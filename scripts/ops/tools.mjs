// The command-line tools the backup scripts run, found the SAME WAY by backup.mjs
// and check_backup_setup.mjs — so the set-up check runs exactly what the night's
// backup will run. That is the whole point of this file existing rather than each
// script resolving its own binaries: a check that passes against a different psql
// from the one the backup uses has certified nothing.
//
// PostgreSQL tools come from PG_BIN when it is set; age and age-keygen from AGE_BIN
// when set, otherwise the PATH. A tool that could not start is reported with its
// cause (error code, signal, and the path tried), because "psql failed" sends
// somebody looking at the database when the real answer is that the binary is not
// installed. A secret is never part of a message.
//
// Ported from palstro-fuel/scripts/ops/tools.mjs, unchanged except this header —
// it holds nothing product-specific.
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const PG_TOOLS = new Set(['pg_dump', 'pg_restore', 'psql'])
const AGE_TOOLS = new Set(['age', 'age-keygen'])
const exe = n => (process.platform === 'win32' ? `${n}.exe` : n)

export function toolPath(name) {
  if (PG_TOOLS.has(name) && process.env.PG_BIN) return path.join(process.env.PG_BIN, exe(name))
  if (AGE_TOOLS.has(name) && process.env.AGE_BIN) return path.join(process.env.AGE_BIN, exe(name))
  return name
}

// runs a tool; returns { ok, status, stdout, stderr, cause } where cause explains a
// failure without any secret in it
export function runTool(name, args, opts = {}) {
  const tried = toolPath(name)
  const r = spawnSync(tried, args, { encoding: 'utf8', maxBuffer: 1 << 30, ...opts })
  if (r.error || r.status === null) {
    const code = r.error?.code
    const why = code === 'ENOENT' ? 'ENOENT: no such program'
              : code === 'EACCES' ? 'EACCES: not allowed to run it'
              : code ? `${code}`
              : `killed by signal ${r.signal}`
    return {
      ok: false, status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '',
      cause: `${name} could not run (${why}${code && r.signal ? `, signal ${r.signal}` : ''}; tried "${tried}"${tried === name ? ' on the PATH' : ''})`,
    }
  }
  return {
    ok: r.status === 0, status: r.status, stdout: r.stdout, stderr: r.stderr,
    cause: r.status === 0 ? '' : `${name} exited with status ${r.status}`,
  }
}

// an age public key, trimmed; `trimmed` says whether surrounding whitespace (a
// space, a newline) had to be removed — which happens when a secret is pasted into
// the GitHub box, and which otherwise fails as an unreadable recipient
export function ageRecipient(raw) {
  const value = String(raw ?? '').trim()
  return {
    value,
    trimmed: value !== String(raw ?? ''),
    wellFormed: /^age1[02-9ac-hj-np-z]{58}$/.test(value),
    isPrivate: /^AGE-SECRET-KEY-/i.test(value),
  }
}
