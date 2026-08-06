import { useEffect, useState } from 'react';
import { formatDisplayDate } from '../../../lib/date';
import { describeError } from '../../../lib/errors';
import { formatMoney, formatQuantity, MISSING_VALUE } from '../../../lib/format';
import { fetchItemLedger } from '../../../lib/stock';
import {
  MOVING_AVERAGE_EXPLANATION,
  movementTypeLabel,
  movementTypeTone,
} from '../../../lib/stockLabels';
import type { StockLedgerRow } from '../../../types/stock';

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
}

export function StockItemLedger({
  tenantId,
  propertyId,
  locationId,
  inventoryItemId,
  baseUnit,
  currency,
}: StockItemLedgerProps) {
  const [rows, setRows] = useState<StockLedgerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
              <th scope="col" className="py-1.5 text-right font-semibold text-charcoal-muted">
                Average after
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-sand-border/50">
            {rows.map((row) => (
              <tr key={row.id}>
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
                  {signedQuantity(row.quantity)} {baseUnit}
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
                <td className="py-2 text-right tabular-nums text-charcoal">
                  {formatMoney(row.running_average_cost, currency)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// §6: numeric arrives as a STRING. formatQuantity parses it; the sign is added
// here so a positive movement reads "+40" rather than "40".
function signedQuantity(value: string): string {
  const formatted = formatQuantity(value);
  if (formatted === MISSING_VALUE) return formatted;
  return value.trim().startsWith('-') ? formatted : `+${formatted}`;
}
