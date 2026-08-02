import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAllPaged } from '../../src/lib/fetchAllPaged';
import { assembleStatement, type StatementData } from '../../src/lib/statement';
import { todayIsoInZone } from '../../src/lib/date';
import type { BookingDetail } from '../../src/types/booking';
import type { Guest } from '../../src/types/guest';
import type {
  Folio,
  FolioChargeTaxRow,
  FolioChargeWithCategory,
  FolioPayment,
  FolioTotals,
} from '../../src/types/folio';
import type { Property, PropertyBranding, PropertySettings } from '../../src/types/tenant';

// ============================================================================
// THE STATEMENT, READ AND ASSEMBLED ON THE SERVER
// ============================================================================
//
// The emailed PDF is generated here, from the database, and NOT from anything
// the browser sent. The request carries ids and an address — never a figure,
// never a line, never a total. A staff member who edited the page in front of
// them, or a script that posted a hand-written body to this endpoint, cannot
// change one number on the bill that reaches the guest: everything printed is
// re-read here under that caller's own RLS and re-assembled by
// assembleStatement, the same function the screen renders from.
//
// ----------------------------------------------------------------------------
// WHAT IS SHARED WITH THE BROWSER, AND WHAT IS RESTATED — HONESTLY
// ----------------------------------------------------------------------------
// SHARED, imported verbatim from src/ so there can only ever be one of each:
//   * assembleStatement — what the document SAYS (lib/statement.ts);
//   * buildStatementPdfDefinition — what the page LOOKS LIKE
//     (lib/export/statementPdfDefinition.ts);
//   * the formatters, the nights logic, the labels, fetchAllPaged.
//
// RESTATED below: the SELECTs. lib/folio.ts, lib/bookings.ts and
// lib/statementLoad.ts all bind to lib/supabase — a browser singleton built from
// import.meta.env — so they cannot be imported into a Node process at all, and
// parameterising every one of them on a client would have meant editing the
// hottest data paths in the app to serve one endpoint. The queries below are
// therefore the same queries written against a request-scoped client.
//
// THE COST IS REAL AND IT IS BOUNDED: if the two drift, the emailed statement
// and the screen could show different LINES (never different arithmetic — the
// totals are folio_totals' either way, and the tax lines are the database's
// view). lib/statementLoad.ts carries the matching warning. When you change a
// filter in one, change it in the other.
//
// Rules kept, one by one:
//   * Rule 1a — every list read goes through fetchAllPaged. A bill must show
//     EVERY line; a capped read would email a guest a shorter bill than the desk
//     is looking at.
//   * Rule 19 — every read is scoped to the tenant AND the property on top of
//     RLS, and the tenant is DERIVED from the property row, never taken from the
//     request.
//   * Rule 5 — soft-deleted rows are filtered NULL-safe; voided lines are
//     dropped by assembleStatement exactly as they are for the screen.
//   * Rule 6 — nothing is cached. Every send re-reads folio_totals.

// Mirrors lib/statementLoad.ts's StatementTarget. Restated rather than imported
// because that module imports lib/supabase (see above).
export type EmailStatementTarget =
  | { kind: 'stay'; bookingId: string }
  | { kind: 'standalone'; guestId: string };

export type StatementMissing = 'property' | 'subject' | 'folio' | 'totals';

export interface LoadedStatement {
  property: Property;
  branding: PropertyBranding;
  statement: StatementData;
  // Carried out for the audit row, so the send is recorded against the same
  // subject the document was built from rather than against what was requested.
  bookingId: string | null;
  guestId: string;
}

export type LoadStatementResult =
  | { ok: true; loaded: LoadedStatement }
  | { ok: false; missing: StatementMissing };

// The booking embed the statement needs. MIRRORS lib/bookings.ts's DETAIL_SELECT
// minus booking_nights, which no statement prints — the per-night breakdown is
// an internal working, and the guest's bill shows the room charges the folio
// actually posted.
const BOOKING_SELECT =
  '*, guest:guests(id, first_name, last_name, middle_name, full_name, phone, email, nationality, id_type, id_number, id_expiry, preferences), room_type:room_types(name, max_adults, max_children), company:companies(name)';

export async function loadStatementForEmail(
  supabase: SupabaseClient,
  propertyId: string,
  target: EmailStatementTarget,
): Promise<LoadStatementResult> {
  // --- The property. RLS admits it only for a member of its tenant, and the
  // tenant every later read is scoped to comes from THIS row (rule 19).
  const propertyRes = await supabase
    .from('properties')
    .select('*')
    .eq('id', propertyId)
    .is('deleted_at', null) // rule 5
    .maybeSingle();
  if (propertyRes.error) throw propertyRes.error;
  const property = (propertyRes.data ?? null) as Property | null;
  if (!property) return { ok: false, missing: 'property' };

  const tenantId = property.tenant_id;

  // --- The subject: a stay, or a guest's non-resident account --------------
  let booking: BookingDetail | null = null;
  if (target.kind === 'stay') {
    const res = await supabase
      .from('bookings')
      .select(BOOKING_SELECT)
      .eq('id', target.bookingId)
      .eq('tenant_id', tenantId) // rule 19
      .eq('property_id', propertyId) // rule 19
      .is('deleted_at', null) // rule 5
      .maybeSingle();
    if (res.error) throw res.error;
    if (!res.data) return { ok: false, missing: 'subject' };
    booking = res.data as unknown as BookingDetail;
  }

  // A stay statement names the guest from the BOOKING's own embed — the same row
  // the stay page reads, so the document cannot disagree with the stay it heads.
  // A standalone statement reads the guest row; guests are TENANT-scoped (014),
  // and the property filter belongs on their money, which every folio read below
  // carries.
  let guestId: string | null;
  let guest: Pick<Guest, 'full_name' | 'phone' | 'email'> | null;
  if (target.kind === 'stay') {
    guestId = booking?.guest?.id ?? null;
    guest = booking?.guest ?? null;
  } else {
    guestId = target.guestId;
    const res = await supabase
      .from('guests')
      .select('full_name, phone, email')
      .eq('id', target.guestId)
      .eq('tenant_id', tenantId) // rule 19
      .is('deleted_at', null) // rule 5
      .maybeSingle();
    if (res.error) throw res.error;
    guest = (res.data ?? null) as Pick<Guest, 'full_name' | 'phone' | 'email'> | null;
  }
  if (!guestId || !guest) return { ok: false, missing: 'subject' };

  // --- The folio -----------------------------------------------------------
  // For a standalone account this is a READ, never open_guest_folio's
  // get-or-create: emailing a document must not open a folio as a side effect.
  const folioRes =
    target.kind === 'stay'
      ? await supabase
          .from('folios')
          .select('*')
          .eq('booking_id', target.bookingId)
          .eq('tenant_id', tenantId)
          .eq('property_id', propertyId)
          .maybeSingle()
      : await supabase
          .from('folios')
          .select('*')
          .eq('guest_id', guestId)
          .is('booking_id', null)
          .eq('tenant_id', tenantId)
          .eq('property_id', propertyId)
          .maybeSingle();
  if (folioRes.error) throw folioRes.error;
  const folio = (folioRes.data ?? null) as Folio | null;
  if (!folio) return { ok: false, missing: 'folio' };

  // --- Its lines, its tax, its totals and the letterhead, in one pass ------
  const [charges, payments, chargeTaxes, totals, branding] = await Promise.all([
    fetchAllPaged<FolioChargeWithCategory>((from, to) =>
      supabase
        .from('folio_charges')
        // The category embed is NOT deleted_at filtered: a retired category must
        // still label its historical charges (021 §8.1).
        .select('*, category:charge_categories(code, name, is_taxable, service_chargeable)')
        .eq('folio_id', folio.id)
        .eq('tenant_id', tenantId)
        .eq('property_id', propertyId)
        .order('charge_date', { ascending: true }) // rule 8: business date
        .order('created_at', { ascending: true })
        .range(from, to)
        .returns<FolioChargeWithCategory[]>(),
    ),
    fetchAllPaged<FolioPayment>((from, to) =>
      supabase
        .from('folio_payments')
        .select('*')
        .eq('folio_id', folio.id)
        .eq('tenant_id', tenantId)
        .eq('property_id', propertyId)
        .order('payment_date', { ascending: true }) // rule 8
        .order('created_at', { ascending: true })
        .range(from, to)
        .returns<FolioPayment[]>(),
    ),
    fetchAllPaged<FolioChargeTaxRow>((from, to) =>
      supabase
        .from('folio_charge_taxes')
        .select('*')
        .eq('folio_id', folio.id)
        .eq('tenant_id', tenantId)
        .eq('property_id', propertyId)
        .range(from, to)
        .returns<FolioChargeTaxRow[]>(),
    ),
    fetchFolioTotals(supabase, folio.id),
    fetchBranding(supabase, propertyId),
  ]);

  if (!totals) return { ok: false, missing: 'totals' };

  return {
    ok: true,
    loaded: {
      property,
      branding,
      bookingId: booking?.id ?? null,
      guestId,
      statement: assembleStatement({
        property,
        branding,
        // NULL, and deliberately so. logoUrl is what a SCREEN renders the
        // letterhead from; this process renders to PDF, which needs decoded
        // bytes rather than a URL, and it gets them from the caller (see
        // api/_lib/statementLogoServer.ts for why the image is the one part of
        // the document the browser supplies). Reading the media row here would
        // cost a query for a field nothing on this path reads.
        logoUrl: null,
        // The PROPERTY's operating day (rules 8, 12) — not the server's calendar
        // day in whichever region Vercel scheduled this invocation.
        issueDate: todayIsoInZone(property.timezone),
        guest,
        booking,
        folio,
        charges,
        payments,
        chargeTaxes,
        totals,
      }),
    },
  };
}

// folio_totals (021 §8.2) — the engine's own decomposition. Never re-derived
// here, never cached (rule 6).
async function fetchFolioTotals(
  supabase: SupabaseClient,
  folioId: string,
): Promise<FolioTotals | null> {
  const { data, error } = await supabase.rpc('folio_totals', { p_folio_id: folioId });
  if (error) throw error;
  const rows = (data ?? []) as FolioTotals[];
  return rows[0] ?? null;
}

// The property's branding JSONB: the statement's footer note and thank-you line
// (both tenant-authored, rule 17), and the optional per-property sender address
// the email uses when its domain is verified.
async function fetchBranding(
  supabase: SupabaseClient,
  propertyId: string,
): Promise<PropertyBranding> {
  const { data, error } = await supabase
    .from('property_settings')
    .select('branding')
    .eq('property_id', propertyId)
    .maybeSingle<Pick<PropertySettings, 'branding'>>();
  if (error) throw error;
  return data?.branding ?? {};
}
