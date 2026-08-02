-- ============================================================================
-- 026_checkout_posts_room_nights.sql
-- Palstro-Hotels: CHECKOUT COMPLETES THE BILL.
--
-- ----------------------------------------------------------------------------
-- THE GAP THIS CLOSES
-- ----------------------------------------------------------------------------
-- Room nights post at the NIGHT AUDIT (021 DECISION 2, 023's runner), which fires
-- once a day at the property's cutoff — 06:00 by default. A guest who departs
-- BEFORE that cutoff has a folio with no room charge on it at all:
--
--     22:14 on the 1st   guest checks in, actual_check_in = the 1st
--     02:40 on the 2nd   guest asks to settle and leave (early flight)
--     06:00 on the 2nd   ...the audit that would have billed the night of the
--                        1st runs FOUR HOURS AFTER THEY LEFT.
--
-- So at 02:40 the bill is empty, the desk cannot settle it, and the only way out
-- is to key a room charge by hand — a re-priced night, posted by whoever is on
-- nights, with no lock behind it. Four hours later the audit posts the real one
-- and the guest is billed twice for a room they have already left.
--
-- CHECKOUT MUST COMPLETE THE BILL AT THE MOMENT OF DEPARTURE, WHATEVER THE HOUR.
-- That is the whole of this migration.
--
-- ----------------------------------------------------------------------------
-- WHAT IS NOT TOUCHED, AND WHY THAT MATTERS
-- ----------------------------------------------------------------------------
-- post_charge, post_room_night_charge, apply_charge_discount, folio_totals,
-- folio_balance, booking_nights, run_night_audit, check_in_booking, mark_no_show,
-- cancel_booking, create_booking and every pricing path are BYTE-FOR-BYTE as
-- 021/023/024/025 left them. ONE function changes: check_out_booking.
--
-- Like the night audit, it ORCHESTRATES ONLY. It does not price a night, does not
-- choose a rate, does not write a folio row itself, and does not resolve a charge
-- category. Every charge it causes is posted by post_room_night_charge at the rate
-- LOCKED in booking_nights when the booking was taken.
--
-- ----------------------------------------------------------------------------
-- THE SAFETY PROPERTY: CHECKOUT AND THE NIGHT AUDIT CANNOT DOUBLE-CHARGE
-- ----------------------------------------------------------------------------
--
--  ┌──────────────────────────────────────────────────────────────────────────┐
--  │  CHECKOUT AND THE NIGHT AUDIT POST THROUGH THE SAME IDEMPOTENT KEY —     │
--  │  'room:<booking>:<date>' — SO WHICHEVER REACHES A NIGHT FIRST WINS AND   │
--  │  THE OTHER NO-OPS. Neither needs to know the other ran.                  │
--  └──────────────────────────────────────────────────────────────────────────┘
--
-- Both callers go through post_room_night_charge (021 §9.2), which builds that
-- deterministic key and hands it to post_charge (021 §9.1). post_charge FIRST
-- looks the key up in folio_charges and returns the existing row if it finds one;
-- if a concurrent call wins the race instead, it catches the unique_violation on
-- folio_charges_idem_uniq — the partial unique index, rule 3 — and returns that
-- row. So for a given (booking, night):
--
--   * the audit posts it at 06:00 and a 09:00 checkout re-requests it -> no-op;
--   * a 02:40 checkout posts it and the 06:00 audit re-requests it    -> no-op;
--   * a double-clicked checkout requests it twice                     -> no-op;
--   * a checkout that errors and is retried                           -> no-op on
--     the nights the first attempt committed... except it committed nothing,
--     because the whole call is one transaction (see below).
--
-- The guarantee is a UNIQUE INDEX IN THE DATABASE, not this function being
-- careful. That is why this migration can add a second poster of room nights
-- without touching the first one.
--
-- ----------------------------------------------------------------------------
-- ONE TRANSACTION: NEVER A CHECKED-OUT BOOKING WITH AN INCOMPLETE BILL (rule 7)
-- ----------------------------------------------------------------------------
-- The postings and the status change happen in the SAME transaction — the
-- implicit one of the function call — and there is DELIBERATELY NO per-night
-- exception block here. That is the one structural difference from
-- run_night_audit, and it is deliberate in both directions:
--
--   * the AUDIT is an unattended sweep across a whole property, so one broken
--     booking must not abandon the other twenty-nine: each posting gets its own
--     subtransaction and failures are collected into the summary (023 §2);
--   * a CHECKOUT is one guest, standing at the desk, with one bill. A night that
--     cannot post means the bill is wrong, and completing the checkout anyway
--     would hand them a settled-looking folio that is missing a night. So a
--     failure propagates, the transaction rolls back, the booking stays
--     checked_in, and the desk sees the real reason (rule 11).
--
-- ============================================================================


-- ############################################################################
-- SECTION 1 — check_out_booking: post the unbilled nights, then depart
-- ############################################################################
--
-- ----------------------------------------------------------------------------
-- WHICH NIGHTS ARE POSTED — AND WHY IT IS THE SAME RULE AS run_night_audit
-- ----------------------------------------------------------------------------
--
--   THE RANGE:  [ greatest(coalesce(actual_check_in, check_in), check_in),
--                 check_out )                                    -- half-open
--
-- That expression is COPIED FROM 024 §3's date predicate, character for
-- character, and it must stay that way. If the two disagreed, a night would be
-- billed differently depending on WHO reached it first — the audit at 06:00 or
-- the desk at 02:40 — and which of the two ran first is an accident of what time
-- the guest chose to leave. A bill must not depend on that.
--
--   run_night_audit (024 §3), per candidate night v_date:
--       greatest(coalesce(b.actual_check_in, b.check_in), b.check_in) <= v_date
--       and v_date < b.check_out
--
--   here, walking v_date from the same start while v_date < check_out:
--       v_charge_from := greatest(coalesce(actual_check_in, check_in), check_in)
--       while v_date < v_booking.check_out
--
-- Same start, same exclusive end. Read outward-in, for the reasons 024 gives in
-- full:
--
--   coalesce(actual_check_in, check_in)
--       CHARGE FROM WHEN THEY ARRIVED. The fallback covers a stay checked in
--       before 024 shipped (it deliberately did not backfill), and reproduces the
--       pre-024 behaviour exactly — unchanged billing, never a skipped night.
--
--   greatest(..., check_in)
--       NEVER BEFORE THE FIRST RESERVED NIGHT. An early arrival has no
--       booking_nights row for the earlier night (nights are locked over the
--       reserved range only, 015 §5), so post_room_night_charge would raise 'has
--       no night on <date>' — and here, unlike in the audit, that raise would
--       roll back the whole checkout. This clause is what keeps an early arrival
--       a clean no-op instead of a checkout that cannot complete.
--
--   v_date < check_out
--       THE DEPARTURE DAY IS NEVER A NIGHT (015 RULES 1 & 2). A guest leaving on
--       the 5th is charged for the 4th, not the 5th.
--
-- WHY check_out AND NOT "TODAY", for the early departure: a guest booked to the
-- 5th who leaves on the 3rd. Clamping the range to the property's today would
-- post the 1st and 2nd and stop — but it would NOT stop the guest being billed
-- for the 3rd and 4th, because run_night_audit charges 'checked_out' stays too
-- (023's header: the nights before departure were genuinely slept, and a
-- same-morning checkout departs before the cutoff). The audit would simply post
-- those two nights over the following mornings, onto the folio of a guest who has
-- gone. Clamping would therefore not avoid the charge — it would only delay it
-- past the moment the guest could see and dispute it, and it would put this
-- function out of step with the audit. THE CORRECT HANDLING OF AN EARLY DEPARTURE
-- IS TO SHORTEN THE BOOKING'S check_out AT THE DESK, which is the same act the
-- audit already relies on (023 §2: "a stay shortened at an early checkout stops
-- being charged from the new check_out onward, with no reversal needed"). This
-- function bills the booking's current dates, exactly as the audit does.
--
-- ----------------------------------------------------------------------------
-- WHAT ELSE CHANGED FROM 016 §6, EXHAUSTIVELY
-- ----------------------------------------------------------------------------
--   + the posting loop and its counters;
--   + the folio lookup and the folio_totals read for the returned balance;
--   + the RETURN TYPE: bookings -> jsonb, so the desk gets a summary (the brief:
--     "nights posted at checkout, nights already posted") instead of a row that
--     says nothing about what the checkout did to the bill. The booking row is
--     still there, whole, under the 'booking' key.
-- UNCHANGED and copied verbatim: SELECT ... FOR UPDATE on the booking, the
-- not-found raise, the is_tenant_staff gate, the idempotent-by-state early
-- return, the checked_in-only status guard, the updated_by stamp, SECURITY
-- DEFINER and the pinned search_path.
--
-- WHAT IT STILL DOES NOT DO: it does not settle the folio, does not close it, and
-- does not require a zero balance. Nothing in the schema moves a folio off 'open'
-- yet, and inventing that transition here would freeze bills the desk still has
-- to take money against. Checkout completes the CHARGES; settlement is its own
-- act on the Folio tab, and the returned balance is what tells the desk to go
-- and perform it.
--
-- DROP-then-CREATE because the RETURN TYPE changes (Postgres refuses a
-- create-or-replace that changes it). Safe: bookings has no update RLS policy, so
-- this RPC is the only thing that has ever performed the transition, and the
-- grant is re-issued in §2 because DROP takes privileges with it.
drop function if exists check_out_booking(uuid, text);

create or replace function check_out_booking(
  p_booking_id      uuid,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking     bookings;
  v_actor       uuid := auth.uid();

  v_charge_from date;
  v_date        date;
  v_key         text;
  v_existed     boolean;
  v_charge      folio_charges;

  v_folio_id    uuid;
  v_replay      boolean;

  v_nights      integer := 0;
  v_posted      integer := 0;
  v_skipped     integer := 0;
  v_voided      integer := 0;
  v_unbilled    integer := 0;
  v_amount      numeric(14,2) := 0;

  v_charges     numeric(14,2);
  v_payments    numeric(14,2);
  v_balance     numeric(14,2);
begin
  -- Lock the booking for the whole call, so a concurrent second checkout (a
  -- double-click, two receptionists on the same guest) waits here and then sees
  -- 'checked_out' rather than racing this one through the posting loop.
  select * into v_booking
  from bookings
  where id = p_booking_id and deleted_at is null
  for update;

  if not found then
    raise exception 'Booking % not found', p_booking_id using errcode = 'no_data_found';
  end if;

  if not is_tenant_staff(v_booking.tenant_id) then
    raise exception 'Not authorised to update this booking'
      using errcode = 'insufficient_privilege';
  end if;

  -- Idempotent by state (unchanged from 016 §6) — but it no longer returns
  -- BLIND. A re-run reports the same summary shape, computed read-only: it posts
  -- nothing and writes nothing, and the desk sees the nights that are already on
  -- the bill and the current balance rather than a bare row. v_replay is what
  -- switches the loop below from posting to counting.
  --
  -- p_idempotency_key is accepted (rule 2) and deliberately NOT forwarded to the
  -- postings, for the same reason mark_no_show refuses one (024 §4): the per-night
  -- key must stay 'room:<booking>:<date>' or two different caller keys could post
  -- the same night twice — which is precisely what must be impossible. The
  -- transition itself is guarded by state, and every charge by its own
  -- deterministic key, so a caller key has nothing left to protect.
  v_replay := (v_booking.status = 'checked_out');

  if not v_replay and v_booking.status <> 'checked_in' then
    raise exception 'Only a checked-in booking can be checked out (status is %)',
      v_booking.status using errcode = 'check_violation';
  end if;

  -- The folio (021 §5 opens one per booking at insert). Needed for the balance in
  -- the summary; post_room_night_charge resolves it again for itself.
  select f.id into v_folio_id from folios f where f.booking_id = p_booking_id;

  -- ==========================================================================
  -- THE POSTING LOOP — the same range run_night_audit selects (see the header)
  -- ==========================================================================
  v_charge_from := greatest(
                     coalesce(v_booking.actual_check_in, v_booking.check_in),
                     v_booking.check_in
                   );

  v_date := v_charge_from;
  while v_date < v_booking.check_out loop
    v_nights := v_nights + 1;

    -- The key post_room_night_charge will build for this (booking, night). Read
    -- BEFORE the call so the summary can tell a night POSTED AT CHECKOUT from one
    -- the audit had already posted; the call itself is what enforces uniqueness,
    -- so a race here can only mis-classify a count, never double-charge.
    v_key := 'room:' || p_booking_id::text || ':' || v_date::text;
    select exists (
      select 1 from folio_charges fc
      where fc.tenant_id = v_booking.tenant_id
        and fc.idempotency_key = v_key
    ) into v_existed;

    if v_replay then
      -- Read-only pass for an already-departed guest: count, post nothing.
      if v_existed then
        v_skipped := v_skipped + 1;
      else
        v_unbilled := v_unbilled + 1;
      end if;
    else
      -- The ONLY write this function causes, and it is somebody else's function.
      -- The rate comes from booking_nights, locked at booking time. NO exception
      -- block: a night that cannot post rolls the entire checkout back (rule 7).
      select * into v_charge from post_room_night_charge(p_booking_id, v_date);

      if v_existed then
        -- Already on the bill — the night audit reached it first. post_charge
        -- returned the existing row and wrote nothing.
        v_skipped := v_skipped + 1;
        -- A night whose charge was deliberately VOIDED stays voided: the key
        -- still exists, so this returns the voided row and posts nothing.
        -- Correct — re-posting would silently undo a person's decision — but it
        -- must be VISIBLE, so it is counted and returned.
        if v_charge.is_voided is true then
          v_voided := v_voided + 1;
        end if;
      else
        v_posted := v_posted + 1;
        v_amount := v_amount + coalesce(v_charge.net_amount, 0);
      end if;
    end if;

    v_date := v_date + 1;
  end loop;

  -- The transition, AFTER the bill is complete and in the SAME transaction.
  if not v_replay then
    update bookings
      set status     = 'checked_out',
          updated_by = v_actor
    where id = p_booking_id
    returning * into v_booking;
  end if;

  -- The balance the desk must act on, read LIVE from folio_totals (021 §8.2) —
  -- never cached, never computed here (rule 6). Null-safe: a booking with no
  -- folio row would be a broken state, but it must not turn a completed checkout
  -- into an error, so the summary reports a null balance and the Folio tab says
  -- the rest.
  if v_folio_id is not null then
    select ft.charges_total, ft.payments_total, ft.balance
      into v_charges, v_payments, v_balance
    from folio_totals(v_folio_id) ft;
  end if;

  -- --------------------------------------------------------------------------
  -- The summary. INVARIANT: posted + already_posted + unbilled = nights_total,
  -- and unbilled is 0 after any successful checkout (the loop posts every night
  -- it counts). A non-zero unbilled can only appear on a REPLAY and means a night
  -- in the range carries NO charge at all — its charge row is gone, or the stay's
  -- dates moved after the guest departed. It is NOT the voided case: a voided
  -- charge keeps its idempotency key, so it counts as already_posted (and is
  -- reported separately as nights_already_voided, which a replay cannot see
  -- because it never calls post_room_night_charge to read the row back).
  -- --------------------------------------------------------------------------
  return jsonb_build_object(
    'booking',                to_jsonb(v_booking),
    'booking_id',             v_booking.id,
    'booking_number',         v_booking.booking_number,
    'status',                 v_booking.status,
    'already_checked_out',    v_replay,
    'charge_from',            v_charge_from,
    'check_out',              v_booking.check_out,
    'nights_total',           v_nights,
    'nights_posted',          v_posted,
    'nights_already_posted',  v_skipped,
    'nights_already_voided',  v_voided,
    'nights_unbilled',        v_unbilled,
    'amount_posted',          v_amount,
    'folio_id',               v_folio_id,
    'charges_total',          v_charges,
    'payments_total',         v_payments,
    'balance',                v_balance
  );
end;
$$;

comment on function check_out_booking(uuid, text) is
  'Transitions a checked-in booking -> checked_out AND COMPLETES THE BILL FIRST: '
  'it posts every unbilled room night of the stay via post_room_night_charge, so '
  'a guest departing at 02:00 — before the night audit runs — has a settleable '
  'folio. The nights are [greatest(coalesce(actual_check_in, check_in), '
  'check_in), check_out), CHARACTER FOR CHARACTER the range run_night_audit '
  'charges (024 §3), so a night is billed identically whoever reaches it first. '
  'Both post through the deterministic room:<booking>:<date> key, so whichever '
  'gets there first wins and the other no-ops — checkout can never double-charge '
  'a night the audit already posted, or vice versa. ONE TRANSACTION with the '
  'status change (rule 7): a night that cannot post rolls the whole checkout '
  'back, so there is never a checked-out booking with an incomplete bill — and '
  'unlike the audit there is NO per-night exception block, because a checkout is '
  'one guest with one bill. Staff-gated, idempotent by state (a re-run posts '
  'nothing and returns the same summary read-only), SECURITY DEFINER, pinned '
  'search_path. Returns a jsonb summary — the booking row plus nights_posted / '
  'nights_already_posted / amount_posted / balance. Does NOT settle or close the '
  'folio: settlement is its own act, and the returned balance is what sends the '
  'desk to it.';


-- ############################################################################
-- SECTION 2 — Grants
-- ############################################################################
-- SECURITY DEFINER functions default to EXECUTE for PUBLIC. Revoke, then grant
-- the intended audience only — never anon.
--
-- The function was DROPPED in §1 (the return type changed), which discarded 016
-- §8's grant; it is re-issued here. The old bookings-returning signature no
-- longer exists, so there is nothing else to revoke.
--
-- authenticated ONLY. Checking a guest out is a FRONT-DESK act and, since this
-- migration, one that posts money to a folio — the service role is not granted
-- it, so no unattended job can complete a stay. (The night audit posts the same
-- nights through its own path when it reaches them; it must never decide that a
-- guest has departed.)
revoke execute on function check_out_booking(uuid, text) from public;
revoke execute on function check_out_booking(uuid, text) from anon;
revoke execute on function check_out_booking(uuid, text) from service_role;
grant  execute on function check_out_booking(uuid, text) to authenticated;

-- ============================================================================
-- End of 026_checkout_posts_room_nights.sql
-- ============================================================================
