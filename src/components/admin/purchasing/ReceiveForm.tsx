import { useState } from 'react';
import { CurrencyField, DateField, NumberField, TextArea, TextField } from '../../ui/form';
import { ManagerPinField } from '../ManagerPinField';
import { ScreenHeader } from '../../ui/ScreenHeader';
import { useToast } from '../../ui/Toast';
import { humanizeError } from '../../../lib/errors';
import { formatMoney, formatQuantity } from '../../../lib/format';
import {
  deliveryTotals,
  lineDifference,
  newIdempotencyKey,
  receivePurchaseOrder,
} from '../../../lib/purchasing';
import {
  NOTHING_OUTSTANDING,
  RECEIVE_ABOUT,
  RECEIVE_ABOUT_TITLE,
} from '../../../lib/purchasingLabels';
import type {
  PurchaseOrderLineStatus,
  PurchaseOrderSummary,
  ReceiptLineDraft,
} from '../../../types/purchasing';

// RECORD A DELIVERY, ON THE ORDER'S OWN PAGE (046 §6.4).
//
// ---------------------------------------------------------------------------
// THE THREE THINGS THIS FORM SHOWS, WHICH ARE NOT ONE THING (rule 25)
// ---------------------------------------------------------------------------
//   SUBJECT   the order line, with its real figures: "Rice — 50 kg ordered,
//             3 kg still outstanding at ₦1,200.00". On screen, always.
//   EFFECT    what THIS delivery does: 47 arrived against 50 outstanding, the
//             invoice is ₦40 a bag higher than the order, the delivery is worth
//             ₦56,400. On screen, always — somebody at the moment of an
//             irreversible act is deciding on exactly those numbers.
//   ABOUT     what a short delivery means, when a manager is needed, what
//             closing short does. Behind the ⓘ, and in the staff guide.
//
// The test between the last two: if it names a figure from the record in front
// of you it is an EFFECT; if it would read the same on a delivery you have never
// seen, it is an ABOUT.
//
// ---------------------------------------------------------------------------
// THE MANAGER IS ASKED FOR ONCE, BEFORE THE SERVER REFUSES
// ---------------------------------------------------------------------------
// deliveryTotals computes needsManager from what is being typed, so the PIN
// field appears the moment a quantity goes over — and the manager is fetched
// once rather than being sent away and called back after a refusal. That mirrors
// the server; it does not REPLACE it. Leave the PIN empty and submit anyway and
// 046 refuses in its own words, which are the words shown.
//
// THE PIN IS HELD FOR THE LENGTH OF ONE CALL AND CLEARED IN A `finally`. Never
// stored, never logged, exactly as the reversal form does it.

interface ReceiveFormProps {
  order: PurchaseOrderSummary;
  lines: PurchaseOrderLineStatus[];
  propertySlug: string;
  currency: string;
  today: string;
  onReceived: () => Promise<void> | void;
  onCancel: () => void;
}

const blankDraft = (line: PurchaseOrderLineStatus): ReceiptLineDraft => ({
  purchaseOrderLineId: line.purchase_order_line_id,
  // DELIBERATELY EMPTY, not pre-filled with the outstanding quantity. Rule 10
  // makes the same argument about a payment screen and it is the same argument
  // here: a pre-filled figure produces a false-positive full delivery that
  // nobody verified, and the whole point of this screen is to catch the delivery
  // that is three bags short.
  quantity: null,
  // The COST is pre-filled from the order, and that is a different case: it is
  // not a measurement of what arrived, it is the price you agreed, and the
  // screen's job is to make a CHANGE to it visible. Starting it blank would mean
  // retyping the same figure on every line of every delivery, which is how
  // people stop reading it.
  unitCost: line.ordered_unit_cost,
  closedShort: false,
  reason: '',
  batchCode: '',
  expiryDate: '',
  note: '',
});

export function ReceiveForm({
  order,
  lines,
  propertySlug,
  currency,
  today,
  onReceived,
  onCancel,
}: ReceiveFormProps) {
  const toast = useToast();

  // Only what is still expected. A settled line is not a row somebody should be
  // typing into, and leaving it out is how the form stays short on the fifth
  // delivery of a long order.
  const open = lines.filter((l) => !l.is_settled);

  // WHICH LINES ARE ON THIS DELIVERY. A line is added by ticking it, because
  // "leave out the ones that did not come" is the normal case and a form with
  // every line pre-armed makes not-receiving something an act of deletion.
  const [drafts, setDrafts] = useState<Map<string, ReceiptLineDraft>>(new Map());
  const [businessDate, setBusinessDate] = useState(today);
  const [deliveryNote, setDeliveryNote] = useState('');
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');
  const [pin, setPin] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  // Held with the key that produced it, so a retry after a network wobble
  // re-sends the SAME intent and cannot record the delivery twice (rules 2/3).
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);

  const totals = deliveryTotals(open, drafts);
  const notAStore = order.destination_kind !== 'store';
  const needsPin = totals.needsManager || notAStore;

  function toggle(line: PurchaseOrderLineStatus) {
    setDrafts((prev) => {
      const next = new Map(prev);
      if (next.has(line.purchase_order_line_id)) {
        next.delete(line.purchase_order_line_id);
      } else {
        next.set(line.purchase_order_line_id, blankDraft(line));
      }
      return next;
    });
  }

  function setDraft(id: string, patch: Partial<ReceiptLineDraft>) {
    setDrafts((prev) => {
      const current = prev.get(id);
      if (!current) return prev;
      const next = new Map(prev);
      next.set(id, { ...current, ...patch });
      return next;
    });
  }

  async function submit() {
    if (submitting) return;
    setSubmitting(true);
    setFormError(null);
    try {
      const receipt = await receivePurchaseOrder({
        purchaseOrderId: order.id,
        businessDate,
        lines: [...drafts.values()],
        deliveryNote: deliveryNote.trim() || null,
        invoiceNumber: invoiceNumber.trim() || null,
        note: note.trim() || null,
        idempotencyKey,
        managerPin: pin || null,
        reason: reason.trim() || null,
      });
      toast.success(`${receipt.receipt_number} recorded.`);
      // A NEW KEY for the NEXT delivery: the one just used belongs to the
      // delivery that landed, and reusing it would be refused by name.
      setIdempotencyKey(newIdempotencyKey());
      setDrafts(new Map());
      await onReceived();
    } catch (e) {
      setFormError(humanizeError(e)); // rules 11, 21 — the server's own words
    } finally {
      // NEVER KEPT. The PIN exists for the length of one call.
      setPin('');
      setSubmitting(false);
    }
  }

  if (open.length === 0) {
    return (
      <div className="rounded-2xl border border-sand-border bg-white/60 p-6 text-center">
        <p className="text-sm text-charcoal-muted">{NOTHING_OUTSTANDING}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4 rounded-2xl border border-sand-border bg-white/60 p-4">
      <ScreenHeader
        level={2}
        title="Record a delivery"
        purpose="What actually arrived, and what the invoice charges for it."
        about={{
          title: RECEIVE_ABOUT_TITLE,
          paragraphs: RECEIVE_ABOUT,
          guideAnchor: 'recording-a-delivery',
          guideLabel: 'Recording a delivery',
        }}
        propertySlug={propertySlug}
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <DateField
          label="Delivery date"
          value={businessDate}
          onChange={setBusinessDate}
          helpText="The day it arrived."
        />
        <TextField
          label="Delivery note"
          value={deliveryNote}
          onChange={setDeliveryNote}
          placeholder="Their reference"
        />
        <TextField
          label="Invoice number"
          value={invoiceNumber}
          onChange={setInvoiceNumber}
        />
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[62rem] text-sm">
          <thead>
            <tr className="border-b border-sand-border text-left text-xs font-medium text-charcoal-muted">
              <th className="w-10 py-2 pr-2" />
              <th className="py-2 pr-3">Item</th>
              <th className="py-2 pr-3 text-right">Outstanding</th>
              <th className="w-32 py-2 pr-3">Arrived</th>
              <th className="w-28 py-2 pr-3 text-right">Difference</th>
              <th className="w-40 py-2 pr-3">Invoiced cost</th>
              <th className="w-32 py-2 pr-3 text-right">Cost change</th>
              <th className="py-2 pr-3">Reason</th>
            </tr>
          </thead>
          <tbody>
            {open.map((line) => {
              const draft = drafts.get(line.purchase_order_line_id);
              const on = Boolean(draft);
              const diff = draft ? lineDifference(line, draft) : null;
              return (
                <ReceiveRow
                  key={line.purchase_order_line_id}
                  line={line}
                  draft={draft}
                  on={on}
                  diff={diff}
                  currency={currency}
                  onToggle={() => toggle(line)}
                  onPatch={(patch) => setDraft(line.purchase_order_line_id, patch)}
                />
              );
            })}
          </tbody>
        </table>
      </div>

      {/* THE EFFECT, in this delivery's own figures. Never hidden behind an
          icon: it is the sentence somebody is deciding on. */}
      {totals.lineCount > 0 ? (
        <div className="rounded-xl bg-sand/60 px-4 py-3 text-sm text-charcoal">
          <p>
            {totals.lineCount} line{totals.lineCount === 1 ? '' : 's'} on this
            delivery, worth{' '}
            <span className="font-semibold tabular-nums">
              {formatMoney(totals.invoiceValue, currency)}
            </span>{' '}
            at the invoiced prices.
          </p>
          {totals.costDifferenceValue !== 0 ? (
            <p className="mt-1">
              That is{' '}
              <span className="font-semibold tabular-nums">
                {formatMoney(Math.abs(totals.costDifferenceValue), currency)}
              </span>{' '}
              {totals.costDifferenceValue > 0 ? 'more' : 'less'} than the same
              quantities at the prices you ordered at (
              {formatMoney(totals.orderedValue, currency)}).
            </p>
          ) : null}
          <p className="mt-1 text-charcoal-muted">
            Stock goes up by what arrived, and what you owe this supplier goes up
            by {formatMoney(totals.invoiceValue, currency)}.
          </p>
        </div>
      ) : null}

      {/* A LIVE CONSEQUENCE (rule 25's "what is NOT teaching"): it appears only
          when this delivery actually needs a manager, and it names why. */}
      {needsPin ? (
        <div className="space-y-2">
          <ManagerPinField
            value={pin}
            onChange={setPin}
            title="A manager must authorise this delivery"
            // THE `lead` IS WHY A PIN IS NEEDED AT ALL, and it must not claim
            // "always": an ordinary delivery into the store needs none, which is
            // the whole reason this panel is conditional.
            lead={
              totals.needsManager && notAStore
                ? 'More arrived than was ordered, and it is not going to a store'
                : totals.needsManager
                  ? 'More arrived than was ordered'
                  : 'This delivery is not going to a store'
            }
            // AND THE `reason` IS WHAT ACCEPTING IT COMMITS THE HOTEL TO — this
            // delivery's own consequence, not a general statement.
            reason={
              totals.needsManager
                ? `accepting ${formatMoney(totals.invoiceValue, currency)} of goods commits the hotel to paying for more than it ordered.`
                : `goods reach ${order.destination_name} by being issued from the store, so a delivery straight there is an exception and is listed on the stock provenance report.`
            }
          />
          {notAStore ? (
            <TextField
              label="Why it went straight there"
              value={reason}
              onChange={setReason}
              placeholder="The driver took it to the bar"
              required
            />
          ) : null}
        </div>
      ) : null}

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
          onClick={submit}
          disabled={submitting || totals.lineCount === 0}
          className="rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-primary-hover focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? 'Recording…' : 'Record delivery'}
        </button>
      </div>
    </div>
  );
}

// EXPORTED so the render proof drives the REAL row (rule 22) rather than a copy
// of its markup — which would prove the copy.
export function ReceiveRow({
  line,
  draft,
  on,
  diff,
  currency,
  onToggle,
  onPatch,
}: {
  line: PurchaseOrderLineStatus;
  draft: ReceiptLineDraft | undefined;
  on: boolean;
  diff: ReturnType<typeof lineDifference> | null;
  currency: string;
  onToggle: () => void;
  onPatch: (patch: Partial<ReceiptLineDraft>) => void;
}) {
  return (
    <tr className="border-b border-sand-border/60 align-top last:border-0">
      <td className="py-2 pr-2 pt-4">
        <input
          type="checkbox"
          checked={on}
          onChange={onToggle}
          aria-label={`Include ${line.item_name ?? line.description ?? 'this line'} in this delivery`}
          className="h-4 w-4 rounded border-sand-border text-primary focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none"
        />
      </td>
      {/* THE SUBJECT: what you are acting on, with its real figures. */}
      <td className="py-2 pr-3 pt-3">
        <p className="font-medium text-charcoal">
          {line.item_name ?? line.description}
        </p>
        <p className="text-xs text-charcoal-muted">
          {formatQuantity(line.ordered_quantity)} {line.base_unit} ordered at{' '}
          {formatMoney(line.ordered_unit_cost, currency)}
        </p>
      </td>
      <td className="py-2 pr-3 pt-3 text-right tabular-nums text-charcoal">
        {formatQuantity(line.outstanding_quantity)} {line.base_unit}
      </td>
      <td className="py-2 pr-3">
        {on && draft ? (
          <NumberField
            label=""
            value={draft.quantity}
            onChange={(v) => onPatch({ quantity: v })}
            min={0}
            step="any"
            placeholder={line.base_unit ?? ''}
          />
        ) : null}
      </td>
      {/* THE EFFECT, per line, live. */}
      <td className="py-2 pr-3 pt-4 text-right tabular-nums">
        {diff && diff.quantityDifference !== 0 ? (
          <span
            className={
              diff.quantityDifference > 0
                ? 'font-semibold text-amber-800'
                : 'font-semibold text-charcoal'
            }
          >
            {diff.quantityDifference > 0 ? '+' : ''}
            {formatQuantity(diff.quantityDifference)}
          </span>
        ) : null}
      </td>
      <td className="py-2 pr-3">
        {on && draft ? (
          <CurrencyField
            label=""
            value={draft.unitCost}
            onChange={(v) => onPatch({ unitCost: v })}
            currency={currency}
          />
        ) : null}
      </td>
      <td className="py-2 pr-3 pt-4 text-right tabular-nums">
        {diff && diff.unitCostDifference !== 0 ? (
          <span className="font-semibold text-amber-800">
            {diff.unitCostDifference > 0 ? '+' : ''}
            {formatMoney(diff.unitCostDifference, currency)}
          </span>
        ) : null}
      </td>
      <td className="py-2 pr-3">
        {on && draft ? (
          <div className="space-y-2">
            {/* SHOWN ONLY WHEN THE SERVER WILL WANT IT. The field appearing is
                the prompt; the refusal, if it is left blank, is the database's. */}
            {diff?.needsReason ? (
              <TextField
                label=""
                value={draft.reason}
                onChange={(v) => onPatch({ reason: v })}
                placeholder="Why the difference"
                required
              />
            ) : null}
            <label className="flex items-center gap-2 text-xs text-charcoal-muted">
              <input
                type="checkbox"
                checked={draft.closedShort}
                onChange={(e) => onPatch({ closedShort: e.target.checked })}
                className="h-3.5 w-3.5 rounded border-sand-border text-primary focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none"
              />
              Nothing more coming
            </label>
            {line.tracks_expiry ? (
              <div className="grid gap-2 sm:grid-cols-2">
                <TextField
                  label="Batch"
                  value={draft.batchCode}
                  onChange={(v) => onPatch({ batchCode: v })}
                />
                <DateField
                  label="Expiry"
                  value={draft.expiryDate}
                  onChange={(v) => onPatch({ expiryDate: v })}
                />
              </div>
            ) : null}
          </div>
        ) : null}
      </td>
    </tr>
  );
}
