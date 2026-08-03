-- ============================================================================
-- 032_reversals_charges.sql
-- Palstro-Hotels: THE REVERSAL SUBSYSTEM, PART 2 — charges and discounts.
--
-- ----------------------------------------------------------------------------
--  ┌────────────────────────────────────────────────────────────────────────┐
--  │  A REVERSAL IS A VISIBLE COUNTER-ENTRY, NEVER A DELETE AND NEVER AN    │
--  │  EDIT — PIN-gated, reason-mandatory, with a permanent reversals row     │
--  │  linking original → counter-entry → who → when → why.                   │
--  └────────────────────────────────────────────────────────────────────────┘
-- ----------------------------------------------------------------------------
--
-- Part 1 (031) built the foundation this file reuses WITHOUT ALTERING: the
-- reversals audit table with its full target_type list, its "one reversal per
-- target, ever" unique index, its member-read/no-write RLS, verify_manager_pin,
-- and the counter-entry pattern. Part 2 adds two RPCs and the one column a
-- counter-CHARGE needs, and changes nothing else about part 1. reverse_payment
-- is byte-for-byte as 031 left it.
--
-- WHAT THIS MIGRATION DOES *NOT* TOUCH, deliberately:
--   folio_totals, folio_balance, folio_charge_tax, the 022 read views, the 027 /
--   028 guest_stays / guest_ledger FIFO views, post_charge, post_room_night_charge,
--   record_payment, reverse_payment, void_payment, create_booking, checkout, the
--   night audit and every pricing path are BYTE-FOR-BYTE as 015–031 left them.
--   The counter-entry is an ORDINARY folio_charges row, so the existing math
--   consumes it with no change of any kind. §5 walks through exactly why.
--
--   TWO EXCEPTIONS, AND BOTH ARE CORRECTNESS FIXES, NOT FEATURES:
--     * void_charge (§6) gains the two guards 031 §4 gave void_payment — a
--       reversed charge and a counter-charge must both refuse a void, or the
--       same money is subtracted twice / an approved reversal is silently undone.
--     * apply_charge_discount (§7) gains three guards. Discounting a charge AFTER
--       it has been reversed changes its net while the counter-entry still holds
--       the OLD net, so the two stop cancelling and the balance moves by the
--       difference — with no PIN, no reason and no audit row. That is the same
--       hole class as the void one, found while writing this file, and it is
--       closed here rather than noted for later.
--
-- ----------------------------------------------------------------------------
-- THE FOUR DESIGN DECISIONS THIS MIGRATION MAKES
-- ----------------------------------------------------------------------------
--
-- DECISION 1 — THE COUNTER-CHARGE MIRRORS ALL THREE MONEY COLUMNS, NOT JUST NET.
--   A charge carries gross_amount, discount_amount and net_amount as three
--   separate visible figures (021 §5's discount-as-its-own-line model). The
--   counter-entry negates ALL THREE:
--
--     original :  gross  100,000   discount  20,000   net  80,000
--     counter  :  gross -100,000   discount -20,000   net -80,000
--
--   so gross_total, discount_total AND net_total each return to what they were
--   before the charge existed. The tempting shortcut — a single -80,000 net line
--   with no discount — balances the BALANCE and corrupts everything else: the
--   folio would still claim ₦20,000 was given away on a charge that no longer
--   stands, and "revenue given away" is a report this hotel bought the system to
--   read. THE DISCOUNTED CASE IS THE SUBTLE ONE AND IT IS WHY THE MIRROR IS THE
--   WHOLE ROW; §3.3 works it through to the kobo.
--
-- DECISION 2 — REVERSING A DISCOUNT IS ALSO A COUNTER-ENTRY (mechanism (a)),
--   NOT AN EDIT OF discount_amount BACK TO ZERO (mechanism (b)).
--   The counter row is, in the same category as the original:
--
--     gross 0   discount -20,000   net +20,000     (net = gross - discount ✓)
--
--   Reasoned against (b), which was the tempting one because a discount is
--   applied by an UPDATE in the first place:
--     * (b) REWRITES A CLOSED DAY. A discount applied on Monday and reversed on
--       Thursday would retroactively raise Monday's net revenue, after Monday's
--       night audit reported it. 031 §3 was explicit for money — "the money goes
--       back out TODAY, and today's cash-up is what must show it" — and a
--       discount reversal is the same claim about revenue. The counter-entry
--       carries charge_date = today; an edit cannot.
--     * (b) IS AN EDIT, and the box at the top of this file says a reversal is
--       never one. The original charge keeps its discount, its reason and its
--       approving manager exactly as they were: the record of what was given away
--       on Monday survives, and the record of it being clawed back on Thursday
--       sits beside it. Under (b) the first fact is overwritten by the second.
--     * (b) MAKES THE FIGURES DISAGREE WITH THE PRINTED LINES for the day. Under
--       (a) discount_total nets to zero across the two rows, so the hotel is not
--       told money was given away when it was not — while each DAY still reads
--       correctly on its own.
--   What (a) costs: one extra line on the bill. That line is the point — it is
--   the visible, dated, manager-approved fact that the discount was undone.
--
-- DECISION 3 — THE COUNTER IS POSTED BY AN INTERNAL SIBLING OF post_charge,
--   NOT BY post_charge ITSELF, AND NOT BY A HAND-ROLLED INSERT.
--   post_charge refuses a negative unit_amount and refuses a retired category —
--   both correct for an ordinary posting, both wrong for a reversal:
--     * a reversal is negative BY CONSTRUCTION;
--     * a charge posted last month against a category the hotel has since retired
--       must still be reversible. This is the same inversion folio_charge_tax
--       (021 §8.1) already makes for tax: what a charge WAS posted against is
--       fixed history, whether or not the category is still offered today.
--   Widening post_charge with a "this one may be negative" parameter would put a
--   negative-posting door in a function every client may call, guarded by nothing
--   — no PIN, no reason, no audit row. So §2 adds post_charge_reversal, which is
--   REVOKED FROM EVERY CLIENT ROLE (the posture 021 §12 uses for
--   verify_manager_pin) and reachable only from the two RPCs below, which have
--   already verified a manager's PIN. post_charge is not modified.
--
-- DECISION 4 — A CHARGE MAY BE REVERSED ONCE AND ITS DISCOUNT ONCE, INDEPENDENTLY,
--   AND reverse_charge NETS THE WHOLE GROUP.
--   reversals_target_uniq is on (tenant, target_type, target_id), so 'charge' and
--   'discount' are separate one-time acts against the same charge — which they
--   must be: a wrongly-applied discount reversed on Tuesday cannot make the whole
--   charge unreversible on Friday. The consequence is that reverse_charge must
--   negate the charge's CURRENT effect, not its original row: original +
--   discount-reversal counter. §3.4 shows the arithmetic. Getting this wrong
--   would leave the discount-reversal's +20,000 stranded on the bill after the
--   charge it belonged to had been reversed.
-- ============================================================================


-- ############################################################################
-- SECTION 1 — folio_charges learns what a counter-entry is
-- ############################################################################
-- Two columns and a relaxed sign rule. This is the ONLY schema change in the
-- file, and it is the mirror of what 031 §2 did to folio_payments — for the same
-- three reasons, which are worth restating because they are why this is a column
-- and not a lookup:
--
--   1. THE BILL AND THE STATEMENT READ IT WITH NO JOIN. One fetch of the folio's
--      charges already knows which lines are counter-entries and which originals
--      they undo, so a negative line prints as "Charge reversal — <reason>"
--      rather than as an unexplained credit.
--   2. IT IS A REAL FOREIGN KEY. reversals.target_id cannot have one (it is
--      polymorphic — 031 §1); this can, in the composite form, so a counter-charge
--      can never point at a charge in another tenant or another property.
--   3. IT MAKES A SECOND COUNTER-ENTRY IMPOSSIBLE at the database level,
--      independently of the reversals table.
--
-- Neither column is a cache (rule 6): they store the IDENTITY of another row and
-- the KIND of act, never a figure, so there is nothing that can drift.

alter table folio_charges
  add column if not exists reversal_of_charge_id uuid;

-- WHICH ACT this counter-entry performs. Not derivable from the amounts (a
-- fully-comped charge reverses with gross 0 too), and the bill must be able to
-- say "Charge reversal" or "Discount reversal" without guessing. The vocabulary
-- is reversals.target_type's, deliberately: one word for one act, everywhere.
alter table folio_charges
  add column if not exists reversal_target_type text;

comment on column folio_charges.reversal_of_charge_id is
  'Set ONLY on a counter-entry posted by reverse_charge / reverse_discount: the '
  'id of the ORIGINAL charge this row reverses. NULL on every ordinary charge. '
  'Not a cache (rule 6) — an identity, not a figure. It is also the flag the sign '
  'constraint keys on: ONLY a counter-entry may carry negative money.';
comment on column folio_charges.reversal_target_type is
  '''charge'' (the whole charge was reversed) or ''discount'' (only the discount '
  'on it was), matching reversals.target_type. Set together with '
  'reversal_of_charge_id and NULL without it. Not derivable from the amounts, and '
  'the bill must name the act rather than infer it.';

do $$
begin
  -- Both or neither. A counter-entry that did not say which act it performs, or
  -- an ordinary charge claiming to be a 'discount' reversal of nothing, are both
  -- rows no reader could interpret.
  if not exists (
    select 1 from pg_constraint where conname = 'folio_charges_reversal_pair_check'
  ) then
    alter table folio_charges
      add constraint folio_charges_reversal_pair_check
      check (
        (reversal_of_charge_id is null and reversal_target_type is null)
        or (reversal_of_charge_id is not null
            and reversal_target_type in ('charge', 'discount'))
      );
  end if;

  -- The composite FK TARGET (§6 composite-key consistency). folio_charges' primary
  -- key is `id` alone, so the triple a child binds to does not exist yet.
  if not exists (
    select 1 from pg_constraint where conname = 'folio_charges_id_scope_uniq'
  ) then
    alter table folio_charges
      add constraint folio_charges_id_scope_uniq unique (id, tenant_id, property_id);
  end if;

  -- The self-reference, bound on all three columns: a counter-charge always sits
  -- on the same tenant AND property as the charge it reverses. Two independent
  -- FKs would allow the pair to disagree; this cannot.
  if not exists (
    select 1 from pg_constraint where conname = 'folio_charges_reversal_of_fk'
  ) then
    alter table folio_charges
      add constraint folio_charges_reversal_of_fk
      foreign key (reversal_of_charge_id, tenant_id, property_id)
      references folio_charges (id, tenant_id, property_id);
  end if;
end;
$$;

-- AT MOST ONE COUNTER-ENTRY PER (ORIGINAL, ACT). Belt to reversals_target_uniq's
-- braces: even if a future code path forgot the reversals row entirely, a charge
-- could still only be reversed once and its discount reversed once. The pair is
-- the key precisely because DECISION 4 keeps the two acts independent.
create unique index if not exists folio_charges_reversal_of_uniq
  on folio_charges (reversal_of_charge_id, reversal_target_type)
  where reversal_of_charge_id is not null;

-- "Show me this charge's counter-entries" — the bill's read, and the aggregate
-- reverse_charge takes over the group (§3.4).
create index if not exists folio_charges_reversal_of_idx
  on folio_charges (reversal_of_charge_id)
  where reversal_of_charge_id is not null;


-- ----------------------------------------------------------------------------
-- 1.1 — THE SIGN RULE, RE-EXPRESSED (not relaxed)
-- ----------------------------------------------------------------------------
-- 021 §5 constrained unit_amount >= 0, gross_amount >= 0, discount_amount >= 0
-- and discount_amount <= gross_amount. Those four say one thing: "a charge is
-- money owed, and a discount reduces it toward zero." A counter-entry is money
-- UN-owed, so the same sentence reads with every sign flipped.
--
-- The four constraints are therefore replaced by ONE that branches on
-- reversal_of_charge_id — which is what makes this a re-expression rather than a
-- relaxation. AN ORDINARY CHARGE IS EXACTLY AS CONSTRAINED AS IT WAS: it cannot
-- go negative, and its discount still cannot exceed it. Only a row that declares
-- itself a counter-entry, and therefore points at the charge it reverses under a
-- unique index, may carry negative money.
--
--   ordinary   : unit >= 0, gross >= 0, 0 <= discount <= gross
--   counter    : unit <= 0, gross <= 0, discount <= 0
--
-- The counter side has no |discount| <= |gross| bound and must not: the
-- discount-reversal counter is (gross 0, discount -20,000, net +20,000), where
-- the discount is the entire content of the row. The EXACT figures are the RPCs'
-- job (they are computed from the original, never passed in from outside), and
-- the RPCs are the only writers — folio_charges has no write policy for anyone
-- (021 §11).
--
-- folio_charges_net_check (net = gross - discount) and
-- folio_charges_quantity_check (quantity > 0) are UNCHANGED and still hold on
-- both sides: a counter-entry is one unit of a negative amount.
alter table folio_charges drop constraint if exists folio_charges_unit_amount_check;
alter table folio_charges drop constraint if exists folio_charges_gross_check;
alter table folio_charges drop constraint if exists folio_charges_discount_check;
alter table folio_charges drop constraint if exists folio_charges_discount_le_gross_check;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'folio_charges_signs_check'
  ) then
    alter table folio_charges
      add constraint folio_charges_signs_check
      check (
        case when reversal_of_charge_id is null
          then unit_amount     >= 0
           and gross_amount    >= 0
           and discount_amount >= 0
           and discount_amount <= gross_amount
          else unit_amount     <= 0
           and gross_amount    <= 0
           and discount_amount <= 0
        end
      );
  end if;
end;
$$;

comment on constraint folio_charges_signs_check on folio_charges is
  'One rule, two directions. An ORDINARY charge (reversal_of_charge_id NULL) is '
  'constrained exactly as 021 §5 constrained it: non-negative money, discount no '
  'greater than the charge. A COUNTER-ENTRY is the same sentence with every sign '
  'flipped. Only a row that declares which charge it reverses may hold negative '
  'money, and only the reverse_* RPCs can write one.';


-- ----------------------------------------------------------------------------
-- 1.2 — reversals: a 'charge' / 'discount' reversal also always has a counter
-- ----------------------------------------------------------------------------
-- 031 §1 constrained counter_entry_id NOT NULL for target_type 'payment' and
-- said in terms that the constraint would be "extended per type rather than
-- relaxed". This is that extension, added as its OWN constraint so 031's is not
-- dropped and re-created — the audit table's existing guarantees are untouched.
--
-- Both of this part's target types always produce exactly one counter-charge, so
-- an audit row without one would record something that did not happen to the
-- money. ('cancel' / 'no_show' / 'checkout' reverse a STATE and may legitimately
-- have none, which is why the column stays nullable at the table level.)
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'reversals_charge_counter_check'
  ) then
    alter table reversals
      add constraint reversals_charge_counter_check
      check (target_type not in ('charge', 'discount')
             or counter_entry_id is not null);
  end if;
end;
$$;


-- ############################################################################
-- SECTION 2 — post_charge_reversal: the counter-posting primitive
-- ############################################################################
-- DECISION 3 in the header says why this exists beside post_charge rather than
-- inside it. What it is: post_charge's insert, with the two validations that are
-- wrong for a reversal removed and nothing else changed.
--
--   * NO CATEGORY LIVENESS CHECK. The category comes from the ORIGINAL charge,
--     not from a caller, so there is nothing to validate — and a category the
--     hotel retired last month must not make last month's charges unreversible.
--     Same inversion as folio_charge_tax (021 §8.1).
--   * NEGATIVE MONEY IS THE POINT, so no non-negative guard.
--   * NO STAFF GATE AND NO PIN CHECK, because it is unreachable from a client:
--     §9 revokes EXECUTE from public, anon and authenticated. Its only callers
--     are the two RPCs below, each of which has already verified a manager's PIN
--     against the original charge's own tenant. This is exactly the posture 021
--     §12 gives verify_manager_pin, and for the same reason — a function whose
--     safety comes from WHO MAY CALL IT must be callable by nobody.
--
-- What it keeps from post_charge, because these are not reversal-specific:
--   the folio-status check, the (tenant, idempotency_key) fast path AND the
--   unique_violation race handler against folio_charges_idem_uniq, the trigger-
--   owned audit columns, and the DB-enforced net = gross - discount.
create or replace function post_charge_reversal(
  p_original_id     uuid,
  p_target_type     text,      -- 'charge' | 'discount'
  p_gross           numeric,   -- already signed by the caller (<= 0)
  p_discount        numeric,   -- already signed by the caller (<= 0)
  p_description     text,
  p_charge_date     date,
  p_idempotency_key text
)
returns folio_charges
language plpgsql
security definer
set search_path = public
as $$
declare
  v_original folio_charges;
  v_folio    folios;
  v_existing folio_charges;
  v_counter  folio_charges;
  v_actor    uuid := auth.uid();
begin
  select * into v_original from folio_charges where id = p_original_id;
  if not found then
    raise exception 'Charge % not found', p_original_id using errcode = 'no_data_found';
  end if;

  if p_target_type not in ('charge', 'discount') then
    raise exception 'Unknown reversal target type %', p_target_type
      using errcode = 'check_violation';
  end if;

  -- IDEMPOTENCY fast path (rules 2 & 3). The key is always the deterministic one
  -- the caller built ('reversal:charge:<id>' / 'reversal:discount:<id>'), so a
  -- replay finds the first counter-entry rather than posting a second.
  if p_idempotency_key is not null then
    select * into v_existing
    from folio_charges
    where tenant_id = v_original.tenant_id
      and idempotency_key = p_idempotency_key
    limit 1;
    if found then
      return v_existing;
    end if;
  end if;

  -- The same status rule post_charge applies: a settled or closed folio takes no
  -- new postings, and a counter-entry IS a posting. The callers raise their own
  -- sentence before reaching here; this is the primitive refusing to be the hole.
  select * into v_folio from folios where id = v_original.folio_id;
  if v_folio.status <> 'open' then
    raise exception 'Folio % is % and cannot take a reversal posting', v_folio.id, v_folio.status
      using errcode = 'check_violation';
  end if;

  begin
    insert into folio_charges (
      tenant_id, property_id, folio_id, charge_category_id,
      description, quantity, unit_amount,
      gross_amount, discount_amount, net_amount,
      charge_date, source, idempotency_key,
      reversal_of_charge_id, reversal_target_type, created_by
    ) values (
      v_original.tenant_id, v_original.property_id, v_original.folio_id,
      -- THE ORIGINAL'S CATEGORY, ALWAYS. It is what makes the tax reverse with
      -- the charge: folio_charge_tax resolves applicability from the category's
      -- is_taxable / service_chargeable flags, so a counter posted under the same
      -- category attracts exactly the same taxes at exactly the same rates, on a
      -- negative net (§5).
      v_original.charge_category_id,
      p_description,
      1,                        -- one unit of a negative amount
      p_gross,                  -- quantity 1, so unit = gross by construction
      p_gross, p_discount, p_gross - p_discount,
      p_charge_date,            -- TODAY's operating day, never the original's
      'reversal',               -- provenance (021 §5: free text on purpose)
      p_idempotency_key,
      p_original_id, p_target_type, v_actor
    )
    returning * into v_counter;
  exception
    when unique_violation then
      -- A concurrent caller won the race on folio_charges_idem_uniq (or on
      -- folio_charges_reversal_of_uniq). Return their row rather than posting a
      -- second counter-entry.
      if p_idempotency_key is not null then
        select * into v_existing
        from folio_charges
        where tenant_id = v_original.tenant_id
          and idempotency_key = p_idempotency_key
        limit 1;
        if found then
          return v_existing;
        end if;
      end if;
      select * into v_existing
      from folio_charges
      where reversal_of_charge_id = p_original_id
        and reversal_target_type = p_target_type
      limit 1;
      if found then
        return v_existing;
      end if;
      raise;
  end;

  return v_counter;
end;
$$;

comment on function post_charge_reversal(uuid, text, numeric, numeric, text, date, text) is
  'INTERNAL counter-posting primitive for reverse_charge / reverse_discount — '
  'REVOKED FROM EVERY CLIENT ROLE (§9), because its safety is entirely a matter of '
  'who may call it: it posts NEGATIVE money and performs no PIN check. Posts an '
  'ordinary folio_charges row in the ORIGINAL''s category (which is what makes the '
  'tax reverse automatically) on TODAY''s business date, idempotent against '
  'folio_charges_idem_uniq. Deliberately does NOT re-validate the category''s '
  'liveness: a retired category must not make last month''s charges unreversible '
  '(the same inversion folio_charge_tax makes, 021 §8.1).';


-- ############################################################################
-- SECTION 3 — reverse_charge
-- ############################################################################
--
-- 3.1 THE GUARD ORDER — 031 §3.1's, applied to a charge
-- -----------------------------------------------------
--   1. RESOLVE AND LOCK the charge (`select ... for update`). FIRST, because it
--      is what makes every check below atomic: two terminals reversing the same
--      charge in the same second serialise here, and the loser reads the
--      winner's committed reversals row at step 4 instead of posting a second
--      counter-charge.
--   2. STAFF GATE, then the caller's own PROPERTY GRANT (rule 19's two layers).
--   3. IDEMPOTENCY BY KEY — a replay of the same intent returns the first
--      outcome, BEFORE the PIN check, so a retry after a network drop does not
--      send the desk to fetch a manager for an approval that already happened.
--   4. IDEMPOTENCY BY STATE — already reversed? Return that reversal. The
--      stronger guard: it also catches a retry arriving with a DIFFERENT key.
--   5. NOT VOIDED. A voided charge counts for nothing already; a counter-entry
--      against it would move the balance by an amount the bill never included.
--   6. NOT ITSELF A COUNTER-ENTRY. Reversing a reversal is a ping-pong that makes
--      the audit trail unreadable and enables nothing — the money is where it
--      started.
--   7. FOLIO NOT CLOSED (and not settled — a counter-entry is a posting, and
--      post_charge_reversal refuses a non-open folio anyway; this raises the
--      sentence a person can act on).
--   8. REASON NON-EMPTY, in the RPC and not only the UI (rule 19), and in the
--      reversals column CHECK besides.
--   9. MANAGER PIN, ALWAYS. Last, so a call that was going to be rejected anyway
--      never consumes a PIN entry.
--
-- 3.2 WHY THE PIN HAS NO THRESHOLD — 031 §3.2, unchanged and re-affirmed
-- ----------------------------------------------------------------------
-- A discount is threshold-gated because giving a small discount is part of the
-- job. Removing a charge that was already billed is not: it is the single most
-- useful act to a person who served something and pocketed the cash, and it is
-- worth exactly as much at ₦5,000 as at ₦500,000, because it is the RECORD being
-- changed and not a price. There is no amount below which it is routine and no
-- property setting that can make it so. Do not add one.
--
-- 3.3 THE DISCOUNTED CHARGE — THE SUBTLE CASE, WORKED THROUGH
-- -----------------------------------------------------------
-- A ₦100,000 charge with a ₦20,000 discount, VAT 7.5%, on a taxable category:
--
--                       gross     discount      net      tax      effect
--   original          100,000       20,000    80,000    6,000    +86,000
--   counter          -100,000      -20,000   -80,000   -6,000    -86,000
--   ----------------------------------------------------------------------
--   folio totals            0            0         0        0          0
--
-- The guest owed 86,000 and now owes nothing for it — the balance returns to
-- EXACTLY what it was before the charge existed, which is the requirement. Note
-- what makes it exact:
--   * the counter mirrors the NET the guest actually owed (80,000), not the rack
--     100,000. Mirroring gross alone would over-credit the guest by the discount;
--   * the TAX FOLLOWS WITHOUT ANY SPECIAL HANDLING, because 021 computes tax LIVE
--     from each charge's net (§5), so a negative net produces a negative tax on
--     the very next read. There is no stored tax to reverse and no tax branch
--     anywhere in this file;
--   * gross_total and discount_total return to zero too (DECISION 1), so the
--     hotel is not told ₦20,000 was given away on a charge that no longer stands.
--
-- 3.4 A CHARGE WHOSE DISCOUNT WAS ALREADY REVERSED (DECISION 4)
-- -------------------------------------------------------------
-- The counter negates the charge's CURRENT effect — the original plus any
-- counter-entries already posted against it — never the original row alone:
--
--                             gross     discount      net      tax
--   original                100,000       20,000    80,000    6,000
--   discount reversal             0      -20,000    20,000    1,500
--   ----------------------------------------------------------------
--   current effect          100,000            0   100,000    7,500
--   charge reversal        -100,000            0  -100,000   -7,500
--   ----------------------------------------------------------------
--   folio totals                  0            0         0        0
--
-- Mirroring the original row alone would have posted -20,000 of discount that was
-- no longer there and left +20,000 stranded on the bill. The aggregate below is
-- one query and it is the reason this function reads the group rather than the row.
--
-- 3.5 WHY folio_totals AND THE FIFO VIEWS NEED NO CHANGE — see §5.
-- 3.6 THE TRANSACTION BOUNDARY — one function call is one transaction (rule 11).
--     The counter-charge and the reversals row are written inside it, so there is
--     no state in which one exists without the other. A failure anywhere rolls
--     the whole thing back and RAISEs with a SQLSTATE the client shows verbatim.

create or replace function reverse_charge(
  p_charge_id       uuid,
  p_reason          text,
  p_manager_pin     text,
  p_idempotency_key text default null
)
returns reversals
language plpgsql
security definer
set search_path = public
as $$
declare
  v_charge      folio_charges;
  v_folio       folios;
  v_counter     folio_charges;
  v_reversal    reversals;
  v_existing    reversals;
  v_manager     uuid;
  v_reason      text;
  v_key         text;
  v_counter_key text;
  v_timezone    text;
  v_date        date;
  v_gross       numeric(14,2);
  v_discount    numeric(14,2);
  v_actor       uuid := auth.uid();
begin
  -- --- GUARD 1: resolve and LOCK the original ------------------------------
  select * into v_charge from folio_charges where id = p_charge_id for update;
  if not found then
    raise exception 'Charge % not found', p_charge_id using errcode = 'no_data_found';
  end if;

  -- --- GUARD 2: staff gate, then this caller's own property grant -----------
  if not is_tenant_staff(v_charge.tenant_id) then
    raise exception 'Not authorised to reverse charges for this tenant'
      using errcode = 'insufficient_privilege';
  end if;
  if not (v_charge.property_id = any(get_property_ids())) then
    raise exception 'You do not have access to this property'
      using errcode = 'insufficient_privilege';
  end if;

  -- The reversals row's key: the caller's, or the deterministic one. The
  -- COUNTER-CHARGE's key is ALWAYS the deterministic one, whatever the caller
  -- passed — see the post_charge_reversal call.
  v_counter_key := 'reversal:charge:' || p_charge_id::text;
  v_key := coalesce(nullif(btrim(p_idempotency_key), ''), v_counter_key);

  -- --- GUARD 3: idempotency BY KEY (rules 2 & 3) ---------------------------
  select * into v_existing
  from reversals
  where tenant_id = v_charge.tenant_id and idempotency_key = v_key
  limit 1;
  if found then
    return v_existing;
  end if;

  -- --- GUARD 4: idempotency BY STATE — already reversed? -------------------
  -- Holding the GUARD 1 row lock, this is what makes "a charge is reversed at
  -- most once" true under concurrency rather than merely likely.
  select * into v_existing
  from reversals
  where tenant_id = v_charge.tenant_id
    and target_type = 'charge'
    and target_id = p_charge_id
  limit 1;
  if found then
    return v_existing;
  end if;

  -- --- GUARD 5: the original must not be voided ----------------------------
  if v_charge.is_voided is true then
    raise exception
      'Charge % is voided; it counts for nothing and cannot be reversed', p_charge_id
      using errcode = 'check_violation',
            hint = 'A voided charge is already out of every total. Reversing it would move the balance by an amount the bill never included.';
  end if;

  -- --- GUARD 6: the original must not itself be a counter-entry ------------
  if v_charge.reversal_of_charge_id is not null then
    raise exception 'This line is itself a reversal and cannot be reversed'
      using errcode = 'check_violation',
            hint = 'The charge is already back where it started. Post a fresh charge if it needs to be billed again.';
  end if;

  -- --- GUARD 7: the folio must be open -------------------------------------
  select * into v_folio from folios where id = v_charge.folio_id;
  if v_folio.status <> 'open' then
    raise exception 'Folio % is %; its charges cannot be reversed', v_folio.id, v_folio.status
      using errcode = 'check_violation',
            hint = 'A reversal posts a counter-charge, and only an open folio takes new postings. Re-open the folio first — a decision with its own audit trail.';
  end if;

  -- --- GUARD 8: the reason is mandatory HERE, not only in the UI (rule 19) --
  v_reason := btrim(coalesce(p_reason, ''));
  if v_reason = '' then
    raise exception 'A reversal needs a reason' using errcode = 'check_violation';
  end if;

  -- --- GUARD 9: A MANAGER PIN. ALWAYS. NO THRESHOLD (§3.2). ----------------
  v_manager := verify_manager_pin(v_charge.tenant_id, p_manager_pin);
  if v_manager is null then
    raise exception 'Reversing a charge always requires a valid manager PIN'
      using errcode = 'insufficient_privilege',
            hint = 'Hand the terminal to a manager. The reversal is recorded against them by name.';
  end if;

  -- --- THE EFFECT, all of it inside this one transaction (§3.6) ------------

  -- The business date (rules 8, 12), resolved in the PROPERTY's timezone exactly
  -- as post_charge and record_payment do. It is the date the REVERSAL happens,
  -- never the original charge's date: the charge comes off the bill TODAY, and
  -- today's revenue is what must show it. Yesterday's night audit stays true.
  select p.timezone into v_timezone from properties p where p.id = v_charge.property_id;
  v_date := (now() at time zone coalesce(nullif(btrim(v_timezone), ''), 'Africa/Lagos'))::date;

  -- THE GROUP AGGREGATE (§3.4). The original plus any counter-entry already
  -- posted against it — today that is only a discount reversal, and this is
  -- written as a sum so a later part cannot silently outgrow it. Rule 5's
  -- NULL-safe void filter, though a counter-entry can never be voided (§6).
  select coalesce(sum(fc.gross_amount), 0), coalesce(sum(fc.discount_amount), 0)
    into v_gross, v_discount
  from folio_charges fc
  where (fc.id = p_charge_id or fc.reversal_of_charge_id = p_charge_id)
    and fc.tenant_id = v_charge.tenant_id
    and fc.is_voided is not true;

  -- THE COUNTER-ENTRY. Negate the group: gross, discount and therefore net
  -- (DECISION 1). net is not passed — post_charge_reversal computes it as
  -- gross - discount, the same arithmetic folio_charges_net_check enforces, so
  -- there is only one place it can be wrong and the database checks that place.
  --
  -- The key is the DETERMINISTIC one, always, even when the caller passed their
  -- own: two different caller keys must not be able to post two counter-charges,
  -- and with one fixed key folio_charges_idem_uniq refuses the second outright.
  v_counter := post_charge_reversal(
    p_charge_id,
    'charge',
    - v_gross,
    - v_discount,
    -- The line's own words, on the row itself. The bill, the guest ledger and the
    -- statement all print description already, so the counter reads correctly
    -- everywhere with no renderer change. The reason is COPIED, not joined: a
    -- reversals row is permanent and never updated, so the copy cannot drift.
    'Charge reversal — ' || v_reason,
    v_date,
    v_counter_key
  );

  -- THE AUDIT ROW. Written last, so it can name the counter-entry it produced.
  begin
    insert into reversals (
      tenant_id, property_id, reversed_by, approved_by, reason,
      target_type, target_id, counter_entry_id, business_date,
      idempotency_key, created_by
    ) values (
      v_charge.tenant_id, v_charge.property_id, v_actor, v_manager, v_reason,
      'charge', p_charge_id, v_counter.id, v_date,
      v_key, v_actor
    )
    returning * into v_reversal;
  exception
    when unique_violation then
      -- A concurrent caller won a race the GUARD 1 lock should already have
      -- prevented. Return THEIR row — but only if it genuinely exists: re-raising
      -- otherwise aborts the whole call, rolling the counter-charge back with it,
      -- so this handler can never leave a counter-charge without its audit row.
      select * into v_existing
      from reversals
      where tenant_id = v_charge.tenant_id
        and (idempotency_key = v_key
             or (target_type = 'charge' and target_id = p_charge_id))
      limit 1;
      if found then
        return v_existing;
      end if;
      raise;
  end;

  return v_reversal;
end;
$$;

comment on function reverse_charge(uuid, text, text, text) is
  'Reverses a charge by posting an equal-and-opposite counter-CHARGE in the same '
  'category and writing a permanent reversals audit row. The original is never '
  'edited or deleted; both lines stay on the bill. The counter mirrors gross, '
  'discount AND net, so a DISCOUNTED charge returns the balance to exactly what it '
  'was before the charge existed, and the TAX reverses with it automatically '
  'because 021 computes tax live from each charge''s net. If the charge''s discount '
  'was already reversed, the counter negates the whole group, not the original row. '
  'ALWAYS requires a valid manager PIN — no threshold — and a non-empty reason, '
  'both enforced here and not only in the UI (rule 19). Idempotent by key AND by '
  'state under a FOR UPDATE lock, so a double-click cannot post two counter-charges.';


-- ############################################################################
-- SECTION 4 — reverse_discount
-- ############################################################################
-- Restores a charge to its full pre-discount amount. DECISION 2 in the header
-- says why this is a counter-entry (mechanism (a)) and not an edit of
-- discount_amount back to zero (mechanism (b)); the short version is that (b)
-- would rewrite a business day that has already been reported, and would
-- overwrite the record of what was given away with the record of it being taken
-- back — two facts, one row.
--
-- THE COUNTER ROW, and why its shape is the only one that works:
--
--                       gross     discount      net      tax(7.5%)
--   original          100,000       20,000    80,000       6,000
--   counter                 0      -20,000    20,000       1,500
--   ----------------------------------------------------------------
--   folio totals      100,000            0   100,000       7,500
--
--   * THE BALANCE RISES BY THE DISCOUNT (20,000) PLUS ITS TAX (1,500) — which is
--     right: the guest is charged tax on what they are actually charged, so
--     restoring the price restores the tax on it.
--   * gross stays 100,000 — the rack price never changed, only what was taken off
--     it, so the counter puts nothing in the gross column.
--   * discount_total nets to zero: nothing was given away in the end.
--   * net_total is 100,000, and 100,000 = gross - 0. The bill still reads
--     rack -> discount -> net correctly on every line and in every total.
--   * ROUNDING: 6,000 + 1,500 = 7,500 = round(100,000 x 0.075) here, but per-line
--     rounding CAN differ from a single rounded figure by one kobo on some rates.
--     That is 021's stated rule, not a defect of this file — the printed lines add
--     up to the printed total because both round the same way (021 §8.1).
--
-- A PIN IS ALWAYS REQUIRED, and this is the one place it needs its own argument
-- rather than 031's: applying the discount required approval (021 §9.3), so
-- un-applying it — which RAISES what the guest owes, after they may have been
-- quoted the discounted figure — cannot require less. There is no threshold for
-- the same reason as §3.2.
--
-- GUARD ORDER AND IDEMPOTENCY MIRROR reverse_charge, with two extra guards that
-- are specific to a discount (5b and 6b below).

create or replace function reverse_discount(
  p_charge_id       uuid,
  p_reason          text,
  p_manager_pin     text,
  p_idempotency_key text default null
)
returns reversals
language plpgsql
security definer
set search_path = public
as $$
declare
  v_charge      folio_charges;
  v_folio       folios;
  v_counter     folio_charges;
  v_reversal    reversals;
  v_existing    reversals;
  v_manager     uuid;
  v_reason      text;
  v_key         text;
  v_counter_key text;
  v_timezone    text;
  v_date        date;
  v_discount    numeric(14,2);
  v_actor       uuid := auth.uid();
begin
  -- --- GUARD 1: resolve and LOCK the charge --------------------------------
  select * into v_charge from folio_charges where id = p_charge_id for update;
  if not found then
    raise exception 'Charge % not found', p_charge_id using errcode = 'no_data_found';
  end if;

  -- --- GUARD 2: staff gate, then this caller's own property grant -----------
  if not is_tenant_staff(v_charge.tenant_id) then
    raise exception 'Not authorised to reverse discounts for this tenant'
      using errcode = 'insufficient_privilege';
  end if;
  if not (v_charge.property_id = any(get_property_ids())) then
    raise exception 'You do not have access to this property'
      using errcode = 'insufficient_privilege';
  end if;

  v_counter_key := 'reversal:discount:' || p_charge_id::text;
  v_key := coalesce(nullif(btrim(p_idempotency_key), ''), v_counter_key);

  -- --- GUARD 3: idempotency BY KEY (rules 2 & 3) ---------------------------
  select * into v_existing
  from reversals
  where tenant_id = v_charge.tenant_id and idempotency_key = v_key
  limit 1;
  if found then
    return v_existing;
  end if;

  -- --- GUARD 4: idempotency BY STATE — this discount already reversed? -----
  -- A DISCOUNT IS REVERSED ONCE, EVER (reversals_target_uniq on
  -- (tenant, 'discount', charge)). That is also why apply_charge_discount refuses
  -- to re-discount a charge whose discount has been reversed (§7): a second
  -- discount could never be reversed, and a reversal nobody can perform is worse
  -- than a discount nobody may give.
  select * into v_existing
  from reversals
  where tenant_id = v_charge.tenant_id
    and target_type = 'discount'
    and target_id = p_charge_id
  limit 1;
  if found then
    return v_existing;
  end if;

  -- --- GUARD 5: the charge must not be voided ------------------------------
  if v_charge.is_voided is true then
    raise exception
      'Charge % is voided; its discount counts for nothing and cannot be reversed', p_charge_id
      using errcode = 'check_violation',
            hint = 'A voided charge is already out of every total, discount and all.';
  end if;

  -- --- GUARD 5b: the WHOLE CHARGE must not have been reversed --------------
  -- Restoring the price of a charge that no longer stands would raise the balance
  -- by a discount on money nobody owes. (reverse_charge has already netted the
  -- group to zero, including the discount — §3.3.)
  if exists (
    select 1 from reversals r
    where r.tenant_id = v_charge.tenant_id
      and r.target_type = 'charge'
      and r.target_id = p_charge_id
  ) then
    raise exception 'Charge % has been reversed in full; there is no discount left to restore', p_charge_id
      using errcode = 'check_violation',
            hint = 'The whole charge, discount included, has already been taken off the bill.';
  end if;

  -- --- GUARD 6: the charge must not itself be a counter-entry --------------
  if v_charge.reversal_of_charge_id is not null then
    raise exception 'This line is a reversal and has no discount to restore'
      using errcode = 'check_violation';
  end if;

  -- --- GUARD 6b: there must BE a discount ---------------------------------
  v_discount := coalesce(v_charge.discount_amount, 0);
  if v_discount <= 0 then
    raise exception 'Charge % carries no discount to reverse', p_charge_id
      using errcode = 'check_violation',
            hint = 'This charge is already at its full amount.';
  end if;

  -- --- GUARD 7: the folio must be open -------------------------------------
  select * into v_folio from folios where id = v_charge.folio_id;
  if v_folio.status <> 'open' then
    raise exception 'Folio % is %; its discounts cannot be reversed', v_folio.id, v_folio.status
      using errcode = 'check_violation',
            hint = 'A discount reversal posts a counter-entry, and only an open folio takes new postings.';
  end if;

  -- --- GUARD 8: the reason is mandatory HERE, not only in the UI (rule 19) --
  v_reason := btrim(coalesce(p_reason, ''));
  if v_reason = '' then
    raise exception 'A reversal needs a reason' using errcode = 'check_violation';
  end if;

  -- --- GUARD 9: A MANAGER PIN. ALWAYS. ------------------------------------
  -- Applying the discount required approval; un-applying it raises what the guest
  -- owes, so it cannot require less.
  v_manager := verify_manager_pin(v_charge.tenant_id, p_manager_pin);
  if v_manager is null then
    raise exception 'Reversing a discount always requires a valid manager PIN'
      using errcode = 'insufficient_privilege',
            hint = 'Hand the terminal to a manager. The approval is recorded against them by name.';
  end if;

  -- --- THE EFFECT ---------------------------------------------------------
  select p.timezone into v_timezone from properties p where p.id = v_charge.property_id;
  v_date := (now() at time zone coalesce(nullif(btrim(v_timezone), ''), 'Africa/Lagos'))::date;

  -- gross 0, discount -X  ->  net +X (post_charge_reversal computes net as
  -- gross - discount). The original row is not touched: it keeps its discount,
  -- its reason and the manager who approved it, which is the record of what was
  -- given away. This row is the record of it being taken back.
  v_counter := post_charge_reversal(
    p_charge_id,
    'discount',
    0,
    - v_discount,
    'Discount reversal — ' || v_reason,
    v_date,
    v_counter_key
  );

  begin
    insert into reversals (
      tenant_id, property_id, reversed_by, approved_by, reason,
      target_type, target_id, counter_entry_id, business_date,
      idempotency_key, created_by
    ) values (
      v_charge.tenant_id, v_charge.property_id, v_actor, v_manager, v_reason,
      -- target_id is THE CHARGE (031 §1: the target is polymorphic, and a
      -- discount has no id of its own — it lives ON the charge, per 021 §5).
      'discount', p_charge_id, v_counter.id, v_date,
      v_key, v_actor
    )
    returning * into v_reversal;
  exception
    when unique_violation then
      select * into v_existing
      from reversals
      where tenant_id = v_charge.tenant_id
        and (idempotency_key = v_key
             or (target_type = 'discount' and target_id = p_charge_id))
      limit 1;
      if found then
        return v_existing;
      end if;
      raise;
  end;

  return v_reversal;
end;
$$;

comment on function reverse_discount(uuid, text, text, text) is
  'Reverses the DISCOUNT on a charge, restoring it to its full pre-discount '
  'amount, by posting a counter-entry of (gross 0, discount -X, net +X) in the '
  'same category — NOT by editing discount_amount back to zero. The counter-entry '
  'is chosen so the reversal lands on TODAY''s business date instead of rewriting '
  'the day the discount was given, and so the original keeps its discount, reason '
  'and approving manager as permanent record. The balance rises by the discount '
  'and its tax recomputes on the restored net automatically (021 computes tax live '
  'from net). ALWAYS requires a manager PIN — applying the discount needed '
  'approval, so un-applying it cannot need less — and a reason. Idempotent by key '
  'and by state: a discount is reversed once, ever.';


-- ############################################################################
-- SECTION 5 — WHY folio_totals, THE TAX AND THE FIFO VIEWS NEED NO CHANGE
-- ############################################################################
-- Because the counter-entry is an ORDINARY CHARGE ROW. Walk it through:
--
--   * folio_totals (021 §8.2) sums gross_amount, discount_amount and net_amount
--     over `where is_voided is not true`. A negative row simply subtracts. Not one
--     character changes, and there is no CASE for reversals anywhere.
--   * TAX IS COMPUTED LIVE, NEVER STORED (021 §5, §8.1). folio_charge_tax
--     multiplies the charge's own net by each applicable active rate, and
--     applicability comes from the CATEGORY — which the counter shares with the
--     original. A negative net therefore produces a negative tax on the very next
--     read: the VAT comes off the bill with the charge, automatically, with no
--     tax handling in this migration at all. This is exactly why 021 refused to
--     store vat_amount columns, and this file is the payoff.
--   * folio_charge_taxes (022 §1) is `cross join lateral folio_charge_tax(fc.id)`
--     over every charge, so the counter's negative tax lines appear in the view
--     the bill and the statement already read.
--   * NOTHING IS CACHED (rule 6), so there is no stored balance to decrement, no
--     denormalised column to keep in lockstep, and no GREATEST(0, ...) floor to
--     get wrong (rule 7). Rule 7's lockstep review is therefore trivial here and
--     is stated rather than performed: ledger, cache and denormalised columns
--     number one, zero and zero.
--   * THE 027 / 028 FIFO ALLOCATION is computed at READ TIME over the same
--     non-voided rows. Reducing the guest's charges re-runs the water-fill on the
--     next read and re-allocates every stay automatically. There is no stored
--     allocation to repair, which is precisely why 027 refused to store one.
--   * guest_ledger unions folio_charges rows as charge lines and recomputes the
--     running balance in the same window, so the counter appears as its own dated
--     line and the balance steps down from there.
--   * assembleStatement (lib/statement.ts) prints non-voided charge rows and reads
--     its totals from folio_totals, so the printed lines and the printed balance
--     both include the counter with no change to the exporter. VOIDS ARE HIDDEN
--     FROM THE GUEST AND REVERSALS ARE NOT — see that file's header: a void says
--     the line should never have existed, while a reversal and its counter are two
--     real events the guest is entitled to read, and they net to nothing in the
--     total either way.
--
-- The rule this expresses, as in 031: A REVERSAL IS A POSTING, NOT AN EXCEPTION.
-- The moment one of these functions needs to know what a reversal is, the design
-- has gone wrong.


-- ############################################################################
-- SECTION 6 — void_charge gains two guards (a CORRECTNESS FIX)
-- ############################################################################
-- THE BUG THIS CLOSES, in figures — the charge-side twin of 031 §4. A ₦80,000 net
-- charge is reversed: the original stays +80,000 and the counter is -80,000, so
-- net_total is 0 and the guest owes nothing for it. Correct.
--
-- Now suppose the ORIGINAL could still be voided. folio_totals drops it, leaving
-- net_total = -80,000, and the folio CREDITS the guest ₦80,000 they were never
-- owed. Voiding the COUNTER-ENTRY instead is the mirror image: net_total returns
-- to +80,000, silently UN-REVERSING an accountable reversal with no PIN, no
-- reason and no audit row, while the permanent reversals row still says the
-- charge came off.
--
-- Neither is hypothetical: both are two clicks apart in the same ⋯ menu. So
-- void_charge now refuses both, and the UI hides the action to match (rule 19:
-- the client hides it for a clean screen, the database is the guard).
--
-- EVERYTHING ELSE IN THIS FUNCTION IS BYTE-FOR-BYTE 021 §9.5 — same signature,
-- same lock, same staff gate, same idempotent-by-state return, same reason
-- requirement, same columns written. Only the two guards are new.
create or replace function void_charge(
  p_charge_id       uuid,
  p_reason          text,
  p_idempotency_key text default null
)
returns folio_charges
language plpgsql
security definer
set search_path = public
as $$
declare
  v_charge folio_charges;
  v_folio  folios;
  v_actor  uuid := auth.uid();
begin
  select * into v_charge from folio_charges where id = p_charge_id for update;
  if not found then
    raise exception 'Charge % not found', p_charge_id using errcode = 'no_data_found';
  end if;

  if not is_tenant_staff(v_charge.tenant_id) then
    raise exception 'Not authorised to void charges for this tenant'
      using errcode = 'insufficient_privilege';
  end if;

  -- Idempotent by state: already voided -> return unchanged (retry-safe).
  if v_charge.is_voided is true then
    return v_charge;
  end if;

  -- NEW (032 §6): a charge that has been REVERSED — in full, or whose discount was
  -- reversed — cannot also be voided. The counter-entry already moved the balance;
  -- voiding the original on top of that would move the same money twice.
  if exists (
    select 1 from reversals r
    where r.tenant_id = v_charge.tenant_id
      and r.target_type in ('charge', 'discount')
      and r.target_id = v_charge.id
  ) then
    raise exception 'Charge % has been reversed and cannot also be voided', p_charge_id
      using errcode = 'check_violation',
            hint = 'The reversal already moved it out of the balance. Voiding it as well would count the same money twice.';
  end if;

  -- NEW (032 §6): a COUNTER-ENTRY cannot be voided either — that would silently
  -- un-reverse an approved reversal, with no PIN, no reason and no audit row,
  -- while the permanent reversals row still says the charge came off.
  if v_charge.reversal_of_charge_id is not null then
    raise exception 'This line is a reversal and cannot be voided'
      using errcode = 'check_violation',
            hint = 'Voiding it would undo an approved reversal without a manager''s authorisation. Post a fresh charge instead.';
  end if;

  select * into v_folio from folios where id = v_charge.folio_id;
  if v_folio.status = 'closed' then
    raise exception 'Folio % is closed; its charges cannot be voided', v_folio.id
      using errcode = 'check_violation';
  end if;

  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'A void needs a reason' using errcode = 'check_violation';
  end if;

  update folio_charges
     set is_voided   = true,
         voided_at   = now(),
         voided_by   = v_actor,
         void_reason = btrim(p_reason),
         updated_by  = v_actor
   where id = p_charge_id
  returning * into v_charge;

  return v_charge;
end;
$$;

comment on function void_charge(uuid, text, text) is
  'Voids a charge — sets is_voided with a reason, time and actor; NEVER deletes '
  '(rule 5). Excluded from folio_balance by the NULL-safe `is_voided is not true` '
  'filter, so no cache is decremented and nothing can drift. Idempotent by state. '
  'REFUSES a charge that has been reversed (in full or by discount), and refuses a '
  'reversal counter-entry: the first would move the same money twice, the second '
  'would un-reverse an approved reversal without a PIN (032 §6).';


-- ############################################################################
-- SECTION 7 — apply_charge_discount gains three guards (a CORRECTNESS FIX)
-- ############################################################################
-- THE BUG THIS CLOSES, and it is the one this build found rather than inherited.
-- A ₦100,000 charge is reversed: the counter holds -100,000/-0/-100,000 and the
-- pair nets to nothing. Now discount the ORIGINAL by ₦30,000. Its net becomes
-- 70,000 while the counter still holds -100,000, so the pair no longer cancels
-- and THE FOLIO CREDITS THE GUEST ₦30,000 — with no PIN on the reversal, no audit
-- row, and no error anywhere. The counter-entry is a snapshot of a net that the
-- original could still change underneath it.
--
-- Three guards close it:
--   1. A REVERSED CHARGE CANNOT BE DISCOUNTED. Its net is now frozen by the
--      counter-entry that mirrors it.
--   2. A COUNTER-ENTRY CANNOT BE DISCOUNTED. Discounting a negative charge is
--      meaningless, and folio_charges_signs_check would refuse the write anyway —
--      as a raw constraint error rather than a sentence a receptionist can act on.
--   3. A CHARGE WHOSE DISCOUNT WAS REVERSED CANNOT BE RE-DISCOUNTED. Not for
--      arithmetic (a fresh discount would compute correctly) but for
--      accountability: reversals_target_uniq allows ONE discount reversal per
--      charge, ever, so a second discount would be one nobody could ever reverse.
--      A discount that cannot be undone is exactly the shape of write-off this
--      subsystem exists to keep undoable. Void the charge and re-post it if the
--      price genuinely needs to change again — a decision with its own trail.
--
-- EVERYTHING ELSE IS BYTE-FOR-BYTE 021 §9.3 — same signature, same lock, same
-- idempotency key and race handler, same threshold read, same comp rule, same
-- PIN branch, same columns written, same absolute (non-cumulative) semantics.
-- Only the three guards are new, and they sit AFTER the idempotency fast path so
-- a retry of an already-applied discount still returns its row.
create or replace function apply_charge_discount(
  p_charge_id       uuid,
  p_discount_amount numeric,
  p_reason          text,
  p_manager_pin     text default null,
  p_idempotency_key text default null
)
returns folio_charges
language plpgsql
security definer
set search_path = public
as $$
declare
  v_charge    folio_charges;
  v_existing  folio_charges;
  v_folio     folios;
  v_threshold numeric(14,2);
  v_manager   uuid;
  v_approver  uuid;
  v_is_comp   boolean;
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

  if p_idempotency_key is not null then
    select * into v_existing
    from folio_charges
    where tenant_id = v_charge.tenant_id
      and discount_idempotency_key = p_idempotency_key
    limit 1;
    if found then
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
  exception
    when unique_violation then
      if p_idempotency_key is not null then
        select * into v_existing
        from folio_charges
        where tenant_id = v_charge.tenant_id
          and discount_idempotency_key = p_idempotency_key
        limit 1;
        if found then
          return v_existing;
        end if;
      end if;
      raise;
  end;

  return v_charge;
end;
$$;

comment on function apply_charge_discount(uuid, numeric, text, text, text) is
  'Applies an ACCOUNTABLE discount to a charge. At or below the property''s '
  'discount_threshold: the staff member''s own authority, and they are named as '
  'approver. Above it: verify_manager_pin must return an active manager or the '
  'call is rejected outright, and THAT manager is named. A full comp (100% off) '
  'ALWAYS requires a manager PIN whatever the threshold. Absolute (not '
  'cumulative), reason mandatory, net recomputed, idempotent via '
  'folio_charges_discount_idem_uniq. REFUSES a reversal counter-entry, a charge '
  'that has been reversed (its counter mirrors the net as it stood), and a charge '
  'whose discount was reversed (a second discount could never be undone) — 032 §7.';


-- ############################################################################
-- SECTION 8 — Row-Level Security
-- ############################################################################
-- NOTHING TO ADD, AND THAT IS THE POINT. No new table: the counter-entry is a
-- folio_charges row (member SELECT, no write policy — 021 §11) and the audit row
-- is a reversals row (member SELECT, no write policy — 031 §5). Both are written
-- exclusively by SECURITY DEFINER functions that verified a manager's PIN first.
--
-- The two new columns need no policy of their own: RLS is row-level, and the rows
-- they sit on are already covered by folio_charges_member_select. They are
-- readable by tenant members and writable by nobody, which is what they must be —
-- a reversal link a client could set is a reversal a staff member could claim.
--
-- Stated explicitly, as 021 §11 and 031 §5 do, so the absence is deliberate and
-- visible rather than merely unwritten: DO NOT ADD A WRITE POLICY TO
-- folio_charges OR reversals.


-- ############################################################################
-- SECTION 9 — Function grants
-- ############################################################################
-- SECURITY DEFINER defaults to EXECUTE for PUBLIC. Revoke on every function and
-- grant only authenticated staff — never anon.
--
-- post_charge_reversal is granted to NOBODY, exactly as verify_manager_pin and
-- the seed_* helpers are (021 §12): it posts negative money and checks no PIN, so
-- its entire safety is that only reverse_charge and reverse_discount — which run
-- as the function owner — can reach it. If this grant ever appears, the manager
-- PIN on every charge reversal in the system becomes optional.
revoke execute on function post_charge_reversal(uuid, text, numeric, numeric, text, date, text) from public;
revoke execute on function post_charge_reversal(uuid, text, numeric, numeric, text, date, text) from anon;
revoke execute on function post_charge_reversal(uuid, text, numeric, numeric, text, date, text) from authenticated;

revoke execute on function reverse_charge(uuid, text, text, text) from public;
revoke execute on function reverse_charge(uuid, text, text, text) from anon;
grant  execute on function reverse_charge(uuid, text, text, text) to authenticated;

revoke execute on function reverse_discount(uuid, text, text, text) from public;
revoke execute on function reverse_discount(uuid, text, text, text) from anon;
grant  execute on function reverse_discount(uuid, text, text, text) to authenticated;

-- Re-stated for the two re-created functions: CREATE OR REPLACE preserves the
-- existing grants, but stating them keeps this file readable on its own.
revoke execute on function void_charge(uuid, text, text) from public;
revoke execute on function void_charge(uuid, text, text) from anon;
grant  execute on function void_charge(uuid, text, text) to authenticated;

revoke execute on function apply_charge_discount(uuid, numeric, text, text, text) from public;
revoke execute on function apply_charge_discount(uuid, numeric, text, text, text) from anon;
grant  execute on function apply_charge_discount(uuid, numeric, text, text, text) to authenticated;

-- ============================================================================
-- End of 032_reversals_charges.sql
-- ============================================================================
