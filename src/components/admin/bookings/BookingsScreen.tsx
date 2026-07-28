import { useEffect, useState } from 'react';
import { Pagination } from '../../ui/Pagination';
import { PlusIcon } from '../../ui/icons';
import { useBookings } from '../../../hooks/useBookings';
import { useBookingDraft } from '../../../hooks/useBookingDraft';
import { describeError } from '../../../lib/errors';
import { formatCurrency, formatOccupancy, MISSING_VALUE } from '../../../lib/format';
import { formatDisplayDate, nightsBetween } from '../../../lib/date';
import { bookingTotal } from '../../../lib/bookings';
import { fetchAllCompanies } from '../../../lib/companies';
import {
  bookingStatusLabel,
  bookingStatusTone,
  formatNights,
} from '../../../lib/bookingLabels';
import type { Company } from '../../../types/company';
import type { BookingListRow } from '../../../types/booking';
import { BookingFilters } from './BookingFilters';
import { BookingStatusSummary } from './BookingStatusSummary';
import { CreateBookingDialog } from './CreateBookingDialog';
import { BookingDetailPanel } from './BookingDetailPanel';

// The bookings screen (build 6b §3). Replaces the "coming soon" placeholder:
//   - a filtered, server-paginated list, newest arrival first (rule 1b),
//   - a status summary across the WHOLE filtered set (rule 20) with a how-it-was-
//     calculated note (rule 16),
//   - a create flow (CreateBookingDialog) that goes through create_booking only,
//   - a manage view (BookingDetailPanel) for the per-night breakdown, cancel and
//     status transitions.
//
// Reads scoped to the active property + tenant in the data layer (rule 19).

interface BookingsScreenProps {
  propertyId: string;
  tenantId: string;
  currency: string;
}

export function BookingsScreen({
  propertyId,
  tenantId,
  currency,
}: BookingsScreenProps) {
  const list = useBookings(tenantId, propertyId);

  // Companies for the filter dropdown (all live, incl. dormant, so a filter can
  // still reach past accounts). Bounded fetch (rule 1a).
  const [companies, setCompanies] = useState<Company[]>([]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const rows = await fetchAllCompanies(tenantId, false);
        if (!cancelled) setCompanies(rows);
      } catch {
        // A companies failure only affects the filter dropdown; the list still works.
        if (!cancelled) setCompanies([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tenantId]);

  // The create-booking form lives in the session-scoped draft (above the routes),
  // so it survives navigating to another admin screen and back — scoped to THIS
  // property (useBookingDraft keys by propertyId). Whether the dialog is open is
  // part of the draft; opening/closing/clearing all go through this hook.
  const { draft, update, clear, open } = useBookingDraft(propertyId);
  const [manageId, setManageId] = useState<string | null>(null);

  return (
    <div className="mx-auto max-w-4xl">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-charcoal">
            Bookings
          </h1>
          <p className="mt-1 text-sm text-charcoal-muted">
            Reservations for this property. Create a booking, manage its
            lifecycle, and see what each stay is worth.
          </p>
        </div>
        <button
          type="button"
          onClick={open}
          className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream"
        >
          <PlusIcon className="h-4 w-4" />
          New booking
        </button>
      </header>

      <div className="mb-5 space-y-4">
        <BookingStatusSummary
          summary={list.summary}
          loading={list.summaryLoading}
          currency={currency}
        />
        <BookingFilters
          filters={list.filters}
          companies={companies}
          onChange={list.setFilters}
          disabled={list.loading}
        />
      </div>

      {list.error ? (
        <ErrorState
          message={describeError(list.error)}
          onRetry={() => void list.reload()}
        />
      ) : list.loading && list.rows.length === 0 ? (
        <LoadingState />
      ) : list.rows.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          <ul className="space-y-2">
            {list.rows.map((row) => (
              <li key={row.id}>
                <BookingRow
                  row={row}
                  currency={currency}
                  onOpen={() => setManageId(row.id)}
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
              disabled={list.loading}
              itemNoun="bookings"
            />
          </div>
        </>
      )}

      {draft.open ? (
        <CreateBookingDialog
          tenantId={tenantId}
          propertyId={propertyId}
          currency={currency}
          draft={draft}
          update={update}
          // Cancel/close clears the draft (a fresh start next time). Navigating
          // away does NOT call this — it just leaves the draft in place.
          onClose={clear}
          onCreated={() => {
            // A successful submission clears the draft.
            clear();
            void list.reload();
          }}
        />
      ) : null}

      {manageId ? (
        <BookingDetailPanel
          bookingId={manageId}
          tenantId={tenantId}
          propertyId={propertyId}
          currency={currency}
          onClose={() => setManageId(null)}
          onChanged={() => void list.reload()}
        />
      ) : null}
    </div>
  );
}

function BookingRow({
  row,
  currency,
  onOpen,
}: {
  row: BookingListRow;
  currency: string;
  onOpen: () => void;
}) {
  const nights = nightsBetween(row.check_in, row.check_out);
  const total = bookingTotal(row.booking_nights);

  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full flex-col gap-3 rounded-xl border border-sand-border bg-white/60 p-4 text-left transition-colors hover:bg-sand/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold text-charcoal">
            {row.guest?.full_name ?? MISSING_VALUE}
          </span>
          <span
            className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${bookingStatusTone(row.status)}`}
          >
            {bookingStatusLabel(row.status)}
          </span>
          {row.company ? (
            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary">
              {row.company.name}
            </span>
          ) : null}
        </div>
        <p className="mt-1 text-xs text-charcoal-muted">
          {row.booking_number} · {row.room_type?.name ?? MISSING_VALUE} ·{' '}
          {formatOccupancy(row.adults, row.children)}
        </p>
        <p className="mt-0.5 text-xs text-charcoal-muted">
          {formatDisplayDate(row.check_in)} → {formatDisplayDate(row.check_out)} ·{' '}
          {formatNights(nights)}
        </p>
      </div>
      <div className="shrink-0 text-right">
        <p className="text-xs text-charcoal-muted">Total</p>
        <p className="text-base font-bold text-charcoal">
          {formatCurrency(total, currency)}
        </p>
      </div>
    </button>
  );
}

function LoadingState() {
  return (
    <div
      className="flex items-center justify-center rounded-2xl border border-sand-border bg-white/60 py-16"
      aria-busy="true"
      aria-live="polite"
    >
      <span className="sr-only">Loading bookings…</span>
      <span className="h-7 w-7 animate-spin rounded-full border-2 border-sand-border border-t-primary" />
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded-2xl border border-dashed border-sand-border bg-white/40 px-6 py-12 text-center">
      <p className="text-base font-semibold text-charcoal">No bookings found</p>
      <p className="mx-auto mt-1 max-w-md text-sm text-charcoal-muted">
        No reservations match the current filter. Clear the filter, or create a
        new booking.
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
        We couldn’t load bookings.
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
