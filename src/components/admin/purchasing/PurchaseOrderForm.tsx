import { useState } from 'react';
import { CurrencyField, DateField, NumberField, TextArea, TextField } from '../../ui/form';
import { ScreenHeader } from '../../ui/ScreenHeader';
import { CloseIcon, PlusIcon } from '../../ui/icons';
import { useToast } from '../../ui/Toast';
import { humanizeError } from '../../../lib/errors';
import { formatMoney } from '../../../lib/format';
import {
  newIdempotencyKey,
  placePurchaseOrder,
  savePurchaseOrder,
} from '../../../lib/purchasing';
import {
  PURCHASES_ABOUT,
  PURCHASES_ABOUT_TITLE,
} from '../../../lib/purchasingLabels';
import type { InventoryItem } from '../../../types/inventory';
import type {
  PurchaseOrderLineDraft,
  PurchaseOrderLineStatus,
  PurchaseOrderSummary,
} from '../../../types/purchasing';
import { ItemPicker } from '../inventory/ItemPicker';
import { LocationPicker } from '../inventory/LocationPicker';
import { SupplierPicker } from './SupplierPicker';

// RAISE OR EDIT A PURCHASE ORDER (046 §6.1).
//
// ---------------------------------------------------------------------------
// ONLY A DRAFT REACHES THIS FORM, AND THE SERVER IS WHAT SAYS SO
// ---------------------------------------------------------------------------
// save_purchase_order refuses anything that is not a draft, by name. The screen
// does not render an edit route for a sent order — which is a courtesy, not the
// guard: somebody with the URL still gets the database's sentence rather than a
// silently ignored save.
//
// ---------------------------------------------------------------------------
// THE LINES ARE REPLACED WHOLE
// ---------------------------------------------------------------------------
// A draft is a document somebody is writing. The form sends what it should now
// say and the server makes it say that, which is why a line's `key` here is a
// React row key and never leaves the browser. Merging would need a client-side
// identity for a line that has never been anything but a row in a form.
//
// ---------------------------------------------------------------------------
// THE ORDER TOTAL IS AN EFFECT, NOT AN ABOUT (rule 25)
// ---------------------------------------------------------------------------
// It names figures from the record in front of you, so it stays on screen. What
// a purchase order IS, and what happens when you send one, are the same
// sentences on every order anybody will ever raise — those are behind the ⓘ.

interface PurchaseOrderFormProps {
  tenantId: string;
  propertyId: string;
  propertySlug: string;
  currency: string;
  timezone: string;
  today: string;
  defaultLocationId: string | null;
  // NULL raises a new one. An order edits it — and only a draft ever gets here.
  order: PurchaseOrderSummary | null;
  existingLines: PurchaseOrderLineStatus[];
  // The catalogue rows behind the existing lines, fetched by the page from the
  // ids on those lines (bounded, rule 1a). ItemPicker needs one to label a
  // choice made in a PREVIOUS session — after a pick it knows the label itself,
  // so this map is only ever about rows that were already on the order.
  itemsById: Map<string, InventoryItem>;
  onSaved: (orderId: string) => Promise<void> | void;
  onCancel: () => void;
}

let rowSeq = 0;
const newRow = (): PurchaseOrderLineDraft => ({
  key: `row-${(rowSeq += 1)}`,
  inventoryItemId: '',
  quantity: null,
  unitCost: null,
  note: '',
});

export function PurchaseOrderForm({
  tenantId,
  propertyId,
  propertySlug,
  currency,
  today,
  defaultLocationId,
  order,
  existingLines,
  itemsById,
  onSaved,
  onCancel,
}: PurchaseOrderFormProps) {
  const toast = useToast();

  const [supplierId, setSupplierId] = useState(order?.supplier_id ?? '');
  const [destinationId, setDestinationId] = useState(
    order?.destination_location_id ?? defaultLocationId ?? '',
  );
  const [orderDate, setOrderDate] = useState(order?.order_date ?? today);
  const [expectedDate, setExpectedDate] = useState(order?.expected_date ?? '');
  const [note, setNote] = useState(order?.note ?? '');
  const [lines, setLines] = useState<PurchaseOrderLineDraft[]>(
    existingLines.length > 0
      ? existingLines.map((l) => ({
          key: `existing-${l.purchase_order_line_id}`,
          inventoryItemId: l.inventory_item_id ?? '',
          quantity: l.ordered_quantity,
          unitCost: l.ordered_unit_cost,
          note: l.note ?? '',
        }))
      : [newRow()],
  );
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const setLine = (key: string, patch: Partial<PurchaseOrderLineDraft>) =>
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const orderTotal = lines.reduce(
    (t, l) => t + Math.round((l.quantity ?? 0) * (l.unitCost ?? 0) * 100) / 100,
    0,
  );

  const complete = lines.filter(
    (l) => l.inventoryItemId && (l.quantity ?? 0) > 0 && l.unitCost !== null,
  );
  const canSubmit =
    supplierId !== '' && destinationId !== '' && complete.length === lines.length &&
    lines.length > 0;

  async function submit(send: boolean) {
    if (submitting) return;
    setSubmitting(true);
    setFormError(null);
    try {
      const saved = await savePurchaseOrder({
        propertyId,
        purchaseOrderId: order?.id ?? null,
        supplierId,
        orderDate,
        expectedDate: expectedDate || null,
        destinationLocationId: destinationId,
        note: note.trim() || null,
        lines,
        idempotencyKey: newIdempotencyKey(),
      });

      if (send) {
        // A SECOND RPC RATHER THAN A FLAG ON THE FIRST, because they are two
        // different acts with two different consequences: saving a draft changes
        // nothing anybody else can see, and sending one makes the order
        // immutable. One function doing both would need a parameter that decides
        // whether the document can ever be edited again.
        await placePurchaseOrder(saved.id, newIdempotencyKey());
        toast.success(`${saved.order_number} sent.`);
      } else {
        toast.success(`${saved.order_number} saved as a draft.`);
      }
      await onSaved(saved.id);
    } catch (e) {
      // The server's own message and hint, verbatim (rules 11, 21).
      setFormError(humanizeError(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-4">
      <ScreenHeader
        title={order ? `Edit ${order.order_number}` : 'New purchase order'}
        purpose="What you are asking a supplier for, and where it is going."
        about={{
          title: PURCHASES_ABOUT_TITLE,
          paragraphs: PURCHASES_ABOUT,
          guideAnchor: 'purchase-orders',
          guideLabel: 'Purchase orders',
        }}
        propertySlug={propertySlug}
      />

      <div className="grid gap-3 rounded-2xl border border-sand-border bg-white/60 p-4 sm:grid-cols-2 lg:grid-cols-4">
        <SupplierPicker
          tenantId={tenantId}
          value={supplierId}
          onChange={setSupplierId}
          required
        />
        {/* NOT NARROWED TO kind='store'. Ordering to a bar is allowed; it is the
            DELIVERY that needs a manager's authorisation, and enforcing the rule
            twice would give it two chances to disagree with itself. */}
        <LocationPicker
          tenantId={tenantId}
          propertyId={propertyId}
          label="Going to"
          value={destinationId}
          onChange={setDestinationId}
          activeOnly
          required
          helpText="Anywhere other than a store needs a manager to sign the delivery in."
        />
        <DateField
          label="Order date"
          value={orderDate}
          onChange={setOrderDate}
          helpText="The day you raised it."
        />
        <DateField
          label="Expected"
          value={expectedDate}
          onChange={setExpectedDate}
          helpText="When they said it would arrive. Optional."
        />
      </div>

      <div className="space-y-3 rounded-2xl border border-sand-border bg-white/60 p-4">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[48rem] text-sm">
            <thead>
              <tr className="border-b border-sand-border text-left text-xs font-medium text-charcoal-muted">
                <th className="py-2 pr-3">Item</th>
                <th className="w-32 py-2 pr-3">Quantity</th>
                <th className="w-40 py-2 pr-3">Cost per unit</th>
                <th className="w-32 py-2 pr-3 text-right">Line total</th>
                <th className="py-2 pr-3">Note</th>
                <th className="w-10 py-2" />
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => {
                const item = itemsById.get(line.inventoryItemId) ?? null;
                const total =
                  Math.round((line.quantity ?? 0) * (line.unitCost ?? 0) * 100) / 100;
                return (
                  <tr
                    key={line.key}
                    className="border-b border-sand-border/60 align-top last:border-0"
                  >
                    <td className="py-2 pr-3">
                      <ItemPicker
                        tenantId={tenantId}
                        label=""
                        value={line.inventoryItemId}
                        selectedItem={item}
                        onChange={(id) => setLine(line.key, { inventoryItemId: id })}
                        activeOnly
                        unavailable={(candidate) =>
                          // SHOWN AND EXPLAINED rather than filtered out (rule
                          // 26): an item already on another line of this order
                          // exists and is simply not choosable twice, and a row
                          // that vanished would read as "we do not stock it".
                          lines.some(
                            (l) =>
                              l.key !== line.key &&
                              l.inventoryItemId === candidate.id,
                          )
                            ? 'Already on this order'
                            : null
                        }
                      />
                    </td>
                    <td className="py-2 pr-3">
                      <NumberField
                        label=""
                        value={line.quantity}
                        onChange={(v) => setLine(line.key, { quantity: v })}
                        min={0}
                        step="any"
                        placeholder={item?.base_unit ?? ''}
                      />
                    </td>
                    <td className="py-2 pr-3">
                      <CurrencyField
                        label=""
                        value={line.unitCost}
                        onChange={(v) => setLine(line.key, { unitCost: v })}
                        currency={currency}
                      />
                    </td>
                    <td className="py-2 pr-3 pt-4 text-right tabular-nums text-charcoal">
                      {formatMoney(total, currency)}
                    </td>
                    <td className="py-2 pr-3">
                      <TextField
                        label=""
                        value={line.note}
                        onChange={(v) => setLine(line.key, { note: v })}
                        placeholder="Optional"
                      />
                    </td>
                    <td className="py-2 pt-4">
                      <button
                        type="button"
                        onClick={() =>
                          setLines((prev) =>
                            prev.length === 1
                              ? [newRow()]
                              : prev.filter((l) => l.key !== line.key),
                          )
                        }
                        aria-label="Remove this line"
                        className="rounded-lg p-1.5 text-charcoal-muted transition-colors hover:bg-sand hover:text-charcoal focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none"
                      >
                        <CloseIcon className="h-4 w-4" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => setLines((prev) => [...prev, newRow()])}
            className="inline-flex items-center gap-2 rounded-full border border-sand-border px-4 py-2 text-sm font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream focus-visible:outline-none"
          >
            <PlusIcon className="h-4 w-4" />
            Add a line
          </button>
          {/* THE EFFECT (rule 25): this order's own figure, on screen, always. */}
          <p className="text-sm text-charcoal">
            Order total{' '}
            <span className="font-semibold tabular-nums">
              {formatMoney(orderTotal, currency)}
            </span>
          </p>
        </div>
      </div>

      <TextArea label="Note" value={note} onChange={setNote} rows={2} />

      {formError ? (
        <p className="rounded-lg bg-primary/10 px-3 py-2 text-sm text-charcoal">
          {formError}
        </p>
      ) : null}

      <div className="flex flex-wrap justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-full px-5 py-2.5 text-sm font-semibold text-charcoal-muted transition-colors hover:text-charcoal focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream focus-visible:outline-none"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => submit(false)}
          disabled={submitting || !canSubmit}
          className="rounded-full border border-sand-border px-5 py-2.5 text-sm font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? 'Saving…' : 'Save as draft'}
        </button>
        <button
          type="button"
          onClick={() => submit(true)}
          disabled={submitting || !canSubmit}
          className="rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-primary-hover focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? 'Sending…' : 'Save and send'}
        </button>
      </div>

      {/* AN EFFECT, NOT AN ABOUT: it names what pressing THAT button does to
          THIS document, and somebody at the moment of an act that cannot be
          undone is deciding on exactly this sentence. */}
      <p className="text-right text-xs text-charcoal-muted">
        Sending fixes what was ordered. After that you record what actually
        arrives, and the difference is kept.
      </p>
    </div>
  );
}
