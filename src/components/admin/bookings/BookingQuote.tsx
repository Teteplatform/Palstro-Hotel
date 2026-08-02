import { formatCurrency, MISSING_VALUE } from '../../../lib/format';
import { formatDisplayDate } from '../../../lib/date';
import { formatNights } from '../../../lib/bookingLabels';
import {
  QUOTE_CALC_NOTE,
  formatStayTotal,
  quoteTotals,
  type NightRate,
} from '../../../lib/bookingQuote';

// THE LIVE QUOTE (build B §"Live quote") — the price forming as the booking is
// built. ONE set of pieces, rendered in two places by the new-booking page:
//   - desktop: inside the sticky side rail beside the form;
//   - mobile: inside the fixed bottom bar, which shows the total always and the
//     per-night breakdown when expanded.
// Both read the SAME numbers from the same resolve_booking_rate results (see
// lib/bookingQuote), so the two breakpoints cannot disagree about the price.

interface QuoteFiguresProps {
  roomTypeName: string | null;
  nights: number;
  nightRates: NightRate[];
  // A company is billing, so the nightly figure is its negotiated rate — worth
  // saying on the quote, since it is why the number differs from the rack rate.
  negotiated: boolean;
  currency: string;
  loading: boolean;
}

// The headline figures: room type, nights, nightly rate, stay total.
export function QuoteFigures({
  roomTypeName,
  nights,
  nightRates,
  negotiated,
  currency,
  loading,
}: QuoteFiguresProps) {
  const totals = quoteTotals(nightRates);

  return (
    <dl className="space-y-2 text-sm">
      <Row label="Room type" value={roomTypeName ?? MISSING_VALUE} />
      <Row
        label="Nights"
        value={nights > 0 ? formatNights(nights) : MISSING_VALUE}
      />
      <Row
        label={negotiated ? 'Nightly (company)' : 'Nightly rate'}
        value={
          totals.uniformRate !== null
            ? formatCurrency(totals.uniformRate, currency)
            : nightRates.length > 0
              ? 'Varies by night'
              : MISSING_VALUE
        }
      />
      <div className="flex items-baseline justify-between gap-3 border-t border-sand-border pt-2">
        <dt className="text-sm font-semibold text-charcoal">Stay total</dt>
        <dd
          className="text-lg font-bold tabular-nums text-charcoal"
          aria-live="polite"
        >
          {loading ? '…' : formatStayTotal(totals, nightRates, currency)}
        </dd>
      </div>
    </dl>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-charcoal-muted">{label}</dt>
      <dd className="min-w-0 truncate text-right font-medium text-charcoal">
        {value}
      </dd>
    </div>
  );
}

interface QuoteBreakdownProps {
  nightRates: NightRate[];
  currency: string;
}

// The per-night lines. Always shown in the desktop rail; on mobile only when the
// bottom bar is expanded.
export function QuoteBreakdown({ nightRates, currency }: QuoteBreakdownProps) {
  if (nightRates.length === 0) return null;
  return (
    <ul className="space-y-1">
      {nightRates.map((n) => (
        <li
          key={n.date}
          className="flex justify-between gap-3 text-xs text-charcoal-muted"
        >
          <span>{formatDisplayDate(n.date)}</span>
          <span className="tabular-nums">
            {n.rate === null ? MISSING_VALUE : formatCurrency(n.rate, currency)}
          </span>
        </li>
      ))}
    </ul>
  );
}

// The rule-16 affordance, shared by both breakpoints.
export function QuoteCalcNote() {
  return (
    <span
      className="cursor-help text-xs text-charcoal-muted"
      tabIndex={0}
      role="note"
      aria-label={QUOTE_CALC_NOTE}
      title={QUOTE_CALC_NOTE}
    >
      ⓘ How this is calculated
    </span>
  );
}
