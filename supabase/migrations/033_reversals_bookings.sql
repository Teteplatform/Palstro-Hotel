-- ============================================================================
-- 033_reversals_bookings.sql
-- Palstro-Hotels: THE REVERSAL SUBSYSTEM, PART 3 — no-show and cancellation.
--
-- ----------------------------------------------------------------------------
--  ┌────────────────────────────────────────────────────────────────────────┐
--  │  PARTS 1 AND 2 REVERSED MONEY. THIS PART REVERSES A STATUS — AND A     │
--  │  STATUS IS WHAT HOLDS A ROOM. So the load-bearing guard here is not    │
--  │  the PIN and not the audit row (both are inherited, unchanged): it is  │
--  │  THE AVAILABILITY RE-CHECK. Un-cancelling is re-making the booking,    │
--  │  and it must pass the same lock-before-count gate create_booking       │
--  │  passes, or the hotel silently sells one room twice.                   │
--  └────────────────────────────────────────────────────────────────────────┘
-- ----------------------------------------------------------------------------
--
-- WHAT IS INHERITED FROM PARTS 1 AND 2, WITHOUT ALTERATION
-- --------------------------------------------------------
--   * the `reversals` audit table (031 §1) — its full target_type list already
--     declares 'no_show' and 'cancel', which is exactly why this part adds RPCs
--     and not a migration that alters that constraint;
--   * reversals_target_uniq — ONE reversal per (tenant, target_type, target),
--     EVER. §4.2 shows what that means for a booking cancelled twice, and it is
--     the subtlest thing in this file;
--   * member-read / no-write RLS on reversals (031 §5) — a reversals row is
--     evidence, and the only write path is a SECURITY DEFINER RPC that verified
--     a manager's PIN first;
--   * verify_manager_pin (021 §7.2), and the rule that a reversal ALWAYS needs a
--     PIN with no threshold (031 §3.2);
--   * the counter-entry pattern — the no-show charge is credited back by calling
--     reverse_charge (032 §3), NOT by a second, parallel reversal path.
--
-- WHAT THIS MIGRATION DOES *NOT* TOUCH, deliberately:
--   folio_totals, folio_balance, folio_charge_tax, the 022 read views, the
--   027/028 guest_stays / guest_ledger FIFO views, post_charge,
--   post_charge_reversal, post_room_night_charge, record_payment, reverse_payment,
--   reverse_charge, reverse_discount, void_charge, void_payment,
--   apply_charge_discount, create_booking, cancel_booking, check_in_booking,
--   check_out_booking, run_night_audit, COUNT_AVAILABLE'S LOGIC and every pricing
--   path are BYTE-FOR-BYTE as 015–032 left them.
--
--   ONE EXCEPTION, AND IT IS A CORRECTNESS FIX, NOT A FEATURE: mark_no_show is
--   re-created in §5 with ONE new guard. It is not in the untouchable list above
--   and it MUST change — see §5's header for the night the hotel would otherwise
--   believe it had charged and had not.
--
-- ----------------------------------------------------------------------------
-- THE THREE DESIGN DECISIONS THIS MIGRATION MAKES
-- ----------------------------------------------------------------------------
--
-- DECISION 1 — RESTORING GOES TO 'confirmed', NEVER STRAIGHT TO 'checked_in'.
--   A reversed no-show means "the guest did turn up, or we marked it in error".
--   The tempting shortcut is to check them in at the same time, since the usual
--   reason for reversing is that they are standing at the desk. It is wrong:
--     * CHECK-IN CAPTURES AN ARRIVAL INSTANT (024), and that instant decides
--       which nights the folio bills. A restore that invented one would file a
--       02:00 arrival against whatever moment the button was pressed;
--     * check_in_booking is the only path that records actual_check_in /
--       checked_in_at, and it exists precisely so nothing else guesses them;
--     * a booking restored in ERROR-CORRECTION mode (the guest never came, the
--       clerk mis-clicked) must NOT become an in-house stay.
--   So the restore is minimal and safe: back to 'confirmed', and the desk runs
--   the ordinary check-in flow with its arrival-time capture if the guest is
--   actually there. One act, one meaning.
--
-- DECISION 2 — THE AVAILABILITY GUARD IS PER NIGHT, AND IT IS SHARED (§2).
--   Both reversals restore a booking to a status that HOLDS INVENTORY, and both
--   are undoing an act that RELEASED it — 015 RULE 4 for a cancel, 029 §2 for a
--   no-show. In both cases the room may have been given to somebody else in the
--   meantime, so both call ONE helper, under the same room_types row lock
--   create_booking takes. Two copies of this guard would agree on the day they
--   were written and drift the first time one was fixed; the failure mode of
--   that drift is a silent overbooking, which is the one failure this file
--   exists to prevent.
--
-- DECISION 3 — THE MONEY IS REVERSED THROUGH THE EXISTING ENGINE, OR NOT AT ALL.
--   A no-show on a company-guaranteed booking posted one night through
--   post_charge under the key 'noshow:<booking>' (024 §4). Reversing the no-show
--   credits that night back by calling reverse_charge — the same PIN-gated,
--   counter-entry, audit-row path a manager would use by hand on the folio — so
--   the tax reverses with it automatically (021 computes tax live from net) and
--   there is exactly one charge-reversal code path in the system. A walk-in was
--   charged NOTHING, so there is nothing to reverse and the status moves alone.
--   No new arithmetic anywhere; see §3.4.
-- ============================================================================


-- ############################################################################
-- SECTION 1 — one more per-type constraint on the audit table
-- ############################################################################
-- 031 §1 required counter_entry_id NOT NULL for 'payment'; 032 §1.2 extended
-- that to 'charge' and 'discount', as its own constraint so 031's was never
-- dropped and re-created. This is the same pattern once more, in the opposite
-- direction, for the type that can never have one.
--
--   'cancel'  — reverses a STATE and posts nothing. Cancelling a not-yet-arrived
--               booking posts no charge (015 §8: it touches only the status), so
--               there is nothing for a counter-entry to undo. A 'cancel' row
--               carrying one would be describing money that never moved.
--   'no_show' — MAY have one (the reversed retention charge on a guaranteed
--               booking) and may not (a walk-in was charged nothing). So it is
--               left unconstrained on purpose: both shapes are correct facts.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'reversals_cancel_no_counter_check'
  ) then
    alter table reversals
      add constraint reversals_cancel_no_counter_check
      check (target_type <> 'cancel' or counter_entry_id is null);
  end if;
end;
$$;


-- ############################################################################
-- SECTION 2 — assert_restorable_inventory: THE AVAILABILITY GUARD
-- ############################################################################
--
--   ┌──────────────────────────────────────────────────────────────────────────┐
--   │  THIS IS THE LOAD-BEARING FUNCTION OF THE WHOLE MIGRATION. Everything    │
--   │  else here is the inherited reversal shape applied to two more targets.  │
--   │  Getting THIS wrong is a silent overbooking — a guest with a confirmed   │
--   │  booking and no room, discovered at 23:00 at the desk.                   │
--   └──────────────────────────────────────────────────────────────────────────┘
--
-- 2.1 WHY A RESTORE NEEDS THE SAME GATE AS A SALE
-- -----------------------------------------------
-- count_available (015 §6 / 029 §2) computes occupancy LIVE from the bookings
-- table; there is no availability cache anywhere. That is what makes a status
-- change the ENTIRE act of freeing a room — and it is equally what makes a
-- status change the entire act of TAKING one back. Restoring a booking to
-- 'confirmed' re-occupies its nights the instant it commits, with no other write.
--
-- So the two acts this file undoes both released a room that somebody else may
-- now hold:
--   * A CANCEL freed it immediately (015 RULE 4: 'cancelled' never occupies).
--   * A NO-SHOW freed it too, since 029 §2 flipped p_count_no_show's default to
--     false — the room was billed as absent and holding it as well was "lost
--     revenue with a status attached".
-- Reversing either is therefore not a bookkeeping correction. IT IS RE-MAKING
-- THE BOOKING, and it must pass the gate create_booking passes.
--
-- 2.2 THE LOCKING DISCIPLINE, IDENTICAL TO create_booking
-- -------------------------------------------------------
-- create_booking (015 §7, carried unchanged through 016/019/020/025) does:
--
--     select ... from room_types where id = ... for update;   -- THE LOCK
--     v_available := count_available(...);                    -- COUNT UNDER IT
--     if v_available <= 0 then raise ...                      -- REFUSE, never floor
--
-- This function does exactly that, in that order, on the SAME row: the lock is
-- taken FIRST so the count cannot go stale underneath it, and two callers
-- racing for the last unit serialise on the room_types row rather than both
-- reading "1 free". A count without the lock is not a guard, it is a guess.
--
-- LOCK ORDER, stated because a deadlock here would be a self-inflicted outage:
-- the callers lock the BOOKING row first (their guard 1) and then this function
-- locks the ROOM TYPE. No path in the schema takes them the other way round —
-- create_booking locks only the room type, and check_in/check_out/cancel/no-show
-- lock only the booking — so the order booking → room_type is consistent
-- everywhere and there is no cycle to deadlock on.
--
-- 2.3 WHY THIS COUNTS PER NIGHT WHERE create_booking COUNTS THE SPAN
-- ------------------------------------------------------------------
-- create_booking asks count_available ONCE for the whole window. That is a
-- CONSERVATIVE reading: count_available counts every booking that overlaps the
-- window ANYWHERE against the window as a whole, so a one-night booking in the
-- middle of a five-night request consumes a unit for all five nights. At the
-- point of SALE that is the right trade — it is simple, it never oversells, and
-- it costs at most a rejected booking a human can re-try with different dates.
--
-- Here the same reading would be actively harmful, for two reasons:
--   1. IT WOULD REFUSE RESTORES THAT ARE PERFECTLY SAFE. A guest whose room was
--      re-let for ONE night of their five-night stay would be unrestorable, and
--      the desk would be told "no availability" about four nights that are free.
--   2. IT COULD NOT NAME THE PROBLEM. The brief's requirement — and the right
--      one — is that the rejection tells the desk WHICH NIGHTS are gone, so they
--      can act on it. A single span-wide count knows only "not enough", never
--      "the 14th and the 15th".
--
-- Per-night is also STRICTLY EXACT rather than merely more permissive: for each
-- night d the loop asserts (bookings occupying [d, d+1)) < inventory BEFORE the
-- restore, so after the restore no night exceeds inventory. There is no night on
-- which the hotel ends up owing more rooms than it has, which is the only thing
-- "do not overbook" can mean.
--
-- 2.4 EVERY NIGHT OF THE SPAN, INCLUDING NIGHTS ALREADY PAST
-- ----------------------------------------------------------
-- A no-show is reversed a day or two after the arrival day has ended, so part of
-- the stay is usually in the past. Those nights are checked too, and that is
-- deliberate: if last night's room was sold to somebody else, it WAS sold — a
-- second booking over it is a double-sold room whether the date is yesterday or
-- tomorrow, and the reports that read count_available make no distinction. The
-- honest answer is to refuse and name the nights, so the desk can see the room
-- genuinely went elsewhere.
--
-- 2.5 WHY IT IS CALLABLE BY NOBODY
-- --------------------------------
-- §7 revokes EXECUTE from public, anon AND authenticated — the posture 021 §12
-- gives verify_manager_pin and 032 §9 gives post_charge_reversal. It takes a
-- whole bookings row as its argument, so a client that could call it could hand
-- it a fabricated one; its only callers are the two RPCs below, which read that
-- row from the table themselves under a lock.
create or replace function assert_restorable_inventory(p_booking bookings)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inventory  integer;
  v_type_name  text;
  v_date       date;
  v_available  integer;
  v_full       date[] := '{}';
  v_full_count integer;
  v_nights     integer := 0;
  v_listed     text;
begin
  -- ===================== THE LOCK (create_booking's own) ====================
  -- Same row, same clause, same NULL-safe deleted_at guard (rule 5). The name is
  -- pulled on this SAME read so the rejection below can say WHICH room type is
  -- full without a second query.
  select rt.inventory_count, rt.name
    into v_inventory, v_type_name
  from room_types rt
  where rt.id = p_booking.room_type_id
    and rt.property_id = p_booking.property_id
    and rt.deleted_at is null
  for update;

  if not found then
    -- The type was retired while the booking sat cancelled. There is no
    -- inventory to restore into, and count_available would return 0 for every
    -- night anyway (015 §6: a missing or soft-deleted type yields 0 free).
    raise exception
      'The room type on this booking no longer exists at this property, so it cannot be restored'
      using errcode = 'no_data_found',
            hint = 'Take a new booking on a room type the property still offers.';
  end if;

  -- ================= THE COUNT, UNDER THE HELD LOCK, PER NIGHT ===============
  -- p_exclude_booking_id = this booking. Belt and braces: a 'cancelled' booking
  -- and (since 029 §2) a 'no_show' one are both already excluded by
  -- count_available's own status predicate, so this changes no answer today. It
  -- is passed because the QUESTION being asked is "is there room for this
  -- booking BESIDES itself", and stating that in the call means a future status
  -- rule cannot silently make the guard count the booking against itself.
  v_date := p_booking.check_in;
  while v_date < p_booking.check_out loop
    v_nights := v_nights + 1;

    v_available := count_available(
      p_booking.property_id,
      p_booking.room_type_id,
      v_date,
      v_date + 1,
      p_booking.id
    );

    if v_available <= 0 then
      v_full := v_full || v_date;
    end if;

    v_date := v_date + 1;
  end loop;

  v_full_count := coalesce(array_length(v_full, 1), 0);

  -- EVERY NIGHT FREE -> the caller may restore. This is the only return path.
  if v_full_count = 0 then
    return;
  end if;

  -- ========================= THE REFUSAL, NAMED =============================
  -- REJECT, NEVER SILENTLY OVERBOOK, and never "restore the nights that fit" —
  -- a booking is one room for a continuous stay, and a guest holding nights 1
  -- and 4 of a four-night reservation has not been helped.
  --
  -- The message names the nights because the desk has to act on it: "the room
  -- was taken" is an argument with a guest, "the 14th and the 15th are full" is
  -- a conversation about alternatives. Up to five are listed by name and the
  -- rest counted, so a month-long booking does not produce an unreadable wall.
  select string_agg(to_char(t.d, 'DD Mon YYYY'), ', ' order by t.d)
    into v_listed
  from unnest(v_full[1:5]) as t(d);

  if v_full_count > 5 then
    v_listed := v_listed || format(' and %s more', v_full_count - 5);
  end if;

  raise exception
    'Room no longer available for % to % — % of % night(s) are full: %',
    to_char(p_booking.check_in, 'DD Mon YYYY'),
    to_char(p_booking.check_out, 'DD Mon YYYY'),
    v_full_count,
    v_nights,
    v_listed
    using errcode = 'check_violation',
          hint = format(
            'Another booking now holds the last %s for those nights, so restoring this one would overbook it. Offer a different room type or different dates, or move the other booking first.',
            v_type_name);
end;
$$;

comment on function assert_restorable_inventory(bookings) is
  'THE OVERBOOKING GUARD FOR A RESTORE. Locks the booking''s room_types row '
  '(SELECT ... FOR UPDATE) exactly as create_booking does, then counts '
  'availability under that lock for EVERY night of the booking''s span, and '
  'RAISES naming the full nights if any night has none. Per-night rather than '
  'create_booking''s single span-wide count: it is exact (no night can exceed '
  'inventory afterwards) and it can tell the desk WHICH nights are gone. Returns '
  'normally only when every night is free. INTERNAL — revoked from every client '
  'role (§7): it takes a whole bookings row, which a client could fabricate.';


-- ############################################################################
-- SECTION 3 — reverse_no_show
-- ############################################################################
--
-- WHAT IT UNDOES. mark_no_show (024 §4) did two things in one transaction: it
-- set status = 'no_show', and — for a GUARANTEED booking (company_id set OR
-- bill_to = 'company') — posted ONE night at the rate locked for the reserved
-- first night, under the deterministic key 'noshow:<booking>'. Since 029 the
-- night audit does the same automatically once the arrival day is entirely over.
-- Reversing says: the guest DID turn up, or it was marked in error.
--
-- 3.1 THE GUARD ORDER, AND WHY IT IS THIS ORDER (031 §3.1, applied to a booking)
-- -----------------------------------------------------------------------------
--   1. RESOLVE AND LOCK the booking (`select ... for update`). FIRST, because it
--      is what makes every check below atomic: a concurrent reversal and a
--      concurrent check-in serialise here.
--   2. STAFF GATE, then the caller's own PROPERTY GRANT (rule 19's two layers).
--   3. IDEMPOTENCY BY KEY — a replay of the same intent returns the first
--      outcome, BEFORE the PIN check, so a retry after a network drop does not
--      send the desk to fetch a manager for an approval that already happened.
--   4. IDEMPOTENCY BY STATE — already reversed? Return that reversal. The
--      stronger guard: it catches a retry arriving with a DIFFERENT key. §4.2's
--      re-cancel subtlety applies here identically and is handled the same way.
--   5. THE BOOKING MUST CURRENTLY BE 'no_show'. Anything else is not a no-show
--      to reverse.
--   6. REASON NON-EMPTY, in the RPC and not only the UI (rule 19), and in the
--      reversals column CHECK besides.
--   7. MANAGER PIN, ALWAYS. No threshold — restoring a booking re-takes a room
--      the hotel may have re-sold, and it un-bills a night that was invoiced.
--   8. THE AVAILABILITY GUARD (§2). LAST of the guards and first of the effects:
--      it takes a second lock, so it runs only once the call is otherwise
--      certain to proceed.
--
-- 3.2 THE ROOM-MAY-BE-GONE RISK IS THE SAME RISK AS UN-CANCEL
-- -----------------------------------------------------------
-- 029 §2 made a no_show RELEASE the room, and it said why in terms: the audit
-- resolves an uncollected booking the morning after arrival, and holding a room
-- already billed as absent is lost revenue. The consequence is exactly the one
-- the brief asks about: BETWEEN THE NO-SHOW AND ITS REVERSAL, ANOTHER BOOKING
-- MAY HAVE TAKEN THAT ROOM. There is no difference in kind from a cancel, so
-- there is no difference in treatment: the same assert_restorable_inventory
-- call, the same per-night count under the same lock, the same named refusal.
--
-- 3.3 WHY THE STATUS GOES TO 'confirmed' — DECISION 1 in the header.
--
-- 3.4 HOW THE NO-SHOW CHARGE IS REVERSED (DECISION 3)
-- ---------------------------------------------------
-- By calling reverse_charge (032 §3) on the charge mark_no_show posted. Not a
-- second reversal path, not a void, not an edit:
--   * THE CHARGE IS FOUND BY ITS DETERMINISTIC KEY, 'noshow:<booking>'. That key
--     is the one fact mark_no_show guarantees about the row (024's header: "one
--     no-show charge per booking, forever"), so it identifies the retention
--     night exactly, without pattern-matching a description or guessing at a
--     category.
--   * reverse_charge POSTS THE COUNTER-ENTRY, mirroring gross, discount and net,
--     so the tax comes off with it automatically — 021 computes tax live from
--     each charge's net, and a negative net yields a negative tax on the very
--     next read. There is no tax handling in this file at all.
--   * IT WRITES ITS OWN 'charge' REVERSALS ROW, and this function's 'no_show'
--     row then names that counter-entry in counter_entry_id. TWO audit rows for
--     two distinct facts — "the retention charge was reversed" and "the no-show
--     itself was reversed" — which is correct: a manager may have reversed the
--     charge alone last week (a goodwill waiver with the status left standing),
--     and that act must not be overwritten or duplicated by this one. If it
--     happened, reverse_charge's idempotency-by-state returns that earlier
--     reversal and no second counter-entry is posted.
--   * NO KEY IS PASSED to reverse_charge, on purpose, so it uses its own
--     deterministic 'reversal:charge:<id>'. Two keys naming one act is how a
--     second counter-entry eventually gets posted.
--   * A VOIDED no-show charge is SKIPPED, not reversed. A void already took it
--     out of every total (rule 5's NULL-safe filter), so a counter-entry would
--     move the balance by an amount the bill never included — the same reasoning
--     031 §3.1 guard 5 and 032 §3.1 guard 5 state for their originals.
--   * A WALK-IN HAS NO CHARGE AT ALL (024's rule: a company held the room so
--     they owe a night; a walk-in committed nothing). Nothing is posted and
--     counter_entry_id stays NULL, which §1 permits precisely for this case.
--
-- 3.5 THE FOLLOW-UP NOTICE IS CLEARED IN THE SAME TRANSACTION
-- -----------------------------------------------------------
-- 029 §1 raises a front-desk note when the audit no-shows and CHARGES a
-- corporate booking: "call them before the room goes to someone else". Reversing
-- the no-show is that call's outcome — the booking stands again and the room is
-- back on it — so leaving the notice outstanding would leave the desk chasing a
-- resolved problem. It is cleared through acknowledge_booking_follow_up (029
-- §3), which records WHO dismissed it from auth.uid() and is idempotent by
-- state, rather than by writing the columns here.
--
-- 3.6 THE TRANSACTION BOUNDARY
-- ----------------------------
-- One function call is one transaction (rule 11), and rule 7's lockstep is real
-- here in a way it was not in parts 1 and 2: the STATUS, the FOLIO and the AUDIT
-- ROW all move together. If the charge reversal fails — a settled folio, a
-- missing category — the status restore rolls back with it, so the system can
-- never hold a booking restored to 'confirmed' whose retention night is still
-- billed to a company that no longer owes it.

create or replace function reverse_no_show(
  p_booking_id      uuid,
  p_reason          text,
  p_manager_pin     text,
  p_idempotency_key text default null
)
returns reversals
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking     bookings;
  v_charge      folio_charges;
  v_folio       folios;
  v_charge_rev  reversals;
  v_counter_id  uuid;
  v_reversal    reversals;
  v_existing    reversals;
  v_manager     uuid;
  v_reason      text;
  v_key         text;
  v_timezone    text;
  v_date        date;
  v_actor       uuid := auth.uid();
begin
  -- --- GUARD 1: resolve and LOCK the booking -------------------------------
  -- FOR UPDATE before anything else: two terminals reversing the same no-show in
  -- the same second serialise here, and the loser reads the winner's committed
  -- reversals row at guard 4 instead of restoring twice.
  select * into v_booking
  from bookings
  where id = p_booking_id and deleted_at is null      -- rule 5
  for update;

  if not found then
    raise exception 'Booking % not found', p_booking_id using errcode = 'no_data_found';
  end if;

  -- --- GUARD 2: staff gate, then this caller's own property grant -----------
  if not is_tenant_staff(v_booking.tenant_id) then
    raise exception 'Not authorised to reverse a no-show for this tenant'
      using errcode = 'insufficient_privilege';
  end if;
  if not (v_booking.property_id = any(get_property_ids())) then
    raise exception 'You do not have access to this property'
      using errcode = 'insufficient_privilege';
  end if;

  v_key := coalesce(
    nullif(btrim(p_idempotency_key), ''),
    'reversal:no_show:' || p_booking_id::text
  );

  -- --- GUARD 3: idempotency BY KEY (rules 2 & 3) ---------------------------
  select * into v_existing
  from reversals
  where tenant_id = v_booking.tenant_id and idempotency_key = v_key
  limit 1;
  if found then
    -- A GENUINE RETRY returns the first outcome. A booking that is no_show
    -- AGAIN, however, was re-marked after being restored, and returning success
    -- would tell the desk it had been restored when it plainly has not (§4.2).
    if v_booking.status = 'no_show' then
      raise exception
        'This booking''s no-show has already been reversed once, and it has been marked as a no-show again since'
        using errcode = 'check_violation',
              hint = 'A no-show is reversed once, ever. Cancel the booking, or take a new booking for the guest.';
    end if;
    return v_existing;
  end if;

  -- --- GUARD 4: idempotency BY STATE — already reversed? -------------------
  -- The stronger of the two: it catches a retry arriving with a DIFFERENT key,
  -- and (holding the guard 1 lock) it is what makes "a no-show is reversed at
  -- most once" true under concurrency rather than merely likely. The DB backs it
  -- with reversals_target_uniq.
  select * into v_existing
  from reversals
  where tenant_id = v_booking.tenant_id
    and target_type = 'no_show'
    and target_id = p_booking_id
  limit 1;
  if found then
    if v_booking.status = 'no_show' then
      raise exception
        'This booking''s no-show has already been reversed once, and it has been marked as a no-show again since'
        using errcode = 'check_violation',
              hint = 'A no-show is reversed once, ever. Cancel the booking, or take a new booking for the guest.';
    end if;
    return v_existing;
  end if;

  -- --- GUARD 5: it must BE a no-show ---------------------------------------
  if v_booking.status <> 'no_show' then
    raise exception
      'Only a no-show can have its no-show reversed (this booking is %)', v_booking.status
      using errcode = 'check_violation';
  end if;

  -- --- GUARD 6: the reason is mandatory HERE, not only in the UI (rule 19) --
  v_reason := btrim(coalesce(p_reason, ''));
  if v_reason = '' then
    raise exception 'A reversal needs a reason' using errcode = 'check_violation';
  end if;

  -- --- GUARD 7: A MANAGER PIN. ALWAYS. NO THRESHOLD. -----------------------
  -- 031 §3.2's reasoning, on a status: this re-takes a room the hotel may have
  -- re-sold and un-bills a night already invoiced to a company. There is no
  -- amount below which that is routine and no property setting that can make it
  -- so. Last of the cheap guards, so a call that was going to be rejected anyway
  -- never consumes a PIN entry.
  v_manager := verify_manager_pin(v_booking.tenant_id, p_manager_pin);
  if v_manager is null then
    raise exception 'Reversing a no-show always requires a valid manager PIN'
      using errcode = 'insufficient_privilege',
            hint = 'Hand the terminal to a manager. The reversal is recorded against them by name.';
  end if;

  -- --- GUARD 8: THE AVAILABILITY GUARD (§2, §3.2) --------------------------
  -- The no-show RELEASED this room (029 §2), so another booking may hold it now.
  -- Identical treatment to un-cancel: locks the room type, counts every night
  -- under the lock, and RAISES naming the full nights rather than overbooking.
  perform assert_restorable_inventory(v_booking);

  -- --- THE EFFECT, all of it inside this one transaction (§3.6) ------------

  -- The business date (rules 8, 12), resolved in the PROPERTY's timezone exactly
  -- as mark_no_show, record_payment and create_booking do. It is the date the
  -- REVERSAL happens, never the original no-show's date: the booking is restored
  -- TODAY, and today's audit trail is what must show it.
  select p.timezone into v_timezone from properties p where p.id = v_booking.property_id;
  v_date := (now() at time zone coalesce(nullif(btrim(v_timezone), ''), 'Africa/Lagos'))::date;

  -- THE STATUS. Back to 'confirmed' — DECISION 1: the safe, minimal reversal,
  -- and it lets the normal check-in flow run with its arrival-time capture if
  -- the guest is in fact standing at the desk. cancelled_at / cancellation_reason
  -- are not touched (a no-show never set them).
  update bookings
     set status     = 'confirmed',
         updated_by = v_actor
   where id = p_booking_id
  returning * into v_booking;

  -- THE RETENTION CHARGE (§3.4). Found by mark_no_show's deterministic key, which
  -- is the only fact guaranteed about the row.
  select * into v_charge
  from folio_charges
  where tenant_id = v_booking.tenant_id
    and idempotency_key = 'noshow:' || p_booking_id::text
  limit 1;

  if found and v_charge.is_voided is not true then      -- rule 5, NULL-safe
    -- A settled/closed folio takes no counter-posting. reverse_charge refuses it
    -- anyway; this raises the sentence a person can act on, naming the no-show
    -- charge rather than a charge id they would have to go and look up.
    select * into v_folio from folios where id = v_charge.folio_id;
    if v_folio.status <> 'open' then
      raise exception
        'This booking''s no-show charge cannot be credited back: its folio is %', v_folio.status
        using errcode = 'check_violation',
              hint = 'Re-open the folio first — a decision with its own audit trail — then reverse the no-show. The status has not been changed.';
    end if;

    -- THROUGH THE EXISTING ENGINE (DECISION 3). No key passed: reverse_charge
    -- uses its own deterministic 'reversal:charge:<id>', so two keys can never
    -- name one act. If a manager already reversed this charge by hand, its
    -- idempotency-by-state returns THAT reversal and nothing is posted twice.
    v_charge_rev := reverse_charge(
      v_charge.id,
      'No-show reversed — ' || v_reason,
      p_manager_pin,
      null
    );
    v_counter_id := v_charge_rev.counter_entry_id;
  end if;

  -- THE FOLLOW-UP NOTICE (§3.5). Only when one is outstanding; the RPC refuses a
  -- booking with no note at all, so the guard is on the column, not on the call.
  if v_booking.follow_up_note is not null
     and v_booking.follow_up_acknowledged_at is null then
    perform acknowledge_booking_follow_up(p_booking_id, null);
  end if;

  -- THE AUDIT ROW. Written last, so it can name the counter-entry it produced.
  begin
    insert into reversals (
      tenant_id, property_id, reversed_by, approved_by, reason,
      target_type, target_id, counter_entry_id, business_date,
      idempotency_key, created_by
    ) values (
      v_booking.tenant_id, v_booking.property_id, v_actor, v_manager, v_reason,
      -- target_id is THE BOOKING: a no-show has no id of its own — it is a
      -- status ON the booking (031 §1: the target is polymorphic).
      'no_show', p_booking_id, v_counter_id, v_date,
      v_key, v_actor
    )
    returning * into v_reversal;
  exception
    when unique_violation then
      -- A concurrent caller won a race the guard 1 lock should already have
      -- prevented. Return THEIR row — but only if it genuinely exists:
      -- re-raising otherwise aborts the whole call, rolling the status restore
      -- and the charge reversal back with it, so this handler can never leave a
      -- restored booking without its audit row.
      select * into v_existing
      from reversals
      where tenant_id = v_booking.tenant_id
        and (idempotency_key = v_key
             or (target_type = 'no_show' and target_id = p_booking_id))
      limit 1;
      if found then
        return v_existing;
      end if;
      raise;
  end;

  return v_reversal;
end;
$$;

comment on function reverse_no_show(uuid, text, text, text) is
  'Reverses a no-show: restores the booking to CONFIRMED (never straight to '
  'checked_in — the desk runs the ordinary check-in so the arrival instant is '
  'captured), credits back the retention charge if one was posted by calling '
  'reverse_charge on the ''noshow:<booking>'' charge (so the tax reverses with it '
  'and there is one charge-reversal path in the system), clears the 029 follow-up '
  'notice, and writes a permanent reversals row. A no-show RELEASED the room (029 '
  '§2), so this re-checks availability PER NIGHT under a room_types row lock '
  'exactly as create_booking does and REFUSES — naming the full nights — rather '
  'than overbooking. ALWAYS requires a valid manager PIN and a non-empty reason, '
  'both enforced here and not only in the UI (rule 19). Idempotent by key AND by '
  'state under a FOR UPDATE lock: a double-click can never double-restore or '
  'double-reverse the charge.';


-- ############################################################################
-- SECTION 4 — reverse_cancel
-- ############################################################################
--
-- 4.1 THE AVAILABILITY GUARD IS THE CRUX, AND IT IS THE SAME ONE
-- --------------------------------------------------------------
-- Cancelling freed the room the instant it committed (015 §8 / RULE 4:
-- count_available excludes 'cancelled', and there is no availability cache).
-- Restoring is therefore RE-MAKING THE BOOKING, and it goes through
-- assert_restorable_inventory (§2) — the same room_types FOR UPDATE lock
-- create_booking takes, the same count_available under that lock, per night,
-- with the same named refusal. §2.2 sets out the lock discipline and §2.3 why
-- the count is per night. THE GUARD IS SHARED CODE, not a copy: a copy would
-- drift, and the failure mode of that drift is a silently double-sold room.
--
-- 4.2 A BOOKING CANCELLED, RESTORED, THEN CANCELLED AGAIN — THE SUBTLE CASE
-- -------------------------------------------------------------------------
-- reversals_target_uniq (031 §1) is on (tenant, target_type, target_id), so
-- there can be exactly ONE 'cancel' reversal per booking, ever. That is right —
-- an audit table where the same act can be recorded twice is not an audit table
-- — but it makes a plain "already reversed -> return that reversal" check WRONG
-- in one sequence:
--
--     cancel -> reverse_cancel (restored) -> cancel again -> reverse_cancel?
--
-- The second call finds the first reversals row and would return it, reporting
-- SUCCESS while the booking sits cancelled. The desk would believe the guest had
-- a room. So both idempotency checks below branch on the CURRENT STATUS:
--
--     found + booking NOT cancelled  -> a genuine retry. Return the first row.
--     found + booking IS cancelled   -> it was re-cancelled after being restored.
--                                       REFUSE, in words that say exactly that.
--
-- Re-cancelling a restored booking stays perfectly legal (cancel_booking is
-- untouched) — it just cannot be undone a second time. Taking a fresh booking is
-- the honest remedy, and it goes through create_booking's own overbooking guard.
--
-- 4.3 WHAT A CANCELLATION REVERSAL DOES *NOT* TOUCH — the money
-- -------------------------------------------------------------
-- NOTHING FINANCIAL, and this is confirmed rather than assumed. cancel_booking
-- (015 §8) sets status, cancelled_at and cancellation_reason and posts nothing:
-- a booking cancelled before arrival has no room charges (the nights are posted
-- by the night audit for in-house stays and by check_out_booking at departure —
-- 023/026 — neither of which ever sees a cancelled booking), and cancelling
-- deliberately does not touch a deposit already taken (021 §10: whether that
-- money is refunded or forfeited is a commercial decision a person makes).
-- So there is no counter-entry to post, §1's constraint enforces that a 'cancel'
-- row carries none, and ANY DEPOSIT OR PAYMENT ON THE FOLIO STAYS EXACTLY WHERE
-- IT IS. Restoring the booking does not touch the guest's money — that remains a
-- separate, deliberate act with its own audit trail.
--
-- 4.4 cancelled_at AND cancellation_reason ARE KEPT
-- --------------------------------------------------
-- They are the record of a cancellation that genuinely happened, and this file's
-- founding principle is that a reversal never erases the original fact (031's
-- header box). The booking WAS cancelled on that date for that reason; the
-- reversals row is the record of that being undone, by whom and why. STATUS is
-- the flag every reader uses — count_available, the audit, the screens — and no
-- code path treats a non-null cancelled_at as "is cancelled" (verified across
-- the schema and the client: the column is written by cancel_booking and read
-- only for display).
--
-- 4.5 A RESTORED BOOKING WHOSE ARRIVAL DAY HAS PASSED
-- ---------------------------------------------------
-- Restoring is allowed whatever the dates, and it is deliberately not gated on
-- them: correcting a wrongly-cancelled stay days later is exactly the case this
-- exists for. But a restored booking whose arrival day is already over is once
-- again a candidate for 029's auto-resolve pass, which will cancel it (or
-- no-show and charge it, if a company guaranteed it) at the next night audit.
-- That is the correct behaviour of that pass, not a bug here — a confirmed
-- booking nobody collected is precisely what it exists to resolve — and the UI
-- says so on the confirmation panel, so the desk checks the guest in rather than
-- discovering it tomorrow.

create or replace function reverse_cancel(
  p_booking_id      uuid,
  p_reason          text,
  p_manager_pin     text,
  p_idempotency_key text default null
)
returns reversals
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking  bookings;
  v_reversal reversals;
  v_existing reversals;
  v_manager  uuid;
  v_reason   text;
  v_key      text;
  v_timezone text;
  v_date     date;
  v_actor    uuid := auth.uid();
begin
  -- --- GUARD 1: resolve and LOCK the booking -------------------------------
  select * into v_booking
  from bookings
  where id = p_booking_id and deleted_at is null      -- rule 5
  for update;

  if not found then
    raise exception 'Booking % not found', p_booking_id using errcode = 'no_data_found';
  end if;

  -- --- GUARD 2: staff gate, then this caller's own property grant -----------
  if not is_tenant_staff(v_booking.tenant_id) then
    raise exception 'Not authorised to reverse a cancellation for this tenant'
      using errcode = 'insufficient_privilege';
  end if;
  if not (v_booking.property_id = any(get_property_ids())) then
    raise exception 'You do not have access to this property'
      using errcode = 'insufficient_privilege';
  end if;

  v_key := coalesce(
    nullif(btrim(p_idempotency_key), ''),
    'reversal:cancel:' || p_booking_id::text
  );

  -- --- GUARD 3: idempotency BY KEY (rules 2 & 3) ---------------------------
  -- Before the PIN check on purpose: a retried intent returns the first outcome
  -- without demanding the manager come back to the terminal.
  select * into v_existing
  from reversals
  where tenant_id = v_booking.tenant_id and idempotency_key = v_key
  limit 1;
  if found then
    -- §4.2: a booking that is cancelled AGAIN was re-cancelled after being
    -- restored. Returning the old row would report success on a booking that
    -- still has no room held for it.
    if v_booking.status = 'cancelled' then
      raise exception
        'This booking''s cancellation has already been reversed once, and it has been cancelled again since'
        using errcode = 'check_violation',
              hint = 'A cancellation is reversed once, ever, so this one cannot be restored a second time. Take a new booking for the guest — it will be checked against availability in the usual way.';
    end if;
    return v_existing;
  end if;

  -- --- GUARD 4: idempotency BY STATE — already reversed? -------------------
  select * into v_existing
  from reversals
  where tenant_id = v_booking.tenant_id
    and target_type = 'cancel'
    and target_id = p_booking_id
  limit 1;
  if found then
    if v_booking.status = 'cancelled' then
      raise exception
        'This booking''s cancellation has already been reversed once, and it has been cancelled again since'
        using errcode = 'check_violation',
              hint = 'A cancellation is reversed once, ever, so this one cannot be restored a second time. Take a new booking for the guest — it will be checked against availability in the usual way.';
    end if;
    return v_existing;
  end if;

  -- --- GUARD 5: it must BE cancelled ---------------------------------------
  if v_booking.status <> 'cancelled' then
    raise exception
      'Only a cancelled booking can have its cancellation reversed (this booking is %)',
      v_booking.status using errcode = 'check_violation';
  end if;

  -- --- GUARD 6: the reason is mandatory HERE, not only in the UI (rule 19) --
  v_reason := btrim(coalesce(p_reason, ''));
  if v_reason = '' then
    raise exception 'A reversal needs a reason' using errcode = 'check_violation';
  end if;

  -- --- GUARD 7: A MANAGER PIN. ALWAYS. NO THRESHOLD. -----------------------
  v_manager := verify_manager_pin(v_booking.tenant_id, p_manager_pin);
  if v_manager is null then
    raise exception 'Reversing a cancellation always requires a valid manager PIN'
      using errcode = 'insufficient_privilege',
            hint = 'Hand the terminal to a manager. The reversal is recorded against them by name.';
  end if;

  -- =================== GUARD 8: THE AVAILABILITY GUARD =====================
  --
  --   ┌──────────────────────────────────────────────────────────────────────┐
  --   │  THE CRUX (§4.1). The room was freed by the cancellation and may be   │
  --   │  somebody else's now. This locks the room_types row and counts under  │
  --   │  the lock, exactly as create_booking does, for EVERY night — and      │
  --   │  RAISES, naming the full nights, rather than overbooking. Only if it  │
  --   │  returns normally does the status change below run.                   │
  --   └──────────────────────────────────────────────────────────────────────┘
  --
  perform assert_restorable_inventory(v_booking);

  -- --- THE EFFECT, all of it inside this one transaction (rule 11) ---------
  select p.timezone into v_timezone from properties p where p.id = v_booking.property_id;
  v_date := (now() at time zone coalesce(nullif(btrim(v_timezone), ''), 'Africa/Lagos'))::date;

  -- Status only. cancelled_at and cancellation_reason are KEPT as the permanent
  -- record of the cancellation that happened (§4.4), and no money moves (§4.3).
  --
  -- 'confirmed' rather than a remembered previous status: today nothing can
  -- create an 'enquiry' (create_booking inserts 'confirmed' — 015 §7), so the
  -- only status a cancel can be reversed FROM is a confirmed one and there is
  -- nothing to lose. If an enquiry path ever ships, THIS is the line that must
  -- learn to record and restore the prior status.
  update bookings
     set status     = 'confirmed',
         updated_by = v_actor
   where id = p_booking_id
  returning * into v_booking;

  begin
    insert into reversals (
      tenant_id, property_id, reversed_by, approved_by, reason,
      target_type, target_id, counter_entry_id, business_date,
      idempotency_key, created_by
    ) values (
      v_booking.tenant_id, v_booking.property_id, v_actor, v_manager, v_reason,
      -- No counter-entry: a cancellation posted nothing to undo (§4.3), and §1's
      -- constraint refuses a 'cancel' row that claims one.
      'cancel', p_booking_id, null, v_date,
      v_key, v_actor
    )
    returning * into v_reversal;
  exception
    when unique_violation then
      select * into v_existing
      from reversals
      where tenant_id = v_booking.tenant_id
        and (idempotency_key = v_key
             or (target_type = 'cancel' and target_id = p_booking_id))
      limit 1;
      if found then
        return v_existing;
      end if;
      raise;
  end;

  return v_reversal;
end;
$$;

comment on function reverse_cancel(uuid, text, text, text) is
  'Reverses a cancellation: restores the booking to CONFIRMED and writes a '
  'permanent reversals row. THE AVAILABILITY GUARD IS THE POINT — cancelling '
  'freed the room, so this locks the room_types row (SELECT ... FOR UPDATE) and '
  'counts availability under that lock for EVERY night, exactly as create_booking '
  'does, and REJECTS naming the nights that are full rather than overbooking. '
  'Nothing financial moves: a cancelled booking posted no charges, and any '
  'deposit on the folio stays where it is (refunding it is a separate decision). '
  'cancelled_at and cancellation_reason are kept — the cancellation happened, and '
  'the reversals row records its undoing. ALWAYS requires a manager PIN and a '
  'reason. Idempotent by key and by state under a FOR UPDATE lock; a booking '
  're-cancelled after being restored is REFUSED rather than falsely reported '
  'restored, because a cancellation is reversed once, ever.';


-- ############################################################################
-- SECTION 5 — mark_no_show gains one guard (a CORRECTNESS FIX)
-- ############################################################################
-- THE BUG THIS CLOSES, in figures — the booking-side twin of 031 §4 and 032 §6.
--
-- A company-guaranteed booking is no-showed: one night at ₦120,000 is posted
-- under the key 'noshow:<booking>'. A manager reverses the no-show: the booking
-- returns to 'confirmed' and a counter-charge of −₦120,000 nets the retention to
-- zero. Correct.
--
-- Now suppose the guest really does not come after all and the desk presses
-- "Mark no-show" again. The status moves back to 'no_show' — and POST_CHARGE
-- POSTS NOTHING, because 'noshow:<booking>' is deterministic and that key is
-- already spent (024's header: "one no-show charge per booking, forever", and
-- the key deliberately carries no date or attempt counter). The folio then holds
-- +120,000 and −120,000 and nets to zero, while the booking says no_show and the
-- hotel believes it has charged the retention. THE COMPANY IS NEVER BILLED, no
-- error is raised anywhere, and the only trace is a folio that reads as settled.
--
-- Re-posting under a fresh key is NOT the fix: it would put a second no-show
-- charge in reach of every double-click and would undo the "forever" guarantee
-- 024 built the deterministic key to give. So mark_no_show refuses instead, in
-- words that name the remedy — and the desk keeps both honest options (cancel
-- the booking, or post the retention charge by hand with its own reason and
-- approval trail).
--
-- EVERYTHING ELSE IN THIS FUNCTION IS BYTE-FOR-BYTE 024 §4 — same signature,
-- same lock, same staff gate, same idempotent-by-state return, same
-- confirmed-only rule, same property-local arrival-day guard, same guaranteed
-- test, same locked first-night rate, same 'room' category resolution, same
-- post_charge call with the same deterministic key. ONLY THE ONE GUARD IS NEW,
-- and it sits AFTER the already-no_show fast path so a plain retry still no-ops.
create or replace function mark_no_show(
  p_booking_id      uuid,
  p_idempotency_key text default null
)
returns bookings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking    bookings;
  v_actor      uuid := auth.uid();
  v_timezone   text;
  v_today      date;
  v_guaranteed boolean;
  v_folio_id   uuid;
  v_rate       numeric(14,2);
  v_category   uuid;
begin
  -- Lock the booking so a concurrent check-in and a no-show cannot interleave —
  -- the two are mutually exclusive readings of the same fact, and whichever
  -- commits first must be seen by the other.
  select * into v_booking
  from bookings
  where id = p_booking_id and deleted_at is null
  for update;

  if not found then
    raise exception 'Booking % not found', p_booking_id using errcode = 'no_data_found';
  end if;

  -- Staff gate: resolving an arrival is front-desk work, like taking a booking
  -- or checking a guest in. Same gate, same reasoning as 015 §7 / 016 §6.
  if not is_tenant_staff(v_booking.tenant_id) then
    raise exception 'Not authorised to update this booking'
      using errcode = 'insufficient_privilege';
  end if;

  -- Idempotent by state (guard 1 of 2). The charge, if any, was posted in the
  -- SAME transaction that set this status, so there is nothing left to do — and
  -- re-attempting the posting here would be wrong in the one case that matters:
  -- a no-show charge the manager deliberately VOIDED must not be resurrected by
  -- somebody pressing the button again.
  if v_booking.status = 'no_show' then
    return v_booking;
  end if;

  -- NEW (033 §5): a booking whose no-show has been REVERSED cannot be no-showed
  -- again. The retention charge's deterministic key is spent, so a second
  -- no-show would move the status and charge nothing — see this section's header
  -- for the ₦120,000 the company would never be billed.
  if exists (
    select 1 from reversals r
    where r.tenant_id = v_booking.tenant_id
      and r.target_type = 'no_show'
      and r.target_id = v_booking.id
  ) then
    raise exception
      'This booking''s no-show was reversed by a manager and it cannot be marked as a no-show again'
      using errcode = 'check_violation',
            hint = 'The retention charge can only be posted once per booking, and that posting has already been credited back. Cancel the booking instead, or post the retention charge on the folio by hand.';
  end if;

  -- Only a live reservation can no-show. A checked_in stay means the guest DID
  -- arrive (the opposite fact); a cancelled one was called off in advance, which
  -- is a different commercial event with a different policy.
  if v_booking.status <> 'confirmed' then
    raise exception 'Only a confirmed booking can be marked as a no-show (status is %)',
      v_booking.status using errcode = 'check_violation';
  end if;

  select p.timezone into v_timezone
  from properties p
  where p.id = v_booking.property_id;

  v_today := (now() at time zone
               coalesce(nullif(btrim(v_timezone), ''), 'Africa/Lagos'))::date;

  -- The arrival day must be OVER. Today's arrivals are still arrivals until
  -- midnight, property-local.
  if v_booking.check_in >= v_today then
    raise exception
      'This booking''s arrival date (%) has not passed yet at this property — a guest can still arrive today',
      v_booking.check_in using errcode = 'check_violation';
  end if;

  update bookings
    set status     = 'no_show',
        updated_by = v_actor
  where id = p_booking_id
  returning * into v_booking;

  -- LOCKSTEP (rule 7): the status change and the charge below happen in ONE
  -- transaction. If the posting fails — no locked rate, no 'room' category, a
  -- folio somebody already closed — the status change rolls back with it, so the
  -- system never ends up with a booking marked no_show whose guaranteed charge
  -- silently did not post. The desk sees the error and can fix the cause.

  -- ================== THE CHARGE RULE (024 §4's header) =====================
  v_guaranteed := (v_booking.company_id is not null or v_booking.bill_to = 'company');

  if not v_guaranteed then
    -- A walk-in committed nothing and owes nothing. No charge, no zero-line.
    return v_booking;
  end if;

  select f.id into v_folio_id from folios f where f.booking_id = p_booking_id;
  if v_folio_id is null then
    raise exception 'Booking % has no folio', p_booking_id using errcode = 'no_data_found';
  end if;

  -- The rate LOCKED at booking time for the RESERVED first night (015 §5).
  select bn.rate into v_rate
  from booking_nights bn
  where bn.booking_id = p_booking_id
    and bn.stay_date  = v_booking.check_in;

  if v_rate is null then
    raise exception 'Booking % has no locked rate for its first night (%)',
      p_booking_id, v_booking.check_in using errcode = 'no_data_found';
  end if;

  -- The tenant's own 'room' category, resolved by CODE — never a hardcoded id
  -- and never a literal account code (rules 4 and 17).
  select cc.id into v_category
  from charge_categories cc
  where cc.tenant_id = v_booking.tenant_id
    and cc.code = 'room'
    and cc.deleted_at is null
    and cc.is_active = true;

  if v_category is null then
    raise exception 'This tenant has no active ''room'' charge category'
      using errcode = 'no_data_found';
  end if;

  -- post_charge is THE posting primitive (021 §9.1) and is called unchanged. The
  -- business date is the RESERVED first night — the night that was held and not
  -- slept — not today, so the revenue lands on the operating day it belongs to
  -- (rule 12). p_idempotency_key is deterministic: one no-show charge per
  -- booking, forever. A caller-supplied key is deliberately NOT honoured for
  -- this posting — allowing one would let two different keys post two no-show
  -- charges for the same booking, which is precisely what must be impossible.
  perform post_charge(
    v_folio_id,
    v_category,
    'No-show charge (guaranteed booking) — one night',
    1,
    v_rate,
    v_booking.check_in,
    'noshow:' || p_booking_id::text,
    'no_show'
  );

  return v_booking;
end;
$$;

comment on function mark_no_show(uuid, text) is
  'Marks a confirmed booking whose reserved arrival date has PASSED (property-'
  'local) as no_show, and posts the no-show charge in the SAME transaction. THE '
  'CHARGE RULE: a GUARANTEED booking (company_id set OR bill_to = ''company'') '
  'is charged ONE night at the rate LOCKED in booking_nights for its reserved '
  'first night, via post_charge against the tenant''s ''room'' category; an '
  'unguaranteed walk-in is charged NOTHING. Staff-gated. Idempotent twice over: '
  'by state on the status, and by the deterministic ''noshow:<booking>'' key on '
  'the charge, so it can never double-charge. REFUSES a booking whose no-show was '
  'REVERSED (033 §5): that key is spent, so a second no-show would move the status '
  'and charge nothing, and the hotel would believe it had billed a night it had '
  'not. NEVER called by the night audit directly — 029''s auto-resolve pass is the '
  'only server-side path, because a 02:00 arrival is not a no-show.';


-- ############################################################################
-- SECTION 6 — Row-Level Security
-- ############################################################################
-- NOTHING TO ADD, AND THAT IS THE POINT. No new table: the audit row is a
-- reversals row (member SELECT, no write policy — 031 §5) and the status lives on
-- bookings, which has member SELECT and NO insert/update/delete policy for anyone
-- (015 §9) precisely so every status change goes through a SECURITY DEFINER RPC
-- where the overbooking guard cannot be bypassed. This migration adds two such
-- RPCs and no new door.
--
-- Stated explicitly, as 015 §9, 021 §11, 031 §5 and 032 §8 do, so the absence is
-- deliberate and visible rather than merely unwritten: DO NOT ADD AN UPDATE
-- POLICY TO bookings, AND DO NOT ADD A WRITE POLICY TO reversals. A client that
-- could set status = 'confirmed' could re-take a sold room with no lock, no
-- count, no PIN and no audit row — which is every guard in this file at once.


-- ############################################################################
-- SECTION 7 — Function grants
-- ############################################################################
-- SECURITY DEFINER defaults to EXECUTE for PUBLIC. Revoke on every function and
-- grant only authenticated staff — never anon.

-- assert_restorable_inventory is granted to NOBODY, exactly as verify_manager_pin
-- (021 §12) and post_charge_reversal (032 §9) are. It takes a whole bookings row
-- as its argument, so a client that could call it could hand it a fabricated
-- booking and learn — or lock — whatever it liked. Its only callers are the two
-- RPCs below, which read that row from the table themselves, under a lock.
revoke execute on function assert_restorable_inventory(bookings) from public;
revoke execute on function assert_restorable_inventory(bookings) from anon;
revoke execute on function assert_restorable_inventory(bookings) from authenticated;

-- The two reversals are FRONT-DESK acts performed by a person with a manager
-- beside them. The service role is REVOKED EXPLICITLY, the same way 024 §5
-- revokes mark_no_show, and with the same honest caveat: this is a guard against
-- ACCIDENT, not a security boundary (the service role has BYPASSRLS and could
-- update bookings directly whatever this says). What it buys is that a future
-- server-side job cannot reach the restore DECISION — which re-takes inventory
-- and un-bills money — by simply calling the obvious RPC.
revoke execute on function reverse_no_show(uuid, text, text, text) from public;
revoke execute on function reverse_no_show(uuid, text, text, text) from anon;
revoke execute on function reverse_no_show(uuid, text, text, text) from service_role;
grant  execute on function reverse_no_show(uuid, text, text, text) to authenticated;

revoke execute on function reverse_cancel(uuid, text, text, text) from public;
revoke execute on function reverse_cancel(uuid, text, text, text) from anon;
revoke execute on function reverse_cancel(uuid, text, text, text) from service_role;
grant  execute on function reverse_cancel(uuid, text, text, text) to authenticated;

-- Re-stated for the re-created mark_no_show: CREATE OR REPLACE preserves the
-- existing grants (including 024 §5's service_role revoke), but stating them
-- keeps this file readable on its own.
revoke execute on function mark_no_show(uuid, text) from public;
revoke execute on function mark_no_show(uuid, text) from anon;
revoke execute on function mark_no_show(uuid, text) from service_role;
grant  execute on function mark_no_show(uuid, text) to authenticated;

-- ============================================================================
-- End of 033_reversals_bookings.sql
-- ============================================================================
