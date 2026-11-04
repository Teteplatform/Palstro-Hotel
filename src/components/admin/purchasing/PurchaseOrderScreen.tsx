import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ScreenHeader } from '../../ui/ScreenHeader';
import { ActionMenu } from '../../ui/ActionMenu';
import { DataTable, type DataColumn } from '../../ui/DataTable';
import { TextField } from '../../ui/form';
import { useToast } from '../../ui/Toast';
import { useAuth } from '../../../hooks/useAuth';
import { staffLabel } from '../../../lib/staffLabel';
import { describeError, humanizeError } from '../../../lib/errors';
import { formatDisplayDate } from '../../../lib/date';
import { formatMoney, formatQuantity, MISSING_VALUE } from '../../../lib/format';
import {
  cancelPurchaseOrder,
  fetchPurchaseOrder,
  fetchPurchaseOrderLines,
  fetchPurchaseReceiptLines,
  groupDeliveries,
  newIdempotencyKey,
  placePurchaseOrder,
} from '../../../lib/purchasing';
import {
  NOTHING_OUTSTANDING,
  orderLinesSummary,
  PURCHASES_ABOUT,
  PURCHASES_ABOUT_TITLE,
  purchaseStatusLabel,
  purchaseStatusTone,
} from '../../../lib/purchasingLabels';
import type {
  PurchaseOrderLineStatus,
  PurchaseOrderSummary,
  PurchaseReceiptLineDetail,
} from '../../../types/purchasing';
import { ReceiveForm } from './ReceiveForm';
import { ReverseDeliveryForm } from './ReverseDeliveryForm';

// ONE PURCHASE ORDER — and RECEIVING HAPPENS HERE, on the same page.
//
// ---------------------------------------------------------------------------
// WHY RECEIVING IS NOT A SEPARATE SCREEN
// ---------------------------------------------------------------------------
// The person recording a delivery is standing beside it with a delivery note in
// their hand, and the question they are answering on every line is "how much of
// this was I expecting?". Putting the form anywhere other than on the order
// means either duplicating the ordered figures onto a second screen — where they
// can go stale — or making somebody hold them in their head while they walk
// between two pages.
//
// So the order's lines, its deliveries so far and the form are one page, in that
// order: what was asked for, what has come, and what is arriving now.

interface PurchaseOrderScreenProps {
  propertySlug: string;
  currency: string;
  today: string;
  purchaseOrderId: string;
}

export function PurchaseOrderScreen({
  propertySlug,
  currency,
  today,
  purchaseOrderId,
}: PurchaseOrderScreenProps) {
  const toast = useToast();
  // Only so an authorisation by the signed-in user reads as "you".
  const { user } = useAuth();

  const [order, setOrder] = useState<PurchaseOrderSummary | null>(null);
  const [lines, setLines] = useState<PurchaseOrderLineStatus[]>([]);
  const [receipts, setReceipts] = useState<PurchaseReceiptLineDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [receiving, setReceiving] = useState(false);
  // WHICH DELIVERY IS BEING UNDONE, by receipt id. One at a time: the form is
  // an irreversible act with a manager standing over it, and two of them open
  // at once is two PINs in two boxes with one pair of hands.
  const [reversingId, setReversingId] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [busy, setBusy] = useState(false);

  // THE FETCH LIVES IN THE EFFECT, and a write asks for a reload by bumping a
  // token rather than by calling a shared loader. Both shapes work; this one is
  // the shape the linter and React actually want (a setState called straight
  // from an effect body is a cascading render), and it is the shape MovementsList
  // and every other list in this codebase already uses — so there is one pattern
  // to recognise rather than two.
  const [reloadToken, setReloadToken] = useState(0);
  const reload = () => setReloadToken((n) => n + 1);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const [o, l, r] = await Promise.all([
          fetchPurchaseOrder(purchaseOrderId),
          fetchPurchaseOrderLines(purchaseOrderId),
          fetchPurchaseReceiptLines(purchaseOrderId),
        ]);
        if (cancelled) return;
        setOrder(o);
        setLines(l);
        setReceipts(r);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        setError(describeError(e)); // rule 11
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [purchaseOrderId, reloadToken]);

  async function send() {
    if (!order || busy) return;
    setBusy(true);
    try {
      await placePurchaseOrder(order.id, newIdempotencyKey());
      toast.success(`${order.order_number} sent.`);
      reload();
    } catch (e) {
      toast.error(humanizeError(e)); // the server's own words (rules 11, 21)
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (!order || busy) return;
    setBusy(true);
    try {
      await cancelPurchaseOrder(order.id, cancelReason, newIdempotencyKey());
      toast.success(`${order.order_number} cancelled.`);
      setCancelling(false);
      setCancelReason('');
      reload();
    } catch (e) {
      toast.error(humanizeError(e));
    } finally {
      setBusy(false);
    }
  }

  // THE LINES FOLDED BACK INTO DELIVERIES (the seam in lib/purchasing.ts). The
  // table is one row per receipt line; a reversal acts on a whole delivery, so
  // the fold is what the action and the "was reversed" sentences hang off.
  const deliveries = groupDeliveries(receipts);
  const reversing =
    deliveries.find((d) => d.receiptId === reversingId) ?? null;

  if (loading && !order) {
    return <p className="py-10 text-center text-sm text-charcoal-muted">Loading…</p>;
  }

  if (error) {
    return (
      <div className="rounded-2xl border border-sand-border bg-white/60 p-6 text-center">
        <p className="text-sm font-medium text-charcoal">
          This purchase order could not be loaded.
        </p>
        <p className="mt-1 text-sm text-charcoal-muted">{error}</p>
      </div>
    );
  }

  if (!order) {
    return (
      <div className="rounded-2xl border border-sand-border bg-white/60 p-6 text-center">
        <p className="text-sm text-charcoal-muted">
          That purchase order does not exist.
        </p>
        <Link
          to={`/admin/${propertySlug}/purchases`}
          className="mt-2 inline-block text-sm font-semibold text-primary underline-offset-2 hover:underline"
        >
          Back to Purchases
        </Link>
      </div>
    );
  }

  const canReceive = order.status === 'ordered' || order.status === 'part_received';
  // Three states, not a fraction of one — see orderLinesSummary for what the
  // walk read on an order that was plainly part-delivered.
  const lineCounts = {
    settled: lines.filter((l) => l.is_settled).length,
    partly: lines.filter((l) => !l.is_settled && l.received_quantity > 0).length,
    waiting: lines.filter((l) => !l.is_settled && l.received_quantity === 0).length,
  };

  return (
    <div className="space-y-4">
      <ScreenHeader
        title={order.order_number}
        purpose={`${order.supplier_name} · going to ${order.destination_name}`}
        about={{
          title: PURCHASES_ABOUT_TITLE,
          paragraphs: PURCHASES_ABOUT,
          guideAnchor: 'purchase-orders',
          guideLabel: 'Purchase orders',
        }}
        propertySlug={propertySlug}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`rounded-full px-3 py-1 text-xs font-semibold ${purchaseStatusTone(order.status)}`}
            >
              {purchaseStatusLabel(order.status)}
            </span>
            {order.status === 'draft' ? (
              <>
                <Link
                  to={`/admin/${propertySlug}/purchases/${order.id}/edit`}
                  className="rounded-full border border-sand-border px-4 py-2.5 text-sm font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream focus-visible:outline-none"
                >
                  Edit
                </Link>
                <button
                  type="button"
                  onClick={send}
                  disabled={busy}
                  className="rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-primary-hover focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Send to supplier
                </button>
              </>
            ) : null}
            {canReceive && !receiving ? (
              <button
                type="button"
                onClick={() => setReceiving(true)}
                className="rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-primary-hover focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream focus-visible:outline-none"
              >
                Record a delivery
              </button>
            ) : null}
            {order.status !== 'received' && order.status !== 'cancelled' ? (
              <ActionMenu
                label={`Actions for ${order.order_number}`}
                items={[
                  {
                    key: 'cancel',
                    label: 'Cancel this order',
                    hint: 'Anything already delivered stays on the record.',
                    tone: 'danger',
                    onSelect: () => setCancelling(true),
                    disabled: busy,
                  },
                ]}
              />
            ) : null}
          </div>
        }
      />

      {/* A LIVE CONSEQUENCE, shown only when it applies: a cancelled order that
          had already been part-delivered is the case somebody will be confused
          by, so the screen says what happened to the goods. */}
      {order.status === 'cancelled' ? (
        <p className="rounded-xl bg-sand/60 px-4 py-3 text-sm text-charcoal">
          Cancelled{order.cancelled_at ? ` on ${formatDisplayDate(order.cancelled_at.slice(0, 10))}` : ''}
          {order.cancel_reason ? ` — ${order.cancel_reason}` : ''}.
          {order.received_value > 0
            ? ` The ${formatMoney(order.received_value, currency)} that had already arrived is still in stock and still on the books.`
            : ''}
        </p>
      ) : null}

      {/* CANCELLING, AS AN ACTION FORM (rule 25): the SUBJECT is this order with
          its real figures, the EFFECT is what cancelling does to them, and what
          a cancellation IS lives behind the ⓘ. A browser prompt could carry
          none of the three. */}
      {cancelling ? (
        <div className="space-y-3 rounded-2xl border-2 border-primary/40 bg-primary/5 p-4">
          <p className="text-sm font-semibold text-charcoal">
            Cancel {order.order_number} — {order.supplier_name},{' '}
            {formatMoney(order.ordered_value, currency)}
          </p>
          <p className="text-sm text-charcoal">
            {order.received_value > 0
              ? `The ${formatMoney(order.received_value, currency)} already delivered stays in stock and stays on the books. Only the ${formatMoney(order.outstanding_value, currency)} still outstanding stops being expected.`
              : `Nothing has arrived against this order, so nothing moves. It stops being expected.`}
          </p>
          <TextField
            label="Why"
            value={cancelReason}
            onChange={setCancelReason}
            required
            placeholder="Supplier cannot supply"
            helpText="Recorded permanently against your name."
          />
          <div className="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setCancelling(false);
                setCancelReason('');
              }}
              className="rounded-full px-5 py-2.5 text-sm font-semibold text-charcoal-muted transition-colors hover:text-charcoal focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream focus-visible:outline-none"
            >
              Keep it
            </button>
            <button
              type="button"
              onClick={cancel}
              disabled={busy || cancelReason.trim().length === 0}
              className="rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-primary-hover focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? 'Cancelling…' : 'Cancel this order'}
            </button>
          </div>
        </div>
      ) : null}

      <dl className="grid gap-x-6 gap-y-1 rounded-2xl border border-sand-border bg-white/60 p-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <Fact label="Raised" value={formatDisplayDate(order.order_date)} />
        <Fact
          label="Expected"
          value={
            order.expected_date
              ? formatDisplayDate(order.expected_date)
              : MISSING_VALUE
          }
        />
        {/* BOTH AT THE AGREED PRICE, and the labels now say so. These two are
            consistent with each other — what changes basis is the deliveries
            table below, which is at the INVOICED price, and that is why the
            three figures a reader meets on this screen do not add up. */}
        <Fact
          label="Ordered, at the agreed price"
          value={formatMoney(order.ordered_value, currency)}
        />
        <Fact
          label="Still to come, at the agreed price"
          value={formatMoney(order.outstanding_value, currency)}
        />
      </dl>

      <div className="space-y-3 rounded-2xl border border-sand-border bg-white/60 p-4">
        <ScreenHeader
          level={2}
          title="What was ordered"
          purpose={orderLinesSummary(lineCounts)}
        />
        <OrderLinesTable lines={lines} currency={currency} />
      </div>

      {receiving ? (
        <ReceiveForm
          order={order}
          lines={lines}
          propertySlug={propertySlug}
          currency={currency}
          today={today}
          onReceived={() => {
            setReceiving(false);
            reload();
          }}
          onCancel={() => setReceiving(false)}
        />
      ) : null}

      {receipts.length > 0 ? (
        <div className="space-y-3 rounded-2xl border border-sand-border bg-white/60 p-4">
          <ScreenHeader
            level={2}
            title="Deliveries"
            purpose="What has arrived so far, at what the invoice charged."
          />

          {/* THE FORM OPENS ABOVE THE TABLE, not in a dialog. The figures the
              decision rests on are in the rows underneath it, and a modal that
              covers them makes somebody authorise a reversal from memory. */}
          {reversing ? (
            <ReverseDeliveryForm
              delivery={reversing}
              orderNumber={order.order_number}
              supplierName={order.supplier_name}
              currency={currency}
              propertySlug={propertySlug}
              onReversed={() => {
                setReversingId(null);
                reload();
              }}
              onCancel={() => setReversingId(null)}
            />
          ) : null}

          <ReceiptLinesTable
            rows={receipts}
            currency={currency}
            currentUserId={user?.id ?? null}
            onReverse={(receiptId) => setReversingId(receiptId)}
          />

          {/* WHAT WAS UNDONE, IN WORDS, WITH ITS REAL FIGURES. Not teaching and
              not a tooltip: a reversed delivery is two facts, and a table can
              carry "it arrived" in its columns but not "and it was sent back on
              this date, for this reason, approved by this person". Rule 25 keeps
              prose out of tables; it does not ask for a fact to be dropped
              because the table has no column for it. */}
          {deliveries
            .filter((d) => d.isReversed)
            .map((d) => (
              <p key={d.receiptId} className="text-xs text-charcoal-muted">
                <span className="font-semibold text-charcoal">
                  {d.receiptNumber}
                </span>{' '}
                was reversed
                {d.reversedOn ? ` on ${formatDisplayDate(d.reversedOn)}` : ''}
                {d.reversalApprovedBy
                  ? `, approved by ${staffLabel(d.reversalApprovedBy, user?.id ?? null)}`
                  : ''}
                {d.reversalReason ? ` — ${d.reversalReason}` : ''}. Its{' '}
                {formatMoney(d.value, currency)} is not counted in anything
                above.
              </p>
            ))}
        </div>
      ) : null}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="text-charcoal-muted">{label}</dt>
      <dd className="font-medium tabular-nums text-charcoal">{value}</dd>
    </div>
  );
}

// EXPORTED for the render proof (rule 22).
export function OrderLinesTable({
  lines,
  currency,
}: {
  lines: PurchaseOrderLineStatus[];
  currency: string;
}) {
  if (lines.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-charcoal-muted">
        Nothing on this order yet.
      </p>
    );
  }

  const columns: DataColumn<PurchaseOrderLineStatus>[] = [
    {
      key: 'item',
      role: 'heading',
      header: 'Item',
      cellClassName: 'pr-3',
      cell: (line) => (
        <>
          <span className="font-medium text-charcoal">
            {line.item_name ?? line.description}
          </span>
          {line.item_code ? (
            <span className="ml-2 text-xs text-charcoal-muted">
              {line.item_code}
            </span>
          ) : null}
          {/* THE SAME SLOT item_code USES, because it answers the same question
              about the line: which thing is this, exactly. On an expense line
              the category is the answer that matters — it is where the money
              lands — and it comes off 054's view, unfiltered on deleted_at, so
              a line raised against a since-retired category still names it. */}
          {line.expense_category_name ? (
            <span className="ml-2 text-xs text-charcoal-muted">
              {line.expense_category_name}
            </span>
          ) : null}
        </>
      ),
    },
    {
      key: 'ordered',
      header: 'Ordered',
      align: 'right',
      cellClassName: 'pr-3 tabular-nums text-charcoal',
      cell: (line) => (
        <>
          {formatQuantity(line.ordered_quantity)}
          {line.base_unit ? ` ${line.base_unit}` : ''}
        </>
      ),
    },
    {
      key: 'cost',
      header: 'Cost',
      align: 'right',
      cellClassName: 'pr-3 tabular-nums text-charcoal-muted',
      cell: (line) => formatMoney(line.ordered_unit_cost, currency),
    },
    {
      key: 'arrived',
      header: 'Arrived',
      align: 'right',
      cellClassName: 'pr-3 tabular-nums text-charcoal',
      cell: (line) => formatQuantity(line.received_quantity),
    },
    {
      key: 'outstanding',
      header: 'Outstanding',
      align: 'right',
      cellClassName: 'pr-3 tabular-nums text-charcoal',
      cell: (line) => formatQuantity(line.outstanding_quantity),
    },
    {
      key: 'state',
      header: 'State',
      cellClassName: 'text-xs',
      cell: (line) =>
        line.closed_short ? (
          <span className="text-charcoal-muted">Closed short</span>
        ) : line.is_settled ? (
          <span className="text-charcoal-muted">Complete</span>
        ) : (
          <span className="font-semibold text-amber-800">Waiting</span>
        ),
    },
  ];

  return (
    <div>
      <DataTable
        columns={columns}
        rows={lines}
        rowKey={(line) => line.purchase_order_line_id}
        minWidthClass="min-w-[44rem]"
        cardListLabel="Lines on this order"
      />
      {lines.every((l) => l.is_settled) ? (
        <p className="pt-3 text-sm text-charcoal-muted">{NOTHING_OUTSTANDING}</p>
      ) : null}
    </div>
  );
}

// THE AUTHORISER IS A COLUMN BECAUSE THE PIN DIALOG PROMISES IT IS.
//
// Before a manager types their PIN, this module tells them in these words: "the
// approval is recorded against them by name, permanently, and it can never be
// edited or deleted." 046 kept that promise — purchase_receipts.authorised_by is
// written and is immutable. Nothing in the application showed it. The walk
// over-received five litres, the database recorded who approved it, and no
// screen in the product could answer "who approved it".
//
// A promise a screen makes is a specification. This column is half of meeting
// it; the provenance report's fourth section (049) is the other half, for the
// owner who is looking across orders rather than at one.
export function ReceiptLinesTable({
  rows,
  currency,
  currentUserId,
  onReverse,
}: {
  rows: PurchaseReceiptLineDetail[];
  currency: string;
  // Only so the signed-in user reads as "you". staffLabel owns the rest, and
  // owns it in ONE place until a staff directory exists.
  currentUserId: string | null;
  // Omitted by the render proof's read-only cases, and by any future surface
  // that shows deliveries without being the place to undo one.
  onReverse?: (receiptId: string) => void;
}) {
  // A REVERSAL ACTS ON A DELIVERY AND THIS TABLE IS PER LINE, so the control
  // belongs to the FIRST row of each delivery — once per delivery, not once per
  // line. groupDeliveries already decides which row that is, and it is the same
  // fold the sentences under the table read, so the button and the sentence can
  // never disagree about which delivery they mean.
  const firstRowOf = new Map(
    groupDeliveries(rows).map((d) => [d.firstRowId, d]),
  );
  // A column of blanks on an order where nothing was ever authorised is noise,
  // so the column appears only when this order HAS an authorisation to show.
  // That is not the same as hiding it when it is inconvenient: the moment one
  // exists it is on screen for every row, with the un-authorised rows reading
  // as the dash that means "nobody had to".
  const anyAuthorised = rows.some((row) => row.authorised_by !== null);

  const columns: DataColumn<PurchaseReceiptLineDetail>[] = [
    {
      key: 'delivery',
      role: 'heading',
      header: 'Delivery',
      cellClassName: 'pr-3 font-medium text-charcoal',
      cell: (row) => {
        const group = firstRowOf.get(row.id);
        return (
          <span className="flex flex-wrap items-center gap-2">
            {/* THE NUMBER STAYS READABLE on a reversed delivery. It is not
                struck through: the delivery is a fact that still stands, and
                what changed is that nothing is counted from it. The chip says
                that, in a word, and the sentence under the table says the
                rest. */}
            <span>{row.receipt_number}</span>
            {row.is_reversed ? (
              <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary">
                Reversed
              </span>
            ) : group && onReverse ? (
              <button
                type="button"
                onClick={() => onReverse(group.receiptId)}
                className="rounded-full border border-sand-border bg-white/70 px-2 py-0.5 text-xs font-semibold text-charcoal-muted transition-colors hover:bg-sand hover:text-charcoal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream"
              >
                Reverse
              </button>
            ) : null}
          </span>
        );
      },
    },
    {
      key: 'date',
      header: 'Date',
      cellClassName: 'pr-3 text-charcoal-muted',
      cell: (row) => formatDisplayDate(row.business_date),
    },
    {
      key: 'item',
      header: 'Item',
      cellClassName: 'pr-3 text-charcoal',
      // ITEM NAME, THEN DESCRIPTION, THEN the dash. Before 055 this read
      // `row.item_name ?? MISSING_VALUE` and a delivered freezer showed as a
      // quantity, a cost and an em-dash — the placeholder behaving exactly as
      // section 6 intends, over a row that had a name nothing was reading.
      cell: (row) => row.item_name ?? row.description ?? MISSING_VALUE,
    },
    {
      key: 'arrived',
      header: 'Arrived',
      align: 'right',
      cellClassName: 'pr-3 tabular-nums text-charcoal',
      cell: (row) => (
        <>
          {formatQuantity(row.quantity)}
          {row.base_unit ? ` ${row.base_unit}` : ''}
          {row.closed_short ? (
            <span className="ml-2 rounded-full bg-sand px-2 py-0.5 text-xs text-charcoal-muted">
              Closed short
            </span>
          ) : null}
        </>
      ),
    },
    {
      key: 'invoiced',
      header: 'Invoiced',
      align: 'right',
      cellClassName: 'pr-3 tabular-nums text-charcoal-muted',
      cell: (row) => formatMoney(row.unit_cost, currency),
    },
    {
      // THE FIGURE THIS MODULE EXISTS TO SURFACE, and a cell that used to be
      // EMPTY when the cost had not changed. The reasoning was "a column of
      // dashes trains people to stop reading it", which is true about dashes and
      // wrong about blanks: on the walk, one delivery showed "+NGN 50.00" and
      // the one under it showed nothing, and nothing is indistinguishable from a
      // cell that failed to render. CLAUDE.md section 6 settles it — a figure
      // that is not there reads as the em-dash.
      key: 'costChange',
      header: 'Cost change',
      align: 'right',
      cellClassName: 'pr-3 tabular-nums',
      cell: (row) =>
        row.unit_cost_difference !== 0 ? (
          <span className="font-semibold text-amber-800">
            {row.unit_cost_difference > 0 ? '+' : ''}
            {formatMoney(row.unit_cost_difference, currency)}
          </span>
        ) : (
          <span className="text-charcoal-muted">{MISSING_VALUE}</span>
        ),
    },
    {
      key: 'value',
      header: 'Value',
      align: 'right',
      cellClassName: 'pr-3 tabular-nums text-charcoal',
      cell: (row) => formatMoney(row.line_value, currency),
    },
    ...(anyAuthorised
      ? ([
          {
            key: 'authorised',
            header: 'Authorised by',
            cellClassName: 'pr-3 text-charcoal-muted',
            cell: (row) =>
              row.authorised_by
                ? staffLabel(row.authorised_by, currentUserId)
                : MISSING_VALUE,
          },
        ] as DataColumn<PurchaseReceiptLineDetail>[])
      : []),
    {
      key: 'reason',
      header: 'Reason',
      cellClassName: 'text-charcoal-muted',
      cell: (row) => row.reason ?? MISSING_VALUE,
    },
  ];

  return (
    <DataTable
      columns={columns}
      rows={rows}
      rowKey={(row) => row.id}
      minWidthClass="min-w-[52rem]"
      cardListLabel="Deliveries against this order"
    />
  );
}
