import { formatCurrency, formatMoney, MISSING_VALUE } from '../../../lib/format';
import type { BookingSummary } from '../../../lib/bookings';

// The summary above the list (brief 1.txt §2, rules 20 + 16), a COMPACT INLINE
// row. Every figure spans the WHOLE filtered set — never the visible page:
//   - Bookings: total count in the filter,
//   - In-house now: count of status = checked_in,
//   - Total value: sum of every booking's LOCKED nightly rates (not a recompute),
//   - Outstanding: sum of every POSITIVE live folio balance (build 6c part 2 §7),
//   - Refunds due: sum of every NEGATIVE balance, shown only when there are any.
//
// WHY OUTSTANDING IS WORTH ITS PLACE HERE (the brief asked for a recommendation):
// "total value" answers what these stays are worth; it does NOT answer what the
// hotel is still owed, and at a front desk that second question is the one being
// asked all day — a filter of "arrivals this week" with ₦4.2m of value and ₦380k
// outstanding tells the manager something the value figure alone cannot. Rule 20
// then makes it mandatory that it span the filter rather than the page, which is
// exactly what a page-derived total would have got wrong. It costs one aggregate
// query over booking_balances beside the one already being run.
//
// Outstanding and refunds due are shown SEPARATELY, never netted: a filtered set
// owed ₦300,000 that also owes ₦300,000 back is not "settled", and one net figure
// would report precisely that.

interface BookingStatusSummaryProps {
  summary: BookingSummary | null;
  loading: boolean;
  currency: string;
}

const CALC_NOTE =
  'Covers the whole filtered set, across all pages — not just this page. ' +
  "Each booking's value is the sum of its locked nightly rates. In-house counts " +
  'bookings currently checked in. Outstanding is the sum of the folio balances ' +
  'that are owed to the hotel; refunds due is the sum of those owed back to ' +
  'guests. Balances are computed live from non-voided charges, their taxes and ' +
  'non-voided payments — nothing is cached.';

export function BookingStatusSummary({
  summary,
  loading,
  currency,
}: BookingStatusSummaryProps) {
  // In-house = bookings currently checked in. Reads 0 until guests are checked in
  // through the booking flow (checked_in is a later lifecycle state than the
  // 'confirmed' create_booking sets), which is expected, not a bug.
  const inHouse = summary?.byStatus.checked_in?.count ?? 0;

  return (
    <div className="rounded-2xl border border-sand-border bg-sand/30 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
        <Figure
          label="Bookings"
          value={summary ? String(summary.totalCount) : MISSING_VALUE}
        />
        <Figure
          label="In-house now"
          value={summary ? String(inHouse) : MISSING_VALUE}
        />
        <Figure
          label="Total value"
          value={summary ? formatCurrency(summary.totalValue, currency) : MISSING_VALUE}
        />
        <Figure
          label="Outstanding"
          value={
            summary ? formatMoney(summary.outstandingTotal, currency) : MISSING_VALUE
          }
        />
        {/* Only shown when there is money to give back — a permanent ₦0.00
            "refunds due" would be noise on every screen. */}
        {summary && summary.refundsDueTotal > 0 ? (
          <Figure
            label="Refunds due"
            value={formatMoney(summary.refundsDueTotal, currency)}
          />
        ) : null}

        <span className="ml-auto flex items-center gap-2 text-xs text-charcoal-muted">
          {loading ? (
            <span aria-live="polite">Updating…</span>
          ) : null}
          {/* rule 16: how this was calculated, and that it spans the filter. */}
          <span
            className="cursor-help"
            tabIndex={0}
            role="note"
            aria-label={CALC_NOTE}
            title={CALC_NOTE}
          >
            ⓘ How this is calculated
          </span>
        </span>
      </div>
    </div>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-xs font-medium uppercase tracking-wide text-charcoal-muted">
        {label}
      </span>
      <span className="text-lg font-bold text-charcoal">{value}</span>
    </div>
  );
}
