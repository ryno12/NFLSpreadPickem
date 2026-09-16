-- ============================================================
--  NFL Spread Pick'em — Supabase schema
--  Paste this whole file into Supabase → SQL Editor → Run.
--  Safe to re-run: everything is CREATE OR REPLACE / IF NOT EXISTS.
-- ============================================================

create extension if not exists pgcrypto;

-- ------------------------------------------------------------
-- Seasons: week 1 starts on the Tuesday before the first game.
-- Weeks roll Tuesday → Monday, so TNF/SNF/MNF all land in one week.
-- ------------------------------------------------------------
create table if not exists public.seasons (
  year          int primary key,
  week1_tuesday date not null
);
insert into public.seasons (year, week1_tuesday)
values (2026, '2026-09-08')
on conflict (year) do nothing;

create or replace function public.nfl_week(ts timestamptz, out season int, out week int)
language plpgsql stable as $$
declare
  d date := (ts at time zone 'America/New_York')::date;
  s record;
begin
  select * into s from public.seasons
   where week1_tuesday <= d
   order by week1_tuesday desc limit 1;
  if s is null then
    raise exception 'No season configured for %', d;
  end if;
  season := s.year;
  week   := ((d - s.week1_tuesday) / 7) + 1;
end $$;

-- ------------------------------------------------------------
-- Profiles: one row per auth user, auto-created on signup.
-- first_week: the first week this player is on the hook for.
--   (a player who joins in week 5 doesn't eat losses for weeks 1-4)
-- ------------------------------------------------------------
create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  is_admin     boolean not null default false,
  active       boolean not null default true,
  first_season int not null default 2026,
  first_week   int not null default 1,
  created_at   timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  wk record;
begin
  select * into wk from public.nfl_week(now());
  insert into public.profiles (id, display_name, first_season, first_week)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)),
    coalesce(wk.season, 2026),
    coalesce(wk.week, 1)
  )
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ------------------------------------------------------------
-- Games. id = The Odds API event id. Spreads are always stored
-- from the HOME team's perspective (home -3.5 means home favored).
-- ------------------------------------------------------------
create table if not exists public.games (
  id                  text primary key,
  season              int not null,
  week                int not null,
  kickoff             timestamptz not null,
  home_team           text not null,
  away_team           text not null,
  home_spread         numeric(4,1),          -- current line (null until DK posts one)
  closing_home_spread numeric(4,1),          -- frozen at kickoff by the sync job
  home_score          int,
  away_score          int,
  status              text not null default 'scheduled'
                      check (status in ('scheduled','in_progress','final')),
  espn_id             text,
  updated_at          timestamptz not null default now()
);
create index if not exists games_season_week_idx on public.games (season, week);
create index if not exists games_kickoff_idx     on public.games (kickoff);

-- Line history — every time DK's number changes we append a row.
create table if not exists public.lines (
  id          bigserial primary key,
  game_id     text not null references public.games(id) on delete cascade,
  captured_at timestamptz not null default now(),
  book        text not null default 'draftkings',
  home_spread numeric(4,1) not null
);
create index if not exists lines_game_idx on public.lines (game_id, captured_at desc);

-- ------------------------------------------------------------
-- Picks. spread_at_pick is set SERVER-SIDE by trigger from the
-- game's current line — the client never gets to choose its number.
-- ------------------------------------------------------------
create table if not exists public.picks (
  id             bigserial primary key,
  user_id        uuid not null references public.profiles(id) on delete cascade,
  game_id        text not null references public.games(id) on delete cascade,
  season         int not null,
  week           int not null,
  side           text not null check (side in ('home','away')),
  spread_at_pick numeric(4,1) not null,
  is_gold        boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (user_id, game_id)
);
create unique index if not exists one_gold_per_week
  on public.picks (user_id, season, week) where is_gold;

create or replace function public.picks_before_write()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  g public.games%rowtype;
  old_gold public.picks%rowtype;
begin
  select * into g from public.games where id = new.game_id;
  if g is null then
    raise exception 'Unknown game %', new.game_id;
  end if;
  if g.kickoff <= now() then
    raise exception 'LOCKED: this game has already kicked off';
  end if;

  new.season := g.season;
  new.week   := g.week;
  new.updated_at := now();

  -- Lock the line at the moment the side is chosen (or changed).
  if tg_op = 'INSERT' or new.side is distinct from old.side then
    if g.home_spread is null then
      raise exception 'NO_LINE: DraftKings has not posted a spread for this game yet';
    end if;
    new.spread_at_pick := g.home_spread;
  else
    new.spread_at_pick := old.spread_at_pick;   -- toggling gold keeps your number
  end if;

  -- Only one gold per week; moving it is allowed unless the old gold has kicked off.
  if new.is_gold and (tg_op = 'INSERT' or not old.is_gold) then
    select p.* into old_gold
      from public.picks p join public.games gg on gg.id = p.game_id
     where p.user_id = new.user_id and p.season = new.season and p.week = new.week
       and p.is_gold and p.id is distinct from new.id;
    if old_gold.id is not null then
      if (select kickoff from public.games where id = old_gold.game_id) <= now() then
        raise exception 'GOLD_LOCKED: your gold pick this week has already kicked off';
      end if;
      update public.picks set is_gold = false, updated_at = now() where id = old_gold.id;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists picks_before_write on public.picks;
create trigger picks_before_write
  before insert or update on public.picks
  for each row execute function public.picks_before_write();

create or replace function public.picks_before_delete()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (select kickoff from public.games where id = old.game_id) <= now() then
    raise exception 'LOCKED: this game has already kicked off';
  end if;
  return old;
end $$;

drop trigger if exists picks_before_delete on public.picks;
create trigger picks_before_delete
  before delete on public.picks
  for each row execute function public.picks_before_delete();

-- ------------------------------------------------------------
-- Row Level Security
-- ------------------------------------------------------------
alter table public.seasons  enable row level security;
alter table public.profiles enable row level security;
alter table public.games    enable row level security;
alter table public.lines    enable row level security;
alter table public.picks    enable row level security;

drop policy if exists "read seasons"  on public.seasons;
create policy "read seasons"  on public.seasons  for select to authenticated using (true);
drop policy if exists "read profiles" on public.profiles;
create policy "read profiles" on public.profiles for select to authenticated using (true);
drop policy if exists "edit own profile" on public.profiles;
create policy "edit own profile" on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());
drop policy if exists "read games" on public.games;
create policy "read games" on public.games for select to authenticated using (true);
drop policy if exists "read lines" on public.lines;
create policy "read lines" on public.lines for select to authenticated using (true);

-- THE important one: you see your own picks always, everyone else's only after kickoff.
drop policy if exists "read picks" on public.picks;
create policy "read picks" on public.picks for select to authenticated
  using (
    user_id = auth.uid()
    or exists (select 1 from public.games g where g.id = picks.game_id and g.kickoff <= now())
  );
drop policy if exists "insert own picks" on public.picks;
create policy "insert own picks" on public.picks for insert to authenticated
  with check (user_id = auth.uid());
drop policy if exists "update own picks" on public.picks;
create policy "update own picks" on public.picks for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "delete own picks" on public.picks;
create policy "delete own picks" on public.picks for delete to authenticated
  using (user_id = auth.uid());

-- Explicit grants (Supabase usually adds these by default, but be sure).
grant usage on schema public to authenticated;
grant select on public.seasons, public.profiles, public.games, public.lines to authenticated;
grant update (display_name) on public.profiles to authenticated;
grant select, insert, update, delete on public.picks to authenticated;
grant usage, select on all sequences in schema public to authenticated;

-- Nobody anonymous touches anything.
revoke all on all tables in schema public from anon;

-- ------------------------------------------------------------
-- Views. security_invoker = RLS still applies through them.
-- ------------------------------------------------------------

-- Every pick, graded. result: win / loss / push / null (not final).
create or replace view public.pick_results
with (security_invoker = true) as
select
  p.id, p.user_id, p.game_id, p.season, p.week, p.side, p.spread_at_pick, p.is_gold,
  p.created_at, p.updated_at,
  g.kickoff, g.home_team, g.away_team, g.home_score, g.away_score, g.status,
  g.home_spread as current_home_spread, g.closing_home_spread,
  case when p.side = 'home' then g.home_team else g.away_team end as picked_team,
  case when p.side = 'home' then p.spread_at_pick else -p.spread_at_pick end as picked_spread,
  case when g.status = 'final' then
    case
      when (g.home_score - g.away_score) + p.spread_at_pick = 0 then 'push'
      when ((g.home_score - g.away_score) + p.spread_at_pick > 0) = (p.side = 'home') then 'win'
      else 'loss'
    end
  end as result,
  -- Closing line value: positive = you got a better number than the close.
  case when g.closing_home_spread is null then null
       when p.side = 'home' then p.spread_at_pick - g.closing_home_spread
       else g.closing_home_spread - p.spread_at_pick
  end as clv,
  false as missed
from public.picks p
join public.games g on g.id = p.game_id;

-- Same shape, plus a synthetic LOSS row for every final game a player didn't pick.
create or replace view public.results_all
with (security_invoker = true) as
select pr.*,
  case when pr.result = 'win' then (case when pr.is_gold then 2 else 1 end) else 0 end as points
from public.pick_results pr
union all
select
  null::bigint as id, pl.id as user_id, g.id as game_id, g.season, g.week,
  null::text as side, null::numeric as spread_at_pick, false as is_gold,
  null::timestamptz as created_at, null::timestamptz as updated_at,
  g.kickoff, g.home_team, g.away_team, g.home_score, g.away_score, g.status,
  g.home_spread, g.closing_home_spread,
  null::text as picked_team, null::numeric as picked_spread,
  'loss'::text as result, null::numeric as clv, true as missed, 0 as points
from public.games g
cross join public.profiles pl
where g.status = 'final'
  and pl.active
  and (g.season, g.week) >= (pl.first_season, pl.first_week)
  and not exists (select 1 from public.picks p where p.user_id = pl.id and p.game_id = g.id);

-- Week completeness: a week is "complete" when every game in it is final.
create or replace view public.week_status
with (security_invoker = true) as
select season, week,
  count(*) as games,
  count(*) filter (where status = 'final') as finals,
  bool_and(status = 'final') as complete,
  min(kickoff) as first_kickoff, max(kickoff) as last_kickoff
from public.games
group by season, week;

-- Per player per week.
create or replace view public.weekly_results
with (security_invoker = true) as
select
  r.user_id, r.season, r.week,
  count(*) filter (where r.result = 'win')  as wins,
  count(*) filter (where r.result = 'loss') as losses,
  count(*) filter (where r.result = 'push') as pushes,
  count(*) filter (where r.missed)          as missed,
  sum(r.points)                             as points,
  max(case when r.is_gold then r.result end) as gold_result,
  max(case when r.is_gold then r.picked_team end) as gold_team,
  avg(r.clv) filter (where not r.missed)    as avg_clv
from public.results_all r
where r.result is not null
group by r.user_id, r.season, r.week;

-- Who won each complete week (ties → everyone at the top gets a tie).
create or replace view public.week_winners
with (security_invoker = true) as
select wr.user_id, wr.season, wr.week, wr.points,
  case
    when wr.points = mx.max_points and mx.n_at_max = 1 then 'won'
    when wr.points = mx.max_points then 'tied'
    else 'lost'
  end as outcome
from public.weekly_results wr
join (
  select season, week, max(points) as max_points,
         count(*) filter (where points = (select max(points) from public.weekly_results w2
                                          where w2.season = w1.season and w2.week = w1.week)) as n_at_max
  from public.weekly_results w1
  group by season, week
) mx on mx.season = wr.season and mx.week = wr.week
join public.week_status ws on ws.season = wr.season and ws.week = wr.week and ws.complete;

-- Season scoreboard.
create or replace view public.season_standings
with (security_invoker = true) as
select
  pl.id as user_id, pl.display_name, s.year as season,
  coalesce(sum(wr.points), 0)  as points,
  coalesce(sum(wr.wins), 0)    as wins,
  coalesce(sum(wr.losses), 0)  as losses,
  coalesce(sum(wr.pushes), 0)  as pushes,
  coalesce(sum(wr.missed), 0)  as missed,
  count(*) filter (where wr.gold_result = 'win')  as gold_wins,
  count(*) filter (where wr.gold_result = 'loss') as gold_losses,
  coalesce((select count(*) from public.week_winners ww where ww.user_id = pl.id and ww.season = s.year and ww.outcome = 'won'),  0) as weeks_won,
  coalesce((select count(*) from public.week_winners ww where ww.user_id = pl.id and ww.season = s.year and ww.outcome = 'lost'), 0) as weeks_lost,
  coalesce((select count(*) from public.week_winners ww where ww.user_id = pl.id and ww.season = s.year and ww.outcome = 'tied'), 0) as weeks_tied,
  round(avg(wr.avg_clv)::numeric, 2) as avg_clv
from public.profiles pl
cross join public.seasons s
left join public.weekly_results wr on wr.user_id = pl.id and wr.season = s.year
where pl.active
group by pl.id, pl.display_name, s.year;

-- How many picks each player has in for a week, WITHOUT revealing which side.
-- security definer so it can count picks RLS would otherwise hide.
create or replace function public.week_pick_counts(p_season int, p_week int)
returns table (user_id uuid, picks int, has_gold boolean)
language sql security definer set search_path = public stable as $$
  select pl.id, count(p.id)::int, coalesce(bool_or(p.is_gold), false)
  from public.profiles pl
  left join public.picks p on p.user_id = pl.id and p.season = p_season and p.week = p_week
  where pl.active
  group by pl.id
$$;
revoke all on function public.week_pick_counts(int, int) from public, anon;
grant execute on function public.week_pick_counts(int, int) to authenticated;

-- Called by the sync job (service role) — freezes the closing line once a game kicks off.
create or replace function public.freeze_closing_lines()
returns int language sql security definer set search_path = public as $$
  with u as (
    update public.games
       set closing_home_spread = home_spread, updated_at = now()
     where kickoff <= now() and closing_home_spread is null and home_spread is not null
    returning 1
  ) select count(*)::int from u
$$;
revoke all on function public.freeze_closing_lines() from public, anon, authenticated;

grant select on public.pick_results, public.results_all, public.week_status,
                public.weekly_results, public.week_winners, public.season_standings
  to authenticated;
