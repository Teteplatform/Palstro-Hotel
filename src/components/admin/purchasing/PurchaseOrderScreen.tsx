import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ScreenHeader } from '../../ui/ScreenHeader';
import { ActionMenu } from '../../ui/ActionMenu';
import { TextField } from '../../ui/form';
import { useToast } from '../../ui/Toast';
import { describeError, humanizeError } from '../../../lib/errors';
import { formatDisplayDate } from '../../../lib/date';
import { formatMoney, formatQuantity, MISSING_VALUE } from '../../../lib/format';
import {
  cancelPurchaseOrder,
  fetchPurchaseOrder,
  fetchPurchaseOrderLines,
  fetchPurchaseReceiptLines,
  newIdempotencyKey,
  placePurchaseOrder,
} from '../../../lib/purchasing';
import {
  NOTHING_OUTSTANDING,
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

  const [order, setOrder] = useState<PurchaseOrderSummary | null>(null);
  const [lines, setLines] = useState<PurchaseOrderLineStatus[]>([]);
  const [receipts, setReceipts] = useState<PurchaseReceiptLineDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [receiving, setReceiving] = useState(false);
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
  const settled = lines.filter((l) => l.is_settled).length;

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
        <Fact label="Ordered" value={formatMoney(order.ordered_value, currency)} />
        <Fact
          label="Outstanding"
          value={formatMoney(order.outstanding_value, currency)}
        />
      </dl>

      <div className="space-y-3 rounded-2xl border border-sand-border bg-white/60 p-4">
        <ScreenHeader
          level={2}
          title="What was ordered"
          purpose={`${settled} of ${lines.length} line${lines.length === 1 ? '' : 's'} settled.`}
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
          <ReceiptLinesTable rows={receipts} currency={currency} />
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
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[44rem] text-sm">
        <thead>
          <tr className="border-b border-sand-border text-left text-xs font-medium text-charcoal-muted">
            <th className="py-2 pr-3">Item</th>
            <th className="py-2 pr-3 text-right">Ordered</th>
            <th className="py-2 pr-3 text-right">Cost</th>
            <th className="py-2 pr-3 text-right">Arrived</th>
            <th className="py-2 pr-3 text-right">Outstanding</th>
            <th className="py-2">State</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => (
            <tr
              key={line.purchase_order_line_id}
              className="border-b border-sand-border/60 last:border-0"
            >
              <td className="py-2 pr-3">
                <span className="font-medium text-charcoal">
                  {line.item_name ?? line.description}
                </span>
                {line.item_code ? (
                  <span className="ml-2 text-xs text-charcoal-muted">
                    {line.item_code}
                  </span>
                ) : null}
              </td>
              <td className="py-2 pr-3 text-right tabular-nums text-charcoal">
                {formatQuantity(line.ordered_quantity)} {line.base_unit}
              </td>
              <td className="py-2 pr-3 text-right tabular-nums text-charcoal-muted">
                {formatMoney(line.ordered_unit_cost, currency)}
              </td>
              <td className="py-2 pr-3 text-right tabular-nums text-charcoal">
                {formatQuantity(line.received_quantity)}
              </td>
              <td className="py-2 pr-3 text-right tabular-nums text-charcoal">
                {formatQuantity(line.outstanding_quantity)}
              </td>
              <td className="py-2 text-xs">
                {line.closed_short ? (
                  <span className="text-charcoal-muted">Closed short</span>
                ) : line.is_settled ? (
                  <span className="text-charcoal-muted">Complete</span>
                ) : (
                  <span className="font-semibold text-amber-800">Waiting</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {lines.every((l) => l.is_settled) ? (
        <p className="pt-3 text-sm text-charcoal-muted">{NOTHING_OUTSTANDING}</p>
      ) : null}
    </div>
  );
}

export function ReceiptLinesTable({
  rows,
  currency,
}: {
  rows: PurchaseReceiptLineDetail[];
  currency: string;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[52rem] text-sm">
        <thead>
          <tr className="border-b border-sand-border text-left text-xs font-medium text-charcoal-muted">
            <th className="py-2 pr-3">Delivery</th>
            <th className="py-2 pr-3">Date</th>
            <th className="py-2 pr-3">Item</th>
            <th className="py-2 pr-3 text-right">Arrived</th>
            <th className="py-2 pr-3 text-right">Invoiced</th>
            <th className="py-2 pr-3 text-right">Cost change</th>
            <th className="py-2 pr-3 text-right">Value</th>
            <th className="py-2">Reason</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.id}
              className="border-b border-sand-border/60 last:border-0"
            >
              <td className="py-2 pr-3 font-medium text-charcoal">
                {row.receipt_number}
              </td>
              <td className="py-2 pr-3 text-charcoal-muted">
                {formatDisplayDate(row.business_date)}
              </td>
              <td className="py-2 pr-3 text-charcoal">
                {row.item_name ?? MISSING_VALUE}
              </td>
              <td className="py-2 pr-3 text-right tabular-nums text-charcoal">
                {formatQuantity(row.quantity)} {row.base_unit}
                {row.closed_short ? (
                  <span className="ml-2 rounded-full bg-sand px-2 py-0.5 text-xs text-charcoal-muted">
                    Closed short
                  </span>
                ) : null}
              </td>
              <td className="py-2 pr-3 text-right tabular-nums text-charcoal-muted">
                {formatMoney(row.unit_cost, currency)}
              </td>
              {/* THE FIGURE THIS MODULE EXISTS TO SURFACE. Shown only when it is
                  not zero — a column of dashes trains people to stop reading it. */}
              <td className="py-2 pr-3 text-right tabular-nums">
                {row.unit_cost_difference !== 0 ? (
                  <span className="font-semibold text-amber-800">
                    {row.unit_cost_difference > 0 ? '+' : ''}
                    {formatMoney(row.unit_cost_difference, currency)}
                  </span>
                ) : null}
              </td>
              <td className="py-2 pr-3 text-right tabular-nums text-charcoal">
                {formatMoney(row.line_value, currency)}
              </td>
              <td className="py-2 text-charcoal-muted">{row.reason ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
