import { CalculationNote } from '../../ui/CalculationNote';
import { formatMoney, formatQuantity, MISSING_VALUE } from '../../../lib/format';
import {
  ITEM_COUNT_EXPLANATION,
  ITEMS_WITH_STOCK_EXPLANATION,
  STOCK_VALUE_EXPLANATION,
  TOTAL_UNITS_EXPLANATION,
} from '../../../lib/stockLabels';
import type { ProductsSummary } from '../../../lib/inventoryProducts';

// THE FIGURES ABOVE THE LIST — the ERP's summary card, adapted.
//
// RULE 20, which is the whole point of this component: every figure spans the
// WHOLE FILTERED SET, across all pages, from a separate aggregate query using the
// same filters as the list — never the rows on screen. A user who filters to one
// category and reads a total expects the total for that category.
//
// RULE 16: each figure carries a note saying what it includes, and every one of
// those notes also states that it covers the filter rather than the page.
//
// WHAT IS NOT HERE, and why: the ERP shows Retail Value and Potential Gross
// Profit beside these. Both need a SELLING price, and nothing in this system has
// one yet — prices arrive with the menu. An empty tile would be a question mark
// where a figure should be, and a computed-from-cost "retail value" would be an
// invented number on an owner's dashboard. So there are four tiles, not six.
//
// NEGATIVE STOCK AND LOW STOCK are shown only when there are any, and each is a
// button that narrows the list to the rows behind it — a count that is a way in
// rather than a dead end. A permanent "0 negative" on every screen would be
// noise, and the figure would stop being read on the day it finally matters.

interface InventorySummaryCardProps {
  summary: ProductsSummary | null;
  loading: boolean;
  currency: string;
  // The scope the figures describe: a location name, or null for the whole
  // property. Shown in the caption so a filtered figure is never mistaken for
  // the hotel's whole position.
  scopeName: string | null;
  onShowLow: () => void;
  onShowNegative: () => void;
}

export function InventorySummaryCard({
  summary,
  loading,
  currency,
  scopeName,
  onShowLow,
  onShowNegative,
}: InventorySummaryCardProps) {
  return (
    <section
      className="rounded-2xl border border-sand-border bg-white/60 p-4"
      aria-label="Stock summary"
    >
      <p className="text-[11px] font-semibold uppercase tracking-wide text-charcoal-muted">
        Summary
        {scopeName ? (
          <span className="ml-2 font-normal normal-case tracking-normal">
            — {scopeName} only
          </span>
        ) : (
          <span className="ml-2 font-normal normal-case tracking-normal">
            — every location in this hotel
          </span>
        )}
        {loading ? (
          <span className="ml-2 font-normal normal-case tracking-normal" aria-live="polite">
            updating…
          </span>
        ) : null}
      </p>

      <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile
          label="Total items"
          value={summary ? summary.itemCount.toLocaleString() : MISSING_VALUE}
          note={ITEM_COUNT_EXPLANATION}
        />
        <Tile
          label="Items with stock"
          value={summary ? summary.itemsWithStock.toLocaleString() : MISSING_VALUE}
          note={ITEMS_WITH_STOCK_EXPLANATION}
        />
        <Tile
          label="Total units on hand"
          value={summary ? formatQuantity(summary.totalUnits) : MISSING_VALUE}
          note={TOTAL_UNITS_EXPLANATION}
        />
        <Tile
          label="Stock value"
          value={summary ? formatMoney(summary.totalValue, currency) : MISSING_VALUE}
          note={STOCK_VALUE_EXPLANATION}
          emphasis
        />
      </div>

      {summary && (summary.belowReorderCount > 0 || summary.negativeCount > 0) ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {summary.belowReorderCount > 0 ? (
            <AlertButton
              onClick={onShowLow}
              label={`${summary.belowReorderCount} ${
                summary.belowReorderCount === 1 ? 'item is' : 'items are'
              } at or below the reorder level`}
            />
          ) : null}
          {summary.negativeCount > 0 ? (
            <AlertButton
              onClick={onShowNegative}
              emphasis
              label={`${summary.negativeCount} ${
                summary.negativeCount === 1 ? 'item shows' : 'items show'
              } less than nothing on hand`}
            />
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function Tile({
  label,
  value,
  note,
  emphasis = false,
}: {
  label: string;
  value: string;
  note: string;
  emphasis?: boolean;
}) {
  return (
    <div
      className={`rounded-xl px-3 py-2.5 ${
        emphasis ? 'bg-primary/10' : 'bg-sand/40'
      }`}
    >
      <div className="flex items-start gap-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-charcoal-muted">
          {label}
        </span>
        <CalculationNote note={note} />
      </div>
      <p
        className={`mt-1 text-lg font-bold tabular-nums ${
          emphasis ? 'text-primary' : 'text-charcoal'
        }`}
      >
        {value}
      </p>
    </div>
  );
}

function AlertButton({
  label,
  onClick,
  emphasis = false,
}: {
  label: string;
  onClick: () => void;
  emphasis?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full px-3 py-1.5 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream ${
        emphasis
          ? 'bg-accent/15 text-accent hover:bg-accent/25'
          : 'border border-sand-border bg-white/70 text-charcoal hover:bg-sand'
      }`}
    >
      {label} →
    </button>
  );
}
