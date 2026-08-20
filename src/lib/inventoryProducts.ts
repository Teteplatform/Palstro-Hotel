import { supabase } from './supabase';
import { fetchAllPagedRows } from './fetchAllPaged';
import { fetchInventoryItemsByIds } from './inventory';
import { fetchItemImages } from './itemImages';
import { boundary } from './rowParse';
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
//   - Rule 24: every read parses its numeric fields at the boundary, so the
//     ProductRow this module hands out carries numbers and never a wire value.

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

  // 042. Narrow to SELLABLE ITEMS WITH NO PRICE — the gap the price rule's
  // unenforceable half leaves behind.
  //
  // WHY THIS IS A FILTER AND NOT A CONSTRAINT. A Sold as-is or Both item must have
  // a price, but that cannot be a CHECK: `add constraint` validates existing rows,
  // and this property already has sellable items priced at nothing. The only ways
  // past that are to invent prices or to relabel real merchandise as ingredients,
  // and both are lies in the data. So the database's trigger stops the gap
  // GROWING, and this filter makes the gap that already exists FINDABLE — which is
  // the difference between a rule that is achievable and one that is aspirational.
  //
  // Applied to the catalogue, not to positions, deliberately: an unpriced sellable
  // item with nothing on hand is exactly as unpriced as one with a full shelf, and
  // a hotel closing this gap wants every one of them, not just the stocked ones.
  unpricedSellable: boolean;
}

export const EMPTY_PRODUCT_FILTERS: ProductFilters = {
  search: '',
  categoryId: '',
  itemType: '',
  state: '',
  includeInactive: false,
  unpricedSellable: false,
};

export function hasProductFilters(f: ProductFilters): boolean {
  return (
    Boolean(f.search) ||
    Boolean(f.categoryId) ||
    Boolean(f.itemType) ||
    Boolean(f.state) ||
    f.includeInactive ||
    f.unpricedSellable
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
  // 042. Both halves of "sellable with no price", server-side, so the page, the
  // count and the export all describe the same set (rules 1b/20).
  if (filters.unpricedSellable) {
    q = q.in('item_type', ['finished', 'both']).is('default_selling_price', null);
  }

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
  // 042. The view carries the price (§3.1) precisely so this is expressible here
  // and not only against the catalogue — otherwise combining "sellable, no price"
  // with a stock-state filter would page one set and count another.
  if (filters.unpricedSellable) {
    q = q.in('item_type', ['finished', 'both']).is('default_selling_price', null);
  }

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
  // numeric(14,4)/(14,2), parsed at the boundary (rule 24).
  quantity: number;
  averageCost: number;
  value: number;
  // 042. What this position would bring in at the item's price. NULL — never 0 —
  // when the item has no price, because "not for sale" and "worth nothing" are
  // different facts and only the first one is true.
  retailValue: number | null;
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
  reorderLevel: number | null;
  isActive: boolean;

  // 042. What one base unit sells for, before tax, or NULL for NOT SOLD. Shown as
  // its own column, so an unpriced sellable line is visible on the row rather than
  // only findable through a filter.
  sellingPrice: number | null;
  // 042. The bucket_path of the item's picture, or NULL. A PATH and not a URL:
  // mediaVariantUrl derives the size the surface needs from it, so a list row
  // pulls the 400px thumb and never the 1920px full.
  imagePath: string | null;
  // 1.1f. The ASSET ID behind that path, carried so the row's tile can open the
  // picture dialog without a lookup per open — ItemImageField needs the id, not
  // the path. One more column on a select that already reads it.
  imageAssetId: string | null;

  // The position AT THE CURRENT SCOPE — the selected location, or the property
  // roll-up when "all locations" is active. NULL (not zero) when the item has
  // never moved at that scope: "we have no figure" is not "there is none", and
  // the screen renders the two differently.
  quantity: number | null;
  averageCost: number | null;
  value: number | null;
  // 042. Retail at the current scope. NULL when there is no position OR no price —
  // the row shows a dash either way, and the summary card is where the two are
  // told apart (it counts the unpriced ones).
  retailValue: number | null;
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
// prettier-ignore
const ITEM_COLUMNS =
  'id,name,code,item_type,base_unit,category_id,reorder_level,is_active,default_selling_price,image_asset_id';

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
  | 'default_selling_price'
  | 'image_asset_id'
>;

interface PositionRow {
  inventory_item_id: string;
  location_id: string;
  location_name: string;
  quantity_on_hand: number;
  moving_average_cost: number;
  stock_value: number;
  is_below_reorder: boolean;
  item_name: string;
  item_code: string | null;
  item_type: ItemType;
  base_unit: string;
  category_id: string | null;
  category_name: string | null;
  item_is_active: boolean;
  // 042 (view §3.1). NULL price means NOT SOLD; NULL retail follows from it, and
  // the view returns NULL rather than 0 precisely so sum() skips it and count()
  // can report how many were skipped.
  default_selling_price: number | null;
  retail_value: number | null;
}

// ONE STRING LITERAL, not a concatenation: supabase-js parses the column list at
// the TYPE level, and a value it only knows as `string` degrades the row type to
// its error placeholder. Kept on one line for that reason, not for style.
// prettier-ignore
const POSITION_COLUMNS = 'inventory_item_id,location_id,location_name,quantity_on_hand,moving_average_cost,stock_value,is_below_reorder,item_name,item_code,item_type,base_unit,category_id,category_name,item_is_active,default_selling_price,retail_value';

interface RollupRow {
  inventory_item_id: string;
  quantity_on_hand: number;
  stock_value: number;
  // NULL when nothing is on hand: with no quantity there is no meaningful unit
  // cost, and the view returns NULL rather than dividing by zero (036 §3.3).
  moving_average_cost: number | null;
  // 042 (view §3.2). Retail summed across every location holding the item.
  retail_value: number | null;
}

// ---------------------------------------------------------------------------
// The boundaries (rule 24)
// ---------------------------------------------------------------------------
// One per READ, not one per table: each of these selects a different projection,
// and a boundary naming a column its query never asked for would throw on every
// row. The compiler checks each list covers every numeric key of its shape.

const positionRows = boundary<PositionRow>('stock_on_hand_items (product list)')(
  ['quantity_on_hand', 'moving_average_cost', 'stock_value'] as const,
  ['default_selling_price', 'retail_value'] as const,
);

const rollupRows = boundary<RollupRow>('stock_on_hand_by_item')(
  ['quantity_on_hand', 'stock_value'] as const,
  ['moving_average_cost', 'retail_value'] as const,
);

const itemRows = boundary<ItemRow>('inventory_items (product list)')(
  [] as const,
  ['reorder_level', 'default_selling_price'] as const,
);

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
    const positions = positionRows.rows(data);
    const rows = positions.map(rowFromPosition);
    return {
      rows: await attachImages(
        tenantId,
        rows,
        await imageIdsFor(tenantId, rows, null),
      ),
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
  const items = itemRows.rows(data);

  const rows = await attachStock(tenantId, propertyId, locationId, items);
  return {
    rows: await attachImages(
      tenantId,
      rows,
      await imageIdsFor(tenantId, rows, items),
    ),
    count: count ?? 0,
    byPosition: false,
  };
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
  const positionsPromise = fetchAllPagedRows<PositionRow>(positionRows, (from, to) => {
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
    : fetchAllPagedRows<RollupRow>(rollupRows, (from, to) =>
        supabase
          .from('stock_on_hand_by_item')
          // prettier-ignore
          .select('inventory_item_id,quantity_on_hand,stock_value,moving_average_cost,retail_value')
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
      sellingPrice: item.default_selling_price,
      // Both filled in by attachImages once the page's asset ids are resolved.
      imagePath: null,
      imageAssetId: item.image_asset_id,
      quantity: locationId
        ? (scoped?.quantity_on_hand ?? null)
        : (rollup?.quantity_on_hand ?? null),
      averageCost: locationId
        ? (scoped?.moving_average_cost ?? null)
        : (rollup?.moving_average_cost ?? null),
      value: locationId ? (scoped?.stock_value ?? null) : (rollup?.stock_value ?? null),
      // Retail comes from the SAME source as value at the same scope — the
      // position's own figure at one location, the view's roll-up across all of
      // them — never a client-side multiplication of price by quantity, which
      // would be a second implementation of the arithmetic in §3.1 that could
      // disagree with the total on the card above.
      retailValue: locationId
        ? (scoped?.retail_value ?? null)
        : (rollup?.retail_value ?? null),
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
    retailValue: p.retail_value,
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
    sellingPrice: p.default_selling_price,
    imageAssetId: null,
    // The positions view does not carry the picture: a thumbnail is not something
    // a stock query should join for, and this mode is reached by filtering on
    // stock state. Filled in by attachImages from the item ids, the same as the
    // catalogue mode, so both modes show the same row.
    imagePath: null,
    quantity: p.quantity_on_hand,
    averageCost: p.moving_average_cost,
    value: p.stock_value,
    retailValue: p.retail_value,
    isBelowReorder: p.is_below_reorder,
    locations: [location],
  };
}

// ---------------------------------------------------------------------------
// The pictures (042 §3)
// ---------------------------------------------------------------------------
// Resolve the page's items to their picture paths in ONE read, after the rows are
// built.
//
// WHY NOT A POSTGREST EMBED on inventory_items → media_assets: an embed would
// nest a row inside a row, and the boundary (rule 24) parses a FLAT projection —
// a nested object would pass through unparsed, which is the exact hole rule 24
// exists to close. A second small read keeps every numeric crossing the boundary
// it is declared at.
//
// A ROW WITH NO PICTURE COSTS NOTHING: the ids are collected first and the read is
// skipped entirely when there are none, so a hotel that has uploaded no pictures
// pays for no extra round trip.
async function attachImages(
  tenantId: string,
  rows: ProductRow[],
  imageIdByItem: Map<string, string>,
): Promise<ProductRow[]> {
  if (imageIdByItem.size === 0) return rows;

  const assets = await fetchItemImages(tenantId, [...imageIdByItem.values()]);
  if (assets.size === 0) return rows;

  return rows.map((row) => {
    const id = imageIdByItem.get(row.itemId) ?? null;
    // An id whose asset is missing (soft-deleted since it was referenced) leaves
    // imagePath null and the row shows an empty tile — a dangling reference is
    // never a broken image. The ID is still carried, because the tile opens the
    // picture dialog either way and "replace the one that will not load" is a
    // thing somebody needs to be able to do.
    const path = id ? (assets.get(id)?.bucket_path ?? null) : null;
    return { ...row, imagePath: path, imageAssetId: id };
  });
}

// The item ids behind a page of rows, mapped to their picture's asset id. Read
// from the CATALOGUE rows where the list has them, and fetched for the positions
// mode where it does not.
async function imageIdsFor(
  tenantId: string,
  rows: ProductRow[],
  known: ItemRow[] | null,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();

  if (known) {
    for (const item of known) {
      if (item.image_asset_id) map.set(item.id, item.image_asset_id);
    }
    return map;
  }

  // Positions mode: the view carries no image column, so the ids come from the
  // catalogue. Bounded by the page (rule 1a) and paged by the helper.
  const ids = [...new Set(rows.map((r) => r.itemId))];
  if (ids.length === 0) return map;
  const items = await fetchInventoryItemsByIds(tenantId, ids);
  for (const item of items) {
    if (item.image_asset_id) map.set(item.id, item.image_asset_id);
  }
  return map;
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
  // VALUE AT COST — what the books say this stock is worth, across EVERY position
  // in scope whether or not the item has a price.
  totalValue: number;
  belowReorderCount: number;
  negativeCount: number;

  // --- 042: retail, and the three figures that make it honest --------------
  //
  // RETAIL VALUE: what the shelf would bring in, at the items' own pre-tax prices,
  // over the positions that HAVE a price.
  retailValue: number;

  // THE COST OF EXACTLY THOSE SAME POSITIONS, and this is the field most likely to
  // be mistaken for a duplicate of totalValue. It is not, and the difference is the
  // whole reason margin can be trusted:
  //
  //   totalValue covers every position on the shelf — priced merchandise AND
  //   unpriced ingredients — because that is what the stock is WORTH.
  //   retailValue covers only the priced ones, because the unpriced ones have no
  //   price to sell at.
  //
  // Subtracting the first from the second would treat every sack of rice in the
  // store as pure loss and put a large negative number on an owner's dashboard —
  // arithmetically explicable, completely false, and nothing would error. So margin
  // is retailValue − retailCostValue: the same positions on both sides.
  retailCostValue: number;

  // How many ITEMS in scope hold stock but have no price, and are therefore absent
  // from retailValue. Reported because a total that silently ignores half the shelf
  // is worse than no total: this is the size of the hole in the figure beside it.
  retailExcludedCount: number;
}

// Retail minus the cost OF THE SAME POSITIONS. Never minus totalValue — see
// retailCostValue. Derived here rather than stored on the summary so there is one
// definition of it, shared by the card and by the proof that checks the card.
export function summaryMargin(summary: ProductsSummary): number {
  return summary.retailValue - summary.retailCostValue;
}

// Margin as a share of retail, or NULL when there is no retail to take a share of
// (nothing priced in scope). NULL, not 0: "no priced stock" and "no margin on
// priced stock" are different statements, and a confident 0% would be the second
// one told about the first.
export function summaryMarginPercent(summary: ProductsSummary): number | null {
  if (summary.retailValue === 0) return null;
  return (summaryMargin(summary) / summary.retailValue) * 100;
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
    quantity_on_hand: number;
    stock_value: number;
    is_below_reorder: boolean;
    // 042. Read, never derived: retail_value is computed once in the view (§3.1),
    // so the total here and the figure on a row can never disagree.
    retail_value: number | null;
  }

  const summaryRows = boundary<SummaryRow>('stock_on_hand_items (product summary)')(
    ['quantity_on_hand', 'stock_value'] as const,
    ['retail_value'] as const,
  );

  // Paged, not a capped read (rule 1a): a total must cover every matching row,
  // so nothing may be truncated at a row cap.
  const positionsPromise = fetchAllPagedRows<SummaryRow>(summaryRows, (from, to) =>
    applyPositionFilters(
      supabase
        .from('stock_on_hand_items')
        // prettier-ignore
        .select('inventory_item_id,quantity_on_hand,stock_value,is_below_reorder,retail_value'),
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
  // 042. Retail, and the cost of THE SAME POSITIONS — accumulated in the same pass
  // and gated by the same condition, so the two sides of the margin can never be
  // taken over different sets. That is the bug this shape exists to prevent, and it
  // is why retailCostValue is not read off totalValue.
  let retailValue = 0;
  let retailCostValue = 0;
  const itemsHolding = new Set<string>();
  const itemsSeen = new Set<string>();
  // Items in scope holding stock that have NO price — the ones absent from retail.
  // A SET of item ids, not a row count: one unpriced item held in three locations
  // is one item the owner has to price, not three.
  const itemsExcludedFromRetail = new Set<string>();

  for (const row of positions) {
    // Already numbers — parsed at the boundary on the way in (rule 24).
    const quantity = row.quantity_on_hand;
    totalUnits += quantity;
    totalValue += row.stock_value;
    if (quantity !== 0) itemsHolding.add(row.inventory_item_id);
    if (quantity < 0) negativeCount += 1;
    if (row.is_below_reorder) belowReorderCount += 1;
    itemsSeen.add(row.inventory_item_id);

    if (row.retail_value === null) {
      // NO PRICE. Excluded from BOTH sides of the margin, and counted — but only
      // when it is actually holding something. An unpriced item with nothing on
      // hand is missing from a retail total that was going to be 0 for it either
      // way, so reporting it as "excluded" would inflate the hole with rows that
      // are not in it. The unpriced-sellable FILTER is the surface for those.
      if (quantity !== 0) itemsExcludedFromRetail.add(row.inventory_item_id);
    } else {
      retailValue += row.retail_value;
      retailCostValue += row.stock_value;
    }
  }

  return {
    itemCount: catalogueCount ?? itemsSeen.size,
    itemsWithStock: itemsHolding.size,
    totalUnits,
    totalValue,
    belowReorderCount,
    negativeCount,
    retailValue,
    retailCostValue,
    retailExcludedCount: itemsExcludedFromRetail.size,
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
    const positions = await fetchAllPagedRows<PositionRow>(positionRows, (from, to) =>
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

  const items = await fetchAllPagedRows<ItemRow>(itemRows, (from, to) =>
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
  // NO PICTURES ON THE EXPORT, and that is a decision rather than an omission: a
  // spreadsheet cannot show a thumbnail, and resolving every asset path for a
  // thousand-row export would be a read whose only consumer is a column that does
  // not exist. The PRICE is exported, because a spreadsheet can carry a number.
  return rows;
}
