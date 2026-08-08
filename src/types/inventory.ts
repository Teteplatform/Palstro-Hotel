// DB row types for the inventory catalogue and locations
// (supabase/migrations/035_inventory_catalogue.sql). Keep in sync with the
// migration — no fields the schema does not have.
//
// THE SCOPING SPLIT, repeated here because it decides every query in
// src/lib/inventory.ts: the CATALOGUE (units, categories, items) is TENANT-level
// — one definition of "Rice" shared by every property. LOCATIONS are
// PROPERTY-level. Stock levels and movements are property-level too and do not
// exist yet (part 2/3).

// ---------------------------------------------------------------------------
// Units of measure
// ---------------------------------------------------------------------------

// What the unit measures. Used later (part 3) to reject a recipe line that
// measures a mass-tracked item in a volume unit.
export type UnitDimension = 'mass' | 'volume' | 'count' | 'length';

export interface UnitOfMeasure {
  id: string;
  tenant_id: string;
  // Canonical LOWERCASE code ('kg', 'ml', 'piece'). inventory_items.base_unit
  // holds this exact string — the FK is by code, not by id, so an item row reads
  // its unit without a join.
  unit_code: string;
  name: string;
  dimension: UnitDimension;
  is_active: boolean;
  display_order: number;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export interface InventoryCategory {
  id: string;
  tenant_id: string;
  name: string;
  is_active: boolean;
  display_order: number;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

// raw      — an ingredient, consumed only through a recipe, never sold directly.
// finished — sold as-is; one sale deducts one base unit of this item.
// both     — sold as-is AND usable in a recipe (a 50cl Coke sold over the bar
//            and poured into a cocktail). Not redundant: as 'finished' the
//            cocktail use would never deduct; as 'raw' the direct sale would
//            have nowhere to post.
export type ItemType = 'raw' | 'finished' | 'both';

export interface InventoryItem {
  id: string;
  tenant_id: string; // no property_id — the catalogue is tenant-wide
  name: string;
  code: string | null;
  item_type: ItemType;
  // The unit_code of a units_of_measure row belonging to the SAME tenant
  // (composite FK). The smallest breakable unit the storekeeper measures; there
  // is no purchase-unit conversion factor in this module by design.
  base_unit: string;
  category_id: string | null;
  is_perishable: boolean;
  // numeric(14,4) — PostgREST returns numeric as a STRING to preserve precision
  // (CLAUDE.md §6). Parse with parseNumeric before any arithmetic or comparison.
  reorder_level: string | null;

  // --- the standard field set (037) ---------------------------------------
  // The manufacturer's scanned code, separate from `code` (the hotel's own short
  // reference). Unique per tenant where set.
  barcode: string | null;
  // How it is packed, as a sentence: 'carton of 24'. TEXT, never a number — a
  // numeric here would be read as a purchase-to-base conversion factor, and this
  // module deliberately has none (035: everything is entered in the base unit).
  pack_size: string | null;
  // numeric(14,2) as a STRING (§6). The standard BUY cost of one base unit,
  // informational only — valuation is the moving average folded from the
  // movements (036 §2) and nothing reads this to value anything.
  purchase_cost: string | null;
  // numeric(14,4) as STRINGS (§6). The ordering par range. NEITHER is the alert:
  // the low-stock flag compares on-hand against reorder_level (036 §3.2). These
  // are read by purchasing (2c) to suggest an order quantity.
  min_stock_level: string | null;
  max_stock_level: string | null;

  is_active: boolean;
  display_order: number;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
}

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

// The kind drives BEHAVIOUR in later parts, not just a label:
//   store        — holds bulk stock and issues it to other locations.
//   kitchen      — consumes stock through recipes.
//   bar          — sells directly AND pours recipes.
//   housekeeping — stocks rooms; an amenity issue IS a stock movement.
//   other        — spares/chemicals; holds and issues, no sales or recipes.
// Kinds are NOT unique per property: two bars are normal, each with its own
// stock and its own variance. No code may assume "the" bar.
export type LocationKind =
  | 'store'
  | 'kitchen'
  | 'bar'
  | 'housekeeping'
  | 'other';

export interface StockLocation {
  id: string;
  tenant_id: string;
  property_id: string;
  name: string;
  kind: LocationKind;
  // The property's designated RECEIVING point — where stock arrives by default
  // (037). At most one per property, and only ever a kind='store'. An OVERRIDE
  // of the fallback rule in pickDefaultLocation, not a prerequisite for it.
  is_default_store: boolean;
  is_active: boolean;
  display_order: number;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
}
