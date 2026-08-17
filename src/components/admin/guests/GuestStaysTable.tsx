import { useState } from 'react';
import { KebabIcon } from '../../ui/icons';
import { Popover } from '../../ui/Popover';
import { formatMoney, MISSING_VALUE, parseNumeric } from '../../../lib/format';
import { formatShortDate } from '../../../lib/date';
import { bookingStatusLabel, bookingStatusTone } from '../../../lib/bookingLabels';
import type { GuestStayRow } from '../../../types/guestLedger';

// THE GUEST'S STAYS TABLE (2.txt §2) — one row per booking, newest first.
//
//   [kebab] · Dates · Room · Nights · Status · Charged · Paid · Balance
//
// PRESENTATION ONLY. Every figure is the database's: charges_total,
// payments_total, balance and display_nights all come from the guest_stays view
// (028 §6), which is folio_totals plus a window function plus PART 1's night
// arithmetic. Nothing is summed, allocated, counted or compared here beyond
// deciding which colour a balance takes.
//
// NIGHTS ARE THE ACTUAL NIGHTS (2.txt PART 1). display_nights is the count the
// folio BILLS — check_out minus the date billing runs from — once the guest has
// checked in, and the reserved count only while the stay is still a reservation.
// A stay that reserved three nights and was arrived at on the last day reads 1
// here, and the folio beneath it carries exactly one room charge. When the two
// counts differ the reserved figure survives as a muted "(3 reserved)", because
// that is what a dispute is argued from.
//
// THE KEBAB IS ON THE LEFT, and that is the point of the column: it opens the
// actions for the WHOLE ROW — take a payment against this stay's folio, post a
// charge to it, open its full bill, check the guest out, cancel the booking.
// Leading rather than trailing because it is the row's handle, not an
// afterthought at the end of a line of figures, and because at 360px a trailing
// control competes with the balance for the only column the eye needs.
//
// SETTLEMENT IS NOT A COLUMN ANY MORE. It was, and it was a permanent source of
// "why does this say Settled when there is money in the Balance column?" — the
// FIFO position of one stay is a working, not a fact the desk acts on. The
// working is still in the view (allocated_amount, charges_before,
// settlement_status) and still on the statement, where it belongs. What the desk
// acts on is charged / paid / balance, which is what this table now shows.
//
// RESPONSIVE (360px): NOT a horizontal scroll. Below `sm` the Room, Status,
// Charged and Paid columns fold into sublines under the dates, and only the
// kebab, the dates and the Balance stay as columns. Nothing is dropped — only
// moved — and the kebab stays reachable at every width.

export interface StayAction {
  key: string;
  label: string;
  // Marks an action that moves or reverses money / status, so the menu can set
  // it apart from the routine ones.
  tone?: 'destructive';
  onSelect: () => void;
}

interface GuestStaysTableProps {
  rows: GuestStayRow[];
  currency: string;
  loading: boolean;
  // The actions offered for one stay. Built by the caller, which knows the
  // booking's status — and every one of them is re-checked by its RPC anyway,
  // so this decides what to OFFER, never what is allowed (rule 19).
  actionsFor: (row: GuestStayRow) => StayAction[];
  // Called when a row's action menu is opened. The caller uses it to prime
  // anything an action will need (the statement export loads its document here),
  // so the click that follows spends no time on a read.
  onActionsOpen?: (row: GuestStayRow) => void;
  // Opens that stay's full detailed bill.
  onOpenStay: (bookingId: string) => void;
}

export function GuestStaysTable({
  rows,
  currency,
  loading,
  actionsFor,
  onActionsOpen,
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
            {/* No visible header over the kebab — a header above a menu
                affordance would be louder than the affordance. */}
            <th scope="col" className="w-9 rounded-tl-2xl px-1 py-2">
              <span className="sr-only">Stay actions</span>
            </th>
            <th
              scope="col"
              className="px-2 py-2 text-xs font-semibold text-charcoal-muted"
            >
              Dates
            </th>
            <th
              scope="col"
              className="hidden px-3 py-2 text-xs font-semibold text-charcoal-muted sm:table-cell"
            >
              Room
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
              className="hidden px-3 py-2 text-right text-xs font-semibold text-charcoal-muted sm:table-cell"
            >
              Charged
            </th>
            <th
              scope="col"
              className="hidden px-3 py-2 text-right text-xs font-semibold text-charcoal-muted sm:table-cell"
            >
              Paid
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
                colSpan={8}
                className="px-4 py-10 text-center text-sm text-charcoal-muted"
                aria-live="polite"
              >
                Loading stays…
              </td>
            </tr>
          ) : rows.length === 0 ? (
            <tr>
              <td
                colSpan={8}
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
                actions={actionsFor(row)}
                onActionsOpen={
                  onActionsOpen ? () => onActionsOpen(row) : undefined
                }
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
  actions,
  onActionsOpen,
  onOpen,
}: {
  row: GuestStayRow;
  currency: string;
  actions: StayAction[];
  onActionsOpen?: () => void;
  onOpen: () => void;
}) {
  const roomType = row.room_type_name ?? MISSING_VALUE;
  const statusLabel = bookingStatusLabel(row.status);

  // PART 1: the number that becomes money. The reserved figure is shown beside
  // it ONLY when the two disagree — printing the same number twice invents a
  // distinction that is not there.
  const nights = row.display_nights;
  const reservedDiffers =
    row.actual_nights !== null && row.actual_nights !== row.reserved_nights;

  // The stay's own window, in the compact form the column has room for. It is
  // the BILLED window once the guest has arrived (charge_from → check_out), so
  // the dates and the night count beside them describe the same thing — a range
  // of three days above a count of one would be a table arguing with itself.
  const from = row.actual_check_in ? row.charge_from : row.check_in;
  const dateRange = `${formatShortDate(from)} → ${formatShortDate(row.check_out)}`;

  return (
    <tr className="group align-top transition-colors hover:bg-sand/40">
      <td className="relative w-9 px-1 py-3 align-top">
        <StayActionsMenu
          actions={actions}
          label={`Actions for ${row.booking_number}`}
          onOpen={onActionsOpen}
        />
      </td>

      {/* The dates cell is the row's click target (it opens the bill), so the
          kebab beside it stays a separate control rather than a nested button
          inside a clickable row. */}
      <td className="px-2 py-3">
        <button
          type="button"
          onClick={onOpen}
          className="block max-w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream"
        >
          <span className="block whitespace-nowrap font-semibold tabular-nums text-charcoal">
            {dateRange}
          </span>
          <span className="block text-xs text-charcoal-muted">
            {row.booking_number}
          </span>
        </button>
        {/* THE MOBILE FOLD. Below `sm` the four middle columns live here, in the
            order the eye wants them: what was booked, how it stands, what it
            came to. Above `sm` this block is hidden — each fact has a column. */}
        <span className="mt-1 block space-y-1 sm:hidden">
          <span className="block text-xs text-charcoal-muted">
            {roomType} · {nights} {nights === 1 ? 'night' : 'nights'}
            {reservedDiffers ? ` (${row.reserved_nights} reserved)` : ''}
          </span>
          <span className="block">
            <span
              className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold ${bookingStatusTone(row.status)}`}
            >
              {statusLabel}
            </span>
          </span>
          <span className="block text-xs text-charcoal-muted">
            Charged {formatMoney(row.charges_total, currency)} · Paid{' '}
            {formatMoney(row.payments_total, currency)}
          </span>
        </span>
      </td>

      <td className="hidden px-3 py-3 text-charcoal sm:table-cell">{roomType}</td>
      <td className="hidden whitespace-nowrap px-3 py-3 text-right tabular-nums text-charcoal sm:table-cell">
        {nights}
        {reservedDiffers ? (
          <span className="ml-1 text-[11px] text-charcoal-muted">
            ({row.reserved_nights} res.)
          </span>
        ) : null}
      </td>
      <td className="hidden px-3 py-3 sm:table-cell">
        <span
          className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ${bookingStatusTone(row.status)}`}
        >
          {statusLabel}
        </span>
      </td>
      <td className="hidden whitespace-nowrap px-3 py-3 text-right tabular-nums text-charcoal sm:table-cell">
        {formatMoney(row.charges_total, currency)}
      </td>
      <td className="hidden whitespace-nowrap px-3 py-3 text-right tabular-nums text-charcoal sm:table-cell">
        {formatMoney(row.payments_total, currency)}
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

// THE PER-STAY MENU. Same interaction contract as the folio bill's line menu, so
// there is one menu behaviour in the admin and not two:
//   * it is a real <button> in the tab order, so keyboard and touch users reach
//     it without hovering anything;
//   * it closes on Escape, on an outside pointer press, and on selecting an
//     item — the three ways a person expects a menu to close;
//   * it carries NO rules about what may be done. The caller passes only the
//     actions currently allowed, and every RPC re-checks anyway.
//
// Unlike the folio's ⋯ this one does NOT fade when unhovered: it is the only way
// to reach checkout and cancellation, and an affordance a receptionist has to
// discover by moving the mouse over a row is one they will not find at 02:00.
function StayActionsMenu({
  actions,
  label,
  onOpen,
}: {
  actions: StayAction[];
  label: string;
  // Fired when the menu is opened, so a caller can start loading anything an
  // action will need — the statement export primes its document here, because
  // reading it inside the click is what costs the user's gesture (and with it
  // the native share sheet).
  onOpen?: () => void;
}) {
  const [open, setOpen] = useState(false);
  // The floating panel goes through the shared Popover, which portals it to
  // document.body. It used to be an absolutely-positioned child of this cell,
  // and the stays table scrolls — so on a narrow window the menu was clipped by
  // its own table exactly as the stock count's was.
  const [trigger, setTrigger] = useState<HTMLButtonElement | null>(null);

  if (actions.length === 0) return null;

  return (
    <div className="print:hidden">
      <button
        ref={setTrigger}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        onClick={() => {
          // Read from state rather than from a setState updater: an updater can
          // be invoked twice in development, and priming twice would double the
          // read.
          const next = !open;
          setOpen(next);
          if (next) onOpen?.();
        }}
        className="inline-flex h-7 w-7 items-center justify-center rounded-full text-charcoal-muted transition-colors hover:bg-sand hover:text-charcoal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream"
      >
        <KebabIcon className="h-4 w-4" />
      </button>
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchor={trigger}
        // Opens to the RIGHT of the kebab, which is the only direction with room
        // when the control sits in the first column at 360px. Popover clamps it
        // to the viewport regardless, so it can no longer run off that edge.
        align="left"
        role="menu"
        ariaLabel={label}
        className="min-w-[11rem]"
      >
        {actions.map((item) => (
          <button
            key={item.key}
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              trigger?.focus({ preventScroll: true });
              item.onSelect();
            }}
            className={`block w-full whitespace-nowrap px-3 py-2 text-left text-xs font-semibold transition-colors hover:bg-sand focus-visible:bg-sand focus-visible:outline-none ${
              item.tone === 'destructive' ? 'text-negative' : 'text-charcoal'
            }`}
          >
            {item.label}
          </button>
        ))}
      </Popover>
    </div>
  );
}
