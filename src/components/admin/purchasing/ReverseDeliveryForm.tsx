import { useState } from 'react';
import { TextField } from '../../ui/form';
import { ManagerPinField } from '../ManagerPinField';
import { FolioActionCard } from '../folio/FolioActionCard';
import { useToast } from '../../ui/Toast';
import { formatDisplayDate } from '../../../lib/date';
import { formatMoney } from '../../../lib/format';
import { humanizeError } from '../../../lib/errors';
import {
  newIdempotencyKey,
  reversePurchaseReceipt,
  type DeliveryGroup,
} from '../../../lib/purchasing';

// UNDOING A DELIVERY (1.1h2d). The three slots rule 25 separates, and this form
// is the reason the rule exists — an irreversible act, decided on one sentence:
//
//   subject  WHICH delivery, with its real figures: "GRN-000003 · 4 Nov ·
//            2 lines · NGN 335,000.00"
//   effect   WHAT UNDOING IT DOES TO THIS ORDER, in this order's numbers: the
//            stock goes back out, the lines return to outstanding, and that
//            much comes off what the supplier is owed. Never behind the icon —
//            somebody at the moment of an irreversible act is deciding on
//            exactly this sentence.
//   about    What a reversal IS, why the delivery stays on record, and why
//            there is no way to undo one line of it. Behind the ⓘ and in the
//            guide, because it reads the same on every delivery ever recorded.
//
// THIS FORM AUTHORS NO REFUSAL (rule 21). It does not restate that a manager is
// needed, that a reason is mandatory, that a delivery is reversed once, or that
// a delivery whose stock was already put back cannot be undone as one act. All
// four live in 056 and arrive as a message with a hint, rendered verbatim.
export function ReverseDeliveryForm({
  delivery,
  orderNumber,
  supplierName,
  currency,
  propertySlug,
  onReversed,
  onCancel,
}: {
  delivery: DeliveryGroup;
  orderNumber: string;
  supplierName: string;
  currency: string;
  propertySlug: string;
  onReversed: () => Promise<void> | void;
  onCancel: () => void;
}) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [pin, setPin] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);

  async function submit() {
    if (submitting) return;
    setSubmitting(true);
    setFormError(null);
    try {
      await reversePurchaseReceipt({
        purchaseReceiptId: delivery.receiptId,
        reason: reason.trim(),
        managerPin: pin,
        idempotencyKey,
      });
      toast.success(`${delivery.receiptNumber} reversed.`);
      // A NEW KEY. The one just used belongs to the reversal that landed, and
      // the server hands the same row back for it rather than doing anything
      // twice — which is correct, and is not what the next act wants.
      setIdempotencyKey(newIdempotencyKey());
      await onReversed();
    } catch (e) {
      setFormError(humanizeError(e)); // rules 11, 21 — the server's own words
    } finally {
      // NEVER KEPT. The PIN exists for the length of one call.
      setPin('');
      setSubmitting(false);
    }
  }

  return (
    <FolioActionCard
      title={`Reverse ${delivery.receiptNumber}`}
      destructive
      propertySlug={propertySlug}
      subject={`${delivery.receiptNumber} · ${formatDisplayDate(delivery.businessDate)} · ${
        delivery.lineCount === 1 ? '1 line' : `${delivery.lineCount} lines`
      } · ${formatMoney(delivery.value, currency)} from ${supplierName}`}
      effect={
        <>
          {delivery.movesStock
            ? 'The stock this delivery brought in goes back out, valued at what it came in at. '
            : 'This delivery moved no stock, so nothing goes back out of a store. '}
          {`Its lines on ${orderNumber} return to outstanding, and ${formatMoney(
            delivery.value,
            currency,
          )} comes off what ${supplierName} is owed.`}
        </>
      }
      about={{
        title: 'Reversing a delivery',
        paragraphs: [
          'A delivery is never edited or deleted — it is the record that goods arrived, and a document a payment will be allocated against. Reversing it posts the opposite of everything it did and leaves both records standing, so the delivery and its undoing are both still there to read afterwards.',
          'It undoes the whole delivery, never one line of it. A delivery with one line wrong is corrected by reversing it and recording what actually arrived: that is a different delivery note, and it gets its own number.',
          'The stock goes back out at the cost it came in at, not at what the item averages today, so reversing a delivery leaves the valuation exactly where it was before the delivery. If the goods have already been issued or used, the position goes negative — that is shown rather than blocked, because a negative is a fact worth seeing and refusing the correction would only produce worse paperwork.',
        ],
        guideAnchor: 'reversing-a-delivery',
        guideLabel: 'Reversing a delivery',
      }}
      submitLabel="Reverse this delivery"
      submittingLabel="Reversing…"
      submitting={submitting}
      canSubmit={reason.trim() !== '' && pin !== ''}
      onSubmit={submit}
      onCancel={onCancel}
    >
      <TextField
        label="Why it is being reversed"
        value={reason}
        onChange={setReason}
        placeholder="Delivered against the wrong order"
        required
      />

      <ManagerPinField
        value={pin}
        onChange={setPin}
        disabled={submitting}
        title="A manager must authorise this reversal"
        lead="Undoing a delivery always needs a PIN, whatever it is worth"
        reason={`it takes ${formatMoney(delivery.value, currency)} off what ${supplierName} is owed${
          delivery.movesStock ? ' and sends the stock back out' : ''
        }.`}
      />

      {formError ? (
        <p
          role="alert"
          className="rounded-xl border border-primary/30 bg-primary/5 p-3 text-xs text-primary"
        >
          {formError}
        </p>
      ) : null}
    </FolioActionCard>
  );
}
