-- ============================================================================
-- 029_auto_resolve_uncollected_bookings.sql
-- Palstro-Hotels: THE NIGHT AUDIT NOW FREES ROOMS FROM UNCOLLECTED BOOKINGS.
--
-- ----------------------------------------------------------------------------
-- THE PROBLEM
-- ----------------------------------------------------------------------------
-- A confirmed booking whose arrival day came and went with nobody at the desk
-- sits as 'confirmed' FOREVER. 015 RULE 4 makes 'confirmed' hold inventory, so
-- that room is unsellable — for the arrival night, and for every night through
-- to its check_out — because of a guest who never came. 024 added mark_no_show
-- as the front-desk act that resolves it, and deliberately refused to let the
-- cron fire it. That was right for the reason 024 gives (a 02:00 arrival is not
-- a no-show, and auto-charging is worse than auto-flagging) — but it left the
-- ROOM held, indefinitely, on nobody's decision. The hotel loses the night
-- twice: once to the guest who did not arrive, and once to the guest it could
-- not sell it to.
--
-- ----------------------------------------------------------------------------
-- WHAT THIS MIGRATION DOES, IN FOUR PARTS
-- ----------------------------------------------------------------------------
--   §1  bookings gains the follow-up flag (note / acknowledged_at / by).
--   §2  count_available: 'no_show' now RELEASES the room. This is a deliberate
--       reversal of 015 RULE 4's DEFAULT, and it is the change that makes the
--       whole feature real — see the proof there.
--   §3  acknowledge_booking_follow_up: the front desk's dismissal.
--   §4  run_night_audit gains an AUTO-RESOLVE pass that reaches the terminal
--       state through the EXISTING RPCs — cancel_booking for a walk-in,
--       mark_no_show for a corporate booking.
--
-- ----------------------------------------------------------------------------
-- WHAT IS NOT TOUCHED
-- ----------------------------------------------------------------------------
-- folio_totals, folio_charge_tax, folio_balance, post_charge,
-- post_room_night_charge, apply_charge_discount, record_payment, void_charge,
-- void_payment, check_in_booking, check_out_booking, create_booking,
-- cancel_booking, mark_no_show and every pricing path are BYTE-FOR-BYTE as
-- 015/016/021/023/024/025/026 left them. THE AUDIT WRITES NO MONEY OF ITS OWN:
-- the one-night no-show charge is posted by mark_no_show, exactly as it is when
-- the desk presses the button, through post_charge, at the rate locked in
-- booking_nights, under the deterministic 'noshow:<booking>' key.
--
-- ----------------------------------------------------------------------------
-- THE PREDICATE — AND WHY IT IS COPIED, NOT RE-DERIVED
-- ----------------------------------------------------------------------------
--
--   ┌──────────────────────────────────────────────────────────────────────────┐
--   │  A BOOKING IS UNCOLLECTED WHEN ITS RESERVED ARRIVAL DAY IS ENTIRELY OVER │
--   │  IN THE PROPERTY'S TIMEZONE, AND IT IS STILL 'confirmed'.                │
--   │                                                                          │
--   │      v_today := (now() at time zone <property tz>)::date                 │
--   │      b.status = 'confirmed'  AND  b.check_in < v_today                   │
--   └──────────────────────────────────────────────────────────────────────────┘
--
-- mark_no_show (024 §4) guards with the SAME two lines, written as its inverse:
--
--     v_today := (now() at time zone
--                  coalesce(nullif(btrim(v_timezone), ''), 'Africa/Lagos'))::date;
--     if v_booking.check_in >= v_today then
--       raise exception '...arrival date (%) has not passed yet...';
--     end if;
--
-- `check_in < v_today` is exactly the negation of `check_in >= v_today`, on the
-- same v_today, derived in the same timezone with the same 'Africa/Lagos'
-- fallback. It is written that way here ON PURPOSE: the auto-resolve pass must
-- never select a booking that mark_no_show would then refuse, or the audit would
-- log an error every single night for the same booking. And a guest has until
-- MIDNIGHT, property-local, to walk in — an 11pm same-day arrival is an ordinary
-- event, so today's arrivals are never touched.
--
-- NOTE THE DIFFERENCE FROM v_date (the audited business date). The audit's
-- business date is YESTERDAY by default but can be an explicit catch-up date,
-- and the resolve pass must NOT use it: whether a guest may still walk in is a
-- fact about NOW, not about the night being audited. A catch-up run for last
-- month must not un-resolve, or re-resolve, anything on the strength of a date
-- somebody typed. So v_today is derived independently and used here alone.
--
-- ----------------------------------------------------------------------------
-- WHICH TERMINAL STATE, AND WHY THE TWO ARE DIFFERENT
-- ----------------------------------------------------------------------------
--   WALK-IN / individual (no company)     -> cancel_booking  -> 'cancelled'
--       They committed nothing and owe nothing. 024 §4 already states the rule:
--       "a walk-in committed nothing, so they owe nothing", and posting a ₦0
--       line would put a meaningless row on a folio somebody then has to
--       explain. Cancelling is the honest record: the reservation ended without
--       a stay and without money.
--
--   CORPORATE (company_id set OR bill_to = 'company') -> mark_no_show -> 'no_show'
--       A company held the room on their account, so they owe one night — and
--       'no_show' rather than 'cancelled' because the two are DIFFERENT
--       COMMERCIAL FACTS. A cancellation is "the reservation was called off"; a
--       no-show is "the room was held, nobody came, and it was charged". The
--       occupancy report, the company's invoice and next year's argument about
--       this account all need to be able to tell them apart, and a status that
--       collapsed both would make that impossible.
--
-- The GUARANTEED test (company_id is not null or bill_to = 'company') is NOT
-- re-implemented here: the branch below decides only WHICH RPC to call, and
-- mark_no_show re-evaluates the same test itself before posting anything. If the
-- two ever disagreed, the RPC's answer is the one that reaches the folio — which
-- is the correct direction for a disagreement about money.
-- ============================================================================


-- ############################################################################
-- SECTION 1 — the corporate follow-up flag
-- ############################################################################
-- A no-show that was CHARGED to a company is not the end of the conversation.
-- The company may have had a delayed flight, may want the room held another
-- night, may dispute the charge. Releasing that room to a walk-in an hour later
-- without a phone call is how a corporate account is lost — so the desk is told,
-- in words, on the guest's own page.
--
-- IT IS A REMINDER, NOT A LOCK. The room IS released the moment the status
-- changes (§2) and the note blocks nothing; it is the human half of a decision
-- the system has already made correctly. Anything stronger — holding inventory
-- pending a phone call — would put us straight back in the state this migration
-- exists to end.
--
-- THE NOTE IS A RENDERED SENTENCE, stored, and that is deliberate rather than a
-- denormalisation to apologise for. It records what was TRUE AT THE MOMENT OF
-- THE NO-SHOW: the room type's name then, the company's name then, the dates as
-- they stood then. A note re-rendered at read time from today's rows would
-- quietly change its wording when a room type is renamed, and the front desk
-- would be reading a reconstruction rather than the notice that was raised.
alter table bookings
  add column if not exists follow_up_note            text,
  add column if not exists follow_up_acknowledged_at timestamptz,
  add column if not exists follow_up_acknowledged_by uuid references auth.users(id);

comment on column bookings.follow_up_note is
  'A front-desk reminder raised automatically when the night audit no-showed and '
  'CHARGED a corporate booking (029 §4): which room, which dates, which company, '
  'and to call before releasing the room to somebody else. A REMINDER ONLY — the '
  'room is already released (§2) and this blocks nothing. Rendered and stored at '
  'the moment it was raised, so it records what was true then rather than a '
  'reconstruction from today''s rows. NULL when there is nothing to follow up.';

comment on column bookings.follow_up_acknowledged_at is
  'When the front desk dismissed the follow-up note. NULL = still outstanding, '
  'which is exactly what the "open follow-ups" query filters on. Set only through '
  'acknowledge_booking_follow_up (§3) — bookings has no update RLS policy.';

comment on column bookings.follow_up_acknowledged_by is
  'WHO dismissed the follow-up. The point of the acknowledgement: a reminder '
  'nobody is answerable for is a reminder that gets clicked away unread.';

-- The "open follow-ups for this property" query, which every screen carrying the
-- notice runs. PARTIAL — it indexes only the handful of rows that are actually
-- outstanding, so it stays tiny however many bookings the property accumulates.
create index if not exists bookings_open_follow_up_idx
  on bookings (property_id, check_in)
  where follow_up_note is not null and follow_up_acknowledged_at is null;


-- ############################################################################
-- SECTION 2 — count_available: a NO-SHOW NOW RELEASES THE ROOM
-- ############################################################################
--
--   ┌──────────────────────────────────────────────────────────────────────────┐
--   │  THIS IS THE CHANGE THAT MAKES THE FEATURE REAL. Without it, auto-no-    │
--   │  showing a corporate booking would move a status and free NOTHING.      │
--   └──────────────────────────────────────────────────────────────────────────┘
--
-- 015 RULE 4 shipped with:
--     'confirmed','checked_in','checked_out'  always hold inventory
--     'cancelled','enquiry'                   never hold
--     'no_show'                               HOLDS, by default
-- and said so in terms: "'no_show' does NOT [free the room] by default (the room
-- was held for a guest who never arrived) ... but is made configurable via
-- p_count_no_show so a property can later choose to release no-shows."
--
-- THIS MIGRATION IS THAT LATER CHOICE, and the reasoning has genuinely inverted:
-- 015's default made sense while a no-show was a MANUAL act recorded after the
-- fact, often days later, on a stay that was already over — releasing inventory
-- retroactively would have changed nothing. It is wrong the moment the audit
-- resolves a booking the morning after its arrival day, because then the whole
-- remaining stay — the arrival night and every night through to check_out — is
-- being held for a guest the hotel has just formally recorded as absent, and has
-- charged for their absence. Holding a room you have already billed for and
-- written off is not caution; it is lost revenue with a status attached.
--
-- THE ONLY CHANGE IS THE DEFAULT of p_count_no_show, from true to false. The
-- parameter itself stays, so any caller that genuinely wants the old reading can
-- still ask for it explicitly — nothing is removed, only the answer given to a
-- caller who does not specify.
--
-- ----------------------------------------------------------------------------
-- THE PROOF THAT THE ROOM IS GENUINELY BOOKABLE AGAIN (what the brief asks for)
-- ----------------------------------------------------------------------------
-- The occupancy predicate below is, verbatim:
--
--     b.status in ('confirmed','checked_in','checked_out')
--     or (p_count_no_show and b.status = 'no_show')
--
-- Walk the two terminal states this migration can produce:
--
--   'cancelled'  -> not in the IN-list, and not equal to 'no_show'. Both
--                   disjuncts are FALSE, so the booking is not counted in
--                   v_booked. The room is free. (Unchanged from 015 — this is
--                   the half of RULE 4 that always worked.)
--
--   'no_show'    -> not in the IN-list. The second disjunct is
--                   (p_count_no_show and true) = p_count_no_show, which is now
--                   FALSE for every caller that does not pass the argument.
--                   So the booking is not counted. The room is free.
--
-- And there is no availability CACHE anywhere to fall out of step — count_available
-- computes live from the bookings table on every call (015 §6), which is why a
-- status change is the ENTIRE act of freeing a room. create_booking's overbooking
-- guard (015 §7) calls this same function under its row lock, so a room released
-- here is immediately sellable through the sanctioned path, not merely displayed
-- as free.
--
-- WHAT THIS DOES NOT DO: it does not touch booking_nights, which are KEPT as the
-- audit record of what was agreed (015 §8's reasoning), and it does not touch the
-- folio. A corporate no-show's one-night charge stays exactly where mark_no_show
-- posted it.
create or replace function count_available(
  p_property_id       uuid,
  p_room_type_id      uuid,
  p_check_in          date,
  p_check_out         date,
  p_exclude_booking_id uuid    default null,
  -- 029: DEFAULT FLIPPED. A no-show releases the room. See the block above.
  p_count_no_show     boolean default false
)
returns integer
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_total  integer;
  v_booked integer;
begin
  if p_check_out <= p_check_in then
    raise exception 'count_available: check_out (%) must be after check_in (%)',
      p_check_out, p_check_in using errcode = 'check_violation';
  end if;

  -- Denominator (RULE 3). A missing or soft-deleted type yields NULL -> 0 free.
  select rt.inventory_count into v_total
  from room_types rt
  where rt.id = p_room_type_id
    and rt.property_id = p_property_id
    and rt.deleted_at is null;

  if v_total is null then
    return 0;
  end if;

  -- Occupied units overlapping the window. deleted_at NULL-safe (rule 5): a
  -- soft-deleted booking never counts. The two strict inequalities ARE the RULE 2
  -- clash test — and because check_out is exclusive, a booking that STARTS on
  -- another's check_out day does not overlap (RULE 1).
  --
  -- BYTE-FOR-BYTE 015 §6 from here down. The behaviour change is entirely in the
  -- DEFAULT of p_count_no_show above; the expression is untouched, so the proof
  -- in the header is a proof about the code that actually runs.
  select count(*) into v_booked
  from bookings b
  where b.property_id  = p_property_id
    and b.room_type_id = p_room_type_id
    and b.deleted_at is null
    and (p_exclude_booking_id is null or b.id <> p_exclude_booking_id)
    and (
      b.status in ('confirmed','checked_in','checked_out')
      or (p_count_no_show and b.status = 'no_show')
    )
    and b.check_in < p_check_out          -- RULE 2, half A
    and p_check_in < b.check_out;         -- RULE 2, half B

  return greatest(0, v_total - v_booked);
end;
$$;

comment on function count_available(uuid, uuid, date, date, uuid, boolean) is
  'Free units of a room type for [check_in, check_out): inventory_count minus '
  'overlapping occupancy-holding bookings, floored at 0. Half-open clash test '
  '(RULES 1&2); cancelled and enquiry never occupy. 029 REVERSES 015 RULE 4''s '
  'DEFAULT: a no_show now RELEASES the room, because the night audit resolves '
  'uncollected bookings the morning after arrival and holding a room already '
  'billed as absent is lost revenue with a status attached. p_count_no_show is '
  'kept so a caller can still ask for the old reading explicitly. '
  'p_exclude_booking_id ignores the booking being modified. STABLE.';


-- ############################################################################
-- SECTION 3 — acknowledge_booking_follow_up
-- ############################################################################
-- The front desk's "seen it". bookings has NO update RLS policy (015 §9), so
-- like every other booking mutation this is a SECURITY DEFINER RPC and not a
-- table write.
--
-- IDEMPOTENT BY STATE, and the state is the stronger guard: a second call on an
-- already-acknowledged booking returns it unchanged rather than re-stamping a
-- new time and a new person over the record of who actually dealt with it.
-- p_idempotency_key is accepted for interface consistency (rule 2) and
-- deliberately not stored — the same shape cancel_booking (015 §8) and
-- void_charge (021 §9.5) use, and for the same reason: a state check also
-- catches a retry that arrives with a DIFFERENT key.
--
-- IT CANNOT RAISE A NOTE, only clear one. There is no parameter for the note
-- text: the notice is raised by the audit from facts, and a client that could
-- write it could write a reminder nobody's system ever decided to give.
create or replace function acknowledge_booking_follow_up(
  p_booking_id      uuid,
  p_idempotency_key text default null
)
returns bookings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking bookings;
  v_actor   uuid := auth.uid();
begin
  select * into v_booking
  from bookings
  where id = p_booking_id and deleted_at is null
  for update;

  if not found then
    raise exception 'Booking % not found', p_booking_id using errcode = 'no_data_found';
  end if;

  -- Staff gate: acknowledging a desk reminder is front-desk work, like every
  -- other operational act on a booking.
  if not is_tenant_staff(v_booking.tenant_id) then
    raise exception 'Not authorised to update this booking'
      using errcode = 'insufficient_privilege';
  end if;

  if v_booking.follow_up_note is null then
    raise exception 'Booking % has no follow-up to acknowledge', p_booking_id
      using errcode = 'check_violation';
  end if;

  -- Idempotent by state: already acknowledged -> unchanged. The FIRST person to
  -- deal with it is the one on the record.
  if v_booking.follow_up_acknowledged_at is not null then
    return v_booking;
  end if;

  update bookings
    set follow_up_acknowledged_at = now(),
        follow_up_acknowledged_by = v_actor,
        updated_by                = v_actor
  where id = p_booking_id
  returning * into v_booking;

  return v_booking;
end;
$$;

comment on function acknowledge_booking_follow_up(uuid, text) is
  'Dismisses a booking''s front-desk follow-up notice, recording WHO and WHEN. '
  'Staff-gated, SECURITY DEFINER (bookings has no update policy). Idempotent by '
  'state — a second call leaves the first acknowledger on the record. It can only '
  'CLEAR a note, never raise one: the notice is raised by the night audit from '
  'facts, and no client may write a reminder the system never decided to give.';

revoke execute on function acknowledge_booking_follow_up(uuid, text) from public;
revoke execute on function acknowledge_booking_follow_up(uuid, text) from anon;
grant  execute on function acknowledge_booking_follow_up(uuid, text) to authenticated;


-- ############################################################################
-- SECTION 4 — run_night_audit: the AUTO-RESOLVE pass
-- ############################################################################
--
--   ┌──────────────────────────────────────────────────────────────────────────┐
--   │  024 SAID: "THE AUDIT REPORTS NO-SHOWS. IT DOES NOT MARK THEM."          │
--   │  029 CHANGES THAT — but only for bookings whose arrival day is ENTIRELY  │
--   │  OVER, which is precisely the case 024's objections do not cover.        │
--   └──────────────────────────────────────────────────────────────────────────┘
--
-- 024 gave three reasons for not auto-marking, and this migration is written
-- against them one at a time rather than around them:
--
--   1. "A LATE ARRIVAL IS NOT A NO-SHOW — a guest whose flight lands at 01:00
--      and who reaches the desk at 02:30 is a paying, in-house guest, and at the
--      06:00 cutoff a naive rule cannot tell them apart from someone who never
--      came."  STILL TRUE, and this pass does not touch them: the predicate is
--      check_in < TODAY (property-local), so a booking arriving TODAY — at any
--      hour, including 23:59 — is never a candidate. 024's failure case was a
--      rule keyed on the AUDITED NIGHT; this one is keyed on whether the arrival
--      DAY is over. The guest asleep upstairs checked in yesterday, so their
--      booking is not 'confirmed' and is not selected either.
--
--   2. "IT WOULD POST MONEY NOBODY DECIDED TO POST."  The decision is now made,
--      deliberately, once, here: a company that held a room through an entire
--      arrival day and never called owes the night, on the same rule
--      mark_no_show has always applied. It is not a new charge and not a new
--      amount — it is the SAME RPC posting the SAME one night at the SAME locked
--      rate under the SAME 'noshow:<booking>' key. And it is now VISIBLE in a way
--      the manual path never was: every one raises a follow-up notice naming the
--      company, and the audit summary reports the count and the booking numbers.
--
--   3. "A NO-SHOW IS A COMMERCIAL JUDGEMENT — hotels waive the charge for a
--      regular, for a corporate account that called ahead, for weather."  STILL
--      TRUE, and the judgement is preserved rather than removed: the charge can
--      be voided on the folio with a reason and a name (void_charge), and the
--      follow-up notice is what puts the person who makes that judgement in
--      front of it. What is NOT preserved is the option to do nothing forever,
--      which is what was actually happening and what was costing the room.
--
-- mark_no_show REMAINS A MANUAL FRONT-DESK ACTION and is not modified. The desk
-- still uses it for the same-day "they are definitely not coming" call — which
-- this pass cannot make, because it deliberately waits for the whole day. The
-- two are the same act at two different levels of certainty, and they go through
-- one function so they can never post differently.
--
-- ----------------------------------------------------------------------------
-- HOW THE PASS REACHES THE EXISTING RPCs (the brief's "show how")
-- ----------------------------------------------------------------------------
-- It calls them. `perform mark_no_show(r.id, null)` and
-- `perform cancel_booking(r.id, <reason>, null)`, from inside this function.
--
-- Two things make that work, and both are worth stating because neither is
-- obvious:
--   * THE STAFF GATE PASSES. Both RPCs call is_tenant_staff(), which 023 §1
--     extended to return true for the SERVICE ROLE so the cron could post
--     through validated RPCs instead of writing rows directly. The cron is the
--     service role, so the gate is satisfied for the same reason the posting
--     loop's is.
--   * THE EXECUTE GRANT IS NOT AN OBSTACLE. 024 §5 revokes EXECUTE on
--     mark_no_show FROM service_role, on purpose, so a server-side job could not
--     reach the no-show decision "by simply calling the obvious RPC". That
--     revoke is LEFT IN PLACE and still does its job: privilege for a nested
--     call is checked against the CURRENT USER, which inside this SECURITY
--     DEFINER function is the function's OWNER, not the caller. So the cron
--     still cannot call mark_no_show directly — it can only reach it through
--     THIS pass, which is the sanctioned path, with its predicate, its
--     idempotency guard and its reporting. 024 asked that going around the
--     sanctioned path be "the kind of thing a reviewer notices"; this migration
--     is that review, and this is the path.
--
-- ----------------------------------------------------------------------------
-- IDEMPOTENCY — THREE LAYERS, AND WHY ONE WOULD NOT DO
-- ----------------------------------------------------------------------------
--   1. THE SELECTION. Only rows that are STILL 'confirmed' are candidates. A
--      booking this pass resolved last night is 'cancelled' or 'no_show' and is
--      not selected again — so a second run in the same hour, or ten runs, see
--      nothing to do.
--   2. THE RE-READ UNDER LOCK. Between the candidate select and the call, a
--      receptionist may check the guest in. So each booking is re-read FOR
--      UPDATE immediately before acting and skipped if its status has moved —
--      which turns the race into a counted skip rather than an exception, and
--      makes it impossible to cancel a guest who has just walked in.
--   3. THE RPCs' OWN GUARDS. cancel_booking returns unchanged if already
--      cancelled and refuses anything past 'confirmed'; mark_no_show returns
--      unchanged if already no_show and refuses anything but 'confirmed'. And
--      the CHARGE carries the deterministic 'noshow:<booking>' key, so even if
--      every guard above were somehow bypassed, folio_charges_idem_uniq (rule 3)
--      makes a second no-show charge for one booking impossible in the database.
--
-- Layer 3 alone is the correctness guarantee; layers 1 and 2 are what keep the
-- audit summary honest and keep a checked-in guest safe.
--
-- ----------------------------------------------------------------------------
-- PER-BOOKING SUBTRANSACTION, as the posting loop already does
-- ----------------------------------------------------------------------------
-- The audit is an unattended sweep across a whole property, so one booking that
-- cannot be resolved — a missing locked rate, no 'room' category — must not
-- abandon the other twenty-nine. Each resolution gets its own BEGIN/EXCEPTION
-- block and failures are collected into the summary. WITHIN one booking, the
-- status change and its charge remain in ONE transaction (rule 7) because
-- mark_no_show performs both and the subtransaction rolls both back together:
-- there is never a no_show whose guaranteed charge silently did not post.
--
-- Everything else in this function is BYTE-FOR-BYTE 024 §3: the property lookup,
-- the staff gate, the property-local business-date derivation, the in-house
-- posting loop and its subtransactions, the pre-read of the idempotency key, the
-- delegation to post_room_night_charge, the not_checked_in / not_yet_arrived /
-- no_show_candidates reports and the summary keys they fill.
create or replace function run_night_audit(
  p_property_id   uuid,
  p_business_date date default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant_id      uuid;
  v_property_name  text;
  v_timezone       text;
  v_audit_time     time;
  v_date           date;

  r                record;
  v_charge         folio_charges;
  v_key            text;
  v_existed        boolean;

  v_in_house       integer := 0;
  v_posted         integer := 0;
  v_skipped        integer := 0;
  v_voided         integer := 0;
  v_amount         numeric(14,2) := 0;
  v_errors         jsonb := '[]'::jsonb;
  v_not_checked_in jsonb := '[]'::jsonb;
  v_not_arrived    jsonb := '[]'::jsonb;
  v_candidates     jsonb := '[]'::jsonb;
  v_candidate_count integer := 0;

  -- 029: the auto-resolve pass.
  v_today          date;
  v_status         text;
  v_guaranteed     boolean;
  v_note           text;
  v_type_name      text;
  v_company_name   text;
  v_charge_amount  numeric(14,2);
  v_cancelled      jsonb := '[]'::jsonb;
  v_no_showed      jsonb := '[]'::jsonb;
  v_resolve_skipped integer := 0;
  v_resolve_errors jsonb := '[]'::jsonb;
  v_no_show_amount numeric(14,2) := 0;

  c_candidate_limit constant integer := 100;
begin
  -- The property, and the timezone the business date is derived in. Rule 5:
  -- a soft-deleted property is not audited.
  select p.tenant_id, p.name, p.timezone, p.night_audit_time
    into v_tenant_id, v_property_name, v_timezone, v_audit_time
  from properties p
  where p.id = p_property_id
    and p.deleted_at is null;

  if v_tenant_id is null then
    raise exception 'Property % not found', p_property_id
      using errcode = 'no_data_found';
  end if;

  -- Rule 19 in its RPC form: SECURITY DEFINER bypasses RLS, so authorise here.
  -- Staff (any active member) or the service role — the same gate every folio
  -- posting path uses, so the audit can never post what a caller could not.
  if not is_tenant_staff(v_tenant_id) then
    raise exception 'Not authorised to run the night audit for this property'
      using errcode = 'insufficient_privilege';
  end if;

  v_timezone := coalesce(nullif(btrim(v_timezone), ''), 'Africa/Lagos');

  if p_business_date is not null then
    v_date := p_business_date;
  else
    -- THE NIGHT THAT JUST ENDED. See 023's header: a charge posted at the 06:00
    -- cutoff on the 5th is for the night of the 4th.
    v_date := (now() at time zone v_timezone)::date - 1;
  end if;

  -- 029: the property's TODAY, derived exactly as mark_no_show derives it (024
  -- §4). Deliberately NOT v_date: whether a guest may still walk in is a fact
  -- about now, not about the night being audited, so a catch-up run for an old
  -- date must not resolve — or fail to resolve — on the strength of it.
  v_today := (now() at time zone v_timezone)::date;

  -- --------------------------------------------------------------------------
  -- The in-house set: bookings whose OCCUPIED range contains the night.
  -- --------------------------------------------------------------------------
  -- charge_from is 024's expression: the actual arrival, falling back to the
  -- reserved check-in, floored at the reserved check-in. The far end is
  -- unchanged — v_date < check_out, half-open, so the departure day is not a
  -- night (015 RULES 1 & 2), and a stay shortened at an early checkout stops
  -- being charged from the new check_out onward with no reversal needed.
  for r in
    select b.id,
           b.booking_number,
           b.status,
           greatest(coalesce(b.actual_check_in, b.check_in), b.check_in) as charge_from
    from bookings b
    where b.property_id = p_property_id
      and b.tenant_id   = v_tenant_id            -- rule 19, explicit
      and b.deleted_at is null                   -- rule 5
      and b.status in ('checked_in', 'checked_out')
      and greatest(coalesce(b.actual_check_in, b.check_in), b.check_in) <= v_date
      and v_date < b.check_out
    order by b.booking_number
  loop
    v_in_house := v_in_house + 1;

    -- The key post_room_night_charge will build for this (booking, night). Read
    -- BEFORE the call so the summary can tell a fresh posting from a no-op
    -- re-run; the call itself is what actually enforces uniqueness, so a race
    -- here can only mis-classify a count, never double-charge.
    v_key := 'room:' || r.id::text || ':' || v_date::text;
    select exists (
      select 1 from folio_charges fc
      where fc.tenant_id = v_tenant_id
        and fc.idempotency_key = v_key
    ) into v_existed;

    begin
      -- The rate comes from booking_nights, locked at booking time.
      select * into v_charge from post_room_night_charge(r.id, v_date);

      if v_existed then
        v_skipped := v_skipped + 1;
        -- A night whose charge was deliberately VOIDED stays voided: the
        -- idempotency key still exists, so the re-run returns the voided row and
        -- posts nothing. That is correct — re-posting would silently undo a
        -- person's decision — but it must be VISIBLE, so it is counted.
        if v_charge.is_voided is true then
          v_voided := v_voided + 1;
        end if;
      else
        v_posted := v_posted + 1;
        v_amount := v_amount + coalesce(v_charge.net_amount, 0);
      end if;
    exception
      when others then
        -- Subtransaction rollback: this booking posted nothing, the rest of the
        -- run continues, and the reason travels back in the summary.
        v_errors := v_errors || jsonb_build_object(
          'booking_id',     r.id,
          'booking_number', r.booking_number,
          'status',         r.status,
          'charge_from',    r.charge_from,
          'sqlstate',       sqlstate,
          'message',        sqlerrm
        );
    end;
  end loop;

  -- ==========================================================================
  -- 029 — AUTO-RESOLVE: free the rooms of bookings nobody collected
  -- ==========================================================================
  -- Runs AFTER the posting loop, deliberately. The two do not interact — a
  -- 'confirmed' booking is not in the in-house set, and a booking resolved here
  -- becomes 'cancelled' or 'no_show', neither of which the loop above selects —
  -- but ordering it second means an unexpected failure in the NEW code can never
  -- prevent the room charges the hotel's revenue depends on from posting.
  --
  -- The candidate list is read WITHOUT a lock and each row re-read FOR UPDATE
  -- below. Locking the whole set up front would hold every candidate for the
  -- duration of the pass, blocking a receptionist trying to check in the one
  -- guest who did turn up.
  for r in
    select b.id, b.booking_number, b.check_in, b.check_out, b.room_type_id,
           b.company_id, b.bill_to
    from bookings b
    where b.property_id = p_property_id
      and b.tenant_id   = v_tenant_id            -- rule 19, explicit
      and b.deleted_at is null                   -- rule 5
      and b.status = 'confirmed'                 -- idempotency layer 1
      and b.check_in < v_today                   -- THE PREDICATE (see the header)
    order by b.check_in, b.booking_number
  loop
    begin
      -- IDEMPOTENCY LAYER 2: re-read under lock. A guest may have been checked
      -- in between the select above and this instant; a status that has moved is
      -- a counted SKIP, never an exception and never a cancellation of somebody
      -- who is upstairs.
      select b.status into v_status
      from bookings b
      where b.id = r.id
      for update;

      if v_status is distinct from 'confirmed' then
        v_resolve_skipped := v_resolve_skipped + 1;
      else
        -- WHICH RPC. This decides only the branch; mark_no_show re-evaluates the
        -- same guaranteed test itself before posting anything, and its answer is
        -- the one that reaches the folio.
        v_guaranteed := (r.company_id is not null or r.bill_to = 'company');

        if v_guaranteed then
          -- CORPORATE: status + one-night charge, in one transaction, through
          -- the unchanged 024 §4 RPC. No amount is computed or passed here.
          perform mark_no_show(r.id, null);

          -- What it actually charged, read back from the folio by the
          -- deterministic key rather than recomputed — so the summary reports
          -- the money that is really on the bill, including 0 for the case where
          -- a previous manual charge had been voided.
          select coalesce(sum(fc.net_amount), 0) into v_charge_amount
          from folio_charges fc
          where fc.tenant_id = v_tenant_id
            and fc.idempotency_key = 'noshow:' || r.id::text
            and fc.is_voided is not true;                        -- rule 5

          v_no_show_amount := v_no_show_amount + coalesce(v_charge_amount, 0);

          -- THE FOLLOW-UP NOTICE. Composed from THIS booking's own rows — the
          -- room type's name, the company's name, the dates — never a literal
          -- about any hotel (rule 17). A retired room type still names the
          -- booking it held (021 §8.1's inverted rule), so no deleted_at filter.
          select rt.name into v_type_name
          from room_types rt where rt.id = r.room_type_id;

          select c.name into v_company_name
          from companies c where c.id = r.company_id;

          v_note :=
            'Room ' || coalesce(v_type_name, 'of this booking') ||
            ' from ' || to_char(r.check_in, 'DD Mon YYYY') ||
            ' to '   || to_char(r.check_out, 'DD Mon YYYY') ||
            ' was held by ' ||
            coalesce(v_company_name, 'the company account on this booking') ||
            ' — call to confirm before releasing to another guest.';

          -- Written here rather than inside mark_no_show so that RPC stays
          -- byte-for-byte 024: the MANUAL path does not need a reminder, because
          -- the person raising it is standing at the desk having just decided it.
          -- The acknowledgement columns are left NULL — outstanding by
          -- definition — and are only ever set by
          -- acknowledge_booking_follow_up (§3).
          update bookings
             set follow_up_note = v_note
           where id = r.id;

          v_no_showed := v_no_showed || jsonb_build_object(
            'booking_id',     r.id,
            'booking_number', r.booking_number,
            'check_in',       r.check_in,
            'check_out',      r.check_out,
            'company_id',     r.company_id,
            'company_name',   v_company_name,
            'charged',        coalesce(v_charge_amount, 0)
          );
        else
          -- WALK-IN: cancel, free the room, charge nothing. The reason is
          -- recorded permanently on the booking, and it says WHO decided (the
          -- audit) so it is never mistaken for a person's cancellation.
          perform cancel_booking(
            r.id,
            'Auto-cancelled by the night audit: the reserved arrival day passed with no check-in.',
            null
          );

          v_cancelled := v_cancelled || jsonb_build_object(
            'booking_id',     r.id,
            'booking_number', r.booking_number,
            'check_in',       r.check_in,
            'check_out',      r.check_out
          );
        end if;
      end if;
    exception
      when others then
        -- Subtransaction rollback: THIS booking is untouched — status, charge
        -- and note together (rule 7) — the rest of the pass continues, and the
        -- reason travels back in the summary for a person to act on.
        v_resolve_errors := v_resolve_errors || jsonb_build_object(
          'booking_id',     r.id,
          'booking_number', r.booking_number,
          'check_in',       r.check_in,
          'sqlstate',       sqlstate,
          'message',        sqlerrm
        );
    end;
  end loop;

  -- --------------------------------------------------------------------------
  -- Reported, never charged (1/3): reserved this night, but ARRIVED LATER.
  -- --------------------------------------------------------------------------
  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'booking_id',      b.id,
               'booking_number',  b.booking_number,
               'status',          b.status,
               'check_in',        b.check_in,
               'actual_check_in', b.actual_check_in
             )
             order by b.booking_number
           ),
           '[]'::jsonb
         )
    into v_not_arrived
  from bookings b
  where b.property_id = p_property_id
    and b.tenant_id   = v_tenant_id
    and b.deleted_at is null
    and b.status in ('checked_in', 'checked_out')
    and b.actual_check_in is not null
    and b.actual_check_in > v_date
    and b.check_in <= v_date
    and v_date < b.check_out;

  -- --------------------------------------------------------------------------
  -- Reported, never charged (2/3): confirmed, spanning the night, not arrived.
  -- --------------------------------------------------------------------------
  -- Unchanged from 023, and it means something NARROWER since 029: a booking
  -- listed here is one whose arrival day has NOT yet fully passed (anything
  -- older was just resolved above), i.e. genuinely "the guest may still walk in
  -- tonight". That is exactly the list the desk should chase.
  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'booking_id',     b.id,
               'booking_number', b.booking_number,
               'status',         b.status,
               'check_in',       b.check_in,
               'check_out',      b.check_out
             )
             order by b.booking_number
           ),
           '[]'::jsonb
         )
    into v_not_checked_in
  from bookings b
  where b.property_id = p_property_id
    and b.tenant_id   = v_tenant_id
    and b.deleted_at is null
    and b.status = 'confirmed'
    and b.check_in <= v_date
    and v_date < b.check_out;

  -- --------------------------------------------------------------------------
  -- Reported (3/3): no-show CANDIDATES — now a LEFTOVERS list.
  -- --------------------------------------------------------------------------
  -- 024 built this as the audit's whole answer to an uncollected booking: report
  -- it, and let a person act. Since §4 the audit ACTS, so on a healthy run this
  -- list is EMPTY, and that is its new value: anything still in it is a booking
  -- the auto-resolve pass could not resolve (see resolve_errors) or one whose
  -- arrival day is not yet over on a catch-up run for an old date. It is kept,
  -- rather than deleted, precisely so the failures stay visible.
  --
  -- The count is always exact and a truncated flag says so out loud, because
  -- this is the one set here that could in principle grow without bound.
  select count(*) into v_candidate_count
  from bookings b
  where b.property_id = p_property_id
    and b.tenant_id   = v_tenant_id
    and b.deleted_at is null
    and b.status = 'confirmed'
    and b.check_in <= v_date;

  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'booking_id',     c.id,
               'booking_number', c.booking_number,
               'check_in',       c.check_in,
               'check_out',      c.check_out,
               'guaranteed',     (c.company_id is not null or c.bill_to = 'company')
             )
             order by c.check_in, c.booking_number
           ),
           '[]'::jsonb
         )
    into v_candidates
  from (
    select b.id, b.booking_number, b.check_in, b.check_out, b.company_id, b.bill_to
    from bookings b
    where b.property_id = p_property_id
      and b.tenant_id   = v_tenant_id
      and b.deleted_at is null
      and b.status = 'confirmed'
      and b.check_in <= v_date
    order by b.check_in, b.booking_number
    limit c_candidate_limit
  ) c;

  -- --------------------------------------------------------------------------
  -- The summary — what makes an unattended job observable.
  -- --------------------------------------------------------------------------
  -- posted + already_posted = in_house on a clean run; anything in `errors`,
  -- `not_checked_in`, `no_show_candidates` or `auto_resolve_errors` is work for
  -- a person. amount_posted counts ONLY the charges this run created, so a
  -- re-run of an already-audited night reports 0.00 — which is exactly how an
  -- operator confirms the retry changed nothing. The 029 counters behave the
  -- same way: a second run resolves nothing and reports zeros.
  return jsonb_build_object(
    'property_id',          p_property_id,
    'property_name',        v_property_name,
    'tenant_id',            v_tenant_id,
    'timezone',             v_timezone,
    'night_audit_time',     v_audit_time,
    'business_date',        v_date,
    -- 029: the property's today, which the auto-resolve predicate is measured
    -- against. Reported so an operator can see WHY a booking was or was not
    -- resolved without re-deriving a timezone by hand.
    'resolve_as_of',        v_today,
    'ran_at',               now(),
    'in_house',             v_in_house,
    'posted',               v_posted,
    'already_posted',       v_skipped,
    'already_posted_voided', v_voided,
    'amount_posted',        v_amount,
    'error_count',          jsonb_array_length(v_errors),
    'errors',               v_errors,
    'not_checked_in_count', jsonb_array_length(v_not_checked_in),
    'not_checked_in',       v_not_checked_in,
    'not_yet_arrived_count', jsonb_array_length(v_not_arrived),
    'not_yet_arrived',       v_not_arrived,
    'no_show_candidate_count',     v_candidate_count,
    'no_show_candidates',          v_candidates,
    'no_show_candidates_truncated', v_candidate_count > c_candidate_limit,
    -- 029: what the auto-resolve pass did, with booking numbers.
    'auto_cancelled_count',  jsonb_array_length(v_cancelled),
    'auto_cancelled',        v_cancelled,
    'auto_no_show_count',    jsonb_array_length(v_no_showed),
    'auto_no_show',          v_no_showed,
    'auto_no_show_charged',  v_no_show_amount,
    'auto_resolve_skipped',  v_resolve_skipped,
    'auto_resolve_error_count', jsonb_array_length(v_resolve_errors),
    'auto_resolve_errors',   v_resolve_errors
  );
end;
$$;

comment on function run_night_audit(uuid, date) is
  'Posts one room-night charge for every in-house booking at a property for a '
  'business date (via post_room_night_charge, from the booking_nights lock — it '
  'orchestrates only, it never prices), charging from the guest''s ACTUAL '
  'arrival (024). 029 ADDS AN AUTO-RESOLVE PASS: every booking still ''confirmed'' '
  'whose reserved arrival day is ENTIRELY over in the property''s timezone '
  '(check_in < property today — mark_no_show''s own predicate, so an 11pm '
  'same-day arrival is never touched) is resolved so its room is freed — '
  'cancel_booking for a walk-in (no charge), mark_no_show for a corporate '
  'booking (one night at the locked rate under the noshow:<booking> key, plus a '
  'front-desk follow-up notice naming the company). Both terminal states are '
  'released by count_available, whose no_show default 029 flipped. Idempotent '
  'three times over: only still-confirmed rows are selected, each is re-read FOR '
  'UPDATE before acting, and the RPCs are idempotent by state with the charge '
  'guarded by a unique index. mark_no_show REMAINS a manual front-desk action '
  'for the same-day call. SAFE TO RE-RUN: a repeat run posts nothing and '
  'resolves nothing.';

-- Grants unchanged from 024 §5 (create-or-replace preserves them); re-asserted.
revoke execute on function run_night_audit(uuid, date) from public;
revoke execute on function run_night_audit(uuid, date) from anon;
grant  execute on function run_night_audit(uuid, date) to authenticated;
grant  execute on function run_night_audit(uuid, date) to service_role;

-- count_available's signature is unchanged (only a default moved), so
-- create-or-replace preserved 015 §10's grants; re-asserted explicitly.
revoke execute on function count_available(uuid, uuid, date, date, uuid, boolean) from public;
revoke execute on function count_available(uuid, uuid, date, date, uuid, boolean) from anon;
grant  execute on function count_available(uuid, uuid, date, date, uuid, boolean) to authenticated;

-- ============================================================================
-- End of 029_auto_resolve_uncollected_bookings.sql
-- ============================================================================
