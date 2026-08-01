import { useCallback, useEffect, useRef, useState } from 'react';
import { useToast } from '../../ui/Toast';
import { TextArea } from '../../ui/form';
import { CloseIcon } from '../../ui/icons';
import { useFocusTrap } from '../../../hooks/useFocusTrap';
import { humanizeError, describeError } from '../../../lib/errors';
import { formatCurrency, formatOccupancy, MISSING_VALUE } from '../../../lib/format';
import { formatDisplayDate, nightsBetween } from '../../../lib/date';
import {
  fetchBookingDetail,
  bookingTotal,
  cancelBooking,
  checkInBooking,
  checkOutBooking,
} from '../../../lib/bookings';
import {
  bookingStatusLabel,
  bookingStatusTone,
  formatNights,
  rateSourceLabel,
} from '../../../lib/bookingLabels';
import type { BookingDetail } from '../../../types/booking';
import { FolioPanel } from '../folio/FolioPanel';

// The manage view for one booking (build 6b §3): its per-night rate breakdown
// (why each night cost what it did, via rate_source), and the lifecycle actions —
// confirm → check-in → check-out, and cancel with a reason. EVERY action goes
// through an RPC (not a direct update). Writes are awaited in try/catch and
// surfaced (rule 11).
//
// TWO TABS (build 6c part 2 §1): STAY — the reservation and what was agreed, its
// per-night rates read from the LOCKED booking_nights; and FOLIO — the guest's
// running money account, every figure computed live by the engine. They are
// deliberately separate views of two different things: the stay total is what was
// agreed at booking time and never moves; the folio balance is what is owed right
// now and moves with every charge, discount, payment and void. Showing them as one
// number would be the exact confusion the folio exists to remove — a booking worth
// ₦450,000 with ₦100,000 taken as a deposit and two nights posted so far is not
// "₦450,000 outstanding" in any useful sense.

interface BookingDetailPanelProps {
  bookingId: string;
  tenantId: string;
  propertyId: string;
  currency: string;
  // The property's IANA timezone — the folio's charge/payment dates default to the
  // PROPERTY's today, not the browser's (rules 8, 12).
  timezone: string;
  onClose: () => void;
  onChanged: () => void; // list should refetch after a status or folio change
}

type DetailTab = 'stay' | 'folio';

export function BookingDetailPanel({
  bookingId,
  tenantId,
  propertyId,
  currency,
  timezone,
  onClose,
  onChanged,
}: BookingDetailPanelProps) {
  const toast = useToast();
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef, true, onClose);

  const [detail, setDetail] = useState<BookingDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');
  const [tab, setTab] = useState<DetailTab>('stay');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const row = await fetchBookingDetail(bookingId, tenantId, propertyId);
      setDetail(row);
      setError(row ? null : 'This booking could not be found.');
    } catch (e) {
      // Load surface: show the real diagnostic (message/details/hint/code) — rule 11.
      setError(describeError(e));
    } finally {
      setLoading(false);
    }
  }, [bookingId, tenantId, propertyId]);

  useEffect(() => {
    // Nested in an async IIFE so the load's setState is not a synchronous
    // effect-body update (the codebase's data-hook convention).
    void (async () => {
      await load();
    })();
  }, [load]);

  // Run a transition RPC, then reload the detail and tell the list to refetch.
  async function runAction(
    fn: () => Promise<unknown>,
    successMessage: string,
  ) {
    setBusy(true);
    try {
      await fn();
      toast.success(successMessage);
      await load();
      onChanged();
    } catch (e) {
      toast.error(humanizeError(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleCancel() {
    if (!reason.trim()) {
      toast.error('Please give a reason for the cancellation.');
      return;
    }
    await runAction(
      () => cancelBooking(bookingId, reason.trim()),
      'Booking cancelled.',
    );
    setCancelling(false);
    setReason('');
  }

  const status = detail?.status;
  const nights = detail ? nightsBetween(detail.check_in, detail.check_out) : 0;
  const total = detail ? bookingTotal(detail.booking_nights) : 0;

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-charcoal/40 p-4 sm:p-6">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Booking details"
        className="w-full max-w-xl rounded-2xl bg-cream shadow-xl"
      >
        <header className="sticky top-0 flex items-center justify-between gap-3 rounded-t-2xl border-b border-sand-border bg-cream px-5 py-4">
          <h2 className="text-lg font-bold tracking-tight text-charcoal">
            {detail ? detail.booking_number : 'Booking'}
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
          {loading ? (
            <p className="py-8 text-center text-sm text-charcoal-muted" aria-live="polite">
              Loading…
            </p>
          ) : error ? (
            <p className="py-8 text-center text-sm text-charcoal-muted">{error}</p>
          ) : detail ? (
            <>
              {/* Header facts */}
              <div className="flex flex-wrap items-center gap-2">
                {status ? (
                  <span
                    className={`rounded-full px-3 py-1 text-xs font-semibold ${bookingStatusTone(status)}`}
                  >
                    {bookingStatusLabel(status)}
                  </span>
                ) : null}
                {detail.company ? (
                  <span className="rounded-full bg-primary/10 px-3 py-1 text-xs font-semibold text-primary">
                    Billed to {detail.company.name}
                  </span>
                ) : null}
              </div>

              <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                <Field label="Guest" value={detail.guest?.full_name ?? MISSING_VALUE} />
                <Field
                  label="Contact"
                  value={detail.guest?.phone || detail.guest?.email || MISSING_VALUE}
                />
                <Field label="Room type" value={detail.room_type?.name ?? MISSING_VALUE} />
                <Field label="Occupancy" value={formatOccupancy(detail.adults, detail.children)} />
                <Field label="Check-in" value={formatDisplayDate(detail.check_in)} />
                <Field label="Check-out" value={formatDisplayDate(detail.check_out)} />
              </dl>

              {detail.special_requests ? (
                <div className="rounded-xl border border-sand-border bg-white/60 p-3">
                  <p className="text-xs font-semibold text-charcoal-muted">
                    Special requests
                  </p>
                  <p className="mt-0.5 text-sm text-charcoal">
                    {detail.special_requests}
                  </p>
                </div>
              ) : null}

              {/* The two views of this booking. Tabs (not a second dialog) so the
                  guest's identity above stays on screen while the folio is being
                  worked, and so there is one focus trap, not two. */}
              <div
                role="tablist"
                aria-label="Booking views"
                className="flex gap-1 border-b border-sand-border"
              >
                <TabButton
                  active={tab === 'stay'}
                  onClick={() => setTab('stay')}
                  controls="booking-tab-stay"
                >
                  Stay
                </TabButton>
                <TabButton
                  active={tab === 'folio'}
                  onClick={() => setTab('folio')}
                  controls="booking-tab-folio"
                >
                  Folio
                </TabButton>
              </div>

              {tab === 'folio' ? (
                <div id="booking-tab-folio" role="tabpanel">
                  <FolioPanel
                    bookingId={bookingId}
                    tenantId={tenantId}
                    propertyId={propertyId}
                    currency={currency}
                    timezone={timezone}
                    // A folio write moves this booking's balance, so the list's
                    // Balance column and outstanding total must re-read. Neither
                    // is cached anywhere (rule 6).
                    onFolioChanged={onChanged}
                  />
                </div>
              ) : (
              <div id="booking-tab-stay" role="tabpanel" className="space-y-5">
              {/* Per-night breakdown */}
              <section>
                <h3 className="mb-2 text-sm font-semibold text-charcoal">
                  Rate breakdown · {formatNights(nights)}
                </h3>
                <ul className="divide-y divide-sand-border rounded-xl border border-sand-border bg-white/60">
                  {detail.booking_nights.map((n) => (
                    <li
                      key={n.stay_date}
                      className="flex items-center justify-between gap-3 px-3 py-2"
                    >
                      <span className="min-w-0">
                        <span className="block text-sm text-charcoal">
                          {formatDisplayDate(n.stay_date)}
                        </span>
                        {rateSourceLabel(n.rate_source) ? (
                          <span className="block text-xs text-charcoal-muted">
                            {rateSourceLabel(n.rate_source)}
                          </span>
                        ) : null}
                      </span>
                      <span className="text-sm font-medium text-charcoal">
                        {formatCurrency(n.rate, currency)}
                      </span>
                    </li>
                  ))}
                </ul>
                <div className="mt-2 flex justify-between border-t border-sand-border pt-2 text-sm font-semibold text-charcoal">
                  <span>Total (locked at booking)</span>
                  <span>{formatCurrency(total, currency)}</span>
                </div>
              </section>

              {/* Cancellation record, if any */}
              {detail.status === 'cancelled' && detail.cancellation_reason ? (
                <div className="rounded-xl border border-sand-border bg-white/60 p-3">
                  <p className="text-xs font-semibold text-charcoal-muted">
                    Cancellation reason
                  </p>
                  <p className="mt-0.5 text-sm text-charcoal">
                    {detail.cancellation_reason}
                  </p>
                </div>
              ) : null}

              {/* Cancel sub-form */}
              {cancelling ? (
                <div className="rounded-xl border border-sand-border bg-white/60 p-3">
                  <TextArea
                    label="Reason for cancellation"
                    required
                    value={reason}
                    onChange={setReason}
                    rows={2}
                    disabled={busy}
                  />
                  <div className="mt-2 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void handleCancel()}
                      disabled={busy}
                      className="rounded-full bg-primary px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:opacity-60"
                    >
                      {busy ? 'Cancelling…' : 'Confirm cancellation'}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setCancelling(false);
                        setReason('');
                      }}
                      disabled={busy}
                      className="rounded-full border border-sand-border bg-white/70 px-4 py-2 text-xs font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:opacity-60"
                    >
                      Keep booking
                    </button>
                  </div>
                </div>
              ) : null}
              </div>
              )}
            </>
          ) : null}
        </div>

        {/* Actions */}
        {detail && !cancelling ? (
          <footer className="sticky bottom-0 flex flex-wrap items-center justify-end gap-2 rounded-b-2xl border-t border-sand-border bg-cream px-5 py-4">
            {/* The two forward transitions the screen exposes (a booking is born
                confirmed, so there is no "confirm" action). Cancel is available
                while the reservation is still live (confirmed). */}
            {status === 'confirmed' ? (
              <ActionButton
                busy={busy}
                onClick={() =>
                  void runAction(() => checkInBooking(bookingId), 'Guest checked in.')
                }
              >
                Check in
              </ActionButton>
            ) : null}
            {status === 'checked_in' ? (
              <ActionButton
                busy={busy}
                onClick={() =>
                  void runAction(() => checkOutBooking(bookingId), 'Guest checked out.')
                }
              >
                Check out
              </ActionButton>
            ) : null}
            {status === 'confirmed' ? (
              <button
                type="button"
                onClick={() => {
                  // The cancellation sub-form lives on the Stay tab; switch to it
                  // so the reason field is not opened out of sight.
                  setTab('stay');
                  setCancelling(true);
                }}
                disabled={busy}
                className="rounded-full border border-sand-border bg-white/70 px-5 py-2.5 text-sm font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:opacity-60"
              >
                Cancel booking
              </button>
            ) : null}
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="rounded-full px-5 py-2.5 text-sm font-semibold text-charcoal-muted transition-colors hover:text-charcoal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:opacity-60"
            >
              Close
            </button>
          </footer>
        ) : null}
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  controls,
  children,
}: {
  active: boolean;
  onClick: () => void;
  controls: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      aria-controls={controls}
      onClick={onClick}
      className={`-mb-px rounded-t-lg border-b-2 px-4 py-2 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream ${
        active
          ? 'border-primary text-charcoal'
          : 'border-transparent text-charcoal-muted hover:text-charcoal'
      }`}
    >
      {children}
    </button>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-charcoal-muted">{label}</dt>
      <dd className="mt-0.5 font-medium text-charcoal">{value}</dd>
    </div>
  );
}

function ActionButton({
  busy,
  onClick,
  children,
}: {
  busy: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:cursor-not-allowed disabled:opacity-50"
    >
      {busy ? 'Working…' : children}
    </button>
  );
}
