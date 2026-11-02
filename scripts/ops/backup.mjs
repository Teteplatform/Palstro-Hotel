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
//   2. A MANIFEST — hotel-<stamp>.manifest.json — recording what this dump is
//      supposed to contain: a row count for EVERY table in both schemas, the
//      applied-migration count and highest version, gl_wired_at per property,
//      the document counters as values, and the trial balance as rows. The
//      monthly restore test asserts the restored copy against this file table by
//      table, instead of against a handful of tables somebody chose.
//   3. Both encrypted with age to the owner's PUBLIC key (--recipient or
//      BACKUP_AGE_RECIPIENT); the plain files are then deleted.
//      --no-encrypt exists for a local test only and is refused unless
//      BACKUP_DB_URL names localhost.
//
//  WHY A MANIFEST RATHER THAN A CHOSEN LIST OF CHECKS. The failure being guarded
//  against is a backup that silently contains LESS than it should — and a
//  hand-picked list of tables cannot catch that in a table nobody picked,
//  including a table that does not exist yet on the day the list was written.
//  The manifest is the check I was running by hand to verify my own work; writing
//  it into the artifact is what lets the restore test run it instead of a person.
//
//  WHY `auth` AND NOT JUST `public`. Every table in this database carries
//  created_by / updated_by referencing auth.users (CLAUDE.md §6, actor columns).
//  Restore `public` alone and every one of those foreign keys points at a user
//  row that does not exist — so the restore either fails or has to be loaded with
//  the constraints off, and "who did this" becomes unanswerable for every row.
//  The customer's primary pain is staff theft; the audit trail is the product.
//
//  WHY NOT THE `storage` SCHEMA IN THE DUMP. It holds only the METADATA of
//  uploaded files. The bytes live in S3 and no pg_dump flag reaches them, so
//  dumping the metadata alone would produce rows pointing at nothing and read
//  like a backup of the images. The bytes are taken separately, below.
//
//  ---------------------------------------------------------------------------
//  THE STORAGE ARCHIVE, AND WHY IT NEEDS NO NEW CREDENTIAL
//  ---------------------------------------------------------------------------
//  media_assets carries no checksum and no source URL. It describes the bytes;
//  it cannot re-fetch them. So the objects in the bucket are THE ONLY COPY, and
//  restoring the database alone leaves live rows pointing at nothing — the guest
//  site renders broken images and nothing in the system can say what they were.
//
//  Reaching them costs nothing extra:
//    * the object list comes from storage.objects over the connection this
//      script already opens (pg_read_all_data covers the storage schema), which
//      is the authoritative list rather than media_assets, an index that could
//      in principle drift from it;
//    * the BYTES come from the public CDN endpoint with NO credential at all,
//      because property-media is a public bucket (005/013).
//  The alternatives were a service-role key (BYPASSRLS, write grants on 66
//  relations in public and 5 in storage, EXECUTE on 105 functions) or a Supabase
//  S3 key (project-scoped, full write and DELETE on every bucket, no read-only
//  variant). Both can destroy the thing this job exists to copy. Neither is used.
//
//  EVERY VARIANT IS KEPT, card and thumb included. They are derivable from `full`
//  in theory; in a real recovery nobody is going to re-run a resize pipeline and
//  write files back at exact paths while the hotel is down. At 630 KB that choice
//  is free.
//
//  WHEN TO REVISIT: 9 objects / 630 KB today. Projected at ~30 rooms photographed
//  (8 photos x 3 variants x ~250 KB) plus menu and item images, this is ~180 MB,
//  which still fits a GitHub artifact at 30-day retention but stops being free.
//  Revisit when the archive passes ~250 MB or the artifact upload starts taking
//  longer than the dump: the first lever is keeping only `full` and documenting
//  that card/thumb must be regenerated. Also in docs/backups.md.
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
import { createHash } from 'node:crypto'
import { ageRecipient, runTool, toolPath } from './tools.mjs'

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/)
  return m ? [m[1], m[2] ?? true] : [a, true]
}))

// The unencrypted files and staging directories this run made. Removed if the run
// stops for ANY reason, so a half-made dump -- or a directory of freshly fetched
// guest-facing images -- never stays behind in plain text on a runner or a laptop.
const plainFiles = new Set()
const tempDirs = new Set()
const die = m => {
  for (const f of plainFiles) fs.rmSync(f, { force: true })
  for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true })
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

// ---- 2. THE STORAGE ARCHIVE ---------------------------------------------------
// Enumerate the buckets, refuse to continue if any is private, fetch every object
// from the public endpoint, verify each download against the size the database
// recorded, checksum it, and tar the lot.
const storageJson = run('psql', [...conn, '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-c', `
SELECT json_build_object(
  'buckets', (SELECT coalesce(json_agg(json_build_object(
                'id', b.id, 'public', b.public,
                'objects', (SELECT count(*) FROM storage.objects o WHERE o.bucket_id = b.id),
                'bytes', (SELECT coalesce(sum((o.metadata->>'size')::bigint), 0) FROM storage.objects o WHERE o.bucket_id = b.id)
              ) ORDER BY b.id), '[]'::json) FROM storage.buckets b),
  'objects', (SELECT coalesce(json_agg(json_build_object(
                'bucket', o.bucket_id, 'name', o.name,
                'bytes', (o.metadata->>'size')::bigint,
                'mime', o.metadata->>'mimetype'
              ) ORDER BY o.bucket_id, o.name), '[]'::json) FROM storage.objects o)
)::text`]).trim()
let store
try { store = JSON.parse(storageJson) } catch { die('the storage query did not return valid JSON') }

// A PRIVATE BUCKET STOPS THE BACKUP. NEVER SKIPPED, NEVER WARNED PAST.
// The bytes are reachable without a credential ONLY because the bucket is public
// -- the public CDN endpoint does not consult storage.objects RLS at all. The day
// somebody adds a private bucket (guest identity documents are the obvious
// candidate), the public endpoint stops serving it and a warn-and-continue backup
// would quietly stop covering the most sensitive files in the system while still
// going green, still being the right size, and still being trusted. That is worse
// than no backup. So it is a named, fatal error that says what to do next.
const privateBuckets = store.buckets.filter(b => b.public !== true)
if (privateBuckets.length) {
  die(`REFUSING TO BACK UP: ${privateBuckets.length} storage bucket(s) are NOT public `
    + `(${privateBuckets.map(b => `${b.id}: ${b.objects} object(s), ${b.bytes} bytes`).join('; ')}).\n`
    + '               This script fetches object bytes from the PUBLIC CDN endpoint, which cannot reach a\n'
    + '               private bucket, so continuing would silently omit every object in it. Do NOT make the\n'
    + '               bucket public to fix this. Give this script a credential that can read the private\n'
    + '               bucket (a signed-URL mint or an S3 key scoped as tightly as Supabase allows), decide\n'
    + '               what that credential may do if the runner is compromised, and write the decision in\n'
    + '               docs/backups.md before enabling it.')
}

// The project URL is DERIVED from the connection's user name (hotel_backup.<ref>)
// rather than taken from an environment variable or written in -- rule 17, and it
// also makes it impossible for the bytes and the database to come from different
// projects, which a separate SUPABASE_URL secret would allow.
const projectRef = (decodeURIComponent(u.username).match(/\.([a-z0-9]{16,})$/) ?? [])[1]
if (!projectRef && store.objects.length) die('cannot read the project ref from the BACKUP_DB_URL user name, so the public storage endpoint cannot be addressed')
const publicBase = `https://${projectRef}.supabase.co/storage/v1/object/public`
const encodePath = p => p.split('/').map(encodeURIComponent).join('/')

const storageDir = path.join(out, `storage-${stamp}`)
const storageTar = path.join(out, `hotel-${stamp}.storage.tar`)
const storedObjects = []
if (store.objects.length) {
  fs.mkdirSync(storageDir, { recursive: true })
  tempDirs.add(storageDir)
  let fetched = 0
  for (const o of store.objects) {
    const url = `${publicBase}/${o.bucket}/${encodePath(o.name)}`
    let body
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(120000) })
      if (!r.ok) {
        die(`storage object ${o.bucket}/${o.name} could not be fetched (HTTP ${r.status}). `
          + 'The database has a row for it and the bytes are not there, which is the orphan this backup exists to prevent.')
      }
      body = Buffer.from(await r.arrayBuffer())
    } catch (e) {
      die(`storage object ${o.bucket}/${o.name} could not be fetched: ${e.message}`)
    }
    // VERIFIED AGAINST THE RECORDED SIZE, not merely against a 200. A truncated
    // or error-page response is a 200 with the wrong length, and an archive of
    // nine HTML error pages is exactly the right shape.
    if (String(body.length) !== String(o.bytes)) {
      die(`storage object ${o.bucket}/${o.name} came back ${body.length} bytes but the database records ${o.bytes}. `
        + 'Refusing to archive a file that is not the file.')
    }
    const target = path.join(storageDir, o.bucket, o.name)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, body)
    storedObjects.push({
      bucket: o.bucket, name: o.name, bytes: Number(o.bytes), mime: o.mime ?? null,
      sha256: createHash('sha256').update(body).digest('hex'),
    })
    fetched++
  }
  // tar, not zip: present on every runner and in Git Bash, so these scripts stay
  // free of npm dependencies and the workflow needs no install step.
  //
  // RUN FROM `out` WITH BASENAMES, never with absolute paths. GNU tar treats an
  // argument containing a colon as `host:path` and tries to resolve a remote
  // host, so an absolute Windows path fails with "Cannot connect to C: resolve
  // failed". --force-local fixes it on GNU tar and does not exist on bsdtar;
  // passing basenames from a cwd works on both and needs no platform branch.
  run('tar', ['-cf', path.basename(storageTar), '-C', path.basename(storageDir), '.'], { cwd: out })
  fs.rmSync(storageDir, { recursive: true, force: true })
  tempDirs.delete(storageDir)
  plainFiles.add(storageTar)
  console.log(`backup: storage archive holds ${fetched} object(s) from ${store.buckets.length} bucket(s), `
    + `${storedObjects.reduce((a, o) => a + o.bytes, 0)} bytes, each verified against its recorded size and checksummed`)
} else {
  console.log('backup: no storage objects to archive')
}

// ---- 3. THE MANIFEST: what this dump is supposed to contain ------------------
// The restore test asserts against this file rather than against a list of
// tables somebody chose, which is the difference between proving the backup is
// complete and proving the six tables we remembered to check are present.
//
// EVERY table in both dumped schemas, not a chosen few. A backup that silently
// contains less than it should is the failure this whole file exists to catch,
// and a hand-picked list cannot catch it in a table nobody picked — including a
// table that does not exist yet on the day the list was written.
//
// Counts come from query_to_xml so that one statement counts every table
// exactly. count(*) per table in a single pass, no dynamic round trips, and no
// reliance on pg_class.reltuples, which is an ESTIMATE the planner maintains and
// is routinely wrong right after a bulk change — an estimate here would make the
// restore test compare two guesses and call it agreement.
//
// EVERY MONETARY AND TIMESTAMP VALUE IS CAST TO text. numeric in JSON becomes a
// JSON number, and JSON numbers go through JavaScript as doubles — so a kobo
// could be lost between recording the manifest and comparing it, and the
// comparison would fail (or worse, pass) for a reason that has nothing to do
// with the backup. Text compares exactly. Same reason CLAUDE.md §6 types money
// as string on the way out of PostgREST.
const manifest = path.join(out, `hotel-${stamp}.manifest.json`)
plainFiles.add(manifest)
const manifestSql = `
SELECT json_build_object(
  'manifest_version', 1,
  'taken_at',         to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  'stamp',            '${stamp}',
  'server_version',   current_setting('server_version'),
  'schemas',          json_build_array('public', 'auth'),

  -- the highest applied migration and how many there are: a restored copy whose
  -- schema history is short is a restored copy of an older database
  'migrations', (
    SELECT json_build_object('applied_count', count(*), 'highest', max(version))
      FROM supabase_migrations.schema_migrations
  ),

  -- a row count for EVERY table in public and auth
  'tables', (
    SELECT coalesce(json_agg(t ORDER BY t.schema, t.table_name), '[]'::json) FROM (
      SELECT c.table_schema AS schema,
             c.table_name,
             ((xpath('/row/n/text()',
                query_to_xml(format('SELECT count(*) AS n FROM %I.%I', c.table_schema, c.table_name),
                             false, true, '')))[1]::text)::bigint AS rows
        FROM information_schema.tables c
       WHERE c.table_schema IN ('public', 'auth')
         AND c.table_type = 'BASE TABLE'
    ) t
  ),

  -- gl_wired_at per property. 047 stamped it once; it is a FACT about when this
  -- property's RPCs began posting, it cannot be re-derived from anything, and a
  -- rebuild from migrations would stamp now() and silently re-explain movements
  -- that genuinely failed to post. gl_start_date rides along because the pair is
  -- easy to confuse and the restore should be able to show both.
  'finance_settings', (
    SELECT coalesce(json_agg(json_build_object(
             'property_id',   property_id,
             'gl_wired_at',   to_char(gl_wired_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
             'gl_start_date', gl_start_date::text
           ) ORDER BY property_id), '[]'::json)
      FROM public.property_finance_settings
  ),

  -- the counters AS VALUES, not counts. Restore these wrong and the next booking
  -- reuses a number already issued (CLAUDE.md section 6, document numbering).
  --
  -- Columns are listed EXPLICITLY rather than taking to_jsonb(d) of the whole
  -- row, for two reasons. The rows carry created_at / updated_at, which are audit
  -- metadata and never the basis for a figure, and a timestamptz rendered
  -- into JSON takes its text form from the SESSION's TimeZone, so a manifest
  -- written in one timezone and compared in another would differ on a field
  -- nobody cares about and fail the restore test for no reason. last_number is
  -- the value that matters, and it is an integer, so it compares exactly.
  'document_counters', (
    SELECT coalesce(json_agg(json_build_object(
             'tenant_id',   d.tenant_id,
             'property_id', d.property_id,
             'doc_type',    d.doc_type,
             'last_number', d.last_number
           ) ORDER BY d.tenant_id, d.property_id, d.doc_type), '[]'::json)
      FROM public.document_counters d
  ),
  'document_period_counters', (
    SELECT coalesce(json_agg(json_build_object(
             'tenant_id',   p.tenant_id,
             'property_id', p.property_id,
             'doc_type',    p.doc_type,
             'year_month',  p.year_month,
             'last_number', p.last_number
           ) ORDER BY p.tenant_id, p.property_id, p.doc_type, p.year_month), '[]'::json)
      FROM public.document_period_counters p
  ),

  -- the trial balance as rows, however many there are (today: none).
  -- Grouped by tenant AND property, because this product's journal is
  -- per-property. A tenant-only grouping would add two hotels together and
  -- still balance, and a figure that agrees for the wrong reason is worse than
  -- one that disagrees. property_id is on journal_entries, not the lines.
  'trial_balance', (
    SELECT coalesce(json_agg(json_build_object(
             'tenant_id',   tb.tenant_id,
             'property_id', tb.property_id,
             'account_id',  tb.account_id,
             'debit',       tb.debit,
             'credit',      tb.credit,
             'lines',       tb.lines
           ) ORDER BY tb.tenant_id, tb.property_id, tb.account_id), '[]'::json)
      FROM (
        SELECT l.tenant_id::text   AS tenant_id,
               je.property_id::text AS property_id,
               l.account_id::text  AS account_id,
               sum(l.debit)::numeric(14,2)::text  AS debit,
               sum(l.credit)::numeric(14,2)::text AS credit,
               count(*)            AS lines
          FROM public.journal_entry_lines l
          JOIN public.journal_entries je ON je.id = l.journal_entry_id
         GROUP BY l.tenant_id, je.property_id, l.account_id
      ) tb
  )
)::text`
// EVERY SQL STRING WE SEND STAYS ASCII, and this is checked rather than assumed.
// A non-ASCII character in the SQL -- an em dash or a section sign in a comment --
// is handed to psql through the Windows process boundary in the console codepage,
// and psql rejects it as `invalid byte sequence for encoding "UTF8"`. That message
// points at the DATA and sends the next person looking for a corrupt row, when the
// cause is a typographic character in a comment nobody reads. Cost me a run.
const nonAscii = [...manifestSql].filter(c => c.charCodeAt(0) > 127)
if (nonAscii.length) {
  die(`the manifest SQL contains ${nonAscii.length} non-ASCII character(s) (${JSON.stringify([...new Set(nonAscii)].join(''))}). `
    + 'Keep SQL sent to psql ASCII-only and put the prose in a JS comment instead.')
}
const manifestJson = run('psql', [...conn, '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-c', manifestSql]).trim()
let parsed
try { parsed = JSON.parse(manifestJson) } catch { die('the manifest query did not return valid JSON') }

// The storage half of the manifest, recorded from what was actually fetched and
// checksummed rather than from what the database said it would be. The restore
// test verifies the ARCHIVED bytes against these checksums -- it does NOT re-fetch
// from live, which would make it a monitoring check that fails when the internet
// is down rather than a restore check that proves the artifact is sound.
parsed.storage = {
  archive: store.objects.length ? path.basename(storageTar) : null,
  buckets: store.buckets,
  object_count: storedObjects.length,
  total_bytes: storedObjects.reduce((a, o) => a + o.bytes, 0),
  objects: storedObjects,
}

// Written pretty, because the one time somebody reads this by hand is the day the
// database is gone and they are not having a good day.
fs.writeFileSync(manifest, JSON.stringify(parsed, null, 2) + '\n')

const tableCount = parsed.tables.length
const rowTotal = parsed.tables.reduce((a, t) => a + Number(t.rows), 0)
const tbRows = parsed.trial_balance.length

// ---- 4. encrypt, and delete the plain copies --------------------------------
const files = store.objects.length ? [dump, storageTar, manifest] : [dump, manifest]
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
console.log(`backup: storage ${parsed.storage.object_count} object(s), ${parsed.storage.total_bytes} bytes, `
  + `${parsed.storage.buckets.length} bucket(s) all public, each object checksummed`)
console.log(`backup: manifest records ${tableCount} tables, ${rowTotal} rows, `
  + `${parsed.finance_settings.length} propert(ies), `
  + `${parsed.document_counters.length} document counter(s), `
  + `migrations ${parsed.migrations.applied_count} (highest ${parsed.migrations.highest}), `
  + `trial balance ${tbRows} row(s)${tbRows === 0 ? ' — EMPTY, so the restore test will report that comparison as vacuous rather than passing it' : ''}`)
console.log(`backup: ${recipient ? 'encrypted to the owner key' : 'NOT encrypted (local test)'}`)
