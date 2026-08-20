import { useEffect, useRef } from 'react';
import { formatDisplayDate } from '../../../lib/date';
import { formatMoney, formatQuantity, formatSignedQuantity } from '../../../lib/format';
import {
  MOVING_AVERAGE_EXPLANATION,
  movementTypeLabel,
  movementTypeTone,
} from '../../../lib/stockLabels';
import type { ItemMovement } from '../../../lib/itemDetail';
import type { StockLocation } from '../../../types/inventory';
import type { MovementType } from '../../../types/stock';
import { ReverseMovementForm } from './ReverseMovementForm';
import { useState } from 'react';

// THE LEDGER ON THE ITEM PAGE (1.1f §4) — every movement at the page's scope,
// filtered by whichever card is pressed.
//
// ---------------------------------------------------------------------------
// WHY THIS IS NOT StockItemLedger
// ---------------------------------------------------------------------------
// StockItemLedger answers a different question and keeps answering it: it is the
// panel inside an expanded LIST row, it fetches its own data for ONE LOCATION, and
// its whole shape assumes that. This one is handed movements it does not fetch,
// covers a scope that may be the whole property, and adds two things that only
// make sense here — a location column when the scope is every location, and a card
// filter above it.
//
// The two share the thing worth sharing, which is the ROW. LedgerRow is exported
// from StockItemLedger precisely so it can be rendered without standing up the
// fetch, and this file uses that same component rather than a second copy that
// would drift the first time a column changed.
//
// EXCEPT AT PROPERTY SCOPE, where the running figures mean something different and
// a shared row would be actively misleading — see LocationScopedRow below. That is
// the one place this file draws its own markup, and the reason is written there.

interface ItemMovementLedgerProps {
  // The rows to show — already filtered by the card selection.
  movements: ItemMovement[];
  // Every movement at the scope, so a reversal can name the movement it undid even
  // when that movement is filtered out of view.
  allMovements: ItemMovement[];
  baseUnit: string;
  currency: string;
  itemName: string;
  locations: StockLocation[];
  // NULL when the page is showing every location — which changes what the running
  // columns mean, and whether a reversal can be offered.
  scopeLocation: StockLocation | null;
  selectedType: MovementType | null;
  onClearFilter: () => void;
  // A movement the chart asked for. Scrolled to and tinted, then cleared.
  highlighted: string | null;
  onHighlightShown: () => void;
  loading: boolean;
  onReversed: () => Promise<void> | void;
}

export function ItemMovementLedger({
  movements,
  allMovements,
  baseUnit,
  currency,
  itemName,
  locations,
  scopeLocation,
  selectedType,
  onClearFilter,
  highlighted,
  onHighlightShown,
  loading,
  onReversed,
}: ItemMovementLedgerProps) {
  const [reversing, setReversing] = useState<ItemMovement | null>(null);
  const rowRefs = useRef(new Map<string, HTMLTableRowElement>());

  // Scroll the chart's chosen movement into view. Await-free and idempotent: the
  // highlight is cleared straight after, so clicking the same point twice works.
  useEffect(() => {
    if (!highlighted) return;
    const row = rowRefs.current.get(highlighted);
    row?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const handle = setTimeout(onHighlightShown, 2000);
    return () => clearTimeout(handle);
  }, [highlighted, onHighlightShown]);

  // A REVERSAL NEEDS A LOCATION TO NAME. reverse_stock_movement acts on one
  // movement in one location, and the confirmation card has to say which — so at
  // property scope the action is offered from the row's OWN location rather than
  // the page's, which is why the location is resolved per row below.
  const locationName = (locationId: string) =>
    locations.find((l) => l.id === locationId)?.name ?? 'this location';

  return (
    <section className="rounded-2xl border border-sand-border bg-white/60">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-sand-border px-4 py-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-charcoal">
            Every movement
            {selectedType ? (
              <span className="font-normal text-charcoal-muted">
                {' '}
                — {movementTypeLabel(selectedType).toLowerCase()} only
              </span>
            ) : null}
          </h3>
          <p className="mt-0.5 text-xs text-charcoal-muted">
            Oldest first, with what the stock stood at afterwards.
          </p>
        </div>

        {/* THE WAY BACK FROM A FILTER, always visible while one is on. A card that
            can be pressed to filter but only un-pressed by remembering which one
            is lit is a trap on a page with six cards. */}
        {selectedType ? (
          <button
            type="button"
            onClick={onClearFilter}
            className="rounded-full border border-sand-border bg-white/70 px-3 py-1.5 text-xs font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream focus-visible:outline-none"
          >
            Show everything
          </button>
        ) : null}
      </div>

      {loading ? (
        <p className="px-4 py-6 text-sm text-charcoal-muted" aria-live="polite">
          Loading movements…
        </p>
      ) : movements.length === 0 ? (
        <p className="px-4 py-10 text-center text-sm text-charcoal-muted">
          {selectedType
            ? `No ${movementTypeLabel(selectedType).toLowerCase()} recorded here.`
            : 'Nothing has moved here yet. Add or correct stock from the menu above.'}
        </p>
      ) : (
        <>
          <p className="px-4 pt-3 text-xs text-charcoal-muted">
            {MOVING_AVERAGE_EXPLANATION}
          </p>
          <div className="overflow-x-auto px-4 pb-4">
            <table className="w-full min-w-[40rem] border-collapse text-xs">
              <thead>
                <tr className="border-b border-sand-border text-left">
                  <Th>Date</Th>
                  {/* THE LOCATION COLUMN EXISTS ONLY AT PROPERTY SCOPE, where it is
                      the answer to the question the page is being asked ("where did
                      it go?"). At one location it would be the same word on every
                      row. */}
                  {scopeLocation ? null : <Th>Location</Th>}
                  <Th>Movement</Th>
                  <Th right>Change</Th>
                  <Th right>At cost</Th>
                  <Th right>On hand after</Th>
                  <Th right>Average after</Th>
                  <th scope="col" className="py-1.5">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-sand-border/50">
                {movements.map((row) => (
                  <LedgerLine
                    key={row.id}
                    row={row}
                    allMovements={allMovements}
                    baseUnit={baseUnit}
                    currency={currency}
                    propertyScope={scopeLocation === null}
                    locationName={locationName(row.location_id)}
                    highlighted={highlighted === row.id}
                    registerRef={(node) => {
                      if (node) rowRefs.current.set(row.id, node);
                      else rowRefs.current.delete(row.id);
                    }}
                    onReverse={setReversing}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Rendered INLINE below the ledger, not as a nested modal: the movement
          being reversed stays visible while the reason is typed. */}
      {reversing ? (
        <div className="border-t border-sand-border px-4 py-4">
          <ReverseMovementForm
            movement={reversing}
            itemName={itemName}
            locationName={locationName(reversing.location_id)}
            baseUnit={baseUnit}
            onDone={async () => {
              setReversing(null);
              await onReversed();
            }}
            onCancel={() => setReversing(null)}
          />
        </div>
      ) : null}
    </section>
  );
}

function Th({ children, right = false }: { children: React.ReactNode; right?: boolean }) {
  return (
    <th
      scope="col"
      className={`py-1.5 pr-3 font-semibold text-charcoal-muted ${right ? 'text-right' : ''}`}
    >
      {children}
    </th>
  );
}

// ONE ROW.
//
// WHY THIS DRAWS ITS OWN MARKUP RATHER THAN REUSING LedgerRow, which was the
// obvious move and is wrong for one specific reason: at PROPERTY scope the two
// running columns mean something different from what LedgerRow's headings claim.
// The view's running_quantity and running_average_cost are that LOCATION's, folded
// over that location's movements — so on a property-wide list, "On hand after"
// would jump between four independent balances down the column and read as a
// history that never happened.
//
// So this row shows the SCOPED quantity in that column, which at one location is
// the database's own figure (they are equal by construction) and at property scope
// is the running total across the property. The average is shown only at one
// location, because there is no property-wide average that means anything: 036
// §3.3 is explicit that the roll-up cost is value/quantity and NEVER the mean of
// the per-location averages, and there is no running form of that.
function LedgerLine({
  row,
  allMovements,
  baseUnit,
  currency,
  propertyScope,
  locationName,
  highlighted,
  registerRef,
  onReverse,
}: {
  row: ItemMovement;
  allMovements: ItemMovement[];
  baseUnit: string;
  currency: string;
  propertyScope: boolean;
  locationName: string;
  highlighted: boolean;
  registerRef: (node: HTMLTableRowElement | null) => void;
  onReverse: (row: ItemMovement) => void;
}) {
  // The label of the movement a reversal points at, for the cross-link. Read from
  // ALL the movements rather than the filtered ones, so filtering to Reversals does
  // not turn every cross-link into "movement".
  const reversedLabel = (targetId: string) => {
    const target = allMovements.find((m) => m.id === targetId);
    return target ? movementTypeLabel(target.movement_type).toLowerCase() : 'movement';
  };

  // The three the server refuses (038 §7 guards 5 and 6, plus already-reversed).
  // Hiding the button is a COURTESY that saves a pointless round trip; the database
  // is still the guard.
  const canReverse =
    row.movement_type !== 'opening' &&
    row.movement_type !== 'reversal' &&
    !row.reversed_by_movement_id;

  return (
    <tr
      ref={registerRef}
      // THE ROW'S IDENTITY, IN THE MARKUP. The scroll target is found through the
      // ref map at runtime, so this is not needed for the feature — it is here so
      // the proof can assert that the chart's points and these rows are THE SAME
      // MOVEMENTS by id rather than by counting two lists and hoping. Counting was
      // the first version and it passed for the wrong reasons.
      data-movement-id={row.id}
      className={highlighted ? 'bg-primary/10 transition-colors' : 'transition-colors'}
    >
      {/* Rule 8/12: the BUSINESS date, never created_at. */}
      <td className="py-2 pr-3 whitespace-nowrap text-charcoal-muted">
        {formatDisplayDate(row.business_date)}
      </td>

      {propertyScope ? (
        <td className="py-2 pr-3 whitespace-nowrap text-charcoal">{locationName}</td>
      ) : null}

      <td className="py-2 pr-3">
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wide uppercase ${movementTypeTone(
            row.movement_type,
          )}`}
        >
          {movementTypeLabel(row.movement_type)}
        </span>
        {row.reversed_by_movement_id ? (
          <span className="mt-0.5 block font-semibold text-primary">
            Reversed — see the reversal below
          </span>
        ) : null}
        {row.reverses_movement_id ? (
          <span className="mt-0.5 block font-semibold text-primary">
            Reverses the {reversedLabel(row.reverses_movement_id)} above
          </span>
        ) : null}
        {row.batch_code ? (
          <span className="mt-0.5 block text-charcoal-muted">
            Batch {row.batch_code}
            {row.expiry_date ? ` · expires ${formatDisplayDate(row.expiry_date)}` : ''}
          </span>
        ) : null}
        {row.reason ? <span className="mt-0.5 block text-charcoal-muted">{row.reason}</span> : null}
        {row.note ? <span className="mt-0.5 block text-charcoal-muted">{row.note}</span> : null}
      </td>

      <td className="py-2 pr-3 text-right tabular-nums text-charcoal">
        {formatSignedQuantity(row.quantity)} {baseUnit}
      </td>

      <td className="py-2 pr-3 text-right tabular-nums text-charcoal-muted">
        {/* A stock-IN states its own cost; a stock-OUT states none and left at the
            running average, which is what is shown. */}
        {row.unit_cost !== null
          ? formatMoney(row.unit_cost, currency)
          : formatMoney(row.running_average_cost, currency)}
      </td>

      <td className="py-2 pr-3 text-right font-semibold tabular-nums text-charcoal">
        {formatQuantity(row.scoped_quantity)}
      </td>

      <td className="py-2 pr-3 text-right tabular-nums text-charcoal">
        {/* NO PROPERTY-WIDE RUNNING AVERAGE EXISTS. Showing this location's here
            would be a figure that is true of neither the row nor the page. */}
        {propertyScope ? (
          <span className="text-charcoal-muted" title="Averages are per location">
            —
          </span>
        ) : (
          formatMoney(row.running_average_cost, currency)
        )}
      </td>

      <td className="py-2 text-right align-top">
        {canReverse ? (
          <button
            type="button"
            onClick={() => onReverse(row)}
            className="rounded-full border border-sand-border bg-white/70 px-3 py-1 text-[11px] font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream focus-visible:outline-none"
          >
            Reverse
          </button>
        ) : null}
      </td>
    </tr>
  );
}
