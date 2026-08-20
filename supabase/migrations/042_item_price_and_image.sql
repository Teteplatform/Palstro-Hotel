-- ============================================================================
-- 042_item_price_and_image.sql
-- Palstro-Hotels: the item record completed — a SELLING PRICE on the item, and
-- ONE PICTURE per item, tenant-level, through the media path that already exists.
--
-- ----------------------------------------------------------------------------
-- THIS FILE REVERSES A DECISION 037 MADE IN WRITING, SO IT SAYS SO
-- ----------------------------------------------------------------------------
-- 037's header lists SELLING_PRICE under "what is deliberately not here", with
-- this reasoning: "A price belongs to a MENU LINE, not to a stock item: the same
-- 50cl Coke sells at one price over the bar and another in the restaurant."
--
-- The reasoning was right about the FACT and wrong about the CONCLUSION, and
-- CLAUDE.md §9 now records the settled version: "The item owns its selling
-- price. Blank means not sold, which is not the same as zero. Where an outlet
-- price exists it overrides the item price at the point of sale."
--
-- The difference matters. 037 read "two outlets charge differently" as "the item
-- cannot have a price", which leaves a hotel unable to answer "what is a crate
-- of Coke worth on the shelf?" until an entire menu module exists — and leaves
-- every outlet that charges the ordinary price with nothing to inherit, so the
-- same number is typed once per outlet and drifts. A DEFAULT on the item with an
-- OVERRIDE at the outlet (1.1g) carries both facts: one price to maintain, and a
-- different one wherever a hotel genuinely charges differently.
--
-- WHAT THIS FILE DOES NOT DO, so 1.1g has nowhere to disagree with it:
--   * no outlet price, no menu, no second price column anywhere;
--   * nothing reads default_selling_price to VALUE stock. Valuation is the
--     moving average, always (§9, 036 §2). purchase_cost still values nothing
--     and neither does this;
--   * no cache column (rule 6). Retail value is computed on read, in the view,
--     from the same fold every other stock figure comes from.
--
-- ----------------------------------------------------------------------------
-- THE PRICE IS PRE-TAX, AND THAT IS A FACT ABOUT THE FOLIO ENGINE
-- ----------------------------------------------------------------------------
-- 021 stores a charge's own money as net_amount and adds tax ON TOP of it:
-- folio_totals computes `sum(round(fc.net_amount * tc.rate, 2))` over the
-- property's live tax_charges. So a price recorded here is a NET price, and it
-- stays net regardless of what a property does with its taxes.
--
-- That last clause is load-bearing, because a property CAN switch VAT off:
-- tax_charges.is_compulsory is an ordinary boolean with no CHECK pinning it, and
-- guard_compulsory_tax_charge() only refuses delete/deactivation WHILE the flag
-- is true — clear the flag (an UPDATE log_field_changes records against a named
-- user) and VAT can be deactivated. Had we treated the price as tax-INCLUSIVE,
-- margin would have been overstated by the VAT rate at every property charging
-- it and by a DIFFERENT amount at one that had turned it off, and no query would
-- have errored. Net prices make the comparison to cost valid everywhere.
--
-- ----------------------------------------------------------------------------
-- CONVENTIONS INHERITED — all load-bearing
-- ----------------------------------------------------------------------------
--   * Money numeric(14,2) (§6), arriving over PostgREST as a STRING and parsed
--     at the boundary (rule 24) — never in a component.
--   * Nullable with no default. NULL means NOT SOLD, which is a real fact about
--     an item and not a missing value; the check below forbids 0 outright so it
--     can never come to mean the same thing.
--   * Errors belong to the database (rule 21): every refusal here carries a
--     MESSAGE stating the rule and a HINT stating the way out, and the client
--     renders both verbatim.
--   * No new RLS: both tables already have per-TABLE policies, and a new column
--     inherits them. media_assets gains no policy either — see §2.4.
--   * log_field_changes() already covers inventory_items, so "who priced this
--     item, and at what" is answerable from the day the column exists.
-- ============================================================================


-- ############################################################################
-- SECTION 1 — inventory_items.default_selling_price
-- ############################################################################

alter table inventory_items
  -- What one BASE UNIT of this item sells for, before tax, when no outlet says
  -- otherwise. numeric(14,2) per §6.
  --
  -- NULL MEANS NOT SOLD. It is not "unknown" and it is not zero — it is the
  -- statement that this thing is not on sale, which is the truth about every
  -- ingredient in the store. The check below makes that meaning stable by
  -- refusing 0, so nobody can express "not sold" two different ways and have
  -- half the reports agree with each.
  add column if not exists default_selling_price numeric(14,2);

comment on column inventory_items.default_selling_price is
  'What one base unit sells for, BEFORE TAX, when no outlet price overrides it '
  '(outlet overrides arrive in 1.1g and READ this). NULL means NOT SOLD — not '
  'unknown, and not zero: 0 is refused by inventory_items_selling_price_check so '
  '"not sold" has exactly one representation. Pre-tax because 021 adds tax on top '
  'of a charge''s net_amount, which holds even at a property that has switched '
  'VAT off. Never used to VALUE stock — valuation is the moving average (036 §2).';


-- ----------------------------------------------------------------------------
-- 1.1 The two halves of the rule, enforced in two DIFFERENT places
-- ----------------------------------------------------------------------------
-- The rule has a safe half and an unsafe half, and they cannot both be a CHECK.
--
--   SAFE     an Ingredient must have NO price. Every existing row has NULL in a
--            column that did not exist a moment ago, so this validates trivially
--            and can be a CHECK — the strongest thing available.
--
--   UNSAFE   a Sold as-is / Both item must HAVE one. `alter table add constraint`
--            VALIDATES EXISTING ROWS, and this property already has sellable
--            items priced at nothing. The migration would simply fail, and the
--            only ways past that are to invent a price (a fabricated figure on an
--            owner's margin report) or to set every sellable item to Ingredient
--            (a lie about what the hotel sells). Neither is honest, so the half
--            that cannot be a constraint becomes a WRITE-PATH guard: §1.2.

alter table inventory_items
  drop constraint if exists inventory_items_selling_price_check;
alter table inventory_items
  add constraint inventory_items_selling_price_check
    check (default_selling_price is null or default_selling_price > 0);

comment on constraint inventory_items_selling_price_check on inventory_items is
  'A price, if given, is greater than zero. Refuses 0 specifically so it can '
  'never become a second spelling of "not sold" (which is NULL) — a zero price '
  'divides into a margin percentage of infinity and reads on a report as an item '
  'given away. Something genuinely free is a complimentary CHARGE on a folio '
  '(021''s discount path), not an item priced at nothing.';

alter table inventory_items
  drop constraint if exists inventory_items_raw_has_no_price_check;
alter table inventory_items
  add constraint inventory_items_raw_has_no_price_check
    check (item_type <> 'raw' or default_selling_price is null);

comment on constraint inventory_items_raw_has_no_price_check on inventory_items is
  'An Ingredient (raw) item carries NO selling price. It is consumed only through '
  'a recipe and has nowhere to be sold from (035 §3), so a price on one is a '
  'number no sale could ever charge — it would sit in the retail total on the '
  'stock screen inflating the shelf''s worth by stock that is not for sale.';


-- ----------------------------------------------------------------------------
-- 1.2 The write-path guard: a sellable item must be priced
-- ----------------------------------------------------------------------------
-- A TRIGGER, NOT CLIENT CODE, and that distinction is the whole reason this is
-- here rather than in lib/inventory.ts. Rule 21: a refusal is raised where the
-- rule lives, the message carries the rule, the hint carries the way out, and the
-- client authors neither. A guard written in TypeScript would be a second source
-- of truth that drifts the first time the rule changes — silently, because
-- nothing errors when a client forgets a check.
--
-- WHEN IT FIRES, which is the part that makes the gap closeable:
--   INSERT  always. No new sellable item may be created without a price.
--   UPDATE  ONLY when item_type or default_selling_price actually changed.
--
-- That second line is deliberate and it is not laziness. The rows this cannot
-- validate — existing sellable items with no price — must stay EDITABLE, or
-- fixing one of them means first satisfying a rule about a different field, and
-- correcting a typo in an item's name becomes impossible until somebody invents
-- a price for it. So an unrelated edit passes, and the three writes that could
-- create or restore the gap are all refused:
--   * creating a sellable item with no price,
--   * retyping an Ingredient as sellable while it has no price,
--   * clearing the price of an item that is sellable.
-- What remains visible instead of enforced is the pre-existing gap, and 1.1e
-- gives the item list a filter that shows exactly those rows (§1 of the brief) —
-- the rule is achieved by making the gap findable, not by pretending it is not
-- there.
create or replace function enforce_sellable_has_price()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- An UPDATE that touches neither the type nor the price is none of this
  -- function's business.
  --
  -- TWO NESTED IFS, NOT ONE `tg_op = 'UPDATE' and new.x = old.x`. PL/pgSQL hands
  -- a condition to the SQL executor, and SQL's AND is NOT guaranteed to
  -- short-circuit — so a single combined condition may evaluate `old.item_type`
  -- during an INSERT, where OLD is unassigned, and raise "record old is not
  -- assigned yet" on every item ever created. The tg_op test has to be its own
  -- statement for the OLD reference to be unreachable rather than merely unlikely.
  if tg_op = 'UPDATE' then
    -- `is distinct from` rather than <> for the price, so a NULL on either side
    -- compares correctly — with <>, clearing a price (500 -> NULL) evaluates to
    -- NULL, the branch is not taken, and the one write this guard most needs to
    -- catch sails through.
    if new.item_type = old.item_type
       and new.default_selling_price is not distinct from old.default_selling_price
    then
      return new;
    end if;
  end if;

  if new.item_type in ('finished', 'both')
     and new.default_selling_price is null
  then
    raise exception
      'A % item must have a selling price. "%" is sold, so the price it sells for is part of what it is.',
      case new.item_type when 'finished' then 'Sold as-is' else 'Both' end,
      new.name
      using
        errcode = 'check_violation',
        hint =
          'Enter what one ' || new.base_unit || ' sells for, before tax. '
          'If this item is not sold on its own, set its type to Ingredient instead.';
  end if;

  return new;
end;
$$;

comment on function enforce_sellable_has_price() is
  'Refuses a Sold as-is / Both item with no default_selling_price. A TRIGGER and '
  'not a CHECK because `add constraint` validates existing rows and this property '
  'already has unpriced sellable items — and there is no honest price to invent '
  'for them (see §1.1). Fires on every INSERT, and on an UPDATE only when '
  'item_type or default_selling_price actually changed, so a pre-existing unpriced '
  'row stays editable and the gap can be closed rather than merely blocked. '
  'Carries a message (the rule) and a hint (the way out) per rule 21.';

drop trigger if exists enforce_sellable_has_price_inventory_items on inventory_items;
create trigger enforce_sellable_has_price_inventory_items
  before insert or update on inventory_items
  for each row execute function enforce_sellable_has_price();


-- ----------------------------------------------------------------------------
-- 1.3 The index behind the "sellable, no price" filter
-- ----------------------------------------------------------------------------
-- The gap is only closeable if it is findable, so the filter that finds it gets
-- an index rather than a sequential scan of the catalogue. Partial on exactly the
-- predicate the filter uses, so it is small — it holds only the rows that are
-- wrong, which is a set a hotel is actively trying to empty.
create index if not exists inventory_items_sellable_unpriced_idx
  on inventory_items (tenant_id, name)
  where default_selling_price is null
    and item_type in ('finished', 'both')
    and deleted_at is null;

comment on index inventory_items_sellable_unpriced_idx is
  'Backs the item list''s "sellable, no price" filter — the surface that makes the '
  'half of the price rule a CHECK cannot enforce (§1.1) visible and closeable. '
  'Partial on the defect itself, so it indexes only rows somebody needs to fix.';


-- ############################################################################
-- SECTION 2 — the item picture: media_assets goes tenant-level
-- ############################################################################
-- ONE ATTACHMENT MECHANISM, NOT TWO. Every byte the product stores already goes
-- through the same path: client-side resize to three WebP variants
-- (imageProcessing.ts), one media_assets row per variant, a per-tenant byte quota
-- enforced by a trigger (005 §6), and delete-together semantics (§6's storage
-- note). Growing a second mechanism for item photos would mean a second quota
-- that does not know about the first, a second orphan story, and a second place
-- for the file-and-row lockstep to be got wrong. So the item picture reuses all
-- of it, and this section only makes media_assets able to hold something that
-- belongs to a TENANT rather than to a property.
--
-- WHY TENANT-LEVEL AT ALL: the catalogue is tenant-level by design (035's
-- header — define "Rice" once and every property uses it). A picture of Rice is a
-- picture of the same Rice in Bonny and in Lagos. Filing it under a property
-- would mean the second property either sees no picture or uploads its own copy
-- of the identical bottle, which is two rows of quota for one photograph and two
-- things to keep in step.

-- ----------------------------------------------------------------------------
-- 2.1 property_id becomes nullable — and tenant_id gets its own FK
-- ----------------------------------------------------------------------------
-- THE TRAP, stated before the DDL because it is invisible afterwards. 005 binds
-- media_assets with a COMPOSITE foreign key:
--
--     foreign key (property_id, tenant_id) references properties (id, tenant_id)
--
-- and a composite FK defaults to MATCH SIMPLE, which is satisfied WITHOUT ANY
-- CHECK AT ALL when any of its columns is NULL. So the moment property_id can be
-- NULL, a tenant-level row's tenant_id is referencing nothing — the guard that
-- makes a media row structurally unable to name a tenant that does not exist
-- would quietly stop applying to exactly the rows this migration adds.
--
-- The composite FK is therefore KEPT (it still binds every property-level row) and
-- a plain FK on tenant_id is added BESIDE it, so both shapes are covered:
--   property-level row → both FKs apply, and the pair must agree,
--   tenant-level row   → the composite is skipped, the tenant FK still holds.
alter table media_assets
  alter column property_id drop not null;

alter table media_assets
  drop constraint if exists media_assets_tenant_fk;
alter table media_assets
  add constraint media_assets_tenant_fk
    foreign key (tenant_id) references tenants (id) on delete cascade;

comment on constraint media_assets_tenant_fk on media_assets is
  'Binds tenant_id on its OWN, because the composite (property_id, tenant_id) FK '
  'is MATCH SIMPLE and is skipped entirely when property_id is NULL — so without '
  'this, a tenant-level media row could name a tenant that does not exist and '
  'nothing would say so. Both constraints coexist: the composite governs '
  'property-level rows, this one governs every row.';

comment on column media_assets.property_id is
  'The property this file belongs to, or NULL for TENANT-LEVEL media (an item '
  'picture — the catalogue is tenant-wide, 035). Which it is is not a matter of '
  'convention: media_assets_scope_check binds it to the category. NULL also keeps '
  'item images out of fetchPropertyMedia, the property gallery and OrphanCleanup, '
  'all of which filter on property_id.';


-- ----------------------------------------------------------------------------
-- 2.2 The new category, and the scope invariant that goes with it
-- ----------------------------------------------------------------------------
-- 'items' joins the fixed category list. And because property_id is now nullable
-- for one category and required for the other five, that pairing is enforced
-- rather than trusted: a hero image with no property, or an item picture filed
-- under a property, would both be rows every existing query reads WRONGLY —
-- the first vanishes from the gallery it was uploaded to, the second appears in
-- one property's gallery as a picture of a bottle of oil. One equivalence covers
-- both directions.
alter table media_assets
  drop constraint if exists media_assets_category_check;
alter table media_assets
  add constraint media_assets_category_check
    check (category in ('hero', 'gallery', 'rooms', 'logo', 'about', 'items'));

alter table media_assets
  drop constraint if exists media_assets_scope_check;
alter table media_assets
  add constraint media_assets_scope_check
    check ((category = 'items') = (property_id is null));

comment on constraint media_assets_category_check on media_assets is
  'Prevents an un-renderable category no screen queries. hero/gallery/rooms/logo/'
  'about are the guest-site categories (005); ''items'' is the tenant-level item '
  'picture added by 042.';
comment on constraint media_assets_scope_check on media_assets is
  'The scope and the category must agree, in BOTH directions: an ''items'' row is '
  'tenant-level (property_id NULL) and every other category is property-level '
  '(property_id set). Enforced rather than assumed because each mistake produces a '
  'row that existing queries read wrongly rather than reject — a property-scoped '
  'item picture would surface in that property''s gallery, and a hero image with '
  'no property would disappear from the gallery it was uploaded to.';

-- The paired-key target inventory_items binds to below (§2.3), so an item can
-- never reference a media row belonging to another tenant. Same pattern as
-- properties (id, tenant_id) and inventory_items (id, tenant_id).
--
-- ADDED IF ABSENT, NOT DROPPED AND RE-ADDED — and this one is not a style choice.
-- Every other constraint in this file uses `drop if exists` then `add`, which is
-- the codebase's idiom and is re-runnable because nothing depends on them. This key
-- is DIFFERENT: §2.3's inventory_items_image_asset_fk references it, so a second
-- run of this migration hit
--
--     2BP01: cannot drop constraint media_assets_id_tenant_unique on table
--            media_assets because other objects depend on it
--
-- The dry run caught it on the re-runnability check, which is exactly what that
-- check is for — the first application was perfectly clean, so nothing else would
-- have said so until a redeploy.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'media_assets_id_tenant_unique'
       and conrelid = 'media_assets'::regclass
  ) then
    alter table media_assets
      add constraint media_assets_id_tenant_unique unique (id, tenant_id);
  end if;
end $$;

-- The tenant-level read: "this tenant's item pictures". The existing index is
-- (tenant_id, category), which already serves it — this one adds the live-row
-- predicate so resolving a page of item thumbnails does not scan soft-deleted
-- history.
create index if not exists media_assets_tenant_live_idx
  on media_assets (tenant_id, category)
  where deleted_at is null;


-- ----------------------------------------------------------------------------
-- 2.3 inventory_items.image_asset_id
-- ----------------------------------------------------------------------------
-- ONE PICTURE PER ITEM, held as a media_asset ID and never a URL. 009 argued this
-- for branding and every word of it applies here: an id resolves to whichever
-- variant a surface needs (a list row wants 'thumb', never the 1920px 'full'), an
-- id has a byte_size the quota trigger sums, and an id is what lets a replaced
-- picture's files be found and released. A URL can do none of the three.
alter table inventory_items
  add column if not exists image_asset_id uuid;

-- COMPOSITE FK (§6 composite-key consistency), because a plain FK to
-- media_assets(id) would let tenant A's item point at tenant B's photograph —
-- and RLS could not catch it, since every policy trusts tenant_id directly and
-- both rows have a perfectly valid one of their own.
--
-- ON DELETE IS DELIBERATELY *NO ACTION*, NOT SET NULL. `on delete set null` on a
-- composite FK nulls EVERY column in it, including tenant_id, which is NOT NULL —
-- so it would not clean up after a delete, it would make the delete fail with a
-- constraint error about a column nobody touched. NO ACTION is honest about what
-- it does: a hard delete of a referenced media row is refused at end of
-- statement. Nothing in this product hard-deletes one (deleteMediaAsset soft-
-- deletes, §6), and the write path clears image_asset_id in the same act, so the
-- refusal only ever fires on a raw SQL delete that skipped the write path.
alter table inventory_items
  drop constraint if exists inventory_items_image_asset_fk;
alter table inventory_items
  add constraint inventory_items_image_asset_fk
    foreign key (image_asset_id, tenant_id)
    references media_assets (id, tenant_id);

comment on column inventory_items.image_asset_id is
  'The media_assets id of this item''s single picture, or NULL for none. An ID and '
  'never a URL (009''s reasoning): an id resolves to the variant a surface needs '
  'so a list row pulls the 400px thumb rather than the 1920px full, it carries a '
  'byte_size the quota trigger counts, and it is what lets a replaced picture''s '
  'files be released. Composite-FK bound to (id, tenant_id) so an item can never '
  'reference another tenant''s media.';

create index if not exists inventory_items_image_asset_id_idx
  on inventory_items (image_asset_id)
  where image_asset_id is not null;


-- ----------------------------------------------------------------------------
-- 2.4 What this section deliberately does NOT change
-- ----------------------------------------------------------------------------
-- NO NEW RLS POLICY, and each omission is a decision:
--
--   * media_assets writes stay admin-only (005: is_tenant_admin on insert/update/
--     delete). inventory_items writes are admin-only too (035), so exactly the
--     people who may create an item may give it a picture. Nothing to widen.
--   * media_assets_member_select already covers reading an item picture in the
--     admin: it is scoped by tenant_id = any(get_tenant_ids()), which a
--     tenant-level row satisfies on its own.
--   * media_assets_public_select (010) resolves through
--     `properties p where p.id = media_assets.property_id`, so with a NULL
--     property_id that EXISTS is false and item pictures are NOT publicly
--     readable. That is the correct default and not an oversight: nothing on the
--     guest site shows an inventory item yet. When the menu ships (1.1g) it will
--     need its own policy, and it should be written against what a menu actually
--     publishes rather than by loosening this one now for a surface that does not
--     exist.
--   * Storage RLS (005) parses the tenant_id out of the FIRST path segment and
--     passes it to is_tenant_admin(). The item-picture path keeps the tenant id
--     first — {tenant_id}/tenant/items/{size}/{filename} — so the existing
--     policies gate it unchanged. The 'tenant' literal occupies the property
--     slot, which keeps the path at the five segments variantPath() and
--     bucketPathFamily() depend on (they rewrite the SECOND-TO-LAST segment to
--     find a sibling variant, and give up below five segments).


-- ############################################################################
-- SECTION 3 — retail value, beside cost, computed in ONE place
-- ############################################################################
-- The stock screen gains "what this shelf would bring in" next to "what the books
-- say it is worth". Both figures come from the SAME view as everything else on
-- that screen, for the reason 036's header gives about the running average:
-- re-implementing an engine rule in TypeScript produces a second implementation
-- that drifts from the first the day either changes, and then the two numbers on
-- one card disagree and nothing errors.
--
-- So retail_value is `quantity_on_hand * default_selling_price`, rounded to money
-- precision ONCE, here — exactly as stock_value is `quantity * average_cost`
-- rounded once in 036 §3.1.
--
-- NULL, NEVER ZERO, FOR AN UNPRICED ITEM. This is the whole substance of the
-- brief's "a total that silently ignores half the shelf is worse than no total":
-- if an unpriced item contributed 0 to retail, the card would show a confident
-- figure that quietly omitted every ingredient in the store, and the margin
-- beside it would look catastrophic for reasons nobody could see. NULL propagates
-- through sum() by being SKIPPED, which is the correct arithmetic, and it leaves
-- the row COUNTABLE — which is how the summary can say how many items it left
-- out. A number the user can see the shape of the hole in.
--
-- A NEGATIVE ON-HAND PRODUCES A NEGATIVE RETAIL, and is not floored (rule 7,
-- same as stock_value). Minus three crates cannot be sold; showing its retail as
-- 0 would hide a discrepancy this module exists to surface.

-- ----------------------------------------------------------------------------
-- 3.1 stock_on_hand_items — the price and the retail figure appended
-- ----------------------------------------------------------------------------
-- `create or replace view` requires every existing output column to keep its
-- name, type and POSITION, with new ones appended — so the two new columns go at
-- the end and nothing above them moves. The whole body is restated because
-- `create or replace` replaces it wholesale; the only changes from 036 §3.2 are
-- the last two select-list entries.
create or replace view stock_on_hand_items
with (security_invoker = on) as
select
  soh.tenant_id,
  soh.property_id,
  soh.location_id,
  soh.inventory_item_id,
  soh.quantity_on_hand,
  soh.moving_average_cost,
  soh.stock_value,
  soh.movement_count,
  soh.last_movement_date,
  -- The catalogue columns the list shows and filters on.
  i.name          as item_name,
  i.code          as item_code,
  i.item_type,
  i.base_unit,
  i.category_id,
  i.reorder_level,
  -- THE LOW-STOCK FLAG (036 §3.2). NULL reorder_level means the item is simply
  -- not monitored, which is FALSE (not low), never NULL: a filter must not
  -- silently drop unmonitored items.
  (i.reorder_level is not null and soh.quantity_on_hand <= i.reorder_level)
                  as is_below_reorder,
  i.is_active     as item_is_active,
  c.name          as category_name,
  l.name          as location_name,
  l.kind          as location_kind,
  -- 042. The item's own price, so "which of these has no price" is answerable
  -- SERVER-SIDE against the same rows the list's count and totals describe
  -- (rules 1b/20) — a client-side scan of a fetched page would make the
  -- excluded-count on the summary card a statement about the page.
  i.default_selling_price,
  -- 042. What this position would bring in at that price. NULL — not 0 — when the
  -- item has no price, so it is skipped by sum() and still counted by count().
  round(soh.quantity_on_hand * i.default_selling_price, 2)::numeric(14,2)
                  as retail_value
from stock_on_hand soh
join inventory_items i
  on i.id = soh.inventory_item_id
 and i.tenant_id = soh.tenant_id
 and i.deleted_at is null                    -- rule 5
join locations l
  on l.id = soh.location_id
 and l.property_id = soh.property_id
 and l.deleted_at is null                    -- rule 5
left join inventory_categories c
  on c.id = i.category_id
 and c.tenant_id = soh.tenant_id
 and c.deleted_at is null;                   -- a removed category reads as blank

comment on view stock_on_hand_items is
  'stock_on_hand joined to the item catalogue and the location, so a stock list '
  'can search by item name/code and filter by category, and now by PRICED-ness, '
  'SERVER-SIDE (rule 1b) against the same rows its exact count and its totals '
  'describe (rule 20). retail_value is quantity x default_selling_price, rounded '
  'once here so there is one implementation of it; NULL (never 0) when the item '
  'has no price, so sum() skips it and count() can report how many were skipped. '
  'Soft-deleted items, locations and categories are filtered NULL-safely (rule 5).';


-- ----------------------------------------------------------------------------
-- 3.2 stock_on_hand_by_item — the same two figures on the property roll-up
-- ----------------------------------------------------------------------------
-- The roll-up gains the price and the retail sum so a product row viewed across
-- ALL locations shows retail the same way it shows value. Appended columns only,
-- and the join to inventory_items is new (the 036 version aggregated
-- stock_on_hand alone).
--
-- THE PRICE IS MIN(), WHICH IS AN AGGREGATE OVER ONE VALUE. The catalogue is
-- tenant-level, so every location's rows for one item share one
-- default_selling_price and any aggregate returns it. min() is used rather than
-- adding the column to the GROUP BY because grouping by a nullable price would
-- add nothing and quietly change the row count if it ever became per-location.
-- The retail sum is a real sum over the positions, and it SKIPS NULLs by
-- definition — so an unpriced item rolls up to NULL retail, not to zero.
create or replace view stock_on_hand_by_item
with (security_invoker = on) as
select
  soh.tenant_id,
  soh.property_id,
  soh.inventory_item_id,
  sum(soh.quantity_on_hand)::numeric(14,4) as quantity_on_hand,
  sum(soh.stock_value)::numeric(14,2)      as stock_value,
  case
    when sum(soh.quantity_on_hand) = 0 then null
    else round(sum(soh.stock_value) / sum(soh.quantity_on_hand), 4)
  end::numeric(14,4)                       as moving_average_cost,
  count(*)::integer                        as location_count,
  max(soh.last_movement_date)              as last_movement_date,
  -- 042. One price per item (the catalogue is tenant-level), so an aggregate over
  -- the group returns it unchanged.
  min(i.default_selling_price)::numeric(14,2) as default_selling_price,
  -- 042. Retail across every location holding it. sum() skips NULL, so an
  -- unpriced item is NULL here and never a confident zero.
  sum(round(soh.quantity_on_hand * i.default_selling_price, 2))::numeric(14,2)
                                           as retail_value
from stock_on_hand soh
join inventory_items i
  on i.id = soh.inventory_item_id
 and i.tenant_id = soh.tenant_id
 and i.deleted_at is null                  -- rule 5, matching §3.1
group by soh.tenant_id, soh.property_id, soh.inventory_item_id;

comment on view stock_on_hand_by_item is
  'One property''s stock of each item rolled up across every location. The roll-up '
  'unit cost is total value / total quantity — NEVER the unweighted mean of the '
  'per-location averages, which would multiply back to the wrong value. Zero '
  'quantity yields NULL, not a division by zero. 042 appends the item''s price and '
  'the retail sum; retail is NULL (not 0) for an unpriced item because sum() skips '
  'NULLs, which is what lets the screen count what it excluded instead of '
  'silently absorbing it into a total.';


-- ############################################################################
-- SECTION 4 — the reconciles-to invariants (rule 9)
-- ############################################################################
-- A figure nobody can reconcile is a figure nobody can trust, and the two added
-- here are the ones an owner will check by hand against a calculator. Stated in
-- SQL so the proof harness runs exactly what this claims:
--
--   RETAIL VALUE, per scope
--     sum(stock_on_hand_items.retail_value) filtered to a scope
--       === sum(quantity_on_hand * inventory_items.default_selling_price)
--           over the same positions, for positions where the price is NOT NULL
--     and the EXCLUDED COUNT
--       === count(distinct inventory_item_id) in that scope
--           where default_selling_price is null
--     so that (included + excluded) === every item holding a position in scope.
--
--   MARGIN, per scope
--     margin === sum(retail_value) - sum(stock_value) over THE SAME POSITIONS,
--     i.e. only those carrying a price. This is the subtle one and it is why the
--     summary card computes a SECOND cost total rather than reusing the one
--     beside it: the cost tile covers every position on the shelf, priced or not,
--     because that is what the books say the stock is worth. Subtracting THAT
--     from a retail total covering only priced positions would produce a margin
--     that treats every ingredient in the store as pure loss — a large negative
--     number, on an owner's dashboard, that is arithmetically explicable and
--     completely false. The two totals answer different questions and the card
--     labels them so.
--
--   PRICE COVERAGE
--     inventory_items where item_type in ('finished','both')
--       and default_selling_price is null and deleted_at is null
--     is the set the item list's "sellable, no price" filter shows, and it is the
--     set §1.2's trigger guarantees cannot GROW. It shrinks to empty as a hotel
--     prices its sellable lines, and nothing can put a row back into it.


-- ============================================================================
-- End of 042_item_price_and_image.sql
-- ============================================================================
