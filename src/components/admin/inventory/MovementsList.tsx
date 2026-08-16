import { useEffect, useState } from 'react';
import { Pagination } from '../../ui/Pagination';
import { DateField, Select } from '../../ui/form';
import type { SelectOption } from '../../ui/form';
import { useAuth } from '../../../hooks/useAuth';
import { formatDisplayDate, formatDisplayDateTimeInZone } from '../../../lib/date';
import { describeError } from '../../../lib/errors';
import {
  formatMoney,
  formatSignedQuantity,
  MISSING_VALUE,
} from '../../../lib/format';
import { fetchInventoryItemsByIds } from '../../../lib/inventory';
import {
  EMPTY_MOVEMENT_FILTERS,
  fetchMovementsPage,
  hasMovementFilters,
  type MovementFilters,
} from '../../../lib/stock';
import { staffLabel } from '../../../lib/staffLabel';
import type { InventoryItem, StockLocation } from '../../../types/inventory';
import type { MovementType, StockMovement } from '../../../types/stock';

// A LIST OF MOVEMENTS OF ONE TYPE — the Adjustments tab and the Import History
// tab are the same list with a different type and different words, so it is one
// component rather than two that drift.
//
// LIST-SURFACE STANDARD (rule 1b): server-side paging via .range() with an exact
// count, every filter applied server-side, and the shared Pagination component.
//
// WHY A MOVEMENT IS SHOWN WITH ITS ACTOR AND NEVER WITH AN EDIT BUTTON. A
// movement is permanent — 036 §1.4 refuses every UPDATE and DELETE at the
// database, not merely in this UI. A mistake is corrected by posting another
// movement, so the whole story stays visible. The customer's stated pain is
// staff theft, and a ledger whose rows can be edited records what somebody last
// decided it should say, not what happened.
//
// THE NAME BESIDE THE ID: there is no staff directory in the schema yet (see
// staffLabel), so "who" reads as "you" or as a short, resolvable id fragment
// rather than an invented name.

interface MovementsListProps {
  tenantId: string;
  propertyId: string;
  currency: string;
  timezone: string;
  movementType: MovementType;
  locations: StockLocation[];
  items: InventoryItem[];
  // Copy for the empty state, so the same list can say "no adjustments yet" and
  // "no opening balances loaded yet" without either being generic.
  emptyTitle: string;
  emptyBody: string;
  // Bumped by the parent after a posting, so the list re-pulls without a
  // full-page refresh.
  refreshToken: number;
}

const PAGE_SIZE = 25;

export function MovementsList({
  tenantId,
  propertyId,
  currency,
  timezone,
  movementType,
  locations,
  items,
  emptyTitle,
  emptyBody,
  refreshToken,
}: MovementsListProps) {
  const { user } = useAuth();

  const [rows, setRows] = useState<StockMovement[]>([]);
  const [count, setCount] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZE);
  const [filters, setFilters] = useState<MovementFilters>(EMPTY_MOVEMENT_FILTERS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Names for the items on THIS page — stock_movements carries an id and no
  // name, and the catalogue prop holds only ACTIVE items, while a movement
  // against a since-retired item still has to render.
  const [names, setNames] = useState<Map<string, InventoryItem>>(new Map());

  const { locationId, inventoryItemId, fromDate, toDate, direction } = filters;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const result = await fetchMovementsPage(
          tenantId,
          propertyId,
          movementType,
          page,
          pageSize,
          { locationId, inventoryItemId, fromDate, toDate, direction },
        );
        if (cancelled) return;

        const lastPage = Math.max(1, Math.ceil(result.count / pageSize));
        if (page > lastPage) {
          setPage(lastPage);
          return; // the effect re-runs with the corrected page; stay loading
        }

        // The id list is this page's, so it is bounded (rule 1a).
        const missing = Array.from(
          new Set(result.rows.map((r) => r.inventory_item_id)),
        );
        const fetched = missing.length > 0
          ? await fetchInventoryItemsByIds(tenantId, missing)
          : [];
        if (cancelled) return;

        setRows(result.rows);
        setCount(result.count);
        setNames(new Map(fetched.map((i) => [i.id, i])));
        setError(null);
      } catch (e) {
        if (cancelled) return;
        setError(describeError(e)); // rule 11: surfaced, never swallowed
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    tenantId,
    propertyId,
    movementType,
    page,
    pageSize,
    locationId,
    inventoryItemId,
    fromDate,
    toDate,
    direction,
    refreshToken,
  ]);

  function narrow(next: Partial<MovementFilters>) {
    setFilters((prev) => ({ ...prev, ...next }));
    // Filter then page, never the other way round (rule 1b).
    setPage(1);
  }

  const locationOptions: SelectOption[] = [
    { value: '', label: 'Every location' },
    ...locations.map((l) => ({ value: l.id, label: l.name })),
  ];

  const itemOptions: SelectOption[] = [
    { value: '', label: 'Every item' },
    ...items.map((i) => ({ value: i.id, label: i.code ? `${i.name} (${i.code})` : i.name })),
  ];

  const filtered = hasMovementFilters(filters);

  return (
    <div className="space-y-4">
      <div className="grid gap-3 rounded-2xl border border-sand-border bg-white/60 p-4 sm:grid-cols-2 lg:grid-cols-4">
        <Select
          label="Location"
          value={filters.locationId}
          onChange={(v) => narrow({ locationId: v })}
          options={locationOptions}
        />
        <Select
          label="Item"
          value={filters.inventoryItemId}
          onChange={(v) => narrow({ inventoryItemId: v })}
          options={itemOptions}
        />
        <DateField
          label="From"
          value={filters.fromDate}
          onChange={(v) => narrow({ fromDate: v })}
          helpText="The operating day, not the day it was keyed."
        />
        <DateField
          label="To"
          value={filters.toDate}
          onChange={(v) => narrow({ toDate: v })}
        />
        {movementType === 'adjustment' ? (
          <Select
            label="Direction"
            value={filters.direction}
            onChange={(v) => narrow({ direction: v as MovementFilters['direction'] })}
            options={[
              { value: '', label: 'Added and removed' },
              { value: 'in', label: 'Stock added' },
              { value: 'out', label: 'Stock removed' },
            ]}
          />
        ) : null}
        {filtered ? (
          <div className="flex items-end">
            <button
              type="button"
              onClick={() => {
                setFilters(EMPTY_MOVEMENT_FILTERS);
                setPage(1);
              }}
              className="rounded-lg px-3 py-2 text-sm font-semibold text-charcoal-muted transition-colors hover:text-charcoal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream"
            >
              Clear filters
            </button>
          </div>
        ) : null}
      </div>

      {error ? (
        <div className="rounded-2xl border border-sand-border bg-white/60 p-6 text-center">
          <p className="text-sm font-medium text-charcoal">
            We couldn’t load these movements.
          </p>
          <p className="mt-1 text-sm text-charcoal-muted">{error}</p>
        </div>
      ) : loading && rows.length === 0 ? (
        <div
          className="flex items-center justify-center rounded-2xl border border-sand-border bg-white/60 py-16"
          aria-busy="true"
          aria-live="polite"
        >
          <span className="sr-only">Loading…</span>
          <span className="h-7 w-7 animate-spin rounded-full border-2 border-sand-border border-t-primary" />
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-sand-border bg-white/40 px-6 py-12 text-center">
          <p className="text-base font-semibold text-charcoal">
            {filtered ? 'Nothing matches your filters' : emptyTitle}
          </p>
          <p className="mx-auto mt-1 max-w-md text-sm text-charcoal-muted">
            {filtered ? 'Try a different range, or clear the filters.' : emptyBody}
          </p>
        </div>
      ) : (
        <>
          <div className="overflow-x-auto rounded-2xl border border-sand-border bg-white/60">
            <table className="w-full border-collapse text-sm sm:min-w-[48rem]">
              <thead>
                <tr className="border-b border-sand-border bg-sand/40 text-left">
                  <th scope="col" className="px-3 py-2 text-xs font-semibold text-charcoal-muted sm:px-4">
                    Date
                  </th>
                  <th scope="col" className="px-2 py-2 text-xs font-semibold text-charcoal-muted">
                    Item
                  </th>
                  <th scope="col" className="hidden px-2 py-2 text-xs font-semibold text-charcoal-muted sm:table-cell">
                    Location
                  </th>
                  <th scope="col" className="px-2 py-2 text-right text-xs font-semibold text-charcoal-muted">
                    Change
                  </th>
                  <th scope="col" className="hidden px-2 py-2 text-right text-xs font-semibold text-charcoal-muted lg:table-cell">
                    At cost
                  </th>
                  <th scope="col" className="hidden px-2 py-2 text-xs font-semibold text-charcoal-muted lg:table-cell">
                    Recorded
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-sand-border/50">
                {rows.map((row) => {
                  const item = names.get(row.inventory_item_id) ?? null;
                  const location =
                    locations.find((l) => l.id === row.location_id) ?? null;
                  const outward = row.quantity.trim().startsWith('-');
                  return (
                    <tr key={row.id}>
                      {/* Rules 8/12: the BUSINESS date — the operating day this
                          movement belongs to, never created_at. */}
                      <td className="whitespace-nowrap px-3 py-2.5 align-top text-charcoal sm:px-4">
                        {formatDisplayDate(row.business_date)}
                      </td>
                      <td className="px-2 py-2.5 align-top">
                        <span className="block font-medium text-charcoal">
                          {item?.name ?? MISSING_VALUE}
                        </span>
                        {row.reason ? (
                          <span className="mt-0.5 block text-xs text-charcoal-muted">
                            {row.reason}
                          </span>
                        ) : null}
                        {row.note ? (
                          <span className="mt-0.5 block text-xs text-charcoal-muted">
                            {row.note}
                          </span>
                        ) : null}
                        <span className="mt-0.5 block text-xs text-charcoal-muted sm:hidden">
                          {location?.name ?? MISSING_VALUE}
                        </span>
                      </td>
                      <td className="hidden px-2 py-2.5 align-top text-xs text-charcoal-muted sm:table-cell">
                        {location?.name ?? MISSING_VALUE}
                      </td>
                      <td
                        className={`px-2 py-2.5 text-right align-top font-semibold tabular-nums ${
                          outward ? 'text-accent' : 'text-charcoal'
                        }`}
                      >
                        {formatSignedQuantity(row.quantity)}
                        <span className="block text-xs font-normal text-charcoal-muted">
                          {item?.base_unit ?? ''}
                        </span>
                      </td>
                      <td className="hidden px-2 py-2.5 text-right align-top tabular-nums text-charcoal-muted lg:table-cell">
                        {/* A stock-OUT states no cost by design (036 §2): it
                            leaves at the average already there, so a figure here
                            would be a second opinion about the same stock. */}
                        {row.unit_cost === null
                          ? MISSING_VALUE
                          : formatMoney(row.unit_cost, currency)}
                      </td>
                      <td className="hidden px-2 py-2.5 align-top text-xs text-charcoal-muted lg:table-cell">
                        {/* formatDisplayDateTimeInZone returns '' when it has
                            nothing to render; format.ts owns the dash, so the
                            fallback is supplied here rather than a silent gap. */}
                        {formatDisplayDateTimeInZone(row.created_at, timezone) ||
                          MISSING_VALUE}
                        <span className="block">
                          by {staffLabel(row.created_by, user?.id)}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <Pagination
            page={page}
            pageSize={pageSize}
            totalCount={count}
            onPageChange={setPage}
            onPageSizeChange={(size) => {
              setPageSize(size);
              setPage(1);
            }}
            disabled={loading}
            itemNoun="movements"
          />
        </>
      )}
    </div>
  );
}

// The signed-quantity formatter used to live here as a private copy, identical
// to the one in StockItemLedger. Both assumed their input was a string and
// crashed on anything else; both are now the shared formatSignedQuantity in
// lib/format.ts, which takes the sign from the parsed number instead.
