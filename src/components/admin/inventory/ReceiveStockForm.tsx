import { useEffect, useState } from 'react';
import { CurrencyField, DateField, NumberField, TextField } from '../../ui/form';
import { ManagerPinField } from '../ManagerPinField';
import { useToast } from '../../ui/Toast';
import { todayIsoInZone } from '../../../lib/date';
import { formatMoney, formatQuantity } from '../../../lib/format';
import { previewReceipt } from '../../../lib/stockChart';
import {
  fetchItemPosition,
  newIdempotencyKey,
  postStockReceipt,
  stockErrorMessage,
} from '../../../lib/stock';
import type { InventoryItem, StockLocation } from '../../../types/inventory';
import type { StockOnHandRow } from '../../../types/stock';
import { ItemPicker } from './ItemPicker';
import { LocationPicker } from './LocationPicker';

// RECEIVE STOCK (1.1g §1) — the delivery form, and the only thing in this system
// that moves an item's average cost.
//
// ---------------------------------------------------------------------------
// THE EFFECT LINE IS THE POINT OF THIS SCREEN
// ---------------------------------------------------------------------------
// Rule 25 splits what a form shows into subject / effect / about, and this form
// is the clearest case for the middle one. A receipt does something a person
// cannot see and cannot undo casually: it BLENDS the price they are typing into
// the item's average, and every valuation, food-cost figure and count variance is
// built on the result.
//
// So the form computes and shows THE NEW AVERAGE, in this item's own figures,
// before anything is posted — "150 kg at ₦1,200.00, up from ₦1,000.00". That is
// an effect, not an about: it names figures from the record in front of you, so it
// stays on screen. How a weighted average works in general is behind the ⓘ.
//
// THE PREVIEW IS ARITHMETIC THE SERVER WILL REDO, and that is fine — it is a
// courtesy, and it is labelled as one. What it must never be is a second
// implementation that could DISAGREE, so it computes exactly the fold's own
// formula over two numbers the screen already holds, and the posted movement's
// figures are re-read from the server afterwards.

interface ReceiveStockFormProps {
  tenantId: string;
  propertyId: string;
  currency: string;
  timezone: string;
  // Where the page is scoped, used to preselect. Locations are chosen HERE and
  // not inherited, because a receipt goes into a specific store.
  defaultLocationId: string | null;
  locations: StockLocation[];
  // Preselected when the form is opened from an item's page.
  presetItem?: InventoryItem | null;
  onDone: () => Promise<void> | void;
  onCancel: () => void;
}

export function ReceiveStockForm({
  tenantId,
  propertyId,
  currency,
  timezone,
  defaultLocationId,
  locations,
  presetItem = null,
  onDone,
  onCancel,
}: ReceiveStockFormProps) {
  const toast = useToast();
  const today = todayIsoInZone(timezone);

  const [locationId, setLocationId] = useState(defaultLocationId ?? '');
  const [itemId, setItemId] = useState(presetItem?.id ?? '');
  const [quantity, setQuantity] = useState<number | null>(null);
  const [unitCost, setUnitCost] = useState<number | null>(null);
  const [date, setDate] = useState(today);
  const [supplier, setSupplier] = useState('');
  const [note, setNote] = useState('');
  const [batchCode, setBatchCode] = useState('');
  const [expiryDate, setExpiryDate] = useState('');
  // The §2 exception. Held for the length of one call and cleared in a finally
  // block — never stored, exactly as the reversal form does.
  const [managerPin, setManagerPin] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // The item's CURRENT position, so the effect line can name real figures.
  const [position, setPosition] = useState<StockOnHandRow | null>(null);

  const location = locations.find((l) => l.id === locationId) ?? null;
  // THE TEST IS kind, NOT is_default_store — a hotel may run two stores and only
  // one can be the designated receiving point. See 043 §2.
  const isStore = location?.kind === 'store';
  const item = presetItem && presetItem.id === itemId ? presetItem : null;
  const baseUnit = item?.base_unit ?? position?.base_unit ?? '';
  const tracksBatch = Boolean(item?.tracks_expiry);

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
        // A position we could not read is shown as unknown rather than as zero:
        // the effect line simply says less, and the server is the authority on
        // the figures either way.
        if (!cancelled) setPosition(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tenantId, propertyId, locationId, itemId]);

  // Only ever a position that belongs to the item and location on screen.
  const shown =
    position && position.inventory_item_id === itemId && position.location_id === locationId
      ? position
      : null;

  // THE EFFECT, in this item's own numbers. The fold's formula (036 §2) over two
  // figures the screen holds: blended in proportion to their quantities.
  const preview =
    shown && quantity !== null && quantity > 0 && unitCost !== null && unitCost >= 0
      ? previewReceipt(
          shown.quantity_on_hand,
          shown.stock_value,
          shown.moving_average_cost,
          quantity,
          unitCost,
        )
      : null;

  async function submit() {
    setFormError(null);
    if (!locationId) return setFormError('Choose where the delivery arrived.');
    if (!itemId) return setFormError('Choose the item that was delivered.');
    if (quantity === null || quantity <= 0) {
      return setFormError('Enter how much arrived, as a number greater than zero.');
    }
    if (unitCost === null) {
      return setFormError(`Enter what one ${baseUnit || 'unit'} cost.`);
    }

    setSubmitting(true);
    try {
      await postStockReceipt({
        propertyId,
        locationId,
        inventoryItemId: itemId,
        quantity,
        unitCost,
        businessDate: date || null,
        supplier: supplier.trim() || null,
        note: note.trim() || null,
        idempotencyKey: newIdempotencyKey(),
        batchCode: tracksBatch ? batchCode.trim() || null : null,
        expiryDate: tracksBatch ? expiryDate || null : null,
        // Sent only when the location is not a store. The server refuses a PIN
        // offered where none is needed rather than ignoring it, so sending one
        // "just in case" would be an error rather than a courtesy.
        managerPin: isStore ? null : managerPin.trim() || null,
        reason: isStore ? null : reason.trim() || null,
      });
      toast.success('Delivery recorded.');
      await onDone();
    } catch (e) {
      // Rule 21: the SERVER's sentence, with its hint. This form authors no
      // message about the store rule — that rule lives in the database, and a
      // second copy here would drift the day it changed.
      setFormError(stockErrorMessage(e));
    } finally {
      setSubmitting(false);
      // The PIN never outlives the call.
      setManagerPin('');
    }
  }

  return (
    <div className="rounded-2xl border border-sand-border bg-white/60 p-4">
      <h2 className="text-base font-semibold text-charcoal">Receive stock</h2>
      {/* ONE LINE (rule 25). How a weighted average works, and why only a store
          receives, are both behind the ⓘ on the tab above and in the guide. */}
      <p className="mt-1 text-sm text-charcoal-muted">
        A delivery arriving from outside. What you pay changes what this item is worth.
      </p>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <LocationPicker
          tenantId={tenantId}
          propertyId={propertyId}
          label="Where it arrived"
          value={locationId}
          onChange={setLocationId}
          selectedLocation={location}
          activeOnly
          required
          disabled={submitting}
        />

        <ItemPicker
          tenantId={tenantId}
          label="What was delivered"
          value={itemId}
          onChange={setItemId}
          selectedItem={presetItem}
          activeOnly
          required
          disabled={submitting}
        />

        <NumberField
          label={`How much arrived${baseUnit ? ` (${baseUnit})` : ''}`}
          required
          value={quantity}
          onChange={setQuantity}
          min={0}
          step="any"
          disabled={submitting}
        />

        <CurrencyField
          label={`Cost per ${baseUnit || 'unit'}`}
          required
          value={unitCost}
          onChange={setUnitCost}
          currency={currency}
          disabled={submitting}
          // The one hint that earns its place: this is the field that moves the
          // average, and somebody typing a line total instead of a unit price is
          // the mistake worth preventing at the point of entry.
          helpText="What ONE unit cost, not the invoice total."
        />

        <TextField
          label="Supplier"
          value={supplier}
          onChange={setSupplier}
          placeholder="Optional"
          disabled={submitting}
        />

        <DateField
          label="Delivery date"
          value={date}
          onChange={setDate}
          max={today}
          disabled={submitting}
          helpText="The day it arrived — not today, if they differ."
        />

        {tracksBatch ? (
          <>
            <TextField
              label="Batch code"
              required
              value={batchCode}
              onChange={setBatchCode}
              disabled={submitting}
            />
            <DateField
              label="Expiry date"
              required
              value={expiryDate}
              onChange={setExpiryDate}
              disabled={submitting}
            />
          </>
        ) : null}

        <div className="sm:col-span-2">
          <TextField
            label="Note"
            value={note}
            onChange={setNote}
            placeholder="e.g. Invoice 4471"
            disabled={submitting}
          />
        </div>
      </div>

      {/* THE EFFECT (rule 25's middle slot): what this does to THIS item, in its
          own figures. Never hidden behind the ⓘ — somebody about to change a
          valuation is deciding on exactly this sentence. */}
      {preview ? (
        <p className="mt-4 rounded-xl border border-primary/30 bg-primary/10 px-3 py-2 text-sm text-charcoal">
          After this delivery {location?.name} holds{' '}
          <span className="font-semibold">
            {formatQuantity(preview.newQuantity)} {baseUnit}
          </span>{' '}
          at{' '}
          <span className="font-semibold">
            {formatMoney(preview.newAverage, currency)}
          </span>{' '}
          per {baseUnit}
          {preview.previousAverage !== preview.newAverage ? (
            <> — up from {formatMoney(preview.previousAverage, currency)}</>
          ) : null}
          .{' '}
          <span className="text-charcoal-muted">
            The figure is confirmed by the server when you post.
          </span>
        </p>
      ) : null}

      {/* THE EXCEPTION, shown ONLY when it applies. A PIN box on every delivery
          would teach people to have a PIN ready for routine work, which is the
          opposite of what it is for. */}
      {location && !isStore ? (
        <div className="mt-4 rounded-xl border border-accent/40 bg-accent/10 p-3">
          <p className="text-sm font-semibold text-charcoal">
            {location.name} is not a store
          </p>
          <p className="mt-1 text-sm text-charcoal">
            Deliveries come into a store, and goods reach here by being issued from
            it. A manager can authorise this one — it will be listed on the stock
            provenance report.
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <TextField
              label="Why it came straight here"
              required
              value={reason}
              onChange={setReason}
              placeholder="e.g. Chef bought it at the market for a function"
              disabled={submitting}
            />
            <ManagerPinField
              value={managerPin}
              onChange={setManagerPin}
              disabled={submitting}
              title="A manager must authorise this delivery"
              reason="This records stock arriving somewhere other than a store, which is the one exception to how goods enter the hotel. It is listed on the stock provenance report against the manager's name."
            />
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

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void submit()}
          disabled={submitting}
          className="rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-primary-hover focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream focus-visible:outline-none disabled:opacity-60"
        >
          {submitting ? 'Recording…' : 'Record the delivery'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={submitting}
          className="rounded-full border border-sand-border bg-white/70 px-5 py-2.5 text-sm font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream focus-visible:outline-none disabled:opacity-60"
        >
          Cancel
        </button>
        {/* NOTHING UNDER THE BUTTONS (rule 25). The first draft of this file put
            MOVING_AVERAGE_EXPLANATION here as a small grey line and hid
            ONLY_THE_STORE_RECEIVES in an sr-only span — a paragraph under a
            button and a wall of text smuggled past the reader, which is the exact
            shape the rule exists to stop. Both are in the tab's ⓘ and in the
            guide; what stays on screen is the EFFECT line above, because that one
            names this delivery's own figures. */}
      </div>
    </div>
  );
}
