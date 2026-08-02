-- ============================================================================
-- 023_night_audit.sql
-- Palstro-Hotels: THE NIGHT AUDIT RUNNER, plus the two settings writers the
-- night audit and the discount threshold need.
--
-- 021 §9.2 shipped the POSTING PRIMITIVE (post_room_night_charge) and said in
-- terms: "The night-audit RUNNER (the scheduled job that walks in-house bookings
-- and calls this per night) belongs to the front-desk/night-audit build; the
-- posting primitive it needs lives here, and is idempotent per (booking, night)
-- so a re-run can never double-post." THIS MIGRATION IS THAT RUNNER.
--
-- ----------------------------------------------------------------------------
-- WHAT IS NOT TOUCHED, AND WHY THAT MATTERS
-- ----------------------------------------------------------------------------
-- post_room_night_charge, post_charge, apply_charge_discount, folio_totals,
-- folio_balance, booking_nights and every pricing path are BYTE-FOR-BYTE as 021
-- left them. run_night_audit ORCHESTRATES; it does not price, it does not decide
-- a rate, and it does not write a folio row itself. Every charge it causes is
-- posted by post_room_night_charge at the rate LOCKED in booking_nights.
--
-- ----------------------------------------------------------------------------
-- THE SAFETY PROPERTY THAT MAKES A CRON SAFE TO RETRY
-- ----------------------------------------------------------------------------
-- post_room_night_charge builds a DETERMINISTIC idempotency key,
--   'room:' || booking_id || ':' || stay_date
-- and hands it to post_charge, which (021 §9.1) FIRST looks the key up in
-- folio_charges and RETURNS THE EXISTING ROW if it finds one — and, if a
-- concurrent call wins the race instead, catches the unique_violation on
-- folio_charges_idem_uniq (the partial unique index, rule 3) and returns that
-- row. So for a given (booking, night):
--
--   * the FIRST call posts one charge,
--   * EVERY later call — a cron retry, a manual re-run, two Vercel regions
--     firing at once, a network timeout that was actually delivered — returns
--     THAT SAME CHARGE and writes nothing.
--
-- The guarantee is therefore enforced by a UNIQUE INDEX IN THE DATABASE, not by
-- this function being careful. run_night_audit could be invoked a hundred times
-- for the same night and the folio would be identical. That is what lets the
-- cron endpoint retry freely and lets a manager re-run an audit they are not
-- sure completed.
--
-- ----------------------------------------------------------------------------
-- WHICH BOOKINGS ARE CHARGED — THE DECISION, AND WHY IT DIFFERS FROM
-- count_available ON PURPOSE
-- ----------------------------------------------------------------------------
-- 015 §6 (count_available) holds inventory for:
--     confirmed, checked_in, checked_out, and no_show (by default).
-- THIS FUNCTION CHARGES:
--     checked_in, checked_out — and nothing else.
--
-- The two sets are answering DIFFERENT QUESTIONS and must not be conflated:
--
--   availability asks "is this room SELLABLE tonight?" — a confirmed
--   reservation makes it unsellable, so it holds inventory even though nobody
--   has arrived;
--
--   the night audit asks "did a guest SLEEP in this room last night?" — only
--   an arrival makes that true.
--
--   * checked_in  -> the guest is in-house. Charged. This is the ordinary case:
--                    a stay stays 'checked_in' for every night of the stay, so
--                    one status covers all of them.
--   * checked_out -> the guest HAS departed, but the nights before their
--                    departure were genuinely slept, and the last audit before
--                    checkout may not have run yet (a same-morning checkout
--                    departs before the 06:00 cutoff). Charged for any night the
--                    half-open range [check_in, check_out) still contains.
--                    Because the range is half-open, the departure DAY itself is
--                    never charged — a guest leaving on the 5th is charged for
--                    the 4th, not the 5th.
--   * confirmed   -> NOT charged, DELIBERATELY. Posting a room charge for a
--                    guest who never arrived is precisely what 021's DECISION 2
--                    exists to prevent ("an un-arrived guest would appear to owe
--                    money"), and it would put a debt on a folio that the front
--                    desk would then have to hunt down and reverse. A confirmed
--                    booking spanning last night is an OPERATIONAL EXCEPTION —
--                    either the guest arrived and nobody pressed check-in, or
--                    they no-showed — and only a person can say which. So the
--                    audit does not guess: it REPORTS them in
--                    `not_checked_in` so the summary makes them visible instead
--                    of silently skipping them.
--   * no_show     -> NOT charged. It holds inventory (the room was kept empty
--                    for them) but no room was occupied. A no-show FEE is a
--                    cancellation-policy charge, posted through post_charge
--                    against the hotel's own policy — not a room night, and not
--                    something an unattended cron should decide.
--   * cancelled /
--     enquiry     -> NOT charged. Neither ever occupied a room.
--   * deleted_at  -> excluded, NULL-safe (rule 5): a row someone marked as a
--                    mistake is not a stay.
--
-- ----------------------------------------------------------------------------
-- ONE DELIBERATE, FLAGGED CHANGE OUTSIDE THE NIGHT AUDIT: is_tenant_staff
-- ----------------------------------------------------------------------------
-- See §1. The cron runs with the SERVICE ROLE, which has no auth.uid(), and
-- post_room_night_charge's staff gate (is_tenant_staff, 015 §6.5) is written for
-- a human session and would refuse every posting. The brief forbids editing
-- post_room_night_charge, so the gate itself is widened — additively, once, with
-- the full security argument written out at the change.
-- ============================================================================


-- ############################################################################
-- SECTION 1 — is_service_role() and the ONE change to is_tenant_staff
-- ############################################################################
--
--  ┌──────────────────────────────────────────────────────────────────────────┐
--  │  THE PROBLEM: a cron has no auth.uid(), and every folio RPC gates on one. │
--  └──────────────────────────────────────────────────────────────────────────┘
--
-- post_room_night_charge -> post_charge both call is_tenant_staff(tenant_id),
-- which is `exists (select 1 from tenant_users where user_id = auth.uid() ...)`.
-- Under the service role auth.uid() is NULL, the EXISTS is false, and the audit
-- would raise 'Not authorised to post room charges for this tenant' on every
-- single booking. Three ways out were considered:
--
--   (a) edit post_room_night_charge to skip the gate — FORBIDDEN by the brief,
--       and it would put a bypass inside the posting path itself, which is the
--       worst possible place for one;
--   (b) have run_night_audit impersonate a real user by setting
--       request.jwt.claims to some member's id — REJECTED. It would stamp
--       created_by on automatic charges with a named human being who did not
--       post them. CLAUDE.md §6 exists so "who did this" is answerable; writing
--       a person's id against a machine's work makes the theft-detection column
--       actively misleading, which is worse than leaving it NULL;
--   (c) widen is_tenant_staff to admit the trusted server context — CHOSEN.
--
-- WHY (c) GRANTS NO NEW AUTHORITY, stated plainly. The service role key:
--   * has BYPASSRLS in Postgres, so it can already INSERT into folio_charges,
--     UPDATE discount_amount and do anything else these RPCs guard — the gate
--     was never a boundary against it, only an obstruction;
--   * lives ONLY in Vercel's server-side environment and is never shipped to a
--     browser (VITE_-prefixed vars are the ones that reach the client; this one
--     is deliberately not prefixed);
--   * is not reachable by anon or by any signed-in staff member.
-- So this change does not let the server do anything new. What it DOES do is let
-- trusted server code go THROUGH the validated RPC path — the rate lock, the
-- folio-status check, the category check and the idempotency index — instead of
-- around it. That is strictly safer than the alternative of a cron writing rows
-- directly.
--
-- FAIL-CLOSED: both signals are read with the missing_ok form and coalesced to
-- '', so an absent GUC, an anon request, a signed-in staff request and a direct
-- psql session all yield false and fall through to the membership check.
create or replace function is_service_role()
returns boolean
language sql
stable
set search_path = public
as $$
  -- TWO signals, because Supabase has two key formats in the wild:
  --   * legacy JWT service keys land in request.jwt.claims with role=service_role;
  --   * the newer secret keys are resolved by the gateway, which issues
  --     `set local role service_role`, visible in the `role` GUC.
  -- Either is conclusive; neither can be produced by a browser client.
  select coalesce(
           nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
           ''
         ) = 'service_role'
      or coalesce(current_setting('role', true), '') = 'service_role';
$$;

comment on function is_service_role() is
  'True only when the caller is the SERVICE ROLE (trusted server-side code: the '
  'Vercel cron). Read from the JWT claims and the role GUC, both fail-closed. '
  'The service role already has BYPASSRLS, so this grants no new authority — it '
  'lets server code use the validated RPCs instead of writing tables directly.';

revoke execute on function is_service_role() from public;
revoke execute on function is_service_role() from anon;

-- The ONLY change to 015 §6.5: an additive first clause. The membership check
-- below it is byte-for-byte what 015 shipped, so every human caller is gated
-- exactly as before — an inactive member, a non-member and an anonymous visitor
-- are all still refused. `create or replace` preserves the existing grants.
create or replace function is_tenant_staff(p_tenant_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  -- Trusted server context (the night-audit cron). See §1's header for why this
  -- is not a widening of what the service role can do.
  if is_service_role() then
    return true;
  end if;

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
  'gate for STAFF operations (booking, folio posting) — OR for the SERVICE ROLE, '
  'so the night-audit cron can post through the validated RPCs rather than '
  'writing folio rows directly (023 §1). Fail-closed for anon and for '
  'non-members; STABLE, SECURITY DEFINER, pinned search_path.';


-- ############################################################################
-- SECTION 2 — run_night_audit: post every in-house night, once, observably
-- ############################################################################
--
-- ----------------------------------------------------------------------------
-- THE BUSINESS DATE: "the night that just ended", in the PROPERTY's timezone
-- ----------------------------------------------------------------------------
-- A hotel night with business date D runs from the evening of D to the morning
-- of D+1. The audit fires after that night has ended — at the property's
-- night_audit_time, 06:00 by default — so THE CHARGE POSTED AT THE 06:00 CUTOFF
-- IS FOR THE NIGHT BEFORE: at 06:00 on the 5th, the night being billed is the
-- 4th. Hence the default business date is YESTERDAY, property-local.
--
-- WHY PROPERTY-LOCAL AND NOT UTC (rules 8, 12, and §6 "Business date"): Lagos is
-- UTC+1, so between 23:00 and 00:00 local the UTC date is already the day
-- before. A UTC-derived "yesterday" would bill the wrong night for one hour
-- every day, and the error would be invisible — a real charge, on a real folio,
-- for a real night, just the wrong one. properties.timezone is read here for
-- exactly the same reason create_booking (020) and post_charge (021 §9.1) read
-- it, with the same 'Africa/Lagos' fallback for a blank column.
--
-- "YESTERDAY LOCAL" IS CORRECT AT EVERY HOUR OF THE OPERATING DAY, which is what
-- makes it safe to schedule loosely: run it at 00:30 local, at 06:00 local or at
-- 14:00 local on the 5th and it resolves the 4th every time. night_audit_time is
-- therefore NOT consulted in this derivation — it is the cutoff that decides
-- which business day a LATE SALE belongs to (a bar round at 02:00 belongs to the
-- previous day), not which night a room charge covers. It is returned in the
-- summary so an operator can see the property's cutoff beside the date that was
-- billed.
--
-- p_business_date overrides it entirely, for the two cases that need it: a
-- catch-up run after an outage ("audit the 2nd, 3rd and 4th"), and a manual
-- re-run. Because the posting is idempotent per (booking, night), neither can
-- double-charge.
--
-- ----------------------------------------------------------------------------
-- ERROR HANDLING: ONE BAD BOOKING MUST NOT ABANDON THE OTHER TWENTY-NINE
-- ----------------------------------------------------------------------------
-- Each booking is posted inside its own BEGIN/EXCEPTION block, which Postgres
-- implements as a subtransaction: a failure rolls back THAT booking's posting
-- and nothing else, and the loop continues. The error is captured with its
-- SQLSTATE and message into the returned summary rather than swallowed (rule
-- 11 — a silent failure would leave a guest un-billed with nobody knowing).
-- Real cases this catches: a booking whose booking_nights row is missing for
-- that date, a folio already 'settled' or 'closed', a tenant whose 'room'
-- charge category was retired.
--
-- Runs across a WHOLE PROPERTY in one call, in one transaction.
create or replace function run_night_audit(
  p_property_id   uuid,
  p_business_date date default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant_id      uuid;
  v_property_name  text;
  v_timezone       text;
  v_audit_time     time;
  v_date           date;

  r                record;
  v_charge         folio_charges;
  v_key            text;
  v_existed        boolean;

  v_in_house       integer := 0;
  v_posted         integer := 0;
  v_skipped        integer := 0;
  v_voided         integer := 0;
  v_amount         numeric(14,2) := 0;
  v_errors         jsonb := '[]'::jsonb;
  v_not_checked_in jsonb := '[]'::jsonb;
begin
  -- The property, and the timezone the business date is derived in. Rule 5:
  -- a soft-deleted property is not audited.
  select p.tenant_id, p.name, p.timezone, p.night_audit_time
    into v_tenant_id, v_property_name, v_timezone, v_audit_time
  from properties p
  where p.id = p_property_id
    and p.deleted_at is null;

  if v_tenant_id is null then
    raise exception 'Property % not found', p_property_id
      using errcode = 'no_data_found';
  end if;

  -- Rule 19 in its RPC form: SECURITY DEFINER bypasses RLS, so authorise here.
  -- Staff (any active member) or the service role — the same gate every folio
  -- posting path uses, so the audit can never post what a caller could not.
  if not is_tenant_staff(v_tenant_id) then
    raise exception 'Not authorised to run the night audit for this property'
      using errcode = 'insufficient_privilege';
  end if;

  v_timezone := coalesce(nullif(btrim(v_timezone), ''), 'Africa/Lagos');

  if p_business_date is not null then
    v_date := p_business_date;
  else
    -- THE NIGHT THAT JUST ENDED. See the header: a charge posted at the 06:00
    -- cutoff on the 5th is for the night of the 4th.
    v_date := (now() at time zone v_timezone)::date - 1;
  end if;

  -- --------------------------------------------------------------------------
  -- The in-house set: bookings whose half-open stay range CONTAINS the night.
  -- --------------------------------------------------------------------------
  -- check_in <= v_date < check_out is the SAME half-open convention as
  -- count_available's clash test and booking_nights' one-row-per-night (015
  -- RULES 1 & 2): the departure day is not a night. It also means a booking
  -- whose stay was shortened at an early checkout stops being charged from the
  -- new check_out onward, with no reversal needed — shortening the stay is the
  -- front desk's act, and the audit simply bills the booking's current dates.
  for r in
    select b.id, b.booking_number, b.status
    from bookings b
    where b.property_id = p_property_id
      and b.tenant_id   = v_tenant_id            -- rule 19, explicit
      and b.deleted_at is null                   -- rule 5
      and b.status in ('checked_in', 'checked_out')
      and b.check_in <= v_date
      and v_date < b.check_out
    order by b.booking_number
  loop
    v_in_house := v_in_house + 1;

    -- The key post_room_night_charge will build for this (booking, night). Read
    -- BEFORE the call so the summary can tell a fresh posting from a no-op
    -- re-run; the call itself is what actually enforces uniqueness, so a race
    -- here can only mis-classify a count, never double-charge.
    v_key := 'room:' || r.id::text || ':' || v_date::text;
    select exists (
      select 1 from folio_charges fc
      where fc.tenant_id = v_tenant_id
        and fc.idempotency_key = v_key
    ) into v_existed;

    begin
      -- The ONLY write this function causes, and it is somebody else's function.
      -- The rate comes from booking_nights, locked at booking time.
      select * into v_charge from post_room_night_charge(r.id, v_date);

      if v_existed then
        v_skipped := v_skipped + 1;
        -- A night whose charge was deliberately VOIDED stays voided: the
        -- idempotency key still exists, so the re-run returns the voided row and
        -- posts nothing. That is correct — re-posting would silently undo a
        -- person's decision — but it must be VISIBLE, so it is counted.
        if v_charge.is_voided is true then
          v_voided := v_voided + 1;
        end if;
      else
        v_posted := v_posted + 1;
        v_amount := v_amount + coalesce(v_charge.net_amount, 0);
      end if;
    exception
      when others then
        -- Subtransaction rollback: this booking posted nothing, the rest of the
        -- run continues, and the reason travels back in the summary.
        v_errors := v_errors || jsonb_build_object(
          'booking_id',     r.id,
          'booking_number', r.booking_number,
          'status',         r.status,
          'sqlstate',       sqlstate,
          'message',        sqlerrm
        );
    end;
  end loop;

  -- --------------------------------------------------------------------------
  -- The exceptions worth a human's attention: confirmed, spanning, not arrived.
  -- --------------------------------------------------------------------------
  -- Reported, never charged (see the header). An empty list here is the normal,
  -- healthy result; a non-empty one means the front desk has arrivals to
  -- resolve — press check-in, or mark the booking no_show.
  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'booking_id',     b.id,
               'booking_number', b.booking_number,
               'status',         b.status,
               'check_in',       b.check_in,
               'check_out',      b.check_out
             )
             order by b.booking_number
           ),
           '[]'::jsonb
         )
    into v_not_checked_in
  from bookings b
  where b.property_id = p_property_id
    and b.tenant_id   = v_tenant_id
    and b.deleted_at is null
    and b.status = 'confirmed'
    and b.check_in <= v_date
    and v_date < b.check_out;

  -- --------------------------------------------------------------------------
  -- The summary — what makes an unattended job observable (brief §1).
  -- --------------------------------------------------------------------------
  -- posted + already_posted = in_house on a clean run; anything in `errors` or
  -- `not_checked_in` is work for a person. amount_posted counts ONLY the charges
  -- this run created, so a re-run of an already-audited night reports 0.00 —
  -- which is exactly how an operator confirms the retry changed nothing.
  return jsonb_build_object(
    'property_id',          p_property_id,
    'property_name',        v_property_name,
    'tenant_id',            v_tenant_id,
    'timezone',             v_timezone,
    'night_audit_time',     v_audit_time,
    'business_date',        v_date,
    'ran_at',               now(),
    'in_house',             v_in_house,
    'posted',               v_posted,
    'already_posted',       v_skipped,
    'already_posted_voided', v_voided,
    'amount_posted',        v_amount,
    'error_count',          jsonb_array_length(v_errors),
    'errors',               v_errors,
    'not_checked_in_count', jsonb_array_length(v_not_checked_in),
    'not_checked_in',       v_not_checked_in
  );
end;
$$;

comment on function run_night_audit(uuid, date) is
  'Posts one room-night charge for every in-house booking at a property for a '
  'business date, by calling post_room_night_charge (which prices from the '
  'booking_nights lock) — it orchestrates only, it never prices. Default date is '
  'YESTERDAY in the PROPERTY''s timezone: the night that just ended, so the '
  'charge posted at the 06:00 cutoff is for the night before. Charges '
  'checked_in and checked_out stays whose half-open [check_in, check_out) '
  'contains the date; confirmed-but-not-arrived bookings are REPORTED, never '
  'charged. SAFE TO RE-RUN: post_room_night_charge''s deterministic '
  'room:<booking>:<date> key plus folio_charges_idem_uniq mean a repeat run '
  'returns the existing charges and writes nothing. Returns a jsonb summary '
  '(posted / already_posted / errors / not_checked_in) so the cron result is '
  'observable. One booking''s failure never abandons the rest.';


-- ############################################################################
-- SECTION 3 — update_property_finance_settings (the discount threshold writer)
-- ############################################################################
-- The fifth settings target, in the IDENTICAL shape as 008's four: resolve the
-- owning tenant -> is_tenant_admin gate -> lock the row FOR UPDATE -> compare
-- updated_at -> apply only the supplied keys -> RETURN the fresh row so the
-- client re-bases its concurrency token without a second fetch. Same custom
-- SQLSTATEs (PT404 / PT403 / PT409 / PT422), so the settings form's existing
-- error handling covers it with no new branch.
--
-- WHY AN RPC AT ALL, when property_finance_settings already has an admin UPDATE
-- policy (021 §11)? For the optimistic-concurrency guard. Two managers with the
-- settings page open would otherwise last-write-wins each other's threshold, and
-- the loser's change would vanish with no error — the exact lost-update failure
-- 008 was written to kill. The threshold decides how much money a receptionist
-- can give away without asking anyone, so a silently-reverted change to it is
-- not a cosmetic loss.
create or replace function update_property_finance_settings(
  p_property_id         uuid,
  p_patch               jsonb,
  p_expected_updated_at timestamptz
) returns property_finance_settings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant_id  uuid;
  v_updated_at timestamptz;
  v_threshold  numeric;
  v_result     property_finance_settings;
begin
  select p.tenant_id
    into v_tenant_id
  from properties p
  where p.id = p_property_id
    and p.deleted_at is null;

  if v_tenant_id is null then
    raise exception 'Property % not found', p_property_id
      using errcode = 'PT404';
  end if;

  -- Raising the no-PIN ceiling is a financial-control decision, not a
  -- preference: owner/manager only, exactly as every other settings writer.
  if not is_tenant_admin(v_tenant_id) then
    raise exception 'You are not authorised to edit this property''s finance settings'
      using errcode = 'PT403';
  end if;

  select pfs.updated_at
    into v_updated_at
  from property_finance_settings pfs
  where pfs.property_id = p_property_id
  for update;

  if v_updated_at is null then
    raise exception 'Finance settings for property % not found', p_property_id
      using errcode = 'PT404';
  end if;

  if p_expected_updated_at is distinct from v_updated_at then
    raise exception 'These settings were changed by someone else since you loaded them'
      using errcode = 'PT409',
            hint = 'Reload to see the latest values, then reapply your change.';
  end if;

  -- discount_threshold is NOT NULL with a >= 0 CHECK. Both are re-stated here so
  -- the admin gets a sentence instead of a constraint name — and so a cleared
  -- field cannot be read as "no threshold", which would be read by
  -- apply_charge_discount as "0 = everything needs a PIN" and quietly change the
  -- hotel's approval policy.
  if p_patch ? 'discount_threshold' then
    v_threshold := (p_patch ->> 'discount_threshold')::numeric;
    if v_threshold is null then
      raise exception 'Enter a discount threshold (use 0 to require approval for every discount)'
        using errcode = 'PT422';
    end if;
    if v_threshold < 0 then
      raise exception 'The discount threshold cannot be negative'
        using errcode = 'PT422';
    end if;
  end if;

  update property_finance_settings
     set discount_threshold = case
                                when p_patch ? 'discount_threshold'
                                  then (p_patch ->> 'discount_threshold')::numeric
                                else discount_threshold
                              end
   where property_id = p_property_id
  returning * into v_result;

  return v_result;
end;
$$;

comment on function update_property_finance_settings(uuid, jsonb, timestamptz) is
  'Patch property_finance_settings columns (discount_threshold) under an '
  'optimistic updated_at check — the same shape as 008''s four settings writers, '
  'same PT404/PT403/PT409/PT422 SQLSTATEs. Admin-gated; SECURITY DEFINER. Exists '
  'for the concurrency guard the table''s RLS policy cannot give: a silently '
  'lost change to the no-PIN ceiling is a change to who may give money away.';


-- ############################################################################
-- SECTION 4 — Grants
-- ############################################################################
-- SECURITY DEFINER functions default to EXECUTE for PUBLIC. Revoke, then grant
-- the intended audience only — never anon.
--
-- run_night_audit is granted to BOTH:
--   * service_role  — the Vercel cron, the normal caller;
--   * authenticated — so a manager can re-run an audit they are not sure
--                     completed, and so the front-desk build can put a "Run
--                     night audit" action on screen without a new migration.
--                     is_tenant_staff inside the function is the real gate, and
--                     the idempotency key means a curious re-run costs nothing.
revoke execute on function run_night_audit(uuid, date) from public;
revoke execute on function run_night_audit(uuid, date) from anon;
grant  execute on function run_night_audit(uuid, date) to authenticated;
grant  execute on function run_night_audit(uuid, date) to service_role;

revoke execute on function update_property_finance_settings(uuid, jsonb, timestamptz) from public;
revoke execute on function update_property_finance_settings(uuid, jsonb, timestamptz) from anon;
grant  execute on function update_property_finance_settings(uuid, jsonb, timestamptz) to authenticated;

-- ============================================================================
-- End of 023_night_audit.sql
-- ============================================================================
