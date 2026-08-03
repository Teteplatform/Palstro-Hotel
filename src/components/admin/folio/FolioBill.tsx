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
  Reversal,
} from '../../../types/folio';
import { AddChargeForm } from './AddChargeForm';
import { DiscountForm } from './DiscountForm';
import {
  ReverseChargeForm,
  type ChargeReversalMode,
} from './ReverseChargeForm';
import { ReversePaymentForm } from './ReversePaymentForm';
import { TakePaymentForm } from './TakePaymentForm';
import { VoidForm } from './VoidForm';
//
// THE DETAILED BILL FOR ONE STAY — a charge TABLE, not a prose statement.
//
// PRESENTATION ONLY. No RPC, no engine function and no figure changed: every
// authoritative number still comes from folio_totals and the folio_charge_taxes
// view, re-read after every mutation (rule 6 — nothing cached).
//
// ---------------------------------------------------------------------------
// EMBEDDABLE BY DESIGN — this is the drill-in target of the coming stays table.
// ---------------------------------------------------------------------------
// A guest has many stays. The GUEST view (next build) will show a table of
// stays — SN, Dates, Nights, Room type, Status, Total, Balance — one row per
// booking, and drilling into a row opens THIS component for that stay. So this
// file is deliberately self-contained: it takes a bookingId (plus the tenant,
// property and the presentation values that are never hardcoded — rule 17) and
// loads, renders and mutates everything itself. It owns no route, reads no
// query param, and assumes nothing about what is above it. Rendering it inside a
// drill-in panel, a second tab, or a print view requires no change here.
//
// On THIS page — the booking detail page — the context is already a single
// booking, so the Folio tab renders this bill directly rather than a one-row
// stays table.
//
// ---------------------------------------------------------------------------
// THE CHARGE TABLE IS THE EXPORT SOURCE OF TRUTH.
// ---------------------------------------------------------------------------
// SN | Date | Type | Description | Amount is exactly a spreadsheet's columns,
// which is why the rows are built as DATA (buildChargeRows / buildPaymentRows
// return plain strings and numbers) and only then rendered. When the export
// build lands, it serialises the very BillRow[] this table prints — one shape,
// one ordering, one set of figures — instead of re-deriving a second version of
// the bill that can silently disagree with the screen. Anything that is NOT a
// column (the quantity computation, the discount trail, the void reason) lives
// in `meta` and stays out of the sheet's five columns by construction.
//
// ---------------------------------------------------------------------------
// WHAT THIS LAYOUT FIXED
// ---------------------------------------------------------------------------
//   * THE CAPTION BUG. The old "Statement / ⓘ How this is calculated" band was a
//     <caption> carrying `display:flex` (Tailwind's `flex`), which takes the
//     element out of the table's box model — it painted over the Date /
//     Description / Amount header row instead of sitting above it. A caption is
//     not a flex container. It is gone: the section title carries the heading,
//     and rule 16's note is a small info affordance beside that title, outside
//     the table entirely, where it cannot collide with a header again.
//   * TYPE IS A COLUMN, NOT PROSE. The charge category used to be glued to the
//     front of the description ("Room — Executive Suite"). It is its own column
//     now, drawn from charge_categories via the row's category embed, so the
//     bill can be scanned down the Type column — Room, Laundry, Food & Beverage,
//     Buffet, Minibar — and sorted or pivoted the moment it reaches a sheet.
//   * ROOM / EXTRAS GROUPING IS GONE, and with it the only client-side
//     arithmetic on this screen. The Type column does what the two group
//     headings did, better (it distinguishes Laundry from Buffet, which "Extras"
//     never could) and without a per-group subtotal this file has to add up.
//
// WHAT DID NOT CHANGE, and must not:
//   * VOIDED ROWS ARE STILL SHOWN — struck through and muted, with their reason
//     and who voided them, excluded from every total. A bill that quietly drops a
//     reversed line cannot be audited. Quiet, not hidden.
//   * BUSINESS DATE, NOT CREATION TIME (rules 8, 12): ordered by charge_date /
//     payment_date, with a posting date shown only when it differs.
//   * THE FIGURES ARE THE ENGINE'S (rule 9). Subtotal, total charges, payments
//     received and the balance are printed from folio_totals; the tax lines are
//     folio_charge_taxes. The ONLY client-side arithmetic left on this screen is
//     grouping those printed per-charge tax amounts by tax code so each tax
//     appears ONCE — a sum of printed numbers whose result is, by the engine's
//     own definition, folio_totals.tax_total.

interface FolioBillProps {
  bookingId: string;
  tenantId: string;
  propertyId: string;
  currency: string;
  timezone: string;
  // Tell whatever is above this bill that its balances have moved (the bookings
  // list's Balance column, the stays table's Total/Balance columns). Neither is
  // cached anywhere; this is a "re-read", not a "patch".
  onFolioChanged: () => void;
}

type ActionState =
  | { kind: 'payment' }
  | { kind: 'charge' }
  | { kind: 'discount'; charge: FolioChargeWithCategory }
  | { kind: 'void-charge'; charge: FolioChargeWithCategory }
  | { kind: 'void-payment'; payment: FolioPayment }
  // REVERSE is a separate action from VOID on purpose (031): a void says the
  // line should never have been recorded; a reversal says it was recorded, was
  // relied upon, and is now being undone by a counter-entry a manager approved.
  | { kind: 'reverse-payment'; payment: FolioPayment }
  // TWO separate charge-side reversals (032), never one action with a mode
  // switch inside it: "Reverse charge" takes the whole line off, "Reverse
  // discount" puts the price back up. They are opened by two differently-named
  // menu items so the choice is made in the menu, where the staff member can
  // still change their mind, rather than inside a dialog they have committed to.
  | { kind: 'reverse-charge'; charge: FolioChargeWithCategory; mode: ChargeReversalMode }
  | null;

// ONE ROW OF THE BILL — and one row of the future export.
//
// `type` and `description` are plain strings, not ReactNode, precisely so this
// array can be handed to a CSV/XLSX writer unchanged. Everything that is
// presentation-only (the muted subline, the ⋯ actions) is kept separate from the
// five columns.
interface BillRow {
  key: string;
  date: string;
  postedDate: string | null;
  // The charge category's own name (rule 17 — the tenant's word, never ours), or
  // the payment method for a payment row.
  type: string;
  // The item detail: "Executive Suite", "Dinner buffet", "ref TRF/8821".
  description: string;
  // The muted subline: the computation (only when it says something), a discount
  // and who approved it, a void and why. Null when there is nothing to add. NOT
  // a column — it never reaches the sheet.
  meta: ReactNode | null;
  // What COUNTS. null on a voided line, so nothing here can ever include it.
  amount: number | null;
  // What PRINTS. A voided line keeps its figure, struck through: "this was billed
  // and then reversed" is a fact of the bill, and a dash would erase it.
  figure: number | null;
  voided: boolean;
  actions: { label: string; onClick: () => void }[];
}

// The number of columns the table declares at its widest, for the rows that span
// it (the section heading and the empty state). SN, Date and Type are hidden
// below `sm` but still exist in the markup, so the span is constant.
const BILL_COLUMNS = 6;

const TOTALS_NOTE =
  'Computed live from this folio: the subtotal is every non-voided charge less ' +
  'its discounts; tax is the property’s active taxes and service charges applied ' +
  'to each net line; total charges is subtotal plus tax; payments is every ' +
  'non-voided payment, net of refunds. Outstanding balance is total charges less ' +
  'payments. Voided charges and voided payments are shown but excluded. A ' +
  'REVERSED line is different: it is still included, because it really happened — ' +
  'its counter-entry is a separate line that takes the same amount back out, so ' +
  'the two net to nothing and both stay visible. A reversed CHARGE nets its ' +
  'discount and its tax out with it; a reversed DISCOUNT puts the charge back to ' +
  'full price and its tax with it. ' +
  'Nothing is stored or cached — these figures are recalculated on every read.';

export function FolioBill({
  bookingId,
  tenantId,
  propertyId,
  currency,
  timezone,
  onFolioChanged,
}: FolioBillProps) {
  const { user } = useAuth();
  const {
    folio,
    charges,
    payments,
    chargeTaxes,
    paymentReversals,
    chargeReversals,
    discountReversals,
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

  // ONE tax fetch, aggregated per tax code so each tax prints ONCE beneath the
  // rows. This is the one place the screen adds anything up, and it adds up the
  // very amounts the database computed per charge (folio_charge_taxes), so the
  // section and folio_totals.tax_total are the same numbers by construction.
  // Sorted by code because the view projects no display_order — an arbitrary row
  // order must not shuffle the printed bill between reads.
  const taxesByCode = new Map<string, { name: string; rate: string; total: number }>();
  for (const row of chargeTaxes) {
    const amount = parseNumeric(row.amount) ?? 0;
    const bucket = taxesByCode.get(row.code);
    if (bucket) bucket.total += amount;
    else taxesByCode.set(row.code, { name: row.name, rate: row.rate, total: amount });
  }
  const taxLines = [...taxesByCode.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  );

  const chargeRows = buildChargeRows({
    charges,
    chargeReversals,
    discountReversals,
    currency,
    timezone,
    currentUserId,
    canAct: action === null,
    folioOpen,
    folioClosed,
    onDiscount: (charge) => setAction({ kind: 'discount', charge }),
    onVoidCharge: (charge) => setAction({ kind: 'void-charge', charge }),
    onReverseCharge: (charge, mode) =>
      setAction({ kind: 'reverse-charge', charge, mode }),
  });

  const paymentRows = buildPaymentRows({
    payments,
    paymentReversals,
    currency,
    timezone,
    currentUserId,
    canAct: action === null,
    folioClosed,
    onVoidPayment: (payment) => setAction({ kind: 'void-payment', payment }),
    onReversePayment: (payment) =>
      setAction({ kind: 'reverse-payment', payment }),
  });

  const isEmpty = chargeRows.length === 0 && paymentRows.length === 0;

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-bold tracking-tight text-charcoal">Folio</h2>
          {/* Rule 16, beside the title and OUTSIDE the table — where the old
              caption band used to break the header row. */}
          <CalculationNote note={TOTALS_NOTE} />
          {loading ? (
            <span className="text-xs text-charcoal-muted" aria-live="polite">
              Updating…
            </span>
          ) : null}
        </div>
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
      {action?.kind === 'reverse-charge' ? (
        <ReverseChargeForm
          mode={action.mode}
          charge={action.charge}
          currency={currency}
          onDone={afterMutation}
          onCancel={() => setAction(null)}
        />
      ) : null}
      {action?.kind === 'reverse-payment' ? (
        <ReversePaymentForm
          payment={action.payment}
          currency={currency}
          onDone={afterMutation}
          onCancel={() => setAction(null)}
        />
      ) : null}

      {/* ------------------------------------------------------------------ */}
      {/* THE CHARGE TABLE. One card, one balance.                            */}
      {/*                                                                     */}
      {/* NO min-width and NO horizontal scroll at any width. Below `sm` the   */}
      {/* SN and Date columns are dropped and Type moves inside the           */}
      {/* description cell as its lead line, with the date leading the muted  */}
      {/* subline (BillTableRow). At 360px that leaves Description + Amount,  */}
      {/* which fits, so the bill reads top-to-bottom on a phone instead of   */}
      {/* scrolling sideways into nothing. Nothing is removed at any width —  */}
      {/* only moved.                                                         */}
      {/*                                                                     */}
      {/* overflow is NOT hidden on the wrapper — the per-line ⋯ menu is       */}
      {/* absolutely positioned and would be clipped by it. The corner cells   */}
      {/* round themselves instead, at both breakpoints, so the card's        */}
      {/* corners follow whichever column is first.                           */}
      {/* ------------------------------------------------------------------ */}
      <div className="rounded-2xl border border-sand-border bg-white/60">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-sand-border bg-sand/40 text-left">
              {/* SN — a printed line number, so a colleague can say "line 4"
                  down a phone. Dropped below `sm`, where the room for it is
                  worth more to the description. */}
              <th
                scope="col"
                className="hidden rounded-tl-2xl px-3 py-2 text-xs font-semibold text-charcoal-muted sm:table-cell sm:w-12 sm:px-4"
              >
                SN
              </th>
              <th
                scope="col"
                className="hidden px-2 py-2 text-xs font-semibold text-charcoal-muted sm:table-cell sm:w-[6.5rem]"
              >
                Date
              </th>
              <th
                scope="col"
                className="hidden px-2 py-2 text-xs font-semibold text-charcoal-muted sm:table-cell sm:w-[9rem]"
              >
                Type
              </th>
              <th
                scope="col"
                className="rounded-tl-2xl px-3 py-2 text-xs font-semibold text-charcoal-muted sm:rounded-none sm:px-2"
              >
                Description
              </th>
              <th
                scope="col"
                className="px-3 py-2 text-right text-xs font-semibold text-charcoal-muted sm:px-4"
              >
                Amount
              </th>
              {/* The actions column has no visible header — a header over a ⋯
                  affordance would be louder than the affordance. */}
              <th scope="col" className="w-8 rounded-tr-2xl px-0 py-2">
                <span className="sr-only">Line actions</span>
              </th>
            </tr>
          </thead>

          {isEmpty ? (
            <tbody>
              <tr>
                <td
                  colSpan={BILL_COLUMNS}
                  className="px-4 py-10 text-center text-sm text-charcoal-muted"
                >
                  Nothing on this folio yet. Room nights post automatically at
                  night audit and at checkout; extras and payments can be added
                  above.
                </td>
              </tr>
            </tbody>
          ) : null}

          {/* --- The charges, in business-date order ----------------------- */}
          {/* No group headings and no date separators: Date and Type are
              columns now, so the eye groups down the column instead of across
              banded rows — and the SN column stays one unbroken sequence, which
              is what makes it quotable and what makes the export a flat sheet.
              The order is the query's (charge_date, then created_at as a stable
              tiebreak — rules 8 and 12), never re-sorted here. */}
          {chargeRows.length > 0 ? (
            <tbody className="divide-y divide-sand-border/50">
              {chargeRows.map((row, index) => (
                <BillTableRow
                  key={row.key}
                  sn={index + 1}
                  row={row}
                  currency={currency}
                />
              ))}
            </tbody>
          ) : null}

          {/* --- Subtotal, then each tax ONCE, then the total -------------- */}
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
              {taxLines.map(([code, tax]) => (
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
          {paymentRows.length > 0 ? (
            <tbody className="divide-y divide-sand-border/50 border-t border-sand-border/70">
              <SectionHeading label="Payments" />
              {paymentRows.map((row, index) => (
                <BillTableRow
                  key={row.key}
                  sn={index + 1}
                  row={row}
                  currency={currency}
                />
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

// --- Building the rows ------------------------------------------------------
//
// These two functions are the export's source data as much as the table's: they
// turn engine rows into the five printed columns and nothing else. Keep them
// returning plain strings and numbers.

// Charges, in the business-date order the query already returned (rule 8:
// charge_date, with created_at only as a stable tiebreak). Nothing is re-sorted
// or re-grouped here — the Type column carries what the old Room/Extras split
// carried, per category rather than per bucket.
//
// CHARGE REVERSALS (032) ARE RENDERED HERE AND NOWHERE ELSE, from the rows
// already in hand. A counter-entry announces itself with reversal_of_charge_id
// and names its act in reversal_target_type, so:
//
//   * the COUNTER-ENTRY reads as "Charge reversal — <reason>" or "Discount
//     reversal — <reason>" (the reason the RPC copied onto its description), and
//     its subline names the line it undoes and the manager who approved it;
//   * the ORIGINAL is marked reversed — NOT struck through, because it is not
//     voided and it still counts: the charge genuinely was billed, and the
//     counter-entry below is what takes it back off;
//   * a charge whose DISCOUNT was reversed keeps its discount trail (what was
//     given away, by whom, why) AND gains a line saying it was put back, by
//     whom, why. Both facts, because both happened;
//   * none of them offers Discount, Void or Reverse any more. Every one of those
//     is refused server-side too (032 §6, §7) — this only keeps the menu honest.
//
// Both lines always stay visible. That is the whole point: a reversal that hid
// either half would be indistinguishable from a charge quietly disappearing.
function buildChargeRows({
  charges,
  chargeReversals,
  discountReversals,
  currency,
  timezone,
  currentUserId,
  canAct,
  folioOpen,
  folioClosed,
  onDiscount,
  onVoidCharge,
  onReverseCharge,
}: {
  charges: FolioChargeWithCategory[];
  // Both keyed by the ORIGINAL charge's id — who approved each reversal and why.
  chargeReversals: Map<string, Reversal>;
  discountReversals: Map<string, Reversal>;
  currency: string;
  timezone: string;
  currentUserId: string | null;
  canAct: boolean;
  folioOpen: boolean;
  folioClosed: boolean;
  onDiscount: (charge: FolioChargeWithCategory) => void;
  onVoidCharge: (charge: FolioChargeWithCategory) => void;
  onReverseCharge: (
    charge: FolioChargeWithCategory,
    mode: ChargeReversalMode,
  ) => void;
}): BillRow[] {
  // Which originals carry a counter-entry, and which original each counter
  // undoes — both derived from the ONE list, because reverse_charge /
  // reverse_discount write the counter-entry and its audit row in a single
  // transaction (032 §3.6), so a counter-entry on this folio IS the proof its
  // original was reversed.
  const byId = new Map(charges.map((c) => [c.id, c] as const));
  const counterByOriginal = new Map<string, FolioChargeWithCategory>();
  for (const c of charges) {
    if (c.reversal_of_charge_id && c.reversal_target_type === 'charge') {
      counterByOriginal.set(c.reversal_of_charge_id, c);
    }
  }
  const discountCounterByOriginal = new Map<string, FolioChargeWithCategory>();
  for (const c of charges) {
    if (c.reversal_of_charge_id && c.reversal_target_type === 'discount') {
      discountCounterByOriginal.set(c.reversal_of_charge_id, c);
    }
  }

  return charges.map((charge) => {
    const voided = charge.is_voided === true;
    const quantity = parseNumeric(charge.quantity) ?? 1;
    const discount = parseNumeric(charge.discount_amount) ?? 0;
    const postedDate = isoDateInZone(charge.created_at, timezone);

    // Which side of a reversal, if any, this line is.
    const isCounterEntry = charge.reversal_of_charge_id !== null;
    const original = isCounterEntry
      ? (byId.get(charge.reversal_of_charge_id as string) ?? null)
      : null;
    const chargeReversal = chargeReversals.get(charge.id) ?? null;
    const discountReversal = discountReversals.get(charge.id) ?? null;
    const wasReversed =
      counterByOriginal.get(charge.id) !== undefined || chargeReversal !== null;
    const discountWasReversed =
      discountCounterByOriginal.get(charge.id) !== undefined ||
      discountReversal !== null;

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
    // exists, and it is not clutter. On a COUNTER-ENTRY the discount is negative
    // (it mirrors the original's), and repeating it as "less −₦20,000 discount"
    // would be noise: the counter's own subline already says what it reverses.
    if (discount > 0) {
      parts.push(
        `less ${formatMoney(discount, currency)} discount${
          charge.discount_reason ? ` (${charge.discount_reason})` : ''
        } · approved by ${staffLabel(charge.discount_approved_by, currentUserId)}`,
      );
    }

    if (isCounterEntry) {
      // The subline of the counter-line: what it undoes, and on whose authority.
      // The approving manager is named from the reversals row keyed by the
      // ORIGINAL's id — that name is the accountability record the subsystem
      // exists to create, so it is never omitted.
      const source = original
        ? charge.reversal_target_type === 'discount'
          ? (discountReversals.get(original.id) ?? null)
          : (chargeReversals.get(original.id) ?? null)
        : null;
      if (original) {
        parts.push(
          charge.reversal_target_type === 'discount'
            ? `restores the ${formatMoney(original.discount_amount, currency)} discount on the ${
                original.category?.name ?? 'charge'
              } of ${formatDisplayDate(original.charge_date)}`
            : `reverses the ${formatMoney(original.net_amount, currency)} ${(
                original.category?.name ?? 'charge'
              ).toLowerCase()} charge of ${formatDisplayDate(original.charge_date)}`,
        );
      } else {
        parts.push('reverses an earlier charge');
      }
      if (source) {
        parts.push(`approved by ${staffLabel(source.approved_by, currentUserId)}`);
      }
    } else {
      // The sublines of the ORIGINAL: what was undone, when, why, by whose
      // authority — and the plain statement that it still counts, because the
      // counter-entry is what moves the money.
      if (wasReversed) {
        parts.push(
          `Reversed${
            chargeReversal ? ` on ${formatDisplayDate(chargeReversal.business_date)}` : ''
          }${chargeReversal?.reason ? ` · ${chargeReversal.reason}` : ''}${
            chargeReversal
              ? ` · approved by ${staffLabel(chargeReversal.approved_by, currentUserId)}`
              : ''
          } · still counted here; the counter-entry takes it back off`,
        );
      }
      if (discountWasReversed) {
        parts.push(
          `Discount reversed${
            discountReversal
              ? ` on ${formatDisplayDate(discountReversal.business_date)}`
              : ''
          }${discountReversal?.reason ? ` · ${discountReversal.reason}` : ''}${
            discountReversal
              ? ` · approved by ${staffLabel(discountReversal.approved_by, currentUserId)}`
              : ''
          } · this line is back at its full amount`,
        );
      }
    }

    if (voided) {
      parts.push(
        `Voided${charge.void_reason ? ` · ${charge.void_reason}` : ''} · by ${staffLabel(
          charge.voided_by,
          currentUserId,
        )} · not included`,
      );
    }

    // WHAT MAY STILL BE DONE TO THIS LINE. Both halves of a completed reversal
    // are closed to further action, and the RPCs enforce every one of these
    // regardless (032 §3, §4, §6, §7).
    //
    // "Reverse discount" appears only on a line that HAS a live discount, and it
    // is named apart from "Reverse charge" so the two undoings are chosen in the
    // menu rather than discovered in a dialog. Both need a manager PIN; neither
    // is reachable once the line has been reversed.
    const actions: { label: string; onClick: () => void }[] = [];
    if (canAct && !voided && !isCounterEntry && !wasReversed) {
      if (folioOpen && !discountWasReversed) {
        actions.push({ label: 'Discount', onClick: () => onDiscount(charge) });
      }
      if (folioOpen) {
        actions.push({
          label: 'Reverse charge',
          onClick: () => onReverseCharge(charge, 'charge'),
        });
      }
      if (folioOpen && discount > 0 && !discountWasReversed) {
        actions.push({
          label: 'Reverse discount',
          onClick: () => onReverseCharge(charge, 'discount'),
        });
      }
      if (!folioClosed) actions.push({ label: 'Void', onClick: () => onVoidCharge(charge) });
    }

    return {
      key: `charge-${charge.id}`,
      date: charge.charge_date,
      postedDate: postedDate && postedDate !== charge.charge_date ? postedDate : null,
      // The TENANT's own name for the category, never a word invented here
      // (rule 17): "Room", "Laundry", "Food & Beverage", "Buffet", "Room tray",
      // "Minibar" are rows in charge_categories, and a retired category still
      // labels the charges posted against it (the embed is not deleted_at
      // filtered — 021 §8.1).
      type: charge.category?.name ?? MISSING_VALUE,
      // The item detail alone: "Executive Suite — 1 Aug 2026", "Dinner buffet".
      // The category no longer prefixes it — that is the Type column's job.
      description: charge.description?.trim() || MISSING_VALUE,
      meta: parts.length > 0 ? joinMeta(parts) : null,
      amount: voided ? null : parseNumeric(charge.net_amount),
      figure: parseNumeric(charge.net_amount),
      voided,
      actions,
    } satisfies BillRow;
  });
}

// Payments, in the business-date order the query returned (rules 8, 12). Same
// five columns as the charges above them, so the section reads as part of the
// same sheet: the METHOD is the type, the reference is the detail.
//
// REVERSALS (031) ARE RENDERED HERE AND NOWHERE ELSE, from the rows already in
// hand. A counter-entry announces itself with reversal_of_payment_id, so:
//
//   * the COUNTER-ENTRY reads as "Payment reversal — <reason>" (the reason the
//     RPC copied onto its reference), not as an unexplained negative "Refund",
//     and its subline names the line it reverses and the manager who approved;
//   * the ORIGINAL is marked as reversed — NOT struck through, because it is not
//     voided and it still counts: the money genuinely was received, and the
//     counter-entry below is what takes it back out;
//   * neither offers Void or Reverse any more. Voiding either one would break
//     the arithmetic, which is why void_payment refuses both server-side too
//     (031 §4) — this only keeps the menu honest.
//
// Both lines always stay visible. That is the whole point: a reversal that
// hid either half would be indistinguishable from money quietly disappearing.
function buildPaymentRows({
  payments,
  paymentReversals,
  currency,
  timezone,
  currentUserId,
  canAct,
  folioClosed,
  onVoidPayment,
  onReversePayment,
}: {
  payments: FolioPayment[];
  // Keyed by the ORIGINAL payment's id — who approved the reversal and why.
  paymentReversals: Map<string, Reversal>;
  currency: string;
  timezone: string;
  currentUserId: string | null;
  canAct: boolean;
  folioClosed: boolean;
  onVoidPayment: (payment: FolioPayment) => void;
  onReversePayment: (payment: FolioPayment) => void;
}): BillRow[] {
  // The originals that have been reversed, and the payment each counter-entry
  // undoes — both derived from the one list, because reverse_payment writes the
  // counter-entry and its audit row in a single transaction (031 §3.4), so a
  // counter-entry on this folio IS the proof its original was reversed.
  const byId = new Map(payments.map((p) => [p.id, p] as const));
  const counterByOriginal = new Map<string, FolioPayment>();
  for (const p of payments) {
    if (p.reversal_of_payment_id) counterByOriginal.set(p.reversal_of_payment_id, p);
  }

  return payments.map((payment) => {
    const voided = payment.is_voided === true;
    const amount = parseNumeric(payment.amount) ?? 0;
    const postedDate = isoDateInZone(payment.created_at, timezone);

    // Which side of a reversal, if any, this line is.
    const isCounterEntry = payment.reversal_of_payment_id !== null;
    const original = isCounterEntry
      ? (byId.get(payment.reversal_of_payment_id as string) ?? null)
      : null;
    const counter = counterByOriginal.get(payment.id) ?? null;
    const reversal = paymentReversals.get(payment.id) ?? null;
    const wasReversed = counter !== null || reversal !== null;

    const parts: ReactNode[] = [
      `received by ${staffLabel(payment.received_by, currentUserId)}`,
    ];

    if (isCounterEntry) {
      // The subline of the counter-line: what it undoes, and on whose authority.
      // The approving manager is named from the reversals row keyed by the
      // ORIGINAL's id — that name is the accountability record the subsystem
      // exists to create, so it is never omitted.
      const source = original
        ? paymentReversals.get(original.id) ?? null
        : null;
      parts.push(
        original
          ? `reverses the ${formatMoney(original.amount, currency)} ${paymentMethodLabel(
              original.method,
            ).toLowerCase()} payment of ${formatDisplayDate(original.payment_date)}`
          : 'reverses an earlier payment',
      );
      if (source) {
        parts.push(`approved by ${staffLabel(source.approved_by, currentUserId)}`);
      }
    } else if (wasReversed) {
      // The subline of the ORIGINAL: reversed, when, why, by whose authority —
      // and the plain statement that it still counts, because the next line is
      // what takes the money back out.
      parts.push(
        `Reversed${
          reversal ? ` on ${formatDisplayDate(reversal.business_date)}` : ''
        }${reversal?.reason ? ` · ${reversal.reason}` : ''}${
          reversal
            ? ` · approved by ${staffLabel(reversal.approved_by, currentUserId)}`
            : ''
        } · still counted here; the counter-entry below returns it`,
      );
    }

    if (voided) {
      parts.push(
        `Voided${payment.void_reason ? ` · ${payment.void_reason}` : ''} · by ${staffLabel(
          payment.voided_by,
          currentUserId,
        )} · not included`,
      );
    }

    // A refund is a negative payment (021 DECISION 3) — the sign carries it, the
    // word stops it being misread as money in. A REVERSAL is also negative but
    // is not a refund, and saying "Refund" over it would misdescribe why the
    // money moved: the reference the RPC wrote already reads "Payment reversal
    // — <reason>", so it stands alone as the description.
    const detail = isCounterEntry
      ? [payment.reference]
      : [
          amount < 0 ? 'Refund' : null,
          payment.reference ? `ref ${payment.reference}` : null,
        ];
    const description = detail.filter(Boolean).join(' · ');

    // WHAT MAY STILL BE DONE TO THIS LINE. Both halves of a completed reversal
    // are closed to further action; the RPCs enforce it regardless (031 §3, §4).
    const actions: { label: string; onClick: () => void }[] = [];
    if (canAct && !voided && !folioClosed && !isCounterEntry && !wasReversed) {
      actions.push({ label: 'Void', onClick: () => onVoidPayment(payment) });
      actions.push({ label: 'Reverse', onClick: () => onReversePayment(payment) });
    }

    return {
      key: `payment-${payment.id}`,
      date: payment.payment_date,
      postedDate:
        postedDate && postedDate !== payment.payment_date ? postedDate : null,
      type: paymentMethodLabel(payment.method),
      description: description || MISSING_VALUE,
      meta: joinMeta(parts),
      amount: voided ? null : amount,
      figure: amount,
      voided,
      actions,
    } satisfies BillRow;
  });
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

// A light heading over a section. `sand/25` rather than a rule and a bold label:
// it should separate the sections without competing with the lines inside them.
function SectionHeading({ label }: { label: string }) {
  return (
    <tr className="bg-sand/25">
      <th
        scope="colgroup"
        colSpan={BILL_COLUMNS}
        className="px-3 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wide text-charcoal-muted sm:px-4"
      >
        {label}
      </th>
    </tr>
  );
}

// One printed line: SN, date, type, description, amount — and the ⋯ menu, which
// is the only interactive thing in the read and is quiet until reached for.
function BillTableRow({
  sn,
  row,
  currency,
}: {
  sn: number;
  row: BillRow;
  currency: string;
}) {
  // THE MOBILE REFLOW. At 360px, five columns would leave the description about
  // eight characters wide and wrap "Executive Suite — 1 Aug 2026" over four
  // lines. So below `sm`: SN goes (a line number is a desktop convenience), Type
  // leads the description cell as a small uppercase label — it is what the eye
  // scans for, so it must survive the phone — and the date leads the muted
  // subline. The same facts, moved, never removed; nothing scrolls sideways.
  const dateText = formatDisplayDate(row.date);
  const postedText = row.postedDate
    ? `posted ${formatDisplayDate(row.postedDate)}`
    : null;
  const struck = row.voided ? 'text-charcoal-muted line-through' : 'text-charcoal';

  return (
    <tr className="group align-top">
      <td className="hidden px-3 py-2.5 text-xs tabular-nums text-charcoal-muted sm:table-cell sm:px-4">
        {sn}
      </td>
      <td className="hidden whitespace-nowrap px-2 py-2.5 text-xs text-charcoal-muted sm:table-cell sm:text-sm">
        {dateText}
        {/* Rule 8's separate posting date, shown ONLY when it differs from the
            business date — a back-dated or late-posted line, and nothing else. */}
        {postedText ? <span className="block text-[11px]">{postedText}</span> : null}
      </td>
      <td className={`hidden px-2 py-2.5 sm:table-cell ${struck}`}>{row.type}</td>
      <td className="px-3 py-2.5 sm:px-2">
        {/* Type, on the phone only — the column it comes from is hidden there. */}
        <span className="mb-0.5 block text-[10px] font-semibold uppercase tracking-wide text-charcoal-muted sm:hidden">
          {row.type}
        </span>
        <span className={`block ${struck}`}>{row.description}</span>
        {/* Hidden from `sm` up when there is no meta — otherwise every plain line
            would carry an empty 11px row on desktop, where the date already has
            its own column. */}
        <span
          className={`mt-0.5 block text-[11px] leading-snug text-charcoal-muted ${
            row.meta ? '' : 'sm:hidden'
          }`}
        >
          <span className="sm:hidden">
            {dateText}
            {postedText ? ` (${postedText})` : ''}
            {row.meta ? ' · ' : ''}
          </span>
          {row.meta}
        </span>
      </td>
      <td
        className={`whitespace-nowrap px-3 py-2.5 text-right tabular-nums sm:px-4 ${struck}`}
      >
        {/* row.figure, not row.amount: a voided line prints what it was, struck
            through, while counting nowhere. */}
        {formatMoney(row.figure, currency)}
      </td>
      <td className="relative w-8 px-0 py-2 align-top">
        {row.actions.length > 0 ? <LineActions items={row.actions} /> : null}
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
      {/* Spacers for the three columns that only exist from `sm` up. A colSpan
          would eat the amount column on mobile, where those columns are gone. */}
      <td className="hidden sm:table-cell" />
      <td className="hidden sm:table-cell" />
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
// It appears EXACTLY ONCE on this screen. The label is "Outstanding Balance"
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
      {/* Column spacers, present only from `sm` up — see FigureRow. The card's
          bottom-left corner is rounded on whichever cell is first at this
          breakpoint. */}
      <td className="hidden rounded-bl-2xl sm:table-cell" />
      <td className="hidden sm:table-cell" />
      <td className="hidden sm:table-cell" />
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

// Rule 16's "how this was calculated", as a small info affordance beside the
// section title.
//
// WHY IT IS NOT A <caption>. It used to be one — a flex band across the top of
// the table carrying the word "Statement" and this note. A <caption> with
// `display:flex` stops participating in the table's box model, and it painted
// straight over the header row. The note does not belong to the table's box at
// all: it explains the FIGURES, so it hangs off the heading, where no amount of
// layout can put it on top of a column header again.
//
// Same affordance as the bookings summary: the full text is the title AND the
// accessible name, so it is reachable by pointer, keyboard and screen reader.
function CalculationNote({ note }: { note: string }) {
  return (
    <span
      className="inline-flex h-5 w-5 cursor-help items-center justify-center rounded-full border border-sand-border bg-white/70 text-[11px] leading-none text-charcoal-muted"
      tabIndex={0}
      role="note"
      aria-label={`How this is calculated: ${note}`}
      title={note}
    >
      <span aria-hidden="true">i</span>
    </span>
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
// state are decided where the row is built, and re-checked by the RPC anyway).
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
