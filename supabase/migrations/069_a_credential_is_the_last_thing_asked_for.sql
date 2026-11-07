-- ============================================================================
-- 069  A CREDENTIAL IS THE LAST THING ASKED FOR
-- ============================================================================
-- Three functions reordered so that every precondition which cannot be
-- satisfied by fetching a manager is tested BEFORE the manager's PIN is
-- demanded. No new rule, no new permission, no signature change: the same acts
-- succeed and the same acts fail. What changes is whether somebody walks across
-- the building first.
--
--     A PIN IS THE MOST EXPENSIVE CHECK IN THE PRODUCT, because it is the only
--     one that moves a human being. Cheap refusals first; the credential last.
--
-- ----------------------------------------------------------------------------
-- THE CENSUS THAT SCOPED THIS, BECAUSE ONE FUNCTION IS NOT A PATTERN
-- ----------------------------------------------------------------------------
-- Fourteen functions call verify_manager_pin, found by syntax — the name
-- followed by an open parenthesis, with comments and string literals stripped
-- first — and then each one opened and read in place (rule 29). TWELVE WERE
-- ALREADY CORRECT, which is a house pattern nobody had written down; it is now
-- in CLAUDE.md so it survives the next person.
--
-- THREE EXCEPTIONS ARE LEGITIMATE AND MUST NOT BE "FIXED", and they are named
-- here as well as in CLAUDE.md because this file is where somebody will come
-- looking:
--
--   * THE PIN DECISION ITSELF. apply_charge_discount demands a PIN only for a
--     comp or an above-threshold discount, so whether one is needed cannot be
--     known until the amount has been validated. post_stock_receipt and
--     receive_purchase_order are the same shape.
--   * A REPLAY CHECK INSIDE A unique_violation HANDLER. apply_charge_discount's
--     key-ownership refusal can only fire after the insert is attempted.
--   * A COURTESY REFUSAL OF A PIN THAT WAS NOT NEEDED — "No manager PIN is
--     needed to receive stock into %". It is about the PIN, so it belongs with
--     the PIN.
--
-- What this file changes, and what it deliberately does not:
--
--   SECTION 1  reverse_purchase_receipt — two checks move above the PIN
--   SECTION 2  reverse_no_show          — the folio check moves above the PIN
--   SECTION 3  record_refund            — a closed folio refused at the REFUND
--                                         door, before the PIN
--   SECTION 4  the self-verify: 11 assertions, rolled back
--
--   * receive_purchase_order IS LEFT ALONE. Its one out-of-order check — an
--     expense line whose category resolves to no role key — sits inside the
--     per-line work loop, so hoisting it means a pre-pass over p_lines in a
--     535-line delivery function on a money path. It is reachable only if an
--     admin retires an expense category while a delivery is being received.
--     THE DEFERRAL HAS A TRIGGER rather than a "later" (044's model): THE DAY
--     THAT FUNCTION NEEDS A PRE-PASS OVER p_lines FOR ANY OTHER REASON, THIS
--     CHECK JOINS IT. Until then the pre-pass is risk bought with nothing.
--   * reverse_purchase_receipt's PER-LINE check stays where it is, for the same
--     reason and to be consistent about it: its own comment says it is
--     belt-and-braces for data older than that file and unreachable going
--     forward, so hoisting it would buy a pre-pass to run a check that cannot
--     fire. Declining it there and taking it here would be incoherent.
--
-- ----------------------------------------------------------------------------
-- TWO OF THE THREE ARE UNREACHABLE TODAY, AND ARE REORDERED ANYWAY
-- ----------------------------------------------------------------------------
-- THIS PARAGRAPH EXISTS SO THE NEXT READER DOES NOT DELETE THE REORDER AS DEAD
-- WORK, which is exactly what it will look like.
--
-- NOTHING IN THIS BUILD WRITES folios.status. Measured, not assumed: the only
-- function that updates `folios` at all is reverse_checkout, and it sets the
-- status back to 'open'; check_out_booking moves the BOOKING to checked_out and
-- leaves the folio alone; every live folio is 'open'. So the folio-state
-- preconditions in SECTION 2 and SECTION 3 cannot be met by any path a person
-- can take.
--
-- They are reordered now because THE SHIPMENT THAT WIRES THE FOLIO LIFECYCLE
-- SHOULD NOT ALSO HAVE TO REMEMBER TO COME BACK HERE. A guard written correctly
-- before it matters costs one migration. The same guard remembered later costs a
-- manager standing at a terminal for nothing, and it will be remembered by
-- somebody debugging that, not by somebody reading this.
--
-- SECTION 1 IS REACHABLE TODAY and is the instance that justifies the file on
-- its own: "this delivery was already reversed" is the likeliest state in the
-- building to change between a page load and a submit, because two people
-- clearing the same mistake is the ordinary way it happens. Before this file
-- the storekeeper opened the screen, a colleague reversed it first, the
-- storekeeper walked to find a manager, the manager typed their PIN — and the
-- system then said it had been reversed on the 5th.
--
-- ----------------------------------------------------------------------------
-- THE BREAKAGE RUN: 8 MUTATIONS, 8 RED
-- ----------------------------------------------------------------------------
-- A file that reorders checks and changes no behaviour can only be proven one
-- way: PUT THE OLD ORDER BACK AND WATCH IT FAIL. If the old order passes, the
-- file is decoration.
--
--   A  §1's PIN moved back in front of the two checks            -> 1
--   B  §1's already-reversed check deleted outright              -> 1
--   C  §2's hoisted folio check removed                          -> 4
--   D  §2's hoist tests `= 'open'` instead of `<> 'open'`        -> 4 AND 5
--   E  §3's closed-folio check deleted                           -> 6, 8
--   F  §3's check moved BELOW the PIN                            -> 6
--   G  §3 reuses record_payment's check_violation instead of PT407 -> 6
--   H  record_payment's OWN closed-folio guard weakened          -> 9
--
-- A is the one that matters: it is this file, undone. It goes red with
-- "answered by 42501 / Reversing a delivery always requires a valid manager
-- PIN" — the old behaviour, named.
--
-- AND TWO OF THE EIGHT MUTATIONS WERE WRONG BEFORE THEY WERE RIGHT, which is
-- worth recording because both failures were silent and both looked like the
-- code passing:
--
--   * F replaced the PIN's opening line with "the check, then that same line",
--     which re-inserted the check exactly where it already was — a no-op
--     dressed as a move. It went GREEN against correct code.
--   * H searched record_payment's body for `''closed''` where the text holds
--     `'closed'`, matched nothing, and changed nothing. Also GREEN.
--
-- Both are rule 27's seventh shape — a mutation, like an assertion, that
-- cannot distinguish working from absent — and H now RAISES if its pattern
-- matches nothing rather than quietly succeeding. A breakage harness needs the
-- same scepticism as the proof it is testing.
--
-- ----------------------------------------------------------------------------
-- AND THE FOLIO LIFECYCLE IS A SEPARATE, LARGER FINDING
-- ----------------------------------------------------------------------------
-- While measuring the above: twelve functions guard on folios.status and nothing
-- writes it. Tested by behaviour on a booking that had been checked in and
-- checked out, in a rolled-back transaction — add a charge, take a payment,
-- apply a discount, reverse a charge, refund money: ALL FIVE ACCEPTED, on a
-- departed guest's bill, with the folio still 'open'.
--
-- That is machinery promising a state transition nothing performs, which is
-- rule 28 at the level of a subsystem — and the guards make it worse than no
-- guards, because they are what stops anybody asking the question. It is its
-- own shipment, in stage 1, and NOT this file's business: 069 reorders checks
-- and changes no behaviour, and wiring the lifecycle changes a great deal of it.
--
-- ----------------------------------------------------------------------------
-- LINEAGE
-- ----------------------------------------------------------------------------
--   021  verify_manager_pin, and folios.status, which nothing writes
--   031  a manager PIN always, no threshold, for a reversal
--   046  reverse_purchase_receipt
--   052  refuse at the moment of the decision, not of the consequence
--   067  record_refund, its ceiling and its PIN; and the floor-and-sentence
--        shape this file's SECTION 3 follows
--   068  a refusal names the remedy, and a guard is read by behaviour rather
--        than from its own name
-- ============================================================================

-- ############################################################################
-- SECTION 1 — reverse_purchase_receipt: the two reachable checks move first
-- ############################################################################
-- Signature unchanged, so this is a plain create-or-replace and the ACL is
-- untouched. Extracted from pg_get_functiondef and patched at two seams.
CREATE OR REPLACE FUNCTION public.reverse_purchase_receipt(p_purchase_receipt_id uuid, p_reason text, p_manager_pin text, p_idempotency_key text)
 RETURNS reversals
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_receipt   purchase_receipts;
  v_order     purchase_orders;
  v_tenant    uuid;
  v_existing  reversals;
  v_prior     reversals;
  v_reversal  reversals;
  v_reason    text;
  v_manager   uuid;
  v_timezone  text;
  v_date      date;
  v_entry     journal_entries;
  v_lines     jsonb;
  v_mv        record;
  v_moves     integer := 0;
  v_key       text;
begin
  -- ---- the delivery -------------------------------------------------------
  select * into v_receipt
  from purchase_receipts
  where id = p_purchase_receipt_id
  for update;

  if not found then
    raise exception 'Goods receipt % not found', p_purchase_receipt_id
      using errcode = 'PT404';
  end if;

  v_tenant := v_receipt.tenant_id;

  if not is_tenant_staff(v_tenant) then
    raise exception 'Not authorised to reverse deliveries for this property'
      using errcode = 'insufficient_privilege';
  end if;

  -- ---- idempotency, BEFORE anything is checked or written ------------------
  -- Rule 2, and the reason it comes first: a double-submitted reversal must hand
  -- back the one that exists, not trip over the manager PIN check or the
  -- already-reversed guard on the way to discovering its own earlier self.
  if p_idempotency_key is not null then
    select * into v_existing
    from reversals
    where tenant_id = v_tenant
      and idempotency_key = p_idempotency_key;
    if found then
      return v_existing;
    end if;
  end if;

  -- ---- the reason and the manager -----------------------------------------
  v_reason := nullif(btrim(coalesce(p_reason, '')), '');
  if v_reason is null then
    raise exception 'Say why this delivery is being reversed'
      using errcode = 'PT422',
            hint = 'It is recorded permanently against your name and the approving manager''s, and it is what the next person reads when they ask why the goods went back.';
  end if;

  -- ---- 069: WHAT CANNOT BE FIXED BY ASKING, ASKED FIRST ------------------
  -- These two checks moved ABOVE the manager PIN. Neither can be satisfied by
  -- fetching a manager, so demanding the credential first spends the most
  -- expensive check in the building — one that moves a human across a room — on
  -- a request that was never going to succeed.
  --
  -- AND "ALREADY REVERSED" IS THE LIKELIEST STATE IN THE BUILDING TO CHANGE
  -- BETWEEN A PAGE LOAD AND A SUBMIT: two people clearing the same delivery
  -- mistake is the ordinary way it happens. The storekeeper opens the screen, a
  -- colleague reverses it first, the storekeeper walks to find a manager, the
  -- manager types their PIN — and only then does the system say it was reversed
  -- on the 5th. The PIN was spent to be told no.
  --
  -- The order lookup keeps its FOR UPDATE and now takes that lock earlier,
  -- which is harmless and marginally better: the row this act depends on is
  -- held from the moment the act is known to be possible.
  --
  -- The per-line "already had its stock put back on its own" check STAYS where
  -- it is, inside the movement loop. Its own comment says it is belt-and-braces
  -- for data older than that file and unreachable going forward, so hoisting it
  -- would cost a pre-pass over the lines to run a check that cannot fire —
  -- which is the same trade declined for receive_purchase_order, and it would
  -- be inconsistent to decline it there and take it here.
  -- ---- already reversed? --------------------------------------------------
  select * into v_prior
  from reversals
  where tenant_id   = v_tenant
    and target_type = 'goods_receipt'
    and target_id   = v_receipt.id;

  if found then
    raise exception
      'Delivery % was already reversed on %. A delivery is reversed once, ever.',
      v_receipt.receipt_number, to_char(v_prior.business_date, 'DD Mon YYYY')
      using errcode = 'PT409',
            hint = 'Nothing further is needed. If the goods did arrive after all, receive them again — that is a new delivery note with its own number.';
  end if;

  -- ---- the order ----------------------------------------------------------
  select * into v_order
  from purchase_orders
  where id = v_receipt.purchase_order_id
  for update;

  if not found then
    raise exception 'The order this delivery belongs to no longer exists'
      using errcode = 'PT404';
  end if;

  -- ---- the credential, LAST ----------------------------------------------
  v_manager := verify_manager_pin(v_tenant, p_manager_pin);
  if v_manager is null then
    raise exception 'Reversing a delivery always requires a valid manager PIN'
      using errcode = 'insufficient_privilege',
            hint = 'Hand the terminal to a manager. The reversal is recorded against them by name.';
  end if;


  -- ---- WHEN ---------------------------------------------------------------
  -- The reversal carries ITS OWN business date — today, in the property's
  -- timezone — never the original delivery's. Back-dating an undoing into the
  -- month it happened in puts a correction inside a period that may be closed and
  -- already reported on (rules 8, 12). The original's date stays on the document,
  -- which is where somebody reading the audit trail wants both.
  select p.timezone into v_timezone
  from properties p where p.id = v_receipt.property_id;
  v_date := (now() at time zone coalesce(nullif(btrim(v_timezone), ''), 'Africa/Lagos'))::date;

  perform assert_posting_open(v_receipt.property_id, v_date);

  -- ---- the stock, through the one engine that values a reversal ----------
  -- post_movement_reversal carries the counter at the ORIGINAL's
  -- carried_unit_cost — the basis it unwinds, never today's moving average —
  -- refuses to reverse a reversal, and writes its own permanent reversals row
  -- per movement. It is handed p_post_journal => false because the ledger half of
  -- this act is ONE mirror entry, posted below, not one entry per movement.
  --
  -- NOTHING HERE BLOCKS ON SUFFICIENCY, deliberately. Reversing a delivery whose
  -- goods have already been issued takes the position negative, and §9 is
  -- explicit that a negative is FLAGGED and never blocked: refusing an honest
  -- correction is what teaches staff to invent a fake receipt, which damages the
  -- ledger far more than a negative on a report does.
  for v_mv in
    select rl.stock_movement_id, rl.line_number
    from purchase_receipt_lines rl
    where rl.purchase_receipt_id = v_receipt.id
      and rl.stock_movement_id is not null
    order by rl.line_number
  loop
    -- Belt-and-braces for data older than this file; SECTION 7 makes it
    -- unreachable going forward. See the header above for why this refuses
    -- rather than half-reverses.
    if exists (
      select 1 from reversals r
      where r.tenant_id   = v_tenant
        and r.target_type = 'stock_movement'
        and r.target_id   = v_mv.stock_movement_id
    ) then
      raise exception
        'Line % of delivery % has already had its stock put back on its own, so the delivery cannot be reversed as one act.',
        v_mv.line_number, v_receipt.receipt_number
        using errcode = 'PT409',
              hint = 'The stock side of that line is already corrected. Post an adjustment for anything still wrong — the delivery stays on record as it was recorded.';
    end if;

    v_key := coalesce(p_idempotency_key, 'receipt:' || v_receipt.id::text)
             || ':mv:' || v_mv.stock_movement_id::text;

    perform post_movement_reversal(
      v_mv.stock_movement_id,
      format('Delivery %s reversed — %s', v_receipt.receipt_number, v_reason),
      v_manager,
      auth.uid(),
      v_key,
      false                      -- the delivery posts ONE counter entry, below
    );

    v_moves := v_moves + 1;
  end loop;

  -- ---- ONE COUNTER ENTRY, THE MIRROR OF THE ORIGINAL ---------------------
  -- Same accounts, same amounts, sides flipped, reverses_entry_id naming the
  -- entry it unwinds. A mirror nets to zero per account BY CONSTRUCTION; a
  -- recomputation nets to zero only if the rounding agrees, and 046 already
  -- learned that per-movement values each rounded to the kobo can legitimately
  -- disagree with an average carried at full precision.
  --
  -- A delivery that booked nothing has nothing to mirror: every line closed
  -- short, or a date before gl_start_date. This posts none either, and the pair
  -- stays consistent rather than one side inventing a figure.
  select * into v_entry
  from journal_entries
  where tenant_id            = v_tenant
    and source_document_type = 'goods_receipt'
    and source_document_id   = v_receipt.id;

  if found then
    -- The mirror is built from the ROLE KEYS of the original, because that is
    -- what post_journal resolves through account_mappings (rule 4) — never a
    -- hardcoded code, and never an account id lifted out of one entry and
    -- planted in another.
    if exists (
      select 1 from journal_entry_lines l
      where l.journal_entry_id = v_entry.id and l.role_key is null
    ) then
      raise exception
        'Delivery % posted a journal line with no role key, so it cannot be mirrored.',
        v_receipt.receipt_number
        using errcode = 'PT500',
              hint = 'This is an internal guard. A counter-entry is built from the roles of the entry it unwinds, so a line with no role has no account to post back to.';
    end if;

    select jsonb_agg(
             jsonb_build_object(
               'role_key',    l.role_key,
               'side',        case when l.debit > 0 then 'credit' else 'debit' end,
               'amount',      greatest(l.debit, l.credit),
               'description', l.description
             )
             order by l.id
           )
      into v_lines
    from journal_entry_lines l
    where l.journal_entry_id = v_entry.id;

    perform post_journal(
      v_receipt.property_id,
      v_date,
      format('Delivery reversed — %s against %s',
             v_receipt.receipt_number, v_order.order_number),
      'goods_receipt_reversal',
      v_receipt.id,
      v_lines,
      p_idempotency_key,
      v_entry.id
    );
  end if;

  -- ---- THE DOCUMENT, WRITTEN BEFORE THE STATUS IS RECOMPUTED -------------
  -- See the header: the derivation below reads this row to decide what still
  -- stands. counter_entry_id stays NULL, which SECTION 5's constraint requires —
  -- undoing a delivery has N counter movements and one counter entry, so there is
  -- no single row of the same kind to name.
  insert into reversals (
    tenant_id, property_id, reversed_by, approved_by, reason,
    target_type, target_id, counter_entry_id, business_date,
    idempotency_key, created_by
  ) values (
    v_tenant, v_receipt.property_id, auth.uid(), v_manager, v_reason,
    'goods_receipt', v_receipt.id, null, v_date,
    p_idempotency_key, auth.uid()
  )
  returning * into v_reversal;

  -- ---- AND THE ORDER FOLLOWS BY ITSELF -----------------------------------
  -- The same function receive uses, so the two can never disagree about what has
  -- been delivered. The transition trigger independently checks this value
  -- against the same derivation, which is why no caller — including this one —
  -- can set a status the deliveries do not support.
  update purchase_orders
     set status     = purchase_order_settled_status(v_order.id),
         updated_by = auth.uid()
   where id = v_order.id;

  return v_reversal;
end;
$function$
;

-- ############################################################################
-- SECTION 2 — reverse_no_show: the folio check moves first
-- ############################################################################
CREATE OR REPLACE FUNCTION public.reverse_no_show(p_booking_id uuid, p_reason text, p_manager_pin text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS reversals
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_booking     bookings;
  v_charge      folio_charges;
  v_folio       folios;
  v_charge_rev  reversals;
  v_counter_id  uuid;
  v_reversal    reversals;
  v_existing    reversals;
  v_manager     uuid;
  v_reason      text;
  v_key         text;
  v_timezone    text;
  v_date        date;
  v_actor       uuid := auth.uid();
begin
  -- --- GUARD 1: resolve and LOCK the booking -------------------------------
  -- FOR UPDATE before anything else: two terminals reversing the same no-show in
  -- the same second serialise here, and the loser reads the winner's committed
  -- reversals row at guard 4 instead of restoring twice.
  select * into v_booking
  from bookings
  where id = p_booking_id and deleted_at is null      -- rule 5
  for update;

  if not found then
    raise exception 'Booking % not found', p_booking_id using errcode = 'no_data_found';
  end if;

  -- --- GUARD 2: staff gate, then this caller's own property grant -----------
  if not is_tenant_staff(v_booking.tenant_id) then
    raise exception 'Not authorised to reverse a no-show for this tenant'
      using errcode = 'insufficient_privilege';
  end if;
  if not (v_booking.property_id = any(get_property_ids())) then
    raise exception 'You do not have access to this property'
      using errcode = 'insufficient_privilege';
  end if;

  v_key := coalesce(
    nullif(btrim(p_idempotency_key), ''),
    'reversal:no_show:' || p_booking_id::text
  );

  -- --- GUARD 3: idempotency BY KEY (rules 2 & 3) ---------------------------
  select * into v_existing
  from reversals
  where tenant_id = v_booking.tenant_id and idempotency_key = v_key
  limit 1;
  if found then
    -- A GENUINE RETRY returns the first outcome. A booking that is no_show
    -- AGAIN, however, was re-marked after being restored, and returning success
    -- would tell the desk it had been restored when it plainly has not (§4.2).
    if v_booking.status = 'no_show' then
      raise exception
        'This booking''s no-show has already been reversed once, and it has been marked as a no-show again since'
        using errcode = 'check_violation',
              hint = 'A no-show is reversed once, ever. Cancel the booking, or take a new booking for the guest.';
    end if;
    return v_existing;
  end if;

  -- --- GUARD 4: idempotency BY STATE — already reversed? -------------------
  -- The stronger of the two: it catches a retry arriving with a DIFFERENT key,
  -- and (holding the guard 1 lock) it is what makes "a no-show is reversed at
  -- most once" true under concurrency rather than merely likely. The DB backs it
  -- with reversals_target_uniq.
  select * into v_existing
  from reversals
  where tenant_id = v_booking.tenant_id
    and target_type = 'no_show'
    and target_id = p_booking_id
  limit 1;
  if found then
    if v_booking.status = 'no_show' then
      raise exception
        'This booking''s no-show has already been reversed once, and it has been marked as a no-show again since'
        using errcode = 'check_violation',
              hint = 'A no-show is reversed once, ever. Cancel the booking, or take a new booking for the guest.';
    end if;
    return v_existing;
  end if;

  -- --- GUARD 5: it must BE a no-show ---------------------------------------
  if v_booking.status <> 'no_show' then
    raise exception
      'Only a no-show can have its no-show reversed (this booking is %)', v_booking.status
      using errcode = 'check_violation';
  end if;

  -- --- GUARD 6: the reason is mandatory HERE, not only in the UI (rule 19) --
  v_reason := btrim(coalesce(p_reason, ''));
  if v_reason = '' then
    raise exception 'A reversal needs a reason' using errcode = 'check_violation';
  end if;

  -- --- GUARD 7: A MANAGER PIN. ALWAYS. NO THRESHOLD. -----------------------
  -- 031 §3.2's reasoning, on a status: this re-takes a room the hotel may have
  -- re-sold and un-bills a night already invoiced to a company. There is no
  -- amount below which that is routine and no property setting that can make it
  -- so. Last of the cheap guards, so a call that was going to be rejected anyway
  -- never consumes a PIN entry.
  -- ---- 069: THE FOLIO, BEFORE THE CREDENTIAL -----------------------------
  -- The no-show charge's folio must be open, and no manager can make it so by
  -- arriving. Tested here rather than inside the work below, so a PIN is not
  -- demanded for an act that is already impossible.
  --
  -- UNREACHABLE TODAY, AND MOVED ANYWAY — see the file header. Nothing in this
  -- build writes folios.status, so no folio is ever settled or closed and this
  -- condition cannot be met. It is reordered now because the shipment that
  -- wires the folio lifecycle should not also have to remember to come back
  -- here: a guard written correctly before it matters costs one migration, and
  -- the same guard remembered later costs a manager standing at a terminal for
  -- nothing.
  select * into v_charge
  from folio_charges
  where tenant_id = v_booking.tenant_id
    and idempotency_key = 'noshow:' || p_booking_id::text
  limit 1;

  if found and v_charge.is_voided is not true then
    select * into v_folio from folios where id = v_charge.folio_id;
    if v_folio.status <> 'open' then
      raise exception
        'This booking''s no-show charge cannot be credited back: its folio is %', v_folio.status
        using errcode = 'check_violation',
              hint = 'Re-open the folio first — a decision with its own audit trail — then reverse the no-show. The status has not been changed.';
    end if;
  end if;

  -- ---- the credential, LAST ----------------------------------------------
  v_manager := verify_manager_pin(v_booking.tenant_id, p_manager_pin);
  if v_manager is null then
    raise exception 'Reversing a no-show always requires a valid manager PIN'
      using errcode = 'insufficient_privilege',
            hint = 'Hand the terminal to a manager. The reversal is recorded against them by name.';
  end if;

  -- --- GUARD 8: THE AVAILABILITY GUARD (§2, §3.2) --------------------------
  -- The no-show RELEASED this room (029 §2), so another booking may hold it now.
  -- Identical treatment to un-cancel: locks the room type, counts every night
  -- under the lock, and RAISES naming the full nights rather than overbooking.
  perform assert_restorable_inventory(v_booking);

  -- --- THE EFFECT, all of it inside this one transaction (§3.6) ------------

  -- The business date (rules 8, 12), resolved in the PROPERTY's timezone exactly
  -- as mark_no_show, record_payment and create_booking do. It is the date the
  -- REVERSAL happens, never the original no-show's date: the booking is restored
  -- TODAY, and today's audit trail is what must show it.
  select p.timezone into v_timezone from properties p where p.id = v_booking.property_id;
  v_date := (now() at time zone coalesce(nullif(btrim(v_timezone), ''), 'Africa/Lagos'))::date;

  -- THE STATUS. Back to 'confirmed' — DECISION 1: the safe, minimal reversal,
  -- and it lets the normal check-in flow run with its arrival-time capture if
  -- the guest is in fact standing at the desk. cancelled_at / cancellation_reason
  -- are not touched (a no-show never set them).
  update bookings
     set status     = 'confirmed',
         updated_by = v_actor
   where id = p_booking_id
  returning * into v_booking;

  -- THE RETENTION CHARGE (§3.4). Found by mark_no_show's deterministic key, which
  -- is the only fact guaranteed about the row.
  select * into v_charge
  from folio_charges
  where tenant_id = v_booking.tenant_id
    and idempotency_key = 'noshow:' || p_booking_id::text
  limit 1;

  if found and v_charge.is_voided is not true then      -- rule 5, NULL-safe
    -- A settled/closed folio takes no counter-posting. reverse_charge refuses it
    -- anyway; this raises the sentence a person can act on, naming the no-show
    -- charge rather than a charge id they would have to go and look up.
    select * into v_folio from folios where id = v_charge.folio_id;
    if v_folio.status <> 'open' then
      raise exception
        'This booking''s no-show charge cannot be credited back: its folio is %', v_folio.status
        using errcode = 'check_violation',
              hint = 'Re-open the folio first — a decision with its own audit trail — then reverse the no-show. The status has not been changed.';
    end if;

    -- THROUGH THE EXISTING ENGINE (DECISION 3). No key passed: reverse_charge
    -- uses its own deterministic 'reversal:charge:<id>', so two keys can never
    -- name one act. If a manager already reversed this charge by hand, its
    -- idempotency-by-state returns THAT reversal and nothing is posted twice.
    v_charge_rev := reverse_charge(
      v_charge.id,
      'No-show reversed — ' || v_reason,
      p_manager_pin,
      null
    );
    v_counter_id := v_charge_rev.counter_entry_id;
  end if;

  -- THE FOLLOW-UP NOTICE (§3.5). Only when one is outstanding; the RPC refuses a
  -- booking with no note at all, so the guard is on the column, not on the call.
  if v_booking.follow_up_note is not null
     and v_booking.follow_up_acknowledged_at is null then
    perform acknowledge_booking_follow_up(p_booking_id, null);
  end if;

  -- THE AUDIT ROW. Written last, so it can name the counter-entry it produced.
  begin
    insert into reversals (
      tenant_id, property_id, reversed_by, approved_by, reason,
      target_type, target_id, counter_entry_id, business_date,
      idempotency_key, created_by
    ) values (
      v_booking.tenant_id, v_booking.property_id, v_actor, v_manager, v_reason,
      -- target_id is THE BOOKING: a no-show has no id of its own — it is a
      -- status ON the booking (031 §1: the target is polymorphic).
      'no_show', p_booking_id, v_counter_id, v_date,
      v_key, v_actor
    )
    returning * into v_reversal;
  exception
    when unique_violation then
      -- A concurrent caller won a race the guard 1 lock should already have
      -- prevented. Return THEIR row — but only if it genuinely exists:
      -- re-raising otherwise aborts the whole call, rolling the status restore
      -- and the charge reversal back with it, so this handler can never leave a
      -- restored booking without its audit row.
      select * into v_existing
      from reversals
      where tenant_id = v_booking.tenant_id
        and (idempotency_key = v_key
             or (target_type = 'no_show' and target_id = p_booking_id))
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
-- SECTION 3 — record_refund: its own sentence, before the credential
-- ############################################################################
CREATE OR REPLACE FUNCTION public.record_refund(p_folio_id uuid, p_amount numeric, p_method text, p_reference text, p_reason text, p_manager_pin text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS folio_payments
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  -- --- 069: A CLOSED FOLIO, SAID AT THE REFUND DOOR ----------------------
  -- record_payment refuses this underneath and keeps refusing it — it owns the
  -- rule and is the floor. What it does NOT own is the sentence: its message is
  -- "Folio % is closed and cannot take payments", which is correct at ITS door
  -- and wrong at this one. Somebody handing money BACK is not taking a payment,
  -- and a refusal that describes the wrong act is the same defect as a hint
  -- naming the wrong remedy.
  --
  -- A DISTINCT ERRCODE, deliberately (rule 27's sixth shape): two layers can
  -- refuse this same act, and PT407 against record_payment's check_violation is
  -- what lets an assertion — or a client — tell which one spoke. Matching on
  -- prose alone could not, and the difference matters: this refusal means the
  -- act was rejected before anything was written, while record_payment's would
  -- mean the PIN had already been verified.
  --
  -- AND IT COMES BEFORE THE PIN, which is the point of this migration. The
  -- folio's status cannot be changed by fetching a manager, so demanding the
  -- credential first spends it on a request that cannot succeed. Before 069 the
  -- order was: ceiling, PIN, then record_payment's closed check — so a manager
  -- walked over, typed their PIN, and was then told the folio was closed.
  --
  -- UNREACHABLE TODAY. Nothing in this build writes folios.status; see the
  -- header.
  if v_folio.status = 'closed' then
    raise exception
      'Folio % is closed, so no money can be refunded from it', p_folio_id
      using errcode = 'PT407',
            hint = 'A closed bill is final and takes no money in either direction. Re-open it first — a decision with its own audit trail — then refund.';
  end if;

  -- --- the credential, LAST ----------------------------------------------
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
$function$
;

-- ############################################################################
-- SECTION 4 — THE SELF-VERIFY, ROLLED BACK
-- ############################################################################
-- Eleven assertions, and they all turn on ONE trick worth naming, because it is
-- what makes a reordering testable at all:
--
--     SEND A WRONG PIN WITH AN ALREADY-IMPOSSIBLE REQUEST. The refusal must be
--     about the ACT. Before this file it was about the CREDENTIAL — the PIN
--     check spoke first on every one of the three — so the assertion goes red
--     against the old order and cannot pass by accident.
--
-- A wrong PIN is deliberately used rather than a right one: with a valid PIN the
-- precondition would refuse either way and the order would be invisible.
--
-- AND TWO OF THE THREE NEED A FOLIO STATUS NOTHING WRITES, so the fixture
-- writes it directly. That is NOT a harness doing what production cannot (rule
-- 27): a closed folio is a legal row — the column exists and its CHECK allows
-- it — and no code path writes it yet. Setting it is reaching a permitted state
-- by the only means currently available, which is the opposite of disabling a
-- guard to get past it.
--
--   1  §1, REACHABLE TODAY: a delivery already reversed, with a WRONG PIN,
--      refuses for being already reversed (PT409) and not for the PIN.
--   2  §1 CONTROL: a FIRST reversal with a wrong PIN still refuses for the PIN
--      (42501). Without this, assertion 1 is equally happy with a function that
--      stopped checking PINs altogether.
--   3  §1 CONTROL: and with the right PIN the reversal still works. A reorder
--      that broke the act would be worse than the order it fixed.
--   4  §2: a no-show whose folio is settled, with a WRONG PIN, refuses for the
--      folio and not for the PIN.
--   5  §2 CONTROL: folio open, wrong PIN -> the PIN refusal.
--   6  §3: a CLOSED folio, with a WRONG PIN, refuses with PT407 naming the
--      REFUND — not 42501, and not record_payment's check_violation.
--   7  §3 CONTROL: folio open, wrong PIN -> the PIN refusal.
--   8  §3: a closed folio with a CORRECT PIN is still refused with PT407, so
--      the check is about the folio rather than about who asked.
--   9  §3 FLOOR: record_payment still refuses a closed folio on its own. The
--      new sentence is the interface; that refusal is what survives if somebody
--      deletes it (067's shape).
--  10  THE SHAPE: all three keep SECURITY DEFINER and a pinned search_path, and
--      stay executable by authenticated and not by anon.
--  11  AND NO SIGNATURE MOVED: exactly one overload of each, so nothing was
--      dropped and no ACL was lost.
do $$
declare
  v_tenant   uuid;
  v_user     uuid;
  v_prop     uuid;
  v_rt       uuid;
  v_guest    uuid;
  v_company  uuid;
  v_receipt  uuid;
  v_bk       bookings;
  v_folio    folios;
  v_folio2   folios;
  v_ok       boolean;
  v_err      text;
  v_state    text;
  v_n        integer;
  v_bad      integer;
  v_fail     text := '';
begin
  begin
    select tu.tenant_id, tu.user_id into v_tenant, v_user
    from tenant_users tu where tu.is_active and tu.role in ('owner','manager') limit 1;
    select p.id into v_prop from properties p where p.tenant_id = v_tenant limit 1;
    if v_tenant is null or v_prop is null then
      raise notice '069 SELF-VERIFY SKIPPED: no tenant or active owner/manager.';
      raise exception 'ZZ_069_FIXTURE_DONE';
    end if;
    perform set_config('request.jwt.claims',
      json_build_object('role','service_role','sub', v_user::text)::text, true);

    -- THIS OVERWRITES A REAL MANAGER'S PIN, and it is only safe because the
    -- ZZ_069_FIXTURE_DONE sentinel below guarantees this block rolls back.
    insert into manager_pins (tenant_id, user_id, pin_hash)
    values (v_tenant, v_user, crypt('4069', gen_salt('bf')))
    on conflict (tenant_id, user_id) do update set pin_hash = excluded.pin_hash;

    select rt.id into v_rt from room_types rt
    where rt.tenant_id = v_tenant and rt.deleted_at is null order by rt.base_rate limit 1;

    -- ===================== 1, 2, 3: THE REACHABLE ONE =====================
    select pr.id into v_receipt
    from purchase_receipts pr
    where pr.tenant_id = v_tenant
      and not exists (select 1 from reversals r
                      where r.tenant_id = pr.tenant_id
                        and r.target_type = 'goods_receipt'
                        and r.target_id = pr.id)
    order by pr.created_at limit 1;
    if v_receipt is null then
      v_fail := v_fail || '1: no un-reversed goods receipt to work with, so the only REACHABLE assertion in this file is vacuous. ';
    else
      -- 2 FIRST, while the delivery is still reversible: a wrong PIN on an act
      -- that IS possible must refuse for the PIN.
      v_ok := false; v_err := null; v_state := null;
      begin
        perform reverse_purchase_receipt(v_receipt, 'ZZ069 control', '0000', 'zz069-rpr-ctl');
        v_ok := true;
      exception when others then v_err := sqlerrm; v_state := sqlstate; end;
      if v_ok or v_err not like '%always requires a valid manager PIN%' then
        v_fail := v_fail || format(
          '2: a first reversal with a WRONG pin was answered by %s rather than the PIN refusal. Assertion 1 proves nothing if the PIN check has simply stopped running. ',
          coalesce(left(v_err, 110), 'success'));
      end if;

      -- 3: and it works with the right one.
      v_ok := false; v_err := null;
      begin
        perform reverse_purchase_receipt(v_receipt, 'ZZ069 the real one', '4069', 'zz069-rpr-ok');
        v_ok := true;
      exception when others then v_err := sqlerrm; end;
      if not v_ok then
        v_fail := v_fail || format(
          '3: reversing a delivery FAILED with a valid PIN (%s). A reorder that breaks the act is worse than the order it fixed. ',
          left(coalesce(v_err, ''), 150));
      else
        -- 1: THE ASSERTION THIS FILE EXISTS FOR. Already reversed, wrong PIN.
        v_ok := false; v_err := null; v_state := null;
        begin
          perform reverse_purchase_receipt(v_receipt, 'ZZ069 again', '0000', 'zz069-rpr-2');
          v_ok := true;
        exception when others then v_err := sqlerrm; v_state := sqlstate; end;
        if v_ok or v_state is distinct from 'PT409'
           or v_err not like '%was already reversed on%' then
          v_fail := v_fail || format(
            '1: a SECOND reversal with a wrong PIN was answered by %s / %s. It must refuse for being already reversed: two people clearing one delivery mistake is the ordinary case, and the old order spent a manager''s walk to say no. ',
            coalesce(v_state, 'success'), coalesce(left(v_err, 120), ''));
        end if;
      end if;
    end if;

    -- ===================== 4, 5: THE NO-SHOW ==============================
    insert into guests (tenant_id, first_name, last_name, created_by)
    values (v_tenant, 'ZZ069', 'No Show', v_user) returning id into v_guest;
    -- BILLED TO A COMPANY, because mark_no_show charges only a GUARANTEED
    -- booking — company_id set, or bill_to 'company' (024 §4). A walk-in
    -- committed nothing and gets no charge, so a walk-in no-show creates no
    -- folio_charge for the hoisted guard to find and the assertion would pass
    -- against any code at all. The first version of this fixture was a walk-in,
    -- and assertion 4 went red against correct code for exactly that reason.
    select c.id into v_company from companies c where c.tenant_id = v_tenant limit 1;
    if v_company is null then
      v_fail := v_fail || '4: no company on this tenant, so a GUARANTEED no-show cannot be built and assertions 4 and 5 are vacuous. ';
    end if;
    v_bk := create_booking(v_prop, v_rt, v_guest, current_date, current_date + 1,
                           1, 'zz069-bk-ns', 0, null, 'company', v_company, null);
    -- BACK-DATED IN THE FIXTURE because mark_no_show refuses a booking whose
    -- arrival has not passed — "a guest can still arrive today", which is right.
    -- create_booking will not take a past arrival, so the only way to reach a
    -- legitimate no-show is to make the stay yesterday's after it exists. A
    -- permitted state reached by the means available, not a guard switched off.
    update bookings set check_in = current_date - 1, check_out = current_date
     where id = v_bk.id;
    update booking_nights set stay_date = current_date - 1
     where booking_id = v_bk.id;
    select * into v_bk from bookings where id = v_bk.id;
    perform mark_no_show(v_bk.id, 'zz069-ns');
    select * into v_folio from folios where booking_id = v_bk.id;

    -- 5 FIRST, folio still open: a wrong PIN must refuse for the PIN.
    v_ok := false; v_err := null;
    begin
      perform reverse_no_show(v_bk.id, 'ZZ069 control', '0000', 'zz069-rns-ctl');
      v_ok := true;
    exception when others then v_err := sqlerrm; end;
    if v_ok or v_err not like '%always requires a valid manager PIN%' then
      v_fail := v_fail || format(
        '5: with the folio OPEN, a wrong pin was answered by %s rather than the PIN refusal. ',
        coalesce(left(v_err, 110), 'success'));
    end if;

    -- 4: now the folio is settled, which nothing in this build does yet.
    update folios set status = 'settled' where id = v_folio.id;
    v_ok := false; v_err := null; v_state := null;
    begin
      perform reverse_no_show(v_bk.id, 'ZZ069 settled', '0000', 'zz069-rns-2');
      v_ok := true;
    exception when others then v_err := sqlerrm; v_state := sqlstate; end;
    if v_ok or v_err not like '%cannot be credited back%' then
      v_fail := v_fail || format(
        '4: a no-show on a SETTLED folio with a wrong pin was answered by %s / %s. It must name the folio: no manager can change a folio''s status by arriving at the terminal. ',
        coalesce(v_state, 'success'), coalesce(left(v_err, 120), ''));
    end if;

    -- ===================== 6, 7, 8, 9: THE REFUND DOOR ====================
    insert into guests (tenant_id, first_name, last_name, created_by)
    values (v_tenant, 'ZZ069', 'Refund', v_user) returning id into v_guest;
    v_folio2 := open_guest_folio(v_tenant, v_prop, v_guest, 'zz069-folio-r');
    perform record_payment(v_folio2.id, 40000, 'cash', 'ZZ069-REF',
                           current_date, 'zz069-pay');

    -- 7 FIRST, folio open: a wrong PIN refuses for the PIN.
    v_ok := false; v_err := null;
    begin
      perform record_refund(v_folio2.id, 1000, 'cash', null, 'ZZ069 control', '0000', 'zz069-rr-ctl');
      v_ok := true;
    exception when others then v_err := sqlerrm; end;
    if v_ok or v_err not like '%A refund always requires a valid manager PIN%' then
      v_fail := v_fail || format(
        '7: with the folio OPEN, a wrong pin was answered by %s rather than the PIN refusal. ',
        coalesce(left(v_err, 110), 'success'));
    end if;

    update folios set status = 'closed', closed_at = now() where id = v_folio2.id;

    -- 6: closed folio, wrong PIN -> PT407, naming the refund.
    v_ok := false; v_err := null; v_state := null;
    begin
      perform record_refund(v_folio2.id, 1000, 'cash', null, 'ZZ069 closed', '0000', 'zz069-rr-2');
      v_ok := true;
    exception when others then v_err := sqlerrm; v_state := sqlstate; end;
    if v_ok or v_state is distinct from 'PT407'
       or v_err not like '%no money can be refunded from it%' then
      v_fail := v_fail || format(
        '6: a refund on a CLOSED folio with a wrong pin was answered by %s / %s. PT407 is distinct from record_payment''s check_violation on purpose, so this cannot pass on the wrong layer''s refusal (rule 27''s sixth shape) — and record_payment''s message describes TAKING a payment, which is the wrong act at this door. ',
        coalesce(v_state, 'success'), coalesce(left(v_err, 120), ''));
    end if;

    -- 8: and with the RIGHT pin it is still PT407. The check is about the
    -- folio, not about who asked.
    v_ok := false; v_state := null;
    begin
      perform record_refund(v_folio2.id, 1000, 'cash', null, 'ZZ069 closed again', '4069', 'zz069-rr-3');
      v_ok := true;
    exception when others then v_state := sqlstate; end;
    if v_ok or v_state is distinct from 'PT407' then
      v_fail := v_fail || format(
        '8: a refund on a closed folio with a VALID pin was answered by %s rather than PT407. ',
        coalesce(v_state, 'success'));
    end if;

    -- 9: THE FLOOR. record_payment refuses a closed folio on its own, so
    -- deleting SECTION 3's sentence loses the wording and not the rule.
    v_ok := false; v_err := null;
    begin
      perform record_payment(v_folio2.id, 500, 'cash', 'ZZ069', current_date, 'zz069-pay-2');
      v_ok := true;
    exception when others then v_err := sqlerrm; end;
    if v_ok or v_err not like '%is closed and cannot take payments%' then
      v_fail := v_fail || format(
        '9: record_payment no longer refuses a closed folio (%s). SECTION 3 is the sentence; this is the floor underneath it. ',
        coalesce(left(v_err, 110), 'success'));
    end if;

    -- ===================== 10, 11: THE SHAPE ==============================
    select count(*)::integer into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('reverse_purchase_receipt','reverse_no_show','record_refund')
      and (not p.prosecdef
           or p.proconfig is null
           or not exists (select 1 from unnest(p.proconfig) cfg where cfg like 'search_path=%')
           or not has_function_privilege('authenticated', p.oid, 'EXECUTE')
           or has_function_privilege('anon', p.oid, 'EXECUTE'));
    if v_bad > 0 then
      v_fail := v_fail || format(
        '10: %s of the three re-emitted functions lost SECURITY DEFINER, lost its pinned search_path, became unreachable to authenticated, or became reachable by anon. Re-emitting from pg_get_functiondef is supposed to make that impossible; this is what says so. ',
        v_bad);
    end if;

    select count(*)::integer into v_n
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('reverse_purchase_receipt','reverse_no_show','record_refund');
    if v_n <> 3 then
      v_fail := v_fail || format(
        '11: there are %s functions with those three names, expected exactly 3. A signature change would have created an overload, and Postgres resolves by argument count — the one a client reached would be whichever survived. ',
        v_n);
    end if;

    if v_fail <> '' then
      raise exception '069 SELF-VERIFY FAILED — %', v_fail;
    end if;

    raise notice '069 SELF-VERIFY: 11 assertions passed.';
    raise exception 'ZZ_069_FIXTURE_DONE';
  exception
    when others then
      if sqlerrm = 'ZZ_069_FIXTURE_DONE' then
        raise notice '069 self-verify complete; fixture rolled back.';
      else
        raise;
      end if;
  end;
end $$;
