import { formatMoney, MISSING_VALUE, parseNumeric } from '../../../lib/format';
import { formatDisplayDate } from '../../../lib/date';
import { bookingStatusLabel, bookingStatusTone, formatNights } from '../../../lib/bookingLabels';
import {
  settlementStatusLabel,
  settlementStatusTone,
} from '../../../lib/guestLedgerLabels';
import type { GuestStayRow } from '../../../types/guestLedger';

// THE GUEST'S STAYS TABLE (2.txt §2) — one row per booking, newest first.
//
// PRESENTATION ONLY. Every figure is the database's: charges_total, balance and
// the FIFO settlement all come from the guest_stays view (027 §3), which is
// itself folio_totals plus a window function. Nothing is summed, allocated or
// compared here beyond deciding which colour a balance takes.
//
// TWO MONEY COLUMNS THAT MEAN DIFFERENT THINGS, and the reason they both exist:
//
//   BALANCE is this STAY's own folio balance — exactly what the booking's Folio
//   tab shows for it, unchanged by anything on this page.
//
//   SETTLEMENT is the GUEST-level FIFO position: how far the guest's whole
//   payment pool reaches down their stays, oldest first. One payment can settle
//   several stays, so a stay can read "Settled" while its own Balance column
//   still shows money — the money that settled it was taken against a later
//   stay.
//
// They can differ per row and can NEVER differ in total: Σ Balance is the
// guest's outstanding balance whatever the allocation says. The note under the
// table states this in the user's own words rather than leaving them to work it
// out from two disagreeing columns (rule 16).
//
// RESPONSIVE (360px): NOT a horizontal scroll. The bookings list scrolls because
// its header row carries the filters and must stay one table; this table has no
// header filters, so below `sm` the Room type, Nights, Status and Settlement
// columns fold into sublines under the dates and only Dates + Balance stay as
// columns. Nothing is dropped — only moved — and nothing scrolls sideways.

interface GuestStaysTableProps {
  rows: GuestStayRow[];
  currency: string;
  loading: boolean;
  // Opens that stay's full detail page (the existing booking detail route).
  onOpenStay: (bookingId: string) => void;
}

export function GuestStaysTable({
  rows,
  currency,
  loading,
  onOpenStay,
}: GuestStaysTableProps) {
  return (
    <div className="rounded-2xl border border-sand-border bg-white/60">
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">
          Stays for this guest at this property
        </caption>
        <thead>
          <tr className="border-b border-sand-border bg-sand/40 text-left">
            <th
              scope="col"
              className="rounded-tl-2xl px-3 py-2 text-xs font-semibold text-charcoal-muted sm:px-4"
            >
              Dates
            </th>
            <th
              scope="col"
              className="hidden px-3 py-2 text-xs font-semibold text-charcoal-muted sm:table-cell"
            >
              Room type
            </th>
            <th
              scope="col"
              className="hidden px-3 py-2 text-right text-xs font-semibold text-charcoal-muted sm:table-cell"
            >
              Nights
            </th>
            <th
              scope="col"
              className="hidden px-3 py-2 text-xs font-semibold text-charcoal-muted sm:table-cell"
            >
              Status
            </th>
            <th
              scope="col"
              className="hidden px-3 py-2 text-xs font-semibold text-charcoal-muted sm:table-cell"
            >
              Settlement
            </th>
            <th
              scope="col"
              className="hidden px-3 py-2 text-right text-xs font-semibold text-charcoal-muted sm:table-cell"
            >
              Total
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
          {loading && rows.length === 0 ? (
            <tr>
              <td
                colSpan={7}
                className="px-4 py-10 text-center text-sm text-charcoal-muted"
                aria-live="polite"
              >
                Loading stays…
              </td>
            </tr>
          ) : rows.length === 0 ? (
            <tr>
              <td
                colSpan={7}
                className="px-4 py-10 text-center text-sm text-charcoal-muted"
              >
                No stays for this guest at this property yet. A booking made for
                them will appear here with its own folio.
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <StayRow
                key={row.booking_id}
                row={row}
                currency={currency}
                onOpen={() => onOpenStay(row.booking_id)}
              />
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function StayRow({
  row,
  currency,
  onOpen,
}: {
  row: GuestStayRow;
  currency: string;
  onOpen: () => void;
}) {
  const roomType = row.room_type_name ?? MISSING_VALUE;
  const nights = formatNights(row.nights);
  const statusLabel = bookingStatusLabel(row.status);
  const settlement = settlementStatusLabel(row.settlement_status);

  return (
    <tr
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      className="group cursor-pointer align-top transition-colors hover:bg-sand/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
    >
      <td className="px-3 py-3 sm:px-4">
        <span className="block font-semibold text-charcoal">
          {formatDisplayDate(row.check_in)} → {formatDisplayDate(row.check_out)}
        </span>
        <span className="block text-xs text-charcoal-muted">
          {row.booking_number}
        </span>
        {/* THE MOBILE FOLD. Below `sm` the four middle columns live here, in the
            order the eye wants them: what was booked, then how it stands, then
            what it came to. Above `sm` this whole block is hidden because each
            fact has its own column. */}
        <span className="mt-1 block space-y-1 sm:hidden">
          <span className="block text-xs text-charcoal-muted">
            {roomType} · {nights}
          </span>
          <span className="block">
            <span
              className={`mr-1 inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold ${bookingStatusTone(row.status)}`}
            >
              {statusLabel}
            </span>
            <span
              className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold ${settlementStatusTone(row.settlement_status)}`}
            >
              {settlement}
            </span>
          </span>
          <span className="block text-xs text-charcoal-muted">
            Total {formatMoney(row.charges_total, currency)}
          </span>
        </span>
      </td>

      <td className="hidden px-3 py-3 text-charcoal sm:table-cell">{roomType}</td>
      <td className="hidden whitespace-nowrap px-3 py-3 text-right tabular-nums text-charcoal sm:table-cell">
        {row.nights}
      </td>
      <td className="hidden px-3 py-3 sm:table-cell">
        <span
          className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ${bookingStatusTone(row.status)}`}
        >
          {statusLabel}
        </span>
      </td>
      <td className="hidden px-3 py-3 sm:table-cell">
        <span
          className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ${settlementStatusTone(row.settlement_status)}`}
        >
          {settlement}
        </span>
      </td>
      <td className="hidden whitespace-nowrap px-3 py-3 text-right font-semibold tabular-nums text-charcoal sm:table-cell">
        {formatMoney(row.charges_total, currency)}
      </td>
      <BalanceCell balance={row.balance} currency={currency} />
    </tr>
  );
}

// This stay's OWN folio balance, under the SAME colour rule as the folio's
// Outstanding Balance and the bookings list, so no two screens disagree about
// what red means:
//   > 0   text-negative (red) — money is owed on this stay.
//   <= 0  text-positive (green) — nothing owed: settled exactly, or the hotel is
//         holding the guest's money against it.
// Both tones are theme tokens (rule 17), contrast-proven at their definition.
function BalanceCell({
  balance,
  currency,
}: {
  balance: string | null;
  currency: string;
}) {
  const value = parseNumeric(balance);
  const owed = value !== null && value > 0;

  return (
    <td
      className={`whitespace-nowrap px-3 py-3 text-right font-bold tabular-nums sm:px-4 ${
        value === null ? 'text-charcoal-muted' : owed ? 'text-negative' : 'text-positive'
      }`}
    >
      {/* A missing balance reads as the shared dash, never a confident ₦0.00. */}
      {value === null ? MISSING_VALUE : formatMoney(value, currency)}
    </td>
  );
}
