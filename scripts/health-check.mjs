// THE DATABASE HEALTH CHECK — `npm run health`
//
// Answers, in one command and about three seconds, the three questions worth
// asking of this database between shipments:
//
//   1. IS THE LEDGER STILL TELLING THE TRUTH? 046 §7.6's invariant —
//      ledger_balance === expected_ledger_balance, to the kobo — read from the
//      journal lines on one side and computed independently from the movements
//      on the other. The assertion the ERP could not make.
//   2. HAS ANYTHING MOVED STOCK WITHOUT THE LEDGER HEARING? That is
//      stock_movements_unposted with a NULL reason, and it must read zero.
//   3. IS THE PROJECT AWAKE? Supabase pauses a free-tier project after about
//      seven days idle, and running this is itself enough activity to stop that.
//
// ----------------------------------------------------------------------------
// WHY IT LIVES IN THE REPO NOW
// ----------------------------------------------------------------------------
// It spent its first two weeks in node_modules/.tmp, which is gitignored and
// disappears on the next `npm ci` — so the one command anybody would reach for
// to answer "is the ledger still right?" was a thing only one machine had, and
// only until that machine cleaned its modules. A check nobody else can run is a
// check that was true once (the same argument that put the reconciliation on a
// screen rather than leaving it in a dry run).
//
// ----------------------------------------------------------------------------
// READ-ONLY, AND NOT A SUBSTITUTE FOR THE SCHEDULED JOB
// ----------------------------------------------------------------------------
// Nothing here writes. It also runs only when somebody runs it, which is exactly
// the weakness .github/workflows/supabase-keepalive.yml exists to cover — that
// job is the thing that keeps the project awake unattended, and this is the
// thing that tells you whether the books are straight. They are not the same
// job and neither replaces the other.
//
// It needs .env.local, so it is a DEVELOPER command and not a deployable.
import fs from 'node:fs';
import pg from 'pg';

// date -> string. Without this, `date` columns come back as JS Dates and
// toISOString() shifts the day by the local UTC offset, silently breaking any
// business-date comparison (rules 8/12).
pg.types.setTypeParser(1082, (v) => v);

const ENV_FILE = '.env.local';
if (!fs.existsSync(ENV_FILE)) {
  console.error(`${ENV_FILE} not found. Run this from the repository root.`);
  process.exit(2);
}
const env = fs.readFileSync(ENV_FILE, 'utf8');

// THE LAST connection string in the file, not the first. .env.local carries
// working notes below the real variables, and the earlier URLs in them are
// superseded passwords that fail with 28P01 — a message naming the bare role,
// which reads like a URL-parsing problem and is not.
const urls = [...env.matchAll(/postgresql:\/\/[^\s'"]+/g)].map((m) => m[0]);
if (urls.length === 0) {
  console.error(`No postgresql:// connection string found in ${ENV_FILE}.`);
  process.exit(2);
}
const dbUrl = urls[urls.length - 1].replace(/['"]+$/, '');

// The PUBLISHABLE browser key and project URL — the pair the app ships to every
// guest. Read here, never printed: this output gets pasted into chats.
const apiUrl = (env.match(/VITE_SUPABASE_URL\s*=\s*(\S+)/) || [])[1]?.replace(/['"]/g, '');
const anon = (env.match(/VITE_SUPABASE_ANON_KEY\s*=\s*(\S+)/) || [])[1]?.replace(/['"]/g, '');

const c = new pg.Client({ connectionString: dbUrl });
const q = (s, p) => c.query(s, p).then((r) => r.rows);

// A non-zero exit when something is actually wrong, so this can be the body of a
// CI step later without being rewritten.
let problems = 0;

await c.connect();
// An abandoned run releases its locks by itself, and a blocked statement fails
// fast and says so, rather than leaving a backend idle in transaction holding
// locks that make the live screens hang.
await c.query(`set idle_in_transaction_session_timeout = '30s'`);
await c.query(`set lock_timeout = '10s'`);

console.log('=== Palstro-Hotels — database health ===');
console.log(`    ${new Date().toISOString()}\n`);

const ver = (await q(`select version() as v, current_database() as db`))[0];
console.log(`Postgres  : ${ver.v.split(' ').slice(0, 2).join(' ')} on ${ver.db}`);

const mig = await q(
  `select version from supabase_migrations.schema_migrations order by version desc limit 3`,
);
console.log(`Migrations: ${mig.map((m) => m.version).join(', ')} (newest first)`);

// --- 1. has anything moved stock without the ledger hearing? ----------------
const alarms = (await q(
  `select count(*)::int n from stock_movements_unposted where reason_unposted is null`,
))[0].n;
if (alarms > 0) problems += 1;
console.log(`\nUnposted ALARM rows: ${alarms}${alarms === 0 ? '  (clean)' : '  <-- LOOK AT THIS'}`);

for (const r of await q(
  `select coalesce(reason_unposted, '(unexplained — the alarm)') r, count(*)::int n
   from stock_movements_unposted group by 1 order by 2 desc`,
)) {
  console.log(`  ${String(r.n).padStart(4)}  ${r.r.slice(0, 74)}`);
}

// --- 2. does the ledger still agree with the stock? -------------------------
// inventory_gl_reconciliation is staff-gated on auth.uid(), and a script has no
// session — so borrow an active member's, exactly as 047's self-verify does.
// INSIDE A TRANSACTION: set_config(..., true) is transaction-LOCAL, and outside
// one every statement is its own transaction, so the claim is gone before the
// next query runs. That is not hypothetical — it is how the first version of
// this script reported "Not authorised" against a database working perfectly.
console.log('\nLedger against stock, per property:');
for (const p of await q(
  `select p.id, p.name,
          (select tu.user_id from tenant_users tu
            where tu.tenant_id = p.tenant_id and tu.is_active
            order by tu.user_id limit 1) as member
   from properties p where p.deleted_at is null order by p.name`,
)) {
  if (!p.member) {
    console.log(`  ${p.name}: no active member to borrow a session from, skipped`);
    continue;
  }
  await c.query('begin');
  await c.query(`select set_config('request.jwt.claims', $1, true)`, [
    JSON.stringify({ sub: p.member, role: 'authenticated' }),
  ]);
  try {
    const r = (await q(`select * from inventory_gl_reconciliation($1)`, [p.id]))[0];
    const agrees = Number(r.ledger_difference) === 0;
    if (!agrees) problems += 1;
    console.log(`  ${p.name}: ${agrees ? 'AGREES' : '*** DOES NOT AGREE ***'}` +
                `  ledger ${r.ledger_balance} vs expected ${r.expected_ledger_balance}`);
    // The residue is meaningless without the count it accumulated over: a kobo
    // across forty movements is arithmetic, across four thousand it is not.
    console.log(`     valuation ${r.valuation_value}, residue ${r.valuation_difference}` +
                ` across ${r.valued_movement_count} movements`);
    console.log(`     pre-wiring ${r.pre_wiring_value}, reset positions ${r.reset_position_count}` +
                `, negative today ${r.negative_position_count}`);
  } catch (e) {
    // A property whose `inventory` key is unmapped cannot be reconciled, and
    // that is resolve_account refusing loudly (rule 4) rather than a fault here.
    console.log(`  ${p.name}: ${e.message}`);
    if (e.code !== 'PT424') problems += 1;
  } finally {
    await c.query('rollback');
  }
}

const counts = (await q(
  `select (select count(*) from stock_movements)::int movements,
          (select count(*) from journal_entries)::int entries,
          (select count(*) from purchase_orders)::int orders,
          (select count(*) from suppliers)::int suppliers`,
))[0];
console.log(`\nRows: ${counts.movements} movements, ${counts.entries} journal entries, ` +
            `${counts.orders} purchase orders, ${counts.suppliers} suppliers`);

await c.end();

// --- 3. the API gateway, which Supabase meters separately -------------------
if (apiUrl && anon) {
  const rest = await fetch(`${apiUrl}/rest/v1/properties?select=id&limit=1`, {
    headers: { apikey: anon, Authorization: `Bearer ${anon}` },
  });
  console.log(`\nPostgREST gateway: HTTP ${rest.status} ${rest.statusText}`);
  if (!rest.ok) problems += 1;

  const auth = await fetch(`${apiUrl}/auth/v1/settings`, { headers: { apikey: anon } });
  console.log(`Auth endpoint    : HTTP ${auth.status} ${auth.statusText}`);
  if (!auth.ok) problems += 1;
} else {
  console.log('\nAPI gateway: skipped (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY not in .env.local)');
}

console.log(
  problems === 0
    ? '\nAll clear — and the project has been touched on both surfaces.'
    : `\n${problems} problem(s) above. Nothing here fixes itself.`,
);
process.exit(problems === 0 ? 0 : 1);
