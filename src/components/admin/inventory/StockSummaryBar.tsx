import { CalculationNote } from '../../ui/CalculationNote';
import { formatMoney, MISSING_VALUE } from '../../../lib/format';
import { STOCK_VALUE_EXPLANATION } from '../../../lib/stockLabels';
import type { StockSummary } from '../../../lib/stock';

// The figures above the stock list — a COMPACT INLINE row, matching
// BookingStatusSummary.
//
// RULE 20, which is the whole point of this component: every figure spans the
// WHOLE FILTERED SET, across all pages, and comes from a separate aggregate
// query using the same filter — never from the rows on screen. A user who
// filters to one category and reads a total expects the total for that category;
// a page-derived total is a wrong number presented with confidence.
//
// WHY TOTAL VALUE AND NOT TOTAL QUANTITY. Quantity does not add up across items:
// summing kilograms of rice, litres of oil and bottles of Coke produces a number
// with no unit and no meaning. Money does — which is exactly why this is the
// first inventory screen with a total at all (the catalogue in part 1 had
// nothing meaningful to total, and said so rather than inventing one).
//
// NEGATIVE STOCK IS ITS OWN FIGURE, shown only when there is any. It is the
// single most important thing this screen can tell a manager: stock that left
// with no movement behind it — a delivery never entered, or theft. Netting it
// into the value would hide it, which is exactly what rule 7 forbids.

interface StockSummaryBarProps {
  summary: StockSummary | null;
  loading: boolean;
  currency: string;
  // Narrows the list to the rows behind a figure, so a count is a way in rather
  // than a dead end.
  onShowNegative: () => void;
  onShowLow: () => void;
}

export function StockSummaryBar({
  summary,
  loading,
  currency,
  onShowNegative,
  onShowLow,
}: StockSummaryBarProps) {
  return (
    <div className="rounded-2xl border border-sand-border bg-sand/30 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
        <Figure
          label="Items with stock"
          value={summary ? String(summary.itemCount) : MISSING_VALUE}
        />
        <Figure
          label="Total stock value"
          value={summary ? formatMoney(summary.totalValue, currency) : MISSING_VALUE}
          note={STOCK_VALUE_EXPLANATION}
        />

        {summary && summary.belowReorderCount > 0 ? (
          <FigureButton
            label="At or below reorder level"
            value={String(summary.belowReorderCount)}
            onClick={onShowLow}
          />
        ) : null}

        {/* Only shown when there IS negative stock — a permanent "0 negative" on
            every screen would be noise, and the figure would stop being read on
            the day it finally matters. */}
        {summary && summary.negativeCount > 0 ? (
          <FigureButton
            label="Less than nothing on hand"
            value={String(summary.negativeCount)}
            onClick={onShowNegative}
            emphasis
          />
        ) : null}

        <span className="ml-auto flex items-center gap-2 text-xs text-charcoal-muted">
          {loading ? <span aria-live="polite">Updating…</span> : null}
        </span>
      </div>
    </div>
  );
}

function Figure({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string;
}) {
  return (
    <div>
      <div className="flex items-center gap-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-charcoal-muted">
          {label}
        </span>
        {note ? <CalculationNote note={note} /> : null}
      </div>
      <p className="mt-0.5 text-base font-bold tabular-nums text-charcoal">
        {value}
      </p>
    </div>
  );
}

function FigureButton({
  label,
  value,
  onClick,
  emphasis = false,
}: {
  label: string;
  value: string;
  onClick: () => void;
  emphasis?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-lg text-left transition-colors hover:bg-white/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream"
    >
      <span className="block text-[11px] font-semibold uppercase tracking-wide text-charcoal-muted">
        {label}
      </span>
      <span
        className={`mt-0.5 block text-base font-bold tabular-nums ${
          emphasis ? 'text-accent' : 'text-charcoal'
        }`}
      >
        {value}
      </span>
    </button>
  );
}
