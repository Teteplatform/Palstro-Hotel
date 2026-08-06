-- ============================================================================
-- 036_stock_movements.sql
-- Palstro-Hotels: THE STOCK MOVEMENT LEDGER — the one place a quantity of
-- anything is recorded as having moved, and the valuation engine that reads it.
-- F&B/Inventory part 2a. After this migration every catalogue item can hold a
-- real quantity in a real location, valued at moving-average cost.
--
-- ----------------------------------------------------------------------------
-- THE ONE DECISION THIS FILE IS BUILT AROUND: STOCK IS NOT A COLUMN
-- ----------------------------------------------------------------------------
-- There is NO stock_levels table, and there is NO quantity_on_hand column
-- anywhere in this schema. An item's quantity in a location IS the sum of its
-- movements there, computed on every read.
--
-- That is CLAUDE.md rule 6 applied exactly as the folio balance applies it: a
-- stored balance is a second source of truth that drifts from the first one the
-- moment any write path forgets to update it, and — unlike a wrong ledger — a
-- drifted cache cannot be repaired from anything, because the information that
-- would repair it is what went missing. On the sister product the same shortcut
-- produced warehouse quantities nobody could reconcile to the movements that
-- supposedly produced them.
--
-- The honest price, stated plainly (022 states its own the same way): reading
-- on-hand costs an aggregate over the movement rows of that item in that
-- location. At a 30-room hotel that is a handful of rows per item. If it ever
-- stops being cheap, the answer is NOT a quantity column bolted on: it is rule
-- 6's deliberate route — a cache shipped in the SAME migration as its recompute
-- function, with every write path updating it in lockstep (rule 7). Do not
-- shortcut that.
--
-- ----------------------------------------------------------------------------
-- WHAT IS AND IS NOT HERE
-- ----------------------------------------------------------------------------
-- IS:     stock_movements (the ledger), the weighted-average-cost fold, the
--         on-hand/valuation views, two write RPCs (opening balance and
--         adjustment), and the removal guards 035 §7 promised for "part 2/3".
-- IS NOT: purchasing and supplier receipts (2c), issues and transfers between
--         locations (part 3), recipe-driven consumption and the
--         theoretical-vs-actual variance (later), stock counts, and any GL
--         posting. The movement TABLE is built wide enough for all of them —
--         the full movement_type set is declared below — but only 'opening' and
--         'adjustment' have a write path in this migration.
--
-- ----------------------------------------------------------------------------
-- CONVENTIONS INHERITED — all load-bearing
-- ----------------------------------------------------------------------------
--   * Quantities numeric(14,4), money numeric(14,2) (§6). Four decimals on
--     quantity because a recipe measure is 0.0250 kg and 2dp rounding drift is
--     precisely what destroys the variance report this module exists to produce.
--   * business_date date not null, separate from created_at (§6, rules 8/12):
--     a bar stock movement keyed at 02:00 belongs to the previous operating day.
--   * Composite FKs bind every scoping column to its parent's paired unique key,
--     so tenant_id can never disagree with the property or the item (§6).
--   * set_row_audit() owns the audit columns; the client can never set them.
--   * Rules 2/3: the write RPCs take p_idempotency_key and there is a partial
--     unique index behind it from day one.
--   * Rule 19: RLS restricts to the user's tenants; every application query
--     additionally scopes to the ACTIVE tenant and property.
-- ============================================================================


-- ############################################################################
-- SECTION 1 — stock_movements: the ledger
-- ############################################################################
--
--  ┌──────────────────────────────────────────────────────────────────────────┐
--  │  MOVEMENTS ARE PERMANENT. A row here is never updated and never deleted. │
--  │  A mistake is corrected by POSTING ANOTHER MOVEMENT (an adjustment now,  │
--  │  a reversal later) — never by editing the one that was wrong.            │
--  └──────────────────────────────────────────────────────────────────────────┘
--
-- The same discipline as the folio, for the same reason. The customer's stated
-- pain is staff theft: a ledger whose rows can be edited after the fact records
-- what someone last decided it should say, not what happened. Every correction
-- must therefore leave BOTH the original and the correction visible, each with
-- its own actor and its own timestamp. This is enforced by a trigger (§1.4), not
-- by convention — there is no code path, application or manual, that can rewrite
-- a movement.
--
-- ----------------------------------------------------------------------------
-- THE SIGN CONVENTION — read this before writing any query against this table
-- ----------------------------------------------------------------------------
-- `quantity` is SIGNED, and the sign is the whole direction system:
--
--        quantity > 0   the location GAINS this much stock   (a stock-IN)
--        quantity < 0   the location LOSES this much stock   (a stock-OUT)
--        quantity = 0   refused by a constraint — a movement of nothing is not
--                       a movement, and a zero row would silently pad counts.
--
-- On-hand is therefore a plain `sum(quantity)` and can never disagree with the
-- rows it came from. The rejected alternative — a positive magnitude plus a
-- separate direction flag — is two facts that can contradict each other, and
-- every reader would have to remember to apply the flag. folio_payments (021 §6)
-- made the same choice for the same reason.
--
-- A TRANSFER between two locations is TWO ROWS, not one: a 'transfer_out'
-- (negative, source location) and a 'transfer_in' (positive, destination),
-- linked by the same source document. That is part 3's job; the table is shaped
-- for it now so part 3 adds rows, not columns.
create table if not exists stock_movements (
  id                uuid primary key default gen_random_uuid(),

  -- INSERTION ORDER, and it is load-bearing for the valuation — not decoration.
  --
  -- Weighted-average cost is PATH-DEPENDENT (§2), so the fold has to walk the
  -- movements in a total order that is the same on every read. business_date
  -- orders them across days (rule 8: the business timeline, never created_at),
  -- but several movements routinely share one day and something has to break
  -- that tie deterministically.
  --
  -- created_at CANNOT do it. now() is the TRANSACTION's start time in Postgres,
  -- so every row written in one transaction carries an identical created_at; the
  -- tie would then fall to the uuid id, which is random, and the same history
  -- would fold to a DIFFERENT average on different reads. That is not a
  -- theoretical worry — it was caught by the dry-run harness before this shipped,
  -- where a receipt and an issue posted in one transaction produced an average
  -- that changed run to run.
  --
  -- An identity sequence is monotonic in real insertion order, within and across
  -- transactions, and is never reused. (Gaps from rolled-back inserts are fine:
  -- the fold needs an ORDER, not a contiguous count.)
  seq               bigint generated always as identity,

  -- No inline FKs on the scoping columns: the composite FKs at the bottom bind
  -- each pair to its parent, so a movement's tenant can never disagree with its
  -- property, its location or its item.
  tenant_id         uuid not null,
  property_id       uuid not null,

  -- THE LOCATION DIMENSION. This is what the ERP's single-location stock model
  -- does not have and what a hotel cannot work without: 200 kg of rice in the
  -- Main Store and 15 kg in the Kitchen are the same catalogue item with
  -- independent quantities, independent valuations and independent variance.
  -- Every quantity in this system is a quantity IN A LOCATION; there is no
  -- property-wide "stock of rice" except as a deliberate roll-up (§3.4).
  location_id       uuid not null,

  -- The catalogue item (035). TENANT-scoped, because the catalogue is: "Rice" is
  -- one definition shared by every property, which is what lets the food-cost
  -- report and the amenity-cost report value the same carton identically.
  inventory_item_id uuid not null,

  -- ------------------------------------------------------------------------
  -- THE FULL MOVEMENT TYPE SET — declared now, opened one tranche at a time
  -- ------------------------------------------------------------------------
  -- Every type this engine will ever post is named here, so later tranches add
  -- a WRITE PATH rather than reshaping a table that by then holds live history:
  --
  --   'opening'          initial balance when a hotel starts using the system.
  --                      WRITABLE NOW (post_opening_balance, §4.1). Once per
  --                      item per location — enforced by a unique index below.
  --   'adjustment'       a correction with a mandatory reason. WRITABLE NOW
  --                      (post_stock_adjustment, §4.2). Either direction.
  --   'receipt'          stock received from a purchase.        RESERVED — 2c.
  --   'issue_out'        stock issued OUT of a store on a requisition.
  --                                                             RESERVED — part 3.
  --   'issue_in'         the matching receipt INTO the requesting location.
  --                                                             RESERVED — part 3.
  --   'transfer_out'     stock leaving a location on a transfer.RESERVED — part 3.
  --   'transfer_in'      the matching arrival.                  RESERVED — part 3.
  --   'consumption'      recipe-driven deduction from an F&B sale.
  --                                                             RESERVED — later.
  --   'wastage'          spoilage/breakage written off, with a reason.
  --                                                             RESERVED — later.
  --   'count_adjustment' the variance a physical stock count posts.
  --                                                             RESERVED — later.
  --
  -- THE RESERVED TYPES HAVE NO WRITE PATH AT ALL TODAY, and that is structural
  -- rather than a matter of discipline: stock_movements has no write RLS policy
  -- for anyone (§5), and the only two SECURITY DEFINER functions that insert
  -- into it hardcode 'opening' and 'adjustment'. A client cannot post a
  -- 'consumption' row by any route until the tranche that owns it ships one.
  movement_type     text not null
                      constraint stock_movements_type_check
                      check (movement_type in (
                        'opening',
                        'adjustment',
                        'receipt',
                        'issue_out',
                        'issue_in',
                        'transfer_out',
                        'transfer_in',
                        'consumption',
                        'wastage',
                        'count_adjustment'
                      )),

  -- SIGNED quantity in the item's BASE UNIT (035: the smallest unit the
  -- storekeeper actually measures; there is no purchase-unit conversion factor
  -- in this module by design, so there is no factor to get wrong here either).
  -- See the sign convention above.
  quantity          numeric(14,4) not null
                      constraint stock_movements_quantity_nonzero_check
                      check (quantity <> 0),

  -- The cost of ONE BASE UNIT on THIS movement. Money, §6: numeric(14,2), and a
  -- STRING over PostgREST — parse with parseNumeric before any arithmetic.
  --
  -- REQUIRED ON EVERY STOCK-IN, FORBIDDEN ON EVERY STOCK-OUT, enforced by the
  -- constraint below. That asymmetry is the entire weighted-average method in
  -- one rule: stock arriving states what it cost and moves the average; stock
  -- leaving does NOT state a cost, it carries out the average that is already
  -- there (§3.1). A cost on an outgoing row would be a second, contradictory
  -- opinion about what that stock was worth, and whichever one a report happened
  -- to read would be the one that decided the food-cost figure.
  unit_cost         numeric(14,2)
                      constraint stock_movements_unit_cost_sign_check
                      check (unit_cost is null or unit_cost >= 0),

  -- THE OPERATING DAY this movement belongs to (§6, rules 8/12), in the
  -- PROPERTY's timezone — never derived from created_at, which is audit metadata
  -- only. A stock issue keyed at 02:00 belongs to the previous business day, and
  -- every report, valuation-at-a-date and variance groups by THIS column.
  business_date     date not null,

  -- WHY this movement happened. Mandatory for adjustments, wastage and count
  -- adjustments (constraint below); optional otherwise. An adjustment moves
  -- stock with no purchase and no sale behind it, which is the classic shape of
  -- a theft being covered — so it must name a reason and it is attributed to its
  -- actor by set_row_audit(), permanently.
  reason            text,
  -- Free-form extra detail (a delivery note number, "counted with the chef").
  note              text,

  -- Provenance. DELIBERATELY UNCONSTRAINED free text, exactly as
  -- folio_charges.source (021 §5): a later module posting movements must not
  -- need a migration to add its own name to a CHECK, which would reintroduce the
  -- per-module coupling one shared ledger exists to avoid.
  -- Today: 'manual' (a person keyed it) or 'import' (the opening-balance
  -- spreadsheet). Later: 'purchase', 'requisition', 'fnb', 'housekeeping'.
  source            text not null default 'manual',

  -- The document this movement came from, when there is one. NULLABLE and
  -- deliberately NOT an FK: the tables it will point at (purchase orders,
  -- requisitions, F&B orders) do not exist yet, and a polymorphic reference
  -- cannot be an FK anyway. The type column is what a later reader keys off.
  source_document_type text,
  source_document_id   uuid,

  -- Rules 2 & 3. A movement that comes from a document — or from a spreadsheet
  -- row — must be idempotent: the same intent replayed must return the SAME
  -- movement, never post a second one. The partial unique index below is the
  -- real guard under concurrency; the RPCs' fast path is the courtesy.
  idempotency_key   text,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  created_by        uuid default auth.uid() references auth.users(id),
  updated_by        uuid references auth.users(id),

  -- ------------------------------------------------------------------------
  -- THE COST/DIRECTION PAIRING — the weighted-average method as a constraint
  -- ------------------------------------------------------------------------
  -- Stock in states its cost; stock out states none. Written as a constraint
  -- rather than trusted to the RPCs so that no future write path — however it is
  -- built — can produce a row the valuation fold cannot value.
  constraint stock_movements_cost_direction_check
    check (
      (quantity > 0 and unit_cost is not null)
      or
      (quantity < 0 and unit_cost is null)
    ),

  -- ------------------------------------------------------------------------
  -- PER-TYPE DIRECTION — a 'receipt' can never remove stock
  -- ------------------------------------------------------------------------
  -- Six of the ten types have one legal direction by definition; the two
  -- correction types ('adjustment', 'count_adjustment') are legitimately either
  -- way, which is exactly what makes them the sensitive ones.
  constraint stock_movements_type_direction_check
    check (
      case movement_type
        when 'opening'      then quantity > 0
        when 'receipt'      then quantity > 0
        when 'issue_in'     then quantity > 0
        when 'transfer_in'  then quantity > 0
        when 'issue_out'    then quantity < 0
        when 'transfer_out' then quantity < 0
        when 'consumption'  then quantity < 0
        when 'wastage'      then quantity < 0
        else true                          -- adjustment, count_adjustment
      end
    ),

  -- A movement that changes stock with no purchase and no sale behind it MUST
  -- say why, at the database, not merely in the form that posted it.
  constraint stock_movements_reason_required_check
    check (
      movement_type not in ('adjustment', 'wastage', 'count_adjustment')
      or (reason is not null and length(btrim(reason)) > 0)
    ),

  -- Composite FKs (§6). Each binds a pair, so a cross-tenant row — which RLS
  -- could never detect, because every policy trusts tenant_id directly — is
  -- structurally impossible rather than a matter of application discipline.
  constraint stock_movements_property_tenant_fk
    foreign key (property_id, tenant_id)
    references properties (id, tenant_id) on delete cascade,

  -- Binds the location to the PROPERTY (which is already bound to the tenant
  -- above), so a movement can never be posted against another property's store.
  constraint stock_movements_location_property_fk
    foreign key (location_id, property_id)
    references locations (id, property_id) on delete cascade,

  -- Binds the item to the TENANT. ON DELETE left as NO ACTION (not RESTRICT, not
  -- CASCADE), for the reason 035 §3 records: CASCADE would let removing an item
  -- destroy the movement history that values it, and RESTRICT is checked
  -- immediately, which would break a tenant hard-delete where items and
  -- movements cascade away together. NO ACTION is checked at end of statement.
  constraint stock_movements_item_tenant_fk
    foreign key (inventory_item_id, tenant_id)
    references inventory_items (id, tenant_id)
);

comment on table stock_movements is
  'THE STOCK MOVEMENT LEDGER — the only record of stock in this system. An '
  'item''s quantity in a location IS the sum of its movements there; there is no '
  'stored balance anywhere, by design (rule 6, exactly as the folio balance). '
  'Rows are PERMANENT: never updated, never deleted, corrected only by posting '
  'another movement, and enforced by a trigger. Quantity is SIGNED (+ into the '
  'location, - out of it). Every stock-in carries a unit_cost and moves the '
  'weighted average; every stock-out carries none and leaves the average alone.';
comment on column stock_movements.seq is
  'Identity sequence = real insertion order, and the fold''s tiebreak within one '
  'business_date. Weighted-average cost is path-dependent, so the walk needs a '
  'TOTAL order that is stable across reads; created_at cannot provide it because '
  'now() is the transaction start time, so rows written together tie and the '
  'order would fall to a random uuid.';
comment on column stock_movements.quantity is
  'SIGNED quantity in the item''s base unit, numeric(14,4) (§6). POSITIVE adds '
  'to the location, NEGATIVE removes from it; zero is refused. On-hand is a '
  'plain sum(quantity), so it can never disagree with its own rows. A magnitude '
  'plus a direction flag would be two facts that can contradict each other.';
comment on column stock_movements.unit_cost is
  'Cost of ONE BASE UNIT on this movement, numeric(14,2) (§6; a STRING over '
  'PostgREST). REQUIRED on every stock-in and FORBIDDEN on every stock-out — '
  'that asymmetry IS the weighted-average method: arriving stock states its cost '
  'and moves the average, leaving stock carries out the average already there. A '
  'cost on an outgoing row would be a second opinion about the same stock.';
comment on column stock_movements.business_date is
  'The OPERATING DAY this movement belongs to, in the property''s timezone '
  '(rules 8/12). Never created_at — a 02:00 movement belongs to the previous '
  'business day, and every report, valuation and variance groups by this.';
comment on column stock_movements.movement_type is
  'The full set is declared from day one so later tranches add a write path, not '
  'a column: opening/adjustment are writable now; receipt (2c), issue_in, '
  'issue_out, transfer_in, transfer_out (part 3), consumption, wastage, '
  'count_adjustment (later) are RESERVED and have no write path — the table has '
  'no write RLS policy and the two RPCs hardcode their own type.';
comment on column stock_movements.reason is
  'WHY the stock moved. Mandatory for adjustment/wastage/count_adjustment (a DB '
  'constraint, not a form rule): those move stock with no purchase and no sale '
  'behind them, which is the shape a covered theft takes. The actor is stamped '
  'by set_row_audit() and cannot be forged.';
comment on column stock_movements.source is
  'Provenance (''manual'', ''import'', later ''purchase''/''requisition''/''fnb''). '
  'Free text ON PURPOSE, as folio_charges.source: a new posting module must never '
  'need a migration to name itself.';
comment on column stock_movements.source_document_id is
  'The document that produced this movement (a purchase, a requisition, an F&B '
  'order), once those exist. Deliberately not an FK — the reference is '
  'polymorphic and its targets are later tranches.';


-- ----------------------------------------------------------------------------
-- 1.1 Indexes
-- ----------------------------------------------------------------------------

-- Rule 3: the partial unique index behind p_idempotency_key, from day one. No
-- dormant 23505 handler waiting for an index that never shipped — the RPCs'
-- exception blocks (§4) name THIS index.
create unique index if not exists stock_movements_idem_uniq
  on stock_movements (tenant_id, idempotency_key)
  where idempotency_key is not null;

-- ONE OPENING BALANCE PER ITEM PER LOCATION, structurally.
--
-- This is the guard that makes a re-run of the day-one spreadsheet import safe
-- even when it is NOT byte-identical (a file re-saved by Excel, a row re-typed):
-- the idempotency key catches the identical replay, and this index catches the
-- non-identical one. "Opening balance" means the stock that was there when the
-- hotel started using the system — by definition it happens once. A second one
-- is not a second opening, it is a double-load, and the RPC turns this violation
-- into a plain-language error telling the user to post an adjustment instead.
create unique index if not exists stock_movements_one_opening_uniq
  on stock_movements (location_id, inventory_item_id)
  where movement_type = 'opening';

-- THE ON-HAND / VALUATION INDEX. The fold in §3 walks exactly this: every
-- movement of one item in one location, in business-date then insertion order.
-- The trailing (business_date, seq) columns are the fold's ORDER BY, so the walk
-- is an index scan with no sort — and that order is load-bearing, not cosmetic:
-- weighted-average cost is path-dependent, so the same movements folded in a
-- different order produce a different (wrong) average.
create index if not exists stock_movements_on_hand_idx
  on stock_movements (property_id, location_id, inventory_item_id,
                      business_date, seq);

-- Reporting by operating day within a property (movements per day, valuation at
-- a date), and the per-item history across every location.
create index if not exists stock_movements_property_date_idx
  on stock_movements (property_id, business_date);
create index if not exists stock_movements_item_idx
  on stock_movements (inventory_item_id);
-- tenant_id drives the member-select policy predicate; indexed as 001/002 do.
create index if not exists stock_movements_tenant_id_idx
  on stock_movements (tenant_id);


-- ----------------------------------------------------------------------------
-- 1.2 Audit columns — INSERT-only, because the row is insert-only
-- ----------------------------------------------------------------------------
-- §6's immutable-table rule: "an immutable, insert-only table carries created_by
-- and gets an INSERT-only trigger; updated_by stays NULL until first update" —
-- and here there is never a first update, so updated_by stays NULL forever and
-- that NULL is meaningful: it says this row has never been touched since it was
-- written, which is the guarantee the whole ledger rests on.
--
-- The shared trigger is still the mechanism (never the client): a movement that
-- arrives with its own created_by has it overwritten. "Who did this" must be
-- answerable for every row, because the customer's primary pain is staff theft
-- and an actor column the actor could set themselves would make every
-- theft-detection report worthless.
drop trigger if exists set_row_audit_stock_movements on stock_movements;
create trigger set_row_audit_stock_movements
  before insert on stock_movements
  for each row execute function set_row_audit();


-- ----------------------------------------------------------------------------
-- 1.3 change_log — logging the INSERT, because there is never an UPDATE
-- ----------------------------------------------------------------------------
-- Every other table in this system carries log_field_changes() (006), an AFTER
-- UPDATE trigger. On an immutable table that trigger can never fire: attaching
-- it here would be dead code that reads like coverage.
--
-- What the change-log viewer needs from this table is the opposite fact — that a
-- movement was POSTED, by whom, and what it said. So this is the generic
-- INSERT-side counterpart of log_field_changes, written once here so every later
-- insert-only table (requisition lines, count lines) reuses it rather than
-- inventing its own.
create or replace function log_row_insert()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  v_new     jsonb := to_jsonb(new);
  v_tenant  uuid;
  v_row     uuid;
  v_summary text;
begin
  -- Same tenant resolution as log_field_changes(): tenant_id where the table has
  -- one, else up through property_id. A table with neither logs nothing rather
  -- than writing an unattributable audit row.
  if v_new ? 'tenant_id' then
    v_tenant := (v_new->>'tenant_id')::uuid;
  elsif v_new ? 'property_id' then
    select p.tenant_id into v_tenant
    from properties p where p.id = (v_new->>'property_id')::uuid;
  end if;

  if v_tenant is null then
    return null;
  end if;

  v_row := (v_new->>'id')::uuid;

  -- The row as it was written, minus the audit columns (which change_log already
  -- records in changed_by/changed_at, and which are noise in a diff view).
  v_summary := (v_new - 'created_at' - 'created_by' - 'updated_at' - 'updated_by')::text;

  insert into change_log
    (tenant_id, table_name, row_id, field_name, old_value, new_value, changed_by)
  values (
    v_tenant, tg_table_name, v_row, '(created)', null,
    case when length(v_summary) > 4000
         then left(v_summary, 4000) || '… [truncated]'
         else v_summary end,
    -- Same actor rule as everywhere else: the session user, falling back to the
    -- row's created_by when there is no session (a SECURITY DEFINER RPC — which
    -- is exactly how every movement is posted, so this branch is the normal one).
    coalesce(auth.uid(), (v_new->>'created_by')::uuid)
  );

  return null; -- AFTER trigger: the return value is ignored.
end;
$$;

comment on function log_row_insert() is
  'Generic AFTER INSERT change-log trigger — the insert-side counterpart of '
  'log_field_changes(), for IMMUTABLE tables where the update trigger could '
  'never fire. Writes ONE change_log row per inserted row, field_name '
  '''(created)'', new_value the row as written minus its audit columns. '
  'SECURITY DEFINER with a pinned search_path, because change_log has no insert '
  'policy for anyone.';

drop trigger if exists log_row_insert_stock_movements on stock_movements;
create trigger log_row_insert_stock_movements
  after insert on stock_movements
  for each row execute function log_row_insert();


-- ----------------------------------------------------------------------------
-- 1.4 IMMUTABILITY — the trigger that makes "permanent" true
-- ----------------------------------------------------------------------------
-- Rule 19 in its purest form: the UI not offering an edit button is a courtesy;
-- THIS is the guard. With no write RLS policy on the table (§5) a client cannot
-- reach it at all, and with this trigger even the service role — or somebody in
-- the SQL editor at 2am — cannot quietly change what a movement said.
--
-- THE ONE PERMITTED DELETE, and why it must be permitted: the composite FKs
-- above cascade from properties and locations, so hard-deleting a property (a
-- tenant teardown) has to be able to take its movements with it. A blanket
-- BEFORE DELETE refusal would make that cascade fail and leave a tenant
-- undeletable. So the guard allows a delete ONLY when the parent property is
-- already gone — i.e. only as part of that cascade, where the parent tuple is
-- deleted before the referential action removes the children. A delete aimed at
-- a movement whose property still exists is refused.
create or replace function forbid_stock_movement_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    if not exists (select 1 from properties p where p.id = old.property_id) then
      return old;  -- cascade from a property being hard-deleted: let it through
    end if;
    raise exception
      'Stock movements are permanent and cannot be deleted. Correct the stock with an adjustment instead.'
      using errcode = 'PT403';
  end if;

  raise exception
    'Stock movements are permanent and cannot be edited. Correct the stock with an adjustment instead.'
    using errcode = 'PT403';
end;
$$;

comment on function forbid_stock_movement_change() is
  'Makes stock_movements genuinely immutable: refuses every UPDATE and every '
  'DELETE except the cascade from a property being hard-deleted (detected by the '
  'parent already being gone). A ledger whose rows can be edited records what '
  'someone last decided it should say, not what happened.';

drop trigger if exists stock_movements_forbid_update on stock_movements;
create trigger stock_movements_forbid_update
  before update on stock_movements
  for each row execute function forbid_stock_movement_change();

drop trigger if exists stock_movements_forbid_delete on stock_movements;
create trigger stock_movements_forbid_delete
  before delete on stock_movements
  for each row execute function forbid_stock_movement_change();


-- ############################################################################
-- SECTION 2 — THE WEIGHTED-AVERAGE-COST FOLD
-- ############################################################################
--
--  ┌──────────────────────────────────────────────────────────────────────────┐
--  │  THE FORMULA, ONCE, IN ONE PLACE.                                        │
--  │                                                                          │
--  │  STOCK IN  (quantity > 0, carrying unit_cost c for q units):             │
--  │                                                                          │
--  │                    (Q × A)  +  (q × c)                                   │
--  │      A' =  ────────────────────────────────         Q' = Q + q           │
--  │                        Q + q                                             │
--  │                                                                          │
--  │      where Q = quantity on hand before, A = average cost before.         │
--  │                                                                          │
--  │  STOCK OUT (quantity < 0):                                              │
--  │                                                                          │
--  │      A' = A            (UNCHANGED)                 Q' = Q + q  (q < 0)   │
--  │                                                                          │
--  │      and the cost carried out of stock is |q| × A.                       │
--  └──────────────────────────────────────────────────────────────────────────┘
--
-- WHY THE AVERAGE MUST NOT MOVE ON THE WAY OUT: the value of what leaves is
-- |q| × A and the value remaining is (Q − |q|) × A, which still sums to Q × A.
-- Issuing stock cannot change what the stock left behind is worth — only buying
-- more at a different price can. A method that re-averaged on issue would let the
-- act of cooking change the cost of the rice still in the store.
--
-- ----------------------------------------------------------------------------
-- THE TWO EDGE CASES THE BRIEF ASKS ABOUT, ANSWERED EXPLICITLY
-- ----------------------------------------------------------------------------
-- 1. THE FIRST RECEIPT (and any receipt into an empty or negative position).
--    When Q <= 0 the formula above is NOT used at all: there is no existing
--    quantity to weight and no meaningful existing average, so the incoming cost
--    simply BECOMES the average — A' = c. For the genuine first receipt
--    (Q = 0) that is what the formula would give anyway ((0×A + q×c)/q = c);
--    the branch exists so the Q < 0 case (an over-issue later corrected by a
--    receipt) does not weight the new cost against a negative quantity, which
--    would produce an average on the wrong side of zero.
--
-- 2. DIVISION BY ZERO — IMPOSSIBLE, BY CONSTRUCTION.
--    The division is reached only on the ELSE branch, which requires Q > 0, and
--    it is only ever reached with q > 0 (the whole branch is guarded by
--    quantity > 0). Therefore the denominator Q + q is the sum of two strictly
--    positive numbers and is strictly positive. There is no input — including
--    an empty movement history, a zero position, a negative position, or a
--    zero-cost receipt — that can make it zero. The zero-quantity movement that
--    could otherwise sneak a 0/0 through is refused by a table constraint (§1),
--    and a NULL/zero-quantity argument returns the state untouched below.
--
-- ----------------------------------------------------------------------------
-- WHY A CUSTOM AGGREGATE AND NOT A LOOP IN A FUNCTION
-- ----------------------------------------------------------------------------
-- The average is PATH-DEPENDENT: receive 100 @ ₦1.50, issue 40, receive 50 @
-- ₦1.70 gives a different average from receiving both lots before issuing. So it
-- cannot be expressed as sum()/sum() and it cannot be reordered. It has to be a
-- fold over the movements in business-date order.
--
-- Written as a custom aggregate, that fold becomes an ordinary SQL expression:
--   stock_wac(quantity, unit_cost ORDER BY business_date, created_at, id)
-- which means the on-hand VIEWS below are plain SQL that PostgREST can filter,
-- order, page and count directly (rule 1b) — no per-row function call, no N+1,
-- and ONE definition of the method that every consumer shares. A plpgsql loop
-- would have forced every list surface through an RPC and would have tempted a
-- second implementation in TypeScript, which is exactly how the folio's tax
-- rules were nearly duplicated (022's header).
-- ############################################################################

-- The running state: how much is on hand so far, and what it is worth per unit.
-- Both plain `numeric` (unconstrained precision) ON PURPOSE — this is an
-- INTERMEDIATE value, and rounding it to 2 or 4 dp at every step would compound
-- a rounding error across a year of movements. Rounding happens ONCE, at the
-- point of presentation (§3).
do $$
begin
  if not exists (select 1 from pg_type where typname = 'stock_wac_state') then
    create type stock_wac_state as (
      quantity     numeric,
      average_cost numeric
    );
  end if;
end $$;

comment on type stock_wac_state is
  'Running state of the weighted-average-cost fold: quantity on hand so far and '
  'the average unit cost so far. Unconstrained numeric deliberately — rounding an '
  'intermediate at every step compounds error across a year of movements.';

-- The transition function. IMMUTABLE: same state + same movement = same result,
-- always, which is what lets the planner use it inside a view.
create or replace function stock_wac_step(
  state       stock_wac_state,
  p_quantity  numeric,
  p_unit_cost numeric
)
returns stock_wac_state
language plpgsql
immutable
as $$
declare
  v_qty   numeric := coalesce(state.quantity, 0);
  v_avg   numeric := coalesce(state.average_cost, 0);
  v_denom numeric;
begin
  -- A movement of nothing changes nothing. The table constraint already refuses
  -- quantity = 0, so this is belt-and-braces against a NULL arriving from a
  -- future caller — and it is the reason no 0/0 can be constructed.
  if p_quantity is null or p_quantity = 0 then
    return state;
  end if;

  if p_quantity > 0 then
    if v_qty <= 0 then
      -- FIRST RECEIPT, or a receipt into an empty/negative position: the
      -- incoming cost BECOMES the average. No division is performed at all.
      -- coalesce keeps a cost-less stock-in (impossible today — the table
      -- forbids it) from wiping a known average.
      v_avg := coalesce(p_unit_cost, v_avg);
    else
      -- THE WEIGHTED AVERAGE. v_qty > 0 and p_quantity > 0, so the denominator
      -- is strictly positive: this division cannot fail.
      v_denom := v_qty + p_quantity;
      v_avg := ((v_qty * v_avg) + (p_quantity * coalesce(p_unit_cost, v_avg)))
               / v_denom;
    end if;
  end if;
  -- STOCK OUT falls through with v_avg UNTOUCHED: it carries cost out at the
  -- current average and leaves the remaining stock worth exactly what it was.

  return (v_qty + p_quantity, v_avg)::stock_wac_state;
end;
$$;

comment on function stock_wac_step(stock_wac_state, numeric, numeric) is
  'One step of the weighted-average-cost fold. Stock IN: A'' = (Q×A + q×c)/(Q+q), '
  'with the Q<=0 case short-circuiting to A'' = c so the first receipt needs no '
  'division and a negative position cannot invert the average. Stock OUT: the '
  'average is untouched and the cost carried out is |q|×A. The division is '
  'reachable only with Q>0 and q>0, so it can never divide by zero.';

-- The aggregate. Always call it with an ORDER BY — the fold is path-dependent
-- and an unordered call is not "approximately right", it is meaningless:
--   stock_wac(quantity, unit_cost order by business_date, created_at, id)
create or replace aggregate stock_wac(numeric, numeric) (
  sfunc    = stock_wac_step,
  stype    = stock_wac_state,
  initcond = '(0,0)'
);

comment on aggregate stock_wac(numeric, numeric) is
  'Folds a movement history into (quantity_on_hand, moving_average_cost). ALWAYS '
  'call with ORDER BY business_date, seq — weighted average cost is '
  'path-dependent, so an unordered call is meaningless rather than approximate, '
  'and created_at cannot break the tie because it is the transaction clock.';


-- ############################################################################
-- SECTION 3 — ON-HAND AND VALUATION (computed, never stored)
-- ############################################################################
-- Four read surfaces over one fold. Every one of them computes from movements on
-- every read; none of them caches anything (rule 6).
--
-- SECURITY: `security_invoker = on` on every view, exactly as 022/027 and for
-- the same reason. A Postgres view runs with its OWNER's rights by default,
-- which would make these a hole straight through RLS — any authenticated user
-- could read every tenant's stock and its valuation. With security_invoker the
-- base-table RLS applies as if the caller had queried stock_movements directly.
--
-- ROUNDING, stated once and applied consistently:
--   * quantity_on_hand     numeric(14,4) — the item's own quantity precision.
--   * moving_average_cost  numeric(14,4) — FOUR decimals, not two, and this is
--     deliberate. An average of 2dp costs is NOT itself a 2dp number: 100 kg at
--     ₦1.50 plus 50 kg at ₦1.70 averages ₦1.5667, and rounding that to ₦1.57
--     before multiplying by 150 overstates the stock by ₦0.50 on one item — an
--     error that scales with quantity and never washes out. It also has to
--     survive a base unit of a GRAM, where a real cost per unit is ₦0.0012.
--   * stock_value          numeric(14,2) — MONEY, rounded once, at the end, from
--     the unrounded quantity × unrounded average. This is the only figure that
--     ever reaches an accounting surface, and it is rounded exactly once.


-- ----------------------------------------------------------------------------
-- 3.1 stock_on_hand — one row per (location, item)
-- ----------------------------------------------------------------------------
-- THE base valuation surface. Everything else in this section, and every screen,
-- reads through this or the join on top of it.
--
-- INVARIANT (rule 9 — every ledger reconciles to something upstream):
--   stock_on_hand.quantity_on_hand
--     === sum(stock_movements.quantity) for that (property, location, item)
-- by construction — the fold's quantity IS that sum, accumulated in the same
-- pass as the average, so the two can never disagree. And:
--   sum(stock_on_hand.stock_value) over a location
--     === that location's total stock value shown on screen (§ the UI total),
-- which is why the screen's total is computed across the whole filtered set from
-- THIS column and never summed from a visible page (rule 20).
--
-- NEGATIVE ON-HAND — how it is treated, and why it is not floored:
--   * This tranche writes only 'opening' and 'adjustment', so normal use cannot
--     drive a quantity negative: an opening balance is positive by constraint,
--     and post_stock_adjustment REFUSES a negative result unless the caller
--     explicitly confirms it (§4.2).
--   * A negative quantity is nevertheless REPRESENTABLE and is shown as-is,
--     never floored at zero with GREATEST(0, ...). Rule 7 forbids exactly that
--     floor, for exactly this reason: a location showing 0 kg when the ledger
--     says −3 kg has hidden the discrepancy the system exists to surface. −3 kg
--     means three kilos left without a movement — a receipt that was never
--     entered, or stock that walked. That is the theft signal, not a display bug.
--   * The hard guard against ISSUING more than is on hand belongs to the issue
--     and consumption tranches (part 3), where an issue is the thing that could
--     cause it. Here, an adjustment that would go negative is flagged and
--     requires confirmation.
create or replace view stock_on_hand
with (security_invoker = on) as
select
  f.tenant_id,
  f.property_id,
  f.location_id,
  f.inventory_item_id,
  -- The fold's own quantity, not a separate sum(): one accumulation, so the
  -- quantity and the average that values it always describe the same walk.
  ((f.wac).quantity)::numeric(14,4)                                as quantity_on_hand,
  round((f.wac).average_cost, 4)::numeric(14,4)                    as moving_average_cost,
  round((f.wac).quantity * (f.wac).average_cost, 2)::numeric(14,2) as stock_value,
  f.movement_count,
  f.last_movement_date
from (
  select
    sm.tenant_id,
    sm.property_id,
    sm.location_id,
    sm.inventory_item_id,
    count(*)::integer      as movement_count,
    max(sm.business_date)  as last_movement_date,
    -- THE ORDER IS LOAD-BEARING (§2): the business timeline first (rule 8 — a
    -- back-dated movement belongs where it happened, not where it was keyed),
    -- then `seq`, the identity sequence, which totally orders same-day movements
    -- by real insertion order. See the seq column's comment for why created_at
    -- cannot serve here: it is the transaction clock, so it ties.
    stock_wac(sm.quantity, sm.unit_cost
              order by sm.business_date, sm.seq) as wac
  from stock_movements sm
  group by sm.tenant_id, sm.property_id, sm.location_id, sm.inventory_item_id
) f;

comment on view stock_on_hand is
  'Quantity on hand, moving-average cost and stock value per (location, item), '
  'COMPUTED from stock_movements on every read — nothing is stored (rule 6). '
  'INVARIANT: quantity_on_hand === sum(stock_movements.quantity) for that '
  '(property, location, item), by construction. Negative quantities are shown '
  'as-is and never floored (rule 7): a negative on-hand is stock that left '
  'without a movement, which is the discrepancy this system exists to surface. '
  'security_invoker: the caller''s RLS decides what is visible.';


-- ----------------------------------------------------------------------------
-- 3.2 stock_on_hand_items — the same, joined to the catalogue
-- ----------------------------------------------------------------------------
-- What the stock screen reads. The join lives HERE, in the database, so that the
-- list's search and category filters are applied SERVER-SIDE against the same
-- rows the count and the total describe (rules 1b and 20). Filtering a fetched
-- page in TypeScript would make "of N" a lie.
--
-- SOFT-DELETED PARENTS DO NOT CASCADE (§6's explicit warning): an item or a
-- location with deleted_at set is still a live FK target, so both are filtered
-- NULL-safely here. That exclusion is safe precisely because §6 of this file
-- makes it impossible to remove either while it still holds stock — so a hidden
-- row is always a zero row, and no value can go missing from the total.
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
  -- THE LOW-STOCK FLAG. 035 captured reorder_level and said the alert itself was
  -- "a later report"; this is that report in its first useful form, and it costs
  -- one CASE. Computed HERE rather than in the client because a list cannot
  -- filter server-side (rule 1b) on a comparison between two columns that
  -- PostgREST has no way to express — and a client-side "low stock" filter over
  -- a fetched page would make the count and the total describe different sets.
  -- NULL reorder_level means the item is simply not monitored, which is FALSE
  -- (not low), never NULL: a filter must not silently drop unmonitored items.
  (i.reorder_level is not null and soh.quantity_on_hand <= i.reorder_level)
                  as is_below_reorder,
  i.is_active     as item_is_active,
  c.name          as category_name,
  l.name          as location_name,
  l.kind          as location_kind
from stock_on_hand soh
join inventory_items i
  on i.id = soh.inventory_item_id
 and i.tenant_id = soh.tenant_id
 and i.deleted_at is null                    -- rule 5, and see the note above
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
  'can search by item name/code and filter by category SERVER-SIDE (rule 1b) '
  'against the same rows its exact count and its total value describe (rule 20). '
  'Soft-deleted items, locations and categories are filtered NULL-safely (rule '
  '5) — safe because §6 forbids removing either while it holds stock.';


-- ----------------------------------------------------------------------------
-- 3.3 stock_on_hand_by_item — the property-wide roll-up
-- ----------------------------------------------------------------------------
-- The same stock summed ACROSS a property's locations: "how much rice does this
-- hotel hold, anywhere?"
--
-- THE ROLL-UP'S AVERAGE COST IS value/quantity, NOT the average of the averages.
-- Two locations holding the same item at different averages (the Main Store
-- bought at ₦1.50, the Kitchen received an earlier lot at ₦1.20) have genuinely
-- different unit costs, and averaging those two numbers unweighted would produce
-- a figure that multiplies back to the wrong total value. Value is additive;
-- unit cost is not.
--
-- A zero total quantity yields NULL rather than a division by zero: with nothing
-- on hand there is no meaningful unit cost, and NULL renders as the shared
-- em-dash placeholder rather than as a confident zero (§6, MISSING_VALUE).
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
  max(soh.last_movement_date)              as last_movement_date
from stock_on_hand soh
group by soh.tenant_id, soh.property_id, soh.inventory_item_id;

comment on view stock_on_hand_by_item is
  'One property''s stock of each item rolled up across every location. The '
  'roll-up unit cost is total value / total quantity — NEVER the unweighted mean '
  'of the per-location averages, which would multiply back to the wrong value. '
  'Zero quantity yields NULL, not a division by zero.';


-- ----------------------------------------------------------------------------
-- 3.4 stock_movement_ledger — the audit trail BEHIND the number
-- ----------------------------------------------------------------------------
-- Every movement of an item in a location, in fold order, each carrying the
-- running quantity and running average cost AS AT THAT MOVEMENT. This is what
-- lets a manager open an item and see exactly how its current cost was arrived
-- at — which receipt moved the average and by how much — instead of being asked
-- to trust a figure with no working shown (rule 16's principle applied to a
-- valuation rather than to a dashboard tile).
--
-- WHY THE RUNNING FIGURES COME FROM THE DATABASE AND NOT FROM THE CLIENT: 022's
-- header records the trap in its own words — re-implementing an engine rule in
-- TypeScript produces a second implementation that drifts from the first the day
-- either changes, and then the working shown disagrees with the number shown and
-- nothing errors. So the running average here is THE SAME stock_wac fold (§2),
-- applied to the movements up to and including each row. There is exactly one
-- definition of weighted-average cost in this system.
--
-- THE COST: a correlated aggregate per row, i.e. O(n²) in the movements of ONE
-- item in ONE location. That is a handful of rows per item at this property's
-- volume, and the view is only ever read for a single expanded item — never for
-- a list. If it is ever read broadly, page it or restrict it by item first.
create or replace view stock_movement_ledger
with (security_invoker = on) as
select
  m.id,
  m.tenant_id,
  m.property_id,
  m.location_id,
  m.inventory_item_id,
  m.seq,
  m.movement_type,
  m.quantity,
  m.unit_cost,
  m.business_date,
  m.reason,
  m.note,
  m.source,
  m.created_at,
  m.created_by,
  ((w.wac).quantity)::numeric(14,4)     as running_quantity,
  round((w.wac).average_cost, 4)::numeric(14,4) as running_average_cost,
  -- The VALUE this movement moved, signed like the quantity. A stock-in moved
  -- quantity x its own stated cost. A stock-out moved quantity x the average —
  -- and because an out does not change the average, the running average after it
  -- IS the average it left at, so one expression is correct for both.
  round(
    case when m.quantity > 0 then m.quantity * m.unit_cost
         else m.quantity * (w.wac).average_cost end,
    2
  )::numeric(14,2)                      as movement_value
from stock_movements m
cross join lateral (
  select stock_wac(m2.quantity, m2.unit_cost
                   order by m2.business_date, m2.seq) as wac
  from stock_movements m2
  where m2.location_id = m.location_id
    and m2.inventory_item_id = m.inventory_item_id
    and (m2.business_date, m2.seq) <= (m.business_date, m.seq)
) w;

comment on view stock_movement_ledger is
  'Every stock movement with the running quantity and running average cost as at '
  'that movement — the working behind the current valuation, so a manager can see '
  'which receipt moved the average and by how much. The running average is THE '
  'SAME stock_wac fold (§2) applied to the movements up to each row, never a '
  'second implementation. movement_value is signed: in = quantity x its own cost, '
  'out = quantity x the average it left at. Correlated per row, so read it for '
  'ONE item in ONE location, never across a list.';


-- ----------------------------------------------------------------------------
-- 3.5 The scalar readers
-- ----------------------------------------------------------------------------
-- The brief names stock_on_hand(property, location, item) and
-- stock_moving_average_cost(property, location, item) as functions, and the RPCs
-- in §4 need exactly those two numbers for one item before they post. Both are
-- thin wrappers over the view above — the detail-plus-wrapper shape 021 uses for
-- folio_totals/folio_balance — so there is no second implementation of the fold
-- that could drift from the first.
--
-- NAMING NOTE: `stock_on_hand` is both a VIEW and a FUNCTION. Postgres keeps
-- relations and functions in separate catalogs, so the two coexist without
-- ambiguity (`select * from stock_on_hand` is the view; `select
-- stock_on_hand(a,b,c)` is the function). It is called out here so nobody
-- rediscovers it as a surprise.
--
-- SECURITY INVOKER, DELIBERATELY — all three, and this is the important part.
-- They read the security_invoker views, so called by a CLIENT they see exactly
-- what that client's RLS allows: their own tenants and nothing else. Making them
-- SECURITY DEFINER would have turned each into a hole straight through RLS —
-- pass any property/location/item id and read another hotel's position. Called
-- from INSIDE the SECURITY DEFINER RPCs in §4 they run as the function owner and
-- therefore see the true, unfiltered position, which is exactly what a guard
-- needs: an adjustment must be checked against all the stock that is really
-- there, not against the stock its caller happens to be able to see.

-- Everything about one item in one location, in one row. Returns a row with
-- zeros and a NULL cost when the item has never moved in that location — the
-- callers need to tell "no history" (cost NULL) from "history, currently zero"
-- (cost known), and that distinction decides whether an adjustment must state a
-- cost (§4.2).
create or replace function stock_valuation(
  p_property_id       uuid,
  p_location_id       uuid,
  p_inventory_item_id uuid
)
returns table (
  quantity_on_hand    numeric,
  moving_average_cost numeric,
  stock_value         numeric,
  movement_count      integer
)
language sql
stable
set search_path = public
as $$
  select
    coalesce(v.quantity_on_hand, 0)::numeric,
    v.moving_average_cost::numeric,       -- NULL when there is no history at all
    coalesce(v.stock_value, 0)::numeric,
    coalesce(v.movement_count, 0)
  from (select 1) one
  left join stock_on_hand v
    on v.property_id = p_property_id
   and v.location_id = p_location_id
   and v.inventory_item_id = p_inventory_item_id;
$$;

comment on function stock_valuation(uuid, uuid, uuid) is
  'Quantity, moving-average cost and value of ONE item in ONE location. Always '
  'returns exactly one row: an item that has never moved there reads 0 quantity '
  'with a NULL cost, which is how a caller tells "no history" from "history, '
  'currently zero" — the distinction that decides whether an adjustment must '
  'state a unit cost.';

create or replace function stock_on_hand(
  p_property_id       uuid,
  p_location_id       uuid,
  p_inventory_item_id uuid
)
returns numeric
language sql
stable
set search_path = public
as $$
  select quantity_on_hand
  from stock_valuation(p_property_id, p_location_id, p_inventory_item_id);
$$;

comment on function stock_on_hand(uuid, uuid, uuid) is
  'Quantity on hand of one item in one location = the sum of its signed '
  'movements there, computed on read (rule 6). Zero when it has never moved '
  'there. NOT floored: a negative result is real and is shown as such (rule 7).';

create or replace function stock_moving_average_cost(
  p_property_id       uuid,
  p_location_id       uuid,
  p_inventory_item_id uuid
)
returns numeric
language sql
stable
set search_path = public
as $$
  select moving_average_cost
  from stock_valuation(p_property_id, p_location_id, p_inventory_item_id);
$$;

comment on function stock_moving_average_cost(uuid, uuid, uuid) is
  'The current weighted-average unit cost of one item in one location, folded '
  'from its movement history in business-date order (§2). NULL — never 0 — when '
  'the item has never moved there, so "we do not know" is distinguishable from '
  '"it is free".';


-- ############################################################################
-- SECTION 4 — THE WRITE RPCs
-- ############################################################################
-- Both are SECURITY DEFINER with a pinned search_path, both are staff-gated via
-- is_tenant_staff (015 §6.5), both are idempotent against
-- stock_movements_idem_uniq (rules 2/3), and both run inside the implicit
-- transaction of the function call so a failure anywhere rolls the whole posting
-- back (rule 11). Errors are RAISEd with meaningful SQLSTATEs for the client to
-- read verbatim, never swallowed.
--
-- WHY STAFF AND NOT ADMIN. Loading opening stock and correcting a count are
-- STORE work, the same way taking a booking is front-desk work — a storekeeper
-- who cannot record what is on the shelf is a storekeeper who keeps a paper
-- book, and then the system holds nothing. 015 §6.5 settled this split for the
-- whole product: operating the hotel is is_tenant_staff, configuring it is
-- is_tenant_admin. Finer per-role control ("only a manager may post an
-- adjustment over ₦50,000") belongs to the staff-permissions build, exactly as
-- 015 records — not here, and not as a UI-only check.
--
-- The ACCOUNTABILITY that matters today is already unforgeable: set_row_audit()
-- stamps created_by from the session, an adjustment cannot be posted without a
-- reason (a table constraint), and the row can never be edited afterwards.

-- ----------------------------------------------------------------------------
-- 4.1 post_opening_balance — how stock first exists
-- ----------------------------------------------------------------------------
-- The day-one load: "when we switched the system on, this location held this
-- much of this item, and it had cost us this much per unit."
--
-- ONCE PER ITEM PER LOCATION. A second opening balance is not a second opening,
-- it is a double-load — the single most expensive mistake available on this
-- screen, because the stock looks plausible and the variance report is wrong
-- forever. Two independent guards:
--   * p_idempotency_key collapses the identical replay (a double-click, a retry,
--     the same spreadsheet uploaded twice — the import derives its keys from the
--     file's own content hash, so a re-upload replays rather than re-posts);
--   * stock_movements_one_opening_uniq refuses a SECOND opening even under a
--     different key, which is what catches the same stock arriving from a
--     re-saved or re-typed file.
-- Ongoing stock-in is NOT this function: it is a purchase receipt (2c). This is
-- the starting line only.
create or replace function post_opening_balance(
  p_property_id       uuid,
  p_location_id       uuid,
  p_inventory_item_id uuid,
  p_quantity          numeric,
  p_unit_cost         numeric,
  p_business_date     date,
  p_note              text,
  p_idempotency_key   text
)
returns stock_movements
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant   uuid;
  v_timezone text;
  v_today    date;
  v_date     date;
  v_existing stock_movements;
  v_movement stock_movements;
begin
  -- The property is the anchor: it resolves the tenant (never trusted from the
  -- client) and it carries the timezone the business date is computed in.
  select p.tenant_id, p.timezone into v_tenant, v_timezone
  from properties p
  where p.id = p_property_id and p.deleted_at is null;

  if v_tenant is null then
    raise exception 'Property % not found', p_property_id using errcode = 'PT404';
  end if;

  if not is_tenant_staff(v_tenant) then
    raise exception 'Not authorised to post stock movements for this property'
      using errcode = 'insufficient_privilege';
  end if;

  -- IDEMPOTENCY FAST PATH (rules 2/3): a retry, a double-click or a re-uploaded
  -- spreadsheet row with the same key returns the SAME movement. The unique
  -- index is the real guard under concurrency and is handled below.
  if p_idempotency_key is not null then
    select * into v_existing
    from stock_movements
    where tenant_id = v_tenant and idempotency_key = p_idempotency_key
    limit 1;
    if found then
      return v_existing;
    end if;
  end if;

  -- The location must belong to THIS property, be live and be in use. The
  -- composite FK enforces the property part structurally; this gives a
  -- plain-language error instead of a raw FK violation, and additionally blocks
  -- a retired location (which the FK cannot see, since deleted_at does not
  -- cascade — §6's warning).
  if not exists (
    select 1 from locations l
    where l.id = p_location_id
      and l.property_id = p_property_id
      and l.deleted_at is null                       -- rule 5
      and l.is_active = true
  ) then
    raise exception 'That stock location is not available for this property'
      using errcode = 'PT404';
  end if;

  if not exists (
    select 1 from inventory_items i
    where i.id = p_inventory_item_id
      and i.tenant_id = v_tenant
      and i.deleted_at is null                       -- rule 5
      and i.is_active = true
  ) then
    raise exception 'That item is not available in this catalogue'
      using errcode = 'PT404';
  end if;

  if p_quantity is null or p_quantity <= 0 then
    raise exception 'An opening balance must be greater than zero. To record nothing on hand, post no opening balance at all.'
      using errcode = 'PT422';
  end if;

  -- A cost is REQUIRED here and cannot be inferred: this is the first movement
  -- of this item in this location, so there is no existing average to fall back
  -- on. An opening balance loaded at zero cost would value the whole starting
  -- stock at nothing and quietly understate every consumption report built on it.
  if p_unit_cost is null then
    raise exception 'A unit cost is required on an opening balance — it is what the stock on hand is worth.'
      using errcode = 'PT422';
  end if;
  if p_unit_cost < 0 then
    raise exception 'A unit cost cannot be negative' using errcode = 'PT422';
  end if;

  -- BUSINESS DATE (rules 8/12), resolved in the PROPERTY's timezone exactly as
  -- 020/021 do, with the same defensive fallback for an unset zone. NULL means
  -- "the property's local today"; it is not a defaulted parameter because
  -- p_idempotency_key follows it and is mandatory (rule 2).
  v_today := (now() at time zone coalesce(nullif(btrim(v_timezone), ''), 'Africa/Lagos'))::date;
  v_date  := coalesce(p_business_date, v_today);

  -- Nothing has happened tomorrow. A future-dated movement would sit in the
  -- ledger changing today's on-hand while claiming it belongs to a day that has
  -- not started, and every valuation-at-a-date would disagree with the screen.
  if v_date > v_today then
    raise exception 'A stock movement cannot be dated in the future (today is % at this property)', v_today
      using errcode = 'PT422';
  end if;

  -- Friendly pre-check for the once-per-item-per-location rule. The unique index
  -- is the guard; this is the message.
  if exists (
    select 1 from stock_movements sm
    where sm.location_id = p_location_id
      and sm.inventory_item_id = p_inventory_item_id
      and sm.movement_type = 'opening'
  ) then
    raise exception 'This item already has an opening balance in this location. Post an adjustment to correct the quantity instead.'
      using errcode = 'PT409';
  end if;

  begin
    insert into stock_movements (
      tenant_id, property_id, location_id, inventory_item_id,
      movement_type, quantity, unit_cost, business_date,
      reason, note, source, idempotency_key, created_by
    ) values (
      v_tenant, p_property_id, p_location_id, p_inventory_item_id,
      'opening', p_quantity, p_unit_cost, v_date,
      null, nullif(btrim(p_note), ''), 'manual', p_idempotency_key, auth.uid()
    )
    returning * into v_movement;
  exception
    when unique_violation then
      -- A CONCURRENT call with the same key won the race
      -- (stock_movements_idem_uniq): return its row rather than posting twice.
      if p_idempotency_key is not null then
        select * into v_existing
        from stock_movements
        where tenant_id = v_tenant and idempotency_key = p_idempotency_key
        limit 1;
        if found then
          return v_existing;
        end if;
      end if;
      -- Otherwise it was stock_movements_one_opening_uniq: a different key
      -- trying to open the same item in the same location a second time.
      raise exception 'This item already has an opening balance in this location. Post an adjustment to correct the quantity instead.'
        using errcode = 'PT409';
  end;

  return v_movement;
end;
$$;

comment on function post_opening_balance(uuid, uuid, uuid, numeric, numeric, date, text, text) is
  'Posts the day-one ''opening'' movement: what a location held when the hotel '
  'started using the system, and what it cost per base unit. ONCE per item per '
  'location, guarded twice — the idempotency key collapses an identical replay '
  '(rules 2/3), and stock_movements_one_opening_uniq refuses a second opening '
  'under any other key. Staff-gated, SECURITY DEFINER, pinned search_path. NULL '
  'p_business_date = the property''s local today; a future date is refused. '
  'ONGOING stock-in is a purchase receipt (2c), never this.';


-- ----------------------------------------------------------------------------
-- 4.2 post_stock_adjustment — the correction, with its reason attached
-- ----------------------------------------------------------------------------
-- An adjustment changes stock with NO purchase and NO sale behind it. That makes
-- it the most sensitive write in this module and the classic shape of a covered
-- theft: stock that walked, written down as "wastage" by the person who took it.
-- So three things are non-negotiable and all three are enforced server-side:
--   1. A REASON is mandatory (a table constraint, not a form rule).
--   2. The ACTOR is stamped by set_row_audit() from the session and cannot be
--      supplied by the caller.
--   3. The row can never afterwards be edited or deleted (§1.4).
--
-- THE COST OF A POSITIVE ADJUSTMENT. p_unit_cost is optional and defaults to the
-- CURRENT moving average, which is the right default by a long way: "I found two
-- more kilos of the same rice" is the same rice at the same cost, and defaulting
-- to it leaves the average exactly where it was. Supplying a different cost is
-- allowed and deliberately DOES move the average — that is what it means. When
-- there is no history at all there is no average to fall back on, so a cost
-- becomes required rather than being silently assumed to be zero.
--
-- NEGATIVE RESULTS ARE FLAGGED, NOT FORBIDDEN (the brief's requirement). An
-- adjustment that would leave the location holding less than nothing raises
-- PT449 — "retry with confirmation" — carrying the resulting figure in its
-- message, and the caller may re-submit with p_allow_negative => true (and the
-- SAME idempotency key, so the confirmation cannot double-post). The refusal is
-- not a moral position on negative stock; it is that going negative is nearly
-- always a typo, and on the rare occasion it is not, the honest record is a
-- negative balance nobody floored away (rule 7).
create or replace function post_stock_adjustment(
  p_property_id       uuid,
  p_location_id       uuid,
  p_inventory_item_id uuid,
  p_quantity          numeric,   -- SIGNED: + adds, - removes
  p_reason            text,      -- mandatory
  p_business_date     date,
  p_unit_cost         numeric,   -- positive adjustments only; NULL = current average
  p_idempotency_key   text,
  p_allow_negative    boolean default false
)
returns stock_movements
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant   uuid;
  v_timezone text;
  v_today    date;
  v_date     date;
  v_reason   text;
  v_existing stock_movements;
  v_movement stock_movements;
  v_val      record;
  v_cost     numeric;
  v_result   numeric;
  v_unit     text;
begin
  select p.tenant_id, p.timezone into v_tenant, v_timezone
  from properties p
  where p.id = p_property_id and p.deleted_at is null;

  if v_tenant is null then
    raise exception 'Property % not found', p_property_id using errcode = 'PT404';
  end if;

  if not is_tenant_staff(v_tenant) then
    raise exception 'Not authorised to post stock movements for this property'
      using errcode = 'insufficient_privilege';
  end if;

  -- IDEMPOTENCY FAST PATH (rules 2/3). This one is load-bearing beyond the usual
  -- double-click: the negative-stock confirmation below re-submits the SAME
  -- intent with the same key, so a user who confirms cannot post twice.
  if p_idempotency_key is not null then
    select * into v_existing
    from stock_movements
    where tenant_id = v_tenant and idempotency_key = p_idempotency_key
    limit 1;
    if found then
      return v_existing;
    end if;
  end if;

  if not exists (
    select 1 from locations l
    where l.id = p_location_id
      and l.property_id = p_property_id
      and l.deleted_at is null
      and l.is_active = true
  ) then
    raise exception 'That stock location is not available for this property'
      using errcode = 'PT404';
  end if;

  -- An INACTIVE item may still be adjusted, unlike an opening balance: a
  -- discontinued line that is still sitting on a shelf has to be correctable and
  -- writable down to zero. A REMOVED (soft-deleted) item may not — and cannot
  -- hold stock anyway, because §6 refuses to remove one that does.
  select i.base_unit into v_unit
  from inventory_items i
  where i.id = p_inventory_item_id
    and i.tenant_id = v_tenant
    and i.deleted_at is null;

  if v_unit is null then
    raise exception 'That item is not available in this catalogue'
      using errcode = 'PT404';
  end if;

  if p_quantity is null or p_quantity = 0 then
    raise exception 'An adjustment must add or remove some quantity. Enter a positive number to add stock or a negative one to remove it.'
      using errcode = 'PT422';
  end if;

  -- A reason is mandatory. The table constraint refuses a blank one too; this
  -- exists so the user reads a sentence rather than a constraint name.
  v_reason := nullif(btrim(coalesce(p_reason, '')), '');
  if v_reason is null then
    raise exception 'A reason is required for a stock adjustment — it is the record of why stock changed with no purchase or sale behind it.'
      using errcode = 'PT422';
  end if;

  v_today := (now() at time zone coalesce(nullif(btrim(v_timezone), ''), 'Africa/Lagos'))::date;
  v_date  := coalesce(p_business_date, v_today);

  if v_date > v_today then
    raise exception 'A stock movement cannot be dated in the future (today is % at this property)', v_today
      using errcode = 'PT422';
  end if;

  -- The CURRENT position, folded from the movements (§3) — never a stored
  -- number. Used for two things: defaulting the cost, and the negative guard.
  select * into v_val
  from stock_valuation(p_property_id, p_location_id, p_inventory_item_id);

  if p_quantity > 0 then
    -- Default to the current average: adding more of the same stock at the same
    -- cost leaves the average untouched, which is what "I found two more kilos"
    -- means. An explicitly supplied cost is honoured and DOES move the average.
    v_cost := coalesce(p_unit_cost, v_val.moving_average_cost);
    if v_cost is null then
      raise exception 'This item has no stock history in this location, so a unit cost is required to add stock.'
        using errcode = 'PT422';
    end if;
    if v_cost < 0 then
      raise exception 'A unit cost cannot be negative' using errcode = 'PT422';
    end if;
  else
    -- A stock-OUT states no cost — it leaves at the current average (§2). A
    -- supplied cost is REFUSED rather than ignored: silently dropping a number
    -- somebody typed is how a user comes to believe stock left at a cost it did
    -- not leave at.
    if p_unit_cost is not null then
      raise exception 'A unit cost cannot be given when removing stock — stock leaves at its current average cost.'
        using errcode = 'PT422';
    end if;
    v_cost := null;
  end if;

  -- THE NEGATIVE GUARD. Flag, do not forbid (see the header).
  v_result := coalesce(v_val.quantity_on_hand, 0) + p_quantity;
  if v_result < 0 and not coalesce(p_allow_negative, false) then
    -- The resulting figure is IN the message on purpose: "this would go
    -- negative" is a rule, "this would leave -12.5 kg" is a number the person
    -- can compare against the shelf in front of them. Trailing zeros are
    -- stripped so a whole number reads as "-12", not "-12.0000".
    raise exception
      'This adjustment would leave % % on hand, which is less than nothing. Check the quantity — or confirm to record it anyway.',
      rtrim(rtrim(trim(to_char(v_result, 'FM999999999990.0000')), '0'), '.'), v_unit
      using errcode = 'PT449';
  end if;

  begin
    insert into stock_movements (
      tenant_id, property_id, location_id, inventory_item_id,
      movement_type, quantity, unit_cost, business_date,
      reason, note, source, idempotency_key, created_by
    ) values (
      v_tenant, p_property_id, p_location_id, p_inventory_item_id,
      'adjustment', p_quantity, v_cost, v_date,
      v_reason, null, 'manual', p_idempotency_key, auth.uid()
    )
    returning * into v_movement;
  exception
    when unique_violation then
      if p_idempotency_key is not null then
        select * into v_existing
        from stock_movements
        where tenant_id = v_tenant and idempotency_key = p_idempotency_key
        limit 1;
        if found then
          return v_existing;
        end if;
      end if;
      raise;
  end;

  return v_movement;
end;
$$;

comment on function post_stock_adjustment(uuid, uuid, uuid, numeric, text, date, numeric, text, boolean) is
  'Posts an ''adjustment'' movement — a correction with no purchase or sale '
  'behind it, which is why a REASON is mandatory (a table constraint) and the '
  'actor is stamped from the session and unforgeable. Signed quantity: + adds, - '
  'removes. A positive adjustment defaults its unit cost to the CURRENT moving '
  'average (adding the same stock leaves the average alone); a negative one may '
  'state no cost at all. An adjustment that would drive on-hand below zero '
  'raises PT449 with the resulting figure and must be re-submitted with '
  'p_allow_negative => true and the SAME idempotency key. Staff-gated, '
  'idempotent (rules 2/3), SECURITY DEFINER, pinned search_path.';


-- ############################################################################
-- SECTION 5 — Row-Level Security
-- ############################################################################
-- stock_movements is a TRANSACTIONAL table, so it takes the posture 015/021 set
-- for bookings, folios, charges and payments: member SELECT and NOTHING ELSE.
--
-- NO INSERT, UPDATE OR DELETE POLICY FOR ANYONE — and this is load-bearing, not
-- caution. A direct INSERT would bypass the staff gate, the location and item
-- validation, the future-date guard, the once-per-location opening rule, the
-- cost defaulting and the negative-stock confirmation — every one of which is
-- the thing that makes the number on the screen trustworthy. A direct UPDATE
-- would rewrite history (the immutability trigger refuses it regardless).
-- DO NOT ADD A WRITE POLICY TO THIS TABLE.
--
-- READ IS MEMBER-WIDE, not admin-only: a storekeeper who cannot see what is on
-- the shelf cannot do their job, and rule 19 means every application query
-- additionally scopes to the single active tenant AND property on top of this.
--
-- NO PUBLIC/ANON POLICY, ever. What a hotel holds in its stores, what it paid
-- for it and what it writes off are private operational data; 001 §14 lists the
-- only three tables that may ever be public and this is not among them. With RLS
-- enabled and no anon policy, an anon SELECT returns zero rows: fail-closed.
alter table stock_movements enable row level security;

drop policy if exists stock_movements_member_select on stock_movements;
create policy stock_movements_member_select on stock_movements
  for select to authenticated
  using (tenant_id = any(get_tenant_ids()));

drop policy if exists stock_movements_member_insert on stock_movements;
drop policy if exists stock_movements_member_update on stock_movements;
drop policy if exists stock_movements_member_delete on stock_movements;


-- ############################################################################
-- SECTION 6 — The removal guards 035 §7 promised
-- ############################################################################
-- 035 recorded two rules it could not yet enforce, because the table they read
-- did not exist. It exists now, so they are enforced now — at the DATABASE, in
-- the soft-delete path itself, not in the UI (rule 19: the UI check is a
-- courtesy, the DB check is the guard).
--
--   * A LOCATION HOLDING STOCK MAY NOT BE REMOVED. Removing it would strand that
--     stock: the movements stay in the ledger and in the valuation, but no
--     screen lists the location, so nothing can ever be counted against it or
--     transferred out of it. Move the stock out first (or write it off with an
--     adjustment), then remove the location.
--
--   * AN ITEM HOLDING STOCK MAY NOT BE REMOVED, for the same reason.
--     (The OTHER half of 035's item rule — an item referenced by a live RECIPE —
--     still belongs to part 3, which is when recipes exist.)
--
-- BOTH GUARDS TEST NON-ZERO ON-HAND, NOT "HAS ANY HISTORY". An item that moved
-- in and back out to zero holds nothing and can be retired; its movements stay
-- in the ledger and its history stays readable, exactly as a removed charge
-- category keeps last year's bills renderable. What must never happen is
-- stranded stock nobody can reach.
--
-- The functions read stock_movements DIRECTLY rather than through the
-- stock_on_hand view, deliberately: SECURITY DEFINER + a direct read means the
-- guard sees every row regardless of the caller's RLS, so it cannot be defeated
-- by a caller who simply cannot see the stock they are about to strand.

create or replace function guard_location_stock_on_remove()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Only on the transition into removed. Editing an already-removed row, or any
  -- other update, is none of this trigger's business.
  if new.deleted_at is null or old.deleted_at is not null then
    return new;
  end if;

  if exists (
    select 1
    from stock_movements sm
    where sm.location_id = old.id
    group by sm.inventory_item_id
    having sum(sm.quantity) <> 0
  ) then
    raise exception
      'This location still holds stock. Transfer it out or write it off with an adjustment before removing the location — otherwise the stock stays in the ledger with no screen able to reach it.'
      using errcode = 'PT409';
  end if;

  return new;
end;
$$;

comment on function guard_location_stock_on_remove() is
  'Refuses the soft-delete of a location that still holds stock (035 §7). Tests '
  'NON-ZERO on-hand, not "has history": a location that moved back to zero can '
  'be retired and keeps its history. At the DB, not the UI (rule 19).';

drop trigger if exists guard_location_stock_on_remove_trigger on locations;
create trigger guard_location_stock_on_remove_trigger
  before update on locations
  for each row execute function guard_location_stock_on_remove();

create or replace function guard_item_stock_on_remove()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.deleted_at is null or old.deleted_at is not null then
    return new;
  end if;

  if exists (
    select 1
    from stock_movements sm
    where sm.inventory_item_id = old.id
    group by sm.location_id
    having sum(sm.quantity) <> 0
  ) then
    raise exception
      'This item still has stock on hand in at least one location. Write it down to zero with an adjustment before removing it from the catalogue.'
      using errcode = 'PT409';
  end if;

  return new;
end;
$$;

comment on function guard_item_stock_on_remove() is
  'Refuses the soft-delete of a catalogue item that still holds stock anywhere '
  '(035 §7). The other half of 035''s item rule — an item used by a live RECIPE — '
  'belongs to part 3, when recipes exist.';

drop trigger if exists guard_item_stock_on_remove_trigger on inventory_items;
create trigger guard_item_stock_on_remove_trigger
  before update on inventory_items
  for each row execute function guard_item_stock_on_remove();


-- ############################################################################
-- SECTION 7 — Grants
-- ############################################################################
-- Views: authenticated staff, SELECT only, NEVER anon — identical to 022/027 and
-- for the same reason. The `revoke all ... from authenticated` before each grant
-- is load-bearing and NOT redundant with the revoke from public: Supabase's
-- default privileges grant ALL on every new relation in `public` to
-- `authenticated`, so a bare `grant select` would leave INSERT/UPDATE/DELETE in
-- place.
revoke all on stock_on_hand from public;
revoke all on stock_on_hand from anon;
revoke all on stock_on_hand from authenticated;
grant select on stock_on_hand to authenticated;

revoke all on stock_on_hand_items from public;
revoke all on stock_on_hand_items from anon;
revoke all on stock_on_hand_items from authenticated;
grant select on stock_on_hand_items to authenticated;

revoke all on stock_on_hand_by_item from public;
revoke all on stock_on_hand_by_item from anon;
revoke all on stock_on_hand_by_item from authenticated;
grant select on stock_on_hand_by_item to authenticated;

revoke all on stock_movement_ledger from public;
revoke all on stock_movement_ledger from anon;
revoke all on stock_movement_ledger from authenticated;
grant select on stock_movement_ledger to authenticated;

-- Functions: SECURITY DEFINER functions default to EXECUTE for PUBLIC. Revoke
-- that on every one and grant only authenticated staff, never anon — the guest
-- website has no business reading what the kitchen holds, let alone posting to
-- it.
revoke execute on function stock_valuation(uuid, uuid, uuid) from public;
revoke execute on function stock_valuation(uuid, uuid, uuid) from anon;
grant  execute on function stock_valuation(uuid, uuid, uuid) to authenticated;

revoke execute on function stock_on_hand(uuid, uuid, uuid) from public;
revoke execute on function stock_on_hand(uuid, uuid, uuid) from anon;
grant  execute on function stock_on_hand(uuid, uuid, uuid) to authenticated;

revoke execute on function stock_moving_average_cost(uuid, uuid, uuid) from public;
revoke execute on function stock_moving_average_cost(uuid, uuid, uuid) from anon;
grant  execute on function stock_moving_average_cost(uuid, uuid, uuid) to authenticated;

revoke execute on function post_opening_balance(uuid, uuid, uuid, numeric, numeric, date, text, text) from public;
revoke execute on function post_opening_balance(uuid, uuid, uuid, numeric, numeric, date, text, text) from anon;
grant  execute on function post_opening_balance(uuid, uuid, uuid, numeric, numeric, date, text, text) to authenticated;

revoke execute on function post_stock_adjustment(uuid, uuid, uuid, numeric, text, date, numeric, text, boolean) from public;
revoke execute on function post_stock_adjustment(uuid, uuid, uuid, numeric, text, date, numeric, text, boolean) from anon;
grant  execute on function post_stock_adjustment(uuid, uuid, uuid, numeric, text, date, numeric, text, boolean) to authenticated;

-- The trigger functions are plumbing, called by their triggers and by nothing
-- else. A trigger runs as the trigger, not under the caller's EXECUTE privilege,
-- so revoking here does not affect them.
revoke execute on function log_row_insert() from public;
revoke execute on function log_row_insert() from anon;
revoke execute on function log_row_insert() from authenticated;

revoke execute on function forbid_stock_movement_change() from public;
revoke execute on function forbid_stock_movement_change() from anon;
revoke execute on function forbid_stock_movement_change() from authenticated;

revoke execute on function guard_location_stock_on_remove() from public;
revoke execute on function guard_location_stock_on_remove() from anon;
revoke execute on function guard_location_stock_on_remove() from authenticated;

revoke execute on function guard_item_stock_on_remove() from public;
revoke execute on function guard_item_stock_on_remove() from anon;
revoke execute on function guard_item_stock_on_remove() from authenticated;

-- stock_wac_step is IMMUTABLE and non-SECURITY-DEFINER (it touches no table), so
-- it is safe for anyone to call; the aggregate must remain executable by the
-- roles that read the views, which is what makes those views work at all.

-- ============================================================================
-- End of 036_stock_movements.sql
-- ============================================================================
