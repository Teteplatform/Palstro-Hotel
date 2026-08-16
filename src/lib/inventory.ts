import { supabase } from './supabase';
import { fetchAllPaged } from './fetchAllPaged';
import type {
  InventoryCategory,
  InventoryItem,
  ItemType,
  StockLocation,
  LocationKind,
  UnitDimension,
  UnitOfMeasure,
} from '../types/inventory';

// The data layer for the inventory catalogue and locations (F&B/Inventory part
// 1, migration 035). Same compliance contract as roomTypes.ts / companies.ts:
//
//   - Rule 19: RLS is the floor, never the ceiling. Every read AND write is
//     ADDITIONALLY scoped in code — items/units/categories to the active TENANT,
//     locations to the active TENANT and PROPERTY — so a multi-tenant user's own
//     tenants can never blend on screen.
//   - Rule 5: deleted_at is NULL-safe; "live" is `deleted_at IS NULL`.
//   - Rule 11: every call is awaited and throws; the calling component surfaces
//     the error and never swallows it.
//   - Rule 1a: any read whose whole result is consumed goes through
//     fetchAllPaged — never a bare unbounded select.
//   - Rule 1b: the items list pages SERVER-SIDE via .range() with an exact
//     count, and its filters are applied server-side, so paging a filtered set
//     is correct rather than paging-then-filtering.
//   - §6: numeric columns arrive as STRINGS (reorder_level); parse with
//     parseNumeric before any arithmetic. This module writes numbers and reads
//     strings, deliberately.
//
// WRITES GO DIRECT TO THE TABLES, NOT THROUGH RPCs — matching roomTypes.ts and
// companies.ts, and for the same reason. These are ADMIN-GATED CONFIGURATION
// MASTER DATA: 035's is_tenant_admin() insert/update policies are the real
// enforcement, there is no money and nothing to double-post, so rule 2's
// idempotency-key machinery does not apply (it exists to stop duplicate
// bookings, charges and payments). An RPC would add a hop and a second place for
// the scoping to drift without buying a guarantee the policy does not already
// give. Where the codebase DOES use an RPC — create_booking's overbooking lock,
// the folio posting path — it is because the server must hold a lock or stamp an
// actor under SECURITY DEFINER. Neither applies to naming a store.
//
// REMOVAL IS ALWAYS A SOFT DELETE. There is no hard-delete function in this file
// and no DELETE policy in 035, so the destructive path does not exist at either
// layer. The stronger guards — a location holding stock, an item used by a
// recipe — belong to part 2/3 and are recorded in 035 §7.

// ===========================================================================
// Units of measure (tenant-level reference)
// ===========================================================================

// Every live unit for a tenant. The WHOLE set is consumed at once (it is the
// base-unit picker), so this is fetchAllPaged (rule 1a), not a paged surface.
// Inactive units are included: an item created before a unit was retired still
// has to render its unit, and the form filters to active ones for NEW choices.
export async function fetchAllUnits(
  tenantId: string,
): Promise<UnitOfMeasure[]> {
  return fetchAllPaged<UnitOfMeasure>((from, to) =>
    supabase
      .from('units_of_measure')
      .select('*')
      .eq('tenant_id', tenantId) // rule 19
      .is('deleted_at', null) // rule 5
      .order('display_order', { ascending: true })
      .order('unit_code', { ascending: true }) // stable tiebreak
      .range(from, to),
  );
}

export interface UnitWrite {
  unit_code?: string;
  name?: string;
  dimension?: UnitDimension;
  is_active?: boolean;
  display_order?: number;
}

// Add a unit of measure. Used by the "+ New unit" affordance on the item form,
// so somebody who buys yam by the TUBER can say so without leaving the form they
// are already filling in.
//
// THE CODE IS CANONICALISED HERE, not left to the caller. 035 constrains
// unit_code to `lower(btrim(unit_code))` and length > 0, and that check is what
// makes the plain unique (tenant_id, unit_code) behave case-insensitively — so
// 'KG' typed into the box is not a different unit, it is a constraint violation
// with an unreadable message. Lowercasing on the way in turns it into the same
// unit, which is what the person meant.
export async function createUnit(
  tenantId: string,
  values: UnitWrite & {
    unit_code: string;
    name: string;
    dimension: UnitDimension;
    display_order: number;
  },
): Promise<UnitOfMeasure> {
  const { data, error } = await supabase
    .from('units_of_measure')
    .insert({
      ...values,
      tenant_id: tenantId,
      unit_code: values.unit_code.trim().toLowerCase(),
      name: values.name.trim(),
    })
    .select()
    .single();

  if (error) throw error;
  return data as UnitOfMeasure;
}

// ===========================================================================
// Categories (tenant-level reference)
// ===========================================================================

export async function fetchAllCategories(
  tenantId: string,
): Promise<InventoryCategory[]> {
  return fetchAllPaged<InventoryCategory>((from, to) =>
    supabase
      .from('inventory_categories')
      .select('*')
      .eq('tenant_id', tenantId) // rule 19
      .is('deleted_at', null) // rule 5
      .order('display_order', { ascending: true })
      .order('name', { ascending: true })
      .range(from, to),
  );
}

export interface CategoryWrite {
  name?: string;
  is_active?: boolean;
  display_order?: number;
}

export async function createCategory(
  tenantId: string,
  values: CategoryWrite & { name: string; display_order: number },
): Promise<InventoryCategory> {
  const { data, error } = await supabase
    .from('inventory_categories')
    .insert({ tenant_id: tenantId, ...values })
    .select()
    .single();

  if (error) throw error;
  return data as InventoryCategory;
}

export async function updateCategory(
  id: string,
  tenantId: string,
  patch: CategoryWrite,
): Promise<InventoryCategory> {
  const { data, error } = await supabase
    .from('inventory_categories')
    .update(patch)
    .eq('id', id)
    .eq('tenant_id', tenantId) // rule 19
    .is('deleted_at', null) // rule 5: only patch a live row
    .select()
    .single();

  if (error) throw error;
  return data as InventoryCategory;
}

// Soft-delete a category. Items filed under it KEEP their category_id — the FK
// is deliberately NO ACTION (035 §3), so removing a category never removes or
// silently re-files its items; they simply show as uncategorised until re-filed.
export async function softDeleteCategory(
  id: string,
  tenantId: string,
): Promise<void> {
  const { error } = await supabase
    .from('inventory_categories')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id)
    .eq('tenant_id', tenantId) // rule 19
    .is('deleted_at', null); // idempotent: a retry after success is a no-op

  if (error) throw error;
}

// ===========================================================================
// Items (THE tenant-level catalogue)
// ===========================================================================

export interface ItemFilters {
  // Free-text search over name and code, applied server-side.
  search: string;
  // '' means "any" for both. Never encoded as null, so the caller's select
  // element has a real value to hold.
  itemType: ItemType | '';
  categoryId: string;
}

export const EMPTY_ITEM_FILTERS: ItemFilters = {
  search: '',
  itemType: '',
  categoryId: '',
};

export interface InventoryItemsPage {
  rows: InventoryItem[];
  count: number; // exact total for the FILTER (rules 1b/20), not the page length
}

// One SERVER-PAGINATED page of the tenant's live catalogue items (rule 1b —
// never a client-side slice of a capped fetch). `page` is 1-based.
//
// ORDERED BY NAME, not display_order, deliberately: a catalogue is looked up
// alphabetically ("where is Rice?"), and a hotel with three hundred items would
// find a curated order useless. display_order exists on the row for later
// curated groupings (a menu's order) and is not exposed in part 1.
//
// EVERY FILTER IS APPLIED SERVER-SIDE so the count, the page and the filter all
// describe the same set (rules 1b/20). A client-side filter over a fetched page
// would make "of N" a lie.
export async function fetchInventoryItemsPage(
  tenantId: string,
  page: number,
  pageSize: number,
  filters: ItemFilters = EMPTY_ITEM_FILTERS,
): Promise<InventoryItemsPage> {
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  let q = supabase
    .from('inventory_items')
    .select('*', { count: 'exact' })
    .eq('tenant_id', tenantId) // rule 19
    .is('deleted_at', null) // rule 5
    .order('name', { ascending: true })
    .order('created_at', { ascending: true }); // stable tiebreak

  const search = filters.search.trim();
  if (search.length > 0) {
    // PostgREST's or() takes a comma-separated filter list, so commas and
    // parens in the term would be read as syntax. Strip them (matching
    // fetchCompaniesPage) rather than trying to escape them.
    const safe = search.replace(/[,()*]/g, ' ').trim();
    if (safe.length > 0) {
      q = q.or(`name.ilike.%${safe}%,code.ilike.%${safe}%`);
    }
  }

  if (filters.itemType) q = q.eq('item_type', filters.itemType);
  if (filters.categoryId) q = q.eq('category_id', filters.categoryId);

  const { data, error, count } = await q.range(from, to);
  if (error) throw error;
  return { rows: (data ?? []) as InventoryItem[], count: count ?? 0 };
}

// The whole live catalogue for a tenant — for later parts that need every item
// at once (a recipe picker, a stock count sheet). Bounded via fetchAllPaged
// (rule 1a), never a bare select.
export async function fetchAllInventoryItems(
  tenantId: string,
  activeOnly = false,
): Promise<InventoryItem[]> {
  return fetchAllPaged<InventoryItem>((from, to) => {
    let q = supabase
      .from('inventory_items')
      .select('*')
      .eq('tenant_id', tenantId) // rule 19
      .is('deleted_at', null); // rule 5
    if (activeOnly) q = q.eq('is_active', true);
    return q.order('name', { ascending: true }).range(from, to);
  });
}

// The catalogue rows behind a page of something else — the movement lists name
// their item this way, because stock_movements carries an item id and no name.
//
// The `.in()` is over the ids of ONE page and is therefore a BOUNDED list, which
// is what rule 1a requires (it forbids a bare `.in()` over an unbounded one); the
// caller must not hand this the whole catalogue. fetchAllPaged wraps it anyway so
// the read cannot silently truncate. Soft-deleted items are INCLUDED on purpose:
// a movement against an item that has since been retired still has to render its
// name, or the ledger reads as a row about nothing.
export async function fetchInventoryItemsByIds(
  tenantId: string,
  ids: string[],
): Promise<InventoryItem[]> {
  if (ids.length === 0) return [];
  return fetchAllPaged<InventoryItem>((from, to) =>
    supabase
      .from('inventory_items')
      .select('*')
      .eq('tenant_id', tenantId) // rule 19
      .in('id', ids)
      .order('id', { ascending: true }) // unique → stable range pagination
      .range(from, to),
  );
}

export interface InventoryItemWrite {
  name?: string;
  code?: string | null;
  item_type?: ItemType;
  base_unit?: string;
  category_id?: string | null;
  is_perishable?: boolean;
  // 038 §1C. When TRUE, every stock-IN of this item must state a batch code and
  // an expiry date — enforced by the posting RPCs, not by this form. Different
  // from is_perishable, which describes the goods and commits nobody to anything.
  tracks_expiry?: boolean;
  // A JS number or null here; the column is numeric(14,4) and comes BACK as a
  // string (§6). Null means "not monitored", never 0 — a zero threshold is a
  // real setting that means something different.
  reorder_level?: number | null;

  // The standard field set (037). Every one is nullable and NULL means "not
  // stated" — never 0, and never ''. An empty barcode string would collide with
  // every other empty one on 037's unique index, so the caller passes null.
  barcode?: string | null;
  pack_size?: string | null;
  // numbers here, numeric(14,2)/(14,4) in the database, STRINGS on the way back.
  purchase_cost?: number | null;
  min_stock_level?: number | null;
  max_stock_level?: number | null;

  is_active?: boolean;
  display_order?: number;
}

export async function createInventoryItem(
  tenantId: string,
  values: InventoryItemWrite & {
    name: string;
    item_type: ItemType;
    base_unit: string;
  },
): Promise<InventoryItem> {
  const { data, error } = await supabase
    .from('inventory_items')
    .insert({ tenant_id: tenantId, ...values })
    .select()
    .single();

  if (error) throw error;
  return data as InventoryItem;
}

export async function updateInventoryItem(
  id: string,
  tenantId: string,
  patch: InventoryItemWrite,
): Promise<InventoryItem> {
  const { data, error } = await supabase
    .from('inventory_items')
    .update(patch)
    .eq('id', id)
    .eq('tenant_id', tenantId) // rule 19
    .is('deleted_at', null) // rule 5
    .select()
    .single();

  if (error) throw error;
  return data as InventoryItem;
}

// Soft-delete an item (§6: master data is never hard-deleted, and 035 ships no
// DELETE policy so the hard path does not exist). Part 2/3 will additionally
// refuse when the item holds stock or a live recipe references it (035 §7).
export async function softDeleteInventoryItem(
  id: string,
  tenantId: string,
): Promise<void> {
  const { error } = await supabase
    .from('inventory_items')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id)
    .eq('tenant_id', tenantId) // rule 19
    .is('deleted_at', null); // idempotent

  if (error) throw error;
}

// ===========================================================================
// Locations (property-level)
// ===========================================================================

// Every live location for a property. NOT a paged surface, and that is a
// deliberate reading of rule 1b rather than an omission: the rule forbids a
// CAPPED list with no way to reach the rest, and fetchAllPaged returns the
// COMPLETE set (rule 1a) — nothing is unreachable. A property has a handful of
// locations, and reordering them requires the whole ordered list in hand, which
// paging would break across a page boundary.
export async function fetchLocations(
  propertyId: string,
  tenantId: string,
): Promise<StockLocation[]> {
  return fetchAllPaged<StockLocation>((from, to) =>
    supabase
      .from('locations')
      .select('*')
      .eq('tenant_id', tenantId) // rule 19
      .eq('property_id', propertyId) // rule 19: active property
      .is('deleted_at', null) // rule 5
      .order('display_order', { ascending: true })
      .order('name', { ascending: true })
      .order('created_at', { ascending: true }) // stable final tiebreak
      .range(from, to),
  );
}

export interface LocationWrite {
  name?: string;
  kind?: LocationKind;
  // Setting this TRUE clears the previous default in the same statement — 037's
  // BEFORE trigger does it, so the client never issues a clear-then-set pair
  // (two writes are not one transaction, and a half-applied pair leaves the
  // property with no default at all).
  is_default_store?: boolean;
  is_active?: boolean;
  display_order?: number;
}

export async function createLocation(
  tenantId: string,
  propertyId: string,
  values: LocationWrite & {
    name: string;
    kind: LocationKind;
    display_order: number;
  },
): Promise<StockLocation> {
  const { data, error } = await supabase
    .from('locations')
    .insert({ tenant_id: tenantId, property_id: propertyId, ...values })
    .select()
    .single();

  if (error) throw error;
  return data as StockLocation;
}

export async function updateLocation(
  id: string,
  tenantId: string,
  propertyId: string,
  patch: LocationWrite,
): Promise<StockLocation> {
  const { data, error } = await supabase
    .from('locations')
    .update(patch)
    .eq('id', id)
    .eq('tenant_id', tenantId) // rule 19
    .eq('property_id', propertyId) // rule 19
    .is('deleted_at', null) // rule 5
    .select()
    .single();

  if (error) throw error;
  return data as StockLocation;
}

// Soft-delete a location. Part 2 will refuse this outright while the location
// still holds stock (035 §7) — removing a box that still has things in it
// strands that stock in the ledger where no screen can ever reconcile it.
export async function softDeleteLocation(
  id: string,
  tenantId: string,
  propertyId: string,
): Promise<void> {
  const { error } = await supabase
    .from('locations')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id)
    .eq('tenant_id', tenantId) // rule 19
    .eq('property_id', propertyId) // rule 19
    .is('deleted_at', null); // idempotent

  if (error) throw error;
}

// ===========================================================================
// Where stock arrives: the designated receiving store
// ===========================================================================

// THE ONE IMPLEMENTATION of "which location does stock come into by default".
// Every receiving surface reads it — the opening-stock import today, purchase
// receipts (2c) tomorrow — so that they cannot disagree about where a delivery
// lands. The order is documented in 037 §2 and repeated here because this is
// where it actually runs:
//
//   1. the location the hotel DESIGNATED (is_default_store), if it is live and
//      in use — the owner's own answer, and it beats every rule below;
//   2. else the first ACTIVE kind='store', in the hotel's own display order.
//      Stock is received into a store and issued out of it (035 §4) — that is
//      what the kind means — so a store beats a kitchen even when the kitchen
//      sorts first;
//   3. else the first active location of any kind, because a property that has
//      no store at all still has to be able to record what it holds;
//   4. else null, and the screen asks rather than guessing.
//
// Rows arrive already ordered by display_order then name (fetchLocations), so
// "first" here means the hotel's own order rather than an arbitrary one.
export function pickDefaultLocation(
  locations: StockLocation[],
): StockLocation | null {
  const live = locations.filter((l) => l.deleted_at === null);
  const usable = live.filter((l) => l.is_active);

  return (
    usable.find((l) => l.is_default_store && l.kind === 'store') ??
    usable.find((l) => l.kind === 'store') ??
    usable[0] ??
    null
  );
}
