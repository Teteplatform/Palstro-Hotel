import { useEffect, useRef, useState, type ReactNode } from 'react';
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
  FolioChargeWithCategory,
  FolioPayment,
} from '../../../types/folio';
import { AddChargeForm } from './AddChargeForm';
import { DiscountForm } from './DiscountForm';
import { TakePaymentForm } from './TakePaymentForm';
import { VoidForm } from './VoidForm';

// THE FOLIO TAB — the guest's account, presented as a BILL.
//
// PRESENTATION ONLY. No RPC, no engine function and no figure changed: every
// authoritative number still comes from folio_totals and the folio_charge_taxes
// view, re-read after every mutation (rule 6 — nothing cached). What changed is
// how it reads.
//
// WHAT THE PREVIOUS LAYOUT GOT WRONG, and what replaced it:
//
//   * a trial-balance grid (Charges | Payments | running Balance) on every line.
//     A running balance beside each row is an accountant's tool; a guest bill has
//     ONE balance and it lives at the foot. The column is gone, and with it the
//     temptation to read a mid-statement figure as "what is owed".
//   * the computation printed inline on the description line
//     ("1 × NGN 130,000 = NGN 130,000"), competing with the description for the
//     same eye. It is now a muted subline, and it is DROPPED ENTIRELY at quantity
//     1, where it says nothing the amount does not already say.
//   * tax interleaved as an indented row under each charge, each with its own
//     running balance. Taxes now appear ONCE, aggregated per tax, in their own
//     section just above the balance — which is where a bill puts them.
//   * Discount / Void buttons sitting inside the rows. They are behind a per-line
//     ⋯ menu now: quiet until reached for, on desktop and on touch.
//   * totals stated twice (an account-summary table AND a statement footer). One
//     statement, one set of totals, one balance.
//
// WHAT DID NOT CHANGE, and must not:
//
//   * VOIDED ROWS ARE STILL SHOWN — struck through and muted, with their reason
//     and who voided them, excluded from every total. A bill that quietly drops a
//     reversed line cannot be audited. Quiet, not hidden.
//   * BUSINESS DATE, NOT CREATION TIME (rules 8, 12): ordered by charge_date /
//     payment_date, with a posting date shown only when it differs.
//   * THE AUTHORITATIVE FIGURES ARE THE ENGINE'S (rule 9). Subtotal, tax, total
//     charges, payments received and the balance are printed from folio_totals /
//     folio_charge_taxes — never summed from the rows on screen. The ONLY figures
//     this file adds up are the per-GROUP subtotals, because the engine has no
//     concept of a group; they sum exactly the same per-line net amounts printed
//     beside them, and they are shown only when there is more than one group.
//
// GROUPS EXIST BEFORE THE MODULES THAT FILL THEM. Charges are grouped Room /
// Extras today; F&B, laundry and minibar all post through the same post_charge
// with their own charge_category, so they land in Extras the day those modules
// ship, with no change here.

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

// One printed line of the bill: a date, a description, an amount, and — quietly —
// the detail and the tools.
interface StatementLine {
  key: string;
  date: string;
  postedDate: string | null;
  // The description that carries the line. Nothing competes with it.
  title: ReactNode;
  // The muted subline: the computation (only when it says something), a discount
  // and who approved it, a void and why. Null when there is nothing to add.
  meta: ReactNode | null;
  // What COUNTS. null on a voided line, so every subtotal here excludes it for
  // exactly the reason the engine does.
  amount: number | null;
  // What PRINTS. A voided line keeps its figure, struck through: "this was billed
  // and then reversed" is a fact of the bill, and a dash would erase it.
  figure: number | null;
  voided: boolean;
  actions: { label: string; onClick: () => void }[];
}

interface StatementGroup {
  key: string;
  label: string;
  lines: StatementLine[];
  // Sum of this group's live line amounts. See the header: the one figure on this
  // screen that is added up here rather than read from the engine, because the
  // engine has no per-group total to give.
  subtotal: number;
}

// The charge_categories.code the room-night poster resolves (021 §9.2 —
// `cc.code = 'room'`). A stable MACHINE KEY defined by the schema, like a booking
// status, not tenant content: the tenant's own display NAME for it is
// category.name and is what actually prints on the line (rule 17).
const ROOM_CATEGORY_CODE = 'room';

const TOTALS_NOTE =
  'Computed live from this folio: the subtotal is every non-voided charge less ' +
  'its discounts; tax is the property’s active taxes and service charges applied ' +
  'to each net line; total charges is subtotal plus tax; payments is every ' +
  'non-voided payment, net of refunds. Outstanding balance is total charges less ' +
  'payments. Voided charges and voided payments are shown but excluded. Nothing ' +
  'is stored or cached — these figures are recalculated on every read.';

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
  const discountTotal = parseNumeric(totals?.discount_total) ?? 0;

  // ONE tax fetch, aggregated per tax code for the taxes section. The per-charge
  // grouping the old layout needed for its indented rows is gone with those rows;
  // the section and the engine's tax_total come from the same numbers either way.
  const taxesByCode = new Map<string, { name: string; rate: string; total: number }>();
  for (const row of chargeTaxes) {
    const amount = parseNumeric(row.amount) ?? 0;
    const bucket = taxesByCode.get(row.code);
    if (bucket) bucket.total += amount;
    else taxesByCode.set(row.code, { name: row.name, rate: row.rate, total: amount });
  }

  const groups = buildChargeGroups({
    charges,
    currency,
    timezone,
    currentUserId,
    canAct: action === null,
    folioOpen,
    folioClosed,
    onDiscount: (charge) => setAction({ kind: 'discount', charge }),
    onVoidCharge: (charge) => setAction({ kind: 'void-charge', charge }),
  });

  const paymentLines = buildPaymentLines({
    payments,
    timezone,
    currentUserId,
    canAct: action === null,
    folioClosed,
    onVoidPayment: (payment) => setAction({ kind: 'void-payment', payment }),
  });

  const isEmpty = groups.length === 0 && paymentLines.length === 0;
  // Group subtotals are noise when there is only one group — they would restate
  // the subtotal line immediately below them, which is exactly the repetition
  // this redesign removes.
  const showGroupSubtotals = groups.length > 1;

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

      {/* ------------------------------------------------------------------ */}
      {/* THE BILL. One card, one balance.                                    */}
      {/*                                                                     */}
      {/* NO min-width and no horizontal scroll. Below `sm` the Date column is  */}
      {/* dropped and each line carries its date in the muted subline instead   */}
      {/* (StatementRow), so at 360px the description keeps a readable width    */}
      {/* and the bill stays a bill on a phone instead of a sideways-scrolling  */}
      {/* grid. Nothing is removed at any width — only moved.                   */}
      {/*                                                                     */}
      {/* overflow is NOT hidden on the wrapper — the per-line ⋯ menu is       */}
      {/* absolutely positioned and would be clipped by it. The caption       */}
      {/* rounds its own top corners so the sand band still follows the card. */}
      {/* ------------------------------------------------------------------ */}
      <div className="rounded-2xl border border-sand-border bg-white/60">
        <table className="w-full border-collapse text-sm">
          <caption className="flex flex-wrap items-center justify-between gap-2 rounded-t-2xl border-b border-sand-border bg-sand/40 px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-charcoal-muted sm:px-4">
            <span>Statement</span>
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

          <thead>
            <tr className="border-b border-sand-border/70 text-left">
              {/* Hidden below `sm`, where the date moves into each line's subline
                  (see StatementRow) so the description keeps a readable width. */}
              <th
                scope="col"
                className="hidden px-3 py-2 text-xs font-semibold text-charcoal-muted sm:table-cell sm:w-[7rem] sm:px-4"
              >
                Date
              </th>
              <th scope="col" className="px-1 py-2 text-xs font-semibold text-charcoal-muted sm:px-2">
                Description
              </th>
              <th scope="col" className="px-3 py-2 text-right text-xs font-semibold text-charcoal-muted sm:px-4">
                Amount
              </th>
              {/* The actions column has no visible header — a header over a ⋯
                  affordance would be louder than the affordance. */}
              <th scope="col" className="w-8 px-0 py-2">
                <span className="sr-only">Line actions</span>
              </th>
            </tr>
          </thead>

          {isEmpty ? (
            <tbody>
              <tr>
                <td colSpan={4} className="px-4 py-10 text-center text-sm text-charcoal-muted">
                  Nothing on this folio yet. Room nights post automatically at
                  night audit and at checkout; extras and payments can be added
                  above.
                </td>
              </tr>
            </tbody>
          ) : null}

          {/* --- Charges, grouped by kind ---------------------------------- */}
          {groups.map((group) => (
            <tbody key={group.key} className="divide-y divide-sand-border/50">
              <SectionHeading label={group.label} />
              {group.lines.map((line) => (
                <StatementRow key={line.key} line={line} currency={currency} />
              ))}
              {showGroupSubtotals ? (
                <FigureRow
                  label={`${group.label} subtotal`}
                  amount={group.subtotal}
                  currency={currency}
                  muted
                />
              ) : null}
            </tbody>
          ))}

          {/* --- Subtotal, then tax, then the total ------------------------ */}
          {!isEmpty ? (
            <tbody className="divide-y divide-sand-border/50 border-t border-sand-border/70">
              {/* Shown only when something was actually given away: on a bill
                  with no discounts, a "− ₦0.00" line is a question with no
                  answer. Both figures are the engine's. */}
              {discountTotal > 0 ? (
                <>
                  <FigureRow
                    label="Charges before discount"
                    amount={parseNumeric(totals?.gross_total)}
                    currency={currency}
                    muted
                  />
                  <FigureRow
                    label="Discounts"
                    amount={discountTotal}
                    currency={currency}
                    muted
                    signed="minus"
                  />
                </>
              ) : null}
              <FigureRow
                label="Subtotal"
                amount={parseNumeric(totals?.net_total)}
                currency={currency}
              />

              {/* TAX, ONCE. One line per tax the property levies, aggregated
                  across every charge it applied to — never interleaved with the
                  charges themselves. Computed live from folio_charge_taxes, so a
                  rate change cannot make history disagree with itself. */}
              {[...taxesByCode.entries()].map(([code, tax]) => (
                <FigureRow
                  key={code}
                  label={`${tax.name} (${formatRatePercent(tax.rate)})`}
                  amount={tax.total}
                  currency={currency}
                  muted
                />
              ))}

              <FigureRow
                label="Total charges"
                amount={parseNumeric(totals?.charges_total)}
                currency={currency}
                strong
              />
            </tbody>
          ) : null}

          {/* --- Payments, in their own section, never interleaved --------- */}
          {paymentLines.length > 0 ? (
            <tbody className="divide-y divide-sand-border/50 border-t border-sand-border/70">
              <SectionHeading label="Payments" />
              {paymentLines.map((line) => (
                <StatementRow key={line.key} line={line} currency={currency} />
              ))}
              <FigureRow
                label="Payments received"
                amount={parseNumeric(totals?.payments_total)}
                currency={currency}
                signed="minus"
              />
            </tbody>
          ) : null}

          {/* --- THE balance. Once, at the foot. --------------------------- */}
          <tfoot>
            <BalanceRow balance={totals ? balance : null} currency={currency} />
          </tfoot>
        </table>
      </div>

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

// --- Building the lines -----------------------------------------------------

// Charges, grouped by kind and ordered by BUSINESS date within each group.
//
// TWO GROUPS TODAY: room nights, and everything else ("Extras"). The split is on
// charge_categories.code, so the day F&B, laundry and minibar start posting they
// appear in Extras with no change here — which is the point of grouping before
// the modules exist rather than after.
function buildChargeGroups({
  charges,
  currency,
  timezone,
  currentUserId,
  canAct,
  folioOpen,
  folioClosed,
  onDiscount,
  onVoidCharge,
}: {
  charges: FolioChargeWithCategory[];
  currency: string;
  timezone: string;
  currentUserId: string | null;
  canAct: boolean;
  folioOpen: boolean;
  folioClosed: boolean;
  onDiscount: (charge: FolioChargeWithCategory) => void;
  onVoidCharge: (charge: FolioChargeWithCategory) => void;
}): StatementGroup[] {
  const room: StatementLine[] = [];
  const extras: StatementLine[] = [];

  for (const charge of charges) {
    const voided = charge.is_voided === true;
    const quantity = parseNumeric(charge.quantity) ?? 1;
    const discount = parseNumeric(charge.discount_amount) ?? 0;
    const postedDate = isoDateInZone(charge.created_at, timezone);

    // THE COMPUTATION, QUIETENED. At quantity 1 it is dropped outright: "1 ×
    // ₦130,000" restates the amount in the next column and does nothing but
    // compete with the description. Above 1 it earns its place — "3 × ₦12,500" is
    // the only thing that explains the figure.
    const parts: ReactNode[] = [];
    if (quantity > 1) {
      parts.push(
        `${formatQuantity(charge.quantity)} × ${formatMoney(charge.unit_amount, currency)}`,
      );
    }
    // The discount stays visible with its reason and the name it was approved
    // under — that accountability record is the reason the discount feature
    // exists, and it is not clutter.
    if (discount > 0) {
      parts.push(
        `less ${formatMoney(discount, currency)} discount${
          charge.discount_reason ? ` (${charge.discount_reason})` : ''
        } · approved by ${staffLabel(charge.discount_approved_by, currentUserId)}`,
      );
    }
    if (voided) {
      parts.push(
        `Voided${charge.void_reason ? ` · ${charge.void_reason}` : ''} · by ${staffLabel(
          charge.voided_by,
          currentUserId,
        )} · not included`,
      );
    }

    const actions: { label: string; onClick: () => void }[] = [];
    if (canAct && !voided) {
      if (folioOpen) actions.push({ label: 'Discount', onClick: () => onDiscount(charge) });
      if (!folioClosed) actions.push({ label: 'Void', onClick: () => onVoidCharge(charge) });
    }

    const line: StatementLine = {
      key: `charge-${charge.id}`,
      date: charge.charge_date,
      postedDate: postedDate && postedDate !== charge.charge_date ? postedDate : null,
      // "Room — Executive Suite — 1 Aug 2026": the tenant's own category name and
      // the poster's description, nothing invented here (rule 17).
      title: (
        <>
          {charge.category?.name ?? MISSING_VALUE}
          {charge.description ? ` — ${charge.description}` : ''}
        </>
      ),
      meta: parts.length > 0 ? joinMeta(parts) : null,
      amount: voided ? null : parseNumeric(charge.net_amount),
      figure: parseNumeric(charge.net_amount),
      voided,
      actions,
    };

    if (charge.category?.code === ROOM_CATEGORY_CODE) room.push(line);
    else extras.push(line);
  }

  const groups: StatementGroup[] = [];
  if (room.length > 0) {
    groups.push({
      key: 'room',
      label: 'Room charges',
      lines: sortByDate(room),
      subtotal: sumLines(room),
    });
  }
  if (extras.length > 0) {
    groups.push({
      key: 'extras',
      label: 'Extras',
      lines: sortByDate(extras),
      subtotal: sumLines(extras),
    });
  }
  return groups;
}

function buildPaymentLines({
  payments,
  timezone,
  currentUserId,
  canAct,
  folioClosed,
  onVoidPayment,
}: {
  payments: FolioPayment[];
  timezone: string;
  currentUserId: string | null;
  canAct: boolean;
  folioClosed: boolean;
  onVoidPayment: (payment: FolioPayment) => void;
}): StatementLine[] {
  const lines = payments.map((payment) => {
    const voided = payment.is_voided === true;
    const amount = parseNumeric(payment.amount) ?? 0;
    const postedDate = isoDateInZone(payment.created_at, timezone);

    const parts: ReactNode[] = [
      `received by ${staffLabel(payment.received_by, currentUserId)}`,
    ];
    if (voided) {
      parts.push(
        `Voided${payment.void_reason ? ` · ${payment.void_reason}` : ''} · by ${staffLabel(
          payment.voided_by,
          currentUserId,
        )} · not included`,
      );
    }

    return {
      key: `payment-${payment.id}`,
      date: payment.payment_date,
      postedDate:
        postedDate && postedDate !== payment.payment_date ? postedDate : null,
      title: (
        <>
          {paymentMethodLabel(payment.method)}
          {/* A refund is a negative payment (021 DECISION 3) — the sign carries
              it, the word stops it being misread as money in. */}
          {amount < 0 ? ' — refund' : ''}
          {payment.reference ? ` · ref ${payment.reference}` : ''}
        </>
      ),
      meta: joinMeta(parts),
      amount: voided ? null : amount,
      figure: amount,
      voided,
      actions:
        canAct && !voided && !folioClosed
          ? [{ label: 'Void', onClick: () => onVoidPayment(payment) }]
          : [],
    } satisfies StatementLine;
  });

  return sortByDate(lines);
}

// Business date first (rules 8, 12), input order as the stable tiebreak — the
// charges and payments arrive already ordered by the query.
function sortByDate(lines: StatementLine[]): StatementLine[] {
  return lines
    .map((line, index) => ({ line, index }))
    .sort((a, b) =>
      a.line.date === b.line.date
        ? a.index - b.index
        : a.line.date < b.line.date
          ? -1
          : 1,
    )
    .map((entry) => entry.line);
}

// A group subtotal: the sum of the very amounts printed on its lines. Voided
// lines carry null and are therefore excluded, exactly as the engine excludes
// them from folio_totals.
function sumLines(lines: StatementLine[]): number {
  return lines.reduce((sum, line) => sum + (line.amount ?? 0), 0);
}

function joinMeta(parts: ReactNode[]): ReactNode {
  return parts.map((part, index) => (
    <span key={index}>
      {index > 0 ? ' · ' : ''}
      {part}
    </span>
  ));
}

// --- Rows -------------------------------------------------------------------

// A light heading over a group. `sand/20` rather than a rule and a bold label:
// it should separate the sections without competing with the lines inside them.
function SectionHeading({ label }: { label: string }) {
  return (
    <tr className="bg-sand/25">
      <th
        scope="colgroup"
        colSpan={4}
        className="px-3 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wide text-charcoal-muted sm:px-4"
      >
        {label}
      </th>
    </tr>
  );
}

// One printed line: date, description, amount — and the ⋯ menu, which is the only
// interactive thing in the read and is quiet until reached for.
function StatementRow({
  line,
  currency,
}: {
  line: StatementLine;
  currency: string;
}) {
  // THE MOBILE REFLOW. At 360px a Date column would leave the description about
  // twelve characters wide and wrap "Room — Executive Suite — 1 Aug 2026" over
  // four lines. So below `sm` the date column is dropped and the date leads the
  // muted subline instead — the same fact, moved, never removed. Nothing scrolls
  // sideways and the bill still reads top-to-bottom on a phone.
  const dateText = formatDisplayDate(line.date);
  const postedText = line.postedDate
    ? `posted ${formatDisplayDate(line.postedDate)}`
    : null;

  return (
    <tr className="group align-top">
      <td className="hidden whitespace-nowrap px-3 py-2.5 text-xs text-charcoal-muted sm:table-cell sm:px-4 sm:text-sm">
        {dateText}
        {/* Rule 8's separate posting date, shown ONLY when it differs from the
            business date — a back-dated or late-posted line, and nothing else. */}
        {postedText ? <span className="block text-[11px]">{postedText}</span> : null}
      </td>
      <td className="px-1 py-2.5 sm:px-2">
        <span
          className={`block ${
            line.voided ? 'text-charcoal-muted line-through' : 'text-charcoal'
          }`}
        >
          {line.title}
        </span>
        {/* Hidden from `sm` up when there is no meta — otherwise every plain line
            would carry an empty 11px row on desktop, where the date already has
            its own column. */}
        <span
          className={`mt-0.5 block text-[11px] leading-snug text-charcoal-muted ${
            line.meta ? '' : 'sm:hidden'
          }`}
        >
          <span className="sm:hidden">
            {dateText}
            {postedText ? ` (${postedText})` : ''}
            {line.meta ? ' · ' : ''}
          </span>
          {line.meta}
        </span>
      </td>
      <td
        className={`whitespace-nowrap px-3 py-2.5 text-right tabular-nums sm:px-4 ${
          line.voided ? 'text-charcoal-muted line-through' : 'text-charcoal'
        }`}
      >
        {/* line.figure, not line.amount: a voided line prints what it was, struck
            through, while counting nowhere. */}
        {formatMoney(line.figure, currency)}
      </td>
      <td className="relative w-8 px-0 py-2 align-top">
        {line.actions.length > 0 ? <LineActions items={line.actions} /> : null}
      </td>
    </tr>
  );
}

// A figure line: a label and an amount, no date, no actions. Subtotals, taxes,
// total charges and payments received all share it, so they line up in the same
// column as the charges above them.
function FigureRow({
  label,
  amount,
  currency,
  muted = false,
  strong = false,
  signed,
}: {
  label: string;
  amount: number | null;
  currency: string;
  muted?: boolean;
  strong?: boolean;
  // Discounts and payments REDUCE what is owed; a leading minus makes the column
  // read as the subtraction it is.
  signed?: 'minus';
}) {
  const text =
    amount === null
      ? MISSING_VALUE
      : `${signed === 'minus' && amount !== 0 ? '−' : ''}${formatMoney(
          Math.abs(amount),
          currency,
        )}`;

  return (
    <tr>
      {/* A spacer for the date column, which only exists from `sm` up. A colSpan
          would eat the amount column on mobile, where that column is gone. */}
      <td className="hidden sm:table-cell" />
      <th
        scope="row"
        className={`px-3 py-2 text-left sm:px-2 ${
          strong
            ? 'font-semibold text-charcoal'
            : muted
              ? 'font-normal text-charcoal-muted'
              : 'font-medium text-charcoal'
        }`}
      >
        {label}
      </th>
      <td
        className={`whitespace-nowrap px-3 py-2 text-right tabular-nums sm:px-4 ${
          strong ? 'font-semibold text-charcoal' : muted ? 'text-charcoal-muted' : 'text-charcoal'
        }`}
      >
        {text}
      </td>
      <td className="w-8 px-0" />
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
// It appears EXACTLY ONCE on this screen now. The label is "Outstanding Balance"
// with the amount and nothing else: a zero outstanding balance is self-evidently
// settled, and appending the word would tell the reader what the number says.
function BalanceRow({
  balance,
  currency,
}: {
  balance: number | null;
  currency: string;
}) {
  const owed = balance !== null && balance > 0;

  return (
    <tr className="border-t-2 border-sand-border bg-sand/40">
      {/* Date-column spacer, present only from `sm` up — see FigureRow. */}
      <td className="hidden rounded-bl-2xl sm:table-cell" />
      <th
        scope="row"
        className="rounded-bl-2xl px-3 py-3 text-left text-sm font-bold text-charcoal sm:rounded-none sm:px-2"
      >
        Outstanding Balance
      </th>
      <td
        className={`whitespace-nowrap px-3 py-3 text-right text-base font-bold tabular-nums sm:px-4 ${
          owed ? 'text-negative' : 'text-positive'
        }`}
      >
        {balance === null ? MISSING_VALUE : formatMoney(balance, currency)}
      </td>
      <td className="w-8 rounded-br-2xl px-0" />
    </tr>
  );
}

// THE PER-LINE TOOLS, OUT OF THE READ.
//
// Discount and Void used to sit as two pill buttons inside every charge row,
// which put the loudest elements on the page inside the quietest part of the
// bill. They live behind a ⋯ button now:
//
//   * on a pointer device it is faint until the row is hovered or something in it
//     is focused, so a clean statement stays clean;
//   * it never disappears entirely, and it is a real <button> in the tab order,
//     so keyboard and touch users can reach it without hovering anything;
//   * the panel closes on Escape, on an outside pointer press, and on selecting
//     an item — the three ways a person expects a menu to close.
//
// The menu itself carries no rules about WHAT may be done: the caller passes only
// the actions that are currently allowed (the folio's status and the row's voided
// state are decided where the line is built, and re-checked by the RPC anyway).
function LineActions({
  items,
}: {
  items: { label: string; onClick: () => void }[];
}) {
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div ref={wrapper} className="relative flex justify-end">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Line actions"
        onClick={() => setOpen((v) => !v)}
        className={`rounded-full px-1.5 py-0.5 text-base leading-none text-charcoal-muted transition-opacity hover:bg-sand hover:text-charcoal focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream sm:opacity-40 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 ${
          open ? 'sm:opacity-100' : ''
        }`}
      >
        ⋯
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-full z-10 mt-1 min-w-[8rem] overflow-hidden rounded-xl border border-sand-border bg-white shadow-lg"
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                item.onClick();
              }}
              className="block w-full px-3 py-2 text-left text-xs font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:bg-sand focus-visible:outline-none"
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
