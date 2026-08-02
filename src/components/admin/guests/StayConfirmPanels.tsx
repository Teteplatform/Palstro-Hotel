import { useState } from 'react';
import { DateField, TextArea, TimeField } from '../../ui/form';
import { useToast } from '../../ui/Toast';
import { humanizeError } from '../../../lib/errors';
import { formatMoney } from '../../../lib/format';
import {
  formatDisplayDate,
  nowTimeInZone,
  todayIsoInZone,
  zonedDateTimeToIso,
} from '../../../lib/date';
import {
  cancelBooking,
  checkInBooking,
  checkOutBooking,
} from '../../../lib/bookings';
import { FolioActionCard } from '../folio/FolioActionCard';
import type { GuestStayRow } from '../../../types/guestLedger';

// THE STATUS-GATED STAY ACTIONS, as confirmation steps on the guest home:
// CHECK IN, CHECK OUT, and CANCEL.
//
// They live here rather than on the booking page because the guest home is where
// the front desk now works: the guest is standing at the desk, their stays are
// on screen, and the relevant row's kebab is how their stay is started, ended or
// called off. All three go through the EXISTING RPCs unchanged —
// check_in_booking (024), check_out_booking (026) and cancel_booking (015 §8) —
// and none of them computes or sends an amount.
//
// NONE IS EVER A ONE-PRESS ACTION, for three different reasons:
//   * CHECK-IN records WHEN the guest arrived, and that date decides which
//     nights the folio bills. A silent "checked in at whatever time the button
//     was pressed" would file a 02:00 walk-in — routinely keyed at 08:00 the
//     next morning — against the wrong operating day, and bill a night that was
//     never slept or miss one that was. So it always opens the picker.
//   * CHECKOUT posts the room nights and then the guest walks out of the
//     building. An F&B chit, a laundry ticket or a minibar item that never
//     reached the folio is money the hotel simply does not collect, so the desk
//     is asked to confirm — for THIS guest, every time — that there is nothing
//     left to post. The acknowledgement is a real gate: the confirm button is
//     disabled until it is ticked, and the handler refuses anyway.
//   * CANCELLING needs a reason, permanently recorded on the booking, because a
//     cancellation with no reason is indistinguishable from a mistake.

interface CheckInPanelProps {
  row: GuestStayRow;
  // The PROPERTY's IANA timezone. LOAD-BEARING, not cosmetic: the arrival the
  // desk types is a wall-clock reading in the HOTEL's zone, and check_in_booking
  // derives the billing business date from that same zone. An instant built in
  // the browser's zone would file a late-evening arrival against the wrong
  // operating day.
  timezone: string;
  onDone: () => Promise<void> | void;
  onCancel: () => void;
}

export function CheckInPanel({
  row,
  timezone,
  onDone,
  onCancel,
}: CheckInPanelProps) {
  const toast = useToast();
  // The property's today, and now — seeded once when the panel mounts, which is
  // the moment it is opened, so the default is "now" rather than "whenever this
  // screen happened to load".
  const [propertyToday] = useState(() => todayIsoInZone(timezone));
  const [date, setDate] = useState(() => todayIsoInZone(timezone));
  const [time, setTime] = useState(() => nowTimeInZone(timezone));
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit() {
    if (submitting) return;
    if (!date || !time) {
      toast.error('Enter the date and time the guest arrived.');
      return;
    }
    if (date > propertyToday) {
      toast.error('An arrival cannot be in the future.');
      return;
    }
    const arrivalAt = zonedDateTimeToIso(date, time, timezone);
    if (!arrivalAt) {
      toast.error('That arrival date and time could not be read. Please re-enter it.');
      return;
    }
    setSubmitting(true);
    try {
      await checkInBooking(row.booking_id, arrivalAt);
      toast.success('Guest checked in.');
      await onDone();
    } catch (e) {
      // Rule 11: surfaced, never swallowed.
      toast.error(humanizeError(e));
    } finally {
      setSubmitting(false);
    }
  }

  // Charging runs from the LATER of the arrival and the reserved check-in: an
  // early arrival has no locked rate for the earlier night (015 §5), so the
  // audit and checkout both floor at the reserved date. Shown before the fact so
  // the desk is never surprised by which nights appear on the bill.
  const chargeFrom = date > row.check_in ? date : row.check_in;

  return (
    <FolioActionCard
      title={`Record the arrival — ${row.booking_number}`}
      description="Defaults to now in the hotel's own clock, but change it if the guest arrived earlier — a 2 a.m. arrival is routinely keyed in the next morning, and this is the date the room nights are charged from. The reserved check-in date is left untouched."
      submitLabel="Confirm check-in"
      submittingLabel="Checking in…"
      submitting={submitting}
      canSubmit={date !== '' && time !== ''}
      onSubmit={() => void handleSubmit()}
      onCancel={onCancel}
    >
      {/* At 360px the two fields stack; from sm they sit side by side. */}
      <div className="grid gap-3 sm:grid-cols-2">
        <DateField
          label="Arrival date"
          required
          value={date}
          onChange={setDate}
          max={propertyToday}
          disabled={submitting}
          helpText="The hotel’s local date."
        />
        <TimeField
          label="Arrival time"
          required
          value={time}
          onChange={setTime}
          disabled={submitting}
          helpText="The hotel’s local time, 24-hour."
        />
      </div>

      {date && date !== row.check_in ? (
        <p className="text-xs font-medium text-charcoal">
          This differs from the reserved check-in of{' '}
          {formatDisplayDate(row.check_in)}. Nights will be charged from{' '}
          {formatDisplayDate(chargeFrom)}.
        </p>
      ) : null}
    </FolioActionCard>
  );
}

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
