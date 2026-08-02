import { useCallback, useEffect, useState } from 'react';
import { describeError } from '../../../lib/errors';
import { formatMoney, MISSING_VALUE, parseNumeric } from '../../../lib/format';
import { formatDisplayDate } from '../../../lib/date';
import { formatNights } from '../../../lib/bookingLabels';
import { paymentMethodLabel } from '../../../lib/folioLabels';
import { staffLabel } from '../../../lib/staffLabel';
import { fetchGuestLedger } from '../../../lib/guestLedger';
import { useAuth } from '../../../hooks/useAuth';
import type { GuestLedgerEntry } from '../../../types/guestLedger';

// THE GUEST LEDGER (2.txt §2) — every stay, every standalone charge and every
// payment across all of this guest's folios at this property, as ONE running
// statement. A bank statement: the balance goes UP with a charge-side line and
// DOWN with a payment.
//
// STANDALONE LINES (028 §8) sit in the same statement as their own rows, dated
// by their own business date, because that is what makes the foot balance the
// guest's WHOLE account rather than just the part of it that happened to be
// attached to a stay. They carry the required explanation note as their subline
// and open nothing — there is no stay bill behind them.
//
// SELF-CONTAINED AND EMBEDDABLE, the same way FolioBill is: it takes a guest id
// and loads, renders and reconciles everything itself, so it can sit in a tab, a
// drawer or a print view without changing.
//
// ---------------------------------------------------------------------------
// WHAT IS COMPUTED WHERE — the whole point of this screen
// ---------------------------------------------------------------------------
//   * Each STAY line's Charges figure is that stay's folio_totals.charges_total.
//   * Each PAYMENT line is one folio_payments row, signed.
//   * The RUNNING BALANCE is computed by the DATABASE (guest_ledger, 027 §4) as
//     a window function over the same rows in the same order this table prints
//     them. It is not accumulated in the browser: a second implementation of the
//     ordering or the arithmetic would drift from the first, silently.
//   * The two foot totals are sums of the printed columns — the only arithmetic
//     in this file. They must equal the history strip's "Total charged" and
//     "Total paid", and provably do: both are Σ folio_totals over the same stays.
//   * The OUTSTANDING BALANCE is the LAST row's running_balance, straight from
//     the view. It is not re-derived from the two totals, so the figure the guest
//     is quoted is the database's own.
//
// RECONCILES TO (rule 9): that outstanding balance equals the sum of every
// stay's own folio balance — the Balance column of the stays table beside it.
// FIFO decides which stay a payment settles; it cannot change the total.
//
// A COLLAPSED STAY LINE IS NOT A LOSS OF DETAIL. Clicking any line opens that
// stay's own bill (SN / Date / Type / Description / Amount), which is where the
// per-charge detail, the tax breakdown and the void trail live — and which
// prints on its own. Full page rather than an inline expander, chosen for
// exactly that: an expander prints as a half-open accordion.
//
// VOIDED ROWS ARE ABSENT HERE (027 §4): a voided payment is filtered out and a
// voided charge never reaches charges_total. The reversal audit trail lives on
// the stay's own bill, struck through with its reason and actor. A cross-stay
// statement that stepped up and back down for every reversal would be unreadable
// and would end on exactly the same balance.

interface GuestLedgerProps {
  guestId: string;
  tenantId: string;
  propertyId: string;
  currency: string;
  guestName: string;
  propertyName: string;
  // Opens that stay's full detailed bill (the booking detail page's Folio tab).
  onOpenStay: (bookingId: string) => void;
}

export function GuestLedger({
  guestId,
  tenantId,
  propertyId,
  currency,
  guestName,
  propertyName,
  onOpenStay,
}: GuestLedgerProps) {
  const { user } = useAuth();
  const [entries, setEntries] = useState<GuestLedgerEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const rows = await fetchGuestLedger(guestId, tenantId, propertyId);
        if (cancelled) return;
        setEntries(rows);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        // Rule 11: the raw error is kept and surfaced, never swallowed.
        setError(e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [guestId, tenantId, propertyId, nonce]);

  if (loading && entries.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-charcoal-muted" aria-live="polite">
        Loading statement…
      </p>
    );
  }

  if (error) {
    return (
      <div className="rounded-2xl border border-sand-border bg-white/60 p-4 text-center">
        <p className="text-sm font-medium text-charcoal">
          We couldn’t load this statement.
        </p>
        <p className="mt-1 text-sm text-charcoal-muted">{describeError(error)}</p>
        <button
          type="button"
          onClick={reload}
          className="mt-3 rounded-full border border-sand-border bg-white/70 px-4 py-2 text-xs font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream"
        >
          Try again
        </button>
      </div>
    );
  }

  const currentUserId = user?.id ?? null;

  // The two foot totals: sums of the very figures printed in the two columns
  // above them. Nothing else here adds anything up.
  let totalCharges = 0;
  let totalPayments = 0;
  for (const entry of entries) {
    totalCharges += parseNumeric(entry.charge_amount) ?? 0;
    totalPayments += parseNumeric(entry.payment_amount) ?? 0;
  }

  // The outstanding balance is the LAST line's running balance — the database's
  // own cumulative figure, not totalCharges − totalPayments recomputed here.
  const outstanding =
    entries.length > 0
      ? parseNumeric(entries[entries.length - 1].running_balance)
      : 0;

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold tracking-tight text-charcoal">
            Guest ledger
          </h2>
          {/* Both names come from the database (the guest row and the active
              property), never a literal (rule 17). They also make the PRINTED
              page identify itself, which a bare table would not. */}
          <p className="text-xs text-charcoal-muted">
            {guestName} · {propertyName} · every stay and payment, oldest first
          </p>
        </div>
        <div className="flex items-center gap-2 print:hidden">
          {loading ? (
            <span className="text-xs text-charcoal-muted" aria-live="polite">
              Updating…
            </span>
          ) : null}
          {/* The browser's own print dialog. No PDF library and no second
              renderer: the statement on screen IS the statement that prints, so
              the two can never disagree. The admin chrome and every control are
              print:hidden, so the page prints as the statement alone. */}
          <button
            type="button"
            onClick={() => window.print()}
            className="rounded-full border border-sand-border bg-white/70 px-4 py-2 text-xs font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream"
          >
            Print statement
          </button>
        </div>
      </header>

      {/* ------------------------------------------------------------------ */}
      {/* NO horizontal scroll at any width. Below `sm` the Date, Charges and  */}
      {/* Payments columns fold into the Detail cell (date on top, the signed  */}
      {/* movement underneath) and only Detail + Balance remain as columns —   */}
      {/* the running balance being the one column a statement cannot lose.    */}
      {/* ------------------------------------------------------------------ */}
      <div className="rounded-2xl border border-sand-border bg-white/60">
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">
            Running statement of every stay and payment for this guest
          </caption>
          <thead>
            <tr className="border-b border-sand-border bg-sand/40 text-left">
              <th
                scope="col"
                className="hidden rounded-tl-2xl px-3 py-2 text-xs font-semibold text-charcoal-muted sm:table-cell sm:w-[7rem] sm:px-4"
              >
                Date
              </th>
              <th
                scope="col"
                className="rounded-tl-2xl px-3 py-2 text-xs font-semibold text-charcoal-muted sm:rounded-none sm:px-2"
              >
                Detail
              </th>
              <th
                scope="col"
                className="hidden px-3 py-2 text-right text-xs font-semibold text-charcoal-muted sm:table-cell"
              >
                Charges
              </th>
              <th
                scope="col"
                className="hidden px-3 py-2 text-right text-xs font-semibold text-charcoal-muted sm:table-cell"
              >
                Payments
              </th>
              <th
                scope="col"
                className="rounded-tr-2xl px-3 py-2 text-right text-xs font-semibold text-charcoal-muted sm:px-4"
              >
                Balance
              </th>
            </tr>
          </thead>

          <tbody className="divide-y divide-sand-border/60">
            {entries.length === 0 ? (
              <tr>
                <td
                  colSpan={5}
                  className="px-4 py-10 text-center text-sm text-charcoal-muted"
                >
                  Nothing on this guest's account yet. Their stays, payments and
                  any standalone charges appear here as soon as the first one is
                  recorded.
                </td>
              </tr>
            ) : (
              entries.map((entry) => (
                <LedgerRow
                  // entry_key is the row's OWN id (booking / charge / payment) —
                  // the same total tiebreak the view's running-balance window
                  // orders by, so it is unique here by construction.
                  key={entry.entry_key}
                  entry={entry}
                  currency={currency}
                  currentUserId={currentUserId}
                  // A standalone line has no stay to open. Passing null rather
                  // than a no-op handler is what lets the row render as plain
                  // text instead of a button that does nothing.
                  onOpen={
                    entry.booking_id
                      ? () => onOpenStay(entry.booking_id as string)
                      : null
                  }
                />
              ))
            )}
          </tbody>

          <tfoot>
            {entries.length > 0 ? (
              <>
                <FootRow
                  label="Total charges"
                  amount={totalCharges}
                  currency={currency}
                />
                <FootRow
                  label="Total payments"
                  amount={totalPayments}
                  currency={currency}
                  signed="minus"
                />
              </>
            ) : null}
            <BalanceRow balance={outstanding} currency={currency} />
          </tfoot>
        </table>
      </div>
    </div>
  );
}

// One statement line, of FOUR kinds (028 §8): a stay collapsed to its charges, a
// STANDALONE charge, a payment on a stay's folio, or a STANDALONE payment. A
// charge-side line pushes the balance up, a payment pulls it down.
//
// A STANDALONE LINE IS MARKED, IN WORDS, and does not open anything: it belongs
// to no stay, so there is no bill to drill into, and a row that looked clickable
// and did nothing would be worse than one that plainly is not.
function LedgerRow({
  entry,
  currency,
  currentUserId,
  onOpen,
}: {
  entry: GuestLedgerEntry;
  currency: string;
  currentUserId: string | null;
  // null when the line has no stay behind it (both standalone kinds).
  onOpen: (() => void) | null;
}) {
  const isCharge =
    entry.entry_type === 'stay' || entry.entry_type === 'standalone_charge';
  const charge = parseNumeric(entry.charge_amount) ?? 0;
  const payment = parseNumeric(entry.payment_amount) ?? 0;
  const dateText = formatDisplayDate(entry.entry_date);

  // "Stay · Executive Suite · 1 night" — the room type is the tenant's own name
  // for it (rule 17), and a retired type still names its stay. The night count is
  // display_nights: the ACTUAL nights the folio billed once the guest arrived
  // (2.txt PART 1), so this line and the bill it collapses agree.
  let detail: string;
  if (entry.entry_type === 'stay') {
    detail = [
      'Stay',
      entry.room_type_name ?? MISSING_VALUE,
      entry.display_nights === null ? null : formatNights(entry.display_nights),
    ]
      .filter(Boolean)
      .join(' · ');
  } else if (entry.entry_type === 'standalone_charge') {
    detail = [
      'Charge',
      entry.charge_type_name ?? MISSING_VALUE,
      '(standalone)',
    ].join(' · ');
  } else {
    detail = [
      paymentMethodLabel(entry.payment_method ?? 'other'),
      // A refund is a negative payment (021 DECISION 3): the sign carries it,
      // the word stops it being misread as money in.
      payment < 0 ? 'refund' : null,
      entry.is_standalone ? '(standalone)' : null,
      entry.payment_reference ? `ref ${entry.payment_reference}` : null,
    ]
      .filter(Boolean)
      .join(' · ');
  }

  // The subline: which stay it belongs to, or — for a standalone item — the
  // required explanation note the desk typed when posting it, which is the whole
  // reason that note is mandatory.
  let meta: string;
  if (entry.entry_type === 'stay') {
    meta = entry.booking_number ?? MISSING_VALUE;
  } else if (entry.entry_type === 'standalone_charge') {
    meta = entry.charge_description?.trim() || 'Not tied to a stay';
  } else {
    meta = [
      entry.booking_number ?? 'Not tied to a stay',
      `received by ${staffLabel(entry.received_by, currentUserId)}`,
    ].join(' · ');
  }

  const clickable = onOpen !== null;

  return (
    <tr
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={onOpen ?? undefined}
      onKeyDown={
        clickable
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onOpen?.();
              }
            }
          : undefined
      }
      className={`group align-top transition-colors ${
        clickable
          ? 'cursor-pointer hover:bg-sand/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary'
          : ''
      }`}
    >
      <td className="hidden whitespace-nowrap px-3 py-3 text-charcoal-muted sm:table-cell sm:px-4">
        {dateText}
      </td>
      <td className="px-3 py-3 sm:px-2">
        <span className="block font-medium text-charcoal">{detail}</span>
        <span className="block text-xs text-charcoal-muted">{meta}</span>
        {/* THE MOBILE FOLD: the date and the movement, which have their own
            columns from `sm` up. */}
        <span className="mt-0.5 block text-xs text-charcoal-muted sm:hidden">
          {dateText} ·{' '}
          {isCharge
            ? formatMoney(charge, currency)
            : `− ${formatMoney(Math.abs(payment), currency)}`}
        </span>
      </td>
      <td className="hidden whitespace-nowrap px-3 py-3 text-right tabular-nums text-charcoal sm:table-cell">
        {isCharge ? formatMoney(charge, currency) : ''}
      </td>
      <td className="hidden whitespace-nowrap px-3 py-3 text-right tabular-nums text-charcoal sm:table-cell">
        {isCharge ? '' : formatMoney(payment, currency)}
      </td>
      <td className="whitespace-nowrap px-3 py-3 text-right font-semibold tabular-nums text-charcoal sm:px-4">
        {/* The database's cumulative figure, printed. */}
        {formatMoney(entry.running_balance, currency)}
      </td>
    </tr>
  );
}

// A foot total: a label under the Detail column and a figure under Balance's
// neighbours. The spacer cells exist rather than a colSpan so the amount stays
// in its own column on mobile, where three of the five columns are hidden.
function FootRow({
  label,
  amount,
  currency,
  signed,
}: {
  label: string;
  amount: number;
  currency: string;
  signed?: 'minus';
}) {
  return (
    <tr className="border-t border-sand-border/70">
      <td className="hidden sm:table-cell" />
      <th
        scope="row"
        className="px-3 py-2 text-left font-medium text-charcoal sm:px-2"
      >
        {label}
      </th>
      <td className="hidden sm:table-cell" />
      <td className="hidden sm:table-cell" />
      <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-charcoal sm:px-4">
        {signed === 'minus' && amount !== 0
          ? `−${formatMoney(Math.abs(amount), currency)}`
          : formatMoney(amount, currency)}
      </td>
    </tr>
  );
}

// THE ONE BALANCE, at the foot, under the SAME colour rule as the folio's
// Outstanding Balance and the bookings list (stated there in full):
//   > 0   text-negative (red) — the guest owes money.
//   <= 0  text-positive (green) — nothing owed: settled exactly, or the hotel is
//         holding the guest's money (a deposit or over-payment).
// Both tones are theme tokens (rule 17), contrast-proven at their definition.
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
      <td className="hidden rounded-bl-2xl sm:table-cell" />
      <th
        scope="row"
        className="rounded-bl-2xl px-3 py-3 text-left text-sm font-bold text-charcoal sm:rounded-none sm:px-2"
      >
        Outstanding Balance
      </th>
      <td className="hidden sm:table-cell" />
      <td className="hidden sm:table-cell" />
      <td
        className={`whitespace-nowrap rounded-br-2xl px-3 py-3 text-right text-base font-bold tabular-nums sm:px-4 ${
          owed ? 'text-negative' : 'text-positive'
        }`}
      >
        {balance === null ? MISSING_VALUE : formatMoney(balance, currency)}
      </td>
    </tr>
  );
}
