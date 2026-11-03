-- 055 — THE DELIVERY HISTORY NAMES A NON-STOCK LINE (shipment 1.1h3)
--
-- purchase_receipt_line_detail joins inventory_items for the name, so an asset
-- or expense line came back with item_name NULL and the delivery history
-- rendered the shared em-dash placeholder for it. A freezer that arrived last
-- Tuesday showed as a quantity, a cost and a dash.
--
-- That is section 6's MISSING_VALUE doing exactly its job -- it says "no value"
-- rather than leaving a gap that looks like a layout bug -- and the gap was
-- real: the row HAS a name, in ol.description, and nothing was reading it.
--
-- THE TYPE IS READ FROM THE RECEIPT LINE, not the order line. 053's composite
-- FK binds the pair, so they cannot disagree, and taking it from the row in
-- front of you is one join fewer to get wrong.
--
-- Rebuilt from the LIVE definition, two substitutions, each matching exactly
-- once, with security_invoker carried explicitly and asserted (051's lesson).
--
-- ----------------------------------------------------------------------------
-- WHAT THE PROOF WENT RED FOR (rule 27)
--
--   A  the four new columns dropped
--        -> 1: purchase_receipt_line_detail does not name a non-stock line
--   B  the type read from the ORDER line instead of the receipt line
--        -> no assertion: 053's composite FK makes the two provably equal, so
--           an assertion here could not fail and would be decoration. Said out
--           loud rather than written as a green check.
--   C  security_invoker left off
--        -> 3: the view does not run as its caller
-- ----------------------------------------------------------------------------

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
    ec.name AS expense_category_name
   FROM purchase_receipt_lines rl
     JOIN purchase_receipts pr ON pr.id = rl.purchase_receipt_id AND pr.tenant_id = rl.tenant_id
     JOIN purchase_orders po ON po.id = pr.purchase_order_id AND po.tenant_id = pr.tenant_id
     JOIN purchase_order_lines ol ON ol.id = rl.purchase_order_line_id AND ol.tenant_id = rl.tenant_id
     LEFT JOIN inventory_items i ON i.id = ol.inventory_item_id AND i.tenant_id = ol.tenant_id
     LEFT JOIN expense_categories ec ON ec.id = ol.expense_category_id AND ec.tenant_id = ol.tenant_id;

comment on view purchase_receipt_line_detail is
  'Every delivery line with what was ordered beside what arrived, and the name of the thing -- an item name for stock, a description for an asset or an expense, plus that expense''s category. line_type is read off the receipt line, which 053''s composite FK keeps equal to the order line''s.';

-- ############################################################################
-- SELF-VERIFY
-- ############################################################################
-- NAME THE DEFECT EACH ONE TURNS RED:
--
--   1  the four columns exist on the view
--      RED if they are dropped. Raised immediately rather than collected,
--      because assertion 2 selects them and would otherwise fail with a raw
--      "column does not exist" carrying none of the reason -- which is what
--      054's breakage A did before it was fixed.
--
--   2  an asset line reads back a name, and an expense line its category
--      RED if the join or the column choice is wrong. Asserted on the
--      DESCRIPTION and the CATEGORY NAME, not on line_type: the type is copied
--      from a column that is already on the row, so an assertion on it alone
--      would pass with both joins removed.
--
--   3  the view runs as its caller
--      RED if `with (security_invoker = on)` is omitted, which would hand every
--      tenant's delivery lines to anybody who can select from the view.
do $$
declare
  v_tenant  uuid;
  v_user    uuid;
  v_prop    uuid;
  v_loc     uuid;
  v_cat     uuid;
  v_sup     uuid;
  v_order   purchase_orders;
  v_receipt purchase_receipts;
  v_la      uuid;
  v_le      uuid;
  v_n       integer;
  v_row     record;
  v_fail    text := '';
begin
  begin
    select count(*) into v_n
    from information_schema.columns
    where table_name = 'purchase_receipt_line_detail'
      and column_name in ('line_type', 'description', 'expense_category_id',
                          'expense_category_name');
    if v_n <> 4 then
      raise exception '055 SELF-VERIFY FAILED: 1: purchase_receipt_line_detail exposes % of the 4 columns that name a non-stock line.', v_n;
    end if;

    select count(*) into v_n from pg_class c
      where c.relname = 'purchase_receipt_line_detail'
        and 'security_invoker=on' = any(c.reloptions);
    if v_n <> 1 then
      v_fail := v_fail ||
        '3: the view does not run as its caller -- security_invoker is off, so it reads with the owner''s rights and RLS is bypassed. ';
    end if;

    select tu.tenant_id, tu.user_id into v_tenant, v_user
      from tenant_users tu where tu.is_active limit 1;
    select p.id into v_prop from properties p where p.tenant_id = v_tenant limit 1;
    perform set_config('request.jwt.claims',
      json_build_object('role', 'service_role', 'sub', v_user::text)::text, true);
    select l.id into v_loc from locations l
      where l.property_id = v_prop and l.kind = 'store' limit 1;
    select c.id into v_cat from expense_categories c
      where c.tenant_id = v_tenant and c.code = 'transport' limit 1;

    insert into suppliers (tenant_id, name, code)
    values (v_tenant, 'ZZ055 fixture supplier', 'ZZ055') returning id into v_sup;

    v_order := save_purchase_order(
      v_prop, null, v_sup, current_date, current_date + 1, v_loc,
      'ZZ055 naming', jsonb_build_array(
        jsonb_build_object('line_type', 'asset',
          'description', 'ZZ055 delivery van', 'quantity', 1, 'unit_cost', 4000000),
        jsonb_build_object('line_type', 'expense',
          'description', 'ZZ055 diesel run', 'expense_category_id', v_cat,
          'quantity', 1, 'unit_cost', 30000)),
      'zz055-order-1');

    select id into v_la from purchase_order_lines
      where purchase_order_id = v_order.id and line_type = 'asset';
    select id into v_le from purchase_order_lines
      where purchase_order_id = v_order.id and line_type = 'expense';

    perform place_purchase_order(v_order.id, 'zz055-place-1');

    v_receipt := receive_purchase_order(
      v_order.id, current_date,
      jsonb_build_array(
        jsonb_build_object('purchase_order_line_id', v_la, 'quantity', 1, 'unit_cost', 4000000),
        jsonb_build_object('purchase_order_line_id', v_le, 'quantity', 1, 'unit_cost', 30000)),
      null, 'ZZ055-INV', null, 'zz055-receive-1');

    -- 2. THE ASSET LINE HAS A NAME.
    select line_type, description, expense_category_name into v_row
    from purchase_receipt_line_detail
    where purchase_receipt_id = v_receipt.id and purchase_order_line_id = v_la;

    if v_row.description is distinct from 'ZZ055 delivery van' then
      v_fail := v_fail || format(
        '2: the asset line came back named %s instead of its description. ',
        coalesce(v_row.description, 'NULL'));
    end if;
    if v_row.line_type is distinct from 'asset' then
      v_fail := v_fail || '2: the asset line did not report its type. ';
    end if;
    if v_row.expense_category_name is not null then
      v_fail := v_fail ||
        '2: the asset line carries an expense category, which only an expense line has. ';
    end if;

    -- AND THE EXPENSE LINE HAS ITS CATEGORY.
    select line_type, description, expense_category_name into v_row
    from purchase_receipt_line_detail
    where purchase_receipt_id = v_receipt.id and purchase_order_line_id = v_le;

    if v_row.description is distinct from 'ZZ055 diesel run' then
      v_fail := v_fail || format(
        '2: the expense line came back named %s. ', coalesce(v_row.description, 'NULL'));
    end if;
    if v_row.expense_category_name is null then
      v_fail := v_fail ||
        '2: the expense line does not name its category, so the delivery history cannot say where the cost went. ';
    end if;

    if v_fail <> '' then
      raise exception '055 SELF-VERIFY FAILED: %', v_fail;
    end if;

    raise notice '055 self-verify: 3 assertions passed.';
    raise exception 'ZZ_055_FIXTURE_DONE';
  exception
    when others then
      if sqlerrm = 'ZZ_055_FIXTURE_DONE' then
        null;  -- the fixture rolled itself back
      else
        raise;
      end if;
  end;
end;
$$;
