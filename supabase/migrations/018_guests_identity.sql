-- ============================================================================
-- 018_guests_identity.sql
-- Palstro-Hotels: structured guest identity (build 6b follow-up, 3.txt §2).
--
-- Nigerian hotels are legally required to record guest identification, so a
-- single free-text full_name is not enough: real guest records need a structured
-- NAME (first / middle / last) and an ID DOCUMENT with an EXPIRY. This migration
-- adds those columns.
--
-- FULL_NAME BECOMES A GENERATED COLUMN — the deliberate choice over dropping it.
-- Two options were on the table (see 3.txt §2):
--   (a) keep full_name, self-maintained, so every existing read keeps working; or
--   (b) drop full_name and rewrite search + every display to span first/last.
-- We take (a) as a STORED GENERATED column:
--   `first_name [ + ' ' + middle_name ] + ' ' + last_name`.
-- Why it is cleaner:
--   * The front-desk search (guests_tenant_full_name_idx + searchGuests' ilike on
--     full_name) and every display site (booking list rows, the guest picker, the
--     booking detail panel) keep working UNCHANGED — one name column to render and
--     to search, matching how staff actually look a returning guest up.
--   * It is SELF-MAINTAINING and cannot drift: Postgres recomputes it from the
--     structured columns on every write, so — unlike a maintained cache column
--     (CLAUDE.md rule 6) — there is nothing to keep in lockstep and no recompute
--     function to own. It is derived, not cached.
-- The tradeoff: a generated column cannot be ALTERed in place, so full_name must
-- be dropped and re-added (its name index recreated with it), and its generation
-- expression must be IMMUTABLE (|| / coalesce / nullif / btrim all are). Option
-- (b) would have spread the change across the whole app for no gain. Because there
-- is only test data so far, the drop-and-regenerate is safe.
--
-- PRIVACY — UNCHANGED AND RE-AFFIRMED. Guest identification (id_type, id_number,
-- and now id_expiry) is SENSITIVE personal data. The guests table has NO public /
-- anon read policy (014) and MUST NEVER get one. Nothing added here is exposed to
-- the guest-facing storefront: these columns are read only by authenticated staff
-- under the tenant-scoped member-select policy. See 014's header privacy note.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Structured name + ID expiry columns (nullable first; NOT NULL applied after
--    the backfill so the existing rows can be filled before the constraint bites).
-- ----------------------------------------------------------------------------
alter table guests
  add column if not exists first_name  text,
  add column if not exists last_name   text,
  add column if not exists middle_name text,
  -- Government ID expiry date. SENSITIVE, like id_type/id_number. Nullable:
  -- captured at check-in, which may follow booking creation, and some IDs (e.g. a
  -- national ID card) may carry no expiry at all.
  add column if not exists id_expiry   date;

comment on column guests.id_expiry is
  'Government ID expiry date. SENSITIVE personal data (see id_number). Never '
  'exposed by a public/anon RLS policy. Nullable — captured at check-in and some '
  'IDs do not expire.';

-- ----------------------------------------------------------------------------
-- 2. Backfill first_name / last_name from the existing full_name (TEST DATA only).
--    Split on the first space: the first token becomes first_name, the remainder
--    becomes last_name. A single-token name (no space) reuses the token for
--    last_name so the NOT NULL below never fails on legacy rows.
-- ----------------------------------------------------------------------------
update guests
set
  first_name = coalesce(nullif(split_part(btrim(full_name), ' ', 1), ''), btrim(full_name)),
  last_name  = coalesce(
                 nullif(
                   btrim(substr(btrim(full_name),
                               length(split_part(btrim(full_name), ' ', 1)) + 1)),
                   ''),
                 split_part(btrim(full_name), ' ', 1)
               )
where first_name is null or last_name is null;

-- ----------------------------------------------------------------------------
-- 3. New rows must carry a structured name (middle_name and id_expiry stay
--    nullable — a middle name and an ID expiry are genuinely optional).
-- ----------------------------------------------------------------------------
alter table guests
  alter column first_name set not null,
  alter column last_name  set not null;

-- ----------------------------------------------------------------------------
-- 4. Replace full_name with a STORED GENERATED column derived from the structured
--    name. Dropping the column drops its dependent index; both are recreated.
--    The expression is immutable (|| / coalesce / nullif / btrim), as generated
--    columns require. Middle name, when present and non-blank, sits between.
-- ----------------------------------------------------------------------------
drop index if exists guests_tenant_full_name_idx;
alter table guests drop column full_name;
alter table guests
  add column full_name text
    generated always as (
      first_name
      || coalesce(' ' || nullif(btrim(middle_name), ''), '')
      || ' ' || last_name
    ) stored;

comment on column guests.full_name is
  'Display/search name, GENERATED from first_name [+ middle_name] + last_name. '
  'Self-maintaining (recomputed by Postgres on every write), so it is derived, '
  'not a cache — nothing to keep in lockstep. Kept so front-desk search and every '
  'display render one name column unchanged.';

-- ----------------------------------------------------------------------------
-- 5. Recreate the name search index on the regenerated column. The phone index
--    (guests_tenant_phone_idx) is untouched — both search paths keep working.
-- ----------------------------------------------------------------------------
create index if not exists guests_tenant_full_name_idx
  on guests (tenant_id, full_name);

-- ----------------------------------------------------------------------------
-- 6. create_guest — widen to the structured name + id_expiry.
--    The 016 signature took p_full_name and inserted into full_name; full_name is
--    now GENERATED and cannot be inserted, so the RPC must take the structured
--    name instead. Renaming input parameters is not allowed by CREATE OR REPLACE,
--    so the old signature is dropped and the new one created. Everything else is
--    preserved verbatim: is_tenant_staff gate (front desk, not just admins),
--    SECURITY DEFINER with the actor stamped explicitly, no idempotency key
--    (non-financial master data — rule 2 guards bookings/charges/payments).
-- ----------------------------------------------------------------------------
-- Drop the OLD 016 signature explicitly, by its exact eight-argument type list
-- (uuid + 7 text). Changing a function's argument list does NOT replace the old
-- function — Postgres keys a function by its full argument types, so CREATE OR
-- REPLACE with the new eleven-argument list would create a SECOND create_guest
-- and leave the stale eight-argument one resolvable. Dropping it here guarantees
-- the app can only ever resolve to the new structured-name signature.
drop function if exists create_guest(uuid, text, text, text, text, text, text, text);

create or replace function create_guest(
  p_tenant_id    uuid,
  p_first_name   text,
  p_last_name    text,
  p_middle_name  text default null,
  p_phone        text default null,
  p_email        text default null,
  p_nationality  text default null,
  p_id_type      text default null,
  p_id_number    text default null,
  p_id_expiry    date default null,
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

  if p_first_name is null or btrim(p_first_name) = '' then
    raise exception 'A guest needs a first name' using errcode = 'check_violation';
  end if;
  if p_last_name is null or btrim(p_last_name) = '' then
    raise exception 'A guest needs a last name' using errcode = 'check_violation';
  end if;

  insert into guests (
    tenant_id, first_name, last_name, middle_name,
    phone, email, nationality, id_type, id_number, id_expiry, notes,
    created_by
  ) values (
    p_tenant_id, btrim(p_first_name), btrim(p_last_name),
    nullif(btrim(coalesce(p_middle_name, '')), ''),
    nullif(btrim(coalesce(p_phone, '')), ''),
    nullif(btrim(coalesce(p_email, '')), ''),
    nullif(btrim(coalesce(p_nationality, '')), ''),
    nullif(btrim(coalesce(p_id_type, '')), ''),
    nullif(btrim(coalesce(p_id_number, '')), ''),
    p_id_expiry,
    nullif(btrim(coalesce(p_notes, '')), ''),
    v_actor
  )
  returning * into v_guest;

  return v_guest;
end;
$$;

comment on function create_guest(uuid, text, text, text, text, text, text, text, text, date, text) is
  'Registers a guest for a tenant during the booking flow, with STRUCTURED name '
  '(first/last required, middle optional) and optional ID (type/number/expiry). '
  'STAFF-gated (is_tenant_staff) — front desk, not just admins. SECURITY DEFINER, '
  'actor stamped explicitly. full_name is GENERATED, so it is not inserted here. '
  'Non-financial master data, so no idempotency key.';

-- Execution grants mirror 016: never public/anon, only authenticated staff (the
-- is_tenant_staff gate inside does the real authorisation).
revoke execute on function create_guest(uuid, text, text, text, text, text, text, text, text, date, text) from public;
revoke execute on function create_guest(uuid, text, text, text, text, text, text, text, text, date, text) from anon;
grant  execute on function create_guest(uuid, text, text, text, text, text, text, text, text, date, text) to authenticated;

-- ============================================================================
-- End of 018_guests_identity.sql
-- ============================================================================
