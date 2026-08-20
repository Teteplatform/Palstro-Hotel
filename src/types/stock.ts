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
// EVERY NUMERIC FIELD BELOW IS A `number`, ALREADY PARSED (rule 24). The wire
// sends numeric(p,s) as a string and int8 as a JSON number; src/lib/stock.ts
// parses both at the boundary, so nothing downstream sees either shape. The DB
// column type is still named in each comment, because it is what the precision
// and the rounding come from — but it is no longer a shape a component may
// depend on, and a string method on any of these is now a compile error.

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
//   reversal         the counter-movement reverse_stock_movement posts (038).
//                    A TYPE OF ITS OWN, deliberately, and not an adjustment: a
//                    reversal that read as an adjustment would be invisible to
//                    every variance and theft report, which is the whole reason
//                    those reports exist. Either direction — reversing a receipt
//                    removes stock, reversing an issue puts it back.
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
  | 'count_adjustment'
  | 'reversal';

// The movement types this tranche can actually write. 'reversal' is NOT here:
// it is never chosen on a form, only produced by reverse_stock_movement.
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
  // numeric(14,4) SIGNED. Positive adds to the location, negative removes from
  // it. Never zero — a table constraint refuses it.
  quantity: number;
  // numeric(14,2). Present on every stock-IN, NULL on every stock-OUT: arriving
  // stock states its cost and moves the average, leaving stock carries out the
  // average already there.
  unit_cost: number | null;
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
  // numeric(14,4). NOT floored at zero — a negative quantity is real (stock
  // that left without a movement) and is shown as such (rule 7).
  quantity_on_hand: number;
  // numeric(14,4). FOUR decimals, not two: an average of 2dp costs is not
  // itself a 2dp number, and a base unit may be a gram.
  moving_average_cost: number;
  // numeric(14,2) — money, rounded once, at the end.
  stock_value: number;
  movement_count: number;
  last_movement_date: string | null;
  // --- catalogue / location columns the view joins in ---
  item_name: string;
  item_code: string | null;
  item_type: string;
  base_unit: string;
  category_id: string | null;
  reorder_level: number | null;
  // Computed in the view so the list can filter on it SERVER-SIDE (rule 1b).
  // FALSE — never null — for an item with no reorder level: unmonitored is not
  // low, and a filter must not silently drop unmonitored items.
  is_below_reorder: boolean;
  // --- 042 -----------------------------------------------------------------
  // DECLARED HERE BECAUSE THE READ ALREADY RETURNS THEM. fetchItemPosition does
  // `select('*')`, so 042's two new view columns have been arriving on this row
  // since that migration — unparsed, because the boundary only parses the fields
  // it is told about and passes everything else through untouched. Nothing read
  // them, so nothing crashed; that is precisely the shape rule 24 exists to stop
  // (a raw wire value sitting on a row that claims to be parsed), and declaring
  // them makes the compiler demand they be listed in the boundary.
  //
  // NULL means NOT SOLD on the price, and NULL retail follows from it — never 0.
  default_selling_price: number | null;
  retail_value: number | null;
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
  quantity: number;
  unit_cost: number | null;
  business_date: string;
  reason: string | null;
  note: string | null;
  source: string;
  created_at: string;
  created_by: string | null;
  running_quantity: number;
  running_average_cost: number;
  // Signed value this movement moved: a reversal moves its carried basis, a
  // stock-in its own cost, a stock-out the cost it actually carried out.
  movement_value: number;

  // --- added by 038 --------------------------------------------------------
  // numeric(14,4). What this stock cost ON THE WAY OUT, stamped at the moment
  // it left. Present on every negative-quantity movement and on every reversal
  // (where it is the basis being unwound); NULL on a stock-in, which states its
  // cost in unit_cost instead.
  //
  // COST OF SALE IS READ FROM THIS AND NEVER RECOMPUTED (CLAUDE.md §6). No
  // screen may re-derive it from the movement history.
  carried_unit_cost: number | null;
  // The movement THIS one undoes. Non-null exactly when movement_type is
  // 'reversal'.
  reverses_movement_id: string | null;
  // The reversal that undid THIS one, derived by the view from the partial
  // unique index — there is no such column on the table, because
  // stock_movements admits no UPDATE. Non-null means "this was reversed".
  reversed_by_movement_id: string | null;
  batch_code: string | null;
  expiry_date: string | null;
}

// ---------------------------------------------------------------------------
// Negative positions (038 §9)
// ---------------------------------------------------------------------------

// A row of `stock_negative_positions`: an (item, location) holding LESS THAN
// NOTHING. Stock that left without a movement behind it.
//
// WHY THIS IS NOT THE SAME AS THE PRODUCTS TAB'S "negative" FILTER, which reads
// stock_on_hand_items — verified against the view rather than assumed. That view
// filters "deleted_at is null" on the item and the location, and does NOT filter
// is_active. So a negative behind a REMOVED item or location is visible on
// exactly one of the two surfaces: this one. A negative behind a merely
// SWITCHED-OFF parent appears on both — and is uncorrectable on both, because
// the posting RPCs require an active location and item, which is the fact this
// screen exists to state.
export interface StockNegativePositionRow {
  tenant_id: string;
  property_id: string;
  location_id: string;
  inventory_item_id: string;
  quantity_on_hand: number;
  moving_average_cost: number | null;
  stock_value: number;
  last_movement_date: string | null;
  item_name: string;
  item_code: string | null;
  base_unit: string;
  category_id: string | null;
  // A position whose item or location is switched off or removed CANNOT BE
  // CORRECTED until it is switched back on: both posting RPCs require a live,
  // active location and a live item. The screen says so rather than letting
  // someone discover it by trying.
  item_is_active: boolean;
  item_deleted_at: string | null;
  location_name: string;
  location_kind: string;
  location_is_active: boolean;
  location_deleted_at: string | null;
  category_name: string | null;
}
