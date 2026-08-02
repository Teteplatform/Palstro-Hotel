import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeftIcon } from '../../ui/icons';
import { describeError } from '../../../lib/errors';
import { MISSING_VALUE } from '../../../lib/format';
import { fetchBookingDetail } from '../../../lib/bookings';
import { bookingStatusLabel, bookingStatusTone } from '../../../lib/bookingLabels';
import type { BookingDetail } from '../../../types/booking';
import { FolioBill } from '../folio/FolioBill';
import { GuestDetailsTab } from './GuestDetailsTab';
import { StayTab } from './StayTab';

// THE BOOKING DETAIL PAGE (build A §1) — a route, not a panel.
//
// WHY A PAGE AND NOT A MODAL: this screen now holds three substantial surfaces
// (identity, stay, money) with editing in two of them. A modal cannot be linked
// to, cannot be refreshed back into, cannot be sent to a colleague, and traps
// focus over a list nobody is reading. A route can do all four, so the front desk
// can keep a guest's folio open in a tab like any other page.
//
// THE ACTIVE TAB LIVES IN THE URL as ?tab=, for the same reason the active
// property does: a refresh, a bookmark or a link shared with a manager returns to
// the same view. It is a QUERY param rather than a path segment because it
// selects a view of one resource, not a different resource — and because
// replace: true keeps tab switching out of the back-button history, so Back goes
// where the user expects (the list), not through every tab they looked at.
//
// NO BROWSER STORAGE anywhere (constraint): the URL is the only place view state
// is kept.

const TABS = [
  { id: 'guest', label: 'Guest Details' },
  { id: 'stay', label: 'Stay' },
  { id: 'folio', label: 'Folio' },
] as const;

type TabId = (typeof TABS)[number]['id'];

function toTabId(value: string | null): TabId {
  return TABS.some((t) => t.id === value) ? (value as TabId) : 'guest';
}

interface BookingDetailScreenProps {
  bookingId: string;
  tenantId: string;
  propertyId: string;
  propertySlug: string;
  currency: string;
  timezone: string;
  // Whether this user is an owner/manager of the tenant that owns the property —
  // the guest-correction path is admin-only at the database (see updateGuest).
  isAdmin: boolean;
}

export function BookingDetailScreen({
  bookingId,
  tenantId,
  propertyId,
  propertySlug,
  currency,
  timezone,
  isAdmin,
}: BookingDetailScreenProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = toTabId(searchParams.get('tab'));

  const [detail, setDetail] = useState<BookingDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // Deep-linking works because the page fetches by id in its own right — it
      // never depends on a row the list happened to have loaded. Scoped to the
      // active tenant AND property (rule 19), so a booking id from another
      // property simply does not resolve here.
      const row = await fetchBookingDetail(bookingId, tenantId, propertyId);
      setDetail(row);
      setError(row ? null : 'This booking could not be found.');
    } catch (e) {
      // Rule 11: the real diagnostic on a load surface.
      setError(describeError(e));
    } finally {
      setLoading(false);
    }
  }, [bookingId, tenantId, propertyId]);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  function selectTab(next: TabId) {
    setSearchParams({ tab: next }, { replace: true });
  }

  const backHref = `/admin/${propertySlug}/bookings`;

  return (
    <div className="mx-auto max-w-5xl">
      {/* A real button, not a bare text link (§1) — it is the primary way off
          this page and should look like something you press. */}
      <Link
        to={backHref}
        className="inline-flex items-center gap-2 rounded-full border border-sand-border bg-white/70 px-4 py-2 text-sm font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream"
      >
        <ArrowLeftIcon className="h-4 w-4" />
        Back to bookings
      </Link>

      <header className="mt-4 mb-5">
        <h1 className="text-2xl font-bold tracking-tight text-charcoal">
          {detail?.guest?.full_name ?? (loading ? 'Loading…' : MISSING_VALUE)}
        </h1>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-sand px-3 py-1 text-xs font-semibold tabular-nums text-charcoal">
            {detail?.booking_number ?? MISSING_VALUE}
          </span>
          {detail ? (
            <span
              className={`rounded-full px-3 py-1 text-xs font-semibold ${bookingStatusTone(detail.status)}`}
            >
              {bookingStatusLabel(detail.status)}
            </span>
          ) : null}
          {detail?.company ? (
            <span className="rounded-full bg-primary/10 px-3 py-1 text-xs font-semibold text-primary">
              Billed to {detail.company.name}
            </span>
          ) : null}
          {/* The way INTO the guest's own page (2.txt §2). This booking is one
              stay; the guest may have many, and their ledger runs across all of
              them. There is no guests LIST screen yet, so this is how the guest
              view is reached — from a stay, which is how the front desk gets
              there anyway. */}
          {detail?.guest ? (
            <Link
              to={`/admin/${propertySlug}/guests/${detail.guest.id}`}
              className="rounded-full border border-sand-border bg-white/70 px-3 py-1 text-xs font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream"
            >
              Guest history &amp; ledger
            </Link>
          ) : null}
        </div>
      </header>

      {/* Tabs. At 360px they SCROLL horizontally rather than wrapping (§ mobile),
          so the row stays one line and the eye keeps the same anchor. */}
      <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <div
          role="tablist"
          aria-label="Booking views"
          className="flex min-w-max gap-1 border-b border-sand-border"
        >
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              aria-controls={`booking-panel-${t.id}`}
              id={`booking-tab-${t.id}`}
              onClick={() => selectTab(t.id)}
              className={`-mb-px whitespace-nowrap rounded-t-lg border-b-2 px-4 py-2.5 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream ${
                tab === t.id
                  ? 'border-primary text-charcoal'
                  : 'border-transparent text-charcoal-muted hover:text-charcoal'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-5">
        {loading && !detail ? (
          <p className="py-10 text-center text-sm text-charcoal-muted" aria-live="polite">
            Loading booking…
          </p>
        ) : error ? (
          <div className="rounded-2xl border border-sand-border bg-white/60 p-6 text-center">
            <p className="text-sm font-medium text-charcoal">
              We couldn’t load this booking.
            </p>
            <p className="mt-1 text-sm text-charcoal-muted">{error}</p>
            <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
              <button
                type="button"
                onClick={() => void load()}
                className="rounded-full border border-sand-border bg-white/70 px-4 py-2 text-sm font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream"
              >
                Try again
              </button>
              <Link
                to={backHref}
                className="rounded-full px-4 py-2 text-sm font-semibold text-charcoal-muted transition-colors hover:text-charcoal"
              >
                Back to bookings
              </Link>
            </div>
          </div>
        ) : detail ? (
          <>
            {tab === 'guest' ? (
              <div role="tabpanel" id="booking-panel-guest" aria-labelledby="booking-tab-guest">
                <GuestDetailsTab
                  guest={detail.guest}
                  tenantId={tenantId}
                  canEdit={isAdmin}
                  onSaved={load}
                />
              </div>
            ) : null}

            {tab === 'stay' ? (
              <div role="tabpanel" id="booking-panel-stay" aria-labelledby="booking-tab-stay">
                {/* timezone is load-bearing here, not decorative: the arrival
                    the desk records is a wall-clock reading in the PROPERTY's
                    zone, and the business date derived from it decides which
                    nights the audit bills. */}
                <StayTab
                  detail={detail}
                  currency={currency}
                  timezone={timezone}
                  onChanged={load}
                  // Checkout posts the room nights and hands back the balance
                  // (026); when money is still owed the summary sends the desk
                  // straight to the settlement screen. The tab lives in the URL,
                  // so this is the page's own selectTab — not a second writer of
                  // the same query param.
                  onGoToFolio={() => selectTab('folio')}
                />
              </div>
            ) : null}

            {tab === 'folio' ? (
              <div role="tabpanel" id="booking-panel-folio" aria-labelledby="booking-tab-folio">
                {/* THIS STAY's bill, directly — the page is already scoped to one
                    booking, so a one-row table of stays would be ceremony. The
                    GUEST view (next build) shows the stays table and drills into
                    this very component for the selected stay; FolioBill takes a
                    booking id and loads everything itself precisely so that
                    drill-in needs no change here or there. */}
                <FolioBill
                  bookingId={bookingId}
                  tenantId={tenantId}
                  propertyId={propertyId}
                  currency={currency}
                  timezone={timezone}
                  // The list is a separate screen now, so there is nothing to
                  // refresh behind this page; re-reading the booking keeps the
                  // header's status in step with anything a folio action changed.
                  onFolioChanged={() => void load()}
                />
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
