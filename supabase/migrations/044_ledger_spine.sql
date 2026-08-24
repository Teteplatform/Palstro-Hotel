-- ============================================================================
-- 044_ledger_spine.sql
-- Palstro-Hotels: THE LEDGER SPINE — a chart of accounts, role-key mappings,
-- journal entries, and the one function that writes them.
-- ============================================================================
--
-- ----------------------------------------------------------------------------
-- WHY THIS IS HERE AND NOT IN STAGE 11
-- ----------------------------------------------------------------------------
-- docs/ARCHITECTURE.md put accounting last, and that was right about the
-- DEPENDENCY order — "account mappings before anything that touches money" —
-- while being wrong about the CALENDAR. Heledon has not gone live. There is no
-- trading history, so there is nothing to backfill, and every module that posts
-- nothing today becomes a stack of documents somebody has to reconstruct into a
-- ledger later, under time pressure, with a real balance depending on the
-- answer. Wiring costs a shipment now; after go-live it costs a project. The
-- folio has been charging and taking payments since 021 and posting nowhere,
-- which is that debt already accruing.
--
-- ----------------------------------------------------------------------------
-- THE DATED GAP, IN THESE WORDS, BECAUSE AN UNDOCUMENTED EXCEPTION BECOMES
-- PERMANENT
-- ----------------------------------------------------------------------------
-- The rule is: every money RPC posts its own journal, inside its own
-- transaction, through post_journal. No client-side posting, ever. No backfill
-- page, ever. (The ERP's general ledger read 782,500 in Stock on Hand against a
-- subledger of 732,500 — off by exactly the goods-in-transit amount — because
-- its journals were posted client-side after the RPC returned, with a Backfill
-- tool as the recovery path. That gap is the entire reason for this rule.)
--
-- THAT RULE IS NOT TRUE YET. It becomes:
--   * TRUE FOR STOCK AND PURCHASING AT 1.1h2, when the six existing stock RPCs
--     (post_opening_balance, post_stock_adjustment, post_stock_receipt,
--     post_stock_writeoff, finish_stock_take, and the two reversal paths) are
--     wired alongside purchasing's own posting, in one file.
--   * TRUE FOR THE FOLIO AT 1.1h4, which begins by capturing tax on the charge
--     at post time and only then wires the folio — see THE TAX PROBLEM below.
--   * NOT TRUE IN BETWEEN.
-- CLOSING DATE: GO-LIVE. Nothing may go live with a posting site unwired.
--
-- This shipment is deliberately designed against EVERY posting site that exists
-- in the code today — the folio, the stock ledger and purchasing at once — and
-- wired progressively. The role keys in SECTION 7 come from all of them, so the
-- spine is not shaped around one module. A spine designed and consumed in the
-- same migration grows a parameter that exists for one caller.
--
-- ----------------------------------------------------------------------------
-- THE TAX PROBLEM, RECORDED HERE BECAUSE 1.1h4 STARTS WITH IT
-- ----------------------------------------------------------------------------
-- folio_charge_tax (021) computes tax LIVE from the current tax_charges.rate,
-- and folio_charges stores no tax amount anywhere. Change VAT from 7.5% to 10%
-- and every historical charge's tax silently changes with it. A posted journal
-- entry would then disagree with the bill it came from, permanently and
-- invisibly. It is the same defect booking_nights was built to prevent: a rate
-- that moves rewrites history. 1.1h4 captures tax on the charge at post time
-- BEFORE it wires the folio; a journal entry that disagrees with its own bill is
-- worse than no journal entry.
--
-- ----------------------------------------------------------------------------
-- WHAT 1.1h4 INHERITS, SETTLED NOW SO IT IS NOT RE-ARGUED
-- ----------------------------------------------------------------------------
-- Four commitments. Two came out of deriving the role keys from the folio; two
-- came out of the questions asked before this migration was allowed to ship. All
-- four are invisible from any function signature, and none of them is enforced by
-- anything — which is exactly why they are written here rather than discovered
-- again, six weeks from now, by somebody with less context than whoever settled
-- them.
--
-- A VOID POSTS A COUNTER-ENTRY. It does not become unavailable once an entry
-- exists. void_charge and void_payment (021) set is_voided; the reversal
-- subsystem (031-034) posts genuine counter-entries. When the folio is wired,
-- is_voided GOES ON DRIVING THE DISPLAY and the void ALSO posts the reversing
-- entry — the front desk keeps its one-click undo and the ledger stays
-- append-only. Removing a working feature to protect the books is the wrong
-- trade when a counter-entry buys both. (Note that this makes a void and a
-- reversal look identical IN THE LEDGER while remaining different acts on the
-- bill; that is correct — the ledger records the money, the folio records the
-- authority.)
--
-- THE CHARGE CATEGORY FORM SHIPS IN 1.1h4, WITH THE ACCOUNT PICKER ON IT, and
-- the mapping screen gains categories listed under their key. This migration adds
-- a NOT NULL and a trigger refusing a category whose role key is not mapped
-- (SECTION 8) — and as of today those guard A PATH THAT DOES NOT EXIST. There is
-- no charge category form anywhere in the client: charge_categories has zero
-- write references in src/, only reads. The only way to create one is the SQL
-- editor.
--
-- So the guard is correct and currently INERT, and that is the reason this is
-- written down rather than left as a good intention. A guard nobody has scheduled
-- the use of is a guard that quietly stops meaning anything — and the failure it
-- prevents (the first post_charge refusing at the front desk, in front of a
-- guest, for a configuration decision made weeks earlier by somebody else) is
-- only reachable once a person can create a category from a screen.
-- src/lib/accounting.ts held a fetchChargeCategoryAccounts read for exactly that
-- screen and nothing called it; it was deleted rather than committed dead, and it
-- is a dozen lines to bring back.
--
-- WHEN THAT FORM SHIPS, THE 'revenue_misc' FALLBACK IS DELETED FROM THE BACKFILL
-- PATH (SECTION 8.3). Today the backfill assigns 'revenue_' || code where that
-- key is mapped and 'revenue_misc' where it is not. On the live database that
-- second branch takes ZERO rows — every existing category is one of the seeded
-- eleven and resolves to its own key — and the only way to reach it is by typing
-- SQL. A silent default is defensible on those terms.
--
-- It stops being defensible the moment a person can create a category from a
-- screen, because then it is a real accounting decision being made FOR them,
-- without a question, in a migration they were not present for. On that day the
-- choice becomes explicit on the form, or the insert refuses. Not both, and not
-- neither.
--
-- A DISCOUNT POSTS THE DELTA, not its face value. apply_charge_discount is
-- ABSOLUTE, not cumulative: apply 500 then 800 and the discount is 800, not
-- 1,300. An entry per application would therefore double-count. The entry is for
-- the NEW discount minus what has already been posted. Cheap to do and
-- completely invisible from the RPC's signature, which is the whole reason it is
-- recorded rather than left to be noticed.
--
-- ----------------------------------------------------------------------------
-- WHAT THIS MIGRATION IS
-- ----------------------------------------------------------------------------
-- IS:  accounts (the chart, per tenant, editable) · account_mappings (role key
--      to account, with a property override) · journal_entries and
--      journal_entry_lines (permanent, never updated, never deleted) ·
--      resolve_account · post_journal · gl_start_date · the seeds.
--
-- IS NOT: a trial balance, a P&L, a balance sheet, bank reconciliation, tax
--      returns, ageing, or group roll-up. Every one of those is a REPORT over
--      this spine and every one stays in stage 11.
--
--      THE TEST FOR SCOPE: this shipment gives money somewhere to go. It does
--      not give anyone something to read.
--
-- ----------------------------------------------------------------------------
-- THE RULES IT CARRIES
-- ----------------------------------------------------------------------------
--   * Rule 4  — accounts are resolved by ROLE KEY. A hardcoded '4000' anywhere
--               in a migration or in the client is a defect. The ONE exception
--               is seed_account_mappings, which resolves by the accounts' own
--               code because it is the function that just created them; see the
--               comment there, and do not generalise from it.
--   * Rule 6  — a MISSING MAPPING IS A LOUD FAILURE, NOT A SUSPENSE ACCOUNT.
--               resolve_account raises and names the role key. The single
--               rounding line (SECTION 5) is capped at 1.00 precisely so it
--               cannot become the place errors go to be forgotten.
--   * Rules 2/3 — post_journal takes p_idempotency_key, and there is ONE entry
--               per source document, enforced by a partial unique index.
--   * Rule 8  — entries sort by entry_date, the BUSINESS date.
--   * Rule 13 — RLS on every table here, from this migration.
--   * Rule 21 — every refusal carries the RULE in its message and the WAY OUT in
--               its hint. The client renders both and authors neither.
--
-- ----------------------------------------------------------------------------
-- RE-RUNNABLE. Every statement is guarded, so applying this file twice in one
-- transaction is a clean no-op (proof 9).
-- ============================================================================


-- ############################################################################
-- SECTION 1 — accounts: the chart
-- ############################################################################
-- TENANT-LEVEL, matching charge_categories and the inventory catalogue: a group
-- has one chart. Per-property differences (two hotels, two tills) are handled by
-- the property override on account_mappings (SECTION 2), not by two charts.
--
-- FLAT, not a tree. A parent/child hierarchy exists to sum a P&L, and a P&L is
-- stage 11. `code` and `display_order` give the ordering an accountant expects
-- without inventing a structure nothing reads yet.
--
-- WHAT IS DELIBERATELY ABSENT: a `normal_balance` column. It is derivable from
-- account_type in one CASE, nothing in this shipment reads it, and a column
-- nothing reads is a column that goes wrong quietly.
create table if not exists accounts (
  id            uuid primary key default gen_random_uuid(),

  tenant_id     uuid not null references tenants(id) on delete cascade,

  -- The accountant's number. DISPLAY AND SORT ONLY — nothing resolves an
  -- account by it (rule 4), and the one function that may is the seed that
  -- creates them.
  code          text not null,
  name          text not null,

  account_type  text not null
                  constraint accounts_type_check
                  check (account_type in
                    ('asset', 'liability', 'equity', 'revenue', 'expense')),

  -- Free text for the accountant: "staff tips, paid out monthly".
  note          text,

  is_active     boolean not null default true,
  display_order integer not null default 0,

  deleted_at    timestamptz,                 -- soft delete (master data, rule 5)
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid default auth.uid() references auth.users(id),
  updated_by    uuid references auth.users(id),

  -- Paired-key target for account_mappings, so a mapping can never point at
  -- another tenant's account (section 6 composite-key consistency).
  constraint accounts_id_tenant_unique unique (id, tenant_id)
);

create unique index if not exists accounts_code_uniq
  on accounts (tenant_id, code)
  where deleted_at is null;

create index if not exists accounts_tenant_idx
  on accounts (tenant_id, account_type, display_order, code)
  where deleted_at is null;

comment on table accounts is
  'THE CHART OF ACCOUNTS, per tenant, seeded and then freely editable. Flat by '
  'design: a hierarchy exists to sum a P&L, which is stage 11. Nothing resolves '
  'an account by `code` (rule 4) — every posting goes through a role key in '
  'account_mappings — so renaming or renumbering an account can never break a '
  'posting path.';
comment on column accounts.code is
  'The accountant''s number, for DISPLAY AND SORT ONLY. The one function allowed '
  'to resolve by it is seed_account_mappings, which is the function that just '
  'created the rows; see its comment, and do not generalise from it.';
comment on column accounts.account_type is
  'asset / liability / equity / revenue / expense. Groups the chart on screen '
  'and is what a later trial balance will branch on. A contra-revenue account '
  '(discounts allowed) is typed `revenue` and carries a debit balance — the '
  'sign, not the type, is what makes it contra.';

drop trigger if exists set_row_audit_accounts on accounts;
create trigger set_row_audit_accounts
  before insert or update on accounts
  for each row execute function set_row_audit();

drop trigger if exists log_field_changes_accounts on accounts;
create trigger log_field_changes_accounts
  after update on accounts
  for each row execute function log_field_changes();


-- ############################################################################
-- SECTION 2 — account_mappings: role key to account
-- ############################################################################
-- THE RULE ARCHITECTURE.md ALREADY STATES, made real: every money movement
-- resolves its account by a ROLE KEY — 'inventory', 'guest_ledger',
-- 'revenue_room' — never by a hardcoded code. A tenant whose chart of accounts
-- differs from Heledon's changes a mapping; nothing in the code changes.
--
-- THE PROPERTY OVERRIDE, and why one nullable column now beats splitting a
-- table that has data in it later. A chart is tenant-wide, but two hotels in one
-- group have two tills, and `cash` at Heledon is not `cash` at the second
-- property. property_id NULL is the TENANT DEFAULT; a row with a property_id
-- OVERRIDES it for that property only. resolve_account looks for the property
-- row, falls back to the tenant row, and raises if neither exists. A group that
-- never needs the override never sees it.
create table if not exists account_mappings (
  id          uuid primary key default gen_random_uuid(),

  tenant_id   uuid not null references tenants(id) on delete cascade,

  -- NULL = the tenant default. Non-null = an override for that property.
  property_id uuid,

  -- The machine key the code posts against. Lower snake case, enforced, so a
  -- GL code can never be smuggled in here as a "key".
  role_key    text not null
                constraint account_mappings_role_key_check
                check (role_key ~ '^[a-z][a-z0-9_]*$'),

  account_id  uuid not null,

  note        text,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid default auth.uid() references auth.users(id),
  updated_by  uuid references auth.users(id),

  constraint account_mappings_account_tenant_fk
    foreign key (account_id, tenant_id)
    references accounts (id, tenant_id),

  constraint account_mappings_property_tenant_fk
    foreign key (property_id, tenant_id)
    references properties (id, tenant_id) on delete cascade
);

-- Two partial unique indexes rather than one, because NULL is not equal to NULL
-- in a unique constraint: a single unique(tenant_id, property_id, role_key)
-- would let a tenant hold two defaults for the same key.
create unique index if not exists account_mappings_default_uniq
  on account_mappings (tenant_id, role_key)
  where property_id is null;

create unique index if not exists account_mappings_property_uniq
  on account_mappings (tenant_id, property_id, role_key)
  where property_id is not null;

comment on table account_mappings is
  'ROLE KEY to account, per tenant, with an optional per-property override '
  '(rule 4). property_id NULL is the tenant default; a row carrying a '
  'property_id overrides it for that property alone. A missing mapping is a '
  'LOUD FAILURE — resolve_account raises and names the key — never a suspense '
  'account, which is a place errors go to be forgotten (rule 6).';
comment on column account_mappings.property_id is
  'NULL = the tenant default, which is what almost every mapping is. Non-null '
  'overrides that one key for that one property — the case is two hotels with '
  'two tills, where `cash` is genuinely a different account.';

drop trigger if exists set_row_audit_account_mappings on account_mappings;
create trigger set_row_audit_account_mappings
  before insert or update on account_mappings
  for each row execute function set_row_audit();

drop trigger if exists log_field_changes_account_mappings on account_mappings;
create trigger log_field_changes_account_mappings
  after update on account_mappings
  for each row execute function log_field_changes();


-- ############################################################################
-- SECTION 3 — journal_entries and journal_entry_lines
-- ############################################################################
-- PERMANENT, exactly as stock_movements is: never updated, never deleted,
-- corrected only by posting a counter-entry. There is no is_voided column here
-- and there will not be one — a voided entry is a fact erased, and an erased
-- fact is what an audit trail exists to prevent. The immutability is a trigger
-- (section 3.2), not a convention.
--
-- ENTRIES ARE NUMBERED. next_document_number(..., 'journal_entry', 'JE') —
-- concurrency-safe, never count(*)+1. An entry an accountant cannot cite by
-- number is one they will not trust.
create table if not exists journal_entries (
  id            uuid primary key default gen_random_uuid(),

  -- Table-wide, monotonic, and the tiebreak for two entries on the same date.
  seq           bigint generated always as identity,

  tenant_id     uuid not null,
  property_id   uuid not null,

  entry_number  text not null,               -- 'JE-000001'

  -- THE BUSINESS DATE (rules 8/12). Every ledger sorts by this, never by
  -- created_at, which is audit metadata and is shown as a separate Posted column
  -- where it differs.
  entry_date    date not null,

  description   text not null
                  constraint journal_entries_description_check
                  check (length(btrim(description)) > 0),

  -- WHAT THIS ENTRY IS FOR. Set together, never separately, and the pair is the
  -- uniqueness key that makes a retried RPC post once (rule 3). Same pattern
  -- stock_movements already uses.
  source_document_type text not null,
  source_document_id   uuid not null,

  -- The entry this one unwinds, on a counter-entry. Reversal is the ONLY way to
  -- undo an entry — the same rule as the stock ledger.
  reverses_entry_id uuid references journal_entries(id),

  idempotency_key text,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid default auth.uid() references auth.users(id),
  updated_by    uuid references auth.users(id),

  -- An entry cannot reverse itself. Cheap, and the mistake is one transposed
  -- variable away in any future reversal path.
  constraint journal_entries_reversal_self_check
    check (reverses_entry_id is null or reverses_entry_id <> id),

  constraint journal_entries_property_tenant_fk
    foreign key (property_id, tenant_id)
    references properties (id, tenant_id) on delete cascade,

  constraint journal_entries_id_tenant_unique unique (id, tenant_id)
);

-- RULE 3, LITERALLY: one entry per source document. A retried RPC cannot post
-- twice, because the second insert hits this index rather than relying on an
-- application-level check that concurrency races past.
create unique index if not exists journal_entries_source_uniq
  on journal_entries (tenant_id, source_document_type, source_document_id);

create unique index if not exists journal_entries_idem_uniq
  on journal_entries (tenant_id, idempotency_key)
  where idempotency_key is not null;

create unique index if not exists journal_entries_number_uniq
  on journal_entries (tenant_id, property_id, entry_number);

-- The hot path: one property's ledger in business-date order (rule 8).
create index if not exists journal_entries_ledger_idx
  on journal_entries (property_id, entry_date, seq);

comment on table journal_entries is
  'THE GENERAL LEDGER. Permanent: never updated, never deleted, corrected only '
  'by a counter-entry (reverses_entry_id) — there is no void, because a voided '
  'entry is a fact erased. ONE entry per source document, enforced by '
  'journal_entries_source_uniq, so a retried RPC posts once. Sorted by '
  'entry_date, the business date (rule 8); created_at is audit metadata and is '
  'never the basis for a user-facing figure.';
comment on column journal_entries.entry_date is
  'The OPERATING DAY this entry belongs to, in the property''s timezone — the '
  'business date of the document it came from, not the day it was keyed. A bar '
  'sale at 02:00 belongs to the previous business day, and its entry says so.';
comment on column journal_entries.source_document_type is
  'What kind of document produced this entry: ''goods_receipt'', '
  '''folio_charge'', ''stock_movement''. Set with source_document_id or not at '
  'all, and the pair is UNIQUE per tenant — which is what makes double-posting '
  'structurally impossible rather than merely unlikely.';

create table if not exists journal_entry_lines (
  id               uuid primary key default gen_random_uuid(),

  tenant_id        uuid not null,
  journal_entry_id uuid not null,

  -- Stable display order within the entry, assigned by post_journal.
  line_number      integer not null
                     constraint journal_entry_lines_number_check
                     check (line_number > 0),

  account_id       uuid not null,

  -- EXACTLY ONE SIDE, always positive. A signed single column would be smaller
  -- and would make every report re-derive which side it was; two columns with an
  -- exclusive check is how every ledger an accountant has ever read is shaped.
  debit            numeric(14,2) not null default 0
                     constraint journal_entry_lines_debit_check check (debit >= 0),
  credit           numeric(14,2) not null default 0
                     constraint journal_entry_lines_credit_check check (credit >= 0),

  -- The ROLE KEY this line resolved through, kept for the mapping screen's
  -- "when did something last post here" column. NOT a second source of truth
  -- about the account: account_id is what the entry means, and this records how
  -- it was chosen. If the mapping is later repointed, past lines still say which
  -- key they came from, which is exactly what makes the screen honest.
  role_key         text,

  description      text,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid default auth.uid() references auth.users(id),
  updated_by       uuid references auth.users(id),

  -- Exactly one side carries a value, and it is non-zero. Both zero is a line
  -- that says nothing; both non-zero is a line that says two things.
  constraint journal_entry_lines_one_side_check
    check ((debit > 0) <> (credit > 0)),

  constraint journal_entry_lines_entry_tenant_fk
    foreign key (journal_entry_id, tenant_id)
    references journal_entries (id, tenant_id) on delete cascade,

  constraint journal_entry_lines_account_tenant_fk
    foreign key (account_id, tenant_id)
    references accounts (id, tenant_id),

  constraint journal_entry_lines_number_uniq
    unique (journal_entry_id, line_number)
);

create index if not exists journal_entry_lines_account_idx
  on journal_entry_lines (tenant_id, account_id);

-- The mapping screen's "last posted" lookup (rule: derived, never maintained
-- by hand). Partial, because a line without a role key was posted before this
-- column existed or by a path that resolved an account directly.
create index if not exists journal_entry_lines_role_key_idx
  on journal_entry_lines (tenant_id, role_key)
  where role_key is not null;

comment on table journal_entry_lines is
  'The lines of an entry. Exactly one of debit/credit is non-zero on each — an '
  'exclusive check, not a convention. Debits equal credits for the entry as a '
  'whole, asserted in post_journal BEFORE the insert, so an unbalanced entry is '
  'never written and never needs cleaning up.';
comment on column journal_entry_lines.role_key is
  'The role key this line resolved through, recorded so the mapping screen can '
  'show when something last posted to each key WITHOUT anyone maintaining that '
  'by hand. Not a second source of truth about the account — account_id is what '
  'the line means. Repointing a mapping leaves past lines saying which key they '
  'came from, which is what keeps the screen honest.';

-- ----------------------------------------------------------------------------
-- 3.2 The ledger is genuinely immutable
-- ----------------------------------------------------------------------------
-- Same shape as forbid_stock_movement_change (036), and for the same reason: a
-- ledger that can be edited is a ledger nobody can rely on, and "we agreed not
-- to" is not a mechanism. The cascade exception is detected the same way — if
-- the parent no longer exists, this DELETE is Postgres tidying up after a hard
-- delete, not a person erasing a fact.
create or replace function forbid_journal_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    if not exists (select 1 from tenants t where t.id = old.tenant_id) then
      return old;  -- cascade from a tenant teardown: let it through
    end if;
    raise exception
      'Journal entries are permanent and cannot be deleted. Reverse the entry with a counter-entry instead.'
      using errcode = 'PT403',
            hint = 'A reversal leaves both the original and the correction on the ledger, which is what an audit trail is for.';
  end if;

  raise exception
    'Journal entries are permanent and cannot be edited. Reverse the entry with a counter-entry instead.'
    using errcode = 'PT403',
          hint = 'A reversal leaves both the original and the correction on the ledger, which is what an audit trail is for.';
end;
$$;

comment on function forbid_journal_change() is
  'Makes the ledger genuinely immutable: refuses every UPDATE and every DELETE '
  'on journal_entries and journal_entry_lines, except the cascade from a tenant '
  'being hard-deleted (detected by the parent no longer existing). The only '
  'correction is a counter-entry — the same rule as the stock ledger.';

drop trigger if exists forbid_journal_entry_change on journal_entries;
create trigger forbid_journal_entry_change
  before update or delete on journal_entries
  for each row execute function forbid_journal_change();

-- The lines carry tenant_id too, so the same function works for both tables.
drop trigger if exists forbid_journal_entry_line_change on journal_entry_lines;
create trigger forbid_journal_entry_line_change
  before update or delete on journal_entry_lines
  for each row execute function forbid_journal_change();

-- set_row_audit still fires on INSERT so created_by/created_at are stamped by
-- the database and never trusted from a caller. It cannot fire on UPDATE,
-- because an UPDATE cannot happen.
drop trigger if exists set_row_audit_journal_entries on journal_entries;
create trigger set_row_audit_journal_entries
  before insert on journal_entries
  for each row execute function set_row_audit();

drop trigger if exists set_row_audit_journal_entry_lines on journal_entry_lines;
create trigger set_row_audit_journal_entry_lines
  before insert on journal_entry_lines
  for each row execute function set_row_audit();


-- ############################################################################
-- SECTION 4 — resolve_account
-- ############################################################################
-- Rule 4's whole point, in one function. Property override first, tenant default
-- second, and a LOUD FAILURE third — never a suspense account.
--
-- WHY A MISSING MAPPING RAISES RATHER THAN RETURNING NULL: a null would be
-- checked by the caller, and one caller will eventually forget. The refusal has
-- to happen where the rule lives (rule 21), and it names the role key, because
-- "no account is mapped" without saying WHICH is a message that sends somebody
-- to read the source.
create or replace function resolve_account(
  p_tenant_id   uuid,
  p_property_id uuid,
  p_role_key    text
)
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_account uuid;
begin
  if p_tenant_id is null or p_role_key is null then
    raise exception 'resolve_account requires a tenant and a role key'
      using errcode = 'PT422';
  end if;

  -- The property override, if this property has one.
  if p_property_id is not null then
    select am.account_id into v_account
    from account_mappings am
    join accounts a
      on a.id = am.account_id
     and a.tenant_id = am.tenant_id
    where am.tenant_id   = p_tenant_id
      and am.property_id = p_property_id
      and am.role_key    = p_role_key
      and a.deleted_at is null
      and a.is_active;

    if v_account is not null then
      return v_account;
    end if;
  end if;

  -- The tenant default.
  select am.account_id into v_account
  from account_mappings am
  join accounts a
    on a.id = am.account_id
   and a.tenant_id = am.tenant_id
  where am.tenant_id = p_tenant_id
    and am.property_id is null
    and am.role_key    = p_role_key
    and a.deleted_at is null
    and a.is_active;

  if v_account is null then
    raise exception
      'No account is mapped to "%", so this cannot be posted.', p_role_key
      using errcode = 'PT424',
            hint = 'Open Settings, then Accounts, and choose the account this should post to. Nothing is written until it is mapped.';
  end if;

  return v_account;
end;
$$;

comment on function resolve_account(uuid, uuid, text) is
  'Resolves a ROLE KEY to an account (rule 4): the property override first, the '
  'tenant default second, and PT424 naming the missing key third. Never returns '
  'NULL and never falls back to a suspense account — a null would be checked by '
  'every caller and one caller would eventually forget, and a suspense account '
  'is a place errors go to be forgotten (rule 6). Also skips an account that has '
  'been deactivated or soft-deleted, so retiring an account fails loudly at the '
  'next posting rather than silently posting into a dead account.';


-- ############################################################################
-- SECTION 5 — post_journal: the one implementation
-- ############################################################################
-- EVERY money RPC posts through this. No client-side posting, ever; no backfill
-- page, ever. See the dated gap in the file header for exactly when that becomes
-- true of each module.
--
-- ----------------------------------------------------------------------------
-- THE LINE PAYLOAD
-- ----------------------------------------------------------------------------
-- p_lines is a jsonb array of objects:
--   { "role_key": "inventory", "side": "debit", "amount": 12500.00,
--     "description": "Rice, 25kg" }
--
-- AT MOST ONE LINE MAY OMIT `amount` (or pass null). That line BALANCES the
-- entry: its amount becomes the difference between the two sides. This is the
-- "one side is computed, the other is the sum of it" rule, and it exists because
-- computing both sides independently is how an entry comes to disagree with
-- itself by a kobo. Build the debit lines from the real figures, then let the
-- credit be the sum of what was actually written.
--
-- ----------------------------------------------------------------------------
-- THE ROUNDING LINE, AND WHY IT IS CAPPED
-- ----------------------------------------------------------------------------
-- Weighted-average cost carries four decimals (section 6: quantities are
-- numeric(14,4)) and the ledger carries two, so an entry built from stock will
-- sometimes miss by a kobo even when every input is correct. ONE
-- 'rounding_difference' line absorbs it — and the entry is REFUSED if the gap
-- exceeds 1.00.
--
-- THE CAP IS WHAT MAKES IT A ROUNDING LINE RATHER THAN A SUSPENSE ACCOUNT. An
-- uncapped absorber is where a real error goes to be forgotten: the entry
-- balances, nothing warns, and the wrong figure is now on the books wearing the
-- costume of an accounting nicety. Rule 6 stands — nothing else in this system
-- may absorb a discrepancy.
--
-- ----------------------------------------------------------------------------
-- gl_start_date: BOOKS NOTHING, REFUSES NOTHING
-- ----------------------------------------------------------------------------
-- An entry dated before the property's gl_start_date returns NULL and writes no
-- row. THE DOCUMENT THAT CALLED IT STILL POSTS NORMALLY. This is the opposite of
-- assert_posting_open, which refuses the document outright. Two date columns
-- sitting side by side with opposite effects, and the only defence is words —
-- see the column comment in SECTION 6.
create or replace function post_journal(
  p_property_id          uuid,
  p_entry_date           date,
  p_description          text,
  p_source_document_type text,
  p_source_document_id   uuid,
  p_lines                jsonb,
  p_idempotency_key      text default null,
  p_reverses_entry_id    uuid default null
)
returns journal_entries
language plpgsql
security definer
set search_path = public
as $$
declare
  -- THE CAP THAT MAKES IT A ROUNDING LINE. See the header above.
  c_rounding_cap constant numeric(14,2) := 1.00;

  v_tenant     uuid;
  v_timezone   text;
  v_today      date;
  v_gl_start   date;
  v_existing   journal_entries;
  v_entry      journal_entries;
  v_number     text;

  -- The resolved lines, accumulated as jsonb rather than in a temp table: this
  -- function pins search_path to public (it is SECURITY DEFINER), so a temporary
  -- table would not resolve without putting pg_temp on the path — which is
  -- exactly the injection surface the pinned path exists to close.
  v_resolved   jsonb := '[]'::jsonb;

  v_line       jsonb;
  v_side       text;
  v_amount     numeric(14,2);
  v_role       text;
  v_account    uuid;
  v_n          integer := 0;
  v_open       integer := 0;   -- how many lines asked to be the balancing line
  v_open_side  text;
  v_open_role  text;
  v_open_desc  text;
  v_debits     numeric(14,2) := 0;
  v_credits    numeric(14,2) := 0;
  v_diff       numeric(14,2);
begin
  -- ---- the property, and who is asking -------------------------------------
  select p.tenant_id, p.timezone into v_tenant, v_timezone
  from properties p
  where p.id = p_property_id and p.deleted_at is null;

  if v_tenant is null then
    raise exception 'Property % not found', p_property_id using errcode = 'PT404';
  end if;

  if not is_tenant_staff(v_tenant) then
    raise exception 'Not authorised to post to this property''s ledger'
      using errcode = 'insufficient_privilege';
  end if;

  if p_source_document_type is null or btrim(p_source_document_type) = ''
     or p_source_document_id is null then
    raise exception 'A journal entry must name the document it came from'
      using errcode = 'PT422',
            hint = 'Pass source_document_type and source_document_id together — the pair is what stops the same document posting twice.';
  end if;

  -- ---- RULE 3: one entry per source document -------------------------------
  -- Checked BEFORE anything else is computed, so a retry is cheap and returns
  -- the entry that already exists rather than racing to build a duplicate.
  select * into v_existing
  from journal_entries je
  where je.tenant_id = v_tenant
    and je.source_document_type = p_source_document_type
    and je.source_document_id   = p_source_document_id;

  if found then
    return v_existing;
  end if;

  if p_idempotency_key is not null then
    select * into v_existing
    from journal_entries je
    where je.tenant_id = v_tenant
      and je.idempotency_key = p_idempotency_key;
    if found then
      return v_existing;
    end if;
  end if;

  -- ---- the date ------------------------------------------------------------
  if p_entry_date is null then
    raise exception 'A journal entry must carry a business date'
      using errcode = 'PT422';
  end if;

  v_today := (now() at time zone
              coalesce(nullif(btrim(v_timezone), ''), 'Africa/Lagos'))::date;

  if p_entry_date > v_today then
    raise exception
      'A journal entry cannot be dated in the future (today is % at this property)', v_today
      using errcode = 'PT422';
  end if;

  -- THE GO-LIVE GATE. Before the books opened: no entry, no error, and the
  -- caller's own document is entirely unaffected. This is the OPPOSITE of the
  -- posting lock immediately below, which refuses the document outright.
  select pfs.gl_start_date into v_gl_start
  from property_finance_settings pfs
  where pfs.property_id = p_property_id;

  if v_gl_start is not null and p_entry_date < v_gl_start then
    return null;
  end if;

  -- One implementation, called by every posting RPC (038 section 4.1).
  perform assert_posting_open(p_property_id, p_entry_date);

  -- ---- build the lines -----------------------------------------------------
  if p_lines is null or jsonb_typeof(p_lines) <> 'array'
     or jsonb_array_length(p_lines) < 2 then
    raise exception 'A journal entry needs at least two lines'
      using errcode = 'PT422',
            hint = 'Every entry has at least one debit and one credit — that is what makes it an entry rather than a note.';
  end if;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_role := nullif(btrim(coalesce(v_line ->> 'role_key', '')), '');
    v_side := lower(nullif(btrim(coalesce(v_line ->> 'side', '')), ''));

    if v_role is null then
      raise exception 'Every journal line must name a role key'
        using errcode = 'PT422';
    end if;
    if v_side is null or v_side not in ('debit', 'credit') then
      raise exception 'The journal line for "%" must say debit or credit', v_role
        using errcode = 'PT422';
    end if;

    -- RULE 4, for every line without exception. Resolving here rather than at
    -- write time means a missing mapping refuses BEFORE any row is written, so
    -- proof 3's "no entry, no partial write" holds by construction.
    v_account := resolve_account(v_tenant, p_property_id, v_role);

    if (v_line -> 'amount') is null
       or jsonb_typeof(v_line -> 'amount') = 'null' then
      -- THE BALANCING LINE. At most one; filled in below, once the rest are
      -- known, as the sum of the other side.
      v_open := v_open + 1;
      if v_open > 1 then
        raise exception 'Only one journal line may be left to balance the entry'
          using errcode = 'PT422',
                hint = 'Give every other line an amount. Two open lines have no single answer.';
      end if;
      v_open_side := v_side;
      v_open_role := v_role;
      v_open_desc := nullif(btrim(coalesce(v_line ->> 'description', '')), '');
    else
      v_amount := round((v_line ->> 'amount')::numeric, 2);
      if v_amount is null or v_amount <= 0 then
        raise exception 'The journal line for "%" must carry a positive amount', v_role
          using errcode = 'PT422',
                hint = 'The side says which way the money goes; the amount is always positive.';
      end if;

      v_n := v_n + 1;
      v_resolved := v_resolved || jsonb_build_object(
        'line_number', v_n,
        'account_id',  v_account,
        'role_key',    v_role,
        'side',        v_side,
        'amount',      v_amount,
        'description', nullif(btrim(coalesce(v_line ->> 'description', '')), '')
      );

      if v_side = 'debit' then
        v_debits := v_debits + v_amount;
      else
        v_credits := v_credits + v_amount;
      end if;
    end if;
  end loop;

  -- ---- the balancing line, if one was asked for ----------------------------
  -- "One side is computed, the other is the sum of it. Never both
  -- independently." Computing both is how an entry comes to disagree with
  -- itself by a kobo, and then the rounding line absorbs a difference that
  -- should never have existed.
  if v_open = 1 then
    if v_open_side = 'debit' then
      v_amount := v_credits - v_debits;
    else
      v_amount := v_debits - v_credits;
    end if;

    if v_amount <= 0 then
      raise exception
        'The line left to balance this entry works out at %, which is not a posting.', v_amount
        using errcode = 'PT422',
              hint = 'It is on the wrong side, or the other lines already balance. Check which side the open line is on.';
    end if;

    v_n := v_n + 1;
    v_account := resolve_account(v_tenant, p_property_id, v_open_role);
    v_resolved := v_resolved || jsonb_build_object(
      'line_number', v_n,
      'account_id',  v_account,
      'role_key',    v_open_role,
      'side',        v_open_side,
      'amount',      v_amount,
      'description', v_open_desc
    );

    if v_open_side = 'debit' then
      v_debits := v_debits + v_amount;
    else
      v_credits := v_credits + v_amount;
    end if;
  end if;

  if v_n < 2 then
    raise exception 'A journal entry needs at least two lines'
      using errcode = 'PT422',
            hint = 'Every entry has at least one debit and one credit — that is what makes it an entry rather than a note.';
  end if;

  -- ---- DEBITS EQUAL CREDITS OR NOTHING IS WRITTEN --------------------------
  -- Asserted HERE, before the insert, not by a trigger afterwards. A trigger
  -- that rejects an unbalanced entry has already let half of it be written and
  -- is relying on the transaction unwinding; this simply never writes one.
  v_diff := v_debits - v_credits;

  if v_diff <> 0 then
    if abs(v_diff) > c_rounding_cap then
      raise exception
        'This entry does not balance: debits of %, credits of %, a difference of %.',
        v_debits, v_credits, v_diff
        using errcode = 'PT422',
              hint = 'A gap larger than 1.00 is an error in the figures, not rounding. Nothing has been written.';
    end if;

    -- ONE rounding line, on whichever side is short.
    v_n := v_n + 1;
    v_account := resolve_account(v_tenant, p_property_id, 'rounding_difference');
    v_resolved := v_resolved || jsonb_build_object(
      'line_number', v_n,
      'account_id',  v_account,
      'role_key',    'rounding_difference',
      'side',        case when v_diff > 0 then 'credit' else 'debit' end,
      'amount',      abs(v_diff),
      'description', 'Rounding'
    );

    if v_diff > 0 then
      v_credits := v_credits + abs(v_diff);
    else
      v_debits := v_debits + abs(v_diff);
    end if;
  end if;

  -- Belt and braces. After the rounding line the two sides are equal by
  -- construction; if they are not, something above is wrong and nothing should
  -- be written on the strength of it.
  if v_debits <> v_credits then
    raise exception 'post_journal failed to balance the entry (% against %)',
      v_debits, v_credits
      using errcode = 'PT422';
  end if;

  -- ---- write it ------------------------------------------------------------
  v_number := next_document_number(v_tenant, p_property_id, 'journal_entry', 'JE');

  begin
    insert into journal_entries (
      tenant_id, property_id, entry_number, entry_date, description,
      source_document_type, source_document_id, reverses_entry_id,
      idempotency_key, created_by
    ) values (
      v_tenant, p_property_id, v_number, p_entry_date, btrim(p_description),
      btrim(p_source_document_type), p_source_document_id, p_reverses_entry_id,
      p_idempotency_key, auth.uid()
    )
    returning * into v_entry;
  exception
    when unique_violation then
      -- Two callers raced past the lookup at the top. The other one won; return
      -- its entry rather than an error the user can do nothing about.
      select * into v_existing
      from journal_entries je
      where je.tenant_id = v_tenant
        and je.source_document_type = btrim(p_source_document_type)
        and je.source_document_id   = p_source_document_id;
      if found then
        return v_existing;
      end if;
      raise;
  end;

  insert into journal_entry_lines (
    tenant_id, journal_entry_id, line_number, account_id, role_key,
    debit, credit, description, created_by
  )
  select
    v_tenant,
    v_entry.id,
    (l ->> 'line_number')::integer,
    (l ->> 'account_id')::uuid,
    l ->> 'role_key',
    case when l ->> 'side' = 'debit'  then (l ->> 'amount')::numeric else 0 end,
    case when l ->> 'side' = 'credit' then (l ->> 'amount')::numeric else 0 end,
    l ->> 'description',
    auth.uid()
  from jsonb_array_elements(v_resolved) as l
  order by (l ->> 'line_number')::integer;

  return v_entry;
end;
$$;

comment on function post_journal(uuid, date, text, text, uuid, jsonb, text, uuid) is
  'THE ONE journal-posting implementation. Every money RPC calls it inside its '
  'own transaction; nothing posts client-side and there is no backfill page. '
  'Resolves every line by ROLE KEY (rule 4) BEFORE writing anything, so a '
  'missing mapping leaves no partial entry. Refuses an unbalanced entry. Allows '
  'at most ONE line to be left open, whose amount becomes the sum of the other '
  'side — never both sides computed independently. Absorbs at most 1.00 of '
  'rounding into a single rounding_difference line: capped, so it is a rounding '
  'line and not a suspense account. Returns NULL and writes nothing for an entry '
  'dated before the property''s gl_start_date, leaving the calling document '
  'untouched. ONE entry per source document (rule 3), enforced by a unique index '
  'rather than by an application check that concurrency races past.';


-- ############################################################################
-- SECTION 6 — gl_start_date
-- ############################################################################
-- THE ONE NEW SETTING, and it earns its place where most would not.
--
-- Without it, every test movement posted into Heledon's inventory during the
-- build lands in the ledger the day the hotel goes live, and the first real
-- trial balance is wrong before anyone has sold a room. It is set once, at
-- go-live, by one person, and never touched again — which is why the writer
-- below refuses to change it once anything has posted.
--
-- IT LIVES HERE, NOT IN property_settings, for the reason 021 gave when it
-- created this table: property_settings has a public (anon) read policy for the
-- guest site and RLS cannot hide a single column. A go-live date is internal
-- financial policy of exactly the same kind as the discount threshold and the
-- posting lock, and it belongs beside them.
alter table property_finance_settings
  add column if not exists gl_start_date date;

comment on column property_finance_settings.gl_start_date is
  'THE DAY THE BOOKS OPEN for this property. A document dated BEFORE it posts '
  'normally and books NO journal entry; post_journal returns null and writes '
  'nothing. NULL (the default) means every entry posts. '
  'THE MIRROR IMAGE OF posting_locked_through, AND THE ONLY DEFENCE IS WORDS: '
  'the posting LOCK refuses the document outright, naming the closed period; the '
  'GL START DATE lets the document through and simply books nothing. Two date '
  'columns side by side with opposite effects. Set once at go-live; the writer '
  'refuses to change it once any entry exists, because moving it later orphans '
  'entries already posted and moving it earlier implies documents that would '
  'have posted and cannot now be made to.';

-- ----------------------------------------------------------------------------
-- 6.1 The settings writer learns the new field
-- ----------------------------------------------------------------------------
-- Re-emitted whole, as 023 -> 038 -> 039 each did. Same optimistic updated_at
-- check, same PT404/PT403/PT409/PT422 SQLSTATEs.
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
  v_timezone   text;
  v_updated_at timestamptz;
  v_threshold  numeric;
  v_variance   numeric;
  v_lock       date;
  v_today      date;
  v_gl_new     date;
  v_gl_old     date;
  v_entries    boolean;
  v_result     property_finance_settings;
begin
  select p.tenant_id, p.timezone
    into v_tenant_id, v_timezone
  from properties p
  where p.id = p_property_id
    and p.deleted_at is null;

  if v_tenant_id is null then
    raise exception 'Property % not found', p_property_id
      using errcode = 'PT404';
  end if;

  if not is_tenant_admin(v_tenant_id) then
    raise exception 'You are not authorised to edit this property''s finance settings'
      using errcode = 'PT403';
  end if;

  select pfs.updated_at, pfs.gl_start_date
    into v_updated_at, v_gl_old
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

  if p_patch ? 'count_variance_threshold' then
    v_variance := (p_patch ->> 'count_variance_threshold')::numeric;
    if v_variance is null then
      raise exception 'Enter a count approval threshold (use 0 to require a manager for every count with a variance)'
        using errcode = 'PT422',
              hint = 'It is a value, not a quantity — 3 kg of saffron and 3 kg of rice are not the same event.';
    end if;
    if v_variance < 0 then
      raise exception 'The count approval threshold cannot be negative'
        using errcode = 'PT422';
    end if;
  end if;

  v_today := (now() at time zone coalesce(nullif(btrim(v_timezone), ''), 'Africa/Lagos'))::date;

  if p_patch ? 'posting_locked_through' then
    v_lock := nullif(btrim(coalesce(p_patch ->> 'posting_locked_through', '')), '')::date;

    if v_lock is not null and v_lock > v_today then
      raise exception
        'The posting lock cannot be set to a future date (today is % at this property)', v_today
        using errcode = 'PT422',
              hint = 'Lock a period once it is closed, not before it has happened.';
    end if;
  end if;

  -- gl_start_date. A FUTURE date is legitimate and deliberately allowed: "we
  -- open on 1 October" is exactly how this gets set. What is refused is CHANGING
  -- it once the ledger has anything in it.
  if p_patch ? 'gl_start_date' then
    v_gl_new := nullif(btrim(coalesce(p_patch ->> 'gl_start_date', '')), '')::date;

    if v_gl_new is distinct from v_gl_old then
      select exists (
        select 1 from journal_entries je where je.property_id = p_property_id
      ) into v_entries;

      if v_entries then
        raise exception
          'The books have already opened for this property, so the GL start date cannot be moved.'
          using errcode = 'PT409',
                hint = 'Moving it later would orphan entries already posted, and moving it earlier would imply documents that should have posted and now cannot. Correct the ledger with journal entries instead.';
      end if;
    end if;
  end if;

  update property_finance_settings
     set discount_threshold = case
                                when p_patch ? 'discount_threshold'
                                  then (p_patch ->> 'discount_threshold')::numeric
                                else discount_threshold
                              end,
         count_variance_threshold = case
                                      when p_patch ? 'count_variance_threshold'
                                        then (p_patch ->> 'count_variance_threshold')::numeric
                                      else count_variance_threshold
                                    end,
         posting_locked_through = case
                                    when p_patch ? 'posting_locked_through'
                                      then nullif(btrim(coalesce(p_patch ->> 'posting_locked_through', '')), '')::date
                                    else posting_locked_through
                                  end,
         gl_start_date = case
                           when p_patch ? 'gl_start_date'
                             then nullif(btrim(coalesce(p_patch ->> 'gl_start_date', '')), '')::date
                           else gl_start_date
                         end
   where property_id = p_property_id
  returning * into v_result;

  return v_result;
end;
$$;

comment on function update_property_finance_settings(uuid, jsonb, timestamptz) is
  'Patch property_finance_settings (discount_threshold, count_variance_threshold, '
  'posting_locked_through, gl_start_date) under an optimistic updated_at check — '
  'the same shape and the same PT404/PT403/PT409/PT422 SQLSTATEs as 008''s four '
  'settings writers. The two thresholds are NOT NULL with a meaningful 0, so a '
  'cleared field is refused; the lock date and the GL start date are nullable, so '
  'an ABSENT key leaves each alone and an explicit null clears it. The GL start '
  'date MAY be in the future (a planned go-live) but may NOT be changed once the '
  'property has any journal entry. Admin-gated, SECURITY DEFINER.';


-- ############################################################################
-- SECTION 7 — the seeds
-- ############################################################################
-- THE FIFTH USE OF THE EXISTING PATTERN, not a new mechanism: an idempotent
-- seed_X(id) keyed on the natural key, a trigger wrapper on tenants, and a
-- backfill loop in this same migration. Exactly how seed_charge_categories,
-- seed_tax_charges, seed_tenant_inventory_reference and create_default_locations
-- already work.

-- ----------------------------------------------------------------------------
-- 7.1 seed_chart_of_accounts
-- ----------------------------------------------------------------------------
-- A starting chart for a Nigerian hotel. DEFAULTS ONLY — the tenant renames,
-- renumbers, deactivates and extends them freely, and nothing in the code
-- resolves an account by code, so none of that can break a posting path.
--
-- FOUR ACCOUNTS ARE SEEDED WITH NO MAPPING, on purpose, and each is named in
-- 7.2's comment: VAT input recoverable, withholding tax payable, retained
-- earnings and cost of sales. They exist so they are there when someone needs
-- them; they are unmapped because NOTHING WRITES THEM YET, and a mapping to an
-- account no code posts to is a claim the mapping screen would have to keep
-- explaining.
create or replace function seed_chart_of_accounts(p_tenant_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into accounts (tenant_id, code, name, account_type, display_order, note)
  select p_tenant_id, d.code, d.name, d.account_type, d.display_order, d.note
  from (values
    -- Assets
    ('1000', 'Cash',                    'asset',      10,  null),
    ('1010', 'Bank',                    'asset',      20,  null),
    ('1020', 'POS clearing',            'asset',      30,
     'Card takings between the terminal and the bank. Cleared when the acquirer settles, usually net of commission.'),
    ('1200', 'Guest ledger',            'asset',      40,
     'What guests owe. Reconciles to the sum of open folio balances.'),
    ('1210', 'Company receivable',      'asset',      50,
     'What corporate accounts owe, billed to the company rather than the guest.'),
    ('1300', 'Inventory',               'asset',      60,
     'Stock on hand at weighted-average cost. Reconciles to stock_valuation.'),
    ('1500', 'Fixed assets',            'asset',      70,  null),
    -- Liabilities
    ('2000', 'Supplier payable',        'liability',  110, null),
    ('2100', 'VAT output',              'liability',  120,
     'VAT charged to guests and owed to the FIRS.'),
    ('2110', 'VAT input recoverable',   'liability',  130,
     'Seeded but NOT mapped: purchase orders carry a cost and no tax, so nothing writes this yet.'),
    ('2200', 'Service charge payable',  'liability',  140,
     'The service charge, held as a liability until the hotel confirms it keeps it. Money that may belong to staff should not sit in revenue by default.'),
    ('2300', 'Withholding tax payable', 'liability',  150,
     'Seeded but NOT mapped: nothing withholds until supplier payments exist.'),
    -- Equity
    ('3000', 'Opening balance equity',  'equity',     210,
     'The other side of an opening stock balance and of any opening chart balance.'),
    ('3900', 'Retained earnings',       'equity',     220,
     'Seeded but NOT mapped: nothing writes it until a P&L exists (stage 11).'),
    -- Revenue
    ('4000', 'Room revenue',            'revenue',    310, null),
    ('4010', 'Food and beverage revenue','revenue',   320, null),
    ('4020', 'Laundry revenue',         'revenue',    330, null),
    ('4030', 'Internet revenue',        'revenue',    340, null),
    ('4040', 'Minibar revenue',         'revenue',    350, null),
    ('4050', 'Transport revenue',       'revenue',    360, null),
    ('4060', 'Extra bed revenue',       'revenue',    370, null),
    ('4070', 'Early check-in revenue',  'revenue',    380, null),
    ('4080', 'Late check-out revenue',  'revenue',    390, null),
    ('4090', 'Damage recovery',         'revenue',    400, null),
    ('4100', 'Other revenue',           'revenue',    410, null),
    ('4900', 'Discounts allowed',       'revenue',    490,
     'Contra-revenue: carries a DEBIT balance. Typed revenue because that is where it belongs on a P&L; the sign is what makes it contra.'),
    -- Expenses
    ('5000', 'Cost of sales',           'expense',    510,
     'Seeded but NOT mapped: nothing consumes stock until recipes exist (6.2), and the granularity question is "which item", not "food or drink".'),
    ('5100', 'Stock adjustment',        'expense',    520,
     'A correction: the count was wrong. Kept apart from write-offs, because blurring the two makes the variance report worthless.'),
    ('5110', 'Stock count variance',    'expense',    530,
     'The variance a physical count posted.'),
    ('5200', 'Spoilage',                'expense',    540, null),
    ('5210', 'Breakage',                'expense',    550, null),
    ('5220', 'Expiry',                  'expense',    560, null),
    ('5230', 'Staff meals',             'expense',    570,
     'A cost of doing business, not a loss to chase.'),
    ('5240', 'Complimentaries',         'expense',    580,
     'A cost of doing business, not a loss to chase.'),
    ('5900', 'Rounding difference',     'expense',    590,
     'Absorbs at most 1.00 on an entry built from four-decimal costs. CAPPED in post_journal, which is what makes it a rounding line and not a suspense account.')
  ) as d(code, name, account_type, display_order, note)
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
  'an account someone has renamed.';

-- ----------------------------------------------------------------------------
-- 7.2 seed_account_mappings
-- ----------------------------------------------------------------------------
-- THE ONE PLACE A LITERAL ACCOUNT CODE MAY APPEAR, and the reason is narrow: this
-- is the function that just created those rows, in the statement immediately
-- above, so resolving '1300' here is resolving something this same seed put
-- there. DO NOT GENERALISE FROM IT. Everywhere else — every RPC, every view,
-- every line of client code — an account is reached through a role key, because
-- the tenant is free to renumber and the key is the only thing that survives it.
--
-- Every key seeded here has a WRITER in code that exists today or in 1.1h2/1.1h3.
-- Four accounts are deliberately left unmapped (VAT input recoverable,
-- withholding tax payable, retained earnings, cost of sales) — see 7.1.
--
-- THERE IS NO guest_deposits KEY, AND THAT IS A DECISION RATHER THAN AN
-- OVERSIGHT. Strictly, money held for a stay that has not begun is a LIABILITY,
-- not negative accounts-receivable. But record_payment (021) already treats a
-- pre-arrival deposit as "simply a positive payment on the already-open folio",
-- so it lands in guest_ledger as a credit balance and needs no key of its own.
-- Splitting it would mean teaching record_payment about arrival state — a real
-- change to a working posting path, to move a number between two lines nobody
-- has yet asked to see apart. A KNOWN SIMPLIFICATION, recorded here so whoever
-- revisits it knows it was weighed and not missed. It becomes worth doing the
-- day somebody needs deposits held separately on a balance sheet, which is
-- stage 11 at the earliest.
create or replace function seed_account_mappings(p_tenant_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
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
  'Seeds a tenant''s DEFAULT role-key mappings. THE ONE PLACE A LITERAL ACCOUNT '
  'CODE MAY APPEAR, and only because this resolves rows seed_chart_of_accounts '
  'created in the statement above — do not generalise from it (rule 4). '
  'Idempotent: skips any role key already mapped, so it never overwrites a '
  'mapping someone has repointed. Every key seeded has a writer in code today or '
  'in 1.1h2/1.1h3; four seeded ACCOUNTS are deliberately left unmapped because '
  'nothing writes them yet.';

-- ----------------------------------------------------------------------------
-- 7.3 The trigger, and the backfill
-- ----------------------------------------------------------------------------
create or replace function seed_tenant_accounts_trigger()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform seed_chart_of_accounts(new.id);
  perform seed_account_mappings(new.id);
  return null;                       -- AFTER trigger: return value ignored.
end;
$$;

drop trigger if exists seed_accounts_after_tenant_insert on tenants;
create trigger seed_accounts_after_tenant_insert
  after insert on tenants
  for each row execute function seed_tenant_accounts_trigger();

do $$
declare
  r record;
begin
  for r in select id from tenants loop
    perform seed_chart_of_accounts(r.id);
    perform seed_account_mappings(r.id);
  end loop;
end $$;


-- ############################################################################
-- SECTION 8 — a charge category cannot exist without an account
-- ############################################################################
-- "Choosing the account is part of creating a charge category. Not a warning
-- afterwards." The alternative is the first post_charge refusing at the front
-- desk, in front of a guest, for a configuration mistake made weeks earlier by
-- somebody else — which is the most likely support call of month one.
--
-- ----------------------------------------------------------------------------
-- 8.1 The column says what it holds
-- ----------------------------------------------------------------------------
-- 021 called it `account_code` and its comment already had to explain that it
-- holds a ROLE KEY rather than a code. A column whose name contradicts its
-- comment gets used according to its name. Renamed now, while nothing reads it —
-- the type declares it and no query consumes it — because after 1.1h4 it will be
-- read everywhere.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'charge_categories'
      and column_name  = 'account_code'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'charge_categories'
      and column_name  = 'account_role_key'
  ) then
    alter table charge_categories rename column account_code to account_role_key;
  end if;
end $$;

-- Belt and braces for a fresh database where 021 ran without the column.
alter table charge_categories
  add column if not exists account_role_key text;

comment on column charge_categories.account_role_key is
  'The account_mappings ROLE KEY this category''s revenue posts to (rule 4 — '
  'never a literal GL code). Convention is ''revenue_'' || code, which is what '
  'the seed and the backfill use and what a category form prefills. REQUIRED: a '
  'category that cannot be charged to should not exist, because the alternative '
  'is the first charge refusing at the front desk for a configuration mistake '
  'made weeks earlier.';

-- ----------------------------------------------------------------------------
-- 8.2 The seed sets it, so a new tenant is complete on the first insert
-- ----------------------------------------------------------------------------
-- Re-emitted whole. TWO CHANGES: it sets account_role_key, and it makes sure the
-- chart and the mappings exist FIRST.
--
-- WHY IT CALLS THE OTHER TWO SEEDS. Both this and seed_accounts_after_tenant_insert
-- hang off `after insert on tenants`, and Postgres fires AFTER triggers in NAME
-- order — a dependency that is invisible from either function and would break the
-- day somebody renamed a trigger. Calling the seeds it depends on (both
-- idempotent, both no-ops if the other trigger already ran) makes the order
-- irrelevant instead of merely lucky.
create or replace function seed_charge_categories(p_tenant_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform seed_chart_of_accounts(p_tenant_id);
  perform seed_account_mappings(p_tenant_id);

  insert into charge_categories
    (tenant_id, code, name, is_taxable, service_chargeable, display_order,
     account_role_key)
  select p_tenant_id, d.code, d.name, d.is_taxable, d.service_chargeable,
         d.display_order, 'revenue_' || d.code
  from (values
    ('room',          'Room',            true,  true,  10),
    ('fnb',           'Food & Beverage', true,  true,  20),
    ('laundry',       'Laundry',         true,  true,  30),
    ('internet',      'Internet',        true,  false, 40),
    ('minibar',       'Minibar',         true,  true,  50),
    ('transport',     'Transport',       true,  false, 60),
    ('extra_bed',     'Extra Bed',       true,  true,  70),
    ('early_checkin', 'Early Check-in',  true,  true,  80),
    ('late_checkout', 'Late Check-out',  true,  true,  90),
    ('damage',        'Damage',          false, false, 100),
    ('misc',          'Miscellaneous',   true,  false, 110)
  ) as d(code, name, is_taxable, service_chargeable, display_order)
  where not exists (
    select 1 from charge_categories cc
    where cc.tenant_id = p_tenant_id
      and cc.code = d.code
      and cc.deleted_at is null
  );
end;
$$;

comment on function seed_charge_categories(uuid) is
  'Seeds a tenant''s DEFAULT charge categories (room, fnb, laundry, ... misc), '
  'each already carrying its account_role_key. Defaults only — the hotel '
  'renames, re-flags, deactivates or extends them freely. Idempotent: skips any '
  'live code that already exists. Calls seed_chart_of_accounts and '
  'seed_account_mappings first, both idempotent, so the two tenant-insert '
  'triggers do not depend on firing in name order.';

-- ----------------------------------------------------------------------------
-- 8.3 Backfill, then make it required
-- ----------------------------------------------------------------------------
-- Existing categories get 'revenue_' || code where that key is mapped, and the
-- general revenue key where it is not — which is what a category form would
-- prefill, and is the honest answer for a custom category nobody has told us
-- where to post.
do $$
declare
  r record;
begin
  for r in select id from tenants loop
    perform seed_charge_categories(r.id);
  end loop;

  update charge_categories cc
     set account_role_key = case
           when exists (
             select 1 from account_mappings am
             where am.tenant_id = cc.tenant_id
               and am.property_id is null
               and am.role_key = 'revenue_' || cc.code
           ) then 'revenue_' || cc.code
           else 'revenue_misc'
         end
   where cc.account_role_key is null;
end $$;

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'charge_categories'
      and column_name  = 'account_role_key'
      and is_nullable  = 'YES'
  ) then
    alter table charge_categories alter column account_role_key set not null;
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 8.4 The guard: the key must actually be mapped
-- ----------------------------------------------------------------------------
-- NOT NULL alone would let somebody type a key nothing resolves, which fails at
-- the front desk exactly as before. This checks the mapping exists at the moment
-- the category is created or its key changed.
--
-- It checks the TENANT DEFAULT only, deliberately: a property override is an
-- override of something, and requiring one per property to create a category
-- would make a group with four hotels do the same work four times.
create or replace function enforce_charge_category_account()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.account_role_key is null or btrim(new.account_role_key) = '' then
    raise exception
      'A charge category must say which account its revenue posts to.'
      using errcode = 'PT422',
            hint = 'Open Settings, then Accounts, and choose the revenue account for this category.';
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
      'Nothing is mapped to "%", so charges in this category could not be posted.',
      new.account_role_key
      using errcode = 'PT424',
            hint = 'Open Settings, then Accounts, and map that role key to a revenue account first. A category that cannot be charged to should not exist.';
  end if;

  return new;
end;
$$;

comment on function enforce_charge_category_account() is
  'Refuses a charge category whose account_role_key is blank or unmapped, at the '
  'moment it is created or the key is changed — so the refusal lands on the '
  'person configuring the hotel rather than on the front desk in front of a '
  'guest. Checks the TENANT DEFAULT only: a property override is an override of '
  'something, and requiring one per property would make a four-hotel group do '
  'the same work four times.';

drop trigger if exists enforce_charge_category_account_trigger on charge_categories;
create trigger enforce_charge_category_account_trigger
  before insert or update on charge_categories
  for each row execute function enforce_charge_category_account();


-- ############################################################################
-- SECTION 8.5 — account_mapping_status: what the settings screen reads
-- ############################################################################
-- ONE VIEW, because the interesting column is DERIVED and must stay that way.
--
-- "WHEN DID SOMETHING LAST POST TO THIS KEY" is the whole reason this view
-- exists rather than the screen reading account_mappings directly. A NULL means
-- NOTHING HAS EVER POSTED HERE, and that is the signal a wiring is missing —
-- which is how the dated gap in this file's header stays visible long after the
-- header is history, and how a hotel finds out in month two that it created a
-- charge category nothing has ever been charged to.
--
-- IT IS DERIVED, NEVER MAINTAINED. A last_posted_at column on account_mappings
-- would be a cache under rule 6, would need an invalidation path, and would be
-- wrong the first time somebody posted through a path that forgot to touch it.
-- A max() over the lines is always right and costs an indexed lookup.
--
-- IT READS role_key, NOT account_id, on purpose. If a mapping is repointed to a
-- different account, the question the screen asks is still "has anything ever
-- posted through this KEY" — the answer should not reset to "never" because an
-- admin moved the key to a new account. journal_entry_lines.role_key records
-- how the account was chosen precisely so this stays answerable.
--
-- security_invoker IS LOAD-BEARING (022's note): without it the view runs as its
-- owner and RLS on the underlying tables is bypassed, so one tenant's admin
-- would read every tenant's mappings.
create or replace view account_mapping_status
with (security_invoker = on) as
select
  am.id                 as mapping_id,
  am.tenant_id,
  am.property_id,
  am.role_key,
  am.account_id,
  am.note,
  a.code                as account_code,
  a.name                as account_name,
  a.account_type,
  a.is_active           as account_is_active,
  -- NULL = nothing has ever posted through this key. Scoped to the property for
  -- an override row, and tenant-wide for a default.
  (
    select max(je.entry_date)
    from journal_entry_lines jel
    join journal_entries je on je.id = jel.journal_entry_id
    where jel.tenant_id = am.tenant_id
      and jel.role_key  = am.role_key
      and (am.property_id is null or je.property_id = am.property_id)
  ) as last_posted_on,
  (
    select count(*)
    from journal_entry_lines jel
    join journal_entries je on je.id = jel.journal_entry_id
    where jel.tenant_id = am.tenant_id
      and jel.role_key  = am.role_key
      and (am.property_id is null or je.property_id = am.property_id)
  ) as line_count
from account_mappings am
join accounts a
  on a.id = am.account_id
 and a.tenant_id = am.tenant_id;

comment on view account_mapping_status is
  'What the Accounts settings screen reads: every mapping with its account, and '
  'WHEN SOMETHING LAST POSTED THROUGH THAT ROLE KEY. last_posted_on NULL means '
  'nothing ever has — the signal that a posting site is unwired, which keeps '
  'working long after the migration header recording the gap is history. '
  'DERIVED, never maintained: a stored column would be a cache (rule 6) and '
  'would be wrong the first time a posting path forgot to touch it. Keyed on '
  'role_key rather than account_id so repointing a mapping does not reset its '
  'history to "never".';


-- ############################################################################
-- SECTION 9 — RLS
-- ############################################################################
-- Rule 13, from this migration. Two shapes:
--   * accounts and account_mappings are ADMIN-GATED CONFIGURATION — member read,
--     admin write — matching inventory_items and every other settings table.
--   * journal_entries and journal_entry_lines are MEMBER-READ ONLY, with no
--     write policy of any kind. There is NO client path to the ledger; the only
--     writer is post_journal, which is SECURITY DEFINER. This is the same shape
--     as stock_movements, folio_charges and folio_payments, and it is what makes
--     "no client-side posting, ever" a structural fact rather than a promise.
alter table accounts             enable row level security;
alter table account_mappings     enable row level security;
alter table journal_entries      enable row level security;
alter table journal_entry_lines  enable row level security;

-- --- accounts ---------------------------------------------------------------
drop policy if exists accounts_member_select on accounts;
create policy accounts_member_select on accounts
  for select to authenticated
  using (tenant_id = any(get_tenant_ids()));

drop policy if exists accounts_admin_insert on accounts;
create policy accounts_admin_insert on accounts
  for insert to authenticated
  with check (is_tenant_admin(tenant_id));

drop policy if exists accounts_admin_update on accounts;
create policy accounts_admin_update on accounts
  for update to authenticated
  using (is_tenant_admin(tenant_id))
  with check (is_tenant_admin(tenant_id));

-- NO DELETE POLICY. An account is retired with deleted_at (rule 5, master data);
-- hard-deleting one with entries against it would orphan the ledger.
drop policy if exists accounts_admin_delete on accounts;

-- --- account_mappings -------------------------------------------------------
drop policy if exists account_mappings_member_select on account_mappings;
create policy account_mappings_member_select on account_mappings
  for select to authenticated
  using (tenant_id = any(get_tenant_ids()));

drop policy if exists account_mappings_admin_insert on account_mappings;
create policy account_mappings_admin_insert on account_mappings
  for insert to authenticated
  with check (is_tenant_admin(tenant_id));

drop policy if exists account_mappings_admin_update on account_mappings;
create policy account_mappings_admin_update on account_mappings
  for update to authenticated
  using (is_tenant_admin(tenant_id))
  with check (is_tenant_admin(tenant_id));

-- DELETE IS ALLOWED HERE, and only here, because removing a PROPERTY OVERRIDE is
-- how a property goes back to the tenant default — there is no other way to say
-- "use the default again". Removing a tenant default is also allowed and fails
-- loudly at the next posting, which is the correct behaviour: a mapping nobody
-- meant to remove is better discovered by a refusal than by a wrong account.
drop policy if exists account_mappings_admin_delete on account_mappings;
create policy account_mappings_admin_delete on account_mappings
  for delete to authenticated
  using (is_tenant_admin(tenant_id));

-- --- the ledger: read only, for everyone ------------------------------------
drop policy if exists journal_entries_member_select on journal_entries;
create policy journal_entries_member_select on journal_entries
  for select to authenticated
  using (tenant_id = any(get_tenant_ids()));

drop policy if exists journal_entries_member_insert on journal_entries;
drop policy if exists journal_entries_member_update on journal_entries;
drop policy if exists journal_entries_member_delete on journal_entries;

drop policy if exists journal_entry_lines_member_select on journal_entry_lines;
create policy journal_entry_lines_member_select on journal_entry_lines
  for select to authenticated
  using (tenant_id = any(get_tenant_ids()));

drop policy if exists journal_entry_lines_member_insert on journal_entry_lines;
drop policy if exists journal_entry_lines_member_update on journal_entry_lines;
drop policy if exists journal_entry_lines_member_delete on journal_entry_lines;


-- ############################################################################
-- SECTION 10 — grants, and the anon assertion
-- ############################################################################
-- Nothing here is for anon. post_journal is staff-gated internally — that is the
-- real boundary — and these grants are the belt-and-braces layer.
revoke all     on function post_journal(uuid, date, text, text, uuid, jsonb, text, uuid) from public;
revoke execute on function post_journal(uuid, date, text, text, uuid, jsonb, text, uuid) from anon;
grant  execute on function post_journal(uuid, date, text, text, uuid, jsonb, text, uuid) to authenticated;

revoke all     on function resolve_account(uuid, uuid, text) from public;
revoke execute on function resolve_account(uuid, uuid, text) from anon;
grant  execute on function resolve_account(uuid, uuid, text) to authenticated;

-- The seeds are operator and trigger surface only. No client calls them.
revoke all on function seed_chart_of_accounts(uuid)      from public, anon, authenticated;
revoke all on function seed_account_mappings(uuid)       from public, anon, authenticated;
revoke all on function seed_tenant_accounts_trigger()    from public, anon, authenticated;
revoke all on function forbid_journal_change()           from public, anon, authenticated;
revoke all on function enforce_charge_category_account() from public, anon, authenticated;

-- THE ASSERTION, NOT A COPIED ARRAY (041 section 3). It raises if anon holds
-- EXECUTE on any SECURITY DEFINER function outside the two documented
-- exemptions, and complains if the quarantine list has entries that no longer
-- leak — so it fails in both directions and cannot rot quietly.
do $$
begin
  perform assert_no_anon_security_definer();
end $$;

-- ============================================================================
-- End of 044_ledger_spine.sql
-- ============================================================================
