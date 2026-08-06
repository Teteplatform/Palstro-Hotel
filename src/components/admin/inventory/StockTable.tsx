import { useState } from 'react';
import { ChevronDownIcon } from '../../ui/icons';
import { formatMoney, formatQuantity, MISSING_VALUE } from '../../../lib/format';
import { parseNumeric } from '../../../lib/format';
import { formatDisplayDate } from '../../../lib/date';
import type { StockOnHandRow } from '../../../types/stock';
import { StockItemLedger } from './StockItemLedger';

// The stock table — the ERP's dense, sharp layout carried over: a real <table>,
// tight rows, right-aligned tabular numbers, one line per item.
//
// WHY A TABLE AND NOT CARDS, on a screen where part 1 used cards: these rows are
// FIGURES being compared down a column. Quantity, cost and value only mean
// anything against each other, and a stack of cards makes a reader scan
// left-right-down for a comparison a column gives away at a glance. The
// catalogue screen has no figures, which is why it stays cards.
//
// AT 360px the numeric columns fold: cost moves into the expanded panel (where
// the ledger explains it properly anyway) and the row keeps item, quantity and
// value — the three a storekeeper checks on a phone in the store. Nothing
// scrolls sideways; the fold is a real second layout, not a squeeze.
//
// EVERY FIGURE IS THE SERVER'S. Nothing here multiplies a quantity by a cost:
// stock_value arrives already computed from the movements (036 §3.1), and
// recomputing it in the browser would be a second implementation of the
// valuation that could disagree with the total above the table.

interface StockTableProps {
  rows: StockOnHandRow[];
  tenantId: string;
  propertyId: string;
  currency: string;
  onCorrect: (row: StockOnHandRow) => void;
}

export function StockTable({
  rows,
  tenantId,
  propertyId,
  currency,
  onCorrect,
}: StockTableProps) {
  // One row open at a time: the ledger is a detail view, and two open at once
  // turns a comparison table into a scroll.
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <div className="rounded-2xl border border-sand-border bg-white/60">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-sand-border bg-sand/40 text-left">
            <th
              scope="col"
              className="rounded-tl-2xl px-3 py-2 text-xs font-semibold text-charcoal-muted sm:px-4"
            >
              Item
            </th>
            <th
              scope="col"
              className="hidden px-2 py-2 text-xs font-semibold text-charcoal-muted sm:table-cell"
            >
              Category
            </th>
            <th
              scope="col"
              className="px-2 py-2 text-right text-xs font-semibold text-charcoal-muted"
            >
              On hand
            </th>
            <th
              scope="col"
              className="hidden px-2 py-2 text-right text-xs font-semibold text-charcoal-muted sm:table-cell"
            >
              Average cost
            </th>
            <th
              scope="col"
              className="px-2 py-2 text-right text-xs font-semibold text-charcoal-muted"
            >
              Value
            </th>
            <th scope="col" className="w-10 rounded-tr-2xl px-0 py-2">
              <span className="sr-only">Movements</span>
            </th>
          </tr>
        </thead>

        <tbody className="divide-y divide-sand-border/50">
          {rows.map((row) => {
            const open = openId === row.inventory_item_id;
            // §6: numeric arrives as a STRING — parsed explicitly before any
            // comparison. `typeof col === 'number'` is always false here.
            const quantity = parseNumeric(row.quantity_on_hand);
            const negative = quantity !== null && quantity < 0;

            return (
              <StockRow
                key={row.inventory_item_id}
                row={row}
                open={open}
                negative={negative}
                currency={currency}
                tenantId={tenantId}
                propertyId={propertyId}
                onToggle={() =>
                  setOpenId(open ? null : row.inventory_item_id)
                }
                onCorrect={() => onCorrect(row)}
              />
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function StockRow({
  row,
  open,
  negative,
  currency,
  tenantId,
  propertyId,
  onToggle,
  onCorrect,
}: {
  row: StockOnHandRow;
  open: boolean;
  negative: boolean;
  currency: string;
  tenantId: string;
  propertyId: string;
  onToggle: () => void;
  onCorrect: () => void;
}) {
  return (
    <>
      <tr className={negative ? 'bg-accent/5' : undefined}>
        <td className="px-3 py-2.5 align-top sm:px-4">
          <span className="block font-medium text-charcoal">
            {row.item_name}
          </span>
          <span className="mt-0.5 block text-xs text-charcoal-muted">
            {/* On mobile the category column is gone, so it rides along here. */}
            <span className="sm:hidden">
              {row.category_name ? `${row.category_name} · ` : ''}
            </span>
            {row.item_code ? `${row.item_code} · ` : ''}
            tracked in {row.base_unit}
          </span>
          <span className="mt-1 flex flex-wrap gap-1">
            {row.is_below_reorder ? (
              <Badge tone="bg-accent/15 text-accent">
                At or below reorder level
              </Badge>
            ) : null}
            {negative ? (
              <Badge tone="bg-accent/15 text-accent">Less than nothing</Badge>
            ) : null}
            {!row.item_is_active ? (
              <Badge tone="bg-sand text-charcoal-muted">Out of use</Badge>
            ) : null}
          </span>
        </td>

        <td className="hidden px-2 py-2.5 align-top text-xs text-charcoal-muted sm:table-cell">
          {row.category_name ?? MISSING_VALUE}
        </td>

        <td className="px-2 py-2.5 text-right align-top tabular-nums">
          <span
            className={`font-semibold ${negative ? 'text-accent' : 'text-charcoal'}`}
          >
            {formatQuantity(row.quantity_on_hand)}
          </span>
          <span className="block text-xs text-charcoal-muted">
            {row.base_unit}
          </span>
        </td>

        <td className="hidden px-2 py-2.5 text-right align-top tabular-nums text-charcoal sm:table-cell">
          {formatMoney(row.moving_average_cost, currency)}
          <span className="block text-xs text-charcoal-muted">
            per {row.base_unit}
          </span>
        </td>

        <td className="px-2 py-2.5 text-right align-top font-semibold tabular-nums text-charcoal">
          {formatMoney(row.stock_value, currency)}
        </td>

        <td className="w-10 px-0 py-2 align-top">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            aria-label={
              open
                ? `Hide movements for ${row.item_name}`
                : `Show movements for ${row.item_name}`
            }
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-charcoal-muted transition-colors hover:bg-sand hover:text-charcoal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream"
          >
            <ChevronDownIcon
              className={`h-4 w-4 transition-transform ${open ? 'rotate-180' : ''}`}
            />
          </button>
        </td>
      </tr>

      {open ? (
        <tr className="bg-sand/20">
          {/* Six columns at the widest layout; the folded ones are display:none
              rather than absent, so one span covers both layouts. */}
          <td colSpan={6} className="px-0 py-0">
            <div className="border-t border-sand-border/70">
              <div className="flex flex-wrap items-center justify-between gap-2 px-3 pt-3 sm:px-4">
                <p className="text-xs text-charcoal-muted">
                  {/* The mobile fold's missing figure, restored where there is
                      room for it. */}
                  <span className="sm:hidden">
                    Average cost{' '}
                    <span className="font-semibold text-charcoal">
                      {formatMoney(row.moving_average_cost, currency)}
                    </span>{' '}
                    per {row.base_unit} ·{' '}
                  </span>
                  Last movement{' '}
                  <span className="font-semibold text-charcoal">
                    {row.last_movement_date
                      ? formatDisplayDate(row.last_movement_date)
                      : MISSING_VALUE}
                  </span>
                  {row.reorder_level ? (
                    <>
                      {' '}
                      · Reorder at{' '}
                      <span className="font-semibold text-charcoal">
                        {formatQuantity(row.reorder_level)} {row.base_unit}
                      </span>
                    </>
                  ) : null}
                </p>
                <button
                  type="button"
                  onClick={onCorrect}
                  className="rounded-full border border-sand-border bg-white/70 px-4 py-1.5 text-xs font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream"
                >
                  Correct this stock
                </button>
              </div>

              <StockItemLedger
                tenantId={tenantId}
                propertyId={propertyId}
                locationId={row.location_id}
                inventoryItemId={row.inventory_item_id}
                baseUnit={row.base_unit}
                currency={currency}
              />
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

function Badge({ tone, children }: { tone: string; children: React.ReactNode }) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${tone}`}
    >
      {children}
    </span>
  );
}
