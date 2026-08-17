import { supabase } from './supabase';
import { fetchAllPaged } from './fetchAllPaged';
import { newIdempotencyKey } from './folio';
import type {
  CountLineResult,
  StockTake,
  StockTakeProgressRow,
  StockTakeSheetRow,
  StockTakeStatus,
} from '../types/stockTake';

export { newIdempotencyKey };

// The data layer for the stock take as a counted document (migration 039).
//
// ---------------------------------------------------------------------------
// THE ONE HARD RULE: THIS FILE NEVER ASKS FOR AN EXPECTED QUANTITY
// ---------------------------------------------------------------------------
// It could not get one if it tried — 039 §4 revokes the column privilege, gives
// stock_take_lines no select policy, and NULLs the column in the view until the
// count is finished. That is deliberate and it is what makes the blind rule
// real: there is no query this file could be edited into that would put the
// answer in front of the counter.
//
// So there is no "expected" anywhere below, no client-side variance arithmetic,
// and no fallback that would quietly reconstruct either. When the count is
// finished the server sends both, already computed, from the cost the movement
// actually carried.
//
// Compliance:
//   - Rule 1b: the sheet pages SERVER-SIDE via .range() with an exact count, and
//     every filter is applied server-side, so the page, the count and the
//     filter always describe the same set.
//   - Rule 19: RLS restricts to the user's tenants; every read here
//     ADDITIONALLY scopes to the active tenant AND property.
//   - Rule 11: every call is awaited and throws; the caller surfaces the error.
//   - Rule 21: errors are the server's own words. This file re-words nothing —
//     stockErrorMessage (which appends the RAISE hint) is shared from lib/stock.
//   - §6: numeric columns arrive as STRINGS; parse with parseNumeric.

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

// Re-exported rather than redefined: a count is refused by the same engine with
// the same SQLSTATEs as every other stock write, and two lists of the same
// constants is how one of them comes to be missing a code.
export {
  STOCK_CONFLICT,
  STOCK_FORBIDDEN,
  STOCK_INVALID,
  STOCK_LOCKED,
  STOCK_NEEDS_CONFIRMATION,
  STOCK_NOT_FOUND,
  stockErrorCode,
  stockErrorMessage,
} from './stock';

// Finishing a count above the property's variance threshold without a valid
// manager PIN is refused with the standard privilege SQLSTATE. A BRANCHING
// CONSTANT ONLY — the sentence the user reads is the server's, which names the
// threshold and deliberately does NOT name the variance (039 §6.3: the variance
// is the blind figure the sheet exists to withhold).
export const COUNT_NEEDS_MANAGER = '42501';

// ---------------------------------------------------------------------------
// The count sheet (rule 1b)
// ---------------------------------------------------------------------------

// What the sheet can be narrowed by while it is being counted. Every one is a
// server-side predicate on a real column of stock_take_sheet — `is_counted` is
// computed in the view precisely so "still to count" can be one too, rather
// than a client-side filter over a fetched page that would make "of N" a lie.
export type CountedState = '' | 'counted' | 'uncounted';

export interface SheetFilters {
  // Free text over item name and code.
  search: string;
  categoryId: string;
  counted: CountedState;
}

export const EMPTY_SHEET_FILTERS: SheetFilters = {
  search: '',
  categoryId: '',
  counted: '',
};

export function hasSheetFilters(f: SheetFilters): boolean {
  return Boolean(f.search) || Boolean(f.categoryId) || Boolean(f.counted);
}

// THE SINGLE FILTER IMPLEMENTATION, shared by the page query and the export, so
// they provably describe the same set (rules 1b, 20).
function applySheetFilters(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query: any,
  tenantId: string,
  propertyId: string,
  stockTakeId: string,
  filters: SheetFilters,
) {
  let q = query
    .eq('tenant_id', tenantId) // rule 19 — RLS is the floor, not the ceiling
    .eq('property_id', propertyId) // rule 19
    .eq('stock_take_id', stockTakeId);

  const search = filters.search.trim().replace(/[,()*]/g, ' ').trim();
  if (search.length > 0) {
    // Commas and parens are PostgREST or() syntax; stripped rather than
    // escaped, exactly as applyStockFilters does.
    q = q.or(`item_name.ilike.%${search}%,item_code.ilike.%${search}%`);
  }

  if (filters.categoryId) q = q.eq('category_id', filters.categoryId);
  if (filters.counted === 'counted') q = q.eq('is_counted', true);
  if (filters.counted === 'uncounted') q = q.eq('is_counted', false);

  return q;
}

export interface SheetPage {
  rows: StockTakeSheetRow[];
  count: number; // exact total for the CURRENT FILTER, not the page length
}

// One SERVER-PAGINATED, SERVER-FILTERED page of a count sheet. `page` is
// 1-based. Ordered by item name, because a storekeeper walks the shelves
// alphabetically the same way they look stock up, with the item id as a stable
// tiebreak so two items sharing a name can never swap between pages.
export async function fetchSheetPage(
  tenantId: string,
  propertyId: string,
  stockTakeId: string,
  page: number,
  pageSize: number,
  filters: SheetFilters = EMPTY_SHEET_FILTERS,
): Promise<SheetPage> {
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  const base = supabase.from('stock_take_sheet').select('*', { count: 'exact' });

  const { data, error, count } = await applySheetFilters(
    base,
    tenantId,
    propertyId,
    stockTakeId,
    filters,
  )
    .order('item_name', { ascending: true })
    .order('inventory_item_id', { ascending: true })
    .range(from, to);

  if (error) throw error;
  return { rows: (data ?? []) as StockTakeSheetRow[], count: count ?? 0 };
}

// ---------------------------------------------------------------------------
// The document, and its progress
// ---------------------------------------------------------------------------

// THE COUNT CURRENTLY OPEN IN A LOCATION, or null. This is what makes a count
// resumable: the screen asks the DATABASE what is open here, rather than asking
// its own memory, so a reload, a different browser or a different person all
// arrive at the same sheet.
//
// There can only ever be one — stock_takes_one_open_uniq (039 §2.1) — so this
// is a maybeSingle rather than a list with a silent "first" pick.
export async function fetchOpenTake(
  tenantId: string,
  propertyId: string,
  locationId: string,
): Promise<StockTakeProgressRow | null> {
  const { data, error } = await supabase
    .from('stock_take_progress')
    .select('*')
    .eq('tenant_id', tenantId) // rule 19
    .eq('property_id', propertyId) // rule 19
    .eq('location_id', locationId)
    .eq('status', 'open')
    .maybeSingle();

  if (error) throw error;
  return (data as StockTakeProgressRow | null) ?? null;
}

export async function fetchTakeProgress(
  tenantId: string,
  propertyId: string,
  stockTakeId: string,
): Promise<StockTakeProgressRow | null> {
  const { data, error } = await supabase
    .from('stock_take_progress')
    .select('*')
    .eq('tenant_id', tenantId) // rule 19
    .eq('property_id', propertyId) // rule 19
    .eq('stock_take_id', stockTakeId)
    .maybeSingle();

  if (error) throw error;
  return (data as StockTakeProgressRow | null) ?? null;
}

export interface TakeHistoryFilters {
  locationId: string;
  status: '' | StockTakeStatus;
}

export const EMPTY_TAKE_FILTERS: TakeHistoryFilters = {
  locationId: '',
  status: '',
};

export interface TakesPage {
  rows: StockTakeProgressRow[];
  count: number;
}

// The counts this property has run, most recent OPERATING DAY first (rule 8 —
// the day the shelves were walked, never the day the row was written), with
// started_at as the tiebreak for several counts on one day.
export async function fetchTakesPage(
  tenantId: string,
  propertyId: string,
  page: number,
  pageSize: number,
  filters: TakeHistoryFilters = EMPTY_TAKE_FILTERS,
): Promise<TakesPage> {
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  let q = supabase
    .from('stock_take_progress')
    .select('*', { count: 'exact' })
    .eq('tenant_id', tenantId) // rule 19
    .eq('property_id', propertyId); // rule 19

  if (filters.locationId) q = q.eq('location_id', filters.locationId);
  if (filters.status) q = q.eq('status', filters.status);

  const { data, error, count } = await q
    .order('business_date', { ascending: false }) // rule 8
    .order('started_at', { ascending: false })
    .range(from, to);

  if (error) throw error;
  return { rows: (data ?? []) as StockTakeProgressRow[], count: count ?? 0 };
}

// ---------------------------------------------------------------------------
// The write RPCs (rules 2, 3, 11)
// ---------------------------------------------------------------------------

export interface StartCountInput {
  propertyId: string;
  locationId: string;
  // ISO yyyy-mm-dd, or null for "the property's local today" (resolved
  // server-side in the property's timezone — rules 8/12).
  businessDate: string | null;
  note: string | null;
  // Rules 2/3. Generated once per Start press and REUSED on a retry, so a
  // double-click returns the count that was started rather than colliding with
  // the one-open-count rule and showing an error for something that worked.
  idempotencyKey: string;
}

export async function startStockTake(input: StartCountInput): Promise<StockTake> {
  const { data, error } = await supabase.rpc('start_stock_take', {
    p_property_id: input.propertyId,
    p_location_id: input.locationId,
    p_business_date: input.businessDate,
    p_idempotency_key: input.idempotencyKey,
    p_note: input.note,
  });

  if (error) throw error; // rule 11 — never swallowed; the caller surfaces it
  return data as StockTake;
}

export interface RecordCountInput {
  stockTakeId: string;
  inventoryItemId: string;
  // What the counter physically found. ZERO IS AN ANSWER. NULL clears the line
  // back to "not counted", which is how a line keyed against the wrong shelf is
  // undone without writing the shelf off.
  countedQuantity: number | null;
  // Rules 2/3: a FRESH key per save. Each save is its own intent — re-keying a
  // line is a new answer and must replace the old one — while a retry of the
  // same save returns the line untouched.
  idempotencyKey: string;
}

export async function recordCountLine(
  input: RecordCountInput,
): Promise<CountLineResult> {
  const { data, error } = await supabase.rpc('record_count_line', {
    p_stock_take_id: input.stockTakeId,
    p_inventory_item_id: input.inventoryItemId,
    p_counted_quantity: input.countedQuantity,
    p_idempotency_key: input.idempotencyKey,
  });

  if (error) throw error;
  // `returns table (...)` — PostgREST sends an array of rows, and this RPC
  // updates exactly one line.
  const rows = (data ?? []) as CountLineResult[];
  return rows[0];
}

export interface FinishCountInput {
  stockTakeId: string;
  // ALWAYS SENT, and always possibly empty — because the client cannot know
  // whether one is needed. The variance is blind while the count is open (039
  // §4), so whether it exceeds the property's threshold is a fact only the
  // server holds. It asks for a PIN, sends whatever was typed, and shows the
  // server's refusal verbatim if one was required and none was given. That is
  // rule 21 falling out of the blind rule rather than being remembered.
  managerPin: string;
  // Rules 2/3. Generated once per Finish press and reused on retry: a finish
  // that timed out must not post a second set of movements, and the replay
  // deliberately does NOT re-check the PIN, so a dropped connection does not
  // fetch the manager back to the terminal.
  //
  // IT IS ALSO WHAT MAKES THE CONFIRMATION BELOW SAFE. The confirm re-sends the
  // SAME key, so a user who confirms cannot post a second set of movements —
  // exactly the shape 036 §4.2 uses for the negative-stock confirmation.
  idempotencyKey: string;
  // 041. Confirms a finish the server refused once because stock MOVED in the
  // location while the count was running and the affected shelves were counted
  // after it moved — the case where a delivery would be recorded twice. The
  // client never decides this: it sends false, reads the server's refusal, shows
  // it verbatim, and sends true only when a person has said so.
  allowMovedStock?: boolean;
}

export async function finishStockTake(input: FinishCountInput): Promise<StockTake> {
  const { data, error } = await supabase.rpc('finish_stock_take', {
    p_stock_take_id: input.stockTakeId,
    p_manager_pin: input.managerPin ? input.managerPin : null,
    p_idempotency_key: input.idempotencyKey,
    p_allow_moved_stock: input.allowMovedStock ?? false,
  });

  if (error) throw error;
  return data as StockTake;
}

export interface CancelCountInput {
  stockTakeId: string;
  // Mandatory and non-blank. An abandoned count with no explanation is itself a
  // finding, so the server refuses a blank one and the table constraint refuses
  // it again underneath.
  reason: string;
  idempotencyKey: string;
}

export async function cancelStockTake(input: CancelCountInput): Promise<StockTake> {
  const { data, error } = await supabase.rpc('cancel_stock_take', {
    p_stock_take_id: input.stockTakeId,
    p_reason: input.reason,
    p_idempotency_key: input.idempotencyKey,
  });

  if (error) throw error;
  return data as StockTake;
}

export interface ReverseCountInput {
  stockTakeId: string;
  reason: string;
  // ALWAYS required, with no threshold — unlike finishing, which is gated by the
  // property's variance threshold. Undoing a count erases movements a manager
  // already approved, so it takes a manager every time (040 §4).
  managerPin: string;
  idempotencyKey: string;
}

// Undoes a FINISHED count: every movement it posted is reversed, and the
// document is marked reversed. Nothing is deleted — the count and its undoing
// both stay on file, which is why there is no "delete count" anywhere in this
// module.
export async function reverseStockTake(input: ReverseCountInput): Promise<StockTake> {
  const { data, error } = await supabase.rpc('reverse_stock_take', {
    p_stock_take_id: input.stockTakeId,
    p_reason: input.reason,
    p_manager_pin: input.managerPin ? input.managerPin : null,
    p_idempotency_key: input.idempotencyKey,
  });

  if (error) throw error;
  return data as StockTake;
}

// ---------------------------------------------------------------------------
// The printed sheet
// ---------------------------------------------------------------------------

// EVERY line of a count, for the sheet that gets printed and carried into the
// store. fetchAllPaged (rule 1a): a paper count sheet that quietly stopped at
// the first thousand rows would send somebody to count a store with shelves
// missing from their list, which is worse than no sheet at all.
//
// It is the SAME view the screen reads, so the printed sheet is blind for the
// same reason the screen is: while the count is open the server sends no
// expected quantity, so there is none to print. That is the whole point of
// printing it — a tally sheet with the answers on it is not a tally sheet.
export async function fetchSheetForPrint(
  tenantId: string,
  propertyId: string,
  stockTakeId: string,
): Promise<StockTakeSheetRow[]> {
  return fetchAllPaged<StockTakeSheetRow>((from, to) =>
    supabase
      .from('stock_take_sheet')
      .select('*')
      .eq('tenant_id', tenantId) // rule 19
      .eq('property_id', propertyId) // rule 19
      .eq('stock_take_id', stockTakeId)
      .order('item_name', { ascending: true })
      .order('inventory_item_id', { ascending: true }) // unique → stable paging
      .range(from, to),
  );
}
