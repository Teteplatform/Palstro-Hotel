-- ============================================================================
-- 027_guest_ledger.sql
-- Palstro-Hotels: the GUEST-LEVEL view over the per-stay folios (2.txt).
--
-- One new column (guests.preferences) and TWO READ-ONLY VIEWS. No new table, no
-- new write RPC, no seed data, and NOTHING in the folio engine is touched:
-- folio_totals, post_charge, record_payment and folio_balance are used exactly as
-- 021 ships them. This migration only AGGREGATES what they already compute.
--
-- ----------------------------------------------------------------------------
-- THE PROBLEM THIS SOLVES
-- ----------------------------------------------------------------------------
-- A folio belongs to a STAY (021 §4.1 opens one per booking). A returning guest
-- with four stays therefore has four folios, four balances and no single answer
-- to "what does this person owe us?" — which is the question the front desk and
-- the owner actually ask about a repeat guest. These views answer it without
-- moving a single row of money.
--
-- ----------------------------------------------------------------------------
-- FIFO ALLOCATION: COMPUTED AT READ TIME, NEVER STORED. THE CRUX — READ THIS.
-- ----------------------------------------------------------------------------
-- Requirement: a guest's payment settles their OLDEST unpaid stay first, and ONE
-- payment may settle across several stays (₦200k clears two older ₦100k stays).
--
-- TWO MODELS WERE POSSIBLE.
--
--   (a) RECORD-TIME ALLOCATION — record_payment splits the money across folios as
--       it is taken, writing allocation rows (or several folio_payments).
--       Rejected, for four separate reasons:
--         1. It is a STORED DERIVED FIGURE, i.e. exactly the cache rule 6
--            forbids. The moment a charge is posted to, voided on, or discounted
--            on an OLDER stay, every allocation after it is wrong — FIFO depends
--            on the charge totals, which keep moving after the payment is taken.
--            Repairing it needs a re-allocation job, and until that job runs the
--            stored answer is silently false.
--         2. Voiding a payment would have to unwind allocations across several
--            folios in lockstep (rule 7). That is a multi-folio reversal path
--            invented for a presentation feature.
--         3. It changes record_payment, which this build is explicitly not to
--            touch — and would make a payment's own folio_id ambiguous, breaking
--            the per-booking folio the brief requires to keep working.
--         4. It destroys the audit line "this payment was taken by X against
--            stay Y", replacing one fact with several derived ones.
--
--   (b) READ-TIME ALLOCATION — payments stay exactly where they were recorded
--       (on their own stay's folio, with their own received_by and business
--       date), and the guest-level FIFO application is COMPUTED on every read
--       from the charges and payments as they stand right now.  ← CHOSEN.
--         * Nothing is stored, so nothing can drift (rule 6). A charge posted
--           tomorrow to an older stay re-flows the allocation automatically.
--         * The per-booking folio is untouched and still exactly correct — the
--           same rows, the same folio_totals, the same balance.
--         * A void is excluded by the SAME NULL-safe filters the engine already
--           applies (rule 5); there is no second reversal path.
--         * Every payment still ties to who took it and when.
--
-- THE ALLOCATION, STATED AS ARITHMETIC (guest_stays below):
--   stays are ordered oldest-first by check_in;
--   pool          = every non-voided payment of this guest at this property,
--                   summed (this is Σ folio_totals.payments_total);
--   before(i)     = Σ charges of every stay older than stay i;
--   allocated(i)  = clamp(pool − before(i), 0, charges(i)).
-- That is FIFO water-filling in one window function, with no loop: the pool
-- fills each stay to the brim in date order and the remainder spills to the
-- next. Applying the payments one at a time in date order yields the same
-- per-stay allocation, so no per-payment tracking is needed to answer
-- "is this stay settled?".
--
-- ----------------------------------------------------------------------------
-- HOW THE TWO VIEWS RECONCILE WITH THE PER-BOOKING FOLIOS (rule 9)
-- ----------------------------------------------------------------------------
-- INVARIANT 1 (the one that matters):
--   Σ folio_totals(f).balance over the guest's stays
--     = Σ charges − Σ payments
--     = guest_ledger.running_balance of the guest's LAST entry
--     = the guest's outstanding balance.
--   FIFO only decides WHICH stay a payment is considered to settle; it cannot
--   change the total, because it only redistributes the same pool. So the guest
--   ledger and the per-stay folios can never disagree about what is owed.
--
-- INVARIANT 2 (allocation closes):
--   Σ allocated(i) = least(pool, Σ charges), and
--   Σ (charges(i) − allocated(i)) = greatest(0, Σ charges − pool).
--   When the pool EXCEEDS total charges the difference is unapplied credit — a
--   deposit or over-payment — which shows as a NEGATIVE guest balance and as
--   zero unallocated. Outstanding and credit are reported separately and never
--   netted into one number, for the same reason the bookings summary keeps
--   outstanding and refunds-due apart.
--
-- A CONSEQUENCE, STATED PLAINLY: because this is a guest-level receivable, a
-- deposit taken for a FUTURE stay counts against that guest's OLDEST unpaid stay
-- first. The per-booking folio still shows the deposit on the stay it was taken
-- against — the two surfaces answer two different questions and agree on the
-- total. That is the intended behaviour of an AR ledger, not a rounding of it.
--
-- ----------------------------------------------------------------------------
-- WHY VIEWS AND NOT FUNCTIONS (and the one thing that makes them safe)
-- ----------------------------------------------------------------------------
-- The stays surface is a LIST (rule 1b): it needs server-side .range() paging
-- with an exact count, server-side filters and ordering — all of which PostgREST
-- gives over a view and does not give cleanly over a set-returning function.
--
-- Both views compute their window functions PARTITIONED BY
-- (tenant_id, property_id, guest_id) and are always queried filtered on exactly
-- those three columns. Two properties follow, and both are load-bearing:
--   * CORRECTNESS: quals on partitioning columns are the only ones Postgres may
--     push below a WindowAgg, so the planner filters to the one guest BEFORE the
--     window runs rather than computing folio_totals for every booking the
--     caller can see. Filtering on anything else (status, dates) is still
--     correct but is applied AFTER the window — which is precisely what we want
--     for the allocation: FIFO is a property of the guest's whole account, so
--     paging or filtering the stays list must never change how a payment was
--     allocated.
--   * ORDER: the allocation depends on the stay order (check_in, then
--     booking_number as a stable unique tiebreak), never on the caller's
--     .order() — so sorting the table by any column leaves every figure intact.
--
-- SECURITY: security_invoker = on, exactly as 022. Without it a view runs with
-- its OWNER's rights and becomes a hole straight through RLS; with it, bookings
-- / folios / folio_payments / guests policies apply as the CALLER. Neither view
-- is granted to anon — what a guest owes is private financial data.
-- ============================================================================


-- ############################################################################
-- SECTION 1 — guests.preferences
-- ############################################################################
-- Free text, captured and displayed, read by no logic: "top floor, quiet room,
-- early breakfast". Master data on the guest (tenant-scoped, shared across the
-- tenant's properties), so it needs no policy of its own — the 014 member-select
-- and admin-update policies already cover every column of the row, which is also
-- why it is editable through the same direct-update path guest corrections use.
-- SENSITIVE-ADJACENT: like every other guests column it must never reach a
-- public/anon policy (see 014's privacy note).
alter table guests
  add column if not exists preferences text;

comment on column guests.preferences is
  'Free-text stay preferences ("top floor, quiet room, early breakfast"). '
  'Captured and displayed only — no logic reads it. Editable by owner/manager '
  'through the same guests_member_update policy as other guest corrections. '
  'Never exposed by a public/anon policy (see 014).';


-- ############################################################################
-- SECTION 2 — index for the guest surfaces
-- ############################################################################
-- Both views start from "this guest's stays at this property, oldest first",
-- which is exactly this index. bookings_guest_id_idx (015) covers guest_id
-- alone; this covers the whole predicate plus the FIFO ordering.
create index if not exists bookings_guest_property_checkin_idx
  on bookings (guest_id, property_id, check_in);


-- ############################################################################
-- SECTION 3 — guest_stays: one row per stay, with the FIFO settlement
-- ############################################################################
-- Feeds the guest's stays table AND its history summary. Carries three distinct
-- money facts per stay, deliberately NOT merged, because they answer three
-- different questions:
--
--   charges_total / payments_total / balance
--       THE STAY'S OWN FOLIO, straight from folio_totals — identical to what the
--       booking's Folio tab shows. `balance` is what the stays table's Balance
--       column prints.
--   allocated_amount / unallocated_amount / settlement_status
--       THE GUEST-LEVEL FIFO view of the same stay: how much of the guest's
--       whole payment pool this stay has absorbed, oldest-first.
--   charges_before / guest_charges_total / guest_payments_pool
--       THE WORKING, exposed on purpose so the allocation can be checked by hand
--       from the row itself rather than trusted.
--
-- The two can legitimately disagree per stay — an old stay can read "settled"
-- under FIFO while its own folio still shows a balance, because the money that
-- settled it was taken against a later stay. They can NEVER disagree in total
-- (invariant 1). The UI says so beside the columns.
--
-- SOFT-DELETED BOOKINGS ARE FILTERED HERE, unlike booking_balances (022) which
-- exposes deleted_at for the caller to filter. That difference is forced and is
-- not an inconsistency: the FIFO window runs INSIDE the view, so a deleted stay
-- left in would consume part of the pool and shift every later allocation, and a
-- caller's after-the-fact filter could not undo it. A view that computes an
-- aggregate must own the row set that aggregate is over.
--
-- room_types is LEFT JOINed and deliberately NOT filtered by deleted_at — the
-- same inverted rule as 021 §8.1's charge categories: a retired room type must
-- still name the stays that were booked into it, or last year's history reprints
-- with a blank column. LEFT so a stay never vanishes from a financial view
-- because of a missing label.
--
-- CANCELLED AND FUTURE STAYS ARE INCLUDED, at ₦0.00 where nothing has been
-- billed. Excluding them would make "every stay in the history appears in the
-- ledger" false, and a cancelled booking carrying a cancellation or no-show
-- charge (024) is exactly a row the owner must see.
create or replace view guest_stays
with (security_invoker = on) as
with stay as (
  select
    b.id                              as booking_id,
    b.guest_id,
    b.tenant_id,
    b.property_id,
    b.booking_number,
    b.check_in,
    b.check_out,
    (b.check_out - b.check_in)::int   as nights,
    b.status,
    b.room_type_id,
    rt.name                           as room_type_name,
    f.id                              as folio_id,
    f.status                          as folio_status,
    tot.charges_total,
    tot.payments_total,
    tot.balance
  from bookings b
  -- INNER on folios, as booking_balances (022) is and for the same reason: every
  -- booking has a folio by trigger, so if that invariant ever broke the stay
  -- would go MISSING (loud) rather than read as nothing owed (quiet, and wrong).
  join folios f            on f.booking_id = b.id
  left join room_types rt  on rt.id = b.room_type_id
  cross join lateral folio_totals(f.id) tot
  where b.deleted_at is null                                     -- rule 5
),
pooled as (
  select
    s.*,
    -- The guest's whole payment pool at this property: Σ payments_total, which is
    -- itself Σ of every NON-VOIDED payment (folio_totals applies `is_voided is
    -- not true`, rule 5). Refunds are negative payments and correctly reduce it.
    sum(s.payments_total) over w_guest              as guest_payments_pool,
    sum(s.charges_total)  over w_guest              as guest_charges_total,
    -- Charges of every OLDER stay. The FIFO frontier.
    coalesce(sum(s.charges_total) over w_older, 0)  as charges_before
  from stay s
  window
    w_guest as (partition by s.tenant_id, s.property_id, s.guest_id),
    -- booking_number is unique per tenant per document type, so this ordering is
    -- total and the allocation is deterministic for same-day arrivals.
    w_older as (
      partition by s.tenant_id, s.property_id, s.guest_id
      order by s.check_in, s.booking_number
      rows between unbounded preceding and 1 preceding
    )
),
allocated as (
  select
    p.*,
    -- clamp(pool − before, 0, charges) — see the header. greatest() first so a
    -- guest who has paid nothing (or is in net refund) allocates 0, never a
    -- negative; least() so a stay can never absorb more than it was charged.
    greatest(
      0::numeric,
      least(p.charges_total, p.guest_payments_pool - p.charges_before)
    )::numeric(14,2) as allocated_amount
  from pooled p
)
select
  a.booking_id,
  a.guest_id,
  a.tenant_id,
  a.property_id,
  a.booking_number,
  a.check_in,
  a.check_out,
  a.nights,
  a.status,
  a.room_type_id,
  a.room_type_name,
  a.folio_id,
  a.folio_status,
  -- This stay's own folio (unchanged, authoritative for the per-booking view).
  a.charges_total,
  a.payments_total,
  a.balance,
  -- The guest-level working.
  a.guest_charges_total,
  a.guest_payments_pool,
  a.charges_before,
  -- The FIFO result.
  a.allocated_amount,
  (a.charges_total - a.allocated_amount)::numeric(14,2) as unallocated_amount,
  case
    -- Nothing billed yet (a future or cancelled stay): neither paid nor owing.
    when a.charges_total <= 0                  then 'nil'
    when a.allocated_amount >= a.charges_total then 'settled'
    when a.allocated_amount > 0                then 'part_paid'
    else                                            'unpaid'
  end as settlement_status
from allocated a;

comment on view guest_stays is
  'One row per stay for a guest: the stay''s OWN folio totals (from folio_totals, '
  '021 §8.2) plus a READ-TIME FIFO settlement of the guest''s whole payment pool '
  'oldest-stay-first. Nothing is stored (rule 6); the allocation is recomputed on '
  'every read, so a charge posted or voided on an older stay re-flows it. '
  'Σ balance over a guest''s stays = their outstanding balance, whatever the '
  'allocation says per stay. Soft-deleted bookings are filtered INSIDE the view '
  'because the FIFO window would otherwise consume pool for a deleted stay. '
  'security_invoker: the caller''s RLS decides what is visible.';


-- ############################################################################
-- SECTION 4 — guest_ledger: the running statement across every stay
-- ############################################################################
-- A bank statement, chronological, one partition per guest per property:
--   a STAY line   carries that stay's total charges  (balance goes UP),
--   a PAYMENT line carries the payment               (balance goes DOWN),
--   running_balance is the cumulative charges − payments to that point.
--
-- THE RUNNING BALANCE IS COMPUTED HERE, NOT IN THE BROWSER, for the same reason
-- 022 computes the tax lines in the database: a second implementation in another
-- language drifts, and the drift is silent. The client prints these numbers.
--
-- A STAY LINE IS DATED BY check_in, not by when its charges posted. A stay is one
-- collapsed line on this statement — the per-charge detail is the stay's own bill
-- (the booking's Folio tab), which is where a reader drills to. Dating the
-- collapsed line by arrival is what makes a deposit taken three weeks earlier sit
-- correctly ABOVE the stay it was taken for.
--
-- VOIDED ROWS ARE ABSENT HERE, and that is the one place this differs from the
-- per-stay bill. A voided payment is dropped by the `is_voided is not true`
-- filter below, and a voided charge never reaches charges_total (folio_totals
-- excludes it). The audit trail for a reversal lives on the stay's own bill,
-- struck through with its reason and actor; a cross-stay statement whose running
-- balance stepped up and back down for every reversal would be unreadable, and
-- the balance would be identical either way.
create or replace view guest_ledger
with (security_invoker = on) as
with entries as (
  -- ---- one line per STAY --------------------------------------------------
  select
    b.guest_id,
    b.tenant_id,
    b.property_id,
    b.check_in                        as entry_date,
    0                                 as entry_rank,   -- stays before payments
    b.created_at                      as entry_created_at,
    'stay'::text                      as entry_type,
    b.id                              as booking_id,
    null::uuid                        as payment_id,
    b.booking_number,
    b.status                          as booking_status,
    rt.name                           as room_type_name,
    (b.check_out - b.check_in)::int   as nights,
    tot.charges_total                 as charge_amount,
    0::numeric(14,2)                  as payment_amount,
    null::text                        as payment_method,
    null::text                        as payment_reference,
    null::uuid                        as received_by
  from bookings b
  join folios f            on f.booking_id = b.id
  left join room_types rt  on rt.id = b.room_type_id
  cross join lateral folio_totals(f.id) tot
  where b.deleted_at is null                                     -- rule 5

  union all

  -- ---- one line per PAYMENT ----------------------------------------------
  select
    b.guest_id,
    p.tenant_id,
    p.property_id,
    p.payment_date                    as entry_date,   -- BUSINESS date (rules 8, 12)
    1                                 as entry_rank,
    p.created_at                      as entry_created_at,
    'payment'::text                   as entry_type,
    b.id                              as booking_id,   -- the stay it was taken on
    p.id                              as payment_id,
    b.booking_number,
    b.status                          as booking_status,
    rt.name                           as room_type_name,
    null::int                         as nights,
    0::numeric(14,2)                  as charge_amount,
    p.amount                          as payment_amount,
    p.method                          as payment_method,
    p.reference                       as payment_reference,
    p.received_by
  from folio_payments p
  join folios f            on f.id = p.folio_id
  join bookings b          on b.id = f.booking_id
  left join room_types rt  on rt.id = b.room_type_id
  where p.is_voided is not true                                  -- rule 5
    and b.deleted_at is null                                     -- rule 5
)
select
  e.*,
  -- The statement's running balance. Ordered by BUSINESS date (rules 8, 12) with
  -- a total tiebreak (rank, then the posting instant, then the row's own id) so
  -- two entries on one day always stack in the same order — a statement whose
  -- lines reshuffled between reads would be worthless.
  sum(e.charge_amount - e.payment_amount) over (
    partition by e.tenant_id, e.property_id, e.guest_id
    order by e.entry_date, e.entry_rank, e.entry_created_at, e.booking_id, e.payment_id
    rows between unbounded preceding and current row
  )::numeric(14,2) as running_balance
from entries e;

comment on view guest_ledger is
  'A guest''s stays and payments across every folio at one property as ONE '
  'chronological running statement: a stay line adds its folio''s charges_total, '
  'a payment line subtracts the payment, running_balance is the cumulative '
  'difference. Business-date ordered (rules 8, 12). Voided payments and voided '
  'charges are excluded (rule 5) — the reversal audit trail lives on the stay''s '
  'own bill. The final running_balance equals Σ folio_totals.balance over the '
  'guest''s stays, which is the reconciles-to invariant (rule 9). Nothing is '
  'cached (rule 6). security_invoker: the caller''s RLS decides what is visible.';


-- ############################################################################
-- SECTION 5 — Grants
-- ############################################################################
-- Authenticated staff, SELECT only, NEVER anon — identical to 022 and for the
-- same reason: a guest's account is private financial data and the storefront has
-- no business reading it. The revoke from `authenticated` before each grant is
-- load-bearing, not redundant: Supabase's default privileges grant ALL on every
-- new relation in `public` to `authenticated`, so a bare `grant select` would
-- leave INSERT/UPDATE/DELETE in place.
revoke all on guest_stays from public;
revoke all on guest_stays from anon;
revoke all on guest_stays from authenticated;
grant select on guest_stays to authenticated;

revoke all on guest_ledger from public;
revoke all on guest_ledger from anon;
revoke all on guest_ledger from authenticated;
grant select on guest_ledger to authenticated;

-- ============================================================================
-- End of 027_guest_ledger.sql
-- ============================================================================
