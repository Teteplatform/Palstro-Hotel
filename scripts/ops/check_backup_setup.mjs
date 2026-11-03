#!/usr/bin/env node
// =============================================================================
//  IS THE BACKUP SET UP?    (docs/backups.md)
//  Run by the db-backup workflow with mode "check-setup", or locally with the
//  same variables in the environment.
// =============================================================================
//  WHY THIS EXISTS. A scheduled backup that is missing one secret fails at 21:43
//  Lagos, and the person who can fix it is asleep. This answers the same question
//  in thirty seconds, by hand, before anybody is relying on it — and it is how we
//  test a change to the workflow without waiting a day for the next slot.
//
//  It prints ONLY present / missing / ok / FAIL for each check. Never a value,
//  never a host, never a user name, and never a server message: a failure is
//  named by its KIND ("the user name or password was refused", "the host does not
//  answer"), because this repository's Actions logs may be world-readable and a
//  server message quotes back more than people expect.
//
//    BACKUP_DB_URL          well formed (postgresql://hotel_backup.<ref>@<pooler
//                           host>:5432/postgres — the SESSION pooler on 5432, not
//                           the transaction pooler on 6543, which cannot serve
//                           pg_dump); connects; the login is hotel_backup; reads
//                           every row (BYPASSRLS + pg_read_all_data); is read-only
//                           by default; cannot write; and can read a row from each
//                           schema the dump covers (public, auth)
//    BACKUP_AGE_RECIPIENT   an age PUBLIC key that age accepts as a recipient
//    BACKUP_AGE_KEY         (monthly restore test only) an age private key whose
//                           public key is BACKUP_AGE_RECIPIENT — i.e. proof that a
//                           backup we take can actually be decrypted again
//    SUPABASE_URL           https://<ref>.supabase.co, and the API answers
//    SUPABASE_ANON_KEY      accepted by the API
//
//  Needs psql and age (via PG_BIN / AGE_BIN or the PATH). Exit 1 if a required
//  check is missing or fails.
//
//  Ported from palstro-fuel/scripts/ops/check_backup_setup.mjs. Changed here:
//  the role name; the schema probes (no `ops` schema in this product);
//  SUPABASE_SERVICE_ROLE_KEY is NOT required, because the check it serves at the
//  station is a daily safety job this product does not have, and demanding a
//  secret nothing reads would make this report red for no reason; and the project
//  ref is DERIVED from SUPABASE_URL rather than written in, both because
//  CLAUDE.md rule 17 forbids the literal and because comparing the two secrets
//  catches a backup pointed at the wrong project — which a hardcoded ref cannot.
// =============================================================================
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ageRecipient, runTool, toolPath } from './tools.mjs'

const ROLE = 'hotel_backup'
const env = process.env
let failed = 0
const line = (name, state, note = '') => {
  console.log(`${state.padEnd(8)} ${name}${note ? `  (${note})` : ''}`)
  if (state === 'FAIL' || state === 'MISSING') failed++
}
const has = k => typeof env[k] === 'string' && env[k].trim() !== ''

// A server or tool message turned into its kind, never echoed.
const kind = s => {
  const t = String(s ?? '')
  if (/password authentication failed|authentication failed|SASL|Tenant or user not found|user .* not found/i.test(t)) return 'the user name or password was refused'
  if (/could not translate host name|Name or service not known|getaddrinfo/i.test(t)) return 'the host name does not resolve'
  if (/timeout|timed out|could not connect|Connection refused|No route to host|Network is unreachable/i.test(t)) return 'the host does not answer'
  if (/SSL/i.test(t)) return 'the secure connection failed'
  if (/permission denied/i.test(t)) return 'permission denied'
  if (/ENOENT|not found|not recognized/i.test(t)) return 'the tool is not installed'
  return 'it failed (details withheld so no value is printed)'
}

// The project ref, taken from SUPABASE_URL when we have it. Not a literal (rule 17).
const refFromUrl = has('SUPABASE_URL')
  ? (env.SUPABASE_URL.trim().match(/^https:\/\/([a-z0-9]+)\.supabase\.co\/?$/) ?? [])[1] ?? null
  : null

// ── BACKUP_DB_URL ───────────────────────────────────────────────────────────
if (!has('BACKUP_DB_URL')) line('BACKUP_DB_URL present', 'MISSING')
else {
  line('BACKUP_DB_URL present', 'ok')
  let u = null
  try { u = new URL(env.BACKUP_DB_URL.trim()) } catch { /* reported by the shape checks */ }
  const user = u ? decodeURIComponent(u.username) : ''
  const userRef = (user.match(/^[a-z_]+\.([a-z0-9]{16,})$/) ?? [])[1] ?? null

  const shape = [
    [u && /^postgres(ql)?:$/.test(u.protocol), 'starts with postgresql://'],
    [u && user.startsWith(`${ROLE}.`), `the user is ${ROLE}.<project ref>`],
    [u && u.password !== '', 'has a password'],
    [u && /\.pooler\.supabase\.com$/.test(u.hostname), 'the host is the Supabase pooler (*.pooler.supabase.com)'],
    [u && (u.port || '5432') === '5432', 'the port is 5432 (session pooler; 6543 cannot serve pg_dump)'],
    [u && (u.pathname.slice(1) || 'postgres') === 'postgres', 'the database is postgres'],
  ]
  for (const [ok, what] of shape) line(`BACKUP_DB_URL ${what}`, ok ? 'ok' : 'FAIL')

  // The cross-check a hardcoded ref cannot make: is this the SAME project the app
  // talks to? A backup of the wrong project is the most expensive kind of green.
  if (refFromUrl && userRef) {
    line('BACKUP_DB_URL and SUPABASE_URL name the same project',
      userRef === refFromUrl ? 'ok' : 'FAIL',
      userRef === refFromUrl ? '' : 'the backup login belongs to a different project than the app')
  } else if (!refFromUrl) {
    line('BACKUP_DB_URL and SUPABASE_URL name the same project', 'note', 'not checked: SUPABASE_URL is missing or not in the https://<ref>.supabase.co form')
  }

  if (shape.every(([ok]) => ok)) {
    const penv = { ...env, PGPASSWORD: decodeURIComponent(u.password), PGSSLMODE: 'require', PGCONNECT_TIMEOUT: '20' }
    delete penv.BACKUP_DB_URL
    delete penv.BACKUP_AGE_KEY
    const conn = ['-h', u.hostname, '-p', u.port || '5432', '-U', user, '-d', 'postgres', '-X', '-At', '-v', 'ON_ERROR_STOP=1']
    const q = sql => {
      const t = runTool('psql', [...conn, '-f', '-'], { env: penv, input: sql, timeout: 60000 })
      return { status: t.ok ? 0 : 1, stdout: t.stdout, stderr: t.stderr || t.cause }
    }

    // One round trip for every attribute, so a slow pooler does not turn this into
    // eight connections.
    const r = q(`SELECT current_user = '${ROLE}',
                        r.rolbypassrls,
                        pg_has_role(current_user, 'pg_read_all_data', 'member'),
                        current_setting('default_transaction_read_only') = 'on',
                        (SELECT count(*) > 0 FROM public.tenants),
                        (SELECT count(*) > 0 FROM public.properties),
                        (SELECT count(*) > 0 FROM auth.users)
                   FROM pg_roles r WHERE r.rolname = current_user`)

    if (r.status !== 0) line('BACKUP_DB_URL connects', 'FAIL', kind(r.stderr))
    else {
      line('BACKUP_DB_URL connects', 'ok')
      const v = r.stdout.trim().split('|')
      const names = [
        `the login is ${ROLE}`,
        'it reads every row (BYPASSRLS) — without this pg_dump STOPS on any RLS table',
        'it has pg_read_all_data',
        'its transactions are read-only by default',
        'it reads public (tenants)',
        'it reads public (properties)',
        'it reads auth (the logins the audit columns point at)',
      ]
      names.forEach((n, i) => line(`backup login: ${n}`, v[i] === 't' ? 'ok' : 'FAIL'))

      // The write probe, with the read-only default deliberately turned OFF —
      // because the role can turn it off itself, so refusing a write *inside* a
      // read-only transaction proves only that the setting is on. The grant
      // underneath it is the real guarantee (see prove_backup_role.mjs).
      const tw = q('SET default_transaction_read_only = off; BEGIN READ WRITE; UPDATE public.tenants SET name = name WHERE false; ROLLBACK')
      line('backup login: cannot write, even with the read-only default switched off',
        tw.status !== 0 ? 'ok' : 'FAIL',
        tw.status !== 0 ? '' : 'an UPDATE on public.tenants was allowed — the login holds write grants')
    }
  }
}

// ── age: the same binary, found the same way, as the night's backup ─────────
const ageCause = t => (t.cause.includes('could not run') ? t.cause : kind(t.stderr))
if (!has('BACKUP_AGE_RECIPIENT')) line('BACKUP_AGE_RECIPIENT present', 'MISSING')
else {
  const rec = ageRecipient(env.BACKUP_AGE_RECIPIENT)
  line('BACKUP_AGE_RECIPIENT present', 'ok', rec.trimmed ? 'had surrounding whitespace (trimmed)' : '')
  line('BACKUP_AGE_RECIPIENT is a public key (age1..., not the private key)',
    rec.wellFormed ? 'ok' : 'FAIL',
    rec.isPrivate ? 'this is the PRIVATE key: remove it from this secret at once and put only the age1... public key here' : '')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-check-'))
  try {
    const plain = path.join(dir, 'probe.txt'), sealed = path.join(dir, 'probe.txt.age')
    fs.writeFileSync(plain, 'backup set-up check\n')
    const t = runTool('age', ['-r', rec.value, '-o', sealed, plain], { timeout: 30000 })
    const made = t.ok && fs.existsSync(sealed) && fs.statSync(sealed).size > 0
    line(`age encrypts a file to BACKUP_AGE_RECIPIENT (the backup's own binary: ${toolPath('age')})`,
      made ? 'ok' : 'FAIL', made ? '' : ageCause(t))
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}

if (!has('BACKUP_AGE_KEY')) line('BACKUP_AGE_KEY present (monthly restore test)', 'MISSING')
else {
  line('BACKUP_AGE_KEY present (monthly restore test)', 'ok')
  const secret = (env.BACKUP_AGE_KEY.match(/AGE-SECRET-KEY-1[0-9A-Z]+/) ?? [])[0]
  if (!secret) line('BACKUP_AGE_KEY is an age private key (AGE-SECRET-KEY-1...)', 'FAIL')
  else {
    // THE CHECK THAT MATTERS MOST IN THIS FILE: a backup nobody can decrypt is not
    // a backup. Derives the public key from the private one and compares.
    const pub = runTool('age-keygen', ['-y'], { input: secret + '\n', timeout: 30000 })
    const same = pub.ok && has('BACKUP_AGE_RECIPIENT') && pub.stdout.trim() === ageRecipient(env.BACKUP_AGE_RECIPIENT).value
    line('BACKUP_AGE_KEY matches BACKUP_AGE_RECIPIENT (a backup we take can be decrypted again)',
      same ? 'ok' : 'FAIL', pub.ok ? '' : ageCause(pub))
  }
}

// ── the API ─────────────────────────────────────────────────────────────────
const api = async (key, what) => {
  try {
    const r = await fetch(`${env.SUPABASE_URL.trim().replace(/\/$/, '')}/auth/v1/health`,
      { headers: { apikey: env[key].trim() }, signal: AbortSignal.timeout(30000) })
    return r.status === 200 ? ['ok', ''] : ['FAIL', `${what} answered ${r.status}`]
  } catch { return ['FAIL', 'the API does not answer'] }
}

if (!has('SUPABASE_URL')) line('SUPABASE_URL present', 'MISSING')
else {
  line('SUPABASE_URL present', 'ok')
  line('SUPABASE_URL is https://<project ref>.supabase.co', refFromUrl ? 'ok' : 'FAIL')
}
if (!has('SUPABASE_ANON_KEY')) line('SUPABASE_ANON_KEY present', 'MISSING')
else {
  line('SUPABASE_ANON_KEY present', 'ok')
  if (has('SUPABASE_URL')) {
    const [s, n] = await api('SUPABASE_ANON_KEY', 'the API')
    line('SUPABASE_ANON_KEY accepted (the API answers)', s, n)
  }
}

console.log(failed
  ? `\nSETUP: ${failed} check(s) missing or failed. Fix them in GitHub > Settings > Secrets and variables > Actions, then run this again.`
  : '\nSETUP: every check passed.')
process.exit(failed ? 1 : 0)
