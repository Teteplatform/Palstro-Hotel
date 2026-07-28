-- ============================================================================
-- 016_companies.sql
-- Palstro-Hotels: corporate accounts + negotiated rates, and the booking-side
-- wiring that gives them meaning (build 6b, migration part).
--
-- A negotiated rate has NO meaning until a booking can carry it, so what was
-- once build "5b" folds in here: companies, per-room-type company_rates, the
-- company-aware rate resolver that WRAPS 012/015's rack-side resolver, and the
-- change to create_booking so a company booking locks the negotiated rate per
-- night exactly as a walk-in locks rack.
--
-- ----------------------------------------------------------------------------
-- THE ONE RULE THIS MIGRATION MUST NOT BREAK
-- ----------------------------------------------------------------------------
-- create_booking is the ONLY path that may insert a booking (015 §7): its
-- SELECT ... FOR UPDATE on room_types is the overbooking guard proven under
-- concurrency in 6a. This migration REPLACES create_booking to change ONE thing
-- — the per-night price is now resolved through the company resolver instead of
-- the plain rack resolver — and keeps EVERY other guarantee (the row lock, the
-- idempotency fast-path + unique-violation handler, the per-night rows, the
-- staff gate, explicit created_by) byte-for-byte intact. The rate is still
-- LOCKED at booking time and never recomputed.
--
-- Conventions inherited from 001/002/012/014/015 (unchanged):
--   * shared set_row_audit() owns audit columns; log_field_changes() records edits,
--   * composite (id, tenant_id)/(id, property_id) FK targets make a child's
--     scoping columns structurally unable to disagree with its parent,
--   * every function is SECURITY DEFINER + pinned search_path; grants are
--     authenticated-only (never anon — company pricing is commercially sensitive),
--   * NULL-safe soft-delete (rule 5): "live" is `deleted_at is null`.
-- No seed data.
-- ============================================================================


-- ############################################################################
-- SECTION 1 — companies (corporate accounts a hotel bills)
-- ############################################################################
-- LAYER: Configuration master data (docs/ARCHITECTURE.md) — a standing business
-- relationship, not a night-audit event. So it carries deleted_at soft-delete
-- (not is_voided) and NO business_date.
--
-- SCOPING: a company belongs to the TENANT, shared across all of that tenant's
-- properties (a Rivers-State group's NLNG account is the same account whichever
-- of its hotels the contractor sleeps in), so it carries tenant_id but NOT
-- property_id — exactly like guests (014). The negotiated RATE, on the other
-- hand, IS per property + room type; that is company_rates (SECTION 2).
create table if not exists companies (
  id            uuid primary key default gen_random_uuid(),
  -- Plain FK to tenants(id): tenant_id is the ONLY scoping column on a company
  -- (no property_id — see header). The unique (id, tenant_id) key at the end is
  -- the composite-FK TARGET company_rates binds (company_id, tenant_id) to, so a
  -- rate can never point at a company from another tenant.
  tenant_id     uuid not null references tenants(id) on delete cascade,

  name          text not null,                 -- 'NLNG', 'Shell', 'Julius Berger'

  contact_name  text,
  contact_phone text,
  contact_email text,
  address       text,
  notes         text,

  is_active     boolean not null default true,

  deleted_at    timestamptz,                   -- soft delete (master data, rule 5)
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid default auth.uid() references auth.users(id),
  updated_by    uuid references auth.users(id),

  -- Composite-FK TARGET for company_rates.company_id (SECTION 2). Redundant-
  -- looking (id is already PK) but required: an FK must target a unique key on
  -- exactly the referenced columns.
  constraint companies_id_tenant_unique unique (id, tenant_id)
);

comment on table companies is
  'Corporate accounts a hotel bills (NLNG, Shell, contractors). Tenant-scoped, '
  'shared across the tenant''s properties (like guests, 014). Master data: '
  'deleted_at soft-delete, no business_date. A company''s negotiated rate '
  '(company_rates) is commercially sensitive and NEVER gets a public read policy.';
comment on column companies.is_active is
  'Whether this account is currently trading. A soft-deleted (deleted_at set) '
  'company leaves the list entirely; is_active=false keeps it listed but flagged '
  'dormant. Two different axes, both real — matching bookings'' cancelled vs deleted_at.';

-- Front desk lists/filters companies within a tenant by name.
create index if not exists companies_tenant_name_idx
  on companies (tenant_id, name);
-- tenant_id drives the member-select policy predicate; index it as 001/002 do.
create index if not exists companies_tenant_id_idx
  on companies (tenant_id);

drop trigger if exists set_row_audit_companies on companies;
create trigger set_row_audit_companies
  before insert or update on companies
  for each row execute function set_row_audit();

-- Field-level history (who edited a company's details, from what) — the same
-- generic trigger every core table uses. AFTER UPDATE only.
drop trigger if exists log_field_changes_companies on companies;
create trigger log_field_changes_companies
  after update on companies for each row execute function log_field_changes();


-- ############################################################################
-- SECTION 2 — company_rates (the negotiated rate, per company per room type)
-- ############################################################################
-- One row per (company, room type): the agreed nightly deal. Two MODES, per the
-- owner's request:
--   * 'fixed'      — a flat nightly price the hotel HONOURS regardless of what
--                    rack does (NLNG pays ₦45,000 a night, full stop; a weekend
--                    or seasonal rack bump does not touch it).
--   * 'percentage' — a standing discount that FOLLOWS rack (NLNG always gets 20%
--                    off whatever the resolved rack-side rate is that night, so
--                    they share in weekend/seasonal moves).
-- This fixed-vs-percentage toggle is exactly the control the owner asked for.
create table if not exists company_rates (
  id               uuid primary key default gen_random_uuid(),
  -- No inline FKs on the scoping columns: the composite FKs at the end bind the
  -- quadruple so tenant/property/company/room_type can never disagree.
  tenant_id        uuid not null,
  property_id      uuid not null,
  company_id       uuid not null,
  room_type_id     uuid not null,

  rate_mode        text not null
                     constraint company_rates_mode_check
                     check (rate_mode in ('fixed','percentage')),

  -- The agreed nightly price when mode is 'fixed'. Money per §6: numeric(14,2),
  -- never float, never JSONB. NULL when mode is 'percentage' (see the check).
  fixed_rate       numeric(14,2),
  -- The percent off the resolved rack-side rate when mode is 'percentage'.
  -- numeric(5,2) covers 0.00–100.00. NULL when mode is 'fixed' (see the check).
  discount_percent numeric(5,2),

  deleted_at       timestamptz,                -- soft delete (master data, rule 5)
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid default auth.uid() references auth.users(id),
  updated_by       uuid references auth.users(id),

  -- A row can NEVER be half-defined: fixed mode must carry fixed_rate (and no
  -- stray discount); percentage mode must carry discount_percent (and no stray
  -- fixed price). Enforcing BOTH the present-side and the null-side keeps a mode
  -- switch from leaving a contradictory leftover value behind.
  constraint company_rates_mode_values_check check (
    (rate_mode = 'fixed'      and fixed_rate       is not null and discount_percent is null)
    or
    (rate_mode = 'percentage' and discount_percent is not null and fixed_rate       is null)
  ),
  -- A percentage is a real fraction of the rack rate: 0–100 inclusive.
  constraint company_rates_discount_range_check
    check (discount_percent is null
           or (discount_percent >= 0 and discount_percent <= 100)),

  -- Composite FKs (cross-tenant / cross-property leak guards):
  constraint company_rates_property_tenant_fk
    foreign key (property_id, tenant_id)
    references properties (id, tenant_id) on delete cascade,
  constraint company_rates_company_tenant_fk
    foreign key (company_id, tenant_id)
    references companies (id, tenant_id) on delete cascade,
  constraint company_rates_room_type_property_fk
    foreign key (room_type_id, property_id)
    references room_types (id, property_id) on delete cascade
);

comment on table company_rates is
  'A negotiated nightly deal, one per (company, room type). rate_mode=fixed is a '
  'flat price that IGNORES rack changes (NLNG pays a flat rate the hotel honours); '
  'rate_mode=percentage FOLLOWS rack (NLNG always gets X% off whatever the current '
  'resolved rate is). This fixed-vs-percentage toggle is the control the owner '
  'asked for. Read by resolve_booking_rate(); OPERATIONAL/commercial — NEVER '
  'gets a public RLS policy.';
comment on column company_rates.fixed_rate is
  'Agreed flat nightly price when rate_mode=fixed. Ignores the date entirely — a '
  'fixed corporate rate does not move with weekend/seasonal rack changes.';
comment on column company_rates.discount_percent is
  'Percent off the resolved RACK-SIDE rate when rate_mode=percentage. Follows '
  'rack: applied against resolve_room_rate_detail() for the date, so weekend/'
  'seasonal moves flow through to the company.';

-- A company has AT MOST ONE live rate per room type (the partial index skips
-- soft-deleted rows, so re-negotiating — soft-delete the old, insert the new —
-- is allowed and only the live one is unique). This is what lets
-- resolve_booking_rate look up "the" rate with a single-row read.
create unique index if not exists company_rates_company_room_type_uniq
  on company_rates (company_id, room_type_id)
  where deleted_at is null;

-- resolve_booking_rate looks up by (company_id, room_type_id); index it.
create index if not exists company_rates_company_room_type_idx
  on company_rates (company_id, room_type_id);
create index if not exists company_rates_tenant_id_idx
  on company_rates (tenant_id);

drop trigger if exists set_row_audit_company_rates on company_rates;
create trigger set_row_audit_company_rates
  before insert or update on company_rates
  for each row execute function set_row_audit();

drop trigger if exists log_field_changes_company_rates on company_rates;
create trigger log_field_changes_company_rates
  after update on company_rates for each row execute function log_field_changes();


-- ############################################################################
-- SECTION 3 — the company-aware rate resolver (WRAPS the rack resolver)
-- ############################################################################
-- Company pricing WRAPS the rack-side resolver, it does not replace it (012/015
-- said as much: "build 5b wraps this"). Following the SAME "detail + thin
-- wrapper" shape 015 established for resolve_room_rate_detail / resolve_room_rate:
--
--   * resolve_booking_rate_detail(...) returns (rate, source) — the full answer,
--     used by create_booking so booking_nights.rate_source can explain WHY each
--     night cost what it did (now including the company deal).
--   * resolve_booking_rate(...) returns numeric — the thin wrapper the brief
--     asks for, used by the booking screen's live price preview.
--
-- Both are ONE source of truth so they can never drift.
--
-- Precedence:
--   * p_company_id IS NULL  -> the rack-side rate, unchanged. Nothing changes for
--                              a walk-in (source 'rack'/'weekend'/'seasonal').
--   * a LIVE company_rate exists for (company, room type):
--       fixed      -> the fixed_rate, IGNORING the date (a flat corporate rate is
--                     flat), source 'company_fixed'.
--       percentage -> the rack-side rate for the date, reduced by the discount,
--                     source 'company_percentage' (so it moves with rack).
--   * a company is given but has NO negotiated rate for that type -> fall back to
--     the rack-side rate. A company without a specific rate simply pays rack —
--     this is NOT an error.
--
-- Returns (NULL, NULL) only when the room type does not exist / is soft-deleted
-- (rack resolver returns NULL), so a caller renders MISSING_VALUE, never a wrong
-- number. STABLE, SECURITY DEFINER, pinned search_path, NULL-safe on deleted_at.
create or replace function resolve_booking_rate_detail(
  p_room_type_id uuid,
  p_date         date,
  p_company_id   uuid default null
)
returns table (rate numeric, source text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_rack_rate   numeric(14,2);
  v_rack_source text;
  v_mode        text;
  v_fixed       numeric(14,2);
  v_discount    numeric(5,2);
begin
  -- The rack-side answer first — the single source of truth for date pricing.
  select d.rate, d.source
    into v_rack_rate, v_rack_source
  from resolve_room_rate_detail(p_room_type_id, p_date) d;

  -- Walk-in (no company): rack, unchanged. Also short-circuits a missing type
  -- (v_rack_rate NULL -> return (NULL, NULL)).
  if p_company_id is null then
    rate := v_rack_rate; source := v_rack_source; return next; return;
  end if;

  -- A company was given. Look up its LIVE negotiated rate for this type (rule 5:
  -- deleted_at NULL-safe; the partial unique index guarantees at most one).
  select cr.rate_mode, cr.fixed_rate, cr.discount_percent
    into v_mode, v_fixed, v_discount
  from company_rates cr
  where cr.company_id   = p_company_id
    and cr.room_type_id = p_room_type_id
    and cr.deleted_at is null
  limit 1;

  -- No negotiated rate for this type: the company simply pays rack. NOT an error.
  if not found then
    rate := v_rack_rate; source := v_rack_source; return next; return;
  end if;

  if v_mode = 'fixed' then
    -- Flat corporate rate: the agreed price, date ignored entirely.
    rate := v_fixed; source := 'company_fixed'; return next; return;
  end if;

  -- percentage: follows rack. If the type has no rack rate (missing/deleted),
  -- v_rack_rate is NULL and there is nothing to discount -> (NULL, NULL).
  if v_rack_rate is null then
    rate := null; source := null; return next; return;
  end if;
  -- round to 2dp explicitly; the numeric(14,2) column would round anyway, but a
  -- computed price should be deterministic at the point of computation.
  rate   := round(v_rack_rate * (1 - v_discount / 100), 2);
  source := 'company_percentage';
  return next; return;
end;
$$;

comment on function resolve_booking_rate_detail(uuid, date, uuid) is
  'Company-aware nightly price AND why: WRAPS resolve_room_rate_detail(). NULL '
  'company -> rack unchanged. Live company_rate: fixed -> flat price (date '
  'ignored), source company_fixed; percentage -> rack reduced by the discount, '
  'source company_percentage. Company without a rate -> rack (not an error). '
  'STABLE, SECURITY DEFINER, pinned search_path.';

-- The thin numeric wrapper the brief names — the booking screen calls this for
-- its live price preview. Single source of truth is the detail function above.
create or replace function resolve_booking_rate(
  p_room_type_id uuid,
  p_date         date,
  p_company_id   uuid default null
)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select rate from resolve_booking_rate_detail(p_room_type_id, p_date, p_company_id);
$$;

comment on function resolve_booking_rate(uuid, date, uuid) is
  'Thin numeric wrapper over resolve_booking_rate_detail(): the company-aware '
  'nightly rate for a date. NULL company -> rack; else the negotiated deal. Used '
  'by the booking screen''s live price preview. STABLE, SECURITY DEFINER.';


-- ############################################################################
-- SECTION 4 — create_booking: price each night through the COMPANY resolver
-- ############################################################################
--  ┌───────────────────────────────────────────────────────────────────────┐
--  │  THE ONLY CHANGE FROM 015: the per-night pricing line now resolves      │
--  │  through resolve_booking_rate_detail(..., p_company_id) instead of the  │
--  │  plain resolve_room_rate_detail(). A company booking therefore LOCKS    │
--  │  the negotiated rate per night, exactly as a walk-in locks rack. The    │
--  │  rate is still locked at booking time and never recomputed.             │
--  │                                                                          │
--  │  EVERYTHING ELSE IS UNCHANGED and load-bearing (see 015 §7):            │
--  │   * SELECT room_types ... FOR UPDATE — the overbooking guard,           │
--  │   * the idempotency fast-path + unique_violation race handler (rule 2), │
--  │   * count_available under the held lock,                                │
--  │   * one booking_nights row per night with its locked rate + source,     │
--  │   * staff gate (is_tenant_staff), explicit created_by (SECURITY DEFINER).│
--  └───────────────────────────────────────────────────────────────────────┘
-- Signature is IDENTICAL to 015 (p_company_id already existed as a forward
-- reference), so this create-or-replace preserves the 015 grant; re-asserted in
-- SECTION 7 to be explicit.
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
  -- type: for the admin gate and the idempotency lookup).
  select p.tenant_id into v_tenant_id
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

  -- Per-(tenant, property) booking number — never count(*)+1 (015 §2).
  v_number := next_document_number(v_tenant_id, p_property_id, 'booking', 'BK');

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
    -- >>> THE 6b CHANGE <<< pricing now flows through the COMPANY resolver, so a
    -- company booking locks its negotiated rate per night just as a walk-in locks
    -- rack. p_company_id NULL (a walk-in) yields the identical rack pricing 015
    -- produced. resolve_booking_rate_detail gives rate AND source so the audit
    -- trail is complete (rack/weekend/seasonal, or company_fixed/company_percentage).
    -- Any NULL rate here (type vanished mid-transaction) would violate
    -- booking_nights.rate NOT NULL and roll the whole booking back — fail-safe.
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
  'THE booking creation path (015 §7), now COMPANY-AWARE: each night is priced '
  'via resolve_booking_rate_detail(..., p_company_id) so a company booking locks '
  'its negotiated rate per night exactly as a walk-in locks rack. Rate locked at '
  'booking time, never recomputed. Idempotent (rule 2/3) and UN-DOUBLE-BOOKABLE '
  '(SELECT FOR UPDATE on room_types) — every 6a guarantee intact. No other code '
  'path may insert a booking. SECURITY DEFINER, staff-gated.';


-- ############################################################################
-- SECTION 5 — create_guest (staff may register a guest during the booking flow)
-- ############################################################################
-- The booking screen (6b) must let front desk "create a new guest inline". 014
-- deliberately gated guests INSERT to admin only, noting creation would come
-- "through create_booking's caller path in 6b". A receptionist is STAFF, not an
-- admin (015's is_tenant_staff exists for exactly this: "a receptionist who
-- cannot book a walk-in is useless" — and cannot register the walk-in either).
--
-- Two ways to open the door: widen the guests INSERT policy to staff, or a
-- SECURITY DEFINER RPC. We choose the RPC so that (a) the actor is stamped
-- explicitly under SECURITY DEFINER, matching create_booking, and (b) guest
-- creation stays a deliberate, auditable operation rather than an open table
-- write. Guests are non-financial master data, so rule 2's idempotency-key
-- machinery (which exists to stop duplicate BOOKINGS/CHARGES/PAYMENTS) does not
-- apply — there is no financial double-post to guard; a duplicate guest is a
-- soft-correctable master record, and the real rule-2 guard lives on
-- create_booking. The guests INSERT policy stays admin-only (untouched).
create or replace function create_guest(
  p_tenant_id    uuid,
  p_full_name    text,
  p_phone        text default null,
  p_email        text default null,
  p_nationality  text default null,
  p_id_type      text default null,
  p_id_number    text default null,
  p_notes        text default null
)
returns guests
language plpgsql
security definer
set search_path = public
as $$
declare
  v_guest guests;
  v_actor uuid := auth.uid();
begin
  if not is_tenant_staff(p_tenant_id) then
    raise exception 'Not authorised to register guests for this tenant'
      using errcode = 'insufficient_privilege';
  end if;

  if p_full_name is null or btrim(p_full_name) = '' then
    raise exception 'A guest needs a name' using errcode = 'check_violation';
  end if;

  insert into guests (
    tenant_id, full_name, phone, email, nationality, id_type, id_number, notes,
    created_by
  ) values (
    p_tenant_id, btrim(p_full_name),
    nullif(btrim(coalesce(p_phone, '')), ''),
    nullif(btrim(coalesce(p_email, '')), ''),
    nullif(btrim(coalesce(p_nationality, '')), ''),
    nullif(btrim(coalesce(p_id_type, '')), ''),
    nullif(btrim(coalesce(p_id_number, '')), ''),
    nullif(btrim(coalesce(p_notes, '')), ''),
    v_actor
  )
  returning * into v_guest;

  return v_guest;
end;
$$;

comment on function create_guest(uuid, text, text, text, text, text, text, text) is
  'Registers a guest for a tenant during the booking flow. STAFF-gated '
  '(is_tenant_staff) — front desk, not just admins, since taking/registering a '
  'walk-in is front-desk work. SECURITY DEFINER, actor stamped explicitly. '
  'Non-financial master data, so no idempotency key (rule 2 guards bookings/'
  'charges/payments; a duplicate guest is soft-correctable).';


-- ############################################################################
-- SECTION 6 — booking status transitions (the TWO the screen exposes)
-- ############################################################################
-- create_booking inserts every booking as 'confirmed' (015) — there is no
-- enquiry-creation path in 6b — so the ONLY forward transitions the manage view
-- can reach are check-in and check-out. We build exactly those two; a
-- confirm_booking (enquiry -> confirmed) would be an RPC nothing calls, so it is
-- deliberately NOT built. Cancellation (confirmed -> cancelled) already exists as
-- cancel_booking (015 §8); it is not re-built here.
--
-- Each transition goes through an RPC (never a direct UPDATE — bookings has no
-- update RLS policy, 015 §9), because each will later touch the FOLIO (6c):
-- check-in opens the folio, check-out finalises it. Built MINIMAL following the
-- cancel_booking pattern (015 §8): lock the row, staff-gate, guard the FROM
-- status, update, idempotent by state. FOLIO EFFECTS ATTACH IN 6c — the comments
-- mark exactly where.
--
-- Availability needs nothing from these: a status move within
-- confirmed/checked_in/checked_out does not change which nights are held (all
-- three HOLD inventory in count_available, 015 §6), and dates are unchanged.

-- check_in_booking: confirmed -> checked_in. FOLIO (6c): this is where the
-- guest's folio is OPENED and the first night's room charge posts.
create or replace function check_in_booking(
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

  if not is_tenant_staff(v_booking.tenant_id) then
    raise exception 'Not authorised to update this booking'
      using errcode = 'insufficient_privilege';
  end if;

  if v_booking.status = 'checked_in' then
    return v_booking;                       -- idempotent by state
  end if;

  if v_booking.status <> 'confirmed' then
    raise exception 'Only a confirmed booking can be checked in (status is %)',
      v_booking.status using errcode = 'check_violation';
  end if;

  update bookings
    set status = 'checked_in', updated_by = v_actor
  where id = p_booking_id
  returning * into v_booking;

  -- FOLIO (6c): open the guest folio here and post the room charges in the SAME
  -- transaction (rule 7 lockstep). Nothing to do yet — the folio does not exist.
  return v_booking;
end;
$$;

comment on function check_in_booking(uuid, text) is
  'Transitions a confirmed booking -> checked_in. Staff-gated, idempotent by '
  'state, via RPC (015 §9). Minimal (015 cancel pattern); in 6c this OPENS the '
  'guest folio and posts room charges in the same transaction.';

-- check_out_booking: checked_in -> checked_out. FOLIO (6c): this is where the
-- folio is finalised and settlement is required before the stay closes.
create or replace function check_out_booking(
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

  if not is_tenant_staff(v_booking.tenant_id) then
    raise exception 'Not authorised to update this booking'
      using errcode = 'insufficient_privilege';
  end if;

  if v_booking.status = 'checked_out' then
    return v_booking;                       -- idempotent by state
  end if;

  if v_booking.status <> 'checked_in' then
    raise exception 'Only a checked-in booking can be checked out (status is %)',
      v_booking.status using errcode = 'check_violation';
  end if;

  update bookings
    set status = 'checked_out', updated_by = v_actor
  where id = p_booking_id
  returning * into v_booking;

  -- FOLIO (6c): finalise the folio and require settlement here, in lockstep
  -- (rule 7). Nothing to do yet — the folio does not exist.
  return v_booking;
end;
$$;

comment on function check_out_booking(uuid, text) is
  'Transitions a checked-in booking -> checked_out. Staff-gated, idempotent by '
  'state, via RPC (015 §9). Minimal (015 cancel pattern); in 6c this FINALISES '
  'the folio and requires settlement in the same transaction.';


-- ############################################################################
-- SECTION 7 — Row-Level Security
-- ############################################################################
-- companies & company_rates follow the 001/012 pattern: member READ, admin
-- WRITE, and — because a negotiated rate is COMMERCIALLY SENSITIVE — NO public
-- policy, ever. With RLS on and no anon policy an anon SELECT returns zero rows
-- (fail-closed), which is what keeps corporate pricing off the open web.
alter table companies     enable row level security;
alter table company_rates enable row level security;

-- --- companies: member read, admin write ----------------------------------
drop policy if exists companies_member_select on companies;
create policy companies_member_select on companies
  for select to authenticated
  using (tenant_id = any(get_tenant_ids()));

drop policy if exists companies_member_insert on companies;
create policy companies_member_insert on companies
  for insert to authenticated
  with check (is_tenant_admin(tenant_id));

drop policy if exists companies_member_update on companies;
create policy companies_member_update on companies
  for update to authenticated
  using (is_tenant_admin(tenant_id))
  with check (is_tenant_admin(tenant_id));

-- NO delete policy — companies are SOFT-DELETED (set deleted_at via update).
drop policy if exists companies_member_delete on companies;

-- --- company_rates: member read, admin write -------------------------------
drop policy if exists company_rates_member_select on company_rates;
create policy company_rates_member_select on company_rates
  for select to authenticated
  using (tenant_id = any(get_tenant_ids()));

drop policy if exists company_rates_member_insert on company_rates;
create policy company_rates_member_insert on company_rates
  for insert to authenticated
  with check (is_tenant_admin(tenant_id));

drop policy if exists company_rates_member_update on company_rates;
create policy company_rates_member_update on company_rates
  for update to authenticated
  using (is_tenant_admin(tenant_id))
  with check (is_tenant_admin(tenant_id));

-- NO delete policy — company_rates are SOFT-DELETED (re-negotiation = soft-
-- delete the old + insert the new; pricing history must survive).
drop policy if exists company_rates_member_delete on company_rates;

-- NO public policy on EITHER table — BY DESIGN. DO NOT ADD ONE. A company's
-- negotiated rate must never reach an anonymous visitor.


-- ############################################################################
-- SECTION 8 — Function grants
-- ############################################################################
-- SECURITY DEFINER functions default to EXECUTE for PUBLIC; revoke and grant
-- only authenticated staff. NONE of these go to anon: company pricing is
-- commercially sensitive, and the guest site is anonymous (§4 — the public price
-- is the rack rate only).

revoke execute on function resolve_booking_rate_detail(uuid, date, uuid) from public;
revoke execute on function resolve_booking_rate_detail(uuid, date, uuid) from anon;
grant  execute on function resolve_booking_rate_detail(uuid, date, uuid) to authenticated;

revoke execute on function resolve_booking_rate(uuid, date, uuid) from public;
revoke execute on function resolve_booking_rate(uuid, date, uuid) from anon;
grant  execute on function resolve_booking_rate(uuid, date, uuid) to authenticated;

-- create_booking's signature is unchanged from 015, so the 015 grant carried
-- over; re-assert it explicitly (authenticated only, never anon).
revoke execute on function create_booking(uuid, uuid, uuid, date, date, integer, text, integer, text, text, uuid) from public;
revoke execute on function create_booking(uuid, uuid, uuid, date, date, integer, text, integer, text, text, uuid) from anon;
grant  execute on function create_booking(uuid, uuid, uuid, date, date, integer, text, integer, text, text, uuid) to authenticated;

revoke execute on function create_guest(uuid, text, text, text, text, text, text, text) from public;
revoke execute on function create_guest(uuid, text, text, text, text, text, text, text) from anon;
grant  execute on function create_guest(uuid, text, text, text, text, text, text, text) to authenticated;

revoke execute on function check_in_booking(uuid, text) from public;
revoke execute on function check_in_booking(uuid, text) from anon;
grant  execute on function check_in_booking(uuid, text) to authenticated;

revoke execute on function check_out_booking(uuid, text) from public;
revoke execute on function check_out_booking(uuid, text) from anon;
grant  execute on function check_out_booking(uuid, text) to authenticated;

-- ============================================================================
-- End of 016_companies.sql
-- ============================================================================
