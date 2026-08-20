import { useState } from 'react';
import { Pagination } from '../../ui/Pagination';
import { Select } from '../../ui/form';
import type { SelectOption } from '../../ui/form';
import { useToast } from '../../ui/Toast';
import { DownloadIcon, PlusIcon, SearchIcon } from '../../ui/icons';
import { useInventoryProducts } from '../../../hooks/useInventoryProducts';
import { todayIsoInZone } from '../../../lib/date';
import { describeError, humanizeError } from '../../../lib/errors';
import {
  fetchInventoryItemsByIds,
  softDeleteInventoryItem,
} from '../../../lib/inventory';
import { ITEM_TYPES, itemTypeLabel } from '../../../lib/inventoryLabels';
import {
  EMPTY_PRODUCT_FILTERS,
  fetchProductsForExport,
  hasProductFilters,
  type ProductRow,
  type ProductStockState,
} from '../../../lib/inventoryProducts';
import {
  PRODUCTS_ABOUT,
  PRODUCTS_ABOUT_TITLE,
  UNPRICED_SELLABLE_FILTER_LABEL,
} from '../../../lib/stockLabels';
import type {
  InventoryCategory,
  InventoryItem,
  ItemType,
  StockLocation,
  UnitOfMeasure,
} from '../../../types/inventory';
import { ScreenHeader } from '../../ui/ScreenHeader';
import { AddProductChoiceDialog } from './AddProductChoiceDialog';
import { InventorySummaryCard } from './InventorySummaryCard';
import { ItemPanel } from './ItemPanel';
import { ProductsTable } from './ProductsTable';
import { StockEntryForm } from './StockEntryForm';

// THE PRODUCTS TAB — the main screen of the module, and the one the ERP's
// Products page is modelled on: the catalogue, with each item's stock beside it.
//
// LIST-SURFACE STANDARD (rule 1b), in full:
//   * server-side pagination via .range() with an exact count — never a client
//     slice of a capped fetch;
//   * an always-visible page-of-N readout, jump to first/last, direct page entry
//     and a page-size selector (the shared Pagination component);
//   * every filter applied SERVER-SIDE, including the stock-state ones, which is
//     why they switch the query's base table rather than filtering a page.
//
// RULE 20, the two things that sit beside the list:
//   * the SUMMARY spans the whole filtered set, from separate aggregate queries
//     over the same filters — never summed from the visible page;
//   * EXPORT writes every row matching the filter, across all pages.
// Both carry the "how this is calculated" note rule 16 requires, and both say
// explicitly that they cover the filter rather than the page.

interface ProductsTabProps {
  tenantId: string;
  propertyId: string;
  propertySlug: string;
  currency: string;
  timezone: string;
  // NULL = every location in this property.
  locationId: string | null;
  locations: StockLocation[];
  units: UnitOfMeasure[];
  categories: InventoryCategory[];
  referenceLoading: boolean;
  // The whole active catalogue, for the stock entry form's item picker. Loaded
  // once by the screen rather than per form, so opening and closing the form
  // does not refetch three hundred items each time.
  items: InventoryItem[];
  itemsError: string | null;
  onCatalogueChanged: () => Promise<void> | void;
  // Re-pulls units and categories after the item form's inline "+ New" adds one.
  onReferenceChanged: () => Promise<void> | void;
}

export function ProductsTab({
  tenantId,
  propertyId,
  propertySlug,
  currency,
  timezone,
  locationId,
  locations,
  units,
  categories,
  referenceLoading,
  items,
  itemsError,
  onCatalogueChanged,
  onReferenceChanged,
}: ProductsTabProps) {
  const toast = useToast();
  const list = useInventoryProducts(tenantId, propertyId, locationId);

  const [searchDraft, setSearchDraft] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [busy, setBusy] = useState(false);

  // The add/edit slide-over. `editing` null with `panelOpen` true is "add".
  const [panelOpen, setPanelOpen] = useState(false);
  const [editing, setEditing] = useState<InventoryItem | null>(null);

  // ADD PRODUCT ASKS "ONE, OR MANY?" FIRST. Pressing the button no longer opens
  // the form directly — it opens the choice, because the bulk path used to be a
  // small link on a different screen that nobody found, and a hotel setting up
  // has three hundred items to enter, not one.
  const [choiceOpen, setChoiceOpen] = useState(false);

  function openAddChoice() {
    setEditing(null);
    setChoiceOpen(true);
  }

  // The stock entry form, opened against one item in one location from a row.
  const [entry, setEntry] = useState<{ itemId: string; locationId: string } | null>(
    null,
  );

  const scopeLocation = locations.find((l) => l.id === locationId) ?? null;
  const filtered = hasProductFilters(list.filters);

  const categoryOptions: SelectOption[] = [
    { value: '', label: 'All categories' },
    ...categories.map((c) => ({ value: c.id, label: c.name })),
  ];

  const typeOptions: SelectOption[] = [
    { value: '', label: 'All types' },
    ...ITEM_TYPES.map((t) => ({ value: t, label: itemTypeLabel(t) })),
  ];

  const stateOptions: SelectOption[] = [
    { value: '', label: 'Everything in the catalogue' },
    { value: 'in_stock', label: 'Holding stock' },
    { value: 'low', label: 'At or below reorder level' },
    { value: 'zero', label: 'Nothing on hand' },
    { value: 'negative', label: 'Less than nothing' },
  ];

  async function handleExport() {
    setExporting(true);
    try {
      // Rule 20: EVERY row matching the current filter, across all pages — never
      // the visible page. The same filter builders as the list and the summary,
      // so all three describe the same stock.
      const rows = await fetchProductsForExport(
        tenantId,
        propertyId,
        locationId,
        list.filters,
      );
      // The spreadsheet writer is loaded ON DEMAND: the OOXML builder is only
      // needed by the person who actually clicks Export, and every kilobyte in
      // the main bundle is paid for by a customer on a Nigerian mobile
      // connection.
      const [{ buildProductsXlsx }, { downloadBytes, XLSX_MIME }] = await Promise.all([
        import('../../../lib/export/productsXlsx'),
        import('../../../lib/export/download'),
      ]);
      const issueDate = todayIsoInZone(timezone);
      const scopeName = scopeLocation?.name ?? 'All locations';
      const bytes = buildProductsXlsx(
        withCategoryNames(rows, categories),
        scopeName,
        currency,
        issueDate,
      );
      const safeName = scopeName.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
      downloadBytes(bytes, `inventory-${safeName}-${issueDate}.xlsx`, XLSX_MIME);
      toast.success(`${rows.length} rows exported.`);
    } catch (e) {
      toast.error(describeError(e)); // rule 11: never swallowed
    } finally {
      setExporting(false);
    }
  }

  // The edit panel needs the WHOLE catalogue row, and the list row is a
  // projection of it. The shared `items` list holds only ACTIVE items (it is
  // there to populate pickers), so an item that has been switched off — visible
  // whenever the filters ask for it — is fetched on demand rather than edited
  // from a half-row, which would blank whatever the projection left out.
  async function handleEdit(row: ProductRow) {
    const known = items.find((i) => i.id === row.itemId) ?? null;
    if (known) {
      setEditing(known);
      setPanelOpen(true);
      return;
    }
    setBusy(true);
    try {
      const [full] = await fetchInventoryItemsByIds(tenantId, [row.itemId]);
      if (!full) throw new Error('That item could not be found.');
      setEditing(full);
      setPanelOpen(true);
    } catch (e) {
      toast.error(humanizeError(e)); // rule 11: surfaced, never swallowed
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove(row: ProductRow) {
    if (
      !window.confirm(
        `Remove "${row.name}"? It leaves the catalogue, but its history is kept and it can be added again later. An item still holding stock anywhere cannot be removed.`,
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      await softDeleteInventoryItem(row.itemId, tenantId);
      toast.success('Item removed.');
      await Promise.all([list.reload(), onCatalogueChanged()]);
    } catch (e) {
      // 036 §6 refuses this at the DATABASE when the item still holds stock, and
      // says so in a sentence the user can act on.
      toast.error(humanizeError(e));
    } finally {
      setBusy(false);
    }
  }

  const entryLocation = entry
    ? (locations.find((l) => l.id === entry.locationId) ?? null)
    : null;

  const rows = withCategoryNames(list.rows, categories);

  return (
    <div className="space-y-4">
      {/* The tab's own line of purpose sits on the page header above; what this
          list is and how its figures are worked out is in the ⓘ (rule 25).
          Placed beside the summary card because that is the first thing on the
          tab and the figures are what people ask about. */}
      <ScreenHeader
        level={2}
        title="Products"
        purpose="Your catalogue, with what is on the shelf beside it."
        about={{
          title: PRODUCTS_ABOUT_TITLE,
          paragraphs: PRODUCTS_ABOUT,
          guideAnchor: 'products-the-item-list',
          guideLabel: 'Products — the item list',
        }}
        propertySlug={propertySlug}
      />

      <InventorySummaryCard
        summary={list.summary}
        loading={list.loading}
        currency={currency}
        scopeName={scopeLocation?.name ?? null}
        onShowLow={() => list.setFilters({ ...list.filters, state: 'low' })}
        onShowNegative={() => list.setFilters({ ...list.filters, state: 'negative' })}
        // The excluded count leads to the CATALOGUE view of the gap, with the
        // stock-state filter cleared: the count is about items holding stock, but
        // the job it starts is "price everything that is sold", and an unpriced
        // item with an empty shelf needs a price just as much.
        onShowUnpriced={() =>
          list.setFilters({ ...list.filters, state: '', unpricedSellable: true })
        }
      />

      {itemsError ? (
        <p className="rounded-xl border border-sand-border bg-white/60 p-3 text-sm text-charcoal-muted">
          The full item list could not load, so adding and correcting stock is
          unavailable: {itemsError}
        </p>
      ) : null}

      {/* Search, filters and the actions, on one wrapping row — the ERP's
          arrangement, at the hotel's touch sizes. */}
      <div className="flex flex-wrap items-center gap-2">
        <form
          className="relative min-w-[12rem] flex-1"
          onSubmit={(e) => {
            e.preventDefault();
            list.setFilters({ ...list.filters, search: searchDraft });
          }}
        >
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-charcoal-muted" />
          <input
            type="search"
            value={searchDraft}
            onChange={(e) => setSearchDraft(e.target.value)}
            placeholder="Search by name or code…"
            aria-label="Search items"
            className="w-full rounded-lg border border-sand-border bg-white/70 py-2 pl-9 pr-3 text-sm text-charcoal transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream"
          />
          {/* A submit button the layout does not need but the keyboard does. */}
          <button type="submit" className="sr-only">
            Search
          </button>
        </form>

        <button
          type="button"
          onClick={() => setShowFilters((v) => !v)}
          aria-expanded={showFilters}
          className={`rounded-lg border px-4 py-2 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream ${
            showFilters || filtered
              ? 'border-primary bg-primary/10 text-primary'
              : 'border-sand-border bg-white/70 text-charcoal hover:bg-sand'
          }`}
        >
          Filters
        </button>

        {/* The opening-stock import USED TO SIT HERE, labelled "Import", beside
            Add product — and that placement is what taught people that adding a
            product meant uploading a stock sheet. It has moved to a secondary
            action on the page header ("Load opening stock"), where it reads as
            what it is: a once-per-location job, done after the items exist.
            Adding many products at once is now reached through Add product
            itself, which is where somebody looking for it actually looks. */}

        <button
          type="button"
          onClick={() => void handleExport()}
          disabled={exporting}
          // Rule 20, stated where the user is about to act on it.
          title="Exports every row matching the current filters, across all pages — not just this page."
          className="inline-flex items-center gap-2 rounded-lg border border-sand-border bg-white/70 px-4 py-2 text-sm font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream disabled:cursor-not-allowed disabled:opacity-60"
        >
          <DownloadIcon className="h-4 w-4" />
          {exporting ? 'Exporting…' : 'Export'}
        </button>

        <button
          type="button"
          onClick={openAddChoice}
          className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream"
        >
          <PlusIcon className="h-4 w-4" />
          Add product
        </button>
      </div>

      {showFilters ? (
        <div className="grid gap-3 rounded-2xl border border-sand-border bg-white/60 p-4 sm:grid-cols-2 lg:grid-cols-4">
          <Select
            label="Category"
            value={list.filters.categoryId}
            onChange={(v) => list.setFilters({ ...list.filters, categoryId: v })}
            options={categoryOptions}
          />
          <Select
            label="Type"
            value={list.filters.itemType}
            onChange={(v) =>
              list.setFilters({ ...list.filters, itemType: v as ItemType | '' })
            }
            options={typeOptions}
          />
          <Select
            label="Stock"
            value={list.filters.state}
            onChange={(v) =>
              list.setFilters({ ...list.filters, state: v as ProductStockState })
            }
            options={stateOptions}
          />
          <Select
            label="Items switched off"
            value={list.filters.includeInactive ? 'yes' : 'no'}
            onChange={(v) =>
              list.setFilters({ ...list.filters, includeInactive: v === 'yes' })
            }
            options={[
              { value: 'no', label: 'Hidden' },
              { value: 'yes', label: 'Shown' },
            ]}
          />
          {/* THE GAP THE PRICE RULE CANNOT CLOSE BY ITSELF (042 §1.2), as a
              first-class filter rather than something to spot by eye. The database
              stops the gap growing; this is what makes the gap that already exists
              findable, which is the difference between a rule that is achievable
              and one that is merely stated. */}
          <Select
            label="Selling price"
            value={list.filters.unpricedSellable ? 'missing' : ''}
            onChange={(v) =>
              list.setFilters({ ...list.filters, unpricedSellable: v === 'missing' })
            }
            options={[
              { value: '', label: 'Any' },
              { value: 'missing', label: UNPRICED_SELLABLE_FILTER_LABEL },
            ]}
          />
          {filtered ? (
            <div className="sm:col-span-2 lg:col-span-4">
              <button
                type="button"
                onClick={() => {
                  setSearchDraft('');
                  list.setFilters(EMPTY_PRODUCT_FILTERS);
                }}
                className="rounded-lg px-3 py-2 text-sm font-semibold text-charcoal-muted transition-colors hover:text-charcoal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream"
              >
                Clear all filters
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* THE ONE SENTENCE THAT STAYED, and the test for why. It is not an
          explanation of the screen — it is a statement about what the rows in
          front of you currently ARE: narrowed by stock, the list is one line per
          LOCATION, so an item held in two places is two rows. Somebody counting
          rows needs it to read the table correctly, and it appears only in the
          mode where it is true. The two negative surfaces differing, and how the
          figures are worked out, are in the ⓘ. */}
      {list.byPosition ? (
        <p className="text-xs text-charcoal-muted">
          One line per location, so an item held in two places appears twice.
        </p>
      ) : null}

      {entry && entryLocation ? (
        <StockEntryForm
          tenantId={tenantId}
          propertyId={propertyId}
          locationId={entryLocation.id}
          locationName={entryLocation.name}
          currency={currency}
          timezone={timezone}
          items={items}
          presetItemId={entry.itemId}
          presetMode="adjustment"
          onDone={async () => {
            setEntry(null);
            await list.reload();
          }}
          onCancel={() => setEntry(null)}
        />
      ) : null}

      {list.error ? (
        <ErrorState message={list.error.message} onRetry={() => void list.reload()} />
      ) : list.loading && list.rows.length === 0 ? (
        <LoadingState />
      ) : list.rows.length === 0 ? (
        <EmptyState filtered={filtered} onAdd={openAddChoice} />
      ) : (
        <>
          <ProductsTable
            rows={rows}
            tenantId={tenantId}
            propertyId={propertyId}
            currency={currency}
            locationId={locationId}
            byPosition={list.byPosition}
            busy={busy}
            onEdit={(row) => void handleEdit(row)}
            onAdjust={(row, locId) => setEntry({ itemId: row.itemId, locationId: locId })}
            onRemove={(row) => void handleRemove(row)}
            // A reversal from the expanded ledger moves the on-hand figure and
            // the location's total, so both the page and the summary are
            // re-pulled — never patched locally, which would be a second,
            // drifting copy of a number the server already computes.
            onReversed={() => list.reload()}
          />

          <div className="mt-6">
            <Pagination
              page={list.page}
              pageSize={list.pageSize}
              totalCount={list.count}
              onPageChange={list.setPage}
              onPageSizeChange={list.setPageSize}
              disabled={list.loading || busy}
              itemNoun={list.byPosition ? 'lines' : 'items'}
            />
          </div>
        </>
      )}

      {choiceOpen ? (
        <AddProductChoiceDialog
          propertySlug={propertySlug}
          onSingle={() => {
            setChoiceOpen(false);
            setEditing(null);
            setPanelOpen(true);
          }}
          onClose={() => setChoiceOpen(false)}
        />
      ) : null}

      {panelOpen ? (
        <ItemPanel
          tenantId={tenantId}
          propertyId={propertyId}
          item={editing}
          units={units}
          categories={categories}
          locations={locations}
          referenceLoading={referenceLoading}
          currency={currency}
          timezone={timezone}
          defaultLocationId={locationId}
          onReferenceChanged={onReferenceChanged}
          onSaved={async () => {
            await Promise.all([list.reload(), onCatalogueChanged()]);
          }}
          onClose={() => {
            setPanelOpen(false);
            setEditing(null);
          }}
        />
      ) : null}
    </div>
  );
}

// The catalogue query does not join the category table — that would be a join on
// every page for a name this screen is already holding in its reference data. A
// row whose STOCK supplied the name keeps it; an item holding nothing anywhere
// has no position to have carried one, so it is filled in here. Without this, an
// item that has a category but no stock would read as uncategorised, which is a
// wrong fact rather than a missing one. Applied to the export as well as the
// screen, so the spreadsheet says the same thing the table does.
function withCategoryNames(
  rows: ProductRow[],
  categories: InventoryCategory[],
): ProductRow[] {
  return rows.map((row) => {
    if (row.categoryName !== null || row.categoryId === null) return row;
    const name = categories.find((c) => c.id === row.categoryId)?.name ?? null;
    return name === null ? row : { ...row, categoryName: name };
  });
}

function LoadingState() {
  return (
    <div
      className="flex items-center justify-center rounded-2xl border border-sand-border bg-white/60 py-16"
      aria-busy="true"
      aria-live="polite"
    >
      <span className="sr-only">Loading items…</span>
      <span className="h-7 w-7 animate-spin rounded-full border-2 border-sand-border border-t-primary" />
    </div>
  );
}

function EmptyState({ filtered, onAdd }: { filtered: boolean; onAdd: () => void }) {
  return (
    <div className="rounded-2xl border border-dashed border-sand-border bg-white/40 px-6 py-12 text-center">
      <p className="text-base font-semibold text-charcoal">
        {filtered ? 'Nothing matches your filters' : 'No items yet'}
      </p>
      <p className="mx-auto mt-1 max-w-md text-sm text-charcoal-muted">
        {filtered
          ? 'Try a different search, or clear the filters.'
          : 'Start with what your kitchen and bar use most. Add product takes one at a time, or the whole catalogue from a spreadsheet.'}
      </p>
      {!filtered ? (
        <button
          type="button"
          onClick={onAdd}
          className="mt-4 inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream"
        >
          <PlusIcon className="h-4 w-4" />
          Add product
        </button>
      ) : null}
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="rounded-2xl border border-sand-border bg-white/60 p-6 text-center">
      <p className="text-sm font-medium text-charcoal">
        We couldn’t load your inventory.
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
