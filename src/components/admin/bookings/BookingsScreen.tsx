import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Pagination } from '../../ui/Pagination';
import { PlusIcon } from '../../ui/icons';
import { useBookings } from '../../../hooks/useBookings';
import { useBookingDraft } from '../../../hooks/useBookingDraft';
import { describeError } from '../../../lib/errors';
import { fetchAllCompanies } from '../../../lib/companies';
import { fetchAllRoomTypes } from '../../../lib/roomTypes';
import type { Company } from '../../../types/company';
import type { RoomType } from '../../../types/room';
import { BookingsTable } from './BookingsTable';
import { BookingStatusSummary } from './BookingStatusSummary';
import { CreateBookingDialog } from './CreateBookingDialog';

// The bookings screen (build 6b §3; table redesign per brief 1.txt §2). A dense,
// server-paginated DATA TABLE (BookingsTable) whose column headers carry the
// filtering inline — the standalone filter panel is gone. Above it sits a compact
// inline summary across the WHOLE filtered set (rule 20) with a how-it-was-
// calculated note (rule 16); below it the shared Pagination control (rule 1b).
// Create goes through create_booking only (CreateBookingDialog); a row click
// NAVIGATES to that booking's own page (build A §1) — the old inline detail panel
// is gone, so the detail can be linked to, refreshed into and shared.
//
// Reads scoped to the active property + tenant in the data layer (rule 19).

interface BookingsScreenProps {
  propertyId: string;
  tenantId: string;
  // The property's slug — the detail route lives under it
  // (/admin/:propertySlug/bookings/:bookingId), so a row click navigates rather
  // than opening a panel (build A §1).
  propertySlug: string;
  // The property's IANA timezone — passed to the create dialog so the check-in
  // date input's min is the PROPERTY's today (matches the RPC guard, migration 020).
  timezone: string;
  currency: string;
}

export function BookingsScreen({
  propertyId,
  tenantId,
  propertySlug,
  timezone,
  currency,
}: BookingsScreenProps) {
  const list = useBookings(tenantId, propertyId);
  const navigate = useNavigate();

  // Companies + room types for the header-filter dropdowns. Both bounded fetches
  // (rule 1a). Companies: all live incl. dormant, so a filter can still reach past
  // accounts. Room types: every live type (fetchAllRoomTypes).
  const [companies, setCompanies] = useState<Company[]>([]);
  const [roomTypes, setRoomTypes] = useState<RoomType[]>([]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [comps, types] = await Promise.all([
          fetchAllCompanies(tenantId, false),
          fetchAllRoomTypes(propertyId, tenantId),
        ]);
        if (cancelled) return;
        setCompanies(comps);
        setRoomTypes(types);
      } catch {
        // A lookup failure only affects the header filter dropdowns; the list still
        // works, so degrade to empty option lists rather than blanking the screen.
        if (!cancelled) {
          setCompanies([]);
          setRoomTypes([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tenantId, propertyId]);

  // The create-booking form lives in the session-scoped draft (above the routes),
  // so it survives navigating to another admin screen and back — scoped to THIS
  // property (useBookingDraft keys by propertyId). Whether the dialog is open is
  // part of the draft; opening/closing/clearing all go through this hook.
  const { draft, update, clear, open } = useBookingDraft(propertyId);

  return (
    <div className="mx-auto max-w-6xl">
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

      {list.error ? (
        <ErrorState
          message={describeError(list.error)}
          onRetry={() => void list.reload()}
        />
      ) : (
        <>
          <div className="mb-4">
            <BookingStatusSummary
              summary={list.summary}
              loading={list.summaryLoading}
              currency={currency}
            />
          </div>

          {/* The table is ALWAYS mounted (never swapped out for a loading/empty
              card), so its header filters stay visible and keep focus across
              reloads; loading/empty states render inside the table body. */}
          <BookingsTable
            rows={list.rows}
            filters={list.filters}
            onFiltersChange={list.setFilters}
            companies={companies}
            roomTypes={roomTypes}
            currency={currency}
            loading={list.loading}
            // A row is a link to the booking's own page now — the inline detail
            // panel is gone (build A §1).
            onOpenRow={(id) => navigate(`/admin/${propertySlug}/bookings/${id}`)}
          />

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
          timezone={timezone}
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
