import { useState } from 'react';
import {
  PAYMENT_ABOUT,
  PAYMENT_ABOUT_TITLE,
} from '../../../lib/folioLabels';
import { CurrencyField, DateField, Select, TextField } from '../../ui/form';
import { useToast } from '../../ui/Toast';
import { todayIsoInZone } from '../../../lib/date';
import { folioErrorMessage, newIdempotencyKey, recordPayment } from '../../../lib/folio';
import { PAYMENT_METHODS, paymentMethodLabel } from '../../../lib/folioLabels';
import type { PaymentMethod } from '../../../types/folio';
import { FolioActionCard } from './FolioActionCard';

// "Take payment / Record deposit" (brief §2).
//
// A DEPOSIT AND A PAYMENT ARE THE SAME ACT, so this is one action, not two. The
// folio is opened by a trigger the moment the booking is created (021 §4.1), so a
// guest paying ₦100,000 three weeks before arrival is simply a positive payment on
// an already-open folio: the balance goes negative (the hotel holds their money)
// and nets off as room nights post at each night audit. There is deliberately no
// deposit table, no deposit state and no "convert deposit to payment" step — all
// of which would be extra machinery holding the same fact, and a second place for
// the money to be recorded differently.
//
// RULE 10: THE AMOUNT STARTS EMPTY. Nothing pre-fills the balance due, no "settle
// in full" shortcut. A pre-filled amount produces false-positive full payments
// nobody verified — the cashier tabs past a number they never read, and the folio
// says settled when the guest handed over less.

interface TakePaymentFormProps {
  folioId: string;
  currency: string;
  // The PROPERTY's IANA timezone, so "today" is the hotel's operating day and not
  // the browser's (rules 8, 12). A payment keyed at 00:30 in Lagos by a manager
  // whose laptop is on UTC must still land on the right business date.
  timezone: string;
  // ---- STANDALONE MODE (2.txt §2) ------------------------------------------
  // A payment on the guest's NON-RESIDENT folio is the same act against a
  // different folio — same RPC, same idempotency, same business date — so it is
  // the same form with its words changed, not a second payment screen that could
  // drift from this one. The only behavioural difference is that the reference
  // becomes REQUIRED: a payment tied to no stay is unexplainable a month later
  // unless the person taking it says what it was for.
  title?: string;
  // What the payment is being taken against, when the screen around it does
  // not already say. The general explanation is behind the ⓘ (rule 25).
  subject?: string;
  propertySlug?: string;
  referenceLabel?: string;
  referenceHelp?: string;
  referencePlaceholder?: string;
  referenceRequired?: boolean;
  onDone: () => Promise<void> | void;
  onCancel: () => void;
}

export function TakePaymentForm({
  folioId,
  currency,
  timezone,
  title = 'Take payment',
  subject,
  propertySlug,
  referenceLabel = 'Reference',
  referenceHelp,
  referencePlaceholder = 'Optional — teller no., POS slip, transfer ref',
  referenceRequired = false,
  onDone,
  onCancel,
}: TakePaymentFormProps) {
  const toast = useToast();

  // Empty. Deliberately (rule 10).
  const [amount, setAmount] = useState<number | null>(null);
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [reference, setReference] = useState('');
  const [date, setDate] = useState(todayIsoInZone(timezone));
  const [submitting, setSubmitting] = useState(false);

  const canSubmit =
    amount !== null &&
    amount !== 0 &&
    date !== '' &&
    (!referenceRequired || reference.trim().length > 0);

  async function handleSubmit() {
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    try {
      // A fresh key per submit intent (rules 2/3). A double-click cannot record
      // the payment twice — the DB's folio_payments_idem_uniq index is the true
      // guard, and record_payment returns the FIRST row rather than inserting a
      // second. The disabled button below is the visible half of the same promise.
      await recordPayment({
        folioId,
        amount: amount as number,
        method,
        reference: reference.trim() || null,
        paymentDate: date || null,
        idempotencyKey: newIdempotencyKey(),
      });
      toast.success('Payment recorded.');
      // Re-read the folio from the database — never patch a balance locally
      // (rule 6). The new balance comes from folio_totals, not from arithmetic
      // performed here.
      await onDone();
    } catch (e) {
      // Rule 11: surface the real failure, never swallow it. folioErrorMessage
      // keeps the RPC's own words (folio closed, unknown method, amount zero).
      toast.error(folioErrorMessage(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <FolioActionCard
      title={title}
      subject={subject}
      about={{
        title: PAYMENT_ABOUT_TITLE,
        paragraphs: PAYMENT_ABOUT,
        guideAnchor: 'taking-a-payment-or-a-deposit',
        guideLabel: 'Taking a payment or a deposit',
      }}
      propertySlug={propertySlug}
      submitLabel="Record payment"
      submittingLabel="Recording…"
      submitting={submitting}
      canSubmit={canSubmit}
      onSubmit={() => void handleSubmit()}
      onCancel={onCancel}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <CurrencyField
          label="Amount"
          required
          value={amount}
          onChange={setAmount}
          currency={currency}
          disabled={submitting}
          // Signed, per 021 §6: a refund is a NEGATIVE payment on the same folio,
          // which is why there is no direction toggle here to contradict the sign.
          helpText="Type the amount received. Enter a negative amount to record a refund."
        />
        <Select
          label="Method"
          required
          value={method}
          onChange={(v) => setMethod(v as PaymentMethod)}
          disabled={submitting}
          options={PAYMENT_METHODS.map((m) => ({
            value: m,
            label: paymentMethodLabel(m),
          }))}
        />
        <TextField
          label={referenceLabel}
          required={referenceRequired}
          value={reference}
          onChange={setReference}
          disabled={submitting}
          placeholder={referencePlaceholder}
          helpText={referenceHelp}
        />
        <DateField
          label="Payment date"
          required
          value={date}
          onChange={setDate}
          disabled={submitting}
          helpText="The business date this money belongs to — the operating day the cash-up will look for it on."
        />
      </div>
    </FolioActionCard>
  );
}
