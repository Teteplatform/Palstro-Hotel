-- ============================================================================
-- 063_discounts_and_payments_post.sql
-- Palstro-Hotels: THE OTHER TWO DOCUMENT TYPES POST.
--
-- 1.1h4 items 4 and 5. Two calls added, one refusal added, one decline added:
--
--     post_folio_discount_journal  declines an application whose day has not come
--     apply_charge_discount        posts the DELTA, keyed on the application row
--     record_payment               refuses a forward date, and posts
--
-- With this, every folio document type posts: charges and room nights and
-- counters (062), discount applications and payments (here). Only voids remain
-- (item 6), and they are a document type of their own because void_charge and
-- void_payment write no row.
--
-- ----------------------------------------------------------------------------
-- TWO FORWARD-DATE QUESTIONS, AND THEY GET OPPOSITE ANSWERS
-- ----------------------------------------------------------------------------
-- 062 found that the folio produces future-dated documents and post_journal
-- refuses them. Both paths here have the same exposure, and both were measured
-- rather than assumed:
--
--   * A DISCOUNT ON A NIGHT THAT HAS NOT ARRIVED. 060 dates an application to
--     the business date of the CHARGE it reduces — the day of the bill, not the
--     day somebody approved it. Checked out a four-night guest on arrival day,
--     discounted the third night, and the application came back dated two days
--     ahead. So the helper DECLINES, exactly as the charge helper does: a
--     manager reducing a forward night must not be told the ledger refused.
--
--   * A PAYMENT DATED FORWARD. ACCEPTED before this file, with no guard at all
--     — measured by keying one three days out. But unlike a reserved night,
--     there is no caller for whom it is a real event: money is not received
--     tomorrow. So record_payment REFUSES, with no p_allow_future escape, and
--     the helper gets no decline because one would be unreachable code. One
--     rule, one place.
--
-- reverse_payment is unaffected: it dates its counter TODAY on purpose ("the
-- money goes back out today, and today's cash-up is what must show it"), so
-- the only caller of record_payment cannot trip the new guard. Asserted.
--
-- A BEHAVIOUR CHANGE WORTH NAMING: a payment by method 'other' is now REFUSED
-- OUTRIGHT rather than written as a row the ledger can never accept. 044
-- settled that a missing mapping is a loud failure and never a suspense
-- account; 059 took 'other' off the picker for that reason. Nothing offers it,
-- zero rows carry it, and the constraint still allows it so a hotel that once
-- recorded one stays representable. Both paths are asserted: record_payment
-- refusing it, and the helper refusing a row inserted around the RPC — which is
-- not redundant, because item 2b's sweep reads ROWS and not RPC calls.
--
-- ----------------------------------------------------------------------------
-- WHAT THE BREAKAGES WENT RED FOR (rule 27)
-- ----------------------------------------------------------------------------
-- Fourteen mutations. THIRTEEN red; the one green was PREDICTED and is a fact
-- about the code rather than a hole in the proof.
--
--   A   the posting call dropped from apply_charge_discount      -> 1
--   B   the posting call dropped from record_payment             -> 6, 7
--   C   the discount call handed the CHARGE id                   -> PT404
--   D   the discount decline removed
--         -> post_journal's PT422, from inside apply_charge_discount: a manager
--            reducing a forward-dated night refused by the ledger
--   E   the decline uses >= so TODAY is declined too             -> 1
--   F   the tax delta READ from the row's amount instead of recomputed from its
--       rate
--         -> 1: -744.80 where 15.20 is owed — the whole restated tax instead of
--            the change
--   G   the tax delta legs dropped entirely
--         -> 1 and 4: 032's residue, in the shape it originally had
--   H   the posting call moved ABOVE restate_charge_taxes        -> GREEN
--   I   the entry posts the NEW AMOUNT instead of the delta
--         -> 1: 500.00 where 300.00 is owed, and 2 names the residue. Green on
--            the FIRST application, where previous is 0 and the two coincide,
--            which is why the fixture discounts twice
--   J   the entry keyed on the CHARGE instead of the application -> 1
--   K   the zero-delta skip removed
--         -> post_journal: an entry needs at least two lines. A manager
--            re-approving the same amount would be refused
--   L   the payment forward-date refusal removed                 -> 8
--   M   company_account mapped to cash
--         -> 6: 0 into company_receivable and one cash-like account touched
--   N   the whitelist falls back to cash instead of refusing     -> 7
--
-- WHY H IS GREEN, AND IT IS 061 PAYING FOR ITSELF. On the charge path, posting
-- before capture_charge_taxes is catastrophic: the tax rows do not exist yet,
-- the entry has no tax legs, and it BALANCES anyway because the receivable is
-- the open line (062's breakage C). Here the same move is HARMLESS, and for a
-- reason rather than by luck: restate_charge_taxes deletes and re-inserts the
-- rows but preserves tax_charge_id, code, RATE and account_role_key exactly —
-- only taxable_amount and amount move — and the helper computes the delta from
-- the RATE, never from the amount. So an entry posted either side of restate is
-- identical, measured. 061 chose to read the rate because a 100% comp leaves a
-- row at amount 0.00; that choice turns out to make this whole path immune to
-- the ordering defect that nearly broke the other one.
--
-- ONE THING THE BREAKAGES FORCED ON THE PROOF, AND IT IS A NEW SHAPE:
-- ASSERTION 8 READ THE SQLSTATE AND THE MESSAGE AND WAS STILL SATISFIED BY THE
-- WRONG REFUSAL. Deleting record_payment's forward-date refusal left it green,
-- because the payment then went in, the posting call ran, and post_journal
-- raised ITS own refusal — 'A JOURNAL ENTRY cannot be dated in the future' —
-- same SQLSTATE, and containing the same substring the assertion matched on.
--
--     Reading the sqlstate and the message is not enough when two different
--     refusals share both.
--
-- 059's lesson was "do not accept any exception"; this is one layer deeper:
-- do not accept any exception that merely LOOKS like yours. The assertion now
-- matches on 'A payment cannot be dated...', naming its subject. And the
-- distinction is not pedantry — post_journal refusing means the row was written
-- and the transaction died on the way to the ledger, which is a cashier being
-- told the LEDGER rejected their takings. The refusal belongs at the keystroke.
--
-- ----------------------------------------------------------------------------
-- WHAT THIS FILE DELIBERATELY DOES NOT DO
-- ----------------------------------------------------------------------------
--   * It does not post voids. Item 6: void_charge and void_payment set a flag
--     and write no row, so a void is its own document type, posting as
--     ('folio_charge_void', <the charge's id>) on the same id.
--   * It does not sweep. Item 2b. The backlog of declined documents now has
--     THREE sources rather than one — charges, and as of this file discount
--     applications too — and the sweep must drain all of them.
--   * It does not reconcile. Item 8. But assertion 11 is the first time the
--     invariant closes as an EQUALITY on a folio carrying charges AND discounts
--     AND payments, which is the figure item 8 reads.
--   * It changes no authorisation. No signature changes, so nothing is dropped
--     and no ACL is rebuilt; assertion 13 checks that the three helpers are
--     still ungranted to `authenticated` and that record_payment and
--     apply_charge_discount still are granted.
-- ============================================================================

-- ############################################################################
-- SECTION 1 — THE DISCOUNT HELPER DECLINES A DOCUMENT WHOSE DAY HAS NOT COME
-- ############################################################################
-- Re-emitted from 061's text with one condition added, the mirror of what 062
-- added to the charge helper. §5 of CLAUDE.md: an applied migration is history.
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
  v_timezone  text;
  v_today     date;
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

  -- 063: AND IT DECLINES A DOCUMENT WHOSE DAY HAS NOT COME, exactly as the
  -- charge helper does (062 §1). Returns NULL on 046's precedent: no entry, no
  -- error, the caller's document untouched.
  --
  -- REACHABLE, AND MEASURED BY DOING IT. 060 dates an application to the
  -- business date of the CHARGE it reduces — the day of the bill, not the day
  -- somebody approved it — so discounting a room night that has not arrived
  -- gives an application with a forward business_date. Checked out a four-night
  -- guest on arrival day, discounted the third night, and the row came back
  -- dated two days ahead. Without this, applying that discount would fail at
  -- the desk with post_journal's PT422, and a manager reducing a bill would be
  -- told the ledger refused.
  --
  -- The charge's own entry is waiting for the same morning, and item 2b's sweep
  -- posts both when it arrives. That ordering is not an accident worth relying
  -- on, though: a discount entry is keyed on the application row and the
  -- charge's on the charge, so neither needs the other to have posted first.
  select p.timezone into v_timezone from properties p where p.id = v_c.property_id;
  v_today := (now() at time zone
              coalesce(nullif(btrim(v_timezone), ''), 'Africa/Lagos'))::date;
  if v_d.business_date > v_today then
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

-- ############################################################################
-- SECTION 2 — apply_charge_discount POSTS THE DELTA
-- ############################################################################
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
  v_prev      numeric(14,2);
  v_disc_id   uuid;
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

  -- 060: THE IDEMPOTENCY CHECK READS EVERY APPLICATION, NOT THE LATEST ONE.
  -- It used to read folio_charges.discount_idempotency_key — ONE mutable column,
  -- which holds only the most recent key. A retry of an earlier application
  -- therefore matched nothing, was treated as new, and re-applied itself:
  -- measured on the live schema, a redelivered first key took an 800 discount
  -- back to 500, restated the tax from 699.20 to 722.00, and wrote the earlier
  -- reason over the later one. Nothing errored.
  --
  -- AND IT RETURNS THE CHARGE AS IT STANDS NOW, which is the honest answer to a
  -- replay: that application did happen, and the charge has since moved on.
  -- Returning the state it left behind would be re-applying it by another route.
  if p_idempotency_key is not null then
    select fc.* into v_existing
    from folio_charge_discounts d
    join folio_charges fc on fc.id = d.folio_charge_id
    where d.tenant_id = v_charge.tenant_id
      and d.idempotency_key = p_idempotency_key
    limit 1;
    if found then
      -- 060: AND THE KEY MUST BELONG TO THIS CHARGE. Keys are unique per
      -- TENANT, not per charge, so a client that reuses one against a DIFFERENT
      -- charge finds a real application — and without this check it is handed
      -- that other charge back as a success, which reads to the caller, and on
      -- the screen, as a discount applied to the charge it asked about. The
      -- index is the floor; this sentence is the interface. 056's GRN reversal
      -- refuses a second key on one receipt for the same reason.
      if v_existing.id <> p_charge_id then
        raise exception
          'Idempotency key % was already used to discount charge %, not charge %',
          p_idempotency_key, v_existing.id, p_charge_id
          using errcode = 'PT409',
                hint = 'A key identifies one application to one charge. Retry with the key this charge''s own call used, or use a new one.';
      end if;
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

  -- 060: WHAT IT WAS, READ BEFORE IT IS OVERWRITTEN. v_charge was loaded FOR
  -- UPDATE at the top, so this is the pre-application figure and the only place
  -- it will ever exist once the column below is written.
  v_prev := coalesce(v_charge.discount_amount, 0);

  -- THE UPDATE AND THE HISTORY ROW ARE IN ONE BLOCK, so a concurrent duplicate
  -- that loses the race on EITHER unique index leaves nothing of this call
  -- behind. A raise inside a begin/exception block rolls that block's
  -- subtransaction back, which is exactly the wanted behaviour here: the winner
  -- owns both the column and the row, and this caller returns the winner's view.
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

    -- 060: THE APPLICATION ITSELF, as a row that nothing overwrites. Its
    -- approver is THIS application's, which the column on the charge forgets
    -- the moment a second one lands (§6: "who did this" must be answerable for
    -- every row, and a discount is the most theft-adjacent act on the floor).
    --
    -- business_date is the CHARGE's operating day, not today's: a discount
    -- belongs to the day of the charge it reduces (rules 8, 12).
    insert into folio_charge_discounts (
      tenant_id, property_id, folio_charge_id,
      previous_amount, new_amount, approved_by, reason,
      business_date, idempotency_key, created_by
    ) values (
      v_charge.tenant_id, v_charge.property_id, v_charge.id,
      v_prev, p_discount_amount, v_approver, btrim(p_reason),
      v_charge.charge_date, p_idempotency_key, v_actor
    )
    returning id into v_disc_id;
  exception
    when unique_violation then
      -- A concurrent caller won on folio_charge_discounts_idem_uniq (or on the
      -- charge's older index). Return THEIR row rather than applying twice.
      if p_idempotency_key is not null then
        select fc.* into v_existing
        from folio_charge_discounts d
        join folio_charges fc on fc.id = d.folio_charge_id
        where d.tenant_id = v_charge.tenant_id
          and d.idempotency_key = p_idempotency_key
        limit 1;
        if not found then
          -- The charge's own older index can also be the one that fired, and it
          -- sees only latest keys. Fall back to it before giving up.
          select * into v_existing
          from folio_charges
          where tenant_id = v_charge.tenant_id
            and discount_idempotency_key = p_idempotency_key
          limit 1;
        end if;
        if found then
          -- Same ownership check as the fast path, and it is NOT redundant
          -- here: the older index is on folio_charges.discount_idempotency_key,
          -- so a key already sitting in ANOTHER charge's column makes this
          -- UPDATE violate it, and the fallback then finds that other charge.
          -- Two routes to the same wrong answer, one check.
          if v_existing.id <> p_charge_id then
            raise exception
              'Idempotency key % was already used to discount charge %, not charge %',
              p_idempotency_key, v_existing.id, p_charge_id
              using errcode = 'PT409',
                    hint = 'A key identifies one application to one charge. Retry with the key this charge''s own call used, or use a new one.';
          end if;
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

  -- 063: AND NOW THE APPLICATION POSTS ITS DELTA. Keyed on the
  -- folio_charge_discounts row (060), never on the charge: journal_entries is
  -- unique on (tenant, source type, source id), so a charge-keyed entry would
  -- post once and hand the second application the first application's entry,
  -- with its delta never reaching the books.
  --
  -- AFTER restate_charge_taxes, and the ordering is deliberate but — unlike the
  -- charge path — NOT load-bearing. The charge path breaks catastrophically if
  -- it posts before capture_charge_taxes, because the tax rows do not exist yet
  -- and the entry balances anyway. Here the rows always exist, and the helper
  -- computes the tax delta from the row RATE rather than its amount, which
  -- restate preserves exactly: same tax_charge_id, same code, same rate, same
  -- account_role_key, only the figures move. So an entry posted either side of
  -- restate is identical. That is 061's decision to read the RATE paying for
  -- itself one shipment later, and the breakage record says so with the
  -- measurement rather than claiming a red it cannot earn.
  --
  -- NOT ON THE REPLAY PATH. The idempotency lookup at the top returns before
  -- the insert, so v_disc_id is null there and nothing posts — the same
  -- decision as the charge path, for the same reason: a redelivered key must
  -- not mint an entry for a pre-wiring document.
  --
  -- perform, NOT an assignment. The helper returns NULL for a ZERO-DELTA
  -- application — the same amount re-approved with a different reason, which
  -- 060 keeps as a real event — and NULL again for one whose business date has
  -- not arrived (§1). post_journal RAISES on a balancing line of zero, so the
  -- skip has to live in the helper, and a not-null check here would turn a
  -- legitimate re-approval into a refusal at the desk.
  perform post_folio_discount_journal(v_disc_id);

  return v_charge;
end;
$function$
;

-- ############################################################################
-- SECTION 3 — record_payment REFUSES A FORWARD DATE, AND POSTS
-- ############################################################################
-- The ONLY function that inserts into folio_payments, and reverse_payment calls
-- it with a negative amount rather than writing its own row — so both sides of
-- a payment and both sides of its reversal travel this one line.
--
-- Its signature does not change, so no drop and no grant to restore.
CREATE OR REPLACE FUNCTION public.record_payment(p_folio_id uuid, p_amount numeric, p_method text, p_reference text, p_payment_date date, p_idempotency_key text)
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

  return v_payment;
end;
$function$
;

-- ############################################################################
-- SECTION 4 — THE SELF-VERIFY, ROLLED BACK
-- ############################################################################
-- Thirteen assertions.
--
--   1  A DISCOUNT POSTS ITS DELTA, WITH ITS TAX. 200 then 500 on one charge, so
--      the second application's delta (300) and its new amount (500) are
--      DIFFERENT NUMBERS — with one application previous is 0 and a helper
--      posting the whole discount is indistinguishable from a correct one
--      (rule 27's fourth shape).
--   2  AND THE WHOLE CHAIN NETS TO ZERO. Charge, both applications and a full
--      reversal: every account to exactly zero. 032's tax residue asserted as
--      an absence, now through the REAL callers end to end — post_charge,
--      apply_charge_discount and reverse_charge, with nothing called by hand.
--   3  A ZERO-DELTA APPLICATION POSTS NOTHING AT ALL. The same amount
--      re-approved with a new reason is a real event 060 keeps, and
--      post_journal RAISES on a balancing line of zero — so if the skip were
--      dropped, re-approving a bill would fail at the desk.
--   4  THE TAX POSTED AGREES WITH restate_charge_taxes' OWN FORMULA. The sum
--      across the charge's entry and both applications must equal
--      round(net * rate, 2) as the row NOW reads. Two expressions computing one
--      quantity is the drift rule 28 is about, so this asserts it rather than
--      commenting on it.
--   5  A DISCOUNT ON A NIGHT THAT HAS NOT ARRIVED POSTS NOTHING, AND THE
--      APPLICATION STILL SUCCEEDS. 060 dates an application to the charge's
--      business date, so this is reachable from the desk; without the decline a
--      manager reducing a forward night is told the ledger refused.
--   6  A PAYMENT POSTS, BY METHOD, FOR ALL FOUR. cash to cash, bank_transfer
--      to bank, pos to pos_clearing, company_account to company_receivable —
--      and company_account touches NO cash-like account, because nothing was
--      received: the debt moved from the guest to the company.
--   7  AND AN UNDECIDED METHOD REFUSES BY NAME. 'other' is legal in the
--      constraint, off the picker since 059 and carries zero rows, so it is the
--      one legal value with no account. PT422, read by SQLSTATE and message.
--   8  A FORWARD-DATED PAYMENT IS REFUSED, AND A TODAY-DATED ONE IS NOT. Both
--      sides: a guard that refuses everything is as wrong as one that refuses
--      nothing. It was accepted before this shipment, measured.
--   9  A PAYMENT REVERSAL MIRRORS BY SIGN AND IS LINKED, and reverse_payment
--      dates it TODAY rather than the original's day, so the guard never
--      catches the one caller of record_payment.
--  10  NEITHER REPLAY POSTS. A redelivered discount key and a redelivered
--      payment key each return the existing row and add no entry.
--  11  THE INVARIANT, NOW CLOSED ON A PAST FOLIO. With charges, discounts and
--      payments all posting, the guest ledger equals folio_balance exactly on a
--      folio whose every document's day has come — the gap 062's assertion 13
--      had to measure is gone.
--  12  NO ROUNDING LINES. post_journal absorbs up to 1.00 into
--      rounding_difference, so a leg a kobo wrong still balances and still
--      posts. A rounding line in a folio entry means a leg is wrong.
--  13  THE SHAPE. All three helpers still SECURITY DEFINER with a pinned
--      search_path and still ungranted to `authenticated`; record_payment and
--      apply_charge_discount keep the grants they had (neither signature
--      changed, so neither was dropped).
do $$
declare
  v_tenant  uuid;
  v_user    uuid;
  v_prop    uuid;
  v_rt      uuid;
  v_guest   uuid;
  v_cat     uuid;
  v_folio   folios;
  v_pfolio  uuid;
  v_a       folio_charges;
  v_rev     folio_charges;
  v_past    uuid;
  v_bk      bookings;
  v_fwd     folio_charges;
  v_pay     folio_payments;
  v_payr    folio_payments;
  v_disc    uuid;
  v_e1      uuid;
  v_e2      uuid;
  v_e3      uuid;
  v_tax0    numeric(14,2);
  v_tax200  numeric(14,2);
  v_tax500  numeric(14,2);
  v_indep   numeric(14,2);
  v_m       text;
  v_role    text;
  v_n       integer;
  v_bad     integer;
  v_amt     numeric;
  v_amt2    numeric;
  v_bal     numeric;
  v_ok      boolean;
  v_err     text;
  v_state   text;
  v_fail    text := '';
  v_d       date;
  v_i       integer;
begin
  begin
    select tu.tenant_id, tu.user_id into v_tenant, v_user
    from tenant_users tu where tu.is_active and tu.role in ('owner','manager') limit 1;
    select p.id into v_prop from properties p where p.tenant_id = v_tenant limit 1;
    if v_tenant is null or v_prop is null then
      raise notice '063 SELF-VERIFY SKIPPED: no tenant or active owner/manager.';
      raise exception 'ZZ_063_FIXTURE_DONE';
    end if;
    perform set_config('request.jwt.claims',
      json_build_object('role','service_role','sub', v_user::text)::text, true);

    -- THIS OVERWRITES A REAL MANAGER'S PIN, and it is only safe because the
    -- ZZ_063_FIXTURE_DONE sentinel below guarantees this block rolls back — the
    -- raise is unconditional, so no path commits it. Anyone copying this
    -- pattern into something that COMMITS must use a throwaway user instead.
    insert into manager_pins (tenant_id, user_id, pin_hash)
    values (v_tenant, v_user, crypt('4063', gen_salt('bf')))
    on conflict (tenant_id, user_id) do update set pin_hash = excluded.pin_hash;

    select cc.id into v_cat from charge_categories cc
    where cc.tenant_id = v_tenant and cc.is_taxable and cc.deleted_at is null
      and cc.is_active and cc.code <> 'room'
    order by cc.code limit 1;
    select rt.id into v_rt from room_types rt
    where rt.tenant_id = v_tenant and rt.deleted_at is null
    order by rt.base_rate limit 1;
    if v_cat is null or v_rt is null then
      raise exception '063 SELF-VERIFY needs a taxable non-room category and a room type.';
    end if;

    -- ===================== 1, 2, 3, 4: THE DISCOUNT CHAIN =================
    insert into guests (tenant_id, first_name, last_name, created_by)
    values (v_tenant, 'ZZ063', 'Discount Chain', v_user) returning id into v_guest;
    v_folio := open_guest_folio(v_tenant, v_prop, v_guest, 'zz063-folio-1');
    v_a := post_charge(v_folio.id, v_cat, 'ZZ063 dinner', 1, 10000, current_date,
                       'zz063-charge-1', 'manual');
    select coalesce(sum(t.amount), 0) into v_tax0
    from folio_charge_tax_lines t where t.folio_charge_id = v_a.id;
    if v_tax0 <= 0 then
      raise exception '063 SELF-VERIFY needs a taxed charge; this one captured %.', v_tax0;
    end if;
    select je.id into v_e1 from journal_entries je
    where je.source_document_type = 'folio_charge' and je.source_document_id = v_a.id;
    if v_e1 is null then
      raise exception '063 SELF-VERIFY: the charge posted no entry; 062''s wiring is gone.';
    end if;

    -- first application, 0 -> 200
    perform apply_charge_discount(v_a.id, 200, 'ZZ063 goodwill', '4063', 'zz063-k1');
    select coalesce(sum(t.amount), 0) into v_tax200
    from folio_charge_tax_lines t where t.folio_charge_id = v_a.id;
    select d.id into v_disc from folio_charge_discounts d
    where d.folio_charge_id = v_a.id order by d.seq desc limit 1;
    select je.id into v_e2 from journal_entries je
    where je.source_document_type = 'folio_charge_discount' and je.source_document_id = v_disc;
    if v_e2 is null then
      raise exception '063 SELF-VERIFY: the first discount application posted no entry. The posting call is missing.';
    end if;
    select coalesce(sum(l.debit - l.credit), 0) into v_amt
    from journal_entry_lines l where l.journal_entry_id = v_e2 and l.role_key = 'discounts_allowed';
    if v_amt is distinct from 200.00 then
      v_fail := v_fail || format('1: the first application''s discount leg nets %s, expected 200.00. ', v_amt);
    end if;
    select coalesce(sum(l.debit - l.credit), 0) into v_amt
    from journal_entry_lines l where l.journal_entry_id = v_e2 and l.role_key = 'vat_output';
    if v_amt is distinct from v_tax0 - v_tax200 then
      v_fail := v_fail || format(
        '1: the first application''s tax delta leg nets %s, expected %s. Omitting it is 032''s tax residue in its original form: entries that balance, reconcile, and do not net. ',
        v_amt, v_tax0 - v_tax200);
    end if;

    -- second application, 200 -> 500, where the delta and the amount differ
    perform apply_charge_discount(v_a.id, 500, 'ZZ063 more goodwill', '4063', 'zz063-k2');
    select coalesce(sum(t.amount), 0) into v_tax500
    from folio_charge_tax_lines t where t.folio_charge_id = v_a.id;
    select d.id into v_disc from folio_charge_discounts d
    where d.folio_charge_id = v_a.id order by d.seq desc limit 1;
    select je.id into v_e3 from journal_entries je
    where je.source_document_type = 'folio_charge_discount' and je.source_document_id = v_disc;
    if v_e3 is null then
      raise exception '063 SELF-VERIFY: the second discount application posted no entry.';
    end if;
    select coalesce(sum(l.debit - l.credit), 0) into v_amt
    from journal_entry_lines l where l.journal_entry_id = v_e3 and l.role_key = 'discounts_allowed';
    if v_amt is distinct from 300.00 then
      v_fail := v_fail || format(
        '1: raising the discount from 200 to 500 posted %s, expected the DELTA of 300.00. A helper posting the new amount reads 500.00 here — and would have been GREEN on the first application, where previous is 0 and the two coincide. ',
        v_amt);
    end if;
    select coalesce(sum(l.debit - l.credit), 0) into v_amt
    from journal_entry_lines l where l.journal_entry_id = v_e3 and l.role_key = 'vat_output';
    if v_amt is distinct from v_tax200 - v_tax500 then
      v_fail := v_fail || format(
        '1: the second application''s tax delta nets %s, expected %s — the change between two states, not the whole restated tax. ',
        v_amt, v_tax200 - v_tax500);
    end if;

    -- 4: the posted tax agrees with restate's own expression
    select coalesce(sum(round((v_a.gross_amount - 500) * t.rate, 2)), 0) into v_indep
    from folio_charge_tax_lines t where t.folio_charge_id = v_a.id;
    select coalesce(-sum(l.debit - l.credit), 0) into v_amt
    from journal_entry_lines l
    where l.journal_entry_id = any(array[v_e1, v_e2, v_e3]) and l.role_key = 'vat_output';
    if v_amt is distinct from v_indep or v_indep is distinct from v_tax500 then
      v_fail := v_fail || format(
        '4: the tax POSTED across the charge and both applications is %s, the independent round(net * rate, 2) is %s, and the row now reads %s. All three must agree or the delta expression has drifted from restate_charge_taxes. ',
        v_amt, v_indep, v_tax500);
    end if;

    -- 3: a zero-delta application posts nothing at all
    perform apply_charge_discount(v_a.id, 500, 'ZZ063 re-approved, same amount',
                                  '4063', 'zz063-k3');
    select d.id into v_disc from folio_charge_discounts d
    where d.folio_charge_id = v_a.id order by d.seq desc limit 1;
    select count(*)::integer into v_n from journal_entries je
    where je.source_document_type = 'folio_charge_discount' and je.source_document_id = v_disc;
    if v_n <> 0 then
      v_fail := v_fail || format(
        '3: re-approving the same amount posted %s entr(ies). The row is kept (060) and the entry is skipped, because post_journal RAISES on a zero balancing line — so without the skip a manager re-approving a bill is refused. ',
        v_n);
    end if;

    -- 2: and the whole chain nets to zero through the real callers
    select * into v_a from folio_charges where id = v_a.id;
    perform reverse_charge(v_a.id, 'ZZ063 keyed in error', '4063', 'zz063-rc-1');
    select * into v_rev from folio_charges
    where reversal_of_charge_id = v_a.id and reversal_target_type = 'charge'
    order by created_at desc limit 1;
    if not found then
      v_fail := v_fail || '2: reverse_charge wrote no counter charge. ';
    else
      select count(*)::integer into v_bad
      from (
        select l.role_key, sum(l.debit - l.credit) net
        from journal_entry_lines l
        join journal_entries je on je.id = l.journal_entry_id
        where (je.source_document_type = 'folio_charge'
               and je.source_document_id in (v_a.id, v_rev.id))
           or (je.source_document_type = 'folio_charge_discount'
               and je.source_document_id in (select d.id from folio_charge_discounts d
                                             where d.folio_charge_id = v_a.id))
        group by l.role_key having sum(l.debit - l.credit) <> 0
      ) r;
      if v_bad > 0 then
        select string_agg(format('%s %s', r.role_key, r.net), ', ') into v_err
        from (
          select l.role_key, sum(l.debit - l.credit) net
          from journal_entry_lines l
          join journal_entries je on je.id = l.journal_entry_id
          where (je.source_document_type = 'folio_charge'
                 and je.source_document_id in (v_a.id, v_rev.id))
             or (je.source_document_type = 'folio_charge_discount'
                 and je.source_document_id in (select d.id from folio_charge_discounts d
                                               where d.folio_charge_id = v_a.id))
          group by l.role_key having sum(l.debit - l.credit) <> 0
        ) r;
        v_fail := v_fail || format(
          '2: a charge, two discount applications and a full reversal left a residue in %s account(s): %s. Every one must net to zero — 032''s tax residue asserted as an absence, end to end through the real callers. ',
          v_bad, v_err);
      end if;
    end if;

    -- ===================== 5: A DISCOUNT ON A FORWARD NIGHT ===============
    insert into guests (tenant_id, first_name, last_name, created_by)
    values (v_tenant, 'ZZ063', 'Early Departure', v_user) returning id into v_guest;
    v_bk := create_booking(v_prop, v_rt, v_guest, current_date, current_date + 4,
                           1, 'zz063-bk-f', 0, null, 'guest', null, null);
    perform check_in_booking(v_bk.id, 'zz063-ci-f', now());
    perform check_out_booking(v_bk.id, 'zz063-co-f');
    select fc.* into v_fwd from folio_charges fc
    join folios f on f.id = fc.folio_id
    where f.booking_id = v_bk.id and fc.source = 'room' and fc.charge_date > current_date
    order by fc.charge_date limit 1;
    if not found then
      raise exception '063 SELF-VERIFY: the early checkout produced no forward-dated night.';
    end if;
    -- THE APPLICATION MUST SUCCEED and post NOTHING. Without the decline this
    -- call raises PT422 and a manager reducing a forward night is refused.
    perform apply_charge_discount(v_fwd.id, 400, 'ZZ063 goodwill on a future night',
                                  '4063', 'zz063-k4');
    select d.id into v_disc from folio_charge_discounts d
    where d.folio_charge_id = v_fwd.id order by d.seq desc limit 1;
    if v_disc is null then
      v_fail := v_fail || '5: the discount on a forward night wrote no application row. ';
    end if;
    select count(*)::integer into v_n from journal_entries je
    where je.source_document_type = 'folio_charge_discount' and je.source_document_id = v_disc;
    if v_n <> 0 then
      v_fail := v_fail || format(
        '5: a discount on a night that has not arrived posted %s entr(ies). Its business date is the night''s, so revenue and the relief against it belong to that day. ', v_n);
    end if;
    select d.business_date into v_d from folio_charge_discounts d where d.id = v_disc;
    if v_d <= current_date then
      v_fail := v_fail || format(
        '5: the application came out dated %s, which is not in the future, so this assertion is not testing the decline. ', v_d);
    end if;

    -- ===================== 6, 7, 8: PAYMENTS, ALL FOUR METHODS ============
    insert into guests (tenant_id, first_name, last_name, created_by)
    values (v_tenant, 'ZZ063', 'Payer', v_user) returning id into v_guest;
    v_folio := open_guest_folio(v_tenant, v_prop, v_guest, 'zz063-folio-2');
    perform post_charge(v_folio.id, v_cat, 'ZZ063 to settle', 1, 60000, current_date,
                        'zz063-charge-2', 'manual');

    v_i := 0;
    for v_m, v_role in
      select * from (values ('cash','cash'), ('bank_transfer','bank'),
                            ('pos','pos_clearing'), ('company_account','company_receivable')) m(a,b)
    loop
      v_i := v_i + 1;
      v_pay := record_payment(v_folio.id, 1000 * v_i, v_m, 'ZZ063 ' || v_m,
                              current_date, 'zz063-pay-' || v_i::text);
      select je.id into v_e1 from journal_entries je
      where je.source_document_type = 'folio_payment' and je.source_document_id = v_pay.id;
      if v_e1 is null then
        v_fail := v_fail || format('6: a %s payment posted no entry. ', v_m);
      else
        select count(*)::integer into v_n
        from journal_entry_lines l where l.journal_entry_id = v_e1;
        select coalesce(sum(l.debit - l.credit), 0) into v_amt
        from journal_entry_lines l where l.journal_entry_id = v_e1 and l.role_key = v_role;
        select coalesce(sum(l.debit - l.credit), 0) into v_amt2
        from journal_entry_lines l where l.journal_entry_id = v_e1 and l.role_key = 'guest_ledger';
        if v_n <> 2 or v_amt is distinct from (1000 * v_i)::numeric
           or v_amt2 is distinct from -(1000 * v_i)::numeric then
          v_fail := v_fail || format(
            '6: a %s payment of %s posted %s lines, %s into %s and %s into the guest ledger; expected 2 lines, +%s and -%s. ',
            v_m, 1000 * v_i, v_n, v_amt, v_role, v_amt2, 1000 * v_i, 1000 * v_i);
        end if;
        -- a company account is NOT a receipt: nothing arrived, the debtor changed
        if v_m = 'company_account' then
          select count(*)::integer into v_bad
          from journal_entry_lines l
          where l.journal_entry_id = v_e1 and l.role_key in ('cash','bank','pos_clearing');
          if v_bad > 0 then
            v_fail := v_fail || format(
              '6: a company-account payment touched %s cash-like account(s). Mapping it to cash or a bank says money arrived when only the debtor changed. ', v_bad);
          end if;
        end if;
      end if;
    end loop;

    -- 7: 'other' HAS NO ACCOUNT AND MUST REFUSE BY NAME, ON BOTH PATHS.
    --
    -- A BEHAVIOUR CHANGE WORTH NAMING: now that record_payment posts, a payment
    -- by an undecided method is REFUSED OUTRIGHT rather than written as a row
    -- the ledger can never accept. Before this shipment it went in and sat
    -- there. 044 settled that a missing mapping is a loud failure and never a
    -- suspense account, and 059 took 'other' off the picker for exactly this
    -- reason — so nothing offers it, zero rows carry it, and the constraint
    -- still allows it so a hotel that recorded one stays representable.
    v_ok := false; v_err := null; v_state := null;
    begin
      perform record_payment(v_folio.id, 100, 'other', 'ZZ063 undecided',
                             current_date, 'zz063-pay-other');
      v_ok := true;
    exception when others then v_err := sqlerrm; v_state := sqlstate; end;
    if v_ok or v_state is distinct from 'PT422'
       or v_err not like '%"other"%' or v_err not like '%no account decided%' then
      v_fail := v_fail || format(
        '7: recording a payment by an undecided method was answered by %s / %s. It must refuse BY NAME — a role key built by concatenation fails as a missing account_mappings row, which invites somebody to add one instead of deciding where the money goes. ',
        coalesce(v_state, 'a recorded payment'), coalesce(v_err, '(no error)'));
    end if;

    -- AND THE HELPER REFUSES IT INDEPENDENTLY, which is not redundant: once
    -- record_payment refuses, the helper's own refusal is what protects item
    -- 2b's sweep, which reads ROWS rather than calling the RPC. A row written
    -- before 'other' was refused — or by a future path that bypasses the RPC —
    -- must not post to a guessed account. Inserted directly for that reason.
    insert into folio_payments (tenant_id, property_id, folio_id, amount, method,
                                reference, payment_date, idempotency_key, created_by)
    values (v_tenant, v_prop, v_folio.id, 100, 'other', 'ZZ063 legacy row',
            current_date, 'zz063-pay-legacy', v_user)
    returning * into v_pay;
    v_ok := false; v_err := null; v_state := null;
    begin
      perform post_folio_payment_journal(v_pay.id);
      v_ok := true;
    exception when others then v_err := sqlerrm; v_state := sqlstate; end;
    if v_ok or v_state is distinct from 'PT422'
       or v_err not like '%"other"%' or v_err not like '%no account decided%' then
      v_fail := v_fail || format(
        '7: the helper was handed a row with an undecided method and answered %s / %s. The sweep reads rows, not RPC calls. ',
        coalesce(v_state, 'a posted entry'), coalesce(v_err, '(no error)'));
    end if;

    -- 8: a forward-dated payment is refused, and a today-dated one is not
    v_ok := false; v_err := null; v_state := null;
    begin
      perform record_payment(v_folio.id, 500, 'cash', 'ZZ063 next week',
                             current_date + 3, 'zz063-pay-future');
      v_ok := true;
    exception when others then v_err := sqlerrm; v_state := sqlstate; end;
    -- MATCHED ON "A PAYMENT", NOT ON "cannot be dated in the future".
    -- Deleting record_payment's refusal left this assertion GREEN: the payment
    -- went in, the posting call ran, and post_journal refused it with ITS own
    -- message — 'A JOURNAL ENTRY cannot be dated in the future' — which carries
    -- the same SQLSTATE and contains the same substring. Reading the sqlstate
    -- AND the message is not enough when TWO DIFFERENT REFUSALS SHARE BOTH
    -- (rule 27's fifth shape, one layer deeper than 059's). The pattern now
    -- names the subject, so only record_payment's own refusal satisfies it.
    --
    -- And the distinction is not pedantry: post_journal refusing means the row
    -- was already written and the transaction dies on the way to the ledger,
    -- which is the cashier being told the LEDGER rejected their takings. The
    -- refusal has to be at the keystroke.
    if v_ok or v_state is distinct from 'PT422'
       or v_err not like '%A payment cannot be dated in the future%' then
      v_fail := v_fail || format(
        '8: a payment dated three days out was answered by %s / %s. Money is not received tomorrow, and it was ACCEPTED before this shipment. If that message mentions a JOURNAL ENTRY, the refusal came from post_journal after the row was written, not from the keystroke. ',
        coalesce(v_state, 'a recorded payment'), coalesce(v_err, '(no error)'));
    end if;
    begin
      perform record_payment(v_folio.id, 500, 'cash', 'ZZ063 today is fine',
                             current_date, 'zz063-pay-today');
    exception when others then
      v_fail := v_fail || format(
        '8: a payment dated TODAY was refused by %s / %s. A guard that refuses everything is as wrong as one that refuses nothing. ',
        sqlstate, sqlerrm);
    end;

    -- ===================== 9: A PAYMENT REVERSAL ==========================
    select * into v_pay from folio_payments
    where folio_id = v_folio.id and method = 'cash' and amount = 1000 limit 1;
    perform reverse_payment(v_pay.id, 'ZZ063 wrong guest', '4063', 'zz063-payrev-1');
    select * into v_payr from folio_payments
    where reversal_of_payment_id = v_pay.id order by created_at desc limit 1;
    if not found then
      v_fail := v_fail || '9: reverse_payment wrote no counter payment. ';
    else
      select je.id into v_e1 from journal_entries je
      where je.source_document_type = 'folio_payment' and je.source_document_id = v_payr.id;
      if v_e1 is null then
        v_fail := v_fail || '9: the payment reversal posted no entry. ';
      else
        select coalesce(sum(l.debit - l.credit), 0) into v_amt
        from journal_entry_lines l where l.journal_entry_id = v_e1 and l.role_key = 'cash';
        select coalesce(sum(l.debit - l.credit), 0) into v_amt2
        from journal_entry_lines l where l.journal_entry_id = v_e1 and l.role_key = 'guest_ledger';
        if v_amt is distinct from -1000.00 or v_amt2 is distinct from 1000.00 then
          v_fail := v_fail || format(
            '9: the payment reversal posted cash %s and receivable %s, expected -1000.00 and +1000.00 — the mirror, by sign and nothing else. ',
            v_amt, v_amt2);
        end if;
      end if;
      if v_payr.payment_date is distinct from current_date then
        v_fail := v_fail || format(
          '9: the reversal is dated %s rather than today. reverse_payment dates it the day the money goes back out, which is also why the forward-date guard never catches the one caller of record_payment. ',
          v_payr.payment_date);
      end if;
    end if;

    -- ===================== 10: NEITHER REPLAY POSTS =======================
    select count(*)::integer into v_n from journal_entries;
    perform apply_charge_discount(v_fwd.id, 400, 'ZZ063 goodwill on a future night',
                                  '4063', 'zz063-k4');
    perform record_payment(v_folio.id, 1000, 'cash', 'ZZ063 cash', current_date,
                           'zz063-pay-1');
    select count(*)::integer into v_bad from journal_entries;
    if v_bad <> v_n then
      v_fail := v_fail || format(
        '10: redelivering a discount key and a payment key added %s entr(ies). A replay returns a row somebody else wrote. ', v_bad - v_n);
    end if;

    -- ===================== 11: THE INVARIANT, NOW CLOSED ==================
    -- A PAST stay, every document's day arrived, charges AND discounts AND
    -- payments all posting. The gap 062's assertion 13 had to measure is gone,
    -- so this is an equality rather than an accounted difference.
    insert into guests (tenant_id, first_name, last_name, created_by)
    values (v_tenant, 'ZZ063', 'Past Stay', v_user) returning id into v_guest;
    insert into bookings (tenant_id, property_id, room_type_id, guest_id,
                          booking_number, check_in, check_out, adults, status,
                          bill_to, created_by)
    values (v_tenant, v_prop, v_rt, v_guest, 'ZZ063-PAST', current_date - 4,
            current_date - 1, 1, 'checked_in', 'guest', v_user)
    returning id into v_past;
    v_i := 0;
    for v_d in select (current_date - 4) + g from generate_series(0, 2) g loop
      v_i := v_i + 1;
      insert into booking_nights (tenant_id, property_id, booking_id, stay_date,
                                  rate, rate_source, created_by)
      values (v_tenant, v_prop, v_past, v_d,
              (array[52000, 48000, 61000])[v_i], 'fixture', v_user);
    end loop;
    for v_d in select bn.stay_date from booking_nights bn
               where bn.booking_id = v_past order by bn.stay_date loop
      perform post_room_night_charge(v_past, v_d, null);
    end loop;
    select f.id into v_pfolio from folios f where f.booking_id = v_past;
    -- a discount on the middle night, and a part payment
    select fc.id into v_disc from folio_charges fc
    where fc.folio_id = v_pfolio and fc.source = 'room'
      and fc.charge_date = current_date - 3;
    perform apply_charge_discount(v_disc, 3000, 'ZZ063 past goodwill', '4063', 'zz063-k5');
    perform record_payment(v_pfolio, 40000, 'cash', 'ZZ063 part settlement',
                           current_date - 1, 'zz063-pay-past');

    select coalesce(sum(l.debit - l.credit), 0) into v_amt
    from journal_entry_lines l
    join journal_entries je on je.id = l.journal_entry_id
    where l.role_key = 'guest_ledger'
      and ((je.source_document_type = 'folio_charge'
            and je.source_document_id in (select id from folio_charges where folio_id = v_pfolio))
        or (je.source_document_type = 'folio_payment'
            and je.source_document_id in (select id from folio_payments where folio_id = v_pfolio))
        or (je.source_document_type = 'folio_charge_discount'
            and je.source_document_id in (
              select d.id from folio_charge_discounts d
              join folio_charges c on c.id = d.folio_charge_id
              where c.folio_id = v_pfolio)));
    v_bal := folio_balance(v_pfolio);
    if v_amt is distinct from v_bal or v_bal = 0 then
      v_fail := v_fail || format(
        '11: the guest ledger nets %s over the past stay''s entries while folio_balance reads %s. Every document on that folio has had its day, so this is now an EQUALITY — folio_balance is computed from the folio tables and knows nothing about the ledger. A zero balance would make it vacuous. ',
        v_amt, v_bal);
    end if;

    -- ===================== 12: NO ROUNDING LINES ==========================
    select count(*)::integer into v_bad
    from journal_entry_lines l
    where l.role_key = 'rounding_difference'
      and l.journal_entry_id in (select je.id from journal_entries je
        where je.source_document_type in ('folio_charge','folio_payment','folio_charge_discount'));
    if v_bad > 0 then
      v_fail := v_fail || format(
        '12: %s rounding_difference line(s) in folio entries. post_journal absorbs up to 1.00 into that line, so a leg a kobo wrong still balances and still posts. ', v_bad);
    end if;

    -- ===================== 13: THE SHAPE ==================================
    select count(*)::integer into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('post_folio_charge_journal','post_folio_discount_journal',
                        'post_folio_payment_journal')
      and (not p.prosecdef
           or p.proconfig is null
           or not exists (select 1 from unnest(p.proconfig) cfg where cfg like 'search_path=public%')
           or has_function_privilege('authenticated', p.oid, 'EXECUTE'));
    if v_bad > 0 then
      v_fail := v_fail || format(
        '13: %s of the three helpers lost SECURITY DEFINER, lost its pinned search_path, or became executable by `authenticated`. ', v_bad);
    end if;
    select count(*)::integer into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('record_payment','apply_charge_discount')
      and (not has_function_privilege('authenticated', p.oid, 'EXECUTE')
           or has_function_privilege('anon', p.oid, 'EXECUTE'));
    if v_bad > 0 then
      v_fail := v_fail || format(
        '13: %s of record_payment / apply_charge_discount is not executable by authenticated, or IS executable by anon. Neither signature changed, so neither was dropped and neither should have lost its ACL. ', v_bad);
    end if;

    if v_fail <> '' then
      raise exception '063 SELF-VERIFY FAILED — %', v_fail;
    end if;

    raise notice '063 SELF-VERIFY: 13 assertions passed.';
    raise exception 'ZZ_063_FIXTURE_DONE';
  exception
    when others then
      if sqlerrm = 'ZZ_063_FIXTURE_DONE' then
        raise notice '063 self-verify complete; fixture rolled back.';
      else
        raise;
      end if;
  end;
end $$;
