// Small date helpers for the admin. Kept separate from format.ts (which is
// presentation-only) because these produce machine values ('YYYY-MM-DD'), not
// display strings.

// Today's date as a 'YYYY-MM-DD' string in the browser's local timezone — the
// value an <input type="date"> expects. Used to default the rate-preview date.
// Local (not UTC) so "today" matches the operator's calendar day; slicing
// toISOString() would shift near midnight in Africa/Lagos (UTC+1).
export function todayIso(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Today's date as a 'YYYY-MM-DD' string in a SPECIFIC IANA timezone — the
// PROPERTY's, not the browser's. This is the value an <input type="date"> min
// attribute needs so past check-in dates are unselectable, and it must match the
// RPC's guard, which computes "today" in properties.timezone (migration 020): a
// receptionist in another timezone, or a booking taken just after local midnight,
// must still see the PROPERTY's today. en-CA formats a Date as 'YYYY-MM-DD'. Falls
// back to the browser-local todayIso() when the zone is blank/invalid — never
// throws (an unknown IANA zone makes Intl throw a RangeError).
export function todayIsoInZone(timeZone: string | null | undefined): string {
  if (!timeZone) return todayIso();
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  } catch {
    return todayIso();
  }
}

// The calendar date of a TIMESTAMP as it fell in a specific IANA timezone,
// 'YYYY-MM-DD'. Used to compare a row's created_at (an instant, stored UTC) with
// its business date (a calendar day in the PROPERTY's timezone) so the folio can
// show "posted on" only when the two genuinely differ — rule 8's separate Posted
// column, shown only when it says something.
//
// Doing this in the browser's timezone would be wrong in exactly the case that
// matters: a charge keyed at 00:30 Lagos time is 23:30 UTC the previous day, so a
// UTC/browser-local comparison would report a same-day posting as back-dated on
// every late-night shift. Falls back to the UTC date when the zone is blank or
// invalid — never throws.
export function isoDateInZone(
  timestamp: string | null | undefined,
  timeZone: string | null | undefined,
): string {
  if (!timestamp) return '';
  const dt = new Date(timestamp);
  if (Number.isNaN(dt.getTime())) return '';
  if (!timeZone) return dt.toISOString().slice(0, 10);
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(dt);
  } catch {
    return dt.toISOString().slice(0, 10);
  }
}

// Add `days` to a 'YYYY-MM-DD' string, returning a 'YYYY-MM-DD' string. Parsed
// as a plain calendar date (noon UTC) so DST / timezone offsets can never shift
// the day — booking dates are calendar days, not instants. Used to default a
// check-out to the night after check-in.
export function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  dt.setUTCDate(dt.getUTCDate() + days);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

// Whole nights in the half-open range [checkIn, checkOut) — the same interval
// convention count_available / booking_nights use (015 RULE 1). Returns 0 when
// dates are missing or out of order (the caller shows a hint rather than a wrong
// count). A one-night stay (check_in 5th, check_out 6th) is 1 night.
export function nightsBetween(checkIn: string, checkOut: string): number {
  if (!checkIn || !checkOut) return 0;
  const [ay, am, ad] = checkIn.split('-').map(Number);
  const [by, bm, bd] = checkOut.split('-').map(Number);
  if (!ay || !am || !ad || !by || !bm || !bd) return 0;
  const a = Date.UTC(ay, am - 1, ad);
  const b = Date.UTC(by, bm - 1, bd);
  const nights = Math.round((b - a) / 86_400_000);
  return nights > 0 ? nights : 0;
}

// Display a 'YYYY-MM-DD' calendar date in a readable, locale-aware form (e.g.
// "5 Jan 2026"). Parsed at noon UTC so it never renders the day before near a
// timezone boundary. Returns the raw input if unparseable (never throws).
export function formatDisplayDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso ?? '';
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  return new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(dt);
}
