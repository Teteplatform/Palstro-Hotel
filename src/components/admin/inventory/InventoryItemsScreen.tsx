import { useState } from 'react';
import { useToast } from '../../ui/Toast';
import { Pagination } from '../../ui/Pagination';
import { Select } from '../../ui/form';
import type { SelectOption } from '../../ui/form';
import { useInventoryItems } from '../../../hooks/useInventoryItems';
import { useInventoryReference } from '../../../hooks/useInventoryReference';
import { humanizeError } from '../../../lib/errors';
import { softDeleteInventoryItem } from '../../../lib/inventory';
import { ITEM_TYPES, itemTypeLabel } from '../../../lib/inventoryLabels';
import type { InventoryItem, ItemType } from '../../../types/inventory';
import { CreateInventoryItem } from './CreateInventoryItem';
import { InventoryItemCard } from './InventoryItemCard';
import { CategoriesPanel } from './CategoriesPanel';

// The inventory items admin screen (F&B/Inventory part 1). The TENANT's shared
// catalogue: define an item once and every property uses it. Stock levels are
// property-scoped and do not exist yet (part 2), which is why this screen shows
// no quantities — only definitions.
//
// LIST-SURFACE STANDARD (rule 1b), in full:
//   * server-side pagination via .range() with an exact count — never a client
//     slice of a capped fetch,
//   * an always-visible page-of-N readout, jump to first/last, direct page
//     entry and a page-size selector (all from the shared Pagination component),
//   * every filter applied SERVER-SIDE, so paging a filtered set is correct
//     rather than paging and then filtering.
// Totals are not shown: a catalogue has nothing meaningful to total (summing
// reorder levels across kilograms and pieces would be a number with no unit and
// no meaning), so rule 20's filtered-total requirement has nothing to apply to
// here. It will apply the moment part 2 puts a stock VALUE on this screen.
//
// Reads are scoped to the active tenant in the data layer (rule 19); every write
// is awaited in try/catch with the error surfaced (rule 11).

interface InventoryItemsScreenProps {
  tenantId: string;
}

export function InventoryItemsScreen({ tenantId }: InventoryItemsScreenProps) {
  const toast = useToast();
  const list = useInventoryItems(tenantId);
  const reference = useInventoryReference(tenantId);

  // Local mirror of the current page so a single-row save reflects instantly
  // without a refetch collapsing open cards (matching CompaniesScreen).
  const [items, setItems] = useState<InventoryItem[]>(list.rows);
  const [lastRows, setLastRows] = useState(list.rows);
  if (list.rows !== lastRows) {
    setLastRows(list.rows);
    setItems(list.rows);
  }

  const [rowBusy, setRowBusy] = useState(false);
  // A local draft of the search box so typing does not refetch on every stroke;
  // it is committed on submit / Enter. The type and category selects commit
  // immediately — a single click is already a deliberate choice.
  const [searchDraft, setSearchDraft] = useState('');

  function handleUpdated(row: InventoryItem) {
    setItems((prev) => prev.map((i) => (i.id === row.id ? row : i)));
  }

  function handleCreated() {
    // A new item sorts alphabetically, so its page is not predictable; re-pull
    // the current page rather than guessing where it landed.
    void list.reload();
  }

  async function handleRequestDelete(item: InventoryItem) {
    if (
      !window.confirm(
        `Remove "${item.name}"? It leaves the catalogue, but its history is kept and it can be added again later.`,
      )
    ) {
      return;
    }
    setRowBusy(true);
    try {
      await softDeleteInventoryItem(item.id, tenantId);
      toast.success('Item removed.');
      await list.reload();
    } catch (e) {
      toast.error(humanizeError(e));
    } finally {
      setRowBusy(false);
    }
  }

  const typeOptions: SelectOption[] = [
    { value: '', label: 'All types' },
    ...ITEM_TYPES.map((t) => ({ value: t, label: itemTypeLabel(t) })),
  ];

  const categoryOptions: SelectOption[] = [
    { value: '', label: 'All categories' },
    ...reference.categories.map((c) => ({ value: c.id, label: c.name })),
  ];

  const filtered =
    Boolean(list.filters.search) ||
    Boolean(list.filters.itemType) ||
    Boolean(list.filters.categoryId);

  return (
    <div className="mx-auto max-w-3xl">
      <header className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight text-charcoal">
          Inventory items
        </h1>
        <p className="mt-1 text-sm text-charcoal-muted">
          Everything you hold, use or sell — defined once and shared by every
          property. Each item is tracked in one unit, the smallest one you
          actually measure. Stock quantities live per store and come next.
        </p>
      </header>

      {reference.error ? (
        <p className="mb-4 rounded-xl border border-sand-border bg-white/60 p-3 text-sm text-charcoal-muted">
          Units and categories could not load, so adding and editing items is
          unavailable: {reference.error.message}
        </p>
      ) : null}

      {/* Filters — ALL applied server-side (rule 1b), so the count, the page and
          the filter always describe the same set. */}
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
                    list.setFilters({
                      search: '',
                      itemType: '',
                      categoryId: '',
                    });
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
          label="Type"
          value={list.filters.itemType}
          onChange={(v) =>
            list.setFilters({ ...list.filters, itemType: v as ItemType | '' })
          }
          options={typeOptions}
        />
        <Select
          label="Category"
          value={list.filters.categoryId}
          onChange={(v) => list.setFilters({ ...list.filters, categoryId: v })}
          options={categoryOptions}
        />
      </form>

      <div className="mb-4">
        <CategoriesPanel
          tenantId={tenantId}
          categories={reference.categories}
          onChanged={() => void reference.reload()}
        />
      </div>

      <div className="mb-6">
        <CreateInventoryItem
          tenantId={tenantId}
          units={reference.units}
          categories={reference.categories}
          referenceLoading={reference.loading}
          onCreated={handleCreated}
        />
      </div>

      {list.error ? (
        <ErrorState
          message={list.error.message}
          onRetry={() => void list.reload()}
        />
      ) : list.loading && items.length === 0 ? (
        <LoadingState />
      ) : items.length === 0 ? (
        <EmptyState filtered={filtered} />
      ) : (
        <>
          <ul className="space-y-3">
            {items.map((item) => (
              <li key={item.id}>
                <InventoryItemCard
                  item={item}
                  tenantId={tenantId}
                  units={reference.units}
                  categories={reference.categories}
                  onUpdated={handleUpdated}
                  onRequestDelete={(i) => void handleRequestDelete(i)}
                  busyRow={rowBusy}
                />
              </li>
            ))}
          </ul>

          <div className="mt-6">
            <Pagination
              page={list.page}
              pageSize={list.pageSize}
              totalCount={list.count}
              onPageChange={list.setPage}
              onPageSizeChange={list.setPageSize}
              disabled={list.loading || rowBusy}
              itemNoun="items"
            />
          </div>
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
      <span className="sr-only">Loading items…</span>
      <span className="h-7 w-7 animate-spin rounded-full border-2 border-sand-border border-t-primary" />
    </div>
  );
}

function EmptyState({ filtered }: { filtered: boolean }) {
  return (
    <div className="rounded-2xl border border-dashed border-sand-border bg-white/40 px-6 py-12 text-center">
      <p className="text-base font-semibold text-charcoal">
        {filtered ? 'No items match your filters' : 'No items yet'}
      </p>
      <p className="mx-auto mt-1 max-w-md text-sm text-charcoal-muted">
        {filtered
          ? 'Try a different search, or clear the filters.'
          : 'Add your first item above — start with what your kitchen and bar use most.'}
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
        We couldn’t load your items.
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
