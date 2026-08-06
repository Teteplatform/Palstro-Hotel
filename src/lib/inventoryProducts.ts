import { supabase } from './supabase';
import { fetchAllPaged } from './fetchAllPaged';
import { parseNumeric } from './format';
import type { InventoryItem, ItemType } from '../types/inventory';

// THE DATA LAYER FOR THE CONSOLIDATED INVENTORY PAGE — one list that is the
// CATALOGUE with stock attached, rather than the stock ledger with a catalogue
// bolted on. That distinction decides everything below, so it is worth stating:
//
//   * A product exists whether or not it has ever moved. An item with nothing on
//     hand anywhere is still a row — that is what makes this the screen you add
//     stock FROM, instead of a screen that only shows what you already have.
//   * A product's stock is a set of POSITIONS, one per location, because stock is
//     physical (036 §1). "All locations" is a deliberate roll-up of those
//     positions, never a pretence that there is one property-wide pile.
//
// NOTHING HERE COMPUTES A QUANTITY, AN AVERAGE COST OR A VALUE. Every figure is
// read from the 036 views, which fold it from the movements on every read (rule
// 6). The only arithmetic in this file is adding up a column of already-computed
// values for a rule-20 total — the same thing fetchStockSummary does, and for the
// same reason: a second implementation of the valuation in TypeScript would drift
// from the first and nothing would error.
//
// Compliance:
//   - Rule 1b: the list pages SERVER-SIDE via .range() with an exact count, and
//     EVERY filter is applied server-side, so the page, the count, the total and
//     the export always describe the same set.
//   - Rule 1a: every read consumed in full goes through fetchAllPaged. The one
//     `.in()` in this file is over the ids of ONE page (bounded by the page size)
//     and is still wrapped in fetchAllPaged, so it can neither be unbounded nor
//     silently truncate.
//   - Rule 19: RLS restricts to the user's tenants; every read ADDITIONALLY
//     scopes to the active tenant and — for anything physical — the property.
//   - Rule 20: totals and exports span the whole FILTERED set, never the page.
//   - §6: numeric columns arrive as STRINGS; parse with parseNumeric.

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

// The on-hand state a user can narrow to. Each is a server-side predicate on a
// real column of stock_on_hand_items (is_below_reorder is computed in the view
// precisely so "low stock" can be one too).
export type ProductStockState = '' | 'in_stock' | 'low' | 'zero' | 'negative';

export interface ProductFilters {
  // Free text over item name and code.
  search: string;
  categoryId: string;
  itemType: ItemType | '';
  state: ProductStockState;
  // Catalogue items that have been switched off are hidden by default: they are
  // still on file and still hold their history, but they are not what somebody
  // scanning a stock list is looking for.
  includeInactive: boolean;
}

export const EMPTY_PRODUCT_FILTERS: ProductFilters = {
  search: '',
  categoryId: '',
  itemType: '',
  state: '',
  includeInactive: false,
};

export function hasProductFilters(f: ProductFilters): boolean {
  return (
    Boolean(f.search) ||
    Boolean(f.categoryId) ||
    Boolean(f.itemType) ||
    Boolean(f.state) ||
    f.includeInactive
  );
}

// PostgREST's or() takes a comma-separated filter list, so commas and parens in
// the term would be read as syntax. Stripped rather than escaped, matching
// fetchInventoryItemsPage and fetchCompaniesPage.
function safeSearch(search: string): string {
  return search.trim().replace(/[,()*]/g, ' ').trim();
}

// THE CATALOGUE FILTER — applied to inventory_items, the base of the default
// list. Tenant-scoped, because the catalogue is (035): one definition of "Rice"
// shared by every property.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyCatalogueFilters(query: any, tenantId: string, filters: ProductFilters) {
  let q = query
    .eq('tenant_id', tenantId) // rule 19 — RLS is the floor, not the ceiling
    .is('deleted_at', null); // rule 5

  const search = safeSearch(filters.search);
  if (search.length > 0) q = q.or(`name.ilike.%${search}%,code.ilike.%${search}%`);
  if (filters.categoryId) q = q.eq('category_id', filters.categoryId);
  if (filters.itemType) q = q.eq('item_type', filters.itemType);
  if (!filters.includeInactive) q = q.eq('is_active', true);

  return q;
}

// THE POSITION FILTER — applied to stock_on_hand_items. The SAME user-facing
// filters, expressed against the view's own columns (which carry the catalogue
// fields precisely so this is possible server-side), plus the stock-state
// predicate the catalogue cannot express.
function applyPositionFilters(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query: any,
  tenantId: string,
  propertyId: string,
  locationId: string | null,
  filters: ProductFilters,
) {
  let q = query
    .eq('tenant_id', tenantId) // rule 19
    .eq('property_id', propertyId); // rule 19 — stock is physical

  // NULL location means "every location in this property" — the roll-up, not a
  // missing filter.
  if (locationId) q = q.eq('location_id', locationId);

  const search = safeSearch(filters.search);
  if (search.length > 0) {
    q = q.or(`item_name.ilike.%${search}%,item_code.ilike.%${search}%`);
  }
  if (filters.categoryId) q = q.eq('category_id', filters.categoryId);
  if (filters.itemType) q = q.eq('item_type', filters.itemType);
  if (!filters.includeInactive) q = q.eq('item_is_active', true);

  switch (filters.state) {
    case 'in_stock':
      q = q.gt('quantity_on_hand', 0);
      break;
    case 'low':
      // At or below the reorder level. Items with no reorder level are FALSE in
      // the view (never null), so they are excluded here rather than dropped by
      // a NULL comparison that would fail silently.
      q = q.eq('is_below_reorder', true);
      break;
    case 'zero':
      q = q.eq('quantity_on_hand', 0);
      break;
    case 'negative':
      // Less than nothing on hand: stock that left with no movement behind it.
      // The single most important thing this screen can surface (036 §3.1), so
      // it is a first-class filter rather than something to spot by eye.
      q = q.lt('quantity_on_hand', 0);
      break;
    default:
      break;
  }

  return q;
}

// ---------------------------------------------------------------------------
// The row shape the screen renders
// ---------------------------------------------------------------------------

// One location's holding of one item. Every figure is the database's.
export interface ProductLocationStock {
  locationId: string;
  locationName: string;
  // numeric(14,4)/(14,2) as STRINGS (§6) — parse before arithmetic.
  quantity: string;
  averageCost: string;
  value: string;
  isBelowReorder: boolean;
}

export interface ProductRow {
  itemId: string;
  name: string;
  code: string | null;
  itemType: ItemType;
  baseUnit: string;
  categoryId: string | null;
  categoryName: string | null;
  reorderLevel: string | null;
  isActive: boolean;

  // The position AT THE CURRENT SCOPE — the selected location, or the property
  // roll-up when "all locations" is active. NULL (not zero) when the item has
  // never moved at that scope: "we have no figure" is not "there is none", and
  // the screen renders the two differently.
  quantity: string | null;
  averageCost: string | null;
  value: string | null;
  isBelowReorder: boolean;

  // Every location holding this item, for the "Main Store: 62 · Kitchen: 1"
  // breakdown. One entry at most when a single location is selected.
  locations: ProductLocationStock[];
}

export interface ProductsPage {
  rows: ProductRow[];
  // Exact total for the CURRENT FILTER, not the page length — what makes "of N"
  // honest (rule 1b).
  count: number;
  // TRUE when the page was built from POSITIONS rather than from the catalogue,
  // i.e. a stock-state filter is active. The screen says so, because in that
  // mode an item held in two locations is legitimately two rows.
  byPosition: boolean;
}

// The catalogue columns the list needs. Selected explicitly rather than '*' so
// adding a column to the table does not silently widen every page fetch.
const ITEM_COLUMNS =
  'id,name,code,item_type,base_unit,category_id,reorder_level,is_active';

type ItemRow = Pick<
  InventoryItem,
  | 'id'
  | 'name'
  | 'code'
  | 'item_type'
  | 'base_unit'
  | 'category_id'
  | 'reorder_level'
  | 'is_active'
>;

interface PositionRow {
  inventory_item_id: string;
  location_id: string;
  location_name: string;
  quantity_on_hand: string;
  moving_average_cost: string;
  stock_value: string;
  is_below_reorder: boolean;
  item_name: string;
  item_code: string | null;
  item_type: ItemType;
  base_unit: string;
  category_id: string | null;
  category_name: string | null;
  item_is_active: boolean;
}

// ONE STRING LITERAL, not a concatenation: supabase-js parses the column list at
// the TYPE level, and a value it only knows as `string` degrades the row type to
// its error placeholder. Kept on one line for that reason, not for style.
// prettier-ignore
const POSITION_COLUMNS = 'inventory_item_id,location_id,location_name,quantity_on_hand,moving_average_cost,stock_value,is_below_reorder,item_name,item_code,item_type,base_unit,category_id,category_name,item_is_active';

interface RollupRow {
  inventory_item_id: string;
  quantity_on_hand: string;
  stock_value: string;
  // NULL when nothing is on hand: with no quantity there is no meaningful unit
  // cost, and the view returns NULL rather than dividing by zero (036 §3.3).
  moving_average_cost: string | null;
}

// ---------------------------------------------------------------------------
// The list (rule 1b)
// ---------------------------------------------------------------------------

// One SERVER-PAGINATED, SERVER-FILTERED page. `page` is 1-based.
//
// TWO MODES, ONE ROW SHAPE. Which base table the page comes from depends on
// whether a stock-state filter is active, and that is not an implementation
// detail — it is the only way both promises can hold at once:
//
//   NO STATE FILTER → the CATALOGUE is the base, so an item with nothing on hand
//   still appears (you cannot add stock to a row that is not there), and the
//   exact count is the number of items matching the filter.
//
//   STATE FILTER    → POSITIONS are the base, because "show me what is below its
//   reorder level" is a question about stock, and it must be answered
//   server-side (rule 1b) against the same rows the count and the total
//   describe. Filtering a fetched page in TypeScript would make "of N" a lie.
//
// Ordered by item name — a storekeeper looks stock up alphabetically ("where is
// the rice?") — with a unique tiebreak so a row can never swap between pages.
export async function fetchProductsPage(
  tenantId: string,
  propertyId: string,
  locationId: string | null,
  page: number,
  pageSize: number,
  filters: ProductFilters = EMPTY_PRODUCT_FILTERS,
): Promise<ProductsPage> {
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  if (filters.state) {
    const { data, error, count } = await applyPositionFilters(
      supabase.from('stock_on_hand_items').select(POSITION_COLUMNS, { count: 'exact' }),
      tenantId,
      propertyId,
      locationId,
      filters,
    )
      .order('item_name', { ascending: true })
      .order('inventory_item_id', { ascending: true })
      .order('location_id', { ascending: true }) // unique triple → stable paging
      .range(from, to);

    if (error) throw error;
    const positions = (data ?? []) as PositionRow[];
    return {
      rows: positions.map(rowFromPosition),
      count: count ?? 0,
      byPosition: true,
    };
  }

  const { data, error, count } = await applyCatalogueFilters(
    supabase.from('inventory_items').select(ITEM_COLUMNS, { count: 'exact' }),
    tenantId,
    filters,
  )
    .order('name', { ascending: true })
    .order('id', { ascending: true }) // unique → stable paging
    .range(from, to);

  if (error) throw error;
  const items = (data ?? []) as ItemRow[];

  const rows = await attachStock(tenantId, propertyId, locationId, items);
  return { rows, count: count ?? 0, byPosition: false };
}

// Attach each item's stock to a page of catalogue rows.
//
// THE `.in()` HERE IS BOUNDED AND STILL PAGED. Rule 1a forbids a bare `.in()`
// over an unbounded list; this one is over the ids of a single page (at most the
// page size), and it is wrapped in fetchAllPaged anyway, because one item can
// hold stock in every location and the row count is items x locations — which
// could otherwise reach a row cap and silently drop a location from a breakdown.
async function attachStock(
  tenantId: string,
  propertyId: string,
  locationId: string | null,
  items: ItemRow[],
): Promise<ProductRow[]> {
  if (items.length === 0) return [];
  const ids = items.map((i) => i.id);

  // The per-location breakdown, always — it is what the Locations column shows,
  // and at a single location it is also the position itself.
  const positionsPromise = fetchAllPaged<PositionRow>((from, to) => {
    let q = supabase
      .from('stock_on_hand_items')
      .select(POSITION_COLUMNS)
      .eq('tenant_id', tenantId) // rule 19
      .eq('property_id', propertyId) // rule 19
      .in('inventory_item_id', ids);
    if (locationId) q = q.eq('location_id', locationId);
    return q
      .order('inventory_item_id', { ascending: true })
      .order('location_id', { ascending: true }) // unique pair → stable paging
      .range(from, to);
  });

  // THE PROPERTY-WIDE ROLL-UP comes from the database, not from adding the
  // breakdown up here — specifically because of the unit cost. 036 §3.3: the
  // roll-up cost is total value / total quantity, NEVER the unweighted mean of
  // the per-location averages, which multiplies back to the wrong value. Reading
  // the view means there is exactly one implementation of that rule.
  const rollupPromise = locationId
    ? Promise.resolve([] as RollupRow[])
    : fetchAllPaged<RollupRow>((from, to) =>
        supabase
          .from('stock_on_hand_by_item')
          .select('inventory_item_id,quantity_on_hand,stock_value,moving_average_cost')
          .eq('tenant_id', tenantId) // rule 19
          .eq('property_id', propertyId) // rule 19
          .in('inventory_item_id', ids)
          .order('inventory_item_id', { ascending: true }) // unique → stable
          .range(from, to),
      );

  const [positions, rollups] = await Promise.all([positionsPromise, rollupPromise]);

  const byItem = new Map<string, PositionRow[]>();
  for (const p of positions) {
    const list = byItem.get(p.inventory_item_id);
    if (list) list.push(p);
    else byItem.set(p.inventory_item_id, [p]);
  }

  const rollupByItem = new Map<string, RollupRow>();
  for (const r of rollups) rollupByItem.set(r.inventory_item_id, r);

  return items.map((item) => {
    const held = byItem.get(item.id) ?? [];
    const locations = held.map(toLocationStock);
    const rollup = rollupByItem.get(item.id) ?? null;

    // The figure at the CURRENT scope. One location: that position. All
    // locations: the view's roll-up. Never a client-side blend of the two.
    const scoped = locationId ? (held[0] ?? null) : null;

    return {
      itemId: item.id,
      name: item.name,
      code: item.code,
      itemType: item.item_type,
      baseUnit: item.base_unit,
      categoryId: item.category_id,
      // The catalogue query does not join the category (it would cost a join on
      // every page for a name the screen already holds in its reference data),
      // so the name comes from whichever position row carries it, else the
      // caller fills it in from useInventoryReference.
      categoryName: held[0]?.category_name ?? null,
      reorderLevel: item.reorder_level,
      isActive: item.is_active,
      quantity: locationId
        ? (scoped?.quantity_on_hand ?? null)
        : (rollup?.quantity_on_hand ?? null),
      averageCost: locationId
        ? (scoped?.moving_average_cost ?? null)
        : (rollup?.moving_average_cost ?? null),
      value: locationId ? (scoped?.stock_value ?? null) : (rollup?.stock_value ?? null),
      // At a single location the view's own flag; across the property, low in
      // ANY location is low — a kitchen about to run out is not reassured by a
      // full main store, because the two are separate physical positions.
      isBelowReorder: locations.some((l) => l.isBelowReorder),
      locations,
    };
  });
}

function toLocationStock(p: PositionRow): ProductLocationStock {
  return {
    locationId: p.location_id,
    locationName: p.location_name,
    quantity: p.quantity_on_hand,
    averageCost: p.moving_average_cost,
    value: p.stock_value,
    isBelowReorder: p.is_below_reorder,
  };
}

// A position rendered as a product row. Used when a stock-state filter makes
// positions the base of the list, so the row IS that one location's holding.
function rowFromPosition(p: PositionRow): ProductRow {
  const location = toLocationStock(p);
  return {
    itemId: p.inventory_item_id,
    name: p.item_name,
    code: p.item_code,
    itemType: p.item_type,
    baseUnit: p.base_unit,
    categoryId: p.category_id,
    categoryName: p.category_name,
    // The view does not carry the item's reorder LEVEL, only the computed flag.
    // Shown as unknown rather than as zero — a confident wrong threshold is
    // worse than an honest dash.
    reorderLevel: null,
    isActive: p.item_is_active,
    quantity: p.quantity_on_hand,
    averageCost: p.moving_average_cost,
    value: p.stock_value,
    isBelowReorder: p.is_below_reorder,
    locations: [location],
  };
}

// ---------------------------------------------------------------------------
// The summary (rule 20 — the FILTER, never the page)
// ---------------------------------------------------------------------------

export interface ProductsSummary {
  // How many CATALOGUE items match the filter — including those holding nothing.
  itemCount: number;
  // How many of them hold a non-zero position somewhere in scope.
  itemsWithStock: number;
  // Every quantity added together. See TOTAL_UNITS_EXPLANATION: this adds
  // kilograms to bottles, so it is a rough scale figure and says so.
  totalUnits: number;
  // THE meaningful total: money adds up across items where quantity does not.
  totalValue: number;
  belowReorderCount: number;
  negativeCount: number;
}

// The figures above the table, across the WHOLE FILTERED SET (rule 20), from
// SEPARATE queries using the SAME filter builders — never summed from the
// visible page. A page-derived total is a wrong number presented with
// confidence, which is worse than no number.
export async function fetchProductsSummary(
  tenantId: string,
  propertyId: string,
  locationId: string | null,
  filters: ProductFilters = EMPTY_PRODUCT_FILTERS,
): Promise<ProductsSummary> {
  interface SummaryRow {
    inventory_item_id: string;
    quantity_on_hand: string;
    stock_value: string;
    is_below_reorder: boolean;
  }

  // fetchAllPaged, not a capped read (rule 1a): a total must cover every
  // matching row, so nothing may be truncated at a row cap.
  const positionsPromise = fetchAllPaged<SummaryRow>((from, to) =>
    applyPositionFilters(
      supabase
        .from('stock_on_hand_items')
        .select('inventory_item_id,quantity_on_hand,stock_value,is_below_reorder'),
      tenantId,
      propertyId,
      locationId,
      filters,
    )
      .order('inventory_item_id', { ascending: true })
      .order('location_id', { ascending: true }) // unique pair → stable paging
      .range(from, to),
  );

  // The catalogue count is a HEAD request — the number is wanted, not the rows.
  // With a stock-state filter active the catalogue is not the set being shown,
  // so the item count comes from the positions instead (below).
  const catalogueCountPromise = filters.state
    ? Promise.resolve<number | null>(null)
    : applyCatalogueFilters(
        supabase.from('inventory_items').select('id', { count: 'exact', head: true }),
        tenantId,
        filters,
      ).then(({ error, count }: { error: unknown; count: number | null }) => {
        if (error) throw error;
        return count ?? 0;
      });

  const [positions, catalogueCount] = await Promise.all([
    positionsPromise,
    catalogueCountPromise,
  ]);

  let totalUnits = 0;
  let totalValue = 0;
  let belowReorderCount = 0;
  let negativeCount = 0;
  const itemsHolding = new Set<string>();
  const itemsSeen = new Set<string>();

  for (const row of positions) {
    // §6: numeric → STRING. Parsed before adding; a bad value contributes 0
    // rather than turning the whole total into NaN.
    const quantity = parseNumeric(row.quantity_on_hand) ?? 0;
    totalUnits += quantity;
    totalValue += parseNumeric(row.stock_value) ?? 0;
    if (quantity !== 0) itemsHolding.add(row.inventory_item_id);
    if (quantity < 0) negativeCount += 1;
    if (row.is_below_reorder) belowReorderCount += 1;
    itemsSeen.add(row.inventory_item_id);
  }

  return {
    itemCount: catalogueCount ?? itemsSeen.size,
    itemsWithStock: itemsHolding.size,
    totalUnits,
    totalValue,
    belowReorderCount,
    negativeCount,
  };
}

// ---------------------------------------------------------------------------
// Export (rule 20 — filters apply, pagination does not)
// ---------------------------------------------------------------------------

// Every row matching the current filter, across ALL pages. fetchAllPaged, so
// nothing is truncated at a row cap: an export that quietly stopped at the first
// thousand rows would be a count sheet with items missing, which is worse than
// no export at all.
export async function fetchProductsForExport(
  tenantId: string,
  propertyId: string,
  locationId: string | null,
  filters: ProductFilters = EMPTY_PRODUCT_FILTERS,
): Promise<ProductRow[]> {
  if (filters.state) {
    const positions = await fetchAllPaged<PositionRow>((from, to) =>
      applyPositionFilters(
        supabase.from('stock_on_hand_items').select(POSITION_COLUMNS),
        tenantId,
        propertyId,
        locationId,
        filters,
      )
        .order('item_name', { ascending: true })
        .order('inventory_item_id', { ascending: true })
        .order('location_id', { ascending: true }) // unique triple → stable
        .range(from, to),
    );
    return positions.map(rowFromPosition);
  }

  const items = await fetchAllPaged<ItemRow>((from, to) =>
    applyCatalogueFilters(
      supabase.from('inventory_items').select(ITEM_COLUMNS),
      tenantId,
      filters,
    )
      .order('name', { ascending: true })
      .order('id', { ascending: true }) // unique → stable paging
      .range(from, to),
  );

  // Attached in chunks so the `.in()` list stays a bounded one (rule 1a) rather
  // than growing with the size of the catalogue.
  const CHUNK = 100;
  const rows: ProductRow[] = [];
  for (let i = 0; i < items.length; i += CHUNK) {
    rows.push(
      ...(await attachStock(tenantId, propertyId, locationId, items.slice(i, i + CHUNK))),
    );
  }
  return rows;
}
