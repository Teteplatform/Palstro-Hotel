-- ============================================================================
-- 060 — A DISCOUNT IS AN EVENT, NOT A COLUMN
-- ============================================================================
-- folio_charges carries a discount as four mutable columns — discount_amount,
-- discount_reason, discount_approved_by, discount_idempotency_key — and a second
-- application overwrites all four. This file gives each application its own row
-- and leaves the columns in place as the current state.
--
-- IT IS NOT HERE BECAUSE OF THE LEDGER, although the ledger is what found it.
-- Two things are already broken, today, with nothing posting anywhere:
--
--   1. A LATE RETRY SILENTLY REVERTS A MANAGER'S DECISION. Measured on the live
--      schema before this file was written, in a rolled-back transaction:
--
--        after 500 (key K1)     discount 500.00  net 9500.00  tax 722.00
--                               reason "first, by manager A"
--        after 800 (key K2)     discount 800.00  net 9200.00  tax 699.20
--                               reason "second, by manager B"
--        after K1 REDELIVERED   discount 500.00  net 9500.00  tax 722.00
--                               reason "first, by manager A"
--
--      The idempotency check reads ONE column, so it can only recognise the
--      MOST RECENT key. A network retry of the first application arriving after
--      the second has landed matches nothing, is treated as new, and re-applies
--      — putting the discount back to 500, restating the tax from 699.20 to
--      722.00, and writing the earlier reason back over the later one. Nothing
--      errors. The bill is simply wrong, by a manager's decision.
--
--   2. WHO APPROVED IT IS ANSWERABLE FOR ONLY THE LATEST ONE. §6 is explicit
--      that "who did this" must be answerable for every row, because the
--      customer's primary pain is staff theft. On a twice-discounted charge the
--      first approver is gone from the charge and survives only in change_log,
--      which is an audit log and not a record anything reads. A discount is the
--      single most theft-adjacent act the front desk can perform, and it is the
--      one whose authorisation we were keeping least carefully.
--
-- ----------------------------------------------------------------------------
-- WHAT THE TABLE IS, AND EXACTLY WHAT IT IS NOT
-- ----------------------------------------------------------------------------
-- folio_charge_discounts is the history of APPLICATIONS OF
-- apply_charge_discount. That is a narrower thing than "every charge with a
-- discount", and the difference is load-bearing, because the natural-sounding
-- invariant is wrong:
--
--   * A REVERSAL COUNTER CHARGE CARRIES A DISCOUNT AND HAS NO APPLICATION. 032's
--     post_charge_reversal inserts the counter with p_discount already set — a
--     charge reversal mirrors the original's discount as a negative, and a
--     DISCOUNT reversal is gross 0 with discount -X. Nobody applied those; they
--     are part of the insert. Giving them rows would invent an approval that
--     never happened and name no approver. So every statement in this file is
--     scoped to `reversal_of_charge_id is null`, and the assertions are too.
--
--   * reverse_discount DOES NOT TOUCH THE ORIGINAL ROW. It posts a counter and
--     leaves the discount where it is — its own comment says so: "The original
--     row is not touched: it keeps its discount." So a reversed discount is not
--     an application either, and the original's history ends at the last real
--     application. (This was checked by reading the function, not by pattern-
--     matching its source: a grep for `discount_amount = 0` matched
--     `coalesce(v_charge.discount_amount, 0)` and said it zeroed the column,
--     which it does not. A pattern that matches the right characters in the
--     wrong place is a lie in the alarming direction — §7.13.)
--
-- apply_charge_discount is therefore the ONLY writer of discount_amount by
-- UPDATE in the whole schema, and the table's scope is exactly its calls.
--
-- ----------------------------------------------------------------------------
-- THE COLUMNS STAY, AND SOMETHING CHECKS THEY AGREE
-- ----------------------------------------------------------------------------
-- discount_amount and friends remain the current state, so no reader changes —
-- folio_totals, the bill, the guest's copy and the discount screens all keep
-- working untouched. The rows are the history.
--
-- TWO PLACES HOLDING ONE FACT IS ONLY SAFE WHILE SOMETHING CHECKS THEY MATCH,
-- and nothing checks what nobody asserts. So the invariant is stated, and it is
-- an IF AND ONLY IF rather than one direction:
--
--   INVARIANT, for every charge with reversal_of_charge_id is null:
--     it has folio_charge_discounts rows  <=>  discount_amount <> 0
--     and when it has them, the HIGHEST-seq row's new_amount = discount_amount.
--
-- "HIGHEST seq", not "latest created_at", and the proof is what insisted on it.
-- With created_at as the ordering key every assertion about the chain read the
-- WRONG ROW — "the newest application" came back as the first one. now() is the
-- TRANSACTION START TIME, so applications written in one transaction tie and the
-- order falls through to a random uuid. 036 had already paid for this on
-- stock_movements.seq, for the same reason and in almost the same words, which
-- is why this table carries an identity column and why nothing here orders by
-- created_at. 1.1h4 reads previous_amount off a specific row to post a delta;
-- an unstable order there would post the wrong delta with nothing erroring.
--
-- Both halves are structural rather than hopeful. post_charge inserts
-- discount_amount 0 and nothing else inserts a non-counter charge, so a
-- non-counter charge can only become discounted through the RPC that now writes
-- a row. And apply_charge_discount refuses an amount that is not > 0, so a
-- charge with history always carries a non-zero discount — which is why the
-- reverse direction can be asserted at all rather than merely hoped for.
--
-- ----------------------------------------------------------------------------
-- THE WIRING LEANS ON THIS ROW, AND COULD NOT LEAN ON THE CHARGE
-- ----------------------------------------------------------------------------
-- 1.1h4's post_folio_discount_journal keys its entry on THIS ROW'S id:
--
--     source_document_type = 'folio_discount'
--     source_document_id   = folio_charge_discounts.id
--
-- Keying on the CHARGE cannot work, and the way it fails is silent.
-- journal_entries carries `unique (tenant_id, source_document_type,
-- source_document_id)` and post_journal returns the existing entry when the pair
-- is already present. So a charge keyed discount posts ONCE: the first
-- application books its entry, the second application is handed the first
-- entry back, and its delta never reaches the books. On the worked example
-- above that is 300 naira of discount that the bill shows and the ledger has
-- never heard of — and the guest ledger would then disagree with the sum of
-- folio balances by exactly that, which is the one thing 1.1h4's invariant
-- exists to catch. It would be caught. It should never have been possible.
--
-- The row makes the stock pattern transfer whole: one entry per row,
-- post_folio_discount_journal(id) beside post_folio_charge_journal(id) and
-- post_folio_payment_journal(id), exactly as 046 does with
-- post_stock_movement_journal.
--
-- TWO THINGS 1.1h4 INHERITS FROM HERE RATHER THAN REDISCOVERING:
--
--   * A ZERO DELTA POSTS NOTHING, AND THE HELPER MUST SKIP IT. The guards allow
--     the same amount to be applied twice (a re-approval by a different manager,
--     with a different reason, is a real event and is kept), so delta_amount can
--     be 0.00. post_journal does NOT quietly ignore that: it RAISES, because the
--     line left to balance works out at zero and "works out at 0.00, which is
--     not a posting" is its own refusal. So the skip belongs in the helper, not
--     in post_journal and not in a tolerance.
--
--   * THE TAX DELTA IS COMPUTED, AND EVERY INPUT IS A CAPTURED FACT. The entry
--     needs one tax leg per tax ACCOUNT (059), so a single stored tax total
--     would not do — it would collapse VAT and service charge into one leg. It
--     does not need storing either. For each of the charge's captured tax rows:
--
--       leg = round((gross - new_amount) * rate, 2)
--           - round((gross - previous_amount) * rate, 2)
--
--     gross and rate come off captured rows (058, 059), previous_amount and
--     new_amount off this one, and nothing is looked up live. It is the SAME
--     expression restate_charge_taxes uses, so the two cannot disagree. The one
--     thing it rests on is that an application does not change WHICH taxes apply
--     or at WHAT rate — true because restate_charge_taxes passes the charge as
--     its own source — and that is asserted in SECTION 4 rather than assumed.
--     (The alternative was a child table storing previous and new per tax. It is
--     the more literal capture and it was not chosen: the figures are a delta
--     between two states both already captured, and §6 forbids the cheap version
--     of storing them — money never goes in JSONB.)
--
-- ----------------------------------------------------------------------------
-- THE BACKFILL, AND THE GUARD IT NEEDS
-- ----------------------------------------------------------------------------
-- The backfill writes one row per currently-discounted non-counter charge, with
-- previous_amount 0 and new_amount the column's value. That is only the true
-- history while no charge has been discounted MORE THAN ONCE — so change_log is
-- asked, exactly as 058's and 059's backfills ask it, and it refuses rather than
-- assumes. A charge discounted twice has a reconstructable history, but
-- reconstructing it is a decision about which approvals and reasons to attach to
-- which amount, and a migration must not make that decision quietly.
--
-- ASKED OF THE LIVE DATABASE BEFORE WRITING THIS. Two charges have ever had
-- discount_amount updated, each exactly once:
--
--     46c787ce…   0.00 -> 20000.00   30 Jul 2026
--     e614b5a7…   0.00 ->   200.00   03 Aug 2026
--
-- so the guard passes and the backfill is a default rather than a decision.
--
-- THE GUARD IS SCOPED TO CHARGES THAT STILL EXIST, and that is not tidiness.
-- 46c787ce is not in folio_charges — it was hard-deleted during early
-- development, and change_log keeps its row_id with no row behind it. An
-- unscoped guard counts orphans like that forever, and a guard that counts
-- something nobody can act on is 059 §5's defect arriving one shipment later: it
-- cannot pass, so somebody adds the exception that gets past it, and the
-- exception is what ships. The backfill writes rows for charges that exist, so
-- the guard asks about charges that exist.
--
-- WHAT IT DOES WITH THE AWKWARD ROWS, stated rather than implied:
--   * A COUNTER CHARGE gets no row, for the reason above. Live: one, the laundry
--     counter carrying discount -200.00.
--   * A VOIDED non-counter charge with a discount DOES get its row. It was
--     discounted and then voided; both happened, and the void is a separate act
--     with its own record.
--   * A CHARGE WITH NO DISCOUNT gets no row, and the invariant's reverse
--     direction is what makes "no rows" mean "never discounted" rather than
--     "not backfilled".
--
-- ----------------------------------------------------------------------------
-- WHAT THE BREAKAGES WENT RED FOR (rule 27)
-- ----------------------------------------------------------------------------
-- Seventeen mutations. SIXTEEN red, and the one that stayed green is the most
-- interesting result in the file:
--
-- A NOTE ON A AND A2's ANCHORS, because it is the second time a proof needed
-- repair rather than the code: adding the key-ownership check moved the text
-- those two mutations matched, and A came back SKIPPED while A2 silently
-- degenerated into L — it dropped the index, went red on assertion 9, and
-- looked like a pass. A SKIP IS NOT A PASS, and a red for the wrong reason is
-- worse than either. Both now anchor on the SELECT alone, which is the part
-- they are actually about.
--
--   A   the idempotency FAST PATH reads the charge's column again
--         -> GREEN, AND THAT IS CORRECT. See below.
--   A2  the fast path reverted AND the unique index dropped
--         -> 1: the charge reads 500.00 not 800.00; the tax reads 722.00 not
--            699.20; the later reason is gone. THE DEFECT, reproduced.
--   B   previous_amount written as a constant 0
--         -> 2: previous=0.00 delta=800.00 on the second application
--   C   v_prev read AFTER the update instead of before
--         -> 2: previous=800.00 new=800.00 delta=0.00 — every delta zero
--   D   the generated delta reversed (previous - new)
--         -> 2: delta=-300.00 where +300.00 is owed. ONLY THE SIGN MOVES, which
--            no magnitude or total would have noticed
--   E   the latest-application reads ordered seq ASC
--         -> 2: "the newest application" is the first one
--   E2  seq stops being an identity column
--         -> 2: same symptom, from the other direction — no total order at all
--   F   the insert omits approved_by
--         -> 23502, NOT NULL. An application with no authorisation cannot exist
--   H   the backfill dropped
--         -> 5: 1 of 2 non-counter charges disagrees with its history
--   I   the backfill stops excluding reversal counters
--         -> 6: a counter was given an application naming an approver nobody
--            appointed, for an act that never happened
--   J   a second discount_amount change is on record when the backfill runs
--         -> PT409 naming the charge and the count
--   K   a discounted charge names no approver
--         -> PT422 refusing rather than coalescing one in
--   L   the per-application unique index dropped
--         -> 9: a duplicate key was accepted
--   M   a write policy added to the history table
--         -> 9: a client could author a discount's audit trail
--   N   the "greater than zero" refusal deleted
--         -> 8: refused by 23514 on folio_charge_discounts_new_check instead of
--            by its own message. The assertion READS THE SQLSTATE AND THE
--            MESSAGE (059's lesson, rule 27's fifth shape), so "something
--            raised" was not accepted — and the table turns out to be a second
--            floor under that rule too
--   O   SECURITY DEFINER removed
--         -> 9
--   P   the key-ownership check dropped from both replay paths
--         -> 11: charge A is returned for a discount asked of charge B, with no
--            error at all. The only breakage here whose green reading is a
--            SUCCESS rather than a wrong number
--
-- WHY A IS GREEN, AND WHY THAT IS THE RIGHT ANSWER. Reverting the lookup alone
-- does not reintroduce the defect, because the unique index on
-- (tenant_id, idempotency_key) catches the redelivery: the INSERT violates it,
-- the handler finds the earlier application, the block rolls back, and the
-- caller is handed the charge as it stands. The index is the FLOOR and the
-- lookup is the INTERFACE — rule 3's own words, arrived at from the other
-- direction. So no single mutation can turn assertion 1 red, and A2 exists to
-- prove the pair: remove both and the 800 goes back to 500.
--
-- That is worth writing down rather than quietly deleting a green line. A
-- breakage that stays green has told you something; here it said the guard is
-- doubled, which nobody had established.
--
-- WHAT NO BREAKAGE HERE CAN SHOW, said plainly: this tenant has ONE active
-- owner/manager, so every application resolves the same approved_by and no
-- fixture can tell a per-application approver from a copy of the charge's
-- column. F proves the column cannot be empty; assertion 1 proves the per-
-- application REASON survives, which travels the same path. Closing the gap
-- properly needs a second user, which means inserting into auth.users, and that
-- is not a trade a migration should make.
--
-- ----------------------------------------------------------------------------
-- WHAT THIS FILE DELIBERATELY DOES NOT DO
-- ----------------------------------------------------------------------------
--   * It posts nothing. post_folio_discount_journal is 1.1h4's.
--   * It does not change what the front desk may do. Every guard in
--     apply_charge_discount is carried through unchanged and asserted by name:
--     the threshold, the comp rule, the PIN, the three reversal guards, the
--     folio status, the amount range and the reason. The only behaviour that
--     changes is the one that was wrong.
--   * It does not remove folio_charges.discount_idempotency_key or its unique
--     index. The column stays as current state (above), and its index is a
--     weaker form of the new one — it can only see the latest key — so it never
--     contradicts the real guard and costs nothing to keep.
--   * It does not touch reverse_discount. A reversal is not an application.
--
-- RE-RUNNABLE. Applying this file twice is a clean no-op: the table is
-- `if not exists`, the backfill is `where not exists`, the function is
-- `create or replace`, and the verify block rolls its own fixture back.
-- ============================================================================


-- ############################################################################
-- SECTION 1 — folio_charge_discounts
-- ############################################################################
create table if not exists folio_charge_discounts (
  id               uuid primary key default gen_random_uuid(),

  tenant_id        uuid not null,
  property_id      uuid not null,
  folio_charge_id  uuid not null,

  -- REAL INSERTION ORDER, and the only thing that can give it. 036 already paid
  -- for this lesson on stock_movements.seq and its comment says why: created_at
  -- cannot order rows written in the same transaction, because now() is the
  -- TRANSACTION START TIME — they tie, and the order falls through to a random
  -- uuid. This file's own proof caught it: with created_at as the key, "the
  -- newest application" came back as the FIRST one, and every assertion about
  -- the chain read the wrong row.
  --
  -- It is not a cosmetic ordering. "The newest application agrees with the
  -- column" is this table's invariant, and 1.1h4 reads the previous amount off
  -- a specific row to post a delta. Both need a TOTAL order that is stable
  -- across reads. Every query that wants the latest application orders by
  -- seq desc, never by created_at.
  seq              bigint generated always as identity,

  -- THE TWO STATES, BOTH STORED. previous_amount is what makes this a delta
  -- rather than a snapshot, and it cannot be recovered from anywhere else once
  -- the next application has overwritten the column.
  previous_amount  numeric(14,2) not null
                     constraint folio_charge_discounts_previous_check
                     check (previous_amount >= 0),

  -- > 0 BECAUSE THE RPC REFUSES ANYTHING ELSE ("A discount must be greater than
  -- zero"), and that is what makes the invariant's reverse direction assertable:
  -- a charge with rows always carries a non-zero discount, so "no rows" means
  -- "never discounted" rather than "not backfilled".
  new_amount       numeric(14,2) not null
                     constraint folio_charge_discounts_new_check
                     check (new_amount > 0),

  -- GENERATED, not written. The delta is what the ledger posts, so it must be
  -- readable as a column — and a stored copy of an arithmetic fact is a cache
  -- under rule 6 unless the database itself computes it, which is exactly what
  -- GENERATED means: it cannot drift, and there is nothing to recompute.
  --
  -- SIGNED. Reducing a discount from 800 to 500 is a legitimate application and
  -- its delta is -300.00; the ledger posts it on the other side without a CASE,
  -- the same reasoning folio_payments and 058's tax rows use.
  delta_amount     numeric(14,2)
                     generated always as (new_amount - previous_amount) stored,

  -- PER APPLICATION, which is half the reason this table exists. The column on
  -- the charge answers who approved the LATEST one and silently forgets the
  -- rest, and a discount is the most theft-adjacent act the front desk performs.
  -- NOT NULL: apply_charge_discount always resolves an approver — the verified
  -- manager above the threshold, the actor below it — so a null here would mean
  -- the resolution was skipped.
  approved_by      uuid not null references auth.users(id),
  reason           text not null
                     constraint folio_charge_discounts_reason_check
                     check (btrim(reason) <> ''),

  -- §6: the property's operating day, copied from the charge so a report can
  -- group by it without a join. A discount belongs to the day of the charge it
  -- reduces, not the day somebody got round to approving it (rules 8, 12).
  business_date    date not null,

  -- RULES 2 AND 3, AND THE WHOLE POINT. One key per APPLICATION, with the index
  -- below, instead of one column on the charge that only ever holds the latest.
  -- That column is why a redelivered first application re-applied itself.
  idempotency_key  text,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid default auth.uid() references auth.users(id),
  updated_by       uuid references auth.users(id),

  -- §6 composite key: the charge's triple, so a discount row can never disagree
  -- with its charge about tenant or property. The same FK 058's tax lines use,
  -- against folio_charges_id_scope_uniq.
  constraint folio_charge_discounts_charge_fk
    foreign key (folio_charge_id, tenant_id, property_id)
    references folio_charges (id, tenant_id, property_id) on delete cascade
);

comment on table folio_charge_discounts is
  'EVERY APPLICATION OF apply_charge_discount, one row each, insert-only. The '
  'four discount_* columns on folio_charges remain the CURRENT STATE so no '
  'reader changes; these rows are the HISTORY. Two things were broken without '
  'it, with nothing posting anywhere: a redelivered idempotency key re-applied '
  'an earlier discount — reverting the amount, restating the tax and overwriting '
  'the later reason, measured rather than reasoned — because the check read one '
  'mutable column and could only recognise the most recent key; and the approver '
  'of every application but the last was answerable only through change_log, '
  'which §6 does not accept for the most theft-adjacent act on the floor. '
  'SCOPE: applications only. A reversal counter charge carries a discount nobody '
  'applied (032 sets it in the insert) and gets no row, and reverse_discount '
  'does not touch the original, so a reversed discount is not an application '
  'either. 1.1h4 keys its discount entry on THIS row''s id; keying on the charge '
  'would post the first application and hand the first entry back to the second, '
  'silently losing its delta.';
comment on column folio_charge_discounts.previous_amount is
  'The discount as it stood before this application. The reason this is a table '
  'and not a log: once the column has been overwritten there is nowhere else '
  'this figure exists, and the ledger posts the DELTA.';
comment on column folio_charge_discounts.delta_amount is
  'What the ledger posts: new_amount - previous_amount, GENERATED so it cannot '
  'drift (and therefore not a cache under rule 6). Signed — reducing a discount '
  'is a legitimate application with a negative delta. MAY BE ZERO: the same '
  'amount re-approved with a different reason is a real event and is kept, and '
  '1.1h4''s helper must SKIP posting for it, because post_journal refuses a '
  'balancing line that works out at zero rather than ignoring it.';
comment on column folio_charge_discounts.approved_by is
  'Who authorised THIS application — the verified manager above the property''s '
  'threshold, the acting user below it. Never overwritten, which is the whole '
  'difference from folio_charges.discount_approved_by.';
comment on column folio_charge_discounts.idempotency_key is
  'Per APPLICATION (rules 2, 3), unique per tenant among non-null values. The '
  'single column on folio_charges could only match the newest key, so a retry '
  'of an earlier application looked new and re-applied it.';

-- RULE 3: the constraint, not an application-level check.
create unique index if not exists folio_charge_discounts_idem_uniq
  on folio_charge_discounts (tenant_id, idempotency_key)
  where idempotency_key is not null;

-- The history of one charge, newest first — what the invariant reads and what a
-- bill's discount trail will show.
create index if not exists folio_charge_discounts_charge_idx
  on folio_charge_discounts (folio_charge_id, seq desc);
create index if not exists folio_charge_discounts_tenant_id_idx
  on folio_charge_discounts (tenant_id);
-- "What did this property give away in October, and who approved it?"
create index if not exists folio_charge_discounts_property_date_idx
  on folio_charge_discounts (property_id, business_date, approved_by);

alter table folio_charge_discounts enable row level security;

-- READ by any member of the tenant, scoped to the active one by the app
-- (rule 19). NO WRITE POLICY, exactly as folio_charges and 058's tax lines have
-- none: these rows are written only by the SECURITY DEFINER RPC below, so there
-- is no path by which a client can author a discount's history or its approver.
drop policy if exists folio_charge_discounts_member_select on folio_charge_discounts;
create policy folio_charge_discounts_member_select on folio_charge_discounts
  for select to authenticated
  using (tenant_id = any(get_tenant_ids()));
drop policy if exists folio_charge_discounts_member_insert on folio_charge_discounts;
drop policy if exists folio_charge_discounts_member_update on folio_charge_discounts;
drop policy if exists folio_charge_discounts_member_delete on folio_charge_discounts;

-- The same trigger shape as booking_nights and folio_charge_tax_lines, its two
-- nearest neighbours: before insert or update, so an update can never rewrite
-- who created the row and updated_by stays NULL until one happens (§6).
drop trigger if exists set_row_audit_folio_charge_discounts on folio_charge_discounts;
create trigger set_row_audit_folio_charge_discounts
  before insert or update on folio_charge_discounts
  for each row execute function set_row_audit();

-- ############################################################################
-- SECTION 2 — apply_charge_discount WRITES THE APPLICATION DOWN
-- ############################################################################
-- Rebuilt from its live text. THREE changes, and every guard, threshold, PIN
-- rule and refusal is carried through untouched and asserted by name in
-- SECTION 4:
--
--   1. The idempotency check reads folio_charge_discounts instead of one mutable
--      column on the charge — the defect this file exists for.
--   2. It remembers what the discount was before overwriting it, and writes the
--      application as a row with ITS OWN approver.
--   3. The update and the insert sit in one block, so a concurrent duplicate
--      leaves nothing behind and the caller is handed the winner's view.
--
-- The four discount_* columns are still written exactly as before. They are the
-- current state; the row is the history.

CREATE OR REPLACE FUNCTION public.apply_charge_discount(p_charge_id uuid, p_discount_amount numeric, p_reason text, p_manager_pin text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS folio_charges
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_charge    folio_charges;
  v_existing  folio_charges;
  v_folio     folios;
  v_threshold numeric(14,2);
  v_manager   uuid;
  v_approver  uuid;
  v_is_comp   boolean;
  v_prev      numeric(14,2);
  v_disc_id   uuid;
  v_actor     uuid := auth.uid();
begin
  select * into v_charge from folio_charges where id = p_charge_id for update;
  if not found then
    raise exception 'Charge % not found', p_charge_id using errcode = 'no_data_found';
  end if;

  if not is_tenant_staff(v_charge.tenant_id) then
    raise exception 'Not authorised to discount charges for this tenant'
      using errcode = 'insufficient_privilege';
  end if;

  -- 060: THE IDEMPOTENCY CHECK READS EVERY APPLICATION, NOT THE LATEST ONE.
  -- It used to read folio_charges.discount_idempotency_key — ONE mutable column,
  -- which holds only the most recent key. A retry of an earlier application
  -- therefore matched nothing, was treated as new, and re-applied itself:
  -- measured on the live schema, a redelivered first key took an 800 discount
  -- back to 500, restated the tax from 699.20 to 722.00, and wrote the earlier
  -- reason over the later one. Nothing errored.
  --
  -- AND IT RETURNS THE CHARGE AS IT STANDS NOW, which is the honest answer to a
  -- replay: that application did happen, and the charge has since moved on.
  -- Returning the state it left behind would be re-applying it by another route.
  if p_idempotency_key is not null then
    select fc.* into v_existing
    from folio_charge_discounts d
    join folio_charges fc on fc.id = d.folio_charge_id
    where d.tenant_id = v_charge.tenant_id
      and d.idempotency_key = p_idempotency_key
    limit 1;
    if found then
      -- 060: AND THE KEY MUST BELONG TO THIS CHARGE. Keys are unique per
      -- TENANT, not per charge, so a client that reuses one against a DIFFERENT
      -- charge finds a real application — and without this check it is handed
      -- that other charge back as a success, which reads to the caller, and on
      -- the screen, as a discount applied to the charge it asked about. The
      -- index is the floor; this sentence is the interface. 056's GRN reversal
      -- refuses a second key on one receipt for the same reason.
      if v_existing.id <> p_charge_id then
        raise exception
          'Idempotency key % was already used to discount charge %, not charge %',
          p_idempotency_key, v_existing.id, p_charge_id
          using errcode = 'PT409',
                hint = 'A key identifies one application to one charge. Retry with the key this charge''s own call used, or use a new one.';
      end if;
      return v_existing;
    end if;
  end if;

  if v_charge.is_voided is true then
    raise exception 'Charge % is voided and cannot be discounted', p_charge_id
      using errcode = 'check_violation';
  end if;

  -- NEW (032 §7), guard 2: a counter-entry has no price to reduce.
  if v_charge.reversal_of_charge_id is not null then
    raise exception 'This line is a reversal and cannot be discounted'
      using errcode = 'check_violation';
  end if;

  -- NEW (032 §7), guards 1 and 3: a charge that has been reversed, or whose
  -- discount has been, is closed to further discounting. See the header for the
  -- ₦30,000 the first case would otherwise credit a guest.
  if exists (
    select 1 from reversals r
    where r.tenant_id = v_charge.tenant_id
      and r.target_type = 'charge'
      and r.target_id = v_charge.id
  ) then
    raise exception 'Charge % has been reversed and cannot be discounted', p_charge_id
      using errcode = 'check_violation',
            hint = 'Its counter-entry mirrors the amount as it stood. Changing the charge now would leave the two disagreeing.';
  end if;

  if exists (
    select 1 from reversals r
    where r.tenant_id = v_charge.tenant_id
      and r.target_type = 'discount'
      and r.target_id = v_charge.id
  ) then
    raise exception 'The discount on charge % has been reversed and cannot be re-applied', p_charge_id
      using errcode = 'check_violation',
            hint = 'A discount is reversed once, ever, so a new one here could never be undone. Void the charge and post it again if the price must change.';
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

  select pfs.discount_threshold into v_threshold
  from property_finance_settings pfs
  where pfs.property_id = v_charge.property_id;
  v_threshold := coalesce(v_threshold, 0);

  v_is_comp := (p_discount_amount >= v_charge.gross_amount);

  if v_is_comp or p_discount_amount > v_threshold then
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
    v_approver := v_actor;
  end if;

  -- 060: WHAT IT WAS, READ BEFORE IT IS OVERWRITTEN. v_charge was loaded FOR
  -- UPDATE at the top, so this is the pre-application figure and the only place
  -- it will ever exist once the column below is written.
  v_prev := coalesce(v_charge.discount_amount, 0);

  -- THE UPDATE AND THE HISTORY ROW ARE IN ONE BLOCK, so a concurrent duplicate
  -- that loses the race on EITHER unique index leaves nothing of this call
  -- behind. A raise inside a begin/exception block rolls that block's
  -- subtransaction back, which is exactly the wanted behaviour here: the winner
  -- owns both the column and the row, and this caller returns the winner's view.
  begin
    update folio_charges
       set discount_amount          = p_discount_amount,
           discount_reason          = btrim(p_reason),
           discount_approved_by     = v_approver,
           net_amount               = v_charge.gross_amount - p_discount_amount,
           discount_idempotency_key = p_idempotency_key,
           updated_by               = v_actor
     where id = p_charge_id
    returning * into v_charge;

    -- 060: THE APPLICATION ITSELF, as a row that nothing overwrites. Its
    -- approver is THIS application's, which the column on the charge forgets
    -- the moment a second one lands (§6: "who did this" must be answerable for
    -- every row, and a discount is the most theft-adjacent act on the floor).
    --
    -- business_date is the CHARGE's operating day, not today's: a discount
    -- belongs to the day of the charge it reduces (rules 8, 12).
    insert into folio_charge_discounts (
      tenant_id, property_id, folio_charge_id,
      previous_amount, new_amount, approved_by, reason,
      business_date, idempotency_key, created_by
    ) values (
      v_charge.tenant_id, v_charge.property_id, v_charge.id,
      v_prev, p_discount_amount, v_approver, btrim(p_reason),
      v_charge.charge_date, p_idempotency_key, v_actor
    )
    returning id into v_disc_id;
  exception
    when unique_violation then
      -- A concurrent caller won on folio_charge_discounts_idem_uniq (or on the
      -- charge's older index). Return THEIR row rather than applying twice.
      if p_idempotency_key is not null then
        select fc.* into v_existing
        from folio_charge_discounts d
        join folio_charges fc on fc.id = d.folio_charge_id
        where d.tenant_id = v_charge.tenant_id
          and d.idempotency_key = p_idempotency_key
        limit 1;
        if not found then
          -- The charge's own older index can also be the one that fired, and it
          -- sees only latest keys. Fall back to it before giving up.
          select * into v_existing
          from folio_charges
          where tenant_id = v_charge.tenant_id
            and discount_idempotency_key = p_idempotency_key
          limit 1;
        end if;
        if found then
          -- Same ownership check as the fast path, and it is NOT redundant
          -- here: the older index is on folio_charges.discount_idempotency_key,
          -- so a key already sitting in ANOTHER charge's column makes this
          -- UPDATE violate it, and the fallback then finds that other charge.
          -- Two routes to the same wrong answer, one check.
          if v_existing.id <> p_charge_id then
            raise exception
              'Idempotency key % was already used to discount charge %, not charge %',
              p_idempotency_key, v_existing.id, p_charge_id
              using errcode = 'PT409',
                    hint = 'A key identifies one application to one charge. Retry with the key this charge''s own call used, or use a new one.';
          end if;
          return v_existing;
        end if;
      end if;
      raise;
  end;

  -- 058: THE TAX FOLLOWS THE NEW NET, AT THE RATE THIS CHARGE WAS POSTED
  -- UNDER. The charge is its own source, which is the whole point: a fresh
  -- lookup would silently throw the capture away the first time anybody
  -- discounted a charge from before a rate change — capture at post time
  -- looks complete right up until that moment.
  perform restate_charge_taxes(v_charge.id, v_charge.id);

  return v_charge;
end;
$function$;

comment on function apply_charge_discount(uuid, numeric, text, text, text) is
  'Applies an ABSOLUTE discount to a charge — 500 then 800 is 800, never 1,300 — '
  'writing the four discount_* columns as the current state AND one '
  'folio_charge_discounts row per application as the history. 060: the '
  'idempotency check reads those rows rather than the single '
  'discount_idempotency_key column, which could only recognise the most recent '
  'key; a redelivered earlier key used to look new and re-apply itself, '
  'reverting the amount, restating the tax and overwriting the later reason. A '
  'replay now returns the charge AS IT STANDS, because that application did '
  'happen and the charge has since moved on. The approver is recorded per '
  'application, so the first of two is no longer answerable only through '
  'change_log. Taxes are restated from the charge''s OWN captured rates (058).';

revoke all on function apply_charge_discount(uuid, numeric, text, text, text)
  from public, anon;
grant execute on function apply_charge_discount(uuid, numeric, text, text, text)
  to authenticated;

-- ############################################################################
-- SECTION 3 — THE BACKFILL, AND THE TWO THINGS IT REFUSES TO ASSUME
-- ############################################################################
-- INVARIANT (rule 9), checked by SECTION 4 against the live rows and against a
-- purpose-built fixture:
--
--   for every folio_charges row with reversal_of_charge_id is null:
--       (it has folio_charge_discounts rows)  <=>  (discount_amount <> 0)
--   and where it has them:
--       the HIGHEST-seq row's new_amount = discount_amount (never created_at:
--       now() is transaction start time, so same-transaction rows tie — 036's
--       stock_movements.seq comment, same lesson)
--
-- It reconciles the history to the current state, which is the price of keeping
-- both. Two places holding one fact is only safe while something checks they
-- match.
do $$
declare
  v_multi   integer;
  v_detail  text;
  v_noappr  integer;
  v_written integer;
begin
  -- ---- GUARD 1: has any charge been discounted MORE THAN ONCE? ------------
  -- The backfill writes a single row with previous_amount 0, which is the true
  -- history only for a charge discounted once. A charge discounted twice has a
  -- reconstructable history, but reconstructing it means deciding which approver
  -- and which reason belong to which amount, and a migration must not make that
  -- decision quietly. Same question 058's and 059's backfills ask of change_log,
  -- about a different column.
  --
  -- SCOPED TO CHARGES THAT STILL EXIST, and that is the point rather than
  -- tidiness: change_log holds a discount_amount change for 46c787ce, a charge
  -- hard-deleted during early development, and an unscoped guard counts orphans
  -- like that forever. 059 §5 is the same lesson one shipment earlier — a guard
  -- that cannot pass does not get deleted, it gets the exception that gets past
  -- it, and the exception is what ships. The backfill writes rows for charges
  -- that exist, so the guard asks about charges that exist.
  select count(*)::integer into v_multi
  from (
    select cl.row_id
    from change_log cl
    join folio_charges fc on fc.id = cl.row_id
    where cl.table_name = 'folio_charges'
      and cl.field_name = 'discount_amount'
      and fc.reversal_of_charge_id is null
    group by cl.row_id
    having count(*) > 1
  ) m;

  if v_multi > 0 then
    select string_agg(format('%s (%s changes)', m.row_id, m.n), '; ')
      into v_detail
    from (
      select cl.row_id, count(*)::integer n
      from change_log cl
      join folio_charges fc on fc.id = cl.row_id
      where cl.table_name = 'folio_charges'
        and cl.field_name = 'discount_amount'
        and fc.reversal_of_charge_id is null
      group by cl.row_id
      having count(*) > 1
    ) m;

    raise exception
      'Cannot backfill folio_charge_discounts: % charge(s) have been discounted more than once, so a single row with previous_amount 0 is not their history. %',
      v_multi, coalesce(v_detail, '(see change_log)')
      using errcode = 'PT409',
            hint = 'change_log holds each step. Decide which approver and reason belong to which amount, insert those rows by hand, then re-run this migration — it skips charges that already have history.';
  end if;

  -- ---- GUARD 2: does every charge to be backfilled name an approver? ------
  -- approved_by is NOT NULL on the new table because apply_charge_discount
  -- always resolves one. A charge that somehow carries a discount with no
  -- approver cannot be backfilled honestly, and coalescing to whoever last
  -- touched the row would invent an authorisation — which is precisely the
  -- record §6 says must be answerable. So it refuses and names them.
  select count(*)::integer into v_noappr
  from folio_charges fc
  where fc.reversal_of_charge_id is null
    and fc.discount_amount <> 0
    and (fc.discount_approved_by is null
         or coalesce(btrim(fc.discount_reason), '') = '');

  if v_noappr > 0 then
    raise exception
      'Cannot backfill folio_charge_discounts: % discounted charge(s) carry no approver or no reason, and inventing either would fabricate an authorisation.',
      v_noappr
      using errcode = 'PT422',
            hint = 'Find those charges (reversal_of_charge_id is null and discount_amount <> 0), establish who approved them and why, set the columns, then re-run.';
  end if;

  -- ---- THE BACKFILL -------------------------------------------------------
  -- One row per currently-discounted NON-COUNTER charge. previous_amount 0
  -- because guard 1 has established there was only ever one application, so the
  -- discount went from nothing to what it is.
  --
  -- A COUNTER CHARGE IS EXCLUDED. 032's post_charge_reversal sets p_discount in
  -- the INSERT — a charge reversal mirrors the original's discount as a negative,
  -- a discount reversal is gross 0 with discount -X — so nobody applied those and
  -- there is no approver to name. Live: one such row, the laundry counter at
  -- -200.00. Giving it a row would invent an approval and would also make the
  -- invariant above read as if a negative discount had been authorised.
  --
  -- A VOIDED charge is NOT excluded: it was discounted and then voided, and both
  -- happened.
  --
  -- created_by is set EXPLICITLY (§6): there is no session inside a migration, so
  -- set_row_audit's coalesce(auth.uid(), new.created_by) falls through to what is
  -- passed, and the honest value is whoever last wrote the charge. approved_by is
  -- the authoritative answer to "who allowed this"; created_by only says who
  -- keyed it.
  insert into folio_charge_discounts (
    tenant_id, property_id, folio_charge_id,
    previous_amount, new_amount, approved_by, reason,
    business_date, idempotency_key, created_by
  )
  select fc.tenant_id, fc.property_id, fc.id,
         0, fc.discount_amount, fc.discount_approved_by, btrim(fc.discount_reason),
         fc.charge_date, fc.discount_idempotency_key,
         coalesce(fc.updated_by, fc.created_by)
  from folio_charges fc
  where fc.reversal_of_charge_id is null
    and fc.discount_amount <> 0
    and not exists (
      select 1 from folio_charge_discounts d where d.folio_charge_id = fc.id
    );

  get diagnostics v_written = row_count;
  raise notice '060 backfill: % discount application(s) written from the columns.', v_written;
end $$;

-- ############################################################################
-- SECTION 4 — SELF-VERIFY
-- ############################################################################
-- NAME THE DEFECT EACH ONE TURNS RED (rule 27), with the fixture choice that
-- lets it:
--
--   1  THE DEFECT THIS FILE EXISTS FOR, AS A FIXTURE. Apply 500 with K1, 800
--      with K2, then REDELIVER K1. The charge must still read 800, its tax must
--      still read the 800 figure, and the second reason must still be there.
--      RED if the idempotency check reads folio_charges.discount_idempotency_key
--      again, because that column holds only the latest key: the broken reading
--      lands on 500 / 722.00 / "first", the fixed one on 800 / 699.20 /
--      "second". DIFFERENT NUMBERS ON BOTH SIDES, which is the whole
--      requirement — a fixture that applied the same amount twice could not
--      tell the two apart.
--
--   2  THE HISTORY IS A CHAIN, NOT A LIST OF SNAPSHOTS. Two rows, and the
--      second must read previous 500 -> new 800, delta 300. RED if
--      previous_amount is written as a constant 0, or read after the update
--      instead of before it: either way row 2 reads previous 0 / delta 800, and
--      every delta the ledger posts is then the full discount rather than the
--      change. This is the assertion that protects 1.1h4's entry.
--
--   3  DELTA IS GENERATED, SIGNED, AND NOT WRITABLE. A third application
--      REDUCING 800 to 500 must read delta -300.00. RED if the generated
--      expression is reversed (previous - new), which no total would notice
--      because the magnitudes are identical — only the sign moves. And an
--      attempt to write the column must be refused, or it is a cache under
--      rule 6 with nothing to recompute it.
--
--   4  A ZERO DELTA IS ACCEPTED AND IS 0.00. The same amount re-approved is a
--      real event. RED if a check forbids it — which would refuse a legitimate
--      re-approval at the front desk. This is the row 1.1h4's helper must skip,
--      because post_journal RAISES on a balancing line of zero rather than
--      ignoring it, and this assertion is what makes that a known fact there
--      rather than a discovery.
--
--   5  THE INVARIANT, OVER THE LIVE ROWS. Rows exist if and only if
--      discount_amount <> 0, and the newest row agrees with the column. RED if
--      the backfill misses a discounted charge, writes the wrong figure, or
--      leaves the two sources disagreeing. The count check is load-bearing: on
--      an empty table "every row agrees" is vacuously true.
--
--   6  A COUNTER CHARGE GETS NO ROW. RED if the backfill stops excluding
--      reversal counters — the live laundry counter carries discount -200.00 and
--      would otherwise be given a row naming an approver nobody appointed, for
--      an application that never happened.
--
--   7  THE BACKFILL'S GUARD CAN SEE A DOUBLE DISCOUNT. The fixture has just made
--      three applications on one charge, so change_log must hold them. RED if
--      log_field_changes is not on folio_charges, which would leave SECTION 3's
--      guard reading an empty table and passing for the wrong reason — 058's
--      assertion 7, same trap, different column.
--
--   8  EVERY CARRIED-THROUGH REFUSAL STILL REFUSES, BY SQLSTATE AND MESSAGE.
--      Not merely "something raised" — 059's assertion 8 passed with the guard
--      it tested deleted because the function fell through to a NOT NULL
--      violation and the proof accepted any exception (rule 27's fifth shape).
--      Four of them: amount not above zero, amount above gross, blank reason,
--      and a counter line.
--
--   9  THE SHAPE. apply_charge_discount still SECURITY DEFINER with a pinned
--      search_path; the table with RLS on and NO write policy; the per-
--      application unique index actually refusing a duplicate key.
--
--  10  created_at CANNOT ORDER THESE ROWS AND seq CAN — asserted as a fact
--      about the data rather than as a behaviour, for the reason written at the
--      assertion itself: a breakage reinstating created_at passes or fails at
--      RANDOM, which is worse than green.
--
--  11  A KEY BELONGS TO ONE CHARGE. Charge A's key replayed against charge B
--      must RAISE and name both. RED if the ownership check is dropped — keys
--      are unique per TENANT, so the lookup finds a real application and hands
--      CHARGE A back as a success, which reads to the caller, and on the
--      screen, as a discount applied to the charge it asked about. A client bug
--      rather than a server one, but the answer to a client bug must not be a
--      wrong answer delivered confidently. Asserted on the check both replay
--      paths share.
--
-- WHAT THIS PROOF CANNOT DISTINGUISH, said out loud rather than left implied:
-- this tenant has ONE active owner/manager, so every application resolves the
-- SAME approver and no assertion here can tell a per-application approved_by
-- from a copy of the charge's column. What is proven instead is that the column
-- is NOT NULL and is written from v_approver — the same variable the charge's
-- own column is written from, in the same statement pair — so the two cannot
-- diverge. The per-application REASON does differ and is asserted in 1, which
-- exercises the same path. A second user in the fixture would close the gap and
-- would mean inserting into auth.users, which is not a trade a migration should
-- make.
do $$
declare
  v_tenant  uuid;
  v_user    uuid;
  v_prop    uuid;
  v_guest   uuid;
  v_folio   folios;
  v_cat     uuid;
  v_ch      folio_charges;
  v_rate    numeric(5,4);
  v_tax     numeric(14,2);
  v_amt     numeric(14,2);
  v_prev    numeric(14,2);
  v_delta   numeric(14,2);
  v_reason  text;
  v_n       integer;
  v_bad     integer;
  v_ok      boolean;
  v_err     text;
  v_state   text;
  v_fail    text := '';
begin
  begin
    select tu.tenant_id, tu.user_id into v_tenant, v_user
    from tenant_users tu where tu.is_active and tu.role in ('owner','manager') limit 1;
    select p.id into v_prop from properties p where p.tenant_id = v_tenant limit 1;
    if v_tenant is null or v_prop is null then
      raise notice '060 SELF-VERIFY SKIPPED: no tenant or active owner/manager.';
      raise exception 'ZZ_060_FIXTURE_DONE';
    end if;
    perform set_config('request.jwt.claims',
      json_build_object('role','service_role','sub', v_user::text)::text, true);

    -- THIS OVERWRITES A REAL MANAGER'S PIN, and it is only safe because the
    -- ZZ_060_FIXTURE_DONE sentinel below guarantees this block rolls back — the
    -- raise is unconditional, so there is no path that commits it. Anyone
    -- copying this fixture pattern into something that COMMITS must replace
    -- this with a pin on a throwaway user; a credential clobbered for the
    -- length of a transaction and a credential clobbered for good look
    -- identical in the diff.
    insert into manager_pins (tenant_id, user_id, pin_hash)
    values (v_tenant, v_user, crypt('4060', gen_salt('bf')))
    on conflict (tenant_id, user_id) do update set pin_hash = excluded.pin_hash;

    -- ---- 5 and 6: THE LIVE ROWS, BEFORE THE FIXTURE TOUCHES ANYTHING -----
    -- Both directions of the invariant in one pass, over every non-counter
    -- charge: a discounted one must have history, an undiscounted one must have
    -- none, and where there is history the newest row must agree.
    select count(*)::integer,
           count(*) filter (
             where (fc.discount_amount <> 0) <> (h.n > 0)
                or (h.n > 0 and h.newest is distinct from fc.discount_amount)
           )::integer
      into v_n, v_bad
    from folio_charges fc
    left join lateral (
      select count(*)::integer n,
             (select d2.new_amount from folio_charge_discounts d2
               where d2.folio_charge_id = fc.id
               order by d2.seq desc limit 1) newest
      from folio_charge_discounts d where d.folio_charge_id = fc.id
    ) h on true
    where fc.reversal_of_charge_id is null;

    if v_n = 0 then
      v_fail := v_fail ||
        '5: there are no non-counter charges at all, so the backfill was tested by nothing. ';
    elsif v_bad > 0 then
      v_fail := v_fail || format(
        '5: %s of %s non-counter charges disagree with their history (rows present without a discount, a discount without rows, or a newest row that does not match the column). ',
        v_bad, v_n);
    end if;

    select count(*)::integer into v_bad
    from folio_charges fc
    join folio_charge_discounts d on d.folio_charge_id = fc.id
    where fc.reversal_of_charge_id is not null;
    if v_bad > 0 then
      v_fail := v_fail || format(
        '6: %s reversal counter charge(s) were given a discount application, which names an approver nobody appointed for an act that never happened. ',
        v_bad);
    end if;

    -- ---- THE FIXTURE -----------------------------------------------------
    select tc.rate into v_rate
    from tax_charges tc
    where tc.property_id = v_prop and tc.code = 'vat'
      and tc.deleted_at is null and tc.is_active;
    select cc.id into v_cat from charge_categories cc
    where cc.tenant_id = v_tenant and cc.is_taxable and cc.deleted_at is null
      and cc.is_active
    order by cc.code limit 1;
    if v_rate is null or v_cat is null then
      raise exception '060 SELF-VERIFY needs a live VAT row and a taxable category (rate=%, cat=%)', v_rate, v_cat;
    end if;

    insert into guests (tenant_id, first_name, last_name, created_by)
    values (v_tenant, 'ZZ060', 'Fixture Guest', v_user) returning id into v_guest;
    v_folio := open_guest_folio(v_tenant, v_prop, v_guest, 'zz060-folio-1');
    v_ch := post_charge(v_folio.id, v_cat, 'ZZ060 laundry', 1, 10000, current_date,
                        'zz060-charge-1', 'manual');

    perform apply_charge_discount(v_ch.id, 500, 'ZZ060 first, by manager A',
                                  '4060', 'ZZ060-K1');
    perform apply_charge_discount(v_ch.id, 800, 'ZZ060 second, by manager B',
                                  '4060', 'ZZ060-K2');

    -- ---- 1. THE REDELIVERY. THE DEFECT, IN ONE CALL ----------------------
    perform apply_charge_discount(v_ch.id, 500, 'ZZ060 first, by manager A',
                                  '4060', 'ZZ060-K1');

    select fc.discount_amount, fc.discount_reason into v_amt, v_reason
    from folio_charges fc where fc.id = v_ch.id;
    select coalesce(sum(fct.amount), 0) into v_tax
    from folio_charge_tax_lines fct where fct.folio_charge_id = v_ch.id;

    if v_amt is distinct from 800.00 then
      v_fail := v_fail || format(
        '1: after redelivering the FIRST key the charge reads %s, not 800.00 — the earlier application re-applied itself. ',
        v_amt);
    end if;
    if v_tax is distinct from round(9200 * v_rate, 2) then
      v_fail := v_fail || format(
        '1: after the redelivery the tax reads %s, expected %s (the 800 figure); a reverted discount restates the tax with it. ',
        v_tax, round(9200 * v_rate, 2));
    end if;
    if v_reason is distinct from 'ZZ060 second, by manager B' then
      v_fail := v_fail || format(
        '1: after the redelivery the reason reads "%s" — the later manager''s decision was overwritten by the earlier one. ',
        v_reason);
    end if;

    select count(*)::integer into v_n
    from folio_charge_discounts where folio_charge_id = v_ch.id;
    if v_n <> 2 then
      v_fail := v_fail || format(
        '1: the redelivery left %s application row(s), expected 2 — a replay must record nothing new. ', v_n);
    end if;

    -- ---- 2. THE CHAIN ----------------------------------------------------
    select d.previous_amount, d.new_amount, d.delta_amount, d.reason
      into v_prev, v_amt, v_delta, v_reason
    from folio_charge_discounts d
    where d.folio_charge_id = v_ch.id
    order by d.seq desc limit 1;
    if v_prev is distinct from 500.00 or v_amt is distinct from 800.00
       or v_delta is distinct from 300.00 then
      v_fail := v_fail || format(
        '2: the newest application reads previous=%s new=%s delta=%s, expected 500.00 / 800.00 / 300.00 — the ledger would post the whole discount instead of the change. ',
        v_prev, v_amt, v_delta);
    end if;
    if v_reason is distinct from 'ZZ060 second, by manager B' then
      v_fail := v_fail || format(
        '2: the newest application records the reason "%s"; each row must keep its own. ', v_reason);
    end if;

    select d.previous_amount, d.new_amount, d.delta_amount, d.reason
      into v_prev, v_amt, v_delta, v_reason
    from folio_charge_discounts d
    where d.folio_charge_id = v_ch.id
    order by d.seq asc limit 1;
    if v_prev is distinct from 0.00 or v_amt is distinct from 500.00
       or v_delta is distinct from 500.00
       or v_reason is distinct from 'ZZ060 first, by manager A' then
      v_fail := v_fail || format(
        '2: the first application reads previous=%s new=%s delta=%s reason="%s". ',
        v_prev, v_amt, v_delta, v_reason);
    end if;

    select count(*) filter (where d.approved_by is null)::integer into v_bad
    from folio_charge_discounts d where d.folio_charge_id = v_ch.id;
    if v_bad > 0 then
      v_fail := v_fail || format(
        '2: %s application(s) name no approver. ', v_bad);
    end if;

    -- ---- 3. A REDUCTION, AND THE SIGN ------------------------------------
    perform apply_charge_discount(v_ch.id, 500, 'ZZ060 third, reduced',
                                  '4060', 'ZZ060-K3');
    select d.delta_amount into v_delta
    from folio_charge_discounts d
    where d.folio_charge_id = v_ch.id
    order by d.seq desc limit 1;
    if v_delta is distinct from -300.00 then
      v_fail := v_fail || format(
        '3: reducing 800 to 500 recorded a delta of %s, expected -300.00. A reversed generated expression gives +300.00, which no magnitude check would notice. ',
        v_delta);
    end if;

    v_ok := false;
    begin
      update folio_charge_discounts set delta_amount = 1
      where folio_charge_id = v_ch.id;
      v_ok := true;
    exception when others then
      null;                                 -- generated columns refuse, as they must
    end;
    if v_ok then
      v_fail := v_fail ||
        '3: delta_amount accepted a written value, so it is a stored copy with nothing to recompute it (rule 6). ';
    end if;

    -- ---- 4. A ZERO DELTA IS A REAL APPLICATION ---------------------------
    perform apply_charge_discount(v_ch.id, 500, 'ZZ060 fourth, re-approved',
                                  '4060', 'ZZ060-K4');
    select d.delta_amount, d.reason into v_delta, v_reason
    from folio_charge_discounts d
    where d.folio_charge_id = v_ch.id
    order by d.seq desc limit 1;
    if v_delta is distinct from 0.00
       or v_reason is distinct from 'ZZ060 fourth, re-approved' then
      v_fail := v_fail || format(
        '4: re-approving the same amount recorded delta=%s reason="%s"; it must be kept as a 0.00 application, which 1.1h4 skips. ',
        v_delta, v_reason);
    end if;

    -- The invariant still holds after four applications.
    select fc.discount_amount into v_amt from folio_charges fc where fc.id = v_ch.id;
    select d.new_amount into v_delta
    from folio_charge_discounts d where d.folio_charge_id = v_ch.id
    order by d.seq desc limit 1;
    if v_amt is distinct from v_delta then
      v_fail := v_fail || format(
        '4: after four applications the column reads %s and the newest row %s. ', v_amt, v_delta);
    end if;

    -- ---- 10. created_at CANNOT ORDER THESE ROWS, AND seq CAN -------------
    -- ASSERTED AS A FACT ABOUT THE DATA, because asserting it as a behaviour is
    -- a coin flip: `order by created_at desc, id desc` over tied rows falls
    -- through to a RANDOM uuid, so a breakage that reinstates created_at passes
    -- or fails at random — which is worse than green. What is deterministic is
    -- that the four applications SHARE a created_at and have four distinct seqs.
    --
    -- RED if set_row_audit stops using now() (then created_at might order them
    -- and the identity column would look unnecessary), or if seq stops being an
    -- identity column. Either way the defect it names is the same: anything that
    -- orders this table by created_at is ordering by a random uuid, and 1.1h4
    -- reads previous_amount off "the latest application" to post a delta.
    select count(distinct d.created_at)::integer, count(distinct d.seq)::integer
      into v_bad, v_n
    from folio_charge_discounts d where d.folio_charge_id = v_ch.id;
    if v_n < 4 then
      v_fail := v_fail || format(
        '10: four applications produced %s distinct seq values, so the table has no total order. ', v_n);
    elsif v_bad > 1 then
      v_fail := v_fail || format(
        '10: the four applications have %s distinct created_at values, so this fixture no longer demonstrates why seq exists — re-check that they are written in one transaction. ',
        v_bad);
    end if;

    -- ---- 7. THE GUARD CAN SEE WHAT JUST HAPPENED -------------------------
    select count(*)::integer into v_n
    from change_log cl
    where cl.table_name = 'folio_charges'
      and cl.field_name = 'discount_amount'
      and cl.row_id = v_ch.id;
    if v_n < 2 then
      v_fail := v_fail || format(
        '7: change_log recorded %s discount_amount change(s) for a charge discounted four times, so SECTION 3''s guard would read an empty table and pass for the wrong reason. ',
        v_n);
    end if;

    -- ---- 8. THE CARRIED-THROUGH REFUSALS, BY SQLSTATE AND MESSAGE --------
    v_ok := false; v_err := null; v_state := null;
    begin
      perform apply_charge_discount(v_ch.id, 0, 'ZZ060 zero', '4060', 'ZZ060-R1');
      v_ok := true;
    exception when others then v_err := sqlerrm; v_state := sqlstate; end;
    if v_ok or v_state is distinct from '23514'
       or v_err not like '%must be greater than zero%' then
      v_fail := v_fail || format('8: a zero discount was refused by %s / %s. ', v_state, v_err);
    end if;

    v_ok := false; v_err := null; v_state := null;
    begin
      perform apply_charge_discount(v_ch.id, 99999, 'ZZ060 too big', '4060', 'ZZ060-R2');
      v_ok := true;
    exception when others then v_err := sqlerrm; v_state := sqlstate; end;
    if v_ok or v_state is distinct from '23514'
       or v_err not like '%cannot exceed the charge%' then
      v_fail := v_fail || format('8: a discount above gross was refused by %s / %s. ', v_state, v_err);
    end if;

    v_ok := false; v_err := null; v_state := null;
    begin
      perform apply_charge_discount(v_ch.id, 400, '   ', '4060', 'ZZ060-R3');
      v_ok := true;
    exception when others then v_err := sqlerrm; v_state := sqlstate; end;
    if v_ok or v_state is distinct from '23514'
       or v_err not like '%needs a reason%' then
      v_fail := v_fail || format('8: a blank reason was refused by %s / %s. ', v_state, v_err);
    end if;

    -- And the counter-line guard, on a real counter.
    declare
      v_counter folio_charges;
    begin
      v_counter := post_charge_reversal(
        v_ch.id, 'charge', -(v_ch.gross_amount), -500,
        'ZZ060 reversal', current_date, 'zz060-rev-1');
      v_ok := false; v_err := null; v_state := null;
      begin
        perform apply_charge_discount(v_counter.id, 100, 'ZZ060 on a counter',
                                      '4060', 'ZZ060-R4');
        v_ok := true;
      exception when others then v_err := sqlerrm; v_state := sqlstate; end;
      if v_ok or v_state is distinct from '23514'
         or v_err not like '%is a reversal and cannot be discounted%' then
        v_fail := v_fail || format('8: a counter line was refused by %s / %s. ', v_state, v_err);
      end if;

      -- 6 again, on a counter this fixture made: it carries a discount of -500
      -- and must have no application row.
      select count(*)::integer into v_bad
      from folio_charge_discounts where folio_charge_id = v_counter.id;
      if v_bad > 0 then
        v_fail := v_fail || format(
          '6: the fixture''s counter charge was given %s application row(s). ', v_bad);
      end if;
    end;

    -- ---- 9. THE SHAPE ----------------------------------------------------
    select count(*)::integer into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'apply_charge_discount'
      and (not p.prosecdef
           or p.proconfig is null
           or not exists (select 1 from unnest(p.proconfig) cfg
                          where cfg like 'search_path=public%'));
    if v_bad > 0 then
      v_fail := v_fail ||
        '9: apply_charge_discount lost SECURITY DEFINER or its pinned search_path. ';
    end if;

    if not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                   where n.nspname = 'public' and c.relname = 'folio_charge_discounts'
                     and c.relrowsecurity) then
      v_fail := v_fail || '9: folio_charge_discounts has RLS switched off. ';
    end if;

    select count(*)::integer into v_bad
    from pg_policies
    where schemaname = 'public' and tablename = 'folio_charge_discounts'
      and cmd <> 'SELECT';
    if v_bad > 0 then
      v_fail := v_fail || format(
        '9: folio_charge_discounts has %s write polic(ies); its rows are the audit trail for the most theft-adjacent act on the floor and no client may author one. ',
        v_bad);
    end if;

    v_ok := false;
    begin
      insert into folio_charge_discounts (
        tenant_id, property_id, folio_charge_id, previous_amount, new_amount,
        approved_by, reason, business_date, idempotency_key, created_by)
      values (v_tenant, v_prop, v_ch.id, 0, 100, v_user, 'ZZ060 dup',
              current_date, 'ZZ060-K1', v_user);
      v_ok := true;
    exception when unique_violation then
      null;                                 -- refused, which is the point
    end;
    if v_ok then
      v_fail := v_fail ||
        '9: a second application reused an idempotency key, so a retry can still be applied twice. ';
    end if;

    -- ---- 11. A KEY BELONGS TO ONE CHARGE ---------------------------------
    -- Charge A's key replayed against charge B. Without the ownership check
    -- the lookup finds A's application, returns CHARGE A, and the caller reads
    -- a success for a charge it never touched. The broken and fixed readings
    -- are not two numbers here but two KINDS of answer — a returned row versus
    -- PT409 — which is why v_ok is asserted alongside the sqlstate.
    declare
      v_ch2 folio_charges;
    begin
      v_ch2 := post_charge(v_folio.id, v_cat, 'ZZ060 second line', 1, 5000,
                           current_date, 'zz060-charge-2', 'manual');
      v_ok := false; v_err := null; v_state := null;
      begin
        perform apply_charge_discount(v_ch2.id, 100, 'ZZ060 key reuse',
                                      '4060', 'ZZ060-K1');
        v_ok := true;
      exception when others then v_err := sqlerrm; v_state := sqlstate; end;
      if v_ok or v_state is distinct from 'PT409'
         or v_err not like '%already used to discount charge%' then
        v_fail := v_fail || format(
          '11: charge A''s key replayed against charge B was answered by %s / %s — the caller is handed charge A back as a success. ',
          coalesce(v_state, 'a returned row'), coalesce(v_err, '(no error)'));
      end if;
      select count(*)::integer into v_bad
      from folio_charge_discounts where folio_charge_id = v_ch2.id;
      if v_bad > 0 then
        v_fail := v_fail || format(
          '11: the refused key still wrote %s application row(s) to charge B. ', v_bad);
      end if;
    end;

    if v_fail <> '' then
      raise exception '060 SELF-VERIFY FAILED — %', v_fail;
    end if;

    raise notice '060 SELF-VERIFY: 11 assertions passed.';
    raise exception 'ZZ_060_FIXTURE_DONE';
  exception
    when others then
      if sqlerrm = 'ZZ_060_FIXTURE_DONE' then
        raise notice '060 self-verify complete; fixture rolled back.';
      else
        raise;
      end if;
  end;
end $$;
