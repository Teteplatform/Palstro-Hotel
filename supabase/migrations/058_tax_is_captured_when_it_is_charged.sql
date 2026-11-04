-- ############################################################################
-- 058 — WHAT A CHARGE WAS TAXED IS CAPTURED WHEN IT IS CHARGED
-- ############################################################################
-- The first piece of 1.1h4, and it lands BEFORE any wiring on purpose.
--
-- ----------------------------------------------------------------------------
-- THE SENTENCE THAT KEPT THIS HIDDEN FOR A YEAR
-- ----------------------------------------------------------------------------
-- src/types/folio.ts, verbatim:
--
--     * per-charge TAX — computed by folio_charge_tax from the currently active
--       tax_charges, so a rate change cannot make history disagree with itself.
--
-- That describes the mechanism that CAUSES the thing it claims to prevent. One
-- source of truth is the right instinct for a definition; for a RATE it is the
-- opposite. Computing every bill from the live rate is exactly what makes
-- history disagree with itself — and because the sentence names the right goal,
-- nobody has looked twice at the mechanism underneath it.
--
-- WHAT WAS MEASURED, not inferred. folio_totals computed tax as
--
--     sum(round(fc.net_amount * tc.rate, 2))
--       from folio_charges fc
--       join charge_categories cc ...
--       join tax_charges tc on tc.property_id = fc.property_id
--                          and tc.deleted_at is null and tc.is_active
--
-- `tax_charges` carries an admin UPDATE policy (021 §12). So one
-- `update tax_charges set rate = 0.10` silently rewrote the tax on every charge
-- ever posted — open, settled and CLOSED folios alike, retroactively, with
-- nothing erroring. The guest-facing `guest_account_items` view ran the same
-- join, so the guest's own copy of a bill from March moved too. change_log
-- recorded the rate change; it recorded nothing about the bills that changed
-- with it. Nigeria's VAT went 5% to 7.5% in 2020: this is scheduled, not
-- hypothetical.
--
-- A SECOND HOLE OF THE SAME FAMILY, found on the way: `charge_categories` also
-- has an admin UPDATE policy, so flipping `is_taxable` changed the tax on every
-- historical charge in that category. 021 guarded the soft-delete half of this
-- in prose ("retiring the minibar category must not untax every minibar charge")
-- and could not guard the flag half at all. Capture closes both, because the
-- rows exist whatever the category later says.
--
-- AND A THIRD, WHICH IS WORSE THAN A WRONG REPRINT, AND WHICH ARRIVES WEARING
-- THE SAME DISGUISE. 032's post_charge_reversal, verbatim:
--
--     -- THE ORIGINAL'S CATEGORY, ALWAYS. It is what makes the tax reverse
--     -- with the charge: folio_charge_tax resolves applicability from the
--     -- category's is_taxable / service_chargeable flags, so a counter posted
--     -- under the same category attracts exactly the same taxes at exactly
--     -- the same rates, on a negative net.
--
-- It attracts the same TAXES, and it attracts them at the CURRENTLY LIVE rates.
-- Reverse a charge from before a rate change and the counter carries the new
-- one, so the pair does NOT net to zero and the reversal leaves a residue — an
-- audit trail failing at the one thing it exists for. Measured on a single
-- 25,000 charge with the rate moved from 7.6% to 20%: the pair left 2,480.00
-- behind. Capture alone does not fix it; the counter has to be restated from
-- the ORIGINAL's captured rates, which SECTION 3 does.
--
-- ----------------------------------------------------------------------------
-- THE PATTERN, NAMED SO THE THIRD ONE GETS NOTICED
-- ----------------------------------------------------------------------------
-- Two comments, in two files, in two voices, both doing the same thing:
--
--     folio.ts  "...from the currently active tax_charges, SO A RATE CHANGE
--                CANNOT MAKE HISTORY DISAGREE WITH ITSELF"
--     032       "...the same category attracts EXACTLY THE SAME TAXES AT
--                EXACTLY THE SAME RATES"
--
-- EACH STATES THE GOAL AND THEN DESCRIBES THE MECHANISM THAT DEFEATS IT. That
-- is what made them invisible: a reviewer reads the goal, agrees with it, and
-- never checks whether the sentence after the comma delivers it. A comment that
-- was simply wrong would have been caught; one that is half right in the
-- reassuring direction survives for a year.
--
-- The shape to look for, when reading any comment in this codebase: a claim
-- about what CANNOT happen, justified by a mechanism that reads something LIVE.
-- "Resolved from", "computed from", "looked up from" — all of them are fine for
-- a definition and all of them are wrong for a fact that was true at a moment.
-- If the sentence promises stability and the mechanism promises freshness, one
-- of the two is a lie, and it is never the mechanism.
--
-- ----------------------------------------------------------------------------
-- WHY THIS IS NOT A CACHE (rule 6), SAID HERE SO THE NEXT REVIEWER DOES NOT ASK
-- ----------------------------------------------------------------------------
-- Rule 6 demands a recompute function beside any cached figure. §6 already draws
-- the line this sits on, for `stock_movements.carried_unit_cost`: a CACHE stores
-- something also derivable NOW and must ship its recompute; this stores
-- something derivable ONLY AT WRITE TIME, and a correct recompute function
-- cannot exist — which is the entire point of writing it down. Asking for one
-- here would be asking for the bug back.
--
-- It is the same decision `booking_nights` makes for the nightly rate: a fact
-- captured when it was true.
--
-- ----------------------------------------------------------------------------
-- WHAT CAPTURE STILL DOES NOT COVER, WRITTEN DOWN RATHER THAN DISCOVERED
-- ----------------------------------------------------------------------------
-- The rate change stays an in-place UPDATE, deliberately: once charges carry
-- their own rate, the audit answer comes from the charge rather than from the
-- rate table, and a second mechanism would have to do something capture does
-- not. Two things it does not do, both scheduled as 2.9 rather than left to be
-- rediscovered:
--
--   * A SCHEDULED CHANGE. A rate announced in October and effective 1 January
--     has to be typed in by a human at midnight. A hotel without a controller
--     will charge the old rate for a week, and the system cannot currently
--     prevent it.
--
--   * A BACK-DATED CHARGE, and this one is the case where capture still captures
--     the WRONG NUMBER. `post_charge` takes `p_charge_date` verbatim — there is
--     no past-date guard, measured in the function and not assumed — so a charge
--     posted today with a business date before a rate change takes TODAY's rate,
--     not the rate that applied on its own date. Capture makes that figure
--     permanent instead of making it correct. Effective-dated rates are the only
--     real answer and they are 2.9.
--
-- ----------------------------------------------------------------------------
-- WHAT IS IN THIS FILE
-- ----------------------------------------------------------------------------
--   1  folio_charge_tax_lines                 the table
--   2  capture_charge_taxes,              the only two writers
--      restate_charge_taxes
--   3  post_charge, apply_charge_discount, post_charge_reversal
--   4  folio_charge_tax, folio_totals, guest_account_items — read, not compute
--   5  the backfill, and the assumption it refuses to make
--   6  self-verify
--
-- The three functions in SECTION 3 and the view in SECTION 4 are rebuilt FROM
-- THEIR LIVE TEXT, with each substitution asserted to match exactly once and
-- every guard re-asserted by name afterwards.
--
-- NOTHING HERE WIRES THE FOLIO INTO THE LEDGER. That is the rest of 1.1h4 and it
-- comes next, because wiring first would mean journal entries carrying the tax as
-- posted while the folio carried whatever the rate is today — and on the first
-- rate change the reconciliation would report a real difference in which the
-- LEDGER is right and the FOLIO is lying. The temptation then is to give the
-- reconciliation a tolerance, which is how a wrong number acquires a defender.
-- ############################################################################

-- ############################################################################
-- A NOTE ON THE NAME
-- ############################################################################
-- The table is `folio_charge_tax_lines` and not `folio_charge_taxes`, because
-- 022 already has a VIEW of that name: one row per (charge, tax), built by
-- CROSS JOIN LATERAL over folio_charge_tax(). src/lib/folio.ts reads it, and it
-- is what FolioBill prints from.
--
-- That view is deliberately left alone, and it is the neatest part of this
-- shipment: it reads folio_charge_tax(), and SECTION 4 changes that function
-- from computing to reading. So the view becomes a read over captured rows with
-- no edit to it and no change to a single line of client code — the screens stop
-- showing a recomputed figure without knowing they ever did.

-- ############################################################################
-- WHAT THE BREAKAGES WENT RED FOR (rule 27)
-- ############################################################################
-- Thirteen mutations, each valid SQL that changes behaviour. All thirteen red:
--
--   A  post_charge stops capturing
--        -> capture wrote nothing; the folio reads 0.00; the guest's copy reads
--           25,000 where it should read 26,900
--   B  folio_totals computes from the live rate again
--        -> 1: the folio reads 5,000.00, expected the captured 1,900.00
--   C  folio_charge_tax computes from the live rate again
--        -> 1: the charge's own tax line reads 5,000.00
--   D  the guest view computes from the live rate again
--        -> 9: the guest's copy reads 30,000.00, expected 26,900.00
--   E  a discount re-looks-up the LIVE rate
--        -> 3: restated at 0.2000 rather than its own 0.0760
--   F  a discount does not restate at all
--        -> 3: the basis stays 25,000.00; and 4, a residue of 380.00
--   G  the counter charge is taxed at the live rate — WHAT 032 ACTUALLY DID
--        -> 4: the pair leaves a residue of -2,480.00
--   H  the counter charge is not taxed at all
--        -> 4: a residue of 1,520.00
--   I  capture ignores the category
--        -> 6: an untaxed category captured 1 row
--   J  the amount constraint stops constraining
--        -> 8: a row whose amount disagrees with rate x basis was accepted
--   L  the unique on (charge, tax) is dropped
--        -> 10: a second row for the same tax was accepted, doubling the VAT
--   M  restate takes its basis from the SOURCE charge, not the one it writes
--        -> 4: the counter's basis reads +20,000.00; the pair leaves 3,040.00
--   K  a rate change is on record when the backfill runs
--        -> PT409 "Cannot backfill ...: what a charge was taxed has already
--           changed. tax_charges.rate changed 0.0750 -> 0.1000 on 04 Nov 2026"
--
-- G IS THE ONE WORTH READING. It is not a hypothetical defect — it is what the
-- code did before this file, and the residue it leaves (-2,480.00 on a single
-- 25,000 charge) is the size of the error a hotel would have carried on every
-- reversal of a pre-rate-change bill.
--
-- THE FIXTURE MOVES THE RATE FROM 7.6% TO 20%, not to something near it. At 7.7%
-- a rounding coincidence could make the captured and the live figure agree on a
-- particular amount, and every one of A through H would be testing nothing. The
-- same reasoning says the rate MUST move between the charge and its reversal in
-- assertion 4: with the rate unmoved, taxing the counter from live and mirroring
-- the original give the same number, and rule 27's fourth shape says a fixture
-- in which the two answers coincide cannot test either one.
--
-- ----------------------------------------------------------------------------
-- AND WHAT THE RUN FOUND IN THE CODE, WHICH IS WHY ASSERTION 3 DISCOUNTS
-- ----------------------------------------------------------------------------
-- The first restate_charge_taxes DELETED the target's rows and then read the
-- source. apply_charge_discount passes the charge as its OWN source, so the
-- delete destroyed the very rows the insert was about to read, and every
-- discounted charge came out with NO TAX AT ALL — a bill that quietly loses its
-- VAT the moment somebody is generous. It was caught by assertion 3 and not by
-- assertion 1, because posting and reading a charge never touches that path.
-- The source is now snapshotted before the delete, and the comment on the
-- function says why so nobody tidies it back.

-- ----------------------------------------------------------------------------
-- THE COMPOSITE, WHICH IS WHERE THIS GETS INTERESTING
-- ----------------------------------------------------------------------------
-- Post, then discount, then reverse, with the rate moving in the middle. Each of
-- the three is proven on its own above; together they are the case a real hotel
-- produces and the one where an error would hide, because the counter has to
-- restate from the DISCOUNTED charge's captured rows — the rate it was posted
-- under, on the amount it was discounted to — while the live rate says something
-- else entirely.
--
--     posted      25,000.00 at 7.6%                 tax  1,900.00
--     rate moves  7.6% -> 20%                       (the bill does not move)
--     discounted  5,000.00 off, net 20,000.00       tax  1,520.00  at 7.6%
--     reversed    counter net -20,000.00            tax -1,520.00  at 7.6%
--     ----------------------------------------------------------------
--     residue                                             0.00
--
-- IT NETS TO EXACTLY ZERO, not to within a kobo: Postgres rounds numeric half
-- AWAY FROM ZERO, so round(-x * r, 2) = -round(x * r, 2) for every x and r.
-- Breakage M is the same fixture with restate taking its basis from the source
-- charge rather than from the one it is writing, and it leaves 3,040.00 behind.


-- ############################################################################
-- SECTION 1 — folio_charge_tax_lines: WHAT THE TAX WAS WHEN IT WAS CHARGED
-- ############################################################################
-- A CHILD TABLE, NOT A COLUMN, and the reasons are not stylistic:
--
--   * a bill prints VAT and service charge as SEPARATE LINES, so one column
--     cannot carry two taxes, and the first hotel to add a service charge would
--     force a migration against live bills;
--   * 021 rounds PER (charge, tax) on purpose, so the printed lines sum to the
--     printed total. A single captured figure per charge throws that away.
--
-- `tax_charges` keeps being the definition of what a property charges TODAY.
-- These rows are what a particular charge was actually charged, once, and they
-- never move again.

-- The composite-FK target for the lineage column below (§6). folio_charges
-- already has its (id, tenant_id, property_id) key; tax_charges never needed one.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'tax_charges_id_tenant_unique') then
    alter table tax_charges add constraint tax_charges_id_tenant_unique unique (id, tenant_id);
  end if;
end $$;

create table if not exists folio_charge_tax_lines (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null,
  property_id     uuid not null,
  folio_charge_id uuid not null,

  -- WHICH tax row this came from. Lineage only: nothing below is read through
  -- it, which is the entire point — the row stays correct and printable after
  -- the tax it came from is re-rated, deactivated or retired.
  tax_charge_id   uuid not null,

  -- THE LABEL, CAPTURED. An invoice reprint reads "VAT 7.5% — ₦1,875". Capturing
  -- the amount alone would make the reprint a reconstruction, and the rate is not
  -- recoverable from a rounded figure.
  code            text not null,
  name            text not null,

  -- THE WHOLE SHAPE OF THE COMPUTATION, not just the rate, because a captured
  -- rate beside a basis rule that has since changed is the same bug one level
  -- down.
  --
  -- WHAT tax_charges ACTUALLY CARRIES that takes part in the number: `rate`,
  -- `applies_to` (which decides WHICH charges it lands on, matched against the
  -- category's is_taxable / service_chargeable), `display_order` (the order it
  -- prints in), and the two filters `is_active` / `deleted_at` — whose
  -- participation is recorded by the row existing at all. There is no inclusive
  -- flag and no basis column today: 021 states the rule in prose instead,
  -- "Computed non-compound, each on the charge's own net_amount".
  applies_to      text not null
                    constraint folio_charge_tax_lines_applies_to_check
                    check (applies_to in ('taxable', 'service_chargeable')),

  -- DECLARED WITH BOTH VALUES, written as 'exclusive' on every row today. This
  -- is 031's reserved-vocabulary pattern (it declared 'charge', 'discount' and
  -- four more before any of them could be written) and NOT 052's dead column:
  -- the column is written on every row and read on every reprint, and what is
  -- unused is one VALUE of it. When an inclusive tax ships it ships with the
  -- writer that produces it and the CHECK clause that constrains it, in the same
  -- migration — the amount check below deliberately constrains only the
  -- calculation that exists, rather than inventing arithmetic for one that does
  -- not.
  calculation     text not null default 'exclusive'
                    constraint folio_charge_tax_lines_calculation_check
                    check (calculation in ('exclusive', 'inclusive')),

  rate            numeric(5,4) not null
                    constraint folio_charge_tax_lines_rate_check
                    check (rate >= 0 and rate <= 1),

  -- THE BASIS AS A VALUE, not as a rule. This is the honest answer to "what if a
  -- tax applies to something other than the net amount": capturing the figure the
  -- rate was applied to is independent of whichever rule chose it. It is also
  -- NECESSARY rather than redundant, because net_amount is MUTABLE —
  -- apply_charge_discount rewrites it — so a reprint that re-derived the basis
  -- from the charge would show today's net beside a tax computed on another one.
  taxable_amount  numeric(14,2) not null,

  -- SIGNED, like folio_payments and like the counter charges in 032: a reversal's
  -- counter charge carries a negative net and therefore a negative tax, and the
  -- pair nets to zero without a CASE anywhere.
  amount          numeric(14,2) not null,

  display_order   integer not null default 0,

  -- §6: every operational table carries the property's operating day. Copied
  -- from the charge so the tax report can group by it without a join, and so a
  -- back-dated charge's tax lands on the day the charge did (rules 8, 12).
  business_date   date not null,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid default auth.uid() references auth.users(id),
  updated_by      uuid references auth.users(id),

  -- THE ARITHMETIC, ENFORCED. Only the calculation that exists is constrained:
  -- an 'inclusive' row would be unconstrained here, and the shipment that
  -- introduces one adds its clause beside this.
  constraint folio_charge_tax_lines_amount_check
    check (calculation <> 'exclusive'
           or amount = round(taxable_amount * rate, 2)),

  -- ONE ROW PER (charge, tax). A second row for the same tax on the same charge
  -- would double it on the bill, and the restate path below rewrites rather than
  -- appends precisely because this index refuses the alternative.
  constraint folio_charge_tax_lines_charge_tax_unique unique (folio_charge_id, tax_charge_id),

  -- §6 composite keys, both of them. The charge's triple, so a tax row can never
  -- disagree with its charge about tenant or property; and the tax's pair, so it
  -- can never cite another tenant's tax.
  constraint folio_charge_tax_lines_charge_fk
    foreign key (folio_charge_id, tenant_id, property_id)
    references folio_charges (id, tenant_id, property_id) on delete cascade,
  constraint folio_charge_tax_lines_tax_fk
    foreign key (tax_charge_id, tenant_id)
    references tax_charges (id, tenant_id)
);

comment on table folio_charge_tax_lines is
  'WHAT A CHARGE WAS ACTUALLY TAXED, captured when it was posted and never '
  'recomputed. Before 058 every tax figure on every bill — open, settled and '
  'closed — was derived from the CURRENTLY ACTIVE tax_charges, so one UPDATE of '
  'one rate silently rewrote the tax on every bill the hotel had ever issued. '
  'This is the same decision booking_nights makes for the nightly rate and '
  'stock_movements.carried_unit_cost makes for cost of sale: a fact captured '
  'when it was true. NOT A CACHE (rule 6) — a cache stores something also '
  'derivable now and must ship a recompute function; this stores something '
  'derivable ONLY at write time, and a correct recompute cannot exist, which is '
  'the whole point. Written only by capture_charge_taxes and '
  'restate_charge_taxes; there is no write policy.';
comment on column folio_charge_tax_lines.tax_charge_id is
  'Lineage only. Nothing on this row is read through it, which is why the row '
  'survives that tax being re-rated, deactivated or retired.';
comment on column folio_charge_tax_lines.taxable_amount is
  'The figure the rate was applied to, captured as a VALUE rather than as a rule '
  'about where it came from. Necessary and not redundant: net_amount is rewritten '
  'by apply_charge_discount, so a reprint that re-derived the basis would show '
  'today''s net beside a tax computed on a different one.';
comment on column folio_charge_tax_lines.calculation is
  '''exclusive'' = added on top, which is every row today. ''inclusive'' is '
  'declared so history can say which it was the day such a tax exists; the '
  'shipment that can WRITE one brings its own arithmetic and its own CHECK '
  'clause.';
comment on column folio_charge_tax_lines.amount is
  'Signed. A reversal''s counter charge carries a negative net and so a negative '
  'tax, and the pair nets to zero without a CASE anywhere.';

create index if not exists folio_charge_tax_lines_charge_idx
  on folio_charge_tax_lines (folio_charge_id);
create index if not exists folio_charge_tax_lines_tenant_id_idx
  on folio_charge_tax_lines (tenant_id);
-- The tax report: "what VAT did this property charge in October?"
create index if not exists folio_charge_tax_lines_property_date_idx
  on folio_charge_tax_lines (property_id, business_date, code);

alter table folio_charge_tax_lines enable row level security;

-- READ by any member of the tenant, scoped to the active one by the app (rule
-- 19). NO WRITE POLICY AT ALL, exactly as folio_charges has none: these rows are
-- written only by the SECURITY DEFINER functions below, so there is no path by
-- which a client can author a tax figure on a bill.
drop policy if exists folio_charge_tax_lines_member_select on folio_charge_tax_lines;
create policy folio_charge_tax_lines_member_select on folio_charge_tax_lines
  for select to authenticated
  using (tenant_id = any(get_tenant_ids()));
drop policy if exists folio_charge_tax_lines_member_insert on folio_charge_tax_lines;
drop policy if exists folio_charge_tax_lines_member_update on folio_charge_tax_lines;
drop policy if exists folio_charge_tax_lines_member_delete on folio_charge_tax_lines;

drop trigger if exists set_row_audit_folio_charge_tax_lines on folio_charge_tax_lines;
create trigger set_row_audit_folio_charge_tax_lines
  before insert or update on folio_charge_tax_lines
  for each row execute function set_row_audit();


-- ############################################################################
-- SECTION 2 — THE TWO FUNCTIONS THAT WRITE A TAX ROW, AND NOTHING ELSE DOES
-- ############################################################################
-- Three call sites need tax rows and they need them from three different
-- places, which is exactly where a careful first attempt leaks:
--
--   post_charge              from the LIVE tax_charges — this is the capture
--   apply_charge_discount    from the charge's OWN stored rates, on its new net
--   post_charge_reversal     from the ORIGINAL's stored rates, on the counter's
--                            net
--
-- The last two are the same act — "rewrite these tax rows at those rates" — so
-- they are one function with a source argument rather than two that can drift.
-- A discount that re-looked-up the live rate would capture at post time and
-- then quietly throw it away the first time anybody discounted an old charge.

-- ----------------------------------------------------------------------------
-- 2.1 capture_charge_taxes — the only place a LIVE rate is ever read
-- ----------------------------------------------------------------------------
-- The applicability rule is 021's, unchanged and moved rather than rewritten,
-- including the one inversion it documents: charge_categories is joined WITHOUT
-- a deleted_at filter, because retiring the "minibar" category next year must
-- not retroactively untax every minibar charge ever posted.
--
-- AND NOW THAT RULE IS CAPTURED RATHER THAN RE-EVALUATED, which closes a second
-- hole of the same family: `charge_categories.is_taxable` has an admin UPDATE
-- policy, so flipping one flag used to change the tax on every historical charge
-- in that category. 021 guarded the soft-delete half of this in prose and could
-- not guard the flag half at all. After this, neither matters: the rows exist.
create or replace function capture_charge_taxes(p_charge_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
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
    taxable_amount, amount, display_order, business_date, created_by
  )
  select v_charge.tenant_id, v_charge.property_id, v_charge.id, tc.id,
         tc.code, tc.name, tc.applies_to, 'exclusive', tc.rate,
         v_charge.net_amount,
         round(v_charge.net_amount * tc.rate, 2),
         tc.display_order, v_charge.charge_date, auth.uid()
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
$$;

comment on function capture_charge_taxes(uuid) is
  'THE ONLY PLACE A LIVE TAX RATE IS READ for a posted charge. Writes one row per '
  'applicable tax, carrying the rate, the label, the basis and the amount as they '
  'stood at that moment. Returns how many rows it wrote — ZERO is a real and '
  'common answer (a charge in a category that is neither taxable nor '
  'service-chargeable), which is why callers must not treat 0 as a failure.';

-- ----------------------------------------------------------------------------
-- 2.2 restate_charge_taxes — the same rates, a different amount
-- ----------------------------------------------------------------------------
-- Rewrites p_charge_id's tax rows from p_source_charge_id's captured rate set,
-- computed on p_charge_id's CURRENT net. Two callers, two readings of the same
-- sentence:
--
--   apply_charge_discount    source = the charge itself. The rates it was posted
--                            under, applied to the net it now has.
--   post_charge_reversal     source = the original. The rates the original was
--                            posted under, applied to the counter's own net —
--                            which is negative for a charge reversal and
--                            POSITIVE for a discount reversal, and this is right
--                            both times without a branch.
--
-- WHY THE COUNTER'S TAX NETS TO ZERO AGAINST THE ORIGINAL'S, exactly. A charge
-- reversal gives the counter net = -original net, and Postgres `round()` on
-- numeric rounds half AWAY FROM ZERO, so round(-x * r, 2) = -round(x * r, 2) for
-- every x and r. The pair cancels to the kobo rather than to within a kobo.
--
-- DELETE-THEN-INSERT rather than UPDATE: the set of applicable taxes is part of
-- what is being restated, and a row that should no longer be there has to go.
-- The unique index on (folio_charge_id, tax_charge_id) is what makes appending
-- impossible rather than merely discouraged.
create or replace function restate_charge_taxes(
  p_charge_id        uuid,
  p_source_charge_id uuid
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
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
    taxable_amount, amount, display_order, business_date, created_by
  )
  select v_charge.tenant_id, v_charge.property_id, v_charge.id, src.tax_charge_id,
         src.code, src.name, src.applies_to, src.calculation, src.rate,
         v_charge.net_amount,
         round(v_charge.net_amount * src.rate, 2),
         src.display_order, v_charge.charge_date, auth.uid()
  from jsonb_to_recordset(coalesce(v_src, '[]'::jsonb)) as src(
    tax_charge_id uuid, code text, name text, applies_to text,
    calculation text, rate numeric, display_order integer);

  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

comment on function restate_charge_taxes(uuid, uuid) is
  'Rewrites a charge''s tax rows at the rates ANOTHER charge was posted under '
  '(or its own), on its own current net. Used by apply_charge_discount with the '
  'charge as its own source, and by post_charge_reversal with the original as '
  'the source — so a counter charge carries the rate its original carried, not '
  'whatever the hotel charges today. Never reads tax_charges.';

revoke all on function capture_charge_taxes(uuid)         from public, anon, authenticated;
revoke all on function restate_charge_taxes(uuid, uuid)   from public, anon, authenticated;


-- ############################################################################
-- SECTION 3 — THE THREE WRITERS
-- ############################################################################
-- All three rebuilt from their live text. The only change in each is one
-- `perform` after the row is written; every guard, every idempotency path and
-- every refusal is carried through untouched and asserted by SECTION 6.

-- ---- 3.1 post_charge -------------------------------------------------------
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
  if not exists (
    select 1 from charge_categories
    where id = p_charge_category_id
      and tenant_id = v_tenant
      and deleted_at is null               -- rule 5
      and is_active = true
  ) then
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
      charge_date, source, idempotency_key, created_by
    ) values (
      v_tenant, v_folio.property_id, p_folio_id, p_charge_category_id,
      p_description, p_quantity, p_unit_amount,
      v_gross, 0, v_gross,
      v_date, coalesce(nullif(btrim(p_source), ''), 'manual'), p_idempotency_key, v_actor
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

-- ---- 3.2 apply_charge_discount ---------------------------------------------
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

  -- 058: THE TAX FOLLOWS THE NEW NET, AT THE RATE THIS CHARGE WAS POSTED
  -- UNDER. The charge is its own source, which is the whole point: a fresh
  -- lookup would silently throw the capture away the first time anybody
  -- discounted a charge from before a rate change — capture at post time
  -- looks complete right up until that moment.
  perform restate_charge_taxes(v_charge.id, v_charge.id);

  return v_charge;
end;
$function$;

-- ---- 3.3 post_charge_reversal ----------------------------------------------
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
-- SECTION 4 — THE READS STOP COMPUTING AND START REPORTING
-- ############################################################################
-- CAPTURING WITHOUT SWITCHING THE READS WOULD FIX NOTHING. There would be two
-- sources of truth and the live one would still win every figure on every
-- screen — the defect surviving its own fix, with a table of correct rows
-- beside it that nothing looked at.
--
-- Three readers, which is all of them: pg_proc and pg_views were asked rather
-- than grepped, and `seed_tax_charges` / `seed_tax_charges_for_property` are the
-- only other functions that touch tax_charges. They SEED it, which is what
-- tax_charges is still for.

-- ----------------------------------------------------------------------------
-- 4.1 folio_charge_tax — the per-charge lines a bill prints
-- ----------------------------------------------------------------------------
-- The signature is unchanged, so every caller and every type stays as it was.
-- What changed is where the numbers come from: four columns that used to be
-- computed are now read.
--
-- The voided check stays and stays NULL-safe (rule 5): a voided charge returns
-- no tax lines, the same as before. It is a filter on the CHARGE, not a reason
-- to have left the rows unwritten — see SECTION 5 on why voided charges are
-- backfilled like any other.
create or replace function folio_charge_tax(p_charge_id uuid)
returns table (tax_charge_id uuid, code text, name text, rate numeric, amount numeric)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_voided boolean;
begin
  select fc.is_voided into v_voided from folio_charges fc where fc.id = p_charge_id;
  if not found then
    return;                              -- unknown charge: no rows, never a wrong number
  end if;
  if v_voided is true then               -- rule 5, NULL-safe
    return;
  end if;

  return query
  select fct.tax_charge_id, fct.code, fct.name, fct.rate, fct.amount
  from folio_charge_tax_lines fct
  where fct.folio_charge_id = p_charge_id
  order by fct.display_order, fct.code;
end;
$$;

comment on function folio_charge_tax(uuid) is
  'The tax lines of ONE charge, as they were captured when it was posted — 058. '
  'Not computed: the rate, the label and the amount are read, so a reprint of a '
  'bill from March shows what March charged however many times the rate has '
  'moved since. Returns nothing for a voided charge (rule 5, NULL-safe) and '
  'nothing for an unknown one, never a wrong figure.';

-- ----------------------------------------------------------------------------
-- 4.2 folio_totals — the folio decomposed
-- ----------------------------------------------------------------------------
-- The tax half was a join from folio_charges through charge_categories to the
-- live tax_charges. It is now a sum of captured rows, and it keeps the property
-- that made the old one careful: the per-(charge, tax) rounding is already baked
-- into `amount`, so the total still equals the sum of the printed lines rather
-- than a separately-rounded figure that can disagree by a kobo.
create or replace function folio_totals(p_folio_id uuid)
returns table (
  gross_total    numeric,
  discount_total numeric,
  net_total      numeric,
  tax_total      numeric,
  charges_total  numeric,
  payments_total numeric,
  balance        numeric
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_gross    numeric(14,2) := 0;
  v_discount numeric(14,2) := 0;
  v_net      numeric(14,2) := 0;
  v_tax      numeric(14,2) := 0;
  v_paid     numeric(14,2) := 0;
begin
  select coalesce(sum(fc.gross_amount), 0),
         coalesce(sum(fc.discount_amount), 0),
         coalesce(sum(fc.net_amount), 0)
    into v_gross, v_discount, v_net
  from folio_charges fc
  where fc.folio_id = p_folio_id
    and fc.is_voided is not true;          -- rule 5

  -- 058: READ, NOT RECOMPUTED. The join to charge_categories and tax_charges is
  -- gone, and with it the behaviour where changing one rate rewrote the tax on
  -- every bill this hotel had ever issued.
  select coalesce(sum(fct.amount), 0)
    into v_tax
  from folio_charge_tax_lines fct
  join folio_charges fc on fc.id = fct.folio_charge_id
  where fc.folio_id = p_folio_id
    and fc.is_voided is not true;          -- rule 5

  -- Payments are SIGNED (DECISION 3): a refund is negative and reduces the total
  -- received without any CASE expression.
  select coalesce(sum(fp.amount), 0)
    into v_paid
  from folio_payments fp
  where fp.folio_id = p_folio_id
    and fp.is_voided is not true;          -- rule 5

  gross_total    := v_gross;
  discount_total := v_discount;
  net_total      := v_net;
  tax_total      := v_tax;
  charges_total  := v_net + v_tax;
  payments_total := v_paid;
  balance        := (v_net + v_tax) - v_paid;
  return next;
end;
$$;

comment on function folio_totals(uuid) is
  'The folio decomposed: gross, discount, net, tax, charges (net+tax), payments '
  'and balance. The BALANCE is still computed live from the rows and still has no '
  'cache (rule 6); the TAX is now READ from what each charge was actually charged '
  '(058), which is not the same thing as a cache — see folio_charge_tax_lines. '
  'INVARIANT (rule 9): net = gross - discount (DB-enforced per charge); charges = '
  'net + tax; balance = charges - payments; and sum(balance) over a property''s '
  'open folios reconciles to the in-house guest ledger.';


-- ---- 4.3 guest_account_items -----------------------------------------------
-- The guest's own copy of their bill ran the same join, so a rate change moved
-- what the guest could see as well as what the hotel could. Rebuilt from its
-- live definition with security_invoker carried explicitly and asserted.
create or replace view guest_account_items
with (security_invoker = on) as
 WITH stay AS (
         SELECT 'stay'::text AS item_kind,
            b.tenant_id,
            b.property_id,
            b.guest_id,
            b.id AS booking_id,
            b.booking_number,
            NULL::uuid AS charge_id,
            NULL::text AS charge_type_name,
            NULL::text AS charge_description,
            b.check_in AS item_date,
            0 AS item_rank,
            b.booking_number AS item_key,
            b.check_in,
            b.check_out,
            b.actual_check_in,
            GREATEST(COALESCE(b.actual_check_in, b.check_in), b.check_in) AS charge_from,
            GREATEST(0, b.check_out - b.check_in) AS reserved_nights,
                CASE
                    WHEN b.actual_check_in IS NULL THEN NULL::integer
                    ELSE GREATEST(0, b.check_out - GREATEST(COALESCE(b.actual_check_in, b.check_in), b.check_in))
                END AS actual_nights,
            b.status AS booking_status,
            b.room_type_id,
            rt.name AS room_type_name,
            f.id AS folio_id,
            f.status AS folio_status,
            tot.charges_total,
            tot.payments_total,
            tot.balance,
            b.created_at AS item_created_at
           FROM bookings b
             JOIN folios f ON f.booking_id = b.id
             LEFT JOIN room_types rt ON rt.id = b.room_type_id
             CROSS JOIN LATERAL folio_totals(f.id) tot(gross_total, discount_total, net_total, tax_total, charges_total, payments_total, balance)
          WHERE b.deleted_at IS NULL
        ), standalone AS (
         SELECT 'standalone_charge'::text AS item_kind,
            gf.tenant_id,
            gf.property_id,
            gf.guest_id,
            NULL::uuid AS booking_id,
            NULL::text AS booking_number,
            fc.id AS charge_id,
            cc.name AS charge_type_name,
            fc.description AS charge_description,
            fc.charge_date AS item_date,
            1 AS item_rank,
            fc.id::text AS item_key,
            NULL::date AS check_in,
            NULL::date AS check_out,
            NULL::date AS actual_check_in,
            NULL::date AS charge_from,
            NULL::integer AS reserved_nights,
            NULL::integer AS actual_nights,
            NULL::text AS booking_status,
            NULL::uuid AS room_type_id,
            NULL::text AS room_type_name,
            gf.folio_id,
            gf.folio_status,
            (fc.net_amount + COALESCE(tx.tax_amount, 0::numeric))::numeric(14,2) AS charges_total,
            0::numeric(14,2) AS payments_total,
            (fc.net_amount + COALESCE(tx.tax_amount, 0::numeric))::numeric(14,2) AS balance,
            fc.created_at AS item_created_at
           FROM guest_folios gf
             JOIN folio_charges fc ON fc.folio_id = gf.folio_id
             JOIN charge_categories cc ON cc.id = fc.charge_category_id
             LEFT JOIN LATERAL ( SELECT sum(fct.amount) AS tax_amount
                   FROM folio_charge_tax_lines fct
                  WHERE fct.folio_charge_id = fc.id) tx ON true
          WHERE gf.is_standalone AND fc.is_voided IS NOT TRUE
        ), item AS (
         SELECT stay.item_kind,
            stay.tenant_id,
            stay.property_id,
            stay.guest_id,
            stay.booking_id,
            stay.booking_number,
            stay.charge_id,
            stay.charge_type_name,
            stay.charge_description,
            stay.item_date,
            stay.item_rank,
            stay.item_key,
            stay.check_in,
            stay.check_out,
            stay.actual_check_in,
            stay.charge_from,
            stay.reserved_nights,
            stay.actual_nights,
            stay.booking_status,
            stay.room_type_id,
            stay.room_type_name,
            stay.folio_id,
            stay.folio_status,
            stay.charges_total,
            stay.payments_total,
            stay.balance,
            stay.item_created_at
           FROM stay
        UNION ALL
         SELECT standalone.item_kind,
            standalone.tenant_id,
            standalone.property_id,
            standalone.guest_id,
            standalone.booking_id,
            standalone.booking_number,
            standalone.charge_id,
            standalone.charge_type_name,
            standalone.charge_description,
            standalone.item_date,
            standalone.item_rank,
            standalone.item_key,
            standalone.check_in,
            standalone.check_out,
            standalone.actual_check_in,
            standalone.charge_from,
            standalone.reserved_nights,
            standalone.actual_nights,
            standalone.booking_status,
            standalone.room_type_id,
            standalone.room_type_name,
            standalone.folio_id,
            standalone.folio_status,
            standalone.charges_total,
            standalone.payments_total,
            standalone.balance,
            standalone.item_created_at
           FROM standalone
        ), pooled AS (
         SELECT i.item_kind,
            i.tenant_id,
            i.property_id,
            i.guest_id,
            i.booking_id,
            i.booking_number,
            i.charge_id,
            i.charge_type_name,
            i.charge_description,
            i.item_date,
            i.item_rank,
            i.item_key,
            i.check_in,
            i.check_out,
            i.actual_check_in,
            i.charge_from,
            i.reserved_nights,
            i.actual_nights,
            i.booking_status,
            i.room_type_id,
            i.room_type_name,
            i.folio_id,
            i.folio_status,
            i.charges_total,
            i.payments_total,
            i.balance,
            i.item_created_at,
            sum(i.charges_total) OVER w_guest AS guest_charges_total,
            COALESCE(sum(i.charges_total) OVER w_older, 0::numeric) AS charges_before
           FROM item i
          WINDOW w_guest AS (PARTITION BY i.tenant_id, i.property_id, i.guest_id), w_older AS (PARTITION BY i.tenant_id, i.property_id, i.guest_id ORDER BY i.item_date, i.item_rank, i.item_key ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING)
        ), allocated AS (
         SELECT p.item_kind,
            p.tenant_id,
            p.property_id,
            p.guest_id,
            p.booking_id,
            p.booking_number,
            p.charge_id,
            p.charge_type_name,
            p.charge_description,
            p.item_date,
            p.item_rank,
            p.item_key,
            p.check_in,
            p.check_out,
            p.actual_check_in,
            p.charge_from,
            p.reserved_nights,
            p.actual_nights,
            p.booking_status,
            p.room_type_id,
            p.room_type_name,
            p.folio_id,
            p.folio_status,
            p.charges_total,
            p.payments_total,
            p.balance,
            p.item_created_at,
            p.guest_charges_total,
            p.charges_before,
            pool.guest_payments_pool,
            GREATEST(0::numeric, LEAST(p.charges_total, pool.guest_payments_pool - p.charges_before))::numeric(14,2) AS allocated_amount
           FROM pooled p
             JOIN guest_payment_pools pool ON pool.tenant_id = p.tenant_id AND pool.property_id = p.property_id AND pool.guest_id = p.guest_id
        )
 SELECT item_kind,
    tenant_id,
    property_id,
    guest_id,
    booking_id,
    booking_number,
    charge_id,
    charge_type_name,
    charge_description,
    item_date,
    item_rank,
    item_key,
    item_created_at,
    check_in,
    check_out,
    actual_check_in,
    charge_from,
    reserved_nights,
    actual_nights,
    COALESCE(actual_nights, reserved_nights) AS display_nights,
    booking_status,
    room_type_id,
    room_type_name,
    folio_id,
    folio_status,
    charges_total,
    payments_total,
    balance,
    guest_charges_total,
    guest_payments_pool,
    charges_before,
    allocated_amount,
    (charges_total - allocated_amount)::numeric(14,2) AS unallocated_amount,
        CASE
            WHEN charges_total <= 0::numeric THEN 'nil'::text
            WHEN allocated_amount >= charges_total THEN 'settled'::text
            WHEN allocated_amount > 0::numeric THEN 'part_paid'::text
            ELSE 'unpaid'::text
        END AS settlement_status
   FROM allocated a;

-- ############################################################################
-- SECTION 5 — THE BACKFILL, AND THE ASSUMPTION IT REFUSES TO MAKE
-- ############################################################################
-- Every charge already posted needs its tax rows, or the reads above return
-- nothing for it and the bill silently loses its VAT.
--
-- BACKFILLING AT TODAY'S RATE IS ONLY HONEST IF TODAY'S RATE IS THE RATE THOSE
-- CHARGES WERE POSTED UNDER. That is true right now — Heledon has not gone live
-- and no rate has ever changed — and it stops being true permanently at the first
-- change. So this does not assume it. `log_field_changes` has been on
-- `tax_charges` and `charge_categories` since 021, which means the DATABASE CAN
-- BE ASKED, and it is asked here:
--
--   * any change to tax_charges.rate or applies_to  -> the rate or the
--     applicability moved, and a backfill is a guess
--   * any change to tax_charges.is_active or deleted_at -> a tax stopped or
--     started applying partway through, same problem
--   * any change to charge_categories.is_taxable or service_chargeable -> WHICH
--     charges a tax landed on moved, which is the same bug one level down and is
--     the half 021 could not guard at all
--
-- If any of those is on record the backfill RAISES and names the field, the
-- date and the user. The right answer then is a human deciding what each
-- affected bill was actually charged — not this file inventing it.
--
-- WHAT IT DOES WITH THE TWO CASES THAT LOOK LIKE EACH OTHER AFTERWARDS, because
-- "no rows" and "not backfilled yet" are indistinguishable once it has run:
--
--   * A CHARGE WHOSE CATEGORY IS NEITHER TAXABLE NOR SERVICE-CHARGEABLE gets
--     ZERO ROWS, and that is the correct and permanent answer for it — damage
--     charges and deposits are not taxed. The reads sum to 0.00 for it, which is
--     right. It is NOT a gap.
--   * A VOIDED CHARGE IS BACKFILLED LIKE ANY OTHER. It would be cheaper to skip
--     them, and it would be wrong: a void is reversible, every read already
--     excludes voided charges by `is_voided is not true` (rule 5), and a charge
--     that came back from a void with no tax rows would be untaxed in silence.
--     The rows cost nothing and the alternative is a hole with a trigger.
--
-- WHICH IS WHY THE ASSERTION AFTERWARDS IS NOT "every charge has rows". It is
-- "every charge whose category attracts a live tax has exactly the rows that tax
-- implies" — a count of zero is a verdict here, not an absence.
do $$
declare
  v_breach text;
  v_n      integer;
  v_zero   integer;
begin
  -- ---- the assumption, asked rather than assumed --------------------------
  select string_agg(
           format('%s.%s changed %s -> %s on %s',
                  cl.table_name, cl.field_name,
                  coalesce(cl.old_value, 'null'), coalesce(cl.new_value, 'null'),
                  to_char(cl.changed_at, 'DD Mon YYYY')),
           '; ')
    into v_breach
  from change_log cl
  where (cl.table_name = 'tax_charges'
         and cl.field_name in ('rate', 'applies_to', 'is_active', 'deleted_at'))
     or (cl.table_name = 'charge_categories'
         and cl.field_name in ('is_taxable', 'service_chargeable'));

  if v_breach is not null then
    raise exception
      'Cannot backfill folio_charge_tax_lines: what a charge was taxed has already changed. %',
      v_breach
      using errcode = 'PT409',
            hint = 'Backfilling at today''s rates would record a figure these bills were never charged. Decide per affected bill what it actually carried, write those rows explicitly, and then re-run this migration with the backfill removed.';
  end if;

  -- ---- the backfill -------------------------------------------------------
  -- Voided charges included, deliberately (see above). Charges that already have
  -- rows are skipped, so the file is re-runnable.
  insert into folio_charge_tax_lines (
    tenant_id, property_id, folio_charge_id, tax_charge_id,
    code, name, applies_to, calculation, rate,
    taxable_amount, amount, display_order, business_date, created_by
  )
  select fc.tenant_id, fc.property_id, fc.id, tc.id,
         tc.code, tc.name, tc.applies_to, 'exclusive', tc.rate,
         fc.net_amount,
         round(fc.net_amount * tc.rate, 2),
         tc.display_order, fc.charge_date, fc.created_by
  from folio_charges fc
  join charge_categories cc on cc.id = fc.charge_category_id
  join tax_charges tc
    on tc.property_id = fc.property_id
   and tc.deleted_at is null
   and tc.is_active = true
   and (
        (tc.applies_to = 'taxable'            and cc.is_taxable)
     or (tc.applies_to = 'service_chargeable' and cc.service_chargeable)
   )
  where not exists (
    select 1 from folio_charge_tax_lines x
    where x.folio_charge_id = fc.id and x.tax_charge_id = tc.id
  );

  get diagnostics v_n = row_count;

  -- ---- AND IT AGREES WITH WHAT THE OLD COMPUTATION SAID ------------------
  -- The strongest check available, and it is available exactly once: while no
  -- rate has changed, the captured figure and the live computation must be the
  -- same number for every charge. If they differ, the capture is wrong and this
  -- is the only moment anybody could tell.
  select count(*)::integer into v_zero
  from folio_charges fc
  left join (
    select fct.folio_charge_id, sum(fct.amount) as captured
    from folio_charge_tax_lines fct group by fct.folio_charge_id
  ) cap on cap.folio_charge_id = fc.id
  left join (
    select fc2.id as charge_id, sum(round(fc2.net_amount * tc.rate, 2)) as live
    from folio_charges fc2
    join charge_categories cc on cc.id = fc2.charge_category_id
    join tax_charges tc
      on tc.property_id = fc2.property_id
     and tc.deleted_at is null and tc.is_active = true
     and ((tc.applies_to = 'taxable' and cc.is_taxable)
       or (tc.applies_to = 'service_chargeable' and cc.service_chargeable))
    group by fc2.id
  ) old on old.charge_id = fc.id
  where coalesce(cap.captured, 0) <> coalesce(old.live, 0);

  if v_zero <> 0 then
    raise exception
      'Backfill disagrees with the computation it replaces on % charge(s)', v_zero
      using errcode = 'PT500';
  end if;

  raise notice '058 backfill: % tax rows written; captured and live agree on every charge.', v_n;
end $$;


-- ############################################################################
-- SECTION 6 — SELF-VERIFY
-- ############################################################################
-- NAME THE DEFECT EACH ONE TURNS RED (rule 27):
--
--   1  A RATE CHANGE DOES NOT MOVE A POSTED BILL. The whole file in one
--      assertion: post at the live rate, move the rate, read the bill again.
--      RED if any read still computes from tax_charges. The fixture moves the
--      rate to 20% rather than to something near 7.5%, so the right and the
--      wrong answers are nowhere near each other and no rounding coincidence
--      can hide the difference.
--
--   2  AND NEITHER DOES FLIPPING THE CATEGORY'S FLAG. The second hole of the
--      same family. RED if any read re-evaluates applicability from
--      charge_categories.
--
--   3  A DISCOUNT RESTATES AT THE CHARGE'S OWN RATE, NOT THE LIVE ONE, applied
--      AFTER the rate has moved. RED if apply_charge_discount re-looks-up the
--      rate. This is where a careful first attempt leaks: capture at post time
--      looks complete until somebody discounts an old charge.
--
--   4  THE COMPOSITE: POST, THEN DISCOUNT, THEN REVERSE, WITH THE RATE MOVING
--      IN THE MIDDLE. Each of the three is proven alone above; together is
--      where it gets interesting, because the counter must restate from the
--      DISCOUNTED charge's captured rows — the 7.6% it was posted under, on
--      the 20,000 it was discounted to — and the pair must still net to
--      EXACTLY zero. Asserted at every step: the counter's rate, its basis,
--      the residue, and the folio's own tax total.
--      RED if the counter is taxed at the live rate (what 032 did), if it is
--      not taxed at all, or if restate takes its basis from the SOURCE charge
--      rather than from the charge it is writing. The rate MUST move between
--      the post and the reversal or both computations give the same number and
--      none of it can fail — rule 27's fourth shape, and the lesson 1.1h2
--      already paid for.
--
--   5  THE LABEL AND THE BASIS ARE CAPTURED, not only the figure. An invoice
--      reads "VAT 7.5% on N25,000", and from a rounded amount the rate is not
--      recoverable. RED if any of the four stops being written.
--
--   6  A CHARGE IN AN UNTAXED CATEGORY GETS ZERO ROWS, AND THAT IS A VERDICT.
--      RED if capture writes rows for a category that attracts no tax.
--      Afterwards "no rows" and "not backfilled" are indistinguishable, so the
--      rule is asserted rather than assumed.
--
--   7  THE BACKFILL'S GUARD CAN SEE A RATE CHANGE. The fixture has just made
--      one, so change_log must hold it. RED if log_field_changes is not on
--      tax_charges, which would leave SECTION 5's guard reading an empty table
--      and passing for the wrong reason.
--
--  10  A SECOND ROW FOR THE SAME (charge, tax) IS REFUSED. restate deletes and
--      re-inserts; the idempotency key protects the charge and nothing protected
--      its tax rows. RED if the unique constraint is dropped. Cheap insurance
--      against a defect whose symptom is a guest being overcharged.
--
--   9  THE GUEST'S OWN COPY DOES NOT MOVE EITHER. guest_account_items ran
--      the same join. RED if the view is left computing from tax_charges.
--
--   8  THE SHAPE: both writers SECURITY DEFINER with a pinned search_path, the
--      table with RLS on and NO write policy, and the amount constraint
--      refusing a wrong figure rather than merely existing.
do $$
declare
  v_tenant  uuid;
  v_user    uuid;
  v_prop    uuid;
  v_guest   uuid;
  v_folio   folios;
  v_cat     uuid;
  v_catfree uuid;
  v_vat     uuid;
  v_rate0   numeric(5,4);
  v_ch      folio_charges;
  v_free    folio_charges;
  v_counter folio_charges;
  v_tax     numeric(14,2);
  v_rate    numeric(5,4);
  v_code    text;
  v_name    text;
  v_basis   numeric(14,2);
  v_n       integer;
  v_dup     uuid;
  v_ok      boolean;
  v_fail    text := '';
begin
  begin
    select tu.tenant_id, tu.user_id into v_tenant, v_user
    from tenant_users tu where tu.is_active and tu.role in ('owner','manager') limit 1;
    select p.id into v_prop from properties p where p.tenant_id = v_tenant limit 1;
    perform set_config('request.jwt.claims',
      json_build_object('role','service_role','sub', v_user::text)::text, true);

    insert into manager_pins (tenant_id, user_id, pin_hash)
    values (v_tenant, v_user, crypt('4058', gen_salt('bf')))
    on conflict (tenant_id, user_id) do update set pin_hash = excluded.pin_hash;

    select tc.id, tc.rate into v_vat, v_rate0
    from tax_charges tc
    where tc.property_id = v_prop and tc.code = 'vat'
      and tc.deleted_at is null and tc.is_active;
    if v_vat is null then
      raise exception '058 SELF-VERIFY found no live VAT row for the property';
    end if;

    -- A TAXABLE category AND AN UNTAXED ONE. Assertion 6 needs both: a fixture
    -- with only taxable categories cannot tell "no rows because nothing
    -- applies" from "no rows because capture did nothing".
    select cc.id into v_cat from charge_categories cc
    where cc.tenant_id = v_tenant and cc.is_taxable and cc.deleted_at is null
    order by cc.code limit 1;
    select cc.id into v_catfree from charge_categories cc
    where cc.tenant_id = v_tenant and not cc.is_taxable and not cc.service_chargeable
      and cc.deleted_at is null
    order by cc.code limit 1;
    if v_cat is null or v_catfree is null then
      raise exception
        '058 SELF-VERIFY needs one taxable and one untaxed category (taxable=%, untaxed=%)',
        v_cat, v_catfree;
    end if;

    -- first/last, not full_name: a later migration split the name and made
    -- full_name GENERATED, which the live schema says and the 014 file does not.
    insert into guests (tenant_id, first_name, last_name, created_by)
    values (v_tenant, 'ZZ058', 'Fixture Guest', v_user) returning id into v_guest;
    v_folio := open_guest_folio(v_tenant, v_prop, v_guest, 'zz058-folio-1');

    -- ---- posted at the live rate ----------------------------------------
    v_ch := post_charge(v_folio.id, v_cat, 'ZZ058 dinner', 1, 25000, current_date,
                        'zz058-charge-1', 'manual');

    select sum(fct.amount) into v_tax
    from folio_charge_tax_lines fct where fct.folio_charge_id = v_ch.id;
    if v_tax is distinct from round(25000 * v_rate0, 2) then
      v_fail := v_fail || format('capture wrote %s, expected %s. ',
                                 v_tax, round(25000 * v_rate0, 2));
    end if;

    -- 5. THE LABEL AND THE BASIS.
    select fct.code, fct.name, fct.rate, fct.taxable_amount
      into v_code, v_name, v_rate, v_basis
    from folio_charge_tax_lines fct where fct.folio_charge_id = v_ch.id;
    if v_code is distinct from 'vat' or coalesce(btrim(v_name), '') = ''
       or v_rate is distinct from v_rate0 or v_basis is distinct from 25000.00 then
      v_fail := v_fail || format(
        '5: the captured line reads code=%s name=%s rate=%s basis=%s. ',
        v_code, v_name, v_rate, v_basis);
    end if;

    -- 6. AN UNTAXED CATEGORY GETS ZERO ROWS, AND THAT IS THE ANSWER.
    v_free := post_charge(v_folio.id, v_catfree, 'ZZ058 refundable deposit', 1, 5000,
                          current_date, 'zz058-charge-free', 'manual');
    select count(*)::integer into v_n
    from folio_charge_tax_lines where folio_charge_id = v_free.id;
    if v_n <> 0 then
      v_fail := v_fail || format('6: an untaxed category captured %s tax row(s). ', v_n);
    end if;

    -- ---- THE RATE MOVES, A LONG WAY -------------------------------------
    update tax_charges set rate = 0.2000 where id = v_vat;

    -- 1. THE POSTED BILL DOES NOT MOVE.
    select t.tax_total into v_tax from folio_totals(v_folio.id) t;
    if v_tax is distinct from round(25000 * v_rate0, 2) then
      v_fail := v_fail || format(
        '1: after the rate changed the folio reads tax %s, expected the captured %s. ',
        v_tax, round(25000 * v_rate0, 2));
    end if;

    select sum(t.amount) into v_tax from folio_charge_tax(v_ch.id) t;
    if v_tax is distinct from round(25000 * v_rate0, 2) then
      v_fail := v_fail || format('1: the charge''s own tax line reads %s. ', v_tax);
    end if;

    -- 9. AND NEITHER DOES THE GUEST'S OWN COPY. guest_account_items ran the
    -- same join, so before this the guest could watch a bill from March change
    -- when the hotel re-rated VAT in July. open_guest_folio makes a STANDALONE
    -- folio, which is the branch of that view this charge appears in.
    select gai.charges_total into v_tax
    from guest_account_items gai
    where gai.item_key = v_ch.id::text;
    if v_tax is distinct from 25000.00 + round(25000 * v_rate0, 2) then
      v_fail := v_fail || format(
        '9: the guests copy reads %s, expected %s. ',
        v_tax, 25000.00 + round(25000 * v_rate0, 2));
    end if;

    -- 2. NOR DOES FLIPPING THE CATEGORY'S FLAG.
    update charge_categories set is_taxable = false where id = v_cat;
    select t.tax_total into v_tax from folio_totals(v_folio.id) t;
    if v_tax is distinct from round(25000 * v_rate0, 2) then
      v_fail := v_fail || format(
        '2: untaxing the category moved the posted bill to %s. ', v_tax);
    end if;
    update charge_categories set is_taxable = true where id = v_cat;

    -- 3. A DISCOUNT RESTATES AT THE CHARGE'S OWN RATE.
    perform apply_charge_discount(v_ch.id, 5000, 'ZZ058 goodwill', '4058', 'zz058-disc-1');
    select sum(fct.amount), max(fct.rate), max(fct.taxable_amount)
      into v_tax, v_rate, v_basis
    from folio_charge_tax_lines fct where fct.folio_charge_id = v_ch.id;
    if v_basis is distinct from 20000.00 then
      v_fail := v_fail || format(
        '3: after the discount the basis reads %s, expected 20000.00. ', v_basis);
    end if;
    if v_rate is distinct from v_rate0 then
      v_fail := v_fail || format(
        '3: the discounted charge was restated at rate %s rather than its own %s. ',
        v_rate, v_rate0);
    end if;
    if v_tax is distinct from round(20000 * v_rate0, 2) then
      v_fail := v_fail || format(
        '3: the discounted charge carries tax %s, expected %s. ',
        v_tax, round(20000 * v_rate0, 2));
    end if;

    -- 4. A REVERSAL NETS TO ZERO ACROSS THE RATE CHANGE.
    v_counter := post_charge_reversal(
      v_ch.id, 'charge', -(v_ch.gross_amount), -5000,
      'ZZ058 reversal', current_date, 'zz058-rev-1');

    select coalesce(sum(fct.amount), 0) into v_tax
    from folio_charge_tax_lines fct
    where fct.folio_charge_id in (v_ch.id, v_counter.id);
    if v_tax <> 0 then
      v_fail := v_fail || format(
        '4: the charge and its counter leave a tax residue of %s. ', v_tax);
    end if;

    select max(fct.rate), max(fct.taxable_amount) into v_rate, v_basis
    from folio_charge_tax_lines fct where fct.folio_charge_id = v_counter.id;
    if v_rate is distinct from v_rate0 then
      v_fail := v_fail || format(
        '4: the counter carries rate %s rather than the original''s %s. ', v_rate, v_rate0);
    end if;
    -- THE BASIS IS THE COUNTER'S OWN NET, WHICH IS THE DISCOUNTED FIGURE
    -- NEGATED. If restate took its basis from the SOURCE charge instead of from
    -- the one it is writing, this reads +20,000 and the residue below doubles
    -- rather than cancelling.
    if v_basis is distinct from -20000.00 then
      v_fail := v_fail || format(
        '4: the counter''s basis reads %s, expected -20000.00 (the discounted net, negated). ',
        v_basis);
    end if;

    -- AND THE FOLIO'S TAX IS NOW ZERO, which is the consequence a person meets:
    -- a reversed charge leaves nothing owed and nothing taxed.
    select t.tax_total into v_tax from folio_totals(v_folio.id) t;
    if v_tax <> 0 then
      v_fail := v_fail || format(
        '4: with the charge reversed the folio still reads tax %s. ', v_tax);
    end if;

    -- 7. THE BACKFILL'S GUARD CAN SEE WHAT JUST HAPPENED.
    if not exists (select 1 from change_log cl
                   where cl.table_name = 'tax_charges' and cl.field_name = 'rate') then
      v_fail := v_fail ||
        '7: change_log did not record the rate change, so SECTION 5''s guard would read an empty table and pass for the wrong reason. ';
    end if;

    -- 8. THE SHAPE.
    select count(*)::integer into v_n
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('capture_charge_taxes', 'restate_charge_taxes')
      and p.prosecdef
      and p.proconfig is not null
      and exists (select 1 from unnest(p.proconfig) cfg where cfg like 'search_path=%public%');
    if v_n <> 2 then
      v_fail := v_fail || format(
        '8: %s of the two writers are SECURITY DEFINER with a pinned search_path, expected 2. ', v_n);
    end if;

    select c.relrowsecurity into v_ok from pg_class c where c.relname = 'folio_charge_tax_lines';
    if not coalesce(v_ok, false) then
      v_fail := v_fail || '8: folio_charge_tax_lines has RLS switched off. ';
    end if;

    select count(*)::integer into v_n from pg_policies
    where tablename = 'folio_charge_tax_lines' and cmd <> 'SELECT';
    if v_n <> 0 then
      v_fail := v_fail || format(
        '8: folio_charge_tax_lines has %s write policy/policies; it is written only by the two definer functions. ', v_n);
    end if;

    v_ok := false;
    begin
      insert into folio_charge_tax_lines (
        tenant_id, property_id, folio_charge_id, tax_charge_id,
        code, name, applies_to, calculation, rate,
        taxable_amount, amount, business_date, created_by)
      values (v_tenant, v_prop, v_free.id, v_vat, 'zz', 'ZZ', 'taxable', 'exclusive',
              0.0750, 1000.00, 999.99, current_date, v_user);
      v_ok := true;
    exception when check_violation then
      null;                                 -- refused, which is the point
    end;
    if v_ok then
      v_fail := v_fail ||
        '8: a tax row whose amount disagrees with rate x basis was accepted. ';
    end if;

    -- 10. A SECOND ROW FOR THE SAME TAX ON THE SAME CHARGE IS REFUSED.
    -- restate deletes and re-inserts, and the idempotency key protects the
    -- CHARGE, not its tax rows: a future bug in that path would double a bill's
    -- VAT with nothing to stop it, and the symptom is a guest being overcharged.
    -- The constraint existed before this assertion did, which is not the same as
    -- being proven.
    select fct.id into v_dup from folio_charge_tax_lines fct
    where fct.folio_charge_id = v_counter.id limit 1;
    v_ok := false;
    begin
      insert into folio_charge_tax_lines (
        tenant_id, property_id, folio_charge_id, tax_charge_id,
        code, name, applies_to, calculation, rate,
        taxable_amount, amount, business_date, created_by)
      select fct.tenant_id, fct.property_id, fct.folio_charge_id, fct.tax_charge_id,
             fct.code, fct.name, fct.applies_to, fct.calculation, fct.rate,
             fct.taxable_amount, fct.amount, fct.business_date, v_user
      from folio_charge_tax_lines fct where fct.id = v_dup;
      v_ok := true;
    exception when unique_violation then
      null;                                 -- refused, which is the point
    end;
    if v_ok then
      v_fail := v_fail ||
        '10: a second row for the same tax on the same charge was accepted, which doubles a bill''s VAT. ';
    end if;

    if v_fail <> '' then
      raise exception '058 SELF-VERIFY FAILED — %', v_fail;
    end if;

    raise notice '058 SELF-VERIFY: 10 assertions passed.';
    raise exception 'ZZ_058_FIXTURE_DONE';
  exception
    when others then
      if sqlerrm = 'ZZ_058_FIXTURE_DONE' then
        raise notice '058 self-verify complete; fixture rolled back.';
      else
        raise;
      end if;
  end;
end $$;

