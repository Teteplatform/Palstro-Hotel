-- 050 — A MOVEMENT WE CANNOT VALUE ASKS BEFORE IT POSTS (shipment 1.1g2)
--
-- THE GAP, FOUND WHILE FIXING 047's 3b DEFECT AND MEASURED BY 048.
--
-- Two guards sit in front of a stock-out and they ask different questions:
--
--   post_stock_writeoff's negative guard asks  WHAT IS ON HAND TODAY.
--   038's carried_unit_cost asks               WHAT THE AVERAGE WAS AS AT
--                                              THIS MOVEMENT'S DATE.
--
-- Nothing asks the second one out loud, and the gap between them is reachable
-- by an ordinary act. Write off 4 kg dated 1 October against a position holding
-- 10 kg received on 5 October: on-hand-today is 10, the result is 6, the
-- negative guard does not fire — and the average as at 1 October is undefined,
-- so stock_average_cost_as_at returns NULL, the trigger stamps NULL, and the
-- movement leaves the shelf carrying no cost at all. Nothing warns anybody.
--
-- Writing off from an EMPTY shelf is already gated, because the result goes
-- below zero and PT449 catches it. The BACK-DATED case sails straight through.
--
-- WHAT IT COSTS, AND IT IS NOT NOTHING. 048 measured this at -4,000.00 on a
-- fixture: the quantity leaves the valuation (stock_value is quantity times an
-- average, and the quantity moved) while no value leaves the ledger, and the
-- difference sits in the unvaluable bucket on the reconciliation card for ever,
-- or until somebody records what the stock cost.
--
-- ----------------------------------------------------------------------------
-- NOT A REFUSAL, AND THAT IS THE WHOLE DESIGN
-- ----------------------------------------------------------------------------
-- §9 holds: negative stock is flagged, never blocked, because blocking an
-- issue stops service and teaches staff to invent fake receipts, which destroys
-- the ledger far more thoroughly than an honest gap. A write-off is a storekeeper
-- ADMITTING A LOSS. Refuse the admission and you get either an invisible loss or
-- fabricated purchase data, in the system built to catch theft.
--
-- So this is an overridable confirm-gate in exactly the shape of
-- p_allow_negative: the storekeeper can always record the loss, and what changes
-- is that doing so becomes deliberate rather than silent.
--
-- IT FIRES ON "NO BASIS AT ALL", NEVER ON A BASIS OF ZERO. stock_average_cost_as_at
-- returns NULL, never 0, when there is no prior history; a genuine average of
-- zero is a VALUE and the movement carries it. The test is IS NULL and nothing
-- else, which is why a position whose history averages to nothing still posts
-- without a question.
--
-- ----------------------------------------------------------------------------
-- WHY THE GATE AND THE TRIGGER CANNOT DISAGREE
-- ----------------------------------------------------------------------------
-- The gate must predict what 038's trigger will stamp, and it does it by calling
-- THE SAME FUNCTION rather than by reimplementing the fold — which is the
-- difference between a gate and a second opinion.
--
-- The trigger passes the row's own seq; the gate has no seq yet, so it passes
-- NULL, which that function documents as "after everything". Those two agree
-- exactly, and the reason is worth stating: the predicate is
-- (business_date, seq) < (p_date, coalesce(p_seq, max_bigint)), so they can
-- differ only over rows on the SAME business_date with a seq GREATER than the
-- new row's. seq is a table-wide identity, so at the moment of insert the new
-- row's seq is larger than every seq in the table and no such row can exist.
--
-- ----------------------------------------------------------------------------
-- BOTH GATES CAN APPLY TO ONE MOVEMENT, AND THEY ASK DIFFERENT THINGS
-- ----------------------------------------------------------------------------
-- A back-dated write-off that ALSO drives on-hand below zero trips PT449 first
-- and PT450 on the re-submission: two questions, two confirmations, in that
-- order. That is clunky and it is honest — "this leaves less than nothing" and
-- "we do not know what this cost" are not the same warning, and merging them
-- into one sentence would make the second invisible on the day only it applies.
--
-- ----------------------------------------------------------------------------
-- WHAT IS DELIBERATELY NOT GATED, SO NOBODY "COMPLETES" THIS LATER
-- ----------------------------------------------------------------------------
-- finish_stock_take IS NOT GATED AND MUST NOT BE. A count adjustment downward on
-- a position with no cost history hits exactly the same case, and refusing it at
-- the end of a count somebody has spent an hour walking is brutal — and worse,
-- it teaches people to fudge the count so it finishes, which destroys the one
-- number the count exists to produce.
--
-- A count is ALREADY a deliberate act with a variance threshold and a manager's
-- PIN in front of it. The acknowledgement this gate asks for has already been
-- given, twice, by the time the movements post.
--
-- Unvaluable movements from a stock take stay allowed, and 048's bucket is what
-- surfaces them — by VALUE, on the reconciliation card, which is where somebody
-- looking for them will be. The architecture already enforces this: finish_stock_take
-- inserts its movements DIRECTLY rather than calling post_stock_adjustment, so it
-- cannot pick the gate up by accident. Section 3's self-verify asserts that it
-- has not picked it up on purpose either.
--
-- NO NEW COLUMN RECORDS THE ACKNOWLEDGEMENT, and that is also deliberate.
-- carried_unit_cost being NULL IS the record, and 048's bucket already reports
-- it by value. A second record of one fact is a second thing to keep in step,
-- and the day they disagree there is no way to tell which is right.
--
-- ----------------------------------------------------------------------------
-- IT ASKS ONCE PER POSITION PER DATE, NOT ONCE PER MOVEMENT — MEASURED
-- ----------------------------------------------------------------------------
-- Found by this file's own fixture failing, and worth stating because it is
-- surprising and it is NOT a bug in the gate:
--
--   write off 4 kg dated 1 Oct, no prior history   -> asks; confirmed, the
--                                                     movement carries NULL
--   write off 2 kg dated 1 Oct, immediately after  -> does NOT ask
--
-- Measured: after the first, stock_average_cost_as_at for a later movement on
-- THE SAME DATE returns 0.0000 rather than NULL, because the fold now has a row
-- to walk — a quantity that left carrying nothing. One day earlier it is still
-- NULL. The gate matches the trigger exactly, which is the property it was built
-- for: the second movement genuinely WILL carry a basis of zero, and a basis of
-- zero is a value, not an absence.
--
-- THE CONSEQUENCE IS WORTH KNOWING. The second movement's carried_unit_cost is
-- 0, not NULL, so 048's unvaluable bucket does not count it — its effect lands
-- in valuation_difference instead. The first movement of a bad position is the
-- one that gets the question and the bucket; the rest of that day inherits the
-- acknowledgement the storekeeper already gave for that position.
--
-- That is defensible and it is not obviously ideal. It is recorded here rather
-- than quietly fixed, because "every unvaluable movement asks" would mean the
-- gate and the trigger disagreeing about what a basis is, which is the one
-- property this design will not trade away.

-- ----------------------------------------------------------------------------
-- THIS FILE WAS EDITED AFTER IT HAD BEEN APPLIED, ONCE, DELIBERATELY
-- ----------------------------------------------------------------------------
-- Normally forbidden. It was allowed here because all three of these held at the
-- same time, and the rule is that it is allowed ONLY while all three do:
--
--   1. MINUTES had passed, inside the session that applied it.
--   2. Exactly ONE database exists.
--   3. The file is IDEMPOTENT -- create or replace, drop if exists, and a
--      fixture that rolls itself back -- and it was re-run and re-verified
--      rather than assumed.
--
-- What was corrected: an ASCII pass had turned em dashes into double hyphens in
-- six storekeeper-facing sentences, four of them copied from 046 where they had
-- been live and correct for weeks. Then the pass itself was undone, once the
-- encoding question behind it was measured -- see scripts/ops/backup.mjs.
--
-- ONCE ANY ONE OF THE THREE STOPS HOLDING, THIS FILE IS HISTORY. A second
-- environment, a later session, or anything applied on top, and the correction
-- goes in the next migration instead -- because the CLI skips a file it has
-- already recorded, so the repo and the database would disagree in silence. That
-- is 040's rule and it does not bend for a cosmetic change.

-- ############################################################################
-- SECTION 1 — post_stock_writeoff
-- ############################################################################
-- DROPPED AND RECREATED rather than replaced, because the argument list grows:
-- `create or replace` with an extra defaulted parameter makes a second overload
-- and every existing call becomes ambiguous. Section 4 re-issues the grants the
-- drop takes with it.
drop function if exists post_stock_writeoff(uuid, uuid, uuid, numeric, text, date, text, text, boolean);

create or replace function post_stock_writeoff(
  p_property_id       uuid,
  p_location_id       uuid,
  p_inventory_item_id uuid,
  p_quantity          numeric,
  p_reason_code       text,
  p_business_date     date,
  p_note              text,
  p_idempotency_key   text,
  p_allow_negative    boolean default false,
  -- 050: the SECOND overridable gate, in the same shape as the first.
  p_allow_unvalued    boolean default false
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
  v_basis    numeric;
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

  select i.base_unit into v_unit
  from inventory_items i
  where i.id = p_inventory_item_id
    and i.tenant_id = v_tenant
    and i.deleted_at is null;

  if v_unit is null then
    raise exception 'That item is not available in this catalogue'
      using errcode = 'PT404';
  end if;

  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Enter how much was lost, as a number greater than zero.'
      using errcode = 'PT422',
            hint = 'A write-off always removes stock, so it is entered as a plain quantity — not as a negative number.';
  end if;

  v_code := nullif(btrim(lower(coalesce(p_reason_code, ''))), '');
  if v_code is null then
    raise exception 'A write-off needs a reason category.'
      using errcode = 'PT422',
            hint = 'Spoilage, breakage, expiry, staff meal or complimentary. It is what makes wastage reportable — free text alone cannot be grouped.';
  end if;

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

  -- 050: THE COST BASIS, asked out loud. Same function the trigger will use,
  -- with the NULL seq that means "after everything" — see the header for why
  -- the two cannot disagree.
  if not coalesce(p_allow_unvalued, false) then
    v_basis := stock_average_cost_as_at(
      p_location_id, p_inventory_item_id, v_date, null
    );
    if v_basis is null then
      raise exception
        'There is no cost history for this item in this location as at %, so this write-off would remove stock without removing any value.',
        to_char(v_date, 'DD Mon YYYY')
        using errcode = 'PT450',
              hint = 'Record the opening balance first, or date the write-off on or after the first receipt — or confirm to write it off unvalued, and the difference will show on the stock-against-ledger check until the cost is recorded.';
    end if;
  end if;

  begin
    insert into stock_movements (
      tenant_id, property_id, location_id, inventory_item_id,
      movement_type, quantity, unit_cost, business_date,
      reason, reason_code, note, source, idempotency_key, created_by
    ) values (
      v_tenant, p_property_id, p_location_id, p_inventory_item_id,
      'wastage', -p_quantity,
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

  -- 046: THE LEDGER. Debits the wastage key for THIS reason code.
  perform post_stock_movement_journal(v_movement.id);

  return v_movement;
end;
$$;

comment on function post_stock_writeoff(uuid, uuid, uuid, numeric, text, date, text, text, boolean, boolean) is
  'Posts a ''wastage'' movement — stock LOST, with the reason as a category '
  '(spoilage/breakage/expiry/staff_meal/complimentary). Quantity is entered as a '
  'POSITIVE magnitude and negated here. States NO unit cost — 038''s trigger '
  'stamps carried_unit_cost at the instant it leaves. TWO overridable gates, '
  'asking different questions: PT449 is what is on hand TODAY, PT450 (050) is '
  'whether there is any cost basis AS AT the movement''s date. Both are '
  'confirmations, never refusals, because a write-off is a storekeeper admitting '
  'a loss and refusing the admission produces an invisible loss or invented '
  'purchase data. Staff-gated, posting-lock checked, idempotent.';


-- ############################################################################
-- SECTION 2 — post_stock_adjustment
-- ############################################################################
-- THE IDENTICAL GAP. A negative adjustment states no cost and leaves at the
-- average already there, so a back-dated one against a position with no prior
-- history is unvaluable in exactly the same way. A POSITIVE adjustment states
-- its own cost and is untouched by this.
drop function if exists post_stock_adjustment(uuid, uuid, uuid, numeric, text, date, numeric, text, boolean, text, date);

create or replace function post_stock_adjustment(
  p_property_id       uuid,
  p_location_id       uuid,
  p_inventory_item_id uuid,
  p_quantity          numeric,
  p_reason            text,
  p_business_date     date,
  p_unit_cost         numeric,
  p_idempotency_key   text,
  p_allow_negative    boolean default false,
  p_batch_code        text default null,
  p_expiry_date       date default null,
  p_allow_unvalued    boolean default false
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
  v_batch    text;
  v_tracks   boolean;
  v_existing stock_movements;
  v_movement stock_movements;
  v_val      record;
  v_cost     numeric;
  v_basis    numeric;
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

  select i.base_unit, i.tracks_expiry into v_unit, v_tracks
  from inventory_items i
  where i.id = p_inventory_item_id
    and i.tenant_id = v_tenant
    and i.deleted_at is null;

  if v_unit is null then
    raise exception 'That item is not available in this catalogue'
      using errcode = 'PT404';
  end if;

  if p_quantity is null or p_quantity = 0 then
    raise exception 'An adjustment needs a quantity that is not zero.'
      using errcode = 'PT422';
  end if;

  v_reason := nullif(btrim(coalesce(p_reason, '')), '');
  if v_reason is null then
    raise exception 'An adjustment needs a reason.'
      using errcode = 'PT422',
            hint = 'It moves stock with no purchase and no sale behind it, so the reason and your name stay against it permanently.';
  end if;

  v_today := (now() at time zone coalesce(nullif(btrim(v_timezone), ''), 'Africa/Lagos'))::date;
  v_date  := coalesce(p_business_date, v_today);

  if v_date > v_today then
    raise exception 'A stock movement cannot be dated in the future (today is % at this property)', v_today
      using errcode = 'PT422';
  end if;

  perform assert_posting_open(p_property_id, v_date);

  select * into v_val
  from stock_valuation(p_property_id, p_location_id, p_inventory_item_id);

  v_batch := nullif(btrim(coalesce(p_batch_code, '')), '');

  if p_quantity > 0 then
    v_cost := coalesce(p_unit_cost, v_val.moving_average_cost);
    if v_cost is null or v_cost < 0 then
      raise exception 'Adding stock needs a unit cost, because there is nothing to average it against yet.'
        using errcode = 'PT422',
              hint = 'Enter what one % cost. It is what the valuation and the books will carry.';
    end if;

    if v_tracks and (v_batch is null or p_expiry_date is null) then
      raise exception
        'This item is tracked by batch, so adding stock requires its batch code and expiry date.'
        using errcode = 'PT422',
              hint = 'They are on the packaging. Without them a recall cannot tell which stock came from which delivery.';
    end if;
  else
    if p_unit_cost is not null then
      raise exception 'A unit cost cannot be given when removing stock — stock leaves at its current average cost.'
        using errcode = 'PT422';
    end if;
    v_cost := null;

    if v_batch is not null or p_expiry_date is not null then
      raise exception
        'A batch code cannot be given when removing stock — which batch left is decided by the issue rules, not typed in here.'
        using errcode = 'PT422';
    end if;
  end if;

  v_result := coalesce(v_val.quantity_on_hand, 0) + p_quantity;
  if v_result < 0 and not coalesce(p_allow_negative, false) then
    raise exception
      'This adjustment would leave % % on hand, which is less than nothing. Check the quantity — or confirm to record it anyway.',
      format_stock_quantity(v_result), v_unit
      using errcode = 'PT449';
  end if;

  -- 050: ONLY ON THE WAY OUT. A positive adjustment states its own cost above
  -- and has a basis by construction.
  if p_quantity < 0 and not coalesce(p_allow_unvalued, false) then
    v_basis := stock_average_cost_as_at(
      p_location_id, p_inventory_item_id, v_date, null
    );
    if v_basis is null then
      raise exception
        'There is no cost history for this item in this location as at %, so this adjustment would remove stock without removing any value.',
        to_char(v_date, 'DD Mon YYYY')
        using errcode = 'PT450',
              hint = 'Record the opening balance first, or date the adjustment on or after the first receipt — or confirm to record it unvalued, and the difference will show on the stock-against-ledger check until the cost is recorded.';
    end if;
  end if;

  begin
    insert into stock_movements (
      tenant_id, property_id, location_id, inventory_item_id,
      movement_type, quantity, unit_cost, business_date,
      reason, note, source, batch_code, expiry_date,
      idempotency_key, created_by
    ) values (
      v_tenant, p_property_id, p_location_id, p_inventory_item_id,
      'adjustment', p_quantity, v_cost, v_date,
      v_reason, null, 'manual', v_batch, p_expiry_date,
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

  -- 046: THE LEDGER.
  perform post_stock_movement_journal(v_movement.id);

  return v_movement;
end;
$$;

comment on function post_stock_adjustment(uuid, uuid, uuid, numeric, text, date, numeric, text, boolean, text, date, boolean) is
  'Posts an ''adjustment'' movement — a correction with no purchase or sale '
  'behind it, which is why a REASON is mandatory. Signed quantity: + adds, '
  '- removes. TWO overridable gates on the way out, asking different questions: '
  'PT449 is what is on hand TODAY, PT450 (050) is whether there is any cost basis '
  'AS AT the movement''s date. A POSITIVE adjustment states its own cost and '
  'trips neither. 046 POSTS it against stock_adjustment, either side, which is '
  'deliberately NOT a wastage account. Staff-gated, idempotent, SECURITY DEFINER.';


-- ############################################################################
-- SECTION 3 — SELF-VERIFY
-- ############################################################################
-- Five assertions, each written to a defect that turns it red. The whole block
-- runs in a subtransaction aborted by a sentinel, so nothing survives:
-- stock_movements is append-only (038) and refuses deletion by name.
--
-- NAME THE DEFECT EACH ONE TURNS RED:
--
--   A  back-dated write-off, no prior receipt  -> PT450
--      RED if the gate is removed, or if it tests the basis for = 0 rather than
--      IS NULL.
--
--   B  the same call with p_allow_unvalued     -> posts, carried_unit_cost NULL,
--                                                 and 048's bucket NAMES it
--      RED if the override does not work, and red if the bucket stops reporting
--      it. Same fixture as A on purpose: the question and its consequence are
--      one story, so they are one test.
--
--   C  an ORDINARY write-off, cost history present -> posts, NO question
--      RED if the gate fires on everything. ON DIFFERENT NUMBERS FROM A — a
--      different item, a different quantity, a different cost — because a
--      fixture where the gated and ungated cases share their figures cannot
--      tell which one it is testing (rule 27).
--
--   D  the same pair for post_stock_adjustment
--      RED if the gate was added to the write-off and forgotten on the
--      adjustment, which is the likeliest way for this shipment to be half done.
--
--   E  finish_stock_take has NOT acquired the gate
--      RED the day somebody "completes" it by adding PT450 there. A SOURCE
--      assertion, deliberately: the claim is that a function is not gated, and
--      running it needs a manager PIN that a migration cannot mint. Asserting on
--      pg_get_functiondef tests the live catalog rather than a copy of it, and
--      it fails for exactly the change the header argues against.
do $$
declare
  v_tenant   uuid;
  v_property uuid;
  v_location uuid;
  v_item_a   uuid;
  v_item_c   uuid;
  v_item_d   uuid;
  v_fail     text := '';
  v_code     text;
  v_mv       stock_movements;
  v_recon    record;
  v_src      text;
  v_date     date := current_date;
  v_actor    uuid;
begin
  begin
    select t.id into v_tenant from tenants t limit 1;
    select p.id into v_property from properties p where p.tenant_id = v_tenant limit 1;

    -- THE FIXTURE CALLS THE REAL RPCs, which are staff-gated — so it has to be
    -- a member of staff. auth.uid() reads request.jwt.claim.sub, and a migration
    -- runs as postgres with no session, so an active tenant_users row is
    -- borrowed for the length of this subtransaction and rolled back with
    -- everything else. Calling the functions rather than reimplementing their
    -- guards is the whole point: a gate proved against a copy of itself proves
    -- the copy (rule 27).
    select tu.user_id into v_actor
    from tenant_users tu
    where tu.tenant_id = v_tenant and tu.is_active = true
    limit 1;

    if v_tenant is null or v_property is null or v_actor is null then
      raise notice '050 self-verify SKIPPED: no tenant, property or active staff member to build a fixture from.';
      return;
    end if;

    perform set_config('request.jwt.claim.sub', v_actor::text, true);

    -- A THROWAWAY LOCATION, so the fixture's positions have no history of their
    -- own and the live data is untouched by the assertions.
    insert into locations (tenant_id, property_id, name, kind, is_active)
    values (v_tenant, v_property, 'ZZ050 fixture store', 'store', true)
    returning id into v_location;

    insert into inventory_items (tenant_id, name, item_type, base_unit, is_active)
    values (v_tenant, 'ZZ050 item A', 'raw', 'kg', true)
    returning id into v_item_a;

    insert into inventory_items (tenant_id, name, item_type, base_unit, is_active)
    values (v_tenant, 'ZZ050 item C', 'raw', 'litre', true)
    returning id into v_item_c;

    -- ITEM D GETS ITS OWN POSITION, and the first draft of this fixture did not
    -- give it one — which is how the behaviour in the header's last section was
    -- found. Reusing item A put B's confirmed write-off, dated the same day, in
    -- front of D's adjustment; the fold then returns an average of ZERO rather
    -- than NULL, the gate correctly stays quiet, and the assertion failed
    -- against a gate that was working. A fixture that shares a position between
    -- the gated and ungated cases cannot tell which one it is testing.
    insert into inventory_items (tenant_id, name, item_type, base_unit, is_active)
    values (v_tenant, 'ZZ050 item D', 'raw', 'piece', true)
    returning id into v_item_d;

    -- ------------------------------------------------------------------
    -- A — no cost history as at the date: the gate asks.
    -- ------------------------------------------------------------------
    -- Stock arrives TODAY, and the write-off is dated five days ago. On-hand
    -- today is 10 so the NEGATIVE guard does not fire; the average as at the
    -- write-off's date is undefined, so PT450 must.
    perform post_stock_receipt(
      v_property, v_location, v_item_a, 10, 1000, v_date, 'ZZ050 receipt', null, null
    );

    begin
      perform post_stock_writeoff(
        v_property, v_location, v_item_a, 4, 'spoilage',
        v_date - 5, 'ZZ050 A', 'zz050-a'
      );
      v_fail := v_fail || 'A: a back-dated write-off with no basis posted without asking. ';
    exception
      when others then
        get stacked diagnostics v_code = returned_sqlstate;
        if v_code <> 'PT450' then
          v_fail := v_fail || format('A: expected PT450, got %s. ', v_code);
        end if;
    end;

    -- ------------------------------------------------------------------
    -- B — confirmed, it posts, and 048's bucket names it.
    -- ------------------------------------------------------------------
    select * into v_mv from post_stock_writeoff(
      v_property, v_location, v_item_a, 4, 'spoilage',
      v_date - 5, 'ZZ050 B', 'zz050-b', false, true
    );

    if v_mv.id is null then
      v_fail := v_fail || 'B: the confirmed write-off did not post. ';
    elsif v_mv.carried_unit_cost is not null then
      v_fail := v_fail || format(
        'B: expected no cost basis, got %s. ', v_mv.carried_unit_cost);
    end if;

    select * into v_recon from inventory_gl_reconciliation(v_property);
    if coalesce(v_recon.unvaluable_movement_count, 0) < 1 then
      v_fail := v_fail || 'B: 048''s bucket did not count the unvaluable movement. ';
    end if;
    -- THE VALUE, not just the count — 048 exists because a count was all the
    -- card showed. 4 kg at the position's average of 1,000.
    if coalesce(v_recon.unvaluable_value, 0) = 0 then
      v_fail := v_fail || 'B: 048''s bucket reported no VALUE for it. ';
    end if;

    -- ------------------------------------------------------------------
    -- C — an ordinary write-off is untouched, on different numbers.
    -- ------------------------------------------------------------------
    -- Item C, 7 litres at 250, written off 3 litres dated TODAY — every figure
    -- different from A's, so a gate that fires on everything cannot pass this
    -- by coincidence.
    perform post_stock_receipt(
      v_property, v_location, v_item_c, 7, 250, v_date - 9, 'ZZ050 receipt C', null, null
    );

    select * into v_mv from post_stock_writeoff(
      v_property, v_location, v_item_c, 3, 'breakage',
      v_date, 'ZZ050 C', 'zz050-c'
    );

    if v_mv.id is null then
      v_fail := v_fail || 'C: an ordinary write-off was refused. ';
    elsif v_mv.carried_unit_cost is null then
      v_fail := v_fail || 'C: an ordinary write-off carried no cost. ';
    elsif round(v_mv.carried_unit_cost, 2) <> 250.00 then
      v_fail := v_fail || format(
        'C: expected a basis of 250.00, got %s. ', round(v_mv.carried_unit_cost, 2));
    end if;

    -- ------------------------------------------------------------------
    -- D — the same pair for post_stock_adjustment.
    -- ------------------------------------------------------------------
    perform post_stock_receipt(
      v_property, v_location, v_item_d, 6, 400, v_date, 'ZZ050 receipt D', null, null
    );

    begin
      perform post_stock_adjustment(
        v_property, v_location, v_item_d, -2, 'ZZ050 D asks',
        v_date - 5, null, 'zz050-d1'
      );
      v_fail := v_fail || 'D: a back-dated adjustment with no basis posted without asking. ';
    exception
      when others then
        get stacked diagnostics v_code = returned_sqlstate;
        if v_code <> 'PT450' then
          v_fail := v_fail || format('D: expected PT450, got %s. ', v_code);
        end if;
    end;

    select * into v_mv from post_stock_adjustment(
      v_property, v_location, v_item_d, -2, 'ZZ050 D confirms',
      v_date - 5, null, 'zz050-d2', false, null, null, true
    );
    if v_mv.id is null then
      v_fail := v_fail || 'D: the confirmed adjustment did not post. ';
    end if;

    -- And an ORDINARY negative adjustment, on item C's numbers, is untouched.
    select * into v_mv from post_stock_adjustment(
      v_property, v_location, v_item_c, -1, 'ZZ050 D ordinary',
      v_date, null, 'zz050-d3'
    );
    if v_mv.id is null then
      v_fail := v_fail || 'D: an ordinary adjustment was refused. ';
    elsif v_mv.carried_unit_cost is null then
      v_fail := v_fail || 'D: an ordinary adjustment carried no cost. ';
    end if;

    -- ------------------------------------------------------------------
    -- E — finish_stock_take is still ungated.
    -- ------------------------------------------------------------------
    select pg_get_functiondef(p.oid) into v_src
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'finish_stock_take'
    limit 1;

    if v_src is null then
      v_fail := v_fail || 'E: finish_stock_take not found. ';
    elsif v_src like '%PT450%' or v_src like '%p_allow_unvalued%' then
      v_fail := v_fail ||
        'E: finish_stock_take has acquired the unvaluable gate. Read 050''s header before removing this assertion — refusing a count at the end of an hour''s walking teaches people to fudge the count. ';
    end if;

    if v_fail <> '' then
      raise exception '050 SELF-VERIFY FAILED: %', v_fail;
    end if;

    raise notice '050 self-verify: 13 assertions passed (A 1, B 4, C 4, D 3, E 1).';
    raise exception 'ZZ_050_FIXTURE_DONE';
  exception
    when others then
      if sqlerrm = 'ZZ_050_FIXTURE_DONE' then
        null;  -- the fixture rolled itself back; nothing above survives
      else
        raise;
      end if;
  end;
end;
$$;


-- ############################################################################
-- SECTION 4 — GRANTS, re-issued after the drops
-- ############################################################################
revoke all     on function post_stock_writeoff(uuid, uuid, uuid, numeric, text, date, text, text, boolean, boolean) from public;
revoke execute on function post_stock_writeoff(uuid, uuid, uuid, numeric, text, date, text, text, boolean, boolean) from anon;
grant  execute on function post_stock_writeoff(uuid, uuid, uuid, numeric, text, date, text, text, boolean, boolean) to authenticated;

revoke all     on function post_stock_adjustment(uuid, uuid, uuid, numeric, text, date, numeric, text, boolean, text, date, boolean) from public;
revoke execute on function post_stock_adjustment(uuid, uuid, uuid, numeric, text, date, numeric, text, boolean, text, date, boolean) from anon;
grant  execute on function post_stock_adjustment(uuid, uuid, uuid, numeric, text, date, numeric, text, boolean, text, date, boolean) to authenticated;
