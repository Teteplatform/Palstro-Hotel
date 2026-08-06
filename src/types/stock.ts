// DB row types for the stock movement ledger and its valuation views
// (supabase/migrations/036_stock_movements.sql). Keep in sync with the
// migration — no fields the schema does not have.
//
// THE MODEL, repeated here because it decides every query in src/lib/stock.ts:
// there is NO stored quantity anywhere. An item's stock in a location IS the sum
// of its movements there, and its value is that quantity at the weighted-average
// cost folded from the same movements. Everything below is either a movement or
// something computed from movements on read (CLAUDE.md rule 6).
//
// §6: every numeric column arrives from PostgREST as a STRING, never a JS
// number, so the precision a numeric(14,4) carries is not silently lost. Parse
// with parseNumeric before any arithmetic or comparison — `typeof col ===
// 'number'` is always false here.

// ---------------------------------------------------------------------------
// Movements
// ---------------------------------------------------------------------------

// The FULL set the table accepts (036 §1). Only 'opening' and 'adjustment' have
// a write path today; the rest are declared so later tranches add a posting
// path rather than reshaping a table that by then holds live history.
//
//   opening          the day-one balance. Once per item per location.
//   adjustment       a correction, either direction, reason mandatory.
//   receipt          stock received from a purchase.            (2c)
//   issue_out        stock leaving a store on a requisition.    (part 3)
//   issue_in         the matching arrival in the requester.     (part 3)
//   transfer_out     stock leaving a location on a transfer.    (part 3)
//   transfer_in      the matching arrival.                      (part 3)
//   consumption      recipe-driven deduction from an F&B sale.  (later)
//   wastage          spoilage/breakage written off.             (later)
//   count_adjustment the variance a physical count posts.       (later)
export type MovementType =
  | 'opening'
  | 'adjustment'
  | 'receipt'
  | 'issue_out'
  | 'issue_in'
  | 'transfer_out'
  | 'transfer_in'
  | 'consumption'
  | 'wastage'
  | 'count_adjustment';

// The movement types this tranche can actually write.
export type WritableMovementType = Extract<
  MovementType,
  'opening' | 'adjustment'
>;

export interface StockMovement {
  id: string;
  // Identity sequence — REAL INSERTION ORDER, and the fold's tiebreak within one
  // business_date (036 §1). Every ordered read of movements must be
  // `business_date, seq`: weighted-average cost is path-dependent, and
  // created_at cannot break the tie because it is the transaction clock.
  seq: number;
  tenant_id: string;
  property_id: string;
  location_id: string;
  inventory_item_id: string;
  movement_type: MovementType;
  // numeric(14,4) SIGNED, as a string (§6). Positive adds to the location,
  // negative removes from it. Never zero — a table constraint refuses it.
  quantity: string;
  // numeric(14,2) as a string (§6). Present on every stock-IN, NULL on every
  // stock-OUT: arriving stock states its cost and moves the average, leaving
  // stock carries out the average already there.
  unit_cost: string | null;
  // The OPERATING DAY (rules 8/12), in the property's timezone. Never created_at.
  business_date: string;
  reason: string | null;
  note: string | null;
  // Free text: 'manual', 'import', later 'purchase'/'requisition'/'fnb'.
  source: string;
  source_document_type: string | null;
  source_document_id: string | null;
  idempotency_key: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  // Always NULL, and that NULL is meaningful: movements are immutable, so a
  // never-set updated_by is the guarantee that this row has not been touched
  // since it was written.
  updated_by: string | null;
}

// ---------------------------------------------------------------------------
// On-hand + valuation (computed views — nothing here is stored)
// ---------------------------------------------------------------------------

// A row of `stock_on_hand_items` (036 §3.2): one item in one location, with the
// catalogue columns the list shows and filters on.
export interface StockOnHandRow {
  tenant_id: string;
  property_id: string;
  location_id: string;
  inventory_item_id: string;
  // numeric(14,4) as a string. NOT floored at zero — a negative quantity is
  // real (stock that left without a movement) and is shown as such (rule 7).
  quantity_on_hand: string;
  // numeric(14,4) as a string. FOUR decimals, not two: an average of 2dp costs
  // is not itself a 2dp number, and a base unit may be a gram.
  moving_average_cost: string;
  // numeric(14,2) as a string — money, rounded once, at the end.
  stock_value: string;
  movement_count: number;
  last_movement_date: string | null;
  // --- catalogue / location columns the view joins in ---
  item_name: string;
  item_code: string | null;
  item_type: string;
  base_unit: string;
  category_id: string | null;
  reorder_level: string | null;
  // Computed in the view so the list can filter on it SERVER-SIDE (rule 1b).
  // FALSE — never null — for an item with no reorder level: unmonitored is not
  // low, and a filter must not silently drop unmonitored items.
  is_below_reorder: boolean;
  item_is_active: boolean;
  category_name: string | null;
  location_name: string;
  location_kind: string;
}

// A row of `stock_movement_ledger` (036 §3.4): one movement with the running
// position AS AT that movement — the working behind the current valuation.
// The running average is the same server-side fold, never a client recompute.
export interface StockLedgerRow {
  id: string;
  tenant_id: string;
  property_id: string;
  location_id: string;
  inventory_item_id: string;
  seq: number;
  movement_type: MovementType;
  quantity: string;
  unit_cost: string | null;
  business_date: string;
  reason: string | null;
  note: string | null;
  source: string;
  created_at: string;
  created_by: string | null;
  running_quantity: string;
  running_average_cost: string;
  // Signed value this movement moved: in = quantity × its own cost,
  // out = quantity × the average it left at.
  movement_value: string;
}
