-- ============================================================================
-- 064_voids_post.sql
-- Palstro-Hotels: A VOID POSTS, AND NOTHING UNWINDS WHAT WAS NEVER BOOKED.
--
-- ############################################################################
-- THIS FILE CLOSES A DEFECT THAT 062 AND 063 LEFT LIVE.
-- ############################################################################
-- Said plainly and at the top, because somebody will one day search for when
-- that residue was closed and the answer should not be "inside a shipment about
-- voids".
--
-- From 062 (4 November) until this file, the folio could post HALF of a pair.
-- A document whose business date had not arrived was correctly declined, and a
-- document that modified or unwound it was posted anyway. Three forms were
-- reachable from the front desk, all three measured on the live schema:
--
--   1. REVERSE A NOT-YET-DUE NIGHT. The night declines; reverse_charge dates
--      its counter TODAY, whose day has come, so the counter posts alone:
--
--          guest_ledger   -48,444.75
--          revenue_room    45,023.00 Dr      <- never credited
--          vat_output       3,421.75 Dr      <- never credited
--
--   2. DISCOUNT A PRE-WIRING CHARGE. The charge will never post (061 §4), the
--      application posts anyway:
--
--          discounts_allowed  5,000.00 Dr
--          vat_output           380.00 Dr
--          guest_ledger       5,380.00 Cr    <- against no debit at all
--
--   3. REVERSE A PRE-WIRING CHARGE. The same, for a whole stay:
--
--          revenue_room     130,000.00 Dr
--          discounts_allowed  5,000.00 Cr
--          vat_output         9,500.00 Dr
--          guest_ledger     134,500.00 Cr
--
-- Every one of those entries BALANCES internally, so nothing errored and
-- nothing looked wrong. Form 3 was sitting one click away on the Executive
-- Suite charge, which is on an open folio today. Nothing real was affected —
-- Heledon has not gone live and 5.5 empties the journal — but the books would
-- have carried 130,000.00 of revenue reversed out of accounts it was never in.
--
-- WHY IT WAS NOT SEEN IN 062 OR 063: both shipments asked "is this document's
-- day here?" and neither asked "is the thing it refers to in the books?". The
-- decline was new, so nothing that pre-dated it had a reason to consider a
-- half-posted pair. It was found by working out what item 2b's sweep would meet
-- one morning, which is the question that forced it.
--
-- ----------------------------------------------------------------------------
-- THE RULE, AND IT IS ONE CONDITION ON A VALUE THE HELPER ALREADY COMPUTED
-- ----------------------------------------------------------------------------
--     A DOCUMENT THAT MODIFIES OR UNWINDS ANOTHER NEVER POSTS UNLESS THAT
--     OTHER ONE HAS POSTED.
--
-- post_folio_charge_journal was already looking up reverses_entry_id and
-- already getting NULL when the original had no entry. It posted anyway. The
-- fix is to ask, and SECTION 1 is where the asking lives.
--
-- It began as "a counter waits for the entry it unwinds", which answers forms 1
-- and 3. Form 2 is why it says MODIFIES OR UNWINDS: a discount does not unwind
-- an entry, it modifies one, and 5,380.00 of relief against revenue that was
-- never booked is the same defect with a smaller number.
--
-- ----------------------------------------------------------------------------
-- AND THE VOID ITSELF: WHAT DOES THE BILL SAY
-- ----------------------------------------------------------------------------
-- Item 6's question was whether a declined document, voided before its day,
-- should post both halves or neither. The test that answers it is already in
-- the product:
--
--   * A VOID REMOVES THE LINE FROM THE BILL. folio_totals filters
--     `is_voided is not true`, so the guest owes nothing for it and it appears
--     in no total. The ledger records NOTHING.
--   * A REVERSAL LEAVES BOTH ROWS ON THE BILL. The charge and its counter both
--     show and net to zero, and the guest sees both. The ledger records BOTH.
--
-- That asymmetry was not invented for this file, which is what makes it safe to
-- lean on. The alternative argument — consistency with the stock ledger — was
-- checked and does not apply: post_stock_adjustment REFUSES a forward business
-- date ('A stock movement cannot be dated in the future'), so the stock side
-- has no declined documents, no half-posted pairs, and no behaviour here to be
-- consistent with. Forward-dating is refused everywhere in this product except
-- a room night, where it is a real event because a reserved night is owed
-- before it arrives.
--
-- A VOID MIRRORS THE ENTRIES, NOT THE ROW, which is SECTION 3's own decision
-- and the subtlest thing in the file. Rebuilding the legs from the charge would
-- unwind a tax figure the books never held, because restate_charge_taxes
-- deletes and re-inserts the tax rows on every discount — and the residue would
-- be exactly the tax on every discount ever given to that charge. Breakage I
-- demonstrates it. The mirror also spans the charge's DISCOUNT applications,
-- because voiding a charge takes its discount off the bill too; breakage H
-- leaves 2,500.00 standing in discounts_allowed without it.
--
-- ----------------------------------------------------------------------------
-- WHAT ITEMS 2b AND 8 INHERIT, AND WHY IT IS A STRING RATHER THAN A BOOLEAN
-- ----------------------------------------------------------------------------
-- Some originals will NEVER post: the six pre-wiring documents, and anything
-- dated before gl_start_date once 5.5 sets it. Reverse one of those and the
-- counter waits for an entry that is never coming. That is the correct outcome
-- and it must not be indistinguishable from "not yet due", so the answer names
-- which it is:
--
--     waiting_*   drains by itself — a day passes, or a dependency posts
--     never_*     does not
--
--   * ITEM 2b's SWEEP posts `ready` and EXCLUDES `never_*`. Without that it
--     re-reads the same rows every morning forever, and the one row that has
--     genuinely gone wrong is lost among them.
--   * ITEM 8's BUCKETS absorb a document AND its dependents together. A
--     pre-wiring charge with a reversal is TWO documents outside the books —
--     never_pre_wiring and never_dependency — and a bucket that catches one but
--     not the other reports a difference that is really an incomplete
--     explanation.
--
-- Neither is built here. What is built here is the one answer they both read,
-- so neither re-derives it.
--
-- ONE SUPERSESSION, CALLED OUT RATHER THAN LEFT TWO FILES APART. 062 §1 said
-- is_voided is deliberately NOT read when posting a charge, on the grounds that
-- a charge voided before a backfill reached it would never post and item 6's
-- counter would then unwind something that was never on the books. That
-- reasoning is now obsolete, defeated by the very thing it feared: the void's
-- counter waits for the charge's entry, so it cannot unwind what was never
-- booked. The sentence was true when written and is wrong now, and SECTION 2
-- says so where the code changed.
--
-- ----------------------------------------------------------------------------
-- WHAT THE BREAKAGES WENT RED FOR (rule 27)
-- ----------------------------------------------------------------------------
-- Fourteen mutations. THIRTEEN red; the one green is documented below.
--
--   A   the dependency rule removed
--         -> 2, 3, 4 all at once: the counter of a not-yet-due night posts
--            alone at -48,444.75 again. The defect this file exists for
--   B   a never_* dependency treated as merely waiting
--         -> 1: three documents read waiting_for_dependency where
--            never_dependency is owed, and the sweep would return to them
--            every morning forever
--   C   a discount stops depending on its charge
--         -> 3: form 2 reopens
--   N   never_pre_gl removed
--         -> 1: a charge dated the day before the books opened reads ready.
--            THE ONE WORTH EXERCISING MOST, because it is the only state whose
--            first real execution is GO-LIVE MORNING — see below
--   D   never_pre_wiring removed                        -> 1, and 3 and 4 with it
--   E   never_voided removed
--         -> 1 / 8: a night voided before its day reads waiting_not_yet_due.
--            This is the precedence that IS observable
--   F   waiting_not_yet_due removed
--         -> post_journal's PT422, from inside checkout
--   G   the precedence inverted: own date before dependency   -> GREEN, below
--   H   the void mirrors only the charge, not its discounts
--         -> 6: discounts_allowed left standing at 2,500.00, with a residue in
--            three accounts
--   I   the void REBUILT FROM THE ROW instead of mirroring the entries
--         -> 12: the ledger stands at 18,830.00 against a folio balance of 0.00
--   J   the void dated the charge's day instead of the day it happened   -> 7
--   K   the posting call dropped from void_charge        -> 5, 12
--   L   the posting call dropped from void_payment       -> 9, 12
--   M   an unknown document type returns a state instead of refusing    -> 1
--
-- WHY G IS GREEN, AND IT IS A FACT ABOUT THE DATA RATHER THAN A GAP. Checking a
-- document's own date BEFORE its dependency changes no answer, because NO
-- REACHABLE DOCUMENT IS BOTH FORWARD-DATED AND never-dependency: a counter is
-- dated today by reverse_charge, a void is dated voided_at which is today, and
-- the only forward-dated dependent is a discount on a forward night — whose
-- charge is `waiting`, not `never`. (A discount on a voided charge would be the
-- case, and apply_charge_discount refuses one.) So that pair of checks is
-- ordered defensively, and the ordering that is load-bearing — never_voided
-- before waiting_not_yet_due — is breakage E, which goes red. Written down
-- rather than deleted, so the next person does not spend an afternoon looking
-- for the case.
--
-- ONE THING THE BREAKAGES FORCED ON THE FIXTURE: breakage J was GREEN at first
-- because the charge it voids was posted with today's date, so "the day of the
-- void" and "the day of the charge" were the same number and assertion 7 could
-- not tell them apart — rule 27's fourth shape. The charge is now posted two
-- days back.
--
-- ----------------------------------------------------------------------------
-- WHAT THIS FILE DELIBERATELY DOES NOT DO
-- ----------------------------------------------------------------------------
-- ALL NINE STATES ARE PRODUCED BY A REAL DOCUMENT, and two of them took work
-- that is worth naming because the alternative was a note saying they could not
-- be reached:
--
--   * never_pre_gl, on a THROWAWAY PROPERTY created inside the fixture, with
--     gl_start_date set by UPDATE — 044's "cannot move once the books have
--     opened" guard lives in update_property_finance_settings and is about a
--     property that already has entries. It matters more than the other one
--     because gl_start_date is null on Heledon until 5.5 sets it, so this
--     branch's first real execution is GO-LIVE MORNING. "Untested" and
--     "untested at the worst possible moment" would have been the same
--     sentence. The document it uses is the realistic one: a charge dated the
--     day before the books opened, which still belongs on the bill and must
--     not be refused.
--   * ready, on a row written AROUND post_charge so no posting call fired,
--     which is exactly what item 2b's sweep will find. The assertion then calls
--     the helper and requires it to post, so "ready" is checked to mean what it
--     says rather than merely to be returned.
--
--   * It does not sweep. Item 2b, which now has SECTION 1 to read.
--   * It does not reconcile. Item 8, likewise.
--   * It does not backfill the three forms' past damage, because there is none:
--     the measurements above were all taken in rolled-back transactions, and
--     journal_entries holds nothing but two goods_receipt entries.
--   * It does not change authorisation. No signature changes, nothing is
--     dropped, no ACL is rebuilt. The classifier and the two new helpers are
--     NOT granted to `authenticated`, matching every posting helper since 046;
--     void_charge and void_payment keep the grants they had. Assertion 14
--     checks both halves.
-- ============================================================================

-- ############################################################################
-- SECTION 1 — ONE FUNCTION THAT SAYS WHY A DOCUMENT IS NOT IN THE BOOKS
-- ############################################################################
-- Every posting decision in the folio now comes from here, and every consumer
-- of those decisions reads the same answer rather than re-deriving it. That is
-- the whole point: before this, the rule "do not post a document whose day has
-- not come" lived inline in two helpers, and the rule "do not unwind what was
-- never booked" lived nowhere, which is why three defects were reachable.
--
-- ----------------------------------------------------------------------------
-- THE EIGHT ANSWERS, IN TWO FAMILIES THAT MATTER MORE THAN THE EIGHT
-- ----------------------------------------------------------------------------
--   posted                   an entry exists for this document
--   ready                    it should post NOW
--   waiting_not_yet_due      its business date is still ahead
--   waiting_for_dependency   what it modifies or unwinds has not posted YET
--   never_pre_gl             dated before gl_start_date
--   never_pre_wiring         written before the folio was wired
--   never_voided             voided before it ever reached the books
--   never_dependency         what it modifies or unwinds will NEVER post
--   absent                   no such document
--
-- THE PREFIX IS THE CONTRACT. `waiting_*` drains by itself — a day passes, or a
-- dependency posts — and `never_*` does not. A consumer that cannot tell those
-- apart re-reads the same rows every morning forever, and the one row that has
-- genuinely gone wrong is lost among them. So:
--
--   * ITEM 2b's SWEEP posts `ready` and must EXCLUDE `never_*` outright. What is
--     left in `waiting_*` is tomorrow's work; what is in `never_*` is not work
--     at all.
--   * ITEM 8's RECONCILIATION buckets by the reason. A pre-wiring charge WITH a
--     reversal is TWO documents outside the books — the charge as
--     never_pre_wiring and its counter as never_dependency — and a bucket that
--     catches one but not the other reports a difference that is really an
--     incomplete explanation.
--
-- Neither of those is built here. What is built here is the one answer they
-- both read.
--
-- ----------------------------------------------------------------------------
-- THE PRECEDENCE, AND WHY IT IS THIS ORDER
-- ----------------------------------------------------------------------------
-- A document can be in several of these states at once, so the order is a
-- decision rather than a formality:
--
--   1. posted beats everything. If it is in the books, nothing else is asked.
--   2. never_pre_gl before never_pre_wiring, which is 047's own precedence on
--      the stock side (`not pre_gl and pre_wiring`), kept so the two buckets
--      stay mutually exclusive and one document cannot be counted twice.
--   3. never_voided before waiting_not_yet_due. A night that was voided before
--      its day will never post whether or not the day arrives, and calling it
--      "waiting" would leave the sweep returning to it every morning.
--   4. THE DEPENDENCY BEFORE THE OWN DATE. A counter of a pre-wiring charge is
--      never_dependency, not waiting_not_yet_due, because the reason it will
--      never post is the original and not the calendar.
--
-- ----------------------------------------------------------------------------
-- WHAT DEPENDS ON WHAT, AND WHY A DISCOUNT COUNTS
-- ----------------------------------------------------------------------------
--   folio_charge (a counter)  ->  the charge it reverses
--   folio_charge_discount     ->  the charge it reduces
--   folio_charge_void         ->  the charge it voids
--   folio_payment_void        ->  the payment it voids
--   folio_charge (ordinary)   ->  nothing
--   folio_payment             ->  nothing
--
-- A DISCOUNT IS ON THAT LIST, and it is the half nobody asked for. The rule was
-- framed as "a counter waits for the entry it unwinds", which answers the
-- reversal. But a discount does not unwind an entry — it MODIFIES one — and a
-- relief posted against revenue that was never booked is the same defect with a
-- smaller number. Measured on the live schema before this file: discounting the
-- pre-wiring room charge posted discounts_allowed 5,000.00 debit, vat_output
-- 380.00 debit and guest_ledger 5,380.00 credit, against a charge with no entry
-- at all. So the rule is stated as MODIFIES OR UNWINDS, and it is one list.
create or replace function folio_posting_state(p_document_type text, p_document_id uuid)
returns text
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_prop     uuid;
  v_bdate    date;
  v_created  timestamptz;
  v_voided   boolean;
  v_dep_type text;
  v_dep_id   uuid;
  v_timezone text;
  v_today    date;
  v_wired    timestamptz;
  v_glstart  date;
  v_dep      text;
begin
  -- ---- resolve the document into the five facts that decide ---------------
  -- its business date, when it was written, whether it is void, and what it
  -- modifies or unwinds. Nothing else matters here.
  if p_document_type = 'folio_charge' then
    select fc.property_id, fc.charge_date, fc.created_at, coalesce(fc.is_voided, false),
           case when fc.reversal_of_charge_id is not null then 'folio_charge' end,
           fc.reversal_of_charge_id
      into v_prop, v_bdate, v_created, v_voided, v_dep_type, v_dep_id
    from folio_charges fc where fc.id = p_document_id;

  elsif p_document_type = 'folio_charge_discount' then
    -- is_voided is read from the CHARGE: voiding a charge takes its discount
    -- off the bill too (folio_totals filters the charge), so an application on
    -- a voided charge has nothing to relieve.
    select d.property_id, d.business_date, d.created_at, coalesce(fc.is_voided, false),
           'folio_charge', fc.id
      into v_prop, v_bdate, v_created, v_voided, v_dep_type, v_dep_id
    from folio_charge_discounts d
    join folio_charges fc on fc.id = d.folio_charge_id
    where d.id = p_document_id;

  elsif p_document_type = 'folio_payment' then
    select fp.property_id, fp.payment_date, fp.created_at, coalesce(fp.is_voided, false),
           null::text, null::uuid
      into v_prop, v_bdate, v_created, v_voided, v_dep_type, v_dep_id
    from folio_payments fp where fp.id = p_document_id;

  elsif p_document_type = 'folio_charge_void' then
    -- The void is its own document on the charge's id. Its business date is the
    -- day the void HAPPENED, not the charge's day: a correction belongs to the
    -- operating day somebody made it, the same way reverse_charge dates its
    -- counter today. voided_at is also when it was "written", so a void keyed
    -- after the wiring is not pre-wiring even when the charge is.
    select fc.property_id,
           (fc.voided_at at time zone
             coalesce(nullif(btrim(p.timezone), ''), 'Africa/Lagos'))::date,
           fc.voided_at, false, 'folio_charge', fc.id
      into v_prop, v_bdate, v_created, v_voided, v_dep_type, v_dep_id
    from folio_charges fc
    join properties p on p.id = fc.property_id
    where fc.id = p_document_id and fc.is_voided is true;

  elsif p_document_type = 'folio_payment_void' then
    select fp.property_id,
           (fp.voided_at at time zone
             coalesce(nullif(btrim(p.timezone), ''), 'Africa/Lagos'))::date,
           fp.voided_at, false, 'folio_payment', fp.id
      into v_prop, v_bdate, v_created, v_voided, v_dep_type, v_dep_id
    from folio_payments fp
    join properties p on p.id = fp.property_id
    where fp.id = p_document_id and fp.is_voided is true;

  else
    raise exception 'Unknown folio document type "%"', p_document_type
      using errcode = 'PT422',
            hint = 'The folio posts five document types: folio_charge, folio_charge_discount, folio_payment, folio_charge_void and folio_payment_void.';
  end if;

  if not found then
    return 'absent';
  end if;

  -- ---- 1. already in the books --------------------------------------------
  if exists (
    select 1 from journal_entries je
    where je.source_document_type = p_document_type
      and je.source_document_id   = p_document_id
  ) then
    return 'posted';
  end if;

  select p.timezone into v_timezone from properties p where p.id = v_prop;
  v_today := (now() at time zone
              coalesce(nullif(btrim(v_timezone), ''), 'Africa/Lagos'))::date;
  select pfs.gl_start_date, pfs.folio_gl_wired_at
    into v_glstart, v_wired
  from property_finance_settings pfs where pfs.property_id = v_prop;

  -- ---- 2, 3. the two that will never post, in 047's precedence ------------
  if v_glstart is not null and v_bdate < v_glstart then
    return 'never_pre_gl';
  end if;
  if v_wired is not null and v_created < v_wired then
    return 'never_pre_wiring';
  end if;
  if v_voided then
    return 'never_voided';
  end if;

  -- ---- 4. what it modifies or unwinds ------------------------------------
  -- Recursive, and it terminates: reversal_of_charge_id always points at an
  -- OLDER row, and a void's dependency is a different TYPE on the same id, so
  -- no document can be its own ancestor.
  if v_dep_id is not null then
    v_dep := folio_posting_state(v_dep_type, v_dep_id);
    if v_dep = 'absent' or v_dep like 'never\_%' then
      return 'never_dependency';
    end if;
    if v_dep <> 'posted' then
      return 'waiting_for_dependency';
    end if;
  end if;

  -- ---- 5. its own day ----------------------------------------------------
  if v_bdate > v_today then
    return 'waiting_not_yet_due';
  end if;

  return 'ready';
end;
$function$;

revoke all on function folio_posting_state(text, uuid) from public;
revoke all on function folio_posting_state(text, uuid) from anon;
revoke all on function folio_posting_state(text, uuid) from authenticated;

comment on function folio_posting_state(text, uuid) is
  'Says why a folio document is or is not in the books, as one of: posted, '
  'ready, waiting_not_yet_due, waiting_for_dependency, never_pre_gl, '
  'never_pre_wiring, never_voided, never_dependency, absent. THE PREFIX IS THE '
  'CONTRACT: waiting_* drains by itself as a day passes or a dependency posts, '
  'never_* does not. Every posting helper asks this before posting, so the rule '
  'exists once; item 2b''s sweep posts what is ready and excludes never_*, and '
  'item 8''s reconciliation buckets by the reason. NOT granted to '
  'authenticated: it is called from inside the definer helpers.';

-- ############################################################################
-- SECTION 2 — THE THREE POSTING HELPERS ASK SECTION 1 INSTEAD
-- ############################################################################
-- Re-emitted from 062's and 063's text, each with its inline date check
-- replaced by one call. The behaviour that changes is in SECTION 1's four
-- further answers, and the three defects it closes are measured in the header.
CREATE OR REPLACE FUNCTION public.post_folio_charge_journal(p_charge_id uuid)
 RETURNS journal_entries
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  -- (062's inline decline stood here; SECTION 1 subsumes it.)
  -- 062 §1 SAID is_voided IS DELIBERATELY NOT READ HERE, on the grounds that a
  -- charge voided before a backfill reached it would never post and item 6's
  -- counter would then unwind something that was never on the books. THAT
  -- REASONING IS NOW SUPERSEDED, and by the very thing it was worried about:
  -- the void's counter waits for the charge's entry, so it cannot unwind what
  -- was never booked. With that risk gone, "what does the bill say" decides —
  -- a voided line is not on the bill, so nothing posts on either side.
  -- 062's sentence was true when it was written and is wrong now; it is called
  -- out here rather than left for somebody to find two files apart.

  -- 064: ONE QUESTION, ASKED IN ONE PLACE. The inline date check that used to
  -- stand here is gone: folio_posting_state answers it, and answers four more
  -- things with it (never_pre_gl, never_pre_wiring, never_voided,
  -- never_dependency / waiting_for_dependency). SECTION 1 holds the reasoning
  -- and the precedence.
  --
  -- WHY THE RULE MOVED OUT OF HERE. It was inline in two helpers and absent
  -- from the third, and "do not unwind or modify what was never booked" was
  -- nowhere at all — which is why three defects were reachable at once. A rule
  -- in two places is a rule that drifts; a rule in no place is a rule nobody
  -- wrote down.
  if folio_posting_state('folio_charge', p_charge_id) <> 'ready' then
    return null;
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
$function$
;

CREATE OR REPLACE FUNCTION public.post_folio_discount_journal(p_discount_id uuid)
 RETURNS journal_entries
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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


  -- 064: ONE QUESTION, ASKED IN ONE PLACE. The inline date check that used to
  -- stand here is gone: folio_posting_state answers it, and answers four more
  -- things with it (never_pre_gl, never_pre_wiring, never_voided,
  -- never_dependency / waiting_for_dependency). SECTION 1 holds the reasoning
  -- and the precedence.
  --
  -- WHY THE RULE MOVED OUT OF HERE. It was inline in two helpers and absent
  -- from the third, and "do not unwind or modify what was never booked" was
  -- nowhere at all — which is why three defects were reachable at once. A rule
  -- in two places is a rule that drifts; a rule in no place is a rule nobody
  -- wrote down.
  --
  -- A DISCOUNT IS A DEPENDENT DOCUMENT, which the first statement of the rule
  -- missed: it does not unwind an entry, it MODIFIES one, and a relief posted
  -- against revenue that was never booked is the same defect with a smaller
  -- number. Measured before this file: discounting the pre-wiring room charge
  -- posted discounts_allowed 5,000.00 Dr, vat_output 380.00 Dr and guest_ledger
  -- 5,380.00 Cr against a charge with no entry at all.
  if folio_posting_state('folio_charge_discount', p_discount_id) <> 'ready' then
    return null;
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
$function$
;

CREATE OR REPLACE FUNCTION public.post_folio_payment_journal(p_payment_id uuid)
 RETURNS journal_entries
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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


  -- 064: ONE QUESTION, ASKED IN ONE PLACE. The inline date check that used to
  -- stand here is gone: folio_posting_state answers it, and answers four more
  -- things with it (never_pre_gl, never_pre_wiring, never_voided,
  -- never_dependency / waiting_for_dependency). SECTION 1 holds the reasoning
  -- and the precedence.
  --
  -- WHY THE RULE MOVED OUT OF HERE. It was inline in two helpers and absent
  -- from the third, and "do not unwind or modify what was never booked" was
  -- nowhere at all — which is why three defects were reachable at once. A rule
  -- in two places is a rule that drifts; a rule in no place is a rule nobody
  -- wrote down.
  --
  -- THE PAYMENT HELPER HAD NO GATE AT ALL. record_payment refuses a forward
  -- date (063), so there was nothing to decline on that axis — but a payment
  -- can still be pre-wiring, or dated before gl_start_date, or voided before
  -- it reached the books, and this helper would have posted all three. It is
  -- asked FIRST, before the method whitelist: whether to post at all is a
  -- different question from where the money lands, and a pre-wiring payment
  -- with a retired method should decline quietly rather than refuse loudly.
  if folio_posting_state('folio_payment', p_payment_id) <> 'ready' then
    return null;
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
$function$
;

-- ############################################################################
-- SECTION 3 — THE TWO VOID DOCUMENT TYPES
-- ############################################################################
-- void_charge and void_payment set a flag and write no row, so a void has no
-- document of its own. It posts as ('folio_charge_void', <the charge's id>) —
-- a different TYPE on the same id, which post_journal's uniqueness on
-- (tenant, type, id) allows, and which keeps the void's entry findable from the
-- thing it voided without a new table.
--
-- ----------------------------------------------------------------------------
-- A VOID MIRRORS THE ENTRIES, NOT THE ROW. THIS IS THE DESIGN DECISION.
-- ----------------------------------------------------------------------------
-- The obvious implementation rebuilds the legs from the charge: gross at its
-- captured account, the discount, one leg per tax row, the receivable. It is
-- wrong, and wrong in the way that is hardest to see.
--
-- A charge's tax rows are DELETED AND RE-INSERTED by restate_charge_taxes every
-- time a discount is applied. So the row today may carry a different tax figure
-- than the entry posted. Rebuilding from the row would unwind a number the
-- books never contained, and the residue would be exactly the tax on every
-- discount ever given to that charge — 032's ₦2,480 arriving for a fourth time.
--
-- So the void sums, PER ACCOUNT, every entry that belongs to the charge — its
-- own, and each discount application's — and posts the mirror. It nets to zero
-- BY CONSTRUCTION rather than by arithmetic that has to be kept in step, and it
-- needs no open line because every leg comes out of the mirror.
--
-- IT MUST INCLUDE THE DISCOUNTS, which is the same grouping 061 §4 warned item
-- 8 about, used constructively this time. Voiding a charge takes its discount
-- and its tax off the bill as well — folio_totals filters the charge, so every
-- figure derived from it goes — so a void that unwound only the charge's own
-- entry would leave the relief standing in discounts_allowed forever.
--
-- AND A VOID NEVER POSTS FOR A DOCUMENT THAT WAS NEVER BOOKED. SECTION 1
-- answers that: the void's dependency is the charge, so a charge that is
-- never_pre_wiring or that declined and was then voided makes the void
-- never_dependency, and nothing posts on either side. What the bill says is the
-- test — a voided line is not on the bill, so the ledger records nothing.
create or replace function post_folio_charge_void_journal(p_charge_id uuid)
returns journal_entries
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_c        folio_charges;
  v_state    text;
  v_lines    jsonb;
  v_n        integer;
  v_reverses uuid;
  v_bdate    date;
  v_timezone text;
begin
  select * into v_c from folio_charges where id = p_charge_id;
  if not found then
    raise exception 'Folio charge % not found', p_charge_id
      using errcode = 'PT404';
  end if;
  if v_c.is_voided is not true then
    raise exception 'Charge % is not voided, so there is no void to post', p_charge_id
      using errcode = 'PT422',
            hint = 'Call this at the END of void_charge, after the flag is set.';
  end if;

  v_state := folio_posting_state('folio_charge_void', p_charge_id);
  if v_state <> 'ready' then
    -- posted, or one of the waiting_*/never_* answers. SECTION 1 holds the
    -- reasoning; item 2b reads the same answer to decide whether to come back.
    return null;
  end if;

  -- ---- the mirror, per account, over the charge AND its discounts ---------
  select coalesce(jsonb_agg(
           jsonb_build_object(
             'role_key',    m.role_key,
             'side',        case when m.net > 0 then 'credit' else 'debit' end,
             'amount',      abs(m.net),
             'description', 'Voided'
           ) order by m.role_key
         ) filter (where m.net <> 0), '[]'::jsonb),
         count(*) filter (where m.net <> 0)
    into v_lines, v_n
  from (
    select l.role_key, sum(l.debit - l.credit) net
    from journal_entry_lines l
    join journal_entries je on je.id = l.journal_entry_id
    where (je.source_document_type = 'folio_charge'
           and je.source_document_id = v_c.id)
       or (je.source_document_type = 'folio_charge_discount'
           and je.source_document_id in (
             select d.id from folio_charge_discounts d
             where d.folio_charge_id = v_c.id))
    group by l.role_key
  ) m;

  if v_n < 2 then
    -- Nothing in the books to unwind, or a single leg, which cannot balance.
    -- SECTION 1 should already have said never_dependency in the first case;
    -- this is the floor under it rather than a second opinion.
    return null;
  end if;

  select je.id into v_reverses
  from journal_entries je
  where je.tenant_id = v_c.tenant_id
    and je.source_document_type = 'folio_charge'
    and je.source_document_id   = v_c.id;

  select p.timezone into v_timezone from properties p where p.id = v_c.property_id;
  v_bdate := (v_c.voided_at at time zone
              coalesce(nullif(btrim(v_timezone), ''), 'Africa/Lagos'))::date;

  return post_journal(
    v_c.property_id,
    v_bdate,
    format('Charge voided — %s',
           coalesce(nullif(btrim(v_c.void_reason), ''),
                    nullif(btrim(v_c.description), ''), 'folio charge')),
    'folio_charge_void',
    v_c.id,
    v_lines,
    null,
    v_reverses
  );
end;
$function$;

revoke all on function post_folio_charge_void_journal(uuid) from public;
revoke all on function post_folio_charge_void_journal(uuid) from anon;
revoke all on function post_folio_charge_void_journal(uuid) from authenticated;

comment on function post_folio_charge_void_journal(uuid) is
  'Posts the counter-entry for a voided charge, as (folio_charge_void, the '
  'charge''s id). It MIRRORS THE ENTRIES rather than rebuilding from the row: a '
  'charge''s tax rows are deleted and re-inserted by restate_charge_taxes on '
  'every discount, so the row can carry a figure the books never held, and '
  'rebuilding would leave a residue of exactly the tax on every discount given. '
  'The mirror spans the charge''s own entry AND each discount application''s, '
  'because voiding a charge takes its discount off the bill too. Nets to zero '
  'by construction. Posts nothing when the charge was never booked.';

-- ----------------------------------------------------------------------------
-- A PAYMENT'S VOID, the same shape with one document fewer to gather: nothing
-- modifies a payment, so the mirror is its own entry alone.
-- ----------------------------------------------------------------------------
create or replace function post_folio_payment_void_journal(p_payment_id uuid)
returns journal_entries
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_p        folio_payments;
  v_state    text;
  v_lines    jsonb;
  v_n        integer;
  v_reverses uuid;
  v_bdate    date;
  v_timezone text;
begin
  select * into v_p from folio_payments where id = p_payment_id;
  if not found then
    raise exception 'Folio payment % not found', p_payment_id
      using errcode = 'PT404';
  end if;
  if v_p.is_voided is not true then
    raise exception 'Payment % is not voided, so there is no void to post', p_payment_id
      using errcode = 'PT422',
            hint = 'Call this at the END of void_payment, after the flag is set.';
  end if;

  v_state := folio_posting_state('folio_payment_void', p_payment_id);
  if v_state <> 'ready' then
    return null;
  end if;

  select coalesce(jsonb_agg(
           jsonb_build_object(
             'role_key',    m.role_key,
             'side',        case when m.net > 0 then 'credit' else 'debit' end,
             'amount',      abs(m.net),
             'description', 'Voided'
           ) order by m.role_key
         ) filter (where m.net <> 0), '[]'::jsonb),
         count(*) filter (where m.net <> 0)
    into v_lines, v_n
  from (
    select l.role_key, sum(l.debit - l.credit) net
    from journal_entry_lines l
    join journal_entries je on je.id = l.journal_entry_id
    where je.source_document_type = 'folio_payment'
      and je.source_document_id   = v_p.id
    group by l.role_key
  ) m;

  if v_n < 2 then
    return null;
  end if;

  select je.id into v_reverses
  from journal_entries je
  where je.tenant_id = v_p.tenant_id
    and je.source_document_type = 'folio_payment'
    and je.source_document_id   = v_p.id;

  select p.timezone into v_timezone from properties p where p.id = v_p.property_id;
  v_bdate := (v_p.voided_at at time zone
              coalesce(nullif(btrim(v_timezone), ''), 'Africa/Lagos'))::date;

  return post_journal(
    v_p.property_id,
    v_bdate,
    format('Payment voided — %s',
           coalesce(nullif(btrim(v_p.void_reason), ''), v_p.method)),
    'folio_payment_void',
    v_p.id,
    v_lines,
    null,
    v_reverses
  );
end;
$function$;

revoke all on function post_folio_payment_void_journal(uuid) from public;
revoke all on function post_folio_payment_void_journal(uuid) from anon;
revoke all on function post_folio_payment_void_journal(uuid) from authenticated;

comment on function post_folio_payment_void_journal(uuid) is
  'Posts the counter-entry for a voided payment, as (folio_payment_void, the '
  'payment''s id), mirroring the payment''s own entry per account so it nets to '
  'zero by construction. Dated the day the void happened, not the payment''s '
  'day. Posts nothing when the payment was never booked.';

-- ############################################################################
-- SECTION 4 — void_charge AND void_payment POST
-- ############################################################################
-- Neither signature changes, so neither is dropped and neither loses its ACL.
--
-- Both already refuse to void a REVERSED document ('Charge % has been reversed
-- and cannot also be voided') and to void a reversal line, so a void and a
-- reversal are mutually exclusive on one document and the two counter-entries
-- can never both exist for the same thing.
CREATE OR REPLACE FUNCTION public.void_charge(p_charge_id uuid, p_reason text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS folio_charges
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  -- 064: AND NOW THE VOID POSTS ITS COUNTER-ENTRY. After the flag is set, never
  -- before: the helper refuses a charge that is not voided, because a void with
  -- no void is a counter-entry for something that is still on the bill.
  --
  -- NOT ON THE ALREADY-VOIDED EARLY RETURN ABOVE. That path is the idempotent
  -- retry, and it returns a row somebody else voided — the same decision as
  -- every other replay path since 062. If that void's counter has not posted
  -- yet because the charge had not posted yet, item 2b's sweep is what comes
  -- back for it, not a second caller of this RPC.
  --
  -- perform, NOT an assignment: the helper returns NULL for a charge that was
  -- never in the books, which is the whole of item 6's ruling. A not-null check
  -- here would refuse to void a not-yet-due night at the front desk.
  perform post_folio_charge_void_journal(v_charge.id);

  return v_charge;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.void_payment(p_payment_id uuid, p_reason text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS folio_payments
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_payment folio_payments;
  v_folio   folios;
  v_actor   uuid := auth.uid();
begin
  select * into v_payment from folio_payments where id = p_payment_id for update;
  if not found then
    raise exception 'Payment % not found', p_payment_id using errcode = 'no_data_found';
  end if;

  if not is_tenant_staff(v_payment.tenant_id) then
    raise exception 'Not authorised to void payments for this tenant'
      using errcode = 'insufficient_privilege';
  end if;

  if v_payment.is_voided is true then
    return v_payment;
  end if;

  -- NEW (031 §4): a payment that has been REVERSED cannot also be voided — the
  -- counter-entry already took it out of the balance, and voiding the original
  -- on top of that would subtract the same money twice.
  if exists (
    select 1 from reversals r
    where r.tenant_id = v_payment.tenant_id
      and r.target_type = 'payment'
      and r.target_id = v_payment.id
  ) then
    raise exception 'Payment % has been reversed and cannot also be voided', p_payment_id
      using errcode = 'check_violation',
            hint = 'The reversal already removed it from the balance. Voiding it as well would subtract the same money twice.';
  end if;

  -- NEW (031 §4): a COUNTER-ENTRY cannot be voided either — that would silently
  -- un-reverse an approved reversal, with no PIN, no reason and no audit row,
  -- while the permanent reversals row still says the money went back.
  if v_payment.reversal_of_payment_id is not null then
    raise exception 'This line is a payment reversal and cannot be voided'
      using errcode = 'check_violation',
            hint = 'Voiding it would undo an approved reversal without a manager''s authorisation. Post a fresh payment instead.';
  end if;

  select * into v_folio from folios where id = v_payment.folio_id;
  if v_folio.status = 'closed' then
    raise exception 'Folio % is closed; its payments cannot be voided', v_folio.id
      using errcode = 'check_violation';
  end if;

  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'A void needs a reason' using errcode = 'check_violation';
  end if;

  update folio_payments
     set is_voided   = true,
         voided_at   = now(),
         voided_by   = v_actor,
         void_reason = btrim(p_reason),
         updated_by  = v_actor
   where id = p_payment_id
  returning * into v_payment;

  -- 064: and the payment's void posts the same way. See void_charge above for
  -- why it is after the flag, and why not on the already-voided early return.
  perform post_folio_payment_void_journal(v_payment.id);

  return v_payment;
end;
$function$
;

-- ############################################################################
-- SECTION 5 — THE SELF-VERIFY, ROLLED BACK
-- ############################################################################
-- Fourteen assertions. Three of them close defects that were LIVE before this
-- file, with the figures measured on this database.
--
--   1  THE CLASSIFIER PRODUCES ALL NINE STATES IT CLAIMS, from a real document
--      rather than from a contrived one. A state nothing can reach is a state
--      nobody can rely on, and a consumer that switches on it would have a
--      branch that never runs — the fifth way to write an assertion that
--      cannot fail.
--   2  FORM 1 CLOSED: reversing a not-yet-due night posts NOTHING on either
--      side. Before this file the counter posted alone: guest_ledger
--      -48,444.75, revenue 45,023.00 Dr, vat_output 3,421.75 Dr.
--   3  FORM 2 CLOSED: discounting a pre-wiring charge posts NOTHING. Before:
--      discounts_allowed 5,000.00 Dr, vat_output 380.00 Dr, guest_ledger
--      5,380.00 Cr, against a charge with no entry at all.
--   4  FORM 3 CLOSED: reversing a pre-wiring charge posts NOTHING. Before:
--      revenue_room 130,000.00 Dr, vat_output 9,500.00 Dr, guest_ledger
--      134,500.00 Cr — a whole stay reversed out of books it was never in.
--   5  A VOID OF A POSTED CHARGE POSTS ITS MIRROR, and the charge plus every
--      discount on it plus the void net to EXACTLY ZERO in every account.
--   6  AND THE MIRROR SPANS THE DISCOUNTS. A charge discounted twice and then
--      voided must leave discounts_allowed at zero. RED if the void unwinds
--      only the charge's own entry, which leaves the relief standing forever.
--   7  THE VOID IS DATED THE DAY IT HAPPENED, not the charge's day: a
--      correction belongs to the operating day somebody made it. The charge is
--      posted TWO DAYS BACK so the two dates differ — with a charge dated today
--      the assertion cannot tell them apart, and it first passed against a void
--      dated from the wrong column.
--   8  A VOID OF A DECLINED CHARGE POSTS NOTHING, and voiding still SUCCEEDS.
--      RED if the helper raises instead of declining — the front desk would
--      lose its one-click undo on a forward night.
--   9  A VOID OF A PAYMENT MIRRORS ITS ENTRY, and the pair nets to zero.
--  10  THE MIRROR IS BUILT FROM THE ENTRIES, NOT THE ROW. A charge discounted
--      after posting has tax rows that no longer match what was posted; the
--      void must still net to zero. RED if the legs are rebuilt from the row,
--      which leaves a residue of exactly the tax on every discount given.
--  11  NEITHER REPLAY POSTS. Voiding an already-voided document returns it and
--      adds no entry.
--  12  THE INVARIANT STILL HOLDS, on a folio carrying a posted charge, a
--      discount, a payment and a void: guest ledger equals folio_balance.
--  13  NO ROUNDING LINES in any folio entry.
--  14  THE SHAPE. The classifier and both new helpers SECURITY DEFINER with a
--      pinned search_path and ungranted to `authenticated`; void_charge and
--      void_payment still granted to authenticated and not to anon, since
--      neither signature changed.
do $$
declare
  v_tenant  uuid;
  v_user    uuid;
  v_prop    uuid;
  v_rt      uuid;
  v_guest   uuid;
  v_cat     uuid;
  v_folio   folios;
  v_a       folio_charges;
  v_b       folio_charges;
  v_pre     folio_charges;
  v_fwd     folio_charges;
  v_ctr     folio_charges;
  v_pay     folio_payments;
  v_bk      bookings;
  v_disc    uuid;
  v_e       uuid;
  v_st      text;
  v_n       integer;
  v_bad     integer;
  v_amt     numeric;
  v_amt2    numeric;
  v_bal     numeric;
  v_edate   date;
  v_prop2   uuid;
  v_folio2  folios;
  v_c2      folio_charges;
  v_c3      folio_charges;
  v_err     text;
  v_state   text;
  v_ok      boolean;
  v_fail    text := '';
  v_seen    text[] := '{}';
begin
  begin
    select tu.tenant_id, tu.user_id into v_tenant, v_user
    from tenant_users tu where tu.is_active and tu.role in ('owner','manager') limit 1;
    select p.id into v_prop from properties p where p.tenant_id = v_tenant limit 1;
    if v_tenant is null or v_prop is null then
      raise notice '064 SELF-VERIFY SKIPPED: no tenant or active owner/manager.';
      raise exception 'ZZ_064_FIXTURE_DONE';
    end if;
    perform set_config('request.jwt.claims',
      json_build_object('role','service_role','sub', v_user::text)::text, true);

    -- THIS OVERWRITES A REAL MANAGER'S PIN, and it is only safe because the
    -- ZZ_064_FIXTURE_DONE sentinel below guarantees this block rolls back — the
    -- raise is unconditional, so no path commits it. Anyone copying this
    -- pattern into something that COMMITS must use a throwaway user instead.
    insert into manager_pins (tenant_id, user_id, pin_hash)
    values (v_tenant, v_user, crypt('4064', gen_salt('bf')))
    on conflict (tenant_id, user_id) do update set pin_hash = excluded.pin_hash;

    select cc.id into v_cat from charge_categories cc
    where cc.tenant_id = v_tenant and cc.is_taxable and cc.deleted_at is null
      and cc.is_active and cc.code <> 'room'
    order by cc.code limit 1;
    select rt.id into v_rt from room_types rt
    where rt.tenant_id = v_tenant and rt.deleted_at is null
    order by rt.base_rate limit 1;
    if v_cat is null or v_rt is null then
      raise exception '064 SELF-VERIFY needs a taxable non-room category and a room type.';
    end if;

    -- a live PRE-WIRING charge, which is what makes forms 2 and 3 testable
    select fc.* into v_pre from folio_charges fc
    join folios f on f.id = fc.folio_id
    where f.status = 'open' and fc.reversal_of_charge_id is null
      and fc.is_voided is not true
      and not exists (select 1 from folio_charges r where r.reversal_of_charge_id = fc.id)
      and not exists (select 1 from journal_entries je
                      where je.source_document_type = 'folio_charge'
                        and je.source_document_id = fc.id)
    order by fc.created_at limit 1;
    if not found then
      raise exception '064 SELF-VERIFY needs a pre-wiring charge still open to action; forms 2 and 3 cannot be tested without one.';
    end if;

    -- the folio the posted-charge assertions use, opened here because the
    -- ready probe below needs somewhere to write a row.
    insert into guests (tenant_id, first_name, last_name, created_by)
    values (v_tenant, 'ZZ064', 'Voided', v_user) returning id into v_guest;
    v_folio := open_guest_folio(v_tenant, v_prop, v_guest, 'zz064-folio-1');

    -- ===================== 1: EVERY STATE IS REACHABLE =====================
    v_st := folio_posting_state('folio_charge', v_pre.id);
    if v_st <> 'never_pre_wiring' then
      v_fail := v_fail || format('1: the pre-wiring charge reads %s, expected never_pre_wiring. ', v_st);
    end if;
    v_seen := v_seen || v_st;

    v_st := folio_posting_state('folio_charge', gen_random_uuid());
    if v_st <> 'absent' then
      v_fail := v_fail || format('1: an unknown id reads %s, expected absent. ', v_st);
    end if;
    v_seen := v_seen || v_st;

    -- ---- never_pre_gl, ON A THROWAWAY PROPERTY -------------------------
    -- THE STATE THAT MATTERS MOST TO EXERCISE, and the hardest to reach:
    -- gl_start_date is deliberately null on Heledon until go-live, so on this
    -- database no document can be pre-GL. "ready" first runs the day 1.1h4b
    -- ships, with somebody watching. never_pre_gl first runs on GO-LIVE
    -- MORNING, when 5.5 sets that date — and a branch that first executes
    -- while a hotel is opening is a branch nobody has run.
    --
    -- A throwaway property closes it. Its AFTER INSERT triggers give it finance
    -- settings, seeded tax charges and a grant to the tenant's admins, so it
    -- behaves like a real one; gl_start_date is set by UPDATE rather than
    -- through update_property_finance_settings, whose "cannot move once the
    -- books have opened" guard is about a property that already has entries.
    insert into properties (tenant_id, name, slug, created_by)
    values (v_tenant, 'ZZ064 Throwaway', 'zz064-throwaway', v_user)
    returning id into v_prop2;
    update property_finance_settings set gl_start_date = current_date
     where property_id = v_prop2;

    insert into guests (tenant_id, first_name, last_name, created_by)
    values (v_tenant, 'ZZ064', 'Pre GL', v_user) returning id into v_guest;
    v_folio2 := open_guest_folio(v_tenant, v_prop2, v_guest, 'zz064-folio-pregl');
    -- the real case: a charge dated the day before the books opened
    v_c2 := post_charge(v_folio2.id, v_cat, 'ZZ064 the day before the books opened',
                        1, 9000, current_date - 1, 'zz064-charge-pregl', 'manual');
    v_st := folio_posting_state('folio_charge', v_c2.id);
    if v_st <> 'never_pre_gl' then
      v_fail := v_fail || format(
        '1: a charge dated before gl_start_date reads %s, expected never_pre_gl. ', v_st);
    end if;
    v_seen := v_seen || v_st;
    select count(*)::integer into v_n from journal_entries je
    where je.source_document_type = 'folio_charge' and je.source_document_id = v_c2.id;
    if v_n <> 0 then
      v_fail := v_fail || format(
        '1: a charge dated before gl_start_date posted %s entr(ies). It still belongs on the bill — the RPC must not refuse it — but the books opened after it. ', v_n);
    end if;

    -- ---- ready, AND THAT IT MEANS WHAT IT SAYS -------------------------
    -- A row written WITHOUT going through post_charge, so no posting call
    -- fired: past-dated, post-wiring, no dependency. That is exactly what
    -- 1.1h4b's sweep will find, and the only way to produce it here.
    insert into folio_charges (tenant_id, property_id, folio_id, charge_category_id,
                               description, quantity, unit_amount, gross_amount,
                               discount_amount, net_amount, charge_date, source,
                               account_role_key, created_by)
    select v_tenant, v_prop, v_folio.id, v_cat, 'ZZ064 written around the RPC',
           1, 1500, 1500, 0, 1500, current_date - 1, 'manual',
           cc.account_role_key, v_user
    from charge_categories cc where cc.id = v_cat
    returning * into v_c3;
    v_st := folio_posting_state('folio_charge', v_c3.id);
    if v_st <> 'ready' then
      v_fail := v_fail || format(
        '1: a past-dated charge with no entry reads %s, expected ready. ', v_st);
    end if;
    v_seen := v_seen || v_st;
    if post_folio_charge_journal(v_c3.id) is null then
      v_fail := v_fail ||
        '1: the helper posted nothing for a document it calls ready, so the state does not mean what it says. ';
    end if;
    if folio_posting_state('folio_charge', v_c3.id) <> 'posted' then
      v_fail := v_fail || '1: a document that just posted does not read posted. ';
    end if;

    -- ===================== 2: FORM 1, a not-yet-due night reversed =========
    insert into guests (tenant_id, first_name, last_name, created_by)
    values (v_tenant, 'ZZ064', 'Early Departure', v_user) returning id into v_guest;
    v_bk := create_booking(v_prop, v_rt, v_guest, current_date, current_date + 4,
                           1, 'zz064-bk-f', 0, null, 'guest', null, null);
    perform check_in_booking(v_bk.id, 'zz064-ci-f', now());
    perform check_out_booking(v_bk.id, 'zz064-co-f');
    select fc.* into v_fwd from folio_charges fc
    join folios f on f.id = fc.folio_id
    where f.booking_id = v_bk.id and fc.source = 'room' and fc.charge_date > current_date
    order by fc.charge_date limit 1;
    if not found then
      raise exception '064 SELF-VERIFY: the early checkout produced no forward-dated night.';
    end if;

    v_st := folio_posting_state('folio_charge', v_fwd.id);
    if v_st <> 'waiting_not_yet_due' then
      v_fail := v_fail || format('1: a forward night reads %s, expected waiting_not_yet_due. ', v_st);
    end if;
    v_seen := v_seen || v_st;

    perform reverse_charge(v_fwd.id, 'ZZ064 rest of the stay cancelled', '4064', 'zz064-rc-f');
    select * into v_ctr from folio_charges
    where reversal_of_charge_id = v_fwd.id order by created_at desc limit 1;
    v_st := folio_posting_state('folio_charge', v_ctr.id);
    if v_st <> 'waiting_for_dependency' then
      v_fail := v_fail || format(
        '1 / 2: the counter of a not-yet-due night reads %s, expected waiting_for_dependency. ', v_st);
    end if;
    v_seen := v_seen || v_st;

    select count(*)::integer into v_n from journal_entries je
    where je.source_document_type = 'folio_charge'
      and je.source_document_id in (v_fwd.id, v_ctr.id);
    if v_n <> 0 then
      select coalesce(sum(l.debit - l.credit), 0) into v_amt
      from journal_entry_lines l join journal_entries je on je.id = l.journal_entry_id
      where je.source_document_type = 'folio_charge'
        and je.source_document_id in (v_fwd.id, v_ctr.id)
        and l.role_key = 'guest_ledger';
      v_fail := v_fail || format(
        '2: reversing a not-yet-due night left %s entr(ies) and %s in the guest ledger. Before this file the counter posted ALONE at -48,444.75, debiting revenue that was never credited. ',
        v_n, v_amt);
    end if;

    -- ===================== 3: FORM 2, a pre-wiring charge discounted =======
    perform apply_charge_discount(v_pre.id, 5000, 'ZZ064 goodwill on a pre-wiring charge',
                                  '4064', 'zz064-k-pre');
    select d.id into v_disc from folio_charge_discounts d
    where d.folio_charge_id = v_pre.id order by d.seq desc limit 1;
    if v_disc is null then
      v_fail := v_fail || '3: the discount on a pre-wiring charge wrote no application row. ';
    else
      v_st := folio_posting_state('folio_charge_discount', v_disc);
      if v_st <> 'never_dependency' then
        v_fail := v_fail || format(
          '1 / 3: an application on a pre-wiring charge reads %s, expected never_dependency. ', v_st);
      end if;
      v_seen := v_seen || v_st;
      select count(*)::integer into v_n from journal_entries je
      where je.source_document_type = 'folio_charge_discount' and je.source_document_id = v_disc;
      if v_n <> 0 then
        v_fail := v_fail || format(
          '3: discounting a pre-wiring charge posted %s entr(ies). Before this file it posted discounts_allowed 5,000.00 Dr, vat_output 380.00 Dr and guest_ledger 5,380.00 Cr against a charge with no entry at all. ',
          v_n);
      end if;
    end if;

    -- ===================== 4: FORM 3, a pre-wiring charge reversed =========
    perform reverse_charge(v_pre.id, 'ZZ064 reversing a pre-wiring charge', '4064', 'zz064-rc-pre');
    select * into v_ctr from folio_charges
    where reversal_of_charge_id = v_pre.id order by created_at desc limit 1;
    v_st := folio_posting_state('folio_charge', v_ctr.id);
    if v_st <> 'never_dependency' then
      v_fail := v_fail || format(
        '1 / 4: the counter of a pre-wiring charge reads %s, expected never_dependency. ', v_st);
    end if;
    select count(*)::integer into v_n from journal_entries je
    where je.source_document_type = 'folio_charge' and je.source_document_id = v_ctr.id;
    if v_n <> 0 then
      v_fail := v_fail || format(
        '4: reversing a pre-wiring charge posted %s entr(ies). Before this file it posted revenue_room 130,000.00 Dr, vat_output 9,500.00 Dr and guest_ledger 134,500.00 Cr — a whole stay reversed out of books it was never in. ',
        v_n);
    end if;

    -- ===================== 5, 6, 7, 10: A VOID OF A POSTED CHARGE ==========
    -- DATED TWO DAYS BACK, deliberately. The void is dated the day it HAPPENS
    -- (today), so a charge dated today would make the two coincide and
    -- assertion 7 could not tell "the day of the void" from "the day of the
    -- charge" — rule 27's fourth shape, which is exactly how it first passed
    -- against a void dated from the wrong column.
    v_a := post_charge(v_folio.id, v_cat, 'ZZ064 dinner', 1, 20000, current_date - 2,
                       'zz064-charge-1', 'manual');
    v_st := folio_posting_state('folio_charge', v_a.id);
    if v_st <> 'posted' then
      v_fail := v_fail || format('1: a freshly posted charge reads %s, expected posted. ', v_st);
    end if;
    v_seen := v_seen || v_st;

    -- discounted TWICE AFTER posting, so its tax rows no longer match what the
    -- charge's own entry carried. That is what makes assertions 6 and 10 able
    -- to fail: a void rebuilt from the row would unwind the restated figure.
    perform apply_charge_discount(v_a.id, 1000, 'ZZ064 goodwill', '4064', 'zz064-k1');
    perform apply_charge_discount(v_a.id, 2500, 'ZZ064 more goodwill', '4064', 'zz064-k2');
    select coalesce(sum(t.amount), 0) into v_amt
    from folio_charge_tax_lines t where t.folio_charge_id = v_a.id;
    select coalesce(-sum(l.debit - l.credit), 0) into v_amt2
    from journal_entry_lines l join journal_entries je on je.id = l.journal_entry_id
    where je.source_document_type = 'folio_charge' and je.source_document_id = v_a.id
      and l.role_key = 'vat_output';
    if v_amt = v_amt2 then
      raise exception
        '064 SELF-VERIFY: the charge''s tax row (%) still equals what its entry posted (%), so assertions 6 and 10 cannot distinguish a mirror of the ENTRIES from a rebuild of the ROW.',
        v_amt, v_amt2;
    end if;

    perform void_charge(v_a.id, 'ZZ064 keyed against the wrong room', 'zz064-vc-1');
    select je.id into v_e from journal_entries je
    where je.source_document_type = 'folio_charge_void' and je.source_document_id = v_a.id;
    if v_e is null then
      v_fail := v_fail || '5: voiding a posted charge posted no counter-entry. ';
    else
      -- 7: dated the day of the void
      select je.entry_date into v_edate from journal_entries je where je.id = v_e;
      if v_edate is distinct from current_date then
        v_fail := v_fail || format(
          '7: the void entry is dated %s, expected today. A correction belongs to the operating day somebody made it, not to the charge''s day. ', v_edate);
      end if;
      -- 5, 6, 10: EVERY account nets to zero across the charge, its two
      -- discount applications and the void
      select count(*)::integer into v_bad
      from (
        select l.role_key, sum(l.debit - l.credit) net
        from journal_entry_lines l join journal_entries je on je.id = l.journal_entry_id
        where (je.source_document_type = 'folio_charge' and je.source_document_id = v_a.id)
           or (je.source_document_type = 'folio_charge_void' and je.source_document_id = v_a.id)
           or (je.source_document_type = 'folio_charge_discount'
               and je.source_document_id in (select d.id from folio_charge_discounts d
                                             where d.folio_charge_id = v_a.id))
        group by l.role_key having sum(l.debit - l.credit) <> 0
      ) r;
      if v_bad > 0 then
        select string_agg(format('%s %s', r.role_key, r.net), ', ') into v_err
        from (
          select l.role_key, sum(l.debit - l.credit) net
          from journal_entry_lines l join journal_entries je on je.id = l.journal_entry_id
          where (je.source_document_type = 'folio_charge' and je.source_document_id = v_a.id)
             or (je.source_document_type = 'folio_charge_void' and je.source_document_id = v_a.id)
             or (je.source_document_type = 'folio_charge_discount'
                 and je.source_document_id in (select d.id from folio_charge_discounts d
                                               where d.folio_charge_id = v_a.id))
          group by l.role_key having sum(l.debit - l.credit) <> 0
        ) r;
        v_fail := v_fail || format(
          '5 / 6 / 10: a charge, its two discount applications and its void left a residue in %s account(s): %s. A void that unwinds only the charge''s own entry leaves the relief standing in discounts_allowed; a void rebuilt from the ROW unwinds a tax figure the books never held. ',
          v_bad, v_err);
      end if;
      -- 6, pointedly: discounts_allowed back to nothing
      select coalesce(sum(l.debit - l.credit), 0) into v_amt
      from journal_entry_lines l join journal_entries je on je.id = l.journal_entry_id
      where l.role_key = 'discounts_allowed'
        and ((je.source_document_type = 'folio_charge' and je.source_document_id = v_a.id)
          or (je.source_document_type = 'folio_charge_void' and je.source_document_id = v_a.id)
          or (je.source_document_type = 'folio_charge_discount'
              and je.source_document_id in (select d.id from folio_charge_discounts d
                                            where d.folio_charge_id = v_a.id)));
      if v_amt <> 0 then
        v_fail := v_fail || format(
          '6: discounts_allowed stands at %s after the void. Voiding a charge takes its discount off the bill too, so the relief has to come back. ', v_amt);
      end if;
    end if;

    -- ===================== 8: A VOID OF A DECLINED CHARGE =================
    select fc.* into v_b from folio_charges fc
    join folios f on f.id = fc.folio_id
    where f.booking_id = v_bk.id and fc.source = 'room' and fc.charge_date > current_date
      and not exists (select 1 from folio_charges r where r.reversal_of_charge_id = fc.id)
    order by fc.charge_date desc limit 1;
    if not found then
      v_fail := v_fail || '8: no second forward night left to void. ';
    else
      begin
        perform void_charge(v_b.id, 'ZZ064 voided before its night', 'zz064-vc-2');
      exception when others then
        v_fail := v_fail || format(
          '8: voiding a not-yet-due night was REFUSED by %s / %s. The front desk keeps its one-click undo; the helper declines, it does not raise. ',
          sqlstate, sqlerrm);
      end;
      v_st := folio_posting_state('folio_charge', v_b.id);
      if v_st <> 'never_voided' then
        v_fail := v_fail || format('1 / 8: a night voided before its day reads %s, expected never_voided. ', v_st);
      end if;
      v_seen := v_seen || v_st;
      v_st := folio_posting_state('folio_charge_void', v_b.id);
      if v_st <> 'never_dependency' then
        v_fail := v_fail || format('1 / 8: the void of a never-posted night reads %s, expected never_dependency. ', v_st);
      end if;
      select count(*)::integer into v_n from journal_entries je
      where je.source_document_id = v_b.id
        and je.source_document_type in ('folio_charge','folio_charge_void');
      if v_n <> 0 then
        v_fail := v_fail || format(
          '8: a night voided before its day left %s entr(ies). A voided line is not on the bill, so the ledger records nothing. ', v_n);
      end if;
    end if;

    -- ===================== 9: A VOID OF A PAYMENT =========================
    v_pay := record_payment(v_folio.id, 7000, 'cash', 'ZZ064 settlement',
                            current_date, 'zz064-pay-1');
    perform void_payment(v_pay.id, 'ZZ064 wrong guest', 'zz064-vp-1');
    select je.id into v_e from journal_entries je
    where je.source_document_type = 'folio_payment_void' and je.source_document_id = v_pay.id;
    if v_e is null then
      v_fail := v_fail || '9: voiding a posted payment posted no counter-entry. ';
    else
      select count(*)::integer into v_bad
      from (
        select l.role_key, sum(l.debit - l.credit) net
        from journal_entry_lines l join journal_entries je on je.id = l.journal_entry_id
        where je.source_document_id = v_pay.id
          and je.source_document_type in ('folio_payment','folio_payment_void')
        group by l.role_key having sum(l.debit - l.credit) <> 0
      ) r;
      if v_bad > 0 then
        v_fail := v_fail || format(
          '9: a payment and its void left a residue in %s account(s). ', v_bad);
      end if;
      select coalesce(sum(l.debit - l.credit), 0) into v_amt
      from journal_entry_lines l where l.journal_entry_id = v_e and l.role_key = 'cash';
      if v_amt is distinct from -7000.00 then
        v_fail := v_fail || format('9: the payment void put %s into cash, expected -7000.00. ', v_amt);
      end if;
    end if;

    -- ===================== 11: NEITHER REPLAY POSTS =======================
    select count(*)::integer into v_n from journal_entries;
    perform void_charge(v_a.id, 'ZZ064 again', 'zz064-vc-1b');
    perform void_payment(v_pay.id, 'ZZ064 again', 'zz064-vp-1b');
    select count(*)::integer into v_bad from journal_entries;
    if v_bad <> v_n then
      v_fail := v_fail || format('11: voiding an already-voided document added %s entr(ies). ', v_bad - v_n);
    end if;

    -- ===================== 12: THE INVARIANT ==============================
    select coalesce(sum(l.debit - l.credit), 0) into v_amt
    from journal_entry_lines l
    join journal_entries je on je.id = l.journal_entry_id
    where l.role_key = 'guest_ledger'
      and ((je.source_document_type in ('folio_charge','folio_charge_void')
            and je.source_document_id in (select id from folio_charges where folio_id = v_folio.id))
        or (je.source_document_type in ('folio_payment','folio_payment_void')
            and je.source_document_id in (select id from folio_payments where folio_id = v_folio.id))
        or (je.source_document_type = 'folio_charge_discount'
            and je.source_document_id in (
              select d.id from folio_charge_discounts d
              join folio_charges c on c.id = d.folio_charge_id
              where c.folio_id = v_folio.id)));
    v_bal := folio_balance(v_folio.id);
    if v_amt is distinct from v_bal then
      v_fail := v_fail || format(
        '12: the guest ledger nets %s over this folio''s entries while folio_balance reads %s. Both the charge and the payment were voided, so folio_totals drops them and the ledger must have unwound them. ',
        v_amt, v_bal);
    end if;

    -- ===================== 13: NO ROUNDING LINES ==========================
    select count(*)::integer into v_bad
    from journal_entry_lines l
    where l.role_key = 'rounding_difference'
      and l.journal_entry_id in (select je.id from journal_entries je
        where je.source_document_type like 'folio%');
    if v_bad > 0 then
      v_fail := v_fail || format(
        '13: %s rounding_difference line(s) in folio entries. The void mirrors what was posted, so it cannot need one — a rounding line here means the mirror was rebuilt rather than read. ', v_bad);
    end if;

    -- ===================== 1 again: EVERY STATE WAS SEEN ==================
    -- A state nothing can reach is a state nobody can rely on, so ALL NINE are
    -- produced by a real document above — including the two that took work:
    -- never_pre_gl, on a throwaway property with gl_start_date set, and ready,
    -- on a row written around the RPC so no posting call fired.
    foreach v_st in array array['posted','ready','absent','never_pre_gl','never_pre_wiring',
                               'never_voided','never_dependency','waiting_not_yet_due',
                               'waiting_for_dependency']
    loop
      if not (v_st = any(v_seen)) then
        v_fail := v_fail || format(
          '1: no document in this fixture reached the state %s, so nothing proves it is reachable. ', v_st);
      end if;
    end loop;

    v_ok := false; v_err := null; v_state := null;
    begin
      perform folio_posting_state('folio_nonsense', gen_random_uuid());
      v_ok := true;
    exception when others then v_err := sqlerrm; v_state := sqlstate; end;
    if v_ok or v_state is distinct from 'PT422'
       or v_err not like '%Unknown folio document type%' then
      v_fail := v_fail || format(
        '1: an unknown document type was answered by %s / %s. It must refuse by name rather than return a state that reads like a decision. ',
        coalesce(v_state, 'a returned state'), coalesce(v_err, '(no error)'));
    end if;

    -- ===================== 14: THE SHAPE ==================================
    select count(*)::integer into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('folio_posting_state','post_folio_charge_void_journal',
                        'post_folio_payment_void_journal')
      and (not p.prosecdef
           or p.proconfig is null
           or not exists (select 1 from unnest(p.proconfig) cfg where cfg like 'search_path=public%')
           or has_function_privilege('authenticated', p.oid, 'EXECUTE'));
    if v_bad > 0 then
      v_fail := v_fail || format(
        '14: %s of the classifier and the two void helpers lost SECURITY DEFINER, lost its pinned search_path, or became executable by `authenticated`. ', v_bad);
    end if;
    select count(*)::integer into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('void_charge','void_payment')
      and (not has_function_privilege('authenticated', p.oid, 'EXECUTE')
           or has_function_privilege('anon', p.oid, 'EXECUTE'));
    if v_bad > 0 then
      v_fail := v_fail || format(
        '14: %s of void_charge / void_payment is not executable by authenticated, or IS by anon. Neither signature changed, so neither should have lost its ACL. ', v_bad);
    end if;

    if v_fail <> '' then
      raise exception '064 SELF-VERIFY FAILED — %', v_fail;
    end if;

    raise notice '064 SELF-VERIFY: 14 assertions passed (all nine states reached).';
    raise exception 'ZZ_064_FIXTURE_DONE';
  exception
    when others then
      if sqlerrm = 'ZZ_064_FIXTURE_DONE' then
        raise notice '064 self-verify complete; fixture rolled back.';
      else
        raise;
      end if;
  end;
end $$;
