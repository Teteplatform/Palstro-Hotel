import { useCallback, useEffect, useState } from 'react';
import { FactTable, type Fact } from '../../ui/FactTable';
import { DateField, TextArea, TimeField } from '../../ui/form';
import { useToast } from '../../ui/Toast';
import { useAuth } from '../../../hooks/useAuth';
import { describeError, humanizeError } from '../../../lib/errors';
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
  fetchBookingStatusReversals,
  markNoShow,
  type BookingStatusReversals,
  type CheckOutSummary,
} from '../../../lib/bookings';
import {
  rateSourceLabel,
  STAY_ABOUT,
  STAY_ABOUT_TITLE,
} from '../../../lib/bookingLabels';
import { ScreenHeader } from '../../ui/ScreenHeader';
import { staffLabel } from '../../../lib/staffLabel';
import type { BookingDetail } from '../../../types/booking';
import type { Reversal } from '../../../types/folio';
import { ReverseBookingStatusForm } from './ReverseBookingStatusForm';
import { ReverseCheckoutForm } from './ReverseCheckoutForm';

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
  // For the ⓘ's link into this property's copy of the staff guide.
  propertySlug: string;
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
type Panel =
  | 'none'
  | 'checkin'
  | 'checkout'
  | 'cancel'
  | 'noshow'
  // The two REVERSALS (migration 033): un-no-show and un-cancel. Gated to the
  // states they undo, and each re-takes the room, so each is PIN-gated and
  // availability-checked by its RPC.
  | 'reverse-noshow'
  | 'reverse-cancel'
  // The third (migration 034): un-checkout, which REOPENS the stay. Gated to
  // checked_out. PIN-gated like the others, but with no availability check —
  // a checked-out stay never released its room, so nothing is re-taken.
  | 'reverse-checkout';

export function StayTab({
  detail,
  propertySlug,
  currency,
  timezone,
  onChanged,
  onGoToFolio,
}: StayTabProps) {
  const toast = useToast();
  const { user } = useAuth();
  const [busy, setBusy] = useState(false);
  const [panel, setPanel] = useState<Panel>('none');
  const [reason, setReason] = useState('');

  // THE PERMANENT RECORD OF A RESTORE. A booking carries no "was restored"
  // column, deliberately (rule 6 and the reversal subsystem's founding rule): a
  // reversal is a fact about an ACT, and it lives in the reversals table, which
  // no client can write and nothing can edit. So the notice below is READ from
  // there rather than derived from the booking row.
  //
  // Re-read whenever the booking's status changes, which is exactly when one of
  // these can appear (the parent re-fetches the booking after any action, so a
  // new `detail` with a new status arrives here and this effect fires).
  const [statusReversals, setStatusReversals] =
    useState<BookingStatusReversals>({
      noShow: null,
      cancel: null,
      checkout: null,
    });
  const [reversalsError, setReversalsError] = useState<string | null>(null);

  const bookingId = detail.id;
  const tenantId = detail.tenant_id;
  const propertyId = detail.property_id;
  const status = detail.status;

  const loadReversals = useCallback(async () => {
    try {
      setStatusReversals(
        await fetchBookingStatusReversals(bookingId, tenantId, propertyId),
      );
      setReversalsError(null);
    } catch (e) {
      // Rule 11: not swallowed. The stay itself still renders — this read only
      // adds the restore notice — so the failure is reported in place rather
      // than taking the panel down with it.
      setReversalsError(describeError(e));
    }
  }, [bookingId, tenantId, propertyId]);

  useEffect(() => {
    // Wrapped exactly as the booking page's own load is: the read is async, so
    // nothing is set during the effect itself.
    void (async () => {
      await loadReversals();
    })();
    // `status` is a dependency on purpose: a restore changes it, and that is the
    // moment a new reversals row exists to show.
  }, [loadReversals, status]);

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
  //
  // THIS BUTTON SURVIVES migration 029, which made the night audit resolve
  // uncollected bookings automatically. The two are the same act at two different
  // levels of certainty: the audit waits for the whole day and runs once, at the
  // cutoff; this is the desk's same-day "they are definitely not coming" call,
  // made hours earlier by a person who has spoken to the guest. Both go through
  // mark_no_show, so they can never post differently.
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

  // The reservation facts, built as DATA and only then rendered — the same shape
  // the folio bill builds its rows in, and for the same reason: the order and the
  // conditionality live in one readable list rather than being spread through
  // markup.
  function reservationFacts(): Fact[] {
    const facts: Fact[] = [
      { label: 'Room type', value: detail.room_type?.name ?? MISSING_VALUE },
      {
        label: 'Occupancy',
        value: formatOccupancy(detail.adults, detail.children),
      },
      // RESERVED — what was booked. Labelled explicitly so the actual arrival
      // below can never be mistaken for a correction of it.
      {
        label: 'Check-in (reserved)',
        value: formatDisplayDate(detail.check_in) || MISSING_VALUE,
      },
      {
        label: 'Check-out',
        value: formatDisplayDate(detail.check_out) || MISSING_VALUE,
      },
      // NIGHTS — THE NUMBER THAT BECOMES MONEY, and nothing else. Once an arrival
      // exists this is the ACTUAL count (billing runs from the arrival, so a
      // guest who booked 3 and arrived on the last day owes 1); before check-in
      // the reserved count is the only figure there is. The reserved figure
      // survives as a muted "(reserved 3)" when the two disagree — it is what a
      // dispute is argued from — and is omitted when they agree, because showing
      // the same number twice invents a distinction that is not there.
      {
        label: 'Nights',
        value: (
          <>
            <span className="font-semibold tabular-nums text-charcoal">
              {stay.actual ?? stay.reserved}
            </span>
            {stay.differs ? (
              <span className="ml-1.5 text-xs tabular-nums text-charcoal-muted">
                (reserved {stay.reserved})
              </span>
            ) : null}
          </>
        ),
      },
      {
        label: 'Company',
        value: companyName ?? (
          <span className="text-charcoal-muted">Walk-in</span>
        ),
      },
      {
        label: 'Bill to',
        value:
          detail.bill_to === 'company'
            ? `Company${companyName ? ` — ${companyName}` : ''}`
            : 'Guest',
      },
    ];

    // ACTUAL ARRIVAL — when they turned up, as ONE value: the arrival instant in
    // the HOTEL's clock ("1 Aug 2026, 22:13"). The bare date is the fallback for
    // a pre-024 stay that has an arrival date but no recorded instant.
    if (detail.actual_check_in) {
      facts.push({
        label: 'Arrived',
        value: (
          <span className="font-semibold text-charcoal">
            {(detail.checked_in_at
              ? formatDisplayDateTimeInZone(detail.checked_in_at, timezone)
              : '') ||
              formatDisplayDate(detail.actual_check_in) ||
              MISSING_VALUE}
          </span>
        ),
      });
    }

    // EXPECTED ARRIVAL (025) — a note the guest gave at booking. IT CHANGES
    // NOTHING: not the price, not availability, not when a no-show may be
    // recorded. The auto-resolve pass (029) waits for the whole reserved arrival
    // DAY to end in the property's timezone, so a 22:00 arrival was never at
    // risk; this exists so the desk is not surprised by an empty room at 20:00
    // and does not go chasing a guest who is on their way.
    if (detail.expected_arrival_time) {
      facts.push({
        label: 'Expected arrival',
        value: (
          <>
            <span className="font-semibold text-charcoal">
              ~{formatDisplayTime(detail.expected_arrival_time) || MISSING_VALUE}
            </span>
            <span className="ml-1.5 text-xs text-charcoal-muted">
              (noted at booking)
            </span>
          </>
        ),
      });
    }

    if (detail.special_requests) {
      facts.push({
        label: 'Special requests',
        value: detail.special_requests,
      });
    }

    if (detail.status === 'cancelled' && detail.cancellation_reason) {
      facts.push({
        label: 'Cancellation reason',
        value: detail.cancellation_reason,
      });
    }

    return facts;
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
      {/* Level 2: a tab is its own screen to the person using it, and gets
          the same shape as a page (rule 25). The three things this tab used to
          explain in place — reserved versus billed nights, why the arrival time
          can be back-dated, and what checkout posts — are in the ⓘ. */}
      <ScreenHeader
        level={2}
        title="Stay"
        purpose="Check the guest in, out, or off."
        about={{
          title: STAY_ABOUT_TITLE,
          paragraphs: STAY_ABOUT,
          guideAnchor: 'reserved-nights-and-nights-billed',
          guideLabel: 'Reserved nights and nights billed',
        }}
        propertySlug={propertySlug}
      />

      {/* WAS THIS BOOKING RESTORED? Read from the permanent reversals rows, so
          the answer is the audit trail itself and not a flag somebody could set.
          Both can be present over a booking's life — no-showed and restored in
          August, cancelled and restored in September — so both are shown. */}
      {statusReversals.noShow ? (
        <RestoreNotice
          reversal={statusReversals.noShow}
          currentUserId={user?.id ?? null}
          title="No-show reversed — this booking was restored"
          detail="The booking went back to confirmed and the room is held for it again. Any no-show charge was credited back by a counter-entry on the folio."
        />
      ) : null}
      {statusReversals.cancel ? (
        <RestoreNotice
          reversal={statusReversals.cancel}
          currentUserId={user?.id ?? null}
          title="Cancellation reversed — this booking was restored"
          detail="The booking went back to confirmed and the room is held for it again. The cancellation itself, and its reason, stay on the record below."
        />
      ) : null}
      {/* THE CHECKOUT REVERSAL (034). It stays on the page after the guest has
          been checked out a second time — the notice is a fact about an act
          that happened, not a badge on the current status. */}
      {statusReversals.checkout ? (
        <RestoreNotice
          reversal={statusReversals.checkout}
          currentUserId={user?.id ?? null}
          title="Checkout reversed — this stay was reopened"
          detail="The stay went back to checked in and its folio was reopened. The room charges already posted were not reversed: those nights were slept, and they remain on the bill."
        />
      ) : null}
      {reversalsError ? (
        // Rule 11: the stay still renders; this says plainly that ONE part of it
        // could not be read, rather than silently omitting a restore notice.
        <p className="text-xs text-charcoal-muted">
          The reversal history for this booking could not be read.{' '}
          {reversalsError}
        </p>
      ) : null}

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

      {/* THE RESERVATION, as a COMPACT TABLE (build 2 §1) — two label/value pairs
          per row on a laptop, one per row at 360px, in the same sharp style as
          the folio bill and the stays table. It used to be a flat one-fact-per-
          row dump that ran half a screen tall, which pushed the nights and the
          bill-to — the two things a receptionist is actually looking for — below
          the fold for no reason.

          THE SEVEN CORE FACTS ARE ALWAYS PRESENT, in this order, so the table
          has the same shape for every booking and the eye learns where to look.
          The four conditional ones below them appear only when they carry a
          value: an "Expected arrival: —" row on the 95% of bookings that noted
          none is a row that says nothing. */}
      <FactTable caption="Reservation" facts={reservationFacts()} />

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
          {/* The paragraph that used to sit here — why you would back-date an
             arrival, and what it does to the reserved date — is in the ⓘ on the
             tab heading. What is left is the LIVE consequence below, which
             appears only when the two dates actually disagree and names the
             real ones: that is not an explanation of the screen, it is what
             this booking is about to do. */}
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

      {/* THE TWO REVERSALS (migration 033). They use the folio action card
          rather than this file's ActionPanel because they carry what a folio
          reversal carries — a mandatory reason and an always-required manager
          PIN — and a reversal must look the same wherever it is performed. */}
      {panel === 'reverse-noshow' ? (
        <ReverseBookingStatusForm
          kind="no_show"
          bookingId={detail.id}
          bookingNumber={detail.booking_number}
          checkIn={detail.check_in}
          checkOut={detail.check_out}
          roomTypeName={detail.room_type?.name ?? null}
          // Known here, so the panel can state exactly what happens to the
          // money rather than covering both cases. The server decides either
          // way — this only chooses the sentence.
          guaranteed={guaranteed}
          propertyToday={propertyToday}
          onDone={async () => {
            closePanel();
            await onChanged();
          }}
          onCancel={closePanel}
        />
      ) : null}

      {panel === 'reverse-cancel' ? (
        <ReverseBookingStatusForm
          kind="cancel"
          bookingId={detail.id}
          bookingNumber={detail.booking_number}
          checkIn={detail.check_in}
          checkOut={detail.check_out}
          roomTypeName={detail.room_type?.name ?? null}
          propertyToday={propertyToday}
          onDone={async () => {
            closePanel();
            await onChanged();
          }}
          onCancel={closePanel}
        />
      ) : null}

      {/* THE CHECKOUT REVERSAL (034). Its own component, not a third `kind` on
          the form above: that one's copy is entirely about re-taking a room and
          restoring to confirmed, and neither is true here. */}
      {panel === 'reverse-checkout' ? (
        <ReverseCheckoutForm
          bookingId={detail.id}
          bookingNumber={detail.booking_number}
          checkIn={detail.check_in}
          checkOut={detail.check_out}
          roomTypeName={detail.room_type?.name ?? null}
          onDone={async () => {
            closePanel();
            // Clears the checkout receipt card: it describes a departure that
            // has just been undone, and leaving it above a checked-in stay
            // would be the one contradiction on this page.
            setCheckOutSummary(null);
            await onChanged();
          }}
          onCancel={closePanel}
        />
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
          {/* THE TWO REVERSALS (033), each offered ONLY on the state it undoes
              and only while it has not already been undone. Both re-take the
              room, so both are PIN-gated and availability-checked by their RPC;
              this only decides what to OFFER (rule 19 — the database is the
              guard). A booking already restored once cannot be restored again:
              a reversal is recorded once per act, ever, so the button goes away
              rather than leading to a refusal. */}
          {status === 'no_show' && statusReversals.noShow === null ? (
            <SecondaryButton
              busy={busy}
              onClick={() => setPanel('reverse-noshow')}
            >
              Reverse no-show
            </SecondaryButton>
          ) : null}
          {status === 'cancelled' && statusReversals.cancel === null ? (
            <SecondaryButton
              busy={busy}
              onClick={() => setPanel('reverse-cancel')}
            >
              Reverse cancellation
            </SecondaryButton>
          ) : null}
          {/* REVERSE CHECKOUT (034) — offered only on a checked-out stay that
              has not already been reopened once. Unlike the two above it does
              not re-take a room (a checked-out stay never released one), but it
              is gated the same way for the same reason: a checkout is reversed
              once, ever, so the button goes away rather than leading to a
              refusal. A stay reopened and then checked out again therefore has
              no button here — which is correct, and the notice above says why. */}
          {status === 'checked_out' && statusReversals.checkout === null ? (
            <SecondaryButton
              busy={busy}
              onClick={() => setPanel('reverse-checkout')}
            >
              Reverse checkout
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
          {/* The "nothing more to do here" line, now excluding the two states
              that DO have an action: a cancelled or no-showed booking can be
              restored, so telling the reader otherwise would hide it. It also
              stays away once a restore has been used up, because the notice
              above already explains what happened. */}
          {status !== 'confirmed' &&
          status !== 'checked_in' &&
          !(status === 'no_show' && statusReversals.noShow === null) &&
          !(status === 'cancelled' && statusReversals.cancel === null) &&
          !(status === 'checked_out' && statusReversals.checkout === null) ? (
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

// THE RESTORE NOTICE (migration 033). A booking that was put back needs to say
// so on its own page, permanently and with a name attached — that is the whole
// point of the reversals row, and a restore nobody is answerable for is exactly
// the shape of act this subsystem exists to make impossible.
//
// EVERY FIELD IS THE DATABASE'S: the business date the reversal was recorded on
// (rules 8 and 12 — the property's operating day, never the browser's clock),
// the reason as it was typed, the staff member who keyed it and the MANAGER
// whose PIN authorised it. Nothing here is derived and nothing can be edited:
// the reversals table has no update path in the app, no write RLS policy, and a
// change_log tripwire if one ever appeared.
//
// role="status", not alert: it reports something that already happened rather
// than demanding an action.
function RestoreNotice({
  reversal,
  currentUserId,
  title,
  detail,
}: {
  reversal: Reversal;
  currentUserId: string | null;
  title: string;
  detail: string;
}) {
  return (
    <section
      role="status"
      className="rounded-2xl border border-sand-border bg-white/70 px-4 py-3"
    >
      <h3 className="text-sm font-bold text-charcoal">{title}</h3>
      <p className="mt-1 text-xs text-charcoal">{detail}</p>
      {/* At 360px these stack; from sm they sit in a row. */}
      <dl className="mt-3 grid gap-3 sm:grid-cols-3">
        <div className="sm:col-span-3">
          <dt className="text-xs text-charcoal-muted">Reason</dt>
          <dd className="text-sm font-semibold text-charcoal">
            {reversal.reason}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-charcoal-muted">On</dt>
          <dd className="text-sm font-semibold tabular-nums text-charcoal">
            {formatDisplayDate(reversal.business_date) || MISSING_VALUE}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-charcoal-muted">Recorded by</dt>
          <dd className="text-sm font-semibold text-charcoal">
            {staffLabel(reversal.reversed_by, currentUserId)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-charcoal-muted">Approved by</dt>
          <dd className="text-sm font-semibold text-charcoal">
            {staffLabel(reversal.approved_by, currentUserId)}
          </dd>
        </div>
      </dl>
    </section>
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
