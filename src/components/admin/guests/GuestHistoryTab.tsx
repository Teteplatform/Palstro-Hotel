import { useState } from 'react';
import { Pagination } from '../../ui/Pagination';
import { useToast } from '../../ui/Toast';
import { controlClasses } from '../../ui/form';
import { humanizeError } from '../../../lib/errors';
import { formatMoney, MISSING_VALUE } from '../../../lib/format';
import { formatDisplayDate } from '../../../lib/date';
import { updateGuestPreferences } from '../../../lib/guests';
import type { Guest } from '../../../types/guest';
import type { GuestHistorySummary, GuestStayRow } from '../../../types/guestLedger';
import { GuestStaysTable } from './GuestStaysTable';

// THE GUEST'S HISTORY (2.txt §2): the lifetime summary strip, their preferences,
// and the paginated table of their stays.
//
// EVERY FIGURE IN THE STRIP SPANS ALL OF THEIR STAYS, NOT THE PAGE (rule 20).
// The summary is a SEPARATE aggregate read over the whole set (see
// fetchGuestHistorySummary), never a sum of the rows currently on screen — a
// "total nights" that changed when you clicked to page 2 would be a wrong number
// presented with confidence, which is worse than no number. The strip carries
// the how-it-was-calculated note rule 16 requires, and that note says so.
//
// SCOPE: this property. A guest belongs to the tenant and may stay at several of
// its properties (014), but an operational screen is always scoped to one
// property (§6), and so is the money. The note says which.

interface GuestHistoryTabProps {
  guest: Guest;
  tenantId: string;
  summary: GuestHistorySummary | null;
  summaryLoading: boolean;
  stays: GuestStayRow[];
  count: number;
  page: number;
  pageSize: number;
  loading: boolean;
  currency: string;
  // Whether this user may save a preference. The admin-only RLS policy is the
  // real guard — this only decides whether to OFFER the action (rule 19).
  canEdit: boolean;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
  onOpenStay: (bookingId: string) => void;
  onGuestChanged: () => Promise<void> | void;
}

const SUMMARY_NOTE =
  'Across EVERY stay this guest has had at this property, not just the stays on ' +
  'this page. Nights are the booked nights (check-out minus check-in). Total ' +
  'charged is every non-voided charge on those stays; total paid is every ' +
  'non-voided payment, net of refunds. Outstanding is what is still owed and ' +
  'credit is money held on account — the two are shown separately, never netted ' +
  'into one figure. Nothing is stored: every number is recalculated on each read.';

export function GuestHistoryTab({
  guest,
  tenantId,
  summary,
  summaryLoading,
  stays,
  count,
  page,
  pageSize,
  loading,
  currency,
  canEdit,
  onPageChange,
  onPageSizeChange,
  onOpenStay,
  onGuestChanged,
}: GuestHistoryTabProps) {
  return (
    <div className="space-y-5">
      <section aria-labelledby="guest-history-heading" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2
            id="guest-history-heading"
            className="text-lg font-bold tracking-tight text-charcoal"
          >
            History
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

        {/* The strip. Wraps rather than scrolls at 360px — six short figures
            stack two-up on a phone and read fine. */}
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
          <Figure
            label="Total nights"
            value={summary ? String(summary.totalNights) : MISSING_VALUE}
          />
          {/* "Total spent" is stated as two figures on purpose: what the guest
              was BILLED and what they have actually PAID are different numbers,
              and collapsing them into one word ("spent") is how a report ends up
              meaning whatever the reader assumed. */}
          <Figure
            label="Total charged"
            value={
              summary ? formatMoney(summary.totalCharged, currency) : MISSING_VALUE
            }
          />
          <Figure
            label="Total paid"
            value={summary ? formatMoney(summary.totalPaid, currency) : MISSING_VALUE}
          />
          {/* Outstanding and credit share a slot: a guest is almost never in both
              states at once, and showing the one that applies keeps the strip to
              six figures. When they somehow are, outstanding wins the slot and
              the ledger's foot shows both. */}
          {summary && summary.outstanding === 0 && summary.creditBalance > 0 ? (
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
              tone={summary && summary.outstanding > 0 ? 'negative' : 'positive'}
            />
          )}
        </div>
      </section>

      <PreferencesCard
        guest={guest}
        tenantId={tenantId}
        canEdit={canEdit}
        onSaved={onGuestChanged}
      />

      <section aria-labelledby="guest-stays-heading" className="space-y-3">
        <h2
          id="guest-stays-heading"
          className="text-lg font-bold tracking-tight text-charcoal"
        >
          Stays
        </h2>
        <GuestStaysTable
          rows={stays}
          currency={currency}
          loading={loading}
          onOpenStay={onOpenStay}
        />
        {/* Says out loud why a "Settled" stay can still show a balance, so the
            two columns never read as a contradiction (rule 16's spirit). */}
        <p className="text-xs text-charcoal-muted">
          <strong className="font-semibold text-charcoal">Balance</strong> is that
          stay's own folio.{' '}
          <strong className="font-semibold text-charcoal">Settlement</strong> is
          the guest-level position: their payments are applied to their oldest
          unpaid stay first, and one payment can settle several stays. So a stay
          can read “Settled” while its own folio still shows money — the payment
          that settled it was taken against a later stay. The two always agree in
          total: the balances above add up to the outstanding figure on the
          ledger.
        </p>
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
      >
        {value}
      </p>
    </div>
  );
}

// PREFERENCES (2.txt §1) — free text, captured and displayed, read by no logic.
//
// It saves through updateGuestPreferences, which patches the ONE column under the
// same admin-only `guests_member_update` policy every other guest correction uses
// (014). A front-desk user is shown the value and told who can change it, rather
// than being offered a Save the database would refuse — the same pattern as the
// booking page's Guest Details tab.
function PreferencesCard({
  guest,
  tenantId,
  canEdit,
  onSaved,
}: {
  guest: Guest;
  tenantId: string;
  canEdit: boolean;
  onSaved: () => Promise<void> | void;
}) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  function startEditing() {
    setDraft(guest.preferences ?? '');
    setEditing(true);
  }

  async function save() {
    if (saving) return;
    setSaving(true);
    try {
      await updateGuestPreferences(guest.id, tenantId, draft);
      toast.success('Preferences saved.');
      setEditing(false);
      await onSaved();
    } catch (e) {
      // Rule 11: surfaced, never swallowed.
      toast.error(humanizeError(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section
      aria-labelledby="guest-preferences-heading"
      className="rounded-2xl border border-sand-border bg-white/60 p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2
          id="guest-preferences-heading"
          className="text-sm font-bold tracking-tight text-charcoal"
        >
          Preferences
        </h2>
        {canEdit ? (
          editing ? (
            <div className="flex items-center gap-2 print:hidden">
              <button
                type="button"
                onClick={() => setEditing(false)}
                disabled={saving}
                className="rounded-full border border-sand-border bg-white/70 px-3 py-1.5 text-xs font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void save()}
                disabled={saving}
                className="rounded-full bg-accent px-4 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-cream disabled:cursor-not-allowed disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={startEditing}
              className="rounded-full border border-sand-border bg-white/70 px-3 py-1.5 text-xs font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream print:hidden"
            >
              {guest.preferences ? 'Edit' : 'Add preferences'}
            </button>
          )
        ) : (
          <span className="text-xs text-charcoal-muted">
            Read-only — an owner or manager can change these.
          </span>
        )}
      </div>

      {editing ? (
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={saving}
          rows={3}
          aria-label="Guest preferences"
          placeholder="Top floor, quiet room, early breakfast…"
          className={`mt-2 ${controlClasses}`}
        />
      ) : (
        <p className="mt-2 whitespace-pre-wrap text-sm text-charcoal">
          {guest.preferences?.trim() ? guest.preferences : MISSING_VALUE}
        </p>
      )}
    </section>
  );
}
