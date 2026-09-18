// PURCHASING'S ROW TYPES (046) — suppliers, purchase orders, goods receipts.
//
// RULE 24 IS THE WHOLE POINT OF THIS FILE, exactly as it is of types/accounting.
// PostgREST returns `numeric` as a STRING and int8/int4 as a NUMBER, and which
// one a field arrives as is decided by a column type and by casts inside a view
// — none of that visible from a component. So a field that is a number in the
// app is TYPED `number` here and parsed on the way in by lib/purchasing's
// boundary declarations. A string method on one of these is then a compile error
// rather than a crash somebody finds while receiving a delivery.
//
// This module has MORE of that hazard than most, not less: purchase_order_summary
// and purchase_order_line_status are views full of sums and counts, and a count
// arrives as a JSON number while the money beside it arrives as a string. Only
// the browser ever sees that difference.

// ---------------------------------------------------------------------------
// Suppliers
// ---------------------------------------------------------------------------

export interface Supplier {
  id: string;
  tenant_id: string;
  // Optional short code — 'BFF'. Shown as the picker's second line, because
  // somebody holding a delivery note usually has the code rather than the full
  // registered name.
  code: string | null;
  name: string;
  contact_name: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  // THE FOUR CAPTURED FOR 1.1h5. Nothing in this shipment computes with any of
  // them; they are here because the table was empty when the form was built and
  // a backfill conversation with a hotel is the alternative.
  tax_id: string | null;
  withholding_tax_rate: number | null;
  bank_name: string | null;
  bank_account_name: string | null;
  bank_account_number: string | null;
  note: string | null;
  is_active: boolean;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

// What a supplier form sends. Separate from the row type because a form does not
// send an id, a timestamp or an actor — those are the database's.
export interface SupplierWrite {
  name: string;
  code: string | null;
  contact_name: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  tax_id: string | null;
  withholding_tax_rate: number | null;
  bank_name: string | null;
  bank_account_name: string | null;
  bank_account_number: string | null;
  note: string | null;
  is_active: boolean;
}

// ---------------------------------------------------------------------------
// Purchase orders
// ---------------------------------------------------------------------------

// The five states, and the graph between them is a database trigger (046 §2.3),
// not something this client decides.
export type PurchaseOrderStatus =
  | 'draft'
  | 'ordered'
  | 'part_received'
  | 'received'
  | 'cancelled';

// The three kinds of purchase line. Only 'inventory' can be written today —
// save_purchase_order refuses the other two BY NAME, naming 1.1h3 — and the type
// is declared in full so that shipment adds a branch rather than a type.
export type PurchaseLineType = 'inventory' | 'asset' | 'expense';

export interface PurchaseOrder {
  id: string;
  seq: number;
  tenant_id: string;
  property_id: string;
  supplier_id: string;
  order_number: string;
  status: PurchaseOrderStatus;
  order_date: string;
  expected_date: string | null;
  destination_location_id: string;
  note: string | null;
  ordered_at: string | null;
  ordered_by: string | null;
  cancelled_at: string | null;
  cancelled_by: string | null;
  cancel_reason: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
}

// What the Purchases list reads — purchase_order_summary. Everything past
// `is_open` is DERIVED by the view on read; nothing here is stored.
export interface PurchaseOrderSummary {
  id: string;
  seq: number;
  tenant_id: string;
  property_id: string;
  order_number: string;
  status: PurchaseOrderStatus;
  order_date: string;
  expected_date: string | null;
  note: string | null;
  cancel_reason: string | null;
  ordered_at: string | null;
  cancelled_at: string | null;
  created_at: string;
  created_by: string | null;

  supplier_id: string;
  supplier_name: string;
  supplier_code: string | null;

  destination_location_id: string;
  destination_name: string;
  destination_kind: string;

  // Still waiting on something. A server-side column, so the list can filter and
  // total on it across the whole filter rather than testing it on a page.
  is_open: boolean;

  // int8 over PostgREST, so a JSON NUMBER on the wire — while every money field
  // beside it is a STRING. Rule 24's exact hazard, in one row.
  line_count: number;
  // At the ORDERED cost.
  ordered_value: number;
  // At the INVOICED cost. The two do not have to agree even when every quantity
  // matched, and that gap is why both are shown.
  received_value: number;
  outstanding_value: number;
  last_receipt_date: string | null;
  receipt_count: number;
}

// One order line with what has arrived against it — purchase_order_line_status.
// outstanding_quantity here is computed EXACTLY as receive_purchase_order
// computes it, which is what stops the screen and a refusal disagreeing.
export interface PurchaseOrderLineStatus {
  purchase_order_line_id: string;
  tenant_id: string;
  property_id: string;
  purchase_order_id: string;
  order_number: string;
  order_status: PurchaseOrderStatus;
  line_number: number;
  line_type: PurchaseLineType;
  inventory_item_id: string | null;
  item_name: string | null;
  item_code: string | null;
  base_unit: string | null;
  tracks_expiry: boolean | null;
  description: string | null;
  ordered_quantity: number;
  ordered_unit_cost: number;
  note: string | null;
  received_quantity: number;
  received_value: number;
  closed_short: boolean;
  outstanding_quantity: number;
  is_settled: boolean;
  // What the supplier charged last time on this line, so the receiving form can
  // show it beside what was ordered. NULL until something has arrived.
  last_unit_cost: number | null;
}

// ---------------------------------------------------------------------------
// Goods receipts
// ---------------------------------------------------------------------------

export interface PurchaseReceipt {
  id: string;
  seq: number;
  tenant_id: string;
  property_id: string;
  purchase_order_id: string;
  receipt_number: string;
  business_date: string;
  location_id: string;
  delivery_note: string | null;
  invoice_number: string | null;
  note: string | null;
  reason: string | null;
  // The manager who authorised an over-receipt, or a delivery somewhere that is
  // not a store. NULL when neither applied.
  authorised_by: string | null;
  created_at: string;
  created_by: string | null;
}

// purchase_receipt_line_detail — what arrived against what was ordered, with the
// cost difference computed by the view rather than by four screens.
export interface PurchaseReceiptLineDetail {
  id: string;
  tenant_id: string;
  property_id: string;
  purchase_receipt_id: string;
  receipt_number: string;
  business_date: string;
  delivery_note: string | null;
  invoice_number: string | null;
  authorised_by: string | null;
  purchase_order_id: string;
  order_number: string;
  purchase_order_line_id: string;
  line_number: number;
  quantity: number;
  unit_cost: number;
  closed_short: boolean;
  reason: string | null;
  batch_code: string | null;
  expiry_date: string | null;
  note: string | null;
  stock_movement_id: string | null;
  created_at: string;
  created_by: string | null;
  ordered_quantity: number;
  ordered_unit_cost: number;
  inventory_item_id: string | null;
  item_name: string | null;
  item_code: string | null;
  base_unit: string | null;
  line_value: number;
  // POSITIVE when the invoice was higher than the order.
  unit_cost_difference: number;
  cost_difference_value: number;
}

// ---------------------------------------------------------------------------
// What a form sends
// ---------------------------------------------------------------------------

// One line of a draft order. `id` is the CLIENT's row key only — the server
// replaces a draft's lines whole (046 §6.1) and never reads it.
export interface PurchaseOrderLineDraft {
  key: string;
  inventoryItemId: string;
  quantity: number | null;
  unitCost: number | null;
  note: string;
}

// One line of a delivery being recorded.
export interface ReceiptLineDraft {
  purchaseOrderLineId: string;
  quantity: number | null;
  unitCost: number | null;
  closedShort: boolean;
  reason: string;
  batchCode: string;
  expiryDate: string;
  note: string;
}

// ---------------------------------------------------------------------------
// Supplier activity — ONE-SIDED, and the type says so
// ---------------------------------------------------------------------------

// WHAT WAS ORDERED AND WHAT ARRIVED. There is deliberately no balance field and
// no "owed" field: receiving credits supplier_payable and nothing in this
// shipment debits it, so a balance computed from receipts alone would be right
// until the first payment and silently wrong forever after. Supplier payments
// are 1.1h5.
export interface SupplierActivityRow {
  purchase_order_id: string;
  tenant_id: string;
  property_id: string;
  supplier_id: string;
  supplier_name: string;
  supplier_code: string | null;
  order_number: string;
  status: PurchaseOrderStatus;
  order_date: string;
  expected_date: string | null;
  ordered_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  ordered_value: number;
  received_value: number;
  outstanding_value: number;
  last_receipt_date: string | null;
  receipt_count: number;
  // The promised date has passed and something is still outstanding. NULL
  // expected_date is never late — it is a promise nobody made.
  is_late: boolean;
}

// ---------------------------------------------------------------------------
// The reconciliation (046 §7.6)
// ---------------------------------------------------------------------------

export interface InventoryGlReconciliation {
  property_id: string;
  account_id: string;
  account_code: string;
  account_name: string;
  ledger_balance: number;
  expected_ledger_balance: number;
  // MUST BE ZERO. Anything else means a posting was skipped or doubled.
  ledger_difference: number;
  pre_gl_value: number;
  // 047: value written before this property's RPCs began posting. Code that did
  // not exist cannot have posted, so the ledger is not expected to hold it.
  pre_wiring_value: number;
  non_posting_value: number;
  unvaluable_movement_count: number;
  valuation_value: number;
  // Per-movement rounding, plus any position that has passed through negative.
  // NOT required to be zero, and never absorbed anywhere.
  valuation_difference: number;
  // 047: THE DENOMINATOR THE RESIDUE MUST BE READ AGAINST. A kobo across forty
  // movements is arithmetic; the same kobo across four thousand is not.
  valued_movement_count: number;
  // 047: positions that have EVER been below zero — the ones that actually cause
  // a divergence. NOT the same as negative_position_count, and 046 showed only
  // the latter: the fold resets the average when stock arrives INTO a negative
  // position, after which the position is usually positive again.
  reset_position_count: number;
  // Positions below zero RIGHT NOW. A different question, and the one somebody
  // acts on today.
  negative_position_count: number;
}

// One (location, item) row of the reconciliation — what turns a property-level
// number into a question somebody can answer.
export interface InventoryReconciliationPosition {
  location_id: string;
  location_name: string;
  inventory_item_id: string;
  item_name: string;
  item_code: string | null;
  base_unit: string;
  quantity_on_hand: number;
  movement_value: number;
  valuation_value: number;
  difference: number;
  movement_count: number;
  // The explanation for any difference beyond a few kobo.
  passed_through_negative: boolean;
}
