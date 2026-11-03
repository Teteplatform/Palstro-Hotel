import { useState } from 'react';
import {
  CurrencyField,
  DateField,
  NumberField,
  Select,
  TextArea,
  TextField,
} from '../../ui/form';
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
  PurchaseLineType,
  PurchaseOrderLineDraft,
  PurchaseOrderLineStatus,
  PurchaseOrderSummary,
} from '../../../types/purchasing';
import { DataTable, type DataColumn } from '../../ui/DataTable';
import { ExpenseCategoryPicker } from './ExpenseCategoryPicker';
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
// A NEW LINE IS STOCK UNTIL SOMEBODY SAYS OTHERWISE, because almost every line
// on almost every order is. The default is not a guess about this order; it is
// where the fewest people have to touch the selector at all.
const newRow = (): PurchaseOrderLineDraft => ({
  key: `row-${(rowSeq += 1)}`,
  lineType: 'inventory',
  inventoryItemId: '',
  description: '',
  expenseCategoryId: '',
  quantity: null,
  unitCost: null,
  note: '',
});

// WHAT MAKES A LINE COMPLETE DEPENDS ON ITS TYPE, and this mirrors
// save_purchase_order's per-type validation rather than restating a rule of its
// own (rule 21): a stock line needs its item, the other two need words, and
// only an expense line needs a category. Quantity and cost are the same for all
// three.
//
// EXPORTED, because it decides whether Save is pressable. Too strict and the
// form blocks an order the server would take; too loose and it sends one to be
// refused after the person has finished typing. The render proof drives this
// function rather than restating its branches.
export function lineComplete(l: PurchaseOrderLineDraft): boolean {
  if ((l.quantity ?? 0) <= 0 || l.unitCost === null) return false;
  if (l.lineType === 'inventory') return l.inventoryItemId !== '';
  if (l.description.trim() === '') return false;
  return l.lineType !== 'expense' || l.expenseCategoryId !== '';
}

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
          lineType: l.line_type,
          inventoryItemId: l.inventory_item_id ?? '',
          description: l.description ?? '',
          expenseCategoryId: l.expense_category_id ?? '',
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

  // THE LABELS FOR CATEGORIES CHOSEN IN A PREVIOUS SESSION, read off the rows
  // the page already fetched. 054 put expense_category_name on the view for
  // exactly this, so editing a draft needs no second query to render what it
  // already says — and a line raised against a category since retired still
  // shows its name, because that join is deliberately unfiltered.
  const existingCategoryNames = new Map<string, string>(
    existingLines
      .filter((l) => l.expense_category_id && l.expense_category_name)
      .map((l) => [l.expense_category_id as string, l.expense_category_name as string]),
  );

  const orderTotal = lines.reduce(
    (t, l) => t + Math.round((l.quantity ?? 0) * (l.unitCost ?? 0) * 100) / 100,
    0,
  );

  const complete = lines.filter(lineComplete);
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
          // 053 NARROWED THE RULE THIS SENTENCE DESCRIBES, so the sentence
          // narrowed with it. Before, it was true of any delivery to a non-store;
          // now only STOCK arriving outside the store needs the manager, so an
          // order of a freezer for the pool bar no longer does. Leaving the old
          // wording would promise a step that never comes — and a field hint
          // that overstates a rule is the second source of truth rule 21 exists
          // to prevent, just in a calmer voice.
          helpText="Stock arriving anywhere other than a store needs a manager to sign the delivery in."
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
        <OrderDraftLinesTable
          lines={lines}
          itemsById={itemsById}
          existingCategoryNames={existingCategoryNames}
          tenantId={tenantId}
          currency={currency}
          setLine={setLine}
          onRemove={(key) =>
            setLines((prev) =>
              prev.length === 1 ? [newRow()] : prev.filter((l) => l.key !== key),
            )
          }
        />

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

// THE DRAFT'S LINES, AS A TABLE OR AS CARDS (1.1a2).
//
// The ordering form has the same shape of problem as the receiving one and a
// milder version of the consequence: 768px of table in a 295px window, with the
// item picker at the left and the cost and note fields off to the right. Nobody
// raises an order at the store door, so this is the annoying case rather than
// the dangerous one — but it goes through the same primitive, because the reason
// seven tables shared one defect is that they were written seven times.
//
// EXPORTED so the render proof drives the real table (rule 22).
export function OrderDraftLinesTable({
  lines,
  itemsById,
  existingCategoryNames,
  tenantId,
  currency,
  setLine,
  onRemove,
}: {
  lines: PurchaseOrderLineDraft[];
  itemsById: Map<string, InventoryItem>;
  // The label for a category chosen in a PREVIOUS session — the same job
  // itemsById does for an item. 054 put the name on the line's view row, so the
  // page builds this from the lines it already fetched and no extra read is
  // needed. After a pick the picker knows the label itself, so this map is only
  // ever about lines that were already on the order.
  existingCategoryNames: Map<string, string>;
  tenantId: string;
  currency: string;
  setLine: (key: string, patch: Partial<PurchaseOrderLineDraft>) => void;
  onRemove: (key: string) => void;
}) {
  const columns: DataColumn<PurchaseOrderLineDraft>[] = [
    {
      // A <select>, NOT A TYPEAHEAD, and rule 26 is why rather than despite:
      // the rule is about what a selector CAN hold, and this one can hold
      // exactly three values for as long as purchase_order_lines carries its
      // type check. There is no growth path to twenty.
      key: 'kind',
      role: 'control',
      header: 'Kind',
      headerClassName: 'w-36 pr-3',
      cellClassName: 'pr-3',
      cell: (line) => (
        <Select
          label=""
          value={line.lineType}
          onChange={(v) =>
            // THE OTHER FIELDS ARE KEPT, NOT CLEARED. Somebody who picks the
            // wrong kind, types a description and then fixes the kind should
            // not lose the words; the data layer sends only the fields the
            // chosen type owns, so what is kept here never reaches the server
            // on a line it does not belong to.
            setLine(line.key, { lineType: v as PurchaseLineType })
          }
          options={[
            { value: 'inventory', label: 'Stock' },
            { value: 'asset', label: 'Asset' },
            { value: 'expense', label: 'Expense' },
          ]}
        />
      ),
    },
    {
      // ONE COLUMN, THREE SUBJECTS. A stock line is named by its item; an asset
      // or expense line has no item, so it is named by words. Three separate
      // columns would leave two of them blank on every row and widen a table
      // that already has to work at 360px.
      key: 'subject',
      role: 'control',
      header: 'What',
      cellClassName: 'pr-3',
      cell: (line) =>
        line.lineType === 'inventory' ? (
          <ItemPicker
            tenantId={tenantId}
            label=""
            value={line.inventoryItemId}
            selectedItem={itemsById.get(line.inventoryItemId) ?? null}
            onChange={(id) => setLine(line.key, { inventoryItemId: id })}
            activeOnly
            unavailable={(candidate) =>
              // SHOWN AND EXPLAINED rather than filtered out (rule 26): an item
              // already on another line of this order exists and is simply not
              // choosable twice, and a row that vanished would read as "we do
              // not stock it".
              lines.some(
                (l) =>
                  l.key !== line.key &&
                  l.lineType === 'inventory' &&
                  l.inventoryItemId === candidate.id,
              )
                ? 'Already on this order'
                : null
            }
          />
        ) : (
          <div className="space-y-2">
            <TextField
              label=""
              value={line.description}
              onChange={(v) => setLine(line.key, { description: v })}
              placeholder={
                line.lineType === 'asset'
                  ? 'What the hotel is keeping'
                  : 'What the money is for'
              }
            />
            {line.lineType === 'expense' ? (
              <ExpenseCategoryPicker
                tenantId={tenantId}
                label=""
                value={line.expenseCategoryId}
                selectedLabel={
                  existingCategoryNames.get(line.expenseCategoryId) ?? null
                }
                onChange={(id) => setLine(line.key, { expenseCategoryId: id })}
              />
            ) : null}
          </div>
        ),
    },
    {
      key: 'quantity',
      role: 'control',
      header: 'Quantity',
      headerClassName: 'w-32 pr-3',
      cellClassName: 'pr-3',
      cell: (line) => (
        <NumberField
          label=""
          value={line.quantity}
          onChange={(v) => setLine(line.key, { quantity: v })}
          min={0}
          step="any"
          placeholder={
            line.lineType === 'inventory'
              ? (itemsById.get(line.inventoryItemId)?.base_unit ?? '')
              : ''
          }
        />
      ),
    },
    {
      key: 'cost',
      role: 'control',
      header: 'Cost per unit',
      headerClassName: 'w-40 pr-3',
      cellClassName: 'pr-3',
      cell: (line) => (
        <CurrencyField
          label=""
          value={line.unitCost}
          onChange={(v) => setLine(line.key, { unitCost: v })}
          currency={currency}
        />
      ),
    },
    {
      key: 'total',
      header: 'Line total',
      align: 'right',
      headerClassName: 'w-32 pr-3',
      cellClassName: 'pr-3 pt-4 tabular-nums text-charcoal',
      cell: (line) =>
        formatMoney(
          Math.round((line.quantity ?? 0) * (line.unitCost ?? 0) * 100) / 100,
          currency,
        ),
    },
    {
      key: 'note',
      role: 'control',
      header: 'Note',
      cellClassName: 'pr-3',
      cell: (line) => (
        <TextField
          label=""
          value={line.note}
          onChange={(v) => setLine(line.key, { note: v })}
          placeholder="Optional"
        />
      ),
    },
    {
      // Removing a line belongs beside the line's subject, not at the end of a
      // card where it reads as "remove this card's last field".
      key: 'remove',
      role: 'select',
      header: '',
      headerClassName: 'w-10',
      cellClassName: 'pt-4',
      cell: (line) => (
        <button
          type="button"
          onClick={() => onRemove(line.key)}
          aria-label="Remove this line"
          className="rounded-lg p-1.5 text-charcoal-muted transition-colors hover:bg-sand hover:text-charcoal focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none"
        >
          <CloseIcon className="h-4 w-4" />
        </button>
      ),
    },
  ];

  return (
    <DataTable
      columns={columns}
      rows={lines}
      rowKey={(line) => line.key}
      minWidthClass="min-w-[48rem]"
      rowClassName={() => 'border-b border-sand-border/60 align-top last:border-0'}
      cardListLabel="Lines on this order"
    />
  );
}
