import { useState } from 'react';
import { Pagination } from '../../ui/Pagination';
import { ScreenHeader } from '../../ui/ScreenHeader';
import { CalculationNote } from '../../ui/CalculationNote';
import { Select } from '../../ui/form';
import { LocationPicker } from './LocationPicker';
import type { SelectOption } from '../../ui/form';
import { useToast } from '../../ui/Toast';
import { DownloadIcon, SearchIcon } from '../../ui/icons';
import { useNegativePositions } from '../../../hooks/useNegativePositions';
import { todayIsoInZone, formatDisplayDate } from '../../../lib/date';
import { describeError } from '../../../lib/errors';
import { formatMoney, formatQuantity, MISSING_VALUE } from '../../../lib/format';
import {
  fetchNegativePositionsForExport,
  hasNegativeFilters,
  isUncorrectable,
} from '../../../lib/stock';
import {
  NEGATIVE_STOCK_ABOUT,
  NEGATIVE_STOCK_ABOUT_TITLE,
  NEGATIVE_STOCK_TOTAL_EXPLANATION,
  NEGATIVE_UNCORRECTABLE_NOTE,
} from '../../../lib/stockLabels';
import type { InventoryCategory, StockLocation } from '../../../types/inventory';
import type { StockNegativePositionRow } from '../../../types/stock';

// NEGATIVE STOCK — the discrepancy screen (038 §9).
//
// ---------------------------------------------------------------------------
// THIS IS A QUESTION, NOT AN ERROR LIST
// ---------------------------------------------------------------------------
// A negative on-hand means stock left without a movement behind it: a delivery
// that was never entered, an issue posted against the wrong location, or stock
// that walked. Every one of those has a different answer, and none of them is
// "the system is broken". So the screen opens by saying what a negative means
// and what to check, and the rows are lines of enquiry rather than faults —
// though that explanation now lives behind the ⓘ and in the staff guide (rule
// 25), because it is the same paragraph every time and the rows are the point.
//
// Negative stock is never blocked and never floored (rule 7). 038 argues that at
// length and this screen is the other half of it: a negative nobody looks at is
// the same as one rounded away to zero.
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS BESIDE THE PRODUCTS TAB'S "negative" FILTER
// ---------------------------------------------------------------------------
// The two are not duplicates and must not read as duplicates. The exact
// difference, verified against the view rather than assumed: stock_on_hand_items
// filters "deleted_at is null" on the item and the location, and does NOT filter
// is_active. So:
//
//   * a negative behind a REMOVED item or location is invisible to the Products
//     tab and visible ONLY here. That is what this screen is for.
//   * a negative behind a SWITCHED-OFF parent appears on BOTH — and is
//     uncorrectable on both, because the posting RPCs require an ACTIVE location
//     and item. This screen is the one that says so, per row and in a total.
//
// The Products filter carries a line saying this and pointing here.
//
// ---------------------------------------------------------------------------
// LIST-SURFACE STANDARD (rule 1b), in full
// ---------------------------------------------------------------------------
//   * server-side pagination via .range() with an exact count — never a client
//     slice of a capped fetch;
//   * an always-visible page-of-N readout, jump to first/last, direct page entry
//     and a page-size selector (the shared Pagination component);
//   * every filter applied SERVER-SIDE, through one builder shared with the
//     totals and the export.
// RULE 20: the summary and the export both span the WHOLE FILTERED SET, from
// separate queries over the same filters — never the visible page.

interface NegativeStockTabProps {
  tenantId: string;
  propertyId: string;
  propertySlug: string;
  currency: string;
  timezone: string;
  locations: StockLocation[];
  categories: InventoryCategory[];
}

export function NegativeStockTab({
  tenantId,
  propertyId,
  propertySlug,
  currency,
  timezone,
  locations,
  categories,
}: NegativeStockTabProps) {
  const toast = useToast();
  const list = useNegativePositions(tenantId, propertyId);
  const [searchDraft, setSearchDraft] = useState('');
  const [exporting, setExporting] = useState(false);

  const filtered = hasNegativeFilters(list.filters);

  // The row behind the location filter, for its label. The screen already holds the
  // property's locations; only the SEARCH goes to the server (rule 26).
  const filterLocation =
    locations.find((l) => l.id === list.filters.locationId) ?? null;

  const categoryOptions: SelectOption[] = [
    { value: '', label: 'All categories' },
    ...categories.map((c) => ({ value: c.id, label: c.name })),
  ];

  async function handleExport() {
    setExporting(true);
    try {
      // Rule 20: EVERY row matching the current filter, across all pages — never
      // the visible page. Same filter builder as the list and the summary.
      const rows = await fetchNegativePositionsForExport(
        tenantId,
        propertyId,
        list.filters,
      );
      // Loaded ON DEMAND: the OOXML builder is only needed by the person who
      // actually clicks Export, and every kilobyte in the main bundle is paid
      // for by a customer on a Nigerian mobile connection.
      const [{ buildNegativeStockXlsx }, { downloadBytes, XLSX_MIME }] =
        await Promise.all([
          import('../../../lib/export/negativeStockXlsx'),
          import('../../../lib/export/download'),
        ]);
      const issueDate = todayIsoInZone(timezone);
      const bytes = buildNegativeStockXlsx(rows, currency, issueDate);
      downloadBytes(
        bytes,
        `negative-stock-${issueDate}.xlsx`,
        XLSX_MIME,
      );
      toast.success(`${rows.length} rows exported.`);
    } catch (e) {
      toast.error(describeError(e)); // rule 11: never swallowed
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* One line of purpose (rule 25). What a negative MEANS — that it is a
          question worth asking rather than a fault, and that this screen sees
          ones the Products tab cannot — is in the ⓘ, because somebody who opens
          this screen twice a week already knows. */}
      <ScreenHeader
        className="rounded-2xl border border-sand-border bg-white/60 p-4"
        level={2}
        title="Negative stock"
        purpose="Positions holding less than nothing, biggest hole first."
        about={{
          title: NEGATIVE_STOCK_ABOUT_TITLE,
          paragraphs: NEGATIVE_STOCK_ABOUT,
          guideAnchor: 'finding-stock-that-says-less-than-nothing',
          guideLabel: 'Finding stock that says less than nothing',
        }}
        propertySlug={propertySlug}
      />

      {/* THE SUMMARY, across the whole filtered set (rule 20), each figure with
          its own note (rule 16). */}
      <div className="grid gap-3 sm:grid-cols-3">
        <SummaryTile
          label="Positions"
          value={
            list.summary ? String(list.summary.positionCount) : MISSING_VALUE
          }
          note="Every item-and-location pair holding less than nothing, across the whole filtered set — not just this page."
        />
        <SummaryTile
          label="Value of the shortfall"
          value={
            list.summary
              ? formatMoney(list.summary.totalValue, currency)
              : MISSING_VALUE
          }
          note={NEGATIVE_STOCK_TOTAL_EXPLANATION}
          tone="accent"
        />
        <SummaryTile
          label="Cannot be corrected yet"
          value={
            list.summary
              ? String(list.summary.uncorrectableCount)
              : MISSING_VALUE
          }
          note={`${NEGATIVE_UNCORRECTABLE_NOTE} Counted across the whole filtered set.`}
          tone={
            list.summary && list.summary.uncorrectableCount > 0
              ? 'accent'
              : undefined
          }
        />
      </div>

      {/* Search, filters and export, on one wrapping row. */}
      <div className="flex flex-wrap items-end gap-2">
        <form
          className="flex min-w-[14rem] flex-1 items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            list.setFilters({ ...list.filters, search: searchDraft });
          }}
        >
          <label className="flex-1">
            <span className="mb-1 block text-sm font-semibold text-charcoal">
              Search
            </span>
            <input
              type="search"
              value={searchDraft}
              onChange={(e) => setSearchDraft(e.target.value)}
              placeholder="Item name or code"
              className="w-full rounded-lg border border-sand-border bg-white/80 px-3 py-2.5 text-sm text-charcoal transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream"
            />
          </label>
          <button
            type="submit"
            className="flex items-center gap-1.5 rounded-full border border-sand-border bg-white/70 px-4 py-2.5 text-sm font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream"
          >
            <SearchIcon className="h-4 w-4" />
            Search
          </button>
        </form>

        <button
          type="button"
          onClick={() => void handleExport()}
          disabled={exporting || list.count === 0}
          title="Exports every row matching the current filters, across all pages — not just this page."
          className="flex items-center gap-1.5 rounded-full border border-sand-border bg-white/70 px-4 py-2.5 text-sm font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:cursor-not-allowed disabled:opacity-50"
        >
          <DownloadIcon className="h-4 w-4" />
          {exporting ? 'Exporting…' : 'Export'}
        </button>
      </div>

      <div className="grid gap-3 rounded-2xl border border-sand-border bg-white/60 p-4 sm:grid-cols-3">
        {/* Searchable, server-side (rule 26). A FILTER over positions that are
            already wrong, so closed locations are offered too — the whole point of
            this screen is the negatives sitting behind something switched off, and
            a picker that hid them would hide the rows it exists to show. */}
        <LocationPicker
          tenantId={tenantId}
          propertyId={propertyId}
          value={list.filters.locationId}
          onChange={(v) => list.setFilters({ ...list.filters, locationId: v })}
          selectedLocation={filterLocation}
          clearable
          placeholder="Every location"
        />
        <Select
          label="Category"
          value={list.filters.categoryId}
          onChange={(v) => list.setFilters({ ...list.filters, categoryId: v })}
          options={categoryOptions}
        />
        <Select
          label="Show"
          value={list.filters.onlyUncorrectable ? 'blocked' : ''}
          onChange={(v) =>
            list.setFilters({
              ...list.filters,
              onlyUncorrectable: v === 'blocked',
            })
          }
          options={[
            { value: '', label: 'Every negative position' },
            { value: 'blocked', label: 'Only ones that cannot be corrected' },
          ]}
          helpText={NEGATIVE_UNCORRECTABLE_NOTE}
        />
      </div>

      {list.error ? (
        <p className="rounded-2xl border border-sand-border bg-white/60 p-6 text-center text-sm text-charcoal">
          We couldn’t load the negative positions: {list.error.message}
        </p>
      ) : list.loading && list.rows.length === 0 ? (
        <div
          className="flex items-center justify-center rounded-2xl border border-sand-border bg-white/60 py-16"
          aria-busy="true"
          aria-live="polite"
        >
          <span className="sr-only">Loading…</span>
          <span className="h-7 w-7 animate-spin rounded-full border-2 border-sand-border border-t-primary" />
        </div>
      ) : list.rows.length === 0 ? (
        // THE EMPTY STATE IS GOOD NEWS HERE, and says so — an empty discrepancy
        // report is the outcome you want, not a screen that failed to load.
        <p className="rounded-2xl border border-dashed border-sand-border bg-white/40 px-6 py-12 text-center text-sm text-charcoal-muted">
          {filtered
            ? 'Nothing matches these filters. Try widening them.'
            : 'Nothing is showing less than nothing. Every location holds at least what the ledger says it should.'}
        </p>
      ) : (
        <>
          <div className="overflow-x-auto rounded-2xl border border-sand-border bg-white/60">
            <table className="w-full border-collapse text-sm sm:min-w-[48rem]">
              <thead>
                <tr className="border-b border-sand-border bg-sand/40 text-left">
                  <th scope="col" className="px-3 py-2 text-xs font-semibold text-charcoal-muted sm:px-4">
                    Item
                  </th>
                  <th scope="col" className="px-2 py-2 text-xs font-semibold text-charcoal-muted">
                    Location
                  </th>
                  <th scope="col" className="px-2 py-2 text-right text-xs font-semibold text-charcoal-muted">
                    On hand
                  </th>
                  <th scope="col" className="hidden px-2 py-2 text-right text-xs font-semibold text-charcoal-muted sm:table-cell">
                    Value
                  </th>
                  <th scope="col" className="hidden px-2 py-2 text-xs font-semibold text-charcoal-muted lg:table-cell">
                    Last movement
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-sand-border/50">
                {list.rows.map((row) => (
                  <NegativeRow
                    key={`${row.location_id}:${row.inventory_item_id}`}
                    row={row}
                    currency={currency}
                  />
                ))}
              </tbody>
            </table>
          </div>

          <Pagination
            page={list.page}
            pageSize={list.pageSize}
            totalCount={list.count}
            onPageChange={list.setPage}
            onPageSizeChange={list.setPageSize}
            disabled={list.loading}
            itemNoun="positions"
          />
        </>
      )}
    </div>
  );
}

function NegativeRow({
  row,
  currency,
}: {
  row: StockNegativePositionRow;
  currency: string;
}) {
  // ONE definition of "cannot be corrected", shared with the summary count and
  // the export, so the badge and the number above the table can never disagree.
  const blocked = isUncorrectable(row);

  return (
    <tr className="bg-accent/5">
      <td className="px-3 py-2.5 align-top sm:px-4">
        <span className="block font-medium text-charcoal">{row.item_name}</span>
        <span className="mt-0.5 block text-xs text-charcoal-muted">
          {row.item_code ? `${row.item_code} · ` : ''}
          in {row.base_unit}
          {row.category_name ? ` · ${row.category_name}` : ''}
        </span>
        {blocked ? (
          <span className="mt-1 inline-block rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
            {blockerLabel(row)}
          </span>
        ) : null}
      </td>
      <td className="px-2 py-2.5 align-top text-charcoal">
        {row.location_name}
        {/* Say WHY it is blocked on the row itself, and what to do — not as a
            general warning at the top that the reader has to map back. */}
        {blocked ? (
          <span className="mt-0.5 block text-xs text-charcoal-muted">
            {NEGATIVE_UNCORRECTABLE_NOTE}
          </span>
        ) : null}
      </td>
      {/* Never floored, never softened (rule 7). The minus sign is the point. */}
      <td className="px-2 py-2.5 text-right align-top font-semibold tabular-nums text-accent">
        {formatQuantity(row.quantity_on_hand)} {row.base_unit}
      </td>
      <td className="hidden px-2 py-2.5 text-right align-top tabular-nums text-charcoal sm:table-cell">
        {formatMoney(row.stock_value, currency)}
      </td>
      <td className="hidden px-2 py-2.5 align-top text-xs text-charcoal-muted lg:table-cell">
        {row.last_movement_date
          ? formatDisplayDate(row.last_movement_date)
          : MISSING_VALUE}
      </td>
    </tr>
  );
}

// Which parent is in the way, named. "Cannot be corrected" alone would send the
// reader hunting; this tells them where to go.
function blockerLabel(row: StockNegativePositionRow): string {
  if (row.location_deleted_at !== null) return 'Location removed';
  if (row.item_deleted_at !== null) return 'Item removed';
  if (!row.location_is_active) return 'Location switched off';
  return 'Item switched off';
}

function SummaryTile({
  label,
  value,
  note,
  tone,
}: {
  label: string;
  value: string;
  note: string;
  tone?: 'accent';
}) {
  return (
    <div className="rounded-2xl border border-sand-border bg-white/60 p-4">
      <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-charcoal-muted">
        {label}
        {/* Rule 16: every summary figure says how it was calculated, and every
            one of these notes states that it covers the whole filtered set. */}
        <CalculationNote note={note} />
      </p>
      <p
        className={`mt-1 text-2xl font-semibold tabular-nums ${
          tone === 'accent' ? 'text-accent' : 'text-charcoal'
        }`}
      >
        {value}
      </p>
    </div>
  );
}
