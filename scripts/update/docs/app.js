import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const { SUPABASE_URL, SUPABASE_ANON_KEY } = window.CONFIG || {};
if (!SUPABASE_URL || SUPABASE_URL.includes('YOUR-PROJECT')) {
  document.body.innerHTML = '<p style="padding:40px;font-family:system-ui">Edit <code>config.js</code> with your Supabase URL and anon key first.</p>';
  throw new Error('config.js not filled in');
}
const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ---------------------------------------------------------------- state
const S = {
  user: null, me: null,
  profiles: new Map(),        // id -> profile
  seasons: [],
  season: null, week: null,   // selected
  thisSeason: null, thisWeek: null,
  games: [], picks: [], counts: [],
  results: [], standings: [], weekly: [], winners: [], weekStatus: [],
  tab: 'picks',
};
const $ = (sel, el = document) => el.querySelector(sel);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) n.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k !== null && k !== undefined) n.append(k.nodeType ? k : document.createTextNode(k));
  return n;
};
const fmtSpread = (s) => s === null || s === undefined ? '—' : Number(s) === 0 ? 'PK' : (Number(s) > 0 ? '+' : '') + Number(s).toFixed(1).replace(/\.0$/, '');
const fmtClv = (c) => c === null || c === undefined ? '—' : (Number(c) > 0 ? '+' : '') + Number(c).toFixed(2);
const fmtPct = (n, d) => d ? Math.round((n / d) * 100) + '%' : '—';
const fmtTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const fmtDay = (iso) => new Date(iso).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
const short = (team) => team.split(' ').slice(-1)[0];           // "Kansas City Chiefs" -> "Chiefs"
const nameOf = (id) => S.profiles.get(id)?.display_name || '?';
const kicked = (g) => new Date(g.kickoff) <= new Date();

let toastTimer;
function toast(msg, err = false) {
  const t = $('#toast'); t.textContent = msg; t.className = 'toast' + (err ? ' err' : '');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), 3500);
}
function friendly(err) {
  const m = err?.message || String(err);
  if (m.includes('LOCKED:') && !m.includes('GOLD')) return 'Too late — that game already kicked off.';
  if (m.includes('GOLD_LOCKED')) return "Your gold pick this week already kicked off, so it's staying put.";
  if (m.includes('NO_LINE')) return "DraftKings hasn't posted a line for that game yet.";
  return m;
}

// ---------------------------------------------------------------- week math
function nflWeek(date, seasons) {
  const d = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  const s = seasons.filter(x => x.week1_tuesday <= d).sort((a, b) => b.week1_tuesday.localeCompare(a.week1_tuesday))[0];
  if (!s) return { season: seasons[0]?.year ?? new Date().getFullYear(), week: 1 };
  const days = Math.round((Date.parse(d + 'T00:00:00Z') - Date.parse(s.week1_tuesday + 'T00:00:00Z')) / 86400000);
  return { season: s.year, week: Math.max(1, Math.floor(days / 7) + 1) };
}

// ---------------------------------------------------------------- auth
sb.auth.onAuthStateChange(async (event, session) => {
  if (event === 'PASSWORD_RECOVERY') { show('newpass'); return; }
  S.user = session?.user ?? null;
  if (S.user) { show('app'); await boot(); } else show('auth');
});

function show(which) {
  for (const id of ['auth', 'newpass', 'app']) $('#' + id).classList.toggle('hidden', id !== which);
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  $('#auth-error').textContent = '';
  const { error } = await sb.auth.signInWithPassword({ email: f.get('email'), password: f.get('password') });
  if (error) $('#auth-error').textContent = error.message;
});
$('#reset-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const { error } = await sb.auth.resetPasswordForEmail(f.get('email'), { redirectTo: location.origin + location.pathname });
  $('#reset-msg').textContent = error ? error.message : 'Check your email for a reset link.';
});
$('#newpass-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const { error } = await sb.auth.updateUser({ password: f.get('password') });
  if (error) { $('#newpass-error').textContent = error.message; return; }
  toast('Password updated'); show('app'); await boot();
});
$('#signout').addEventListener('click', () => sb.auth.signOut());
$('#changepass').addEventListener('click', () => { $('#pass-error').textContent = ''; $('#pass-form').reset(); $('#pass-modal').classList.remove('hidden'); });
$('#pass-cancel').addEventListener('click', () => $('#pass-modal').classList.add('hidden'));
$('#pass-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  if (f.get('password') !== f.get('confirm')) { $('#pass-error').textContent = "Passwords don't match."; return; }
  const { error } = await sb.auth.updateUser({ password: f.get('password') });
  if (error) { $('#pass-error').textContent = error.message; return; }
  $('#pass-modal').classList.add('hidden'); toast('Password changed');
});
$('#me-name').addEventListener('click', async () => {
  const name = prompt('Display name', S.me?.display_name || '');
  if (!name || !name.trim()) return;
  const { error } = await sb.from('profiles').update({ display_name: name.trim() }).eq('id', S.user.id);
  if (error) return toast(friendly(error), true);
  await boot(); toast('Name updated');
});

// ---------------------------------------------------------------- data
async function boot() {
  const [{ data: seasons }, { data: profiles }] = await Promise.all([
    sb.from('seasons').select('*').order('year'),
    sb.from('profiles').select('*'),
  ]);
  S.seasons = seasons || [];
  S.profiles = new Map((profiles || []).map(p => [p.id, p]));
  S.me = S.profiles.get(S.user.id);
  $('#me-name').textContent = S.me?.display_name || S.user.email;
  const now = nflWeek(new Date(), S.seasons);
  S.thisSeason = now.season; S.thisWeek = now.week;
  if (S.season === null) { S.season = now.season; S.week = now.week; }
  await refresh();
  startAutoRefresh();
}

async function refresh() {
  $('#refresh').disabled = true;
  try {
    const [games, picks, counts, results, standings, weekly, winners, weekStatus] = await Promise.all([
      sb.from('games').select('*').eq('season', S.season).eq('week', S.week).order('kickoff'),
      sb.from('picks').select('*').eq('season', S.season).eq('week', S.week),
      sb.rpc('week_pick_counts', { p_season: S.season, p_week: S.week }),
      sb.from('results_all').select('*').eq('season', S.season),
      sb.from('season_standings').select('*').eq('season', S.season),
      sb.from('weekly_results').select('*').eq('season', S.season),
      sb.from('week_winners').select('*').eq('season', S.season),
      sb.from('week_status').select('*').eq('season', S.season),
    ]);
    for (const r of [games, picks, counts, results, standings, weekly, winners, weekStatus]) if (r.error) throw r.error;
    S.games = games.data; S.picks = picks.data; S.counts = counts.data; S.results = results.data;
    S.standings = standings.data; S.weekly = weekly.data; S.winners = winners.data; S.weekStatus = weekStatus.data;
    render();
  } catch (e) { console.error(e); toast(friendly(e), true); }
  finally { $('#refresh').disabled = false; }
}

let autoTimer;
function startAutoRefresh() {
  clearInterval(autoTimer);
  autoTimer = setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 60_000);
}

// ---------------------------------------------------------------- actions
async function pick(game, side) {
  const mine = myPick(game.id);
  try {
    if (mine && mine.side === side) {
      const { error } = await sb.from('picks').delete().eq('id', mine.id);
      if (error) throw error;
      toast(`Removed ${short(side === 'home' ? game.home_team : game.away_team)}`);
    } else {
      const { error } = await sb.from('picks')
        .upsert({ user_id: S.user.id, game_id: game.id, season: game.season, week: game.week, side, spread_at_pick: 0 }, { onConflict: 'user_id,game_id' });
      if (error) throw error;
      const team = side === 'home' ? game.home_team : game.away_team;
      const sp = side === 'home' ? game.home_spread : -game.home_spread;
      toast(`${short(team)} ${fmtSpread(sp)} locked in`);
    }
    await refresh();
  } catch (e) { toast(friendly(e), true); refresh(); }
}
async function toggleGold(game) {
  const mine = myPick(game.id);
  if (!mine) return;
  const wasGold = mine.is_gold;
  try {
    const { error } = await sb.from('picks').update({ is_gold: !wasGold }).eq('id', mine.id);
    if (error) throw error;
    toast(wasGold ? 'Gold removed' : `⭐ ${short(mine.side === 'home' ? game.home_team : game.away_team)} is your gold pick`);
    await refresh();
  } catch (e) { toast(friendly(e), true); }
}
const myPick = (gameId) => S.picks.find(p => p.game_id === gameId && p.user_id === S.user.id);

// ---------------------------------------------------------------- nav
document.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => {
  S.tab = b.dataset.tab;
  document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === b));
  document.querySelectorAll('.tabpane').forEach(p => p.classList.toggle('hidden', p.id !== 'tab-' + S.tab));
}));
$('#prev-week').addEventListener('click', () => { if (S.week > 1) { S.week--; refresh(); } });
$('#next-week').addEventListener('click', () => { if (S.week < 18) { S.week++; refresh(); } });
$('#refresh').addEventListener('click', refresh);

// ---------------------------------------------------------------- render
function render() {
  const ws = S.weekStatus.find(w => w.week === S.week);
  $('#week-title').textContent = `Week ${S.week}`;
  $('#week-sub').textContent = S.week === S.thisWeek ? 'current week'
    : ws?.complete ? 'final' : S.games.length ? `${ws?.finals ?? 0}/${S.games.length} final` : '';
  $('#prev-week').disabled = S.week <= 1;
  $('#next-week').disabled = S.week >= 18;
  renderPickStatus();
  renderGames();
  renderStandings();
  renderWeeksTable();
  renderSplits();
  renderStats();
}

function renderPickStatus() {
  const box = $('#pick-status'); box.innerHTML = '';
  const total = S.games.length;
  const weekPts = Object.fromEntries(S.weekly.filter(w => w.week === S.week).map(w => [w.user_id, w]));
  const players = [...S.profiles.values()].filter(p => p.active).sort((a, b) => (a.id === S.user.id ? -1 : b.id === S.user.id ? 1 : a.display_name.localeCompare(b.display_name)));
  for (const p of players) {
    const c = S.counts.find(x => x.user_id === p.id) || { picks: 0, has_gold: false };
    const w = weekPts[p.id];
    const isMe = p.id === S.user.id;
    box.append(el('span', { class: 'chip' + (isMe ? ' me' : '') },
      el('b', {}, isMe ? 'You' : p.display_name), ` ${c.picks}/${total} picked `,
      c.has_gold ? el('span', { class: 'gold' }, '⭐') : (total ? el('span', { class: 'warn', title: 'No gold pick yet' }, '☆') : ''),
      w ? ` · ${w.points} pt${w.points === 1 ? '' : 's'} (${w.wins}-${w.losses}${w.pushes ? '-' + w.pushes : ''})` : ''));
  }
}

function renderGames() {
  const box = $('#games'); box.innerHTML = '';
  if (!S.games.length) {
    box.append(el('div', { class: 'empty' }, S.week > S.thisWeek
      ? 'No games loaded for this week yet. DraftKings usually posts next week\'s lines after Monday night.'
      : 'No games found for this week.'));
    return;
  }
  const resultsByGame = {};
  for (const r of S.results) if (r.week === S.week) (resultsByGame[r.game_id] ||= []).push(r);

  let lastDay = '';
  for (const g of S.games) {
    const day = fmtDay(g.kickoff);
    if (day !== lastDay) { box.append(el('div', { class: 'day' }, day)); lastDay = day; }
    box.append(gameCard(g, resultsByGame[g.id] || []));
  }
}

function gameCard(g, results) {
  const locked = kicked(g);
  const mine = myPick(g.id);
  const myRes = results.find(r => r.user_id === S.user.id && !r.missed);
  const homeSp = g.home_spread, awaySp = homeSp === null ? null : -homeSp;
  const final = g.status === 'final';
  const live = g.status === 'in_progress';

  const status = final ? el('span', { class: 'final' }, 'FINAL')
    : live ? el('span', { class: 'live' }, '● LIVE')
    : locked ? el('span', {}, 'Kicked off ' + fmtTime(g.kickoff))
    : el('span', {}, fmtTime(g.kickoff));

  const sideBtn = (side) => {
    const team = side === 'home' ? g.home_team : g.away_team;
    const sp = side === 'home' ? homeSp : awaySp;
    const score = side === 'home' ? g.home_score : g.away_score;
    const picked = mine?.side === side;
    const cls = ['side', side, picked ? 'picked' : '', picked && mine.is_gold ? 'gold' : '',
      picked && myRes?.result === 'win' ? 'win' : '', picked && myRes?.result === 'loss' ? 'loss' : ''].join(' ');
    const lockedSp = picked ? (side === 'home' ? mine.spread_at_pick : -mine.spread_at_pick) : null;
    return el('button', { class: cls, disabled: locked ? '' : null, onclick: () => !locked && pick(g, side) },
      el('span', { class: 'team' }, (picked && mine.is_gold ? '⭐ ' : '') + team),
      el('span', { class: 'spread' },
        picked ? `your line ${fmtSpread(lockedSp)}` + (Number(lockedSp) !== Number(sp) && !locked ? ` · now ${fmtSpread(sp)}` : '') : `DK ${fmtSpread(sp)}`),
      score !== null && score !== undefined && (locked) ? el('span', { class: 'score' }, String(score)) : null);
  };

  const foot = el('div', { class: 'foot' });
  if (!locked) {
    foot.append(el('span', {}, mine ? (mine.is_gold ? 'Your gold pick this week.' : 'Tap ⭐ to make this your 2-point gold pick.') : 'Pick a side. You can change it until kickoff.'));
    if (mine) foot.append(el('button', { class: 'goldbtn' + (mine.is_gold ? ' on' : ''), onclick: () => toggleGold(g) }, mine.is_gold ? '⭐ Gold' : '☆ Make gold'));
  } else {
    const others = el('div', { class: 'others' });
    const players = [...S.profiles.values()].filter(p => p.active).sort((a, b) => a.display_name.localeCompare(b.display_name));
    for (const p of players) {
      const r = results.find(x => x.user_id === p.id);
      const pk = S.picks.find(x => x.game_id === g.id && x.user_id === p.id);
      const who = p.id === S.user.id ? 'You' : p.display_name;
      if (!pk) {
        // Either they didn't pick, or the game isn't final yet (missed rows only exist for finals).
        others.append(el('span', { class: 'pill missed' }, `${who}: no pick`, final ? ' (L)' : ''));
      } else {
        const team = pk.side === 'home' ? g.home_team : g.away_team;
        const sp = pk.side === 'home' ? pk.spread_at_pick : -pk.spread_at_pick;
        const res = r?.result;
        others.append(el('span', { class: 'pill ' + (res || '') },
          pk.is_gold ? el('span', { class: 'g' }, '⭐') : null,
          `${who}: ${short(team)} ${fmtSpread(sp)}`, res ? ` (${res[0].toUpperCase()})` : ''));
      }
    }
    foot.append(others);
    if (g.closing_home_spread !== null) foot.append(el('span', { class: 'small' }, `closed ${short(g.home_team)} ${fmtSpread(g.closing_home_spread)}`));
  }

  return el('div', { class: 'game' + (locked ? ' locked' : '') },
    el('div', { class: 'meta' }, status, el('span', {}, locked ? '' : 'Pick locks at kickoff')),
    el('div', { class: 'sides' }, sideBtn('away'), el('div', { class: 'at' }, '@'), sideBtn('home')),
    foot);
}

function renderStandings() {
  const box = $('#standings'); box.innerHTML = '';
  const rows = [...S.standings].sort((a, b) => b.points - a.points || b.wins - a.wins || a.losses - b.losses);
  if (!rows.length) { box.append(el('div', { class: 'empty' }, 'No results yet.')); return; }
  const top = rows[0].points;
  const t = el('table', {},
    el('thead', {}, el('tr', {}, ...['Player', 'Pts', 'W', 'L', 'P', 'Gold', 'Weeks W-L-T', 'Missed', 'Avg CLV'].map(h => el('th', {}, h)))),
    el('tbody', {}, ...rows.map(r => el('tr', {},
      el('td', {}, r.user_id === S.user.id ? el('b', {}, r.display_name) : r.display_name),
      el('td', { class: r.points === top && top > 0 ? 'lead' : '' }, String(r.points)),
      el('td', {}, String(r.wins)), el('td', {}, String(r.losses)), el('td', {}, String(r.pushes)),
      el('td', {}, `${r.gold_wins}-${r.gold_losses}`),
      el('td', {}, `${r.weeks_won}-${r.weeks_lost}-${r.weeks_tied}`),
      el('td', {}, String(r.missed)),
      el('td', { class: r.avg_clv > 0 ? 'pos' : r.avg_clv < 0 ? 'neg' : '' }, fmtClv(r.avg_clv))))));
  box.append(el('div', { class: 'tablewrap' }, t));
}

function renderWeeksTable() {
  const box = $('#weeks-table'); box.innerHTML = '';
  const players = [...S.profiles.values()].filter(p => p.active).sort((a, b) => a.display_name.localeCompare(b.display_name));
  const weeks = [...new Set([...S.weekly.map(w => w.week), ...S.weekStatus.map(w => w.week)])].sort((a, b) => a - b);
  if (!weeks.length) { box.append(el('div', { class: 'empty' }, 'Nothing yet.')); return; }
  const t = el('table', {},
    el('thead', {}, el('tr', {}, el('th', {}, 'Week'), ...players.map(p => el('th', {}, p.display_name)), el('th', {}, ''))),
    el('tbody', {}, ...weeks.map(wk => {
      const ws = S.weekStatus.find(x => x.week === wk);
      return el('tr', {},
        el('td', {}, `Week ${wk}`),
        ...players.map(p => {
          const w = S.weekly.find(x => x.week === wk && x.user_id === p.id);
          const win = S.winners.find(x => x.week === wk && x.user_id === p.id);
          return el('td', { class: win?.outcome || '' }, w ? `${w.points} (${w.wins}-${w.losses}${w.pushes ? '-' + w.pushes : ''})` : '—');
        }),
        el('td', { class: 'small' }, ws?.complete ? 'final' : ws ? `${ws.finals}/${ws.games}` : ''));
    })));
  box.append(el('div', { class: 'tablewrap' }, t));
}

function renderSplits() {
  $('#split-week').textContent = `— Week ${S.week}`;
  const box = $('#splits'); box.innerHTML = '';
  const players = [...S.profiles.values()].filter(p => p.active);
  const rows = [];
  for (const g of S.games) {
    if (!kicked(g)) continue;
    const picks = S.picks.filter(p => p.game_id === g.id);
    const sides = new Set(picks.map(p => p.side));
    const missing = players.filter(p => !picks.find(x => x.user_id === p.id));
    if (sides.size < 2 && !(sides.size === 1 && missing.length && picks.length)) continue;
    const res = S.results.filter(r => r.game_id === g.id);
    rows.push(el('div', { class: 'game locked' },
      el('div', { class: 'meta' }, el('span', {}, `${g.away_team} @ ${g.home_team}`),
        el('span', {}, g.status === 'final' ? `FINAL ${g.away_score}-${g.home_score}` : fmtTime(g.kickoff))),
      el('div', { class: 'others' }, ...players.map(p => {
        const pk = picks.find(x => x.user_id === p.id);
        const r = res.find(x => x.user_id === p.id);
        if (!pk) return el('span', { class: 'pill missed' }, `${p.display_name}: no pick`);
        const team = pk.side === 'home' ? g.home_team : g.away_team;
        const sp = pk.side === 'home' ? pk.spread_at_pick : -pk.spread_at_pick;
        return el('span', { class: 'pill ' + (r?.result || '') }, pk.is_gold ? '⭐ ' : '', `${p.display_name}: ${short(team)} ${fmtSpread(sp)}`, r?.result ? ` (${r.result[0].toUpperCase()})` : '');
      }))));
  }
  if (!rows.length) box.append(el('div', { class: 'empty' }, 'No disagreements revealed yet this week.'));
  else box.append(...rows);
}

// ---------------------------------------------------------------- stats
function playerStats(userId) {
  const rows = S.results.filter(r => r.user_id === userId && r.result).sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff));
  const picked = rows.filter(r => !r.missed);
  const wins = picked.filter(r => r.result === 'win').length;
  const losses = picked.filter(r => r.result === 'loss').length;
  const pushes = picked.filter(r => r.result === 'push').length;
  const clvRows = picked.filter(r => r.clv !== null);
  const avgClv = clvRows.length ? clvRows.reduce((a, r) => a + Number(r.clv), 0) / clvRows.length : null;
  const beatClose = clvRows.filter(r => Number(r.clv) > 0).length;
  const favs = picked.filter(r => Number(r.picked_spread) < 0).length;
  const dogs = picked.filter(r => Number(r.picked_spread) > 0).length;
  const home = picked.filter(r => r.side === 'home').length;
  const golds = picked.filter(r => r.is_gold);
  const goldW = golds.filter(r => r.result === 'win').length;
  const missed = rows.filter(r => r.missed).length;

  // streaks (pushes ignored, missed picks count as losses)
  let cur = { type: null, n: 0 }, longW = 0, longL = 0, run = { type: null, n: 0 };
  for (const r of rows) {
    if (r.result === 'push') continue;
    const t = r.result === 'win' ? 'W' : 'L';
    run = run.type === t ? { type: t, n: run.n + 1 } : { type: t, n: 1 };
    if (t === 'W') longW = Math.max(longW, run.n); else longL = Math.max(longL, run.n);
    cur = run;
  }
  // best / worst week by win%
  const byWeek = S.weekly.filter(w => w.user_id === userId && (w.wins + w.losses) >= 5);
  const best = byWeek.slice().sort((a, b) => (b.wins / (b.wins + b.losses)) - (a.wins / (a.wins + a.losses)))[0];
  const worst = byWeek.slice().sort((a, b) => (a.wins / (a.wins + a.losses)) - (b.wins / (b.wins + b.losses)))[0];
  const weeksWon = S.winners.filter(w => w.user_id === userId && w.outcome === 'won').length;

  return { rows, picked: picked.length, wins, losses, pushes, avgClv, beatClose, clvN: clvRows.length, favs, dogs, home, golds: golds.length, goldW, missed, cur, longW, longL, best, worst, weeksWon };
}

function badges(s) {
  const b = [];
  const ats = s.wins + s.losses;
  if (s.weeksWon) b.push(['🏆', `Week winner ×${s.weeksWon}`]);
  if (s.cur.type === 'W' && s.cur.n >= 4) b.push(['🔥', `Hot hand — ${s.cur.n} straight`]);
  if (s.cur.type === 'L' && s.cur.n >= 4) b.push(['🧊', `Ice cold — ${s.cur.n} straight L`]);
  if (s.longW >= 7) b.push(['⚡', `${s.longW}-game heater`]);
  if (s.golds >= 3 && s.goldW / s.golds >= 0.75) b.push(['⭐', 'Midas — gold hits 75%+']);
  if (s.golds >= 3 && s.goldW / s.golds <= 0.25) b.push(['🪨', 'Fool\'s gold — gold hits 25% or worse']);
  if (s.clvN >= 10 && s.avgClv >= 0.5) b.push(['🧠', 'Sharp — avg CLV +0.5 or better']);
  if (s.clvN >= 10 && s.avgClv <= -0.5) b.push(['🟦', 'Square — avg CLV −0.5 or worse']);
  if (s.picked >= 15 && s.dogs / s.picked >= 0.6) b.push(['🐶', 'Dog lover — 60%+ underdogs']);
  if (s.picked >= 15 && s.favs / s.picked >= 0.7) b.push(['🍝', 'Chalk eater — 70%+ favorites']);
  if (s.picked >= 15 && s.home / s.picked >= 0.65) b.push(['🏠', 'Homer — 65%+ home teams']);
  if (s.picked >= 15 && s.home / s.picked <= 0.35) b.push(['✈️', 'Road warrior — 65%+ away teams']);
  if (s.missed >= 3) b.push(['👻', `Ghost — ${s.missed} missed picks`]);
  if (ats >= 20 && s.wins / ats >= 0.58) b.push(['💰', 'Beating Vegas — 58%+ ATS']);
  if (ats >= 20 && s.wins / ats <= 0.42) b.push(['🎰', 'Fade material — 42% or worse ATS']);
  if (s.best && s.best.wins / (s.best.wins + s.best.losses) >= 0.75) b.push(['🎯', `Best week: ${s.best.wins}-${s.best.losses} (Wk ${s.best.week})`]);
  if (s.worst && s.worst.wins / (s.worst.wins + s.worst.losses) <= 0.3) b.push(['🤡', `Worst week: ${s.worst.wins}-${s.worst.losses} (Wk ${s.worst.week})`]);
  return b;
}

function renderStats() {
  const players = [...S.profiles.values()].filter(p => p.active).sort((a, b) => (a.id === S.user.id ? -1 : b.id === S.user.id ? 1 : a.display_name.localeCompare(b.display_name)));
  const stats = players.map(p => [p, playerStats(p.id)]);

  const vegas = $('#vegas'); vegas.innerHTML = '';
  vegas.append(el('div', { class: 'cards' }, ...stats.map(([p, s]) => {
    const ats = s.wins + s.losses;
    return el('div', { class: 'card' },
      el('h3', {}, p.display_name),
      el('div', { class: 'big', style: `color:${ats && s.wins / ats > 0.5 ? 'var(--win)' : ats && s.wins / ats < 0.5 ? 'var(--loss)' : 'var(--text)'}` }, fmtPct(s.wins, ats)),
      el('div', { class: 'row' }, 'ATS record', el('b', {}, `${s.wins}-${s.losses}-${s.pushes}`)),
      el('div', { class: 'row' }, 'Avg closing line value', el('b', { class: s.avgClv > 0 ? 'pos' : s.avgClv < 0 ? 'neg' : '' }, fmtClv(s.avgClv))),
      el('div', { class: 'row' }, 'Beat the close', el('b', {}, fmtPct(s.beatClose, s.clvN))),
      el('div', { class: 'row' }, 'Favorites / dogs', el('b', {}, `${s.favs} / ${s.dogs}`)),
      el('div', { class: 'row' }, 'Home / away', el('b', {}, `${s.home} / ${s.picked - s.home}`)),
      el('div', { class: 'row' }, 'Gold record', el('b', {}, `${s.goldW}-${s.golds - s.goldW}`)));
  })));

  const streaks = $('#streaks'); streaks.innerHTML = '';
  streaks.append(el('div', { class: 'cards' }, ...stats.map(([p, s]) => el('div', { class: 'card' },
    el('h3', {}, p.display_name),
    el('div', { class: 'big', style: `color:${s.cur.type === 'W' ? 'var(--win)' : s.cur.type === 'L' ? 'var(--loss)' : 'var(--text)'}` }, s.cur.type ? `${s.cur.type}${s.cur.n}` : '—'),
    el('div', { class: 'row' }, 'Current streak', el('b', {}, s.cur.type ? `${s.cur.n} ${s.cur.type === 'W' ? 'win' : 'loss'}${s.cur.n === 1 ? '' : s.cur.type === 'W' ? 's' : 'es'}` : '—')),
    el('div', { class: 'row' }, 'Longest win streak', el('b', {}, String(s.longW))),
    el('div', { class: 'row' }, 'Longest losing streak', el('b', {}, String(s.longL))),
    el('div', { class: 'row' }, 'Best week', el('b', {}, s.best ? `${s.best.wins}-${s.best.losses} (Wk ${s.best.week})` : '—')),
    el('div', { class: 'row' }, 'Worst week', el('b', {}, s.worst ? `${s.worst.wins}-${s.worst.losses} (Wk ${s.worst.week})` : '—'))))));

  const bx = $('#badges'); bx.innerHTML = '';
  bx.append(el('div', { class: 'cards' }, ...stats.map(([p, s]) => {
    const list = badges(s);
    return el('div', { class: 'card' }, el('h3', {}, p.display_name),
      list.length ? el('div', {}, ...list.map(([i, t]) => el('span', { class: 'badge' }, el('span', { class: 'i' }, i), t)))
                  : el('span', { class: 'muted small' }, 'Nothing earned yet. Give it a few weeks.'));
  })));
}
