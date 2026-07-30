import { formatCurrency, MISSING_VALUE } from '../../../lib/format';
import type { BookingSummary } from '../../../lib/bookings';

// The summary above the list (brief 1.txt §2, rules 20 + 16), now a COMPACT INLINE
// row rather than the old stacked card. Three figures, all across the WHOLE
// filtered set — never the visible page:
//   - Bookings: total count in the filter,
//   - In-house now: count of status = checked_in,
//   - Total value: sum of every booking's LOCKED nightly rates (not a recompute).
// The rule-16 note states exactly what it covers and that it spans the filter, not
// the page.

interface BookingStatusSummaryProps {
  summary: BookingSummary | null;
  loading: boolean;
  currency: string;
}

const CALC_NOTE =
  'Covers the whole filtered set, across all pages — not just this page. ' +
  "Each booking's value is the sum of its locked nightly rates. In-house counts " +
  'bookings currently checked in.';

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
