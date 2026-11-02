#!/usr/bin/env node
// =============================================================================
//  THE RESTORE TEST — restore a backup into a throwaway database and assert it
//  against the manifest taken with it.          (docs/backups.md)
// =============================================================================
//  node scripts/ops/restore_check.mjs --dump=<hotel-*.dump> --manifest=<hotel-*.manifest.json>
//                                     [--db=restore_check_<x>] [--keep]
//
//  The throwaway server comes from RESTORE_ADMIN_URL — a superuser on a LOCAL or
//  CI-only PostgreSQL 17+. localhost only, refused otherwise, because this script
//  creates and drops databases.
//
//  WHY THIS EXISTS AT ALL. An untested backup is a belief. Supabase's own backups
//  are on their plan, in their account; ours is only worth something if we have
//  opened one. This opens the latest one every month and asserts what came back.
//
//  THREE OUTCOMES, NOT TWO — and the third is the point of this file:
//    PASS      the check ran against real inputs and agreed
//    FAIL      the check ran and disagreed
//    VACUOUS   the check could not distinguish working from absent, because its
//              inputs were empty. REPORTED, and NEVER counted as a pass.
//
//  Rule 27's third shape is a fixture already in the state being asserted, and
//  the trial balance is exactly that today: nothing has posted to the ledger, so
//  comparing the restored trial balance to the recorded one compares nothing to
//  nothing and agrees. That is not evidence. So it prints VACUOUS and says why.
//  When the folio starts posting it becomes load-bearing on its own and NOTHING
//  HERE NEEDS TO CHANGE — it simply stops announcing that it is vacuous. A check
//  that has to be remembered and rewritten on a future date is a check that will
//  be green on the day it was supposed to start mattering.
//
//  A MISSING MANIFEST IS A FAILURE, NOT A SKIP. The whole defect being guarded
//  against is a backup containing less than it should; an absent manifest means
//  every table-by-table assertion silently does not run, which is the same
//  failure wearing the costume of a pass.
// =============================================================================
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/)
  return m ? [m[1], m[2] ?? true] : [a, true]
}))
const die = m => { console.error(`restore_check: ${m}`); process.exit(1) }

const adminUrl = process.env.RESTORE_ADMIN_URL
if (!adminUrl) die('set RESTORE_ADMIN_URL (a superuser on a local / CI PostgreSQL 17+)')
const u = new URL(adminUrl)
if (!['localhost', '127.0.0.1'].includes(u.hostname)) die('the restore test runs only against localhost')
const db = String(args.db ?? `restore_check_${Date.now().toString(36)}`)
if (!/^restore_check_[a-z0-9_]+$/.test(db)) die('the database must be named restore_check_*')
if (!args.dump) die('give --dump (decrypted)')
if (!args.manifest) die('give --manifest (decrypted). A missing manifest is a FAILURE, not a skip: '
  + 'without it every table-by-table assertion silently does not run.')
if (!fs.existsSync(args.dump)) die(`--dump not found: ${args.dump}`)
if (!fs.existsSync(args.manifest)) die(`--manifest not found: ${args.manifest}`)

let M
try { M = JSON.parse(fs.readFileSync(args.manifest, 'utf8')) } catch (e) { die(`the manifest is not valid JSON: ${e.message}`) }
for (const k of ['tables', 'migrations', 'finance_settings', 'document_counters', 'document_period_counters', 'trial_balance']) {
  if (M[k] === undefined) die(`the manifest has no "${k}" — it was not written by this version of backup.mjs`)
}

const bin = n => (process.env.PG_BIN ? path.join(process.env.PG_BIN, n) : n)
const env = { ...process.env, PGPASSWORD: decodeURIComponent(u.password), PGSSLMODE: 'disable' }
delete env.RESTORE_ADMIN_URL
delete env.BACKUP_AGE_KEY
delete env.BACKUP_DB_URL
const conn = d => ['-h', u.hostname, '-p', u.port || '5432', '-U', decodeURIComponent(u.username), '-d', d]
const run = (cmd, a, { ok = [0] } = {}) => {
  const r = spawnSync(bin(cmd), a, { env, encoding: 'utf8', maxBuffer: 1 << 30 })
  if (!ok.includes(r.status)) die(`${cmd} failed (${r.status}): ${(r.stderr || '').split('\n').slice(0, 8).join(' | ')}`)
  return r
}
const sql = (d, q) => run('psql', [...conn(d), '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-c', q]).stdout

// ---- the three-state ledger of results -------------------------------------
let pass = 0, fail = 0, vacuous = 0
const PASS = (n, note = '') => { pass++; console.log(`  PASS     ${n}${note ? `  (${note})` : ''}`) }
const FAIL = (n, note = '') => { fail++; console.log(`  FAIL     ${n}${note ? `  (${note})` : ''}`) }
const VACUOUS = (n, why) => { vacuous++; console.log(`  VACUOUS  ${n}\n           ${why}`) }

const t0 = Date.now()
sql('postgres', `CREATE DATABASE ${db} TEMPLATE template0 STRATEGY FILE_COPY`)
try {
  // The dump creates `public` and `auth` itself, so the fresh database's own
  // empty public schema is dropped first — otherwise every object in it is
  // reported as "already exists" and the noise hides a real error.
  sql(db, `DROP SCHEMA IF EXISTS public, auth CASCADE;`)

  // The roles and extensions a Supabase dump refers to. Created if missing so the
  // GRANTs and policy clauses in the dump resolve; a throwaway cluster has none
  // of them.
  sql(db, `DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN NOINHERIT; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN NOINHERIT; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') THEN CREATE ROLE authenticator NOLOGIN NOINHERIT; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin') THEN CREATE ROLE supabase_admin NOLOGIN; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN CREATE ROLE supabase_auth_admin NOLOGIN; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hotel_backup') THEN CREATE ROLE hotel_backup NOLOGIN; END IF;
  END $$;
  CREATE SCHEMA IF NOT EXISTS extensions;
  CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;
  CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;`)

  // pg_dump's own three sections, in its order. The data goes in with triggers
  // OFF: this schema is full of append-only and write guards
  // (forbid_stock_movement_change, forbid_purchase_receipt_change,
  // set_row_audit) and they would refuse a reload or rewrite the audit columns of
  // every row as they went. post-data comes last, as pg_dump intends, so a NOT
  // VALID check is created after the rows it was never meant to judge.
  const errs = r => (r.stderr.match(/^pg_restore: error:.*$/gm) || [])
  const pre = run('pg_restore', [...conn(db), '--no-owner', '--no-privileges', '--section=pre-data', args.dump], { ok: [0, 1] })
  const schemaErrors = errs(pre).length
  const data = run('pg_restore', [...conn(db), '--no-owner', '--no-privileges', '--section=data', '--disable-triggers', args.dump], { ok: [0, 1] })
  if (errs(data).length) die(`the data did not restore cleanly (${errs(data).length} error(s)): ${errs(data).slice(0, 5).join(' | ')}`)
  const post = run('pg_restore', [...conn(db), '--no-owner', '--no-privileges', '--section=post-data', args.dump], { ok: [0, 1] })
  if (errs(post).length) die(`indexes, foreign keys or checks did not restore cleanly (${errs(post).length} error(s)): ${errs(post).slice(0, 5).join(' | ')}`)
  if (schemaErrors) console.log(`restore_check: pre-data items skipped (Supabase-only parts): ${errs(pre).slice(0, 6).join(' | ')}`)

  // ---- 1. EVERY TABLE IN THE MANIFEST, BY NAME AND BY COUNT ----------------
  console.log('\n=== every table in the manifest ===')
  const restoredRows = JSON.parse(sql(db, `
    SELECT coalesce(json_agg(json_build_object('schema', t.table_schema, 'table_name', t.table_name, 'rows',
             ((xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM %I.%I', t.table_schema, t.table_name),
                                                   false, true, '')))[1]::text)::bigint)), '[]'::json)::text
      FROM information_schema.tables t
     WHERE t.table_schema IN ('public','auth') AND t.table_type = 'BASE TABLE'`).trim())
  const got = new Map(restoredRows.map(r => [`${r.schema}.${r.table_name}`, Number(r.rows)]))

  const missing = [], differing = []
  for (const t of M.tables) {
    const key = `${t.schema}.${t.table_name}`
    if (!got.has(key)) { missing.push(key); continue }
    if (got.get(key) !== Number(t.rows)) differing.push(`${key}: manifest ${t.rows}, restored ${got.get(key)}`)
  }
  const extra = [...got.keys()].filter(k => !M.tables.some(t => `${t.schema}.${t.table_name}` === k))

  if (M.tables.length === 0) {
    VACUOUS('table-by-table row counts', 'the manifest lists no tables at all, so this compares nothing')
  } else if (missing.length === 0 && differing.length === 0) {
    const total = M.tables.reduce((a, t) => a + Number(t.rows), 0)
    if (total === 0) {
      VACUOUS(`all ${M.tables.length} tables present`,
        'every table in the manifest has zero rows, so "the counts agree" cannot tell a good restore from an empty one')
    } else {
      PASS(`all ${M.tables.length} tables restored with matching row counts`, `${total} rows`)
    }
  } else {
    for (const m of missing) FAIL(`table absent from the restored copy: ${m}`)
    for (const d of differing) FAIL(`row count differs — ${d}`)
  }
  if (extra.length) console.log(`  note     ${extra.length} table(s) in the restored copy but not the manifest: ${extra.slice(0, 5).join(', ')}`)

  // ---- 2. THE SCHEMA HISTORY ----------------------------------------------
  // supabase_migrations is NOT in the dumped schemas, so it cannot be asserted on
  // the restored copy. What the manifest records is which database was dumped,
  // and that is worth having in the artifact even though this check cannot run
  // here — saying so is better than quietly omitting it.
  console.log('\n=== schema history ===')
  console.log(`  note     the dump covers public and auth only, so supabase_migrations is not in it. `
    + `The manifest records applied_count=${M.migrations.applied_count}, highest=${M.migrations.highest} — `
    + `the schema to rebuild from before restoring data.`)

  // ---- 3. gl_wired_at, THE VALUE THAT CANNOT BE RE-DERIVED ----------------
  console.log('\n=== property_finance_settings.gl_wired_at ===')
  const fsRestored = JSON.parse(sql(db, `
    SELECT coalesce(json_agg(json_build_object(
             'property_id', property_id,
             'gl_wired_at', to_char(gl_wired_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
             'gl_start_date', gl_start_date::text
           ) ORDER BY property_id), '[]'::json)::text
      FROM public.property_finance_settings`).trim())
  if (M.finance_settings.length === 0) {
    VACUOUS('gl_wired_at per property', 'the manifest records no properties, so there is nothing to compare')
  } else {
    const a = JSON.stringify(M.finance_settings), b = JSON.stringify(fsRestored)
    a === b
      ? PASS(`gl_wired_at and gl_start_date match for all ${M.finance_settings.length} propert(ies)`)
      : FAIL('gl_wired_at / gl_start_date differ', `manifest ${a} vs restored ${b}`)
  }

  // ---- 4. THE DOCUMENT COUNTERS, AS VALUES --------------------------------
  console.log('\n=== document counters ===')
  const dcRestored = JSON.parse(sql(db, `
    SELECT coalesce(json_agg(json_build_object('tenant_id', tenant_id, 'property_id', property_id,
             'doc_type', doc_type, 'last_number', last_number)
           ORDER BY tenant_id, property_id, doc_type), '[]'::json)::text
      FROM public.document_counters`).trim())
  const dpcRestored = JSON.parse(sql(db, `
    SELECT coalesce(json_agg(json_build_object('tenant_id', tenant_id, 'property_id', property_id,
             'doc_type', doc_type, 'year_month', year_month, 'last_number', last_number)
           ORDER BY tenant_id, property_id, doc_type, year_month), '[]'::json)::text
      FROM public.document_period_counters`).trim())
  for (const [label, recorded, restored] of [
    ['document_counters', M.document_counters, dcRestored],
    ['document_period_counters', M.document_period_counters, dpcRestored],
  ]) {
    if (recorded.length === 0) {
      VACUOUS(`${label} values`, 'the manifest records none, so this compares nothing — a reset counter would not be noticed')
    } else if (JSON.stringify(recorded) === JSON.stringify(restored)) {
      PASS(`${label}: all ${recorded.length} counter(s) came back at the same last_number`)
    } else {
      FAIL(`${label} differ — the next document would reuse a number already issued`,
        `manifest ${JSON.stringify(recorded)} vs restored ${JSON.stringify(restored)}`)
    }
  }

  // ---- 5. THE TRIAL BALANCE ----------------------------------------------
  console.log('\n=== trial balance ===')
  const tbRestored = JSON.parse(sql(db, `
    SELECT coalesce(json_agg(json_build_object(
             'tenant_id', tb.tenant_id, 'property_id', tb.property_id, 'account_id', tb.account_id,
             'debit', tb.debit, 'credit', tb.credit, 'lines', tb.lines
           ) ORDER BY tb.tenant_id, tb.property_id, tb.account_id), '[]'::json)::text
      FROM (SELECT l.tenant_id::text AS tenant_id, je.property_id::text AS property_id, l.account_id::text AS account_id,
                   sum(l.debit)::numeric(14,2)::text AS debit, sum(l.credit)::numeric(14,2)::text AS credit, count(*) AS lines
              FROM public.journal_entry_lines l
              JOIN public.journal_entries je ON je.id = l.journal_entry_id
             GROUP BY l.tenant_id, je.property_id, l.account_id) tb`).trim())
  if (M.trial_balance.length === 0 && tbRestored.length === 0) {
    VACUOUS('the trial balance equals the one recorded at backup',
      'nothing has posted to the ledger yet, so this compares an empty set to an empty set and agrees for no reason. '
      + 'It becomes load-bearing by itself once the folio posts; nothing here changes on that day.')
  } else if (JSON.stringify(M.trial_balance) === JSON.stringify(tbRestored)) {
    PASS(`the trial balance matches the one recorded at backup`, `${M.trial_balance.length} account row(s)`)
  } else {
    FAIL('the restored trial balance differs from the one recorded at backup',
      `${M.trial_balance.length} recorded row(s) vs ${tbRestored.length} restored`)
  }

  // Every property's debits must equal its credits. Independent of the manifest:
  // this one asks whether the restored books are internally coherent.
  const unbalanced = sql(db, `
    SELECT coalesce(string_agg(x.property_id::text, ', '), '') FROM (
      SELECT je.property_id FROM public.journal_entry_lines l
        JOIN public.journal_entries je ON je.id = l.journal_entry_id
       GROUP BY je.property_id HAVING sum(l.debit) <> sum(l.credit)) x`).trim()
  const anyLines = Number(sql(db, `SELECT count(*) FROM public.journal_entry_lines`).trim())
  if (anyLines === 0) {
    VACUOUS('every property balances (debits = credits)', 'there are no journal lines, so nothing can be out of balance')
  } else if (!unbalanced) {
    PASS('every property balances (debits = credits)', `${anyLines} journal line(s)`)
  } else {
    FAIL(`properties whose debits do not equal their credits: ${unbalanced}`)
  }

  // ---- 6. THE STOCK SIDE — the one that means something TODAY -------------
  // ASSERT BOTH OR NEITHER. ledger_difference = 0.00 is trivially true on a
  // database with no stock movements, so with an empty ledger the reconciliation
  // is evidence ONLY if the stock movements are proven to have come back. The two
  // are deliberately bound together: if the movement count is not what the
  // manifest recorded, the reconciliation result is reported as VACUOUS rather
  // than as a pass, however green it looks.
  console.log('\n=== the stock side ===')
  const smManifest = M.tables.find(t => t.schema === 'public' && t.table_name === 'stock_movements')
  const smRestored = Number(sql(db, `SELECT count(*) FROM public.stock_movements`).trim())
  const smRecorded = smManifest ? Number(smManifest.rows) : null
  const stockCameBack = smRecorded !== null && smRecorded === smRestored && smRestored > 0

  if (smRecorded === null) {
    FAIL('stock_movements is not in the manifest', 'the manifest was not written by this version of backup.mjs')
  } else if (smRecorded !== smRestored) {
    FAIL(`stock_movements did not come back`, `manifest ${smRecorded}, restored ${smRestored}`)
  } else if (smRestored === 0) {
    VACUOUS('stock_movements restored', 'there are no stock movements at all, so the reconciliation below cannot be evidence of anything')
  } else {
    PASS(`stock_movements restored`, `${smRestored} movement(s), matching the manifest`)
  }

  const props = sql(db, `SELECT id::text FROM public.properties WHERE deleted_at IS NULL ORDER BY id`)
    .trim().split('\n').filter(Boolean)
  if (props.length === 0) {
    VACUOUS('inventory_gl_reconciliation reads 0.00 for every property', 'the restored copy has no properties')
  } else {
    // The function is staff-gated on auth.uid() and a restore has no session, so
    // a real active member of each property's tenant is borrowed for the call —
    // the same trick 047's self-verify uses, and for the same reason: it tests
    // THE FUNCTION rather than a copy of its arithmetic (rule 27's first shape).
    const bad = [], skipped = [], results = []
    for (const p of props) {
      const member = sql(db, `SELECT coalesce((SELECT tu.user_id::text FROM public.tenant_users tu
          JOIN public.properties pr ON pr.tenant_id = tu.tenant_id
         WHERE pr.id = '${p}' AND tu.is_active ORDER BY tu.user_id LIMIT 1), '')`).trim()
      if (!member) { skipped.push(`${p} (no active member to call it as)`); continue }
      const r = spawnSync(bin('psql'), [...conn(db), '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1',
        '-c', `SELECT set_config('request.jwt.claims', json_build_object('sub','${member}','role','authenticated')::text, false)`,
        '-c', `SELECT r.ledger_difference FROM public.inventory_gl_reconciliation('${p}') r`],
        { env, encoding: 'utf8' })
      if (r.status !== 0) {
        if (/PT424/.test(r.stderr)) { skipped.push(`${p} (the inventory account is unmapped — resolve_account refusing loudly, rule 4)`); continue }
        bad.push(`${p}: the function errored: ${(r.stderr || '').split('\n')[0].slice(0, 160)}`)
        continue
      }
      const diff = r.stdout.trim().split('\n').filter(Boolean).pop()
      results.push(`${p.slice(0, 8)}…=${diff}`)
      if (Number(diff) !== 0) bad.push(`${p}: ledger_difference ${diff}`)
    }
    for (const s of skipped) console.log(`  note     reconciliation not run for ${s}`)
    if (bad.length) {
      for (const b of bad) FAIL(`inventory_gl_reconciliation — ${b}`)
    } else if (results.length === 0) {
      VACUOUS('inventory_gl_reconciliation reads 0.00 for every property', 'it could not be run for any property')
    } else if (!stockCameBack) {
      VACUOUS(`inventory_gl_reconciliation reads 0.00 for every property (${results.join(', ')})`,
        'the stock side is not proven: stock_movements is empty or did not match the manifest, and ledger_difference = 0.00 '
        + 'is trivially true with no movements. Asserted both or neither, so this does not count as a pass.')
    } else {
      PASS(`inventory_gl_reconciliation reads 0.00 for all ${results.length} propert(ies)`,
        `${results.join(', ')}; and the stock movements it reads came back intact`)
    }
  }

  console.log(`\n=== ${pass} passed, ${fail} failed, ${vacuous} vacuous — in ${Math.round((Date.now() - t0) / 1000)} s ===`)
  if (schemaErrors) console.log(`(${schemaErrors} pre-data item(s) needing Supabase-only parts were skipped)`)
  if (vacuous) {
    console.log('\nVACUOUS checks could not tell working from absent, because their inputs were empty.')
    console.log('They are NOT passes. Each becomes load-bearing on its own once there is data behind it,')
    console.log('and nothing in this script needs to change on that day.')
  }
  if (fail) die(`${fail} check(s) failed`)
  if (pass === 0) die('no check passed — every assertion was vacuous, so this run is not evidence that the backup is good')
  console.log('\nrestore_check: the backup opens, and everything the manifest claims about it is true.')
} finally {
  if (!args.keep) sql('postgres', `DROP DATABASE IF EXISTS ${db} WITH (FORCE)`)
}
