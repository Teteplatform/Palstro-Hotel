import {
  fetchFolioCharges,
  fetchFolioChargeTaxes,
  fetchFolioForBooking,
  fetchFolioPayments,
  fetchFolioTotals,
} from './folio';
import {
  assembleStatement,
  fetchStandaloneFolioForGuest,
  fetchStatementBranding,
  type StatementData,
} from './statement';
import { fetchBookingDetail } from './bookings';
import { fetchGuestById } from './guests';
import { todayIsoInZone } from './date';
import type { Property } from '../types/tenant';

// READING ONE STATEMENT, ONCE, FOR EVERY SURFACE THAT NEEDS IT.
//
// This was the body of useStatement's effect. It moved here the moment the
// exports arrived, because a PDF can now be asked for from the stay page and
// from the guest's home — surfaces that never render the document and have no
// business mounting a hook to fetch it. One loader means the file a guest is
// sent from the stays list is assembled by exactly the same code as the page the
// desk is looking at.
//
// IT ADDS NO READ THAT DID NOT ALREADY EXIST: the folio reads are lib/folio's
// (shared with FolioBill), the booking read lib/bookings', the guest read
// lib/guests'. Only two are the statement's own — the read-only lookup of a
// guest's standalone folio, and the branding the letterhead needs.
//
// NOTHING IS CACHED (rule 6). Every call re-reads folio_totals and the lines
// from scratch; there is no local arithmetic on any balance and no patching.

export type StatementTarget =
  | { kind: 'stay'; bookingId: string }
  | { kind: 'standalone'; guestId: string };

export type StatementMissing =
  // The booking / guest id does not resolve in this tenant + property.
  | 'subject'
  // The subject resolved but has no folio. Benign for a standalone account,
  // a fault for a stay — the CALLER draws that distinction, because it is the
  // one that knows which document was asked for.
  | 'folio'
  // folio_totals returned no row. Should be impossible; never defaulted to zero.
  | 'totals';

// Exactly one of the two is set. "Not found" is deliberately NOT an error: a
// guest who never had a bar tab has no standalone folio, and the honest answer
// is "there is nothing to print", not a red failure panel. A thrown error is a
// real failure and is left to the caller (rule 11: surfaced, never swallowed).
export interface StatementLoadResult {
  statement: StatementData | null;
  missing: StatementMissing | null;
}

export async function loadStatement(
  target: StatementTarget,
  property: Property,
): Promise<StatementLoadResult> {
  const tenantId = property.tenant_id;
  const propertyId = property.id;
  const subjectId = target.kind === 'stay' ? target.bookingId : target.guestId;

  // --- The subject: a stay, or a guest's non-resident account --------------
  const booking =
    target.kind === 'stay'
      ? await fetchBookingDetail(subjectId, tenantId, propertyId)
      : null;
  if (target.kind === 'stay' && !booking) {
    return { statement: null, missing: 'subject' };
  }

  // A stay statement names the guest from the BOOKING's own embed — the same row
  // the stay page and the folio bill read, so the document cannot disagree with
  // the stay it heads, and no second query is spent on three fields already in
  // hand. A standalone statement has no booking, so it reads the guest row:
  // guests are TENANT-scoped, not property-scoped (014), and the property filter
  // belongs on their MONEY, which every folio read below carries.
  const guestId = target.kind === 'stay' ? (booking?.guest?.id ?? null) : subjectId;
  const guest =
    target.kind === 'stay'
      ? (booking?.guest ?? null)
      : await fetchGuestById(subjectId, tenantId);
  if (!guestId || !guest) return { statement: null, missing: 'subject' };

  // --- The folio -----------------------------------------------------------
  const folio =
    target.kind === 'stay'
      ? await fetchFolioForBooking(subjectId, tenantId, propertyId)
      : await fetchStandaloneFolioForGuest(guestId, tenantId, propertyId);
  if (!folio) return { statement: null, missing: 'folio' };

  // --- Its lines, its tax and its totals, in one pass (never N+1) ----------
  const [charges, payments, chargeTaxes, totals, branding] = await Promise.all([
    fetchFolioCharges(folio.id, tenantId, propertyId),
    fetchFolioPayments(folio.id, tenantId, propertyId),
    fetchFolioChargeTaxes(folio.id, tenantId, propertyId),
    fetchFolioTotals(folio.id),
    fetchStatementBranding(propertyId, tenantId),
  ]);

  if (!totals) return { statement: null, missing: 'totals' };

  return {
    statement: assembleStatement({
      property,
      branding: branding.branding,
      logoUrl: branding.logoUrl,
      // The PROPERTY's operating day (rules 8, 12), not the browser's calendar:
      // a statement produced at 00:30 in Lagos belongs to the day the desk is
      // still working, and a colleague reading it from another timezone must see
      // the same date.
      issueDate: todayIsoInZone(property.timezone),
      guest,
      booking,
      folio,
      charges,
      payments,
      chargeTaxes,
      totals,
    }),
    missing: null,
  };
}
