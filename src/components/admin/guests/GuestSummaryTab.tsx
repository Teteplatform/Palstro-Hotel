import { useState } from 'react';
import { Pagination } from '../../ui/Pagination';
import { formatMoney, MISSING_VALUE } from '../../../lib/format';
import { formatDisplayDate } from '../../../lib/date';
import { AddChargeForm } from '../folio/AddChargeForm';
import { TakePaymentForm } from '../folio/TakePaymentForm';
import { FollowUpNotices } from '../FollowUpNotices';
import { GuestStaysTable, type StayAction } from './GuestStaysTable';
import { CancelPanel, CheckInPanel, CheckOutPanel } from './StayConfirmPanels';
import { StandaloneEntryPanel } from './StandaloneEntryPanel';
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
  | { kind: 'standalone' }
  | null;

export function GuestSummaryTab({
  guestId,
  guestName,
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
  onAccountChanged,
}: GuestSummaryTabProps) {
  const [panel, setPanel] = useState<PanelState>(null);

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
            <button
              type="button"
              onClick={() => setPanel({ kind: 'standalone' })}
              className="rounded-full border border-sand-border bg-white/70 px-4 py-2 text-xs font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream print:hidden"
            >
              Standalone charge / payment
            </button>
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
            description="Recorded against this stay's folio. It joins the guest's payment pool and settles their oldest unpaid item first."
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
        {panel?.kind === 'standalone' ? (
          <StandaloneEntryPanel
            guestId={guestId}
            guestName={guestName}
            tenantId={tenantId}
            propertyId={propertyId}
            currency={currency}
            timezone={timezone}
            onDone={afterMutation}
            onCancel={() => setPanel(null)}
          />
        ) : null}

        <GuestStaysTable
          rows={stays}
          currency={currency}
          loading={loading}
          actionsFor={actionsFor}
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
