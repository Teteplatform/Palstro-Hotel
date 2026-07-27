-- ============================================================================
-- 015_bookings.sql
-- Palstro-Hotels: the bookings foundation (build 6a, part 2 of 2).
--
-- This is the HIGHEST-STAKES migration in the project. A double-booked room is
-- the one mistake a hotel cannot forgive, and its correctness lives almost
-- entirely HERE, in the database, not in any UI. The booking CREATION screen is
-- 6b and the folio is 6c; this migration stops at exactly one thing:
--
--     the database can correctly answer "are rooms free?" and can HOLD a booking
--     without EVER double-booking, even under simultaneous requests.
--
-- ----------------------------------------------------------------------------
-- THE FOUR CORRECTNESS RULES THAT GOVERN EVERYTHING BELOW (this is the spec)
-- ----------------------------------------------------------------------------
--
-- RULE 1 — A CHECKOUT DAY IS NOT AN OCCUPIED NIGHT. A guest leaving on the 5th
--   and a guest arriving on the 5th do NOT clash. Nights are counted as
--   [check_in, check_out): check_in inclusive, check_out EXCLUSIVE. A one-night
--   stay check_in=5th, check_out=6th occupies the night of the 5th only.
--
-- RULE 2 — TWO BOOKINGS CLASH IFF  check_in_a < check_out_b AND check_in_b < check_out_a.
--   Nothing else. This is the half-open-interval overlap test. Get it wrong and
--   you either double-book (too loose) or block a free room (too tight). In
--   particular a booking whose check_in equals another's check_out does NOT
--   satisfy it, which is exactly RULE 1.
--
-- RULE 3 — AVAILABILITY IS PER ROOM TYPE, NOT PER PHYSICAL ROOM. You sell "a
--   Deluxe": availability is "how many Deluxes are booked those nights vs how
--   many exist". Assigning physical room 204 is a later, separate concern (front
--   desk / housekeeping). The denominator here is room_types.inventory_count.
--
-- RULE 4 — A CANCELLED OR NO-SHOW BOOKING'S EFFECT ON AVAILABILITY IS EXPLICIT,
--   NEVER ASSUMED. 'cancelled' FREES the room. 'no_show' does NOT by default (the
--   room was held for a guest who never arrived). 'enquiry' never held a room, so
--   it does not occupy. See the occupancy-status set in count_available.
--
-- ----------------------------------------------------------------------------
-- Conventions inherited from 001/002/006/012:
--   * shared set_row_audit() owns audit columns; log_field_changes() records edits,
--   * composite (id, tenant_id)/(id, property_id) FK targets make a child's
--     scoping columns structurally unable to disagree with its parent,
--   * per-tenant document numbering via a counter table + SECURITY DEFINER
--     function (§6) — NEVER count(*) + 1,
--   * every write RPC takes p_idempotency_key and is backed by a partial unique
--     index (rules 2 & 3); every function is SECURITY DEFINER + pinned search_path.
-- No seed data.
-- ============================================================================


-- ############################################################################
-- SECTION 1 — inventory_count on room_types (the availability DENOMINATOR)
-- ############################################################################
-- Physical rooms (002.rooms) are not wired into booking yet, so until the front
-- desk module ties them in, the number of sellable units of a type is an explicit
-- integer on the type. This is the "how many Deluxes exist" in RULE 3.
alter table room_types
  add column if not exists inventory_count integer not null default 0;

comment on column room_types.inventory_count is
  'How many physical units of this room type the property has to sell — the '
  'DENOMINATOR of availability (RULE 3). Explicit integer until the front-desk '
  'module ties physical rooms (002) into booking, at which point this is replaced '
  'by a count of live rooms of the type. Default 0 = nothing sellable until set.';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'room_types_inventory_count_check'
  ) then
    alter table room_types
      add constraint room_types_inventory_count_check
      check (inventory_count >= 0);
  end if;
end $$;


-- ############################################################################
-- SECTION 2 — document numbering (per-tenant counter, never count(*)+1)
-- ############################################################################
-- CLAUDE.md §6: booking/invoice/receipt numbers come from a SECURITY DEFINER
-- function backed by a per-tenant counter table, NEVER from counting rows and
-- adding one. Counting rows RACES under concurrency (two callers read the same
-- max) and REUSES numbers after a void. This counter is shared: invoices and
-- receipts (later builds) call the same function with a different doc_type.
--
-- Keyed on (tenant_id, property_id, doc_type): each PROPERTY gets its own booking
-- sequence starting at 1, which is what makes booking_number "unique per
-- property" (015 bookings). It is still a per-tenant counter table (tenant-scoped
-- rows); property is added to the key so two hotels in a group do not share one
-- run of numbers.
--
-- §6 EXCEPTION (like change_log): this is a system-maintained counter, not domain
-- data. It is written ONLY by next_document_number() (SECURITY DEFINER) and
-- carries no created_by/updated_by actor columns — no human ever edits it.
create table if not exists document_counters (
  tenant_id   uuid not null,
  property_id uuid not null,
  doc_type    text not null,                  -- 'booking', later 'invoice','receipt',...
  last_number bigint not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (tenant_id, property_id, doc_type),
  -- Composite FK: the counter's (property_id, tenant_id) must be a real property,
  -- so a counter row can never straddle tenants. Cascade on property teardown.
  constraint document_counters_property_tenant_fk
    foreign key (property_id, tenant_id)
    references properties (id, tenant_id) on delete cascade
);

comment on table document_counters is
  'Per-(tenant, property, doc_type) monotonic counter backing document numbering '
  '(§6). Written ONLY by next_document_number(). Never count(*)+1: that races and '
  'reuses numbers after voids.';

-- next_document_number: atomically claim the next number for a document type.
-- The INSERT ... ON CONFLICT DO UPDATE takes a ROW LOCK on the counter row and
-- increments in one statement, so two concurrent callers are serialised on that
-- row and can never receive the same number. Gaps are possible on ROLLBACK and
-- are ACCEPTABLE — the guarantee is uniqueness and no-reuse, not contiguity.
create or replace function next_document_number(
  p_tenant_id   uuid,
  p_property_id uuid,
  p_doc_type    text,
  p_prefix      text
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_seq bigint;
begin
  insert into document_counters as dc (tenant_id, property_id, doc_type, last_number)
  values (p_tenant_id, p_property_id, p_doc_type, 1)
  on conflict (tenant_id, property_id, doc_type)
  do update set last_number = dc.last_number + 1,
                updated_at  = now()
  returning last_number into v_seq;

  -- e.g. 'BK-000001'. FM suppresses the leading sign/space; min 6 digits, grows
  -- past 999999 without truncating. The prefix is a document-type marker, not a
  -- tenant value (rule 17 is about tenant-specific strings — a doc prefix is not).
  return p_prefix || '-' || to_char(v_seq, 'FM000000');
end;
$$;

comment on function next_document_number(uuid, uuid, text, text) is
  'Atomically claims the next per-(tenant,property,doc_type) document number via '
  'an upsert row-lock. Concurrency-safe and never reuses a number. Callable only '
  'from SECURITY DEFINER RPCs (execute revoked from clients) so numbers cannot be '
  'burned by direct calls.';


-- ############################################################################
-- SECTION 3 — resolve_room_rate_detail (rate + WHY, for the per-night audit)
-- ############################################################################
-- booking_nights records rate_source ('rack'/'weekend'/'seasonal') alongside the
-- locked rate, so the folio and any dispute can answer "why did this night cost
-- this?". 012's resolve_room_rate() returns only the number. Rather than DUPLICATE
-- the precedence logic (which would drift), the full precedence now lives HERE in
-- resolve_room_rate_detail(), and 012's resolve_room_rate() is redefined below as
-- a thin wrapper over it — ONE source of truth, two shapes.
--
-- Precedence (highest first), identical to 012:
--   1. seasonal_rate covering the date (newest-created wins on overlap; soft-
--      deleted ignored, rule 5)  -> source 'seasonal'
--   2. weekend_rate when set AND the date is a configured weekend_day (NULL means
--      "no premium", fall through — never treated as 0)  -> source 'weekend'
--   3. base_rate (the rack rate)  -> source 'rack'
-- Returns (NULL, NULL) only when the type does not exist or is soft-deleted, so a
-- caller renders MISSING_VALUE rather than a wrong number.
create or replace function resolve_room_rate_detail(
  p_room_type_id uuid,
  p_date         date
)
returns table (rate numeric, source text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_seasonal     numeric(14,2);
  v_base         numeric(14,2);
  v_weekend      numeric(14,2);
  v_weekend_days integer[];
begin
  -- 1. Seasonal override — highest precedence, soft-deleted ignored (rule 5),
  --    newest wins on overlap (deliberate tiebreak from 012).
  select sr.rate into v_seasonal
  from seasonal_rates sr
  where sr.room_type_id = p_room_type_id
    and sr.deleted_at is null
    and p_date between sr.start_date and sr.end_date
  order by sr.created_at desc
  limit 1;

  if v_seasonal is not null then
    rate := v_seasonal; source := 'seasonal'; return next; return;
  end if;

  -- Load rack/weekend config. deleted_at NULL-safe: a soft-deleted type cannot be
  -- priced (a stricter, more correct guard than 012's original lookup).
  select rt.base_rate, rt.weekend_rate, rt.weekend_days
    into v_base, v_weekend, v_weekend_days
  from room_types rt
  where rt.id = p_room_type_id
    and rt.deleted_at is null;

  if v_base is null then
    rate := null; source := null; return next; return;
  end if;

  -- 2. Weekend premium — only when set AND the date is a configured weekend day.
  if v_weekend is not null
     and extract(isodow from p_date)::integer = any(v_weekend_days) then
    rate := v_weekend; source := 'weekend'; return next; return;
  end if;

  -- 3. Rack rate.
  rate := v_base; source := 'rack'; return next; return;
end;
$$;

comment on function resolve_room_rate_detail(uuid, date) is
  'SINGLE SOURCE OF TRUTH for a room type''s nightly price AND why: returns '
  '(rate, source) where source is seasonal/weekend/rack. resolve_room_rate() is a '
  'thin wrapper returning only the rate. STABLE, SECURITY DEFINER, pinned search_path.';

-- Redefine 012's resolve_room_rate() as a thin wrapper so the two can never
-- disagree. create-or-replace PRESERVES existing privileges (the 012 grants), but
-- we re-assert them at the end of this file for both functions to be explicit.
create or replace function resolve_room_rate(
  p_room_type_id uuid,
  p_date         date
)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select rate from resolve_room_rate_detail(p_room_type_id, p_date);
$$;

comment on function resolve_room_rate(uuid, date) is
  'Thin wrapper over resolve_room_rate_detail() returning only the nightly rate. '
  'Single source of truth for pricing precedence now lives in the detail function.';


-- ############################################################################
-- SECTION 4 — bookings
-- ############################################################################
-- LAYER: Operations (docs/ARCHITECTURE.md) — but a booking is a reservation of
-- future nights, not a night-audit event, so it does NOT carry business_date;
-- its dates ARE its business meaning. It carries deleted_at (soft-delete of an
-- erroneous record) SEPARATELY from status='cancelled' (the guest cancelled) —
-- two different axes, both real:
--   * deleted_at  -> "this booking row was a mistake; hide it entirely"
--   * cancelled   -> "a real reservation the guest called off"
-- count_available excludes BOTH from occupancy.
create table if not exists bookings (
  id                  uuid primary key default gen_random_uuid(),
  -- No inline FKs on the scoping columns: composite FKs at the end bind the
  -- pairs so tenant/property/room_type/guest can never disagree.
  tenant_id           uuid not null,
  property_id         uuid not null,
  room_type_id        uuid not null,
  guest_id            uuid not null,

  -- Unique per property (SECTION 2), generated by next_document_number — never a
  -- row count. Plain unique (not partial): a number is NEVER reused, even after a
  -- booking is cancelled or soft-deleted.
  booking_number      text not null,

  check_in            date not null,
  check_out           date not null,

  adults              integer not null,
  children            integer not null default 0,

  -- Occupancy lifecycle. See count_available for which of these HOLD inventory.
  status              text not null default 'confirmed'
                        constraint bookings_status_check
                        check (status in ('enquiry','confirmed','checked_in',
                                          'checked_out','cancelled','no_show')),

  -- FORWARD REFERENCE to build 5b (company bookings). The column exists NOW so
  -- the booking flow is built against its final shape, but the companies table
  -- does not exist yet, so there is DELIBERATELY no FK on company_id here — 5b
  -- adds it. Do not create a companies table in this migration.
  company_id          uuid,

  -- Who the folio settles against. 'company' billing is wired in 5b; the field
  -- exists now (same reason as company_id) so folio/settlement code is built once.
  bill_to             text not null default 'guest'
                        constraint bookings_bill_to_check
                        check (bill_to in ('guest','company')),

  special_requests    text,

  -- Business cancellation (distinct from deleted_at soft-delete, see header).
  cancelled_at        timestamptz,
  cancellation_reason text,

  -- Retry/double-click guard (rules 2 & 3). The partial unique index below is the
  -- real enforcement; create_booking uses it. NULL allowed (index is partial).
  idempotency_key     text,

  deleted_at          timestamptz,             -- soft delete (rule 5)
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  created_by          uuid default auth.uid() references auth.users(id),
  updated_by          uuid references auth.users(id),

  -- check_out strictly after check_in (RULE 1/2: a zero-night booking is invalid).
  constraint bookings_dates_check check (check_out > check_in),
  constraint bookings_adults_check   check (adults >= 1),
  constraint bookings_children_check check (children >= 0),

  -- Composite FKs (cross-tenant / cross-property leak guards):
  constraint bookings_property_tenant_fk
    foreign key (property_id, tenant_id)
    references properties (id, tenant_id) on delete cascade,
  constraint bookings_room_type_property_fk
    foreign key (room_type_id, property_id)
    references room_types (id, property_id) on delete cascade,
  constraint bookings_guest_tenant_fk
    foreign key (guest_id, tenant_id)
    references guests (id, tenant_id) on delete cascade,

  -- booking_number unique WITHIN a property (SECTION 2).
  constraint bookings_property_number_unique unique (property_id, booking_number),

  -- Composite-FK TARGET for booking_nights: lets a night bind
  -- (booking_id, tenant_id, property_id) so a night's scoping can never disagree
  -- with its booking. Redundant-looking (id is already PK) but required — an FK
  -- must target a unique constraint on exactly the referenced columns.
  constraint bookings_id_tenant_property_unique unique (id, tenant_id, property_id)
);

comment on table bookings is
  'A reservation of nights for a room TYPE (RULE 3). Created ONLY through '
  'create_booking() — NEVER a direct insert (no insert RLS policy exists), because '
  'a direct insert bypasses the overbooking guard. status=cancelled frees the '
  'room; deleted_at is a separate "this row was a mistake" soft-delete.';
comment on column bookings.company_id is
  'FORWARD REFERENCE to 5b (company bookings). No FK yet — the companies table '
  'does not exist. Present now so the booking flow is built against its final shape.';
comment on column bookings.idempotency_key is
  'Retry/double-click guard (rules 2 & 3). Enforced by the partial unique index '
  'bookings_idem_uniq; used by create_booking to return the existing booking on a '
  'repeat call rather than creating a second one.';

-- Partial unique index — the DB-level idempotency enforcement (rule 3), present
-- from day one so no dormant 23505 handler waits on an index that never shipped.
create unique index if not exists bookings_idem_uniq
  on bookings (tenant_id, idempotency_key)
  where idempotency_key is not null;

-- Availability queries scan by property+type over a date window — the hot path
-- for count_available. Ordered to serve the range predicate.
create index if not exists bookings_availability_idx
  on bookings (property_id, room_type_id, check_in, check_out);
-- Operational lists filter by status within a property.
create index if not exists bookings_property_status_idx
  on bookings (property_id, status);
-- A guest's stay history.
create index if not exists bookings_guest_id_idx
  on bookings (guest_id);
-- tenant_id drives the member-select policy predicate; index it as 001/002 do.
create index if not exists bookings_tenant_id_idx
  on bookings (tenant_id);

drop trigger if exists set_row_audit_bookings on bookings;
create trigger set_row_audit_bookings
  before insert or update on bookings
  for each row execute function set_row_audit();

-- Field-level history: who changed a booking's status/dates, from what. Answers
-- "who cancelled this?" for disputes. AFTER UPDATE only.
drop trigger if exists log_field_changes_bookings on bookings;
create trigger log_field_changes_bookings
  after update on bookings for each row execute function log_field_changes();


-- ############################################################################
-- SECTION 5 — booking_nights (the per-night LOCKED rate)
-- ############################################################################
-- THE DECISION THAT MAKES CANCELLATION, MODIFICATION, COMPANY BILLING AND THE
-- FOLIO ALL CORRECT: the rate is LOCKED PER NIGHT AT BOOKING TIME, not recomputed
-- at read time.
--
-- A five-night stay across a weekend has DIFFERENT nightly rates (rack on
-- weekdays, weekend_rate on Fri/Sat, a seasonal override over Christmas). Storing
-- the resolved rate per night means a booking ALWAYS bills what was agreed, even
-- after the room type's rack/weekend/seasonal rates later move. Recomputing at
-- read time would silently RE-PRICE historical bookings whenever an admin edits a
-- rate — a serious correctness AND trust failure (the guest agreed to a price;
-- the system must honour it). rate_source records WHY each night cost what it did.
--
-- Insert-only in practice: a night is written once by create_booking and never
-- edited (so no log_field_changes trigger — there is nothing to diff).
create table if not exists booking_nights (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null,
  property_id  uuid not null,
  booking_id   uuid not null,

  stay_date    date not null,                 -- one row per night in [check_in, check_out)

  -- The rate RESOLVED for this night at booking time (via resolve_room_rate_detail),
  -- FROZEN here. Money per §6: numeric(14,2), never float, never JSONB.
  rate         numeric(14,2) not null,
  -- Why this night cost this: 'rack' | 'weekend' | 'seasonal'. Audit trail only.
  rate_source  text,

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  created_by   uuid default auth.uid() references auth.users(id),
  updated_by   uuid references auth.users(id),

  -- One row per (booking, night) — no duplicate nights.
  constraint booking_nights_booking_date_unique unique (booking_id, stay_date),

  -- Composite FK binding the triple to the parent booking, so a night's
  -- tenant_id/property_id can never disagree with its booking's. Cascade so
  -- nights fall with a HARD-deleted booking (soft-delete does not cascade —
  -- see §6's warning; bookings are not hard-deleted in normal operation).
  constraint booking_nights_booking_fk
    foreign key (booking_id, tenant_id, property_id)
    references bookings (id, tenant_id, property_id) on delete cascade
);

comment on table booking_nights is
  'One row per night of a stay, each carrying the rate LOCKED at booking time so '
  'the booking always bills what was agreed even after rates move. Recomputing at '
  'read time would re-price history — a correctness/trust failure. rate_source is '
  'the audit trail of why (rack/weekend/seasonal).';

create index if not exists booking_nights_tenant_id_idx
  on booking_nights (tenant_id);
-- Occupancy/revenue by date within a property (later reporting) reads by night.
create index if not exists booking_nights_property_date_idx
  on booking_nights (property_id, stay_date);

drop trigger if exists set_row_audit_booking_nights on booking_nights;
create trigger set_row_audit_booking_nights
  before insert or update on booking_nights
  for each row execute function set_row_audit();


-- ############################################################################
-- SECTION 6 — count_available (the availability answer)
-- ############################################################################
-- Returns how many units of a room type are free for [p_check_in, p_check_out).
--   total  = room_types.inventory_count (RULE 3 denominator; 0 if type missing/
--            soft-deleted, NULL-safe rule 5)
--   booked = bookings of this type whose status HOLDS inventory and that OVERLAP
--            the window by the half-open clash test (RULES 1 & 2)
--   result = greatest(0, total - booked)
--
-- OCCUPANCY STATUS (RULE 4): 'confirmed','checked_in','checked_out' always hold.
-- 'cancelled' and 'enquiry' never hold. 'no_show' holds BY DEFAULT (the room was
-- held for a guest who never arrived) but is made configurable via
-- p_count_no_show so a property can later choose to release no-shows.
--
-- p_exclude_booking_id lets a MODIFICATION (6b) re-check availability while
-- ignoring the booking being edited, so moving a booking's dates does not clash
-- with itself.
--
-- STABLE + SECURITY DEFINER + pinned search_path (same hardening as the resolvers).
create or replace function count_available(
  p_property_id       uuid,
  p_room_type_id      uuid,
  p_check_in          date,
  p_check_out         date,
  p_exclude_booking_id uuid    default null,
  p_count_no_show     boolean default true
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
  '(RULES 1&2); cancelled/enquiry never occupy, no_show occupies by default '
  '(RULE 4). p_exclude_booking_id ignores the booking being modified. STABLE.';


-- ############################################################################
-- SECTION 6.5 — is_tenant_staff (membership gate for STAFF operations)
-- ############################################################################
-- is_tenant_admin (001) is owner/manager ONLY — right for CONFIGURING a hotel
-- (rates, room types) but WRONG for OPERATING it: taking a booking is the front
-- desk's core job, and a receptionist who cannot book a walk-in is useless.
-- is_tenant_staff is the operational counterpart: true for ANY active member of
-- the tenant, regardless of role — the boolean form of the get_tenant_ids()
-- membership check, scoped to one tenant. Same hardening as is_tenant_admin
-- (STABLE, SECURITY DEFINER, pinned search_path) and the same fail-closed
-- property: EXISTS yields false, never NULL, so a missing membership DENIES.
-- SECURITY DEFINER also keeps its read of tenant_users from re-triggering that
-- table's RLS.
--
-- Finer per-role control (e.g. only managers may cancel a CHECKED-IN booking)
-- belongs to the staff-permissions build, NOT here. Booking is a STAFF act;
-- pricing stays an ADMIN act (is_tenant_admin, left unchanged on rate/room-type).
create or replace function is_tenant_staff(p_tenant_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  return exists (
    select 1 from tenant_users
    where user_id = auth.uid()
      and tenant_id = p_tenant_id
      and is_active = true
  );
end;
$$;

comment on function is_tenant_staff(uuid) is
  'True for any ACTIVE member of the tenant, any role — the boolean membership '
  'gate for STAFF operations (booking), as is_tenant_admin is for admin acts '
  '(pricing). Fail-closed; STABLE, SECURITY DEFINER, pinned search_path.';


-- ############################################################################
-- SECTION 7 — create_booking  (THE HEART: idempotent + un-double-bookable)
-- ############################################################################
--
--  ┌───────────────────────────────────────────────────────────────────────┐
--  │  THE OVERBOOKING GUARD — WHY WE LOCK BEFORE WE COUNT.                   │
--  │  (This is the single most important comment in the codebase.)          │
--  └───────────────────────────────────────────────────────────────────────┘
--
--  The naive flow is: count how many rooms are free; if > 0, insert. Under
--  concurrency this DOUBLE-BOOKS. With exactly ONE Deluxe left and two guests
--  booking the same nights at the same instant (READ COMMITTED, the default):
--
--    t1  caller A   count_available(...) -> 1     (one free)
--    t2  caller B   count_available(...) -> 1     (A has NOT committed, so B does
--                                                   not see A's row yet)
--    t3  caller A   INSERT booking       -> ok    (A took "the last room")
--    t4  caller B   INSERT booking       -> ok    (B also took "the last room")
--    ==> TWO confirmed bookings for ONE physical room. The unforgivable mistake.
--
--  The count is stale the instant it is read: nothing stops another transaction
--  inserting between B's count and B's insert. No CHECK constraint can catch it
--  either — the conflict is ACROSS ROWS, not within one row.
--
--  THE FIX: serialise the whole (count -> decide -> insert) for a given
--  (property_id, room_type_id) so it runs to completion for one caller before the
--  next may begin. We take a ROW LOCK on the room_types row with
--  SELECT ... FOR UPDATE *before* counting:
--
--    t1  caller A   SELECT room_types ... FOR UPDATE  -> acquires the row lock
--    t2  caller B   SELECT room_types ... FOR UPDATE  -> BLOCKS, waiting for A
--    t3  caller A   count -> 1, INSERT, COMMIT (releases the lock)
--    t4  caller B   unblocks, acquires lock, count -> 0 (A's row is now committed
--                   and visible), raises "no availability".
--    ==> Exactly ONE booking. The race is closed.
--
--  The lock is held to end-of-transaction and released automatically on
--  COMMIT/ROLLBACK, so a failed insert never strands it. We lock the room_types
--  ROW (not a table lock, not the property) so bookings for DIFFERENT types run in
--  parallel; only same-type creation serialises — exactly the contention needed,
--  no more. An advisory lock on hash(property_id, room_type_id) would behave
--  identically; the row lock is chosen because we must read that room_types row
--  anyway (inventory_count, occupancy limits), so one locking read does both jobs
--  and ties the lock to a concrete, real row.
--
--  INVARIANT ENFORCED: for any (property_id, room_type_id, night), the number of
--  occupancy-holding bookings covering that night never exceeds
--  room_types.inventory_count. NO code path may INSERT into bookings except
--  through this function — a direct insert bypasses the lock and voids the
--  guarantee. That is why bookings has NO insert RLS policy (SECTION 9).
--
--  This function also carries the rule-2 idempotency guard: a retry/double-click
--  with the same p_idempotency_key returns the EXISTING booking, never a second.
--
-- SECURITY DEFINER + pinned search_path; STAFF-gated via is_tenant_staff — taking
-- a booking is the front desk's core job, not an admin act (rate/room-type editing
-- stays admin-only). Finer per-role rules come with the staff-permissions build.
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

  -- Guest must exist within this tenant (the composite FK enforces it too, but a
  -- clear error beats a raw FK violation).
  if not exists (
    select 1 from guests
    where id = p_guest_id and tenant_id = v_tenant_id and deleted_at is null
  ) then
    raise exception 'Guest % not found for this tenant', p_guest_id
      using errcode = 'no_data_found';
  end if;

  -- ================= THE OVERBOOKING GUARD (see block above) ================
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

  -- Per-(tenant, property) booking number — never count(*)+1 (SECTION 2).
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
    -- resolve_room_rate_detail gives rate AND source so the audit trail is
    -- complete. Any NULL rate here (type vanished mid-transaction) would violate
    -- booking_nights.rate NOT NULL and roll the whole booking back — fail-safe.
    v_date := p_check_in;
    while v_date < p_check_out loop
      select rate, source into v_rate, v_source
      from resolve_room_rate_detail(p_room_type_id, v_date);

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
  'THE booking creation path. Idempotent (rule 2/3, bookings_idem_uniq) and '
  'UN-DOUBLE-BOOKABLE: it locks the room_types row (SELECT FOR UPDATE) before '
  'counting availability, serialising same-type creation so two callers cannot '
  'both take the last room. Locks the nightly rate per night. No other code path '
  'may insert a booking. SECURITY DEFINER, staff-gated (is_tenant_staff).';


-- ############################################################################
-- SECTION 8 — cancel_booking (RULE 4: cancelling FREES the room)
-- ############################################################################
-- Cancellation's effect on availability is the second half of RULE 4, so it
-- belongs to this correctness-focused build even though the cancel SCREEN is 6b.
-- Because bookings has no update RLS policy (all mutation goes through RPCs), this
-- is the sanctioned path to set status='cancelled'; a direct UPDATE is impossible
-- for clients. Naturally IDEMPOTENT (re-cancelling is a no-op returning the same
-- row), which satisfies rule 2's retry-safety by STATE — there is no separate
-- operation-key ledger yet, so p_idempotency_key is accepted for interface
-- consistency but the state check is the real guard.
create or replace function cancel_booking(
  p_booking_id      uuid,
  p_reason          text,
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
  -- Lock the booking row so a concurrent check-in/cancel cannot interleave.
  select * into v_booking
  from bookings
  where id = p_booking_id and deleted_at is null
  for update;

  if not found then
    raise exception 'Booking % not found', p_booking_id using errcode = 'no_data_found';
  end if;

  -- Staff gate: cancelling a reservation is front-desk work, like taking one.
  -- (Finer control — e.g. only a manager may cancel a CHECKED-IN stay — is the
  -- staff-permissions build; the status guard below already blocks cancelling
  -- anything past 'confirmed' here.)
  if not is_tenant_staff(v_booking.tenant_id) then
    raise exception 'Not authorised to cancel this booking'
      using errcode = 'insufficient_privilege';
  end if;

  -- Idempotent: already cancelled -> return unchanged (retry-safe, rule 2).
  if v_booking.status = 'cancelled' then
    return v_booking;
  end if;

  -- Only a live reservation can be cancelled. A checked_in/checked_out stay is a
  -- different reversal (it unwinds folio postings) and belongs to 6c.
  if v_booking.status not in ('enquiry','confirmed') then
    raise exception 'Cannot cancel a booking in status %', v_booking.status
      using errcode = 'check_violation';
  end if;

  update bookings
    set status              = 'cancelled',
        cancelled_at        = now(),
        cancellation_reason = p_reason,
        updated_by          = v_actor
  where id = p_booking_id
  returning * into v_booking;

  -- LOCKSTEP NOTE (rule 7): cancellation currently touches ONLY the booking's
  -- status. Availability needs nothing else — count_available computes live and
  -- already excludes 'cancelled', so the slot is freed the instant this commits;
  -- there is no availability CACHE to decrement. When the folio (6c) and ledger
  -- arrive, THIS function MUST also reverse their postings in the SAME
  -- transaction — that is where rule 7's "all stores in lockstep" becomes real.
  -- booking_nights rows are intentionally KEPT as the audit record of what was agreed.
  return v_booking;
end;
$$;

comment on function cancel_booking(uuid, text, text) is
  'Cancels a live reservation (status enquiry/confirmed -> cancelled), freeing the '
  'room per RULE 4 (count_available excludes cancelled). Idempotent by state. '
  'SECURITY DEFINER, staff-gated. Extend for folio/ledger reversal in 6c (rule 7).';


-- ############################################################################
-- SECTION 9 — Row-Level Security
-- ############################################################################
-- bookings & booking_nights: member READ only. NO insert/update/delete policy for
-- ANYONE — all mutation goes through the SECURITY DEFINER RPCs above (which run as
-- the function owner and bypass RLS). This is DELIBERATE and load-bearing: a
-- direct insert would bypass the overbooking guard (SECTION 7), so there is no
-- insert policy at all. document_counters: member read (transparency); writes are
-- function-only. NONE of these tables ever gets a public/anon policy — bookings
-- and guest occupancy are private operational data.

alter table bookings          enable row level security;
alter table booking_nights    enable row level security;
alter table document_counters enable row level security;

-- --- bookings: member READ only --------------------------------------------
drop policy if exists bookings_member_select on bookings;
create policy bookings_member_select on bookings
  for select to authenticated
  using (tenant_id = any(get_tenant_ids()));

-- NO insert policy — BY DESIGN. Inserts happen ONLY via create_booking (SECURITY
-- DEFINER), so the overbooking guard can never be bypassed. DO NOT ADD ONE.
drop policy if exists bookings_member_insert on bookings;
-- NO update policy — BY DESIGN. Status changes (cancel now; check-in/out in 6b)
-- go through RPCs so date/status edits cannot bypass the availability re-check.
drop policy if exists bookings_member_update on bookings;
-- NO delete policy — bookings are soft-deleted via a future RPC, never hard-deleted.
drop policy if exists bookings_member_delete on bookings;

-- --- booking_nights: member READ only --------------------------------------
drop policy if exists booking_nights_member_select on booking_nights;
create policy booking_nights_member_select on booking_nights
  for select to authenticated
  using (tenant_id = any(get_tenant_ids()));

-- NO write policies — nights are written only by create_booking. DO NOT ADD ONE.
drop policy if exists booking_nights_member_insert on booking_nights;
drop policy if exists booking_nights_member_update on booking_nights;
drop policy if exists booking_nights_member_delete on booking_nights;

-- --- document_counters: member READ only -----------------------------------
drop policy if exists document_counters_member_select on document_counters;
create policy document_counters_member_select on document_counters
  for select to authenticated
  using (tenant_id = any(get_tenant_ids()));

-- NO write policies — written only by next_document_number (SECURITY DEFINER).
drop policy if exists document_counters_member_insert on document_counters;
drop policy if exists document_counters_member_update on document_counters;
drop policy if exists document_counters_member_delete on document_counters;

-- NO public policy on ANY table in this migration — BY DESIGN. Bookings, guest
-- occupancy and counters are private operational data. If a future online-booking
-- site needs public availability, it must call a dedicated aggregate RPC (a free-
-- count per type), NEVER read these rows.


-- ############################################################################
-- SECTION 10 — Function grants
-- ############################################################################
-- SECURITY DEFINER functions default to EXECUTE for PUBLIC; revoke that and grant
-- only the intended audience. The guest site is ANONYMOUS and must not probe
-- availability, pricing, or create/cancel bookings from these primitives — those
-- come later through purpose-built, rate-limited public RPCs. So: authenticated
-- staff only, never anon. next_document_number is callable by NO client at all
-- (only from inside the SECURITY DEFINER RPCs, which run as owner) so numbers
-- cannot be burned by direct calls.

revoke execute on function next_document_number(uuid, uuid, text, text) from public;
revoke execute on function next_document_number(uuid, uuid, text, text) from anon;
revoke execute on function next_document_number(uuid, uuid, text, text) from authenticated;

revoke execute on function resolve_room_rate_detail(uuid, date) from public;
revoke execute on function resolve_room_rate_detail(uuid, date) from anon;
grant  execute on function resolve_room_rate_detail(uuid, date) to authenticated;

-- Re-assert 012's grant on the wrapper (create-or-replace preserved it; explicit).
revoke execute on function resolve_room_rate(uuid, date) from public;
revoke execute on function resolve_room_rate(uuid, date) from anon;
grant  execute on function resolve_room_rate(uuid, date) to authenticated;

revoke execute on function count_available(uuid, uuid, date, date, uuid, boolean) from public;
revoke execute on function count_available(uuid, uuid, date, date, uuid, boolean) from anon;
grant  execute on function count_available(uuid, uuid, date, date, uuid, boolean) to authenticated;

revoke execute on function create_booking(uuid, uuid, uuid, date, date, integer, text, integer, text, text, uuid) from public;
revoke execute on function create_booking(uuid, uuid, uuid, date, date, integer, text, integer, text, text, uuid) from anon;
grant  execute on function create_booking(uuid, uuid, uuid, date, date, integer, text, integer, text, text, uuid) to authenticated;

revoke execute on function cancel_booking(uuid, text, text) from public;
revoke execute on function cancel_booking(uuid, text, text) from anon;
grant  execute on function cancel_booking(uuid, text, text) to authenticated;

-- ============================================================================
-- End of 015_bookings.sql
-- ============================================================================
