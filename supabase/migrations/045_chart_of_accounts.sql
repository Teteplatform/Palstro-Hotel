-- ============================================================================
-- 045_chart_of_accounts.sql
-- Palstro-Hotels: the rules that protect a posted account, and the removal of a
-- column the chart no longer orders by.
-- ============================================================================
--
-- ----------------------------------------------------------------------------
-- WHY THIS IS A MIGRATION AND NOT A SCREEN
-- ----------------------------------------------------------------------------
-- 044 gave a tenant admin `accounts_admin_insert` and `accounts_admin_update`.
-- Those policies are correct and they are also the whole problem: a rule enforced
-- only by the form that usually writes the row is not a rule, because the policy
-- lets any admin PATCH the table directly. Every guard below therefore lives here,
-- refuses in the database, and states itself in its own words (rule 21). The
-- chart screen shows what comes back and authors nothing.
--
-- ----------------------------------------------------------------------------
-- WHAT THIS MIGRATION IS
-- ----------------------------------------------------------------------------
-- IS:  four guards on `accounts` — a posted account's CODE and its GROUP are
--      both frozen, an account a mapping still points at cannot be retired, and
--      a posted account is never removed — plus the removal of
--      `accounts.display_order`.
--
-- IS NOT: a parent/group column, a statement_section column, an is_postable
--      flag, or anything else. Each was considered in 1.1h1 §0 and each was
--      ruled out for a reason recorded below.
--
-- ----------------------------------------------------------------------------
-- WHY display_order GOES, RATHER THAN GETTING A BETTER DEFAULT
-- ----------------------------------------------------------------------------
-- The chart is ordered by (SECTION RANK, CODE) — assets, liabilities, equity,
-- revenue, expenses, and inside each section by the account number itself. That
-- is what a numbered chart means, and it needs no stored ordering at all.
--
-- THE BUG THIS AVOIDS, which had already shipped and had not yet been clicked:
-- `display_order integer not null default 0`. Every account a hotel added would
-- have taken 0 and sorted ABOVE 1000 Cash, at the top of the entire chart. To
-- the person who just added their second bank account that reads as a broken
-- screen, not as a default that needs setting. Fixing the default would have
-- meant computing a sensible value on every insert, forever, in every writer —
-- so the dependency is removed instead of repaired.
--
-- PROVEN BEFORE IT WAS DONE: ordering the 35 seeded accounts by
-- (section_rank, code) returns byte-for-byte the same sequence as ordering them
-- by display_order. The seeded thousand-blocks (assets 1000-1500, liabilities
-- 2000-2300, equity 3000-3900, revenue 4000-4900, expenses 5000-5900) already
-- encode statement order in the number. If that had NOT matched, the ranges were
-- wrong and this migration would not have been written.
--
-- THE SECTION RANK IS A CASE, NOT A COLUMN. Five values, fixed by accounting
-- rather than by a tenant, and derivable from account_type in one expression. A
-- column would be a second source of truth for something that cannot vary, and
-- the first time the two disagreed the chart would be wrong in a way nothing
-- errors on.
--
-- ----------------------------------------------------------------------------
-- FORWARD COMMITMENT: is_postable BELONGS TO STAGE 11, NOT TO NOTHING
-- ----------------------------------------------------------------------------
-- 1.1h1 considered an `is_postable` flag and it was withdrawn, deliberately, and
-- this is the record of that being a DECISION rather than an omission.
--
-- It has no writer today. There is no manual journal entry screen: every posting
-- goes through post_journal, which resolves its account from a ROLE KEY, so no
-- user can aim at an account by hand. A flag nothing can violate protects
-- nothing. There is also no parent column, so there are no group headers for it
-- to mark.
--
-- WHEN A MANUAL JOURNAL ENTRY SCREEN ARRIVES IN STAGE 11, that changes in one
-- step: a person will be able to choose any account from a picker, including
-- control accounts — the guest ledger, inventory, supplier payable — whose
-- balances are owned by their subledgers and must only ever move through the
-- engine that maintains them. A hand-written journal against Inventory is how a
-- GL and a stock valuation start disagreeing with nothing to blame. THAT is
-- where is_postable earns its place, on the same day the screen does.
--
-- SUB-GROUPING INSIDE A SECTION (current vs non-current assets, direct vs
-- overhead cost) was ruled out for the same shape of reason: it is the parent
-- column 044 cut, a 30-room hotel does not need it, and the chart screen says so
-- behind its ⓘ so the absence reads as a decision rather than an oversight.
--
-- ----------------------------------------------------------------------------
-- RE-RUNNABLE. Applying this file twice in one transaction is a clean no-op.
-- ============================================================================


-- ############################################################################
-- SECTION 1 — the guards on a posted account
-- ############################################################################
-- ONE TRIGGER FUNCTION, FOUR RULES, and that is deliberate rather than lazy: all
-- four fire on `before update on accounts`, so four functions would mean four
-- trigger invocations per row and four places to look when an update is refused.
-- Each is sectioned inside and raises its own message with its own SQLSTATE.
--
-- THE SQLSTATES DIFFER ON PURPOSE, and the difference is the one thing a client
-- can act on without reading the text:
--   * PT403 for the frozen CODE, the frozen GROUP, and the removal of a posted
--     account — PERMANENT prohibitions. No sequence of steps makes any of them
--     allowed; the entries exist and they cite that account as it stands.
--   * PT409 for the still-mapped account — a RESOLVABLE conflict. Repoint the
--     mapping and the same action succeeds. The hint names the keys, so the way
--     out is one click away rather than a hunt.
-- One code for all four would tell the client they are the same kind of "no",
-- and they are not.
create or replace function enforce_account_change_rules()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_posted  boolean;
  v_keys    text;
begin
  -- ---- RULES 1 AND 2 both turn on the same question ------------------------
  -- Asked ONCE, and only when one of the two frozen columns actually moved, so
  -- an ordinary rename never touches journal_entry_lines at all.
  if new.code is distinct from old.code
     or new.account_type is distinct from old.account_type then
    select exists (
      select 1 from journal_entry_lines jel where jel.account_id = old.id
    ) into v_posted;
  end if;

  -- ---- RULE 1: a posted account's CODE is frozen ---------------------------
  -- RENAMING STAYS FREE, ALWAYS. That is the same rule as everywhere else in
  -- this system: the record stands, the label can be corrected. An account
  -- called "Bank" that turns out to be "GTBank current" should be renamed on the
  -- spot, and every entry already posted to it keeps pointing at it, because
  -- entries reference the id and never the code.
  --
  -- The CODE is different. It is what an accountant cites, what a printed
  -- trial balance is sorted by, and what an auditor matches against last year's
  -- statements. Renumbering an account that has been posted to silently
  -- rewrites the history of every report already issued.
  if coalesce(v_posted, false) and new.code is distinct from old.code then
    raise exception
      'Account % has already been posted to, so its number cannot be changed.',
      old.code
      using errcode = 'PT403',
            hint = 'Rename it instead — the name can always be corrected, and every entry already posted stays attached. If you genuinely need a different number, create a new account and stop using this one.';
  end if;

  -- ---- RULE 2: a posted account's GROUP is frozen too ----------------------
  -- THE SAME FAMILY AS THE CODE, and the harm is worse because it is harder to
  -- see. Moving an account from asset to expense once it has entries does not
  -- change a single figure in the ledger — every debit and credit stays exactly
  -- where it was — but it silently moves that balance from the balance sheet to
  -- the profit and loss. A statement somebody has already read, filed and acted
  -- on now says something different, and there is no diff anywhere to point at.
  -- Renumbering at least leaves a number that no longer matches the printout;
  -- this leaves nothing.
  --
  -- PT403 like the code, and for the same reason: no sequence of steps makes it
  -- allowed. If an account is genuinely in the wrong section, the honest fix is a
  -- new account in the right one and a journal entry moving the balance across —
  -- which leaves a trail, which is the point.
  --
  -- THE NAME IS STILL FREE. That is the shape of this whole system: the record
  -- stands, the label can be corrected.
  if coalesce(v_posted, false)
     and new.account_type is distinct from old.account_type then
    raise exception
      'Account % has already been posted to, so it cannot move from % to %.',
      old.code, old.account_type, new.account_type
      using errcode = 'PT403',
            hint = 'Moving it would shift a balance somebody has already reported between the balance sheet and the profit and loss, with nothing on any statement to show it happened. Create an account in the right group instead and move the balance across with a journal entry.';
  end if;

  -- ---- RULE 3: an account a MAPPING still points at cannot be retired ------
  -- resolve_account (044) already skips a deactivated or soft-deleted account
  -- and then refuses, naming the role key. THIS IS THE SAME RULE SAID EARLIER,
  -- where it is cheap to fix: at the moment somebody switches the account off,
  -- rather than at the moment a receipt fails at the store counter three days
  -- later for a reason nobody connects to a settings change.
  --
  -- It names the keys, because "something still uses this" sends a person
  -- hunting and "guest_ledger, revenue_room still use it" does not.
  if (old.is_active and not new.is_active)
     or (old.deleted_at is null and new.deleted_at is not null) then

    select string_agg(distinct am.role_key, ', ' order by am.role_key)
      into v_keys
    from account_mappings am
    where am.account_id = old.id;

    if v_keys is not null then
      raise exception
        'Account % is still where % posts, so it cannot be switched off.',
        old.code, v_keys
        using errcode = 'PT409',
              hint = 'Open the "Where money posts" tab, point that role key at a different account, then switch this one off.';
    end if;
  end if;

  -- ---- RULE 4: a posted account is never removed --------------------------
  -- Soft delete only, and not even that once there are entries against it. An
  -- account with a balance that vanishes from the chart is a trial balance that
  -- no longer adds up, with nothing on screen to say why.
  if old.deleted_at is null and new.deleted_at is not null then
    -- Recomputed rather than reused: v_posted above is only populated when the
    -- code or the group moved, and a removal usually moves neither.
    select exists (
      select 1 from journal_entry_lines jel where jel.account_id = old.id
    ) into v_posted;

    if v_posted then
      raise exception
        'Account % has entries posted to it and cannot be removed.',
        old.code
        using errcode = 'PT403',
              hint = 'Switch it off instead. It stops being offered for new postings and stays on the chart, so past reports still balance.';
    end if;
  end if;

  return new;
end;
$$;

comment on function enforce_account_change_rules() is
  'The two rules a posted account carries, refused in the DATABASE because 044''s '
  'accounts_admin_update policy lets an admin PATCH the table directly — a rule '
  'enforced only by the form that usually writes the row is not a rule. (1) A '
  'posted account''s CODE is frozen (PT403); renaming stays free always, because '
  'entries reference the id and never the code. (2) An account a mapping still '
  'points at cannot be switched off or removed (PT409), naming the role keys — '
  'the same refusal resolve_account would give at posting time, said early where '
  'it is cheap to fix. (3) A posted account is never removed at all.';

drop trigger if exists enforce_account_change_rules_trigger on accounts;
create trigger enforce_account_change_rules_trigger
  before update on accounts
  for each row execute function enforce_account_change_rules();


-- ############################################################################
-- SECTION 2 — display_order leaves the chart
-- ############################################################################
-- Three steps, in this order, because the column cannot go while a function
-- writes it or an index reads it. All three are part of the one removal; none is
-- a separate change.

-- ----------------------------------------------------------------------------
-- 2.1 The seed stops writing it
-- ----------------------------------------------------------------------------
-- Re-emitted whole, identical to 044's except that the display_order column and
-- its values are gone. The codes are unchanged, and they are what the ordering
-- now uses — so the seeded chart comes out in exactly the sequence it did
-- before, which is the assertion that licensed this migration.
create or replace function seed_chart_of_accounts(p_tenant_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into accounts (tenant_id, code, name, account_type, note)
  select p_tenant_id, d.code, d.name, d.account_type, d.note
  from (values
    -- Assets
    ('1000', 'Cash',                    'asset',      null),
    ('1010', 'Bank',                    'asset',      null),
    ('1020', 'POS clearing',            'asset',
     'Card takings between the terminal and the bank. Cleared when the acquirer settles, usually net of commission.'),
    ('1200', 'Guest ledger',            'asset',
     'What guests owe. Reconciles to the sum of open folio balances.'),
    ('1210', 'Company receivable',      'asset',
     'What corporate accounts owe, billed to the company rather than the guest.'),
    ('1300', 'Inventory',               'asset',
     'Stock on hand at weighted-average cost. Reconciles to stock_valuation.'),
    ('1500', 'Fixed assets',            'asset',      null),
    -- Liabilities
    ('2000', 'Supplier payable',        'liability',  null),
    ('2100', 'VAT output',              'liability',
     'VAT charged to guests and owed to the FIRS.'),
    ('2110', 'VAT input recoverable',   'liability',
     'Seeded but NOT mapped: purchase orders carry a cost and no tax, so nothing writes this yet.'),
    ('2200', 'Service charge payable',  'liability',
     'The service charge, held as a liability until the hotel confirms it keeps it. Money that may belong to staff should not sit in revenue by default.'),
    ('2300', 'Withholding tax payable', 'liability',
     'Seeded but NOT mapped: nothing withholds until supplier payments exist.'),
    -- Equity
    ('3000', 'Opening balance equity',  'equity',
     'The other side of an opening stock balance and of any opening chart balance.'),
    ('3900', 'Retained earnings',       'equity',
     'Seeded but NOT mapped: nothing writes it until a P&L exists (stage 11).'),
    -- Revenue
    ('4000', 'Room revenue',            'revenue',    null),
    ('4010', 'Food and beverage revenue','revenue',   null),
    ('4020', 'Laundry revenue',         'revenue',    null),
    ('4030', 'Internet revenue',        'revenue',    null),
    ('4040', 'Minibar revenue',         'revenue',    null),
    ('4050', 'Transport revenue',       'revenue',    null),
    ('4060', 'Extra bed revenue',       'revenue',    null),
    ('4070', 'Early check-in revenue',  'revenue',    null),
    ('4080', 'Late check-out revenue',  'revenue',    null),
    ('4090', 'Damage recovery',         'revenue',    null),
    ('4100', 'Other revenue',           'revenue',    null),
    ('4900', 'Discounts allowed',       'revenue',
     'Contra-revenue: carries a DEBIT balance. Typed revenue because that is where it belongs on a P&L; the sign is what makes it contra.'),
    -- Expenses
    ('5000', 'Cost of sales',           'expense',
     'Seeded but NOT mapped: nothing consumes stock until recipes exist (6.2), and the granularity question is "which item", not "food or drink".'),
    ('5100', 'Stock adjustment',        'expense',
     'A correction: the count was wrong. Kept apart from write-offs, because blurring the two makes the variance report worthless.'),
    ('5110', 'Stock count variance',    'expense',
     'The variance a physical count posted.'),
    ('5200', 'Spoilage',                'expense',    null),
    ('5210', 'Breakage',                'expense',    null),
    ('5220', 'Expiry',                  'expense',    null),
    ('5230', 'Staff meals',             'expense',
     'A cost of doing business, not a loss to chase.'),
    ('5240', 'Complimentaries',         'expense',
     'A cost of doing business, not a loss to chase.'),
    ('5900', 'Rounding difference',     'expense',
     'Absorbs at most 1.00 on an entry built from four-decimal costs. CAPPED in post_journal, which is what makes it a rounding line and not a suspense account.')
  ) as d(code, name, account_type, note)
  where not exists (
    select 1 from accounts a
    where a.tenant_id = p_tenant_id
      and a.code = d.code
      and a.deleted_at is null
  );
end;
$$;

comment on function seed_chart_of_accounts(uuid) is
  'Seeds a tenant''s DEFAULT chart of accounts. Defaults only — the hotel '
  'renames, renumbers, deactivates and extends them freely, and nothing resolves '
  'an account by code (rule 4), so none of that can break a posting path. '
  'Idempotent: skips any live code that already exists, so it never overwrites '
  'an account someone has renamed. 045: no display_order — the chart is ordered '
  'by (section rank, code), and the codes below already encode statement order.';

-- ----------------------------------------------------------------------------
-- 2.2 The index stops reading it
-- ----------------------------------------------------------------------------
-- Replaced rather than merely dropped: (tenant_id, account_type, code) is what
-- the chart screen actually sorts within, now that display_order is gone.
drop index if exists accounts_tenant_idx;
create index if not exists accounts_tenant_idx
  on accounts (tenant_id, account_type, code)
  where deleted_at is null;

-- ----------------------------------------------------------------------------
-- 2.3 The column goes
-- ----------------------------------------------------------------------------
-- A COLUMN WITH NO READER IS A COLUMN SOMEBODY WILL ONE DAY WRITE TO, and the
-- value they write will silently do nothing — or, worse, something, if a future
-- reader picks it up again and finds a table half-populated with zeros.
alter table accounts drop column if exists display_order;


-- ############################################################################
-- SECTION 3 — grants, and the anon assertion
-- ############################################################################
revoke all on function enforce_account_change_rules() from public, anon, authenticated;

-- THE ASSERTION, NOT A COPIED ARRAY (041 section 3). Raises if anon holds
-- EXECUTE on any SECURITY DEFINER function outside the documented exemptions,
-- and complains if the quarantine list has entries that no longer leak.
do $$
begin
  perform assert_no_anon_security_definer();
end $$;

-- ============================================================================
-- End of 045_chart_of_accounts.sql
-- ============================================================================
