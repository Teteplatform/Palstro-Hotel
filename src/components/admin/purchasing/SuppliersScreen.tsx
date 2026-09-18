import { useEffect, useState } from 'react';
import { Pagination } from '../../ui/Pagination';
import { ScreenHeader } from '../../ui/ScreenHeader';
import { ActionMenu } from '../../ui/ActionMenu';
import { PlusIcon } from '../../ui/icons';
import { Select, TextField } from '../../ui/form';
import { useToast } from '../../ui/Toast';
import { describeError, humanizeError } from '../../../lib/errors';
import { todayIsoInZone } from '../../../lib/date';
import { MISSING_VALUE } from '../../../lib/format';
import {
  EMPTY_SUPPLIER_FILTERS,
  fetchSuppliersForExport,
  fetchSuppliersPage,
  hasSupplierFilters,
  softDeleteSupplier,
  type SupplierFilters,
} from '../../../lib/suppliers';
import {
  NO_SUPPLIERS_MATCH,
  NO_SUPPLIERS_YET,
  SUPPLIERS_ABOUT,
  SUPPLIERS_ABOUT_TITLE,
} from '../../../lib/purchasingLabels';
import type { Supplier } from '../../../types/purchasing';
import { SupplierForm } from './SupplierForm';
import { SupplierActivityPanel } from './SupplierActivityPanel';

// SUPPLIERS — the address book, and the activity view (the brief's second
// screen, sitting beside Purchases in the sidebar).
//
// ---------------------------------------------------------------------------
// A FULL LIST SURFACE (rule 1b), INCLUDING THE PARTS THAT LOOK OPTIONAL
// ---------------------------------------------------------------------------
// Server-side paging with an exact count, an always-visible page-of-N, jump to
// first and last, direct page entry, a page-size selector, and filters applied
// SERVER-side so paging a filtered set is correct rather than paging then
// filtering. A hotel will have a dozen suppliers on the day it goes live, which
// is exactly the argument that produced the ERP bug this rule exists for: the
// cap was harmless when it was added and older records vanished off the end two
// years later, silently.
//
// THERE IS NO SUMMARY CARD, and that is not an omission of rule 20. Rule 20 is
// about a FIGURE beside a list being computed across the filter rather than the
// page; the only figure this list has is how many suppliers match, and the
// pager's "showing 1-25 of 214" already says that across the whole filter.
// Inventing a money total here would mean inventing a supplier balance, which is
// precisely what this shipment must not do.

interface SuppliersScreenProps {
  tenantId: string;
  propertyId: string;
  propertySlug: string;
  currency: string;
  timezone: string;
}

export function SuppliersScreen({
  tenantId,
  propertyId,
  propertySlug,
  currency,
  timezone,
}: SuppliersScreenProps) {
  const toast = useToast();

  const [rows, setRows] = useState<Supplier[]>([]);
  const [count, setCount] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [filters, setFilters] = useState<SupplierFilters>(EMPTY_SUPPLIER_FILTERS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [exporting, setExporting] = useState(false);

  // ONE value rather than three booleans: three booleans can all be true, and
  // "adding and editing and viewing at once" is a state nobody meant.
  const [pane, setPane] = useState<
    | { kind: 'none' }
    | { kind: 'new' }
    | { kind: 'edit'; supplier: Supplier }
    | { kind: 'activity'; supplier: Supplier }
  >({ kind: 'none' });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const result = await fetchSuppliersPage(tenantId, page, pageSize, filters);
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
  }, [tenantId, page, pageSize, filters, refreshToken]);

  function narrow(next: Partial<SupplierFilters>) {
    setFilters((prev) => ({ ...prev, ...next }));
    setPage(1); // filter then page, never the other way round (rule 1b)
  }

  async function exportAll() {
    if (exporting) return;
    setExporting(true);
    try {
      // THE WHOLE FILTERED SET, across all pages (rule 20).
      const all = await fetchSuppliersForExport(tenantId, filters);
      // LOADED ON DEMAND, matching every other export in this app: the OOXML
      // writer is only needed by the person who actually clicks Export, and
      // every kilobyte in the main bundle is paid for by a customer on a
      // Nigerian mobile connection.
      const [{ buildSuppliersXlsx }, { downloadBytes, XLSX_MIME }] = await Promise.all([
        import('../../../lib/export/purchasingXlsx'),
        import('../../../lib/export/download'),
      ]);
      const bytes = buildSuppliersXlsx(all, currency, todayIsoInZone(timezone));
      downloadBytes(bytes, 'suppliers.xlsx', XLSX_MIME);
    } catch (e) {
      toast.error(describeError(e));
    } finally {
      setExporting(false);
    }
  }

  async function retire(supplier: Supplier) {
    try {
      await softDeleteSupplier(supplier.id);
      toast.success(`${supplier.name} removed.`);
      setPane({ kind: 'none' });
      setRefreshToken((n) => n + 1);
    } catch (e) {
      toast.error(humanizeError(e));
    }
  }

  const filtered = hasSupplierFilters(filters);

  return (
    <div className="space-y-4">
      <ScreenHeader
        title="Suppliers"
        purpose="Who this hotel buys from, and how they are paid."
        about={{
          title: SUPPLIERS_ABOUT_TITLE,
          paragraphs: SUPPLIERS_ABOUT,
          guideAnchor: 'suppliers',
          guideLabel: 'Suppliers',
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
            <button
              type="button"
              onClick={() => setPane({ kind: 'new' })}
              className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-primary-hover focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream focus-visible:outline-none"
            >
              <PlusIcon className="h-4 w-4" />
              New supplier
            </button>
          </div>
        }
      />

      {pane.kind === 'new' ? (
        <SupplierForm
          tenantId={tenantId}
          supplier={null}
          onDone={() => {
            setPane({ kind: 'none' });
            setRefreshToken((n) => n + 1);
          }}
          onCancel={() => setPane({ kind: 'none' })}
        />
      ) : null}

      {pane.kind === 'edit' ? (
        <SupplierForm
          tenantId={tenantId}
          supplier={pane.supplier}
          onDone={() => {
            setPane({ kind: 'none' });
            setRefreshToken((n) => n + 1);
          }}
          onCancel={() => setPane({ kind: 'none' })}
        />
      ) : null}

      {pane.kind === 'activity' ? (
        <SupplierActivityPanel
          tenantId={tenantId}
          propertyId={propertyId}
          propertySlug={propertySlug}
          currency={currency}
          supplier={pane.supplier}
        />
      ) : null}

      <div className="grid gap-3 rounded-2xl border border-sand-border bg-white/60 p-4 sm:grid-cols-2 lg:grid-cols-4">
        <TextField
          label="Search"
          value={filters.search}
          onChange={(v) => narrow({ search: v })}
          placeholder="Name, code, contact or phone"
        />
        <Select
          label="In use"
          value={filters.state}
          onChange={(v) => narrow({ state: v as SupplierFilters['state'] })}
          options={[
            { value: '', label: 'Every supplier' },
            { value: 'active', label: 'In use' },
            { value: 'inactive', label: 'Switched off' },
          ]}
        />
        {filtered ? (
          <div className="flex items-end">
            <button
              type="button"
              onClick={() => {
                setFilters(EMPTY_SUPPLIER_FILTERS);
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
            The supplier list could not be loaded.
          </p>
          <p className="mt-1 text-sm text-charcoal-muted">{error}</p>
        </div>
      ) : (
        <div className="space-y-4 rounded-2xl border border-sand-border bg-white/60 p-4">
          {loading && rows.length === 0 ? (
            <p className="py-8 text-center text-sm text-charcoal-muted">Loading…</p>
          ) : rows.length === 0 ? (
            <p className="py-8 text-center text-sm text-charcoal-muted">
              {filtered ? NO_SUPPLIERS_MATCH : NO_SUPPLIERS_YET}
            </p>
          ) : (
            <SupplierTable
              rows={rows}
              onView={(s) => setPane({ kind: 'activity', supplier: s })}
              onEdit={(s) => setPane({ kind: 'edit', supplier: s })}
              onRetire={retire}
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
            itemNoun="suppliers"
          />
        </div>
      )}
    </div>
  );
}

// EXPORTED, because that is the seam a render proof needs (rule 22): the proof
// renders THIS, the component the screen runs, rather than a copy of its markup.
export function SupplierTable({
  rows,
  onView,
  onEdit,
  onRetire,
}: {
  rows: Supplier[];
  onView: (s: Supplier) => void;
  onEdit: (s: Supplier) => void;
  onRetire: (s: Supplier) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[44rem] text-sm">
        <thead>
          <tr className="border-b border-sand-border text-left text-xs font-medium text-charcoal-muted">
            <th className="py-2 pr-3">Supplier</th>
            <th className="py-2 pr-3">Contact</th>
            <th className="py-2 pr-3">Phone</th>
            <th className="py-2 pr-3">TIN</th>
            <th className="py-2 pr-3">Bank</th>
            <th className="py-2 pr-3">In use</th>
            <th className="w-10 py-2" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.id}
              className="border-b border-sand-border/60 last:border-0"
            >
              <td className="py-2 pr-3">
                <button
                  type="button"
                  onClick={() => onView(row)}
                  className="text-left font-medium text-charcoal underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none"
                >
                  {row.name}
                </button>
                {row.code ? (
                  <span className="ml-2 text-xs text-charcoal-muted">{row.code}</span>
                ) : null}
              </td>
              <td className="py-2 pr-3 text-charcoal-muted">
                {row.contact_name ?? MISSING_VALUE}
              </td>
              <td className="py-2 pr-3 text-charcoal-muted">
                {row.phone ?? MISSING_VALUE}
              </td>
              <td className="py-2 pr-3 text-charcoal-muted">
                {row.tax_id ?? MISSING_VALUE}
              </td>
              <td className="py-2 pr-3 text-charcoal-muted">
                {row.bank_name ?? MISSING_VALUE}
              </td>
              <td className="py-2 pr-3">
                {row.is_active ? (
                  <span className="text-charcoal">Yes</span>
                ) : (
                  <span className="text-charcoal-muted">Off</span>
                )}
              </td>
              <td className="py-2">
                {/* PORTALLED (rule 23), so the last row's menu is reachable at
                    1366x768 and at 360px rather than being cut in half by this
                    table's overflow-x wrapper. */}
                <ActionMenu
                  label={`Actions for ${row.name}`}
                  items={[
                    {
                      key: 'activity',
                      label: 'Orders and deliveries',
                      hint: 'What this hotel has ordered from them.',
                      onSelect: () => onView(row),
                    },
                    {
                      key: 'edit',
                      label: 'Edit',
                      onSelect: () => onEdit(row),
                    },
                    {
                      key: 'retire',
                      label: 'Remove',
                      hint: 'Their orders stay on the record.',
                      tone: 'danger',
                      onSelect: () => onRetire(row),
                    },
                  ]}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
