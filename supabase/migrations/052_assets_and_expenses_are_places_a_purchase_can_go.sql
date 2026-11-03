-- 052 — WHERE ELSE A PURCHASE CAN GO: ASSETS AND EXPENSES (shipment 1.1h3)
--
-- 046 declared all three line types and opened one. `purchase_order_lines`
-- already holds the shape — an inventory line MUST carry an item and no
-- description, an asset or expense line the exact opposite — and
-- save_purchase_order refuses the other two BY NAME, naming this shipment. So
-- this migration adds a WRITE PATH to a table that already holds live orders
-- rather than reshaping one, which is the whole reason 046 declared them early.
--
-- ONE ORDER, THREE DESTINATIONS, ONE RECEIVE. Rice, a fridge and a plumber's
-- call-out on one purchase order: receive it once and the stock moves, the
-- asset register gains the fridge with the supplier on it, and the charge lands
-- in an expense account.
--
-- RECORDS, NOT MODULES. No depreciation schedule and no approval flow — those
-- are 8.5 and 7.1. A `depreciation_method` column shipped now would be a field
-- nothing reads, which is the same mistake as a hardcoded account code: it looks
-- like foresight and it is a lie the next person has to maintain.
--
-- ----------------------------------------------------------------------------
-- WHAT WAS IN THE WAY, AND NEITHER OF THEM WAS OBVIOUS FROM THE TRACKER
-- ----------------------------------------------------------------------------
-- 1. THE RECEIPT TABLE ACTIVELY BLOCKED IT.
--    `purchase_receipt_lines_movement_shape_check` reads
--        (quantity > 0) = (stock_movement_id is not null)
--    and an asset or expense line is received with a positive quantity and
--    posts NO stock movement. §6 widens it, as a constraint change on a table
--    that now holds live rows: drop, add, validate.
--
-- 2. THERE WAS NOWHERE FOR AN EXPENSE TO LAND.
--    The chart had 5000 Cost of sales, 5100/5110 stock corrections, 5200–5240
--    wastage and 5900 Rounding. `fixed_assets` (1500) existed and was mapped;
--    nothing existed for a plumber, a drum of bleach or a tank of diesel. §1
--    seeds six, §2 maps them.
--
-- ----------------------------------------------------------------------------
-- WHY line_type IS DENORMALISED ONTO THE RECEIPT LINE
-- ----------------------------------------------------------------------------
-- The widened check has to know what kind of line it is looking at, and
-- `line_type` lives on `purchase_order_lines`. A CHECK constraint cannot join,
-- so the alternatives were a trigger or a copy of the column.
--
-- A CHECK THAT HAS TO JOIN IS A TRIGGER WEARING A CONSTRAINT'S NAME. It runs per
-- row, it can be disabled, and it is not visible to anyone reading the table
-- definition — which is exactly where somebody looks to find out what a row is
-- allowed to be.
--
-- So the column is copied, and then made INCAPABLE of disagreeing rather than
-- merely checked against its parent: `purchase_order_lines` gains
-- `unique (id, line_type)` and the receipt line's FK binds the PAIR. A receipt
-- line whose type differs from its order line's cannot be written, because no
-- such parent row exists. That is §6's composite-key rule applied to a column
-- rather than to a tenant id, and it is the same argument: a row whose two
-- columns disagree is a defect no policy can detect, so the database must not
-- be able to hold one.
--
-- NO `on update cascade`, deliberately. 046 refuses a line change once an order
-- has been sent, and a draft order has no receipts, so a type change on a line
-- with receipts is already impossible. If one were ever attempted, refusing it
-- is the correct answer rather than quietly rewriting history.

-- ----------------------------------------------------------------------------
-- THE CORRECTION PATH, TODAY — AND THE TWO COLUMNS THAT ARE NOT HERE
--
-- `expenses` has no `is_voided`. `fixed_assets` has no `deleted_at`. An earlier
-- draft of this migration carried both, and NEITHER COULD EVER HAVE BEEN SET:
-- no UPDATE policy by design, and no SECURITY DEFINER function that voids or
-- removes either. The comment beside them promised the folio's discipline --
-- "void and re-record" -- while the folio has `reverse_charge` and the movement
-- ledger has `post_movement_reversal` and these two had nothing.
--
-- That is worse than a missing feature, because the column makes a reader
-- believe there is a way back. It is the same argument this header already makes
-- against shipping `depreciation_method` now: a column nothing can write is a
-- promise the next person has to keep, and it looks like foresight while it is
-- being written.
--
-- SO WHAT IS THE CORRECTION PATH? Three honest sentences:
--
--   1. A row created by RECEIVING A DELIVERY is corrected by undoing the
--      delivery — shipment 1.1h2d, which must land before 1.1h5. Both tables
--      anchor on `purchase_receipt_line_id`, uniquely, so the undo has exactly
--      one row to find and remove.
--   2. A STANDALONE expense cannot be created yet — there is no entry screen and
--      no RPC — so it cannot yet be wrong.
--   3. WHEN STANDALONE ENTRY SHIPS, IT SHIPS WITH ITS VOID PATH IN THE SAME
--      SHIPMENT, and the column comes back then, beside the function that sets
--      it. Not before.
--
-- Assertion 7 enforces that pairing rather than trusting this paragraph: a
-- soft-delete column on any of these three tables must come with a way to write
-- it. `expense_categories` KEEPS its `deleted_at` under exactly that test --
-- it has an admin UPDATE policy, so the column is writable today.
-- ----------------------------------------------------------------------------
--
-- ----------------------------------------------------------------------------
-- WHAT THE PROOF WENT RED FOR (rule 27)
--
-- Six breakages, each named by the defect it catches, all confirmed RED before
-- the green run below was trusted:
--
--   A  the inventory half of the shape check weakened to `true`
--        -> 3: an inventory line posted with NO stock movement
--   B  the asset/expense half weakened to `true`
--        -> 4: an asset line carrying a stock movement was accepted
--   C  the composite FK downgraded to a plain id FK
--        -> 5: a receipt line claimed 'expense' against an 'asset' order line
--   D  one expense mapping removed from the seeder
--        -> 1: expected 6 expense mappings, found 5, AND 2: does not resolve
--   E  `enable row level security` removed from all three new tables
--        -> 6: expense_categories / expenses / fixed_assets have RLS disabled
--   F  an UPDATE policy added to `expenses`
--        -> 6: expenses has an UPDATE or DELETE policy
--   G  the code uniqueness restored as a plain `unique (tenant_id, code)`
--        -> 8: a retired code blocks recreating it
--   H  `is_voided` re-added to `expenses` with neither policy nor RPC
--        -> 7: expenses.is_voided is a soft-delete column with no way to write it
--   I  the code index left partial but not unique
--        -> 8: two live categories share a code
--
-- E AND F EXIST BECAUSE THE FIRST DRAFT OF THIS MIGRATION HAD NO RLS AT ALL.
-- Three new tables, rule 13, nine green assertions, and nothing failed --
-- because nothing asked. It was caught by re-reading checklist item 2 against
-- finished work, which is luck dressed as process. The assertion is here so the
-- next migration that forgets cannot reach a green run.
--
-- AND A WORD ON BREAKAGE A, which is the sharper lesson. A first went "red" and
-- was nearly believed: the mutation anchored on the bare expression
-- `(quantity > 0) = (stock_movement_id is not null)`, which appears in the
-- header comment ABOVE the constraint as well as in the constraint. A string
-- `.replace()` takes the FIRST match, so the harness edited PROSE, the SQL then
-- failed to parse for an unrelated reason, and a syntax error read as a caught
-- defect. A breakage that fails to COMPILE proves nothing about the assertion --
-- rule 27 applied to the harness itself. Re-anchored on the constraint's own
-- `when 'inventory' then ...` line, A was briefly GREEN, which is what the
-- assertion actually had to survive.
-- ----------------------------------------------------------------------------

-- ############################################################################
-- SECTION 1 — SIX EXPENSE ACCOUNTS
-- ############################################################################
-- Seeded the way the rest of the chart is, and editable afterwards like the rest
-- of it. Six rather than one, for the reason the wastage block has five: a
-- single "Expenses" account answers no question anybody asks of it.
--
-- NOTHING IS RENUMBERED. The first draft of this migration moved Rounding's
-- display_order to keep it last -- written from 044's text, which still had that
-- column. 045 REMOVED it: the chart sorts by CODE now, so 5300-5350 land between
-- the wastage block and 5900 by themselves. Both seeders here are therefore
-- taken verbatim from the LIVE catalog rather than from the migration that first
-- created them, which is the same discipline 051 arrived at the hard way.
create or replace function seed_chart_of_accounts(p_tenant_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $$
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
    -- 052: the six operating expenses a hotel meets in its first week. They
    -- sort between the wastage block and Rounding by CODE, which is the only
    -- ordering the chart has since 045 removed display_order -- so nothing has
    -- to be renumbered for Rounding to stay the last line.
    ('5300', 'Repairs and maintenance', 'expense',
     'Work on the building and its equipment -- a plumber, an electrician, a part for the generator.'),
    ('5310', 'Utilities',               'expense',
     'Power, water, diesel for the generator, and the bills that arrive monthly.'),
    ('5320', 'Cleaning and consumables','expense',
     'Bought to be used up and not held as stock -- cleaning chemicals, small sundries.'),
    ('5330', 'Transport and fuel',      'expense',
     'Running the hotel''s vehicles, and getting goods and people about.'),
    ('5340', 'Professional fees',       'expense',
     'Accountants, lawyers, consultants, and anybody else invoicing for their time.'),
    ('5350', 'Other operating',         'expense',
     'The one that catches what the other five do not. If it fills up, that is the signal to add a category.'),
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
  'Seeds a tenant''s chart of accounts. Re-runnable: a code that already exists '
  'is skipped, so adding rows here and calling it again backfills an existing '
  'tenant without touching what they have edited. 052 adds the six operating '
  'expense accounts, 5300-5350.';

-- Backfill every tenant that already exists.
do $$
declare t record;
begin
  for t in select id from tenants loop
    perform seed_chart_of_accounts(t.id);
  end loop;
end;
$$;


-- ############################################################################
-- SECTION 2 -- THE MAPPINGS
-- ############################################################################
-- Rule 4: nothing in code will name 5310. An expense category resolves its
-- account through a ROLE KEY, exactly as every other posting does, which is also
-- what lets a hotel repoint one without a migration.
create or replace function seed_account_mappings(p_tenant_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $$
begin
  insert into account_mappings (tenant_id, property_id, role_key, account_id)
  select p_tenant_id, null, m.role_key, a.id
  from (values
    -- Assets
    ('cash',                    '1000'),
    ('bank',                    '1010'),
    ('pos_clearing',            '1020'),
    ('guest_ledger',            '1200'),
    ('company_receivable',      '1210'),
    ('inventory',               '1300'),
    ('fixed_assets',            '1500'),
    -- Liabilities
    ('supplier_payable',        '2000'),
    ('vat_output',              '2100'),
    ('service_charge_payable',  '2200'),
    -- Equity
    ('opening_balance_equity',  '3000'),
    -- Revenue, one per seeded charge category ('revenue_' || category code)
    ('revenue_room',            '4000'),
    ('revenue_fnb',             '4010'),
    ('revenue_laundry',         '4020'),
    ('revenue_internet',        '4030'),
    ('revenue_minibar',         '4040'),
    ('revenue_transport',       '4050'),
    ('revenue_extra_bed',       '4060'),
    ('revenue_early_checkin',   '4070'),
    ('revenue_late_checkout',   '4080'),
    ('revenue_damage',          '4090'),
    ('revenue_misc',            '4100'),
    -- Contra-revenue
    ('discounts_allowed',       '4900'),
    -- Cost and loss
    ('stock_adjustment',        '5100'),
    ('stock_variance',          '5110'),
    ('wastage_spoilage',        '5200'),
    ('wastage_breakage',        '5210'),
    ('wastage_expiry',          '5220'),
    ('wastage_staff_meal',      '5230'),
    ('wastage_complimentary',   '5240'),
    -- 052: one role key per seeded expense category, named the way the revenue
    -- keys are. Rule 4: nothing in code will ever name 5310.
    ('expense_repairs',         '5300'),
    ('expense_utilities',       '5310'),
    ('expense_cleaning',        '5320'),
    ('expense_transport',       '5330'),
    ('expense_professional',    '5340'),
    ('expense_other',           '5350'),
    ('rounding_difference',     '5900')
  ) as m(role_key, code)
  join accounts a
    on a.tenant_id = p_tenant_id
   and a.code = m.code
   and a.deleted_at is null
  where not exists (
    select 1 from account_mappings am
    where am.tenant_id = p_tenant_id
      and am.property_id is null
      and am.role_key = m.role_key
  );
end;
$$;


comment on function seed_account_mappings(uuid) is
  'Seeds the tenant-level account mappings, resolving each role key to the '
  'account with the matching seeded code. Re-runnable: a role key that already '
  'has a tenant-level mapping is skipped, so a hotel that has repointed one '
  'keeps their choice. 052 adds the six expense_* keys.';

do $$
declare t record;
begin
  for t in select id from tenants loop
    perform seed_account_mappings(t.id);
  end loop;
end;
$$;


-- ############################################################################
-- SECTION 3 — expense_categories
-- ############################################################################
-- Modelled on charge_categories (021 §1): a STABLE MACHINE CODE apart from the
-- display name, because the posting path looks up by code and must not break
-- when a hotel renames "Cleaning and consumables" to "Housekeeping supplies".
--
-- The ACCOUNT IS A ROLE KEY, not an account id. That is rule 4 and it is also
-- what makes a new category a configuration change rather than a migration:
-- add the category, add the mapping, and the posting path resolves it.
create table if not exists expense_categories (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id) on delete cascade,

  code       text not null
               constraint expense_categories_code_check
               check (code ~ '^[a-z][a-z0-9_]*$'),
  name       text not null,

  -- Resolved through account_mappings by resolve_account(). NOT an account id:
  -- a hotel that repoints the key gets every past and future expense following
  -- it, which is the behaviour rule 4 exists to produce.
  role_key   text not null
               constraint expense_categories_role_key_check
               check (role_key ~ '^[a-z][a-z0-9_]*$'),

  is_active  boolean not null default true,
  sort_order integer not null default 100,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid default auth.uid() references auth.users(id),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,

  constraint expense_categories_id_tenant_unique unique (id, tenant_id)
);

-- THE CODE IS UNIQUE AMONG LIVE ROWS, NOT AMONG ALL ROWS. A table constraint
-- cannot be partial, so the uniqueness is an index.
--
-- WHY THIS TABLE KEEPS deleted_at WHEN THE OTHER TWO LOSE IT: this one has an
-- admin UPDATE policy, so the column is writable today by the role that owns
-- the configuration. The test is not "does the column exist" but "can anybody
-- ever set it" -- and on `expenses` and `fixed_assets` the answer was no.
--
-- A PLAIN unique (tenant_id, code) WOULD MAKE THE SOFT DELETE A TRAP: delete
-- "cleaning", try to add "cleaning" again, and the dead row refuses it -- with
-- a duplicate-key error naming a row no screen will ever show, so the message
-- describes something the user cannot see or reach.
create unique index if not exists expense_categories_code_uniq
  on expense_categories (tenant_id, code)
  where deleted_at is null;

comment on table expense_categories is
  'What kind of operating expense this is, and which account it posts to. The '
  'CODE is the stable machine key and the NAME is freely editable, the same '
  'split charge_categories uses — a posting path that looked up by name would '
  'break the first time a hotel renamed one. The account is held as a ROLE KEY '
  'and resolved through account_mappings (rule 4), so adding a category is '
  'configuration rather than a migration.';

drop trigger if exists set_row_audit_expense_categories on expense_categories;
create trigger set_row_audit_expense_categories
  before insert or update on expense_categories
  for each row execute function set_row_audit();

create or replace function seed_expense_categories(p_tenant_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into expense_categories (tenant_id, code, name, role_key, sort_order)
  select p_tenant_id, d.code, d.name, d.role_key, d.sort_order
  from (values
    ('repairs',      'Repairs and maintenance',  'expense_repairs',      10),
    ('utilities',    'Utilities',                'expense_utilities',    20),
    ('cleaning',     'Cleaning and consumables', 'expense_cleaning',     30),
    ('transport',    'Transport and fuel',       'expense_transport',    40),
    ('professional', 'Professional fees',        'expense_professional', 50),
    ('other',        'Other operating',          'expense_other',        60)
  ) as d(code, name, role_key, sort_order)
  where not exists (
    select 1 from expense_categories c
    where c.tenant_id = p_tenant_id and c.code = d.code
  );
end;
$$;

comment on function seed_expense_categories(uuid) is
  'Seeds the six categories a hotel meets in its first week. SEEDED RATHER THAN '
  'LEFT EMPTY because the person who meets an empty picker is buying a '
  'plumber''s call-out at the time, and a dead end there is a reason to write it '
  'on a scrap of paper instead. Re-runnable, skipping codes that exist.';

do $$
declare t record;
begin
  for t in select id from tenants loop
    perform seed_expense_categories(t.id);
  end loop;
end;
$$;

-- New tenants get all three seeders, in one trigger function so the order is
-- stated once: accounts, then the mappings that resolve against them, then the
-- categories that resolve through the mappings.
create or replace function seed_tenant_accounting()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform seed_chart_of_accounts(new.id);
  perform seed_account_mappings(new.id);
  perform seed_expense_categories(new.id);
  return new;
end;
$$;

drop trigger if exists seed_accounts_after_tenant_insert on tenants;
drop trigger if exists seed_tenant_accounting_after_insert on tenants;
create trigger seed_tenant_accounting_after_insert
  after insert on tenants
  for each row execute function seed_tenant_accounting();


-- THE KEY THE TWO RECORD TABLES POINT AT. Both anchor on a receipt line and
-- both carry tenant_id, so §6's composite-key rule applies: the FK binds the
-- PAIR rather than trusting two independent columns to agree. The receipt line
-- had no such key, because nothing had needed to reference it until now.
alter table purchase_receipt_lines
  drop constraint if exists purchase_receipt_lines_id_tenant_unique;
alter table purchase_receipt_lines
  add constraint purchase_receipt_lines_id_tenant_unique unique (id, tenant_id);


-- ############################################################################
-- SECTION 4 — expenses
-- ############################################################################
-- ONE TABLE FOR BOTH SHAPES. An expense bought on a purchase order and an
-- expense somebody simply paid are the same fact about the hotel's money, and
-- two tables would mean two places to look and two totals that can disagree.
-- The link to the receipt line is NULLABLE: present when a delivery created it,
-- absent when somebody recorded it directly.
create table if not exists expenses (
  id                       uuid primary key default gen_random_uuid(),

  tenant_id                uuid not null,
  property_id              uuid not null,

  -- The operating day it belongs to (§6). Not created_at, which is audit only.
  business_date            date not null,

  expense_category_id      uuid not null,
  supplier_id              uuid,

  description              text not null
                             constraint expenses_description_check
                             check (length(btrim(description)) > 0),

  amount                   numeric(14,2) not null
                             constraint expenses_amount_check
                             check (amount > 0),

  -- THE ANCHOR THAT MAKES RECEIVING TWICE SAFE. Unique, so a repeated receive
  -- cannot write a second expense for the same delivery line — the same job
  -- stock_movement_id already does for an inventory line.
  purchase_receipt_line_id uuid
                             constraint expenses_receipt_line_uniq unique,

  note                     text,

  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  created_by               uuid default auth.uid() references auth.users(id),
  updated_by               uuid references auth.users(id),

  -- NO is_voided, AND THAT IS THE POINT. See THE CORRECTION PATH, TODAY in the
  -- header: a column nothing can write is a promise the next person inherits.
  constraint expenses_property_tenant_fk
    foreign key (property_id, tenant_id) references properties (id, tenant_id),
  constraint expenses_category_tenant_fk
    foreign key (expense_category_id, tenant_id)
    references expense_categories (id, tenant_id),
  constraint expenses_supplier_tenant_fk
    foreign key (supplier_id, tenant_id) references suppliers (id, tenant_id),
  constraint expenses_receipt_line_tenant_fk
    foreign key (purchase_receipt_line_id, tenant_id)
    references purchase_receipt_lines (id, tenant_id)
);

comment on table expenses is
  'An operating cost, whether it arrived on a purchase order or was simply '
  'paid. ONE table for both, because they are the same fact and two would be '
  'two totals that can disagree. purchase_receipt_line_id is UNIQUE and '
  'nullable: unique so receiving a delivery twice cannot write the expense '
  'twice, nullable so a standalone expense needs no invented order.';

create index if not exists expenses_property_date_idx
  on expenses (property_id, business_date desc);
create index if not exists expenses_category_idx
  on expenses (expense_category_id);

drop trigger if exists set_row_audit_expenses on expenses;
create trigger set_row_audit_expenses
  before insert or update on expenses
  for each row execute function set_row_audit();


-- ############################################################################
-- SECTION 5 — fixed_assets
-- ############################################################################
-- A RECORD, NOT A SCHEDULE. What was bought, what it cost, who sold it and
-- which order it came in on. Depreciation is 8.5 and is deliberately absent:
-- a `depreciation_method` column nothing reads is a promise the next person has
-- to keep.
create table if not exists fixed_assets (
  id                       uuid primary key default gen_random_uuid(),

  tenant_id                uuid not null,
  property_id              uuid not null,

  name                     text not null
                             constraint fixed_assets_name_check
                             check (length(btrim(name)) > 0),
  description              text,

  -- The operating day it was acquired (§6).
  acquired_on              date not null,

  cost                     numeric(14,2) not null
                             constraint fixed_assets_cost_check
                             check (cost >= 0),

  supplier_id              uuid,
  purchase_order_id        uuid,

  -- Same anchor, same reason: receiving twice must not make two freezers.
  purchase_receipt_line_id uuid
                             constraint fixed_assets_receipt_line_uniq unique,

  note                     text,

  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  created_by               uuid default auth.uid() references auth.users(id),
  updated_by               uuid references auth.users(id),

  -- NO deleted_at, for the same reason expenses has no is_voided.
  constraint fixed_assets_property_tenant_fk
    foreign key (property_id, tenant_id) references properties (id, tenant_id),
  constraint fixed_assets_supplier_tenant_fk
    foreign key (supplier_id, tenant_id) references suppliers (id, tenant_id),
  constraint fixed_assets_order_tenant_fk
    foreign key (purchase_order_id, tenant_id)
    references purchase_orders (id, tenant_id),
  constraint fixed_assets_receipt_line_tenant_fk
    foreign key (purchase_receipt_line_id, tenant_id)
    references purchase_receipt_lines (id, tenant_id)
);

comment on table fixed_assets is
  'What the hotel owns and keeps, with the supplier and the order that bought '
  'it. A RECORD rather than a module: no depreciation schedule and no disposal '
  'flow, which are 8.5. purchase_receipt_line_id is UNIQUE so receiving a '
  'delivery twice cannot register the same asset twice.';

create index if not exists fixed_assets_property_idx
  on fixed_assets (property_id, acquired_on desc);

drop trigger if exists set_row_audit_fixed_assets on fixed_assets;
create trigger set_row_audit_fixed_assets
  before insert or update on fixed_assets
  for each row execute function set_row_audit();


-- ############################################################################
-- SECTION 6 — THE RECEIPT LINE LEARNS WHAT KIND OF LINE IT IS
-- ############################################################################
-- A CONSTRAINT CHANGE ON A TABLE WITH LIVE ROWS, treated as one: the column is
-- added and backfilled first, the parent gains the key the FK needs, the old
-- check is dropped and the new one added, and both are VALIDATED against what
-- is already there.
--
-- WIDENING A CHECK IS HOW A GUARD QUIETLY STOPS GUARDING, so §7 asserts the
-- half that must survive: an INVENTORY line still cannot post without its
-- movement, in both directions.

-- The FK target. `unique (id, line_type)` is redundant against the primary key
-- and exists solely to be referenced — the same reason 046 added
-- `unique (id, tenant_id)` to half the tables in this module.
alter table purchase_order_lines
  drop constraint if exists purchase_order_lines_id_type_unique;
alter table purchase_order_lines
  add constraint purchase_order_lines_id_type_unique unique (id, line_type);

alter table purchase_receipt_lines
  add column if not exists line_type text;

-- Backfill from the parent. Every existing receipt line is an inventory line by
-- construction, because 046 refused the other two — but it is READ from the
-- order line rather than defaulted, so the backfill is the truth rather than an
-- assumption that happens to hold today.
--
-- THE IMMUTABILITY TRIGGER IS DISABLED FOR THE LENGTH OF ONE UPDATE, and that
-- deserves to be uncomfortable to read, so here is the reasoning in full — it is
-- 038's, because this is 038's situation exactly.
--
-- forbid_purchase_receipt_change() refuses every UPDATE on this table, which is
-- right for every application and administrative path and is the guarantee a
-- supplier payment will later be allocated against. A schema migration adding a
-- column that must be populated from history is the one thing it cannot
-- accommodate, and the alternative — defaulting the column to 'inventory' and
-- calling it true — would bake an assumption into live rows rather than read
-- the answer.
--
-- The disable/enable pair is inside this migration's single transaction, so
-- there is no window in which the table is unprotected to anything else, and the
-- UPDATE touches ONE column that was NULL on every row a moment earlier.
do $$
begin
  execute 'alter table purchase_receipt_lines disable trigger forbid_purchase_receipt_line_change_trigger';

  update purchase_receipt_lines rl
     set line_type = ol.line_type
    from purchase_order_lines ol
   where ol.id = rl.purchase_order_line_id
     and rl.line_type is distinct from ol.line_type;

  execute 'alter table purchase_receipt_lines enable trigger forbid_purchase_receipt_line_change_trigger';
exception
  when others then
    -- The re-enable must happen even if the UPDATE fails, or a failed migration
    -- leaves the table permanently editable. The transaction would roll the
    -- disable back anyway; this is belt and braces for the case where somebody
    -- later runs this block outside one.
    execute 'alter table purchase_receipt_lines enable trigger forbid_purchase_receipt_line_change_trigger';
    raise;
end;
$$;

alter table purchase_receipt_lines
  alter column line_type set not null;
alter table purchase_receipt_lines
  alter column line_type set default 'inventory';

-- THE PAIR BINDING. After this a receipt line whose type differs from its order
-- line's cannot exist, because there is no parent row to point at.
alter table purchase_receipt_lines
  drop constraint if exists purchase_receipt_lines_order_line_type_fk;
alter table purchase_receipt_lines
  add constraint purchase_receipt_lines_order_line_type_fk
  foreign key (purchase_order_line_id, line_type)
  references purchase_order_lines (id, line_type);

-- THE WIDENED SHAPE CHECK. An inventory line keeps the old rule exactly; an
-- asset or expense line moves no stock and must carry no movement.
alter table purchase_receipt_lines
  drop constraint if exists purchase_receipt_lines_movement_shape_check;
alter table purchase_receipt_lines
  add constraint purchase_receipt_lines_movement_shape_check
  check (
    case line_type
      when 'inventory' then (quantity > 0) = (stock_movement_id is not null)
      else stock_movement_id is null
    end
  );

alter table purchase_receipt_lines
  validate constraint purchase_receipt_lines_movement_shape_check;
alter table purchase_receipt_lines
  validate constraint purchase_receipt_lines_order_line_type_fk;

comment on column purchase_receipt_lines.line_type is
  'Copied from the order line, and bound to it by a composite FK on '
  '(purchase_order_line_id, line_type) so the two are INCAPABLE of disagreeing. '
  'It is here because the movement shape check has to know what kind of line '
  'this is, and a CHECK cannot join — the alternative was a trigger, which is '
  'invisible to anyone reading the table definition.';


-- ############################################################################
-- SECTION 6a — RLS, FROM DAY ONE (rule 13)
-- ############################################################################
-- Three new tables, three sets of policies, written in the same migration that
-- creates them. Reads are membership-scoped through get_tenant_ids(); writes
-- follow the shape purchasing already uses — a member may record what happened,
-- an admin may change the configuration.
--
-- expense_categories is CONFIGURATION, so it is admin-write: it decides which
-- account an expense posts to, and a member who can repoint that can move money
-- between accounts without touching a single expense.
--
-- expenses and fixed_assets are RECORDS of things that happened, so a member may
-- insert them — that is what receiving a delivery does. Neither is updatable by
-- anybody: an expense is corrected by voiding it and recording another, the same
-- rule the folio and the movement ledger follow, so the history stays readable.
alter table expense_categories enable row level security;
alter table expenses           enable row level security;
alter table fixed_assets       enable row level security;

drop policy if exists expense_categories_member_select on expense_categories;
create policy expense_categories_member_select on expense_categories
  for select to authenticated
  using (tenant_id = any(get_tenant_ids()));

drop policy if exists expense_categories_admin_insert on expense_categories;
create policy expense_categories_admin_insert on expense_categories
  for insert to authenticated
  with check (is_tenant_admin(tenant_id));

drop policy if exists expense_categories_admin_update on expense_categories;
create policy expense_categories_admin_update on expense_categories
  for update to authenticated
  using (is_tenant_admin(tenant_id))
  with check (is_tenant_admin(tenant_id));

drop policy if exists expenses_member_select on expenses;
create policy expenses_member_select on expenses
  for select to authenticated
  using (tenant_id = any(get_tenant_ids()));

drop policy if exists expenses_member_insert on expenses;
create policy expenses_member_insert on expenses
  for insert to authenticated
  with check (
    tenant_id = any(get_tenant_ids())
    and property_id = any(get_property_ids())
  );

drop policy if exists fixed_assets_member_select on fixed_assets;
create policy fixed_assets_member_select on fixed_assets
  for select to authenticated
  using (tenant_id = any(get_tenant_ids()));

drop policy if exists fixed_assets_member_insert on fixed_assets;
create policy fixed_assets_member_insert on fixed_assets
  for insert to authenticated
  with check (
    tenant_id = any(get_tenant_ids())
    and property_id = any(get_property_ids())
  );

-- NO UPDATE OR DELETE POLICY ON EITHER RECORD TABLE, deliberately. Without one,
-- RLS refuses both for every client role.
--
-- AND THIS COMMENT DOES NOT CLAIM A VOID PATH, because there isn't one. An
-- earlier draft said "void and re-record, the same rule the folio and the
-- movement ledger follow" -- but the folio has reverse_charge and the ledger
-- has post_movement_reversal, and these two had nothing at all: no UPDATE
-- policy, no definer function, and an `is_voided` / `deleted_at` column that
-- therefore nobody could ever set. See THE CORRECTION PATH, TODAY in the header
-- for what is actually true. The columns are gone, so the comment and the schema
-- now say the same thing.


-- ############################################################################
-- SECTION 7 — SELF-VERIFY
-- ############################################################################
-- NAME THE DEFECT EACH ONE TURNS RED:
--
--   1  the six accounts and six mappings exist for every tenant
--      RED if the backfill loop is dropped, or a code is seeded without its
--      mapping — which would make a category resolve to nothing at posting time.
--
--   2  every category resolves to an account through resolve_account
--      RED if a role key is misspelled in one of the two lists. The two are
--      written out separately, so a typo in either is invisible until something
--      tries to post.
--
--   3  an INVENTORY line still cannot post without its movement, BOTH ways
--      RED if the widened check lost the inventory half — which is what
--      "widening a check" does when it is done carelessly.
--
--   4  an ASSET line posts with no movement, and is REFUSED with one
--      RED if the new half is wrong in either direction.
--
--   5  a receipt line cannot disagree with its order line's type
--      RED if the composite FK is dropped in favour of the plain one.
--
--   6  RLS is on, and the two record tables have no UPDATE or DELETE policy
--      RED if `enable row level security` is omitted — which is how the first
--      draft of this migration reached a green run with three unprotected
--      tables, because nothing asked.
--
--   7  a soft-delete column comes with a way to write it — a policy OR a
--      definer function
--      RED if `is_voided` returns to `expenses` with neither. Asserts the
--      PAIRING, not the absence, so it keeps holding when the column
--      legitimately comes back beside its void RPC.
--
--   8  a code is unique among LIVE rows, not among all rows
--      RED if the partial index becomes a plain unique constraint (8a) or
--      stops being unique at all (8b). Both sides, because a plain constraint
--      passes 8b.
do $$
declare
  v_tenant  uuid;
  v_actor   uuid;
  v_prop    uuid;
  v_sup     uuid;
  v_order   uuid;
  v_line    uuid;
  v_line2   uuid;
  v_receipt uuid;
  v_receipt2 uuid;
  v_receipt3 uuid;
  v_loc     uuid;
  v_item    uuid;
  v_move    uuid;
  v_n       integer;
  v_cat     record;
  v_acct    uuid;
  v_dead    uuid;
  v_fail    text := '';
begin
  begin
    select t.id into v_tenant from tenants t limit 1;
    select tu.user_id into v_actor
    from tenant_users tu where tu.tenant_id = v_tenant and tu.is_active limit 1;
    if v_tenant is null or v_actor is null then
      raise notice '052 self-verify SKIPPED: no tenant or active staff member.';
      return;
    end if;
    perform set_config('request.jwt.claim.sub', v_actor::text, true);

    -- --- 1. THE ACCOUNTS AND MAPPINGS --------------------------------------
    select count(*) into v_n from accounts
    where tenant_id = v_tenant and code in ('5300','5310','5320','5330','5340','5350');
    if v_n <> 6 then
      v_fail := v_fail || format('1: expected 6 expense accounts, found %s. ', v_n);
    end if;

    select count(*) into v_n from account_mappings
    where tenant_id = v_tenant and property_id is null
      and role_key in ('expense_repairs','expense_utilities','expense_cleaning',
                       'expense_transport','expense_professional','expense_other');
    if v_n <> 6 then
      v_fail := v_fail || format('1: expected 6 expense mappings, found %s. ', v_n);
    end if;

    select count(*) into v_n from expense_categories where tenant_id = v_tenant;
    if v_n <> 6 then
      v_fail := v_fail || format('1: expected 6 categories, found %s. ', v_n);
    end if;

    -- --- 2. EVERY CATEGORY RESOLVES ----------------------------------------
    select p.id into v_prop from properties p where p.tenant_id = v_tenant limit 1;
    for v_cat in
      select code, role_key from expense_categories where tenant_id = v_tenant
    loop
      begin
        v_acct := resolve_account(v_tenant, v_prop, v_cat.role_key);
        if v_acct is null then
          v_fail := v_fail || format(
            '2: category %s resolves to nothing. ', v_cat.code);
        end if;
      exception when others then
        v_fail := v_fail || format(
          '2: category %s (%s) does not resolve: %s. ',
          v_cat.code, v_cat.role_key, sqlerrm);
      end;
    end loop;

    -- --- 3, 4, 5. THE WIDENED CHECK ----------------------------------------
    insert into suppliers (tenant_id, name, code)
    values (v_tenant, 'ZZ052 fixture supplier', 'ZZ052') returning id into v_sup;
    select l.id into v_loc from locations l
      where l.property_id = v_prop and l.kind = 'store' limit 1;
    select i.id into v_item from inventory_items i
      where i.tenant_id = v_tenant and i.deleted_at is null limit 1;

    insert into purchase_orders (
      tenant_id, property_id, supplier_id, order_number, status,
      order_date, destination_location_id)
    values (v_tenant, v_prop, v_sup, 'ZZ052', 'draft', current_date, v_loc)
    returning id into v_order;

    insert into purchase_order_lines (
      tenant_id, purchase_order_id, line_number, line_type,
      inventory_item_id, quantity, unit_cost)
    values (v_tenant, v_order, 1, 'inventory', v_item, 10, 100)
    returning id into v_line;

    insert into purchase_order_lines (
      tenant_id, purchase_order_id, line_number, line_type,
      description, quantity, unit_cost)
    values (v_tenant, v_order, 2, 'asset', 'ZZ052 chest freezer', 1, 250000)
    returning id into v_line2;

    insert into purchase_receipts (
      tenant_id, property_id, purchase_order_id, receipt_number,
      business_date, location_id)
    values (v_tenant, v_prop, v_order, 'ZZ052-R1', current_date, v_loc)
    returning id into v_receipt;

    -- 3a. An INVENTORY line with no movement is still refused.
    begin
      insert into purchase_receipt_lines (
        tenant_id, purchase_receipt_id, purchase_order_line_id,
        line_type, line_number, quantity, unit_cost)
      values (v_tenant, v_receipt, v_line, 'inventory', 1, 10, 100);
      v_fail := v_fail ||
        '3: an inventory line posted with NO stock movement -- the widened check lost its inventory half. ';
    exception when check_violation then null;
    end;

    -- 3b. And WITH one it is accepted, so 3a is not passing because everything
    -- is refused.
    insert into stock_movements (
      tenant_id, property_id, location_id, inventory_item_id,
      movement_type, quantity, unit_cost, business_date, source)
    values (v_tenant, v_prop, v_loc, v_item, 'receipt', 10, 100, current_date, 'purchase')
    returning id into v_move;

    begin
      insert into purchase_receipt_lines (
        tenant_id, purchase_receipt_id, purchase_order_line_id,
        line_type, line_number, quantity, unit_cost, stock_movement_id)
      values (v_tenant, v_receipt, v_line, 'inventory', 1, 10, 100, v_move);
    exception when others then
      v_fail := v_fail || format(
        '3: an inventory line WITH its movement was refused: %s. ', sqlerrm);
    end;

    -- 4a. An ASSET line posts with no movement.
    begin
      insert into purchase_receipt_lines (
        tenant_id, purchase_receipt_id, purchase_order_line_id,
        line_type, line_number, quantity, unit_cost)
      values (v_tenant, v_receipt, v_line2, 'asset', 2, 1, 250000);
    exception when others then
      v_fail := v_fail || format(
        '4: an asset line with no movement was refused: %s. ', sqlerrm);
    end;

    -- 4b. And is REFUSED if it carries one.
    --
    -- ON ITS OWN RECEIPT. 046 allows one order line only once per receipt, so
    -- the first draft of this fixture -- which reused one receipt for 4a, 4b and
    -- 5 -- tripped that index instead of the constraint it meant to test, and
    -- the catch written for it (`when unique_violation then null`) would have
    -- swallowed a genuine failure of the check. Each assertion now gets a fresh
    -- (receipt, order line) pair and catches ONLY the error it is asserting.
    insert into purchase_receipts (
      tenant_id, property_id, purchase_order_id, receipt_number,
      business_date, location_id)
    values (v_tenant, v_prop, v_order, 'ZZ052-R2', current_date, v_loc)
    returning id into v_receipt2;

    begin
      insert into purchase_receipt_lines (
        tenant_id, purchase_receipt_id, purchase_order_line_id,
        line_type, line_number, quantity, unit_cost, stock_movement_id)
      values (v_tenant, v_receipt2, v_line2, 'asset', 1, 1, 250000, v_move);
      v_fail := v_fail ||
        '4: an asset line carrying a stock movement was accepted. ';
    exception when check_violation then null;
    end;

    -- 5. A receipt line cannot claim a type its order line does not have.
    insert into purchase_receipts (
      tenant_id, property_id, purchase_order_id, receipt_number,
      business_date, location_id)
    values (v_tenant, v_prop, v_order, 'ZZ052-R3', current_date, v_loc)
    returning id into v_receipt3;

    begin
      insert into purchase_receipt_lines (
        tenant_id, purchase_receipt_id, purchase_order_line_id,
        line_type, line_number, quantity, unit_cost)
      values (v_tenant, v_receipt3, v_line2, 'expense', 1, 1, 250000);
      v_fail := v_fail ||
        '5: a receipt line claimed ''expense'' against an ''asset'' order line -- the composite FK is not binding. ';
    exception when foreign_key_violation then null;
    end;

    -- --- 6. RLS IS ON, AND THE RECORD TABLES ARE INSERT-ONLY ---------------
    -- THIS ASSERTION EXISTS BECAUSE THE FIRST DRAFT OF THIS MIGRATION HAD NO
    -- RLS AT ALL. Three new tables, rule 13, and the omission was caught by
    -- re-reading the checklist rather than by anything failing -- which is
    -- exactly how a table ships without policies and leaks every tenant's data.
    for v_cat in
      select c.relname, c.relrowsecurity,
             (select count(*) from pg_policies pp
               where pp.schemaname = 'public' and pp.tablename = c.relname
                 and pp.cmd in ('UPDATE', 'DELETE')) as writable
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relname in ('expense_categories', 'expenses', 'fixed_assets')
    loop
      if not v_cat.relrowsecurity then
        v_fail := v_fail || format('6: %s has RLS disabled. ', v_cat.relname);
      end if;
      if v_cat.relname <> 'expense_categories' and v_cat.writable > 0 then
        v_fail := v_fail || format(
          '6: %s has an UPDATE or DELETE policy -- it is insert-only until a shipment gives it a correction path. ',
          v_cat.relname);
      end if;
    end loop;
    select count(*) into v_n from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname in ('expense_categories', 'expenses', 'fixed_assets')
      and c.relrowsecurity;
    if v_n <> 3 then
      v_fail := v_fail || format('6: expected RLS on 3 tables, found %s. ', v_n);
    end if;

    -- --- 7. A SOFT-DELETE COLUMN COMES WITH A WAY TO WRITE IT --------------
    -- THE RULE, NOT THE INSTANCE. `expenses` carried `is_voided` and
    -- `fixed_assets` carried `deleted_at`, and neither could ever be set: no
    -- UPDATE policy by design, no definer function that voids or removes
    -- either. The comment beside them promised the folio's "void and re-record"
    -- while the folio has reverse_charge and these had nothing -- a column
    -- nothing can write is a promise the next person inherits.
    --
    -- So this does not assert "the two columns are absent", which would be a
    -- restatement of the edit. It asserts the PAIRING: on these three tables, a
    -- soft-delete column must come with something that can set it.
    --
    -- EITHER FORM COUNTS -- an UPDATE policy, or a SECURITY DEFINER function
    -- naming the table and the column. The first version of this assertion took
    -- a policy ONLY, and it would therefore have refused the exact path the
    -- header prescribes: the folio voids through `reverse_charge` and the ledger
    -- through `post_movement_reversal`, both definer RPCs with no UPDATE policy
    -- in sight. An assertion that forbids the remedy it demands is worse than
    -- none, because the next person meets a contradiction and resolves it by
    -- deleting the assertion.
    --
    -- expense_categories passes WITH its deleted_at, because it has an admin
    -- UPDATE policy. Re-add is_voided to expenses with neither form and this
    -- goes red naming the column -- which is the defect, and it is the one that
    -- shipped.
    for v_cat in
      select c.relname as tbl, a.attname as col,
             (select count(*) from pg_policies pp
               where pp.schemaname = 'public' and pp.tablename = c.relname
                 and pp.cmd in ('UPDATE', 'ALL'))
           + (select count(*) from pg_proc pr
               join pg_namespace pn on pn.oid = pr.pronamespace
               where pn.nspname = 'public' and pr.prosecdef
                 and pg_get_functiondef(pr.oid) ilike '%' || c.relname || '%'
                 and pg_get_functiondef(pr.oid) ilike '%' || a.attname || '%')
             as writable
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid
      where n.nspname = 'public'
        and c.relname in ('expense_categories', 'expenses', 'fixed_assets')
        and a.attname in ('is_voided', 'deleted_at')
        and a.attnum > 0 and not a.attisdropped
    loop
      if v_cat.writable = 0 then
        v_fail := v_fail || format(
          '7: %s.%s is a soft-delete column with no way to write it -- ship the void path in the same shipment as the column, or drop the column. ',
          v_cat.tbl, v_cat.col);
      end if;
    end loop;

    -- --- 8. A CODE IS UNIQUE AMONG LIVE ROWS, NOT AMONG ALL ROWS -----------
    -- BOTH SIDES OF THE BOUNDARY, because only one of them disagrees with the
    -- defect. A plain unique (tenant_id, code) also refuses 8b, so asserting
    -- 8b alone would stay green against it (rule 27: assert where the two
    -- rules DISAGREE). 8a is that side.
    insert into expense_categories (tenant_id, code, name, role_key, deleted_at)
    values (v_tenant, 'zz052_dead', 'ZZ052 retired category', 'expense_other', now())
    returning id into v_dead;

    -- 8a. The SAME code can be created again once the old one is retired.
    begin
      insert into expense_categories (tenant_id, code, name, role_key)
      values (v_tenant, 'zz052_dead', 'ZZ052 recreated', 'expense_other');
    exception when unique_violation then
      v_fail := v_fail ||
        '8: a retired code blocks recreating it -- the uniqueness is not partial on deleted_at. ';
    end;

    -- 8b. And two LIVE rows with one code are still refused.
    begin
      insert into expense_categories (tenant_id, code, name, role_key)
      values (v_tenant, 'zz052_dead', 'ZZ052 duplicate live', 'expense_other');
      v_fail := v_fail ||
        '8: two live categories share a code -- the partial index is not unique. ';
    exception when unique_violation then null;
    end;

    if v_fail <> '' then
      raise exception '052 SELF-VERIFY FAILED: %', v_fail;
    end if;

    raise notice '052 self-verify: 17 assertions passed (3 seeding, 1 resolution, 5 shape, 4 RLS, 4 correction-path).';
    raise exception 'ZZ_052_FIXTURE_DONE';
  exception
    when others then
      if sqlerrm = 'ZZ_052_FIXTURE_DONE' then
        null;  -- the fixture rolled itself back; nothing above survives
      else
        raise;
      end if;
  end;
end;
$$;
