-- ============================================================================
-- 020_booking_reject_past_checkin.sql
-- Palstro-Hotels: refuse a booking whose check-in is BEFORE the property's own
-- "today". The form (min= today) is a convenience; THIS is the law.
--
-- WHY: a booking was created for 9 July while the operating day was 28 July. A
-- check-in strictly before today is invalid and must be rejected at the RPC, the
-- one sanctioned booking path, so no form bug or direct RPC call can slip a past
-- reservation in.
--
-- ----------------------------------------------------------------------------
-- THE ONLY CHANGE FROM 019
-- ----------------------------------------------------------------------------
--   * A new cheap validation: reject p_check_in strictly before the property's
--     LOCAL today. "Today" is computed in the PROPERTY's own timezone
--     (properties.timezone, already read by this function in 019 as v_timezone)
--     via (now() AT TIME ZONE tz)::date — the SAME instant + zone the booking
--     number's month uses. So a booking taken at 00:30 Africa/Lagos still allows
--     today's date; it is not pushed a day either way by UTC.
--   * check_in == today is ALLOWED. Same-day walk-ins are the commonest booking
--     of all; ONLY strictly-before-today is refused (p_check_in < v_today).
--
-- EVERYTHING ELSE IS BYTE-FOR-BYTE 019 and load-bearing:
--   * the property read (tenant_id, timezone, prefix) — unchanged, we just derive
--     v_today from the v_timezone it already fetched (no extra round-trip),
--   * SELECT room_types ... FOR UPDATE — the overbooking guard — UNCHANGED,
--   * count_available under the held lock — UNCHANGED,
--   * the idempotency fast-path + unique_violation race handler (rule 2/3) —
--     UNCHANGED,
--   * next_monthly_document_number booking-number generation (019) — UNCHANGED,
--   * the per-night pricing loop via resolve_booking_rate_detail(..., company) —
--     UNCHANGED.
--
-- SCOPE: this guards CREATE only. Modifying an existing booking's dates has the
-- same "new check-in not in the past" rule, BUT a booking already checked-in /
-- in progress is a separate concern — those date rules ship WITH the modify flow
-- (see the guard's inline comment below). We deliberately do not touch modify here.
--
-- Signature is IDENTICAL to 019/016, so this create-or-replace preserves the
-- grant; re-asserted in SECTION 2 to be explicit. No new tables, no RLS changes,
-- no seed data.
-- ============================================================================


-- ############################################################################
-- SECTION 1 — create_booking: add the past-check-in guard (all else UNCHANGED)
-- ############################################################################
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
  p_company_id      uuid    default null
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
  begin
    insert into bookings (
      tenant_id, property_id, room_type_id, guest_id, booking_number,
      check_in, check_out, adults, children, status,
      bill_to, company_id, special_requests, idempotency_key, created_by
    ) values (
      v_tenant_id, p_property_id, p_room_type_id, p_guest_id, v_number,
      p_check_in, p_check_out, p_adults, coalesce(p_children, 0), 'confirmed',
      p_bill_to, p_company_id, p_special_requests, p_idempotency_key, v_actor
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

comment on function create_booking(uuid, uuid, uuid, date, date, integer, text, integer, text, text, uuid) is
  'THE booking creation path (015 §7 / 016 §4 / 019). Now ALSO refuses a check-in '
  'strictly before the property-local today (020) — same-day (check_in = today) is '
  'allowed; only the past is rejected; "today" is computed in properties.timezone. '
  'Booking number is PREFIX-MMYY-NNN, resetting monthly per property via '
  'next_monthly_document_number (019). Every 015/016 guarantee intact: idempotent '
  '(rule 2/3, bookings_idem_uniq) and UN-DOUBLE-BOOKABLE (SELECT FOR UPDATE on '
  'room_types). No other code path may insert a booking. SECURITY DEFINER, staff-gated.';


-- ############################################################################
-- SECTION 2 — Function grant (re-assert; signature unchanged from 019/016)
-- ############################################################################
-- create_booking's signature is unchanged, so the grant carried through the
-- create-or-replace; re-assert it explicitly (authenticated staff only, never anon).
revoke execute on function create_booking(uuid, uuid, uuid, date, date, integer, text, integer, text, text, uuid) from public;
revoke execute on function create_booking(uuid, uuid, uuid, date, date, integer, text, integer, text, text, uuid) from anon;
grant  execute on function create_booking(uuid, uuid, uuid, date, date, integer, text, integer, text, text, uuid) to authenticated;

-- ============================================================================
-- End of 020_booking_reject_past_checkin.sql
-- ============================================================================
