import { formatCurrency } from '../../../lib/format';
import { bookingStatusLabel, bookingStatusTone } from '../../../lib/bookingLabels';
import { BOOKING_STATUSES } from '../../../lib/bookingLabels';
import type { BookingSummary } from '../../../lib/bookings';

// The status summary above the list (build 6b §3, rules 20 + 16). It reports the
// total count and value, and a per-status breakdown, computed across the WHOLE
// filtered set — never the visible page. The value is the sum of each booking's
// LOCKED nightly rates (not a recompute). The rule-16 note states exactly what it
// covers and how it was calculated, and that it spans the filter, not the page.

interface BookingStatusSummaryProps {
  summary: BookingSummary | null;
  loading: boolean;
  currency: string;
}

const CALC_NOTE =
  'Covers the whole filtered set, across all pages — not just this page. ' +
  "Each booking's value is the sum of its locked nightly rates.";

export function BookingStatusSummary({
  summary,
  loading,
  currency,
}: BookingStatusSummaryProps) {
  return (
    <div className="rounded-2xl border border-sand-border bg-sand/30 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-charcoal">
          Summary
          {/* rule 16: how this was calculated. */}
          <span
            className="ml-1.5 cursor-help text-charcoal-muted"
            tabIndex={0}
            role="note"
            aria-label={CALC_NOTE}
            title={CALC_NOTE}
          >
            ⓘ
          </span>
        </h2>
        {loading ? (
          <span className="text-xs text-charcoal-muted" aria-live="polite">
            Updating…
          </span>
        ) : null}
      </div>

      {summary ? (
        <>
          <div className="mt-3 flex flex-wrap items-end gap-x-8 gap-y-2">
            <div>
              <p className="text-xs text-charcoal-muted">Bookings</p>
              <p className="text-2xl font-bold text-charcoal">
                {summary.totalCount}
              </p>
            </div>
            <div>
              <p className="text-xs text-charcoal-muted">Total value</p>
              <p className="text-2xl font-bold text-charcoal">
                {formatCurrency(summary.totalValue, currency)}
              </p>
            </div>
          </div>

          {summary.totalCount > 0 ? (
            <ul className="mt-4 flex flex-wrap gap-2">
              {BOOKING_STATUSES.filter((s) => summary.byStatus[s]).map((s) => {
                const bucket = summary.byStatus[s]!;
                return (
                  <li
                    key={s}
                    className={`rounded-full px-3 py-1 text-xs font-semibold ${bookingStatusTone(s)}`}
                  >
                    {bookingStatusLabel(s)}: {bucket.count} ·{' '}
                    {formatCurrency(bucket.total, currency)}
                  </li>
                );
              })}
            </ul>
          ) : null}

          <p className="mt-3 text-xs text-charcoal-muted">{CALC_NOTE}</p>
        </>
      ) : (
        <p className="mt-2 text-sm text-charcoal-muted">
          Summary unavailable for the current filter.
        </p>
      )}
    </div>
  );
}
