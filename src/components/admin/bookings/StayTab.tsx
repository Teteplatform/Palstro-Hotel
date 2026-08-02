import { useState } from 'react';
import { DetailTable, DetailRow } from '../../ui/DetailTable';
import { DateField, TextArea, TimeField } from '../../ui/form';
import { useToast } from '../../ui/Toast';
import { humanizeError } from '../../../lib/errors';
import {
  formatCurrency,
  formatMoney,
  formatOccupancy,
  MISSING_VALUE,
} from '../../../lib/format';
import {
  formatDisplayDate,
  formatDisplayDateTimeInZone,
  formatDisplayTime,
  nowTimeInZone,
  todayIsoInZone,
  zonedDateTimeToIso,
} from '../../../lib/date';
import { describeStayNights } from '../../../lib/stayNights';
import {
  bookingTotal,
  cancelBooking,
  checkInBooking,
  checkOutBooking,
  markNoShow,
  type CheckOutSummary,
} from '../../../lib/bookings';
import { rateSourceLabel } from '../../../lib/bookingLabels';
import type { BookingDetail } from '../../../types/booking';

// The Stay tab (build A §2): what was reserved, what was agreed, and the
// lifecycle actions — which live HERE because checking in, checking out, marking
// a no-show and cancelling are all facts about the stay, not about the guest or
// the money.
//
// Every action goes through an RPC, never a direct update: bookings has no update
// RLS policy, and each transition touches other subsystems. Every call is awaited
// in try/catch and its failure surfaced (rule 11). No browser storage anywhere.
//
// FACTS IN TABLES, NO PARAGRAPHS (build 2 §3). This tab used to explain each
// figure in a sentence beneath it — "the folio bills 1 night, charged from…",
// "arrived 2 nights after the reserved check-in…". A front desk reads a screen in
// two seconds between guests, and prose is the thing they skip; worse, a sentence
// beside a number invites the reader to check whether the two agree. So every row
// here is a value or a short label, and nothing is a sentence explaining another
// row. The reasoning that used to sit on the screen lives in these comments,
// which is where reasoning belongs.
//
// RESERVED vs ACTUAL (migration 024). bookings.check_in is what was BOOKED;
// bookings.actual_check_in is when the guest PHYSICALLY ARRIVED, and it is what
// the night audit charges from. The tab shows the ACTUAL night count — the one
// that becomes money — with the reserved figure kept only as a muted "(reserved
// 3)" beside it, because that is what a dispute is argued from. The arithmetic is
// describeStayNights (lib/stayNights.ts), which transcribes run_night_audit's
// date predicate so the screen and the audit can never disagree.
//
// EXPECTED ARRIVAL TIME (025) is a note from the booking ("arriving ~22:00") so
// the desk expects a late guest instead of chasing one. It drives nothing: not
// charging, not availability, not the no-show guard.
//
// THE RATE BREAKDOWN LISTS BILLABLE NIGHTS ONLY — from the actual arrival to
// check-out. A late arrival's reserved-but-never-slept nights are not shown and
// not totalled, because listing a night that will never be charged, under a total
// that does not include it, is a table that does not add up. Rates are the LOCKED
// booking_nights, never re-derived from today's rate tables. This total is not
// the folio balance: the Folio tab answers "what is owed".
//
// CHECKOUT COMPLETES THE BILL (migration 026). check_out_booking posts every
// unbilled room night before it changes the status, so a 02:00 departure — hours
// before the night audit runs — leaves with a settleable folio. What this screen
// adds is the human half of that: the desk is asked to confirm there are no
// unposted extras BEFORE the checkout, because an F&B chit that misses the folio
// cannot be added after the guest has gone.

interface StayTabProps {
  detail: BookingDetail;
  currency: string;
  // The PROPERTY's IANA timezone. Load-bearing, not cosmetic: the arrival the
  // desk types is a wall-clock reading in the HOTEL's timezone, and the server
  // derives the billing business date from that same zone. Sending an instant
  // built in the browser's zone would file a late-evening arrival against the
  // wrong operating day.
  timezone: string;
  onChanged: () => Promise<void> | void;
  // Bring the folio into view. The booking page has no tabs any more (2.txt §2),
  // so this is now a scroll to the bill further down the SAME page rather than a
  // tab switch — but it stays a callback because where the bill is remains the
  // page's business, not this panel's. Optional: this panel must still render
  // wherever it is mounted.
  onGoToFolio?: () => void;
}

// Which confirmation panel is open. One at a time: each is a decision that
// deserves the screen's full attention, and two open panels invite pressing the
// wrong confirm.
type Panel = 'none' | 'checkin' | 'checkout' | 'cancel' | 'noshow';

export function StayTab({
  detail,
  currency,
  timezone,
  onChanged,
  onGoToFolio,
}: StayTabProps) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [panel, setPanel] = useState<Panel>('none');
  const [reason, setReason] = useState('');

  // THE CHECKOUT ACKNOWLEDGEMENT. Deliberately NOT defaulted to true and
  // deliberately not a "don't ask again": the whole point is that a person
  // actively answers "any last orders?" for THIS guest, every time. It resets
  // with the panel.
  const [chargesConfirmed, setChargesConfirmed] = useState(false);

  // What the checkout did to the bill, kept until the user navigates away. Not
  // stored anywhere (no browser storage, constraint) — it is the receipt of an
  // action that just happened, not state the page reloads into.
  const [checkOutSummary, setCheckOutSummary] = useState<CheckOutSummary | null>(
    null,
  );

  // The arrival being recorded. Seeded when the check-in panel opens (see
  // openCheckIn) so it always defaults to NOW in the property's timezone rather
  // than to whenever this component happened to mount.
  const [arrivalDate, setArrivalDate] = useState('');
  const [arrivalTime, setArrivalTime] = useState('');

  // RESERVED vs ACTUAL NIGHTS. describeStayNights transcribes run_night_audit's
  // own date predicate (024 §3), so the count shown here is the count the folio
  // will bill — ACTUAL NIGHTS DRIVE BILLING. A walk-in who reserved the 30th and
  // reached the desk on the 1st pays only for the nights they slept, and this is
  // where the desk sees that before the audit runs. `reserved` is left visible
  // beside it rather than replaced: it is what the guest agreed to and what a
  // dispute is argued from.
  const stay = describeStayNights(detail);
  const status = detail.status;

  // BILLABLE NIGHTS ONLY. The rate table lists the nights the folio will actually
  // charge — [chargeFrom, check_out) — so a late arrival's reserved-but-empty
  // nights are neither listed nor totalled. chargeFrom is describeStayNights'
  // transcription of run_night_audit's start date, so this filter selects exactly
  // the nights check_out_booking and the audit post (dates are 'YYYY-MM-DD', so
  // `>=` is a chronological compare). Before check-in there is no arrival yet and
  // every reserved night is still billable.
  const billableNights = stay.chargeFrom
    ? detail.booking_nights.filter((n) => n.stay_date >= (stay.chargeFrom as string))
    : detail.booking_nights;
  const excludedNights = detail.booking_nights.length - billableNights.length;
  const total = bookingTotal(billableNights);

  // The property's today, used for two things: the arrival date's max (an
  // arrival cannot be in the future) and the no-show test below.
  const propertyToday = todayIsoInZone(timezone);

  // A no-show can only be judged once the reserved arrival DAY IS OVER — a guest
  // has until midnight to walk in, and a 23:00 check-in is ordinary. This mirrors
  // the identical guard inside mark_no_show; the server's copy is the real one
  // (an application check is user experience only, never the sole guard).
  const arrivalDayHasPassed = detail.check_in < propertyToday;
  const canMarkNoShow = status === 'confirmed' && arrivalDayHasPassed;

  // GUARANTEED = a company held the room (either the reservation is against a
  // company account, or the bill was always going to one). Same test as
  // mark_no_show, restated here only to tell the user what will happen — the
  // charge itself is entirely the server's decision.
  const guaranteed = detail.company_id !== null || detail.bill_to === 'company';
  const companyName = detail.company?.name ?? null;

  // What a no-show would cost: ONE night at the locked rate for the RESERVED
  // first night. Read from booking_nights, never recomputed.
  const firstNightRate =
    detail.booking_nights.find((n) => n.stay_date === detail.check_in)?.rate ??
    detail.booking_nights[0]?.rate ??
    null;

  function closePanel() {
    setPanel('none');
    setReason('');
    setChargesConfirmed(false);
  }

  async function runAction(fn: () => Promise<unknown>, successMessage: string) {
    setBusy(true);
    try {
      await fn();
      toast.success(successMessage);
      await onChanged();
      return true;
    } catch (e) {
      // Rule 11: never swallowed — the desk sees why it failed and can act.
      toast.error(humanizeError(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  function openCheckIn() {
    // Default to NOW in the property's timezone, editable. See the panel's own
    // help text for why editable is the requirement, not a convenience.
    setArrivalDate(propertyToday);
    setArrivalTime(nowTimeInZone(timezone));
    setPanel('checkin');
  }

  async function handleCheckIn() {
    if (!arrivalDate || !arrivalTime) {
      toast.error('Enter the date and time the guest arrived.');
      return;
    }
    if (arrivalDate > propertyToday) {
      toast.error('An arrival cannot be in the future.');
      return;
    }
    const arrivalAt = zonedDateTimeToIso(arrivalDate, arrivalTime, timezone);
    if (!arrivalAt) {
      toast.error('That arrival date and time could not be read. Please re-enter it.');
      return;
    }
    const ok = await runAction(
      () => checkInBooking(detail.id, arrivalAt),
      'Guest checked in.',
    );
    if (ok) closePanel();
  }

  // CHECKOUT. Not routed through runAction because the RPC's return value is the
  // point: check_out_booking (026) posts the unbilled room nights in the same
  // transaction as the status change and hands back what it did — nights posted,
  // nights the audit had already posted, and the live balance. That summary is
  // shown to the desk; a bare "Guest checked out." would hide the fact that a
  // balance is still outstanding.
  async function handleCheckOut() {
    if (!chargesConfirmed) {
      toast.error('Confirm that all charges are posted before checking out.');
      return;
    }
    setBusy(true);
    try {
      const result = await checkOutBooking(detail.id);
      setCheckOutSummary(result);
      toast.success('Guest checked out.');
      await onChanged();
      closePanel();
    } catch (e) {
      // Rule 11: the posting failed, the whole checkout rolled back, and the desk
      // is told why rather than being left with a half-finished bill.
      toast.error(humanizeError(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleCancel() {
    if (!reason.trim()) {
      toast.error('Please give a reason for the cancellation.');
      return;
    }
    const ok = await runAction(
      () => cancelBooking(detail.id, reason.trim()),
      'Booking cancelled.',
    );
    if (ok) closePanel();
  }

  async function handleNoShow() {
    const ok = await runAction(
      () => markNoShow(detail.id),
      guaranteed
        ? 'Marked as a no-show. One night has been charged to the folio.'
        : 'Marked as a no-show. No charge applies.',
    );
    if (ok) closePanel();
  }

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-bold tracking-tight text-charcoal">Stay</h2>

      {/* THE CHECKOUT RECEIPT — what the departure did to the bill, and whether
          money is still owed. Shown here, at the top, because at 02:00 the guest
          is still standing there and the next action (settle, or let them go) is
          decided by the balance on this card. */}
      {checkOutSummary ? (
        <CheckOutResult
          summary={checkOutSummary}
          currency={currency}
          onGoToFolio={onGoToFolio}
          onDismiss={() => setCheckOutSummary(null)}
        />
      ) : null}

      <DetailTable caption="Reservation">
        <DetailRow label="Room type">
          {detail.room_type?.name ?? MISSING_VALUE}
        </DetailRow>
        <DetailRow label="Occupancy">
          {formatOccupancy(detail.adults, detail.children)}
        </DetailRow>
        {/* RESERVED — what was booked. Labelled explicitly so the actual arrival
            below can never be mistaken for a correction of it. */}
        <DetailRow label="Check-in (reserved)">
          {formatDisplayDate(detail.check_in)}
        </DetailRow>
        {/* EXPECTED ARRIVAL (025) — a note the guest gave at booking, shown only
            when they gave one. IT CHANGES NOTHING: not the price, not
            availability, not when a no-show may be recorded. mark_no_show
            already waits for the whole reserved arrival DAY to end in the
            property's timezone, so a 22:00 arrival was never at risk of being
            marked a no-show; this row exists so the desk is not surprised by an
            empty room at 20:00 and does not go chasing a guest who is on their
            way. */}
        {detail.expected_arrival_time ? (
          <DetailRow label="Expected arrival">
            <span className="font-semibold text-charcoal">
              ~{formatDisplayTime(detail.expected_arrival_time) || MISSING_VALUE}
            </span>
            <span className="ml-1.5 text-xs text-charcoal-muted">
              (noted at booking)
            </span>
          </DetailRow>
        ) : null}
        {/* ACTUAL — when they turned up, as ONE value: the arrival instant in the
            hotel's clock ("1 Aug 2026, 22:13"). The date used to be printed again
            in front of it, which read as two facts where there is one. The bare
            date is the fallback for a pre-024 stay that has an arrival date but no
            recorded instant. Shown only once there IS an arrival; an empty row
            before check-in would read as missing data. */}
        {detail.actual_check_in ? (
          <DetailRow label="Arrived">
            <span className="font-semibold text-charcoal">
              {(detail.checked_in_at
                ? formatDisplayDateTimeInZone(detail.checked_in_at, timezone)
                : '') ||
                formatDisplayDate(detail.actual_check_in) ||
                MISSING_VALUE}
            </span>
          </DetailRow>
        ) : null}
        <DetailRow label="Check-out">
          {formatDisplayDate(detail.check_out)}
        </DetailRow>
        {/* NIGHTS — THE NUMBER THAT BECOMES MONEY, and nothing else.
            Once an arrival exists this is the ACTUAL count (billing runs from the
            arrival, so a guest who booked 3 and arrived on the last day owes 1);
            before check-in the reserved count is the only figure there is. The
            reserved figure survives as a muted "(reserved 3)" when the two
            disagree — it is what a dispute is argued from — and is omitted when
            they agree, because showing the same number twice invents a
            distinction that is not there. */}
        <DetailRow label="Nights">
          <span className="font-semibold tabular-nums text-charcoal">
            {stay.actual ?? stay.reserved}
          </span>
          {stay.differs ? (
            <span className="ml-1.5 text-xs tabular-nums text-charcoal-muted">
              (reserved {stay.reserved})
            </span>
          ) : null}
        </DetailRow>
        <DetailRow label="Company">
          {companyName ?? <span className="text-charcoal-muted">Walk-in</span>}
        </DetailRow>
        <DetailRow label="Bill to">
          {detail.bill_to === 'company'
            ? `Company${companyName ? ` — ${companyName}` : ''}`
            : 'Guest'}
        </DetailRow>
        {detail.special_requests ? (
          <DetailRow label="Special requests">
            {detail.special_requests}
          </DetailRow>
        ) : null}
        {detail.status === 'cancelled' && detail.cancellation_reason ? (
          <DetailRow label="Cancellation reason">
            {detail.cancellation_reason}
          </DetailRow>
        ) : null}
      </DetailTable>

      {/* THE BILLABLE nights, as a table: each night, why it cost what it did
          (rate_source), and the rate locked at booking. Nights before the actual
          arrival are absent — they will never be charged, and a table that lists
          rows its own total excludes is a table nobody can add up. */}
      <div className="overflow-x-auto rounded-2xl border border-sand-border bg-white/60">
        <table className="w-full min-w-[22rem] border-collapse text-sm">
          <caption className="border-b border-sand-border bg-sand/40 px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-charcoal-muted">
            Locked nightly rates
            {excludedNights > 0 ? (
              // A short label, not an explanation: the count is what stops the
              // shorter list reading as missing data.
              <span className="ml-1.5 font-normal normal-case tracking-normal">
                · billable only ({excludedNights} before arrival excluded)
              </span>
            ) : null}
          </caption>
          <thead>
            <tr className="border-b border-sand-border/70 text-left">
              <th scope="col" className="px-4 py-2 text-xs font-semibold text-charcoal-muted">
                Night
              </th>
              <th scope="col" className="px-4 py-2 text-xs font-semibold text-charcoal-muted">
                Rate basis
              </th>
              <th scope="col" className="px-4 py-2 text-right text-xs font-semibold text-charcoal-muted">
                Rate
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-sand-border/70">
            {/* Empty is reachable: an arrival recorded on or after the check-out
                date leaves no night in [chargeFrom, check_out). A row saying so
                beats a blank table under a zero total. */}
            {billableNights.length === 0 ? (
              <tr>
                <td colSpan={3} className="px-4 py-3 text-charcoal-muted">
                  No billable nights
                </td>
              </tr>
            ) : null}
            {billableNights.map((n) => (
              <tr key={n.stay_date}>
                <td className="whitespace-nowrap px-4 py-2.5 text-charcoal">
                  {formatDisplayDate(n.stay_date)}
                </td>
                <td className="px-4 py-2.5 text-charcoal-muted">
                  {rateSourceLabel(n.rate_source) || MISSING_VALUE}
                </td>
                <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums text-charcoal">
                  {formatCurrency(n.rate, currency)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-sand-border bg-sand/30">
              <th scope="row" colSpan={2} className="px-4 py-2.5 text-left text-sm font-semibold text-charcoal">
                Room total
              </th>
              <td className="whitespace-nowrap px-4 py-2.5 text-right text-sm font-bold tabular-nums text-charcoal">
                {formatCurrency(total, currency)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Lifecycle actions. One panel at a time; the buttons return when it   */}
      {/* closes.                                                             */}
      {/* ------------------------------------------------------------------ */}

      {panel === 'checkin' ? (
        <ActionPanel title="Record the arrival">
          {/* At 360px the two fields stack; from sm they sit side by side. */}
          <div className="grid gap-3 sm:grid-cols-2">
            <DateField
              label="Arrival date"
              required
              value={arrivalDate}
              onChange={setArrivalDate}
              max={propertyToday}
              disabled={busy}
              helpText="The hotel’s local date."
            />
            <TimeField
              label="Arrival time"
              required
              value={arrivalTime}
              onChange={setArrivalTime}
              disabled={busy}
              helpText="The hotel’s local time, 24-hour."
            />
          </div>
          <p className="mt-3 text-xs text-charcoal-muted">
            Defaults to now, but change it if the guest arrived earlier — a
            2 a.m. arrival is routinely keyed in the next morning, and this is
            the date the room nights are charged from. The reserved check-in date
            is left untouched.
          </p>
          {arrivalDate && arrivalDate !== detail.check_in ? (
            <p className="mt-2 text-xs font-medium text-charcoal">
              This differs from the reserved check-in of{' '}
              {formatDisplayDate(detail.check_in)}. Nights will be charged from{' '}
              {formatDisplayDate(
                arrivalDate > detail.check_in ? arrivalDate : detail.check_in,
              )}
              .
            </p>
          ) : null}
          <PanelActions
            busy={busy}
            cancelLabel="Cancel"
            confirmLabel={busy ? 'Checking in…' : 'Confirm check-in'}
            onCancel={closePanel}
            onConfirm={() => void handleCheckIn()}
          />
        </ActionPanel>
      ) : null}

      {panel === 'checkout' ? (
        <ActionPanel title="Check out">
          {/* THE LAST-ORDERS PROMPT. This is a real front-desk habit — "anything
              from the bar this morning?" — and it is a habit because the folio is
              the only place an extra can be recovered from. Once the guest has
              gone, an F&B chit, a laundry ticket or a minibar item that never
              reached the folio is money the hotel simply does not collect.

              WHY IT MOVES: it is competing with muscle memory. The desk has
              pressed this button a hundred times and the last ninety-nine had
              nothing to check. A static red box becomes furniture within a week;
              a slow halo does not. It is the ONLY animation in the admin, spent
              here deliberately — an attention-grab everywhere is an attention-grab
              nowhere.

              REDUCED MOTION: .animate-pulse-alert is switched off entirely by the
              prefers-reduced-motion media query in index.css. Nothing is
              communicated by the movement alone — the callout keeps its red
              border, red tint and red heading, and every word stays. */}
          <div
            role="alert"
            className="animate-pulse-alert rounded-xl border-2 border-negative bg-negative/10 px-4 py-3"
          >
            <p className="text-sm font-bold text-negative">
              Before checking out — confirm all charges are posted.
            </p>
            <p className="mt-1 text-sm text-charcoal">
              Any F&amp;B, laundry, minibar or other extras must be on the folio
              now. They cannot be added after checkout.
            </p>
          </div>

          {/* THE ACKNOWLEDGEMENT. A real gate, not decoration: the confirm button
              is disabled until it is ticked, and handleCheckOut refuses anyway if
              it somehow is not. A native checkbox because it is keyboard- and
              screen-reader-correct for free, and at 360px it stays a comfortable
              target beside wrapping label text. */}
          <label className="mt-3 flex cursor-pointer items-start gap-3 rounded-xl border border-sand-border bg-white/70 px-4 py-3">
            <input
              type="checkbox"
              checked={chargesConfirmed}
              onChange={(e) => setChargesConfirmed(e.target.checked)}
              disabled={busy}
              className="mt-0.5 h-4 w-4 shrink-0 accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream"
            />
            <span className="text-sm font-medium text-charcoal">
              I have checked with the guest and all charges are on the folio.
            </span>
          </label>

          {/* What the checkout will do to the bill, stated before it happens: the
              nights it is about to post are the ones the night audit has not
              reached yet. A count, not a paragraph. */}
          <p className="mt-3 text-xs text-charcoal-muted">
            Room nights are posted automatically at checkout
            {stay.chargeFrom
              ? ` — from ${formatDisplayDate(stay.chargeFrom)} to ${formatDisplayDate(detail.check_out)}.`
              : '.'}
          </p>

          <PanelActions
            busy={busy}
            confirmDisabled={!chargesConfirmed}
            cancelLabel="Not yet"
            confirmLabel={busy ? 'Checking out…' : 'Confirm check-out'}
            onCancel={closePanel}
            onConfirm={() => void handleCheckOut()}
          />
        </ActionPanel>
      ) : null}

      {panel === 'cancel' ? (
        <ActionPanel title="Cancel this booking">
          <TextArea
            label="Reason for cancellation"
            required
            value={reason}
            onChange={setReason}
            rows={2}
            disabled={busy}
            helpText="Recorded on the booking, permanently."
          />
          <PanelActions
            busy={busy}
            cancelLabel="Keep booking"
            confirmLabel={busy ? 'Cancelling…' : 'Confirm cancellation'}
            onCancel={closePanel}
            onConfirm={() => void handleCancel()}
          />
        </ActionPanel>
      ) : null}

      {panel === 'noshow' ? (
        <ActionPanel title="Mark as a no-show">
          <p className="text-sm text-charcoal">
            The guest did not arrive for their reserved check-in on{' '}
            {formatDisplayDate(detail.check_in)}. The room stays held for this
            booking.
          </p>
          {/* THE CONFIRMATION MUST STATE THE MONEY AND WHO PAYS IT. A no-show is
              the one lifecycle action that can post a charge, and a guaranteed
              booking's charge goes to a company that will read it on an invoice.
              Both outcomes are spelled out; neither is left to be discovered. */}
          {guaranteed ? (
            <div className="mt-3 rounded-xl border border-sand-border bg-sand/50 px-4 py-3">
              <p className="text-sm font-semibold text-charcoal">
                One night will be charged
                {firstNightRate
                  ? ` — ${formatCurrency(firstNightRate, currency)}`
                  : ''}
                .
              </p>
              <p className="mt-1 text-xs text-charcoal">
                Billed to{' '}
                <span className="font-semibold">
                  {companyName ?? 'the company account on this booking'}
                </span>
                , at the rate locked for {formatDisplayDate(detail.check_in)}.
                The company held the room, so one night is owed.
              </p>
            </div>
          ) : (
            <div className="mt-3 rounded-xl border border-sand-border bg-sand/50 px-4 py-3">
              <p className="text-sm font-semibold text-charcoal">
                No charge applies.
              </p>
              <p className="mt-1 text-xs text-charcoal">
                This is a walk-in booking with no company guarantee, so nothing
                is posted to the folio.
              </p>
            </div>
          )}
          <PanelActions
            busy={busy}
            cancelLabel="Keep as confirmed"
            confirmLabel={busy ? 'Marking…' : 'Confirm no-show'}
            onCancel={closePanel}
            onConfirm={() => void handleNoShow()}
          />
        </ActionPanel>
      ) : null}

      {panel === 'none' ? (
        <div className="flex flex-wrap items-center gap-2">
          {/* A booking is born confirmed (create_booking), so there is no
              "confirm" action; check-in, no-show and cancel are the ways a live
              reservation can be resolved. */}
          {status === 'confirmed' ? (
            <ActionButton busy={busy} onClick={openCheckIn}>
              Check in
            </ActionButton>
          ) : null}
          {status === 'checked_in' ? (
            // Never a one-press checkout: the reminder panel is the point (§2).
            <ActionButton busy={busy} onClick={() => setPanel('checkout')}>
              Check out
            </ActionButton>
          ) : null}
          {canMarkNoShow ? (
            <SecondaryButton busy={busy} onClick={() => setPanel('noshow')}>
              Mark no-show
            </SecondaryButton>
          ) : null}
          {status === 'confirmed' ? (
            <SecondaryButton busy={busy} onClick={() => setPanel('cancel')}>
              Cancel booking
            </SecondaryButton>
          ) : null}
          {status === 'confirmed' && !arrivalDayHasPassed ? (
            // Why the no-show action is absent, rather than a disabled button
            // with no explanation: the guest can still walk in today.
            <p className="w-full text-xs text-charcoal-muted">
              A no-show can only be recorded once the reserved arrival date has
              passed at the property.
            </p>
          ) : null}
          {status !== 'confirmed' && status !== 'checked_in' ? (
            <p className="text-xs text-charcoal-muted">
              No further stay actions are available for a {status.replace('_', ' ')}{' '}
              booking.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// The shared shell for a confirmation step, so check-in, cancel and no-show all
// look and behave identically rather than three near-copies drifting apart.
function ActionPanel({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-sand-border bg-white/70 p-4">
      <h3 className="text-sm font-semibold text-charcoal">{title}</h3>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function PanelActions({
  busy,
  cancelLabel,
  confirmLabel,
  confirmDisabled = false,
  onCancel,
  onConfirm,
}: {
  busy: boolean;
  cancelLabel: string;
  confirmLabel: string;
  // An unmet precondition inside the panel (the checkout acknowledgement). Kept
  // separate from `busy` so the two reasons a confirm is unavailable stay
  // distinguishable — one clears itself, the other is waiting for the user.
  confirmDisabled?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
      <button
        type="button"
        onClick={onCancel}
        disabled={busy}
        className="rounded-full border border-sand-border bg-white/70 px-4 py-2 text-xs font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:opacity-60"
      >
        {cancelLabel}
      </button>
      <button
        type="button"
        onClick={onConfirm}
        disabled={busy || confirmDisabled}
        className="rounded-full bg-primary px-5 py-2 text-xs font-semibold text-white transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:cursor-not-allowed disabled:opacity-60"
      >
        {confirmLabel}
      </button>
    </div>
  );
}

// THE CHECKOUT SUMMARY (build 2 §2). What check_out_booking actually did, in
// three facts: the nights it posted, the nights that were already there, and what
// is still owed.
//
// EVERY FIGURE IS THE SERVER'S. The counts come from the RPC's summary and the
// balance from folio_totals read inside the same transaction — nothing here adds
// up a number of its own, so the card cannot disagree with the Folio tab (rule 6:
// no cached or client-derived balance).
//
// The settle prompt appears only for a POSITIVE balance. A negative one means the
// hotel owes the guest — a real state, never floored away — and it needs a refund,
// not a payment, so it is labelled rather than turned into a "settle" button.
function CheckOutResult({
  summary,
  currency,
  onGoToFolio,
  onDismiss,
}: {
  summary: CheckOutSummary;
  currency: string;
  onGoToFolio?: () => void;
  onDismiss: () => void;
}) {
  const balance = summary.balance;
  const owes = balance !== null && balance > 0;
  const refundDue = balance !== null && balance < 0;

  return (
    <section
      // role=status, not alert: this reports a completed action rather than
      // demanding one, so a screen reader announces it without interrupting.
      role="status"
      className={`rounded-2xl border px-4 py-3 ${
        owes ? 'border-negative bg-negative/10' : 'border-sand-border bg-white/70'
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 className="text-sm font-bold text-charcoal">
          {summary.alreadyCheckedOut
            ? 'Already checked out'
            : 'Checked out — bill complete'}
        </h3>
        <button
          type="button"
          onClick={onDismiss}
          className="rounded-full px-2 py-0.5 text-xs font-semibold text-charcoal-muted transition-colors hover:text-charcoal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream"
        >
          Dismiss
        </button>
      </div>

      {/* At 360px the three figures stack; from sm they sit in a row. */}
      <dl className="mt-3 grid gap-3 sm:grid-cols-3">
        <div>
          <dt className="text-xs text-charcoal-muted">Nights posted now</dt>
          <dd className="text-sm font-semibold tabular-nums text-charcoal">
            {summary.nightsPosted}
            {summary.amountPosted > 0 ? (
              <span className="ml-1.5 text-xs font-normal text-charcoal-muted">
                {formatMoney(summary.amountPosted, currency)}
              </span>
            ) : null}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-charcoal-muted">Already posted</dt>
          <dd className="text-sm font-semibold tabular-nums text-charcoal">
            {summary.nightsAlreadyPosted}
            {summary.nightsUnbilled > 0 ? (
              // Zero after any successful checkout — the loop posts every night
              // it counts. Only a re-run of an already-departed stay can show a
              // night with no charge at all, and that is worth a number on screen
              // rather than a silent gap in the bill.
              <span className="ml-1.5 text-xs font-normal text-negative">
                ({summary.nightsUnbilled} unbilled)
              </span>
            ) : null}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-charcoal-muted">Balance</dt>
          <dd
            className={`text-sm font-bold tabular-nums ${
              owes ? 'text-negative' : 'text-positive'
            }`}
          >
            {balance === null ? MISSING_VALUE : formatMoney(balance, currency)}
          </dd>
        </div>
      </dl>

      {owes || refundDue ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-charcoal">
            {owes ? 'Settle before the guest leaves.' : 'Refund due to the guest.'}
          </span>
          {onGoToFolio ? (
            <button
              type="button"
              onClick={onGoToFolio}
              className="rounded-full bg-accent px-4 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-cream"
            >
              Open folio
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function ActionButton({
  busy,
  onClick,
  children,
}: {
  busy: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:cursor-not-allowed disabled:opacity-50"
    >
      {busy ? 'Working…' : children}
    </button>
  );
}

function SecondaryButton({
  busy,
  onClick,
  children,
}: {
  busy: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="rounded-full border border-sand-border bg-white/70 px-5 py-2.5 text-sm font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:opacity-60"
    >
      {children}
    </button>
  );
}
