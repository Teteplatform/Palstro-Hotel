-- ============================================================================
-- 066  THE FOLIO RECONCILES TO THE BOOKS
-- ============================================================================
-- 1.1h4 item 8, and the last of the wiring. 061 built the three posting
-- helpers, 062 to 065 wired every path that writes a folio document, and this
-- is the check that makes all of it worth having (rule 9):
--
--     THE GUEST'S BALANCE ON THE BILL === THE GUEST'S BALANCE IN THE JOURNAL,
--     TO THE KOBO, FOR EVERY FOLIO, ALWAYS
--
-- less what legitimately has not reached the books yet, named bucket by bucket
-- rather than tolerated.
--
-- FOUR FUNCTIONS, in two pairs:
--
--   SECTION 1  folio_totals_by_folio    — the balance arithmetic for a whole
--                                          property in one query
--   SECTION 2  folio_posting_states     — 064's nine states for a whole
--                                          property in one query
--   SECTION 3  folio_gl_reconciliation_folios — the invariant, PER FOLIO
--              folio_gl_reconciliation        — the headline, summed from it
--   SECTION 4  the self-verify: 18 assertions, rolled back; 20 breakages
--
-- Nothing already in the database changes. Not folio_totals, not
-- folio_posting_state, not a posting helper, not an RPC. 066 only adds, and
-- SECTION 4's assertions 10, 11 and 12 are there to prove it did.
--
-- ----------------------------------------------------------------------------
-- WHY THE SET-WISE PAIR EXISTS, AND WHAT IT COST TO FIND OUT
-- ----------------------------------------------------------------------------
-- The reconciliation needs the state of every folio document and the balance of
-- every folio at a property. Both already existed for ONE document and ONE
-- folio. The first build simply called them in a loop.
--
-- HOW IT WAS MEASURED, stated because a performance figure with no method is a
-- number somebody quotes later without knowing what it covered: a generated
-- year of trading on one property — 4,000 folios, 12,600 charges, 4,000
-- payments, 1,200 discounts, 95% posted, 17,800 documents — inside one
-- transaction that rolls back, every table ANALYZEd first, each figure timed
-- SERVER-SIDE with clock_timestamp() inside a plpgsql loop rather than from the
-- client, evaluation forced with count(distinct ...), and reported as the
-- MEDIAN OF FIVE with the spread beside it.
--
-- Every one of those precautions was bought with a wrong reading first:
--
--   * Three readings of the same query came back 9,607 ms, 188 ms and 162 ms.
--     That is contention on a shared instance, not a change in the query. A
--     timing here is a DISTRIBUTION, not a number.
--   * One reading said 17,800 plpgsql calls took 5 ms. That is 0.3 microseconds
--     each, which is not a thing — the planner had ELIDED the STABLE function
--     because count(*) never read its column. WHEN A NUMBER IS IMPLAUSIBLY
--     GOOD, SUSPECT THE HARNESS BEFORE CELEBRATING.
--   * A hypothesis that stale statistics explained the cost was tested and was
--     wrong: 162 ms before ANALYZE, 141 ms after.
--   * And a cleverer query shape was nearly built on the strength of one
--     contended reading. The naive join turned out to be 21 ms and the clever
--     one 69 ms. PREFER THE SIMPLE SHAPE UNLESS A SOUND MEASUREMENT SAYS
--     OTHERWISE.
--
-- Both of those lessons are now in CLAUDE.md beside rule 27, because they are
-- the same rule as an assertion that cannot fail: a measurement that cannot
-- distinguish working from absent is not a measurement.
--
-- WHAT IT SAID. Everything below is a measured median, not a derivation:
--
--     at 2,000 folios
--       folio_posting_state, 1,000 calls in a loop      790 ms  (0.79 ms each)
--       folio_totals, 2,000 calls in a loop             115 ms  (0.06 ms each)
--       folio_posting_states, the WHOLE property         48 ms   — one call
--       folio_totals_by_folio, the WHOLE property        25 ms   — one call
--
--     at 4,000 folios / 17,800 documents (a year of trading)
--       folio_posting_state, once per document       20,264 ms
--
-- So the set-wise forms are not a refinement. They are the difference between a
-- report somebody opens at 7am and one they do not.
--
-- ----------------------------------------------------------------------------
-- AND THE PART THAT WAS BUILT, MEASURED AND THROWN AWAY
-- ----------------------------------------------------------------------------
-- The plan — approved, and right on its face — was to re-emit folio_totals and
-- folio_posting_state as thin filters over the set-wise forms, so each rule
-- would exist exactly once. That was built, including three successive fixes to
-- keep the filtered path indexed (a sargable folio join, an indexed `exists`
-- instead of a property-wide CTE, two prunable branches instead of an OR).
--
-- Then it was measured, side by side, in one transaction:
--
--     folio_posting_state, per call     064's own  0.79 ms   as a filter  14.14 ms
--     folio_totals, per folio           021's own  0.06 ms   as a filter  11.10 ms
--
-- 18x and 193x WORSE, on the two paths that can least afford it: 064's posting
-- helpers call the classifier on every charge, every discount and every payment
-- as they post, and folio_totals is on every folio screen. The three fixes
-- moved it from 10.9 ms to 14.1 ms without changing the shape of the problem,
-- which is the signal that the cost was structural rather than a plan — a
-- five-branch union over five tables, materialised and then discarded down to
-- one row.
--
-- A COST THAT GROWS WITH TRADING, PAID AT THE FRONT DESK, IS THE WORST PLACE IN
-- THIS PRODUCT TO PUT ONE. So the re-emission was reverted and the single-
-- document forms are untouched.
--
-- WHICH LEAVES TWO IMPLEMENTATIONS OF EACH RULE, AND THAT IS THE DECISION.
-- What makes it honest rather than the drift risk this very shipment filed
-- 1.1h2a against on the stock side:
--
--   * One of each pair is the AUTHORITY and is named as such in its comment.
--     021's folio_totals and 064's folio_posting_state are what the product
--     writes and screens against; the set-wise forms are bulk readers.
--   * The pair is PINNED, not sampled. Assertion 1 compares all seven balance
--     columns on every live folio; assertion 3 compares the state of every
--     live document at the property.
--   * AND THE PIN IS NOT CONTINUOUS, WHICH HAS TO BE SAID PLAINLY BECAUSE THE
--     WHOLE JUSTIFICATION RESTS ON IT. The reconciliation does NOT compute both
--     implementations when it runs: SECTION 3 calls folio_posting_states and
--     folio_totals_by_folio and never calls folio_posting_state or
--     folio_totals. It cannot, and the reason is the measurement above —
--     pinning the classifier per document IS the 20-second path this file
--     exists to avoid, so an inline pin would reinstate the cost through the
--     back door, on the one report somebody opens when something is already
--     wrong.
--
--     So: these assertions are true ON APPLY DAY, and nothing watches the pair
--     afterwards. THE ANSWER IS A SCHEDULED CHECK, NOT AN INLINE ONE — a deep
--     check that compares both implementations across a property and reports
--     any disagreement, run on the same monthly slot as the restore test.
--     Expensive proof on a schedule rather than inline is a pattern this repo
--     already has and already trusts, and it is the shape the stock pair should
--     take too, so one answer covers both (1.1h2a's note carries it).
--     UNTIL THAT SHIPS, THIS PAIR IS IN EXACTLY THE POSITION 1.1h2a DESCRIBES.
--
-- The stock side's pair still has less than that: inventory_gl_reconciliation
-- and inventory_gl_reconciliation_positions are two independent queries over
-- the same movements, neither is named the authority, and nothing has EVER
-- compared them, not even once. No figure is wrong there today, which is why it
-- is a tracker line rather than a fix inside a money shipment. But the
-- difference between the two pairs is now one of degree and a date, not of
-- kind, and saying otherwise would be the reassuring half of a rule 28 comment.
--
-- ----------------------------------------------------------------------------
-- AND WHAT THE RECONCILIATION ITSELF COSTS, WHICH TOOK TWO FIXES TO FIND OUT
-- ----------------------------------------------------------------------------
-- Measured the same way, on the same generated year:
--
--     folio_gl_reconciliation_folios, 4,000 folios      768 ms
--     folio_gl_reconciliation (the headline)            760 ms
--     its two inputs, for scale                45 ms and 86 ms
--
-- It did not start there. The first build DID NOT FINISH inside a fifteen-
-- minute statement timeout at 4,000 folios, and the two defects behind that are
-- both worth the lines they take, because neither was visible by reading:
--
--   1. `chgl` — what a void unwinds — ran for EVERY charge at the property with
--      a LATERAL over a materialised CTE. Branch 4 only ever asks about VOIDED
--      charges, so it now runs for those, aggregated once. 15 min -> 13 s.
--   2. Three branches asked "is this counter's original in the books?" by
--      SELF-JOINING folio_posting_states' result. A materialised CTE has no
--      index, so the planner answered with a CTE Scan per outer row: 5,402
--      loops over 8,900 rows, three times. SECTION 2 now RETURNS the
--      dependency's state as a column. 13 s -> 277 ms at 2,000 folios.
--
-- The plan is what found both. The clock said "slow"; only `loops 5402` beside
-- a CTE Scan said WHY, and neither fix is one a reading of the SQL suggests.
--
-- ----------------------------------------------------------------------------
-- THE BREAKAGE RUN: 20 mutations, 18 RED, 2 GREEN ON PURPOSE
-- ----------------------------------------------------------------------------
-- Rule 22 and rule 27: an assertion is not trusted until a plausible defect has
-- been seen to turn it red. Each line is valid SQL that changes behaviour, run
-- in its own rolled-back transaction. The mutation -> the assertion that caught
-- it:
--
--   A   the discount formula drops its tax term                      -> 13
--   B   the discount formula differences the roundings               -> 13
--   C   an unposted discount is counted though its charge never
--       posted, so the relief is double-counted                     -> 14, 15
--   D   a charge outside the books is bucketed without its tax       -> 14, 15
--   E   branch 4's "the original posted" condition is deleted        -> GREEN
--   F   the dependency bucket is dropped from expected_balance       -> 15, 16
--   G   the waiting bucket is dropped from expected_balance          -> 15, 16
--   H   unclassified is hardcoded to zero                            -> GREEN
--   H2  'ready' falls out of the bucketed list, so it lands in
--       unclassified instead                                        -> 15
--   I   the breakdown is not ordered worst-first                     -> 16
--   J   the worst folio is picked by raw value, not magnitude        -> 16
--   K   the account side is rolled up from the folios instead of
--       read from the account                                        -> 17
--   L   the account side is restricted to folio source documents     -> 17
--   M   3.1 loses its is_tenant_staff gate                           -> 18
--   N   the bulk balance reader forgets to subtract payments         -> 1, 13, 15
--   O   the bulk balance reader includes voided charges              -> 1, 15, 16
--   P   the set-wise classifier treats a never-posting dependency
--       as merely waiting                                            -> 3, 7
--   Q   the bulk balance reader stops scoping a named folio to
--       its property                                                 -> 2
--   R   depends_on_state always says 'posted'                        -> 3, 14, 15
--   S   depends_on_state is always null, so nothing is bucketed      -> 3, 14, 15
--
-- THE TWO GREENS ARE REPORTED RATHER THAN HIDDEN, because what they mean is
-- the useful part:
--
--   * E is green because the condition is BELT-AND-BRACES. When the original
--     never posted there are no entries to mirror, so the branch contributes
--     zero whether the condition is there or not. It is kept for what it says,
--     and the comment on branch 4 now says so.
--   * H is green because `unclassified` is UNREACHABLE BY CONSTRUCTION today —
--     every state a document can hold is either 'posted' (excluded) or one of
--     the six bucketed, and never_voided and absent cannot carry money through
--     any branch. H2 is the mutation that proves the alarm FIRES: move a state
--     out of the bucketed list and the figure appears and the invariant goes
--     red. So the column is tested; what is untestable is the tenth state
--     nobody has added yet.
--
-- FIVE ASSERTIONS WERE THE BROKEN THING RATHER THAN THE CODE, which is the
-- sixth time that has happened in this family of shipments and is why rule 27
-- keeps growing:
--
--   * 13 carried its OWN copy of the discount formula and compared that to the
--     entry, so breaking the function's copy changed nothing it looked at
--     (rule 27's FIRST shape). It now reads the figure out of the function, as
--     a bucket, against the entry the helper wrote for an arithmetical twin.
--   * 13's fixture used 8,000 with 1,500 off, where round-then-difference and
--     difference-then-round give the SAME number (rule 27's FOURTH shape). It
--     is now 1,000 with 1.25 off, where they differ by a kobo — and the
--     assertion re-checks that they still differ, so a changed VAT rate reports
--     itself instead of quietly disarming the test.
--   * 3 ran before the fixture reached never_dependency, so the comparison it
--     exists for had nothing to compare (rule 27's THIRD shape). It now runs
--     last, over both properties, and asserts 8 distinct states are present.
--   * 16 asked that one named folio came back first, and stayed green when the
--     ordering was replaced by opened_at — because every folio this fixture
--     opens shares one opened_at, `now()` being transaction start time. It now
--     asserts MONOTONICITY, which is the actual contract.
--   * 1 compared the balance pair on LIVE folios only, which have no payments
--     at all, so a bulk reader that forgot payments entirely passed. It is now
--     repeated after the fixture, which has them.
--
-- ----------------------------------------------------------------------------
-- PER FOLIO, NOT PER PROPERTY
-- ----------------------------------------------------------------------------
-- The reconciliation is stated FOR EVERY FOLIO and the headline is a sum over
-- those rows. The full argument is in SECTION 3; the short form is that a
-- property-level figure tells a duty manager at 7am that something is wrong,
-- and a folio-level one tells them which bill to open — and that a property
-- total can be green while two folios are wrong in opposite directions, which
-- is rule 27's second shape one layer up.
--
-- ZERO TOLERANCE. No epsilon, no "within a kobo". Stated as a decision in
-- SECTION 3 so it cannot later be read as an oversight.
--
-- ----------------------------------------------------------------------------
-- LINEAGE
-- ----------------------------------------------------------------------------
--   021  folio_totals, folio_balance — the balance arithmetic this reads
--   028  folios gained guest_id and a nullable booking_id, so a folio's label
--        is a booking number OR a guest's name
--   044  post_journal, journal_entry_lines.role_key — the ledger spine
--   046  one posting helper per document type, called inside the RPC
--   047  pre_gl and pre_wiring as BUCKETS rather than tolerances, and the count
--        beside the figure; this file follows both
--   051  a reconciliation is SECURITY DEFINER with an explicit is_tenant_staff
--        gate, and losing either reports a perfect zero
--   058  folio_charge_tax_lines, which capture the rate
--   060  a discount is an event: folio_charge_discounts
--   061  the three posting helpers and the guest_ledger leg
--   062  the charge wiring, folio_gl_wired_at
--   063  discounts and payments post
--   064  folio_posting_state and its nine states; voids mirror the ENTRIES
--   065  every reversal path reconciles, and a counter cannot be reversed
-- ============================================================================

-- ############################################################################
-- SECTION 1 — THE FOLIO'S BALANCE ARITHMETIC, SET-WISE, ONCE
-- ############################################################################
-- folio_totals_by_folio holds it for a whole property at once. 021's
-- folio_totals stays exactly as it is and stays the authority — the plan to
-- re-emit it over this was built, measured, and reverted, and the figures and
-- the reasoning are below the function rather than in a commit message.
--
-- WHY IT HAS TO BE SET-WISE: item 8's reconciliation needs the balance of every
-- folio at a property, and calling folio_totals in a loop is a function call per
-- folio. Measured at 2,000 folios, server-side, median of five: 25 ms for the
-- whole property against 115 ms for the loop — and the gap widens with the
-- folio count, because the loop pays per folio and this pays per property.
--
-- WHY IT CANNOT BE A SECOND COPY OF THE ARITHMETIC: the reconciliation's whole
-- claim is that the ledger agrees with the folio. If it computed the folio side
-- from its own expression, a drift between that expression and folio_totals
-- would read as a ledger difference — the reconciliation would report the one
-- thing it exists to disprove, and be wrong.
create or replace function folio_totals_by_folio(p_property_id uuid,
                                                 p_folio_id uuid default null)
returns table (
  folio_id       uuid,
  gross_total    numeric(14,2),
  discount_total numeric(14,2),
  net_total      numeric(14,2),
  tax_total      numeric(14,2),
  charges_total  numeric(14,2),
  payments_total numeric(14,2),
  balance        numeric(14,2)
)
language sql
stable
security definer
set search_path to 'public'
as $function$
  with f as (
    -- TWO MUTUALLY EXCLUSIVE BRANCHES, not one OR. `p_folio_id is null` is a
    -- constant to the planner, so it prunes the branch that cannot run and the
    -- surviving one is an index scan — on the primary key when a folio is
    -- named, on property_id when it is not. With the OR it had to read every
    -- folio at the property and filter to one, which is what kept the
    -- single-document path slow after the first two fixes.
    select fl.id from folios fl
    where p_folio_id is not null and fl.id = p_folio_id
      and fl.property_id = p_property_id
    union all
    select fl.id from folios fl
    where p_folio_id is null and fl.property_id = p_property_id
  ),
  ch as (
    -- rule 5 throughout: `is not true`, never `= false`
    select fc.folio_id,
           sum(fc.gross_amount)    gross,
           sum(fc.discount_amount) disc,
           sum(fc.net_amount)      net
    from folio_charges fc
    join f on f.id = fc.folio_id
    where fc.is_voided is not true
    group by fc.folio_id
  ),
  tx as (
    select fc.folio_id, sum(tl.amount) tax
    from folio_charge_tax_lines tl
    join folio_charges fc on fc.id = tl.folio_charge_id
    join f on f.id = fc.folio_id
    where fc.is_voided is not true
    group by fc.folio_id
  ),
  pm as (
    select fp.folio_id, sum(fp.amount) paid
    from folio_payments fp
    join f on f.id = fp.folio_id
    where fp.is_voided is not true
    group by fp.folio_id
  )
  select f.id,
         coalesce(ch.gross, 0)::numeric(14,2),
         coalesce(ch.disc,  0)::numeric(14,2),
         coalesce(ch.net,   0)::numeric(14,2),
         coalesce(tx.tax,   0)::numeric(14,2),
         (coalesce(ch.net, 0) + coalesce(tx.tax, 0))::numeric(14,2),
         coalesce(pm.paid,  0)::numeric(14,2),
         (coalesce(ch.net, 0) + coalesce(tx.tax, 0) - coalesce(pm.paid, 0))::numeric(14,2)
  from f
  left join ch on ch.folio_id = f.id
  left join tx on tx.folio_id = f.id
  left join pm on pm.folio_id = f.id;
$function$;

revoke all on function folio_totals_by_folio(uuid, uuid) from public;
revoke all on function folio_totals_by_folio(uuid, uuid) from anon;
revoke all on function folio_totals_by_folio(uuid, uuid) from authenticated;

comment on function folio_totals_by_folio(uuid, uuid) is
  'The folio balance arithmetic for every folio at a property (or one of them), '
  'in ONE query — what item 8''s reconciliation reads. 021''s folio_totals is '
  'the AUTHORITY and is untouched: re-emitting it over this was built, measured '
  'at 193x slower per folio, and reverted, so there are deliberately two '
  'implementations with the per-folio one authoritative. 066''s assertion 1 '
  'compares them on every live folio, all seven columns — ON APPLY DAY ONLY. '
  'The reconciliation does NOT compare them when it runs and cannot afford to; '
  'the standing check belongs on the monthly restore-test slot (1.1h2a). A '
  'drift between two copies of this expression would read as a LEDGER '
  'difference, so the reconciliation would report the one thing it exists to '
  'disprove. NOT granted to authenticated: '
  'folio_totals is the granted interface for one folio, and the reconciliation '
  'functions are the granted interface for a property.';

-- ----------------------------------------------------------------------------
-- AND folio_totals IS *NOT* RE-EMITTED OVER THIS. MEASURED, NOT ASSUMED.
-- ----------------------------------------------------------------------------
-- The plan was to make folio_totals a thin filter over this so the arithmetic
-- existed once. It was built that way, measured, and REVERTED — side by side in
-- one transaction, 2,000 folios, server-side, median of five:
--
--     folio_totals, per folio      021's own version   0.06 ms
--                                  as a filter over this  11.10 ms   193x WORSE
--
-- 021's version is three indexed aggregates for one folio. This one builds a
-- query over four tables and throws away all but one row. No amount of
-- sargability closes that: the work is structural. And folio_totals is on every
-- folio screen, so a 193x regression there is paid by everybody who opens a
-- bill, to buy tidiness in a report nobody opens hourly.
--
-- SO THERE ARE TWO IMPLEMENTATIONS, AND THAT IS THE DECISION. What makes it
-- honest rather than the thing 1.1h2a exists to fix is which one is the
-- authority and what pins them:
--
--   * 021's folio_totals is THE authority. Every screen reads it and this file
--     does not touch it.
--   * folio_totals_by_folio is a BULK READER of the same arithmetic, for item 8.
--   * SECTION 4's assertion 1 compares them on EVERY LIVE FOLIO, all seven
--     columns. Not sampled.
--   * And item 8's reconciliation will carry the same comparison in its own
--     run, so the pin is CONTINUOUS rather than something that was true on the
--     day this migration was applied.
--
-- The stock side's pair has none of that: inventory_gl_reconciliation and
-- inventory_gl_reconciliation_positions are two independent queries, neither is
-- authoritative, and nothing compares them (1.1h2a).

-- ############################################################################
-- SECTION 2 — THE CLASSIFIER, SET-WISE, AND THE FILTER THAT NEARLY BROKE IT
-- ############################################################################
-- 064 put the posting rule in one place and the whole folio reads it. Measured
-- over a year — 4,000 folios, 17,800 documents, timed server-side, median of
-- five — calling it once per document costs 20.2 SECONDS. That is not a
-- reconciliation somebody opens at 7am, and it is 1.13 ms per document, which
-- is simply what plpgsql costs 17,800 times rather than something a plan fixes.
--
-- So the rule moves set-wise FOR THE BULK READ. 064's single-document form was
-- then re-emitted over it so the rule would exist once — and that was measured,
-- found 18x slower on the path every posting helper takes, and REVERTED. The
-- figures and the reasoning are below the function. What survives from the
-- attempt is the folio filter and the assertion that pins the pair, and the
-- filter is worth reading even though nothing in this file now depends on it,
-- because item 2b's sweep will.
--
-- ----------------------------------------------------------------------------
-- THE FILTER IS THE FOLIO, AND THAT IS NOT AN OPTIMISATION — IT IS CORRECTNESS
-- ----------------------------------------------------------------------------
-- The obvious filter for a single-document call is the document. IT IS WRONG,
-- and wrong in exactly the case the rule exists for: a counter's state depends
-- on its original's, so a base set narrowed to the counter alone classifies it
-- with the original ABSENT. The second pass then resolves against nothing, and
-- the function returns `never_dependency` — confidently — for a counter that is
-- perfectly postable.
--
-- THE FILTER IS THEREFORE "THIS DOCUMENT AND WHATEVER IT DEPENDS ON", and the
-- folio is exactly that set, STRUCTURALLY rather than by observation:
--
--   * a counter charge carries v_original.folio_id — post_charge_reversal's
--     INSERT copies it from the row it reverses (032, read in place);
--   * a counter payment is written by record_payment(v_payment.folio_id, ...)
--     from inside reverse_payment (031);
--   * a discount application hangs off folio_charge_id, so its charge is on the
--     same folio by schema;
--   * a void is the same document under a different type, so the same folio.
--
-- Filtering to the folio therefore pulls in every dependency, and it keeps the
-- single-document call bounded by ONE FOLIO — three to six documents — rather
-- than by the property, which matters because 064's posting helpers call it on
-- every charge, every discount and every payment as they post. A filter that
-- computed the property would make posting a charge at the desk slower every
-- month the hotel trades, which is the worst place in the product to put a
-- growing cost.
--
-- SECTION 4 ASSERTS BOTH HALVES: that a counter classified through the filtered
-- call and through the property-wide call gives the SAME answer — the only
-- thing that proves this inversion kept one implementation rather than quietly
-- growing a second — and that no dependency crosses a folio, so the premise
-- above is checked rather than believed.
--
-- ----------------------------------------------------------------------------
-- TWO PASSES, NOT A RECURSIVE CTE, AND FOUR REFUSALS ARE WHY
-- ----------------------------------------------------------------------------
-- Every dependency points at an INDEPENDENT document, so depth is exactly two:
--
--   * a counter cannot be reversed       — 'This line is itself a reversal and
--                                          cannot be reversed' (065 asserts it)
--   * a counter cannot be voided         — 'is a reversal and cannot be voided'
--   * a counter cannot be discounted     — 'This line is a reversal and cannot
--                                          be discounted'
--   * a payment reversal cannot be voided — 'is a payment reversal and cannot
--                                          be voided'
--
-- 065's assertion 11 was written to replace 064's recursion argument with a
-- test; the test is what licenses this shape one shipment later. SECTION 4
-- asserts the premise directly too — no document's dependency is itself a
-- dependent — because if a future path breaks one of those four refusals, the
-- two-pass form gives a wrong answer for that document in silence.
create or replace function folio_posting_states(p_property_id uuid,
                                                p_folio_id uuid default null)
returns table (
  document_type   text,
  document_id     uuid,
  folio_id        uuid,
  state           text,
  -- WHAT IT DEPENDS ON, returned rather than left to be re-derived. Item 2b
  -- needs it to post originals before counters, and item 8 needs it to absorb a
  -- document and its dependents into ONE explanation — a pre-wiring charge and
  -- its reversal are two documents outside the books for ONE reason, and a
  -- bucket that catches one but not the other reports a difference that is
  -- really an incomplete explanation. Deriving it twice is how the two answers
  -- start to disagree.
  depends_on_type text,
  depends_on_id   uuid,
  -- AND THE DEPENDENCY'S OWN STATE, RETURNED RATHER THAN LEFT TO BE JOINED.
  -- Null on an independent document. This column exists because of a
  -- measurement, and the figure is worth the sentence: item 8's reconciliation
  -- asks "is this counter's original in the books?" in three of its branches,
  -- and the obvious way to ask is to self-join this function's result. A
  -- materialised CTE HAS NO INDEX, so the planner answered it with a CTE Scan
  -- per outer row — 5,402 loops over 8,900 rows, three times over — and the
  -- whole reconciliation went from 57 ms of inputs to THIRTEEN SECONDS at 2,000
  -- folios, and did not finish inside a fifteen-minute timeout at 4,000.
  --
  -- Pass 2 already has the answer in hand. Returning it costs nothing here and
  -- removes three nested loops there. Item 2b wants it too, for the same
  -- reason: it must post originals before counters.
  depends_on_state text
)
language sql
stable
security definer
set search_path to 'public'
as $function$
  with settings as (
    select pfs.gl_start_date,
           pfs.folio_gl_wired_at,
           (now() at time zone
             coalesce(nullif(btrim(p.timezone), ''), 'Africa/Lagos'))::date as today
    from property_finance_settings pfs
    join properties p on p.id = pfs.property_id
    where pfs.property_id = p_property_id
  ),
  f as (
    -- THE TARGET FOLIOS, RESOLVED ONCE AND JOINED. Not
    -- `(p_folio_id is null or fc.folio_id = p_folio_id)`: that predicate is NOT
    -- SARGABLE, so the planner cannot use folio_charges_folio_id_idx and reads
    -- every charge at the property to answer about one folio. Measured at 2,000
    -- folios before this change: 25.3 ms for a single folio and 10.9 ms per
    -- single-document call, against 064's 1.13 ms — the inversion had made the
    -- POSTING path ten times slower and growing, which is the worst place in
    -- the product to put a cost that grows with trading.
    -- TWO MUTUALLY EXCLUSIVE BRANCHES, not one OR. `p_folio_id is null` is a
    -- constant to the planner, so it prunes the branch that cannot run and the
    -- surviving one is an index scan — on the primary key when a folio is
    -- named, on property_id when it is not. With the OR it had to read every
    -- folio at the property and filter to one, which is what kept the
    -- single-document path slow after the first two fixes.
    select fl.id from folios fl
    where p_folio_id is not null and fl.id = p_folio_id
      and fl.property_id = p_property_id
    union all
    select fl.id from folios fl
    where p_folio_id is null and fl.property_id = p_property_id
  ),
  doc as (
    -- every folio document, reduced to the five facts that decide: its business
    -- date, when it was written, whether it is void, and what it depends on.
    select 'folio_charge'::text as dt, fc.id as did, fc.folio_id as fid,
           fc.charge_date as bdate, fc.created_at as created,
           coalesce(fc.is_voided, false) as voided,
           case when fc.reversal_of_charge_id is not null then 'folio_charge'::text end as dep_dt,
           fc.reversal_of_charge_id as dep_id
    from folio_charges fc
    join f on f.id = fc.folio_id

    union all
    -- is_voided comes from the CHARGE: voiding a charge takes its discount off
    -- the bill too, so an application on a voided charge has nothing to relieve.
    select 'folio_charge_discount', d.id, c.folio_id, d.business_date, d.created_at,
           coalesce(c.is_voided, false), 'folio_charge', c.id
    from folio_charge_discounts d
    join folio_charges c on c.id = d.folio_charge_id
    join f on f.id = c.folio_id

    union all
    select 'folio_payment', fp.id, fp.folio_id, fp.payment_date, fp.created_at,
           coalesce(fp.is_voided, false), null::text, null::uuid
    from folio_payments fp
    join f on f.id = fp.folio_id

    union all
    -- A void is its own document on the voided row's id, and it exists only
    -- once that row is voided. Its business date is the day the void HAPPENED,
    -- and voided_at is also when it was "written", so a void keyed after the
    -- wiring is not pre-wiring even when the charge is.
    select 'folio_charge_void', fc.id, fc.folio_id,
           (fc.voided_at at time zone
             coalesce(nullif(btrim(p.timezone), ''), 'Africa/Lagos'))::date,
           fc.voided_at, false, 'folio_charge', fc.id
    from folio_charges fc
    join f on f.id = fc.folio_id
    join properties p on p.id = fc.property_id
    where fc.is_voided is true

    union all
    select 'folio_payment_void', fp.id, fp.folio_id,
           (fp.voided_at at time zone
             coalesce(nullif(btrim(p.timezone), ''), 'Africa/Lagos'))::date,
           fp.voided_at, false, 'folio_payment', fp.id
    from folio_payments fp
    join f on f.id = fp.folio_id
    join properties p on p.id = fp.property_id
    where fp.is_voided is true
  ),
  own as (
    -- 064's precedence, steps 1 to 3: posted beats everything; never_pre_gl
    -- before never_pre_wiring, which is 047's order and is what keeps the two
    -- buckets mutually exclusive; never_voided before the calendar, because a
    -- night voided before its day will never post whether the day arrives or
    -- not. NULL here means "no answer yet — ask the dependency, then the date".
    select d.*, s.today,
           case
             -- An indexed exists per row, on journal_entries_source_uniq
             -- (tenant, source type, source id), rather than a CTE holding
             -- every folio entry at the property: that CTE was read in full on
             -- every call, which is half of why the filtered path was slow.
             when exists (select 1 from journal_entries je
                          where je.source_document_type = d.dt
                            and je.source_document_id   = d.did
                            and je.property_id = p_property_id)
               then 'posted'
             when s.gl_start_date is not null and d.bdate < s.gl_start_date
               then 'never_pre_gl'
             when s.folio_gl_wired_at is not null and d.created < s.folio_gl_wired_at
               then 'never_pre_wiring'
             when d.voided
               then 'never_voided'
           end as st
    from doc d cross join settings s
  ),
  pass1 as (
    -- the independents: nothing to wait for, so its own answer or the calendar.
    select o.dt, o.did, o.fid,
           coalesce(o.st,
                    case when o.bdate > o.today then 'waiting_not_yet_due'
                         else 'ready' end) as state,
           o.dep_dt, o.dep_id, null::text as dep_state
    from own o
    where o.dep_id is null
  ),
  pass2 as (
    -- the dependents. Its own answer still comes first (a posted counter is
    -- posted whatever its original says); then the dependency; then the date.
    -- A dependency that is ABSENT from the base set would read as
    -- never_dependency, which is exactly why the filter is the folio.
    select o.dt, o.did, o.fid,
           coalesce(o.st,
                    case
                      when p.state is null                then 'never_dependency'
                      when p.state like 'never%'          then 'never_dependency'
                      when p.state <> 'posted'            then 'waiting_for_dependency'
                      when o.bdate > o.today              then 'waiting_not_yet_due'
                      else 'ready'
                    end) as state,
           o.dep_dt, o.dep_id, p.state as dep_state
    from own o
    left join pass1 p on p.dt = o.dep_dt and p.did = o.dep_id
    where o.dep_id is not null
  )
  select dt, did, fid, state, dep_dt, dep_id, dep_state from pass1
  union all
  select dt, did, fid, state, dep_dt, dep_id, dep_state from pass2;
$function$;

revoke all on function folio_posting_states(uuid, uuid) from public;
revoke all on function folio_posting_states(uuid, uuid) from anon;
revoke all on function folio_posting_states(uuid, uuid) from authenticated;

comment on function folio_posting_states(uuid, uuid) is
  'Why every folio document at a property is or is not in the books, set-wise, '
  'in 064''s nine states — what item 8''s reconciliation reads. 064''s '
  'folio_posting_state is the AUTHORITY for one document and is untouched: '
  're-emitting it over this was built, measured at 18x slower per call on the '
  'path every posting helper takes, and reverted. 066''s assertion 3 compares '
  'the two on EVERY document at the property. THE FILTER IS THE FOLIO, not the '
  'document: a '
  'counter''s state depends on its original''s, and a base set narrowed to the '
  'counter alone would classify it with the original absent and return '
  'never_dependency for a postable counter. Two passes rather than a recursive '
  'CTE, because four refusals make every dependency point at an independent '
  'document. NOT granted to authenticated.';

-- ----------------------------------------------------------------------------
-- AND folio_posting_state IS *NOT* RE-EMITTED OVER THIS EITHER. SAME REASON.
-- ----------------------------------------------------------------------------
-- Measured side by side in one transaction, 1,000 documents, server-side,
-- median of five:
--
--     folio_posting_state, per call   064's own version    0.79 ms
--                                     as a filter over this  14.14 ms   18x WORSE
--
-- 064's version is two to four index lookups. This one assembles a five-branch
-- union over five tables, materialises a CTE and discards all but one row —
-- every time. Three successive fixes (a sargable folio join, an indexed exists
-- instead of a property-wide CTE, prunable branches instead of an OR) took it
-- from 10.9 to 14.1 ms without changing the shape of the problem, which is the
-- signal that the cost is structural rather than a plan.
--
-- AND THIS IS THE WORST PLACE IN THE PRODUCT TO PUT THAT. 064's posting helpers
-- call it on every charge, every discount and every payment as they post, so
-- the regression would be paid at the front desk, on every keystroke, growing
-- with the property.
--
-- WHAT THE INVERSION IS ACTUALLY FOR, measured the same way:
--
--     the whole property, one call    folio_posting_states    48 ms
--     the same answers, per document  folio_posting_state   ~7,000 ms
--
-- So: two implementations, 064's authoritative and this one a bulk reader, and
-- SECTION 4's assertion 3 compares them ON EVERY DOCUMENT at the property —
-- which is the assertion that proves the second one did not quietly become a
-- different rule.
--
-- ON APPLY DAY, AND ONLY THEN. The reconciliation does NOT re-run that
-- comparison, because comparing per document IS the 20-second path above: an
-- inline pin would put back exactly the cost this file exists to remove. The
-- standing check is SCHEDULED instead, on the monthly restore-test slot
-- (1.1h2a's note carries the shape), which is where this repo already keeps
-- proof too expensive to run inline.
--
-- THE FILTER IS STILL THE FOLIO, and the reasoning above still holds for anyone
-- calling this with p_folio_id — item 2b's sweep will, folio by folio. A filter
-- narrowed to the document would classify a counter with its original absent.

-- ############################################################################
-- SECTION 3 — THE RECONCILIATION, PER FOLIO AND ROLLED UP
-- ############################################################################
-- The invariant, and it is the whole point of 061 to 065 (rule 9):
--
--     ledger_balance === expected_balance, TO THE KOBO, PER FOLIO, ALWAYS.
--
-- The left side is read from journal_entry_lines. The right is computed
-- independently from the folio's own rows — charges, their tax lines, their
-- discount applications, payments — less what legitimately has not reached the
-- books yet, named bucket by bucket. Any difference means a posting was
-- skipped, doubled, or landed on the wrong side.
--
-- PER FOLIO, NOT PER PROPERTY, AND THE PER-FOLIO ROW IS THE AUTHORITY. The
-- question was which way round to state it, and what each choice costs when it
-- goes red:
--
--   * A PROPERTY-LEVEL figure costs one query and tells somebody that
--     48,444.75 is unaccounted for. That is the end of what it tells them. The
--     next step is a hand search of every open folio, and the search is worst
--     exactly when the figure is worst, because a property with a problem is
--     usually a property that has been trading.
--   * A PER-FOLIO figure costs a row per folio and names the bill. At 7am,
--     before the night audit is signed off, "folio BK-000412 is 12,500 out" is
--     a thing a duty manager can open, read and act on. "The property is
--     12,500 out" is a thing they escalate.
--   * AND THEY DO NOT COST THE SAME WHEN NOTHING IS WRONG EITHER. A green
--     property-level figure says the sum is right, which a pair of offsetting
--     errors also says. A green per-folio run says every folio is right, and
--     two folios 5,000 out in opposite directions cannot hide in it. That is
--     rule 27's second shape — a total insensitive to the rule that produced it
--     — one layer up, and it is the argument that decides this: the cheap
--     figure is the one that can be green while the books are wrong.
--
-- SO THE HEADLINE IS A SUM OVER THE PER-FOLIO ROWS, never a second query over
-- the same data. The stock side has it the other way round today —
-- inventory_gl_reconciliation and inventory_gl_reconciliation_positions each
-- aggregate the movements independently, so nothing stops them disagreeing
-- about the same stock (named as 1.1h2a; no figure is wrong today).
--
-- ZERO TOLERANCE, AND IT IS A DECISION RATHER THAN AN OVERSIGHT. There is no
-- epsilon, no "within a kobo", no rounding allowance. Every figure on both
-- sides is numeric(14,2) and every tax line was rounded to the kobo WHEN IT WAS
-- CAPTURED, so there is no irrational quantity anywhere in this arithmetic for
-- a tolerance to absorb — unlike the stock side, where a moving average has
-- more decimals than money does and 047 reports a valuation_difference for
-- exactly that reason. Room made for nothing is where a real difference hides
-- later: a tolerance of one kobo per folio is 40 naira a year across Heledon's
-- folios, and the day something is genuinely 40 naira out it reads as the
-- tolerance.
--
-- WHY SECURITY DEFINER, WRITTEN DOWN SO THE NEXT PERSON WHO TIDIES IT HAS THE
-- ARGUMENT. This reads journal_entry_lines, which RLS does not expose to staff.
-- As SECURITY INVOKER the join would return NO ROWS rather than a refusal, and
-- the reconciliation would report a perfect zero — indistinguishable from a
-- property whose books balance, which is the one failure this function must
-- never have. 051 made exactly this mistake and had it caught in review rather
-- than by a test. So: DEFINER rights, paired with an EXPLICIT is_tenant_staff
-- gate, because without the gate a member with no business reading the books
-- gets zeros instead of a refusal — a different answer to a different question
-- from the one they asked.

-- ----------------------------------------------------------------------------
-- 3.1 folio_gl_reconciliation_folios — one row per folio, and the authority
-- ----------------------------------------------------------------------------
drop function if exists folio_gl_reconciliation_folios(uuid);

create or replace function folio_gl_reconciliation_folios(p_property_id uuid)
returns table (
  folio_id            uuid,
  -- What a human calls it: the booking number, or the guest's name on a
  -- standalone folio (028 made booking_id nullable). Always populated, because
  -- a headline that names a UUID names nothing.
  folio_label         text,
  folio_status        text,

  -- THE LEFT SIDE: the guest's balance as the JOURNAL has it.
  ledger_balance      numeric(14,2),
  -- THE RIGHT SIDE: the bill, less every bucket below.
  expected_balance    numeric(14,2),
  -- MUST BE ZERO. Anything else is a posting skipped, doubled or misdirected.
  ledger_difference   numeric(14,2),

  -- The bill as the guest sees it — folio_totals' own figure, so this column
  -- and the folio screen cannot disagree about what is owed.
  folio_balance       numeric(14,2),

  -- WHAT LEGITIMATELY HAS NOT REACHED THE BOOKS, split by 064's states so the
  -- arithmetic above is complete rather than approximately complete. Each is
  -- SIGNED the way it moves the guest's balance: a charge outside the books is
  -- positive, an unposted payment or discount negative.
  pre_gl_value        numeric(14,2),
  pre_wiring_value    numeric(14,2),
  -- The counters of the two above. A pre-wiring charge and its reversal are two
  -- documents outside the books for ONE reason, and they must be absorbed
  -- TOGETHER: a bucket that catches the charge but not its reversal reports a
  -- difference that is really an incomplete explanation.
  dependency_value    numeric(14,2),
  -- Drains by itself: the date arrives, or the original posts.
  waiting_value       numeric(14,2),
  -- DOES NOT DRAIN BY ITSELF. Something should have posted and did not — the
  -- backlog item 2b's sweep exists to clear. Expected to be zero once it ships.
  ready_value         numeric(14,2),
  -- A state this function does not know how to bucket, which today is no state
  -- at all. It is NOT subtracted from expected_balance, so a tenth state added
  -- to 064 without a bucket here goes RED and names its amount, rather than
  -- being silently absorbed into a figure that is meant to be exactly zero.
  unclassified_value  numeric(14,2),

  -- THE DENOMINATORS. 047's lesson: a figure with no count beside it is a
  -- figure somebody misreads. 12,500 across three documents is a mistake you
  -- can find; across four hundred it is a different investigation.
  document_count      integer,
  unposted_count      integer
)
language plpgsql
stable
security definer
set search_path = public
as $$
-- The OUT parameters of a `returns table` are plpgsql VARIABLES and several
-- share a name with a column below. Every reference is qualified; the directive
-- removes the class of ambiguity rather than relying on that staying true. It
-- lives inside the body, above `declare`: the PL/pgSQL parser reads it, not
-- CREATE FUNCTION, and putting it in the header is a plain syntax error.
#variable_conflict use_column
declare
  v_tenant uuid;
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

  return query
  with st as (
    -- ONE call, for the whole property. This is what SECTION 2 exists for: the
    -- same answers document by document cost 20.2 SECONDS over a year of
    -- trading and cost 48 ms here.
    select s.document_type, s.document_id, s.folio_id, s.state,
           s.depends_on_type, s.depends_on_id, s.depends_on_state
    from folio_posting_states(p_property_id) s
  ),
  tot as (
    -- and SECTION 1, likewise — and it is folio_totals' arithmetic, so this
    -- column cannot disagree with the folio screen.
    select t.folio_id, t.balance
    from folio_totals_by_folio(p_property_id) t
  ),
  gl as (
    -- THE GUEST'S BALANCE AS THE JOURNAL HAS IT, per source document.
    --
    -- Keyed on role_key, not account_id, and the distinction is the point: a
    -- line's role_key says THIS LINE IS THE GUEST'S BALANCE, whichever account
    -- the mapping pointed at when it posted (044's comment on the column). The
    -- ACCOUNT total is checked separately, in 3.2, and the gap between the two
    -- is where a repointed mapping shows up (1.1h4c).
    --
    -- company_receivable is deliberately NOT here. A payment by company account
    -- credits guest_ledger and debits company_receivable: the debt moves off
    -- the guest and onto the company, so the guest's balance is still fully
    -- described by the guest_ledger lines alone.
    select je.source_document_type as dt,
           je.source_document_id   as did,
           sum(l.debit - l.credit)::numeric(14,2) as net
    from journal_entries je
    join journal_entry_lines l on l.journal_entry_id = je.id
    where je.tenant_id   = v_tenant
      and je.property_id = p_property_id
      and l.role_key     = 'guest_ledger'
    group by je.source_document_type, je.source_document_id
  ),
  tax as (
    select tl.folio_charge_id as cid, sum(tl.amount)::numeric(14,2) as amount
    from folio_charge_tax_lines tl
    join folio_charges fc on fc.id = tl.folio_charge_id
    where fc.property_id = p_property_id
    group by tl.folio_charge_id
  ),
  dres as (
    -- WHAT A DISCOUNT APPLICATION DOES TO THE GUEST'S BALANCE, by 061's own
    -- formula: the relief itself, plus the tax that comes off with it, where the
    -- tax delta is the difference between the tax on the new net and the tax on
    -- the old one — each rounded to the kobo separately, exactly as
    -- post_folio_discount_journal rounds them, because rounding the difference
    -- is not the same number as differencing the roundings.
    --
    -- THIS DUPLICATES THAT HELPER'S ARITHMETIC, KNOWINGLY, AND THAT IS WHAT A
    -- RECONCILIATION IS: two numbers derived independently and compared. The
    -- risk the duplication carries is that the copy drifts, so SECTION 4's
    -- assertion 13 pins it — for every discount that DID post, this expression
    -- must equal the guest_ledger net of the entry the helper actually wrote.
    select d.id as did,
           c.folio_id as fid,
           (-d.delta_amount
             + coalesce(sum(round((c.gross_amount - d.new_amount)      * tl.rate, 2)
                          - round((c.gross_amount - d.previous_amount) * tl.rate, 2)), 0)
           )::numeric(14,2) as residual
    from folio_charge_discounts d
    join folio_charges c on c.id = d.folio_charge_id
    left join folio_charge_tax_lines tl on tl.folio_charge_id = c.id
    where c.property_id = p_property_id
    group by d.id, c.folio_id, d.delta_amount
  ),
  chgl as (
    -- WHAT A CHARGE VOID UNWINDS, read from the entries rather than rebuilt
    -- from the row — 064's lesson, and it has to be the entries here for the
    -- same reason it had to be there: a bill from before a rate change carries
    -- tax at the old rate, and a counter rebuilt from today's rates leaves a
    -- residue. The void mirrors the charge's entry AND its discounts' entries
    -- (064 section 2), so this sums both.
    -- VOIDED CHARGES ONLY, AND AGGREGATED ONCE — both measured, not assumed.
    -- The first version ran this for EVERY charge at the property with a
    -- LATERAL over the gl CTE, which is a nested loop over a materialised CTE
    -- with no index on it: at 4,000 folios the whole reconciliation did not
    -- finish inside a FIFTEEN MINUTE statement timeout. Branch 4 is the only
    -- consumer and it only ever asks about voided charges, so the row count
    -- drops from every charge to the handful that were voided, and the
    -- discounts' entries are summed by one grouped join instead of a scan per
    -- charge.
    select fc.id as cid,
           (coalesce(g0.net, 0) + coalesce(dg.net, 0))::numeric(14,2) as net
    from folio_charges fc
    left join gl g0 on g0.dt = 'folio_charge' and g0.did = fc.id
    left join (
      select d.folio_charge_id as cid, sum(g.net) as net
      from folio_charge_discounts d
      join gl g on g.dt = 'folio_charge_discount' and g.did = d.id
      group by d.folio_charge_id
    ) dg on dg.cid = fc.id
    where fc.property_id = p_property_id
      and fc.is_voided is true
  ),
  contrib as (
    -- EVERY DOCUMENT OUTSIDE THE BOOKS, AND WHAT IT WOULD HAVE DONE TO THE
    -- GUEST'S BALANCE. Five branches, and the conditions on them are what stop
    -- one document being counted twice:

    -- 1. A CHARGE OUTSIDE THE BOOKS: the whole of it, as the bill NOW stands.
    --    Its discount applications are not counted separately — net_amount is
    --    already net of them, and they are all never_dependency behind it.
    select st.folio_id as fid, st.state,
           (fc.net_amount + coalesce(tax.amount, 0))::numeric(14,2) as amount
    from st
    join folio_charges fc on fc.id = st.document_id
    left join tax on tax.cid = fc.id
    where st.document_type = 'folio_charge'
      and st.state <> 'posted'
      and fc.is_voided is not true

    union all
    -- 2. A DISCOUNT OUTSIDE THE BOOKS WHOSE CHARGE IS IN THEM. Only then: if
    --    the charge never posted, branch 1 already holds the whole of it
    --    including this relief, and counting it here too would double it.
    --    Excluded on a voided charge, where branch 4 accounts for the lot.
    --
    --    `st.depends_on_state` rather than a self-join on st: the self-join
    --    cost thirteen seconds at 2,000 folios (see SECTION 2's column).
    select st.folio_id, st.state, dres.residual
    from st
    join dres on dres.did = st.document_id
    join folio_charges fc on fc.id = st.depends_on_id
    where st.document_type = 'folio_charge_discount'
      and st.state <> 'posted'
      and fc.is_voided is not true
      and st.depends_on_state = 'posted'

    union all
    -- 3. A PAYMENT OUTSIDE THE BOOKS. Negative: the bill shows it reducing what
    --    is owed and the ledger does not.
    select st.folio_id, st.state, (-fp.amount)::numeric(14,2)
    from st
    join folio_payments fp on fp.id = st.document_id
    where st.document_type = 'folio_payment'
      and st.state <> 'posted'
      and fp.is_voided is not true

    union all
    -- 4. A CHARGE VOID OUTSIDE THE BOOKS WHOSE CHARGE IS IN THEM. The bill has
    --    dropped the line; the journal still holds it. Only when the original
    --    posted — 064's ruling: a void of something that never posted has
    --    nothing to unwind, and both sides are already zero.
    --
    --    THE `ost.state = 'posted'` CONDITION IS BELT-AND-BRACES, AND THE
    --    BREAKAGE RUN SAYS SO: deleting it stays green, because when the
    --    original never posted there are no entries to mirror and chgl.net is
    --    0, so the branch contributes nothing either way. It is kept because it
    --    states the rule at the place the rule applies, and because it stops
    --    being redundant the moment a charge can carry a posted discount
    --    without a posted entry of its own.
    select st.folio_id, st.state, (-chgl.net)::numeric(14,2)
    from st
    join chgl on chgl.cid = st.document_id
    where st.document_type = 'folio_charge_void'
      and st.state <> 'posted'
      and st.depends_on_state = 'posted'

    union all
    -- 5. The same for a payment void, which mirrors one entry rather than a
    --    charge's entry plus its discounts'.
    select st.folio_id, st.state, (-coalesce(gl.net, 0))::numeric(14,2)
    from st
    left join gl on gl.dt = 'folio_payment' and gl.did = st.document_id
    where st.document_type = 'folio_payment_void'
      and st.state <> 'posted'
      and st.depends_on_state = 'posted'
  ),
  buckets as (
    select tot.folio_id as fid,
           tot.balance,
           coalesce(sum(c.amount) filter (where c.state = 'never_pre_gl'), 0)::numeric(14,2)     as pre_gl,
           coalesce(sum(c.amount) filter (where c.state = 'never_pre_wiring'), 0)::numeric(14,2) as pre_wiring,
           coalesce(sum(c.amount) filter (where c.state = 'never_dependency'), 0)::numeric(14,2) as dependency,
           coalesce(sum(c.amount) filter (where c.state in ('waiting_not_yet_due',
                                                            'waiting_for_dependency')), 0)::numeric(14,2) as waiting,
           coalesce(sum(c.amount) filter (where c.state = 'ready'), 0)::numeric(14,2)            as ready,
           coalesce(sum(c.amount) filter (where c.state not in ('never_pre_gl','never_pre_wiring',
                                                                'never_dependency','waiting_not_yet_due',
                                                                'waiting_for_dependency','ready')), 0)::numeric(14,2) as unclassified
    from tot
    left join contrib c on c.fid = tot.folio_id
    group by tot.folio_id, tot.balance
  ),
  led as (
    select st.folio_id as fid,
           coalesce(sum(gl.net), 0)::numeric(14,2) as net,
           count(*)::integer as docs,
           count(*) filter (where st.state <> 'posted')::integer as unposted
    from st
    left join gl on gl.dt = st.document_type and gl.did = st.document_id
    group by st.folio_id
  ),
  shaped as (
    select
      b.fid,
      coalesce(bk.booking_number,
               nullif(btrim(coalesce(g.first_name, '') || ' ' || coalesce(g.last_name, '')), ''),
               'folio ' || left(b.fid::text, 8)) as label,
      f.status,
      f.opened_at,
      coalesce(led.net, 0)::numeric(14,2) as ledger,
      -- EXPECTED, COMPUTED ONCE, AND THE REASON IS A BREAKAGE THAT STAYED
      -- GREEN. This expression was written three times in the select list — as
      -- the column, inside the difference, and inside the ordering — and
      -- dropping a bucket from the column left the DIFFERENCE reading its own
      -- untouched copy. The invariant stayed at zero while the figure beside it
      -- was wrong, which is the one failure shape this function must not have.
      -- One expression, three readers.
      (b.balance - b.pre_gl - b.pre_wiring - b.dependency - b.waiting - b.ready)::numeric(14,2) as expected,
      b.balance, b.pre_gl, b.pre_wiring, b.dependency, b.waiting, b.ready, b.unclassified,
      coalesce(led.docs, 0) as docs,
      coalesce(led.unposted, 0) as unposted
    from buckets b
    join folios f on f.id = b.fid
    left join bookings bk on bk.id = f.booking_id
    left join guests g on g.id = f.guest_id
    left join led on led.fid = b.fid
  )
  select s.fid, s.label, s.status,
         s.ledger,
         s.expected,
         (s.ledger - s.expected)::numeric(14,2),
         s.balance, s.pre_gl, s.pre_wiring, s.dependency, s.waiting, s.ready,
         s.unclassified, s.docs, s.unposted
  from shaped s
  order by abs(s.ledger - s.expected) desc, s.opened_at desc;
end;
$$;

revoke all on function folio_gl_reconciliation_folios(uuid) from public;
revoke all on function folio_gl_reconciliation_folios(uuid) from anon;
grant execute on function folio_gl_reconciliation_folios(uuid) to authenticated;

comment on function folio_gl_reconciliation_folios(uuid) is
  'THE CHECK THAT MAKES 061 TO 065 WORTH HAVING, PER FOLIO (rule 9). '
  'INVARIANT: ledger_balance === expected_balance, to the kobo, FOR EVERY '
  'FOLIO — the left side read from journal_entry_lines by role_key, the right '
  'computed independently from the folio''s own charges, tax lines, discount '
  'applications and payments, less the buckets naming what legitimately has not '
  'posted. PER FOLIO rather than per property because a property-level figure '
  'tells a duty manager that something is wrong and a folio-level one tells '
  'them which bill to open; and because a property total can be green while two '
  'folios are wrong in opposite directions, which is rule 27''s second shape a '
  'layer up. ZERO TOLERANCE, deliberately: every figure on both sides is '
  'numeric(14,2) and every tax line was rounded when it was captured, so there '
  'is no irrational quantity for a tolerance to absorb. Ordered worst-first. '
  'SECURITY DEFINER with an explicit is_tenant_staff gate: as INVOKER the '
  'journal join would return no rows rather than a refusal, and a property '
  'whose books are unreadable would report a perfect zero.';

-- ----------------------------------------------------------------------------
-- 3.2 folio_gl_reconciliation — the headline, SUMMED FROM 3.1
-- ----------------------------------------------------------------------------
-- Every figure here except the account balance is an aggregate OVER 3.1's rows,
-- so the headline and the breakdown cannot disagree. The headline carries THE
-- WORST ONE, with its number, because a count and a total still leave somebody
-- opening folios one by one: "3 folios out, 12,500 in total, worst is
-- BK-000412 at 12,500" is a figure and a destination in one line.
drop function if exists folio_gl_reconciliation(uuid);

create or replace function folio_gl_reconciliation(p_property_id uuid)
returns table (
  property_id            uuid,

  -- THE ACCOUNT, which is the question an accountant actually asks, and the one
  -- figure here that CANNOT come from 3.1: a journal entry nobody's folio
  -- produced is invisible to a per-folio read.
  account_id             uuid,
  account_code           text,
  account_name           text,
  account_balance        numeric(14,2),
  -- The part of that account that came from a folio document, summed from 3.1.
  folio_sourced_balance  numeric(14,2),
  -- account_balance - folio_sourced_balance. MUST BE ZERO today. Non-zero means
  -- guest_ledger carries something no folio produced: a manual journal entry
  -- against the guest ledger, or a mapping repointed after posting so old lines
  -- sit on an account the role key no longer names (1.1h4c).
  outside_folios         numeric(14,2),

  -- THE INVARIANT, rolled up. MUST BE ZERO.
  expected_balance       numeric(14,2),
  ledger_difference      numeric(14,2),
  folio_balance_total    numeric(14,2),

  pre_gl_value           numeric(14,2),
  pre_wiring_value       numeric(14,2),
  dependency_value       numeric(14,2),
  waiting_value          numeric(14,2),
  ready_value            numeric(14,2),
  unclassified_value     numeric(14,2),

  folio_count            integer,
  document_count         integer,
  unposted_count         integer,

  -- AND THE WORST ONE, BY NAME.
  differing_folio_count  integer,
  worst_folio_id         uuid,
  worst_folio_label      text,
  worst_folio_difference numeric(14,2)
)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_tenant  uuid;
  v_account uuid;
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
  -- `guest_ledger` gets a reconciliation of the account it now points at.
  v_account := resolve_account(v_tenant, p_property_id, 'guest_ledger');

  return query
  with r as (
    select * from folio_gl_reconciliation_folios(p_property_id)
  ),
  acct as (
    select coalesce(sum(l.debit - l.credit), 0)::numeric(14,2) as balance
    from journal_entry_lines l
    join journal_entries je on je.id = l.journal_entry_id
    where je.tenant_id   = v_tenant
      and je.property_id = p_property_id
      and l.account_id   = v_account
  ),
  agg as (
    select
      coalesce(sum(r.ledger_balance), 0)::numeric(14,2)     as led,
      coalesce(sum(r.expected_balance), 0)::numeric(14,2)   as expected,
      coalesce(sum(r.ledger_difference), 0)::numeric(14,2)  as diff,
      coalesce(sum(r.folio_balance), 0)::numeric(14,2)      as bill,
      coalesce(sum(r.pre_gl_value), 0)::numeric(14,2)       as pre_gl,
      coalesce(sum(r.pre_wiring_value), 0)::numeric(14,2)   as pre_wiring,
      coalesce(sum(r.dependency_value), 0)::numeric(14,2)   as dependency,
      coalesce(sum(r.waiting_value), 0)::numeric(14,2)      as waiting,
      coalesce(sum(r.ready_value), 0)::numeric(14,2)        as ready,
      coalesce(sum(r.unclassified_value), 0)::numeric(14,2) as unclassified,
      count(*)::integer                                     as folios,
      coalesce(sum(r.document_count), 0)::integer           as docs,
      coalesce(sum(r.unposted_count), 0)::integer           as unposted,
      -- THE COUNT BESIDE THE DIFFERENCE. One folio 12,500 out is an incident;
      -- four hundred folios 12,500 out between them is a different problem
      -- with the same total, and a reader cannot tell them apart from the
      -- total alone.
      count(*) filter (where r.ledger_difference <> 0)::integer as differing
    from r
  ),
  worst as (
    -- The largest SINGLE folio difference, by magnitude, so a big negative is
    -- not hidden behind a small positive.
    select r.folio_id, r.folio_label, r.ledger_difference
    from r
    where r.ledger_difference <> 0
    order by abs(r.ledger_difference) desc, r.folio_id
    limit 1
  )
  select
    p_property_id,
    v_account,
    a.code,
    a.name,
    acct.balance,
    agg.led,
    (acct.balance - agg.led)::numeric(14,2),
    agg.expected,
    agg.diff,
    agg.bill,
    agg.pre_gl,
    agg.pre_wiring,
    agg.dependency,
    agg.waiting,
    agg.ready,
    agg.unclassified,
    agg.folios,
    agg.docs,
    agg.unposted,
    agg.differing,
    w.folio_id,
    w.folio_label,
    coalesce(w.ledger_difference, 0)::numeric(14,2)
  from agg
  cross join acct
  left join worst w on true
  cross join accounts a
  where a.id = v_account;
end;
$$;

revoke all on function folio_gl_reconciliation(uuid) from public;
revoke all on function folio_gl_reconciliation(uuid) from anon;
grant execute on function folio_gl_reconciliation(uuid) to authenticated;

comment on function folio_gl_reconciliation(uuid) is
  'The per-folio reconciliation (3.1) rolled up, plus the one figure a '
  'per-folio read cannot see: the guest_ledger ACCOUNT total, and the gap '
  'between it and the folios that produced it. INVARIANTS, both exactly zero: '
  'ledger_difference (summed from the per-folio rows, each of which must '
  'itself be zero) and outside_folios (guest_ledger carrying something no '
  'folio produced — a manual journal against the guest ledger, or a mapping '
  'repointed after posting, which is 1.1h4c). EVERY figure except the account '
  'balance is an aggregate over 3.1''s rows rather than a second query over the '
  'same data, so the headline cannot contradict the breakdown. It carries the '
  'WORST single folio by name, because a count and a total still leave somebody '
  'opening bills one at a time.';

-- ############################################################################
-- SECTION 4 — THE SELF-VERIFY, ROLLED BACK
-- ############################################################################
-- EIGHTEEN assertions. Twelve about the two set-wise forms, six about the
-- reconciliation built on them.
--
-- THE FIRST TWELVE ARE MOSTLY COMPARISONS RATHER THAN CONSTANTS, and the reason
-- is the measurement in the header: the single-document forms were NOT
-- re-emitted over the set-wise ones, so there are two implementations of each
-- rule — 021's and 064's for one document, this file's for a property at a
-- time. That is a deliberate decision with a figure behind it, and what makes
-- it honest rather than the drift 1.1h2a exists to fix is that assertions 1 and
-- 3 compare the pair on EVERY live folio and EVERY live document. They are the
-- load-bearing two in this file.
--
--   1  THE TWO BALANCE IMPLEMENTATIONS AGREE, on every live folio, on all
--      seven columns: 021's folio_totals (the authority, untouched) against
--      SECTION 1's grouped form (the bulk reader). RED if the grouped form
--      drifts — which is the one defect that would make the reconciliation
--      report a ledger difference that is really a disagreement about what a
--      folio is worth.
--   2  AND THE BULK READER IS SCOPED TO ITS PROPERTY. A folio named with
--      another property's id returns NO ROW rather than that folio's figures.
--      This is a SECURITY DEFINER function, so the scope is the only thing
--      standing between a caller and another property's balances.
--   3  THE TWO CLASSIFIER IMPLEMENTATIONS AGREE, document by document, over
--      every live document: 064's folio_posting_state against SECTION 2's
--      set-wise form. Checked for every document rather than sampled, because
--      if they can disagree anywhere they are two rules.
--   4  AND THEY AGREE FOR A COUNTER IN PARTICULAR, built for the purpose. This
--      is the case the folio filter nearly broke: narrowed to the document
--      alone, a counter is classified with its original absent and reads
--      never_dependency. Asserted on a counter whose original is POSTED, so the
--      right answer is 'ready' or 'posted' and the wrong one is loud.
--   5  NO DEPENDENCY CROSSES A FOLIO. The filter's premise, checked rather than
--      believed — post_charge_reversal copies v_original.folio_id and
--      reverse_payment passes v_payment.folio_id, so this holds structurally,
--      and this is what notices if either ever stops.
--   6  NO DEPENDENCY IS ITSELF A DEPENDENT. The two-pass form's premise. Four
--      refusals make it true today (a counter cannot be reversed, voided or
--      discounted; a payment reversal cannot be voided); if any of them is ever
--      relaxed, the second pass starts resolving against an unresolved answer
--      and this is what says so.
--   7  ALL NINE STATES STILL REACHABLE through the set-wise form, including the
--      two that took work in 064: never_pre_gl on a throwaway property, and
--      ready on a row written around the RPC.
--   8  THE PRECEDENCE IS UNCHANGED, on the two orderings that are observable:
--      never_voided before waiting_not_yet_due, and the dependency before the
--      document's own date.
--   9  THE UNKNOWN-TYPE REFUSAL SURVIVES, by SQLSTATE and message.
--  10  THE POSTING HELPERS STILL BEHAVE, because they read the classifier on
--      every call: a charge posts, a forward night declines, a counter of a
--      pre-wiring charge declines. If the inversion broke any of those, the
--      front desk breaks.
--  11  THE SHAPE. The two set-wise forms SECURITY DEFINER with a pinned
--      search_path and ungranted to `authenticated`; folio_totals and
--      folio_balance keep the grants they had, which is also the check that
--      this file left them alone.
--  12  THE FOLIO-FILTERED CALL IS BOUNDED BY THE FOLIO, not the property —
--      asserted structurally, by requiring it returns fewer rows than the
--      property-wide call. Item 2b's sweep will walk folio by folio.
--
-- AND SIX ABOUT THE RECONCILIATION. The first of them is the one that matters:
-- a reconciliation nobody has seen go red is decoration (rule 27).
--
--  13  THE DISCOUNT FORMULA IS FAITHFUL. 3.1 recomputes what a discount does to
--      the guest's balance from the operational rows, which duplicates
--      post_folio_discount_journal's arithmetic on purpose — two numbers
--      derived independently is what a reconciliation IS. So for every discount
--      that DID post, the recomputation must equal the guest_ledger net of the
--      entry the helper actually wrote. RED if the copy drifts: round-then-
--      difference changed to difference-then-round, or the tax term dropped.
--  14  THE INVARIANT HOLDS ON LIVE DATA, FOLIO BY FOLIO. Every live folio:
--      ledger_difference exactly zero, unclassified_value exactly zero. This is
--      the assertion 061 to 065 were building towards.
--  15  AND ON A FIXTURE THAT REACHES EVERY BUCKET — which is asserted too,
--      because a run where every bucket is zero proves nothing about the
--      buckets (rule 27's third shape: a fixture already in the state being
--      asserted). pre_gl, pre_wiring, dependency, waiting and ready must each
--      be non-zero SOMEWHERE across the two properties, and every folio's
--      difference must still be zero.
--  16  A PLANTED DIFFERENCE IS DETECTED, TO THE KOBO, AND NAMED. Charges'
--      net_amounts are moved behind the RPC's back, so the bill and the journal
--      genuinely disagree by figures this block chose. THREE plants, each
--      answering a different way the detection could be dead:
--        * one on a charge that never posted, which the ready bucket must
--          FOLLOW, leaving the invariant at zero — a bucket reading a stale
--          figure fails here, and would otherwise absorb the plants below;
--        * one of -2,500 on a POSTED charge, which nothing can absorb;
--        * one of +1,000 on a second folio, so the two differences have
--          OPPOSITE SIGNS. Without it "the worst by magnitude" and "the largest
--          value" are the same answer and neither is tested, and a rollup that
--          summed absolute values would stay green (rule 27's fourth shape).
--      Asserted: each folio's difference exactly the planted figure,
--      differing_folio_count 2, the headline naming the -2,500 folio as the
--      worst, that folio sorting FIRST in the breakdown, and the rolled-up
--      difference being -1,500 rather than either plant alone.
--      THIS IS THE ASSERTION THE WHOLE SHIPMENT RESTS ON. Every other green
--      number in this file is worth exactly what this one is, because a
--      reconciliation nobody has watched go red is decoration.
--  17  OUTSIDE_FOLIOS CATCHES A JOURNAL NO FOLIO PRODUCED. A manual entry
--      against guest_ledger under a source document type no folio uses: the
--      per-folio rows cannot see it, so the account-level figure must. RED if
--      3.2's account side were derived from the per-folio rows instead of read
--      from the account — which is the tempting simplification, because every
--      other figure in 3.2 IS a rollup of them, and it would make this one
--      structurally zero and the check vacuous. Asserted in both directions:
--      outside_folios moves by exactly 7,777.00, and the per-folio invariant
--      does NOT move, because the folios are unchanged.
--  18  THE GUARDS ARE ON BOTH RECONCILIATION FUNCTIONS, and a non-member is
--      REFUSED rather than handed zeros. 051's first draft lost DEFINER and the
--      is_tenant_staff gate by rewriting from memory, and no assertion noticed —
--      a human reading the diff did. Matched on the sqlstate AND on a message
--      that names this property's LEDGER, because resolve_account can also
--      refuse inside 3.2 and a pattern loose enough to accept its refusal would
--      be satisfied by the gate's deletion (rule 27's sixth shape).
do $$
declare
  v_tenant  uuid;
  v_user    uuid;
  v_prop    uuid;
  v_prop2   uuid;
  v_rt      uuid;
  v_guest   uuid;
  v_cat     uuid;
  v_folio   folios;
  v_folio2  folios;
  v_a       folio_charges;
  v_ctr     folio_charges;
  v_c3      folio_charges;
  v_c2      folio_charges;
  v_c4      folio_charges;
  v_c5      folio_charges;
  v_c6      folio_charges;
  v_c7      folio_charges;
  v_c8      folio_charges;
  v_folio3  folios;
  v_folio4  folios;
  v_folio5  folios;
  v_pay     folio_payments;
  v_pay2    folio_payments;
  v_dres    numeric(14,2);
  v_fwd     folio_charges;
  v_pre     folio_charges;
  v_bk      bookings;
  v_disc    uuid;
  v_st      text;
  v_st2     text;
  v_n       integer;
  v_bad     integer;
  v_amt     numeric;
  v_err     text;
  v_state   text;
  v_ok      boolean;
  v_fail    text := '';
  v_seen    text[];
  v_amt_id  uuid;
  v_head    record;
  v_row     record;
  v_diff    numeric(14,2);
  v_plant   numeric(14,2) := 2500.00;
  v_first   uuid;
  v_b1      numeric(14,2);
  v_b2      numeric(14,2);
  v_b3      numeric(14,2);
  v_b4      numeric(14,2);
begin
  begin
    select tu.tenant_id, tu.user_id into v_tenant, v_user
    from tenant_users tu where tu.is_active and tu.role in ('owner','manager') limit 1;
    select p.id into v_prop from properties p where p.tenant_id = v_tenant limit 1;
    if v_tenant is null or v_prop is null then
      raise notice '066 SELF-VERIFY SKIPPED: no tenant or active owner/manager.';
      raise exception 'ZZ_066_FIXTURE_DONE';
    end if;
    perform set_config('request.jwt.claims',
      json_build_object('role','service_role','sub', v_user::text)::text, true);

    -- THIS OVERWRITES A REAL MANAGER'S PIN, and it is only safe because the
    -- ZZ_066_FIXTURE_DONE sentinel below guarantees this block rolls back — the
    -- raise is unconditional, so no path commits it. Anyone copying this
    -- pattern into something that COMMITS must use a throwaway user instead.
    insert into manager_pins (tenant_id, user_id, pin_hash)
    values (v_tenant, v_user, crypt('4066', gen_salt('bf')))
    on conflict (tenant_id, user_id) do update set pin_hash = excluded.pin_hash;

    select cc.id into v_cat from charge_categories cc
    where cc.tenant_id = v_tenant and cc.is_taxable and cc.deleted_at is null
      and cc.is_active and cc.code <> 'room' order by cc.code limit 1;
    select rt.id into v_rt from room_types rt
    where rt.tenant_id = v_tenant and rt.deleted_at is null order by rt.base_rate limit 1;
    if v_cat is null or v_rt is null then
      raise exception '066 SELF-VERIFY needs a taxable non-room category and a room type.';
    end if;

    -- ===================== 1: folio_totals IS UNCHANGED ===================
    -- Compared against the arithmetic it now wraps, on EVERY live folio. The
    -- two cannot be compared against a constant: the point is that the
    -- re-emission did not change an answer, so the old answer is the oracle.
    select count(*)::integer into v_bad
    from folios f
    cross join lateral folio_totals(f.id) t
    join folio_totals_by_folio(f.property_id, f.id) g on true
    where t.gross_total    is distinct from g.gross_total::numeric
       or t.discount_total is distinct from g.discount_total::numeric
       or t.net_total      is distinct from g.net_total::numeric
       or t.tax_total      is distinct from g.tax_total::numeric
       or t.charges_total  is distinct from g.charges_total::numeric
       or t.payments_total is distinct from g.payments_total::numeric
       or t.balance        is distinct from g.balance::numeric;
    if v_bad > 0 then
      v_fail := v_fail || format(
        '1: folio_totals disagrees with folio_totals_by_folio on %s live folio(s). A drift between the two reads as a LEDGER difference in item 8 and the reconciliation reports the one thing it exists to disprove. ',
        v_bad);
    end if;
    select count(*)::integer into v_n from folios;
    if v_n = 0 then
      v_fail := v_fail || '1: no live folios, so this comparison is vacuous. ';
    end if;

    -- ===================== 2: SCOPED TO ITS PROPERTY ======================
    -- A DEFINER function's scope is the only thing between a caller and another
    -- property's balances. Both directions, because "returns no rows" is also
    -- what a function that returns nothing at all does — and that would pass
    -- the negative half on its own (rule 27: an assertion that cannot tell
    -- working from absent).
    select fl.id into v_amt_id from folios fl where fl.property_id = v_prop limit 1;
    if v_amt_id is null then
      v_fail := v_fail || '2: no folio at this property, so the scope check is vacuous. ';
    else
      select count(*)::integer into v_n
      from folio_totals_by_folio(gen_random_uuid(), v_amt_id);
      if v_n <> 0 then
        v_fail := v_fail || format(
          '2: folio_totals_by_folio returned %s row(s) for a folio named under ANOTHER property''s id. It is SECURITY DEFINER, so that is a cross-property read with nothing above it to stop it. ', v_n);
      end if;
      select count(*)::integer into v_n
      from folio_totals_by_folio(v_prop, v_amt_id);
      if v_n <> 1 then
        v_fail := v_fail || format(
          '2: and under its OWN property it returned %s row(s) rather than 1 — so the check above proves nothing, because a function that returns nothing passes it. ', v_n);
      end if;
    end if;

    -- ===================== 5, 6: THE TWO PREMISES =========================
    select count(*)::integer into v_bad
    from folio_charges ctr join folio_charges o on o.id = ctr.reversal_of_charge_id
    where ctr.folio_id <> o.folio_id;
    select v_bad + count(*)::integer into v_bad
    from folio_payments ctr join folio_payments o on o.id = ctr.reversal_of_payment_id
    where ctr.folio_id <> o.folio_id;
    if v_bad > 0 then
      v_fail := v_fail || format(
        '5: %s counter(s) sit on a different folio from the document they reverse. THE FILTER IS THE FOLIO, so a dependency on another folio would be classified as absent and read never_dependency — a postable counter reported as permanently unpostable. ',
        v_bad);
    end if;

    select count(*)::integer into v_bad
    from folio_posting_states(v_prop) a
    join folio_posting_states(v_prop) b
      on b.document_type = a.depends_on_type and b.document_id = a.depends_on_id
    where a.depends_on_id is not null and b.depends_on_id is not null;
    if v_bad > 0 then
      v_fail := v_fail || format(
        '6: %s document(s) depend on something that is ITSELF a dependent, so the chain is deeper than two and the two-pass form resolves against an unresolved answer. Four refusals make this impossible today; if one was relaxed, this is what noticed. ',
        v_bad);
    end if;

    -- ===================== 14: THE INVARIANT, ON LIVE DATA ================
    -- BEFORE the fixture, so this figure is about Heledon's books rather than
    -- about rows this file wrote. 061 to 065 were building towards exactly this
    -- line, and 065 found a real defect on the way; if anything is still out,
    -- this is where it says so and by how much.
    select count(*)::integer,
           coalesce(sum(abs(r.ledger_difference)), 0),
           coalesce(sum(abs(r.unclassified_value)), 0)
      into v_bad, v_diff, v_amt
    from folio_gl_reconciliation_folios(v_prop) r
    where r.ledger_difference <> 0 or r.unclassified_value <> 0;
    if v_bad > 0 then
      select string_agg(format('%s: ledger %s vs expected %s (diff %s, unclassified %s)',
               r.folio_label, r.ledger_balance, r.expected_balance,
               r.ledger_difference, r.unclassified_value), '; ')
        into v_err
      from folio_gl_reconciliation_folios(v_prop) r
      where r.ledger_difference <> 0 or r.unclassified_value <> 0;
      v_fail := v_fail || format(
        '14: %s LIVE folio(s) do not reconcile — %s of difference and %s unclassified. %s. ',
        v_bad, v_diff, v_amt, left(v_err, 600));
    end if;
    select count(*)::integer into v_n from folio_gl_reconciliation_folios(v_prop);
    if v_n = 0 then
      v_fail := v_fail || '14: no folios at this property, so the live invariant is vacuous. ';
    end if;

    -- ===================== THE FIXTURE ====================================
    insert into guests (tenant_id, first_name, last_name, created_by)
    values (v_tenant, 'ZZ066', 'Inversion', v_user) returning id into v_guest;
    v_folio := open_guest_folio(v_tenant, v_prop, v_guest, 'zz066-folio-1');

    -- a posted charge and its counter: assertion 4's subject
    v_a := post_charge(v_folio.id, v_cat, 'ZZ066 dinner', 1, 14000, current_date - 1,
                       'zz066-c-a', 'manual');
    perform reverse_charge(v_a.id, 'ZZ066 keyed in error', '4066', 'zz066-rc-a');
    select * into v_ctr from folio_charges
    where reversal_of_charge_id = v_a.id order by created_at desc limit 1;

    -- a forward night, for the decline and for waiting_*
    insert into guests (tenant_id, first_name, last_name, created_by)
    values (v_tenant, 'ZZ066', 'Early', v_user) returning id into v_guest;
    v_bk := create_booking(v_prop, v_rt, v_guest, current_date, current_date + 4,
                           1, 'zz066-bk', 0, null, 'guest', null, null);
    perform check_in_booking(v_bk.id, 'zz066-ci', now());
    perform check_out_booking(v_bk.id, 'zz066-co');
    select fc.* into v_fwd from folio_charges fc join folios f on f.id = fc.folio_id
    where f.booking_id = v_bk.id and fc.source = 'room' and fc.charge_date > current_date
    order by fc.charge_date limit 1;

    -- a live PRE-WIRING charge, for never_pre_wiring and never_dependency
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
      raise exception '066 SELF-VERIFY needs a pre-wiring charge still open to action.';
    end if;

    -- ===================== 4: THE COUNTER, BOTH WAYS ======================
    v_st  := folio_posting_state('folio_charge', v_ctr.id);
    select s.state into v_st2 from folio_posting_states(v_prop) s
    where s.document_type = 'folio_charge' and s.document_id = v_ctr.id;
    if v_st is distinct from v_st2 then
      v_fail := v_fail || format(
        '4: a counter reads %s through the filtered call and %s through the property-wide one. THE CASE THE FILTER NEARLY BROKE: narrowed to the document alone it would read never_dependency, confidently, for a counter whose original is posted. ',
        v_st, v_st2);
    end if;
    if v_st not in ('posted','ready') then
      v_fail := v_fail || format(
        '4: a counter of a POSTED charge reads %s, expected posted or ready. Its original is in the books, so nothing is waiting and nothing is permanent. ', v_st);
    end if;

    -- ===================== 7: ALL NINE STATES =============================
    insert into properties (tenant_id, name, slug, created_by)
    values (v_tenant, 'ZZ066 Throwaway', 'zz066-throwaway', v_user) returning id into v_prop2;
    update property_finance_settings set gl_start_date = current_date
     where property_id = v_prop2;
    insert into guests (tenant_id, first_name, last_name, created_by)
    values (v_tenant, 'ZZ066', 'Pre GL', v_user) returning id into v_guest;
    v_folio2 := open_guest_folio(v_tenant, v_prop2, v_guest, 'zz066-folio-pregl');
    v_c2 := post_charge(v_folio2.id, v_cat, 'ZZ066 before the books opened', 1, 9000,
                        current_date - 1, 'zz066-c-pregl', 'manual');

    -- a row written AROUND the RPC, so no posting call fired: 'ready'
    insert into folio_charges (tenant_id, property_id, folio_id, charge_category_id,
                               description, quantity, unit_amount, gross_amount,
                               discount_amount, net_amount, charge_date, source,
                               account_role_key, created_by)
    select v_tenant, v_prop, v_folio.id, v_cat, 'ZZ066 around the RPC',
           1, 1500, 1500, 0, 1500, current_date - 1, 'manual', cc.account_role_key, v_user
    from charge_categories cc where cc.id = v_cat
    returning * into v_c3;

    -- A POSTED CHARGE WITH A POSTED DISCOUNT, for assertion 13. There is no
    -- posted discount in Heledon's live data yet, and the only way to pin the
    -- reconciliation's copy of 061's tax-delta formula is against an entry
    -- post_folio_discount_journal actually wrote. The category is taxable, so
    -- the tax term is exercised rather than multiplied by nothing.
    v_c4 := post_charge(v_folio.id, v_cat, 'ZZ066 laundry', 1, 8000, current_date - 1,
                        'zz066-c-disc', 'manual');
    perform apply_charge_discount(v_c4.id, 1500, 'ZZ066 goodwill', '4066', 'zz066-k-disc');

    -- A SECOND FOLIO WITH A POSTED CHARGE, so assertion 16 can plant a
    -- difference of the OPPOSITE SIGN. With one differing folio, "the worst by
    -- magnitude" and "the largest value" are the same answer, and an assertion
    -- that cannot tell them apart cannot test either (rule 27's fourth shape).
    insert into guests (tenant_id, first_name, last_name, created_by)
    values (v_tenant, 'ZZ066', 'Second', v_user) returning id into v_guest;
    v_folio3 := open_guest_folio(v_tenant, v_prop, v_guest, 'zz066-folio-2');
    v_c5 := post_charge(v_folio3.id, v_cat, 'ZZ066 bar', 1, 6000, current_date - 1,
                        'zz066-c-2', 'manual');

    -- ---- A POSTED DOCUMENT WITH AN UNPOSTED ONE HANGING OFF IT -----------
    -- Branches 2 and 3 of `contrib` — a discount and a payment outside the
    -- books on a folio whose charge is IN them — had no fixture at all, and the
    -- breakage run is what said so: dropping the tax term from the discount
    -- formula and dropping payments from SECTION 1's balance BOTH stayed green.
    --
    -- Reaching that state takes some care, and the first attempt was wrong in
    -- an instructive way: it applied the documents through their RPCs and then
    -- DELETED the journal entries. Postgres refused — PT403, 'Journal entries
    -- are permanent and cannot be deleted' (044's trigger) — and the refusal
    -- was right. A fixture that disabled that trigger to get its way would be a
    -- harness permitted to do something production cannot, which is the same
    -- class of lie as a dry run more permissive than the real thing.
    --
    -- So the state is reached LEGITIMATELY, on the throwaway property: post the
    -- charge and the first payment while the books are open, then move
    -- gl_start_date FORWARD, and the documents keyed afterwards decline because
    -- post_journal returns null for an entry dated before the books opened.
    -- Everything already posted stays posted, because 'posted' beats the
    -- calendar (064's precedence, step 1) — which this also demonstrates.
    -- TWO IDENTICAL CHARGES ON ONE FOLIO, and the discounts are the twins: one
    -- applied while the books are open so the helper writes its entry, one
    -- applied after they close so the reconciliation has to compute it. Same
    -- property, so the tax rates are the same BY CONSTRUCTION rather than by a
    -- fixture copying them — the first attempt copied v_prop's tax_charges
    -- across and hit a unique violation, because a new property is already
    -- seeded its own, which would have left the two sides on different rates
    -- and the comparison meaningless in a way nothing would have shown.
    insert into guests (tenant_id, first_name, last_name, created_by)
    values (v_tenant, 'ZZ066', 'Discount', v_user) returning id into v_guest;
    v_folio4 := open_guest_folio(v_tenant, v_prop2, v_guest, 'zz066-folio-3');
    -- 1,000.00 WITH 1.25 OFF, AND THE ODD-LOOKING FIGURES ARE THE POINT. At
    -- this property's VAT rate those are numbers where 061's ROUND-THEN-
    -- DIFFERENCE gives -0.09 and the obvious DIFFERENCE-THEN-ROUND gives -0.10.
    -- With round numbers the two agree, and the breakage run proved what that
    -- costs: rewriting the formula the wrong way round stayed GREEN on a
    -- fixture of 8,000 with 1,500 off, because there the two answers coincide
    -- (rule 27's fourth shape, exactly). Assertion 13 re-checks that they still
    -- diverge here, so a changed VAT rate tells us rather than quietly
    -- disarming the assertion.
    v_c6 := post_charge(v_folio4.id, v_cat, 'ZZ066 rounding twin A', 1, 1000,
                        current_date, 'zz066-c-3a', 'manual');
    v_c8 := post_charge(v_folio4.id, v_cat, 'ZZ066 rounding twin B', 1, 1000,
                        current_date, 'zz066-c-3b', 'manual');
    -- the one that posts, and the figure the helper itself produced for it
    perform apply_charge_discount(v_c8.id, 1.25, 'ZZ066 goodwill posted', '4066', 'zz066-k-3b');
    select d.id into v_disc from folio_charge_discounts d
    where d.folio_charge_id = v_c8.id order by d.seq desc limit 1;
    select coalesce(sum(l.debit - l.credit), 0)::numeric(14,2) into v_dres
    from journal_entry_lines l
    join journal_entries je on je.id = l.journal_entry_id
    where je.source_document_type = 'folio_charge_discount'
      and je.source_document_id = v_disc
      and l.role_key = 'guest_ledger';
    -- and the tax term must actually be in it, or half the formula is untested
    select count(*)::integer into v_n from folio_charge_tax_lines tl
    where tl.folio_charge_id = v_c8.id and tl.rate > 0 and tl.amount <> 0;
    if v_n = 0 then
      v_fail := v_fail || '13: the twin charge carries no tax, so the tax delta in the discount formula is multiplied by nothing and the half most likely to be wrong is untested. ';
    end if;
    -- AND THE FIXTURE MUST BE ABLE TO TELL THE TWO ROUNDING ORDERS APART.
    select coalesce(sum(round((v_c8.gross_amount - 1.25) * tl.rate, 2)
                      - round( v_c8.gross_amount         * tl.rate, 2)), 0),
           coalesce(sum(round(-1.25 * tl.rate, 2)), 0)
      into v_b1, v_b2
    from folio_charge_tax_lines tl where tl.folio_charge_id = v_c8.id;
    if v_b1 = v_b2 then
      v_fail := v_fail || format(
        '13: at this property''s tax rates, round-then-difference and difference-then-round both give %s for these amounts, so the fixture cannot tell 061''s rounding structure from the obvious wrong one. Pick amounts where they diverge. ',
        v_b1);
    end if;

    insert into guests (tenant_id, first_name, last_name, created_by)
    values (v_tenant, 'ZZ066', 'Payer', v_user) returning id into v_guest;
    v_folio5 := open_guest_folio(v_tenant, v_prop2, v_guest, 'zz066-folio-4');
    v_c7 := post_charge(v_folio5.id, v_cat, 'ZZ066 restaurant', 1, 20000,
                        current_date, 'zz066-c-4', 'manual');
    v_pay := record_payment(v_folio5.id, 5000, 'cash', 'ZZ066-REF-1',
                            current_date, 'zz066-p-1');

    -- the books close behind them
    update property_finance_settings set gl_start_date = current_date + 1
     where property_id = v_prop2;

    perform apply_charge_discount(v_c6.id, 1.25, 'ZZ066 goodwill twin', '4066', 'zz066-k-3');
    v_pay2 := record_payment(v_folio5.id, 3000, 'pos', 'ZZ066-REF-2',
                             current_date, 'zz066-p-2');

    -- a night voided before its day: never_voided, and its void: never_dependency
    select fc.* into v_c2 from folio_charges fc join folios f on f.id = fc.folio_id
    where f.booking_id = v_bk.id and fc.source = 'room' and fc.charge_date > current_date
      and fc.id <> v_fwd.id
    order by fc.charge_date desc limit 1;
    perform void_charge(v_c2.id, 'ZZ066 voided before its night', 'zz066-vc');

    -- a discount on a pre-wiring charge: never_dependency
    perform apply_charge_discount(v_pre.id, 500, 'ZZ066 on a pre-wiring charge',
                                  '4066', 'zz066-k-pre');

    -- and a counter whose ORIGINAL is still waiting, which is the only way to
    -- reach waiting_for_dependency: reversing a night that has not arrived.
    perform reverse_charge(v_fwd.id, 'ZZ066 the rest of the stay is cancelled',
                           '4066', 'zz066-rc-fwd');

    select array_agg(distinct s.state) into v_seen
    from (select state from folio_posting_states(v_prop)
          union all select state from folio_posting_states(v_prop2)
          union all select folio_posting_state('folio_charge', gen_random_uuid())) s;
    foreach v_st in array array['posted','ready','absent','never_pre_gl','never_pre_wiring',
                               'never_voided','never_dependency','waiting_not_yet_due',
                               'waiting_for_dependency']
    loop
      if not (v_st = any(v_seen)) then
        v_fail := v_fail || format(
          '7: no document reached %s through the set-wise form, so nothing proves it is still reachable. ', v_st);
      end if;
    end loop;

    -- ===================== 3: EVERY DOCUMENT, BOTH WAYS ===================
    -- Not sampled: if the two implementations can disagree anywhere, they are
    -- two rules. Over both properties, so the throwaway's pre-GL documents are
    -- in it too.
    --
    -- AND IT RUNS HERE, AFTER THE WHOLE FIXTURE, BECAUSE IT RAN EARLIER AND WAS
    -- VACUOUS. With it placed before the state-coverage block, no
    -- never_dependency document existed yet — Heledon's live books have none
    -- since 065 — so breaking the set-wise form's never_dependency branch left
    -- this assertion GREEN while assertion 7 caught it by accident. That is
    -- rule 27's third shape: a fixture not yet in the state being asserted.
    select count(*)::integer into v_bad
    from (select * from folio_posting_states(v_prop)
          union all select * from folio_posting_states(v_prop2)) s
    where s.state is distinct from folio_posting_state(s.document_type, s.document_id);
    if v_bad > 0 then
      select string_agg(format('%s %s: set-wise %s, single %s',
               s.document_type, substr(s.document_id::text, 1, 8), s.state,
               folio_posting_state(s.document_type, s.document_id)), '; ')
        into v_err
      from (select * from folio_posting_states(v_prop)
            union all select * from folio_posting_states(v_prop2)) s
      where s.state is distinct from folio_posting_state(s.document_type, s.document_id);
      v_fail := v_fail || format(
        '3: %s document(s) are classified differently by 064''s single-document form and this file''s set-wise one: %s. Two answers to one rule is the drift this file''s own header says these assertions exist to prevent. ',
        v_bad, left(v_err, 400));
    end if;
    select count(*)::integer into v_n from folio_posting_states(v_prop);
    if v_n < 10 then
      v_fail := v_fail || format(
        '3: only %s documents at this property, so the comparison is too thin to mean much. ', v_n);
    end if;
    -- AND depends_on_state, WHICH THREE OF THE RECONCILIATION'S FIVE BRANCHES
    -- NOW READ. It exists because self-joining this function cost thirteen
    -- seconds, so it is a performance fix that changed an ANSWER's source — and
    -- that is the kind of change that needs an assertion rather than a comment.
    select count(*)::integer into v_bad
    from (select * from folio_posting_states(v_prop)
          union all select * from folio_posting_states(v_prop2)) s
    where s.depends_on_id is not null
      and s.depends_on_state is distinct from
          folio_posting_state(s.depends_on_type, s.depends_on_id);
    if v_bad > 0 then
      v_fail := v_fail || format(
        '3: %s document(s) carry a depends_on_state that disagrees with what the classifier says about that dependency. Branches 2, 4 and 5 of the reconciliation decide whether to bucket on this column, so a wrong value here is a bucket silently missing or doubled. ',
        v_bad);
    end if;
    select count(*)::integer into v_n
    from (select * from folio_posting_states(v_prop)
          union all select * from folio_posting_states(v_prop2)) s
    where s.depends_on_id is not null;
    if v_n = 0 then
      v_fail := v_fail || '3: no document has a dependency, so depends_on_state is unpinned. ';
    end if;

    -- and every one of the nine states must be represented in what was just
    -- compared, or the comparison skipped the branches that matter.
    select count(distinct s.state)::integer into v_n
    from (select * from folio_posting_states(v_prop)
          union all select * from folio_posting_states(v_prop2)) s;
    if v_n < 8 then
      v_fail := v_fail || format(
        '3: only %s distinct states appear in the compared set, of the 8 reachable through a property call. A pin that never sees a branch does not pin it. ', v_n);
    end if;

    -- ===================== 1b: AND THE BALANCE PAIR, AFTER THE FIXTURE ====
    -- Assertion 1 ran on live folios, which have no payments and no voided
    -- charges. The fixture has both, so the comparison is repeated here — and
    -- it had to be: dropping payments from SECTION 1's balance passed the live
    -- comparison, because no live folio had ever been paid.
    select count(*)::integer into v_bad
    from folios f
    cross join lateral folio_totals(f.id) t
    join folio_totals_by_folio(f.property_id, f.id) g on true
    where f.property_id in (v_prop, v_prop2)
      and (t.gross_total    is distinct from g.gross_total::numeric
        or t.discount_total is distinct from g.discount_total::numeric
        or t.net_total      is distinct from g.net_total::numeric
        or t.tax_total      is distinct from g.tax_total::numeric
        or t.charges_total  is distinct from g.charges_total::numeric
        or t.payments_total is distinct from g.payments_total::numeric
        or t.balance        is distinct from g.balance::numeric);
    if v_bad > 0 then
      v_fail := v_fail || format(
        '1: folio_totals and folio_totals_by_folio disagree on %s folio(s) once payments and voided charges are in play. ', v_bad);
    end if;
    select count(*)::integer into v_n
    from folios f cross join lateral folio_totals(f.id) t
    where f.property_id in (v_prop, v_prop2) and t.payments_total <> 0;
    if v_n = 0 then
      v_fail := v_fail || '1: no folio in the compared set has a payment, so the payments side of the balance is still unpinned — which is exactly what let a breakage that dropped payments entirely stay green. ';
    end if;

    -- ===================== 8: THE PRECEDENCE ==============================
    v_st := folio_posting_state('folio_charge', v_c2.id);
    if v_st <> 'never_voided' then
      v_fail := v_fail || format(
        '8: a night voided before its day reads %s, expected never_voided — voided must beat the calendar, or the sweep returns to it every morning forever. ', v_st);
    end if;
    select d.id into v_disc from folio_charge_discounts d
    where d.folio_charge_id = v_pre.id order by d.seq desc limit 1;
    v_st := folio_posting_state('folio_charge_discount', v_disc);
    if v_st <> 'never_dependency' then
      v_fail := v_fail || format(
        '8: an application on a pre-wiring charge reads %s, expected never_dependency — the dependency must beat the document''s own date. ', v_st);
    end if;

    -- ===================== 9: THE UNKNOWN TYPE ============================
    v_ok := false; v_err := null; v_state := null;
    begin
      perform folio_posting_state('folio_nonsense', gen_random_uuid());
      v_ok := true;
    exception when others then v_err := sqlerrm; v_state := sqlstate; end;
    if v_ok or v_state is distinct from 'PT422'
       or v_err not like '%Unknown folio document type%' then
      v_fail := v_fail || format(
        '9: an unknown document type was answered by %s / %s. ',
        coalesce(v_state, 'a returned state'), coalesce(v_err, '(no error)'));
    end if;

    -- ===================== 10: THE POSTING HELPERS STILL BEHAVE ===========
    -- They read the classifier on every call, so an inversion that broke it
    -- breaks the front desk rather than a report.
    select count(*)::integer into v_n from journal_entries je
    where je.source_document_type = 'folio_charge' and je.source_document_id = v_a.id;
    if v_n <> 1 then
      v_fail := v_fail || format('10: the posted charge has %s entr(ies), expected 1. ', v_n);
    end if;
    select count(*)::integer into v_n from journal_entries je
    where je.source_document_type = 'folio_charge' and je.source_document_id = v_fwd.id;
    if v_n <> 0 then
      v_fail := v_fail || format(
        '10: a forward-dated night posted %s entr(ies). The decline runs through the classifier, so this is what says the inversion kept it. ', v_n);
    end if;
    perform reverse_charge(v_pre.id, 'ZZ066 reversing a pre-wiring charge', '4066', 'zz066-rc-pre');
    select count(*)::integer into v_n from journal_entries je
    where je.source_document_type = 'folio_charge'
      and je.source_document_id in (select id from folio_charges
                                    where reversal_of_charge_id = v_pre.id);
    if v_n <> 0 then
      v_fail := v_fail || format(
        '10: the counter of a pre-wiring charge posted %s entr(ies) — 064''s defect, reopened by the inversion. ', v_n);
    end if;

    -- ===================== 12: BOUNDED BY THE FOLIO =======================
    select count(*)::integer into v_n from folio_posting_states(v_prop, v_folio.id);
    select count(*)::integer into v_bad from folio_posting_states(v_prop);
    if v_n >= v_bad then
      v_fail := v_fail || format(
        '12: the folio-filtered call returns %s rows and the property-wide one %s. The single-document path must be bounded by ONE FOLIO: 064''s helpers call it on every charge, discount and payment as they post, so a filter that computed the property would make posting at the desk slower every month the hotel trades. ',
        v_n, v_bad);
    end if;

    -- ===================== 11: THE SHAPE ==================================
    select count(*)::integer into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('folio_totals_by_folio','folio_posting_states')
      and (not p.prosecdef
           or p.proconfig is null
           or not exists (select 1 from unnest(p.proconfig) cfg where cfg like 'search_path=public%')
           or has_function_privilege('authenticated', p.oid, 'EXECUTE'));
    if v_bad > 0 then
      v_fail := v_fail || format(
        '11: %s of the two new functions lost SECURITY DEFINER, lost its pinned search_path, or became executable by `authenticated`. ', v_bad);
    end if;
    select count(*)::integer into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('folio_totals','folio_balance')
      and (not has_function_privilege('authenticated', p.oid, 'EXECUTE')
           or has_function_privilege('anon', p.oid, 'EXECUTE'));
    if v_bad > 0 then
      v_fail := v_fail || format(
        '11: %s of folio_totals / folio_balance is not executable by authenticated, or IS by anon. Neither signature changed, so neither was dropped and neither should have lost its ACL. ', v_bad);
    end if;

    -- ===================== 13: THE DISCOUNT FORMULA IS FAITHFUL ===========
    -- 3.1 recomputes what a discount does to the guest's balance, which copies
    -- post_folio_discount_journal's arithmetic on purpose. This is the one
    -- expression in the reconciliation that can drift from a posting helper
    -- without anything else noticing, so it is pinned against THE HELPER'S OWN
    -- ENTRY: v_dres was read off the entry the helper wrote for this very
    -- discount, before that entry was deleted to put the document through
    -- branch 2.
    --
    -- THE FIRST VERSION OF THIS ASSERTION WAS RULE 27'S FIRST SHAPE and both
    -- breakages walked past it: it carried its OWN copy of the formula in a
    -- lateral and compared that to the entry, so breaking the function's copy
    -- changed nothing it looked at. It is now read out of the function, as a
    -- bucket, on a folio that holds nothing else unposted.
    select * into v_row from folio_gl_reconciliation_folios(v_prop2) r
    where r.folio_id = v_folio4.id;
    if v_row.pre_gl_value is distinct from v_dres then
      v_fail := v_fail || format(
        '13: the reconciliation values the unposted discount at %s; the entry post_folio_discount_journal wrote for its arithmetical twin was %s. The copy of 061''s formula has drifted, and every bucket derived from it is wrong by that much. ',
        v_row.pre_gl_value, v_dres);
    end if;
    if v_dres is null or v_dres = 0 then
      v_fail := v_fail || format(
        '13: the helper''s own figure for that discount is %s, so the pin has nothing to compare against. A taxable category and a non-zero relief are both required for this assertion to mean anything. ',
        coalesce(v_dres::text, 'null'));
    end if;
    if v_row.ledger_difference <> 0 then
      v_fail := v_fail || format(
        '13: and that folio does not reconcile — difference %s. A posted charge with one unposted discount is the simplest case branch 2 exists for. ',
        v_row.ledger_difference);
    end if;

    -- AND THE SAME PIN FOR A PAYMENT (branch 3), which had no fixture at all
    -- until the breakage run found that dropping payments from the balance
    -- stayed green.
    select * into v_row from folio_gl_reconciliation_folios(v_prop2) r
    where r.folio_id = v_folio5.id;
    if v_row.pre_gl_value is distinct from -v_pay2.amount then
      v_fail := v_fail || format(
        '13: the reconciliation values the unposted payment at %s rather than %s. A payment outside the books is negative: the bill shows it reducing what is owed and the ledger does not. ',
        v_row.pre_gl_value, -v_pay2.amount);
    end if;
    if v_row.ledger_difference <> 0 then
      v_fail := v_fail || format(
        '13: and the paid folio does not reconcile — difference %s, with one posted payment and one unposted. ',
        v_row.ledger_difference);
    end if;

    -- ===================== 15: EVERY BUCKET REACHED, STILL ZERO ===========
    -- A run in which every bucket is zero proves nothing about the buckets, so
    -- the fixture is built to reach each one and that is asserted rather than
    -- assumed. The two properties together: v_prop holds pre_wiring, dependency,
    -- waiting and ready; v_prop2 holds pre_gl.
    select coalesce(sum(r.pre_wiring_value), 0), coalesce(sum(r.dependency_value), 0),
           coalesce(sum(r.waiting_value), 0),    coalesce(sum(r.ready_value), 0)
      into v_b1, v_b2, v_b3, v_b4
    from folio_gl_reconciliation_folios(v_prop) r;
    if v_b1 = 0 then v_fail := v_fail || '15: pre_wiring_value is zero everywhere, so that bucket is untested. '; end if;
    if v_b2 = 0 then v_fail := v_fail || '15: dependency_value is zero everywhere — the counter of a never-posting charge is what this bucket exists for. '; end if;
    if v_b3 = 0 then v_fail := v_fail || '15: waiting_value is zero everywhere, so a forward-dated night is not reaching it. '; end if;
    if v_b4 = 0 then v_fail := v_fail || '15: ready_value is zero everywhere, so the row written around the RPC is not reaching it. '; end if;
    select coalesce(sum(r.pre_gl_value), 0) into v_amt
    from folio_gl_reconciliation_folios(v_prop2) r;
    if v_amt = 0 then
      v_fail := v_fail || '15: pre_gl_value is zero on the throwaway property, so the bucket that first becomes reachable on GO-LIVE MORNING is untested. ';
    end if;
    select count(*)::integer into v_bad
    from (select * from folio_gl_reconciliation_folios(v_prop)
          union all select * from folio_gl_reconciliation_folios(v_prop2)) r
    where r.ledger_difference <> 0 or r.unclassified_value <> 0;
    if v_bad > 0 then
      select string_agg(format('%s: diff %s, unclassified %s, buckets %s/%s/%s/%s/%s',
               r.folio_label, r.ledger_difference, r.unclassified_value,
               r.pre_gl_value, r.pre_wiring_value, r.dependency_value,
               r.waiting_value, r.ready_value), '; ')
        into v_err
      from (select * from folio_gl_reconciliation_folios(v_prop)
            union all select * from folio_gl_reconciliation_folios(v_prop2)) r
      where r.ledger_difference <> 0 or r.unclassified_value <> 0;
      v_fail := v_fail || format(
        '15: %s folio(s) do not reconcile once every bucket is in play: %s. ', v_bad, left(v_err, 600));
    end if;

    -- ===================== 16: A PLANTED DIFFERENCE IS DETECTED ============
    -- THE ASSERTION THE WHOLE SHIPMENT RESTS ON. Every other green figure here
    -- is worth exactly what this one is: a reconciliation nobody has watched go
    -- red is decoration. The bill is moved behind the RPC's back, so the journal
    -- and the folio genuinely disagree by a figure this block chose.
    --
    -- v_c3 is the charge written around the RPC — no entry, no discounts, no
    -- tax lines — so moving it changes one bucket and nothing else, and the
    -- expected difference is arithmetic rather than a guess.
    update folio_charges
       set net_amount = net_amount + v_plant,
           gross_amount = gross_amount + v_plant
     where id = v_c3.id;

    select * into v_head from folio_gl_reconciliation(v_prop);
    select * into v_row from folio_gl_reconciliation_folios(v_prop) r
    where r.folio_id = v_folio.id;

    -- FIRST, THE CONTROL. v_c3 never posted, so its whole value sits in the
    -- ready bucket, and moving the bill must move the bucket with it, leaving
    -- the invariant at zero. A bucket computed from a stale figure fails here —
    -- and would otherwise ABSORB the real plant below, which is exactly how a
    -- reconciliation comes to be incapable of going red.
    if v_row.ready_value is distinct from (v_c3.net_amount + v_plant) then
      v_fail := v_fail || format(
        '16: the ready bucket reads %s after the bill moved by %s; expected %s. The bucket is computed from the row as it NOW stands, so a bucket that did not follow the row is a bucket reading a stale figure. ',
        v_row.ready_value, v_plant, v_c3.net_amount + v_plant);
    end if;

    -- Now a difference the buckets CANNOT explain: a charge that posted, whose
    -- bill is then moved. The ledger holds the old figure, nothing is unposted,
    -- and the difference has nowhere to go but the invariant.
    update folio_charges
       set net_amount = net_amount + v_plant,
           gross_amount = gross_amount + v_plant
     where id = v_a.id;

    select * into v_row from folio_gl_reconciliation_folios(v_prop) r
    where r.folio_id = v_folio.id;
    if v_row.ledger_difference is distinct from -v_plant then
      v_fail := v_fail || format(
        '16: a posted charge''s bill was moved by %s and the reconciliation reports a difference of %s rather than %s. IT CANNOT DETECT A DIVERGENCE, which makes every other figure in this file decoration. ',
        v_plant, v_row.ledger_difference, -v_plant);
    end if;

    -- AND A SECOND DIFFERENCE, OF THE OPPOSITE SIGN AND SMALLER. Without it,
    -- "the worst by magnitude" and "the largest value" give the same answer and
    -- neither is tested; with it, a worst-folio picked by raw value returns the
    -- +1,000 one and this block says so.
    update folio_charges
       set net_amount = net_amount - 1000,
           gross_amount = gross_amount - 1000
     where id = v_c5.id;

    select * into v_head from folio_gl_reconciliation(v_prop);
    if v_head.differing_folio_count <> 2 then
      v_fail := v_fail || format(
        '16: the headline counts %s differing folio(s), expected exactly 2. The count beside the total is what tells one incident from four hundred. ',
        v_head.differing_folio_count);
    end if;
    if v_head.worst_folio_id is distinct from v_folio.id
       or v_head.worst_folio_difference is distinct from -v_plant then
      v_fail := v_fail || format(
        '16: the headline''s worst folio is %s at %s; expected %s at %s. A headline that names the wrong bill sends somebody to the wrong bill. ',
        coalesce(v_head.worst_folio_label, '(none)'), v_head.worst_folio_difference,
        v_folio.id, -v_plant);
    end if;
    -- WORST-FIRST, ASSERTED AS MONOTONICITY RATHER THAN AS "THIS FOLIO IS
    -- FIRST". The first version asked that v_folio came back first and stayed
    -- GREEN when the ordering was replaced by opened_at — because every folio
    -- this fixture opens shares one opened_at. now() is TRANSACTION START TIME
    -- (060's lesson, third outing), so a tiebreak on it is arbitrary and the
    -- right row came first only by luck. This asks the actual contract: no row
    -- may carry a larger absolute difference than the row above it.
    select count(*)::integer into v_bad
    from (select abs(r.ledger_difference) d,
                 lag(abs(r.ledger_difference)) over () prev
          from folio_gl_reconciliation_folios(v_prop) r) x
    where x.prev is not null and x.d > x.prev;
    if v_bad > 0 then
      v_fail := v_fail || format(
        '16: %s row(s) in the breakdown carry a bigger difference than the row above them, so it is not sorted worst-first. The first page is the only page somebody reads. ', v_bad);
    end if;
    select r.folio_id into v_first from folio_gl_reconciliation_folios(v_prop) r limit 1;
    if v_first is distinct from v_head.worst_folio_id then
      v_fail := v_fail || format(
        '16: the breakdown''s first row is %s and the headline''s worst folio is %s. They read the same rows and must agree about which bill to open. ',
        v_first, v_head.worst_folio_id);
    end if;
    if v_head.ledger_difference is distinct from (-v_plant + 1000) then
      v_fail := v_fail || format(
        '16: the headline''s rolled-up difference is %s rather than %s, so it is not a sum over the breakdown it claims to summarise. Two differences of opposite sign, so a rollup that took the worst row or an absolute value instead of the sum says so here. ',
        v_head.ledger_difference, -v_plant + 1000);
    end if;

    -- put the bills back, so 17 measures only what it plants
    update folio_charges set net_amount = net_amount - v_plant,
                             gross_amount = gross_amount - v_plant
     where id in (v_a.id, v_c3.id);
    update folio_charges set net_amount = net_amount + 1000,
                             gross_amount = gross_amount + 1000
     where id = v_c5.id;

    -- ===================== 17: A JOURNAL NO FOLIO PRODUCED ================
    -- The per-folio rows cannot see it — its source document is not a folio
    -- document — so the ACCOUNT-level figure is the only thing that can. This
    -- is why 3.2 reads the account by account_id while 3.1 reads by role_key:
    -- key them the same way and the two sides become one query.
    select * into v_head from folio_gl_reconciliation(v_prop);
    v_amt := v_head.outside_folios;
    perform post_journal(
      v_prop, current_date - 1, 'ZZ066 a manual entry against the guest ledger',
      'zz066_manual', gen_random_uuid(),
      jsonb_build_array(
        jsonb_build_object('role_key','guest_ledger','side','debit','amount',7777.00),
        jsonb_build_object('role_key','cash','side','credit')),
      null, null);
    select * into v_head from folio_gl_reconciliation(v_prop);
    if v_head.outside_folios is distinct from v_amt + 7777.00 then
      v_fail := v_fail || format(
        '17: a manual guest_ledger entry of 7,777.00 moved outside_folios from %s to %s. An entry on the guest ledger that no folio produced is invisible to every per-folio row, so if the account-level figure misses it nothing in the product ever sees it. ',
        v_amt, v_head.outside_folios);
    end if;
    if v_head.ledger_difference <> 0 then
      v_fail := v_fail || format(
        '17: and it moved the per-folio invariant to %s. It must not: the folios are unchanged, and a manual entry leaking into the per-folio difference would send somebody looking for a bill that is correct. ',
        v_head.ledger_difference);
    end if;

    -- ===================== 18: THE GUARDS, AND THE REFUSAL ================
    -- 051's first draft lost DEFINER and the is_tenant_staff gate by rewriting
    -- from memory, and no assertion in that file noticed.
    select count(*)::integer into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('folio_gl_reconciliation','folio_gl_reconciliation_folios')
      and (not p.prosecdef
           or p.proconfig is null
           or not exists (select 1 from unnest(p.proconfig) cfg where cfg like 'search_path=public%')
           or p.prosrc not like '%is_tenant_staff%');
    if v_bad > 0 then
      v_fail := v_fail || format(
        '18: %s of the two reconciliation functions lost SECURITY DEFINER, its pinned search_path, or its is_tenant_staff gate. Without DEFINER the journal join returns NO ROWS rather than a refusal and the reconciliation reports a perfect zero; without the gate a member with no business reading the books gets zeros instead of a refusal. ',
        v_bad);
    end if;
    -- and the refusal itself, from a session that belongs to no tenant.
    perform set_config('request.jwt.claims',
      json_build_object('role','authenticated','sub', gen_random_uuid()::text)::text, true);
    v_ok := false; v_err := null; v_state := null;
    begin
      perform 1 from folio_gl_reconciliation_folios(v_prop);
      v_ok := true;
    exception when others then v_err := sqlerrm; v_state := sqlstate; end;
    perform set_config('request.jwt.claims',
      json_build_object('role','service_role','sub', v_user::text)::text, true);
    if v_ok or v_state is distinct from '42501'
       or v_err not like '%Not authorised to read this property''s ledger%' then
      v_fail := v_fail || format(
        '18: a session belonging to no tenant was answered by %s / %s rather than refused. ZEROS ARE THE DANGEROUS ANSWER HERE: they are indistinguishable from books that balance. Matched on the message naming this property''s LEDGER, not merely on the sqlstate, because resolve_account can also raise inside 3.2 and a looser pattern would be satisfied by the gate''s deletion. ',
        coalesce(v_state, 'rows'), coalesce(left(v_err, 120), '(no error)'));
    end if;

    if v_fail <> '' then
      raise exception '066 SELF-VERIFY FAILED — %', v_fail;
    end if;

    raise notice '066 SELF-VERIFY: 18 assertions passed.';
    raise exception 'ZZ_066_FIXTURE_DONE';
  exception
    when others then
      if sqlerrm = 'ZZ_066_FIXTURE_DONE' then
        raise notice '066 self-verify complete; fixture rolled back.';
      else
        raise;
      end if;
  end;
end $$;
