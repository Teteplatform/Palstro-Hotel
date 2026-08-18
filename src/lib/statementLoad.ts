import {
  fetchFolioCharges,
  fetchFolioChargeTaxes,
  fetchFolioForBooking,
  fetchFolioPayments,
  fetchFolioTotals,
} from './folio';
import { supabase } from './supabase';
import { passthrough } from './rowParse';
import { assembleStatement, type StatementData } from './statement';
import { fetchBookingDetail } from './bookings';
import { fetchGuestById } from './guests';
import { brandingString } from './branding';
import { fetchPropertyMedia } from './mediaAssets';
import { buildMediaMap, mediaUrl } from './mediaUrl';
import { todayIsoInZone } from './date';
import type { Folio } from '../types/folio';
import type { Property, PropertyBranding, PropertySettings } from '../types/tenant';

// The boundaries (rule 24). None of these three reads carries a numeric column —
// a folio holds no balance (021 §5), and the other two select one text field
// each — and they are declared anyway, because a read exempted by judgement is
// how the next one gets missed.
const folios = passthrough<Folio>('folios (standalone)');
const guestIds = passthrough<{ guest_id: string | null }>('bookings (guest id)');
const brandingRows = passthrough<Pick<PropertySettings, 'branding'>>(
  'property_settings (branding)',
);

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
//
// THIS IS THE BROWSER'S LOADER, AND THE ONLY ONE THAT MAY TOUCH lib/supabase.
// The email endpoint (api/statements/email.ts) needs the same StatementSource
// from a Node process holding the caller's JWT, and lib/supabase is a browser
// singleton built from import.meta.env — so api/_lib/statementSource.ts restates
// these reads against a request-scoped client. THE TWO MUST STAY IN STEP: any
// filter added or removed below belongs there too, and vice versa. What is NOT
// duplicated is the part that decides what the document says — assembleStatement
// and the PDF definition are imported by both, so the emailed bill and the
// downloaded one cannot disagree on a single figure.

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

// ---------------------------------------------------------------------------
// Reads the statement needs that no other helper covers
// ---------------------------------------------------------------------------
// Both moved here from lib/statement.ts when the email endpoint arrived: that
// file is now compiled into a Node function as well as into the browser, and it
// may no longer import lib/supabase (see its header).

// The guest's ONE standalone (non-resident) folio at this property, READ ONLY.
//
// Deliberately NOT open_guest_folio (lib/guestLedger): that is a get-or-create,
// and opening a folio as a side effect of viewing a document would be a write
// performed by a read. A guest with no non-resident tab has no statement to
// print, and null is exactly that answer.
//
// `booking_id is null` is the discriminator 028 §1's folios_owner_check
// guarantees: exactly one of booking_id / guest_id is set, and the partial
// unique index folios_guest_standalone_uniq makes a second one impossible — so
// maybeSingle() cannot throw on multiple rows.
export async function fetchStandaloneFolioForGuest(
  guestId: string,
  tenantId: string,
  propertyId: string,
): Promise<Folio | null> {
  const { data, error } = await supabase
    .from('folios')
    .select('*')
    .eq('guest_id', guestId)
    .is('booking_id', null)
    .eq('tenant_id', tenantId) // rule 19
    .eq('property_id', propertyId) // rule 19
    .maybeSingle();

  if (error) throw error;
  return folios.maybeRow(data);
}

// WHOSE record a statement belongs to. A standalone statement IS a guest's
// account, so the target already carries it; a stay statement's guest is the
// booking's, and the assembled document deliberately does not carry the id (it
// prints a name, not a key — see lib/statement's rule that every field is
// something a reader sees).
//
// Read only when something needs to WRITE to that guest — today, saving a
// corrected email address from the send dialog — so the common path spends
// nothing. Scoped to the tenant and property (rule 19), live rows only (rule 5).
export async function resolveStatementGuestId(
  target: StatementTarget,
  tenantId: string,
  propertyId: string,
): Promise<string | null> {
  if (target.kind === 'standalone') return target.guestId;

  const { data, error } = await supabase
    .from('bookings')
    .select('guest_id')
    .eq('id', target.bookingId)
    .eq('tenant_id', tenantId) // rule 19
    .eq('property_id', propertyId) // rule 19
    .is('deleted_at', null) // rule 5
    .maybeSingle();

  if (error) throw error;
  return guestIds.maybeRow(data)?.guest_id ?? null;
}

export interface StatementBranding {
  branding: PropertyBranding;
  logoUrl: string | null;
}

// The property's branding plus its logo resolved to a printable URL.
//
// The 'card' variant, not usePropertyLogo's 'thumb': that hook feeds a 64px
// sidebar brand, and a thumb enlarged into a document header prints soft. Card
// is the smallest variant that survives A4 (§ storage: one id resolves to any
// variant, so this costs no extra row — mediaUrl derives the sibling path).
//
// A failure here is NOT swallowed the way usePropertyLogo swallows it: the
// sidebar logo is chrome, but this is the letterhead of a document the guest
// keeps, and a header that silently loses the hotel's identity is worth
// surfacing. The caller decides whether to block on it.
export async function fetchStatementBranding(
  propertyId: string,
  tenantId: string,
): Promise<StatementBranding> {
  const [settingsRes, mediaRows] = await Promise.all([
    supabase
      .from('property_settings')
      .select('branding')
      .eq('property_id', propertyId)
      .maybeSingle(),
    fetchPropertyMedia(propertyId, tenantId),
  ]);
  if (settingsRes.error) throw settingsRes.error;

  const branding: PropertyBranding =
    brandingRows.maybeRow(settingsRes.data)?.branding ?? {};
  const logoId = brandingString(branding, 'logo_url');
  return {
    branding,
    // null — never a broken image — when no logo is set or the stored id is
    // dangling. The renderer falls back to the property name as a wordmark.
    logoUrl: mediaUrl(buildMediaMap(mediaRows), logoId, 'card'),
  };
}
