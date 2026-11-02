#!/usr/bin/env node
// =============================================================================
//  OUR OWN BACKUP — a pg_dump of the live database plus its trial balance,
//  encrypted to the owner's age key.            (docs/backups.md)
// =============================================================================
//  node scripts/ops/backup.mjs --out=<dir> [--recipient=<age public key>] [--no-encrypt]
//
//  The connection comes ONLY from the environment variable BACKUP_DB_URL — the
//  dedicated read-only login from scripts/ops/backup_role.sql. Never printed,
//  never written to a file.
//
//  WHAT IT PRODUCES
//   1. pg_dump -Fc of the schemas `public` and `auth` (custom format; no owners,
//      no privileges, no security labels).
//   2. The trial balance per tenant, property and account, from
//      journal_entry_lines — so the monthly restore test has something exact to
//      compare the restored copy against (§3, docs/backups.md).
//   3. Both encrypted with age to the owner's PUBLIC key (--recipient or
//      BACKUP_AGE_RECIPIENT); the plain files are then deleted.
//      --no-encrypt exists for a local test only and is refused unless
//      BACKUP_DB_URL names localhost.
//
//  WHY `auth` AND NOT JUST `public`. Every table in this database carries
//  created_by / updated_by referencing auth.users (CLAUDE.md §6, actor columns).
//  Restore `public` alone and every one of those foreign keys points at a user
//  row that does not exist — so the restore either fails or has to be loaded with
//  the constraints off, and "who did this" becomes unanswerable for every row.
//  The customer's primary pain is staff theft; the audit trail is the product.
//
//  WHY NOT `storage`. The storage schema holds only the METADATA of uploaded
//  files. The bytes live in S3 and no pg_dump flag reaches them, so dumping the
//  metadata alone would produce rows pointing at nothing and read as a backup of
//  the images. See §4 in docs/backups.md for what actually covers them.
//
//  Prints only file names, sizes and counts — never a value, a host or a user.
//
//  Ported from palstro-fuel/scripts/ops/backup.mjs. Changed for this product:
//  the schema list (no `ops` schema here), the file prefix, and the trial-balance
//  query (this database spells the columns `debit`/`credit`, not
//  debit_amount/credit_amount, and property_id lives on journal_entries rather
//  than on the lines, so it needs the join).
// =============================================================================
import fs from 'node:fs'
import path from 'node:path'
import { ageRecipient, runTool, toolPath } from './tools.mjs'

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/)
  return m ? [m[1], m[2] ?? true] : [a, true]
}))

// The unencrypted files this run made. Removed if the run stops for any reason, so
// a half-made dump never stays behind in plain text on a runner or a laptop.
const plainFiles = new Set()
const die = m => {
  for (const f of plainFiles) fs.rmSync(f, { force: true })
  console.error(`backup: ${m}`)
  process.exit(1)
}

const url = process.env.BACKUP_DB_URL
if (!url) die('set BACKUP_DB_URL (the read-only backup login from scripts/ops/backup_role.sql)')
const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url)

// The recipient is trimmed, because a secret pasted into the GitHub box arrives
// with a newline round it more often than not. Its value is never printed.
const rec = ageRecipient(args.recipient === true ? '' : (args.recipient ?? process.env.BACKUP_AGE_RECIPIENT))
const recipient = rec.value
if (!recipient && !args['no-encrypt']) die('give --recipient=<age public key> (or BACKUP_AGE_RECIPIENT)')
if (recipient && rec.isPrivate) die('BACKUP_AGE_RECIPIENT holds an age PRIVATE key: put only the age1... public key there')
if (recipient && !rec.wellFormed) die('BACKUP_AGE_RECIPIENT is not an age public key (age1 followed by 58 letters and digits)')
if (rec.trimmed) console.log('backup: BACKUP_AGE_RECIPIENT had surrounding whitespace (trimmed)')
if (args['no-encrypt'] && !local) die('--no-encrypt is for a local database only')

const out = path.resolve(String(args.out ?? 'backup-out'))
fs.mkdirSync(out, { recursive: true })
const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13)   // 20261102T1930 (UTC)

// The password NEVER goes on a command line — it is parsed out of the URL and
// handed to the child processes through PGPASSWORD. A command line is visible in
// the process list to anything else on the machine; an environment variable of a
// child process is not.
const u = new URL(url)
const env = {
  ...process.env,
  PGPASSWORD: decodeURIComponent(u.password),
  PGSSLMODE: local ? 'disable' : 'require',
}
delete env.BACKUP_DB_URL
const conn = [
  '-h', u.hostname,
  '-p', u.port || '5432',
  '-U', decodeURIComponent(u.username),
  '-d', u.pathname.slice(1) || 'postgres',
]

// A tool's own messages, with anything secret-shaped taken out. age names a bad
// recipient in its error text, which is why the key patterns are scrubbed too.
const clean = t => (t || '').split('\n')
  .filter(l => l.trim() && !/password/i.test(l))
  .map(l => l.replace(/age1[0-9a-z]{20,}/gi, '[recipient]').replace(/AGE-SECRET-KEY-[0-9A-Z]+/g, '[key]'))
  .slice(0, 5).join(' | ')

const run = (cmd, a, opts = {}) => {
  const r = runTool(cmd, a, { env, ...opts })
  if (!r.ok) die(`${r.cause}${r.stderr ? `: ${clean(r.stderr)}` : ''}`)
  return r.stdout
}

// ---- 1. the dump ------------------------------------------------------------
const dump = path.join(out, `hotel-${stamp}.dump`)
plainFiles.add(dump)
run('pg_dump', [
  ...conn, '-Fc', '--no-owner', '--no-privileges', '--no-security-labels',
  '-n', 'public', '-n', 'auth', '-f', dump,
])

// ---- 2. the trial balance, which is what the restore test compares ----------
// Grouped by tenant AND property: this product's journal is per-property (a
// tenant is a company, a property is a physical hotel), so a tenant-only grouping
// would add two hotels together and still balance — a figure that agrees for the
// wrong reason is worse than one that disagrees.
// property_id is on journal_entries, not on the lines, hence the join.
const tb = path.join(out, `hotel-${stamp}.tb.csv`)
plainFiles.add(tb)
const tbSql = `COPY (
  SELECT l.tenant_id,
         je.property_id,
         l.account_id,
         sum(l.debit)::numeric(14,2)  AS debit,
         sum(l.credit)::numeric(14,2) AS credit,
         count(*)                     AS lines
    FROM public.journal_entry_lines l
    JOIN public.journal_entries je ON je.id = l.journal_entry_id
   GROUP BY l.tenant_id, je.property_id, l.account_id
   ORDER BY l.tenant_id, je.property_id, l.account_id
) TO STDOUT WITH (FORMAT csv, HEADER)`
fs.writeFileSync(tb, run('psql', [...conn, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-c', tbSql]))

const rows = fs.readFileSync(tb, 'utf8').trim().split('\n').slice(1).filter(l => l.trim())
const properties = new Set(rows.map(l => l.split(',')[1])).size

// ---- 3. encrypt, and delete the plain copies --------------------------------
const files = [dump, tb]
if (recipient) {
  console.log(`backup: encrypting with ${toolPath('age')}`)
  for (const f of files) {
    run('age', ['-r', recipient, '-o', `${f}.age`, f])
    fs.rmSync(f)
    plainFiles.delete(f)
  }
}
for (const f of files.map(f => (recipient ? `${f}.age` : f))) {
  console.log(`backup: ${path.basename(f)} ${(fs.statSync(f).size / 1048576).toFixed(2)} MB`)
}
console.log(`backup: trial balance of ${rows.length} account row(s) across ${properties} propert(ies) recorded; ${recipient ? 'encrypted to the owner key' : 'NOT encrypted (local test)'}`)
