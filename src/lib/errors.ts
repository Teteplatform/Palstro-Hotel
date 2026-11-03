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

// THE HINT IS HALF THE REFUSAL, and dropping it is the subtle half of rule 21.
//
// A refusal shown without its hint says "no" without "instead" — and the pressure
// is then to write the "instead" into a component, which is a second source of
// truth about a rule that lives in the database. 042's sellable-needs-a-price
// trigger is exactly this shape: the message states the rule ("a Sold as-is item
// must have a selling price") and the hint states the way out ("enter what one kg
// sells for, or set its type to Ingredient"). Showing only the first would leave a
// storekeeper stuck at a form with no route through it.
//
// Verbatim, both of them. Never re-worded — see rule 21's snippet, which this is.
function withHint(message: string, err: PostgrestLikeError | null): string {
  const hint = err?.hint?.trim();
  return hint ? `${message} — ${hint}` : message;
}

// 42501 IS TWO DIFFERENT EVENTS WEARING ONE SQLSTATE, and this is the 1.1c
// lesson arriving at the generic layer.
//
// 1.1c fixed stockErrorMessage to stop swallowing hints and left THIS — the
// function ninety-odd other surfaces call — returning a hardcoded sentence for
// every `insufficient_privilege`. The walk found what that costs: an
// over-receipt refusal that the database had written out in full
//
//   "More arrived than was ordered, so a manager has to authorise accepting it."
//   hint: "Hand the terminal to a manager. Accepting more than was ordered
//          commits the hotel to paying for it, and the authorisation is
//          recorded against them by name."
//
// reached the storekeeper as "You do not have permission to make this change."
// 98 refusals across the migrations raise insufficient_privilege and 25 of them
// carry a hand-written hint; all 25 were being replaced by that one sentence.
// That is rule 21 inverted — the client authoring the refusal and discarding the
// database's.
//
// The two events:
//
//   * POSTGRES raised it. An RLS policy or a GRANT refused, and the message is
//     machine text ("new row violates row-level security policy for table
//     \"bookings\"") with no hint. Nobody outside this codebase should read it,
//     so the friendly substitution is right and stays.
//
//   * WE raised it. A `raise exception ... using errcode = 'insufficient_privilege'`
//     in a migration, with a sentence written for the person reading it and
//     usually a hint saying what to do instead. Rule 21 says show it verbatim.
//
// They are told apart by the message, because Postgres' own 42501 text is a
// short closed set. THE FALLBACK DIRECTION IS DELIBERATE: if Postgres ever
// rewords one of these, an unmatched message falls through to being SHOWN —
// slightly raw, and the truth. The opposite default hides an instruction, which
// is the defect being fixed here.
const POSTGRES_PRIVILEGE_TEXT =
  /^(permission denied|new row violates row-level security policy|must be owner of)/i;

function isPostgresPrivilegeDenial(err: PostgrestLikeError | null): boolean {
  const message = err?.message?.trim();
  if (!message) return true; // nothing to show, so show the friendly sentence
  return POSTGRES_PRIVILEGE_TEXT.test(message);
}

export function humanizeError(e: unknown): string {
  const err = e as PostgrestLikeError | null;
  switch (err?.code) {
    case '42501': // insufficient_privilege — see the note above: two events, one code
      return isPostgresPrivilegeDenial(err)
        ? 'You do not have permission to make this change.'
        : withHint(err?.message?.trim() ?? '', err);
    case '23505': // unique_violation
      return 'That already exists. Please use a different value.';
    case '23502': // not_null_violation
      return 'A required field is missing. Please fill it in and try again.';
    case '23514': // check_violation — surface the DB message (e.g. date order)
      return withHint(
        err?.message || 'One of the values is not allowed. Please review and try again.',
        err,
      );
    default:
      return withHint(err?.message || 'Something went wrong. Please try again.', err);
  }
}
