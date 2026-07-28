// A generic, user-facing error humaniser (rule 11: surface the error, never
// swallow it). CLAUDE.md's rule-11 example calls a `humanize(e)` before showing a
// toast; this is it, shared so every module reads a failure the same way rather
// than dumping a raw PostgREST error at the user.
//
// It maps the Postgres/PostgREST error codes a direct table write can raise into
// plain language, and falls back to the server's own message (then a safe
// default) for anything unmapped. The settings surfaces keep their own
// mediaErrorMessage for the custom PT4xx SQLSTATEs their RPCs raise; this covers
// the standard SQLSTATEs a direct insert/update hits (RLS denial, constraint
// violations).

interface PostgrestLikeError {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
}

// Full diagnostic text for a failure, for surfaces that must show the REAL error
// rather than a friendly substitution (a "couldn't load" panel — rule 11). Unlike
// humanizeError, it does NOT map codes to soft copy: it assembles every field a
// Supabase/PostgREST error carries (message, details, hint, code), so the actual
// cause is visible. Critically it reads the fields off the ORIGINAL error object;
// wrapping such an object in `new Error(String(e))` yields "[object Object]"
// because a PostgREST error is a plain object, not an Error — so callers must
// pass the raw error through, never a stringified copy.
export function describeError(e: unknown): string {
  if (e === null || e === undefined) return 'Something went wrong. Please try again.';
  if (typeof e === 'string') return e;

  const err = e as PostgrestLikeError;
  const parts: string[] = [];
  if (err.message) parts.push(err.message);
  if (err.details) parts.push(err.details);
  if (err.hint) parts.push(`Hint: ${err.hint}`);
  if (err.code) parts.push(`(code ${err.code})`);
  if (parts.length > 0) return parts.join(' — ');

  // A genuine Error with only a message, or anything else.
  if (e instanceof Error && e.message) return e.message;
  return 'Something went wrong. Please try again.';
}

export function humanizeError(e: unknown): string {
  const err = e as PostgrestLikeError | null;
  switch (err?.code) {
    case '42501': // insufficient_privilege — an RLS policy refused the write
      return 'You do not have permission to make this change.';
    case '23505': // unique_violation
      return 'That already exists. Please use a different value.';
    case '23502': // not_null_violation
      return 'A required field is missing. Please fill it in and try again.';
    case '23514': // check_violation — surface the DB message (e.g. date order)
      return err?.message || 'One of the values is not allowed. Please review and try again.';
    default:
      return err?.message || 'Something went wrong. Please try again.';
  }
}
