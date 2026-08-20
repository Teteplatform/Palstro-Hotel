import { CalculationNote } from '../../ui/CalculationNote';
import { formatMoney, formatQuantity, MISSING_VALUE } from '../../../lib/format';
import {
  COST_VALUE_CONTRAST,
  ITEM_COUNT_EXPLANATION,
  ITEMS_WITH_STOCK_EXPLANATION,
  MARGIN_EXPLANATION,
  RETAIL_EXCLUDED_EXPLANATION,
  RETAIL_VALUE_EXPLANATION,
  STOCK_VALUE_EXPLANATION,
  TOTAL_UNITS_EXPLANATION,
} from '../../../lib/stockLabels';
import {
  summaryMargin,
  summaryMarginPercent,
  type ProductsSummary,
} from '../../../lib/inventoryProducts';

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
// COST AND RETAIL, SIDE BY SIDE (1.1e §2). This card used to carry a note saying
// the ERP's Retail Value and Potential Gross Profit could not be shown because
// nothing in the system had a selling price. 042 gives the item one, so they are
// here — and the note has been replaced rather than left to contradict the screen.
//
// THREE THINGS MAKE THEM HONEST, and each is a decision rather than a detail:
//
//   THE LABELS. "Value at cost" and "Retail value", in words, on the tiles. The
//   confusion is expensive in both directions: a retail figure read as the stock's
//   worth overstates the books, and a cost figure read as takings understates every
//   pricing decision made from it.
//
//   THE MARGIN IS NOT THE DIFFERENCE OF THE TWO TILES. It is retail minus the cost
//   of THE SAME positions — only those carrying a price. The cost tile covers every
//   position on the shelf including the ingredients, which have no selling price, so
//   subtracting it would count every sack of rice in the store as a loss and put a
//   large negative number on an owner's dashboard. See ProductsSummary.
//   retailCostValue for the arithmetic, and MARGIN_EXPLANATION for the sentence
//   that says so where the owner will try the subtraction.
//
//   THE EXCLUDED COUNT IS SHOWN, NOT ABSORBED. An unpriced item contributes NULL to
//   retail, not zero, so it is skipped by the sum and counted separately — and the
//   card says how many. A total that silently ignores half the shelf is worse than
//   no total, and the count is what turns the figure into one whose shape you can
//   see. It is also a BUTTON, like the two below it: somewhere to go and fix it.
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
  // Narrows the list to the sellable items with no price — what the excluded
  // count is about (1.1e §1/§2).
  onShowUnpriced: () => void;
}

export function InventorySummaryCard({
  summary,
  loading,
  currency,
  scopeName,
  onShowLow,
  onShowNegative,
  onShowUnpriced,
}: InventorySummaryCardProps) {
  // Derived in the data layer, not here (summaryMargin/summaryMarginPercent), so
  // the proof checks the same arithmetic the card renders rather than a second
  // copy of it.
  const margin = summary ? summaryMargin(summary) : null;
  const marginPercent = summary ? summaryMarginPercent(summary) : null;
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

      <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
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
        {/* THE THREE MONEY TILES, in the order the sentence runs: what it cost,
            what it would fetch, what is left. Each labelled so it cannot be read
            as one of the others. */}
        <Tile
          label="Value at cost"
          value={summary ? formatMoney(summary.totalValue, currency) : MISSING_VALUE}
          note={`${STOCK_VALUE_EXPLANATION} ${COST_VALUE_CONTRAST}`}
          emphasis
        />
        <Tile
          label="Retail value"
          value={summary ? formatMoney(summary.retailValue, currency) : MISSING_VALUE}
          note={RETAIL_VALUE_EXPLANATION}
          // The pre-tax caveat is on the tile and not only in the note: it is a
          // property of the figure, and somebody comparing it to a day's takings
          // needs it without opening anything.
          sub="before tax"
          emphasis
        />
        <Tile
          label="Margin"
          value={margin === null ? MISSING_VALUE : formatMoney(margin, currency)}
          note={MARGIN_EXPLANATION}
          sub={
            marginPercent === null
              ? // Nothing in scope has a price, so there is no share to take. A
                // dash, never "0%", which would be a different and false claim.
                'nothing priced yet'
              : `${marginPercent.toFixed(1)}% of retail`
          }
          emphasis
        />
      </div>

      {summary &&
      (summary.belowReorderCount > 0 ||
        summary.negativeCount > 0 ||
        summary.retailExcludedCount > 0) ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {/* THE EXCLUDED COUNT, said out loud and clickable. It leads the row
              because it is the one that explains the figures directly above it. */}
          {summary.retailExcludedCount > 0 ? (
            <AlertButton
              onClick={onShowUnpriced}
              label={`${summary.retailExcludedCount} ${
                summary.retailExcludedCount === 1
                  ? 'item on the shelf has'
                  : 'items on the shelf have'
              } no selling price, so ${
                summary.retailExcludedCount === 1 ? 'it is' : 'they are'
              } left out of retail`}
              note={RETAIL_EXCLUDED_EXPLANATION}
            />
          ) : null}
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
  sub,
  emphasis = false,
}: {
  label: string;
  value: string;
  note: string;
  // A qualifier ON the figure — "before tax", "34.2% of retail". Not an
  // explanation (that is `note`, behind the small i): it is a unit, and a figure
  // whose unit is hidden behind an icon is a figure that gets misread once per
  // reader.
  sub?: string;
  emphasis?: boolean;
}) {
  return (
    <div
      className={`rounded-xl px-3 py-2.5 ${
        emphasis ? 'bg-primary/10' : 'bg-sand/40'
      }`}
    >
      <div className="flex items-start gap-1.5">
        <span className="text-[11px] font-semibold tracking-wide text-charcoal-muted uppercase">
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
      {sub ? (
        <p className="text-[11px] text-charcoal-muted">{sub}</p>
      ) : null}
    </div>
  );
}

function AlertButton({
  label,
  onClick,
  note,
  emphasis = false,
}: {
  label: string;
  onClick: () => void;
  // Rule 16's per-figure note, on a count that is also a control. The excluded
  // count needs one — "left out of retail" invites "left out how?" — while
  // "3 items are below reorder level" does not.
  note?: string;
  emphasis?: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-1">
      <button
        type="button"
        onClick={onClick}
        className={`rounded-full px-3 py-1.5 text-xs font-semibold transition-colors focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream focus-visible:outline-none ${
          emphasis
            ? 'bg-accent/15 text-accent hover:bg-accent/25'
            : 'border border-sand-border bg-white/70 text-charcoal hover:bg-sand'
        }`}
      >
        {label} →
      </button>
      {note ? <CalculationNote note={note} /> : null}
    </span>
  );
}
