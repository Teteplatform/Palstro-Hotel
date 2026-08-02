import { useCallback, useEffect, useState } from 'react';
import {
  fetchFolioCharges,
  fetchFolioChargeTaxes,
  fetchFolioForBooking,
  fetchFolioPayments,
  fetchFolioTotals,
} from '../lib/folio';
import {
  assembleStatement,
  fetchStandaloneFolioForGuest,
  fetchStatementBranding,
  type StatementData,
} from '../lib/statement';
import { fetchBookingDetail } from '../lib/bookings';
import { fetchGuestById } from '../lib/guests';
import { todayIsoInZone } from '../lib/date';
import type { Property } from '../types/tenant';

// Loads everything the guest-facing statement prints, as ONE consistent
// snapshot, and hands the assembled document to the renderer.
//
// IT ADDS NO READ THAT DID NOT ALREADY EXIST. The folio reads are lib/folio's,
// unchanged and shared with FolioBill; the booking read is lib/bookings'; the
// guest read is lib/guests'. Only two are new (lib/statement): the READ-ONLY
// lookup of a guest's standalone folio, and the branding + logo the letterhead
// needs. So the statement cannot show a figure the internal bill does not — the
// same rows, assembled for a different reader.
//
// NOTHING IS CACHED (rule 6). There is no local arithmetic on any balance and
// no patching: reload() re-reads folio_totals and the lines from scratch, the
// same contract useFolio keeps.
//
// TWO TARGETS, ONE HOOK:
//   { kind: 'stay', bookingId }        — the booking's folio (021 §4.1 opens one
//                                        for every booking).
//   { kind: 'standalone', guestId }    — the guest's non-resident folio (028 §2),
//                                        which may legitimately not exist.
//
// "NOT FOUND" IS NOT AN ERROR, AND THE TWO ARE KEPT APART. A guest who never had
// a bar tab has no standalone folio, and the honest answer is "there is nothing
// to print" — not a red failure panel. A BOOKING with no folio, by contrast, is
// a genuine fault (the trigger opens one for every booking), and the screen says
// so rather than rendering a convincing ₦0.00.

export type StatementTarget =
  | { kind: 'stay'; bookingId: string }
  | { kind: 'standalone'; guestId: string };

export type StatementMissing =
  // The booking / guest id does not resolve in this tenant + property.
  | 'subject'
  // The subject resolved but has no folio. Benign for a standalone account,
  // a fault for a stay — the SCREEN draws that distinction, because it is the
  // one that knows which document was asked for.
  | 'folio'
  // folio_totals returned no row. Should be impossible; never defaulted to zero.
  | 'totals';

export interface UseStatementResult {
  statement: StatementData | null;
  // Set when the document could not be built for a structural reason rather
  // than a failure. Exactly one of `statement`, `missing` and `error` is
  // meaningful once loading is false.
  missing: StatementMissing | null;
  loading: boolean;
  // The RAW error, preserved for describeError (rule 11) — a PostgREST error is
  // a plain object, and wrapping it in new Error(String(e)) yields
  // "[object Object]".
  error: unknown;
  reload: () => void;
}

export function useStatement(
  target: StatementTarget,
  property: Property,
): UseStatementResult {
  const [statement, setStatement] = useState<StatementData | null>(null);
  const [missing, setMissing] = useState<StatementMissing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  // Destructured so the effect depends on stable primitives rather than on the
  // `target` and `property` object identities, which a parent re-render remints.
  const kind = target.kind;
  const subjectId = target.kind === 'stay' ? target.bookingId : target.guestId;
  const tenantId = property.tenant_id;
  const propertyId = property.id;

  useEffect(() => {
    let cancelled = false;

    (async () => {
      setLoading(true);
      try {
        // --- The subject: a stay, or a guest's non-resident account ---------
        const booking =
          kind === 'stay'
            ? await fetchBookingDetail(subjectId, tenantId, propertyId)
            : null;
        if (cancelled) return;

        if (kind === 'stay' && !booking) {
          setStatement(null);
          setMissing('subject');
          setError(null);
          return;
        }

        // A stay statement names the guest from the BOOKING's own embed — the
        // same row the stay page and the folio bill read, so the document
        // cannot disagree with the stay it heads, and no second query is spent
        // on three fields already in hand. A standalone statement has no
        // booking, so it reads the guest row: guests are TENANT-scoped, not
        // property-scoped (014), and the property filter belongs on their MONEY,
        // which every folio read below carries.
        const guestId = kind === 'stay' ? (booking?.guest?.id ?? null) : subjectId;
        const guest =
          kind === 'stay'
            ? (booking?.guest ?? null)
            : await fetchGuestById(subjectId, tenantId);
        if (cancelled) return;
        if (!guestId || !guest) {
          setStatement(null);
          setMissing('subject');
          setError(null);
          return;
        }

        // --- The folio ------------------------------------------------------
        const folio =
          kind === 'stay'
            ? await fetchFolioForBooking(subjectId, tenantId, propertyId)
            : await fetchStandaloneFolioForGuest(guestId, tenantId, propertyId);
        if (cancelled) return;
        if (!folio) {
          setStatement(null);
          setMissing('folio');
          setError(null);
          return;
        }

        // --- Its lines, its tax and its totals, in one pass (never N+1) -----
        const [charges, payments, chargeTaxes, totals, branding] =
          await Promise.all([
            fetchFolioCharges(folio.id, tenantId, propertyId),
            fetchFolioPayments(folio.id, tenantId, propertyId),
            fetchFolioChargeTaxes(folio.id, tenantId, propertyId),
            fetchFolioTotals(folio.id),
            fetchStatementBranding(propertyId, tenantId),
          ]);
        if (cancelled) return;

        if (!totals) {
          setStatement(null);
          setMissing('totals');
          setError(null);
          return;
        }

        setStatement(
          assembleStatement({
            property,
            branding: branding.branding,
            logoUrl: branding.logoUrl,
            // The PROPERTY's operating day (rules 8, 12), not the browser's
            // calendar: a statement produced at 00:30 in Lagos belongs to the
            // day the desk is still working, and a colleague reading it from
            // another timezone must see the same date.
            issueDate: todayIsoInZone(property.timezone),
            guest,
            booking,
            folio,
            charges,
            payments,
            chargeTaxes,
            totals,
          }),
        );
        setMissing(null);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        // Rule 11: kept raw and surfaced, never swallowed.
        setStatement(null);
        setMissing(null);
        setError(e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // `property` is a dependency and is safe as one: useActiveProperty returns
    // an ELEMENT of the provider's properties array, so its identity is stable
    // across re-renders and changes only when that list is genuinely refetched —
    // at which point re-reading the document is the correct behaviour.
  }, [kind, subjectId, tenantId, propertyId, property, nonce]);

  return { statement, missing, loading, error, reload };
}
