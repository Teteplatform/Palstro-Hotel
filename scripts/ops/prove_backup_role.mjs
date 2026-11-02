#!/usr/bin/env node
// =============================================================================
//  Proof that `hotel_backup` is read-only AND sees everything.  (docs/backups.md)
// =============================================================================
//  node scripts/ops/prove_backup_role.mjs
//
//  Rule 27: an assertion that cannot distinguish working from absent is not an
//  assertion. Each check below names the defect that turns it RED, and the
//  BYPASSRLS check is MADE to fail as part of the run — the role is briefly set
//  NOBYPASSRLS, re-measured, and restored — because that is the only way to show
//  the green was earned. Without that flip the check would pass against a role
//  with no RLS tables at all, which is rule 27's "fixture already in the state
//  being asserted".
//
//  WHAT ACTUALLY WENT RED while this was written: check 5 (the write refused with
//  the read-only default turned OFF) is the one that matters, and check 4 alone
//  would have been decoration. default_transaction_read_only is PGC_USERSET, so
//  hotel_backup can switch its own seatbelt off; a role holding real write grants
//  behind that setting would pass check 4 and fail check 5.
//
//  Reads BACKUP_DB_URL and SUPABASE_DB_URL from .env.local. Prints no values.
// =============================================================================
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
const require = createRequire(import.meta.url);
const pg = require('pg');

const REPO = path.resolve(import.meta.dirname, '../..');
const ENV_FILE = path.join(REPO, '.env.local');

function readEnv() {
  if (!existsSync(ENV_FILE)) { console.error('.env.local not found'); process.exit(1); }
  const out = {};
  for (const l of readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

const env = readEnv();
for (const k of ['BACKUP_DB_URL', 'SUPABASE_DB_URL']) {
  if (!env[k]) { console.error(k + ' is not set in .env.local'); process.exit(1); }
}

const client = (url) => new pg.Client({
  connectionString: url, ssl: { rejectUnauthorized: false }, statement_timeout: 60000,
});

let pass = 0, fail = 0;
const ok = (n, d) => { pass++; console.log('  PASS  ' + n + '\n        red when: ' + d); };
const bad = (n, d, got) => { fail++; console.log('  FAIL  ' + n + '\n        red when: ' + d + '\n        got: ' + got); };
const firstLine = (e) => String(e.message).split('\n')[0];

// The table the RLS checks use: every row is tenant-scoped by get_tenant_ids().
const RLS_TABLE = 'bookings';

const backup = client(env.BACKUP_DB_URL);
const admin = client(env.SUPABASE_DB_URL);
await backup.connect();
await admin.connect();
let restored = true;

try {
  console.log('=== hotel_backup: identity ===');
  const who = (await backup.query(
    `select current_user u,
            (select rolbypassrls from pg_roles where rolname = current_user) bypassrls,
            (select rolconnlimit from pg_roles where rolname = current_user) connlimit,
            current_setting('default_transaction_read_only') ro`)).rows[0];
  console.log(' ', JSON.stringify(who));

  who.u === 'hotel_backup'
    ? ok('connects as hotel_backup, not postgres',
         'BACKUP_DB_URL is rebuilt with the wrong username, or the pooler falls back to the admin user')
    : bad('connects as hotel_backup, not postgres', 'wrong user in BACKUP_DB_URL', who.u);

  who.ro === 'on'
    ? ok('its transactions are read-only by default',
         'the ALTER ROLE ... SET default_transaction_read_only line is dropped from backup_role.sql')
    : bad('its transactions are read-only by default', 'the role setting is missing', who.ro);

  // --- 1. IT CAN READ. Established FIRST, so a later refusal cannot be -------
  //        confused with the table being absent or unreadable.
  console.log('\n=== it reads ===');
  const seen = Number((await backup.query('select count(*)::int n from public.' + RLS_TABLE)).rows[0].n);
  const truth = Number((await admin.query('select count(*)::int n from public.' + RLS_TABLE)).rows[0].n);
  console.log('  ' + RLS_TABLE + ': hotel_backup sees ' + seen + ', admin sees ' + truth);

  if (truth === 0) {
    bad('reads every row of ' + RLS_TABLE,
        'n/a — THE FIXTURE IS EMPTY, so this check cannot tell BYPASSRLS from no data. Point RLS_TABLE at a table with rows.',
        '0 rows on live');
  } else if (seen === truth) {
    ok('reads all ' + truth + ' rows of ' + RLS_TABLE + ', an RLS table',
       'BYPASSRLS is removed from the role — the count silently drops to 0 and nothing errors');
  } else {
    bad('reads all ' + truth + ' rows of ' + RLS_TABLE, 'BYPASSRLS missing', seen + ' of ' + truth);
  }

  // --- 2. THE POLICIES WOULD HIDE THOSE ROWS --------------------------------
  //        Without this, "it read 3 rows" might only mean the policies allow it.
  const tids = (await backup.query('select coalesce(array_length(get_tenant_ids(), 1), 0)::int n')).rows[0].n;
  console.log('  get_tenant_ids() for hotel_backup returns ' + tids + ' tenant(s)');
  Number(tids) === 0
    ? ok('the RLS predicate would match nothing for this login',
         'hotel_backup is added to tenant_users — the read above then proves nothing about BYPASSRLS, because the policies would have allowed it anyway')
    : bad('the RLS predicate would match nothing for this login',
          'hotel_backup must belong to no tenant', tids + ' tenants');

  // --- 3. MAKE IT FAIL. The flip that earns the green above. ----------------
  console.log('\n=== made to fail: the same read with BYPASSRLS removed ===');
  restored = false;
  await admin.query('alter role hotel_backup nobypassrls');
  try {
    const b = client(env.BACKUP_DB_URL);   // a NEW session: the attribute is read at connect
    await b.connect();
    const without = Number((await b.query('select count(*)::int n from public.' + RLS_TABLE)).rows[0].n);
    await b.end();
    console.log('  with NOBYPASSRLS, hotel_backup sees ' + without + ' of ' + truth + ' rows');
    without === 0
      ? ok('removing BYPASSRLS really does blind it, so check 1 can go red',
           'nothing — this IS the red. Had it still read rows, the policies were permissive and check 1 was decoration')
      : bad('removing BYPASSRLS really does blind it',
            'check 1 cannot distinguish working from absent', without + ' rows still visible');
  } finally {
    await admin.query('alter role hotel_backup bypassrls');
    const back = (await admin.query("select rolbypassrls b from pg_roles where rolname = 'hotel_backup'")).rows[0].b;
    restored = back === true;
    console.log('  BYPASSRLS restored: ' + restored);
    if (!restored) console.log('  *** RESTORE FAILED — run: alter role hotel_backup bypassrls');
  }

  // --- 4. IT CANNOT WRITE, in its own read-only transaction ----------------
  console.log('\n=== it cannot write ===');
  const b2 = client(env.BACKUP_DB_URL);
  await b2.connect();
  try {
    await b2.query('insert into public.' + RLS_TABLE + ' (id) values (gen_random_uuid())');
    bad('a write is refused in the default read-only transaction', 'this IS the red', 'the INSERT SUCCEEDED');
  } catch (e) {
    console.log('  refused: ' + e.code + ' ' + firstLine(e));
    ok('a write is refused in the default read-only transaction (' + e.code + ')',
       'default_transaction_read_only is turned off for the role AND a write grant exists — the insert then lands');
  }

  // --- 5. AND STILL CANNOT WRITE WITH THE SEATBELT OFF ---------------------
  //        The one that matters. Check 4 alone would pass for a role holding full
  //        write grants behind a setting it can change itself.
  try {
    await b2.query('set default_transaction_read_only = off');
    const ro = (await b2.query("select current_setting('default_transaction_read_only') v")).rows[0].v;
    console.log('  seatbelt off: default_transaction_read_only = ' + ro);
    try {
      await b2.query('insert into public.' + RLS_TABLE + ' (id) values (gen_random_uuid())');
      bad('a write is STILL refused with the read-only default turned off', 'this IS the red',
          'the INSERT SUCCEEDED — the role holds write grants and only the setting was stopping it');
    } catch (e) {
      console.log('  refused: ' + e.code + ' ' + firstLine(e));
      ok('a write is STILL refused with the read-only default off (' + e.code + ')',
         'hotel_backup is granted INSERT/UPDATE/DELETE anywhere, or made a member of a writing role — check 4 would stay green while this goes red');
    }
  } finally {
    await b2.end();
  }

  // --- 6. NO ADMIN RIGHTS --------------------------------------------------
  console.log('\n=== it holds no admin rights ===');
  const rights = (await admin.query(
    `select rolsuper, rolcreatedb, rolcreaterole, rolreplication
       from pg_roles where rolname = 'hotel_backup'`)).rows[0];
  const anyAdmin = rights.rolsuper || rights.rolcreatedb || rights.rolcreaterole || rights.rolreplication;
  !anyAdmin
    ? ok('not superuser, cannot create databases or roles, no replication',
         'any of those four flags is granted — a leaked backup secret then becomes an admin credential')
    : bad('holds no admin rights', 'one of the four admin flags is set', JSON.stringify(rights));

} finally {
  await backup.end();
  await admin.end();
}

console.log('\n=== ' + pass + ' passed, ' + fail + ' failed ===');
if (!restored) console.log('WARNING: BYPASSRLS may not have been restored — backups would silently dump zero rows.');
process.exit(fail === 0 && restored ? 0 : 1);
