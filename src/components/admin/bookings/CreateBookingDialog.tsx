import { useEffect, useMemo, useRef, useState } from 'react';
import { useToast } from '../../ui/Toast';
import { NumberField, Select, TextArea } from '../../ui/form';
import { CloseIcon } from '../../ui/icons';
import { useFocusTrap } from '../../../hooks/useFocusTrap';
import { humanizeError, describeError } from '../../../lib/errors';
import { formatCurrency, MISSING_VALUE } from '../../../lib/format';
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
import type { RoomType } from '../../../types/room';
import type { Company } from '../../../types/company';
import type { Booking } from '../../../types/booking';
import type { BookingDraft } from '../../../hooks/useBookingDraft';
import { GuestPicker } from './GuestPicker';

// The create-booking flow (build 6b §3), as a modal. Enforces every guarantee in
// the brief:
//   - shows availability per room type (count_available) once dates are chosen; a
//     fully booked type is visible but not selectable, with its 0 shown;
//   - optional company switches pricing to the negotiated rate and bill_to;
//   - live resolved nightly rate + stay total via resolve_booking_rate BEFORE
//     committing;
//   - a searched-or-inline guest (create_guest, staff-gated);
//   - adults/children within the room type's limits, with the limit surfaced;
//   - submits through create_booking with a fresh idempotency key (a double-click
//     cannot double-book — the DB index is the true guard);
//   - on the availability exception, a clear "no longer available" message and a
//     refresh of availability, since someone may have booked in between.

interface CreateBookingDialogProps {
  tenantId: string;
  propertyId: string;
  // The property's IANA timezone. Used to compute "today" for the check-in date
  // input's min, so past dates are not even selectable — the same property-local
  // "today" the create_booking RPC guards against (migration 020). The RPC is the
  // real law; this is the convenience layer.
  timezone: string;
  currency: string;
  // The session-scoped draft (held above the routes, survives navigation) and its
  // updater. The whole form is CONTROLLED by this draft — there is NO local state
  // for any form field here — so leaving to another admin screen and returning
  // restores the form exactly. Loaded/derived data (room types, availability, the
  // rate quote) is local transient state below and is recomputed on mount.
  draft: BookingDraft;
  update: (patch: Partial<BookingDraft>) => void;
  onClose: () => void;
  onCreated: (booking: Booking) => void;
}

// A fresh idempotency key per submit intent. crypto.randomUUID is available in
// every supported browser and needs no storage (constraint).
function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

export function CreateBookingDialog({
  tenantId,
  propertyId,
  timezone,
  currency,
  draft,
  update,
  onClose,
  onCreated,
}: CreateBookingDialogProps) {
  const toast = useToast();
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef, true, onClose);

  // The earliest selectable check-in: the PROPERTY's today (not the browser's).
  // Matches the RPC guard (020); check_in == today is allowed (same-day walk-ins).
  const minCheckIn = todayIsoInZone(timezone);

  // --- FORM STATE: read from / written to the draft (session-scoped, no storage).
  const {
    checkIn,
    checkOut,
    roomTypeId,
    companyId,
    guest,
    adults,
    children,
    specialRequests,
    idempotencyKey,
  } = draft;
  // Shallow-merge helper for the nested new-guest sub-form the GuestPicker owns.
  const updateNewGuest = (patch: Partial<BookingDraft['newGuest']>) =>
    update({ newGuest: { ...draft.newGuest, ...patch } });

  // --- TRANSIENT / DERIVED STATE: recomputed on mount, deliberately NOT persisted.
  const [roomTypes, setRoomTypes] = useState<RoomType[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [availability, setAvailability] = useState<Map<string, number>>(new Map());
  const [availLoading, setAvailLoading] = useState(false);

  const [nightRates, setNightRates] = useState<{ date: string; rate: number | null }[]>([]);
  const [rateLoading, setRateLoading] = useState(false);

  const [submitting, setSubmitting] = useState(false);

  const nights = nightsBetween(checkIn, checkOut);
  const datesValid = nights > 0;
  const selectedType = roomTypes.find((rt) => rt.id === roomTypeId) ?? null;

  // Load room types + active companies once on open.
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
        // Load surface: show the real diagnostic (message/details/hint/code) — rule 11.
        if (!cancelled) setLoadError(describeError(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [propertyId, tenantId]);

  // Recompute availability per room type whenever the dates (or the type list)
  // change. Extracted so the availability-exception handler can re-run it.
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
            rate: await resolveBookingRate(
              selectedType.id,
              date,
              companyId || null,
            ),
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

  const stayTotal = nightRates.reduce((sum, n) => sum + (n.rate ?? 0), 0);
  const anyRateMissing = nightRates.some((n) => n.rate === null);

  const selectedAvailable = selectedType
    ? availability.get(selectedType.id)
    : undefined;

  // Keeping check_out at least one night after check_in when check_in moves past it.
  function handleCheckInChange(value: string) {
    update(
      value && (!checkOut || checkOut <= value)
        ? { checkIn: value, checkOut: addDaysIso(value, 1) }
        : { checkIn: value },
    );
  }

  // Validation gates for enabling submit.
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
        idempotencyKey,
      });
      toast.success(`Booking ${booking.booking_number} created.`);
      onCreated(booking);
    } catch (e) {
      if (isNoAvailabilityError(e)) {
        toast.error(
          'That room type is no longer available for these dates — someone may have just booked it. Availability has been refreshed.',
        );
        // A genuinely new attempt after refresh: fresh key, re-count availability.
        update({ idempotencyKey: newIdempotencyKey() });
        void refreshAvailability();
      } else {
        toast.error(humanizeError(e));
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-charcoal/40 p-4 sm:p-6">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Create booking"
        className="w-full max-w-2xl rounded-2xl bg-cream shadow-xl"
      >
        <header className="sticky top-0 flex items-center justify-between gap-3 rounded-t-2xl border-b border-sand-border bg-cream px-5 py-4">
          <h2 className="text-lg font-bold tracking-tight text-charcoal">
            New booking
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-2 text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream"
          >
            <CloseIcon className="h-5 w-5" />
          </button>
        </header>

        <div className="space-y-5 px-5 py-5">
          {loadError ? (
            <p className="rounded-xl border border-sand-border bg-white/60 p-3 text-sm text-charcoal-muted">
              {loadError}
            </p>
          ) : null}

          {/* Dates */}
          <section>
            <h3 className="mb-2 text-sm font-semibold text-charcoal">Dates</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium text-charcoal">Check-in</span>
                <input
                  type="date"
                  value={checkIn}
                  min={minCheckIn}
                  onChange={(e) => handleCheckInChange(e.target.value)}
                  className="rounded-lg border border-sand-border bg-white/70 px-3 py-2 text-sm text-charcoal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream"
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium text-charcoal">Check-out</span>
                <input
                  type="date"
                  value={checkOut}
                  min={addDaysIso(checkIn, 1)}
                  onChange={(e) => update({ checkOut: e.target.value })}
                  className="rounded-lg border border-sand-border bg-white/70 px-3 py-2 text-sm text-charcoal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream"
                />
              </label>
            </div>
            <p className="mt-1.5 text-xs text-charcoal-muted">
              {datesValid
                ? `${formatNights(nights)} · ${formatDisplayDate(checkIn)} → ${formatDisplayDate(checkOut)}`
                : 'Check-out must be after check-in.'}
            </p>
          </section>

          {/* Room type + availability */}
          <section>
            <h3 className="mb-2 text-sm font-semibold text-charcoal">
              Room type
              {availLoading ? (
                <span className="ml-2 text-xs font-normal text-charcoal-muted">
                  checking availability…
                </span>
              ) : null}
            </h3>
            {!datesValid ? (
              <p className="text-sm text-charcoal-muted">
                Choose valid dates to see what’s free.
              </p>
            ) : roomTypes.length === 0 ? (
              <p className="text-sm text-charcoal-muted">
                This property has no room types to book.
              </p>
            ) : (
              <ul className="space-y-2">
                {roomTypes.map((rt) => {
                  const free = availability.get(rt.id);
                  const soldOut = free !== undefined && free <= 0;
                  const selected = rt.id === roomTypeId;
                  return (
                    <li key={rt.id}>
                      <button
                        type="button"
                        disabled={soldOut}
                        onClick={() => update({ roomTypeId: rt.id })}
                        className={`flex w-full items-center justify-between gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream ${
                          selected
                            ? 'border-primary bg-primary/5'
                            : 'border-sand-border bg-white/60 hover:bg-sand'
                        } ${soldOut ? 'cursor-not-allowed opacity-60' : ''}`}
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-semibold text-charcoal">
                            {rt.name}
                          </span>
                          <span className="block text-xs text-charcoal-muted">
                            Up to {rt.max_adults} adult
                            {rt.max_adults === 1 ? '' : 's'}
                            {rt.max_children > 0
                              ? `, ${rt.max_children} child${rt.max_children === 1 ? '' : 'ren'}`
                              : ''}
                          </span>
                        </span>
                        <span
                          className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${
                            free === undefined
                              ? 'bg-sand text-charcoal-muted'
                              : soldOut
                                ? 'bg-charcoal/10 text-charcoal-muted'
                                : 'bg-accent/15 text-accent'
                          }`}
                        >
                          {free === undefined
                            ? '—'
                            : soldOut
                              ? 'Fully booked'
                              : `${free} free`}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {/* Company (optional) */}
          <section>
            <Select
              label="Bill to company (optional)"
              value={companyId}
              onChange={(v) => update({ companyId: v })}
              options={[
                { value: '', label: 'Walk-in — bill the guest' },
                ...companies.map((c) => ({ value: c.id, label: c.name })),
              ]}
              helpText="Choosing a company switches pricing to its negotiated rate and bills the folio to the company."
            />
          </section>

          {/* Guest */}
          <section>
            <h3 className="mb-2 text-sm font-semibold text-charcoal">Guest</h3>
            <GuestPicker
              tenantId={tenantId}
              value={guest}
              onChange={(g) => update({ guest: g })}
              newGuest={draft.newGuest}
              onNewGuestChange={updateNewGuest}
              disabled={submitting}
            />
          </section>

          {/* Occupancy */}
          <section>
            <h3 className="mb-2 text-sm font-semibold text-charcoal">Occupancy</h3>
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
          </section>

          {/* Special requests */}
          <section>
            <TextArea
              label="Special requests"
              value={specialRequests}
              onChange={(v) => update({ specialRequests: v })}
              rows={2}
              disabled={submitting}
              placeholder="Optional — cot, late arrival, dietary notes…"
            />
          </section>

          {/* Price preview */}
          {selectedType && datesValid ? (
            <section className="rounded-xl border border-sand-border bg-sand/30 p-4">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-charcoal">
                  Price {companyId ? '(company rate)' : '(rack)'}
                </h3>
                {rateLoading ? (
                  <span className="text-xs text-charcoal-muted" aria-live="polite">
                    Resolving…
                  </span>
                ) : null}
              </div>
              {nightRates.length > 0 ? (
                <>
                  <ul className="mt-2 space-y-0.5">
                    {nightRates.map((n) => (
                      <li
                        key={n.date}
                        className="flex justify-between text-xs text-charcoal-muted"
                      >
                        <span>{formatDisplayDate(n.date)}</span>
                        <span>
                          {n.rate === null
                            ? MISSING_VALUE
                            : formatCurrency(n.rate, currency)}
                        </span>
                      </li>
                    ))}
                  </ul>
                  <div className="mt-2 flex justify-between border-t border-sand-border pt-2 text-sm font-semibold text-charcoal">
                    <span>{formatNights(nights)} total</span>
                    <span>
                      {anyRateMissing
                        ? MISSING_VALUE
                        : formatCurrency(stayTotal, currency)}
                    </span>
                  </div>
                </>
              ) : (
                <p className="mt-1 text-xs text-charcoal-muted">
                  Rate will show once resolved.
                </p>
              )}
            </section>
          ) : null}
        </div>

        <footer className="sticky bottom-0 flex items-center justify-end gap-2 rounded-b-2xl border-t border-sand-border bg-cream px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-full border border-sand-border bg-white/70 px-5 py-2.5 text-sm font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={!canSubmit}
            className="rounded-full bg-accent px-6 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? 'Creating…' : 'Create booking'}
          </button>
        </footer>
      </div>
    </div>
  );
}
