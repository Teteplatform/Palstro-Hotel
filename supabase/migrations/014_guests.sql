-- ============================================================================
-- 014_guests.sql
-- Palstro-Hotels: guests — the people who stay (build 6a, part 1 of 2).
--
-- A GUEST IS NOT AN AUTH USER. auth.users are STAFF (front desk, housekeeping);
-- a guest is a person who sleeps in a room and has a folio. They never log in.
-- Reused across stays: a returning guest is ONE record with a stay history, not
-- a fresh row per visit — which is why front desk searches by phone (the index
-- below) to find the existing record before creating a booking.
--
-- SCOPING: a guest belongs to the TENANT, shared across all of that tenant's
-- properties (a group's guest who stayed at hotel A may next stay at hotel B and
-- is the same person). So the guest carries tenant_id but NOT property_id — the
-- stay's property lives on the booking (015), not on the guest.
--
-- LAYER: master data (a person, not an event) — so per CLAUDE.md §6 it carries
-- deleted_at soft-delete (not is_voided) and NO business_date.
--
-- Conventions inherited from 001/002/012: shared set_row_audit() owns every audit
-- column; the generic log_field_changes() trigger records edits; RLS scopes reads
-- via get_tenant_ids() and gates writes via is_tenant_admin(). No seed data.
--
-- PRIVACY — READ THIS BEFORE ADDING ANY POLICY. Guest ID details (id_type,
-- id_number) are recorded because Nigerian hotels are legally required to capture
-- guest identification. They are SENSITIVE personal data. This table must NEVER
-- receive a public/anon read policy — not now, not for any storefront feature.
-- Guest ID scans as IMAGES are explicitly OUT OF SCOPE for the public media
-- bucket (see 013's note); a guest ID document never goes in a public bucket.
-- ============================================================================

create table if not exists guests (
  id           uuid primary key default gen_random_uuid(),
  -- Scoping root. Plain FK to tenants(id) is sufficient here because tenant_id is
  -- the ONLY scoping column on a guest (no property_id — see the header). The
  -- unique (id, tenant_id) key at the end exists so bookings (015) can bind
  -- (guest_id, tenant_id) with a COMPOSITE FK, making a booking structurally
  -- unable to reference a guest from a different tenant.
  tenant_id    uuid not null references tenants(id) on delete cascade,

  full_name    text not null,

  -- How front desk actually finds a returning guest; nullable because a walk-in
  -- may give neither. Indexed below.
  phone        text,
  email        text,

  nationality  text,

  -- Government identification. Nigerian hotels are required to record it.
  -- SENSITIVE — see the privacy note in the header. Nullable: captured at
  -- check-in, which may be after the booking is created.
  id_type      text,                          -- 'passport', 'national_id', 'drivers_license', ...
  id_number    text,

  notes        text,

  deleted_at   timestamptz,                    -- soft delete (master data, rule 5)
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  created_by   uuid default auth.uid() references auth.users(id),
  updated_by   uuid references auth.users(id),

  -- Composite-FK TARGET for bookings.guest_id (015). Lets a child bind
  -- (guest_id, tenant_id) so a booking's tenant can never disagree with its
  -- guest's tenant — a cross-tenant leak RLS could not catch (policies trust
  -- tenant_id directly). See CLAUDE.md §6 "composite-key consistency".
  constraint guests_id_tenant_unique unique (id, tenant_id)
);

comment on table guests is
  'A person who stays (NOT an auth user / staff). Tenant-scoped, shared across '
  'the tenant''s properties, reused across stays. Master data: deleted_at soft '
  'delete, no business_date. NEVER gets a public read policy — see id_number.';
comment on column guests.id_number is
  'Government ID number. SENSITIVE personal data, recorded because Nigerian hotels '
  'must. This column (and this table) must never be exposed by a public/anon RLS '
  'policy, and ID scans as images are out of scope for the public media bucket.';
comment on constraint guests_id_tenant_unique on guests is
  'Composite-FK target so bookings.guest_id binds (guest_id, tenant_id) and can '
  'never point at a guest from another tenant.';

-- Front desk lists/searches guests within a tenant by name...
create index if not exists guests_tenant_full_name_idx
  on guests (tenant_id, full_name);
-- ...and, more often, finds a returning guest by phone.
create index if not exists guests_tenant_phone_idx
  on guests (tenant_id, phone);

drop trigger if exists set_row_audit_guests on guests;
create trigger set_row_audit_guests
  before insert or update on guests
  for each row execute function set_row_audit();

-- Field-level history (who edited a guest's details, from what) — same generic
-- trigger every core table uses. AFTER UPDATE only; inserts are not diffed.
drop trigger if exists log_field_changes_guests on guests;
create trigger log_field_changes_guests
  after update on guests for each row execute function log_field_changes();

-- ----------------------------------------------------------------------------
-- Row-Level Security — member read, admin write, NO public policy
-- ----------------------------------------------------------------------------
-- Same shape as room_types (002) MINUS any public policy. Guest PII must never
-- reach anon/storefront readers. With RLS on and no anon policy, an anon SELECT
-- returns zero rows (fail-closed).
alter table guests enable row level security;

-- SELECT: any active member of the owning tenant. Front desk, housekeeping and
-- accounting all legitimately need to read guests.
drop policy if exists guests_member_select on guests;
create policy guests_member_select on guests
  for select to authenticated
  using (tenant_id = any(get_tenant_ids()));

-- INSERT/UPDATE: admin only, matching 002's conservative default (writes are
-- owner/manager until purpose-built RPCs widen them). Guest creation during the
-- booking flow goes through create_booking's caller path in 6b; direct admin
-- edits are for corrections.
drop policy if exists guests_member_insert on guests;
create policy guests_member_insert on guests
  for insert to authenticated
  with check (is_tenant_admin(tenant_id));

drop policy if exists guests_member_update on guests;
create policy guests_member_update on guests
  for update to authenticated
  using (is_tenant_admin(tenant_id))
  with check (is_tenant_admin(tenant_id));

-- NO delete policy — BY DESIGN. Guests are SOFT-DELETED (set deleted_at) so their
-- stay/folio history survives. The drop clears any delete policy a prior version
-- of this migration created.
drop policy if exists guests_member_delete on guests;

-- NO public policy — BY DESIGN. DO NOT ADD ONE. See the header privacy note.

-- ============================================================================
-- End of 014_guests.sql
-- ============================================================================
