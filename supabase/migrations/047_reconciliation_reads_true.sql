-- ============================================================================
-- 047_reconciliation_reads_true.sql
-- Palstro-Hotels: the two reconciliation surfaces 046 shipped, made to tell the
-- truth on a database that existed BEFORE the posting did.
-- ============================================================================
--
-- ----------------------------------------------------------------------------
-- THE DEFECT, FOUND BY LOOKING AT LIVE RATHER THAN AT THE DRY RUN
-- ----------------------------------------------------------------------------
-- 046's dry run ran against a property created inside the transaction, so every
-- movement it saw was written by a posting RPC. Heledon is not that database. It
-- holds EIGHT movements written during the build — six openings, an adjustment
-- and its reversal — none of which posted, because on the day they were written
-- nothing posted.
--
-- On live, therefore, 046's two surfaces both lie:
--
--   stock_movements_unposted listed all 8 with reason_unposted NULL — which is
--   the ALARM, the signal reserved for "stock moved and the ledger never heard
--   about it". A list that cries wolf on its first day is a list nobody opens on
--   the day it finally means something. That is the whole value of the view,
--   spent before anybody looked at it.
--
--   inventory_gl_reconciliation read a ledger_difference of -533,000.00 — the
--   figure that is supposed to be ZERO ALWAYS, and whose entire worth is that it
--   is alarming. A reconciliation that opens permanently red is a reconciliation
--   with a fudge factor, whether or not anybody writes the fudge factor down.
--
-- ----------------------------------------------------------------------------
-- THE FIX IS A RECORDED FACT, NOT A TOLERANCE
-- ----------------------------------------------------------------------------
-- A movement written before the posting code existed COULD NOT HAVE POSTED. That
-- is not an excuse for a gap, it is the reason there is no gap — the same kind of
-- statement gl_start_date already makes, and it is checkable rather than
-- assumed. So the instant is RECORDED, once, here, and both surfaces read it.
--
-- WHAT WOULD HAVE BEEN A FUDGE, and was rejected: widening the alarm to "ignore
-- anything older than N days", or setting gl_start_date on Heledon to silence
-- it. The first is a tolerance dressed as a filter. The second pre-empts a named
-- go-live step, and would ALSO be wrong: gl_start_date is a business boundary a
-- person chooses, and 044's writer deliberately refuses to move it once anything
-- has posted. Borrowing it to paper over a technical fact would spend it.
--
-- THE TWO DATES ARE NOT THE SAME THING, and the pair needs saying out loud
-- because they now sit in the same table:
--   gl_start_date  THE DAY THE BOOKS OPEN. A POLICY, chosen by a person, about
--                  BUSINESS dates. Set once at go-live.
--   gl_wired_at    THE INSTANT THIS PROPERTY'S RPCs BEGAN POSTING. A FACT about
--                  the code, stamped by a migration, about ROW CREATION times.
--
-- ----------------------------------------------------------------------------
-- AND created_at IS THE RIGHT COLUMN HERE, WHICH IS UNUSUAL ENOUGH TO STATE
-- ----------------------------------------------------------------------------
-- Rules 8 and 12 say business_date, never created_at, for anything user-facing —
-- and they are about WHEN SOMETHING HAPPENED IN THE HOTEL. This is not that
-- question. This asks WHEN THE ROW WAS WRITTEN, because that is what decides
-- whether the function that posts existed at the time. A back-dated movement
-- keyed today posts today and must NOT be excused by its business date; a
-- movement written last month cannot be posted by code deployed this month
-- whatever date it carries. created_at is the only column that answers it.
--
-- ----------------------------------------------------------------------------
-- TWO THINGS THE RECONCILIATION NOW SHOWS THAT IT DID NOT
-- ----------------------------------------------------------------------------
--   1. THE RESIDUE, BESIDE THE NUMBER OF MOVEMENTS IT ACCUMULATED OVER. A kobo
--      across forty movements is arithmetic. The same kobo across four thousand
--      is something else entirely, and the only way anybody notices the
--      difference is if both figures are on the screen together. Rounding scales
--      with the count; a real error does not.
--   2. WHICH POSITIONS HAVE PASSED THROUGH NEGATIVE, which 046 got WRONG rather
--      than merely left out. It reported positions holding less than nothing
--      TODAY — and that is a different set from the one that causes the
--      divergence. The fold resets the average when stock arrives INTO a
--      negative position (038 §5.1), after which the position is usually
--      POSITIVE again and 046's count could not see it. The real test is whether
--      the running quantity was EVER below zero, which is a window function over
--      the movement history and is what §3.2 computes.
--
-- ----------------------------------------------------------------------------
-- RE-RUNNABLE. Applying this file twice in one transaction is a clean no-op.
-- ============================================================================


-- ############################################################################
-- SECTION 1 — gl_wired_at
-- ############################################################################
alter table property_finance_settings
  add column if not exists gl_wired_at timestamptz;

comment on column property_finance_settings.gl_wired_at is
  'THE INSTANT THIS PROPERTY''S STOCK RPCs BEGAN POSTING TO THE LEDGER — stamped '
  'by 047, and by the settings-row default for any property created afterwards. '
  'A movement whose created_at precedes it COULD NOT have posted, because the '
  'function that posts did not exist; that is a recorded FACT and not a '
  'tolerance, which is the difference between this and silencing the alarm. '
  'NOT THE SAME AS gl_start_date, and the pair is easy to confuse: gl_start_date '
  'is a POLICY a person chooses about BUSINESS dates (the day the books open), '
  'while this is a FACT about the CODE, compared against row CREATION times. '
  'Rules 8/12 say business_date for anything user-facing and they are right; '
  'this asks when the row was WRITTEN, which is the only question created_at can '
  'answer.';

-- ----------------------------------------------------------------------------
-- 1.1 Stamped once, for every property that exists today
-- ----------------------------------------------------------------------------
-- now() is the transaction's start time, so every property gets the SAME instant
-- — which is correct: they all began posting when this migration ran.
--
-- ONLY WHERE IT IS NULL, so re-running this file never moves a stamp that has
-- already been set. A moved stamp would silently re-explain movements that had
-- genuinely failed to post, which is the one thing this column must never do.
update property_finance_settings
   set gl_wired_at = now()
 where gl_wired_at is null;

-- A property created from here on starts posting the moment it exists.
alter table property_finance_settings
  alter column gl_wired_at set default now();


-- ############################################################################
-- SECTION 2 — stock_movements_unposted learns the sixth reason
-- ############################################################################
-- Re-emitted whole. The new branch sits AFTER gl_start_date and before the
-- cost-basis branch, and that order is a decision: a movement can satisfy both
-- date tests, and "dated before the books opened" is the more meaningful
-- sentence — it is a statement about the hotel's accounts, while "recorded
-- before the posting was wired" is a statement about a deployment. Where both
-- are true, say the one the reader can act on.
--
-- THE ALARM IS UNCHANGED AND IS STILL THE SIXTH CASE: reason_unposted NULL means
-- stock moved, after the wiring, inside the books, with a cost, worth more than
-- nothing — and the ledger never heard about it.
create or replace view stock_movements_unposted
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
  m.business_date,
  m.created_at,
  m.source,
  m.source_document_type,
  m.reason,
  case
    when m.movement_type = 'reversal' then round(abs(m.quantity) * m.carried_unit_cost, 2)
    when m.quantity > 0               then round(m.quantity * m.unit_cost, 2)
    else                                   round(-m.quantity * m.carried_unit_cost, 2)
  end::numeric(14,2)                                     as unposted_value,
  case
    when m.source_document_type = 'purchase_receipt'
      then 'Booked with its goods receipt, which posts one entry for the whole delivery'
    when m.movement_type in ('issue_out', 'issue_in', 'transfer_out', 'transfer_in')
      then 'Moves stock between two locations of one property, so the property holds the same value and there is nothing to book'
    when pfs.gl_start_date is not null and m.business_date < pfs.gl_start_date
      then 'Dated before the books opened for this property'
    -- 047: RECORDED BEFORE THE CODE THAT POSTS EXISTED. A fact, not a tolerance.
    when pfs.gl_wired_at is not null and m.created_at < pfs.gl_wired_at
      then 'Recorded before this property''s stock movements began posting to the ledger, so there was nothing to post it'
    when (case when m.movement_type = 'reversal' then m.carried_unit_cost
               when m.quantity > 0               then m.unit_cost
               else                                   m.carried_unit_cost end) is null
      then 'No cost basis, so booking it would mean guessing what the stock was worth'
    when (case
            when m.movement_type = 'reversal' then round(abs(m.quantity) * m.carried_unit_cost, 2)
            when m.quantity > 0               then round(m.quantity * m.unit_cost, 2)
            else                                   round(-m.quantity * m.carried_unit_cost, 2)
          end) = 0
      then 'Its value rounds to nothing, so there is no entry to make'
    -- NULL: NOT EXPLAINED. This is the alarm.
    else null
  end                                                    as reason_unposted
from stock_movements m
left join property_finance_settings pfs
  on pfs.property_id = m.property_id
where not exists (
  select 1 from journal_entries je
  where je.tenant_id = m.tenant_id
    and je.source_document_type = 'stock_movement'
    and je.source_document_id   = m.id
);

comment on view stock_movements_unposted is
  'EVERY MOVEMENT WITH NO JOURNAL ENTRY, WITH THE REASON. This is what replaces '
  'the guarantee an after-insert trigger would have given (046 §4): the posting '
  'cannot be made impossible to forget, so it is made impossible to forget '
  'QUIETLY. SIX reasons are legitimate and expected — 047 adds the sixth, '
  'recorded-before-the-wiring, because without it every movement written during '
  'the build read as the alarm and the view cried wolf from its first day. '
  'reason_unposted NULL is still the alarm and still means exactly one thing: '
  'stock moved, after the wiring, inside the books, with a cost, and the ledger '
  'never heard about it — sized in naira by unposted_value.';


-- ############################################################################
-- SECTION 3 — the reconciliation reads true, and says more
-- ############################################################################
-- Re-emitted whole, with three changes. The INVARIANT is unchanged and is still
-- the point:
--
--     ledger_balance === expected_ledger_balance, TO THE KOBO, ALWAYS.
--
-- What 047 changes is which movements the right-hand side is entitled to expect
-- an entry for — the ones written after the code that posts existed — and what
-- sits beside the residue so a reader can tell arithmetic from an error.

-- ----------------------------------------------------------------------------
-- 3.1 inventory_gl_reconciliation
-- ----------------------------------------------------------------------------
drop function if exists inventory_gl_reconciliation(uuid);

create or replace function inventory_gl_reconciliation(p_property_id uuid)
returns table (
  property_id             uuid,
  account_id              uuid,
  account_code            text,
  account_name            text,
  ledger_balance          numeric(14,2),
  expected_ledger_balance numeric(14,2),
  -- MUST BE ZERO. Anything else is a posting skipped, doubled, or misdirected.
  ledger_difference       numeric(14,2),
  -- Value that legitimately never reached the ledger, split three ways so the
  -- arithmetic below is complete rather than approximately complete.
  pre_gl_value            numeric(14,2),
  -- 047: written before the posting code existed.
  pre_wiring_value        numeric(14,2),
  non_posting_value       numeric(14,2),
  unvaluable_movement_count integer,
  valuation_value         numeric(14,2),
  -- Per-movement rounding, plus any position that has passed through negative.
  -- NOT required to be zero, and never absorbed anywhere.
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
      -- Books something by type but has no cost basis. Absent from the ledger
      -- AND from the valuation, so it cancels out — COUNTED rather than valued,
      -- because valuing it would mean inventing the figure it does not have.
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
    val.value,
    (val.value - (totals.expected_balance + totals.pre_gl_total
                  + totals.pre_wiring_total + totals.non_posting))::numeric(14,2),
    totals.valued_n,
    resets.n,
    val.negatives
  from totals
  cross join led
  cross join val
  cross join resets
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
  '047 excludes from the right-hand side any movement written BEFORE this '
  'property''s gl_wired_at, because code that did not exist cannot have posted — '
  'a recorded fact, not a tolerance, and without it Heledon''s own build data '
  'made this figure open permanently red. valuation_difference is a DIFFERENT '
  'figure and is NOT required to be zero: per-movement rounding (money has two '
  'decimals, a moving average does not) plus any position that has passed '
  'through negative. 047 reports valued_movement_count beside it — a kobo across '
  'forty movements is arithmetic, the same kobo across four thousand is not — '
  'and reset_position_count, which counts positions that have EVER been below '
  'zero rather than the ones below zero today. Those are different sets, and 046 '
  'reported the wrong one: the fold resets the average when stock arrives INTO a '
  'negative position, after which it is usually positive again.';


-- ----------------------------------------------------------------------------
-- 3.2 inventory_gl_reconciliation_positions — and WHY each one differs
-- ----------------------------------------------------------------------------
-- A difference at the property level is a number. A difference on ONE shelf is a
-- question somebody can answer — and with `passed_through_negative` beside it,
-- it is a question that answers itself:
--
--   "Rice in the Main Store: the ledger says 181,500.00 and the valuation says
--    173,000.00. This position went below zero at some point, so when stock next
--    arrived the average was reset to the incoming cost."
--
-- That is a sentence a hotel owner can act on. An unexplained variance is one
-- they will either ignore or panic about, and both are worse than the truth.
drop function if exists inventory_gl_reconciliation_positions(uuid);

create or replace function inventory_gl_reconciliation_positions(p_property_id uuid)
returns table (
  location_id         uuid,
  location_name       text,
  inventory_item_id   uuid,
  item_name           text,
  item_code           text,
  base_unit           text,
  quantity_on_hand    numeric(14,4),
  movement_value      numeric(14,2),
  valuation_value     numeric(14,2),
  difference          numeric(14,2),
  -- How many movements this position's difference accumulated over.
  movement_count      integer,
  -- HAS IT EVER BEEN BELOW ZERO? The explanation for any difference larger than
  -- a few kobo, and it is emphatically NOT "is it below zero now".
  passed_through_negative boolean
)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_tenant uuid;
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

  return query
  with walked as (
    -- THE FOLD'S OWN ORDER (036 §2): business date first, then seq. Any other
    -- order would answer a different question, because a weighted average is
    -- path-dependent and so is the moment it crossed zero.
    select
      sm.location_id,
      sm.inventory_item_id,
      sm.movement_type,
      sm.quantity,
      sm.unit_cost,
      sm.carried_unit_cost,
      sum(sm.quantity) over (
        partition by sm.location_id, sm.inventory_item_id
        order by sm.business_date, sm.seq
        rows between unbounded preceding and current row
      ) as running
    from stock_movements sm
    where sm.property_id = p_property_id
  ),
  m as (
    select
      w.location_id,
      w.inventory_item_id,
      coalesce(sum(
        case
          when w.movement_type in ('issue_out', 'issue_in', 'transfer_out', 'transfer_in')
            then 0
          when w.movement_type = 'reversal'
            then sign(w.quantity) * round(abs(w.quantity) * w.carried_unit_cost, 2)
          when w.quantity > 0
            then round(w.quantity * w.unit_cost, 2)
          else -round(-w.quantity * w.carried_unit_cost, 2)
        end
      ), 0)::numeric(14,2) as mv,
      count(*)::integer    as moves,
      (min(w.running) < 0) as went_negative
    from walked w
    group by w.location_id, w.inventory_item_id
  )
  select
    soh.location_id,
    l.name,
    soh.inventory_item_id,
    i.name,
    i.code,
    i.base_unit,
    soh.quantity_on_hand,
    coalesce(m.mv, 0)::numeric(14,2),
    soh.stock_value,
    (soh.stock_value - coalesce(m.mv, 0))::numeric(14,2),
    coalesce(m.moves, 0),
    coalesce(m.went_negative, false)
  from stock_on_hand soh
  join locations l        on l.id = soh.location_id
  join inventory_items i  on i.id = soh.inventory_item_id
  left join m
    on m.location_id = soh.location_id
   and m.inventory_item_id = soh.inventory_item_id
  where soh.property_id = p_property_id
  order by abs(soh.stock_value - coalesce(m.mv, 0)) desc,
           l.name, i.name;
end;
$$;

comment on function inventory_gl_reconciliation_positions(uuid) is
  'The same reconciliation per (location, item), ordered by the SIZE of the '
  'difference, with the number of movements it accumulated over and — 047 — '
  'whether that position has EVER been below zero. The last column is the '
  'explanation for any difference beyond a few kobo: the fold resets the average '
  'when stock arrives into a negative position (038 §5.1), so the position is '
  'usually POSITIVE again by the time anybody looks. It is computed from the '
  'running total in the fold''s own order, never from the closing quantity. '
  'Deliberately not filtered to non-zero rows: a position that reconciles '
  'exactly is the evidence that the ones which do not are the exception.';


-- ############################################################################
-- SECTION 4 — GRANTS
-- ############################################################################
-- §3 dropped and recreated both functions, which took their grants with them.
revoke all     on function inventory_gl_reconciliation(uuid) from public;
revoke execute on function inventory_gl_reconciliation(uuid) from anon;
grant  execute on function inventory_gl_reconciliation(uuid) to authenticated;

revoke all     on function inventory_gl_reconciliation_positions(uuid) from public;
revoke execute on function inventory_gl_reconciliation_positions(uuid) from anon;
grant  execute on function inventory_gl_reconciliation_positions(uuid) to authenticated;

do $$
begin
  perform assert_no_anon_security_definer();
end $$;


-- ############################################################################
-- SECTION 5 — IN-TRANSACTION SELF-VERIFY
-- ############################################################################
-- Rule 27 applies here as much as anywhere: each assertion names the defect that
-- turns it RED.
do $$
declare
  v_n      integer;
  v_prop   uuid;
  v_member uuid;
  v_alarm  integer;
  v_def    text;
  -- WHATEVER SESSION THE CALLER HAD, captured so it can be put back exactly.
  -- A migration has none; a dry-run harness running this file inside its own
  -- transaction has one, and the first version of this block reset the claim to
  -- '' rather than restoring it — which logged the harness out halfway through
  -- its own run. Restoring a value is not the same as clearing one.
  v_claims text := current_setting('request.jwt.claims', true);
begin
  -- --- 1. EVERY PROPERTY IS STAMPED ---------------------------------------
  -- RED WHEN: the backfill is dropped, or a property is created without a
  -- settings row. An unstamped property explains nothing, so every movement it
  -- ever wrote reads as the alarm — which is the exact defect this file exists
  -- to fix, reappearing silently for one hotel.
  select count(*)::integer into v_n
  from properties p
  left join property_finance_settings pfs on pfs.property_id = p.id
  where p.deleted_at is null
    and (pfs.property_id is null or pfs.gl_wired_at is null);

  if v_n > 0 then
    raise exception
      'ASSERT FAILED: % live propert(ies) have no gl_wired_at, so their build-era movements will read as unexplained', v_n;
  end if;

  -- --- 2. THE ALARM LIST IS EMPTY ------------------------------------------
  -- RED WHEN: the new branch is removed, its comparison is flipped, or a
  -- movement genuinely moved stock without posting. THE POINT OF THE WHOLE FILE:
  -- before it, this counted 8 on Heledon and the view cried wolf from day one.
  --
  -- It is a REAL assertion rather than a tautology because the branch is dated:
  -- a movement written AFTER the stamp with no entry still has no reason and
  -- still trips this.
  select count(*)::integer into v_alarm
  from stock_movements_unposted where reason_unposted is null;

  if v_alarm > 0 then
    raise exception
      'ASSERT FAILED: % movement(s) moved stock and the ledger never heard about it', v_alarm;
  end if;

  -- --- 3. THE LEDGER AGREES ON EVERY LIVE PROPERTY -------------------------
  -- RED WHEN: pre-wiring movements are counted into expected_ledger_balance, or
  -- a posting is skipped anywhere. Before this file Heledon read -533,000.00.
  --
  -- THE BORROWED SESSION, AND WHY IT IS HERE. inventory_gl_reconciliation is
  -- staff-gated on auth.uid(), and A MIGRATION HAS NO SESSION — auth.uid() is
  -- NULL, is_tenant_staff fails closed, and the function refuses. The first
  -- version of this block called it anyway and APPLIED CLEANLY IN THE DRY RUN,
  -- because the dry-run harness sets request.jwt.claims to make the RPCs
  -- callable; the real push then failed at this statement. A harness more
  -- permissive than production is a harness that certifies nothing.
  --
  -- Setting the claim to a real ACTIVE MEMBER of the property's own tenant is
  -- what lets the assertion test THE FUNCTION rather than a copy of its
  -- arithmetic — and a copy would be rule 27's first shape, an assertion that
  -- recomputes the answer it is checking. set_config(..., true) is
  -- transaction-local, so it is gone when this migration commits.
  for v_prop, v_member in
    select p.id,
           (select tu.user_id from tenant_users tu
             where tu.tenant_id = p.tenant_id and tu.is_active
             order by tu.user_id limit 1)
    from properties p where p.deleted_at is null
  loop
    -- A tenant with no active member cannot be checked and is not a failure of
    -- this assertion; it is a tenant nobody can log into.
    continue when v_member is null;

    perform set_config('request.jwt.claims',
                       json_build_object('sub', v_member, 'role', 'authenticated')::text,
                       true);
    begin
      select r.ledger_difference into v_def
      from inventory_gl_reconciliation(v_prop) r;
    exception
      -- A property whose `inventory` key is unmapped cannot be reconciled, and
      -- that is resolve_account refusing loudly (rule 4) rather than a failure
      -- of this assertion. Stepped over BY NAME, never by a bare catch-all.
      when sqlstate 'PT424' then
        v_def := null;
    end;

    if v_def is not null and v_def::numeric <> 0 then
      raise exception
        'ASSERT FAILED: property % has a ledger difference of %', v_prop, v_def;
    end if;
  end loop;

  -- Put the session back EXACTLY as it was found, which for a migration is
  -- nothing and for a harness is its own signed-in user.
  perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);

  -- --- 4. THE RESET TEST IS A WINDOW, NOT A CLOSING BALANCE ----------------
  -- RED WHEN: somebody "simplifies" passed_through_negative to
  -- quantity_on_hand < 0 — which reports a DIFFERENT set and misses exactly the
  -- positions that caused a divergence, because they are positive again by then.
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'inventory_gl_reconciliation_positions';

  if v_def is null or position('rows between unbounded preceding' in v_def) = 0 then
    raise exception
      'ASSERT FAILED: the passed-through-negative test is no longer a running window over the movement history';
  end if;

  raise notice '047 self-verify: 4 assertions passed (alarm list: %, properties stamped)', v_alarm;
end $$;

-- ============================================================================
-- End of 047_reconciliation_reads_true.sql
-- ============================================================================
