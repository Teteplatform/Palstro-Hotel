-- ============================================================================
-- 028_guest_home_and_standalone_folio.sql
-- Palstro-Hotels: (PART 1) ACTUAL nights on every guest surface, and
--                 (PART 2) the STANDALONE (non-resident) guest folio.
--
-- ----------------------------------------------------------------------------
-- WHAT IS NOT TOUCHED, AND WHY THAT IS THE POINT
-- ----------------------------------------------------------------------------
-- folio_totals, folio_charge_tax, folio_balance, post_charge, post_room_night_
-- charge, record_payment, apply_charge_discount, void_charge, void_payment,
-- check_in_booking, check_out_booking, run_night_audit, mark_no_show,
-- cancel_booking and create_booking are BYTE-FOR-BYTE as 015/016/021/023/024/
-- 025/026 left them. Not one money computation changes.
--
-- What DOES change is the READ side and ONE structural fact about folios:
--   §1  folios gains guest_id and a nullable booking_id, so a folio can belong
--       to a GUEST rather than to a stay (the walk-in / non-resident folio).
--   §2  open_guest_folio: the get-or-create RPC for that folio.
--   §3  guest_folios      — folio -> (tenant, property, guest), one place.
--   §4  guest_payment_pools — the guest's whole payment pool, one place.
--   §5  guest_account_items — the FIFO ledger of chargeable ITEMS, with ACTUAL
--                             nights on the stay items.
--   §6  guest_stays        — rebuilt: the stay items, projected.
--   §7  guest_account_summary — the guest home's six tiles (rule 20).
--   §8  guest_ledger      — rebuilt: stays, payments AND standalone lines.
--
-- The brief says "do NOT change guest_ledger / guest_stays / the FIFO
-- allocation". Those two views ARE rebuilt here, and the tension is resolved
-- rather than ignored, because the same brief requires two things the 027 views
-- structurally cannot do:
--   * "if a view needs a computed actual_nights column to state it truthfully,
--     add it to the view" — 027's `nights` is check_out − check_in, i.e. the
--     RESERVED count, which is the display bug PART 1 exists to fix;
--   * "[a standalone item] must reconcile into the same guest outstanding
--     balance and FIFO pool" — 027's views start FROM bookings, so a folio with
--     no booking is invisible to both, and the guest's balance would silently
--     exclude it.
-- So: the FIFO ARITHMETIC is unchanged, character for character —
--     allocated(i) = clamp(pool − before(i), 0, charges(i))
-- and only the ROW SET it runs over is widened to include standalone charges.
-- Every invariant 027 documents still holds, and §7 states them again.
--
-- ----------------------------------------------------------------------------
-- PART 1 — THE NIGHTS BUG, STATED EXACTLY
-- ----------------------------------------------------------------------------
-- A booking reserving 30 Jul -> 2 Aug is 3 reserved nights. If the guest
-- actually arrived on 1 Aug, the folio charges ONE night (024 §3 narrowed the
-- audit's date predicate, and 026 copied it into checkout). But every DISPLAY
-- surface still printed `check_out − check_in` = 3, so the screen said three
-- nights over a bill for one. The screen was wrong; the bill was right.
--
--   ┌────────────────────────────────────────────────────────────────────────┐
--   │  charge_from     = greatest(coalesce(actual_check_in, check_in),       │
--   │                             check_in)                                  │
--   │  reserved_nights = check_out − check_in                                │
--   │  actual_nights   = check_out − charge_from   (NULL until checked in)   │
--   │  display_nights  = coalesce(actual_nights, reserved_nights)            │
--   └────────────────────────────────────────────────────────────────────────┘
--
-- charge_from is COPIED from 024 §3 and 026 §1 character for character, and
-- must stay that way: the nights in [charge_from, check_out) are EXACTLY the
-- nights check_out_booking posts and run_night_audit charges, so the displayed
-- count and the billed count cannot disagree. That is the whole fix — not a
-- second definition of "nights" that happens to agree today.
--
-- actual_nights is NULL, not 0 and not the reserved figure, before check-in:
-- "we do not yet know when they will arrive" is the honest reading of a NULL
-- actual_check_in, and it is the same choice lib/stayNights.ts already makes on
-- the client. display_nights is what a screen prints; actual/reserved are kept
-- beside it so a dispute can be argued from what was BOOKED.
-- ============================================================================


-- ############################################################################
-- SECTION 1 — folios: a folio may belong to a GUEST instead of a STAY
-- ############################################################################
--
--   ┌──────────────────────────────────────────────────────────────────────────┐
--   │  A FOLIO HAS EXACTLY ONE OWNER: a booking (the stay folio, unchanged)    │
--   │  or a guest (the standalone / non-resident folio). Never both, never     │
--   │  neither.                                                                │
--   └──────────────────────────────────────────────────────────────────────────┘
--
-- WHY A FOLIO AT ALL, rather than a "guest charges" table: because a charge and
-- a payment already have exactly one home in this system, and post_charge /
-- record_payment already take a folio_id. Inventing a second place to hold a
-- guest's money would mean a second posting path, a second tax computation, a
-- second void path and a second balance — which is precisely the failure the
-- folio engine exists to prevent (docs/ARCHITECTURE.md, "Folio — built per
-- module, each module keeps its own idea of what the guest owes"). Giving the
-- EXISTING folio a second kind of owner costs one nullable column and changes no
-- function at all.
--
-- WHY ONE PER (TENANT, PROPERTY, GUEST) and not one per standalone item: the
-- guest's non-resident tab is a running account, exactly like a stay's. Opening
-- a folio per item would make "what does this walk-in owe" a sum across N folios
-- again, which is the question 027 was written to answer once.
--
-- WHAT THIS CANNOT BREAK, item by item:
--   * folios_booking_unique (unique (booking_id)) — Postgres treats NULLs as
--     DISTINCT in a unique index, so any number of standalone folios coexist
--     while a booking still cannot acquire a second folio.
--   * folios_booking_fk (composite FK on (booking_id, tenant_id, property_id)) —
--     MATCH SIMPLE (the default) satisfies the constraint whenever ANY
--     referencing column is NULL, so a standalone folio simply does not reference
--     a booking. Existing stay folios are unaffected.
--   * create_folio_for_booking (021 §4.1) — still inserts booking folios with
--     guest_id NULL, which passes the new CHECK. Not modified.
--   * folio_charges / folio_payments composite FKs — they bind to
--     folios (id, tenant_id, property_id), which is unchanged.
--   * folio_totals / folio_balance — they take a folio_id and know nothing about
--     what owns it. A standalone folio's totals are computed identically.
alter table folios
  add column if not exists guest_id uuid;

alter table folios
  alter column booking_id drop not null;

comment on column folios.booking_id is
  'The stay this folio belongs to. NULL on a STANDALONE (non-resident) folio, '
  'which belongs to a guest instead — see guest_id and the folios_owner_check '
  'constraint. A booking still gets exactly one folio, opened by the AFTER '
  'INSERT trigger in 021 §4.1.';

comment on column folios.guest_id is
  'The guest this folio belongs to, on a STANDALONE folio only (booking_id '
  'NULL): the walk-in / non-resident tab that holds charges and payments not '
  'tied to any stay. NULL on every stay folio, where the guest is reached '
  'through the booking. Exactly one of booking_id / guest_id is set.';

-- Exactly one owner. Written as an explicit XOR rather than two NOT NULLs so an
-- ownerless folio — which nothing could ever bill to anybody — is impossible.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'folios_owner_check'
  ) then
    alter table folios
      add constraint folios_owner_check check (
        (booking_id is not null and guest_id is null)
        or (booking_id is null and guest_id is not null)
      );
  end if;
end $$;

-- Composite FK to guests (id, tenant_id) — 014's guests_id_tenant_unique. §6's
-- composite-key rule: a standalone folio's tenant_id cannot disagree with its
-- guest's, because the pair is what is referenced. No ON DELETE clause: guests
-- are SOFT-deleted (deleted_at), so a hard delete of a guest with a live folio
-- must fail loudly rather than cascade money away.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'folios_guest_fk'
  ) then
    alter table folios
      add constraint folios_guest_fk
        foreign key (guest_id, tenant_id) references guests (id, tenant_id);
  end if;
end $$;

-- ONE standalone folio per guest per property. This partial unique index is the
-- idempotency guard for open_guest_folio (§2) — rule 3's "enforce uniqueness at
-- the DB, not in app code". It is STRONGER than an idempotency key would be: a
-- key protects one caller's retry, whereas this makes a second standalone folio
-- for the same guest impossible however it is requested.
create unique index if not exists folios_guest_standalone_uniq
  on folios (tenant_id, property_id, guest_id)
  where booking_id is null;

-- The guest surfaces all start from "this guest's folios at this property".
create index if not exists folios_guest_property_idx
  on folios (guest_id, property_id)
  where guest_id is not null;

comment on constraint folios_owner_check on folios is
  'A folio belongs to a booking (stay folio) or to a guest (standalone / '
  'non-resident folio) — exactly one, never both and never neither. An '
  'ownerless folio could be billed to nobody.';


-- ############################################################################
-- SECTION 2 — open_guest_folio: get-or-create the standalone folio
-- ############################################################################
-- folios has NO insert policy for anyone (021 §11) and that does not change, so
-- this SECURITY DEFINER RPC is the only way a standalone folio comes into being
-- — the same posture every other folio write has.
--
-- GET-OR-CREATE, NOT CREATE. The front desk does not think "open a folio"; they
-- think "charge this walk-in for the bar tab". So the UI calls this and gets the
-- guest's one standalone folio back, whether it existed a second ago or a year
-- ago. Two people doing that at once is resolved by folios_guest_standalone_uniq
-- and the unique_violation handler below, exactly as post_charge resolves its
-- own race (021 §9.1).
--
-- p_idempotency_key IS ACCEPTED (rule 2) AND DELIBERATELY NOT STORED, for the
-- same reason cancel_booking (015 §8) and void_charge (021 §9.5) do not store
-- theirs: the natural key (tenant, property, guest) is a stronger guard, and it
-- also catches a retry that arrives with a DIFFERENT key. Storing a key here
-- would actively make things worse — two different keys would then be entitled
-- to two standalone folios for one guest, which is exactly what must be
-- impossible.
--
-- IT POSTS NOTHING. Opening the folio is not a money movement; the charge or
-- payment that follows goes through post_charge / record_payment unchanged. An
-- empty standalone folio costs one row and nothing else — the same judgement
-- 021 DECISION 1 makes about opening a folio for an enquiry.
create or replace function open_guest_folio(
  p_tenant_id       uuid,
  p_property_id     uuid,
  p_guest_id        uuid,
  p_idempotency_key text default null
)
returns folios
language plpgsql
security definer
set search_path = public
as $$
declare
  v_folio folios;
  v_actor uuid := auth.uid();
begin
  -- Staff gate, identical to post_charge / record_payment: taking money from a
  -- non-resident is front-desk work, not an admin act.
  if not is_tenant_staff(p_tenant_id) then
    raise exception 'Not authorised to open a folio for this tenant'
      using errcode = 'insufficient_privilege';
  end if;

  -- The property must belong to the tenant and be live (rule 5). Checked here
  -- rather than left to the composite FKs so the desk gets a sentence instead of
  -- a raw constraint name.
  if not exists (
    select 1 from properties p
    where p.id = p_property_id
      and p.tenant_id = p_tenant_id
      and p.deleted_at is null
  ) then
    raise exception 'Property % does not belong to this tenant', p_property_id
      using errcode = 'no_data_found';
  end if;

  -- The guest must belong to the tenant and be live (rules 5, 19). A guest is
  -- TENANT-scoped (014) — shared across the tenant's properties — while their
  -- money is property-scoped, which is why the folio carries both columns.
  if not exists (
    select 1 from guests g
    where g.id = p_guest_id
      and g.tenant_id = p_tenant_id
      and g.deleted_at is null
  ) then
    raise exception 'Guest % does not belong to this tenant', p_guest_id
      using errcode = 'no_data_found';
  end if;

  -- GET.
  select * into v_folio
  from folios f
  where f.tenant_id   = p_tenant_id
    and f.property_id = p_property_id
    and f.guest_id    = p_guest_id
    and f.booking_id is null;

  if found then
    return v_folio;
  end if;

  -- CREATE. The unique index is what actually guarantees one folio; the
  -- exception block is what turns a lost race into the winner's row rather than
  -- an error the desk cannot act on (rule 2's shape, as post_charge uses it).
  begin
    insert into folios (tenant_id, property_id, booking_id, guest_id, created_by)
    values (p_tenant_id, p_property_id, null, p_guest_id, v_actor)
    returning * into v_folio;
  exception
    when unique_violation then
      select * into v_folio
      from folios f
      where f.tenant_id   = p_tenant_id
        and f.property_id = p_property_id
        and f.guest_id    = p_guest_id
        and f.booking_id is null;
      if not found then
        raise;
      end if;
  end;

  return v_folio;
end;
$$;

comment on function open_guest_folio(uuid, uuid, uuid, text) is
  'GET-OR-CREATE the guest''s ONE standalone (non-resident) folio at a property '
  '— the folio that holds charges and payments not tied to any stay. Staff-'
  'gated, SECURITY DEFINER (folios has no insert policy, 021 §11). Idempotent by '
  'the folios_guest_standalone_uniq partial unique index, which is stronger than '
  'a key: p_idempotency_key is accepted for interface consistency (rule 2) and '
  'deliberately NOT stored, because two different keys must never be entitled to '
  'two standalone folios for one guest. Posts NOTHING — the charge or payment '
  'that follows goes through post_charge / record_payment unchanged.';

revoke execute on function open_guest_folio(uuid, uuid, uuid, text) from public;
revoke execute on function open_guest_folio(uuid, uuid, uuid, text) from anon;
grant  execute on function open_guest_folio(uuid, uuid, uuid, text) to authenticated;


-- ############################################################################
-- SECTION 3 — guest_folios: folio -> (tenant, property, guest), in ONE place
-- ############################################################################
-- Every guest-level surface below needs the same mapping, and it has exactly two
-- branches:
--   a STAY folio      -> its booking's guest;
--   a STANDALONE folio -> its own guest_id.
-- Written once, here, so the pool (§4), the items (§5) and the statement (§8)
-- cannot disagree about which folios belong to a guest.
--
-- SOFT-DELETED BOOKINGS ARE EXCLUDED (rule 5), and the join is what excludes
-- them: `left join bookings ... and b.deleted_at is null` leaves b.guest_id NULL
-- for a deleted stay's folio, and the coalesce then yields NULL, which the WHERE
-- drops. That matches 027 §3's decision to filter deleted bookings INSIDE the
-- view: a deleted stay must not consume part of the FIFO pool, and a caller's
-- after-the-fact filter could not undo it.
create or replace view guest_folios
with (security_invoker = on) as
select
  f.id                              as folio_id,
  f.tenant_id,
  f.property_id,
  coalesce(b.guest_id, f.guest_id)  as guest_id,
  f.booking_id,
  (f.booking_id is null)            as is_standalone,
  f.status                          as folio_status
from folios f
left join bookings b
  on b.id = f.booking_id
 and b.deleted_at is null                                       -- rule 5
where coalesce(b.guest_id, f.guest_id) is not null;

comment on view guest_folios is
  'Maps every folio to the guest it belongs to — through its booking for a stay '
  'folio, directly for a standalone folio — so the pool, the FIFO items and the '
  'statement all resolve "whose folio is this?" the same way. Folios of '
  'soft-deleted bookings are excluded (rule 5): a deleted stay must not consume '
  'FIFO pool. security_invoker: the caller''s RLS decides what is visible.';


-- ############################################################################
-- SECTION 4 — guest_payment_pools: the guest's whole payment pool
-- ############################################################################
-- Σ every NON-VOIDED payment on ANY of the guest's folios at this property —
-- stay folios and the standalone folio together. This is the water in 027's
-- FIFO water-filling, and widening it to include standalone payments is the
-- whole of "a standalone payment reconciles into the same pool".
--
-- Refunds are negative payments (021 DECISION 3) and correctly reduce the pool
-- with no CASE expression. Voided payments are excluded by the NULL-safe
-- `is_voided is not true` (rule 5) — the same filter folio_totals applies, so
-- the pool and Σ folio_totals.payments_total are the same number by
-- construction.
create or replace view guest_payment_pools
with (security_invoker = on) as
select
  gf.tenant_id,
  gf.property_id,
  gf.guest_id,
  coalesce(sum(fp.amount), 0)::numeric(14,2) as guest_payments_pool
from guest_folios gf
left join folio_payments fp
  on fp.folio_id  = gf.folio_id
 and fp.is_voided is not true                                   -- rule 5
group by gf.tenant_id, gf.property_id, gf.guest_id;

comment on view guest_payment_pools is
  'Σ every non-voided payment across ALL of a guest''s folios at one property — '
  'their stays'' folios AND their standalone folio. The pool the read-time FIFO '
  'allocation fills from (027''s model, unchanged). Refunds are negative and '
  'reduce it. LEFT JOIN so a guest who has paid nothing still has a row, at '
  '0.00, rather than vanishing from the summary.';


-- ############################################################################
-- SECTION 5 — guest_account_items: the FIFO ledger of chargeable items
-- ############################################################################
-- ONE ROW PER THING THE GUEST CAN OWE FOR, of two kinds:
--
--   'stay'              one row per booking, carrying that stay's folio totals
--                       (from folio_totals — identical to the booking's own
--                       bill) AND the nights columns PART 1 adds;
--   'standalone_charge' one row per non-voided charge on the standalone folio,
--                       carrying its own net + tax.
--
-- WHY STANDALONE CHARGES ARE ITEMS ONE BY ONE, while a stay is collapsed to one
-- item: a stay is a bounded event with a start date, so "the stay of 1 Aug" is a
-- thing a person recognises and can drill into. A standalone charge has no such
-- container — it IS the event — and it carries its own business date, which is
-- where it must sit on the statement. Collapsing the standalone folio to a
-- single item would date the whole thing on one arbitrary day and make the
-- statement lie about when the money was owed.
--
-- THE TAX ON A STANDALONE ITEM is computed here EXACTLY as folio_totals computes
-- it (021 §8.2): round(net × rate, 2) per (charge, tax), summed. Same
-- applicability rule (the tax's applies_to × the category's flag), same
-- per-line rounding, charge_categories joined WITHOUT a deleted_at filter (021
-- §8.1's deliberately inverted rule — retiring a category must never
-- retroactively untax the charges posted against it) and tax_charges filtered
-- (a retired tax stops applying, which is what retiring a tax means). So
-- Σ standalone item amounts ≡ folio_totals(standalone folio).charges_total, to
-- the kobo, by construction rather than by review.
--
-- THE FIFO ALLOCATION IS 027's, UNCHANGED:
--     pool         = Σ every non-voided payment of this guest at this property
--     before(i)    = Σ charges of every OLDER item
--     allocated(i) = clamp(pool − before(i), 0, charges(i))
-- Only the row set widened. The ordering key is (date, kind, key): a stay is
-- dated by check_in and keyed by booking_number; a standalone charge is dated by
-- charge_date and keyed by its own id. Both keys are unique, so the order is
-- TOTAL and the allocation is deterministic — sorting or paging the stays table
-- by any column cannot change a single figure.
--
-- Stays are ordered BEFORE standalone charges on the same date (kind 0 vs 1)
-- for one reason: a stay is the reason the guest is at the hotel, and a
-- standalone item on the same day is an extra beside it. Any total order would
-- close (invariant 2 below); this one reads the way a person expects.
create or replace view guest_account_items
with (security_invoker = on) as
with stay as (
  select
    'stay'::text                      as item_kind,
    b.tenant_id,
    b.property_id,
    b.guest_id,
    b.id                              as booking_id,
    b.booking_number,
    null::uuid                        as charge_id,
    null::text                        as charge_type_name,
    null::text                        as charge_description,
    b.check_in                        as item_date,
    0                                 as item_rank,
    b.booking_number                  as item_key,
    b.check_in,
    b.check_out,
    b.actual_check_in,
    -- PART 1. COPIED CHARACTER FOR CHARACTER from run_night_audit (024 §3) and
    -- check_out_booking (026 §1). If these ever diverge, the screen and the bill
    -- diverge with them.
    greatest(coalesce(b.actual_check_in, b.check_in), b.check_in) as charge_from,
    greatest(0, (b.check_out - b.check_in))::int                  as reserved_nights,
    case
      -- NULL, not 0 and not the reserved figure: before check-in the actual
      -- arrival has not happened, and a guessed number is worse than an honest
      -- absence (the same choice lib/stayNights.ts makes).
      when b.actual_check_in is null then null
      else greatest(
             0,
             (b.check_out - greatest(coalesce(b.actual_check_in, b.check_in), b.check_in))
           )::int
    end                                                            as actual_nights,
    b.status                          as booking_status,
    b.room_type_id,
    rt.name                           as room_type_name,
    f.id                              as folio_id,
    f.status                          as folio_status,
    tot.charges_total,
    tot.payments_total,
    tot.balance,
    b.created_at                      as item_created_at
  from bookings b
  -- INNER on folios, as 022/027 are and for the same reason: every booking has a
  -- folio by trigger, so a broken invariant makes the stay go MISSING (loud)
  -- rather than read as nothing owed (quiet, and wrong).
  join folios f            on f.booking_id = b.id
  -- Deliberately NOT filtered by deleted_at: a retired room type must still name
  -- the stays booked into it (021 §8.1's inverted rule). LEFT so a stay never
  -- vanishes from a financial view because of a missing label.
  left join room_types rt  on rt.id = b.room_type_id
  cross join lateral folio_totals(f.id) tot
  where b.deleted_at is null                                     -- rule 5
),
standalone as (
  select
    'standalone_charge'::text         as item_kind,
    gf.tenant_id,
    gf.property_id,
    gf.guest_id,
    null::uuid                        as booking_id,
    null::text                        as booking_number,
    fc.id                             as charge_id,
    cc.name                           as charge_type_name,
    fc.description                    as charge_description,
    fc.charge_date                    as item_date,
    1                                 as item_rank,
    fc.id::text                       as item_key,
    null::date                        as check_in,
    null::date                        as check_out,
    null::date                        as actual_check_in,
    null::date                        as charge_from,
    null::int                         as reserved_nights,
    null::int                         as actual_nights,
    null::text                        as booking_status,
    null::uuid                        as room_type_id,
    null::text                        as room_type_name,
    gf.folio_id,
    gf.folio_status,
    -- net + its taxes: the SAME arithmetic folio_totals performs (021 §8.2).
    (fc.net_amount + coalesce(tx.tax_amount, 0))::numeric(14,2) as charges_total,
    -- A standalone CHARGE carries no payment of its own: payments live in the
    -- pool (§4) and on the statement (§8) as their own lines, never netted into
    -- an item. Stated as 0.00 rather than NULL so the columns sum cleanly.
    0::numeric(14,2)                  as payments_total,
    (fc.net_amount + coalesce(tx.tax_amount, 0))::numeric(14,2) as balance,
    fc.created_at                     as item_created_at
  from guest_folios gf
  join folio_charges fc on fc.folio_id = gf.folio_id
  join charge_categories cc on cc.id = fc.charge_category_id
  left join lateral (
    select sum(round(fc.net_amount * tc.rate, 2)) as tax_amount
    from tax_charges tc
    where tc.property_id = fc.property_id
      and tc.deleted_at is null                                  -- rule 5
      and tc.is_active = true
      and (
           (tc.applies_to = 'taxable'            and cc.is_taxable)
        or (tc.applies_to = 'service_chargeable' and cc.service_chargeable)
      )
  ) tx on true
  where gf.is_standalone
    and fc.is_voided is not true                                 -- rule 5
),
item as (
  select * from stay
  union all
  select * from standalone
),
pooled as (
  select
    i.*,
    sum(i.charges_total) over w_guest                as guest_charges_total,
    coalesce(sum(i.charges_total) over w_older, 0)   as charges_before
  from item i
  window
    w_guest as (partition by i.tenant_id, i.property_id, i.guest_id),
    w_older as (
      partition by i.tenant_id, i.property_id, i.guest_id
      order by i.item_date, i.item_rank, i.item_key
      rows between unbounded preceding and 1 preceding
    )
),
allocated as (
  -- clamp(pool − before, 0, charges) — 027's arithmetic, character for
  -- character. greatest() first so a guest who has paid nothing (or is in net
  -- refund) allocates 0, never a negative; least() so an item can never absorb
  -- more than it was charged. Computed ONCE here so the four places that read it
  -- below cannot drift into four slightly different expressions.
  select
    p.*,
    pool.guest_payments_pool,
    greatest(
      0::numeric,
      least(p.charges_total, pool.guest_payments_pool - p.charges_before)
    )::numeric(14,2) as allocated_amount
  from pooled p
  join guest_payment_pools pool
    on pool.tenant_id   = p.tenant_id
   and pool.property_id = p.property_id
   and pool.guest_id    = p.guest_id
)
select
  a.item_kind,
  a.tenant_id,
  a.property_id,
  a.guest_id,
  a.booking_id,
  a.booking_number,
  a.charge_id,
  a.charge_type_name,
  a.charge_description,
  a.item_date,
  a.item_rank,
  a.item_key,
  a.item_created_at,
  -- --- the stay's dates and nights (PART 1) ---------------------------------
  a.check_in,
  a.check_out,
  a.actual_check_in,
  a.charge_from,
  a.reserved_nights,
  a.actual_nights,
  -- WHAT EVERY SCREEN PRINTS: the actual count once the guest has arrived, the
  -- reserved count while the stay is still only a reservation.
  coalesce(a.actual_nights, a.reserved_nights) as display_nights,
  a.booking_status,
  a.room_type_id,
  a.room_type_name,
  a.folio_id,
  a.folio_status,
  -- --- the item's own money -------------------------------------------------
  a.charges_total,
  a.payments_total,
  a.balance,
  -- --- the guest-level working (exposed so the allocation is checkable) ------
  a.guest_charges_total,
  a.guest_payments_pool,
  a.charges_before,
  -- --- the FIFO result ------------------------------------------------------
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

comment on view guest_account_items is
  'One row per chargeable ITEM on a guest''s account at one property: a STAY '
  '(collapsed to its folio_totals, with PART 1''s actual/reserved/display '
  'nights) or a STANDALONE CHARGE (its own net + tax, computed exactly as '
  'folio_totals computes it). Carries 027''s read-time FIFO settlement — '
  'allocated = clamp(pool − charges_before, 0, charges) — with the arithmetic '
  'unchanged and only the row set widened so a standalone charge reconciles into '
  'the same pool. Nothing is stored (rule 6). Ordering is (item_date, item_rank, '
  'item_key) and is TOTAL, so paging or sorting a caller''s list cannot change a '
  'single allocated figure. security_invoker: the caller''s RLS decides what is '
  'visible.';


-- ############################################################################
-- SECTION 6 — guest_stays: the stay items, projected
-- ############################################################################
-- The guest home's stays TABLE (rule 1b: server-paged with an exact count). It
-- is now a projection of §5 rather than its own query, so a stay's nights, its
-- folio figures and its FIFO position are the same numbers the summary and the
-- statement use — one derivation, one answer.
--
-- DROP-then-CREATE because the column list CHANGES: 027's `nights` (the RESERVED
-- count, which is the display bug) is replaced by reserved_nights /
-- actual_nights / display_nights, and create-or-replace cannot drop a column.
drop view if exists guest_stays;

create view guest_stays
with (security_invoker = on) as
select
  i.booking_id,
  i.guest_id,
  i.tenant_id,
  i.property_id,
  i.booking_number,
  i.check_in,
  i.check_out,
  i.actual_check_in,
  -- The date the folio bills from. Exposed so the screen can SHOW it, and so the
  -- nights arithmetic can be checked by hand from the row itself.
  i.charge_from,
  i.reserved_nights,
  i.actual_nights,
  i.display_nights,
  i.booking_status as status,
  i.room_type_id,
  i.room_type_name,
  i.folio_id,
  i.folio_status,
  -- This stay's OWN folio, straight from folio_totals — identical to what the
  -- booking's own bill shows.
  i.charges_total,
  i.payments_total,
  i.balance,
  -- The guest-level working.
  i.guest_charges_total,
  i.guest_payments_pool,
  i.charges_before,
  -- The FIFO result.
  i.allocated_amount,
  i.unallocated_amount,
  i.settlement_status
from guest_account_items i
where i.item_kind = 'stay';

comment on view guest_stays is
  'One row per STAY for a guest at one property: the stay''s own folio totals '
  '(folio_totals, 021 §8.2), its guest-level FIFO settlement, and PART 1''s '
  'nights — reserved_nights (check_out − check_in), actual_nights (check_out − '
  'charge_from, NULL until checked in) and display_nights (what a screen '
  'prints). charge_from is greatest(coalesce(actual_check_in, check_in), '
  'check_in), COPIED from run_night_audit (024 §3) and check_out_booking (026 '
  '§1), so the nights displayed are exactly the nights the folio charges. A '
  'projection of guest_account_items, so it cannot disagree with the summary or '
  'the statement. Nothing is cached (rule 6).';


-- ############################################################################
-- SECTION 7 — guest_account_summary: the guest home's six tiles (rule 20)
-- ############################################################################
-- ONE ROW PER (tenant, property, guest), spanning EVERY stay and EVERY
-- standalone item — never the visible page. Rule 20 in its exact form: the
-- figures beside a list are computed server-side across the whole set, because a
-- total that changes when you click to page 2 is a wrong number presented with
-- confidence.
--
-- THE SPINE IS guest_folios, not the items. A guest whose only activity is a
-- deposit — money taken, nothing charged yet — has no items at all, and a
-- summary built from items would omit them entirely while the hotel is holding
-- their money. Starting from "every guest with a folio here" and LEFT JOINing
-- the item aggregate keeps them, at zero charges and a credit balance, which is
-- the truth.
--
-- INVARIANTS (rule 9), and they are the same three 027 documented:
--   1. guest_balance = total_charged − total_paid
--                    = Σ guest_stays.balance + Σ standalone charge balances
--                    = the LAST guest_ledger.running_balance.
--      FIFO only decides WHICH item a payment settles; it redistributes the same
--      pool and cannot change the total. So the tiles, the stays table and the
--      statement can never disagree about what is owed.
--   2. Σ allocated = least(pool, Σ charges), and the remainder above Σ charges
--      is unapplied credit — a deposit or over-payment.
--   3. outstanding and credit_balance are the two SIDES of guest_balance, never
--      netted into one word and never both non-zero. This is the one deliberate
--      change from 027's client-side summary, which accumulated per-STAY
--      positives and negatives separately and could report "owes ₦100k AND holds
--      ₦100k" for a guest whose own FIFO position is settled. At GUEST level the
--      account has one balance — that is what a guest-level receivable MEANS —
--      and it is the figure the statement's foot prints.
create or replace view guest_account_summary
with (security_invoker = on) as
with spine as (
  select distinct gf.tenant_id, gf.property_id, gf.guest_id
  from guest_folios gf
),
agg as (
  select
    i.tenant_id,
    i.property_id,
    i.guest_id,
    count(*) filter (where i.item_kind = 'stay')                as stay_count,
    count(*) filter (where i.item_kind = 'standalone_charge')   as standalone_count,
    -- PART 1's requirement, exactly: total nights is Σ ACTUAL nights, falling
    -- back to reserved for a stay that has not arrived yet.
    coalesce(sum(i.display_nights) filter (where i.item_kind = 'stay'), 0)::int
                                                                as total_nights,
    min(i.check_in) filter (where i.item_kind = 'stay')          as first_stay,
    max(i.check_in) filter (where i.item_kind = 'stay')          as last_stay,
    coalesce(sum(i.charges_total), 0)::numeric(14,2)             as total_charged
  from guest_account_items i
  group by i.tenant_id, i.property_id, i.guest_id
)
select
  s.tenant_id,
  s.property_id,
  s.guest_id,
  coalesce(a.stay_count, 0)                   as stay_count,
  coalesce(a.standalone_count, 0)             as standalone_count,
  coalesce(a.total_nights, 0)                 as total_nights,
  a.first_stay,
  a.last_stay,
  coalesce(a.total_charged, 0)::numeric(14,2) as total_charged,
  p.guest_payments_pool::numeric(14,2)        as total_paid,
  (coalesce(a.total_charged, 0) - p.guest_payments_pool)::numeric(14,2)
                                              as guest_balance,
  -- The two sides of the one balance. NOT floored away in either direction: a
  -- negative balance is money the hotel owes back, and hiding it would hide real
  -- money (021 §8.3's reasoning, rule 7's neighbourhood).
  greatest(0::numeric, coalesce(a.total_charged, 0) - p.guest_payments_pool)::numeric(14,2)
                                              as outstanding,
  greatest(0::numeric, p.guest_payments_pool - coalesce(a.total_charged, 0))::numeric(14,2)
                                              as credit_balance
from spine s
join guest_payment_pools p
  on p.tenant_id   = s.tenant_id
 and p.property_id = s.property_id
 and p.guest_id    = s.guest_id
left join agg a
  on a.tenant_id   = s.tenant_id
 and a.property_id = s.property_id
 and a.guest_id    = s.guest_id;

comment on view guest_account_summary is
  'ONE row per (tenant, property, guest): the guest home''s summary tiles — with '
  'us since, stays, NIGHTS (Σ actual nights, reserved for a stay not yet '
  'arrived), charged, paid, and the balance — computed across EVERY stay and '
  'EVERY standalone item, never a page (rule 20). INVARIANT (rule 9): '
  'guest_balance = total_charged − total_paid = Σ guest_stays.balance + Σ '
  'standalone charges = the last guest_ledger.running_balance. outstanding and '
  'credit_balance are the two sides of that one balance and are never both '
  'non-zero. Nothing is cached (rule 6).';


-- ############################################################################
-- SECTION 8 — guest_ledger: the running statement, now including standalone
-- ############################################################################
-- A bank statement, chronological, one partition per guest per property. FOUR
-- kinds of line now, where 027 had two:
--
--   'stay'                a stay collapsed to its folio's charges  (balance UP)
--   'standalone_charge'   one charge on the standalone folio       (balance UP)
--   'payment'             a payment on a stay's folio              (balance DOWN)
--   'standalone_payment'  a payment on the standalone folio        (balance DOWN)
--
-- The two standalone kinds carry is_standalone = true and a NULL booking_id, so
-- the screen can render them as their own lines ("Charge · Minibar ·
-- (standalone)") and can decline to offer a drill-in that does not exist — a
-- standalone item has no stay bill to open.
--
-- DROP-then-CREATE because the column list changes: booking_id / booking_number /
-- booking_status become NULLABLE (a standalone line has no booking), `nights` is
-- replaced by the three PART 1 columns, and entry_key is new.
--
-- entry_key IS THE ORDERING TIEBREAK, and it is what makes the sort TOTAL: it is
-- the row's own id — the payment's, the charge's, or the stay's booking id —
-- every one of them a distinct uuid. 027 tiebroke on (booking_id, payment_id),
-- which cannot separate two standalone charges. A statement whose lines
-- reshuffled between reads would be worthless, and its running balance column
-- would not add up, so the client orders by EXACTLY (entry_date, entry_rank,
-- entry_created_at, entry_key) — the same four the window below uses.
--
-- VOIDED ROWS ARE ABSENT (unchanged from 027): a voided payment is dropped by
-- the NULL-safe filter, and a voided charge never reaches charges_total. The
-- reversal audit trail lives on the stay's own bill, struck through with its
-- reason and actor.
drop view if exists guest_ledger;

create view guest_ledger
with (security_invoker = on) as
with entries as (
  -- ---- one line per STAY --------------------------------------------------
  -- Dated by check_in, not by when its charges posted: that is what makes a
  -- deposit taken three weeks earlier sit correctly ABOVE the stay it was taken
  -- for. Nights come from guest_account_items, so the statement prints the same
  -- ACTUAL count the stays table and the folio do (PART 1).
  select
    i.guest_id,
    i.tenant_id,
    i.property_id,
    i.check_in                        as entry_date,
    0                                 as entry_rank,   -- charges before payments
    i.item_created_at                 as entry_created_at,
    i.booking_id::text                as entry_key,
    'stay'::text                      as entry_type,
    false                             as is_standalone,
    i.booking_id,
    null::uuid                        as payment_id,
    null::uuid                        as charge_id,
    i.booking_number,
    i.booking_status,
    i.room_type_name,
    null::text                        as charge_type_name,
    null::text                        as charge_description,
    i.reserved_nights,
    i.actual_nights,
    i.display_nights,
    i.charges_total                   as charge_amount,
    0::numeric(14,2)                  as payment_amount,
    null::text                        as payment_method,
    null::text                        as payment_reference,
    null::uuid                        as received_by
  from guest_account_items i
  where i.item_kind = 'stay'

  union all

  -- ---- one line per STANDALONE CHARGE -------------------------------------
  select
    i.guest_id,
    i.tenant_id,
    i.property_id,
    i.item_date                       as entry_date,   -- the charge's BUSINESS date
    0                                 as entry_rank,
    i.item_created_at                 as entry_created_at,
    i.charge_id::text                 as entry_key,
    'standalone_charge'::text         as entry_type,
    true                              as is_standalone,
    null::uuid                        as booking_id,
    null::uuid                        as payment_id,
    i.charge_id,
    null::text                        as booking_number,
    null::text                        as booking_status,
    null::text                        as room_type_name,
    i.charge_type_name,
    i.charge_description,
    null::int                         as reserved_nights,
    null::int                         as actual_nights,
    null::int                         as display_nights,
    i.charges_total                   as charge_amount,
    0::numeric(14,2)                  as payment_amount,
    null::text                        as payment_method,
    null::text                        as payment_reference,
    null::uuid                        as received_by
  from guest_account_items i
  where i.item_kind = 'standalone_charge'

  union all

  -- ---- one line per PAYMENT, on ANY of the guest's folios ------------------
  -- guest_folios is the join, so this single branch covers a payment taken
  -- against a stay AND a standalone payment; is_standalone distinguishes them
  -- and booking_number is NULL on the latter. Payments stay exactly where they
  -- were recorded (027's chosen model): nothing is re-homed, and every payment
  -- still names who took it and on which business date.
  select
    gf.guest_id,
    p.tenant_id,
    p.property_id,
    p.payment_date                    as entry_date,   -- BUSINESS date (rules 8, 12)
    1                                 as entry_rank,
    p.created_at                      as entry_created_at,
    p.id::text                        as entry_key,
    case when gf.is_standalone then 'standalone_payment' else 'payment' end,
    gf.is_standalone,
    gf.booking_id,
    p.id                              as payment_id,
    null::uuid                        as charge_id,
    b.booking_number,
    b.status                          as booking_status,
    rt.name                           as room_type_name,
    null::text                        as charge_type_name,
    null::text                        as charge_description,
    null::int                         as reserved_nights,
    null::int                         as actual_nights,
    null::int                         as display_nights,
    0::numeric(14,2)                  as charge_amount,
    p.amount                          as payment_amount,
    p.method                          as payment_method,
    p.reference                       as payment_reference,
    p.received_by
  from folio_payments p
  join guest_folios gf     on gf.folio_id = p.folio_id
  left join bookings b     on b.id = gf.booking_id
  left join room_types rt  on rt.id = b.room_type_id
  where p.is_voided is not true                                  -- rule 5
)
select
  e.*,
  -- The statement's running balance, computed HERE and not in the browser, for
  -- the reason 022 gives about tax: a second implementation in another language
  -- drifts, and the drift is silent. The client prints these numbers.
  sum(e.charge_amount - e.payment_amount) over (
    partition by e.tenant_id, e.property_id, e.guest_id
    order by e.entry_date, e.entry_rank, e.entry_created_at, e.entry_key
    rows between unbounded preceding and current row
  )::numeric(14,2) as running_balance
from entries e;

comment on view guest_ledger is
  'A guest''s whole account at one property as ONE chronological running '
  'statement: a STAY line adds its folio''s charges, a STANDALONE CHARGE line '
  'adds its own net + tax, and a PAYMENT line (on a stay''s folio or the '
  'standalone one) subtracts. Business-date ordered with entry_key — the row''s '
  'own id — as a TOTAL tiebreak, so the order is stable across reads and the '
  'running balance always adds up; a caller MUST order by (entry_date, '
  'entry_rank, entry_created_at, entry_key) to print it. Stay lines carry PART '
  '1''s actual/reserved/display nights. Voided rows are excluded (rule 5). The '
  'final running_balance equals guest_account_summary.guest_balance, which is '
  'the reconciles-to invariant (rule 9). Nothing is cached (rule 6).';


-- ############################################################################
-- SECTION 9 — Grants
-- ############################################################################
-- Authenticated staff, SELECT only, NEVER anon — identical to 022 and 027 and
-- for the same reason: what a guest owes is private financial data and the
-- storefront has no business reading it.
--
-- The `revoke all ... from authenticated` before each grant is load-bearing, not
-- redundant: Supabase's default privileges grant ALL on every new relation in
-- `public` to `authenticated`, so a bare `grant select` would leave
-- INSERT/UPDATE/DELETE in place.
--
-- guest_stays and guest_ledger were DROPPED and recreated in §6/§8, which
-- discarded 027 §5's grants; they are re-issued here.
revoke all on guest_folios from public;
revoke all on guest_folios from anon;
revoke all on guest_folios from authenticated;
grant select on guest_folios to authenticated;

revoke all on guest_payment_pools from public;
revoke all on guest_payment_pools from anon;
revoke all on guest_payment_pools from authenticated;
grant select on guest_payment_pools to authenticated;

revoke all on guest_account_items from public;
revoke all on guest_account_items from anon;
revoke all on guest_account_items from authenticated;
grant select on guest_account_items to authenticated;

revoke all on guest_stays from public;
revoke all on guest_stays from anon;
revoke all on guest_stays from authenticated;
grant select on guest_stays to authenticated;

revoke all on guest_account_summary from public;
revoke all on guest_account_summary from anon;
revoke all on guest_account_summary from authenticated;
grant select on guest_account_summary to authenticated;

revoke all on guest_ledger from public;
revoke all on guest_ledger from anon;
revoke all on guest_ledger from authenticated;
grant select on guest_ledger to authenticated;

-- ============================================================================
-- End of 028_guest_home_and_standalone_folio.sql
-- ============================================================================
