import { useState } from 'react';
import { TextArea } from '../../ui/form';
import { useToast } from '../../ui/Toast';
import { formatDisplayDate } from '../../../lib/date';
import { formatQuantity, MISSING_VALUE, parseNumeric } from '../../../lib/format';
import { reverseStockMovement, stockErrorMessage } from '../../../lib/stock';
import {
  movementTypeLabel,
  REVERSAL_PERMANENCE_NOTE,
  REVERSAL_POSTS_TODAY_NOTE,
} from '../../../lib/stockLabels';
import type { StockLedgerRow } from '../../../types/stock';
import { FolioActionCard } from '../folio/FolioActionCard';
import { ManagerPinField } from '../ManagerPinField';

// REVERSING A STOCK MOVEMENT (migration 038 §7) — the same act, and therefore
// the same shape, as every other reversal in this product: a card, a mandatory
// reason, a manager's PIN with no threshold, and the server's own words when it
// refuses.
//
// ----------------------------------------------------------------------------
// WHY THIS LIVES ON THE ITEM LEDGER AND NOWHERE ELSE
// ----------------------------------------------------------------------------
// The item ledger is the only surface with the context needed to make the
// decision: one item, one location, the running quantity and the running average
// cost visible on every line. Reversing from a flat cross-item movement list is
// the sort of thing people do by mistake — the row looks the same as the row
// above it, and the consequence is invisible until the valuation moves.
//
// The Adjustments list still SHOWS reversals, distinctly typed, so nobody there
// is misled into thinking they do not exist. It just does not act on them.
//
// ----------------------------------------------------------------------------
// EVERY REFUSAL IS THE SERVER'S OWN SENTENCE, VERBATIM
// ----------------------------------------------------------------------------
// 038 raises five distinct refusals from this one call, and every one of them
// already names the specific thing in the way:
//
//   PT409  already reversed (and on which date) / is itself a reversal /
//          is an opening balance / the location or item is switched off (named)
//   PT422  no reason, or the movement has no recorded cost to unwind
//   PT423  the posting lock, naming the lock date AND the attempted date
//   42501  wrong or missing manager PIN
//
// NOTHING IN THIS FILE RESTATES ANY OF THAT. stockErrorMessage returns the
// server's message and appends its HINT, which is where 038 puts the way out
// ("Switch it back on (or restore it) first", "Post an adjustment for the
// difference instead"). A client that re-worded these would be a second source
// of truth about rules that live in the database, and it would drift the first
// time one of them changed.
//
// What this screen DOES say is what the button is about to do — which is the
// client's job, and stops exactly where the server's begins.

interface ReverseMovementFormProps {
  movement: StockLedgerRow;
  itemName: string;
  locationName: string;
  baseUnit: string;
  onDone: () => Promise<void> | void;
  onCancel: () => void;
}

export function ReverseMovementForm({
  movement,
  itemName,
  locationName,
  baseUnit,
  onDone,
  onCancel,
}: ReverseMovementFormProps) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [pin, setPin] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // The server's refusal, shown in place rather than only as a toast: these
  // sentences are long, actionable, and often name a thing the user has to go
  // and change first. A toast that disappears is the wrong container for
  // "switch the location back on, then come back".
  const [formError, setFormError] = useState<string | null>(null);

  const canSubmit = reason.trim().length > 0 && pin.trim().length > 0;

  // §6: every numeric column arrives as a STRING — parse before any arithmetic.
  const quantity = parseNumeric(movement.quantity) ?? 0;
  // The counter negates the original, so this is what will move and in which
  // direction. Stated as a quantity in the item's own unit, because that is what
  // the storekeeper can check against the shelf.
  const counterQuantity = -quantity;
  const putsStockBack = counterQuantity > 0;

  async function handleSubmit() {
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    setFormError(null);
    try {
      await reverseStockMovement({
        movementId: movement.id,
        reason: reason.trim(),
        managerPin: pin.trim(),
        // NO idempotency key, deliberately. 038 draws the distinction: a key the
        // caller supplies means "one request of mine, possibly retried" and is
        // replayed; omitting it means "reverse this", and a second press is
        // answered with the state — "already reversed on 16 Aug 2026". A person
        // pressing the button twice IS asking twice, and should be told so
        // rather than silently handed the first counter as if it were new.
      });
      toast.success(
        'Movement reversed. The counter is on the ledger today and the approval is recorded against the manager.',
      );
      await onDone();
    } catch (e) {
      // The RPC's OWN words, plus its hint. Never re-worded here.
      const message = stockErrorMessage(e);
      setFormError(message);
      toast.error(message);
    } finally {
      // The PIN leaves memory the moment the call is over, success or failure.
      setPin('');
      setSubmitting(false);
    }
  }

  return (
    <FolioActionCard
      title="Reverse this movement"
      description={
        <>
          {movementTypeLabel(movement.movement_type)} of{' '}
          {formatQuantity(movement.quantity)} {baseUnit} · {itemName} ·{' '}
          {locationName} · {formatDisplayDate(movement.business_date)}
        </>
      }
      submitLabel="Reverse movement"
      submittingLabel="Reversing…"
      submitting={submitting}
      canSubmit={canSubmit}
      destructive
      onSubmit={() => void handleSubmit()}
      onCancel={onCancel}
    >
      {/* WHAT WILL HAPPEN, before it happens — the item, the location, the
          quantity that moves and which way, and the date it lands on. Each of
          these is a fact about the request being assembled, not a restatement of
          a rule the database enforces. */}
      <div className="rounded-xl border border-sand-border bg-sand/40 px-3 py-2.5 text-sm text-charcoal">
        <p>
          <strong>
            {formatQuantity(Math.abs(counterQuantity))} {baseUnit}
          </strong>{' '}
          {putsStockBack ? 'goes back into' : 'comes out of'}{' '}
          <strong>{locationName}</strong> for <strong>{itemName}</strong>.
        </p>
        <p className="mt-1.5 text-xs text-charcoal-muted">
          {REVERSAL_POSTS_TODAY_NOTE}
        </p>
        <p className="mt-1.5 text-xs text-charcoal-muted">
          {REVERSAL_PERMANENCE_NOTE}
        </p>
      </div>

      {/* The cost the counter will carry, when the ledger knows it. This is READ
          from the movement, never recomputed here — 038 stamps carried_unit_cost
          at the moment stock leaves, and CLAUDE.md §6 forbids re-deriving it.
          A stock-IN carries its own stated unit_cost instead. */}
      <p className="text-xs text-charcoal-muted">
        The reversal unwinds exactly what this movement moved, at{' '}
        <strong>
          {movement.carried_unit_cost ?? movement.unit_cost
            ? `${movement.carried_unit_cost ?? movement.unit_cost} per ${baseUnit}`
            : MISSING_VALUE}
        </strong>
        , so the average cost in this location returns to where it was — not to
        something approximately right.
      </p>

      <TextArea
        label="Reason for the reversal"
        required
        value={reason}
        onChange={setReason}
        rows={2}
        disabled={submitting}
        placeholder="e.g. delivery was rejected at the gate, keyed against the wrong item"
        helpText="Kept permanently on the counter-movement and on the reversal record, in your name."
      />

      <ManagerPinField
        value={pin}
        onChange={setPin}
        disabled={submitting}
        reason="this puts a movement the ledger has already counted back the other way, and stock figures have been read since."
      />

      {/* The server's refusal, in full, in place. Shown here as well as in the
          toast because these sentences carry an instruction the user has to act
          on before trying again. */}
      {formError ? (
        <p
          role="alert"
          className="rounded-xl border border-primary/40 bg-primary/5 px-3 py-2.5 text-sm text-charcoal"
        >
          {formError}
        </p>
      ) : null}
    </FolioActionCard>
  );
}
