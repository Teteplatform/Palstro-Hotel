import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ArrowLeftIcon } from '../../ui/icons';
import { describeError } from '../../../lib/errors';
import { MISSING_VALUE } from '../../../lib/format';
import { formatShortDate } from '../../../lib/date';
import { describeStayNights } from '../../../lib/stayNights';
import { fetchBookingDetail } from '../../../lib/bookings';
import { bookingStatusLabel, bookingStatusTone } from '../../../lib/bookingLabels';
import type { BookingDetail } from '../../../types/booking';
import { FolioBill } from '../folio/FolioBill';
import { StayTab } from './StayTab';

// THE BOOKING DETAIL PAGE — ONE STAY, ON ONE PAGE, WITH NO TABS.
//
// ---------------------------------------------------------------------------
// WHAT CHANGED, AND WHY (2.txt §2)
// ---------------------------------------------------------------------------
// This page used to carry three tabs: Guest Details, Stay and Folio. Guest
// Details is GONE — not moved, gone. It held an editable copy of the guest
// record that the guest home also held, and two editable copies of one record is
// the shape that eventually produces two different phone numbers for one person
// with no way to tell which is current. The guest is edited on the guest home
// and nowhere else, and the header below links there prominently.
//
// The remaining two are no longer tabs, because there is no longer a choice to
// make: what is left on this page is one stay's RESERVATION FACTS and one
// stay's BILL, and a reader who opens a booking wants both. Tabs over two
// panels that are always read together is ceremony — it hides half the page
// behind a click and makes the whole thing print as half of itself. They stack.
//
// WHAT THIS PAGE IS NOW FOR: it is the DRILL-IN from a stay. The guest home
// lists the stays and carries every per-stay ACTION on the row's kebab (take a
// payment, post a charge, check out, cancel); this page is where you come to
// read the detail — what was reserved, what rate was locked for each night, and
// the itemised bill. The lifecycle actions remain available here too, on the
// stay panel, because a booking opened directly (from the list, from a link)
// must still be workable without a detour through the guest.
//
// STILL A ROUTE, NOT A MODAL: it can be linked to, refreshed into, sent to a
// colleague and printed. No browser storage anywhere.

interface BookingDetailScreenProps {
  bookingId: string;
  tenantId: string;
  propertyId: string;
  propertySlug: string;
  currency: string;
  timezone: string;
}

export function BookingDetailScreen({
  bookingId,
  tenantId,
  propertyId,
  propertySlug,
  currency,
  timezone,
}: BookingDetailScreenProps) {
  const { hash } = useLocation();
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

  // Bring the bill into view. It is on the same page now, so this is a scroll
  // rather than a tab switch — which is the whole benefit of dropping the tabs:
  // the thing the desk is being sent to was never hidden, only further down.
  function scrollToFolio() {
    document
      .getElementById('booking-folio')
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // The guest home's "Open full bill" links to #booking-folio. A browser cannot
  // honour that hash on arrival because the section does not exist until the
  // booking has loaded, so the scroll happens HERE, once it does. Guarded on
  // `detail` for exactly that reason, and it runs only when the hash asked for
  // it — an ordinary visit lands at the top of the page, on the stay.
  useEffect(() => {
    if (!detail || hash !== '#booking-folio') return;
    scrollToFolio();
  }, [detail, hash]);

  // BACK GOES TO THE GUEST (build 2 §1), never to the bookings list. A stay is
  // reached FROM its guest, so Back must return there — including on a DEEP LINK
  // typed or pasted straight to a stay URL, where there is no history to go back
  // through. That is why it is a computed href off the loaded booking rather
  // than navigate(-1): -1 would send a deep-linked visitor to whatever page they
  // were on before, or out of the app entirely.
  //
  // Until the booking has loaded the guest is unknown, so the control renders as
  // a DISABLED button with the same label and geometry — it never flashes a
  // different destination, and it never briefly points at the bookings list.
  const backHref = detail?.guest
    ? `/admin/${propertySlug}/guests/${detail.guest.id}`
    : null;

  // PART 1: the nights this stay is DESCRIBED by are the nights it is BILLED
  // for. describeStayNights transcribes run_night_audit's own date predicate
  // (024 §3), which is the same expression guest_stays.charge_from uses, so the
  // header here and the stays table on the guest home cannot disagree.
  const stay = detail ? describeStayNights(detail) : null;

  return (
    <div className="mx-auto max-w-5xl">
      {backHref ? (
        <Link
          to={backHref}
          className="inline-flex items-center gap-2 rounded-full border border-sand-border bg-white/70 px-4 py-2 text-sm font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream print:hidden"
        >
          <ArrowLeftIcon className="h-4 w-4" />
          Back to guest
        </Link>
      ) : (
        <button
          type="button"
          disabled
          className="inline-flex items-center gap-2 rounded-full border border-sand-border bg-white/70 px-4 py-2 text-sm font-semibold text-charcoal opacity-60 print:hidden"
        >
          <ArrowLeftIcon className="h-4 w-4" />
          Back to guest
        </button>
      )}

      <header className="mt-4 mb-5">
        {/* THE GUEST'S NAME IS THE LINK TO THEIR HOME, and it is the page's
            title, because that is where everything about the person now lives —
            their details, their other stays, their whole ledger. A separate
            "Guest history" pill beside a plain-text name would make the primary
            route to the guest look like a secondary one. */}
        {detail?.guest ? (
          <Link
            to={`/admin/${propertySlug}/guests/${detail.guest.id}`}
            className="inline-flex max-w-full items-baseline gap-2 rounded-lg text-2xl font-bold tracking-tight text-charcoal underline decoration-primary/40 decoration-2 underline-offset-4 transition-colors hover:decoration-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream"
          >
            <span className="truncate">{detail.guest.full_name}</span>
            <span className="whitespace-nowrap text-xs font-semibold text-primary print:hidden">
              Guest home →
            </span>
          </Link>
        ) : (
          <h1 className="text-2xl font-bold tracking-tight text-charcoal">
            {loading ? 'Loading…' : MISSING_VALUE}
          </h1>
        )}

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
          {/* The stay's window and its night count, together, in the compact
              form the guest home's stays table uses — so the same stay reads the
              same on both screens. Once the guest has arrived this is the BILLED
              window; before that it is what was reserved. */}
          {detail && stay ? (
            <span className="rounded-full border border-sand-border bg-white/70 px-3 py-1 text-xs font-semibold tabular-nums text-charcoal">
              {formatShortDate(stay.chargeFrom ?? detail.check_in)} →{' '}
              {formatShortDate(detail.check_out)} ·{' '}
              {stay.actual ?? stay.reserved}{' '}
              {(stay.actual ?? stay.reserved) === 1 ? 'night' : 'nights'}
              {stay.differs ? (
                <span className="ml-1 font-normal text-charcoal-muted">
                  ({stay.reserved} reserved)
                </span>
              ) : null}
            </span>
          ) : null}
          {detail?.company ? (
            <span className="rounded-full bg-primary/10 px-3 py-1 text-xs font-semibold text-primary">
              Billed to {detail.company.name}
            </span>
          ) : null}
          {/* THIS is where a SINGLE stay is printed (build 2 §1) — the guest
              ledger prints the whole account, this prints one bill. The
              browser's own dialog, no PDF library and no second renderer: the
              page on screen IS the page that prints, so the two can never
              disagree. Every control is print:hidden, so it comes out as the
              reservation and its bill alone. */}
          {detail ? (
            <button
              type="button"
              onClick={() => window.print()}
              className="ml-auto rounded-full border border-sand-border bg-white/70 px-4 py-1 text-xs font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream print:hidden"
            >
              Print bill
            </button>
          ) : null}
        </div>
      </header>

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
            {/* The one place the bookings LIST is still the fallback: the
                booking did not load, so there is no guest to go back to, and
                stranding the user on a dead page would be worse than sending
                them somewhere real. */}
            <Link
              to={`/admin/${propertySlug}/bookings`}
              className="rounded-full px-4 py-2 text-sm font-semibold text-charcoal-muted transition-colors hover:text-charcoal"
            >
              Back to bookings
            </Link>
          </div>
        </div>
      ) : detail ? (
        <div className="space-y-8">
          {/* THE STAY: what was reserved, what rate was locked per night, and the
              lifecycle actions. All of it is about this STAY, not about the
              person — which is exactly why it stayed here when Guest Details
              left. */}
          <section aria-label="Stay">
            <StayTab
              detail={detail}
              currency={currency}
              timezone={timezone}
              onChanged={load}
              onGoToFolio={scrollToFolio}
            />
          </section>

          {/* THE BILL for this stay, directly — the page is already scoped to one
              booking, so a one-row table of stays would be ceremony. FolioBill
              takes a booking id and loads everything itself, which is why the
              guest home can drill straight into this page without either side
              knowing about the other. */}
          <section id="booking-folio" aria-label="Folio" className="scroll-mt-4">
            <FolioBill
              bookingId={bookingId}
              tenantId={tenantId}
              propertyId={propertyId}
              currency={currency}
              timezone={timezone}
              // Re-reading the booking keeps the header's status and nights in
              // step with anything a folio action changed. Nothing is cached
              // anywhere; this is a "re-read", not a "patch".
              onFolioChanged={() => void load()}
            />
          </section>
        </div>
      ) : null}
    </div>
  );
}
