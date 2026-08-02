-- ============================================================================
-- 025_expected_arrival_time.sql
-- Palstro-Hotels: the EXPECTED arrival time a guest gives when booking.
--
-- ----------------------------------------------------------------------------
-- WHAT THIS IS FOR
-- ----------------------------------------------------------------------------
-- A guest says "we land late, we'll be at the hotel around ten". Today there is
-- nowhere to put that, so it goes in special_requests if it goes anywhere, and
-- at 20:00 the desk is looking at an empty room wondering whether to start
-- chasing. This migration gives the sentence a home.
--
-- ----------------------------------------------------------------------------
-- WHAT THIS IS *NOT* FOR — READ THIS BEFORE USING THE COLUMN
-- ----------------------------------------------------------------------------
--
--  ┌──────────────────────────────────────────────────────────────────────────┐
--  │  expected_arrival_time IS INFORMATIONAL. NOTHING READS IT.               │
--  │  It does not price a stay, hold a room, move a business date, or decide  │
--  │  a no-show. It is a note for a human being.                              │
--  └──────────────────────────────────────────────────────────────────────────┘
--
-- The temptation this comment exists to kill: "a booking with an expected
-- arrival of 22:00 should not be a no-show candidate until 22:00". It already
-- is not. 024 §4's mark_no_show refuses to run until the RESERVED ARRIVAL DAY IS
-- FULLY OVER in the property's timezone (check_in >= today raises), so a guest
-- has until local midnight whatever they said, and a 22:00 arrival was never at
-- risk. Wiring this column into that guard would replace a rule that is right by
-- construction with one that depends on a field somebody may have typed wrong —
-- and the failure mode is a real, paying guest marked no_show and, on a
-- guaranteed booking, CHARGED for it. The desk decides; this column only tells
-- them what to expect.
--
-- Likewise it is NOT the arrival. bookings.checked_in_at / actual_check_in (024
-- §1) record what actually happened, are set at the desk, and are what the night
-- audit bills from. This is what somebody SAID would happen, set at booking time,
-- and is never reconciled against the other two — a guest who said 22:00 and
-- walked in at 01:30 is not a discrepancy to resolve, just a guest who was late.
--
-- ----------------------------------------------------------------------------
-- WHAT CHANGES
-- ----------------------------------------------------------------------------
--   §1  bookings gains ONE nullable column.
--   §2  create_booking accepts and stores it. Nothing else in that function
--       moves — see the section header for the exhaustive diff.
--
-- UNTOUCHED, byte-for-byte: run_night_audit, mark_no_show, check_in_booking,
-- check_out_booking, cancel_booking, post_charge, post_room_night_charge,
-- apply_charge_discount, folio_totals, folio_balance, count_available,
-- resolve_booking_rate, resolve_booking_rate_detail, next_monthly_document_number
-- and every pricing path. No RLS policy changes, no new tables, no seed data,
-- no index (the column is never filtered or joined on — adding one would be a
-- write cost paid for a read nobody performs).
-- ============================================================================


-- ############################################################################
-- SECTION 1 — the column
-- ############################################################################
--
-- `time` (time WITHOUT time zone), not timestamptz and not text:
--
--   * NOT timestamptz — there is no instant here. "Around ten" is a wall-clock
--     reading against the arrival day the booking already carries; storing it as
--     an instant would force us to invent a date and a zone at booking time and
--     then keep them correct if the dates are ever changed. A bare time cannot
--     drift, because it never claimed to know the day.
--   * NOT text — Postgres validates a `time` on write, so '25:70' and 'evening'
--     are rejected at the database rather than discovered by a formatter three
--     screens later. §6's reasoning for typing money as numeric, applied to a
--     clock reading.
--   * NULLABLE, with no default. NULL means THE GUEST DID NOT SAY, which is the
--     common case and a genuinely different fact from "they said 14:00". A
--     default of the property's standard check-in time would put an answer
--     nobody gave onto every booking ever taken, and the desk would learn within
--     a week to ignore the field entirely.
--
-- NO BACKFILL, for the same reason 024 §1 refused one: this records something a
-- person said, and there is nothing truthful to write for the bookings taken
-- before the field existed.
alter table bookings
  add column if not exists expected_arrival_time time;

comment on column bookings.expected_arrival_time is
  'The time the guest EXPECTS to reach the desk, as told at booking ("arriving '
  '~22:00"). PURELY INFORMATIONAL — NOTHING IN THE SCHEMA READS IT. It does not '
  'affect pricing, availability, the business date, or the no-show guard '
  '(mark_no_show already waits for the whole reserved arrival DAY to end in the '
  'property''s timezone, so a late-evening arrival is never a no-show). NULL '
  'means the guest did not say, which is different from saying an early time. '
  'Distinct from checked_in_at / actual_check_in, which record the arrival that '
  'ACTUALLY happened and are what the night audit bills from; this is never '
  'reconciled against them.';


-- ############################################################################
-- SECTION 2 — create_booking: accept and store it
-- ############################################################################
--
-- WHY THIS FUNCTION HAD TO BE TOUCHED AT ALL, stated plainly because the column
-- was meant to be the whole change: `bookings` has NO insert policy and NO
-- update policy, by design (015 §9) — create_booking is the only path that ever
-- writes a booking row. A column with no path through this function is a column
-- that can never hold a value.
--
-- WHAT CHANGED FROM 020, EXHAUSTIVELY:
--   + a twelfth parameter, p_expected_arrival_time time default null;
--   + expected_arrival_time in the INSERT's column list and values list.
-- That is the entire diff. UNCHANGED and copied verbatim: the property read, the
-- property-local v_today derivation, the past-check-in guard (020), the
-- is_tenant_staff gate, the idempotency fast path, every cheap validation, the
-- company and guest tenant checks, SELECT room_types ... FOR UPDATE (THE
-- OVERBOOKING GUARD), the occupancy limits, count_available under the held lock,
-- next_monthly_document_number (019), the per-night pricing loop through
-- resolve_booking_rate_detail (016), the unique_violation race handler (rules
-- 2/3), SECURITY DEFINER, the pinned search_path and the returns type.
--
-- THE NEW PARAMETER IS INERT. It is validated by the column's own type and by
-- nothing else, it is not consulted by any guard, and it is written in the same
-- INSERT as the rest of the row — so it cannot fail independently, cannot leave
-- a booking half-created, and cannot change which bookings are accepted. A
-- booking taken with it and a booking taken without it follow identical code.
--
-- DROP-then-CREATE, exactly as 024 §2 had to for check_in_booking: the new
-- parameter is defaulted, so an eleven-argument call would match BOTH the old
-- and the new signature and Postgres would raise "function is not unique" on
-- every existing call site. Dropping is safe — bookings has no insert policy, so
-- nothing but this RPC has ever been able to create a booking. The grant is
-- re-issued in §3 because DROP takes the privileges with it.
drop function if exists create_booking(uuid, uuid, uuid, date, date, integer, text, integer, text, text, uuid);

create or replace function create_booking(
  p_property_id     uuid,
  p_room_type_id    uuid,
  p_guest_id        uuid,
  p_check_in        date,
  p_check_out       date,
  p_adults          integer,
  p_idempotency_key text,
  p_children        integer default 0,
  p_special_requests text   default null,
  p_bill_to         text    default 'guest',
  p_company_id      uuid    default null,
  -- >>> THE 025 ADDITION <<< Informational only; see §1. Defaulted so a caller
  -- that never asks the question passes nothing and gets NULL.
  p_expected_arrival_time time default null
)
returns bookings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant_id    uuid;
  v_timezone     text;                     -- property-local tz for the booking-number month
  v_prefix       text;                     -- per-property booking-number prefix (NULL -> 'HB')
  v_today        date;                     -- property-local "today", the earliest allowed check-in
  v_max_adults   integer;
  v_max_children integer;
  v_inventory    integer;
  v_available    integer;
  v_existing     bookings;
  v_booking      bookings;
  v_number       text;
  v_actor        uuid := auth.uid();     -- the real caller; set on created_by explicitly
  v_date         date;
  v_rate         numeric(14,2);
  v_source       text;
begin
  -- Resolve the owning tenant from the property (needed before we touch the room
  -- type: for the admin gate and the idempotency lookup). Also pull timezone and
  -- the booking-number prefix on this SAME read — both feed the number generator
  -- below, at no extra round-trip.
  select p.tenant_id, p.timezone, p.booking_number_prefix
    into v_tenant_id, v_timezone, v_prefix
  from properties p
  where p.id = p_property_id and p.deleted_at is null;

  if v_tenant_id is null then
    raise exception 'Property % not found or inactive', p_property_id
      using errcode = 'no_data_found';
  end if;

  -- Property-local "today". Computed in the PROPERTY's own timezone from the same
  -- now() the booking number uses, so it is Lagos-today, not UTC-today — a booking
  -- taken at 00:30 local is not bumped to "yesterday". Blank tz falls back to
  -- Africa/Lagos defensively, mirroring next_monthly_document_number.
  v_today := (now() at time zone coalesce(nullif(btrim(v_timezone), ''), 'Africa/Lagos'))::date;

  -- Staff gate (rule 19: RLS is the floor; this is the RPC's own guard). Booking
  -- is a STAFF operation — any active member of the tenant may create one, not
  -- just owners/managers. Pricing edits remain admin-only (is_tenant_admin).
  if not is_tenant_staff(v_tenant_id) then
    raise exception 'Not authorised to create bookings for this tenant'
      using errcode = 'insufficient_privilege';
  end if;

  -- IDEMPOTENCY fast path (rules 2 & 3): a repeat call with the same key returns
  -- the SAME booking. The partial unique index bookings_idem_uniq is the true
  -- guard under concurrency (handled in the exception block below); this lookup
  -- just short-circuits the common retry case without raising.
  if p_idempotency_key is not null then
    select * into v_existing
    from bookings
    where tenant_id = v_tenant_id
      and idempotency_key = p_idempotency_key
    limit 1;
    if found then
      return v_existing;
    end if;
  end if;

  -- Cheap validation before we take any lock.
  --
  -- NOTE (025): p_expected_arrival_time is deliberately NOT validated here.
  -- There is nothing to validate — `time` rejects a malformed value at the
  -- column, any hour of the day is a legitimate thing for a guest to say
  -- (including 03:00, which is a red-eye, not a mistake), and the value is
  -- compared against nothing. A guard here could only reject truthful input.

  -- >>> THE 020 CHANGE <<< Reject a check-in strictly BEFORE the property's local
  -- today. The form also sets the input's min to today (convenience); the RPC is
  -- the LAW so no form bug or direct call can slip a past reservation in. Only
  -- strictly-before-today is refused — check_in == today is ALLOWED (same-day
  -- walk-ins are the commonest booking). NOTE: this guards CREATE only. Modifying
  -- an existing booking's dates carries the same "not in the past" rule for the
  -- NEW check-in, but a booking already checked-in / in progress is a separate
  -- concern; those date rules ship WITH the modify flow, not here.
  if p_check_in < v_today then
    raise exception 'Check-in date % is in the past; the earliest allowed is today (%)',
      p_check_in, v_today using errcode = 'check_violation';
  end if;

  if p_check_out <= p_check_in then
    raise exception 'check_out (%) must be after check_in (%)', p_check_out, p_check_in
      using errcode = 'check_violation';
  end if;
  if p_adults is null or p_adults < 1 then
    raise exception 'A booking needs at least one adult'
      using errcode = 'check_violation';
  end if;
  if coalesce(p_children, 0) < 0 then
    raise exception 'children cannot be negative'
      using errcode = 'check_violation';
  end if;
  if p_bill_to not in ('guest','company') then
    raise exception 'bill_to must be ''guest'' or ''company'', got %', p_bill_to
      using errcode = 'check_violation';
  end if;

  -- If billing to a company, the company must belong to THIS tenant and be live.
  -- (The bookings table has no company_id FK — 015 left it unconstrained as a
  -- forward reference — so this RPC is where cross-tenant company use is caught.)
  if p_company_id is not null then
    if not exists (
      select 1 from companies
      where id = p_company_id and tenant_id = v_tenant_id and deleted_at is null
    ) then
      raise exception 'Company % not found for this tenant', p_company_id
        using errcode = 'no_data_found';
    end if;
  end if;

  -- Guest must exist within this tenant (the composite FK enforces it too, but a
  -- clear error beats a raw FK violation).
  if not exists (
    select 1 from guests
    where id = p_guest_id and tenant_id = v_tenant_id and deleted_at is null
  ) then
    raise exception 'Guest % not found for this tenant', p_guest_id
      using errcode = 'no_data_found';
  end if;

  -- ================= THE OVERBOOKING GUARD (015 §7, unchanged) ==============
  -- Lock the room_types ROW and, in the SAME read, pull the occupancy limits and
  -- the availability denominator. FOR UPDATE serialises same-type creation;
  -- deleted_at NULL-safe (rule 5) — a soft-deleted type cannot be booked.
  select rt.max_adults, rt.max_children, rt.inventory_count
    into v_max_adults, v_max_children, v_inventory
  from room_types rt
  where rt.id = p_room_type_id
    and rt.property_id = p_property_id
    and rt.deleted_at is null
  for update;

  if not found then
    raise exception 'Room type % not found for this property', p_room_type_id
      using errcode = 'no_data_found';
  end if;

  -- Occupancy limits are a property of the room type.
  if p_adults > v_max_adults then
    raise exception 'Room type allows at most % adults, got %', v_max_adults, p_adults
      using errcode = 'check_violation';
  end if;
  if coalesce(p_children, 0) > v_max_children then
    raise exception 'Room type allows at most % children, got %',
      v_max_children, coalesce(p_children, 0) using errcode = 'check_violation';
  end if;

  -- With the lock HELD, this count cannot go stale under us (that is the whole
  -- point). p_exclude null: a brand-new booking excludes nothing.
  v_available := count_available(p_property_id, p_room_type_id, p_check_in, p_check_out, null);
  if v_available <= 0 then
    raise exception 'No availability: room type % is fully booked for % to %',
      p_room_type_id, p_check_in, p_check_out using errcode = 'check_violation';
  end if;

  -- Per-(tenant, property, MONTH) booking number in the PREFIX-MMYY-NNN format
  -- (019) — still generated here, never count(*)+1 (015 §2). Prefix resolves
  -- per-property, falling back to 'HB'; the month is computed in the property's
  -- own timezone inside the generator.
  v_number := next_monthly_document_number(
    v_tenant_id, p_property_id, 'booking',
    coalesce(nullif(btrim(v_prefix), ''), 'HB'), v_timezone);

  -- Insert the booking. created_by set EXPLICITLY because this is SECURITY
  -- DEFINER (the set_row_audit trigger also stamps auth.uid(); the brief requires
  -- it be explicit here so the intent is unmistakable). All inserts wrapped by
  -- the idempotency-race handler below.
  --
  -- 025: expected_arrival_time rides along in this SAME insert — one statement,
  -- so the note either lands with the booking or the whole booking rolls back.
  -- There is no second write to half-fail.
  begin
    insert into bookings (
      tenant_id, property_id, room_type_id, guest_id, booking_number,
      check_in, check_out, adults, children, status,
      bill_to, company_id, special_requests, expected_arrival_time,
      idempotency_key, created_by
    ) values (
      v_tenant_id, p_property_id, p_room_type_id, p_guest_id, v_number,
      p_check_in, p_check_out, p_adults, coalesce(p_children, 0), 'confirmed',
      p_bill_to, p_company_id, p_special_requests, p_expected_arrival_time,
      p_idempotency_key, v_actor
    )
    returning * into v_booking;

    -- Lock the rate PER NIGHT over the half-open range [check_in, check_out).
    -- Pricing flows through the COMPANY resolver (016 §4), so a company booking
    -- locks its negotiated rate per night just as a walk-in locks rack. p_company_id
    -- NULL (a walk-in) yields the identical rack pricing. resolve_booking_rate_detail
    -- gives rate AND source so the audit trail is complete (rack/weekend/seasonal,
    -- or company_fixed/company_percentage). Any NULL rate here (type vanished
    -- mid-transaction) would violate booking_nights.rate NOT NULL and roll the
    -- whole booking back — fail-safe.
    --
    -- 025 changes NOTHING here. The expected arrival time is not a night, not a
    -- rate and not a date the loop can see: the range is still [check_in,
    -- check_out) and the same nights are locked at the same prices as before.
    v_date := p_check_in;
    while v_date < p_check_out loop
      select rate, source into v_rate, v_source
      from resolve_booking_rate_detail(p_room_type_id, v_date, p_company_id);

      insert into booking_nights (
        tenant_id, property_id, booking_id, stay_date, rate, rate_source, created_by
      ) values (
        v_tenant_id, p_property_id, v_booking.id, v_date, v_rate, v_source, v_actor
      );

      v_date := v_date + 1;
    end loop;

  exception
    when unique_violation then
      -- A CONCURRENT call with the same idempotency key won the race and inserted
      -- first (bookings_idem_uniq). Its row is now committed/visible; return it
      -- instead of creating a duplicate (rule 2). This is the DB-level guard that
      -- backs the fast-path lookup above.
      if p_idempotency_key is not null then
        select * into v_existing
        from bookings
        where tenant_id = v_tenant_id
          and idempotency_key = p_idempotency_key
        limit 1;
        if found then
          return v_existing;
        end if;
      end if;
      raise;   -- any other unique violation is a real error
  end;

  return v_booking;
end;
$$;

comment on function create_booking(uuid, uuid, uuid, date, date, integer, text, integer, text, text, uuid, time) is
  'THE booking creation path (015 §7 / 016 §4 / 019 / 020). 025 adds ONE inert '
  'parameter, p_expected_arrival_time — the time the guest said they would '
  'arrive, stored on the booking and read by NOTHING: it does not price, hold, '
  'validate or schedule anything, and it plays no part in the no-show rules. It '
  'is written in the same INSERT as the rest of the row, so it cannot fail on '
  'its own. Everything else is byte-for-byte 020: refuses a check-in strictly '
  'before the property-local today (same-day allowed), booking number is '
  'PREFIX-MMYY-NNN resetting monthly per property (019), idempotent (rules 2/3, '
  'bookings_idem_uniq) and UN-DOUBLE-BOOKABLE (SELECT FOR UPDATE on room_types). '
  'No other code path may insert a booking. SECURITY DEFINER, staff-gated.';


-- ############################################################################
-- SECTION 3 — Function grant (re-issued: the old signature was DROPPED)
-- ############################################################################
-- §2 dropped create_booking(…, uuid) and created create_booking(…, uuid, time),
-- which discarded 020's grant. Re-issue it on the NEW signature — authenticated
-- staff only, never anon. The eleven-argument signature no longer exists, so
-- there is nothing left to revoke from it.
revoke execute on function create_booking(uuid, uuid, uuid, date, date, integer, text, integer, text, text, uuid, time) from public;
revoke execute on function create_booking(uuid, uuid, uuid, date, date, integer, text, integer, text, text, uuid, time) from anon;
grant  execute on function create_booking(uuid, uuid, uuid, date, date, integer, text, integer, text, text, uuid, time) to authenticated;

-- ============================================================================
-- End of 025_expected_arrival_time.sql
-- ============================================================================
