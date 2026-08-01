import { useState } from 'react';
import { DetailTable, DetailRow } from '../../ui/DetailTable';
import { TextArea } from '../../ui/form';
import { useToast } from '../../ui/Toast';
import { humanizeError } from '../../../lib/errors';
import { formatCurrency, formatOccupancy, MISSING_VALUE } from '../../../lib/format';
import { formatDisplayDate, nightsBetween } from '../../../lib/date';
import {
  bookingTotal,
  cancelBooking,
  checkInBooking,
  checkOutBooking,
} from '../../../lib/bookings';
import { formatNights, rateSourceLabel } from '../../../lib/bookingLabels';
import type { BookingDetail } from '../../../types/booking';

// The Stay tab (build A §2): what was reserved, what was agreed, and the
// lifecycle actions — which live HERE because checking in, checking out and
// cancelling are all facts about the stay, not about the guest or the money.
//
// Every action goes through an RPC, never a direct update: bookings has no update
// RLS policy, and each transition will touch other subsystems as they land. Every
// call is awaited in try/catch and its failure surfaced (rule 11).
//
// The rate breakdown is read from the LOCKED booking_nights — the rate agreed for
// each night when the booking was made. It is never re-derived from today's rate
// tables, which is the whole point of locking it: a stay bills what was agreed,
// even after rack rates move. Note that this total is NOT the folio balance: it
// is what the room nights were priced at, before deposits, extras, discounts or
// tax. The Folio tab answers "what is owed"; this one answers "what was agreed".

interface StayTabProps {
  detail: BookingDetail;
  currency: string;
  onChanged: () => Promise<void> | void;
}

export function StayTab({ detail, currency, onChanged }: StayTabProps) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');

  const nights = nightsBetween(detail.check_in, detail.check_out);
  const total = bookingTotal(detail.booking_nights);
  const status = detail.status;

  async function runAction(fn: () => Promise<unknown>, successMessage: string) {
    setBusy(true);
    try {
      await fn();
      toast.success(successMessage);
      await onChanged();
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
      () => cancelBooking(detail.id, reason.trim()),
      'Booking cancelled.',
    );
    setCancelling(false);
    setReason('');
  }

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-bold tracking-tight text-charcoal">Stay</h2>

      <DetailTable caption="Reservation">
        <DetailRow label="Room type">
          {detail.room_type?.name ?? MISSING_VALUE}
        </DetailRow>
        <DetailRow label="Occupancy">
          {formatOccupancy(detail.adults, detail.children)}
        </DetailRow>
        <DetailRow label="Check-in">
          {formatDisplayDate(detail.check_in)}
        </DetailRow>
        <DetailRow label="Check-out">
          {formatDisplayDate(detail.check_out)}
        </DetailRow>
        <DetailRow label="Nights">{formatNights(nights)}</DetailRow>
        <DetailRow label="Company">
          {detail.company ? (
            detail.company.name
          ) : (
            <span className="text-charcoal-muted">Walk-in</span>
          )}
        </DetailRow>
        <DetailRow label="Bill to">
          {detail.bill_to === 'company'
            ? `Company${detail.company ? ` — ${detail.company.name}` : ''}`
            : 'Guest'}
        </DetailRow>
        {detail.special_requests ? (
          <DetailRow label="Special requests">
            {detail.special_requests}
          </DetailRow>
        ) : null}
        {detail.status === 'cancelled' && detail.cancellation_reason ? (
          <DetailRow label="Cancellation reason">
            {detail.cancellation_reason}
          </DetailRow>
        ) : null}
      </DetailTable>

      {/* The per-night rates, as a table: each night, why it cost what it did
          (rate_source), and what was locked. */}
      <div className="overflow-x-auto rounded-2xl border border-sand-border bg-white/60">
        <table className="w-full min-w-[22rem] border-collapse text-sm">
          <caption className="border-b border-sand-border bg-sand/40 px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-charcoal-muted">
            Rate breakdown · locked at booking
          </caption>
          <thead>
            <tr className="border-b border-sand-border/70 text-left">
              <th scope="col" className="px-4 py-2 text-xs font-semibold text-charcoal-muted">
                Night
              </th>
              <th scope="col" className="px-4 py-2 text-xs font-semibold text-charcoal-muted">
                Rate basis
              </th>
              <th scope="col" className="px-4 py-2 text-right text-xs font-semibold text-charcoal-muted">
                Rate
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-sand-border/70">
            {detail.booking_nights.map((n) => (
              <tr key={n.stay_date}>
                <td className="whitespace-nowrap px-4 py-2.5 text-charcoal">
                  {formatDisplayDate(n.stay_date)}
                </td>
                <td className="px-4 py-2.5 text-charcoal-muted">
                  {rateSourceLabel(n.rate_source) || MISSING_VALUE}
                </td>
                <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums text-charcoal">
                  {formatCurrency(n.rate, currency)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-sand-border bg-sand/30">
              <th scope="row" colSpan={2} className="px-4 py-2.5 text-left text-sm font-semibold text-charcoal">
                Total agreed for the stay
              </th>
              <td className="whitespace-nowrap px-4 py-2.5 text-right text-sm font-bold tabular-nums text-charcoal">
                {formatCurrency(total, currency)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="text-xs text-charcoal-muted">
        This is what the room nights were priced at when the booking was made. It
        is not the balance — deposits, extras, discounts and tax all live on the
        Folio tab.
      </p>

      {/* Lifecycle actions. */}
      {cancelling ? (
        <section className="rounded-2xl border border-sand-border bg-white/70 p-4">
          <h3 className="text-sm font-semibold text-charcoal">Cancel this booking</h3>
          <div className="mt-3">
            <TextArea
              label="Reason for cancellation"
              required
              value={reason}
              onChange={setReason}
              rows={2}
              disabled={busy}
              helpText="Recorded on the booking, permanently."
            />
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
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
            <button
              type="button"
              onClick={() => void handleCancel()}
              disabled={busy}
              className="rounded-full bg-primary px-5 py-2 text-xs font-semibold text-white transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:opacity-60"
            >
              {busy ? 'Cancelling…' : 'Confirm cancellation'}
            </button>
          </div>
        </section>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {/* A booking is born confirmed (create_booking), so there is no
              "confirm" action; cancel is available while it is still live. */}
          {status === 'confirmed' ? (
            <ActionButton
              busy={busy}
              onClick={() =>
                void runAction(() => checkInBooking(detail.id), 'Guest checked in.')
              }
            >
              Check in
            </ActionButton>
          ) : null}
          {status === 'checked_in' ? (
            <ActionButton
              busy={busy}
              onClick={() =>
                void runAction(() => checkOutBooking(detail.id), 'Guest checked out.')
              }
            >
              Check out
            </ActionButton>
          ) : null}
          {status === 'confirmed' ? (
            <button
              type="button"
              onClick={() => setCancelling(true)}
              disabled={busy}
              className="rounded-full border border-sand-border bg-white/70 px-5 py-2.5 text-sm font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:opacity-60"
            >
              Cancel booking
            </button>
          ) : null}
          {status !== 'confirmed' && status !== 'checked_in' ? (
            <p className="text-xs text-charcoal-muted">
              No further stay actions are available for a {status.replace('_', ' ')}{' '}
              booking.
            </p>
          ) : null}
        </div>
      )}
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
