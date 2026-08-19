import { useState } from 'react';
import { TextArea } from '../../ui/form';
import { useToast } from '../../ui/Toast';
import { LockIcon } from '../../ui/icons';
import { formatDisplayDate } from '../../../lib/date';
import { folioErrorMessage, newIdempotencyKey } from '../../../lib/folio';
import { reverseCheckout } from '../../../lib/bookings';
import { FolioActionCard } from '../folio/FolioActionCard';

// REVERSING A CHECKOUT (migration 034) — the last of the four reversals, and the
// one whose meaning is easiest to mis-read, so the panel says it in words before
// it asks for anything:
//
//   THIS REOPENS THE STAY. IT DOES NOT UN-CHARGE IT.
//
// The guest has not actually left — a checkout keyed at 09:00 for someone still
// at breakfast and staying another night, or keyed on the wrong booking of a
// group. The booking goes back to CHECKED IN and the folio is open again, so the
// desk can post tonight's dinner and take payment. The room nights already on the
// bill STAY: they were slept, and reopening the stay says the guest is here, not
// that they were never here. A night that genuinely has to come off is a separate
// reversal on that charge, with its own PIN and its own reason.
//
// WHY IT IS ITS OWN COMPONENT AND NOT A THIRD `kind` ON ReverseBookingStatusForm:
// that form's entire body is about RE-TAKING A ROOM — "availability is re-checked
// night by night", "you will be told which nights are gone", "the booking goes
// back to confirmed, not checked in". Every one of those sentences is FALSE here.
// A checked-out stay never released its room (count_available counts checked_in
// and checked_out identically), so nothing is re-taken and nothing can be
// refused for availability; and this one goes straight back to checked_in,
// because the arrival it is returning to genuinely happened and is still on the
// record. Sharing a component would mean branching every string in it, which is
// how two different acts end up explained in one set of hedged words.
//
// WHAT IS SHARED is the part that must never differ: FolioActionCard, the
// mandatory reason, the always-required manager PIN with no threshold, the
// server's rejection shown verbatim in place, and the PIN cleared in `finally`.
// A reversal asks for the same things and reads the same way wherever it is
// performed.
//
// THE PIN: one piece of component state for the duration of one call, never
// written anywhere else, never logged, never included in an error message, and
// cleared whether the call succeeded or failed. There is no browser storage
// anywhere in this app (constraint).
//
// RESPONSIVE: FolioActionCard stacks to a single column at 360px, with the PIN
// field capped to a comfortable width and the buttons wrapping rather than
// shrinking.

interface ReverseCheckoutFormProps {
  bookingId: string;
  bookingNumber: string;
  // The stay's dates, shown so the desk can confirm it is reopening the right
  // one before a manager is called over.
  checkIn: string;
  checkOut: string;
  roomTypeName?: string | null;
  onDone: () => Promise<void> | void;
  onCancel: () => void;
}

export function ReverseCheckoutForm({
  bookingId,
  bookingNumber,
  checkIn,
  checkOut,
  roomTypeName,
  onDone,
  onCancel,
}: ReverseCheckoutFormProps) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [pin, setPin] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // THE SERVER'S REJECTION, KEPT ON SCREEN rather than thrown into a toast. The
  // one this panel can produce is a sentence the desk has to act on — "already
  // reversed once, and the guest has been checked out again since", with a hint
  // naming the remedy — and it belongs in the panel the user is still looking
  // at. It clears when they change something and try again.
  const [rejection, setRejection] = useState<string | null>(null);

  const canSubmit = reason.trim().length > 0 && pin.trim().length > 0;

  async function handleSubmit() {
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    setRejection(null);
    try {
      await reverseCheckout({
        bookingId,
        reason: reason.trim(),
        managerPin: pin.trim(),
        // A fresh key per submit INTENT. It cannot cause a double reopen either
        // way: the RPC also refuses a booking that already carries a checkout
        // reversal, whatever key arrives, under a lock on the booking row.
        idempotencyKey: newIdempotencyKey(),
      });
      toast.success(
        'Checkout reversed. The stay is checked in again and its folio is open — the room charges already posted are unchanged.',
      );
      await onDone();
    } catch (e) {
      // THE RPC'S OWN WORDS, VERBATIM — message and hint (rule 11).
      // folioErrorMessage is the shared "show the server's sentence" helper; it
      // is used rather than humanizeError because humanizeError replaces a 42501
      // with soft copy, and 42501 is what a wrong or missing manager PIN raises,
      // and it drops the hint that carries the remedy.
      setRejection(folioErrorMessage(e));
    } finally {
      // The PIN leaves memory the moment the call is over, success or failure.
      setPin('');
      setSubmitting(false);
    }
  }

  return (
    <FolioActionCard
      title={`Reverse the checkout — ${bookingNumber}`}
      subject={
        <>
          {formatDisplayDate(checkIn)} → {formatDisplayDate(checkOut)}
          {roomTypeName ? ` · ${roomTypeName}` : ''}
        </>
      }
      effect={
        <>
          Use this if the guest has <strong>not actually left</strong>.
        </>
      }
      submitLabel="Reverse checkout"
      submittingLabel="Reopening…"
      submitting={submitting}
      canSubmit={canSubmit}
      destructive
      onSubmit={() => void handleSubmit()}
      onCancel={onCancel}
    >
      {/* WHAT THIS ACTUALLY DOES, in the two halves people confuse. Stated
          before the fields, because a person who reads only the first box must
          still come away with the right idea of the act. */}
      <div className="rounded-xl border border-sand-border bg-sand/50 px-4 py-3">
        <p className="text-sm font-semibold text-charcoal">
          This reopens the stay to checked-in.
        </p>
        <p className="mt-1 text-xs text-charcoal">
          The booking returns to the in-house list and its folio is open again,
          so charges and payments can be posted against it. The guest&rsquo;s
          recorded arrival is unchanged, so the nights the bill charges for do
          not move.
        </p>
      </div>

      <div className="rounded-xl border border-sand-border bg-white/70 px-4 py-3">
        <p className="text-sm font-semibold text-charcoal">
          Room charges already posted remain.
        </p>
        <p className="mt-1 text-xs text-charcoal">
          Those nights were slept, so they stay on the bill and stay counted —
          reopening a stay is not the same as un-charging it. If one particular
          charge has to come off, reverse that charge on the folio instead: it
          takes its own reason and its own manager approval.
        </p>
      </div>

      {/* THE ONE-SHOT WARNING. Not a legalism: re-checking-out a reopened stay
          is the NORMAL ending — the guest leaves the next morning — and at that
          point this action is spent for good. Better said now than discovered
          in a refusal. */}
      <div
        role="note"
        className="rounded-xl border border-primary/40 bg-primary/5 px-4 py-3"
      >
        <p className="text-xs text-charcoal">
          <strong>This can only be done once.</strong> When the guest really does
          leave, check them out again in the usual way — the room nights already
          on the bill are not posted twice, and only nights the stay has since
          gained are added. That second checkout cannot be reversed.
        </p>
      </div>

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
        placeholder="e.g. checked out in error — the guest is staying another night"
        helpText="Recorded permanently against the manager who approves it, and shown on the booking from now on."
      />

      {/* ALWAYS shown — never conditional, unlike the discount screen's field. */}
      <div className="rounded-xl border-2 border-primary/40 bg-primary/5 p-3 sm:p-4">
        <p className="flex flex-wrap items-center gap-2 text-sm font-bold text-primary">
          <LockIcon className="h-5 w-5 shrink-0" />A manager must authorise this
          reversal
        </p>
        <p className="mt-1.5 text-xs text-charcoal">
          Every reversal needs a PIN, whatever the amount — this one puts a
          settled bill back in play and returns a departed guest to the in-house
          list. Hand the terminal to a manager: the approval is recorded{' '}
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
          something. */}
      {rejection ? (
        <div
          role="alert"
          className="rounded-xl border-2 border-negative bg-negative/10 px-4 py-3"
        >
          <p className="text-sm font-bold text-negative">
            The checkout was not reversed.
          </p>
          <p className="mt-1 text-sm text-charcoal">{rejection}</p>
          <p className="mt-1.5 text-xs text-charcoal-muted">
            Nothing has changed: the stay is exactly as it was, and the bill is
            untouched.
          </p>
        </div>
      ) : null}
    </FolioActionCard>
  );
}
