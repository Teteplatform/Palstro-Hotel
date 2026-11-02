-- ============================================================================
-- 048_unvaluable_gets_a_bucket.sql
-- Palstro-Hotels: a movement with no cost basis stops corrupting the figure
-- beside it, and 047's claim about it is replaced with what was measured.
-- ============================================================================
--
-- ----------------------------------------------------------------------------
-- THE DEFECT, AND 047 SAYING THE OPPOSITE OF IT IN A COMMENT
-- ----------------------------------------------------------------------------
-- 047 §3 wrote this, beside the count of movements it could not value:
--
--     -- Books something by type but has no cost basis. Absent from the ledger
--     -- AND from the valuation, so it cancels out — COUNTED rather than valued,
--     -- because valuing it would mean inventing the figure it does not have.
--
-- THE SECOND HALF IS FALSE. Absent from the ledger, yes. Absent from the
-- valuation, NO — and it was never going to be, because of how the valuation is
-- built. `stock_on_hand.stock_value` is `quantity_on_hand * moving_average_cost`,
-- and an unvaluable movement is a movement: it moved the quantity. The fold
-- never sees its missing basis at all, because `stock_on_hand` passes
-- `carried_unit_cost` to `stock_wac` for reversal rows ONLY (038 §5) — for every
-- other outbound the third argument is NULL and the quantity is simply folded in.
-- So a write-off with `carried_unit_cost = NULL` and one with
-- `carried_unit_cost = 1100` produce an IDENTICAL `stock_on_hand` row.
--
-- The consequence, measured rather than reasoned about. A back-dated write-off
-- on a fresh position, followed by a receipt:
--
--     wastage  -4   business_date 2026-10-01   carried_unit_cost NULL
--     receipt +10 @ 1000.00                    business_date 2026-10-05
--
--   stock_on_hand:  quantity 6.0000, average 1000.0000, stock_value 6000.00
--   expected_ledger_balance: 10000.00   (the receipt; the write-off has no value)
--   valuation_difference:    -4000.00   <-- the write-off's quantity at the average
--
-- Exactly the 4 units at the ₦1,000 the average was reset to. The figure whose
-- entire worth is that it reads zero reads minus four thousand, and the only
-- thing on screen about it was a count.
--
-- WHY THE CASE IS REACHABLE AND NOT A CURIOSITY. `set_stock_carried_cost` (038
-- §6) stamps the basis from the average STRICTLY BEFORE this row's
-- (business_date, seq). A back-dated write-off, or any outbound from a position
-- with no prior receipt, has no such average, so the column stays NULL. That is
-- §9's "negative stock is flagged, never blocked" arriving at the reconciliation.
-- `stock_movements_cost_direction_check` forces `unit_cost IS NULL` on every
-- outbound, so `carried_unit_cost` is the only basis an outbound ever has.
--
-- ----------------------------------------------------------------------------
-- THE FIX IS A BUCKET, BECAUSE THAT IS WHAT THE OTHER THREE ARE
-- ----------------------------------------------------------------------------
-- The reconciliation already names every category of value that legitimately
-- never reached the ledger: `pre_gl_value`, `pre_wiring_value`,
-- `non_posting_value`. Each is computed independently, reported on its own, and
-- absorbed nowhere. Unvaluable movements were the one exception — counted, and
-- then left to corrupt the number next to them.
--
-- So they get a bucket like the others: `unvaluable_value`, the valuation effect
-- of the movements with no cost basis, computed from the movements themselves.
--
-- HOW IT IS DEFINED, and why this definition and not another. For each position,
-- the valuation is `total_quantity * average`. The unvaluable movements
-- contributed `unvaluable_quantity` to that total and changed the average not at
-- all (an outbound never does). So the value the valuation assigns to quantity
-- the ledger never saw is `unvaluable_quantity * average`, per position, summed.
-- It is NOT derived from `valuation_difference` — that would be a plug, true by
-- construction and incapable of being wrong. It is computed from the movement
-- rows and the position's own average, which is what makes it an assertion.
--
-- THE SIGN IS LEFT ALONE. An unvaluable write-off of 4 units at ₦1,000 reports
-- -4,000.00: the valuation is four thousand naira LIGHTER than the books expect,
-- because stock left and no cost went with it. Taking an absolute value here
-- would hide which direction the hole runs in.
--
-- WHAT THIS IS NOT: a tolerance, and not a fudge. Nothing is widened, nothing is
-- ignored, and `valuation_difference` is still required to be explainable. The
-- rejected alternative was to subtract the unvaluable value inside
-- `valuation_difference` without reporting it, which reads identically on a good
-- day and silently swallows the figure on a bad one.
--
-- ----------------------------------------------------------------------------
-- 047's COMMENT IS REPLACED, NOT SOFTENED
-- ----------------------------------------------------------------------------
-- The function is redefined here, so the new body carries the corrected comment.
-- 047's FILE is left exactly as it is: it has been applied, and an applied
-- migration is history. The record of the correction lives here, where the
-- change does.
--
-- The card's sentence was wrong in the same way and for the same reason -- it
-- said these movements were "on neither side" -- and is corrected in the same
-- shipment (InventoryReconciliationPanel.tsx).
--
-- ----------------------------------------------------------------------------
-- NOTHING IS WRONG ON LIVE TODAY, which is why this could be done calmly:
-- `unvaluable_movement_count` is 0 on Heledon and no movement exists with a
-- negative quantity and no carried cost. The first back-dated write-off is what
-- would have broken it.
--
-- RE-RUNNABLE. Applying this file twice in one transaction is a clean no-op.
-- ============================================================================


-- ############################################################################
-- SECTION 1 — the reconciliation gains a fourth bucket
-- ############################################################################
-- DROP then CREATE, not CREATE OR REPLACE: the return type gains a column, and
-- Postgres refuses to replace a function whose OUT parameters have changed.
-- `drop if exists` keeps the file re-runnable.
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
      -- 048: STILL COUNTED HERE, and now valued in `unval` below. The count and
      -- the value answer different questions -- how many, and how much -- and
      -- the card says both.
      count(*) filter (where not v.books_nothing and v.value is null)::integer
                                                                 as unvaluable_n,
      coalesce(sum(case when v.books_nothing and v.value is not null
                        then v.value else 0 end), 0)::numeric(14,2) as non_posting,
      -- EVERY movement whose value was rounded to the kobo — which is exactly
      -- the set the rounding residue accumulated over.
      count(*) filter (where not v.books_nothing and v.value is not null)::integer
                                                                 as valued_n
    from v
  ),
  -- 048 §1. THE FOURTH BUCKET. The valuation effect of the movements that carry
  -- no cost basis: their quantity, at the position's own moving average.
  --
  -- Computed from the MOVEMENTS, deliberately, and not from the difference it is
  -- meant to explain. A bucket derived from `valuation_difference` would be true
  -- by construction, could never be wrong, and would make the assertion below
  -- unfalsifiable -- rule 27's first shape, an assertion that recomputes the
  -- answer it is checking.
  --
  -- The predicate repeats `basis` rather than reading the `v` CTE because `v`
  -- does not carry the position columns, and widening it to carry them would
  -- change the shape of every aggregate above for one new figure.
  unval as (
    select coalesce(sum(round(u.qty * coalesce(soh.moving_average_cost, 0), 2)), 0)::numeric(14,2) as value
    from (
      select sm.location_id, sm.inventory_item_id, sum(sm.quantity) as qty
      from stock_movements sm
      where sm.property_id = p_property_id
        and sm.movement_type not in ('issue_out', 'issue_in', 'transfer_out', 'transfer_in')
        and (case
               when sm.movement_type = 'reversal' then sm.carried_unit_cost
               when sm.quantity > 0               then sm.unit_cost
               else                                    sm.carried_unit_cost
             end) is null
      group by sm.location_id, sm.inventory_item_id
    ) u
    join stock_on_hand soh
      on  soh.property_id       = p_property_id
      and soh.location_id       = u.location_id
      and soh.inventory_item_id = u.inventory_item_id
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
    totals.unvaluable_n,
    unval.value,
    val.value,
    -- 048: the unvaluable bucket joins the three it belongs with. What is left is
    -- rounding and the average resets a negative position causes -- which is what
    -- this figure was always documented to be.
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
  cross join accounts a
  where a.id = v_account;
end;
$$;

comment on function inventory_gl_reconciliation(uuid) is
  'THE CHECK THAT MAKES THE POSTING WORTH HAVING (rule 9). INVARIANT: '
  'ledger_balance === expected_ledger_balance, to the kobo, always — the left '
  'side read from journal_entry_lines, the right computed independently from '
  'stock_movements, so any difference means a posting was skipped, doubled or '
  'landed on the wrong account. That is the assertion the ERP could not make. '
  'SECOND INVARIANT (048): valuation_value === expected_ledger_balance + '
  'pre_gl_value + pre_wiring_value + non_posting_value + unvaluable_value, '
  'leaving valuation_difference as per-movement rounding and average resets '
  'ONLY. 047 claimed a movement with no cost basis was absent from the ledger '
  'AND from the valuation, so that it cancelled out. THAT WAS WRONG: it is '
  'absent from the ledger and PRESENT in the valuation, because '
  'stock_on_hand.stock_value is quantity times an average and the movement '
  'moved the quantity. Measured at -4,000.00 on a fixture before this '
  'migration. 048 gives it a reported bucket, unvaluable_value, so the figure '
  'returns to zero when that is the only cause and the quantity is accounted '
  'for in words rather than hidden in a residue.';

revoke all     on function inventory_gl_reconciliation(uuid) from public;
revoke execute on function inventory_gl_reconciliation(uuid) from anon;
grant  execute on function inventory_gl_reconciliation(uuid) to authenticated;


-- ############################################################################
-- SECTION 2 — IN-TRANSACTION SELF-VERIFY
-- ############################################################################
-- Rule 27: each assertion names the defect that turns it RED, and the fixture is
-- built so the right and the wrong answers are DIFFERENT NUMBERS. The 1.1h2
-- post-mortem is the reason that sentence is here: a deliberate breakage stayed
-- green because the fixture made the two computations coincide.
--
-- FOUR DELIBERATE BREAKAGES WERE RUN AGAINST THIS BLOCK. Three go red and are
-- named in the assertions below: leaving the bucket out of the
-- valuation_difference arithmetic (case 2 reads -4000.00 again); valuing the
-- bucket at anything other than the position's average (case 2's bucket reads
-- 0.00); and inverting the unvaluable predicate so it values the VALUED
-- movements instead (case 1 reads 10000.00 against a count of 0).
--
-- AND ONE STAYS GREEN, which is recorded rather than hidden: dropping the
-- per-position round() from the `unval` CTE. This fixture cannot catch it,
-- because every unvaluable quantity in it multiplies out to an exact kobo
-- (-4 x 1000.00), so rounded and unrounded are the same number, and the final
-- cast to numeric(14,2) would absorb a sub-kobo difference anyway. The round()
-- is kept because it is where the VALUATION rounds -- `stock_on_hand.stock_value`
-- rounds once per position -- and a bucket that rounds somewhere else drifts from
-- it once enough positions carry sub-kobo fractions. Catching that honestly needs
-- a fixture with several fractional unvaluable positions whose errors accumulate
-- past half a kobo, which is a fixture worth building the day a second unvaluable
-- position exists on any real property. Today there are none.
--
-- THE FIXTURE UNDOES ITSELF BY ABORTING A SUBTRANSACTION, not by deleting its
-- rows. The first version ended with `delete from stock_movements` and the
-- migration failed on its own cleanup:
--
--     Stock movements are permanent and cannot be deleted. Correct the stock
--     with an adjustment instead.
--
-- which is `forbid_stock_movement_change` doing exactly its job (§6, append-only)
-- and is the same guard the restore runbook needs --disable-triggers for. There
-- is no polite way to delete a movement, and there should not be. So the whole
-- fixture runs inside a BEGIN/EXCEPTION block -- a subtransaction -- which is
-- then deliberately aborted with a sentinel. Every row it wrote is rolled back
-- by Postgres rather than removed by us. PL/pgSQL variables are NOT transactional,
-- so the figures asserted inside survive the abort and can be reported after it.
do $$
declare
  v_prop    uuid;
  v_tenant  uuid;
  v_loc     uuid;
  v_item    uuid;
  v_member  uuid;
  v_diff    numeric;
  v_unval   numeric;
  v_count   integer;
  v_cdiff   numeric;
  v_cunval  numeric;
  v_rdiff   numeric;
  v_runval  numeric;
  v_item2   uuid;
  v_done    boolean := false;
  v_claims  text := current_setting('request.jwt.claims', true);
begin
  -- A THROWAWAY PROPERTY, so every figure below is exact. Live test data makes
  -- an exact assertion impossible; a property created inside this transaction
  -- makes it arithmetic.
  select t.id into v_tenant from tenants t where t.deleted_at is null order by t.id limit 1;
  if v_tenant is null then
    raise notice '048 self-verify: no tenant on this database, skipped';
    return;
  end if;

  select tu.user_id into v_member
  from tenant_users tu where tu.tenant_id = v_tenant and tu.is_active
  order by tu.user_id limit 1;
  if v_member is null then
    raise notice '048 self-verify: no active member, skipped';
    return;
  end if;

  begin   -- the subtransaction that holds, and then discards, the whole fixture

  insert into properties (tenant_id, name, slug)
  values (v_tenant, 'ZZ 048 self-verify',
          'zz-048-' || substr(md5(random()::text), 1, 10))
  returning id into v_prop;

  insert into locations (tenant_id, property_id, name, kind)
  values (v_tenant, v_prop, 'ZZ 048 Store', 'store')
  returning id into v_loc;

  insert into inventory_items (tenant_id, name, item_type, base_unit, code)
  values (v_tenant, 'ZZ 048 Item', 'raw', 'kg',
          'ZZ-048-' || substr(md5(random()::text), 1, 8))
  returning id into v_item;

  perform set_config('request.jwt.claims',
                     json_build_object('sub', v_member, 'role', 'authenticated')::text,
                     true);

  -- --- 1. THE CLEAN CASE: a valued receipt only -----------------------------
  -- RED WHEN: the new bucket is computed from valuation_difference rather than
  -- from the movements, or leaks a value where there is no unvaluable movement.
  -- It is asserted FIRST and on DIFFERENT NUMBERS from case 2, so "it reads
  -- zero" cannot mean "it always reads zero".
  insert into stock_movements
    (tenant_id, property_id, location_id, inventory_item_id, movement_type,
     quantity, unit_cost, business_date, created_by)
  values (v_tenant, v_prop, v_loc, v_item, 'receipt', 10, 1000, '2026-10-05', v_member);

  select r.valuation_difference, r.unvaluable_value, r.unvaluable_movement_count
    into v_cdiff, v_cunval, v_count
  from inventory_gl_reconciliation(v_prop) r;

  if v_cunval <> 0 or v_count <> 0 then
    raise exception
      'ASSERT FAILED (clean case): no movement lacks a basis, yet unvaluable_value=% count=%',
      v_cunval, v_count;
  end if;
  if v_cdiff <> 0 then
    raise exception
      'ASSERT FAILED (clean case): valuation_difference=% on a single valued receipt', v_cdiff;
  end if;

  -- --- 2. THE DEFECT CASE ---------------------------------------------------
  -- A BACK-DATED write-off, so set_stock_carried_cost finds no average strictly
  -- before it and leaves carried_unit_cost NULL. The fold then orders it FIRST,
  -- the position goes negative, and the later receipt resets the average -- which
  -- is what makes the hole worth exactly 4 x 1000.
  --
  -- RED WHEN: the unvaluable bucket is removed from the valuation_difference
  -- arithmetic (it returns to -4000.00), or the bucket is valued at something
  -- other than the position's average (it stops being -4000.00 while the
  -- difference stops being 0.00). Before this migration this case read
  -- valuation_difference = -4000.00 and had no bucket at all.
  insert into stock_movements
    (tenant_id, property_id, location_id, inventory_item_id, movement_type,
     quantity, business_date, reason, reason_code, created_by)
  values (v_tenant, v_prop, v_loc, v_item, 'wastage', -4, '2026-10-01',
          '048 self-verify: back-dated write-off with no cost history', 'spoilage', v_member);

  select r.valuation_difference, r.unvaluable_value, r.unvaluable_movement_count
    into v_diff, v_unval, v_count
  from inventory_gl_reconciliation(v_prop) r;

  if v_count <> 1 then
    raise exception 'ASSERT FAILED (defect case): expected 1 unvaluable movement, got %', v_count;
  end if;
  if v_unval <> -4000.00 then
    raise exception
      'ASSERT FAILED (defect case): unvaluable_value=% but the write-off moved 4 units at an average of 1000.00',
      v_unval;
  end if;
  if v_diff <> 0 then
    raise exception
      'ASSERT FAILED (defect case): valuation_difference=% -- the unvaluable value is not being accounted for',
      v_diff;
  end if;

  -- --- 3. THE ONE THAT CATCHES A PLUG --------------------------------------
  -- CASES 1 AND 2 ARE NOT ENOUGH, and this was proved rather than assumed. If
  -- `unvaluable_value` were defined as the difference it is meant to explain --
  --
  --     val.value - (expected + pre_gl + pre_wiring + non_posting)
  --
  -- -- then it would be true by construction, could never be wrong, and WOULD
  -- PASS BOTH CASES ABOVE: zero on the clean one, -4000.00 on the defect one.
  -- That variant was built and run, and it came back green. It is rule 27's
  -- first shape exactly: an assertion that recomputes the answer it is checking.
  --
  -- What separates the honest computation from the plug is a fixture where
  -- SOMETHING ELSE is also out: genuine per-movement rounding. The honest bucket
  -- values only the unvaluable quantity and leaves the kobo where it belongs; the
  -- plug swallows the kobo too and reports a difference of exactly zero.
  --
  -- A SECOND position does it, on a different item so the first is untouched:
  -- two receipts of 0.3333 kg at 10.00.
  --
  -- THE RESIDUE HAS TO COME FROM THE QUANTITY, NOT THE COST, and the first
  -- attempt got that wrong: it used two receipts of 1 unit at 0.3333, which
  -- produces no residue at all because `unit_cost` is numeric(14,2) and stores
  -- 0.3333 as 0.33. `quantity` is numeric(14,4) (§6: four decimals, because
  -- recipe ingredients and bar measures are fractional), so the fraction has to
  -- live there.
  --
  -- The ledger books round(0.3333 * 10.00, 2) = 3.33, twice, = 6.66. The
  -- valuation folds at full precision -- 0.6666 kg at an average of 10.0000 --
  -- and rounds once: round(6.666, 2) = 6.67. One kobo, from exactly the rounding
  -- this figure is documented to be made of (§6: the ledger sums per-movement
  -- values each rounded to the kobo while the valuation carries an average at
  -- full precision).
  --
  -- RED WHEN: the bucket is a plug. Honest -> unvaluable_value stays exactly
  -- -4000.00 and valuation_difference becomes exactly 0.01. Plug -> the bucket
  -- reads -3999.99 and the difference reads 0.00. DIFFERENT NUMBERS, which is the
  -- whole point (rule 27, fourth shape, learned in 1.1h2).
  insert into inventory_items (tenant_id, name, item_type, base_unit, code)
  values (v_tenant, 'ZZ 048 Rounding Item', 'raw', 'kg',
          'ZZ-048R-' || substr(md5(random()::text), 1, 8))
  returning id into v_item2;

  insert into stock_movements
    (tenant_id, property_id, location_id, inventory_item_id, movement_type,
     quantity, unit_cost, business_date, created_by)
  values (v_tenant, v_prop, v_loc, v_item2, 'receipt', 0.3333, 10.00, '2026-10-06', v_member),
         (v_tenant, v_prop, v_loc, v_item2, 'receipt', 0.3333, 10.00, '2026-10-07', v_member);

  select r.valuation_difference, r.unvaluable_value
    into v_rdiff, v_runval
  from inventory_gl_reconciliation(v_prop) r;

  if v_runval <> -4000.00 then
    raise exception
      'ASSERT FAILED (plug case): unvaluable_value=% beside a rounding residue. The honest bucket values only the unvaluable quantity and stays at -4000.00; a plug absorbs the kobo and reads -3999.99.',
      v_runval;
  end if;
  if v_rdiff <> 0.01 then
    raise exception
      'ASSERT FAILED (plug case): valuation_difference=% but one kobo of genuine rounding was introduced. A plug reports 0.00 here by swallowing it.',
      v_rdiff;
  end if;

  -- THE SENTINEL. Everything the fixture wrote is discarded by aborting this
  -- subtransaction; the figures above are already in variables, which an abort
  -- does not touch.
  raise exception 'ZZ_048_FIXTURE_DONE';

  exception
    when others then
      if sqlerrm <> 'ZZ_048_FIXTURE_DONE' then
        -- A REAL failure -- an assertion above, or anything else -- is re-raised
        -- unchanged, so the migration fails loudly and nothing is applied.
        raise;
      end if;
      v_done := true;
  end;

  if not v_done then
    raise exception '048 self-verify did not reach its sentinel, so its assertions did not all run';
  end if;

  perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);

  raise notice
    '048 self-verify: 4 assertions passed on a fixture that rolled itself back. Clean: unvaluable_value %, difference %. Defect: unvaluable_value %, difference % (was -4000.00 before 048). Plug-catcher: unvaluable_value %, difference % (a plug reads -3999.99 / 0.00 here).',
    v_cunval, v_cdiff, v_unval, v_diff, v_runval, v_rdiff;
end $$;

-- ============================================================================
-- End of 048_unvaluable_gets_a_bucket.sql
-- ============================================================================
