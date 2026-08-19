import { useState } from 'react';
import { TextArea } from '../../ui/form';
import { useToast } from '../../ui/Toast';
import { LockIcon } from '../../ui/icons';
import { formatDisplayDate } from '../../../lib/date';
import { folioErrorMessage, newIdempotencyKey } from '../../../lib/folio';
import { reverseCancel, reverseNoShow } from '../../../lib/bookings';
import { FolioActionCard } from '../folio/FolioActionCard';

// REVERSING A BOOKING'S STATUS (migration 033) — one form for both acts, because
// they are the same act on two different facts and a second copy would drift.
//
//   REVERSE NO-SHOW      — "the guest did turn up, or we marked it in error."
//                          The booking returns to CONFIRMED and any retention
//                          charge is credited back by a counter-entry.
//   REVERSE CANCELLATION — "this booking should never have been cancelled."
//                          The booking returns to CONFIRMED. No money moves.
//
// NEITHER IS A ONE-PRESS ACTION, and the reason is the same one for both: THEY
// RE-TAKE A ROOM. A cancel freed the room (015 RULE 4) and a no-show freed it
// too (029 §2), so the room may be somebody else's now. The RPC re-checks
// availability for EVERY night of the stay under the same lock create_booking
// takes, and refuses — naming the nights that are full — rather than
// overbooking. That refusal is the most important thing this screen can show, so
// it is rendered in full, in place, and not paraphrased.
//
// A MANAGER PIN IS ALWAYS REQUIRED, with no threshold — the same rule the money
// reversals follow (031 §3.2). Restoring a booking re-takes inventory the hotel
// may have re-sold and un-bills a night that was already invoiced to a company;
// there is no version of that which is routine. The field is never conditional
// here, and the RPC refuses the call outright without one (rule 19: the screen
// is convenience, the database is the guard).
//
// THE PIN ITSELF: one piece of component state for the duration of one call,
// never written anywhere else, never logged, never included in an error message,
// and cleared in the finally block whether the call succeeded or failed. There
// is no browser storage anywhere in this app (constraint).
//
// RESPONSIVE: FolioActionCard is the shared shell every folio action already
// uses, so this stacks to a single column at 360px with the PIN field capped to
// a comfortable width and the two buttons wrapping rather than shrinking.

export type BookingStatusReversalKind = 'no_show' | 'cancel';

interface ReverseBookingStatusFormProps {
  kind: BookingStatusReversalKind;
  bookingId: string;
  bookingNumber: string;
  // The RESERVED window — what the availability re-check will test, night by
  // night. Shown so the desk knows which nights are about to be re-taken.
  checkIn: string;
  checkOut: string;
  roomTypeName?: string | null;
  // Only meaningful for a no-show, and only when the caller knows it: a
  // GUARANTEED booking (a company held the room) had one night charged, a
  // walk-in had nothing. Undefined means "not known here" and the copy covers
  // both cases without guessing — the server decides either way.
  guaranteed?: boolean;
  // The PROPERTY's today ('YYYY-MM-DD'), for the stale-restore warning below.
  propertyToday: string;
  onDone: () => Promise<void> | void;
  onCancel: () => void;
}

export function ReverseBookingStatusForm({
  kind,
  bookingId,
  bookingNumber,
  checkIn,
  checkOut,
  roomTypeName,
  guaranteed,
  propertyToday,
  onDone,
  onCancel,
}: ReverseBookingStatusFormProps) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [pin, setPin] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // THE SERVER'S REJECTION, KEPT ON SCREEN. It is not a toast, and that is
  // deliberate: the availability refusal is a sentence naming dates ("2 of 3
  // nights are full: 14 Aug 2026, 15 Aug 2026") plus a hint about what to do
  // instead, and it belongs beside the dates it is talking about, in the panel
  // the user is still looking at — not in a corner of the screen above it. It
  // clears when the user changes anything and tries again.
  const [rejection, setRejection] = useState<string | null>(null);

  const isNoShow = kind === 'no_show';
  const canSubmit = reason.trim().length > 0 && pin.trim().length > 0;

  // A restore whose arrival day is already over is legitimate — correcting a
  // wrongly-cancelled stay days later is exactly what this is for — but that
  // booking becomes a candidate for the night audit's auto-resolve pass again
  // (029 §4), which will cancel it, or no-show and charge it, at the next run.
  // Said before the fact so the desk checks the guest in today rather than
  // discovering it tomorrow.
  const arrivalDayHasPassed = checkIn < propertyToday;

  async function handleSubmit() {
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    setRejection(null);
    try {
      const input = {
        bookingId,
        reason: reason.trim(),
        managerPin: pin.trim(),
        // A fresh key per submit INTENT. It cannot cause a double restore either
        // way: both RPCs also refuse a booking that already carries a reversal
        // of this kind, whatever key arrives, under a lock on the booking row.
        idempotencyKey: newIdempotencyKey(),
      };
      if (isNoShow) {
        await reverseNoShow(input);
      } else {
        await reverseCancel(input);
      }
      toast.success(
        isNoShow
          ? 'No-show reversed. The booking is confirmed again, the room is held for it, and any no-show charge has been credited back on the folio.'
          : 'Cancellation reversed. The booking is confirmed again and the room is held for it.',
      );
      await onDone();
    } catch (e) {
      // THE RPC'S OWN WORDS, VERBATIM — message and hint (rule 11).
      // folioErrorMessage is the shared "show the server's sentence" helper; it
      // is used rather than humanizeError because humanizeError replaces a 42501
      // with soft copy, and 42501 is what a wrong or missing manager PIN raises.
      // The availability refusal (23514) carries its detail in the hint, which
      // humanizeError drops entirely.
      setRejection(folioErrorMessage(e));
    } finally {
      // The PIN leaves memory the moment the call is over, success or failure.
      setPin('');
      setSubmitting(false);
    }
  }

  return (
    <FolioActionCard
      title={
        isNoShow
          ? `Reverse the no-show — ${bookingNumber}`
          : `Reverse the cancellation — ${bookingNumber}`
      }
      subject={
        <>
          {formatDisplayDate(checkIn)} → {formatDisplayDate(checkOut)}
          {roomTypeName ? ` · ${roomTypeName}` : ''}
        </>
      }
      effect={
        <>
          The booking goes back to <strong>confirmed</strong> — not checked in.
        </>
      }
      submitLabel={isNoShow ? 'Reverse no-show' : 'Reverse cancellation'}
      submittingLabel="Restoring…"
      submitting={submitting}
      canSubmit={canSubmit}
      destructive
      onSubmit={() => void handleSubmit()}
      onCancel={onCancel}
    >
      {/* WHAT WILL HAPPEN TO THE ROOM — the fact that decides whether this can
          be done at all. Stated before the attempt so a refusal is understood
          rather than experienced as a system fault. */}
      <div className="rounded-xl border border-sand-border bg-sand/50 px-4 py-3">
        <p className="text-sm font-semibold text-charcoal">
          This re-takes the room for every night of the stay.
        </p>
        <p className="mt-1 text-xs text-charcoal">
          {isNoShow
            ? 'Marking the no-show released the room, so it may already be booked for somebody else. '
            : 'Cancelling released the room, so it may already be booked for somebody else. '}
          Availability is re-checked night by night before anything changes. If
          any night is full the booking is <strong>not</strong> restored and you
          will be told which nights are gone.
        </p>
      </div>

      {/* THE MONEY, for the no-show only — a cancellation posted nothing, so
          there is nothing to say about it that would not be noise. */}
      {isNoShow ? (
        <div className="rounded-xl border border-sand-border bg-white/70 px-4 py-3">
          <p className="text-sm font-semibold text-charcoal">
            {guaranteed === true
              ? 'The one-night no-show charge will be credited back.'
              : guaranteed === false
                ? 'No charge was posted for this no-show, so nothing changes on the folio.'
                : 'Any no-show charge on the folio will be credited back.'}
          </p>
          <p className="mt-1 text-xs text-charcoal">
            {guaranteed === false
              ? 'This booking had no company guarantee, so the no-show cost the guest nothing and only the status changes.'
              : 'The original charge stays on the bill and a matching counter-entry is posted against it, with the tax, so both lines remain visible for good. A charge that was already voided is left alone.'}
          </p>
        </div>
      ) : (
        <div className="rounded-xl border border-sand-border bg-white/70 px-4 py-3">
          <p className="text-sm font-semibold text-charcoal">
            No money moves.
          </p>
          <p className="mt-1 text-xs text-charcoal">
            A cancelled booking had no room charges, and any deposit already
            taken stays exactly where it is — refunding or forfeiting it is a
            separate, deliberate act on the folio.
          </p>
        </div>
      )}

      {arrivalDayHasPassed ? (
        <div
          role="note"
          className="rounded-xl border border-primary/40 bg-primary/5 px-4 py-3"
        >
          <p className="text-xs text-charcoal">
            <strong>The arrival date has passed.</strong> Once restored, this
            booking is confirmed but nobody has arrived on it, so tonight&rsquo;s
            night audit will resolve it again — cancelling it, or recording a
            no-show and charging a company guarantee. Check the guest in today if
            they are here.
          </p>
        </div>
      ) : null}

      <TextArea
        label="Reason for the reversal"
        required
        value={reason}
        onChange={(value) => {
          setReason(value);
          setRejection(null);
        }}
        rows={2}
        disabled={submitting}
        placeholder={
          isNoShow
            ? 'e.g. guest arrived late and was recorded as a no-show in error'
            : 'e.g. cancelled on the wrong booking; the guest is still coming'
        }
        helpText="Recorded permanently against the manager who approves it, and shown on the booking from now on."
      />

      {/* ALWAYS shown — never conditional, unlike the discount screen's field. */}
      <div className="rounded-xl border-2 border-primary/40 bg-primary/5 p-3 sm:p-4">
        <p className="flex flex-wrap items-center gap-2 text-sm font-bold text-primary">
          <LockIcon className="h-5 w-5 shrink-0" />A manager must authorise this
          reversal
        </p>
        <p className="mt-1.5 text-xs text-charcoal">
          Every reversal needs a PIN, whatever the amount — this one re-takes a
          room the hotel may have re-sold
          {isNoShow ? ' and un-bills a night that was already charged' : ''}.
          Hand the terminal to a manager: the approval is recorded{' '}
          <strong>against them by name</strong>, permanently, and it can never be
          edited or deleted.
        </p>

        <label className="mt-3 block">
          <span className="mb-1 block text-sm font-semibold text-charcoal">
            Manager PIN{' '}
            <span className="text-primary" aria-hidden="true">
              *
            </span>
            <span className="sr-only">(required)</span>
          </span>
          <input
            type="password"
            inputMode="numeric"
            autoComplete="off"
            // 021 §7.1 accepts 4-8 digits; the RPC is the authority on format and
            // rejects anything else in its own words.
            maxLength={8}
            value={pin}
            onChange={(e) => {
              setPin(e.target.value);
              setRejection(null);
            }}
            disabled={submitting}
            aria-label="Manager PIN"
            className="w-full max-w-[14rem] rounded-lg border border-sand-border bg-white/80 px-3 py-2.5 text-base tracking-[0.4em] text-charcoal transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream disabled:cursor-not-allowed disabled:opacity-60"
          />
        </label>

        <p className="mt-2 text-[11px] text-charcoal-muted">
          The PIN is sent only to the approval check and is cleared from this
          screen the moment it is used. It is never stored or displayed, and no
          PIN is ever kept in this browser.
        </p>
      </div>

      {/* THE REFUSAL, IN THE SERVER'S OWN WORDS. role="alert" so a screen reader
          announces it the moment it appears, and it stays until the user changes
          something — a message telling the desk which nights are gone is one
          they need to read twice and quote to a guest. */}
      {rejection ? (
        <div
          role="alert"
          className="rounded-xl border-2 border-negative bg-negative/10 px-4 py-3"
        >
          <p className="text-sm font-bold text-negative">
            {isNoShow
              ? 'The no-show was not reversed.'
              : 'The cancellation was not reversed.'}
          </p>
          <p className="mt-1 text-sm text-charcoal">{rejection}</p>
          <p className="mt-1.5 text-xs text-charcoal-muted">
            Nothing has changed: the booking is exactly as it was.
          </p>
        </div>
      ) : null}
    </FolioActionCard>
  );
}
