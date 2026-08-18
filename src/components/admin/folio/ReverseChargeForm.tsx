import { useState } from 'react';
import { TextArea } from '../../ui/form';
import { useToast } from '../../ui/Toast';
import { LockIcon } from '../../ui/icons';
import { formatMoney } from '../../../lib/format';
import { formatDisplayDate } from '../../../lib/date';
import {
  folioErrorMessage,
  newIdempotencyKey,
  reverseCharge,
  reverseDiscount,
} from '../../../lib/folio';
import type { FolioChargeWithCategory } from '../../../types/folio';
import { FolioActionCard } from './FolioActionCard';

// "Reverse charge" and "Reverse discount" (2.txt part 2) — ONE screen, two acts,
// deliberately kept in one file so the PIN block, the reason field and the
// error handling cannot drift apart between them, and deliberately LABELLED
// APART so a receptionist is never in doubt about which undoing they are asking
// for.
//
// THE TWO ACTS, IN THE WORDS THE SCREEN USES:
//
//   REVERSE CHARGE   — "take the whole line off the bill." The counter-entry
//                      mirrors the charge including its discount, so the balance
//                      returns to exactly what it was before the charge existed,
//                      tax included. Used when the item should not have been
//                      billed at all.
//   REVERSE DISCOUNT — "put the price back up." The charge STAYS; only the
//                      reduction is undone, so the balance RISES by the discount
//                      and its tax. Used when a discount was given in error, or
//                      to the wrong guest, or beyond what was agreed.
//
// Getting these the wrong way round is the confusion the brief asks to design
// out, so the two are never a single "Reverse" with a mode dropdown: they are
// two separately-named menu items, each opening this card with its own title,
// its own sentence about what will happen, and its own figure — the amount that
// will actually move.
//
// REVERSE IS NOT VOID (031's distinction, unchanged):
//   VOID    — "this never should have been recorded." A same-moment keying
//             mistake. The line drops out of the totals. No PIN.
//   REVERSE — "this WAS recorded and WAS relied upon." The line keeps counting,
//             because it happened, and a second line undoes it with a manager's
//             name on it.
//
// A MANAGER PIN IS ALWAYS REQUIRED, for both acts, with no threshold. Removing a
// charge that was already billed is the single most useful act to someone who
// served an item and pocketed the cash; and restoring a price the guest may
// already have been quoted raises what they owe, which is not a thing to do on
// one person's word. The RPCs refuse the call outright without a valid PIN
// (rule 19: the screen is convenience, the database is the guard).
//
// THE PIN ITSELF: one piece of component state for the duration of one call,
// never written anywhere else, never logged, never included in an error message,
// and cleared in the finally block whether the call succeeded or failed. There is
// no browser storage anywhere in this app (constraint).

export type ChargeReversalMode = 'charge' | 'discount';

interface ReverseChargeFormProps {
  mode: ChargeReversalMode;
  charge: FolioChargeWithCategory;
  currency: string;
  onDone: () => Promise<void> | void;
  onCancel: () => void;
}

export function ReverseChargeForm({
  mode,
  charge,
  currency,
  onDone,
  onCancel,
}: ReverseChargeFormProps) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [pin, setPin] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const canSubmit = reason.trim().length > 0 && pin.trim().length > 0;

  // §6: every numeric column arrives as a STRING — parse before any arithmetic.
  // Already numbers (rule 24) — parsed when the folio's charges were read.
  const gross = charge.gross_amount;
  const discount = charge.discount_amount;
  const net = charge.net_amount;
  const isDiscountMode = mode === 'discount';

  // THE FIGURE THAT WILL MOVE. Shown before the tax, because the tax follows the
  // net automatically and the screen must not restate the engine's arithmetic as
  // if it were its own (rule 6 — nothing here computes a balance). The card says
  // which way the balance goes; folio_totals says by how much once it has.
  const movingAmount = isDiscountMode ? discount : net;

  async function handleSubmit() {
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    try {
      const call = isDiscountMode ? reverseDiscount : reverseCharge;
      await call({
        chargeId: charge.id,
        reason: reason.trim(),
        managerPin: pin.trim(),
        // A fresh key per submit INTENT. It cannot cause a double post either
        // way: both RPCs also refuse a charge that already carries a reversal of
        // that kind, whatever key arrives, under a lock on the original row, and
        // the counter-entry itself uses a deterministic key.
        idempotencyKey: newIdempotencyKey(),
      });
      toast.success(
        isDiscountMode
          ? 'Discount reversed. The charge is back at its full amount and the approval is recorded against the manager.'
          : 'Charge reversed. The counter-entry is on the bill and the approval is recorded against the manager.',
      );
      await onDone();
    } catch (e) {
      // The RPC's OWN words, verbatim: "Reversing a charge always requires a
      // valid manager PIN", "Charge … is voided; it counts for nothing and
      // cannot be reversed", "Charge … carries no discount to reverse", "Folio …
      // is closed". Each says something different and actionable, which is why
      // folioErrorMessage does not substitute soft copy for a 42501 here.
      toast.error(folioErrorMessage(e));
    } finally {
      // The PIN leaves memory the moment the call is over, success or failure.
      setPin('');
      setSubmitting(false);
    }
  }

  const lineSummary = `${charge.category?.name ?? 'Charge'}${
    charge.description ? ` — ${charge.description}` : ''
  } · ${formatDisplayDate(charge.charge_date)}`;

  return (
    <FolioActionCard
      title={isDiscountMode ? 'Reverse the discount on this charge' : 'Reverse this charge'}
      description={
        <>
          {lineSummary}
          <br />
          {isDiscountMode ? (
            <>
              The charge <strong>stays on the bill</strong> and goes back to its
              full {formatMoney(gross, currency)}. Only the{' '}
              {formatMoney(discount, currency)} discount is undone, so the
              balance goes <strong>up</strong> by that amount and the tax on it.
              The original discount, its reason and the manager who approved it
              all stay on the record.
            </>
          ) : (
            <>
              The whole line comes off: a matching counter-entry of{' '}
              {formatMoney(net, currency)}
              {discount > 0
                ? ` (the net after the ${formatMoney(discount, currency)} discount)`
                : ''}{' '}
              is posted against it, so the balance goes{' '}
              <strong>down</strong> by that amount and its tax. Nothing is
              deleted — the original line and the counter-entry both stay on the
              bill permanently.
            </>
          )}
        </>
      }
      submitLabel={isDiscountMode ? 'Reverse discount' : 'Reverse charge'}
      submittingLabel="Reversing…"
      submitting={submitting}
      canSubmit={canSubmit}
      destructive
      onSubmit={() => void handleSubmit()}
      onCancel={onCancel}
    >
      {/* The one figure that matters, stated plainly and in the direction it
          moves — the two acts differ by exactly this, so it is the loudest thing
          on the card after the title. */}
      <p className="rounded-xl border border-sand-border bg-sand/40 px-3 py-2 text-sm text-charcoal">
        The guest will owe{' '}
        <strong>
          {formatMoney(Math.abs(movingAmount), currency)}{' '}
          {isDiscountMode ? 'more' : 'less'}
        </strong>
        , plus the tax that follows it. The new balance is recalculated by the
        folio itself — nothing on this screen estimates it.
      </p>

      <TextArea
        label={
          isDiscountMode
            ? 'Reason for reversing the discount'
            : 'Reason for the reversal'
        }
        required
        value={reason}
        onChange={setReason}
        rows={2}
        disabled={submitting}
        placeholder={
          isDiscountMode
            ? 'e.g. discount applied to the wrong line, rate not agreed by the manager'
            : 'e.g. item never delivered, posted to the wrong folio after the guest checked out'
        }
        helpText="Printed on the counter-entry itself, so the bill and the guest's statement both say why. Permanent."
      />

      {/* ALWAYS shown — never conditional, unlike the discount screen's field. */}
      <div className="rounded-xl border-2 border-primary/40 bg-primary/5 p-3 sm:p-4">
        <p className="flex flex-wrap items-center gap-2 text-sm font-bold text-primary">
          <LockIcon className="h-5 w-5 shrink-0" />A manager must authorise this
          reversal
        </p>
        <p className="mt-1.5 text-xs text-charcoal">
          {isDiscountMode
            ? 'Every reversal needs a PIN, whatever the amount — this puts a price back up after a discount a manager already approved.'
            : 'Every reversal needs a PIN, whatever the amount — this takes a charge the hotel has already billed back off the bill.'}{' '}
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
