#!/usr/bin/env node
// ============================================================
//  sync.mjs — pulls DraftKings spreads (The Odds API) and scores
//  (ESPN public scoreboard) into Supabase. Zero dependencies.
//
//  Env:
//    SUPABASE_URL              https://xxxx.supabase.co
//    SUPABASE_SERVICE_ROLE_KEY service role key (bypasses RLS — server only!)
//    ODDS_API_KEY              the-odds-api.com key
//    SYNC_ODDS                 "always" | "auto" (default) | "never"
//                              auto = only when UTC hour % ODDS_EVERY_HOURS == 0
//    ODDS_EVERY_HOURS          default 4  (→ ~180 credits/month of the free 500)
//    SYNC_SCORES               "always" (default) | "never"
// ============================================================

const SUPABASE_URL = need('SUPABASE_URL').replace(/\/$/, '');
const SERVICE_KEY  = need('SUPABASE_SERVICE_ROLE_KEY');
const ODDS_KEY     = process.env.ODDS_API_KEY || '';
const SYNC_ODDS    = process.env.SYNC_ODDS || 'auto';
const ODDS_EVERY   = Number(process.env.ODDS_EVERY_HOURS || 4);
const SYNC_SCORES  = process.env.SYNC_SCORES || 'always';
const BOOKS        = ['draftkings', 'fanduel', 'betmgm']; // preference order

function need(k) {
  if (!process.env[k]) { console.error(`Missing env ${k}`); process.exit(1); }
  return process.env[k];
}

// ---------- Supabase REST helpers ----------
async function sb(path, { method = 'GET', body, prefer } = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${method} ${path} → ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

// ---------- NFL week math (mirrors public.nfl_week in SQL) ----------
let seasons = [];
function nyDate(iso) {
  // YYYY-MM-DD in America/New_York
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(iso));
}
function daysBetween(a, b) { // both 'YYYY-MM-DD'
  return Math.round((Date.UTC(...split(b)) - Date.UTC(...split(a))) / 86400000);
  function split(s) { const [y, m, d] = s.split('-').map(Number); return [y, m - 1, d]; }
}
function nflWeek(iso) {
  const d = nyDate(iso);
  const s = seasons.filter(x => x.week1_tuesday <= d).sort((a, b) => b.week1_tuesday.localeCompare(a.week1_tuesday))[0];
  if (!s) throw new Error(`No season configured covering ${d}`);
  return { season: s.year, week: Math.floor(daysBetween(s.week1_tuesday, d) / 7) + 1 };
}

// ---------- Odds ----------
async function syncOdds() {
  if (!ODDS_KEY) { console.log('odds: no ODDS_API_KEY, skipping'); return; }
  const url = `https://api.the-odds-api.com/v4/sports/americanfootball_nfl/odds?apiKey=${ODDS_KEY}` +
              `&regions=us&markets=spreads&bookmakers=${BOOKS.join(',')}&oddsFormat=american&dateFormat=iso`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Odds API ${res.status}: ${await res.text()}`);
  console.log(`odds: credits used=${res.headers.get('x-requests-used')} remaining=${res.headers.get('x-requests-remaining')}`);
  const events = await res.json();

  const existing = Object.fromEntries(
    (await sb(`games?select=id,home_spread,kickoff&id=in.(${events.map(e => `"${e.id}"`).join(',') || '"none"'})`))
      .map(g => [g.id, g]));

  const upserts = [], newLines = [];
  for (const ev of events) {
    const { season, week } = nflWeek(ev.commence_time);
    let spread = null, book = null;
    for (const b of BOOKS) {
      const bk = ev.bookmakers.find(x => x.key === b);
      const mk = bk?.markets.find(m => m.key === 'spreads');
      const home = mk?.outcomes.find(o => o.name === ev.home_team);
      if (home && typeof home.point === 'number') { spread = home.point; book = b; break; }
    }
    const prev = existing[ev.id];
    const kickedOff = new Date(ev.commence_time) <= new Date();
    const row = { id: ev.id, season, week, kickoff: ev.commence_time, home_team: ev.home_team, away_team: ev.away_team, updated_at: new Date().toISOString() };
    // Never move the line after kickoff (the pick trigger already refuses, but keep the record honest).
    if (spread !== null && !kickedOff) row.home_spread = spread;
    upserts.push(row);
    if (spread !== null && !kickedOff && (!prev || Number(prev.home_spread) !== spread)) {
      newLines.push({ game_id: ev.id, book, home_spread: spread });
    }
  }
  if (upserts.length) await sb('games', { method: 'POST', body: upserts, prefer: 'resolution=merge-duplicates,return=minimal' });
  if (newLines.length) await sb('lines', { method: 'POST', body: newLines, prefer: 'return=minimal' });
  console.log(`odds: ${events.length} events, ${upserts.length} upserted, ${newLines.length} line changes`);
}

// ---------- Scores (ESPN) ----------
async function syncScores() {
  // Games that kicked off in the last 3 days and aren't final yet.
  const since = new Date(Date.now() - 3 * 86400000).toISOString();
  const pending = await sb(`games?select=id,season,week,home_team,away_team,kickoff,status&status=neq.final&kickoff=lte.${new Date().toISOString()}&kickoff=gte.${since}`);
  if (!pending.length) { console.log('scores: nothing pending'); return; }

  // One ESPN call per (season, week) that has pending games.
  const weeks = [...new Set(pending.map(g => `${g.season}:${g.week}`))];
  const events = [];
  for (const sw of weeks) {
    const [season, week] = sw.split(':');
    const url = `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?limit=100&seasontype=2&dates=${season}&week=${week}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'curl/8.5.0', Accept: 'application/json' } });
    if (!res.ok) throw new Error(`ESPN ${res.status}: ${await res.text()}`);
    const data = await res.json();
    events.push(...(data.events || []));
  }

  const espn = events.map(ev => {
    const comp = ev.competitions?.[0];
    const home = comp?.competitors?.find(c => c.homeAway === 'home');
    const away = comp?.competitors?.find(c => c.homeAway === 'away');
    return {
      id: ev.id, date: ev.date,
      home: home?.team?.displayName, away: away?.team?.displayName,
      homeScore: home?.score != null ? Number(home.score) : null,
      awayScore: away?.score != null ? Number(away.score) : null,
      state: comp?.status?.type?.state,              // pre | in | post
      completed: !!comp?.status?.type?.completed,
    };
  });

  let updated = 0;
  for (const g of pending) {
    const m = espn.find(e => norm(e.home) === norm(g.home_team) && norm(e.away) === norm(g.away_team)
                          && Math.abs(new Date(e.date) - new Date(g.kickoff)) < 36 * 3600000);
    if (!m) { console.log(`scores: no ESPN match for ${g.away_team} @ ${g.home_team}`); continue; }
    const status = m.completed ? 'final' : (m.state === 'in' ? 'in_progress' : g.status);
    const patch = { espn_id: m.id, status, updated_at: new Date().toISOString() };
    if (m.state !== 'pre') { patch.home_score = m.homeScore; patch.away_score = m.awayScore; }
    await sb(`games?id=eq.${encodeURIComponent(g.id)}`, { method: 'PATCH', body: patch, prefer: 'return=minimal' });
    updated++;
    if (status === 'final') console.log(`scores: FINAL ${g.away_team} ${m.awayScore} @ ${g.home_team} ${m.homeScore}`);
  }
  console.log(`scores: ${pending.length} pending, ${updated} updated`);
}
const norm = s => (s || '').toLowerCase().replace(/[^a-z]/g, '');

// ---------- main ----------
(async () => {
  seasons = await sb('seasons?select=year,week1_tuesday');

  const hour = new Date().getUTCHours();
  const doOdds = SYNC_ODDS === 'always' || (SYNC_ODDS === 'auto' && hour % ODDS_EVERY === 0);
  if (doOdds) await syncOdds(); else console.log(`odds: skipped (hour ${hour}, every ${ODDS_EVERY}h)`);

  const frozen = await sb('rpc/freeze_closing_lines', { method: 'POST', body: {} });
  if (frozen) console.log(`closing lines frozen: ${frozen}`);

  if (SYNC_SCORES !== 'never') {
    try { await syncScores(); }
    catch (e) { console.error('scores: FAILED (lines were still synced):', e.message); process.exitCode = 1; }
  }
  console.log('done');
})().catch(e => { console.error(e); process.exit(1); });
