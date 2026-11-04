-- ============================================================================
-- 061_the_folio_posts_to_the_ledger.sql
-- Palstro-Hotels: THE FOLIO'S THREE DOCUMENT TYPES LEARN TO POST.
--
-- 1.1h4 item 1. Three helpers in 046's pattern — one per document type, each
-- called at the end of the RPC that writes the row, inside that RPC's
-- transaction:
--
--     post_folio_charge_journal(p_charge_id)      a charge, a room night, a counter
--     post_folio_discount_journal(p_discount_id)  one application of a discount
--     post_folio_payment_journal(p_payment_id)    a payment, by method
--
-- NOTHING CALLS THEM YET, AND THAT IS DELIBERATE. post_charge,
-- post_charge_reversal, apply_charge_discount and record_payment are
-- BYTE-FOR-BYTE untouched, so no front-desk action behaves differently after
-- this migration than before it. The wiring is items 2, 4 and 5, and it is a
-- separate decision because it changes what every charge, discount and payment
-- DOES — and because it needs an answer about the documents that already
-- exist, which is what 059's folio_gl_wired_at was added to record. What ships
-- here is three functions and the proof that they agree with each other.
--
-- ----------------------------------------------------------------------------
-- THREE THINGS THE SHAPE WORK FOUND, ON THE RECORD BECAUSE THEY OUTLIVE IT
-- ----------------------------------------------------------------------------
--
-- 1. ROOM NIGHTS NEED NO HELPER, because a night is ALREADY A CHARGE ROW.
--    booking_nights has no folio link at all: a night reaches the bill through
--    post_room_night_charge -> post_charge, called by run_night_audit and by
--    check_out_booking (026). So "one journal entry per night" — the ruling
--    that looked like a build — falls out of one charge, one entry, and item 3
--    becomes a proof rather than a module. That is the kind of simplification
--    only COUNTING THE CALL SITES finds; reasoning about it from the module
--    names would have produced a fourth helper nobody needed.
--
--    The census, which is worth keeping because the next module will want it:
--    exactly TWO functions insert into folio_charges (post_charge and
--    post_charge_reversal) and exactly ONE into folio_payments
--    (record_payment — reverse_payment calls it with a negative amount). Every
--    other folio RPC routes through those three. So the whole folio module
--    wires at FOUR call sites.
--
--    And FIVE document types, not three: void_charge and void_payment flip
--    is_voided and write no row, so a void is its own document, posting as
--    ('folio_charge_void', <the charge's id>) — a different type on the same
--    id, which post_journal's uniqueness on (tenant, type, id) allows. Item 6.
--
-- 2. A COUNTER CAN BE BORN OWING NOTHING, AND AN UNCONDITIONAL RECEIVABLE LEG
--    WOULD MAKE REVERSING IT FAIL. Measured by building one rather than
--    reasoned about: comp a charge 100%, then reverse it, and
--    post_charge_reversal mirrors both halves, so the counter arrives gross
--    -10,000.00, discount -10,000.00, net 0.00, with its tax row restated to
--    0.00. Its legs are revenue debit and discounts_allowed credit — already
--    balanced — so an always-open guest ledger line works out at ZERO and
--    post_journal raises ('which is not a posting', 044 §5). At the desk that
--    is "reverse a comped charge" failing outright.
--
--    The answer is the principle rather than a special case: THAT LEG IS THE
--    RESIDUAL, so a zero residual has no leg. The entry still posts, because
--    revenue and its contra genuinely need unwinding. Refusing to reverse a
--    fully comped charge would be the tail wagging the dog — a comp posted in
--    error is exactly the thing somebody needs to undo.
--
-- 3. ITEM 8'S TRAP, WRITTEN DOWN NOW RATHER THAN WHEN IT IS REACHED. A
--    reconciliation must not compare a charge's entry to that charge's CURRENT
--    tax rows: the entry carries the tax as it stood when the charge posted,
--    the row carries it as restated by every discount since, and only the NET
--    of the charge's entry and its discount entries equals the row. It is the
--    obvious comparison, it is wrong, and it is wrong silently. SECTION 4 holds
--    it in full, beside the invariant it belongs to.
--
-- ----------------------------------------------------------------------------
-- THE SHAPE, IN ONE PLACE
-- ----------------------------------------------------------------------------
--   * EVERY LEG OFF A CAPTURED FACT. The revenue account from the charge's own
--     account_role_key (059), the tax account and rate from the captured tax
--     row (058/059), the two amounts from the application row (060). No live
--     lookup anywhere, which is what lets a reversal unwind the account the
--     original actually used rather than wherever its category points today.
--   * GROSS AND DISCOUNT AS SEPARATE LEGS, so discounts_allowed answers "how
--     much did we give away" instead of sitting at zero while revenue quietly
--     reads low.
--   * ONE TAX LEG PER CAPTURED TAX ROW, so the ledger can say what is owed to
--     each authority without re-deriving it.
--   * EVERY SIDE CHOSEN BY SIGN, never by document type. That is the whole
--     reason counters and payment reversals need no code of their own: a
--     negative row posts as the exact mirror.
--   * THE GUEST LEDGER LEFT OPEN, so the receivable is by construction the sum
--     of what was written — which is what makes SECTION 4's invariant a proof
--     rather than a second calculation that can disagree by a kobo.
--   * THE PAYMENT METHOD MAPPED BY AN EXPLICIT WHITELIST THAT REFUSES BY NAME.
--     Not built by concatenation: a constructed role key fails as a MISSING
--     ACCOUNT MAPPING, which somebody fixes by adding a mapping, when the real
--     answer is that a method nobody decided an account for has reached the
--     front desk. 'other' is legal in the constraint, off the picker since 059
--     and carries zero rows — so the refusal is for the next method somebody
--     adds, and it is what assertion 6 exercises.
--
-- ----------------------------------------------------------------------------
-- WHAT THE BREAKAGES WENT RED FOR (rule 27)
-- ----------------------------------------------------------------------------
-- Twenty-one mutations, ALL TWENTY-ONE red, none skipped.
--
--   A   the gross leg built from net_amount
--         -> 3: the counter's gross leg reads 9,500.00 where 10,000.00 is owed,
--            and 4 names the residue: guest_ledger 500.00 against revenue
--            -500.00. GREEN on the charge itself, where gross and net are the
--            same number — which is why the fixture reverses a discounted one
--   B   the gross leg's side hardcoded to credit
--         -> post_journal: 'works out at -9778.00, which is not a posting'
--   C   the discount leg dropped
--         -> post_journal: an entry needs at least two lines
--   D   the gross account looked up LIVE through charge_categories
--         -> 3 and 12: the reversal lands in revenue_misc, the account the
--            category points at TODAY, instead of the one the charge used
--   T   the tax legs dropped
--         -> 1: two lines where three are owed, and the receivable short by the
--            whole tax
--   E   the receivable leg made unconditional
--         -> 8: posting the comped counter REFUSED by PT422 — the live defect
--            this decision exists to prevent
--   F   the receivable leg's side flipped
--         -> post_journal: 'works out at -10760.00'
--   G   the receivable carrying its own amount, ONE KOBO short
--         -> 7: three rounding_difference lines, and 9 at 5,379.99 against
--            5,380.00. The entry still balanced and still posted, which is the
--            entire reason assertion 7 counts rounding lines
--   U   the counter not linked to the entry it unwinds
--         -> 3: reverses_entry_id is '(nothing)'
--   H   the discount entry posting the NEW AMOUNT instead of the delta
--         -> 2: 500.00 where 300.00 is owed. GREEN on the first application,
--            where previous is 0 and the two coincide
--   I   the tax delta READ from the row's amount
--         -> 2: -744.80 where 15.20 is owed — the whole restated tax instead of
--            the change
--   J   the tax delta with previous and new swapped
--         -> 2: the sign, and only the sign
--   K   the tax delta computed from net_amount live, both terms equal
--         -> 2: zero, every time
--   L   the zero-delta skip removed
--         -> post_journal: an entry needs at least two lines, so re-approving
--            the same amount would fail at the desk
--   M   the discount entry keyed on the CHARGE instead of the application
--         -> 2: the second application is handed the first application's entry,
--            and its 300.00 never reaches the books. This is 060's reason for
--            existing, demonstrated from the posting side
--   N   the method whitelist falling back to cash
--         -> 6: an undecided method posted an entry instead of refusing
--   O   company_account mapped to cash
--         -> 6: 0 into company_receivable and one cash-like account touched
--   P   the money leg's side hardcoded to debit
--         -> post_journal, on the payment reversal
--   Q   the payment's receivable leg hardcoded to credit
--         -> post_journal, on the payment reversal
--   R   SECURITY DEFINER removed from the charge helper
--         -> 11
--   S   the payment helper granted to authenticated
--         -> 11
--
-- ONE CHANGE THE BREAKAGES FORCED ON THE PROOF ITSELF, which is worth naming
-- because it is the second time this has happened: A's first run went red for
-- the WRONG REASON. The comped counter's post raised out of post_journal, that
-- raise aborted the block, and every assertion already recorded in v_fail was
-- thrown away — so the proof reported 'must carry a positive amount' instead of
-- the four findings it was holding, including the one about the counter's
-- account. The refusal is now CAUGHT AND RECORDED as assertion 8's own
-- sentence, with its SQLSTATE and message. A proof that stops at the first
-- raise is a proof that reports the least informative of its findings.
--
-- TWO THINGS THE FIXTURE HAD TO LEARN FROM THE DATABASE, both of which looked
-- like code defects first:
--   * open_guest_folio returns a guest's EXISTING OPEN folio whatever
--     idempotency key it is handed — one open folio per guest. Opening two for
--     one guest gave back one folio, folio 2's payments landed on folio 1, and
--     assertion 9 went red at exactly their total against correct code. Two
--     guests now, and the fixture refuses if the two folios come back equal.
--   * reverse_payment returns a `reversals` row, not the payment it wrote, so
--     the counter payment is read back by the link it set.
--
-- ----------------------------------------------------------------------------
-- WHAT THIS FILE DELIBERATELY DOES NOT DO
-- ----------------------------------------------------------------------------
--   * It wires nothing. Items 2, 4 and 5.
--   * It backfills nothing, and that is DECIDED rather than deferred: item 2
--     stamps folio_gl_wired_at and the six existing documents stay unposted,
--     landing in item 8's pre_wiring bucket exactly as 047 put the stock side's
--     pre-wiring value in its own. SECTION 4 carries the reasoning and names
--     what clears it (5.5, at go-live). Two modules needing that boundary
--     separately is 059's rename earning itself one shipment after it was made.
--   * It does not reconcile. folio_gl_reconciliation is item 8; SECTION 4
--     states the invariant it will enforce and the trap it must avoid.
--   * It does not touch voids. void_charge and void_payment are item 6, and
--     they need a document type of their own rather than a flag read here —
--     SECTION 1 says why skipping voided charges HERE would be the quiet bug.
--   * It changes no authorisation. The three helpers are NOT granted to
--     `authenticated`, matching 046's post_stock_movement_journal: they are
--     called from inside the definer RPC that writes the row.
-- ============================================================================

-- ############################################################################
-- SECTION 1 — THE CHARGE'S ENTRY
-- ############################################################################
-- One helper per document type, called at the end of the RPC that writes the
-- row, inside that RPC's transaction. 046's post_stock_movement_journal is the
-- worked example and this is the same shape down to the details: the document
-- pair IS the idempotency key, so p_idempotency_key is null; a document that
-- moved nothing returns NULL rather than posting an empty entry; and one side
-- is computed while the other is left OPEN for post_journal to sum.
--
-- WHAT THE LEGS ARE, and every one of them off a CAPTURED fact:
--
--   gross          the charge's own account_role_key (059)         credit
--   discount       discounts_allowed                                debit
--   tax, per row   the tax line's own account_role_key (059)        credit
--   receivable     guest_ledger                                    debit, OPEN
--
-- GROSS AND DISCOUNT ARE SEPARATE LEGS. Posting the net would make a discount
-- invisible in the accounts: revenue would read as if the hotel had charged
-- less, and discounts_allowed — the one figure that answers "how much did we
-- give away this month" — would stay at zero forever.
--
-- EVERY SIDE FLIPS ON THE SIGN, and that is what makes a counter charge fall
-- out for free instead of needing a branch. post_journal takes only POSITIVE
-- amounts with a side saying which way the money goes (044 §5), so each leg is
-- abs() with its side chosen by sign — 046's `case when quantity > 0` one table
-- over. A reversal counter carries negative gross, negative discount and
-- negative tax, so it posts as the exact mirror with no special case anywhere.
--
-- ----------------------------------------------------------------------------
-- THE GUEST LEDGER LEG IS THE RESIDUAL, SO A ZERO RESIDUAL HAS NO LEG
-- ----------------------------------------------------------------------------
-- Not a special case — the principle. That leg is what this document moved in
-- what the guest owes; when it moves nothing there is no receivable movement to
-- record, so there is no line. The entry still posts, because revenue and its
-- contra genuinely need unwinding.
--
-- IT IS REACHABLE, AND IT WAS MEASURED BY BUILDING ONE. Comp a charge 100% and
-- then reverse it: post_charge_reversal mirrors both halves, so the counter is
-- born gross -3,000.00, discount -3,000.00, net 0.00, with its tax row restated
-- to 0.00. Its legs are revenue 3,000.00 debit and discounts_allowed 3,000.00
-- credit — already balanced — so an unconditional open line works out at zero
-- and post_journal RAISES ('which is not a posting', 044 §5). Unconditional,
-- this helper would make reversing a comped charge fail outright at the desk.
--
-- The alternative — refusing to reverse a fully comped charge — is the tail
-- wagging the dog. A comp posted in error is exactly the thing somebody needs
-- to undo, and refusing a legitimate correction to dodge an awkward zero is how
-- a system teaches people to work around it.
--
-- ----------------------------------------------------------------------------
-- A SINGLE SURVIVING LEG IS UNREACHABLE, BY ARITHMETIC
-- ----------------------------------------------------------------------------
-- Asserted rather than handled, and the reason is written here so the next
-- person meets the proof instead of wondering what happens.
--
-- Each leg is omitted at zero: no revenue leg on a zero-gross counter, no
-- discount leg at zero, no tax leg for a zero row, and no receivable leg on a
-- zero residual. The residual is (gross - discount + tax). If it is zero and
-- exactly ONE other leg were non-zero, then that leg's own amount would have to
-- be zero — which is the condition under which it was already omitted. So the
-- set is either EMPTY (nothing happened financially: return null) or TWO OR
-- MORE. There is no one-leg branch because there is no one-leg case, and
-- assertion 7 checks it over every entry the fixture posts.
--
-- ----------------------------------------------------------------------------
-- A VOIDED CHARGE STILL POSTS, AND THAT IS DELIBERATE
-- ----------------------------------------------------------------------------
-- is_voided is not read here. void_charge flips the flag and writes NO counter
-- row (measured: void_charge and void_payment are the only two functions that
-- set it), so a void is its own document — it posts as ('folio_charge_void',
-- <the charge's id>), a different type on the same id, which post_journal's
-- uniqueness on (tenant, type, id) allows. That is 1.1h4 item 6.
--
-- Skipping voided charges HERE would be the quiet bug: a charge voided before
-- the backfill reaches it would never post at all, and then item 6's counter
-- entry would unwind something that was never on the books.
create or replace function post_folio_charge_journal(p_charge_id uuid)
returns journal_entries
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_c         folio_charges;
  v_cat       text;
  v_tax_total numeric(14,2);
  v_tax_lines jsonb;
  v_residual  numeric(14,2);
  v_lines     jsonb := '[]'::jsonb;
  v_reverses  uuid;
  v_label     text;
begin
  select * into v_c from folio_charges where id = p_charge_id;
  if not found then
    raise exception 'Folio charge % not found', p_charge_id
      using errcode = 'PT404',
            hint = 'The charge must be written before its entry is posted. Call this at the END of the RPC that inserts it.';
  end if;

  -- ---- the taxes, read ONCE so the legs and the residual cannot disagree ---
  -- The sum spans every row; the legs skip the zero ones. Both come out of the
  -- same query on purpose: two queries is two chances to drift, and a residual
  -- computed from a different row set than the legs is exactly the shape that
  -- balances in the fixture and not in production.
  select coalesce(sum(t.amount), 0),
         coalesce(jsonb_agg(
           jsonb_build_object(
             'role_key',    t.account_role_key,
             'side',        case when t.amount > 0 then 'credit' else 'debit' end,
             'amount',      abs(t.amount),
             'description', format('%s at %s%%', t.name,
                                   trim(to_char(t.rate * 100, 'FM990.00')))
           ) order by t.display_order
         ) filter (where t.amount <> 0), '[]'::jsonb)
    into v_tax_total, v_tax_lines
  from folio_charge_tax_lines t
  where t.folio_charge_id = v_c.id;

  -- ---- gross, at the account the charge CAPTURED (059) --------------------
  -- Never charge_categories.account_role_key read live. The category can be
  -- repointed and a past charge's revenue must stay where it was booked.
  if v_c.gross_amount <> 0 then
    v_lines := v_lines || jsonb_build_object(
      'role_key',    v_c.account_role_key,
      'side',        case when v_c.gross_amount > 0 then 'credit' else 'debit' end,
      'amount',      abs(v_c.gross_amount),
      'description', format('%s x %s',
                            trim(to_char(v_c.quantity, 'FM999,999,990.####')),
                            trim(to_char(v_c.unit_amount, 'FM999,999,999,990.00'))));
  end if;

  -- ---- the discount, as its own leg ---------------------------------------
  -- A charge born with a discount is a reversal counter: post_charge always
  -- inserts 0 and apply_charge_discount moves it afterwards (whose entry is
  -- SECTION 2's), while post_charge_reversal mirrors the original's discount in
  -- its INSERT. So in practice this leg appears on counters — but the rule is
  -- written as "non-zero", not as "is a counter", because a rule about what a
  -- row IS outlives a rule about where it came from.
  if v_c.discount_amount <> 0 then
    v_lines := v_lines || jsonb_build_object(
      'role_key',    'discounts_allowed',
      'side',        case when v_c.discount_amount > 0 then 'debit' else 'credit' end,
      'amount',      abs(v_c.discount_amount),
      'description', coalesce(nullif(btrim(v_c.discount_reason), ''), 'Discount'));
  end if;

  v_lines := v_lines || v_tax_lines;

  -- ---- the receivable, left OPEN ------------------------------------------
  -- Computed from gross and discount — the same two values the legs above were
  -- built from — rather than from net_amount, which is a third copy of the same
  -- fact. Assertion 8 checks that the two agree on every live row, because two
  -- places holding one fact is only safe while something checks they match.
  --
  -- The AMOUNT is still post_journal's, not ours. What is decided here is only
  -- WHETHER to ask for the line, which is why a receivable that is by
  -- construction the sum of what was written survives this.
  v_residual := v_c.gross_amount - v_c.discount_amount + v_tax_total;
  if v_residual <> 0 then
    v_lines := v_lines || jsonb_build_object(
      'role_key',    'guest_ledger',
      'side',        case when v_residual > 0 then 'debit' else 'credit' end,
      'description', 'Guest balance');
  end if;

  if jsonb_array_length(v_lines) = 0 then
    -- A row that moved no revenue, gave no discount and carried no tax. Nothing
    -- to book, and an empty entry would be a line in the ledger saying nothing.
    return null;
  end if;

  -- ---- the entry this one unwinds, when there is one ----------------------
  if v_c.reversal_of_charge_id is not null then
    select je.id into v_reverses
    from journal_entries je
    where je.tenant_id = v_c.tenant_id
      and je.source_document_type = 'folio_charge'
      and je.source_document_id   = v_c.reversal_of_charge_id;
  end if;

  select cc.name into v_cat
  from charge_categories cc where cc.id = v_c.charge_category_id;

  v_label := case
               when v_c.reversal_of_charge_id is not null then 'Charge reversal'
               when v_c.source = 'room'                  then 'Room charge'
               else 'Charge'
             end;

  -- entry_date is the CHARGE DATE, which is this table's business date (rules
  -- 8, 12 and §6): a bar sale at 02:00 belongs to the previous operating day,
  -- and created_at would file it under the one the night audit had already run.
  return post_journal(
    v_c.property_id,
    v_c.charge_date,
    format('%s — %s', v_label,
           coalesce(nullif(btrim(v_c.description), ''), v_cat, 'folio charge')),
    'folio_charge',
    v_c.id,
    v_lines,
    null,
    v_reverses
  );
end;
$function$;

revoke all on function post_folio_charge_journal(uuid) from public;
revoke all on function post_folio_charge_journal(uuid) from anon;
revoke all on function post_folio_charge_journal(uuid) from authenticated;

comment on function post_folio_charge_journal(uuid) is
  'Posts the journal entry for one folio_charges row: gross at the account the '
  'charge captured, the discount as its own leg, one leg per captured tax row '
  'at that row''s captured account, and the guest ledger left OPEN so the '
  'receivable is by construction the sum of what was written. Every side flips '
  'on the sign, so a reversal counter posts as the exact mirror with no special '
  'case. A zero residual gets NO guest ledger leg — that leg IS the residual, '
  'and a counter of a fully comped charge genuinely moves nothing the guest '
  'owes. NOT granted to authenticated: it is called from inside the RPC that '
  'writes the row, the way 046 calls post_stock_movement_journal.';

-- ############################################################################
-- SECTION 2 — THE DISCOUNT'S ENTRY, WHICH POSTS THE DELTA
-- ############################################################################
-- Keyed on the folio_charge_discounts row (060), never on the charge. Keying on
-- the charge posts ONCE: journal_entries is unique on (tenant,
-- source_document_type, source_document_id) and post_journal hands the existing
-- entry back on a repeat, so a second application would receive the first
-- application's entry and its delta would never reach the books. 060 exists so
-- that this row, and therefore this entry, exists per application.
--
-- IT POSTS THE DELTA, NOT THE DISCOUNT. apply_charge_discount is ABSOLUTE — 500
-- then 800 is 800, never 1,300 — so an entry per application carrying the full
-- figure would double-count. previous_amount and new_amount are both on the row,
-- so the change is a captured fact rather than a reconstruction.
--
-- ----------------------------------------------------------------------------
-- THE TAX DELTA, AND WHY IT IS THE SAME EXPRESSION TWICE
-- ----------------------------------------------------------------------------
-- One leg per captured tax row, so the ledger can answer what is owed to each
-- authority without re-deriving it. Per row:
--
--   round((gross - new_amount)      * rate, 2)
-- - round((gross - previous_amount) * rate, 2)
--
-- which is restate_charge_taxes' OWN expression — `round(net_amount * rate, 2)`
-- — evaluated at the two states, because net_amount IS (gross - discount). Every
-- input is a captured fact: gross off the charge, rate off the captured tax row
-- (058/059), both amounts off the application row (060). Nothing is looked up
-- live and nothing is read from `amount`.
--
-- READING `rate` RATHER THAN `amount` IS LOAD-BEARING, and the reason was
-- measured rather than assumed. restate_charge_taxes DELETES and re-inserts the
-- charge's tax rows on every application, so by the time this runs the rows hold
-- the NEW figures. What was worth checking is whether a row survives at all when
-- the taxable amount reaches zero — if a 100% comp dropped the row, this would
-- find no row, post no tax delta, and silently lose a whole 228.00 of VAT. It
-- does not: a comped charge keeps its row at amount 0.00, taxable 0.00, rate
-- 0.0760. The rate is stable across a restate; the amount is not. So the formula
-- holds, and it holds BECAUSE it never touches amount.
--
-- Two expressions computing one quantity is the drift risk rule 28 is about, so
-- assertion 4 does not comment on it — it asserts it. The net of the posted tax
-- (this entry's delta plus the charge's entry) must equal `round(net * rate, 2)`
-- as the row NOW reads. If this expression and restate's ever part company, that
-- goes red.
--
-- ----------------------------------------------------------------------------
-- A ZERO DELTA POSTS NOTHING, AND THE ROW IS STILL KEPT
-- ----------------------------------------------------------------------------
-- The same amount re-approved with a different reason is a real event and 060
-- records it, but post_journal RAISES on a balancing line of zero rather than
-- ignoring it (044 §5), so the skip belongs here. A zero delta means previous =
-- new, which makes every tax delta zero too by the formula above, so the leg set
-- comes out EMPTY and the empty check carries it — one rule, not two.
create or replace function post_folio_discount_journal(p_discount_id uuid)
returns journal_entries
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_d         folio_charge_discounts;
  v_c         folio_charges;
  v_tax_total numeric(14,2);
  v_tax_lines jsonb;
  v_residual  numeric(14,2);
  v_lines     jsonb := '[]'::jsonb;
begin
  select * into v_d from folio_charge_discounts where id = p_discount_id;
  if not found then
    raise exception 'Discount application % not found', p_discount_id
      using errcode = 'PT404',
            hint = 'Post the entry from the id apply_charge_discount''s insert returned, at the end of that call.';
  end if;

  select * into v_c from folio_charges where id = v_d.folio_charge_id;
  if not found then
    raise exception 'Discount application % points at charge %, which is gone',
      p_discount_id, v_d.folio_charge_id using errcode = 'PT404';
  end if;

  -- ---- the tax delta, per captured row ------------------------------------
  select coalesce(sum(x.td), 0),
         coalesce(jsonb_agg(
           jsonb_build_object(
             'role_key',    x.account_role_key,
             'side',        case when x.td > 0 then 'credit' else 'debit' end,
             'amount',      abs(x.td),
             'description', format('%s at %s%%', x.name,
                                   trim(to_char(x.rate * 100, 'FM990.00')))
           ) order by x.display_order
         ) filter (where x.td <> 0), '[]'::jsonb)
    into v_tax_total, v_tax_lines
  from (
    select t.account_role_key, t.name, t.rate, t.display_order,
           round((v_c.gross_amount - v_d.new_amount)      * t.rate, 2)
         - round((v_c.gross_amount - v_d.previous_amount) * t.rate, 2) as td
    from folio_charge_tax_lines t
    where t.folio_charge_id = v_c.id
  ) x;

  -- ---- the discount given, as the change ----------------------------------
  if v_d.delta_amount <> 0 then
    v_lines := v_lines || jsonb_build_object(
      'role_key',    'discounts_allowed',
      'side',        case when v_d.delta_amount > 0 then 'debit' else 'credit' end,
      'amount',      abs(v_d.delta_amount),
      'description', v_d.reason);
  end if;

  v_lines := v_lines || v_tax_lines;

  -- ---- the receivable, left OPEN ------------------------------------------
  -- What the guest owes moves by (-delta + tax delta): a discount given takes
  -- the bill DOWN by the discount AND by its tax. The two terms have the same
  -- sign here — a bigger discount means less tax — so the residual can only be
  -- zero when the delta is, which the empty check below has already caught.
  v_residual := -v_d.delta_amount + v_tax_total;
  if v_residual <> 0 then
    v_lines := v_lines || jsonb_build_object(
      'role_key',    'guest_ledger',
      'side',        case when v_residual > 0 then 'debit' else 'credit' end,
      'description', 'Guest balance');
  end if;

  if jsonb_array_length(v_lines) = 0 then
    -- The same amount re-approved. A real event, kept by 060, with nothing to
    -- post — and post_journal raises on a zero balancing line, so the skip has
    -- to be here rather than there.
    return null;
  end if;

  -- business_date is the CHARGE's operating day, set by 060: a discount belongs
  -- to the day of the bill it reduces, not to the day somebody approved it.
  -- reverses_entry_id is null — an application does not unwind an entry.
  -- reverse_discount raises a COUNTER CHARGE instead, which posts through
  -- SECTION 1 and points at the original charge's entry (item 7).
  return post_journal(
    v_c.property_id,
    v_d.business_date,
    format('Discount — %s', coalesce(nullif(btrim(v_c.description), ''), 'folio charge')),
    'folio_charge_discount',
    v_d.id,
    v_lines,
    null,
    null
  );
end;
$function$;

revoke all on function post_folio_discount_journal(uuid) from public;
revoke all on function post_folio_discount_journal(uuid) from anon;
revoke all on function post_folio_discount_journal(uuid) from authenticated;

comment on function post_folio_discount_journal(uuid) is
  'Posts the journal entry for ONE application of a discount, keyed on the '
  'folio_charge_discounts row (060) because keying on the charge would post '
  'once and hand the second application the first entry. It posts the DELTA — '
  'apply_charge_discount is absolute, so an entry per application carrying the '
  'full figure would double-count — plus one tax leg per captured tax row, '
  'computed from gross, rate, previous_amount and new_amount, which is '
  'restate_charge_taxes'' own expression at two states. A zero delta posts '
  'nothing. NOT granted to authenticated.';

-- ############################################################################
-- SECTION 3 — THE PAYMENT'S ENTRY, PER METHOD
-- ############################################################################
-- Two legs: the money lands somewhere, and the guest owes less. The receivable
-- is the OPEN one here too, so a payment entry is always exactly two lines —
-- the two stand or fall together, since the residual IS the amount.
--
-- ----------------------------------------------------------------------------
-- THE METHOD MAPPING IS AN EXPLICIT WHITELIST THAT REFUSES BY NAME
-- ----------------------------------------------------------------------------
-- 'cash' -> cash, 'bank_transfer' -> bank, 'pos' -> pos_clearing,
-- 'company_account' -> company_receivable. Anything else RAISES, naming the
-- method.
--
-- IT IS NOT BUILT BY CONCATENATION, and that is the whole point of writing it
-- out. A method mapped to a constructed role key would reach resolve_account,
-- which would report that no mapping exists — and the failure then reads as a
-- MISSING MAPPING, which somebody fixes by adding an account_mappings row. The
-- real answer is that a payment method nobody decided an account for has
-- reached the front desk, and that decision belongs to a person, not to whoever
-- is next to see a red screen. This is 059's lesson one table over: capture the
-- answer, do not deduce it — and here, refuse to deduce it.
--
-- WHAT THE REFUSAL IS ACTUALLY FOR. 'other' is legal in
-- folio_payments_method_check and carries zero rows (reported with 059); it
-- came off the picker in that shipment because it is not a destination, it is a
-- missing answer, and the one thing that cannot be done with it is map it to a
-- suspense account. So the refusal is not for today's data — it is for the next
-- method somebody adds to the constraint and the picker without deciding where
-- the money goes. Assertion 6 exercises it through 'other', which is the only
-- legal value with no account, and reads the SQLSTATE and the message.
--
-- A COMPANY ACCOUNT IS NOT REALLY A PAYMENT, which is why it maps to a
-- receivable rather than to cash or a bank. Nothing has been received; the debt
-- has moved from the guest to the company that will be invoiced. The entry says
-- exactly that: debit company_receivable, credit guest_ledger. The guest's bill
-- clears and the money is still owed, by somebody else.
--
-- A REVERSED PAYMENT IS A NEGATIVE ROW. reverse_payment calls record_payment
-- with a negative amount rather than flipping a flag (measured: record_payment
-- is the only function that inserts into folio_payments), so both sides flip on
-- the sign and the mirror needs no special case — the same property SECTION 1
-- relies on for counter charges. A VOID is different again: void_payment sets
-- is_voided and writes no row, so it is its own document type in item 6.
create or replace function post_folio_payment_journal(p_payment_id uuid)
returns journal_entries
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_p        folio_payments;
  v_role     text;
  v_residual numeric(14,2);
  v_lines    jsonb := '[]'::jsonb;
  v_reverses uuid;
  v_label    text;
begin
  select * into v_p from folio_payments where id = p_payment_id;
  if not found then
    raise exception 'Folio payment % not found', p_payment_id
      using errcode = 'PT404',
            hint = 'The payment must be written before its entry is posted. Call this at the END of record_payment.';
  end if;

  -- ---- the whitelist ------------------------------------------------------
  v_role := case v_p.method
              when 'cash'            then 'cash'
              when 'bank_transfer'   then 'bank'
              when 'pos'             then 'pos_clearing'
              when 'company_account' then 'company_receivable'
              else null
            end;

  if v_role is null then
    raise exception
      'Payment method "%" has no account decided for it, so this payment cannot be posted to the ledger',
      v_p.method
      using errcode = 'PT422',
            hint = 'Decide which account this money lands in, then add the method to post_folio_payment_journal''s mapping. Adding an account_mappings row alone will not do it — the mapping is in the function deliberately, so that a method nobody has decided about refuses by name instead of resolving to nothing.';
  end if;

  if v_p.amount <> 0 then
    v_lines := v_lines || jsonb_build_object(
      'role_key',    v_role,
      'side',        case when v_p.amount > 0 then 'debit' else 'credit' end,
      'amount',      abs(v_p.amount),
      'description', coalesce(nullif(btrim(v_p.reference), ''), v_p.method));
  end if;

  -- What the guest owes moves by the negative of what was paid.
  v_residual := -v_p.amount;
  if v_residual <> 0 then
    v_lines := v_lines || jsonb_build_object(
      'role_key',    'guest_ledger',
      'side',        case when v_residual > 0 then 'debit' else 'credit' end,
      'description', 'Guest balance');
  end if;

  if jsonb_array_length(v_lines) = 0 then
    -- Unreachable through the API: record_payment refuses a zero amount by its
    -- own message. Kept for the same reason SECTION 1's is — a backfill reads
    -- rows, not RPC calls, and a row that moved nothing must post nothing.
    return null;
  end if;

  if v_p.reversal_of_payment_id is not null then
    select je.id into v_reverses
    from journal_entries je
    where je.tenant_id = v_p.tenant_id
      and je.source_document_type = 'folio_payment'
      and je.source_document_id   = v_p.reversal_of_payment_id;
  end if;

  v_label := case
               when v_p.reversal_of_payment_id is not null then 'Payment reversal'
               when v_p.method = 'company_account'         then 'Charged to company account'
               else 'Payment received'
             end;

  return post_journal(
    v_p.property_id,
    v_p.payment_date,
    format('%s — %s', v_label, v_p.method),
    'folio_payment',
    v_p.id,
    v_lines,
    null,
    v_reverses
  );
end;
$function$;

revoke all on function post_folio_payment_journal(uuid) from public;
revoke all on function post_folio_payment_journal(uuid) from anon;
revoke all on function post_folio_payment_journal(uuid) from authenticated;

comment on function post_folio_payment_journal(uuid) is
  'Posts the journal entry for one folio_payments row: the money side at the '
  'account its METHOD maps to, and the guest ledger left OPEN. The mapping is '
  'an explicit whitelist that refuses an unknown method BY NAME rather than '
  'building a role key by concatenation — a constructed key fails as a missing '
  'account_mappings row, which invites somebody to add one, when the real '
  'answer is that a method nobody decided an account for has reached the front '
  'desk. company_account maps to company_receivable because nothing was '
  'received: the debt moved from the guest to the company. NOT granted to '
  'authenticated.';

-- ############################################################################
-- SECTION 4 — THE INVARIANT THESE THREE HELPERS OWE (rule 9)
-- ############################################################################
-- Stated here, where the helpers are, rather than in item 8 where it will be
-- enforced — because it is a property of what they write, and the reasoning is
-- known NOW.
--
--   INVARIANT: per property, the guest ledger account's net debit equals the
--   sum of every folio's balance.
--
--     sum(journal_entry_lines.debit - credit) where role_key = 'guest_ledger'
--       ===  sum(folio_balance(f.id)) over every folio of that property
--
-- It holds by construction rather than by arithmetic luck, and that is the
-- whole reason the guest ledger is the OPEN line in all three helpers: a charge
-- debits it by whatever the other legs came to, a discount credits it by
-- whatever it took off, a payment credits it by what was received. The
-- receivable is therefore the sum of what was written, not a second
-- calculation that can disagree with it by a kobo. Assertion 9 checks it
-- against folio_balance, which is computed from the folio tables and knows
-- nothing about the ledger — that independence is what makes it a proof rather
-- than a restatement.
--
-- ALL FOLIOS, not just open ones (F4). Free now, and it removes a silent
-- dependency on a close-out transition that does not exist yet.
--
-- ----------------------------------------------------------------------------
-- THE TRAP IN ITEM 8, WRITTEN DOWN WHILE IT IS KNOWN
-- ----------------------------------------------------------------------------
-- A reconciliation must NOT compare a charge's entry to that charge's CURRENT
-- tax rows. It is the obvious comparison and it is wrong.
--
-- The live laundry charge: its entry carries vat_output 228.00 — the tax as it
-- stood when the charge posted — while its tax row now reads 212.80, because
-- restate_charge_taxes deletes and re-inserts the rows on every discount
-- application. Only the NET of the charge's entry and every discount entry
-- against it equals the current row:
--
--     228.00 (charge entry)  -  15.20 (discount entry)  =  212.80 (the row)
--
-- Both figures are real. Both reconcile to something. Neither is the other, and
-- a check that pairs them off is wrong SILENTLY — it reports a discrepancy of
-- exactly the tax on every discount ever given, which reads like a rounding
-- problem and is not one.
--
-- So item 8's reconciliation groups by CHARGE and sums every entry whose
-- document belongs to it, never entry-to-row. Assertion 4 is the live form of
-- this: it asserts that the posted tax across a charge's entries equals
-- `round(net_amount * rate, 2)` as the row now reads — which is also what keeps
-- SECTION 2's delta expression and restate_charge_taxes' own expression from
-- drifting apart, since the two are the same formula in two places and nothing
-- else would notice if one changed.
--
-- ----------------------------------------------------------------------------
-- THE SIX DOCUMENTS THAT ALREADY EXIST ARE NOT BACKFILLED, AND THE
-- RECONCILIATION SAYS SO FROM ITS FIRST RUN
-- ----------------------------------------------------------------------------
-- Decided before item 2 wires anything, because the decision is what makes the
-- invariant above a statement rather than a complaint.
--
-- Three charges, two payments and one discount application were written while
-- there was nowhere to post them. ITEM 2 STAMPS folio_gl_wired_at AND LEAVES
-- THEM UNPOSTED, and item 8's folio_gl_reconciliation carries a pre_wiring
-- bucket from its FIRST RUN — the same shape 047 gave the stock side, which
-- put its pre-wiring value in its own bucket rather than inventing entries for
-- movements written before the code existed. Keyed the same way too:
-- created_at < wired_at, REAL TIME rather than business date, because the
-- wiring is an event in the deployment and not in the hotel's day.
--
-- WHY NOT BACKFILL, and the reason is sharper here than it was for stock: the
-- laundry charge's net is NOT WHAT IT WAS POSTED AT. Two discount applications
-- have moved it since, and restate_charge_taxes deleted and re-inserted its tax
-- rows with them. Reconstructing its entry would mean deciding what the document
-- looked like at a moment nobody recorded — which is exactly the guesswork 060's
-- backfill guard refuses on a smaller scale. Refusing it there and doing it here
-- would be one decision answered two ways in two shipments.
--
-- SO A NON-ZERO pre_wiring FIGURE IS EXPECTED, NOT A FAULT. What clears it is
-- 5.5 at go-live: the journal is emptied, the test documents are removed, and
-- gl_start_date is set once. BOTH buckets go to zero there together — pre_gl
-- (dated before gl_start_date) and pre_wiring (written before the module was
-- wired) — and item 8 keeps them mutually exclusive as 047 does, so the same
-- document can never be counted in both.
--
-- Two modules needing that boundary separately is 059's rename earning itself
-- one shipment after it was made: a single gl_wired_at could not have said that
-- the stock ledger wired in 1.1h2 and the folio in 1.1h4, and a charge posted
-- between the two would have been explained by neither.

-- ############################################################################
-- SECTION 5 — THE SELF-VERIFY, ROLLED BACK
-- ############################################################################
-- Twelve assertions, each with a named defect that turns it red (rule 27).
--
-- THREE THINGS THE FIXTURE DOES THAT LOOK LIKE EXTRA WORK AND ARE NOT. Each
-- exists because an assertion written without it CANNOT FAIL:
--
--   * IT DISCOUNTS THE SAME CHARGE TWICE, 200 then 500. With one application
--     previous_amount is 0, so the delta EQUALS the new amount and a helper
--     posting the whole discount is indistinguishable from a correct one. The
--     second application is where 200 and 300 part company. (Rule 27's fourth
--     shape: a fixture in which the correct and incorrect computations coincide
--     cannot test either one.)
--
--   * IT REPOINTS THE CHARGE CATEGORY'S ACCOUNT between the charge and its
--     reversal. Without that, the captured account_role_key and a live lookup
--     through charge_categories return the SAME STRING, and any assertion that
--     the key comes off the row is decoration. After the repoint they differ.
--     Charge B is then posted under the NEW key while A stays under the old,
--     which is assertion 12: two charges on one folio that must land in two
--     different revenue accounts.
--
--   * IT LEAVES FOLIO 1 WITH A NON-ZERO BALANCE. A charge fully reversed and a
--     payment fully reversed both net to zero, and an invariant comparing zero
--     to zero is satisfied by any symmetric defect — a payment posted on the
--     wrong side twice still sums to nothing. Charge B is never reversed, so
--     the balance is real and the two sides must agree on a number.
--
--   1  THE CHARGE'S ENTRY. Gross at the charge's captured account, tax at the
--      tax row's captured account, the guest ledger as the sum. The line count
--      is COUNTED from the tax rows, not assumed, so a property with a service
--      charge as well as VAT would not fail against correct code. RED if a leg
--      is dropped or the open line is asked for on the wrong side.
--
--   2  THE DISCOUNT'S ENTRY IS THE DELTA, WITH ITS TAX. 200 then 300, not 200
--      then 500. RED if it posts the new amount (what keying on the charge
--      would have forced), if the tax delta is read from the row's `amount`
--      instead of recomputed from its rate, or if it is omitted — 032's ₦2,480
--      residue in its original form.
--
--   3  THE COUNTER IS THE EXACT MIRROR, BY SIGN ALONE, AND AT THE CAPTURED
--      ACCOUNT. Four legs, every one flipped, reverses_entry_id pointing at the
--      charge's entry, and the gross leg still under the ORIGINAL revenue
--      account although the category now points elsewhere.
--
--   4  AND THE WHOLE THING NETS TO ZERO. Across the charge, both applications
--      and the counter, EVERY account nets to exactly zero. 032's tax residue
--      asserted as an absence: zero only because 058 captured the rate, 059
--      captured the accounts and 060 made each application its own document.
--      It also pins SECTION 2's delta expression to restate_charge_taxes' own —
--      the tax posted must equal round(net * rate, 2) as the row reads — so the
--      two cannot drift apart unnoticed.
--
--   5  A ZERO-DELTA APPLICATION POSTS NOTHING. RED if the skip is dropped:
--      post_journal raises on a zero balancing line, so re-approving the same
--      amount would fail outright at the desk.
--
--   6  PAYMENTS, PER METHOD, AND THE WHITELIST REFUSING BY NAME. cash to cash;
--      company_account to company_receivable and to nothing cash-like, because
--      nothing was received; a reversal mirrored by sign with its entry linked.
--      'other' — legal in the constraint, off the picker since 059, zero rows —
--      must raise PT422 NAMING the method, read by SQLSTATE and message rather
--      than by "something raised" (rule 27's fifth shape).
--
--   7  NO ENTRY IS SHORT, AND NONE NEEDED ROUNDING. Two or more lines each, and
--      NOT ONE rounding_difference line. The second half earns its place:
--      post_journal absorbs a discrepancy up to 1.00 into that line, so a
--      receivable computed here instead of left open — one kobo wrong — would
--      still balance, still post, and look perfect.
--
--   8  THE COMPED COUNTER POSTS WITHOUT A GUEST LEDGER LEG. Two legs, debits
--      equal credits, no receivable. RED if the leg is unconditional, in which
--      case post_journal raises and reversing a comped charge fails at the desk.
--
--   9  THE INVARIANT. The guest ledger's net debit over folio 1's entries
--      equals folio_balance(folio 1), computed from the folio tables by a
--      function that knows nothing about the ledger. Plus a guard that the
--      balance is not zero, so the comparison cannot pass vacuously.
--
--  10  A SECOND CALL POSTS NOTHING NEW. The document pair is the key.
--
--  11  THE SHAPE. All three SECURITY DEFINER with a pinned search_path, and
--      none executable by `authenticated`.
--
--  12  EACH CHARGE'S ENTRY USES ITS OWN CAPTURED ACCOUNT. Two charges on one
--      folio, posted either side of a repoint, must land in two different
--      revenue accounts. Anything reading a single global answer puts them
--      together.
do $$
declare
  v_tenant  uuid;
  v_user    uuid;
  v_prop    uuid;
  v_guest   uuid;
  v_guest2  uuid;
  v_folio   folios;
  v_folio2  folios;
  v_cat     uuid;
  v_rk      text;
  v_rk2     text;
  v_a       folio_charges;
  v_b       folio_charges;
  v_ctr     folio_charges;
  v_d       folio_charges;
  v_dctr    folio_charges;
  v_disc    uuid;
  v_pay     folio_payments;
  v_payr    folio_payments;
  v_pay2    folio_payments;
  v_pay3    folio_payments;
  v_e1      journal_entries;   -- charge A
  v_e2      journal_entries;   -- discount 0 -> 200
  v_e3      journal_entries;   -- discount 200 -> 500
  v_e4      journal_entries;   -- the counter of A
  v_e5      journal_entries;   -- charge B, posted after the repoint
  v_e6      journal_entries;   -- cash payment
  v_e7      journal_entries;   -- the payment's reversal
  v_e8      journal_entries;   -- company-account payment (folio 2)
  v_e9      journal_entries;   -- the comped counter (folio 2)
  v_tmp     journal_entries;
  v_ids     uuid[] := '{}';    -- every entry this fixture posted
  v_chain   uuid[] := '{}';    -- charge A, its applications, its counter
  v_f1      uuid[] := '{}';    -- every entry belonging to folio 1
  v_tax0    numeric(14,2);
  v_tax200  numeric(14,2);
  v_tax500  numeric(14,2);
  v_indep   numeric(14,2);
  v_ntax    integer;
  v_nctax   integer;
  v_n       integer;
  v_bad     integer;
  v_amt     numeric;
  v_amt2    numeric;
  v_bal     numeric;
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
      raise notice '061 SELF-VERIFY SKIPPED: no tenant or active owner/manager.';
      raise exception 'ZZ_061_FIXTURE_DONE';
    end if;
    perform set_config('request.jwt.claims',
      json_build_object('role','service_role','sub', v_user::text)::text, true);

    -- THIS OVERWRITES A REAL MANAGER'S PIN, and it is only safe because the
    -- ZZ_061_FIXTURE_DONE sentinel below guarantees this block rolls back — the
    -- raise is unconditional, so no path commits it. Anyone copying this
    -- pattern into something that COMMITS must use a throwaway user instead; a
    -- credential clobbered for the length of a transaction and one clobbered
    -- for good look identical in the diff.
    insert into manager_pins (tenant_id, user_id, pin_hash)
    values (v_tenant, v_user, crypt('4061', gen_salt('bf')))
    on conflict (tenant_id, user_id) do update set pin_hash = excluded.pin_hash;

    select cc.id into v_cat from charge_categories cc
    where cc.tenant_id = v_tenant and cc.is_taxable and cc.deleted_at is null
      and cc.is_active
    order by cc.code limit 1;
    if v_cat is null then
      raise exception '061 SELF-VERIFY needs a live taxable charge category.';
    end if;

    -- TWO GUESTS, because open_guest_folio returns a guest's EXISTING OPEN
    -- folio whatever idempotency key it is handed — one open folio per guest.
    -- Opening both for one guest gave back the same folio, so folio 2's
    -- payments landed on folio 1 and assertion 9 went red at exactly their
    -- total against code that was correct. That is the assertion earning its
    -- place: it caught a wrong assumption in the FIXTURE, which is the only
    -- reason it can be trusted to catch one in the helpers.
    insert into guests (tenant_id, first_name, last_name, created_by)
    values (v_tenant, 'ZZ061', 'Fixture Guest', v_user) returning id into v_guest;
    insert into guests (tenant_id, first_name, last_name, created_by)
    values (v_tenant, 'ZZ061', 'Second Guest', v_user) returning id into v_guest2;
    v_folio  := open_guest_folio(v_tenant, v_prop, v_guest,  'zz061-folio-1');
    v_folio2 := open_guest_folio(v_tenant, v_prop, v_guest2, 'zz061-folio-2');
    if v_folio2.id = v_folio.id then
      raise exception '061 SELF-VERIFY: both folios came back as the same row.';
    end if;

    -- ===================== 1. THE CHARGE'S ENTRY ==========================
    v_a  := post_charge(v_folio.id, v_cat, 'ZZ061 dinner', 1, 10000, current_date,
                        'zz061-charge-1', 'manual');
    v_rk := v_a.account_role_key;

    select coalesce(sum(t.amount), 0), count(*) filter (where t.amount <> 0)::integer
      into v_tax0, v_ntax
    from folio_charge_tax_lines t where t.folio_charge_id = v_a.id;
    if v_tax0 <= 0 then
      raise exception '061 SELF-VERIFY needs a taxed charge; this one captured % of tax.', v_tax0;
    end if;

    v_e1 := post_folio_charge_journal(v_a.id);
    if v_e1 is null then
      raise exception '061 SELF-VERIFY: the charge posted no entry at all, so nothing below can be read.';
    end if;
    v_ids := v_ids || v_e1.id; v_chain := v_chain || v_e1.id; v_f1 := v_f1 || v_e1.id;

    select count(*)::integer into v_n
    from journal_entry_lines l where l.journal_entry_id = v_e1.id;
    if v_n <> 2 + v_ntax then
      v_fail := v_fail || format(
        '1: the charge entry has %s lines, expected %s (gross, %s tax, receivable). ',
        v_n, 2 + v_ntax, v_ntax);
    end if;

    select coalesce(sum(l.debit - l.credit), 0) into v_amt
    from journal_entry_lines l where l.journal_entry_id = v_e1.id and l.role_key = v_rk;
    if v_amt is distinct from -10000.00 then
      v_fail := v_fail || format(
        '1: the gross leg nets %s at %s, expected a credit of 10000.00. ', v_amt, v_rk);
    end if;

    select coalesce(sum(l.debit - l.credit), 0) into v_amt
    from journal_entry_lines l where l.journal_entry_id = v_e1.id and l.role_key = 'vat_output';
    if v_amt is distinct from -v_tax0 then
      v_fail := v_fail || format('1: the tax leg nets %s, expected %s. ', v_amt, -v_tax0);
    end if;

    select coalesce(sum(l.debit - l.credit), 0) into v_amt
    from journal_entry_lines l where l.journal_entry_id = v_e1.id and l.role_key = 'guest_ledger';
    if v_amt is distinct from 10000.00 + v_tax0 then
      v_fail := v_fail || format(
        '1: the receivable leg nets %s, expected %s — it is the sum of what was written, so this also checks the OPEN line was asked for on the right side. ',
        v_amt, 10000.00 + v_tax0);
    end if;

    -- ===================== 2. TWO APPLICATIONS, TWO DELTAS ================
    perform apply_charge_discount(v_a.id, 200, 'ZZ061 goodwill', '4061', 'zz061-k1');
    select coalesce(sum(t.amount), 0) into v_tax200
    from folio_charge_tax_lines t where t.folio_charge_id = v_a.id;
    select d.id into v_disc from folio_charge_discounts d
    where d.folio_charge_id = v_a.id order by d.seq desc limit 1;
    v_e2 := post_folio_discount_journal(v_disc);
    if v_e2 is null then
      raise exception '061 SELF-VERIFY: the first discount application posted no entry.';
    end if;
    v_ids := v_ids || v_e2.id; v_chain := v_chain || v_e2.id; v_f1 := v_f1 || v_e2.id;

    select coalesce(sum(l.debit - l.credit), 0) into v_amt
    from journal_entry_lines l
    where l.journal_entry_id = v_e2.id and l.role_key = 'discounts_allowed';
    if v_amt is distinct from 200.00 then
      v_fail := v_fail || format(
        '2: the first application''s discount leg nets %s, expected 200.00. ', v_amt);
    end if;
    select coalesce(sum(l.debit - l.credit), 0) into v_amt
    from journal_entry_lines l
    where l.journal_entry_id = v_e2.id and l.role_key = 'vat_output';
    if v_amt is distinct from v_tax0 - v_tax200 then
      v_fail := v_fail || format(
        '2: the first application''s tax delta leg nets %s, expected %s. Omitting it is 032''s tax residue in its original form: entries that balance, reconcile, and do not net. ',
        v_amt, v_tax0 - v_tax200);
    end if;

    -- THE SECOND APPLICATION, where the delta (300) and the new amount (500)
    -- are different numbers. This is the assertion that protects the ledger.
    perform apply_charge_discount(v_a.id, 500, 'ZZ061 more goodwill', '4061', 'zz061-k2');
    select coalesce(sum(t.amount), 0) into v_tax500
    from folio_charge_tax_lines t where t.folio_charge_id = v_a.id;
    select d.id into v_disc from folio_charge_discounts d
    where d.folio_charge_id = v_a.id order by d.seq desc limit 1;
    v_e3 := post_folio_discount_journal(v_disc);
    if v_e3 is null then
      raise exception '061 SELF-VERIFY: the second discount application posted no entry.';
    end if;
    v_ids := v_ids || v_e3.id; v_chain := v_chain || v_e3.id; v_f1 := v_f1 || v_e3.id;

    select coalesce(sum(l.debit - l.credit), 0) into v_amt
    from journal_entry_lines l
    where l.journal_entry_id = v_e3.id and l.role_key = 'discounts_allowed';
    if v_amt is distinct from 300.00 then
      v_fail := v_fail || format(
        '2: raising the discount from 200 to 500 posted %s, expected the DELTA of 300.00. A helper posting the new amount reads 500.00 here — and would have been GREEN on the first application, where previous is 0 and the two coincide. ',
        v_amt);
    end if;
    select coalesce(sum(l.debit - l.credit), 0) into v_amt
    from journal_entry_lines l
    where l.journal_entry_id = v_e3.id and l.role_key = 'vat_output';
    if v_amt is distinct from v_tax200 - v_tax500 then
      v_fail := v_fail || format(
        '2: the second application''s tax delta nets %s, expected %s — the change between the two states, not the whole restated tax. ',
        v_amt, v_tax200 - v_tax500);
    end if;

    -- ---- 4a: the posted tax agrees with restate's OWN formula -------------
    select coalesce(sum(round((v_a.gross_amount - 500) * t.rate, 2)), 0) into v_indep
    from folio_charge_tax_lines t where t.folio_charge_id = v_a.id;
    select coalesce(-sum(l.debit - l.credit), 0) into v_amt
    from journal_entry_lines l
    where l.journal_entry_id = any(array[v_e1.id, v_e2.id, v_e3.id])
      and l.role_key = 'vat_output';
    if v_amt is distinct from v_indep or v_indep is distinct from v_tax500 then
      v_fail := v_fail || format(
        '4: the tax POSTED across the charge and both applications is %s, the independent round(net * rate, 2) is %s, and the row now reads %s. All three must agree or SECTION 2''s delta has drifted from restate_charge_taxes. ',
        v_amt, v_indep, v_tax500);
    end if;

    -- ===================== 5. A ZERO DELTA POSTS NOTHING ==================
    perform apply_charge_discount(v_a.id, 500, 'ZZ061 re-approved, same amount',
                                  '4061', 'zz061-k3');
    select d.id into v_disc from folio_charge_discounts d
    where d.folio_charge_id = v_a.id order by d.seq desc limit 1;
    v_tmp := post_folio_discount_journal(v_disc);
    if v_tmp is not null then
      v_fail := v_fail ||
        '5: a zero-delta application posted an entry. post_journal raises on a zero balancing line, so a re-approval at the desk would fail outright. ';
    end if;
    select count(*)::integer into v_n from journal_entries je
    where je.source_document_type = 'folio_charge_discount' and je.source_document_id = v_disc;
    if v_n <> 0 then
      v_fail := v_fail || format('5: the zero-delta application left %s entr(ies). ', v_n);
    end if;

    -- ===================== THE REPOINT ====================================
    -- From here the category points somewhere else. Charge A's captured key and
    -- a live lookup now DISAGREE, which is the only condition under which
    -- assertions 3 and 12 can tell them apart. 059 made post_charge capture the
    -- key and post_charge_reversal carry the ORIGINAL's; this proves the
    -- posting helper reads what they captured rather than asking again.
    v_rk2 := case when v_rk = 'revenue_misc' then 'revenue_fnb' else 'revenue_misc' end;
    update charge_categories set account_role_key = v_rk2 where id = v_cat;

    -- ===================== 3. THE COUNTER, MIRRORED =======================
    -- RE-READ FIRST. v_a is the row post_charge returned, whose discount was 0;
    -- 500 has been applied since. Mirroring the stale value would give the
    -- counter no discount leg, and assertion 4 would then report a residue in
    -- discounts_allowed against code that is perfectly correct.
    select * into v_a from folio_charges where id = v_a.id;
    v_ctr := post_charge_reversal(v_a.id, 'charge', -(v_a.gross_amount),
                                  -(v_a.discount_amount), 'ZZ061 reversal',
                                  current_date, 'zz061-rev-1');
    if v_ctr.account_role_key is distinct from v_rk then
      raise exception '061 SELF-VERIFY: the counter captured % rather than the original''s %; 059''s carry-through has changed and assertion 3 would be testing nothing.',
        v_ctr.account_role_key, v_rk;
    end if;
    v_e4 := post_folio_charge_journal(v_ctr.id);
    if v_e4 is null then
      raise exception '061 SELF-VERIFY: the counter charge posted no entry.';
    end if;
    v_ids := v_ids || v_e4.id; v_chain := v_chain || v_e4.id; v_f1 := v_f1 || v_e4.id;

    select count(*) filter (where t.amount <> 0)::integer into v_nctax
    from folio_charge_tax_lines t where t.folio_charge_id = v_ctr.id;
    select count(*)::integer into v_n
    from journal_entry_lines l where l.journal_entry_id = v_e4.id;
    if v_n <> 3 + v_nctax then
      v_fail := v_fail || format(
        '3: the counter entry has %s lines, expected %s (gross, discount, %s tax, receivable). ',
        v_n, 3 + v_nctax, v_nctax);
    end if;
    if v_e4.reverses_entry_id is distinct from v_e1.id then
      v_fail := v_fail || format(
        '3: the counter entry points at %s as the entry it unwinds, expected the charge''s own entry %s. ',
        coalesce(v_e4.reverses_entry_id::text, '(nothing)'), v_e1.id);
    end if;
    select coalesce(sum(l.debit - l.credit), 0) into v_amt
    from journal_entry_lines l where l.journal_entry_id = v_e4.id and l.role_key = v_rk;
    select coalesce(sum(l.debit - l.credit), 0) into v_amt2
    from journal_entry_lines l where l.journal_entry_id = v_e4.id and l.role_key = v_rk2;
    if v_amt is distinct from 10000.00 or v_amt2 <> 0 then
      v_fail := v_fail || format(
        '3: the counter''s gross leg nets %s at the CAPTURED account %s and %s at the repointed %s; expected +10000.00 and 0. A live lookup books a reversal against whichever account that category points at today. ',
        v_amt, v_rk, v_amt2, v_rk2);
    end if;
    select coalesce(sum(l.debit - l.credit), 0) into v_amt
    from journal_entry_lines l where l.journal_entry_id = v_e4.id and l.role_key = 'discounts_allowed';
    if v_amt is distinct from -500.00 then
      v_fail := v_fail || format('3: the counter''s discount leg nets %s, expected -500.00. ', v_amt);
    end if;

    -- ---- 4b: EVERY ACCOUNT NETS TO ZERO ----------------------------------
    select count(*)::integer into v_bad
    from (
      select l.role_key, sum(l.debit - l.credit) net
      from journal_entry_lines l where l.journal_entry_id = any(v_chain)
      group by l.role_key having sum(l.debit - l.credit) <> 0
    ) r;
    if v_bad > 0 then
      select string_agg(format('%s %s', r.role_key, r.net), ', ') into v_err
      from (
        select l.role_key, sum(l.debit - l.credit) net
        from journal_entry_lines l where l.journal_entry_id = any(v_chain)
        group by l.role_key having sum(l.debit - l.credit) <> 0
      ) r;
      v_fail := v_fail || format(
        '4: a charge, two discount applications and a full reversal left a residue in %s account(s): %s. Every one must net to zero — 032''s tax residue asserted as an absence. ',
        v_bad, v_err);
    end if;

    -- ===================== 12. EACH CHARGE, ITS OWN ACCOUNT ===============
    v_b := post_charge(v_folio.id, v_cat, 'ZZ061 breakfast', 1, 5000, current_date,
                       'zz061-charge-2', 'manual');
    if v_b.account_role_key is distinct from v_rk2 then
      raise exception '061 SELF-VERIFY: charge B captured % rather than the repointed %.',
        v_b.account_role_key, v_rk2;
    end if;
    v_e5 := post_folio_charge_journal(v_b.id);
    if v_e5 is null then
      raise exception '061 SELF-VERIFY: charge B posted no entry.';
    end if;
    v_ids := v_ids || v_e5.id; v_f1 := v_f1 || v_e5.id;
    select coalesce(sum(l.debit - l.credit), 0) into v_amt
    from journal_entry_lines l where l.journal_entry_id = v_e5.id and l.role_key = v_rk2;
    select coalesce(sum(l.debit - l.credit), 0) into v_amt2
    from journal_entry_lines l where l.journal_entry_id = v_e5.id and l.role_key = v_rk;
    if v_amt is distinct from -5000.00 or v_amt2 <> 0 then
      v_fail := v_fail || format(
        '12: charge B posted %s at %s and %s at %s. Two charges on one folio, either side of a repoint, must land in two different revenue accounts. ',
        v_amt, v_rk2, v_amt2, v_rk);
    end if;

    -- ===================== 6. PAYMENTS ====================================
    v_pay := record_payment(v_folio.id, 2000, 'cash', 'ZZ061 cash in',
                            current_date, 'zz061-pay-1');
    v_e6 := post_folio_payment_journal(v_pay.id);
    if v_e6 is null then
      raise exception '061 SELF-VERIFY: the cash payment posted no entry.';
    end if;
    v_ids := v_ids || v_e6.id; v_f1 := v_f1 || v_e6.id;
    select count(*)::integer into v_n
    from journal_entry_lines l where l.journal_entry_id = v_e6.id;
    select coalesce(sum(l.debit - l.credit), 0) into v_amt
    from journal_entry_lines l where l.journal_entry_id = v_e6.id and l.role_key = 'cash';
    select coalesce(sum(l.debit - l.credit), 0) into v_amt2
    from journal_entry_lines l where l.journal_entry_id = v_e6.id and l.role_key = 'guest_ledger';
    if v_n <> 2 or v_amt is distinct from 2000.00 or v_amt2 is distinct from -2000.00 then
      v_fail := v_fail || format(
        '6: a cash payment posted %s lines, cash %s, receivable %s; expected 2 lines, +2000.00 and -2000.00. ',
        v_n, v_amt, v_amt2);
    end if;

    -- its reversal, mirrored by sign and linked to the entry it unwinds
    -- reverse_payment returns a `reversals` row, not the payment it wrote, so the
    -- counter row is read back by the link it set.
    perform reverse_payment(v_pay.id, 'ZZ061 wrong guest', '4061', 'zz061-payrev-1');
    select * into v_payr from folio_payments
    where reversal_of_payment_id = v_pay.id order by created_at desc limit 1;
    if not found then
      raise exception '061 SELF-VERIFY: reverse_payment wrote no counter payment row.';
    end if;
    v_e7 := post_folio_payment_journal(v_payr.id);
    if v_e7 is null then
      raise exception '061 SELF-VERIFY: the payment reversal posted no entry.';
    end if;
    v_ids := v_ids || v_e7.id; v_f1 := v_f1 || v_e7.id;
    select coalesce(sum(l.debit - l.credit), 0) into v_amt
    from journal_entry_lines l where l.journal_entry_id = v_e7.id and l.role_key = 'cash';
    select coalesce(sum(l.debit - l.credit), 0) into v_amt2
    from journal_entry_lines l where l.journal_entry_id = v_e7.id and l.role_key = 'guest_ledger';
    if v_amt is distinct from -2000.00 or v_amt2 is distinct from 2000.00 then
      v_fail := v_fail || format(
        '6: the payment reversal posted cash %s and receivable %s, expected -2000.00 and +2000.00 — the mirror, by sign and nothing else. ',
        v_amt, v_amt2);
    end if;
    if v_e7.reverses_entry_id is distinct from v_e6.id then
      v_fail := v_fail || format(
        '6: the reversal entry points at %s, expected the payment''s own entry %s. ',
        coalesce(v_e7.reverses_entry_id::text, '(nothing)'), v_e6.id);
    end if;

    -- a company account is NOT a receipt: the debt moves, nothing arrives
    v_pay2 := record_payment(v_folio2.id, 1500, 'company_account', 'ZZ061 to company',
                             current_date, 'zz061-pay-2');
    v_e8 := post_folio_payment_journal(v_pay2.id);
    if v_e8 is null then
      raise exception '061 SELF-VERIFY: the company-account payment posted no entry.';
    end if;
    v_ids := v_ids || v_e8.id;
    select coalesce(sum(l.debit - l.credit), 0) into v_amt
    from journal_entry_lines l
    where l.journal_entry_id = v_e8.id and l.role_key = 'company_receivable';
    select count(*)::integer into v_bad
    from journal_entry_lines l
    where l.journal_entry_id = v_e8.id and l.role_key in ('cash','bank','pos_clearing');
    if v_amt is distinct from 1500.00 or v_bad > 0 then
      v_fail := v_fail || format(
        '6: a company-account payment put %s into company_receivable and touched %s cash-like account(s); expected +1500.00 and none. Mapping it to cash or a bank says money arrived when only the debtor changed. ',
        v_amt, v_bad);
    end if;

    -- 'other' is legal in the constraint, off the picker, and carries zero
    -- rows. It is the one legal method with no account decided for it, so it is
    -- how the whitelist's refusal is exercised. READ BY SQLSTATE AND MESSAGE.
    v_pay3 := record_payment(v_folio2.id, 100, 'other', 'ZZ061 undecided',
                             current_date, 'zz061-pay-3');
    v_ok := false; v_err := null; v_state := null;
    begin
      v_tmp := post_folio_payment_journal(v_pay3.id);
      v_ok := true;
    exception when others then v_err := sqlerrm; v_state := sqlstate; end;
    if v_ok or v_state is distinct from 'PT422'
       or v_err not like '%"other"%' or v_err not like '%no account decided%' then
      v_fail := v_fail || format(
        '6: a payment by an undecided method was answered by %s / %s. It must refuse BY NAME — a role key built by concatenation fails as a missing account_mappings row, which invites somebody to add one instead of deciding where the money goes. ',
        coalesce(v_state, 'a posted entry'), coalesce(v_err, '(no error)'));
    end if;

    -- ===================== 8. THE COMPED COUNTER ==========================
    v_d := post_charge(v_folio2.id, v_cat, 'ZZ061 comped dinner', 1, 10000,
                       current_date, 'zz061-charge-3', 'manual');
    perform apply_charge_discount(v_d.id, 10000, 'ZZ061 full comp', '4061', 'zz061-k4');
    select * into v_d from folio_charges where id = v_d.id;
    v_dctr := post_charge_reversal(v_d.id, 'charge', -(v_d.gross_amount),
                                   -(v_d.discount_amount), 'ZZ061 comp reversed',
                                   current_date, 'zz061-rev-2');
    if v_dctr.net_amount <> 0 then
      v_fail := v_fail || format(
        '8: the comped counter came out at net %s, so this fixture no longer demonstrates the zero-residual case. ',
        v_dctr.net_amount);
    end if;
    -- THE REFUSAL IS CAUGHT AND RECORDED, not allowed to propagate. An
    -- unconditional receivable leg makes post_journal raise HERE, and if that
    -- raise escaped it would abort the block and throw away every assertion
    -- already written into v_fail — so the proof would report "post_journal
    -- refused" instead of the eight findings it had collected. Reading the
    -- SQLSTATE and the message keeps it an assertion rather than "something
    -- raised" (rule 27's fifth shape).
    v_e9 := null; v_err := null; v_state := null;
    begin
      v_e9 := post_folio_charge_journal(v_dctr.id);
    exception when others then v_err := sqlerrm; v_state := sqlstate; end;
    if v_state is not null then
      v_fail := v_fail || format(
        '8: posting the counter of a fully comped charge was REFUSED by %s / %s. That leg IS the residual, and this document moved nothing the guest owes — refusing here makes reversing a comp fail at the desk. ',
        v_state, v_err);
    end if;
    if v_e9 is null and v_state is null then
      v_fail := v_fail ||
        '8: the counter of a fully comped charge posted nothing. Its revenue and contra genuinely need unwinding. ';
    else
      v_ids := v_ids || v_e9.id;
      select count(*)::integer into v_n
      from journal_entry_lines l where l.journal_entry_id = v_e9.id;
      select count(*)::integer into v_bad
      from journal_entry_lines l
      where l.journal_entry_id = v_e9.id and l.role_key = 'guest_ledger';
      if v_n <> 2 or v_bad <> 0 then
        v_fail := v_fail || format(
          '8: the comped counter posted %s lines, %s of them guest_ledger; expected 2 and NO receivable leg. That leg IS the residual, and this document moved nothing the guest owes. ',
          v_n, v_bad);
      end if;
      select coalesce(sum(l.debit), 0), coalesce(sum(l.credit), 0) into v_amt, v_amt2
      from journal_entry_lines l where l.journal_entry_id = v_e9.id;
      if v_amt is distinct from 10000.00 or v_amt2 is distinct from 10000.00 then
        v_fail := v_fail || format(
          '8: the comped counter posted debits %s and credits %s, expected 10000.00 each. ', v_amt, v_amt2);
      end if;
    end if;

    -- ===================== 7. SHORT ENTRIES AND ROUNDING ==================
    select count(*)::integer into v_bad
    from (
      select l.journal_entry_id from journal_entry_lines l
      where l.journal_entry_id = any(v_ids)
      group by l.journal_entry_id having count(*) < 2
    ) s;
    if v_bad > 0 then
      v_fail := v_fail || format(
        '7: %s entr(ies) posted with fewer than two lines. By SECTION 1''s arithmetic a single surviving leg is unreachable, so this means a leg was omitted on the wrong test. ',
        v_bad);
    end if;
    select count(*)::integer into v_bad
    from journal_entry_lines l
    where l.journal_entry_id = any(v_ids) and l.role_key = 'rounding_difference';
    if v_bad > 0 then
      v_fail := v_fail || format(
        '7: %s rounding_difference line(s) were written. post_journal absorbs up to 1.00 into that line, so a receivable computed here instead of left open — one kobo wrong — still balances, still posts, and looks perfect. A rounding line in a folio entry means a leg is wrong, not that money is awkward. ',
        v_bad);
    end if;

    -- ===================== 9. THE INVARIANT ===============================
    select coalesce(sum(l.debit - l.credit), 0) into v_amt
    from journal_entry_lines l
    where l.journal_entry_id = any(v_f1) and l.role_key = 'guest_ledger';
    v_bal := folio_balance(v_folio.id);
    if v_amt is distinct from v_bal then
      v_fail := v_fail || format(
        '9: the guest ledger nets %s over folio 1''s entries while folio_balance reads %s. The receivable is meant to be the sum of what was written, and folio_balance knows nothing about the ledger — which is what makes this a proof rather than a restatement. ',
        v_amt, v_bal);
    end if;
    if v_bal = 0 then
      v_fail := v_fail ||
        '9: folio 1 balances to zero, so this assertion is comparing zero to zero and any symmetric defect satisfies it. Charge B exists to stop that. ';
    end if;

    select count(*)::integer into v_bad
    from folio_charges fc
    where fc.net_amount is distinct from fc.gross_amount - fc.discount_amount;
    if v_bad > 0 then
      v_fail := v_fail || format(
        '9: %s charge(s) have net_amount disagreeing with gross - discount, which is what SECTION 1''s residual is computed from. ', v_bad);
    end if;

    -- ===================== 10. A SECOND CALL ==============================
    select count(*)::integer into v_n from journal_entries;
    v_tmp := post_folio_charge_journal(v_a.id);
    if v_tmp.id is distinct from v_e1.id then
      v_fail := v_fail || format('10: posting the charge twice gave entry %s then %s. ', v_e1.id, v_tmp.id);
    end if;
    v_tmp := post_folio_payment_journal(v_pay.id);
    if v_tmp.id is distinct from v_e6.id then
      v_fail := v_fail || '10: posting the payment twice gave two different entries. ';
    end if;
    select count(*)::integer into v_bad from journal_entries;
    if v_bad <> v_n then
      v_fail := v_fail || format('10: calling the helpers again added %s entr(ies). ', v_bad - v_n);
    end if;

    -- ===================== 11. THE SHAPE ==================================
    select count(*)::integer into v_n
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('post_folio_charge_journal','post_folio_discount_journal',
                        'post_folio_payment_journal');
    if v_n <> 3 then
      v_fail := v_fail || format('11: %s of the three helpers exist, expected 3. ', v_n);
    end if;

    select count(*)::integer into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('post_folio_charge_journal','post_folio_discount_journal',
                        'post_folio_payment_journal')
      and (not p.prosecdef
           or p.proconfig is null
           or not exists (select 1 from unnest(p.proconfig) cfg
                          where cfg like 'search_path=public%'));
    if v_bad > 0 then
      v_fail := v_fail || format(
        '11: %s of the three helpers lost SECURITY DEFINER or its pinned search_path. ', v_bad);
    end if;

    select count(*)::integer into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('post_folio_charge_journal','post_folio_discount_journal',
                        'post_folio_payment_journal')
      and has_function_privilege('authenticated', p.oid, 'EXECUTE');
    if v_bad > 0 then
      v_fail := v_fail || format(
        '11: %s of the three helpers can be executed by `authenticated`. They are called from inside the RPC that writes the row — 046''s post_stock_movement_journal is not granted either. ', v_bad);
    end if;

    if v_fail <> '' then
      raise exception '061 SELF-VERIFY FAILED — %', v_fail;
    end if;

    raise notice '061 SELF-VERIFY: 12 assertions passed (folio 1 balance %).', v_bal;
    raise exception 'ZZ_061_FIXTURE_DONE';
  exception
    when others then
      if sqlerrm = 'ZZ_061_FIXTURE_DONE' then
        raise notice '061 self-verify complete; fixture rolled back.';
      else
        raise;
      end if;
  end;
end $$;
