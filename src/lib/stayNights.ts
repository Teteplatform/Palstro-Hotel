import { nightsBetween } from './date';

// RESERVED NIGHTS vs ACTUAL NIGHTS — one definition, used by every screen that
// has to say how long a stay is.
//
// ┌──────────────────────────────────────────────────────────────────────────┐
// │  RESERVED nights = what was BOOKED.                                      │
// │  ACTUAL   nights = what the folio BILLS, counted from the real arrival.  │
// │  A walk-in who books the 30th and reaches the desk on the 1st pays for   │
// │  the nights they SLEPT — never the empty ones.                           │
// └──────────────────────────────────────────────────────────────────────────┘
//
// THIS FILE DECIDES NOTHING ABOUT MONEY. It reports, in the browser, the same
// window the server already charges over, so the desk can read the two figures
// before the night audit runs. The charge itself is entirely run_night_audit's
// (migration 024 §3) and this must never diverge from it — which is why the
// start date below is the SAME expression, transcribed:
//
//     SQL : greatest(coalesce(b.actual_check_in, b.check_in), b.check_in)
//     here: actual_check_in > check_in ? actual_check_in : check_in
//
// Read outward-in, for the same reasons the migration gives:
//
//   * coalesce(actual, reserved) — bill from when they ARRIVED. NULL means the
//     arrival was never recorded (a stay checked in before 024 shipped), and the
//     honest answer there is "actual is not known", not a guessed figure. So
//     this helper returns `actual: null` rather than silently reporting the
//     reserved count as though it had been observed.
//   * greatest(..., reserved) — NEVER before the first reserved night. An EARLY
//     arrival has no booking_nights row for the earlier night (nights are locked
//     over the reserved range only, 015 §5), so the audit bills from the reserved
//     check-in and this reports the same. An early arrival therefore reads as
//     "no difference", which is correct about the BILL; StayTab carries a
//     separate note explaining the physical difference and how to fix it
//     (extend the booking, which locks a rate for the new night).
//
// Dates are 'YYYY-MM-DD' strings throughout, so `>` is a chronological compare —
// the same lexicographic ordering the rest of the booking code relies on.

export interface StayNights {
  // check_out − check_in. Always available: it is what was booked.
  reserved: number;
  // check_out − the date billing starts. NULL until the guest is checked in and
  // an arrival has actually been recorded — before that, "actual" is unknown,
  // not zero and not the reserved figure.
  actual: number | null;
  // The date the folio charges from. NULL alongside `actual`.
  chargeFrom: string | null;
  // The two figures disagree and BOTH must be shown. Only ever true for a LATE
  // arrival: the greatest(...) floor makes an early arrival bill the reserved
  // nights, so it is not a difference the desk can act on here.
  differs: boolean;
  arrivedLate: boolean;
  arrivedEarly: boolean;
}

export function describeStayNights(booking: {
  check_in: string;
  check_out: string;
  actual_check_in: string | null;
}): StayNights {
  const reserved = nightsBetween(booking.check_in, booking.check_out);
  const arrival = booking.actual_check_in;

  // Not arrived (or an arrival that predates migration 024): reserved only.
  if (!arrival) {
    return {
      reserved,
      actual: null,
      chargeFrom: null,
      differs: false,
      arrivedLate: false,
      arrivedEarly: false,
    };
  }

  // greatest(arrival, reserved check-in) — see the header.
  const chargeFrom = arrival > booking.check_in ? arrival : booking.check_in;
  // nightsBetween is half-open [from, check_out) and floors at 0, so an arrival
  // recorded on or after the check-out date reports 0 billable nights rather
  // than a negative count. That is a data oddity worth showing plainly, not
  // hiding behind the reserved figure.
  const actual = nightsBetween(chargeFrom, booking.check_out);

  return {
    reserved,
    actual,
    chargeFrom,
    differs: actual !== reserved,
    arrivedLate: arrival > booking.check_in,
    arrivedEarly: arrival < booking.check_in,
  };
}
