-- ============================================================================
-- 017_bookings_company_fk.sql
-- Palstro-Hotels: the composite FK from bookings to companies (build 6b, fix).
--
-- WHY THIS EXISTS, SEPARATELY FROM 015/016:
--   015 created bookings.company_id but DELIBERATELY left it without an FK — the
--   companies table did not exist yet (it was a forward reference). 016 created
--   companies with the unique (id, tenant_id) target. This migration finally wires
--   the relationship the booking-list/detail queries were WRITTEN AGAINST: the
--   `company:companies(name)` embed in fetchBookingsPage / fetchBookingDetail
--   resolves through a real PostgREST foreign-key relationship, and a booking's
--   company is guaranteed to belong to the SAME tenant (composite-key consistency,
--   CLAUDE.md §6). The queries are NOT changed; the FK is what they assume.
--
-- Verified before shipping (against the live DB): the one company (Nigeria LNG
-- Limited) and zero existing bookings — no booking has a company_id pointing at a
-- missing company, so the constraint attaches with no violation. A trial ADD in a
-- rolled-back transaction confirmed a clean attach.
--
-- KEY BEHAVIOURS:
--   * company_id is NULLABLE (a walk-in has no company). A composite FK in Postgres
--     is NOT enforced when ANY referencing column is NULL under the default MATCH
--     SIMPLE — exactly what we want: a walk-in (company_id NULL) passes unchecked,
--     while a company booking must reference a real company in the same tenant.
--   * ON DELETE RESTRICT (not cascade): deleting a company that has bookings
--     against it must FAIL, never silently delete booking history. This is a large
--     part of WHY the companies screen SOFT-deletes (sets deleted_at) instead of
--     hard-deleting — a company with any booking cannot be hard-deleted at all.
--   * Idempotent: the add is guarded so re-running this migration does not error.
-- No seed data.
-- ============================================================================

-- Safety net (belt-and-braces to Postgres's own validation): if any existing
-- booking names a company that does not exist for its tenant, STOP with a clear
-- message rather than letting a raw constraint error surface — and never force,
-- null, or coerce the offending rows. (Verified empty on the live DB before
-- shipping; this guard protects any environment whose data differs.)
do $$
declare
  v_orphans bigint;
begin
  select count(*) into v_orphans
  from bookings b
  where b.company_id is not null
    and not exists (
      select 1 from companies c
      where c.id = b.company_id and c.tenant_id = b.tenant_id
    );

  if v_orphans > 0 then
    raise exception
      'Cannot add bookings -> companies FK: % booking(s) have a company_id with no '
      'matching company in the same tenant. Correct or clear those company_id values '
      'first — this migration will NOT force, null, or delete them.', v_orphans
      using errcode = 'foreign_key_violation';
  end if;
end $$;

-- The composite FK. MATCH SIMPLE (default) leaves NULL company_id unchecked;
-- ON DELETE RESTRICT protects booking history. Guarded for idempotency.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'bookings_company_tenant_fk'
  ) then
    alter table bookings
      add constraint bookings_company_tenant_fk
      foreign key (company_id, tenant_id)
      references companies (id, tenant_id)
      on delete restrict;
  end if;
end $$;

comment on constraint bookings_company_tenant_fk on bookings is
  'Composite FK: a booking billed to a company references a REAL company of the '
  'SAME tenant (companies unique (id, tenant_id), 016) — a cross-tenant company a '
  'booking''s tenant_id could otherwise disagree with is structurally impossible '
  '(§6). company_id NULLABLE, so walk-ins (NULL) pass unchecked under MATCH SIMPLE. '
  'ON DELETE RESTRICT: a company with bookings CANNOT be hard-deleted (which is why '
  'the companies screen soft-deletes). Enables the company:companies(name) embed in '
  'fetchBookingsPage / fetchBookingDetail.';

-- Index the referencing columns: supports the booking list''s company filter
-- (.eq(''company_id'', ...)) and the FK''s own referential checks. Partial (only
-- rows that name a company) since the vast majority of bookings are walk-ins.
create index if not exists bookings_company_id_idx
  on bookings (company_id)
  where company_id is not null;

-- ============================================================================
-- End of 017_bookings_company_fk.sql
-- ============================================================================
