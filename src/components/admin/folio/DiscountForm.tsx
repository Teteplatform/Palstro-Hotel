import { useState } from 'react';
import { CurrencyField, TextArea } from '../../ui/form';
import { useToast } from '../../ui/Toast';
import { formatMoney, parseNumeric } from '../../../lib/format';
import {
  applyChargeDiscount,
  folioErrorMessage,
  newIdempotencyKey,
} from '../../../lib/folio';
import type { FolioChargeWithCategory } from '../../../types/folio';
import { FolioActionCard } from './FolioActionCard';

// "Discount" — the accountable one (brief §4).
//
// A DISCOUNT ATTACHES TO A CHARGE, NOT TO THE FOLIO. That is why this action
// opens from a specific line and not from the bill as a whole: the record has to
// say WHICH sale was reduced, by how much, why, and on whose authority. A
// folio-level discount would be an unattributable lump nobody could investigate.
//
// THE PIN RULES, AND WHERE THEY ARE ACTUALLY ENFORCED
// ---------------------------------------------------
// The screen decides whether to SHOW the PIN field:
//   * a COMP (the discount equals the charge's gross — 100% off) ALWAYS needs a
//     manager PIN, whatever the threshold is and however small the amount.
//     Writing a sale off entirely is the easiest way to make a real sale
//     disappear (serve it, comp it, pocket the cash), so it is the one act that
//     most needs a name against it;
//   * otherwise, above the property's discount_threshold needs a PIN; at or below
//     it, the staff member's own authority applies and they are recorded as the
//     approver.
//
// THE UI HINT IS CONVENIENCE. THE RPC IS THE GUARD. apply_charge_discount re-reads
// the threshold from property_finance_settings and re-applies both rules itself,
// so a staffer who somehow submits without a PIN, or a client holding a stale
// threshold, is rejected by the database and the rejection is shown verbatim.
// This is rule 19's shape exactly: two layers guarding different things, neither
// replacing the other. Never move the decision into this file.
//
// THE PIN ITSELF: held in one piece of component state for the duration of one
// call, never written anywhere else, never logged, never included in an error
// message, and cleared in the finally block whether the call succeeded or failed.
// It is not stored in a form draft, and there is no browser storage anywhere in
// this app (constraint).

interface DiscountFormProps {
  charge: FolioChargeWithCategory;
  // The property's PIN-free ceiling. 0 (the default) means EVERY discount needs a
  // manager PIN — the deliberately strict default of 021 §3.
  threshold: number;
  currency: string;
  onDone: () => Promise<void> | void;
  onCancel: () => void;
}

export function DiscountForm({
  charge,
  threshold,
  currency,
  onDone,
  onCancel,
}: DiscountFormProps) {
  const toast = useToast();

  const [amount, setAmount] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  const [pin, setPin] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // numeric(14,2) arrives as a STRING (§6) — parse before comparing. `typeof
  // charge.gross_amount === 'number'` is always false.
  const gross = parseNumeric(charge.gross_amount) ?? 0;
  const existing = parseNumeric(charge.discount_amount) ?? 0;

  const entered = amount ?? 0;
  // A comp is 100% off, compared against GROSS because the discount is absolute
  // and replaces whatever was there before — the same comparison the RPC makes.
  const isComp = entered > 0 && entered >= gross;
  const aboveThreshold = entered > threshold;
  const needsPin = isComp || aboveThreshold;

  const canSubmit =
    amount !== null &&
    amount > 0 &&
    amount <= gross &&
    reason.trim().length > 0 &&
    // The field is required when the UI believes a PIN is needed. If the UI is
    // wrong — a threshold changed under us — the RPC rejects the call and says so.
    (!needsPin || pin.trim().length > 0);

  async function handleSubmit() {
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    try {
      await applyChargeDiscount({
        chargeId: charge.id,
        discountAmount: amount as number,
        reason: reason.trim(),
        // Always pass what was entered — never a UI-side decision to omit it.
        // Null when nothing was typed, so the RPC sees the truth and applies its
        // own rules to it.
        managerPin: pin.trim() || null,
        idempotencyKey: newIdempotencyKey(),
      });
      toast.success(
        needsPin
          ? 'Discount approved and recorded against the approving manager.'
          : 'Discount applied.',
      );
      await onDone();
    } catch (e) {
      // The RPC's own words, verbatim (rule 11 + brief §4): "wrong PIN", "a full
      // comp always requires a manager PIN, whatever the discount threshold", "a
      // discount above the approval threshold (50000.00) requires a valid manager
      // PIN". Each tells the user something different and actionable, which is
      // why folioErrorMessage does not substitute soft copy for a 42501 here.
      toast.error(folioErrorMessage(e));
    } finally {
      // The PIN leaves memory the moment the call is over, success or failure.
      setPin('');
      setSubmitting(false);
    }
  }

  return (
    <FolioActionCard
      title="Discount this charge"
      description={
        <>
          {charge.category?.name ?? 'Charge'}
          {charge.description ? ` — ${charge.description}` : ''} ·{' '}
          {formatMoney(gross, currency)}
          {existing > 0
            ? ` · currently discounted ${formatMoney(existing, currency)}`
            : ''}
        </>
      }
      submitLabel={needsPin ? 'Approve discount' : 'Apply discount'}
      submittingLabel="Applying…"
      submitting={submitting}
      canSubmit={canSubmit}
      onSubmit={() => void handleSubmit()}
      onCancel={onCancel}
    >
      <CurrencyField
        label="Discount amount"
        required
        value={amount}
        onChange={setAmount}
        currency={currency}
        disabled={submitting}
        error={
          amount !== null && amount > gross
            ? `A discount cannot exceed the charge (${formatMoney(gross, currency)}).`
            : undefined
        }
        helpText={
          existing > 0
            ? 'This REPLACES the existing discount on this charge — it is not added to it.'
            : `Up to ${formatMoney(gross, currency)}. Discounting the full amount is a comp.`
        }
      />

      <TextArea
        label="Reason"
        required
        value={reason}
        onChange={setReason}
        rows={2}
        disabled={submitting}
        placeholder="Why is this being discounted?"
        helpText="Recorded on the bill and in the change log. A discount with no reason is not an audit trail."
      />

      {/* The PIN field appears only when approval is required — but the database
          decides, not this component. */}
      {needsPin ? (
        <div className="rounded-lg border border-primary/30 bg-primary/5 p-3">
          <p className="text-xs font-semibold text-charcoal">
            {isComp
              ? 'This is a full comp — a manager must authorise it.'
              : `This is above the approval limit of ${formatMoney(threshold, currency)} — a manager must authorise it.`}
          </p>
          <p className="mt-1 text-xs text-charcoal-muted">
            Ask a manager to enter their PIN. The approval is recorded against
            that manager by name on this charge — not against you.
          </p>
          <label className="mt-2 block">
            <span className="mb-1 block text-sm font-medium text-charcoal">
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
              // 021 §7.1 accepts 4-8 digits; the RPC is the authority on format
              // and rejects anything else with its own message.
              maxLength={8}
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              disabled={submitting}
              aria-label="Manager PIN"
              className="w-full max-w-[12rem] rounded-lg border border-sand-border bg-white/70 px-3 py-2 text-sm tracking-[0.4em] text-charcoal transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream disabled:cursor-not-allowed disabled:opacity-60"
            />
          </label>
          <p className="mt-1.5 text-[11px] text-charcoal-muted">
            The PIN is sent only to the approval check and is cleared from this
            screen the moment it is used. It is never stored or displayed.
          </p>
        </div>
      ) : (
        <p className="text-xs text-charcoal-muted">
          This is within your own approval limit
          {threshold > 0 ? ` of ${formatMoney(threshold, currency)}` : ''}, so no
          manager PIN is needed — and it will be recorded against you.
        </p>
      )}
    </FolioActionCard>
  );
}
