-- 054 — THE ORDER LINE SAYS WHICH EXPENSE CATEGORY (shipment 1.1h3)
--
-- 053 put expense_category_id on purchase_order_lines; the screens need its
-- NAME. Without it an expense line renders as a description and an amount with
-- nothing to say where the cost lands, which is the one thing the category was
-- added to decide.
--
-- REBUILT FROM THE LIVE DEFINITION, two substitutions, each matching exactly
-- once. 051 was rewritten from memory and lost SECURITY DEFINER and an
-- authorisation gate; a view has the same exposure through security_invoker,
-- so this file carries it explicitly and asserts it afterwards.
--
-- THE JOIN IS LEFT, AND DELIBERATELY DOES NOT FILTER ec.deleted_at.
-- Section 6 warns that soft-deleted parents do not cascade and that every join
-- to one must filter it. The exception is a query whose job is to say what a
-- HISTORICAL row points at: an order raised in March against a category retired
-- in June must still name that category, or last quarter's orders turn
-- unreadable the day somebody tidies the settings list. Filtering here would
-- blank the name rather than hide the row -- the worst of both, since the line
-- would then look like an expense posting nowhere.
--
-- ----------------------------------------------------------------------------
-- WHAT THE PROOF WENT RED FOR (rule 27)
--
--   A  the three new columns dropped from the select list
--        -> 1: purchase_order_line_status does not expose the expense category
--   B  the join narrowed to `ec.deleted_at is null`
--        -> 3: a line against a RETIRED category lost its name
--   C  security_invoker left off the view
--        -> 4: the view does not run as its caller, so RLS would be bypassed
-- ----------------------------------------------------------------------------

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
          WHERE rl.purchase_order_line_id = ol.id) r ON true;

comment on view purchase_order_line_status is
  'One order line with what has arrived against it, and -- for an expense line -- the category it posts to. outstanding_quantity is computed exactly as receive_purchase_order computes it, so the screen and a refusal cannot disagree. The expense_categories join is deliberately unfiltered on deleted_at so a historical line still names a retired category.';

-- ############################################################################
-- SELF-VERIFY
-- ############################################################################
-- NAME THE DEFECT EACH ONE TURNS RED:
--
--   1  the three columns exist on the view
--      RED if they are dropped from the select list.
--
--   2  an expense line reads back its category's code and name
--      RED if the join is wrong -- on the wrong column, or to the wrong table.
--      Asserted on the NAME, not on the id: the id is already on the line, so
--      an assertion that only checked it would pass with the join removed.
--
--   3  a line against a RETIRED category STILL names it
--      RED if the join gains `and ec.deleted_at is null`, which is the
--      obvious-looking fix that section 6's warning invites. The fixture
--      retires the category AFTER the order is raised, because a fixture that
--      retired it first could not tell the two behaviours apart -- the line
--      would never have had a name to lose.
--
--   4  the view runs as its caller
--      RED if `with (security_invoker = on)` is omitted, which would make the
--      view read with the OWNER's rights and hand every tenant's order lines to
--      anybody who can select from it. Rule 13's floor, asserted rather than
--      assumed, because a `create or replace view` that forgets it is silent.
do $$
declare
  v_tenant  uuid;
  v_user    uuid;
  v_prop    uuid;
  v_loc     uuid;
  v_cat     uuid;
  v_sup     uuid;
  v_order   purchase_orders;
  v_le      uuid;
  v_n       integer;
  v_row     record;
  v_fail    text := '';
begin
  begin
    select count(*) into v_n
    from information_schema.columns
    where table_name = 'purchase_order_line_status'
      and column_name in ('expense_category_id', 'expense_category_code',
                          'expense_category_name');
    -- RAISED HERE AND NOT COLLECTED, because every assertion below selects
    -- these columns and would fail with `column "expense_category_id" does not
    -- exist` instead -- a true error carrying none of the reason. Breakage A
    -- proved that: it went red on the raw column error, which is detection
    -- without a sentence, and rule 27 is about what the next person inherits.
    if v_n <> 3 then
      raise exception '054 SELF-VERIFY FAILED: 1: purchase_order_line_status exposes % of the 3 expense category columns (expense_category_id, expense_category_code, expense_category_name).', v_n;
    end if;

    -- 4. SECURITY INVOKER, read off pg_class rather than trusted.
    select count(*) into v_n from pg_class c
      where c.relname = 'purchase_order_line_status'
        and 'security_invoker=on' = any(c.reloptions);
    if v_n <> 1 then
      v_fail := v_fail ||
        '4: the view does not run as its caller -- security_invoker is off, so it reads with the owner''s rights and RLS is bypassed. ';
    end if;

    select tu.tenant_id, tu.user_id into v_tenant, v_user
      from tenant_users tu where tu.is_active limit 1;
    select p.id into v_prop from properties p where p.tenant_id = v_tenant limit 1;
    perform set_config('request.jwt.claims',
      json_build_object('role', 'service_role', 'sub', v_user::text)::text, true);
    select l.id into v_loc from locations l
      where l.property_id = v_prop and l.kind = 'store' limit 1;
    select c.id into v_cat from expense_categories c
      where c.tenant_id = v_tenant and c.code = 'cleaning' limit 1;

    insert into suppliers (tenant_id, name, code)
    values (v_tenant, 'ZZ054 fixture supplier', 'ZZ054') returning id into v_sup;

    v_order := save_purchase_order(
      v_prop, null, v_sup, current_date, current_date + 1, v_loc,
      'ZZ054 category naming', jsonb_build_array(jsonb_build_object(
        'line_type', 'expense', 'description', 'ZZ054 drum of bleach',
        'expense_category_id', v_cat, 'quantity', 1, 'unit_cost', 9000)),
      'zz054-order-1');

    select purchase_order_line_id into v_le from purchase_order_line_status
      where purchase_order_id = v_order.id;

    -- 2. THE NAME, not the id.
    select expense_category_id, expense_category_code, expense_category_name
      into v_row
    from purchase_order_line_status where purchase_order_line_id = v_le;

    if v_row.expense_category_id is distinct from v_cat then
      v_fail := v_fail || '2: the line does not carry its category id. ';
    end if;
    if v_row.expense_category_code is distinct from 'cleaning'
       or v_row.expense_category_name is null then
      v_fail := v_fail || format(
        '2: the category did not come through the join (code=%s, name=%s). ',
        coalesce(v_row.expense_category_code, 'NULL'),
        coalesce(v_row.expense_category_name, 'NULL'));
    end if;

    -- 3. RETIRE IT, AFTER the order exists, and read the line again.
    update expense_categories set deleted_at = now() where id = v_cat;

    select expense_category_code, expense_category_name into v_row
    from purchase_order_line_status where purchase_order_line_id = v_le;

    if v_row.expense_category_name is null then
      v_fail := v_fail ||
        '3: retiring the category blanked its name on an order already raised -- the join is filtering deleted_at. ';
    end if;

    if v_fail <> '' then
      raise exception '054 SELF-VERIFY FAILED: %', v_fail;
    end if;

    raise notice '054 self-verify: 4 assertions passed.';
    raise exception 'ZZ_054_FIXTURE_DONE';
  exception
    when others then
      if sqlerrm = 'ZZ_054_FIXTURE_DONE' then
        null;  -- the fixture rolled itself back, the retired category included
      else
        raise;
      end if;
  end;
end;
$$;
