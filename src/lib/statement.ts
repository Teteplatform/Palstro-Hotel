import { supabase } from './supabase';
import { parseNumeric } from './format';
import { brandingString } from './branding';
import { fetchPropertyMedia } from './mediaAssets';
import { buildMediaMap, mediaUrl } from './mediaUrl';
import { formatPropertyAddress } from './address';
import { paymentMethodLabel } from './folioLabels';
import { describeStayNights } from './stayNights';
import type { Property, PropertyBranding, PropertySettings } from '../types/tenant';
import type { Guest } from '../types/guest';
import type { BookingDetail } from '../types/booking';
import type {
  Folio,
  FolioChargeTaxRow,
  FolioChargeWithCategory,
  FolioPayment,
  FolioTotals,
} from '../types/folio';

// ===========================================================================
// THE GUEST-FACING STATEMENT — DATA ASSEMBLY.
//
// THIS FILE IS THE EXPORT SOURCE OF TRUTH (3.txt: "structure it so the same
// data assembly can be reused by the export build").
// ===========================================================================
//
// assembleStatement() turns the rows the folio engine already returns into ONE
// plain object describing the document. It is pure: no React, no supabase, no
// formatting. The screen renders it; the coming PDF / WhatsApp / Excel / Word
// exporters serialise the SAME object. That is the whole point — a second
// exporter that re-derived "what goes on the bill" from folio rows would be a
// second bill, and the day the two disagreed nothing would error.
//
// SO, TWO RULES FOR ANYONE EXTENDING THIS:
//   1. Everything a reader sees on the statement is a field of StatementData.
//      If the renderer computes it, an exporter cannot reuse it.
//   2. StatementData carries MACHINE values — numbers and 'YYYY-MM-DD' dates,
//      never formatted strings. A spreadsheet needs 130000, not "₦130,000.00";
//      the currency code travels beside the figures so every renderer formats
//      them the same way through lib/format.
//
// ---------------------------------------------------------------------------
// NO MONEY LOGIC LIVES HERE (3.txt constraint, and rule 6)
// ---------------------------------------------------------------------------
// Every figure is the engine's:
//   * the line amounts are folio_charges.net_amount / folio_payments.amount,
//   * the tax lines are the folio_charge_taxes VIEW (022 §1) — folio_charge_tax
//     applied per charge BY THE DATABASE,
//   * subtotal / total charges / payments received / balance are folio_totals
//     (021 §8.2).
// The ONLY arithmetic in this file is grouping the printed per-charge tax
// amounts by tax code so each tax prints once — a sum of the database's own
// numbers whose result is, by folio_totals' own definition, tax_total. Exactly
// what FolioBill does, for the same reason.
//
// ---------------------------------------------------------------------------
// VOIDED LINES ARE ABSENT — AND THE TOTALS STILL RECONCILE
// ---------------------------------------------------------------------------
// A guest never sees a reversed line; the void trail is internal and stays on
// the folio bill, struck through with its reason and actor. Dropping them here
// changes NO printed total, and that is provable rather than hopeful:
//   * folio_totals sums `where is_voided is not true` for both charges and
//     payments (021 §8.2), so a voided row contributes nothing to gross,
//     discount, net, charges_total, payments_total or balance;
//   * folio_charge_tax returns NO rows for a voided charge (021 §8.1: "a void
//     carries no tax"), so the folio_charge_taxes view has no rows for it and
//     the per-code tax lines here cannot include one.
// Therefore Σ printed charge lines = net_total, Σ printed tax lines =
// tax_total, Σ printed payment lines = payments_total, and the printed balance
// is charges_total − payments_total. The document adds up in the guest's hands.
//
// INVARIANT (rule 9): this statement reconciles to folio_totals(folio_id) for
// the folio it was built from, and that folio's balance is one term of the
// guest ledger's own invariant (028: Σ folio balances = the guest's balance).

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

// A stay statement is built from a booking's folio; a standalone statement from
// the guest's non-resident folio (028 §2), which has no booking, no room and no
// nights. One document, two shapes — never two documents.
export type StatementKind = 'stay' | 'standalone';

// Which side of zero the balance falls on. The WORD is the load-bearing part:
// the statement must be readable in black and white (3.txt), so the state is
// printed in words and colour only reinforces it.
export type StatementBalanceState = 'due' | 'settled' | 'credit';

export interface StatementProperty {
  name: string;
  // One composed line, or null when the property has no real locality set.
  address: string | null;
  phone: string | null;
  email: string | null;
  // Resolved logo URL ('card' variant — a printed header needs more than the
  // sidebar's thumb), or null: no logo set, or the stored id is dangling. The
  // renderer falls back to the name as a wordmark, never a broken image.
  logoUrl: string | null;
  currency: string;
}

export interface StatementGuest {
  name: string;
  phone: string | null;
  email: string | null;
}

// Who the bill is addressed to when that is NOT the guest — a corporate booking
// billed to the company (bookings.bill_to = 'company'). Null on a guest-billed
// stay, where the guest block already says who is being billed.
export interface StatementBillTo {
  name: string;
}

export interface StatementStay {
  roomTypeName: string | null;
  // The window the folio BILLS: from the recorded arrival once checked in,
  // from the reserved check-in before that (lib/stayNights, which transcribes
  // run_night_audit's own predicate). checkOut is the reserved departure.
  checkIn: string;
  checkOut: string;
  // True once an arrival has actually been recorded, so the renderer can label
  // the dates honestly ("arrived" vs "arriving").
  arrived: boolean;
  // What is billed. reservedNights is carried ONLY when it differs — printing
  // the same number twice invents a distinction that is not there.
  nights: number;
  reservedNights: number | null;
}

// One printed line — and one row of the coming export. Plain strings and
// numbers by construction: this array is what a CSV/XLSX writer serialises.
export interface StatementLine {
  key: string;
  // A printed line number, continuous within its section, so a guest can ring
  // the desk and say "line 4".
  sn: number;
  // The BUSINESS date (rules 8, 12) — charge_date / payment_date, never
  // created_at. No "posted on" here: which operating day the desk keyed a line
  // is an internal audit fact, and the guest's document says when it happened.
  date: string;
  // The tenant's own word for the category (rule 17), or the payment method.
  type: string;
  // The item detail. May be '' — the RENDERER supplies MISSING_VALUE, so an
  // exported cell is empty rather than carrying a dash meant for a screen.
  description: string;
  // Signed exactly as the engine stores it: a refund is a negative payment.
  amount: number;
}

// Charges, split into the sections a guest expects to read: what the room cost,
// and what else was signed for.
export interface StatementGroup {
  key: 'room' | 'extras' | 'charges';
  label: string;
  lines: StatementLine[];
}

export interface StatementTaxLine {
  code: string;
  name: string;
  // numeric(5,4) as the DB stores it: a FRACTION ('0.0750' = 7.5%). Kept raw so
  // the renderer formats it through formatRatePercent like everywhere else.
  rate: string;
  amount: number;
}

// Every figure below is folio_totals'. `discount` and `gross` are carried so a
// bill that gave something away can show it — a guest who negotiated a rate
// should see the reduction on their own bill — and are simply not rendered when
// nothing was discounted.
export interface StatementTotals {
  gross: number;
  discount: number;
  subtotal: number;
  taxes: StatementTaxLine[];
  charges: number;
  payments: number;
  balance: number;
}

export interface StatementData {
  kind: StatementKind;
  property: StatementProperty;
  // "Statement" — one adaptive document, not an invoice and a receipt (3.txt).
  title: string;
  // The document's handle and what to call it. A stay carries its booking
  // number (015's per-tenant document numbering). A standalone folio has NO
  // document number in the schema, so it carries a short reference derived from
  // the folio id — see buildReference for why nothing is generated here.
  reference: string;
  referenceLabel: string;
  // The property's operating day this was produced on (rules 8, 12) — not the
  // browser's date.
  issueDate: string;
  guest: StatementGuest;
  billTo: StatementBillTo | null;
  // Null on a standalone statement: there is no stay to describe.
  stay: StatementStay | null;
  groups: StatementGroup[];
  payments: StatementLine[];
  totals: StatementTotals;
  balance: {
    // Always folio_totals.balance, unmodified. The renderer shows its magnitude
    // beside the state's own word; it never re-signs or re-derives it.
    amount: number;
    state: StatementBalanceState;
  };
  footer: {
    thankYou: string;
    // The property's own note (payment terms, bank details), or null.
    note: string | null;
  };
}

// The raw material: everything assembleStatement needs, and nothing it does not.
// Gathered by useStatement from reads that already existed.
export interface StatementSource {
  property: Property;
  branding: PropertyBranding;
  logoUrl: string | null;
  // The property's today (todayIsoInZone) — the operating day, not the browser's.
  issueDate: string;
  // Only the three fields the document prints, so a STAY statement can name the
  // guest from the booking's own embed (which cannot disagree with the stay it
  // heads, and costs no extra read) while a standalone one supplies the guest
  // row. A full Guest here would force a second query for no printed value.
  guest: Pick<Guest, 'full_name' | 'phone' | 'email'>;
  // Null for a standalone folio.
  booking: BookingDetail | null;
  folio: Folio;
  charges: FolioChargeWithCategory[];
  payments: FolioPayment[];
  chargeTaxes: FolioChargeTaxRow[];
  // Null only if folio_totals returned nothing, which should be impossible. The
  // caller treats it as a fault rather than printing a confident zero, so this
  // is never silently defaulted here either.
  totals: FolioTotals;
}

// ---------------------------------------------------------------------------
// Branding keys the statement reads
// ---------------------------------------------------------------------------
// Both optional, both freeform strings on property_settings.branding, both
// tenant-authored so no copy on the printed page is invented here (rule 17)
// beyond a neutral fallback.
//
// ⚠ BRANDING IS PUBLICLY READABLE. property_settings carries a public (anon)
// read policy for the guest site, and RLS is row-level — it cannot hide a
// column. So a note placed here is world-readable. Bank details and payment
// terms are printed on the bill the guest walks out with anyway, so that is an
// acceptable home for THIS note; anything genuinely private belongs on
// property_finance_settings (member-read only, 021 §3), which would need a
// migration and is deliberately out of scope for a render-only build.
const BRANDING_NOTE_KEY = 'statement_note';
const BRANDING_THANK_YOU_KEY = 'statement_thank_you';

// The neutral fallback when a property has not written its own closing line.
// Not tenant content: it names no hotel, no place and no product, exactly as
// format.ts's "adult"/"children" do not.
const DEFAULT_THANK_YOU = 'Thank you for your custom. We look forward to welcoming you again.';

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export function assembleStatement(source: StatementSource): StatementData {
  const { property, booking, folio, totals } = source;
  const kind: StatementKind = booking ? 'stay' : 'standalone';

  // LIVE LINES ONLY. Rule 5's NULL-safe direction for a void: anything not
  // explicitly voided is live, so the test is `!== true`, never `=== false`.
  const liveCharges = source.charges.filter((c) => c.is_voided !== true);
  const livePayments = source.payments.filter((p) => p.is_voided !== true);

  const { groups } = buildChargeGroups(liveCharges, kind);

  const payments = livePayments.map((payment, index) => ({
    key: `payment-${payment.id}`,
    sn: index + 1,
    date: payment.payment_date,
    type: paymentMethodLabel(payment.method),
    // A refund is a negative payment (021 DECISION 3) — the sign carries it,
    // the word stops a guest reading money out as money in.
    description: [
      (parseNumeric(payment.amount) ?? 0) < 0 ? 'Refund' : null,
      payment.reference ? `ref ${payment.reference}` : null,
    ]
      .filter(Boolean)
      .join(' · '),
    amount: parseNumeric(payment.amount) ?? 0,
  }));

  const balance = parseNumeric(totals.balance) ?? 0;

  return {
    kind,
    property: {
      name: property.name,
      address: formatPropertyAddress(property),
      phone: property.phone?.trim() || null,
      email: property.email?.trim() || null,
      logoUrl: source.logoUrl,
      currency: property.currency,
    },
    title: 'Statement',
    ...buildReference(booking, folio),
    issueDate: source.issueDate,
    guest: {
      name: source.guest.full_name,
      phone: source.guest.phone?.trim() || null,
      email: source.guest.email?.trim() || null,
    },
    // A corporate booking is billed to the company, and the document has to say
    // so: the guest slept in the room, the company owes the money.
    billTo:
      booking?.bill_to === 'company' && booking.company
        ? { name: booking.company.name }
        : null,
    stay: booking ? buildStay(booking) : null,
    groups,
    payments,
    totals: {
      gross: parseNumeric(totals.gross_total) ?? 0,
      discount: parseNumeric(totals.discount_total) ?? 0,
      subtotal: parseNumeric(totals.net_total) ?? 0,
      taxes: buildTaxLines(source.chargeTaxes),
      charges: parseNumeric(totals.charges_total) ?? 0,
      payments: parseNumeric(totals.payments_total) ?? 0,
      balance,
    },
    balance: {
      amount: balance,
      // Exact comparisons are safe: every figure is a numeric(14,2) the
      // database rounded, so "zero" here is a real zero and not a float
      // residue. > 0 the guest owes; < 0 the hotel holds their money.
      state: balance > 0 ? 'due' : balance < 0 ? 'credit' : 'settled',
    },
    footer: {
      thankYou:
        brandingString(source.branding, BRANDING_THANK_YOU_KEY) ?? DEFAULT_THANK_YOU,
      note: brandingString(source.branding, BRANDING_NOTE_KEY),
    },
  };
}

// THE ROOM / EXTRAS SPLIT (3.txt: "Grouped (room / extras)").
//
// A NOTE ON THE INTERNAL BILL: FolioBill dropped its Room/Extras headings when
// Type became a column — down a Type column the eye separates Laundry from
// Buffet, which "Extras" never could. That is right for STAFF, who are reading
// an itemised working document. It is not right for a GUEST, who reads a bill
// as two questions: what did the room cost, and what else did I sign for. So
// the grouping lives here, on the guest document, and the Type column carries
// the detail inside each group. Both surfaces still print the same lines, in the
// same order, from the same rows.
//
// THE SPLIT IS BY CATEGORY CODE, NOT BY PROVENANCE. charge_categories.code
// 'room' is the tenant's room category (seeded by 021 §2 and the one
// post_room_night_charge resolves); folio_charges.source records WHO posted the
// line ('room' at night audit, 'manual' at the desk). A late-checkout fee keyed
// by the desk under the Room category is a room charge to the guest reading the
// bill, whatever posted it — so the category decides.
//
// NO PER-GROUP SUBTOTAL, deliberately: a subtotal would be arithmetic this file
// performed on the engine's lines, and the totals block below already carries
// every figure the bill has to add up to. The headings separate; they do not
// compute.
function buildChargeGroups(
  charges: FolioChargeWithCategory[],
  kind: StatementKind,
): { groups: StatementGroup[] } {
  // SN is continuous across the groups, so the sequence stays quotable down a
  // phone and the export stays one flat sheet.
  let sn = 0;
  const toLine = (charge: FolioChargeWithCategory): StatementLine => {
    sn += 1;
    return {
      key: `charge-${charge.id}`,
      sn,
      date: charge.charge_date,
      // The tenant's own name for the category (rule 17). A retired category
      // still labels its historical charges — the embed is deliberately not
      // deleted_at filtered (021 §8.1).
      type: charge.category?.name ?? '',
      description: charge.description?.trim() ?? '',
      // net_amount: what the guest is actually charged, after any discount. The
      // internal working (rack rate, the discount, who approved it) is not on a
      // guest's bill; the totals block shows the discount as one figure when
      // there was one.
      amount: parseNumeric(charge.net_amount) ?? 0,
    };
  };

  // A standalone folio has no room nights by definition, so a "Room" heading
  // over nothing and an "Extras" heading over everything would be ceremony.
  if (kind === 'standalone') {
    const lines = charges.map(toLine);
    return {
      groups: lines.length > 0 ? [{ key: 'charges', label: 'Charges', lines }] : [],
    };
  }

  const roomLines: StatementLine[] = [];
  const extraLines: StatementLine[] = [];
  // ONE pass in the query's order (charge_date, then created_at — rules 8, 12),
  // so the room nights read as a run of consecutive dates and the SN sequence
  // still follows the bill's own ordering within each group.
  for (const charge of charges) {
    if (charge.category?.code === 'room') roomLines.push(toLine(charge));
  }
  for (const charge of charges) {
    if (charge.category?.code !== 'room') extraLines.push(toLine(charge));
  }

  const groups: StatementGroup[] = [];
  if (roomLines.length > 0) groups.push({ key: 'room', label: 'Room', lines: roomLines });
  if (extraLines.length > 0) {
    groups.push({ key: 'extras', label: 'Extras', lines: extraLines });
  }
  return { groups };
}

// EACH TAX ONCE, across the whole folio — never interleaved with the charges.
// Aggregated from the per-charge amounts the DATABASE computed
// (folio_charge_taxes, 022 §1), so these lines and folio_totals.tax_total are
// the same numbers by construction rather than by agreement. Sorted by code
// because the view projects no display_order and an arbitrary row order must
// not shuffle a printed document between reads.
function buildTaxLines(rows: FolioChargeTaxRow[]): StatementTaxLine[] {
  const byCode = new Map<string, StatementTaxLine>();
  for (const row of rows) {
    const amount = parseNumeric(row.amount) ?? 0;
    const bucket = byCode.get(row.code);
    if (bucket) bucket.amount += amount;
    else byCode.set(row.code, { code: row.code, name: row.name, rate: row.rate, amount });
  }
  return [...byCode.values()].sort((a, b) => a.code.localeCompare(b.code));
}

// The stay block. The window is the BILLED one — from the recorded arrival once
// the guest has checked in — because the document beneath it charges exactly
// those nights (lib/stayNights transcribes run_night_audit's own predicate). A
// range of three days above a bill for one night is a document arguing with
// itself.
function buildStay(booking: BookingDetail): StatementStay {
  const nights = describeStayNights(booking);
  const arrived = nights.actual !== null;
  return {
    roomTypeName: booking.room_type?.name ?? null,
    checkIn: nights.chargeFrom ?? booking.check_in,
    checkOut: booking.check_out,
    arrived,
    nights: nights.actual ?? nights.reserved,
    // Carried only when the two genuinely disagree (a late arrival) — that is
    // the figure a dispute is argued from, and it is noise otherwise.
    reservedNights: nights.differs ? nights.reserved : null,
  };
}

// THE DOCUMENT'S HANDLE.
//
// A stay has one: bookings.booking_number, generated per tenant by a counter
// table (015/019), which is the number the desk and the guest both quote.
//
// A STANDALONE FOLIO HAS NONE, and this build does not invent one. Document
// numbering is a `SECURITY DEFINER` function over a per-tenant counter (§6) —
// never something a browser generates, and never something derived by counting
// rows. So the non-resident account is referenced by the only real handle it
// has: the first segment of its folio id, which is stable, unique within the
// property, and honest about being a reference rather than a serial number. If
// non-resident tabs ever need a proper number, that is a counter row and a
// migration, not a string built here.
function buildReference(
  booking: BookingDetail | null,
  folio: Folio,
): { reference: string; referenceLabel: string } {
  if (booking) {
    return { reference: booking.booking_number, referenceLabel: 'Booking' };
  }
  return { reference: folio.id.slice(0, 8).toUpperCase(), referenceLabel: 'Account' };
}

// A filename stem for the coming exports (PDF / Excel / Word) and for the share
// sheet, built from the same document the screen renders so every channel names
// the file identically: "Statement-HH-2608-0001". Safe characters only — a
// booking number is generated, but a filename must not depend on that.
export function statementFileBase(statement: StatementData): string {
  const safe = statement.reference.replace(/[^A-Za-z0-9._-]+/g, '-');
  return `Statement-${safe}`;
}

// ---------------------------------------------------------------------------
// Reads the statement needs that no existing helper covers
// ---------------------------------------------------------------------------

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
  return (data ?? null) as Folio | null;
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
      .maybeSingle<Pick<PropertySettings, 'branding'>>(),
    fetchPropertyMedia(propertyId, tenantId),
  ]);
  if (settingsRes.error) throw settingsRes.error;

  const branding: PropertyBranding = settingsRes.data?.branding ?? {};
  const logoId = brandingString(branding, 'logo_url');
  return {
    branding,
    // null — never a broken image — when no logo is set or the stored id is
    // dangling. The renderer falls back to the property name as a wordmark.
    logoUrl: mediaUrl(buildMediaMap(mediaRows), logoId, 'card'),
  };
}
