-- ============================================================================
-- 021_folio_engine.sql
-- Palstro-Hotels: THE FOLIO ENGINE (build 6c, part 1 — schema + backend only;
-- the UI is part 2).
--
-- A folio is the guest's running account for a stay. It is one of the THREE
-- SHARED ENGINES in docs/ARCHITECTURE.md: bookings, F&B, laundry, housekeeping
-- and the minibar ALL post into it, and accounting reads it. Built once, or the
-- front desk cannot produce one correct bill at checkout.
--
-- ----------------------------------------------------------------------------
-- THE CORE PRINCIPLE: GENERIC, CATEGORY-DRIVEN, NEVER ONE-RPC-PER-TYPE
-- ----------------------------------------------------------------------------
-- There is NO post_room_charge, NO post_fnb_charge, NO post_laundry_charge, and
-- there never will be. There is ONE post_charge() RPC, driven by the
-- charge_categories reference table.
--
--   Adding "spa", "conference hall", "airport pickup" or "pet fee" next year is
--   an INSERT into charge_categories. NOT a migration. NOT a new function. NOT a
--   new RLS policy. NOT a code deploy.
--
-- The same principle governs TAX: taxes are not columns and not constants, they
-- are ROWS in tax_charges. A hotel that starts charging a tray charge adds a row;
-- a VAT rate change is an UPDATE. No function anywhere in this file contains a
-- tax rate literal (rule 17) — the seeded VAT rate is read from
-- tenant_settings.default_vat_rate, which is itself configurable.
--
-- Every one-RPC-per-type system ends the same way: eleven near-identical
-- functions that have silently drifted apart, so the discount rule works on F&B
-- and not on laundry, and nobody notices until an audit.
--
-- ----------------------------------------------------------------------------
-- THE FOUR DESIGN DECISIONS THIS MIGRATION MAKES (each asked for by the brief)
-- ----------------------------------------------------------------------------
--
-- DECISION 1 — THE FOLIO IS OPENED BY A TRIGGER ON bookings, NOT BY create_booking.
--   Chosen deliberately. create_booking is the highest-stakes function in the
--   codebase (015 §7: the SELECT ... FOR UPDATE overbooking guard). Editing it to
--   open a folio would mean re-touching that lock, its availability re-count and
--   its idempotency race handler for a reason that has nothing to do with
--   overbooking. An AFTER INSERT trigger on bookings gets the same guarantee —
--   every booking has a folio, always, in the SAME transaction as the booking —
--   with a ZERO-LINE DIFF to create_booking. It is also strictly stronger: any
--   future insert path (a channel-manager import, a data migration, a repair
--   script) gets a folio too, without remembering to.
--   >>> create_booking IS NOT MODIFIED BY THIS MIGRATION. The lock, the
--   >>> availability check and the idempotency handling are byte-for-byte 020.
--
-- DECISION 2 — ROOM CHARGES POST PER NIGHT, AT NIGHT AUDIT (NOT AT BOOKING TIME).
--   RECOMMENDED AND IMPLEMENTED as post_room_night_charge() (§9.2), which posts
--   ONE night at a time from the booking's LOCKED booking_nights rate.
--   Why not at booking creation: a booking is a reservation of FUTURE nights. If
--   create_booking posted all five nights up front, the folio would show a
--   balance for nights not yet stayed — so every cancellation, every date change
--   and every early departure would have to hunt down and reverse postings, and
--   an un-arrived guest would appear to owe money. Debtor reports would count
--   revenue that has not happened.
--   Why not "all of it at check-in" either: a guest who checks out two nights
--   early would have three nights to reverse. Posting the night that was actually
--   slept, on the business day it was slept (the standard PMS night-audit model),
--   means the folio balance is ALWAYS "what this guest owes right now" and
--   nothing ever needs unwinding. It also makes the charge's charge_date the real
--   business date (rule 12), which is what every report groups by.
--   The night-audit RUNNER (the scheduled job that walks in-house bookings and
--   calls this per night) belongs to the front-desk/night-audit build; the
--   posting primitive it needs lives here, and is idempotent per (booking, night)
--   so a re-run can never double-post.
--
-- DECISION 3 — folio_payments.amount IS A SINGLE SIGNED COLUMN, NOT amount + direction.
--   Positive = money in (deposit, settlement), negative = money out (refund).
--   Why: the balance is a SUM. A signed column sums directly. A magnitude plus a
--   direction flag is TWO sources of truth for one fact, and the moment they
--   disagree (direction='refund' with a negative amount = a double negative that
--   ADDS money) the folio is silently wrong and nothing errors. The sign is also
--   self-documenting in every export and every ad-hoc SQL query, where a
--   direction enum has to be remembered and joined. Enforced: amount <> 0.
--
-- DECISION 4 — received_by IS KEPT, AND IS NOT REDUNDANT WITH created_by.
--   They answer different questions and only usually coincide:
--     created_by  = who KEYED the row. Trigger-owned, non-forgeable (§6), the
--                   audit truth. This is the theft-detection column.
--     received_by = who TOOK THE MONEY. An operational claim, defaulting to the
--                   keying user. Cash handed to the duty manager at 23:00 and
--                   posted by the morning receptionist has two different people
--                   in these two columns, and the cash-up needs to know both.
--   If they were merged, that hand-over becomes invisible and the till variance
--   lands on the wrong person. See the column comment.
--
-- ----------------------------------------------------------------------------
-- ONE DELIBERATE DEVIATION FROM THE BRIEF (flagged, with the reason)
-- ----------------------------------------------------------------------------
-- The brief puts discount_threshold on property_settings. IT IS NOT PUT THERE.
-- property_settings carries a PUBLIC (anon) read policy — 001 §14 — because the
-- guest website renders from it. Postgres RLS is ROW-level, not column-level, so
-- a column added there is readable by the entire internet. "Discounts above
-- ₦50,000 need a manager" is internal financial policy, and 001 says in terms:
-- "NEVER put a rate, amount, tax figure, threshold ... in here", and "No table
-- holding ... financials ... may EVER receive a public policy".
-- So the threshold lives on a NEW per-property table, property_finance_settings
-- (§3), auto-provisioned by the same AFTER INSERT trigger pattern 001 uses, with
-- member-read/admin-write RLS and NO public policy. Still per property, still one
-- guaranteed row, just not published to anonymous visitors.
--
-- Conventions inherited from 001/006/012/014/015/016:
--   * shared set_row_audit() owns audit columns; log_field_changes() records edits
--     (EXCEPT on manager_pins — see §7, the hash must never enter change_log),
--   * composite (id, tenant_id) / (id, property_id) FK targets make a child's
--     scoping columns structurally unable to disagree with its parent,
--   * every write RPC takes p_idempotency_key backed by a PARTIAL UNIQUE INDEX
--     (rules 2 & 3); every function is SECURITY DEFINER with a pinned search_path,
--   * money numeric(14,2), quantities numeric(14,4) (§6),
--   * voided, never deleted; NULL-safe filters (rule 5).
-- Seed data: YES, and deliberately — charge categories per tenant and VAT per
-- property are REFERENCE data the engine cannot run without.
-- ============================================================================


-- ############################################################################
-- SECTION 1 — charge_categories (WHAT can be charged: the extension point)
-- ############################################################################
-- Per TENANT, not per property: a hotel group's chart of charge types is a
-- company decision (it maps to the chart of accounts, which is per tenant), and
-- two properties of the same group posting "fnb" to different categories would
-- make group revenue reports meaningless.
--
-- NOTE ON THE BRIEF: the brief's column list says "per tenant, unique per tenant"
-- but the seed line says "per property". The columns win — the table is
-- tenant-scoped and seeded per tenant (§1.2). tax_charges (§2) is the per-PROPERTY
-- one, which is correct: tax rates and surcharges genuinely differ by location.
create table if not exists charge_categories (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenants(id) on delete cascade,

  -- Machine key ('room','fnb','laundry',...). Code, not name, is what other
  -- modules look up by, so F&B posting does not break when the hotel renames
  -- "Food & Beverage" to "Restaurant".
  code               text not null,
  name               text not null,             -- display label; freely editable

  -- Tax behaviour, resolved against tax_charges.applies_to (§2). These two flags
  -- are the ENTIRE tax configuration of a charge type — there is no third place
  -- to look.
  is_taxable         boolean not null default true,
  service_chargeable boolean not null default true,

  -- ACCOUNTING HOOK, deliberately nullable FOR NOW. Rule 4 says accounts are
  -- resolved through account_mappings by ROLE KEY, never by a hardcoded code, and
  -- account_mappings does not exist yet (it is the first hard dependency of the
  -- accounting build — see docs/ARCHITECTURE.md "dependency order" §1). When it
  -- lands, this column becomes the role key that resolve_account() takes, and the
  -- posting path reads it here. Until then it is NULL and nothing reads it: a
  -- nullable hook is honest, a hardcoded '4000' would be a lie we later have to
  -- find and remove from every tenant.
  account_code       text,

  is_active          boolean not null default true,
  display_order      integer not null default 0,

  deleted_at         timestamptz,               -- soft delete (rule 5)
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  created_by         uuid default auth.uid() references auth.users(id),
  updated_by         uuid references auth.users(id),

  -- Composite-FK TARGET for folio_charges: lets a charge bind
  -- (charge_category_id, tenant_id) so a charge can never be posted against
  -- another tenant's category.
  constraint charge_categories_id_tenant_unique unique (id, tenant_id)
);

comment on table charge_categories is
  'The reference list of WHAT can be charged to a folio, per tenant. THE '
  'EXTENSION POINT of the folio engine: adding a charge type (spa, conference '
  'hall) is an INSERT here, never a migration and never a new RPC. Its '
  'is_taxable/service_chargeable flags are the whole tax configuration of a '
  'charge type, resolved against tax_charges.applies_to.';
comment on column charge_categories.code is
  'Stable machine key other modules post against (F&B posts ''fnb''). Renaming '
  'the display name must never break posting, which is why code is separate.';
comment on column charge_categories.account_code is
  'HOOK for the accounting build: the account_mappings ROLE KEY this category '
  'posts to (rule 4 — never a literal GL code). NULL until account_mappings '
  'exists; nothing reads it yet.';
comment on column charge_categories.is_taxable is
  'Whether tax_charges rows with applies_to=''taxable'' (e.g. VAT) apply to this '
  'category''s charges.';
comment on column charge_categories.service_chargeable is
  'Whether tax_charges rows with applies_to=''service_chargeable'' (e.g. the 10% '
  'service charge) apply to this category''s charges.';

-- Code unique per tenant AMONG LIVE ROWS. Partial (deleted_at is null) so a
-- category retired years ago does not block re-creating one with the same code —
-- the same shape as company_rates' live-unique index (016).
create unique index if not exists charge_categories_tenant_code_live_uniq
  on charge_categories (tenant_id, code)
  where deleted_at is null;

create index if not exists charge_categories_tenant_id_idx
  on charge_categories (tenant_id);

drop trigger if exists set_row_audit_charge_categories on charge_categories;
create trigger set_row_audit_charge_categories
  before insert or update on charge_categories
  for each row execute function set_row_audit();

drop trigger if exists log_field_changes_charge_categories on charge_categories;
create trigger log_field_changes_charge_categories
  after update on charge_categories for each row execute function log_field_changes();


-- ----------------------------------------------------------------------------
-- 1.2 — Default charge categories, seeded per tenant
-- ----------------------------------------------------------------------------
-- These are DEFAULTS, not a fixed list. Every one of them can be renamed,
-- deactivated, re-flagged or soft-deleted by the hotel, and the hotel can add as
-- many more as it likes — that is the whole point of the table.
--
-- The is_taxable / service_chargeable flags below encode common Nigerian hotel
-- practice as a STARTING POINT the hotel's accountant adjusts; they are data, not
-- law. Two worth explaining:
--   * damage      -> neither taxable nor service-chargeable. Recovering the cost
--                    of a broken basin is COMPENSATION, not a sale; charging
--                    service charge on it is indefensible to a guest.
--   * internet /
--     transport /
--     misc        -> taxable but NOT service-chargeable. Service charge is
--                    distributed to service staff; a fee nobody served does not
--                    generate one.
-- Room is taxable AND service-chargeable, always — it is the core sale.
create or replace function seed_charge_categories(p_tenant_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into charge_categories
    (tenant_id, code, name, is_taxable, service_chargeable, display_order)
  select p_tenant_id, d.code, d.name, d.is_taxable, d.service_chargeable, d.display_order
  from (values
    ('room',          'Room',            true,  true,  10),
    ('fnb',           'Food & Beverage', true,  true,  20),
    ('laundry',       'Laundry',         true,  true,  30),
    ('internet',      'Internet',        true,  false, 40),
    ('minibar',       'Minibar',         true,  true,  50),
    ('transport',     'Transport',       true,  false, 60),
    ('extra_bed',     'Extra Bed',       true,  true,  70),
    ('early_checkin', 'Early Check-in',  true,  true,  80),
    ('late_checkout', 'Late Check-out',  true,  true,  90),
    ('damage',        'Damage',          false, false, 100),
    ('misc',          'Miscellaneous',   true,  false, 110)
  ) as d(code, name, is_taxable, service_chargeable, display_order)
  where not exists (
    select 1 from charge_categories cc
    where cc.tenant_id = p_tenant_id
      and cc.code = d.code
      and cc.deleted_at is null
  );
end;
$$;

comment on function seed_charge_categories(uuid) is
  'Seeds a tenant''s DEFAULT charge categories (room, fnb, laundry, ... misc). '
  'Defaults only — the hotel renames, re-flags, deactivates or extends them '
  'freely. Idempotent: skips any live code that already exists.';

create or replace function seed_charge_categories_for_tenant()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform seed_charge_categories(new.id);
  return null;      -- AFTER trigger: return value ignored.
end;
$$;

drop trigger if exists seed_charge_categories_after_tenant_insert on tenants;
create trigger seed_charge_categories_after_tenant_insert
  after insert on tenants
  for each row execute function seed_charge_categories_for_tenant();

-- Backfill every tenant that already exists (this migration lands after the first
-- tenant was created by hand).
do $$
declare
  r record;
begin
  for r in select id from tenants loop
    perform seed_charge_categories(r.id);
  end loop;
end $$;


-- ############################################################################
-- SECTION 2 — tax_charges (the configurable tax / surcharge list)
-- ############################################################################
-- Per PROPERTY: VAT is federal, but a state consumption tax, a service charge
-- percentage and a tray charge are all decisions a single hotel makes, and a
-- group with a hotel in Lagos and one in Bonny may face different ones.
--
-- applies_to — THE DISTINCTION THAT MATTERS:
--   'taxable'            -> applies to charges whose category has is_taxable.
--                           This is a TAX proper: VAT, consumption tax. It is
--                           levied because the law says so, on things the law
--                           considers a taxable supply. Damage recovery is not.
--   'service_chargeable' -> applies to charges whose category has
--                           service_chargeable. This is a SURCHARGE the HOTEL
--                           levies and (typically) distributes to service staff:
--                           the 10% service charge, a tray/room-service charge.
-- They are NOT the same set. A minibar item is both; internet is taxable but not
-- service-chargeable; damage is neither. Collapsing the two into one flag makes
-- one of those three wrong, and it is always the one the guest argues about.
--
-- NON-COMPOUND BY DESIGN: every tax_charge is computed on the charge's OWN
-- net_amount, never on another tax's output. VAT-on-service-charge (compounding)
-- is a real thing in some jurisdictions but is NOT how these bills are struck
-- here, and a silent compounding is a silent overcharge. If a tenant ever needs
-- it, that is a deliberate later change (a compound_on column + a documented
-- evaluation order), never an ad-hoc tweak inside folio_charge_tax.
create table if not exists tax_charges (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null,
  property_id   uuid not null,

  code          text not null,                  -- 'vat','service','tray',...
  name          text not null,                  -- display label on the bill

  -- A RATE, not a percentage: 0.075 means 7.5%. The 0..1 check is the same guard
  -- 001 puts on tenant_settings.default_vat_rate and exists for the same reason —
  -- 7.5 entered instead of 0.075 would 100x every bill in the hotel.
  rate          numeric(5,4) not null
                  constraint tax_charges_rate_check
                  check (rate >= 0 and rate <= 1),

  -- A compulsory tax always applies and cannot be toggled off on a bill. VAT is
  -- seeded compulsory. Enforced by the guard trigger below: while is_compulsory
  -- is true the row can be neither soft-deleted nor deactivated.
  is_compulsory boolean not null default false,

  applies_to    text not null default 'taxable'
                  constraint tax_charges_applies_to_check
                  check (applies_to in ('taxable', 'service_chargeable')),

  is_active     boolean not null default true,
  display_order integer not null default 0,

  deleted_at    timestamptz,                    -- soft delete (rule 5)
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid default auth.uid() references auth.users(id),
  updated_by    uuid references auth.users(id),

  -- Composite FK: a tax's (property_id, tenant_id) must be a real property, so a
  -- tax row can never straddle tenants.
  constraint tax_charges_property_tenant_fk
    foreign key (property_id, tenant_id)
    references properties (id, tenant_id) on delete cascade
);

comment on table tax_charges is
  'Per-property taxes and surcharges applied to folio charges. ROWS, NOT '
  'CONSTANTS: a rate change is an UPDATE and a new surcharge is an INSERT — no '
  'function in this schema contains a tax rate literal (rule 17). Computed '
  'non-compound, each on the charge''s own net_amount.';
comment on column tax_charges.applies_to is
  '''taxable'' = a TAX proper (VAT), applying to categories flagged is_taxable. '
  '''service_chargeable'' = a hotel SURCHARGE (service/tray), applying to '
  'categories flagged service_chargeable. Different sets on purpose: internet is '
  'taxable but not service-chargeable; damage is neither.';
comment on column tax_charges.is_compulsory is
  'A compulsory tax (VAT) always applies and cannot be removed from a bill. While '
  'true, the guard trigger refuses both soft-delete and deactivation — the admin '
  'must first set is_compulsory=false, which is an explicit, logged decision.';
comment on column tax_charges.rate is
  'Fraction, not percent: 0.075 = 7.5%. Constrained to 0..1 so a 7.5 typo cannot '
  '100x every bill.';

-- Code unique per property among LIVE rows (same partial-unique reasoning as
-- charge_categories).
create unique index if not exists tax_charges_property_code_live_uniq
  on tax_charges (property_id, code)
  where deleted_at is null;

-- The hot path: folio_charge_tax / folio_totals read every live active tax for a
-- property on every balance computation.
create index if not exists tax_charges_property_active_idx
  on tax_charges (property_id, is_active);
create index if not exists tax_charges_tenant_id_idx
  on tax_charges (tenant_id);

drop trigger if exists set_row_audit_tax_charges on tax_charges;
create trigger set_row_audit_tax_charges
  before insert or update on tax_charges
  for each row execute function set_row_audit();

drop trigger if exists log_field_changes_tax_charges on tax_charges;
create trigger log_field_changes_tax_charges
  after update on tax_charges for each row execute function log_field_changes();


-- ----------------------------------------------------------------------------
-- 2.1 — The compulsory-tax guard
-- ----------------------------------------------------------------------------
-- A compulsory tax cannot be soft-deleted OR deactivated while it is compulsory.
-- Both are guarded, not just delete: deactivating VAT and soft-deleting VAT have
-- the IDENTICAL effect on a bill (it stops being charged), so guarding only one
-- of them would be a guard in name only.
--
-- The escape hatch is deliberate and two-step: set is_compulsory = false first
-- (an UPDATE the change_log records against a named user), then deactivate or
-- delete. Nobody can remove VAT from a hotel's bills by accident, and if it ever
-- happens the log says who decided it was no longer compulsory.
create or replace function guard_compulsory_tax_charge()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.is_compulsory then
    if new.deleted_at is not null and old.deleted_at is null then
      raise exception
        'Tax charge % (%) is compulsory and cannot be deleted. Set is_compulsory = false first.',
        new.code, new.name using errcode = 'check_violation';
    end if;
    if new.is_active = false and old.is_active = true then
      raise exception
        'Tax charge % (%) is compulsory and cannot be deactivated. Set is_compulsory = false first.',
        new.code, new.name using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

comment on function guard_compulsory_tax_charge() is
  'Refuses to soft-delete OR deactivate a tax_charge while is_compulsory is true. '
  'Both paths guarded because both have the same effect on a bill. Escape hatch: '
  'clear is_compulsory first — an explicit, change_log-recorded decision.';

drop trigger if exists guard_compulsory_tax_charges on tax_charges;
create trigger guard_compulsory_tax_charges
  before update on tax_charges
  for each row execute function guard_compulsory_tax_charge();


-- ----------------------------------------------------------------------------
-- 2.2 — Seed VAT per property (rate READ from tenant_settings, never a literal)
-- ----------------------------------------------------------------------------
-- Rule 17 in its sharpest form: the VAT rate is not written in this function. It
-- is READ from tenant_settings.default_vat_rate — the tenant-level, admin-editable
-- value 001 already established (Nigerian VAT is federal, hence tenant-level).
-- Seeded data, not a constant.
--
-- Only VAT is seeded, and it is seeded COMPULSORY. Service charge, tray charge,
-- consumption tax and anything else are the hotel's own decisions: the admin adds
-- them as compulsory or optional from the tax settings screen (part 2). We do not
-- presume a hotel charges service charge — plenty do not, and a surcharge we
-- invented appearing on a guest's bill is worse than one they have to add.
--
-- FAILS LOUD if the tenant has no settings row. 001's AFTER INSERT trigger
-- guarantees one, so this cannot happen; if it somehow did, seeding VAT at 0 (or
-- skipping it) would silently under-bill every guest of that property forever,
-- which is far worse than a failed property insert.
create or replace function seed_tax_charges(p_property_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant_id uuid;
  v_vat_rate  numeric(5,4);
begin
  select p.tenant_id into v_tenant_id
  from properties p where p.id = p_property_id;

  if v_tenant_id is null then
    raise exception 'seed_tax_charges: property % not found', p_property_id
      using errcode = 'no_data_found';
  end if;

  select ts.default_vat_rate into v_vat_rate
  from tenant_settings ts where ts.tenant_id = v_tenant_id;

  if v_vat_rate is null then
    raise exception
      'seed_tax_charges: tenant % has no tenant_settings row, so the VAT rate cannot be resolved',
      v_tenant_id using errcode = 'no_data_found';
  end if;

  insert into tax_charges
    (tenant_id, property_id, code, name, rate, is_compulsory, applies_to, display_order)
  select v_tenant_id, p_property_id, 'vat', 'VAT', v_vat_rate, true, 'taxable', 10
  where not exists (
    select 1 from tax_charges tc
    where tc.property_id = p_property_id
      and tc.code = 'vat'
      and tc.deleted_at is null
  );
end;
$$;

comment on function seed_tax_charges(uuid) is
  'Seeds a property''s compulsory VAT row, with the rate READ from '
  'tenant_settings.default_vat_rate — never a literal (rule 17). Service/tray '
  'charges are NOT seeded: they are the hotel''s own decision to add. Idempotent.';

create or replace function seed_tax_charges_for_property()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform seed_tax_charges(new.id);
  return null;
end;
$$;

drop trigger if exists seed_tax_charges_after_property_insert on properties;
create trigger seed_tax_charges_after_property_insert
  after insert on properties
  for each row execute function seed_tax_charges_for_property();

-- Backfill existing properties.
do $$
declare
  r record;
begin
  for r in select id from properties loop
    perform seed_tax_charges(r.id);
  end loop;
end $$;


-- ############################################################################
-- SECTION 3 — property_finance_settings (the discount threshold)
-- ############################################################################
-- See the header: this does NOT go on property_settings, because that table is
-- publicly readable by anonymous guest-site visitors (001 §14) and RLS cannot
-- hide a single column. A hotel's discount approval threshold is internal
-- financial policy.
--
-- Same guarantees as 001's settings tables: exactly one row per property,
-- auto-provisioned by an AFTER INSERT trigger, so no query in the app ever has to
-- handle a missing row.
create table if not exists property_finance_settings (
  property_id        uuid primary key references properties(id) on delete cascade,

  -- The PIN-free discount ceiling, in money (§6: numeric(14,2)).
  --   discount <= threshold -> the staff member's own authority; no PIN.
  --   discount >  threshold -> a manager PIN is required and the approving
  --                            manager is recorded on the charge.
  -- THRESHOLD 0 (the default) MEANS EVERY DISCOUNT NEEDS A MANAGER PIN. That is
  -- the deliberately strict default: a hotel that has not yet thought about this
  -- gets the safe answer, and loosening it is an explicit, logged decision by an
  -- admin who has decided how much they trust the front desk.
  -- A COMP (100% off) ALWAYS needs a PIN regardless of this number — see
  -- apply_charge_discount (§9.3).
  discount_threshold numeric(14,2) not null default 0
                       constraint property_finance_settings_threshold_check
                       check (discount_threshold >= 0),

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  created_by         uuid default auth.uid() references auth.users(id),
  updated_by         uuid references auth.users(id)
);

comment on table property_finance_settings is
  'Per-property INTERNAL finance config. Deliberately NOT property_settings: that '
  'table has a public (anon) read policy for the guest site and RLS cannot hide a '
  'column, so a threshold placed there would be world-readable. NEVER give this '
  'table a public policy.';
comment on column property_finance_settings.discount_threshold is
  'Largest discount a staff member may apply without a manager PIN. 0 (default) = '
  'EVERY discount needs approval — the strict default; the admin sets the hotel''s '
  'comfort level. A full comp always needs a PIN whatever this is.';

drop trigger if exists set_row_audit_property_finance_settings on property_finance_settings;
create trigger set_row_audit_property_finance_settings
  before insert or update on property_finance_settings
  for each row execute function set_row_audit();

-- Changing the threshold is exactly the kind of decision a theft investigation
-- needs to see ("who raised the no-PIN ceiling to ₦200,000 last Tuesday?").
drop trigger if exists log_field_changes_property_finance_settings on property_finance_settings;
create trigger log_field_changes_property_finance_settings
  after update on property_finance_settings for each row execute function log_field_changes();

create or replace function create_property_finance_settings_row()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into property_finance_settings (property_id)
  values (new.id)
  on conflict (property_id) do nothing;
  return new;
end;
$$;

drop trigger if exists create_property_finance_settings_after_insert on properties;
create trigger create_property_finance_settings_after_insert
  after insert on properties
  for each row execute function create_property_finance_settings_row();

-- Backfill existing properties.
insert into property_finance_settings (property_id)
select p.id from properties p
on conflict (property_id) do nothing;


-- ############################################################################
-- SECTION 4 — folios (the running account; NO cached balance)
-- ############################################################################
-- One folio per booking, opened automatically the instant the booking row exists
-- (DECISION 1 in the header — an AFTER INSERT trigger on bookings, so
-- create_booking is untouched).
--
-- >>> THERE IS NO balance COLUMN, AND THERE WILL NOT BE ONE. <<<
-- Rule 6: a cached balance is a reconciliation bug waiting to happen. It has to
-- be invalidated by every charge, every discount, every payment, every void, and
-- by a tax rate change that alters the tax on charges already posted — and the
-- day one of those paths forgets, the folio quietly disagrees with its own lines
-- and NOTHING ERRORS. The guest is billed the cached number; the ledger has the
-- real one. folio_balance() (§8.3) computes it live from the rows, every time.
-- If performance ever demands a cache, rule 6 says the recompute function ships
-- in the SAME PR as the cache and cancel/reversal updates it in lockstep (rule 7)
-- — a deliberate, later decision, not a shortcut taken now.
--
-- status: 'open' -> charges and payments may be posted.
--         'settled' -> the bill has been paid off; refunds/corrections still
--                      possible, new charges are not.
--         'closed' -> finalised (post-night-audit / post-checkout); frozen.
-- The transitions belong to the checkout flow (part 2 / front desk build); the
-- RPCs here simply refuse to post to a folio that is not in the right state.
create table if not exists folios (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  property_id uuid not null,
  booking_id  uuid not null,

  status      text not null default 'open'
                constraint folios_status_check
                check (status in ('open', 'settled', 'closed')),

  opened_at   timestamptz not null default now(),
  closed_at   timestamptz,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid default auth.uid() references auth.users(id),
  updated_by  uuid references auth.users(id),

  -- ONE folio per booking. Plain unique (not partial) — a folio is never deleted,
  -- so a booking can never acquire a second one.
  constraint folios_booking_unique unique (booking_id),

  -- Composite FK to the booking's (id, tenant_id, property_id) triple (015 §4's
  -- bookings_id_tenant_property_unique), so a folio's scoping columns can never
  -- disagree with its booking's.
  constraint folios_booking_fk
    foreign key (booking_id, tenant_id, property_id)
    references bookings (id, tenant_id, property_id) on delete cascade,

  -- Composite-FK TARGET for folio_charges / folio_payments.
  constraint folios_id_tenant_property_unique unique (id, tenant_id, property_id)
);

comment on table folios is
  'The guest''s running account for a stay — one per booking, opened by an AFTER '
  'INSERT trigger on bookings. NO CACHED BALANCE BY DESIGN (rule 6): the balance '
  'is computed live by folio_balance() from non-voided charges + their taxes minus '
  'non-voided payments. Written only via the RPCs in §9 (no write RLS policy).';
comment on column folios.status is
  'open = accepting charges/payments; settled = paid off, no new charges; closed = '
  'finalised and frozen. The RPCs refuse to post into the wrong state.';

create index if not exists folios_tenant_id_idx    on folios (tenant_id);
create index if not exists folios_property_status_idx on folios (property_id, status);

drop trigger if exists set_row_audit_folios on folios;
create trigger set_row_audit_folios
  before insert or update on folios
  for each row execute function set_row_audit();

drop trigger if exists log_field_changes_folios on folios;
create trigger log_field_changes_folios
  after update on folios for each row execute function log_field_changes();


-- ----------------------------------------------------------------------------
-- 4.1 — Open the folio automatically (DECISION 1)
-- ----------------------------------------------------------------------------
-- AFTER INSERT on bookings, in the SAME transaction as the booking, so "every
-- booking has a folio" is a structural fact and not a convention someone can
-- forget. SECURITY DEFINER because folios has no insert policy for anyone.
--
-- The folio is opened for EVERY booking including an 'enquiry' — an empty folio
-- costs one row and nothing else, and creating it up front means converting an
-- enquiry to a confirmed booking needs no extra step (and no "does a folio exist
-- yet?" branch anywhere in the app). created_by is carried from the booking so
-- the folio is attributed to whoever took the reservation.
create or replace function create_folio_for_booking()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into folios (tenant_id, property_id, booking_id, created_by)
  values (new.tenant_id, new.property_id, new.id, new.created_by)
  on conflict (booking_id) do nothing;
  return null;
end;
$$;

comment on function create_folio_for_booking() is
  'AFTER INSERT trigger on bookings: opens the stay''s folio in the same '
  'transaction. Chosen over editing create_booking so the overbooking guard '
  '(015 §7) is not re-touched, and so ANY future insert path gets a folio too.';

drop trigger if exists create_folio_after_booking_insert on bookings;
create trigger create_folio_after_booking_insert
  after insert on bookings
  for each row execute function create_folio_for_booking();

-- Backfill: every booking that already exists gets its folio.
insert into folios (tenant_id, property_id, booking_id, created_by)
select b.tenant_id, b.property_id, b.id, b.created_by
from bookings b
where not exists (select 1 from folios f where f.booking_id = b.id);


-- ############################################################################
-- SECTION 5 — folio_charges (the discount-as-its-own-line model)
-- ############################################################################
-- THE BILL MUST SHOW ITS WORKING: rack, then the discount, then the net. A
-- charge therefore records what was ORIGINALLY due (gross_amount) and the
-- reduction (discount_amount) as SEPARATE, VISIBLE figures, with net_amount the
-- arithmetic consequence.
--
-- The alternative — quietly writing a smaller amount — destroys exactly the
-- information the hotel needs: how much revenue was given away, by whom, to
-- which guest, and how often. A discount that leaves no trace is
-- indistinguishable from a rate that was simply lower, which is precisely how
-- front-desk revenue leakage hides.
--
-- TAXES ARE NOT STORED HERE. There are no vat_amount / service_amount columns and
-- there must not be. A stored tax is a snapshot of a rate at a moment: change VAT
-- from 7.5% to 10% and every historical row still says 7.5%, while a
-- freshly-recomputed total says 10%, and the two numbers on the same screen
-- disagree with no way to tell which is right. Tax is computed at display and
-- settlement time by folio_charge_tax() (§8.1) from the CURRENTLY ACTIVE
-- tax_charges against this charge's net_amount and its category's
-- is_taxable/service_chargeable flags. One derivation, one answer.
create table if not exists folio_charges (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null,
  property_id         uuid not null,
  folio_id            uuid not null,
  charge_category_id  uuid not null,

  description         text,

  -- §6: quantities are numeric(14,4). Four decimals because this same column
  -- will carry recipe-driven F&B quantities (0.0250 kg) once F&B posts here.
  quantity            numeric(14,4) not null default 1
                        constraint folio_charges_quantity_check check (quantity > 0),

  -- Money, §6: numeric(14,2), returned to the client as a STRING by PostgREST —
  -- parse with parseNumeric before any arithmetic, never rely on coercion.
  unit_amount         numeric(14,2) not null
                        constraint folio_charges_unit_amount_check check (unit_amount >= 0),
  gross_amount        numeric(14,2) not null
                        constraint folio_charges_gross_check check (gross_amount >= 0),
  discount_amount     numeric(14,2) not null default 0
                        constraint folio_charges_discount_check check (discount_amount >= 0),
  discount_reason     text,
  -- The manager whose PIN authorised an above-threshold discount, or the staff
  -- member themselves when the discount was within their own authority. THIS
  -- COLUMN IS THE POINT OF THE WHOLE DISCOUNT FEATURE: an unapproved discount is
  -- impossible to post, and every approved one names a person.
  discount_approved_by uuid references auth.users(id),
  net_amount          numeric(14,2) not null,

  -- The BUSINESS DATE of the charge (§6 business_date under its domain name;
  -- rules 8 and 12). Never derived from created_at: a bar sale keyed at 02:00
  -- belongs to the previous operating day, and every report groups by THIS.
  charge_date         date not null,

  -- Provenance. DELIBERATELY UNCONSTRAINED free text, not an enum: a new module
  -- posting to the folio must not require a migration to add its name to a CHECK
  -- constraint — that would reintroduce, through the back door, exactly the
  -- per-type coupling this engine exists to avoid.
  source              text not null default 'manual',

  -- Voided, never deleted (rule 5). Every read filters .not('is_voided','is',true).
  is_voided           boolean not null default false,
  voided_at           timestamptz,
  voided_by           uuid references auth.users(id),
  void_reason         text,

  -- Rules 2 & 3, TWO separate operations on this row, so TWO keys, each with its
  -- own partial unique index below:
  --   idempotency_key          -> the POSTING (post_charge)
  --   discount_idempotency_key -> the DISCOUNT (apply_charge_discount, which is
  --                               an UPDATE, so it cannot share the insert key)
  idempotency_key          text,
  discount_idempotency_key text,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  created_by          uuid default auth.uid() references auth.users(id),
  updated_by          uuid references auth.users(id),

  -- The arithmetic is a CONSTRAINT, not a convention: net is always exactly
  -- gross minus discount, and a discount can never exceed the charge.
  constraint folio_charges_net_check
    check (net_amount = gross_amount - discount_amount),
  constraint folio_charges_discount_le_gross_check
    check (discount_amount <= gross_amount),

  -- Composite FKs: the charge's scoping columns cannot disagree with its folio,
  -- and its category cannot belong to another tenant.
  constraint folio_charges_folio_fk
    foreign key (folio_id, tenant_id, property_id)
    references folios (id, tenant_id, property_id) on delete cascade,
  constraint folio_charges_category_tenant_fk
    foreign key (charge_category_id, tenant_id)
    references charge_categories (id, tenant_id)
);

comment on table folio_charges is
  'Every charge on a folio. DISCOUNT-AS-ITS-OWN-LINE: gross_amount and '
  'discount_amount are separate visible figures so the bill shows rack -> discount '
  '-> net and the hotel can see what was given away, by whom. NO TAX COLUMNS BY '
  'DESIGN — tax is computed live by folio_charge_tax() from the currently active '
  'tax_charges, so a rate change cannot make history disagree with itself.';
comment on column folio_charges.charge_date is
  'The BUSINESS date of the charge (§6''s business_date under a domain name). All '
  'reports group by this; created_at is audit metadata only (rules 8, 12).';
comment on column folio_charges.discount_approved_by is
  'WHO authorised the discount: the manager whose PIN was verified for an '
  'above-threshold discount or a comp, else the staff member acting within their '
  'own authority. The accountability record the discount feature exists to create.';
comment on column folio_charges.source is
  'Provenance (''room'',''manual'',''fnb'',''laundry''...). Free text ON PURPOSE: a '
  'new posting module must never need a migration to name itself.';
comment on column folio_charges.discount_idempotency_key is
  'Rule 2/3 key for apply_charge_discount, which UPDATES this row and so cannot '
  'reuse the insert key. Enforced by folio_charges_discount_idem_uniq.';

-- Rule 3: partial unique indexes from day one, one per operation.
create unique index if not exists folio_charges_idem_uniq
  on folio_charges (tenant_id, idempotency_key)
  where idempotency_key is not null;

create unique index if not exists folio_charges_discount_idem_uniq
  on folio_charges (tenant_id, discount_idempotency_key)
  where discount_idempotency_key is not null;

-- The folio view reads every charge of one folio; the balance reads the
-- non-voided ones. Both indexed, as the brief requires.
create index if not exists folio_charges_folio_id_idx
  on folio_charges (folio_id);
create index if not exists folio_charges_folio_voided_idx
  on folio_charges (folio_id, is_voided);
-- Revenue-by-business-date reporting within a property.
create index if not exists folio_charges_property_date_idx
  on folio_charges (property_id, charge_date);
create index if not exists folio_charges_tenant_id_idx
  on folio_charges (tenant_id);

drop trigger if exists set_row_audit_folio_charges on folio_charges;
create trigger set_row_audit_folio_charges
  before insert or update on folio_charges
  for each row execute function set_row_audit();

-- Every discount and every void is an UPDATE, so this trigger is what makes them
-- permanently answerable: who discounted this charge, from what to what, when.
drop trigger if exists log_field_changes_folio_charges on folio_charges;
create trigger log_field_changes_folio_charges
  after update on folio_charges for each row execute function log_field_changes();


-- ############################################################################
-- SECTION 6 — folio_payments (deposits, settlements, refunds)
-- ############################################################################
-- One table for all three, distinguished by the SIGN of amount (DECISION 3 in
-- the header). A deposit taken weeks before arrival is simply a positive payment
-- on an open folio — there is no separate deposits table and no deposit state
-- machine, because a deposit IS money received against this stay, which is
-- exactly what this row means. At checkout the balance already accounts for it.
create table if not exists folio_payments (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null,
  property_id   uuid not null,
  folio_id      uuid not null,

  -- SIGNED (DECISION 3): positive = money in (deposit, settlement), negative =
  -- money out (refund). One column, one source of truth, sums directly into the
  -- balance. Zero is meaningless and refused.
  amount        numeric(14,2) not null
                  constraint folio_payments_amount_nonzero_check check (amount <> 0),

  method        text not null
                  constraint folio_payments_method_check
                  check (method in ('cash','bank_transfer','pos','company_account','other')),
  reference     text,                            -- transfer ref, POS STAN, etc.

  -- Business date of the payment (rules 8, 12) — the operating day it belongs to,
  -- not the timestamp it was keyed.
  payment_date  date not null,

  -- Who physically TOOK the money (DECISION 4). Not redundant with created_by:
  -- created_by is trigger-owned and non-forgeable ("who keyed it"), received_by is
  -- an operational claim ("who took it") that differs whenever cash is handed over
  -- and posted later by someone else. The cash-up needs both.
  received_by   uuid references auth.users(id),

  is_voided     boolean not null default false,
  voided_at     timestamptz,
  voided_by     uuid references auth.users(id),
  void_reason   text,

  idempotency_key text,                          -- rules 2 & 3

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid default auth.uid() references auth.users(id),
  updated_by    uuid references auth.users(id),

  constraint folio_payments_folio_fk
    foreign key (folio_id, tenant_id, property_id)
    references folios (id, tenant_id, property_id) on delete cascade
);

comment on table folio_payments is
  'Deposits, settlements and refunds against a folio, distinguished by the SIGN '
  'of amount (+ in, - out) rather than a direction flag — one source of truth that '
  'sums straight into the balance. A pre-arrival deposit is just a positive '
  'payment on an open folio.';
comment on column folio_payments.amount is
  'SIGNED money (§6 numeric(14,2), a STRING over PostgREST). Positive = received, '
  'negative = refunded. A magnitude + direction pair would be two facts that can '
  'contradict each other; this cannot.';
comment on column folio_payments.received_by is
  'Who TOOK the money — an operational claim, defaulting to the keying user. '
  'created_by (trigger-owned, non-forgeable) remains the audit truth of who keyed '
  'the row. They differ on a hand-over, which is exactly when the cash-up needs '
  'to know both, so the column is NOT redundant.';

create unique index if not exists folio_payments_idem_uniq
  on folio_payments (tenant_id, idempotency_key)
  where idempotency_key is not null;

create index if not exists folio_payments_folio_id_idx
  on folio_payments (folio_id);
create index if not exists folio_payments_folio_voided_idx
  on folio_payments (folio_id, is_voided);
-- Daily cash-up / banking reconciliation by business date.
create index if not exists folio_payments_property_date_idx
  on folio_payments (property_id, payment_date);
create index if not exists folio_payments_tenant_id_idx
  on folio_payments (tenant_id);

drop trigger if exists set_row_audit_folio_payments on folio_payments;
create trigger set_row_audit_folio_payments
  before insert or update on folio_payments
  for each row execute function set_row_audit();

drop trigger if exists log_field_changes_folio_payments on folio_payments;
create trigger log_field_changes_folio_payments
  after update on folio_payments for each row execute function log_field_changes();


-- ############################################################################
-- SECTION 7 — manager PINs (hashed with pgcrypto — NEVER plaintext)
-- ############################################################################
--
--  ┌──────────────────────────────────────────────────────────────────────────┐
--  │  THE PIN IS NEVER STORED, LOGGED, RETURNED OR COMPARED IN PLAINTEXT.     │
--  └──────────────────────────────────────────────────────────────────────────┘
--
-- pin_hash holds a BCRYPT hash produced by pgcrypto's crypt(pin, gen_salt('bf')),
-- the same construction a password uses. It is a ONE-WAY function: there is no
-- code path in this schema, and there must never be one, that can turn a stored
-- hash back into a PIN. Verification re-hashes the CANDIDATE with the stored
-- hash's own embedded salt and compares — crypt(p_pin, mp.pin_hash) = mp.pin_hash.
--
-- Consequences that are DELIBERATE, not oversights:
--   * A forgotten PIN cannot be recovered, only RESET by its owner. Correct: a
--     PIN an administrator could read is a PIN an administrator could use to
--     approve a discount in someone else's name, which destroys the entire
--     accountability chain this table exists to create.
--   * manager_pins gets NO log_field_changes TRIGGER. change_log copies old and
--     new values into a table every member of the tenant can read (006), so
--     logging this column would publish every manager's hash to the whole staff.
--     The FACT that a PIN was set/changed is inferable from updated_at/updated_by;
--     the VALUE never leaves this table.
--   * manager_pins gets NO RLS SELECT POLICY EITHER — not even for the owner.
--     Nothing reads this table except the two SECURITY DEFINER functions below.
--     has_manager_pin() answers "do I have one?" without exposing the row.
--   * verify_manager_pin() is REVOKED from all client roles (§12). Exposing it
--     would hand every logged-in staff member a PIN-guessing oracle. It is
--     callable only from inside apply_charge_discount, which runs as owner.
--
-- BRUTE FORCE: a 4-8 digit PIN is a small secret. Its protection here is
-- (a) bcrypt's deliberate slowness, (b) the staff gate — only an ACTIVE member of
-- the tenant can reach any path that verifies a PIN, so the attacker set is
-- employees, not the internet, and (c) the trivially-weak-PIN rejection below.
-- Attempt throttling / lockout is a real remaining gap and belongs to the
-- staff-permissions build; it is named here so it is not forgotten.
create table if not exists manager_pins (
  tenant_id  uuid not null references tenants(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,

  -- BCRYPT hash. NEVER a PIN, never reversible, never selected by a client.
  pin_hash   text not null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid default auth.uid() references auth.users(id),
  updated_by uuid references auth.users(id),

  -- Per (user, tenant): a manager working for two hotel groups holds a separate
  -- PIN for each, so a PIN leaked at one company cannot approve at the other.
  primary key (tenant_id, user_id)
);

comment on table manager_pins is
  'Per-(manager, tenant) approval PIN, stored ONLY as a bcrypt hash via pgcrypto. '
  'No RLS read policy for anyone and NO change_log trigger (change_log is '
  'member-readable, so the hash must never enter it). Reachable only through '
  'set_manager_pin / verify_manager_pin / has_manager_pin.';
comment on column manager_pins.pin_hash is
  'BCRYPT hash of the PIN (crypt + gen_salt(''bf'')). ONE-WAY. Never store, log, '
  'return or transmit the PIN itself, in any form, anywhere.';

drop trigger if exists set_row_audit_manager_pins on manager_pins;
create trigger set_row_audit_manager_pins
  before insert or update on manager_pins
  for each row execute function set_row_audit();

-- NO log_field_changes trigger here — see the block above. Do not add one.


-- ----------------------------------------------------------------------------
-- 7.1 — set_manager_pin
-- ----------------------------------------------------------------------------
-- A manager sets or changes their OWN PIN. Nobody sets anyone else's: the
-- function takes no user_id at all, it uses auth.uid(), so there is no parameter
-- an admin could pass to plant a PIN on a colleague's account and then approve
-- discounts as them.
--
-- Takes p_tenant_id (a small deviation from the brief's set_manager_pin(p_pin)):
-- the PIN is keyed on (tenant_id, user_id) because a user can manage more than
-- one tenant, so the tenant must be named — there is no single "the" tenant to
-- infer, and inferring the wrong one would set a PIN nobody can use.
--
-- search_path is 'public, extensions': Supabase installs pgcrypto into the
-- extensions schema, so crypt()/gen_salt() are NOT resolvable from a
-- public-only path. This is load-bearing — without it the function raises
-- "function crypt(text, text) does not exist" at runtime.
create or replace function set_manager_pin(
  p_tenant_id uuid,
  p_pin       text
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'Not authenticated' using errcode = 'insufficient_privilege';
  end if;

  -- Only an owner/manager may hold an approval PIN. A PIN on a front-desk account
  -- would let the front desk approve its own above-threshold discounts, which is
  -- the exact hole the threshold exists to close.
  if not is_tenant_admin(p_tenant_id) then
    raise exception 'Only an owner or manager may set an approval PIN'
      using errcode = 'insufficient_privilege';
  end if;

  -- Format: 4-8 digits. Long enough not to be guessed in three tries, short
  -- enough to be typed at a busy front desk without the manager writing it down —
  -- and a PIN on a sticky note under the keyboard is a worse hole than a short PIN.
  if p_pin is null or p_pin !~ '^[0-9]{4,8}$' then
    raise exception 'A PIN must be 4 to 8 digits'
      using errcode = 'check_violation';
  end if;

  -- Reject the PINs that would be tried first: all-one-digit (0000, 7777) and
  -- straight runs in either direction (1234, 4321, 7890). The wrap digit in the
  -- literals catches 7890 and 0987.
  if p_pin ~ '^(.)\1*$'
     or position(p_pin in '01234567890') > 0
     or position(p_pin in '09876543210') > 0 then
    raise exception 'That PIN is too easy to guess; avoid repeated digits and simple sequences'
      using errcode = 'check_violation';
  end if;

  -- gen_salt('bf') -> bcrypt with a per-PIN random salt embedded in the hash, so
  -- two managers who chose the same PIN have different hashes and neither can
  -- recognise the other's.
  insert into manager_pins (tenant_id, user_id, pin_hash, created_by)
  values (p_tenant_id, v_user, crypt(p_pin, gen_salt('bf', 10)), v_user)
  on conflict (tenant_id, user_id) do update
    set pin_hash   = excluded.pin_hash,
        updated_by = v_user;
end;
$$;

comment on function set_manager_pin(uuid, text) is
  'Sets/changes the CALLING manager''s own approval PIN for a tenant, stored as a '
  'bcrypt hash. Takes no user_id by design — nobody can set another person''s PIN '
  'and then approve discounts as them. Owner/manager only; rejects trivially weak '
  'PINs. search_path includes extensions so pgcrypto''s crypt() resolves.';


-- ----------------------------------------------------------------------------
-- 7.2 — verify_manager_pin
-- ----------------------------------------------------------------------------
-- Returns the user_id of the manager whose PIN matches, or NULL.
--
-- IDENTIFYING *WHICH* MANAGER APPROVED IS THE ENTIRE POINT. A boolean "is this a
-- valid manager PIN?" would authorise the discount while leaving the bill saying
-- only "a manager approved this" — which, when the monthly discount report shows
-- ₦400,000 given away, names nobody. Returning the user_id is what puts a person
-- on the line, and it is why any manager's PIN authorises: whoever is on shift
-- can approve, and the record says it was them.
--
-- Checks the candidate against EVERY active owner/manager of the tenant, using
-- each stored hash's own salt. Fail-closed: no match, no membership, no row -> NULL.
create or replace function verify_manager_pin(
  p_tenant_id uuid,
  p_pin       text
)
returns uuid
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  v_manager uuid;
begin
  if p_pin is null or p_tenant_id is null then
    return null;
  end if;

  select mp.user_id into v_manager
  from manager_pins mp
  join tenant_users tu
    on tu.user_id = mp.user_id
   and tu.tenant_id = mp.tenant_id
  where mp.tenant_id = p_tenant_id
    and tu.is_active = true
    and tu.role in ('owner', 'manager')     -- a demoted manager's PIN stops working
    and mp.pin_hash = crypt(p_pin, mp.pin_hash)
  limit 1;

  return v_manager;   -- NULL when nothing matched: fail closed.
end;
$$;

comment on function verify_manager_pin(uuid, text) is
  'Returns the user_id of the ACTIVE owner/manager of the tenant whose PIN matches '
  'the candidate, else NULL. Identifying WHICH manager approved is the point — a '
  'boolean would authorise the discount and name nobody. Any manager''s PIN '
  'authorises, and the record says whose. REVOKED from all client roles (§12): it '
  'would otherwise be a PIN-guessing oracle.';


-- ----------------------------------------------------------------------------
-- 7.3 — has_manager_pin
-- ----------------------------------------------------------------------------
-- Lets the UI show "You have not set your approval PIN yet" without any client
-- ever reading manager_pins (which has no select policy). Answers only about the
-- CALLING user, so it cannot be used to enumerate which managers have PINs.
create or replace function has_manager_pin(p_tenant_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  return exists (
    select 1 from manager_pins
    where tenant_id = p_tenant_id and user_id = auth.uid()
  );
end;
$$;

comment on function has_manager_pin(uuid) is
  'Whether the CALLING user has set an approval PIN for this tenant. Answers only '
  'about the caller, so it cannot enumerate other managers. Exists so the UI never '
  'needs to read manager_pins (which no client can select from).';


-- ############################################################################
-- SECTION 8 — the computed money functions (NO cached anything)
-- ############################################################################

-- ----------------------------------------------------------------------------
-- 8.1 — folio_charge_tax: the tax breakdown of ONE charge
-- ----------------------------------------------------------------------------
-- Returns one row per tax that applies to this charge, with the money it adds.
-- This is what the bill prints under a line, and what folio_totals sums.
--
-- Which taxes apply is the intersection of two facts, and nothing else:
--   the tax's applies_to ('taxable' / 'service_chargeable')
--   x the category's flag (is_taxable / service_chargeable)
-- against the charge's NET amount (post-discount) — a discount reduces the tax
-- with it, because the guest is only taxed on what they are actually charged.
--
-- ROUNDING IS PER (CHARGE, TAX) LINE, TO 2 DP, AND folio_totals ROUNDS THE SAME
-- WAY. That is deliberate: if the printed lines rounded per line and the total
-- rounded the aggregate, the printed lines would not add up to the printed total
-- — by a few kobo, on some bills, unpredictably. Guests notice, and there is no
-- good answer at the desk. One rounding rule, applied in one place, both times.
--
-- A VOIDED charge returns no rows: a void carries no tax.
create or replace function folio_charge_tax(p_charge_id uuid)
returns table (
  tax_charge_id uuid,
  code          text,
  name          text,
  rate          numeric,
  amount        numeric
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_property_id uuid;
  v_net         numeric(14,2);
  v_taxable     boolean;
  v_service     boolean;
  v_voided      boolean;
begin
  -- DELIBERATELY NOT filtering cc.deleted_at here, and this is the one place the
  -- §6 "filter the soft-deleted parent" warning is INVERTED on purpose. A hotel
  -- that retires the "minibar" category next year must not thereby remove VAT
  -- from every minibar charge ever posted — dropping the join would silently
  -- under-bill and would make last year's reprinted bill disagree with last
  -- year's. A charge's tax behaviour is fixed by the category it was posted
  -- against, whether or not that category is still offered today.
  select fc.property_id, fc.net_amount, cc.is_taxable, cc.service_chargeable, fc.is_voided
    into v_property_id, v_net, v_taxable, v_service, v_voided
  from folio_charges fc
  join charge_categories cc on cc.id = fc.charge_category_id
  where fc.id = p_charge_id;

  if not found then
    return;                              -- unknown charge: no rows, never a wrong number
  end if;

  -- Rule 5, NULL-safe: anything not explicitly voided is live.
  if v_voided is true then
    return;
  end if;

  return query
  select tc.id,
         tc.code,
         tc.name,
         tc.rate,
         round(v_net * tc.rate, 2)
  from tax_charges tc
  where tc.property_id = v_property_id
    and tc.deleted_at is null              -- rule 5
    and tc.is_active = true
    and (
         (tc.applies_to = 'taxable'            and v_taxable)
      or (tc.applies_to = 'service_chargeable' and v_service)
    )
  order by tc.display_order, tc.code;
end;
$$;

comment on function folio_charge_tax(uuid) is
  'The tax breakdown of ONE folio charge: one row per applicable active tax_charge '
  'with its money, computed on the charge''s NET (post-discount) amount, rounded '
  'per line to 2dp — the same rounding folio_totals uses, so printed lines always '
  'add up to the printed total. Voided charge -> no rows.';


-- ----------------------------------------------------------------------------
-- 8.2 — folio_totals: the whole folio, decomposed
-- ----------------------------------------------------------------------------
-- INVARIANT (rule 9) — WHAT THIS RECONCILES TO:
--   net_total      = gross_total - discount_total                (per charge, by
--                    the folio_charges_net_check CHECK constraint, so the DB
--                    itself cannot hold a row where this is false)
--   charges_total  = net_total + tax_total
--   balance        = charges_total - payments_total
--   folio_balance(f) === (folio_totals(f)).balance                (8.3 is a wrapper)
-- and, upward:
--   sum(balance) over a property's OPEN folios === the front desk's "in-house
--   guest ledger" figure, and (once accounting lands) the Guest Ledger control
--   account in the chart of accounts. Any divergence there is a posting bug, not
--   a rounding artefact, because NOTHING here is cached — every figure is derived
--   from the same non-voided rows on every call.
--
-- Voided charges and voided payments are excluded via `is not true` (rule 5: for
-- is_voided a NULL means not-voided and must be KEPT).
create or replace function folio_totals(p_folio_id uuid)
returns table (
  gross_total    numeric,
  discount_total numeric,
  net_total      numeric,
  tax_total      numeric,
  charges_total  numeric,
  payments_total numeric,
  balance        numeric
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_gross    numeric(14,2) := 0;
  v_discount numeric(14,2) := 0;
  v_net      numeric(14,2) := 0;
  v_tax      numeric(14,2) := 0;
  v_paid     numeric(14,2) := 0;
begin
  select coalesce(sum(fc.gross_amount), 0),
         coalesce(sum(fc.discount_amount), 0),
         coalesce(sum(fc.net_amount), 0)
    into v_gross, v_discount, v_net
  from folio_charges fc
  where fc.folio_id = p_folio_id
    and fc.is_voided is not true;          -- rule 5

  -- Tax across the folio. The join IS the applicability rule from 8.1, expressed
  -- set-wise so the whole folio costs one query instead of one per charge; the
  -- per-(charge, tax) round() keeps it identical to the sum of the printed lines.
  -- charge_categories is joined WITHOUT a deleted_at filter, for the reason given
  -- in 8.1: retiring a category must never retroactively untax the charges that
  -- were posted against it. tax_charges IS filtered — a retired tax stops
  -- applying, which is what retiring a tax means.
  select coalesce(sum(round(fc.net_amount * tc.rate, 2)), 0)
    into v_tax
  from folio_charges fc
  join charge_categories cc on cc.id = fc.charge_category_id
  join tax_charges tc
    on tc.property_id = fc.property_id
   and tc.deleted_at is null
   and tc.is_active = true
   and (
        (tc.applies_to = 'taxable'            and cc.is_taxable)
     or (tc.applies_to = 'service_chargeable' and cc.service_chargeable)
   )
  where fc.folio_id = p_folio_id
    and fc.is_voided is not true;

  -- Payments are SIGNED (DECISION 3): a refund is negative and reduces the total
  -- received without any CASE expression.
  select coalesce(sum(fp.amount), 0)
    into v_paid
  from folio_payments fp
  where fp.folio_id = p_folio_id
    and fp.is_voided is not true;          -- rule 5

  gross_total    := v_gross;
  discount_total := v_discount;
  net_total      := v_net;
  tax_total      := v_tax;
  charges_total  := v_net + v_tax;
  payments_total := v_paid;
  balance        := (v_net + v_tax) - v_paid;
  return next;
end;
$$;

comment on function folio_totals(uuid) is
  'The folio decomposed: gross, discount, net, tax, charges (net+tax), payments '
  'and balance — all computed LIVE from non-voided rows, nothing cached (rule 6). '
  'INVARIANT (rule 9): net = gross - discount (DB-enforced per charge); charges = '
  'net + tax; balance = charges - payments; and sum(balance) over a property''s '
  'open folios reconciles to the in-house guest ledger.';


-- ----------------------------------------------------------------------------
-- 8.3 — folio_balance: the one number
-- ----------------------------------------------------------------------------
-- What the guest owes RIGHT NOW: net-of-discount charges, PLUS their taxes, MINUS
-- payments received (net of refunds). Positive = the guest owes the hotel;
-- negative = the hotel owes the guest (over-payment / unreturned deposit), which
-- is a real state and is deliberately NOT floored at zero — a GREATEST(0, ...)
-- here would hide money the hotel owes back, and rule 7 forbids exactly that kind
-- of floor for exactly that reason.
--
-- A thin wrapper over folio_totals so the two can never drift (the same
-- detail-plus-wrapper shape 015/016 use for the rate resolvers).
create or replace function folio_balance(p_folio_id uuid)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select balance from folio_totals(p_folio_id);
$$;

comment on function folio_balance(uuid) is
  'The live balance of a folio = non-voided net charges + their computed taxes - '
  'non-voided payments. Thin wrapper over folio_totals so they cannot drift. NOT '
  'floored at zero: a negative balance means the hotel owes the guest, and hiding '
  'that would hide real money (rule 7).';


-- ############################################################################
-- SECTION 9 — THE RPCs
-- ############################################################################
-- All SECURITY DEFINER with pinned search_path, all staff-gated via
-- is_tenant_staff (015 §6.5) except where a manager PIN raises the bar, all
-- idempotency-keyed per rules 2 & 3 against the partial unique indexes declared
-- beside their tables (§5, §6 — each index named in the function that uses it).
-- Every one of them runs inside the implicit transaction of the function call, so
-- a failure anywhere rolls the whole posting back (rule 11); errors are RAISEd
-- with meaningful SQLSTATEs for the client to humanize, never swallowed.

-- ----------------------------------------------------------------------------
-- 9.1 — post_charge: THE ONE CHARGE RPC
-- ----------------------------------------------------------------------------
-- F&B, laundry, minibar, spa, conference hall and everything not yet imagined
-- post through THIS function, passing their own charge_category_id. There is no
-- other charge-posting path and there must never be one — see the header.
--
-- p_charge_date may be NULL, meaning "the property's local today". It is not a
-- defaulted parameter because p_idempotency_key follows it and is mandatory
-- (rule 2); passing NULL explicitly is the documented way to say "now". The date
-- is resolved in the PROPERTY's timezone, exactly as create_booking does (020),
-- so a charge keyed at 00:30 Lagos time lands on the right operating day.
create or replace function post_charge(
  p_folio_id           uuid,
  p_charge_category_id uuid,
  p_description        text,
  p_quantity           numeric,
  p_unit_amount        numeric,
  p_charge_date        date,
  p_idempotency_key    text,
  p_source             text default 'manual'
)
returns folio_charges
language plpgsql
security definer
set search_path = public
as $$
declare
  v_folio    folios;
  v_tenant   uuid;
  v_timezone text;
  v_date     date;
  v_gross    numeric(14,2);
  v_existing folio_charges;
  v_charge   folio_charges;
  v_actor    uuid := auth.uid();
begin
  select * into v_folio from folios where id = p_folio_id;
  if not found then
    raise exception 'Folio % not found', p_folio_id using errcode = 'no_data_found';
  end if;
  v_tenant := v_folio.tenant_id;

  -- Staff gate (rule 19): posting a charge is front-desk / F&B / housekeeping
  -- work, not an admin act.
  if not is_tenant_staff(v_tenant) then
    raise exception 'Not authorised to post charges for this tenant'
      using errcode = 'insufficient_privilege';
  end if;

  -- IDEMPOTENCY fast path (rules 2 & 3): a retry or double-click with the same key
  -- returns the SAME charge. folio_charges_idem_uniq is the real guard under
  -- concurrency and is handled in the exception block below.
  if p_idempotency_key is not null then
    select * into v_existing
    from folio_charges
    where tenant_id = v_tenant and idempotency_key = p_idempotency_key
    limit 1;
    if found then
      return v_existing;
    end if;
  end if;

  -- A folio that is settled or closed does not take new charges. (A late charge
  -- on a departed guest is a real situation; it is handled by re-opening the
  -- folio in the checkout flow, which is a decision with an audit trail, not a
  -- silent posting into a closed bill.)
  if v_folio.status <> 'open' then
    raise exception 'Folio % is % and cannot take new charges', p_folio_id, v_folio.status
      using errcode = 'check_violation';
  end if;

  -- The category must belong to THIS tenant and be live and active. The composite
  -- FK enforces the tenant part structurally; this gives a clear error instead of
  -- a raw FK violation, and additionally blocks a retired category.
  if not exists (
    select 1 from charge_categories
    where id = p_charge_category_id
      and tenant_id = v_tenant
      and deleted_at is null               -- rule 5
      and is_active = true
  ) then
    raise exception 'Charge category % is not available for this tenant', p_charge_category_id
      using errcode = 'no_data_found';
  end if;

  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Quantity must be greater than zero' using errcode = 'check_violation';
  end if;
  if p_unit_amount is null or p_unit_amount < 0 then
    raise exception 'Unit amount cannot be negative' using errcode = 'check_violation';
  end if;

  -- Business date (rule 12), property-local. Same computation as 020's past-date
  -- guard, from the property's own timezone, with the same defensive fallback.
  if p_charge_date is not null then
    v_date := p_charge_date;
  else
    select p.timezone into v_timezone from properties p where p.id = v_folio.property_id;
    v_date := (now() at time zone coalesce(nullif(btrim(v_timezone), ''), 'Africa/Lagos'))::date;
  end if;

  -- gross = quantity x unit, rounded to money precision ONCE, here. quantity is
  -- numeric(14,4) precisely so a 0.0250 kg recipe line does not round to zero
  -- before it is multiplied out (§6).
  v_gross := round(p_quantity * p_unit_amount, 2);

  -- Posted with NO discount: discount is a separate, accountable act
  -- (apply_charge_discount), never something the posting call can smuggle in.
  begin
    insert into folio_charges (
      tenant_id, property_id, folio_id, charge_category_id,
      description, quantity, unit_amount,
      gross_amount, discount_amount, net_amount,
      charge_date, source, idempotency_key, created_by
    ) values (
      v_tenant, v_folio.property_id, p_folio_id, p_charge_category_id,
      p_description, p_quantity, p_unit_amount,
      v_gross, 0, v_gross,
      v_date, coalesce(nullif(btrim(p_source), ''), 'manual'), p_idempotency_key, v_actor
    )
    returning * into v_charge;
  exception
    when unique_violation then
      -- A CONCURRENT call with the same key won the race (folio_charges_idem_uniq).
      -- Return its row rather than creating a second charge (rule 2).
      if p_idempotency_key is not null then
        select * into v_existing
        from folio_charges
        where tenant_id = v_tenant and idempotency_key = p_idempotency_key
        limit 1;
        if found then
          return v_existing;
        end if;
      end if;
      raise;
  end;

  return v_charge;
end;
$$;

comment on function post_charge(uuid, uuid, text, numeric, numeric, date, text, text) is
  'THE ONE charge-posting RPC for the whole system — F&B, laundry, minibar, spa '
  'and everything later call it with their own charge_category_id. There is no '
  'post_room_charge/post_fnb_charge and never will be. Idempotent (rules 2/3, '
  'folio_charges_idem_uniq), staff-gated, posts with zero discount (discounting is '
  'the separate, accountable apply_charge_discount). NULL p_charge_date = the '
  'property''s local today (rule 12).';


-- ----------------------------------------------------------------------------
-- 9.2 — post_room_night_charge: how ROOM charges get onto the folio (DECISION 2)
-- ----------------------------------------------------------------------------
-- A thin, deliberate wrapper over post_charge — NOT a second charge RPC. It adds
-- exactly three things and then delegates:
--   1. it reads the LOCKED rate for that night from booking_nights (015 §5), so a
--      stay always bills what was agreed even if rack rates have since moved;
--   2. it resolves the tenant's 'room' category, so no caller hardcodes an id;
--   3. it builds a DETERMINISTIC idempotency key, 'room:<booking>:<date>', which
--      is what makes the night audit safe to re-run: a second run for the same
--      night returns the first run's charge instead of posting it twice. That
--      property is the entire reason this wrapper exists rather than leaving each
--      caller to invent a key.
-- The night-audit RUNNER (which loops in-house bookings and calls this) is the
-- front-desk build's job; this is the primitive it needs.
create or replace function post_room_night_charge(
  p_booking_id      uuid,
  p_stay_date       date,
  p_idempotency_key text default null
)
returns folio_charges
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking   bookings;
  v_folio_id  uuid;
  v_rate      numeric(14,2);
  v_category  uuid;
  v_type_name text;
  v_key       text;
begin
  select * into v_booking from bookings where id = p_booking_id and deleted_at is null;
  if not found then
    raise exception 'Booking % not found', p_booking_id using errcode = 'no_data_found';
  end if;

  if not is_tenant_staff(v_booking.tenant_id) then
    raise exception 'Not authorised to post room charges for this tenant'
      using errcode = 'insufficient_privilege';
  end if;

  select f.id into v_folio_id from folios f where f.booking_id = p_booking_id;
  if v_folio_id is null then
    raise exception 'Booking % has no folio', p_booking_id using errcode = 'no_data_found';
  end if;

  -- The rate LOCKED at booking time for this specific night (015 §5). Never
  -- re-resolved from the rate tables: re-pricing a stay after the fact is the
  -- correctness/trust failure booking_nights exists to prevent.
  select bn.rate into v_rate
  from booking_nights bn
  where bn.booking_id = p_booking_id and bn.stay_date = p_stay_date;

  if v_rate is null then
    raise exception 'Booking % has no night on %', p_booking_id, p_stay_date
      using errcode = 'no_data_found';
  end if;

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

  select rt.name into v_type_name from room_types rt where rt.id = v_booking.room_type_id;

  -- Deterministic key: the same night can never post twice, however many times the
  -- night audit runs or retries. A caller-supplied key overrides it only for the
  -- unusual case of a deliberate re-post.
  v_key := coalesce(p_idempotency_key, 'room:' || p_booking_id::text || ':' || p_stay_date::text);

  return post_charge(
    v_folio_id,
    v_category,
    coalesce(v_type_name, 'Room') || ' — ' || to_char(p_stay_date, 'DD Mon YYYY'),
    1,
    v_rate,
    p_stay_date,        -- the business date IS the night that was slept (rule 12)
    v_key,
    'room'
  );
end;
$$;

comment on function post_room_night_charge(uuid, date, text) is
  'Posts ONE night of a stay to its folio at the rate LOCKED in booking_nights, '
  'via post_charge (not a second charge RPC). Room charges post per night at night '
  'audit, not at booking time, so the folio balance is always "what is owed now" '
  'and a cancellation or early departure has nothing to unwind. Idempotency key '
  'defaults to room:<booking>:<date>, so a night-audit re-run cannot double-post.';


-- ----------------------------------------------------------------------------
-- 9.3 — apply_charge_discount: THE ACCOUNTABILITY HEART OF THIS BUILD
-- ----------------------------------------------------------------------------
--
--  ┌──────────────────────────────────────────────────────────────────────────┐
--  │  AN ABOVE-THRESHOLD DISCOUNT IS PROVABLY TIED TO A NAMED MANAGER, OR IT  │
--  │  DOES NOT HAPPEN. There is no third outcome.                             │
--  └──────────────────────────────────────────────────────────────────────────┘
--
-- The rules, in the order they are evaluated:
--
--   1. A COMP — a discount equal to the FULL charge (100% off) — ALWAYS requires a
--      manager PIN, WHATEVER the threshold is, even if the threshold is higher
--      than the amount and even if the amount is small. Writing off a charge
--      entirely is categorically different from reducing it: it is the single
--      easiest way to make a real sale disappear (serve the drinks, comp the bill,
--      pocket the cash), and it is the one act a hotel most needs a name against.
--      A ₦500 comp on a hotel with a ₦50,000 threshold still needs a manager.
--
--   2. Otherwise, compare against the property's discount_threshold:
--        discount <= threshold -> the staff member's OWN authority. No PIN.
--                                 discount_approved_by = the staff member, so even
--                                 an unremarkable discount has a name on it.
--        discount >  threshold -> verify_manager_pin() must return a manager.
--                                 If it returns NULL — wrong PIN, no PIN, a PIN
--                                 belonging to someone who has been deactivated or
--                                 demoted out of owner/manager — the whole call is
--                                 REJECTED and nothing is written.
--                                 discount_approved_by = THAT MANAGER's user_id.
--      Threshold 0 (the default) means every discount takes the manager branch.
--
-- The discount is ABSOLUTE, not cumulative: p_discount_amount is what the discount
-- BECOMES, not an amount added to whatever was there. Calling it twice with 5,000
-- leaves a 5,000 discount, not 10,000. Cumulative would mean a repeated click
-- silently doubles a write-off, and the second application would be attributed to
-- whoever happened to make the last call.
--
-- A reason is MANDATORY. "Discount: ₦20,000, reason: (blank)" is not an audit
-- trail, and the moment blanks are allowed they become the norm.
create or replace function apply_charge_discount(
  p_charge_id       uuid,
  p_discount_amount numeric,
  p_reason          text,
  p_manager_pin     text default null,
  p_idempotency_key text default null
)
returns folio_charges
language plpgsql
security definer
set search_path = public
as $$
declare
  v_charge    folio_charges;
  v_existing  folio_charges;
  v_folio     folios;
  v_threshold numeric(14,2);
  v_manager   uuid;
  v_approver  uuid;
  v_is_comp   boolean;
  v_actor     uuid := auth.uid();
begin
  -- Lock the charge: two people discounting the same line at once must serialise,
  -- or the second silently overwrites the first's approval and reason.
  select * into v_charge from folio_charges where id = p_charge_id for update;
  if not found then
    raise exception 'Charge % not found', p_charge_id using errcode = 'no_data_found';
  end if;

  if not is_tenant_staff(v_charge.tenant_id) then
    raise exception 'Not authorised to discount charges for this tenant'
      using errcode = 'insufficient_privilege';
  end if;

  -- IDEMPOTENCY (rules 2 & 3) against folio_charges_discount_idem_uniq. A repeat
  -- of the same approved discount returns the row as it stands — crucially
  -- WITHOUT re-checking the PIN, so a retry after a network drop does not demand
  -- the manager come back to the terminal.
  if p_idempotency_key is not null then
    select * into v_existing
    from folio_charges
    where tenant_id = v_charge.tenant_id
      and discount_idempotency_key = p_idempotency_key
    limit 1;
    if found then
      return v_existing;
    end if;
  end if;

  if v_charge.is_voided is true then
    raise exception 'Charge % is voided and cannot be discounted', p_charge_id
      using errcode = 'check_violation';
  end if;

  select * into v_folio from folios where id = v_charge.folio_id;
  if v_folio.status <> 'open' then
    raise exception 'Folio % is % and its charges cannot be discounted',
      v_folio.id, v_folio.status using errcode = 'check_violation';
  end if;

  if p_discount_amount is null or p_discount_amount <= 0 then
    raise exception 'A discount must be greater than zero' using errcode = 'check_violation';
  end if;
  if p_discount_amount > v_charge.gross_amount then
    raise exception 'A discount (%) cannot exceed the charge (%)',
      p_discount_amount, v_charge.gross_amount using errcode = 'check_violation';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'A discount needs a reason' using errcode = 'check_violation';
  end if;

  -- The property's no-PIN ceiling. property_finance_settings is guaranteed to have
  -- a row (§3's AFTER INSERT trigger), but coalesce to 0 anyway: if it were ever
  -- missing, the safe reading is "everything needs approval", never "nothing does".
  select pfs.discount_threshold into v_threshold
  from property_finance_settings pfs
  where pfs.property_id = v_charge.property_id;
  v_threshold := coalesce(v_threshold, 0);

  -- RULE 1: a comp is 100% off. Compared against gross because the discount is
  -- absolute and replaces any previous one.
  v_is_comp := (p_discount_amount >= v_charge.gross_amount);

  if v_is_comp or p_discount_amount > v_threshold then
    -- THE MANAGER BRANCH. Nothing is written unless a real PIN matches a real,
    -- currently-active manager of this tenant.
    v_manager := verify_manager_pin(v_charge.tenant_id, p_manager_pin);
    if v_manager is null then
      if v_is_comp then
        raise exception
          'A full comp always requires a manager PIN, whatever the discount threshold'
          using errcode = 'insufficient_privilege';
      else
        raise exception
          'A discount above the approval threshold (%) requires a valid manager PIN',
          v_threshold using errcode = 'insufficient_privilege';
      end if;
    end if;
    v_approver := v_manager;
  else
    -- WITHIN THE STAFF MEMBER'S OWN AUTHORITY. Still named: an in-threshold
    -- discount is attributed to whoever applied it, so the pattern "the same
    -- receptionist gives ₦4,900 off every night" is visible in the reports.
    v_approver := v_actor;
  end if;

  begin
    update folio_charges
       set discount_amount          = p_discount_amount,
           discount_reason          = btrim(p_reason),
           discount_approved_by     = v_approver,
           -- Recomputed, not adjusted: net is always exactly gross - discount, and
           -- the folio_charges_net_check CHECK constraint refuses anything else.
           net_amount               = v_charge.gross_amount - p_discount_amount,
           discount_idempotency_key = p_idempotency_key,
           updated_by               = v_actor
     where id = p_charge_id
    returning * into v_charge;
  exception
    when unique_violation then
      -- A concurrent call with the same discount key won the race; return its row.
      if p_idempotency_key is not null then
        select * into v_existing
        from folio_charges
        where tenant_id = v_charge.tenant_id
          and discount_idempotency_key = p_idempotency_key
        limit 1;
        if found then
          return v_existing;
        end if;
      end if;
      raise;
  end;

  -- The change_log trigger on folio_charges has now recorded the before/after of
  -- discount_amount, discount_reason, discount_approved_by and net_amount against
  -- the acting user — so the discount is answerable from two directions: the row
  -- says who approved it, the log says who applied it and what it replaced.
  return v_charge;
end;
$$;

comment on function apply_charge_discount(uuid, numeric, text, text, text) is
  'Applies an ACCOUNTABLE discount to a charge. At or below the property''s '
  'discount_threshold: the staff member''s own authority, and they are named as '
  'approver. Above it: verify_manager_pin must return an active manager or the '
  'call is rejected outright, and THAT manager is named. A full comp (100% off) '
  'ALWAYS requires a manager PIN whatever the threshold — writing a sale off '
  'entirely is the act most in need of a name. Absolute (not cumulative), reason '
  'mandatory, net recomputed, idempotent via folio_charges_discount_idem_uniq.';


-- ----------------------------------------------------------------------------
-- 9.4 — record_payment
-- ----------------------------------------------------------------------------
-- A DEPOSIT IS JUST A PAYMENT ON AN OPEN FOLIO. A guest who pays ₦100,000 three
-- weeks before arrival gets a positive folio_payment on their (already open,
-- because the folio is created with the booking) folio; the balance goes negative
-- until charges post against it and then nets off at checkout. There is no
-- separate deposit table, no deposit state and no "convert deposit to payment"
-- step — all of which would be extra machinery holding the same fact, and a
-- second place for the money to be recorded differently.
--
-- Rule 10 lives in the UI, not here: the payment SCREEN must start EMPTY and the
-- user must type the amount. This RPC deliberately has no "settle the balance"
-- convenience and no default amount, so no caller can pre-fill one.
create or replace function record_payment(
  p_folio_id        uuid,
  p_amount          numeric,
  p_method          text,
  p_reference       text,
  p_payment_date    date,
  p_idempotency_key text
)
returns folio_payments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_folio    folios;
  v_tenant   uuid;
  v_timezone text;
  v_date     date;
  v_existing folio_payments;
  v_payment  folio_payments;
  v_actor    uuid := auth.uid();
begin
  select * into v_folio from folios where id = p_folio_id;
  if not found then
    raise exception 'Folio % not found', p_folio_id using errcode = 'no_data_found';
  end if;
  v_tenant := v_folio.tenant_id;

  if not is_tenant_staff(v_tenant) then
    raise exception 'Not authorised to record payments for this tenant'
      using errcode = 'insufficient_privilege';
  end if;

  -- IDEMPOTENCY (rules 2 & 3) against folio_payments_idem_uniq. This one matters
  -- most of all: a double-clicked "Record ₦200,000" that posts twice makes the
  -- hotel believe it has been paid twice.
  if p_idempotency_key is not null then
    select * into v_existing
    from folio_payments
    where tenant_id = v_tenant and idempotency_key = p_idempotency_key
    limit 1;
    if found then
      return v_existing;
    end if;
  end if;

  -- Payments are accepted on an OPEN folio and on a SETTLED one (a refund or a
  -- correction after settlement is legitimate), but never on a CLOSED one —
  -- closed means finalised, and money moving into a finalised bill with no
  -- re-opening decision is how reconciliations start disagreeing.
  if v_folio.status = 'closed' then
    raise exception 'Folio % is closed and cannot take payments', p_folio_id
      using errcode = 'check_violation';
  end if;

  if p_amount is null or p_amount = 0 then
    raise exception 'A payment amount cannot be zero' using errcode = 'check_violation';
  end if;
  if p_method is null or p_method not in ('cash','bank_transfer','pos','company_account','other') then
    raise exception 'Unknown payment method %', p_method using errcode = 'check_violation';
  end if;

  -- Business date (rules 8, 12), property-local — the operating day the cash-up
  -- will look for it on.
  if p_payment_date is not null then
    v_date := p_payment_date;
  else
    select p.timezone into v_timezone from properties p where p.id = v_folio.property_id;
    v_date := (now() at time zone coalesce(nullif(btrim(v_timezone), ''), 'Africa/Lagos'))::date;
  end if;

  begin
    insert into folio_payments (
      tenant_id, property_id, folio_id, amount, method, reference,
      payment_date, received_by, idempotency_key, created_by
    ) values (
      v_tenant, v_folio.property_id, p_folio_id, p_amount, p_method, p_reference,
      v_date,
      -- received_by (DECISION 4) defaults to the keying user, which is the common
      -- case. A hand-over — cash taken by one person, posted by another — is
      -- recorded by the checkout screen passing the real receiver once the
      -- staff-permissions build exists. created_by stays the non-forgeable truth.
      v_actor,
      p_idempotency_key, v_actor
    )
    returning * into v_payment;
  exception
    when unique_violation then
      if p_idempotency_key is not null then
        select * into v_existing
        from folio_payments
        where tenant_id = v_tenant and idempotency_key = p_idempotency_key
        limit 1;
        if found then
          return v_existing;
        end if;
      end if;
      raise;
  end;

  return v_payment;
end;
$$;

comment on function record_payment(uuid, numeric, text, text, date, text) is
  'Records a payment (positive) or refund (negative) against a folio. A pre-arrival '
  'DEPOSIT is simply a positive payment on the already-open folio — no separate '
  'deposit table or state. Idempotent (rules 2/3, folio_payments_idem_uniq) because '
  'a double-clicked payment makes the hotel believe it was paid twice. Staff-gated. '
  'No amount default anywhere: rule 10 requires the user to type it.';


-- ----------------------------------------------------------------------------
-- 9.5 — void_charge / void_payment: VOIDED, NEVER DELETED
-- ----------------------------------------------------------------------------
-- Nothing on a folio is ever deleted. A mistaken ₦150,000 charge that vanishes is
-- indistinguishable from a charge that was never posted, which is precisely the
-- cover a dishonest posting needs. A void leaves the original line, its amount,
-- its author, and now a reason, a time and a name against the reversal.
--
-- HOW A VOID REACHES THE BALANCE: it does not decrement anything, because nothing
-- is cached (rule 6). folio_balance / folio_totals filter with
-- `is_voided is not true` — the NULL-safe form required by rule 5, which KEEPS
-- rows whose flag was never set (a NULL means not-voided) and drops only rows
-- explicitly marked. `= false` would silently drop every NULL row from the bill.
--
-- IDEMPOTENCY: these are idempotent BY STATE — voiding an already-voided row
-- returns it unchanged. p_idempotency_key is accepted for interface consistency
-- (rule 2) and is not stored, exactly as cancel_booking does (015 §8) and for the
-- same reason: the state check is a stronger guard than a key here, since it also
-- catches a retry that arrives with a *different* key.
create or replace function void_charge(
  p_charge_id       uuid,
  p_reason          text,
  p_idempotency_key text default null
)
returns folio_charges
language plpgsql
security definer
set search_path = public
as $$
declare
  v_charge folio_charges;
  v_folio  folios;
  v_actor  uuid := auth.uid();
begin
  select * into v_charge from folio_charges where id = p_charge_id for update;
  if not found then
    raise exception 'Charge % not found', p_charge_id using errcode = 'no_data_found';
  end if;

  if not is_tenant_staff(v_charge.tenant_id) then
    raise exception 'Not authorised to void charges for this tenant'
      using errcode = 'insufficient_privilege';
  end if;

  -- Idempotent by state: already voided -> return unchanged (retry-safe).
  if v_charge.is_voided is true then
    return v_charge;
  end if;

  select * into v_folio from folios where id = v_charge.folio_id;
  if v_folio.status = 'closed' then
    raise exception 'Folio % is closed; its charges cannot be voided', v_folio.id
      using errcode = 'check_violation';
  end if;

  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'A void needs a reason' using errcode = 'check_violation';
  end if;

  update folio_charges
     set is_voided   = true,
         voided_at   = now(),
         voided_by   = v_actor,
         void_reason = btrim(p_reason),
         updated_by  = v_actor
   where id = p_charge_id
  returning * into v_charge;

  return v_charge;
end;
$$;

comment on function void_charge(uuid, text, text) is
  'Voids a charge — sets is_voided with a reason, time and actor; NEVER deletes '
  '(rule 5). Excluded from folio_balance by the NULL-safe `is_voided is not true` '
  'filter, so no cache is decremented and nothing can drift. Idempotent by state; '
  'p_idempotency_key accepted for interface consistency (as cancel_booking, 015 §8).';

create or replace function void_payment(
  p_payment_id      uuid,
  p_reason          text,
  p_idempotency_key text default null
)
returns folio_payments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payment folio_payments;
  v_folio   folios;
  v_actor   uuid := auth.uid();
begin
  select * into v_payment from folio_payments where id = p_payment_id for update;
  if not found then
    raise exception 'Payment % not found', p_payment_id using errcode = 'no_data_found';
  end if;

  if not is_tenant_staff(v_payment.tenant_id) then
    raise exception 'Not authorised to void payments for this tenant'
      using errcode = 'insufficient_privilege';
  end if;

  if v_payment.is_voided is true then
    return v_payment;
  end if;

  select * into v_folio from folios where id = v_payment.folio_id;
  if v_folio.status = 'closed' then
    raise exception 'Folio % is closed; its payments cannot be voided', v_folio.id
      using errcode = 'check_violation';
  end if;

  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'A void needs a reason' using errcode = 'check_violation';
  end if;

  update folio_payments
     set is_voided   = true,
         voided_at   = now(),
         voided_by   = v_actor,
         void_reason = btrim(p_reason),
         updated_by  = v_actor
   where id = p_payment_id
  returning * into v_payment;

  return v_payment;
end;
$$;

comment on function void_payment(uuid, text, text) is
  'Voids a payment — sets is_voided with a reason, time and actor; NEVER deletes '
  '(rule 5). Excluded from folio_balance by the NULL-safe filter. Voiding a '
  'payment that was actually received is a serious act and is fully logged: the '
  'row survives, and change_log records who voided it. Idempotent by state.';


-- ############################################################################
-- SECTION 10 — RULE 7 LOCKSTEP REVIEW: cancel_booking is UNCHANGED, and why
-- ############################################################################
-- 015 §8 left a standing instruction: "When the folio (6c) and ledger arrive,
-- THIS function MUST also reverse their postings in the SAME transaction."
-- The folio has now arrived, so that instruction is DISCHARGED HERE, explicitly,
-- rather than left to be noticed later.
--
-- CONCLUSION: cancel_booking needs no change, and this is a REASONED conclusion,
-- not an omission:
--
--   * cancel_booking refuses any status past 'confirmed' (015 §8's status guard),
--     so a cancellable booking has NEVER been checked in.
--   * Room charges post per night at night audit (DECISION 2), which only runs for
--     in-house stays. A booking that was never checked in therefore has NO room
--     charges to reverse. There is nothing in lockstep to update.
--   * The only thing a cancellable folio can hold is a DEPOSIT. And a deposit must
--     NOT be auto-voided on cancellation — that would be the system silently
--     deciding the guest's money is gone. Refund versus forfeit is a commercial
--     decision made by a person under the hotel's cancellation policy, recorded as
--     a negative payment (refund) or left as revenue (forfeit) with a charge
--     against it. Auto-voiding would additionally erase the record that money was
--     ever received, which is the opposite of what the audit trail is for.
--   * The folio is therefore left OPEN on cancellation, deliberately: an open folio
--     with a positive balance owed back to the guest is exactly the "unresolved
--     money" state the front desk needs to see and clear.
--   * There is still NO cache to decrement anywhere — folio_balance is computed —
--     so rule 7's "all three data stores in lockstep" has nothing to synchronise.
--
-- When the LEDGER lands, this review must be redone: a cancellation after a
-- deposit has been posted to the GL WILL need a journal reversal in the same
-- transaction. That is the accounting build's obligation, recorded here so it is
-- inherited rather than rediscovered.
--
-- create_booking: NOT TOUCHED BY THIS MIGRATION AT ALL. No create-or-replace, no
-- new parameter, no diff. Its SELECT ... FOR UPDATE overbooking lock, its
-- availability re-count under that lock, its past-check-in guard (020) and its
-- idempotency fast-path + unique_violation race handler are byte-for-byte as 020
-- left them. The folio is opened by the AFTER INSERT trigger in §4.1, which is
-- precisely why that design was chosen (DECISION 1).


-- ############################################################################
-- SECTION 11 — Row-Level Security
-- ############################################################################
-- Two different postures, deliberately:
--
--   REFERENCE/CONFIG tables (charge_categories, tax_charges,
--   property_finance_settings) — member SELECT, admin WRITE, per 001. These are
--   configuration: front-desk staff must READ categories and tax rates to build a
--   bill, but only an owner/manager may change what the hotel charges or what tax
--   it levies.
--
--   TRANSACTIONAL tables (folios, folio_charges, folio_payments) — member SELECT
--   and NOTHING ELSE. No insert, update or delete policy for anyone, exactly as
--   bookings (015 §9). Every write goes through the SECURITY DEFINER RPCs above,
--   which run as the function owner and bypass RLS. This is load-bearing: a direct
--   INSERT into folio_charges would bypass the folio-status check, the category
--   validation and the idempotency guard; a direct UPDATE of discount_amount would
--   bypass the ENTIRE manager-PIN threshold system, which would make the
--   accountability chain decorative. DO NOT ADD A WRITE POLICY TO THESE TABLES.
--
--   manager_pins — NO POLICY OF ANY KIND, not even select. See §7.
--
-- NO PUBLIC/ANON POLICY ON ANY TABLE IN THIS MIGRATION, ever. Folios, charges,
-- payments, tax configuration and the discount threshold are private financial
-- data; 001 §14 lists exactly which three tables may be public and none of these
-- is among them.

alter table charge_categories        enable row level security;
alter table tax_charges              enable row level security;
alter table property_finance_settings enable row level security;
alter table folios                   enable row level security;
alter table folio_charges            enable row level security;
alter table folio_payments           enable row level security;
alter table manager_pins             enable row level security;

-- --- charge_categories: member read, admin write ----------------------------
drop policy if exists charge_categories_member_select on charge_categories;
create policy charge_categories_member_select on charge_categories
  for select to authenticated
  using (tenant_id = any(get_tenant_ids()));

drop policy if exists charge_categories_member_insert on charge_categories;
create policy charge_categories_member_insert on charge_categories
  for insert to authenticated
  with check (is_tenant_admin(tenant_id));

drop policy if exists charge_categories_member_update on charge_categories;
create policy charge_categories_member_update on charge_categories
  for update to authenticated
  using (is_tenant_admin(tenant_id))
  with check (is_tenant_admin(tenant_id));

-- NO delete policy — categories are SOFT-DELETED (set deleted_at via update), so
-- historical charges keep pointing at a category that still exists and bills from
-- last year still render.
drop policy if exists charge_categories_member_delete on charge_categories;

-- --- tax_charges: member read, admin write ----------------------------------
drop policy if exists tax_charges_member_select on tax_charges;
create policy tax_charges_member_select on tax_charges
  for select to authenticated
  using (tenant_id = any(get_tenant_ids()));

drop policy if exists tax_charges_member_insert on tax_charges;
create policy tax_charges_member_insert on tax_charges
  for insert to authenticated
  with check (is_tenant_admin(tenant_id));

drop policy if exists tax_charges_member_update on tax_charges;
create policy tax_charges_member_update on tax_charges
  for update to authenticated
  using (is_tenant_admin(tenant_id))
  with check (is_tenant_admin(tenant_id));

-- NO delete policy — soft-deleted via update, and the compulsory-tax guard
-- trigger (§2.1) still applies to that update.
drop policy if exists tax_charges_member_delete on tax_charges;

-- --- property_finance_settings: member read, admin write --------------------
-- Read is member-wide because the discount UI must know the threshold to decide
-- whether to prompt for a PIN. (That prompt is UX only — apply_charge_discount
-- re-checks the threshold server-side, per rule 19: the client's copy is never
-- the guard.)
drop policy if exists property_finance_settings_member_select on property_finance_settings;
create policy property_finance_settings_member_select on property_finance_settings
  for select to authenticated
  using (exists (
    select 1 from properties p
    where p.id = property_finance_settings.property_id
      and p.tenant_id = any(get_tenant_ids())
  ));

drop policy if exists property_finance_settings_member_insert on property_finance_settings;
create policy property_finance_settings_member_insert on property_finance_settings
  for insert to authenticated
  with check (exists (
    select 1 from properties p
    where p.id = property_finance_settings.property_id
      and is_tenant_admin(p.tenant_id)
  ));

drop policy if exists property_finance_settings_member_update on property_finance_settings;
create policy property_finance_settings_member_update on property_finance_settings
  for update to authenticated
  using (exists (
    select 1 from properties p
    where p.id = property_finance_settings.property_id
      and is_tenant_admin(p.tenant_id)
  ))
  with check (exists (
    select 1 from properties p
    where p.id = property_finance_settings.property_id
      and is_tenant_admin(p.tenant_id)
  ));

drop policy if exists property_finance_settings_member_delete on property_finance_settings;

-- --- folios / folio_charges / folio_payments: member READ ONLY ---------------
drop policy if exists folios_member_select on folios;
create policy folios_member_select on folios
  for select to authenticated
  using (tenant_id = any(get_tenant_ids()));

-- NO write policies — BY DESIGN. Folios are opened by the trigger (§4.1) and
-- their status is changed by the checkout flow's RPCs. DO NOT ADD ONE.
drop policy if exists folios_member_insert on folios;
drop policy if exists folios_member_update on folios;
drop policy if exists folios_member_delete on folios;

drop policy if exists folio_charges_member_select on folio_charges;
create policy folio_charges_member_select on folio_charges
  for select to authenticated
  using (tenant_id = any(get_tenant_ids()));

-- NO write policies — BY DESIGN. A direct UPDATE here would bypass the entire
-- manager-PIN discount system. DO NOT ADD ONE.
drop policy if exists folio_charges_member_insert on folio_charges;
drop policy if exists folio_charges_member_update on folio_charges;
drop policy if exists folio_charges_member_delete on folio_charges;

drop policy if exists folio_payments_member_select on folio_payments;
create policy folio_payments_member_select on folio_payments
  for select to authenticated
  using (tenant_id = any(get_tenant_ids()));

-- NO write policies — BY DESIGN. DO NOT ADD ONE.
drop policy if exists folio_payments_member_insert on folio_payments;
drop policy if exists folio_payments_member_update on folio_payments;
drop policy if exists folio_payments_member_delete on folio_payments;

-- --- manager_pins: NO POLICIES AT ALL ---------------------------------------
-- RLS is enabled with zero policies, which denies everything to every client
-- role. Only the SECURITY DEFINER functions in §7 touch this table. Adding even a
-- self-select policy would publish bcrypt hashes to the client; has_manager_pin()
-- exists so the UI never needs one.
drop policy if exists manager_pins_member_select on manager_pins;
drop policy if exists manager_pins_member_insert on manager_pins;
drop policy if exists manager_pins_member_update on manager_pins;
drop policy if exists manager_pins_member_delete on manager_pins;


-- ############################################################################
-- SECTION 12 — Function grants
-- ############################################################################
-- SECURITY DEFINER functions default to EXECUTE for PUBLIC. Revoke that on every
-- one and grant only the intended audience: authenticated staff, NEVER anon. The
-- guest website must not be able to read a folio, post a charge, or probe a PIN.
--
-- Two functions are callable by NO client at all:
--   * verify_manager_pin — it would be a PIN-guessing oracle (§7).
--   * the seed_* helpers — they are trigger/migration plumbing; a client calling
--     them could re-create categories someone deliberately retired.

revoke execute on function seed_charge_categories(uuid) from public;
revoke execute on function seed_charge_categories(uuid) from anon;
revoke execute on function seed_charge_categories(uuid) from authenticated;

revoke execute on function seed_tax_charges(uuid) from public;
revoke execute on function seed_tax_charges(uuid) from anon;
revoke execute on function seed_tax_charges(uuid) from authenticated;

-- THE PIN ORACLE: revoked from everyone. Called only from inside
-- apply_charge_discount, which runs as the function owner.
revoke execute on function verify_manager_pin(uuid, text) from public;
revoke execute on function verify_manager_pin(uuid, text) from anon;
revoke execute on function verify_manager_pin(uuid, text) from authenticated;

revoke execute on function set_manager_pin(uuid, text) from public;
revoke execute on function set_manager_pin(uuid, text) from anon;
grant  execute on function set_manager_pin(uuid, text) to authenticated;

revoke execute on function has_manager_pin(uuid) from public;
revoke execute on function has_manager_pin(uuid) from anon;
grant  execute on function has_manager_pin(uuid) to authenticated;

revoke execute on function folio_charge_tax(uuid) from public;
revoke execute on function folio_charge_tax(uuid) from anon;
grant  execute on function folio_charge_tax(uuid) to authenticated;

revoke execute on function folio_totals(uuid) from public;
revoke execute on function folio_totals(uuid) from anon;
grant  execute on function folio_totals(uuid) to authenticated;

revoke execute on function folio_balance(uuid) from public;
revoke execute on function folio_balance(uuid) from anon;
grant  execute on function folio_balance(uuid) to authenticated;

revoke execute on function post_charge(uuid, uuid, text, numeric, numeric, date, text, text) from public;
revoke execute on function post_charge(uuid, uuid, text, numeric, numeric, date, text, text) from anon;
grant  execute on function post_charge(uuid, uuid, text, numeric, numeric, date, text, text) to authenticated;

revoke execute on function post_room_night_charge(uuid, date, text) from public;
revoke execute on function post_room_night_charge(uuid, date, text) from anon;
grant  execute on function post_room_night_charge(uuid, date, text) to authenticated;

revoke execute on function apply_charge_discount(uuid, numeric, text, text, text) from public;
revoke execute on function apply_charge_discount(uuid, numeric, text, text, text) from anon;
grant  execute on function apply_charge_discount(uuid, numeric, text, text, text) to authenticated;

revoke execute on function record_payment(uuid, numeric, text, text, date, text) from public;
revoke execute on function record_payment(uuid, numeric, text, text, date, text) from anon;
grant  execute on function record_payment(uuid, numeric, text, text, date, text) to authenticated;

revoke execute on function void_charge(uuid, text, text) from public;
revoke execute on function void_charge(uuid, text, text) from anon;
grant  execute on function void_charge(uuid, text, text) to authenticated;

revoke execute on function void_payment(uuid, text, text) from public;
revoke execute on function void_payment(uuid, text, text) from anon;
grant  execute on function void_payment(uuid, text, text) to authenticated;

-- ============================================================================
-- End of 021_folio_engine.sql
-- ============================================================================
