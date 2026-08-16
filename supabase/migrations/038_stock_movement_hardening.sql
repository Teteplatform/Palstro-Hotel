-- ============================================================================
-- 038_stock_movement_hardening.sql
-- Palstro-Hotels: the things the stock ledger must be able to do BEFORE any
-- further write path is built on top of it. F&B/Inventory 1.1b.
--
-- ----------------------------------------------------------------------------
-- WHY THIS FILE COMES BEFORE RECEIVE, WRITE-OFF, REQUISITION AND CONSUMPTION
-- ----------------------------------------------------------------------------
-- Every one of those tranches posts movements. Whatever this file establishes,
-- they inherit; whatever it omits, they will each have to invent, and the two
-- things below cannot be retrofitted at all once history exists:
--
--   * REVERSAL. A ledger with no reversal path grows corrections that look like
--     ordinary adjustments, and a year later nobody can tell an error from a
--     theft. Adding reversal after the fact cannot re-label the corrections
--     already posted.
--   * CARRIED COST. What a unit of stock cost ON THE WAY OUT is knowable only at
--     the moment it leaves. Recomputing it later means re-folding history under
--     whatever rules exist then, which is exactly how two reports come to
--     disagree about the same carton.
--
-- So this migration deliberately builds more than a 30-room hotel needs today
-- (batch codes, expiry dates, a posting lock) — because each of them is cheap
-- now and a data-migration later.
--
-- ----------------------------------------------------------------------------
-- WHAT IS AND IS NOT HERE
-- ----------------------------------------------------------------------------
-- IS:  A movement reversal path with a manager PIN and a permanent audit row;
--      carried cost on every stock-out; batch/expiry columns and the item flag
--      that arms them; a per-property posting lock date; a negative-stock view;
--      and removal/deactivation guards that name what is in the way.
-- IS NOT: stock takes as a counted document (039 — deliberately split out, it is
--      a shipment in its own right), selling prices, outlet prices, item photos,
--      the receive path, write-offs, requisitions, or any change to the upload
--      template.
--
-- ----------------------------------------------------------------------------
-- ON THE ABSENCE OF AN EXPLICIT BEGIN/COMMIT — a deliberate deviation
-- ----------------------------------------------------------------------------
-- Migrations 001-037 carry no explicit transaction control, and this one follows
-- them. `supabase db push` already wraps each migration file in a single
-- transaction, so an explicit BEGIN here would raise "there is already a
-- transaction in progress" and the matching COMMIT would end the CLI's
-- transaction EARLY — after which any later failure would leave a half-applied
-- migration committed. The single-transaction guarantee is real; adding the
-- keywords would destroy it rather than assert it.
--
-- ----------------------------------------------------------------------------
-- CONVENTIONS INHERITED — all load-bearing
-- ----------------------------------------------------------------------------
--   * Money numeric(14,2), quantities and unit costs at fold precision
--     numeric(14,4) (§6). Both arrive over PostgREST as STRINGS.
--   * business_date, never created_at, for anything a person reads (rules 8/12).
--   * Rules 2/3: every write RPC takes p_idempotency_key and there is a partial
--     unique index behind it.
--   * Rule 19: RLS is the floor. Every guard here is at the database, in the
--     path that performs the act — never in the UI.
--   * Rule 6: nothing is cached. carried_unit_cost is NOT a cache — see §6.
-- ============================================================================


-- ############################################################################
-- SECTION 1 — The new columns on stock_movements
-- ############################################################################

alter table stock_movements
  -- ------------------------------------------------------------------------
  -- WHAT THIS STOCK COST ON THE WAY OUT. numeric(14,4), fold precision.
  -- ------------------------------------------------------------------------
  -- Set on EVERY movement with a negative quantity, by the trigger in §6, to
  -- the moving-average cost of that item in that location as at that movement.
  --
  -- THIS IS NOT A CACHE COLUMN (rule 6), and the distinction is exact rather
  -- than semantic. A cache stores a value that is also derivable NOW, so it can
  -- drift from the truth and must ship with a recompute function. This stores a
  -- value that is derivable ONLY AT THE INSTANT IT IS WRITTEN: it is the cost
  -- the stock actually left at, and once later movements land the fold can no
  -- longer reproduce it. It is the same class of column as booking_nights'
  -- locked rate — a fact captured at the moment it was true.
  --
  -- COST OF SALE IS READ FROM HERE AND NEVER RECOMPUTED. That rule is recorded
  -- in CLAUDE.md §6 as well, because it is the kind of rule a later report will
  -- otherwise "helpfully" re-derive and quietly disagree with the P&L.
  add column if not exists carried_unit_cost numeric(14,4),

  -- ------------------------------------------------------------------------
  -- THE FORWARD POINTER: this movement undoes that one.
  -- ------------------------------------------------------------------------
  -- Set at INSERT on a 'reversal' row and never afterwards, which is what lets
  -- it coexist with the immutability trigger (036 §1.4) untouched.
  --
  -- THERE IS DELIBERATELY NO reversed_by_movement_id COLUMN. It cannot be
  -- written: forbid_stock_movement_change() refuses every UPDATE on this table,
  -- and weakening that trigger to admit one convenience column would put a hole
  -- in the single guarantee the whole ledger rests on. It is also redundant —
  -- the partial unique index below already makes "reversed once, ever" true, and
  -- "was this reversed, and by what" is one lookup, which stock_movement_ledger
  -- now exposes as a derived column (§5.4).
  add column if not exists reverses_movement_id uuid,

  -- ------------------------------------------------------------------------
  -- BATCH AND EXPIRY. Captured now, consumed by a later FEFO or recall build.
  -- ------------------------------------------------------------------------
  -- Nothing in this migration reads them and no report groups by them yet. They
  -- are here because a recall ("which rooms got the milk from batch 4471?") can
  -- only ever be answered from history that was recorded at the time — there is
  -- no backfill for a batch code nobody wrote down.
  add column if not exists batch_code text,
  add column if not exists expiry_date date;

comment on column stock_movements.carried_unit_cost is
  'What ONE base unit of this stock cost ON THE WAY OUT — the moving-average '
  'cost of the item in the location as at this movement, stamped by a trigger on '
  'every negative-quantity row. NOT A CACHE (rule 6): it is derivable only at the '
  'instant it is written, exactly like booking_nights'' locked rate, and later '
  'movements make it unreproducible. COST OF SALE IS READ FROM THIS COLUMN AND '
  'NEVER RECOMPUTED. On a ''reversal'' row it holds the cost basis being unwound '
  'and IS read by the valuation fold (§5).';
comment on column stock_movements.reverses_movement_id is
  'The movement this one undoes. Set at INSERT on a ''reversal'' row, never '
  'updated. There is no reverse pointer by design: the immutability trigger '
  'refuses every UPDATE, and the partial unique index on this column already '
  'makes a movement reversible once, ever. stock_movement_ledger derives '
  'reversed_by_movement_id for readers.';
comment on column stock_movements.batch_code is
  'The supplier''s batch/lot code, where the item tracks one. Required on a '
  'stock-IN when inventory_items.tracks_expiry is set (enforced in the RPCs, not '
  'as a CHECK — it is a cross-table rule). Nothing reads it yet; it exists so a '
  'future recall has history to work with, which no backfill could ever provide.';
comment on column stock_movements.expiry_date is
  'The batch''s expiry date. Required alongside batch_code on a stock-IN when the '
  'item tracks expiry. Deliberately unconstrained against the business date: '
  'stock that arrives already expired is a real delivery and must be recordable, '
  'and refusing it would only teach the storekeeper to type a fake date.';


-- ----------------------------------------------------------------------------
-- 1.1 Constraints on the new columns
-- ----------------------------------------------------------------------------
-- Each added under its own guarded name so a re-run is a plain no-op and so a
-- violation names itself in the error the user sees.
do $$
begin
  -- A cost is never negative. Same rule as unit_cost (036 §1).
  if not exists (select 1 from pg_constraint
                 where conname = 'stock_movements_carried_cost_sign_check') then
    alter table stock_movements
      add constraint stock_movements_carried_cost_sign_check
      check (carried_unit_cost is null or carried_unit_cost >= 0);
  end if;

  -- A 'reversal' row MUST carry both its target and its cost basis, and no other
  -- row type may carry a target. Written as an equivalence rather than two
  -- one-way checks so neither half can be satisfied alone: a reversal with no
  -- target is unattributable, and a non-reversal with a target would be read by
  -- the fold as an ordinary movement while claiming to undo something.
  if not exists (select 1 from pg_constraint
                 where conname = 'stock_movements_reversal_shape_check') then
    alter table stock_movements
      add constraint stock_movements_reversal_shape_check
      check ((movement_type = 'reversal') = (reverses_movement_id is not null));
  end if;

  -- The fold reads carried_unit_cost on a reversal row (§5). A reversal without
  -- one would fall through to the ordinary stock-out branch and leave the
  -- residue this migration exists to remove.
  if not exists (select 1 from pg_constraint
                 where conname = 'stock_movements_reversal_cost_check') then
    alter table stock_movements
      add constraint stock_movements_reversal_cost_check
      check (movement_type <> 'reversal' or carried_unit_cost is not null);
  end if;

  -- A movement cannot undo itself. The RPC refuses it with a sentence; this is
  -- the guard under any other route.
  if not exists (select 1 from pg_constraint
                 where conname = 'stock_movements_reversal_self_check') then
    alter table stock_movements
      add constraint stock_movements_reversal_self_check
      check (reverses_movement_id is null or reverses_movement_id <> id);
  end if;

  -- An empty-string batch code is not a batch code — it is a blank field that
  -- would later be trusted by a recall query as if it identified something.
  if not exists (select 1 from pg_constraint
                 where conname = 'stock_movements_batch_code_nonblank_check') then
    alter table stock_movements
      add constraint stock_movements_batch_code_nonblank_check
      check (batch_code is null or length(btrim(batch_code)) > 0);
  end if;

  -- The self-referencing FK. ON DELETE is left as NO ACTION (checked at end of
  -- statement) for the reason 036 gives about the item FK: the property cascade
  -- has to be able to take a whole tree of movements with it in one statement,
  -- and RESTRICT — checked immediately — would break that teardown.
  if not exists (select 1 from pg_constraint
                 where conname = 'stock_movements_reverses_fk') then
    alter table stock_movements
      add constraint stock_movements_reverses_fk
      foreign key (reverses_movement_id) references stock_movements (id);
  end if;
end $$;


-- ----------------------------------------------------------------------------
-- 1.2 A movement is reversed ONCE, EVER
-- ----------------------------------------------------------------------------
-- The RPC's state check (§7) is the friendly guard that returns a sentence;
-- THIS index is what makes that guard true under concurrency, when two
-- terminals reverse the same movement in the same instant. Exactly the shape
-- 031 uses for reversals_target_uniq, and for exactly the same reason.
create unique index if not exists stock_movements_reverses_uniq
  on stock_movements (reverses_movement_id)
  where reverses_movement_id is not null;

-- The cost-of-sale read: every stock-out of a property in a period, which is
-- what the P&L and the consumption report will page over.
create index if not exists stock_movements_carried_cost_idx
  on stock_movements (property_id, business_date)
  where quantity < 0;


-- ############################################################################
-- SECTION 2 — 'reversal' becomes a movement type
-- ############################################################################
-- 036 declared ten types and said later tranches would add a WRITE PATH rather
-- than reshape the table. This is the one exception, and it is worth stating
-- why rather than quietly widening a CHECK:
--
-- A reversal could have been posted as an ordinary 'adjustment' — the direction
-- rules allow either sign and a reason is already mandatory. That was rejected.
-- A reversal that reads as an adjustment is INVISIBLE to every variance and
-- theft report this engine exists to produce: "adjustments in the bar this
-- month" would silently include the corrections of legitimate postings, and the
-- one number a manager looks at to spot stock walking would be diluted by
-- clerical noise. The type is what makes the two separable forever.
--
-- stock_movements_type_direction_check needs NO change: its CASE already ends in
-- `else true`, and a reversal is legitimately either direction — reversing a
-- receipt removes stock, reversing an issue puts it back.
alter table stock_movements drop constraint if exists stock_movements_type_check;
alter table stock_movements
  add constraint stock_movements_type_check
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
    'count_adjustment',
    'reversal'            -- 038: the counter-movement reverse_stock_movement posts
  ));

comment on column stock_movements.movement_type is
  'The full set is declared up front so later tranches add a write path, not a '
  'column: opening/adjustment (036) and reversal (038) are writable now; receipt '
  '(2c), issue_in/issue_out/transfer_in/transfer_out (part 3), consumption, '
  'wastage and count_adjustment (039 and later) are RESERVED and have no write '
  'path — the table has no write RLS policy and every RPC hardcodes its own '
  'type. ''reversal'' is a type of its own rather than an adjustment so that a '
  'correction of a legitimate posting can never be counted as one of the '
  'unexplained movements the theft reports look for.';


-- ############################################################################
-- SECTION 3 — inventory_items.tracks_expiry
-- ############################################################################
-- SEPARATE FROM is_perishable, and the difference is the whole point. Milk is
-- perishable — that is a property of the substance, captured in 035 for
-- reporting. tracks_expiry says something operational and much stronger: THIS
-- HOTEL RECORDS A BATCH AND AN EXPIRY DATE EVERY TIME THIS ITEM ARRIVES. It
-- turns two nullable columns into a mandatory pair on every stock-in (§8), so it
-- is a workload decision a storekeeper lives with daily, not a description.
--
-- Defaults FALSE, so nothing changes for any existing item and no current screen
-- gains a required field. A hotel opts an item in when it is ready to do the
-- work.
alter table inventory_items
  add column if not exists tracks_expiry boolean not null default false;

comment on column inventory_items.tracks_expiry is
  'Whether every stock-IN of this item must state a batch code and an expiry '
  'date (enforced in the posting RPCs — it is a cross-table rule, so not a '
  'CHECK). DIFFERENT FROM is_perishable: perishable describes the substance, '
  'this commits the storekeeper to recording a batch on every delivery. Defaults '
  'false so no existing item or screen changes.';


-- ############################################################################
-- SECTION 4 — THE POSTING LOCK
-- ############################################################################
-- One date per property: "everything on or before this day is closed."
--
-- WHY IT LIVES ON property_finance_settings AND NOWHERE ELSE. 021 §3 built that
-- table precisely because property_settings is anon-readable for the guest site
-- and RLS cannot hide a single column. A lock date is internal financial policy
-- of the same kind as the discount threshold: it says when the hotel considers
-- its books closed. It belongs beside it.
--
-- WHY A LOCK AT ALL, at a 30-room hotel with no accountant yet. Because the
-- alternative is discovering, in month four, that somebody corrected a February
-- figure in April and every report printed since February is now wrong. The
-- lock is what makes "we have reported this month" a fact the database holds
-- rather than a thing everyone remembers.
alter table property_finance_settings
  add column if not exists posting_locked_through date;

comment on column property_finance_settings.posting_locked_through is
  'The last CLOSED business date for this property. Every posting RPC refuses a '
  'movement dated on or before it, naming the date and the lock. NULL (the '
  'default) means nothing is locked. Reversal is not an exception and does not '
  'need to be: a reversal always posts on the CURRENT business date (§7), so it '
  'never reaches back into a closed period in the first place.';


-- ----------------------------------------------------------------------------
-- 4.1 assert_posting_open — one implementation, called by every posting RPC
-- ----------------------------------------------------------------------------
-- Written once, here, rather than as four copies of the same IF. A lock check
-- that is re-implemented per RPC is a lock check that one future RPC forgets,
-- and the forgetting is silent — the posting simply succeeds.
--
-- SECURITY DEFINER because property_finance_settings is member-readable but the
-- guard must be true even for a caller whose RLS cannot see the row; a lock that
-- can be defeated by not being able to read it is not a lock.
create or replace function assert_posting_open(
  p_property_id   uuid,
  p_business_date date
)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_lock date;
begin
  select pfs.posting_locked_through into v_lock
  from property_finance_settings pfs
  where pfs.property_id = p_property_id;

  if v_lock is not null and p_business_date <= v_lock then
    -- BOTH dates are in the message on purpose. "That period is locked" is a
    -- rule; "you are posting to 12 Feb and the books are closed through 28 Feb"
    -- is something the person can act on without finding an admin first.
    raise exception
      'This property''s books are closed through %. A movement dated % falls inside the closed period and cannot be posted.',
      to_char(v_lock, 'DD Mon YYYY'), to_char(p_business_date, 'DD Mon YYYY')
      using errcode = 'PT423',
            hint = 'Post it on a business date after the lock, or ask an admin to move the posting lock in Finance settings.';
  end if;
end;
$$;

comment on function assert_posting_open(uuid, date) is
  'Refuses a posting dated on or before the property''s posting_locked_through, '
  'naming both the lock date and the attempted date (PT423). ONE implementation, '
  'called by every posting RPC — a per-RPC copy is one a future RPC forgets, and '
  'the forgetting is silent. SECURITY DEFINER so the lock holds even for a caller '
  'whose RLS cannot read the settings row.';


-- ----------------------------------------------------------------------------
-- 4.2 The settings writer learns the new field
-- ----------------------------------------------------------------------------
-- Same signature, same optimistic-concurrency shape, same SQLSTATEs as 023 §3 —
-- so the existing settings form's error handling covers it with no new branch.
-- Replaced rather than supplemented: two writers of one settings table is how a
-- concurrency guard gets bypassed by whichever one somebody calls next.
create or replace function update_property_finance_settings(
  p_property_id         uuid,
  p_patch               jsonb,
  p_expected_updated_at timestamptz
) returns property_finance_settings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant_id  uuid;
  v_timezone   text;
  v_updated_at timestamptz;
  v_threshold  numeric;
  v_lock       date;
  v_today      date;
  v_result     property_finance_settings;
begin
  select p.tenant_id, p.timezone
    into v_tenant_id, v_timezone
  from properties p
  where p.id = p_property_id
    and p.deleted_at is null;

  if v_tenant_id is null then
    raise exception 'Property % not found', p_property_id
      using errcode = 'PT404';
  end if;

  if not is_tenant_admin(v_tenant_id) then
    raise exception 'You are not authorised to edit this property''s finance settings'
      using errcode = 'PT403';
  end if;

  select pfs.updated_at
    into v_updated_at
  from property_finance_settings pfs
  where pfs.property_id = p_property_id
  for update;

  if v_updated_at is null then
    raise exception 'Finance settings for property % not found', p_property_id
      using errcode = 'PT404';
  end if;

  if p_expected_updated_at is distinct from v_updated_at then
    raise exception 'These settings were changed by someone else since you loaded them'
      using errcode = 'PT409',
            hint = 'Reload to see the latest values, then reapply your change.';
  end if;

  if p_patch ? 'discount_threshold' then
    v_threshold := (p_patch ->> 'discount_threshold')::numeric;
    if v_threshold is null then
      raise exception 'Enter a discount threshold (use 0 to require approval for every discount)'
        using errcode = 'PT422';
    end if;
    if v_threshold < 0 then
      raise exception 'The discount threshold cannot be negative'
        using errcode = 'PT422';
    end if;
  end if;

  -- THE LOCK DATE. NULL is a legitimate value here and means "nothing is
  -- locked", so unlike the threshold a cleared field is honoured rather than
  -- refused. A JSON null and an absent key mean different things and are
  -- treated differently: absent = leave it alone, null = unlock.
  if p_patch ? 'posting_locked_through' then
    v_lock := nullif(btrim(coalesce(p_patch ->> 'posting_locked_through', '')), '')::date;

    -- A lock in the FUTURE would close days that have not happened yet, and the
    -- first person to discover it would be a storekeeper who cannot record
    -- tonight's delivery. Refused with the property's own today, not the
    -- server's calendar day (rules 8/12).
    v_today := (now() at time zone coalesce(nullif(btrim(v_timezone), ''), 'Africa/Lagos'))::date;
    if v_lock is not null and v_lock > v_today then
      raise exception
        'The posting lock cannot be set to a future date (today is % at this property)', v_today
        using errcode = 'PT422',
              hint = 'Lock a period once it is closed, not before it has happened.';
    end if;
  end if;

  update property_finance_settings
     set discount_threshold = case
                                when p_patch ? 'discount_threshold'
                                  then (p_patch ->> 'discount_threshold')::numeric
                                else discount_threshold
                              end,
         posting_locked_through = case
                                    when p_patch ? 'posting_locked_through'
                                      then nullif(btrim(coalesce(p_patch ->> 'posting_locked_through', '')), '')::date
                                    else posting_locked_through
                                  end
   where property_id = p_property_id
  returning * into v_result;

  return v_result;
end;
$$;

comment on function update_property_finance_settings(uuid, jsonb, timestamptz) is
  'Patch property_finance_settings (discount_threshold, posting_locked_through) '
  'under an optimistic updated_at check — the same shape and the same '
  'PT404/PT403/PT409/PT422 SQLSTATEs as 008''s four settings writers. For the '
  'lock date an ABSENT key leaves it alone and an explicit null UNLOCKS; a future '
  'date is refused, because it would close days that have not happened. '
  'Admin-gated, SECURITY DEFINER.';


-- ############################################################################
-- SECTION 5 — THE FOLD, REBUILT SO A REVERSAL UNWINDS EXACTLY
-- ############################################################################
--
--  ┌──────────────────────────────────────────────────────────────────────────┐
--  │  THE PROBLEM, IN NUMBERS.                                                │
--  │                                                                          │
--  │  100 kg on hand at ₦1.50.   Receive 50 kg at ₦2.10.                      │
--  │      A = (100×1.50 + 50×2.10) / 150 = 255/150 = ₦1.70                    │
--  │                                                                          │
--  │  Now reverse that receipt. Under 036's fold the counter is an ordinary    │
--  │  stock-out, and a stock-out LEAVES THE AVERAGE ALONE:                    │
--  │      Q = 100  ✓        A = ₦1.70  ✗   (it should be ₦1.50)               │
--  │                                                                          │
--  │  The quantity unwinds exactly. The value does not. ₦20 of cost has been  │
--  │  left behind in an average nobody will ever look at again — permanent,   │
--  │  invisible, and compounding into every consumption figure taken from it. │
--  └──────────────────────────────────────────────────────────────────────────┘
--
-- WHY THIS IS THE FOLIO-CONSISTENT ANSWER, not a departure from it. The folio
-- principle is "do not rewrite a closed day" — which this migration keeps
-- absolutely (§7: a reversal posts on TODAY, never on the original's date).
-- It is not "accept arithmetic residue": reverse a ₦100 charge on a folio and
-- the balance moves back by exactly ₦100. The equivalent here is that reversing
-- a receipt unwinds exactly the value it added.
--
-- ----------------------------------------------------------------------------
-- THE CHANGE, STATED AS NARROWLY AS IT ACTUALLY IS
-- ----------------------------------------------------------------------------
-- The fold gains a THIRD input, and every view passes it as:
--
--     case when movement_type = 'reversal' then carried_unit_cost end
--
-- So it is non-null for exactly one row type. Consequences, deliberately:
--
--   * ORDINARY STOCK-OUT IS COMPLETELY UNCHANGED. It still consumes at the
--     running average and still leaves the average alone. carried_unit_cost on
--     an ordinary out is a locked cost-of-sale record for reporting and for the
--     future P&L — it does NOT feed the fold.
--   * ORDINARY STOCK-IN IS COMPLETELY UNCHANGED.
--   * On-hand and value stay fully derived from the movements. Rule 6 holds:
--     there is still no stored balance anywhere.
--   * Therefore no number this system has ever produced changes, except for
--     histories that contain a reversal — and none can, because this migration
--     is what creates the type.
--
-- ----------------------------------------------------------------------------
-- THE ARITHMETIC, both directions
-- ----------------------------------------------------------------------------
-- REVERSING A STOCK-IN (counter quantity q < 0, basis c = the original's cost):
--     value' = Q×A + q×c        (q is negative, so this SUBTRACTS q's value)
--     Q'     = Q + q
--     A'     = value' / Q'                       when Q' > 0
--   Worked on the example above: 150×1.70 + (−50)×2.10 = 255 − 105 = 150,
--   over Q' = 100, gives A' = ₦1.50. Exact.
--
-- REVERSING A STOCK-OUT (counter quantity q > 0, basis c = what left):
--     the ordinary weighted-average formula with the incoming cost set to c.
--   If the out consumed |q| at average A0 and nothing has happened since, then
--   ((Q0−|q|)×A0 + |q|×A0) / Q0 = A0. Exact.
--
-- Q' <= 0 leaves the average UNTOUCHED rather than dividing: with nothing (or
-- less than nothing) on hand there is no meaningful unit cost, and the next
-- stock-in resets it outright via the existing Q<=0 branch.


-- ----------------------------------------------------------------------------
-- 5.1 The transition function
-- ----------------------------------------------------------------------------
-- An OVERLOAD, not a replacement: the 3-argument form still exists at this
-- point in the migration because the views below still reference the old
-- aggregate. Both the old aggregate and the old step function are dropped in
-- §5.5, once nothing points at them — so this system ends the migration with
-- exactly ONE definition of weighted-average cost, as 036 §2 insists.
create or replace function stock_wac_step(
  state           stock_wac_state,
  p_quantity      numeric,
  p_unit_cost     numeric,
  p_reversal_cost numeric
)
returns stock_wac_state
language plpgsql
immutable
as $$
declare
  v_qty  numeric := coalesce(state.quantity, 0);
  v_avg  numeric := coalesce(state.average_cost, 0);
  v_new  numeric;
  v_cost numeric;
begin
  -- A movement of nothing changes nothing. The table constraint already refuses
  -- quantity = 0; this is belt-and-braces against a NULL from a future caller,
  -- and it is the reason no 0/0 can be constructed here either.
  if p_quantity is null or p_quantity = 0 then
    return state;
  end if;

  v_new := v_qty + p_quantity;

  if p_quantity > 0 then
    -- STOCK IN. A reversal of a stock-out re-enters at the cost that left; an
    -- ordinary receipt enters at its own stated cost. Identical machinery.
    v_cost := coalesce(p_reversal_cost, p_unit_cost);

    if v_qty <= 0 then
      -- First receipt, or a receipt into an empty/negative position: the
      -- incoming cost BECOMES the average and no division happens at all.
      v_avg := coalesce(v_cost, v_avg);
    else
      -- v_qty > 0 and p_quantity > 0, so the denominator is strictly positive.
      v_avg := ((v_qty * v_avg) + (p_quantity * coalesce(v_cost, v_avg)))
               / (v_qty + p_quantity);
    end if;

  elsif p_reversal_cost is not null then
    -- REVERSING A STOCK-IN. Remove exactly the VALUE that arrived — not |q| ×
    -- the current average, which is what an ordinary out would remove and which
    -- is precisely the residue this branch exists to eliminate.
    if v_new > 0 then
      v_avg := ((v_qty * v_avg) + (p_quantity * p_reversal_cost)) / v_new;
    end if;
    -- v_new <= 0: nothing left to value. The average is held as-is and the next
    -- stock-in resets it through the Q<=0 branch above.
  end if;
  -- ORDINARY STOCK-OUT falls through with v_avg UNTOUCHED — 036's rule, intact.

  return (v_new, v_avg)::stock_wac_state;
end;
$$;

comment on function stock_wac_step(stock_wac_state, numeric, numeric, numeric) is
  'One step of the weighted-average-cost fold. The third argument is the '
  'REVERSAL COST BASIS and is non-null for exactly one row type — every caller '
  'passes `case when movement_type = ''reversal'' then carried_unit_cost end`. '
  'Stock IN: A'' = (Q×A + q×c)/(Q+q), with Q<=0 short-circuiting to A'' = c. '
  'Reversing a stock-IN: value'' = Q×A + q×c, so the exact value that arrived is '
  'removed rather than |q|×A. ORDINARY stock-out is unchanged from 036 — the '
  'average is untouched and the cost carried out is |q|×A. No division is '
  'reachable with a non-positive denominator.';


-- ----------------------------------------------------------------------------
-- 5.2 The aggregate
-- ----------------------------------------------------------------------------
-- ALWAYS call it with an ORDER BY. The fold is path-dependent, so an unordered
-- call is not "approximately right", it is meaningless:
--   stock_wac(quantity, unit_cost, reversal_cost
--             order by business_date, seq)
create or replace aggregate stock_wac(numeric, numeric, numeric) (
  sfunc    = stock_wac_step,
  stype    = stock_wac_state,
  initcond = '(0,0)'
);

comment on aggregate stock_wac(numeric, numeric, numeric) is
  'Folds a movement history into (quantity_on_hand, moving_average_cost). ALWAYS '
  'call with ORDER BY business_date, seq — weighted average cost is '
  'path-dependent, and created_at cannot break the tie because it is the '
  'transaction clock. The third argument carries the reversal cost basis so a '
  'reversal unwinds the exact value its original moved.';


-- ----------------------------------------------------------------------------
-- 5.3 stock_on_hand — same columns, new fold
-- ----------------------------------------------------------------------------
-- CREATE OR REPLACE, not DROP and recreate: the column list, names, order and
-- types are byte-identical to 036 §3.1, so the two views that read this one
-- (stock_on_hand_items, stock_on_hand_by_item) need no change and keep working
-- throughout. Only the expression behind `wac` differs.
--
-- INVARIANT (rule 9), unchanged and now stronger:
--   stock_on_hand.quantity_on_hand === sum(stock_movements.quantity)
--     for that (property, location, item), by construction.
-- And newly true:
--   a movement and its reversal together move BOTH quantity and value by zero.
create or replace view stock_on_hand
with (security_invoker = on) as
select
  f.tenant_id,
  f.property_id,
  f.location_id,
  f.inventory_item_id,
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
    -- THE ORDER IS LOAD-BEARING (036 §2): the business timeline first (rule 8),
    -- then `seq`, which totally orders same-day movements by real insertion
    -- order. The third argument is non-null for reversal rows ONLY, so every
    -- other row folds exactly as it did before this migration.
    stock_wac(sm.quantity,
              sm.unit_cost,
              case when sm.movement_type = 'reversal'
                   then sm.carried_unit_cost end
              order by sm.business_date, sm.seq) as wac
  from stock_movements sm
  group by sm.tenant_id, sm.property_id, sm.location_id, sm.inventory_item_id
) f;

comment on view stock_on_hand is
  'Quantity on hand, moving-average cost and stock value per (location, item), '
  'COMPUTED from stock_movements on every read — nothing is stored (rule 6). '
  'INVARIANT: quantity_on_hand === sum(stock_movements.quantity) for that '
  '(property, location, item), by construction; and a movement plus its reversal '
  'move both quantity AND value by exactly zero (038 §5). Negative quantities are '
  'shown as-is and never floored (rule 7): a negative on-hand is stock that left '
  'without a movement, which is the discrepancy this system exists to surface. '
  'security_invoker: the caller''s RLS decides what is visible.';


-- ----------------------------------------------------------------------------
-- 5.4 stock_movement_ledger — new fold, and the reversal columns a reader needs
-- ----------------------------------------------------------------------------
-- The eighteen columns 036 defined keep their names, types and ORDER exactly;
-- five are appended, which is the one shape CREATE OR REPLACE VIEW permits.
--
-- reversed_by_movement_id is the DERIVED back-pointer promised in §1: a scalar
-- subquery over the partial unique index, so it is at most one row and needs no
-- column on the table and no hole in the immutability trigger.
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
  ((w.wac).quantity)::numeric(14,4)             as running_quantity,
  round((w.wac).average_cost, 4)::numeric(14,4) as running_average_cost,
  -- THE VALUE THIS MOVEMENT MOVED, signed like the quantity.
  --   reversal   -> its own carried basis, which is what it unwound;
  --   stock-in   -> its own stated cost;
  --   stock-out  -> the cost it actually carried out, now recorded on the row
  --                 itself (§6) rather than re-derived from the running average.
  -- The coalesce keeps any row written before §6's trigger existed readable.
  round(
    case
      when m.movement_type = 'reversal'
        then m.quantity * coalesce(m.carried_unit_cost, m.unit_cost)
      when m.quantity > 0
        then m.quantity * m.unit_cost
      else m.quantity * coalesce(m.carried_unit_cost, (w.wac).average_cost)
    end,
    2
  )::numeric(14,2)                              as movement_value,
  -- --- appended by 038 ----------------------------------------------------
  m.carried_unit_cost,
  m.reverses_movement_id,
  (select r.id
     from stock_movements r
    where r.reverses_movement_id = m.id)        as reversed_by_movement_id,
  m.batch_code,
  m.expiry_date
from stock_movements m
cross join lateral (
  select stock_wac(m2.quantity,
                   m2.unit_cost,
                   case when m2.movement_type = 'reversal'
                        then m2.carried_unit_cost end
                   order by m2.business_date, m2.seq) as wac
  from stock_movements m2
  where m2.location_id = m.location_id
    and m2.inventory_item_id = m.inventory_item_id
    and (m2.business_date, m2.seq) <= (m.business_date, m.seq)
) w;

comment on view stock_movement_ledger is
  'Every stock movement with the running quantity and running average cost as at '
  'that movement — the working behind the current valuation. The running average '
  'is THE SAME stock_wac fold applied to the movements up to each row, never a '
  'second implementation. movement_value is signed: a reversal moves its carried '
  'basis, a stock-in its own cost, a stock-out the cost it actually carried out. '
  'reversed_by_movement_id is DERIVED from the partial unique index rather than '
  'stored, because stock_movements admits no UPDATE. Correlated per row, so read '
  'it for ONE item in ONE location, never across a list.';


-- ----------------------------------------------------------------------------
-- 5.5 Retire the 2-argument fold
-- ----------------------------------------------------------------------------
-- Nothing references it any more. Left in place it would be a SECOND definition
-- of weighted-average cost sitting beside the first, silently missing the
-- reversal branch — and the next author to write a report would have a
-- coin-flip's chance of calling the wrong one. 036 §2's whole argument for a
-- custom aggregate was ONE definition the consumers share; two aggregates of the
-- same name would defeat it more thoroughly than a plpgsql loop ever could.
--
-- BEFORE DROPPING IT, PROVE NOTHING STILL CALLS IT — and the reason this check
-- exists rather than trusting the drop is specific and nasty. Postgres tracks a
-- VIEW's dependency on an aggregate, so a view still using the old fold would
-- make this DROP fail loudly. It does NOT track a call from inside a plpgsql or
-- SQL FUNCTION BODY: those are resolved at execution time, so the drop would
-- succeed and the caller would break at runtime, on some future Tuesday, with a
-- "function stock_wac(numeric, numeric) does not exist" in front of a
-- storekeeper.
--
-- The three at risk are 036 §3.5's scalar readers — stock_valuation,
-- stock_on_hand(uuid,uuid,uuid) and stock_moving_average_cost. All three read
-- the VIEW rather than the aggregate, which is what makes this drop safe; this
-- block is what turns that from a belief into a checked fact, now and on every
-- future re-run.
do $$
declare
  v_callers text;
begin
  select string_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', ', ' order by p.proname)
    into v_callers
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prokind = 'f'
    and p.prosrc ilike '%stock\_wac%'
    -- TWO EXCLUSIONS, AND THEY ARE BOTH FUNCTIONS THIS FILE ITSELF AUTHORS
    -- AGAINST THE NEW THREE-ARGUMENT SIGNATURE. That is the whole justification:
    -- this is not a list of callers somebody remembered, it is the set of things
    -- defined a few hundred lines above, which cannot drift without editing this
    -- migration. Anything else naming stock_wac predates 038 and is therefore a
    -- two-argument caller by definition.
    --
    -- Both must be excluded for IDEMPOTENCY, not merely for tidiness: on a
    -- re-run of this migration they already exist from the first run, and
    -- without these two lines the guard would fire on 038's own work and abort a
    -- migration that had nothing wrong with it.
    and p.proname <> 'stock_wac_step'            -- the fold's own machinery
    and p.proname <> 'stock_average_cost_as_at'; -- §6.1, written against the 3-arg form

  if v_callers is not null then
    raise exception
      'ASSERT FAILED: these function bodies still name stock_wac and would break silently when the 2-argument aggregate is dropped: %. Give them the third argument first.',
      v_callers;
  end if;

  raise notice
    '038: no function body calls stock_wac directly — the scalar readers go through the view, so the 2-argument aggregate is safe to drop.';
end $$;

-- The aggregate goes first: it depends on the step function.
drop aggregate if exists stock_wac(numeric, numeric);
drop function  if exists stock_wac_step(stock_wac_state, numeric, numeric);


-- ############################################################################
-- SECTION 6 — CARRIED COST ON EVERY STOCK-OUT
-- ############################################################################
-- The cost a unit of stock left at is knowable ONLY at the moment it leaves.
-- Once another receipt lands, the fold produces a different average, and no
-- amount of later cleverness recovers what the earlier issue actually cost.
--
-- WHY A TRIGGER RATHER THAN A LINE IN EACH RPC. Because "each RPC" is not a
-- closed set: receive, write-off, requisition, consumption, transfer and the
-- count variance are all still to be built, and every one of them posts
-- stock-outs. A rule that each future author must remember is a rule that gets
-- forgotten once, silently, and the gap is discovered a year later as a hole in
-- the cost-of-sale report. The trigger makes it structural: there is no way to
-- insert a negative movement without a carried cost being stamped on it.
--
-- The trigger DOES NOT OVERWRITE an explicitly supplied value, which is what
-- lets reverse_stock_movement (§7) set the basis it actually needs — the
-- ORIGINAL's cost, not today's average.


-- ----------------------------------------------------------------------------
-- 6.1 The as-at reader
-- ----------------------------------------------------------------------------
-- The average as at a POSITION in the ledger, not "the average now". Back-dating
-- is the reason: a movement inserted with an earlier business_date belongs where
-- it happened (rule 8), and the cost it carried is the cost that was true at
-- that point in the walk — not the cost after everything that has been posted
-- since.
--
-- NULL — never 0 — when there is no prior history at all, exactly as
-- stock_moving_average_cost does. "We do not know what this cost" and "it was
-- free" are different facts and a report must be able to tell them apart.
--
-- NOT SECURITY DEFINER, deliberately, and for 036 §3.5's reason: called by a
-- client it sees only what that client's RLS allows; called from inside the
-- SECURITY DEFINER trigger below it runs with the owner's rights and therefore
-- sees the true position, which is what a stamp of record requires.
create or replace function stock_average_cost_as_at(
  p_location_id       uuid,
  p_inventory_item_id uuid,
  p_business_date     date,
  p_seq               bigint
)
returns numeric
language sql
stable
set search_path = public
as $$
  select case
           when count(*) = 0 then null::numeric
           else round(
             (stock_wac(m.quantity,
                        m.unit_cost,
                        case when m.movement_type = 'reversal'
                             then m.carried_unit_cost end
                        order by m.business_date, m.seq)).average_cost,
             4)
         end
  from stock_movements m
  where m.location_id = p_location_id
    and m.inventory_item_id = p_inventory_item_id
    and (m.business_date, m.seq) < (p_business_date, coalesce(p_seq, 9223372036854775807));
$$;

comment on function stock_average_cost_as_at(uuid, uuid, date, bigint) is
  'The moving-average cost of one item in one location AS AT a position in the '
  'ledger — strictly before (business_date, seq). Used to stamp carried_unit_cost '
  'on a stock-out, including a back-dated one, which must carry the cost that was '
  'true where it belongs rather than the cost that is true now. NULL, never 0, '
  'when there is no prior history. A NULL p_seq reads as "after everything", '
  'which is the correct meaning for a row being appended.';


-- ----------------------------------------------------------------------------
-- 6.2 The trigger
-- ----------------------------------------------------------------------------
-- ONE MOVEMENT PER STATEMENT — a real constraint, stated rather than assumed.
-- stock_average_cost_as_at is STABLE, so inside a BEFORE trigger it reads the
-- calling statement's snapshot: rows inserted earlier in the SAME multi-row
-- INSERT are not visible to it. Every RPC in this system inserts exactly one
-- movement per statement, so this is correct today. A future batch path must
-- either keep that shape or compute carried_unit_cost itself — which the
-- trigger honours, because it never overwrites a supplied value.
create or replace function set_stock_carried_cost()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Stock-OUT only. A stock-in states its own cost in unit_cost and has nothing
  -- to carry out; the cost/direction constraint (036 §1) already forbids the
  -- reverse pairing.
  if new.quantity < 0 and new.carried_unit_cost is null then
    new.carried_unit_cost := stock_average_cost_as_at(
      new.location_id,
      new.inventory_item_id,
      new.business_date,
      new.seq
    );
  end if;

  return new;
end;
$$;

comment on function set_stock_carried_cost() is
  'Stamps carried_unit_cost — what the stock cost on the way out — on every '
  'negative-quantity movement, from the fold as at that movement''s position. A '
  'TRIGGER rather than a line in each RPC because "each RPC" is not a closed set: '
  'receive, write-off, requisition, consumption and transfer are all still to be '
  'built and all post stock-outs, and a rule each future author must remember is '
  'one that gets forgotten silently. Never overwrites a value the caller supplied, '
  'which is how reverse_stock_movement sets the ORIGINAL''s basis instead.';

-- Fires before set_row_audit only by alphabetical accident and it does not
-- matter: the two touch disjoint columns.
drop trigger if exists set_stock_carried_cost_trigger on stock_movements;
create trigger set_stock_carried_cost_trigger
  before insert on stock_movements
  for each row execute function set_stock_carried_cost();


-- ----------------------------------------------------------------------------
-- 6.3 Backfill — every negative movement already in the ledger
-- ----------------------------------------------------------------------------
-- THE IMMUTABILITY TRIGGER IS DISABLED FOR THE LENGTH OF ONE UPDATE, and that
-- deserves to be uncomfortable to read, so here is the reasoning in full.
-- forbid_stock_movement_change() refuses every UPDATE on this table (036 §1.4),
-- which is exactly right for every application and administrative path and is
-- the guarantee the ledger rests on. A schema migration adding a column that
-- must be populated from history is the one thing it cannot accommodate, and the
-- alternative — leaving pre-038 stock-outs permanently unvalued — would mean the
-- cost-of-sale report has a hole in it that no later run can fill.
--
-- The disable/enable pair is inside this migration's single transaction, so
-- there is no window in which the table is unprotected to anything else, and the
-- UPDATE touches ONE column that was NULL on every row a moment earlier.
--
-- ON THIS DATABASE IT UPDATES NOTHING: stock_movements currently holds zero
-- rows. The code is written properly anyway, because a migration that is only
-- correct against an empty table is a migration nobody can trust on the next
-- tenant.
do $$
declare
  v_expected   bigint;
  v_done       bigint;
  v_unvaluable bigint;
begin
  -- PRE-SNAPSHOT. "Backfillable" is a negative-quantity row that has at least
  -- one movement before it in its own (location, item) walk — a row with no
  -- prior history has no average to carry and NULL is the honest answer, not a
  -- failure. Counted before the write so the assertion compares two independent
  -- measurements rather than restating one.
  select count(*)
    into v_expected
  from stock_movements m
  where m.quantity < 0
    and exists (
      select 1 from stock_movements p
      where p.location_id = m.location_id
        and p.inventory_item_id = m.inventory_item_id
        and (p.business_date, p.seq) < (m.business_date, m.seq)
    );

  execute 'alter table stock_movements disable trigger stock_movements_forbid_update';

  update stock_movements m
     set carried_unit_cost = stock_average_cost_as_at(
           m.location_id, m.inventory_item_id, m.business_date, m.seq)
   where m.quantity < 0
     and m.carried_unit_cost is null;

  execute 'alter table stock_movements enable trigger stock_movements_forbid_update';

  select count(*) filter (where carried_unit_cost is not null),
         count(*) filter (where carried_unit_cost is null)
    into v_done, v_unvaluable
  from stock_movements
  where quantity < 0;

  if v_done <> v_expected then
    raise exception
      'Backfill assertion failed: % negative movements had prior history and should carry a cost, but % carry one.',
      v_expected, v_done;
  end if;

  raise notice
    '038 carried-cost backfill: % negative movements valued, % left NULL (no prior history in their location).',
    v_done, v_unvaluable;
end $$;


-- ############################################################################
-- SECTION 7 — REVERSING A MOVEMENT
-- ############################################################################
-- The same shape as every reversal in this product (031-034), because it is the
-- same act: lock the original, gate it, check idempotency by key AND by state,
-- test the state, demand a reason, demand a manager's PIN with no threshold,
-- post an equal-and-opposite entry, and leave a permanent audit row.
--
-- ----------------------------------------------------------------------------
-- THE COUNTER POSTS ON TODAY, NEVER ON THE ORIGINAL'S DATE
-- ----------------------------------------------------------------------------
-- Identical to reverse_charge (032). Yesterday's stock report was true when it
-- was printed and stays true; the correction appears on the day it was actually
-- made. Rewriting a closed day would mean two people running the same report a
-- week apart get different numbers with nothing to explain the difference — and
-- it is why the posting lock (§4) needs no exception for reversal: a reversal
-- never reaches backwards in the first place.
--
-- ----------------------------------------------------------------------------
-- WHY AN 'opening' MOVEMENT IS REFUSED
-- ----------------------------------------------------------------------------
-- stock_movements_one_opening_uniq lives on the ORIGINAL row, and "has not been
-- reversed" is a fact about a DIFFERENT row, so it cannot be expressed as a
-- partial index without either a trigger holding a lock or a hole in
-- immutability. Neither is worth it, because the practical case is already
-- safe: a wrong opening balance is corrected at onboarding, before anything else
-- has moved, when the average still equals the opening cost — so an ordinary
-- adjustment unwinds it exactly, with no residue at all. The error message says
-- so, because a person who is told "no" and not told "instead" will go and do
-- something worse.
--
-- ----------------------------------------------------------------------------
-- THE AUDIT ROW GOES IN reversals (031), NOT IN A NEW TABLE
-- ----------------------------------------------------------------------------
-- 031 built one permanent record of every reversal across the product —
-- reversed_by, approved_by, reason, business_date, target, counter-entry — with
-- member-read and no write policy for anyone. A stock reversal is a reversal.
-- Giving it a second, parallel audit trail would mean the manager's
-- reversal-approval report (031's reversals_approved_by_idx: "a manager whose
-- PIN authorises a reversal every Friday night") has to know about two tables
-- and would miss whichever one a future reader forgot.
--
-- Without it, the PIN requirement would record NOTHING: verify_manager_pin
-- returns WHICH manager precisely so the approval can be named (021 §7.2), and
-- stock_movements has nowhere to put that.
alter table reversals drop constraint if exists reversals_target_type_check;
alter table reversals
  add constraint reversals_target_type_check
  check (target_type in (
    'payment',          -- 031
    'charge',           -- 032
    'discount',         -- 032
    'no_show',          -- 033
    'cancel',           -- 033
    'checkout',         -- 034
    'stock_movement'    -- 038
  ));

-- A stock reversal ALWAYS produces a counter-movement — unlike a 'cancel' or a
-- 'checkout', which reverse a STATE and legitimately have no counter row. An
-- audit record of a stock reversal with no counter would be a record of
-- something that did not happen to the stock.
do $$
begin
  if not exists (select 1 from pg_constraint
                 where conname = 'reversals_stock_counter_check') then
    alter table reversals
      add constraint reversals_stock_counter_check
      check (target_type <> 'stock_movement' or counter_entry_id is not null);
  end if;
end $$;


-- ----------------------------------------------------------------------------
-- 7.1 A shared quantity formatter for error messages
-- ----------------------------------------------------------------------------
-- 036 built this expression inline for the negative-stock message; §7 and §10
-- need it three more times. Written once so every message in this module reads
-- "-12" and "0.25" rather than one of them reading "-12.0000".
create or replace function format_stock_quantity(p_quantity numeric)
returns text
language sql
immutable
as $$
  select case
           when p_quantity is null then '—'
           else rtrim(rtrim(trim(to_char(p_quantity, 'FM999999999990.0000')), '0'), '.')
         end;
$$;

comment on function format_stock_quantity(numeric) is
  'Renders a numeric(14,4) quantity for a user-facing error message with trailing '
  'zeros stripped ("-12", not "-12.0000"), and the shared MISSING_VALUE em-dash '
  'for NULL. One implementation so every message in this module reads the same.';


-- ----------------------------------------------------------------------------
-- 7.2 reverse_stock_movement
-- ----------------------------------------------------------------------------
-- p_idempotency_key is the FOURTH parameter and defaults to NULL, so the
-- three-argument call in the brief still works — but rule 2 admits no exception,
-- so when the caller supplies none a DETERMINISTIC key is derived from the
-- target: 'reversal:<movement id>'. That is the honest canonical key here,
-- because a movement is reversed once ever, and it means a double-click returns
-- the first counter rather than racing the unique index.
create or replace function reverse_stock_movement(
  p_movement_id     uuid,
  p_reason          text,
  p_manager_pin     text,
  p_idempotency_key text default null
)
returns stock_movements
language plpgsql
security definer
set search_path = public
as $$
declare
  v_original stock_movements;
  v_counter  stock_movements;
  v_existing stock_movements;
  v_manager  uuid;
  v_reason   text;
  v_key      text;
  v_timezone text;
  v_date     date;
  v_basis    numeric;
  v_qty      numeric;
  v_blocker  text;
  v_actor    uuid := auth.uid();
begin
  -- --- GUARD 1: resolve and LOCK the original ------------------------------
  -- FOR UPDATE so two terminals reversing the same movement in the same instant
  -- serialise here rather than both reaching the insert. The unique index is
  -- still the arbiter; this is what turns a raw 23505 into an ordered outcome.
  select * into v_original
  from stock_movements
  where id = p_movement_id
  for update;

  if not found then
    raise exception 'Stock movement % not found', p_movement_id
      using errcode = 'PT404';
  end if;

  -- --- GUARD 2: staff of the owning tenant ---------------------------------
  if not is_tenant_staff(v_original.tenant_id) then
    raise exception 'Not authorised to reverse stock movements for this property'
      using errcode = 'insufficient_privilege';
  end if;

  -- --- GUARD 3: idempotency, by an EXPLICIT key ONLY -----------------------
  -- THE DISTINCTION THIS GUARD DRAWS, and why it is not pedantic. A key the
  -- CALLER supplied means "this is one request of mine, possibly retried" — a
  -- dropped connection or a double-click, where returning the first counter is
  -- exactly right and an error would be a lie. Asking to reverse the same
  -- movement a second time with no key is a DIFFERENT act: it is a person
  -- deciding to reverse something again, and the honest answer is that it was
  -- already reversed, on such-and-such a day. Collapsing the two would mean the
  -- second request silently reported success, and the user would believe two
  -- reversals had been posted when only one had.
  --
  -- So the replay path requires an explicit key. The derived key below is still
  -- written onto the row, so stock_movements_idem_uniq covers it, but it is
  -- never used to short-circuit.
  v_key := nullif(btrim(coalesce(p_idempotency_key, '')), '');

  if v_key is not null then
    select * into v_existing
    from stock_movements
    where tenant_id = v_original.tenant_id
      and idempotency_key = v_key
    limit 1;
    if found then
      return v_existing;
    end if;
  else
    -- Rule 2 admits no exception: a write RPC always has a key. A movement is
    -- reversed once ever, so the target IS the canonical key.
    v_key := 'reversal:' || p_movement_id::text;
  end if;

  -- --- GUARD 4: THE STATE. A movement is reversed once, ever. --------------
  -- Reached by every caller who did not replay an explicit key, so this is what
  -- answers a second attempt. The partial unique index makes it true under
  -- concurrency; this makes it a sentence rather than a constraint name.
  select * into v_existing
  from stock_movements
  where reverses_movement_id = p_movement_id
  limit 1;
  if found then
    raise exception
      'This movement was already reversed on %. A movement is reversed once, ever.',
      to_char(v_existing.business_date, 'DD Mon YYYY')
      using errcode = 'PT409',
            hint = 'The stock is already back where it started. Post a fresh movement if it needs to move again.';
  end if;

  -- --- GUARD 5: the original must not itself be a reversal ------------------
  if v_original.movement_type = 'reversal' then
    raise exception 'This movement is itself a reversal and cannot be reversed'
      using errcode = 'PT409',
            hint = 'The stock is already back where it started. Post a fresh adjustment if it needs to move again.';
  end if;

  -- --- GUARD 6: an opening balance is corrected, not reversed --------------
  if v_original.movement_type = 'opening' then
    raise exception
      'An opening balance cannot be reversed — it is the starting line of this item''s history in this location.'
      using errcode = 'PT409',
            hint = 'Post an adjustment for the difference instead. Before anything else has moved, the average still equals the opening cost, so an adjustment unwinds it exactly.';
  end if;

  -- --- GUARD 7: a reason, here and not only in the UI (rule 19) ------------
  v_reason := btrim(coalesce(p_reason, ''));
  if v_reason = '' then
    raise exception 'A reversal needs a reason'
      using errcode = 'PT422',
            hint = 'It is recorded permanently against your name and the approving manager''s.';
  end if;

  -- --- GUARD 8: A MANAGER PIN. ALWAYS. NO THRESHOLD. ----------------------
  -- Identical to reverse_charge (032 §GUARD 9) and for the identical reason:
  -- there is no quantity of stock at which erasing a recorded movement is
  -- routine. Reversal is the power to erase.
  v_manager := verify_manager_pin(v_original.tenant_id, p_manager_pin);
  if v_manager is null then
    raise exception 'Reversing a stock movement always requires a valid manager PIN'
      using errcode = 'insufficient_privilege',
            hint = 'Hand the terminal to a manager. The reversal is recorded against them by name.';
  end if;

  -- --- THE BUSINESS DATE: TODAY, never the original's day ------------------
  select p.timezone into v_timezone
  from properties p where p.id = v_original.property_id;
  v_date := (now() at time zone coalesce(nullif(btrim(v_timezone), ''), 'Africa/Lagos'))::date;

  -- --- GUARD 9: the posting lock ------------------------------------------
  -- Checked against TODAY, which is the only date this posts on. A lock set to
  -- today or later closes the reversal path too, and that is correct: a hotel
  -- that has closed today's books has closed them for corrections as well.
  perform assert_posting_open(v_original.property_id, v_date);

  -- --- THE COST BASIS -----------------------------------------------------
  -- The whole point of §5. Whichever direction the original went, the counter
  -- carries the cost the ORIGINAL moved, so quantity and value both unwind to
  -- exactly zero.
  --
  --   original was a stock-IN  -> basis is its own stated unit_cost;
  --   original was a stock-OUT -> basis is the carried cost stamped on it (§6),
  --                               i.e. what that stock actually cost on the way
  --                               out, not what the average happens to be now.
  if v_original.quantity > 0 then
    v_basis := v_original.unit_cost;
  else
    v_basis := v_original.carried_unit_cost;
  end if;

  if v_basis is null then
    -- Only reachable for a movement written before §6's trigger existed, in a
    -- location that had no history to value it. Refused rather than guessed: a
    -- reversal posted at a made-up cost is a silent corruption of the average,
    -- which is precisely what this migration exists to prevent.
    raise exception
      'This movement has no recorded cost, so reversing it would have to guess what the stock was worth.'
      using errcode = 'PT422',
            hint = 'Post an adjustment stating the cost explicitly instead.';
  end if;

  v_qty := - v_original.quantity;

  -- --- GUARD 10: a counter that ADDS stock needs somewhere reachable to put it
  --
  -- THE HOLE THIS CLOSES, which is §10's own hole reached by a different road:
  --   1. an item moves into a location and back out to zero;
  --   2. the location is switched off — §10 permits it, correctly, because net
  --      on-hand is zero and nothing is being stranded;
  --   3. somebody reverses the outbound issue;
  --   4. stock reappears in an inactive location, where both posting RPCs
  --      require is_active = true — so it cannot be adjusted, cannot be written
  --      down to zero, and cannot be moved. Stranded, permanently.
  --
  -- §10 guards the act of switching off. This guards the act that puts stock
  -- back, which is the only other way to arrive at the same place. Checked ONLY
  -- when the counter is positive: a counter that REMOVES stock strands nothing
  -- and must stay available, because reversing a mis-keyed receipt into a
  -- location that has since been retired is exactly the correction somebody
  -- needs to be able to make.
  if v_qty > 0 then
    select case
             when l.deleted_at is not null then 'the location "' || l.name || '" has been removed'
             when not l.is_active          then 'the location "' || l.name || '" is switched off'
           end
      into v_blocker
    from locations l
    where l.id = v_original.location_id;

    if v_blocker is null then
      select case
               when i.deleted_at is not null then 'the item "' || i.name || '" has been removed from the catalogue'
               when not i.is_active          then 'the item "' || i.name || '" is switched off'
             end
        into v_blocker
      from inventory_items i
      where i.id = v_original.inventory_item_id;
    end if;

    if v_blocker is not null then
      raise exception
        'Reversing this movement would put stock back, but % — and stock there could not then be counted, corrected or moved.',
        v_blocker
        using errcode = 'PT409',
              hint = 'Switch it back on (or restore it) first, then reverse the movement.';
    end if;
  end if;

  -- --- THE COUNTER-MOVEMENT ------------------------------------------------
  -- unit_cost and carried_unit_cost are BOTH set, and which one is populated is
  -- decided by 036's cost/direction constraint rather than by preference:
  --   counter is positive -> unit_cost is REQUIRED (rounded to money precision);
  --   counter is negative -> unit_cost is FORBIDDEN and must be NULL.
  -- carried_unit_cost carries the full 4-decimal basis in both cases, and it is
  -- what the fold reads for a 'reversal' row — so the rounding on unit_cost is a
  -- display concern and never enters the arithmetic.
  --
  -- 036's constraint is left completely alone. It is the weighted-average method
  -- written as a constraint, and the reversal cost travels beside unit_cost
  -- rather than inside it.
  begin
  insert into stock_movements (
    tenant_id, property_id, location_id, inventory_item_id,
    movement_type, quantity, unit_cost, carried_unit_cost,
    business_date, reason, note, source,
    source_document_type, source_document_id,
    reverses_movement_id, batch_code, expiry_date,
    idempotency_key, created_by
  ) values (
    v_original.tenant_id, v_original.property_id,
    v_original.location_id, v_original.inventory_item_id,
    'reversal',
    v_qty,
    case when v_qty > 0 then round(v_basis, 2) else null end,
    v_basis,
    v_date,
    v_reason,
    -- The counter says what it undid and when, on the row itself, so the ledger
    -- reads correctly with no join. Copied rather than derived: a movement is
    -- permanent, so the copy can never drift from its source.
    format('Reversal of the %s of %s dated %s',
           v_original.movement_type,
           format_stock_quantity(v_original.quantity),
           to_char(v_original.business_date, 'DD Mon YYYY')),
    'reversal',
    'stock_movement', p_movement_id,
    p_movement_id,
    -- A batch is a property of the physical stock, so the counter moves the same
    -- batch back. A future FEFO build must see the batch on both rows or its
    -- per-batch position will be wrong by the reversal.
    v_original.batch_code, v_original.expiry_date,
    v_key, v_actor
  )
  returning * into v_counter;

  -- Belt-and-braces. GUARD 1's FOR UPDATE lock already serialises two terminals
  -- reversing the same movement — the second waits, then GUARD 4 sees the
  -- first's counter and says so. This handler exists so that if any future path
  -- reaches the insert without that lock, the caller still gets the first
  -- counter rather than a raw 23505.
  exception
    when unique_violation then
      select * into v_existing
      from stock_movements
      where reverses_movement_id = p_movement_id
         or (tenant_id = v_original.tenant_id and idempotency_key = v_key)
      limit 1;
      if found then
        return v_existing;
      end if;
      raise;
  end;

  -- --- THE AUDIT ROW -------------------------------------------------------
  -- Written last so it can name the counter it produced. Any failure here rolls
  -- the counter-movement back with it, so there is no state in which stock moved
  -- without a record of who authorised it.
  insert into reversals (
    tenant_id, property_id, reversed_by, approved_by, reason,
    target_type, target_id, counter_entry_id, business_date,
    idempotency_key, created_by
  ) values (
    v_original.tenant_id, v_original.property_id, v_actor, v_manager, v_reason,
    'stock_movement', p_movement_id, v_counter.id, v_date,
    v_key, v_actor
  );

  return v_counter;
end;
$$;

comment on function reverse_stock_movement(uuid, text, text, text) is
  'Reverses a stock movement by posting an equal-and-opposite ''reversal'' '
  'movement — the original row is never touched, because movements are permanent. '
  'ALWAYS requires a valid manager PIN and a non-empty reason, both enforced here '
  'and not only in the UI (rule 19). The counter posts on the CURRENT business '
  'date, never the original''s: a closed day is not rewritten, exactly as '
  'reverse_charge. It carries the ORIGINAL''s cost basis in carried_unit_cost, so '
  'the moving average unwinds by exactly what it was moved by. Refuses a movement '
  'that is itself a reversal, one already reversed, and an opening balance (which '
  'is corrected with an adjustment). Idempotent by key and by state; writes a '
  'permanent reversals row naming who reversed and which manager approved.';


-- ############################################################################
-- SECTION 8 — THE POSTING RPCs LEARN THE LOCK, THE BATCH AND THE EXPIRY
-- ############################################################################
-- BOTH FUNCTIONS ARE DROPPED AND RECREATED rather than replaced, because they
-- gain two TRAILING parameters and CREATE OR REPLACE cannot change a signature.
-- The client contract is unchanged and no TypeScript needs editing: PostgREST
-- calls an RPC with NAMED arguments, and both new parameters carry SQL defaults,
-- so every existing call in src/lib/stock.ts resolves to the new function and
-- gets NULL for the two it does not send.
--
-- WHY THE PARAMETERS AT ALL, when nothing in the UI sets a batch yet. Because
-- without them tracks_expiry would be a landmine: switch the flag on and stock
-- entry would fail with no field on any screen able to satisfy it. The flag has
-- to be usable the moment it is set, even if the only caller today is psql.
--
-- Everything else in both bodies is byte-for-byte 036's, deliberately. This
-- migration is not the place to improve them.

drop function if exists post_opening_balance(uuid, uuid, uuid, numeric, numeric, date, text, text);
drop function if exists post_stock_adjustment(uuid, uuid, uuid, numeric, text, date, numeric, text, boolean);


-- ----------------------------------------------------------------------------
-- 8.1 post_opening_balance
-- ----------------------------------------------------------------------------
create or replace function post_opening_balance(
  p_property_id       uuid,
  p_location_id       uuid,
  p_inventory_item_id uuid,
  p_quantity          numeric,
  p_unit_cost         numeric,
  p_business_date     date,
  p_note              text,
  p_idempotency_key   text,
  p_batch_code        text default null,
  p_expiry_date       date default null
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
  v_tracks   boolean;
  v_batch    text;
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

  -- 038: tracks_expiry is read here alongside the availability check, so the
  -- batch rule below costs no extra query.
  select i.tracks_expiry into v_tracks
  from inventory_items i
  where i.id = p_inventory_item_id
    and i.tenant_id = v_tenant
    and i.deleted_at is null
    and i.is_active = true;

  if v_tracks is null then
    raise exception 'That item is not available in this catalogue'
      using errcode = 'PT404';
  end if;

  if p_quantity is null or p_quantity <= 0 then
    raise exception 'An opening balance must be greater than zero. To record nothing on hand, post no opening balance at all.'
      using errcode = 'PT422';
  end if;

  if p_unit_cost is null then
    raise exception 'A unit cost is required on an opening balance — it is what the stock on hand is worth.'
      using errcode = 'PT422';
  end if;
  if p_unit_cost < 0 then
    raise exception 'A unit cost cannot be negative' using errcode = 'PT422';
  end if;

  -- 038: THE BATCH RULE. Cross-table (the flag is on the item, the values are on
  -- the movement), so it is enforced here rather than as a CHECK. An opening
  -- balance of a batch-tracked item is stock physically on a shelf with a code
  -- printed on it — there is nothing special about day one that makes the code
  -- unknowable.
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

  -- 038: THE POSTING LOCK. After the future-date guard, so a caller who is wrong
  -- about both is told about the nearer problem first.
  perform assert_posting_open(p_property_id, v_date);

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
      reason, note, source, batch_code, expiry_date,
      idempotency_key, created_by
    ) values (
      v_tenant, p_property_id, p_location_id, p_inventory_item_id,
      'opening', p_quantity, p_unit_cost, v_date,
      null, nullif(btrim(p_note), ''), 'manual', v_batch, p_expiry_date,
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
      raise exception 'This item already has an opening balance in this location. Post an adjustment to correct the quantity instead.'
        using errcode = 'PT409';
  end;

  return v_movement;
end;
$$;

comment on function post_opening_balance(uuid, uuid, uuid, numeric, numeric, date, text, text, text, date) is
  'Posts the day-one ''opening'' movement: what a location held when the hotel '
  'started using the system, and what it cost per base unit. ONCE per item per '
  'location, guarded twice (the idempotency key collapses an identical replay; '
  'stock_movements_one_opening_uniq refuses a second opening under any other '
  'key). 038 adds the posting-lock check and the batch/expiry pair, which are '
  'REQUIRED when the item''s tracks_expiry is set — a cross-table rule, so it is '
  'enforced here and not as a CHECK. Staff-gated, SECURITY DEFINER, pinned '
  'search_path. NULL p_business_date = the property''s local today; a future date '
  'is refused. ONGOING stock-in is a purchase receipt (2c), never this.';


-- ----------------------------------------------------------------------------
-- 8.2 post_stock_adjustment
-- ----------------------------------------------------------------------------
-- THE NEGATIVE-STOCK BEHAVIOUR IS UNCHANGED, and that is a decision. 036 ships
-- PT449 + confirm + resubmit-with-the-same-key, which already satisfies "never
-- blocked": the user can always proceed, they are simply told first, and the
-- shared key means confirming cannot double-post. It is the same
-- warn-once-and-confirm pattern used elsewhere in the product. Changing the
-- return type to carry a flag instead would have meant rewriting
-- postStockAdjustment and StockEntryForm — tested, working code — to reach the
-- same outcome. 038 adds the negative-stock VIEW (§9) so the condition can be
-- reported on, and leaves the posting path alone.
create or replace function post_stock_adjustment(
  p_property_id       uuid,
  p_location_id       uuid,
  p_inventory_item_id uuid,
  p_quantity          numeric,   -- SIGNED: + adds, - removes
  p_reason            text,      -- mandatory
  p_business_date     date,
  p_unit_cost         numeric,   -- positive adjustments only; NULL = current average
  p_idempotency_key   text,
  p_allow_negative    boolean default false,
  p_batch_code        text default null,
  p_expiry_date       date default null
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

  -- An INACTIVE item may still be adjusted, unlike an opening balance: a
  -- discontinued line still sitting on a shelf has to be correctable and
  -- writable down to zero.
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
    raise exception 'An adjustment must add or remove some quantity. Enter a positive number to add stock or a negative one to remove it.'
      using errcode = 'PT422';
  end if;

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

  -- 038: THE POSTING LOCK.
  perform assert_posting_open(p_property_id, v_date);

  select * into v_val
  from stock_valuation(p_property_id, p_location_id, p_inventory_item_id);

  v_batch := nullif(btrim(coalesce(p_batch_code, '')), '');

  if p_quantity > 0 then
    v_cost := coalesce(p_unit_cost, v_val.moving_average_cost);
    if v_cost is null then
      raise exception 'This item has no stock history in this location, so a unit cost is required to add stock.'
        using errcode = 'PT422';
    end if;
    if v_cost < 0 then
      raise exception 'A unit cost cannot be negative' using errcode = 'PT422';
    end if;

    -- 038: THE BATCH RULE, on the stock-IN side only. Stock LEAVING does not
    -- state a batch here: which batch went out is a FEFO decision, and inventing
    -- an answer now would put a guess into the history a recall will read.
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

  -- THE NEGATIVE GUARD. Flag, do not forbid.
  v_result := coalesce(v_val.quantity_on_hand, 0) + p_quantity;
  if v_result < 0 and not coalesce(p_allow_negative, false) then
    raise exception
      'This adjustment would leave % % on hand, which is less than nothing. Check the quantity — or confirm to record it anyway.',
      format_stock_quantity(v_result), v_unit
      using errcode = 'PT449';
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

  return v_movement;
end;
$$;

comment on function post_stock_adjustment(uuid, uuid, uuid, numeric, text, date, numeric, text, boolean, text, date) is
  'Posts an ''adjustment'' movement — a correction with no purchase or sale behind '
  'it, which is why a REASON is mandatory and the actor is stamped from the '
  'session and unforgeable. Signed quantity: + adds, - removes. A positive '
  'adjustment defaults its unit cost to the CURRENT moving average; a negative one '
  'may state no cost and no batch (which batch left is an issue-rules decision, '
  'not a typed one). An adjustment that would drive on-hand below zero still '
  'raises PT449 and must be re-submitted with p_allow_negative => true and the '
  'SAME idempotency key — flagged, never blocked. 038 adds the posting-lock check '
  'and the batch/expiry pair required when the item''s tracks_expiry is set. '
  'Staff-gated, idempotent (rules 2/3), SECURITY DEFINER, pinned search_path.';


-- ############################################################################
-- SECTION 9 — NEGATIVE STOCK, SURFACED
-- ############################################################################
-- Negative on-hand is never blocked and never floored (rule 7). 036 argues the
-- point at length and this migration keeps it: blocking an issue stops service,
-- and staff who cannot get through the night invent fake receipts to do it —
-- which destroys the ledger far more thoroughly than an honest negative.
--
-- But "not blocked" is only half a policy. A negative that nobody looks at is
-- the same as a floored one. This view is the other half: the list of every
-- position that says less than nothing, so it can be worked through.
--
-- WHAT A NEGATIVE MEANS, stated here because the view is where someone will read
-- it: stock left without a movement. A delivery that was never entered, an issue
-- posted against the wrong location, or stock that walked. It is a QUESTION, not
-- an error — and it is the single most useful question this module produces.
--
-- BUILT ON stock_on_hand DIRECTLY, not on stock_on_hand_items, and the joins do
-- NOT filter deleted_at. That is deliberate: a discrepancy report must not be
-- able to hide a row. §10 makes it impossible to remove or deactivate an item or
-- a location holding stock, so a soft-deleted parent here would itself be a bug
-- — and this is the view that would reveal it.
create or replace view stock_negative_positions
with (security_invoker = on) as
select
  soh.tenant_id,
  soh.property_id,
  soh.location_id,
  soh.inventory_item_id,
  soh.quantity_on_hand,
  soh.moving_average_cost,
  soh.stock_value,
  soh.last_movement_date,
  i.name        as item_name,
  i.code        as item_code,
  i.base_unit,
  i.category_id,
  i.is_active   as item_is_active,
  i.deleted_at  as item_deleted_at,
  l.name        as location_name,
  l.kind        as location_kind,
  l.is_active   as location_is_active,
  l.deleted_at  as location_deleted_at,
  c.name        as category_name
from stock_on_hand soh
join inventory_items i
  on i.id = soh.inventory_item_id
 and i.tenant_id = soh.tenant_id
join locations l
  on l.id = soh.location_id
 and l.property_id = soh.property_id
left join inventory_categories c
  on c.id = i.category_id
 and c.tenant_id = soh.tenant_id
where soh.quantity_on_hand < 0;

comment on view stock_negative_positions is
  'Every (location, item) holding LESS THAN NOTHING — the discrepancy report. A '
  'negative on-hand is stock that left without a movement: a delivery never '
  'entered, an issue posted to the wrong location, or stock that walked. Negative '
  'stock is never blocked and never floored (rule 7); this is where it is looked '
  'at instead. Deliberately does NOT filter soft-deleted items or locations — a '
  'discrepancy report must not be able to hide a row, and §10 makes a '
  'soft-deleted parent holding stock impossible, so one appearing here is itself '
  'the finding. security_invoker: the caller''s RLS decides what is visible.';


-- ############################################################################
-- SECTION 10 — REMOVAL AND DEACTIVATION GUARDS THAT NAME WHAT IS IN THE WAY
-- ############################################################################
-- 036 §6 shipped both guards against SOFT DELETE only, and with a message that
-- names nothing. Two things are wrong with that, and the second is a live bug:
--
--   1. "This item still has stock on hand in at least one location" tells the
--      user there is a problem and gives them no way to find it. They then have
--      to hunt every location by hand. Naming the locations and quantities turns
--      a refusal into an instruction.
--
--   2. DEACTIVATION WAS COMPLETELY UNGUARDED, and for a LOCATION that is not
--      cosmetic. post_stock_adjustment and post_opening_balance both require
--      `l.is_active = true`, so switching off a location that still holds stock
--      makes that stock permanently unadjustable and unremovable — it cannot
--      even be written down to zero to release the location. The stock is
--      stranded exactly as if the location had been deleted, which is the
--      outcome 035 §7 wrote the guard to prevent. Closing that is the point of
--      this section.
--
-- Both guards still test NON-ZERO ON-HAND, not "has any history": an item that
-- moved in and back out to zero holds nothing and can be retired, and its
-- movements stay readable forever.
--
-- Both read stock_movements DIRECTLY under SECURITY DEFINER, so the guard sees
-- every row regardless of the caller's RLS and cannot be defeated by a caller
-- who simply cannot see the stock they are about to strand.

create or replace function guard_item_stock_on_remove()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_positions text;
  v_verb      text;
begin
  -- WHICH TRANSITION IS THIS? Only the crossings matter — editing an already
  -- removed row, or an already inactive one, is none of this trigger's business,
  -- and re-raising on it would make an unrelated edit impossible to save.
  if new.deleted_at is not null and old.deleted_at is null then
    v_verb := 'removed from the catalogue';
  elsif new.is_active = false and old.is_active = true then
    v_verb := 'switched off';
  else
    return new;
  end if;

  -- Name every location and quantity, in the hotel's own location order.
  select string_agg(
           l.name || ' (' || format_stock_quantity(t.qty) || ' ' || old.base_unit || ')',
           ', ' order by l.display_order, l.name)
    into v_positions
  from (
    select sm.location_id, sum(sm.quantity) as qty
    from stock_movements sm
    where sm.inventory_item_id = old.id
    group by sm.location_id
    having sum(sm.quantity) <> 0
  ) t
  join locations l on l.id = t.location_id;

  if v_positions is not null then
    raise exception
      'This item cannot be % while it still holds stock: %. Write it down to zero with an adjustment first.',
      v_verb, v_positions
      using errcode = 'PT409';
  end if;

  return new;
end;
$$;

comment on function guard_item_stock_on_remove() is
  'Refuses BOTH the soft-delete and the deactivation of a catalogue item that '
  'still holds stock anywhere, naming every location and quantity so the refusal '
  'is an instruction rather than a dead end. Tests NON-ZERO on-hand, not "has '
  'history": an item that moved back to zero can be retired and keeps its '
  'history. At the DB, not the UI (rule 19). The other half of 035 §7''s item '
  'rule — an item used by a live RECIPE — belongs to the recipe tranche.';

create or replace function guard_location_stock_on_remove()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_positions text;
  v_verb      text;
begin
  if new.deleted_at is not null and old.deleted_at is null then
    v_verb := 'removed';
  elsif new.is_active = false and old.is_active = true then
    -- THE LIVE BUG THIS CLOSES. Both posting RPCs require an ACTIVE location, so
    -- switching one off while it holds stock leaves that stock unreachable by
    -- every write path — it cannot even be written down to zero. Deactivating is
    -- as destructive as removing, and is guarded identically.
    v_verb := 'switched off';
  else
    return new;
  end if;

  select string_agg(
           i.name || ' (' || format_stock_quantity(t.qty) || ' ' || i.base_unit || ')',
           ', ' order by i.name)
    into v_positions
  from (
    select sm.inventory_item_id, sum(sm.quantity) as qty
    from stock_movements sm
    where sm.location_id = old.id
    group by sm.inventory_item_id
    having sum(sm.quantity) <> 0
  ) t
  join inventory_items i on i.id = t.inventory_item_id;

  if v_positions is not null then
    raise exception
      'This location cannot be % while it still holds stock: %. Transfer it out or write it off with an adjustment first — otherwise the stock stays in the ledger with no screen able to reach it.',
      v_verb, v_positions
      using errcode = 'PT409';
  end if;

  return new;
end;
$$;

comment on function guard_location_stock_on_remove() is
  'Refuses BOTH the soft-delete and the deactivation of a location that still '
  'holds stock, naming every item and quantity. The deactivation half closes a '
  'live gap: both posting RPCs require an ACTIVE location, so switching one off '
  'while it holds stock stranded that stock beyond every write path — it could '
  'not even be written down to zero. Tests NON-ZERO on-hand, not "has history".';


-- ############################################################################
-- SECTION 11 — GRANTS
-- ############################################################################
-- Every SECURITY DEFINER function defaults to EXECUTE for PUBLIC, so each is
-- revoked and then granted its intended audience only. §12 asserts the result
-- rather than trusting it.

-- --- The two write RPCs, recreated in §8 (a DROP takes its grants with it) ---
revoke all on function post_opening_balance(uuid, uuid, uuid, numeric, numeric, date, text, text, text, date) from public, anon;
grant  execute on function post_opening_balance(uuid, uuid, uuid, numeric, numeric, date, text, text, text, date) to authenticated;

revoke all on function post_stock_adjustment(uuid, uuid, uuid, numeric, text, date, numeric, text, boolean, text, date) from public, anon;
grant  execute on function post_stock_adjustment(uuid, uuid, uuid, numeric, text, date, numeric, text, boolean, text, date) to authenticated;

-- --- The reversal ---------------------------------------------------------
-- service_role is revoked EXPLICITLY, exactly as 033/034 do for the other
-- reversals, with the same honest caveat: this guards against ACCIDENT, not
-- against the service role, which has BYPASSRLS and could write the rows
-- directly. What it buys is that no future unattended job — a night audit pass,
-- an import cleanup — can reach the decision to erase a stock movement by
-- calling the obvious RPC. Reversing stock is a person's judgement made with a
-- manager standing beside them.
revoke all on function reverse_stock_movement(uuid, text, text, text) from public, anon, service_role;
grant  execute on function reverse_stock_movement(uuid, text, text, text) to authenticated;

-- --- The settings writer, replaced in §4.2 --------------------------------
revoke all on function update_property_finance_settings(uuid, jsonb, timestamptz) from public, anon;
grant  execute on function update_property_finance_settings(uuid, jsonb, timestamptz) to authenticated;

-- --- Helpers --------------------------------------------------------------
-- assert_posting_open is granted to authenticated: a client may legitimately
-- want to check before offering a date picker, and it discloses nothing the
-- settings row does not already show a member.
revoke all on function assert_posting_open(uuid, date) from public, anon;
grant  execute on function assert_posting_open(uuid, date) to authenticated;

revoke all on function stock_average_cost_as_at(uuid, uuid, date, bigint) from public, anon;
grant  execute on function stock_average_cost_as_at(uuid, uuid, date, bigint) to authenticated;

-- Trigger plumbing, called by its trigger and by nothing else. A trigger runs as
-- the trigger, not under the caller's EXECUTE privilege, so revoking is free.
revoke all on function set_stock_carried_cost() from public, anon, authenticated;

-- format_stock_quantity is IMMUTABLE, touches no table and is not SECURITY
-- DEFINER, so it is safe for anyone — and the views' error paths need it.

-- --- The new view ---------------------------------------------------------
-- The `revoke all ... from authenticated` before the grant is load-bearing and
-- NOT redundant with the revoke from public: Supabase's default privileges grant
-- ALL on every new relation in `public` to `authenticated`, so a bare
-- `grant select` would leave INSERT/UPDATE/DELETE in place.
revoke all on stock_negative_positions from public;
revoke all on stock_negative_positions from anon;
revoke all on stock_negative_positions from authenticated;
grant select on stock_negative_positions to authenticated;

-- --- 035's two trigger wrappers: the hygiene defect this shipment found ----
-- Both are SECURITY DEFINER and both were left with the default PUBLIC ACL when
-- 035 §8 revoked their worker functions and forgot the wrappers. NOT a reachable
-- hole — Postgres refuses direct invocation of any `returns trigger` function
-- whatever the privilege, and PostgREST does not expose them at all, both of
-- which were tested rather than assumed. Revoked so that §12's assertion can be
-- written strictly across the whole module, with no exception list for a future
-- reader to mistake for an allowance.
revoke all on function seed_tenant_inventory_reference_trigger() from public, anon, authenticated;
revoke all on function create_default_locations_trigger() from public, anon, authenticated;


-- ############################################################################
-- SECTION 12 — IN-TRANSACTION SELF-VERIFY
-- ############################################################################
-- Counted assertions, inside the migration's own transaction, so a migration
-- that half-worked never commits. Everything here is checkable without touching
-- data — the arithmetic proofs run the aggregate over literal VALUES rows, so
-- the fold is proven on this database before a single movement exists.
do $$
declare
  v_count   integer;
  v_avg     numeric;
  v_missing text;
begin
  -- --- 1. The four new columns exist, with the right types ----------------
  select count(*) into v_count
  from information_schema.columns
  where table_schema = 'public' and table_name = 'stock_movements'
    and column_name in ('carried_unit_cost', 'reverses_movement_id',
                        'batch_code', 'expiry_date');
  if v_count <> 4 then
    raise exception 'ASSERT FAILED: expected 4 new stock_movements columns, found %', v_count;
  end if;

  select count(*) into v_count
  from information_schema.columns
  where table_schema = 'public'
    and ((table_name = 'inventory_items' and column_name = 'tracks_expiry')
      or (table_name = 'property_finance_settings' and column_name = 'posting_locked_through'));
  if v_count <> 2 then
    raise exception 'ASSERT FAILED: expected tracks_expiry and posting_locked_through, found %', v_count;
  end if;

  -- --- 2. 'reversal' is an accepted movement type -------------------------
  select count(*) into v_count
  from pg_constraint
  where conname = 'stock_movements_type_check'
    and pg_get_constraintdef(oid) like '%''reversal''%';
  if v_count <> 1 then
    raise exception 'ASSERT FAILED: stock_movements_type_check does not admit ''reversal''';
  end if;

  select count(*) into v_count
  from pg_constraint
  where conname = 'reversals_target_type_check'
    and pg_get_constraintdef(oid) like '%''stock_movement''%';
  if v_count <> 1 then
    raise exception 'ASSERT FAILED: reversals_target_type_check does not admit ''stock_movement''';
  end if;

  -- --- 3. There is exactly ONE fold ---------------------------------------
  select count(*) into v_count
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'stock_wac' and p.prokind = 'a';
  if v_count <> 1 then
    raise exception
      'ASSERT FAILED: expected exactly 1 stock_wac aggregate (one definition of weighted-average cost), found %', v_count;
  end if;

  -- --- 4. THE RESIDUE PROOF, run as arithmetic on this database -----------
  -- 100 @ 1.50, then 50 @ 2.10. The average must be exactly 1.70.
  select round((stock_wac(v.q, v.c, v.rc order by v.ord)).average_cost, 4)
    into v_avg
  from (values (1, 100::numeric, 1.50::numeric, null::numeric),
               (2,  50::numeric, 2.10::numeric, null::numeric)) v(ord, q, c, rc);
  if v_avg <> 1.7000 then
    raise exception 'ASSERT FAILED: two-receipt average should be 1.7000, got %', v_avg;
  end if;

  -- Now reverse the second receipt: -50 carrying its basis of 2.10. The average
  -- must return to EXACTLY 1.50, with no residue. This is the single assertion
  -- that justifies rebuilding the fold.
  select round((stock_wac(v.q, v.c, v.rc order by v.ord)).average_cost, 4)
    into v_avg
  from (values (1, 100::numeric, 1.50::numeric, null::numeric),
               (2,  50::numeric, 2.10::numeric, null::numeric),
               (3, -50::numeric, null::numeric, 2.10::numeric)) v(ord, q, c, rc);
  if v_avg <> 1.5000 then
    raise exception
      'ASSERT FAILED: reversing the receipt should return the average to 1.5000, got % — the residue is still there', v_avg;
  end if;

  -- And the quantity must be back to 100.
  select (stock_wac(v.q, v.c, v.rc order by v.ord)).quantity
    into v_avg
  from (values (1, 100::numeric, 1.50::numeric, null::numeric),
               (2,  50::numeric, 2.10::numeric, null::numeric),
               (3, -50::numeric, null::numeric, 2.10::numeric)) v(ord, q, c, rc);
  if v_avg <> 100 then
    raise exception 'ASSERT FAILED: on-hand after the reversal should be 100, got %', v_avg;
  end if;

  -- --- 5. An ORDINARY stock-out still leaves the average alone ------------
  -- The guarantee that nothing else changed. 100 @ 1.50, 50 @ 2.10 (avg 1.70),
  -- then an ordinary issue of 50 with NO reversal basis: still 1.70.
  select round((stock_wac(v.q, v.c, v.rc order by v.ord)).average_cost, 4)
    into v_avg
  from (values (1, 100::numeric, 1.50::numeric, null::numeric),
               (2,  50::numeric, 2.10::numeric, null::numeric),
               (3, -50::numeric, null::numeric, null::numeric)) v(ord, q, c, rc);
  if v_avg <> 1.7000 then
    raise exception
      'ASSERT FAILED: an ordinary stock-out must not move the average (expected 1.7000, got %)', v_avg;
  end if;

  -- --- 6. NO SECURITY DEFINER FUNCTION ANYWHERE IN public IS ANON-EXECUTABLE
  --
  -- A REAL SWEEP, not a name list. The first draft of this assertion listed
  -- fifteen function names — which would have caught nothing, because the defect
  -- it exists to catch is precisely a function NOBODY THOUGHT TO LIST. 035's two
  -- forgotten trigger wrappers were found by a sweep, not by a list, and a list
  -- would have let the next forgotten one through in silence.
  --
  -- So it is inverted: every SECURITY DEFINER function in `public` is in scope by
  -- default, and anything holding anon EXECUTE must be explained by one of the
  -- two arrays below. A function added tomorrow is caught automatically.
  --
  -- EXEMPTION 1 — the RLS helpers. These MUST stay anon-executable: the public
  -- storefront's own RLS policies invoke them, so revoking would take the guest
  -- site down. They disclose nothing to an unauthenticated caller — auth.uid() is
  -- NULL, so get_tenant_ids() returns the empty array and both predicates are
  -- false. Fail-closed by construction.
  --
  -- EXEMPTION 2 — the QUARANTINE. Six pre-existing functions (008, 030) whose
  -- grants predate this shipment. NOT a live exposure and it was checked rather
  -- than assumed: every one of them gates internally on is_tenant_admin() or on
  -- auth.uid() being non-null, so an anon call raises rather than acting. But
  -- they are one layer where the rest of the module has two, and they belong to
  -- the 1.3 security sweep alongside the table-level anon GRANTs.
  --
  -- WRITING THEM DOWN HERE IS THE POINT. A finding recorded in prose is a finding
  -- that gets forgotten; a finding recorded as an assertion cannot be. The list
  -- can only SHRINK — 1.3 removes an entry as it revokes each grant, and until
  -- then any NEW leak fails this migration.
  --
  -- Trigger-returning functions are exempt MECHANICALLY rather than by name:
  -- Postgres refuses direct invocation of any `returns trigger` function whatever
  -- the privilege (tested, error 0A000), and PostgREST does not expose them.
  select string_agg(leaks.fn, ', ' order by leaks.fn)
    into v_missing
  from (
    select p.proname as nm,
           p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as fn
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosecdef
      and p.prorettype <> 'pg_catalog.trigger'::regtype
      and has_function_privilege('anon', p.oid, 'EXECUTE')
  ) leaks
  where leaks.nm <> all (array[
          -- EXEMPTION 1: invoked by anon RLS policies; removing them breaks the guest site.
          'get_tenant_ids', 'get_property_ids', 'is_tenant_admin', 'is_tenant_staff'
        ])
    and leaks.nm <> all (array[
          -- EXEMPTION 2: the 1.3 quarantine. All self-gate; all still want the grant revoked.
          'claim_statement_email', 'complete_statement_email',
          'update_property_branding', 'update_property_config',
          'update_property_details', 'update_tenant_settings'
        ]);

  if v_missing is not null then
    raise exception
      'ASSERT FAILED: anon holds EXECUTE on these SECURITY DEFINER functions, and they are neither RLS helpers nor on the 1.3 quarantine list: %. Revoke them, or add them to the quarantine with a reason.',
      v_missing;
  end if;

  -- The quarantine is allowed to shrink but must never be trusted blindly: say
  -- so when 1.3 has cleared an entry, so the array gets trimmed rather than
  -- quietly outliving the problem it names.
  select string_agg(nm, ', ' order by nm) into v_missing
  from unnest(array[
         'claim_statement_email', 'complete_statement_email',
         'update_property_branding', 'update_property_config',
         'update_property_details', 'update_tenant_settings'
       ]) as nm
  where not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = nm
      and has_function_privilege('anon', p.oid, 'EXECUTE')
  );
  if v_missing is not null then
    raise notice
      '038: these are on the 1.3 quarantine list but no longer leak to anon — trim them from the array: %', v_missing;
  end if;

  -- --- 6b. THE SCALAR READERS STILL RUN, after the 2-arg fold was dropped --
  -- The text scan in §5.5 is a good guard and an imperfect one: it reads
  -- function SOURCE, so it cannot tell a two-argument call from a three-argument
  -- one, and it would miss a caller that built the name dynamically. This is the
  -- check that does not care about any of that — it simply CALLS all three of
  -- 036 §3.5's scalar readers and lets a missing aggregate raise 42883.
  --
  -- Nonsense UUIDs on purpose: every one of them is defined to return a row for
  -- an item that has never moved (zeros and a NULL cost), so there is no fixture
  -- to set up and nothing is written. What is being tested is that the function
  -- RESOLVES, not what it returns.
  perform stock_valuation(
    '00000000-0000-0000-0000-000000000000'::uuid,
    '00000000-0000-0000-0000-000000000000'::uuid,
    '00000000-0000-0000-0000-000000000000'::uuid);
  perform stock_on_hand(
    '00000000-0000-0000-0000-000000000000'::uuid,
    '00000000-0000-0000-0000-000000000000'::uuid,
    '00000000-0000-0000-0000-000000000000'::uuid);
  perform stock_moving_average_cost(
    '00000000-0000-0000-0000-000000000000'::uuid,
    '00000000-0000-0000-0000-000000000000'::uuid,
    '00000000-0000-0000-0000-000000000000'::uuid);

  -- And the three read surfaces, which DO carry a tracked dependency but are
  -- cheap to prove rather than assume.
  perform 1 from stock_on_hand           limit 1;
  perform 1 from stock_on_hand_items     limit 1;
  perform 1 from stock_on_hand_by_item   limit 1;
  perform 1 from stock_movement_ledger   limit 1;
  perform 1 from stock_negative_positions limit 1;

  -- --- 7. The carried-cost trigger is attached ---------------------------
  select count(*) into v_count
  from pg_trigger
  where tgrelid = 'stock_movements'::regclass
    and tgname = 'set_stock_carried_cost_trigger'
    and not tgisinternal;
  if v_count <> 1 then
    raise exception 'ASSERT FAILED: set_stock_carried_cost_trigger is not attached';
  end if;

  -- --- 8. The immutability trigger is BACK ON after the backfill ---------
  -- §6.3 disables it for one UPDATE. If anything left it disabled, the ledger's
  -- central guarantee would be silently gone.
  select count(*) into v_count
  from pg_trigger
  where tgrelid = 'stock_movements'::regclass
    and tgname = 'stock_movements_forbid_update'
    and tgenabled <> 'D';
  if v_count <> 1 then
    raise exception
      'ASSERT FAILED: stock_movements_forbid_update is not enabled — the backfill left immutability off';
  end if;

  -- --- 9. Every negative movement carries a cost, or has no history ------
  select count(*) into v_count
  from stock_movements m
  where m.quantity < 0
    and m.carried_unit_cost is null
    and exists (
      select 1 from stock_movements p
      where p.location_id = m.location_id
        and p.inventory_item_id = m.inventory_item_id
        and (p.business_date, p.seq) < (m.business_date, m.seq)
    );
  if v_count <> 0 then
    raise exception
      'ASSERT FAILED: % negative movements have prior history but no carried_unit_cost', v_count;
  end if;

  raise notice '038 self-verify: all assertions passed.';
end $$;


-- PostgREST caches the function signatures it exposes. §8 dropped and recreated
-- two of them, so without this the API would keep offering the old shapes until
-- the next unrelated reload.
notify pgrst, 'reload schema';

-- ============================================================================
-- End of 038_stock_movement_hardening.sql
--
-- The stock ledger can now be corrected without being rewritten, values what
-- leaves at the moment it leaves, refuses to touch a closed period, cannot
-- strand stock behind a switched-off item or location, and surfaces every
-- position that says less than nothing. Stock takes as a counted document are
-- 039; receive, write-offs and requisitions follow it.
-- ============================================================================
