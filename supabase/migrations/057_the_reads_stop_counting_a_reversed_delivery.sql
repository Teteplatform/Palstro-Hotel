-- ############################################################################
-- 057 — THE READS STOP COUNTING A REVERSED DELIVERY
-- ############################################################################
-- 056 made a delivery undoable. Every purchasing read is built on
-- purchase_receipt_lines, and nothing in them knew a receipt could stop
-- standing, so until this file a reversal corrected the stock, the ledger and
-- the order's status while received_quantity, outstanding_quantity, is_settled,
-- received_value, receipt_count, the supplier row and the over-receipt report
-- all went on reporting the delivery as though it had happened.
--
-- FOUR EXCLUDE, ONE KEEPS, AND ONE IS DELIBERATELY NOT TOUCHED:
--
--   purchase_order_line_status     excludes  (six figures, one LATERAL)
--   purchase_order_summary         excludes  (two sites: the LATERAL and the
--                                             separate receipt_count subquery)
--   stock_over_receipts            excludes  (in the CTE, see SECTION 4)
--   purchase_receipt_line_detail   KEEPS, and marks
--   supplier_activity              inherits from the summary — SECTION 3
--
-- THE ONE THAT KEEPS IS NOT AN INCONSISTENCY. A delivery that happened and was
-- undone is two facts, not zero. The three figure-bearing reads answer "what
-- stands?", so a reversed delivery must leave them or every total is wrong. The
-- delivery history answers "what happened?", so the same row must stay, with the
-- reversal beside it. Deciding that per view, in writing, is the difference
-- between a rule and a set of accidents.
--
-- AND IT IS WHERE AN AUTHORISATION STAYS ANSWERABLE. Reversing an over-received
-- delivery takes it off stock_over_receipts, which is right — that report is
-- about stock that is there now — but the manager who approved accepting five
-- litres more than were ordered must still be answerable for having approved it.
-- `purchase_receipts.authorised_by` is permanent (the receipt is immutable by
-- trigger) and this view already carried it; assertion 3 asserts BOTH halves
-- from the same act, because asserting only the disappearance would pass just as
-- well if the row had vanished from everywhere.
--
-- EVERY VIEW IS REBUILT FROM ITS LIVE DEFINITION with `security_invoker = on`
-- carried explicitly and asserted off pg_class afterwards. A Postgres view runs
-- with its OWNER's rights by default, which on any of these would be a hole
-- straight through RLS — every tenant's purchasing, readable by any
-- authenticated user. It is spelled out on every one rather than assumed,
-- because `create or replace view` does not preserve reloptions you forget to
-- restate.
--
-- The joins to `expense_categories` still do NOT filter `deleted_at`, for the
-- reason 054 and 055 gave: an order raised in March against a category retired
-- in June must still name it, or last quarter's orders turn unreadable the day
-- somebody tidies the settings.
--
-- ----------------------------------------------------------------------------
-- WHAT THE BREAKAGES WENT RED FOR (rule 27)
-- ----------------------------------------------------------------------------
-- Ten mutations, each valid SQL that changes what a view REPORTS. All ten red.
--
--   A  line_status keeps counting a reversed delivery
--        -> 1: the line reads received=12 outstanding=0 settled=t
--   B  the summary keeps counting it in its figures
--        -> 1: value=1200.00 outstanding=0; and 2, through the supplier row
--   C  receipt_count keeps counting it
--        -> 1: receipts=1 after the reversal
--   D  stock_over_receipts keeps listing stock that went back
--        -> 3: the report still lists 1 row
--   E  the predicate moves OUTSIDE the CTE, past the window sum
--        -> 4: the line still reports an over-receipt of 2 after the first of
--           two deliveries was reversed. NOTHING ELSE WENT RED: fixture A, with
--           its single delivery, is green under both placements, which is
--           exactly why fixture B exists.
--   F  the delivery history excludes reversed rows
--        -> 3: 0 rows for the reversed delivery with its manager and reason
--   G  it stops naming the approving manager        -> 5
--   H  it stops carrying the reversal reason        -> 5
--   I  a view is rebuilt without security_invoker   -> 6, naming the view
--   J  supplier_activity stops inheriting           -> 2
--
-- AND WHAT THE RUN FOUND IN THE ASSERTIONS
--
-- J HAD NO ANCHOR AT FIRST, because 057 does not contain supplier_activity --
-- which is the whole of SECTION 3. A mutation with nothing to edit is a
-- breakage that proves nothing, so it now INJECTS the future edit it is testing
-- into the same transaction.
--
-- AND THEN J WAS GREEN. Assertion 2 compared supplier_activity against the
-- summary only AFTER the reversal, where the right answer is 0.00 -- and a view
-- that hardcodes 0 agrees with it perfectly. The correct and the incorrect
-- computation were the same number, so the assertion could not test either one
-- (rule 27's fourth shape). It now also asserts the agreement while a delivery
-- still stands, where inheriting reads 1200.00 and not inheriting reads 0.00.
--
-- Two fixture errors came out of the first dry run, both mine and both worth
-- naming: a difference between what was ordered and what arrived needs a reason
-- on the LINE, not the call -- p_reason authorises the destination, and the
-- over-receipt reason is `line ->> 'reason'` -- and assertion 5 read
-- `reversed_on` into a numeric variable, which failed on "invalid input syntax
-- for type numeric".
--
-- ----------------------------------------------------------------------------
-- A NOTE ON THIS FILE'S OWN HISTORY (§5)
-- ----------------------------------------------------------------------------
-- This header was edited AFTER the file had been applied once, to add the
-- breakage record above -- which was written in a tool that turned out not to
-- exist on this machine, so the first apply went in without it. §5's exception
-- was used deliberately and all three parts held at the same time: minutes had
-- passed inside the same session, exactly one database has ever seen this file,
-- and the file is idempotent throughout (`create or replace view` everywhere
-- and a fixture that rolls itself back). It was then RE-RUN and RE-VERIFIED
-- rather than assumed, which is the part of the exception that actually matters.
-- Flagged here, in the file, the way 050 was.
-- ############################################################################

-- ############################################################################
-- SECTION 1 — purchase_order_line_status
-- ############################################################################
-- received_quantity, received_value, closed_short, outstanding_quantity,
-- is_settled and last_unit_cost all come out of one LATERAL over the receipt
-- lines, so one predicate corrects all six. is_settled is the one that matters
-- most: it is what the receiving screen reads to decide whether a line can be
-- delivered against again.
create or replace view purchase_order_line_status
with (security_invoker = on) as
SELECT ol.id AS purchase_order_line_id,
    ol.tenant_id,
    po.property_id,
    ol.purchase_order_id,
    po.order_number,
    po.status AS order_status,
    ol.line_number,
    ol.line_type,
    ol.inventory_item_id,
    i.name AS item_name,
    i.code AS item_code,
    i.base_unit,
    i.tracks_expiry,
    ol.description,
    ol.quantity AS ordered_quantity,
    ol.unit_cost AS ordered_unit_cost,
    ol.note,
    COALESCE(r.received_quantity, 0::numeric)::numeric(14,4) AS received_quantity,
    COALESCE(r.received_value, 0::numeric)::numeric(14,2) AS received_value,
    COALESCE(r.closed_short, false) AS closed_short,
    GREATEST(ol.quantity - COALESCE(r.received_quantity, 0::numeric), 0::numeric)::numeric(14,4) AS outstanding_quantity,
    COALESCE(r.closed_short, false) OR COALESCE(r.received_quantity, 0::numeric) >= ol.quantity AS is_settled,
    r.last_unit_cost,
    ol.expense_category_id,
    ec.code AS expense_category_code,
    ec.name AS expense_category_name
   FROM purchase_order_lines ol
     JOIN purchase_orders po ON po.id = ol.purchase_order_id AND po.tenant_id = ol.tenant_id
     LEFT JOIN inventory_items i ON i.id = ol.inventory_item_id AND i.tenant_id = ol.tenant_id
     LEFT JOIN expense_categories ec ON ec.id = ol.expense_category_id AND ec.tenant_id = ol.tenant_id
     LEFT JOIN LATERAL ( SELECT sum(rl.quantity) AS received_quantity,
            sum(round(rl.quantity * rl.unit_cost, 2)) AS received_value,
            bool_or(rl.closed_short) AS closed_short,
            (array_agg(rl.unit_cost ORDER BY pr.business_date DESC, rl.created_at DESC))[1] AS last_unit_cost
           FROM purchase_receipt_lines rl
             JOIN purchase_receipts pr ON pr.id = rl.purchase_receipt_id
          WHERE rl.purchase_order_line_id = ol.id
            AND NOT EXISTS (
              SELECT 1 FROM reversals rv
              WHERE rv.tenant_id = pr.tenant_id
                AND rv.target_type = 'goods_receipt'
                AND rv.target_id = pr.id)) r ON true;

-- ############################################################################
-- SECTION 2 — purchase_order_summary
-- ############################################################################
-- TWO SITES, not one. The per-line LATERAL feeds received_value,
-- outstanding_value and last_receipt_date; receipt_count is a separate
-- subquery and would otherwise have gone on counting a delivery that no
-- longer stands -- an order reading "1 delivery" with nothing delivered.
create or replace view purchase_order_summary
with (security_invoker = on) as
SELECT po.id,
    po.seq,
    po.tenant_id,
    po.property_id,
    po.order_number,
    po.status,
    po.order_date,
    po.expected_date,
    po.note,
    po.cancel_reason,
    po.ordered_at,
    po.cancelled_at,
    po.created_at,
    po.created_by,
    po.supplier_id,
    s.name AS supplier_name,
    s.code AS supplier_code,
    po.destination_location_id,
    l.name AS destination_name,
    l.kind AS destination_kind,
    po.status = ANY (ARRAY['ordered'::text, 'part_received'::text]) AS is_open,
    agg.line_count,
    agg.ordered_value,
    agg.received_value,
    agg.outstanding_value,
    agg.last_receipt_date,
    agg.receipt_count
   FROM purchase_orders po
     JOIN suppliers s ON s.id = po.supplier_id AND s.tenant_id = po.tenant_id
     JOIN locations l ON l.id = po.destination_location_id AND l.property_id = po.property_id
     CROSS JOIN LATERAL ( SELECT count(*)::integer AS line_count,
            COALESCE(sum(round(ol.quantity * ol.unit_cost, 2)), 0::numeric)::numeric(14,2) AS ordered_value,
            COALESCE(sum(r.received_value), 0::numeric)::numeric(14,2) AS received_value,
            COALESCE(sum(
                CASE
                    WHEN r.closed_short THEN 0::numeric
                    ELSE GREATEST(ol.quantity - COALESCE(r.received_quantity, 0::numeric), 0::numeric) * ol.unit_cost
                END), 0::numeric)::numeric(14,2) AS outstanding_value,
            max(r.last_date) AS last_receipt_date,
            ( SELECT count(*)::integer AS count
                   FROM purchase_receipts pr
                  WHERE pr.purchase_order_id = po.id
                    AND NOT EXISTS (
                      SELECT 1 FROM reversals rv
                      WHERE rv.tenant_id = pr.tenant_id
                        AND rv.target_type = 'goods_receipt'
                        AND rv.target_id = pr.id)) AS receipt_count
           FROM purchase_order_lines ol
             LEFT JOIN LATERAL ( SELECT sum(rl.quantity) AS received_quantity,
                    sum(round(rl.quantity * rl.unit_cost, 2)) AS received_value,
                    bool_or(rl.closed_short) AS closed_short,
                    max(pr2.business_date) AS last_date
                   FROM purchase_receipt_lines rl
                     JOIN purchase_receipts pr2 ON pr2.id = rl.purchase_receipt_id
                  WHERE rl.purchase_order_line_id = ol.id
                    AND NOT EXISTS (
                      SELECT 1 FROM reversals rv
                      WHERE rv.tenant_id = pr2.tenant_id
                        AND rv.target_type = 'goods_receipt'
                        AND rv.target_id = pr2.id)) r ON true
          WHERE ol.purchase_order_id = po.id) agg;

-- ############################################################################
-- SECTION 3 — supplier_activity IS NOT TOUCHED, AND THAT IS THE POINT
-- ############################################################################
-- It reads ordered_value, received_value, outstanding_value,
-- last_receipt_date and receipt_count straight off purchase_order_summary, so
-- SECTION 2 corrects it. Editing it as well would be adding a second place
-- for the same rule to live, which is how two surfaces come to disagree.
-- Assertion 2 asserts the inheritance rather than trusting it, because the day
-- somebody inlines those aggregates here is the day this comment becomes
-- wrong in silence.

-- ############################################################################
-- SECTION 4 — stock_over_receipts
-- ############################################################################
-- THE PREDICATE GOES IN THE CTE, not on the outer WHERE, and that is not a
-- style choice. received_to_date is a WINDOW SUM over the receipt lines of a
-- purchase order line, so excluding a reversed delivery from the CTE makes
-- every later delivery on that line recount correctly. Filtered on the outside
-- instead, the reversed row would disappear while still inflating the running
-- total it contributed to -- and a delivery that was NOT over-received would
-- start reporting as over.
create or replace view stock_over_receipts
with (security_invoker = on) as
WITH running AS (
         SELECT rl.id,
            rl.tenant_id,
            pr.property_id,
            rl.purchase_receipt_id,
            rl.purchase_order_line_id,
            pr.purchase_order_id,
            pr.receipt_number,
            pr.business_date,
            pr.created_at,
            pr.delivery_note,
            pr.invoice_number,
            pr.authorised_by,
            po.order_number,
            po.supplier_id,
            s.name AS supplier_name,
            s.code AS supplier_code,
            rl.line_number,
            rl.quantity,
            rl.unit_cost,
            rl.reason,
            rl.note,
            rl.created_by,
            rl.stock_movement_id,
            ol.quantity AS ordered_quantity,
            ol.inventory_item_id,
            i.name AS item_name,
            i.code AS item_code,
            i.base_unit,
            l.name AS location_name,
            sum(rl.quantity) OVER (PARTITION BY rl.purchase_order_line_id ORDER BY pr.seq, rl.line_number ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS received_to_date
           FROM purchase_receipt_lines rl
             JOIN purchase_receipts pr ON pr.id = rl.purchase_receipt_id AND pr.tenant_id = rl.tenant_id
             JOIN purchase_orders po ON po.id = pr.purchase_order_id AND po.tenant_id = pr.tenant_id
             JOIN purchase_order_lines ol ON ol.id = rl.purchase_order_line_id AND ol.tenant_id = rl.tenant_id
             JOIN suppliers s ON s.id = po.supplier_id AND s.tenant_id = po.tenant_id
             JOIN locations l ON l.id = pr.location_id AND l.property_id = pr.property_id
             LEFT JOIN inventory_items i ON i.id = ol.inventory_item_id AND i.tenant_id = ol.tenant_id
          WHERE NOT EXISTS (
            SELECT 1 FROM reversals rv
            WHERE rv.tenant_id = pr.tenant_id
              AND rv.target_type = 'goods_receipt'
              AND rv.target_id = pr.id)
        )
 SELECT id,
    tenant_id,
    property_id,
    purchase_receipt_id,
    purchase_order_id,
    purchase_order_line_id,
    receipt_number,
    order_number,
    business_date,
    created_at,
    delivery_note,
    invoice_number,
    authorised_by,
    created_by,
    supplier_id,
    supplier_name,
    supplier_code,
    line_number,
    inventory_item_id,
    item_name,
    item_code,
    base_unit,
    location_name,
    ordered_quantity,
    received_to_date,
    quantity,
    unit_cost,
    LEAST(quantity, received_to_date - ordered_quantity)::numeric(14,4) AS over_quantity,
    round(LEAST(quantity, received_to_date - ordered_quantity) * unit_cost, 2)::numeric(14,2) AS over_value,
    reason,
    note,
    stock_movement_id
   FROM running r
  WHERE received_to_date > ordered_quantity;

-- ############################################################################
-- SECTION 5 — purchase_receipt_line_detail KEEPS THE ROW AND MARKS IT
-- ############################################################################
-- The one read of the five that does NOT exclude a reversed delivery. A
-- delivery that happened and was undone is two facts, and this is the surface
-- where both belong: the quantities as they were recorded, and the reversal
-- that undid them, with its date, its reason and the manager who approved it.
--
-- AND IT IS WHERE AN AUTHORISATION STAYS ANSWERABLE. The manager who approved
-- accepting five litres more than were ordered is on purchase_receipts.
-- authorised_by, which this view already carried. Reversing the delivery
-- rightly takes it off stock_over_receipts -- that report is about stock that
-- is there now -- but it must not take the approval out of reach, and
-- assertion 3 asserts both halves from the same act.
--
-- The join does not filter the reversal by anything: reversals_target_uniq
-- makes at most one row per receipt, so the LEFT JOIN cannot multiply the
-- rows of this view.
create or replace view purchase_receipt_line_detail
with (security_invoker = on) as
SELECT rl.id,
    rl.tenant_id,
    pr.property_id,
    rl.purchase_receipt_id,
    pr.receipt_number,
    pr.business_date,
    pr.delivery_note,
    pr.invoice_number,
    pr.authorised_by,
    pr.purchase_order_id,
    po.order_number,
    rl.purchase_order_line_id,
    rl.line_number,
    rl.quantity,
    rl.unit_cost,
    rl.closed_short,
    rl.reason,
    rl.batch_code,
    rl.expiry_date,
    rl.note,
    rl.stock_movement_id,
    rl.created_at,
    rl.created_by,
    ol.quantity AS ordered_quantity,
    ol.unit_cost AS ordered_unit_cost,
    ol.inventory_item_id,
    i.name AS item_name,
    i.code AS item_code,
    i.base_unit,
    round(rl.quantity * rl.unit_cost, 2)::numeric(14,2) AS line_value,
    (rl.unit_cost - ol.unit_cost)::numeric(14,2) AS unit_cost_difference,
    round(rl.quantity * (rl.unit_cost - ol.unit_cost), 2)::numeric(14,2) AS cost_difference_value,
    rl.line_type,
    ol.description,
    ol.expense_category_id,
    ec.name AS expense_category_name,
    rv.id IS NOT NULL AS is_reversed,
    rv.business_date AS reversed_on,
    rv.reversed_at,
    rv.reason AS reversal_reason,
    rv.reversed_by AS reversal_recorded_by,
    rv.approved_by AS reversal_approved_by
   FROM purchase_receipt_lines rl
     JOIN purchase_receipts pr ON pr.id = rl.purchase_receipt_id AND pr.tenant_id = rl.tenant_id
     JOIN purchase_orders po ON po.id = pr.purchase_order_id AND po.tenant_id = pr.tenant_id
     JOIN purchase_order_lines ol ON ol.id = rl.purchase_order_line_id AND ol.tenant_id = rl.tenant_id
     LEFT JOIN inventory_items i ON i.id = ol.inventory_item_id AND i.tenant_id = ol.tenant_id
     LEFT JOIN expense_categories ec ON ec.id = ol.expense_category_id AND ec.tenant_id = ol.tenant_id
     LEFT JOIN reversals rv ON rv.target_type = 'goods_receipt' AND rv.target_id = pr.id AND rv.tenant_id = pr.tenant_id;

-- ############################################################################
-- SECTION 6 — SELF-VERIFY
-- ############################################################################
-- NAME THE DEFECT EACH ONE TURNS RED (rule 27):
--
--   1  the figures drop a reversed delivery
--      Six on purchase_order_line_status and three on purchase_order_summary,
--      asserted BEFORE and AFTER the same reversal. RED if either predicate is
--      dropped. Asserted on the VALUES, not on a row count: every one of these
--      rows exists either way, and a count of 1 is insensitive to all nine
--      figures being wrong.
--
--   2  supplier_activity inherits it
--      RED if SECTION 2's predicate is dropped, and RED if somebody later
--      inlines those aggregates here instead of reading the summary. That second
--      case is the one worth having: this view is correct today only because it
--      does not compute anything, and nothing else in the file would notice if
--      that changed.
--
--   3  THE OVER-RECEIPT LEAVES THE ALARM AND THE APPROVAL STAYS ANSWERABLE
--      Both halves, from the same act. RED if stock_over_receipts goes on
--      listing stock that went back; RED if purchase_receipt_line_detail starts
--      excluding reversed rows, which is the obvious over-correction and would
--      take the authorising manager out of reach with it. Asserting only the
--      disappearance would pass just as well if the row had vanished from
--      everywhere, which is the failure the pairing exists to catch.
--
--   4  THE PREDICATE IS INSIDE THE CTE, WHERE THE WINDOW SUM IS
--      This is the purpose-built one. An order of 10 delivered as 6 then 6: the
--      second delivery is over by 2. Reverse the FIRST and the second is 6 of
--      10 and over by nothing. With the predicate on the OUTER where instead,
--      the reversed row disappears while still contributing to the window sum it
--      fed, so received_to_date stays 12 and a delivery that was never over
--      starts reporting as over. The one-delivery fixture above CANNOT see that
--      -- it goes green under both -- which is why this second order exists.
--
--   5  the delivery history MARKS it
--      is_reversed, the date, the reason and the approving manager. RED if the
--      join or the columns are dropped. Asserted on the reason and the manager
--      rather than on is_reversed alone, because a boolean is one bit and these
--      are what somebody actually reads.
--
--   6  security_invoker on all five
--      RED if a rebuild drops it. `create or replace view` does not preserve
--      reloptions you forget to restate, and the failure is silent: the view
--      keeps working, for everybody, on every tenant's rows.
do $$
declare
  v_tenant  uuid;
  v_user    uuid;
  v_prop    uuid;
  v_loc     uuid;
  v_item    uuid;
  v_sup     uuid;
  v_order   purchase_orders;
  v_order2  purchase_orders;
  v_l1      uuid;
  v_l2      uuid;
  v_rc      purchase_receipts;
  v_rc2     purchase_receipts;
  v_rcb     purchase_receipts;
  v_qty     numeric(14,4);
  v_out     numeric(14,4);
  v_val     numeric(14,2);
  v_set     boolean;
  v_n       integer;
  v_mgr     uuid;
  v_txt     text;
  v_on      date;
  v_ok      boolean;
  v_fail    text := '';
begin
  begin
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

    if v_loc is null or v_item is null then
      raise exception '057 SELF-VERIFY could not build its fixture (store=%, item=%)',
        v_loc, v_item;
    end if;

    insert into manager_pins (tenant_id, user_id, pin_hash)
    values (v_tenant, v_user, crypt('4057', gen_salt('bf')))
    on conflict (tenant_id, user_id) do update set pin_hash = excluded.pin_hash;

    insert into suppliers (tenant_id, name, code)
    values (v_tenant, 'ZZ057 fixture supplier', 'ZZ057') returning id into v_sup;

    -- ======================================================================
    -- FIXTURE A — ONE LINE, OVER-RECEIVED IN ONE DELIVERY
    -- ======================================================================
    v_order := save_purchase_order(
      v_prop, null, v_sup, current_date, current_date + 1, v_loc,
      'ZZ057 over-received order',
      jsonb_build_array(jsonb_build_object('line_type', 'inventory',
        'inventory_item_id', v_item, 'quantity', 10, 'unit_cost', 100)),
      'zz057-order-1');
    select id into v_l1 from purchase_order_lines
      where purchase_order_id = v_order.id and line_number = 1;
    perform place_purchase_order(v_order.id, 'zz057-place-1');

    -- 12 against 10 ordered: an over-receipt, which needs a manager and a
    -- reason. That is what makes assertion 3 possible.
    v_rc := receive_purchase_order(
      v_order.id, current_date,
      jsonb_build_array(jsonb_build_object(
        'purchase_order_line_id', v_l1, 'quantity', 12, 'unit_cost', 100,
        'reason', 'ZZ057 two extra on the truck')),
      'ZZ057 delivery note', 'ZZ057-INV', null, 'zz057-receive-1',
      '4057', 'ZZ057 driver brought two extra and the kitchen wanted them');

    select authorised_by into v_mgr from purchase_receipts where id = v_rc.id;
    if v_mgr is null then
      v_fail := v_fail ||
        '3: the fixture''s over-receipt recorded no authorising manager, so the assertion cannot test for one. ';
    end if;

    -- ---- 1 BEFORE -------------------------------------------------------
    select received_quantity, outstanding_quantity, received_value, is_settled
      into v_qty, v_out, v_val, v_set
    from purchase_order_line_status where purchase_order_line_id = v_l1;
    if v_qty <> 12 or v_out <> 0 or v_val <> 1200.00 or not v_set then
      v_fail := v_fail || format(
        '1: before the reversal the line reads received=%s outstanding=%s value=%s settled=%s, expected 12/0/1200.00/true. ',
        v_qty, v_out, v_val, v_set);
    end if;

    select received_value, outstanding_value, receipt_count
      into v_val, v_out, v_n
    from purchase_order_summary where id = v_order.id;
    if v_val <> 1200.00 or v_out <> 0 or v_n <> 1 then
      v_fail := v_fail || format(
        '1: before the reversal the order reads value=%s outstanding=%s receipts=%s, expected 1200.00/0/1. ',
        v_val, v_out, v_n);
    end if;

    -- ---- 3a THE ALARM IS RINGING, AND NAMES THE MANAGER -----------------
    select count(*)::integer into v_n from stock_over_receipts
    where purchase_receipt_id = v_rc.id and over_quantity = 2 and authorised_by = v_mgr;
    if v_n <> 1 then
      v_fail := v_fail || format(
        '3: before the reversal the over-receipt report shows %s matching rows, expected 1. ', v_n);
    end if;

    -- ---- 2a supplier_activity AGREES WHILE THE FIGURE IS NON-ZERO -------
    -- HERE, and not only after the reversal. A supplier_activity that stops
    -- inheriting and hardcodes 0 AGREES with the summary once the delivery is
    -- reversed, because the right answer is 0 too -- so the after-check alone
    -- stayed GREEN against exactly that mutation. This is the side of the
    -- boundary where inheriting and not inheriting are different numbers.
    select count(*)::integer into v_n
    from supplier_activity sa
    join purchase_order_summary pos on pos.id = sa.purchase_order_id
    where sa.purchase_order_id = v_order.id
      and sa.received_value    = pos.received_value
      and sa.outstanding_value = pos.outstanding_value
      and sa.receipt_count     = pos.receipt_count;
    if v_n <> 1 then
      v_fail := v_fail ||
        '2: supplier_activity disagrees with purchase_order_summary while a delivery stands, so it is computing its own answer. ';
    end if;
    select received_value, receipt_count into v_val, v_n
    from supplier_activity where purchase_order_id = v_order.id;
    if v_val <> 1200.00 or v_n <> 1 then
      v_fail := v_fail || format(
        '2: before the reversal the supplier row reads value=%s receipts=%s, expected 1200.00/1. ', v_val, v_n);
    end if;

    -- ---- THE REVERSAL ---------------------------------------------------
    perform reverse_purchase_receipt(
      v_rc.id, 'ZZ057 sent the whole delivery back', '4057', 'zz057-reverse-1');

    -- ---- 1 AFTER --------------------------------------------------------
    select received_quantity, outstanding_quantity, received_value, is_settled
      into v_qty, v_out, v_val, v_set
    from purchase_order_line_status where purchase_order_line_id = v_l1;
    if v_qty <> 0 or v_out <> 10 or v_val <> 0.00 or v_set then
      v_fail := v_fail || format(
        '1: after the reversal the line reads received=%s outstanding=%s value=%s settled=%s, expected 0/10/0.00/false. ',
        v_qty, v_out, v_val, v_set);
    end if;

    select received_value, outstanding_value, receipt_count
      into v_val, v_out, v_n
    from purchase_order_summary where id = v_order.id;
    if v_val <> 0.00 or v_out <> 1000.00 or v_n <> 0 then
      v_fail := v_fail || format(
        '1: after the reversal the order reads value=%s outstanding=%s receipts=%s, expected 0.00/1000.00/0. ',
        v_val, v_out, v_n);
    end if;

    -- ---- 2 supplier_activity INHERITS IT --------------------------------
    select count(*)::integer into v_n
    from supplier_activity sa
    join purchase_order_summary pos on pos.id = sa.purchase_order_id
    where sa.purchase_order_id = v_order.id
      and sa.received_value   = pos.received_value
      and sa.outstanding_value = pos.outstanding_value
      and sa.receipt_count    = pos.receipt_count
      and coalesce(sa.last_receipt_date, '1900-01-01'::date)
          = coalesce(pos.last_receipt_date, '1900-01-01'::date);
    if v_n <> 1 then
      v_fail := v_fail ||
        '2: supplier_activity no longer agrees with purchase_order_summary, so it is computing its own answer. ';
    end if;
    select received_value, receipt_count into v_val, v_n
    from supplier_activity where purchase_order_id = v_order.id;
    if v_val <> 0.00 or v_n <> 0 then
      v_fail := v_fail || format(
        '2: the supplier row reads value=%s receipts=%s after the reversal, expected 0.00/0. ', v_val, v_n);
    end if;

    -- ---- 3b THE ALARM IS QUIET AND THE APPROVAL IS STILL ANSWERABLE -----
    select count(*)::integer into v_n from stock_over_receipts
    where purchase_receipt_id = v_rc.id;
    if v_n <> 0 then
      v_fail := v_fail || format(
        '3: the over-receipt report still lists %s row(s) for stock that went back. ', v_n);
    end if;

    select count(*)::integer into v_n from purchase_receipt_line_detail
    where purchase_receipt_id = v_rc.id
      and quantity = 12
      and authorised_by = v_mgr
      and reason is not null;
    if v_n <> 1 then
      v_fail := v_fail || format(
        '3: the delivery history shows %s rows for the reversed delivery with its manager and reason, expected 1 — an authorisation that happened must not become unfindable. ',
        v_n);
    end if;

    -- ---- 5 AND IT IS MARKED AS REVERSED --------------------------------
    select is_reversed, reversal_reason, reversal_approved_by = v_user, reversed_on
      into v_ok, v_txt, v_set, v_on
    from purchase_receipt_line_detail where purchase_receipt_id = v_rc.id;
    if not coalesce(v_ok, false) then
      v_fail := v_fail || '5: the delivery history does not mark the row as reversed. ';
    end if;
    if v_txt is distinct from 'ZZ057 sent the whole delivery back' then
      v_fail := v_fail || format('5: the reversal reason reads %L. ', v_txt);
    end if;
    if not coalesce(v_set, false) then
      v_fail := v_fail || '5: the reversal does not name the manager who approved it. ';
    end if;

    -- ======================================================================
    -- FIXTURE B — TWO DELIVERIES, AND THE WINDOW SUM
    -- 10 ordered, delivered 6 then 6. The SECOND is over by 2. Reverse the
    -- FIRST and the second is 6 of 10, over by nothing. Fixture A cannot test
    -- this: with one delivery, inside-the-CTE and outside-the-CTE give the same
    -- answer, so it passes either way.
    -- ======================================================================
    v_order2 := save_purchase_order(
      v_prop, null, v_sup, current_date, current_date + 1, v_loc,
      'ZZ057 two-delivery order',
      jsonb_build_array(jsonb_build_object('line_type', 'inventory',
        'inventory_item_id', v_item, 'quantity', 10, 'unit_cost', 100)),
      'zz057-order-2');
    select id into v_l2 from purchase_order_lines
      where purchase_order_id = v_order2.id and line_number = 1;
    perform place_purchase_order(v_order2.id, 'zz057-place-2');

    v_rc2 := receive_purchase_order(
      v_order2.id, current_date,
      jsonb_build_array(jsonb_build_object(
        'purchase_order_line_id', v_l2, 'quantity', 6, 'unit_cost', 100,
        'reason', 'ZZ057 part delivery, rest to follow')),
      'ZZ057 first six', 'ZZ057-INV-A', null, 'zz057-receive-2a');

    v_rcb := receive_purchase_order(
      v_order2.id, current_date,
      jsonb_build_array(jsonb_build_object(
        'purchase_order_line_id', v_l2, 'quantity', 6, 'unit_cost', 100,
        'reason', 'ZZ057 six more, two past the order')),
      'ZZ057 second six', 'ZZ057-INV-B', null, 'zz057-receive-2b',
      '4057', 'ZZ057 the second six took it past what was ordered');

    -- The second delivery is over by 2 while both stand.
    select coalesce(sum(over_quantity), 0) into v_qty from stock_over_receipts
    where purchase_order_line_id = v_l2;
    if v_qty <> 2 then
      v_fail := v_fail || format(
        '4: with both deliveries standing the line is over by %s, expected 2 — the fixture is not in the state the assertion needs. ', v_qty);
    end if;

    perform reverse_purchase_receipt(
      v_rc2.id, 'ZZ057 the first six never arrived', '4057', 'zz057-reverse-2a');

    -- AND NOW: 6 of 10. Nothing is over.
    select count(*)::integer into v_n from stock_over_receipts
    where purchase_order_line_id = v_l2;
    if v_n <> 0 then
      select string_agg(format('receipt %s over by %s', receipt_number, over_quantity), ', ')
        into v_txt from stock_over_receipts where purchase_order_line_id = v_l2;
      v_fail := v_fail || format(
        '4: after reversing the first of two deliveries the line still reports an over-receipt (%s) — the reversed row is gone but its quantity is still in the running total. ',
        v_txt);
    end if;

    select received_quantity, outstanding_quantity into v_qty, v_out
    from purchase_order_line_status where purchase_order_line_id = v_l2;
    if v_qty <> 6 or v_out <> 4 then
      v_fail := v_fail || format(
        '4: the line reads received=%s outstanding=%s, expected 6/4. ', v_qty, v_out);
    end if;

    -- ---- 6 security_invoker, off pg_class ------------------------------
    select string_agg(c.relname, ', ') into v_txt
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname in ('purchase_order_summary', 'purchase_order_line_status',
                        'supplier_activity', 'stock_over_receipts',
                        'purchase_receipt_line_detail')
      and not coalesce(c.reloptions @> array['security_invoker=on'], false);
    if v_txt is not null then
      v_fail := v_fail || format(
        '6: these views are not security_invoker, so they read past RLS for every tenant: %s. ', v_txt);
    end if;

    if v_fail <> '' then
      raise exception '057 SELF-VERIFY FAILED — %', v_fail;
    end if;

    raise notice '057 SELF-VERIFY: 6 assertions passed.';
    raise exception 'ZZ_057_FIXTURE_DONE';
  exception
    when others then
      if sqlerrm = 'ZZ_057_FIXTURE_DONE' then
        raise notice '057 self-verify complete; fixture rolled back.';
      else
        raise;
      end if;
  end;
end $$
