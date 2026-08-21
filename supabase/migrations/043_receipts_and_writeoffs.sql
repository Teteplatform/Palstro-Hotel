-- ============================================================================
-- 043_receipts_and_writeoffs.sql
-- Palstro-Hotels: stock ARRIVES, and stock is LOST — the two movement types 036
-- reserved and nothing has ever written.
--
-- ----------------------------------------------------------------------------
-- WHY THIS COMES BEFORE OUTLET PRICES
-- ----------------------------------------------------------------------------
-- Nothing can be sold yet, so a price override would move a figure on a screen
-- and nothing else. Meanwhile the moving average is FROZEN at whatever the
-- opening balances said, because there is no way to record a purchase. The week
-- this hotel starts buying rice, every valuation drifts and nothing says so —
-- the food-cost report, the stock value on the dashboard, the variance on a
-- count, all of them quietly wrong and none of them complaining.
--
-- A receipt is what moves the average. That is this migration's whole purpose,
-- and it is why it jumped the queue.
--
-- ----------------------------------------------------------------------------
-- WHAT IS HERE
-- ----------------------------------------------------------------------------
--   §1  three columns on stock_movements: supplier, authorised_by, reason_code
--   §2  post_stock_receipt      — stock arriving from outside
--   §3  post_stock_writeoff     — stock lost, by category
--   §4  two views for the provenance report
--   §5  grants, and the anon assertion
--
-- WHAT IS NOT HERE, deliberately:
--   * SUPPLIERS AS A TABLE. §1's supplier is free text. Stage 7 turns it into a
--     supplier record and a purchase order, and a half-built supplier table now
--     would have to be unpicked then. A text column upgrades cleanly: the
--     migration that creates suppliers can match on the text it finds.
--   * ISSUES AND TRANSFERS. Those are the requisition module's two-sided
--     movement with an approval in the middle, not a form.
--   * ANY CHANGE TO THE FOLD. stock_wac (036 §2) values a receipt correctly
--     already — it is an ordinary stock-in that states its cost. Nothing about
--     the valuation engine changes; this migration only gives it input.
--
-- CONVENTIONS INHERITED — all load-bearing:
--   * Both RPCs read like their siblings post_opening_balance and
--     post_stock_adjustment (038 §8), in the SAME guard order. That order is
--     itself a decision — see §2's header.
--   * Money numeric(14,2), quantities numeric(14,4) (§6), STRINGS over PostgREST
--     and parsed at the boundary (rule 24).
--   * Rules 2/3: every write takes p_idempotency_key, guarded by the partial
--     unique index that already exists on stock_movements.
--   * Rule 21: every refusal carries a MESSAGE with the rule and a HINT with the
--     way out. The client renders both and authors neither.
--   * SECURITY DEFINER + pinned search_path, staff-gated, actor stamped from the
--     session and unforgeable (§6 actor columns).
-- ============================================================================


-- ############################################################################
-- SECTION 1 — three columns on stock_movements
-- ############################################################################

alter table stock_movements
  -- WHO IT CAME FROM, as free text. 'Bonny Fresh Foods', 'the cash and carry',
  -- 'Chidi'. Not a foreign key, and that is the decision rather than the
  -- shortcut: a hotel buys rice from three people at three prices, and the
  -- useful fact is which delivery came from whom — which is a purchase order,
  -- which is stage 7. A text column upgrades into that cleanly; a half-built
  -- suppliers table would have to be unpicked first.
  add column if not exists supplier text,

  -- THE MANAGER WHO AUTHORISED AN EXCEPTION (§2). NULL on every ordinary
  -- movement, and non-null only on a direct receipt into a non-store location.
  --
  -- A NEW COLUMN RATHER THAN A REUSED ONE. reversals.approved_by exists, but it
  -- is a different table recording a different act; the §4 report has to name
  -- who authorised THIS receipt, and that has to be on the movement itself or
  -- the report cannot answer the question it exists to ask.
  add column if not exists authorised_by uuid references auth.users(id),

  -- WHY STOCK WAS WRITTEN OFF, as a CATEGORY rather than as prose (§3).
  --
  -- THE SPLIT BETWEEN THIS AND `reason`, which is the one shape decision in this
  -- file worth reading twice:
  --
  --   reason_code   the machine key — 'spoilage', 'breakage', …
  --   reason        the human sentence, which 036's
  --                 stock_movements_reason_required_check ALREADY demands be
  --                 non-blank for a wastage row
  --   note          the free text the person typed
  --
  -- The RPC writes the category's LABEL into `reason`, so the existing
  -- constraint is satisfied, and every current reader — the ledger, the item
  -- page, the movements list, the exports — keeps working with no change at all.
  -- The report groups on reason_code, so it never has to parse prose.
  --
  -- A CONSEQUENCE WORTH STATING RATHER THAN DISCOVERING: because the label is
  -- COPIED at write time, a row keeps the wording it was written with even if the
  -- label text is later reworded. That is correct — a ledger records what was
  -- said at the time, not what the current release would say — but it means the
  -- code is the thing to group by and the reason is the thing to display.
  add column if not exists reason_code text;

comment on column stock_movements.supplier is
  'Who the stock came from, as FREE TEXT — deliberately not a foreign key. A '
  'supplier record and a purchase order arrive in stage 7; a text column upgrades '
  'into them cleanly, while a half-built suppliers table would have to be '
  'unpicked. Set on receipts; NULL everywhere else.';
comment on column stock_movements.authorised_by is
  'The manager who authorised an EXCEPTION to a posting rule — today, a direct '
  'receipt into a location that is not a store (043 §2). NULL on every ordinary '
  'movement. Recorded on the movement rather than in reversals.approved_by, which '
  'is a different table for a different act, because the provenance report has to '
  'name who authorised THIS receipt.';
comment on column stock_movements.reason_code is
  'The write-off CATEGORY as a machine key (spoilage/breakage/expiry/staff_meal/'
  'complimentary), so wastage can be grouped without parsing prose. The matching '
  'human label is copied into `reason` at write time — which satisfies 036''s '
  'reason-required check and keeps every existing reader working — and stays as '
  'written even if the label is later reworded, because a ledger records what was '
  'said at the time.';

-- ----------------------------------------------------------------------------
-- 1.1 The category set, and where it may appear
-- ----------------------------------------------------------------------------
-- The five §9 names, as a CHECK rather than a reference table. Same reasoning as
-- item_type (035 §3): these are BEHAVIOUR the reports branch on — staff meals and
-- complimentaries are a cost of doing business, spoilage and breakage are losses
-- to chase — not values a tenant configures. A sixth would be a code change by
-- definition, so a migration is the right place for it.
alter table stock_movements
  drop constraint if exists stock_movements_reason_code_check;
alter table stock_movements
  add constraint stock_movements_reason_code_check
    check (
      reason_code is null
      or reason_code in ('spoilage', 'breakage', 'expiry', 'staff_meal', 'complimentary')
    );

-- A reason_code belongs to a write-off and to nothing else, in BOTH directions:
-- a wastage row without one cannot be grouped on the report it exists to feed,
-- and an adjustment carrying one would be a correction claiming to be a loss —
-- which is precisely the blur §9 says destroys the variance report.
alter table stock_movements
  drop constraint if exists stock_movements_reason_code_shape_check;
alter table stock_movements
  add constraint stock_movements_reason_code_shape_check
    check ((movement_type = 'wastage') = (reason_code is not null));

comment on constraint stock_movements_reason_code_shape_check on stock_movements is
  'A reason_code appears on a wastage row and on no other, written as an '
  'equivalence so neither half can hold alone. A write-off without a category '
  'cannot be grouped on the wastage report; an adjustment WITH one would be a '
  'correction claiming to be a loss, which is exactly the blur that makes a '
  'variance report meaningless (§9: an adjustment means the count was wrong, a '
  'write-off means we lost it and here is why).';

-- authorised_by is scoped to the one act that uses it today. Narrow on purpose:
-- the column means "a manager approved an exception", and a stray value on an
-- adjustment would imply an approval that never happened. Widening it when
-- issues or transfers gain an approval is a one-line migration; leaving it open
-- now would make the report's "who authorised this" unanswerable in general.
alter table stock_movements
  drop constraint if exists stock_movements_authorised_scope_check;
alter table stock_movements
  add constraint stock_movements_authorised_scope_check
    check (authorised_by is null or movement_type = 'receipt');

-- The report's hot path: direct receipts for one property, newest first.
create index if not exists stock_movements_authorised_idx
  on stock_movements (property_id, business_date desc)
  where authorised_by is not null;

-- Wastage grouped by category, for the loss report.
create index if not exists stock_movements_wastage_idx
  on stock_movements (property_id, reason_code, business_date desc)
  where movement_type = 'wastage';


-- ############################################################################
-- SECTION 2 — post_stock_receipt
-- ############################################################################
-- STOCK ARRIVING FROM OUTSIDE. The movement that recomputes the moving average,
-- and the reason this shipment exists.
--
-- ----------------------------------------------------------------------------
-- THE GUARD ORDER IS ITS SIBLINGS' (038 §8), AND THAT IS DELIBERATE
-- ----------------------------------------------------------------------------
--   property → tenant + timezone, staff gate, idempotency fast path, location,
--   item, shape checks, batch/expiry, business date + future guard, POSTING
--   LOCK, then the type-specific rule, then the insert with its
--   unique_violation catch.
--
-- The posting lock sits AFTER the future-date guard for 038's stated reason: a
-- caller who is wrong about both is told about the nearer problem first. The
-- type-specific rule sits last because it is the most expensive to explain, and
-- a person who has also got the date wrong should hear about the date.
--
-- ----------------------------------------------------------------------------
-- ONLY THE STORE RECEIVES (§2 of the brief, §9 of CLAUDE.md)
-- ----------------------------------------------------------------------------
-- Goods reach the kitchen, the bar or housekeeping by LEAVING THE STORE, never
-- by arriving from outside. That is a hard rule and this function refuses it.
--
-- THE EXCEPTION EXISTS ON PURPOSE, and the reasoning is worth keeping: without
-- it, staff who buy something directly will record a fake store receipt and an
-- instant requisition, which is worse than no paperwork — it puts two fictional
-- movements in the ledger instead of one true one, and the store's average cost
-- absorbs a delivery that never touched it. So a manager PIN plus a mandatory
-- reason allows the direct receipt, and every one of them is FLAGGED rather than
-- hidden. It is not an error; it is a thing the owner should be able to see.
--
-- THE TEST IS kind = 'store', NOT is_default_store. A hotel may run a dry store
-- and a main store; both are legitimately stores, only one can be the designated
-- receiving point (037's enforce_single_default_store keeps that flag unique),
-- and refusing a delivery into the second would be wrong in a way nobody would
-- notice until a hotel with two stores complained.
create or replace function post_stock_receipt(
  p_property_id       uuid,
  p_location_id       uuid,
  p_inventory_item_id uuid,
  p_quantity          numeric,   -- POSITIVE: a receipt is stock arriving
  p_unit_cost         numeric,   -- REQUIRED: this is what moves the average
  p_business_date     date,
  p_supplier          text,
  p_note              text,
  p_idempotency_key   text,
  p_batch_code        text default null,
  p_expiry_date       date default null,
  -- The §2 exception. Both required together, or neither.
  p_manager_pin       text default null,
  p_reason            text default null
)
returns stock_movements
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_tenant    uuid;
  v_timezone  text;
  v_today     date;
  v_date      date;
  v_kind      text;
  v_locname   text;
  v_tracks    boolean;
  v_batch     text;
  v_reason    text;
  v_manager   uuid;
  v_existing  stock_movements;
  v_movement  stock_movements;
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

  -- IDEMPOTENCY FAST PATH (rules 2/3). A delivery keyed twice — a double-click, a
  -- retry on a dropped connection — must return the movement that already exists
  -- rather than receiving the same rice twice and moving the average twice.
  if p_idempotency_key is not null then
    select * into v_existing
    from stock_movements
    where tenant_id = v_tenant and idempotency_key = p_idempotency_key
    limit 1;
    if found then
      return v_existing;
    end if;
  end if;

  select l.kind, l.name into v_kind, v_locname
  from locations l
  where l.id = p_location_id
    and l.property_id = p_property_id
    and l.deleted_at is null
    and l.is_active = true;

  if v_kind is null then
    raise exception 'That stock location is not available for this property'
      using errcode = 'PT404';
  end if;

  -- A receipt of an INACTIVE item is refused, unlike an adjustment: an adjustment
  -- of a discontinued line is how you write it down to zero, but BUYING MORE of
  -- something you have switched off is a mistake worth catching at the door.
  select i.tracks_expiry into v_tracks
  from inventory_items i
  where i.id = p_inventory_item_id
    and i.tenant_id = v_tenant
    and i.deleted_at is null
    and i.is_active = true;

  if v_tracks is null then
    raise exception 'That item is not available in this catalogue'
      using errcode = 'PT404',
            hint = 'An item that has been switched off cannot be received. Turn it back on first, or receive against the item you actually bought.';
  end if;

  if p_quantity is null or p_quantity <= 0 then
    raise exception 'A receipt must be a positive quantity — it is stock arriving.'
      using errcode = 'PT422',
            hint = 'To take stock OUT, post a write-off or an adjustment instead.';
  end if;

  -- THE ONE THING THAT WOULD SILENTLY CORRUPT THE AVERAGE. A stock-in with no
  -- cost cannot be valued, and 036's cost-direction constraint refuses it at the
  -- table — this exists so the person reads a sentence rather than a constraint
  -- name, and so the sentence says WHY.
  if p_unit_cost is null then
    raise exception 'A receipt must state what one % cost.',
      (select base_unit from inventory_items where id = p_inventory_item_id)
      using errcode = 'PT422',
            hint = 'It is what moves this item''s average cost, and every valuation and food-cost figure is built on it. It is on the delivery note or the invoice.';
  end if;

  if p_unit_cost < 0 then
    raise exception 'A unit cost cannot be negative' using errcode = 'PT422';
  end if;

  -- THE BATCH RULE (038 §1C), cross-table so it lives here rather than in a
  -- CHECK: the flag is on the item, the values are on the movement. A delivery of
  -- batch-tracked stock arrives with the code printed on the carton.
  v_batch := nullif(btrim(coalesce(p_batch_code, '')), '');
  if v_tracks and (v_batch is null or p_expiry_date is null) then
    raise exception
      'This item is tracked by batch, so its batch code and expiry date are both required.'
      using errcode = 'PT422',
            hint = 'They are on the packaging. Without them a recall cannot tell which stock came from which delivery.';
  end if;

  v_today := (now() at time zone coalesce(nullif(btrim(v_timezone), ''), 'Africa/Lagos'))::date;
  v_date  := coalesce(p_business_date, v_today);

  if v_date > v_today then
    raise exception 'A stock movement cannot be dated in the future (today is % at this property)', v_today
      using errcode = 'PT422';
  end if;

  -- The posting lock, after the future-date guard (038's ordering).
  perform assert_posting_open(p_property_id, v_date);

  -- ------------------------------------------------------------------------
  -- ONLY THE STORE RECEIVES
  -- ------------------------------------------------------------------------
  v_reason := nullif(btrim(coalesce(p_reason, '')), '');

  if v_kind <> 'store' then
    -- A PIN alone is not enough and a reason alone is not enough. The PIN says
    -- somebody with authority was standing there; the reason says what the
    -- exception was for. The report is worthless without the second.
    if p_manager_pin is null or v_reason is null then
      raise exception
        'Stock is received into a store, not into %. Goods reach a kitchen or a bar by being issued from the store.',
        v_locname
        using errcode = 'PT403',
              hint = 'If this delivery genuinely went straight there, a manager can authorise it with their PIN and a reason. It will be listed on the stock provenance report.';
    end if;

    v_manager := verify_manager_pin(v_tenant, p_manager_pin);
    if v_manager is null then
      raise exception 'Receiving stock somewhere other than a store requires a valid manager PIN'
        using errcode = 'insufficient_privilege',
              hint = 'Hand the terminal to a manager. The receipt is recorded against them by name, and appears on the stock provenance report.';
    end if;
  else
    -- A PIN offered where none is needed is REFUSED rather than ignored. Silently
    -- accepting it would record an authorisation against a manager for a movement
    -- that needed none — a name on a record they never approved.
    if p_manager_pin is not null then
      raise exception 'No manager PIN is needed to receive stock into %.', v_locname
        using errcode = 'PT422',
              hint = 'A PIN authorises a delivery going somewhere other than a store. This one is going to a store.';
    end if;
    v_manager := null;
    -- A reason is optional on an ordinary receipt and is kept if given.
  end if;

  begin
    insert into stock_movements (
      tenant_id, property_id, location_id, inventory_item_id,
      movement_type, quantity, unit_cost, business_date,
      reason, note, source, supplier, authorised_by,
      batch_code, expiry_date, idempotency_key, created_by
    ) values (
      v_tenant, p_property_id, p_location_id, p_inventory_item_id,
      'receipt', p_quantity, p_unit_cost, v_date,
      v_reason, nullif(btrim(coalesce(p_note, '')), ''), 'manual',
      nullif(btrim(coalesce(p_supplier, '')), ''), v_manager,
      v_batch, p_expiry_date, p_idempotency_key, auth.uid()
    )
    returning * into v_movement;
  exception
    when unique_violation then
      -- The partial unique index is the real idempotency guard (rule 3); the fast
      -- path above is the courtesy. Under concurrency both callers reach here and
      -- exactly one row exists.
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

comment on function post_stock_receipt(uuid, uuid, uuid, numeric, numeric, date, text, text, text, text, date, text, text) is
  'Posts a ''receipt'' — stock arriving from outside, and THE movement that '
  'recomputes the moving average (036 §2 values it; nothing about the fold '
  'changes). Quantity must be positive and a unit cost is REQUIRED: a stock-in '
  'with no cost is the one input that would silently corrupt every valuation. '
  'ONLY A LOCATION WITH kind = ''store'' MAY RECEIVE — goods reach a kitchen or '
  'bar by being issued from the store — with one permissioned exception: a valid '
  'manager PIN plus a mandatory reason posts it anyway and records the manager in '
  'authorised_by, where the provenance report (§4) lists it. The exception exists '
  'because without it staff fake a store receipt plus an instant requisition, '
  'which puts two fictional movements in the ledger instead of one true one. A '
  'PIN offered where none is needed is refused rather than ignored. Supplier is '
  'free text (stage 7 owns supplier records). Staff-gated, posting-lock checked, '
  'idempotent (rules 2/3), SECURITY DEFINER, pinned search_path.';


-- ############################################################################
-- SECTION 3 — post_stock_writeoff
-- ############################################################################
-- STOCK LOST, AND WHY. The 'wastage' type, which 036 reserved and pinned to a
-- negative quantity.
--
-- ----------------------------------------------------------------------------
-- A WRITE-OFF IS NOT AN ADJUSTMENT, AND THE DISTINCTION IS THE WHOLE POINT
-- ----------------------------------------------------------------------------
-- §9, in its own words: an adjustment means THE COUNT WAS WRONG. A write-off
-- means WE LOST IT, AND HERE IS WHY. Blur them and the variance report is
-- worthless — because variance is precisely the gap between what should have
-- gone and what did, and a loss recorded as a correction moves the wrong side of
-- that equation.
--
-- So the two are different movement types with different rules, and the category
-- is the thing that makes wastage reportable: five names the report groups on,
-- not five ways of typing "went bad".
--
-- ----------------------------------------------------------------------------
-- THE COST COMES FROM THE TRIGGER, NOT FROM THE CALLER
-- ----------------------------------------------------------------------------
-- A write-off states NO unit cost — 036's cost-direction constraint forbids one
-- on a stock-out, because leaving stock carries out the average that is already
-- there. 038's trigger stamps carried_unit_cost at the instant it leaves, and
-- THAT is what makes a write-off reportable in naira rather than in units. It is
-- read, never recomputed (§6, cost of sale).
create or replace function post_stock_writeoff(
  p_property_id       uuid,
  p_location_id       uuid,
  p_inventory_item_id uuid,
  p_quantity          numeric,   -- POSITIVE magnitude; the sign is this function's
  p_reason_code       text,      -- the category, mandatory
  p_business_date     date,
  p_note              text,
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
  v_code     text;
  v_label    text;
  v_unit     text;
  v_val      record;
  v_result   numeric;
  v_existing stock_movements;
  v_movement stock_movements;
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

  -- An INACTIVE item MAY be written off, matching post_stock_adjustment and
  -- unlike a receipt: a discontinued line that has gone bad on a shelf still has
  -- to be removable, and refusing would leave stock nobody can clear.
  select i.base_unit into v_unit
  from inventory_items i
  where i.id = p_inventory_item_id
    and i.tenant_id = v_tenant
    and i.deleted_at is null;

  if v_unit is null then
    raise exception 'That item is not available in this catalogue'
      using errcode = 'PT404';
  end if;

  -- THE MAGNITUDE IS POSITIVE AND THE SIGN IS OURS. A person writing off five
  -- kilos types 5, not -5: a minus typed into a box is one missed keystroke from
  -- ADDING five kilos of spoiled rice, and the mistake is invisible until a count
  -- months later. The same reasoning the adjustment form's direction toggle uses,
  -- pushed into the RPC because a write-off has only one direction.
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Enter how much was lost, as a number greater than zero.'
      using errcode = 'PT422',
            hint = 'A write-off always removes stock, so it is entered as a plain quantity — not as a negative number.';
  end if;

  -- THE CATEGORY. Validated here so the caller reads a sentence naming the five,
  -- rather than a constraint name; the CHECK in §1.1 is what actually holds.
  v_code := nullif(btrim(lower(coalesce(p_reason_code, ''))), '');
  if v_code is null then
    raise exception 'A write-off needs a reason category.'
      using errcode = 'PT422',
            hint = 'Spoilage, breakage, expiry, staff meal or complimentary. It is what makes wastage reportable — free text alone cannot be grouped.';
  end if;

  -- The label copied into `reason`. ONE place both the code and its wording are
  -- decided, so a new category cannot be added to the CHECK without being given
  -- words here.
  v_label := case v_code
               when 'spoilage'      then 'Spoilage'
               when 'breakage'      then 'Breakage'
               when 'expiry'        then 'Expired'
               when 'staff_meal'    then 'Staff meal'
               when 'complimentary' then 'Complimentary'
               else null
             end;

  if v_label is null then
    raise exception 'Unknown write-off reason "%".', p_reason_code
      using errcode = 'PT422',
            hint = 'Use one of: spoilage, breakage, expiry, staff_meal, complimentary.';
  end if;

  v_today := (now() at time zone coalesce(nullif(btrim(v_timezone), ''), 'Africa/Lagos'))::date;
  v_date  := coalesce(p_business_date, v_today);

  if v_date > v_today then
    raise exception 'A stock movement cannot be dated in the future (today is % at this property)', v_today
      using errcode = 'PT422';
  end if;

  perform assert_posting_open(p_property_id, v_date);

  -- THE NEGATIVE GUARD, identical in shape to post_stock_adjustment's: flag, do
  -- not forbid (rule 7 / §9 — blocking teaches staff to invent fake receipts,
  -- which destroys the ledger far more thoroughly than an honest negative). The
  -- resulting figure is IN the message so the person can compare it against the
  -- shelf in front of them.
  select * into v_val
  from stock_valuation(p_property_id, p_location_id, p_inventory_item_id);

  v_result := coalesce(v_val.quantity_on_hand, 0) - p_quantity;
  if v_result < 0 and not coalesce(p_allow_negative, false) then
    raise exception
      'Writing off % % would leave % % on hand, which is less than nothing. Check the quantity — or confirm to record it anyway.',
      rtrim(rtrim(trim(to_char(p_quantity, 'FM999999999990.0000')), '0'), '.'), v_unit,
      rtrim(rtrim(trim(to_char(v_result, 'FM999999999990.0000')), '0'), '.'), v_unit
      using errcode = 'PT449',
            hint = 'A negative on-hand means stock left without a movement behind it. It is recorded rather than blocked, so the discrepancy stays visible.';
  end if;

  begin
    insert into stock_movements (
      tenant_id, property_id, location_id, inventory_item_id,
      movement_type, quantity, unit_cost, business_date,
      reason, reason_code, note, source, idempotency_key, created_by
    ) values (
      v_tenant, p_property_id, p_location_id, p_inventory_item_id,
      -- NEGATIVE, from a positive magnitude. 036's type-direction check pins
      -- wastage to quantity < 0, so this is the only shape the table accepts.
      'wastage', -p_quantity,
      -- NO UNIT COST. Stock leaving carries out the average already there, and
      -- 038's trigger stamps carried_unit_cost with what it actually cost — which
      -- is what makes this reportable in naira.
      null, v_date,
      v_label, v_code, nullif(btrim(coalesce(p_note, '')), ''), 'manual',
      p_idempotency_key, auth.uid()
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

comment on function post_stock_writeoff(uuid, uuid, uuid, numeric, text, date, text, text, boolean) is
  'Posts a ''wastage'' movement — stock LOST, with the reason as a category '
  '(spoilage/breakage/expiry/staff_meal/complimentary). NOT an adjustment, and '
  'the distinction is the point (§9): an adjustment means the count was wrong, a '
  'write-off means we lost it and here is why, and blurring them makes the '
  'variance report meaningless. Quantity is entered as a POSITIVE magnitude and '
  'negated here, so a missed minus sign cannot add spoiled stock. States NO unit '
  'cost — 038''s trigger stamps carried_unit_cost at the instant it leaves, which '
  'is what makes wastage reportable in naira rather than in units, and it is READ '
  'never recomputed (§6). A write-off that would leave less than nothing raises '
  'PT449 and must be re-submitted with p_allow_negative and the SAME key. '
  'Staff-gated, posting-lock checked, idempotent, SECURITY DEFINER.';


-- ############################################################################
-- SECTION 4 — the provenance views
-- ############################################################################
-- "Things that did not come through the front door." Two views here; the third
-- part of the report JOINS stock_negative_positions (038 §9) rather than
-- rebuilding it, because a second implementation of "what is negative" would
-- drift from the first and the two screens would disagree.
--
-- FRAMED AS QUESTIONS, NOT ACCUSATIONS. Every row here has an innocent
-- explanation and most of them are innocent. A direct receipt is usually a real
-- delivery that really did go straight to the bar. A late opening balance is
-- usually somebody adding an item they forgot. The report's job is to make them
-- ASKABLE, not to allege anything — which is why the views carry the actor, the
-- reason and the dates, so the answer is usually visible without asking anyone.

-- ----------------------------------------------------------------------------
-- 4.1 stock_direct_receipts — stock that arrived somewhere other than a store
-- ----------------------------------------------------------------------------
create or replace view stock_direct_receipts
with (security_invoker = on) as
select
  m.id,
  m.tenant_id,
  m.property_id,
  m.location_id,
  m.inventory_item_id,
  m.business_date,
  m.created_at,
  m.quantity,
  m.unit_cost,
  round(m.quantity * m.unit_cost, 2)::numeric(14,2) as receipt_value,
  m.supplier,
  m.reason,
  m.note,
  m.created_by,
  m.authorised_by,
  i.name        as item_name,
  i.code        as item_code,
  i.base_unit,
  l.name        as location_name,
  l.kind        as location_kind
from stock_movements m
join inventory_items i
  on i.id = m.inventory_item_id
 and i.tenant_id = m.tenant_id
join locations l
  on l.id = m.location_id
 and l.property_id = m.property_id
where m.movement_type = 'receipt'
  -- The DEFINITION of a direct receipt: it went somewhere that is not a store.
  -- Read from the location's kind rather than from authorised_by, so a receipt
  -- into a location that was a store at the time and has since been converted to
  -- a bar still reads correctly today — the question is "where is this stock",
  -- and the location's kind is the current answer.
  and l.kind <> 'store';

comment on view stock_direct_receipts is
  'Receipts that went somewhere other than a store — the permissioned exception '
  'to "only the store receives" (043 §2), with the manager who authorised each '
  'one and the reason they gave. NOT an error list: a real delivery straight to '
  'the bar is a legitimate thing that happened, and the report exists so the '
  'owner can SEE them rather than so anybody is accused. Filtered on the '
  'location''s kind rather than on authorised_by, so the row still reads '
  'correctly if a location was later converted.';

-- ----------------------------------------------------------------------------
-- 4.2 stock_late_openings — an opening balance in a location already in use
-- ----------------------------------------------------------------------------
-- AN OPENING BALANCE IS A DAY-ONE DECLARATION: "this is what was here when we
-- started". Posted on day one it is the honest beginning of the ledger. Posted
-- into a location that has been trading for six months it is stock appearing
-- from nowhere with no purchase behind it — which is worth a question.
--
-- THE DEFINITION, AND WHY IT NEEDS NO CONFIGURATION. There is no go-live date in
-- this schema and adding one for a single report would be a setting somebody has
-- to maintain forever, and would be wrong the first time it was not updated. So:
--
--   an opening posted LATER than the earliest NON-OPENING movement in the SAME
--   LOCATION.
--
-- A genuine day-one load has nothing earlier to be later than, so it never fires
-- on the honest case — including the bulk spreadsheet import, which posts many
-- openings and nothing else.
--
-- ----------------------------------------------------------------------------
-- "LATER" IS `seq`, NOT `created_at`, AND THE FIRST VERSION OF THIS GOT IT WRONG
-- ----------------------------------------------------------------------------
-- The obvious reading of "posted later" is created_at, and it is broken for a
-- reason 036 already wrote down about `seq`:
--
--     now() is the TRANSACTION's start time in Postgres, so every row written in
--     one transaction carries an IDENTICAL created_at.
--
-- So `m.created_at > first_use.created_at` is false for any two movements posted
-- together, and the view silently finds nothing. The dry run caught it: the
-- fixture posted a receipt and then a late opening, the opening was plainly late,
-- and the view returned no rows because both timestamps were equal to the
-- microsecond.
--
-- `seq` is the column 036 created for exactly this problem — a table-wide
-- identity, monotonic in real insertion order WITHIN and ACROSS transactions,
-- never reused. It is the same total order the valuation fold walks in, it is
-- stamped by the database, and `generated always` means no client can set it.
--
-- IT IS ALSO STILL NOT business_date, which was the other half of the original
-- reasoning and survives unchanged: business_date is what the person TYPED and
-- can be back-dated to anything, so comparing it would let a back-dated movement
-- mask a late opening — which is exactly what somebody covering their tracks
-- would do, and the one case this view exists to catch. The fixture proves that
-- too: the late opening is dated EARLIER than the receipt it follows and is
-- still flagged.
create or replace view stock_late_openings
with (security_invoker = on) as
select
  m.id,
  m.tenant_id,
  m.property_id,
  m.location_id,
  m.inventory_item_id,
  m.business_date,
  m.created_at,
  m.quantity,
  m.unit_cost,
  round(m.quantity * m.unit_cost, 2)::numeric(14,2) as opening_value,
  m.note,
  m.created_by,
  first_use.first_movement_at,
  first_use.first_movement_date,
  first_use.first_movement_type,
  i.name  as item_name,
  i.code  as item_code,
  i.base_unit,
  l.name  as location_name,
  l.kind  as location_kind
from stock_movements m
join lateral (
  -- The FIRST non-opening movement in this LOCATION — the moment the location
  -- demonstrably started being used. Ordered by seq, the same total order the
  -- valuation fold walks in. Correlated per opening row, which is cheap: openings
  -- are one per item per location by construction (036's unique index), so this
  -- runs once per opening and not once per movement.
  select e.seq          as first_movement_seq,
         e.created_at   as first_movement_at,
         e.business_date as first_movement_date,
         e.movement_type as first_movement_type
  from stock_movements e
  where e.location_id = m.location_id
    and e.movement_type <> 'opening'
  order by e.seq
  limit 1
) first_use on true
join inventory_items i
  on i.id = m.inventory_item_id
 and i.tenant_id = m.tenant_id
join locations l
  on l.id = m.location_id
 and l.property_id = m.property_id
where m.movement_type = 'opening'
  and m.seq > first_use.first_movement_seq;

comment on view stock_late_openings is
  'Opening balances declared in a location that was ALREADY IN USE — an opening '
  'whose created_at is later than the earliest non-opening movement in the same '
  'location. Needs no go-live date and no configuration: a genuine day-one load '
  'has no earlier movement to be later than, so it never fires on the honest '
  'case (including the bulk import, which posts openings and nothing else). BOTH '
  'sides are created_at rather than business_date, because created_at is stamped '
  'by the database and business_date is typed by the user — comparing the two '
  'would let a back-dated movement mask exactly the case this exists to catch.';


-- ############################################################################
-- SECTION 5 — grants, and the anon assertion
-- ############################################################################
-- Neither RPC is for anon. Both are staff-gated internally — that is the real
-- boundary — and these grants are the belt-and-braces layer, matching every
-- other posting function in the module.
revoke all     on function post_stock_receipt(uuid, uuid, uuid, numeric, numeric, date, text, text, text, text, date, text, text) from public;
revoke execute on function post_stock_receipt(uuid, uuid, uuid, numeric, numeric, date, text, text, text, text, date, text, text) from anon;
grant  execute on function post_stock_receipt(uuid, uuid, uuid, numeric, numeric, date, text, text, text, text, date, text, text) to authenticated;

revoke all     on function post_stock_writeoff(uuid, uuid, uuid, numeric, text, date, text, text, boolean) from public;
revoke execute on function post_stock_writeoff(uuid, uuid, uuid, numeric, text, date, text, text, boolean) from anon;
grant  execute on function post_stock_writeoff(uuid, uuid, uuid, numeric, text, date, text, text, boolean) to authenticated;

-- THE ASSERTION, NOT A COPIED ARRAY. 041 §3 built assert_no_anon_security_definer
-- precisely so a migration adding SECURITY DEFINER functions proves it leaked
-- nothing, rather than restating a list that goes stale. It raises if anon holds
-- EXECUTE on any SECURITY DEFINER function outside the two documented exemptions,
-- and it also complains if the quarantine list has entries that are no longer
-- leaking — so it fails in both directions and cannot rot quietly.
do $$
begin
  perform assert_no_anon_security_definer();
end $$;

-- ============================================================================
-- End of 043_receipts_and_writeoffs.sql
-- ============================================================================
