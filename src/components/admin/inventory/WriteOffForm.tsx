import { useEffect, useState } from 'react';
import { DateField, NumberField, TextField } from '../../ui/form';
import { useToast } from '../../ui/Toast';
import { todayIsoInZone } from '../../../lib/date';
import { formatMoney, formatQuantity } from '../../../lib/format';
import {
  fetchItemPosition,
  newIdempotencyKey,
  postStockWriteoff,
  stockErrorCode,
  stockErrorMessage,
  STOCK_NEEDS_CONFIRMATION,
} from '../../../lib/stock';
import {
  WRITEOFF_REASONS,
  writeoffReasonHint,
  writeoffReasonLabel,
} from '../../../lib/stockLabels';
import type { InventoryItem, StockLocation } from '../../../types/inventory';
import type { StockOnHandRow, WriteoffReason } from '../../../types/stock';
import { ItemPicker } from './ItemPicker';
import { LocationPicker } from './LocationPicker';

// WRITE OFF STOCK (1.1g §3) — stock that is gone, and why.
//
// ---------------------------------------------------------------------------
// THIS IS NOT THE ADJUSTMENT FORM, AND THE DIFFERENCE IS THE WHOLE POINT
// ---------------------------------------------------------------------------
// §9, in its own words: an adjustment means THE COUNT WAS WRONG. A write-off
// means WE LOST IT, AND HERE IS WHY. Blur them and the variance report stops
// meaning anything — because variance IS the gap between what should have gone
// and what did, and a loss recorded as a correction moves the wrong side of it.
//
// So the reason is a CATEGORY, chosen from five, not a sentence typed into a box.
// Five names a report can group on is the difference between "we lost ₦180,000 to
// spoilage last quarter" and a column of prose nobody can add up. The free text
// still exists — it sits beside the category as a note, which is where the detail
// belongs.
//
// ---------------------------------------------------------------------------
// THE QUANTITY IS A PLAIN POSITIVE NUMBER
// ---------------------------------------------------------------------------
// A person writing off five kilos types 5. The RPC applies the sign, because a
// minus typed into a box is one missed keystroke from ADDING five kilos of
// spoiled rice and the mistake is invisible until a count months later. Same
// reasoning as the adjustment form's direction toggle, except a write-off has
// only one direction so there is nothing to toggle.

interface WriteOffFormProps {
  tenantId: string;
  propertyId: string;
  currency: string;
  timezone: string;
  defaultLocationId: string | null;
  locations: StockLocation[];
  presetItem?: InventoryItem | null;
  onDone: () => Promise<void> | void;
  onCancel: () => void;
}

export function WriteOffForm({
  tenantId,
  propertyId,
  currency,
  timezone,
  defaultLocationId,
  locations,
  presetItem = null,
  onDone,
  onCancel,
}: WriteOffFormProps) {
  const toast = useToast();
  const today = todayIsoInZone(timezone);

  const [locationId, setLocationId] = useState(defaultLocationId ?? '');
  const [itemId, setItemId] = useState(presetItem?.id ?? '');
  const [quantity, setQuantity] = useState<number | null>(null);
  const [reasonCode, setReasonCode] = useState<WriteoffReason | null>(null);
  const [date, setDate] = useState(today);
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  // A PT449 the server raised: legal, but it would leave less than nothing. Held
  // with the key that produced it, so confirming re-sends the SAME intent and
  // cannot post twice.
  const [confirm, setConfirm] = useState<{ message: string; key: string } | null>(null);

  const [position, setPosition] = useState<StockOnHandRow | null>(null);

  const location = locations.find((l) => l.id === locationId) ?? null;
  const item = presetItem && presetItem.id === itemId ? presetItem : null;
  const baseUnit = item?.base_unit ?? position?.base_unit ?? '';

  useEffect(() => {
    let cancelled = false;
    // NOT cleared synchronously when the selection empties — StockEntryForm
    // records the same decision, and the linter agrees: a setState in an effect
    // body is a cascading render. It is unnecessary anyway, because `shown`
    // below already ignores a position that does not belong to the item AND
    // location currently on screen, which also covers the gap between picking a
    // new item and its position arriving.
    if (!itemId || !locationId) return;
    (async () => {
      try {
        const row = await fetchItemPosition(tenantId, propertyId, locationId, itemId);
        if (!cancelled) setPosition(row);
      } catch {
        if (!cancelled) setPosition(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tenantId, propertyId, locationId, itemId]);

  const shown =
    position && position.inventory_item_id === itemId && position.location_id === locationId
      ? position
      : null;

  // THE EFFECT (rule 25): what this write-off costs, in this item's own figures.
  // Stock leaves at the average that is already there, so the loss is quantity ×
  // that average — which is exactly what 038's trigger will stamp onto the
  // movement as carried_unit_cost. The screen is previewing the server's own
  // arithmetic, not inventing a second one.
  const preview =
    shown && quantity !== null && quantity > 0
      ? {
          cost: quantity * shown.moving_average_cost,
          left: shown.quantity_on_hand - quantity,
          average: shown.moving_average_cost,
        }
      : null;

  async function submit(allowNegative: boolean, existingKey?: string) {
    setFormError(null);
    if (!locationId) return setFormError('Choose where the stock was.');
    if (!itemId) return setFormError('Choose what was lost.');
    if (quantity === null || quantity <= 0) {
      return setFormError('Enter how much was lost, as a number greater than zero.');
    }
    if (!reasonCode) return setFormError('Choose why it was lost.');

    // The SAME key when confirming a negative result — the second call is the
    // same intent, not a new one, so it cannot post a second movement.
    const key = existingKey ?? newIdempotencyKey();

    setSubmitting(true);
    try {
      await postStockWriteoff({
        propertyId,
        locationId,
        inventoryItemId: itemId,
        quantity,
        reasonCode,
        businessDate: date || null,
        note: note.trim() || null,
        idempotencyKey: key,
        allowNegative,
      });
      toast.success('Write-off recorded.');
      await onDone();
    } catch (e) {
      // Rule 21: the server's own sentence, with its hint.
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
      <h2 className="text-base font-semibold text-charcoal">Write off stock</h2>
      {/* ONE LINE (rule 25). The difference between this and an adjustment is in
          the tab's ⓘ and in the guide — and it is also implicit in the form,
          which asks WHY from a list rather than asking for a correction. */}
      <p className="mt-1 text-sm text-charcoal-muted">
        Stock that is gone, and what happened to it.
      </p>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <LocationPicker
          tenantId={tenantId}
          propertyId={propertyId}
          label="Where it was"
          value={locationId}
          onChange={setLocationId}
          selectedLocation={location}
          activeOnly
          required
          disabled={submitting}
        />

        <ItemPicker
          tenantId={tenantId}
          label="What was lost"
          value={itemId}
          onChange={setItemId}
          selectedItem={presetItem}
          activeOnly={false}
          required
          disabled={submitting}
          // A discontinued line that has gone bad on a shelf still has to be
          // removable, so switched-off items are offered here — unlike a receipt,
          // where buying more of something you have switched off is the mistake.
          helpText="Items switched off are included — they can still spoil."
        />

        <NumberField
          label={`How much was lost${baseUnit ? ` (${baseUnit})` : ''}`}
          required
          value={quantity}
          onChange={setQuantity}
          min={0}
          step="any"
          disabled={submitting}
          helpText="A plain number. It is taken off the shelf, so there is no minus to type."
        />

        <DateField
          label="When"
          value={date}
          onChange={setDate}
          max={today}
          disabled={submitting}
          helpText="The day it happened — not today, if they differ."
        />
      </div>

      {/* THE CATEGORY, as five buttons rather than a dropdown. Five is few enough
          to show, and showing them puts the CHOICE in front of the person along
          with what each one means — which is what makes the wastage report worth
          reading. A dropdown would hide four of them behind the first. */}
      <fieldset className="mt-4">
        <legend className="mb-2 text-sm font-medium text-charcoal">
          Why it was lost{' '}
          <span className="text-primary" aria-hidden="true">
            *
          </span>
        </legend>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {WRITEOFF_REASONS.map((code) => {
            const selected = reasonCode === code;
            return (
              <button
                key={code}
                type="button"
                onClick={() => setReasonCode(code)}
                disabled={submitting}
                aria-pressed={selected}
                className={`rounded-xl border px-3 py-2 text-left transition-colors focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream focus-visible:outline-none disabled:opacity-60 ${
                  selected
                    ? 'border-primary bg-primary/10'
                    : 'border-sand-border bg-white/70 hover:bg-sand'
                }`}
              >
                <span
                  className={`block text-sm font-semibold ${
                    selected ? 'text-primary' : 'text-charcoal'
                  }`}
                >
                  {writeoffReasonLabel(code)}
                </span>
                <span className="mt-0.5 block text-xs leading-relaxed text-charcoal-muted">
                  {writeoffReasonHint(code)}
                </span>
              </button>
            );
          })}
        </div>
      </fieldset>

      <div className="mt-4">
        <TextField
          label="Note"
          value={note}
          onChange={setNote}
          placeholder="e.g. Sacks split in the rain"
          disabled={submitting}
          helpText="Anything the category does not say. Recorded permanently against your name."
        />
      </div>

      {/* THE EFFECT: what this costs, in this item's own figures. Never hidden —
          somebody about to record an irreversible loss is deciding on exactly
          this sentence. */}
      {preview ? (
        <p className="mt-4 rounded-xl border border-accent/40 bg-accent/10 px-3 py-2 text-sm text-charcoal">
          This writes off{' '}
          <span className="font-semibold">
            {formatMoney(preview.cost, currency)}
          </span>{' '}
          of stock — {formatQuantity(quantity ?? 0)} {baseUnit} at{' '}
          {formatMoney(preview.average, currency)} per {baseUnit} — and leaves{' '}
          <span className="font-semibold">
            {formatQuantity(preview.left)} {baseUnit}
          </span>{' '}
          in {location?.name}.
        </p>
      ) : null}

      {/* THE PT449 CONFIRMATION, in the server's own words. */}
      {confirm ? (
        <div className="mt-4 rounded-xl border border-accent/40 bg-accent/10 p-3" role="alert">
          <p className="text-sm text-charcoal">{confirm.message}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void submit(true, confirm.key)}
              disabled={submitting}
              className="rounded-full bg-accent px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-accent-hover focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-cream focus-visible:outline-none disabled:opacity-60"
            >
              Record it anyway
            </button>
            <button
              type="button"
              onClick={() => setConfirm(null)}
              disabled={submitting}
              className="rounded-full border border-sand-border bg-white/70 px-4 py-2 text-xs font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream focus-visible:outline-none disabled:opacity-60"
            >
              Let me check
            </button>
          </div>
        </div>
      ) : null}

      {formError ? (
        <p
          role="alert"
          className="mt-4 rounded-xl border border-accent/40 bg-accent/10 p-3 text-sm font-medium text-charcoal"
        >
          {formError}
        </p>
      ) : null}

      {confirm ? null : (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void submit(false)}
            disabled={submitting}
            className="rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-accent-hover focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-cream focus-visible:outline-none disabled:opacity-60"
          >
            {submitting ? 'Recording…' : 'Record the write-off'}
          </button>
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className="rounded-full border border-sand-border bg-white/70 px-5 py-2.5 text-sm font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream focus-visible:outline-none disabled:opacity-60"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
