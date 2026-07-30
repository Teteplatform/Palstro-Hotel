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
// MONEY IS A STRING. Every numeric(14,2)/numeric(14,4) column arrives from
// PostgREST as a string (§6) so the exact decimal survives. Parse with
// parseNumeric before ANY arithmetic or comparison; `typeof amount === 'number'`
// is always false.

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
  // Hook for the accounting build: the account_mappings ROLE KEY this category
  // posts to (rule 4 — never a literal GL code). NULL until account_mappings exists.
  account_code: string | null;
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
  // numeric(5,4) -> STRING. A FRACTION, not a percent: '0.0750' is 7.5%.
  rate: string;
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

export interface Folio {
  id: string;
  tenant_id: string;
  property_id: string;
  booking_id: string;
  status: FolioStatus;
  opened_at: string;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
  // NOTE: no `balance`. Call folio_balance()/folio_totals() — see the header.
}

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
  quantity: string;                   // numeric(14,4) -> string
  unit_amount: string;                // numeric(14,2) -> string
  gross_amount: string;
  discount_amount: string;
  discount_reason: string | null;
  // WHO authorised the discount: the manager whose PIN was verified above the
  // threshold (or for any comp), else the staff member acting within their own
  // authority. The accountability record the discount feature exists to create.
  discount_approved_by: string | null;
  net_amount: string;                 // always exactly gross - discount (DB CHECK)
  charge_date: string;                // 'YYYY-MM-DD' — the BUSINESS date (rules 8, 12)
  source: string;                     // 'room' | 'manual' | 'fnb' | ... free text
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
  amount: string;                     // numeric(14,2) -> string; signed
  method: PaymentMethod;
  reference: string | null;
  payment_date: string;               // BUSINESS date (rules 8, 12)
  // Who TOOK the money (an operational claim). created_by remains the
  // non-forgeable audit truth of who KEYED the row; they differ on a hand-over.
  received_by: string | null;
  is_voided: boolean;
  voided_at: string | null;
  voided_by: string | null;
  void_reason: string | null;
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
  discount_threshold: string;
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
  rate: string;
  amount: string;
}

// What folio_totals(folio_id) returns. INVARIANT (rule 9):
//   net_total     = gross_total - discount_total   (DB-enforced per charge)
//   charges_total = net_total + tax_total
//   balance       = charges_total - payments_total = folio_balance(folio_id)
// All live from non-voided rows; nothing cached.
export interface FolioTotals {
  gross_total: string;
  discount_total: string;
  net_total: string;
  tax_total: string;
  charges_total: string;
  payments_total: string;
  balance: string;
}
