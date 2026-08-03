import { supabase } from './supabase';
import { fetchAllPaged } from './fetchAllPaged';
import { parseNumeric } from './format';
import type {
  ChargeCategory,
  Folio,
  FolioChargeTaxRow,
  FolioChargeWithCategory,
  FolioPayment,
  FolioTotals,
  PaymentMethod,
  Reversal,
  TaxCharge,
} from '../types/folio';

// Data layer for the folio UI (build 6c part 2) over the engine in migration 021
// and the two read views in 022.
//
// THE ONE HARD RULE, INHERITED FROM 021: nothing here writes folios,
// folio_charges or folio_payments directly — those tables have NO write RLS
// policy at all, by design. Every mutation goes through a SECURITY DEFINER RPC,
// because a direct update of discount_amount would bypass the entire manager-PIN
// threshold system and make the accountability chain decorative.
//
// Compliance:
//   - Rule 19: every read is scoped to the active tenant AND property, on top of
//     the RLS that already restricts to the user's tenants.
//   - Rule 1a: reads consumed in full go through fetchAllPaged — a bill must show
//     EVERY line, so nothing here caps.
//   - Rule 2/3: every write RPC gets a fresh idempotency key per submit attempt.
//   - Rule 6: no balance is ever cached client-side. After any mutation the
//     caller re-reads folio_totals; there is no local arithmetic on the balance.
//   - Rule 11: every call is awaited and throws; the caller surfaces the error.
//   - §6: every numeric column arrives as a STRING — parse with parseNumeric
//     before any arithmetic or comparison.

// A fresh idempotency key per submit intent (rules 2/3). crypto.randomUUID needs
// no storage (constraint) and is available in every supported browser. A NEW key
// per attempt is correct: a call that failed wrote nothing, so its retry is a new
// intent — the key exists to collapse a double-click or a network retry of the
// SAME in-flight intent, not to make a rejected write reappear.
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// Errors — the folio surfaces must show the RPC's OWN message
// ---------------------------------------------------------------------------

// humanizeError (lib/errors.ts) deliberately replaces 42501 with soft copy
// ("You do not have permission to make this change"), which is right for an RLS
// denial on a table write. It is WRONG here: apply_charge_discount raises
// insufficient_privilege (42501) for "wrong PIN", "a full comp always requires a
// manager PIN" and "a discount above the approval threshold (₦x) requires a valid
// manager PIN" — three different, actionable things the staff member must read
// verbatim (brief §4: each shows the real message from the RPC). Same for the
// check_violation guards (folio closed, discount exceeds charge, void needs a
// reason) and no_data_found (retired category).
//
// So: prefer the server's message, always. Fall back to plain language only when
// the error carries no message at all.
export function folioErrorMessage(e: unknown): string {
  const err = e as { message?: string; details?: string; hint?: string } | null;
  const message = err?.message?.trim();
  if (message) {
    // hint is where a Postgres RAISE ... USING HINT lands; append it when present
    // so an instruction attached to the rejection is not silently dropped.
    const hint = err?.hint?.trim();
    return hint ? `${message} — ${hint}` : message;
  }
  return 'Something went wrong. Please try again.';
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

// The folio of a booking. 021 §4.1 opens one for EVERY booking via an AFTER
// INSERT trigger and backfilled the existing ones, so this is expected to find a
// row; null means something is genuinely wrong (and the panel says so) rather
// than "no folio yet".
export async function fetchFolioForBooking(
  bookingId: string,
  tenantId: string,
  propertyId: string,
): Promise<Folio | null> {
  const { data, error } = await supabase
    .from('folios')
    .select('*')
    .eq('booking_id', bookingId)
    .eq('tenant_id', tenantId) // rule 19
    .eq('property_id', propertyId) // rule 19
    .maybeSingle();

  if (error) throw error;
  return (data ?? null) as Folio | null;
}

// Every charge on the folio, in BUSINESS-DATE order (rule 8: charge_date, never
// created_at), with created_at only as a stable tiebreak for two charges on the
// same day. The panel shows the posting timestamp separately when it differs.
//
// NOT capped and NOT paged in the UI: a bill that hides lines is not a bill.
// fetchAllPaged keeps the read bounded per request while still returning every
// row (rule 1a), so nothing is unreachable and no pager is needed here.
export async function fetchFolioCharges(
  folioId: string,
  tenantId: string,
  propertyId: string,
): Promise<FolioChargeWithCategory[]> {
  return fetchAllPaged<FolioChargeWithCategory>((from, to) =>
    supabase
      .from('folio_charges')
      // The category embed is NOT filtered by deleted_at — a retired category
      // must still label its historical charges (021 §8.1's inverted rule).
      .select(
        '*, category:charge_categories(code, name, is_taxable, service_chargeable)',
      )
      .eq('folio_id', folioId)
      .eq('tenant_id', tenantId) // rule 19
      .eq('property_id', propertyId) // rule 19
      .order('charge_date', { ascending: true }) // rule 8: business date
      .order('created_at', { ascending: true })
      .range(from, to)
      // PostgREST types a to-one embed as an array it cannot prove singular; at
      // runtime it is one object (same override as lib/bookings.ts).
      .returns<FolioChargeWithCategory[]>(),
  );
}

// Every payment on the folio, business-date ordered (rules 8, 12).
export async function fetchFolioPayments(
  folioId: string,
  tenantId: string,
  propertyId: string,
): Promise<FolioPayment[]> {
  return fetchAllPaged<FolioPayment>((from, to) =>
    supabase
      .from('folio_payments')
      .select('*')
      .eq('folio_id', folioId)
      .eq('tenant_id', tenantId) // rule 19
      .eq('property_id', propertyId) // rule 19
      .order('payment_date', { ascending: true }) // rule 8
      .order('created_at', { ascending: true })
      .range(from, to)
      .returns<FolioPayment[]>(),
  );
}

// Every charge's computed tax lines for the whole folio in ONE read, from the
// folio_charge_taxes view (022 §1) — which is folio_charge_tax applied per charge
// BY THE DATABASE. The alternative (multiplying tax_charges by the category flags
// in TypeScript) would be a second implementation of the applicability rule and
// the per-line rounding, in another language, and the bill would silently drift
// from the balance the day either changed.
export async function fetchFolioChargeTaxes(
  folioId: string,
  tenantId: string,
  propertyId: string,
): Promise<FolioChargeTaxRow[]> {
  return fetchAllPaged<FolioChargeTaxRow>((from, to) =>
    supabase
      .from('folio_charge_taxes')
      .select('*')
      .eq('folio_id', folioId)
      .eq('tenant_id', tenantId) // rule 19
      .eq('property_id', propertyId) // rule 19
      .range(from, to)
      .returns<FolioChargeTaxRow[]>(),
  );
}

// The folio decomposed, straight from folio_totals (021 §8.2). NOTHING is cached
// (rule 6): this is re-read after every mutation, and the UI never adds or
// subtracts its own numbers to guess a new balance.
export async function fetchFolioTotals(
  folioId: string,
): Promise<FolioTotals | null> {
  const { data, error } = await supabase.rpc('folio_totals', {
    p_folio_id: folioId,
  });
  if (error) throw error;
  // A `returns table` function comes back as an array of rows; folio_totals
  // returns exactly one.
  const rows = (data ?? []) as FolioTotals[];
  return rows[0] ?? null;
}

// The tenant's live, active charge categories for the Add-charge picker, in the
// hotel's own display order. Soft-deleted and deactivated rows are excluded here
// because this is the "what may I post NOW" list — post_charge rejects them
// anyway (021 §9.1), which is the actual guard.
export async function fetchChargeCategories(
  tenantId: string,
): Promise<ChargeCategory[]> {
  return fetchAllPaged<ChargeCategory>((from, to) =>
    supabase
      .from('charge_categories')
      .select('*')
      .eq('tenant_id', tenantId) // rule 19
      .is('deleted_at', null) // rule 5
      .eq('is_active', true)
      .order('display_order', { ascending: true })
      .order('name', { ascending: true })
      .range(from, to)
      .returns<ChargeCategory[]>(),
  );
}

// The property's live, active taxes and surcharges. Used ONLY by the pre-posting
// preview below — never to compute a figure on a posted bill.
export async function fetchActiveTaxCharges(
  tenantId: string,
  propertyId: string,
): Promise<TaxCharge[]> {
  return fetchAllPaged<TaxCharge>((from, to) =>
    supabase
      .from('tax_charges')
      .select('*')
      .eq('tenant_id', tenantId) // rule 19
      .eq('property_id', propertyId) // rule 19
      .is('deleted_at', null) // rule 5
      .eq('is_active', true)
      .order('display_order', { ascending: true })
      .order('code', { ascending: true })
      .range(from, to)
      .returns<TaxCharge[]>(),
  );
}

// The property's PIN-free discount ceiling (021 §3). Read so the discount screen
// can decide whether to SHOW the PIN field — a UX convenience only. Rule 19's
// pattern applies exactly: apply_charge_discount re-reads this threshold
// server-side and rejects the call regardless of what the client believed, so a
// stale or tampered copy here changes nothing about what is allowed.
//
// coalesce to 0 on a missing row for the same reason the RPC does: if the
// settings row were ever absent, the safe reading is "everything needs approval",
// never "nothing does".
export async function fetchDiscountThreshold(
  propertyId: string,
): Promise<number> {
  const { data, error } = await supabase
    .from('property_finance_settings')
    .select('discount_threshold')
    .eq('property_id', propertyId)
    .maybeSingle();

  if (error) throw error;
  return parseNumeric((data as { discount_threshold: string } | null)?.discount_threshold) ?? 0;
}

// ---------------------------------------------------------------------------
// Pre-posting tax PREVIEW — the one place the applicability rule is restated,
// and it never touches a posted figure
// ---------------------------------------------------------------------------
//
// WHAT THE ENGINE CANNOT DO, STATED PLAINLY (brief: "if the UI needs something
// the engine cannot do, say so"): 021 computes tax from a charge ROW —
// folio_charge_tax takes a charge_id. Brief §3 requires staff to see the tax
// BEFORE posting, when no row exists yet, and there is no quote-a-hypothetical
// function in the engine.
//
// So this function restates the applicability rule (tax.applies_to x the
// category's flag) and the per-line round-to-2dp for a charge that does not exist
// yet. It is confined to this one function, it is labelled an ESTIMATE in the UI,
// and NOTHING on a posted bill is ever computed with it — every printed figure
// comes from folio_charge_taxes / folio_totals. If this ever needs to be exact by
// construction rather than by review, the right fix is a read-only
// quote_charge_tax(property, category, net) in the engine that the posting path
// and this preview both call — not a richer copy of the rule here.
export interface PreviewTaxLine {
  code: string;
  name: string;
  rate: string;
  amount: number;
}

export function previewChargeTaxes(
  taxes: TaxCharge[],
  category: Pick<ChargeCategory, 'is_taxable' | 'service_chargeable'> | null,
  netAmount: number,
): PreviewTaxLine[] {
  if (!category) return [];
  return taxes
    .filter(
      (t) =>
        (t.applies_to === 'taxable' && category.is_taxable) ||
        (t.applies_to === 'service_chargeable' && category.service_chargeable),
    )
    .map((t) => {
      const rate = parseNumeric(t.rate) ?? 0;
      return {
        code: t.code,
        name: t.name,
        rate: t.rate,
        // Rounded per line to 2dp, exactly as folio_charge_tax rounds, so the
        // preview and the posted bill agree to the kobo.
        amount: Math.round(netAmount * rate * 100) / 100,
      };
    });
}

// ---------------------------------------------------------------------------
// Writes — ALL through the 021 RPCs (never a table write; there is no policy)
// ---------------------------------------------------------------------------

export interface PostChargeInput {
  folioId: string;
  chargeCategoryId: string;
  description: string | null;
  quantity: number;
  unitAmount: number;
  // The BUSINESS date (rules 8, 12). null = the property's local today, resolved
  // server-side from properties.timezone.
  chargeDate: string | null;
  idempotencyKey: string;
  // PROVENANCE (021 §5: free text ON PURPOSE, so a new posting module never
  // needs a migration to name itself). Omitted for an ordinary front-desk extra,
  // which takes the RPC's own 'manual' default; the guest home passes
  // 'standalone' for a charge posted to the non-resident folio, so the bill and
  // every future report can tell the two apart without inspecting the folio.
  source?: string;
}

// Post a manual charge. THE ONE charge RPC (021 §9.1) — F&B, laundry, internet,
// minibar and every later module post through it with their own category.
//
// SOURCE IS 'manual' (the RPC's default) because this screen is the FRONT DESK
// posting an extra: a restaurant bill signed to the room, a laundry ticket, a
// pay-as-you-go internet voucher. ROOM NIGHTS DO NOT COME FROM HERE — they are
// posted per night by post_room_night_charge at night audit (021 §9.2), with a
// deterministic 'room:<booking>:<date>' key so a re-run cannot double-post. A
// receptionist should never key a room night by hand; it arrives automatically.
export async function postCharge(input: PostChargeInput) {
  const { data, error } = await supabase.rpc('post_charge', {
    p_folio_id: input.folioId,
    p_charge_category_id: input.chargeCategoryId,
    p_description: input.description,
    p_quantity: input.quantity,
    p_unit_amount: input.unitAmount,
    p_charge_date: input.chargeDate,
    p_idempotency_key: input.idempotencyKey,
    // Omitted -> the RPC's 'manual' default (it coalesces a blank away too).
    p_source: input.source ?? 'manual',
  });
  if (error) throw error;
  return data;
}

export interface RecordPaymentInput {
  folioId: string;
  // SIGNED: positive = money in (deposit, settlement), negative = money out
  // (refund). There is no direction flag — a magnitude plus a direction is two
  // facts that can contradict each other (021 §6).
  amount: number;
  method: PaymentMethod;
  reference: string | null;
  paymentDate: string | null;
  idempotencyKey: string;
}

// Record a payment. A PRE-ARRIVAL DEPOSIT IS JUST A PAYMENT ON THE OPEN FOLIO —
// the folio exists from the moment the booking does, so a deposit taken three
// weeks before check-in is a positive payment that drives the balance negative
// until charges post against it and net off at checkout. There is deliberately no
// separate deposit table, deposit state, or "convert deposit to payment" step, so
// this one action serves both (021 §9.4). The screen starts EMPTY (rule 10): the
// user types the amount; nothing pre-fills the balance due.
export async function recordPayment(input: RecordPaymentInput) {
  const { data, error } = await supabase.rpc('record_payment', {
    p_folio_id: input.folioId,
    p_amount: input.amount,
    p_method: input.method,
    p_reference: input.reference,
    p_payment_date: input.paymentDate,
    p_idempotency_key: input.idempotencyKey,
  });
  if (error) throw error;
  return data;
}

export interface ApplyDiscountInput {
  chargeId: string;
  // ABSOLUTE, not cumulative: this is what the discount BECOMES. Calling twice
  // with 5,000 leaves a 5,000 discount, not 10,000 (021 §9.3).
  discountAmount: number;
  reason: string;
  // The manager's PIN, or null when the amount is within the staff member's own
  // authority. NEVER stored, never logged, never sent anywhere but this RPC, and
  // cleared from component state the moment this call returns.
  managerPin: string | null;
  idempotencyKey: string;
}

// Apply an accountable discount to ONE charge (discount attaches to a charge, not
// to the folio — 021 §5's discount-as-its-own-line model).
//
// THE THRESHOLD IS ENFORCED HERE, NOT IN THE UI. The screen decides whether to
// SHOW a PIN field purely for good UX; apply_charge_discount re-reads the
// property's discount_threshold and re-checks the comp rule itself, so a staffer
// who skips the field, or a client with a stale threshold, is rejected by the
// database and the rejection is shown verbatim. Exactly rule 19's shape: the
// client's copy is a convenience, the server is the guard.
export async function applyChargeDiscount(input: ApplyDiscountInput) {
  const { data, error } = await supabase.rpc('apply_charge_discount', {
    p_charge_id: input.chargeId,
    p_discount_amount: input.discountAmount,
    p_reason: input.reason,
    p_manager_pin: input.managerPin,
    p_idempotency_key: input.idempotencyKey,
  });
  if (error) throw error;
  return data;
}

// Void a charge / a payment. Voided rows are NEVER deleted and never hidden: the
// line stays on the bill, marked, with its reason, time and actor, and the DB's
// NULL-safe `is_voided is not true` filter (rule 5) keeps it out of every total.
// No cache is decremented because nothing is cached (rules 6, 7).
export async function voidCharge(
  chargeId: string,
  reason: string,
  idempotencyKey: string,
) {
  const { data, error } = await supabase.rpc('void_charge', {
    p_charge_id: chargeId,
    p_reason: reason,
    p_idempotency_key: idempotencyKey,
  });
  if (error) throw error;
  return data;
}

export async function voidPayment(
  paymentId: string,
  reason: string,
  idempotencyKey: string,
) {
  const { data, error } = await supabase.rpc('void_payment', {
    p_payment_id: paymentId,
    p_reason: reason,
    p_idempotency_key: idempotencyKey,
  });
  if (error) throw error;
  return data;
}

// ---------------------------------------------------------------------------
// Reversal (031) — VOID and REVERSE are different acts
// ---------------------------------------------------------------------------
//
//   VOID    = "this never should have been recorded" — a keying mistake caught
//             in the same breath. The line drops out of the totals. No PIN.
//   REVERSE = "this WAS recorded and WAS relied upon, and must now be undone" —
//             a receipt was issued, a statement was emailed, a balance was
//             quoted. The original keeps counting, because it happened, and the
//             undoing is a SECOND visible line with a manager's name on it.
//
// A reversal NEVER deletes or edits the original. reverse_payment posts an equal
// and opposite counter-payment through the SAME record_payment path, so
// folio_totals and the 027 FIFO views need no change at all: payments are signed,
// so the balance rises by the reversed amount and the guest-level FIFO
// allocation re-runs on the next read. Nothing is cached (rule 6), so there is no
// cache to keep in lockstep (rule 7).

export interface ReversePaymentInput {
  paymentId: string;
  reason: string;
  // ALWAYS required — unlike a discount there is no threshold below which a
  // reversal is routine, because it is the RECORD being changed, not a price.
  // Never stored, never logged, never put in an error message, and cleared from
  // component state the moment this call returns.
  managerPin: string;
  idempotencyKey: string;
}

// Reverse a payment. Returns the permanent `reversals` audit row.
//
// IDEMPOTENT TWICE OVER, AND LOAD-BEARING (constraint): the RPC keys on the
// passed key AND, independently, refuses a payment that already has a reversal —
// under a FOR UPDATE lock on the original, so two terminals in the same second
// cannot post two counter-payments. A re-run returns the FIRST reversal's
// outcome unchanged, and does so BEFORE re-checking the PIN, so a retry after a
// network drop does not send the desk to fetch a manager twice.
//
// EVERY GUARD IS THE SERVER'S (rule 19). The dialog requires a reason and a PIN
// for a clean screen; reverse_payment requires them itself and rejects the call
// with its own wording, which the caller shows verbatim through
// folioErrorMessage.
export async function reversePayment(
  input: ReversePaymentInput,
): Promise<Reversal> {
  const { data, error } = await supabase.rpc('reverse_payment', {
    p_payment_id: input.paymentId,
    p_reason: input.reason,
    p_manager_pin: input.managerPin,
    p_idempotency_key: input.idempotencyKey,
  });
  if (error) throw error;
  return data as Reversal;
}

// Every reversal recorded against a folio's payments, so the bill can name the
// manager who approved each one. Keyed by the ORIGINAL payment id.
//
// The bill does not NEED this to render correctly — a counter-entry is
// recognisable from folio_payments.reversal_of_payment_id alone, and the reason
// is copied onto the counter-line's reference — but "approved by whom" lives
// only here, and a reversal that names nobody is the failure the whole subsystem
// exists to prevent.
//
// Rule 1a: paginated through fetchAllPaged; rule 19: scoped to the active tenant
// and property on top of RLS.
export async function fetchPaymentReversals(
  paymentIds: string[],
  tenantId: string,
  propertyId: string,
): Promise<Map<string, Reversal>> {
  const byTarget = new Map<string, Reversal>();
  if (paymentIds.length === 0) return byTarget;

  // Chunked because `.in()` on an unbounded list is exactly what rule 1 forbids:
  // a folio with hundreds of payments would otherwise build one enormous URL.
  const CHUNK = 200;
  for (let i = 0; i < paymentIds.length; i += CHUNK) {
    const chunk = paymentIds.slice(i, i + CHUNK);
    const rows = await fetchAllPaged<Reversal>((from, to) =>
      supabase
        .from('reversals')
        .select('*')
        .eq('tenant_id', tenantId) // rule 19
        .eq('property_id', propertyId) // rule 19
        .eq('target_type', 'payment')
        .in('target_id', chunk)
        .order('reversed_at', { ascending: true })
        .range(from, to)
        .returns<Reversal[]>(),
    );
    for (const row of rows) byTarget.set(row.target_id, row);
  }
  return byTarget;
}

// ---------------------------------------------------------------------------
// Manager PIN (021 §7)
// ---------------------------------------------------------------------------

// Whether the CALLING user has an approval PIN for this tenant. manager_pins has
// no select policy for anyone — not even its owner — so this function is the only
// way to answer the question, and it answers only about the caller, so it cannot
// be used to enumerate which managers have PINs.
export async function hasManagerPin(tenantId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('has_manager_pin', {
    p_tenant_id: tenantId,
  });
  if (error) throw error;
  return data === true;
}

// Set or change the CALLING manager's own PIN. Takes no user id by design —
// nobody can plant a PIN on a colleague's account and then approve discounts as
// them. Owner/manager only (the RPC enforces it via is_tenant_admin), 4-8 digits,
// and trivially weak PINs (repeated digits, sequences) are rejected by the RPC
// with a message the caller shows as-is.
//
// The PIN is passed straight through and never held anywhere: not in a variable
// that outlives this call, not in a log, not in an error message.
export async function setManagerPin(
  tenantId: string,
  pin: string,
): Promise<void> {
  const { error } = await supabase.rpc('set_manager_pin', {
    p_tenant_id: tenantId,
    p_pin: pin,
  });
  if (error) throw error;
}
