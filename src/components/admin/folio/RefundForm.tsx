import { useState } from 'react';
import { CurrencyField, Select, TextArea, TextField } from '../../ui/form';
import { useToast } from '../../ui/Toast';
import { formatMoney } from '../../../lib/format';
import {
  PAYMENT_METHODS,
  paymentMethodLabel,
  REFUND_ABOUT,
  REFUND_ABOUT_TITLE,
} from '../../../lib/folioLabels';
import {
  folioErrorMessage,
  newIdempotencyKey,
  recordRefund,
} from '../../../lib/folio';
import type { PaymentMethod } from '../../../types/folio';
import { FolioActionCard } from './FolioActionCard';
import { ManagerPinField } from '../ManagerPinField';

// GIVING MONEY BACK (1.1h4a) — the screen half of 067.
//
// ----------------------------------------------------------------------------
// WHY THIS SCREEN EXISTS, WHICH IS A GAP WE OPENED OURSELVES
// ----------------------------------------------------------------------------
// Until 067 a refund was a MINUS SIGN in the payment box, and the payment form
// said so in its help text. That path had no approval, no reason, and no limit:
// measured as an ordinary member of the tenant, record_payment(folio, -50000,
// 'cash') was accepted, credited cash and debited the guest ledger. Fifty
// thousand naira out of the till with nothing on the row to read it against —
// while the SAME movement through reverse_payment demanded a manager's PIN.
//
// 067 closed the hole and, in doing so, left the act unreachable: the minus sign
// is refused by name and record_refund had no caller. Reversing a WHOLE payment
// still worked, so a full give-back was reachable; a guest who paid ₦50,000 and
// left early owed ₦20,000 back was not. This is that button.
//
// ----------------------------------------------------------------------------
// IT IS A FOLIO-LEVEL ACTION, NOT A ROW ACTION ON A PAYMENT
// ----------------------------------------------------------------------------
// record_refund takes a FOLIO and has no payment as its target, which is exactly
// why it is not called refund_payment. A row action in a payment's own menu
// would read as "refund this payment" — an affordance implying a target the act
// does not have — and that act already exists one item above it, as Reverse.
// The two stay visibly different, the way 031 made void and reverse different.
//
// ----------------------------------------------------------------------------
// THE AMOUNT STARTS EMPTY (rule 10), AND THE CEILING IS NOT A PREFILL
// ----------------------------------------------------------------------------
// The subject line names what this folio has received, because that is the most
// a refund can be. Nothing is filled in: the person types the amount. Those are
// different things and the distinction is worth stating rather than leaving to
// be re-litigated — a figure DISPLAYED tells somebody the limit before they
// type, a figure PLACED IN THE BOX gets accepted without being read, which is
// the false-positive rule 10 exists to prevent.
//
// ----------------------------------------------------------------------------
// THE EFFECT LINE STATES THE RESULTING BALANCE, NOT A DIRECTION
// ----------------------------------------------------------------------------
// The first draft read "the balance goes up by X — the guest owes that again",
// and it is wrong on one side of zero. Take 067's own example: ₦50,000 received
// against no charges, refund ₦20,000. The balance moves from -50,000 to -30,000
// — up, and the guest owes nothing before OR after. That sentence would have
// told the receptionist he owed ₦20,000.
//
// A sentence that is true on one side of zero and false on the other is worse
// than a figure with no sentence, because it reads fluently and gets believed.
// So the effect names the RESULTING Outstanding Balance, in the bill's own
// label and with the bill's own sign, and only characterises it when the figure
// itself says so. BalanceRow's rule, verbatim: above zero the guest owes; at or
// below zero nothing is owed, because the hotel is holding their money.

interface RefundFormProps {
  folioId: string;
  currency: string;
  // What this folio has actually received, net — the ceiling record_refund
  // enforces, read from the same folio_totals the bill above is printed from so
  // the screen and the guard cannot disagree about what fits.
  received: number;
  // The CURRENT Outstanding Balance, for the effect line. Signed exactly as the
  // bill shows it.
  balance: number;
  propertySlug: string;
  onDone: () => Promise<void> | void;
  onCancel: () => void;
}

export function RefundForm({
  folioId,
  currency,
  received,
  balance,
  propertySlug,
  onDone,
  onCancel,
}: RefundFormProps) {
  const toast = useToast();
  // Empty. Deliberately (rule 10).
  const [amount, setAmount] = useState<number | null>(null);
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [reference, setReference] = useState('');
  const [reason, setReason] = useState('');
  const [pin, setPin] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const canSubmit =
    amount !== null &&
    amount > 0 &&
    reason.trim().length > 0 &&
    pin.trim().length > 0 &&
    !submitting;

  async function handleSubmit() {
    if (!canSubmit || amount === null) return;
    setSubmitting(true);
    try {
      await recordRefund({
        folioId,
        // POSITIVE: how much to hand over. record_refund writes the negative
        // payment itself, so there is no sign for this screen to get wrong.
        amount,
        method,
        reference: reference.trim() === '' ? null : reference.trim(),
        reason: reason.trim(),
        managerPin: pin.trim(),
        idempotencyKey: newIdempotencyKey(),
      });
      toast.success(
        'Refund recorded. It is on the bill and the approval is recorded against the manager.',
      );
      await onDone();
    } catch (e) {
      // THE DATABASE'S OWN WORDS, hint included, never re-worded (rule 21). Each
      // of these says something different and actionable: "A refund of … is more
      // than the … this folio has received" with its hint naming petty cash, "A
      // refund always requires a valid manager PIN", "A refund needs a reason",
      // "Folio … is closed and cannot take payments".
      toast.error(folioErrorMessage(e));
    } finally {
      // The PIN leaves memory the moment the call is over, success or failure.
      setPin('');
      setSubmitting(false);
    }
  }

  return (
    <FolioActionCard
      title="Refund money to the guest"
      subject={
        <>
          This folio has received <strong>{formatMoney(received, currency)}</strong>,
          which is the most that can be refunded.
        </>
      }
      effect={<RefundEffect amount={amount} balance={balance} currency={currency} />}
      about={{
        title: REFUND_ABOUT_TITLE,
        paragraphs: REFUND_ABOUT,
        guideAnchor: 'refunding-money',
        guideLabel: 'Refunding money',
      }}
      propertySlug={propertySlug}
      submitLabel="Record refund"
      submittingLabel="Recording…"
      submitting={submitting}
      canSubmit={canSubmit}
      destructive
      onSubmit={() => void handleSubmit()}
      onCancel={onCancel}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <CurrencyField
          label="Amount to refund"
          required
          value={amount}
          onChange={setAmount}
          currency={currency}
          disabled={submitting}
          helpText="Type the amount you are handing back."
        />
        <Select
          label="How it is going back"
          required
          value={method}
          onChange={(v) => setMethod(v as PaymentMethod)}
          disabled={submitting}
          options={PAYMENT_METHODS.map((m) => ({
            value: m,
            label: paymentMethodLabel(m),
          }))}
          // IT DOES NOT HAVE TO MATCH THE ORIGINAL PAYMENT'S METHOD, and that is
          // not a validation we chose to skip — it is a thing this shape cannot
          // express. record_refund takes a FOLIO and has no payment as its
          // target, which is the same property that made record_refund the right
          // name rather than refund_payment. There is no "original" here to
          // match against.
          //
          // THE DAY A REFUND MUST MATCH ITS ORIGINAL PAYMENT'S METHOD, the act
          // needs a payment target — and at that point it is reverse_payment's
          // shape, not this one, and belongs on that menu rather than widening
          // this form. Picking what actually happened is correct in the meantime:
          // a transfer in, refunded in cash at the desk, is an ordinary evening.
          helpText="Whatever you actually did — it need not match how the money came in."
        />
      </div>

      <TextField
        label="Reference"
        value={reference}
        onChange={setReference}
        disabled={submitting}
        placeholder="Optional — transfer ref, POS slip, cash-up note"
      />

      <TextArea
        label="Reason for the refund"
        required
        value={reason}
        onChange={setReason}
        rows={2}
        disabled={submitting}
        placeholder="e.g. guest left two nights early, deposit returned at checkout"
        helpText="Kept on the refund itself, so the bill and the statement both say why. Permanent."
      />

      {/* THE SHARED CONTROL, and this is its FIRST FOLIO CONSUMER. Four reversal
          forms beside this one still hand-roll a block identical to it; that
          conversion is 1.1h4b1 and deliberately not folded in here (see
          ManagerPinField's own header for why the proof is the reason). */}
      <ManagerPinField
        value={pin}
        onChange={setPin}
        disabled={submitting}
        title="A manager must authorise this refund"
        reason="This is cash leaving the building, and no amount is small enough to skip it."
      />
    </FolioActionCard>
  );
}

// THE RESULTING BALANCE, IN THE BILL'S OWN TERMS — extracted so the render proof
// can drive all three sides of zero without a folio, and so the direction can be
// asserted rather than eyeballed.
//
// `balance` is signed as the bill shows it: above zero the guest owes, at or
// below zero the hotel is holding their money (BalanceRow's rule). A refund
// reduces what the folio has received, so it RAISES the balance by its amount —
// which is why the figure, not the direction, is what gets stated.
export function RefundEffect({
  amount,
  balance,
  currency,
}: {
  amount: number | null;
  balance: number;
  currency: string;
}) {
  if (amount === null || amount <= 0) {
    // NOT a guess at zero. Until there is an amount there is no effect to state,
    // and inventing one would mean the line said something before the person
    // had decided anything.
    return <>Type an amount to see what it does to this bill.</>;
  }

  const after = balance + amount;
  const figure = <strong>{formatMoney(after, currency)}</strong>;

  if (after > 0) {
    return <>Outstanding Balance becomes {figure}, which the guest owes.</>;
  }
  if (after === 0) {
    return <>Outstanding Balance becomes {figure} — the account is exactly settled.</>;
  }
  return (
    <>
      Outstanding Balance becomes {figure}, which is money the hotel is still
      holding for the guest.
    </>
  );
}
