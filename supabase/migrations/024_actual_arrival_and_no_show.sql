-- ============================================================================
-- 024_actual_arrival_and_no_show.sql
-- Palstro-Hotels: ACTUAL ARRIVAL CAPTURE and NO-SHOW HANDLING.
--
-- ----------------------------------------------------------------------------
-- THE PROBLEM THIS MIGRATION EXISTS TO FIX
-- ----------------------------------------------------------------------------
-- 016 §6's check_in_booking only flips a status. It records NOTHING about when
-- the guest actually walked through the door. So the system had exactly one set
-- of dates — the RESERVED ones — and used them for two different questions:
--
--     "what did the guest BOOK?"      -> bookings.check_in / check_out
--     "what did the guest SLEEP?"     -> ...the same columns, wrongly.
--
-- Those two answers diverge constantly. A guest books the 30th, their flight is
-- cancelled, and they arrive on the 1st. 023's night audit walks every night in
-- [check_in, check_out) and charges it, so that guest is billed for the 30th and
-- the 31st — two nights in an EMPTY room. The guest disputes it at checkout, the
-- front desk voids two charges by hand, and the hotel's occupancy report has
-- already counted a room that nobody slept in. Every one of those is downstream
-- of the same missing fact: WHEN DID THEY ACTUALLY ARRIVE.
--
-- This migration records that fact and makes the night audit charge from it.
--
-- The mirror case is the guest who never arrives at all. Today they sit as
-- 'confirmed' forever, holding inventory (015 RULE 4), invisible except as a
-- line in the audit's not_checked_in list. §4 adds the explicit front-desk act
-- that resolves them, and the ONE charge rule that decides whether they owe
-- anything.
--
-- ----------------------------------------------------------------------------
-- WHAT IS NOT TOUCHED, AND WHY THAT MATTERS
-- ----------------------------------------------------------------------------
-- post_charge, post_room_night_charge, apply_charge_discount, folio_totals,
-- folio_balance, booking_nights, create_booking, count_available and every
-- pricing path are BYTE-FOR-BYTE as 021/015/016 left them. Nothing here prices
-- anything: the no-show charge is the rate LOCKED in booking_nights for the
-- reserved first night, and the night audit still delegates every posting to
-- post_room_night_charge. Three things change and nothing else:
--
--   §1  bookings gains two nullable columns (checked_in_at, actual_check_in);
--   §2  check_in_booking captures them;
--   §3  run_night_audit's DATE PREDICATE charges from the actual arrival;
--   §4  mark_no_show is new.
-- ============================================================================


-- ############################################################################
-- SECTION 1 — the two arrival columns
-- ############################################################################
--
--  ┌──────────────────────────────────────────────────────────────────────────┐
--  │  RESERVED check_in  = what was BOOKED. Set at booking time, by the guest. │
--  │  ACTUAL   arrival   = when they PHYSICALLY TURNED UP. Set at the desk.    │
--  │  They differ often, and ACTUAL is what drives charging.                   │
--  └──────────────────────────────────────────────────────────────────────────┘
--
-- TWO columns, not one, because they answer two questions that must not be
-- conflated:
--
--   * checked_in_at (timestamptz) is the INSTANT — 02:14 on the 1st. It is the
--     audit fact: "who was on the desk, at what moment". Stored as an instant
--     because an instant is unambiguous everywhere on earth.
--   * actual_check_in (date) is the BUSINESS DATE that instant fell on IN THE
--     PROPERTY'S TIMEZONE (§6 "Business date"; rules 8 and 12). It is the
--     OPERATIONAL fact: which night the stay starts billing from. Derived once,
--     at check-in, and stored — never recomputed at read time, because a stored
--     business date cannot drift when a property's timezone setting is edited
--     later, and every report that groups by it would otherwise silently
--     re-group history.
--
-- Both NULLABLE, deliberately: a booking that has not been checked in has no
-- arrival, and NULL is the honest representation of "has not happened yet". A
-- default of now() would assert that every confirmed reservation has already
-- arrived, which is exactly the lie this migration removes.
--
-- NO BACKFILL. Existing checked_in / checked_out bookings keep NULL, and §3's
-- fallback treats NULL as "arrival was the reserved check-in" — the assumption
-- the system was already making implicitly. Writing a guessed arrival date into
-- a column whose entire purpose is to record an OBSERVED fact would poison it
-- with fiction on day one.
alter table bookings
  add column if not exists checked_in_at   timestamptz,
  add column if not exists actual_check_in date;

comment on column bookings.checked_in_at is
  'The INSTANT the guest physically arrived, recorded by the front desk at '
  'check-in (defaults to now(), but is EDITABLE — a 02:00 arrival is commonly '
  'keyed in at 08:00 the next morning). NULL until checked in. Audit fact: '
  '"when exactly". Distinct from created_at, which is when the ROW was made.';

comment on column bookings.actual_check_in is
  'The BUSINESS DATE of the arrival — checked_in_at''s date in the PROPERTY''s '
  'timezone — and THE DATE THAT DRIVES CHARGING. bookings.check_in is what was '
  'RESERVED; this is when they actually turned up, set by the front desk. The '
  'two differ often (a guest who books the 30th and arrives on the 1st), and '
  'the night audit bills from THIS one so the empty nights are never charged. '
  'NULL until checked in; the audit then falls back to the reserved check_in.';

-- The night audit's per-property scan now filters on the arrival date as well as
-- the reserved range, so the availability index alone no longer covers it.
create index if not exists bookings_actual_check_in_idx
  on bookings (property_id, actual_check_in);


-- ############################################################################
-- SECTION 2 — check_in_booking: capture the arrival
-- ############################################################################
--
-- WHAT CHANGED FROM 016 §6, exhaustively (nothing else in this function moved):
--   + a third parameter, p_arrival_at timestamptz default null;
--   + v_timezone / v_arrival_at / v_actual_date locals;
--   + a read of properties.timezone;
--   + the UPDATE also sets checked_in_at and actual_check_in.
-- UNCHANGED: the row lock, the not-found raise, the is_tenant_staff gate, the
-- idempotent-by-state early return, the confirmed-only status guard, the
-- updated_by stamp, SECURITY DEFINER, the pinned search_path, and the returns
-- type. The transition itself is identical; it now records WHEN.
--
-- WHY p_arrival_at IS A PARAMETER AND NOT JUST now():
-- The front desk does not always press the button at the moment the guest walks
-- in. A 02:00 walk-in is checked in on the system at 08:00 when the day shift
-- arrives; a guest whose room was not ready waits in the bar and is processed
-- an hour later. If the system stamped now() unconditionally, that 02:00 arrival
-- would be recorded on the WRONG BUSINESS DATE roughly every time it happened
-- after the night-audit cutoff — and the wrong business date means a night
-- billed that should not have been, or one missed that should have been. So the
-- desk passes the arrival it observed; now() is only the DEFAULT.
--
-- WHY THE DATE IS DERIVED IN THE PROPERTY'S TIMEZONE:
-- Identical reasoning to 020's past-date guard, 021 §9.1's charge date and 023's
-- business date, and it must agree with all three or the same stay will be
-- filed under two different days. Lagos is UTC+1, so between 23:00 and midnight
-- local the UTC date is already the day before: a UTC-derived arrival date would
-- be wrong for one hour every single day, invisibly. Same 'Africa/Lagos'
-- fallback for a blank column as every other timezone read in the schema.
--
-- DROP-then-CREATE rather than create-or-replace: the signature GAINS a
-- parameter, and a defaulted third argument would make check_in_booking(uuid,
-- text) ambiguous against the old two-argument function (Postgres would raise
-- "function is not unique" on every existing two-argument call). Dropping is
-- safe — bookings has no update RLS policy, so nothing but this RPC has ever
-- been able to perform the transition. The grant is re-issued in §5 because DROP
-- takes the privileges with it.
drop function if exists check_in_booking(uuid, text);

create or replace function check_in_booking(
  p_booking_id      uuid,
  p_idempotency_key text        default null,
  p_arrival_at      timestamptz default null
)
returns bookings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking     bookings;
  v_actor       uuid := auth.uid();
  v_timezone    text;
  v_arrival_at  timestamptz;
  v_actual_date date;
begin
  select * into v_booking
  from bookings
  where id = p_booking_id and deleted_at is null
  for update;

  if not found then
    raise exception 'Booking % not found', p_booking_id using errcode = 'no_data_found';
  end if;

  if not is_tenant_staff(v_booking.tenant_id) then
    raise exception 'Not authorised to update this booking'
      using errcode = 'insufficient_privilege';
  end if;

  if v_booking.status = 'checked_in' then
    -- Idempotent by state, and deliberately NON-DESTRUCTIVE: a repeat call does
    -- NOT overwrite checked_in_at. The first check-in is the one that observed
    -- the arrival; a double-click six seconds later, or a retry after a network
    -- timeout that was actually delivered, must not quietly move the recorded
    -- arrival time (and with it, possibly, the business date that decides which
    -- nights are billed). Correcting a mis-keyed arrival is a separate,
    -- deliberate act — not something a retry can do by accident.
    return v_booking;
  end if;

  if v_booking.status <> 'confirmed' then
    raise exception 'Only a confirmed booking can be checked in (status is %)',
      v_booking.status using errcode = 'check_violation';
  end if;

  -- The arrival instant: what the desk observed, or now() when they said nothing.
  v_arrival_at := coalesce(p_arrival_at, now());

  select p.timezone into v_timezone
  from properties p
  where p.id = v_booking.property_id;

  -- The business date of that instant, PROPERTY-LOCAL (see the header).
  v_actual_date := (v_arrival_at at time zone
                     coalesce(nullif(btrim(v_timezone), ''), 'Africa/Lagos'))::date;

  update bookings
    set status          = 'checked_in',
        checked_in_at   = v_arrival_at,
        actual_check_in = v_actual_date,
        updated_by      = v_actor
  where id = p_booking_id
  returning * into v_booking;

  -- FOLIO: the folio already exists (021 §5 opens one per booking at insert) and
  -- room nights post at the NIGHT AUDIT, not here (021 DECISION 2) — which is
  -- precisely why actual_check_in must be stored: the audit reads it hours later
  -- to decide which nights this stay owes.
  return v_booking;
end;
$$;

comment on function check_in_booking(uuid, text, timestamptz) is
  'Transitions a confirmed booking -> checked_in AND RECORDS THE ARRIVAL: '
  'checked_in_at (the instant, from p_arrival_at or now()) and actual_check_in '
  '(that instant''s date in the PROPERTY''s timezone). p_arrival_at is editable '
  'by the front desk because a 02:00 walk-in is routinely keyed in the next '
  'morning, and the business date decides which nights the audit bills. '
  'Staff-gated, idempotent by state and non-destructive on a repeat call (the '
  'recorded arrival is never overwritten by a retry). SECURITY DEFINER.';


-- ############################################################################
-- SECTION 3 — run_night_audit charges from the ACTUAL arrival
-- ############################################################################
--
--  ┌──────────────────────────────────────────────────────────────────────────┐
--  │  A ROOM NIGHT IS BILLED ONLY IF SOMEBODY WAS IN THE ROOM THAT NIGHT.     │
--  └──────────────────────────────────────────────────────────────────────────┘
--
-- THE ONLY CHANGE TO THE POSTING LOOP IS ITS DATE PREDICATE. Everything else in
-- this function is byte-for-byte 023 §2: the property lookup, the staff gate,
-- the property-local "yesterday" derivation, the per-booking subtransaction, the
-- pre-read of the idempotency key, the delegation to post_room_night_charge, the
-- error capture, and the not_checked_in report. It still orchestrates only — it
-- does not price, does not choose a rate, and writes no folio row itself.
--
-- BEFORE:  b.check_in                                   <= v_date < b.check_out
-- AFTER :  greatest(coalesce(b.actual_check_in,
--                            b.check_in), b.check_in)   <= v_date < b.check_out
--
-- Read the new start date outward-in:
--
--   coalesce(actual_check_in, check_in)
--       CHARGE FROM WHEN THEY ARRIVED. The fallback to the reserved check_in
--       applies only when actual_check_in is somehow NULL — a stay checked in
--       before this migration shipped (§1 deliberately does not backfill), or a
--       row whose status was moved by a future path that forgot to record the
--       arrival. In that case the audit behaves EXACTLY as 023 did, which is the
--       right failure mode: unchanged behaviour, never a skipped night.
--
--   greatest(..., check_in)
--       NEVER CHARGE BEFORE THE FIRST RESERVED NIGHT. An EARLY arrival (guest
--       booked the 5th, walked in on the 4th) has no booking_nights row for the
--       4th, because nights are locked at booking time over the reserved range
--       only (015 §5). post_room_night_charge would raise 'has no night on
--       2026-01-04' and the audit would log an error for that booking every
--       night of the stay. There is no locked rate for a night nobody reserved,
--       and INVENTING one here would re-price a stay from today's rate tables —
--       the exact correctness/trust failure booking_nights exists to prevent.
--       The correct handling of an early arrival is to EXTEND the booking's
--       dates at the desk (which re-checks availability and locks a rate for the
--       new night); until that happens the audit bills the reserved nights and
--       nothing else. This clause is what keeps that case a clean no-op instead
--       of a nightly error.
--
-- The half-open convention is UNCHANGED and still governs the far end: the
-- predicate is [charge_from, check_out), check_out EXCLUSIVE, so the departure
-- day is never a night (015 RULES 1 & 2). The worked example from the brief: a
-- booking reserving the 30th with actual arrival on the 1st and check_out on the
-- 3rd is charged for the 1st and the 2nd — never the 30th, the 31st, or the 3rd.
--
-- IDEMPOTENCY IS COMPLETELY UNAFFECTED. The key post_room_night_charge builds is
-- still 'room:<booking>:<date>' and folio_charges_idem_uniq is still what
-- enforces it (rule 3). Narrowing WHICH nights are considered cannot create a
-- second charge for a night: the key does not contain the arrival date, so a
-- re-run — including a re-run AFTER the arrival was corrected — returns the
-- existing charge for every night it still selects and writes nothing.
--
-- WHAT A NARROWED WINDOW DOES *NOT* DO, STATED PLAINLY (rule 7's neighbourhood):
-- it does not un-post a night that was already charged. If an audit ran against
-- the old logic and billed the 30th, the charge is still there; this function
-- will simply never post it again, and it will not void it either. Reversing a
-- posted charge is a person's decision with a reason attached (void_reason), not
-- something an unattended cron may do silently — a cron that could delete
-- revenue on a rule change is a far worse failure than one that leaves a visible
-- charge for a human to void. The Folio tab is where that void happens.
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

  -- The no-show candidate list is REPORTED IN FULL AS A COUNT but capped as a
  -- LIST, because it is the one set here that can grow without bound: every
  -- confirmed booking the desk never resolved stays a candidate forever. A cron
  -- summary that silently truncated would read as "only 100 to deal with", so
  -- the count is always exact and a truncated flag says so out loud (rule 1's
  -- reasoning applied to a machine-readable summary rather than a screen).
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

  -- --------------------------------------------------------------------------
  -- The in-house set: bookings whose OCCUPIED range contains the night.
  -- --------------------------------------------------------------------------
  -- charge_from is the section header's expression: the actual arrival, falling
  -- back to the reserved check-in, floored at the reserved check-in. The far end
  -- is unchanged — v_date < check_out, half-open, so the departure day is not a
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
      -- The ONLY write this function causes, and it is somebody else's function.
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

  -- --------------------------------------------------------------------------
  -- Reported, never charged (1/3): reserved this night, but ARRIVED LATER.
  -- --------------------------------------------------------------------------
  -- The set this migration newly EXCLUDES from billing, surfaced so the change
  -- is observable rather than silent. These are checked-in stays whose reserved
  -- range covers the audited night but whose actual arrival was after it — the
  -- guest who booked the 30th and turned up on the 1st. Before 024 each of these
  -- produced a charge for a night in an empty room; now they produce a line
  -- here. An operator comparing today's in_house against yesterday's can see
  -- exactly where the difference went.
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
  -- Unchanged from 023. An empty list here is the normal, healthy result; a
  -- non-empty one means the front desk has arrivals to resolve — press check-in,
  -- or mark the booking no_show.
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
  -- Reported, never charged, NEVER AUTO-ACTIONED (3/3): no-show CANDIDATES.
  -- --------------------------------------------------------------------------
  --
  --  ┌────────────────────────────────────────────────────────────────────────┐
  --  │  THE AUDIT REPORTS NO-SHOWS. IT DOES NOT MARK THEM, AND IT DOES NOT    │
  --  │  CHARGE THEM. THAT IS A FRONT-DESK DECISION. (§4 is the action.)       │
  --  └────────────────────────────────────────────────────────────────────────┘
  --
  -- WHY NOT AUTO-FIRE mark_no_show FROM THE CRON, stated plainly because it is
  -- the tempting shortcut:
  --
  --   * A LATE ARRIVAL IS NOT A NO-SHOW. A guest whose flight lands at 01:00 and
  --     who reaches the desk at 02:30 is a paying, in-house guest — but at the
  --     06:00 cutoff a naive rule sees "confirmed, arrival date passed" and
  --     cannot tell them apart from someone who never came. Auto-marking would
  --     set no_show on a guest ASLEEP UPSTAIRS.
  --   * IT WOULD POST MONEY NOBODY DECIDED TO POST. On a guaranteed booking the
  --     auto-mark would also post a night's charge, so the failure above is not
  --     just a wrong status — it is a wrong CHARGE, on a real folio, that the
  --     desk must then find and reverse. 021 DECISION 2 exists to stop exactly
  --     this class of phantom debt.
  --   * A NO-SHOW IS A COMMERCIAL JUDGEMENT. Hotels waive the charge for a
  --     regular, for a corporate account that called ahead, for weather. A cron
  --     cannot weigh any of that, and a policy applied without judgement is the
  --     kind of thing a guest never books again over.
  --
  -- So the audit does the one thing an unattended job should do with an
  -- exception: MAKE IT VISIBLE. The desk decides.
  --
  -- The candidate test is "still confirmed, and its reserved arrival is on or
  -- before the audited night" — the same frame the rest of this function uses,
  -- so a catch-up run for an old date reports what was outstanding THEN rather
  -- than what is outstanding now. It is a SUPERSET of not_checked_in, which only
  -- covers bookings still spanning the audited night; a booking that reserved
  -- the 30th to the 31st and was never resolved stops appearing there after the
  -- 31st but stays a candidate here until somebody acts on it.
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
               -- Whether a charge WOULD apply if the desk marks it — the same
               -- test §4 applies. Reported so the summary shows the money at
               -- stake without anybody having to open each booking.
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
  -- `not_checked_in` or `no_show_candidates` is work for a person. amount_posted
  -- counts ONLY the charges this run created, so a re-run of an already-audited
  -- night reports 0.00 — which is exactly how an operator confirms the retry
  -- changed nothing.
  return jsonb_build_object(
    'property_id',          p_property_id,
    'property_name',        v_property_name,
    'tenant_id',            v_tenant_id,
    'timezone',             v_timezone,
    'night_audit_time',     v_audit_time,
    'business_date',        v_date,
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
    -- New in 024: reserved this night but arrived later, so deliberately unbilled.
    'not_yet_arrived_count', jsonb_array_length(v_not_arrived),
    'not_yet_arrived',       v_not_arrived,
    -- New in 024: reported for a human, never auto-marked and never auto-charged.
    'no_show_candidate_count',     v_candidate_count,
    'no_show_candidates',          v_candidates,
    'no_show_candidates_truncated', v_candidate_count > c_candidate_limit
  );
end;
$$;

comment on function run_night_audit(uuid, date) is
  'Posts one room-night charge for every in-house booking at a property for a '
  'business date, by calling post_room_night_charge (which prices from the '
  'booking_nights lock) — it orchestrates only, it never prices. 024: a night is '
  'charged only from the guest''s ACTUAL arrival (bookings.actual_check_in, '
  'falling back to the reserved check_in when it is null, and never earlier than '
  'the reserved check_in because no rate is locked before it), so a guest who '
  'booked the 30th and arrived the 1st is never billed for the empty nights. '
  'Default date is YESTERDAY in the PROPERTY''s timezone. Confirmed-but-not-'
  'arrived bookings are REPORTED, never charged, and no-show CANDIDATES are '
  'reported too — marking and charging a no-show is a front-desk act '
  '(mark_no_show), never the cron''s, because a 02:00 arrival is not a no-show. '
  'SAFE TO RE-RUN: the deterministic room:<booking>:<date> key plus '
  'folio_charges_idem_uniq mean a repeat run writes nothing.';


-- ############################################################################
-- SECTION 4 — mark_no_show: the explicit front-desk act
-- ############################################################################
--
--  ┌──────────────────────────────────────────────────────────────────────────┐
--  │  THE CHARGE RULE, IN ONE SENTENCE:                                       │
--  │  A COMPANY HELD THE ROOM, SO THEY OWE ONE NIGHT. A WALK-IN COMMITTED     │
--  │  NOTHING, SO THEY OWE NOTHING.                                           │
--  └──────────────────────────────────────────────────────────────────────────┘
--
-- GUARANTEED = company_id is not null OR bill_to = 'company'. Either condition
-- alone is enough, and the OR is deliberate rather than an AND:
--   * company_id set means a corporate account made the reservation against
--     their name — the hotel turned away other guests on that account's word;
--   * bill_to = 'company' means the bill was always going to a company, which is
--     the same commitment expressed at the settlement end.
-- A booking carrying either has an ACCOUNTABLE PARTY the hotel can invoice and a
-- relationship that survives the charge. Requiring both would let a booking with
-- a company attached but bill_to 'guest' escape a charge the company plainly
-- guaranteed.
--
-- NOT GUARANTEED (a walk-in / individual reservation) POSTS NOTHING. Not a zero
-- charge — NOTHING. A guest who left no card and made no commitment owes the
-- hotel nothing for not turning up, and posting a ₦0 line would put a
-- meaningless row on a folio the desk then has to explain. The room being empty
-- is the hotel's loss on an unguaranteed booking; that is what "unguaranteed"
-- MEANS. (When card-on-file guarantees arrive, THIS is the function they extend:
-- one more branch in one place, not a second charge path.)
--
-- ONE NIGHT, AT THE RESERVED FIRST NIGHT'S LOCKED RATE. Not the whole stay: the
-- industry norm is one night's retention, the room can be resold for the rest,
-- and billing five nights nobody slept is the kind of invoice that ends a
-- corporate account. The rate comes from booking_nights for the RESERVED
-- check_in date (015 §5) — the price that was agreed — never a re-resolution
-- from today's rate tables, for the same reason every other posting path reads
-- the lock.
--
-- IDEMPOTENCY IS LOAD-BEARING HERE, TWICE OVER (rules 2 & 3):
--   1. the STATUS transition is idempotent by state — a second call on a booking
--      already marked no_show returns the row unchanged;
--   2. the CHARGE carries the deterministic key 'noshow:<booking_id>', so even a
--      concurrent double-click cannot post two no-show charges: post_charge
--      returns the existing row on the fast path, and folio_charges_idem_uniq
--      (the partial unique index) catches the race that beats it.
-- One booking can therefore be marked no-show any number of times and the folio
-- carries exactly one no-show charge. The key does not include a date or an
-- attempt counter precisely so that stays true forever.
--
-- WHY THE ARRIVAL DATE MUST HAVE PASSED: a booking whose reserved arrival day is
-- still running cannot be judged a no-show — the guest has until the end of that
-- day to walk in, and a 23:00 check-in is an ordinary event. The guard uses the
-- PROPERTY's today (rules 8 and 12), the same derivation as §2 and 023, so a
-- receptionist in another timezone or a shift working past local midnight gets
-- the property's calendar, not their browser's.
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

  -- See the header: the arrival day must be OVER. Today's arrivals are still
  -- arrivals until midnight, property-local.
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
  --
  -- Availability needs nothing: count_available already holds inventory for
  -- no_show by default (015 RULE 4 — the room WAS kept empty for them), and
  -- there is no availability cache to decrement.

  -- ================== THE CHARGE RULE (see the header) ======================
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
  -- and never a literal account code (rules 4 and 17). A no-show retention is
  -- room revenue: the room was held, unsold, for this booking.
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
  'unguaranteed walk-in is charged NOTHING — a company held the room so they owe '
  'a night, a walk-in committed nothing. Staff-gated. Idempotent twice over: by '
  'state on the status, and by the deterministic ''noshow:<booking>'' key on the '
  'charge, so it can never double-charge. NEVER called by the night audit — that '
  'reports candidates only, because a 02:00 arrival is not a no-show and '
  'auto-charging would be wrong.';


-- ############################################################################
-- SECTION 5 — Grants
-- ############################################################################
-- SECURITY DEFINER functions default to EXECUTE for PUBLIC. Revoke, then grant
-- the intended audience only — never anon.
--
-- check_in_booking was DROPPED and recreated in §2 with a new signature, which
-- discarded 016 §8's grant; it is re-issued here. The old two-argument signature
-- no longer exists, so nothing needs revoking from it.
revoke execute on function check_in_booking(uuid, text, timestamptz) from public;
revoke execute on function check_in_booking(uuid, text, timestamptz) from anon;
grant  execute on function check_in_booking(uuid, text, timestamptz) to authenticated;

-- mark_no_show is a FRONT-DESK act, so authenticated staff only — and the
-- service role is REVOKED EXPLICITLY, which is not redundant: Supabase's default
-- privileges grant service_role EXECUTE on every new function in public, so
-- without this line the cron could call it by name.
--
-- STATED HONESTLY, because a comment that overclaims is worse than none: this is
-- a guard against ACCIDENT, not a security boundary. The service role has
-- BYPASSRLS and could update bookings and insert folio_charges directly whatever
-- this grant says. What the revoke buys is that a future server-side job cannot
-- reach the no-show DECISION by simply calling the obvious RPC — it would have
-- to go around the sanctioned path deliberately, which is the kind of thing a
-- reviewer notices. §3's box is the reasoning; this is the latch on the door.
revoke execute on function mark_no_show(uuid, text) from public;
revoke execute on function mark_no_show(uuid, text) from anon;
revoke execute on function mark_no_show(uuid, text) from service_role;
grant  execute on function mark_no_show(uuid, text) to authenticated;

-- run_night_audit's signature is unchanged, so create-or-replace preserved 023's
-- grants; re-asserted explicitly.
revoke execute on function run_night_audit(uuid, date) from public;
revoke execute on function run_night_audit(uuid, date) from anon;
grant  execute on function run_night_audit(uuid, date) to authenticated;
grant  execute on function run_night_audit(uuid, date) to service_role;

-- ============================================================================
-- End of 024_actual_arrival_and_no_show.sql
-- ============================================================================
