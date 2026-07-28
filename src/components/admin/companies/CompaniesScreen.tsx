import { useEffect, useState } from 'react';
import { useToast } from '../../ui/Toast';
import { Pagination } from '../../ui/Pagination';
import { useCompanies } from '../../../hooks/useCompanies';
import { humanizeError } from '../../../lib/errors';
import { softDeleteCompany } from '../../../lib/companies';
import { fetchAllRoomTypes } from '../../../lib/roomTypes';
import type { Company } from '../../../types/company';
import type { RoomType } from '../../../types/room';
import { CreateCompany } from './CreateCompany';
import { CompanyEditor } from './CompanyEditor';

// The companies admin screen (build 6b §2). A paginated list of corporate
// accounts (rule 1b), each expandable to edit its details and manage its
// negotiated rates (one per room type) with a live rack-vs-company preview.
//
// Reads are scoped to the active tenant/property in the data layer (rule 19);
// every write is awaited in try/catch with the error surfaced (rule 11). Company
// pricing is never public (§4) — these screens are admin-only.

interface CompaniesScreenProps {
  propertyId: string;
  tenantId: string;
  currency: string;
}

export function CompaniesScreen({
  propertyId,
  tenantId,
  currency,
}: CompaniesScreenProps) {
  const toast = useToast();
  const list = useCompanies(tenantId);

  // The property's room types, loaded once for the whole screen (the rates
  // editor and preview both need them). fetchAllRoomTypes is bounded (rule 1a).
  const [roomTypes, setRoomTypes] = useState<RoomType[]>([]);
  const [roomTypesError, setRoomTypesError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const rows = await fetchAllRoomTypes(propertyId, tenantId);
        if (!cancelled) setRoomTypes(rows);
      } catch (e) {
        if (!cancelled) setRoomTypesError(humanizeError(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [propertyId, tenantId]);

  // Local mirror of the current page's rows so a single-row save reflects
  // instantly without a refetch collapsing open cards (matching RoomTypesScreen).
  const [items, setItems] = useState<Company[]>(list.rows);
  const [lastRows, setLastRows] = useState(list.rows);
  if (list.rows !== lastRows) {
    setLastRows(list.rows);
    setItems(list.rows);
  }

  const [rowBusy, setRowBusy] = useState(false);
  // A local draft of the name filter so typing does not refetch on every stroke;
  // committed on submit / Enter.
  const [filterDraft, setFilterDraft] = useState('');

  function handleUpdated(row: Company) {
    setItems((prev) => prev.map((c) => (c.id === row.id ? row : c)));
  }

  function handleCreated() {
    // A new company sorts by name, so its page is not predictable; reload the
    // current page and clear any filter that might hide it.
    void list.reload();
  }

  async function handleRequestDelete(company: Company) {
    if (
      !window.confirm(
        `Remove "${company.name}"? Its negotiated rates and any bookings against it are kept, but it leaves this list and new bookings.`,
      )
    ) {
      return;
    }
    setRowBusy(true);
    try {
      await softDeleteCompany(company.id, tenantId);
      toast.success('Company removed.');
      await list.reload();
    } catch (e) {
      toast.error(humanizeError(e));
    } finally {
      setRowBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <header className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight text-charcoal">
          Companies
        </h1>
        <p className="mt-1 text-sm text-charcoal-muted">
          Corporate accounts you bill, and the nightly rate you’ve negotiated with
          each — a fixed price, or a percentage off rack. A booking billed to a
          company locks that rate per night.
        </p>
      </header>

      {roomTypesError ? (
        <p className="mb-4 rounded-xl border border-sand-border bg-white/60 p-3 text-sm text-charcoal-muted">
          Room types could not load, so rate editing is unavailable: {roomTypesError}
        </p>
      ) : null}

      {/* Name filter (server-side, rule 1b) */}
      <form
        className="mb-4 flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          list.setNameFilter(filterDraft);
        }}
      >
        <label className="flex-1 min-w-[12rem]">
          <span className="mb-1 block text-sm font-medium text-charcoal">
            Search companies
          </span>
          <input
            type="text"
            value={filterDraft}
            onChange={(e) => setFilterDraft(e.target.value)}
            placeholder="Name…"
            className="w-full rounded-lg border border-sand-border bg-white/70 px-3 py-2 text-sm text-charcoal transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream"
          />
        </label>
        <button
          type="submit"
          className="rounded-lg border border-sand-border bg-white/70 px-4 py-2 text-sm font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream"
        >
          Search
        </button>
        {list.nameFilter ? (
          <button
            type="button"
            onClick={() => {
              setFilterDraft('');
              list.setNameFilter('');
            }}
            className="rounded-lg px-3 py-2 text-sm font-semibold text-charcoal-muted transition-colors hover:text-charcoal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream"
          >
            Clear
          </button>
        ) : null}
      </form>

      <div className="mb-6">
        <CreateCompany tenantId={tenantId} onCreated={handleCreated} />
      </div>

      {list.error ? (
        <ErrorState
          message={list.error.message}
          onRetry={() => void list.reload()}
        />
      ) : list.loading && items.length === 0 ? (
        <LoadingState />
      ) : items.length === 0 ? (
        <EmptyState filtered={Boolean(list.nameFilter)} />
      ) : (
        <>
          <ul className="space-y-3">
            {items.map((company) => (
              <li key={company.id}>
                <CompanyEditor
                  company={company}
                  tenantId={tenantId}
                  propertyId={propertyId}
                  currency={currency}
                  roomTypes={roomTypes}
                  onUpdated={handleUpdated}
                  onRequestDelete={(c) => void handleRequestDelete(c)}
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
              itemNoun="companies"
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
      <span className="sr-only">Loading companies…</span>
      <span className="h-7 w-7 animate-spin rounded-full border-2 border-sand-border border-t-primary" />
    </div>
  );
}

function EmptyState({ filtered }: { filtered: boolean }) {
  return (
    <div className="rounded-2xl border border-dashed border-sand-border bg-white/40 px-6 py-12 text-center">
      <p className="text-base font-semibold text-charcoal">
        {filtered ? 'No companies match your search' : 'No companies yet'}
      </p>
      <p className="mx-auto mt-1 max-w-md text-sm text-charcoal-muted">
        {filtered
          ? 'Try a different name, or clear the search.'
          : 'Add your first corporate account above, then set its negotiated rate for each room type.'}
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
        We couldn’t load your companies.
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
