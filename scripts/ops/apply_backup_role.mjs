#!/usr/bin/env node
// =============================================================================
//  Create or rotate the read-only backup login `hotel_backup`.   (docs/backups.md)
// =============================================================================
//  node scripts/ops/apply_backup_role.mjs [--password=<letters and digits>]
//
//  WHAT IT DOES
//   1. Generates a 40-character alphanumeric password (or takes --password).
//   2. Substitutes it into scripts/ops/backup_role.sql IN MEMORY and pipes the
//      result to psql on SUPABASE_DB_URL. The substituted SQL never touches disk,
//      so the password exists in exactly two places: this process, and the
//      BACKUP_DB_URL line this script writes into .env.local.
//   3. Writes/updates BACKUP_DB_URL in .env.local — session pooler, port 5432,
//      user hotel_backup.<project-ref> — and prints the NAME only, never the value.
//
//  WHY NOT JUST RUN psql -f. Because `-f` needs a file, and a file with the real
//  password in it is a file somebody forgets to delete. stdin has no such copy.
//
//  WHY THE PASSWORD IS LETTERS AND DIGITS ONLY. It goes into a connection string
//  that is pasted into a GitHub secret and parsed by libpq, pg_dump and a URL
//  parser. A '#', '@', '/' or '%' in a password is a percent-encoding bug waiting
//  to happen, and the failure shows up as an authentication error that looks like a
//  wrong password rather than a quoting problem. 40 alphanumerics is ~238 bits.
// =============================================================================
import { spawnSync } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '../..');
const ENV_FILE = path.join(REPO, '.env.local');
const SQL_FILE = path.join(REPO, 'scripts/ops/backup_role.sql');
const ROLE = 'hotel_backup';
const PG_BIN = process.env.PG_BIN || 'C:/Program Files/PostgreSQL/17/bin';

const die = (m) => { console.error('apply_backup_role: ' + m); process.exit(1); };

// ---- .env.local, strict KEY=VALUE ------------------------------------------
function readEnv() {
  if (!existsSync(ENV_FILE)) die('.env.local not found');
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

// Replaces the line if the key exists, appends it otherwise. Touches nothing else,
// so the commented-out notes in .env.local survive untouched.
function upsertEnv(key, value) {
  const lines = readFileSync(ENV_FILE, 'utf8').split(/\r?\n/);
  const re = new RegExp('^\s*' + key + '\s*=');
  let found = false;
  const next = lines.map(l => (re.test(l) ? (found = true, `${key}=${value}`) : l));
  if (!found) {
    if (next.length && next[next.length - 1].trim() !== '') next.push('');
    next.push(`# The read-only backup login (scripts/ops/backup_role.sql). Session pooler, port 5432.`);
    next.push(`${key}=${value}`);
    next.push('');
  }
  writeFileSync(ENV_FILE, next.join('\n'));
  return found ? 'replaced' : 'appended';
}

const password = (() => {
  const arg = process.argv.find(a => a.startsWith('--password='));
  if (arg) {
    const p = arg.slice('--password='.length);
    if (!/^[A-Za-z0-9]{24,}$/.test(p)) die('--password must be 24+ characters, letters and digits only');
    return p;
  }
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 40 }, () => A[randomInt(A.length)]).join('');
})();

const env = readEnv();
const admin = env.SUPABASE_DB_URL || die('SUPABASE_DB_URL is not set in .env.local');
const u = new URL(admin);
// the pooler wants <db-user>.<project-ref>; take the ref from the admin URL rather
// than hardcoding it, so this script has no tenant-specific literal in it (rule 17)
const ref = (u.username.match(/\.([a-z0-9]{16,})$/) || [])[1] || die('cannot read the project ref from SUPABASE_DB_URL username');

// ---- apply, via stdin ------------------------------------------------------
const sql = readFileSync(SQL_FILE, 'utf8');
const anchor = "v_password text := 'CHANGE_ME_IN_EDITOR';";
if (!sql.includes(anchor)) die('could not find the password anchor in backup_role.sql');
const applied = sql.replace(anchor, `v_password text := '${password}';`);

const psql = path.join(PG_BIN, 'psql');
const r = spawnSync(psql, [admin, '-X', '-v', 'ON_ERROR_STOP=1', '-f', '-'],
  { input: applied, encoding: 'utf8', timeout: 180000 });

const scrub = (t) => String(t ?? '').split(password).join('«redacted»').split(admin).join('«SUPABASE_DB_URL»');
if (r.error) die(`could not run psql at ${psql}: ${r.error.message}`);
console.log('--- psql stdout ---');
console.log(scrub(r.stdout).trim() || '(empty)');
const err = scrub(r.stderr).trim();
if (err) { console.log('--- psql stderr ---'); console.log(err); }
if (r.status !== 0) die(`psql exited ${r.status}; nothing was written to .env.local`);

// ---- record the connection string, nowhere else ----------------------------
const backupUrl = `postgresql://${ROLE}.${ref}:${password}@${u.hostname}:${u.port || 5432}${u.pathname}`;
const how = upsertEnv('BACKUP_DB_URL', backupUrl);
console.log(`\nBACKUP_DB_URL ${how} in .env.local (value not printed).`);
console.log(`  user ${ROLE}.${ref} @ ${u.hostname}:${u.port || 5432}${u.pathname}`);
