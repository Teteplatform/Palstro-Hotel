import { supabase } from './supabase';
import { fetchAllPagedRows } from './fetchAllPaged';
import { boundary } from './rowParse';
// ONE definition of the rule-2 key for the whole app. Re-declaring
// crypto.randomUUID() here would be a second place for the "fresh key per submit
// intent" convention to drift from, and rules 2/3 are the last thing that should
// have two implementations.
import { newIdempotencyKey } from './folio';
import type {
  MovementType,
  StockLedgerRow,
  StockMovement,
  StockNegativePositionRow,
  StockOnHandRow,
} from '../types/stock';

export { newIdempotencyKey };

// The data layer for stock on hand, its valuation and the two write RPCs
// (F&B/Inventory part 2a, migration 036).
//
// THE ONE HARD RULE, INHERITED FROM 036: nothing here writes stock_movements
// directly. The table has NO write RLS policy at all, by design — a direct
// INSERT would bypass the staff gate, the location/item validation, the
// future-date guard, the once-per-location opening rule, the cost defaulting and
// the negative-stock confirmation, every one of which is what makes the number
// on the screen trustworthy. Every mutation goes through a SECURITY DEFINER RPC.
//
// AND NOTHING HERE RECOMPUTES A QUANTITY OR AN AVERAGE COST. On-hand, the
// moving average, the stock value and the running figures in the ledger all come
// from the database, which folds them from the movements on every read (rule 6 —
// no cached balance, and 022's warning about re-implementing an engine rule in
// TypeScript, where the second implementation drifts from the first and the
// working shown disagrees with the number shown while nothing errors). The only
// arithmetic in this file is summing a column of already-computed values for a
// rule-20 total.
//
// Compliance:
//   - Rule 1b: the stock list pages SERVER-SIDE via .range() with an exact
//     count, and EVERY filter is applied server-side, so the page, the count and
//     the total always describe the same set.
//   - Rule 1a: reads consumed in full (the summary, one item's ledger) go
//     through fetchAllPaged — never a bare unbounded select, never a bare .in().
//   - Rule 19: RLS restricts to the user's tenants; every read here
//     ADDITIONALLY scopes to the active tenant AND property.
//   - Rule 20: the totals span the WHOLE FILTERED SET, computed by a separate
//     query using the SAME filter builder — never summed from the visible page.
//   - Rule 11: every call is awaited and throws; the caller surfaces the error.
//   - Rule 24: every read below parses its numeric fields HERE, once, so no
//     component ever holds a raw PostgREST value.

// ---------------------------------------------------------------------------
// The boundaries (rule 24)
// ---------------------------------------------------------------------------
//
// Each names its READ, then every numeric key of the row type, split by whether
// the type admits null. The lists are checked for completeness by the compiler:
// add a numeric column to one of these row types and the build fails here until
// it is parsed. See src/lib/rowParse.ts.
//
// TWO OF THEM ARE EXPORTED, and that is the seam rule 22 asks for rather than a
// copy: proofs/movementsRender and proofs/ledgerRender push RAW WIRE ROWS —
// numerics as strings, then the same numerics as JSON numbers — through THESE
// parsers and render the result with the real components. A proof that declared
// its own boundary would prove its own boundary.

export const movementRows = boundary<StockMovement>('stock_movements')(
  ['seq', 'quantity'] as const,
  ['unit_cost'] as const,
);

export const onHandRows = boundary<StockOnHandRow>('stock_on_hand_items')(
  ['quantity_on_hand', 'moving_average_cost', 'stock_value', 'movement_count'] as const,
  ['reorder_level'] as const,
);

export const ledgerRows = boundary<StockLedgerRow>('stock_movement_ledger')(
  [
    'seq',
    'quantity',
    'running_quantity',
    'running_average_cost',
    'movement_value',
  ] as const,
  ['unit_cost', 'carried_unit_cost'] as const,
);

const negativeRows = boundary<StockNegativePositionRow>('stock_negative_positions')(
  ['quantity_on_hand', 'stock_value'] as const,
  ['moving_average_cost'] as const,
);

// ---------------------------------------------------------------------------
// Errors — the stock surfaces must show the RPC's OWN message
// ---------------------------------------------------------------------------

// The custom SQLSTATEs 036 raises, named so callers branch on a constant rather
// than on a magic string. Same convention as the settings engine (008) and the
// media RPCs.
export const STOCK_NOT_FOUND = 'PT404';
export const STOCK_FORBIDDEN = 'PT403';
export const STOCK_CONFLICT = 'PT409';
export const STOCK_INVALID = 'PT422';
// "Retry with confirmation": the adjustment is legal but would drive on-hand
// below zero, so the server refuses it once and asks. Re-submit with
// allowNegative: true and the SAME idempotency key — which is what stops the
// confirmation from posting a second movement.
export const STOCK_NEEDS_CONFIRMATION = 'PT449';
// The property's books are closed through posting_locked_through (038 §4), so a
// movement dated on or before it is refused. A BRANCHING CONSTANT ONLY — the
// sentence the user reads is the server's, which names both the lock date and
// the date they tried to post to. Nothing in this client re-states that rule.
export const STOCK_LOCKED = 'PT423';

interface PostgrestLikeError {
  code?: string;
  message?: string;
  hint?: string;
}

// humanizeError (lib/errors.ts) replaces codes with soft generic copy, which is
// right for an RLS denial on a table write and WRONG here: 036 raises PT422 for
// "a reason is required", "a unit cost cannot be given when removing stock" and
// "this item has no stock history in this location, so a unit cost is required"
// — three different, actionable sentences the storekeeper has to read verbatim
// to fix what they typed. So: prefer the server's message, always.
//
// THE HINT IS APPENDED, exactly as folioErrorMessage does — one behaviour across
// the product, not two. This is load-bearing rather than tidy: 038 deliberately
// splits every refusal in half, putting THE RULE in the message and THE WAY OUT
// in the RAISE hint.
//
//   message: 'An opening balance cannot be reversed — it is the starting line…'
//   hint:    'Post an adjustment for the difference instead. Before anything
//             else has moved, the average still equals the opening cost…'
//
//   message: 'Reversing this movement would put stock back, but the location
//             "Main Store" is switched off…'
//   hint:    'Switch it back on (or restore it) first, then reverse the movement.'
//
// Dropping the hint would show the user "no" without "instead" — and the
// pressure would then be to write the instruction into a component, which is
// precisely the second source of truth that drifts the first time the rule
// changes. Appending it is what makes "the client never restates a rule"
// achievable rather than aspirational.
export function stockErrorMessage(e: unknown): string {
  const err = e as PostgrestLikeError | null;
  const message = err?.message?.trim();
  if (message) {
    const hint = err?.hint?.trim();
    return hint ? `${message} — ${hint}` : message;
  }
  return 'Something went wrong. Please try again.';
}

export function stockErrorCode(e: unknown): string | undefined {
  return (e as PostgrestLikeError | null)?.code;
}

// ---------------------------------------------------------------------------
// Filters — ONE builder, used by the list AND by the totals
// ---------------------------------------------------------------------------

// The on-hand state a user can narrow to. Every one of these is a server-side
// predicate on a real column (is_below_reorder is computed in the view precisely
// so "low stock" can be one too) — nothing is filtered client-side, because a
// client-side filter over a fetched page would make "of N" and the total lie.
export type StockState = '' | 'in_stock' | 'low' | 'zero' | 'negative';

export interface StockFilters {
  // Free text over item name and code.
  search: string;
  categoryId: string;
  state: StockState;
}

export const EMPTY_STOCK_FILTERS: StockFilters = {
  search: '',
  categoryId: '',
  state: '',
};

export function hasStockFilters(f: StockFilters): boolean {
  return Boolean(f.search) || Boolean(f.categoryId) || Boolean(f.state);
}

// THE SINGLE FILTER IMPLEMENTATION. The page query and the totals query both go
// through this, which is what makes "the total for this filter" honest rather
// than a second, drifting definition of the same set (the shape
// applyBookingFilters uses for the same reason).
function applyStockFilters(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query: any,
  tenantId: string,
  propertyId: string,
  locationId: string,
  filters: StockFilters,
) {
  let q = query
    .eq('tenant_id', tenantId) // rule 19 — RLS is the floor, not the ceiling
    .eq('property_id', propertyId) // rule 19
    .eq('location_id', locationId);

  const search = filters.search.trim().replace(/[,()*]/g, ' ').trim();
  if (search.length > 0) {
    // PostgREST's or() takes a comma-separated filter list, so commas and parens
    // in the term would be read as syntax. Stripped rather than escaped, as
    // fetchInventoryItemsPage and fetchCompaniesPage do.
    q = q.or(`item_name.ilike.%${search}%,item_code.ilike.%${search}%`);
  }

  if (filters.categoryId) q = q.eq('category_id', filters.categoryId);

  switch (filters.state) {
    case 'in_stock':
      q = q.gt('quantity_on_hand', 0);
      break;
    case 'low':
      // At or below the reorder level. Items with no reorder level are FALSE in
      // the view (not null), so they are excluded here rather than dropped by a
      // NULL comparison that would fail silently.
      q = q.eq('is_below_reorder', true);
      break;
    case 'zero':
      q = q.eq('quantity_on_hand', 0);
      break;
    case 'negative':
      // Less than nothing on hand: stock that left with no movement behind it.
      // The single most important thing this screen can surface, so it is a
      // first-class filter rather than something to spot by eye.
      q = q.lt('quantity_on_hand', 0);
      break;
    default:
      break;
  }

  return q;
}

// ---------------------------------------------------------------------------
// The list (rule 1b)
// ---------------------------------------------------------------------------

export interface StockPage {
  rows: StockOnHandRow[];
  count: number; // exact total for the CURRENT FILTER, not the page length
}

// One SERVER-PAGINATED, SERVER-FILTERED page of a location's stock. `page` is
// 1-based. Ordered by item name, because a storekeeper looks stock up
// alphabetically ("where is the rice?"), with the item id as a stable tiebreak
// so two items sharing a name can never swap between pages.
export async function fetchStockPage(
  tenantId: string,
  propertyId: string,
  locationId: string,
  page: number,
  pageSize: number,
  filters: StockFilters = EMPTY_STOCK_FILTERS,
): Promise<StockPage> {
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  const base = supabase
    .from('stock_on_hand_items')
    .select('*', { count: 'exact' });

  const { data, error, count } = await applyStockFilters(
    base,
    tenantId,
    propertyId,
    locationId,
    filters,
  )
    .order('item_name', { ascending: true })
    .order('inventory_item_id', { ascending: true })
    .range(from, to);

  if (error) throw error;
  return { rows: onHandRows.rows(data), count: count ?? 0 };
}

// ---------------------------------------------------------------------------
// The totals (rule 20 — the FILTER, never the page)
// ---------------------------------------------------------------------------

export interface StockSummary {
  // How many (item, location) positions match the filter.
  itemCount: number;
  // Total stock value across every matching position. THE meaningful total on
  // this screen: unlike a quantity — which sums kilograms and bottles into a
  // number with no unit and no meaning — money adds up across items.
  totalValue: number;
  // Counts worth surfacing beside the total, both across the whole filter.
  negativeCount: number;
  belowReorderCount: number;
}

// The summary across the WHOLE FILTERED SET (rule 20), never the visible page.
// A SEPARATE query from the page fetch, through the SAME applyStockFilters, so
// the total and the rows provably describe the same stock.
//
// Each row's stock_value is computed BY THE DATABASE from the movements (036
// §3.1); this only adds an already-correct column up, which is why the sum is
// not a second implementation of the valuation.
export async function fetchStockSummary(
  tenantId: string,
  propertyId: string,
  locationId: string,
  filters: StockFilters = EMPTY_STOCK_FILTERS,
): Promise<StockSummary> {
  interface SummaryRow {
    inventory_item_id: string;
    quantity_on_hand: number;
    stock_value: number;
    is_below_reorder: boolean;
  }

  // The narrow projection gets its OWN boundary rather than borrowing onHand's:
  // a boundary describes the columns a read actually selects, and one naming
  // columns this query never asked for would throw on every row.
  const summaryRows = boundary<SummaryRow>('stock_on_hand_items (summary)')(
    ['quantity_on_hand', 'stock_value'] as const,
    [] as const,
  );

  // Paged, not a capped read (rule 1a): the total must cover every matching
  // row, so nothing may be truncated at a row cap.
  const rows = await fetchAllPagedRows<SummaryRow>(summaryRows, (from, to) => {
    const base = supabase
      .from('stock_on_hand_items')
      // Only the columns the aggregate needs.
      .select('inventory_item_id, quantity_on_hand, stock_value, is_below_reorder');
    return applyStockFilters(base, tenantId, propertyId, locationId, filters)
      .order('inventory_item_id', { ascending: true }) // unique → stable paging
      .range(from, to);
  });

  let totalValue = 0;
  let negativeCount = 0;
  let belowReorderCount = 0;

  for (const row of rows) {
    // Already numbers — the boundary parsed them on the way in (rule 24), and a
    // row whose figures could not be parsed never reached this loop.
    totalValue += row.stock_value;
    if (row.quantity_on_hand < 0) negativeCount += 1;
    if (row.is_below_reorder) belowReorderCount += 1;
  }

  return {
    itemCount: rows.length,
    totalValue,
    negativeCount,
    belowReorderCount,
  };
}

// Every row matching the current filter, across ALL pages — what Export writes
// (rule 20: filters apply, pagination does not). fetchAllPaged, so nothing is
// truncated at a row cap: an export that quietly stopped at the first thousand
// rows would be a count sheet with items missing, which is worse than no export.
export async function fetchStockForExport(
  tenantId: string,
  propertyId: string,
  locationId: string,
  filters: StockFilters = EMPTY_STOCK_FILTERS,
): Promise<StockOnHandRow[]> {
  return fetchAllPagedRows<StockOnHandRow>(onHandRows, (from, to) => {
    const base = supabase.from('stock_on_hand_items').select('*');
    return applyStockFilters(base, tenantId, propertyId, locationId, filters)
      .order('item_name', { ascending: true })
      .order('inventory_item_id', { ascending: true }) // unique → stable paging
      .range(from, to);
  });
}

// ---------------------------------------------------------------------------
// One item's position, and one item's ledger
// ---------------------------------------------------------------------------

// The current position of ONE item in ONE location, or null when it has never
// moved there. The entry form reads it the moment an item is picked, so the
// person about to post can see what the system currently believes BEFORE they
// change it — which is the difference between correcting a figure and guessing
// at one.
export async function fetchItemPosition(
  tenantId: string,
  propertyId: string,
  locationId: string,
  inventoryItemId: string,
): Promise<StockOnHandRow | null> {
  const { data, error } = await supabase
    .from('stock_on_hand_items')
    .select('*')
    .eq('tenant_id', tenantId) // rule 19
    .eq('property_id', propertyId) // rule 19
    .eq('location_id', locationId)
    .eq('inventory_item_id', inventoryItemId)
    .maybeSingle();

  if (error) throw error;
  return onHandRows.maybeRow(data);
}

// Every movement of ONE item in ONE location, oldest first, each carrying the
// running quantity and running average cost as at that movement (036 §3.4).
//
// NOT a capped read and NOT a paged surface: rule 1b forbids a CAPPED list with
// no way to reach the rest, and fetchAllPaged returns the COMPLETE history, so
// nothing is unreachable. That completeness is the point — a valuation trail
// missing its middle proves nothing.
//
// Ordered by (business_date, seq): the business timeline first (rule 8), then
// real insertion order. This is the SAME order the server folds in, so the
// running figures read down the screen in the order they were computed.
export async function fetchItemLedger(
  tenantId: string,
  propertyId: string,
  locationId: string,
  inventoryItemId: string,
): Promise<StockLedgerRow[]> {
  return fetchAllPagedRows<StockLedgerRow>(ledgerRows, (from, to) =>
    supabase
      .from('stock_movement_ledger')
      .select('*')
      .eq('tenant_id', tenantId) // rule 19
      .eq('property_id', propertyId) // rule 19
      .eq('location_id', locationId)
      .eq('inventory_item_id', inventoryItemId)
      .order('business_date', { ascending: true }) // rule 8: business date
      .order('seq', { ascending: true }) // the fold's own tiebreak
      .range(from, to),
  );
}

// ---------------------------------------------------------------------------
// The write RPCs (rules 2, 3, 11)
// ---------------------------------------------------------------------------

export interface OpeningBalanceInput {
  propertyId: string;
  locationId: string;
  inventoryItemId: string;
  // A JS number here; the columns are numeric and come BACK as strings (§6).
  quantity: number;
  unitCost: number;
  // ISO yyyy-mm-dd, or null for "the property's local today" (resolved
  // server-side in the property's timezone — rules 8/12).
  businessDate: string | null;
  note: string | null;
  // Rules 2/3. For the spreadsheet import this is derived from the FILE'S OWN
  // CONTENT, so re-uploading the same file replays instead of double-loading.
  idempotencyKey: string;
  // 038 §1C. REQUIRED by the server when the item's tracks_expiry is set, and
  // meaningless otherwise. Optional here so every existing caller is unchanged:
  // both parameters carry SQL defaults, so an omitted key resolves to NULL.
  batchCode?: string | null;
  expiryDate?: string | null;
}

export async function postOpeningBalance(
  input: OpeningBalanceInput,
): Promise<StockMovement> {
  const { data, error } = await supabase.rpc('post_opening_balance', {
    p_property_id: input.propertyId,
    p_location_id: input.locationId,
    p_inventory_item_id: input.inventoryItemId,
    p_quantity: input.quantity,
    p_unit_cost: input.unitCost,
    p_business_date: input.businessDate,
    p_note: input.note,
    p_idempotency_key: input.idempotencyKey,
    p_batch_code: input.batchCode ?? null,
    p_expiry_date: input.expiryDate ?? null,
  });

  if (error) throw error; // rule 11 — never swallowed; the caller surfaces it
  // An RPC's return crosses the same boundary as a select: post_opening_balance
  // returns the stock_movements row, quantity and all (rule 24).
  return movementRows.row(data);
}

export interface StockAdjustmentInput {
  propertyId: string;
  locationId: string;
  inventoryItemId: string;
  // SIGNED: positive adds to the location, negative removes from it.
  quantity: number;
  // Mandatory. An adjustment moves stock with no purchase and no sale behind
  // it; the server refuses a blank reason and the table constraint refuses it
  // again underneath.
  reason: string;
  businessDate: string | null;
  // Positive adjustments only, and OPTIONAL: null means "the current moving
  // average", which leaves the average where it is. A cost on a negative
  // adjustment is REFUSED by the server rather than ignored.
  unitCost: number | null;
  idempotencyKey: string;
  // Re-submit after a PT449 with the SAME key to record a result below zero.
  allowNegative?: boolean;
  // 038 §1C. Required by the server on a stock-IN of a batch-tracked item, and
  // REFUSED on a stock-out — which batch left is an issue-rules decision, not a
  // typed one, so a guess here would put a wrong answer into the history a
  // recall will read.
  batchCode?: string | null;
  expiryDate?: string | null;
}

export async function postStockAdjustment(
  input: StockAdjustmentInput,
): Promise<StockMovement> {
  const { data, error } = await supabase.rpc('post_stock_adjustment', {
    p_property_id: input.propertyId,
    p_location_id: input.locationId,
    p_inventory_item_id: input.inventoryItemId,
    p_quantity: input.quantity,
    p_reason: input.reason,
    p_business_date: input.businessDate,
    p_unit_cost: input.unitCost,
    p_idempotency_key: input.idempotencyKey,
    p_allow_negative: input.allowNegative ?? false,
    p_batch_code: input.batchCode ?? null,
    p_expiry_date: input.expiryDate ?? null,
  });

  if (error) throw error;
  return movementRows.row(data);
}

// ---------------------------------------------------------------------------
// Reversing a movement (038 §7)
// ---------------------------------------------------------------------------

export interface ReverseMovementInput {
  movementId: string;
  // Mandatory and non-blank. Kept permanently on the counter-movement and on
  // the reversals audit row.
  reason: string;
  // Required ALWAYS, with no threshold. Held in component state for the length
  // of one call and cleared in a finally block — never stored anywhere.
  managerPin: string;
  // Rules 2/3. OPTIONAL, and the distinction matters: a key the caller supplies
  // means "this is one request of mine, possibly retried", and the server
  // replays it. Omitting it means "reverse this", and the server answers with
  // the state — it was already reversed, on such-and-such a day. The UI omits
  // it, because a person pressing the button twice is asking twice.
  idempotencyKey?: string;
}

// Returns the COUNTER-MOVEMENT, not the original. The original is untouched —
// movements are permanent, and the counter is what moves the stock back.
export async function reverseStockMovement(
  input: ReverseMovementInput,
): Promise<StockMovement> {
  const { data, error } = await supabase.rpc('reverse_stock_movement', {
    p_movement_id: input.movementId,
    p_reason: input.reason,
    p_manager_pin: input.managerPin,
    p_idempotency_key: input.idempotencyKey ?? null,
  });

  if (error) throw error; // rule 11 — the caller surfaces the server's own words
  return movementRows.row(data);
}

// ---------------------------------------------------------------------------
// Movement lists (the Adjustments and Import History tabs)
// ---------------------------------------------------------------------------

// What a movement list can be narrowed by. Every one is a server-side predicate
// on a real stock_movements column, so the page, the count and the filter always
// describe the same set (rule 1b).
//
// THERE IS DELIBERATELY NO FREE-TEXT SEARCH HERE. stock_movements carries no
// item name — the name lives in the catalogue — and PostgREST cannot filter a
// list on a column it is not selecting from. A client-side name search over a
// fetched page would make "of N" a lie, so the item is chosen from a picker
// instead, which filters on inventory_item_id and is exact.
export interface MovementFilters {
  locationId: string;
  inventoryItemId: string;
  // Business dates (rules 8/12) — the operating day the movement belongs to,
  // never created_at.
  fromDate: string;
  toDate: string;
  // '' = either way. Adjustments go in both directions and which one matters:
  // stock written OFF is the direction worth watching.
  direction: '' | 'in' | 'out';
}

export const EMPTY_MOVEMENT_FILTERS: MovementFilters = {
  locationId: '',
  inventoryItemId: '',
  fromDate: '',
  toDate: '',
  direction: '',
};

export function hasMovementFilters(f: MovementFilters): boolean {
  return (
    Boolean(f.locationId) ||
    Boolean(f.inventoryItemId) ||
    Boolean(f.fromDate) ||
    Boolean(f.toDate) ||
    Boolean(f.direction)
  );
}

export interface MovementsPage {
  rows: StockMovement[];
  count: number; // exact total for the FILTER, not the page length
}

// One SERVER-PAGINATED page of movements of one type. `page` is 1-based.
//
// ORDERED BY BUSINESS DATE, DESCENDING (rule 8): the operating day the movement
// belongs to, most recent first, because a correction posted today for last
// Tuesday belongs where it happened. `seq` breaks the tie in real insertion
// order — the same total order the valuation folds in (036 §1), and the only one
// that is stable across reads.
export async function fetchMovementsPage(
  tenantId: string,
  propertyId: string,
  movementType: MovementType,
  page: number,
  pageSize: number,
  filters: MovementFilters = EMPTY_MOVEMENT_FILTERS,
): Promise<MovementsPage> {
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  let q = supabase
    .from('stock_movements')
    .select('*', { count: 'exact' })
    .eq('tenant_id', tenantId) // rule 19
    .eq('property_id', propertyId) // rule 19
    .eq('movement_type', movementType);

  if (filters.locationId) q = q.eq('location_id', filters.locationId);
  if (filters.inventoryItemId) q = q.eq('inventory_item_id', filters.inventoryItemId);
  if (filters.fromDate) q = q.gte('business_date', filters.fromDate);
  if (filters.toDate) q = q.lte('business_date', filters.toDate);
  if (filters.direction === 'in') q = q.gt('quantity', 0);
  if (filters.direction === 'out') q = q.lt('quantity', 0);

  const { data, error, count } = await q
    .order('business_date', { ascending: false }) // rule 8
    .order('seq', { ascending: false }) // the fold's own tiebreak
    .range(from, to);

  if (error) throw error;
  return { rows: movementRows.rows(data), count: count ?? 0 };
}

// Every movement matching the filter, across all pages — what Export writes
// (rule 20: filters apply, pagination does not).
export async function fetchMovementsForExport(
  tenantId: string,
  propertyId: string,
  movementType: MovementType,
  filters: MovementFilters = EMPTY_MOVEMENT_FILTERS,
): Promise<StockMovement[]> {
  return fetchAllPagedRows<StockMovement>(movementRows, (from, to) => {
    let q = supabase
      .from('stock_movements')
      .select('*')
      .eq('tenant_id', tenantId) // rule 19
      .eq('property_id', propertyId) // rule 19
      .eq('movement_type', movementType);

    if (filters.locationId) q = q.eq('location_id', filters.locationId);
    if (filters.inventoryItemId) q = q.eq('inventory_item_id', filters.inventoryItemId);
    if (filters.fromDate) q = q.gte('business_date', filters.fromDate);
    if (filters.toDate) q = q.lte('business_date', filters.toDate);
    if (filters.direction === 'in') q = q.gt('quantity', 0);
    if (filters.direction === 'out') q = q.lt('quantity', 0);

    return q
      .order('business_date', { ascending: false })
      .order('seq', { ascending: false }) // unique → stable range pagination
      .range(from, to);
  });
}

// ---------------------------------------------------------------------------
// Helpers the import and the manual form share
// ---------------------------------------------------------------------------

// The key an (item, location) pair is looked up by in the set below.
export function openingKey(locationId: string, itemId: string): string {
  return `${locationId}:${itemId}`;
}

// Which (location, item) pairs ALREADY have an opening balance in this property.
// The import's validation pass shows those rows as "will be skipped" BEFORE
// anything is written, rather than letting the user press Import and collect a
// wall of PT409s (036 §4.1 refuses a second opening structurally, so the
// alternative is not a double-load — it is a confusing pile of errors).
//
// Property-wide rather than per-location because an import file may name several
// locations in its Location column.
//
// fetchAllPaged (rule 1a): the whole set is consumed to build a lookup, so it
// must be complete — a capped read would report "no opening balance" for rows
// that have one.
export async function fetchOpeningBalanceKeys(
  tenantId: string,
  propertyId: string,
): Promise<Set<string>> {
  interface Row {
    location_id: string;
    inventory_item_id: string;
  }
  // No numeric column in the projection, and the boundary still runs: it is
  // what makes "every read is parsed" checkable rather than a habit.
  const keys = boundary<Row>('stock_movements (opening keys)')([] as const, [] as const);
  const rows = await fetchAllPagedRows<Row>(keys, (from, to) =>
    supabase
      .from('stock_movements')
      .select('location_id, inventory_item_id')
      .eq('tenant_id', tenantId) // rule 19
      .eq('property_id', propertyId) // rule 19
      .eq('movement_type', 'opening')
      .order('id', { ascending: true }) // unique → stable range pagination
      .range(from, to),
  );
  return new Set(rows.map((r) => openingKey(r.location_id, r.inventory_item_id)));
}

// ---------------------------------------------------------------------------
// Negative positions (038 §9) — the discrepancy screen
// ---------------------------------------------------------------------------
//
// WHY THIS IS ITS OWN READ AND NOT ANOTHER StockFilters STATE. The Products tab
// already has a `state: 'negative'` filter over stock_on_hand_items, and it
// stays — it is the quick view while you are looking at one location's stock.
// THE EXACT DIFFERENCE, verified against the view rather than assumed.
// stock_on_hand_items filters "deleted_at is null" on the item, the location and
// the category, and does NOT filter is_active. So:
//
//   * a negative behind a REMOVED item or location is invisible to the Products
//     tab and visible ONLY here. That is what this screen is for.
//   * a negative behind a SWITCHED-OFF parent appears on BOTH. It is still
//     uncorrectable — the posting RPCs require an ACTIVE location and item — and
//     this surface is the one that says so.
//
// stock_negative_positions filters neither, by design: a discrepancy report that
// could hide a row would be the wrong tool for the only job it has.
//
// It is also PROPERTY-WIDE rather than per-location: a negative is a question
// about the property, and asking it one location at a time is how one gets
// missed.

export interface NegativeFilters {
  // Free text over item name and code.
  search: string;
  categoryId: string;
  locationId: string;
  // Narrow to the positions that cannot be corrected until something is
  // switched back on. A server-side predicate, like every other filter here.
  onlyUncorrectable: boolean;
}

export const EMPTY_NEGATIVE_FILTERS: NegativeFilters = {
  search: '',
  categoryId: '',
  locationId: '',
  onlyUncorrectable: false,
};

export function hasNegativeFilters(f: NegativeFilters): boolean {
  return (
    Boolean(f.search) ||
    Boolean(f.categoryId) ||
    Boolean(f.locationId) ||
    f.onlyUncorrectable
  );
}

// THE SINGLE FILTER IMPLEMENTATION for this surface — the page, the totals and
// the export all go through it, so all three provably describe the same set
// (rules 1b and 20).
function applyNegativeFilters(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query: any,
  tenantId: string,
  propertyId: string,
  filters: NegativeFilters,
) {
  let q = query
    .eq('tenant_id', tenantId) // rule 19 — RLS is the floor, not the ceiling
    .eq('property_id', propertyId); // rule 19

  const search = filters.search.trim().replace(/[,()*]/g, ' ').trim();
  if (search.length > 0) {
    // Commas and parens are PostgREST or() syntax; stripped rather than
    // escaped, exactly as applyStockFilters does.
    q = q.or(`item_name.ilike.%${search}%,item_code.ilike.%${search}%`);
  }

  if (filters.categoryId) q = q.eq('category_id', filters.categoryId);
  if (filters.locationId) q = q.eq('location_id', filters.locationId);

  if (filters.onlyUncorrectable) {
    // Any of the four states that leave a position with no write path. Rule 5's
    // NULL-safe direction applies to the two deleted_at columns: "removed" is
    // `not.is.null`, so a row where the flag was never set is correctly NOT
    // matched rather than silently swept in.
    q = q.or(
      'item_is_active.is.false,location_is_active.is.false,' +
        'item_deleted_at.not.is.null,location_deleted_at.not.is.null',
    );
  }

  return q;
}

export interface NegativePositionsPage {
  rows: StockNegativePositionRow[];
  count: number; // exact total for the CURRENT FILTER, not the page length
}

// One SERVER-PAGINATED, SERVER-FILTERED page. `page` is 1-based.
//
// Ordered MOST NEGATIVE FIRST, which is the ordering this screen wants: the
// biggest hole is the one to explain first, and an alphabetical list of
// discrepancies buries it. (location_id, inventory_item_id) is the stable
// tiebreak — a unique pair — so two equally-negative rows can never swap
// between pages.
export async function fetchNegativePositionsPage(
  tenantId: string,
  propertyId: string,
  page: number,
  pageSize: number,
  filters: NegativeFilters = EMPTY_NEGATIVE_FILTERS,
): Promise<NegativePositionsPage> {
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  const base = supabase
    .from('stock_negative_positions')
    .select('*', { count: 'exact' });

  const { data, error, count } = await applyNegativeFilters(
    base,
    tenantId,
    propertyId,
    filters,
  )
    .order('quantity_on_hand', { ascending: true })
    .order('location_id', { ascending: true })
    .order('inventory_item_id', { ascending: true })
    .range(from, to);

  if (error) throw error;
  return { rows: negativeRows.rows(data), count: count ?? 0 };
}

export interface NegativeSummary {
  // How many (item, location) positions match the filter.
  positionCount: number;
  // Of those, how many cannot be corrected until something is switched back on.
  uncorrectableCount: number;
  // The value of the shortfall across the whole filter — negative, because the
  // quantities are. What the missing stock would have been worth.
  totalValue: number;
}

// The summary across the WHOLE FILTERED SET (rule 20), never the visible page.
// A SEPARATE query through the SAME filter builder, for the reason
// fetchStockSummary states: a total summed from the visible page is a wrong
// number presented with confidence.
export async function fetchNegativeSummary(
  tenantId: string,
  propertyId: string,
  filters: NegativeFilters = EMPTY_NEGATIVE_FILTERS,
): Promise<NegativeSummary> {
  interface SummaryRow {
    location_id: string;
    inventory_item_id: string;
    stock_value: number;
    item_is_active: boolean;
    location_is_active: boolean;
    item_deleted_at: string | null;
    location_deleted_at: string | null;
  }

  const summaryRows = boundary<SummaryRow>('stock_negative_positions (summary)')(
    ['stock_value'] as const,
    [] as const,
  );

  // Paged (rule 1a): a total that stopped at a row cap would understate the
  // shortfall, which is the one direction this figure must never err in.
  const rows = await fetchAllPagedRows<SummaryRow>(summaryRows, (from, to) => {
    const base = supabase
      .from('stock_negative_positions')
      .select(
        'location_id, inventory_item_id, stock_value, item_is_active, ' +
          'location_is_active, item_deleted_at, location_deleted_at',
      );
    return applyNegativeFilters(base, tenantId, propertyId, filters)
      .order('location_id', { ascending: true })
      .order('inventory_item_id', { ascending: true }) // unique pair → stable paging
      .range(from, to);
  });

  let totalValue = 0;
  let uncorrectableCount = 0;

  for (const row of rows) {
    // Already a number (rule 24).
    totalValue += row.stock_value;
    if (isUncorrectable(row)) uncorrectableCount += 1;
  }

  return { positionCount: rows.length, uncorrectableCount, totalValue };
}

// Every row matching the current filter, across ALL pages — what Export writes
// (rule 20: filters apply, pagination does not).
export async function fetchNegativePositionsForExport(
  tenantId: string,
  propertyId: string,
  filters: NegativeFilters = EMPTY_NEGATIVE_FILTERS,
): Promise<StockNegativePositionRow[]> {
  return fetchAllPagedRows<StockNegativePositionRow>(negativeRows, (from, to) => {
    const base = supabase.from('stock_negative_positions').select('*');
    return applyNegativeFilters(base, tenantId, propertyId, filters)
      .order('quantity_on_hand', { ascending: true })
      .order('location_id', { ascending: true })
      .order('inventory_item_id', { ascending: true }) // unique → stable paging
      .range(from, to);
  });
}

// ONE definition of "this position cannot be corrected right now", shared by the
// row badge, the filter's meaning and the summary count — so the number above
// the table and the flags inside it can never disagree about which rows they
// mean.
//
// It is a fact about the PARENTS, not about the quantity: both posting RPCs
// require a live, ACTIVE location and a live item, so a position behind a
// switched-off or removed parent has no write path at all until it is switched
// back on. Not even an adjustment down to zero.
export function isUncorrectable(row: {
  item_is_active: boolean;
  location_is_active: boolean;
  item_deleted_at: string | null;
  location_deleted_at: string | null;
}): boolean {
  return (
    !row.item_is_active ||
    !row.location_is_active ||
    row.item_deleted_at !== null ||
    row.location_deleted_at !== null
  );
}
