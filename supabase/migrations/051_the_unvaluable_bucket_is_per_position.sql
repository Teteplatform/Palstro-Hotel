-- 051 — THE UNVALUABLE BUCKET IS A FACT ABOUT A POSITION, NOT ABOUT A MOVEMENT
--
-- 048 built the bucket and asked the right question of the wrong subject. It
-- counts a movement whose cost basis is NULL, and that catches the FIRST
-- unvaluable movement on a position and misses every one after it on the same
-- day.
--
-- MEASURED while building 050's gate, not reasoned about afterwards:
--
--   write off 4 kg dated 1 Oct, no prior history  -> carried_unit_cost NULL
--   write off 3 kg dated 1 Oct, immediately after -> carried_unit_cost 0.0000
--
-- The fold now has a row to walk — a quantity that left carrying nothing — so
-- `stock_average_cost_as_at` returns zero rather than NULL for the second. Zero
-- is a VALUE, so 048's `basis is null` test excludes it, and its effect lands in
-- `valuation_difference` instead: the one figure whose entire worth is that it
-- contains only rounding and the average resets a negative position causes.
--
-- The owner's question was never "which movement had no basis". It is **this
-- position has no cost basis, and here is everything that has left it
-- unvalued** — which accounts for all of them.
--
-- ----------------------------------------------------------------------------
-- THE DEFINITION, AND WHY IT IS SIMPLER THAN IT LOOKS
-- ----------------------------------------------------------------------------
-- Every outbound movement that happened BEFORE the position's first inbound one,
-- ordered by (business_date, seq) — the same walk the valuation fold uses — plus
-- all outbounds if the position has never had an inbound at all.
--
-- It collapses to "first inbound" rather than "first COSTED inbound" because of
-- a constraint rather than an assumption. 036's cost/direction check is:
--
--     (quantity > 0 and unit_cost is not null) or (quantity < 0 and unit_cost is null)
--
-- so EVERY stock-in carries a cost, and a genuinely free-of-charge receipt is
-- stored as 0 rather than NULL. There is no such thing as an uncosted inbound,
-- so the first inbound is the first basis.
--
-- THE NEW SET CONTAINS THE OLD ONE, which is worth knowing because it means
-- nothing 048 reported stops being reported. A NULL basis means the fold found
-- no rows before that movement; an inbound before it would have been such a row;
-- so every NULL-basis movement is already before the first inbound.
--
-- ----------------------------------------------------------------------------
-- MOVEMENT TYPE IS USED TWICE HERE, FOR TWO DIFFERENT THINGS, AND SWAPPING THEM
-- IS THE WAY THIS QUERY GETS WRITTEN WRONG BY SOMEBODY READING IT QUICKLY
-- ----------------------------------------------------------------------------
--   * THE THRESHOLD counts EVERY inbound movement, INCLUDING `transfer_in` and
--     `issue_in`. Stock that arrived by transfer gave the position a cost basis
--     just as a receipt would, and a position fed only by transfers is not a
--     position without a basis.
--
--   * THE COUNTED SET keeps 048's exclusion of all four transfer and issue
--     types. An issue or transfer nets to zero across the two locations, so
--     counting one leg without the other would invent a hole.
--
-- THE COMPARISON IS STRICT (<) ONLY FOR READABILITY. seq is a table-wide
-- identity, so an outbound and the threshold inbound can never share a
-- (business_date, seq) and <= selects the same rows. Flipping it was tried as a
-- breakage and stayed GREEN, which is correct rather than a missing assertion --
-- there is no data on which the two differ, so there is no defect to catch.
--
-- ----------------------------------------------------------------------------
-- WHY THIS FUNCTION IS SECURITY DEFINER, so that nobody tidies it away
-- ----------------------------------------------------------------------------
-- Carried unchanged from 047 and 048, and written down here because a DEFINER
-- function is exactly the thing a careful reader reaches to remove.
--
-- THE FIGURE'S WHOLE CLAIM IS THAT EVERYTHING AGREES: the ledger against an
-- independent recomputation across EVERY movement in the property. A figure
-- that means "everything agrees" has to see everything. Under SECURITY INVOKER
-- it would see whatever the caller's RLS lets through -- so on the day 2.3
-- lands per-location access, a storekeeper opening the card would get a
-- confident difference computed from a SUBSET of the movements, and it would
-- look exactly like a real one. That is the worst failure this screen has,
-- because it is indistinguishable from the thing the screen exists to detect.
--
-- The DEFINER rights are paired with an explicit is_tenant_staff gate rather
-- than left open: without it, a member with no business reading the books gets
-- ZEROS instead of a refusal, which is a different answer to a different
-- question than the one they asked.
--
-- 051's first draft lost both, rewriting the function from memory instead of
-- from 048. It was caught in review, not by a test, which is why the rebuild
-- was done mechanically from 048's text with the guards asserted present.
--
-- Get these the wrong way round and the query still runs. Excluding transfers
-- from the THRESHOLD invents bad positions that have a perfectly good basis;
-- including them in the COUNTED SET reports half of a movement pair that nets to
-- nothing. Neither errors, and both produce a confident wrong number on the one
-- screen that exists to say the books and the stock agree.
--
-- ----------------------------------------------------------------------------
-- THE COUNT MOVES WITH THE VALUE
-- ----------------------------------------------------------------------------
-- `unvaluable_movement_count` was computed from the per-movement test in
-- `totals`. Leaving it there while the value became per-position would put "1
-- movement" beside a figure covering three, which is a card contradicting
-- itself. Both now come from the same subquery, so there is ONE definition of
-- what unvaluable means.
--
-- ----------------------------------------------------------------------------
-- WHAT THE IDENTITY DOES, AND WHY IT IS THE ONLY ASSERTION THAT MATTERS
-- ----------------------------------------------------------------------------
-- A NULL basis and a zero basis both contribute NOTHING to the ledger side: the
-- first has no value to add, the second adds zero. So widening the bucket moves
-- quantity out of `valuation_difference` and into `unvaluable_value` and changes
-- nothing else, and
--
--     val = expected + pre_gl + pre_wiring + non_posting + unval
--
-- must hold EXACTLY afterwards. §3's fixture proves it on three unvaluable
-- movements on one position on one date, where 048's reading and this one sit on
-- different numbers — because a fixture on which the old and new definitions
-- agree cannot test either of them (rule 27).

drop function if exists inventory_gl_reconciliation(uuid);

create function inventory_gl_reconciliation(p_property_id uuid)
returns table (
  property_id             uuid,
  account_id              uuid,
  account_code            text,
  account_name            text,
  ledger_balance          numeric(14,2),
  expected_ledger_balance numeric(14,2),
  -- MUST BE ZERO. Anything else is a posting skipped, doubled, or misdirected.
  ledger_difference       numeric(14,2),
  -- Value that legitimately never reached the ledger, split FOUR ways as of 048
  -- so the arithmetic below is complete rather than approximately complete.
  pre_gl_value            numeric(14,2),
  -- 047: written before the posting code existed.
  pre_wiring_value        numeric(14,2),
  non_posting_value       numeric(14,2),
  unvaluable_movement_count integer,
  -- 048: THE VALUATION EFFECT OF THE MOVEMENTS THAT COUNT NAMES. Quantity moved
  -- with no cost to move with it, valued at the position's own average. Reported
  -- rather than absorbed, exactly like the three above -- and it is the reason
  -- valuation_difference can be required to explain itself again.
  unvaluable_value        numeric(14,2),
  valuation_value         numeric(14,2),
  -- Per-movement rounding, plus any position that has passed through negative.
  -- NOT required to be zero, and never absorbed anywhere. As of 048 it no longer
  -- carries the unvaluable movements' quantity, which was never rounding.
  valuation_difference    numeric(14,2),
  -- 047: THE DENOMINATOR THE RESIDUE MUST BE READ AGAINST. A kobo across forty
  -- movements is arithmetic; the same kobo across four thousand is not, and the
  -- only way anybody sees the difference is if both numbers are together.
  valued_movement_count   integer,
  -- 047: positions that have EVER been below zero — the ones that actually cause
  -- a divergence, because the fold resets the average when stock arrives into a
  -- negative position.
  reset_position_count    integer,
  -- Positions below zero RIGHT NOW. A different question, kept because it is the
  -- one somebody acts on today.
  negative_position_count integer
)
language plpgsql
stable
security definer
set search_path = public
as $$
-- The OUT parameters of a `returns table` are plpgsql VARIABLES and several
-- share a name with a column below. Every reference is qualified; the directive
-- removes the class of ambiguity rather than relying on that staying true.
-- IT LIVES INSIDE THE BODY, above `declare`: it is read by the PL/pgSQL parser,
-- not by CREATE FUNCTION, and putting it in the header is a plain syntax error.
#variable_conflict use_column
declare
  v_tenant   uuid;
  v_account  uuid;
  v_gl_start date;
  v_wired    timestamptz;
begin
  select p.tenant_id into v_tenant
  from properties p where p.id = p_property_id and p.deleted_at is null;

  if v_tenant is null then
    raise exception 'Property % not found', p_property_id using errcode = 'PT404';
  end if;

  if not is_tenant_staff(v_tenant) then
    raise exception 'Not authorised to read this property''s ledger'
      using errcode = 'insufficient_privilege';
  end if;

  -- Rule 4, even here: resolved by ROLE KEY, so a tenant who repoints
  -- `inventory` gets a reconciliation of the account it now points at.
  v_account := resolve_account(v_tenant, p_property_id, 'inventory');

  select pfs.gl_start_date, pfs.gl_wired_at into v_gl_start, v_wired
  from property_finance_settings pfs where pfs.property_id = p_property_id;

  return query
  with m as (
    select
      sm.movement_type,
      sm.business_date,
      sm.created_at,
      sm.quantity,
      case
        when sm.movement_type in ('issue_out', 'issue_in', 'transfer_out', 'transfer_in')
          then null
        when sm.movement_type = 'reversal' then sm.carried_unit_cost
        when sm.quantity > 0               then sm.unit_cost
        else                                    sm.carried_unit_cost
      end as basis,
      (sm.movement_type in ('issue_out', 'issue_in', 'transfer_out', 'transfer_in'))
        as books_nothing
    from stock_movements sm
    where sm.property_id = p_property_id
  ),
  v as (
    select
      m.*,
      case when m.basis is null then null
           else sign(m.quantity) * round(abs(m.quantity) * m.basis, 2)
      end as value,
      -- Dated before the books opened. A POLICY boundary about business dates.
      (v_gl_start is not null and m.business_date < v_gl_start) as pre_gl,
      -- Written before the code that posts existed. A FACT about created_at.
      (v_wired is not null and m.created_at < v_wired)          as pre_wiring
    from m
  ),
  totals as (
    select
      -- What the ledger SHOULD hold: everything that books something, is
      -- valuable, is inside the books, and was written after the wiring.
      coalesce(sum(case
        when v.books_nothing then 0
        when v.value is null then 0
        when v.pre_gl then 0
        when v.pre_wiring then 0
        else v.value end), 0)::numeric(14,2)                     as expected_balance,
      coalesce(sum(case
        when not v.books_nothing and v.value is not null and v.pre_gl
        then v.value else 0 end), 0)::numeric(14,2)              as pre_gl_total,
      -- NOT pre_gl AND pre_wiring, so the two buckets never double-count the
      -- same movement — they are reported separately and summed below.
      coalesce(sum(case
        when not v.books_nothing and v.value is not null
             and not v.pre_gl and v.pre_wiring
        then v.value else 0 end), 0)::numeric(14,2)              as pre_wiring_total,
      coalesce(sum(case when v.books_nothing and v.value is not null
                        then v.value else 0 end), 0)::numeric(14,2) as non_posting,
      -- EVERY movement whose value was rounded to the kobo — which is exactly
      -- the set the rounding residue accumulated over.
      count(*) filter (where not v.books_nothing and v.value is not null)::integer
                                                                 as valued_n
    from v
  ),
  -- 051 §1. THE POSITION'S FIRST INBOUND, which is its first cost basis.
  --
  -- EVERY inbound counts here, transfers and issues INCLUDED -- see the header.
  -- Stock that arrived by transfer gave this position a basis as surely as a
  -- receipt would, and a position fed only by transfers is not a position
  -- without a basis.
  -- `distinct on` rather than an aggregate: the ordering key is the PAIR
  -- (business_date, seq) -- seq alone is wrong, because a back-dated row has a
  -- higher seq and an earlier date -- and Postgres has no min() over a record.
  first_in as (
    select distinct on (sm.location_id, sm.inventory_item_id)
      sm.location_id,
      sm.inventory_item_id,
      sm.business_date,
      sm.seq
    from stock_movements sm
    where sm.property_id = p_property_id
      and sm.quantity > 0
    order by sm.location_id, sm.inventory_item_id, sm.business_date, sm.seq
  ),
  -- 051 §2. WHAT LEFT BEFORE THERE WAS ANYTHING TO VALUE IT AT.
  --
  -- 048's four excluded types are excluded HERE and nowhere else -- again, see
  -- the header. The threshold above wants them; this does not.
  unvalued_out as (
    select sm.location_id, sm.inventory_item_id, sm.quantity
    from stock_movements sm
    left join first_in fi
      on  fi.location_id       = sm.location_id
      and fi.inventory_item_id = sm.inventory_item_id
    where sm.property_id = p_property_id
      and sm.quantity < 0
      and sm.movement_type not in ('issue_out', 'issue_in', 'transfer_out', 'transfer_in')
      and (
        fi.location_id is null
        or (sm.business_date, sm.seq) < (fi.business_date, fi.seq)
      )
  ),
  -- THE VALUE: the quantity those movements took off the position, at the
  -- position's own moving average. Computed from the MOVEMENTS, deliberately,
  -- and not from the difference it is meant to explain -- a bucket derived from
  -- `valuation_difference` would be true by construction and incapable of being
  -- wrong (048's reasoning, unchanged).
  unval as (
    select coalesce(sum(round(u.qty * coalesce(soh.moving_average_cost, 0), 2)), 0)::numeric(14,2) as value
    from (
      select uo.location_id, uo.inventory_item_id, sum(uo.quantity) as qty
      from unvalued_out uo
      group by uo.location_id, uo.inventory_item_id
    ) u
    join stock_on_hand soh
      on  soh.property_id       = p_property_id
      and soh.location_id       = u.location_id
      and soh.inventory_item_id = u.inventory_item_id
  ),
  -- THE COUNT is of MOVEMENTS, so it is taken from the un-grouped set. One
  -- definition of unvaluable feeds both figures, which is the point of 051: a
  -- count on one test beside a value on another is a card contradicting itself.
  unval_n as (
    select count(*)::integer as n from unvalued_out
  ),
  led as (
    select coalesce(sum(jel.debit - jel.credit), 0)::numeric(14,2) as balance
    from journal_entry_lines jel
    join journal_entries je on je.id = jel.journal_entry_id
    where je.tenant_id   = v_tenant
      and je.property_id = p_property_id
      and jel.account_id = v_account
  ),
  val as (
    select
      coalesce(sum(soh.stock_value), 0)::numeric(14,2)          as value,
      count(*) filter (where soh.quantity_on_hand < 0)::integer as negatives
    from stock_on_hand soh
    where soh.property_id = p_property_id
  ),
  -- HAS THIS POSITION EVER BEEN BELOW ZERO? The running total in the fold's own
  -- order (business_date, seq — 036 §2), not the closing quantity: a position
  -- that went negative and was then replenished is POSITIVE today and is exactly
  -- the one whose average was reset.
  resets as (
    select count(*)::integer as n
    from (
      select r.location_id, r.inventory_item_id
      from (
        select
          sm.location_id,
          sm.inventory_item_id,
          sum(sm.quantity) over (
            partition by sm.location_id, sm.inventory_item_id
            order by sm.business_date, sm.seq
            rows between unbounded preceding and current row
          ) as running
        from stock_movements sm
        where sm.property_id = p_property_id
      ) r
      group by r.location_id, r.inventory_item_id
      having min(r.running) < 0
    ) q
  )
  select
    p_property_id,
    v_account,
    a.code,
    a.name,
    led.balance,
    totals.expected_balance,
    (led.balance - totals.expected_balance)::numeric(14,2),
    totals.pre_gl_total,
    totals.pre_wiring_total,
    totals.non_posting,
    unval_n.n,
    unval.value,
    val.value,
    -- 048 put the unvaluable bucket beside the three it belongs with; 051 makes
    -- it complete. What is left here is rounding and the average resets a
    -- negative position causes -- which is what this figure was always
    -- documented to be, and now is.
    (val.value - (totals.expected_balance + totals.pre_gl_total
                  + totals.pre_wiring_total + totals.non_posting
                  + unval.value))::numeric(14,2),
    totals.valued_n,
    resets.n,
    val.negatives
  from totals
  cross join led
  cross join val
  cross join resets
  cross join unval
  cross join unval_n
  cross join accounts a
  where a.id = v_account;
end;
$$;
comment on function inventory_gl_reconciliation(uuid) is
  'Stock against the ledger for one property, with every difference named rather '
  'than absorbed. 051 redefines the unvaluable bucket as a fact about a POSITION '
  'rather than about a movement: everything that left a position before its '
  'first inbound, which is the first thing that gave it a cost basis. 048 tested '
  'the movement''s own basis for NULL, which caught the first unvaluable movement '
  'on a position and missed every one after it on the same day — those carry a '
  'basis of ZERO, because the fold then has a row to walk. Movement type is used '
  'TWICE and differently: the threshold counts every inbound INCLUDING transfers '
  'and issues, the counted set excludes all four transfer and issue types.';


-- ############################################################################
-- SECTION 3 — SELF-VERIFY
-- ############################################################################
-- THE FIXTURE IS THREE UNVALUABLE MOVEMENTS ON ONE POSITION ON ONE DATE, and it
-- is built that way because a fixture with ONE would read identically under 048
-- and 051. The old definition catches the first and misses two; the new one
-- catches all three; the two readings therefore sit on different numbers, which
-- is what makes the assertion capable of failing (rule 27).
--
-- ON A THROWAWAY PROPERTY. The reconciliation is a property-wide invariant and
-- the live property carries its own history, so an exact assertion is only
-- possible on a property whose entire contents this fixture put there.
--
-- NAME THE DEFECT EACH ASSERTION TURNS RED:
--
--   1  the identity holds exactly      RED if the bucket under- or over-counts
--                                      by any amount at all.
--   2  the new reading is -9,000       RED if the threshold or the counted set
--      and the old one is -4,000       is wrong, and red if they are swapped.
--   3  the count is 3, not 1           RED if the count was left on the old
--                                      per-movement test while the value moved.
--   4  a transfer OUT of a bad         RED if the counted set stops excluding
--      position is NOT counted         the four types.
--   5  a transfer IN gives a position  RED if the threshold stops counting
--      a basis, so later outs are      transfers — the half of the swap that
--      NOT counted                     invents bad positions.
do $$
declare
  v_tenant   uuid;
  v_actor    uuid;
  v_prop     uuid;
  v_loc      uuid;
  v_loc2     uuid;
  v_item     uuid;
  v_item2    uuid;
  v_date     date := current_date;
  v_r        record;
  v_old      numeric;
  v_secdef   boolean;
  v_src      text;
  v_fail     text := '';
begin
  begin
    select t.id into v_tenant from tenants t limit 1;
    select tu.user_id into v_actor
    from tenant_users tu where tu.tenant_id = v_tenant and tu.is_active limit 1;

    if v_tenant is null or v_actor is null then
      raise notice '051 self-verify SKIPPED: no tenant or active staff member.';
      return;
    end if;
    perform set_config('request.jwt.claim.sub', v_actor::text, true);

    insert into properties (tenant_id, name, slug)
    values (v_tenant, 'ZZ051 fixture property', 'zz051-fixture')
    returning id into v_prop;

    insert into locations (tenant_id, property_id, name, kind, is_active)
    values (v_tenant, v_prop, 'ZZ051 store', 'store', true) returning id into v_loc;
    insert into locations (tenant_id, property_id, name, kind, is_active)
    values (v_tenant, v_prop, 'ZZ051 kitchen', 'kitchen', true) returning id into v_loc2;

    insert into inventory_items (tenant_id, name, item_type, base_unit, is_active)
    values (v_tenant, 'ZZ051 item', 'raw', 'kg', true) returning id into v_item;
    insert into inventory_items (tenant_id, name, item_type, base_unit, is_active)
    values (v_tenant, 'ZZ051 transferred', 'raw', 'kg', true) returning id into v_item2;

    -- THE RECEIPT IS DATED TODAY AND THE WRITE-OFFS FIVE DAYS BACK, so the
    -- position has a REAL average (1,000) while the outs precede it. Without a
    -- non-zero average the bucket would read zero either way and the assertion
    -- could not fail.
    perform post_stock_receipt(
      v_prop, v_loc, v_item, 30, 1000, v_date, 'ZZ051', null, null);

    -- Three outs on one date, before the first inbound. 050's gate asks on the
    -- first (no basis) and not on the next two (basis zero), and the negative
    -- guard asks on all three, so both overrides are passed.
    perform post_stock_writeoff(
      v_prop, v_loc, v_item, 4, 'spoilage', v_date - 5, 'ZZ051 a', 'zz051-a', true, true);
    perform post_stock_writeoff(
      v_prop, v_loc, v_item, 3, 'spoilage', v_date - 5, 'ZZ051 b', 'zz051-b', true, true);
    perform post_stock_writeoff(
      v_prop, v_loc, v_item, 2, 'spoilage', v_date - 5, 'ZZ051 c', 'zz051-c', true, true);

    select * into v_r from inventory_gl_reconciliation(v_prop);

    -- --- 1. THE IDENTITY, which is the whole point -------------------------
    if v_r.valuation_difference <> 0 then
      v_fail := v_fail || format(
        '1: the identity does not hold — valuation_difference reads %s, not 0.00. ',
        v_r.valuation_difference);
    end if;

    -- --- 2. THE TWO READINGS SIT ON DIFFERENT NUMBERS ----------------------
    -- 9 kg left at an average of 1,000.
    if v_r.unvaluable_value <> -9000 then
      v_fail := v_fail || format(
        '2: expected unvaluable_value -9000.00, got %s. ', v_r.unvaluable_value);
    end if;
    -- 048's reading, recomputed here ONLY to show the fixture discriminates —
    -- the assertion of correctness is the identity above, not this.
    select coalesce(sum(round(q.qty * coalesce(soh.moving_average_cost, 0), 2)), 0)
      into v_old
    from (
      select sm.location_id, sm.inventory_item_id, sum(sm.quantity) as qty
      from stock_movements sm
      where sm.property_id = v_prop
        and sm.movement_type not in ('issue_out','issue_in','transfer_out','transfer_in')
        and (case when sm.movement_type = 'reversal' then sm.carried_unit_cost
                  when sm.quantity > 0 then sm.unit_cost
                  else sm.carried_unit_cost end) is null
      group by sm.location_id, sm.inventory_item_id
    ) q
    join stock_on_hand soh on soh.property_id = v_prop
      and soh.location_id = q.location_id
      and soh.inventory_item_id = q.inventory_item_id;
    if v_old <> -4000 then
      v_fail := v_fail || format(
        '2: the fixture does not discriminate — 048''s reading is %s, expected -4000.00. ',
        v_old);
    end if;

    -- --- 3. THE COUNT MOVED WITH THE VALUE ---------------------------------
    if v_r.unvaluable_movement_count <> 3 then
      v_fail := v_fail || format(
        '3: expected 3 unvaluable movements, got %s. ', v_r.unvaluable_movement_count);
    end if;

    -- --- 4 and 5. THE TWO USES OF MOVEMENT TYPE ----------------------------
    -- THE FIRST VERSION OF THIS FIXTURE DID NOT DISCRIMINATE, and the breakage
    -- run proved it: the transfer sat AFTER the store's first inbound, so the
    -- threshold excluded it anyway and removing the type exclusion from the
    -- counted set changed nothing. Green, and testing neither half.
    --
    -- The transfer OUT must therefore precede the position's first inbound,
    -- which is the only place the type exclusion is load-bearing: a position
    -- that has issued stock it never received is exactly the §9 negative the
    -- bucket must NOT claim, because the matching leg is sitting in another
    -- location with the value on it.
    insert into stock_movements (
      tenant_id, property_id, location_id, inventory_item_id,
      movement_type, quantity, unit_cost, business_date, reason, source
    ) values (
      v_tenant, v_prop, v_loc, v_item2, 'transfer_out', -5, null, v_date - 6,
      'ZZ051 transfer', 'manual');
    insert into stock_movements (
      tenant_id, property_id, location_id, inventory_item_id,
      movement_type, quantity, unit_cost, business_date, reason, source
    ) values (
      v_tenant, v_prop, v_loc2, v_item2, 'transfer_in', 5, 500, v_date - 6,
      'ZZ051 transfer', 'manual');

    -- The store's first inbound arrives AFTER the transfer out, so the transfer
    -- is inside the window the threshold opens.
    perform post_stock_receipt(
      v_prop, v_loc, v_item2, 10, 500, v_date - 2, 'ZZ051', null, null);

    -- And something leaves the KITCHEN after its transfer_in. The transfer_in is
    -- an inbound, so the kitchen has a basis and this must not be counted — the
    -- other half of the swap.
    perform post_stock_writeoff(
      v_prop, v_loc2, v_item2, 2, 'breakage', v_date - 1, 'ZZ051 d', 'zz051-d');

    select * into v_r from inventory_gl_reconciliation(v_prop);

    if v_r.unvaluable_movement_count <> 3 then
      v_fail := v_fail || format(
        '4/5: expected 3 — a count of 4 means the counted set stopped excluding transfers, '
        || 'a count above that means the threshold stopped counting them. Got %s. ',
        v_r.unvaluable_movement_count);
    end if;
    if v_r.valuation_difference <> 0 then
      v_fail := v_fail || format(
        '4/5: the identity broke once transfers existed — valuation_difference %s. ',
        v_r.valuation_difference);
    end if;

    -- --- 6. THE GUARDS ARE STILL ON THE FUNCTION ---------------------------
    -- THIS ASSERTION EXISTS BECAUSE 051'S FIRST DRAFT LOST THEM. Rewriting the
    -- function from memory rather than from 048's text silently turned it
    -- SECURITY INVOKER and dropped the is_tenant_staff gate, and no assertion in
    -- this file noticed -- a human reading the diff did.
    --
    -- A security mode and an authorisation gate are the one class of change
    -- where the diff looks small and the blast radius is not, so they get an
    -- assertion of their own rather than relying on the next reader being as
    -- careful. The header says WHY definer; this says it is still definer.
    select p.prosecdef, pg_get_functiondef(p.oid) into v_secdef, v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'inventory_gl_reconciliation';

    if not coalesce(v_secdef, false) then
      v_fail := v_fail ||
        ' 6: inventory_gl_reconciliation is no longer SECURITY DEFINER. Read this file''s header before changing that -- under invoker it reports agreement computed from whatever the caller''s RLS lets through, which is indistinguishable from the disagreement it exists to detect. ';
    end if;
    if v_src is null or v_src not like '%is_tenant_staff%' then
      v_fail := v_fail ||
        ' 6: the is_tenant_staff gate is gone. Without it a member with no business reading the books gets zeros rather than a refusal. ';
    end if;

    if v_fail <> '' then
      raise exception '051 SELF-VERIFY FAILED: %', v_fail;
    end if;

    raise notice '051 self-verify: 8 assertions passed (identity twice, both readings, the count, the two type uses, definer, the staff gate).';
    raise exception 'ZZ_051_FIXTURE_DONE';
  exception
    when others then
      if sqlerrm = 'ZZ_051_FIXTURE_DONE' then
        null;  -- the fixture rolled itself back; nothing above survives
      else
        raise;
      end if;
  end;
end;
$$;
