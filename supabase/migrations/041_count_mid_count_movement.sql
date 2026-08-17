-- ============================================================================
-- 041_count_mid_count_movement.sql
-- Palstro-Hotels: three fixes, no new features. F&B/Inventory 1.1d, third pass.
--
--   1. A count now WARNS when stock moved in its location while it was running
--      and the affected items were counted AFTER it moved — the case where a
--      delivery is recorded twice, once as the receipt and again as a variance.
--   2. stock_takes_status_shape_check gets an ELSE. A CASE with no ELSE returns
--      NULL and a CHECK passes on NULL, so the guard failed OPEN.
--   3. The anon quarantine list becomes ONE FUNCTION future migrations call,
--      instead of an array copy-pasted into every self-verify block.
--
-- ----------------------------------------------------------------------------
-- ON THE ABSENCE OF AN EXPLICIT BEGIN/COMMIT — as 038-040
-- ----------------------------------------------------------------------------
-- `supabase db push` already wraps each migration file in a single transaction.
-- An explicit BEGIN raises "there is already a transaction in progress", and the
-- matching COMMIT would end the CLI's transaction early.
-- ============================================================================


-- ############################################################################
-- SECTION 1 — THE STATE-SHAPE CHECK GETS AN ELSE
-- ############################################################################
--
--  ┌──────────────────────────────────────────────────────────────────────────┐
--  │  A CASE WITH NO ELSE RETURNS NULL, AND A CHECK CONSTRAINT PASSES ON      │
--  │  NULL. So a status the CASE does not name is not refused — it is         │
--  │  WAVED THROUGH, silently, by the constraint written to refuse it.        │
--  └──────────────────────────────────────────────────────────────────────────┘
--
-- 039 wrote the check with three branches and 040 added a fourth, and neither
-- added an ELSE. Today that is harmless twice over — stock_takes_status_check
-- already restricts the column to those four values, and every write goes
-- through an RPC that sets the pair itself. It is still wrong, and the way it
-- becomes real is entirely ordinary: a later migration adds a fifth status to
-- stock_takes_status_check and does not think to touch this one. From that
-- moment the timestamp shape of the new state is unguarded, nothing errors, and
-- the first sign of it is a row that says 'open' while carrying a finished_at.
--
-- 040 §7 already asserts that this constraint mentions reversed_at, which is
-- what caught the missing branch there. The ELSE is what makes the NEXT missing
-- branch fail loudly instead of quietly.
alter table stock_takes drop constraint if exists stock_takes_status_shape_check;
alter table stock_takes
  add constraint stock_takes_status_shape_check
  check (
    case status
      when 'open'      then finished_at is null and cancelled_at is null
                            and reversed_at is null
      when 'finished'  then finished_at is not null and cancelled_at is null
                            and reversed_at is null
      when 'cancelled' then cancelled_at is not null and finished_at is null
                            and reversed_at is null
      -- A reversed count KEEPS its finished_at: it was finished, and then it was
      -- undone. Erasing the first fact to record the second is exactly the edit
      -- this engine refuses to make.
      when 'reversed'  then finished_at is not null and reversed_at is not null
                            and cancelled_at is null
      -- FAIL CLOSED. An unnamed status is refused rather than unguarded.
      else false
    end
  );


-- ############################################################################
-- SECTION 2 — THE ANON SWEEP, WRITTEN ONCE
-- ############################################################################
-- 038 §12.6 established the sweep and explained why it is a SWEEP rather than a
-- name list: the defect it exists to catch is precisely a function NOBODY
-- THOUGHT TO LIST, so every SECURITY DEFINER function in `public` is in scope by
-- default and anything holding anon EXECUTE must be explained.
--
-- That reasoning was right and the implementation was not. The sweep was copied
-- verbatim into 039 §9.10 and 040 §7.6, exemption arrays and all — three copies
-- of a list whose whole purpose is to SHRINK as the 1.3 security work clears it.
-- A list that must be edited in three places is a list that gets edited in one,
-- and then the migrations disagree about what is quarantined while all three
-- keep passing.
--
-- So it becomes a function. A future migration writes ONE LINE:
--
--     perform assert_no_anon_security_definer();
--
-- and clearing a quarantine entry is a CREATE OR REPLACE of this function in the
-- migration that revokes the grant — one edit, in the same file as the fix.
--
-- ----------------------------------------------------------------------------
-- IT IS DELIBERATELY *NOT* SECURITY DEFINER
-- ----------------------------------------------------------------------------
-- It reads pg_proc, pg_namespace and has_function_privilege, all of which any
-- role may read, so it needs no elevation — and a SECURITY DEFINER function
-- would land inside its own sweep, which is the kind of joke that becomes a bug
-- when somebody adds it to an exemption array to quiet it down.
--
-- The historical copies in 038/039/040 are LEFT ALONE. Those files are the
-- record of what actually ran; editing an applied migration to tidy it makes the
-- record a lie. They keep their own arrays, and nothing new copies them.
create or replace function assert_no_anon_security_definer()
returns void
language plpgsql
stable
set search_path = public
as $$
declare
  -- EXEMPTION 1 — the RLS helpers. These MUST stay anon-executable: the public
  -- storefront's own policies invoke them, so revoking would take the guest site
  -- down. They disclose nothing to an unauthenticated caller — auth.uid() is
  -- NULL, so get_tenant_ids() returns the empty array and every predicate is
  -- false. Fail-closed by construction.
  c_rls_helpers constant text[] := array[
    'get_tenant_ids', 'get_property_ids', 'is_tenant_admin', 'is_tenant_staff'
  ];
  -- EXEMPTION 2 — THE 1.3 QUARANTINE. Six pre-existing functions (008, 030)
  -- whose grants predate this work. NOT a live exposure and it was checked
  -- rather than assumed: every one gates internally on is_tenant_admin() or on
  -- auth.uid() being non-null, so an anon call raises rather than acting. But
  -- they are one layer where the rest of the module has two.
  --
  -- THIS ARRAY CAN ONLY SHRINK. The migration that revokes a grant removes its
  -- entry here, in the same file. Until then any NEW leak fails the next
  -- migration that calls this.
  c_quarantine constant text[] := array[
    'claim_statement_email', 'complete_statement_email',
    'update_property_branding', 'update_property_config',
    'update_property_details', 'update_tenant_settings'
  ];
  v_leaks   text;
  v_cleared text;
begin
  -- Trigger-returning functions are exempt MECHANICALLY rather than by name:
  -- Postgres refuses direct invocation of any `returns trigger` function
  -- whatever the privilege, and PostgREST does not expose them at all.
  select string_agg(leaks.fn, ', ' order by leaks.fn)
    into v_leaks
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
  where leaks.nm <> all (c_rls_helpers)
    and leaks.nm <> all (c_quarantine);

  if v_leaks is not null then
    raise exception
      'ASSERT FAILED: anon holds EXECUTE on these SECURITY DEFINER functions, and they are neither RLS helpers nor on the 1.3 quarantine list: %. Revoke them, or add them to assert_no_anon_security_definer with a reason.',
      v_leaks;
  end if;

  -- The quarantine is allowed to shrink but must never be trusted blindly: say
  -- so when an entry has been cleared, so the array gets trimmed rather than
  -- quietly outliving the problem it names.
  select string_agg(nm, ', ' order by nm) into v_cleared
  from unnest(c_quarantine) as nm
  where not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = nm
      and has_function_privilege('anon', p.oid, 'EXECUTE')
  );
  if v_cleared is not null then
    raise notice
      'These are on the 1.3 quarantine list but no longer leak to anon — trim them from assert_no_anon_security_definer: %', v_cleared;
  end if;
end;
$$;

comment on function assert_no_anon_security_definer() is
  'THE ANON SWEEP, written once. Raises if any SECURITY DEFINER function in '
  'public is anon-executable and is neither an RLS helper (which must be) nor on '
  'the 1.3 quarantine list. Future migrations call it in their self-verify block '
  'instead of copy-pasting the arrays — 038, 039 and 040 each carried their own '
  'copy of a list whose whole purpose is to shrink, which is how three '
  'migrations come to disagree while all three keep passing. Clearing a '
  'quarantine entry is a CREATE OR REPLACE of THIS function, in the migration '
  'that revokes the grant. Deliberately NOT security definer: it needs no '
  'elevation, and a definer function would land inside its own sweep.';


-- ############################################################################
-- SECTION 3 — STOCK THAT MOVED WHILE THE COUNT WAS RUNNING
-- ############################################################################
--
--  ┌──────────────────────────────────────────────────────────────────────────┐
--  │  THE DOUBLE COUNT, IN NUMBERS.                                          │
--  │                                                                          │
--  │  09:00  the count starts. Snapshot: 100 kg of rice.                      │
--  │  10:00  a delivery of 20 kg is received and put on the shelf.            │
--  │  11:00  the counter reaches that shelf and finds 120 kg. Keys 120.       │
--  │                                                                          │
--  │  variance = counted - SNAPSHOT = 120 - 100 = +20                         │
--  │  on hand after finishing = 120 + 20 = 140                                │
--  │                                                                          │
--  │  The 20 kg has been recorded TWICE: once as the receipt, and again as a  │
--  │  variance the count "found". Nothing errors. The ledger is wrong by      │
--  │  exactly one delivery, and the storekeeper is the one who looks careless.│
--  └──────────────────────────────────────────────────────────────────────────┘
--
-- ----------------------------------------------------------------------------
-- THIS IS THE OTHER HALF OF 039's SNAPSHOT, NOT A CONTRADICTION OF IT
-- ----------------------------------------------------------------------------
-- 039 measures every line against the position at START, and that is right: it
-- is what stops a mid-count delivery being blamed on the counter. Counting the
-- shelf BEFORE the delivery lands gives the correct answer and always did — the
-- delivery simply shows up as stock the count did not see.
--
-- The failure is the other order. Count the shelf AFTER the delivery is on it,
-- and the counted figure already contains what the receipt recorded. The
-- snapshot cannot know that, because it was taken two hours earlier.
--
-- ----------------------------------------------------------------------------
-- WHY IT WARNS RATHER THAN REFUSES, AND WHY IT IS NOT SILENTLY ADJUSTED
-- ----------------------------------------------------------------------------
-- Two tempting alternatives, both rejected:
--
--   * SUBTRACT THE MOVEMENT AUTOMATICALLY. The system does not know whether the
--     counter saw the delivery. If it was still in the corridor at 11:00, the
--     count of 120 is a genuine +20 discovery and "correcting" it would delete a
--     real finding. A guess dressed as arithmetic is worse than a question.
--   * REFUSE OUTRIGHT. Stock moving during a count is normal in a working hotel
--     and blocking the finish would leave the count stuck with no way out but
--     abandoning two hours of work — which teaches people not to count.
--
-- So: raise PT449 once, name the items, and let the caller re-submit with
-- p_allow_moved_stock => true AND THE SAME IDEMPOTENCY KEY. Exactly the shape
-- 036 §4.2 uses for the negative-stock confirmation, for exactly the same reason
-- — the same key is what stops a confirmation from posting a second time.
--
-- ----------------------------------------------------------------------------
-- created_at IS THE RIGHT CLOCK HERE, AND THAT IS NOT A BREACH OF RULES 8/12
-- ----------------------------------------------------------------------------
-- Those rules say a user-facing FIGURE is grouped by business_date, never by the
-- creation timestamp. This is not a figure — it is a question about the real
-- order of two events on one afternoon: was the stock on the shelf before the
-- person wrote a number down? business_date cannot answer that; both the receipt
-- and the count carry the same one. stock_take_lines.counted_at exists precisely
-- so this question is answerable per line.
--
-- BOTH DIRECTIONS ARE CAUGHT. An issue OUT before the line was counted
-- double-subtracts in exactly the same way (snapshot 100, issue 20, count 80,
-- variance -20, result 60). The test is "moved", not "arrived".

-- DROPPED AND RECREATED rather than replaced: it gains a trailing parameter and
-- CREATE OR REPLACE cannot change a signature. The client contract is unchanged
-- and no existing call needs editing — PostgREST calls RPCs with NAMED
-- arguments and the new parameter has a SQL default, so an omitted key resolves
-- to false. §4 re-issues the grants a DROP takes with it.
drop function if exists finish_stock_take(uuid, text, text);

create or replace function finish_stock_take(
  p_stock_take_id     uuid,
  p_manager_pin       text,
  p_idempotency_key   text default null,
  p_allow_moved_stock boolean default false
)
returns stock_takes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_take      stock_takes;
  v_existing  stock_takes;
  v_key       text;
  v_threshold numeric(14,2);
  v_absolute  numeric := 0;
  v_manager   uuid;
  v_actor     uuid := auth.uid();
  v_line      record;
  v_cost      numeric;
  v_variance  numeric;
  v_reason    text;
  v_movement  stock_movements;
  v_moved     text;
  v_moved_n   integer;
begin
  -- --- GUARD 1: resolve and LOCK the document ------------------------------
  select * into v_take from stock_takes where id = p_stock_take_id for update;
  if not found then
    raise exception 'Stock count % not found', p_stock_take_id using errcode = 'PT404';
  end if;

  if not is_tenant_staff(v_take.tenant_id) then
    raise exception 'Not authorised to finish stock counts for this property'
      using errcode = 'insufficient_privilege',
            hint = 'Ask an administrator to add you to this hotel''s team.';
  end if;

  -- --- GUARD 2: idempotency, by an EXPLICIT key ----------------------------
  -- A key the CALLER supplied means "this is one request of mine, possibly
  -- retried" — and it does NOT re-check the PIN, so a dropped connection does
  -- not fetch the manager back to the terminal. It is also what makes the
  -- moved-stock confirmation below safe: the confirm re-sends the SAME key.
  v_key := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  if v_key is not null then
    select * into v_existing
    from stock_takes
    where tenant_id = v_take.tenant_id and close_idempotency_key = v_key
    limit 1;
    if found then
      return v_existing;
    end if;
  else
    v_key := 'close_stock_take:' || p_stock_take_id::text;
  end if;

  -- --- GUARD 3: the state --------------------------------------------------
  if v_take.status <> 'open' then
    raise exception 'Count % is already %.', v_take.take_number, v_take.status
      using errcode = 'PT409',
            hint = 'A count settles once. Start a new one for this location if the shelves need counting again.';
  end if;

  -- --- GUARD 4: the posting lock (038 §4) ----------------------------------
  perform assert_posting_open(v_take.property_id, v_take.business_date);

  -- --- GUARD 5: STOCK THAT MOVED BEFORE ITS SHELF WAS COUNTED --------------
  -- Checked HERE, before the manager is asked for a PIN and before pass 1
  -- writes anything. Order matters for the person at the terminal: warn first,
  -- confirm, and only then fetch a manager — so the manager is fetched once
  -- rather than being sent away and called back.
  --
  -- ONLY COUNTED LINES, and only movements recorded BEFORE that line was
  -- counted. A shelf nobody visited produces nothing whatever moved on it, and
  -- a movement AFTER the line was counted is the case 039's snapshot already
  -- handles correctly — including it would fire the warning on the normal
  -- working day and teach everyone to click through it.
  if not coalesce(p_allow_moved_stock, false) then
    with risky as (
      select i.name
      from stock_take_lines l
      join inventory_items i on i.id = l.inventory_item_id
      where l.stock_take_id = v_take.id
        and l.counted_quantity is not null
        and exists (
          select 1
          from stock_movements m
          where m.location_id = v_take.location_id
            and m.inventory_item_id = l.inventory_item_id
            and m.created_at > v_take.started_at
            and m.created_at <= l.counted_at
        )
    )
    select (select count(*) from risky)::integer,
           (select string_agg(r.name, ', ' order by r.name)
              from (select name from risky order by name limit 5) r)
      into v_moved_n, v_moved;

    if v_moved_n > 0 then
      -- Capped at five names. A refusal listing two hundred items is a refusal
      -- nobody reads, and the count is the number that decides what to do next.
      if v_moved_n > 5 then
        v_moved := v_moved || ', and ' || (v_moved_n - 5)::text || ' more';
      end if;

      raise exception
        'Stock moved in this location while this count was running, and % of the items you counted were counted AFTER it moved: %. Counting a shelf after a delivery has been put on it records that delivery twice — once as the receipt, and again as a difference the count appears to have found.',
        v_moved_n, v_moved
        using errcode = 'PT449',
              hint = 'Check those shelves against their movements. Clear the affected lines and count them again, or confirm to finish anyway and record the differences exactly as they stand.';
    end if;
  end if;

  -- ------------------------------------------------------------------------
  -- PASS 1: value every counted line, and stamp the cost it will move at.
  -- ------------------------------------------------------------------------
  for v_line in
    select l.id, l.inventory_item_id, l.expected_quantity, l.counted_quantity,
           i.name as item_name
    from stock_take_lines l
    join inventory_items i on i.id = l.inventory_item_id
    where l.stock_take_id = v_take.id
      and l.counted_quantity is not null
    order by i.name, l.inventory_item_id
  loop
    v_cost := stock_moving_average_cost(
                v_take.property_id, v_take.location_id, v_line.inventory_item_id);
    v_variance := v_line.counted_quantity - v_line.expected_quantity;

    if v_cost is null and v_variance > 0 then
      raise exception
        'The count found more % than the ledger has any cost for, so the difference cannot be valued.',
        v_line.item_name
        using errcode = 'PT422',
              hint = 'Post an opening balance or an adjustment stating the cost explicitly, then count again.';
    end if;

    update stock_take_lines
       set variance_unit_cost = v_cost,
           updated_by = v_actor
     where id = v_line.id;

    v_absolute := v_absolute + abs(round(v_variance * coalesce(v_cost, 0), 2));
  end loop;

  -- ------------------------------------------------------------------------
  -- THE APPROVAL. A value threshold, in the shape apply_charge_discount uses.
  -- ------------------------------------------------------------------------
  select pfs.count_variance_threshold into v_threshold
  from property_finance_settings pfs
  where pfs.property_id = v_take.property_id;
  v_threshold := coalesce(v_threshold, 0);

  if v_absolute > v_threshold then
    v_manager := verify_manager_pin(v_take.tenant_id, p_manager_pin);
    if v_manager is null then
      -- THE FIGURE IS DELIBERATELY NOT IN THIS MESSAGE. The variance IS the
      -- blind data: a counter who could read "this count is out by ₦180,000"
      -- from a refusal would have learnt it while the sheet is still open and
      -- editable. Naming the THRESHOLD tells them what to do; naming the
      -- variance would tell them what to type.
      raise exception
        'This count''s variance is above this property''s approval threshold of %, so a manager must authorise it.',
        to_char(v_threshold, 'FM999,999,999,990.00')
        using errcode = 'insufficient_privilege',
              hint = 'Hand the terminal to a manager. The approval is recorded against them by name, permanently.';
    end if;
  end if;

  -- ------------------------------------------------------------------------
  -- PASS 2: post one 'count_adjustment' movement per NON-ZERO variance.
  -- ------------------------------------------------------------------------
  v_reason := case
                when v_take.note is not null and btrim(v_take.note) <> ''
                  then format('Stock count %s on %s — %s',
                              v_take.take_number,
                              to_char(v_take.business_date, 'DD Mon YYYY'),
                              btrim(v_take.note))
                else format('Stock count %s on %s',
                            v_take.take_number,
                            to_char(v_take.business_date, 'DD Mon YYYY'))
              end;

  for v_line in
    select l.id, l.inventory_item_id, l.expected_quantity, l.counted_quantity,
           l.variance_unit_cost, i.name as item_name
    from stock_take_lines l
    join inventory_items i on i.id = l.inventory_item_id
    where l.stock_take_id = v_take.id
      and l.counted_quantity is not null
      and l.counted_quantity <> l.expected_quantity
    order by i.name, l.inventory_item_id
  loop
    v_variance := v_line.counted_quantity - v_line.expected_quantity;

    insert into stock_movements (
      tenant_id, property_id, location_id, inventory_item_id,
      movement_type, quantity, unit_cost, business_date,
      reason, note, source,
      source_document_type, source_document_id,
      idempotency_key, created_by
    ) values (
      v_take.tenant_id, v_take.property_id, v_take.location_id,
      v_line.inventory_item_id,
      'count_adjustment',
      v_variance,
      case when v_variance > 0 then round(v_line.variance_unit_cost, 2) else null end,
      v_take.business_date,
      v_reason,
      format('Counted %s against %s expected',
             format_stock_quantity(v_line.counted_quantity),
             format_stock_quantity(v_line.expected_quantity)),
      'stock_take',
      'stock_take', v_take.id,
      'stock_take:' || v_take.id::text || ':' || v_line.inventory_item_id::text,
      v_actor
    )
    returning * into v_movement;

    update stock_take_lines
       set movement_id = v_movement.id,
           updated_by = v_actor
     where id = v_line.id;
  end loop;

  -- ------------------------------------------------------------------------
  -- STAMP THE DOCUMENT, last, so any failure above rolls the whole count back.
  -- ------------------------------------------------------------------------
  begin
    update stock_takes t
       set status = 'finished',
           finished_at = now(),
           finished_by = v_actor,
           approved_by = v_manager,      -- NULL when within the threshold
           close_idempotency_key = v_key,
           updated_by = v_actor
     where t.id = v_take.id
    returning * into v_take;
  exception
    when unique_violation then
      select * into v_existing
      from stock_takes t
      where t.tenant_id = v_take.tenant_id and t.close_idempotency_key = v_key
      limit 1;
      if found then
        return v_existing;
      end if;
      raise;
  end;

  return v_take;
end;
$$;

comment on function finish_stock_take(uuid, text, text, boolean) is
  'Finishes a count: values every counted line at the moving average it found the '
  'stock at, requires a manager PIN when the ABSOLUTE variance value exceeds the '
  'property''s count_variance_threshold, and posts ONE ''count_adjustment'' '
  'movement per non-zero variance. Variance is measured against the SNAPSHOT '
  'taken at start. WARNS FIRST (PT449) when stock moved in the location while the '
  'count was running AND the affected items were counted after it moved — the '
  'double-count case the snapshot cannot see — naming up to five of them; the '
  'caller re-submits with p_allow_moved_stock => true and THE SAME idempotency '
  'key. Uncounted lines produce nothing; a counted ZERO produces a variance of '
  'the full expected quantity. Staff-gated, idempotent by key and by state, one '
  'transaction throughout (rule 11).';


-- ############################################################################
-- SECTION 4 — GRANTS
-- ############################################################################
-- The DROP in §3 took its grants with it.
revoke all on function finish_stock_take(uuid, text, text, boolean) from public, anon;
grant  execute on function finish_stock_take(uuid, text, text, boolean) to authenticated;

-- The sweep helper is migration plumbing, called by migrations and by nothing
-- else. Revoked from every client role so it cannot be probed for the shape of
-- the quarantine list.
revoke all on function assert_no_anon_security_definer() from public, anon, authenticated;


-- ############################################################################
-- SECTION 5 — IN-TRANSACTION SELF-VERIFY
-- ############################################################################
do $$
declare
  v_count integer;
  v_def   text;
begin
  -- --- 1. The ELSE is there -----------------------------------------------
  select pg_get_constraintdef(oid) into v_def
  from pg_constraint where conname = 'stock_takes_status_shape_check';
  if v_def is null then
    raise exception 'ASSERT FAILED: stock_takes_status_shape_check is missing';
  end if;
  if position('ELSE false' in v_def) = 0 and position('else false' in v_def) = 0 then
    raise exception
      'ASSERT FAILED: stock_takes_status_shape_check still has no ELSE — a CASE with no ELSE returns NULL and a CHECK passes on NULL, so the guard fails OPEN: %', v_def;
  end if;

  -- And it still names all four states, so the ELSE was added rather than the
  -- branches being lost.
  if position('open' in v_def) = 0 or position('finished' in v_def) = 0
     or position('cancelled' in v_def) = 0 or position('reversed' in v_def) = 0 then
    raise exception 'ASSERT FAILED: the state-shape check lost a branch: %', v_def;
  end if;

  -- --- 2. The sweep is a function now, and it is not its own subject ------
  select count(*) into v_count
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'assert_no_anon_security_definer';
  if v_count <> 1 then
    raise exception 'ASSERT FAILED: assert_no_anon_security_definer does not exist';
  end if;

  select count(*) into v_count
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'assert_no_anon_security_definer'
    and p.prosecdef;
  if v_count <> 0 then
    raise exception
      'ASSERT FAILED: assert_no_anon_security_definer is SECURITY DEFINER, which puts it inside its own sweep. It needs no elevation — make it INVOKER.';
  end if;

  if has_function_privilege('anon', 'assert_no_anon_security_definer()', 'EXECUTE')
     or has_function_privilege('authenticated', 'assert_no_anon_security_definer()', 'EXECUTE') then
    raise exception 'ASSERT FAILED: a client can execute the sweep helper';
  end if;

  -- --- 3. THE SWEEP ITSELF, through the shared function -------------------
  -- This is the line every future migration writes instead of copying arrays.
  perform assert_no_anon_security_definer();

  -- --- 4. finish_stock_take gained the confirmation parameter -------------
  -- NOTE the shape of this test. pg_get_function_identity_arguments returns the
  -- argument list WITH PARAMETER NAMES ('p_stock_take_id uuid, …'), not the bare
  -- type list that has_function_privilege takes — comparing it against
  -- 'uuid, text, text, boolean' fails on a function that is perfectly correct.
  select count(*) into v_count
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'finish_stock_take'
    and p.pronargs = 4
    and pg_get_function_identity_arguments(p.oid) like '%p_allow_moved_stock boolean%';
  if v_count <> 1 then
    raise exception
      'ASSERT FAILED: finish_stock_take does not take p_allow_moved_stock — the mid-count confirmation has no way in';
  end if;

  -- Exactly ONE finish_stock_take: the DROP must have removed the old
  -- three-argument version, or PostgREST would see an ambiguous overload and
  -- every finish would fail at the API rather than in SQL.
  select count(*) into v_count
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'finish_stock_take';
  if v_count <> 1 then
    raise exception
      'ASSERT FAILED: expected exactly 1 finish_stock_take, found % — an overload would make the RPC ambiguous over PostgREST', v_count;
  end if;

  if not has_function_privilege('authenticated', 'finish_stock_take(uuid, text, text, boolean)', 'EXECUTE') then
    raise exception 'ASSERT FAILED: authenticated cannot execute finish_stock_take — the DROP took its grant and §4 did not put it back';
  end if;
  if has_function_privilege('anon', 'finish_stock_take(uuid, text, text, boolean)', 'EXECUTE') then
    raise exception 'ASSERT FAILED: anon can execute finish_stock_take';
  end if;

  -- --- 5. The guard is in the function, not merely in the comment ---------
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'finish_stock_take';
  if position('counted_at' in v_def) = 0 or position('PT449' in v_def) = 0 then
    raise exception
      'ASSERT FAILED: finish_stock_take does not compare movements against counted_at — the mid-count double-count guard is gone';
  end if;

  raise notice '041 self-verify: all assertions passed.';
end $$;

notify pgrst, 'reload schema';

-- ============================================================================
-- End of 041_count_mid_count_movement.sql
--
-- A count now says so when the shelf it measured had already changed under it,
-- the state-shape guard fails closed instead of open, and the anon sweep is one
-- function rather than three copies of a list that only ever shrinks.
-- ============================================================================
