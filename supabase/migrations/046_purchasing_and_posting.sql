-- ============================================================================
-- 046_purchasing_and_posting.sql
-- Palstro-Hotels: PURCHASING — suppliers, purchase orders and goods receipts —
-- and the shipment in which every stock RPC that moves money starts posting.
-- ============================================================================
--
-- ----------------------------------------------------------------------------
-- §0 — DOES 044'S SHAPE NEED TO CHANGE NOW THAT POSTING IS IN IT? NO.
-- ----------------------------------------------------------------------------
-- The spine was designed against every posting site at once (044's header says
-- so) and this migration is the test of that claim. It holds:
--
--   * Every role key this shipment posts through was already seeded and mapped —
--     inventory, supplier_payable, cash, opening_balance_equity, stock_adjustment,
--     stock_variance, the five wastage_* keys, rounding_difference. Nothing here
--     needed a key 044 did not anticipate.
--   * ONE line may be left open and becomes the sum of the other side. A goods
--     receipt is exactly that shape: N debits built from the real line figures,
--     one credit that is their sum. Computing both sides independently is what
--     044 refused to allow, and it is what would have made a receipt disagree
--     with itself by a kobo.
--   * (tenant_id, source_document_type, source_document_id) UNIQUE is what makes
--     a retried receipt post once. Both new document types — 'stock_movement'
--     and 'goods_receipt' — key cleanly against it.
--   * post_journal returning NULL before gl_start_date, and leaving the calling
--     document untouched, is what lets every one of these RPCs be wired TODAY
--     against a database full of test movements.
--
-- ONE THING POSTING FORCES, and it is inside post_stock_receipt rather than
-- inside 044: a receipt that is part of a goods receipt must NOT post its own
-- per-movement entry, because the GRN posts one entry for the whole delivery.
-- That is the additive extension to post_stock_receipt (§5.4), not a change to
-- the spine.
--
-- TWO THINGS FOUND WHILE WIRING, RECORDED HERE RATHER THAN FIXED SILENTLY:
--
--   1. THE LEDGER AND THE VALUATION AGREE TO THE KOBO ONLY WHERE THE ARITHMETIC
--      IS EXACT, AND THE DIFFERENCE IS NOT A BUG IN EITHER. The GL holds the sum
--      of per-movement values, each rounded to 2dp as money must be. The stock
--      valuation holds quantity times a moving average carried at full
--      precision, rounded once at the end. Those two are equal whenever the
--      average lands on two decimals — which is every ordinary delivery — and
--      can differ by a kobo when it does not. SECTION 7.3 therefore asserts the
--      STRONG invariant exactly (the GL equals the sum of the movement values,
--      to the kobo, which is the assertion the ERP could not make) and REPORTS
--      the residue against the valuation instead of hiding it. See 7.3's header
--      for the worked case.
--
--   2. A POSITION THAT HAS PASSED THROUGH NEGATIVE breaks the value identity for
--      a real reason, not a rounding one: the fold RESETS the average to the
--      incoming cost when stock arrives into a negative position (038 SECTION
--      5.1), because there is no sensible average to weight against less than
--      nothing. The GL, correctly, recorded what happened. SECTION 7.3 names
--      those positions rather than absorbing them, which is the whole point of
--      not having a suspense account.
--
-- NOT CHANGED, and it is a decision: accounts.code '2110' VAT input recoverable
-- is typed `liability` where a strict reading makes it an asset. It is seeded,
-- UNMAPPED, and nothing writes it; retyping it would also mean renumbering it
-- into the 1000 block, because 045 asserts that (section rank, code) reproduces
-- statement order. That is a change for 1.1h3, which brings tax on a purchase
-- line and is the shipment that gives the account a writer.
--
-- ----------------------------------------------------------------------------
-- WHAT THIS MIGRATION IS
-- ----------------------------------------------------------------------------
-- IS:  five tables (suppliers, purchase_orders, purchase_order_lines,
--      purchase_receipts, purchase_receipt_lines); four purchasing RPCs
--      (save_purchase_order, place_purchase_order, cancel_purchase_order,
--      receive_purchase_order); ONE journal-posting helper and the wiring of it
--      into all six existing stock RPCs; the reconciliation between the ledger's
--      inventory account and the stock valuation; the read surfaces the two new
--      screens need.
--
-- IS NOT: supplier payments, supplier bills or ageing (1.1h5 — see SECTION 1's
--      header, which is where the gap is recorded); asset or expense purchase
--      lines (1.1h3, refused BY NAME here rather than being absent); tax on a
--      purchase line (1.1h3); requisitions or transfers (part 3); a trial
--      balance or any other report over the ledger (stage 11).
--
-- ----------------------------------------------------------------------------
-- RE-RUNNABLE. Applying this file twice in one transaction is a clean no-op.
-- ============================================================================


-- ############################################################################
-- SECTION 1 — suppliers
-- ############################################################################
-- TENANT-LEVEL, exactly as the inventory catalogue is. A group that buys rice
-- from Bonny Fresh Foods for two hotels has ONE supplier record; the ORDER is
-- what carries a property. Splitting suppliers per property would mean the same
-- company's TIN keyed twice and a payment history that adds up to nothing.
--
-- ----------------------------------------------------------------------------
-- THE GAP THIS TABLE MAKES VISIBLE, STATED BEFORE IT IS BUILT
-- ----------------------------------------------------------------------------
-- Receiving CREDITS supplier_payable, and NOTHING IN THIS SHIPMENT EVER DEBITS
-- IT. Every delivery raises what the hotel owes and there is no document that
-- brings it back down, so the account only ever grows: Heledon's first trial
-- balance would carry a liability that has never once been paid, and a balance
-- sheet wrong in a way anybody who reads one would spot immediately.
--
-- PAYING SUPPLIERS IS 1.1h5, BEFORE GO-LIVE. It was stage 7.3, which is after
-- go-live, and that is now wrong for the same reason the ledger itself moved
-- forward: the debt accrues from the first delivery. Three things follow, and
-- they are the whole of what this shipment owes that one:
--
--   * supplier_activity (SECTION 7.2) STAYS ONE-SIDED and keeps that name. It
--     lists what was ordered and what arrived. It is not an account, it does not
--     total to a balance, and it must not start looking like one.
--   * NO BALANCE IS INVENTED FROM RECEIPTS ALONE. A figure called "owed" that
--     is really "received" is worse than no figure, because it is right until
--     the first payment and wrong forever after, silently.
--   * THE RECEIPT IS THE DOCUMENT A PAYMENT WILL ALLOCATE AGAINST. Its id is
--     stable, its line figures are the invoiced ones, and nothing derivable is
--     snapshotted onto it — so an allocation table can hang off it in 1.1h5
--     without anything here being reshaped.
--
-- ----------------------------------------------------------------------------
-- THE FOUR PAYMENT COLUMNS ARE HERE NOW BECAUSE THE TABLE IS EMPTY NOW
-- ----------------------------------------------------------------------------
-- Adding a column to a table with no rows costs nothing. Adding one to a live
-- supplier list is a backfill conversation with a hotel, item by item, months
-- after the person who knew the answers stopped picking up. tax_id,
-- withholding_tax_rate and the three bank fields are captured because 1.1h5 will
-- need every one of them and the form that collects them is being built today.
--
-- NOTHING COMPUTES WITH ANY OF THEM IN THIS SHIPMENT. withholding_tax_rate in
-- particular is INFORMATIONAL: services and goods withhold at different rates in
-- Nigeria and the rate is a property of the relationship rather than of a
-- payment, which is why it sits here rather than on a document — but no RPC
-- reads it and no figure on any screen is computed from it.
--
-- ----------------------------------------------------------------------------
-- WHAT IS DELIBERATELY ABSENT, each because the absence is a decision
-- ----------------------------------------------------------------------------
--   * A CONTACTS CHILD TABLE. One phone and one email is what a hotel supplier
--     relationship actually is. If a second contact is ever genuinely needed the
--     child table is purely additive and these columns become the primary
--     contact — nothing here has to move.
--   * WHAT THEY SUPPLY. Tempting, and it earns nothing until there is a "who
--     should we buy this from" question to answer, which is 7.2.
--   * PERFORMANCE RATINGS. They arrive free later and must not be built as a
--     field: purchase_receipt_lines already records ordered against received
--     against invoiced, so on-time and short-delivery history is a REPORT over
--     data this shipment is already writing. A rating column would be a second,
--     hand-maintained opinion about the same facts.
create table if not exists suppliers (
  id            uuid primary key default gen_random_uuid(),

  tenant_id     uuid not null references tenants(id) on delete cascade,

  -- Optional short code — 'BFF'. The picker shows it as the second line, the way
  -- inventory_items.code does, because somebody holding a delivery note usually
  -- has the code rather than the full registered name.
  code          text,
  name          text not null
                  constraint suppliers_name_check
                  check (length(btrim(name)) > 0),

  contact_name  text,
  phone         text,
  email         text,
  address       text,

  -- --- what 1.1h5 will need, captured while it is free ---------------------
  -- The supplier's TIN. Nigerian withholding needs it and nobody goes back to
  -- collect it later.
  tax_id        text,
  -- INFORMATIONAL IN THIS SHIPMENT. Nothing computes with it.
  withholding_tax_rate numeric(5,2)
                  constraint suppliers_wht_rate_check
                  check (withholding_tax_rate is null
                         or (withholding_tax_rate >= 0 and withholding_tax_rate <= 100)),
  -- How you actually pay them. FIELDS, not the note column — which is where
  -- they end up otherwise, unsearchable and un-copyable.
  bank_name            text,
  bank_account_name    text,
  bank_account_number  text,

  note          text,
  is_active     boolean not null default true,

  deleted_at    timestamptz,                 -- soft delete (master data, rule 5)
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid default auth.uid() references auth.users(id),
  updated_by    uuid references auth.users(id),

  -- Paired-key target, so a purchase order can never point at another tenant's
  -- supplier (SECTION 6 composite-key consistency).
  constraint suppliers_id_tenant_unique unique (id, tenant_id)
);

-- Case-insensitively unique per tenant among LIVE rows: "Bonny Fresh Foods" and
-- "bonny fresh foods" are one supplier with two payment histories otherwise.
create unique index if not exists suppliers_name_uniq
  on suppliers (tenant_id, lower(btrim(name)))
  where deleted_at is null;

create unique index if not exists suppliers_code_uniq
  on suppliers (tenant_id, upper(btrim(code)))
  where deleted_at is null and code is not null and btrim(code) <> '';

create index if not exists suppliers_tenant_idx
  on suppliers (tenant_id, name)
  where deleted_at is null;

comment on table suppliers is
  'WHO THE HOTEL BUYS FROM. Tenant-level, like the catalogue: one company, one '
  'record, one payment history, however many properties order from it. Carries '
  'the TIN, the withholding rate and the bank details 1.1h5 will need to PAY '
  'them — captured now because the table is empty now, and INFORMATIONAL until '
  'that shipment: nothing in 046 computes with any of them. Deliberately has no '
  'contacts child table, no what-they-supply, and no performance rating; each '
  'absence is argued in this file''s SECTION 1 header rather than left as a gap.';
comment on column suppliers.withholding_tax_rate is
  'INFORMATIONAL IN 1.1h2 — no RPC reads it and no figure is computed from it. '
  'It is a property of the RELATIONSHIP (services and goods withhold at '
  'different rates in Nigeria), which is why it lives on the supplier rather '
  'than on a payment. 1.1h5 is what gives it a reader.';

drop trigger if exists set_row_audit_suppliers on suppliers;
create trigger set_row_audit_suppliers
  before insert or update on suppliers
  for each row execute function set_row_audit();

drop trigger if exists log_field_changes_suppliers on suppliers;
create trigger log_field_changes_suppliers
  after update on suppliers
  for each row execute function log_field_changes();


-- ############################################################################
-- SECTION 2 — purchase_orders and purchase_order_lines
-- ############################################################################
-- WHAT WAS ASKED FOR, FROM WHOM, TO WHERE, AND WHAT HAS ARRIVED SO FAR.
--
-- ----------------------------------------------------------------------------
-- THE DESTINATION EQUIVALENCE
-- ----------------------------------------------------------------------------
-- A purchase order names ONE destination location, and receiving against it is
-- A DIRECT RECEIPT WITH PAPERWORK — nothing more and nothing less. The store
-- rule, the batch rule, the inactive-item rule, the future-date guard and the
-- posting lock are the SAME rules for a delivery on a PO as for one keyed by
-- hand, and they are the same rules because they are THE SAME FUNCTION:
-- receive_purchase_order calls post_stock_receipt once per line and never
-- inserts a movement itself.
--
-- THAT IS THE WHOLE POINT. A purchase order must not become the route by which
-- goods reach a bar without a manager's authorisation — which is exactly what a
-- second, parallel receiving implementation would quietly become, one guard at a
-- time, because each omission looks reasonable in isolation. Only the store
-- receives (CLAUDE.md SECTION 9); ordering something to a kitchen is allowed and
-- the delivery still needs the PIN and the reason, and still lands on the
-- received-outside-the-store report.
--
-- ----------------------------------------------------------------------------
-- THE NUMBER IS CLAIMED AT CREATION, INCLUDING FOR A DRAFT
-- ----------------------------------------------------------------------------
-- Same as a booking (015). An abandoned draft therefore burns a number, and that
-- is the cheaper of the two mistakes: the alternative is a document that exists,
-- can be opened and edited and talked about, and has nothing to call it but a
-- uuid. Numbers are never reused and a gap in a purchase-order sequence is not a
-- finding; a document nobody can cite is.
--
-- ----------------------------------------------------------------------------
-- STATUS: FIVE VALUES, AND THE GRAPH IS A TRIGGER
-- ----------------------------------------------------------------------------
--   draft         being written. The only state in which anything can be edited.
--   ordered       sent to the supplier. IMMUTABLE from here on.
--   part_received something arrived and something is still outstanding.
--   received      every line is settled — delivered, or closed short.
--   cancelled     abandoned. Terminal.
--
-- A CHECK pins the vocabulary; the TRIGGER (SECTION 2.3) pins the transitions
-- and the immutability, because a CHECK can only see the row in front of it and
-- "you cannot go back to draft" is a statement about two rows.
create table if not exists purchase_orders (
  id            uuid primary key default gen_random_uuid(),

  -- Insertion order, for a stable tiebreak between two orders on one date —
  -- the same reason stock_movements carries one.
  seq           bigint generated always as identity,

  tenant_id     uuid not null,
  property_id   uuid not null,

  supplier_id   uuid not null,

  order_number  text not null,               -- 'PO-000001'

  status        text not null default 'draft'
                  constraint purchase_orders_status_check
                  check (status in
                    ('draft', 'ordered', 'part_received', 'received', 'cancelled')),

  -- THE BUSINESS DATE (rules 8/12). What day the hotel considers this order to
  -- have been raised on, never created_at.
  order_date    date not null,
  -- When the supplier said it would arrive. Nullable: plenty of orders have no
  -- promised date, and a made-up one is worse than none.
  expected_date date,

  -- WHERE THE GOODS ARE GOING. See the destination equivalence above.
  destination_location_id uuid not null,

  note          text,

  -- Stamped by the transitions, so "who sent this order" is answerable without
  -- reading the change log.
  ordered_at    timestamptz,
  ordered_by    uuid references auth.users(id),
  cancelled_at  timestamptz,
  cancelled_by  uuid references auth.users(id),
  cancel_reason text,

  -- Rules 2/3, one key per WRITE INTENT — the shape stock_takes uses. Creating,
  -- sending and cancelling are three separate intents that happen at three
  -- different moments, so one shared key would collapse them.
  idempotency_key        text,
  -- The FINGERPRINT of the payload this key was first used with. A retry
  -- carrying a DIFFERENT payload is refused by name rather than silently handed
  -- back the first one — see SECTION 6.1.
  idempotency_digest     text,
  place_idempotency_key  text,
  cancel_idempotency_key text,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid default auth.uid() references auth.users(id),
  updated_by    uuid references auth.users(id),

  -- A cancellation always says why. Same rule as every other undoing in this
  -- product (031, 039, 040).
  constraint purchase_orders_cancel_reason_check
    check (status <> 'cancelled'
           or (cancel_reason is not null and length(btrim(cancel_reason)) > 0)),

  -- The expected date cannot precede the order date. Cheap, and the mistake is
  -- one mis-keyed year away.
  constraint purchase_orders_date_order_check
    check (expected_date is null or expected_date >= order_date),

  constraint purchase_orders_property_tenant_fk
    foreign key (property_id, tenant_id)
    references properties (id, tenant_id) on delete cascade,

  constraint purchase_orders_supplier_tenant_fk
    foreign key (supplier_id, tenant_id)
    references suppliers (id, tenant_id),

  constraint purchase_orders_location_property_fk
    foreign key (destination_location_id, property_id)
    references locations (id, property_id),

  -- Paired-key targets for the lines and the receipts.
  constraint purchase_orders_id_tenant_unique unique (id, tenant_id),
  constraint purchase_orders_id_property_unique unique (id, property_id)
);

create unique index if not exists purchase_orders_number_uniq
  on purchase_orders (tenant_id, property_id, order_number);

create unique index if not exists purchase_orders_idem_uniq
  on purchase_orders (tenant_id, idempotency_key)
  where idempotency_key is not null;

create unique index if not exists purchase_orders_place_idem_uniq
  on purchase_orders (tenant_id, place_idempotency_key)
  where place_idempotency_key is not null;

create unique index if not exists purchase_orders_cancel_idem_uniq
  on purchase_orders (tenant_id, cancel_idempotency_key)
  where cancel_idempotency_key is not null;

-- The two hot paths: one property's orders newest first, and the OUTSTANDING
-- list, which is the screen somebody actually opens in the morning.
create index if not exists purchase_orders_property_idx
  on purchase_orders (property_id, order_date desc, seq desc);

create index if not exists purchase_orders_open_idx
  on purchase_orders (property_id, expected_date, seq)
  where status in ('ordered', 'part_received');

create index if not exists purchase_orders_supplier_idx
  on purchase_orders (tenant_id, supplier_id, order_date desc);

comment on table purchase_orders is
  'WHAT WAS ORDERED, FROM WHOM, TO WHERE. An order is editable ONLY as a draft; '
  'once it is ordered it is immutable and the only things that change are its '
  'status and the receipts hanging off it (SECTION 2.3''s trigger, not a '
  'convention). Its DESTINATION obeys exactly the rules a direct receipt obeys, '
  'because receiving calls post_stock_receipt rather than inserting movements '
  'itself — a purchase order is not a route around "only the store receives". '
  'No write policy of any kind: every change goes through a SECURITY DEFINER '
  'RPC, the same shape as stock_movements and journal_entries.';
comment on column purchase_orders.destination_location_id is
  'Where the goods are going. Receiving into a location whose kind is not '
  '''store'' needs a manager PIN and a reason and lands on the '
  'received-outside-the-store report — IDENTICALLY to a direct receipt, because '
  'it is the same function that enforces it.';
comment on column purchase_orders.idempotency_digest is
  'A fingerprint of the payload this order''s idempotency key was FIRST used '
  'with. A retry under the same key carrying a different payload is refused by '
  'name (PT409) rather than being handed back the first order — which would be a '
  'silent, confident wrong answer: the caller believes their edit saved and it '
  'did not.';

drop trigger if exists set_row_audit_purchase_orders on purchase_orders;
create trigger set_row_audit_purchase_orders
  before insert or update on purchase_orders
  for each row execute function set_row_audit();

drop trigger if exists log_field_changes_purchase_orders on purchase_orders;
create trigger log_field_changes_purchase_orders
  after update on purchase_orders
  for each row execute function log_field_changes();


-- ----------------------------------------------------------------------------
-- 2.2 purchase_order_lines — and THE SHAPE CHECK
-- ----------------------------------------------------------------------------
-- A purchase line is one of three things, and they are genuinely different
-- documents wearing one shape:
--
--   'inventory'  50 kg of rice. Goes into stock, moves the average, debits
--                the inventory account. THE ONLY ONE THIS SHIPMENT WRITES.
--   'asset'      a freezer. Debits fixed assets and starts depreciating.  1.1h3
--   'expense'    a plumber's call-out. Debits an expense account.          1.1h3
--
-- THE SHAPE CHECK IS HERE NOW, AND THE OTHER TWO ARE REFUSED BY NAME RATHER
-- THAN BEING ABSENT. An inventory line MUST carry an item and MUST NOT carry a
-- free-text description standing in for one; an asset or expense line is the
-- exact opposite. Encoding that today means 1.1h3 adds a WRITE PATH to a table
-- that already holds live orders, rather than reshaping one — which is the same
-- reasoning 036 used when it declared all ten movement types and opened two.
--
-- The refusal is in save_purchase_order (SECTION 6.1) and it NAMES THE
-- SHIPMENT, because "not supported" without "when" sends somebody to read the
-- source.
create table if not exists purchase_order_lines (
  id                uuid primary key default gen_random_uuid(),

  tenant_id         uuid not null,
  purchase_order_id uuid not null,

  -- Stable display order within the order, assigned by save_purchase_order.
  line_number       integer not null
                      constraint purchase_order_lines_number_check
                      check (line_number > 0),

  line_type         text not null default 'inventory'
                      constraint purchase_order_lines_type_check
                      check (line_type in ('inventory', 'asset', 'expense')),

  inventory_item_id uuid,

  -- What this line is for, in words. NULL on an inventory line — the item's own
  -- name is the description, and a second one would be a place for them to
  -- disagree. REQUIRED on the other two, which have no item to name them.
  description       text,

  -- Base units (CLAUDE.md SECTION 9), four decimals, matching stock_movements.
  quantity          numeric(14,4) not null
                      constraint purchase_order_lines_quantity_check
                      check (quantity > 0),

  -- What the hotel expects to pay for ONE base unit. The INVOICED cost lives on
  -- the receipt line, and the difference between the two is the thing the
  -- receiving screen shows live.
  unit_cost         numeric(14,2) not null
                      constraint purchase_order_lines_cost_check
                      check (unit_cost >= 0),

  note              text,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  created_by        uuid default auth.uid() references auth.users(id),
  updated_by        uuid references auth.users(id),

  -- THE SHAPE CHECK.
  constraint purchase_order_lines_shape_check
    check (
      case line_type
        when 'inventory'
          then inventory_item_id is not null and description is null
        else
          inventory_item_id is null
          and description is not null and length(btrim(description)) > 0
      end
    ),

  constraint purchase_order_lines_order_tenant_fk
    foreign key (purchase_order_id, tenant_id)
    references purchase_orders (id, tenant_id) on delete cascade,

  constraint purchase_order_lines_item_tenant_fk
    foreign key (inventory_item_id, tenant_id)
    references inventory_items (id, tenant_id),

  constraint purchase_order_lines_number_uniq
    unique (purchase_order_id, line_number),

  constraint purchase_order_lines_id_tenant_unique unique (id, tenant_id)
);

-- One order's lines in order, and the reverse lookup a receipt line needs.
create index if not exists purchase_order_lines_order_idx
  on purchase_order_lines (purchase_order_id, line_number);

create index if not exists purchase_order_lines_item_idx
  on purchase_order_lines (tenant_id, inventory_item_id)
  where inventory_item_id is not null;

-- ONE ITEM ONCE PER ORDER. Two lines for the same rice is not a richer order, it
-- is two people entering the same delivery — and it makes "what is still
-- outstanding for this item" a question with two answers.
create unique index if not exists purchase_order_lines_item_uniq
  on purchase_order_lines (purchase_order_id, inventory_item_id)
  where inventory_item_id is not null;

comment on table purchase_order_lines is
  'What was ordered, line by line. THE SHAPE CHECK enforces that an inventory '
  'line carries an item and no description while an asset or expense line '
  'carries a description and no item — declared NOW so 1.1h3 adds a write path '
  'rather than reshaping a table holding live orders, exactly as 036 declared '
  'all ten movement types and opened two. Asset and expense lines are refused BY '
  'NAME in save_purchase_order, naming the shipment that brings them.';
comment on column purchase_order_lines.unit_cost is
  'What the hotel EXPECTS to pay per base unit. What it was actually invoiced '
  'lives on purchase_receipt_lines.unit_cost, and the difference between the two '
  'is shown live while receiving. Neither is a snapshot of the other: they are '
  'two different facts about two different moments.';

drop trigger if exists set_row_audit_purchase_order_lines on purchase_order_lines;
create trigger set_row_audit_purchase_order_lines
  before insert or update on purchase_order_lines
  for each row execute function set_row_audit();


-- ----------------------------------------------------------------------------
-- 2.3 THE TRANSITION TRIGGER — the graph, and the immutability
-- ----------------------------------------------------------------------------
-- A CHECK constraint sees ONE row. "You cannot go back to draft" and "an ordered
-- order's supplier cannot change" are both statements about TWO rows, so they
-- are a trigger or they are nothing.
--
-- WHY THIS IS NOT LEFT TO THE RPCs, which is the tempting answer since there is
-- no write policy: the RPCs are three today and will be five, and the guarantee
-- an accountant is relying on — "the order I approved is the order that was
-- sent" — must not depend on all five of them remembering. 045 made exactly this
-- argument about the chart of accounts and it is the same argument.
--
-- THE LEGAL GRAPH:
--   draft         -> ordered | cancelled
--   ordered       -> part_received | received | cancelled
--   part_received -> received | cancelled
--   received      -> (terminal)
--   cancelled     -> (terminal)
--
-- CANCELLING A PART-RECEIVED ORDER IS ALLOWED, and deliberately: a delivery that
-- came half and then the supplier went quiet is exactly the case somebody needs
-- to close. What ARRIVED is untouched — the movements and their journal entries
-- are permanent, as everything in this system is — and the cancellation only
-- says nothing more is coming.
create or replace function enforce_purchase_order_transition()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_legal boolean;
begin
  -- ---- the graph -----------------------------------------------------------
  if new.status is distinct from old.status then
    v_legal := case old.status
                 when 'draft'         then new.status in ('ordered', 'cancelled')
                 when 'ordered'       then new.status in ('part_received', 'received', 'cancelled')
                 when 'part_received' then new.status in ('received', 'cancelled')
                 else false                      -- received and cancelled are terminal
               end;

    if not v_legal then
      raise exception
        'A purchase order cannot go from % to %.', old.status, new.status
        using errcode = 'PT409',
              hint = case old.status
                       when 'received'  then 'This order is complete. Raise a new order for anything else you need.'
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
  'on all of them remembering.';

drop trigger if exists enforce_purchase_order_transition_trigger on purchase_orders;
create trigger enforce_purchase_order_transition_trigger
  before update on purchase_orders
  for each row execute function enforce_purchase_order_transition();


-- ----------------------------------------------------------------------------
-- 2.4 A SENT ORDER'S LINES ARE FROZEN TOO
-- ----------------------------------------------------------------------------
-- Freezing the header and leaving the lines writable would freeze the envelope
-- and leave the letter editable. Same trigger shape as forbid_journal_change
-- (044) and forbid_stock_movement_change (036), INCLUDING the cascade exception:
-- if the parent order no longer exists, this DELETE is Postgres tidying up after
-- a hard delete of a property or tenant, not a person editing a sent order.
create or replace function enforce_purchase_order_line_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order  purchase_orders;
  v_row    purchase_order_lines;
begin
  v_row := case when tg_op = 'DELETE' then old else new end;

  select * into v_order
  from purchase_orders
  where id = v_row.purchase_order_id;

  if not found then
    -- The parent is gone: this is a cascade, not an edit.
    return v_row;
  end if;

  if v_order.status <> 'draft' then
    raise exception
      'Purchase order % has already been sent, so its lines cannot be changed.',
      v_order.order_number
      using errcode = 'PT409',
            hint = 'Record what actually arrived when it does — a delivery that differs from the order is what the receiving screen exists to capture.';
  end if;

  return v_row;
end;
$$;

comment on function enforce_purchase_order_line_change() is
  'Refuses any insert, update or delete of a line on an order that is no longer '
  'a draft. Freezing the header and leaving the lines writable would freeze the '
  'envelope and leave the letter editable. Detects the cascade case the way 036 '
  'and 044 do — a parent that no longer exists means Postgres is tidying up, not '
  'a person editing a sent order.';

drop trigger if exists enforce_purchase_order_line_change_trigger on purchase_order_lines;
create trigger enforce_purchase_order_line_change_trigger
  before insert or update or delete on purchase_order_lines
  for each row execute function enforce_purchase_order_line_change();


-- ############################################################################
-- SECTION 3 — purchase_receipts and purchase_receipt_lines
-- ############################################################################
-- THE GOODS RECEIVED NOTE. What actually turned up, on what day, against which
-- order, and what the invoice said it cost.
--
-- ----------------------------------------------------------------------------
-- NO DERIVABLE SNAPSHOTS. NOT ONE.
-- ----------------------------------------------------------------------------
-- This table deliberately does NOT carry supplier_id, supplier_name, line_count,
-- total_value, or the quantity ordered. Every one of them is one join away and
-- every one of them would be a cache under rule 6 — a second opinion that is
-- right on the day it is written and drifts silently afterwards, with no
-- recompute function because nobody ever thinks a snapshot needs one.
--
-- WHAT IS NOT A SNAPSHOT, and the distinction matters because it looks like one:
--   * purchase_receipt_lines.unit_cost is the INVOICED cost. It is NOT a copy of
--     the ordered cost; it is a different fact about a different moment, and the
--     difference between the two is the figure the receiving screen shows live.
--     Storing it is the ONLY non-redundant way to record a cost difference —
--     storing the difference itself would be the snapshot.
--   * property_id is here for RLS scoping and is bound to the order by a
--     composite FK, so it cannot disagree with its parent rather than merely
--     being expected not to.
--
-- ----------------------------------------------------------------------------
-- WHY THE RECEIPT IS A DOCUMENT AND NOT JUST SOME MOVEMENTS
-- ----------------------------------------------------------------------------
-- The movements are what happened to stock. The receipt is what happened with
-- the supplier: one delivery, one delivery note, one invoice number, one
-- authorisation, one journal entry. 1.1h5 allocates a PAYMENT against THIS row,
-- which is why its id is stable and its figures are clean.
create table if not exists purchase_receipts (
  id                uuid primary key default gen_random_uuid(),

  seq               bigint generated always as identity,

  tenant_id         uuid not null,
  property_id       uuid not null,

  purchase_order_id uuid not null,

  receipt_number    text not null,           -- 'GRN-000001'

  -- THE BUSINESS DATE (rules 8/12): the operating day the goods arrived, in the
  -- property's timezone. Never created_at.
  business_date     date not null,

  -- WHERE IT ACTUALLY LANDED. Normally the order's destination; kept on the
  -- receipt because it is what the movements were posted against and because a
  -- later delivery of the same order could, in principle, land elsewhere.
  location_id       uuid not null,

  -- The supplier's own paperwork, so a query can start from either side.
  delivery_note     text,
  invoice_number    text,

  note              text,

  -- WHY THE DELIVERY DIFFERS FROM THE ORDER. Required by the RPC whenever ANY
  -- line's quantity differs from what was outstanding — in either direction.
  reason            text,

  -- The manager who authorised an over-receipt, or a delivery into a location
  -- that is not a store. NULL when neither applied.
  authorised_by     uuid references auth.users(id),

  idempotency_key   text,
  idempotency_digest text,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  created_by        uuid default auth.uid() references auth.users(id),
  updated_by        uuid references auth.users(id),

  constraint purchase_receipts_order_tenant_fk
    foreign key (purchase_order_id, tenant_id)
    references purchase_orders (id, tenant_id) on delete cascade,

  -- Binds the receipt's property to the ORDER's property, so the two can never
  -- disagree — a cross-property receipt is invisible to RLS, which trusts
  -- tenant_id directly.
  constraint purchase_receipts_order_property_fk
    foreign key (purchase_order_id, property_id)
    references purchase_orders (id, property_id) on delete cascade,

  constraint purchase_receipts_location_property_fk
    foreign key (location_id, property_id)
    references locations (id, property_id),

  constraint purchase_receipts_id_tenant_unique unique (id, tenant_id)
);

create unique index if not exists purchase_receipts_number_uniq
  on purchase_receipts (tenant_id, property_id, receipt_number);

create unique index if not exists purchase_receipts_idem_uniq
  on purchase_receipts (tenant_id, idempotency_key)
  where idempotency_key is not null;

create index if not exists purchase_receipts_order_idx
  on purchase_receipts (purchase_order_id, business_date, seq);

create index if not exists purchase_receipts_property_idx
  on purchase_receipts (property_id, business_date desc, seq desc);

comment on table purchase_receipts is
  'THE GOODS RECEIVED NOTE: one delivery, one delivery note, one invoice number, '
  'one authorisation, ONE journal entry. Carries NO derivable snapshot — no '
  'supplier, no line count, no total — because each would be a cache under rule 6 '
  'with no recompute function. purchase_receipt_lines.unit_cost is NOT a '
  'snapshot: it is the INVOICED cost, a different fact from the ordered cost, and '
  'storing it is the only non-redundant way to record a difference. This row is '
  'what a supplier PAYMENT will allocate against in 1.1h5, which is why its id is '
  'stable and its figures are clean.';

-- BEFORE INSERT ONLY, and the change log gets the INSERT-side trigger — the
-- shape 036 uses for stock_movements and for the same reason: this table is
-- immutable (3.3), so an update-side audit trigger could never fire and
-- log_field_changes would record nothing for the life of the table.
drop trigger if exists set_row_audit_purchase_receipts on purchase_receipts;
create trigger set_row_audit_purchase_receipts
  before insert on purchase_receipts
  for each row execute function set_row_audit();

drop trigger if exists log_row_insert_purchase_receipts on purchase_receipts;
create trigger log_row_insert_purchase_receipts
  after insert on purchase_receipts
  for each row execute function log_row_insert();


-- ----------------------------------------------------------------------------
-- 3.2 purchase_receipt_lines
-- ----------------------------------------------------------------------------
-- ONE ROW PER ORDER LINE TOUCHED BY THIS DELIVERY. Not per order line: a
-- delivery that brings three of five lines writes three rows, and the other two
-- stay outstanding.
--
-- QUANTITY ZERO REQUIRES closed_short, and that pairing is the whole reason
-- either exists. A receipt line of nothing, with nothing said about it, is a row
-- that means nothing — the way to record "we did not receive this" is to not
-- write a line at all. A zero WITH closed_short means something precise and
-- useful: NOTHING MORE IS COMING FOR THIS LINE. That is what lets an order whose
-- supplier went quiet reach 'received' and stop sitting in the outstanding list
-- forever, and it is what makes the short-delivery report honest.
create table if not exists purchase_receipt_lines (
  id                     uuid primary key default gen_random_uuid(),

  tenant_id              uuid not null,
  purchase_receipt_id    uuid not null,
  purchase_order_line_id uuid not null,

  line_number            integer not null
                           constraint purchase_receipt_lines_number_check
                           check (line_number > 0),

  -- WHAT ARRIVED, in base units. ZERO IS LEGAL and means "nothing arrived and
  -- nothing more is coming" — which is why the check below pairs it with
  -- closed_short.
  quantity               numeric(14,4) not null
                           constraint purchase_receipt_lines_quantity_check
                           check (quantity >= 0),

  -- WHAT THE INVOICE SAID ONE BASE UNIT COST. This is what moves the average and
  -- what the journal entry debits — never the ordered cost, which was an
  -- expectation.
  unit_cost              numeric(14,2) not null
                           constraint purchase_receipt_lines_cost_check
                           check (unit_cost >= 0),

  -- NOTHING MORE IS COMING FOR THIS LINE.
  closed_short           boolean not null default false,

  -- Why this line differs from what was outstanding. Required by the RPC on any
  -- quantity difference; the column is nullable because a line that matches
  -- exactly needs no explanation and a mandatory blank would be filled with
  -- "ok".
  reason                 text,

  -- Batch/expiry travel with the goods when the item is tracked (038 SECTION 1C).
  batch_code             text,
  expiry_date            date,

  note                   text,

  -- The movement this line posted. NULL when quantity is zero — a close-short
  -- moves no stock. A REAL foreign key, unlike stock_movements.source_document_id
  -- which points at whatever table posted it and therefore cannot be one: this
  -- points at exactly one table, so a dangling pointer is refused rather than
  -- being something a report would have to notice.
  stock_movement_id      uuid references stock_movements(id),

  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  created_by             uuid default auth.uid() references auth.users(id),
  updated_by             uuid references auth.users(id),

  -- QUANTITY ZERO REQUIRES closed_short.
  constraint purchase_receipt_lines_zero_check
    check (quantity > 0 or closed_short),

  -- A line that moved no stock has no movement, and one that did has one. Both
  -- directions, so neither half can be satisfied alone.
  constraint purchase_receipt_lines_movement_shape_check
    check ((quantity > 0) = (stock_movement_id is not null)),

  constraint purchase_receipt_lines_receipt_tenant_fk
    foreign key (purchase_receipt_id, tenant_id)
    references purchase_receipts (id, tenant_id) on delete cascade,

  constraint purchase_receipt_lines_order_line_tenant_fk
    foreign key (purchase_order_line_id, tenant_id)
    references purchase_order_lines (id, tenant_id),

  constraint purchase_receipt_lines_number_uniq
    unique (purchase_receipt_id, line_number)
);

-- ONE ORDER LINE ONCE PER RECEIPT. Two rows for the same line in one delivery is
-- somebody keying it twice, and it would double the stock and the journal.
create unique index if not exists purchase_receipt_lines_once_uniq
  on purchase_receipt_lines (purchase_receipt_id, purchase_order_line_id);

-- "What has arrived against this line so far", which is the outstanding
-- calculation and the hottest read in the module.
create index if not exists purchase_receipt_lines_order_line_idx
  on purchase_receipt_lines (purchase_order_line_id);

comment on table purchase_receipt_lines is
  'WHAT ARRIVED, line by line, at the INVOICED cost — which is what moves the '
  'average and what the journal debits, never the ordered cost. A quantity of '
  'zero is legal ONLY with closed_short, and that pairing is the point: a zero '
  'with nothing said means nothing (do not write the line at all), while a zero '
  'WITH closed_short means nothing more is coming, which is what lets an order '
  'the supplier abandoned reach ''received'' instead of sitting in the '
  'outstanding list forever.';
comment on column purchase_receipt_lines.closed_short is
  'NOTHING MORE IS COMING FOR THIS LINE. Set on a short delivery that is the '
  'last one, or on a zero-quantity line, which cannot be written without it.';

drop trigger if exists set_row_audit_purchase_receipt_lines on purchase_receipt_lines;
create trigger set_row_audit_purchase_receipt_lines
  before insert on purchase_receipt_lines
  for each row execute function set_row_audit();

drop trigger if exists log_row_insert_purchase_receipt_lines on purchase_receipt_lines;
create trigger log_row_insert_purchase_receipt_lines
  after insert on purchase_receipt_lines
  for each row execute function log_row_insert();


-- ----------------------------------------------------------------------------
-- 3.3 A RECEIPT IS PERMANENT
-- ----------------------------------------------------------------------------
-- Same rule as the stock ledger and the journal, and for the same reason: the
-- delivery happened. It is corrected by receiving again (a negative is not
-- possible, so a mis-keyed delivery is corrected by reversing its MOVEMENT,
-- which posts its own counter-entry and leaves both facts visible).
--
-- THIS IS WHY THERE IS NO edit_receipt RPC and no update policy. The one thing
-- an update could plausibly want — fixing a typo'd invoice number — is not worth
-- a hole in a document a payment will be allocated against.
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
          hint = 'To correct what was received, reverse the stock movement it posted. Both facts then stay visible, which is what an audit trail is for.';
end;
$$;

comment on function forbid_purchase_receipt_change() is
  'Refuses every UPDATE and DELETE on a goods receipt and its lines, apart from '
  'the cascade of a hard-deleted parent. Same rule as stock_movements and '
  'journal_entries: the delivery happened, and a document a payment will be '
  'allocated against must not be editable afterwards. Corrections go through a '
  'movement reversal, which posts its own counter-entry.';

drop trigger if exists forbid_purchase_receipt_change_trigger on purchase_receipts;
create trigger forbid_purchase_receipt_change_trigger
  before update or delete on purchase_receipts
  for each row execute function forbid_purchase_receipt_change();

drop trigger if exists forbid_purchase_receipt_line_change_trigger on purchase_receipt_lines;
create trigger forbid_purchase_receipt_line_change_trigger
  before update or delete on purchase_receipt_lines
  for each row execute function forbid_purchase_receipt_change();


-- ############################################################################
-- SECTION 4 — THE ONE IMPLEMENTATION OF "BOOK THIS MOVEMENT"
-- ############################################################################
-- Six RPCs move stock and money at the same time. They could each build their
-- own p_lines payload and call post_journal, and six copies of the sign rule and
-- the cost rule would then drift — the fifth author to add a movement type would
-- get one of them subtly wrong and nothing would error, because a wrong account
-- still balances.
--
-- So there is ONE function. Each RPC calls it with a movement id, at the end,
-- inside its own transaction. It decides the amount, the sides and the accounts
-- from the movement itself.
--
-- ----------------------------------------------------------------------------
-- WHY THIS IS A CALL IN EACH RPC AND NOT AN AFTER-INSERT TRIGGER
-- ----------------------------------------------------------------------------
-- A trigger was the obvious alternative and it has a genuinely strong argument
-- behind it — 038 used exactly that argument for set_stock_carried_cost: "each
-- RPC" is not a closed set, requisitions and transfers and consumption are all
-- still to be built, and a rule every future author must remember is one that
-- gets forgotten silently.
--
-- IT IS A CALL ANYWAY, for two reasons that only appeared once purchasing was
-- in front of it:
--
--   1. A GOODS RECEIPT POSTS ONE ENTRY FOR N MOVEMENTS. A trigger fires per row
--      and would post N. Suppressing it would mean the trigger inspecting
--      source_document_type and skipping names it recognises — which is a
--      posting rule hidden inside a string comparison, and the failure when a
--      later document type is added to one list and not the other is a
--      DOUBLE-POSTED delivery.
--   2. The posting must be able to say NOTHING WENT WRONG AND NOTHING WAS
--      BOOKED — before gl_start_date, for a movement with no cost basis, for a
--      transfer between two locations of one property. A trigger can do that
--      too, but the caller then cannot tell the difference between "booked" and
--      "deliberately not booked", and one of those is a bug.
--
-- WHAT REPLACES THE TRIGGER'S GUARANTEE: stock_movements_unposted (SECTION 7.4)
-- lists every movement that has no journal entry, WITH THE REASON. A forgotten
-- call shows up there as "no reason" — loudly, on a screen, the same way 044's
-- last_posted_on makes an unwired mapping visible. The guarantee moves from
-- "impossible to forget" to "impossible to forget QUIETLY", which is the honest
-- version of it.

-- ----------------------------------------------------------------------------
-- 4.1 stock_movement_counter_role — which account sits opposite inventory
-- ----------------------------------------------------------------------------
-- Inventory is always one side of a stock movement. This decides the other, by
-- ROLE KEY (rule 4) and never by a code.
--
--   opening           -> opening_balance_equity   the books opening, not a purchase
--   receipt           -> supplier_payable, or cash when no supplier was named
--   adjustment        -> stock_adjustment         the count was wrong
--   count_adjustment  -> stock_variance           a physical count found a difference
--   wastage           -> wastage_<reason_code>    the FIVE separate keys, not one
--   reversal          -> whatever the ORIGINAL used
--
-- A CASH MARKET PURCHASE CREDITING cash IS A SIMPLIFICATION, and it is written
-- down rather than assumed: it says the money left the till that day. It is true
-- of how a Nigerian hotel actually buys tomatoes, and it is not true of a
-- delivery on credit from a supplier the hotel has an account with — which is
-- why naming a supplier switches it to supplier_payable. When supplier PAYMENTS
-- arrive in 1.1h5, a direct receipt on credit becomes properly expressible and
-- this branch gets revisited.
--
-- A WRITE-OFF POSTS TO THE KEY FOR ITS REASON CODE, not to one wastage account.
-- Spoilage, breakage, expiry, staff meals and complimentaries are five different
-- conversations with an owner — two of them are theft questions and two of them
-- are cost-of-business — and a single account merges them into a number that
-- answers none of the five.
--
-- RETURNS NULL to mean THIS MOVEMENT BOOKS NOTHING, which is different from
-- raising. A transfer or an issue moves stock between two locations of one
-- property: what the property holds is unchanged, so the inventory account is
-- unchanged, and posting a debit and a credit to the same account would be an
-- entry that says nothing. (Departmental cost allocation is a later question and
-- a different mechanism.)
create or replace function stock_movement_counter_role(p_movement_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_m stock_movements;
begin
  select * into v_m from stock_movements where id = p_movement_id;
  if not found then
    raise exception 'Stock movement % not found', p_movement_id using errcode = 'PT404';
  end if;

  -- A reversal books against whatever the original booked against, which is what
  -- makes the pair net to zero on every account rather than merely on inventory.
  if v_m.movement_type = 'reversal' then
    return stock_movement_counter_role(v_m.reverses_movement_id);
  end if;

  -- REFUSED BY NAME rather than guessed at, and rather than falling through to
  -- NULL — which would look identical to "books nothing" and would silently
  -- leave every plate of jollof rice out of the food-cost figure. Consumption's
  -- account is cost_of_sales, which 044 seeded and deliberately left UNMAPPED
  -- because the granularity question is "which item", not "food or drink".
  if v_m.movement_type = 'consumption' then
    raise exception
      'Recipe consumption has no account mapping yet, so it cannot be posted.'
      using errcode = 'PT501',
            hint = 'It arrives with recipes (6.2), which is what decides whether cost of sales is split by item or held as one account.';
  end if;

  return case v_m.movement_type
           when 'opening'          then 'opening_balance_equity'
           when 'receipt'          then
             case when nullif(btrim(coalesce(v_m.supplier, '')), '') is not null
                  then 'supplier_payable' else 'cash' end
           when 'adjustment'       then 'stock_adjustment'
           when 'count_adjustment' then 'stock_variance'
           when 'wastage'          then 'wastage_' || v_m.reason_code
           -- Between two locations of one property: books nothing.
           when 'issue_out'        then null
           when 'issue_in'         then null
           when 'transfer_out'     then null
           when 'transfer_in'      then null
           else null
         end;
end;
$$;

comment on function stock_movement_counter_role(uuid) is
  'Which account sits OPPOSITE inventory for one stock movement, as a ROLE KEY '
  '(rule 4) and never a code. A reversal returns whatever its ORIGINAL used, '
  'which is what makes the pair net to zero on every account rather than only on '
  'inventory. A write-off returns the key for ITS reason code — five keys, not '
  'one wastage account, because two of the five are theft questions and two are '
  'cost of business. NULL means THIS MOVEMENT BOOKS NOTHING: a transfer or an '
  'issue moves stock between two locations of one property, so what the property '
  'holds is unchanged and an entry would say nothing.';


-- ----------------------------------------------------------------------------
-- 4.2 post_stock_movement_journal
-- ----------------------------------------------------------------------------
-- THE THREE RULES ON THE AMOUNT, and they are the reason 038 stamped
-- carried_unit_cost in the first place:
--
--   STOCK IN  is quantity x unit_cost. What it cost, as stated on the delivery.
--   STOCK OUT is quantity x carried_unit_cost. What it cost ON THE WAY OUT,
--             stamped at the instant it left. NEVER recomputed and never
--             re-derived from the fold — a moving average is path-dependent, so
--             one more receipt makes the fold give a different answer for the
--             same historic issue, and a ledger that disagrees with itself
--             depending on when it is read is not a ledger.
--   A REVERSAL uses carried_unit_cost IN BOTH DIRECTIONS, because that column
--             holds the exact basis being unwound (038 SECTION 7). That is what
--             makes an original and its counter net to exactly zero rather than
--             to a residue.
--
-- ONE ENTRY PER MOVEMENT, source_document_type 'stock_movement', so 044's
-- partial unique index makes a double post structurally impossible rather than
-- merely unlikely.
--
-- A REVERSAL POSTS A COUNTER-ENTRY, never an edit and never a deletion — the
-- same rule as the stock ledger it mirrors — and names the entry it unwinds
-- through reverses_entry_id, when that entry exists. It may not: the original
-- may have been dated before gl_start_date and booked nothing. The counter still
-- books nothing in that case, because it is dated today and the original's value
-- was never on the books to remove.
--
-- RETURNS NULL, WRITING NOTHING, IN FOUR CASES, all of them visible on
-- stock_movements_unposted (SECTION 7.4):
--   * the movement books nothing by type (a transfer);
--   * it has no cost basis, so booking it would mean guessing what the stock was
--     worth — which is the one thing a ledger must never do;
--   * its value rounds to zero, so there is no entry to make;
--   * it is dated before gl_start_date, which post_journal itself decides.
create or replace function post_stock_movement_journal(p_movement_id uuid)
returns journal_entries
language plpgsql
security definer
set search_path = public
as $$
declare
  v_m           stock_movements;
  v_role        text;
  v_basis       numeric;
  v_amount      numeric(14,2);
  v_item        text;
  v_location    text;
  v_unit        text;
  v_label       text;
  v_reverses    uuid;
  v_orig_type   text;
  v_lines       jsonb;
begin
  select * into v_m from stock_movements where id = p_movement_id;
  if not found then
    raise exception 'Stock movement % not found', p_movement_id using errcode = 'PT404';
  end if;

  -- ---- does this type book anything at all? --------------------------------
  v_role := stock_movement_counter_role(p_movement_id);
  if v_role is null then
    return null;
  end if;

  -- ---- the amount ----------------------------------------------------------
  if v_m.movement_type = 'reversal' then
    v_basis := v_m.carried_unit_cost;
  elsif v_m.quantity > 0 then
    v_basis := v_m.unit_cost;
  else
    v_basis := v_m.carried_unit_cost;
  end if;

  if v_basis is null then
    -- No cost basis. Booking it would mean guessing what the stock was worth,
    -- and a guess in a ledger is indistinguishable from a fact afterwards.
    return null;
  end if;

  v_amount := round(abs(v_m.quantity) * v_basis, 2);
  if v_amount = 0 then
    return null;
  end if;

  -- ---- what an accountant reads on the entry -------------------------------
  select i.name, i.base_unit into v_item, v_unit
  from inventory_items i where i.id = v_m.inventory_item_id;
  select l.name into v_location
  from locations l where l.id = v_m.location_id;

  if v_m.movement_type = 'reversal' then
    select o.movement_type into v_orig_type
    from stock_movements o where o.id = v_m.reverses_movement_id;
  end if;

  v_label := case v_m.movement_type
               when 'opening'          then 'Opening stock'
               when 'receipt'          then 'Stock received'
               when 'adjustment'       then
                 case when v_m.quantity > 0 then 'Stock adjustment, added'
                      else 'Stock adjustment, removed' end
               when 'count_adjustment' then
                 case when v_m.quantity > 0 then 'Stock count, found'
                      else 'Stock count, short' end
               when 'wastage'          then 'Stock written off — ' || coalesce(v_m.reason, v_m.reason_code)
               when 'reversal'         then 'Reversal of a ' || coalesce(v_orig_type, 'movement')
               else v_m.movement_type
             end;

  -- ---- the entry this one unwinds, when there is one -----------------------
  if v_m.reverses_movement_id is not null then
    select je.id into v_reverses
    from journal_entries je
    where je.tenant_id = v_m.tenant_id
      and je.source_document_type = 'stock_movement'
      and je.source_document_id   = v_m.reverses_movement_id;
  end if;

  -- ---- the two lines -------------------------------------------------------
  -- The INVENTORY side carries the amount; the counter side is left OPEN and
  -- becomes the sum of it (044's rule). With two lines the two are identical, and
  -- that is exactly why it is written this way: the day a third line appears —
  -- tax on a purchase, 1.1h3 — the counter is still the sum rather than a second
  -- independent calculation that can disagree by a kobo.
  v_lines := jsonb_build_array(
    jsonb_build_object(
      'role_key',    'inventory',
      'side',        case when v_m.quantity > 0 then 'debit' else 'credit' end,
      'amount',      v_amount,
      'description', format('%s %s at %s',
                            format_stock_quantity(abs(v_m.quantity)),
                            coalesce(v_unit, ''),
                            to_char(v_basis, 'FM999,999,999,990.00'))
    ),
    jsonb_build_object(
      'role_key',    v_role,
      'side',        case when v_m.quantity > 0 then 'credit' else 'debit' end,
      'description', coalesce(v_m.reason, v_m.note)
    )
  );

  return post_journal(
    v_m.property_id,
    v_m.business_date,
    format('%s — %s, %s', v_label, coalesce(v_item, 'item'), coalesce(v_location, 'location')),
    'stock_movement',
    v_m.id,
    v_lines,
    null,
    v_reverses
  );
end;
$$;

comment on function post_stock_movement_journal(uuid) is
  'THE ONE IMPLEMENTATION of booking a stock movement. Called at the end of every '
  'RPC that posts one, inside that RPC''s own transaction, through post_journal. '
  'STOCK IN is quantity x unit_cost; STOCK OUT is quantity x carried_unit_cost, '
  'READ and never recomputed (a moving average is path-dependent, so a recomputed '
  'cost of sale changes with every later receipt); a REVERSAL uses '
  'carried_unit_cost in both directions, which is what makes it net to exactly '
  'zero against its original and is why 038 stamped that column. ONE entry per '
  'movement (source_document_type ''stock_movement''), so 044''s unique index '
  'makes a double post impossible. Returns NULL and writes nothing when the type '
  'books nothing, when there is no cost basis, when the value rounds to zero, or '
  'before gl_start_date — every one of which is listed, with its reason, by '
  'stock_movements_unposted.';


-- ############################################################################
-- SECTION 5 — THE SIX THAT ALREADY MOVE MONEY, NOW POSTING
-- ############################################################################
-- This is the half that makes rule 1 of the ledger true. Until today every one
-- of these functions moved stock — which is money — and posted nowhere, and 044
-- recorded that gap with a date on it. This closes it.
--
--   post_opening_balance          debit inventory   credit opening_balance_equity
--   post_stock_receipt (direct)   debit inventory   credit supplier_payable / cash
--   post_stock_adjustment         either side, against stock_adjustment
--   finish_stock_take             either side, against stock_variance
--   post_stock_writeoff           debit wastage_<reason>   credit inventory
--   post_movement_reversal        a counter-entry naming the movement it unwinds
--
-- EACH IS RE-EMITTED WHOLE, as 038 -> 039 -> 041 each re-emitted their
-- predecessors. The alternative — a patch that only shows the new lines — leaves
-- the reader of this file unable to see what the function now is without opening
-- three others and applying them in order in their head.
--
-- WHAT CHANGED IN EACH IS EXACTLY ONE LINE, and it is the same line:
--
--     perform post_stock_movement_journal(v_movement.id);
--
-- placed immediately before the return, so a failure to post rolls the movement
-- back with it (rule 11) and there is no state in which stock moved and the
-- ledger did not hear about it.

-- ----------------------------------------------------------------------------
-- 5.1 post_opening_balance
-- ----------------------------------------------------------------------------
-- Debit inventory, credit OPENING BALANCE EQUITY — not a supplier and not cash.
-- An opening balance is not a purchase: it is the statement that this stock
-- already existed when the books opened, and the other side of it is the owner's
-- stake, which is what opening balance equity means.
create or replace function post_opening_balance(
  p_property_id       uuid,
  p_location_id       uuid,
  p_inventory_item_id uuid,
  p_quantity          numeric,
  p_unit_cost         numeric,
  p_business_date     date,
  p_note              text,
  p_idempotency_key   text,
  p_batch_code        text default null,
  p_expiry_date       date default null
)
returns stock_movements
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant   uuid;
  v_timezone text;
  v_today    date;
  v_date     date;
  v_tracks   boolean;
  v_batch    text;
  v_existing stock_movements;
  v_movement stock_movements;
begin
  select p.tenant_id, p.timezone into v_tenant, v_timezone
  from properties p
  where p.id = p_property_id and p.deleted_at is null;

  if v_tenant is null then
    raise exception 'Property % not found', p_property_id using errcode = 'PT404';
  end if;

  if not is_tenant_staff(v_tenant) then
    raise exception 'Not authorised to post stock movements for this property'
      using errcode = 'insufficient_privilege';
  end if;

  if p_idempotency_key is not null then
    select * into v_existing
    from stock_movements
    where tenant_id = v_tenant and idempotency_key = p_idempotency_key
    limit 1;
    if found then
      return v_existing;
    end if;
  end if;

  if not exists (
    select 1 from locations l
    where l.id = p_location_id
      and l.property_id = p_property_id
      and l.deleted_at is null
      and l.is_active = true
  ) then
    raise exception 'That stock location is not available for this property'
      using errcode = 'PT404';
  end if;

  select i.tracks_expiry into v_tracks
  from inventory_items i
  where i.id = p_inventory_item_id
    and i.tenant_id = v_tenant
    and i.deleted_at is null
    and i.is_active = true;

  if v_tracks is null then
    raise exception 'That item is not available in this catalogue'
      using errcode = 'PT404';
  end if;

  if p_quantity is null or p_quantity <= 0 then
    raise exception 'An opening balance must be greater than zero. To record nothing on hand, post no opening balance at all.'
      using errcode = 'PT422';
  end if;

  if p_unit_cost is null then
    raise exception 'A unit cost is required on an opening balance — it is what the stock on hand is worth.'
      using errcode = 'PT422';
  end if;
  if p_unit_cost < 0 then
    raise exception 'A unit cost cannot be negative' using errcode = 'PT422';
  end if;

  v_batch := nullif(btrim(coalesce(p_batch_code, '')), '');
  if v_tracks and (v_batch is null or p_expiry_date is null) then
    raise exception
      'This item is tracked by batch, so its batch code and expiry date are both required.'
      using errcode = 'PT422',
            hint = 'They are on the packaging. Without them a recall cannot tell which stock came from which delivery.';
  end if;

  v_today := (now() at time zone coalesce(nullif(btrim(v_timezone), ''), 'Africa/Lagos'))::date;
  v_date  := coalesce(p_business_date, v_today);

  if v_date > v_today then
    raise exception 'A stock movement cannot be dated in the future (today is % at this property)', v_today
      using errcode = 'PT422';
  end if;

  perform assert_posting_open(p_property_id, v_date);

  if exists (
    select 1 from stock_movements sm
    where sm.location_id = p_location_id
      and sm.inventory_item_id = p_inventory_item_id
      and sm.movement_type = 'opening'
  ) then
    raise exception 'This item already has an opening balance in this location. Post an adjustment to correct the quantity instead.'
      using errcode = 'PT409';
  end if;

  begin
    insert into stock_movements (
      tenant_id, property_id, location_id, inventory_item_id,
      movement_type, quantity, unit_cost, business_date,
      reason, note, source, batch_code, expiry_date,
      idempotency_key, created_by
    ) values (
      v_tenant, p_property_id, p_location_id, p_inventory_item_id,
      'opening', p_quantity, p_unit_cost, v_date,
      null, nullif(btrim(p_note), ''), 'manual', v_batch, p_expiry_date,
      p_idempotency_key, auth.uid()
    )
    returning * into v_movement;
  exception
    when unique_violation then
      if p_idempotency_key is not null then
        select * into v_existing
        from stock_movements
        where tenant_id = v_tenant and idempotency_key = p_idempotency_key
        limit 1;
        if found then
          return v_existing;
        end if;
      end if;
      raise exception 'This item already has an opening balance in this location. Post an adjustment to correct the quantity instead.'
        using errcode = 'PT409';
  end;

  -- 046: THE LEDGER. Inside this transaction, so a refusal here — a missing
  -- mapping, a closed period — takes the movement with it.
  perform post_stock_movement_journal(v_movement.id);

  return v_movement;
end;
$$;

comment on function post_opening_balance(uuid, uuid, uuid, numeric, numeric, date, text, text, text, date) is
  'Posts the day-one ''opening'' movement: what a location held when the hotel '
  'started using the system, and what it cost per base unit. ONCE per item per '
  'location, guarded twice (the idempotency key collapses an identical replay; '
  'stock_movements_one_opening_uniq refuses a second opening under any other '
  'key). 038 adds the posting-lock check and the batch/expiry pair. 046 POSTS: '
  'debit inventory, credit opening_balance_equity — not a supplier and not cash, '
  'because an opening balance is not a purchase but the statement that this '
  'stock already existed when the books opened. Staff-gated, SECURITY DEFINER, '
  'pinned search_path. ONGOING stock-in is a purchase receipt, never this.';


-- ----------------------------------------------------------------------------
-- 5.2 post_stock_adjustment
-- ----------------------------------------------------------------------------
-- Either side, against STOCK ADJUSTMENT — an expense account that means "the
-- count was wrong". Kept apart from the wastage accounts on purpose: blur a
-- correction with a loss and the variance report is worthless, which is
-- CLAUDE.md SECTION 9's rule expressed in the chart rather than only in the
-- movement type.
create or replace function post_stock_adjustment(
  p_property_id       uuid,
  p_location_id       uuid,
  p_inventory_item_id uuid,
  p_quantity          numeric,
  p_reason            text,
  p_business_date     date,
  p_unit_cost         numeric,
  p_idempotency_key   text,
  p_allow_negative    boolean default false,
  p_batch_code        text default null,
  p_expiry_date       date default null
)
returns stock_movements
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant   uuid;
  v_timezone text;
  v_today    date;
  v_date     date;
  v_reason   text;
  v_batch    text;
  v_tracks   boolean;
  v_existing stock_movements;
  v_movement stock_movements;
  v_val      record;
  v_cost     numeric;
  v_result   numeric;
  v_unit     text;
begin
  select p.tenant_id, p.timezone into v_tenant, v_timezone
  from properties p
  where p.id = p_property_id and p.deleted_at is null;

  if v_tenant is null then
    raise exception 'Property % not found', p_property_id using errcode = 'PT404';
  end if;

  if not is_tenant_staff(v_tenant) then
    raise exception 'Not authorised to post stock movements for this property'
      using errcode = 'insufficient_privilege';
  end if;

  if p_idempotency_key is not null then
    select * into v_existing
    from stock_movements
    where tenant_id = v_tenant and idempotency_key = p_idempotency_key
    limit 1;
    if found then
      return v_existing;
    end if;
  end if;

  if not exists (
    select 1 from locations l
    where l.id = p_location_id
      and l.property_id = p_property_id
      and l.deleted_at is null
      and l.is_active = true
  ) then
    raise exception 'That stock location is not available for this property'
      using errcode = 'PT404';
  end if;

  select i.base_unit, i.tracks_expiry into v_unit, v_tracks
  from inventory_items i
  where i.id = p_inventory_item_id
    and i.tenant_id = v_tenant
    and i.deleted_at is null;

  if v_unit is null then
    raise exception 'That item is not available in this catalogue'
      using errcode = 'PT404';
  end if;

  if p_quantity is null or p_quantity = 0 then
    raise exception 'An adjustment must add or remove some quantity. Enter a positive number to add stock or a negative one to remove it.'
      using errcode = 'PT422';
  end if;

  v_reason := nullif(btrim(coalesce(p_reason, '')), '');
  if v_reason is null then
    raise exception 'A reason is required for a stock adjustment — it is the record of why stock changed with no purchase or sale behind it.'
      using errcode = 'PT422';
  end if;

  v_today := (now() at time zone coalesce(nullif(btrim(v_timezone), ''), 'Africa/Lagos'))::date;
  v_date  := coalesce(p_business_date, v_today);

  if v_date > v_today then
    raise exception 'A stock movement cannot be dated in the future (today is % at this property)', v_today
      using errcode = 'PT422';
  end if;

  perform assert_posting_open(p_property_id, v_date);

  select * into v_val
  from stock_valuation(p_property_id, p_location_id, p_inventory_item_id);

  v_batch := nullif(btrim(coalesce(p_batch_code, '')), '');

  if p_quantity > 0 then
    v_cost := coalesce(p_unit_cost, v_val.moving_average_cost);
    if v_cost is null then
      raise exception 'This item has no stock history in this location, so a unit cost is required to add stock.'
        using errcode = 'PT422';
    end if;
    if v_cost < 0 then
      raise exception 'A unit cost cannot be negative' using errcode = 'PT422';
    end if;

    if v_tracks and (v_batch is null or p_expiry_date is null) then
      raise exception
        'This item is tracked by batch, so adding stock requires its batch code and expiry date.'
        using errcode = 'PT422',
              hint = 'They are on the packaging. Without them a recall cannot tell which stock came from which delivery.';
    end if;
  else
    if p_unit_cost is not null then
      raise exception 'A unit cost cannot be given when removing stock — stock leaves at its current average cost.'
        using errcode = 'PT422';
    end if;
    v_cost := null;

    if v_batch is not null or p_expiry_date is not null then
      raise exception
        'A batch code cannot be given when removing stock — which batch left is decided by the issue rules, not typed in here.'
        using errcode = 'PT422';
    end if;
  end if;

  v_result := coalesce(v_val.quantity_on_hand, 0) + p_quantity;
  if v_result < 0 and not coalesce(p_allow_negative, false) then
    raise exception
      'This adjustment would leave % % on hand, which is less than nothing. Check the quantity — or confirm to record it anyway.',
      format_stock_quantity(v_result), v_unit
      using errcode = 'PT449';
  end if;

  begin
    insert into stock_movements (
      tenant_id, property_id, location_id, inventory_item_id,
      movement_type, quantity, unit_cost, business_date,
      reason, note, source, batch_code, expiry_date,
      idempotency_key, created_by
    ) values (
      v_tenant, p_property_id, p_location_id, p_inventory_item_id,
      'adjustment', p_quantity, v_cost, v_date,
      v_reason, null, 'manual', v_batch, p_expiry_date,
      p_idempotency_key, auth.uid()
    )
    returning * into v_movement;
  exception
    when unique_violation then
      if p_idempotency_key is not null then
        select * into v_existing
        from stock_movements
        where tenant_id = v_tenant and idempotency_key = p_idempotency_key
        limit 1;
        if found then
          return v_existing;
        end if;
      end if;
      raise;
  end;

  -- 046: THE LEDGER.
  perform post_stock_movement_journal(v_movement.id);

  return v_movement;
end;
$$;

comment on function post_stock_adjustment(uuid, uuid, uuid, numeric, text, date, numeric, text, boolean, text, date) is
  'Posts an ''adjustment'' movement — a correction with no purchase or sale behind '
  'it, which is why a REASON is mandatory and the actor is stamped from the '
  'session and unforgeable. Signed quantity: + adds, - removes. A positive '
  'adjustment defaults its unit cost to the CURRENT moving average; a negative one '
  'may state no cost and no batch. An adjustment that would drive on-hand below '
  'zero raises PT449 and must be re-submitted with p_allow_negative => true and '
  'the SAME idempotency key — flagged, never blocked. 046 POSTS it against '
  'stock_adjustment, either side, which is deliberately NOT a wastage account: '
  'blur a correction with a loss and the variance report is worthless. '
  'Staff-gated, idempotent (rules 2/3), SECURITY DEFINER, pinned search_path.';


-- ----------------------------------------------------------------------------
-- 5.3 post_stock_writeoff
-- ----------------------------------------------------------------------------
-- Debit the wastage_* key FOR THAT REASON CODE, credit inventory. Five accounts,
-- not one: spoilage and breakage are questions about how the store is run,
-- expiry is a question about ordering, and staff meals and complimentaries are
-- costs of doing business that nobody should be chasing. A single wastage
-- account merges all five into a figure that answers none of them.
create or replace function post_stock_writeoff(
  p_property_id       uuid,
  p_location_id       uuid,
  p_inventory_item_id uuid,
  p_quantity          numeric,
  p_reason_code       text,
  p_business_date     date,
  p_note              text,
  p_idempotency_key   text,
  p_allow_negative    boolean default false
)
returns stock_movements
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant   uuid;
  v_timezone text;
  v_today    date;
  v_date     date;
  v_code     text;
  v_label    text;
  v_unit     text;
  v_val      record;
  v_result   numeric;
  v_existing stock_movements;
  v_movement stock_movements;
begin
  select p.tenant_id, p.timezone into v_tenant, v_timezone
  from properties p
  where p.id = p_property_id and p.deleted_at is null;

  if v_tenant is null then
    raise exception 'Property % not found', p_property_id using errcode = 'PT404';
  end if;

  if not is_tenant_staff(v_tenant) then
    raise exception 'Not authorised to post stock movements for this property'
      using errcode = 'insufficient_privilege';
  end if;

  if p_idempotency_key is not null then
    select * into v_existing
    from stock_movements
    where tenant_id = v_tenant and idempotency_key = p_idempotency_key
    limit 1;
    if found then
      return v_existing;
    end if;
  end if;

  if not exists (
    select 1 from locations l
    where l.id = p_location_id
      and l.property_id = p_property_id
      and l.deleted_at is null
      and l.is_active = true
  ) then
    raise exception 'That stock location is not available for this property'
      using errcode = 'PT404';
  end if;

  select i.base_unit into v_unit
  from inventory_items i
  where i.id = p_inventory_item_id
    and i.tenant_id = v_tenant
    and i.deleted_at is null;

  if v_unit is null then
    raise exception 'That item is not available in this catalogue'
      using errcode = 'PT404';
  end if;

  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Enter how much was lost, as a number greater than zero.'
      using errcode = 'PT422',
            hint = 'A write-off always removes stock, so it is entered as a plain quantity — not as a negative number.';
  end if;

  v_code := nullif(btrim(lower(coalesce(p_reason_code, ''))), '');
  if v_code is null then
    raise exception 'A write-off needs a reason category.'
      using errcode = 'PT422',
            hint = 'Spoilage, breakage, expiry, staff meal or complimentary. It is what makes wastage reportable — free text alone cannot be grouped.';
  end if;

  v_label := case v_code
               when 'spoilage'      then 'Spoilage'
               when 'breakage'      then 'Breakage'
               when 'expiry'        then 'Expired'
               when 'staff_meal'    then 'Staff meal'
               when 'complimentary' then 'Complimentary'
               else null
             end;

  if v_label is null then
    raise exception 'Unknown write-off reason "%".', p_reason_code
      using errcode = 'PT422',
            hint = 'Use one of: spoilage, breakage, expiry, staff_meal, complimentary.';
  end if;

  v_today := (now() at time zone coalesce(nullif(btrim(v_timezone), ''), 'Africa/Lagos'))::date;
  v_date  := coalesce(p_business_date, v_today);

  if v_date > v_today then
    raise exception 'A stock movement cannot be dated in the future (today is % at this property)', v_today
      using errcode = 'PT422';
  end if;

  perform assert_posting_open(p_property_id, v_date);

  select * into v_val
  from stock_valuation(p_property_id, p_location_id, p_inventory_item_id);

  v_result := coalesce(v_val.quantity_on_hand, 0) - p_quantity;
  if v_result < 0 and not coalesce(p_allow_negative, false) then
    raise exception
      'Writing off % % would leave % % on hand, which is less than nothing. Check the quantity — or confirm to record it anyway.',
      rtrim(rtrim(trim(to_char(p_quantity, 'FM999999999990.0000')), '0'), '.'), v_unit,
      rtrim(rtrim(trim(to_char(v_result, 'FM999999999990.0000')), '0'), '.'), v_unit
      using errcode = 'PT449',
            hint = 'A negative on-hand means stock left without a movement behind it. It is recorded rather than blocked, so the discrepancy stays visible.';
  end if;

  begin
    insert into stock_movements (
      tenant_id, property_id, location_id, inventory_item_id,
      movement_type, quantity, unit_cost, business_date,
      reason, reason_code, note, source, idempotency_key, created_by
    ) values (
      v_tenant, p_property_id, p_location_id, p_inventory_item_id,
      'wastage', -p_quantity,
      null, v_date,
      v_label, v_code, nullif(btrim(coalesce(p_note, '')), ''), 'manual',
      p_idempotency_key, auth.uid()
    )
    returning * into v_movement;
  exception
    when unique_violation then
      if p_idempotency_key is not null then
        select * into v_existing
        from stock_movements
        where tenant_id = v_tenant and idempotency_key = p_idempotency_key
        limit 1;
        if found then
          return v_existing;
        end if;
      end if;
      raise;
  end;

  -- 046: THE LEDGER. Debits the wastage key for THIS reason code.
  perform post_stock_movement_journal(v_movement.id);

  return v_movement;
end;
$$;

comment on function post_stock_writeoff(uuid, uuid, uuid, numeric, text, date, text, text, boolean) is
  'Posts a ''wastage'' movement — stock LOST, with the reason as a category '
  '(spoilage/breakage/expiry/staff_meal/complimentary). NOT an adjustment, and '
  'the distinction is the point: an adjustment means the count was wrong, a '
  'write-off means we lost it and here is why. Quantity is entered as a POSITIVE '
  'magnitude and negated here. States NO unit cost — 038''s trigger stamps '
  'carried_unit_cost at the instant it leaves, which is what makes wastage '
  'reportable in naira and is READ, never recomputed. 046 POSTS it to the '
  'wastage_* key FOR THAT REASON CODE, not to one wastage account: two of the '
  'five categories are theft questions and two are costs of doing business, and '
  'one account answers neither. Staff-gated, posting-lock checked, idempotent.';


-- ----------------------------------------------------------------------------
-- 5.4 post_stock_receipt — THE ADDITIVE EXTENSION, and the posting
-- ----------------------------------------------------------------------------
-- Four parameters are added, all defaulted, so every existing caller is
-- unaffected and the direct-receipt screen keeps working unchanged:
--
--   p_source                'manual' by default; 'purchase' when a goods receipt
--                           posts it, so the movement ledger says where it came
--                           from without a join.
--   p_source_document_type  and
--   p_source_document_id    the GRN this movement belongs to, so one click gets
--                           from a movement back to the delivery note.
--   p_post_journal          DEFAULT TRUE. A goods receipt passes FALSE and posts
--                           ONE entry for the whole delivery instead of N.
--
-- WHY p_post_journal IS A PARAMETER AND NOT A NAME THE FUNCTION RECOGNISES. The
-- alternative — skipping the posting whenever source_document_type looks like a
-- purchase — hides a posting decision inside a string comparison, and the day a
-- second document type posts its own entry, whoever adds it has to know to add
-- it to that list too. Forgetting means the delivery is booked TWICE, in full,
-- and the ledger balances perfectly while being wrong by the value of a
-- delivery. An explicit flag makes the caller state its intent.
--
-- THE STORE RULE IS UNCHANGED AND UNMOVED, which is the destination equivalence:
-- a goods receipt reaches stock through THIS function, so ordering to a bar
-- still needs a manager PIN and a reason and still lands on the provenance
-- report. There is no second receiving implementation to drift.
--
-- DROPPED AND RECREATED rather than replaced, because the argument list changes.
-- SECTION 9 re-issues the grants a drop takes with it.
drop function if exists post_stock_receipt(uuid, uuid, uuid, numeric, numeric, date, text, text, text, text, date, text, text);

create or replace function post_stock_receipt(
  p_property_id       uuid,
  p_location_id       uuid,
  p_inventory_item_id uuid,
  p_quantity          numeric,
  p_unit_cost         numeric,
  p_business_date     date,
  p_supplier          text,
  p_note              text,
  p_idempotency_key   text,
  p_batch_code        text default null,
  p_expiry_date       date default null,
  p_manager_pin       text default null,
  p_reason            text default null,
  -- 046, all defaulted so no existing caller changes.
  p_source                text    default 'manual',
  p_source_document_type  text    default null,
  p_source_document_id    uuid    default null,
  p_post_journal          boolean default true
)
returns stock_movements
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_tenant    uuid;
  v_timezone  text;
  v_today     date;
  v_date      date;
  v_kind      text;
  v_locname   text;
  v_tracks    boolean;
  v_batch     text;
  v_reason    text;
  v_manager   uuid;
  v_existing  stock_movements;
  v_movement  stock_movements;
begin
  select p.tenant_id, p.timezone into v_tenant, v_timezone
  from properties p
  where p.id = p_property_id and p.deleted_at is null;

  if v_tenant is null then
    raise exception 'Property % not found', p_property_id using errcode = 'PT404';
  end if;

  if not is_tenant_staff(v_tenant) then
    raise exception 'Not authorised to post stock movements for this property'
      using errcode = 'insufficient_privilege';
  end if;

  if p_idempotency_key is not null then
    select * into v_existing
    from stock_movements
    where tenant_id = v_tenant and idempotency_key = p_idempotency_key
    limit 1;
    if found then
      return v_existing;
    end if;
  end if;

  select l.kind, l.name into v_kind, v_locname
  from locations l
  where l.id = p_location_id
    and l.property_id = p_property_id
    and l.deleted_at is null
    and l.is_active = true;

  if v_kind is null then
    raise exception 'That stock location is not available for this property'
      using errcode = 'PT404';
  end if;

  select i.tracks_expiry into v_tracks
  from inventory_items i
  where i.id = p_inventory_item_id
    and i.tenant_id = v_tenant
    and i.deleted_at is null
    and i.is_active = true;

  if v_tracks is null then
    raise exception 'That item is not available in this catalogue'
      using errcode = 'PT404',
            hint = 'An item that has been switched off cannot be received. Turn it back on first, or receive against the item you actually bought.';
  end if;

  if p_quantity is null or p_quantity <= 0 then
    raise exception 'A receipt must be a positive quantity — it is stock arriving.'
      using errcode = 'PT422',
            hint = 'To take stock OUT, post a write-off or an adjustment instead.';
  end if;

  if p_unit_cost is null then
    raise exception 'A receipt must state what one % cost.',
      (select base_unit from inventory_items where id = p_inventory_item_id)
      using errcode = 'PT422',
            hint = 'It is what moves this item''s average cost, and every valuation and food-cost figure is built on it. It is on the delivery note or the invoice.';
  end if;

  if p_unit_cost < 0 then
    raise exception 'A unit cost cannot be negative' using errcode = 'PT422';
  end if;

  v_batch := nullif(btrim(coalesce(p_batch_code, '')), '');
  if v_tracks and (v_batch is null or p_expiry_date is null) then
    raise exception
      'This item is tracked by batch, so its batch code and expiry date are both required.'
      using errcode = 'PT422',
            hint = 'They are on the packaging. Without them a recall cannot tell which stock came from which delivery.';
  end if;

  v_today := (now() at time zone coalesce(nullif(btrim(v_timezone), ''), 'Africa/Lagos'))::date;
  v_date  := coalesce(p_business_date, v_today);

  if v_date > v_today then
    raise exception 'A stock movement cannot be dated in the future (today is % at this property)', v_today
      using errcode = 'PT422';
  end if;

  perform assert_posting_open(p_property_id, v_date);

  -- ------------------------------------------------------------------------
  -- ONLY THE STORE RECEIVES — and a purchase order is not a way around it.
  -- ------------------------------------------------------------------------
  v_reason := nullif(btrim(coalesce(p_reason, '')), '');

  if v_kind <> 'store' then
    if p_manager_pin is null or v_reason is null then
      raise exception
        'Stock is received into a store, not into %. Goods reach a kitchen or a bar by being issued from the store.',
        v_locname
        using errcode = 'PT403',
              hint = 'If this delivery genuinely went straight there, a manager can authorise it with their PIN and a reason. It will be listed on the stock provenance report.';
    end if;

    v_manager := verify_manager_pin(v_tenant, p_manager_pin);
    if v_manager is null then
      raise exception 'Receiving stock somewhere other than a store requires a valid manager PIN'
        using errcode = 'insufficient_privilege',
              hint = 'Hand the terminal to a manager. The receipt is recorded against them by name, and appears on the stock provenance report.';
    end if;
  else
    if p_manager_pin is not null then
      raise exception 'No manager PIN is needed to receive stock into %.', v_locname
        using errcode = 'PT422',
              hint = 'A PIN authorises a delivery going somewhere other than a store. This one is going to a store.';
    end if;
    v_manager := null;
  end if;

  begin
    insert into stock_movements (
      tenant_id, property_id, location_id, inventory_item_id,
      movement_type, quantity, unit_cost, business_date,
      reason, note, source, supplier, authorised_by,
      source_document_type, source_document_id,
      batch_code, expiry_date, idempotency_key, created_by
    ) values (
      v_tenant, p_property_id, p_location_id, p_inventory_item_id,
      'receipt', p_quantity, p_unit_cost, v_date,
      v_reason, nullif(btrim(coalesce(p_note, '')), ''),
      coalesce(nullif(btrim(coalesce(p_source, '')), ''), 'manual'),
      nullif(btrim(coalesce(p_supplier, '')), ''), v_manager,
      nullif(btrim(coalesce(p_source_document_type, '')), ''), p_source_document_id,
      v_batch, p_expiry_date, p_idempotency_key, auth.uid()
    )
    returning * into v_movement;
  exception
    when unique_violation then
      if p_idempotency_key is not null then
        select * into v_existing
        from stock_movements
        where tenant_id = v_tenant and idempotency_key = p_idempotency_key
        limit 1;
        if found then
          return v_existing;
        end if;
      end if;
      raise;
  end;

  -- 046: THE LEDGER — unless the document this belongs to posts its own entry.
  -- A goods receipt books ONE entry for N lines and passes false here; a direct
  -- receipt books its own.
  if coalesce(p_post_journal, true) then
    perform post_stock_movement_journal(v_movement.id);
  end if;

  return v_movement;
end;
$$;

comment on function post_stock_receipt(uuid, uuid, uuid, numeric, numeric, date, text, text, text, text, date, text, text, text, text, uuid, boolean) is
  'Posts a ''receipt'' — stock arriving from outside, and THE movement that '
  'recomputes the moving average. Quantity must be positive and a unit cost is '
  'REQUIRED: a stock-in with no cost is the one input that would silently corrupt '
  'every valuation. ONLY A LOCATION WITH kind = ''store'' MAY RECEIVE, with one '
  'permissioned exception (a valid manager PIN plus a mandatory reason, recorded '
  'in authorised_by and listed on the provenance report) — and a PURCHASE ORDER '
  'IS NOT A WAY AROUND IT, because receive_purchase_order reaches stock through '
  'this same function. 046 adds four defaulted parameters — p_source, the source '
  'document pair, and p_post_journal — and POSTS: debit inventory, credit '
  'supplier_payable when a supplier is named, else cash. p_post_journal => false '
  'is how a goods receipt books ONE entry for the whole delivery instead of one '
  'per line; it is an explicit flag rather than a document type this function '
  'recognises, because forgetting to add a type to such a list would double-post '
  'a delivery while balancing perfectly.';


-- ----------------------------------------------------------------------------
-- 5.5 post_movement_reversal — the counter-entry
-- ----------------------------------------------------------------------------
-- A REVERSAL POSTS A COUNTER-ENTRY, never an edit and never a deletion. Same
-- rule as the stock ledger it mirrors, and the same rule 044 wrote into
-- journal_entries by giving it no is_voided column and an immutability trigger.
--
-- Both entries stay visible and the pair nets to zero. That is what an audit
-- trail is: not the absence of mistakes, but the presence of every correction.
create or replace function post_movement_reversal(
  p_movement_id     uuid,
  p_reason          text,
  p_approved_by     uuid,
  p_actor           uuid,
  p_idempotency_key text
)
returns stock_movements
language plpgsql
security definer
set search_path = public
as $$
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
  perform post_stock_movement_journal(v_counter.id);

  return v_counter;
end;
$$;

comment on function post_movement_reversal(uuid, text, uuid, uuid, text) is
  'THE ONE IMPLEMENTATION of reversing a stock movement: the state guards, the '
  'cost basis, the stranding guard, the counter-movement, the permanent reversals '
  'row and — 046 — the COUNTER-ENTRY in the ledger. Never an edit and never a '
  'deletion: both entries stay visible and the pair nets to zero, which is what '
  'an audit trail is. It does NOT verify a PIN — the CALLER does, and passes the '
  'manager it verified. REVOKED from every client role: it is a PIN-gated act '
  'with the PIN taken out.';


-- ----------------------------------------------------------------------------
-- 5.6 finish_stock_take
-- ----------------------------------------------------------------------------
-- Either side, against STOCK COUNT VARIANCE — a third account, separate from
-- both stock_adjustment and the wastage keys, because the three answer three
-- different questions. An adjustment is somebody correcting a figure they know
-- is wrong. A write-off is a named loss. A COUNT VARIANCE is what the shelves
-- said when nobody was correcting anything, and it is the one number an owner
-- reads to find out whether the other two are being used honestly.
--
-- ONE ENTRY PER MOVEMENT, not one per count. A count of two hundred items posts
-- two hundred movements and two hundred entries, and that is right: the entry is
-- attributable to an ITEM, so "what did we lose on rice this quarter" is a query
-- rather than a reconstruction. The GRN is the opposite case and posts one entry
-- for the whole delivery, because a delivery is one transaction with one
-- supplier for one invoiced total — there is nothing to attribute separately.
create or replace function finish_stock_take(
  p_stock_take_id     uuid,
  p_manager_pin       text,
  p_idempotency_key   text default null,
  p_allow_moved_stock boolean default false
)
returns stock_takes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_take      stock_takes;
  v_existing  stock_takes;
  v_key       text;
  v_threshold numeric(14,2);
  v_absolute  numeric := 0;
  v_manager   uuid;
  v_actor     uuid := auth.uid();
  v_line      record;
  v_cost      numeric;
  v_variance  numeric;
  v_reason    text;
  v_movement  stock_movements;
  v_moved     text;
  v_moved_n   integer;
begin
  select * into v_take from stock_takes where id = p_stock_take_id for update;
  if not found then
    raise exception 'Stock count % not found', p_stock_take_id using errcode = 'PT404';
  end if;

  if not is_tenant_staff(v_take.tenant_id) then
    raise exception 'Not authorised to finish stock counts for this property'
      using errcode = 'insufficient_privilege',
            hint = 'Ask an administrator to add you to this hotel''s team.';
  end if;

  v_key := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  if v_key is not null then
    select * into v_existing
    from stock_takes
    where tenant_id = v_take.tenant_id and close_idempotency_key = v_key
    limit 1;
    if found then
      return v_existing;
    end if;
  else
    v_key := 'close_stock_take:' || p_stock_take_id::text;
  end if;

  if v_take.status <> 'open' then
    raise exception 'Count % is already %.', v_take.take_number, v_take.status
      using errcode = 'PT409',
            hint = 'A count settles once. Start a new one for this location if the shelves need counting again.';
  end if;

  perform assert_posting_open(v_take.property_id, v_take.business_date);

  if not coalesce(p_allow_moved_stock, false) then
    with risky as (
      select i.name
      from stock_take_lines l
      join inventory_items i on i.id = l.inventory_item_id
      where l.stock_take_id = v_take.id
        and l.counted_quantity is not null
        and exists (
          select 1
          from stock_movements m
          where m.location_id = v_take.location_id
            and m.inventory_item_id = l.inventory_item_id
            and m.created_at > v_take.started_at
            and m.created_at <= l.counted_at
        )
    )
    select (select count(*) from risky)::integer,
           (select string_agg(r.name, ', ' order by r.name)
              from (select name from risky order by name limit 5) r)
      into v_moved_n, v_moved;

    if v_moved_n > 0 then
      if v_moved_n > 5 then
        v_moved := v_moved || ', and ' || (v_moved_n - 5)::text || ' more';
      end if;

      raise exception
        'Stock moved in this location while this count was running, and % of the items you counted were counted AFTER it moved: %. Counting a shelf after a delivery has been put on it records that delivery twice — once as the receipt, and again as a difference the count appears to have found.',
        v_moved_n, v_moved
        using errcode = 'PT449',
              hint = 'Check those shelves against their movements. Clear the affected lines and count them again, or confirm to finish anyway and record the differences exactly as they stand.';
    end if;
  end if;

  -- PASS 1: value every counted line, and stamp the cost it will move at.
  for v_line in
    select l.id, l.inventory_item_id, l.expected_quantity, l.counted_quantity,
           i.name as item_name
    from stock_take_lines l
    join inventory_items i on i.id = l.inventory_item_id
    where l.stock_take_id = v_take.id
      and l.counted_quantity is not null
    order by i.name, l.inventory_item_id
  loop
    v_cost := stock_moving_average_cost(
                v_take.property_id, v_take.location_id, v_line.inventory_item_id);
    v_variance := v_line.counted_quantity - v_line.expected_quantity;

    if v_cost is null and v_variance > 0 then
      raise exception
        'The count found more % than the ledger has any cost for, so the difference cannot be valued.',
        v_line.item_name
        using errcode = 'PT422',
              hint = 'Post an opening balance or an adjustment stating the cost explicitly, then count again.';
    end if;

    update stock_take_lines
       set variance_unit_cost = v_cost,
           updated_by = v_actor
     where id = v_line.id;

    v_absolute := v_absolute + abs(round(v_variance * coalesce(v_cost, 0), 2));
  end loop;

  select pfs.count_variance_threshold into v_threshold
  from property_finance_settings pfs
  where pfs.property_id = v_take.property_id;
  v_threshold := coalesce(v_threshold, 0);

  if v_absolute > v_threshold then
    v_manager := verify_manager_pin(v_take.tenant_id, p_manager_pin);
    if v_manager is null then
      raise exception
        'This count''s variance is above this property''s approval threshold of %, so a manager must authorise it.',
        to_char(v_threshold, 'FM999,999,999,990.00')
        using errcode = 'insufficient_privilege',
              hint = 'Hand the terminal to a manager. The approval is recorded against them by name, permanently.';
    end if;
  end if;

  -- PASS 2: post one 'count_adjustment' movement per NON-ZERO variance.
  v_reason := case
                when v_take.note is not null and btrim(v_take.note) <> ''
                  then format('Stock count %s on %s — %s',
                              v_take.take_number,
                              to_char(v_take.business_date, 'DD Mon YYYY'),
                              btrim(v_take.note))
                else format('Stock count %s on %s',
                            v_take.take_number,
                            to_char(v_take.business_date, 'DD Mon YYYY'))
              end;

  for v_line in
    select l.id, l.inventory_item_id, l.expected_quantity, l.counted_quantity,
           l.variance_unit_cost, i.name as item_name
    from stock_take_lines l
    join inventory_items i on i.id = l.inventory_item_id
    where l.stock_take_id = v_take.id
      and l.counted_quantity is not null
      and l.counted_quantity <> l.expected_quantity
    order by i.name, l.inventory_item_id
  loop
    v_variance := v_line.counted_quantity - v_line.expected_quantity;

    insert into stock_movements (
      tenant_id, property_id, location_id, inventory_item_id,
      movement_type, quantity, unit_cost, business_date,
      reason, note, source,
      source_document_type, source_document_id,
      idempotency_key, created_by
    ) values (
      v_take.tenant_id, v_take.property_id, v_take.location_id,
      v_line.inventory_item_id,
      'count_adjustment',
      v_variance,
      case when v_variance > 0 then round(v_line.variance_unit_cost, 2) else null end,
      v_take.business_date,
      v_reason,
      format('Counted %s against %s expected',
             format_stock_quantity(v_line.counted_quantity),
             format_stock_quantity(v_line.expected_quantity)),
      'stock_take',
      'stock_take', v_take.id,
      'stock_take:' || v_take.id::text || ':' || v_line.inventory_item_id::text,
      v_actor
    )
    returning * into v_movement;

    update stock_take_lines
       set movement_id = v_movement.id,
           updated_by = v_actor
     where id = v_line.id;

    -- 046: THE LEDGER, per movement — inside the same loop and the same
    -- transaction, so a missing stock_variance mapping refuses the WHOLE count
    -- and no line is left posted against a ledger that never heard about it.
    perform post_stock_movement_journal(v_movement.id);
  end loop;

  begin
    update stock_takes t
       set status = 'finished',
           finished_at = now(),
           finished_by = v_actor,
           approved_by = v_manager,
           close_idempotency_key = v_key,
           updated_by = v_actor
     where t.id = v_take.id
    returning * into v_take;
  exception
    when unique_violation then
      select * into v_existing
      from stock_takes t
      where t.tenant_id = v_take.tenant_id and t.close_idempotency_key = v_key
      limit 1;
      if found then
        return v_existing;
      end if;
      raise;
  end;

  return v_take;
end;
$$;

comment on function finish_stock_take(uuid, text, text, boolean) is
  'Finishes a count: values every counted line at the moving average it found the '
  'stock at, requires a manager PIN when the ABSOLUTE variance value exceeds the '
  'property''s count_variance_threshold, and posts ONE ''count_adjustment'' '
  'movement per non-zero variance. Variance is measured against the SNAPSHOT '
  'taken at start. WARNS FIRST (PT449) when stock moved in the location while the '
  'count was running AND the affected items were counted after it moved. 046 '
  'POSTS each of those movements against STOCK COUNT VARIANCE — a third account, '
  'separate from stock_adjustment and from the wastage keys, because a variance '
  'is what the shelves said when nobody was correcting anything and is the number '
  'that shows whether the other two are being used honestly. One entry per '
  'MOVEMENT, so a loss is attributable to an item. Staff-gated, idempotent by key '
  'and by state, one transaction throughout (rule 11).';


-- ############################################################################
-- SECTION 6 — THE PURCHASING RPCs
-- ############################################################################
-- FOUR, NAMED BEFORE THEY WERE WRITTEN, because "and the other bits of order
-- management" is how a fifth appears later with a different idea about what a
-- draft is:
--
--   save_purchase_order    creates or rewrites a DRAFT, header and lines
--                          together. REFUSES ANYTHING THAT IS NOT A DRAFT.
--   place_purchase_order   draft -> ordered. The moment it becomes immutable.
--   cancel_purchase_order  -> cancelled, with a mandatory reason.
--   receive_purchase_order records a delivery: receipt, lines, movements and
--                          ONE journal entry.
--
-- There is deliberately no fifth for closing an order short. A line is closed
-- short ON A RECEIPT, which is where somebody is actually standing when they
-- learn nothing more is coming, and the order then walks to 'received' by
-- itself.
--
-- ----------------------------------------------------------------------------
-- A RETRY WITH THE SAME KEY AND A DIFFERENT PAYLOAD IS REFUSED BY NAME
-- ----------------------------------------------------------------------------
-- Rule 2 says a replayed key returns the row that already exists. That is right
-- for a RETRY — the same request, sent twice, because a connection dropped. It
-- is dangerously wrong for a DIFFERENT request that happens to reuse a key: the
-- caller believes their edit saved, the server hands back the previous order,
-- and nothing anywhere errors. The two are indistinguishable at the server
-- unless the payload is fingerprinted, so it is.
--
-- md5 OF THE CANONICAL JSONB, not of a hand-built string: jsonb normalises key
-- order and whitespace, so the same request fingerprints identically however the
-- client happened to serialise it. It is a collision check between two of one
-- caller's own requests, not a security boundary, which is what makes md5 the
-- right tool rather than a weak one.

-- ----------------------------------------------------------------------------
-- 6.1 save_purchase_order
-- ----------------------------------------------------------------------------
-- AN ORDERED PURCHASE ORDER IS IMMUTABLE, and this function refuses anything
-- that is not a draft — before the trigger would, so the person reads a sentence
-- about purchase orders rather than one about rows.
--
-- LINES ARE REPLACED WHOLE, not merged. A draft is a document somebody is
-- writing; the client sends what it should now say, and the server makes it say
-- that. Merging would need a client-side identity for a line that has never been
-- anything but a row in a form.
create or replace function save_purchase_order(
  p_property_id             uuid,
  p_purchase_order_id       uuid,
  p_supplier_id             uuid,
  p_order_date              date,
  p_expected_date           date,
  p_destination_location_id uuid,
  p_note                    text,
  p_lines                   jsonb,
  p_idempotency_key         text
)
returns purchase_orders
language plpgsql
security definer
set search_path = public
as $$
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

    -- ASSET AND EXPENSE REFUSED BY NAME, and the message names the shipment.
    -- The table already holds their shape (2.2), so 1.1h3 adds a write path
    -- rather than a migration against live orders.
    if v_type in ('asset', 'expense') then
      raise exception
        'Line %: a purchase order cannot yet carry % lines — only stock items.',
        v_n, v_type
        using errcode = 'PT501',
              hint = 'Assets and expenses on a purchase order arrive in 1.1h3, with the accounts they post to. For now, order stock here and record the rest as a direct expense when that screen exists.';
    end if;

    if v_type is distinct from 'inventory' then
      raise exception 'Line %: "%" is not a kind of purchase line.', v_n, v_type
        using errcode = 'PT422',
              hint = 'Use inventory. Asset and expense lines arrive in 1.1h3.';
    end if;

    v_item := nullif(btrim(coalesce(v_line ->> 'inventory_item_id', '')), '')::uuid;
    if v_item is null then
      raise exception 'Line %: choose the item you are ordering.', v_n
        using errcode = 'PT422';
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
    insert into purchase_order_lines (
      tenant_id, purchase_order_id, line_number, line_type,
      inventory_item_id, quantity, unit_cost, note, created_by
    ) values (
      v_tenant, v_order.id, v_n, 'inventory',
      (v_line ->> 'inventory_item_id')::uuid,
      (v_line ->> 'quantity')::numeric,
      round((v_line ->> 'unit_cost')::numeric, 2),
      nullif(btrim(coalesce(v_line ->> 'note', '')), ''),
      auth.uid()
    );
  end loop;

  return v_order;
end;
$$;

comment on function save_purchase_order(uuid, uuid, uuid, date, date, uuid, text, jsonb, text) is
  'Creates or rewrites a DRAFT purchase order, header and lines together, and '
  'REFUSES anything that is not a draft — an ordered purchase order is immutable, '
  'and this says so in sentences about purchase orders before the trigger says it '
  'in sentences about rows. Lines are replaced whole rather than merged: a draft '
  'is a document somebody is writing, and the client sends what it should now '
  'say. ASSET AND EXPENSE LINES ARE REFUSED BY NAME, naming 1.1h3 — the shape '
  'CHECK already holds them, so that shipment adds a write path rather than '
  'reshaping a table with live orders in it. A retry under the same idempotency '
  'key carrying a DIFFERENT payload is refused (PT409) rather than silently '
  'handed the first order, which would leave the caller believing an edit saved.';


-- ----------------------------------------------------------------------------
-- 6.2 place_purchase_order — the moment it becomes immutable
-- ----------------------------------------------------------------------------
create or replace function place_purchase_order(
  p_purchase_order_id uuid,
  p_idempotency_key   text default null
)
returns purchase_orders
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order    purchase_orders;
  v_existing purchase_orders;
  v_key      text;
  v_lines    integer;
begin
  select * into v_order from purchase_orders where id = p_purchase_order_id for update;
  if not found then
    raise exception 'Purchase order % not found', p_purchase_order_id using errcode = 'PT404';
  end if;

  if not is_tenant_staff(v_order.tenant_id) then
    raise exception 'Not authorised to send purchase orders for this property'
      using errcode = 'insufficient_privilege';
  end if;

  v_key := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  if v_key is not null then
    select * into v_existing
    from purchase_orders
    where tenant_id = v_order.tenant_id and place_idempotency_key = v_key
    limit 1;
    if found then
      return v_existing;
    end if;
  else
    v_key := 'place_purchase_order:' || p_purchase_order_id::text;
  end if;

  -- Already sent under a different key: say so, rather than refusing a person
  -- who pressed the button twice.
  if v_order.status <> 'draft' then
    if v_order.status in ('ordered', 'part_received', 'received') then
      return v_order;
    end if;
    raise exception 'Purchase order % is %, so it cannot be sent.',
      v_order.order_number, v_order.status
      using errcode = 'PT409',
            hint = 'Raise a new order rather than reviving a cancelled one.';
  end if;

  select count(*)::integer into v_lines
  from purchase_order_lines where purchase_order_id = v_order.id;

  if v_lines = 0 then
    raise exception 'Purchase order % has nothing on it.', v_order.order_number
      using errcode = 'PT422',
            hint = 'Add what you are ordering before sending it.';
  end if;

  update purchase_orders
     set status                = 'ordered',
         ordered_at            = now(),
         ordered_by            = auth.uid(),
         place_idempotency_key = v_key,
         updated_by            = auth.uid()
   where id = v_order.id
  returning * into v_order;

  return v_order;
end;
$$;

comment on function place_purchase_order(uuid, text) is
  'Sends a draft: draft -> ordered, and THE MOMENT IT BECOMES IMMUTABLE (2.3''s '
  'trigger, which from here refuses any change to what the supplier was told). '
  'An order already sent is RETURNED rather than refused — somebody pressing the '
  'button twice is asking once — while a cancelled one is refused by name. Posts '
  'nothing: an order is a promise, and a promise is not a transaction.';


-- ----------------------------------------------------------------------------
-- 6.3 cancel_purchase_order
-- ----------------------------------------------------------------------------
-- CANCELLING A PART-RECEIVED ORDER IS ALLOWED and leaves what arrived exactly
-- where it is: those movements and their journal entries are permanent, as
-- everything in this system is. The cancellation says only that nothing more is
-- coming.
create or replace function cancel_purchase_order(
  p_purchase_order_id uuid,
  p_reason            text,
  p_idempotency_key   text default null
)
returns purchase_orders
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order    purchase_orders;
  v_existing purchase_orders;
  v_key      text;
  v_reason   text;
begin
  select * into v_order from purchase_orders where id = p_purchase_order_id for update;
  if not found then
    raise exception 'Purchase order % not found', p_purchase_order_id using errcode = 'PT404';
  end if;

  if not is_tenant_staff(v_order.tenant_id) then
    raise exception 'Not authorised to cancel purchase orders for this property'
      using errcode = 'insufficient_privilege';
  end if;

  v_key := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  if v_key is not null then
    select * into v_existing
    from purchase_orders
    where tenant_id = v_order.tenant_id and cancel_idempotency_key = v_key
    limit 1;
    if found then
      return v_existing;
    end if;
  else
    v_key := 'cancel_purchase_order:' || p_purchase_order_id::text;
  end if;

  if v_order.status = 'cancelled' then
    return v_order;
  end if;

  if v_order.status = 'received' then
    raise exception 'Purchase order % is complete, so there is nothing to cancel.',
      v_order.order_number
      using errcode = 'PT409',
            hint = 'Everything on it has either arrived or been closed short. To send stock back, reverse the movement the delivery posted.';
  end if;

  v_reason := nullif(btrim(coalesce(p_reason, '')), '');
  if v_reason is null then
    raise exception 'Cancelling a purchase order needs a reason'
      using errcode = 'PT422',
            hint = 'It is recorded permanently against your name, and it is what the supplier report reads.';
  end if;

  update purchase_orders
     set status                 = 'cancelled',
         cancelled_at           = now(),
         cancelled_by           = auth.uid(),
         cancel_reason          = v_reason,
         cancel_idempotency_key = v_key,
         updated_by             = auth.uid()
   where id = v_order.id
  returning * into v_order;

  return v_order;
end;
$$;

comment on function cancel_purchase_order(uuid, text, text) is
  'Cancels an order, with a MANDATORY reason — the same rule every other undoing '
  'in this product follows. A PART-RECEIVED order may be cancelled and what '
  'arrived stays exactly where it is: those movements and their journal entries '
  'are permanent, and the cancellation says only that nothing more is coming. '
  'Re-cancelling returns the order rather than refusing.';


-- ----------------------------------------------------------------------------
-- 6.4 receive_purchase_order — the delivery, the movements, and ONE entry
-- ----------------------------------------------------------------------------
-- THE GUARD ORDER IS post_stock_receipt's, for the same reason 038 gave: a
-- caller who is wrong about several things is told about the nearest one first.
--
--   order + lock -> staff gate -> idempotency (with the payload check) ->
--   order state -> business date + future guard -> posting lock -> destination ->
--   the lines against what is outstanding -> the manager PIN -> the receipt ->
--   the movements -> the order's new state -> ONE journal entry.
--
-- ----------------------------------------------------------------------------
-- THE THREE RULES ON A LINE, AND WHY THEY DIFFER
-- ----------------------------------------------------------------------------
--   ANY QUANTITY DIFFERENCE NEEDS A REASON. Ordered 50, got 47: why? "Part
--   delivery, rest Friday" and "they short-changed us" are different facts and
--   the short-delivery report is worthless without them. It applies in BOTH
--   directions, because five extra kilos is a question too.
--
--   AN OVER-RECEIPT ADDITIONALLY NEEDS A MANAGER PIN. Accepting more than was
--   ordered commits the hotel to paying for it, which is a decision somebody
--   should have to be present for. Under-receiving commits it to nothing.
--
--   A QUANTITY OF ZERO NEEDS closed_short. A line of nothing with nothing said
--   means nothing — do not write it. A zero WITH closed_short says nothing more
--   is coming, which is what lets an order the supplier abandoned reach
--   'received' rather than sitting in the outstanding list forever.
--
-- COST DIFFERENCE IS SHOWN AND STORED, WITH NO REASON AND NO TOLERANCE. The
-- invoiced cost goes onto the line and the ordered cost is one join away, so the
-- difference is visible on every screen that wants it and on the supplier
-- report. Deliberately NOT gated: a mandatory reason on a price change would be
-- answered "price went up" five hundred times, and a tolerance setting is a
-- number somebody sets once, wrong, and never revisits — after which every
-- overcharge under it is invisible. Showing it live, while the delivery is still
-- at the door, is what actually catches one.
--
-- ONE JOURNAL ENTRY FOR THE WHOLE DELIVERY: N debits to inventory, one credit to
-- supplier_payable. Built from the receipt lines that were just written — not
-- from the payload — so what is booked is what was recorded, and the credit is
-- the SUM of the debits rather than a second independent total.
create or replace function receive_purchase_order(
  p_purchase_order_id uuid,
  p_business_date     date,
  p_lines             jsonb,
  p_delivery_note     text,
  p_invoice_number    text,
  p_note              text,
  p_idempotency_key   text,
  p_manager_pin       text default null,
  p_reason            text default null
)
returns purchase_receipts
language plpgsql
security definer
set search_path = public, extensions
as $$
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

    select ol.quantity, ol.inventory_item_id, i.name, i.base_unit, i.tracks_expiry
      into v_ordered, v_item, v_itemname, v_unit, v_tracks
    from purchase_order_lines ol
    join inventory_items i on i.id = ol.inventory_item_id
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
  end loop;

  -- ---- the manager --------------------------------------------------------
  -- ONE verification for both cases. A delivery that is both over-received AND
  -- into a bar is one decision by one manager, not two.
  if v_over or v_kind <> 'store' then
    if v_kind <> 'store' and v_reason is null then
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

    select ol.inventory_item_id, i.name, i.base_unit
      into v_item, v_itemname, v_unit
    from purchase_order_lines ol
    join inventory_items i on i.id = ol.inventory_item_id
    where ol.id = v_line_id;

    v_movement_id := null;

    if v_qty > 0 then
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

    insert into purchase_receipt_lines (
      tenant_id, purchase_receipt_id, purchase_order_line_id, line_number,
      quantity, unit_cost, closed_short, reason,
      batch_code, expiry_date, note, stock_movement_id, created_by
    ) values (
      v_tenant, v_receipt.id, v_line_id, v_n,
      v_qty, v_cost, v_closed, v_lreason,
      v_batch, v_expiry,
      nullif(btrim(coalesce(v_line ->> 'note', '')), ''),
      v_movement_id,
      auth.uid()
    );

    -- The journal debit for this line, built from what was just written.
    v_amount := round(v_qty * v_cost, 2);
    if v_amount > 0 then
      v_total  := v_total + v_amount;
      v_debits := v_debits || jsonb_build_object(
        'role_key',    'inventory',
        'side',        'debit',
        'amount',      v_amount,
        'description', format('%s — %s %s at %s',
                              v_itemname,
                              format_stock_quantity(v_qty),
                              coalesce(v_unit, ''),
                              to_char(v_cost, 'FM999,999,999,990.00'))
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
$$;

comment on function receive_purchase_order(uuid, date, jsonb, text, text, text, text, text, text) is
  'Records a delivery against a purchase order: the goods receipt, its lines, one '
  'stock movement per line that brought something, the order''s new state, and ONE '
  'journal entry — N debits to inventory, one credit to supplier_payable, the '
  'credit left OPEN so it is the sum of the debits rather than a second total. '
  'THE DESTINATION EQUIVALENCE: stock reaches the ledger through post_stock_receipt, '
  'the same function a hand-keyed delivery uses, so "only the store receives" and '
  'every other rule holds here without being restated — a purchase order is not a '
  'route around them. ANY quantity difference needs a REASON, in either direction; '
  'an OVER-receipt additionally needs a manager PIN, recorded in authorised_by, '
  'because accepting more than was ordered commits the hotel to paying for it; a '
  'quantity of ZERO needs closed_short, which is what lets an abandoned order '
  'reach ''received''. Cost differences are stored and shown, with no mandatory '
  'reason and no tolerance setting. A retry under the same key recording a '
  'DIFFERENT delivery is refused by name.';


-- ############################################################################
-- SECTION 7 — THE READ SURFACES
-- ############################################################################
-- Everything a screen reads is DERIVED here, never maintained. A received-value
-- column on purchase_orders would be a cache under rule 6, would need an
-- invalidation path through four RPCs, and would be wrong the first time one of
-- them forgot — silently, because a wrong total still looks like a total.
--
-- security_invoker IS LOAD-BEARING on every view (022's note): without it the
-- view runs as its owner and RLS on the underlying tables is bypassed, so one
-- tenant would read another's orders.

-- ----------------------------------------------------------------------------
-- 7.1 purchase_order_summary — what the Purchases list reads
-- ----------------------------------------------------------------------------
-- One row per order, with the supplier, the destination, and the four figures
-- somebody actually wants: what it is worth, what has arrived, what is still
-- outstanding, and when the last delivery was.
--
-- ordered_value USES THE ORDERED COST and received_value USES THE INVOICED ONE,
-- which is why they do not have to agree even when every quantity matches. That
-- gap is the whole reason for showing both.
create or replace view purchase_order_summary
with (security_invoker = on) as
select
  po.id,
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
  s.name                          as supplier_name,
  s.code                          as supplier_code,

  po.destination_location_id,
  l.name                          as destination_name,
  l.kind                          as destination_kind,

  -- STILL WAITING ON SOMETHING. The single most useful predicate on this screen,
  -- so it is a column the server can filter on rather than a client-side test
  -- over a fetched page (rule 1b).
  (po.status in ('ordered', 'part_received')) as is_open,

  agg.line_count,
  agg.ordered_value,
  agg.received_value,
  -- WHAT IS STILL COMING, at the ORDERED cost — because nothing has been
  -- invoiced for it yet, so the ordered cost is the only figure that exists.
  -- Never negative: an over-receipt settles a line, it does not create a
  -- negative expectation.
  agg.outstanding_value,
  agg.last_receipt_date,
  agg.receipt_count
from purchase_orders po
join suppliers s
  on s.id = po.supplier_id
 and s.tenant_id = po.tenant_id
join locations l
  on l.id = po.destination_location_id
 and l.property_id = po.property_id
cross join lateral (
  select
    count(*)::integer                                          as line_count,
    coalesce(sum(round(ol.quantity * ol.unit_cost, 2)), 0)::numeric(14,2)
                                                               as ordered_value,
    coalesce(sum(r.received_value), 0)::numeric(14,2)          as received_value,
    coalesce(sum(
      case when r.closed_short then 0
           else greatest(ol.quantity - coalesce(r.received_quantity, 0), 0) * ol.unit_cost
      end
    ), 0)::numeric(14,2)                                       as outstanding_value,
    max(r.last_date)                                           as last_receipt_date,
    (select count(*)::integer from purchase_receipts pr
      where pr.purchase_order_id = po.id)                      as receipt_count
  from purchase_order_lines ol
  left join lateral (
    select
      sum(rl.quantity)                                as received_quantity,
      sum(round(rl.quantity * rl.unit_cost, 2))       as received_value,
      bool_or(rl.closed_short)                        as closed_short,
      max(pr2.business_date)                          as last_date
    from purchase_receipt_lines rl
    join purchase_receipts pr2 on pr2.id = rl.purchase_receipt_id
    where rl.purchase_order_line_id = ol.id
  ) r on true
  where ol.purchase_order_id = po.id
) agg;

comment on view purchase_order_summary is
  'What the Purchases list reads: one order with its supplier, its destination, '
  'and what it is worth, what has arrived and what is still outstanding — ALL '
  'DERIVED on read (rule 6). ordered_value uses the ORDERED cost and '
  'received_value the INVOICED one, so the two do not have to agree even when '
  'every quantity matched; that gap is the reason both are shown. is_open is a '
  'column rather than a client-side test so the list can filter and total on the '
  'SERVER across the whole filter (rules 1b, 20). security_invoker: the caller''s '
  'RLS decides what is visible.';


-- ----------------------------------------------------------------------------
-- 7.2 purchase_order_line_status — what the RECEIVING screen reads
-- ----------------------------------------------------------------------------
-- One row per order line, with what was ordered, what has arrived so far, and
-- what is therefore outstanding. THE OUTSTANDING FIGURE IS THE ONE THE RPC
-- VALIDATES AGAINST, computed the same way — so the number on the screen and the
-- number in the refusal can never disagree.
create or replace view purchase_order_line_status
with (security_invoker = on) as
select
  ol.id                            as purchase_order_line_id,
  ol.tenant_id,
  po.property_id,
  ol.purchase_order_id,
  po.order_number,
  po.status                        as order_status,
  ol.line_number,
  ol.line_type,
  ol.inventory_item_id,
  i.name                           as item_name,
  i.code                           as item_code,
  i.base_unit,
  i.tracks_expiry,
  ol.description,
  ol.quantity                      as ordered_quantity,
  ol.unit_cost                     as ordered_unit_cost,
  ol.note,
  coalesce(r.received_quantity, 0)::numeric(14,4)   as received_quantity,
  coalesce(r.received_value, 0)::numeric(14,2)      as received_value,
  coalesce(r.closed_short, false)                   as closed_short,
  -- Never negative: an over-receipt settles the line rather than creating a
  -- negative expectation, and a negative here would read as "we owe them stock".
  greatest(ol.quantity - coalesce(r.received_quantity, 0), 0)::numeric(14,4)
                                                    as outstanding_quantity,
  -- SETTLED = nothing more is expected. Everything arrived, or a receipt line
  -- closed it short.
  (coalesce(r.closed_short, false)
   or coalesce(r.received_quantity, 0) >= ol.quantity)  as is_settled,
  -- The last invoiced cost for this line, so the receiving form can show what
  -- the supplier charged last time beside what was ordered.
  r.last_unit_cost
from purchase_order_lines ol
join purchase_orders po
  on po.id = ol.purchase_order_id
 and po.tenant_id = ol.tenant_id
left join inventory_items i
  on i.id = ol.inventory_item_id
 and i.tenant_id = ol.tenant_id
left join lateral (
  select
    sum(rl.quantity)                          as received_quantity,
    sum(round(rl.quantity * rl.unit_cost, 2)) as received_value,
    bool_or(rl.closed_short)                  as closed_short,
    (array_agg(rl.unit_cost order by pr.business_date desc, rl.created_at desc))[1]
                                              as last_unit_cost
  from purchase_receipt_lines rl
  join purchase_receipts pr on pr.id = rl.purchase_receipt_id
  where rl.purchase_order_line_id = ol.id
) r on true;

comment on view purchase_order_line_status is
  'One order line with what was ordered, what has arrived and what is therefore '
  'OUTSTANDING — and outstanding is computed here EXACTLY as receive_purchase_order '
  'computes it, so the figure on the screen and the figure in a refusal can never '
  'disagree. is_settled means nothing more is expected: it all arrived, or a '
  'receipt line closed it short.';


-- ----------------------------------------------------------------------------
-- 7.3 purchase_receipt_line_detail — the delivery history on an order
-- ----------------------------------------------------------------------------
-- What arrived, when, against what was ordered, at what it was invoiced. THE
-- COST DIFFERENCE IS A COLUMN because it is the figure this module exists to
-- surface, and computing it in four screens would give four answers.
create or replace view purchase_receipt_line_detail
with (security_invoker = on) as
select
  rl.id,
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
  ol.quantity                                        as ordered_quantity,
  ol.unit_cost                                       as ordered_unit_cost,
  ol.inventory_item_id,
  i.name                                             as item_name,
  i.code                                             as item_code,
  i.base_unit,
  -- What this line was worth on the invoice.
  round(rl.quantity * rl.unit_cost, 2)::numeric(14,2)          as line_value,
  -- THE COST DIFFERENCE PER UNIT, positive when the invoice was higher than the
  -- order. Stored nowhere — the two costs are two facts and this is their
  -- relationship, which is exactly the kind of thing a cache gets wrong.
  (rl.unit_cost - ol.unit_cost)::numeric(14,2)                 as unit_cost_difference,
  round(rl.quantity * (rl.unit_cost - ol.unit_cost), 2)::numeric(14,2)
                                                               as cost_difference_value
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
left join inventory_items i
  on i.id = ol.inventory_item_id
 and i.tenant_id = ol.tenant_id;

comment on view purchase_receipt_line_detail is
  'What arrived, line by line, against what was ordered and at what it was '
  'invoiced. The COST DIFFERENCE is a column here and stored nowhere: the '
  'ordered cost and the invoiced cost are two facts, and their relationship is '
  'the sort of derived figure that goes wrong quietly the moment it is cached. '
  'Computing it in four screens would produce four answers.';


-- ----------------------------------------------------------------------------
-- 7.4 supplier_activity — ONE-SIDED, AND IT KEEPS THAT NAME
-- ----------------------------------------------------------------------------
-- WHAT WAS ORDERED AND WHAT ARRIVED. That is all this is, and the name says so
-- on purpose: it is NOT supplier_account, it does not total to a balance, and
-- there is no column here that could be mistaken for one.
--
-- THE REASON IS THE GAP RECORDED IN SECTION 1. Receiving credits
-- supplier_payable and nothing in this shipment ever debits it, so a figure
-- called "owed" would be right until the first payment and silently wrong
-- afterwards, forever. A balance needs two sides; supplier payments are 1.1h5,
-- and this view gets its second side on the day they land — at which point it
-- can honestly be renamed.
create or replace view supplier_activity
with (security_invoker = on) as
select
  po.id                            as purchase_order_id,
  po.tenant_id,
  po.property_id,
  po.supplier_id,
  s.name                           as supplier_name,
  s.code                           as supplier_code,
  po.order_number,
  po.status,
  po.order_date,
  po.expected_date,
  po.ordered_at,
  po.cancelled_at,
  po.cancel_reason,
  sm.ordered_value,
  sm.received_value,
  sm.outstanding_value,
  sm.last_receipt_date,
  sm.receipt_count,
  -- LATE means the promised date has passed and something is still outstanding.
  -- NULL expected_date is not late — it is a promise nobody made.
  (po.status in ('ordered', 'part_received')
   and po.expected_date is not null
   and po.expected_date < (now() at time zone
        coalesce(nullif(btrim(p.timezone), ''), 'Africa/Lagos'))::date) as is_late
from purchase_orders po
join suppliers s
  on s.id = po.supplier_id
 and s.tenant_id = po.tenant_id
join properties p
  on p.id = po.property_id
join purchase_order_summary sm
  on sm.id = po.id;

comment on view supplier_activity is
  'WHAT WAS ORDERED FROM A SUPPLIER AND WHAT ARRIVED. ONE-SIDED, DELIBERATELY, '
  'and the name says so: it is not supplier_account, it does not total to a '
  'balance, and no column here could be mistaken for one. Receiving credits '
  'supplier_payable and NOTHING in 1.1h2 ever debits it, so a figure called '
  '"owed" would be right until the first payment and silently wrong forever '
  'after. Supplier payments are 1.1h5; this view gets its second side then, and '
  'can honestly be renamed on the same day.';


-- ----------------------------------------------------------------------------
-- 7.5 stock_movements_unposted — WHERE A FORGOTTEN POSTING BECOMES VISIBLE
-- ----------------------------------------------------------------------------
-- SECTION 4's header explains why the posting is a call in each RPC rather than
-- a trigger. This view is what replaces the trigger's guarantee, and it is the
-- same device 044 used with last_posted_on: the gap does not become impossible,
-- it becomes impossible to leave QUIETLY.
--
-- Every movement with no journal entry, WITH THE REASON. Five of the six reasons
-- are legitimate and expected. THE SIXTH IS NULL, and a NULL here means a
-- movement moved stock and the ledger never heard about it — which is exactly
-- the ₦50,000 gap the ERP could not explain, surfaced on the day it happens
-- instead of at the year end.
create or replace view stock_movements_unposted
with (security_invoker = on) as
select
  m.id,
  m.tenant_id,
  m.property_id,
  m.location_id,
  m.inventory_item_id,
  m.seq,
  m.movement_type,
  m.quantity,
  m.business_date,
  m.created_at,
  m.source,
  m.source_document_type,
  m.reason,
  -- What it would have been worth, so a real gap can be sized rather than merely
  -- counted.
  case
    when m.movement_type = 'reversal' then round(abs(m.quantity) * m.carried_unit_cost, 2)
    when m.quantity > 0               then round(m.quantity * m.unit_cost, 2)
    else                                   round(-m.quantity * m.carried_unit_cost, 2)
  end::numeric(14,2)                                     as unposted_value,
  case
    when m.source_document_type = 'purchase_receipt'
      then 'Booked with its goods receipt, which posts one entry for the whole delivery'
    when m.movement_type in ('issue_out', 'issue_in', 'transfer_out', 'transfer_in')
      then 'Moves stock between two locations of one property, so the property holds the same value and there is nothing to book'
    when pfs.gl_start_date is not null and m.business_date < pfs.gl_start_date
      then 'Dated before the books opened for this property'
    when (case when m.movement_type = 'reversal' then m.carried_unit_cost
               when m.quantity > 0               then m.unit_cost
               else                                   m.carried_unit_cost end) is null
      then 'No cost basis, so booking it would mean guessing what the stock was worth'
    when (case
            when m.movement_type = 'reversal' then round(abs(m.quantity) * m.carried_unit_cost, 2)
            when m.quantity > 0               then round(m.quantity * m.unit_cost, 2)
            else                                   round(-m.quantity * m.carried_unit_cost, 2)
          end) = 0
      then 'Its value rounds to nothing, so there is no entry to make'
    -- NULL: NOT EXPLAINED. This is the alarm.
    else null
  end                                                    as reason_unposted
from stock_movements m
left join property_finance_settings pfs
  on pfs.property_id = m.property_id
where not exists (
  select 1 from journal_entries je
  where je.tenant_id = m.tenant_id
    and je.source_document_type = 'stock_movement'
    and je.source_document_id   = m.id
);

comment on view stock_movements_unposted is
  'EVERY MOVEMENT WITH NO JOURNAL ENTRY, WITH THE REASON. This is what replaces '
  'the guarantee an after-insert trigger would have given (SECTION 4''s header): '
  'the posting cannot become impossible to forget, so it is made impossible to '
  'forget QUIETLY — the same device 044 used with last_posted_on. Five reasons '
  'are legitimate and expected. reason_unposted NULL is the sixth and it is the '
  'ALARM: stock moved and the ledger never heard about it, sized in naira by '
  'unposted_value.';


-- ----------------------------------------------------------------------------
-- 7.6 THE RECONCILIATION — the check that makes all of this worth having
-- ----------------------------------------------------------------------------
-- INVARIANT (rule 9), and it is the assertion the ERP could not make:
--
--     ledger_balance === expected_ledger_balance, TO THE KOBO, ALWAYS.
--
-- The left side is read from journal_entry_lines — rows that were actually
-- written. The right side is computed from stock_movements. They are two
-- independent measurements of the same fact, and a difference of any size means
-- a posting was skipped, doubled, or landed on the wrong account. The ERP read
-- 782,500 in Stock on Hand against a subledger of 732,500 and had no way to say
-- which of the two was wrong; this says so in one row.
--
-- (Rule 27, applied to this view before trusting it: the arithmetic on the right
-- IS the arithmetic post_stock_movement_journal uses, and that is not a
-- recomputation of the answer — it is the point. What is being checked is not
-- whether the multiplication is right, it is whether the WRITE HAPPENED. Delete
-- one `perform post_stock_movement_journal` line and ledger_difference goes
-- non-zero; that is the defect that turns it red.)
--
-- ----------------------------------------------------------------------------
-- AND THE SECOND FIGURE, WHICH IS NOT THE SAME AND MUST NOT BE CONFLATED
-- ----------------------------------------------------------------------------
-- valuation_difference compares the ledger against stock_valuation, and it is
-- NOT required to be zero. Two reasons, both real, both worth seeing:
--
--   ROUNDING. The GL holds the sum of per-movement values, each rounded to the
--   kobo because money has two decimals. The valuation holds quantity x an
--   average carried at full precision, rounded once. Worked case: receive 3 at
--   10.00 and 1 at 11.11, then issue 2. The average is 10.2775, the issue is
--   stamped and booked at 20.56, the GL reads 20.55, and the valuation reads
--   round(2 x 10.2775) = 20.56. One kobo, and NEITHER SIDE IS WRONG.
--
--   A POSITION THAT HAS PASSED THROUGH NEGATIVE. When stock arrives into a
--   negative position the fold RESETS the average to the incoming cost (038
--   SECTION 5.1), because there is no sensible average to weight against less
--   than nothing. The GL, correctly, recorded what happened. The gap is real
--   economics — stock that left without a movement and was replaced at a new
--   price — and negative_position_count is beside the figure so it can be read
--   as the explanation it is rather than as noise.
--
-- NEITHER IS ABSORBED ANYWHERE. There is no suspense account and no tolerance
-- setting; the difference is shown, and 7.7 breaks it down to the shelf it came
-- from.
create or replace function inventory_gl_reconciliation(p_property_id uuid)
returns table (
  property_id             uuid,
  account_id              uuid,
  account_code            text,
  account_name            text,
  -- What the ledger actually holds on the inventory account for this property.
  ledger_balance          numeric(14,2),
  -- What it should hold, computed from the movements independently.
  expected_ledger_balance numeric(14,2),
  -- MUST BE ZERO. Anything else is a posting that was skipped or doubled.
  ledger_difference       numeric(14,2),
  -- Value that legitimately never reached the ledger, split so the arithmetic
  -- below is complete rather than approximately complete.
  pre_gl_value            numeric(14,2),
  non_posting_value       numeric(14,2),
  -- COUNTED, NOT VALUED, and that is the honest shape: a movement with no cost
  -- basis is one whose value nobody knows. It is absent from the ledger AND from
  -- the valuation, so it cancels out of the arithmetic — but it is a real thing
  -- somebody should look at, so it is reported rather than dropped.
  unvaluable_movement_count integer,
  -- What the stock valuation says the property holds.
  valuation_value         numeric(14,2),
  -- Rounding, plus any position that has passed through negative. NOT required
  -- to be zero, and never absorbed anywhere.
  valuation_difference    numeric(14,2),
  negative_position_count integer
)
language plpgsql
stable
security definer
set search_path = public
as $$
-- The OUT parameters of a `returns table` are plpgsql VARIABLES, and several of
-- them share a name with a column in the query below. Every reference is
-- qualified, but the directive removes the whole class of ambiguity rather than
-- relying on that staying true through the next edit.
#variable_conflict use_column
declare
  v_tenant   uuid;
  v_account  uuid;
  v_gl_start date;
begin
  select p.tenant_id into v_tenant
  from properties p where p.id = p_property_id and p.deleted_at is null;

  if v_tenant is null then
    raise exception 'Property % not found', p_property_id using errcode = 'PT404';
  end if;

  if not is_tenant_staff(v_tenant) then
    raise exception 'Not authorised to read this property''s ledger'
      using errcode = 'insufficient_privilege';
  end if;

  -- Rule 4, even here: the reconciliation resolves the account by ROLE KEY, so a
  -- tenant who repoints `inventory` gets a reconciliation of the account it now
  -- points at rather than a silently stale one.
  v_account := resolve_account(v_tenant, p_property_id, 'inventory');

  select pfs.gl_start_date into v_gl_start
  from property_finance_settings pfs where pfs.property_id = p_property_id;

  return query
  with m as (
    select
      sm.movement_type,
      sm.business_date,
      sm.quantity,
      case
        when sm.movement_type in ('issue_out', 'issue_in', 'transfer_out', 'transfer_in')
          then null
        when sm.movement_type = 'reversal' then sm.carried_unit_cost
        when sm.quantity > 0               then sm.unit_cost
        else                                    sm.carried_unit_cost
      end as basis,
      (sm.movement_type in ('issue_out', 'issue_in', 'transfer_out', 'transfer_in'))
        as books_nothing
    from stock_movements sm
    where sm.property_id = p_property_id
  ),
  v as (
    select
      m.*,
      case when m.basis is null then null
           else sign(m.quantity) * round(abs(m.quantity) * m.basis, 2)
      end as value
    from m
  ),
  totals as (
    select
      coalesce(sum(case
        when v.books_nothing then 0
        when v.value is null then 0
        when v_gl_start is not null and v.business_date < v_gl_start then 0
        else v.value end), 0)::numeric(14,2)                       as expected_balance,
      coalesce(sum(case
        when not v.books_nothing and v.value is not null
             and v_gl_start is not null and v.business_date < v_gl_start
        then v.value else 0 end), 0)::numeric(14,2)                as pre_gl,
      -- A movement that books something by type but has no cost basis. It is
      -- ALSO absent from the valuation (a null average contributes nothing), so
      -- it cancels out of the arithmetic and is COUNTED rather than valued —
      -- valuing it would mean inventing the figure it does not have.
      count(*) filter (where not v.books_nothing and v.value is null)::integer
                                                                   as unvaluable_n,
      coalesce(sum(case when v.books_nothing and v.value is not null
                        then v.value else 0 end), 0)::numeric(14,2) as non_posting
    from v
  ),
  led as (
    select coalesce(sum(jel.debit - jel.credit), 0)::numeric(14,2) as balance
    from journal_entry_lines jel
    join journal_entries je on je.id = jel.journal_entry_id
    where je.tenant_id   = v_tenant
      and je.property_id = p_property_id
      and jel.account_id = v_account
  ),
  val as (
    select
      coalesce(sum(soh.stock_value), 0)::numeric(14,2)                 as value,
      count(*) filter (where soh.quantity_on_hand < 0)::integer        as negatives
    from stock_on_hand soh
    where soh.property_id = p_property_id
  )
  select
    p_property_id,
    v_account,
    a.code,
    a.name,
    led.balance,
    totals.expected_balance,
    (led.balance - totals.expected_balance)::numeric(14,2),
    totals.pre_gl,
    totals.non_posting,
    totals.unvaluable_n,
    val.value,
    (val.value - (totals.expected_balance + totals.pre_gl + totals.non_posting))::numeric(14,2),
    val.negatives
  from totals
  cross join led
  cross join val
  cross join accounts a
  where a.id = v_account;
end;
$$;

comment on function inventory_gl_reconciliation(uuid) is
  'THE CHECK THAT MAKES THE POSTING WORTH HAVING (rule 9). INVARIANT: '
  'ledger_balance === expected_ledger_balance, to the kobo, always — the left '
  'side read from journal_entry_lines, the right computed independently from '
  'stock_movements, so any difference means a posting was skipped, doubled or '
  'landed on the wrong account. That is the assertion the ERP could not make '
  'when its general ledger read 782,500 against a subledger of 732,500. '
  'valuation_difference is a DIFFERENT figure and is NOT required to be zero: it '
  'is per-movement rounding (money has two decimals, a moving average does not) '
  'plus any position that has passed through negative, where the fold resets the '
  'average to the incoming cost. Neither is absorbed anywhere — there is no '
  'suspense account and no tolerance setting.';


-- ----------------------------------------------------------------------------
-- 7.7 ...and the same thing per shelf, so a difference can be traced
-- ----------------------------------------------------------------------------
-- A difference at the property level is a number. A difference on ONE (location,
-- item) is a question somebody can answer. Same arithmetic, not grouped away.
create or replace function inventory_gl_reconciliation_positions(p_property_id uuid)
returns table (
  location_id         uuid,
  location_name       text,
  inventory_item_id   uuid,
  item_name           text,
  item_code           text,
  base_unit           text,
  quantity_on_hand    numeric(14,4),
  movement_value      numeric(14,2),
  valuation_value     numeric(14,2),
  difference          numeric(14,2)
)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_tenant uuid;
begin
  select p.tenant_id into v_tenant
  from properties p where p.id = p_property_id and p.deleted_at is null;

  if v_tenant is null then
    raise exception 'Property % not found', p_property_id using errcode = 'PT404';
  end if;

  if not is_tenant_staff(v_tenant) then
    raise exception 'Not authorised to read this property''s ledger'
      using errcode = 'insufficient_privilege';
  end if;

  return query
  with m as (
    select
      sm.location_id,
      sm.inventory_item_id,
      coalesce(sum(
        case
          when sm.movement_type in ('issue_out', 'issue_in', 'transfer_out', 'transfer_in')
            then 0
          when sm.movement_type = 'reversal'
            then sign(sm.quantity) * round(abs(sm.quantity) * sm.carried_unit_cost, 2)
          when sm.quantity > 0
            then round(sm.quantity * sm.unit_cost, 2)
          else -round(-sm.quantity * sm.carried_unit_cost, 2)
        end
      ), 0)::numeric(14,2) as movement_value
    from stock_movements sm
    where sm.property_id = p_property_id
    group by sm.location_id, sm.inventory_item_id
  )
  select
    soh.location_id,
    l.name,
    soh.inventory_item_id,
    i.name,
    i.code,
    i.base_unit,
    soh.quantity_on_hand,
    coalesce(m.movement_value, 0)::numeric(14,2),
    soh.stock_value,
    (soh.stock_value - coalesce(m.movement_value, 0))::numeric(14,2)
  from stock_on_hand soh
  join locations l        on l.id = soh.location_id
  join inventory_items i  on i.id = soh.inventory_item_id
  left join m
    on m.location_id = soh.location_id
   and m.inventory_item_id = soh.inventory_item_id
  where soh.property_id = p_property_id
  order by abs(soh.stock_value - coalesce(m.movement_value, 0)) desc,
           l.name, i.name;
end;
$$;

comment on function inventory_gl_reconciliation_positions(uuid) is
  'The same reconciliation per (location, item), ordered by the SIZE of the '
  'difference. A gap at the property level is a number; a gap on one shelf is a '
  'question somebody can answer. Deliberately not filtered to non-zero rows: a '
  'position that reconciles exactly is the evidence that the ones which do not '
  'are the exception.';


-- ############################################################################
-- SECTION 8 — RLS
-- ############################################################################
-- Rule 13, from this migration. Two shapes, and the split is the same one 044
-- drew:
--
--   * suppliers is ADMIN-GATED CONFIGURATION — member read, admin write —
--     matching inventory_items and locations. A supplier record is master data
--     with a TIN and a bank account on it, and who the hotel is allowed to pay
--     is not a storekeeper's decision.
--   * purchase_orders, their lines, purchase_receipts and their lines are
--     MEMBER-READ ONLY, WITH NO WRITE POLICY OF ANY KIND. The only writers are
--     the four SECURITY DEFINER RPCs. Same shape as stock_movements and
--     journal_entries, and it is what makes "an ordered purchase order is
--     immutable" and "a receipt is permanent" structural facts rather than
--     promises — a policy that let an admin PATCH the table would make both of
--     them things the form usually does.
alter table suppliers              enable row level security;
alter table purchase_orders        enable row level security;
alter table purchase_order_lines   enable row level security;
alter table purchase_receipts      enable row level security;
alter table purchase_receipt_lines enable row level security;

-- --- suppliers --------------------------------------------------------------
drop policy if exists suppliers_member_select on suppliers;
create policy suppliers_member_select on suppliers
  for select to authenticated
  using (tenant_id = any(get_tenant_ids()));

drop policy if exists suppliers_admin_insert on suppliers;
create policy suppliers_admin_insert on suppliers
  for insert to authenticated
  with check (is_tenant_admin(tenant_id));

drop policy if exists suppliers_admin_update on suppliers;
create policy suppliers_admin_update on suppliers
  for update to authenticated
  using (is_tenant_admin(tenant_id))
  with check (is_tenant_admin(tenant_id));

-- NO DELETE POLICY. A supplier is retired with deleted_at (rule 5, master data);
-- hard-deleting one with orders against it would orphan the purchase history a
-- payment will need.
drop policy if exists suppliers_admin_delete on suppliers;

-- --- purchasing: read only, for everyone ------------------------------------
drop policy if exists purchase_orders_member_select on purchase_orders;
create policy purchase_orders_member_select on purchase_orders
  for select to authenticated
  using (tenant_id = any(get_tenant_ids()));

drop policy if exists purchase_orders_member_insert on purchase_orders;
drop policy if exists purchase_orders_member_update on purchase_orders;
drop policy if exists purchase_orders_member_delete on purchase_orders;

drop policy if exists purchase_order_lines_member_select on purchase_order_lines;
create policy purchase_order_lines_member_select on purchase_order_lines
  for select to authenticated
  using (tenant_id = any(get_tenant_ids()));

drop policy if exists purchase_order_lines_member_insert on purchase_order_lines;
drop policy if exists purchase_order_lines_member_update on purchase_order_lines;
drop policy if exists purchase_order_lines_member_delete on purchase_order_lines;

drop policy if exists purchase_receipts_member_select on purchase_receipts;
create policy purchase_receipts_member_select on purchase_receipts
  for select to authenticated
  using (tenant_id = any(get_tenant_ids()));

drop policy if exists purchase_receipts_member_insert on purchase_receipts;
drop policy if exists purchase_receipts_member_update on purchase_receipts;
drop policy if exists purchase_receipts_member_delete on purchase_receipts;

drop policy if exists purchase_receipt_lines_member_select on purchase_receipt_lines;
create policy purchase_receipt_lines_member_select on purchase_receipt_lines
  for select to authenticated
  using (tenant_id = any(get_tenant_ids()));

drop policy if exists purchase_receipt_lines_member_insert on purchase_receipt_lines;
drop policy if exists purchase_receipt_lines_member_update on purchase_receipt_lines;
drop policy if exists purchase_receipt_lines_member_delete on purchase_receipt_lines;


-- ############################################################################
-- SECTION 9 — GRANTS
-- ############################################################################
-- Nothing here is for anon. The RPCs are staff-gated internally — that is the
-- real boundary — and these grants are the belt-and-braces layer.
revoke all     on function save_purchase_order(uuid, uuid, uuid, date, date, uuid, text, jsonb, text) from public;
revoke execute on function save_purchase_order(uuid, uuid, uuid, date, date, uuid, text, jsonb, text) from anon;
grant  execute on function save_purchase_order(uuid, uuid, uuid, date, date, uuid, text, jsonb, text) to authenticated;

revoke all     on function place_purchase_order(uuid, text) from public;
revoke execute on function place_purchase_order(uuid, text) from anon;
grant  execute on function place_purchase_order(uuid, text) to authenticated;

revoke all     on function cancel_purchase_order(uuid, text, text) from public;
revoke execute on function cancel_purchase_order(uuid, text, text) from anon;
grant  execute on function cancel_purchase_order(uuid, text, text) to authenticated;

revoke all     on function receive_purchase_order(uuid, date, jsonb, text, text, text, text, text, text) from public;
revoke execute on function receive_purchase_order(uuid, date, jsonb, text, text, text, text, text, text) from anon;
grant  execute on function receive_purchase_order(uuid, date, jsonb, text, text, text, text, text, text) to authenticated;

-- The DROP in 5.4 took post_stock_receipt's grants with it. Re-issued here,
-- which is exactly the kind of thing that is forgotten once and leaves a working
-- screen 403-ing — so SECTION 10 asserts it afterwards.
revoke all     on function post_stock_receipt(uuid, uuid, uuid, numeric, numeric, date, text, text, text, text, date, text, text, text, text, uuid, boolean) from public;
revoke execute on function post_stock_receipt(uuid, uuid, uuid, numeric, numeric, date, text, text, text, text, date, text, text, text, text, uuid, boolean) from anon;
grant  execute on function post_stock_receipt(uuid, uuid, uuid, numeric, numeric, date, text, text, text, text, date, text, text, text, text, uuid, boolean) to authenticated;

revoke all     on function inventory_gl_reconciliation(uuid) from public;
revoke execute on function inventory_gl_reconciliation(uuid) from anon;
grant  execute on function inventory_gl_reconciliation(uuid) to authenticated;

revoke all     on function inventory_gl_reconciliation_positions(uuid) from public;
revoke execute on function inventory_gl_reconciliation_positions(uuid) from anon;
grant  execute on function inventory_gl_reconciliation_positions(uuid) to authenticated;

-- INTERNAL. post_stock_movement_journal writes to the ledger with no document
-- behind it; exposing it would hand out the power to post an entry against any
-- movement at will. stock_movement_counter_role is harmless on its own and is
-- revoked with it because a client has no reason to ask.
revoke all on function post_stock_movement_journal(uuid)     from public, anon, authenticated;
revoke all on function stock_movement_counter_role(uuid)     from public, anon, authenticated;
revoke all on function enforce_purchase_order_transition()   from public, anon, authenticated;
revoke all on function enforce_purchase_order_line_change()  from public, anon, authenticated;
revoke all on function forbid_purchase_receipt_change()      from public, anon, authenticated;

-- THE ASSERTION, NOT A COPIED ARRAY (041 SECTION 3). It raises if anon holds
-- EXECUTE on any SECURITY DEFINER function outside the documented exemptions,
-- and complains if the quarantine list has entries that no longer leak — so it
-- fails in both directions and cannot rot quietly.
do $$
begin
  perform assert_no_anon_security_definer();
end $$;


-- ############################################################################
-- SECTION 10 — IN-TRANSACTION SELF-VERIFY
-- ############################################################################
-- Every assertion below is written to a rule 27 test: name the defect that turns
-- it RED. Where one could not be named, the assertion is not here.
--
-- ----------------------------------------------------------------------------
-- MADE TO FAIL BEFORE IT WAS TRUSTED (rules 22 and 27)
-- ----------------------------------------------------------------------------
-- The dry run applies this file to the real schema in one transaction, runs 77
-- assertions across the twelve proofs, and rolls back. It was then re-run seven
-- times against a DELIBERATELY BROKEN 046, each time overriding one function
-- after the migration:
--
--   the write-off books to spoilage whatever its reason code   7 RED
--   a reversal is valued at the CURRENT average, not its basis 4 RED  (see below)
--   the goods receipt lets each movement post its own entry    3 RED
--   the receipt idempotency payload fingerprint is not checked 2 RED
--   an over-receipt no longer needs a manager                  3 RED
--   the posting call is deleted from post_stock_writeoff       5 RED
--   stock OUT is valued at unit_cost instead of what it carried 9 RED
--
-- And this block itself was re-run after five structural breakages — the deleted
-- posting call, a write policy on purchase_orders, the shape CHECK weakened to a
-- one-way implication, the lost grant after 5.4's drop, and a wastage role key
-- renamed on one side only. All five raised; unmutated it passes.
--
-- THE FINDING, AND IT WAS THE ASSERTION RATHER THAN THE CODE. The reversal
-- mutation — valuing a counter-entry at the current moving average instead of
-- the basis it unwinds, which is exactly what §6's "cost of sale is READ, never
-- recomputed" forbids — left the run at 76/76 GREEN the first time. The fixture
-- reversed a write-off while the average was still the same 1,100.00 the
-- write-off had carried out, so the right answer and the wrong answer were the
-- same number: rule 27's third shape, a fixture already in the state being
-- asserted. The dry run now moves the average to 1,152.50 between the write-off
-- and its reversal, after which that mutation turns FOUR assertions red —
-- including the reconciliation itself.
do $$
declare
  v_def   text;
  v_n     integer;
  v_src   text;
  v_fn    text;
  v_miss  text := '';
begin
  -- --- 1. THE POSTING CALL IS IN ALL SIX ----------------------------------
  -- RED WHEN: any `perform post_stock_movement_journal(...)` is deleted from any
  -- of the six — which is precisely the failure that made the ERP's ledger
  -- disagree with its subledger by ₦50,000, and precisely what a trigger would
  -- have made impossible. It is a call, so this is the assertion that stands in
  -- for the trigger (SECTION 4's header).
  foreach v_fn in array array[
    'post_opening_balance', 'post_stock_adjustment', 'post_stock_writeoff',
    'post_stock_receipt', 'post_movement_reversal', 'finish_stock_take'
  ] loop
    select p.prosrc into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = v_fn
    order by p.oid desc
    limit 1;

    if v_src is null or position('post_stock_movement_journal' in v_src) = 0 then
      v_miss := v_miss || v_fn || ' ';
    end if;
  end loop;

  if v_miss <> '' then
    raise exception
      'ASSERT FAILED: these RPCs move stock and never post to the ledger: %', v_miss;
  end if;

  -- --- 2. THE PURCHASING TABLES HAVE NO WRITE POLICY ----------------------
  -- RED WHEN: somebody adds an insert/update/delete policy to any of the four,
  -- which would make "an ordered purchase order is immutable" and "a receipt is
  -- permanent" things the form usually does rather than things the database
  -- enforces. 045's whole argument, applied here.
  select count(*)::integer into v_n
  from pg_policies
  where schemaname = 'public'
    and tablename in ('purchase_orders', 'purchase_order_lines',
                      'purchase_receipts', 'purchase_receipt_lines')
    and cmd <> 'SELECT';

  if v_n > 0 then
    raise exception
      'ASSERT FAILED: % write polic(ies) exist on the purchasing tables. Every write goes through a SECURITY DEFINER RPC.', v_n;
  end if;

  -- --- 3. RLS IS ON, ALL FIVE ---------------------------------------------
  -- RED WHEN: a table is created without `enable row level security`, which is
  -- the one omission that leaks every tenant's data and cannot be seen on any
  -- screen.
  select count(*)::integer into v_n
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname in ('suppliers', 'purchase_orders', 'purchase_order_lines',
                      'purchase_receipts', 'purchase_receipt_lines')
    and c.relrowsecurity;

  if v_n <> 5 then
    raise exception 'ASSERT FAILED: only % of the 5 new tables have RLS enabled', v_n;
  end if;

  -- --- 4. THE SHAPE CHECK IS AN EITHER/OR, NOT A ONE-WAY IMPLICATION ------
  -- RED WHEN: the CHECK is weakened to `line_type <> ''inventory'' or
  -- inventory_item_id is not null`, which permits an ASSET line carrying an item
  -- — the exact row 1.1h3 would then have to clean up before it could ship.
  select pg_get_constraintdef(oid) into v_def
  from pg_constraint where conname = 'purchase_order_lines_shape_check';

  if v_def is null then
    raise exception 'ASSERT FAILED: purchase_order_lines_shape_check is missing';
  end if;
  if position('inventory_item_id IS NULL' in v_def) = 0 then
    raise exception
      'ASSERT FAILED: the shape check no longer refuses an item on an asset or expense line: %', v_def;
  end if;

  -- --- 5. QUANTITY ZERO STILL REQUIRES closed_short -----------------------
  -- RED WHEN: the check is dropped, after which a receipt line of nothing can be
  -- written with nothing said — a row that means nothing and that leaves the
  -- order outstanding forever.
  select pg_get_constraintdef(oid) into v_def
  from pg_constraint where conname = 'purchase_receipt_lines_zero_check';

  if v_def is null then
    raise exception 'ASSERT FAILED: purchase_receipt_lines_zero_check is missing';
  end if;

  -- --- 6. post_stock_receipt KEPT ITS GRANT AFTER THE DROP ----------------
  -- RED WHEN: 5.4's drop-and-recreate happens without SECTION 9's re-grant. The
  -- symptom otherwise is a working receiving screen that starts 403-ing, with
  -- nothing in this migration to suggest why.
  if not has_function_privilege(
       'authenticated',
       'post_stock_receipt(uuid, uuid, uuid, numeric, numeric, date, text, text, text, text, date, text, text, text, text, uuid, boolean)',
       'execute') then
    raise exception
      'ASSERT FAILED: authenticated lost EXECUTE on post_stock_receipt when it was dropped and recreated';
  end if;

  -- --- 7. EVERY ROLE KEY THIS MIGRATION POSTS THROUGH IS SEEDED ----------
  -- RED WHEN: a key is renamed on one side only — say wastage_staff_meal here
  -- and wastage_staff_meals in the seed. resolve_account would then refuse a
  -- write-off at the moment somebody tried to record one, on a Saturday, with
  -- the food going off. Checked against seed_account_mappings' own source, so
  -- the two cannot drift.
  select p.prosrc into v_src
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'seed_account_mappings'
  limit 1;

  v_miss := '';
  foreach v_fn in array array[
    'inventory', 'supplier_payable', 'cash', 'opening_balance_equity',
    'stock_adjustment', 'stock_variance',
    'wastage_spoilage', 'wastage_breakage', 'wastage_expiry',
    'wastage_staff_meal', 'wastage_complimentary'
  ] loop
    if v_src is null or position('''' || v_fn || '''' in v_src) = 0 then
      v_miss := v_miss || v_fn || ' ';
    end if;
  end loop;

  if v_miss <> '' then
    raise exception
      'ASSERT FAILED: 046 posts through role keys that seed_account_mappings does not seed: %', v_miss;
  end if;

  raise notice '046 self-verify: 7 assertions passed';
end $$;

-- ============================================================================
-- End of 046_purchasing_and_posting.sql
-- ============================================================================
