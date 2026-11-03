-- 049 -- STOCK ACCEPTED ABOVE WHAT WAS ORDERED IS A PROVENANCE QUESTION
--
-- WHAT THE WALK FOUND. 046 gates an over-receipt behind a manager PIN and writes
-- purchase_receipts.authorised_by, and the form promises the manager, in these
-- words, that "the approval is recorded against them by name, permanently, and
-- it can never be edited or deleted". The database kept that promise. No screen
-- in the application showed it: the deliveries table has no authoriser column,
-- and the provenance report returned "No deliveries have gone anywhere other
-- than a store" for an order that had just accepted five litres nobody ordered.
--
-- A promise a screen makes is a specification. This migration supplies the data
-- the fourth section needs; 1.1a's client change renders it.
--
-- ----------------------------------------------------------------------------
-- WHY THE EXISTING THREE SECTIONS DO NOT COVER IT
-- ----------------------------------------------------------------------------
-- 043 section 4's three questions are all about stock arriving in the wrong PLACE:
-- a receipt into a non-store, an opening balance in a location already trading,
-- a position below zero. An over-receipt arrives in exactly the right place, in
-- the wrong QUANTITY -- the same question asked of a different column, and the
-- only other act in the module that spends a manager's PIN.
--
-- ----------------------------------------------------------------------------
-- THE DEFINITION, AND THE TWO WAYS OF GETTING IT WRONG
-- ----------------------------------------------------------------------------
-- A receipt line is over-received to the extent that it pushed the RUNNING total
-- for its order line above the ordered quantity. Two cheaper definitions are
-- both wrong, and the dry run below uses fixtures on which they DISAGREE with
-- this one (rule 27 -- a fixture where the right and wrong answers coincide
-- cannot test either):
--
--   * `rl.quantity > ol.quantity` -- compares one delivery against the whole
--     order. Order 20, take 15 then 10: the second delivery is over by 5 and
--     this test finds nothing, because neither 15 nor 10 exceeds 20.
--
--   * `running_total - ordered`, unclamped -- charges every later delivery with
--     the whole cumulative excess. Order 20, take 25 then 10: the second is over
--     by 10, and the unclamped form reports 15, double-counting the 5 already
--     reported against the first.
--
-- `least(rl.quantity, running_total - ol.quantity)` is the part of THIS delivery
-- that sat above the line, and it sums across deliveries to the true excess.
--
-- ORDERED BY (receipt seq, line_number), never created_at: 036 established that
-- now() is the transaction's start time, so rows written together carry an
-- identical created_at and a running total ordered by it is not deterministic.
-- seq is stamped by the database, monotonic across transactions and never
-- reused, which is the same total order the valuation fold walks in.
--
-- NOT filtered on authorised_by. The over-receipt is a fact about quantities;
-- who approved it is an attribute of that fact. Reading the definition off
-- authorised_by would also silently fold in the not-a-store case, which already
-- has its own section, and would show nothing at all for any row written before
-- the PIN gate existed.

-- ----------------------------------------------------------------------------
-- 1. stock_over_receipts
-- ----------------------------------------------------------------------------
create or replace view stock_over_receipts
with (security_invoker = on) as
with running as (
  select
    rl.id,
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
    s.name  as supplier_name,
    s.code  as supplier_code,
    rl.line_number,
    rl.quantity,
    rl.unit_cost,
    rl.reason,
    rl.note,
    rl.created_by,
    rl.stock_movement_id,
    ol.quantity as ordered_quantity,
    ol.inventory_item_id,
    i.name      as item_name,
    i.code      as item_code,
    i.base_unit,
    l.name      as location_name,
    sum(rl.quantity) over (
      partition by rl.purchase_order_line_id
      order by pr.seq, rl.line_number
      rows between unbounded preceding and current row
    ) as received_to_date
  from purchase_receipt_lines rl
  join purchase_receipts pr
    on pr.id = rl.purchase_receipt_id
   and pr.tenant_id = rl.tenant_id
  join purchase_orders po
    on po.id = pr.purchase_order_id
   and po.tenant_id = pr.tenant_id
  join purchase_order_lines ol
    on ol.id = rl.purchase_order_line_id
   and ol.tenant_id = rl.tenant_id
  join suppliers s
    on s.id = po.supplier_id
   and s.tenant_id = po.tenant_id
  join locations l
    on l.id = pr.location_id
   and l.property_id = pr.property_id
  left join inventory_items i
    on i.id = ol.inventory_item_id
   and i.tenant_id = ol.tenant_id
)
select
  r.id,
  r.tenant_id,
  r.property_id,
  r.purchase_receipt_id,
  r.purchase_order_id,
  r.purchase_order_line_id,
  r.receipt_number,
  r.order_number,
  r.business_date,
  r.created_at,
  r.delivery_note,
  r.invoice_number,
  r.authorised_by,
  r.created_by,
  r.supplier_id,
  r.supplier_name,
  r.supplier_code,
  r.line_number,
  r.inventory_item_id,
  r.item_name,
  r.item_code,
  r.base_unit,
  r.location_name,
  r.ordered_quantity,
  r.received_to_date,
  r.quantity,
  r.unit_cost,
  -- The part of THIS delivery that sat above the ordered quantity.
  least(r.quantity, r.received_to_date - r.ordered_quantity)::numeric(14,4)
    as over_quantity,
  -- What that excess cost, at the price it was invoiced at. The figure the
  -- owner is actually asking about: what did accepting it commit us to.
  round(
    least(r.quantity, r.received_to_date - r.ordered_quantity) * r.unit_cost, 2
  )::numeric(14,2) as over_value,
  r.reason,
  r.note,
  r.stock_movement_id
from running r
where r.received_to_date > r.ordered_quantity;

comment on view stock_over_receipts is
  'Deliveries accepted above what the order asked for -- the second of the two '
  'acts in this product that spend a manager PIN, and the one 043 section 4 did '
  'not cover because its three questions are all about stock arriving in the '
  'wrong PLACE. over_quantity is the part of THIS delivery that pushed the '
  'order line above its ordered quantity, clamped so two deliveries past the '
  'line do not both report the whole cumulative excess. NOT an error list: a '
  'supplier sending a full carton instead of a part one is an ordinary thing '
  'that happened, and the report exists so the owner can see it rather than so '
  'anybody is accused.';

-- The view is security_invoker, so the caller's RLS on purchase_receipt_lines,
-- purchase_orders and the rest applies unchanged -- nothing here widens access.
grant select on stock_over_receipts to authenticated;

-- ----------------------------------------------------------------------------
-- 2. SELF-VERIFY -- four fixtures, each chosen because a CHEAPER definition
--    gives a DIFFERENT answer on it (rule 27).
-- ----------------------------------------------------------------------------
-- NAME THE DEFECT EACH ONE TURNS RED, or it is decoration:
--
--   A  ordered 20, deliveries 15 then 10   -> 1 row, over 5
--      RED for `rl.quantity > ol.quantity`, which finds nothing here because
--      neither delivery on its own exceeds the order.
--
--   B  ordered 20, deliveries 25 then 10   -> 2 rows, over 5 + 10 = 15
--      RED for the UNCLAMPED `received_to_date - ordered`, which reports
--      5 + 15 = 20 and charges the first excess twice.
--
--   C  ordered 20, deliveries 18 then 2    -> 0 rows
--      RED for `>=` instead of `>`. The boundary asserted on the side where
--      the two rules DISAGREE: a line received exactly in full is not over.
--
--   D  ordered 10 at 100, delivery 12 at 250 -> over_value 500
--      RED for valuing the excess at the ORDERED cost, which gives 200.
--      The fixture prices the receipt differently from the order on purpose,
--      because at one price the two readings coincide and neither is tested.
--
-- The whole block runs inside a subtransaction aborted by a sentinel, so nothing
-- it writes survives. stock_movements is append-only (038) and refuses deletion
-- by name, so rolling back is the only way to clean up after it.
do $$
declare
  v_tenant    uuid;
  v_property  uuid;
  v_location  uuid;
  v_item      uuid;
  v_supplier  uuid;
  v_order     uuid;
  v_line      uuid;
  v_receipt   uuid;
  v_move      uuid;
  v_rows      integer;
  v_over      numeric;
  v_fail      text := '';
  v_fix       record;
  v_qty       numeric;
  v_n         integer;
begin
  begin
    select t.id into v_tenant from tenants t limit 1;
    select p.id into v_property from properties p where p.tenant_id = v_tenant limit 1;
    select l.id into v_location from locations l
      where l.property_id = v_property and l.kind = 'store' limit 1;
    select i.id into v_item from inventory_items i
      where i.tenant_id = v_tenant and i.deleted_at is null limit 1;

    if v_tenant is null or v_property is null or v_location is null or v_item is null then
      raise notice '049 self-verify SKIPPED: no tenant, property, store or item to build a fixture from.';
      return;
    end if;

    insert into suppliers (tenant_id, name, code)
    values (v_tenant, 'ZZ049 fixture supplier', 'ZZ049')
    returning id into v_supplier;

    for v_fix in
      select *
      from (values
        ('ZZ049-A', 20::numeric, array[15, 10]::numeric[], 1, 5::numeric),
        ('ZZ049-B', 20::numeric, array[25, 10]::numeric[], 2, 15::numeric),
        ('ZZ049-C', 20::numeric, array[18, 2]::numeric[],  0, 0::numeric)
      ) as f(code, ordered, deliveries, want_rows, want_over)
    loop
      -- A DRAFT order: 046 refuses line changes once an order has been sent,
      -- and this view does not read status, so draft is the honest fixture.
      insert into purchase_orders (
        tenant_id, property_id, supplier_id, order_number, status,
        order_date, destination_location_id
      )
      values (
        v_tenant, v_property, v_supplier, v_fix.code, 'draft',
        current_date, v_location
      )
      returning id into v_order;

      insert into purchase_order_lines (
        tenant_id, purchase_order_id, line_number, line_type,
        inventory_item_id, quantity, unit_cost
      )
      values (v_tenant, v_order, 1, 'inventory', v_item, v_fix.ordered, 100)
      returning id into v_line;

      v_n := 0;
      foreach v_qty in array v_fix.deliveries loop
        v_n := v_n + 1;

        insert into purchase_receipts (
          tenant_id, property_id, purchase_order_id, receipt_number,
          business_date, location_id
        )
        values (
          v_tenant, v_property, v_order, v_fix.code || '-R' || v_n,
          current_date, v_location
        )
        returning id into v_receipt;

        -- A receipt line that moved stock must point at the movement that moved
        -- it (046's movement_shape_check), and the check runs both directions.
        insert into stock_movements (
          tenant_id, property_id, location_id, inventory_item_id,
          movement_type, quantity, unit_cost, business_date, source
        )
        values (
          v_tenant, v_property, v_location, v_item,
          'receipt', v_qty, 100, current_date, 'purchase'
        )
        returning id into v_move;

        insert into purchase_receipt_lines (
          tenant_id, purchase_receipt_id, purchase_order_line_id,
          line_number, quantity, unit_cost, reason, stock_movement_id
        )
        values (
          v_tenant, v_receipt, v_line, 1, v_qty, 100,
          'ZZ049 fixture', v_move
        );
      end loop;

      select count(*), coalesce(sum(over_quantity), 0)
        into v_rows, v_over
      from stock_over_receipts
      where purchase_order_line_id = v_line;

      if v_rows <> v_fix.want_rows then
        v_fail := v_fail || format(
          '%s: expected %s row(s), got %s. ', v_fix.code, v_fix.want_rows, v_rows);
      end if;
      if v_over <> v_fix.want_over then
        v_fail := v_fail || format(
          '%s: expected over_quantity %s, got %s. ', v_fix.code, v_fix.want_over, v_over);
      end if;
    end loop;

    -- FIXTURE D -- the VALUE, at the invoiced price and not the ordered one.
    insert into purchase_orders (
      tenant_id, property_id, supplier_id, order_number, status,
      order_date, destination_location_id
    )
    values (
      v_tenant, v_property, v_supplier, 'ZZ049-D', 'draft',
      current_date, v_location
    )
    returning id into v_order;

    insert into purchase_order_lines (
      tenant_id, purchase_order_id, line_number, line_type,
      inventory_item_id, quantity, unit_cost
    )
    values (v_tenant, v_order, 1, 'inventory', v_item, 10, 100)
    returning id into v_line;

    insert into purchase_receipts (
      tenant_id, property_id, purchase_order_id, receipt_number,
      business_date, location_id
    )
    values (v_tenant, v_property, v_order, 'ZZ049-D-R1', current_date, v_location)
    returning id into v_receipt;

    insert into stock_movements (
      tenant_id, property_id, location_id, inventory_item_id,
      movement_type, quantity, unit_cost, business_date, source
    )
    values (
      v_tenant, v_property, v_location, v_item,
      'receipt', 12, 250, current_date, 'purchase'
    )
    returning id into v_move;

    insert into purchase_receipt_lines (
      tenant_id, purchase_receipt_id, purchase_order_line_id,
      line_number, quantity, unit_cost, reason, stock_movement_id
    )
    values (v_tenant, v_receipt, v_line, 1, 12, 250, 'ZZ049 fixture', v_move);

    select coalesce(sum(over_value), 0) into v_over
    from stock_over_receipts
    where purchase_order_line_id = v_line;

    -- 2 units over at the invoiced 250 = 500. At the ordered 100 it would be
    -- 200, so the two readings disagree on this fixture by design.
    if v_over <> 500 then
      v_fail := v_fail || format(
        'D: expected over_value 500 (2 units at the INVOICED 250), got %s. ', v_over);
    end if;

    if v_fail <> '' then
      raise exception '049 SELF-VERIFY FAILED: %', v_fail;
    end if;

    raise notice '049 self-verify: 7 assertions passed (A 2, B 2, C 2, D 1).';
    raise exception 'ZZ_049_FIXTURE_DONE';
  exception
    when others then
      if sqlerrm = 'ZZ_049_FIXTURE_DONE' then
        null;  -- the fixture rolled itself back; nothing above survives
      else
        raise;
      end if;
  end;
end;
$$;
