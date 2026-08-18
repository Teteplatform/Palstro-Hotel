import { useState } from 'react';
import { ChevronDownIcon } from '../../ui/icons';
import { formatMoney, formatQuantity, MISSING_VALUE } from '../../../lib/format';
import { itemTypeLabel, itemTypeTone } from '../../../lib/inventoryLabels';
import type { ProductRow } from '../../../lib/inventoryProducts';
import { StockItemLedger } from './StockItemLedger';

// THE PRODUCTS TABLE — the ERP's dense, sharp layout carried over: a real
// <table>, tight rows, right-aligned tabular numbers, one line per item.
//
// WHY A TABLE AND NOT CARDS, on a screen whose predecessor used cards for the
// catalogue: these rows are FIGURES being compared down a column. Cost, quantity
// and value only mean anything against each other, and a stack of cards makes a
// reader scan left-right-down for a comparison a column gives away at a glance.
//
// AT 360px THE NUMERIC COLUMNS FOLD. Category, type, unit, cost and the location
// breakdown move into the expanded panel; the row keeps item, on hand and value —
// the three a storekeeper checks on a phone in the store. The table scrolls
// sideways only above that fold, inside its own container, so the PAGE never
// scrolls horizontally.
//
// EVERY FIGURE IS THE SERVER'S. Nothing here multiplies a quantity by a cost or
// averages an average: the values arrive already folded from the movements (036
// §3), and recomputing one in the browser would be a second implementation of the
// valuation that could disagree with the total above the table.
//
// A NEGATIVE QUANTITY IS SHOWN AS-IS AND NEVER FLOORED (rule 7). Minus three
// kilos means three kilos left without a movement — a receipt never entered, or
// stock that walked. That is the signal this whole module exists to surface, so
// it is tinted, badged and never rounded away to a comfortable zero.

interface ProductsTableProps {
  rows: ProductRow[];
  tenantId: string;
  propertyId: string;
  currency: string;
  // The location being viewed, or null for the whole property. Decides whether
  // the expanded panel shows one location's movement ledger or the breakdown
  // across every location holding the item.
  locationId: string | null;
  // TRUE when a stock-state filter made positions the base of the list, so a row
  // is one location's holding rather than the item's whole position.
  byPosition: boolean;
  onEdit: (row: ProductRow) => void;
  onAdjust: (row: ProductRow, locationId: string) => void;
  onRemove: (row: ProductRow) => void;
  // Re-pull the page and its totals after a reversal posts from the expanded
  // ledger: the on-hand figure and the location total have both just moved.
  onReversed: () => Promise<void> | void;
  busy: boolean;
}

export function ProductsTable({
  rows,
  tenantId,
  propertyId,
  currency,
  locationId,
  byPosition,
  onEdit,
  onAdjust,
  onRemove,
  onReversed,
  busy,
}: ProductsTableProps) {
  // One row open at a time: the panel is a detail view, and two open at once
  // turns a comparison table into a scroll.
  const [openKey, setOpenKey] = useState<string | null>(null);

  return (
    <div className="overflow-x-auto rounded-2xl border border-sand-border bg-white/60">
      <table className="w-full border-collapse text-sm sm:min-w-[56rem]">
        <thead>
          <tr className="border-b border-sand-border bg-sand/40 text-left">
            <Th className="px-3 sm:px-4">Item</Th>
            <Th className="hidden lg:table-cell">Category</Th>
            <Th className="hidden xl:table-cell">Type</Th>
            <Th className="hidden xl:table-cell">Unit</Th>
            <Th className="hidden text-right sm:table-cell">Average cost</Th>
            <Th className="text-right">On hand</Th>
            <Th className="hidden lg:table-cell">Locations</Th>
            <Th className="text-right">Value</Th>
            <th scope="col" className="w-10 px-0 py-2">
              <span className="sr-only">Details</span>
            </th>
          </tr>
        </thead>

        <tbody className="divide-y divide-sand-border/50">
          {rows.map((row) => {
            // A position row is keyed by item AND location: the same item can
            // legitimately appear twice when the list is filtered by stock state.
            const key = byPosition
              ? `${row.itemId}:${row.locations[0]?.locationId ?? ''}`
              : row.itemId;
            return (
              <ProductTableRow
                key={key}
                row={row}
                open={openKey === key}
                onToggle={() => setOpenKey(openKey === key ? null : key)}
                tenantId={tenantId}
                propertyId={propertyId}
                currency={currency}
                locationId={locationId}
                byPosition={byPosition}
                onEdit={() => onEdit(row)}
                onAdjust={onAdjust}
                onRemove={() => onRemove(row)}
                onReversed={onReversed}
                busy={busy}
              />
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Th({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <th
      scope="col"
      className={`px-2 py-2 text-xs font-semibold text-charcoal-muted ${className}`}
    >
      {children}
    </th>
  );
}

function ProductTableRow({
  row,
  open,
  onToggle,
  tenantId,
  propertyId,
  currency,
  locationId,
  byPosition,
  onEdit,
  onAdjust,
  onRemove,
  onReversed,
  busy,
}: {
  row: ProductRow;
  open: boolean;
  onToggle: () => void;
  tenantId: string;
  propertyId: string;
  currency: string;
  locationId: string | null;
  byPosition: boolean;
  onEdit: () => void;
  onAdjust: (row: ProductRow, locationId: string) => void;
  onRemove: () => void;
  onReversed: () => Promise<void> | void;
  busy: boolean;
}) {
  // Already a number, or genuinely absent (rule 24). null means NO POSITION at
  // this scope, which is the distinction the next line depends on.
  const quantity = row.quantity;
  const negative = quantity !== null && quantity < 0;
  // No movements at this scope at all. Rendered as the shared em-dash, never as
  // a confident zero: "we hold none" and "we have no figure" are different
  // statements, and only one of them is true here.
  const untracked = row.quantity === null;

  // Which location an adjustment from this row should target. A single selected
  // location, the row's own when the list is by position, else the only place it
  // is held — and when it is held in several, the panel makes the person choose
  // rather than picking one for them.
  const soleLocationId =
    locationId ??
    row.locations[0]?.locationId ??
    null;
  const ambiguousLocation = !locationId && row.locations.length > 1;

  return (
    <>
      <tr className={negative ? 'bg-accent/5' : undefined}>
        <td className="px-3 py-2.5 align-top sm:px-4">
          <span className="block font-medium text-charcoal">{row.name}</span>
          <span className="mt-0.5 block text-xs text-charcoal-muted">
            {/* The folded columns ride along here at narrow widths. */}
            <span className="lg:hidden">
              {row.categoryName ? `${row.categoryName} · ` : ''}
            </span>
            {row.code ? `${row.code} · ` : ''}
            tracked in {row.baseUnit}
          </span>
          <span className="mt-1 flex flex-wrap gap-1">
            {row.isBelowReorder ? (
              <Badge tone="bg-accent/15 text-accent">At or below reorder level</Badge>
            ) : null}
            {negative ? <Badge tone="bg-accent/15 text-accent">Less than nothing</Badge> : null}
            {!row.isActive ? (
              <Badge tone="bg-sand text-charcoal-muted">Not in use</Badge>
            ) : null}
          </span>
        </td>

        <td className="hidden px-2 py-2.5 align-top text-xs text-charcoal-muted lg:table-cell">
          {row.categoryName ?? MISSING_VALUE}
        </td>

        <td className="hidden px-2 py-2.5 align-top xl:table-cell">
          <span
            className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${itemTypeTone(
              row.itemType,
            )}`}
          >
            {itemTypeLabel(row.itemType)}
          </span>
        </td>

        <td className="hidden px-2 py-2.5 align-top text-xs text-charcoal-muted xl:table-cell">
          {row.baseUnit}
        </td>

        <td className="hidden px-2 py-2.5 text-right align-top tabular-nums text-charcoal sm:table-cell">
          {row.averageCost === null ? (
            <span className="text-charcoal-muted">{MISSING_VALUE}</span>
          ) : (
            <>
              {formatMoney(row.averageCost, currency)}
              <span className="block text-xs text-charcoal-muted">
                per {row.baseUnit}
              </span>
            </>
          )}
        </td>

        <td className="px-2 py-2.5 text-right align-top tabular-nums">
          {untracked ? (
            <span className="text-charcoal-muted">{MISSING_VALUE}</span>
          ) : (
            <span
              className={`font-semibold ${negative ? 'text-accent' : 'text-charcoal'}`}
            >
              {formatQuantity(row.quantity)}
            </span>
          )}
          <span className="block text-xs text-charcoal-muted">{row.baseUnit}</span>
        </td>

        <td className="hidden max-w-[16rem] px-2 py-2.5 align-top text-xs text-charcoal-muted lg:table-cell">
          <LocationBreakdown row={row} locationId={locationId} />
        </td>

        <td className="px-2 py-2.5 text-right align-top font-semibold tabular-nums text-charcoal">
          {row.value === null ? (
            <span className="font-normal text-charcoal-muted">{MISSING_VALUE}</span>
          ) : (
            formatMoney(row.value, currency)
          )}
        </td>

        <td className="w-10 px-0 py-2 align-top">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            aria-label={open ? `Hide details for ${row.name}` : `Show details for ${row.name}`}
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
          {/* Nine columns at the widest layout; the folded ones are display:none
              rather than absent, so one span covers every layout. */}
          <td colSpan={9} className="px-0 py-0">
            <div className="border-t border-sand-border/70">
              <div className="flex flex-wrap items-start justify-between gap-2 px-3 pt-3 sm:px-4">
                <div className="min-w-0 text-xs text-charcoal-muted">
                  {/* The mobile fold's missing figures, restored where there is
                      room for them. */}
                  <p className="sm:hidden">
                    Average cost{' '}
                    <span className="font-semibold text-charcoal">
                      {row.averageCost === null
                        ? MISSING_VALUE
                        : formatMoney(row.averageCost, currency)}
                    </span>{' '}
                    per {row.baseUnit}
                  </p>
                  <p className="lg:hidden">
                    <LocationBreakdown row={row} locationId={locationId} />
                  </p>
                  {row.reorderLevel ? (
                    <p>
                      Reorder at{' '}
                      <span className="font-semibold text-charcoal">
                        {formatQuantity(row.reorderLevel)} {row.baseUnit}
                      </span>
                    </p>
                  ) : null}
                </div>

                <div className="flex flex-wrap gap-2">
                  <RowAction onClick={onEdit} disabled={busy}>
                    Edit item
                  </RowAction>
                  {soleLocationId && !ambiguousLocation ? (
                    <RowAction
                      onClick={() => onAdjust(row, soleLocationId)}
                      disabled={busy}
                    >
                      Add or correct stock
                    </RowAction>
                  ) : null}
                  <RowAction onClick={onRemove} disabled={busy}>
                    Remove item
                  </RowAction>
                </div>
              </div>

              {/* ONE LOCATION → the working behind its figures. EVERY LOCATION →
                  where the stock actually is, because a movement ledger blended
                  across locations would fold two independent averages into one
                  number that is true of neither. */}
              {locationId || byPosition ? (
                <StockItemLedger
                  tenantId={tenantId}
                  propertyId={propertyId}
                  locationId={locationId ?? row.locations[0]!.locationId}
                  inventoryItemId={row.itemId}
                  baseUnit={row.baseUnit}
                  currency={currency}
                  // Named so the reversal card can say WHICH item in WHICH
                  // location is about to move. The location name comes from the
                  // row's own position rather than being looked up, so it is
                  // always the location whose ledger is on screen.
                  itemName={row.name}
                  locationName={
                    row.locations.find(
                      (l) => l.locationId === (locationId ?? row.locations[0]!.locationId),
                    )?.locationName ?? row.locations[0]?.locationName
                  }
                  onReversed={onReversed}
                />
              ) : (
                <LocationDetail
                  row={row}
                  currency={currency}
                  onAdjust={onAdjust}
                  busy={busy}
                />
              )}
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

// "Main Store: 62 · Kitchen: 1" — the ERP's Locations column, with the hotel's
// separator. Truncated in the cell with the full string as its title, so a wide
// spread is readable without breaking the row height.
function LocationBreakdown({
  row,
  locationId,
}: {
  row: ProductRow;
  locationId: string | null;
}) {
  const held = row.locations.filter((l) => l.quantity !== 0);

  if (locationId) {
    const here = row.locations[0];
    return (
      <span className="truncate">{here ? here.locationName : MISSING_VALUE}</span>
    );
  }

  if (held.length === 0) {
    return <span className="text-charcoal-muted">Nowhere yet</span>;
  }

  const text = held
    .map((l) => `${l.locationName}: ${formatQuantity(l.quantity)}`)
    .join(' · ');

  return (
    <span className="block truncate" title={text}>
      {text}
    </span>
  );
}

// The per-location breakdown as a real little table, shown when the page is
// looking at every location at once. Each line is a position with its OWN
// average cost — two locations holding the same item at different costs is
// normal, and the roll-up above is value/quantity, never the mean of these.
function LocationDetail({
  row,
  currency,
  onAdjust,
  busy,
}: {
  row: ProductRow;
  currency: string;
  onAdjust: (row: ProductRow, locationId: string) => void;
  busy: boolean;
}) {
  if (row.locations.length === 0) {
    return (
      <p className="px-3 py-4 text-xs text-charcoal-muted sm:px-4">
        This item has no stock recorded in any location yet. Record an opening
        balance from a location, or add stock with an adjustment.
      </p>
    );
  }

  return (
    <div className="px-3 py-3 sm:px-4">
      <p className="mb-2 text-xs text-charcoal-muted">
        Where this item is held. Each location keeps its own quantity and its own
        average cost — pick a location above to see the movements behind them.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[28rem] border-collapse text-xs">
          <thead>
            <tr className="border-b border-sand-border text-left">
              <th scope="col" className="py-1.5 pr-3 font-semibold text-charcoal-muted">
                Location
              </th>
              <th scope="col" className="py-1.5 pr-3 text-right font-semibold text-charcoal-muted">
                On hand
              </th>
              <th scope="col" className="py-1.5 pr-3 text-right font-semibold text-charcoal-muted">
                Average cost
              </th>
              <th scope="col" className="py-1.5 pr-3 text-right font-semibold text-charcoal-muted">
                Value
              </th>
              <th scope="col" className="py-1.5" />
            </tr>
          </thead>
          <tbody className="divide-y divide-sand-border/50">
            {row.locations.map((l) => {
              const q = l.quantity;
              const negative = q < 0;
              return (
                <tr key={l.locationId}>
                  <td className="py-2 pr-3 text-charcoal">
                    {l.locationName}
                    {l.isBelowReorder ? (
                      <span className="ml-1 text-accent">· low</span>
                    ) : null}
                  </td>
                  <td
                    className={`py-2 pr-3 text-right tabular-nums font-semibold ${
                      negative ? 'text-accent' : 'text-charcoal'
                    }`}
                  >
                    {formatQuantity(l.quantity)} {row.baseUnit}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums text-charcoal-muted">
                    {formatMoney(l.averageCost, currency)}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums text-charcoal">
                    {formatMoney(l.value, currency)}
                  </td>
                  <td className="py-2 text-right">
                    <button
                      type="button"
                      onClick={() => onAdjust(row, l.locationId)}
                      disabled={busy}
                      className="rounded-lg px-2 py-1 text-[11px] font-semibold text-primary transition-colors hover:bg-white/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream disabled:opacity-60"
                    >
                      Correct here
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RowAction({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded-full border border-sand-border bg-white/70 px-3 py-1.5 text-xs font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:opacity-60"
    >
      {children}
    </button>
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
