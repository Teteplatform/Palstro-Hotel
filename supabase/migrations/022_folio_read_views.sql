-- ============================================================================
-- 022_folio_read_views.sql
-- Palstro-Hotels: two READ-ONLY views over the folio engine (build 6c part 2).
--
-- NO NEW FINANCIAL LOGIC, NO NEW RPCs, NO NEW TABLES, NO SEED DATA. Both views
-- are thin projections over functions 021 already ships (folio_charge_tax,
-- folio_totals). They exist for exactly one reason: the UI must not re-implement
-- the engine, and it must not fetch N rows with N round-trips.
--
-- ----------------------------------------------------------------------------
-- WHY VIEWS AND NOT UI CODE
-- ----------------------------------------------------------------------------
-- Two things the folio screen needs, and the two wrong ways to get them:
--
--   1. THE TAX BREAKDOWN OF EVERY CHARGE ON A FOLIO.
--      Wrong way A: call folio_charge_tax(charge_id) once per charge — N+1 round
--      trips for one panel.
--      Wrong way B: fetch tax_charges + the category flags and multiply in
--      TypeScript — a SECOND implementation of the applicability rule and the
--      per-line rounding, in a different language, which will drift from the
--      first the day either changes. The bill would then disagree with the
--      balance and nothing would error.
--      Right way: ONE query against folio_charge_taxes, which is literally
--      folio_charge_tax applied per charge by the database.
--
--   2. A BOOKING'S OUTSTANDING BALANCE, IN A LIST.
--      Wrong way: folio_balance(folio_id) per visible row.
--      Right way: ONE query against booking_balances for the page's rows, and
--      ONE aggregate across the filtered set for the list total (rule 20).
--
-- ----------------------------------------------------------------------------
-- SECURITY: security_invoker IS LOAD-BEARING
-- ----------------------------------------------------------------------------
-- A Postgres view runs with the OWNER's rights by default, which would make both
-- of these a hole straight through RLS — any authenticated user could read every
-- tenant's balances. `security_invoker = on` (PG15+; this project is on 17) makes
-- the view evaluate the base tables as the CALLER, so folios/folio_charges/
-- bookings/guests RLS applies exactly as it does to a direct select. The
-- SECURITY DEFINER functions called in the lateral joins are safe here precisely
-- because the row they are called FOR has already passed the caller's RLS.
--
-- Neither view is granted to anon. Folio balances are private financial data
-- (001 §14: only tenants/properties/property_settings may ever be public).
--
-- ----------------------------------------------------------------------------
-- THE COST, STATED PLAINLY
-- ----------------------------------------------------------------------------
-- folio_totals is plpgsql, so it cannot be inlined: booking_balances costs one
-- function call per booking row scanned. That is the honest price of rule 6's
-- "no cached balance" — the number is always right, and it is computed. At this
-- property's volume it is nothing. If it ever becomes a problem the answer is
-- NOT to sprinkle a cached column: it is rule 6's deliberate route — a cache
-- shipped in the same migration as its recompute function, with cancel/void
-- updating it in lockstep (rule 7). Do not shortcut that.
-- ============================================================================


-- ############################################################################
-- SECTION 1 — folio_charge_taxes: every charge's tax lines, in one read
-- ############################################################################
-- One row per (charge, applicable tax). The folio panel groups it two ways from
-- a single fetch: by charge_id for the per-line breakdown under each charge, and
-- by tax code for the folio-level tax lines in the totals block.
--
-- CROSS JOIN LATERAL (not LEFT JOIN LATERAL) is deliberate: folio_charge_tax
-- returns no rows for a charge that attracts no tax — a voided charge, or a
-- category flagged neither taxable nor service-chargeable (damage). Those charges
-- correctly produce no tax lines here, and the UI renders the charge with no tax
-- beneath it rather than a phantom zero line.
create or replace view folio_charge_taxes
with (security_invoker = on) as
select
  fc.id          as charge_id,
  fc.folio_id,
  fc.tenant_id,
  fc.property_id,
  t.tax_charge_id,
  t.code,
  t.name,
  t.rate,
  t.amount
from folio_charges fc
cross join lateral folio_charge_tax(fc.id) t;

comment on view folio_charge_taxes is
  'Every folio charge''s computed tax lines, one row per (charge, tax), straight '
  'from folio_charge_tax (021 §8.1) — so the UI never re-implements the '
  'applicability rule or the per-line rounding in TypeScript. security_invoker: '
  'the caller''s RLS on folio_charges decides which charges are visible.';


-- ############################################################################
-- SECTION 2 — booking_balances: the live balance per booking, list-shaped
-- ############################################################################
-- Carries the booking's FILTERABLE columns alongside the balance, so the exact
-- same filter set the bookings list applies can be applied here — the page's
-- balance column and the filtered-set outstanding total then describe provably
-- the same rows (rule 20), instead of two filter implementations that agree until
-- one of them changes.
--
-- guest_name is projected as a plain COLUMN rather than left to a PostgREST embed
-- so the guest-name filter is an ordinary .ilike() on the view. An embed would
-- need !inner join semantics on a view relationship, which is exactly the kind of
-- subtlety that silently returns the wrong row set.
--
-- deleted_at is exposed (not filtered out here) so the list's existing NULL-safe
-- `.is('deleted_at', null)` guard applies unchanged (rule 5) — the view does not
-- quietly pre-filter something the caller believes it controls.
--
-- INNER JOIN on folios is safe: 021 §4.1 opens a folio for EVERY booking via an
-- AFTER INSERT trigger and backfilled the existing ones, so a booking without a
-- folio does not exist. It is an inner join precisely so that if that invariant
-- were ever broken, the row would go MISSING from the balance list (loud) rather
-- than silently reading as zero owed (quiet, and wrong).
create or replace view booking_balances
with (security_invoker = on) as
select
  b.id             as booking_id,
  b.tenant_id,
  b.property_id,
  b.booking_number,
  b.status,
  b.check_in,
  b.check_out,
  b.room_type_id,
  b.company_id,
  b.deleted_at,
  g.full_name      as guest_name,
  f.id             as folio_id,
  f.status         as folio_status,
  tot.charges_total,
  tot.payments_total,
  tot.balance
from bookings b
join folios f on f.booking_id = b.id
join guests g on g.id = b.guest_id
cross join lateral folio_totals(f.id) tot;

comment on view booking_balances is
  'Per-booking LIVE folio balance (from folio_totals, 021 §8.2) plus the '
  'booking''s filterable columns, so a list can show a Balance column and an '
  'outstanding total across the whole filtered set (rule 20) without N+1 calls. '
  'Nothing is cached (rule 6). security_invoker: the caller''s RLS on bookings / '
  'folios / guests decides what is visible.';


-- ############################################################################
-- SECTION 3 — Grants
-- ############################################################################
-- Authenticated staff only, SELECT only. NEVER anon: what a guest owes is private
-- financial data, and the guest site has no business reading it.
--
-- The `revoke all ... from authenticated` before each grant is load-bearing and is
-- NOT redundant with the revoke from public. Supabase ships default privileges
-- that grant ALL on every new relation in `public` to `authenticated`, so a view
-- created here arrives with INSERT/UPDATE/DELETE/TRUNCATE already granted; a bare
-- `grant select` would leave every one of them in place. Both views happen to be
-- non-auto-updatable today (each has a join, so Postgres would reject a write
-- anyway) — but that is an accident of their current shape, not a policy. Revoking
-- first makes the privilege set say what this file means: read, and nothing else.
revoke all on folio_charge_taxes from public;
revoke all on folio_charge_taxes from anon;
revoke all on folio_charge_taxes from authenticated;
grant select on folio_charge_taxes to authenticated;

revoke all on booking_balances from public;
revoke all on booking_balances from anon;
revoke all on booking_balances from authenticated;
grant select on booking_balances to authenticated;

-- ============================================================================
-- End of 022_folio_read_views.sql
-- ============================================================================
