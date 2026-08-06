import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Pagination } from '../../ui/Pagination';
import { Select } from '../../ui/form';
import type { SelectOption } from '../../ui/form';
import { useToast } from '../../ui/Toast';
import { DownloadIcon, PlusIcon } from '../../ui/icons';
import { useLocations } from '../../../hooks/useLocations';
import { useInventoryReference } from '../../../hooks/useInventoryReference';
import { useStockOnHand } from '../../../hooks/useStockOnHand';
import { todayIsoInZone } from '../../../lib/date';
import { describeError } from '../../../lib/errors';
import { fetchAllInventoryItems } from '../../../lib/inventory';
import { fetchStockForExport, type StockState } from '../../../lib/stock';
import type { InventoryItem } from '../../../types/inventory';
import { StockEntryForm } from './StockEntryForm';
import { StockSummaryBar } from './StockSummaryBar';
import { StockTable } from './StockTable';

// THE STOCK VIEW — what one location actually holds, what it cost and what it is
// worth (F&B/Inventory part 2a).
//
// This is the first inventory screen with real quantities on it. Part 1 defined
// items and locations; nothing had a number. Everything here is computed from
// the movement ledger on every read — there is no stored quantity anywhere in
// the system (rule 6), which is why the figures cannot drift from the movements
// that produced them.
//
// LIST-SURFACE STANDARD (rule 1b), in full:
//   * server-side pagination via .range() with an exact count — never a client
//     slice of a capped fetch;
//   * an always-visible page-of-N readout, jump to first/last, direct page entry
//     and a page-size selector (the shared Pagination component);
//   * every filter applied SERVER-SIDE, including "low stock", which is a
//     computed column in the view precisely so it can be one.
//
// RULE 20, the two things that sit beside the list:
//   * the TOTAL STOCK VALUE spans the whole filtered set, from a separate
//     aggregate query over the same filter — never summed from the visible page;
//   * EXPORT writes every row matching the filter, across all pages.
// Both carry the "how this is calculated" note rule 16 requires, and it says so.
//
// ONE LOCATION AT A TIME, by design. Stock is physical: 200 kg of rice in the
// Main Store and 15 kg in the Kitchen are separate quantities with separate
// valuations, and a screen that blended them would answer a question nobody at a
// hotel asks. The location picker is the primary control on the page.

interface StockScreenProps {
  tenantId: string;
  propertyId: string;
  propertySlug: string;
  currency: string;
  timezone: string;
}

export function StockScreen({
  tenantId,
  propertyId,
  propertySlug,
  currency,
  timezone,
}: StockScreenProps) {
  const toast = useToast();
  const locations = useLocations(propertyId, tenantId);
  const reference = useInventoryReference(tenantId);

  const [locationId, setLocationId] = useState('');
  // Default to the property's first location once they load. Not stored
  // anywhere (no browser storage, by constraint) — a fresh visit starts at the
  // first location, which for a hotel is the main store.
  if (!locationId && locations.rows.length > 0) {
    setLocationId(locations.rows[0].id);
  }

  const list = useStockOnHand(tenantId, propertyId, locationId || null);

  const [searchDraft, setSearchDraft] = useState('');
  const [showEntry, setShowEntry] = useState(false);
  const [entryPreset, setEntryPreset] = useState<
    { itemId: string; mode: 'opening' | 'adjustment' } | undefined
  >(undefined);
  const [exporting, setExporting] = useState(false);

  // The catalogue, for the entry form's item picker. Loaded here rather than in
  // the form so opening and closing the form does not refetch three hundred
  // items each time.
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [itemsError, setItemsError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const rows = await fetchAllInventoryItems(tenantId, true);
        if (!cancelled) setItems(rows);
      } catch (e) {
        if (!cancelled) setItemsError(describeError(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tenantId]);

  const location = locations.rows.find((l) => l.id === locationId) ?? null;

  const locationOptions: SelectOption[] = locations.rows.map((l) => ({
    value: l.id,
    label: l.is_active ? l.name : `${l.name} (closed)`,
  }));

  const categoryOptions: SelectOption[] = [
    { value: '', label: 'All categories' },
    ...reference.categories.map((c) => ({ value: c.id, label: c.name })),
  ];

  const stateOptions: SelectOption[] = [
    { value: '', label: 'Everything with movements' },
    { value: 'in_stock', label: 'In stock' },
    { value: 'low', label: 'At or below reorder level' },
    { value: 'zero', label: 'Nothing on hand' },
    { value: 'negative', label: 'Less than nothing' },
  ];

  const filtered =
    Boolean(list.filters.search) ||
    Boolean(list.filters.categoryId) ||
    Boolean(list.filters.state);

  async function handleExport() {
    if (!location) return;
    setExporting(true);
    try {
      // Rule 20: EVERY row matching the current filter, across all pages —
      // never the visible page. The same filter builder as the list and the
      // total, so all three describe the same stock.
      const rows = await fetchStockForExport(
        tenantId,
        propertyId,
        location.id,
        list.filters,
      );
      // The spreadsheet writer is loaded ON DEMAND, matching useStatementExport:
      // the OOXML builder and fflate are only needed by the person who actually
      // clicks Export, and every kilobyte in the main bundle is paid for by a
      // customer on a Nigerian mobile connection.
      const [{ buildStockXlsx }, { downloadBytes, XLSX_MIME }] =
        await Promise.all([
          import('../../../lib/export/stockXlsx'),
          import('../../../lib/export/download'),
        ]);
      const issueDate = todayIsoInZone(timezone);
      const bytes = buildStockXlsx(rows, location.name, currency, issueDate);
      const safeName = location.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
      downloadBytes(bytes, `stock-${safeName}-${issueDate}.xlsx`, XLSX_MIME);
      toast.success(`${rows.length} rows exported.`);
    } catch (e) {
      // Rule 11: never swallowed.
      toast.error(describeError(e));
    } finally {
      setExporting(false);
    }
  }

  function openEntry(preset?: { itemId: string; mode: 'opening' | 'adjustment' }) {
    setEntryPreset(preset);
    setShowEntry(true);
  }

  return (
    <div className="mx-auto max-w-5xl">
      <header className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight text-charcoal">
          Stock on hand
        </h1>
        <p className="mt-1 text-sm text-charcoal-muted">
          What each store, kitchen and bar is holding right now, and what it is
          worth. Every figure is added up from the movements recorded against it
          — nothing is stored, so nothing can drift.
        </p>
      </header>

      {locations.error ? (
        <ErrorState
          message={locations.error.message}
          onRetry={() => void locations.reload()}
        />
      ) : locations.rows.length === 0 && !locations.loading ? (
        <NoLocations propertySlug={propertySlug} />
      ) : (
        <>
          {/* The location picker is the page's primary control, not a filter:
              stock is physical and belongs to one box at a time. */}
          <div className="mb-4 grid gap-3 sm:grid-cols-2">
            <Select
              label="Location"
              value={locationId}
              onChange={(v) => {
                setLocationId(v);
                setShowEntry(false);
              }}
              options={locationOptions}
              disabled={locations.loading}
            />
          </div>

          <div className="mb-4">
            <StockSummaryBar
              summary={list.summary}
              loading={list.loading}
              currency={currency}
              onShowNegative={() =>
                list.setFilters({ ...list.filters, state: 'negative' })
              }
              onShowLow={() => list.setFilters({ ...list.filters, state: 'low' })}
            />
          </div>

          {itemsError ? (
            <p className="mb-4 rounded-xl border border-sand-border bg-white/60 p-3 text-sm text-charcoal-muted">
              The item list could not load, so adding stock is unavailable:{' '}
              {itemsError}
            </p>
          ) : null}

          {/* Filters — ALL applied server-side (rule 1b), so the count, the page,
              the total and the export always describe the same set. */}
          <form
            className="mb-4 grid gap-3 sm:grid-cols-2"
            onSubmit={(e) => {
              e.preventDefault();
              list.setFilters({ ...list.filters, search: searchDraft });
            }}
          >
            <div className="sm:col-span-2">
              <label className="block">
                <span className="mb-1 block text-sm font-medium text-charcoal">
                  Search items
                </span>
                <div className="flex flex-wrap gap-2">
                  <input
                    type="text"
                    value={searchDraft}
                    onChange={(e) => setSearchDraft(e.target.value)}
                    placeholder="Name or code…"
                    className="min-w-0 flex-1 rounded-lg border border-sand-border bg-white/70 px-3 py-2 text-sm text-charcoal transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream"
                  />
                  <button
                    type="submit"
                    className="rounded-lg border border-sand-border bg-white/70 px-4 py-2 text-sm font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream"
                  >
                    Search
                  </button>
                  {filtered ? (
                    <button
                      type="button"
                      onClick={() => {
                        setSearchDraft('');
                        list.setFilters({ search: '', categoryId: '', state: '' });
                      }}
                      className="rounded-lg px-3 py-2 text-sm font-semibold text-charcoal-muted transition-colors hover:text-charcoal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream"
                    >
                      Clear
                    </button>
                  ) : null}
                </div>
              </label>
            </div>

            <Select
              label="Category"
              value={list.filters.categoryId}
              onChange={(v) => list.setFilters({ ...list.filters, categoryId: v })}
              options={categoryOptions}
            />
            <Select
              label="Show"
              value={list.filters.state}
              onChange={(v) =>
                list.setFilters({ ...list.filters, state: v as StockState })
              }
              options={stateOptions}
            />
          </form>

          <div className="mb-4 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => openEntry()}
              disabled={!location || items.length === 0}
              className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:cursor-not-allowed disabled:opacity-50"
            >
              <PlusIcon className="h-4 w-4" />
              Add or correct stock
            </button>
            <Link
              to={`/admin/${propertySlug}/stock/import`}
              className="rounded-full border border-sand-border bg-white/70 px-5 py-2.5 text-sm font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream"
            >
              Load from a spreadsheet
            </Link>
            <button
              type="button"
              onClick={() => void handleExport()}
              disabled={exporting || !location}
              className="ml-auto inline-flex items-center gap-2 rounded-full border border-sand-border bg-white/70 px-4 py-2 text-xs font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:cursor-not-allowed disabled:opacity-50"
              // Rule 20 stated where the user is about to act on it.
              title="Exports every row matching the current filter, across all pages — not just this page."
            >
              <DownloadIcon className="h-4 w-4" />
              {exporting ? 'Exporting…' : 'Export'}
            </button>
          </div>

          {showEntry && location ? (
            <div className="mb-6">
              <StockEntryForm
                tenantId={tenantId}
                propertyId={propertyId}
                locationId={location.id}
                locationName={location.name}
                currency={currency}
                timezone={timezone}
                items={items}
                presetItemId={entryPreset?.itemId}
                presetMode={entryPreset?.mode}
                onDone={async () => {
                  setShowEntry(false);
                  setEntryPreset(undefined);
                  await list.reload();
                }}
                onCancel={() => {
                  setShowEntry(false);
                  setEntryPreset(undefined);
                }}
              />
            </div>
          ) : null}

          {list.error ? (
            <ErrorState
              message={list.error.message}
              onRetry={() => void list.reload()}
            />
          ) : list.loading && list.rows.length === 0 ? (
            <LoadingState />
          ) : list.rows.length === 0 ? (
            <EmptyState
              filtered={filtered}
              locationName={location?.name ?? ''}
              propertySlug={propertySlug}
            />
          ) : (
            <>
              <StockTable
                rows={list.rows}
                tenantId={tenantId}
                propertyId={propertyId}
                currency={currency}
                onCorrect={(row) =>
                  openEntry({ itemId: row.inventory_item_id, mode: 'adjustment' })
                }
              />

              <div className="mt-6">
                <Pagination
                  page={list.page}
                  pageSize={list.pageSize}
                  totalCount={list.count}
                  onPageChange={list.setPage}
                  onPageSizeChange={list.setPageSize}
                  disabled={list.loading}
                  itemNoun="items"
                />
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

function LoadingState() {
  return (
    <div
      className="flex items-center justify-center rounded-2xl border border-sand-border bg-white/60 py-16"
      aria-busy="true"
      aria-live="polite"
    >
      <span className="sr-only">Loading stock…</span>
      <span className="h-7 w-7 animate-spin rounded-full border-2 border-sand-border border-t-primary" />
    </div>
  );
}

function EmptyState({
  filtered,
  locationName,
  propertySlug,
}: {
  filtered: boolean;
  locationName: string;
  propertySlug: string;
}) {
  return (
    <div className="rounded-2xl border border-dashed border-sand-border bg-white/40 px-6 py-12 text-center">
      <p className="text-base font-semibold text-charcoal">
        {filtered
          ? 'Nothing matches your filters'
          : `No stock recorded in ${locationName} yet`}
      </p>
      <p className="mx-auto mt-1 max-w-md text-sm text-charcoal-muted">
        {filtered ? (
          'Try a different search, or clear the filters.'
        ) : (
          <>
            Start by recording what is already on the shelf — one item at a time
            with “Add or correct stock”, or the whole store at once from a{' '}
            <Link
              to={`/admin/${propertySlug}/stock/import`}
              className="font-semibold text-primary underline underline-offset-2"
            >
              spreadsheet
            </Link>
            .
          </>
        )}
      </p>
    </div>
  );
}

function NoLocations({ propertySlug }: { propertySlug: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-sand-border bg-white/40 px-6 py-12 text-center">
      <p className="text-base font-semibold text-charcoal">
        This hotel has no stock locations
      </p>
      <p className="mx-auto mt-1 max-w-md text-sm text-charcoal-muted">
        Stock is held in a place — a store, a kitchen, a bar. Add at least one
        under{' '}
        <Link
          to={`/admin/${propertySlug}/locations`}
          className="font-semibold text-primary underline underline-offset-2"
        >
          Locations
        </Link>{' '}
        before recording any.
      </p>
    </div>
  );
}

function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="rounded-2xl border border-sand-border bg-white/60 p-6 text-center">
      <p className="text-sm font-medium text-charcoal">
        We couldn’t load your stock.
      </p>
      <p className="mt-1 text-sm text-charcoal-muted">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-4 inline-flex items-center rounded-lg border border-sand-border bg-white/70 px-4 py-2 text-sm font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream"
      >
        Try again
      </button>
    </div>
  );
}
