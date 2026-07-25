-- ============================================================================
-- 011_property_coordinates.sql
-- Palstro-Hotels: make properties.latitude/longitude editable and range-safe.
--
-- 003 added latitude/longitude as numeric(10,7) columns, but the settings writer
-- update_property_details (008) never handled them — so a coordinate typed in the
-- admin had no way to reach the database. This migration closes that gap AND makes
-- an out-of-range coordinate impossible to store.
--
-- WHY A HARD FLOOR IN THE DATABASE (3.txt §3): a wrong coordinate does not error.
-- It silently drops the map pin in the ocean, and nobody notices until a guest
-- tries to find the hotel. The client validates the range and previews a live pin,
-- but the client is UX, never the sole guard (CLAUDE.md multi-tenancy §): the
-- CHECK constraints below are the floor that holds even against a hand-rolled
-- write, and the RPC raises a friendly PT422 before the constraint ever fires.
--
-- Idempotent: guarded constraint adds + create-or-replace of the function, matching
-- the sequential, re-runnable style of every prior migration. create or replace
-- preserves the grants 008 set (authenticated-only), so no re-grant is needed.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Range CHECK constraints — the hard floor
-- ----------------------------------------------------------------------------
-- NULL stays allowed (a property may simply have no coordinates yet); a present
-- value must be in range. Added only if absent so the migration re-runs cleanly.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'properties_latitude_range'
  ) then
    alter table properties
      add constraint properties_latitude_range
      check (latitude is null or (latitude >= -90 and latitude <= 90));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'properties_longitude_range'
  ) then
    alter table properties
      add constraint properties_longitude_range
      check (longitude is null or (longitude >= -180 and longitude <= 180));
  end if;
end $$;

comment on constraint properties_latitude_range on properties is
  'Latitude must be NULL or within [-90, 90]. The DB floor behind the client''s '
  'range check — an out-of-range pin (the ocean failure mode) is unstorable.';
comment on constraint properties_longitude_range on properties is
  'Longitude must be NULL or within [-180, 180]. The DB floor behind the client''s '
  'range check.';

-- ----------------------------------------------------------------------------
-- 2. update_property_details — now patches latitude/longitude too
-- ----------------------------------------------------------------------------
-- Reproduces 008's function verbatim (same tenant resolve -> admin gate ->
-- optimistic updated_at check -> name-not-blank guard) and adds:
--   * PT422 range validation for latitude/longitude, so a bad coordinate returns
--     a friendly message rather than tripping the raw CHECK constraint, and
--   * the two coordinate columns in the UPDATE, following the existing
--     `p_patch ? 'key'` presence pattern so a save that omits them is untouched.
-- A JSON null value clears the column (p_patch ? key is true, ->> yields SQL NULL,
-- NULL::numeric is NULL) — the range guard skips a null, so clearing always works.
create or replace function update_property_details(
  p_property_id         uuid,
  p_patch               jsonb,
  p_expected_updated_at timestamptz
) returns properties
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant_id  uuid;
  v_updated_at timestamptz;
  v_result     properties;
begin
  select p.tenant_id, p.updated_at
    into v_tenant_id, v_updated_at
  from properties p
  where p.id = p_property_id
    and p.deleted_at is null
  for update;

  if v_tenant_id is null then
    raise exception 'Property % not found', p_property_id
      using errcode = 'PT404';
  end if;

  if not is_tenant_admin(v_tenant_id) then
    raise exception 'You are not authorised to edit this property'
      using errcode = 'PT403';
  end if;

  if p_expected_updated_at is distinct from v_updated_at then
    raise exception 'This property was changed by someone else since you loaded it'
      using errcode = 'PT409',
            hint = 'Reload to see the latest values, then reapply your change.';
  end if;

  -- name is NOT NULL and is rendered site-wide: reject a blank/whitespace-only
  -- value rather than writing it. (slug stays deliberately unpatchable — it
  -- breaks URLs; name carries no such risk.)
  if p_patch ? 'name' and length(trim(coalesce(p_patch ->> 'name', ''))) = 0 then
    raise exception 'Hotel name cannot be empty'
      using errcode = 'PT422';
  end if;

  -- Coordinate range guards — friendly PT422 before the CHECK constraint fires.
  -- A null value (clearing the field) is skipped; only a present, out-of-range
  -- number is rejected.
  if p_patch ? 'latitude' and (p_patch ->> 'latitude') is not null
     and ((p_patch ->> 'latitude')::numeric < -90
          or (p_patch ->> 'latitude')::numeric > 90) then
    raise exception 'Latitude must be between -90 and 90'
      using errcode = 'PT422';
  end if;

  if p_patch ? 'longitude' and (p_patch ->> 'longitude') is not null
     and ((p_patch ->> 'longitude')::numeric < -180
          or (p_patch ->> 'longitude')::numeric > 180) then
    raise exception 'Longitude must be between -180 and 180'
      using errcode = 'PT422';
  end if;

  update properties
     set name = case
                  when p_patch ? 'name' then trim(p_patch ->> 'name')
                  else name
                end,
         timezone = case
                      when p_patch ? 'timezone' then p_patch ->> 'timezone'
                      else timezone
                    end,
         currency = case
                      when p_patch ? 'currency' then p_patch ->> 'currency'
                      else currency
                    end,
         night_audit_time = case
                              when p_patch ? 'night_audit_time'
                                then (p_patch ->> 'night_audit_time')::time
                              else night_audit_time
                            end,
         phone = case
                   when p_patch ? 'phone' then nullif(p_patch ->> 'phone', '')
                   else phone
                 end,
         email = case
                   when p_patch ? 'email' then nullif(p_patch ->> 'email', '')
                   else email
                 end,
         address_line = case
                          when p_patch ? 'address_line'
                            then nullif(p_patch ->> 'address_line', '')
                          else address_line
                        end,
         city = case
                  when p_patch ? 'city' then nullif(p_patch ->> 'city', '')
                  else city
                end,
         state = case
                   when p_patch ? 'state' then nullif(p_patch ->> 'state', '')
                   else state
                 end,
         postal_code = case
                         when p_patch ? 'postal_code'
                           then nullif(p_patch ->> 'postal_code', '')
                         else postal_code
                       end,
         latitude = case
                      when p_patch ? 'latitude'
                        then (p_patch ->> 'latitude')::numeric
                      else latitude
                    end,
         longitude = case
                       when p_patch ? 'longitude'
                         then (p_patch ->> 'longitude')::numeric
                       else longitude
                     end
   where id = p_property_id
  returning * into v_result;

  return v_result;
end;
$$;

comment on function update_property_details(uuid, jsonb, timestamptz) is
  'Patch properties columns (timezone, currency, night audit, contact/location, '
  'latitude/longitude) under an optimistic updated_at check. Admin-gated; SECURITY '
  'DEFINER. PT409 on stale; PT422 on a blank name or out-of-range coordinate.';

-- ============================================================================
-- End of 011_property_coordinates.sql
-- ============================================================================
