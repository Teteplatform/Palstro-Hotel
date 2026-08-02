import { useCallback, useEffect, useState } from 'react';
import { useToast } from '../ui/Toast';
import { describeError, humanizeError } from '../../lib/errors';
import {
  acknowledgeBookingFollowUp,
  fetchOpenFollowUps,
  type BookingFollowUp,
} from '../../lib/bookings';

// THE FRONT-DESK FOLLOW-UP NOTICE (migration 029 §1, §3).
//
// WHAT IT IS: when the night audit no-shows a CORPORATE booking, it also charges
// the company one night — and then the room is released and can be sold to
// somebody else within the hour. That is correct for the room and wrong for the
// relationship: a company whose flight was delayed, or who meant to extend, finds
// out by being billed and by losing the room. So the audit leaves a notice
// naming the room, the dates and the company, and asking the desk to call.
//
// WHAT IT IS NOT: a lock. The room is ALREADY free — count_available releases a
// no_show since 029 §2 — and nothing here blocks a booking, a check-in or a sale.
// Anything stronger would put us back in the state the auto-resolve pass exists
// to end: a room held indefinitely on nobody's decision.
//
// DISMISSAL IS ACCOUNTABLE. acknowledge_booking_follow_up records WHO cleared it
// and WHEN, and is idempotent by state so the first person to deal with it stays
// on the record. A reminder nobody is answerable for is a reminder that gets
// clicked away unread.
//
// SELF-CONTAINED, like FolioBill and GuestLedger: it takes a scope and loads,
// renders and clears its own rows, so the bookings list and the guest home both
// get it by mounting it — with no duplicated fetch, no duplicated copy and no
// chance of the two disagreeing about what is outstanding.
//
// IT RENDERS NOTHING WHEN THERE IS NOTHING, including while loading and on a
// failed read (the failure is surfaced, quietly, rather than as an empty alert
// box that looks like a bug). A healthy property sees no chrome at all.

interface FollowUpNoticesProps {
  tenantId: string;
  propertyId: string;
  // Narrow to one guest (the guest home). Omitted on the bookings list, which
  // shows every outstanding follow-up at the property.
  guestId?: string;
  // Let the surrounding screen re-read anything the acknowledgement affects.
  // Optional: nothing here changes money or availability.
  onAcknowledged?: () => void;
}

export function FollowUpNotices({
  tenantId,
  propertyId,
  guestId,
  onAcknowledged,
}: FollowUpNoticesProps) {
  const toast = useToast();
  const [rows, setRows] = useState<BookingFollowUp[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await fetchOpenFollowUps(tenantId, propertyId, guestId);
      setRows(next);
      setError(null);
    } catch (e) {
      // Rule 11: not swallowed. But a reminder surface must not turn a read
      // failure into a scary empty banner, so it degrades to a single quiet line.
      setError(describeError(e));
    }
  }, [tenantId, propertyId, guestId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (cancelled) return;
      await load();
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  async function acknowledge(row: BookingFollowUp) {
    if (busyId) return;
    setBusyId(row.booking_id);
    try {
      // Awaited, and the list is RE-READ rather than patched locally — the same
      // discipline every other mutation surface follows.
      await acknowledgeBookingFollowUp(row.booking_id);
      toast.success('Follow-up acknowledged.');
      await load();
      onAcknowledged?.();
    } catch (e) {
      // Rule 11: the RPC's own words.
      toast.error(humanizeError(e));
    } finally {
      setBusyId(null);
    }
  }

  if (error) {
    return (
      <p className="text-xs text-charcoal-muted">
        Follow-up reminders could not be loaded. {error}
      </p>
    );
  }

  if (rows.length === 0) return null;

  return (
    <section
      aria-label="Front-desk follow-ups"
      className="space-y-2 print:hidden"
    >
      {rows.map((row) => (
        <div
          key={row.booking_id}
          // role=status, not alert: this reports something that already happened
          // and needs a phone call, so a screen reader announces it without
          // interrupting what the user is doing.
          role="status"
          className="flex flex-col gap-2 rounded-2xl border-2 border-primary/50 bg-primary/5 px-4 py-3 sm:flex-row sm:items-start sm:justify-between"
        >
          <div className="min-w-0">
            <p className="text-sm font-bold text-charcoal">
              Call before releasing this room
            </p>
            {/* The stored sentence, printed as it was composed — room type,
                dates and company all from the booking's own rows (rule 17). */}
            <p className="mt-0.5 text-sm text-charcoal">{row.note}</p>
            <p className="mt-0.5 text-xs text-charcoal-muted">
              {row.booking_number} · charged one night as a no-show
            </p>
          </div>
          <button
            type="button"
            onClick={() => void acknowledge(row)}
            disabled={busyId !== null}
            className="shrink-0 self-start rounded-full border border-sand-border bg-white/80 px-4 py-1.5 text-xs font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busyId === row.booking_id ? 'Saving…' : 'Acknowledge'}
          </button>
        </div>
      ))}
    </section>
  );
}
