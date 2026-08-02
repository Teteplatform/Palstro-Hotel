import { formatCurrency, MISSING_VALUE } from './format';

// The maths behind the live new-booking quote (build B §"Live quote"), kept out
// of the component so the figures can be computed and reasoned about on their
// own — and so the desktop rail and the mobile bottom bar are guaranteed to be
// showing the same number rather than two independent sums.
//
// This computes NOTHING about price itself: every nightly figure comes from the
// server's resolve_booking_rate (rack / weekend / seasonal, or the company's
// negotiated rate when a company is billing). All that happens here is a sum and
// a "do all the nights cost the same" check.

export interface NightRate {
  date: string;
  // null when resolve_booking_rate had no rate for that date.
  rate: number | null;
}

// Rule 16: what this figure includes and excludes, shown on the quote itself.
export const QUOTE_CALC_NOTE =
  'Room charges only, priced per night by the server: the negotiated company ' +
  'rate when a company is billing, otherwise the rack, weekend or seasonal ' +
  'rate for that date. Taxes and any extras (food, laundry, minibar) are ' +
  'posted to the folio during the stay and are not included here. A night the ' +
  'server cannot price shows a dash, and the total is withheld rather than ' +
  'shown short.';

export interface QuoteTotals {
  total: number;
  // True when at least one night could not be priced — the total is incomplete
  // and must not be shown as if it were the whole stay.
  anyMissing: boolean;
  // The single nightly rate when every night costs the same; null when nights
  // differ (weekend/seasonal pricing) or nothing is priced yet.
  uniformRate: number | null;
}

export function quoteTotals(nightRates: NightRate[]): QuoteTotals {
  const total = nightRates.reduce((sum, n) => sum + (n.rate ?? 0), 0);
  const anyMissing = nightRates.some((n) => n.rate === null);
  const first = nightRates[0]?.rate ?? null;
  const uniform =
    nightRates.length > 0 && nightRates.every((n) => n.rate === first);
  return { total, anyMissing, uniformRate: uniform ? first : null };
}

// The formatted stay total, or the shared dash when it is not yet knowable. A
// stay with an unpriced night yields the dash, never a partial sum presented as
// the total (§6 — a missing value reads as missing, not as a smaller number).
export function formatStayTotal(
  totals: QuoteTotals,
  nightRates: NightRate[],
  currency: string,
): string {
  if (nightRates.length === 0 || totals.anyMissing) return MISSING_VALUE;
  return formatCurrency(totals.total, currency);
}
