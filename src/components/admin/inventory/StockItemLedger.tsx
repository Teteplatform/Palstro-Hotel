import { useCallback, useEffect, useState } from 'react';
import { formatDisplayDate } from '../../../lib/date';
import { describeError } from '../../../lib/errors';
import {
  formatMoney,
  formatQuantity,
  formatSignedQuantity,
} from '../../../lib/format';
import { fetchItemLedger } from '../../../lib/stock';
import {
  MOVING_AVERAGE_EXPLANATION,
  movementTypeLabel,
  movementTypeTone,
} from '../../../lib/stockLabels';
import type { StockLedgerRow } from '../../../types/stock';
import { ReverseMovementForm } from './ReverseMovementForm';

// THE WORKING BEHIND THE NUMBER — every movement of one item in one location,
// oldest first, each with the running quantity and running average cost as at
// that movement.
//
// WHY THIS EXISTS AT ALL. Rule 16 says a summary figure must explain how it was
// calculated, and a moving average is the least self-evident figure in the whole
// product: a storekeeper who sees "₦1.5909 per kg" when every delivery note said
// ₦1.50 or ₦1.70 will assume the system is wrong. Here they can see the exact
// line where the average moved and by how much, and check it against the
// paperwork. An explanation the user can verify beats an explanation they have
// to believe.
//
// EVERY RUNNING FIGURE COMES FROM THE DATABASE (the stock_movement_ledger view,
// 036 §3.4), folded by the same aggregate that produces the on-hand figures. It
// is deliberately NOT recomputed here: a second implementation in TypeScript
// would drift from the first, and then the working shown would disagree with the
// number shown while nothing errored — the exact trap 022's header records.
//
// Loaded COMPLETE (fetchAllPaged in the data layer, rule 1a), not paged. Rule 1b
// forbids a CAPPED list with no way to reach the rest; this is not capped, and
// completeness is the point — a valuation trail missing its middle proves
// nothing.

interface StockItemLedgerProps {
  tenantId: string;
  propertyId: string;
  locationId: string;
  inventoryItemId: string;
  baseUnit: string;
  currency: string;
  // Named for the reversal card, which has to say WHICH item in WHICH location
  // is about to move. Optional so existing callers that only expand a ledger
  // are unaffected; without them the action is not offered, because a reversal
  // card that could not name what it was about would be worse than no button.
  itemName?: string;
  locationName?: string;
  // Called after a reversal posts, so the surrounding stock list re-pulls its
  // page and its totals — the on-hand figure above this ledger has just moved.
  onReversed?: () => Promise<void> | void;
}

export function StockItemLedger({
  tenantId,
  propertyId,
  locationId,
  inventoryItemId,
  baseUnit,
  currency,
  itemName,
  locationName,
  onReversed,
}: StockItemLedgerProps) {
  const [rows, setRows] = useState<StockLedgerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Which row's reversal card is open. One at a time: two open cards would mean
  // two PINs on screen and two things that could be confirmed by accident.
  const [reversing, setReversing] = useState<StockLedgerRow | null>(null);

  const canReverse = Boolean(itemName && locationName);

  const load = useCallback(async () => {
    const data = await fetchItemLedger(
      tenantId,
      propertyId,
      locationId,
      inventoryItemId,
    );
    setRows(data);
  }, [tenantId, propertyId, locationId, inventoryItemId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const data = await fetchItemLedger(
          tenantId,
          propertyId,
          locationId,
          inventoryItemId,
        );
        if (cancelled) return;
        setRows(data);
        setError(null);
      } catch (e) {
        // Rule 11: shown, never swallowed. describeError keeps the real cause
        // visible on a panel whose whole job is to be checkable.
        if (!cancelled) setError(describeError(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tenantId, propertyId, locationId, inventoryItemId]);

  if (loading) {
    return (
      <p className="px-3 py-4 text-xs text-charcoal-muted" aria-live="polite">
        Loading movements…
      </p>
    );
  }

  if (error) {
    return (
      <p className="px-3 py-4 text-xs text-charcoal">
        The movements could not be loaded: {error}
      </p>
    );
  }

  if (rows.length === 0) {
    return (
      <p className="px-3 py-4 text-xs text-charcoal-muted">
        No movements recorded for this item here.
      </p>
    );
  }

  return (
    <div className="px-3 py-3 sm:px-4">
      <p className="mb-2 text-xs text-charcoal-muted">
        Every movement, oldest first, with what the stock stood at afterwards.{' '}
        {MOVING_AVERAGE_EXPLANATION}
      </p>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[34rem] border-collapse text-xs">
          <thead>
            <tr className="border-b border-sand-border text-left">
              <th scope="col" className="py-1.5 pr-3 font-semibold text-charcoal-muted">
                Date
              </th>
              <th scope="col" className="py-1.5 pr-3 font-semibold text-charcoal-muted">
                Movement
              </th>
              <th scope="col" className="py-1.5 pr-3 text-right font-semibold text-charcoal-muted">
                Change
              </th>
              <th scope="col" className="py-1.5 pr-3 text-right font-semibold text-charcoal-muted">
                At cost
              </th>
              <th scope="col" className="py-1.5 pr-3 text-right font-semibold text-charcoal-muted">
                On hand after
              </th>
              <th scope="col" className="py-1.5 pr-3 text-right font-semibold text-charcoal-muted">
                Average after
              </th>
              {canReverse ? (
                <th scope="col" className="py-1.5 text-right font-semibold text-charcoal-muted">
                  <span className="sr-only">Actions</span>
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody className="divide-y divide-sand-border/50">
            {rows.map((row) => (
              <LedgerRow
                key={row.id}
                row={row}
                rows={rows}
                baseUnit={baseUnit}
                currency={currency}
                canReverse={canReverse}
                onReverse={setReversing}
              />
            ))}
          </tbody>
        </table>
      </div>

      {/* Rendered INLINE, below the ledger it acts on, for FolioActionCard's own
          reason: this panel already sits inside a dialog that traps focus, and a
          nested modal means two traps arguing over the same Escape key. Keeping
          it in the scroll flow also keeps the movement being reversed visible
          while the reason is typed. */}
      {reversing && itemName && locationName ? (
        <div className="mt-3">
          <ReverseMovementForm
            movement={reversing}
            itemName={itemName}
            locationName={locationName}
            baseUnit={baseUnit}
            onDone={async () => {
              setReversing(null);
              // Re-pull THIS ledger so the counter appears with its running
              // figures, then let the parent re-pull the list and its totals.
              try {
                await load();
              } catch (e) {
                setError(describeError(e));
              }
              await onReversed?.();
            }}
            onCancel={() => setReversing(null)}
          />
        </div>
      ) : null}
    </div>
  );
}

// The label of the movement a reversal points at, for the cross-link. Falls back
// to a neutral word rather than an id: the ledger is loaded complete, so the
// target is normally present, and "movement" reads better than a uuid in the one
// case where it is not.
function reversedLabel(rows: StockLedgerRow[], targetId: string): string {
  const target = rows.find((r) => r.id === targetId);
  return target ? movementTypeLabel(target.movement_type).toLowerCase() : 'movement';
}


// ONE LEDGER ROW, extracted so it can be RENDERED in a proof without standing up
// the whole component and its data fetch.
//
// That is not testability for its own sake. 1.1c shipped with 40 passing SQL
// wiring proofs and a screen that crashed on first render, because a SQL proof
// cannot render React: it confirmed every column existed and every RPC accepted
// its arguments, and said nothing about what the browser does with the JSON.
// The crash was a formatter assuming a shape PostgREST does not always send.
// This seam is what lets a proof exercise the real row markup against real
// PostgREST shapes — a reversal row, a null carried cost, an int8 seq.
//
// It is the SAME component the screen renders; there is no second copy to drift.
export function LedgerRow({
  row,
  rows,
  baseUnit,
  currency,
  canReverse,
  onReverse,
}: {
  row: StockLedgerRow;
  // The whole ledger, so a reversal can name the movement it undid. Loaded
  // complete, so the target is present.
  rows: StockLedgerRow[];
  baseUnit: string;
  currency: string;
  canReverse: boolean;
  onReverse: (row: StockLedgerRow) => void;
}) {
  return (
  <tr>
    {/* Rule 8/12: the BUSINESS date, the operating day the movement
        belongs to — never created_at. */}
    <td className="py-2 pr-3 whitespace-nowrap text-charcoal-muted">
      {formatDisplayDate(row.business_date)}
    </td>
    <td className="py-2 pr-3">
      <span
        className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${movementTypeTone(
          row.movement_type,
        )}`}
      >
        {movementTypeLabel(row.movement_type)}
      </span>
      {/* THE TWO ROWS LINK TO EACH OTHER (038 §1A). The counter says
          what it undid; the original says it was undone. Both facts
          come from the view — reverses_movement_id is a real column,
          reversed_by_movement_id is derived by the view from the
          partial unique index — so neither is inferred here. */}
      {row.reversed_by_movement_id ? (
        <span className="mt-0.5 block font-semibold text-primary">
          Reversed — see the reversal below
        </span>
      ) : null}
      {row.reverses_movement_id ? (
        <span className="mt-0.5 block font-semibold text-primary">
          Reverses the {reversedLabel(rows, row.reverses_movement_id)} above
        </span>
      ) : null}
      {row.batch_code ? (
        <span className="mt-0.5 block text-charcoal-muted">
          Batch {row.batch_code}
          {row.expiry_date
            ? ` · expires ${formatDisplayDate(row.expiry_date)}`
            : ''}
        </span>
      ) : null}
      {row.reason ? (
        <span className="mt-0.5 block text-charcoal-muted">
          {row.reason}
        </span>
      ) : null}
      {row.note ? (
        <span className="mt-0.5 block text-charcoal-muted">
          {row.note}
        </span>
      ) : null}
    </td>
    {/* The signed change, with its sign shown explicitly: a bare
        "40" in a ledger is ambiguous in the one place ambiguity
        costs money. */}
    <td className="py-2 pr-3 text-right tabular-nums text-charcoal">
      {formatSignedQuantity(row.quantity)} {baseUnit}
    </td>
    <td className="py-2 pr-3 text-right tabular-nums text-charcoal-muted">
      {/* A stock-IN states its own cost; a stock-OUT states none and
          left at the running average, which is what is shown. */}
      {row.unit_cost !== null
        ? formatMoney(row.unit_cost, currency)
        : formatMoney(row.running_average_cost, currency)}
    </td>
    <td className="py-2 pr-3 text-right tabular-nums font-semibold text-charcoal">
      {formatQuantity(row.running_quantity)}
    </td>
    <td className="py-2 pr-3 text-right tabular-nums text-charcoal">
      {formatMoney(row.running_average_cost, currency)}
    </td>
    {canReverse ? (
      <td className="py-2 text-right align-top">
        {/* WHICH ROWS OFFER THE ACTION. An opening balance and a row
            that is itself a reversal are both refused by the server
            (038 §7 guards 5 and 6), and one already reversed is
            refused too. Hiding the button for those three is a
            COURTESY that saves a pointless round trip — the database
            is still the guard, and a user who reached the RPC any
            other way gets the same refusal with the same sentence. */}
        {row.movement_type !== 'opening' &&
        row.movement_type !== 'reversal' &&
        !row.reversed_by_movement_id ? (
          <button
            type="button"
            onClick={() => onReverse(row)}
            className="rounded-full border border-sand-border bg-white/70 px-3 py-1 text-[11px] font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream"
          >
            Reverse
          </button>
        ) : null}
      </td>
    ) : null}
  </tr>
  );
}

// The signed-quantity formatter used to live here as a private copy, identical
// to MovementsList's. Both assumed their input was a string and crashed on
// anything else; both are now the shared formatSignedQuantity in lib/format.ts,
// which takes the sign from the parsed number instead.
