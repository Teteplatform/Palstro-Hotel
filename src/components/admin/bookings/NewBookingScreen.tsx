import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useToast } from '../../ui/Toast';
import { NumberField, Select, TextArea, TimeField } from '../../ui/form';
import { ArrowLeftIcon, ChevronDownIcon } from '../../ui/icons';
import { controlClasses } from '../../ui/form/FieldShell';
import { humanizeError, describeError } from '../../../lib/errors';
import {
  addDaysIso,
  nightsBetween,
  formatDisplayDate,
  todayIsoInZone,
} from '../../../lib/date';
import { fetchAllRoomTypes } from '../../../lib/roomTypes';
import { fetchAllCompanies } from '../../../lib/companies';
import {
  countAvailable,
  createBooking,
  isNoAvailabilityError,
  resolveBookingRate,
} from '../../../lib/bookings';
import { formatNights } from '../../../lib/bookingLabels';
import { useBookingDraft } from '../../../hooks/useBookingDraft';
import type { RoomType } from '../../../types/room';
import type { Company } from '../../../types/company';
import {
  formatStayTotal,
  quoteTotals,
  type NightRate,
} from '../../../lib/bookingQuote';
import { GuestPicker } from './GuestPicker';
import { RoomTypeStep } from './RoomTypeStep';
import { QuoteBreakdown, QuoteCalcNote, QuoteFigures } from './BookingQuote';

// THE NEW-BOOKING PAGE (build B §1) — a route, not a modal.
//
// WHY A PAGE: the same reasons the booking DETAIL became one. A booking is built
// over minutes, not seconds — dates, a room type chosen against live
// availability, a guest who may have to be registered from scratch — and a modal
// makes all of that happen in a box floating over a list nobody is reading, with
// no URL to return to and a focus trap fighting the form. As a route it can be
// linked to, refreshed into, and left and returned to; the draft (below) makes
// leaving safe.
//
// THIS FILE IS PRESENTATION AND ROUTING ONLY. Availability (count_available),
// pricing (resolve_booking_rate), the past-date guard (property-local today) and
// the create path (create_booking + idempotency key, and its overbooking
// rejection) are the ENGINE and are used exactly as the dialog used them — not a
// line of their logic is re-implemented or altered here.
//
// THE DRAFT IS UNCHANGED. The form is still wholly CONTROLLED by the
// session-scoped BookingDraftProvider, which lives above the route Outlet, so a
// half-filled booking survives navigating to another admin screen and back —
// including via the Back button on this page, which deliberately does NOT clear.
// That is why an explicit "Discard draft" exists: with no modal Cancel to clear
// on close, the user needs one honest way to throw the draft away. No browser
// storage anywhere (constraint) — a refresh clears it, by design.
//
// Only two pieces of state here are local and transient, because neither is form
// input: whether the room-type table is expanded, and whether the mobile quote
// bar is expanded.
//
// LAYOUT (§3, both breakpoints are requirements, not one plus an afterthought):
//   - desktop: form in a 2-col column, the live quote in a sticky side rail;
//   - 360px:   one column, the same quote as a fixed bottom bar showing the
//              total always and the per-night breakdown when expanded, with the
//              page padded so the last field never hides beneath it.

interface NewBookingScreenProps {
  tenantId: string;
  propertyId: string;
  propertySlug: string;
  // The property's IANA timezone: "today" for the check-in min comes from the
  // PROPERTY, matching the create_booking past-date guard (migration 020). The
  // RPC is the law; this only stops the user picking a date it would reject.
  timezone: string;
  currency: string;
}

// A fresh key per submit INTENT (rules 2/3). crypto.randomUUID needs no storage.
function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

export function NewBookingScreen({
  tenantId,
  propertyId,
  propertySlug,
  timezone,
  currency,
}: NewBookingScreenProps) {
  const toast = useToast();
  const navigate = useNavigate();

  const { draft, update, updateNewGuest, clear, open } =
    useBookingDraft(propertyId);

  // Materialise this property's draft slot and make sure it carries a
  // submit-intent key — the same call the list's "New booking" button used to
  // make before opening the dialog.
  //
  // DEPENDS ON propertyId, DELIBERATELY NOT ON `open`. The draft hook's mutators
  // are bound to the context VALUE, which is re-memoised on every draft change,
  // so `open` gets a new identity on every keystroke. An effect keyed on it
  // would call open() → new drafts object → new identity → fire again, forever.
  // Keying on the property is also what we actually mean: one slot per property,
  // materialised once.
  useEffect(() => {
    open();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [propertyId]);

  const {
    checkIn,
    checkOut,
    roomTypeId,
    companyId,
    guest,
    adults,
    children,
    specialRequests,
    expectedArrivalTime,
    idempotencyKey,
  } = draft;

  // --- TRANSIENT / DERIVED STATE: recomputed on mount, never persisted.
  const [roomTypes, setRoomTypes] = useState<RoomType[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [typesLoading, setTypesLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [availability, setAvailability] = useState<Map<string, number>>(new Map());
  const [availLoading, setAvailLoading] = useState(false);

  const [nightRates, setNightRates] = useState<NightRate[]>([]);
  const [rateLoading, setRateLoading] = useState(false);

  const [submitting, setSubmitting] = useState(false);

  // View state (not form input, so not in the draft). The room-type table starts
  // expanded for a fresh draft and collapsed when returning to one that already
  // has a type — the screen picks up where the user left it.
  const [roomStepOpen, setRoomStepOpen] = useState(() => !draft.roomTypeId);
  const [quoteExpanded, setQuoteExpanded] = useState(false);

  const minCheckIn = todayIsoInZone(timezone);
  const nights = nightsBetween(checkIn, checkOut);
  const datesValid = nights > 0;
  const selectedType = roomTypes.find((rt) => rt.id === roomTypeId) ?? null;

  // Room types + active companies, once.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [types, comps] = await Promise.all([
          fetchAllRoomTypes(propertyId, tenantId),
          fetchAllCompanies(tenantId, true),
        ]);
        if (cancelled) return;
        setRoomTypes(types);
        setCompanies(comps);
      } catch (e) {
        // Load surface: the real diagnostic, never a swallowed failure (rule 11).
        if (!cancelled) setLoadError(describeError(e));
      } finally {
        // Until this flips, an empty list means "not loaded yet", not "this
        // property has nothing to book" — two very different things to tell a
        // receptionist.
        if (!cancelled) setTypesLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [propertyId, tenantId]);

  // Availability per room type for the chosen dates. Extracted so the
  // availability-rejection handler can re-run it.
  const refreshAvailability = useMemo(
    () => async (signal?: { cancelled: boolean }) => {
      if (!datesValid || roomTypes.length === 0) {
        setAvailability(new Map());
        return;
      }
      setAvailLoading(true);
      try {
        const entries = await Promise.all(
          roomTypes.map(async (rt) => {
            const free = await countAvailable(propertyId, rt.id, checkIn, checkOut);
            return [rt.id, free] as const;
          }),
        );
        if (signal?.cancelled) return;
        setAvailability(new Map(entries));
      } catch (e) {
        if (signal?.cancelled) return;
        toast.error(humanizeError(e));
      } finally {
        if (!signal?.cancelled) setAvailLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [propertyId, checkIn, checkOut, roomTypes, datesValid],
  );

  useEffect(() => {
    const signal = { cancelled: false };
    void (async () => {
      await refreshAvailability(signal);
    })();
    return () => {
      signal.cancelled = true;
    };
  }, [refreshAvailability]);

  // Live per-night rate resolution (rack or negotiated) for the selected type.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!selectedType || !datesValid) {
        setNightRates([]);
        return;
      }
      setRateLoading(true);
      try {
        const dates: string[] = [];
        for (let d = checkIn; d < checkOut; d = addDaysIso(d, 1)) dates.push(d);
        const rates = await Promise.all(
          dates.map(async (date) => ({
            date,
            rate: await resolveBookingRate(selectedType.id, date, companyId || null),
          })),
        );
        if (cancelled) return;
        setNightRates(rates);
      } catch (e) {
        if (cancelled) return;
        toast.error(humanizeError(e));
        setNightRates([]);
      } finally {
        if (!cancelled) setRateLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedType, companyId, checkIn, checkOut, datesValid]);

  const totals = quoteTotals(nightRates);
  const selectedAvailable = selectedType
    ? availability.get(selectedType.id)
    : undefined;

  // Keep check-out at least one night after check-in when check-in moves past it.
  function handleCheckInChange(value: string) {
    update(
      value && (!checkOut || checkOut <= value)
        ? { checkIn: value, checkOut: addDaysIso(value, 1) }
        : { checkIn: value },
    );
  }

  function handleSelectRoomType(id: string) {
    update({ roomTypeId: id });
    // The point of the collapse: the table has done its job, so it gets out of
    // the way and the eye moves down to the guest.
    setRoomStepOpen(false);
  }

  // Validation gates — identical to the dialog's.
  const adultsOk =
    adults !== null &&
    adults >= 1 &&
    (!selectedType || adults <= selectedType.max_adults);
  const childrenOk =
    (children ?? 0) >= 0 &&
    (!selectedType || (children ?? 0) <= selectedType.max_children);
  const canSubmit =
    datesValid &&
    !!selectedType &&
    selectedAvailable !== undefined &&
    selectedAvailable > 0 &&
    !!guest &&
    adultsOk &&
    childrenOk &&
    !submitting;

  // Why the button is disabled, said plainly — a dead primary action with no
  // explanation is the thing users complain about most on a long form.
  const missing: string[] = [];
  if (!datesValid) missing.push('valid dates');
  if (!selectedType) missing.push('a room type');
  else if (selectedAvailable !== undefined && selectedAvailable <= 0)
    missing.push('a room type with availability');
  if (!guest) missing.push('a guest');
  if (!adultsOk) missing.push('a valid number of adults');
  if (!childrenOk) missing.push('a valid number of children');

  async function handleSubmit() {
    if (!canSubmit || !selectedType || !guest || adults === null) return;
    setSubmitting(true);
    try {
      const booking = await createBooking({
        propertyId,
        roomTypeId: selectedType.id,
        guestId: guest.id,
        checkIn,
        checkOut,
        adults,
        children: children ?? 0,
        specialRequests: specialRequests.trim() || null,
        companyId: companyId || null,
        billTo: companyId ? 'company' : 'guest',
        // Informational only (025) — stored on the booking, read by nothing.
        expectedArrivalTime: expectedArrivalTime || null,
        idempotencyKey,
      });
      toast.success(`Booking ${booking.booking_number} created.`);
      // The draft has been committed — clear it, then land on the booking's own
      // page, which is where the user wants to be next (take a deposit, note a
      // request) rather than back on a list hunting for the row they just made.
      clear();
      navigate(`/admin/${propertySlug}/bookings/${booking.id}`);
    } catch (e) {
      if (isNoAvailabilityError(e)) {
        toast.error(
          'That room type is no longer available for these dates — someone may have just booked it. Availability has been refreshed.',
        );
        // A genuinely new attempt after the refresh: fresh key, re-count, and
        // reopen the table so the user can see what is actually free now.
        update({ idempotencyKey: newIdempotencyKey() });
        setRoomStepOpen(true);
        void refreshAvailability();
      } else {
        toast.error(humanizeError(e));
      }
    } finally {
      setSubmitting(false);
    }
  }

  // Discarding: remove the slot, then immediately re-open a fresh one so the
  // page keeps a blank draft with a new submit-intent key rather than sitting on
  // the provider's shared default (which carries no key).
  function handleDiscard() {
    clear();
    open();
    setRoomStepOpen(true);
    setQuoteExpanded(false);
  }

  const negotiated = Boolean(companyId);
  const stayTotalLabel = formatStayTotal(totals, nightRates, currency);

  const createButton = (
    <button
      type="button"
      onClick={() => void handleSubmit()}
      disabled={!canSubmit}
      className="inline-flex min-h-12 w-full items-center justify-center rounded-full bg-accent px-6 text-sm font-semibold text-white transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:cursor-not-allowed disabled:opacity-50"
    >
      {submitting ? 'Creating…' : 'Create booking'}
    </button>
  );

  const stillNeeded =
    missing.length > 0 ? (
      <p className="text-xs text-charcoal-muted">
        Still needed: {missing.join(', ')}.
      </p>
    ) : null;

  return (
    // pb-40 on mobile keeps the last field clear of the fixed quote bar; the bar
    // is lg:hidden, so desktop needs no such allowance.
    <div className="mx-auto max-w-6xl pb-40 lg:pb-0">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* Same button treatment as the detail page's — this is the way off the
            page and should look like something you press. */}
        <Link
          to={`/admin/${propertySlug}/bookings`}
          className="inline-flex min-h-11 items-center gap-2 rounded-full border border-sand-border bg-white/70 px-4 text-sm font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream"
        >
          <ArrowLeftIcon className="h-4 w-4" />
          Back to bookings
        </Link>

        <button
          type="button"
          onClick={handleDiscard}
          disabled={submitting}
          className="inline-flex min-h-11 items-center rounded-full px-4 text-sm font-semibold text-charcoal-muted underline-offset-4 transition-colors hover:text-charcoal hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:opacity-60"
        >
          Discard draft
        </button>
      </div>

      <header className="mt-4 mb-5">
        <h1 className="text-2xl font-bold tracking-tight text-charcoal">
          New booking
        </h1>
        <p className="mt-1 text-sm text-charcoal-muted">
          Dates, then the room, then the guest. The price updates as you go, and
          an unfinished booking is kept if you step away.
        </p>
      </header>

      {loadError ? (
        <p className="mb-4 rounded-xl border border-sand-border bg-white/60 p-3 text-sm text-charcoal-muted">
          {loadError}
        </p>
      ) : null}

      {/* items-start is what lets the rail actually stick: a stretched grid item
          is already full height and has nowhere to scroll to. */}
      <div className="grid items-start gap-6 lg:grid-cols-3">
        {/* FORM COLUMN. The descendant-input rules give every control in the form
            a 44px minimum height for thumbs (§3) without changing the shared
            field components for the rest of the app. */}
        <div className="space-y-5 lg:col-span-2 [&_input]:min-h-11 [&_select]:min-h-11 [&_textarea]:min-h-11">
          <Step number={1} title="Dates">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col">
                <span className="mb-1 block text-sm font-medium text-charcoal">
                  Check-in
                </span>
                <input
                  type="date"
                  value={checkIn}
                  min={minCheckIn}
                  onChange={(e) => handleCheckInChange(e.target.value)}
                  disabled={submitting}
                  className={controlClasses}
                />
              </label>
              <label className="flex flex-col">
                <span className="mb-1 block text-sm font-medium text-charcoal">
                  Check-out
                </span>
                <input
                  type="date"
                  value={checkOut}
                  min={addDaysIso(checkIn, 1)}
                  onChange={(e) => update({ checkOut: e.target.value })}
                  disabled={submitting}
                  className={controlClasses}
                />
              </label>
            </div>
            <p className="mt-2 text-xs text-charcoal-muted">
              {datesValid
                ? `${formatNights(nights)} · ${formatDisplayDate(checkIn)} → ${formatDisplayDate(checkOut)}`
                : 'Check-out must be after check-in.'}
            </p>

            {/* EXPECTED ARRIVAL TIME (025) — sits with the dates because it is
                the same question asked more precisely: not which day, but roughly
                what hour. OPTIONAL and PURELY INFORMATIONAL. It is stored on the
                booking and read by NOTHING: not the night audit, not
                count_available, not the no-show guard (which already waits for
                the whole reserved arrival DAY to end at the property, so a 22:00
                arrival was never at risk). Its only job is to stop the desk
                chasing a guest who said they would be late.
                Half-width from sm so it aligns under Check-in; full width at
                360px like every other control here. */}
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <TimeField
                label="Expected arrival time"
                value={expectedArrivalTime}
                onChange={(v) => update({ expectedArrivalTime: v })}
                disabled={submitting}
                helpText="Optional, 24-hour. A heads-up for the front desk — it does not affect the price, availability, or no-show handling."
              />
            </div>
          </Step>

          <Step
            number={2}
            title="Room type"
            // Only when COLLAPSED: expanded, the table shows its own
            // availability-loading line beneath itself, and two of them would
            // be saying the same thing twice.
            aside={
              selectedType && !roomStepOpen && availLoading
                ? 'checking availability…'
                : undefined
            }
          >
            <RoomTypeStep
              roomTypes={roomTypes}
              typesLoading={typesLoading}
              availability={availability}
              availLoading={availLoading}
              datesValid={datesValid}
              selectedId={roomTypeId}
              onSelect={handleSelectRoomType}
              open={roomStepOpen}
              onOpenChange={setRoomStepOpen}
              nightlyRate={totals.uniformRate}
              rateVaries={nightRates.length > 0 && totals.uniformRate === null}
              rateLoading={rateLoading}
              negotiated={negotiated}
              currency={currency}
              disabled={submitting}
            />
          </Step>

          <Step number={3} title="Guest">
            <div className="space-y-4">
              <Select
                label="Bill to"
                value={companyId}
                onChange={(v) => update({ companyId: v })}
                options={[
                  { value: '', label: 'Walk-in — bill the guest' },
                  ...companies.map((c) => ({ value: c.id, label: c.name })),
                ]}
                disabled={submitting}
                helpText="Choosing a company switches pricing to its negotiated rate and bills the folio to the company."
              />

              <GuestPicker
                tenantId={tenantId}
                value={guest}
                onChange={(g) => update({ guest: g })}
                newGuest={draft.newGuest}
                onNewGuestChange={updateNewGuest}
                disabled={submitting}
              />

              <div className="grid gap-3 sm:grid-cols-2">
                <NumberField
                  label="Adults"
                  required
                  value={adults}
                  onChange={(v) => update({ adults: v })}
                  min={1}
                  max={selectedType?.max_adults}
                  step={1}
                  disabled={submitting}
                  error={
                    selectedType && adults !== null && adults > selectedType.max_adults
                      ? `This room type allows at most ${selectedType.max_adults} adults.`
                      : undefined
                  }
                  helpText={
                    selectedType
                      ? `Max ${selectedType.max_adults} for ${selectedType.name}.`
                      : 'Select a room type to see its limit.'
                  }
                />
                <NumberField
                  label="Children"
                  value={children}
                  onChange={(v) => update({ children: v })}
                  min={0}
                  max={selectedType?.max_children}
                  step={1}
                  disabled={submitting}
                  error={
                    selectedType && (children ?? 0) > selectedType.max_children
                      ? `This room type allows at most ${selectedType.max_children} children.`
                      : undefined
                  }
                  helpText={
                    selectedType
                      ? `Max ${selectedType.max_children} for ${selectedType.name}.`
                      : undefined
                  }
                />
              </div>

              <TextArea
                label="Special requests"
                value={specialRequests}
                onChange={(v) => update({ specialRequests: v })}
                rows={2}
                disabled={submitting}
                placeholder="Optional — cot, late arrival, dietary notes…"
              />
            </div>
          </Step>
        </div>

        {/* DESKTOP QUOTE RAIL. Sticky below the admin header (which is itself
            sticky at the top of the main column), so the price stays in view as
            the form scrolls. Hidden at mobile, where the bar below takes over. */}
        <aside className="hidden lg:sticky lg:top-20 lg:block">
          <div className="rounded-2xl border border-sand-border bg-sand/30 p-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-charcoal">Quote</h2>
              {rateLoading ? (
                <span className="text-xs text-charcoal-muted" aria-live="polite">
                  Pricing…
                </span>
              ) : null}
            </div>

            <QuoteFigures
              roomTypeName={selectedType?.name ?? null}
              nights={nights}
              nightRates={nightRates}
              negotiated={negotiated}
              currency={currency}
              loading={rateLoading}
            />

            {nightRates.length > 0 ? (
              <div className="mt-3 border-t border-sand-border pt-3">
                <QuoteBreakdown nightRates={nightRates} currency={currency} />
              </div>
            ) : null}

            <div className="mt-3">
              <QuoteCalcNote />
            </div>

            <div className="mt-4 space-y-2">
              {createButton}
              {stillNeeded}
            </div>
          </div>
        </aside>
      </div>

      {/* MOBILE QUOTE BAR. Fixed to the bottom so the total is never scrolled
          away, expandable to the same per-night breakdown the rail shows. */}
      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-sand-border bg-cream shadow-2xl lg:hidden">
        {quoteExpanded ? (
          <div
            id="quote-breakdown"
            className="max-h-56 overflow-y-auto border-b border-sand-border px-4 py-3"
          >
            {nightRates.length > 0 ? (
              <QuoteBreakdown nightRates={nightRates} currency={currency} />
            ) : (
              <p className="text-xs text-charcoal-muted">
                Pick dates and a room type to see the nightly breakdown.
              </p>
            )}
            <div className="mt-2">
              <QuoteCalcNote />
            </div>
          </div>
        ) : null}

        <div className="space-y-2 px-4 py-3">
          <button
            type="button"
            onClick={() => setQuoteExpanded((v) => !v)}
            aria-expanded={quoteExpanded}
            aria-controls="quote-breakdown"
            className="flex min-h-11 w-full items-center justify-between gap-3 rounded-lg px-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream"
          >
            <span className="min-w-0">
              <span className="block text-xs text-charcoal-muted">
                {datesValid ? formatNights(nights) : 'Dates not set'}
                {selectedType ? ` · ${selectedType.name}` : ''}
              </span>
              <span className="block text-xs font-medium text-charcoal">
                Stay total
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-2">
              <span
                className="text-lg font-bold tabular-nums text-charcoal"
                aria-live="polite"
              >
                {rateLoading ? '…' : stayTotalLabel}
              </span>
              <ChevronDownIcon
                className={`h-4 w-4 text-charcoal-muted transition-transform ${
                  quoteExpanded ? 'rotate-180' : ''
                }`}
              />
            </span>
          </button>

          {createButton}
          {stillNeeded}
        </div>
      </div>
    </div>
  );
}

// One numbered step. The numbering is the whole point of the page (§2): the eye
// follows 1 → 2 → 3 down the screen instead of hunting a wall of cards.
function Step({
  number,
  title,
  aside,
  children,
}: {
  number: number;
  title: string;
  aside?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-sand-border bg-white/40 p-4">
      <div className="mb-3 flex items-center gap-2">
        <span
          aria-hidden="true"
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-bold text-white"
        >
          {number}
        </span>
        <h2 className="text-sm font-semibold text-charcoal">
          <span className="sr-only">Step {number}: </span>
          {title}
        </h2>
        {aside ? (
          <span className="text-xs text-charcoal-muted" aria-live="polite">
            {aside}
          </span>
        ) : null}
      </div>
      {children}
    </section>
  );
}
