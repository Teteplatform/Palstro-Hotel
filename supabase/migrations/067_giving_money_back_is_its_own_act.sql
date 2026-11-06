-- ============================================================================
-- 067  GIVING MONEY BACK IS ITS OWN ACT
-- ============================================================================
-- 1.1h4 item 9. The tracker line said "deposits and refunds post as what they
-- are, a liability taken and released." Reading it properly turned it into two
-- different things: one already decided against in writing, and one live defect
-- nobody had looked for.
--
-- ----------------------------------------------------------------------------
-- THE DEFECT, MEASURED BEFORE IT WAS DESCRIBED
-- ----------------------------------------------------------------------------
-- A refund is a NEGATIVE payment (021 §6 made folio_payments signed on purpose,
-- and that decision is untouched here). record_payment refused only a ZERO
-- amount, so a negative one was ordinary business. Run as an ordinary member of
-- the tenant, in a transaction that rolled back:
--
--     record_payment(folio, -50000, 'cash', ...)   ACCEPTED
--       cash          Cr 50,000.00
--       guest_ledger  Dr 50,000.00
--       folio balance back to 0.00; 50,000 of cash has left the till
--
--     the SAME movement reached by reverse_payment instead:
--       REFUSED, 42501 — "Reversing a payment always requires a valid manager PIN"
--
-- ONE ACT, TWO ROUTES, OPPOSITE CONTROLS. And TakePaymentForm's own help text
-- read "Enter a negative amount to record a refund", so the desk was being
-- instructed to use the unguarded one.
--
-- Set against the rest of the folio, a refund sat below every bar in the
-- module — including the one a VOID clears:
--
--     apply_charge_discount, reverse_charge, reverse_discount,
--     reverse_payment ............................. reason + manager PIN
--     void_charge, void_payment ................... reason
--     record_payment, including a refund .......... NEITHER
--
-- while being the only one of those where cash physically leaves the building.
-- 031's sentence for the reversal PIN is "no threshold, because erasing
-- recorded money is never routine"; this is the same money, going further.
--
-- ----------------------------------------------------------------------------
-- WHAT THIS FILE DOES
-- ----------------------------------------------------------------------------
--   SECTION 1  folio_payments gains refund_reason and approved_by, and TWO
--              CHECK CONSTRAINTS: every money-out row is either a reversal
--              counter or an approved refund, and a payment IN carries neither
--   SECTION 2  record_payment does ONE DIRECTION and refuses the other BY NAME
--              (PT405), with p_allow_negative for its two entitled callers
--   SECTION 3  reverse_payment passes that flag — the regression this shipment
--              could otherwise cause
--   SECTION 4  record_refund: reason, manager PIN and a CEILING, all mandatory
--              by signature
--   SECTION 5  the self-verify: 15 assertions, rolled back
--
-- THE NAME IS record_refund AND NOT refund_payment. "refund_payment" reads as
-- "refund a payment", and it does not: it takes a FOLIO and gives money back to
-- a guest, with no payment row as its target. A name that implies an argument
-- the function does not have is one that gets called wrongly by somebody who
-- never read it. record_refund sits beside record_payment and the pair reads as
-- the two directions money moves at a desk.
--
-- ----------------------------------------------------------------------------
-- THE CEILING, WHICH IS THE PART THAT IS NOT MERELY AN APPROVAL
-- ----------------------------------------------------------------------------
-- A refund cannot exceed what that folio has actually received. Paying out more
-- than was taken in is not a refund — it is money leaving the building against
-- no receipt, and it belongs in petty cash (4.3), where it would have a
-- different approval and a different account. So the refusal NAMES which it is,
-- with both figures, rather than saying no:
--
--     A refund of 50000.01 is more than the 50000.00 this folio has received
--     hint: ... Paying out more than that is a petty cash payment, not a
--           refund — it needs its own approval and its own account.
--
-- The figure is READ from folio_totals.payments_total, never recomputed: it is
-- the NET of every non-voided payment, so the ceiling falls as refunds are
-- taken and a fully-refunded folio refuses the next one at zero. A second
-- expression here would be a second answer to "what has this guest paid us",
-- and the screen and the guard would eventually disagree about whether a refund
-- fits. SECTION 5's assertion 14 is built on exactly that difference — the sum
-- of payments IN and the NET are the same number until the first refund lands.
--
-- ----------------------------------------------------------------------------
-- THE DEPOSIT HALF: NOTHING TO BUILD, AND 044 SAYS SO IN ITS OWN WORDS
-- ----------------------------------------------------------------------------
-- Strictly, money held for a stay that has not begun is a LIABILITY rather than
-- negative accounts-receivable, and the tracker line promised that treatment.
-- It is not what the product does, and that is a recorded decision rather than
-- an oversight. seed_account_mappings (044 §7.2) carries it:
--
--     THERE IS NO guest_deposits KEY, AND THAT IS A DECISION RATHER THAN AN
--     OVERSIGHT. ... A KNOWN SIMPLIFICATION, recorded here so whoever revisits
--     it knows it was weighed and not missed. It becomes worth doing the day
--     somebody needs deposits held separately on a balance sheet, which is
--     stage 11 at the earliest.
--
-- So this file leaves it exactly alone, and the TRACKER LINE IS CORRECTED
-- instead: a source of truth promising a treatment the product deliberately
-- does not have is worse than a gap, because the gap is at least visible. The
-- liability split goes where 044 put it.
--
-- That comment is also the model for how a deferral gets written here: it names
-- its own EXPIRY CONDITION. A deferral with no trigger is a thing nobody ever
-- revisits.
--
-- Measured, since it is half of what item 9 claimed: a 50,000 deposit on a
-- folio with no charges posts cash Dr 50,000 / guest_ledger Cr 50,000, leaves
-- the folio balance at -50,000, and 066 reconciles it at exactly zero.
-- Assertion 15 is that, so the half nothing was built for is still proven.
--
-- ----------------------------------------------------------------------------
-- WHAT THIS FILE DELIBERATELY DOES NOT DO
-- ----------------------------------------------------------------------------
--   * IT DOES NOT GIVE void_payment A PIN, and that is deliberate rather than
--     an oversight found late. Voiding a received payment also erases recorded
--     money, and it takes a reason but no approval — 021 §9.5 reasons it
--     explicitly ("a serious act and is fully logged: the row survives, and
--     change_log records who voided it"), and 064 now posts its counter-entry
--     as well. A different control, deliberately chosen. If it needs
--     revisiting it gets its own conversation rather than a ride on this one.
--   * It does not make 'other' a refundable method or change the method
--     whitelist. A refund resolves its account exactly as a payment does.
--   * It does not touch the signed-amount decision (021 §6) or add a refunds
--     table. A refund is a folio_payments row, as it always was.
--
-- ----------------------------------------------------------------------------
-- THE SCREEN, IN THE SAME PUSH
-- ----------------------------------------------------------------------------
-- TakePaymentForm's help text invited the act this file now refuses, so it
-- cannot survive the guard by even one commit: a screen instructing the desk to
-- do what the database has just started refusing is the same defect as a hint
-- naming the wrong remedy, pointing the other way. The line goes in this push.
-- The full refund form, and the folio's FIRST RENDER PROOF, land in item 10 —
-- named here rather than implied, because rule 22 is owed a proof and this
-- commit does not carry one.
--
-- ----------------------------------------------------------------------------
-- LINEAGE
-- ----------------------------------------------------------------------------
--   021  folio_payments, signed amounts, verify_manager_pin, void_payment's
--        reason-but-no-PIN reasoning
--   031  reverse_payment: a manager PIN always, no threshold; and the reversals
--        row that holds its own reason and approver
--   044  §7.2's recorded decision on guest_deposits, quoted above
--   052  refuse at the moment of the decision, not of the consequence
--   062  p_allow_future — the escape-flag pattern p_allow_negative follows
--   063  record_payment refuses a future date; payments post
--   065  record_payment's p_post_journal, and the drop-and-recreate with its
--        grants re-emitted and asserted
--   066  folio_gl_reconciliation_folios, which assertions 13 and 11 now simply
--        ask whether the folio still reconciles
-- ============================================================================

-- ############################################################################
-- SECTION 1 — A REFUND CARRIES ITS REASON AND ITS APPROVER
-- ############################################################################
-- Two columns, both NULL on an ordinary payment, and two table-level guards
-- that make the pairing a property of the TABLE rather than of one function.
--
-- WHY A TABLE GUARD AT ALL, stated accurately because the first draft of this
-- comment stated it wrongly. It claimed folio_payments "has an insert policy
-- for staff", which it does NOT: the table carries exactly one policy,
-- folio_payments_member_select, and nothing else. Every write goes through a
-- SECURITY DEFINER RPC, so there is no client path for a guard here to block
-- today — and the claim was checked only because rule 29 says to read the thing
-- you are about to rely on.
--
-- It is kept anyway, and the reason is the NEXT writer rather than this one.
-- Rule 3's sentence, one table over: the constraint is the floor and the
-- sentence is the interface. record_refund is where the refusal is worded,
-- because that is where somebody reads it; the table is what still refuses the
-- day an insert policy appears, or a new RPC writes a negative payment without
-- knowing what a negative payment owes. SECTION 5 asserts both guards by
-- writing rows past every function in this file.
alter table folio_payments
  add column if not exists refund_reason text,
  add column if not exists approved_by   uuid references auth.users(id);

comment on column folio_payments.refund_reason is
  'WHY money went back to the guest. Mandatory on a refund, NULL on a payment '
  'and NULL on a reversal counter — a reversal''s reason lives on the reversals '
  'row (031), which is its own record with its own approver, so copying it here '
  'would be a second place to read it from and a second place for it to drift.';

comment on column folio_payments.approved_by is
  'The MANAGER whose PIN authorised a refund, resolved by verify_manager_pin — '
  'never taken from the client and never the same column as created_by, which '
  'stays the non-forgeable record of who stood at the terminal. The pair is the '
  'whole point: the customer''s primary pain is staff theft, so a payout has to '
  'answer "who keyed it" and "who allowed it" SEPARATELY. Equal to created_by '
  'only when a manager served the guest themselves.';

-- ----------------------------------------------------------------------------
-- 1.1 A PAYMENT IN NEVER CARRIES REFUND FIELDS — a plain CHECK
-- ----------------------------------------------------------------------------
-- Without this the columns become a place to put a note on an ordinary payment,
-- and then "every row with a refund_reason is a refund" stops being true —
-- exactly the kind of thing a later report relies on without checking.
alter table folio_payments
  drop constraint if exists folio_payments_refund_fields_only_out_check;
alter table folio_payments
  add constraint folio_payments_refund_fields_only_out_check
  check (
    amount < 0
    or (refund_reason is null and approved_by is null)
  );

-- ----------------------------------------------------------------------------
-- 1.2 EVERY MONEY-OUT ROW IS EXPLAINED — a DEFERRED constraint trigger
-- ----------------------------------------------------------------------------
-- Three ways a folio_payments row can be negative, and all three are covered:
--   * a reversal counter      -> reversal_of_payment_id is set (031), and
--                                reverse_payment already took a manager PIN;
--   * an approved refund      -> refund_reason and approved_by are both set;
--   * anything else           -> refused.
--
-- A TRIGGER RATHER THAN A CHECK, AND THE REASON IS NOT STYLE. This was written
-- as a CHECK first and the dry run refused 067's own refund path: record_refund
-- writes the row THROUGH record_payment and sets the reason and the approver in
-- the next statement, so at the moment of the INSERT the row is legitimately
-- incomplete. A CHECK fires per statement and CANNOT be deferred — only UNIQUE,
-- FOREIGN KEY and EXCLUDE constraints can — so a CHECK here means one of three
-- things, all worse:
--
--   * record_refund inserts the row itself, duplicating the method whitelist,
--     the folio-status rule, the business date, the idempotency handling and
--     the posting call — five places a refund could drift from a payment;
--   * record_payment takes the reason and the approver as parameters, which
--     puts approved_by in a CLIENT'S hands: a PostgREST caller could then write
--     an "approved" refund naming any manager, with no PIN. Strictly worse than
--     having no column at all;
--   * no table guard, and the whole rule lives in one function's branch.
--
-- A DEFERRABLE INITIALLY DEFERRED constraint trigger fires at COMMIT, so the
-- row may be incomplete between two statements of one transaction and must be
-- explained by the end of it. A direct insert commits immediately, so it is
-- refused exactly as a CHECK would have refused it.
--
-- ITS ERRCODE IS DISTINCT FROM THE CEILING'S ON PURPOSE (PT406, not PT402).
-- The two refusals mean different things to whoever meets them — the ceiling is
-- "this folio has not got that much in it", this is "this row is unaccountable"
-- — and rule 27's sixth shape is that an assertion matching a shared code
-- cannot tell which layer spoke.
-- IT RE-READS THE ROW INSTEAD OF TRUSTING `new`, AND THAT IS NOT DEFENSIVE
-- CODING — IT IS THE WHOLE POINT. A deferred AFTER trigger is handed the tuple
-- AS IT WAS AT THE TRIGGERING STATEMENT, not as it stands at commit. Written
-- against `new`, this fired at the end of the transaction holding the row
-- record_payment had inserted, before record_refund's next statement set the
-- reason and the approver — and refused 067's own legitimate refund. The dry
-- run caught it, in the direction that matters: the guard was wrong in the way
-- that stops real work rather than the way that lets money out.
--
-- Re-reading by id makes it an END-STATE check, which is what "deferred" was
-- asked for in the first place. `not found` is a row written and then rolled
-- back inside the same transaction, which is what the self-verify does; there
-- is nothing to check and nothing wrong.
create or replace function enforce_money_out_explained()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_row folio_payments;
begin
  select * into v_row from folio_payments where id = new.id;
  if not found then
    return null;
  end if;

  if v_row.amount < 0
     and v_row.reversal_of_payment_id is null
     and (btrim(coalesce(v_row.refund_reason, '')) = '' or v_row.approved_by is null) then
    raise exception
      'Payment % takes % out of this folio and is neither a reversal nor an approved refund',
      v_row.id, v_row.amount
      using errcode = 'PT406',
            hint = 'Money leaving a folio is written by reverse_payment, which links the payment it unwinds, or by record_refund, which records the reason and the manager who approved it. A negative payment with neither is money nobody can account for.';
  end if;
  return null;
end;
$$;

comment on function enforce_money_out_explained() is
  'Constraint trigger: every NEGATIVE folio_payments row is either a reversal '
  'counter or an approved refund, checked AT COMMIT. Deferred because '
  'record_refund writes the row through record_payment and sets the reason and '
  'the approver in the next statement, and a CHECK constraint cannot be '
  'deferred. It RE-READS the row rather than trusting the trigger''s NEW, '
  'because a deferred AFTER trigger is handed the tuple as it was at the '
  'triggering statement and a refund is completed by the statement after its '
  'insert — written the other way it refused 067''s own refunds. Raises PT406, '
  'deliberately distinct from the ceiling''s PT402.';

-- REVOKED, BECAUSE A NEW FUNCTION IN THIS PROJECT IS NOT PRIVATE. Supabase's
-- default privileges (pg_default_acl, set by supabase_admin) grant EXECUTE on
-- every newly created function to anon, authenticated AND service_role — so a
-- `grant ... to authenticated` line is belt-and-braces and the REVOKE is what
-- closes anything. Measured: a brand-new function with no grant line reads
-- executable by all three. Harmless here, since calling a trigger function
-- directly fails, but "harmless" is not a reason to leave it reachable.
revoke all on function enforce_money_out_explained() from public;
revoke all on function enforce_money_out_explained() from anon;
revoke all on function enforce_money_out_explained() from authenticated;

drop trigger if exists folio_payments_money_out_explained on folio_payments;
create constraint trigger folio_payments_money_out_explained
  after insert or update on folio_payments
  deferrable initially deferred
  for each row execute function enforce_money_out_explained();

-- ############################################################################
-- SECTION 2 — record_payment DOES ONE DIRECTION
-- ############################################################################
-- Re-emitted from 065's text with ONE new parameter and ONE new guard, and
-- EXTRACTED rather than retyped: 051's first draft rewrote a function from
-- memory and lost SECURITY DEFINER and its is_tenant_staff gate without any
-- assertion noticing. Everything between the signature and the guard below is
-- byte-for-byte 065.
--
-- THE SIGNATURE CHANGES, SO THE OLD ONE IS DROPPED. Postgres resolves overloads
-- by argument count, so leaving the seven-argument form in place would give two
-- record_payments -- and the one a six-argument PostgREST call reached would be
-- the UNGUARDED one. 065 made the same drop for the same reason and its
-- assertion 14 is why the grants are re-emitted below; SECTION 5 asserts the
-- end state rather than trusting these three lines.
drop function if exists record_payment(uuid, numeric, text, text, date, text, boolean);

CREATE OR REPLACE FUNCTION public.record_payment(p_folio_id uuid, p_amount numeric, p_method text, p_reference text, p_payment_date date, p_idempotency_key text, p_post_journal boolean DEFAULT true, p_allow_negative boolean DEFAULT false)
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

  -- 067: A NEGATIVE AMOUNT IS NOT AN ORDINARY PAYMENT, AND THIS WAS THE DOOR IT
  -- CAME THROUGH. Measured before the guard, as an ordinary member of the
  -- tenant: record_payment(folio, -50000, 'cash', ...) was ACCEPTED. It credited
  -- cash 50,000.00 and debited the guest ledger 50,000.00 -- fifty thousand
  -- naira of cash out of the till with no approval, no reason, and nothing on
  -- the row to read it against. The SAME movement reached by reverse_payment is
  -- refused: "Reversing a payment always requires a valid manager PIN".
  --
  -- One act, two routes, opposite controls. And the screen's own help text read
  -- "Enter a negative amount to record a refund", so the desk was being
  -- instructed to use the unguarded one. On a product whose primary pain is
  -- staff theft, a refund sat below the bar a VOID clears: a void demands a
  -- reason (021 S9.5), a reversal demands a reason and a PIN (031 S3.2), and a
  -- refund demanded neither -- while being the only one of the three where cash
  -- physically leaves the building.
  --
  -- SO THIS FUNCTION DOES ONE DIRECTION AND REFUSES THE OTHER BY NAME, which is
  -- 052's ruling and 062's: refuse at the moment of the decision, not at the
  -- moment of the consequence.
  --
  -- p_allow_negative is 062's p_allow_future pattern -- an escape that exactly
  -- two entitled callers pass and nothing else does, both of them in this file:
  --   * reverse_payment, writing the counter of a payment (031/065), and
  --   * record_refund, which demands the PIN, the reason and the ceiling FIRST.
  -- Like every other p_allow_* flag it is reachable through PostgREST, which is
  -- why it goes on 1.3's list as the SEVENTH. That is worth being exact about:
  -- the flag is a convenience for internal callers and is NEVER the control.
  -- The control is that record_refund exists, that it is what the screen
  -- offers, and that SECTION 1's CONSTRAINT TRIGGER refuses a negative row
  -- which is neither a reversal counter nor an approved refund -- so a
  -- PostgREST caller who passes the flag gets PT406 from the table at commit,
  -- not a quiet payment.
  if p_amount < 0 and not p_allow_negative then
    raise exception
      'A payment cannot be negative, and % is money going out', p_amount
      using errcode = 'PT405',
            hint = 'Giving money back is its own act. Call record_refund with a POSITIVE amount: it needs a reason and a manager PIN, and it cannot exceed what this folio has received.';
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

revoke execute on function record_payment(uuid, numeric, text, text, date, text, boolean, boolean) from public;
revoke execute on function record_payment(uuid, numeric, text, text, date, text, boolean, boolean) from anon;
grant  execute on function record_payment(uuid, numeric, text, text, date, text, boolean, boolean) to authenticated;

-- ############################################################################
-- SECTION 3 — reverse_payment passes the flag
-- ############################################################################
-- Its SIGNATURE DOES NOT CHANGE, so this is a plain create-or-replace and the
-- ACL survives untouched -- no drop, no re-grant, nothing to lose. Extracted
-- from 065 and patched at ONE call site.
--
-- It is in this file because it is the other caller entitled to a negative
-- amount. Left alone, its seven-argument call would take p_allow_negative's
-- default of false and every payment reversal would start refusing at the desk
-- -- the one regression this shipment could cause, and the reason SECTION 5
-- exercises reverse_payment end to end rather than only the new function.
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
  -- 067: NAMED NOTATION, AND THE REASON IS THE SECOND BOOLEAN. record_payment
  -- now ends in two boolean parameters, and two adjacent booleans passed
  -- positionally are one careless reorder away from meaning each other's
  -- thing -- silently, because both are valid. Named notation cannot be
  -- reordered wrongly and says at the call site which is which.
  v_counter := record_payment(
    p_folio_id        => v_payment.folio_id,
    p_amount          => - v_payment.amount,
    p_method          => v_payment.method,
    p_reference       => 'Payment reversal — ' || v_reason,
    p_payment_date    => v_date,
    p_idempotency_key => v_counter_key,
    -- 065: DO NOT POST IT YET. The link below is what the entry needs, and it
    -- is not on the row until the next statement.
    p_post_journal    => false,
    -- 067: AND THIS COUNTER IS ENTITLED TO BE NEGATIVE. It is the other half of
    -- the pair record_payment's new guard names, and it needs no PIN of its own
    -- because GUARD 9 above already took one.
    p_allow_negative  => true
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
-- SECTION 4 — record_refund
-- ############################################################################
-- Giving money back is its own act, so it is its own function, sitting beside
-- record_payment as the two directions money moves at a desk.
--
-- WHY NOT A FLAG ON record_payment, which was the smaller change: the guards
-- would then live in a conditional branch rather than in the signature, and a
-- function whose meaning flips on the sign of an argument is one somebody calls
-- without reading. Here the reason and the PIN are MANDATORY BY SIGNATURE —
-- there is no way to call this function without having both in your hand.
--
-- THE AMOUNT IS POSITIVE, and that is deliberate. The caller says how much to
-- give back; this function writes the negative. Asking a caller for a negative
-- "refund amount" is how a double negative eventually becomes a payment.
--
-- WHAT IT DOES NOT DO: it does not insert. The row is written through
-- record_payment, so the method whitelist, the folio-status rule, the business
-- date, the idempotency handling and the posting call all stay in ONE place and
-- a refund cannot drift from a payment in any of them. This function is the
-- APPROVAL and the CEILING, and nothing else.
--
-- THE ORDER OF THE GUARDS IS LOAD-BEARING, and one of them is counter-intuitive:
-- THE REPLAY LOOKUP COMES BEFORE THE PIN. A retried refund — the terminal lost
-- its reply, the till drawer is already open — returns the first outcome
-- without demanding the manager walk back. 060 and 065 both settled this; it is
-- not a convenience, it is what stops a second payout being the easier path
-- than proving the first one happened.
create or replace function record_refund(
  p_folio_id        uuid,
  -- POSITIVE: the amount to give back.
  p_amount          numeric,
  p_method          text,
  p_reference       text,
  p_reason          text,
  p_manager_pin     text,
  p_idempotency_key text default null
)
returns folio_payments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_folio    folios;
  v_tenant   uuid;
  v_existing folio_payments;
  v_payment  folio_payments;
  v_received numeric(14,2);
  v_manager  uuid;
  v_reason   text;
  v_actor    uuid := auth.uid();
begin
  select * into v_folio from folios where id = p_folio_id;
  if not found then
    raise exception 'Folio % not found', p_folio_id using errcode = 'no_data_found';
  end if;
  v_tenant := v_folio.tenant_id;

  if not is_tenant_staff(v_tenant) then
    raise exception 'Not authorised to refund on this tenant''s folios'
      using errcode = 'insufficient_privilege';
  end if;

  -- --- THE REPLAY, BEFORE THE PIN (see the header) -------------------------
  -- The key is passed straight through to record_payment, so the row carries
  -- THIS key and this lookup finds the same row record_payment's own replay
  -- would. One key, one row, one payout.
  if p_idempotency_key is not null then
    select * into v_existing
    from folio_payments
    where tenant_id = v_tenant and idempotency_key = p_idempotency_key
    limit 1;
    if found then
      return v_existing;
    end if;
  end if;

  v_reason := btrim(coalesce(p_reason, ''));
  if v_reason = '' then
    raise exception 'A refund needs a reason' using errcode = 'check_violation';
  end if;

  -- --- THE AMOUNT IS THE AMOUNT TO GIVE BACK -------------------------------
  if p_amount is null or p_amount <= 0 then
    raise exception
      'A refund amount is how much to give back, so it is positive (% given)', p_amount
      using errcode = 'check_violation',
            hint = 'Enter the amount to hand to the guest. This function writes the negative payment itself.';
  end if;

  -- --- THE CEILING: A REFUND CANNOT EXCEED WHAT CAME IN --------------------
  -- Paying out more than the folio has received is not a refund. It is money
  -- leaving the building against no receipt, and it belongs in petty cash (4.3)
  -- where it would have a different approval and a different account. So the
  -- refusal NAMES which it is, with both figures, rather than saying no.
  --
  -- READ FROM folio_totals, not recomputed. payments_total is the NET of every
  -- non-voided payment on the folio — deposits in, reversal counters out, and
  -- earlier refunds out — so the ceiling falls as refunds are taken and a
  -- fully-refunded folio refuses the next one at zero. A second expression here
  -- would be a second answer to "what has this guest paid us", and the screen
  -- and the guard would eventually disagree about whether a refund fits.
  select t.payments_total into v_received from folio_totals(p_folio_id) t;
  if p_amount > coalesce(v_received, 0) then
    raise exception
      'A refund of % is more than the % this folio has received', p_amount, coalesce(v_received, 0)
      using errcode = 'PT402',
            hint = 'A refund can only return money this folio took in. Paying out more than that is a petty cash payment, not a refund — it needs its own approval and its own account.';
  end if;

  -- --- THE MANAGER PIN. ALWAYS. NO THRESHOLD. ------------------------------
  -- 031's sentence for the reversal applies unchanged and more literally here:
  -- erasing recorded money is never routine, and this is cash leaving the
  -- drawer. verify_manager_pin returns the user_id of the ACTIVE owner/manager
  -- whose PIN matched, or NULL — fail closed. It is revoked from every client
  -- role (021 §12), so this is the only kind of place it can be called from.
  v_manager := verify_manager_pin(v_tenant, p_manager_pin);
  if v_manager is null then
    raise exception 'A refund always requires a valid manager PIN'
      using errcode = 'insufficient_privilege',
            hint = 'Hand the terminal to a manager. The refund is recorded against them by name.';
  end if;

  -- --- THE EFFECT ----------------------------------------------------------
  -- Named notation, for the reason SECTION 3 gives: two adjacent booleans.
  v_payment := record_payment(
    p_folio_id        => p_folio_id,
    p_amount          => - p_amount,
    p_method          => p_method,
    p_reference       => p_reference,
    -- NULL, so record_payment resolves the property-local business date exactly
    -- as it does for a payment. A refund is dated the day the money goes out,
    -- which is the day whose cash-up has to show it short.
    p_payment_date    => null,
    p_idempotency_key => p_idempotency_key,
    p_post_journal    => true,
    p_allow_negative  => true
  );

  -- THE REASON AND THE APPROVER, in a SEPARATE statement after the insert —
  -- which is the shape of the defect 065 found, so it is worth saying why it is
  -- safe HERE. 065's bug was that record_payment POSTED inside the gap, and the
  -- posting helper read a column reverse_payment had not written yet. These two
  -- columns are read by nothing in the posting path: post_folio_payment_journal
  -- takes the amount and the method and nothing else. The entry written a
  -- moment ago is therefore identical whether these columns are set before or
  -- after it, and SECTION 5 asserts that the entry is correct rather than
  -- trusting the paragraph.
  --
  -- If a future helper ever reads either column, this becomes 065's bug again
  -- and the fix is 065's fix: pass p_post_journal => false and post after.
  update folio_payments
     set refund_reason = v_reason,
         approved_by   = v_manager,
         updated_by    = v_actor
   where id = v_payment.id
  returning * into v_payment;

  return v_payment;
end;
$$;

revoke all    on function record_refund(uuid, numeric, text, text, text, text, text) from public;
revoke all    on function record_refund(uuid, numeric, text, text, text, text, text) from anon;
grant  execute on function record_refund(uuid, numeric, text, text, text, text, text) to authenticated;

comment on function record_refund(uuid, numeric, text, text, text, text, text) is
  'Gives money back to a guest: a NEGATIVE folio_payments row, written through '
  'record_payment so nothing about a refund can drift from a payment. Takes a '
  'POSITIVE amount — the amount to hand over — and three controls a payment '
  'does not have, all mandatory by signature rather than by a branch: a REASON, '
  'a MANAGER PIN (always, no threshold — 031''s rule, and this is cash leaving '
  'the drawer), and a CEILING of what the folio has actually received, read '
  'from folio_totals. Over the ceiling it refuses BY NAME with both figures, '
  'because paying out more than came in is a petty cash payment (4.3) and not a '
  'refund. The replay lookup runs BEFORE the PIN so a retry does not fetch the '
  'manager back to the terminal (060, 065). Before 067 this act was reachable '
  'as record_payment with a negative amount, with no approval and no reason, '
  'while the same movement through reverse_payment demanded a PIN.';

-- ############################################################################
-- SECTION 5 — THE SELF-VERIFY, ROLLED BACK
-- ############################################################################
-- Fifteen assertions. The defect each one goes red for is named beside it,
-- because an assertion nobody can name a failure for is decoration (rule 27).
--
--   1  A NEGATIVE AMOUNT THROUGH record_payment IS REFUSED BY NAME, on
--      SQLSTATE PT405 and a message naming money going out. PT405 is new in
--      this file and nothing else raises it — which matters, because three
--      other guards in the same function refuse with check_violation and a
--      pattern loose enough to accept those would be satisfied by this guard's
--      deletion (rule 27's sixth shape).
--   2  AND THE FLAG IS NOT A WAY IN. p_allow_negative gets a caller past the
--      function and no further: the table still refuses a row with no reason
--      and no approver. One act proves both halves. The positive control for
--      the flag is assertions 3 and 11, which write negatives through it
--      legitimately — the first draft of THIS assertion was the control, and
--      it manufactured the exact unaccountable row the shipment prevents.
--   3  A REFUND IS WRITTEN, POSTED, AND CARRIES ITS REASON AND ITS APPROVER —
--      the row negative, refund_reason set, approved_by the MANAGER rather than
--      the keying user, and the entry crediting cash and debiting the guest
--      ledger by the refunded amount.
--   4  THE CEILING REFUSES BY NAME, WITH BOTH FIGURES, and it is asserted ON
--      BOTH SIDES OF THE BOUNDARY: exactly the received amount SUCCEEDS and one
--      kobo more FAILS. A ceiling asserted only from above passes for a rule
--      that refuses everything (rule 27: assert where the two rules disagree).
--   5  THE PIN IS DEMANDED, ALWAYS. Matched on the message naming the PIN, not
--      on the sqlstate alone: is_tenant_staff refuses with the same
--      insufficient_privilege a line earlier.
--   6  A MISSING REASON IS REFUSED.
--   7  A NEGATIVE OR ZERO REFUND AMOUNT IS REFUSED — the double negative that
--      would otherwise be a payment.
--   8  A RETRY RETURNS THE FIRST OUTCOME WITHOUT A PIN. Called again with the
--      same key and a WRONG pin, the first refund comes back. RED if the PIN
--      check ever moves above the replay lookup, which is the change somebody
--      makes while tidying the guard order.
--   9  THE TABLE REFUSES AN UNEXPLAINED MONEY-OUT ROW, by direct insert, past
--      every function in this file. This is the half that makes the RPC's
--      refusal more than advice.
--  10  AND A PAYMENT IN CANNOT CARRY REFUND FIELDS.
--  11  reverse_payment STILL WORKS, END TO END. It is the regression this
--      shipment could cause: left unpatched, its seven-argument call would take
--      p_allow_negative's default and every payment reversal would start
--      refusing at the desk.
--  12  THE GRANTS SURVIVED THE DROP (065's assertion 14, same reason), and
--      verify_manager_pin is still unreachable from a client role.
--  13  THE REFUNDED FOLIO RECONCILES. 066 shipped yesterday and this is the
--      first shipment that can simply ask it: ledger_difference exactly zero on
--      the folio a refund just moved money out of.
--  14  THE CEILING FALLS AS REFUNDS ARE TAKEN. Refund half, and the second
--      refund of the full original amount must refuse. RED for a ceiling read
--      as "the sum of payments IN" instead of the NET — the two are the same
--      number until the first refund lands, which is the fixture's whole job.
--  15  A DEPOSIT STILL POSTS AS IT DID. The other half of item 9: nothing about
--      taking money in has changed, and 044's recorded decision to leave a
--      pre-arrival deposit in the guest ledger rather than a liability account
--      is untouched.
do $$
declare
  v_tenant   uuid;
  v_user     uuid;
  v_prop     uuid;
  v_guest    uuid;
  v_folio    folios;
  v_folio2   folios;
  v_pay      folio_payments;
  v_ref      folio_payments;
  v_ref2     folio_payments;
  v_rev      record;
  v_row      record;
  v_amt      numeric(14,2);
  v_n        integer;
  v_bad      integer;
  v_ok       boolean;
  v_err      text;
  v_state    text;
  v_mgr      uuid;
  v_fail     text := '';
begin
  begin
    select tu.tenant_id, tu.user_id into v_tenant, v_user
    from tenant_users tu where tu.is_active and tu.role in ('owner','manager') limit 1;
    select p.id into v_prop from properties p where p.tenant_id = v_tenant limit 1;
    if v_tenant is null or v_prop is null then
      raise notice '067 SELF-VERIFY SKIPPED: no tenant or active owner/manager.';
      raise exception 'ZZ_067_FIXTURE_DONE';
    end if;
    perform set_config('request.jwt.claims',
      json_build_object('role','service_role','sub', v_user::text)::text, true);

    -- THIS OVERWRITES A REAL MANAGER'S PIN, and it is only safe because the
    -- ZZ_067_FIXTURE_DONE sentinel below guarantees this block rolls back — the
    -- raise is unconditional, so no path commits it. Anyone copying this
    -- pattern into something that COMMITS must use a throwaway user instead.
    -- A SECOND MANAGER, AND THE REASON IS ASSERTION 3. This tenant has exactly
    -- ONE auth user, so "the approving manager" and "the person at the terminal"
    -- are the same uuid — and an assertion that approved_by is the manager
    -- cannot tell that from approved_by being the keying user. Both answers are
    -- the same number (rule 27's fourth shape), which the breakage run proved
    -- by changing the column to v_actor and staying GREEN.
    --
    -- So the PIN belongs to somebody ELSE. The session stays the owner; the
    -- approval comes from this second member; and approved_by must be the
    -- second one. That distinction is the entire theft control — "who keyed it"
    -- and "who allowed it" are different questions — so it is worth a row in a
    -- fixture that rolls back.
    insert into auth.users (id, instance_id, aud, role, email)
    values (gen_random_uuid(), '00000000-0000-0000-0000-000000000000',
            'authenticated', 'authenticated', 'zz067-approver@example.invalid')
    returning id into v_mgr;
    insert into tenant_users (tenant_id, user_id, role, is_active)
    values (v_tenant, v_mgr, 'manager', true);
    insert into manager_pins (tenant_id, user_id, pin_hash)
    values (v_tenant, v_mgr, crypt('4067', gen_salt('bf')));

    -- and the real owner gets a DIFFERENT pin, so a mix-up cannot pass either.
    -- THIS OVERWRITES A REAL MANAGER'S PIN, and it is only safe because the
    -- ZZ_067_FIXTURE_DONE sentinel below guarantees this block rolls back.
    insert into manager_pins (tenant_id, user_id, pin_hash)
    values (v_tenant, v_user, crypt('9999', gen_salt('bf')))
    on conflict (tenant_id, user_id) do update set pin_hash = excluded.pin_hash;

    insert into guests (tenant_id, first_name, last_name, created_by)
    values (v_tenant, 'ZZ067', 'Refund', v_user) returning id into v_guest;
    v_folio := open_guest_folio(v_tenant, v_prop, v_guest, 'zz067-folio-1');

    -- ===================== 15: A DEPOSIT STILL POSTS ======================
    v_pay := record_payment(v_folio.id, 50000, 'cash', 'ZZ067-DEP',
                            current_date, 'zz067-dep');
    select coalesce(sum(l.debit - l.credit), 0) into v_amt
    from journal_entry_lines l join journal_entries je on je.id = l.journal_entry_id
    where je.source_document_type = 'folio_payment' and je.source_document_id = v_pay.id
      and l.role_key = 'guest_ledger';
    if v_amt is distinct from -50000 then
      v_fail := v_fail || format(
        '15: a 50,000 deposit moved the guest ledger by %s, expected -50000 (a credit: the hotel holds their money). Nothing about taking money in was meant to change. ', v_amt);
    end if;
    select t.payments_total into v_amt from folio_totals(v_folio.id) t;
    if v_amt is distinct from 50000 then
      v_fail := v_fail || format('15: payments_total reads %s after one 50,000 deposit. ', v_amt);
    end if;

    -- ===================== 1: A NEGATIVE PAYMENT IS REFUSED ===============
    v_ok := false; v_err := null; v_state := null;
    begin
      perform record_payment(v_folio.id, -1000, 'cash', 'ZZ067-NEG',
                             current_date, 'zz067-neg');
      v_ok := true;
    exception when others then v_err := sqlerrm; v_state := sqlstate; end;
    if v_ok or v_state is distinct from 'PT405'
       or v_err not like '%money going out%' then
      v_fail := v_fail || format(
        '1: a NEGATIVE payment was answered by %s / %s rather than refused. This is the hole 067 exists to close: measured before the guard, -50,000 cash went out of the till with no approval and no reason. ',
        coalesce(v_state, 'a written row'), coalesce(left(v_err, 140), '(no error)'));
    end if;

    -- ===================== 2: THE FLAG IS NOT A WAY IN ====================
    -- The first version of this assertion simply called record_payment with
    -- p_allow_negative => true and checked it succeeded, as a positive control
    -- for assertion 1. It DID succeed — and it left a -1.00 row on the folio
    -- with no reason and no approver, which then broke assertion 14's ceiling
    -- arithmetic and was correctly refused by SECTION 1's trigger in 9a. The
    -- fixture had manufactured the exact state the shipment exists to prevent.
    --
    -- Which turns out to be the better assertion. THE FLAG GETS YOU PAST THE
    -- FUNCTION AND NO FURTHER: the table still demands the row be explained, so
    -- a PostgREST caller who discovers p_allow_negative cannot write money out
    -- with it. Both halves are proven here in one act — the function let it
    -- through, and the table refused at commit.
    --
    -- The positive control for the flag is therefore assertions 3 and 11:
    -- record_refund and reverse_payment both write a negative payment through
    -- record_payment, and both go RED if the flag stops working. A control that
    -- writes an illegal row is not a control.
    --
    -- The insert rolls back with this block's implicit subtransaction, so
    -- nothing is left behind for the later assertions to trip over.
    v_ok := false; v_err := null; v_state := null;
    begin
      perform record_payment(p_folio_id => v_folio.id, p_amount => -1,
                             p_method => 'cash', p_reference => 'ZZ067-FLAG',
                             p_payment_date => current_date,
                             p_idempotency_key => 'zz067-flag',
                             p_allow_negative => true);
      execute 'set constraints folio_payments_money_out_explained immediate';
      v_ok := true;
    exception when others then v_err := sqlerrm; v_state := sqlstate; end;
    if v_ok or v_state is distinct from 'PT406' then
      v_fail := v_fail || format(
        '2: a bare p_allow_negative wrote an unexplained money-out row and the table allowed it (%s / %s). The flag is a convenience for two internal callers, never a control — if it is also a way in, the guard in assertion 1 is cosmetic. ',
        coalesce(v_state, 'no error'), coalesce(left(v_err, 140), ''));
    end if;
    if v_err is not null and v_err like '%money going out%' then
      v_fail := v_fail || '2: and it was record_payment that refused, not the table — so the flag was ignored and assertion 1 cannot tell the guard from a function that refuses every negative. ';
    end if;

    -- ===================== 6, 7: REASON AND AMOUNT ========================
    v_ok := false; v_err := null; v_state := null;
    begin
      perform record_refund(v_folio.id, 1000, 'cash', null, '   ', '4067', 'zz067-noreason');
      v_ok := true;
    exception when others then v_err := sqlerrm; v_state := sqlstate; end;
    if v_ok or v_err not like '%A refund needs a reason%' then
      v_fail := v_fail || format('6: a refund with a blank reason was answered by %s. ',
        coalesce(left(v_err, 120), 'a written row'));
    end if;

    v_ok := false; v_err := null;
    begin
      perform record_refund(v_folio.id, -1000, 'cash', null, 'ZZ067 negative ask', '4067', 'zz067-negask');
      v_ok := true;
    exception when others then v_err := sqlerrm; end;
    if v_ok or v_err not like '%how much to give back%' then
      v_fail := v_fail || format('7: a NEGATIVE refund amount was answered by %s — the double negative that is really a payment. ',
        coalesce(left(v_err, 120), 'a written row'));
    end if;

    -- ===================== 5: THE PIN, ALWAYS =============================
    v_ok := false; v_err := null; v_state := null;
    begin
      perform record_refund(v_folio.id, 1000, 'cash', null, 'ZZ067 wrong pin', '0000', 'zz067-badpin');
      v_ok := true;
    exception when others then v_err := sqlerrm; v_state := sqlstate; end;
    if v_ok or v_state is distinct from '42501'
       or v_err not like '%A refund always requires a valid manager PIN%' then
      v_fail := v_fail || format(
        '5: a refund with a wrong PIN was answered by %s / %s. Matched on the message naming the PIN rather than the sqlstate alone, because is_tenant_staff refuses with the same 42501 a few lines earlier. ',
        coalesce(v_state, 'a written row'), coalesce(left(v_err, 120), '(no error)'));
    end if;

    -- ===================== 4: THE CEILING, BOTH SIDES =====================
    -- one kobo over the received 50,000 must refuse...
    v_ok := false; v_err := null; v_state := null;
    begin
      perform record_refund(v_folio.id, 50000.01, 'cash', null, 'ZZ067 over the top', '4067', 'zz067-over');
      v_ok := true;
    exception when others then v_err := sqlerrm; v_state := sqlstate; end;
    if v_ok or v_state is distinct from 'PT402'
       or v_err not like '%more than the%' then
      v_fail := v_fail || format(
        '4: a refund of 50,000.01 against 50,000.00 received was answered by %s / %s. Paying out more than came in is a petty cash payment, not a refund, and the refusal has to say which. ',
        coalesce(v_state, 'a written row'), coalesce(left(v_err, 140), '(no error)'));
    end if;
    if v_err is not null and v_err not like '%50000.01%' then
      v_fail := v_fail || format(
        '4: the refusal does not name the amount asked for: "%s". Both figures are what make it actionable rather than a no. ', left(v_err, 140));
    end if;

    -- ===================== 3, 13: THE REFUND ITSELF =======================
    -- ...and exactly the received amount is allowed. Taken in two halves so
    -- assertion 14 has a partial refund to work against.
    v_ref := record_refund(v_folio.id, 25000, 'cash', 'ZZ067-REF-1',
                           'ZZ067 guest left early', '4067', 'zz067-ref-1');
    if v_ref.amount is distinct from -25000 then
      v_fail := v_fail || format('3: the refund row carries %s, expected -25000. ', v_ref.amount);
    end if;
    if btrim(coalesce(v_ref.refund_reason, '')) = '' then
      v_fail := v_fail || '3: the refund row carries no refund_reason. ';
    end if;
    if v_ref.approved_by is distinct from v_mgr then
      v_fail := v_fail || format(
        '3: approved_by is %s, expected the manager whose PIN matched (%s), not the user at the terminal (%s). This column and created_by answer two different questions — who allowed it and who keyed it — and a payout has to answer both. ',
        coalesce(v_ref.approved_by::text, 'null'), v_mgr, v_user);
    end if;
    if v_ref.created_by is distinct from v_user then
      v_fail := v_fail || format(
        '3: created_by is %s, expected the keying user %s. If the approver has overwritten it, the row answers one question twice and the other not at all. ',
        coalesce(v_ref.created_by::text, 'null'), v_user);
    end if;
    select coalesce(sum(l.debit - l.credit), 0) into v_amt
    from journal_entry_lines l join journal_entries je on je.id = l.journal_entry_id
    where je.source_document_type = 'folio_payment' and je.source_document_id = v_ref.id
      and l.role_key = 'guest_ledger';
    if v_amt is distinct from 25000 then
      v_fail := v_fail || format(
        '3: the refund moved the guest ledger by %s, expected +25000 (a debit: the guest owes more again because we gave the money back). ', v_amt);
    end if;
    select coalesce(sum(l.credit - l.debit), 0) into v_amt
    from journal_entry_lines l join journal_entries je on je.id = l.journal_entry_id
    where je.source_document_type = 'folio_payment' and je.source_document_id = v_ref.id
      and l.role_key = 'cash';
    if v_amt is distinct from 25000 then
      v_fail := v_fail || format('3: cash was credited %s, expected 25000 — the money has to leave an account. ', v_amt);
    end if;

    select * into v_row from folio_gl_reconciliation_folios(v_prop) r
    where r.folio_id = v_folio.id;
    if v_row.ledger_difference is distinct from 0 or v_row.unclassified_value is distinct from 0 then
      v_fail := v_fail || format(
        '13: the refunded folio does not reconcile — difference %s, unclassified %s. 066 exists so this question can be asked in one line. ',
        v_row.ledger_difference, v_row.unclassified_value);
    end if;

    -- ===================== 8: A RETRY NEEDS NO MANAGER ====================
    v_ref2 := record_refund(v_folio.id, 25000, 'cash', 'ZZ067-REF-1',
                            'ZZ067 guest left early', '0000', 'zz067-ref-1');
    if v_ref2.id is distinct from v_ref.id then
      v_fail := v_fail || format(
        '8: a retry with the same key returned %s rather than the first refund %s. ',
        coalesce(v_ref2.id::text, 'nothing'), v_ref.id);
    end if;
    select count(*)::integer into v_n from folio_payments
    where folio_id = v_folio.id and idempotency_key = 'zz067-ref-1';
    if v_n <> 1 then
      v_fail := v_fail || format('8: %s rows carry the retried key. A second payout is the one thing a retry must never be. ', v_n);
    end if;

    -- ===================== 14: THE CEILING FALLS ==========================
    -- 25,000 came back, so 25,000 is left. The ORIGINAL 50,000 must now refuse
    -- — and it is the net that makes that true: the sum of payments IN is still
    -- 50,000 and would allow it.
    select t.payments_total into v_amt from folio_totals(v_folio.id) t;
    if v_amt is distinct from 25000 then
      v_fail := v_fail || format('14: payments_total reads %s after 50,000 in and 25,000 back, expected 25000. ', v_amt);
    end if;
    v_ok := false; v_err := null;
    begin
      perform record_refund(v_folio.id, 50000, 'cash', null, 'ZZ067 twice over', '4067', 'zz067-twice');
      v_ok := true;
    exception when others then v_err := sqlerrm; end;
    if v_ok or v_err not like '%more than the%' then
      v_fail := v_fail || format(
        '14: a second refund of the full 50,000 was answered by %s. The ceiling is the NET of what the folio holds, not the sum of what came in — read the wrong way, a guest could be refunded their deposit twice. ',
        coalesce(left(v_err, 140), 'a written row'));
    end if;
    -- and the remaining 25,000 IS allowed, or the ceiling has simply closed.
    v_ok := false;
    begin
      perform record_refund(v_folio.id, 25000, 'cash', null, 'ZZ067 the rest', '4067', 'zz067-rest');
      v_ok := true;
    exception when others then v_err := sqlerrm; end;
    if not v_ok then
      v_fail := v_fail || format(
        '14: the remaining 25,000 was refused (%s), so the ceiling is not what came in less what went back — it has just stopped allowing refunds. ',
        left(coalesce(v_err, ''), 140));
    end if;

    -- ===================== 9: THE TABLE ITSELF ============================
    -- A DEFERRED CONSTRAINT TRIGGER NEVER FIRES IN A DRY RUN, AND THAT NEARLY
    -- MADE THIS WHOLE FILE'S PROOF A LIE. Deferred events are checked at COMMIT
    -- and this block ends in a deliberate rollback, so every legitimate refund
    -- above would have gone unvalidated and a real commit could have been the
    -- first time the trigger ever ran — against the front desk. Rule 27's
    -- family exactly: a harness that cannot tell working from absent.
    --
    -- `set constraints ... immediate` forces the pending events to be checked
    -- NOW, which is what makes both halves below real.
    --
    -- 9a, THE POSITIVE CONTROL FIRST: the refunds this fixture wrote are
    -- legitimate, so firing the trigger must NOT raise. If it does, the
    -- shipment breaks refunds at the desk the moment it is committed, and
    -- without this line the dry run would have said nothing.
    v_ok := false; v_err := null; v_state := null;
    begin
      execute 'set constraints folio_payments_money_out_explained immediate';
      v_ok := true;
    exception when others then v_err := sqlerrm; v_state := sqlstate; end;
    if not v_ok then
      v_fail := v_fail || format(
        '9a: the constraint trigger REFUSED this fixture''s own legitimate refunds (%s / %s). Those rows carry a reason and an approver, so the guard is wrong in the direction that stops real work. ',
        coalesce(v_state, ''), coalesce(left(v_err, 160), ''));
    end if;
    execute 'set constraints folio_payments_money_out_explained deferred';

    -- 9b, and now an unaccountable one, written past every function in this file.
    v_ok := false; v_err := null; v_state := null;
    begin
      insert into folio_payments (tenant_id, property_id, folio_id, amount, method,
                                  payment_date, created_by)
      values (v_tenant, v_prop, v_folio.id, -5000, 'cash', current_date, v_user);
      execute 'set constraints folio_payments_money_out_explained immediate';
      v_ok := true;
    exception when others then v_err := sqlerrm; v_state := sqlstate; end;
    if v_ok or v_state is distinct from 'PT406'
       or v_err not like '%neither a reversal nor an approved refund%' then
      v_fail := v_fail || format(
        '9b: a money-out row with no reversal link and no approval was accepted by the TABLE (%s / %s). The RPC''s refusal is advice until the table refuses too — and PT406 is deliberately not the ceiling''s PT402, so this cannot pass on the wrong refusal. ',
        coalesce(v_state, 'no error'), coalesce(left(v_err, 140), ''));
    end if;

    -- 9c AND 9d: EACH HALF ON ITS OWN. A reason with no approver, and an
    -- approver with no reason, must both be refused — and they are asserted
    -- SEPARATELY because the breakage run found that dropping the approver half
    -- of the condition stayed GREEN: 9b's row has neither, so it is refused by
    -- whichever half survives. A condition tested only by a row that fails both
    -- halves is a condition half of which is untested.
    v_ok := false; v_err := null; v_state := null;
    begin
      insert into folio_payments (tenant_id, property_id, folio_id, amount, method,
                                  payment_date, refund_reason, created_by)
      values (v_tenant, v_prop, v_folio.id, -5000, 'cash', current_date,
              'ZZ067 a reason and nobody who approved it', v_user);
      execute 'set constraints folio_payments_money_out_explained immediate';
      v_ok := true;
    exception when others then v_err := sqlerrm; v_state := sqlstate; end;
    if v_ok or v_state is distinct from 'PT406' then
      v_fail := v_fail || format(
        '9c: a money-out row with a REASON but no APPROVER was accepted (%s). A reason somebody typed themselves is not an approval, and this is the row a cashier would write. ',
        coalesce(v_state, 'no error'));
    end if;

    v_ok := false; v_err := null; v_state := null;
    begin
      insert into folio_payments (tenant_id, property_id, folio_id, amount, method,
                                  payment_date, approved_by, created_by)
      values (v_tenant, v_prop, v_folio.id, -5000, 'cash', current_date,
              v_mgr, v_user);
      execute 'set constraints folio_payments_money_out_explained immediate';
      v_ok := true;
    exception when others then v_err := sqlerrm; v_state := sqlstate; end;
    if v_ok or v_state is distinct from 'PT406' then
      v_fail := v_fail || format(
        '9d: a money-out row with an APPROVER but no REASON was accepted (%s). ',
        coalesce(v_state, 'no error'));
    end if;

    v_ok := false; v_err := null; v_state := null;
    begin
      insert into folio_payments (tenant_id, property_id, folio_id, amount, method,
                                  payment_date, refund_reason, approved_by, created_by)
      values (v_tenant, v_prop, v_folio.id, 5000, 'cash', current_date,
              'ZZ067 not a refund', v_user, v_user);
      v_ok := true;
    exception when others then v_err := sqlerrm; v_state := sqlstate; end;
    if v_ok or v_state is distinct from '23514'
       or v_err not like '%refund_fields_only_out%' then
      v_fail := v_fail || format(
        '10: a payment IN carrying refund fields was accepted (%s / %s). Then "every row with a refund_reason is a refund" stops being true, and a later report will rely on it without checking. ',
        coalesce(v_state, 'no error'), coalesce(left(v_err, 120), ''));
    end if;

    -- ===================== 11: reverse_payment STILL WORKS ================
    -- THE REGRESSION THIS SHIPMENT COULD CAUSE. Its call into record_payment
    -- passes a negative amount; left unpatched it would take the new flag's
    -- default and every payment reversal would refuse at the desk.
    insert into guests (tenant_id, first_name, last_name, created_by)
    values (v_tenant, 'ZZ067', 'Reversal', v_user) returning id into v_guest;
    v_folio2 := open_guest_folio(v_tenant, v_prop, v_guest, 'zz067-folio-2');
    v_pay := record_payment(v_folio2.id, 18000, 'pos', 'ZZ067-REV-SRC',
                            current_date, 'zz067-rev-src');
    v_ok := false; v_err := null;
    begin
      perform reverse_payment(v_pay.id, 'ZZ067 keyed to the wrong folio', '4067', 'zz067-rev');
      v_ok := true;
    exception when others then v_err := sqlerrm; end;
    if not v_ok then
      v_fail := v_fail || format(
        '11: reverse_payment FAILED (%s). This is the regression: its counter is a negative payment, so an unpatched call takes p_allow_negative''s default and every reversal starts refusing. ',
        left(coalesce(v_err, ''), 160));
    else
      select * into v_rev from folio_payments
      where reversal_of_payment_id = v_pay.id order by created_at desc limit 1;
      if v_rev.amount is distinct from -18000 then
        v_fail := v_fail || format('11: the reversal counter carries %s, expected -18000. ', v_rev.amount);
      end if;
      if v_rev.refund_reason is not null or v_rev.approved_by is not null then
        v_fail := v_fail || '11: the reversal counter carries refund fields. A reversal is not a refund — its reason and approver live on the reversals row (031), and duplicating them here would be a second place to read them from. ';
      end if;
      select coalesce(sum(l.debit - l.credit), 0) into v_amt
      from journal_entry_lines l join journal_entries je on je.id = l.journal_entry_id
      where je.source_document_type = 'folio_payment'
        and je.source_document_id in (v_pay.id, v_rev.id)
        and l.role_key = 'guest_ledger';
      if v_amt is distinct from 0 then
        v_fail := v_fail || format('11: a payment and its reversal net to %s on the guest ledger, expected 0. ', v_amt);
      end if;
      select * into v_row from folio_gl_reconciliation_folios(v_prop) r
      where r.folio_id = v_folio2.id;
      if v_row.ledger_difference is distinct from 0 then
        v_fail := v_fail || format('11: and that folio does not reconcile — difference %s. ', v_row.ledger_difference);
      end if;
    end if;

    -- ===================== 12: THE GRANTS AND THE PIN HELPER ==============
    select count(*)::integer into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and ((p.proname = 'record_payment'
            and pg_get_function_identity_arguments(p.oid)
                = 'p_folio_id uuid, p_amount numeric, p_method text, p_reference text, p_payment_date date, p_idempotency_key text, p_post_journal boolean, p_allow_negative boolean')
        or (p.proname = 'record_refund'))
      and (not has_function_privilege('authenticated', p.oid, 'EXECUTE')
           or has_function_privilege('anon', p.oid, 'EXECUTE')
           or not p.prosecdef);
    if v_bad > 0 then
      v_fail := v_fail || format(
        '12: %s of record_payment / record_refund is not executable by authenticated, IS by anon, or lost SECURITY DEFINER. record_payment''s signature changed, so it was DROPPED, and a drop takes the ACL with it. ', v_bad);
    end if;
    -- AND THE ANON HALF IS THE LOAD-BEARING ONE, which the breakage run is how
    -- we know. Deleting the `grant ... to authenticated` line left this
    -- assertion GREEN, because THIS PROJECT'S DEFAULT PRIVILEGES already grant
    -- EXECUTE on every new function to anon, authenticated and service_role
    -- (pg_default_acl, set by supabase_admin). So the grant line is
    -- belt-and-braces and it is the REVOKE FROM ANON that actually closes
    -- something — on a function that moves money, reachable by an
    -- unauthenticated caller is the failure that matters.
    --
    -- Which also means a new function is PUBLIC until revoked, so the trigger
    -- function gets the same treatment in SECTION 1 and is checked here.
    if has_function_privilege('anon', 'enforce_money_out_explained()', 'EXECUTE')
       or has_function_privilege('public', 'enforce_money_out_explained()', 'EXECUTE') then
      v_fail := v_fail || '12: enforce_money_out_explained is executable by anon or PUBLIC. A new function in this project is granted to anon BY DEFAULT, so every one of them has to be revoked explicitly rather than assumed private. ';
    end if;
    select count(*)::integer into v_n
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'record_payment';
    if v_n <> 1 then
      v_fail := v_fail || format(
        '12: there are %s record_payment overloads. Postgres resolves by argument count, so the one a shorter call reaches would be whichever survived — and the old one has no negative guard. ', v_n);
    end if;
    if has_function_privilege('authenticated', 'verify_manager_pin(uuid, text)', 'EXECUTE') then
      v_fail := v_fail || '12: verify_manager_pin is executable by authenticated. A client that can call it can test PINs. ';
    end if;

    if v_fail <> '' then
      raise exception '067 SELF-VERIFY FAILED — %', v_fail;
    end if;

    raise notice '067 SELF-VERIFY: 15 assertions passed.';
    raise exception 'ZZ_067_FIXTURE_DONE';
  exception
    when others then
      if sqlerrm = 'ZZ_067_FIXTURE_DONE' then
        raise notice '067 self-verify complete; fixture rolled back.';
      else
        raise;
      end if;
  end;
end $$;
