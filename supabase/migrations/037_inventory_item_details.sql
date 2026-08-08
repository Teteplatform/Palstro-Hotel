-- ============================================================================
-- 037_inventory_item_details.sql
-- Palstro-Hotels: the rest of the STANDARD INVENTORY ITEM FIELD SET, plus the
-- per-property DESIGNATED RECEIVING STORE.
--
-- Small by design. The stock engine is untouched: no new movement type, no
-- change to the weighted-average fold (036 §2), no new write path, no cache
-- column. Everything added here is either DESCRIPTIVE (what the thing is, how it
-- is packed, what it usually costs to buy) or a THRESHOLD a later report will
-- read. Nothing in this file participates in valuation.
--
-- ----------------------------------------------------------------------------
-- WHAT IS DELIBERATELY NOT HERE
-- ----------------------------------------------------------------------------
--   * SUPPLIER. An item's supplier is not one column — a hotel buys rice from
--     three people at three prices, and the useful fact is "who did we last buy
--     this from, at what price, on which order". That is the purchasing tranche
--     (2c) and it is a table, not a text field. A `supplier text` added now
--     would be filled in, trusted, and then contradicted by the first purchase
--     order that named somebody else.
--   * SELLING_PRICE. A price belongs to a MENU LINE, not to a stock item: the
--     same 50cl Coke sells at one price over the bar and another in the
--     restaurant, and a bottle poured into a cocktail is not sold at all. The
--     menu tranche owns it. Putting a single price on the item here would force
--     exactly the one-price-per-thing model the F&B module exists to avoid.
--
-- ----------------------------------------------------------------------------
-- CONVENTIONS INHERITED — all load-bearing
-- ----------------------------------------------------------------------------
--   * Money numeric(14,2), quantities numeric(14,4) (§6). Both arrive over
--     PostgREST as STRINGS; parse with parseNumeric before any arithmetic.
--   * Every new column is NULLABLE with no default beyond NULL, except the
--     boolean flag below. A hotel that never fills one in is not carrying a
--     defaulted lie — NULL means "not stated", which is what an unfilled field
--     honestly is, and it renders as the shared MISSING_VALUE dash.
--   * No RLS work: 035's member-read / admin-write policies are per TABLE, so a
--     new column inherits them. No new table, so no new policy.
--   * log_field_changes() already covers both tables, so "who set this item's
--     purchase cost" and "who moved the default store" are answerable from day
--     one without touching a trigger.
-- ============================================================================


-- ############################################################################
-- SECTION 1 — inventory_items: the standard field set
-- ############################################################################

alter table inventory_items
  -- The scanned code on the packaging. SEPARATE FROM `code` and not a rename of
  -- it: `code` is the hotel's OWN short reference, written on a bin card by a
  -- storekeeper; a barcode is the manufacturer's, and the two are different
  -- lengths, different alphabets and different owners. A hotel routinely has one
  -- without the other.
  add column if not exists barcode text,

  -- HOW IT IS PACKED, as a sentence: 'carton of 24', 'bale of 10 packs',
  -- '25 kg bag'.
  --
  -- TEXT, NOT NUMERIC, and this is the one type decision in this file worth
  -- arguing. A numeric pack_size would be read — by a person, and sooner or
  -- later by code — as a CONVERSION FACTOR: "24" beside a base unit of 'piece'
  -- says a purchase of 5 is really 120. 035 is explicit that this module has NO
  -- purchase-unit conversion factor by design ("everything is entered in the
  -- base unit, so there is no factor to get wrong"), and a numeric column here
  -- would quietly reintroduce one that nothing multiplies by — so the first
  -- report to trust it would be wrong by a factor of the pack size. Text cannot
  -- be multiplied by accident. If real pack-to-base conversion is ever wanted it
  -- is a purchase-unit table with its own factor and its own validation, not
  -- this column.
  add column if not exists pack_size text,

  -- THE STANDARD BUY COST of one BASE unit — what this normally costs to
  -- purchase. Informational ONLY: valuation is the moving average folded from
  -- the movements (036 §2), and nothing reads this column to value anything. It
  -- is here so a purchase order can be pre-filled and a delivery priced wildly
  -- differently can be spotted, both of which are 2c.
  add column if not exists purchase_cost numeric(14,2),

  -- THE PAR RANGE, in the item's base unit. min = the floor a store should not
  -- fall below, max = the ceiling worth holding (money tied up in stock, and for
  -- a perishable, stock that will spoil before it is used).
  --
  -- HOW THESE RELATE TO reorder_level, stated plainly because three numbers that
  -- all sound like "not much left" is exactly how a field gets filled in wrongly:
  --   reorder_level     is THE ALERT. stock_on_hand_items.is_below_reorder (036
  --                     §3.2) compares on-hand against it, and the low-stock
  --                     filter and the summary tile both key off that flag. It is
  --                     the only one of the three the system acts on today.
  --   min_stock_level   is the ORDERING FLOOR — how much you want to still have
  --                     when the delivery arrives.
  --   max_stock_level   is the ORDERING CEILING — how far up to top the order.
  -- Purchasing (2c) will suggest an order quantity of (max - on hand) when the
  -- alert fires. Until it ships, min/max are captured and shown and do nothing
  -- else, and the form says so rather than implying an alert that does not exist.
  add column if not exists min_stock_level numeric(14,4),
  add column if not exists max_stock_level numeric(14,4);

comment on column inventory_items.barcode is
  'The manufacturer''s scanned code. Separate from `code`, which is the hotel''s '
  'own short reference — different owners, different alphabets, and a hotel '
  'routinely has one without the other. Unique per tenant where set.';
comment on column inventory_items.pack_size is
  'How the item is packed, as a sentence (''carton of 24''). TEXT ON PURPOSE: a '
  'numeric here would be read as a purchase-to-base CONVERSION FACTOR, which 035 '
  'deliberately does not have — everything is entered in the base unit. Text '
  'cannot be multiplied by accident.';
comment on column inventory_items.purchase_cost is
  'The standard buy cost of ONE BASE UNIT, numeric(14,2) (§6). INFORMATIONAL '
  'ONLY — valuation is the moving average folded from the movements (036 §2) and '
  'nothing reads this to value anything. Here so purchasing (2c) can pre-fill an '
  'order and flag a delivery priced far from it.';
comment on column inventory_items.min_stock_level is
  'The ordering FLOOR in the base unit — how much you still want on the shelf '
  'when a delivery lands. NOT the alert: the low-stock flag compares against '
  'reorder_level (036 §3.2). Read by purchasing (2c).';
comment on column inventory_items.max_stock_level is
  'The ordering CEILING in the base unit — how far up to top an order. Read by '
  'purchasing (2c) to suggest (max - on hand). NULL means no ceiling.';

-- ----------------------------------------------------------------------------
-- 1.1 Value constraints
-- ----------------------------------------------------------------------------
-- Added separately from the columns so each carries its own name in the error a
-- user would see, and so re-running this migration is a plain no-op.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'inventory_items_purchase_cost_check'
  ) then
    alter table inventory_items
      add constraint inventory_items_purchase_cost_check
      check (purchase_cost is null or purchase_cost >= 0);
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'inventory_items_min_stock_check'
  ) then
    alter table inventory_items
      add constraint inventory_items_min_stock_check
      check (min_stock_level is null or min_stock_level >= 0);
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'inventory_items_max_stock_check'
  ) then
    alter table inventory_items
      add constraint inventory_items_max_stock_check
      check (max_stock_level is null or max_stock_level >= 0);
  end if;

  -- A ceiling below its floor is not a range, it is a typo — and a purchasing
  -- suggestion computed from it would be negative. Only enforced when BOTH are
  -- set, so either alone is still allowed (a floor with no ceiling is a normal,
  -- meaningful setting).
  if not exists (
    select 1 from pg_constraint where conname = 'inventory_items_min_max_order_check'
  ) then
    alter table inventory_items
      add constraint inventory_items_min_max_order_check
      check (
        min_stock_level is null
        or max_stock_level is null
        or max_stock_level >= min_stock_level
      );
  end if;

  -- An empty-string barcode is not a barcode. Without this, two items each
  -- carrying '' would collide on the unique index below and the user would be
  -- told their barcode is taken by an item that visibly has none.
  if not exists (
    select 1 from pg_constraint where conname = 'inventory_items_barcode_nonblank_check'
  ) then
    alter table inventory_items
      add constraint inventory_items_barcode_nonblank_check
      check (barcode is null or length(btrim(barcode)) > 0);
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 1.2 Barcode uniqueness
-- ----------------------------------------------------------------------------
-- Same shape as 035's code index — case-insensitive, LIVE rows only, and only
-- where one is SET (a nullable column with many NULLs must not collide with
-- itself). A barcode exists to resolve a scan to exactly one item; two items
-- sharing one makes every future scan ambiguous, and the resolution would be
-- whichever row the query happened to return first.
create unique index if not exists inventory_items_tenant_barcode_live_uniq
  on inventory_items (tenant_id, lower(barcode))
  where barcode is not null and deleted_at is null;


-- ############################################################################
-- SECTION 2 — locations: the designated receiving store
-- ############################################################################
-- WHY THIS FLAG EXISTS. Stock is received INTO a store and issued OUT of it
-- (035 §4: that is what kind='store' MEANS), so every screen that receives stock
-- — the opening-stock import today, purchase receipts tomorrow — has to default
-- its location to a store rather than to whatever happens to be first in the
-- list. Without a flag the best available rule is "the first location of kind
-- store", which is an ORDERING accident: a hotel with a Dry Store and a Main
-- Store gets whichever they happened to name first, and reordering the list for
-- unrelated reasons silently moves where deliveries land.
--
-- THE RESOLUTION ORDER, defined once here and implemented once in the client
-- (pickDefaultLocation, src/lib/inventory.ts):
--   1. the live, active location with is_default_store = true, if there is one;
--   2. else the first live, ACTIVE kind='store' by display_order then name;
--   3. else the first live location at all;
--   4. else nothing, and the screen asks.
-- Steps 2-4 are what a property that has never touched the flag gets, so the
-- flag is an override of a sensible rule rather than a prerequisite for one.
alter table locations
  add column if not exists is_default_store boolean not null default false;

comment on column locations.is_default_store is
  'The property''s designated RECEIVING point — where stock arrives by default '
  '(the opening-stock import today, purchase receipts in 2c). At most one per '
  'property, and only ever a kind=''store'' location. An OVERRIDE of the fallback '
  'rule (first active store, then first location), not a prerequisite for it.';

-- Only a store can be the default receiving store. Enforced as a constraint for
-- the guarantee and NORMALISED by the trigger below so a user changing a
-- location''s kind never actually meets it.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'locations_default_store_kind_check'
  ) then
    alter table locations
      add constraint locations_default_store_kind_check
      check (is_default_store = false or kind = 'store');
  end if;
end $$;

-- AT MOST ONE PER PROPERTY, structurally. The trigger below clears the previous
-- default so a user never has to; this index is what holds when two admins set a
-- different default in the same moment, where both transactions read a state in
-- which the other's write had not happened.
create unique index if not exists locations_one_default_store_uniq
  on locations (property_id)
  where is_default_store and deleted_at is null;

-- ----------------------------------------------------------------------------
-- 2.1 "Setting a default clears the previous one"
-- ----------------------------------------------------------------------------
-- Written as a trigger rather than as two client writes on purpose. Two writes
-- are not one transaction: a clear that succeeds and a set that fails leaves the
-- property with NO default, and the reverse leaves it failing the unique index
-- with an error about a constraint the user never heard of. One statement, one
-- transaction, one outcome.
--
-- NOT INFINITELY RECURSIVE, and it is worth saying why rather than trusting it:
-- the inner UPDATE sets is_default_store = FALSE, so when this trigger fires for
-- those rows the `if new.is_default_store` test is false and it returns
-- immediately. The recursion is exactly one level deep.
create or replace function enforce_single_default_store()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Normalise first: a location that is not a store cannot be the receiving
  -- store. Silently corrected rather than rejected — somebody converting their
  -- old Main Store into a Bar means the kind change, not a constraint lecture.
  if new.kind <> 'store' then
    new.is_default_store := false;
  end if;

  -- A removed location is nobody's receiving point.
  if new.deleted_at is not null then
    new.is_default_store := false;
  end if;

  if new.is_default_store then
    update locations
       set is_default_store = false
     where property_id = new.property_id
       and id <> new.id
       and is_default_store;
  end if;

  return new;
end;
$$;

comment on function enforce_single_default_store() is
  'Keeps at most one designated receiving store per property, and keeps the flag '
  'off anything that is not a live store. Done in ONE statement rather than as a '
  'clear-then-set pair in the client, because two client writes are not one '
  'transaction and a half-applied pair leaves the property with no default or '
  'with a unique-index violation. Recursion is one level deep by construction: '
  'the inner update sets the flag FALSE, which short-circuits this branch.';

drop trigger if exists enforce_single_default_store_trigger on locations;
create trigger enforce_single_default_store_trigger
  before insert or update on locations
  for each row execute function enforce_single_default_store();

revoke execute on function enforce_single_default_store() from public;
revoke execute on function enforce_single_default_store() from anon;
revoke execute on function enforce_single_default_store() from authenticated;

-- ----------------------------------------------------------------------------
-- 2.2 Backfill — every existing property gets its default named
-- ----------------------------------------------------------------------------
-- A trigger only fires on future writes, so without this every property built
-- before today falls to the fallback rule forever, and the flag would look
-- broken to the first person who opened the locations panel expecting to see
-- which store is the default. Marks the SAME location the fallback would have
-- picked (first active store by display_order then name), so this changes no
-- behaviour — it only writes the choice down where it can then be changed.
--
-- Idempotent: properties that already have a default are skipped entirely.
do $$
declare
  r record;
begin
  for r in
    select p.id as property_id
    from properties p
    where not exists (
      select 1 from locations l
      where l.property_id = p.id
        and l.is_default_store
        and l.deleted_at is null
    )
  loop
    update locations
       set is_default_store = true
     where id = (
       select l.id
       from locations l
       where l.property_id = r.property_id
         and l.kind = 'store'
         and l.is_active
         and l.deleted_at is null
       order by l.display_order, l.name, l.created_at
       limit 1
     );
  end loop;
end $$;

-- ============================================================================
-- End of 037_inventory_item_details.sql
-- ============================================================================
