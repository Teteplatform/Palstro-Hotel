-- ============================================================================
-- 035_inventory_catalogue.sql
-- Palstro-Hotels: the inventory item CATALOGUE and the stock-holding LOCATIONS.
-- F&B/Inventory part 1 — the foundation everything later (purchasing,
-- requisitions, recipes, consumption, variance) hangs off.
--
-- ----------------------------------------------------------------------------
-- THE SCOPING SPLIT THIS MIGRATION EXISTS TO GET RIGHT
-- ----------------------------------------------------------------------------
-- The CATALOGUE is TENANT-level: define "Rice" once and every property in the
-- group uses the same item, the same base unit, the same category. STOCK and
-- MOVEMENTS are PROPERTY-level and arrive in part 2/3 — they are deliberately
-- NOT in this migration. LOCATIONS (the cost-centre boxes that will own that
-- stock) are PROPERTY-level and ARE built here, because a location is
-- configuration a hotel sets up once, not a movement.
--
-- Getting this wrong is expensive later: a per-property catalogue means the same
-- carton of soap is a different item in the kitchen and in housekeeping, and
-- docs/ARCHITECTURE.md is explicit that two catalogues make the food-cost report
-- and the amenity-cost report disagree forever. One catalogue, many locations.
--
-- ----------------------------------------------------------------------------
-- WHAT IS AND IS NOT HERE
-- ----------------------------------------------------------------------------
-- IS:     units of measure, item categories, inventory_items, locations, their
--         RLS, their seeds, and the reference data a tenant/property starts with.
-- IS NOT: stock levels, movements (receipt/issue/transfer/adjustment/wastage),
--         recipes, suppliers, purchase orders, counts, WAC valuation, or any GL
--         posting. No money logic of any kind — there is not one numeric(14,2)
--         column in this file.
--
-- ----------------------------------------------------------------------------
-- CONVENTIONS INHERITED (001/002/006/016) — all load-bearing
-- ----------------------------------------------------------------------------
--   * All four tables are MASTER DATA (docs/ARCHITECTURE.md layer 2,
--     Configuration), so per CLAUDE.md §6 they carry `deleted_at` soft-delete —
--     NOT `is_voided`, which is for transactional records — and NO business_date.
--     Nothing in this file "happened" on an operating day; the movements in part
--     2/3 did, and those will carry business_date.
--   * The shared set_row_audit() trigger owns every audit column on every table.
--   * The generic log_field_changes() trigger records field-level history on
--     every table, so "who renamed this item / changed its reorder level" is
--     answerable — the customer's stated pain is staff theft.
--   * Composite FKs bind a child's scoping columns to its parent's paired unique
--     key, so tenant_id can never disagree with the parent's tenant (§6).
--   * RLS: member READ via get_tenant_ids(), admin WRITE via is_tenant_admin().
--     NO delete policy anywhere and NO public policy anywhere.
--   * Quantities are numeric(14,4) (§6) — four decimals, because a reorder level
--     of 0.2500 kg is a real threshold and 2dp rounding drift is exactly what
--     destroys the variance reports this module exists to produce.
-- ============================================================================


-- ############################################################################
-- SECTION 1 — units_of_measure (tenant-level reference)
-- ############################################################################
-- WHY A TABLE AND NOT A CHECK CONSTRAINT.
-- The brief offered a constrained set OR a reference table. A table wins on
-- three counts:
--   1. A CHECK cannot carry the unit's DISPLAY NAME ('Kilogram') or its
--      DIMENSION (mass/volume/count/length), and the dimension is what will let
--      part 3 reject a recipe that measures a mass item in millilitres.
--   2. Every new unit a hotel needs ('tuber', 'bunch', 'crate') would otherwise
--      be a code change and a migration. Here it is a row.
--   3. It is the FK target that makes 'kg' vs 'kgs' STRUCTURALLY impossible
--      rather than a matter of data-entry discipline. That typo is not
--      hypothetical: two spellings of one unit silently splits an item's stock
--      and its recipe measures into two incompatible scales.
--
-- WHY TENANT-SCOPED AND NOT ONE GLOBAL LIST.
-- Rule 13 wants tenant_id + RLS on every table, and a global read-only list
-- would leave a hotel that buys yam by the TUBER unable to record it at all.
-- Each tenant gets its own seeded copy (SECTION 5) and may add to it.
create table if not exists units_of_measure (
  id            uuid primary key default gen_random_uuid(),
  -- Plain FK to tenants(id): a unit has no property scope (the catalogue is
  -- tenant-wide, so its units must be too). The unique (tenant_id, unit_code)
  -- key below is the composite-FK TARGET inventory_items.base_unit binds to.
  tenant_id     uuid not null references tenants(id) on delete cascade,

  -- The stored, machine-side code: 'kg', 'ml', 'piece'. Forced lowercase and
  -- trimmed by the check below, which is what makes the plain unique constraint
  -- BEHAVE case-insensitively without needing citext or an expression index —
  -- and an expression index could not serve as an FK target, which this must.
  unit_code     text not null,
  -- The human label shown in every picker: 'Kilogram', 'Millilitre', 'Piece'.
  name          text not null,

  -- What the unit MEASURES. Not decoration: part 3 uses it to reject a recipe
  -- line that measures a mass-tracked item in a volume unit, and reports group
  -- by it. 'count' covers discrete items (piece, bottle, sachet).
  dimension     text not null
                  constraint units_of_measure_dimension_check
                  check (dimension in ('mass', 'volume', 'count', 'length')),

  is_active     boolean not null default true,
  display_order integer not null default 0,

  deleted_at    timestamptz,                 -- soft delete (master data, rule 5)
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid default auth.uid() references auth.users(id),
  updated_by    uuid references auth.users(id),

  -- Canonical form. With this in place, `unique (tenant_id, unit_code)` is a
  -- case-insensitive uniqueness guarantee: 'KG' can never be stored, so it can
  -- never coexist with 'kg'.
  constraint units_of_measure_code_canonical_check
    check (unit_code = lower(btrim(unit_code)) and length(unit_code) > 0),

  -- THE FK TARGET for inventory_items.(tenant_id, base_unit). Deliberately NOT
  -- partial on deleted_at: a plain unique constraint is required for an FK, and
  -- a retired unit must keep owning its code anyway — reusing 'kg' to mean
  -- something else would silently rescale every historical item that used it.
  constraint units_of_measure_tenant_code_unique unique (tenant_id, unit_code),
  -- Paired-key target for any future child that references a unit by id.
  constraint units_of_measure_id_tenant_unique   unique (id, tenant_id)
);

comment on table units_of_measure is
  'The tenant''s units of measure — the smallest BREAKABLE units stock is '
  'tracked in. A reference table, not a check constraint, so a unit carries a '
  'display name and a dimension and can be added without a migration. It is the '
  'FK target for inventory_items.base_unit, which is what makes ''kg'' vs '
  '''kgs'' structurally impossible rather than a matter of discipline. Seeded '
  'per tenant on provision (SECTION 5); a tenant may add its own.';
comment on column units_of_measure.unit_code is
  'Canonical lowercase code (''kg'', ''ml'', ''piece''), forced by a check so '
  'the plain unique (tenant_id, unit_code) behaves case-insensitively — and so '
  'it can still serve as an FK target, which an expression index could not.';
comment on column units_of_measure.dimension is
  'What the unit measures: mass/volume/count/length. Load-bearing later — part 3 '
  'uses it to reject a recipe line that measures a mass item in a volume unit.';

-- The picker reads the tenant's live units in display order.
create index if not exists units_of_measure_tenant_order_idx
  on units_of_measure (tenant_id, display_order);
-- tenant_id drives the member-select policy predicate; index it as 001/002 do.
create index if not exists units_of_measure_tenant_id_idx
  on units_of_measure (tenant_id);

drop trigger if exists set_row_audit_units_of_measure on units_of_measure;
create trigger set_row_audit_units_of_measure
  before insert or update on units_of_measure
  for each row execute function set_row_audit();

drop trigger if exists log_field_changes_units_of_measure on units_of_measure;
create trigger log_field_changes_units_of_measure
  after update on units_of_measure for each row execute function log_field_changes();


-- ############################################################################
-- SECTION 2 — inventory_categories (tenant-level reference)
-- ############################################################################
-- WHY A TABLE AND NOT `category text`.
-- Category is the GROUPING AXIS of every report this module is built to
-- produce — food cost by category, wastage by category, stock value by
-- category. Free text guarantees 'Drinks', 'drinks' and 'Drink' end up as three
-- categories, and three rows in a report that should have one. That is not a
-- cosmetic problem: the owner reads those three lines as three different things.
-- The cost of the table is one join; the cost of free text is a permanently
-- fragmented report nobody can reconcile (rule 9).
--
-- Kept deliberately THIN — a name and ordering, nothing else. Categories are a
-- grouping label, not a hierarchy; a parent_id would invite a tree nobody asked
-- for and every report would then have to decide whether to roll up.
create table if not exists inventory_categories (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,

  name          text not null,               -- 'Grains', 'Drinks', 'Toiletries'

  is_active     boolean not null default true,
  display_order integer not null default 0,

  deleted_at    timestamptz,                 -- soft delete (master data, rule 5)
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid default auth.uid() references auth.users(id),
  updated_by    uuid references auth.users(id),

  -- Composite-FK TARGET for inventory_items.(category_id, tenant_id), so an item
  -- can never be filed under another tenant's category.
  constraint inventory_categories_id_tenant_unique unique (id, tenant_id)
);

comment on table inventory_categories is
  'Per-tenant grouping labels for catalogue items (Grains, Drinks, Toiletries). '
  'A table rather than free text because category is the grouping axis of the '
  'food-cost, wastage and stock-value reports, and free text fragments those '
  'reports into Drinks/drinks/Drink. Deliberately flat — no hierarchy.';

-- Case-insensitive uniqueness per tenant, LIVE rows only: a removed category
-- releases its name for reuse (unlike a unit code, a category name carries no
-- scale, so reusing it cannot silently rescale anything).
create unique index if not exists inventory_categories_tenant_name_live_uniq
  on inventory_categories (tenant_id, lower(name))
  where deleted_at is null;

create index if not exists inventory_categories_tenant_order_idx
  on inventory_categories (tenant_id, display_order);
create index if not exists inventory_categories_tenant_id_idx
  on inventory_categories (tenant_id);

drop trigger if exists set_row_audit_inventory_categories on inventory_categories;
create trigger set_row_audit_inventory_categories
  before insert or update on inventory_categories
  for each row execute function set_row_audit();

drop trigger if exists log_field_changes_inventory_categories on inventory_categories;
create trigger log_field_changes_inventory_categories
  after update on inventory_categories for each row execute function log_field_changes();


-- ############################################################################
-- SECTION 3 — inventory_items (THE TENANT-LEVEL CATALOGUE)
-- ############################################################################
-- One row per thing the hotel holds, consumes or sells. TENANT-scoped: no
-- property_id, by design (see the header). The same 'Rice' is the same item in
-- every property of the group; only its STOCK differs, and stock is part 2.
--
-- THE THREE ITEM TYPES, and why three and not two:
--   'raw'      — an ingredient. Consumed ONLY through a recipe, never sold on
--                its own. Rice, vegetable oil, a bar of soap issued to a room.
--                It will never appear on a menu or a bar list.
--   'finished' — sold as-is. One sale deducts exactly one base unit of THIS
--                item. A packet of biscuits, a bottle of water.
--   'both'     — sold as-is AND usable inside a recipe. A 50cl Coke sold over
--                the bar counter, and the same Coke poured into a cocktail. The
--                type exists because collapsing it into either of the other two
--                loses real consumption: called 'finished' its cocktail use
--                never deducts (the bar runs dry with stock "on hand"), called
--                'raw' its direct sale has nowhere to post. Both deductions are
--                real; the item must support both paths.
-- The type is a CHECK, not a reference table — unlike units and categories these
-- three values are BEHAVIOUR the code branches on, not data a tenant configures.
-- Adding a fourth would be a code change by definition, so a migration is right.
create table if not exists inventory_items (
  id             uuid primary key default gen_random_uuid(),
  -- Plain FK to tenants(id). NO property_id — the catalogue is tenant-wide.
  -- (The composite FKs below still bind category and unit to this tenant.)
  tenant_id      uuid not null references tenants(id) on delete cascade,

  name           text not null,              -- 'Rice', 'Coca-Cola 50cl'
  -- Optional short code the storekeeper writes on a bin card or scans later.
  -- Nullable: most hotels start without codes and add them when they grow.
  code           text,

  item_type      text not null
                   constraint inventory_items_type_check
                   check (item_type in ('raw', 'finished', 'both')),

  -- THE SMALLEST BREAKABLE UNIT this item is tracked in — the unit the
  -- storekeeper actually measures. There is deliberately NO purchase-unit
  -- conversion factor in this module: stock is counted in the base unit and
  -- entered in the base unit, so there is no factor to get wrong and no
  -- carton-vs-piece ambiguity to reconcile. A purchase of 5 cartons is entered
  -- as the base quantity it actually is.
  base_unit      text not null,

  -- Nullable: an item may be uncategorised. NOT NULL would force a junk
  -- category on day one, which is worse than an honest blank in a report.
  category_id    uuid,

  -- Informational ONLY in part 1. Expiry tracking, wastage and shelf-life
  -- reporting are later parts; this flag is what they will key off, and
  -- capturing it now costs nothing while backfilling it later costs a data
  -- clean-up across the whole catalogue.
  is_perishable  boolean not null default false,

  -- The low-stock threshold, in the item's base unit. numeric(14,4) per §6:
  -- quantities are four-decimal because 0.2500 kg is a real threshold. The
  -- low-stock ALERT is a later report; this is only the number it will read.
  -- Nullable — an item with no threshold is simply not monitored.
  reorder_level  numeric(14,4)
                   constraint inventory_items_reorder_level_check
                   check (reorder_level is null or reorder_level >= 0),

  is_active      boolean not null default true,
  display_order  integer not null default 0,

  deleted_at     timestamptz,                -- soft delete (master data, rule 5)
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  created_by     uuid default auth.uid() references auth.users(id),
  updated_by     uuid references auth.users(id),

  -- Composite FK: the item's base unit must be a unit OF THIS TENANT (§6
  -- composite-key consistency). Referencing by CODE rather than by id is
  -- deliberate — the item row then reads `base_unit: 'kg'` with no join, which
  -- every list screen and every later report wants, while the FK still gives
  -- full referential integrity. ON UPDATE CASCADE so correcting a unit's code
  -- carries through instead of being blocked.
  -- ON DELETE is left as NO ACTION (not RESTRICT, not CASCADE): CASCADE would
  -- let removing a unit destroy items, and RESTRICT is checked immediately,
  -- which would break a tenant hard-delete where units and items cascade away
  -- together. NO ACTION is checked at end of statement, so that teardown works.
  constraint inventory_items_base_unit_fk
    foreign key (tenant_id, base_unit)
    references units_of_measure (tenant_id, unit_code)
    on update cascade,

  -- Composite FK: the category must belong to THIS tenant. Same NO ACTION
  -- reasoning — a category must never take its items with it.
  constraint inventory_items_category_tenant_fk
    foreign key (category_id, tenant_id)
    references inventory_categories (id, tenant_id),

  -- Paired-key target so part 2's stock rows and part 3's recipe lines can bind
  -- (item_id, tenant_id) and inherit the same cross-tenant guard.
  constraint inventory_items_id_tenant_unique unique (id, tenant_id)
);

comment on table inventory_items is
  'THE SHARED ITEM CATALOGUE — tenant-level by design: define an item once and '
  'every property uses it. Stock levels and movements are PROPERTY-scoped and '
  'live in part 2/3, never here. One catalogue is what makes the food-cost '
  'report and the amenity-cost report agree (docs/ARCHITECTURE.md): built twice, '
  'two ledgers value the same carton of soap at two different costs.';
comment on column inventory_items.item_type is
  'raw = ingredient, consumed only via a recipe, never sold directly. '
  'finished = sold as-is, one sale deducts one base unit of this item. '
  'both = sold as-is AND usable in a recipe (a 50cl Coke sold at the bar and '
  'poured into a cocktail). ''both'' is not redundant: as ''finished'' the '
  'cocktail use would never deduct, as ''raw'' the direct sale would have '
  'nowhere to post. A CHECK not a table — these are behaviours code branches '
  'on, not values a tenant configures.';
comment on column inventory_items.base_unit is
  'The smallest BREAKABLE unit this item is tracked in, and the unit the '
  'storekeeper physically measures. There is NO purchase-unit conversion factor '
  'in this module by design — everything is entered in the base unit, so there '
  'is no factor to get wrong. FK-bound to this tenant''s units_of_measure.';
comment on column inventory_items.reorder_level is
  'Low-stock threshold in the base unit, numeric(14,4) per §6. The alert itself '
  'is a later report; this only captures the number it will read. NULL means the '
  'item is not monitored.';
comment on column inventory_items.is_active is
  'Whether the item is currently in use. Two DIFFERENT axes, both real: '
  'deleted_at removes it from the catalogue entirely; is_active=false keeps it '
  'listed but flagged out-of-use (a seasonal line, a discontinued brand still '
  'holding stock). Matches companies.is_active (016).';

-- Case-insensitive uniqueness per tenant, LIVE rows only (rule 5). A tenant must
-- not end up with 'Rice' twice; a removed item releases its name for reuse.
create unique index if not exists inventory_items_tenant_name_live_uniq
  on inventory_items (tenant_id, lower(name))
  where deleted_at is null;

-- Same for the optional code, but only where one is SET — a nullable column with
-- many NULLs must not collide with itself.
create unique index if not exists inventory_items_tenant_code_live_uniq
  on inventory_items (tenant_id, lower(code))
  where code is not null and deleted_at is null;

-- The admin list pages by name within a tenant; the type and category filters
-- are applied SERVER-SIDE (rule 1b) so these back them.
create index if not exists inventory_items_tenant_name_idx
  on inventory_items (tenant_id, name);
create index if not exists inventory_items_tenant_type_idx
  on inventory_items (tenant_id, item_type);
create index if not exists inventory_items_category_id_idx
  on inventory_items (category_id);
create index if not exists inventory_items_tenant_id_idx
  on inventory_items (tenant_id);

drop trigger if exists set_row_audit_inventory_items on inventory_items;
create trigger set_row_audit_inventory_items
  before insert or update on inventory_items
  for each row execute function set_row_audit();

drop trigger if exists log_field_changes_inventory_items on inventory_items;
create trigger log_field_changes_inventory_items
  after update on inventory_items for each row execute function log_field_changes();


-- ############################################################################
-- SECTION 4 — locations (PROPERTY-level cost centres that will own stock)
-- ############################################################################
-- A location is a BOX THAT HOLDS STOCK: the main store, the kitchen, a specific
-- bar. Property-scoped because stock is physical and a carton in the Bonny
-- Island kitchen is not a carton in another hotel's kitchen.
--
-- WHAT `kind` DRIVES IN LATER PARTS (it is behaviour, not a label):
--   'store'        — holds bulk stock and ISSUES it to other locations. A
--                    requisition is raised AGAINST a store; purchases receive
--                    INTO one. Typically not a point of sale.
--   'kitchen'      — CONSUMES stock through recipes. An F&B sale of a plated
--                    dish deducts its recipe ingredients from the kitchen that
--                    produced it (part 3's theoretical-vs-actual variance is
--                    computed per kitchen).
--   'bar'          — SELLS stock, both directly ('finished'/'both' items over
--                    the counter) and through recipes (cocktails). The one kind
--                    that routinely does both deduction paths at once.
--   'housekeeping' — STOCKS ROOMS. Issuing an amenity kit while cleaning is a
--                    stock movement against this location, not a separate
--                    housekeeping count (docs/ARCHITECTURE.md department hooks).
--   'other'        — anything the four above do not describe: a maintenance
--                    spares cupboard, a laundry chemical store. Holds and issues
--                    stock with no sales or recipe behaviour attached.
--
-- KINDS ARE NOT UNIQUE PER PROPERTY, deliberately: a hotel can have a Poolside
-- Bar and an Executive Lounge Bar, both kind='bar', each with its own stock and
-- its own variance. Nothing in this schema or in later parts may assume "the"
-- bar. Only the NAME is unique per property.
create table if not exists locations (
  id            uuid primary key default gen_random_uuid(),
  -- No inline FKs: the composite FK below binds the pair to the property, so a
  -- location's tenant can never disagree with its property's tenant.
  tenant_id     uuid not null,
  property_id   uuid not null,

  -- The hotel's OWN name for the box: 'Main Store', 'Poolside Bar', 'Dry Store'.
  -- Seeded with sensible defaults (SECTION 5) that a hotel renames freely.
  name          text not null,

  kind          text not null
                  constraint locations_kind_check
                  check (kind in ('store', 'kitchen', 'bar', 'housekeeping', 'other')),

  is_active     boolean not null default true,
  display_order integer not null default 0,

  deleted_at    timestamptz,                 -- soft delete (master data, rule 5)
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid default auth.uid() references auth.users(id),
  updated_by    uuid references auth.users(id),

  -- Composite FK: (property_id, tenant_id) must match a real properties row —
  -- the same cross-tenant leak guard room_types and rooms carry (002).
  constraint locations_property_tenant_fk
    foreign key (property_id, tenant_id)
    references properties (id, tenant_id) on delete cascade,

  -- Paired-key targets for part 2's stock and movement rows, which will bind
  -- (location_id, property_id) and (location_id, tenant_id).
  constraint locations_id_property_unique unique (id, property_id),
  constraint locations_id_tenant_unique   unique (id, tenant_id)
);

comment on table locations is
  'PROPERTY-level cost centres that own stock — main store, kitchen, each bar, '
  'housekeeping. Configurable data, never hardcoded: a hotel renames, adds and '
  'removes them. `kind` drives BEHAVIOUR in later parts (a store issues, a '
  'kitchen consumes via recipes, a bar sells and pours, housekeeping stocks '
  'rooms). Kinds are NOT unique — a property may have several bars, each with '
  'its own stock and its own variance. Whether the module appears at all is a '
  'separate question, gated by tenant_settings.enabled_modules (006/007).';
comment on column locations.kind is
  'store = holds bulk and issues it; kitchen = consumes via recipes; bar = sells '
  'directly AND pours recipes; housekeeping = stocks rooms (an amenity issue IS '
  'a stock movement); other = spares/chemicals, holds and issues only. Not '
  'unique per property — two bars are normal and each keeps its own stock.';
comment on column locations.is_active is
  'A closed-for-the-season bar stays on file with is_active=false and keeps its '
  'stock history; deleted_at removes it from the list entirely. Two axes.';

-- Names are unique within a property for LIVE rows only, case-insensitively: a
-- removed location releases its name (renaming and reopening a bar is normal).
create unique index if not exists locations_property_name_live_uniq
  on locations (property_id, lower(name))
  where deleted_at is null;

-- Operational screens list a property's locations in the owner's chosen order.
create index if not exists locations_property_order_idx
  on locations (property_id, display_order);
create index if not exists locations_tenant_id_idx
  on locations (tenant_id);

drop trigger if exists set_row_audit_locations on locations;
create trigger set_row_audit_locations
  before insert or update on locations
  for each row execute function set_row_audit();

drop trigger if exists log_field_changes_locations on locations;
create trigger log_field_changes_locations
  after update on locations for each row execute function log_field_changes();


-- ############################################################################
-- SECTION 5 — Seeds: reference data every tenant and property starts with
-- ############################################################################
-- Same shape as 001's create_tenant_settings_row/create_property_settings_row:
-- a SECURITY DEFINER function with a pinned search_path (the admin-only insert
-- policies below would otherwise block the trigger's own write), fired AFTER
-- INSERT, and idempotent via ON CONFLICT DO NOTHING so re-running is a no-op.
--
-- WHY SEED AT ALL. Units are NOT optional — inventory_items.base_unit is NOT
-- NULL and FK-bound, so a tenant with an empty units table cannot create a
-- single item. An empty picker on the first screen a new hotel opens is a dead
-- end, not a blank slate. Categories and locations are seeded for the same
-- reason in weaker form: a sensible starting set the hotel edits beats an empty
-- screen that gives no hint of what belongs there.

-- ----------------------------------------------------------------------------
-- 5.1 Tenant reference data — units and categories
-- ----------------------------------------------------------------------------
create or replace function seed_tenant_inventory_reference(
  p_tenant_id uuid,
  p_actor     uuid default null
)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  -- The actor rule of set_row_audit(): the session user when there is one,
  -- falling back to an explicitly supplied actor (the trigger passes the
  -- property/tenant creator; the backfill below has no session and passes NULL,
  -- which correctly records "seeded by the system, not by a person").
  v_actor uuid := coalesce(auth.uid(), p_actor);
begin
  -- Units. Deliberately generous, and weighted to what a Nigerian hotel
  -- actually measures: mass and volume for the kitchen and bar, plus the count
  -- units a storekeeper really uses (a tuber of yam, a bunch of plantain).
  -- Codes are lowercase — the canonical-form check requires it.
  insert into units_of_measure
    (tenant_id, unit_code, name, dimension, display_order, created_by)
  select p_tenant_id, u.code, u.label, u.dim, u.ord, v_actor
  from (values
    ('g',      'Gram',        'mass',   10),
    ('kg',     'Kilogram',    'mass',   20),
    ('ml',     'Millilitre',  'volume', 30),
    ('cl',     'Centilitre',  'volume', 40),
    ('litre',  'Litre',       'volume', 50),
    ('piece',  'Piece',       'count',  60),
    ('pack',   'Pack',        'count',  70),
    ('sachet', 'Sachet',      'count',  80),
    ('bottle', 'Bottle',      'count',  90),
    ('can',    'Can',         'count', 100),
    ('tin',    'Tin',         'count', 110),
    ('roll',   'Roll',        'count', 120),
    ('pair',   'Pair',        'count', 130),
    ('tuber',  'Tuber',       'count', 140),
    ('bunch',  'Bunch',       'count', 150),
    ('m',      'Metre',       'length',160)
  ) as u(code, label, dim, ord)
  on conflict (tenant_id, unit_code) do nothing;

  -- Categories. A starting vocabulary, not a fixed taxonomy — every one of
  -- these is renameable and removable, and a hotel will add its own.
  insert into inventory_categories
    (tenant_id, name, display_order, created_by)
  select p_tenant_id, c.label, c.ord, v_actor
  from (values
    ('Grains and staples', 10),
    ('Proteins',           20),
    ('Vegetables',         30),
    ('Groceries',          40),
    ('Drinks',             50),
    ('Toiletries',         60),
    ('Cleaning',           70),
    ('Kitchen supplies',   80)
  ) as c(label, ord)
  -- No conflict TARGET: the uniqueness is a partial index on lower(name), which
  -- an ON CONFLICT target cannot name. The bare DO NOTHING catches any conflict.
  on conflict do nothing;
end;
$$;

comment on function seed_tenant_inventory_reference(uuid, uuid) is
  'Seeds a tenant''s units of measure and starting item categories. Units are '
  'NOT optional — inventory_items.base_unit is NOT NULL and FK-bound, so an '
  'unseeded tenant could not create a single item. Idempotent; SECURITY DEFINER '
  'so it writes past the admin-only insert policies, with a pinned search_path.';

create or replace function seed_tenant_inventory_reference_trigger()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  -- new.created_by is the person who created the tenant; auth.uid() inside the
  -- function resolves to the same caller in the normal path.
  perform seed_tenant_inventory_reference(new.id, new.created_by);
  return new;
end;
$$;

drop trigger if exists seed_inventory_reference_after_insert on tenants;
create trigger seed_inventory_reference_after_insert
  after insert on tenants
  for each row execute function seed_tenant_inventory_reference_trigger();

-- ----------------------------------------------------------------------------
-- 5.2 Property defaults — the four locations a hotel starts with
-- ----------------------------------------------------------------------------
-- WHICH LOCATIONS A PROPERTY HAS IS DATA, NOT CODE. These four are a starting
-- point, not a fixture: rename them, add a second bar, remove housekeeping. A
-- standalone restaurant keeps Main Store + Kitchen + Bar and simply removes (or
-- ignores) Housekeeping. NOTHING in this module may assume a location exists or
-- assume there is exactly one of a kind.
create or replace function create_default_locations(
  p_property_id uuid,
  p_tenant_id   uuid,
  p_actor       uuid default null
)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_actor uuid := coalesce(auth.uid(), p_actor);
begin
  insert into locations
    (tenant_id, property_id, name, kind, display_order, created_by)
  select p_tenant_id, p_property_id, l.label, l.kind, l.ord, v_actor
  from (values
    ('Main Store',   'store',        10),
    ('Kitchen',      'kitchen',      20),
    ('Bar',          'bar',          30),
    ('Housekeeping', 'housekeeping', 40)
  ) as l(label, kind, ord)
  -- Bare DO NOTHING: uniqueness is a partial index on lower(name), which cannot
  -- be named as a conflict target. Re-running is therefore a no-op.
  on conflict do nothing;
end;
$$;

comment on function create_default_locations(uuid, uuid, uuid) is
  'Seeds a new property with Main Store / Kitchen / Bar / Housekeeping. A '
  'STARTING POINT, not a fixture — every one is renameable and removable, and a '
  'property may add a second bar. No code anywhere may assume a location exists '
  'or that there is exactly one of a kind. Idempotent; SECURITY DEFINER.';

create or replace function create_default_locations_trigger()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  perform create_default_locations(new.id, new.tenant_id, new.created_by);
  return new;
end;
$$;

drop trigger if exists create_default_locations_after_insert on properties;
create trigger create_default_locations_after_insert
  after insert on properties
  for each row execute function create_default_locations_trigger();

-- ----------------------------------------------------------------------------
-- 5.3 Backfill — tenants and properties that ALREADY exist
-- ----------------------------------------------------------------------------
-- A trigger only fires on future inserts, so without this the first tenant
-- (Heledon, provisioned long before this migration) would open the module to an
-- empty units picker and no locations — exactly the dead end 5.1 exists to
-- prevent. Same two-step reasoning as 007's enabled_modules backfill.
-- Both calls are idempotent, so re-running this migration changes nothing.
do $$
declare
  r record;
begin
  for r in select id from tenants loop
    perform seed_tenant_inventory_reference(r.id, null);
  end loop;

  -- Only properties with NO live location at all: a property whose owner has
  -- already set up (or deliberately removed) locations must not have the
  -- defaults pushed back at it.
  for r in
    select p.id, p.tenant_id
    from properties p
    where not exists (
      select 1 from locations l
      where l.property_id = p.id and l.deleted_at is null
    )
  loop
    perform create_default_locations(r.id, r.tenant_id, null);
  end loop;
end $$;


-- ############################################################################
-- SECTION 6 — Row-Level Security
-- ############################################################################
-- The 001/002/016 pattern on all four tables: member READ scoped by
-- get_tenant_ids(), admin WRITE gated by is_tenant_admin(tenant_id).
--
-- READ IS MEMBER-WIDE, NOT ADMIN-ONLY, on purpose: a storekeeper who cannot read
-- the catalogue cannot record a receipt, and a waiter's till needs to resolve an
-- item. WRITE is admin-only because the catalogue is configuration — a
-- mis-defined base unit silently rescales every movement and every recipe that
-- ever references the item.
--
-- Locations are described in the brief as "property admin". There is no
-- property-level admin predicate in this schema (001 ships is_tenant_admin only,
-- and roles are tenant-level), so writes gate on is_tenant_admin(tenant_id) —
-- the same gate room_types uses for property-scoped configuration. The property
-- SCOPE is still enforced: the composite FK ties the location to a property of
-- that tenant, and every application read additionally filters property_id
-- (rule 19).
--
-- NO DELETE POLICY ON ANY OF THE FOUR — by design, and it is the mechanism
-- behind the brief's "don't hard-delete" guard. Removal is a soft delete
-- (setting deleted_at through the update policy), so there is no code path,
-- application or manual, that can hard-delete an item or a location.
--
-- NO PUBLIC POLICY ON ANY OF THE FOUR — by design. What a hotel stocks, what it
-- pays attention to, and how its stores are laid out are operational data of no
-- use to a marketing visitor. With RLS enabled and no anon policy, an anon
-- SELECT returns zero rows: fail-closed.
alter table units_of_measure      enable row level security;
alter table inventory_categories  enable row level security;
alter table inventory_items       enable row level security;
alter table locations             enable row level security;

-- --- units_of_measure -------------------------------------------------------
drop policy if exists units_of_measure_member_select on units_of_measure;
create policy units_of_measure_member_select on units_of_measure
  for select to authenticated
  using (tenant_id = any(get_tenant_ids()));

drop policy if exists units_of_measure_member_insert on units_of_measure;
create policy units_of_measure_member_insert on units_of_measure
  for insert to authenticated
  with check (is_tenant_admin(tenant_id));

drop policy if exists units_of_measure_member_update on units_of_measure;
create policy units_of_measure_member_update on units_of_measure
  for update to authenticated
  using (is_tenant_admin(tenant_id))
  with check (is_tenant_admin(tenant_id));

-- NO delete policy — a unit code in use by an item must never vanish.
drop policy if exists units_of_measure_member_delete on units_of_measure;

-- --- inventory_categories ---------------------------------------------------
drop policy if exists inventory_categories_member_select on inventory_categories;
create policy inventory_categories_member_select on inventory_categories
  for select to authenticated
  using (tenant_id = any(get_tenant_ids()));

drop policy if exists inventory_categories_member_insert on inventory_categories;
create policy inventory_categories_member_insert on inventory_categories
  for insert to authenticated
  with check (is_tenant_admin(tenant_id));

drop policy if exists inventory_categories_member_update on inventory_categories;
create policy inventory_categories_member_update on inventory_categories
  for update to authenticated
  using (is_tenant_admin(tenant_id))
  with check (is_tenant_admin(tenant_id));

drop policy if exists inventory_categories_member_delete on inventory_categories;

-- --- inventory_items --------------------------------------------------------
drop policy if exists inventory_items_member_select on inventory_items;
create policy inventory_items_member_select on inventory_items
  for select to authenticated
  using (tenant_id = any(get_tenant_ids()));

drop policy if exists inventory_items_member_insert on inventory_items;
create policy inventory_items_member_insert on inventory_items
  for insert to authenticated
  with check (is_tenant_admin(tenant_id));

drop policy if exists inventory_items_member_update on inventory_items;
create policy inventory_items_member_update on inventory_items
  for update to authenticated
  using (is_tenant_admin(tenant_id))
  with check (is_tenant_admin(tenant_id));

-- NO delete policy — items are SOFT-DELETED only. An item will later carry
-- movement history, recipe lines and stock rows; a hard DELETE would take that
-- history with it and silently rewrite past variance reports.
drop policy if exists inventory_items_member_delete on inventory_items;

-- --- locations --------------------------------------------------------------
drop policy if exists locations_member_select on locations;
create policy locations_member_select on locations
  for select to authenticated
  using (tenant_id = any(get_tenant_ids()));

drop policy if exists locations_member_insert on locations;
create policy locations_member_insert on locations
  for insert to authenticated
  with check (is_tenant_admin(tenant_id));

drop policy if exists locations_member_update on locations;
create policy locations_member_update on locations
  for update to authenticated
  using (is_tenant_admin(tenant_id))
  with check (is_tenant_admin(tenant_id));

-- NO delete policy — locations are SOFT-DELETED only, for the same reason.
drop policy if exists locations_member_delete on locations;


-- ############################################################################
-- SECTION 7 — Removal guards that belong to LATER parts
-- ############################################################################
-- COMMENT ONLY, ENFORCED IN PART 2/3 — the tables these rules read do not exist
-- yet, so writing the check now would reference nothing. Recording them here so
-- the requirement is not rediscovered later:
--
--   * A LOCATION HOLDING STOCK MAY NOT BE REMOVED. Once stock rows exist, the
--     soft-delete path must first assert the location's on-hand quantity is zero
--     across every item (or require the stock be transferred out first).
--     Removing a location that still holds stock would strand that stock: it
--     stays in the movement ledger and in the valuation, but no screen lists it
--     and no count can ever reconcile it.
--
--   * AN ITEM USED BY A RECIPE — or holding stock, or carrying movement
--     history — MAY NOT BE REMOVED. Soft-delete must first assert no live
--     recipe line references it. A recipe pointing at a removed item computes a
--     food cost from an ingredient the system says does not exist, and the
--     theoretical-vs-actual variance (the theft report) quietly loses a line.
--
--   * Both guards belong in the RPC (or trigger) that performs the soft delete,
--     NOT in the UI — the UI check is a courtesy, the DB check is the guard
--     (rule 19). Until then, part 1 ships the structural half of the promise:
--     with no DELETE policy on either table, nothing can hard-delete a row at
--     all, so the worst reachable outcome is a soft delete that a later part can
--     tighten and, if need be, reverse.

-- ############################################################################
-- SECTION 8 — Function grants
-- ############################################################################
-- The seed functions are called by their triggers and by this migration, never
-- by a client. SECURITY DEFINER functions default to EXECUTE for PUBLIC, so
-- revoke that: a client must not be able to re-seed reference data at will.
-- (Trigger execution is unaffected — a trigger function runs as the trigger,
-- not under the caller's EXECUTE privilege.)
revoke execute on function seed_tenant_inventory_reference(uuid, uuid) from public;
revoke execute on function seed_tenant_inventory_reference(uuid, uuid) from anon;
revoke execute on function seed_tenant_inventory_reference(uuid, uuid) from authenticated;

revoke execute on function create_default_locations(uuid, uuid, uuid) from public;
revoke execute on function create_default_locations(uuid, uuid, uuid) from anon;
revoke execute on function create_default_locations(uuid, uuid, uuid) from authenticated;

-- ============================================================================
-- End of 035_inventory_catalogue.sql
-- ============================================================================
