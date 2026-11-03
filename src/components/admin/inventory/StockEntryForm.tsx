import { useCallback, useEffect, useState } from 'react';
import { CurrencyField, DateField, NumberField, TextField } from '../../ui/form';
import { useToast } from '../../ui/Toast';
import { todayIsoInZone } from '../../../lib/date';
import { describeError } from '../../../lib/errors';
import { ConfirmGatePanel } from './ConfirmGatePanel';
import { formatMoney, formatQuantity } from '../../../lib/format';
import {
  fetchItemPosition,
  fetchOpeningBalanceKeys,
  newIdempotencyKey,
  openingKey,
  postOpeningBalance,
  postStockAdjustment,
  stockErrorCode,
  stockErrorMessage,
  STOCK_NEEDS_CONFIRMATION,
  STOCK_NEEDS_COST_CONFIRMATION,
} from '../../../lib/stock';
import {
  ADJUSTMENT_REASON_EXPLANATION,
  BATCH_FIELDS_IN_ONLY_NOTE,
  MOVING_AVERAGE_EXPLANATION,
} from '../../../lib/stockLabels';
import type { InventoryItem } from '../../../types/inventory';
import { ItemPicker } from './ItemPicker';
import type { StockOnHandRow } from '../../../types/stock';

// THE MANUAL PATH — an opening balance, or a correction, for one item in one
// location. The spreadsheet import is the bulk path for day one; this is the one
// used every week after that.
//
// TWO MODES IN ONE FORM, deliberately, because they are the same act with
// different rules and a second screen would drift from this one:
//
//   OPENING BALANCE — "this is what was here when we started". Once per item per
//   location (036 refuses a second one), quantity positive, cost REQUIRED
//   because there is no history to infer it from.
//
//   ADJUSTMENT — "this is what it should be". Either direction, REASON
//   MANDATORY, and the cost of an increase defaults to the current average so
//   finding more of the same stock does not silently re-price what was already
//   there.
//
// DIRECTION IS A CHOICE, NOT A MINUS SIGN. The RPC takes a signed quantity, but
// a storekeeper typing "-5" into a box is one missed keystroke away from adding
// five kilos instead of removing them, and the mistake is invisible until a
// count months later. So the form asks which way, in words, and does the
// arithmetic itself.
//
// EVERY GUARD HERE IS A COURTESY (rule 19). The server re-checks all of it: the
// staff gate, the location and item, the future date, the mandatory reason, the
// once-per-location opening, and the negative-stock confirmation. Nothing in
// this file is the guard.

type Mode = 'opening' | 'adjustment';
type Direction = 'add' | 'remove';

interface StockEntryFormProps {
  tenantId: string;
  propertyId: string;
  locationId: string;
  locationName: string;
  currency: string;
  timezone: string;
  // The tenant's active catalogue items, already loaded by the screen.
  items: InventoryItem[];
  // Pre-selected when the form is opened from a row's "Correct stock" action.
  presetItemId?: string;
  presetMode?: Mode;
  onDone: () => Promise<void> | void;
  onCancel: () => void;
}

export function StockEntryForm({
  tenantId,
  propertyId,
  locationId,
  locationName,
  currency,
  timezone,
  items,
  presetItemId,
  presetMode,
  onDone,
  onCancel,
}: StockEntryFormProps) {
  const toast = useToast();
  const today = todayIsoInZone(timezone);

  const [mode, setMode] = useState<Mode>(presetMode ?? 'opening');
  const [itemId, setItemId] = useState(presetItemId ?? '');
  const [direction, setDirection] = useState<Direction>('add');
  const [quantity, setQuantity] = useState<number | null>(null);
  const [unitCost, setUnitCost] = useState<number | null>(null);
  const [date, setDate] = useState(today);
  // 038 §1C. Only ever sent on a stock-IN of an item that tracks them.
  const [batchCode, setBatchCode] = useState('');
  const [expiryDate, setExpiryDate] = useState('');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Which items already have an opening balance HERE, so the opening picker can
  // leave them out rather than offering a choice the server will refuse. Loaded
  // once; the server remains the guard.
  const [openings, setOpenings] = useState<Set<string> | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // The item's CURRENT position, read the moment one is picked. Shown before
  // anything is typed, because "correct this to what it should be" is a
  // different job from "guess at a number".
  const [position, setPosition] = useState<StockOnHandRow | null>(null);
  const [positionLoading, setPositionLoading] = useState(false);

  // A CONFIRM-GATE THE SERVER RAISED. Two of them exist and they ask different
  // questions: PT449 is "this leaves less than nothing on hand", PT450 is "we do
  // not know what this stock cost". A back-dated movement against a healthy
  // position trips the second and not the first, which is the gap 050 was built
  // for, so they are never merged into one "are you sure".
  //
  // `allowed` CARRIES FORWARD. A movement can trip both, one after the other, and
  // answering the second must not silently drop the answer to the first. Held
  // with the key that produced it, so confirming re-sends the SAME intent and
  // cannot post twice.
  const [confirm, setConfirm] = useState<{
    message: string;
    key: string;
    gate: 'negative' | 'unvalued';
    signature: string;
    allowed: { negative: boolean; unvalued: boolean };
  } | null>(null);

  // THE CONFIRMATION BELONGS TO THE FORM THAT RAISED IT.
  //
  // 1.1a found this on the receiving screen: a refusal outlived the form it
  // described, and sat there offering a confirmation for an intent nobody was
  // attempting any more. Here it would be worse, because confirming re-sends the
  // SAME idempotency key -- so a panel raised for one date, answered after the
  // date was changed, would be answering with the wrong key for the wrong thing.
  //
  // DERIVED, NOT CLEARED IN EVERY SETTER. A setState from an effect body is the
  // cascading render the linter rightly refuses, and these forms have eight
  // fields; a signature compared during render says the same thing with nothing
  // to keep in step.
  const intentSignature = `${mode}|${locationId}|${itemId}|${direction}|${quantity}|${unitCost}|${date}|${reason}|${note}`;
  const liveConfirm =
    confirm && confirm.signature === intentSignature ? confirm : null;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const keys = await fetchOpeningBalanceKeys(tenantId, propertyId);
        if (!cancelled) setOpenings(keys);
      } catch (e) {
        // Rule 11: surfaced, not swallowed. The form still works — the picker
        // just cannot pre-filter, and the server refuses a duplicate anyway.
        if (!cancelled) setLoadError(describeError(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tenantId, propertyId]);

  // Loads the position for whichever item is selected. It does NOT clear the
  // state when the selection empties — the render below simply ignores a
  // position that belongs to a different item, which also covers the moment
  // between picking a new item and its position arriving (the previous item's
  // figures must never be shown under a new item's name).
  useEffect(() => {
    let cancelled = false;
    if (!itemId) return;
    (async () => {
      setPositionLoading(true);
      try {
        const row = await fetchItemPosition(
          tenantId,
          propertyId,
          locationId,
          itemId,
        );
        if (!cancelled) setPosition(row);
      } catch {
        // A position we could not read is shown as unknown rather than as zero:
        // asserting "nothing on hand" about stock we failed to load is exactly
        // the kind of confident wrong number this codebase avoids.
        if (!cancelled) setPosition(null);
      } finally {
        if (!cancelled) setPositionLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tenantId, propertyId, locationId, itemId]);

  const item = items.find((i) => i.id === itemId) ?? null;
  const baseUnit = item?.base_unit ?? '';

  // An opening balance is always stock coming IN; an adjustment is only stock in
  // when the direction toggle says so. One expression, used by both the batch
  // fields and the submit guard, so the form cannot ask for a batch it then
  // fails to send.
  const isStockIn = mode === 'opening' || direction === 'add';
  const tracksBatch = Boolean(item?.tracks_expiry) && isStockIn;

  // Only ever show a position that belongs to the item currently selected.
  const shownPosition =
    position && position.inventory_item_id === itemId ? position : null;

  // WHY AN ITEM CANNOT BE CHOSEN, in opening mode: it already has an opening
  // balance in this location, and 036 refuses a second one structurally.
  //
  // IT USED TO BE A FILTER over the loaded catalogue, and it deliberately is not one
  // any more. Two reasons, and the second is the one that made it wrong rather than
  // merely unhelpful:
  //   * a dropped row is indistinguishable from an item that does not exist, so the
  //     storekeeper searching for Rice learns nothing about why it is missing;
  //   * now that the search is the server's, removing rows from the RESULT would mean
  //     a query that matched twenty items could display two — which reads as "no
  //     matches" for a term that matched plenty.
  // So the row is shown, disabled, carrying the reason, and the person can see that
  // what they want is an adjustment.
  //
  // useCallback because ItemPicker passes it into Typeahead's debounced search
  // effect: an identity that changed every render would restart the timer forever.
  const openingUnavailable = useCallback(
    (candidate: InventoryItem): string | null => {
      if (mode !== 'opening' || !openings) return null;
      if (candidate.id === itemId) return null; // never disqualify the current choice
      return openings.has(openingKey(locationId, candidate.id))
        ? 'Already has an opening balance here — correct it with an adjustment'
        : null;
    },
    [mode, openings, itemId, locationId],
  );

  const currentAverage = shownPosition?.moving_average_cost ?? null;
  const costIsOptional = mode === 'adjustment' && currentAverage !== null;

  function resetAfterPost() {
    setItemId('');
    setQuantity(null);
    setUnitCost(null);
    setBatchCode('');
    setExpiryDate('');
    setReason('');
    setNote('');
    setConfirm(null);
    setFormError(null);
  }

  async function submit(
    allowed: { negative: boolean; unvalued: boolean },
    existingKey?: string,
  ) {
    setFormError(null);

    if (!itemId) {
      setFormError('Choose an item first.');
      return;
    }
    if (quantity === null || quantity <= 0) {
      setFormError('Enter how much, as a number greater than zero.');
      return;
    }
    if (mode === 'opening' && unitCost === null) {
      setFormError(
        'Enter what one ' + (baseUnit || 'unit') + ' cost — it is what this stock is worth.',
      );
      return;
    }
    if (mode === 'adjustment' && !reason.trim()) {
      setFormError('Enter a reason. It is recorded against your name, permanently.');
      return;
    }

    // A fresh key per submit INTENT (rules 2/3) — but the SAME key when
    // confirming a negative result, which is what makes the confirmation safe:
    // the second call is the same intent, not a new one, so it cannot post a
    // second movement even if the first somehow got through.
    const key = existingKey ?? newIdempotencyKey();

    setSubmitting(true);
    try {
      if (mode === 'opening') {
        await postOpeningBalance({
          propertyId,
          locationId,
          inventoryItemId: itemId,
          quantity,
          unitCost: unitCost!,
          businessDate: date || null,
          note: note.trim() || null,
          idempotencyKey: key,
          // Sent only when the item tracks them and this is stock coming IN.
          // The server is the authority on whether they were required.
          batchCode: tracksBatch ? batchCode.trim() || null : null,
          expiryDate: tracksBatch ? expiryDate || null : null,
        });
        toast.success('Opening balance recorded.');
      } else {
        await postStockAdjustment({
          propertyId,
          locationId,
          inventoryItemId: itemId,
          // The direction toggle becomes the sign here, in one place.
          quantity: direction === 'add' ? quantity : -quantity,
          reason: reason.trim(),
          businessDate: date || null,
          // A cost is only meaningful when adding; the server REFUSES one on a
          // removal rather than ignoring it, so it is never sent.
          unitCost: direction === 'add' ? unitCost : null,
          idempotencyKey: key,
          allowNegative: allowed.negative,
          allowUnvalued: allowed.unvalued,
          batchCode: tracksBatch ? batchCode.trim() || null : null,
          expiryDate: tracksBatch ? expiryDate || null : null,
        });
        toast.success('Adjustment recorded.');
      }
      resetAfterPost();
      await onDone();
    } catch (e) {
      // 036 raises sentences a storekeeper can act on ("a unit cost cannot be
      // given when removing stock"), so the server's own message is shown
      // verbatim rather than replaced with soft generic copy.
      const code = stockErrorCode(e);
      if (code === STOCK_NEEDS_CONFIRMATION || code === STOCK_NEEDS_COST_CONFIRMATION) {
        setConfirm({
          message: stockErrorMessage(e),
          key,
          gate: code === STOCK_NEEDS_CONFIRMATION ? 'negative' : 'unvalued',
          signature: intentSignature,
          allowed,
        });
      } else {
        setFormError(stockErrorMessage(e));
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="rounded-2xl border border-sand-border bg-white/60 p-4">
      <h2 className="text-base font-semibold text-charcoal">
        {mode === 'opening' ? 'Record an opening balance' : 'Correct the stock'}
      </h2>
      <p className="mt-1 text-sm text-charcoal-muted">
        {mode === 'opening'
          ? `What ${locationName} already held when you started using the system. Once per item — after that, corrections are adjustments.`
          : `Change what ${locationName} holds without a purchase or a sale behind it. ${ADJUSTMENT_REASON_EXPLANATION}`}
      </p>

      {loadError ? (
        <p className="mt-3 rounded-xl border border-sand-border bg-white/60 p-3 text-xs text-charcoal-muted">
          Existing opening balances could not be checked, so every item is listed:{' '}
          {loadError}
        </p>
      ) : null}

      {/* Mode — two words, not a dropdown: they are two different acts and the
          person already knows which one they are doing. */}
      <div className="mt-4 flex flex-wrap gap-2" role="group" aria-label="What to record">
        <ModeButton
          active={mode === 'opening'}
          disabled={submitting}
          onClick={() => {
            setMode('opening');
            setConfirm(null);
          }}
        >
          Opening balance
        </ModeButton>
        <ModeButton
          active={mode === 'adjustment'}
          disabled={submitting}
          onClick={() => {
            setMode('adjustment');
            setConfirm(null);
          }}
        >
          Adjustment
        </ModeButton>
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          {/* SEARCHABLE, SERVER-SIDE (rule 26). This was a <select> over the whole
              loaded catalogue, which works at thirty items and is unusable at a
              thousand — and the obvious fix, a filter box over the loaded array,
              would search what happened to be fetched rather than what exists. */}
          <ItemPicker
            tenantId={tenantId}
            value={itemId}
            onChange={(v) => {
              setItemId(v);
              setConfirm(null);
            }}
            selectedItem={item}
            // A form about to write a movement offers only items in use.
            activeOnly
            // Opening mode: an item that already has one HERE is listed with the
            // reason and cannot be chosen — not dropped. See ItemPicker's header for
            // why hiding it is worse, and why filtering the search result would be
            // worse still.
            unavailable={openingUnavailable}
            required
            disabled={submitting}
          />
        </div>

        {/* WHAT THE SYSTEM CURRENTLY BELIEVES — before anything is typed. */}
        {itemId ? (
          <div className="sm:col-span-2 rounded-xl border border-sand-border bg-sand/30 px-3 py-2 text-xs text-charcoal-muted">
            {positionLoading ? (
              <span aria-live="polite">Checking current stock…</span>
            ) : shownPosition ? (
              <>
                <span className="font-semibold text-charcoal">
                  {formatQuantity(shownPosition.quantity_on_hand)} {baseUnit}
                </span>{' '}
                on hand here, at{' '}
                <span className="font-semibold text-charcoal">
                  {formatMoney(shownPosition.moving_average_cost, currency)}
                </span>{' '}
                per {baseUnit} — worth{' '}
                <span className="font-semibold text-charcoal">
                  {formatMoney(shownPosition.stock_value, currency)}
                </span>
                .
              </>
            ) : (
              <>No stock recorded for this item in {locationName} yet.</>
            )}
          </div>
        ) : null}

        {mode === 'adjustment' ? (
          <div className="sm:col-span-2">
            <span className="mb-1 block text-sm font-medium text-charcoal">
              Which way{' '}
              <span className="text-primary" aria-hidden="true">
                *
              </span>
            </span>
            <div className="flex flex-wrap gap-2" role="group" aria-label="Direction">
              <ModeButton
                active={direction === 'add'}
                disabled={submitting}
                onClick={() => setDirection('add')}
              >
                Add stock
              </ModeButton>
              <ModeButton
                active={direction === 'remove'}
                disabled={submitting}
                onClick={() => {
                  setDirection('remove');
                  // A removal states no cost — clear it rather than sending
                  // something the server would refuse.
                  setUnitCost(null);
                }}
              >
                Remove stock
              </ModeButton>
            </div>
          </div>
        ) : null}

        <NumberField
          label={
            mode === 'opening'
              ? `How much is on hand${baseUnit ? ` (${baseUnit})` : ''}`
              : `How much to ${direction}${baseUnit ? ` (${baseUnit})` : ''}`
          }
          required
          value={quantity}
          onChange={setQuantity}
          min={0}
          step="any"
          disabled={submitting}
          helpText={
            baseUnit
              ? `In ${baseUnit} — the unit this item is tracked in.`
              : undefined
          }
        />

        {mode === 'opening' || direction === 'add' ? (
          <CurrencyField
            label={`Cost per ${baseUnit || 'unit'}`}
            required={mode === 'opening'}
            value={unitCost}
            onChange={setUnitCost}
            currency={currency}
            disabled={submitting}
            helpText={
              costIsOptional
                ? `Leave blank to use the current average of ${formatMoney(
                    currentAverage,
                    currency,
                  )}. ${MOVING_AVERAGE_EXPLANATION}`
                : 'What one unit cost. This is what the stock on hand is worth.'
            }
          />
        ) : (
          <div className="rounded-xl border border-dashed border-sand-border bg-white/40 px-3 py-2 text-xs text-charcoal-muted">
            Stock leaves at its current average cost, so there is no cost to
            enter here.
          </div>
        )}

        {/* BATCH AND EXPIRY — only for an item that tracks them, and ONLY ON THE
            WAY IN (038 §1C).
            They are deliberately absent on a removal rather than optional there:
            which batch left is decided by the issue rules, not typed in by
            whoever is at the keyboard, and a guess here would put a wrong answer
            into the history a future recall reads. The server refuses a batch on
            a stock-out for the same reason, so an optional field would only be a
            slower way to reach a refusal. */}
        {tracksBatch ? (
          <>
            <TextField
              label="Batch code"
              required
              value={batchCode}
              onChange={setBatchCode}
              disabled={submitting}
              placeholder="e.g. LOT-4471"
              helpText="From the packaging. It is what a recall traces back to."
            />
            <DateField
              label="Expiry date"
              required
              value={expiryDate}
              onChange={setExpiryDate}
              disabled={submitting}
              helpText="From the packaging. Stock that arrives already expired is still recorded honestly — enter the real date."
            />
          </>
        ) : null}

        {item?.tracks_expiry && !isStockIn ? (
          <p className="rounded-xl border border-dashed border-sand-border bg-white/40 px-3 py-2 text-xs text-charcoal-muted sm:col-span-2">
            {BATCH_FIELDS_IN_ONLY_NOTE}
          </p>
        ) : null}

        <DateField
          label="Date"
          required
          value={date}
          onChange={setDate}
          max={today}
          disabled={submitting}
          helpText="The day this was counted or corrected — not today, if they differ."
        />

        {mode === 'adjustment' ? (
          <TextField
            label="Reason"
            required
            value={reason}
            onChange={setReason}
            placeholder="e.g. Physical count on 5 Aug, two bags damaged"
            disabled={submitting}
          />
        ) : (
          <TextField
            label="Note"
            value={note}
            onChange={setNote}
            placeholder="e.g. Counted with the chef"
            disabled={submitting}
          />
        )}
      </div>

      {/* The server said this would leave less than nothing on hand. Not an
          error to dismiss — a question to answer. */}
      {liveConfirm ? (
        <ConfirmGatePanel
          message={liveConfirm.message}
          gate={liveConfirm.gate}
          verb="recording it"
          busy={submitting}
          confirmLabel="Record it anyway"
          cancelLabel="Let me check the number"
          onConfirm={() =>
            void submit(
              {
                negative: liveConfirm.allowed.negative || liveConfirm.gate === 'negative',
                unvalued: liveConfirm.allowed.unvalued || liveConfirm.gate === 'unvalued',
              },
              liveConfirm.key,
            )
          }
          onCancel={() => setConfirm(null)}
        />
      ) : null}

      {formError ? (
        <p className="mt-4 text-sm font-medium text-primary" role="alert">
          {formError}
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void submit({ negative: false, unvalued: false })}
          disabled={submitting || confirm !== null}
          className="rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:opacity-60"
        >
          {submitting
            ? 'Recording…'
            : mode === 'opening'
              ? 'Record opening balance'
              : 'Record adjustment'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={submitting}
          className="rounded-full border border-sand-border bg-white/70 px-5 py-2.5 text-sm font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:opacity-60"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function ModeButton({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={`rounded-full px-4 py-2 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:opacity-60 ${
        active
          ? 'bg-primary text-white'
          : 'border border-sand-border bg-white/70 text-charcoal hover:bg-sand'
      }`}
    >
      {children}
    </button>
  );
}
