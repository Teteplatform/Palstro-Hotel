import { useState } from 'react';
import { CurrencyField, DateField, NumberField, TextArea, TextField } from '../../ui/form';
import { ManagerPinField } from '../ManagerPinField';
import { DataTable, type DataColumn } from '../../ui/DataTable';
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
  // MIRRORS 053's GATE, which is narrower than the destination. Before 053 the
  // server demanded a PIN whenever the destination was not a store, and this
  // line said the same; now both also require that the delivery actually move
  // stock. Leaving this as `|| notAStore` would show the PIN field for a
  // freezer going to the bar and then have the server refuse it with "No
  // manager PIN is needed for this delivery" — somebody fetches a manager, the
  // manager types their PIN, and the answer is that none was wanted.
  //
  // NAMED ONCE AND USED EVERYWHERE, because the three places below that ask
  // "is the destination a problem" must agree. Using `notAStore` in one of them
  // and this in another is how a form comes to demand a written reason for a
  // delivery the server is happy to take without one.
  const destinationNeedsAuthorisation = notAStore && totals.movesStock;
  const needsPin = totals.needsManager || destinationNeedsAuthorisation;

  // A REFUSAL IS ABOUT THE FORM AS IT WAS WHEN IT WAS SUBMITTED, and the walk
  // found it outliving that form: the delivery was refused for the over-receipt,
  // the over-received line was then unticked, and "You do not have permission to
  // make this change" stayed on screen underneath a form it no longer described.
  // A stale refusal is worse than none — it is a true sentence about a thing
  // that is no longer being attempted, and the reader cannot tell. So every edit
  // retires it, and the next submit earns a new one.
  function edited() {
    setFormError((current) => (current === null ? current : null));
  }

  function toggle(line: PurchaseOrderLineStatus) {
    edited();
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
    edited();
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
          onChange={(v) => { edited(); setBusinessDate(v); }}
          helpText="The day it arrived."
        />
        <TextField
          label="Delivery note"
          value={deliveryNote}
          onChange={(v) => { edited(); setDeliveryNote(v); }}
          placeholder="Their reference"
        />
        <TextField
          label="Invoice number"
          value={invoiceNumber}
          onChange={(v) => { edited(); setInvoiceNumber(v); }}
        />
      </div>

      <ReceiveLinesTable
        lines={open}
        drafts={drafts}
        currency={currency}
        onToggle={toggle}
        onPatch={setDraft}
      />

      {/* THE REFUSAL SITS AGAINST THE TABLE IT IS ABOUT.
          It used to render at the very bottom, below the Note box and the
          manager panel, which on the walk put "Rice (long grain): 100 was
          outstanding and 90 arrived…" most of a screen away from the rice.
          Here it is the first thing under the rows it names.

          IT IS STILL NOT MARKED ON THE FIELD, and that is deliberate rather
          than unfinished: knowing WHICH field a refusal belongs to would mean
          parsing the database's sentence in the client, which is rule 21's
          defect wearing a helpful face — the client would be deciding what the
          server meant, and would go on deciding it wrongly the first time the
          server's wording changed. Proximity is what the client can honestly
          offer. role="alert" is what a screen reader gets. */}
      {formError ? (
        <p
          role="alert"
          className="rounded-lg bg-primary/10 px-3 py-2 text-sm text-charcoal"
        >
          {formError}
        </p>
      ) : null}

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
            onChange={(v) => { edited(); setPin(v); }}
            title="A manager must authorise this delivery"
            // THE `lead` IS WHY A PIN IS NEEDED AT ALL, and it must not claim
            // "always": an ordinary delivery into the store needs none, which is
            // the whole reason this panel is conditional.
            lead={
              totals.needsManager && destinationNeedsAuthorisation
                ? 'More arrived than was ordered, and the stock is not going to a store'
                : totals.needsManager
                  ? 'More arrived than was ordered'
                  : 'This delivery puts stock somewhere that is not a store'
            }
            // AND THE `reason` IS WHAT ACCEPTING IT COMMITS THE HOTEL TO — this
            // delivery's own consequence, not a general statement.
            reason={
              totals.needsManager
                ? `accepting ${formatMoney(totals.invoiceValue, currency)} of goods commits the hotel to paying for more than it ordered.`
                : `stock reaches ${order.destination_name} by being issued from the store, so a delivery straight there is an exception and is listed on the stock provenance report.`
            }
          />
          {destinationNeedsAuthorisation ? (
            <TextField
              label="Why it went straight there"
              value={reason}
              onChange={(v) => { edited(); setReason(v); }}
              placeholder="The driver took it to the bar"
              required
            />
          ) : null}
        </div>
      ) : null}

      <TextArea label="Note" value={note} onChange={(v) => { edited(); setNote(v); }} rows={2} />

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


// THE COLUMN SPEC, DECLARED ONCE, RENDERED AS A TABLE OR AS CARDS (1.1a2).
//
// This replaced a hand-written `<table>` plus a `ReceiveRow` that emitted eight
// `<td>`s. The two shapes now come from this one list, which is the point: a
// ninth column cannot arrive in the table and be forgotten on the phone,
// because there is nowhere to add it that only one shape reads.
//
// THE ROLES ARE WHERE THE LAYOUT DECISION LIVES, and the three that matter here:
//
//   * `Item` is the HEADING. On a phone it is the card's title, with no "Item:"
//     caption in front of it — the name of a thing does not need a label saying
//     that it is a name.
//   * `Arrived`, `Invoiced cost` and `Reason` are CONTROLS, so on a phone they
//     get their label above and the full width of the card. An input in the
//     value half of a label/value pair at 360px is a 120px box, which is how a
//     quantity gets mistyped.
//   * `Reason` IS IN THE SAME CARD AS THE ITEM AND THE QUANTITY, and that is the
//     whole ruling. On the live walk Item sat at x=40 and Reason at x=922 inside
//     a 295px window, so they could not be seen together at any scroll position
//     — and Reason is the field the server REQUIRES the moment a delivery
//     differs. It is not behind a disclosure either: a tap to reveal the
//     mandatory field recreates the same bug one layer deeper.
//
// EXPORTED so the render proof drives the REAL table (rule 22) rather than a
// copy of its markup, which would prove the copy.
export function ReceiveLinesTable({
  lines,
  drafts,
  currency,
  onToggle,
  onPatch,
}: {
  lines: PurchaseOrderLineStatus[];
  drafts: Map<string, ReceiptLineDraft>;
  currency: string;
  onToggle: (line: PurchaseOrderLineStatus) => void;
  onPatch: (id: string, patch: Partial<ReceiptLineDraft>) => void;
}) {
  const draftOf = (line: PurchaseOrderLineStatus) =>
    drafts.get(line.purchase_order_line_id);
  const diffOf = (line: PurchaseOrderLineStatus) => {
    const draft = draftOf(line);
    return draft ? lineDifference(line, draft) : null;
  };
  const label = (line: PurchaseOrderLineStatus) =>
    line.item_name ?? line.description ?? 'this line';

  const columns: DataColumn<PurchaseOrderLineStatus>[] = [
    {
      key: 'include',
      role: 'select',
      header: '',
      headerClassName: 'w-10 pr-2',
      cellClassName: 'pr-2 pt-4',
      cell: (line) => (
        <input
          type="checkbox"
          checked={Boolean(draftOf(line))}
          onChange={() => onToggle(line)}
          aria-label={`Include ${label(line)} in this delivery`}
          className="h-4 w-4 rounded border-sand-border text-primary focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none"
        />
      ),
    },
    {
      key: 'item',
      role: 'heading',
      header: 'Item',
      cellClassName: 'pr-3 pt-3',
      // THE SUBJECT: what you are acting on, with its real figures (rule 25).
      cell: (line) => (
        <>
          <p className="font-medium text-charcoal">{label(line)}</p>
          <p className="text-xs text-charcoal-muted">
            {formatQuantity(line.ordered_quantity)}
            {line.base_unit ? ` ${line.base_unit}` : ''} ordered at{' '}
            {formatMoney(line.ordered_unit_cost, currency)}
          </p>
        </>
      ),
    },
    {
      key: 'outstanding',
      header: 'Outstanding',
      align: 'right',
      cellClassName: 'pr-3 pt-3 tabular-nums text-charcoal',
      cell: (line) => (
        <>
          {formatQuantity(line.outstanding_quantity)}
          {line.base_unit ? ` ${line.base_unit}` : ''}
        </>
      ),
    },
    {
      key: 'arrived',
      role: 'control',
      header: 'Arrived',
      headerClassName: 'w-32 pr-3',
      cellClassName: 'pr-3',
      cell: (line) => {
        const draft = draftOf(line);
        if (!draft) return null;
        return (
          <NumberField
            label=""
            value={draft.quantity}
            onChange={(v) => onPatch(line.purchase_order_line_id, { quantity: v })}
            min={0}
            step="any"
            placeholder={line.base_unit ?? ''}
          />
        );
      },
    },
    {
      key: 'difference',
      header: 'Difference',
      align: 'right',
      headerClassName: 'w-28 pr-3',
      cellClassName: 'pr-3 pt-4 tabular-nums',
      // THE EFFECT, per line, live. Renders nothing until a quantity has been
      // typed — "nothing entered" is not "none arrived" (see lineDifference).
      cell: (line) => {
        const diff = diffOf(line);
        if (!diff || diff.quantityDifference === 0) return null;
        return (
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
        );
      },
    },
    {
      key: 'invoiced',
      role: 'control',
      header: 'Invoiced cost',
      headerClassName: 'w-40 pr-3',
      cellClassName: 'pr-3',
      cell: (line) => {
        const draft = draftOf(line);
        if (!draft) return null;
        return (
          <CurrencyField
            label=""
            value={draft.unitCost}
            onChange={(v) => onPatch(line.purchase_order_line_id, { unitCost: v })}
            currency={currency}
          />
        );
      },
    },
    {
      key: 'costChange',
      header: 'Cost change',
      align: 'right',
      headerClassName: 'w-32 pr-3',
      cellClassName: 'pr-3 pt-4 tabular-nums',
      cell: (line) => {
        const diff = diffOf(line);
        if (!diff || diff.unitCostDifference === 0) return null;
        return (
          <span className="font-semibold text-amber-800">
            {diff.unitCostDifference > 0 ? '+' : ''}
            {formatMoney(diff.unitCostDifference, currency)}
          </span>
        );
      },
    },
    {
      key: 'reason',
      role: 'control',
      header: 'Reason',
      cellClassName: 'pr-3',
      cell: (line) => {
        const draft = draftOf(line);
        if (!draft) return null;
        const diff = diffOf(line);
        return (
          <div className="space-y-2">
            {/* SHOWN ONLY WHEN THE SERVER WILL WANT IT. The field appearing is
                the prompt; the refusal, if it is left blank, is the database's. */}
            {diff?.needsReason ? (
              <TextField
                label=""
                value={draft.reason}
                onChange={(v) => onPatch(line.purchase_order_line_id, { reason: v })}
                placeholder="Why the difference"
                required
              />
            ) : null}
            <label className="flex items-center gap-2 text-xs text-charcoal-muted">
              <input
                type="checkbox"
                checked={draft.closedShort}
                onChange={(e) =>
                  onPatch(line.purchase_order_line_id, {
                    closedShort: e.target.checked,
                  })
                }
                className="h-3.5 w-3.5 rounded border-sand-border text-primary focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none"
              />
              Nothing more coming
            </label>
            {line.tracks_expiry ? (
              <div className="grid gap-2 sm:grid-cols-2">
                <TextField
                  label="Batch"
                  value={draft.batchCode}
                  onChange={(v) =>
                    onPatch(line.purchase_order_line_id, { batchCode: v })
                  }
                />
                <DateField
                  label="Expiry"
                  value={draft.expiryDate}
                  onChange={(v) =>
                    onPatch(line.purchase_order_line_id, { expiryDate: v })
                  }
                />
              </div>
            ) : null}
          </div>
        );
      },
    },
  ];

  return (
    <DataTable
      columns={columns}
      rows={lines}
      rowKey={(line) => line.purchase_order_line_id}
      minWidthClass="min-w-[62rem]"
      rowClassName={() => 'border-b border-sand-border/60 align-top last:border-0'}
      cardListLabel="Lines on this delivery"
    />
  );
}
