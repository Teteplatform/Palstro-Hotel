import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Pagination } from '../../ui/Pagination';
import { PlusIcon } from '../../ui/icons';
import { useBookings } from '../../../hooks/useBookings';
import { describeError } from '../../../lib/errors';
import { fetchAllCompanies } from '../../../lib/companies';
import { fetchAllRoomTypes } from '../../../lib/roomTypes';
import type { Company } from '../../../types/company';
import type { RoomType } from '../../../types/room';
import { FollowUpNotices } from '../FollowUpNotices';
import { BookingsTable } from './BookingsTable';
import { BookingStatusSummary } from './BookingStatusSummary';

// The bookings screen (build 6b §3; table redesign per brief 1.txt §2). A dense,
// server-paginated DATA TABLE (BookingsTable) whose column headers carry the
// filtering inline — the standalone filter panel is gone. Above it sits a compact
// inline summary across the WHOLE filtered set (rule 20) with a how-it-was-
// calculated note (rule 16); below it the shared Pagination control (rule 1b).
//
// BOTH directions off this screen are now ROUTES, not panels: "New booking"
// navigates to /bookings/new (build B §1) and a row click to that booking's own
// page (build A §1). Neither is a modal any more, so both can be linked to,
// refreshed into and shared — and this screen holds no create state at all. The
// half-filled booking still survives leaving and returning because the draft
// lives in BookingDraftProvider above the routes, which is untouched.
//
// Reads scoped to the active property + tenant in the data layer (rule 19).

interface BookingsScreenProps {
  propertyId: string;
  tenantId: string;
  // The property's slug — both routes off this screen live under it
  // (/admin/:propertySlug/bookings/new and /bookings/:bookingId), so creating a
  // booking and opening one both navigate rather than open a panel.
  propertySlug: string;
  currency: string;
}

export function BookingsScreen({
  propertyId,
  tenantId,
  propertySlug,
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
        {/* A route, not a dialog (build B §1). An in-progress draft is picked up
            by that page, so this is "go back to what I was filling in" as much
            as "start a new one". */}
        <Link
          to={`/admin/${propertySlug}/bookings/new`}
          className="inline-flex min-h-11 items-center gap-2 rounded-full bg-primary px-5 text-sm font-semibold text-white transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream"
        >
          <PlusIcon className="h-4 w-4" />
          New booking
        </Link>
      </header>

      {list.error ? (
        <ErrorState
          message={describeError(list.error)}
          onRetry={() => void list.reload()}
        />
      ) : (
        <>
          {/* THE NIGHT AUDIT'S FOLLOW-UPS (029), property-wide. A corporate
              booking it no-showed and charged has had its room released, and the
              desk is asked to call the company before that room goes to somebody
              else. It renders nothing at all when there is nothing outstanding,
              so a healthy property sees no extra chrome. */}
          <div className="mb-4">
            <FollowUpNotices tenantId={tenantId} propertyId={propertyId} />
          </div>

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
            // A ROW OPENS THE GUEST, NOT THE STAY (build 2 §1). THE GUEST IS THE
            // HUB: the front desk almost never wants one reservation in
            // isolation — they want the person standing in front of them, all
            // their stays and what they owe across the lot. Landing on a single
            // stay meant reading one row of a story and then navigating back out
            // to find the rest. The stay is still one click further in, from the
            // guest's own stays table, which is where it belongs.
            //
            // This list stays exactly as it was otherwise: it is the "everyone"
            // view and the entry point, and a hotel will accumulate thousands of
            // bookings over years — which is what the server-side pager is for.
            onOpenRow={(row) =>
              navigate(`/admin/${propertySlug}/guests/${row.guest_id}`)
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
              itemNoun="bookings"
            />
          </div>
        </>
      )}

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
