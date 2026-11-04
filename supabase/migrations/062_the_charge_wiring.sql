-- ============================================================================
-- 062_the_charge_wiring.sql
-- Palstro-Hotels: A CHARGE POSTS. THE FIRST TIME A FRONT-DESK ACTION CHANGES.
--
-- 1.1h4 items 2 and 3. Four functions re-emitted, one stamp, and from here
-- every charge, every room night, every no-show and every charge reversal
-- writes a journal entry inside the transaction that wrote the document.
--
--     post_folio_charge_journal   declines a document whose day has not come
--     post_charge                 posts, and refuses a forward date it was
--                                 not explicitly given
--     post_room_night_charge      the one caller that IS given it
--     post_charge_reversal        posts the counter
--     property_finance_settings   folio_gl_wired_at stamped, once
--
-- ITEM 3 NEEDED NO CODE, and finding that out is worth more than the code it
-- saved. booking_nights has no folio link: a night reaches the bill as its own
-- folio_charges row through post_room_night_charge, called by run_night_audit
-- and by check_out_booking. So "one journal entry per night" falls out of one
-- charge, one entry — and it was found by COUNTING THE CALL SITES, which is
-- also how the census came out at four. Reasoning from the module names would
-- have produced a fourth helper nobody needed.
--
-- ----------------------------------------------------------------------------
-- THE FINDING THAT CHANGED THE SHAPE, AND IT WAS FOUND BY WIRING IT
-- ----------------------------------------------------------------------------
-- post_journal refuses an entry dated in the future (044 §5). The folio
-- LEGITIMATELY PRODUCES future-dated documents. Wired as first designed, a
-- four-night stay checked out on its arrival day failed outright:
--
--     PT422 - A journal entry cannot be dated in the future
--       post_journal -> post_folio_charge_journal -> post_charge
--                    -> post_room_night_charge -> check_out_booking
--
-- check_out_booking bills [greatest(actual_check_in, check_in), check_out) —
-- the FULL RESERVED RANGE, and nothing shortens check_out — so a guest leaving
-- early is billed for nights still ahead. That is 026's own scenario: the
-- migration written so a guest departing at 02:00 has a settleable folio.
-- Naive wiring turns it into a checkout that cannot complete.
--
-- Three paths produce such a document, all measured: an early checkout; a
-- manual post_charge with a forward p_charge_date, which was ACCEPTED with no
-- guard at all before this file; and run_night_audit run for a future business
-- date, also accepted. None of the six documents that already exist is
-- future-dated, so nothing was broken — the first early checkout after wiring
-- would have been.
--
-- THE ANSWER IS TWO RULES THAT LOOK OPPOSITE AND ARE NOT:
--
--   * THE HELPER DECLINES. A document whose business date has not arrived posts
--     NOTHING, YET — return null, on 046's precedent. Revenue for the 7th
--     belongs to the 7th; posting it on the 4th would misstate every daily
--     figure the hotel reads. Rules 8 and 12 were already the answer and
--     post_journal's guard was enforcing them.
--
--   * post_charge REFUSES. A room night dated forward is a real event. A bar
--     charge dated next week is a typo, and nothing refused it until now — it
--     would sit on a bill for days, in a period nobody is reading, and land in
--     a figure already reported. So p_allow_future boolean default false, with
--     post_room_night_charge the only caller that passes it, and ASSERTED ON
--     BOTH SIDES, because a guard that refuses everything is as wrong as one
--     that refuses nothing.
--
-- WHAT POSTS THE DECLINED ONES IS ITEM 2b, a sweep in the night audit. Not a
-- line in this file: a sweep buried inside a wiring migration is a thing nobody
-- can find when it misfires.
--
-- ----------------------------------------------------------------------------
-- WHAT THE BREAKAGES WENT RED FOR (rule 27)
-- ----------------------------------------------------------------------------
-- Fourteen mutations. THIRTEEN red; the one green is documented below.
--
--   A   the decline removed
--         -> post_journal's PT422, from inside checkout. The finding itself
--   B   the decline uses >= so TONIGHT is declined too
--         -> the first charge posts no entry at all
--   C   the posting call moved ABOVE capture_charge_taxes
--         -> 2: the tax leg nets 0 against 760.00 captured, and the receivable
--            is short by exactly the VAT. THE ENTRY STILL BALANCES, because the
--            receivable is the open line, so nothing errors and post_journal's
--            uniqueness makes it permanent. The nastiest defect available here
--   D   the posting call dropped from post_charge
--         -> 1
--   E   the posting call dropped from post_charge_reversal
--         -> 8: a residue of the whole charge in three accounts
--   F   the entry dated TODAY instead of the charge's business date
--         -> 3 and 7: four past nights and a no-show all filed on the wrong day
--   G   the forward-date refusal removed
--         -> 6: a manual charge three days out posted without complaint
--   H   the refusal ignores p_allow_future, refusing EVERYTHING forward
--         -> checkout fails again, from the other direction
--   I   post_room_night_charge stops passing it
--         -> same
--   J   the stamp loses its guard
--         -> the stamp rolled forward (see the note below — this one took two
--            attempts to make red)
--   K   the re-grant to authenticated dropped
--         -> GREEN, deliberately. See below
--   K2  authenticated explicitly revoked
--         -> 15
--   K3  anon granted execute
--         -> 15
--   L   the old eight-argument post_charge left in place
--         -> 42725, 'function post_charge(...) is not unique'. The DROP is
--            load-bearing, which is why it is there
--
-- WHY K IS GREEN, AND WHY IT IS STILL WORTH WRITING. Dropping the explicit
-- grant changes nothing on THIS database: its default privileges already grant
-- EXECUTE to authenticated on a new function in public, and already do not
-- grant anon. So the three re-emitted lines are INTENT rather than mechanism
-- here — and they are kept because a default-privilege setting is a server
-- configuration, not a property of this file, and the day it changes a silent
-- grant to anon is the failure. Assertion 15 checks the END STATE instead of
-- the statements, which is why K2 and K3 can turn it red.
--
-- TWO THINGS THE BREAKAGES FORCED ON THE PROOF RATHER THAN THE CODE:
--
--   * ASSERTION 11 WAS RE-IMPLEMENTING THE STATEMENT IT TESTED. It ran SECTION
--     5's update again from its own copy and compared — so breakage J, which
--     deletes SECTION 5's guard, stayed green. Rule 27's first shape exactly.
--     "The stamp does not roll forward" is a property of TWO applications, so
--     it moved to the dry run, which applies this file twice.
--
--   * AND THE DRY RUN COULD NOT SEE IT EITHER, at first, because now() IS
--     TRANSACTION START TIME: an unguarded `set folio_gl_wired_at = now()`
--     produces the SAME value on both passes inside one transaction. The same
--     fact that forced seq onto folio_charge_discounts in 060, arriving from a
--     third direction. The harness now creates the already-stamped condition
--     directly — an hour back, so the six pre-wiring documents still fall
--     before it — which is what a real second deployment looks like.
--
-- ONE THING THE FIXTURE LEARNED FROM THE CODE: mark_no_show charges only a
-- GUARANTEED booking (company_id is not null or bill_to = 'company'), because a
-- walk-in who fails to arrive owes nothing. The fixture asserted a charge on a
-- guest-billed no-show and got none; the code was right. Worth noting where it
-- leads — a guaranteed no-show IS a company booking, so it is the first charge
-- here that will settle against company_receivable once 1.1h6 exists.
--
-- A 30-NIGHT CHECKOUT, MEASURED RATHER THAN ASSUMED: 30 charges written, ONE
-- entry posted (only tonight has arrived), in roughly 20-40 ms. The baseline
-- with nothing posting was about the same, which is what one would expect when
-- 29 of the 30 postings decline before touching post_journal. The cost of a
-- long checkout once item 2b's sweep exists is 30 entries spread over 30 days,
-- one per morning, not 30 in a burst.
--
-- ----------------------------------------------------------------------------
-- WHAT THIS FILE DELIBERATELY DOES NOT DO
-- ----------------------------------------------------------------------------
--   * It does not post discounts or payments. Items 4 and 5 — the helpers exist
--     (061) and nothing calls them yet. SECTION 7's assertion 13 measures the
--     resulting gap exactly, so item 4 inherits a number rather than a guess.
--   * It does not sweep. Item 2b, in the night audit.
--   * It does not reconcile. Item 8; SECTION 6 states the three buckets it must
--     carry and which of them is MEANT to be non-zero.
--   * It does not touch voids. Item 6, and they need a document type of their
--     own rather than a flag read here.
--   * It does not guard the mapping orphan. You can point a charge category
--     only at a MAPPED role key (enforce_charge_category_account, 044, BEFORE
--     INSERT OR UPDATE — already there, and checked before writing a second
--     one), and then delete the mapping underneath it. One direction guarded
--     and the other open reads as "guarded", which is worse than neither. Its
--     own tracker shipment.
--   * It changes no authorisation. post_charge is DROPPED to change its
--     argument list, which takes its ACL with it, so 021's three lines are
--     re-emitted verbatim and assertion 15 checks the end state. Every other
--     function keeps the grants it had.
-- ============================================================================

-- ############################################################################
-- SECTION 1 — THE HELPER DECLINES A DOCUMENT WHOSE DAY HAS NOT COME
-- ############################################################################
-- Re-emitted from 061's text with one condition added. §5 of CLAUDE.md: an
-- applied migration is history, so the change comes in the next numbered file.
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
  v_timezone  text;
  v_today     date;
begin
  select * into v_c from folio_charges where id = p_charge_id;
  if not found then
    raise exception 'Folio charge % not found', p_charge_id
      using errcode = 'PT404',
            hint = 'The charge must be written before its entry is posted. Call this at the END of the RPC that inserts it.';
  end if;

  -- 062: A DOCUMENT WHOSE BUSINESS DATE HAS NOT ARRIVED POSTS NOTHING, YET.
  -- Returns NULL on 046's precedent — the same answer post_stock_movement_journal
  -- gives a movement with no cost basis, and the same answer post_journal itself
  -- gives a document dated before gl_start_date: no entry, no error, the caller's
  -- document entirely unaffected.
  --
  -- IT IS NOT A WORKAROUND, IT IS THE RULE. Revenue for the 7th belongs to the
  -- 7th. post_journal refuses a future-dated entry (044 §5) because posting it on
  -- the 4th would misstate every daily figure the hotel reads, and rules 8 and 12
  -- had already settled that. The guard was enforcing them.
  --
  -- AND THE FOLIO LEGITIMATELY PRODUCES SUCH DOCUMENTS, which is why this is here
  -- rather than nowhere. check_out_booking bills the nights
  -- [greatest(actual_check_in, check_in), check_out) — the FULL RESERVED RANGE,
  -- and nothing shortens check_out — so a guest departing early is billed for
  -- nights still in the future. Wired without this line, a four-night stay
  -- checked out on its arrival day fails outright with post_journal's PT422,
  -- inside post_room_night_charge, inside checkout. That is 026's own scenario:
  -- the migration written so a guest leaving at 02:00 has a settleable folio.
  -- Measured by wiring it and watching checkout break, not reasoned about.
  --
  -- WHAT POSTS IT LATER IS ITEM 2b, a sweep in the night audit, which already
  -- runs daily and is already idempotent through the document pair. Until then
  -- item 8's reconciliation carries these in a third bucket — see SECTION 6,
  -- which says why that bucket is the one that is MEANT to be non-zero.
  select p.timezone into v_timezone from properties p where p.id = v_c.property_id;
  v_today := (now() at time zone
              coalesce(nullif(btrim(v_timezone), ''), 'Africa/Lagos'))::date;
  if v_c.charge_date > v_today then
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

-- ############################################################################
-- SECTION 2 — post_charge POSTS, AND REFUSES A FORWARD DATE IT WAS NOT GIVEN
-- ############################################################################
-- TWO CHANGES AND A DROP. The signature gains p_allow_future, so the old
-- eight-argument function is DROPPED first rather than left beside the new one:
-- create or replace with a different argument list makes an OVERLOAD, and two
-- post_charges would resolve by argument count with nothing to say which a
-- caller meant.
--
-- A DROP TAKES THE FUNCTION'S GRANTS WITH IT, so 021's three lines are
-- re-emitted verbatim below. Without them Supabase's default privileges would
-- decide, and the net effect would be a function anon can execute.
--
-- EVERY ROOM NIGHT AND EVERY NO-SHOW POSTS THROUGH THIS ONE LINE. The call
-- census, re-run with comments and string literals stripped because the first
-- one matched a function name inside comment text:
--
--     run_night_audit   ─┐
--     check_out_booking ─┴→ post_room_night_charge ─┐
--     mark_no_show ─────────────────────────────────┴→ post_charge
--
-- THE PARAMETER IS REACHABLE FROM A CLIENT, AND THAT IS THE HOUSE PATTERN
-- rather than a hole. post_charge is granted to authenticated and PostgREST
-- passes whatever named arguments a request carries, so a staff user could set
-- p_allow_future themselves — exactly as they could set p_allow_negative on
-- post_stock_adjustment, p_allow_unvalued on post_stock_writeoff,
-- p_allow_moved_stock on finish_stock_take or p_count_no_show on
-- count_available, all of which are granted to authenticated today. These flags
-- are a CONFIRMATION of an override, not a security boundary; the boundary is
-- is_tenant_staff and RLS, and both still apply. This one is stricter than the
-- five before it in one respect: nothing in the UI offers it, so the typo it
-- guards against cannot be waved through by a receptionist clicking past a
-- dialog. src/lib/folio.ts's postCharge sends the eight named arguments it
-- always has and is untouched by this migration.
--
-- So item 3's ruling — ONE ENTRY PER NIGHT — needs no code: a night is its own
-- folio_charges row with its own charge_date, so one charge is one entry. What
-- remains is to prove it, which SECTION 7 does.
drop function if exists post_charge(uuid, uuid, text, numeric, numeric, date, text, text);

CREATE OR REPLACE FUNCTION public.post_charge(p_folio_id uuid, p_charge_category_id uuid, p_description text, p_quantity numeric, p_unit_amount numeric, p_charge_date date, p_idempotency_key text, p_source text DEFAULT 'manual'::text, p_allow_future boolean DEFAULT false)
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
  v_today    date;
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
  select p.timezone into v_timezone from properties p where p.id = v_folio.property_id;
  v_today := (now() at time zone
              coalesce(nullif(btrim(v_timezone), ''), 'Africa/Lagos'))::date;
  v_date  := coalesce(p_charge_date, v_today);

  -- 062: A FORWARD DATE IS A REAL EVENT ON ONE PATH AND A TYPO ON EVERY OTHER.
  -- A room night dated forward is exactly what check_out_booking produces when a
  -- guest leaves early: the nights were reserved and are owed. A bar charge dated
  -- next week is somebody keying the wrong date, and nothing refused it until
  -- now — a charge can sit on a bill for days, in a period nobody is reading, and
  -- then land in a figure that was already reported.
  --
  -- So the permission is a PARAMETER rather than a rule about p_source: only
  -- post_room_night_charge passes it, and it is false everywhere else, including
  -- mark_no_show (whose charge is dated the reserved first night and which
  -- already refuses unless that night is strictly past). A rule keyed on
  -- p_source would be a string somebody can pass, which is the difference
  -- between an interface and a convention.
  if v_date > v_today and not p_allow_future then
    raise exception
      'A charge cannot be dated in the future (today is % at this property)', v_today
      using errcode = 'PT422',
            hint = 'Check the date. Room nights for a stay still to come are posted by checkout or by the night audit, not keyed by hand.';
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

  -- 062: AND NOW IT POSTS. AFTER capture_charge_taxes, NEVER BEFORE — the
  -- entry's tax legs are read from folio_charge_tax_lines, so posting first
  -- gives an entry with NO TAX LEGS AT ALL. It would still BALANCE, because the
  -- guest ledger is the open line, so it would post cleanly with the bill short
  -- by the whole VAT and nothing erroring; and post_journal's uniqueness on
  -- (tenant, type, id) makes it permanent, because a later call hands back the
  -- wrong entry instead of correcting it.
  --
  -- NOT ON THE THREE EARLY RETURNS ABOVE, and that is a decision rather than an
  -- omission. The idempotency lookup and both unique_violation handlers return a
  -- charge SOMEBODY ELSE wrote: if that charge predates the wiring, posting here
  -- would mint an entry for a pre-wiring document and quietly move it out of the
  -- bucket 061 §4 decided it belongs in — and only for the documents whose keys
  -- somebody happened to redeliver. The boundary stays
  -- created_at < folio_gl_wired_at. For the concurrent case the caller that won
  -- already posted inside its own transaction, so nothing is lost.
  --
  -- perform, NOT an assignment: the helper returns NULL for a document whose
  -- business date has not arrived (§1) and post_journal returns NULL for one
  -- dated before gl_start_date (044 §5). Both are CORRECT answers, and a
  -- not-null check here would turn each into a refusal at the desk.
  perform post_folio_charge_journal(v_charge.id);

  return v_charge;
end;
$function$
;

revoke execute on function post_charge(uuid, uuid, text, numeric, numeric, date, text, text, boolean) from public;
revoke execute on function post_charge(uuid, uuid, text, numeric, numeric, date, text, text, boolean) from anon;
grant  execute on function post_charge(uuid, uuid, text, numeric, numeric, date, text, text, boolean) to authenticated;

-- ############################################################################
-- SECTION 3 — THE ONE CALLER THAT MAY DATE A CHARGE FORWARD
-- ############################################################################
-- Re-emitted only to pass p_allow_future. Its own signature does not change, so
-- it is a plain create or replace and its grants are untouched.
CREATE OR REPLACE FUNCTION public.post_room_night_charge(p_booking_id uuid, p_stay_date date, p_idempotency_key text DEFAULT NULL::text)
 RETURNS folio_charges
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_booking   bookings;
  v_folio_id  uuid;
  v_rate      numeric(14,2);
  v_category  uuid;
  v_type_name text;
  v_key       text;
begin
  select * into v_booking from bookings where id = p_booking_id and deleted_at is null;
  if not found then
    raise exception 'Booking % not found', p_booking_id using errcode = 'no_data_found';
  end if;

  if not is_tenant_staff(v_booking.tenant_id) then
    raise exception 'Not authorised to post room charges for this tenant'
      using errcode = 'insufficient_privilege';
  end if;

  select f.id into v_folio_id from folios f where f.booking_id = p_booking_id;
  if v_folio_id is null then
    raise exception 'Booking % has no folio', p_booking_id using errcode = 'no_data_found';
  end if;

  -- The rate LOCKED at booking time for this specific night (015 §5). Never
  -- re-resolved from the rate tables: re-pricing a stay after the fact is the
  -- correctness/trust failure booking_nights exists to prevent.
  select bn.rate into v_rate
  from booking_nights bn
  where bn.booking_id = p_booking_id and bn.stay_date = p_stay_date;

  if v_rate is null then
    raise exception 'Booking % has no night on %', p_booking_id, p_stay_date
      using errcode = 'no_data_found';
  end if;

  select cc.id into v_category
  from charge_categories cc
  where cc.tenant_id = v_booking.tenant_id
    and cc.code = 'room'
    and cc.deleted_at is null
    and cc.is_active = true;

  if v_category is null then
    raise exception 'This tenant has no active ''room'' charge category'
      using errcode = 'no_data_found';
  end if;

  select rt.name into v_type_name from room_types rt where rt.id = v_booking.room_type_id;

  -- Deterministic key: the same night can never post twice, however many times the
  -- night audit runs or retries. A caller-supplied key overrides it only for the
  -- unusual case of a deliberate re-post.
  v_key := coalesce(p_idempotency_key, 'room:' || p_booking_id::text || ':' || p_stay_date::text);

  return post_charge(
    v_folio_id,
    v_category,
    coalesce(v_type_name, 'Room') || ' — ' || to_char(p_stay_date, 'DD Mon YYYY'),
    1,
    v_rate,
    p_stay_date,        -- the business date IS the night that was slept (rule 12)
    v_key,
    'room',
    -- 062: THE ONE CALLER ALLOWED A FORWARD DATE, and the only one. A reserved
    -- night is owed whether or not it has arrived — checkout bills the whole
    -- range when a guest leaves early — so the charge is written now and its
    -- ENTRY waits for the night (§1). Every other caller of post_charge leaves
    -- this false and is refused, which is the half that makes the permission
    -- mean something.
    true
  );
end;
$function$
;

-- ############################################################################
-- SECTION 4 — post_charge_reversal POSTS
-- ############################################################################
-- The other of the two functions that insert into folio_charges. Reached by
-- reverse_charge and by reverse_discount, which between them produce the two
-- shapes of counter:
--
--   * a CHARGE reversal mirrors gross, discount and tax, so its entry is the
--     exact mirror of the original's — by sign alone, no branch anywhere.
--   * a DISCOUNT reversal is gross 0 with a negative discount, so its entry
--     carries NO REVENUE LEG, and the captured revenue key on the row is there
--     for reporting rather than for this entry. 061 §1 says why that is right.
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

  -- 062: AND NOW THE COUNTER POSTS TOO. AFTER restate_charge_taxes for the same
  -- reason post_charge posts after capture: until that line runs the counter has
  -- NO tax rows at all, so an entry built first would unwind the revenue and
  -- leave the whole liability standing — 058's residue in a new costume.
  --
  -- This function does NOT call post_charge (it inserts the counter itself), so
  -- the two posting calls are independent and each sits after its OWN tax step.
  -- It also means the counter is NOT subject to §2's forward-date refusal, which
  -- is right: a counter mirrors a charge that already exists, and refusing to
  -- reverse a future-dated night would strand it.
  perform post_folio_charge_journal(v_counter.id);

  return v_counter;
end;
$function$
;

-- ############################################################################
-- SECTION 3 — THE WIRING IS STAMPED
-- ############################################################################
-- folio_gl_wired_at records the moment the folio began posting, so item 8's
-- reconciliation can put the documents written before it in a pre_wiring
-- bucket instead of reporting them as a discrepancy. 061 §4 holds the decision
-- and the reasoning; this is the line that makes it true.
--
-- THE SIX DOCUMENTS THAT CAME BEFORE STAY UNPOSTED. Three charges, two
-- payments and one discount application, written while there was nowhere to
-- post. 047 did the same on the stock side rather than invent entries for
-- movements that predate the code, and backfilling is worse here: the laundry
-- charge's net is not what it was posted at, because two discount applications
-- have moved it and restate_charge_taxes has rewritten its tax rows since.
--
-- TWO GUARDS, AND ONLY ONE OF THEM IS LOAD-BEARING TODAY. The WHERE clause is
-- what makes this re-runnable — on a second apply it matches no rows and the
-- stamp cannot move. The coalesce is belt-and-braces for the day somebody
-- widens that WHERE, which is exactly how a one-time stamp quietly becomes a
-- rolling one.
--
-- WHY THE STAMP COMES BEFORE THE FIXTURE and not after: now() is transaction
-- START time, so the stamp and every row SECTION 4 writes share one timestamp.
-- created_at < wired_at is therefore FALSE for the fixture's documents, which
-- is correct — they are post-wiring, and they must not land in the bucket the
-- assertions are about to check is clean.
do $$
declare
  v_n     integer;
  v_when  timestamptz;
begin
  update property_finance_settings
     set folio_gl_wired_at = coalesce(folio_gl_wired_at, now())
   where folio_gl_wired_at is null;
  get diagnostics v_n = row_count;

  select min(folio_gl_wired_at) into v_when from property_finance_settings;
  if v_when is null then
    raise exception
      'No property has a folio_gl_wired_at after stamping it, so nothing can tell a pre-wiring document from a posted one.'
      using errcode = 'PT424',
            hint = 'Every property needs a property_finance_settings row. The AFTER INSERT trigger on properties creates one; check that it fired.';
  end if;

  raise notice '062: folio_gl_wired_at stamped on % propert(ies); the folio wired at %.',
    v_n, v_when;
end $$;

-- ############################################################################
-- SECTION 6 — WHAT ITEM 8 MUST CARRY, WRITTEN NOW
-- ############################################################################
-- 061 §4 states the invariant: per property, the guest ledger account's net
-- debit equals the sum of every folio's balance. This section adds what THIS
-- shipment makes true about it, while it is known rather than when somebody
-- gets there.
--
-- ----------------------------------------------------------------------------
-- A THIRD BUCKET, AND IT IS THE ONLY ONE MEANT TO BE NON-ZERO
-- ----------------------------------------------------------------------------
-- folio_gl_reconciliation carries THREE buckets of documents that are not in
-- the ledger, and the difference between them is the thing to say out loud:
--
--   pre_gl         dated before gl_start_date. post_journal returns NULL for
--                  these, by design (044 §5).
--   pre_wiring     created before folio_gl_wired_at. The six documents written
--                  while there was nowhere to post (061 §4).
--   not_yet_due    business date still in the future. SECTION 1's decline.
--
-- THE FIRST TWO ARE CLEARED ONCE, AT GO-LIVE: 5.5 empties the journal, removes
-- the test documents and sets gl_start_date, and both go to zero together and
-- stay there.
--
-- THE THIRD IS EXPECTED TO BE NON-ZERO ON AN ORDINARY TUESDAY, and it EMPTIES
-- ITSELF as days pass. Any hotel with a guest who has departed early is
-- carrying nights that have not arrived; item 2b's sweep posts each one the
-- morning its date comes, and the bucket drains without anybody touching it.
--
-- SO THE FIGURE IS NOT A DISCREPANCY AND MUST NOT READ AS ONE. Without that
-- sentence on the screen, the first person to see a non-zero not_yet_due goes
-- looking for a bug in the ledger — and the ledger is right. Rule 16's tooltip
-- carries it: what the number includes, and that it is supposed to be there.
--
-- ----------------------------------------------------------------------------
-- AND THE RECEIVABLE CAN GO THE WRONG WAY WHILE THE BUCKET IS FULL
-- ----------------------------------------------------------------------------
-- This is the part that will look like a defect if it is not written down.
--
-- A payment posts the moment it is taken; a charge for a night that has not
-- arrived does not. So a folio whose future nights are still waiting has the
-- ledger BEHIND the folio by exactly those nights' net plus their tax — and if
-- the guest has settled on departure, which is the ordinary case for an early
-- checkout, that folio's guest_ledger lines are a NET CREDIT. Read on its own,
-- that says the hotel owes the guest money. It does not: it says the hotel has
-- been paid for nights it has not yet booked as revenue, which is exactly what
-- happened and exactly what the bucket accounts for.
--
-- So the reconciliation's statement is not
--
--     guest ledger  ===  sum of folio balances
--
-- but
--
--     guest ledger + pre_gl + pre_wiring + not_yet_due  ===  sum of folio balances
--
-- which is the shape 047 already uses on the stock side (`val = expected +
-- pre_gl + pre_wiring + non_posting + unval`), for the same reason: a figure
-- that cannot be reconciled is a figure nobody trusts, and the way to reconcile
-- it is to name every bucket it is missing rather than to round the difference
-- away. SECTION 7 asserts this gap EXACTLY, so item 8 inherits a measured
-- number rather than a plausible one.

-- ############################################################################
-- SECTION 7 — THE SELF-VERIFY, ROLLED BACK
-- ############################################################################
-- Fifteen assertions. Items 2 and 3 are proven together, because item 3 is not
-- a build: a night is already a charge row, so the ruling it carries is a
-- property of this wiring.
--
-- WHY THE FIXTURE INSERTS A BOOKING DIRECTLY instead of going through
-- create_booking, which would be the obvious thing: it needs a stay whose
-- nights are in the PAST, and create_booking refuses a past check-in (020).
-- With a forward stay, SECTION 1's decline means only tonight's night posts —
-- and ONE NIGHT CANNOT TELL A PER-NIGHT RATE FROM AN AVERAGE, which is rule
-- 27's fourth shape arriving in the same place twice. So the per-night
-- assertion is driven through post_room_night_charge on four PAST nights at
-- four DIFFERENT rates (50,000 / 55,000 / 60,000 / 45,000 — no two the same and
-- no average equal to any of them), which is the function run_night_audit and
-- check_out_booking both call. The orchestrators are then proven separately, on
-- a forward stay, where the right answer is that three of the four nights post
-- NOTHING.
--
--   1  A CHARGE POSTS AT ALL, through post_charge. RED if the call is dropped.
--   2  AND AFTER THE TAX STEP. The entry's tax leg equals what
--      capture_charge_taxes wrote and the receivable is gross + tax. RED if the
--      call moves above capture_charge_taxes — the nastiest defect available
--      here, because the entry still BALANCES with no tax legs (the receivable
--      is the open line), so it posts cleanly with the bill short by the whole
--      VAT, nothing errors, and post_journal's uniqueness makes it permanent.
--   3  ITEM 3: ONE ENTRY PER NIGHT, EACH AT ITS OWN LOCKED RATE, over four past
--      nights at four different rates. RED if an entry carries an average, a
--      total, or another night's figure.
--   4  AND NO ENTRY COVERS TWO NIGHTS, dated to its own stay_date.
--   5  A FORWARD NIGHT POSTS NOTHING, AND CHECKOUT STILL SUCCEEDS. The whole
--      finding, as a fixture: a four-night stay checked out on arrival day
--      leaves four charges and exactly ONE entry. RED if the decline is removed
--      — checkout then fails with post_journal's PT422 and the guest cannot
--      settle.
--   6  A MANUAL FORWARD DATE IS REFUSED, AND A TODAY DATE IS NOT. Both sides,
--      because a guard that refuses everything is as wrong as one that refuses
--      nothing. Read by SQLSTATE and message (rule 27's fifth shape).
--   7  A NO-SHOW POSTS, dated the reserved first night. mark_no_show does NOT
--      pass p_allow_future and does not need to: it already refuses unless that
--      night is strictly past.
--   8  A REVERSED CHARGE NETS TO ZERO IN EVERY ACCOUNT, through the real caller
--      reverse_charge rather than through post_charge_reversal directly as 061
--      did.
--   9  A REVERSED DISCOUNT POSTS WITH NO REVENUE LEG. Its gross is 0, so the
--      captured revenue key on the row is for reporting, not for this entry.
--  10  NONE OF THE THREE EARLY RETURNS POSTS. A redelivered key returns the
--      existing charge and adds no entry.
--  11  THE STAMP IS SET, ON EVERY PROPERTY, AND IS NOT IN THE FUTURE. That it
--      cannot MOVE is asserted by the dry run instead, which applies the file
--      twice: a fixture inside one application cannot observe a property of
--      two, and the first version of this assertion re-ran its own copy of the
--      statement and stayed green when the real one was broken.
--  12  THE PRE-WIRING DOCUMENTS ARE STILL UNPOSTED, and there is at least one
--      so the check is not vacuous.
--  13  THE INVARIANT, AND THE not_yet_due GAP MEASURED EXACTLY. On the past
--      stay, fully posted, the guest ledger equals folio_balance. On the
--      forward stay it is BEHIND by precisely the unposted nights' net plus
--      their tax — the number item 8's third bucket has to carry.
--  14  WHAT A LONG CHECKOUT COSTS, measured rather than assumed, and reported
--      as a notice because a wall-clock assertion is a flaky one.
--  15  THE GRANTS SURVIVED THE DROP. post_charge had to be dropped to change
--      its argument list, and A DROP TAKES THE FUNCTION'S ACL WITH IT — so the
--      new one must be executable by authenticated, NOT by anon, and the old
--      eight-argument signature must be gone rather than left as an overload.
--      Nothing else in this file would notice: the fixture runs as the owner,
--      for whom every grant is irrelevant. RED if 021's three lines are not
--      re-emitted, in which case Supabase's default privileges decide and anon
--      can post charges.
do $$
declare
  v_tenant   uuid;
  v_user     uuid;
  v_prop     uuid;
  v_rt       uuid;
  v_guest    uuid;
  v_cat      uuid;
  v_folio    folios;
  v_a        folio_charges;
  v_rev      folio_charges;
  v_dctr     folio_charges;
  v_past     uuid;              -- the past booking, nights already slept
  v_ns       uuid;              -- the no-show booking
  v_bk       bookings;          -- the forward stay, checked out on arrival day
  v_bk30     bookings;
  v_pfolio   uuid;
  v_ffolio   uuid;
  v_e1       uuid;
  v_tax      numeric(14,2);
  v_wired    timestamptz;
  v_wired2   timestamptz;
  v_t0       timestamptz;
  v_ms       integer;
  v_n        integer;
  v_bad      integer;
  v_amt      numeric;
  v_amt2     numeric;
  v_bal      numeric;
  v_rates    integer;
  v_ok       boolean;
  v_err      text;
  v_state    text;
  v_fail     text := '';
  v_d        date;
  v_i        integer;
begin
  begin
    select tu.tenant_id, tu.user_id into v_tenant, v_user
    from tenant_users tu where tu.is_active and tu.role in ('owner','manager') limit 1;
    select p.id into v_prop from properties p where p.tenant_id = v_tenant limit 1;
    if v_tenant is null or v_prop is null then
      raise notice '062 SELF-VERIFY SKIPPED: no tenant or active owner/manager.';
      raise exception 'ZZ_062_FIXTURE_DONE';
    end if;
    perform set_config('request.jwt.claims',
      json_build_object('role','service_role','sub', v_user::text)::text, true);

    -- THIS OVERWRITES A REAL MANAGER'S PIN, and it is only safe because the
    -- ZZ_062_FIXTURE_DONE sentinel below guarantees this block rolls back — the
    -- raise is unconditional, so no path commits it. Anyone copying this
    -- pattern into something that COMMITS must use a throwaway user instead.
    insert into manager_pins (tenant_id, user_id, pin_hash)
    values (v_tenant, v_user, crypt('4062', gen_salt('bf')))
    on conflict (tenant_id, user_id) do update set pin_hash = excluded.pin_hash;

    select cc.id into v_cat from charge_categories cc
    where cc.tenant_id = v_tenant and cc.is_taxable and cc.deleted_at is null
      and cc.is_active and cc.code <> 'room'
    order by cc.code limit 1;
    select rt.id into v_rt from room_types rt
    where rt.tenant_id = v_tenant and rt.deleted_at is null
    order by rt.base_rate limit 1;
    if v_cat is null or v_rt is null then
      raise exception '062 SELF-VERIFY needs a taxable non-room category and a room type (cat=%, rt=%)', v_cat, v_rt;
    end if;

    -- ===================== 1, 2: A CHARGE POSTS ===========================
    insert into guests (tenant_id, first_name, last_name, created_by)
    values (v_tenant, 'ZZ062', 'Walk-in', v_user) returning id into v_guest;
    v_folio := open_guest_folio(v_tenant, v_prop, v_guest, 'zz062-folio-1');
    v_a := post_charge(v_folio.id, v_cat, 'ZZ062 dinner', 1, 10000, current_date,
                       'zz062-charge-1', 'manual');

    select je.id into v_e1 from journal_entries je
    where je.source_document_type = 'folio_charge' and je.source_document_id = v_a.id;
    if v_e1 is null then
      raise exception '062 SELF-VERIFY: post_charge left no entry, so nothing below can be read. The posting call is missing.';
    end if;

    select coalesce(sum(t.amount), 0) into v_tax
    from folio_charge_tax_lines t where t.folio_charge_id = v_a.id;
    if v_tax <= 0 then
      raise exception '062 SELF-VERIFY needs a taxed charge; this one captured %.', v_tax;
    end if;

    select coalesce(sum(l.debit - l.credit), 0) into v_amt
    from journal_entry_lines l where l.journal_entry_id = v_e1 and l.role_key = 'vat_output';
    if v_amt is distinct from -v_tax then
      v_fail := v_fail || format(
        '2: the charge entry''s tax leg nets %s against %s of captured tax. A posting call placed ABOVE capture_charge_taxes reads no tax rows, and the entry still BALANCES because the receivable is the open line — so the bill posts short by the whole VAT with nothing erroring. ',
        v_amt, -v_tax);
    end if;
    select coalesce(sum(l.debit - l.credit), 0) into v_amt
    from journal_entry_lines l where l.journal_entry_id = v_e1 and l.role_key = 'guest_ledger';
    if v_amt is distinct from 10000.00 + v_tax then
      v_fail := v_fail || format('2: the receivable leg nets %s, expected %s. ', v_amt, 10000.00 + v_tax);
    end if;
    select coalesce(sum(l.debit - l.credit), 0) into v_amt
    from journal_entry_lines l
    where l.journal_entry_id = v_e1 and l.role_key = v_a.account_role_key;
    if v_amt is distinct from -10000.00 then
      v_fail := v_fail || format('1: the gross leg nets %s at %s, expected a credit of 10000.00. ',
                                 v_amt, v_a.account_role_key);
    end if;

    -- ===================== 10: THE REPLAY POSTS NOTHING ===================
    select count(*)::integer into v_n from journal_entries;
    perform post_charge(v_folio.id, v_cat, 'ZZ062 dinner', 1, 10000, current_date,
                        'zz062-charge-1', 'manual');
    select count(*)::integer into v_bad from journal_entries;
    if v_bad <> v_n then
      v_fail := v_fail || format(
        '10: redelivering a charge''s idempotency key added %s entr(ies). A replay returns a charge somebody else wrote, and posting there would mint entries for pre-wiring documents depending on who happened to retry. ',
        v_bad - v_n);
    end if;

    -- ===================== 6: THE FORWARD-DATE REFUSAL, BOTH SIDES ========
    v_ok := false; v_err := null; v_state := null;
    begin
      perform post_charge(v_folio.id, v_cat, 'ZZ062 next week', 1, 1000,
                          current_date + 3, 'zz062-future-1', 'manual');
      v_ok := true;
    exception when others then v_err := sqlerrm; v_state := sqlstate; end;
    if v_ok or v_state is distinct from 'PT422'
       or v_err not like '%cannot be dated in the future%' then
      v_fail := v_fail || format(
        '6: a manual charge dated three days out was answered by %s / %s. It must refuse: a bar charge dated next week is a typo, and nothing refused it before this shipment. ',
        coalesce(v_state, 'a posted charge'), coalesce(v_err, '(no error)'));
    end if;
    -- and the other side, which is the half that makes the guard mean something
    begin
      perform post_charge(v_folio.id, v_cat, 'ZZ062 today is fine', 1, 1000,
                          current_date, 'zz062-today-1', 'manual');
    exception when others then
      v_fail := v_fail || format(
        '6: a charge dated TODAY was refused by %s / %s. A guard that refuses everything is as wrong as one that refuses nothing. ',
        sqlstate, sqlerrm);
    end;

    -- ===================== 3, 4: ITEM 3, FOUR PAST NIGHTS =================
    -- Inserted directly: create_booking refuses a past check-in (020), and a
    -- forward stay would post only tonight — one night, from which an average
    -- is indistinguishable. The folio is created by the AFTER INSERT trigger.
    insert into guests (tenant_id, first_name, last_name, created_by)
    values (v_tenant, 'ZZ062', 'Past Stay', v_user) returning id into v_guest;
    insert into bookings (tenant_id, property_id, room_type_id, guest_id,
                          booking_number, check_in, check_out, adults, status,
                          bill_to, created_by)
    values (v_tenant, v_prop, v_rt, v_guest, 'ZZ062-PAST', current_date - 5,
            current_date - 1, 1, 'checked_in', 'guest', v_user)
    returning id into v_past;

    v_i := 0;
    for v_d in select (current_date - 5) + g from generate_series(0, 3) g loop
      v_i := v_i + 1;
      insert into booking_nights (tenant_id, property_id, booking_id, stay_date,
                                  rate, rate_source, created_by)
      values (v_tenant, v_prop, v_past, v_d,
              (array[50000, 55000, 60000, 45000])[v_i], 'fixture', v_user);
    end loop;

    for v_d in select bn.stay_date from booking_nights bn
               where bn.booking_id = v_past order by bn.stay_date loop
      perform post_room_night_charge(v_past, v_d, null);
    end loop;

    select f.id into v_pfolio from folios f where f.booking_id = v_past;

    -- no two nights cost the same, so no average can pass
    select count(distinct fc.gross_amount)::integer, count(*)::integer
      into v_rates, v_n
    from folio_charges fc where fc.folio_id = v_pfolio and fc.source = 'room';
    if v_n <> 4 or v_rates <> 4 then
      raise exception
        '062 SELF-VERIFY: the past stay produced % room charge(s) at % distinct rate(s); four of each is what makes assertion 3 able to fail.',
        v_n, v_rates;
    end if;

    -- one entry per night, dated to that night
    select count(*)::integer into v_bad
    from folio_charges fc
    left join journal_entries je
      on je.source_document_type = 'folio_charge' and je.source_document_id = fc.id
    where fc.folio_id = v_pfolio and fc.source = 'room'
      and (je.id is null or je.entry_date is distinct from fc.charge_date);
    if v_bad > 0 then
      v_fail := v_fail || format(
        '3: %s of the four past nights has no entry, or an entry dated other than its own stay_date. The night audit''s grain is the night. ', v_bad);
    end if;

    -- each night's revenue leg is THAT night's own locked rate
    select count(*)::integer into v_bad
    from folio_charges fc
    join journal_entries je
      on je.source_document_type = 'folio_charge' and je.source_document_id = fc.id
    where fc.folio_id = v_pfolio and fc.source = 'room'
      and coalesce((select -sum(l.debit - l.credit) from journal_entry_lines l
                    where l.journal_entry_id = je.id
                      and l.role_key = fc.account_role_key), 0)
          is distinct from fc.gross_amount;
    if v_bad > 0 then
      select string_agg(format('%s=%s', fc.charge_date, fc.gross_amount), ', ' order by fc.charge_date)
        into v_err
      from folio_charges fc where fc.folio_id = v_pfolio and fc.source = 'room';
      v_fail := v_fail || format(
        '3: %s night(s) posted a revenue leg that is not that night''s own locked rate. The nights were %s — four different figures, so an average matches none of them. ',
        v_bad, v_err);
    end if;

    -- 4: exactly one entry per room charge
    select count(*)::integer into v_n
    from journal_entries je
    where je.source_document_type = 'folio_charge'
      and je.source_document_id in (select fc.id from folio_charges fc
                                    where fc.folio_id = v_pfolio and fc.source = 'room');
    if v_n <> 4 then
      v_fail := v_fail || format(
        '4: four past nights produced %s entr(ies), expected one each. An entry covering a run of nights is the thing the ruling was against. ', v_n);
    end if;

    -- ===================== 7: A NO-SHOW POSTS =============================
    insert into guests (tenant_id, first_name, last_name, created_by)
    values (v_tenant, 'ZZ062', 'No Show', v_user) returning id into v_guest;
    insert into bookings (tenant_id, property_id, room_type_id, guest_id,
                          booking_number, check_in, check_out, adults, status,
                          bill_to, created_by)
    -- BILLED TO THE COMPANY, because mark_no_show only charges a GUARANTEED
    -- booking: v_guaranteed is (company_id is not null or bill_to = 'company'),
    -- and a walk-in who fails to arrive owes nothing. The fixture asserted a
    -- charge on a guest-billed no-show and got none — the code was right.
    -- Worth noting where it leads: a guaranteed no-show IS a company booking,
    -- so this is the first charge in the fixture that will settle to
    -- company_receivable once 1.1h6 exists.
    values (v_tenant, v_prop, v_rt, v_guest, 'ZZ062-NS', current_date - 3,
            current_date - 2, 1, 'confirmed', 'company', v_user)
    returning id into v_ns;
    insert into booking_nights (tenant_id, property_id, booking_id, stay_date,
                                rate, rate_source, created_by)
    values (v_tenant, v_prop, v_ns, current_date - 3, 70000, 'fixture', v_user);

    perform mark_no_show(v_ns, 'zz062-ns-1');
    select count(*)::integer into v_bad
    from folio_charges fc join folios f on f.id = fc.folio_id
    where f.booking_id = v_ns;
    select count(*)::integer into v_n
    from folio_charges fc
    join folios f on f.id = fc.folio_id
    join journal_entries je
      on je.source_document_type = 'folio_charge' and je.source_document_id = fc.id
    where f.booking_id = v_ns and je.entry_date = current_date - 3;
    if v_bad <> 1 or v_n <> 1 then
      v_fail := v_fail || format(
        '7: a no-show left %s charge(s) and %s entr(ies) dated the reserved night. mark_no_show reaches post_charge without p_allow_future, and does not need it: its charge is dated the reserved first night and it already refuses unless that night is strictly past. ',
        v_bad, v_n);
    end if;

    -- ===================== 5: A FORWARD STAY POSTS ONLY TONIGHT ===========
    insert into guests (tenant_id, first_name, last_name, created_by)
    values (v_tenant, 'ZZ062', 'Early Departure', v_user) returning id into v_guest;
    v_bk := create_booking(v_prop, v_rt, v_guest, current_date, current_date + 4,
                           1, 'zz062-bk-f', 0, null, 'guest', null, null);
    perform check_in_booking(v_bk.id, 'zz062-ci-f', now());
    -- THE FINDING, AS A FIXTURE: without SECTION 1's decline this call RAISES
    -- PT422 from inside post_journal and the guest cannot settle at all.
    perform check_out_booking(v_bk.id, 'zz062-co-f');
    select f.id into v_ffolio from folios f where f.booking_id = v_bk.id;

    select count(*)::integer into v_n
    from folio_charges fc where fc.folio_id = v_ffolio and fc.source = 'room';
    select count(*)::integer into v_bad
    from folio_charges fc
    join journal_entries je
      on je.source_document_type = 'folio_charge' and je.source_document_id = fc.id
    where fc.folio_id = v_ffolio and fc.source = 'room';
    if v_n <> 4 or v_bad <> 1 then
      v_fail := v_fail || format(
        '5: an early checkout over four nights left %s charge(s) and %s entr(ies); expected 4 and 1. Every night is owed, and only tonight''s belongs in today''s figures. ',
        v_n, v_bad);
    end if;
    select count(*)::integer into v_bad
    from folio_charges fc
    join journal_entries je
      on je.source_document_type = 'folio_charge' and je.source_document_id = fc.id
    where fc.folio_id = v_ffolio and fc.source = 'room' and fc.charge_date > current_date;
    if v_bad > 0 then
      v_fail := v_fail || format(
        '5: %s night(s) still in the future were posted. Revenue for the 7th belongs to the 7th. ', v_bad);
    end if;

    -- ===================== 8: A REVERSAL NETS TO ZERO =====================
    perform reverse_charge(v_a.id, 'ZZ062 keyed in error', '4062', 'zz062-rc-1');
    select * into v_rev from folio_charges
    where reversal_of_charge_id = v_a.id and reversal_target_type = 'charge'
    order by created_at desc limit 1;
    if not found then
      v_fail := v_fail || '8: reverse_charge wrote no counter charge. ';
    else
      select count(*)::integer into v_bad
      from (
        select l.role_key, sum(l.debit - l.credit) net
        from journal_entry_lines l
        join journal_entries je on je.id = l.journal_entry_id
        where je.source_document_type = 'folio_charge'
          and je.source_document_id in (v_a.id, v_rev.id)
        group by l.role_key having sum(l.debit - l.credit) <> 0
      ) r;
      if v_bad > 0 then
        select string_agg(format('%s %s', r.role_key, r.net), ', ') into v_err
        from (
          select l.role_key, sum(l.debit - l.credit) net
          from journal_entry_lines l
          join journal_entries je on je.id = l.journal_entry_id
          where je.source_document_type = 'folio_charge'
            and je.source_document_id in (v_a.id, v_rev.id)
          group by l.role_key having sum(l.debit - l.credit) <> 0
        ) r;
        v_fail := v_fail || format(
          '8: a charge and its reversal through reverse_charge left a residue in %s account(s): %s. ', v_bad, v_err);
      end if;
    end if;

    -- ===================== 9: A REVERSED DISCOUNT =========================
    insert into guests (tenant_id, first_name, last_name, created_by)
    values (v_tenant, 'ZZ062', 'Discounted', v_user) returning id into v_guest;
    v_folio := open_guest_folio(v_tenant, v_prop, v_guest, 'zz062-folio-2');
    v_a := post_charge(v_folio.id, v_cat, 'ZZ062 laundry', 1, 8000, current_date,
                       'zz062-charge-2', 'manual');
    perform apply_charge_discount(v_a.id, 500, 'ZZ062 goodwill', '4062', 'zz062-k1');
    perform reverse_discount(v_a.id, 'ZZ062 discount withdrawn', '4062', 'zz062-rd-1');
    select * into v_dctr from folio_charges
    where reversal_of_charge_id = v_a.id and reversal_target_type = 'discount'
    order by created_at desc limit 1;
    if not found then
      v_fail := v_fail || '9: reverse_discount wrote no counter charge. ';
    else
      select je.id into v_e1 from journal_entries je
      where je.source_document_type = 'folio_charge' and je.source_document_id = v_dctr.id;
      if v_e1 is null then
        v_fail := v_fail || '9: the discount reversal''s counter posted no entry. ';
      else
        select count(*)::integer into v_bad
        from journal_entry_lines l
        where l.journal_entry_id = v_e1 and l.role_key = v_dctr.account_role_key;
        select coalesce(sum(l.debit - l.credit), 0) into v_amt
        from journal_entry_lines l
        where l.journal_entry_id = v_e1 and l.role_key = 'discounts_allowed';
        if v_bad > 0 or v_amt is distinct from -500.00 then
          v_fail := v_fail || format(
            '9: a discount reversal posted %s revenue leg(s) and %s to discounts_allowed; expected NONE and -500.00. Its gross is 0, so the captured revenue key is for reporting and not for this entry. ',
            v_bad, v_amt);
        end if;
      end if;
    end if;

    -- ===================== 11: THE STAMP ==================================
    select min(folio_gl_wired_at) into v_wired from property_finance_settings;
    if v_wired is null then
      v_fail := v_fail || '11: folio_gl_wired_at is null, so nothing can tell a pre-wiring document from a posted one. ';
    end if;
    -- WHAT IS *NOT* ASSERTED HERE, AND WHY. The first version of this ran
    -- SECTION 5's update again and compared — and breakage J, which deletes
    -- SECTION 5's WHERE clause, stayed GREEN, because the assertion was
    -- re-running its OWN copy of the statement rather than the one it was
    -- testing. That is rule 27's first shape exactly: an assertion that
    -- recomputes the answer it is checking.
    --
    -- "The stamp does not roll forward" is only observable across TWO
    -- APPLICATIONS, which a fixture inside one of them cannot see. So it is
    -- asserted by the dry run, which applies this file twice in one
    -- transaction and compares the stamp between passes; breakage J goes red
    -- there. What IS checkable in one pass is below.
    if v_wired > now() then
      v_fail := v_fail || format(
        '11: the stamp reads %s, which is later than this transaction. It records the moment the folio began posting. ', v_wired);
    end if;
    select count(*)::integer into v_bad
    from property_finance_settings where folio_gl_wired_at is null;
    if v_bad > 0 then
      v_fail := v_fail || format(
        '11: %s propert(ies) still have no folio_gl_wired_at, so a pre-wiring document there cannot be told from a posted one. ', v_bad);
    end if;

    -- ===================== 12: THE PRE-WIRING DOCUMENTS ===================
    select count(*)::integer into v_n
    from (
      select fc.id, fc.created_at, 'folio_charge' k from folio_charges fc
      union all select fp.id, fp.created_at, 'folio_payment' from folio_payments fp
      union all select d.id, d.created_at, 'folio_charge_discount' from folio_charge_discounts d
    ) doc
    where doc.created_at < v_wired;
    if v_n = 0 then
      v_fail := v_fail ||
        '12: no document predates the stamp, so this assertion is vacuous — on this database six of them do. ';
    end if;
    select count(*)::integer into v_bad
    from (
      select fc.id, fc.created_at, 'folio_charge' k from folio_charges fc
      union all select fp.id, fp.created_at, 'folio_payment' from folio_payments fp
      union all select d.id, d.created_at, 'folio_charge_discount' from folio_charge_discounts d
    ) doc
    join journal_entries je
      on je.source_document_type = doc.k and je.source_document_id = doc.id
    where doc.created_at < v_wired;
    if v_bad > 0 then
      v_fail := v_fail || format(
        '12: %s document(s) written before the wiring have entries. They belong in item 8''s pre_wiring bucket. ', v_bad);
    end if;
    raise notice '062: % document(s) predate the wiring and stay unposted.', v_n;

    -- ===================== 13: THE INVARIANT, AND THE GAP =================
    -- ON THE PAST STAY, which is fully posted: four nights, no discount, no
    -- payment, and a balance in the hundreds of thousands rather than zero.
    select coalesce(sum(l.debit - l.credit), 0) into v_amt
    from journal_entry_lines l
    join journal_entries je on je.id = l.journal_entry_id
    where l.role_key = 'guest_ledger'
      and je.source_document_type = 'folio_charge'
      and je.source_document_id in (select id from folio_charges where folio_id = v_pfolio);
    v_bal := folio_balance(v_pfolio);
    if v_amt is distinct from v_bal or v_bal = 0 then
      v_fail := v_fail || format(
        '13: the guest ledger nets %s over the past stay''s entries while folio_balance reads %s. folio_balance is computed from the folio tables and knows nothing about the ledger, which is what makes this a proof rather than a restatement; a zero balance would make it vacuous. ',
        v_amt, v_bal);
    end if;

    -- AND ON THE FORWARD STAY THE GAP IS EXACTLY not_yet_due: the unposted
    -- nights' net plus their tax, which is the figure item 8's third bucket has
    -- to carry. Asserted here so item 8 inherits a measured number.
    select coalesce(sum(l.debit - l.credit), 0) into v_amt
    from journal_entry_lines l
    join journal_entries je on je.id = l.journal_entry_id
    where l.role_key = 'guest_ledger'
      and je.source_document_type = 'folio_charge'
      and je.source_document_id in (select id from folio_charges where folio_id = v_ffolio);
    v_bal := folio_balance(v_ffolio);
    select coalesce(sum(fc.net_amount), 0)
         + coalesce((select sum(t.amount) from folio_charge_tax_lines t
                     where t.folio_charge_id in (
                       select fc2.id from folio_charges fc2
                       where fc2.folio_id = v_ffolio and fc2.charge_date > current_date)), 0)
      into v_amt2
    from folio_charges fc
    where fc.folio_id = v_ffolio and fc.charge_date > current_date;
    if (v_bal - v_amt) is distinct from v_amt2 then
      v_fail := v_fail || format(
        '13: on the early-departure folio the ledger is behind the balance by %s, while the nights not yet due come to %s. Those must be the same number — it is what item 8''s not_yet_due bucket carries, and the only one of the three buckets that is MEANT to be non-zero on an ordinary day. ',
        v_bal - v_amt, v_amt2);
    end if;
    if v_amt2 <= 0 then
      v_fail := v_fail ||
        '13: the forward stay has nothing not-yet-due, so this assertion is comparing zero to zero. ';
    end if;

    select count(*)::integer into v_bad
    from journal_entry_lines l
    where l.role_key = 'rounding_difference'
      and l.journal_entry_id in (select je.id from journal_entries je
        where je.source_document_type in ('folio_charge','folio_payment','folio_charge_discount'));
    if v_bad > 0 then
      v_fail := v_fail || format(
        '13: %s rounding_difference line(s) in folio entries. post_journal absorbs up to 1.00 into that line, so a leg a kobo wrong still balances and still posts. ', v_bad);
    end if;

    -- ===================== 14: WHAT A LONG CHECKOUT COSTS =================
    insert into guests (tenant_id, first_name, last_name, created_by)
    values (v_tenant, 'ZZ062', 'Thirty Nights', v_user) returning id into v_guest;
    v_bk30 := create_booking(v_prop, v_rt, v_guest, current_date, current_date + 30,
                             1, 'zz062-bk-30', 0, null, 'guest', null, null);
    perform check_in_booking(v_bk30.id, 'zz062-ci-30', now());
    v_t0 := clock_timestamp();
    perform check_out_booking(v_bk30.id, 'zz062-co-30');
    v_ms := (extract(epoch from (clock_timestamp() - v_t0)) * 1000)::integer;
    select count(*)::integer into v_n
    from folio_charges fc join folios f on f.id = fc.folio_id
    where f.booking_id = v_bk30.id and fc.source = 'room';
    select count(*)::integer into v_bad
    from folio_charges fc
    join folios f on f.id = fc.folio_id
    join journal_entries je
      on je.source_document_type = 'folio_charge' and je.source_document_id = fc.id
    where f.booking_id = v_bk30.id and fc.source = 'room';
    if v_n <> 30 or v_bad <> 1 then
      v_fail := v_fail || format(
        '14: a 30-night forward stay left %s charge(s) and %s entr(ies); expected 30 and 1, since only tonight has arrived. ', v_n, v_bad);
    end if;
    raise notice '062: a 30-night checkout wrote % charges and posted % entry in % ms (clock_timestamp, real time).',
      v_n, v_bad, v_ms;

    -- ===================== 15: THE GRANTS SURVIVED THE DROP ===============
    select count(*)::integer into v_n
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'post_charge';
    if v_n <> 1 then
      v_fail := v_fail || format(
        '15: there are %s post_charge functions, expected exactly 1. Changing an argument list with create or replace leaves an OVERLOAD, and two post_charges resolve by argument count with nothing to say which a caller meant. ',
        v_n);
    end if;

    select count(*)::integer into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'post_charge'
      and (not has_function_privilege('authenticated', p.oid, 'EXECUTE')
           or has_function_privilege('anon', p.oid, 'EXECUTE'));
    if v_bad > 0 then
      v_fail := v_fail ||
        '15: post_charge is not executable by authenticated, or IS executable by anon. A drop takes the ACL with it, so 021''s three grant lines have to be re-emitted; without them Supabase''s default privileges decide and the front desk either cannot post a charge or anon can. ';
    end if;

    if v_fail <> '' then
      raise exception '062 SELF-VERIFY FAILED — %', v_fail;
    end if;

    raise notice '062 SELF-VERIFY: 15 assertions passed.';
    raise exception 'ZZ_062_FIXTURE_DONE';
  exception
    when others then
      if sqlerrm = 'ZZ_062_FIXTURE_DONE' then
        raise notice '062 self-verify complete; fixture rolled back.';
      else
        raise;
      end if;
  end;
end $$;
