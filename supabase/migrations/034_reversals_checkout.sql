-- ============================================================================
-- 034_reversals_checkout.sql
-- Palstro-Hotels: THE REVERSAL SUBSYSTEM, PART 4 (FINAL) — checkout.
--
-- ----------------------------------------------------------------------------
--  ┌────────────────────────────────────────────────────────────────────────┐
--  │  REVERSING A CHECKOUT MEANS "THE GUEST HAS NOT ACTUALLY LEFT" —        │
--  │  NOT "ERASE WHAT THEY OWE". The stay REOPENS (checked_out ->           │
--  │  checked_in, folio back to open); THE ROOM CHARGES STAY, because       │
--  │  those nights were genuinely slept. Un-charging a night is a           │
--  │  different act with its own audit trail: reverse_charge (032).         │
--  └────────────────────────────────────────────────────────────────────────┘
-- ----------------------------------------------------------------------------
--
-- WHAT IS INHERITED FROM PARTS 1–3, WITHOUT ALTERATION
-- ----------------------------------------------------
--   * the `reversals` audit table (031 §1) — its target_type list already
--     declares 'checkout', which is exactly why this part adds an RPC and not a
--     migration that alters that constraint;
--   * reversals_target_uniq — ONE reversal per (tenant, target_type, target),
--     EVER. §2.3 shows what that means for a stay reopened and re-checked-out,
--     and it is the subtlest thing in this file;
--   * member-read / no-write RLS on reversals (031 §5) — the row is evidence,
--     and the only write path is a SECURITY DEFINER RPC that verified a PIN;
--   * verify_manager_pin (021 §7.2), and the rule that a reversal ALWAYS needs a
--     PIN with no threshold (031 §3.2);
--   * the guard order of 031 §3.1, applied to a booking exactly as 033 applied
--     it: lock -> staff/property gate -> idempotency by key -> idempotency by
--     state -> the state test -> reason -> PIN.
--
-- WHAT THIS MIGRATION DOES *NOT* TOUCH, deliberately, and it must stay that way:
--   folio_totals, folio_balance, folio_charge_tax, the 022 read views, the
--   027/028 guest_stays / guest_ledger FIFO views, post_charge,
--   post_charge_reversal, post_room_night_charge, record_payment, count_available,
--   assert_restorable_inventory, reverse_payment, reverse_charge,
--   reverse_discount, reverse_no_show, reverse_cancel, void_charge, void_payment,
--   apply_charge_discount, create_booking, cancel_booking, mark_no_show,
--   check_in_booking, CHECK_OUT_BOOKING, run_night_audit and every pricing path
--   are BYTE-FOR-BYTE as 015–033 left them.
--
--   THERE IS NO "ONE EXCEPTION" THIS TIME. Parts 1, 2 and 3 each had to re-create
--   one function to close a hole the new reversal opened (void_payment,
--   void_charge / apply_charge_discount, mark_no_show). Part 4 opens none, and
--   §2.4 is the proof: check_out_booking run again on a reopened stay posts
--   nothing twice and corrupts nothing, because every night it touches carries
--   the deterministic 'room:<booking>:<date>' key it has always carried. The
--   re-checkout is not a hole to be plugged — IT IS THE INTENDED NEXT STEP.
--
-- ----------------------------------------------------------------------------
-- THE FOUR FINDINGS THIS FILE IS BUILT ON — each verified against the shipped
-- code, not assumed. They are stated up front because they are the whole reason
-- this migration is short.
-- ----------------------------------------------------------------------------
--
-- FINDING 1 — NO ROOM-CONFLICT RISK. NO AVAILABILITY GUARD IS NEEDED, and adding
-- one would be wrong. count_available's occupancy predicate (029 §2, byte-for-
-- byte 015 §6) is:
--
--     b.status in ('confirmed','checked_in','checked_out')
--     or (p_count_no_show and b.status = 'no_show')
--
-- 'checked_in' and 'checked_out' are BOTH in the same IN-list, so they are
-- treated IDENTICALLY for occupancy — a checked_out booking holds its room for
-- its whole span exactly as a checked_in one does. The transition this RPC
-- performs is checked_out -> checked_in, i.e. one member of that list to another,
-- so v_booked is unchanged for every night and every room type. THE OCCUPANCY IS
-- BIT-FOR-BIT THE SAME BEFORE AND AFTER. Nothing is freed by a checkout and
-- nothing is re-taken by reversing one.
--
-- That is the exact ASYMMETRY with part 3, and it is why assert_restorable_
-- inventory is not called here: a cancel genuinely FREED the room ('cancelled' is
-- not in the list) and a no-show genuinely freed it too (029 flipped
-- p_count_no_show's default to false), so both of those restores could overbook
-- and had to be gated. This one cannot. Calling the guard anyway would not be
-- harmless caution — it would REFUSE legitimate reversals: the guard counts
-- availability EXCLUDING this booking, so a sold-out night on which this very
-- guest is the last room would report 0 free and block the desk from correcting a
-- premature checkout on a full house, which is precisely the night it is most
-- likely to happen.
--
-- FINDING 2 — CHECKOUT NEVER CLOSED THE FOLIO, SO THERE IS NOTHING TO REOPEN
-- TODAY. Verified twice over: 026 §1 says in terms "it does not settle the folio,
-- does not close it, and does not require a zero balance", and there is not a
-- single `update folios` statement anywhere in migrations 001–033 — no
-- settle_folio, no close_folio, no path of any kind that moves a folio off
-- 'open'. The 'settled' and 'closed' values exist in folios_status_check (021 §4)
-- and every posting RPC refuses them, but nothing can currently produce them.
-- So the reopen below is a NO-OP on every folio that exists today. It is written
-- anyway, and it is not dead weight: the day a settle/close transition ships, THE
-- REOPEN MUST ALREADY BE PART OF THIS ACT or a reversed checkout would leave a
-- reopened stay whose bill silently refuses new charges — the guest is back in
-- the room and the desk cannot post their breakfast. It is also what makes
-- reverse_no_show's hint honest: that RPC refuses a non-open folio and says
-- "re-open the folio first — a decision with its own audit trail". THIS IS THAT
-- DECISION, and it carries that trail.
--
-- FINDING 3 — REVERSE THEN RE-CHECKOUT IS SAFE. THE KEY CORRECTNESS POINT, and
-- §2.4 walks it in full.
--
-- FINDING 4 — counter_entry_id NULL IS ALREADY LEGAL FOR 'checkout', and §1 now
-- makes it MANDATORY. The per-type constraints as they stand are:
--     031 §1  reversals_payment_counter_check    payment  -> NOT NULL
--     032 §1.2 reversals_charge_counter_check    charge, discount -> NOT NULL
--     033 §1  reversals_cancel_no_counter_check  cancel   -> NULL
-- 'checkout' appears in none of them, so a NULL passes today with no adjustment
-- needed anywhere. §1 adds the positive form rather than relying on that silence.
-- ============================================================================


-- ############################################################################
-- SECTION 1 — the last per-type constraint on the audit table
-- ############################################################################
-- Same pattern, one final time, and in the same direction 033 §1 used for
-- 'cancel': a type that can NEVER carry a counter-entry.
--
--   'checkout' — reverses a STATE and posts nothing. The whole decision of this
--                migration is that the room charges STAY, so there is no money to
--                undo and nothing for a counter-entry to be. A 'checkout' row
--                carrying one would be describing a posting that did not happen —
--                and worse, it would be the only trace of a reversal that HAD
--                touched the money, which is the one thing a reader of this table
--                must never have to guess about.
--
-- Added as its OWN constraint, never by dropping and re-creating 031's, so each
-- part's rule stays independently readable and independently droppable.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'reversals_checkout_no_counter_check'
  ) then
    alter table reversals
      add constraint reversals_checkout_no_counter_check
      check (target_type <> 'checkout' or counter_entry_id is null);
  end if;
end;
$$;

comment on constraint reversals_checkout_no_counter_check on reversals is
  'A ''checkout'' reversal reopens a stay and moves NO money — the nights were '
  'slept and their charges stay — so it can never name a counter-entry. The '
  'audit row IS the record of the act. Removing a specific charge is a separate '
  'reverse_charge with its own row (032).';


-- ############################################################################
-- SECTION 2 — reverse_checkout
-- ############################################################################
--
-- WHAT IT UNDOES. check_out_booking (026 §1) did three things in ONE
-- transaction: it posted every unbilled room night in
-- [greatest(coalesce(actual_check_in, check_in), check_in), check_out), it set
-- status = 'checked_out', and it returned the bill's state to the desk. It did
-- NOT touch the folio's status (FINDING 2), did NOT clear the arrival columns,
-- and did NOT write a departure timestamp — bookings has no checked_out_at
-- column, so 'checked_out' IS the entire record of the departure.
--
-- Reversing it says: THE GUEST HAS NOT ACTUALLY LEFT. A premature checkout at
-- 09:00 for a guest who is still at breakfast and staying another night; a
-- checkout keyed on the wrong booking of a group; a departure recorded and then
-- reversed by the guest themselves at the desk.
--
-- 2.1 THE GUARD ORDER, AND WHY IT IS THIS ORDER (031 §3.1, as 033 applied it)
-- ---------------------------------------------------------------------------
--   1. RESOLVE AND LOCK the booking (`select ... for update`). FIRST, because it
--      is what makes every check below atomic: a concurrent reversal and a
--      concurrent re-checkout serialise here (check_out_booking takes the same
--      lock on the same row, 026 §1), and the loser sees the winner's committed
--      work rather than racing it.
--   2. STAFF GATE, then the caller's own PROPERTY GRANT (rule 19's two layers).
--   3. IDEMPOTENCY BY KEY — a replay of the same intent returns the first
--      outcome, BEFORE the PIN check, so a retry after a network drop does not
--      send the desk to fetch a manager for an approval that already happened.
--      It branches on the CURRENT STATUS; §2.3 is the whole of why.
--   4. IDEMPOTENCY BY STATE — already reversed? The stronger guard: it catches a
--      retry arriving with a DIFFERENT key, and (holding the guard 1 lock) it is
--      what makes "a checkout is reversed at most once" true under concurrency
--      rather than merely likely. Same status branch.
--   5. THE BOOKING MUST CURRENTLY BE 'checked_out'. Anything else is not a
--      checkout to reverse — and the message names the status it found, because
--      "cannot reverse" without the current state sends the desk to guess.
--   6. REASON NON-EMPTY, in the RPC and not only the UI (rule 19), and in the
--      reversals column CHECK besides.
--   7. MANAGER PIN, ALWAYS. No threshold (031 §3.2). Last of the guards, so a
--      call that was going to be rejected anyway never consumes a PIN entry.
--
-- THERE IS NO GUARD 8. Parts 3's eighth guard was the availability re-check;
-- FINDING 1 is the proof that this act needs none, and it is stated in the code
-- at the point where the reader will look for it.
--
-- 2.2 THE EFFECT, AND THE ONE THING IT DELIBERATELY DOES NOT DO
-- -------------------------------------------------------------
--   * STATUS: 'checked_out' -> 'checked_in'. Straight back, unlike part 3's
--     restore-to-'confirmed' — and the reason is the exact inverse of DECISION 1
--     there. 033 refused to go to checked_in because CHECKING IN CAPTURES AN
--     ARRIVAL INSTANT that nothing else may invent. Here the arrival instant
--     ALREADY EXISTS: checked_in_at and actual_check_in were written by
--     check_in_booking when the guest genuinely arrived, and check_out_booking
--     never cleared them. So 'checked_in' is not a state being invented, it is
--     the state the booking was in five minutes ago, with its original arrival
--     facts intact. Nothing is guessed and nothing is re-derived.
--   * THE ARRIVAL COLUMNS ARE NOT TOUCHED, for that same reason: they are still
--     true. Re-writing them would re-date the guest's arrival to today and move
--     every night the audit bills (024 §3's charge_from reads actual_check_in),
--     silently re-pricing a stay that was only ever meant to be reopened.
--   * THE FOLIO IS REOPENED IF, AND ONLY IF, IT IS NOT ALREADY OPEN. FINDING 2:
--     a no-op today, mandatory the day a settle/close transition exists. closed_at
--     is cleared with it — a folio that is open and still carries a closing
--     timestamp is a row that contradicts itself.
--   * THE ROOM CHARGES STAY. Not reversed, not voided, not touched in any way.
--     Stated as loudly in the code as in this header, because it is the decision
--     the whole feature turns on.
--   * NO PAYMENT MOVES EITHER. A guest who settled and is now staying another
--     night has paid what they paid; the balance simply reads against a folio
--     that is open again, and tonight's audit adds the next night to it.
--
-- 2.3 A STAY REOPENED, THEN CHECKED OUT AGAIN — THE SUBTLE CASE (033 §4.2's twin)
-- ------------------------------------------------------------------------------
-- reversals_target_uniq (031 §1) allows exactly ONE 'checkout' reversal per
-- booking, ever. That makes a plain "already reversed -> return that reversal"
-- check WRONG in the sequence this feature is EXPECTED to produce:
--
--     check out -> reverse_checkout (reopened) -> check out again -> reverse?
--
-- The second reversal call would find the first row and return it, reporting
-- SUCCESS while the guest sits checked_out — the desk would believe a departed
-- stay had been reopened, post charges into a bill nobody is adding to, and find
-- out at the next handover. So both idempotency checks branch on CURRENT STATUS:
--
--     found + booking NOT checked_out -> a genuine retry. Return the first row.
--     found + booking IS checked_out  -> re-checked-out since. REFUSE, in words
--                                        that say exactly that.
--
-- AND NOTE THE DIFFERENCE FROM PART 3 IN HOW LIKELY THIS IS. Re-cancelling a
-- restored booking is unusual; RE-CHECKING-OUT A REOPENED STAY IS THE NORMAL,
-- INTENDED ENDING — the guest stays their extra night and leaves the next
-- morning. So this branch is not an edge case defended against, it is the
-- ordinary end of the story, and the only thing it costs is that the SECOND
-- checkout cannot be reversed. That is the price of "an act is reversed once,
-- ever", it is the same price parts 1–3 pay, and the honest sentence below is
-- worth more than a second reversal would be. The remedies are real ones: the
-- desk can check the guest in again through the ordinary flow if they are back,
-- or take a fresh booking.
--
-- 2.4 REVERSE THEN RE-CHECKOUT: WHY NO NIGHT IS EVER POSTED TWICE (FINDING 3)
-- ---------------------------------------------------------------------------
-- This is the correctness point the whole part turns on, and it is settled by
-- reading check_out_booking (026 §1) rather than by adding anything here.
--
-- After this RPC commits, the booking is 'checked_in', so a second
-- check_out_booking call takes the normal path (v_replay is false — it is
-- computed as `status = 'checked_out'`) and walks THE SAME NIGHT RANGE it walked
-- the first time: [greatest(coalesce(actual_check_in, check_in), check_in),
-- check_out). The range is identical because none of its three inputs changed —
-- the arrival columns were not touched (§2.2) and check_out is not touched by
-- anything in this file.
--
-- For each night it calls post_room_night_charge(booking, date), which builds the
-- DETERMINISTIC key 'room:<booking>:<date>' and hands it to post_charge. And
-- post_charge's FIRST substantive step, before the folio-status check, before the
-- category check, before any insert, is:
--
--     if p_idempotency_key is not null then
--       select * into v_existing from folio_charges
--       where tenant_id = v_tenant and idempotency_key = p_idempotency_key;
--       if found then return v_existing; end if;   -- 021 §9.1, verbatim
--     end if;
--
-- So EVERY night already on the bill returns its existing row and posts nothing.
-- Walk the three cases a reopened stay can present:
--
--   * A NIGHT ALREADY POSTED (by the first checkout or by the audit) -> the key
--     lookup finds it, the existing row comes back, no write. check_out_booking
--     counts it as nights_already_posted. The folio is unchanged.
--   * A NIGHT WHOSE CHARGE WAS VOIDED -> the key still exists (a void sets a flag,
--     it never deletes — rule 5), so the voided row comes back and posting is
--     still skipped. Correct: re-posting would silently undo a person's decision.
--     026 counts it in nights_already_voided so it is VISIBLE rather than lost.
--   * A NIGHT WHOSE CHARGE WAS REVERSED by a manager (032) -> the ORIGINAL row
--     still carries the key, so it is returned and nothing is posted; the
--     counter-entry carries its own 'reversal:charge:<id>' key and is irrelevant
--     to this lookup. Both lines stay on the bill and net to zero, which is
--     exactly what the reversal decided.
--
-- AND THE GENUINELY NEW NIGHTS DO POST. A guest whose stay is extended before the
-- re-checkout (check_out moved from the 5th to the 7th) has nights 5 and 6 with
-- no key yet: they post normally, at the rate locked in booking_nights, through
-- the same path the audit uses. That is not a side effect to tolerate — it is the
-- reopened stay being billed correctly for the nights it actually gained.
--
-- ONE MORE INTERACTION, CHECKED: THE NIGHT AUDIT. run_night_audit's in-house set
-- is `status in ('checked_in','checked_out')` (023/029), so it was already
-- charging this booking's nights while it sat checked_out. Reopening it to
-- checked_in changes nothing about whether the audit sees it, only which of two
-- statuses it reports — so a reopened stay keeps being billed nightly exactly as
-- before, with no gap and no double-post (same deterministic key).
--
-- 2.5 THE TRANSACTION BOUNDARY
-- ----------------------------
-- One function call is one transaction (rule 11). The status change, the folio
-- reopen and the audit row commit together or not at all, so there is no state in
-- which a stay is reopened without its evidence, or a folio is reopened for a
-- booking that stayed checked_out. Rule 7's lockstep is genuinely exercised here:
-- two data stores move, and they move in one statement each inside one
-- transaction. There is NO cache and NO denormalised column to keep in step —
-- the balance is computed live (rule 6) and occupancy is computed live from
-- status (FINDING 1) — so the count is: ledger 0, status 1, folio 1, cache 0.

create or replace function reverse_checkout(
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
  v_folio    folios;
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
  -- FOR UPDATE before anything else. check_out_booking locks the same row the
  -- same way (026 §1), so a reversal and a re-checkout racing each other
  -- serialise here instead of interleaving.
  select * into v_booking
  from bookings
  where id = p_booking_id and deleted_at is null      -- rule 5
  for update;

  if not found then
    raise exception 'Booking % not found', p_booking_id using errcode = 'no_data_found';
  end if;

  -- --- GUARD 2: staff gate, then this caller's own property grant -----------
  if not is_tenant_staff(v_booking.tenant_id) then
    raise exception 'Not authorised to reverse a checkout for this tenant'
      using errcode = 'insufficient_privilege';
  end if;
  if not (v_booking.property_id = any(get_property_ids())) then
    raise exception 'You do not have access to this property'
      using errcode = 'insufficient_privilege';
  end if;

  v_key := coalesce(
    nullif(btrim(p_idempotency_key), ''),
    'reversal:checkout:' || p_booking_id::text
  );

  -- --- GUARD 3: idempotency BY KEY (rules 2 & 3) ---------------------------
  -- Before the PIN check on purpose: a retried intent returns the first outcome
  -- without demanding the manager come back to the terminal.
  select * into v_existing
  from reversals
  where tenant_id = v_booking.tenant_id and idempotency_key = v_key
  limit 1;
  if found then
    -- §2.3: a stay that is checked_out AGAIN was re-checked-out after being
    -- reopened — the ordinary, intended ending. Returning the old row would
    -- report success on a guest who has departed.
    if v_booking.status = 'checked_out' then
      raise exception
        'This stay''s checkout has already been reversed once, and the guest has been checked out again since'
        using errcode = 'check_violation',
              hint = 'A checkout is reversed once, ever, so this one cannot be reopened a second time. If the guest is still here, check them in again; otherwise take a new booking.';
    end if;
    return v_existing;
  end if;

  -- --- GUARD 4: idempotency BY STATE — already reversed? -------------------
  -- The stronger of the two: it catches a retry arriving with a DIFFERENT key,
  -- and (holding the guard 1 lock) it is what makes "a checkout is reversed at
  -- most once" true under concurrency. The DB backs it with reversals_target_uniq.
  select * into v_existing
  from reversals
  where tenant_id = v_booking.tenant_id
    and target_type = 'checkout'
    and target_id = p_booking_id
  limit 1;
  if found then
    if v_booking.status = 'checked_out' then
      raise exception
        'This stay''s checkout has already been reversed once, and the guest has been checked out again since'
        using errcode = 'check_violation',
              hint = 'A checkout is reversed once, ever, so this one cannot be reopened a second time. If the guest is still here, check them in again; otherwise take a new booking.';
    end if;
    return v_existing;
  end if;

  -- --- GUARD 5: it must BE checked out -------------------------------------
  if v_booking.status <> 'checked_out' then
    raise exception
      'Only a checked-out stay can have its checkout reversed (this booking is %)',
      v_booking.status using errcode = 'check_violation';
  end if;

  -- --- GUARD 6: the reason is mandatory HERE, not only in the UI (rule 19) --
  v_reason := btrim(coalesce(p_reason, ''));
  if v_reason = '' then
    raise exception 'A reversal needs a reason' using errcode = 'check_violation';
  end if;

  -- --- GUARD 7: A MANAGER PIN. ALWAYS. NO THRESHOLD. -----------------------
  -- 031 §3.2's reasoning on a status: reopening a stay puts a settled bill back
  -- in play and returns a departed guest to the in-house list. There is no
  -- version of that which is routine and no property setting that can make it so.
  v_manager := verify_manager_pin(v_booking.tenant_id, p_manager_pin);
  if v_manager is null then
    raise exception 'Reversing a checkout always requires a valid manager PIN'
      using errcode = 'insufficient_privilege',
            hint = 'Hand the terminal to a manager. The reversal is recorded against them by name.';
  end if;

  -- ==========================================================================
  -- THERE IS NO AVAILABILITY GUARD HERE, AND THAT IS A FINDING, NOT AN OMISSION
  -- ==========================================================================
  -- count_available counts 'confirmed', 'checked_in' AND 'checked_out' as
  -- occupying (029 §2 / 015 §6). This transition moves the booking from one
  -- member of that list to another, so occupancy is UNCHANGED for every night of
  -- the span: nothing was freed by the checkout and nothing is re-taken by
  -- reversing it. assert_restorable_inventory (033 §2) is therefore NOT called —
  -- see FINDING 1 in the header for why calling it anyway would actively refuse
  -- legitimate reversals on a full house. If count_available's predicate is ever
  -- changed so that 'checked_out' stops occupying, THIS is the comment that must
  -- become a guard.

  -- --- THE EFFECT, all of it inside this one transaction (§2.5) ------------

  -- The business date (rules 8, 12), resolved in the PROPERTY's timezone exactly
  -- as check_out_booking's postings, record_payment and the other reversals do.
  -- It is the date the REVERSAL happens, never the original checkout's date.
  select p.timezone into v_timezone from properties p where p.id = v_booking.property_id;
  v_date := (now() at time zone coalesce(nullif(btrim(v_timezone), ''), 'Africa/Lagos'))::date;

  -- THE STATUS. Straight back to 'checked_in' — the state it left five minutes
  -- ago, with its original arrival intact. checked_in_at and actual_check_in are
  -- NOT touched (§2.2): they record an arrival that genuinely happened, and
  -- re-stamping them would silently re-price the stay by moving the date the
  -- night audit charges from (024 §3).
  update bookings
     set status     = 'checked_in',
         updated_by = v_actor
   where id = p_booking_id
  returning * into v_booking;

  -- ==========================================================================
  -- THE ROOM CHARGES STAY. THIS IS THE DECISION, AND THERE IS NO CODE FOR IT.
  -- ==========================================================================
  -- Nothing below reverses, voids, deletes or edits a folio_charges row, and
  -- nothing may be added here that does. The nights this stay was billed for were
  -- SLEPT; reopening the stay says the guest has not left, not that they never
  -- stayed. If one specific charge genuinely has to come off — a night billed in
  -- error, a rate dispute — that is reverse_charge (032 §3): its own manager PIN,
  -- its own reason, its own counter-entry and its own permanent audit row, taken
  -- deliberately on the folio rather than smuggled inside a status change.
  -- Payments are untouched for the same reason (§2.2).

  -- THE FOLIO. Reopened only if it is not already open (FINDING 2: nothing in
  -- 001–033 can currently close one, so this is a no-op today and mandatory the
  -- day a settle/close transition ships — a reopened stay whose bill refuses the
  -- guest's breakfast is the failure it prevents).
  --
  -- LOCKED FOR UPDATE: this is the only writer of folios.status in the schema,
  -- and the lock order booking -> folio is uncontested (no path anywhere takes
  -- them the other way round), so there is no cycle to deadlock on. The folio is
  -- found by booking_id, which folios_booking_unique makes at most one row.
  --
  -- The update is recorded in change_log by the folios log_field_changes trigger
  -- (021 §4), so "who reopened this bill, and when" is answerable from the row's
  -- own history as well as from the reversals row below.
  select * into v_folio
  from folios
  where booking_id = p_booking_id
  for update;

  if found and v_folio.status <> 'open' then
    update folios
       set status     = 'open',
           -- A folio that is open and still carries a closing timestamp is a row
           -- that contradicts itself.
           closed_at  = null,
           updated_by = v_actor
     where id = v_folio.id;
  end if;

  -- THE AUDIT ROW. THE ONLY RECORD OF THIS ACT — there is no counter-entry to
  -- point at, because no money moved (§1), and the booking carries no "was
  -- reopened" column by design (rule 6: a reversal is a fact about an ACT, and it
  -- lives in the table no client can write and nothing can edit).
  begin
    insert into reversals (
      tenant_id, property_id, reversed_by, approved_by, reason,
      target_type, target_id, counter_entry_id, business_date,
      idempotency_key, created_by
    ) values (
      v_booking.tenant_id, v_booking.property_id, v_actor, v_manager, v_reason,
      -- target_id is THE BOOKING: a checkout has no id of its own — it is a
      -- status ON the booking (031 §1: the target is polymorphic).
      'checkout', p_booking_id, null, v_date,
      v_key, v_actor
    )
    returning * into v_reversal;
  exception
    when unique_violation then
      -- A concurrent caller won a race the guard 1 lock should already have
      -- prevented. Return THEIR row — but only if it genuinely exists: re-raising
      -- otherwise aborts the whole call, rolling the status change and the folio
      -- reopen back with it, so this handler can never leave a reopened stay
      -- without its audit row.
      select * into v_existing
      from reversals
      where tenant_id = v_booking.tenant_id
        and (idempotency_key = v_key
             or (target_type = 'checkout' and target_id = p_booking_id))
      limit 1;
      if found then
        return v_existing;
      end if;
      raise;
  end;

  return v_reversal;
end;
$$;

comment on function reverse_checkout(uuid, text, text, text) is
  'Reverses a checkout: the stay REOPENS — status checked_out -> checked_in and '
  'the folio back to ''open'' if anything had closed it — and THE ROOM CHARGES '
  'STAY, because those nights were slept (removing one is a separate '
  'reverse_charge with its own audit trail). The arrival columns are untouched: '
  'checked_in_at / actual_check_in still record the real arrival, so nothing is '
  're-priced. NO AVAILABILITY GUARD, and that is verified rather than assumed: '
  'count_available treats checked_in and checked_out IDENTICALLY (both occupy), '
  'so this transition frees and re-takes nothing — unlike un-cancel and '
  'un-no-show, which restore from a status that had released the room. Writes a '
  'permanent reversals row with counter_entry_id NULL (no money moved). ALWAYS '
  'requires a valid manager PIN and a non-empty reason, both enforced here and '
  'not only in the UI (rule 19). Idempotent by key AND by state under a FOR '
  'UPDATE lock; a stay checked out AGAIN after being reopened is REFUSED rather '
  'than falsely reported reopened, because a checkout is reversed once, ever. '
  'check_out_booking may then be run again on the reopened stay: every night it '
  'touches carries the deterministic room:<booking>:<date> key, so already-posted '
  'nights no-op and only genuinely new nights post.';


-- ############################################################################
-- SECTION 3 — Row-Level Security
-- ############################################################################
-- NOTHING TO ADD, AND THAT IS THE POINT — the same statement 033 §6 makes, for
-- the same reasons, and it now covers one more writer of two existing tables.
--
--   * the audit row is a reversals row: member SELECT, NO write policy for
--     anyone (031 §5). The only path to one is a SECURITY DEFINER RPC that
--     verified a manager's PIN first.
--   * the status lives on bookings, which has member SELECT and NO
--     insert/update/delete policy (015 §9), precisely so every transition goes
--     through an RPC where the guards cannot be bypassed.
--   * the folio status lives on folios, which likewise has NO write policy
--     (021 §11) — which is why reopening one has to be an RPC and why this is
--     the only function in the schema that writes folios.status at all.
--
-- Stated explicitly, as 015 §9, 021 §11, 031 §5, 032 §8 and 033 §6 do, so the
-- absence is deliberate and visible rather than merely unwritten: DO NOT ADD AN
-- UPDATE POLICY TO bookings OR folios, AND DO NOT ADD A WRITE POLICY TO
-- reversals. A client that could set status = 'checked_in' could reopen a
-- departed stay with no PIN, no reason and no audit row; a client that could set
-- folios.status could re-open a closed bill the same way.


-- ############################################################################
-- SECTION 4 — Function grants
-- ############################################################################
-- SECURITY DEFINER defaults to EXECUTE for PUBLIC. Revoke, then grant only
-- authenticated staff — never anon.
--
-- The service role is REVOKED EXPLICITLY, exactly as 033 §7 does for the other
-- two status reversals, and with the same honest caveat: this is a guard against
-- ACCIDENT, not a security boundary (the service role has BYPASSRLS and could
-- update bookings directly whatever this says). What it buys is that a future
-- unattended job — a night audit pass, a cleanup script — cannot reach the
-- decision to reopen a departed stay by calling the obvious RPC. Reopening a stay
-- is a person's judgement made with a manager standing beside them.
revoke execute on function reverse_checkout(uuid, text, text, text) from public;
revoke execute on function reverse_checkout(uuid, text, text, text) from anon;
revoke execute on function reverse_checkout(uuid, text, text, text) from service_role;
grant  execute on function reverse_checkout(uuid, text, text, text) to authenticated;

-- ============================================================================
-- End of 034_reversals_checkout.sql
--
-- THE REVERSAL SUBSYSTEM IS COMPLETE: payments (031), charges and discounts
-- (032), no-shows and cancellations (033), checkouts (034). Every one of them
-- goes through the same shape — lock, gate, idempotency by key then by state,
-- the state test, a mandatory reason, a manager's PIN with no threshold — and
-- leaves the same permanent, unwritable, uneditable audit row behind.
-- ============================================================================
