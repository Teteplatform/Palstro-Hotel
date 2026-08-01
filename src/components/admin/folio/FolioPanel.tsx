import { useState, type ReactNode } from 'react';
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
import { paymentMethodLabel } from '../../../lib/folioLabels';
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

// THE FOLIO TAB — the guest's account, presented as a statement (build A §2).
//
// PRESENTATION CHANGED, NOTHING ELSE. No RPC, no money computation and no total
// on this screen has changed: every figure still comes from folio_totals and the
// folio_charge_taxes view, re-read after every mutation (rule 6 — no cached
// balance). What changed is the shape: an account-summary TABLE, and a
// TRIAL-BALANCE LEDGER with two figure columns, column totals and a grand total,
// instead of stacked label/value pairs.
//
// THE LEDGER RECONCILES BY CONSTRUCTION (rule 9). Each charge contributes its NET
// to the Charges column and each of its tax lines contributes its own amount, so
// the Charges column sums to exactly folio_totals.charges_total (= net + tax).
// The Payments column sums to payments_total. The grand total is therefore
// charges − payments = balance. The footer prints the ENGINE's figures, not the
// column arithmetic, so if a presentation bug ever made them differ, the screen
// shows the database's number and the discrepancy is visible rather than hidden.
//
// VOIDED ROWS ARE SHOWN, NOT HIDDEN — struck through, with no figure in either
// column, because the engine excludes them from every total. A bill that quietly
// drops a reversed line cannot be audited.
//
// BUSINESS DATE, NOT CREATION TIME (rules 8, 12): the statement is ordered by
// charge_date / payment_date, and a posting date is shown only when it differs.

interface FolioPanelProps {
  bookingId: string;
  tenantId: string;
  propertyId: string;
  currency: string;
  timezone: string;
  // Tell the bookings list its balances have moved, so the Balance column and the
  // outstanding total refresh (neither is cached anywhere).
  onFolioChanged: () => void;
}

type ActionState =
  | { kind: 'payment' }
  | { kind: 'charge' }
  | { kind: 'discount'; charge: FolioChargeWithCategory }
  | { kind: 'void-charge'; charge: FolioChargeWithCategory }
  | { kind: 'void-payment'; payment: FolioPayment }
  | null;

// One line of the statement. `charge` and `payment` are the two figure columns;
// exactly one of them carries a number on a live row, and neither does on a
// voided one.
interface LedgerLine {
  key: string;
  date: string;
  postedDate: string | null;
  detail: ReactNode;
  charge: number | null;
  payment: number | null;
  voided: boolean;
  // A tax line sits under the charge it belongs to and is indented.
  sub: boolean;
  actions?: ReactNode;
}

const TOTALS_NOTE =
  'Computed live from this folio: gross is every non-voided charge before ' +
  'discount; net is gross less discounts; tax is the property’s active taxes ' +
  'and service charges applied to each net line; charges is net plus tax; ' +
  'payments is every non-voided payment, net of refunds. Outstanding balance is ' +
  'charges less payments. Voided charges and voided payments are excluded. ' +
  'Nothing is stored or cached — these figures are recalculated on every read.';

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
      <div className="rounded-2xl border border-sand-border bg-white/60 p-4 text-center">
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
      <p className="rounded-2xl border border-sand-border bg-white/60 p-4 text-sm text-charcoal">
        This booking has no folio, which should not be possible. Nothing can be
        charged or paid until it is investigated — please contact support rather
        than treating this as a zero balance.
      </p>
    );
  }

  const currentUserId = user?.id ?? null;
  const folioOpen = folio.status === 'open';
  const folioClosed = folio.status === 'closed';
  const balance = parseNumeric(totals?.balance) ?? 0;

  // Group the ONE tax fetch two ways: per charge for the statement's tax lines,
  // and per tax code for the tax summary. Both from the same rows, so the lines
  // and the summary can never disagree.
  const taxesByCharge = new Map<string, FolioChargeTaxRow[]>();
  const taxesByCode = new Map<string, { name: string; rate: string; total: number }>();
  for (const row of chargeTaxes) {
    const list = taxesByCharge.get(row.charge_id) ?? [];
    list.push(row);
    taxesByCharge.set(row.charge_id, list);

    const amount = parseNumeric(row.amount) ?? 0;
    const bucket = taxesByCode.get(row.code);
    if (bucket) bucket.total += amount;
    else taxesByCode.set(row.code, { name: row.name, rate: row.rate, total: amount });
  }

  const lines = buildLedger({
    charges,
    payments,
    taxesByCharge,
    currency,
    timezone,
    currentUserId,
    canAct: action === null,
    folioOpen,
    folioClosed,
    onDiscount: (charge) => setAction({ kind: 'discount', charge }),
    onVoidCharge: (charge) => setAction({ kind: 'void-charge', charge }),
    onVoidPayment: (payment) => setAction({ kind: 'void-payment', payment }),
  });
  const runningBalances = runningBalanceSeries(lines);

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-bold tracking-tight text-charcoal">Folio</h2>
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
      </header>

      {/* The action forms — unchanged behaviour, only their place on the page. */}
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
      {/* Account summary — a table, ending in the outstanding balance.    */}
      {/* ---------------------------------------------------------------- */}
      <div className="overflow-hidden rounded-2xl border border-sand-border bg-white/60">
        <table className="w-full border-collapse text-sm">
          <caption className="flex flex-wrap items-center justify-between gap-2 border-b border-sand-border bg-sand/40 px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-charcoal-muted">
            <span>Account summary</span>
            <span className="flex items-center gap-2 normal-case">
              {loading ? <span aria-live="polite">Updating…</span> : null}
              {/* Rule 16: how these figures were calculated, in full. */}
              <span
                className="cursor-help font-normal"
                tabIndex={0}
                role="note"
                aria-label={TOTALS_NOTE}
                title={TOTALS_NOTE}
              >
                ⓘ How this is calculated
              </span>
            </span>
          </caption>
          <tbody className="divide-y divide-sand-border/70">
            <SummaryRow label="Charges before discount" value={totals?.gross_total} currency={currency} />
            <SummaryRow label="Discounts" value={totals?.discount_total} currency={currency} negative />
            <SummaryRow label="Net charges" value={totals?.net_total} currency={currency} />
            <SummaryRow label="Tax & service charge" value={totals?.tax_total} currency={currency} />
            <SummaryRow label="Total charges" value={totals?.charges_total} currency={currency} strong />
            <SummaryRow label="Payments received" value={totals?.payments_total} currency={currency} negative />
          </tbody>
          <tfoot>
            <BalanceRow balance={totals ? balance : null} currency={currency} colSpan={1} />
          </tfoot>
        </table>
      </div>

      {/* ---------------------------------------------------------------- */}
      {/* The statement — trial-balance style                              */}
      {/* ---------------------------------------------------------------- */}
      <div className="overflow-x-auto rounded-2xl border border-sand-border bg-white/60">
        <table className="w-full min-w-[42rem] border-collapse text-sm">
          <caption className="border-b border-sand-border bg-sand/40 px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-charcoal-muted">
            Statement
          </caption>
          <thead>
            <tr className="border-b border-sand-border/70 text-left">
              <th scope="col" className="w-[6.5rem] px-4 py-2 text-xs font-semibold text-charcoal-muted">
                Date
              </th>
              <th scope="col" className="px-4 py-2 text-xs font-semibold text-charcoal-muted">
                Detail
              </th>
              <th scope="col" className="w-[8rem] px-4 py-2 text-right text-xs font-semibold text-charcoal-muted">
                Charges
              </th>
              <th scope="col" className="w-[8rem] px-4 py-2 text-right text-xs font-semibold text-charcoal-muted">
                Payments
              </th>
              <th scope="col" className="w-[8rem] px-4 py-2 text-right text-xs font-semibold text-charcoal-muted">
                Balance
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-sand-border/70">
            {lines.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-10 text-center text-sm text-charcoal-muted">
                  Nothing on this folio yet. Room nights post automatically at
                  night audit; extras and payments can be added above.
                </td>
              </tr>
            ) : (
              lines.map((line, index) => (
                <LedgerRow
                  key={line.key}
                  line={line}
                  // The running balance is a presentation of the same figures,
                  // accumulated down the page the way a statement reads. The
                  // AUTHORITATIVE closing figure is the engine's, printed in the
                  // footer below — never this column's last value.
                  running={runningBalances[index]}
                  currency={currency}
                />
              ))
            )}
          </tbody>
          <tfoot>
            {/* Column totals, straight from folio_totals — not summed from the
                rows above (rule 9: the engine is the source, the rows are the
                presentation). */}
            <tr className="border-t border-sand-border bg-sand/30">
              <th scope="row" colSpan={2} className="px-4 py-2.5 text-left text-sm font-semibold text-charcoal">
                Totals
              </th>
              <td className="whitespace-nowrap px-4 py-2.5 text-right text-sm font-bold tabular-nums text-charcoal">
                {formatMoney(totals?.charges_total, currency)}
              </td>
              <td className="whitespace-nowrap px-4 py-2.5 text-right text-sm font-bold tabular-nums text-charcoal">
                {formatMoney(totals?.payments_total, currency)}
              </td>
              <td className="px-4 py-2.5" />
            </tr>
            <BalanceRow balance={totals ? balance : null} currency={currency} colSpan={4} />
          </tfoot>
        </table>
      </div>

      {/* Tax summary — computed, never stored. */}
      {taxesByCode.size > 0 ? (
        <div className="overflow-hidden rounded-2xl border border-sand-border bg-white/60">
          <table className="w-full border-collapse text-sm">
            <caption className="border-b border-sand-border bg-sand/40 px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-charcoal-muted">
              Tax & service charge
            </caption>
            <tbody className="divide-y divide-sand-border/70">
              {[...taxesByCode.entries()].map(([code, tax]) => (
                <tr key={code}>
                  <th scope="row" className="px-4 py-2.5 text-left font-normal text-charcoal">
                    {tax.name}{' '}
                    <span className="text-charcoal-muted">
                      ({formatRatePercent(tax.rate)})
                    </span>
                  </th>
                  <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums text-charcoal">
                    {formatMoney(tax.total, currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="border-t border-sand-border px-4 py-2 text-[11px] text-charcoal-muted">
            Computed live from each charge’s net amount and this property’s active
            taxes — never stored, so a rate change cannot make history disagree
            with itself.
          </p>
        </div>
      ) : null}

      {folio.status !== 'open' ? (
        <p className="text-xs text-charcoal-muted">
          This folio is {folio.status}.{' '}
          {folioClosed
            ? 'A closed folio takes no further charges, payments or voids.'
            : 'A settled folio still accepts payments and refunds, but no new charges.'}
        </p>
      ) : null}
    </div>
  );
}

// --- The statement rows -----------------------------------------------------

// Build the ledger: every charge (its NET in the Charges column) followed by its
// tax lines, plus every payment (in the Payments column), ordered by BUSINESS
// date. Charges sort before payments on the same day, which is how a statement
// reads: what was incurred, then what was paid against it.
function buildLedger({
  charges,
  payments,
  taxesByCharge,
  currency,
  timezone,
  currentUserId,
  canAct,
  folioOpen,
  folioClosed,
  onDiscount,
  onVoidCharge,
  onVoidPayment,
}: {
  charges: FolioChargeWithCategory[];
  payments: FolioPayment[];
  taxesByCharge: Map<string, FolioChargeTaxRow[]>;
  currency: string;
  timezone: string;
  currentUserId: string | null;
  canAct: boolean;
  folioOpen: boolean;
  folioClosed: boolean;
  onDiscount: (charge: FolioChargeWithCategory) => void;
  onVoidCharge: (charge: FolioChargeWithCategory) => void;
  onVoidPayment: (payment: FolioPayment) => void;
}): LedgerLine[] {
  const groups: { date: string; order: number; lines: LedgerLine[] }[] = [];

  charges.forEach((charge, index) => {
    const voided = charge.is_voided === true;
    const discount = parseNumeric(charge.discount_amount) ?? 0;
    const postedDate = isoDateInZone(charge.created_at, timezone);
    const lines: LedgerLine[] = [
      {
        key: `charge-${charge.id}`,
        date: charge.charge_date,
        postedDate: postedDate && postedDate !== charge.charge_date ? postedDate : null,
        detail: (
          <>
            <span className={voided ? 'line-through' : ''}>
              <span className="font-semibold">
                {charge.category?.name ?? MISSING_VALUE}
              </span>
              {charge.description ? ` — ${charge.description}` : ''}
            </span>
            <span className="block text-xs text-charcoal-muted">
              {formatQuantity(charge.quantity)} ×{' '}
              {formatMoney(charge.unit_amount, currency)} ={' '}
              {formatMoney(charge.gross_amount, currency)}
              {/* The discount as its own visible fact, with reason and the name
                  it was approved under — the accountability record the engine
                  exists to create. */}
              {discount > 0 ? (
                <>
                  {' · less '}
                  {formatMoney(discount, currency)} discount
                  {charge.discount_reason ? ` (${charge.discount_reason})` : ''} ·
                  approved by {staffLabel(charge.discount_approved_by, currentUserId)}
                </>
              ) : null}
            </span>
            {voided ? (
              <VoidedNote
                reason={charge.void_reason}
                actor={staffLabel(charge.voided_by, currentUserId)}
              />
            ) : null}
          </>
        ),
        charge: voided ? null : parseNumeric(charge.net_amount),
        payment: null,
        voided,
        sub: false,
        actions:
          canAct && !voided ? (
            <span className="flex flex-wrap justify-end gap-1.5">
              {folioOpen ? (
                <RowAction onClick={() => onDiscount(charge)}>Discount</RowAction>
              ) : null}
              {!folioClosed ? (
                <RowAction onClick={() => onVoidCharge(charge)}>Void</RowAction>
              ) : null}
            </span>
          ) : undefined,
      },
    ];

    // Tax lines belong to their charge and sit under it, indented. A voided
    // charge has none — a void carries no tax.
    for (const tax of taxesByCharge.get(charge.id) ?? []) {
      lines.push({
        key: `tax-${charge.id}-${tax.tax_charge_id}`,
        date: charge.charge_date,
        postedDate: null,
        detail: (
          <span className="text-charcoal-muted">
            {tax.name} ({formatRatePercent(tax.rate)})
          </span>
        ),
        charge: parseNumeric(tax.amount),
        payment: null,
        voided: false,
        sub: true,
      });
    }

    groups.push({ date: charge.charge_date, order: index, lines });
  });

  payments.forEach((payment, index) => {
    const voided = payment.is_voided === true;
    const amount = parseNumeric(payment.amount) ?? 0;
    const postedDate = isoDateInZone(payment.created_at, timezone);
    groups.push({
      date: payment.payment_date,
      // +1_000_000 keeps every payment after every charge on the same date while
      // preserving each list's own order.
      order: 1_000_000 + index,
      lines: [
        {
          key: `payment-${payment.id}`,
          date: payment.payment_date,
          postedDate:
            postedDate && postedDate !== payment.payment_date ? postedDate : null,
          detail: (
            <>
              <span className={voided ? 'line-through' : ''}>
                <span className="font-semibold">
                  {paymentMethodLabel(payment.method)}
                </span>
                {amount < 0 ? ' — refund' : ''}
                {payment.reference ? ` · ref ${payment.reference}` : ''}
              </span>
              <span className="block text-xs text-charcoal-muted">
                received by {staffLabel(payment.received_by, currentUserId)}
              </span>
              {voided ? (
                <VoidedNote
                  reason={payment.void_reason}
                  actor={staffLabel(payment.voided_by, currentUserId)}
                />
              ) : null}
            </>
          ),
          charge: null,
          payment: voided ? null : amount,
          voided,
          sub: false,
          actions:
            canAct && !voided && !folioClosed ? (
              <span className="flex justify-end">
                <RowAction onClick={() => onVoidPayment(payment)}>Void</RowAction>
              </span>
            ) : undefined,
        },
      ],
    });
  });

  return groups
    .sort((a, b) => (a.date === b.date ? a.order - b.order : a.date < b.date ? -1 : 1))
    .flatMap((g) => g.lines);
}

// The running balance beside each row: charges so far less payments so far, in
// one pass. Presentation only — the closing figure printed in the footer is the
// engine's folio_totals.balance, never this column's last value.
function runningBalanceSeries(lines: LedgerLine[]): number[] {
  let running = 0;
  return lines.map((line) => {
    running += line.charge ?? 0;
    running -= line.payment ?? 0;
    return running;
  });
}

function LedgerRow({
  line,
  running,
  currency,
}: {
  line: LedgerLine;
  running: number;
  currency: string;
}) {
  return (
    <tr className={line.voided ? 'bg-sand/20' : undefined}>
      <td className="whitespace-nowrap px-4 py-2.5 align-top text-charcoal-muted">
        {line.sub ? '' : formatDisplayDate(line.date)}
        {line.postedDate ? (
          <span className="block text-[11px]">
            posted {formatDisplayDate(line.postedDate)}
          </span>
        ) : null}
      </td>
      <td className={`px-4 py-2.5 align-top text-charcoal ${line.sub ? 'pl-8' : ''}`}>
        {line.detail}
        {line.actions ? <div className="mt-1.5">{line.actions}</div> : null}
      </td>
      <td className="whitespace-nowrap px-4 py-2.5 text-right align-top tabular-nums text-charcoal">
        {line.charge === null ? MISSING_VALUE : formatMoney(line.charge, currency)}
      </td>
      <td className="whitespace-nowrap px-4 py-2.5 text-right align-top tabular-nums text-charcoal">
        {line.payment === null ? MISSING_VALUE : formatMoney(line.payment, currency)}
      </td>
      <td className="whitespace-nowrap px-4 py-2.5 text-right align-top tabular-nums text-charcoal-muted">
        {formatMoney(running, currency)}
      </td>
    </tr>
  );
}

function SummaryRow({
  label,
  value,
  currency,
  negative = false,
  strong = false,
}: {
  label: string;
  value: string | null | undefined;
  currency: string;
  // Discounts and payments REDUCE what is owed; a leading minus makes the column
  // read as the subtraction it is.
  negative?: boolean;
  strong?: boolean;
}) {
  const amount = parseNumeric(value);
  const text =
    amount === null
      ? MISSING_VALUE
      : `${negative && amount !== 0 ? '−' : ''}${formatMoney(Math.abs(amount), currency)}`;

  return (
    <tr>
      <th
        scope="row"
        className={`px-4 py-2 text-left ${
          strong ? 'font-semibold text-charcoal' : 'font-normal text-charcoal-muted'
        }`}
      >
        {label}
      </th>
      <td
        className={`whitespace-nowrap px-4 py-2 text-right tabular-nums text-charcoal ${
          strong ? 'font-semibold' : ''
        }`}
      >
        {text}
      </td>
    </tr>
  );
}

// THE BALANCE LINE, AND THE COLOUR RULE — stated once, used everywhere:
//
//   balance >  0  → text-negative (red).   The guest OWES money.
//   balance <= 0  → text-positive (green). Nothing is owed: either the account is
//                   exactly settled, or the hotel is holding the guest's money
//                   (a deposit or over-payment), which is not a debt to chase.
//
// Both tones are theme tokens (--brand-positive / --brand-negative), never a hex
// literal in a component (rule 17), and both carry their measured AA contrast on
// every surface at their definition in index.css (§8).
//
// The label is exactly "Outstanding Balance" with the amount and nothing else: a
// zero outstanding balance is self-evidently settled, and appending the word
// would be telling the reader what the number already says.
function BalanceRow({
  balance,
  currency,
  colSpan,
}: {
  balance: number | null;
  currency: string;
  colSpan: number;
}) {
  const owed = balance !== null && balance > 0;

  return (
    <tr className="border-t-2 border-sand-border bg-sand/40">
      <th
        scope="row"
        colSpan={colSpan}
        className="px-4 py-3 text-left text-sm font-bold text-charcoal"
      >
        Outstanding Balance
      </th>
      <td
        className={`whitespace-nowrap px-4 py-3 text-right text-base font-bold tabular-nums ${
          owed ? 'text-negative' : 'text-positive'
        }`}
      >
        {balance === null ? MISSING_VALUE : formatMoney(balance, currency)}
      </td>
    </tr>
  );
}

function VoidedNote({
  reason,
  actor,
}: {
  reason: string | null;
  actor: string;
}) {
  return (
    <span className="mt-1 inline-flex flex-wrap items-center gap-1.5 rounded-full bg-charcoal/10 px-2 py-0.5 text-[11px] font-semibold text-charcoal">
      Voided
      <span className="font-normal">
        {reason ? `· ${reason}` : ''} · by {actor} · excluded from totals
      </span>
    </span>
  );
}

function RowAction({
  onClick,
  children,
}: {
  onClick: () => void;
  children: ReactNode;
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
