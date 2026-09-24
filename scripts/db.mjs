#!/usr/bin/env node
// ============================================================
//  db.mjs — local admin console against the Supabase Postgres.
//  Dev tool only: it uses the direct DB connection, which bypasses
//  RLS entirely. Never ship this anywhere or run it in CI.
//
//  Env (from .env at the repo root, which is gitignored):
//    DATABASE_URL   Supabase → Project Settings → Database →
//                   Connection string → URI, SESSION mode (port 5432).
//                   Transaction mode (6543) cannot run multi-statement DDL.
//    PGSSLROOTCERT  optional path to Supabase's CA cert. Without it we
//                   encrypt but skip cert verification (see ssl below).
//
//  Usage:
//    node scripts/db.mjs ping
//    node scripts/db.mjs file supabase/schema.sql [--no-tx]
//    node scripts/db.mjs query "select * from public.games limit 5"
// ============================================================

import { readFileSync } from 'node:fs';
import pg from 'pg';

try { process.loadEnvFile(new URL('../.env', import.meta.url).pathname); } catch { /* no .env — fall back to the real env */ }

const URL_ = process.env.DATABASE_URL;
if (!URL_) die('DATABASE_URL is not set. Put it in .env at the repo root (see the header of this file).');

// Supabase's pooler cert is not signed by a CA in Node's default store, so
// verification is off unless you point PGSSLROOTCERT at their CA. The
// connection is still TLS-encrypted either way.
const ssl = process.env.PGSSLROOTCERT
  ? { ca: readFileSync(process.env.PGSSLROOTCERT, 'utf8') }
  : { rejectUnauthorized: false };

const [cmd, arg, ...rest] = process.argv.slice(2);
const client = new pg.Client({ connectionString: URL_, ssl, application_name: 'nfl-picks-db.mjs' });
client.on('notice', n => console.log('  NOTICE:', n.message));

try {
  await client.connect();
  if (cmd === 'ping')       await ping();
  else if (cmd === 'file')  await runFile(arg, rest.includes('--no-tx'));
  else if (cmd === 'query') await runQuery(arg);
  else die('Usage: db.mjs ping | file <path.sql> [--no-tx] | query "<sql>"');
} catch (e) {
  // Postgres errors carry the useful bits outside .message.
  console.error('\n✗ ' + (e.message || e));
  for (const k of ['detail', 'hint', 'where', 'position']) if (e[k]) console.error(`  ${k}: ${e[k]}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}

async function ping() {
  const { rows } = await client.query(
    `select current_database() as db, current_user as "user",
            substring(version() from 'PostgreSQL [0-9.]+') as version, now() as now`);
  console.table(rows);
}

async function runFile(path, noTx) {
  if (!path) die('Which file? e.g. db.mjs file supabase/schema.sql');
  const sql = readFileSync(path, 'utf8');
  console.log(`→ ${path} (${sql.length} bytes)${noTx ? '' : ' in a transaction'}`);
  if (noTx) { await client.query(sql); }
  else {
    // DDL is transactional in Postgres, so a failure halfway leaves nothing behind.
    await client.query('begin');
    try { await client.query(sql); await client.query('commit'); }
    catch (e) { await client.query('rollback').catch(() => {}); throw e; }
  }
  console.log('✓ applied');
}

async function runQuery(sql) {
  if (!sql) die('Nothing to run. e.g. db.mjs query "select 1"');
  const res = await client.query(sql);
  for (const r of Array.isArray(res) ? res : [res]) {
    if (r.rows?.length) console.table(r.rows);
    else console.log(`${r.command || 'OK'} — ${r.rowCount ?? 0} row(s)`);
  }
}

function die(msg) { console.error(msg); process.exit(1); }
