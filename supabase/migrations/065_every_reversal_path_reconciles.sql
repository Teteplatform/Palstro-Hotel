-- ============================================================================
-- 065_every_reversal_path_reconciles.sql
-- Palstro-Hotels: ITEM 7. THE PROOF THAT FOUND ONE MORE DEFECT.
--
-- 1.1h4 item 7, and it was meant to be proof only. The census said every
-- reversal path's financial effect already travels through post_charge_reversal
-- or record_payment, both of which post and are both gated by 064's
-- folio_posting_state. That was right. What the proof then found is one line.
--
-- ############################################################################
-- A PAYMENT REVERSAL'S ENTRY DID NOT KNOW WHAT IT UNWOUND. 063 DID THAT.
-- ############################################################################
-- Measured side by side on the live schema:
--
--     CHARGE  reversal : counter entry reverses_entry_id = SET
--     PAYMENT reversal : row link SET, counter entry reverses_entry_id = NULL
--
-- post_charge_reversal writes reversal_of_charge_id IN ITS INSERT, so when the
-- helper posts at the end of that function the column is already there.
-- reverse_payment writes reversal_of_payment_id in a SEPARATE STATEMENT after
-- record_payment returns — and from 063, when record_payment started posting,
-- the entry was written inside exactly that gap. The helper's lookup of "which
-- entry does this one unwind" found NULL.
--
-- EVERY AMOUNT WAS RIGHT. The pair netted to zero, the folio reconciled, the
-- cash-up balanced. What was gone was the audit pointer — the one field whose
-- entire job is to say that this entry exists because of that one. A journal
-- screen would show a credit of 15,000 with nothing to click through to.
--
-- AND 031'S COMMENT IS RULE 28'S THIRD INSTANCE. It said, of that separate
-- statement: "Same transaction, so no window exists in which the counter-payment
-- is unlinked." True of the FOLIO TABLES, and false of the LEDGER from the day
-- the ledger began reading that column mid-transaction. The sentence promised
-- there was no window; the mechanism was a second statement, which is a window
-- by definition, and it only became load-bearing two years later. A reader
-- checking "same transaction" found it confirmed and stopped — which is rule
-- 28's whole point. SECTION 2 rewrites it where the code changed.
--
-- RULE 28 SAYS THE THIRD INSTANCE MEANS LOOKING FOR A FOURTH BEFORE CLOSING THE
-- SHIPMENT, so that was done: every comment in the migrations promising "no
-- window", "cannot drift", "cannot disagree", "never changes" or atomicity was
-- listed and the candidates read IN PLACE (rule 29). The closest match in shape
-- was 031's and 032's "a reversals row is permanent and never updated, so the
-- copy cannot drift from its source" — and it is TRUE: `reversals` has only a
-- SELECT policy, no UPDATE policy, and not one function writes it. The promise
-- is backed by the absence of any write path. No fourth instance in this family.
--
-- THE FIX IS 046'S SHAPE. record_payment gains p_post_journal, reverse_payment
-- passes false, writes the link, and posts itself. post_stock_receipt already
-- carries that parameter for a caller that needs to post at its own moment, so
-- this is the house pattern rather than a new idea — and the failure mode if
-- somebody ever passes false and forgets to post is benign: the payment reads
-- 'ready' to folio_posting_state and item 2b's sweep takes it the next morning.
--
-- ----------------------------------------------------------------------------
-- WHAT THE CENSUS FOUND, WHICH IS WHY THERE IS ALMOST NO BUILD HERE
-- ----------------------------------------------------------------------------
--   reverse_charge     -> post_charge_reversal        posts (062, gated 064)
--   reverse_discount   -> post_charge_reversal        posts
--   reverse_payment    -> record_payment              posts (fixed here)
--   reverse_no_show    -> reverse_charge              posts
--   void_charge        -> its own document type       posts (064)
--   void_payment       -> its own document type       posts (064)
--   reverse_checkout   -> re-opens the booking and folio, NO financial document
--   reverse_cancel     -> status back to confirmed,   NO financial document
--   cancel_booking     -> no financial effect at all
--
-- reverse_checkout writing no financial document is CORRECT rather than an
-- omission: the guest is back in house, so the nights they slept are still owed
-- and there is nothing to unwind.
--
-- AND A FIRST CENSUS GOT reverse_no_show WRONG, which is rule 29's second
-- instance and the reason that rule now exists. A 300-character window between
-- `set` and `is_voided` reported it as setting the flag itself — which, after
-- 064 made voids post, would have been a void with no counter-entry and the
-- no-show's revenue stranded. It READS the flag, in `if found and
-- v_charge.is_voided is not true then`, and routes the work through
-- reverse_charge. Believed, this shipment would have added a posting call to a
-- function that needs none. Assertion 4 takes that path end to end instead.
--
-- ----------------------------------------------------------------------------
-- WHAT THE BREAKAGES WENT RED FOR (rule 27)
-- ----------------------------------------------------------------------------
-- Ten mutations. ALL TEN red, none skipped.
--
--   A   reverse_payment lets record_payment post BEFORE the link is written
--         -> 3 and 13. THE DEFECT ITSELF, restored
--   B   reverse_payment never posts at all
--         -> 3, and 7 by 15,000.00 — the whole-folio identity catches it
--   C   p_post_journal ignored, so record_payment always posts     -> 3, 13
--   D   p_post_journal inverted, so an ordinary payment stops posting
--         -> 7 by 15,000.00, and 7's cleanliness check names never_voided
--   E   the old six-argument record_payment left in place
--         -> 42725, 'function record_payment(...) is not unique'. The DROP is
--            load-bearing, the same way 062's was
--   F   authenticated explicitly revoked after the drop            -> 14
--   G   anon granted execute                                      -> 14
--   H   a CHARGE counter stops carrying its link                  -> 13
--   I   a VOID stops carrying its link                            -> 13
--   J   the payment helper stops looking the link up at all       -> 3, 13
--
-- ONE ASSERTION WAS WRONG AND THE CODE WAS RIGHT, which is worth the sentence
-- because of what it taught: assertion 2 first asked that a charge, its two
-- discount applications AND a discount reversal net to zero. It went red at
-- revenue -18,000.00 — because a DISCOUNT REVERSAL PUTS THE LINE BACK TO FULL
-- PRICE and does not unwind the sale. The charge's own entry is now deliberately
-- outside that sum, and a second check asserts the sale still stands at its
-- full 18,000.00. The discount comes off the record; the sale stays on it.
--
-- ----------------------------------------------------------------------------
-- THE FIXTURE IS CLEAN OF DECLINED DOCUMENTS, ON PURPOSE
-- ----------------------------------------------------------------------------
-- Every charge is past-dated and every payment is dated today, so assertion 7
-- is a plain EQUALITY between the guest ledger and the sum of folio balances —
-- no buckets, no arithmetic to get wrong. The identity with buckets belongs to
-- item 8, and mixing it in here would make a red run ambiguous between "a
-- reversal path is wrong" and "the bucket arithmetic is wrong". An ambiguous red
-- gets resolved by loosening the assertion rather than by finding the defect.
--
-- So assertion 7 also asserts the fixture IS clean: nothing on these folios is
-- in a waiting_* or never_* state. A later edit that drops a forward night into
-- it is told rather than tolerated.
--
-- And it carries a LIVE, UNREVERSED CHARGE so the comparison is not zero
-- against zero — 149,564.00 across four folios. Third time that has earned its
-- place: 061 for the folio balance, 062 for the early-departure gap, here for a
-- folio whose every other document has been undone.
--
-- ----------------------------------------------------------------------------
-- WHAT THIS FILE DELIBERATELY DOES NOT DO
-- ----------------------------------------------------------------------------
--   * It does not sweep. Item 2b.
--   * It does not reconcile across a property. Item 8, which is the last of the
--     wiring; this proves the identity on folios whose every document has had
--     its day, which is the clean case item 8 has to generalise.
--   * It does not touch the cancellation-fee asymmetry. There is no fee today,
--     so reverse_cancel having nothing to unwind is consistent; the day one is
--     added it will post through post_charge and reverse_cancel will NOT take it
--     back off. Recorded on 10.4, where the policy lands, as what a guest would
--     experience rather than as a schema note.
--   * Its only authorisation change is the one the drop forces: record_payment
--     is dropped and recreated, so 021's three grant lines are re-emitted and
--     assertion 14 checks the end state. reverse_payment keeps what it had.
-- ============================================================================

-- ############################################################################
-- SECTION 2 — THE ONE FIX: A PAYMENT REVERSAL'S ENTRY KNOWS WHAT IT UNWINDS
-- ############################################################################
-- record_payment's signature gains p_post_journal, so the eight-argument form
-- is DROPPED first: create or replace with a different argument list makes an
-- OVERLOAD, and two record_payments would resolve by argument count with
-- nothing to say which a caller meant (062 proved that one — 'function
-- post_charge(...) is not unique').
--
-- A DROP TAKES THE FUNCTION'S GRANTS WITH IT, so 021's three lines are
-- re-emitted verbatim below, and assertion 14 checks the end state.
--
-- src/lib/folio.ts's recordPayment sends the six named arguments it always has
-- and is untouched; PostgREST matches the new form because the seventh has a
-- default.
drop function if exists record_payment(uuid, numeric, text, text, date, text);

CREATE OR REPLACE FUNCTION public.record_payment(p_folio_id uuid, p_amount numeric, p_method text, p_reference text, p_payment_date date, p_idempotency_key text, p_post_journal boolean DEFAULT true)
 RETURNS folio_payments
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_folio    folios;
  v_tenant   uuid;
  v_timezone text;
  v_date     date;
  v_existing folio_payments;
  v_payment  folio_payments;
  v_today    date;
  v_actor    uuid := auth.uid();
begin
  select * into v_folio from folios where id = p_folio_id;
  if not found then
    raise exception 'Folio % not found', p_folio_id using errcode = 'no_data_found';
  end if;
  v_tenant := v_folio.tenant_id;

  if not is_tenant_staff(v_tenant) then
    raise exception 'Not authorised to record payments for this tenant'
      using errcode = 'insufficient_privilege';
  end if;

  -- IDEMPOTENCY (rules 2 & 3) against folio_payments_idem_uniq. This one matters
  -- most of all: a double-clicked "Record ₦200,000" that posts twice makes the
  -- hotel believe it has been paid twice.
  if p_idempotency_key is not null then
    select * into v_existing
    from folio_payments
    where tenant_id = v_tenant and idempotency_key = p_idempotency_key
    limit 1;
    if found then
      return v_existing;
    end if;
  end if;

  -- Payments are accepted on an OPEN folio and on a SETTLED one (a refund or a
  -- correction after settlement is legitimate), but never on a CLOSED one —
  -- closed means finalised, and money moving into a finalised bill with no
  -- re-opening decision is how reconciliations start disagreeing.
  if v_folio.status = 'closed' then
    raise exception 'Folio % is closed and cannot take payments', p_folio_id
      using errcode = 'check_violation';
  end if;

  if p_amount is null or p_amount = 0 then
    raise exception 'A payment amount cannot be zero' using errcode = 'check_violation';
  end if;
  if p_method is null or p_method not in ('cash','bank_transfer','pos','company_account','other') then
    raise exception 'Unknown payment method %', p_method using errcode = 'check_violation';
  end if;

  -- Business date (rules 8, 12), property-local — the operating day the cash-up
  -- will look for it on.
  select p.timezone into v_timezone from properties p where p.id = v_folio.property_id;
  v_today := (now() at time zone
              coalesce(nullif(btrim(v_timezone), ''), 'Africa/Lagos'))::date;
  v_date  := coalesce(p_payment_date, v_today);

  -- 063: A PAYMENT CANNOT BE DATED IN THE FUTURE, AND THERE IS NO ESCAPE
  -- PARAMETER, because unlike a room night there is no caller for whom it is a
  -- real event. Money is not received tomorrow. post_charge needed
  -- p_allow_future because a reserved night genuinely is owed before it
  -- arrives; nothing about a payment is.
  --
  -- It was ACCEPTED before this line, measured rather than assumed: a payment
  -- keyed three days out went in without complaint, and once payments post it
  -- would have failed at post_journal instead — a cashier told the ledger
  -- refused their takings. Refuse at the moment of the typo.
  --
  -- reverse_payment is unaffected: it passes TODAY deliberately ("the money
  -- goes back out today, and today's cash-up is what must show it"), never the
  -- original payment's date, so the only caller of this function cannot trip
  -- the guard.
  if v_date > v_today then
    raise exception
      'A payment cannot be dated in the future (today is % at this property)', v_today
      using errcode = 'PT422',
            hint = 'Check the date. A payment is recorded on the day the money arrives; the cash-up for that day is what has to balance against it.';
  end if;

  begin
    insert into folio_payments (
      tenant_id, property_id, folio_id, amount, method, reference,
      payment_date, received_by, idempotency_key, created_by
    ) values (
      v_tenant, v_folio.property_id, p_folio_id, p_amount, p_method, p_reference,
      v_date,
      -- received_by (DECISION 4) defaults to the keying user, which is the common
      -- case. A hand-over — cash taken by one person, posted by another — is
      -- recorded by the checkout screen passing the real receiver once the
      -- staff-permissions build exists. created_by stays the non-forgeable truth.
      v_actor,
      p_idempotency_key, v_actor
    )
    returning * into v_payment;
  exception
    when unique_violation then
      if p_idempotency_key is not null then
        select * into v_existing
        from folio_payments
        where tenant_id = v_tenant and idempotency_key = p_idempotency_key
        limit 1;
        if found then
          return v_existing;
        end if;
      end if;
      raise;
  end;

  -- 065: ...UNLESS ITS ONE INTERNAL CALLER IS GOING TO DO IT ITSELF.
  --
  -- p_post_journal exists for reverse_payment and for nothing else, and it
  -- exists because of a measured defect. reverse_payment writes the counter
  -- through this function and then sets reversal_of_payment_id in a SEPARATE
  -- statement — so from 063, when this line started posting, the entry was
  -- written while that column was still NULL, and the helper's lookup of
  -- "which entry does this one unwind" found nothing. Measured: a charge
  -- reversal's entry carries reverses_entry_id and a payment reversal's does
  -- not. Every amount was right; the audit pointer was gone.
  --
  -- 031's comment on that separate statement said "same transaction, so no
  -- window exists in which the counter-payment is unlinked". True of the folio
  -- tables, and false of the ledger from the day the ledger started reading
  -- the column mid-transaction. That is rule 28's third instance in this
  -- codebase, and SECTION 2 rewrites the sentence where the code changed.
  --
  -- THE SHAPE IS 046'S. post_stock_receipt already takes p_post_journal for a
  -- caller that needs to post at its own moment, so this is the house pattern
  -- rather than a new idea — and there, as here, THE CALLER THAT PASSES FALSE
  -- POSTS THE ENTRY ITSELF, in the same function, a few statements later.
  --
  -- THERE IS NO SAFETY NET FOR FORGETTING, TODAY. A payment written with
  -- p_post_journal => false and never posted simply never reaches the ledger:
  -- folio_posting_state will read it as 'ready', and nothing acts on 'ready'
  -- yet. ITEM 1.1h4b's SWEEP IS WHAT WOULD CATCH IT, and 1.1h4b does not
  -- exist. So until it ships, this parameter has exactly one legitimate caller
  -- and that caller must post in the same breath — which reverse_payment does,
  -- two statements below its link.
  --
  -- When 1.1h4b lands, delete this paragraph and say so: the sweep posts what
  -- has come due, and a forgotten false becomes a one-morning delay instead of
  -- a permanent hole. Writing it the other way round — describing the world
  -- after the next shipment — is a comment that is wrong today.
  if p_post_journal then
  -- 063: AND NOW IT POSTS. The money side at the account its METHOD maps to,
  -- the guest ledger left OPEN so the receivable is the sum of what was
  -- written. The mapping is an explicit whitelist that refuses an unknown
  -- method BY NAME (061 §3) rather than building a role key by concatenation:
  -- a constructed key fails as a MISSING ACCOUNT MAPPING, which somebody fixes
  -- by adding a mapping, when the real answer is that a method nobody decided
  -- an account for has reached the front desk. 'other' is the one legal value
  -- with no account, and it is what the assertion exercises.
  --
  -- NO DECLINE HERE, and that is the difference from the other two helpers: the
  -- refusal above makes a forward-dated payment impossible to write, so a
  -- decline in post_folio_payment_journal would be unreachable code. One rule,
  -- one place. Item 2b's sweep filters by date for all three document types
  -- regardless, so nothing depends on the symmetry.
  --
  -- NOT ON THE REPLAY PATH, inside the unique_violation handler above: it
  -- returns a payment somebody else wrote, and if that payment predates the
  -- wiring, posting here would move it out of the pre_wiring bucket for no
  -- reason but who happened to retry.
    perform post_folio_payment_journal(v_payment.id);
  end if;

  return v_payment;
end;
$function$
;

revoke execute on function record_payment(uuid, numeric, text, text, date, text, boolean) from public;
revoke execute on function record_payment(uuid, numeric, text, text, date, text, boolean) from anon;
grant  execute on function record_payment(uuid, numeric, text, text, date, text, boolean) to authenticated;

-- ----------------------------------------------------------------------------
-- And the one caller that needs it. Its own signature does not change, so no
-- drop and no grant to restore.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reverse_payment(p_payment_id uuid, p_reason text, p_manager_pin text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS reversals
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_payment     folio_payments;
  v_folio       folios;
  v_counter     folio_payments;
  v_reversal    reversals;
  v_existing    reversals;
  v_manager     uuid;
  v_reason      text;
  v_key         text;
  v_counter_key text;
  v_timezone    text;
  v_date        date;
  v_actor       uuid := auth.uid();
begin
  -- --- GUARD 1: resolve and LOCK the original ------------------------------
  -- FOR UPDATE before anything else: this lock is what serialises two
  -- simultaneous reversals of the same payment. The second call blocks here,
  -- and when it proceeds its guards see the first's committed work.
  select * into v_payment from folio_payments where id = p_payment_id for update;
  if not found then
    raise exception 'Payment % not found', p_payment_id using errcode = 'no_data_found';
  end if;

  -- --- GUARD 2: staff gate, then this caller's own property grant -----------
  if not is_tenant_staff(v_payment.tenant_id) then
    raise exception 'Not authorised to reverse payments for this tenant'
      using errcode = 'insufficient_privilege';
  end if;
  if not (v_payment.property_id = any(get_property_ids())) then
    raise exception 'You do not have access to this property'
      using errcode = 'insufficient_privilege';
  end if;

  -- The reversals row's key: the caller's, or the deterministic one. The
  -- COUNTER-PAYMENT's key (below) is ALWAYS the deterministic one, whatever the
  -- caller passed — see the comment at the record_payment call.
  v_counter_key := 'reversal:payment:' || p_payment_id::text;
  v_key := coalesce(nullif(btrim(p_idempotency_key), ''), v_counter_key);

  -- --- GUARD 3: idempotency BY KEY (rules 2 & 3) ---------------------------
  -- Before the PIN check on purpose: a retried intent returns the first
  -- outcome without demanding the manager come back to the terminal.
  select * into v_existing
  from reversals
  where tenant_id = v_payment.tenant_id and idempotency_key = v_key
  limit 1;
  if found then
    return v_existing;
  end if;

  -- --- GUARD 4: idempotency BY STATE — already reversed? -------------------
  -- The stronger of the two: it catches a retry arriving with a different key,
  -- and (holding the row lock from GUARD 1) it is what makes "a payment is
  -- reversed at most once" true under concurrency rather than merely likely.
  select * into v_existing
  from reversals
  where tenant_id = v_payment.tenant_id
    and target_type = 'payment'
    and target_id = p_payment_id
  limit 1;
  if found then
    return v_existing;
  end if;

  -- --- GUARD 5: the original must not be voided ----------------------------
  if v_payment.is_voided is true then
    raise exception
      'Payment % is voided; it counts for nothing and cannot be reversed', p_payment_id
      using errcode = 'check_violation',
            hint = 'A voided payment is already out of every total. Reversing it would move the balance by an amount the bill never included.';
  end if;

  -- --- GUARD 6: the original must not itself be a counter-entry ------------
  if v_payment.reversal_of_payment_id is not null then
    raise exception 'This line is itself a payment reversal and cannot be reversed'
      using errcode = 'check_violation',
            hint = 'The money is already back where it started. Post a fresh payment if it needs to be taken again.';
  end if;

  -- --- GUARD 7: the folio must not be closed -------------------------------
  select * into v_folio from folios where id = v_payment.folio_id;
  if v_folio.status = 'closed' then
    raise exception 'Folio % is closed; its payments cannot be reversed', v_folio.id
      using errcode = 'check_violation';
  end if;

  -- --- GUARD 8: the reason is mandatory HERE, not only in the UI (rule 19) --
  v_reason := btrim(coalesce(p_reason, ''));
  if v_reason = '' then
    raise exception 'A reversal needs a reason' using errcode = 'check_violation';
  end if;

  -- --- GUARD 9: A MANAGER PIN. ALWAYS. NO THRESHOLD. -----------------------
  -- §3.2 says why there is no amount below which this is skipped. verify_manager_pin
  -- returns the user_id of the ACTIVE owner/manager whose PIN matched, or NULL —
  -- fail closed. It is revoked from every client role (021 §12), so this is the
  -- only kind of place it can be called from.
  v_manager := verify_manager_pin(v_payment.tenant_id, p_manager_pin);
  if v_manager is null then
    raise exception 'Reversing a payment always requires a valid manager PIN'
      using errcode = 'insufficient_privilege',
            hint = 'Hand the terminal to a manager. The reversal is recorded against them by name.';
  end if;

  -- --- THE EFFECT, all of it inside this one transaction (§3.4) ------------

  -- The business date (rules 8, 12), resolved in the PROPERTY's timezone exactly
  -- as record_payment and create_booking do. It is the date the REVERSAL happens,
  -- never the original payment's date: the money goes back out today, and today's
  -- cash-up is what must show it.
  select p.timezone into v_timezone from properties p where p.id = v_payment.property_id;
  v_date := (now() at time zone coalesce(nullif(btrim(v_timezone), ''), 'Africa/Lagos'))::date;

  -- THE COUNTER-ENTRY, THROUGH THE EXISTING PAYMENT PATH. Not a hand-rolled
  -- insert: record_payment (021 §9.4) re-checks the folio status, validates the
  -- method, stamps the actor and arbitrates its own idempotency against
  -- folio_payments_idem_uniq. Reversal money must not travel a second, parallel
  -- road that could diverge from the first.
  --
  --   * amount = -amount. Payments are SIGNED (021 DECISION 3), so the negation
  --     IS the reversal — a +₦200,000 settlement reverses to -₦200,000, and a
  --     -₦50,000 refund reverses to +₦50,000. No direction flag, no CASE.
  --   * method = the original's. Cash reversed is cash out; the cash-up must see
  --     the two against the same tender.
  --   * reference = the human marker. folio_payments has no description column,
  --     and reference is its free-text field ("transfer ref, POS STAN, etc."), so
  --     this is where the line's own words live. The bill, the guest ledger view
  --     (027 §4 projects p.reference) and the statement all already print it, so
  --     the counter-line reads as "Payment reversal — <reason>" everywhere with
  --     no renderer change. The reason is COPIED, not joined: a reversals row is
  --     permanent and never updated, so the copy cannot drift from its source.
  --   * key = the DETERMINISTIC key, always, even when the caller passed one of
  --     their own. Two different caller keys must not be able to post two counter
  --     payments; with one fixed key, folio_payments_idem_uniq refuses the second
  --     outright. It also cannot collide with an ordinary payment's key, which a
  --     caller-supplied value could.
  v_counter := record_payment(
    v_payment.folio_id,
    - v_payment.amount,
    v_payment.method,
    'Payment reversal — ' || v_reason,
    v_date,
    v_counter_key,
    -- 065: DO NOT POST IT YET. The link below is what the entry needs, and it
    -- is not on the row until the next statement.
    false
  );

  -- The link back (§2). A separate statement because record_payment deliberately
  -- takes no reversal parameter — widening the signature of the ONE payment RPC
  -- for one caller's benefit is how a shared path starts growing special cases.
  --
  -- 065 CORRECTS WHAT THIS COMMENT USED TO CLAIM. It said "same transaction, so
  -- no window exists in which the counter-payment is unlinked". That was true of
  -- the FOLIO TABLES and became false of the LEDGER in 063, when record_payment
  -- started posting: the entry was written inside exactly that window, the
  -- helper's lookup of which entry this one unwinds found NULL, and the
  -- counter-entry shipped with no link. Measured — a charge reversal's entry
  -- carried reverses_entry_id and a payment reversal's did not — because
  -- post_charge_reversal sets its link IN THE INSERT and this one sets it after.
  --
  -- The window is real whenever anything inside the transaction reads the
  -- column. So the posting now happens AFTER this statement, by this function,
  -- and record_payment is told not to do it.
  update folio_payments
     set reversal_of_payment_id = p_payment_id,
         updated_by             = v_actor
   where id = v_counter.id
  returning * into v_counter;

  -- NOW it can post: the column the helper reads is on the row.
  perform post_folio_payment_journal(v_counter.id);

  -- THE AUDIT ROW. Written last, so it can name the counter-entry it produced.
  begin
    insert into reversals (
      tenant_id, property_id, reversed_by, approved_by, reason,
      target_type, target_id, counter_entry_id, business_date,
      idempotency_key, created_by
    ) values (
      v_payment.tenant_id, v_payment.property_id, v_actor, v_manager, v_reason,
      'payment', p_payment_id, v_counter.id, v_date,
      v_key, v_actor
    )
    returning * into v_reversal;
  exception
    when unique_violation then
      -- A concurrent caller won a race the GUARD 1 lock should already have
      -- prevented. Return THEIR row — but only if it genuinely exists: re-raising
      -- otherwise aborts the whole call, rolling the counter-payment back with
      -- it, so this handler can never leave a counter-payment without its audit
      -- row.
      select * into v_existing
      from reversals
      where tenant_id = v_payment.tenant_id
        and (idempotency_key = v_key
             or (target_type = 'payment' and target_id = p_payment_id))
      limit 1;
      if found then
        return v_existing;
      end if;
      raise;
  end;

  return v_reversal;
end;
$function$
;

-- ############################################################################
-- SECTION 1 — THE PROOF
-- ############################################################################
-- Fourteen assertions and ONE FIX. This shipment was meant to be proof only,
-- and assertion 13 is the defect the proof found.
--
-- Every reversal path is exercised through the
-- CLIENT-CALLABLE RPC rather than through the internal writer, because that is
-- the thing the front desk reaches and the thing nobody had taken end to end.
--
-- ----------------------------------------------------------------------------
-- THE FIXTURE IS DELIBERATELY CLEAN OF DECLINED DOCUMENTS, AND SAYS SO
-- ----------------------------------------------------------------------------
-- Every charge here is PAST-DATED and every payment is dated today, so every
-- document has had its day and the guest ledger equals folio_balance EXACTLY.
-- Not one not-yet-due night is folded in.
--
-- That is a decision, not an accident. The identity
--
--     guest ledger + pre_gl + pre_wiring + not_yet_due = sum of folio balances
--
-- belongs to item 8. Mixing it in here would make a red run AMBIGUOUS between
-- "a reversal path is wrong" and "the bucket arithmetic is wrong" — and an
-- ambiguous red is the kind that gets resolved by loosening the assertion
-- rather than by finding the defect. So assertion 7 asserts the clean identity
-- AND asserts that the fixture is clean, so a later edit that drops a forward
-- night into it is told rather than tolerated.
--
-- AND IT CARRIES A LIVE, UNREVERSED CHARGE so the comparison is not zero
-- against zero. Third time that has earned its place: 061 §5 needed it for the
-- folio balance, 062 for the early-departure gap, and here for a folio whose
-- every other document has been undone.
--
--   1  reverse_charge: the pair nets to ZERO in every account, through the RPC.
--   2  reverse_discount: the counter carries NO revenue leg (its gross is 0),
--      and the charge, its applications and the counter net to zero.
--   3  reverse_payment: mirrored by sign, linked to the entry it unwinds, and
--      dated TODAY rather than the original's day.
--   4  reverse_no_show: the no-show charge and its counter net to zero. THE
--      PATH NOBODY HAD TAKEN THROUGH THE LEDGER — it routes through
--      reverse_charge, which a first census got wrong (rule 29).
--   5  void_charge through the RPC: the mirror nets the charge and every
--      discount on it to zero.
--   6  void_payment through the RPC: likewise.
--   7  THE WHOLE-FOLIO IDENTITY. Over every folio this fixture touches, the
--      guest ledger equals the sum of folio_balance, it is NON-ZERO, and no
--      document on any of them is in a waiting_* or never_* state.
--   8  folio_posting_state FOR EVERY DOCUMENT on those folios, which is the
--      first time the classifier is read across a whole history rather than one
--      document at a time. Everything is 'posted' except what was never
--      supposed to post, and each exception is named.
--   9  reverse_checkout LEAVES THE FOLIO RECONCILING. Stated that way rather
--      than as "it posts nothing", because the day a cancellation or early
--      departure fee is added, posting becomes the CORRECT behaviour and a
--      proof that fails for doing the right thing gets deleted rather than
--      understood.
--  10  reverse_cancel, the same. Its folio carries no financial document today,
--      so its own balance is zero; it is summed into assertion 7's identity,
--      which is not.
--  11  A COUNTER CANNOT BE REVERSED OR VOIDED, by SQLSTATE and message. 064
--      argued its recursion terminates because reversal_of_charge_id points at
--      an older row; this replaces the argument with the constraint. The chain
--      is at most two deep because the database says so.
--  12  NO ENTRY IS SHORT AND NONE NEEDED ROUNDING, across every folio entry.
--  13  EVERY COUNTER-ENTRY KNOWS WHAT IT UNWINDS. A charge counter, a payment
--      counter and a void, all three carrying reverses_entry_id. This is the
--      defect SECTION 2 fixes: 063 made record_payment post, and it posted
--      BEFORE reverse_payment had written the link, so every payment reversal
--      shipped with a null pointer while every amount stayed correct.
--  14  THE GRANTS SURVIVED THE DROP. record_payment's argument list changes, so
--      it is dropped and recreated, and a drop takes the ACL with it. Exactly
--      one record_payment exists, authenticated can execute it, anon cannot,
--      and both it and reverse_payment keep SECURITY DEFINER with a pinned
--      search_path.
do $$
declare
  v_tenant  uuid;
  v_user    uuid;
  v_prop    uuid;
  v_rt      uuid;
  v_guest   uuid;
  v_cat     uuid;
  v_folio   folios;
  v_folios  uuid[] := '{}';
  v_a       folio_charges;   -- reversed by reverse_charge
  v_b       folio_charges;   -- discounted, then reverse_discount
  v_c       folio_charges;   -- voided
  v_d       folio_charges;   -- LIVE and unreversed: the non-zero
  v_ctr     folio_charges;
  v_p1      folio_payments;  -- reversed
  v_p2      folio_payments;  -- voided
  v_bk_ns   uuid;
  v_bk_co   uuid;
  v_bk_ca   uuid;
  v_disc    uuid;
  v_e       uuid;
  v_st      text;
  v_n       integer;
  v_bad     integer;
  v_amt     numeric;
  v_amt2    numeric;
  v_bal     numeric;
  v_err     text;
  v_state   text;
  v_ok      boolean;
  v_fail    text := '';
  v_d1      date;
begin
  begin
    select tu.tenant_id, tu.user_id into v_tenant, v_user
    from tenant_users tu where tu.is_active and tu.role in ('owner','manager') limit 1;
    select p.id into v_prop from properties p where p.tenant_id = v_tenant limit 1;
    if v_tenant is null or v_prop is null then
      raise notice '065 SELF-VERIFY SKIPPED: no tenant or active owner/manager.';
      raise exception 'ZZ_065_FIXTURE_DONE';
    end if;
    perform set_config('request.jwt.claims',
      json_build_object('role','service_role','sub', v_user::text)::text, true);

    -- THIS OVERWRITES A REAL MANAGER'S PIN, and it is only safe because the
    -- ZZ_065_FIXTURE_DONE sentinel below guarantees this block rolls back — the
    -- raise is unconditional, so no path commits it. Anyone copying this
    -- pattern into something that COMMITS must use a throwaway user instead.
    insert into manager_pins (tenant_id, user_id, pin_hash)
    values (v_tenant, v_user, crypt('4065', gen_salt('bf')))
    on conflict (tenant_id, user_id) do update set pin_hash = excluded.pin_hash;

    select cc.id into v_cat from charge_categories cc
    where cc.tenant_id = v_tenant and cc.is_taxable and cc.deleted_at is null
      and cc.is_active and cc.code <> 'room'
    order by cc.code limit 1;
    select rt.id into v_rt from room_types rt
    where rt.tenant_id = v_tenant and rt.deleted_at is null
    order by rt.base_rate limit 1;
    if v_cat is null or v_rt is null then
      raise exception '065 SELF-VERIFY needs a taxable non-room category and a room type.';
    end if;

    -- ===================== THE WALK-IN FOLIO ==============================
    -- Four charges and two payments, all past-dated or today, so every document
    -- has had its day. One charge is left ALIVE.
    insert into guests (tenant_id, first_name, last_name, created_by)
    values (v_tenant, 'ZZ065', 'Every Path', v_user) returning id into v_guest;
    v_folio := open_guest_folio(v_tenant, v_prop, v_guest, 'zz065-folio-1');
    v_folios := v_folios || v_folio.id;

    v_a := post_charge(v_folio.id, v_cat, 'ZZ065 to be reversed', 1, 12000,
                       current_date - 3, 'zz065-c-a', 'manual');
    v_b := post_charge(v_folio.id, v_cat, 'ZZ065 to be discounted then undone', 1, 18000,
                       current_date - 3, 'zz065-c-b', 'manual');
    v_c := post_charge(v_folio.id, v_cat, 'ZZ065 to be voided', 1, 9000,
                       current_date - 2, 'zz065-c-c', 'manual');
    v_d := post_charge(v_folio.id, v_cat, 'ZZ065 LIVE, never undone', 1, 25000,
                       current_date - 1, 'zz065-c-d', 'manual');

    -- ---- 1: reverse_charge, through the RPC ----------------------------
    perform reverse_charge(v_a.id, 'ZZ065 keyed against the wrong room', '4065', 'zz065-rc-a');
    select count(*)::integer into v_bad
    from (
      select l.role_key, sum(l.debit - l.credit) net
      from journal_entry_lines l join journal_entries je on je.id = l.journal_entry_id
      where je.source_document_type = 'folio_charge'
        and (je.source_document_id = v_a.id
             or je.source_document_id in (select id from folio_charges
                                          where reversal_of_charge_id = v_a.id))
      group by l.role_key having sum(l.debit - l.credit) <> 0
    ) r;
    if v_bad > 0 then
      select string_agg(format('%s %s', r.role_key, r.net), ', ') into v_err
      from (
        select l.role_key, sum(l.debit - l.credit) net
        from journal_entry_lines l join journal_entries je on je.id = l.journal_entry_id
        where je.source_document_type = 'folio_charge'
          and (je.source_document_id = v_a.id
               or je.source_document_id in (select id from folio_charges
                                            where reversal_of_charge_id = v_a.id))
        group by l.role_key having sum(l.debit - l.credit) <> 0
      ) r;
      v_fail := v_fail || format(
        '1: a charge reversed through reverse_charge left a residue in %s account(s): %s. ', v_bad, v_err);
    end if;

    -- ---- 2: reverse_discount, through the RPC --------------------------
    perform apply_charge_discount(v_b.id, 1500, 'ZZ065 goodwill', '4065', 'zz065-k-b1');
    perform apply_charge_discount(v_b.id, 4000, 'ZZ065 more goodwill', '4065', 'zz065-k-b2');
    perform reverse_discount(v_b.id, 'ZZ065 the discount was not authorised', '4065', 'zz065-rd-b');
    select * into v_ctr from folio_charges
    where reversal_of_charge_id = v_b.id and reversal_target_type = 'discount'
    order by created_at desc limit 1;
    if not found then
      v_fail := v_fail || '2: reverse_discount wrote no counter charge. ';
    else
      select je.id into v_e from journal_entries je
      where je.source_document_type = 'folio_charge' and je.source_document_id = v_ctr.id;
      if v_e is null then
        v_fail := v_fail || '2: the discount reversal''s counter posted no entry. ';
      else
        select count(*)::integer into v_bad
        from journal_entry_lines l
        where l.journal_entry_id = v_e and l.role_key = v_ctr.account_role_key;
        if v_bad > 0 then
          v_fail := v_fail || format(
            '2: the discount reversal''s counter posted %s revenue leg(s). Its gross is 0, so the captured revenue key on the row is for reporting and not for this entry. ',
            v_bad);
        end if;
      end if;
      -- THE APPLICATIONS AND THE COUNTER NET TO ZERO — the charge's OWN entry is
      -- deliberately NOT in this sum. A discount reversal puts the line back to
      -- FULL PRICE; it does not unwind the charge. The first version of this
      -- assertion included the charge's entry and went red at revenue
      -- -18,000.00 against code that was perfectly correct, which is the
      -- clearest statement of what reverse_discount is: the discount comes off
      -- the record, the sale stays on it.
      select count(*)::integer into v_bad
      from (
        select l.role_key, sum(l.debit - l.credit) net
        from journal_entry_lines l join journal_entries je on je.id = l.journal_entry_id
        where (je.source_document_type = 'folio_charge'
               and je.source_document_id = v_ctr.id)
           or (je.source_document_type = 'folio_charge_discount'
               and je.source_document_id in (select d.id from folio_charge_discounts d
                                             where d.folio_charge_id = v_b.id))
        group by l.role_key having sum(l.debit - l.credit) <> 0
      ) r;
      if v_bad > 0 then
        select string_agg(format('%s %s', r.role_key, r.net), ', ') into v_err
        from (
          select l.role_key, sum(l.debit - l.credit) net
          from journal_entry_lines l join journal_entries je on je.id = l.journal_entry_id
          where (je.source_document_type = 'folio_charge'
                 and je.source_document_id = v_ctr.id)
             or (je.source_document_type = 'folio_charge_discount'
                 and je.source_document_id in (select d.id from folio_charge_discounts d
                                               where d.folio_charge_id = v_b.id))
          group by l.role_key having sum(l.debit - l.credit) <> 0
        ) r;
        v_fail := v_fail || format(
          '2: two discount applications and their reversal left a residue in %s account(s): %s. The relief must come back off exactly, tax included. ',
          v_bad, v_err);
      end if;

      -- AND THE SALE IS STILL ON THE BOOKS AT FULL PRICE. The counter has gross
      -- 0, so revenue is untouched: the charge's own credit stands alone.
      select coalesce(-sum(l.debit - l.credit), 0) into v_amt
      from journal_entry_lines l join journal_entries je on je.id = l.journal_entry_id
      where l.role_key = v_b.account_role_key
        and je.source_document_type = 'folio_charge'
        and je.source_document_id in (v_b.id, v_ctr.id);
      if v_amt is distinct from 18000.00 then
        v_fail := v_fail || format(
          '2: after the discount reversal the sale stands at %s in revenue, expected the full 18000.00. ', v_amt);
      end if;
    end if;

    -- ---- 5: void_charge, through the RPC -------------------------------
    perform apply_charge_discount(v_c.id, 500, 'ZZ065 small goodwill', '4065', 'zz065-k-c1');
    perform void_charge(v_c.id, 'ZZ065 never happened', 'zz065-vc-c');
    select count(*)::integer into v_bad
    from (
      select l.role_key, sum(l.debit - l.credit) net
      from journal_entry_lines l join journal_entries je on je.id = l.journal_entry_id
      where (je.source_document_type in ('folio_charge','folio_charge_void')
             and je.source_document_id = v_c.id)
         or (je.source_document_type = 'folio_charge_discount'
             and je.source_document_id in (select d.id from folio_charge_discounts d
                                           where d.folio_charge_id = v_c.id))
      group by l.role_key having sum(l.debit - l.credit) <> 0
    ) r;
    if v_bad > 0 then
      v_fail := v_fail || format(
        '5: a discounted charge voided through void_charge left a residue in %s account(s). The mirror spans the charge AND its applications. ', v_bad);
    end if;

    -- ---- 3: reverse_payment, through the RPC ---------------------------
    v_p1 := record_payment(v_folio.id, 15000, 'cash', 'ZZ065 settlement',
                           current_date, 'zz065-p-1');
    perform reverse_payment(v_p1.id, 'ZZ065 wrong guest', '4065', 'zz065-rp-1');
    select * into v_p2 from folio_payments
    where reversal_of_payment_id = v_p1.id order by created_at desc limit 1;
    if not found then
      v_fail := v_fail || '3: reverse_payment wrote no counter payment. ';
    else
      select je.id into v_e from journal_entries je
      where je.source_document_type = 'folio_payment' and je.source_document_id = v_p2.id;
      select coalesce(sum(l.debit - l.credit), 0) into v_amt
      from journal_entry_lines l where l.journal_entry_id = v_e and l.role_key = 'cash';
      select coalesce(sum(l.debit - l.credit), 0) into v_amt2
      from journal_entry_lines l where l.journal_entry_id = v_e and l.role_key = 'guest_ledger';
      if v_amt is distinct from -15000.00 or v_amt2 is distinct from 15000.00 then
        v_fail := v_fail || format(
          '3: the payment reversal posted cash %s and receivable %s, expected -15000.00 and +15000.00. ',
          v_amt, v_amt2);
      end if;
      select je.reverses_entry_id into v_e
      from journal_entries je
      where je.source_document_type = 'folio_payment' and je.source_document_id = v_p2.id;
      if v_e is distinct from (select je2.id from journal_entries je2
                               where je2.source_document_type = 'folio_payment'
                                 and je2.source_document_id = v_p1.id) then
        v_fail := v_fail || '3: the payment reversal is not linked to the entry it unwinds. ';
      end if;
      if v_p2.payment_date is distinct from current_date then
        v_fail := v_fail || format(
          '3: the payment reversal is dated %s rather than today. The money goes back out today, and today''s cash-up is what has to show it. ',
          v_p2.payment_date);
      end if;
    end if;

    -- ---- 6: void_payment, through the RPC ------------------------------
    v_p2 := record_payment(v_folio.id, 6000, 'pos', 'ZZ065 card',
                           current_date, 'zz065-p-2');
    perform void_payment(v_p2.id, 'ZZ065 terminal declined after all', 'zz065-vp-2');
    select count(*)::integer into v_bad
    from (
      select l.role_key, sum(l.debit - l.credit) net
      from journal_entry_lines l join journal_entries je on je.id = l.journal_entry_id
      where je.source_document_type in ('folio_payment','folio_payment_void')
        and je.source_document_id = v_p2.id
      group by l.role_key having sum(l.debit - l.credit) <> 0
    ) r;
    if v_bad > 0 then
      v_fail := v_fail || format(
        '6: a payment voided through void_payment left a residue in %s account(s). ', v_bad);
    end if;

    -- ===================== 4: reverse_no_show =============================
    -- A GUARANTEED booking, because mark_no_show charges only a booking with a
    -- company or billed to one; a walk-in who fails to arrive owes nothing.
    insert into guests (tenant_id, first_name, last_name, created_by)
    values (v_tenant, 'ZZ065', 'No Show', v_user) returning id into v_guest;
    insert into bookings (tenant_id, property_id, room_type_id, guest_id,
                          booking_number, check_in, check_out, adults, status,
                          bill_to, created_by)
    values (v_tenant, v_prop, v_rt, v_guest, 'ZZ065-NS', current_date - 3,
            current_date - 2, 1, 'confirmed', 'company', v_user)
    returning id into v_bk_ns;
    insert into booking_nights (tenant_id, property_id, booking_id, stay_date,
                                rate, rate_source, created_by)
    values (v_tenant, v_prop, v_bk_ns, current_date - 3, 70000, 'fixture', v_user);
    perform mark_no_show(v_bk_ns, 'zz065-ns');
    select f.id into v_e from folios f where f.booking_id = v_bk_ns;
    v_folios := v_folios || v_e;

    perform reverse_no_show(v_bk_ns, 'ZZ065 the guest arrived after all', '4065', 'zz065-rns');
    select count(*)::integer into v_bad
    from (
      select l.role_key, sum(l.debit - l.credit) net
      from journal_entry_lines l join journal_entries je on je.id = l.journal_entry_id
      where je.source_document_type = 'folio_charge'
        and je.source_document_id in (select id from folio_charges where folio_id = v_e)
      group by l.role_key having sum(l.debit - l.credit) <> 0
    ) r;
    if v_bad > 0 then
      v_fail := v_fail || format(
        '4: a no-show reversed through reverse_no_show left a residue in %s account(s). It routes through reverse_charge — a first census said it set is_voided itself, which it does not (rule 29). ',
        v_bad);
    end if;
    select count(*)::integer into v_n
    from folio_charges fc where fc.folio_id = v_e;
    if v_n <> 2 then
      v_fail := v_fail || format(
        '4: the no-show folio holds %s charge(s), expected 2 — the no-show charge and its counter. ', v_n);
    end if;

    -- ===================== 9: reverse_checkout ============================
    -- A PAST stay, so every night it bills has had its day and posts.
    insert into guests (tenant_id, first_name, last_name, created_by)
    values (v_tenant, 'ZZ065', 'Checked Out', v_user) returning id into v_guest;
    insert into bookings (tenant_id, property_id, room_type_id, guest_id,
                          booking_number, check_in, check_out, adults, status,
                          bill_to, created_by)
    values (v_tenant, v_prop, v_rt, v_guest, 'ZZ065-CO', current_date - 3,
            current_date - 1, 1, 'checked_in', 'guest', v_user)
    returning id into v_bk_co;
    for v_d1 in select (current_date - 3) + g from generate_series(0, 1) g loop
      insert into booking_nights (tenant_id, property_id, booking_id, stay_date,
                                  rate, rate_source, created_by)
      values (v_tenant, v_prop, v_bk_co, v_d1, 48000, 'fixture', v_user);
    end loop;
    perform check_out_booking(v_bk_co, 'zz065-co');
    select f.id into v_e from folios f where f.booking_id = v_bk_co;
    v_folios := v_folios || v_e;
    perform reverse_checkout(v_bk_co, 'ZZ065 checked out by mistake', '4065', 'zz065-rco');
    -- STATED AS RECONCILIATION, not as "it posts nothing": the day an early
    -- departure or cancellation fee exists, posting is the CORRECT behaviour,
    -- and a proof that fails for doing the right thing gets deleted rather than
    -- understood.
    select coalesce(sum(l.debit - l.credit), 0) into v_amt
    from journal_entry_lines l join journal_entries je on je.id = l.journal_entry_id
    where l.role_key = 'guest_ledger'
      and ((je.source_document_type in ('folio_charge','folio_charge_void')
            and je.source_document_id in (select id from folio_charges where folio_id = v_e))
        or (je.source_document_type in ('folio_payment','folio_payment_void')
            and je.source_document_id in (select id from folio_payments where folio_id = v_e)));
    v_bal := folio_balance(v_e);
    if v_amt is distinct from v_bal then
      v_fail := v_fail || format(
        '9: after reverse_checkout the guest ledger nets %s over that folio while folio_balance reads %s. The nights the guest slept are still owed; reversing the checkout does not unwind them. ',
        v_amt, v_bal);
    end if;
    if v_bal = 0 then
      v_fail := v_fail ||
        '9: the reversed-checkout folio balances to zero, so this assertion is comparing zero to zero. Its two nights should still be owed. ';
    end if;

    -- ===================== 10: reverse_cancel =============================
    insert into guests (tenant_id, first_name, last_name, created_by)
    values (v_tenant, 'ZZ065', 'Cancelled', v_user) returning id into v_guest;
    insert into bookings (tenant_id, property_id, room_type_id, guest_id,
                          booking_number, check_in, check_out, adults, status,
                          bill_to, created_by)
    values (v_tenant, v_prop, v_rt, v_guest, 'ZZ065-CA', current_date + 7,
            current_date + 9, 1, 'cancelled', 'guest', v_user)
    returning id into v_bk_ca;
    insert into booking_nights (tenant_id, property_id, booking_id, stay_date,
                                rate, rate_source, created_by)
    values (v_tenant, v_prop, v_bk_ca, current_date + 7, 52000, 'fixture', v_user);
    perform reverse_cancel(v_bk_ca, 'ZZ065 the guest changed their mind back', '4065', 'zz065-rca');
    select f.id into v_e from folios f where f.booking_id = v_bk_ca;
    v_folios := v_folios || v_e;
    -- No financial document exists for a cancellation TODAY, so this folio's own
    -- balance is zero and the reconciliation is trivial on its own. It is summed
    -- into assertion 7's identity, which is not trivial — and the day a
    -- cancellation fee lands (10.4) this assertion strengthens by itself instead
    -- of going red for the right behaviour.
    select coalesce(sum(l.debit - l.credit), 0) into v_amt
    from journal_entry_lines l join journal_entries je on je.id = l.journal_entry_id
    where l.role_key = 'guest_ledger'
      and je.source_document_type in ('folio_charge','folio_charge_void',
                                      'folio_payment','folio_payment_void')
      and (je.source_document_id in (select id from folio_charges where folio_id = v_e)
        or je.source_document_id in (select id from folio_payments where folio_id = v_e));
    if v_amt is distinct from folio_balance(v_e) then
      v_fail := v_fail || format(
        '10: after reverse_cancel the guest ledger nets %s over that folio while folio_balance reads %s. ',
        v_amt, folio_balance(v_e));
    end if;

    -- ===================== 7: THE WHOLE-FOLIO IDENTITY ====================
    select coalesce(sum(l.debit - l.credit), 0) into v_amt
    from journal_entry_lines l
    join journal_entries je on je.id = l.journal_entry_id
    where l.role_key = 'guest_ledger'
      and ((je.source_document_type in ('folio_charge','folio_charge_void')
            and je.source_document_id in (select id from folio_charges
                                          where folio_id = any(v_folios)))
        or (je.source_document_type in ('folio_payment','folio_payment_void')
            and je.source_document_id in (select id from folio_payments
                                          where folio_id = any(v_folios)))
        or (je.source_document_type = 'folio_charge_discount'
            and je.source_document_id in (select d.id from folio_charge_discounts d
                                          join folio_charges c on c.id = d.folio_charge_id
                                          where c.folio_id = any(v_folios))));
    select coalesce(sum(folio_balance(f.id)), 0) into v_bal
    from folios f where f.id = any(v_folios);
    if v_amt is distinct from v_bal then
      v_fail := v_fail || format(
        '7: over the %s folios this fixture touched, the guest ledger nets %s while the folio balances sum to %s. Every document here has had its day, so this is an EQUALITY — no bucket arithmetic is involved, which is what makes a red run unambiguous. ',
        array_length(v_folios, 1), v_amt, v_bal);
    end if;
    if v_bal = 0 then
      v_fail := v_fail ||
        '7: the fixture''s folios balance to zero, so this is comparing zero to zero and any symmetric defect satisfies it. The live unreversed charge exists to stop that. ';
    end if;

    -- AND THE FIXTURE IS CLEAN: nothing on these folios is waiting or never.
    select count(*)::integer into v_bad
    from (
      select folio_posting_state('folio_charge', fc.id) st
      from folio_charges fc where fc.folio_id = any(v_folios)
      union all
      select folio_posting_state('folio_payment', fp.id)
      from folio_payments fp where fp.folio_id = any(v_folios)
      union all
      select folio_posting_state('folio_charge_discount', d.id)
      from folio_charge_discounts d
      join folio_charges c on c.id = d.folio_charge_id
      where c.folio_id = any(v_folios)
    ) s
    where s.st like 'waiting%' or s.st like 'never%';
    if v_bad > 0 then
      select string_agg(distinct s.st, ', ') into v_err
      from (
        select folio_posting_state('folio_charge', fc.id) st
        from folio_charges fc where fc.folio_id = any(v_folios)
        union all
        select folio_posting_state('folio_payment', fp.id)
        from folio_payments fp where fp.folio_id = any(v_folios)
        union all
        select folio_posting_state('folio_charge_discount', d.id)
        from folio_charge_discounts d
        join folio_charges c on c.id = d.folio_charge_id
        where c.folio_id = any(v_folios)
      ) s
      where s.st like 'waiting%' or s.st like 'never%';
      v_fail := v_fail || format(
        '7: %s document(s) on these folios are not posted (%s). THIS FIXTURE MUST STAY CLEAN OF DECLINED DOCUMENTS — the bucket identity belongs to item 8, and mixing it in makes a red run ambiguous between a wrong reversal path and wrong bucket arithmetic. ',
        v_bad, v_err);
    end if;

    -- ===================== 8: THE CLASSIFIER, WHOLE HISTORY ===============
    -- Everything on these folios is posted EXCEPT what was never supposed to
    -- post, and the only such documents here are the two voids whose charge or
    -- payment was itself posted first (those voids ARE posted) — so the answer
    -- is uniform. The exception worth naming is the VOID of a document: it is
    -- its own type, and its state is read as that type.
    select count(*)::integer into v_bad
    from folio_charges fc
    where fc.folio_id = any(v_folios)
      and folio_posting_state('folio_charge', fc.id) <> 'posted';
    if v_bad > 0 then
      v_fail := v_fail || format('8: %s charge(s) on these folios do not read posted. ', v_bad);
    end if;
    select count(*)::integer into v_bad
    from folio_charges fc
    where fc.folio_id = any(v_folios) and fc.is_voided is true
      and folio_posting_state('folio_charge_void', fc.id) <> 'posted';
    if v_bad > 0 then
      v_fail := v_fail || format(
        '8: %s voided charge(s) have a void that does not read posted, although the charge itself was in the books. ', v_bad);
    end if;
    select count(*)::integer into v_n
    from folio_charges fc where fc.folio_id = any(v_folios) and fc.is_voided is true;
    if v_n = 0 then
      v_fail := v_fail || '8: no voided charge on these folios, so the void half of this assertion is vacuous. ';
    end if;

    -- ===================== 11: A COUNTER IS TERMINAL ======================
    -- 064 argued the classifier's recursion terminates because
    -- reversal_of_charge_id points at an older row. True, but this is the
    -- stronger reason: the chain is at most TWO deep because the database
    -- refuses a third. The argument now has a test.
    select * into v_ctr from folio_charges
    where reversal_of_charge_id = v_a.id order by created_at desc limit 1;
    v_ok := false; v_err := null; v_state := null;
    begin
      perform reverse_charge(v_ctr.id, 'ZZ065 reversing a counter', '4065', 'zz065-rc-ctr');
      v_ok := true;
    exception when others then v_err := sqlerrm; v_state := sqlstate; end;
    if v_ok or v_err not like '%itself a reversal and cannot be reversed%' then
      v_fail := v_fail || format(
        '11: reversing a counter was answered by %s / %s. The chain must be at most two deep by CONSTRAINT, which is what makes 064''s recursion safe by construction rather than by argument. ',
        coalesce(v_state, 'a written counter'), coalesce(v_err, '(no error)'));
    end if;
    v_ok := false; v_err := null; v_state := null;
    begin
      perform void_charge(v_ctr.id, 'ZZ065 voiding a counter', 'zz065-vc-ctr');
      v_ok := true;
    exception when others then v_err := sqlerrm; v_state := sqlstate; end;
    if v_ok or v_err not like '%is a reversal and cannot be voided%' then
      v_fail := v_fail || format(
        '11: voiding a counter was answered by %s / %s. ',
        coalesce(v_state, 'a set flag'), coalesce(v_err, '(no error)'));
    end if;

    -- ===================== 13: EVERY COUNTER KNOWS WHAT IT UNWINDS ========
    -- The defect SECTION 2 fixes, asserted for all three kinds at once. A
    -- charge counter's link is set IN post_charge_reversal's INSERT, so it was
    -- always right; a payment counter's was set AFTER record_payment posted, so
    -- from 063 it was silently NULL; a void's is looked up from the document's
    -- own entry. All three must carry it.
    select count(*)::integer into v_bad
    from journal_entries je
    where je.reverses_entry_id is null
      and ((je.source_document_type = 'folio_charge'
            and je.source_document_id in (select id from folio_charges
                                          where folio_id = any(v_folios)
                                            and reversal_of_charge_id is not null))
        or (je.source_document_type = 'folio_payment'
            and je.source_document_id in (select id from folio_payments
                                          where folio_id = any(v_folios)
                                            and reversal_of_payment_id is not null))
        or (je.source_document_type in ('folio_charge_void','folio_payment_void')));
    if v_bad > 0 then
      select string_agg(distinct je.source_document_type, ', ') into v_err
      from journal_entries je
      where je.reverses_entry_id is null
        and ((je.source_document_type = 'folio_charge'
              and je.source_document_id in (select id from folio_charges
                                            where folio_id = any(v_folios)
                                              and reversal_of_charge_id is not null))
          or (je.source_document_type = 'folio_payment'
              and je.source_document_id in (select id from folio_payments
                                            where folio_id = any(v_folios)
                                              and reversal_of_payment_id is not null))
          or (je.source_document_type in ('folio_charge_void','folio_payment_void')));
      v_fail := v_fail || format(
        '13: %s counter-entr(ies) carry no link to the entry they unwind (%s). Every amount can be right and the audit pointer still be gone, which is exactly what 063 shipped for payment reversals. ',
        v_bad, v_err);
    end if;
    -- and all three kinds are present, so none of the three is vacuous
    select count(distinct je.source_document_type)::integer into v_n
    from journal_entries je
    where je.reverses_entry_id is not null and je.source_document_type like 'folio%';
    if v_n < 3 then
      v_fail := v_fail || format(
        '13: only %s kind(s) of linked counter-entry exist in this fixture, expected 3 (a charge counter, a payment counter and a void). ', v_n);
    end if;

    -- ===================== 12: NO SHORT ENTRIES, NO ROUNDING ==============
    select count(*)::integer into v_bad
    from (
      select l.journal_entry_id from journal_entry_lines l
      join journal_entries je on je.id = l.journal_entry_id
      where je.source_document_type like 'folio%'
      group by l.journal_entry_id having count(*) < 2
    ) s;
    if v_bad > 0 then
      v_fail := v_fail || format('12: %s folio entr(ies) have fewer than two lines. ', v_bad);
    end if;
    select count(*)::integer into v_bad
    from journal_entry_lines l join journal_entries je on je.id = l.journal_entry_id
    where l.role_key = 'rounding_difference' and je.source_document_type like 'folio%';
    if v_bad > 0 then
      v_fail := v_fail || format(
        '12: %s rounding_difference line(s) in folio entries. Every counter and every void mirrors what was posted, so none can need one. ', v_bad);
    end if;

    -- ===================== 14: THE GRANTS SURVIVED THE DROP ===============
    -- record_payment had to be DROPPED to change its argument list, and a drop
    -- takes the function's ACL with it. Nothing else in this file would notice:
    -- the fixture runs as the owner, for whom every grant is irrelevant. 062
    -- learned this on post_charge; the same two lines are needed here.
    select count(*)::integer into v_n
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'record_payment';
    if v_n <> 1 then
      v_fail := v_fail || format(
        '14: there are %s record_payment functions, expected exactly 1. Changing an argument list with create or replace leaves an OVERLOAD, and two of them resolve by argument count with nothing to say which a caller meant. ',
        v_n);
    end if;
    select count(*)::integer into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'record_payment'
      and (not has_function_privilege('authenticated', p.oid, 'EXECUTE')
           or has_function_privilege('anon', p.oid, 'EXECUTE'));
    if v_bad > 0 then
      v_fail := v_fail ||
        '14: record_payment is not executable by authenticated, or IS executable by anon. 021''s three grant lines have to be re-emitted after the drop; without them Supabase''s default privileges decide, and the front desk either cannot take a payment or anon can. ';
    end if;
    -- and its SECURITY DEFINER / pinned search_path survived too
    select count(*)::integer into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('record_payment','reverse_payment')
      and (not p.prosecdef
           or p.proconfig is null
           or not exists (select 1 from unnest(p.proconfig) cfg where cfg like 'search_path=public%'));
    if v_bad > 0 then
      v_fail := v_fail || format(
        '14: %s of record_payment / reverse_payment lost SECURITY DEFINER or its pinned search_path. ', v_bad);
    end if;

    if v_fail <> '' then
      raise exception '065 SELF-VERIFY FAILED — %', v_fail;
    end if;

    raise notice '065 SELF-VERIFY: 14 assertions passed over % folios, balance %.',
      array_length(v_folios, 1), v_bal;
    raise exception 'ZZ_065_FIXTURE_DONE';
  exception
    when others then
      if sqlerrm = 'ZZ_065_FIXTURE_DONE' then
        raise notice '065 self-verify complete; fixture rolled back.';
      else
        raise;
      end if;
  end;
end $$;
