import { useEffect, useState } from 'react';
import {
  CurrencyField,
  DateField,
  NumberField,
  Select,
  TextField,
} from '../../ui/form';
import type { SelectOption } from '../../ui/form';
import { useToast } from '../../ui/Toast';
import { todayIsoInZone } from '../../../lib/date';
import { describeError } from '../../../lib/errors';
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
} from '../../../lib/stock';
import {
  ADJUSTMENT_REASON_EXPLANATION,
  MOVING_AVERAGE_EXPLANATION,
} from '../../../lib/stockLabels';
import type { InventoryItem } from '../../../types/inventory';
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

  // A PT449 the server raised: the adjustment is legal but would leave less than
  // nothing on hand. Held with the key that produced it, so confirming re-sends
  // the SAME intent and cannot post twice.
  const [confirm, setConfirm] = useState<{ message: string; key: string } | null>(
    null,
  );

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

  // Only ever show a position that belongs to the item currently selected.
  const shownPosition =
    position && position.inventory_item_id === itemId ? position : null;

  // The opening picker hides items that already have one here; the adjustment
  // picker offers everything.
  const selectableItems =
    mode === 'opening' && openings
      ? items.filter(
          (i) => i.id === itemId || !openings.has(openingKey(locationId, i.id)),
        )
      : items;

  const itemOptions: SelectOption[] = [
    { value: '', label: 'Choose an item…' },
    ...selectableItems.map((i) => ({
      value: i.id,
      label: i.code ? `${i.name} (${i.code})` : i.name,
    })),
  ];

  const currentAverage = shownPosition?.moving_average_cost ?? null;
  const costIsOptional = mode === 'adjustment' && currentAverage !== null;

  function resetAfterPost() {
    setItemId('');
    setQuantity(null);
    setUnitCost(null);
    setReason('');
    setNote('');
    setConfirm(null);
    setFormError(null);
  }

  async function submit(allowNegative: boolean, existingKey?: string) {
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
          allowNegative,
        });
        toast.success('Adjustment recorded.');
      }
      resetAfterPost();
      await onDone();
    } catch (e) {
      // 036 raises sentences a storekeeper can act on ("a unit cost cannot be
      // given when removing stock"), so the server's own message is shown
      // verbatim rather than replaced with soft generic copy.
      if (stockErrorCode(e) === STOCK_NEEDS_CONFIRMATION) {
        setConfirm({ message: stockErrorMessage(e), key });
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
          <Select
            label="Item"
            required
            value={itemId}
            onChange={(v) => {
              setItemId(v);
              setConfirm(null);
            }}
            options={itemOptions}
            disabled={submitting}
            helpText={
              mode === 'opening'
                ? 'Items that already have an opening balance here are not listed.'
                : undefined
            }
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
      {confirm ? (
        <div className="mt-4 rounded-xl border border-accent/40 bg-accent/10 p-3">
          <p className="text-sm font-medium text-charcoal">{confirm.message}</p>
          <p className="mt-1 text-xs text-charcoal-muted">
            Recording it anyway is the honest thing to do if the stock really is
            gone — the shortfall stays visible instead of being rounded away, and
            it is what makes the difference show up in a report.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void submit(true, confirm.key)}
              disabled={submitting}
              className="rounded-full bg-accent px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:opacity-60"
            >
              {submitting ? 'Recording…' : 'Record it anyway'}
            </button>
            <button
              type="button"
              onClick={() => setConfirm(null)}
              disabled={submitting}
              className="rounded-full border border-sand-border bg-white/70 px-4 py-2 text-xs font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:opacity-60"
            >
              Let me check the number
            </button>
          </div>
        </div>
      ) : null}

      {formError ? (
        <p className="mt-4 text-sm font-medium text-primary" role="alert">
          {formError}
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void submit(false)}
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
