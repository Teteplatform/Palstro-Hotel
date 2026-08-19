import { useState } from 'react';
import { TextArea } from '../../ui/form';
import { useToast } from '../../ui/Toast';
import { LockIcon } from '../../ui/icons';
import { formatMoney } from '../../../lib/format';
import { formatDisplayDate } from '../../../lib/date';
import { paymentMethodLabel,
  VOID_ABOUT,
  VOID_ABOUT_TITLE,
} from '../../../lib/folioLabels';
import {
  folioErrorMessage,
  newIdempotencyKey,
  reversePayment,
} from '../../../lib/folio';
import type { FolioPayment } from '../../../types/folio';
import { FolioActionCard } from './FolioActionCard';

// "Reverse" a payment (2.txt part 1) — the accountable undoing.
//
// REVERSE IS NOT VOID, AND THE TWO MUST NOT BE OFFERED AS THE SAME THING:
//
//   VOID    — "this never should have been recorded." A same-moment keying
//             mistake: the amount was mistyped, it went on the wrong folio, the
//             transfer never cleared. The line drops out of the totals. No PIN,
//             because nothing was ever relied upon.
//   REVERSE — "this WAS recorded, it WAS relied upon, and it must now be
//             undone." A receipt was issued, a statement was emailed, a balance
//             was quoted down the phone. The payment keeps counting, because it
//             happened, and a SECOND line — the counter-entry — puts the money
//             back, with a manager's name on it.
//
// So this action posts an EQUAL AND OPPOSITE counter-payment through the same
// engine the original went through; it never edits or deletes the original. Both
// lines stay on the bill forever, and a permanent reversals row records who
// authorised it and why.
//
// A MANAGER PIN IS ALWAYS REQUIRED — there is no threshold, unlike a discount.
// A reversal changes the RECORD of money received, which is worth exactly as much
// to a person stealing cash at ₦5,000 as at ₦500,000. The field is therefore
// never conditional here, and reverse_payment refuses the call outright without
// one (rule 19: the screen is convenience, the database is the guard).
//
// THE PIN ITSELF: one piece of component state for the duration of one call,
// never written anywhere else, never logged, never included in an error message,
// and cleared in the finally block whether the call succeeded or failed. There is
// no browser storage anywhere in this app (constraint).

interface ReversePaymentFormProps {
  // For the ⓘ's link into this property's copy of the staff guide.
  propertySlug: string;
  payment: FolioPayment;
  currency: string;
  onDone: () => Promise<void> | void;
  onCancel: () => void;
}

export function ReversePaymentForm({
  payment,
  propertySlug,
  currency,
  onDone,
  onCancel,
}: ReversePaymentFormProps) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [pin, setPin] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const canSubmit = reason.trim().length > 0 && pin.trim().length > 0;

  async function handleSubmit() {
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    try {
      await reversePayment({
        paymentId: payment.id,
        reason: reason.trim(),
        managerPin: pin.trim(),
        // A fresh key per submit INTENT. It cannot cause a double post either
        // way: reverse_payment also refuses a payment that already carries a
        // reversal, whatever key arrives, under a lock on the original row.
        idempotencyKey: newIdempotencyKey(),
      });
      toast.success(
        'Payment reversed. The counter-entry is on the bill and the approval is recorded against the manager.',
      );
      await onDone();
    } catch (e) {
      // The RPC's OWN words, verbatim: "Reversing a payment always requires a
      // valid manager PIN", "Payment … is voided; it counts for nothing and
      // cannot be reversed", "A reversal needs a reason", "Folio … is closed".
      // Each says something different and actionable, which is why
      // folioErrorMessage does not substitute soft copy for a 42501 here.
      toast.error(folioErrorMessage(e));
    } finally {
      // The PIN leaves memory the moment the call is over, success or failure.
      setPin('');
      setSubmitting(false);
    }
  }

  return (
    <FolioActionCard
      title="Reverse this payment"
      subject={
        <>
          {paymentMethodLabel(payment.method)} ·{' '}
          {formatMoney(payment.amount, currency)} ·{' '}
          {formatDisplayDate(payment.payment_date)}
          {payment.reference ? ` · ref ${payment.reference}` : ''}
        </>
      }
      effect={
        <>
          The balance goes back up by{' '}
          <strong>{formatMoney(payment.amount, currency)}</strong>.
        </>
      }
      about={{
        title: VOID_ABOUT_TITLE,
        paragraphs: VOID_ABOUT,
        guideAnchor: 'reversing-a-payment',
        guideLabel: 'Reversing a payment',
      }}
      propertySlug={propertySlug}
      submitLabel="Reverse payment"
      submittingLabel="Reversing…"
      submitting={submitting}
      canSubmit={canSubmit}
      destructive
      onSubmit={() => void handleSubmit()}
      onCancel={onCancel}
    >
      <TextArea
        label="Reason for the reversal"
        required
        value={reason}
        onChange={setReason}
        rows={2}
        disabled={submitting}
        placeholder="e.g. transfer recalled by the guest's bank, deposit refunded in cash at the desk"
        helpText="Printed on the counter-entry itself, so the guest's bill and statement both say why. Permanent."
      />

      {/* ALWAYS shown — never conditional, unlike the discount screen's field. */}
      <div className="rounded-xl border-2 border-primary/40 bg-primary/5 p-3 sm:p-4">
        <p className="flex flex-wrap items-center gap-2 text-sm font-bold text-primary">
          <LockIcon className="h-5 w-5 shrink-0" />A manager must authorise this
          reversal
        </p>
        <p className="mt-1.5 text-xs text-charcoal">
          Every reversal needs a PIN, whatever the amount — this changes the
          record of money the hotel has already been paid. Hand the terminal to a
          manager: the approval is recorded{' '}
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
            onChange={(e) => setPin(e.target.value)}
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
    </FolioActionCard>
  );
}
