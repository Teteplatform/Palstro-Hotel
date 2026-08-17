-- ============================================================================
-- 040_stock_take_reversal.sql
-- Palstro-Hotels: UNDOING A COUNT, and one implementation of "reverse a
-- movement" instead of two. F&B/Inventory 1.1d, second pass.
--
-- ----------------------------------------------------------------------------
-- WHY THIS EXISTS
-- ----------------------------------------------------------------------------
-- 039 made a count a document that settles once and can never be re-opened,
-- which is right: a count that could be edited after it posted would record what
-- someone last decided it should say. But "settles once" left no answer to the
-- thing that actually happens in a store — the count was wrong. Somebody counted
-- the wrong shelf, or counted cases as bottles, and finished it.
--
-- The answer is the same one the rest of this product gives: NOT an edit, and
-- NOT a delete. A reversal — every movement the count posted is undone by an
-- equal and opposite movement, the count is marked as reversed, and BOTH the
-- count and its undoing stay visible with their own names against them. Then
-- count again.
--
-- THERE IS DELIBERATELY NO "DELETE COUNT". A finished count moved real stock and
-- a manager approved it; removing the record would remove the evidence that both
-- happened. An OPEN count is abandoned (039 §6.4) because it posted nothing; a
-- FINISHED one is reversed. Those are two different acts on two different states
-- and the screens say so.
--
-- ----------------------------------------------------------------------------
-- THE REFACTOR THIS FORCED, AND WHY IT IS NOT OPTIONAL
-- ----------------------------------------------------------------------------
-- Reversing a count means reversing every movement it posted. The obvious
-- implementation calls reverse_stock_movement (038 §7.2) once per line — and it
-- is wrong twice over:
--
--   * IT VERIFIES THE PIN ONCE PER LINE. verify_manager_pin runs bcrypt at cost
--     10, roughly 100ms a call. A fifty-line count would spend five seconds
--     hashing the same PIN fifty times and a two-hundred-line count would run
--     past the statement timeout — so the feature would work in testing and fail
--     on the counts that most need it.
--   * THE ALTERNATIVE IS WORSE. Inlining a second copy of "post the counter and
--     write the audit row" would give this system TWO implementations of
--     reversal, and the day either changes the other drifts silently. That is
--     the exact trap 022's header records about re-implementing an engine rule.
--
-- So the POSTING half of 038 §7.2 is extracted into post_movement_reversal(),
-- which does everything except decide who is allowed to ask. Both callers use
-- it: reverse_stock_movement verifies one PIN for one movement,
-- reverse_stock_take verifies one PIN for a whole document. There is still
-- exactly one place that knows how to reverse a movement.
--
-- reverse_stock_movement's OBSERVABLE BEHAVIOUR IS UNCHANGED — same signature,
-- same guards, same messages, same hints, same SQLSTATEs, same audit rows. §7
-- asserts that rather than asking anyone to trust it.
--
-- ----------------------------------------------------------------------------
-- ON THE ABSENCE OF AN EXPLICIT BEGIN/COMMIT — as 038 and 039
-- ----------------------------------------------------------------------------
-- `supabase db push` already wraps each migration file in a single transaction.
-- An explicit BEGIN raises "there is already a transaction in progress", and the
-- matching COMMIT would end the CLI's transaction early — after which a later
-- failure would leave a half-applied migration committed.
-- ============================================================================


-- ############################################################################
-- SECTION 1 — 'reversed' becomes a fourth state of a count
-- ############################################################################
--
--  ┌──────────────────────────────────────────────────────────────────────────┐
--  │  open ──finish──► finished ──reverse──► reversed                         │
--  │    │                                                                     │
--  │    └──cancel───► cancelled                                               │
--  │                                                                          │
--  │  Every arrow is one-way. A reversed count is not re-openable and not      │
--  │  re-finishable: the answer to a count that was wrong is another count.    │
--  └──────────────────────────────────────────────────────────────────────────┘
--
-- WHY A STATUS RATHER THAN A DERIVED FLAG. "Has every movement of this count
-- been reversed?" is answerable by joining the lines to stock_movements, and
-- that was the first design. It is wrong for the same reason 038 gave 'reversal'
-- its own movement_type: a count that was UNDONE AS A DOCUMENT — one decision,
-- one manager, one reason — is a different fact from a count whose lines each
-- happened to be corrected separately over a month. Deriving the flag would
-- collapse the two, and the one number a manager looks at ("how many of our
-- counts had to be thrown out?") would be diluted by ordinary line corrections.
alter table stock_takes
  add column if not exists reversed_at            timestamptz,
  add column if not exists reversed_by            uuid references auth.users(id),
  -- The manager whose PIN authorised it. NOT NULLABLE in practice: reversal
  -- ALWAYS needs a PIN, with no threshold (§4), so this is never null on a
  -- reversed count — unlike approved_by, which is null when a count's variance
  -- was within the property's limit.
  add column if not exists reverse_approved_by    uuid references auth.users(id),
  add column if not exists reverse_reason         text,
  add column if not exists reverse_idempotency_key text;

comment on column stock_takes.reversed_at is
  'When the whole count was undone. A count is reversed as a DOCUMENT — one '
  'decision, one manager, one reason — which is a different fact from a count '
  'whose lines each happened to be corrected separately over a month, and the '
  'status is what keeps the two separable.';
comment on column stock_takes.reverse_approved_by is
  'The manager whose PIN authorised undoing the count. Never null on a reversed '
  'count: reversal always needs a PIN, with no threshold, exactly as '
  'reverse_stock_movement (038 §7). Unlike approved_by, which is null when the '
  'count''s variance was within the property''s limit.';

-- The status CHECK and the state-shape CHECK both learn the fourth state.
-- Rebuilt rather than added to: a CASE with a missing branch returns NULL, and a
-- CHECK passes on NULL — so a forgotten branch fails OPEN, silently.
alter table stock_takes drop constraint if exists stock_takes_status_check;
alter table stock_takes
  add constraint stock_takes_status_check
  check (status in ('open', 'finished', 'cancelled', 'reversed'));

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
      -- this whole engine refuses to make.
      when 'reversed'  then finished_at is not null and reversed_at is not null
                            and cancelled_at is null
    end
  );

do $$
begin
  -- An undoing always says why, at the database. Same rule as a cancellation
  -- (039 §2) and a movement reversal (038 §7 GUARD 7).
  if not exists (select 1 from pg_constraint
                 where conname = 'stock_takes_reverse_reason_check') then
    alter table stock_takes
      add constraint stock_takes_reverse_reason_check
      check (
        status <> 'reversed'
        or (reverse_reason is not null and length(btrim(reverse_reason)) > 0)
      );
  end if;
end $$;

-- Rules 2/3: the third key on this document, with its own partial unique index.
-- Reversing is a third write intent, separate from starting and from closing —
-- and unlike those two it happens AFTER the document was closed, so it cannot
-- share the close key.
create unique index if not exists stock_takes_reverse_idem_uniq
  on stock_takes (tenant_id, reverse_idempotency_key)
  where reverse_idempotency_key is not null;


-- ############################################################################
-- SECTION 2 — THE ONE IMPLEMENTATION OF "REVERSE A MOVEMENT"
-- ############################################################################
-- Everything 038 §7.2 did EXCEPT decide who is allowed to ask. Lifted verbatim —
-- the same guards in the same order, the same messages, the same hints, the same
-- SQLSTATEs — so that extracting it changed no behaviour, which §7 asserts.
--
-- WHAT THE CALLER OWNS, AND WHY THE SPLIT IS EXACTLY HERE:
--   the caller  — the staff gate, the idempotency fast path, the reason, and
--                 THE MANAGER PIN. Authorisation is a decision about a REQUEST;
--                 one request may move one movement or fifty.
--   this helper — the state guards, the cost basis, the stranding guard, the
--                 counter-movement and the permanent audit row. Those are facts
--                 about a MOVEMENT and are identical however many are asked for.
--
-- p_approved_by is the manager the caller ALREADY VERIFIED. It is not optional
-- and not defaulted: a NULL here would write an audit row claiming a reversal
-- nobody approved, so it is checked below rather than trusted.
--
-- REVOKED FROM EVERY CLIENT ROLE (§6). It is the posting half of a PIN-gated act
-- with the PIN taken out; exposing it would be handing out the power to erase a
-- movement with no manager anywhere near it.
create or replace function post_movement_reversal(
  p_movement_id     uuid,
  p_reason          text,
  p_approved_by     uuid,
  p_actor           uuid,
  p_idempotency_key text
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
  v_reason   text;
  v_timezone text;
  v_date     date;
  v_basis    numeric;
  v_qty      numeric;
  v_blocker  text;
begin
  if p_approved_by is null then
    raise exception 'A reversal cannot be posted without the manager who approved it'
      using errcode = 'insufficient_privilege',
            hint = 'This is an internal guard: the caller must verify a manager PIN first.';
  end if;

  v_reason := btrim(coalesce(p_reason, ''));
  if v_reason = '' then
    raise exception 'A reversal needs a reason'
      using errcode = 'PT422',
            hint = 'It is recorded permanently against your name and the approving manager''s.';
  end if;

  -- LOCK the original. Two terminals reversing the same movement in the same
  -- instant serialise here rather than both reaching the insert; the partial
  -- unique index is still the arbiter, and this turns a raw 23505 into an
  -- ordered outcome.
  select * into v_original
  from stock_movements
  where id = p_movement_id
  for update;

  if not found then
    raise exception 'Stock movement % not found', p_movement_id
      using errcode = 'PT404';
  end if;

  -- A movement is reversed once, ever (038 §1.2's partial unique index makes it
  -- true under concurrency; this makes it a sentence).
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

  if v_original.movement_type = 'reversal' then
    raise exception 'This movement is itself a reversal and cannot be reversed'
      using errcode = 'PT409',
            hint = 'The stock is already back where it started. Post a fresh adjustment if it needs to move again.';
  end if;

  if v_original.movement_type = 'opening' then
    raise exception
      'An opening balance cannot be reversed — it is the starting line of this item''s history in this location.'
      using errcode = 'PT409',
            hint = 'Post an adjustment for the difference instead. Before anything else has moved, the average still equals the opening cost, so an adjustment unwinds it exactly.';
  end if;

  -- THE BUSINESS DATE: TODAY, never the original's day (038 §7). Yesterday's
  -- stock report was true when it was printed and stays true; the correction
  -- appears on the day it was actually made. It is also why the posting lock
  -- needs no exception for reversal — a reversal never reaches backwards.
  select p.timezone into v_timezone
  from properties p where p.id = v_original.property_id;
  v_date := (now() at time zone coalesce(nullif(btrim(v_timezone), ''), 'Africa/Lagos'))::date;

  perform assert_posting_open(v_original.property_id, v_date);

  -- THE COST BASIS. Whichever direction the original went, the counter carries
  -- the cost the ORIGINAL moved, so quantity and value both unwind to zero.
  if v_original.quantity > 0 then
    v_basis := v_original.unit_cost;
  else
    v_basis := v_original.carried_unit_cost;
  end if;

  if v_basis is null then
    raise exception
      'This movement has no recorded cost, so reversing it would have to guess what the stock was worth.'
      using errcode = 'PT422',
            hint = 'Post an adjustment stating the cost explicitly instead.';
  end if;

  v_qty := - v_original.quantity;

  -- A counter that ADDS stock needs somewhere reachable to put it (038 §7 GUARD
  -- 10). Checked only when the counter is positive: one that REMOVES stock
  -- strands nothing, and reversing a mis-keyed receipt into a location that has
  -- since been retired is exactly the correction somebody needs to make.
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
      -- 036's cost/direction constraint decides which is populated: a positive
      -- counter must state a cost, a negative one must not. carried_unit_cost
      -- carries the full 4-decimal basis either way, and that is what the fold
      -- reads for a reversal row (038 §5).
      case when v_qty > 0 then round(v_basis, 2) else null end,
      v_basis,
      v_date,
      v_reason,
      format('Reversal of the %s of %s dated %s',
             v_original.movement_type,
             format_stock_quantity(v_original.quantity),
             to_char(v_original.business_date, 'DD Mon YYYY')),
      'reversal',
      'stock_movement', p_movement_id,
      p_movement_id,
      v_original.batch_code, v_original.expiry_date,
      p_idempotency_key, p_actor
    )
    returning * into v_counter;
  exception
    when unique_violation then
      select * into v_existing
      from stock_movements
      where reverses_movement_id = p_movement_id
         or (tenant_id = v_original.tenant_id and idempotency_key = p_idempotency_key)
      limit 1;
      if found then
        return v_existing;
      end if;
      raise;
  end;

  -- THE AUDIT ROW, in reversals (031) — one permanent record of every reversal
  -- across the product, so the manager's approval report reads one table.
  -- Written last so it can name the counter it produced; any failure here rolls
  -- the counter back with it.
  insert into reversals (
    tenant_id, property_id, reversed_by, approved_by, reason,
    target_type, target_id, counter_entry_id, business_date,
    idempotency_key, created_by
  ) values (
    v_original.tenant_id, v_original.property_id, p_actor, p_approved_by, v_reason,
    'stock_movement', p_movement_id, v_counter.id, v_date,
    p_idempotency_key, p_actor
  );

  return v_counter;
end;
$$;

comment on function post_movement_reversal(uuid, text, uuid, uuid, text) is
  'THE ONE IMPLEMENTATION of reversing a stock movement: the state guards, the '
  'cost basis, the stranding guard, the counter-movement and the permanent '
  'reversals row. Extracted from 038 §7.2 unchanged so that reverse_stock_movement '
  '(one movement, one PIN) and reverse_stock_take (a whole document, one PIN) '
  'share it instead of holding two copies that drift. It does NOT verify a PIN — '
  'the CALLER does, and passes the manager it verified. REVOKED from every client '
  'role: it is a PIN-gated act with the PIN taken out.';


-- ############################################################################
-- SECTION 3 — reverse_stock_movement, now delegating
-- ############################################################################
-- Same signature, same guards, same words. The only change is that the posting
-- half now lives in one place.
--
-- THE STATE PRE-CHECK BELOW IS DUPLICATED ON PURPOSE, and it is a duplicated
-- CHECK rather than duplicated LOGIC. The helper re-tests it under the row lock,
-- which is what makes it true; this copy exists so that a user asking to reverse
-- something already reversed is told THAT, rather than being asked for a manager
-- PIN first and only then told the request was pointless.
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
  v_existing stock_movements;
  v_manager  uuid;
  v_key      text;
  v_actor    uuid := auth.uid();
begin
  select * into v_original from stock_movements where id = p_movement_id;
  if not found then
    raise exception 'Stock movement % not found', p_movement_id
      using errcode = 'PT404';
  end if;

  if not is_tenant_staff(v_original.tenant_id) then
    raise exception 'Not authorised to reverse stock movements for this property'
      using errcode = 'insufficient_privilege';
  end if;

  -- IDEMPOTENCY, BY AN EXPLICIT KEY ONLY (038 §7 GUARD 3). A key the CALLER
  -- supplied means "this is one request of mine, possibly retried" — returning
  -- the first counter is right. Asking to reverse the same movement again with
  -- no key is a DIFFERENT act, and the honest answer is that it was already
  -- reversed, on such-and-such a day.
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
    v_key := 'reversal:' || p_movement_id::text;
  end if;

  -- The friendly state checks (see the header) — the helper is the guard.
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

  if v_original.movement_type = 'reversal' then
    raise exception 'This movement is itself a reversal and cannot be reversed'
      using errcode = 'PT409',
            hint = 'The stock is already back where it started. Post a fresh adjustment if it needs to move again.';
  end if;

  if v_original.movement_type = 'opening' then
    raise exception
      'An opening balance cannot be reversed — it is the starting line of this item''s history in this location.'
      using errcode = 'PT409',
            hint = 'Post an adjustment for the difference instead. Before anything else has moved, the average still equals the opening cost, so an adjustment unwinds it exactly.';
  end if;

  if btrim(coalesce(p_reason, '')) = '' then
    raise exception 'A reversal needs a reason'
      using errcode = 'PT422',
            hint = 'It is recorded permanently against your name and the approving manager''s.';
  end if;

  -- A MANAGER PIN. ALWAYS. NO THRESHOLD. There is no quantity of stock at which
  -- erasing a recorded movement is routine — reversal is the power to erase.
  v_manager := verify_manager_pin(v_original.tenant_id, p_manager_pin);
  if v_manager is null then
    raise exception 'Reversing a stock movement always requires a valid manager PIN'
      using errcode = 'insufficient_privilege',
            hint = 'Hand the terminal to a manager. The reversal is recorded against them by name.';
  end if;

  return post_movement_reversal(p_movement_id, p_reason, v_manager, v_actor, v_key);
end;
$$;

comment on function reverse_stock_movement(uuid, text, text, text) is
  'Reverses ONE stock movement by posting an equal-and-opposite ''reversal'' — the '
  'original row is never touched, because movements are permanent. ALWAYS requires '
  'a valid manager PIN and a non-empty reason. The counter posts on the CURRENT '
  'business date, never the original''s. Since 040 the posting itself is '
  'post_movement_reversal(), shared with reverse_stock_take so there is one '
  'implementation rather than two; every guard, message, hint and SQLSTATE is '
  'unchanged.';


-- ############################################################################
-- SECTION 4 — reverse_stock_take
-- ############################################################################
-- Undoes a FINISHED count: every movement it posted is reversed, the document is
-- marked reversed, and one reversals row per movement names the manager who
-- approved it.
--
-- ----------------------------------------------------------------------------
-- ONE PIN FOR THE DOCUMENT, NOT ONE PER LINE
-- ----------------------------------------------------------------------------
-- The manager is approving a DECISION — "this count was wrong, throw it out" —
-- and that decision is made once. Asking for the PIN per line would be both
-- theatre and, at bcrypt's cost, a timeout (see the header). It is verified
-- once, here, and recorded against every movement the reversal posts.
--
-- ----------------------------------------------------------------------------
-- LINES ALREADY REVERSED ON THEIR OWN ARE SKIPPED, NOT REFUSED
-- ----------------------------------------------------------------------------
-- Somebody may have reversed one bad line from the ledger last week and only now
-- decided the whole count was wrong. Refusing on that basis would leave the
-- count permanently half-undone with no way to finish the job. So a line whose
-- movement is already reversed is stepped over — stock_movements_reverses_uniq
-- guarantees it cannot be reversed twice — and the count still ends up reversed.
create or replace function reverse_stock_take(
  p_stock_take_id   uuid,
  p_reason          text,
  p_manager_pin     text,
  p_idempotency_key text default null
)
returns stock_takes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_take     stock_takes;
  v_existing stock_takes;
  v_manager  uuid;
  v_reason   text;
  v_key      text;
  v_line     record;
  v_timezone text;
  v_today    date;
  v_actor    uuid := auth.uid();
begin
  -- --- GUARD 1: resolve and LOCK the document ------------------------------
  select * into v_take from stock_takes where id = p_stock_take_id for update;
  if not found then
    raise exception 'Stock count % not found', p_stock_take_id using errcode = 'PT404';
  end if;

  if not is_tenant_staff(v_take.tenant_id) then
    raise exception 'Not authorised to reverse stock counts for this property'
      using errcode = 'insufficient_privilege',
            hint = 'Ask an administrator to add you to this hotel''s team.';
  end if;

  -- --- GUARD 2: idempotency, by an EXPLICIT key ----------------------------
  -- The same distinction reverse_stock_movement draws: a supplied key is one
  -- request possibly retried, and crucially the replay does NOT re-check the PIN
  -- — a dropped connection must not fetch the manager back to the terminal.
  v_key := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  if v_key is not null then
    select * into v_existing
    from stock_takes
    where tenant_id = v_take.tenant_id and reverse_idempotency_key = v_key
    limit 1;
    if found then
      return v_existing;
    end if;
  else
    v_key := 'reverse_stock_take:' || p_stock_take_id::text;
  end if;

  -- --- GUARD 3: only a FINISHED count can be reversed ----------------------
  -- An open one posted nothing and is ABANDONED; a cancelled one posted nothing
  -- either; a reversed one is already undone. The message names the state and
  -- the hint names the act that fits it, so nobody is told "no" without "instead".
  if v_take.status <> 'finished' then
    raise exception 'Count % is %, so there is nothing to reverse.',
      v_take.take_number, v_take.status
      using errcode = 'PT409',
            hint = case v_take.status
                     when 'open'      then 'An open count has posted nothing yet — abandon it instead.'
                     when 'cancelled' then 'An abandoned count posted nothing, so nothing needs undoing.'
                     else 'This count has already been reversed. Start a fresh count if the shelves need counting again.'
                   end;
  end if;

  -- --- GUARD 4: a reason ---------------------------------------------------
  v_reason := btrim(coalesce(p_reason, ''));
  if v_reason = '' then
    raise exception 'Undoing a count needs a reason'
      using errcode = 'PT422',
            hint = 'It is recorded permanently against your name and the approving manager''s.';
  end if;

  -- --- GUARD 5: A MANAGER PIN. ALWAYS. NO THRESHOLD. ----------------------
  -- Unlike FINISHING a count — which is gated by the property's variance
  -- threshold — undoing one is never routine at any size. It erases stock
  -- movements a manager already approved, so it takes a manager every time.
  v_manager := verify_manager_pin(v_take.tenant_id, p_manager_pin);
  if v_manager is null then
    raise exception 'Undoing a stock count always requires a valid manager PIN'
      using errcode = 'insufficient_privilege',
            hint = 'Hand the terminal to a manager. The reversal is recorded against them by name, permanently.';
  end if;

  -- --- GUARD 6: the posting lock ------------------------------------------
  -- Against TODAY, which is the only date the counters post on. A hotel that has
  -- closed today's books has closed them for corrections too.
  select p.timezone into v_timezone from properties p where p.id = v_take.property_id;
  v_today := (now() at time zone coalesce(nullif(btrim(v_timezone), ''), 'Africa/Lagos'))::date;
  perform assert_posting_open(v_take.property_id, v_today);

  -- --- THE COUNTERS --------------------------------------------------------
  -- ONE MOVEMENT PER STATEMENT, as 038 §6.2 requires: set_stock_carried_cost is
  -- STABLE and reads the statement's snapshot, so a batch insert would misvalue
  -- every stock-out after the first. The loop is not a style choice.
  for v_line in
    select l.movement_id, i.name as item_name
    from stock_take_lines l
    join inventory_items i on i.id = l.inventory_item_id
    where l.stock_take_id = v_take.id
      and l.movement_id is not null
      -- Already reversed on its own: step over it (see the header).
      and not exists (
        select 1 from stock_movements r
        where r.reverses_movement_id = l.movement_id
      )
    order by i.name, l.movement_id
  loop
    perform post_movement_reversal(
      v_line.movement_id,
      format('%s — count %s reversed: %s', v_line.item_name, v_take.take_number, v_reason),
      v_manager,
      v_actor,
      -- Rules 2/3: DETERMINISTIC per (count, movement). The count is undone once
      -- ever, so the document and the movement ARE the canonical key.
      'reverse_stock_take:' || v_take.id::text || ':' || v_line.movement_id::text
    );
  end loop;

  -- --- STAMP THE DOCUMENT --------------------------------------------------
  -- Last, so any failure above rolls the whole undoing back and there is no
  -- state in which some counters posted against a count still marked finished.
  begin
    update stock_takes t
       set status = 'reversed',
           reversed_at = now(),
           reversed_by = v_actor,
           reverse_approved_by = v_manager,
           reverse_reason = v_reason,
           reverse_idempotency_key = v_key,
           updated_by = v_actor
     where t.id = v_take.id
    returning * into v_take;
  exception
    when unique_violation then
      select * into v_existing
      from stock_takes t
      where t.tenant_id = v_take.tenant_id and t.reverse_idempotency_key = v_key
      limit 1;
      if found then
        return v_existing;
      end if;
      raise;
  end;

  return v_take;
end;
$$;

comment on function reverse_stock_take(uuid, text, text, text) is
  'Undoes a FINISHED count: posts an equal-and-opposite ''reversal'' for every '
  'movement it produced, marks the document reversed, and writes one permanent '
  'reversals row per movement naming who asked and which manager approved. ONE '
  'PIN for the document, not one per line — the manager approves a decision, and '
  'per-line bcrypt would run past the statement timeout on a large count. Lines '
  'already reversed on their own are STEPPED OVER rather than refused, so a count '
  'half-corrected from the ledger can still be finished off. There is deliberately '
  'no delete: an open count is abandoned, a finished one is reversed, and both '
  'stay readable forever.';


-- ############################################################################
-- SECTION 5 — THE READ SURFACES LEARN THE FOURTH STATE
-- ############################################################################
-- A REVERSED COUNT KEEPS ITS FIGURES VISIBLE. The blind rule (039 §4) withholds
-- the expected quantity until a count is FINISHED, and a reversed count was
-- finished — the numbers were already shown, approved and posted. Hiding them
-- again would not restore any secret; it would only make the document nobody can
-- now check the one document nobody can read.
--
-- 'cancelled' still reveals nothing, for 039's reason: a cancelled count settled
-- nothing, so start-then-cancel must never become a way to read the answers.
--
-- DROPPED AND RECREATED RATHER THAN REPLACED. `create or replace view` can only
-- APPEND columns; stock_take_progress gains four reversal columns that belong
-- beside the cancellation columns they mirror, not bolted onto the end. Both
-- views are dropped for consistency, and §6 re-issues every grant a drop takes
-- with it — which is exactly the kind of thing that is forgotten once and leaves
-- a screen 403-ing, so §7 asserts the grants afterwards.
drop view if exists stock_take_sheet;
drop view if exists stock_take_progress;

create view stock_take_sheet as
select
  l.id                            as line_id,
  l.tenant_id,
  t.id                            as stock_take_id,
  t.property_id,
  t.location_id,
  t.status                        as take_status,
  t.business_date,
  l.inventory_item_id,
  i.name                          as item_name,
  i.code                          as item_code,
  i.base_unit,
  i.category_id,
  i.is_active                     as item_is_active,
  c.name                          as category_name,

  l.counted_quantity,
  (l.counted_quantity is not null) as is_counted,
  l.counted_at,
  l.counted_by,

  -- BLIND UNTIL FINISHED (039 §4). Now: finished OR reversed.
  case when t.status in ('finished', 'reversed') then l.expected_quantity end
                                  as expected_quantity,
  case when t.status in ('finished', 'reversed') and l.counted_quantity is not null
       then (l.counted_quantity - l.expected_quantity)::numeric(14,4) end
                                  as variance_quantity,
  case when t.status in ('finished', 'reversed') then l.variance_unit_cost end
                                  as variance_unit_cost,
  case when t.status in ('finished', 'reversed') and l.counted_quantity is not null
       then round((l.counted_quantity - l.expected_quantity)
                  * coalesce(l.variance_unit_cost, 0), 2)::numeric(14,2) end
                                  as variance_value,

  l.movement_id,
  -- WHETHER THIS LINE'S MOVEMENT HAS BEEN UNDONE, so the report can show which
  -- lines still stand. Derived, never stored (rule 6) — the reversal pointer
  -- lives on the counter-movement and one lookup answers it, exactly as 038 §5.4
  -- derives reversed_by_movement_id for the ledger.
  (l.movement_id is not null and exists (
     select 1 from stock_movements r where r.reverses_movement_id = l.movement_id
   ))                             as movement_reversed
from stock_take_lines l
join stock_takes t
  on t.id = l.stock_take_id
join inventory_items i
  on i.id = l.inventory_item_id
 and i.tenant_id = l.tenant_id
left join inventory_categories c
  on c.id = i.category_id
 and c.tenant_id = l.tenant_id
 and c.deleted_at is null
-- THE TENANT PREDICATE. This view runs with the owner's rights (039 §4), so this
-- line IS the isolation. §7 asserts it is still here.
where t.tenant_id = any(get_tenant_ids());

comment on view stock_take_sheet is
  'THE COUNT SHEET and the finished variance report, in one view. '
  'expected_quantity, variance_quantity, variance_unit_cost and variance_value '
  'are NULL until the take is FINISHED (or reversed, which was finished first): '
  'the blind rule is enforced here, in the read path, not in the client. A '
  'CANCELLED count reveals nothing, so start-then-cancel is not a way to read the '
  'answers. movement_reversed says whether a line''s posting has since been '
  'undone. Runs with the OWNER''s rights, so it carries its own get_tenant_ids() '
  'predicate.';

create view stock_take_progress as
select
  t.id                                        as stock_take_id,
  t.tenant_id,
  t.property_id,
  t.location_id,
  l2.name                                     as location_name,
  t.take_number,
  t.status,
  t.business_date,
  t.note,
  t.started_at,
  t.started_by,
  t.finished_at,
  t.finished_by,
  t.approved_by,
  t.cancelled_at,
  t.cancelled_by,
  t.cancel_reason,
  t.reversed_at,
  t.reversed_by,
  t.reverse_approved_by,
  t.reverse_reason,

  count(l.id)::integer                        as line_count,
  count(l.counted_quantity)::integer          as counted_count,
  (count(l.id) - count(l.counted_quantity))::integer
                                              as uncounted_count,

  case when t.status in ('finished', 'reversed')
       then count(*) filter (
              where l.counted_quantity is not null
                and l.counted_quantity <> l.expected_quantity)::integer
  end                                         as variance_count,
  case when t.status in ('finished', 'reversed')
       then coalesce(sum(
              case when l.counted_quantity is null then 0
                   else round((l.counted_quantity - l.expected_quantity)
                              * coalesce(l.variance_unit_cost, 0), 2)
              end), 0)::numeric(14,2)
  end                                         as net_variance_value,
  case when t.status in ('finished', 'reversed')
       then coalesce(sum(
              case when l.counted_quantity is null then 0
                   else abs(round((l.counted_quantity - l.expected_quantity)
                                  * coalesce(l.variance_unit_cost, 0), 2))
              end), 0)::numeric(14,2)
  end                                         as absolute_variance_value,
  -- How much of this count is still standing. On a reversed count this is 0 and
  -- on a finished one it is variance_count — unless somebody reversed individual
  -- lines from the ledger, which is exactly the case worth being able to see.
  count(*) filter (where l.movement_id is not null)::integer
                                              as movement_count,
  count(*) filter (
    where l.movement_id is not null
      and exists (select 1 from stock_movements r
                   where r.reverses_movement_id = l.movement_id))::integer
                                              as reversed_movement_count
from stock_takes t
join locations l2
  on l2.id = t.location_id
left join stock_take_lines l
  on l.stock_take_id = t.id
where t.tenant_id = any(get_tenant_ids())
group by t.id, l2.name;

comment on view stock_take_progress is
  'One row per stock take with its sheet counted up: how many lines, how many '
  'counted, how many NOT counted, and — once finished — how many varied and what '
  'the variance was worth, net and absolute. Nothing is stored (rule 6). '
  'movement_count and reversed_movement_count say how much of the count is still '
  'standing, which differs from the status when individual lines were reversed '
  'from the ledger rather than the whole document being undone.';


-- ############################################################################
-- SECTION 6 — GRANTS
-- ############################################################################
revoke all on function reverse_stock_take(uuid, text, text, text) from public, anon, service_role;
grant  execute on function reverse_stock_take(uuid, text, text, text) to authenticated;

-- 038 revoked service_role from reverse_stock_movement explicitly, with the
-- honest caveat that it guards against ACCIDENT rather than against a role with
-- BYPASSRLS. Re-stated here because CREATE OR REPLACE keeps the existing ACL and
-- this file should not depend on that being remembered.
revoke all on function reverse_stock_movement(uuid, text, text, text) from public, anon, service_role;
grant  execute on function reverse_stock_movement(uuid, text, text, text) to authenticated;

-- THE POSTING HALF IS REACHABLE BY NOBODY. It is a PIN-gated act with the PIN
-- taken out; a client that could call it directly could erase any movement with
-- no manager involved. service_role is revoked too, for 038's reason: no future
-- unattended job should be able to reach the decision to erase stock.
revoke all on function post_movement_reversal(uuid, text, uuid, uuid, text)
  from public, anon, authenticated, service_role;

revoke all on stock_take_sheet from public;
revoke all on stock_take_sheet from anon;
revoke all on stock_take_sheet from authenticated;
grant select on stock_take_sheet to authenticated;

revoke all on stock_take_progress from public;
revoke all on stock_take_progress from anon;
revoke all on stock_take_progress from authenticated;
grant select on stock_take_progress to authenticated;


-- ############################################################################
-- SECTION 7 — IN-TRANSACTION SELF-VERIFY
-- ############################################################################
do $$
declare
  v_count   integer;
  v_missing text;
  v_def     text;
begin
  -- --- 1. The fourth state exists, in both constraints --------------------
  select count(*) into v_count
  from pg_constraint
  where conname = 'stock_takes_status_check'
    and pg_get_constraintdef(oid) like '%''reversed''%';
  if v_count <> 1 then
    raise exception 'ASSERT FAILED: stock_takes_status_check does not admit ''reversed''';
  end if;

  select count(*) into v_count
  from pg_constraint
  where conname = 'stock_takes_status_shape_check'
    and pg_get_constraintdef(oid) like '%reversed_at%';
  if v_count <> 1 then
    raise exception
      'ASSERT FAILED: the state-shape check does not mention reversed_at — a CASE with a missing branch returns NULL and a CHECK passes on NULL, so the fourth state would fail OPEN';
  end if;

  select count(*) into v_count
  from information_schema.columns
  where table_schema = 'public' and table_name = 'stock_takes'
    and column_name in ('reversed_at', 'reversed_by', 'reverse_approved_by',
                        'reverse_reason', 'reverse_idempotency_key');
  if v_count <> 5 then
    raise exception 'ASSERT FAILED: expected 5 reversal columns on stock_takes, found %', v_count;
  end if;

  select count(*) into v_count
  from pg_indexes
  where schemaname = 'public' and indexname = 'stock_takes_reverse_idem_uniq';
  if v_count <> 1 then
    raise exception 'ASSERT FAILED: the reverse idempotency index is missing (rule 3)';
  end if;

  -- --- 2. THERE IS ONE IMPLEMENTATION OF REVERSAL, NOT TWO ----------------
  -- The whole point of §2. reverse_stock_movement must DELEGATE rather than post
  -- for itself: if a later edit inlines the insert again, this fails.
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'reverse_stock_movement';
  if position('post_movement_reversal' in v_def) = 0 then
    raise exception
      'ASSERT FAILED: reverse_stock_movement no longer delegates to post_movement_reversal — there are two implementations of reversal again, and they will drift';
  end if;
  if position('insert into stock_movements' in v_def) > 0 then
    raise exception
      'ASSERT FAILED: reverse_stock_movement inserts a movement itself; the posting belongs to post_movement_reversal alone';
  end if;

  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'reverse_stock_take';
  if position('post_movement_reversal' in v_def) = 0 then
    raise exception 'ASSERT FAILED: reverse_stock_take does not use the shared reversal';
  end if;
  -- ONE PIN PER DOCUMENT: verify_manager_pin must appear exactly once, and never
  -- inside the loop. A per-line call is a timeout on a large count.
  if (length(v_def) - length(replace(v_def, 'verify_manager_pin', ''))) / length('verify_manager_pin') <> 1 then
    raise exception
      'ASSERT FAILED: reverse_stock_take calls verify_manager_pin more than once — bcrypt per line runs past the statement timeout on a large count';
  end if;

  -- --- 3. THE POSTING HALF IS REACHABLE BY NOBODY -------------------------
  if has_function_privilege('authenticated', 'post_movement_reversal(uuid, text, uuid, uuid, text)', 'EXECUTE')
     or has_function_privilege('anon', 'post_movement_reversal(uuid, text, uuid, uuid, text)', 'EXECUTE') then
    raise exception
      'ASSERT FAILED: a client can execute post_movement_reversal — that is the power to erase a movement with no manager anywhere near it';
  end if;

  if not has_function_privilege('authenticated', 'reverse_stock_take(uuid, text, text, text)', 'EXECUTE') then
    raise exception 'ASSERT FAILED: authenticated cannot execute reverse_stock_take';
  end if;

  -- --- 4. THE BLIND RULE SURVIVED THE VIEW REBUILD ------------------------
  -- The single most important thing this file could have broken. 039's guards A
  -- and B are untouched by it, but the view was rewritten, so C is re-asserted
  -- here rather than assumed.
  if has_column_privilege('authenticated', 'stock_take_lines', 'expected_quantity', 'SELECT') then
    raise exception 'ASSERT FAILED: authenticated can now SELECT expected_quantity — the count is no longer blind';
  end if;

  v_def := pg_get_viewdef('stock_take_sheet'::regclass, true);
  if position('''cancelled''' in v_def) > 0 then
    raise exception
      'ASSERT FAILED: stock_take_sheet mentions ''cancelled'' in its reveal condition — an abandoned count must never show its expected figures';
  end if;
  if position('''finished''' in v_def) = 0 or position('''reversed''' in v_def) = 0 then
    raise exception 'ASSERT FAILED: stock_take_sheet no longer reveals on finished/reversed';
  end if;
  if position('get_tenant_ids' in v_def) = 0 then
    raise exception
      'ASSERT FAILED: stock_take_sheet lost its get_tenant_ids() predicate — an owner-rights view with no tenant predicate reads every tenant';
  end if;

  v_def := pg_get_viewdef('stock_take_progress'::regclass, true);
  if position('get_tenant_ids' in v_def) = 0 then
    raise exception 'ASSERT FAILED: stock_take_progress lost its get_tenant_ids() predicate';
  end if;

  -- --- 5. The read surfaces resolve, AND KEPT THEIR GRANTS ----------------
  -- A DROP takes every grant with it. §6 re-issues them; this is what catches
  -- the day somebody adds a column to one view and forgets the other's grant,
  -- which presents as a screen 403-ing for every user at once.
  perform 1 from stock_take_sheet    limit 1;
  perform 1 from stock_take_progress limit 1;

  if not has_table_privilege('authenticated', 'stock_take_sheet', 'SELECT')
     or not has_table_privilege('authenticated', 'stock_take_progress', 'SELECT') then
    raise exception
      'ASSERT FAILED: a count view lost its SELECT grant when it was dropped and rebuilt — every count screen would 403';
  end if;

  if has_table_privilege('anon', 'stock_take_sheet', 'SELECT')
     or has_table_privilege('anon', 'stock_take_progress', 'SELECT') then
    raise exception
      'ASSERT FAILED: the rebuilt views are readable by anon. What a hotel counted in its stores is not for the internet.';
  end if;

  -- --- 6. The anon sweep, unchanged from 038/039 --------------------------
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
          'get_tenant_ids', 'get_property_ids', 'is_tenant_admin', 'is_tenant_staff'
        ])
    and leaks.nm <> all (array[
          'claim_statement_email', 'complete_statement_email',
          'update_property_branding', 'update_property_config',
          'update_property_details', 'update_tenant_settings'
        ]);

  if v_missing is not null then
    raise exception
      'ASSERT FAILED: anon holds EXECUTE on these SECURITY DEFINER functions, and they are neither RLS helpers nor on the 1.3 quarantine list: %.',
      v_missing;
  end if;

  raise notice '040 self-verify: all assertions passed.';
end $$;

notify pgrst, 'reload schema';

-- ============================================================================
-- End of 040_stock_take_reversal.sql
--
-- A count that was wrong can now be undone as one decision, by one manager, with
-- one reason — and both the count and its undoing stay on file. There is still
-- exactly one implementation of what it means to reverse a stock movement.
-- ============================================================================
