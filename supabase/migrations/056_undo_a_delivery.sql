-- ############################################################################
-- 056 — UNDO A DELIVERY
-- ############################################################################
-- A goods receipt is permanent and must stay permanent: it is the record that a
-- delivery happened, and a document a payment will be allocated against cannot
-- be editable afterwards. So undoing one is a REVERSAL — a second document that
-- says the first was wrong — and both stay visible. A delivery that happened and
-- was undone is two facts, not zero.
--
-- WHY THIS MOVED TO THE FRONT OF THE QUEUE. It was scheduled after 1.1h5,
-- because a supplier payment is allocated against what a delivery says arrived.
-- 1.1h3 gave it a second and sharper reason: 052 shipped `expenses` and
-- `fixed_assets` with NO void column at all, deliberately — a column nothing can
-- write is a promise the next person has to keep — so undoing the receipt is now
-- the ONLY correction path a mis-received asset or expense has. A freezer
-- received against the wrong order was permanent until this file.
--
-- ----------------------------------------------------------------------------
-- WHAT IT DOES NOT DO, AND WHY THAT IS NOT AN OVERSIGHT
-- ----------------------------------------------------------------------------
-- IT DOES NOT ADD A REVERSAL COLUMN TO `expenses` OR `fixed_assets`. Each row
-- anchors on `purchase_receipt_line_id`, so "was this reversed" is already
-- answerable by a join: receipt line -> receipt -> reversals. A derived fact
-- cannot drift from the document; a stored one is a second source of truth and a
-- third writable promise on two tables that just had two taken off them. The
-- asset register and the expense list join and mark.
--
-- That leaves 052's header exactly as written. A row created by receiving a
-- delivery is corrected by undoing the delivery — this file. A STANDALONE
-- expense ships with its own void column and its own void path, in the same
-- shipment, because a standalone row has no receipt line to derive anything
-- from.
--
-- 052's assertion 7 pairs a soft-delete column with something able to write it.
-- It cannot see a reversal that lives in a join, so SECTION 8 extends the same
-- idea to the other half of the rule: a record anchored on a receipt line is
-- reversible THROUGH the receipt, asserted by reversing one and reading it back.
-- Without that, the next person reads assertion 7 as the whole rule and concludes
-- these tables still have no way back.
--
-- IT REVERSES A WHOLE RECEIPT, NEVER ONE LINE OF IT. A partial undo of a
-- delivery is indistinguishable in the data from a second, corrected delivery,
-- and it makes the over-receipt question ambiguous — if one line of three is
-- undone, was the delivery over-received or not? The real act is "this delivery
-- note was wrong". If two of three lines were right, undo it and receive those
-- two again. The cost, stated rather than hidden: re-receiving burns a GRN
-- number, which is correct — it is a different delivery note — and is said out
-- loud in the user guide because somebody will ask.
--
-- IT DOES NOT BLOCK BECAUSE THE STOCK HAS GONE. Reversing a receipt whose goods
-- were already issued takes the position negative, and §9 is explicit: negative
-- stock is FLAGGED, never blocked, because blocking an honest correction teaches
-- staff to invent fake receipts, which destroys the ledger far more thoroughly
-- than a negative does. The existing engine does not block on sufficiency and
-- this does not add it.
--
-- IT DOES NOT GUARD AGAINST AN ALLOCATED PAYMENT, BECAUSE THERE ARE NO PAYMENTS
-- YET. 1.1h5 owns both directions of that rule and must ship BOTH:
--   * reversing a receipt that a supplier payment is allocated to is refused —
--     that is money paid for goods that went back;
--   * allocating a payment to a receipt that has been REVERSED is refused — the
--     same mistake arriving from the other side.
-- Writing one half and leaving the other to be reasoned out later is how a rule
-- becomes half a rule. It is named here because this file is where somebody will
-- come looking for it.
--
-- ----------------------------------------------------------------------------
-- THE ORDER'S STATUS, WHICH IS THE PART THAT NEEDED A DECISION
-- ----------------------------------------------------------------------------
-- MEASURED FIRST. 046's transition trigger treats `received` as terminal
-- (`else false`), so before this file all three walk-backs were refused:
--
--     received -> part_received   PT409  "A purchase order cannot go from
--     received -> ordered                 received to part_received."
--     received -> cancelled       hint:  "This order is complete. Raise a new
--                                         order for anything else you need."
--
-- Reverse the receipt that settled an order and the order would have stayed
-- `received` with nothing received — every read corrected and the status beside
-- them a lie, in a hint that tells the reader the order is complete.
--
-- THE THING THAT DECIDED THE FIX: THE STATUS IS ALREADY A DERIVED VALUE. 046's
-- receive computes it from the rows at the moment of the act, and its own comment
-- says why — "never tracked on a counter column that would be a cache with no
-- recompute function (rule 6)". The column is the STORED RESULT of a derivation,
-- not an independent fact. So the fix does not have to choose between trusting a
-- caller and rebuilding the module.
--
-- WHAT WAS REJECTED, BY NAME:
--
--   * Widening the transition table unconditionally. Cheapest, and it makes the
--     status settable directly by any future caller — which is the one rule this
--     module has held from the start.
--   * Widening it behind a session signal the reversal sets (a `set_config` the
--     trigger reads). The trigger would then ask WHO IS CALLING instead of
--     WHETHER THE CLAIM IS TRUE, and a trust token is only as good as every
--     future caller's discipline.
--   * Deriving on read and dropping the column. Right in the abstract, and five
--     views and every status filter wide — not in the shipment whose job is to
--     undo a delivery.
--
-- WHAT IT DOES INSTEAD (SECTIONS 1 AND 2). `v_unsettled` is extracted into
-- `purchase_order_settled_status()`, and the walk-back edges are legal ONLY WHEN
-- THE NEW STATUS EQUALS WHAT THE LINES NOW SAY. The trigger stops trusting the
-- caller and starts checking the claim: nothing can walk a status back to a lie,
-- not a future RPC and not this one. Forward edges are untouched, because the
-- walk-back is the new capability and the new capability carries the new guard.
-- `cancelled` stays terminal and `received -> cancelled` stays refused.
--
-- AND A LATENT BUG CAME OUT OF THE EXTRACTION, which is why it is load-bearing
-- rather than tidy. `v_unsettled` does not exclude reversed receipts, because
-- none could exist. The moment they can: reverse a delivery, receive again, and
-- the reversed delivery's quantities still count toward settlement — the order
-- reads `received` with half of it undelivered. The same lie by a different
-- route, in the FORWARD path, which nothing else in this file would have caught.
-- One expression, three callers (receive, the reversal, and the trigger as its
-- own validator), so the three can never disagree.
--
-- ORDERING INSIDE THE TRANSACTION IS LOAD-BEARING. The `reversals` row is
-- inserted BEFORE the status update, because the derivation reads it. A `stable`
-- function sees the effects of earlier commands in the same transaction, which is
-- exactly enough — and assertion 6 asserts it rather than assuming it.
--
-- ----------------------------------------------------------------------------
-- THE LEDGER, WHICH IS WHERE THIS COULD HAVE GONE QUIETLY WRONG
-- ----------------------------------------------------------------------------
-- The forward path DEFERS its journal: `post_stock_receipt` takes
-- `p_post_journal` and 046's receive passes false, then posts ONE entry for the
-- whole delivery — N debits (inventory, fixed assets, each expense account) and
-- one credit to supplier payable left open so it is the SUM of the debits.
--
-- `post_movement_reversal` had no such flag and called
-- `post_stock_movement_journal` unconditionally, and
-- `stock_movement_counter_role` returns `supplier_payable` for a receipt movement
-- with a supplier. So calling the engine as it stood would have posted a
-- stock-half counter entry PER MOVEMENT while this RPC still owed the non-stock
-- debits and their share of the credit. Both ways out of that are wrong:
--
--   * reverse the whole original entry as well, and the stock half is reversed
--     TWICE;
--   * reverse only the non-stock part, and the credit is split across N+1
--     entries, each rounded to the kobo against an average carried at full
--     precision — the kobo-level disagreement 046 already learned not to assert
--     against.
--
-- THE FIX IS SYMMETRY, NOT ARITHMETIC. `post_movement_reversal` gains
-- `p_post_journal boolean default true` — the same shape `post_stock_receipt`
-- already has — purchasing passes false, and SECTION 6 posts ONE counter entry
-- that is the MIRROR of the original: same accounts, same amounts, sides flipped,
-- `reverses_entry_id` naming it. A mirror nets to zero per account BY
-- CONSTRUCTION. A recomputation nets to zero only if the rounding agrees, and
-- this product's own history says it sometimes legitimately will not.
--
-- The original entry is findable exactly, by `source_document_type =
-- 'goods_receipt'` and the receipt id. A receipt that booked nothing — every line
-- closed short, or dated before `gl_start_date` — has no entry, so this posts
-- none either and the pair stays consistent.
--
-- ----------------------------------------------------------------------------
-- TWO HINTS IN THE DATABASE'S OWN VOICE ARE NOW WRONG, AND FIXING THEM IS PART
-- OF THE SHIPMENT (rule 21)
-- ----------------------------------------------------------------------------
-- `forbid_purchase_receipt_change` says: "To correct what was received, reverse
-- the stock movement it posted." That is the half-measure this file replaces — it
-- moves the stock and leaves the receipt still saying the goods arrived, which is
-- two records disagreeing about one event. And the transition trigger's
-- `received` hint says the order is complete.
--
-- A database telling somebody to do the wrong thing in its own voice is worse
-- than one that says nothing, because rule 21 is why anybody reads the hint at
-- all. Both are rewritten here, in the same file as the thing that makes them
-- wrong.
--
-- ----------------------------------------------------------------------------
-- WHAT IS IN THIS FILE
-- ----------------------------------------------------------------------------
--   1  purchase_order_settled_status()      the derivation, extracted
--   2  enforce_purchase_order_transition()  the walk-back, gated on the data
--   3  receive_purchase_order()             uses the shared derivation
--   4  post_movement_reversal()             gains p_post_journal
--   5  reversals.target_type                admits 'goods_receipt'
--   6  reverse_purchase_receipt()           the RPC
--   7  forbid_purchase_receipt_change()     the hint that is now wrong
--   8  self-verify
--
-- 057 carries the five reads. Same split as 053 -> 054/055: the engine lands
-- first and the views that read it land next, so a view rebuild never sits in
-- the same file as the function whose behaviour it is reporting.
--
-- Every function below that already existed is rebuilt FROM ITS LIVE TEXT, with
-- each substitution asserted to match exactly once and every guard re-asserted by
-- name afterwards: SECURITY DEFINER, the search_path, the `is_tenant_staff` gate,
-- `p_idempotency_key`, `verify_manager_pin`, and the
-- `select m.id from post_stock_receipt(...) m` form that must never become
-- `(post_stock_receipt(...)).id` — which Postgres expands to one call per output
-- column, posting the line about twenty times.
-- ############################################################################

-- ############################################################################
-- WHAT THE BREAKAGES WENT RED FOR (rule 27)
-- ############################################################################
-- Fourteen mutations, each valid SQL that changes behaviour, each applied in a
-- rolled-back transaction. All fourteen red. What they reported:
--
--   A  the derivation counts a reversed delivery toward settlement
--        -> 3: after reversing one of two deliveries the order reads received
--   B  the v_standing branch dropped
--        -> 1: with every delivery reversed the order reads part_received
--   C  the walk-back stops checking the deliveries
--        -> 2: an order with two standing deliveries was walked back to ordered
--   D  the walk-back edges never offered
--        -> PT409 at the call site: "A purchase order cannot go from received to
--           part_received." No assertion reports this one, and that is correct:
--           the reversal itself becomes impossible, so the file dies at the act
--           rather than in a report.
--   E  the status recomputed BEFORE the reversals row exists
--        -> 3: after reversing one of two deliveries the order reads received
--   F  the receipt reversal lets every movement post its own entry
--        -> 5: expected 4 entries, found 6; the pair does not net to zero
--           (1300 net -3000.00, 2000 net 3000.00)
--   G  the mirror does not flip the sides
--        -> 5: the pair does not net to zero (1300 net 6000.00)
--   H  the mirror does not name the entry it unwinds
--        -> 5: no reverses_entry_id
--   I  the idempotency return dropped
--        -> 6: a retry under the same key was REFUSED
--   J  the already-reversed guard dropped
--        -> 7: refused, but not by name
--   K  reverse_stock_movement stops refusing a delivery's movement
--        -> 8: a delivery's stock movement was reversed on its own
--   L  p_post_journal defaults to FALSE
--        -> 9: reversing a manual receipt posted 0 counter entries
--   M  the goods_receipt counter constraint not added
--        -> 11: a goods_receipt reversal was allowed to name a counter row
--   N  the five-argument post_movement_reversal left beside the new one
--        -> 42725 "function post_movement_reversal(...) is not unique" at the
--           first call. Assertion 11 counts the overloads and would also catch
--           it, but the ambiguity bites first, which is the louder failure.
--
-- ----------------------------------------------------------------------------
-- AND WHAT THE BREAKAGE RUN FOUND IN THE ASSERTIONS THEMSELVES, WHICH IS THE
-- PART WORTH READING
-- ----------------------------------------------------------------------------
-- THE FIRST RUN HAD F GREEN AT 11 OF 11 — the mutation that reverses the stock
-- half of the LEDGER TWICE, which is the single most consequential defect this
-- file can contain. Assertion 5 scoped its entry count and its netting to
-- journal entries whose source document is one of the two receipts, and a
-- per-movement entry is sourced on the MOVEMENT. So the extra entries were
-- invisible to the count and their lines were invisible to the netting, and the
-- proof said nothing was wrong while the general ledger was out by the value of
-- the stock. Rule 27's second shape exactly: a total that is insensitive to the
-- rule that produced it. The set now covers the receipts, their movements and
-- the counters of those movements.
--
-- E WAS GREEN TOO, AND FOR A SILLIER REASON: the mutation meant to move the
-- status update above the reversals insert instead DUPLICATED it, leaving
-- wrong-update, insert, right-update — and the second one corrected the first.
-- A breakage that proves nothing is the same failure as an assertion that
-- cannot fail, and it also arrives looking like diligence.
--
-- TWO ASSERTIONS WERE GOING RED BY DYING RATHER THAN BY REPORTING. With the
-- idempotency return dropped, the unwrapped retry killed the block with
-- "already reversed" and assertion 6 never said what it was testing; with 7.2's
-- guard dropped, assertion 8 recorded the failure and then the fixture ran four
-- assertions further and died on the belt-and-braces guard, naming THAT. Both
-- are red either way, and both would have been read as a different bug. The
-- retry is wrapped and assertion 8 stops the run — and the stop is a flag read
-- after the block, because a `raise` inside it would have been caught by its own
-- `exception when others` and reported as "refused with P0001 rather than
-- PT409", which is an assertion lying about itself.
--
-- ONE ASSERTION COULD NOT HAVE FAILED AT ALL. Assertion 4 compared the counter
-- movement's cost against the ORIGINAL's carried_unit_cost — which is NULL on a
-- receipt, because carried_unit_cost is what stock going OUT takes with it. The
-- basis of an incoming movement is its unit_cost. And even corrected, the
-- fixture could not have told the right valuation from the wrong one, because
-- the moving average still stood at the receipt's own cost: §6 and 038 exist to
-- stop a reversal being valued at the CURRENT average, and those two numbers
-- were the same number. A manual receipt at 250 now moves the average off 100
-- before the reversal, and the fixture RAISES ON ITSELF if they ever coincide
-- again.
--
-- ONE MORE, FOUND BY THE FIRST DRY RUN: assertion 11 demanded
-- `search_path=public` exactly, and reported that receive_purchase_order had
-- "lost SECURITY DEFINER or its search_path in the rebuild". It had not —
-- receive legitimately carries `public, extensions`, because it reaches crypt()
-- through verify_manager_pin. A guard that fails on a correct function in the
-- ALARMING direction costs a day chasing a defect that was never there, and it
-- feels like diligence while it is happening (checklist item 13). It now asserts
-- what actually matters: a search_path is pinned, and public is in it.
-- ############################################################################


-- ############################################################################
-- SECTION 1 — THE DERIVATION, EXTRACTED
-- ############################################################################
-- 046's receive computed this inline and said why it was computed rather than
-- counted on a column: "never tracked on a counter column that would be a cache
-- with no recompute function (rule 6)". It is extracted here UNCHANGED in
-- meaning and with ONE addition — a receipt that has been reversed does not
-- count toward settlement — because three callers now need the same answer and
-- three copies of it would be three answers the day one of them is edited:
--
--   * receive_purchase_order, which sets the status forward (SECTION 3);
--   * reverse_purchase_receipt, which sets it back (SECTION 6);
--   * enforce_purchase_order_transition, which VALIDATES the claim (SECTION 2).
--
-- The third is the one that matters. Because the trigger checks the new status
-- against this function, the status cannot be walked back to a lie by anything —
-- including by the RPC in this same file.
--
-- STABLE, not IMMUTABLE: it reads tables, and it must see the effects of earlier
-- commands in the transaction that is reversing a receipt. That is exactly what
-- STABLE gives (the statement's own snapshot) and what IMMUTABLE would forbid.
--
-- SECURITY DEFINER because the trigger calls it, and a trigger firing for a
-- member must be able to count rows the member can read anyway. It takes an id
-- and returns a word; there is nothing here to leak across a tenant.
create or replace function purchase_order_settled_status(p_purchase_order_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_lines      integer;
  v_unsettled  integer;
  v_standing   integer;
begin
  select count(*)::integer into v_lines
  from purchase_order_lines ol
  where ol.purchase_order_id = p_purchase_order_id;

  -- An order with no lines cannot be placed (save_purchase_order refuses one),
  -- so this is unreachable through the product. It is answered anyway, and
  -- answered 'ordered' rather than 'received', because `count(*) = 0` unsettled
  -- lines out of zero lines is the one input on which the honest reading and the
  -- catastrophic one coincide.
  if v_lines = 0 then
    return 'ordered';
  end if;

  -- A LINE IS SETTLED when everything ordered has arrived, or when a receipt
  -- line closed it short. 056: only a receipt that STILL STANDS counts for
  -- either, which is the whole reason this is a function and not a copy.
  select count(*)::integer into v_unsettled
  from purchase_order_lines ol
  where ol.purchase_order_id = p_purchase_order_id
    and not exists (
      select 1
      from purchase_receipt_lines rl
      join purchase_receipts pr on pr.id = rl.purchase_receipt_id
      where rl.purchase_order_line_id = ol.id
        and rl.closed_short
        and not exists (
          select 1 from reversals r
          where r.tenant_id   = pr.tenant_id
            and r.target_type = 'goods_receipt'
            and r.target_id   = pr.id
        )
    )
    and coalesce((
      select sum(rl.quantity)
      from purchase_receipt_lines rl
      join purchase_receipts pr on pr.id = rl.purchase_receipt_id
      where rl.purchase_order_line_id = ol.id
        and not exists (
          select 1 from reversals r
          where r.tenant_id   = pr.tenant_id
            and r.target_type = 'goods_receipt'
            and r.target_id   = pr.id
        )
    ), 0) < ol.quantity;

  if v_unsettled = 0 then
    return 'received';
  end if;

  -- SOMETHING OUTSTANDING AND NOTHING STANDING MEANS 'ordered', NOT
  -- 'part_received'. Reverse the only delivery an order ever had and it is back
  -- to being an order nobody has delivered against — which is what the receiving
  -- screen needs to believe to let it be received again.
  select count(*)::integer into v_standing
  from purchase_receipt_lines rl
  join purchase_receipts pr on pr.id = rl.purchase_receipt_id
  where pr.purchase_order_id = p_purchase_order_id
    and not exists (
      select 1 from reversals r
      where r.tenant_id   = pr.tenant_id
        and r.target_type = 'goods_receipt'
        and r.target_id   = pr.id
    );

  if v_standing = 0 then
    return 'ordered';
  end if;

  return 'part_received';
end;
$$;

comment on function purchase_order_settled_status(uuid) is
  'THE ONE DEFINITION of how much of an order has been delivered: ordered '
  '(nothing standing), part_received (something standing, something outstanding) '
  'or received (every line delivered or closed short). Counts only receipts that '
  'have NOT been reversed. Called by receive_purchase_order to set the status '
  'forward, by reverse_purchase_receipt to set it back, and by '
  'enforce_purchase_order_transition to VALIDATE either — which is what makes the '
  'status unable to be a lie rather than merely unlikely to be one. STABLE so it '
  'sees the reversals row written earlier in the same transaction.';


-- ############################################################################
-- SECTION 2 — THE WALK-BACK, GATED ON THE DATA RATHER THAN ON THE CALLER
-- ############################################################################
-- 046's graph ended `else false  -- received and cancelled are terminal`, and
-- the hint told the reader "This order is complete." Both were true until a
-- receipt could be undone.
--
-- THE FORWARD EDGES ARE UNTOUCHED, VERBATIM. The walk-back is the new
-- capability, so the walk-back carries the new guard; widening a path that works
-- is scope this file does not need.
--
-- THE THREE NEW EDGES, and each is legal ONLY when the lines agree:
--
--     received      -> part_received     one of several deliveries reversed
--     received      -> ordered           the only delivery reversed
--     part_received -> ordered            the only delivery reversed
--
-- WHAT "AGREE" MEANS, AND WHY IT IS THE WHOLE POINT. The trigger does not ask
-- who is calling. It asks whether the claim is TRUE — whether the new status is
-- the one `purchase_order_settled_status()` computes from the receipts that still
-- stand. A caller that tries to walk a status back while a delivery is still
-- standing is refused, by the data. That keeps the rule this module has held
-- since 046: the status is not settable directly by anything except the act that
-- earns it. The alternative considered and rejected was a session signal the
-- reversal sets and the trigger trusts, which answers "who" instead of
-- "whether", and is only ever as good as the discipline of every caller written
-- after it.
--
-- `cancelled` stays terminal, and `received -> cancelled` stays refused:
-- cancelling an order that was delivered and then undone is not a correction, it
-- is two different decisions, and the second one is "raise a new order".
create or replace function enforce_purchase_order_transition()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_legal     boolean;
  v_walk_back boolean;
  v_derived   text;
begin
  -- ---- the graph -----------------------------------------------------------
  if new.status is distinct from old.status then
    v_legal := case old.status
                 when 'draft'         then new.status in ('ordered', 'cancelled')
                 when 'ordered'       then new.status in ('part_received', 'received', 'cancelled')
                 when 'part_received' then new.status in ('received', 'cancelled')
                 else false                      -- received and cancelled are terminal
               end;

    -- ---- 056: THE WALK-BACK, WHICH THE DELIVERIES HAVE TO AGREE WITH -------
    if not v_legal then
      v_walk_back :=
        (old.status = 'received' and new.status in ('part_received', 'ordered'))
        or (old.status = 'part_received' and new.status = 'ordered');

      if v_walk_back then
        v_derived := purchase_order_settled_status(new.id);

        if v_derived = new.status then
          v_legal := true;
        else
          -- NOT the generic "cannot go from X to Y". This one knows the real
          -- answer and says it, because the person reading it is looking at a
          -- screen that disagrees with the database and needs to know which way
          -- round the disagreement goes.
          raise exception
            'This order cannot be marked % — the deliveries that still stand say %.',
            new.status, v_derived
            using errcode = 'PT409',
                  hint = 'An order walks its status back only when a delivery has been reversed, and only as far as the remaining deliveries add up to. Reverse the delivery and the status follows.';
        end if;
      end if;
    end if;

    if not v_legal then
      raise exception
        'A purchase order cannot go from % to %.', old.status, new.status
        using errcode = 'PT409',
              hint = case old.status
                       -- 056: the old hint said "This order is complete. Raise a
                       -- new order for anything else you need." That was true
                       -- while a receipt could not be undone; now it sends
                       -- somebody to raise a second order for goods they are
                       -- holding and want to send back.
                       when 'received'  then 'A completed order is not edited. If a delivery against it was wrong, reverse that delivery — the order and its figures then follow by themselves.'
                       when 'cancelled' then 'This order was cancelled. Raise a new one rather than reviving it.'
                       else 'Send the order first, then receive against it.'
                     end;
    end if;
  end if;

  -- ---- immutability, once it has been sent --------------------------------
  -- The columns below are WHAT THE SUPPLIER WAS TOLD. Changing any of them after
  -- the order went out means the paper in the supplier's hand and the record in
  -- the system are two different documents, and the receiving screen would then
  -- be comparing a delivery against an order nobody sent.
  if old.status <> 'draft' then
    if new.supplier_id is distinct from old.supplier_id
       or new.destination_location_id is distinct from old.destination_location_id
       or new.order_date is distinct from old.order_date
       or new.expected_date is distinct from old.expected_date
       or new.order_number is distinct from old.order_number
       or new.property_id is distinct from old.property_id
       or new.tenant_id is distinct from old.tenant_id then
      raise exception
        'Purchase order % has already been sent, so what was ordered cannot be changed.',
        old.order_number
        using errcode = 'PT409',
              hint = 'Cancel it and raise a new order, or record what actually arrived when it does — the difference is what the receiving screen is for.';
    end if;
  end if;

  return new;
end;
$$;

comment on function enforce_purchase_order_transition() is
  'THE STATUS GRAPH AND THE IMMUTABILITY, at the database. A CHECK sees one row; '
  '"you cannot go back to draft" and "a sent order''s supplier cannot change" '
  'are statements about two, so they are a trigger or they are nothing. Not left '
  'to the RPCs because the RPCs are three today and will be five, and the '
  'guarantee — the order I approved is the order that was sent — must not depend '
  'on all of them remembering. 056: a status may also walk BACK, when a delivery '
  'has been reversed, and only to the value purchase_order_settled_status() '
  'computes from the receipts that still stand. The trigger checks the claim, not '
  'the caller, so no RPC — including the one that reverses — can set a status the '
  'deliveries do not support.';

drop trigger if exists enforce_purchase_order_transition_trigger on purchase_orders;
create trigger enforce_purchase_order_transition_trigger
  before update on purchase_orders
  for each row execute function enforce_purchase_order_transition();

revoke all on function enforce_purchase_order_transition() from public, anon, authenticated;
revoke all on function purchase_order_settled_status(uuid)   from public, anon, authenticated;


-- ############################################################################
-- SECTION 3 — receive_purchase_order USES THE SHARED DERIVATION
-- ############################################################################
-- Rebuilt from its live text; the inline count is the only thing that changed.
-- Every other guard is carried through and asserted present by SECTION 8.
CREATE OR REPLACE FUNCTION public.receive_purchase_order(p_purchase_order_id uuid, p_business_date date, p_lines jsonb, p_delivery_note text, p_invoice_number text, p_note text, p_idempotency_key text, p_manager_pin text DEFAULT NULL::text, p_reason text DEFAULT NULL::text)
 RETURNS purchase_receipts
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_order       purchase_orders;
  v_tenant      uuid;
  v_timezone    text;
  v_today       date;
  v_date        date;
  v_digest      text;
  v_existing    purchase_receipts;
  v_receipt     purchase_receipts;
  v_number      text;
  v_kind        text;
  v_locname     text;
  v_supplier    text;
  v_reason      text;
  v_manager     uuid;
  v_over        boolean := false;
  v_line        jsonb;
  v_line_id     uuid;
  v_qty         numeric;
  v_cost        numeric;
  v_closed      boolean;
  v_lreason     text;
  v_outstanding numeric;
  v_ordered     numeric;
  v_itemname    text;
  v_unit        text;
  v_item        uuid;
  v_tracks      boolean;
  v_batch       text;
  v_expiry      date;
  v_n           integer := 0;
  v_movement_id uuid;
  v_ltype       text;
  v_ldesc       text;
  v_lcat        uuid;
  v_lrole       text;
  v_rl_id       uuid;
  v_moves_stock boolean := false;
  v_amount      numeric(14,2);
  v_seen        uuid[] := '{}';
  v_debits      jsonb := '[]'::jsonb;
  v_total       numeric(14,2) := 0;
begin
  -- ---- the order ----------------------------------------------------------
  select * into v_order from purchase_orders where id = p_purchase_order_id for update;
  if not found then
    raise exception 'Purchase order % not found', p_purchase_order_id using errcode = 'PT404';
  end if;

  v_tenant := v_order.tenant_id;

  if not is_tenant_staff(v_tenant) then
    raise exception 'Not authorised to receive deliveries for this property'
      using errcode = 'insufficient_privilege';
  end if;

  -- ---- idempotency, with the payload check --------------------------------
  v_digest := md5(jsonb_build_object(
    'order',    p_purchase_order_id,
    'date',     p_business_date,
    'lines',    coalesce(p_lines, '[]'::jsonb),
    'delivery', nullif(btrim(coalesce(p_delivery_note, '')), ''),
    'invoice',  nullif(btrim(coalesce(p_invoice_number, '')), ''),
    'note',     nullif(btrim(coalesce(p_note, '')), ''),
    'reason',   nullif(btrim(coalesce(p_reason, '')), '')
  )::text);

  if p_idempotency_key is not null then
    select * into v_existing
    from purchase_receipts
    where tenant_id = v_tenant and idempotency_key = p_idempotency_key
    limit 1;

    if found then
      if v_existing.idempotency_digest is distinct from v_digest then
        raise exception
          'This request reuses the key of goods receipt %, but records a different delivery.',
          v_existing.receipt_number
          using errcode = 'PT409',
                hint = 'Nothing has been received. Reload the order and enter the delivery again — a retry must send exactly what the first attempt sent, or it is a second delivery and needs its own key.';
      end if;
      return v_existing;
    end if;
  end if;

  -- ---- the order's state --------------------------------------------------
  if v_order.status not in ('ordered', 'part_received') then
    raise exception 'Purchase order % is %, so nothing can be received against it.',
      v_order.order_number, v_order.status
      using errcode = 'PT409',
            hint = case v_order.status
                     when 'draft'     then 'Send the order to the supplier first.'
                     when 'received'  then 'Everything on it has already arrived or been closed short.'
                     else 'This order was cancelled. Raise a new one for anything that still needs buying.'
                   end;
  end if;

  -- ---- the date -----------------------------------------------------------
  select p.timezone into v_timezone from properties p where p.id = v_order.property_id;
  v_today := (now() at time zone coalesce(nullif(btrim(v_timezone), ''), 'Africa/Lagos'))::date;
  v_date  := coalesce(p_business_date, v_today);

  if v_date > v_today then
    raise exception 'A delivery cannot be dated in the future (today is % at this property)', v_today
      using errcode = 'PT422';
  end if;

  -- Checked HERE as well as inside post_stock_receipt, because a receipt whose
  -- every line is a close-short posts no movement at all and would otherwise
  -- slip into a closed period unchecked.
  perform assert_posting_open(v_order.property_id, v_date);

  -- ---- the destination — THE EQUIVALENCE ----------------------------------
  select l.kind, l.name into v_kind, v_locname
  from locations l
  where l.id = v_order.destination_location_id
    and l.property_id = v_order.property_id
    and l.deleted_at is null
    and l.is_active = true;

  if v_kind is null then
    raise exception 'The location this order was going to is no longer available'
      using errcode = 'PT404',
            hint = 'Switch it back on in Locations, then record the delivery.';
  end if;

  select s.name into v_supplier from suppliers s where s.id = v_order.supplier_id;

  v_reason := nullif(btrim(coalesce(p_reason, '')), '');

  -- ---- the lines, validated BEFORE anything is written --------------------
  if p_lines is null or jsonb_typeof(p_lines) <> 'array'
     or jsonb_array_length(p_lines) = 0 then
    raise exception 'Record what actually arrived — at least one line'
      using errcode = 'PT422',
            hint = 'Enter the quantity for each line that came. Leave out the ones that did not.';
  end if;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_n       := v_n + 1;
    v_line_id := nullif(btrim(coalesce(v_line ->> 'purchase_order_line_id', '')), '')::uuid;

    -- 053: a LEFT join, and the type comes with it.
    --
    -- THIS JOIN WAS THE WHOLE REASON AN ASSET LINE COULD NOT BE RECEIVED.
    -- It was an inner join to inventory_items, and an asset or expense line
    -- has no inventory_item_id -- so the row vanished, v_ordered came back
    -- null, and the function reported 'Line % is not on purchase order %'.
    -- A line that was plainly on the order was refused for not existing,
    -- which is the least helpful true-sounding error a screen can show.
    select ol.quantity, ol.inventory_item_id, ol.line_type, ol.description,
           ol.expense_category_id,
           coalesce(i.name, ol.description), i.base_unit, i.tracks_expiry
      into v_ordered, v_item, v_ltype, v_ldesc, v_lcat,
           v_itemname, v_unit, v_tracks
    from purchase_order_lines ol
    left join inventory_items i on i.id = ol.inventory_item_id
    where ol.id = v_line_id
      and ol.purchase_order_id = v_order.id;

    if v_ordered is null then
      raise exception 'Line % is not on purchase order %.', v_n, v_order.order_number
        using errcode = 'PT404';
    end if;

    -- THE SAME LINE TWICE IN ONE DELIVERY. The unique index would catch it as a
    -- raw 23505 halfway through writing the receipt; catching it here refuses
    -- the whole delivery before anything is written, and says which item.
    if v_line_id = any(v_seen) then
      raise exception '% appears twice in this delivery.', v_itemname
        using errcode = 'PT422',
              hint = 'Add the two quantities together into one line. Two rows for one item would double the stock and the invoice.';
    end if;
    v_seen := v_seen || v_line_id;

    -- What is still outstanding on this line, across every earlier delivery.
    select v_ordered - coalesce(sum(rl.quantity), 0)
      into v_outstanding
    from purchase_receipt_lines rl
    where rl.purchase_order_line_id = v_line_id;

    v_qty    := (v_line ->> 'quantity')::numeric;
    v_closed := coalesce((v_line ->> 'closed_short')::boolean, false);
    v_lreason := nullif(btrim(coalesce(v_line ->> 'reason', '')), '');

    if v_qty is null or v_qty < 0 then
      raise exception '%: enter how much arrived. Zero is allowed, a negative is not.', v_itemname
        using errcode = 'PT422',
              hint = 'To send stock back, reverse the movement the delivery posted — a delivery is never negative.';
    end if;

    -- QUANTITY ZERO REQUIRES closed_short.
    if v_qty = 0 and not v_closed then
      raise exception '%: a delivery of nothing has to say that nothing more is coming.', v_itemname
        using errcode = 'PT422',
              hint = 'Tick "nothing more coming" to close this line short, or leave the line out of this delivery altogether if you are still expecting it.';
    end if;

    -- ANY DIFFERENCE NEEDS A REASON.
    if v_qty <> v_outstanding and v_lreason is null then
      raise exception
        '%: % was outstanding and % arrived, so this delivery needs a reason.',
        v_itemname,
        format_stock_quantity(v_outstanding),
        format_stock_quantity(v_qty)
        using errcode = 'PT422',
              hint = 'A word is enough — "part delivery, rest Friday", "short on the truck". It is what the short-delivery report reads.';
    end if;

    -- AN OVER-RECEIPT ADDITIONALLY NEEDS A MANAGER PIN.
    if v_qty > v_outstanding then
      v_over := true;
    end if;

    v_cost := (v_line ->> 'unit_cost')::numeric;
    if v_cost is null or v_cost < 0 then
      raise exception '%: enter what the invoice says one % cost.', v_itemname, coalesce(v_unit, 'unit')
        using errcode = 'PT422',
              hint = 'It is what moves this item''s average cost, so it is the invoiced price and not what you expected to pay.';
    end if;

    -- The batch rule, checked here as well so a whole delivery is refused before
    -- any of it is written rather than halfway down the list.
    v_batch  := nullif(btrim(coalesce(v_line ->> 'batch_code', '')), '');
    v_expiry := nullif(btrim(coalesce(v_line ->> 'expiry_date', '')), '')::date;
    if v_qty > 0 and v_tracks and (v_batch is null or v_expiry is null) then
      raise exception
        '%: this item is tracked by batch, so its batch code and expiry date are both required.',
        v_itemname
        using errcode = 'PT422',
              hint = 'They are on the packaging. Without them a recall cannot tell which stock came from which delivery.';
    end if;

    -- 053: REFUSED, NOT IGNORED, the same way this function already refuses
    -- a manager PIN offered where none is needed. A batch code typed against
    -- a plumber's call-out means the person is on the wrong line, and
    -- swallowing it would let them finish the delivery believing otherwise.
    if v_ltype <> 'inventory' and (v_batch is not null or v_expiry is not null) then
      raise exception '%: a % line has no batch or expiry.', v_itemname, v_ltype
        using errcode = 'PT422',
              hint = 'Only stock is tracked by batch, because only stock is counted and recalled. Clear those two boxes, or check you are on the right line.';
    end if;

    -- Does ANY of this delivery actually move stock? The manager gate below
    -- turns on it, so it is computed here while every line is in hand.
    if v_ltype = 'inventory' and v_qty > 0 then
      v_moves_stock := true;
    end if;
  end loop;

  -- ---- the manager --------------------------------------------------------
  -- ONE verification for both cases. A delivery that is both over-received AND
  -- into a bar is one decision by one manager, not two.
  -- 053: THE DESTINATION HALF OF THIS GATE IS ABOUT STOCK, NOT ABOUT
  -- DELIVERIES. Section 9's rule is that goods reach a kitchen or a bar by
  -- being ISSUED from the store -- it is about stock arriving outside the
  -- store, and nothing else. Before this, the gate read v_kind <> 'store'
  -- alone, so an order containing only a chest freezer and a plumber's
  -- call-out, against an order whose destination happened to be the bar,
  -- demanded a manager's PIN and a written reason for a delivery that moves
  -- no stock at all -- and then listed it on the stock provenance report,
  -- where a freezer is not stock and never was.
  --
  -- THE OVER-RECEIPT HALF IS UNCHANGED AND APPLIES TO EVERY TYPE: accepting
  -- more than was ordered commits the hotel to paying for it, and that is
  -- as true of two freezers as of two bags of rice.
  if v_over or (v_kind <> 'store' and v_moves_stock) then
    if v_kind <> 'store' and v_moves_stock and v_reason is null then
      raise exception
        'Stock is received into a store, not into %. Goods reach a kitchen or a bar by being issued from the store.',
        v_locname
        using errcode = 'PT403',
              hint = 'If this delivery genuinely went straight there, a manager can authorise it with their PIN and a reason. It will be listed on the stock provenance report.';
    end if;

    v_manager := verify_manager_pin(v_tenant, p_manager_pin);
    if v_manager is null then
      if v_over then
        raise exception
          'More arrived than was ordered, so a manager has to authorise accepting it.'
          using errcode = 'insufficient_privilege',
                hint = 'Hand the terminal to a manager. Accepting more than was ordered commits the hotel to paying for it, and the authorisation is recorded against them by name.';
      else
        raise exception 'Receiving stock somewhere other than a store requires a valid manager PIN'
          using errcode = 'insufficient_privilege',
                hint = 'Hand the terminal to a manager. The receipt is recorded against them by name, and appears on the stock provenance report.';
      end if;
    end if;
  elsif p_manager_pin is not null then
    -- Refused rather than ignored, exactly as post_stock_receipt refuses it:
    -- accepting it silently would record an authorisation against a manager for
    -- a delivery that needed none.
    raise exception 'No manager PIN is needed for this delivery.'
      using errcode = 'PT422',
            hint = 'A PIN authorises accepting more than was ordered, or a delivery going somewhere other than a store. This is neither.';
  end if;

  -- ---- the receipt --------------------------------------------------------
  v_number := next_document_number(v_tenant, v_order.property_id, 'goods_receipt', 'GRN');

  begin
    insert into purchase_receipts (
      tenant_id, property_id, purchase_order_id, receipt_number,
      business_date, location_id, delivery_note, invoice_number, note,
      reason, authorised_by, idempotency_key, idempotency_digest, created_by
    ) values (
      v_tenant, v_order.property_id, v_order.id, v_number,
      v_date, v_order.destination_location_id,
      nullif(btrim(coalesce(p_delivery_note, '')), ''),
      nullif(btrim(coalesce(p_invoice_number, '')), ''),
      nullif(btrim(coalesce(p_note, '')), ''),
      v_reason, v_manager, p_idempotency_key, v_digest, auth.uid()
    )
    returning * into v_receipt;
  exception
    when unique_violation then
      select * into v_existing
      from purchase_receipts
      where tenant_id = v_tenant and idempotency_key = p_idempotency_key
      limit 1;
      if found then
        return v_existing;
      end if;
      raise;
  end;

  -- ---- the movements, one statement each ---------------------------------
  -- ONE MOVEMENT PER STATEMENT is not a style choice: set_stock_carried_cost is
  -- STABLE and reads the statement's snapshot (038 SECTION 6.2), and this loop
  -- also recomputes the moving average delivery line by delivery line.
  v_n := 0;
  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_n       := v_n + 1;
    v_line_id := (v_line ->> 'purchase_order_line_id')::uuid;
    v_qty     := (v_line ->> 'quantity')::numeric;
    v_cost    := round((v_line ->> 'unit_cost')::numeric, 2);
    v_closed  := coalesce((v_line ->> 'closed_short')::boolean, false);
    v_lreason := nullif(btrim(coalesce(v_line ->> 'reason', '')), '');
    v_batch   := nullif(btrim(coalesce(v_line ->> 'batch_code', '')), '');
    v_expiry  := nullif(btrim(coalesce(v_line ->> 'expiry_date', '')), '')::date;

    -- 053: the same left join, plus the role key this line's cost posts to.
    -- An expense line's account is resolved from its CATEGORY (rule 4), so a
    -- hotel that repoints 'expense_repairs' moves every past and future
    -- repair with it. An asset posts to the 'fixed_assets' key, which the
    -- chart already carries.
    select ol.inventory_item_id, ol.line_type, ol.description,
           ol.expense_category_id,
           coalesce(i.name, ol.description), i.base_unit,
           case ol.line_type
             when 'inventory' then 'inventory'
             when 'asset'     then 'fixed_assets'
             else (select c.role_key from expense_categories c
                    where c.id = ol.expense_category_id)
           end
      into v_item, v_ltype, v_ldesc, v_lcat, v_itemname, v_unit, v_lrole
    from purchase_order_lines ol
    left join inventory_items i on i.id = ol.inventory_item_id
    where ol.id = v_line_id;

    -- A category that resolves to nothing is refused HERE rather than
    -- posting an entry with a null role key, which post_journal would reject
    -- with a message about the journal instead of about this line.
    if v_lrole is null then
      raise exception '%: this expense line has no category, so it has nowhere to post.', v_itemname
        using errcode = 'PT422',
              hint = 'Reopen the order and choose what kind of expense it is. The category decides the account.';
    end if;

    v_movement_id := null;

    if v_qty > 0 and v_ltype = 'inventory' then
      -- THE DESTINATION EQUIVALENCE, made structural: stock reaches the ledger
      -- through the SAME function a hand-keyed delivery uses, so every rule it
      -- enforces is enforced here without being restated.
      --
      -- The PIN is passed ONLY when the destination is not a store, because
      -- post_stock_receipt refuses a PIN offered where none is needed — and an
      -- over-receipt into a store needs the manager's authorisation on the
      -- RECEIPT, which is where it is recorded.
      -- `select ... from f(...) m`, NEVER `(f(...)).id`: Postgres expands the
      -- latter to one call per output column, which would post this delivery
      -- line about twenty times (and mostly return the idempotent replay, which
      -- is what makes it invisible).
      select m.id into v_movement_id from post_stock_receipt(
        v_order.property_id,
        v_order.destination_location_id,
        v_item,
        v_qty,
        v_cost,
        v_date,
        v_supplier,
        format('%s against %s', v_receipt.receipt_number, v_order.order_number),
        'purchase_receipt:' || v_receipt.id::text || ':' || v_line_id::text,
        v_batch,
        v_expiry,
        case when v_kind <> 'store' then p_manager_pin end,
        case when v_kind <> 'store' then v_reason end,
        'purchase',
        'purchase_receipt',
        v_receipt.id,
        false                       -- the GRN posts ONE entry for the delivery
      ) m;
    end if;

    -- 053: line_type is written onto the receipt line, and the row returns
    -- its id because the expense or asset it creates anchors on it.
    insert into purchase_receipt_lines (
      tenant_id, purchase_receipt_id, purchase_order_line_id, line_number,
      line_type, quantity, unit_cost, closed_short, reason,
      batch_code, expiry_date, note, stock_movement_id, created_by
    ) values (
      v_tenant, v_receipt.id, v_line_id, v_n,
      v_ltype, v_qty, v_cost, v_closed, v_lreason,
      v_batch, v_expiry,
      nullif(btrim(coalesce(v_line ->> 'note', '')), ''),
      v_movement_id,
      auth.uid()
    ) returning id into v_rl_id;

    -- WHAT A NON-STOCK LINE LEAVES BEHIND. Stock leaves a movement; an
    -- expense leaves a row in expenses and an asset a row in fixed_assets.
    -- All three anchor on this receipt line, uniquely, so receiving the same
    -- line twice cannot make two of anything -- the same job
    -- stock_movement_id does for stock.
    --
    -- A CLOSE-SHORT OF NOTHING RECORDS NOTHING: zero arrived, so there is no
    -- expense and no asset, exactly as there is no movement.
    if v_qty > 0 and v_ltype = 'expense' then
      insert into expenses (
        tenant_id, property_id, business_date, expense_category_id,
        supplier_id, description, amount, purchase_receipt_line_id,
        note, created_by
      ) values (
        v_tenant, v_order.property_id, v_date, v_lcat,
        v_order.supplier_id, v_ldesc, round(v_qty * v_cost, 2), v_rl_id,
        format('%s against %s', v_receipt.receipt_number, v_order.order_number),
        auth.uid()
      );
    elsif v_qty > 0 and v_ltype = 'asset' then
      -- ONE ROW PER RECEIPT LINE, at the line's total, and the quantity is
      -- said in the name when it is more than one. Ten chairs bought
      -- together are one register entry here, because the uniqueness that
      -- makes a repeated receive safe is per receipt LINE. If per-unit rows
      -- are ever wanted -- a serial number each, depreciated separately --
      -- the anchor has to become (receipt line, unit number) and that is a
      -- schema change, not something to fake by dropping the constraint.
      insert into fixed_assets (
        tenant_id, property_id, name, description, acquired_on, cost,
        supplier_id, purchase_order_id, purchase_receipt_line_id,
        note, created_by
      ) values (
        v_tenant, v_order.property_id,
        case when v_qty > 1
             then format('%s x %s', format_stock_quantity(v_qty), v_ldesc)
             else v_ldesc end,
        v_ldesc, v_date, round(v_qty * v_cost, 2),
        v_order.supplier_id, v_order.id, v_rl_id,
        format('%s against %s', v_receipt.receipt_number, v_order.order_number),
        auth.uid()
      );
    end if;

    -- The journal debit for this line, built from what was just written.
    v_amount := round(v_qty * v_cost, 2);
    if v_amount > 0 then
      v_total  := v_total + v_amount;
      -- 053: the role key is this line's own, so one delivery can debit
      -- inventory, fixed assets and two different expense accounts and
      -- still post ONE entry. The credit is left open below, so it remains
      -- the sum of whatever the debits came to.
      --
      -- The description drops the unit for a non-stock line, because there
      -- is no base unit to name -- 'Plumber call-out — 1 at 25,000.00'
      -- rather than a stray double space where a kilogram would have been.
      v_debits := v_debits || jsonb_build_object(
        'role_key',    v_lrole,
        'side',        'debit',
        'amount',      v_amount,
        'description', case when v_ltype = 'inventory'
          then format('%s — %s %s at %s',
                      v_itemname, format_stock_quantity(v_qty),
                      coalesce(v_unit, ''),
                      to_char(v_cost, 'FM999,999,999,990.00'))
          else format('%s — %s at %s',
                      v_itemname, format_stock_quantity(v_qty),
                      to_char(v_cost, 'FM999,999,999,990.00'))
        end
      );
    end if;
  end loop;

  -- ---- the order's new state ---------------------------------------------
  -- 056: THE SHARED DERIVATION. This was computed inline here, and it did not
  -- know that a reversed receipt should not count -- because before 056 no
  -- receipt could be reversed. Left inline it would have become wrong in the
  -- FORWARD direction the day the first reversal landed: reverse a delivery,
  -- receive against the order again, and the reversed delivery would still
  -- have counted toward settlement, marking the order received with half of it
  -- undelivered. One expression, three callers, so the three cannot disagree.
  update purchase_orders
     set status     = purchase_order_settled_status(v_order.id),
         updated_by = auth.uid()
   where id = v_order.id;

  -- ---- ONE ENTRY ----------------------------------------------------------
  -- N debits to inventory, one credit to supplier_payable LEFT OPEN so it is the
  -- SUM of the debits rather than a second total that can disagree by a kobo.
  --
  -- A receipt whose every line is a close-short books nothing: no goods arrived,
  -- so nothing is owed and nothing entered stock.
  if v_total > 0 then
    perform post_journal(
      v_order.property_id,
      v_date,
      format('Goods received — %s against %s, %s',
             v_receipt.receipt_number, v_order.order_number,
             coalesce(v_supplier, 'supplier')),
      'goods_receipt',
      v_receipt.id,
      v_debits || jsonb_build_object(
        'role_key',    'supplier_payable',
        'side',        'credit',
        'description', coalesce(nullif(btrim(coalesce(p_invoice_number, '')), ''),
                                v_receipt.receipt_number)
      ),
      null,
      null
    );
  end if;

  return v_receipt;
end;
$function$;

-- ############################################################################
-- SECTION 4 — post_movement_reversal GAINS p_post_journal
-- ############################################################################
-- Rebuilt from its live text. The only changes are the new parameter and the
-- `if` around the journal call; every guard — the manager, the reason, the
-- reversal-of-a-reversal refusal, the opening-balance refusal, the cost basis,
-- the stranding check, the idempotency return and the permanent reversals row —
-- is carried through untouched and asserted present by SECTION 8.
--
-- THE DROP IS NOT OPTIONAL. `create or replace function` with a different
-- argument list creates an OVERLOAD rather than replacing anything: the
-- five-argument copy would still be there, every existing five-argument call
-- would keep resolving to it, and this file's edit would apply to a function
-- nobody calls. Assertion 11 counts the overloads for exactly this reason.
--
-- The two existing callers — reverse_stock_movement and reverse_stock_take —
-- pass five arguments and are deliberately NOT edited: they resolve to the new
-- function, the default supplies true, and their behaviour is identical.
-- Assertion 9 proves that by reversing a manual receipt and reading the ledger,
-- rather than by reasoning about it.
drop function if exists post_movement_reversal(uuid, text, uuid, uuid, text);

CREATE OR REPLACE FUNCTION public.post_movement_reversal(p_movement_id uuid, p_reason text, p_approved_by uuid, p_actor uuid, p_idempotency_key text, p_post_journal boolean DEFAULT true)
 RETURNS stock_movements
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_original stock_movements;
  v_counter  stock_movements;
  v_existing stock_movements;
  v_reason   text;
  v_timezone text;
  v_date     date;
  v_basis    numeric;
  v_qty      numeric;
  v_blocker  text;
begin
  if p_approved_by is null then
    raise exception 'A reversal cannot be posted without the manager who approved it'
      using errcode = 'insufficient_privilege',
            hint = 'This is an internal guard: the caller must verify a manager PIN first.';
  end if;

  v_reason := btrim(coalesce(p_reason, ''));
  if v_reason = '' then
    raise exception 'A reversal needs a reason'
      using errcode = 'PT422',
            hint = 'It is recorded permanently against your name and the approving manager''s.';
  end if;

  select * into v_original
  from stock_movements
  where id = p_movement_id
  for update;

  if not found then
    raise exception 'Stock movement % not found', p_movement_id
      using errcode = 'PT404';
  end if;

  select * into v_existing
  from stock_movements
  where reverses_movement_id = p_movement_id
  limit 1;
  if found then
    raise exception
      'This movement was already reversed on %. A movement is reversed once, ever.',
      to_char(v_existing.business_date, 'DD Mon YYYY')
      using errcode = 'PT409',
            hint = 'The stock is already back where it started. Post a fresh movement if it needs to move again.';
  end if;

  if v_original.movement_type = 'reversal' then
    raise exception 'This movement is itself a reversal and cannot be reversed'
      using errcode = 'PT409',
            hint = 'The stock is already back where it started. Post a fresh adjustment if it needs to move again.';
  end if;

  if v_original.movement_type = 'opening' then
    raise exception
      'An opening balance cannot be reversed — it is the starting line of this item''s history in this location.'
      using errcode = 'PT409',
            hint = 'Post an adjustment for the difference instead. Before anything else has moved, the average still equals the opening cost, so an adjustment unwinds it exactly.';
  end if;

  select p.timezone into v_timezone
  from properties p where p.id = v_original.property_id;
  v_date := (now() at time zone coalesce(nullif(btrim(v_timezone), ''), 'Africa/Lagos'))::date;

  perform assert_posting_open(v_original.property_id, v_date);

  if v_original.quantity > 0 then
    v_basis := v_original.unit_cost;
  else
    v_basis := v_original.carried_unit_cost;
  end if;

  if v_basis is null then
    raise exception
      'This movement has no recorded cost, so reversing it would have to guess what the stock was worth.'
      using errcode = 'PT422',
            hint = 'Post an adjustment stating the cost explicitly instead.';
  end if;

  v_qty := - v_original.quantity;

  if v_qty > 0 then
    select case
             when l.deleted_at is not null then 'the location "' || l.name || '" has been removed'
             when not l.is_active          then 'the location "' || l.name || '" is switched off'
           end
      into v_blocker
    from locations l
    where l.id = v_original.location_id;

    if v_blocker is null then
      select case
               when i.deleted_at is not null then 'the item "' || i.name || '" has been removed from the catalogue'
               when not i.is_active          then 'the item "' || i.name || '" is switched off'
             end
        into v_blocker
      from inventory_items i
      where i.id = v_original.inventory_item_id;
    end if;

    if v_blocker is not null then
      raise exception
        'Reversing this movement would put stock back, but % — and stock there could not then be counted, corrected or moved.',
        v_blocker
        using errcode = 'PT409',
              hint = 'Switch it back on (or restore it) first, then reverse the movement.';
    end if;
  end if;

  begin
    insert into stock_movements (
      tenant_id, property_id, location_id, inventory_item_id,
      movement_type, quantity, unit_cost, carried_unit_cost,
      business_date, reason, note, source,
      source_document_type, source_document_id,
      reverses_movement_id, batch_code, expiry_date,
      idempotency_key, created_by
    ) values (
      v_original.tenant_id, v_original.property_id,
      v_original.location_id, v_original.inventory_item_id,
      'reversal',
      v_qty,
      case when v_qty > 0 then round(v_basis, 2) else null end,
      v_basis,
      v_date,
      v_reason,
      format('Reversal of the %s of %s dated %s',
             v_original.movement_type,
             format_stock_quantity(v_original.quantity),
             to_char(v_original.business_date, 'DD Mon YYYY')),
      'reversal',
      'stock_movement', p_movement_id,
      p_movement_id,
      -- 046 NOTE, because it looks like an omission and is not: the counter row
      -- deliberately does NOT copy the original's supplier or reason_code.
      -- 043's shape check is an EQUIVALENCE — a reason_code appears on a wastage
      -- row and on no other — so copying one here would refuse the reversal of
      -- every write-off. That is exactly why stock_movement_counter_role
      -- RECURSES to the original rather than reading the counter's own columns.
      v_original.batch_code, v_original.expiry_date,
      p_idempotency_key, p_actor
    )
    returning * into v_counter;
  exception
    when unique_violation then
      select * into v_existing
      from stock_movements
      where reverses_movement_id = p_movement_id
         or (tenant_id = v_original.tenant_id and idempotency_key = p_idempotency_key)
      limit 1;
      if found then
        return v_existing;
      end if;
      raise;
  end;

  insert into reversals (
    tenant_id, property_id, reversed_by, approved_by, reason,
    target_type, target_id, counter_entry_id, business_date,
    idempotency_key, created_by
  ) values (
    v_original.tenant_id, v_original.property_id, p_actor, p_approved_by, v_reason,
    'stock_movement', p_movement_id, v_counter.id, v_date,
    p_idempotency_key, p_actor
  );

  -- 046: THE COUNTER-ENTRY. Names the entry it unwinds through
  -- reverses_entry_id when that entry exists — it may not, if the original was
  -- dated before gl_start_date and booked nothing, in which case this books
  -- nothing either and the pair is consistent.
  --
  -- 056: ONE CALLER PASSES FALSE, AND IT IS reverse_purchase_receipt. A
  -- purchase delivery posts ONE entry for the whole receipt, so undoing it
  -- posts ONE mirror entry — not one per movement, which would split the
  -- supplier-payable credit across N+1 entries each rounded to the kobo
  -- against an average carried at full precision.
  --
  -- PASSING FALSE WITHOUT POSTING AN ENTRY YOURSELF LEAVES THE LEDGER SHORT
  -- BY THE VALUE OF THE STOCK, WITH NOTHING ANYWHERE TO SHOW IT. The movement
  -- reverses, the position is right, every stock screen agrees, and the
  -- general ledger is quietly wrong — surfacing later as a reconciliation
  -- difference nobody can source back to an act. There is no guard that can
  -- catch it, because posting the entry is work this function can no longer
  -- see. If you add a second caller that passes false, the counter entry is
  -- YOUR job, in the same transaction, or you have introduced that hole.
  if p_post_journal then
    perform post_stock_movement_journal(v_counter.id);
  end if;

  return v_counter;
end;
$function$;

comment on function post_movement_reversal(uuid, text, uuid, uuid, text, boolean) is
  'THE ONE IMPLEMENTATION of reversing a stock movement: the state guards, the '
  'cost basis, the stranding guard, the counter-movement, the permanent reversals '
  'row and — 046 — the COUNTER-ENTRY in the ledger. Never an edit and never a '
  'deletion: both entries stay visible and the pair nets to zero, which is what '
  'an audit trail is. It does NOT verify a PIN — the CALLER does, and passes the '
  'manager it verified. REVOKED from every client role: it is a PIN-gated act '
  'with the PIN taken out. 056: p_post_journal defaults to TRUE and only '
  'reverse_purchase_receipt passes false, because a delivery posts one entry for '
  'the whole receipt and so does its reversal. A caller that passes false and '
  'does not post an entry itself leaves the ledger short by the value of the '
  'stock, with nothing anywhere to show it.';

revoke all on function post_movement_reversal(uuid, text, uuid, uuid, text, boolean)
  from public, anon, authenticated;

-- ############################################################################
-- SECTION 5 — reversals ADMITS A GOODS RECEIPT
-- ############################################################################
-- 031 declared the whole vocabulary up front so later parts would not have to
-- ALTER this constraint; 038 added 'stock_movement' anyway, because a stock
-- ledger was not on 031's list. Same here, and the same way — the full list is
-- restated rather than appended to, so the file reads as the vocabulary rather
-- than as a diff.
alter table reversals drop constraint if exists reversals_target_type_check;
alter table reversals
  add constraint reversals_target_type_check
  check (target_type in (
    'payment',          -- 031
    'charge',           -- 032
    'discount',         -- 032
    'no_show',          -- 033
    'cancel',           -- 033
    'checkout',         -- 034
    'stock_movement',   -- 038
    'goods_receipt'     -- 056
  ));

-- A GOODS RECEIPT REVERSAL HAS NO SINGLE COUNTER ROW, AND THAT IS ASSERTED
-- RATHER THAN LEFT TO READ AS AN OMISSION. `counter_entry_id` means "the counter
-- row in the target's own domain": a folio_payments row for a 'payment', a
-- stock_movements row for a 'stock_movement'. Undoing a delivery produces N
-- counter movements and ONE counter journal entry, so there is no single row of
-- the same kind to point at — exactly the case 031's own comment anticipated
-- when it left the column nullable.
--
-- The constraint forbids filling it, which stops the obvious future mistake:
-- putting the mirror entry's id in a column that means something else in every
-- other row of this table. The mirror is findable the way every other entry is,
-- by source_document_type = 'goods_receipt_reversal' and the receipt's id.
do $$
begin
  if not exists (select 1 from pg_constraint
                 where conname = 'reversals_receipt_counter_check') then
    alter table reversals
      add constraint reversals_receipt_counter_check
      check (target_type <> 'goods_receipt' or counter_entry_id is null);
  end if;
end $$;


-- ############################################################################
-- SECTION 6 — reverse_purchase_receipt
-- ############################################################################
-- THE WHOLE DELIVERY, IN ONE TRANSACTION, TOUCHING EVERY STORE TOGETHER
-- (rule 7): the stock movements go back through the one engine that knows how to
-- value a reversal, the ledger gets ONE mirror entry, the order's status is
-- recomputed from what still stands, and the permanent `reversals` row records
-- who did it, which manager approved it and why. Nothing is edited and nothing is
-- deleted — the delivery stays on record, and so does its undoing.
--
-- IT VERIFIES THE PIN ITSELF and passes the manager it verified down to
-- post_movement_reversal, which deliberately does not verify one (its comment
-- says so: "It does NOT verify a PIN — the CALLER does"). One PIN entry for one
-- act, however many movements that act turns out to involve.
--
-- THE ORDER OF OPERATIONS IS LOAD-BEARING, and assertion 6 is about exactly
-- this: the `reversals` row is written BEFORE the status is recomputed, because
-- `purchase_order_settled_status()` decides what still stands by reading that
-- row. Written the other way round, the status would be computed as though the
-- delivery were still good — and it would be wrong in the reassuring direction,
-- leaving an order reading `received` with its goods sent back.
--
-- WHAT IT REFUSES, AND THE ONE STATE IT CANNOT CORRECT:
--
--   * a delivery already reversed — answered as a sentence naming the date, not
--     as a 23505 naming `reversals_target_uniq`. The index is the floor, not the
--     interface.
--   * a delivery whose stock was already put back on its own, movement by
--     movement, from the item ledger. SECTION 7 closes that door going forward —
--     `reverse_stock_movement` now refuses a movement that arrived on a delivery
--     and sends the user here — but data written before this file could already
--     be in that state, so it is detected and refused BY NAME rather than
--     half-reversed. It cannot occur on live: the only receipt that exists is
--     GRN-000002 and its movements have never been reversed outside a
--     rolled-back transaction. The honest statement of the limitation: such a
--     delivery's document stays as it was, because mirroring an entry that has
--     already been partly countered means attributing entry lines back to
--     receipt lines, and the entry does not carry that. A path that cannot be
--     tested except by fixture, for a state that cannot arise, is worse than a
--     refusal that says so.
create or replace function reverse_purchase_receipt(
  p_purchase_receipt_id uuid,
  p_reason              text,
  p_manager_pin         text,
  p_idempotency_key     text
)
returns reversals
language plpgsql
security definer
set search_path = public
as $$
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

  v_manager := verify_manager_pin(v_tenant, p_manager_pin);
  if v_manager is null then
    raise exception 'Reversing a delivery always requires a valid manager PIN'
      using errcode = 'insufficient_privilege',
            hint = 'Hand the terminal to a manager. The reversal is recorded against them by name.';
  end if;

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
$$;

comment on function reverse_purchase_receipt(uuid, text, text, text) is
  'Undoes a whole goods receipt as a DOCUMENT: the counter movements through '
  'post_movement_reversal (valued at the basis they unwind), ONE mirror journal '
  'entry, the order''s status recomputed from the deliveries that still stand, '
  'and a permanent reversals row naming the staff member, the approving manager '
  'and the reason. Never one line of a delivery — a partial undo is '
  'indistinguishable from a second corrected delivery. Verifies the manager PIN '
  'itself and passes the manager down, because post_movement_reversal '
  'deliberately does not. Writes the reversals row BEFORE recomputing the '
  'status, because the derivation reads it.';

revoke all on function reverse_purchase_receipt(uuid, text, text, text) from public, anon;
grant execute on function reverse_purchase_receipt(uuid, text, text, text) to authenticated;


-- ############################################################################
-- SECTION 7 — THE TWO PLACES THE DATABASE WAS TELLING PEOPLE THE WRONG THING
-- ############################################################################
-- Rule 21 is why anybody reads a hint at all: the message carries the rule and
-- the hint carries the way out, and the client is forbidden from authoring
-- either. The price of that is that a hint which goes stale is not a typo — it is
-- the product's instruction, in the database's own voice, and nothing errors when
-- it starts being wrong.
--
-- Both of these were true until this file and are false after it. They are
-- rewritten HERE, in the same migration as the thing that makes them false,
-- because a follow-up commit for the sentence is a follow-up commit nobody
-- schedules.

-- ----------------------------------------------------------------------------
-- 7.1 THE RECEIPT IS STILL PERMANENT — the hint just stops recommending the
--     half-measure
-- ----------------------------------------------------------------------------
-- It said: "To correct what was received, reverse the stock movement it posted."
-- That moves the stock and leaves the receipt still saying the goods arrived,
-- which is two records disagreeing about one event — the thing this module exists
-- to prevent, recommended by the module.
create or replace function forbid_purchase_receipt_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    -- The cascade exception, detected exactly as 036/044 detect it.
    if tg_table_name = 'purchase_receipt_lines'
       and not exists (select 1 from purchase_receipts r where r.id = old.purchase_receipt_id) then
      return old;
    end if;
    if tg_table_name = 'purchase_receipts'
       and not exists (select 1 from purchase_orders o where o.id = old.purchase_order_id) then
      return old;
    end if;
  end if;

  raise exception
    'A goods receipt is permanent — it is the record that a delivery happened.'
    using errcode = 'PT403',
          hint = 'To undo what was received, reverse the delivery. The stock, the order and the supplier balance then move together, and both facts stay visible — which is what an audit trail is for.';
end;
$$;

comment on function forbid_purchase_receipt_change() is
  'Refuses every UPDATE and DELETE on a goods receipt and its lines, apart from '
  'the cascade of a hard-deleted parent. Same rule as stock_movements and '
  'journal_entries: the delivery happened, and a document a payment will be '
  'allocated against must not be editable afterwards. Corrections go through '
  'reverse_purchase_receipt (056), which posts the counter movements and the '
  'counter entry and leaves both documents standing.';

-- ----------------------------------------------------------------------------
-- 7.2 AND THE HALF-MEASURE ITSELF IS CLOSED
-- ----------------------------------------------------------------------------
-- `reverse_stock_movement` would happily reverse a movement that arrived on a
-- delivery: it has no idea where the stock came from, and until this file it was
-- the only correction that existed, which is why the hint above recommended it.
-- Leaving it open after shipping the real path would leave two ways to undo one
-- event, one of which silently desynchronises the purchasing module from the
-- stock ledger — and it is the easier of the two to reach, because the item
-- ledger is where somebody looking at a wrong quantity ends up.
--
-- It now refuses, by name, and says where to go. This also makes SECTION 6's
-- belt-and-braces guard unreachable for anything written from here on.
--
-- NOTE THE DIRECTION OF THE GUARD: it keys on source_document_type, which
-- 046's receive sets to 'purchase_receipt' when it calls post_stock_receipt. A
-- manual receipt typed into the item ledger has source 'manual' and is
-- unaffected — that stock has no delivery document behind it, so the movement
-- IS the record and reversing the movement is the whole correction.

CREATE OR REPLACE FUNCTION public.reverse_stock_movement(p_movement_id uuid, p_reason text, p_manager_pin text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS stock_movements
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_original stock_movements;
  v_existing stock_movements;
  v_manager  uuid;
  v_key      text;
  v_actor    uuid := auth.uid();
begin
  select * into v_original from stock_movements where id = p_movement_id;
  if not found then
    raise exception 'Stock movement % not found', p_movement_id
      using errcode = 'PT404';
  end if;

  if not is_tenant_staff(v_original.tenant_id) then
    raise exception 'Not authorised to reverse stock movements for this property'
      using errcode = 'insufficient_privilege';
  end if;

  -- IDEMPOTENCY, BY AN EXPLICIT KEY ONLY (038 §7 GUARD 3). A key the CALLER
  -- supplied means "this is one request of mine, possibly retried" — returning
  -- the first counter is right. Asking to reverse the same movement again with
  -- no key is a DIFFERENT act, and the honest answer is that it was already
  -- reversed, on such-and-such a day.
  v_key := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  if v_key is not null then
    select * into v_existing
    from stock_movements
    where tenant_id = v_original.tenant_id
      and idempotency_key = v_key
    limit 1;
    if found then
      return v_existing;
    end if;
  else
    v_key := 'reversal:' || p_movement_id::text;
  end if;

  -- The friendly state checks (see the header) — the helper is the guard.
  select * into v_existing
  from stock_movements
  where reverses_movement_id = p_movement_id
  limit 1;
  if found then
    raise exception
      'This movement was already reversed on %. A movement is reversed once, ever.',
      to_char(v_existing.business_date, 'DD Mon YYYY')
      using errcode = 'PT409',
            hint = 'The stock is already back where it started. Post a fresh movement if it needs to move again.';
  end if;

  if v_original.movement_type = 'reversal' then
    raise exception 'This movement is itself a reversal and cannot be reversed'
      using errcode = 'PT409',
            hint = 'The stock is already back where it started. Post a fresh adjustment if it needs to move again.';
  end if;

  -- 056: STOCK THAT ARRIVED ON A DELIVERY GOES BACK BY REVERSING THE DELIVERY.
  -- Reversing the movement alone puts the stock back and leaves the receipt,
  -- the order status, the outstanding quantities and the supplier balance all
  -- still saying the goods arrived — two records disagreeing about one event,
  -- which is the thing this module exists to prevent. Until 056 it was the only
  -- correction that existed, which is why the receipt trigger used to recommend
  -- it; now there is a real path and this one is closed.
  --
  -- Keyed on source_document_type, which 046 sets when receive calls
  -- post_stock_receipt. A receipt typed straight into the item ledger has source
  -- 'manual' and is unaffected: that stock has no delivery document behind it, so
  -- the movement IS the record and reversing it is the whole correction.
  if v_original.source_document_type = 'purchase_receipt' then
    raise exception
      'This stock arrived on a delivery, so it goes back by reversing the delivery rather than the movement by itself.'
      using errcode = 'PT409',
            hint = 'Open the delivery on the purchase order and reverse it there. The stock, the order and the supplier balance then move together, and the delivery stays on record as something that happened and was undone.';
  end if;

  if v_original.movement_type = 'opening' then
    raise exception
      'An opening balance cannot be reversed — it is the starting line of this item''s history in this location.'
      using errcode = 'PT409',
            hint = 'Post an adjustment for the difference instead. Before anything else has moved, the average still equals the opening cost, so an adjustment unwinds it exactly.';
  end if;

  if btrim(coalesce(p_reason, '')) = '' then
    raise exception 'A reversal needs a reason'
      using errcode = 'PT422',
            hint = 'It is recorded permanently against your name and the approving manager''s.';
  end if;

  -- A MANAGER PIN. ALWAYS. NO THRESHOLD. There is no quantity of stock at which
  -- erasing a recorded movement is routine — reversal is the power to erase.
  v_manager := verify_manager_pin(v_original.tenant_id, p_manager_pin);
  if v_manager is null then
    raise exception 'Reversing a stock movement always requires a valid manager PIN'
      using errcode = 'insufficient_privilege',
            hint = 'Hand the terminal to a manager. The reversal is recorded against them by name.';
  end if;

  return post_movement_reversal(p_movement_id, p_reason, v_manager, v_actor, v_key);
end;
$function$;

revoke all on function reverse_stock_movement(uuid, text, text, text) from public, anon;
grant execute on function reverse_stock_movement(uuid, text, text, text) to authenticated;

-- ############################################################################
-- SECTION 8 — SELF-VERIFY
-- ############################################################################
-- NAME THE DEFECT EACH ONE TURNS RED (rule 27). An assertion that cannot
-- distinguish working from absent is decoration, and a green run then buys
-- confidence it did not earn.
--
--   1  the derivation answers all THREE states, and 'ordered' is one of them
--      RED if reversals are not excluded, and RED SEPARATELY if the v_standing
--      branch is dropped — a fully-reversed order would then read
--      'part_received', which is the plausible defect and the one a fixture that
--      only reverses one of two deliveries cannot see. Both cases are built.
--
--   2  a walk-back the deliveries do NOT support is REFUSED
--      RED if the `v_derived = new.status` gate is dropped. Asserted on the side
--      of the boundary where the two rules disagree: a supported walk-back
--      succeeds under the true rule AND under the broken one, so asserting only
--      that would stay green. This attempts 'ordered' while a delivery stands.
--
--   3  the order's status follows the reversal, end to end
--      RED if the status update is dropped, and RED if the reversals insert is
--      moved AFTER it — the derivation would then still see the delivery as
--      standing and leave the order 'received' with its goods sent back. That
--      ordering has no separate assertion because this is the assertion for it;
--      breakage F is what proves it.
--
--   4  the stock goes back, at the basis it unwinds
--      RED if the movement loop is dropped. Asserted on the counter movement's
--      carried_unit_cost and on the position returning to what it was, not on a
--      row count: a count of 1 is insensitive to the value.
--
--   5  ONE mirror entry, and the pair nets to ZERO ON EVERY ACCOUNT
--      RED if p_post_journal is left true (per-movement entries appear, the
--      entry count rises and inventory stops netting), if the mirror omits a
--      line, or if the sides are not flipped. The entry COUNT is asserted
--      beside the netting because either alone can be fooled: a count of 2 says
--      nothing about the amounts, and netting could in principle be reached by
--      two wrong entries that cancel.
--
--   6  a retry under the SAME key returns the SAME row and reverses nothing
--      twice
--      RED if the idempotency lookup is dropped — the second call then raises
--      "already reversed", which is a refusal where the interface promises a
--      quiet yes. Asserted on the id AND on the counts, because returning the
--      right row while having written a second set of movements would pass on
--      the id alone.
--
--   7  a DIFFERENT key on the same receipt is refused as a SENTENCE
--      RED if the already-reversed guard is dropped: the unique index then
--      raises 23505 naming `reversals_target_uniq`, which is a constraint name
--      where rule 21 requires a rule and a way out. Asserted on the SQLSTATE
--      being PT409, not merely on something having been refused.
--
--   8  reverse_stock_movement refuses a movement that arrived on a delivery
--      RED if 7.2's guard is dropped. This is the half-measure the old hint
--      recommended, and leaving it reachable would leave two ways to undo one
--      event.
--
--   9  AND THE EXISTING CALLERS ARE UNTOUCHED, BY NAME
--      post_movement_reversal's new parameter defaults to true, so a manual
--      receipt reversed from the item ledger still posts its own counter entry.
--      RED if the default is flipped to false — which is the one edit in this
--      file that could silently empty the general ledger for housekeeping, stock
--      takes and write-offs alike, and would show up nowhere else in here.
--
--  10  the authorisation that happened is still on the record afterwards
--      RED if the receipt were edited rather than reversed. The receipt row is
--      permanent by trigger, so this asserts the consequence of that: after the
--      reversal, authorised_by and the reason are still there to answer for.
--      The other half — that the delivery HISTORY still shows it while the
--      over-receipt alarm no longer does — belongs to 057, where those views
--      live, and is asserted there.
--
--  11  the shape: SECURITY DEFINER, the search_path, the tenant gate, the new
--      parameter's default, and both new constraints
--      RED if a rebuild from live text silently dropped a guard. Read out of the
--      catalog rather than trusted, because every function in SECTIONS 2, 3, 4
--      and 7 was reassembled from its live definition.
do $$
declare
  v_tenant   uuid;
  v_user     uuid;
  v_prop     uuid;
  v_loc      uuid;
  v_item     uuid;
  v_item2    uuid;
  v_sup      uuid;
  v_order    purchase_orders;
  v_order2   purchase_orders;
  v_lines    jsonb;
  v_l1       uuid;
  v_l2       uuid;
  v_receipt  purchase_receipts;
  v_receipt2 purchase_receipts;
  v_rev      reversals;
  v_rev2     reversals;
  v_mv       uuid;
  v_mv2      uuid;
  v_cmv      uuid;
  v_docs     uuid[];
  v_avg      numeric(14,4);
  v_status   text;
  v_before   numeric(14,4);
  v_after    numeric(14,4);
  v_basis    numeric(14,4);
  v_n        integer;
  v_bad      text;
  v_state    text;
  v_msg      text;
  v_ok       boolean;
  v_fail     text := '';
begin
  begin
    -- A REAL user who is an owner or a manager, because verify_manager_pin
    -- refuses anybody else's PIN and created_by references auth.users.
    select tu.tenant_id, tu.user_id into v_tenant, v_user
    from tenant_users tu
    where tu.is_active and tu.role in ('owner', 'manager')
    limit 1;

    select p.id into v_prop from properties p where p.tenant_id = v_tenant limit 1;

    perform set_config('request.jwt.claims',
      json_build_object('role', 'service_role', 'sub', v_user::text)::text, true);

    select l.id into v_loc from locations l
      where l.property_id = v_prop and l.kind = 'store' limit 1;

    select i.id into v_item from inventory_items i
      where i.tenant_id = v_tenant and i.deleted_at is null and i.is_active
      order by i.name limit 1;
    select i.id into v_item2 from inventory_items i
      where i.tenant_id = v_tenant and i.deleted_at is null and i.is_active
        and i.id <> v_item
      order by i.name limit 1;

    if v_loc is null or v_item is null or v_item2 is null then
      raise exception '056 SELF-VERIFY could not build its fixture (store=%, items=%/%)',
        v_loc, v_item, v_item2;
    end if;

    -- A PIN this fixture knows. Inside a transaction that rolls itself back, so
    -- the real manager's PIN is restored with everything else.
    insert into manager_pins (tenant_id, user_id, pin_hash)
    values (v_tenant, v_user, crypt('4057', gen_salt('bf')))
    on conflict (tenant_id, user_id) do update set pin_hash = excluded.pin_hash;

    insert into suppliers (tenant_id, name, code)
    values (v_tenant, 'ZZ056 fixture supplier', 'ZZ056') returning id into v_sup;

    -- ======================================================================
    -- FIXTURE A — TWO STOCK LINES, DELIVERED IN TWO GOES
    -- Built this way on purpose: it is the only shape in which 'ordered' and
    -- 'part_received' are DIFFERENT answers, so the v_standing branch of the
    -- derivation can be told apart from its absence.
    -- ======================================================================
    v_order := save_purchase_order(
      v_prop, null, v_sup, current_date, current_date + 1, v_loc,
      'ZZ056 two-line order',
      jsonb_build_array(
        jsonb_build_object('line_type', 'inventory',
          'inventory_item_id', v_item,  'quantity', 10, 'unit_cost', 100),
        jsonb_build_object('line_type', 'inventory',
          'inventory_item_id', v_item2, 'quantity', 4,  'unit_cost', 500)),
      'zz056-order-1');

    select id into v_l1 from purchase_order_lines
      where purchase_order_id = v_order.id and line_number = 1;
    select id into v_l2 from purchase_order_lines
      where purchase_order_id = v_order.id and line_number = 2;

    perform place_purchase_order(v_order.id, 'zz056-place-1');

    -- 1a. NOTHING DELIVERED.
    v_status := purchase_order_settled_status(v_order.id);
    if v_status <> 'ordered' then
      v_fail := v_fail || format('1: a placed order with no deliveries reads %s. ', v_status);
    end if;

    -- The on-hand before anything arrives, for assertion 4.
    -- STOCK IS NOT A COLUMN in this schema (036): on-hand is the fold over the
    -- movements, read through stock_on_hand. coalesce because an item with no
    -- movements in a location has no row at all, which is a position of zero.
    select coalesce((select soh.quantity_on_hand from stock_on_hand soh
                     where soh.inventory_item_id = v_item
                       and soh.location_id = v_loc), 0) into v_before;

    -- FIRST DELIVERY: line 1 only.
    v_receipt := receive_purchase_order(
      v_order.id, current_date,
      jsonb_build_array(
        jsonb_build_object('purchase_order_line_id', v_l1, 'quantity', 10, 'unit_cost', 100)),
      'ZZ056 delivery one', 'ZZ056-INV-1', null, 'zz056-receive-1');

    -- 1b. SOMETHING STANDING, SOMETHING OUTSTANDING.
    v_status := purchase_order_settled_status(v_order.id);
    if v_status <> 'part_received' then
      v_fail := v_fail || format('1: one line of two delivered reads %s. ', v_status);
    end if;
    select status into v_state from purchase_orders where id = v_order.id;
    if v_state <> 'part_received' then
      v_fail := v_fail || format('1: receive stored %s rather than part_received. ', v_state);
    end if;

    -- SECOND DELIVERY: line 2, which settles the order.
    v_receipt2 := receive_purchase_order(
      v_order.id, current_date,
      jsonb_build_array(
        jsonb_build_object('purchase_order_line_id', v_l2, 'quantity', 4, 'unit_cost', 500)),
      'ZZ056 delivery two', 'ZZ056-INV-2', null, 'zz056-receive-2');

    -- 1c. EVERYTHING DELIVERED.
    select status into v_state from purchase_orders where id = v_order.id;
    if v_state <> 'received' then
      v_fail := v_fail || format('1: a fully delivered order reads %s. ', v_state);
    end if;

    select rl.stock_movement_id into v_mv
    from purchase_receipt_lines rl where rl.purchase_receipt_id = v_receipt.id;
    -- THE BASIS OF AN INCOMING MOVEMENT IS ITS unit_cost. carried_unit_cost is
    -- what stock going OUT carried away with it, and it is NULL on a receipt --
    -- the first version of this assertion read it there and compared the
    -- counter's real figure against a null, which is a comparison that cannot
    -- fail in the direction that matters.
    select m.unit_cost into v_basis
    from stock_movements m where m.id = v_mv;

    -- ----------------------------------------------------------------------
    -- 2. A WALK-BACK THE DELIVERIES DO NOT SUPPORT IS REFUSED.
    -- Both deliveries still stand, so 'ordered' is a lie and 'part_received'
    -- is a lie. Attempted here, BEFORE any reversal, which is the side of the
    -- boundary where the gate and its absence disagree.
    -- ----------------------------------------------------------------------
    begin
      update purchase_orders set status = 'ordered' where id = v_order.id;
      v_fail := v_fail ||
        '2: an order with two standing deliveries was walked back to ordered. ';
    exception when others then
      if sqlstate <> 'PT409' then
        v_fail := v_fail || format(
          '2: refused with %s rather than PT409, so the message is not the rule (%s). ',
          sqlstate, sqlerrm);
      elsif sqlerrm not like '%the deliveries that still stand say%' then
        v_fail := v_fail || format(
          '2: refused, but by the generic graph rather than by the derivation (%s). ', sqlerrm);
      end if;
    end;

    -- ----------------------------------------------------------------------
    -- THE POSITION BEFORE ANYTHING IS UNDONE, and then A MANUAL RECEIPT AT A
    -- VERY DIFFERENT COST -- which is what makes assertion 4 able to fail.
    --
    -- A reversal must carry the basis it UNWINDS, never the moving average as
    -- it stands when the reversal is posted. Those two are the SAME NUMBER
    -- while nothing has moved since the receipt, so a fixture that reverses
    -- straight after receiving cannot tell the correct implementation from the
    -- exact defect §6 and 038 exist to prevent. 7 at 250 moves the average off
    -- 100, and the fixture refuses itself below if it somehow did not.
    -- ----------------------------------------------------------------------
    select coalesce((select soh.quantity_on_hand from stock_on_hand soh
                     where soh.inventory_item_id = v_item
                       and soh.location_id = v_loc), 0) into v_after;
    if v_after <> v_before + 10 then
      v_fail := v_fail || format(
        '4: before any reversal the position reads %s, expected %s. ', v_after, v_before + 10);
    end if;

    select m.id into v_mv2 from post_stock_receipt(
      v_prop, v_loc, v_item, 7, 250, current_date,
      'ZZ056 manual supplier', 'ZZ056 manual receipt', 'zz056-manual-1'
    ) m;

    select soh.moving_average_cost into v_avg from stock_on_hand soh
    where soh.inventory_item_id = v_item and soh.location_id = v_loc;
    if v_avg is null or v_avg = v_basis then
      raise exception
        '056 SELF-VERIFY: the fixture cannot distinguish the basis from the current average (both %), so assertion 4 would pass either way',
        v_avg;
    end if;

    -- ----------------------------------------------------------------------
    -- 8. A DELIVERY'S MOVEMENT CANNOT BE REVERSED ON ITS OWN.
    -- HERE, and not later, because reverse_stock_movement refuses an
    -- already-reversed movement first. Attempted after the deliveries are
    -- reversed, this assertion goes green on the OLD guard and never reaches
    -- the new one -- which is what the first dry run of this file reported.
    -- ----------------------------------------------------------------------
    v_ok := false;
    begin
      perform reverse_stock_movement(
        v_mv, 'ZZ056 trying the old way', '4057', 'zz056-old-way');
      v_ok := true;                    -- it was NOT refused, which is the defect
    exception when others then
      if sqlstate <> 'PT409' then
        v_fail := v_fail || format('8: refused with %s rather than PT409 (%s). ', sqlstate, sqlerrm);
      elsif sqlerrm not like '%reversing the delivery%' then
        v_fail := v_fail || format('8: refused, but not by name (%s). ', sqlerrm);
      end if;
    end;
    if v_ok then
      raise exception
        '056 SELF-VERIFY FAILED — 8: a delivery''s stock movement was reversed on its own, leaving the receipt saying the goods arrived.';
    end if;

    -- ----------------------------------------------------------------------
    -- 3. REVERSE THE SECOND DELIVERY. The order must fall back to
    --    part_received -- not to ordered, because delivery one still stands.
    -- ----------------------------------------------------------------------
    v_rev := reverse_purchase_receipt(
      v_receipt2.id, 'ZZ056 wrong order entirely', '4057', 'zz056-reverse-2');

    select status into v_state from purchase_orders where id = v_order.id;
    if v_state <> 'part_received' then
      v_fail := v_fail || format(
        '3: after reversing one of two deliveries the order reads %s. ', v_state);
    end if;

    -- ----------------------------------------------------------------------
    -- 1d. AND NOW THE CASE THAT TELLS v_standing FROM ITS ABSENCE: reverse the
    --     OTHER delivery too, leaving nothing standing. 'ordered', not
    --     'part_received'.
    -- ----------------------------------------------------------------------
    v_rev2 := reverse_purchase_receipt(
      v_receipt.id, 'ZZ056 never arrived', '4057', 'zz056-reverse-1');

    select status into v_state from purchase_orders where id = v_order.id;
    if v_state <> 'ordered' then
      v_fail := v_fail || format(
        '1: with every delivery reversed the order reads %s rather than ordered. ', v_state);
    end if;

    -- ----------------------------------------------------------------------
    -- 4. THE STOCK WENT BACK, AT THE BASIS IT UNWINDS.
    -- ----------------------------------------------------------------------
    -- The delivery is gone and the manual receipt remains, so the position is
    -- the original plus the manual 7 -- not the original. Asserting v_before
    -- here would be asserting that the reversal also took away stock that
    -- arrived by another route.
    select coalesce((select soh.quantity_on_hand from stock_on_hand soh
                     where soh.inventory_item_id = v_item
                       and soh.location_id = v_loc), 0) into v_after;
    if v_after <> v_before + 7 then
      v_fail := v_fail || format(
        '4: the position is %s after reversing, expected %s. ', v_after, v_before + 7);
    end if;

    -- AND THE COUNTER CARRIES THE BASIS IT UNWINDS -- 100, the cost the stock
    -- came in at -- NOT v_avg, the average as it stands now. The fixture has
    -- just proved those are different numbers.
    select m.id, m.carried_unit_cost into v_cmv, v_after
    from stock_movements m where m.reverses_movement_id = v_mv;
    if v_cmv is null then
      v_fail := v_fail || '4: no counter movement was posted for the stock line. ';
    elsif v_after is distinct from v_basis then
      v_fail := v_fail || format(
        '4: the counter carries %s; it should carry the basis it unwinds, %s (the average now stands at %s). ',
        v_after, v_basis, v_avg);
    end if;

    -- ----------------------------------------------------------------------
    -- 5. ONE MIRROR ENTRY PER DELIVERY, AND THE PAIR NETS TO ZERO ON EVERY
    --    ACCOUNT.
    -- ----------------------------------------------------------------------
    -- EVERY DOCUMENT THIS ACT TOUCHED, AND THE REASON THE LIST IS THIS LONG.
    -- The first version of this assertion looked only at entries whose source
    -- document is one of the two receipts. A per-movement entry is sourced on
    -- the MOVEMENT, not on the receipt — so leaving p_post_journal true in the
    -- reversal, which reverses the stock half of the ledger a second time,
    -- stayed GREEN at 11 of 11. The count could not see the extra entries and
    -- the netting could not see the extra lines. A figure scoped to the wrong
    -- set is rule 27 arriving as thoroughness.
    select array_agg(d) into v_docs from (
      select v_receipt.id as d
      union select v_receipt2.id
      union select rl.stock_movement_id
        from purchase_receipt_lines rl
        where rl.purchase_receipt_id in (v_receipt.id, v_receipt2.id)
      union select m.id
        from stock_movements m
        join purchase_receipt_lines rl
          on rl.stock_movement_id = m.reverses_movement_id
        where rl.purchase_receipt_id in (v_receipt.id, v_receipt2.id)
    ) t where d is not null;

    select count(*)::integer into v_n
    from journal_entries je
    where je.tenant_id = v_tenant
      and je.source_document_id = any(v_docs);
    if v_n <> 4 then
      v_fail := v_fail || format(
        '5: expected 4 entries (two deliveries, two mirrors) across the receipts and their movements, found %s. ', v_n);
    end if;

    select string_agg(format('%s net %s', a.code, t.net), ', ') into v_bad
    from (
      select l.account_id, sum(l.debit - l.credit) as net
      from journal_entry_lines l
      join journal_entries je on je.id = l.journal_entry_id
      where je.tenant_id = v_tenant
        and je.source_document_id = any(v_docs)
      group by l.account_id
      having sum(l.debit - l.credit) <> 0
    ) t
    join accounts a on a.id = t.account_id;
    if v_bad is not null then
      v_fail := v_fail || format('5: the pair does not net to zero (%s). ', v_bad);
    end if;

    select count(*)::integer into v_n
    from journal_entries je
    where je.tenant_id = v_tenant
      and je.source_document_type = 'goods_receipt_reversal'
      and je.source_document_id = v_receipt.id
      and je.reverses_entry_id = (
        select id from journal_entries
        where tenant_id = v_tenant
          and source_document_type = 'goods_receipt'
          and source_document_id = v_receipt.id);
    if v_n <> 1 then
      v_fail := v_fail ||
        '5: the mirror does not name the entry it unwinds through reverses_entry_id. ';
    end if;

    -- ----------------------------------------------------------------------
    -- 6. A RETRY UNDER THE SAME KEY. Same row back, nothing reversed twice.
    -- ----------------------------------------------------------------------
    -- WRAPPED, because the plausible defect here is a REFUSAL. Unwrapped, a
    -- dropped idempotency return killed the whole block with "already
    -- reversed" and this assertion never got to say what it was testing —
    -- red, but naming the wrong thing, which is most of the way to being
    -- misread as a different bug.
    begin
      v_rev2 := reverse_purchase_receipt(
        v_receipt2.id, 'ZZ056 wrong order entirely', '4057', 'zz056-reverse-2');
      if v_rev2.id <> v_rev.id then
        v_fail := v_fail || '6: a retry created a second reversal instead of returning the first. ';
      end if;
    exception when others then
      v_fail := v_fail || format(
        '6: a retry under the same key was REFUSED (%s: %s) — the index is the floor, not the interface. ',
        sqlstate, sqlerrm);
    end;

    select count(*)::integer into v_n from reversals
    where tenant_id = v_tenant and target_type = 'goods_receipt'
      and target_id in (v_receipt.id, v_receipt2.id);
    if v_n <> 2 then
      v_fail := v_fail || format('6: %s goods_receipt reversals exist, expected 2. ', v_n);
    end if;

    select count(*)::integer into v_n
    from journal_entries je
    where je.tenant_id = v_tenant
      and je.source_document_id in (v_receipt.id, v_receipt2.id);
    if v_n <> 4 then
      v_fail := v_fail || format('6: the retry left %s entries, expected 4. ', v_n);
    end if;

    -- ----------------------------------------------------------------------
    -- 7. A DIFFERENT KEY ON AN ALREADY-REVERSED DELIVERY: a sentence, not the
    --    index.
    -- ----------------------------------------------------------------------
    begin
      perform reverse_purchase_receipt(
        v_receipt2.id, 'ZZ056 second attempt', '4057', 'zz056-reverse-2-again');
      v_fail := v_fail || '7: an already-reversed delivery was reversed a second time. ';
    exception when others then
      if sqlstate <> 'PT409' then
        v_fail := v_fail || format(
          '7: refused with %s rather than PT409 (%s). ', sqlstate, sqlerrm);
      elsif sqlerrm not like '%already reversed%' then
        v_fail := v_fail || format('7: refused, but not by name (%s). ', sqlerrm);
      end if;
    end;

    -- ----------------------------------------------------------------------
    -- 10. THE AUTHORISATION IS STILL ON THE RECORD.
    -- ----------------------------------------------------------------------
    select count(*)::integer into v_n
    from purchase_receipts pr
    where pr.id in (v_receipt.id, v_receipt2.id)
      and pr.receipt_number is not null;
    if v_n <> 2 then
      v_fail := v_fail || format(
        '10: %s of the two reversed deliveries are still on record, expected 2. ', v_n);
    end if;

    select count(*)::integer into v_n
    from reversals r
    where r.target_type = 'goods_receipt'
      and r.target_id in (v_receipt.id, v_receipt2.id)
      and r.approved_by = v_user
      and r.reversed_by = v_user
      and length(btrim(r.reason)) > 0
      and r.business_date = (now() at time zone 'Africa/Lagos')::date;
    if v_n <> 2 then
      v_fail := v_fail || format(
        '10: %s reversals name their manager, their author, a reason and today''s date, expected 2. ', v_n);
    end if;

    -- ======================================================================
    -- 9. THE EXISTING 5-ARGUMENT CALLERS ARE UNTOUCHED, PROVEN NOT REASONED.
    -- The manual receipt built above has no delivery behind it, so the
    -- movement IS the record: it reverses through the old path, and it posts
    -- its OWN counter entry, which is what p_post_journal defaulting to true
    -- means. Flip that default and this is the only assertion in the file that
    -- notices -- and housekeeping, stock takes and write-offs would all have
    -- stopped reaching the ledger.
    -- ======================================================================
    perform reverse_stock_movement(
      v_mv2, 'ZZ056 manual reversal', '4057', 'zz056-manual-reverse');

    select count(*)::integer into v_n
    from journal_entries je
    join stock_movements m on m.id = je.source_document_id
    where je.tenant_id = v_tenant
      and je.source_document_type = 'stock_movement'
      and m.reverses_movement_id = v_mv2;
    if v_n <> 1 then
      v_fail := v_fail || format(
        '9: reversing a manual receipt posted %s counter entries, expected 1 — p_post_journal no longer defaults to true. ', v_n);
    end if;

    select coalesce((select soh.quantity_on_hand from stock_on_hand soh
                     where soh.inventory_item_id = v_item
                       and soh.location_id = v_loc), 0) into v_after;
    if v_after <> v_before then
      v_fail := v_fail || format(
        '9: with the delivery and the manual receipt both reversed the position is %s, expected the original %s. ',
        v_after, v_before);
    end if;

    -- ----------------------------------------------------------------------
    -- 11. THE SHAPE, READ OUT OF THE CATALOG.
    -- ----------------------------------------------------------------------
    for v_state, v_msg in
      select x.fn, x.want from (values
        ('purchase_order_settled_status',    'stable'),
        ('enforce_purchase_order_transition','definer'),
        ('receive_purchase_order',           'definer'),
        ('post_movement_reversal',           'definer'),
        ('reverse_purchase_receipt',         'definer'),
        ('reverse_stock_movement',           'definer'),
        ('forbid_purchase_receipt_change',   'definer')
      ) as x(fn, want)
    loop
      -- A PINNED search_path THAT INCLUDES public, not an exact string.
      -- receive_purchase_order legitimately carries `public, extensions` --
      -- it reaches crypt() through verify_manager_pin -- and the first
      -- version of this check called that a lost guard. What matters is that
      -- a search_path is SET and that public is in it.
      select not p.prosecdef or p.proconfig is null
                 or not exists (select 1 from unnest(p.proconfig) cfg
                                where cfg like 'search_path=%public%')
        into v_ok
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = v_state;
      if v_ok is null then
        v_fail := v_fail || format('11: %s is missing. ', v_state);
      elsif v_ok then
        v_fail := v_fail || format(
          '11: %s lost SECURITY DEFINER or its search_path in the rebuild. ', v_state);
      end if;
      if v_msg = 'stable' then
        select p.provolatile <> 's' into v_ok
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = v_state;
        if coalesce(v_ok, true) then
          v_fail := v_fail || format('11: %s is not STABLE. ', v_state);
        end if;
      end if;
    end loop;

    -- The tenant gate and the idempotency parameter, by name, in the two
    -- functions that were reassembled from live text.
    for v_state in select unnest(array['receive_purchase_order', 'reverse_purchase_receipt'])
    loop
      select pg_get_functiondef(p.oid) not like '%is_tenant_staff(%'
          or pg_get_functiondef(p.oid) not like '%p_idempotency_key%'
        into v_ok
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = v_state;
      if coalesce(v_ok, true) then
        v_fail := v_fail || format(
          '11: %s lost its is_tenant_staff gate or its idempotency key. ', v_state);
      end if;
    end loop;

    -- post_stock_receipt is still called in the form that evaluates it ONCE.
    select pg_get_functiondef(p.oid) like '%from post_stock_receipt(%'
       and pg_get_functiondef(p.oid) not like '%(post_stock_receipt(%'
      into v_ok
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'receive_purchase_order';
    if not coalesce(v_ok, false) then
      v_fail := v_fail ||
        '11: receive_purchase_order no longer calls post_stock_receipt in the select-from form. ';
    end if;

    -- THE NEW PARAMETER'S DEFAULT, read rather than trusted, and only ONE
    -- overload: a leftover 5-argument copy would be a second implementation
    -- that existing callers would quietly keep using.
    select count(*)::integer into v_n
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'post_movement_reversal';
    if v_n <> 1 then
      v_fail := v_fail || format(
        '11: %s overloads of post_movement_reversal exist, expected 1. ', v_n);
    end if;
    select pg_get_function_arguments(p.oid) like '%p_post_journal boolean DEFAULT true%'
      into v_ok
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'post_movement_reversal';
    if not coalesce(v_ok, false) then
      v_fail := v_fail ||
        '11: post_movement_reversal''s p_post_journal does not default to true. ';
    end if;

    -- Both new constraints.
    select count(*)::integer into v_n from pg_constraint
    where conname in ('reversals_target_type_check', 'reversals_receipt_counter_check')
      and pg_get_constraintdef(oid) like '%goods_receipt%';
    if v_n <> 2 then
      v_fail := v_fail || format(
        '11: %s of the two reversals constraints mention goods_receipt, expected 2. ', v_n);
    end if;

    begin
      insert into reversals (
        tenant_id, property_id, reversed_by, approved_by, reason,
        target_type, target_id, counter_entry_id, business_date, created_by)
      values (v_tenant, v_prop, v_user, v_user, 'ZZ056 counter probe',
              'goods_receipt', gen_random_uuid(), v_mv2, current_date, v_user);
      v_fail := v_fail ||
        '11: a goods_receipt reversal was allowed to name a counter row. ';
    exception when check_violation then
      null;                                  -- refused, which is the point
    end;

    -- ---- the verdict -----------------------------------------------------
    if v_fail <> '' then
      raise exception '056 SELF-VERIFY FAILED — %', v_fail;
    end if;

    raise notice '056 SELF-VERIFY: 11 assertions passed.';
    raise exception 'ZZ_056_FIXTURE_DONE';
  exception
    when others then
      if sqlerrm = 'ZZ_056_FIXTURE_DONE' then
        raise notice '056 self-verify complete; fixture rolled back.';
      else
        raise;
      end if;
  end;
end $$;

