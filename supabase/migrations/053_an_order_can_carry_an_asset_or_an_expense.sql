-- 053 — AN ORDER CAN CARRY AN ASSET OR AN EXPENSE (shipment 1.1h3)
--
-- 052 built the places a purchase can land: expense_categories, expenses,
-- fixed_assets, and line_type on the receipt line. This opens the path to them.
-- save_purchase_order stops refusing asset and expense by name, and
-- receive_purchase_order branches on the type instead of assuming stock.
--
-- ONE ORDER, THREE DESTINATIONS, ONE RECEIVE, ONE JOURNAL ENTRY. Rice, a chest
-- freezer and a plumber's call-out on one purchase order: receive it once and
-- the rice moves into the store, the freezer enters the asset register with the
-- supplier on it, the call-out posts to repairs, and all of it lands as a single
-- entry whose credit to the supplier is the sum of three different debits.
--
-- ----------------------------------------------------------------------------
-- THE COLUMN 052 SHOULD HAVE ADDED, AND DID NOT
--
-- `expenses.expense_category_id` is `not null`, and `purchase_order_lines` had
-- no way to say which category a line posts to. So 052 left the receive side
-- unbuildable: an expense line could be ordered but there was nothing to write.
-- That was a gap in 052's own design, found while reading the receive function
-- rather than by anything failing, and it is why this migration starts with a
-- column and not with a function.
--
-- THE CATEGORY IS CHOSEN WHEN ORDERING, NOT WHEN RECEIVING. The person raising
-- the order knows a plumber's call-out is repairs and a drum of bleach is
-- cleaning. The person at the door with a delivery note does not, and asking
-- them at that moment is how a profit and loss ends up with one enormous "other
-- operating" line and five empty ones beside it. It sits on the ORDER line for
-- the same reason the item does.
--
-- ----------------------------------------------------------------------------
-- A GATE THAT WAS WIDER THAN THE RULE IT ENFORCED
--
-- receive_purchase_order demanded a manager's PIN and a written reason whenever
-- the destination was not a store. Section 9's rule is about STOCK -- goods
-- reach a kitchen or a bar by being issued from the store -- so an order of a
-- freezer and a call-out, against an order whose destination happened to be the
-- bar, demanded a manager for a delivery that moves no stock whatsoever, and
-- then listed it on the stock provenance report, where a freezer is not stock.
--
-- The destination half of the gate now also requires that the delivery actually
-- move stock. THE OVER-RECEIPT HALF IS UNCHANGED and still applies to every
-- type: accepting more than was ordered commits the hotel to paying for it, and
-- that is as true of two freezers as of two bags of rice.
--
-- ----------------------------------------------------------------------------
-- BOTH FUNCTIONS ARE BUILT FROM THEIR LIVE TEXT, MECHANICALLY
--
-- 051 was rewritten from memory and silently lost SECURITY DEFINER and its
-- is_tenant_staff gate; the review caught it, no test did. So each change here
-- is a substitution that had to match the live definition EXACTLY ONCE, and the
-- guards were asserted present afterwards by name: SECURITY DEFINER, the
-- search_path, the tenant-staff gate, p_idempotency_key, verify_manager_pin,
-- next_document_number, and the `select m.id from post_stock_receipt(...) m`
-- form that must never become `(post_stock_receipt(...)).id` -- which Postgres
-- expands to one call per output column, posting the line about twenty times.
--
-- ----------------------------------------------------------------------------
-- WHAT THE PROOF WENT RED FOR (rule 27)
--
-- Named defect, then what actually went red. Every one confirmed before the
-- green run was trusted:
--
--   A  the validate loop's join left as an INNER join
--        -> 3: Line 2 is not on purchase order PO-000002
--   B  the movement guard left as `v_qty > 0` without the type test
--        -> 3: That item is not available in this catalogue
--             (post_stock_receipt is handed a null item, which is the shape of
--             the bug rather than the sentence anybody wants -- 052's receipt
--             check would also refuse the row, and they catch it in different
--             places, which is why both exist)
--   C  the expense insert dropped
--        -> 5: expected 1 expense, found 0
--   D  the fixed-asset insert dropped
--        -> 6: expected 1 fixed asset, found 0
--   E  the debit role key left hardcoded to 'inventory'
--        -> 7: the 3 debits landed in 1 distinct account
--   F  the manager gate left as `v_kind <> 'store'` alone
--        -> 8: a delivery that moves no stock was refused for want of a manager
--   G  the idempotency replay removed from receive_purchase_order
--        -> 9: retrying the same delivery raised instead of returning the
--             first receipt
--   H  save's chose-nothing refusal removed, leaving only does-not-exist
--        -> 2: refused with PT404 -- the wrong sentence for the mistake made
--
-- TWO OF THESE STARTED OUT UNABLE TO FAIL, and both were found by running them
-- rather than by reading them:
--
--   * G's first mutation replaced `return v_existing;`, which occurs FOUR
--     times in this file. It hit save_purchase_order's replay, not receive's,
--     and the assertion stayed green -- 052's breakage A exactly, an anchor
--     that is not unique testing whichever copy came first.
--   * H's first form removed save's chose-nothing guard, and assertion 2 stayed
--     green because a SECOND guard catches it: a lookup of a NULL category
--     finds nothing, so "that expense category is not available" came back for
--     a category nobody chose. The assertion asked "was it refused" when the
--     question is "WHICH refusal", and it now asserts PT422 by name. The wrong
--     sentence at the moment somebody is reading it is the whole of rule 21.
--
-- F IS THE ONE THAT NEEDED THE MOST CARE, and it is rule 27's fourth shape. A
-- fixture whose delivery contains BOTH stock and a freezer asks for a PIN under
-- the true rule and the broken one alike, because the stock half triggers the
-- gate either way -- so it cannot test the change. The assertion uses a
-- delivery of a freezer ALONE, which is the only side of the boundary where the
-- two rules disagree.
-- ----------------------------------------------------------------------------


-- ############################################################################
-- SECTION 1 — AN EXPENSE LINE SAYS WHERE IT POSTS
-- ############################################################################
alter table purchase_order_lines
  add column if not exists expense_category_id uuid;

-- THE PAIR, NOT TWO INDEPENDENT FKS (section 6). A line whose tenant_id
-- disagreed with its category's tenant would be a cross-tenant leak that RLS
-- cannot see, because every policy trusts tenant_id directly. 052 gave
-- expense_categories its `unique (id, tenant_id)` to be this FK's target.
alter table purchase_order_lines
  drop constraint if exists purchase_order_lines_expense_category_fk;
alter table purchase_order_lines
  add constraint purchase_order_lines_expense_category_fk
  foreign key (expense_category_id, tenant_id)
  references expense_categories (id, tenant_id);

-- THE SHAPE CHECK GAINS ITS THIRD CLAUSE. 046's two are unchanged, verbatim:
-- an inventory line carries an item and no description, the other two the exact
-- opposite. The new clause is about the category only, and it is NOT NULL-safe
-- by accident -- `is null` and `is not null` are both explicit, because a
-- `<>` against a null here would make the check return NULL, which Postgres
-- accepts as passing and would let every shape through silently.
alter table purchase_order_lines
  drop constraint if exists purchase_order_lines_shape_check;
alter table purchase_order_lines
  add constraint purchase_order_lines_shape_check
  check (
    case line_type
      when 'inventory' then (inventory_item_id is not null and description is null)
      else (inventory_item_id is null
            and description is not null
            and length(btrim(description)) > 0)
    end
    and
    case line_type
      when 'expense' then expense_category_id is not null
      else expense_category_id is null
    end
  );

alter table purchase_order_lines
  validate constraint purchase_order_lines_shape_check;

comment on column purchase_order_lines.expense_category_id is
  'Which expense category this line posts to; required on an expense line and forbidden on the other two (shape check). Resolved to an account through account_mappings by role_key, never stored as an account id — rule 4.';


-- ############################################################################
-- SECTION 2 — save_purchase_order ACCEPTS ALL THREE TYPES
-- ############################################################################
-- Built from the live definition. The only changes: the PT501 refusal of asset
-- and expense is gone, validation is per type, and the insert writes the type
-- it was given instead of the literal 'inventory'.

CREATE OR REPLACE FUNCTION public.save_purchase_order(p_property_id uuid, p_purchase_order_id uuid, p_supplier_id uuid, p_order_date date, p_expected_date date, p_destination_location_id uuid, p_note text, p_lines jsonb, p_idempotency_key text)
 RETURNS purchase_orders
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant   uuid;
  v_timezone text;
  v_today    date;
  v_date     date;
  v_order    purchase_orders;
  v_existing purchase_orders;
  v_digest   text;
  v_number   text;
  v_line     jsonb;
  v_type     text;
  v_item     uuid;
  v_desc     text;
  v_cat      uuid;
  v_qty      numeric;
  v_cost     numeric;
  v_n        integer := 0;
  v_name     text;
begin
  select p.tenant_id, p.timezone into v_tenant, v_timezone
  from properties p
  where p.id = p_property_id and p.deleted_at is null;

  if v_tenant is null then
    raise exception 'Property % not found', p_property_id using errcode = 'PT404';
  end if;

  if not is_tenant_staff(v_tenant) then
    raise exception 'Not authorised to raise purchase orders for this property'
      using errcode = 'insufficient_privilege';
  end if;

  -- ---- the fingerprint of THIS request ------------------------------------
  v_digest := md5(jsonb_build_object(
    'property',    p_property_id,
    'order',       p_purchase_order_id,
    'supplier',    p_supplier_id,
    'order_date',  p_order_date,
    'expected',    p_expected_date,
    'destination', p_destination_location_id,
    'note',        nullif(btrim(coalesce(p_note, '')), ''),
    'lines',       coalesce(p_lines, '[]'::jsonb)
  )::text);

  -- ---- idempotency, with the payload check --------------------------------
  if p_idempotency_key is not null and p_purchase_order_id is null then
    select * into v_existing
    from purchase_orders
    where tenant_id = v_tenant and idempotency_key = p_idempotency_key
    limit 1;

    if found then
      if v_existing.idempotency_digest is distinct from v_digest then
        raise exception
          'This request reuses the key of purchase order %, but asks for something different.',
          v_existing.order_number
          using errcode = 'PT409',
                hint = 'Nothing has been changed. Reload the order and try again — a retry must send exactly what the first attempt sent, or it is a new request and needs a new key.';
      end if;
      return v_existing;
    end if;
  end if;

  -- ---- the supplier -------------------------------------------------------
  select s.name into v_name
  from suppliers s
  where s.id = p_supplier_id
    and s.tenant_id = v_tenant
    and s.deleted_at is null
    and s.is_active = true;

  if v_name is null then
    raise exception 'That supplier is not available'
      using errcode = 'PT404',
            hint = 'A supplier that has been switched off cannot be ordered from. Turn it back on in Suppliers, or choose another.';
  end if;

  -- ---- the destination ----------------------------------------------------
  -- NOT required to be a store. Ordering to a bar is allowed; the DELIVERY is
  -- what needs a manager's authorisation, and refusing it here would mean the
  -- rule was enforced twice, in two places, with two chances to disagree.
  if not exists (
    select 1 from locations l
    where l.id = p_destination_location_id
      and l.property_id = p_property_id
      and l.deleted_at is null
      and l.is_active = true
  ) then
    raise exception 'That stock location is not available for this property'
      using errcode = 'PT404';
  end if;

  -- ---- the date -----------------------------------------------------------
  v_today := (now() at time zone coalesce(nullif(btrim(v_timezone), ''), 'Africa/Lagos'))::date;
  v_date  := coalesce(p_order_date, v_today);

  if v_date > v_today then
    raise exception 'A purchase order cannot be dated in the future (today is % at this property)', v_today
      using errcode = 'PT422',
            hint = 'The order date is the day you raised it. When you expect it to arrive is the expected date.';
  end if;

  if p_expected_date is not null and p_expected_date < v_date then
    raise exception 'The expected date cannot be before the order date'
      using errcode = 'PT422';
  end if;

  -- ---- the lines, validated BEFORE anything is written --------------------
  if p_lines is null or jsonb_typeof(p_lines) <> 'array'
     or jsonb_array_length(p_lines) = 0 then
    raise exception 'A purchase order needs at least one line'
      using errcode = 'PT422',
            hint = 'Add what you are ordering, with a quantity and what you expect to pay for one unit.';
  end if;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_n    := v_n + 1;
    v_type := lower(nullif(btrim(coalesce(v_line ->> 'line_type', 'inventory')), ''));

    -- 053: ALL THREE TYPES ACCEPTED. Until now asset and expense were refused
    -- by name with a hint naming this shipment; 046 declared them and held
    -- their shape so that this is a write path and not a migration against
    -- live orders.
    if v_type is distinct from 'inventory'
       and v_type is distinct from 'asset'
       and v_type is distinct from 'expense' then
      raise exception 'Line %: "%" is not a kind of purchase line.', v_n, v_type
        using errcode = 'PT422',
              hint = 'A line is inventory (stock that enters the store), asset (something the hotel keeps) or expense (a service or a cost that is used up).';
    end if;

    v_item := nullif(btrim(coalesce(v_line ->> 'inventory_item_id', '')), '')::uuid;
    v_desc := nullif(btrim(coalesce(v_line ->> 'description', '')), '');
    v_cat  := nullif(btrim(coalesce(v_line ->> 'expense_category_id', '')), '')::uuid;

    -- WHAT EACH TYPE IDENTIFIES ITSELF BY. The table's shape check enforces the
    -- same pairing, so these raises are the readable half of a rule the
    -- database holds either way -- and each says what to do, not just no.
    if v_type = 'inventory' then
      if v_item is null then
        raise exception 'Line %: choose the item you are ordering.', v_n
          using errcode = 'PT422';
      end if;
      if v_desc is not null then
        raise exception 'Line %: a stock line is named by its item, not by a description.', v_n
          using errcode = 'PT422',
                hint = 'Put anything extra in the line note. The item name is what the store, the ledger and the variance report all read.';
      end if;
      if not exists (
        select 1 from inventory_items i
        where i.id = v_item
          and i.tenant_id = v_tenant
          and i.deleted_at is null
          and i.is_active = true
      ) then
        raise exception 'Line %: that item is not available in this catalogue.', v_n
          using errcode = 'PT404',
                hint = 'An item that has been switched off cannot be ordered. Turn it back on first, or order the item you actually want.';
      end if;
    else
      if v_item is not null then
        raise exception 'Line %: an % line is not a stock item.', v_n, v_type
          using errcode = 'PT422',
                hint = 'Stock enters the store and is counted; an asset is kept and an expense is used up. Describe it in words instead, or change the line to inventory.';
      end if;
      if v_desc is null then
        raise exception 'Line %: say what you are buying.', v_n
          using errcode = 'PT422',
                hint = 'An asset or expense line has no item to name it, so the description is what the order, the invoice and the asset register will all show.';
      end if;
    end if;

    -- AN EXPENSE LINE SAYS WHERE IT POSTS, AND SAYS IT AT ORDER TIME. The
    -- person raising the order knows a plumber's call-out is repairs; the
    -- person at the door receiving it does not, and asking them then is how
    -- everything ends up in "other operating".
    if v_type = 'expense' then
      if v_cat is null then
        raise exception 'Line %: choose what kind of expense this is.', v_n
          using errcode = 'PT422',
                hint = 'It decides which account the cost lands in, so the profit and loss can be read by category instead of as one lump.';
      end if;
      if not exists (
        select 1 from expense_categories c
        where c.id = v_cat
          and c.tenant_id = v_tenant
          and c.deleted_at is null
          and c.is_active = true
      ) then
        raise exception 'Line %: that expense category is not available.', v_n
          using errcode = 'PT404',
                hint = 'A category that has been retired or switched off cannot be used on a new order. Pick a current one, or turn it back on in settings.';
      end if;
    elsif v_cat is not null then
      raise exception 'Line %: only an expense line has an expense category.', v_n
        using errcode = 'PT422',
              hint = 'A stock line posts to inventory and an asset line to fixed assets, both decided by the type rather than chosen.';
    end if;

    v_qty := (v_line ->> 'quantity')::numeric;
    if v_qty is null or v_qty <= 0 then
      raise exception 'Line %: enter how much you are ordering, as a number greater than zero.', v_n
        using errcode = 'PT422';
    end if;

    v_cost := (v_line ->> 'unit_cost')::numeric;
    if v_cost is null or v_cost < 0 then
      raise exception 'Line %: enter what you expect to pay for one unit.', v_n
        using errcode = 'PT422',
              hint = 'It is what the receiving screen compares the invoice against, so a difference is visible while the delivery is still at the door.';
    end if;
  end loop;

  -- ---- create or rewrite --------------------------------------------------
  if p_purchase_order_id is null then
    v_number := next_document_number(v_tenant, p_property_id, 'purchase_order', 'PO');

    begin
      insert into purchase_orders (
        tenant_id, property_id, supplier_id, order_number, status,
        order_date, expected_date, destination_location_id, note,
        idempotency_key, idempotency_digest, created_by
      ) values (
        v_tenant, p_property_id, p_supplier_id, v_number, 'draft',
        v_date, p_expected_date, p_destination_location_id,
        nullif(btrim(coalesce(p_note, '')), ''),
        p_idempotency_key, v_digest, auth.uid()
      )
      returning * into v_order;
    exception
      when unique_violation then
        select * into v_existing
        from purchase_orders
        where tenant_id = v_tenant and idempotency_key = p_idempotency_key
        limit 1;
        if found then
          if v_existing.idempotency_digest is distinct from v_digest then
            raise exception
              'This request reuses the key of purchase order %, but asks for something different.',
              v_existing.order_number
              using errcode = 'PT409',
                    hint = 'Nothing has been changed. Reload the order and try again.';
          end if;
          return v_existing;
        end if;
        raise;
    end;
  else
    select * into v_order
    from purchase_orders
    where id = p_purchase_order_id
      and tenant_id = v_tenant
      and property_id = p_property_id
    for update;

    if not found then
      raise exception 'Purchase order % not found', p_purchase_order_id
        using errcode = 'PT404';
    end if;

    -- AN ORDERED PURCHASE ORDER IS IMMUTABLE.
    if v_order.status <> 'draft' then
      raise exception 'Purchase order % is %, so it can no longer be changed.',
        v_order.order_number, v_order.status
        using errcode = 'PT409',
              hint = case v_order.status
                       when 'cancelled' then 'Raise a new order rather than reviving this one.'
                       else 'Only a draft can be edited. Record what actually arrives on the receiving screen — that is where a delivery differing from the order belongs.'
                     end;
    end if;

    update purchase_orders
       set supplier_id             = p_supplier_id,
           order_date              = v_date,
           expected_date           = p_expected_date,
           destination_location_id = p_destination_location_id,
           note                    = nullif(btrim(coalesce(p_note, '')), ''),
           updated_by              = auth.uid()
     where id = v_order.id
    returning * into v_order;

    -- Replaced whole. The line trigger (2.4) permits this only while the order
    -- is a draft, which the guard above has just established.
    delete from purchase_order_lines where purchase_order_id = v_order.id;
  end if;

  -- ---- the lines ----------------------------------------------------------
  v_n := 0;
  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_n := v_n + 1;
    -- 053: the type is read from the payload rather than hardcoded, and each
    -- type writes only the columns it owns -- the shape check refuses the rest.
    v_type := lower(nullif(btrim(coalesce(v_line ->> 'line_type', 'inventory')), ''));

    insert into purchase_order_lines (
      tenant_id, purchase_order_id, line_number, line_type,
      inventory_item_id, description, expense_category_id,
      quantity, unit_cost, note, created_by
    ) values (
      v_tenant, v_order.id, v_n, v_type,
      case when v_type = 'inventory'
           then nullif(btrim(coalesce(v_line ->> 'inventory_item_id', '')), '')::uuid end,
      case when v_type <> 'inventory'
           then nullif(btrim(coalesce(v_line ->> 'description', '')), '') end,
      case when v_type = 'expense'
           then nullif(btrim(coalesce(v_line ->> 'expense_category_id', '')), '')::uuid end,
      (v_line ->> 'quantity')::numeric,
      round((v_line ->> 'unit_cost')::numeric, 2),
      nullif(btrim(coalesce(v_line ->> 'note', '')), ''),
      auth.uid()
    );
  end loop;

  return v_order;
end;
$function$;

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
  v_unsettled   integer;
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
  -- A line is SETTLED when everything ordered has arrived, or when a receipt
  -- line closed it short. Computed from the rows, never tracked on a counter
  -- column that would be a cache with no recompute function (rule 6).
  select count(*)::integer into v_unsettled
  from purchase_order_lines ol
  where ol.purchase_order_id = v_order.id
    and not exists (
      select 1 from purchase_receipt_lines rl
      where rl.purchase_order_line_id = ol.id and rl.closed_short
    )
    and coalesce((select sum(rl.quantity) from purchase_receipt_lines rl
                  where rl.purchase_order_line_id = ol.id), 0) < ol.quantity;

  update purchase_orders
     set status     = case when v_unsettled = 0 then 'received' else 'part_received' end,
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
-- SECTION 4 — SELF-VERIFY
-- ############################################################################
-- NAME THE DEFECT EACH ONE TURNS RED:
--
--   1  an order carries all three line types, and the shape check holds for
--      each
--      RED if the third clause of the shape check is dropped, or if it is
--      written with `<>` against a null — which returns NULL, which Postgres
--      accepts as passing, which lets every shape through in silence.
--
--   2  an expense line without a category is refused at SAVE time, WITH THE
--      RIGHT SENTENCE
--      RED if save's chose-nothing refusal is dropped (PT404 answers a
--      question nobody asked) or if both its guards go (23514 shows a
--      constraint name). The first version of this assertion checked only that
--      something refused, and could not tell those three apart -- two guards
--      overlap on a NULL category, so removing one left it green.
--
--   3  all three lines can be RECEIVED
--      RED if either loop's join to inventory_items is left as an inner join.
--      This is the defect that made the feature unbuildable: an asset line was
--      reported as "not on purchase order", which is true-sounding and wrong.
--
--   4  only the stock line posts a movement
--      RED if the movement guard is left as `v_qty > 0` without the type test.
--      052's widened receipt-line check would also refuse it, so this asserts
--      the count of movements rather than relying on that — the two catch it in
--      different places and the check could be relaxed later.
--
--   5  the expense line records an expense, with its category and its amount
--      RED if the insert is dropped, or if it reads the wrong line's figures.
--      Asserted on the CATEGORY and the AMOUNT, not on the row count: a count
--      of 1 is insensitive to both.
--
--   6  the asset line records a fixed asset, with the supplier and the order
--      RED if the insert is dropped. Same reasoning as 5.
--
--   7  ONE journal entry, three debits, three DIFFERENT accounts, and a credit
--      that is their sum
--      RED if the debit role key is left hardcoded to 'inventory'. Asserted on
--      the three DISTINCT account ids, because a total is insensitive to which
--      account each debit landed in — rule 27's second shape, and the exact
--      mistake 1.1h made.
--
--   8  a delivery that moves NO stock, into a non-store location, needs no
--      manager PIN
--      RED if the gate is left as `v_kind <> 'store'` alone.
--      THE FIXTURE IS A FREEZER ALONE, deliberately. A delivery containing both
--      stock and a freezer asks for a PIN under the true rule and the broken
--      one alike, because the stock half triggers the gate either way, so it
--      could not test this at all (rule 27's fourth shape). The two rules
--      disagree only where there is no stock.
--
--   9  a RETRIED delivery returns the first receipt and records nothing more
--      RED if the idempotency replay is removed from receive_purchase_order --
--      which it catches on the RAISE, because the retry then falls through to
--      the order-state check. The three counts beside it guard the
--      double-write, which that same state check also happens to prevent
--      today, so they are belt-and-braces rather than what breakage G turns
--      red. Said plainly because a count that something else also protects is
--      exactly what rule 27 warns about.
--      This assertion replaced one that could not fail: it received the line
--      again under a DIFFERENT key and asserted a count of 1, but the second
--      receive was refused by the needs-a-reason rule long before any expense
--      insert, so dropping the unique anchor altogether left it green. A
--      number two different mechanisms produce is not evidence about either.
do $$
declare
  v_tenant   uuid;
  v_prop     uuid;
  v_user     uuid;
  v_loc      uuid;
  v_bar      uuid;
  v_item     uuid;
  v_cat      uuid;
  v_sup      uuid;
  v_order    purchase_orders;
  v_order2   purchase_orders;
  v_receipt  purchase_receipts;
  v_lines    jsonb;
  v_li       uuid;
  v_la       uuid;
  v_le       uuid;
  v_la2      uuid;
  v_n        integer;
  v_amount   numeric(14,2);
  v_acct     uuid;
  v_entry    uuid;
  v_ok       boolean;
  v_fail     text := '';
begin
  begin
    -- A REAL user, because created_by references auth.users and a made-up uuid
    -- would fail on the FK rather than on anything being asserted.
    select tu.tenant_id, tu.user_id into v_tenant, v_user
    from tenant_users tu where tu.is_active limit 1;
    select p.id into v_prop from properties p where p.tenant_id = v_tenant limit 1;

    -- The RPCs are SECURITY DEFINER and gate on is_tenant_staff(), which reads
    -- auth.uid(). Without a session both would refuse, so the dry run supplies
    -- one -- the same shape the gateway sends.
    perform set_config('request.jwt.claims',
      json_build_object('role', 'service_role', 'sub', v_user::text)::text, true);

    select l.id into v_loc from locations l
      where l.property_id = v_prop and l.kind = 'store' limit 1;
    select l.id into v_bar from locations l
      where l.property_id = v_prop and l.kind <> 'store' limit 1;
    select i.id into v_item from inventory_items i
      where i.tenant_id = v_tenant and i.deleted_at is null and i.is_active limit 1;
    select c.id into v_cat from expense_categories c
      where c.tenant_id = v_tenant and c.code = 'repairs' limit 1;

    if v_loc is null or v_item is null or v_cat is null then
      raise exception '053 SELF-VERIFY could not build its fixture (store=%, item=%, category=%)',
        v_loc, v_item, v_cat;
    end if;

    insert into suppliers (tenant_id, name, code)
    values (v_tenant, 'ZZ053 fixture supplier', 'ZZ053') returning id into v_sup;

    -- --- 1, 2. ONE ORDER, THREE TYPES -------------------------------------
    v_lines := jsonb_build_array(
      jsonb_build_object('line_type', 'inventory',
        'inventory_item_id', v_item, 'quantity', 10, 'unit_cost', 100),
      jsonb_build_object('line_type', 'asset',
        'description', 'ZZ053 chest freezer', 'quantity', 1, 'unit_cost', 250000),
      jsonb_build_object('line_type', 'expense',
        'description', 'ZZ053 plumber call-out', 'expense_category_id', v_cat,
        'quantity', 1, 'unit_cost', 25000)
    );

    begin
      v_order := save_purchase_order(
        v_prop, null, v_sup, current_date, current_date + 1, v_loc,
        'ZZ053 mixed order', v_lines, 'zz053-order-1');
    exception when others then
      v_fail := v_fail || format('1: an order of all three types was refused: %s. ', sqlerrm);
    end;

    if v_order.id is not null then
      select count(*) into v_n from purchase_order_lines
        where purchase_order_id = v_order.id;
      if v_n <> 3 then
        v_fail := v_fail || format('1: expected 3 order lines, found %s. ', v_n);
      end if;

      select id into v_li from purchase_order_lines
        where purchase_order_id = v_order.id and line_type = 'inventory';
      select id into v_la from purchase_order_lines
        where purchase_order_id = v_order.id and line_type = 'asset';
      select id into v_le from purchase_order_lines
        where purchase_order_id = v_order.id and line_type = 'expense';

      if v_li is null or v_la is null or v_le is null then
        v_fail := v_fail ||
          '1: the three lines did not keep their types through the insert. ';
      end if;

      select expense_category_id = v_cat into v_ok
        from purchase_order_lines where id = v_le;
      if not coalesce(v_ok, false) then
        v_fail := v_fail ||
          '1: the expense line did not keep its category. ';
      end if;
    end if;

    -- 2. AN EXPENSE LINE WITH NO CATEGORY, refused by name at save time.
    begin
      perform save_purchase_order(
        v_prop, null, v_sup, current_date, current_date + 1, v_loc,
        'ZZ053 uncategorised', jsonb_build_array(
          jsonb_build_object('line_type', 'expense',
            'description', 'ZZ053 nowhere to post', 'quantity', 1, 'unit_cost', 500)),
        'zz053-order-nocat');
      v_fail := v_fail ||
        '2: an expense line saved with no category -- it has nowhere to post. ';
    exception when others then
      -- WHICH REFUSAL, NOT MERELY THAT ONE CAME. Two guards in save overlap on
      -- this input -- "choose what kind of expense this is" and "that expense
      -- category is not available" -- because a lookup of NULL finds nothing
      -- either way. So an assertion that only checked "was it refused" could
      -- not tell a correct save from one where the person who chose nothing is
      -- told the thing they did not choose does not exist. That is the wrong
      -- sentence at the one moment they are reading it (rule 21), and it was
      -- found by probing the defect rather than by the assertion.
      --
      -- PT422 is the chose-nothing refusal. 23514 means save validated nothing
      -- and the table caught it, so the user sees a constraint name. PT404
      -- means the does-not-exist message answered a question nobody asked.
      if sqlstate = '23514' then
        v_fail := v_fail ||
          '2: refused by the table check rather than by save, so the user sees a constraint name instead of a sentence. ';
      elsif sqlstate <> 'PT422' then
        v_fail := v_fail || format(
          '2: refused with %s (%s) -- an expense line with nothing chosen must get the choose-one refusal, not this. ',
          sqlstate, sqlerrm);
      end if;
    end;

    -- --- 3 to 7. RECEIVE ALL THREE ----------------------------------------
    -- PLACED FIRST, through the real RPC. 046's transition trigger refuses a
    -- receipt against a draft, and reaching past it with an `update
    -- purchase_orders set status` would be testing a state the application
    -- cannot produce.
    if v_order.id is not null then
      perform place_purchase_order(v_order.id, 'zz053-place-1');

      begin
        v_receipt := receive_purchase_order(
          v_order.id, current_date,
          jsonb_build_array(
            jsonb_build_object('purchase_order_line_id', v_li, 'quantity', 10, 'unit_cost', 100),
            jsonb_build_object('purchase_order_line_id', v_la, 'quantity', 1, 'unit_cost', 250000),
            jsonb_build_object('purchase_order_line_id', v_le, 'quantity', 1, 'unit_cost', 25000)),
          'ZZ053 delivery note', 'ZZ053-INV', null, 'zz053-receive-1');
      exception when others then
        v_fail := v_fail || format(
          '3: receiving an order with asset and expense lines failed: %s. ', sqlerrm);
      end;
    end if;

    if v_receipt.id is not null then
      -- 4. ONLY THE STOCK LINE MOVED STOCK.
      select count(*) into v_n from purchase_receipt_lines
        where purchase_receipt_id = v_receipt.id and stock_movement_id is not null;
      if v_n <> 1 then
        v_fail := v_fail || format(
          '4: expected exactly 1 line with a stock movement, found %s. ', v_n);
      end if;
      select count(*) into v_n from purchase_receipt_lines
        where purchase_receipt_id = v_receipt.id
          and line_type <> 'inventory' and stock_movement_id is not null;
      if v_n <> 0 then
        v_fail := v_fail || format(
          '4: %s non-stock line(s) posted a stock movement. ', v_n);
      end if;

      -- 5. THE EXPENSE, by its category and its amount.
      select count(*) into v_n from expenses e
        join purchase_receipt_lines rl on rl.id = e.purchase_receipt_line_id
        where rl.purchase_receipt_id = v_receipt.id;
      if v_n <> 1 then
        v_fail := v_fail || format('5: expected 1 expense, found %s. ', v_n);
      else
        select e.expense_category_id = v_cat and e.amount = 25000.00
               and e.supplier_id = v_sup and e.business_date = current_date
          into v_ok
        from expenses e
        join purchase_receipt_lines rl on rl.id = e.purchase_receipt_line_id
        where rl.purchase_receipt_id = v_receipt.id;
        if not coalesce(v_ok, false) then
          select format('category=%s amount=%s supplier=%s date=%s',
                        e.expense_category_id = v_cat, e.amount,
                        e.supplier_id = v_sup, e.business_date)
            into v_fail
          from expenses e
          join purchase_receipt_lines rl on rl.id = e.purchase_receipt_line_id
          where rl.purchase_receipt_id = v_receipt.id;
          v_fail := format('5: the expense was recorded wrong (%s). ', v_fail);
        end if;
      end if;

      -- 6. THE FIXED ASSET, by its cost, supplier and order.
      select count(*) into v_n from fixed_assets fa
        join purchase_receipt_lines rl on rl.id = fa.purchase_receipt_line_id
        where rl.purchase_receipt_id = v_receipt.id;
      if v_n <> 1 then
        v_fail := v_fail || format('6: expected 1 fixed asset, found %s. ', v_n);
      else
        select fa.cost = 250000.00 and fa.supplier_id = v_sup
               and fa.purchase_order_id = v_order.id
               and fa.acquired_on = current_date
               and fa.name = 'ZZ053 chest freezer'
          into v_ok
        from fixed_assets fa
        join purchase_receipt_lines rl on rl.id = fa.purchase_receipt_line_id
        where rl.purchase_receipt_id = v_receipt.id;
        if not coalesce(v_ok, false) then
          v_fail := v_fail ||
            '6: the fixed asset was recorded wrong (cost, supplier, order, date or name). ';
        end if;
      end if;

      -- 7. ONE ENTRY, THREE DISTINCT DEBIT ACCOUNTS, CREDIT = THEIR SUM.
      select je.id into v_entry from journal_entries je
        where je.source_document_type = 'goods_receipt'
          and je.source_document_id = v_receipt.id;
      if v_entry is null then
        v_fail := v_fail || '7: the delivery posted no journal entry. ';
      else
        select count(*), count(distinct account_id) into v_n, v_amount
        from journal_entry_lines where journal_entry_id = v_entry and debit > 0;
        if v_n <> 3 then
          v_fail := v_fail || format('7: expected 3 debits, found %s. ', v_n);
        end if;
        -- THE ASSERTION THAT MATTERS. Three debits summing correctly says
        -- nothing about WHERE they went; a role key left hardcoded to
        -- 'inventory' debits one account three times and the total is
        -- identical. So: three DISTINCT accounts.
        if v_amount <> 3 then
          v_fail := v_fail || format(
            '7: the 3 debits landed in %s distinct account(s) -- the debit role key is not this line''s own. ',
            v_amount);
        end if;

        -- journal_entry_lines carries role_key, so this reads the key the
        -- posting actually used rather than re-resolving the account and
        -- comparing ids -- fewer moving parts between the assertion and the
        -- thing asserted.
        select count(*) into v_n from journal_entry_lines
          where journal_entry_id = v_entry
            and role_key = 'expense_repairs' and debit = 25000.00;
        if v_n <> 1 then
          v_fail := v_fail ||
            '7: the plumber''s call-out did not debit the repairs account. ';
        end if;

        select sum(credit) into v_amount
        from journal_entry_lines where journal_entry_id = v_entry;
        if v_amount <> 276000.00 then
          v_fail := v_fail || format(
            '7: the credit to the supplier is %s, not the 276,000.00 the three debits come to. ', v_amount);
        end if;
      end if;
    end if;

    -- --- 8. NO STOCK MOVES, SO NO MANAGER IS NEEDED ------------------------
    -- A FREEZER ALONE, into the bar. Under the rule as it was, this demanded a
    -- PIN and a reason; under the rule as it is, it needs neither, because
    -- nothing entered stock anywhere.
    if v_bar is not null then
      v_order2 := save_purchase_order(
        v_prop, null, v_sup, current_date, current_date + 1, v_bar,
        'ZZ053 freezer for the bar', jsonb_build_array(
          jsonb_build_object('line_type', 'asset',
            'description', 'ZZ053 bar freezer', 'quantity', 1, 'unit_cost', 180000)),
        'zz053-order-2');

      select id into v_la2 from purchase_order_lines
        where purchase_order_id = v_order2.id and line_type = 'asset';

      perform place_purchase_order(v_order2.id, 'zz053-place-2');

      begin
        perform receive_purchase_order(
          v_order2.id, current_date,
          jsonb_build_array(jsonb_build_object(
            'purchase_order_line_id', v_la2, 'quantity', 1, 'unit_cost', 180000)),
          null, 'ZZ053-INV2', null, 'zz053-receive-2');
      exception when others then
        v_fail := v_fail || format(
          '8: a delivery that moves no stock was refused for want of a manager: %s. ', sqlerrm);
      end;
    end if;

    -- --- 9. A RETRIED DELIVERY RECORDS ONE EXPENSE AND ONE ASSET ----------
    -- THE FIRST VERSION OF THIS ASSERTION WAS DECORATION, and it is worth
    -- saying why. It receIved the same line a second time with a different key
    -- and asserted that only one expense existed -- but the second receive was
    -- refused long before the expense insert, by the rule that a quantity
    -- differing from what is outstanding needs a reason. So dropping the unique
    -- anchor entirely would have left it GREEN. It asserted a number that two
    -- different mechanisms produce, which is rule 27's first trap wearing a
    -- different coat.
    --
    -- AND THE ANCHOR DOES NOT DO WHAT THAT ASSERTION IMAGINED. It is unique per
    -- receipt LINE, and a second receive makes a second receipt line, so a
    -- genuine second delivery against one order line SHOULD record a second
    -- expense -- two plumber visits billed on one line are two costs.
    --
    -- The property that actually protects the hotel is the RETRY: the same
    -- delivery sent twice, which is what a double-click and a dropped
    -- connection both produce. It must return the first receipt and record
    -- nothing more. That is the idempotency key and the anchor together, and
    -- breakage G removes the replay to prove this can fail.
    if v_receipt.id is not null then
      -- THE RETRY IS CAUGHT, so this assertion names what happened instead of
      -- letting a bare Postgres error out. Removing the replay makes the retry
      -- fall through to the order-state check and RAISE -- which is the defect,
      -- and an unguarded call would have surfaced it as
      -- "Purchase order PO-000002 is received" with nothing to say that a
      -- double-click is what produced it.
      begin
        perform receive_purchase_order(
          v_order.id, current_date,
          jsonb_build_array(
            jsonb_build_object('purchase_order_line_id', v_li, 'quantity', 10, 'unit_cost', 100),
            jsonb_build_object('purchase_order_line_id', v_la, 'quantity', 1, 'unit_cost', 250000),
            jsonb_build_object('purchase_order_line_id', v_le, 'quantity', 1, 'unit_cost', 25000)),
          'ZZ053 delivery note', 'ZZ053-INV', null, 'zz053-receive-1');
      exception when others then
        v_fail := v_fail || format(
          '9: retrying the same delivery raised instead of returning the first receipt: %s. ', sqlerrm);
      end;

      select count(*) into v_n from expenses e
        join purchase_receipt_lines rl on rl.id = e.purchase_receipt_line_id
        join purchase_order_lines ol on ol.id = rl.purchase_order_line_id
        where ol.id = v_le;
      if v_n <> 1 then
        v_fail := v_fail || format(
          '9: retrying the same delivery recorded %s expenses. ', v_n);
      end if;

      select count(*) into v_n from fixed_assets fa
        join purchase_receipt_lines rl on rl.id = fa.purchase_receipt_line_id
        join purchase_order_lines ol on ol.id = rl.purchase_order_line_id
        where ol.id = v_la;
      if v_n <> 1 then
        v_fail := v_fail || format(
          '9: retrying the same delivery recorded %s fixed assets. ', v_n);
      end if;

      select count(*) into v_n from purchase_receipts
        where purchase_order_id = v_order.id;
      if v_n <> 1 then
        v_fail := v_fail || format(
          '9: retrying the same delivery made %s receipts. ', v_n);
      end if;
    end if;

    if v_fail <> '' then
      raise exception '053 SELF-VERIFY FAILED: %', v_fail;
    end if;

    raise notice '053 self-verify: 9 assertions passed (2 save, 7 receive).';
    raise exception 'ZZ_053_FIXTURE_DONE';
  exception
    when others then
      if sqlerrm = 'ZZ_053_FIXTURE_DONE' then
        null;  -- the fixture rolled itself back; nothing above survives
      else
        raise;
      end if;
  end;
end;
$$;
