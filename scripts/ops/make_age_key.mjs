#!/usr/bin/env node
// =============================================================================
//  Create the age keypair the backups are encrypted to.    (docs/backups.md)
// =============================================================================
//  node scripts/ops/make_age_key.mjs [--force]
//
//  Writes BOTH halves into .env.local and prints NEITHER:
//    BACKUP_AGE_RECIPIENT   the PUBLIC key (age1...) — the backup encrypts to it
//    BACKUP_AGE_KEY         the PRIVATE key (AGE-SECRET-KEY-1...) — the ONLY thing
//                           that can decrypt a backup, ever
//
//  WHY TWO SECRETS AND NOT ONE PASSPHRASE. age encrypts to a public key, so the
//  nightly runner is given only BACKUP_AGE_RECIPIENT and therefore holds nothing
//  that can read its own output. Only the monthly restore test gets the private
//  key. With a shared passphrase, anyone who can read the secret can read every
//  backup ever taken, including the ones taken before they were given it.
//
//  *** THE PRIVATE KEY MUST ALSO LIVE SOMEWHERE THAT IS NOT THIS MACHINE AND NOT
//  THIS REPOSITORY. *** It is not recoverable. Lose it and every encrypted backup
//  becomes permanently unreadable — the backups keep arriving, keep being the
//  right size, and are scrap. Put it in a password manager the moment this runs.
//  A backup you cannot decrypt fails in exactly the same way as no backup at all,
//  except that it costs you the belief that you had one.
//
//  REFUSES TO OVERWRITE. If BACKUP_AGE_KEY is already in .env.local the script
//  stops, because generating a new keypair silently orphans every backup taken
//  under the old one. --force only after the old private key is safely stored and
//  you accept that existing artifacts become unreadable.
// =============================================================================
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { runTool, ageRecipient, toolPath } from './tools.mjs'

const REPO = path.resolve(import.meta.dirname, '../..')
const ENV_FILE = path.join(REPO, '.env.local')
const die = m => { console.error('make_age_key: ' + m); process.exit(1) }

if (!existsSync(ENV_FILE)) die('.env.local not found')
const raw = readFileSync(ENV_FILE, 'utf8')
const keyOf = k => {
  const m = raw.split(/\r?\n/).find(l => new RegExp('^\\s*' + k + '\\s*=').test(l))
  return m ? m.slice(m.indexOf('=') + 1).trim() : ''
}

const force = process.argv.includes('--force')
if (keyOf('BACKUP_AGE_KEY') && !force) {
  die('BACKUP_AGE_KEY is already set in .env.local. A new keypair makes every existing\n'
    + '               backup permanently unreadable. Store the current private key safely first,\n'
    + '               then re-run with --force if you really mean to rotate.')
}

// age-keygen prints the private key on stdout and the public key on stderr as
// "Public key: age1...". Both are captured; neither is printed.
const gen = runTool('age-keygen', [], { timeout: 30000 })
if (!gen.ok) die(`could not run age-keygen (tried "${toolPath('age-keygen')}"): ${gen.cause}`)

const secret = (gen.stdout.match(/AGE-SECRET-KEY-1[0-9A-Z]+/) ?? [])[0]
const pubFromErr = (gen.stderr.match(/age1[02-9ac-hj-np-z]{58}/) ?? [])[0]
const pubFromOut = (gen.stdout.match(/age1[02-9ac-hj-np-z]{58}/) ?? [])[0]
const publicKey = pubFromErr ?? pubFromOut
if (!secret) die('age-keygen did not produce a private key')
if (!publicKey) die('age-keygen did not produce a public key')

// The pair must actually correspond, or the backups encrypt to one key and the
// restore test holds another — which only shows up in a month, on the one run
// that matters. Derived again from the private key and compared.
const derived = runTool('age-keygen', ['-y'], { input: secret + '\n', timeout: 30000 })
if (!derived.ok) die('could not derive the public key from the private key')
if (derived.stdout.trim() !== publicKey) die('the generated keypair does not match itself; nothing was written')
if (!ageRecipient(publicKey).wellFormed) die('the generated public key is not well formed; nothing was written')

function upsert(lines, key, value, comment) {
  const re = new RegExp('^\\s*' + key + '\\s*=')
  let found = false
  const next = lines.map(l => (re.test(l) ? ((found = true), `${key}=${value}`) : l))
  if (!found) {
    if (next.length && next[next.length - 1].trim() !== '') next.push('')
    if (comment) next.push(comment)
    next.push(`${key}=${value}`)
    next.push('')
  }
  return next
}

let lines = raw.split(/\r?\n/)
lines = upsert(lines, 'BACKUP_AGE_RECIPIENT', publicKey,
  '# The age PUBLIC key the backups encrypt to (scripts/ops/make_age_key.mjs).')
lines = upsert(lines, 'BACKUP_AGE_KEY', secret,
  '# The age PRIVATE key. The ONLY thing that can decrypt a backup. Keep a copy\n'
  + '# in a password manager OFF this machine — it cannot be regenerated.')
while (lines.length && lines[lines.length - 1].trim() === '') lines.pop()
lines.push('')
writeFileSync(ENV_FILE, lines.join('\n'))

console.log('age keypair generated and written to .env.local (values not printed):')
console.log('  BACKUP_AGE_RECIPIENT   the public key  — goes in the GitHub secret of the same name')
console.log('  BACKUP_AGE_KEY         the private key — GitHub secret of the same name, AND a password manager')
console.log('\nThe pair was verified against itself: the public key derived from the private')
console.log('key matches the one recorded, so a backup taken with one can be opened with the other.')
console.log('\n*** Copy BACKUP_AGE_KEY into a password manager now. It cannot be regenerated, and')
console.log('*** without it every encrypted backup is scrap.')
