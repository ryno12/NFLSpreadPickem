-- ============================================================
--  scores-cron.sql — in-database score syncing, every 10 minutes.
--  Paste into Supabase → SQL Editor → Run. Safe to re-run.
--
--  WHY THIS EXISTS: GitHub's scheduler delivered ~20% of the hourly
--  sync.yml schedule (median gap 5.4h), so scores sat hours stale
--  during live games. pg_cron runs inside Postgres and actually fires.
--  sync.mjs still owns the DraftKings odds pull; this only does scores.
--
--  Uses `http` (synchronous) rather than `pg_net` (async), so one
--  function call does request + parse + update in a single transaction.
-- ============================================================

create extension if not exists http with schema extensions;
create extension if not exists pg_cron;

-- Mirrors the `norm` helper in scripts/sync.mjs: "Kansas City Chiefs" -> "kansascitychiefs"
create or replace function public.norm_team(t text)
returns text language sql immutable parallel safe as $$
  select lower(regexp_replace(coalesce(t, ''), '[^a-zA-Z]', '', 'g'))
$$;

create or replace function public.sync_scores_from_espn()
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  wk        record;
  resp      extensions.http_response;
  body      jsonb;
  ev        jsonb;
  comp      jsonb;
  home      jsonb;
  away      jsonb;
  pending   int;
  updated   int := 0;
  calls     int := 0;
  errors    text[] := '{}';
begin
  -- ---- Offseason guard -------------------------------------------------
  -- Only inside a configured season's window: a week before kickoff week 1
  -- through ~23 weeks later (18 regular + playoffs). Driven by the seasons
  -- table, so it needs no maintenance when a new year is added.
  if not exists (
    select 1 from public.seasons s
     where current_date between s.week1_tuesday - 7 and s.week1_tuesday + (7 * 23)
  ) then
    return jsonb_build_object('skipped', 'offseason');
  end if;

  -- ---- Nothing live? Leave without touching the network -----------------
  select count(*) into pending
    from public.games
   where status <> 'final'
     and kickoff <= now()
     and kickoff >= now() - interval '3 days';

  if pending = 0 then
    return jsonb_build_object('skipped', 'no pending games');
  end if;

  -- Don't let a hung ESPN hold a worker open.
  perform extensions.http_set_curlopt('CURLOPT_TIMEOUT', '15');

  drop table if exists _espn;
  create temp table _espn (
    id text, kicks timestamptz, home text, away text,
    home_score int, away_score int, state text, completed boolean
  ) on commit drop;

  -- ---- One ESPN call per (season, week) that has a live game ------------
  for wk in
    select distinct season, week
      from public.games
     where status <> 'final'
       and kickoff <= now()
       and kickoff >= now() - interval '3 days'
  loop
    begin
      select * into resp from extensions.http_get(
        'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard'
        || '?limit=100&seasontype=2&dates=' || wk.season || '&week=' || wk.week);
      calls := calls + 1;

      if resp.status <> 200 then
        errors := errors || format('week %s: HTTP %s', wk.week, resp.status);
        continue;
      end if;

      body := resp.content::jsonb;

      for ev in select value from jsonb_array_elements(coalesce(body->'events', '[]'::jsonb))
      loop
        comp := ev->'competitions'->0;
        select e.value into home from jsonb_array_elements(comp->'competitors') e
         where e.value->>'homeAway' = 'home' limit 1;
        select e.value into away from jsonb_array_elements(comp->'competitors') e
         where e.value->>'homeAway' = 'away' limit 1;

        insert into _espn values (
          ev->>'id',
          (ev->>'date')::timestamptz,
          home->'team'->>'displayName',
          away->'team'->>'displayName',
          nullif(home->>'score','')::int,
          nullif(away->>'score','')::int,
          comp->'status'->'type'->>'state',                       -- pre | in | post
          coalesce((comp->'status'->'type'->>'completed')::boolean, false)
        );
      end loop;
    exception when others then
      errors := errors || format('week %s: %s', wk.week, sqlerrm);
    end;
  end loop;

  -- ---- Apply, matching the way sync.mjs does ---------------------------
  with m as (
    select g.id as game_id, e.*
      from public.games g
      join _espn e
        on public.norm_team(e.home) = public.norm_team(g.home_team)
       and public.norm_team(e.away) = public.norm_team(g.away_team)
       and abs(extract(epoch from (e.kicks - g.kickoff))) < 36 * 3600
     where g.status <> 'final'
       and g.kickoff <= now()
       and g.kickoff >= now() - interval '3 days'
  )
  update public.games g
     set espn_id    = m.id,
         status     = case when m.completed      then 'final'
                           when m.state = 'in'   then 'in_progress'
                           else g.status end,
         home_score = case when m.state <> 'pre' then m.home_score else g.home_score end,
         away_score = case when m.state <> 'pre' then m.away_score else g.away_score end,
         updated_at = now()
    from m
   where g.id = m.game_id;
  get diagnostics updated = row_count;

  -- Closing lines are frozen at kickoff, and that was riding on the same
  -- broken GitHub schedule. Cheap and idempotent, so do it here too.
  perform public.freeze_closing_lines();

  insert into public.sync_state (key, ran_at)
  values ('last_score_sync', now())
  on conflict (key) do update set ran_at = excluded.ran_at, updated_at = now();

  return jsonb_build_object(
    'pending', pending, 'espn_calls', calls, 'updated', updated,
    'errors', case when cardinality(errors) = 0 then null else to_jsonb(errors) end);
end $$;

-- Server-side only. Nobody signed into the app can invoke it.
revoke all on function public.sync_scores_from_espn() from public, anon, authenticated;
revoke all on function public.norm_team(text) from public, anon, authenticated;

-- ---- Schedule ---------------------------------------------------------
-- Every 10 minutes year-round; the function's own guards make an offseason
-- or quiet-day tick a single cheap COUNT with no network call.
select cron.unschedule('sync-scores')
 where exists (select 1 from cron.job where jobname = 'sync-scores');

select cron.schedule('sync-scores', '*/10 * * * *', $job$select public.sync_scores_from_espn();$job$);
