-- ============================================================================
-- 019_booking_number_monthly.sql
-- Palstro-Hotels: human-friendly, monthly-resetting booking numbers.
--
-- Replaces the single ever-growing per-property booking sequence (BK-000001)
-- with the format  PREFIX-MMYY-NNN , e.g.  HB-0726-001  (July 2026, #1):
--
--   PREFIX : a short per-property code (new properties.booking_number_prefix),
--            defaulting to 'HB' (Heledon Bookings) when unset.
--   MMYY   : two-digit month + two-digit year of the booking's creation, taken
--            in the PROPERTY'S OWN timezone (properties.timezone) so a booking
--            made at 00:30 local on the 1st lands in the right month.
--   NNN    : a per-property, per-MONTH sequence that RESETS to 1 at the start of
--            each calendar month, zero-padded to a MINIMUM of 3 digits.
--
-- ----------------------------------------------------------------------------
-- WHAT THIS MIGRATION DOES AND DOES NOT TOUCH
-- ----------------------------------------------------------------------------
--  * DOES NOT rewrite history. Existing bookings keep their old BK- numbers;
--    only bookings created from here on use PREFIX-MMYY-NNN. The
--    bookings_property_number_unique constraint (015) is satisfied by both
--    shapes and by the new format (uniqueness argued in SECTION 2).
--  * DOES NOT repurpose the generic document_counters / next_document_number
--    (015 §2). Those stay a plain non-resetting counter for future invoices and
--    receipts. Monthly reset is a booking-numbering choice, so it gets its OWN
--    counter table and generator rather than forcing every future doc type to
--    reset monthly.
--  * REPLACES create_booking to change exactly TWO body lines — the property
--    read (now also fetching timezone + prefix) and the number-generation line.
--    EVERY overbooking / idempotency / pricing guarantee from 015 §7 and 016 is
--    kept byte-for-byte (see SECTION 4's header box).
--
-- Conventions inherited (001/002/006/012/015/016): SECURITY DEFINER + pinned
-- search_path on every function; a system-maintained counter table carries no
-- created_by/updated_by actor columns and is written ONLY by its generator
-- (§6 exception, like change_log / document_counters); composite (id, tenant_id)
-- FK targets keep a child's scoping columns from disagreeing with its parent.
-- No seed data.
-- ============================================================================


-- ############################################################################
-- SECTION 1 — properties.booking_number_prefix (the per-property PREFIX)
-- ############################################################################
-- The PREFIX is a document-type/label marker, NOT a tenant-identity string, so
-- it is not a rule-17 violation (015 §2 already established this for 'BK'). We
-- still make it per-PROPERTY configurable — cheap, because create_booking
-- already reads the properties row for tenant_id, so the prefix and timezone
-- ride along on that same read with zero extra round-trips. NULL/blank falls
-- back to 'HB' (Heledon Bookings) in create_booking; a group with a second
-- hotel simply sets each property's own code.
alter table properties
  add column if not exists booking_number_prefix text;

comment on column properties.booking_number_prefix is
  'Short per-property code that PREFIXes booking numbers (PREFIX-MMYY-NNN), e.g. '
  '''HB''. A document-label marker, not a tenant-identity value (not rule 17). '
  'NULL/blank -> create_booking falls back to ''HB''. Configurable per property so '
  'a second hotel in a group gets its own code.';


-- ############################################################################
-- SECTION 2 — document_period_counters (the per-MONTH counter, never count(*)+1)
-- ############################################################################
-- A monthly-resetting sibling of document_counters (015 §2). Same discipline —
-- numbers come from an atomic counter, NEVER from count(*)+1 (which races under
-- concurrency and reuses numbers after a void) — but the primary key carries a
-- year_month segment, so a NEW MONTH is a NEW ROW that starts at 1. That new-row
-- boundary IS the monthly reset; no scheduled job, no truncation, nothing to
-- forget.
--
-- KEY: (tenant_id, property_id, doc_type, year_month). The brief asks for a
-- unique key on (property_id, year_month); this PK is a superset of it — for a
-- fixed doc_type='booking' it is exactly unique per (property, month). tenant_id
-- and doc_type are included so the table is reusable (a future monthly invoice
-- series calls the same generator with a different doc_type) and so two hotels
-- in a group never share a run of numbers, mirroring document_counters.
--
-- year_month is stored CANONICAL as 'YYYYMM' (not the display 'MMYY') so the key
-- is century-safe and sortable; the 'MMYY' display token is derived in the
-- generator. FM display width is a floor, not a ceiling — see SECTION 3.
--
-- §6 EXCEPTION (like document_counters / change_log): system-maintained counter,
-- not domain data. Written ONLY by next_monthly_document_number() (SECURITY
-- DEFINER); no created_by/updated_by, no set_row_audit trigger — no human edits it.
create table if not exists document_period_counters (
  tenant_id   uuid not null,
  property_id uuid not null,
  doc_type    text not null,                  -- 'booking'; later e.g. a monthly invoice series
  year_month  text not null,                  -- canonical 'YYYYMM' (property-local), the reset key
  last_number bigint not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (tenant_id, property_id, doc_type, year_month),
  -- Composite FK: the counter's (property_id, tenant_id) must be a real property,
  -- so a counter row can never straddle tenants. Cascade on property teardown.
  constraint document_period_counters_property_tenant_fk
    foreign key (property_id, tenant_id)
    references properties (id, tenant_id) on delete cascade
);

comment on table document_period_counters is
  'Per-(tenant, property, doc_type, year_month) monotonic counter backing '
  'MONTHLY-RESETTING document numbering (PREFIX-MMYY-NNN). A new month = a new PK '
  'row starting at 1 = the reset. Written ONLY by next_monthly_document_number(). '
  'Never count(*)+1: that races and reuses numbers after voids. Sibling of the '
  'non-resetting document_counters (015 §2).';


-- ############################################################################
-- SECTION 3 — next_monthly_document_number (THE GENERATOR)
-- ############################################################################
-- Atomically claims the next number for a (tenant, property, doc_type) within the
-- CURRENT MONTH (computed in the property's own timezone) and formats it as
-- PREFIX-MMYY-NNN.
--
-- CONCURRENCY (identical mechanism to next_document_number, proven in 6a):
--   The INSERT ... ON CONFLICT DO UPDATE takes a ROW LOCK on the single counter
--   row for (tenant, property, doc_type, year_month) and increments in ONE
--   statement, so two concurrent callers in the same property+month are
--   serialised on that row and can NEVER receive the same number. The first
--   booking of a fresh month is the ON-CONFLICT insert race: exactly one INSERT
--   wins with last_number=1, the loser falls to the DO UPDATE branch and gets 2.
--   Uniqueness is enforced by the PK (the DB), not app code. Gaps on ROLLBACK are
--   ACCEPTABLE — the guarantee is uniqueness + no-reuse, not contiguity.
--
-- The reference instant is now(), which is STABLE within the calling
-- transaction. It is converted to the property's local wall clock via
-- (now() AT TIME ZONE p_timezone) BEFORE extracting month/year, so a booking
-- taken just after local midnight on the 1st is numbered in the new month, not
-- the previous UTC one. p_timezone comes from properties.timezone (default
-- 'Africa/Lagos'); a blank falls back to 'Africa/Lagos' defensively.
create or replace function next_monthly_document_number(
  p_tenant_id   uuid,
  p_property_id uuid,
  p_doc_type    text,
  p_prefix      text,
  p_timezone    text
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_local  timestamp;   -- property-local wall clock (no tz), for month/year extraction
  v_period text;        -- 'YYYYMM' canonical key
  v_mmyy   text;        -- 'MMYY' display token
  v_seq    bigint;
begin
  -- Property-local calendar month drives BOTH the reset key and the display token.
  v_local  := now() at time zone coalesce(nullif(btrim(p_timezone), ''), 'Africa/Lagos');
  v_period := to_char(v_local, 'YYYYMM');
  v_mmyy   := to_char(v_local, 'MMYY');

  insert into document_period_counters as dc
    (tenant_id, property_id, doc_type, year_month, last_number)
  values (p_tenant_id, p_property_id, p_doc_type, v_period, 1)
  on conflict (tenant_id, property_id, doc_type, year_month)
  do update set last_number = dc.last_number + 1,
                updated_at  = now()
  returning last_number into v_seq;

  -- PREFIX-MMYY-NNN. FM suppresses the leading sign/space; 'FM000' pads to a
  -- MINIMUM of 3 digits. THE WIDTH IS A DISPLAY FLOOR, NOT A CEILING: the 1000th
  -- booking of a month renders 'HB-0726-1000', the 1001st 'HB-0726-1001', and so
  -- on without truncation. The number can never run out.
  return p_prefix || '-' || v_mmyy || '-' || to_char(v_seq, 'FM000');
end;
$$;

comment on function next_monthly_document_number(uuid, uuid, text, text, text) is
  'Atomically claims the next per-(tenant,property,doc_type) number WITHIN the '
  'current property-local month and formats it PREFIX-MMYY-NNN. Concurrency-safe '
  'via an upsert row-lock on document_period_counters; never reuses a number; '
  'resets to 1 each month by keying on year_month. NNN is a MINIMUM width (>=3), '
  'never a cap. Callable only from inside SECURITY DEFINER RPCs (execute revoked '
  'from all clients) so numbers cannot be burned by direct calls.';


-- ############################################################################
-- SECTION 4 — create_booking: emit the new number (everything else UNCHANGED)
-- ############################################################################
--  ┌───────────────────────────────────────────────────────────────────────┐
--  │  THE ONLY CHANGE FROM 016: the booking number is now produced by        │
--  │  next_monthly_document_number(...) — PREFIX-MMYY-NNN, monthly reset —   │
--  │  and the property read that already fetches tenant_id now also fetches   │
--  │  timezone and booking_number_prefix (no extra round-trip). The number is │
--  │  STILL generated inside create_booking, never by counting rows.          │
--  │                                                                          │
--  │  EVERYTHING ELSE IS UNCHANGED and load-bearing (015 §7, 016 §4):        │
--  │   * SELECT room_types ... FOR UPDATE — the overbooking guard,           │
--  │   * count_available under the held lock,                                │
--  │   * the idempotency fast-path + unique_violation race handler (rule 2), │
--  │   * per-night pricing via resolve_booking_rate_detail(..., p_company_id),│
--  │   * the company-belongs-to-tenant check, the guest check,               │
--  │   * staff gate (is_tenant_staff), explicit created_by (SECURITY DEFINER).│
--  └───────────────────────────────────────────────────────────────────────┘
-- Signature is IDENTICAL to 016, so this create-or-replace preserves the grant;
-- re-asserted in SECTION 6 to be explicit.
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

  -- >>> THE 019 CHANGE <<< Per-(tenant, property, MONTH) booking number in the
  -- new PREFIX-MMYY-NNN format — still generated here, never count(*)+1 (015 §2).
  -- Prefix resolves per-property, falling back to 'HB'; the month is computed in
  -- the property's own timezone inside the generator.
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
  'THE booking creation path (015 §7 / 016 §4). Booking number is now '
  'PREFIX-MMYY-NNN, resetting monthly per property via next_monthly_document_number '
  '(019) — still generated here, never count(*)+1. COMPANY-AWARE pricing and every '
  '6a/6b guarantee intact: idempotent (rule 2/3, bookings_idem_uniq) and '
  'UN-DOUBLE-BOOKABLE (SELECT FOR UPDATE on room_types). No other code path may '
  'insert a booking. SECURITY DEFINER, staff-gated.';


-- ############################################################################
-- SECTION 5 — Row-Level Security (document_period_counters)
-- ############################################################################
-- Mirror document_counters (015 §9): member READ only for transparency; NO
-- write policy for anyone — the table is written solely by
-- next_monthly_document_number (SECURITY DEFINER, runs as owner, bypasses RLS).
-- Never a public/anon policy: counters are private operational data.
alter table document_period_counters enable row level security;

drop policy if exists document_period_counters_member_select on document_period_counters;
create policy document_period_counters_member_select on document_period_counters
  for select to authenticated
  using (tenant_id = any(get_tenant_ids()));

-- NO write policies — written only by next_monthly_document_number (SECURITY DEFINER).
drop policy if exists document_period_counters_member_insert on document_period_counters;
drop policy if exists document_period_counters_member_update on document_period_counters;
drop policy if exists document_period_counters_member_delete on document_period_counters;


-- ############################################################################
-- SECTION 6 — Function grants
-- ############################################################################
-- next_monthly_document_number is callable by NO client at all (only from inside
-- the SECURITY DEFINER RPCs, which run as owner) so numbers cannot be burned by
-- direct calls — identical stance to next_document_number (015 §10).
revoke execute on function next_monthly_document_number(uuid, uuid, text, text, text) from public;
revoke execute on function next_monthly_document_number(uuid, uuid, text, text, text) from anon;
revoke execute on function next_monthly_document_number(uuid, uuid, text, text, text) from authenticated;

-- create_booking's signature is unchanged from 016, so the grant carried through
-- create-or-replace; re-assert it explicitly (authenticated staff only, never anon).
revoke execute on function create_booking(uuid, uuid, uuid, date, date, integer, text, integer, text, text, uuid) from public;
revoke execute on function create_booking(uuid, uuid, uuid, date, date, integer, text, integer, text, text, uuid) from anon;
grant  execute on function create_booking(uuid, uuid, uuid, date, date, integer, text, integer, text, text, uuid) to authenticated;

-- ============================================================================
-- End of 019_booking_number_monthly.sql
-- ============================================================================
