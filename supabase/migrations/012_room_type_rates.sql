-- ============================================================================
-- 012_room_type_rates.sql
-- Palstro-Hotels: rate structure on room types (build 5a).
--
-- WHAT THIS ADDS, and what it deliberately does NOT:
--   * A room type can now price differently on weekends and during named
--     seasonal periods, with a clear, single-source-of-truth precedence.
--   * COMPANIES and negotiated corporate rates are build 5b — OUT OF SCOPE here.
--     resolve_room_rate() below is written so 5b WRAPS it (applying a company
--     discount against the rate this returns), never rewrites it.
--   * Physical rooms (002) are untouched — that is the housekeeping build.
--
-- Configuration-layer master data (docs/ARCHITECTURE.md): seasonal_rates carries
-- deleted_at soft-delete (not is_voided) and NO business_date — a rate override
-- is a standing rule, not something that "happened" on an operating day.
--
-- Conventions inherited verbatim from 001/002/005:
--   * shared set_row_audit() trigger owns every audit column,
--   * composite (id, tenant_id) / (id, property_id) FK targets make a child's
--     scoping columns structurally unable to disagree with its parent (002 §0),
--   * RLS scopes member reads via get_tenant_ids() and gates writes via
--     is_tenant_admin(); no public policy on operational pricing,
--   * sequential numbering, one concern per file, re-runnable (guarded DDL).
-- No seed data.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Rate columns on room_types
-- ----------------------------------------------------------------------------
-- base_rate stays the RACK RATE: the standard nightly price when no weekend or
-- seasonal rule applies. Renaming nothing keeps every existing reader (the guest
-- site's "from" price, 002's comment) correct.
comment on column room_types.base_rate is
  'The RACK RATE: the standard nightly price used when no weekend or seasonal '
  'rule applies. This is the public "from" price the guest site advertises. '
  'Weekend and dated pricing layer ON TOP via resolve_room_rate(); company '
  'discounts (build 5b) apply AGAINST the rate that function returns.';

-- weekend_rate: a flat nightly price for nights that fall on a weekend day.
-- NULLABLE and NULL is meaningful — see the comment. numeric(14,2) per §6 (money
-- is never float, never JSONB).
alter table room_types
  add column if not exists weekend_rate numeric(14,2);

comment on column room_types.weekend_rate is
  'Flat nightly price on a weekend night (see weekend_days). NULL means "NO '
  'weekend premium" — weekends fall back to base_rate — NOT zero. A literal 0 '
  'would price weekend nights free; leave it NULL to charge the rack rate.';

-- weekend_days: which ISO weekday numbers count as "weekend" for THIS room type,
-- because it varies by market. ISO day-of-week: Mon=1 .. Fri=5, Sat=6, Sun=7
-- (matches Postgres extract(isodow ...), which resolve_room_rate relies on).
-- Bonny Island hotels often treat Friday and Saturday NIGHTS as the weekend, so
-- the default is {5,6}; a hotel wanting Sat+Sun sets {6,7}. NOT NULL with a
-- default so the resolver never has to guard a null array.
alter table room_types
  add column if not exists weekend_days integer[] not null default '{5,6}';

comment on column room_types.weekend_days is
  'ISO weekday numbers that count as a weekend NIGHT for this type (Mon=1 .. '
  'Fri=5, Sat=6, Sun=7 — matching extract(isodow)). Default {5,6} = Fri+Sat, the '
  'common Bonny Island pattern; set {6,7} for Sat+Sun. Read by resolve_room_rate.';

-- ----------------------------------------------------------------------------
-- 2. seasonal_rates — dated, named rate overrides
-- ----------------------------------------------------------------------------
-- A named override for a date range ("Christmas", "Independence weekend") so the
-- owner reads WHY a period is priced differently, not just that it is.
create table if not exists seasonal_rates (
  id            uuid primary key default gen_random_uuid(),
  -- No inline FKs on the scoping columns: the two COMPOSITE FKs at the end bind
  -- the triple so tenant_id/property_id/room_type_id can never disagree.
  tenant_id     uuid not null,
  property_id   uuid not null,
  room_type_id  uuid not null,

  name          text not null,                 -- e.g. 'Christmas', 'Independence weekend'

  start_date    date not null,
  end_date      date not null,

  -- Money per §6: numeric(14,2), never float, never money-in-JSONB.
  rate          numeric(14,2) not null,

  deleted_at    timestamptz,                   -- soft delete (master data, rule 5)
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid default auth.uid() references auth.users(id),
  updated_by    uuid references auth.users(id),

  -- end must not precede start. A single-day period (start = end) is valid.
  constraint seasonal_rates_date_order_check check (end_date >= start_date),

  -- Composite FK: (property_id, tenant_id) must match a real properties row, so a
  -- seasonal rate's tenant_id can never disagree with its property's tenant — a
  -- cross-tenant leak RLS could not catch (every policy trusts tenant_id).
  constraint seasonal_rates_property_tenant_fk
    foreign key (property_id, tenant_id)
    references properties (id, tenant_id) on delete cascade,
  -- Composite FK: (room_type_id, property_id) must match a real room_types row,
  -- so a seasonal rate can NEVER point at a room type belonging to another
  -- property. Targets room_types' unique (id, property_id) key from 002.
  constraint seasonal_rates_room_type_property_fk
    foreign key (room_type_id, property_id)
    references room_types (id, property_id) on delete cascade
);

comment on table seasonal_rates is
  'Named, dated nightly-rate overrides for a room type (e.g. Christmas). '
  'OPERATIONAL pricing, not storefront data — deliberately NO public RLS policy, '
  'so a guest never sees dated pricing (the public price is the rack rate). '
  'Overlapping periods for one type are ALLOWED by design; precedence between '
  'them is resolved by resolve_room_rate(), never by a schema constraint.';
comment on column seasonal_rates.rate is
  'Flat nightly price while p_date is within [start_date, end_date]. Highest '
  'precedence in resolve_room_rate() — beats both weekend_rate and base_rate.';
comment on constraint seasonal_rates_date_order_check on seasonal_rates is
  'end_date must not precede start_date; a single-day period (start = end) is valid.';

-- DELIBERATELY NO exclusion/unique constraint preventing overlapping periods for
-- the same room type. Overlaps are legitimate (a broad "December" period plus a
-- tighter "Christmas week" inside it), and resolve_room_rate() picks a winner by
-- most-recently-created. The absence of an overlap constraint is intentional, not
-- an oversight — the resolution lives in the function, not the schema.

-- Range lookups by type + date drive resolve_room_rate; index them together.
create index if not exists seasonal_rates_type_date_idx
  on seasonal_rates (room_type_id, start_date, end_date);
-- tenant_id drives the member-select policy predicate; index it as 001/002 do.
create index if not exists seasonal_rates_tenant_id_idx
  on seasonal_rates (tenant_id);

drop trigger if exists set_row_audit_seasonal_rates on seasonal_rates;
create trigger set_row_audit_seasonal_rates
  before insert or update on seasonal_rates
  for each row execute function set_row_audit();

-- ----------------------------------------------------------------------------
-- 3. seasonal_rates RLS — member read, admin write, NO public policy
-- ----------------------------------------------------------------------------
-- Same pattern as room_types (002) MINUS the public-read policy: seasonal pricing
-- is operational, so it never reaches the guest site. With RLS on and no
-- anon/public policy, an anon SELECT returns zero rows (fail-closed) — which is
-- exactly what keeps dated pricing off the open web.
alter table seasonal_rates enable row level security;

-- SELECT: any active member of the owning tenant may read seasonal rates.
drop policy if exists seasonal_rates_member_select on seasonal_rates;
create policy seasonal_rates_member_select on seasonal_rates
  for select to authenticated
  using (tenant_id = any(get_tenant_ids()));

-- INSERT/UPDATE: admin only (owner/manager). Prevents a front_desk/housekeeper
-- from creating or editing pricing.
drop policy if exists seasonal_rates_member_insert on seasonal_rates;
create policy seasonal_rates_member_insert on seasonal_rates
  for insert to authenticated
  with check (is_tenant_admin(tenant_id));

drop policy if exists seasonal_rates_member_update on seasonal_rates;
create policy seasonal_rates_member_update on seasonal_rates
  for update to authenticated
  using (is_tenant_admin(tenant_id))
  with check (is_tenant_admin(tenant_id));

-- NO delete policy — BY DESIGN. Seasonal rates are SOFT-DELETED (set deleted_at
-- via the update policy). A hard DELETE would destroy the record of what a period
-- was priced at, which pricing history and audits must keep. The drop clears any
-- delete policy a prior version created.
drop policy if exists seasonal_rates_member_delete on seasonal_rates;

-- NO public policy — BY DESIGN. DO NOT ADD ONE. See the table comment: dated
-- pricing is operational and must not leak to anonymous visitors.

-- ----------------------------------------------------------------------------
-- 4. resolve_room_rate — the SINGLE SOURCE OF TRUTH for a type's price on a date
-- ----------------------------------------------------------------------------
-- Given a room type and a date, return the nightly rate, applying this precedence
-- (highest first):
--   1. A seasonal_rate whose [start_date, end_date] contains p_date. If several
--      overlap, the MOST RECENTLY CREATED wins — a deliberate tiebreak so the
--      owner's latest, most-specific override takes effect without needing an
--      overlap constraint the schema deliberately omits (see §2).
--   2. weekend_rate, when p_date falls on a configured weekend_day AND
--      weekend_rate is set (NULL = no premium, so fall through — never treat NULL
--      as 0).
--   3. base_rate (the rack rate).
--
-- BUILD 5b (company/negotiated rates) will WRAP this function, not replace it:
-- the value returned here is the RACK-SIDE price a company discount is applied
-- AGAINST. Keep it a pure pricing primitive so that wrapping stays a one-liner.
--
-- Hardening matches the 001/005 resolvers: STABLE (no writes, cacheable within a
-- statement), SECURITY DEFINER with a pinned search_path. plpgsql so the table
-- references resolve at runtime. Returns NULL only when the type does not exist,
-- so a caller renders MISSING_VALUE rather than a wrong number.
create or replace function resolve_room_rate(
  p_room_type_id uuid,
  p_date         date
)
returns numeric
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
  -- 1. Seasonal override — highest precedence. deleted_at is NULL-safe (rule 5):
  --    a soft-deleted seasonal rate NEVER counts. On overlap, newest wins.
  select sr.rate
    into v_seasonal
  from seasonal_rates sr
  where sr.room_type_id = p_room_type_id
    and sr.deleted_at is null
    and p_date between sr.start_date and sr.end_date
  order by sr.created_at desc          -- deliberate tiebreak: most recent override wins
  limit 1;

  if v_seasonal is not null then
    return v_seasonal;
  end if;

  -- Load the type's rack/weekend config in one read.
  select rt.base_rate, rt.weekend_rate, rt.weekend_days
    into v_base, v_weekend, v_weekend_days
  from room_types rt
  where rt.id = p_room_type_id;

  -- No such room type: nothing to price. (base_rate is NOT NULL, so a found row
  -- always has one.) NULL lets the caller show a dash rather than a stray 0.
  if v_base is null then
    return null;
  end if;

  -- 2. Weekend premium — only when set AND the date is a configured weekend day.
  --    extract(isodow) gives Mon=1 .. Sun=7, the same encoding weekend_days uses.
  --    NULL weekend_rate falls through to the rack rate (never treated as 0).
  if v_weekend is not null
     and extract(isodow from p_date)::integer = any(v_weekend_days) then
    return v_weekend;
  end if;

  -- 3. Rack rate.
  return v_base;
end;
$$;

comment on function resolve_room_rate(uuid, date) is
  'SINGLE SOURCE OF TRUTH for a room type''s nightly price on a date. Precedence: '
  'seasonal override (newest wins on overlap, soft-deleted ignored) > weekend_rate '
  '(when set and the date is a weekend_day) > base_rate (rack). Build 5b wraps '
  'this to apply company discounts against the returned rack-side price; it does '
  'not replace it. STABLE, SECURITY DEFINER, pinned search_path.';

-- Grants: authenticated only, never anon. The public guest site is ANONYMOUS and
-- must never learn weekend/seasonal pricing (§4 — the public price is the rack
-- rate); revoking anon keeps this dated-pricing primitive off the open web while
-- the admin rate preview (authenticated staff) can call it. SECURITY DEFINER
-- functions default to EXECUTE for PUBLIC, so revoke that explicitly.
revoke execute on function resolve_room_rate(uuid, date) from public;
revoke execute on function resolve_room_rate(uuid, date) from anon;
grant  execute on function resolve_room_rate(uuid, date) to authenticated;

-- ============================================================================
-- End of 012_room_type_rates.sql
-- ============================================================================
