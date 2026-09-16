-- Backfill picks that were made "by text" before the app was live
-- (e.g. Week 2 Thursday night). Run in Supabase → SQL Editor.
--
-- The normal kickoff lock is enforced by a trigger, so we disable it for this one statement.
-- You must supply the spread each person actually had when they picked (home-team perspective).

-- 1) find the user ids and the game id
select id, display_name from public.profiles;
select id, kickoff, away_team, home_team, home_spread from public.games where week = 2 order by kickoff;

-- 2) insert (edit the values!)
alter table public.picks disable trigger picks_before_write;

insert into public.picks (user_id, game_id, season, week, side, spread_at_pick, is_gold) values
  ('<RYAN-UUID>', '<GAME-ID>', 2026, 2, 'home', -4.5, false),   -- Ryan: Bills -4.5
  ('<TJ-UUID>',   '<GAME-ID>', 2026, 2, 'away', -4.5, false)    -- TJ: Lions +4.5 (stored as home -4.5)
on conflict (user_id, game_id) do update
  set side = excluded.side, spread_at_pick = excluded.spread_at_pick, is_gold = excluded.is_gold;

alter table public.picks enable trigger picks_before_write;
