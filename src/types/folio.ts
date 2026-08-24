// DB row types for the folio engine (supabase/migrations/021_folio_engine.sql).
// Keep in sync with the migration.
//
// The folio is the guest's running account for a stay — one per booking, opened
// by an AFTER INSERT trigger on bookings. It is a SHARED ENGINE: F&B, laundry,
// housekeeping and the minibar all post into it through the ONE post_charge RPC,
// driven by charge_categories. There is no per-module charge RPC and no per-module
// charge table.
//
// TWO THINGS ARE NEVER STORED, AND SO ARE NEVER FIELDS HERE:
//   * the folio BALANCE — computed by the folio_balance / folio_totals RPCs
//     (rule 6: a cached balance drifts and cannot be repaired),
//   * per-charge TAX — computed by folio_charge_tax from the currently active
//     tax_charges, so a rate change cannot make history disagree with itself.
// If you find yourself wanting either as a column, read §5 and §8 of the migration.
//
// EVERY MONEY FIELD BELOW IS A `number`, ALREADY PARSED (rule 24). The wire
// sends numeric(14,2)/numeric(14,4) as a string so the exact decimal survives;
// src/lib/folio.ts parses each read at the boundary, so a component receives
// the figure and never the transport. The column type stays in each comment —
// it is where the scale and the rounding come from.

export type FolioStatus = 'open' | 'settled' | 'closed';

export type PaymentMethod =
  | 'cash'
  | 'bank_transfer'
  | 'pos'
  | 'company_account'
  | 'other';

// Which set of charges a tax or surcharge applies to. 'taxable' = a tax proper
// (VAT), matched against charge_categories.is_taxable; 'service_chargeable' = a
// hotel surcharge (service/tray), matched against
// charge_categories.service_chargeable. Deliberately different sets.
export type TaxAppliesTo = 'taxable' | 'service_chargeable';

// What can be charged, per tenant. THE EXTENSION POINT: a new charge type (spa,
// conference hall) is a row here, never a migration and never a new RPC.
export interface ChargeCategory {
  id: string;
  tenant_id: string;
  code: string;                       // stable machine key modules post against
  name: string;                       // display label, freely editable
  is_taxable: boolean;
  service_chargeable: boolean;
  // The account_mappings ROLE KEY this category's revenue posts to (rule 4 —
  // never a literal GL code). REQUIRED since 044: a category that cannot be
  // charged to should not exist, because the alternative is the first charge
  // refusing at the front desk for a configuration mistake made weeks earlier.
  // Convention is 'revenue_' || code. Renamed from account_code in 044 — the old
  // name said "code" while holding a key, and a column whose name contradicts
  // its comment gets used according to its name.
  account_role_key: string;
  is_active: boolean;
  display_order: number;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
}

// The taxes and surcharges a property levies. Rows, not constants: a rate change
// is an UPDATE. A compulsory row (VAT is seeded compulsory) can be neither
// deactivated nor soft-deleted until is_compulsory is cleared first.
export interface TaxCharge {
  id: string;
  tenant_id: string;
  property_id: string;
  code: string;
  name: string;
  // numeric(5,4). A FRACTION, not a percent: 0.0750 is 7.5%.
  rate: number;
  is_compulsory: boolean;
  applies_to: TaxAppliesTo;
  is_active: boolean;
  display_order: number;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
}

// A folio has exactly ONE owner (028 §1, folios_owner_check):
//   booking_id set, guest_id null  -> the STAY folio (021's original, unchanged)
//   booking_id null, guest_id set  -> the STANDALONE / non-resident folio, which
//                                     holds a guest's charges and payments that
//                                     belong to no stay. One per guest per
//                                     property, opened by open_guest_folio.
// Both kinds are charged and paid through the SAME unchanged post_charge /
// record_payment, and folio_totals values them identically.
export interface Folio {
  id: string;
  tenant_id: string;
  property_id: string;
  booking_id: string | null;
  guest_id: string | null;
  status: FolioStatus;
  opened_at: string;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
  // NOTE: no `balance`. Call folio_balance()/folio_totals() — see the header.
}

// The two acts that can be reversed ON a charge (032). A subset of
// ReversalTargetType, because a folio_charges counter-entry can only ever be one
// of these two — keep in sync with folio_charges_reversal_pair_check.
export type ChargeReversalTargetType = 'charge' | 'discount';

// One charge line. The DISCOUNT-AS-ITS-OWN-LINE model: gross and discount are
// separate visible figures so a bill reads rack -> discount -> net, and the hotel
// can see what was given away and by whom.
export interface FolioCharge {
  id: string;
  tenant_id: string;
  property_id: string;
  folio_id: string;
  charge_category_id: string;
  description: string | null;
  quantity: number;                   // numeric(14,4)
  unit_amount: number;                // numeric(14,2)
  gross_amount: number;
  discount_amount: number;
  discount_reason: string | null;
  // WHO authorised the discount: the manager whose PIN was verified above the
  // threshold (or for any comp), else the staff member acting within their own
  // authority. The accountability record the discount feature exists to create.
  discount_approved_by: string | null;
  net_amount: number;                 // always exactly gross - discount (DB CHECK)
  charge_date: string;                // 'YYYY-MM-DD' — the BUSINESS date (rules 8, 12)
  source: string;                     // 'room' | 'manual' | 'fnb' | 'reversal' | ... free text
  // Set ONLY on a REVERSAL COUNTER-ENTRY (032 §1): the id of the original charge
  // this row reverses, and WHICH act it performs. NULL on every ordinary charge.
  // Not cached figures (rule 6) — an identity and a kind, neither of which can
  // drift.
  //
  // They are also what the DB's sign constraint keys on: ONLY a row that declares
  // the charge it reverses may carry negative money, so a counter-entry is the
  // one shape of folio_charges row whose amounts are negative.
  //   'charge'   — the whole charge was reversed. The counter mirrors gross,
  //                discount AND net, so the balance returns to exactly what it
  //                was before the charge existed, tax included.
  //   'discount' — only the discount was reversed. The counter is
  //                (gross 0, discount −X, net +X): the charge goes back to full
  //                price and the original keeps its discount trail intact.
  reversal_of_charge_id: string | null;
  reversal_target_type: ChargeReversalTargetType | null;
  is_voided: boolean;
  voided_at: string | null;
  voided_by: string | null;
  void_reason: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
}

// Deposits, settlements and refunds. amount is SIGNED: positive = money in,
// negative = money out. There is no direction field by design — a magnitude plus
// a direction is two facts that can contradict each other.
export interface FolioPayment {
  id: string;
  tenant_id: string;
  property_id: string;
  folio_id: string;
  amount: number;                     // numeric(14,2); signed
  method: PaymentMethod;
  reference: string | null;
  payment_date: string;               // BUSINESS date (rules 8, 12)
  // Who TOOK the money (an operational claim). created_by remains the
  // non-forgeable audit truth of who KEYED the row; they differ on a hand-over.
  received_by: string | null;
  // Set ONLY on a REVERSAL COUNTER-ENTRY (031 §2): the id of the original
  // payment this row reverses. NULL on every ordinary payment, deposit and
  // refund. Not a cached figure (rule 6) — the identity of another row, which
  // cannot drift.
  //
  // It is what lets the bill and the statement print a counter-line as "Payment
  // reversal — <reason>" rather than a mysterious negative "Refund", and lets
  // the ORIGINAL line be marked as reversed, from ONE fetch of the folio's
  // payments with no join to `reversals`.
  reversal_of_payment_id: string | null;
  is_voided: boolean;
  voided_at: string | null;
  voided_by: string | null;
  void_reason: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
}

// What may be reversed. 'payment' is live (031); the rest are declared in the
// same DB CHECK constraint now so later parts of the reversal subsystem add an
// RPC and not a migration that alters it. Keep in sync with
// reversals_target_type_check.
export type ReversalTargetType =
  | 'payment'
  | 'charge'
  | 'discount'
  | 'no_show'
  | 'cancel'
  | 'checkout';

// One permanent reversal audit row (031 §1): which row was reversed, which
// counter-entry undid it, which manager's PIN authorised it, who keyed it, when
// and why.
//
// NEVER UPDATED AND NEVER DELETED — there is no update path in the app, no write
// RLS policy on the table, and a change_log tripwire on the table if one ever
// appeared. Treat every field here as immutable history.
export interface Reversal {
  id: string;
  tenant_id: string;
  property_id: string;
  reversed_at: string;
  // The staff member at the keyboard (non-forgeable — set from auth.uid()).
  reversed_by: string;
  // The manager whose PIN verified. May equal reversed_by when a manager
  // reverses their own posting; that is recorded, not suppressed.
  approved_by: string;
  reason: string;
  target_type: ReversalTargetType;
  // The ORIGINAL row reversed, and the counter-entry produced. Polymorphic over
  // target_type, which is why neither carries a foreign key in the DB.
  target_id: string;
  counter_entry_id: string | null;
  business_date: string;              // 'YYYY-MM-DD' — the BUSINESS date (rules 8, 12)
  idempotency_key: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
}

// Per-property internal finance config. Deliberately NOT on property_settings,
// which is publicly readable by the guest site (RLS cannot hide a column).
export interface PropertyFinanceSettings {
  property_id: string;
  // Largest discount a staff member may apply without a manager PIN. '0.00'
  // (the default) means EVERY discount needs manager approval. A full comp
  // always needs a PIN whatever this is.
  discount_threshold: number;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
}

// ---------------------------------------------------------------------------
// RPC return shapes (computed — nothing below is stored)
// ---------------------------------------------------------------------------

// One row per tax applying to a charge: what folio_charge_tax(charge_id) returns
// and what the bill prints beneath the line. Rounded per line to 2dp, the same
// way folio_totals rounds, so printed lines always add up to the printed total.
export interface FolioChargeTaxLine {
  tax_charge_id: string;
  code: string;
  name: string;
  rate: number;
  amount: number;
}

// A charge as the folio PANEL reads it: the row plus the category it was posted
// against, so the bill can print "Food & Beverage — Dinner, 2 × ₦12,500".
//
// The category embed is deliberately NOT filtered by deleted_at, matching
// folio_charge_tax (021 §8.1): a category retired last year must still label the
// charges posted against it, or last year's bill reprints with a blank line.
export interface FolioChargeWithCategory extends FolioCharge {
  category: {
    code: string;
    name: string;
    is_taxable: boolean;
    service_chargeable: boolean;
  } | null;
}

// What folio_totals(folio_id) returns. INVARIANT (rule 9):
//   net_total     = gross_total - discount_total   (DB-enforced per charge)
//   charges_total = net_total + tax_total
//   balance       = charges_total - payments_total = folio_balance(folio_id)
// All live from non-voided rows; nothing cached.
export interface FolioTotals {
  gross_total: number;
  discount_total: number;
  net_total: number;
  tax_total: number;
  charges_total: number;
  payments_total: number;
  balance: number;
}

// ---------------------------------------------------------------------------
// The two READ VIEWS (supabase/migrations/022_folio_read_views.sql)
// ---------------------------------------------------------------------------
// Nothing here is stored either: both views are thin projections over 021's
// functions, so the UI never re-implements the engine and never issues N+1 calls.

// One row of folio_charge_taxes: folio_charge_tax(charge) applied per charge by
// the database. The panel fetches these ONCE per folio and groups them two ways —
// by charge_id for the per-line breakdown, by code for the folio tax lines — so
// the printed lines and the printed total come from the same numbers.
export interface FolioChargeTaxRow {
  charge_id: string;
  folio_id: string;
  tenant_id: string;
  property_id: string;
  tax_charge_id: string;
  code: string;
  name: string;
  rate: number;                       // numeric(5,4); a FRACTION
  amount: number;                     // numeric(14,2)
}

// One row of booking_balances: a booking's LIVE folio balance (folio_totals)
// alongside the booking columns the list filters on, so the bookings table can
// show a Balance column and an outstanding total across the whole filtered set
// (rule 20) without one function call per visible row.
export interface BookingBalanceRow {
  booking_id: string;
  tenant_id: string;
  property_id: string;
  folio_id: string;
  folio_status: FolioStatus;
  charges_total: number;
  payments_total: number;
  balance: number;                    // positive = guest owes; negative = refund due
}
