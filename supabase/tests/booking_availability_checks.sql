-- ============================================================================
-- booking_availability_checks.sql
-- Palstro-Hotels: hand-run verification of the booking availability engine (6a).
--
-- THIS IS NOT A MIGRATION. Do not number it, do not put it in migrations/. It
-- proves the engine in 015 is correct BEFORE any UI (6b) is built on top of it.
-- Run it in the Supabase SQL editor. It is NON-DESTRUCTIVE: it builds a
-- throwaway tenant/property/room type/guest, runs every check, then deliberately
-- raises at the end to ROLL BACK everything it created (including the document
-- counter it advanced). A successful run ends with:
--
--     ERROR:  ✅ ALL CHECKS PASSED — rolling back test data (this abort is expected)
--
-- Any other ERROR before that line is a REAL FAILURE — read its message.
--
-- ---------------------------------------------------------------------------
-- ONE THING TO FILL IN: your own auth user UUID.
-- The RPCs are admin-gated via is_tenant_admin(), which reads auth.uid(). This
-- harness impersonates an OWNER by setting the JWT claim to the id below, and
-- created_by columns reference auth.users(id), so it MUST be a REAL auth user —
-- use your own. Find it with:  select id, email from auth.users order by created_at;
-- ---------------------------------------------------------------------------

do $$
declare
  -- >>> FILL THIS IN <<<  a real auth.users.id (yours).
  v_owner       uuid := '00000000-0000-0000-0000-000000000000';

  v_tenant      uuid;
  v_property    uuid;
  v_type        uuid;
  v_guest       uuid;

  v_b1          bookings;
  v_b2          bookings;
  v_b3          bookings;
  v_b_idem_a    bookings;
  v_b_idem_b    bookings;
  v_avail       integer;
begin
  if v_owner = '00000000-0000-0000-0000-000000000000' then
    raise exception 'Set v_owner to a real auth.users.id before running (see header).';
  end if;

  -- Impersonate the owner for the whole block so auth.uid() = v_owner inside every
  -- RPC. `true` = transaction-local; the SQL editor runs this in one transaction.
  perform set_config('request.jwt.claims',
                     json_build_object('sub', v_owner::text, 'role', 'authenticated')::text,
                     true);

  -- ---- Setup: a disposable tenant / property / room type / owner / guest -----
  -- Inserted directly (we are the DB owner here; RLS is bypassed for setup). The
  -- AFTER-INSERT triggers create tenant_settings/property_settings rows for us.
  insert into tenants (name, slug, status)
    values ('TEST Tenant', 'test-tenant-6a-' || substr(v_owner::text, 1, 8), 'active')
    returning id into v_tenant;

  insert into properties (tenant_id, name, slug)
    values (v_tenant, 'TEST Property', 'test-prop')
    returning id into v_property;

  -- Make v_owner an ACTIVE OWNER so is_tenant_admin(v_tenant) is true.
  insert into tenant_users (tenant_id, user_id, role, is_active)
    values (v_tenant, v_owner, 'owner', true);

  -- A room type with INVENTORY_COUNT = 2 (RULE 3 denominator), rack 20000.
  insert into room_types (tenant_id, property_id, name, base_rate,
                          max_adults, max_children, inventory_count)
    values (v_tenant, v_property, 'TEST Deluxe', 20000.00, 3, 2, 2)
    returning id into v_type;

  insert into guests (tenant_id, full_name, phone)
    values (v_tenant, 'TEST Guest', '08000000000')
    returning id into v_guest;

  raise notice '--- setup done: type % has inventory_count = 2 ---', v_type;

  -- =========================================================================
  -- CHECK 1 — two overlapping bookings fit (inventory 2); the THIRD is rejected.
  -- =========================================================================
  v_b1 := create_booking(v_property, v_type, v_guest,
                         date '2026-08-10', date '2026-08-13', 2, 'idem-b1');
  raise notice 'CHECK 1: booking #1 created: %', v_b1.booking_number;

  v_b2 := create_booking(v_property, v_type, v_guest,
                         date '2026-08-11', date '2026-08-14', 2, 'idem-b2');
  raise notice 'CHECK 1: booking #2 created: % (both hold nights of Aug 11-12)',
    v_b2.booking_number;

  -- inventory is 2 and both overlap Aug 11–12, so a third overlapping booking
  -- MUST be refused.
  begin
    v_b3 := create_booking(v_property, v_type, v_guest,
                          date '2026-08-11', date '2026-08-12', 2, 'idem-b3');
    raise exception 'CHECK 1 FAILED: third overlapping booking was ACCEPTED (% ) — OVERBOOKED',
      v_b3.booking_number;
  exception
    when check_violation then
      raise notice 'CHECK 1 PASSED: third overlapping booking correctly rejected (no availability).';
  end;

  -- =========================================================================
  -- CHECK 2 — a booking STARTING on another's checkout day is ACCEPTED.
  -- (RULE 1: check-out day is not an occupied night; half-open [in, out).)
  -- b1 is Aug 10–13, so it occupies nights 10,11,12 and frees on the 13th.
  -- A booking Aug 13–15 must NOT clash with b1. With b2 (Aug 11–14) still holding
  -- night 13, only 1 unit is free on the 13th, so ONE such booking fits.
  -- =========================================================================
  v_avail := count_available(v_property, v_type, date '2026-08-13', date '2026-08-15', null);
  raise notice 'CHECK 2: available for Aug 13-15 = % (expect 1: b2 holds night 13, b1 does not)', v_avail;
  if v_avail <> 1 then
    raise exception 'CHECK 2 FAILED: expected 1 free for Aug 13-15, got %', v_avail;
  end if;

  declare
    v_boundary bookings;
  begin
    v_boundary := create_booking(v_property, v_type, v_guest,
                                date '2026-08-13', date '2026-08-15', 2, 'idem-boundary');
    raise notice 'CHECK 2 PASSED: booking starting on b1''s checkout day (Aug 13) accepted: %',
      v_boundary.booking_number;
  end;

  -- =========================================================================
  -- CHECK 3 — cancelling a booking FREES a slot (RULE 4).
  -- Aug 11–12 is currently full (b1 + b2). Cancel b2, then an Aug 11–12 booking fits.
  -- =========================================================================
  v_avail := count_available(v_property, v_type, date '2026-08-11', date '2026-08-12', null);
  if v_avail <> 0 then
    raise exception 'CHECK 3 PRECONDITION FAILED: expected 0 free for Aug 11-12 before cancel, got %', v_avail;
  end if;

  perform cancel_booking(v_b2.id, 'test cancellation', 'idem-cancel-b2');

  v_avail := count_available(v_property, v_type, date '2026-08-11', date '2026-08-12', null);
  raise notice 'CHECK 3: available for Aug 11-12 after cancelling b2 = % (expect 1)', v_avail;
  if v_avail <> 1 then
    raise exception 'CHECK 3 FAILED: cancel did not free a slot (got % free)', v_avail;
  end if;

  declare
    v_after_cancel bookings;
  begin
    v_after_cancel := create_booking(v_property, v_type, v_guest,
                                    date '2026-08-11', date '2026-08-12', 2, 'idem-after-cancel');
    raise notice 'CHECK 3 PASSED: after cancelling b2, an Aug 11-12 booking fits: %',
      v_after_cancel.booking_number;
  end;

  -- =========================================================================
  -- CHECK 4 — idempotency: the SAME key returns the SAME booking, not a second.
  -- =========================================================================
  v_b_idem_a := create_booking(v_property, v_type, v_guest,
                              date '2026-09-01', date '2026-09-03', 1, 'idem-repeat-key');
  v_b_idem_b := create_booking(v_property, v_type, v_guest,
                              date '2026-09-01', date '2026-09-03', 1, 'idem-repeat-key');
  raise notice 'CHECK 4: first call id=% number=% ; second call id=% number=%',
    v_b_idem_a.id, v_b_idem_a.booking_number, v_b_idem_b.id, v_b_idem_b.booking_number;
  if v_b_idem_a.id <> v_b_idem_b.id then
    raise exception 'CHECK 4 FAILED: same idempotency key produced TWO bookings (% vs %)',
      v_b_idem_a.id, v_b_idem_b.id;
  end if;
  raise notice 'CHECK 4 PASSED: repeat call returned the same booking (idempotent).';

  -- Bonus sanity: each night of a stay got a locked rate row.
  declare
    v_nights integer;
  begin
    select count(*) into v_nights from booking_nights where booking_id = v_b1.id;
    if v_nights <> 3 then
      raise exception 'NIGHTS FAILED: b1 (Aug 10-13) should have 3 night rows, has %', v_nights;
    end if;
    raise notice 'NIGHTS PASSED: b1 has 3 locked booking_nights rows.';
  end;

  -- All good — abort to leave the database exactly as we found it.
  raise exception '✅ ALL CHECKS PASSED — rolling back test data (this abort is expected)';
end $$;


-- ============================================================================
-- CONCURRENCY PROOF (two sessions — cannot be scripted in one block)
-- ----------------------------------------------------------------------------
-- The block above proves the LOGIC (half-open clash, cancel frees, idempotency).
-- To witness the LOCK itself defeat a simultaneous double-book, use two SQL
-- sessions against a room type with inventory_count = 1 and a real owner session.
-- Replace <PROP>, <TYPE>, <GUEST> with ids of a type that has exactly ONE unit
-- free for the dates, and run as an authenticated owner in BOTH sessions.
--
-- Session A:
--     begin;
--     -- take the row lock + attempt the booking, then PAUSE holding the lock:
--     select create_booking('<PROP>','<TYPE>','<GUEST>',
--                           date '2026-10-01', date '2026-10-03', 1, 'concurrency-A');
--     -- do NOT commit yet; leave this transaction open.
--
-- Session B (while A is still open):
--     begin;
--     select create_booking('<PROP>','<TYPE>','<GUEST>',
--                           date '2026-10-01', date '2026-10-03', 1, 'concurrency-B');
--     -- B BLOCKS here, waiting on A's SELECT ... FOR UPDATE on the room_types row.
--
-- Back in Session A:
--     commit;   -- releases the lock; A's booking is now committed.
--
-- Session B then unblocks, re-counts (now sees 0 free), and RAISES
-- "No availability: room type ... is fully booked". Exactly one booking exists.
--     rollback;  -- in B (nothing was inserted)
--
-- Cleanup: delete the 'concurrency-A' booking (and its nights cascade) if you ran
-- this against real data.
-- ============================================================================
