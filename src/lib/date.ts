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

// ---------------------------------------------------------------------------
// Wall-clock time IN A PROPERTY'S TIMEZONE
// ---------------------------------------------------------------------------
// These three exist for ONE screen behaviour: the front desk records when a
// guest ACTUALLY arrived (migration 024), typing a date and a time that they
// mean in the HOTEL's timezone — never in whatever timezone the browser happens
// to be in. The RPC derives the arrival's business date from the property's
// timezone, so the instant we send must be built in that same frame or a
// late-evening arrival is filed against the wrong operating day.

// The offset, in minutes east of UTC, that `timeZone` was at a given instant.
// Derived by formatting the instant in the zone and reading the difference back
// — the only way to get an IANA zone's offset from Intl, which exposes no
// offset API. Returns 0 for a blank/invalid zone so callers degrade to UTC
// rather than throwing (an unknown zone makes Intl throw a RangeError).
function zoneOffsetMinutes(at: Date, timeZone: string): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(at);
    const get = (type: string) =>
      Number(parts.find((p) => p.type === type)?.value ?? '0');
    const asUtc = Date.UTC(
      get('year'),
      get('month') - 1,
      get('day'),
      get('hour'),
      get('minute'),
      get('second'),
    );
    return Math.round((asUtc - at.getTime()) / 60_000);
  } catch {
    return 0;
  }
}

// The current wall-clock time in a specific IANA timezone as 'HH:MM' — the value
// an <input type="time"> expects. hourCycle h23 so midnight is '00:00' and never
// '24:00' (which some locales produce and the input rejects). Falls back to the
// browser's local time when the zone is blank or invalid; never throws.
export function nowTimeInZone(timeZone: string | null | undefined): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  if (!timeZone) return `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hourCycle: 'h23',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(now);
    const hour = parts.find((p) => p.type === 'hour')?.value ?? '00';
    const minute = parts.find((p) => p.type === 'minute')?.value ?? '00';
    return `${hour}:${minute}`;
  } catch {
    return `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  }
}

// A date ('YYYY-MM-DD') and a time ('HH:MM') typed by a person who means them in
// `timeZone`, converted to the exact INSTANT they name — an ISO-8601 UTC string,
// the form Postgres reads into a timestamptz unambiguously.
//
// The two-pass loop is not superstition: the offset to apply depends on the
// instant, and the instant depends on the offset. Pass one guesses the offset
// from the naive UTC reading; pass two re-reads it at the corrected instant, so
// a wall-clock time that falls near a DST transition resolves to the offset
// actually in force then. Africa/Lagos has no DST, but this helper must not be
// wrong for the first tenant that does.
//
// Returns '' when either part is missing or unparseable, so the caller can
// refuse to submit rather than sending a silently wrong timestamp.
export function zonedDateTimeToIso(
  dateIso: string,
  time: string,
  timeZone: string | null | undefined,
): string {
  const [y, m, d] = (dateIso ?? '').split('-').map(Number);
  const [hh, mi] = (time ?? '').split(':').map(Number);
  if (!y || !m || !d) return '';
  if (!Number.isFinite(hh) || !Number.isFinite(mi)) return '';

  // The wall-clock reading treated as if it were UTC — the starting point.
  const naive = Date.UTC(y, m - 1, d, hh, mi, 0, 0);

  if (!timeZone) {
    // No property timezone: fall back to the BROWSER's local frame, which is at
    // least a real frame the operator is standing in.
    return new Date(y, m - 1, d, hh, mi, 0, 0).toISOString();
  }

  let instant = naive;
  for (let pass = 0; pass < 2; pass += 1) {
    instant = naive - zoneOffsetMinutes(new Date(instant), timeZone) * 60_000;
  }
  return new Date(instant).toISOString();
}

// An instant rendered as a date AND time in a specific IANA timezone, e.g.
// "1 Aug 2026, 02:14". Used to show an arrival back to the desk in the HOTEL's
// clock, which is the only clock the front desk reasons in. Returns
// MISSING_VALUE-free empty string for a missing/unparseable timestamp; the
// caller supplies the dash (format.ts owns that placeholder).
export function formatDisplayDateTimeInZone(
  timestamp: string | null | undefined,
  timeZone: string | null | undefined,
): string {
  if (!timestamp) return '';
  const dt = new Date(timestamp);
  if (Number.isNaN(dt.getTime())) return '';
  const options: Intl.DateTimeFormatOptions = {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  };
  try {
    return new Intl.DateTimeFormat(undefined, {
      ...options,
      timeZone: timeZone ?? undefined,
    }).format(dt);
  } catch {
    return new Intl.DateTimeFormat(undefined, options).format(dt);
  }
}

// Display a bare TIME OF DAY — a Postgres `time` column, which PostgREST returns
// as 'HH:MM:SS' — as 'HH:MM'. Used for the expected arrival a guest gives when
// booking: a wall-clock reading with no date and no instant behind it, so there
// is nothing to convert and no timezone to apply. Rendering it through Intl would
// require inventing a date to attach it to, which is exactly the kind of quiet
// fiction that puts a 23:30 arrival on the wrong day.
//
// 24-hour, matching TimeField's own help text and the clock a Nigerian front desk
// reads. Returns '' for a missing or unparseable value; the CALLER supplies the
// dash, as with every other display helper in this file (format.ts owns
// MISSING_VALUE). Never throws.
export function formatDisplayTime(value: string | null | undefined): string {
  if (!value) return '';
  const [hh, mm] = value.split(':');
  const hour = Number(hh);
  const minute = Number(mm);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return '';
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(hour)}:${pad(minute)}`;
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
