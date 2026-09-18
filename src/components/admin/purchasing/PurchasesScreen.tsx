import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Pagination } from '../../ui/Pagination';
import { ScreenHeader } from '../../ui/ScreenHeader';
import { CalculationNote } from '../../ui/CalculationNote';
import { PlusIcon } from '../../ui/icons';
import { DateField, Select, TextField } from '../../ui/form';
import { useToast } from '../../ui/Toast';
import { describeError } from '../../../lib/errors';
import { formatDisplayDate, todayIsoInZone } from '../../../lib/date';
import { formatMoney, MISSING_VALUE } from '../../../lib/format';
import {
  EMPTY_PURCHASE_FILTERS,
  fetchPurchaseOrdersForExport,
  fetchPurchaseOrdersPage,
  fetchPurchaseSummary,
  hasPurchaseFilters,
  type PurchaseFilters,
  type PurchaseSummary,
} from '../../../lib/purchasing';
import {
  NO_ORDERS_MATCH,
  NO_ORDERS_YET,
  OPEN_COUNT_NOTE,
  ORDERED_VALUE_NOTE,
  OUTSTANDING_VALUE_NOTE,
  PURCHASES_ABOUT,
  PURCHASES_ABOUT_TITLE,
  purchaseStatusLabel,
  purchaseStatusTone,
  RECEIVED_VALUE_NOTE,
} from '../../../lib/purchasingLabels';
import type { PurchaseOrderSummary } from '../../../types/purchasing';
import { SupplierPicker } from './SupplierPicker';

// PURCHASES — every order this hotel has raised, and the way to raise another.
//
// ---------------------------------------------------------------------------
// THE DEFAULT FILTER IS "STILL OPEN", AND THAT IS THE SCREEN'S OPINION
// ---------------------------------------------------------------------------
// The person who opens Purchases in the morning is asking one question: WHAT AM
// I STILL WAITING FOR. Landing them on every order the hotel has ever raised
// makes them do the filtering by eye, every morning, and the day they stop
// bothering is the day a short delivery goes unnoticed.
//
// It is a FILTER and not a hidden cap, which is the distinction rule 1b turns
// on: the control is on screen, set to a visible value, and one click away from
// "every order". A capped list with no way to reach the rest is the defect; a
// list that opens on the useful subset and says so is a default.
//
// ---------------------------------------------------------------------------
// THE FOUR FIGURES SPAN THE FILTER, NEVER THE PAGE (rules 16, 20)
// ---------------------------------------------------------------------------
// fetchPurchaseSummary pages the SAME filtered set the list pages and sums it,
// so the figure and the rows under it describe the same orders by construction.
// Each carries a note saying what it includes AND that it covers every page.
//
// Ordered and received are two different valuations of the same delivery — one
// at the price agreed, one at the price invoiced — and showing both is the only
// way a price rise is visible without opening every order.

interface PurchasesScreenProps {
  tenantId: string;
  propertyId: string;
  propertySlug: string;
  currency: string;
  timezone: string;
}

export function PurchasesScreen({
  tenantId,
  propertyId,
  propertySlug,
  currency,
  timezone,
}: PurchasesScreenProps) {
  const toast = useToast();

  // ?supplier=<id> ARRIVES FROM THE SUPPLIER ACTIVITY PANEL, which shows the 25
  // most recent orders and links here for the rest. Read ONCE, as the initial
  // filter, and not synced afterwards: the person is then free to widen or
  // narrow it, and a URL that fought the filter boxes would be a second source
  // of truth about what is on screen.
  const [searchParams] = useSearchParams();
  const initialSupplier = searchParams.get('supplier') ?? '';

  const [rows, setRows] = useState<PurchaseOrderSummary[]>([]);
  const [count, setCount] = useState(0);
  const [summary, setSummary] = useState<PurchaseSummary | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [filters, setFilters] = useState<PurchaseFilters>({
    ...EMPTY_PURCHASE_FILTERS,
    supplierId: initialSupplier,
    // ARRIVING FROM A SUPPLIER MEANS "SHOW ME EVERYTHING FROM THEM", so the
    // default open-orders filter steps aside. Landing on "still open" would hide
    // the completed orders somebody following that link came to see.
    state: initialSupplier ? '' : 'open',
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const result = await fetchPurchaseOrdersPage(
          tenantId,
          propertyId,
          page,
          pageSize,
          filters,
        );
        if (cancelled) return;

        const lastPage = Math.max(1, Math.ceil(result.count / pageSize));
        if (page > lastPage) {
          setPage(lastPage);
          return; // the effect re-runs with the corrected page; stay loading
        }

        setRows(result.rows);
        setCount(result.count);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        setError(describeError(e)); // rule 11
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tenantId, propertyId, page, pageSize, filters]);

  // A SEPARATE QUERY FROM THE PAGE, over the same filter and NOT over `page` —
  // which is what makes the figures describe the filtered set rather than the
  // twenty rows on screen (rule 20).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await fetchPurchaseSummary(tenantId, propertyId, filters);
        if (!cancelled) setSummary(result);
      } catch {
        // A failed total must not blank the list. The tiles show a dash, which
        // reads as "no figure" rather than as zero (§6, MISSING_VALUE).
        if (!cancelled) setSummary(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tenantId, propertyId, filters]);

  function narrow(next: Partial<PurchaseFilters>) {
    setFilters((prev) => ({ ...prev, ...next }));
    setPage(1); // filter then page, never the other way round (rule 1b)
  }

  async function exportAll() {
    if (exporting) return;
    setExporting(true);
    try {
      const all = await fetchPurchaseOrdersForExport(tenantId, propertyId, filters);
      // LOADED ON DEMAND, matching every other export in this app: the OOXML
      // writer is only needed by the person who actually clicks Export, and
      // every kilobyte in the main bundle is paid for by a customer on a
      // Nigerian mobile connection.
      const [{ buildPurchaseOrdersXlsx }, { downloadBytes, XLSX_MIME }] = await Promise.all([
        import('../../../lib/export/purchasingXlsx'),
        import('../../../lib/export/download'),
      ]);
      const bytes = buildPurchaseOrdersXlsx(all, currency, todayIsoInZone(timezone));
      downloadBytes(bytes, 'purchase-orders.xlsx', XLSX_MIME);
    } catch (e) {
      toast.error(describeError(e));
    } finally {
      setExporting(false);
    }
  }

  const filtered = hasPurchaseFilters(filters);

  return (
    <div className="space-y-4">
      <ScreenHeader
        title="Purchases"
        purpose="What this hotel has ordered, and what is still to come."
        about={{
          title: PURCHASES_ABOUT_TITLE,
          paragraphs: PURCHASES_ABOUT,
          guideAnchor: 'purchase-orders',
          guideLabel: 'Purchase orders',
        }}
        propertySlug={propertySlug}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={exportAll}
              disabled={exporting || count === 0}
              className="rounded-full border border-sand-border px-4 py-2.5 text-sm font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
            >
              {exporting ? 'Exporting…' : 'Export'}
            </button>
            <Link
              to={`/admin/${propertySlug}/purchases/new`}
              className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-primary-hover focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream focus-visible:outline-none"
            >
              <PlusIcon className="h-4 w-4" />
              New order
            </Link>
          </div>
        }
      />

      <PurchaseSummaryCard summary={summary} currency={currency} />

      <div className="grid gap-3 rounded-2xl border border-sand-border bg-white/60 p-4 sm:grid-cols-2 lg:grid-cols-5">
        <TextField
          label="Search"
          value={filters.search}
          onChange={(v) => narrow({ search: v })}
          placeholder="Order number or supplier"
        />
        {/* SERVER-SEARCHED (rule 26), and a FILTER — so it does not pass
            activeOnly: an order raised against a supplier since switched off is
            still an order, and a picker that omitted them would make that
            history unreachable. */}
        <SupplierPicker
          tenantId={tenantId}
          value={filters.supplierId}
          onChange={(v) => narrow({ supplierId: v })}
          activeOnly={false}
          clearable
          placeholder="Every supplier"
        />
        <Select
          label="State"
          value={filters.state}
          onChange={(v) => narrow({ state: v as PurchaseFilters['state'] })}
          options={[
            { value: 'open', label: 'Still open' },
            { value: '', label: 'Every order' },
            { value: 'draft', label: 'Drafts' },
            { value: 'ordered', label: 'Sent' },
            { value: 'part_received', label: 'Partly delivered' },
            { value: 'received', label: 'Complete' },
            { value: 'cancelled', label: 'Cancelled' },
          ]}
        />
        <DateField
          label="From"
          value={filters.fromDate}
          onChange={(v) => narrow({ fromDate: v })}
          helpText="The day the order was raised."
        />
        <DateField
          label="To"
          value={filters.toDate}
          onChange={(v) => narrow({ toDate: v })}
        />
        {filtered ? (
          <div className="flex items-end">
            <button
              type="button"
              onClick={() => {
                setFilters(EMPTY_PURCHASE_FILTERS);
                setPage(1);
              }}
              className="rounded-lg px-3 py-2 text-sm font-semibold text-charcoal-muted transition-colors hover:text-charcoal focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream focus-visible:outline-none"
            >
              Clear filters
            </button>
          </div>
        ) : null}
      </div>

      {error ? (
        <div className="rounded-2xl border border-sand-border bg-white/60 p-6 text-center">
          <p className="text-sm font-medium text-charcoal">
            The purchase orders could not be loaded.
          </p>
          <p className="mt-1 text-sm text-charcoal-muted">{error}</p>
        </div>
      ) : (
        <div className="space-y-4 rounded-2xl border border-sand-border bg-white/60 p-4">
          {loading && rows.length === 0 ? (
            <p className="py-8 text-center text-sm text-charcoal-muted">Loading…</p>
          ) : rows.length === 0 ? (
            <p className="py-8 text-center text-sm text-charcoal-muted">
              {filtered ? NO_ORDERS_MATCH : NO_ORDERS_YET}
            </p>
          ) : (
            <PurchaseOrderTable
              rows={rows}
              currency={currency}
              propertySlug={propertySlug}
              today={todayIsoInZone(timezone)}
            />
          )}

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
            itemNoun="orders"
          />
        </div>
      )}
    </div>
  );
}

// EXPORTED for the render proof (rule 22) — the proof renders the component the
// screen runs, not a copy of its markup.
export function PurchaseSummaryCard({
  summary,
  currency,
}: {
  summary: PurchaseSummary | null;
  currency: string;
}) {
  const money = (v: number | undefined) =>
    v === undefined ? MISSING_VALUE : formatMoney(v, currency);

  return (
    <div className="grid gap-3 rounded-2xl border border-sand-border bg-white/60 p-4 sm:grid-cols-2 lg:grid-cols-4">
      <Tile
        label="Still open"
        value={summary ? String(summary.openCount) : MISSING_VALUE}
        note={OPEN_COUNT_NOTE}
      />
      <Tile
        label="Ordered value"
        value={money(summary?.orderedValue)}
        note={ORDERED_VALUE_NOTE}
      />
      <Tile
        label="Received value"
        value={money(summary?.receivedValue)}
        note={RECEIVED_VALUE_NOTE}
      />
      <Tile
        label="Still outstanding"
        value={money(summary?.outstandingValue)}
        note={OUTSTANDING_VALUE_NOTE}
      />
    </div>
  );
}

function Tile({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note: string;
}) {
  return (
    <div>
      <div className="flex items-center gap-1.5">
        <span className="text-xs font-medium text-charcoal-muted">{label}</span>
        {/* Rule 16's per-figure note. A different affordance from the screen's
            ⓘ and a different job: that one is about the screen, this one is
            about this number. */}
        <CalculationNote note={note} />
      </div>
      <p className="mt-0.5 text-lg font-semibold tabular-nums text-charcoal">
        {value}
      </p>
    </div>
  );
}

export function PurchaseOrderTable({
  rows,
  currency,
  propertySlug,
  today,
}: {
  rows: PurchaseOrderSummary[];
  currency: string;
  propertySlug: string;
  // The property's own today, for the late test. Passed in rather than read from
  // the clock here so the proof can render a deterministic screen.
  today: string;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[54rem] text-sm">
        <thead>
          <tr className="border-b border-sand-border text-left text-xs font-medium text-charcoal-muted">
            <th className="py-2 pr-3">Order</th>
            <th className="py-2 pr-3">Raised</th>
            <th className="py-2 pr-3">Expected</th>
            <th className="py-2 pr-3">Supplier</th>
            <th className="py-2 pr-3">Going to</th>
            <th className="py-2 pr-3">Status</th>
            <th className="py-2 pr-3 text-right">Ordered</th>
            <th className="py-2 pr-3 text-right">Arrived</th>
            <th className="py-2 text-right">Outstanding</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            // A LIVE CONSEQUENCE, not teaching (rule 25): shown only when the
            // promised date has passed with something still outstanding.
            const late =
              row.is_open &&
              row.expected_date !== null &&
              row.expected_date < today;
            return (
              <tr
                key={row.id}
                className="border-b border-sand-border/60 last:border-0"
              >
                <td className="py-2 pr-3">
                  <Link
                    to={`/admin/${propertySlug}/purchases/${row.id}`}
                    className="font-medium text-charcoal underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none"
                  >
                    {row.order_number}
                  </Link>
                </td>
                <td className="py-2 pr-3 text-charcoal-muted">
                  {formatDisplayDate(row.order_date)}
                </td>
                <td className="py-2 pr-3 text-charcoal-muted">
                  {row.expected_date
                    ? formatDisplayDate(row.expected_date)
                    : MISSING_VALUE}
                  {late ? (
                    <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-900">
                      Late
                    </span>
                  ) : null}
                </td>
                <td className="py-2 pr-3 text-charcoal">{row.supplier_name}</td>
                <td className="py-2 pr-3 text-charcoal-muted">
                  {row.destination_name}
                </td>
                <td className="py-2 pr-3">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-semibold ${purchaseStatusTone(row.status)}`}
                  >
                    {purchaseStatusLabel(row.status)}
                  </span>
                </td>
                <td className="py-2 pr-3 text-right tabular-nums text-charcoal">
                  {formatMoney(row.ordered_value, currency)}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums text-charcoal">
                  {formatMoney(row.received_value, currency)}
                </td>
                <td className="py-2 text-right tabular-nums text-charcoal">
                  {formatMoney(row.outstanding_value, currency)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
