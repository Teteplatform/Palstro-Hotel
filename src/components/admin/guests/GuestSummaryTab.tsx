import { useState } from 'react';
import { useActiveProperty } from '../../../hooks/useActiveProperty';
import { useStatementExport } from '../../../hooks/useStatementExport';
import { Pagination } from '../../ui/Pagination';
import { formatMoney, MISSING_VALUE } from '../../../lib/format';
import { formatDisplayDate, todayIsoInZone } from '../../../lib/date';
import { AddChargeForm } from '../folio/AddChargeForm';
import { TakePaymentForm } from '../folio/TakePaymentForm';
import { FollowUpNotices } from '../FollowUpNotices';
import { GuestStaysTable, type StayAction } from './GuestStaysTable';
import { CancelPanel, CheckInPanel, CheckOutPanel } from './StayConfirmPanels';
import { ReverseBookingStatusForm } from '../bookings/ReverseBookingStatusForm';
import { ReverseCheckoutForm } from '../bookings/ReverseCheckoutForm';
import { StandaloneEntryPanel } from './StandaloneEntryPanel';
import { SendStatementEmailDialog } from '../statement/SendStatementEmailDialog';
import type { StatementData } from '../../../lib/statement';
import type { StatementTarget } from '../../../lib/statementLoad';
import type { GuestAccountSummary, GuestStayRow } from '../../../types/guestLedger';

// THE SUMMARY TAB (2.txt §2) — the guest's account as it stands RIGHT NOW: six
// figures, then their stays.
//
// IT IS CALLED "SUMMARY", NOT "HISTORY", and the rename is the point: every
// figure here is a current snapshot — what they owe, what is on the books today
// — not a record of the past. A tab called History invites the reader to treat
// the outstanding balance as something that already happened.
//
// EVERY FIGURE IN THE STRIP SPANS THE WHOLE ACCOUNT, NOT THE PAGE (rule 20). The
// summary is a separate SERVER-SIDE aggregate over every stay and every
// standalone item (guest_account_summary, 028 §7), never a sum of the rows
// currently on screen — a "total nights" that changed when you clicked to page 2
// would be a wrong number presented with confidence, which is worse than no
// number. The strip carries the how-it-was-calculated note rule 16 requires, and
// that note says so.
//
// THE LONG "BALANCE / SETTLEMENT" PARAGRAPH IS GONE. It existed to explain why a
// stay could read "Settled" while its Balance column showed money — a
// contradiction created by putting the FIFO working in a column of its own. The
// column is gone (see GuestStaysTable), so the paragraph explaining it has
// nothing left to explain. The working still exists in the view and on the
// statement, where a reader who wants it can find it.
//
// SCOPE: this property. A guest belongs to the tenant and may stay at several of
// its properties (014), but an operational screen is always scoped to one
// property (§6), and so is the money. The note says which.

interface GuestSummaryTabProps {
  guestId: string;
  // For the ⓘ's link into this property's copy of the staff guide.
  propertySlug: string;
  guestName: string;
  tenantId: string;
  propertyId: string;
  summary: GuestAccountSummary | null;
  summaryLoading: boolean;
  stays: GuestStayRow[];
  count: number;
  page: number;
  pageSize: number;
  loading: boolean;
  currency: string;
  timezone: string;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
  onOpenStay: (bookingId: string) => void;
  // Opens the GUEST-FACING statement for one stay — the clean printable bill,
  // as opposed to onOpenStay's internal folio (3.txt).
  onOpenStayStatement: (bookingId: string) => void;
  // The same document for the guest's non-resident account.
  onOpenStandaloneStatement: () => void;
  onAccountChanged: () => Promise<void> | void;
}

const SUMMARY_NOTE =
  'Across this guest’s ENTIRE account at this property — every stay and every ' +
  'standalone charge or payment — not just the stays on this page. Nights are ' +
  'the ACTUAL nights billed (from the recorded arrival to check-out); a stay ' +
  'that has not arrived yet counts its reserved nights. Charged is every ' +
  'non-voided charge plus its tax; paid is every non-voided payment, net of ' +
  'refunds. Outstanding is charged minus paid when the guest owes, and is shown ' +
  'as Credit held when the hotel is holding their money. Nothing is stored: ' +
  'every figure is recalculated on each read.';

// Which panel is open above the stays table. ONE at a time: each is a decision
// that deserves the screen's attention, and two open panels invite pressing the
// wrong confirm.
type PanelState =
  | { kind: 'payment'; row: GuestStayRow }
  | { kind: 'charge'; row: GuestStayRow }
  | { kind: 'checkin'; row: GuestStayRow }
  | { kind: 'checkout'; row: GuestStayRow }
  | { kind: 'cancel'; row: GuestStayRow }
  // The two STATUS REVERSALS (033): un-no-show and un-cancel. Each restores the
  // booking to confirmed, and each re-takes the room — so each is PIN-gated and
  // availability-checked by its RPC.
  | { kind: 'reverse-noshow'; row: GuestStayRow }
  | { kind: 'reverse-cancel'; row: GuestStayRow }
  // The CHECKOUT reversal (034), which reopens a stay the guest has not left.
  // PIN-gated like the two above, but it re-takes nothing: a checked-out stay
  // never released its room, so there is no availability check to fail.
  | { kind: 'reverse-checkout'; row: GuestStayRow }
  | { kind: 'standalone' }
  | null;

export function GuestSummaryTab({
  guestId,
  guestName,
  propertySlug,
  tenantId,
  propertyId,
  summary,
  summaryLoading,
  stays,
  count,
  page,
  pageSize,
  loading,
  currency,
  timezone,
  onPageChange,
  onPageSizeChange,
  onOpenStay,
  onOpenStayStatement,
  onOpenStandaloneStatement,
  onAccountChanged,
}: GuestSummaryTabProps) {
  const [panel, setPanel] = useState<PanelState>(null);
  // The stay whose statement is being emailed, with the document already
  // assembled. Not a PanelState: the panels above are inline forms that replace
  // the action strip, and this is a modal over the whole page.
  const [emailing, setEmailing] = useState<{
    statement: StatementData;
    target: StatementTarget;
  } | null>(null);
  // ONE exporter for the whole table: the target travels with each call, because
  // a hook per row is not something React allows. Opening a row's menu primes
  // that stay's document (see onActionsOpen below).
  const { property } = useActiveProperty();
  const statementExport = useStatementExport({ property });

  async function afterMutation() {
    setPanel(null);
    // Rule 6: nothing is patched locally. Every figure is re-read from the
    // views, which recompute folio_totals and the FIFO allocation from scratch.
    await onAccountChanged();
  }

  // THE KEBAB'S MENU for one stay.
  //
  // MONEY IS NEVER STATUS-GATED HERE, and that is deliberate: a checked-out
  // guest can still be paid by (late settlement) and still be charged (a late
  // extra), so Make payment and Add charge are offered on every stay whose folio
  // can take them. Only the two LIFECYCLE actions are gated — you cannot check
  // out someone who is not checked in, and you cannot cancel a stay that has
  // already begun. Both gates mirror the RPCs' own guards; the RPC is the real
  // one (rule 19).
  function actionsFor(row: GuestStayRow): StayAction[] {
    const actions: StayAction[] = [];

    // A closed folio takes no money at all; a settled one still takes payments
    // and refunds but no new charges (021 §9.1/§9.4). Mirrored, not enforced.
    if (row.folio_status !== 'closed') {
      actions.push({
        key: 'payment',
        label: 'Make payment',
        onSelect: () => setPanel({ kind: 'payment', row }),
      });
    }
    if (row.folio_status === 'open') {
      actions.push({
        key: 'charge',
        label: 'Add charge',
        onSelect: () => setPanel({ kind: 'charge', row }),
      });
    }
    actions.push({
      key: 'bill',
      label: 'Open full bill',
      onSelect: () => onOpenStay(row.booking_id),
    });
    // THE GUEST-FACING BILL (3.txt), beside the internal one. Two entries, two
    // plain names: "Open full bill" is the working document with the void trail
    // and the per-line tools; "Statement" is the clean printable page the guest
    // is handed or sent. Offered on EVERY stay, whatever its status — a folio
    // with nothing on it prints an honest empty statement, and a checked-out
    // guest asking for their bill a week later is the commonest reason anyone
    // opens this menu at all.
    actions.push({
      key: 'statement',
      label: 'Statement',
      onSelect: () => onOpenStayStatement(row.booking_id),
    });
    // THE TWO EXPORTS A DESK REACHES FOR WITHOUT WANTING TO OPEN A PAGE: save the
    // guest their bill, or send it to them. Both build the SAME assembled
    // document the statement route renders — the menu opening has already
    // started loading it — so a PDF saved from here and one saved from the
    // statement page are the same file. Excel and Word stay on the statement
    // page and the stay page: they are the "I need to work on this" formats, and
    // whoever needs them is already looking at the document.
    actions.push({
      key: 'statement-pdf',
      label: 'Statement PDF',
      onSelect: () => {
        void statementExport.run('pdf', {
          kind: 'stay',
          bookingId: row.booking_id,
        });
      },
    });
    actions.push({
      key: 'statement-whatsapp',
      label: 'Send on WhatsApp',
      onSelect: () => {
        void statementExport.run('whatsapp', {
          kind: 'stay',
          bookingId: row.booking_id,
        });
      },
    });
    // EMAIL, the third way this document reaches the guest. It opens a dialog
    // rather than sending, because the address on file is exactly the thing that
    // is wrong often enough to matter — see SendStatementEmailDialog. The
    // document is resolved FIRST (the menu opening already primed it) so the
    // dialog can show what is about to be sent and to whom.
    actions.push({
      key: 'statement-email',
      label: 'Email statement',
      onSelect: () => {
        const target: StatementTarget = { kind: 'stay', bookingId: row.booking_id };
        void statementExport.prepare(target).then((statement) => {
          // A null means the document could not be built and prepare() has
          // already said why (rule 11); there is nothing to open a dialog on.
          if (statement) setEmailing({ statement, target });
        });
      },
    });
    // CHECK IN, on the guest home (build 2 §1) — the front desk pulls up the
    // person, not the reservation, so this is where a stay begins. It NEVER
    // checks anybody in silently: it opens the arrival date/time picker, because
    // the arrival date is what decides which nights the folio bills.
    if (row.status === 'confirmed') {
      actions.push({
        key: 'checkin',
        label: 'Check in',
        onSelect: () => setPanel({ kind: 'checkin', row }),
      });
    }
    if (row.status === 'checked_in') {
      actions.push({
        key: 'checkout',
        label: 'Check out',
        onSelect: () => setPanel({ kind: 'checkout', row }),
      });
    }
    if (row.status === 'confirmed') {
      actions.push({
        key: 'cancel',
        label: 'Cancel',
        tone: 'destructive',
        onSelect: () => setPanel({ kind: 'cancel', row }),
      });
    }
    // THE TWO REVERSALS (033), each offered only on the state it undoes. They
    // are the desk's way back from a stay that was resolved wrongly — the guest
    // who arrived at 01:00 and was already recorded as a no-show, the booking
    // cancelled on the wrong row — and this menu is where the desk works.
    //
    // Offered here from the row's status alone, without reading the reversals
    // table for every stay on the page: a booking already restored once is
    // refused by its RPC in its own words, which the panel shows verbatim. The
    // stay page, which reads one booking, is where the "already restored"
    // notice lives and where the action disappears.
    if (row.status === 'no_show') {
      actions.push({
        key: 'reverse-noshow',
        label: 'Reverse no-show',
        tone: 'destructive',
        onSelect: () => setPanel({ kind: 'reverse-noshow', row }),
      });
    }
    if (row.status === 'cancelled') {
      actions.push({
        key: 'reverse-cancel',
        label: 'Reverse cancellation',
        tone: 'destructive',
        onSelect: () => setPanel({ kind: 'reverse-cancel', row }),
      });
    }
    // REVERSE CHECKOUT (034) — the guest has not actually left. Offered from the
    // row's status alone, exactly as the two above are: a stay already reopened
    // once is refused by its RPC in its own words, which the panel shows
    // verbatim. The stay page, which reads one booking, is where the "already
    // reopened" notice lives and where the action disappears.
    if (row.status === 'checked_out') {
      actions.push({
        key: 'reverse-checkout',
        label: 'Reverse checkout',
        tone: 'destructive',
        onSelect: () => setPanel({ kind: 'reverse-checkout', row }),
      });
    }
    return actions;
  }

  const owing = summary !== null && summary.outstanding > 0;
  const holdingCredit = summary !== null && summary.creditBalance > 0;

  return (
    <div className="space-y-5">
      {/* THE NIGHT AUDIT'S FOLLOW-UPS FOR THIS GUEST (029) — above everything,
          because if there is one it is the reason somebody opened this page. A
          corporate stay the audit no-showed and charged has had its room
          released; the desk is asked to call before it goes to someone else. It
          renders nothing when there is nothing outstanding. */}
      <FollowUpNotices
        tenantId={tenantId}
        propertyId={propertyId}
        guestId={guestId}
        // The acknowledgement changes no money and no availability, but the
        // stays table is re-read anyway so the page is never showing a mix of
        // pre- and post-action state.
        onAcknowledged={() => void onAccountChanged()}
      />

      <section aria-labelledby="guest-summary-heading" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2
            id="guest-summary-heading"
            className="text-lg font-bold tracking-tight text-charcoal"
          >
            Summary
          </h2>
          <span className="flex items-center gap-2 text-xs text-charcoal-muted">
            {summaryLoading ? <span aria-live="polite">Updating…</span> : null}
            {/* Rule 16 — and rule 20's specific requirement that the note says
                the figures span the whole set, not the page. */}
            <span
              className="cursor-help"
              tabIndex={0}
              role="note"
              aria-label={SUMMARY_NOTE}
              title={SUMMARY_NOTE}
            >
              ⓘ How this is calculated
            </span>
          </span>
        </div>

        {/* The six tiles. They WRAP rather than scroll at 360px — six short
            figures stack two-up on a phone and read fine. */}
        <div className="grid grid-cols-2 gap-3 rounded-2xl border border-sand-border bg-white/60 p-4 sm:grid-cols-3 lg:grid-cols-6">
          <Figure
            label="With us since"
            value={
              summary?.firstStay ? formatDisplayDate(summary.firstStay) : MISSING_VALUE
            }
          />
          <Figure
            label="Stays"
            value={summary ? String(summary.stayCount) : MISSING_VALUE}
          />
          {/* PART 1: Σ ACTUAL nights across their stays, reserved only for the
              ones that have not arrived. This is the figure that used to read 3
              for a guest the folio billed 1 night. */}
          <Figure
            label="Nights"
            value={summary ? String(summary.totalNights) : MISSING_VALUE}
          />
          {/* "Charged" and "Paid" are two figures on purpose: what the guest was
              BILLED and what they have actually PAID are different numbers, and
              collapsing them into one word ("spent") is how a report ends up
              meaning whatever the reader assumed. */}
          <Figure
            label="Charged"
            value={
              summary ? formatMoney(summary.totalCharged, currency) : MISSING_VALUE
            }
          />
          <Figure
            label="Paid"
            value={summary ? formatMoney(summary.totalPaid, currency) : MISSING_VALUE}
          />
          {/* THE ONE BALANCE, under the SAME colour rule as the folio and the
              bookings list: red when the guest owes, green when nothing is owed.
              When the hotel is holding their money the tile says so in words —
              "Credit held" — rather than printing a negative Outstanding, which
              reads as a typo. */}
          {holdingCredit && !owing ? (
            <Figure
              label="Credit held"
              value={formatMoney(summary.creditBalance, currency)}
              tone="positive"
            />
          ) : (
            <Figure
              label="Outstanding"
              value={
                summary ? formatMoney(summary.outstanding, currency) : MISSING_VALUE
              }
              tone={owing ? 'negative' : 'positive'}
            />
          )}
        </div>
      </section>

      <section aria-labelledby="guest-stays-heading" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2
            id="guest-stays-heading"
            className="text-lg font-bold tracking-tight text-charcoal"
          >
            Stays
          </h2>
          {panel === null ? (
            <div className="flex flex-wrap items-center gap-2 print:hidden">
              {/* The non-resident account's own statement (3.txt) — the same
                  document, adapted: no room, no dates, no nights.

                  SHOWN ONLY WHEN THERE IS SOMETHING TO PRINT. standalone_count
                  (028 §7) counts standalone CHARGES, so the rare account
                  holding only a payment and no charge does not surface a link
                  here; it is still reachable at the route, and the statement
                  page says plainly when a guest has no non-resident account. A
                  permanently visible link that usually leads to an empty page
                  would be worse than the edge case. */}
              {summary && summary.standaloneCount > 0 ? (
                <button
                  type="button"
                  onClick={onOpenStandaloneStatement}
                  className="rounded-full border border-sand-border bg-white/70 px-4 py-2 text-xs font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream"
                >
                  Non-resident statement
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => setPanel({ kind: 'standalone' })}
                className="rounded-full border border-sand-border bg-white/70 px-4 py-2 text-xs font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream"
              >
                Standalone charge / payment
              </button>
            </div>
          ) : null}
        </div>

        {/* The open panel, ABOVE the table it acts on, in the same scroll flow —
            the folio surfaces use the same inline-card pattern for the same
            reason: a dialog over a page the user is reading costs more attention
            than the action is worth, and keeping the row visible while you type
            is the whole benefit. */}
        {panel?.kind === 'payment' ? (
          <TakePaymentForm
            folioId={panel.row.folio_id}
            currency={currency}
            timezone={timezone}
            title={`Take payment — ${panel.row.booking_number}`}
            subject="Recorded against this stay's folio."
            propertySlug={propertySlug}
            onDone={afterMutation}
            onCancel={() => setPanel(null)}
          />
        ) : null}
        {panel?.kind === 'charge' ? (
          <AddChargeForm
            folioId={panel.row.folio_id}
            tenantId={tenantId}
            propertyId={propertyId}
            currency={currency}
            timezone={timezone}
            title={`Add charge — ${panel.row.booking_number}`}
            onDone={afterMutation}
            onCancel={() => setPanel(null)}
          />
        ) : null}
        {panel?.kind === 'checkin' ? (
          <CheckInPanel
            row={panel.row}
            timezone={timezone}
            onDone={afterMutation}
            onCancel={() => setPanel(null)}
          />
        ) : null}
        {panel?.kind === 'checkout' ? (
          <CheckOutPanel
            row={panel.row}
            currency={currency}
            onDone={afterMutation}
            onCancel={() => setPanel(null)}
          />
        ) : null}
        {panel?.kind === 'cancel' ? (
          <CancelPanel
            row={panel.row}
            onDone={afterMutation}
            onCancel={() => setPanel(null)}
          />
        ) : null}
        {/* The restore panels. Same component the stay page mounts, so a
            reversal asks for the same things and reads the same way wherever it
            is done. The room type is on the row; the property's today drives the
            "this arrival date has passed" warning. */}
        {panel?.kind === 'reverse-noshow' ? (
          <ReverseBookingStatusForm
            kind="no_show"
            bookingId={panel.row.booking_id}
            bookingNumber={panel.row.booking_number}
            checkIn={panel.row.check_in}
            checkOut={panel.row.check_out}
            roomTypeName={panel.row.room_type_name}
            // guaranteed is deliberately NOT passed: guest_stays carries no
            // company, and the panel's copy covers both cases without guessing.
            // The server decides what happens to the money either way.
            propertyToday={todayIsoInZone(timezone)}
            onDone={afterMutation}
            onCancel={() => setPanel(null)}
          />
        ) : null}
        {panel?.kind === 'reverse-cancel' ? (
          <ReverseBookingStatusForm
            kind="cancel"
            bookingId={panel.row.booking_id}
            bookingNumber={panel.row.booking_number}
            checkIn={panel.row.check_in}
            checkOut={panel.row.check_out}
            roomTypeName={panel.row.room_type_name}
            propertyToday={todayIsoInZone(timezone)}
            onDone={afterMutation}
            onCancel={() => setPanel(null)}
          />
        ) : null}
        {/* Reopening a stay. The same component the stay page mounts, so the
            act asks for the same things and reads the same way wherever it is
            done. No propertyToday is needed: nothing about this panel depends
            on the date — it re-takes no room and can be refused for no
            availability reason. */}
        {panel?.kind === 'reverse-checkout' ? (
          <ReverseCheckoutForm
            bookingId={panel.row.booking_id}
            bookingNumber={panel.row.booking_number}
            checkIn={panel.row.check_in}
            checkOut={panel.row.check_out}
            roomTypeName={panel.row.room_type_name}
            onDone={afterMutation}
            onCancel={() => setPanel(null)}
          />
        ) : null}
        {panel?.kind === 'standalone' ? (
          <StandaloneEntryPanel
            guestId={guestId}
            propertySlug={propertySlug}
            guestName={guestName}
            tenantId={tenantId}
            propertyId={propertyId}
            currency={currency}
            timezone={timezone}
            onDone={afterMutation}
            onCancel={() => setPanel(null)}
          />
        ) : null}

        {/* Mounted only while a statement is being emailed. `property` is
            non-null here by construction — the exporter above needs it too — and
            the dialog is not offered before the active property resolves. */}
        {emailing && property ? (
          <SendStatementEmailDialog
            statement={emailing.statement}
            target={emailing.target}
            property={property}
            onClose={() => setEmailing(null)}
          />
        ) : null}

        <GuestStaysTable
          rows={stays}
          currency={currency}
          loading={loading}
          actionsFor={actionsFor}
          // Start reading the stay's statement as the menu opens, so the export
          // items below it act immediately — and, on a phone, so WhatsApp's
          // native share is still reachable inside the click that follows.
          onActionsOpen={(row) =>
            statementExport.prime({ kind: 'stay', bookingId: row.booking_id })
          }
          onOpenStay={onOpenStay}
        />

        {/* Rule 1b: server-side paging with an exact count, jump-to-first/last,
            direct page entry and a page-size selector — the one shared
            component, so paging behaves identically everywhere. The totals above
            span the whole set regardless of what this shows (rule 20). */}
        <Pagination
          page={page}
          pageSize={pageSize}
          totalCount={count}
          onPageChange={onPageChange}
          onPageSizeChange={onPageSizeChange}
          disabled={loading}
          itemNoun="stays"
        />
      </section>
    </div>
  );
}

function Figure({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'positive' | 'negative';
}) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-charcoal-muted">
        {label}
      </p>
      <p
        className={`truncate text-sm font-bold tabular-nums ${
          tone === 'negative'
            ? 'text-negative'
            : tone === 'positive'
              ? 'text-positive'
              : 'text-charcoal'
        }`}
        title={value}
      >
        {value}
      </p>
    </div>
  );
}
