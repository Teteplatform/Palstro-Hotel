import { useState } from 'react';
import { TextArea } from '../../ui/form';
import { useToast } from '../../ui/Toast';
import { humanizeError } from '../../../lib/errors';
import { formatMoney } from '../../../lib/format';
import { formatDisplayDate } from '../../../lib/date';
import { cancelBooking, checkOutBooking } from '../../../lib/bookings';
import { FolioActionCard } from '../folio/FolioActionCard';
import type { GuestStayRow } from '../../../types/guestLedger';

// THE TWO STATUS-GATED STAY ACTIONS, as confirmation steps on the guest home
// (2.txt §2): CHECK OUT, and CANCEL.
//
// They live here rather than on the booking page because the guest home is where
// the front desk now works: the guest is standing at the desk, their stays are
// on screen, and the most recent active one is the row whose kebab ends the
// stay. Both go through the EXISTING RPCs unchanged — check_out_booking (026)
// and cancel_booking (015 §8) — and neither computes or sends an amount.
//
// NEITHER IS EVER A ONE-PRESS ACTION, and for two different reasons:
//   * CHECKOUT posts the room nights and then the guest walks out of the
//     building. An F&B chit, a laundry ticket or a minibar item that never
//     reached the folio is money the hotel simply does not collect, so the desk
//     is asked to confirm — for THIS guest, every time — that there is nothing
//     left to post. The acknowledgement is a real gate: the confirm button is
//     disabled until it is ticked, and the handler refuses anyway.
//   * CANCELLING needs a reason, permanently recorded on the booking, because a
//     cancellation with no reason is indistinguishable from a mistake.

interface CheckOutPanelProps {
  row: GuestStayRow;
  currency: string;
  onDone: () => Promise<void> | void;
  onCancel: () => void;
}

export function CheckOutPanel({
  row,
  currency,
  onDone,
  onCancel,
}: CheckOutPanelProps) {
  const toast = useToast();
  const [confirmed, setConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit() {
    if (!confirmed || submitting) return;
    setSubmitting(true);
    try {
      // The RPC's RETURN VALUE is the point: check_out_booking posts every
      // unbilled room night in the same transaction as the status change and
      // hands back what it did. A bare "checked out" would hide the fact that
      // money is still owed, which at 02:00 is the only thing that matters.
      const summary = await checkOutBooking(row.booking_id);
      const owed = summary.balance !== null && summary.balance > 0;
      toast.success(
        `Checked out. ${summary.nightsPosted} night${
          summary.nightsPosted === 1 ? '' : 's'
        } posted now, ${summary.nightsAlreadyPosted} already on the bill. ${
          summary.balance === null
            ? ''
            : owed
              ? `${formatMoney(summary.balance, currency)} still outstanding — settle before they leave.`
              : 'Nothing outstanding.'
        }`,
      );
      await onDone();
    } catch (e) {
      // Rule 11: a night that could not post rolls the WHOLE checkout back, and
      // the desk is told why rather than left with a half-finished bill.
      toast.error(humanizeError(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <FolioActionCard
      title={`Check out — ${row.booking_number}`}
      description={`Room nights post automatically at checkout, from ${formatDisplayDate(
        row.charge_from,
      )} to ${formatDisplayDate(row.check_out)}.`}
      submitLabel="Confirm check-out"
      submittingLabel="Checking out…"
      submitting={submitting}
      canSubmit={confirmed}
      onSubmit={() => void handleSubmit()}
      onCancel={onCancel}
    >
      {/* THE LAST-ORDERS PROMPT. A real front-desk habit — "anything from the bar
          this morning?" — and a habit because the folio is the only place an
          extra can be recovered from.

          WHY IT MOVES: it is competing with muscle memory. The desk has pressed
          this a hundred times and the last ninety-nine had nothing to check. A
          static red box becomes furniture within a week; a slow halo does not.
          REDUCED MOTION: .animate-pulse-alert is switched off entirely by the
          prefers-reduced-motion query in index.css, and nothing is communicated
          by the movement alone — the border, the tint and every word stay. */}
      <div
        role="alert"
        className="animate-pulse-alert rounded-xl border-2 border-negative bg-negative/10 px-4 py-3"
      >
        <p className="text-sm font-bold text-negative">
          Before checking out — confirm all charges are posted.
        </p>
        <p className="mt-1 text-sm text-charcoal">
          Any F&amp;B, laundry, minibar or other extras must be on the folio now.
          They cannot be added to this stay after checkout.
        </p>
      </div>

      <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-sand-border bg-white/70 px-4 py-3">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
          disabled={submitting}
          className="mt-0.5 h-4 w-4 shrink-0 accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream"
        />
        <span className="text-sm font-medium text-charcoal">
          I have checked with the guest and all charges are on the folio.
        </span>
      </label>
    </FolioActionCard>
  );
}

interface CancelPanelProps {
  row: GuestStayRow;
  onDone: () => Promise<void> | void;
  onCancel: () => void;
}

export function CancelPanel({ row, onDone, onCancel }: CancelPanelProps) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit() {
    if (reason.trim().length === 0 || submitting) return;
    setSubmitting(true);
    try {
      await cancelBooking(row.booking_id, reason.trim());
      toast.success('Booking cancelled.');
      await onDone();
    } catch (e) {
      toast.error(humanizeError(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <FolioActionCard
      title={`Cancel ${row.booking_number}`}
      // Stated plainly because it surprises people: cancelling does NOT touch
      // any deposit already taken. Whether that money is refunded or forfeited
      // is a commercial decision a person makes under the hotel's policy, and
      // the system silently deciding it would be worse than the surprise (021
      // §10 sets this out in full).
      description="A deposit already taken is left exactly where it is — refunding or forfeiting it is a separate, deliberate act on the folio."
      submitLabel="Confirm cancellation"
      submittingLabel="Cancelling…"
      submitting={submitting}
      canSubmit={reason.trim().length > 0}
      destructive
      onSubmit={() => void handleSubmit()}
      onCancel={onCancel}
    >
      <TextArea
        label="Reason for cancellation"
        required
        value={reason}
        onChange={setReason}
        rows={2}
        disabled={submitting}
        helpText="Recorded on the booking, permanently."
      />
    </FolioActionCard>
  );
}
