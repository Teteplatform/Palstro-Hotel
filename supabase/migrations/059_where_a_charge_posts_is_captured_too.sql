-- ============================================================================
-- 059 — WHERE A CHARGE POSTS IS CAPTURED TOO
-- ============================================================================
-- Three things the folio wiring (1.1h4) needs before its first journal entry
-- exists, for exactly the reason 058 came before it: each one decides what a
-- posting WRITES, so discovering it afterwards means a correction migration
-- against entries that are already in the books.
--
-- 058 captured what a charge was TAXED. It left what a charge POSTS TO resolved
-- live, and that is the same defect one column over. This file closes it, gives
-- a tax its own account instead of inferring one, and splits a timestamp that
-- is about to be asked two different questions.
--
-- NOTHING HERE POSTS ANYTHING. There is still no folio journal entry in this
-- system; 1.1h4 writes the first one. This file only makes sure the facts it
-- will read are on the rows rather than in a live lookup.
--
-- ----------------------------------------------------------------------------
-- 1. THE REVENUE ACCOUNT IS CAPTURED ON THE CHARGE
-- ----------------------------------------------------------------------------
-- charge_categories.account_role_key says where a category's revenue posts. It
-- has an ADMIN UPDATE POLICY, so a hotel can repoint "Food & Beverage" from
-- revenue_fnb to revenue_misc at any time — and 044 deliberately allows that,
-- because a hotel reorganising its chart of accounts is a legitimate act.
--
-- Resolved live at posting time, that act is also a silent corruption of the
-- past. A charge posted under revenue_fnb and REVERSED after the repoint would
-- credit revenue_fnb and debit revenue_misc: both entries balance, the trial
-- balance is clean, and two revenue accounts carry equal and opposite residues
-- that nothing will ever clear. It is 032's defect exactly — the pair that is
-- supposed to net, and does not — and it is invisible for the same reason: no
-- figure is wrong on any screen, only the pairing is.
--
-- So the key is copied ONTO the charge when it is posted, the way 058 copies the
-- rate and booking_nights copies the nightly rate. The same sentence applies and
-- it is the same decision: A FACT CAPTURED WHEN IT WAS TRUE.
--
-- AND A COUNTER CHARGE CAPTURES THE ORIGINAL'S KEY, NOT ITS CATEGORY'S. If the
-- category was repointed between the charge and its reversal, the counter must
-- unwind the account the original actually hit. This is the same reading as
-- restate_charge_taxes taking the original's RATES rather than today's, and it
-- is why the key is read off v_original rather than off charge_categories.
--
-- NOT A CACHE (rule 6), for the reason 058's table is not: a cache stores
-- something also derivable now and must ship a recompute function. This stores
-- which account was live at one instant, which is derivable ONLY then — the
-- category's current key is a different fact that happens to share a name.
--
-- WHAT IS NOT CAPTURED, AND WHY NOT. The discount leg's account is the single
-- role key `discounts_allowed`, identical on every charge in every category, so
-- there is nothing per-row to capture and a column would be eleven thousand
-- copies of one constant. Rule 4 is satisfied by resolving that key through
-- account_mappings at posting time, exactly as `guest_ledger` is. The thing that
-- breaks netting is a key that VARIES BY ROW, and only the revenue key does.
--
-- ----------------------------------------------------------------------------
-- 2. A TAX HAS ITS OWN ACCOUNT
-- ----------------------------------------------------------------------------
-- tax_charges carries no account at all, so the only thing the wiring could
-- have read is applies_to: 'taxable' -> vat_output, 'service_chargeable' ->
-- service_charge_payable. Today that is right, because the only tax that exists
-- is VAT and 021 seeds nothing else.
--
-- It is right BY ACCIDENT, and the accident is not stable. applies_to answers
-- "which charges does this apply to" — 021's own words make it the distinction
-- between a tax the law levies and a surcharge the hotel levies. It does not
-- answer "who is owed the money", and the two questions have the same answer
-- only while there is one tax on each side. A Rivers State consumption tax is
-- also applies_to='taxable'; a tray charge is also 'service_chargeable'. Either
-- one would land in an account belonging to somebody else and RECONCILE
-- PERFECTLY while doing it — money owed to one authority sitting in the ledger
-- line for another, with every total correct.
--
-- So applies_to keeps its job and an account_role_key is added beside it, NOT
-- NULL and guarded against being unmapped: the same shape 044 gave
-- charge_categories, for the same reason — the refusal lands on the person
-- configuring the hotel, not on the front desk with a guest waiting.
--
-- AND 058'S CAPTURED ROWS CARRY IT. A tax row on a bill from before a hotel
-- reorganises its liabilities must still say which account it was owed to, or
-- the reversal of that charge unwinds a different one — SECTION 1's defect
-- again, in the tax leg. restate_charge_taxes carries the key through from its
-- source for the same reason it carries the rate.
--
-- ----------------------------------------------------------------------------
-- 3. gl_wired_at BECOMES TWO COLUMNS
-- ----------------------------------------------------------------------------
-- 047 added gl_wired_at as "THE INSTANT THIS PROPERTY'S RPCs BEGAN POSTING",
-- stamped when the STOCK posting shipped. The folio posting ships later, so
-- after 1.1h4 one timestamp would be the answer to two different questions, and
-- both reconciliations would read it confidently. A stock movement from before
-- the stock wiring is explained; a folio charge from before the FOLIO wiring is
-- explained; and a charge posted BETWEEN the two wirings is explained by
-- neither, while a single column says it is.
--
-- That is not a column somebody misreads through carelessness. It is a column
-- whose name is a complete and accurate description of a thing that has stopped
-- being one thing. So:
--
--   stock_gl_wired_at   renamed from gl_wired_at. Same value, same meaning,
--                       narrower name. Stamped 2026-09-18 on Heledon.
--   folio_gl_wired_at   added, NULL, NO DEFAULT. Null is the honest answer
--                       today: the folio posts nothing, so there is no instant
--                       at which it began. 1.1h4 stamps it and adds the default,
--                       in the migration that makes it true.
--
-- NO GENERAL MODULE-WIRING TABLE, deliberately, and this is written down so the
-- next person does not have to re-decide it: two rows do not need a table, and
-- the indirection would make the reconciliation's query worse to read for no
-- gain today. WHEN A THIRD MODULE WIRES, THAT IS THE MOMENT TO RECONSIDER —
-- three is where a pattern starts and where a table begins to pay.
--
-- ----------------------------------------------------------------------------
-- 4. 'other' COMES OFF THE PAYMENT PICKER, AND THE COUNT
-- ----------------------------------------------------------------------------
-- folio_payments.method allows 'other' and the front desk offers it, labelled
-- "Other". There is no account mapped to it and there must not be: 044 settled
-- that A MISSING MAPPING IS A LOUD FAILURE, NOT A SUSPENSE ACCOUNT. So once the
-- folio posts, the first "Other" payment raises resolve_account's refusal at the
-- counter with a guest standing there — the precise failure 044's header
-- describes for charge categories and already decided is unacceptable.
--
-- ASKED RATHER THAN ASSUMED, on the live database before writing this:
--
--     method   n   voided   first        last
--     cash     2   0        2026-08-02   2026-08-03
--
-- ZERO payments carry 'other'. Nothing to migrate, nothing to re-point, no
-- history to preserve — the fix is to stop offering a destination that does not
-- exist. The VALUE stays legal in the check constraint, because a database that
-- cannot represent what somebody typed last year is a worse database; it simply
-- comes off the screen. A hotel that needs cheque or mobile money gets a NAMED
-- method with its own account, which is a day's work when somebody asks for it.
--
-- The screen change travels in the same commit as this file. The column comment
-- in SECTION 6 is where somebody will look when they wonder why the constraint
-- allows a value the UI does not offer.
--
-- ----------------------------------------------------------------------------
-- 5. THE GUARD THAT COULD NEVER HAVE PASSED
-- ----------------------------------------------------------------------------
-- SECTION 1's backfill writes today's category key onto every existing charge,
-- and that is only correct while no category has ever been repointed — the same
-- assumption 058's backfill makes about rates, so it is asked the same way: of
-- change_log, refusing rather than assuming.
--
-- Written the obvious way, the guard was WRONG, and it was wrong in the
-- direction that looks like diligence. "Has charge_categories.account_role_key
-- ever changed?" returns ELEVEN on this database, so the guard refused and the
-- backfill stopped — and all eleven are 044's own backfill, at one instant
-- (2026-08-24 09:10:01.605), changed_by null, every one of them null ->
-- 'revenue_<code>'. The column being POPULATED, not a hotel changing its mind.
--
-- That guard would have refused on EVERY database that has ever run 044, which
-- is every database, forever. A guard that cannot pass is worse than no guard:
-- the next person does not delete it, they add the exception that gets them past
-- it, and the exception is what ships. It is the alarming-direction lie from
-- §7.13 — a harness that cries wolf costs a day, and it feels like rigour the
-- whole time it is happening.
--
-- So the guard asks the question it meant: a change whose old_value is NOT NULL,
-- which is a repoint from one key to another. On this database: ZERO, and the
-- backfill is correct. BOTH column names are checked, because 044 renamed
-- account_code to account_role_key and a repoint from before that rename would
-- be logged under the old name — a DDL rename moves the column and leaves the
-- log's field_name where it was.
--
-- ----------------------------------------------------------------------------
-- 6. WHAT THE BACKFILLS DO WITH THE AWKWARD ROWS, stated rather than implied
-- ----------------------------------------------------------------------------
--   A VOIDED CHARGE gets its key, same as any other. It is a row that existed
--   and will be read by a reversal path and by every report that groups by
--   revenue account; leaving it null would make the column nullable, which is
--   the whole guarantee gone for the sake of three rows.
--
--   A COUNTER CHARGE gets the key of the category it was posted under, which is
--   the original's category by construction (032). Live: one such row, laundry.
--
--   A CHARGE IN AN UNTAXED CATEGORY has no tax rows to touch and is not special
--   here; SECTION 4's backfill writes nothing for it, exactly as 058's capture
--   writes nothing. Zero rows is a real answer, not a failure.
--
--   A TAX ROW ON A RETIRED TAX keeps its captured code and gets its account
--   from that code. tax_charge_id is lineage only (058) and is not read.
--
-- ----------------------------------------------------------------------------
-- 7. THE ARITHMETIC THAT DECIDES SECTION 1'S SHAPE — AND IS NOT THIS FILE'S
-- ----------------------------------------------------------------------------
-- Capturing the key only pays if the wiring reads it correctly, and working out
-- what "correctly" means turned up a constraint on the entry 1.1h4 posts. It is
-- recorded here because it is WHY the key alone is enough, and because the
-- alternative reading leaves a residue that balances.
--
-- A charge's entry must be struck on GROSS and DISCOUNT as separate legs:
--
--     Dr guest_ledger          net + tax
--     Cr <account_role_key>    gross
--     Dr discounts_allowed     discount
--     Cr <tax accounts>        each captured tax amount
--
-- NOT on net. Worked on the laundry charge that is actually in this database —
-- gross 3,000, discount 200, net 2,800 — and its counter, which carries gross
-- -3,000, discount -200, net -2,800:
--
--   NET-BASED: the posting credits revenue 3,000 (discount is 0 at post time),
--   the discount act debits discounts_allowed 200, and the counter debits
--   revenue 2,800. Revenue is left holding 200 credit and discounts_allowed 200
--   debit, FOREVER. Each entry balances, the P&L nets to zero, the trial balance
--   is clean, and two accounts carry a residue of a charge that no longer
--   exists.
--
--   GROSS/DISCOUNT: the counter credits revenue -3,000 and debits
--   discounts_allowed -200. Both clear to zero exactly.
--
-- This also makes the gross/discount split the right one for the hotel: a P&L
-- that reads "revenue 3,000, discounts 200" is the one a manager can act on, and
-- "revenue 2,800" is the one that hides how much was given away.
--
-- AND IT SETTLES WHAT A DISCOUNT-REVERSAL COUNTER CAPTURES. Such a counter
-- carries gross 0 and discount -X, so its revenue leg is zero naira and its
-- captured key is never read for an amount; it still captures the ORIGINAL'S
-- key, because that is what the row honestly is — a laundry line — and every
-- report that groups charges by revenue account reads that column. Capturing
-- 'discounts_allowed' there would make the row describe its ENTRY rather than
-- itself, and a laundry line would go missing from laundry.
--
-- The entry shape is 1.1h4's to write. It is stated here so the capture can be
-- judged against it rather than taken on trust.
--
-- ----------------------------------------------------------------------------
-- 8. THE PATTERN FROM 058, NOW AT A THIRD SITE
-- ----------------------------------------------------------------------------
-- 058 named it from two comments, in folio.ts and in 032. Both stated a goal and
-- then described a mechanism that defeated it:
--
--   IF THE SENTENCE PROMISES STABILITY AND THE MECHANISM PROMISES FRESHNESS,
--   ONE OF THE TWO IS A LIE, AND IT IS NEVER THE MECHANISM.
--
-- and why such a comment survives a reading:
--
--   A COMMENT THAT IS HALF RIGHT IN THE REASSURING DIRECTION GETS AGREED WITH.
--
-- The third site is in this repository now, and it is 032's own comment on the
-- insert in post_charge_reversal:
--
--   "THE ORIGINAL'S CATEGORY, ALWAYS. It is what makes the tax reverse with the
--    charge ... so a counter posted under the same category attracts exactly the
--    same taxes at exactly the same rates"
--
-- 058 fixed the RATES half and left the sentence standing. It is still half
-- right in the reassuring direction: the same category does fix which taxes
-- apply, and after 058 the counter does carry the same rates — but for a reason
-- the comment does not give, and the comment's reason is now also wrong about
-- the ACCOUNT, which is what this file captures. Rewritten in SECTION 2 to say
-- what the mechanism actually does.
--
-- ----------------------------------------------------------------------------
-- 9. WHAT THE BREAKAGES WENT RED FOR (rule 27)
-- ----------------------------------------------------------------------------
-- Fourteen mutations, each valid SQL that changes behaviour. All fourteen red:
--
--   A  post_charge DERIVES the key from the code instead of capturing it
--        -> 2: the charge captured revenue_zz059; the category says
--           revenue_misc. The fixture's whole purpose, in one line.
--   B  post_charge_reversal reads the CATEGORY — what it did before this file
--        -> 3: the counter carries revenue_room rather than revenue_misc, so
--           the pair posts to two accounts and neither ever clears
--   N  a discount-reversal counter captures discounts_allowed instead
--        -> 4: the laundry line files itself under discounts_allowed
--   C  capture INFERS the tax account from applies_to — what 1.1h4 would have
--      done with no column to read
--        -> 5: the levy reads vat_output; the tax says service_charge_payable
--   D  restate drops account_role_key from its jsonb_to_recordset column list
--        -> 23502, a NOT NULL violation. THE OMISSION THAT HAS NO COMPILE
--           ERROR: a key left out of that list is silently NULL, and the NOT
--           NULL is the only thing standing between it and an unposted tax leg
--   E  restate re-reads the LIVE tax account
--        -> 6: the counter's tax row reads vat_output, not the source's
--   F  SECTION 1's backfill is dropped
--        -> 23502 on the ALTER: the column contains nulls
--   G  the backfill writes one key to every charge
--        -> 1: 3 of 3 charges carry an account that is not their category's
--   H  THE REPOINT GUARD LOSES `old_value is not null`
--        -> PT409, refusing over 044's own eleven null -> value rows. This
--           breakage is the guard that was WRITTEN FIRST; see §5
--   I  the tax map forgets VAT
--        -> PT422 "Cannot decide which account these taxes are owed to:
--           vat/taxable"
--   J  the two renamed-column readers are not re-emitted
--        -> 9: inventory_gl_reconciliation will not run (column
--           pfs.gl_wired_at does not exist). THE VIEW SURVIVES ON ITS OWN —
--           Postgres stores a view as a parsed tree and follows a column
--           rename, so only the FUNCTION, whose body is text, actually breaks.
--           The view is re-emitted anyway, because the file would otherwise
--           hold a definition that disagrees with the database
--   K  folio_gl_wired_at is stamped
--        -> 10: 1 property claims a folio wiring instant
--   L  the NOT NULL on folio_charges.account_role_key is skipped
--        -> 12: a charge accepted a NULL account
--   M  post_charge's rewritten lookup loses its refusal
--        -> 8: refused by the wrong thing — 23502, 'null value in column
--           "account_role_key"'
--
-- M IS THE ONE WORTH READING, because it was GREEN first and the assertion was
-- the broken thing. Written as `exception when others then null`, assertion 8
-- passed with the refusal deleted: v_role_key stays NULL, the insert dies on the
-- NOT NULL three lines later, something raised, and the proof agreed. The code
-- was wrong, the guard was gone, and what the front desk would have met is
-- 'null value in column "account_role_key"' instead of the sentence naming the
-- retired category. The assertion now reads the SQLSTATE and the message. That
-- is the fifth time on this project that breaking the code has revealed the
-- assertion rather than the defect, and the shape is new: not a total
-- insensitive to the rule, not a fixture already in the asserted state, but AN
-- ASSERTION SATISFIED BY ANY FAILURE AT ALL. `when others then null` proves
-- that something went wrong, which is not the same as proving the right thing
-- refused.
--
-- A SECOND ASSERTION WAS WRONG IN THE OTHER DIRECTION and is worth the same
-- line: assertion 4 first posted charge B AFTER the repoint and went red
-- against correct code, because revenue_room was then charge B's honest
-- captured answer. The obvious repair — compare the counter to charge B's own
-- key — would have been green and untestable, since the two strings were
-- identical and reading the original was indistinguishable from reading the
-- category. Charge B is now posted BEFORE the repoint, which is the only
-- arrangement where the two readings differ.
--
-- ----------------------------------------------------------------------------
-- 10. WHAT THIS FILE DELIBERATELY DOES NOT DO
-- ----------------------------------------------------------------------------
--   * It posts nothing. No journal entry, no trigger that posts, no
--     reconciliation of the guest ledger. All of that is 1.1h4.
--   * It does not stamp folio_gl_wired_at or give it a default. Null is true
--     today and 1.1h4 makes it false.
--   * It does not add an account for folio_payments.method = 'other'. The
--     methods that exist have accounts; 'other' comes off the screen instead.
--   * It does not touch charge_categories.account_role_key's admin UPDATE
--     policy. Repointing stays legal — capture is what makes it harmless.
--
-- RE-RUNNABLE. Applying this file twice is a clean no-op: every add is
-- `if not exists`, every backfill is `where ... is null`, every function is
-- `create or replace`, and the rename is guarded on information_schema.
-- ============================================================================


-- ############################################################################
-- SECTION 1 — folio_charges.account_role_key
-- ############################################################################

alter table folio_charges
  add column if not exists account_role_key text;

comment on column folio_charges.account_role_key is
  'THE ACCOUNT THIS CHARGE''S REVENUE POSTS TO, captured when it was posted and '
  'never re-resolved. Copied from charge_categories.account_role_key by '
  'post_charge, and from THE ORIGINAL CHARGE by post_charge_reversal. '
  'charge_categories.account_role_key has an admin UPDATE policy, so a hotel '
  'repointing a category after a charge was posted would otherwise have the '
  'charge debit one revenue account and its reversal credit another — both '
  'entries balancing, the trial balance clean, two accounts left holding equal '
  'and opposite residues nothing can clear. Same decision as 058''s captured tax '
  'rate, booking_nights'' nightly rate and stock_movements.carried_unit_cost: a '
  'fact captured when it was true. NOT A CACHE (rule 6) — the category''s '
  'CURRENT key is a different fact that happens to share a name, and there is no '
  'recompute function because a correct one cannot exist. The DISCOUNT leg''s '
  'account is not here: it is the single role key discounts_allowed on every '
  'charge in every category, so there is nothing per-row to capture.';

-- ----------------------------------------------------------------------------
-- 1.1 THE ASSUMPTION, ASKED RATHER THAN ASSUMED
-- ----------------------------------------------------------------------------
-- The backfill below writes TODAY's category key onto charges posted in the
-- past, which is only correct while no category has ever been repointed. 058
-- asked change_log the same kind of question about rates; this asks it about
-- keys, and refuses rather than assuming.
--
-- old_value IS NOT NULL IS THE WHOLE POINT OF THE PREDICATE. Without it this
-- counts 044's own backfill — eleven rows, one instant, null -> 'revenue_<code>'
-- — and refuses on every database that has ever run 044, which is every
-- database, forever. See the header, §5: a guard that cannot pass does not get
-- deleted, it gets an exception, and the exception is what ships.
--
-- BOTH COLUMN NAMES, because 044 renamed account_code to account_role_key and a
-- DDL rename does not rewrite change_log.field_name, so a repoint from before
-- that rename is on record under the old name.
do $$
declare
  v_repoints integer;
  v_detail   text;
begin
  select count(*)::integer into v_repoints
  from change_log
  where table_name = 'charge_categories'
    and field_name in ('account_role_key', 'account_code')
    and old_value is not null;

  if v_repoints > 0 then
    select string_agg(
             format('%s: %s -> %s on %s',
                    coalesce(cc.code, cl.row_id::text),
                    cl.old_value, cl.new_value, cl.changed_at::date),
             '; ' order by cl.changed_at)
      into v_detail
    from change_log cl
    left join charge_categories cc on cc.id = cl.row_id
    where cl.table_name = 'charge_categories'
      and cl.field_name in ('account_role_key', 'account_code')
      and cl.old_value is not null;

    raise exception
      'Cannot backfill folio_charges.account_role_key: % charge categor(ies) have been repointed, so today''s key is not what past charges posted to. %',
      v_repoints, coalesce(v_detail, '(the repoints are in change_log; this message could not summarise them)')
      using errcode = 'PT409',
            hint = 'Each repoint needs a decision about which charges keep the old key. Decide that before this migration, not inside it.';
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 1.2 Backfill
-- ----------------------------------------------------------------------------
-- EVERY charge, voided and counter rows included — see the header, §6. The
-- category is joined WITHOUT a deleted_at filter, the same inversion 021 and 058
-- document: retiring the "minibar" category next year must not leave every
-- historical minibar charge with no account.
--
-- `where account_role_key is null` makes a second run a no-op AND makes this
-- safe to re-run after 1.1h4 has posted: it can never move a key off a charge
-- whose entry is already in the books.
update folio_charges fc
   set account_role_key = cc.account_role_key
  from charge_categories cc
 where cc.id = fc.charge_category_id
   and fc.account_role_key is null;

-- ----------------------------------------------------------------------------
-- 1.3 Then it is required
-- ----------------------------------------------------------------------------
-- NOT NULL is the point of the column: a charge with no account is a charge the
-- wiring cannot post, discovered at the moment somebody tries. The non-blank
-- check is 044's lesson on charge_categories — NOT NULL alone admits '' and ' ',
-- which resolve_account would then refuse with a confusing message about an
-- empty role key.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'folio_charges'
      and column_name  = 'account_role_key'
      and is_nullable  = 'YES'
  ) then
    alter table folio_charges alter column account_role_key set not null;
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'folio_charges_account_role_key_check'
  ) then
    alter table folio_charges
      add constraint folio_charges_account_role_key_check
      check (btrim(account_role_key) <> '');
  end if;
end $$;

-- The reports that will group a period's revenue by account.
create index if not exists folio_charges_account_role_key_idx
  on folio_charges (property_id, charge_date, account_role_key);

-- ############################################################################
-- SECTION 2 — THE TWO WRITERS THAT CREATE A CHARGE ROW CAPTURE IT
-- ############################################################################
-- Both rebuilt from their LIVE text. The only changes in each are the capture
-- itself and the comments around it; every guard, every idempotency path and
-- every refusal is carried through untouched and asserted by SECTION 7.
--
-- apply_charge_discount is NOT here and does not need to be: it rewrites a
-- charge's discount and net, never its category, so the account it posts to is
-- unchanged by definition. Its own leg is discounts_allowed, which is not a
-- per-row fact (header §1).

-- ---- 2.1 post_charge -------------------------------------------------------
CREATE OR REPLACE FUNCTION public.post_charge(p_folio_id uuid, p_charge_category_id uuid, p_description text, p_quantity numeric, p_unit_amount numeric, p_charge_date date, p_idempotency_key text, p_source text DEFAULT 'manual'::text)
 RETURNS folio_charges
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_folio    folios;
  v_tenant   uuid;
  v_timezone text;
  v_date     date;
  v_gross    numeric(14,2);
  v_existing folio_charges;
  v_charge   folio_charges;
  v_role_key text;
  v_actor    uuid := auth.uid();
begin
  select * into v_folio from folios where id = p_folio_id;
  if not found then
    raise exception 'Folio % not found', p_folio_id using errcode = 'no_data_found';
  end if;
  v_tenant := v_folio.tenant_id;

  -- Staff gate (rule 19): posting a charge is front-desk / F&B / housekeeping
  -- work, not an admin act.
  if not is_tenant_staff(v_tenant) then
    raise exception 'Not authorised to post charges for this tenant'
      using errcode = 'insufficient_privilege';
  end if;

  -- IDEMPOTENCY fast path (rules 2 & 3): a retry or double-click with the same key
  -- returns the SAME charge. folio_charges_idem_uniq is the real guard under
  -- concurrency and is handled in the exception block below.
  if p_idempotency_key is not null then
    select * into v_existing
    from folio_charges
    where tenant_id = v_tenant and idempotency_key = p_idempotency_key
    limit 1;
    if found then
      return v_existing;
    end if;
  end if;

  -- A folio that is settled or closed does not take new charges. (A late charge
  -- on a departed guest is a real situation; it is handled by re-opening the
  -- folio in the checkout flow, which is a decision with an audit trail, not a
  -- silent posting into a closed bill.)
  if v_folio.status <> 'open' then
    raise exception 'Folio % is % and cannot take new charges', p_folio_id, v_folio.status
      using errcode = 'check_violation';
  end if;

  -- The category must belong to THIS tenant and be live and active. The composite
  -- FK enforces the tenant part structurally; this gives a clear error instead of
  -- a raw FK violation, and additionally blocks a retired category.
  --
  -- 059: AND IT HANDS BACK THE ACCOUNT, in the same query. The check and the
  -- capture are one lookup on purpose: two lookups of the same row can return
  -- different answers under a concurrent repoint, and the one that decided the
  -- charge was postable must be the one that says where it posts.
  select cc.account_role_key into v_role_key
  from charge_categories cc
  where cc.id = p_charge_category_id
    and cc.tenant_id = v_tenant
    and cc.deleted_at is null              -- rule 5
    and cc.is_active = true;
  if not found then
    raise exception 'Charge category % is not available for this tenant', p_charge_category_id
      using errcode = 'no_data_found';
  end if;

  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Quantity must be greater than zero' using errcode = 'check_violation';
  end if;
  if p_unit_amount is null or p_unit_amount < 0 then
    raise exception 'Unit amount cannot be negative' using errcode = 'check_violation';
  end if;

  -- Business date (rule 12), property-local. Same computation as 020's past-date
  -- guard, from the property's own timezone, with the same defensive fallback.
  if p_charge_date is not null then
    v_date := p_charge_date;
  else
    select p.timezone into v_timezone from properties p where p.id = v_folio.property_id;
    v_date := (now() at time zone coalesce(nullif(btrim(v_timezone), ''), 'Africa/Lagos'))::date;
  end if;

  -- gross = quantity x unit, rounded to money precision ONCE, here. quantity is
  -- numeric(14,4) precisely so a 0.0250 kg recipe line does not round to zero
  -- before it is multiplied out (§6).
  v_gross := round(p_quantity * p_unit_amount, 2);

  -- Posted with NO discount: discount is a separate, accountable act
  -- (apply_charge_discount), never something the posting call can smuggle in.
  begin
    insert into folio_charges (
      tenant_id, property_id, folio_id, charge_category_id,
      description, quantity, unit_amount,
      gross_amount, discount_amount, net_amount,
      charge_date, source, idempotency_key, account_role_key, created_by
    ) values (
      v_tenant, v_folio.property_id, p_folio_id, p_charge_category_id,
      p_description, p_quantity, p_unit_amount,
      v_gross, 0, v_gross,
      v_date, coalesce(nullif(btrim(p_source), ''), 'manual'), p_idempotency_key,
      -- 059: WHERE THIS CHARGE POSTS IS DECIDED NOW AND NEVER AGAIN. The
      -- category can be repointed tomorrow; this charge and its reversal will
      -- still meet in the account they were struck in.
      v_role_key,
      v_actor
    )
    returning * into v_charge;
  exception
    when unique_violation then
      -- A CONCURRENT call with the same key won the race (folio_charges_idem_uniq).
      -- Return its row rather than creating a second charge (rule 2).
      if p_idempotency_key is not null then
        select * into v_existing
        from folio_charges
        where tenant_id = v_tenant and idempotency_key = p_idempotency_key
        limit 1;
        if found then
          return v_existing;
        end if;
      end if;
      raise;
  end;

  -- 058: WHAT THIS CHARGE IS TAXED IS DECIDED NOW AND NEVER AGAIN. Before
  -- this, every tax figure on every bill was derived from whatever the live
  -- rate happened to be when somebody looked, so one UPDATE rewrote the tax
  -- on every bill the hotel had ever issued.
  --
  -- Zero rows is a normal answer (a category that is neither taxable nor
  -- service-chargeable) and is NOT checked for, because treating it as a
  -- failure would refuse to post a deposit.
  perform capture_charge_taxes(v_charge.id);

  return v_charge;
end;
$function$;

-- ---- 2.2 post_charge_reversal ----------------------------------------------
CREATE OR REPLACE FUNCTION public.post_charge_reversal(p_original_id uuid, p_target_type text, p_gross numeric, p_discount numeric, p_description text, p_charge_date date, p_idempotency_key text)
 RETURNS folio_charges
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
      charge_date, source, idempotency_key, account_role_key,
      reversal_of_charge_id, reversal_target_type, created_by
    ) values (
      v_original.tenant_id, v_original.property_id, v_original.folio_id,
      -- THE ORIGINAL'S CATEGORY, ALWAYS — and the reason is NOT the one this
      -- comment used to give. Its old text said the category "attracts exactly
      -- the same taxes at exactly the same rates", which was half right in the
      -- reassuring direction and is why it was agreed with for a year: the same
      -- category does fix WHICH taxes apply, and it never fixed the RATE. 058
      -- moved that onto the row; 059 moves the account. What the category
      -- decides here now:
      --
      --   WHICH TAXES AND AT WHAT RATE — no longer this. They come from the
      --     original's captured tax rows, restated at the bottom of this
      --     function.
      --   WHICH ACCOUNT THE REVENUE UNWINDS FROM — no longer this either. It
      --     comes from the original's captured account_role_key, below.
      --   HOW THE LINE READS — this, and only this. A laundry reversal belongs
      --     under laundry on the bill, in the folio screens and in every report
      --     that groups by category. That is the whole of its job, and it is
      --     worth keeping.
      v_original.charge_category_id,
      p_description,
      1,                        -- one unit of a negative amount
      p_gross,                  -- quantity 1, so unit = gross by construction
      p_gross, p_discount, p_gross - p_discount,
      p_charge_date,            -- TODAY's operating day, never the original's
      'reversal',               -- provenance (021 §5: free text on purpose)
      p_idempotency_key,
      -- 059: THE ORIGINAL'S ACCOUNT, NOT THE CATEGORY'S CURRENT ONE. If the
      -- category was repointed between the charge and this reversal, the counter
      -- must unwind the account the original actually hit; reading the category
      -- here would credit one revenue account and debit another, both entries
      -- balancing, neither ever clearing. Same reading as the restate below
      -- taking the original's RATES rather than today's.
      --
      -- A DISCOUNT reversal carries gross 0, so no naira flows through this
      -- account on that path — and it still records the original's, because that
      -- is what the row IS. A laundry line recording 'discounts_allowed' here
      -- would describe its journal entry instead of itself, and would go missing
      -- from laundry in every report that groups by revenue account.
      v_original.account_role_key,
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

  -- 058: THE COUNTER IS TAXED AT THE ORIGINAL'S RATES, NOT TODAY'S. The
  -- comment on the insert above says a counter "attracts exactly the same
  -- taxes at exactly the same rates" because it is posted under the same
  -- category. That was true of the taxes and FALSE of the rates: before this
  -- line it attracted them at whatever the property charges now, so
  -- reversing a charge from before a rate change left a tax residue and the
  -- pair did not net to zero. An audit trail failing at the one thing it is
  -- for.
  --
  -- The counter's own net is the basis, which is right for BOTH callers
  -- without a branch: negative for a charge reversal, positive for a discount
  -- reversal. And because Postgres rounds numeric half AWAY FROM ZERO,
  -- round(-x * r, 2) = -round(x * r, 2) exactly, so the pair cancels to the
  -- kobo rather than to within one.
  perform restate_charge_taxes(v_counter.id, p_original_id);

  return v_counter;
end;
$function$;

-- ############################################################################
-- SECTION 3 — tax_charges.account_role_key
-- ############################################################################

alter table tax_charges
  add column if not exists account_role_key text;

comment on column tax_charges.account_role_key is
  'THE ACCOUNT THIS TAX IS OWED TO — an account_mappings role key (rule 4), '
  'never a GL code. SEPARATE FROM applies_to AND NOT DERIVABLE FROM IT: '
  'applies_to answers "which charges does this apply to" (a tax the law levies '
  'vs a surcharge the hotel levies), which decided the account only while there '
  'was exactly one tax on each side. A Rivers State consumption tax is also '
  '''taxable'' and a tray charge is also ''service_chargeable''; inferring from '
  'applies_to would book either into an account belonging to somebody else and '
  'RECONCILE PERFECTLY doing it — money owed to one authority sitting in the '
  'ledger line for another, with every total correct. REQUIRED, and the trigger '
  'below refuses a key nothing is mapped to, so the refusal lands on whoever '
  'configures the tax rather than on the front desk.';

-- ----------------------------------------------------------------------------
-- 3.1 THE MAP, THE GUARD AND THE BACKFILL, IN ONE BLOCK
-- ----------------------------------------------------------------------------
-- They share one VALUES list because they must not disagree: a guard that
-- approves a code the backfill then cannot map, or the reverse, is worse than
-- either alone. Two copies of a two-row table is exactly how that happens.
--
-- WHAT THE MAP KNOWS, and it is deliberately only what 021 can create:
--   ('vat',     'taxable')            -> vat_output
--   ('service', 'service_chargeable') -> service_charge_payable
--
-- ANYTHING ELSE IS REFUSED, not guessed. A hotel that has added its own tax has
-- made a decision nobody else can reconstruct: a tray charge is hotel income and
-- belongs in revenue, a state consumption tax is a liability to a different
-- authority, and both are 'service_chargeable'/'taxable' respectively. Guessing
-- would put real money in the wrong account silently, which is the whole defect
-- this section exists to prevent — so the migration stops and names the row.
--
-- ASKED OF THE LIVE DATABASE BEFORE WRITING THIS: one tax row exists (Heledon,
-- code 'vat', applies_to 'taxable', rate 0.0760) and one distinct captured code
-- ('vat', 'taxable', 3 rows). Both map. change_log holds NOTHING for tax_charges
-- at all, which is also what SECTION 4's backfill depends on.
do $$
declare
  v_unknown text;
  v_changed integer;
begin
  -- ---- the guard: every code that exists, live or captured, must be mappable
  select string_agg(distinct format('%s/%s', u.code, u.applies_to), ', ')
    into v_unknown
  from (
    select tc.code, tc.applies_to from tax_charges tc
    union
    select fct.code, fct.applies_to from folio_charge_tax_lines fct
  ) u
  left join (values
    ('vat',     'taxable',            'vat_output'),
    ('service', 'service_chargeable', 'service_charge_payable')
  ) as m(code, applies_to, role_key)
    on m.code = u.code and m.applies_to = u.applies_to
  where m.role_key is null;

  if v_unknown is not null then
    raise exception
      'Cannot decide which account these taxes are owed to: %. Nothing maps them, and guessing would book real money into an account belonging to somebody else.',
      v_unknown
      using errcode = 'PT422',
            hint = 'Set tax_charges.account_role_key by hand for each of those, then re-run this migration. A surcharge the hotel keeps is revenue; a tax collected for an authority is a liability to that authority.';
  end if;

  -- ---- the backfill, from the same list
  update tax_charges tc
     set account_role_key = m.role_key
    from (values
      ('vat',     'taxable',            'vat_output'),
      ('service', 'service_chargeable', 'service_charge_payable')
    ) as m(code, applies_to, role_key)
   where m.code = tc.code
     and m.applies_to = tc.applies_to
     and tc.account_role_key is null;

  -- ---- and the dependency SECTION 4 rests on, proven here while the map is
  -- in view: no tax has ever had its code or its applies_to changed, so a
  -- captured row's tax_charge_id still points at a row carrying the same code,
  -- and SECTION 4 may read the account through that lineage once.
  select count(*)::integer into v_changed
  from change_log
  where table_name = 'tax_charges'
    and field_name in ('code', 'applies_to');

  if v_changed > 0 then
    raise exception
      'A tax has had its code or applies_to changed (% logged), so a captured tax row''s lineage no longer identifies the account it was owed to.',
      v_changed
      using errcode = 'PT409',
            hint = 'Set folio_charge_tax_lines.account_role_key by hand for the affected rows before re-running, using what the tax was at the time rather than what it is now.';
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 3.2 Then it is required
-- ----------------------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'tax_charges'
      and column_name  = 'account_role_key'
      and is_nullable  = 'YES'
  ) then
    alter table tax_charges alter column account_role_key set not null;
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'tax_charges_account_role_key_check'
  ) then
    alter table tax_charges
      add constraint tax_charges_account_role_key_check
      check (btrim(account_role_key) <> '');
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 3.3 The guard: the key must actually be mapped
-- ----------------------------------------------------------------------------
-- 044's enforce_charge_category_account, applied to the other side of the bill,
-- and the reasoning transfers whole: NOT NULL alone lets somebody type a key
-- nothing resolves, which fails at the front desk exactly as before. The TENANT
-- DEFAULT only, for 044's reason — a property override is an override of
-- something, and requiring one per property would make a four-hotel group do the
-- same work four times.
create or replace function enforce_tax_charge_account()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.account_role_key is null or btrim(new.account_role_key) = '' then
    raise exception
      'A tax must say which account it is owed to.'
      using errcode = 'PT422',
            hint = 'Open Settings, then Accounts, and choose the account for this tax. A tax the hotel collects for an authority is a liability to that authority; a surcharge the hotel keeps is revenue.';
  end if;

  if tg_op = 'UPDATE'
     and new.account_role_key is not distinct from old.account_role_key then
    return new;                       -- unchanged: nothing to re-check
  end if;

  if not exists (
    select 1
    from account_mappings am
    join accounts a
      on a.id = am.account_id
     and a.tenant_id = am.tenant_id
    where am.tenant_id = new.tenant_id
      and am.property_id is null
      and am.role_key = new.account_role_key
      and a.deleted_at is null
      and a.is_active
  ) then
    raise exception
      'Nothing is mapped to "%", so this tax could not be posted.',
      new.account_role_key
      using errcode = 'PT424',
            hint = 'Open Settings, then Accounts, and map that role key to an account first. A tax that cannot be posted should not be on a bill.';
  end if;

  return new;
end;
$$;

comment on function enforce_tax_charge_account() is
  'Refuses a tax whose account_role_key is blank or unmapped, at the moment it is '
  'created or the key is changed — so the refusal lands on the person '
  'configuring the hotel rather than on the front desk in front of a guest. The '
  'twin of enforce_charge_category_account (044 §8.4), same reasoning, other side '
  'of the bill. Checks the TENANT DEFAULT only.';

drop trigger if exists enforce_tax_charge_account_trigger on tax_charges;
create trigger enforce_tax_charge_account_trigger
  before insert or update on tax_charges
  for each row execute function enforce_tax_charge_account();

revoke all on function enforce_tax_charge_account() from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 3.4 seed_tax_charges sets it, so a new property is complete on first insert
-- ----------------------------------------------------------------------------
-- Re-emitted whole from its live text. TWO CHANGES: it sets account_role_key,
-- and it calls seed_account_mappings first.
--
-- WHY IT CALLS THE SEED. This is 044 §8.2's reasoning arriving one table later.
-- 3.3's trigger now refuses a tax whose key is unmapped, and seed_tax_charges
-- fires from `after insert on properties` while seed_account_mappings fires from
-- `after insert on tenants`. The tenant's triggers do run first today — a
-- property cannot exist before its tenant — but that makes the ordering LUCKY
-- rather than guaranteed, and the failure mode is a property insert refusing for
-- a reason three files away. seed_account_mappings is idempotent, so calling it
-- makes the order irrelevant instead.
create or replace function seed_tax_charges(p_property_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant_id uuid;
  v_vat_rate  numeric(5,4);
begin
  select p.tenant_id into v_tenant_id
  from properties p where p.id = p_property_id;

  if v_tenant_id is null then
    raise exception 'seed_tax_charges: property % not found', p_property_id
      using errcode = 'no_data_found';
  end if;

  -- 059: the account this tax is owed to must be mapped before the tax exists.
  perform seed_account_mappings(v_tenant_id);

  select ts.default_vat_rate into v_vat_rate
  from tenant_settings ts where ts.tenant_id = v_tenant_id;

  if v_vat_rate is null then
    raise exception
      'seed_tax_charges: tenant % has no tenant_settings row, so the VAT rate cannot be resolved',
      v_tenant_id using errcode = 'no_data_found';
  end if;

  insert into tax_charges
    (tenant_id, property_id, code, name, rate, is_compulsory, applies_to,
     display_order, account_role_key)
  select v_tenant_id, p_property_id, 'vat', 'VAT', v_vat_rate, true, 'taxable', 10,
         -- 059: VAT is collected FOR the FIRS, so it is a liability to the FIRS
         -- and never revenue. A role key, not a code (rule 4).
         'vat_output'
  where not exists (
    select 1 from tax_charges tc
    where tc.property_id = p_property_id
      and tc.code = 'vat'
      and tc.deleted_at is null
  );
end;
$$;

comment on function seed_tax_charges(uuid) is
  'Seeds a property''s compulsory VAT row, with the rate READ from '
  'tenant_settings.default_vat_rate — never a literal (rule 17) — and the '
  'account_role_key vat_output, because VAT is collected for the FIRS and is a '
  'liability to the FIRS. Service/tray charges are NOT seeded: they are the '
  'hotel''s own decision to add, and each brings its own account. Calls '
  'seed_account_mappings first (idempotent), so 059''s account guard cannot '
  'refuse a property insert over two triggers'' firing order. Idempotent.';

-- ############################################################################
-- SECTION 4 — THE CAPTURED TAX ROWS CARRY THE ACCOUNT TOO
-- ############################################################################
-- 058 captured the rate, the label, the basis and the applicability rule, and
-- left the account to be inferred — because there was no account to capture.
-- Now there is, and it is captured for the identical reason: a bill from before
-- the hotel reorganises its liabilities must still say which account its VAT was
-- owed to, or the reversal of that charge unwinds a different one.

alter table folio_charge_tax_lines
  add column if not exists account_role_key text;

comment on column folio_charge_tax_lines.account_role_key is
  'THE ACCOUNT THIS TAX WAS OWED TO, captured with the rate and never '
  're-resolved. Copied from tax_charges.account_role_key by capture, and from '
  'THE SOURCE CHARGE''S ROWS by restate — so a counter charge unwinds the '
  'liability its original created rather than whichever account that tax points '
  'at today. Completes 058: the rate, the label, the basis, the applicability '
  'and now the destination are all facts of the moment the charge was posted.';

-- ----------------------------------------------------------------------------
-- 4.1 Backfill, through the lineage, ONCE, with the dependency already proven
-- ----------------------------------------------------------------------------
-- 058 is explicit that tax_charge_id is lineage only and that nothing on the row
-- is read through it — which is what lets a captured row survive its tax being
-- re-rated or retired. This reads through it exactly once, in a migration, and
-- the exception is a stated one rather than a quiet one:
--
--   * The account being written did not exist until SECTION 3 of this same file,
--     so there is no earlier value for any row to have captured. There is
--     nothing for the lineage to contradict.
--   * SECTION 3 proved, of change_log, that no tax has ever had its code or its
--     applies_to changed. So the row the lineage points at still carries the code
--     this row captured, and the parent's key is the key this row would have
--     captured. If that had NOT held, SECTION 3 refused before reaching here.
--   * From the next posting onward nothing reads the lineage again: capture
--     writes the column and restate carries it.
--
-- The FK has no ON DELETE CASCADE for the tax side, so a hard-deleted tax is
-- impossible and this join can never miss a row. A SOFT-deleted tax is still
-- present and still answers, which is the point of a soft delete.
update folio_charge_tax_lines fct
   set account_role_key = tc.account_role_key
  from tax_charges tc
 where tc.id = fct.tax_charge_id
   and fct.account_role_key is null;

-- ----------------------------------------------------------------------------
-- 4.2 Then it is required
-- ----------------------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'folio_charge_tax_lines'
      and column_name  = 'account_role_key'
      and is_nullable  = 'YES'
  ) then
    alter table folio_charge_tax_lines alter column account_role_key set not null;
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'folio_charge_tax_lines_account_role_key_check'
  ) then
    alter table folio_charge_tax_lines
      add constraint folio_charge_tax_lines_account_role_key_check
      check (btrim(account_role_key) <> '');
  end if;
end $$;

-- The tax return: "what did this property owe each authority in October?"
create index if not exists folio_charge_tax_lines_account_idx
  on folio_charge_tax_lines (property_id, business_date, account_role_key);

-- ---- 4.3 capture_charge_taxes ----------------------------------------------
-- Rebuilt from its live text; the only change is the captured column.
CREATE OR REPLACE FUNCTION public.capture_charge_taxes(p_charge_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_charge folio_charges;
  v_cat    charge_categories;
  v_n      integer;
begin
  select * into v_charge from folio_charges where id = p_charge_id;
  if not found then
    raise exception 'Charge % not found', p_charge_id using errcode = 'PT404';
  end if;

  select * into v_cat from charge_categories where id = v_charge.charge_category_id;
  if not found then
    raise exception 'Charge % has no category, so its tax cannot be captured', p_charge_id
      using errcode = 'PT500',
            hint = 'This is an internal guard: folio_charges.charge_category_id is not null and has a foreign key, so reaching it means something deleted a category row out from under a charge.';
  end if;

  insert into folio_charge_tax_lines (
    tenant_id, property_id, folio_charge_id, tax_charge_id,
    code, name, applies_to, calculation, rate,
    taxable_amount, amount, display_order, business_date, account_role_key,
    created_by
  )
  select v_charge.tenant_id, v_charge.property_id, v_charge.id, tc.id,
         tc.code, tc.name, tc.applies_to, 'exclusive', tc.rate,
         v_charge.net_amount,
         round(v_charge.net_amount * tc.rate, 2),
         tc.display_order, v_charge.charge_date,
         -- 059: WHO THIS TAX IS OWED TO, captured with the rate. The same
         -- argument the rate made: tax_charges.account_role_key can be
         -- repointed, and a charge reversed afterwards would unwind a different
         -- liability than the one it created.
         tc.account_role_key,
         auth.uid()
  from tax_charges tc
  where tc.property_id = v_charge.property_id
    and tc.deleted_at is null              -- rule 5
    and tc.is_active = true
    and (
         (tc.applies_to = 'taxable'            and v_cat.is_taxable)
      or (tc.applies_to = 'service_chargeable' and v_cat.service_chargeable)
    );

  get diagnostics v_n = row_count;
  return v_n;
end;
$function$;

-- ---- 4.4 restate_charge_taxes ----------------------------------------------
-- Rebuilt from its live text. TWO changes, and the second is the one that would
-- be missed: the column is added to the insert AND to the jsonb_to_recordset
-- column list. A key left out of that list is silently NULL rather than a
-- compile error, and the NOT NULL above is what turns that omission into a loud
-- failure instead of an unposted tax leg.
CREATE OR REPLACE FUNCTION public.restate_charge_taxes(p_charge_id uuid, p_source_charge_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_charge folio_charges;
  v_src    jsonb;
  v_n      integer;
begin
  select * into v_charge from folio_charges where id = p_charge_id;
  if not found then
    raise exception 'Charge % not found', p_charge_id using errcode = 'PT404';
  end if;

  -- THE SOURCE IS SNAPSHOTTED BEFORE THE DELETE, and that is not defensive
  -- tidiness: apply_charge_discount passes the charge as its OWN source, so
  -- deleting first would destroy the very rows this is about to read. The first
  -- version of this function did exactly that and left every discounted charge
  -- with no tax at all -- a bill that quietly loses its VAT the moment somebody
  -- is generous. Caught by assertion 3, which is why that assertion discounts
  -- rather than only posting.
  select jsonb_agg(to_jsonb(t)) into v_src
  from folio_charge_tax_lines t
  where t.folio_charge_id = p_source_charge_id;

  delete from folio_charge_tax_lines where folio_charge_id = p_charge_id;

  insert into folio_charge_tax_lines (
    tenant_id, property_id, folio_charge_id, tax_charge_id,
    code, name, applies_to, calculation, rate,
    taxable_amount, amount, display_order, business_date, account_role_key,
    created_by
  )
  select v_charge.tenant_id, v_charge.property_id, v_charge.id, src.tax_charge_id,
         src.code, src.name, src.applies_to, src.calculation, src.rate,
         v_charge.net_amount,
         round(v_charge.net_amount * src.rate, 2),
         src.display_order, v_charge.charge_date,
         -- 059: THE SOURCE'S ACCOUNT, carried through for the reason its RATE is.
         -- A counter charge must unwind the liability the original created, not
         -- whichever account that tax points at today.
         src.account_role_key,
         auth.uid()
  from jsonb_to_recordset(coalesce(v_src, '[]'::jsonb)) as src(
    tax_charge_id uuid, code text, name text, applies_to text,
    calculation text, rate numeric, display_order integer,
    account_role_key text);

  get diagnostics v_n = row_count;
  return v_n;
end;
$function$;

revoke all on function capture_charge_taxes(uuid)       from public, anon, authenticated;
revoke all on function restate_charge_taxes(uuid, uuid) from public, anon, authenticated;

-- ############################################################################
-- SECTION 5 — gl_wired_at BECOMES stock_gl_wired_at, AND GETS A SIBLING
-- ############################################################################

-- ----------------------------------------------------------------------------
-- 5.1 The rename
-- ----------------------------------------------------------------------------
-- Guarded on information_schema so a second application is a no-op. A rename
-- rather than a new column plus a copy: the value is unchanged and its meaning
-- is unchanged, only its name was too wide. Copying would leave two columns that
-- can drift, and the old one would be read by whoever got there first.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'property_finance_settings'
      and column_name  = 'gl_wired_at'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'property_finance_settings'
      and column_name  = 'stock_gl_wired_at'
  ) then
    alter table property_finance_settings
      rename column gl_wired_at to stock_gl_wired_at;
  end if;
end $$;

-- Belt and braces for a database where 047 never ran.
alter table property_finance_settings
  add column if not exists stock_gl_wired_at timestamptz;

comment on column property_finance_settings.stock_gl_wired_at is
  'THE INSTANT THIS PROPERTY''S STOCK RPCs BEGAN POSTING TO THE LEDGER — stamped '
  'by 047, and by the column default for any property created afterwards. A '
  'stock movement whose created_at precedes it COULD NOT have posted, because '
  'the function that posts did not exist; that is a recorded FACT and not a '
  'tolerance, which is the difference between this and silencing the alarm. '
  'RENAMED from gl_wired_at by 059: the folio begins posting at a different '
  'instant, and one column answering two modules'' questions is read '
  'confidently and wrongly for the module it is not about. NOT THE SAME AS '
  'gl_start_date: that is a POLICY a person chooses about BUSINESS dates (the '
  'day the books open), while this is a FACT about the CODE, compared against '
  'row CREATION times. Rules 8/12 say business_date for anything user-facing and '
  'they are right; this asks when the row was WRITTEN, which is the only '
  'question created_at can answer.';

-- ----------------------------------------------------------------------------
-- 5.2 The sibling, deliberately NULL and deliberately without a default
-- ----------------------------------------------------------------------------
-- NULL IS THE TRUE ANSWER TODAY. The folio posts nothing, so there is no instant
-- at which it began posting, and a stamp here would claim one. 047's column got
-- a default now() because the code it describes was shipping in that same file;
-- this column's code is not written yet.
--
-- 1.1h4 stamps every existing property and adds the default, in the migration
-- that makes the sentence true. Until then the folio reconciliation does not
-- exist to read it, and if anything reads it early it reads NULL, which means
-- exactly what it says.
alter table property_finance_settings
  add column if not exists folio_gl_wired_at timestamptz;

comment on column property_finance_settings.folio_gl_wired_at is
  'THE INSTANT THIS PROPERTY''S FOLIO RPCs BEGAN POSTING TO THE LEDGER. The twin '
  'of stock_gl_wired_at, for the other engine, and separate from it because the '
  'two wirings ship months apart: a charge posted BETWEEN them is explained by '
  'neither, while a single shared column would say it was. NULL UNTIL 1.1h4, '
  'which is the truth and not an omission — the folio posts nothing yet, so '
  'there is no such instant, and that migration stamps it and adds the default '
  'in the same breath as writing the code it describes. NO MODULE-WIRING TABLE '
  'for two rows; when a THIRD module wires, that is the moment to reconsider.';

-- ----------------------------------------------------------------------------
-- 5.3 The two readers, re-emitted
-- ----------------------------------------------------------------------------
-- These are 047's view and 051's function, verbatim, with the column renamed and
-- nothing else touched. They are the only two objects in the database that
-- mention the column — asked of pg_get_viewdef and pg_proc.prosrc rather than
-- assumed from a grep of the repository, because a view created in a session and
-- never committed would not appear in the files.
--
-- THE TWO READERS ARE NOT IN THE SAME DANGER, which is worth knowing rather
-- than guessing, and the breakage record measured it: with the re-emission
-- removed, the FUNCTION dies on "column pfs.gl_wired_at does not exist" and THE
-- VIEW IS FINE. Postgres stores a view as a parsed tree pointing at column
-- numbers, so it follows a rename; a plpgsql body is text and does not.
--
-- The view is re-emitted anyway, and the reason is not defensive: without it
-- 047's file would hold a definition naming a column that no longer exists,
-- which reads as the truth and is not. That is the §5 divergence this project
-- has already paid for twice.
--
-- A SEARCH-AND-REPLACE WOULD HAVE BEEN ENOUGH AND IS NOT WHAT THIS IS. The
-- replace is COUNTED — two sites in the view, one in the function — and the
-- build refuses if either number moves. It refused once already: a guess of
-- three in the function was wrong, because it reads the column once into a
-- local and uses the local thereafter. The failure it really prevents is the
-- quiet one: a reader re-emitted from a STALE copy of its own source silently
-- reverts whatever 048 or 051 changed, and the reconciliation goes back to a
-- bucket it had already outgrown. Nothing errors. That is why the function text
-- comes from 051 and not from 047, and why it was diffed against
-- pg_get_functiondef before being trusted.

create or replace view stock_movements_unposted
with (security_invoker = on) as
select
  m.id,
  m.tenant_id,
  m.property_id,
  m.location_id,
  m.inventory_item_id,
  m.seq,
  m.movement_type,
  m.quantity,
  m.business_date,
  m.created_at,
  m.source,
  m.source_document_type,
  m.reason,
  case
    when m.movement_type = 'reversal' then round(abs(m.quantity) * m.carried_unit_cost, 2)
    when m.quantity > 0               then round(m.quantity * m.unit_cost, 2)
    else                                   round(-m.quantity * m.carried_unit_cost, 2)
  end::numeric(14,2)                                     as unposted_value,
  case
    when m.source_document_type = 'purchase_receipt'
      then 'Booked with its goods receipt, which posts one entry for the whole delivery'
    when m.movement_type in ('issue_out', 'issue_in', 'transfer_out', 'transfer_in')
      then 'Moves stock between two locations of one property, so the property holds the same value and there is nothing to book'
    when pfs.gl_start_date is not null and m.business_date < pfs.gl_start_date
      then 'Dated before the books opened for this property'
    -- 047: RECORDED BEFORE THE CODE THAT POSTS EXISTED. A fact, not a tolerance.
    when pfs.stock_gl_wired_at is not null and m.created_at < pfs.stock_gl_wired_at
      then 'Recorded before this property''s stock movements began posting to the ledger, so there was nothing to post it'
    when (case when m.movement_type = 'reversal' then m.carried_unit_cost
               when m.quantity > 0               then m.unit_cost
               else                                   m.carried_unit_cost end) is null
      then 'No cost basis, so booking it would mean guessing what the stock was worth'
    when (case
            when m.movement_type = 'reversal' then round(abs(m.quantity) * m.carried_unit_cost, 2)
            when m.quantity > 0               then round(m.quantity * m.unit_cost, 2)
            else                                   round(-m.quantity * m.carried_unit_cost, 2)
          end) = 0
      then 'Its value rounds to nothing, so there is no entry to make'
    -- NULL: NOT EXPLAINED. This is the alarm.
    else null
  end                                                    as reason_unposted
from stock_movements m
left join property_finance_settings pfs
  on pfs.property_id = m.property_id
where not exists (
  select 1 from journal_entries je
  where je.tenant_id = m.tenant_id
    and je.source_document_type = 'stock_movement'
    and je.source_document_id   = m.id
);

comment on view stock_movements_unposted is
  'EVERY MOVEMENT WITH NO JOURNAL ENTRY, WITH THE REASON. This is what replaces '
  'the guarantee an after-insert trigger would have given (046 §4): the posting '
  'cannot be made impossible to forget, so it is made impossible to forget '
  'QUIETLY. SIX reasons are legitimate and expected — 047 adds the sixth, '
  'recorded-before-the-wiring, because without it every movement written during '
  'the build read as the alarm and the view cried wolf from its first day. '
  'reason_unposted NULL is still the alarm and still means exactly one thing: '
  'stock moved, after the wiring, inside the books, with a cost, and the ledger '
  'never heard about it — sized in naira by unposted_value.';

-- Dropped and recreated rather than replaced, because that is how 051 emits it:
-- RETURNS TABLE column types cannot be changed by CREATE OR REPLACE, so 048 and
-- 051 both had to drop, and keeping the same two statements here means this file
-- stays a copy of theirs rather than a variant. Neither carries a grant or
-- revoke, so the default EXECUTE comes back with it.
drop function if exists inventory_gl_reconciliation(uuid);

create function inventory_gl_reconciliation(p_property_id uuid)
returns table (
  property_id             uuid,
  account_id              uuid,
  account_code            text,
  account_name            text,
  ledger_balance          numeric(14,2),
  expected_ledger_balance numeric(14,2),
  -- MUST BE ZERO. Anything else is a posting skipped, doubled, or misdirected.
  ledger_difference       numeric(14,2),
  -- Value that legitimately never reached the ledger, split FOUR ways as of 048
  -- so the arithmetic below is complete rather than approximately complete.
  pre_gl_value            numeric(14,2),
  -- 047: written before the posting code existed.
  pre_wiring_value        numeric(14,2),
  non_posting_value       numeric(14,2),
  unvaluable_movement_count integer,
  -- 048: THE VALUATION EFFECT OF THE MOVEMENTS THAT COUNT NAMES. Quantity moved
  -- with no cost to move with it, valued at the position's own average. Reported
  -- rather than absorbed, exactly like the three above -- and it is the reason
  -- valuation_difference can be required to explain itself again.
  unvaluable_value        numeric(14,2),
  valuation_value         numeric(14,2),
  -- Per-movement rounding, plus any position that has passed through negative.
  -- NOT required to be zero, and never absorbed anywhere. As of 048 it no longer
  -- carries the unvaluable movements' quantity, which was never rounding.
  valuation_difference    numeric(14,2),
  -- 047: THE DENOMINATOR THE RESIDUE MUST BE READ AGAINST. A kobo across forty
  -- movements is arithmetic; the same kobo across four thousand is not, and the
  -- only way anybody sees the difference is if both numbers are together.
  valued_movement_count   integer,
  -- 047: positions that have EVER been below zero — the ones that actually cause
  -- a divergence, because the fold resets the average when stock arrives into a
  -- negative position.
  reset_position_count    integer,
  -- Positions below zero RIGHT NOW. A different question, kept because it is the
  -- one somebody acts on today.
  negative_position_count integer
)
language plpgsql
stable
security definer
set search_path = public
as $$
-- The OUT parameters of a `returns table` are plpgsql VARIABLES and several
-- share a name with a column below. Every reference is qualified; the directive
-- removes the class of ambiguity rather than relying on that staying true.
-- IT LIVES INSIDE THE BODY, above `declare`: it is read by the PL/pgSQL parser,
-- not by CREATE FUNCTION, and putting it in the header is a plain syntax error.
#variable_conflict use_column
declare
  v_tenant   uuid;
  v_account  uuid;
  v_gl_start date;
  v_wired    timestamptz;
begin
  select p.tenant_id into v_tenant
  from properties p where p.id = p_property_id and p.deleted_at is null;

  if v_tenant is null then
    raise exception 'Property % not found', p_property_id using errcode = 'PT404';
  end if;

  if not is_tenant_staff(v_tenant) then
    raise exception 'Not authorised to read this property''s ledger'
      using errcode = 'insufficient_privilege';
  end if;

  -- Rule 4, even here: resolved by ROLE KEY, so a tenant who repoints
  -- `inventory` gets a reconciliation of the account it now points at.
  v_account := resolve_account(v_tenant, p_property_id, 'inventory');

  select pfs.gl_start_date, pfs.stock_gl_wired_at into v_gl_start, v_wired
  from property_finance_settings pfs where pfs.property_id = p_property_id;

  return query
  with m as (
    select
      sm.movement_type,
      sm.business_date,
      sm.created_at,
      sm.quantity,
      case
        when sm.movement_type in ('issue_out', 'issue_in', 'transfer_out', 'transfer_in')
          then null
        when sm.movement_type = 'reversal' then sm.carried_unit_cost
        when sm.quantity > 0               then sm.unit_cost
        else                                    sm.carried_unit_cost
      end as basis,
      (sm.movement_type in ('issue_out', 'issue_in', 'transfer_out', 'transfer_in'))
        as books_nothing
    from stock_movements sm
    where sm.property_id = p_property_id
  ),
  v as (
    select
      m.*,
      case when m.basis is null then null
           else sign(m.quantity) * round(abs(m.quantity) * m.basis, 2)
      end as value,
      -- Dated before the books opened. A POLICY boundary about business dates.
      (v_gl_start is not null and m.business_date < v_gl_start) as pre_gl,
      -- Written before the code that posts existed. A FACT about created_at.
      (v_wired is not null and m.created_at < v_wired)          as pre_wiring
    from m
  ),
  totals as (
    select
      -- What the ledger SHOULD hold: everything that books something, is
      -- valuable, is inside the books, and was written after the wiring.
      coalesce(sum(case
        when v.books_nothing then 0
        when v.value is null then 0
        when v.pre_gl then 0
        when v.pre_wiring then 0
        else v.value end), 0)::numeric(14,2)                     as expected_balance,
      coalesce(sum(case
        when not v.books_nothing and v.value is not null and v.pre_gl
        then v.value else 0 end), 0)::numeric(14,2)              as pre_gl_total,
      -- NOT pre_gl AND pre_wiring, so the two buckets never double-count the
      -- same movement — they are reported separately and summed below.
      coalesce(sum(case
        when not v.books_nothing and v.value is not null
             and not v.pre_gl and v.pre_wiring
        then v.value else 0 end), 0)::numeric(14,2)              as pre_wiring_total,
      coalesce(sum(case when v.books_nothing and v.value is not null
                        then v.value else 0 end), 0)::numeric(14,2) as non_posting,
      -- EVERY movement whose value was rounded to the kobo — which is exactly
      -- the set the rounding residue accumulated over.
      count(*) filter (where not v.books_nothing and v.value is not null)::integer
                                                                 as valued_n
    from v
  ),
  -- 051 §1. THE POSITION'S FIRST INBOUND, which is its first cost basis.
  --
  -- EVERY inbound counts here, transfers and issues INCLUDED -- see the header.
  -- Stock that arrived by transfer gave this position a basis as surely as a
  -- receipt would, and a position fed only by transfers is not a position
  -- without a basis.
  -- `distinct on` rather than an aggregate: the ordering key is the PAIR
  -- (business_date, seq) -- seq alone is wrong, because a back-dated row has a
  -- higher seq and an earlier date -- and Postgres has no min() over a record.
  first_in as (
    select distinct on (sm.location_id, sm.inventory_item_id)
      sm.location_id,
      sm.inventory_item_id,
      sm.business_date,
      sm.seq
    from stock_movements sm
    where sm.property_id = p_property_id
      and sm.quantity > 0
    order by sm.location_id, sm.inventory_item_id, sm.business_date, sm.seq
  ),
  -- 051 §2. WHAT LEFT BEFORE THERE WAS ANYTHING TO VALUE IT AT.
  --
  -- 048's four excluded types are excluded HERE and nowhere else -- again, see
  -- the header. The threshold above wants them; this does not.
  unvalued_out as (
    select sm.location_id, sm.inventory_item_id, sm.quantity
    from stock_movements sm
    left join first_in fi
      on  fi.location_id       = sm.location_id
      and fi.inventory_item_id = sm.inventory_item_id
    where sm.property_id = p_property_id
      and sm.quantity < 0
      and sm.movement_type not in ('issue_out', 'issue_in', 'transfer_out', 'transfer_in')
      and (
        fi.location_id is null
        or (sm.business_date, sm.seq) < (fi.business_date, fi.seq)
      )
  ),
  -- THE VALUE: the quantity those movements took off the position, at the
  -- position's own moving average. Computed from the MOVEMENTS, deliberately,
  -- and not from the difference it is meant to explain -- a bucket derived from
  -- `valuation_difference` would be true by construction and incapable of being
  -- wrong (048's reasoning, unchanged).
  unval as (
    select coalesce(sum(round(u.qty * coalesce(soh.moving_average_cost, 0), 2)), 0)::numeric(14,2) as value
    from (
      select uo.location_id, uo.inventory_item_id, sum(uo.quantity) as qty
      from unvalued_out uo
      group by uo.location_id, uo.inventory_item_id
    ) u
    join stock_on_hand soh
      on  soh.property_id       = p_property_id
      and soh.location_id       = u.location_id
      and soh.inventory_item_id = u.inventory_item_id
  ),
  -- THE COUNT is of MOVEMENTS, so it is taken from the un-grouped set. One
  -- definition of unvaluable feeds both figures, which is the point of 051: a
  -- count on one test beside a value on another is a card contradicting itself.
  unval_n as (
    select count(*)::integer as n from unvalued_out
  ),
  led as (
    select coalesce(sum(jel.debit - jel.credit), 0)::numeric(14,2) as balance
    from journal_entry_lines jel
    join journal_entries je on je.id = jel.journal_entry_id
    where je.tenant_id   = v_tenant
      and je.property_id = p_property_id
      and jel.account_id = v_account
  ),
  val as (
    select
      coalesce(sum(soh.stock_value), 0)::numeric(14,2)          as value,
      count(*) filter (where soh.quantity_on_hand < 0)::integer as negatives
    from stock_on_hand soh
    where soh.property_id = p_property_id
  ),
  -- HAS THIS POSITION EVER BEEN BELOW ZERO? The running total in the fold's own
  -- order (business_date, seq — 036 §2), not the closing quantity: a position
  -- that went negative and was then replenished is POSITIVE today and is exactly
  -- the one whose average was reset.
  resets as (
    select count(*)::integer as n
    from (
      select r.location_id, r.inventory_item_id
      from (
        select
          sm.location_id,
          sm.inventory_item_id,
          sum(sm.quantity) over (
            partition by sm.location_id, sm.inventory_item_id
            order by sm.business_date, sm.seq
            rows between unbounded preceding and current row
          ) as running
        from stock_movements sm
        where sm.property_id = p_property_id
      ) r
      group by r.location_id, r.inventory_item_id
      having min(r.running) < 0
    ) q
  )
  select
    p_property_id,
    v_account,
    a.code,
    a.name,
    led.balance,
    totals.expected_balance,
    (led.balance - totals.expected_balance)::numeric(14,2),
    totals.pre_gl_total,
    totals.pre_wiring_total,
    totals.non_posting,
    unval_n.n,
    unval.value,
    val.value,
    -- 048 put the unvaluable bucket beside the three it belongs with; 051 makes
    -- it complete. What is left here is rounding and the average resets a
    -- negative position causes -- which is what this figure was always
    -- documented to be, and now is.
    (val.value - (totals.expected_balance + totals.pre_gl_total
                  + totals.pre_wiring_total + totals.non_posting
                  + unval.value))::numeric(14,2),
    totals.valued_n,
    resets.n,
    val.negatives
  from totals
  cross join led
  cross join val
  cross join resets
  cross join unval
  cross join unval_n
  cross join accounts a
  where a.id = v_account;
end;
$$;
comment on function inventory_gl_reconciliation(uuid) is
  'Stock against the ledger for one property, with every difference named rather '
  'than absorbed. 051 redefines the unvaluable bucket as a fact about a POSITION '
  'rather than about a movement: everything that left a position before its '
  'first inbound, which is the first thing that gave it a cost basis. 048 tested '
  'the movement''s own basis for NULL, which caught the first unvaluable movement '
  'on a position and missed every one after it on the same day — those carry a '
  'basis of ZERO, because the fold then has a row to walk. Movement type is used '
  'TWICE and differently: the threshold counts every inbound INCLUDING transfers '
  'and issues, the counted set excludes all four transfer and issue types.';

-- ############################################################################
-- SECTION 6 — 'other' STAYS LEGAL AND STOPS BEING OFFERED
-- ############################################################################
-- The check constraint is UNCHANGED, deliberately. A database that cannot
-- represent what somebody recorded last year is a worse database, and 'other' is
-- a value some hotel may genuinely hold in history. On this one, nobody does:
-- two payments exist, both cash.
--
-- What changes is the picker, in src/lib/folioLabels.ts, in this commit. The
-- comment here is for whoever finds the constraint allowing a value the UI does
-- not offer and reasonably wonders which of the two is the mistake.
comment on column folio_payments.method is
  'How the money arrived. Each method resolves to an account_mappings role key '
  'when the folio posts: cash -> cash, bank_transfer -> bank, pos -> '
  'pos_clearing, company_account -> company_receivable (which is not really a '
  'payment at all — it moves the debt from the guest to the company, and the '
  'entry says so). '
  '''other'' IS NOT OFFERED ON THE SCREEN AND MUST NOT BE MAPPED. It is a '
  'missing answer rather than a destination: 044 settled that A MISSING MAPPING '
  'IS A LOUD FAILURE, NOT A SUSPENSE ACCOUNT, so the alternative to removing it '
  'was the front desk hitting resolve_account''s refusal with a guest standing '
  'there. It remains legal in the constraint so that history stays '
  'representable. A hotel that needs cheque or mobile money gets a NAMED method '
  'with its own account — a day''s work when somebody asks, and the right answer '
  'rather than a bucket.';

-- ############################################################################
-- SECTION 7 — SELF-VERIFY
-- ############################################################################
-- NAME THE DEFECT EACH ONE TURNS RED (rule 27), and note the fixture choice that
-- makes it capable of going red at all:
--
--   1  EVERY EXISTING CHARGE CARRIES ITS CATEGORY'S KEY, and there is at least
--      one. RED if the backfill joins the wrong column or is scoped away. The
--      count check is load-bearing: on an empty table "every row agrees" is
--      vacuously true and the assertion would pass having tested nothing.
--
--   2  post_charge CAPTURES THE CATEGORY'S KEY RATHER THAN DERIVING IT.
--      THE FIXTURE IS THE ASSERTION HERE. The probe category's code is 'zz059'
--      and its key is 'revenue_misc', so the convention ('revenue_' || code)
--      gives 'revenue_zz059' and the captured value gives 'revenue_misc'. On any
--      of the eleven seeded categories the two are IDENTICAL, and a capture that
--      rebuilt the key from the code would have passed against every one of
--      them. Rule 27's fourth shape, avoided on purpose.
--
--   3  A REPOINT BETWEEN THE CHARGE AND ITS REVERSAL DOES NOT SPLIT THE PAIR.
--      THE WHOLE FILE IN ONE ASSERTION. Post under 'revenue_misc', repoint the
--      category to 'revenue_room', reverse. The counter must carry
--      'revenue_misc'. RED if post_charge_reversal reads charge_categories —
--      which is what it did before this file, and which balances, reconciles
--      and leaves two revenue accounts holding equal and opposite residues
--      forever. The repoint MUST happen between the two acts or both readings
--      give the same string and nothing can fail.
--
--   4  A DISCOUNT REVERSAL ALSO CARRIES THE ORIGINAL'S REVENUE KEY, not
--      'discounts_allowed'. RED if somebody later "fixes" the counter to
--      describe its journal entry instead of itself — see the header, §7: its
--      gross is zero so no naira is at stake, and a laundry line filed under
--      discounts_allowed goes missing from laundry in every report that groups
--      by revenue account.
--
--   5  THE CAPTURED TAX ROW CARRIES THE TAX'S OWN ACCOUNT, NOT ONE INFERRED
--      FROM applies_to. THE FIXTURE IS AGAIN THE ASSERTION: the probe tax is
--      applies_to 'taxable' with account_role_key 'service_charge_payable', so
--      the inference gives 'vat_output' and the captured value does not. Against
--      the seeded VAT row the two agree exactly, which is the accident the
--      header calls out, and a proof built on VAT alone could not fail.
--
--   6  restate CARRIES THE SOURCE'S TAX ACCOUNT, ACROSS A REPOINT. Repoint the
--      probe tax to 'vat_output', then reverse. The counter's tax row must still
--      read 'service_charge_payable'. RED if restate re-reads tax_charges, and
--      red if account_role_key is missing from its jsonb_to_recordset column
--      list — that omission is silently NULL rather than a compile error, which
--      is exactly why the column is NOT NULL.
--
--   7  AN UNTAXED CATEGORY STILL GETS A REVENUE KEY. Zero tax rows and one
--      account are not the same statement. RED if the capture of the account
--      was wired into the tax path by mistake.
--
--   8  THE REFUSAL post_charge'S REWRITTEN LOOKUP MUST STILL RAISE. The
--      availability check was converted from `if not exists` to `select ... into
--      ... if not found`, which is where a rewrite loses a guard. RED if an
--      inactive category now posts.
--
--   9  BOTH gl_wired_at READERS STILL RUN, AND THE ALARM IS STILL EMPTY. A
--      renamed column leaves a stale reader failing at CALL time, not at DDL
--      time, so the assertion calls them. The empty alarm list is 047's own
--      assertion 2 re-run: a reader re-emitted from a STALE source would
--      silently revert 048's and 051's bucket and this is what notices.
--
--  10  folio_gl_wired_at IS NULL FOR EVERY PROPERTY. RED if this file stamps
--      it. The folio posts nothing yet; a stamp here would claim an instant
--      that does not exist and would then explain away charges 1.1h4 ought to
--      report.
--
--  11  'other' IS STILL UNMAPPED. RED if somebody maps it to a suspense
--      account, which is the one thing 044 settled must not happen.
--
--  12  THE SHAPE: all four rewritten functions still SECURITY DEFINER with a
--      pinned search_path, and the two new NOT NULLs actually refuse a NULL.
--      search_path is asserted as SET AND STARTING AT public rather than
--      equalling 'public' exactly — 056 learned that the hard way, failing on
--      receive_purchase_order's legitimate 'public, extensions'.
do $$
declare
  v_tenant   uuid;
  v_user     uuid;
  v_prop     uuid;
  v_guest    uuid;
  v_folio    folios;
  v_cat      uuid;
  v_catfree  uuid;
  v_tax      uuid;
  v_ch       folio_charges;
  v_chb      folio_charges;
  v_free     folio_charges;
  v_counter  folio_charges;
  v_key      text;
  v_n        integer;
  v_bad      integer;
  v_ok       boolean;
  v_err      text;
  v_state    text;
  v_fail     text := '';
begin
  begin
    select tu.tenant_id, tu.user_id into v_tenant, v_user
    from tenant_users tu where tu.is_active and tu.role in ('owner','manager') limit 1;
    select p.id into v_prop from properties p where p.tenant_id = v_tenant limit 1;
    if v_tenant is null or v_prop is null then
      raise notice '059 SELF-VERIFY SKIPPED: no tenant or active owner/manager.';
      raise exception 'ZZ_059_FIXTURE_DONE';
    end if;
    perform set_config('request.jwt.claims',
      json_build_object('role','service_role','sub', v_user::text)::text, true);

    insert into manager_pins (tenant_id, user_id, pin_hash)
    values (v_tenant, v_user, crypt('4059', gen_salt('bf')))
    on conflict (tenant_id, user_id) do update set pin_hash = excluded.pin_hash;

    -- ---- 1. EVERY EXISTING CHARGE AGREES WITH ITS CATEGORY ---------------
    select count(*)::integer,
           count(*) filter (where fc.account_role_key is distinct from cc.account_role_key)::integer
      into v_n, v_bad
    from folio_charges fc
    join charge_categories cc on cc.id = fc.charge_category_id;
    if v_n = 0 then
      v_fail := v_fail ||
        '1: there are no charges at all, so the backfill was not tested by anything. ';
    elsif v_bad > 0 then
      v_fail := v_fail || format(
        '1: %s of %s charges carry an account that is not their category''s. ', v_bad, v_n);
    end if;

    -- ---- THE FIXTURE, BUILT SO THE TWO READINGS DIFFER -------------------
    -- A category whose key is deliberately NOT 'revenue_' || code, and a tax
    -- whose account is deliberately NOT what applies_to would infer. Both
    -- targets are already mapped for this tenant, so 044's and 3.3's guards are
    -- satisfied by real mappings rather than by being skipped.
    insert into charge_categories
      (tenant_id, code, name, is_taxable, service_chargeable, display_order,
       account_role_key, created_by)
    values (v_tenant, 'zz059', 'ZZ059 Probe', true, false, 9059,
            'revenue_misc', v_user)
    returning id into v_cat;

    insert into tax_charges
      (tenant_id, property_id, code, name, rate, is_compulsory, applies_to,
       display_order, account_role_key, created_by)
    values (v_tenant, v_prop, 'zz059tax', 'ZZ059 Probe Levy', 0.1000, false,
            'taxable', 9059, 'service_charge_payable', v_user)
    returning id into v_tax;

    select cc.id into v_catfree from charge_categories cc
    where cc.tenant_id = v_tenant and not cc.is_taxable and not cc.service_chargeable
      and cc.deleted_at is null and cc.code <> 'zz059'
    order by cc.code limit 1;

    insert into guests (tenant_id, first_name, last_name, created_by)
    values (v_tenant, 'ZZ059', 'Fixture Guest', v_user) returning id into v_guest;
    v_folio := open_guest_folio(v_tenant, v_prop, v_guest, 'zz059-folio-1');

    -- ---- 2. post_charge CAPTURES, IT DOES NOT DERIVE ---------------------
    v_ch := post_charge(v_folio.id, v_cat, 'ZZ059 charge A', 1, 10000, current_date,
                        'zz059-charge-a', 'manual');
    if v_ch.account_role_key is distinct from 'revenue_misc' then
      v_fail := v_fail || format(
        '2: the charge captured %s; the category says revenue_misc and the naming convention would have said revenue_zz059. ',
        coalesce(v_ch.account_role_key, '<null>'));
    end if;

    -- ---- 5. AND THE TAX ROW CARRIES THE TAX'S OWN ACCOUNT ----------------
    select fct.account_role_key into v_key
    from folio_charge_tax_lines fct
    where fct.folio_charge_id = v_ch.id and fct.code = 'zz059tax';
    if v_key is distinct from 'service_charge_payable' then
      v_fail := v_fail || format(
        '5: the captured levy reads account %s; the tax says service_charge_payable and applies_to would have inferred vat_output. ',
        coalesce(v_key, '<null>'));
    end if;

    -- ---- 7. AN UNTAXED CATEGORY STILL GETS A REVENUE KEY -----------------
    if v_catfree is not null then
      v_free := post_charge(v_folio.id, v_catfree, 'ZZ059 deposit', 1, 5000,
                            current_date, 'zz059-charge-free', 'manual');
      select count(*)::integer into v_n
      from folio_charge_tax_lines where folio_charge_id = v_free.id;
      if v_free.account_role_key is null or btrim(v_free.account_role_key) = '' then
        v_fail := v_fail ||
          '7: a charge in an untaxed category came out with no revenue account, so the account was wired into the tax path. ';
      elsif v_n <> 0 then
        v_fail := v_fail || format(
          '7: an untaxed category captured %s tax row(s). ', v_n);
      end if;
    end if;

    -- ---- CHARGE B, POSTED AND DISCOUNTED BEFORE THE REPOINT --------------
    -- A SECOND CHARGE because the first is about to be reversed, and reversing
    -- a charge and then reversing its discount is not something that happens to
    -- one line.
    --
    -- POSTED BEFORE THE REPOINT, which is the whole of assertion 4's ability to
    -- fail. Written the other way round first — charge B posted after the
    -- repoint — the assertion went RED against correct code, because
    -- 'revenue_room' was then charge B's honest captured answer. Worse, the
    -- version that would have "passed" (comparing the counter to charge B's own
    -- key) could not have failed either: the two strings were identical, so
    -- reading the original and reading the live category were indistinguishable.
    -- Rule 27 from both sides in one assertion.
    v_chb := post_charge(v_folio.id, v_cat, 'ZZ059 charge B', 1, 8000, current_date,
                         'zz059-charge-b', 'manual');
    perform apply_charge_discount(v_chb.id, 1000, 'ZZ059 goodwill', '4059', 'zz059-disc-b');
    if v_chb.account_role_key is distinct from 'revenue_misc' then
      v_fail := v_fail || format(
        '4: charge B captured %s before the repoint, so assertion 4 is testing the wrong thing. ',
        coalesce(v_chb.account_role_key, '<null>'));
    end if;

    -- ---- THE REPOINTS. BOTH OF THEM, BETWEEN THE ACT AND ITS REVERSAL ----
    -- This is what makes 3, 4 and 6 able to fail. Without these two updates the
    -- captured value and the live value are the same string, and a reversal
    -- that read the live row would be indistinguishable from one that read the
    -- capture.
    update charge_categories set account_role_key = 'revenue_room' where id = v_cat;
    update tax_charges       set account_role_key = 'vat_output'   where id = v_tax;

    -- ---- 3. THE COUNTER CARRIES THE ORIGINAL'S ACCOUNT -------------------
    v_counter := post_charge_reversal(
      v_ch.id, 'charge', -(v_ch.gross_amount), 0,
      'ZZ059 reversal A', current_date, 'zz059-rev-a');
    if v_counter.account_role_key is distinct from 'revenue_misc' then
      v_fail := v_fail || format(
        '3: after the category was repointed the counter carries %s rather than the original''s revenue_misc, so the pair posts to two different accounts and neither ever clears. ',
        coalesce(v_counter.account_role_key, '<null>'));
    end if;

    -- ---- 6. AND SO DOES ITS TAX ROW --------------------------------------
    select fct.account_role_key into v_key
    from folio_charge_tax_lines fct
    where fct.folio_charge_id = v_counter.id and fct.code = 'zz059tax';
    if v_key is distinct from 'service_charge_payable' then
      v_fail := v_fail || format(
        '6: after the levy was repointed the counter''s tax row reads %s rather than the source''s service_charge_payable. ',
        coalesce(v_key, '<null>'));
    end if;

    -- ---- 4. A DISCOUNT REVERSAL CARRIES THE ORIGINAL'S REVENUE KEY -------
    v_counter := post_charge_reversal(
      v_chb.id, 'discount', 0, -1000,
      'ZZ059 discount reversal', current_date, 'zz059-rev-b');
    if v_counter.account_role_key is distinct from 'revenue_misc' then
      v_fail := v_fail || format(
        '4: a discount-reversal counter carries %s; it must carry the original''s revenue_misc so the line stays findable under its own revenue account. ',
        coalesce(v_counter.account_role_key, '<null>'));
    end if;

    -- ---- 8. THE REWRITTEN LOOKUP STILL REFUSES, FOR THE RIGHT REASON -----
    -- IT ASSERTS THE ERROR, NOT MERELY THAT THERE WAS ONE, and that is the
    -- whole assertion. Written as `exception when others then null`, this
    -- passed while the refusal was deleted: with no `if not found`, v_role_key
    -- stays NULL and the insert dies on the NOT NULL a few lines later, so
    -- something still raised and the proof agreed. What the front desk would
    -- have met is 'null value in column "account_role_key"' instead of the
    -- sentence naming the retired category — a worse error, past a guard that
    -- was gone, under a green proof. Rule 27 exactly: it could not distinguish
    -- working from absent.
    update charge_categories set is_active = false where id = v_cat;
    v_ok := false;
    v_err := null;
    v_state := null;
    begin
      perform post_charge(v_folio.id, v_cat, 'ZZ059 should refuse', 1, 100,
                          current_date, 'zz059-charge-refuse', 'manual');
      v_ok := true;
    exception when others then
      v_err := sqlerrm;
      v_state := sqlstate;
    end;
    if v_ok then
      v_fail := v_fail ||
        '8: a retired category still posts, so converting the availability check into the capture lookup lost the guard. ';
    elsif v_state is distinct from 'P0002'
          or v_err not like '%is not available for this tenant%' then
      v_fail := v_fail || format(
        '8: a retired category was refused by the wrong thing — %s / %s. The lookup must raise its own no_data_found refusal, not fall through to a NOT NULL violation. ',
        v_state, v_err);
    end if;
    update charge_categories set is_active = true where id = v_cat;

    -- ---- 9. BOTH RENAMED-COLUMN READERS STILL RUN ------------------------
    -- Called, not inspected. A reader left on the old name is a runtime error.
    begin
      select count(*)::integer into v_n from stock_movements_unposted;
      select count(*)::integer into v_bad
      from stock_movements_unposted where reason_unposted is null;
      if v_bad > 0 then
        v_fail := v_fail || format(
          '9: %s movement(s) are unexplained, so a reader was re-emitted from a stale source and reverted 048/051''s bucket. ',
          v_bad);
      end if;
    exception when others then
      v_fail := v_fail || format(
        '9: stock_movements_unposted will not run after the rename (%s). ', sqlerrm);
    end;
    begin
      perform * from inventory_gl_reconciliation(v_prop);
    exception when others then
      v_fail := v_fail || format(
        '9: inventory_gl_reconciliation will not run after the rename (%s). ', sqlerrm);
    end;

    -- ---- 10. THE FOLIO IS NOT CLAIMED TO BE WIRED ------------------------
    select count(*)::integer into v_bad
    from property_finance_settings where folio_gl_wired_at is not null;
    if v_bad > 0 then
      v_fail := v_fail || format(
        '10: %s propert(ies) claim a folio wiring instant, but the folio posts nothing until 1.1h4. ', v_bad);
    end if;

    -- ---- 11. 'other' IS STILL UNMAPPED -----------------------------------
    if exists (select 1 from account_mappings am
               where am.role_key in ('other', 'payment_other', 'suspense')) then
      v_fail := v_fail ||
        '11: something is mapped for an unnamed payment method, which is the suspense account 044 ruled out. ';
    end if;

    -- ---- 12. THE SHAPE ---------------------------------------------------
    select count(*)::integer into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('post_charge', 'post_charge_reversal',
                        'capture_charge_taxes', 'restate_charge_taxes',
                        'seed_tax_charges', 'enforce_tax_charge_account')
      and (not p.prosecdef
           or p.proconfig is null
           or not exists (select 1 from unnest(p.proconfig) cfg
                          where cfg like 'search_path=public%'));
    if v_bad > 0 then
      v_fail := v_fail || format(
        '12: %s of the rewritten functions lost SECURITY DEFINER or its pinned search_path. ', v_bad);
    end if;

    -- The NOT NULLs refuse, rather than merely existing.
    v_ok := false;
    begin
      update folio_charges set account_role_key = null where id = v_chb.id;
      v_ok := true;
    exception when not_null_violation then
      null;
    end;
    if v_ok then
      v_fail := v_fail ||
        '12: a charge accepted a NULL account, so NOT NULL is not on folio_charges.account_role_key. ';
    end if;

    v_ok := false;
    begin
      update folio_charge_tax_lines set account_role_key = null
      where folio_charge_id = v_chb.id;
      v_ok := true;
    exception when not_null_violation then
      null;
    end;
    if v_ok then
      v_fail := v_fail ||
        '12: a captured tax row accepted a NULL account. ';
    end if;

    if v_fail <> '' then
      raise exception '059 SELF-VERIFY FAILED — %', v_fail;
    end if;

    raise notice '059 SELF-VERIFY: 12 assertions passed.';
    raise exception 'ZZ_059_FIXTURE_DONE';
  exception
    when others then
      if sqlerrm = 'ZZ_059_FIXTURE_DONE' then
        raise notice '059 self-verify complete; fixture rolled back.';
      else
        raise;
      end if;
  end;
end $$;
