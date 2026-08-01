import { useState } from 'react';
import { useAuth } from '../../../hooks/useAuth';
import { useFolio } from '../../../hooks/useFolio';
import { describeError } from '../../../lib/errors';
import {
  formatMoney,
  formatQuantity,
  formatRatePercent,
  MISSING_VALUE,
  parseNumeric,
} from '../../../lib/format';
import { formatDisplayDate, isoDateInZone } from '../../../lib/date';
import {
  balanceDirection,
  balanceLabel,
  paymentMethodLabel,
} from '../../../lib/folioLabels';
import { staffLabel } from '../../../lib/staffLabel';
import type {
  FolioChargeTaxRow,
  FolioChargeWithCategory,
  FolioPayment,
} from '../../../types/folio';
import { AddChargeForm } from './AddChargeForm';
import { DiscountForm } from './DiscountForm';
import { TakePaymentForm } from './TakePaymentForm';
import { VoidForm } from './VoidForm';

// THE FOLIO PANEL (build 6c part 2 §1) — the guest's running account, as a tab
// inside the booking detail dialog.
//
// EVERY FIGURE ON THIS SCREEN IS COMPUTED BY THE DATABASE. The totals come from
// folio_totals, the tax lines from the folio_charge_taxes view (which is
// folio_charge_tax applied per charge by Postgres), and after any mutation the
// whole lot is re-read (rule 6 — no cached balance, here least of all). This
// component adds up nothing except what it needs to GROUP the tax rows it was
// given, and it never recomputes a figure it could have asked for.
//
// VOIDED ROWS ARE SHOWN, NOT HIDDEN. Struck through and badged, excluded from
// every total by the engine's NULL-safe filter. A bill that quietly drops a
// reversed line is a bill that cannot be audited.
//
// BUSINESS DATE, NOT CREATION TIME (rules 8, 12). Charges and payments sort by
// their charge_date / payment_date, and when a row was POSTED on a different day
// than it belongs to, that posting date is shown beside it — a back-dated charge
// keyed today must not look like today's business.

interface FolioPanelProps {
  bookingId: string;
  tenantId: string;
  propertyId: string;
  currency: string;
  timezone: string;
  // Tell the bookings list its balances have moved, so the Balance column and the
  // outstanding total refresh (they are read live, never cached).
  onFolioChanged: () => void;
}

type ActionState =
  | { kind: 'payment' }
  | { kind: 'charge' }
  | { kind: 'discount'; charge: FolioChargeWithCategory }
  | { kind: 'void-charge'; charge: FolioChargeWithCategory }
  | { kind: 'void-payment'; payment: FolioPayment }
  | null;

const TOTALS_NOTE =
  'Computed live from this folio: gross is every non-voided charge before ' +
  'discount; net is gross less discounts; tax is the property’s active taxes ' +
  'and service charges applied to each net line; charges is net plus tax; ' +
  'payments is every non-voided payment, net of refunds. Balance is charges less ' +
  'payments. Voided charges and voided payments are excluded. Nothing is stored ' +
  'or cached — these figures are recalculated on every read.';

export function FolioPanel({
  bookingId,
  tenantId,
  propertyId,
  currency,
  timezone,
  onFolioChanged,
}: FolioPanelProps) {
  const { user } = useAuth();
  const {
    folio,
    charges,
    payments,
    chargeTaxes,
    totals,
    discountThreshold,
    loading,
    error,
    reload,
  } = useFolio(bookingId, tenantId, propertyId);
  const [action, setAction] = useState<ActionState>(null);

  // After any write: re-read the folio from the database and refresh the list.
  async function afterMutation() {
    setAction(null);
    await reload();
    onFolioChanged();
  }

  if (loading && !folio) {
    return (
      <p className="py-8 text-center text-sm text-charcoal-muted" aria-live="polite">
        Loading folio…
      </p>
    );
  }

  if (error) {
    return (
      <div className="rounded-xl border border-sand-border bg-white/60 p-4 text-center">
        <p className="text-sm font-medium text-charcoal">
          We couldn’t load this folio.
        </p>
        {/* Rule 11: the REAL diagnostic, not a friendly substitution. */}
        <p className="mt-1 text-sm text-charcoal-muted">{describeError(error)}</p>
        <button
          type="button"
          onClick={() => void reload()}
          className="mt-3 rounded-full border border-sand-border bg-white/70 px-4 py-2 text-xs font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream"
        >
          Try again
        </button>
      </div>
    );
  }

  if (!folio) {
    // Every booking gets a folio from an AFTER INSERT trigger (021 §4.1), so this
    // is a real fault. Say so loudly rather than rendering a convincing ₦0.00.
    return (
      <p className="rounded-xl border border-sand-border bg-white/60 p-4 text-sm text-charcoal">
        This booking has no folio, which should not be possible. Nothing can be
        charged or paid until it is investigated — please contact support rather
        than treating this as a zero balance.
      </p>
    );
  }

  // Group the ONE tax fetch two ways: per charge for the line breakdown, and per
  // tax code for the folio-level tax lines. Both come from the same rows, so the
  // lines under the charges always sum to the tax line in the totals.
  const taxesByCharge = new Map<string, FolioChargeTaxRow[]>();
  const taxesByCode = new Map<string, { name: string; rate: string; total: number }>();
  for (const row of chargeTaxes) {
    const list = taxesByCharge.get(row.charge_id) ?? [];
    list.push(row);
    taxesByCharge.set(row.charge_id, list);

    const amount = parseNumeric(row.amount) ?? 0;
    const bucket = taxesByCode.get(row.code);
    if (bucket) {
      bucket.total += amount;
    } else {
      taxesByCode.set(row.code, {
        name: row.name,
        rate: row.rate,
        total: amount,
      });
    }
  }

  const balance = parseNumeric(totals?.balance) ?? 0;
  const direction = balanceDirection(balance);
  const folioOpen = folio.status === 'open';
  const folioClosed = folio.status === 'closed';
  const currentUserId = user?.id ?? null;

  return (
    <div className="space-y-5">
      {/* ---------------------------------------------------------------- */}
      {/* Totals — the answer to "what does this guest owe right now?"     */}
      {/* ---------------------------------------------------------------- */}
      <section className="rounded-xl border border-sand-border bg-sand/30 p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-sm font-semibold text-charcoal">Account summary</h3>
          <span className="flex items-center gap-2 text-xs text-charcoal-muted">
            {loading ? <span aria-live="polite">Updating…</span> : null}
            {/* Rule 16: how this number was calculated, in full. */}
            <span
              className="cursor-help"
              tabIndex={0}
              role="note"
              aria-label={TOTALS_NOTE}
              title={TOTALS_NOTE}
            >
              ⓘ How this is calculated
            </span>
          </span>
        </div>

        <dl className="mt-3 space-y-1">
          <TotalRow label="Charges before discount" value={totals?.gross_total} currency={currency} />
          <TotalRow label="Discounts" value={totals?.discount_total} currency={currency} negative />
          <TotalRow label="Net charges" value={totals?.net_total} currency={currency} />
          <TotalRow label="Tax & service charge" value={totals?.tax_total} currency={currency} />
          <TotalRow label="Total charges" value={totals?.charges_total} currency={currency} emphasis />
          <TotalRow label="Payments received" value={totals?.payments_total} currency={currency} negative />
        </dl>

        {/* The balance, labelled. A negative balance is money the hotel owes the
            guest — real, deliberately not floored at zero by the engine (021
            §8.3) — so it is shown as a positive amount under an explicit "refund
            due" label rather than as a bare minus nobody can interpret. */}
        <div
          className={`mt-3 flex flex-wrap items-baseline justify-between gap-2 rounded-lg border px-3 py-2.5 ${
            direction === 'refund_due'
              ? 'border-primary/40 bg-primary/5'
              : 'border-sand-border bg-white/70'
          }`}
        >
          <span className="text-sm font-semibold text-charcoal">
            {balanceLabel(direction)}
          </span>
          <span className="text-lg font-bold tabular-nums text-charcoal">
            {totals ? formatMoney(Math.abs(balance), currency) : MISSING_VALUE}
          </span>
        </div>

        {folio.status !== 'open' ? (
          <p className="mt-2 text-xs text-charcoal-muted">
            This folio is {folio.status}.{' '}
            {folioClosed
              ? 'A closed folio takes no further charges, payments or voids.'
              : 'A settled folio still accepts payments and refunds, but no new charges.'}
          </p>
        ) : null}
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* Actions                                                          */}
      {/* ---------------------------------------------------------------- */}
      {action === null ? (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setAction({ kind: 'payment' })}
            disabled={folioClosed}
            className="rounded-full bg-accent px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:cursor-not-allowed disabled:opacity-50"
          >
            Take payment / deposit
          </button>
          <button
            type="button"
            onClick={() => setAction({ kind: 'charge' })}
            disabled={!folioOpen}
            className="rounded-full border border-sand-border bg-white/70 px-4 py-2 text-xs font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:cursor-not-allowed disabled:opacity-50"
          >
            Add charge
          </button>
        </div>
      ) : null}

      {action?.kind === 'payment' ? (
        <TakePaymentForm
          folioId={folio.id}
          currency={currency}
          timezone={timezone}
          onDone={afterMutation}
          onCancel={() => setAction(null)}
        />
      ) : null}

      {action?.kind === 'charge' ? (
        <AddChargeForm
          folioId={folio.id}
          tenantId={tenantId}
          propertyId={propertyId}
          currency={currency}
          timezone={timezone}
          onDone={afterMutation}
          onCancel={() => setAction(null)}
        />
      ) : null}

      {action?.kind === 'discount' ? (
        <DiscountForm
          charge={action.charge}
          threshold={discountThreshold}
          currency={currency}
          onDone={afterMutation}
          onCancel={() => setAction(null)}
        />
      ) : null}

      {action?.kind === 'void-charge' ? (
        <VoidForm
          target={{
            kind: 'charge',
            id: action.charge.id,
            summary: `${action.charge.category?.name ?? 'Charge'}${
              action.charge.description ? ` — ${action.charge.description}` : ''
            } · ${formatMoney(action.charge.net_amount, currency)}`,
          }}
          onDone={afterMutation}
          onCancel={() => setAction(null)}
        />
      ) : null}

      {action?.kind === 'void-payment' ? (
        <VoidForm
          target={{
            kind: 'payment',
            id: action.payment.id,
            summary: `${paymentMethodLabel(action.payment.method)} · ${formatMoney(
              action.payment.amount,
              currency,
            )} · ${formatDisplayDate(action.payment.payment_date)}`,
          }}
          onDone={afterMutation}
          onCancel={() => setAction(null)}
        />
      ) : null}

      {/* ---------------------------------------------------------------- */}
      {/* Charges                                                          */}
      {/* ---------------------------------------------------------------- */}
      <section>
        <h3 className="mb-2 text-sm font-semibold text-charcoal">
          Charges{' '}
          <span className="font-normal text-charcoal-muted">
            ({charges.length})
          </span>
        </h3>
        {charges.length === 0 ? (
          <p className="rounded-xl border border-sand-border bg-white/60 px-3 py-6 text-center text-sm text-charcoal-muted">
            Nothing charged yet. Room nights post automatically at night audit;
            extras can be added above.
          </p>
        ) : (
          <ul className="divide-y divide-sand-border rounded-xl border border-sand-border bg-white/60">
            {charges.map((charge) => (
              <ChargeRow
                key={charge.id}
                charge={charge}
                taxes={taxesByCharge.get(charge.id) ?? []}
                currency={currency}
                timezone={timezone}
                currentUserId={currentUserId}
                canDiscount={folioOpen && !charge.is_voided && action === null}
                canVoid={!folioClosed && !charge.is_voided && action === null}
                onDiscount={() => setAction({ kind: 'discount', charge })}
                onVoid={() => setAction({ kind: 'void-charge', charge })}
              />
            ))}
          </ul>
        )}
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* Tax breakdown — computed, never stored                           */}
      {/* ---------------------------------------------------------------- */}
      {taxesByCode.size > 0 ? (
        <section>
          <h3 className="mb-2 text-sm font-semibold text-charcoal">
            Tax & service charge
          </h3>
          <ul className="divide-y divide-sand-border rounded-xl border border-sand-border bg-white/60">
            {[...taxesByCode.entries()].map(([code, tax]) => (
              <li
                key={code}
                className="flex items-baseline justify-between gap-3 px-3 py-2 text-sm"
              >
                <span className="text-charcoal">
                  {tax.name}{' '}
                  <span className="text-charcoal-muted">
                    ({formatRatePercent(tax.rate)})
                  </span>
                </span>
                <span className="tabular-nums text-charcoal">
                  {formatMoney(tax.total, currency)}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-[11px] text-charcoal-muted">
            Computed live from each charge’s net amount and this property’s active
            taxes — never stored, so a rate change cannot make history disagree
            with itself.
          </p>
        </section>
      ) : null}

      {/* ---------------------------------------------------------------- */}
      {/* Payments                                                         */}
      {/* ---------------------------------------------------------------- */}
      <section>
        <h3 className="mb-2 text-sm font-semibold text-charcoal">
          Payments{' '}
          <span className="font-normal text-charcoal-muted">
            ({payments.length})
          </span>
        </h3>
        {payments.length === 0 ? (
          <p className="rounded-xl border border-sand-border bg-white/60 px-3 py-6 text-center text-sm text-charcoal-muted">
            Nothing received yet.
          </p>
        ) : (
          <ul className="divide-y divide-sand-border rounded-xl border border-sand-border bg-white/60">
            {payments.map((payment) => (
              <PaymentRow
                key={payment.id}
                payment={payment}
                currency={currency}
                timezone={timezone}
                currentUserId={currentUserId}
                canVoid={!folioClosed && !payment.is_voided && action === null}
                onVoid={() => setAction({ kind: 'void-payment', payment })}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

// --- One charge, with its discount line and its tax lines -------------------

function ChargeRow({
  charge,
  taxes,
  currency,
  timezone,
  currentUserId,
  canDiscount,
  canVoid,
  onDiscount,
  onVoid,
}: {
  charge: FolioChargeWithCategory;
  taxes: FolioChargeTaxRow[];
  currency: string;
  timezone: string;
  currentUserId: string | null;
  canDiscount: boolean;
  canVoid: boolean;
  onDiscount: () => void;
  onVoid: () => void;
}) {
  const discount = parseNumeric(charge.discount_amount) ?? 0;
  const voided = charge.is_voided === true;
  // The posting timestamp only matters when it differs from the business date —
  // that is precisely the back-dated or late-posted row rule 8 asks us to make
  // visible, and showing it on every row would be noise. Compared in the
  // PROPERTY's timezone, so a charge keyed at 00:30 local (23:30 UTC the day
  // before) is not falsely reported as back-dated on every late shift.
  const postedDate = isoDateInZone(charge.created_at, timezone);
  const showPosted = postedDate !== '' && postedDate !== charge.charge_date;

  return (
    <li className={`px-3 py-3 ${voided ? 'bg-sand/20' : ''}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="min-w-0 flex-1">
          <p
            className={`text-sm font-semibold text-charcoal ${voided ? 'line-through' : ''}`}
          >
            {charge.category?.name ?? MISSING_VALUE}
            {charge.description ? (
              <span className="font-normal"> — {charge.description}</span>
            ) : null}
          </p>
          <p className="text-xs text-charcoal-muted">
            {formatDisplayDate(charge.charge_date)} ·{' '}
            {formatQuantity(charge.quantity)} ×{' '}
            {formatMoney(charge.unit_amount, currency)}
            {showPosted ? (
              <> · posted {formatDisplayDate(postedDate)}</>
            ) : null}
          </p>
        </div>
        <span
          className={`shrink-0 text-sm tabular-nums text-charcoal ${voided ? 'line-through' : ''}`}
        >
          {formatMoney(charge.gross_amount, currency)}
        </span>
      </div>

      {/* The discount as its OWN visible line — the model the engine is built
          around: a bill reads rack → discount → net, so the hotel can see what
          was given away and, crucially, on whose authority. */}
      {discount > 0 ? (
        <div className="mt-1.5 rounded-lg bg-sand/40 px-2.5 py-1.5">
          <div className="flex items-baseline justify-between gap-3 text-xs">
            <span className="font-semibold text-charcoal">Discount</span>
            <span className="tabular-nums text-charcoal">
              −{formatMoney(discount, currency)}
            </span>
          </div>
          <p className="mt-0.5 text-[11px] text-charcoal-muted">
            {charge.discount_reason || 'No reason recorded'} · approved by{' '}
            {staffLabel(charge.discount_approved_by, currentUserId)}
          </p>
        </div>
      ) : null}

      {/* Tax lines, straight from the database (folio_charge_taxes). A voided
          charge carries no tax and so has no lines here. */}
      {taxes.length > 0 ? (
        <ul className="mt-1.5 space-y-0.5">
          {taxes.map((t) => (
            <li
              key={t.tax_charge_id}
              className="flex items-baseline justify-between gap-3 text-[11px] text-charcoal-muted"
            >
              <span>
                {t.name} ({formatRatePercent(t.rate)})
              </span>
              <span className="tabular-nums">{formatMoney(t.amount, currency)}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {discount > 0 ? (
        <div className="mt-1.5 flex items-baseline justify-between gap-3 border-t border-sand-border pt-1.5 text-xs">
          <span className="font-semibold text-charcoal">Net</span>
          <span className="font-semibold tabular-nums text-charcoal">
            {formatMoney(charge.net_amount, currency)}
          </span>
        </div>
      ) : null}

      {voided ? (
        <p className="mt-1.5 inline-flex flex-wrap items-center gap-1.5 rounded-full bg-charcoal/10 px-2 py-0.5 text-[11px] font-semibold text-charcoal">
          Voided
          <span className="font-normal">
            {charge.void_reason ? `· ${charge.void_reason}` : ''} · by{' '}
            {staffLabel(charge.voided_by, currentUserId)} · excluded from totals
          </span>
        </p>
      ) : null}

      {canDiscount || canVoid ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {canDiscount ? (
            <RowAction onClick={onDiscount}>Discount</RowAction>
          ) : null}
          {canVoid ? <RowAction onClick={onVoid}>Void</RowAction> : null}
        </div>
      ) : null}
    </li>
  );
}

// --- One payment ------------------------------------------------------------

function PaymentRow({
  payment,
  currency,
  timezone,
  currentUserId,
  canVoid,
  onVoid,
}: {
  payment: FolioPayment;
  currency: string;
  timezone: string;
  currentUserId: string | null;
  canVoid: boolean;
  onVoid: () => void;
}) {
  const voided = payment.is_voided === true;
  const amount = parseNumeric(payment.amount) ?? 0;
  const postedDate = isoDateInZone(payment.created_at, timezone);
  const showPosted = postedDate !== '' && postedDate !== payment.payment_date;

  return (
    <li className={`px-3 py-3 ${voided ? 'bg-sand/20' : ''}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="min-w-0 flex-1">
          <p
            className={`text-sm font-semibold text-charcoal ${voided ? 'line-through' : ''}`}
          >
            {paymentMethodLabel(payment.method)}
            {/* A negative payment is a refund — say so rather than leaving a
                minus sign to carry the meaning. */}
            {amount < 0 ? (
              <span className="ml-1.5 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary">
                Refund
              </span>
            ) : null}
          </p>
          <p className="text-xs text-charcoal-muted">
            {formatDisplayDate(payment.payment_date)}
            {payment.reference ? ` · ref ${payment.reference}` : ''} · received by{' '}
            {staffLabel(payment.received_by, currentUserId)}
            {showPosted ? ` · posted ${formatDisplayDate(postedDate)}` : ''}
          </p>
        </div>
        <span
          className={`shrink-0 text-sm font-semibold tabular-nums text-charcoal ${voided ? 'line-through' : ''}`}
        >
          {formatMoney(payment.amount, currency)}
        </span>
      </div>

      {voided ? (
        <p className="mt-1.5 inline-flex flex-wrap items-center gap-1.5 rounded-full bg-charcoal/10 px-2 py-0.5 text-[11px] font-semibold text-charcoal">
          Voided
          <span className="font-normal">
            {payment.void_reason ? `· ${payment.void_reason}` : ''} · by{' '}
            {staffLabel(payment.voided_by, currentUserId)} · excluded from totals
          </span>
        </p>
      ) : null}

      {canVoid ? (
        <div className="mt-2">
          <RowAction onClick={onVoid}>Void</RowAction>
        </div>
      ) : null}
    </li>
  );
}

// --- Small shared bits ------------------------------------------------------

function TotalRow({
  label,
  value,
  currency,
  negative = false,
  emphasis = false,
}: {
  label: string;
  value: string | null | undefined;
  currency: string;
  // Discounts and payments REDUCE what is owed; showing them with a leading minus
  // makes the column read as the subtraction it is.
  negative?: boolean;
  emphasis?: boolean;
}) {
  const amount = parseNumeric(value);
  const text =
    amount === null
      ? MISSING_VALUE
      : `${negative && amount !== 0 ? '−' : ''}${formatMoney(Math.abs(amount), currency)}`;

  return (
    <div
      className={`flex items-baseline justify-between gap-3 text-sm ${
        emphasis ? 'border-t border-sand-border pt-1 font-semibold' : ''
      }`}
    >
      <dt className={emphasis ? 'text-charcoal' : 'text-charcoal-muted'}>{label}</dt>
      <dd className="tabular-nums text-charcoal">{text}</dd>
    </div>
  );
}

function RowAction({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-full border border-sand-border bg-white/80 px-3 py-1 text-[11px] font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream"
    >
      {children}
    </button>
  );
}
