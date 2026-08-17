-- ============================================================================
-- 039_stock_takes.sql
-- Palstro-Hotels: THE STOCK TAKE AS A COUNTED DOCUMENT. F&B/Inventory 1.1d.
--
-- ----------------------------------------------------------------------------
-- WHAT WAS WRONG, STATED PLAINLY
-- ----------------------------------------------------------------------------
-- Until this file, a count lived entirely in React state. Three consequences,
-- each of which is the kind of defect that is invisible until it costs money:
--
--   1. A REFRESH LOST THE COUNT. Two hours of walking a store, gone to a stray
--      Ctrl-R or a phone locking. The next count is then done more carelessly,
--      because nobody trusts the sheet.
--   2. THE EXPECTED FIGURE WAS TAKEN PER KEYSTROKE from whatever the list last
--      returned, so a receipt landing mid-count silently mixed two epochs: some
--      lines were compared against the position before the delivery and some
--      after, and the resulting variance report described a warehouse that never
--      existed at any single moment.
--   3. THE COUNT WAS NOT BLIND. The expected quantity was on the screen beside
--      the input. CLAUDE.md §9 says counts are blind for a reason — a count
--      taken with the answer visible proves nothing, because the easiest way to
--      finish is to type what the system already believes.
--
-- After this migration a count is STARTED, FILLED, LEFT AND RESUMED, and
-- FINISHED. It survives a refresh and a shift change, it is compared against ONE
-- snapshot taken at the moment it started, and the expected figure is not sent
-- to the browser at all while it is open.
--
-- ----------------------------------------------------------------------------
-- THE ONE DECISION THIS FILE IS BUILT AROUND: BLINDNESS IS A SERVER PROPERTY
-- ----------------------------------------------------------------------------
-- A count sheet that hides the expected figure in CSS, or simply does not render
-- a column that is sitting in the JSON payload, is not blind. It is blind to a
-- person who does not open the network tab, which is not the person the control
-- exists to catch. Rule 19 in its purest form: the UI not showing a number is a
-- courtesy; the server not sending it is the guard.
--
-- So `expected_quantity` is guarded THREE ways, and each one is load-bearing on
-- its own (§4):
--   * the column is not in the column-level GRANT that `authenticated` holds on
--     stock_take_lines, so Postgres itself refuses to read it;
--   * stock_take_lines has NO select policy for anyone, so the table returns
--     nothing to a client whatever the columns;
--   * the read view NULLs the column until the count is finished.
-- And the RPC that records a count returns a NARROW ROW TYPE rather than
-- `stock_take_lines`, because a SECURITY DEFINER function returning the table
-- type would serialise every column straight past all three (§6.2).
--
-- ----------------------------------------------------------------------------
-- WHAT IS AND IS NOT HERE
-- ----------------------------------------------------------------------------
-- IS:  stock_takes and stock_take_lines; the snapshot at start; the blind read
--      path; four RPCs (start, record a line, finish, cancel); the write path
--      for the 'count_adjustment' movement type 036 reserved; and the per-
--      property variance threshold above which finishing needs a manager PIN.
-- IS NOT: receive and write-off (1.1h), the item page redesign (1.1f), selling
--      price and photo (1.1e), outlet prices (1.1g), the upload template (1.1i).
--
-- ----------------------------------------------------------------------------
-- ON THE ABSENCE OF AN EXPLICIT BEGIN/COMMIT — as 038, and for its reason
-- ----------------------------------------------------------------------------
-- `supabase db push` already wraps each migration file in a single transaction.
-- An explicit BEGIN here would raise "there is already a transaction in
-- progress", and the matching COMMIT would end the CLI's transaction EARLY —
-- after which any later failure would leave a half-applied migration committed.
-- The single-transaction guarantee is real; adding the keywords destroys it.
--
-- ----------------------------------------------------------------------------
-- CONVENTIONS INHERITED — all load-bearing
-- ----------------------------------------------------------------------------
--   * Quantities numeric(14,4), money numeric(14,2) (§6). Both arrive over
--     PostgREST as STRINGS.
--   * business_date, never created_at, for anything a person reads (rules 8/12).
--   * Rules 2/3: every write RPC takes p_idempotency_key and there is a partial
--     unique index behind it.
--   * Composite FKs bind every scoping column to its parent's paired unique key,
--     so tenant_id can never disagree with the property, the location or the
--     item (§6).
--   * set_row_audit() owns the audit columns; the client can never set them.
--   * Rule 21: every refusal below carries the RULE in its message and the WAY
--     OUT in its hint. The client renders both and authors neither.
-- ============================================================================


-- ############################################################################
-- SECTION 1 — THE VARIANCE THRESHOLD
-- ############################################################################
-- One amount per property: "a count whose variance is worth more than this
-- cannot be finished without a manager standing beside the person finishing it."
--
-- IT IS A VALUE, NOT A QUANTITY, and that is the whole design of the field.
-- 3 kg of saffron and 3 kg of rice are not the same event, and there is no
-- meaningful way to compare quantities across units at all — a threshold of "5"
-- would mean five kilos, five bottles and five sachets simultaneously. Money is
-- the only dimension in which a mixed basket of stock can be compared to itself.
--
-- WHY IT LIVES ON property_finance_settings. Identical to the posting lock (038
-- §4) and the discount threshold (021 §3): property_settings carries a public
-- (anon) read policy for the guest site and Postgres RLS cannot hide a single
-- column, so an internal approval ceiling placed there would be readable by the
-- entire internet. This table is member-read / admin-write with no public policy.
--
-- SAME SHAPE AS discount_threshold, deliberately: NOT NULL, default 0, CHECK
-- >= 0, and ZERO MEANS ALWAYS ASK. Copying that shape rather than inventing one
-- means the settings form, its validation, its error handling and the mental
-- model a manager already has all transfer unchanged.
alter table property_finance_settings
  add column if not exists count_variance_threshold numeric(14,2) not null default 0;

do $$
begin
  if not exists (select 1 from pg_constraint
                 where conname = 'property_finance_count_threshold_check') then
    alter table property_finance_settings
      add constraint property_finance_count_threshold_check
      check (count_variance_threshold >= 0);
  end if;
end $$;

comment on column property_finance_settings.count_variance_threshold is
  'The VALUE of variance above which finishing a stock take requires a manager '
  'PIN (039 §6.3). Money, never quantity: 3 kg of saffron and 3 kg of rice are '
  'not the same event and quantities across units cannot be compared at all. '
  'Measured as the sum of the ABSOLUTE value of every counted line''s variance, '
  'so a +₦40,000 error and a -₦40,000 error are two discrepancies rather than '
  'none. 0 (the default) means every count with any variance at all needs a '
  'manager — the same strict default as discount_threshold.';


-- ----------------------------------------------------------------------------
-- 1.1 The settings writer learns the new field
-- ----------------------------------------------------------------------------
-- Same signature, same optimistic-concurrency shape, same SQLSTATEs as 023 §3
-- and 038 §4.2, so the existing settings form's error handling covers it with no
-- new branch. REPLACED rather than supplemented, for 038's reason: two writers
-- of one settings table is how a concurrency guard gets bypassed by whichever
-- one somebody calls next.
create or replace function update_property_finance_settings(
  p_property_id         uuid,
  p_patch               jsonb,
  p_expected_updated_at timestamptz
) returns property_finance_settings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant_id  uuid;
  v_timezone   text;
  v_updated_at timestamptz;
  v_threshold  numeric;
  v_variance   numeric;
  v_lock       date;
  v_today      date;
  v_result     property_finance_settings;
begin
  select p.tenant_id, p.timezone
    into v_tenant_id, v_timezone
  from properties p
  where p.id = p_property_id
    and p.deleted_at is null;

  if v_tenant_id is null then
    raise exception 'Property % not found', p_property_id
      using errcode = 'PT404';
  end if;

  if not is_tenant_admin(v_tenant_id) then
    raise exception 'You are not authorised to edit this property''s finance settings'
      using errcode = 'PT403';
  end if;

  select pfs.updated_at
    into v_updated_at
  from property_finance_settings pfs
  where pfs.property_id = p_property_id
  for update;

  if v_updated_at is null then
    raise exception 'Finance settings for property % not found', p_property_id
      using errcode = 'PT404';
  end if;

  if p_expected_updated_at is distinct from v_updated_at then
    raise exception 'These settings were changed by someone else since you loaded them'
      using errcode = 'PT409',
            hint = 'Reload to see the latest values, then reapply your change.';
  end if;

  if p_patch ? 'discount_threshold' then
    v_threshold := (p_patch ->> 'discount_threshold')::numeric;
    if v_threshold is null then
      raise exception 'Enter a discount threshold (use 0 to require approval for every discount)'
        using errcode = 'PT422';
    end if;
    if v_threshold < 0 then
      raise exception 'The discount threshold cannot be negative'
        using errcode = 'PT422';
    end if;
  end if;

  -- THE COUNT VARIANCE THRESHOLD. Validated exactly as the discount threshold:
  -- the column is NOT NULL and 0 is MEANINGFUL (it means "always ask"), so a
  -- cleared field is an incomplete form rather than an instruction — unlike the
  -- posting lock below, where a cleared field genuinely means "unlock".
  if p_patch ? 'count_variance_threshold' then
    v_variance := (p_patch ->> 'count_variance_threshold')::numeric;
    if v_variance is null then
      raise exception 'Enter a count approval threshold (use 0 to require a manager for every count with a variance)'
        using errcode = 'PT422',
              hint = 'It is a value, not a quantity — 3 kg of saffron and 3 kg of rice are not the same event.';
    end if;
    if v_variance < 0 then
      raise exception 'The count approval threshold cannot be negative'
        using errcode = 'PT422';
    end if;
  end if;

  -- THE LOCK DATE (038 §4.2). NULL is a legitimate value and means "nothing is
  -- locked", so a cleared field is honoured rather than refused. A JSON null and
  -- an absent key mean different things: absent = leave it alone, null = unlock.
  if p_patch ? 'posting_locked_through' then
    v_lock := nullif(btrim(coalesce(p_patch ->> 'posting_locked_through', '')), '')::date;

    v_today := (now() at time zone coalesce(nullif(btrim(v_timezone), ''), 'Africa/Lagos'))::date;
    if v_lock is not null and v_lock > v_today then
      raise exception
        'The posting lock cannot be set to a future date (today is % at this property)', v_today
        using errcode = 'PT422',
              hint = 'Lock a period once it is closed, not before it has happened.';
    end if;
  end if;

  update property_finance_settings
     set discount_threshold = case
                                when p_patch ? 'discount_threshold'
                                  then (p_patch ->> 'discount_threshold')::numeric
                                else discount_threshold
                              end,
         count_variance_threshold = case
                                      when p_patch ? 'count_variance_threshold'
                                        then (p_patch ->> 'count_variance_threshold')::numeric
                                      else count_variance_threshold
                                    end,
         posting_locked_through = case
                                    when p_patch ? 'posting_locked_through'
                                      then nullif(btrim(coalesce(p_patch ->> 'posting_locked_through', '')), '')::date
                                    else posting_locked_through
                                  end
   where property_id = p_property_id
  returning * into v_result;

  return v_result;
end;
$$;

comment on function update_property_finance_settings(uuid, jsonb, timestamptz) is
  'Patch property_finance_settings (discount_threshold, count_variance_threshold, '
  'posting_locked_through) under an optimistic updated_at check — the same shape '
  'and the same PT404/PT403/PT409/PT422 SQLSTATEs as 008''s four settings writers. '
  'The two thresholds are NOT NULL with a meaningful 0, so a cleared field is '
  'refused; the lock date is nullable, so an ABSENT key leaves it alone and an '
  'explicit null UNLOCKS. Admin-gated, SECURITY DEFINER.';


-- ############################################################################
-- SECTION 2 — stock_takes: the document
-- ############################################################################
--
--  ┌──────────────────────────────────────────────────────────────────────────┐
--  │  A COUNT IS A DOCUMENT WITH A LIFE, NOT A FORM SUBMISSION.               │
--  │                                                                          │
--  │      open  ──finish_stock_take──►  finished   (posts the variances)      │
--  │        │                                                                 │
--  │        └────cancel_stock_take───►  cancelled  (posts nothing, readable)  │
--  │                                                                          │
--  │  There is no path out of 'finished' or 'cancelled'. A count that was      │
--  │  wrong is answered by another count, never by re-opening this one —      │
--  │  the same discipline as a movement, and for the same reason.             │
--  └──────────────────────────────────────────────────────────────────────────┘
--
-- ONE OPEN COUNT PER LOCATION AT A TIME, enforced by a partial unique index
-- (§2.1). Two people counting the same shelves is not a workflow to support: it
-- is two snapshots of the same stock taken at different instants, and whichever
-- finished second would post a variance measured against an epoch the other one
-- had already moved. The refusal names the count that is in the way.
create table if not exists stock_takes (
  id            uuid primary key default gen_random_uuid(),

  -- No inline FKs on the scoping columns: the composite FKs at the bottom bind
  -- each pair to its parent (§6).
  tenant_id     uuid not null,
  property_id   uuid not null,

  -- THE LOCATION IS THE COUNT. Stock is physical (036 §1): 200 kg of rice in the
  -- Main Store and 15 kg in the Kitchen are separate quantities with separate
  -- valuations, so a count is always of ONE location's shelves. A count "across
  -- the property" would be several counts pretending to be one.
  location_id   uuid not null,

  -- The document number, from the shared per-tenant counter (015 §2). NEVER
  -- count(*)+1 (§6): that races under concurrency and reuses numbers after a
  -- cancellation. A count is referred to out loud ("finish ST-000004 before you
  -- start another") so it needs a name a person can say.
  take_number   text not null,

  -- THE OPERATING DAY THIS COUNT BELONGS TO (§6, rules 8/12), in the property's
  -- timezone. Every movement the count posts carries THIS date, not the day the
  -- Finish button happened to be pressed — a count walked on Tuesday night and
  -- finished on Wednesday morning is Tuesday's count.
  business_date date not null,

  status        text not null default 'open'
                  constraint stock_takes_status_check
                  check (status in ('open', 'finished', 'cancelled')),

  -- Free-form: "counted with the chef", "monthly count". Copied onto the reason
  -- of every movement the count posts, so the ledger says why stock moved
  -- without a join.
  note          text,

  started_at    timestamptz not null default now(),
  started_by    uuid references auth.users(id),

  finished_at   timestamptz,
  finished_by   uuid references auth.users(id),
  -- The manager whose PIN authorised finishing, when the variance was above the
  -- property's threshold. NULL means the variance was within the threshold and
  -- the person finishing was acting on their own authority — which is still
  -- named, in finished_by. Same two-column shape as a discount's approver.
  approved_by   uuid references auth.users(id),

  cancelled_at  timestamptz,
  cancelled_by  uuid references auth.users(id),
  -- Mandatory when cancelling (§6.4). A count abandoned with no reason is the
  -- shape of a count abandoned because it was about to show something.
  cancel_reason text,

  -- Rules 2 & 3. TWO keys, because a count has TWO write intents that must each
  -- be replayable independently: starting it, and closing it. The close key
  -- covers finishing AND cancelling — a take is closed once, by one act or the
  -- other, and giving them separate keys would imply a document could be both.
  idempotency_key       text,
  close_idempotency_key text,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid default auth.uid() references auth.users(id),
  updated_by    uuid references auth.users(id),

  -- ------------------------------------------------------------------------
  -- THE STATE SHAPE, as a constraint rather than as RPC discipline
  -- ------------------------------------------------------------------------
  -- A row that says 'open' while carrying a finished_at is a row that every
  -- later reader will interpret differently. Written as one CASE so the three
  -- states are exhaustive and no fourth combination is representable.
  constraint stock_takes_status_shape_check
    check (
      case status
        when 'open'      then finished_at is null and cancelled_at is null
        when 'finished'  then finished_at is not null and cancelled_at is null
        when 'cancelled' then cancelled_at is not null and finished_at is null
      end
    ),

  -- A cancellation always says why. The RPC refuses a blank one with a sentence;
  -- this is the guard under any other route.
  constraint stock_takes_cancel_reason_check
    check (
      status <> 'cancelled'
      or (cancel_reason is not null and length(btrim(cancel_reason)) > 0)
    ),

  -- Composite FKs (§6): a cross-tenant row is a leak RLS cannot detect, because
  -- every policy trusts tenant_id directly.
  constraint stock_takes_property_tenant_fk
    foreign key (property_id, tenant_id)
    references properties (id, tenant_id) on delete cascade,
  constraint stock_takes_location_property_fk
    foreign key (location_id, property_id)
    references locations (id, property_id) on delete cascade,

  -- The paired unique key stock_take_lines binds to (§6), so a line can never
  -- carry a tenant_id its take disagrees with.
  constraint stock_takes_id_tenant_uniq unique (id, tenant_id)
);

comment on table stock_takes is
  'A PHYSICAL STOCK COUNT as a document: started, filled, left and resumed, and '
  'finished. It survives a refresh and a shift change, which the previous '
  'component-state count did not. Exactly ONE open count per location at a time '
  '(a partial unique index): two counts of the same shelves are two snapshots of '
  'different instants, and the second to finish would post a variance against an '
  'epoch the first had already moved. open -> finished (posts the variances) or '
  'open -> cancelled (posts nothing, stays readable); there is no way back.';
comment on column stock_takes.business_date is
  'The OPERATING DAY the count belongs to (rules 8/12), in the property''s '
  'timezone. Every movement the count posts carries THIS date, not the day '
  'Finish was pressed: a count walked on Tuesday night and finished on Wednesday '
  'morning is Tuesday''s count.';
comment on column stock_takes.approved_by is
  'The manager whose PIN authorised finishing, when the variance value was above '
  'the property''s count_variance_threshold. NULL means the variance was within '
  'the threshold and the person finishing acted on their own authority — still '
  'named, in finished_by.';
comment on column stock_takes.close_idempotency_key is
  'Rules 2/3 for the CLOSING act. One key covers finishing and cancelling '
  'because a take is closed once, by one act or the other; separate keys would '
  'imply a document could be both. Its own partial unique index, separate from '
  'the key that started the count.';


-- ----------------------------------------------------------------------------
-- 2.1 Indexes
-- ----------------------------------------------------------------------------

-- Rule 3: the partial unique indexes behind both keys, from day one. The RPCs'
-- exception blocks name THESE indexes.
create unique index if not exists stock_takes_idem_uniq
  on stock_takes (tenant_id, idempotency_key)
  where idempotency_key is not null;

create unique index if not exists stock_takes_close_idem_uniq
  on stock_takes (tenant_id, close_idempotency_key)
  where close_idempotency_key is not null;

-- ONE OPEN COUNT PER LOCATION, structurally.
--
-- The RPC's pre-check (§6.1) is the friendly guard that returns a sentence; THIS
-- index is what makes that guard true under concurrency, when two terminals
-- start a count in the same store in the same instant. Exactly the shape 038 §1.2
-- uses for stock_movements_reverses_uniq, and for exactly the same reason.
create unique index if not exists stock_takes_one_open_uniq
  on stock_takes (location_id)
  where status = 'open';

-- The document number is unique within a property, per document type.
create unique index if not exists stock_takes_number_uniq
  on stock_takes (tenant_id, property_id, take_number);

-- The history list: a property's counts, most recent operating day first
-- (rule 8), which is the order the screen pages through.
create index if not exists stock_takes_property_date_idx
  on stock_takes (property_id, business_date desc);
create index if not exists stock_takes_location_idx
  on stock_takes (location_id, status);
-- tenant_id drives the member-select policy predicate; indexed as 001/002 do.
create index if not exists stock_takes_tenant_id_idx
  on stock_takes (tenant_id);


-- ----------------------------------------------------------------------------
-- 2.2 Audit columns and change log
-- ----------------------------------------------------------------------------
-- MUTABLE, unlike stock_movements: a count is filled in over hours, so the row
-- is updated as it goes. It therefore takes the ORDINARY pair — set_row_audit()
-- on insert AND update (the trigger pins created_at/created_by back to their OLD
-- values on update, so an edit can never rewrite who started the count), and
-- log_field_changes() so every status transition is answerable.
drop trigger if exists set_row_audit_stock_takes on stock_takes;
create trigger set_row_audit_stock_takes
  before insert or update on stock_takes
  for each row execute function set_row_audit();

drop trigger if exists log_field_changes_stock_takes on stock_takes;
create trigger log_field_changes_stock_takes
  after update on stock_takes
  for each row execute function log_field_changes();


-- ############################################################################
-- SECTION 3 — stock_take_lines: the sheet
-- ############################################################################
-- One row per item that had a position in the location when the count STARTED.
--
-- ----------------------------------------------------------------------------
-- THE SNAPSHOT IS THE POINT OF THIS TABLE
-- ----------------------------------------------------------------------------
-- expected_quantity is written ONCE, at start, from the fold as it stood at that
-- instant — and never touched again. That single fact fixes the second defect in
-- this file's header: a receipt landing mid-count changes the position, but it
-- does NOT change what this count is measured against, because this count is
-- measured against the shelf as it was when the counter began walking it. The
-- receipt shows up as stock the count did not see, which is the truth, rather
-- than as a variance the counter caused.
--
-- ----------------------------------------------------------------------------
-- NULL IS NOT ZERO, AND THE DIFFERENCE IS THE WHOLE PARTIAL-COUNT FEATURE
-- ----------------------------------------------------------------------------
--   counted_quantity IS NULL  ->  NOT COUNTED. Nobody has been to that shelf.
--                                 Produces no movement and no variance.
--   counted_quantity = 0      ->  COUNTED, AND THERE IS NONE. A real answer, and
--                                 usually the most important one on the sheet:
--                                 it posts a variance of the full expected
--                                 quantity.
-- Collapsing the two — the obvious shortcut of defaulting the field to 0 — would
-- write off the entire contents of every shelf nobody visited.
create table if not exists stock_take_lines (
  id                uuid primary key default gen_random_uuid(),

  tenant_id         uuid not null,
  stock_take_id     uuid not null,
  inventory_item_id uuid not null,

  -- THE SNAPSHOT. numeric(14,4) (§6), taken at start, never updated.
  -- NOT NULL: an item is only on the sheet because it had a position, and a
  -- nullable snapshot would let a later reader confuse "we did not know" with
  -- "there was none".
  expected_quantity numeric(14,4) not null,

  -- WHAT THE COUNTER PHYSICALLY FOUND. NULL until they visit the shelf.
  -- Never negative: a shelf cannot hold less than nothing, whatever the ledger
  -- says. (The ledger CAN go negative — 038 §9 — and a count is how that gets
  -- corrected, not how it gets created.)
  counted_quantity  numeric(14,4)
                      constraint stock_take_lines_counted_sign_check
                      check (counted_quantity is null or counted_quantity >= 0),

  -- WHO counted this line and WHEN — separately from the audit columns, because
  -- they answer a different question. created_by is whoever started the sheet;
  -- counted_by is whoever walked to that shelf, and on a two-person count those
  -- are different people. The customer's primary pain is staff theft, so "who
  -- said there were four" has to be answerable per line.
  counted_at        timestamptz,
  counted_by        uuid references auth.users(id),

  -- THE COST THE VARIANCE MOVED AT, stamped at FINISH (§6.3).
  --
  -- NOT A CACHE (rule 6), exactly as stock_movements.carried_unit_cost is not:
  -- it stores a value derivable ONLY at the instant it is written. The moving
  -- average is path-dependent, so what a count's variance was worth is knowable
  -- at the moment the count is finished and not afterwards — one more receipt
  -- and the fold produces a different number. There is deliberately no recompute
  -- function, because a correct one cannot exist.
  --
  -- It is what makes the finished variance report REPRODUCIBLE: the value shown
  -- to the manager who approved it is still the value shown a year later.
  variance_unit_cost numeric(14,4)
                      constraint stock_take_lines_variance_cost_sign_check
                      check (variance_unit_cost is null or variance_unit_cost >= 0),

  -- The 'count_adjustment' movement this line produced, if it produced one. NULL
  -- means either the count is not finished, or the line was never counted, or
  -- the count agreed with the ledger — three different things, told apart by
  -- counted_quantity and the take's status.
  movement_id       uuid references stock_movements (id) on delete cascade,

  -- Rules 2/3: recording a count is a write, so it takes a key and has a partial
  -- unique index behind it.
  idempotency_key   text,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  created_by        uuid default auth.uid() references auth.users(id),
  updated_by        uuid references auth.users(id),

  -- ------------------------------------------------------------------------
  -- THE COUNTED TRIPLE MOVES TOGETHER
  -- ------------------------------------------------------------------------
  -- A quantity with no counter and no time is an anonymous number on a theft
  -- report; a counter and a time with no quantity is a line nobody counted
  -- claiming they did. Both halves are refused here rather than trusted to the
  -- RPC, which is also what makes CLEARING a line (back to "not counted") a
  -- single legal state rather than a half-erased row.
  constraint stock_take_lines_counted_shape_check
    check (
      (counted_quantity is null and counted_at is null and counted_by is null)
      or (counted_quantity is not null and counted_at is not null)
    ),

  -- A movement can only exist for a line that was actually counted.
  constraint stock_take_lines_movement_needs_count_check
    check (movement_id is null or counted_quantity is not null),

  -- ONE LINE PER ITEM PER COUNT. The sheet is a set of shelves, not a list of
  -- visits: a second line for the same item would be a second opinion with no
  -- way to tell which one the variance came from.
  constraint stock_take_lines_item_uniq unique (stock_take_id, inventory_item_id),

  -- Composite FKs (§6). The take binds the tenant; the item binds it again, so
  -- the three can never disagree.
  constraint stock_take_lines_take_tenant_fk
    foreign key (stock_take_id, tenant_id)
    references stock_takes (id, tenant_id) on delete cascade,
  constraint stock_take_lines_item_tenant_fk
    foreign key (inventory_item_id, tenant_id)
    references inventory_items (id, tenant_id)
);

comment on table stock_take_lines is
  'ONE LINE PER ITEM that had a position in the location when the count STARTED. '
  'expected_quantity is the SNAPSHOT taken at that instant and is never touched '
  'again — which is why a receipt landing mid-count shows up as stock the count '
  'did not see rather than as a variance the counter caused. counted_quantity '
  'NULL means NOT COUNTED (no movement, no variance); 0 means COUNTED AND THERE '
  'IS NONE (a variance of the full expected quantity). Those two must never be '
  'collapsed: defaulting the field to 0 would write off every shelf nobody '
  'visited.';
comment on column stock_take_lines.expected_quantity is
  'The fold''s quantity_on_hand for this item in this location AT THE MOMENT THE '
  'COUNT STARTED. NOT SELECTABLE by `authenticated` (§4): the column-level GRANT '
  'omits it, the table has no select policy, and the read view NULLs it until '
  'the count is finished. A blind count whose answer is sitting in the payload '
  'is not blind.';
comment on column stock_take_lines.variance_unit_cost is
  'The moving-average cost the variance moved at, stamped at FINISH. NOT A CACHE '
  '(rule 6): derivable only at the instant it is written, exactly like '
  'stock_movements.carried_unit_cost, because one more receipt makes the fold '
  'produce a different number. It is what keeps the finished variance report '
  'reproducible — the value the approving manager saw is the value seen a year '
  'later. The LEDGER remains the authority on cost of sale (§6).';
comment on column stock_take_lines.counted_by is
  'WHO walked to that shelf — deliberately separate from created_by (who started '
  'the sheet), because on a two-person count they are different people and "who '
  'said there were four" has to be answerable per line.';


-- ----------------------------------------------------------------------------
-- 3.1 Indexes
-- ----------------------------------------------------------------------------
create unique index if not exists stock_take_lines_idem_uniq
  on stock_take_lines (tenant_id, idempotency_key)
  where idempotency_key is not null;

-- The sheet read: every line of one take, which is what the paged sheet and the
-- progress aggregate both walk.
create index if not exists stock_take_lines_take_idx
  on stock_take_lines (stock_take_id);
-- "Has this item ever been counted, and what did the count say?" — the item
-- page's future count history.
create index if not exists stock_take_lines_item_idx
  on stock_take_lines (inventory_item_id);
create index if not exists stock_take_lines_tenant_id_idx
  on stock_take_lines (tenant_id);

-- The movements a count produced, looked up from the movement side. Also serves
-- every other document-driven movement the later tranches will post.
create index if not exists stock_movements_source_document_idx
  on stock_movements (source_document_type, source_document_id)
  where source_document_id is not null;


-- ----------------------------------------------------------------------------
-- 3.2 Audit columns and change log
-- ----------------------------------------------------------------------------
-- The full pair again, and log_field_changes() matters more here than anywhere
-- else in this file: it records every RE-KEY of a counted quantity, with the
-- actor and the old value. "The line said 4, then said 40 after the manager
-- walked away" is exactly the pattern a theft report is looking for, and without
-- this trigger the row would only ever show the last thing anybody typed.
drop trigger if exists set_row_audit_stock_take_lines on stock_take_lines;
create trigger set_row_audit_stock_take_lines
  before insert or update on stock_take_lines
  for each row execute function set_row_audit();

drop trigger if exists log_field_changes_stock_take_lines on stock_take_lines;
create trigger log_field_changes_stock_take_lines
  after update on stock_take_lines
  for each row execute function log_field_changes();


-- ############################################################################
-- SECTION 4 — BLIND, AND BLIND ON THE SERVER
-- ############################################################################
--
--  ┌──────────────────────────────────────────────────────────────────────────┐
--  │  THE CONTROL CANNOT LIVE IN THE UI.                                      │
--  │                                                                          │
--  │  A count sheet that hides the expected figure with CSS — or simply does  │
--  │  not render a column that is sitting in the JSON the browser already     │
--  │  received — is blind to a person who does not open the network tab.      │
--  │  That is not the person the control exists to catch.                     │
--  └──────────────────────────────────────────────────────────────────────────┘
--
-- THREE GUARDS, each sufficient on its own, because the failure mode of this
-- particular control is silent: nothing errors when a payload carries one extra
-- column, and no test that does not look at the payload will ever notice.
--
--   GUARD A — COLUMN PRIVILEGE. `authenticated` is granted SELECT on a NAMED
--     column list that does not include expected_quantity. Postgres refuses to
--     return it, whatever the query and whatever the policy.
--   GUARD B — NO SELECT POLICY. stock_take_lines has RLS enabled and no select
--     policy for anyone, so a client reading the table directly gets nothing at
--     all. Guard A survives someone later adding a member-select policy as a
--     convenience, which is precisely the change that would otherwise reopen
--     this quietly.
--   GUARD C — THE READ VIEW. The sheet is read through stock_take_sheet, which
--     NULLs expected_quantity, the variance and its value until the count is
--     FINISHED.
--
-- ----------------------------------------------------------------------------
-- WHY THE VIEWS RUN WITH THE OWNER'S RIGHTS — the one deviation in this file
-- ----------------------------------------------------------------------------
-- Every other read view in this product carries `security_invoker = on` (022,
-- 027, 036), so base-table RLS applies as if the caller had queried the tables
-- directly. These two deliberately do NOT, and the reason is mechanical rather
-- than a preference: under security_invoker the caller's own column privileges
-- are checked against the base table, so a view that reads expected_quantity
-- would need the caller to hold Guard A's revoked privilege. The blindness rule
-- and security_invoker are mutually exclusive here; blindness wins.
--
-- The price is that these views must do their own tenant scoping, and they do —
-- `t.tenant_id = any(get_tenant_ids())` in the WHERE of each, which is the same
-- predicate every RLS policy in this product uses. §9 asserts that the predicate
-- is present in both view definitions, so a later edit that drops it fails the
-- migration rather than leaking silently. Rule 19 still applies on top: every
-- application query additionally scopes to the ACTIVE tenant and property.
--
-- ----------------------------------------------------------------------------
-- 'finished', NOT 'not open' — a deliberate strengthening
-- ----------------------------------------------------------------------------
-- The obvious rule is "show expected once the count is no longer open". That
-- leaves a one-click hole: start a count, cancel it, read the expected figures
-- off the cancelled sheet, start another and type them in. So expected is
-- revealed only when the count is FINISHED — the state that has already posted
-- its variances and can no longer be influenced by knowing them. A cancelled
-- count keeps its counted quantities readable (what was found, and by whom) and
-- keeps its expected figures hidden, because it settled nothing.


-- ----------------------------------------------------------------------------
-- 4.1 stock_take_sheet — one row per line, for the counter and for the report
-- ----------------------------------------------------------------------------
-- ONE view serves both faces of the sheet, and that is deliberate: a separate
-- "variance report view" would be a second definition of what a variance is, and
-- the two would drift the first time either changed. The status decides which
-- columns carry values; the shape never changes, so the screen renders one table
-- and the numbers appear when they are allowed to.
--
-- The join to the catalogue lives HERE, in the database, so the sheet's search
-- and category filters are applied SERVER-SIDE against the same rows its exact
-- count and its totals describe (rules 1b and 20).
--
-- INVARIANT (rule 9): for a FINISHED take, every line with movement_id not null
-- satisfies
--     stock_take_sheet.variance_quantity === stock_movements.quantity
-- for that movement, exactly; and the count of such lines equals the number of
-- 'count_adjustment' movements carrying source_document_id = the take's id. The
-- VALUE column is the variance at the cost the movement carried, rounded once to
-- money precision — the ledger remains the authority on cost of sale (§6).
create or replace view stock_take_sheet as
select
  l.id                            as line_id,
  l.tenant_id,
  t.id                            as stock_take_id,
  t.property_id,
  t.location_id,
  t.status                        as take_status,
  t.business_date,
  l.inventory_item_id,
  i.name                          as item_name,
  i.code                          as item_code,
  i.base_unit,
  i.category_id,
  i.is_active                     as item_is_active,
  c.name                          as category_name,

  -- ALWAYS VISIBLE. What the counter typed is theirs to see — re-reading your
  -- own sheet is how a resumed count works at all.
  l.counted_quantity,
  -- The boolean the sheet filters on ("show me what is still to count"). A real
  -- column so the filter is server-side (rule 1b); derived from NULL-ness so a
  -- counted zero is TRUE here, which is the whole point of §3's header.
  (l.counted_quantity is not null) as is_counted,
  l.counted_at,
  l.counted_by,

  -- BLIND UNTIL FINISHED (§4's header). Not hidden in the client: absent from
  -- the payload.
  case when t.status = 'finished' then l.expected_quantity end
                                  as expected_quantity,
  case when t.status = 'finished' and l.counted_quantity is not null
       then (l.counted_quantity - l.expected_quantity)::numeric(14,4) end
                                  as variance_quantity,
  case when t.status = 'finished' then l.variance_unit_cost end
                                  as variance_unit_cost,
  -- Rounded ONCE, at the end, from the unrounded quantity difference and the
  -- stamped cost — the same rounding discipline 036 §3 states for stock_value.
  case when t.status = 'finished' and l.counted_quantity is not null
       then round((l.counted_quantity - l.expected_quantity)
                  * coalesce(l.variance_unit_cost, 0), 2)::numeric(14,2) end
                                  as variance_value,

  l.movement_id
from stock_take_lines l
join stock_takes t
  on t.id = l.stock_take_id
join inventory_items i
  on i.id = l.inventory_item_id
 and i.tenant_id = l.tenant_id
left join inventory_categories c
  on c.id = i.category_id
 and c.tenant_id = l.tenant_id
 and c.deleted_at is null                     -- a removed category reads as blank
-- THE TENANT PREDICATE. This view runs with the owner's rights (see §4's
-- header), so this line IS the isolation. §9 asserts it is still here.
where t.tenant_id = any(get_tenant_ids());

comment on view stock_take_sheet is
  'THE COUNT SHEET and the finished variance report, in one view — a second '
  '"report view" would be a second definition of what a variance is. '
  'expected_quantity, variance_quantity, variance_unit_cost and variance_value '
  'are NULL until the take is FINISHED: the blind rule is enforced here, in the '
  'read path, not in the client (CLAUDE.md §9). Revealed at ''finished'' rather '
  'than at "not open", because otherwise starting and cancelling a count would '
  'be a one-click way to read the answers. Runs with the OWNER''s rights — '
  'deliberately, since security_invoker would require the caller to hold the '
  'column privilege the blind rule revokes — so it carries its own '
  'get_tenant_ids() predicate.';


-- ----------------------------------------------------------------------------
-- 4.2 stock_take_progress — the document, with its sheet counted up
-- ----------------------------------------------------------------------------
-- What the header of the screen reads, and what the history list pages over.
--
-- NOTHING HERE IS STORED (rule 6). counted/uncounted/variance counts and the
-- variance totals are all computed from the lines on every read, for the reason
-- 036 gives about on-hand: a stored progress figure is a second source of truth
-- that drifts the moment any write path forgets to update it, and — unlike a
-- wrong ledger — cannot be repaired, because the information that would repair
-- it is what went missing.
--
-- "HOW MANY WERE COUNTED AND HOW MANY WERE NOT" is the brief's requirement and
-- it is these two columns. They are visible WHILE THE COUNT IS OPEN, which is
-- correct and not a leak: knowing that 40 of 180 shelves have been visited tells
-- you nothing about what is on them.
create or replace view stock_take_progress as
select
  t.id                                        as stock_take_id,
  t.tenant_id,
  t.property_id,
  t.location_id,
  l2.name                                     as location_name,
  t.take_number,
  t.status,
  t.business_date,
  t.note,
  t.started_at,
  t.started_by,
  t.finished_at,
  t.finished_by,
  t.approved_by,
  t.cancelled_at,
  t.cancelled_by,
  t.cancel_reason,

  -- int8 over PostgREST is a JSON NUMBER while numeric is a STRING (rule 22's
  -- lesson). Cast to integer so these three are unambiguously numbers on the
  -- wire and the render proof can pin that shape.
  count(l.id)::integer                        as line_count,
  -- count(col) counts NON-NULL values, so a counted ZERO counts as counted —
  -- which is the distinction §3's header exists to preserve.
  count(l.counted_quantity)::integer          as counted_count,
  (count(l.id) - count(l.counted_quantity))::integer
                                              as uncounted_count,

  -- BLIND UNTIL FINISHED, as the sheet is. A running variance total on an open
  -- count would hand the counter the answer in aggregate — worse than a single
  -- line, because it tells them how much they still have to "find".
  case when t.status = 'finished'
       then count(*) filter (
              where l.counted_quantity is not null
                and l.counted_quantity <> l.expected_quantity)::integer
  end                                         as variance_count,
  -- NET: what the count changed the property's stock value by. Signed.
  case when t.status = 'finished'
       then coalesce(sum(
              case when l.counted_quantity is null then 0
                   else round((l.counted_quantity - l.expected_quantity)
                              * coalesce(l.variance_unit_cost, 0), 2)
              end), 0)::numeric(14,2)
  end                                         as net_variance_value,
  -- ABSOLUTE: the size of the discrepancy, which is the figure the approval
  -- threshold is measured against (§6.3). +₦40,000 of rice found and ₦40,000 of
  -- gin missing is two discrepancies, not none.
  case when t.status = 'finished'
       then coalesce(sum(
              case when l.counted_quantity is null then 0
                   else abs(round((l.counted_quantity - l.expected_quantity)
                                  * coalesce(l.variance_unit_cost, 0), 2))
              end), 0)::numeric(14,2)
  end                                         as absolute_variance_value
from stock_takes t
join locations l2
  on l2.id = t.location_id
left join stock_take_lines l
  on l.stock_take_id = t.id
-- The tenant predicate, for §4.1's reason. §9 asserts it is still here.
where t.tenant_id = any(get_tenant_ids())
group by t.id, l2.name;

comment on view stock_take_progress is
  'One row per stock take with its sheet counted up: how many lines, how many '
  'counted, how many NOT counted, and — once FINISHED — how many varied and what '
  'the variance was worth, net and absolute. Nothing is stored (rule 6); every '
  'figure folds from the lines on read. counted/uncounted are visible while the '
  'count is OPEN and that is not a leak: knowing 40 of 180 shelves have been '
  'visited says nothing about what is on them. The variance figures are blind '
  'until finished, because a running total tells the counter how much they still '
  'have to "find". absolute_variance_value is the figure the approval threshold '
  'is measured against.';


-- ############################################################################
-- SECTION 5 — ROW-LEVEL SECURITY
-- ############################################################################
-- Both tables take the transactional posture 015/021/036 set: member SELECT at
-- most, and NO INSERT, UPDATE OR DELETE POLICY FOR ANYONE. Every mutation goes
-- through a SECURITY DEFINER RPC, because a direct write would bypass the staff
-- gate, the posting lock, the one-open-count rule, the snapshot, the status
-- machine and the manager approval — every one of which is what makes the
-- variance report trustworthy. DO NOT ADD A WRITE POLICY TO EITHER TABLE.
--
-- NO PUBLIC/ANON POLICY, ever. What a hotel holds in its stores and what its
-- counts found are private operational data; 001 §14 lists the only three tables
-- that may ever be public and neither of these is among them.
alter table stock_takes enable row level security;

-- The HEADER is member-readable: it carries no expected figure, and the count's
-- existence, status and progress are what a storekeeper needs to resume work.
drop policy if exists stock_takes_member_select on stock_takes;
create policy stock_takes_member_select on stock_takes
  for select to authenticated
  using (tenant_id = any(get_tenant_ids()));

drop policy if exists stock_takes_member_insert on stock_takes;
drop policy if exists stock_takes_member_update on stock_takes;
drop policy if exists stock_takes_member_delete on stock_takes;

-- THE LINES HAVE NO SELECT POLICY AT ALL — Guard B of §4, and the one place in
-- this product where a member is denied a read on purpose. The lines are read
-- through stock_take_sheet, which is the only surface that knows when the
-- expected figure may be shown. With RLS enabled and no policy, a direct read
-- returns zero rows: fail-closed, and quiet rather than confusing.
--
-- DO NOT ADD A MEMBER SELECT POLICY HERE as a convenience. It would put the
-- expected quantity one `select=*` away from every counter — except that Guard A
-- (the column-level grant, §8) would still refuse the column, which is exactly
-- why both guards exist.
alter table stock_take_lines enable row level security;

drop policy if exists stock_take_lines_member_select on stock_take_lines;
drop policy if exists stock_take_lines_member_insert on stock_take_lines;
drop policy if exists stock_take_lines_member_update on stock_take_lines;
drop policy if exists stock_take_lines_member_delete on stock_take_lines;


-- ############################################################################
-- SECTION 6 — THE WRITE RPCs
-- ############################################################################
-- Four, all SECURITY DEFINER with a pinned search_path, all staff-gated via
-- is_tenant_staff (015 §6.5), all idempotent against a partial unique index
-- (rules 2/3), and all running inside the implicit transaction of the function
-- call so a failure anywhere rolls the whole act back (rule 11).
--
-- WHY FOUR AND NOT THREE. The brief names start / record / finish. A 'cancelled'
-- status with no write path would be a state the schema can represent and
-- nothing can reach — dead code that reads like a feature — and an abandoned
-- count would then have to be finished (posting variances nobody agreed to) or
-- left open forever (blocking every future count of that location, by §2.1's
-- unique index). cancel_stock_take is what makes the third state real.
--
-- WHY STAFF AND NOT ADMIN. Counting a store is store work, exactly as loading
-- opening stock is (036 §4). A storekeeper who cannot count is a storekeeper who
-- keeps a paper book, and then the system holds nothing. The APPROVAL of a
-- material variance is the part that needs a manager, and that is a PIN on the
-- finishing act (§6.3) rather than a role gate on the whole module.


-- ----------------------------------------------------------------------------
-- 6.1 start_stock_take — the snapshot
-- ----------------------------------------------------------------------------
-- WHAT LANDS ON THE SHEET: every item that HAS A POSITION in this location —
-- i.e. every item with at least one movement here — including items whose
-- position is zero or negative. Zero matters because the shelf may not be empty
-- (found stock is a real and common outcome), and negative matters because it is
-- the discrepancy the whole module exists to surface.
--
-- WHAT DOES NOT: an item that has NEVER moved in this location. It has no cost
-- basis here, so a "variance" against it could not be valued, and inventing an
-- opening position from a count would be a second way for stock to enter the
-- system — which CLAUDE.md §9 forbids in its first line ("one way in"). Stock
-- physically present for an item with no history here is an OPENING BALANCE,
-- posted on the import page, and the error below says so.
--
-- AN INACTIVE ITEM STILL GETS A LINE. A discontinued line still sitting on a
-- shelf is exactly the thing a count must be able to write down to zero, and
-- 036 §4.2 already allows an inactive item to be adjusted for that reason. A
-- REMOVED (soft-deleted) item does not, and cannot hold stock anyway — 036 §6
-- refuses to remove one that does.
create or replace function start_stock_take(
  p_property_id     uuid,
  p_location_id     uuid,
  p_business_date   date,
  p_idempotency_key text,
  p_note            text default null
)
returns stock_takes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant   uuid;
  v_timezone text;
  v_today    date;
  v_date     date;
  v_existing stock_takes;
  v_take     stock_takes;
  v_open     stock_takes;
  v_lines    integer;
  v_number   text;
  v_actor    uuid := auth.uid();
begin
  -- The property is the anchor: it resolves the tenant (never trusted from the
  -- client) and carries the timezone the business date is computed in.
  select p.tenant_id, p.timezone into v_tenant, v_timezone
  from properties p
  where p.id = p_property_id and p.deleted_at is null;

  if v_tenant is null then
    raise exception 'Property % not found', p_property_id using errcode = 'PT404';
  end if;

  if not is_tenant_staff(v_tenant) then
    raise exception 'Not authorised to count stock for this property'
      using errcode = 'insufficient_privilege',
            hint = 'Ask an administrator to add you to this hotel''s team.';
  end if;

  -- IDEMPOTENCY FAST PATH (rules 2/3): a double-click or a retry after a dropped
  -- connection returns the SAME count rather than starting a second one — which
  -- the one-open-count index would refuse anyway, leaving the user staring at an
  -- error for a count they had in fact successfully started.
  if p_idempotency_key is not null then
    select * into v_existing
    from stock_takes
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
      and l.deleted_at is null                       -- rule 5
      and l.is_active = true
  ) then
    raise exception 'That stock location is not available for this property'
      using errcode = 'PT404',
            hint = 'Pick a location that is switched on, or switch this one back on under Manage locations.';
  end if;

  -- BUSINESS DATE (rules 8/12), resolved in the PROPERTY's timezone exactly as
  -- 036 does. NULL means "the property's local today".
  v_today := (now() at time zone coalesce(nullif(btrim(v_timezone), ''), 'Africa/Lagos'))::date;
  v_date  := coalesce(p_business_date, v_today);

  if v_date > v_today then
    raise exception 'A stock count cannot be dated in the future (today is % at this property)', v_today
      using errcode = 'PT422',
            hint = 'Date the count for the day you walked the shelves.';
  end if;

  -- THE POSTING LOCK (038 §4), checked HERE as well as at finish. Checking it at
  -- the start is the kindness: discovering a closed period after two hours of
  -- counting, with the sheet unfinishable, is how a control gets hated and then
  -- worked around.
  perform assert_posting_open(p_property_id, v_date);

  -- ONE OPEN COUNT PER LOCATION. The index (§2.1) is the guard under
  -- concurrency; this is the sentence, and it names the count in the way.
  select * into v_open
  from stock_takes
  where location_id = p_location_id and status = 'open'
  limit 1;
  if found then
    raise exception
      'A count is already open in this location — % , started on %.',
      v_open.take_number, to_char(v_open.started_at, 'DD Mon YYYY')
      using errcode = 'PT409',
            hint = 'Open it and carry on counting, or cancel it, before starting another. Two counts of the same shelves measure different moments.';
  end if;

  -- §6: the document number comes from the shared per-tenant counter, never from
  -- count(*)+1, which races and reuses numbers after a cancellation.
  v_number := next_document_number(v_tenant, p_property_id, 'stock_take', 'ST');

  begin
    insert into stock_takes (
      tenant_id, property_id, location_id, take_number, business_date,
      status, note, started_at, started_by, idempotency_key, created_by
    ) values (
      v_tenant, p_property_id, p_location_id, v_number, v_date,
      'open', nullif(btrim(p_note), ''), now(), v_actor, p_idempotency_key, v_actor
    )
    returning * into v_take;
  exception
    when unique_violation then
      -- A concurrent call with the same key won the race (stock_takes_idem_uniq):
      -- return its row rather than starting twice.
      if p_idempotency_key is not null then
        select * into v_existing
        from stock_takes
        where tenant_id = v_tenant and idempotency_key = p_idempotency_key
        limit 1;
        if found then
          return v_existing;
        end if;
      end if;
      -- Otherwise it was stock_takes_one_open_uniq: two terminals started a
      -- count in the same store in the same instant.
      raise exception 'A count is already open in this location.'
        using errcode = 'PT409',
              hint = 'Reload the page: the count that won the race is the one to carry on with.';
  end;

  -- ------------------------------------------------------------------------
  -- THE SNAPSHOT. One statement, so every line is taken from ONE instant.
  -- ------------------------------------------------------------------------
  -- Reading stock_on_hand from inside a SECURITY DEFINER function means the fold
  -- runs with the owner's rights and therefore sees the TRUE position (036 §3.5
  -- states this explicitly) — a count must be measured against all the stock
  -- that is really there, not against the stock its starter happens to be able
  -- to see.
  insert into stock_take_lines (
    tenant_id, stock_take_id, inventory_item_id, expected_quantity, created_by
  )
  select
    v_tenant, v_take.id, soh.inventory_item_id, soh.quantity_on_hand, v_actor
  from stock_on_hand soh
  join inventory_items i
    on i.id = soh.inventory_item_id
   and i.tenant_id = soh.tenant_id
   and i.deleted_at is null                          -- rule 5; see the header
  where soh.tenant_id = v_tenant
    and soh.property_id = p_property_id
    and soh.location_id = p_location_id;

  get diagnostics v_lines = row_count;

  if v_lines = 0 then
    -- Refused rather than started empty. A sheet with no lines cannot be
    -- counted, cannot be finished into anything, and would hold the location's
    -- one open-count slot against a real count later.
    raise exception
      'Nothing has ever moved in this location, so there is nothing to count.'
      using errcode = 'PT422',
            hint = 'Record opening balances for what is held here first — an item with no history in a location has no cost to value a count against.';
  end if;

  return v_take;
end;
$$;

comment on function start_stock_take(uuid, uuid, date, text, text) is
  'Opens a stock take and SNAPSHOTS the expected quantity of every item holding a '
  'position in that location, in one statement, so every line is measured from '
  'ONE instant — which is what makes a receipt landing mid-count show up as stock '
  'the count did not see rather than as a variance the counter caused. Refuses a '
  'second open count in the same location (naming the one in the way), a future '
  'date, a closed period (038 §4, checked here as a kindness as well as at '
  'finish), and a location with no movement history at all. Items with no history '
  'here are NOT added: stock physically present for one of those is an opening '
  'balance, which is the only other way in (CLAUDE.md §9). Staff-gated, '
  'idempotent, SECURITY DEFINER, pinned search_path.';


-- ----------------------------------------------------------------------------
-- 6.2 record_count_line — what the counter physically found
-- ----------------------------------------------------------------------------
--
--  ┌──────────────────────────────────────────────────────────────────────────┐
--  │  THE RETURN TYPE IS NARROW ON PURPOSE.                                   │
--  │                                                                          │
--  │  `returns stock_take_lines` would have been the obvious shape, and it    │
--  │  would have defeated every guard in §4 in one line: a SECURITY DEFINER    │
--  │  function returning the table type serialises EVERY column — including    │
--  │  expected_quantity — straight past the column grant, the missing policy   │
--  │  and the view. So this returns only the fields the caller is allowed to   │
--  │  know, and §9 asserts that NOTHING in this schema returns the line type.  │
--  └──────────────────────────────────────────────────────────────────────────┘
--
-- ZERO IS AN ANSWER; NULL CLEARS THE LINE. Passing NULL is how a counter undoes
-- a line they keyed against the wrong shelf — it restores "not counted", which
-- produces no movement, rather than leaving a 0 that would write the shelf off.
create or replace function record_count_line(
  p_stock_take_id     uuid,
  p_inventory_item_id uuid,
  p_counted_quantity  numeric,
  p_idempotency_key   text default null
)
returns table (
  line_id           uuid,
  stock_take_id     uuid,
  inventory_item_id uuid,
  counted_quantity  numeric,
  counted_at        timestamptz,
  counted_by        uuid
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_take  stock_takes;
  v_line  stock_take_lines;
  v_key   text;
  v_actor uuid := auth.uid();
-- EVERY COLUMN REFERENCE BELOW IS TABLE-QUALIFIED, and that is not house style
-- for its own sake. `returns table (...)` declares OUT variables named
-- stock_take_id, inventory_item_id and counted_quantity, which are ALSO column
-- names here: an unqualified reference to either is ambiguous, and plpgsql
-- raises 42702 at runtime rather than at creation — so the function would create
-- cleanly, pass a signature check, and fail the first time a counter used it.
begin
  select * into v_take from stock_takes t where t.id = p_stock_take_id;
  if not found then
    raise exception 'Stock count % not found', p_stock_take_id
      using errcode = 'PT404';
  end if;

  if not is_tenant_staff(v_take.tenant_id) then
    raise exception 'Not authorised to count stock for this property'
      using errcode = 'insufficient_privilege',
            hint = 'Ask an administrator to add you to this hotel''s team.';
  end if;

  v_key := nullif(btrim(coalesce(p_idempotency_key, '')), '');

  -- IDEMPOTENCY FAST PATH (rules 2/3). A key here means "this keystroke's save,
  -- possibly retried": a flaky connection on a phone in a cold store is the
  -- normal case, not the exotic one. Each SAVE carries a fresh key, so re-typing
  -- a line is a new intent and updates it, while a retry of the same save
  -- returns the line untouched.
  if v_key is not null then
    select * into v_line
    from stock_take_lines l
    where l.tenant_id = v_take.tenant_id and l.idempotency_key = v_key
    limit 1;
    if found then
      return query select v_line.id, v_line.stock_take_id, v_line.inventory_item_id,
                          v_line.counted_quantity, v_line.counted_at, v_line.counted_by;
      return;
    end if;
  end if;

  -- THE STATE GATE. A finished count is a settled document and a cancelled one
  -- settled nothing; neither takes another number.
  if v_take.status <> 'open' then
    raise exception 'Count % is % and cannot be added to.', v_take.take_number, v_take.status
      using errcode = 'PT409',
            hint = 'Start a new count for this location if the shelves need counting again.';
  end if;

  if p_counted_quantity is not null and p_counted_quantity < 0 then
    raise exception 'A counted quantity cannot be negative — a shelf cannot hold less than nothing.'
      using errcode = 'PT422',
            hint = 'Enter 0 if the shelf is empty. If the ledger says less than nothing, the count is how that gets corrected.';
  end if;

  -- LOCK THE LINE. Two people keying the same item at the same instant serialise
  -- here rather than racing; the last one to commit is the one on the sheet, and
  -- log_field_changes has recorded both.
  select * into v_line
  from stock_take_lines l
  where l.stock_take_id = p_stock_take_id
    and l.inventory_item_id = p_inventory_item_id
  for update;

  if not found then
    raise exception 'That item is not on this count sheet.'
      using errcode = 'PT404',
            hint = 'A count sheet holds the items that had stock in this location when it started. An item that has never moved here needs an opening balance, not a count.';
  end if;

  begin
    update stock_take_lines l
       set counted_quantity = p_counted_quantity,
           -- The triple moves together (§3's constraint): clearing the quantity
           -- clears the counter and the time with it.
           counted_at = case when p_counted_quantity is null then null else now() end,
           counted_by = case when p_counted_quantity is null then null else v_actor end,
           idempotency_key = v_key,
           updated_by = v_actor
     where l.id = v_line.id
    returning * into v_line;
  exception
    when unique_violation then
      -- A concurrent call with the same key won the race
      -- (stock_take_lines_idem_uniq): return its row rather than counting twice.
      if v_key is not null then
        select * into v_line
        from stock_take_lines l
        where l.tenant_id = v_take.tenant_id and l.idempotency_key = v_key
        limit 1;
        if found then
          return query select v_line.id, v_line.stock_take_id, v_line.inventory_item_id,
                              v_line.counted_quantity, v_line.counted_at, v_line.counted_by;
          return;
        end if;
      end if;
      raise;
  end;

  return query select v_line.id, v_line.stock_take_id, v_line.inventory_item_id,
                      v_line.counted_quantity, v_line.counted_at, v_line.counted_by;
end;
$$;

comment on function record_count_line(uuid, uuid, numeric, text) is
  'Records what the counter physically found on ONE line of an open count. '
  'Upsert-shaped: re-keying a line replaces the number and log_field_changes '
  'keeps both. A counted ZERO is a real answer (it posts a variance of the full '
  'expected quantity); passing NULL CLEARS the line back to "not counted", which '
  'posts nothing. Returns a NARROW row type rather than stock_take_lines, '
  'deliberately: the table type would serialise expected_quantity past every '
  'guard in §4. Refuses a negative quantity, an item not on the sheet, and any '
  'count that is not open. Staff-gated, idempotent, SECURITY DEFINER.';


-- ----------------------------------------------------------------------------
-- 6.3 finish_stock_take — the variances become movements
-- ----------------------------------------------------------------------------
--
--  ┌──────────────────────────────────────────────────────────────────────────┐
--  │  THIS IS THE WRITE PATH 036 RESERVED FOR 'count_adjustment'.             │
--  │                                                                          │
--  │  036 declared the type and deliberately gave it no way in: the table has  │
--  │  no write RLS policy for anyone, and every RPC hardcodes its own type.    │
--  │  This function is the only thing in the system that posts one, and it     │
--  │  can only do it from a counted document.                                  │
--  │                                                                          │
--  │  WHY THE TYPE MATTERS. A count variance posted as an ordinary             │
--  │  'adjustment' is invisible to every variance report: "adjustments in the  │
--  │  bar this month" would blend the corrections a count found with the       │
--  │  corrections somebody typed, and the one number a manager looks at to     │
--  │  spot stock walking would be diluted. Adjustment and count are different  │
--  │  things (CLAUDE.md §9) and the type is what keeps them separable forever. │
--  └──────────────────────────────────────────────────────────────────────────┘
--
-- ----------------------------------------------------------------------------
-- WHAT THE VARIANCE IS MEASURED AGAINST — the snapshot, not the present
-- ----------------------------------------------------------------------------
--     variance = counted_quantity - expected_quantity(SNAPSHOT AT START)
-- A receipt that landed mid-count is therefore NOT absorbed into the variance.
-- It stays in the ledger as the receipt it was, and the resulting on-hand is
-- (position now + variance) — which is exactly right: the counter counted the
-- shelf before the delivery arrived, and the delivery is separately recorded.
--
-- ----------------------------------------------------------------------------
-- THE RESULT MAY GO NEGATIVE, AND IT IS NOT BLOCKED
-- ----------------------------------------------------------------------------
-- If stock was ISSUED between the snapshot and the finish, applying the variance
-- can leave the position below zero. CLAUDE.md §9 is explicit: negative stock is
-- flagged, never blocked, because blocking stops service and teaches staff to
-- invent fake receipts — which destroys the ledger far more thoroughly than an
-- honest negative. 038 §9's report is where it then surfaces.
create or replace function finish_stock_take(
  p_stock_take_id   uuid,
  p_manager_pin     text,
  p_idempotency_key text default null
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
begin
  -- --- GUARD 1: resolve and LOCK the document ------------------------------
  -- FOR UPDATE so two terminals finishing the same count in the same instant
  -- serialise here rather than both reaching the posting loop. The second then
  -- sees a status of 'finished' and says so.
  select * into v_take from stock_takes where id = p_stock_take_id for update;
  if not found then
    raise exception 'Stock count % not found', p_stock_take_id using errcode = 'PT404';
  end if;

  if not is_tenant_staff(v_take.tenant_id) then
    raise exception 'Not authorised to finish stock counts for this property'
      using errcode = 'insufficient_privilege',
            hint = 'Ask an administrator to add you to this hotel''s team.';
  end if;

  -- --- GUARD 2: idempotency, by an EXPLICIT key ----------------------------
  -- Same distinction reverse_stock_movement draws (038 §7 GUARD 3), and for the
  -- same reason. A key the CALLER supplied means "this is one request of mine,
  -- possibly retried" — returning the finished document is exactly right, and
  -- crucially it does NOT re-check the PIN, so a retry after a dropped
  -- connection does not fetch the manager back to the terminal. Asking to finish
  -- a count with no key when it is already finished is a different act, and the
  -- honest answer is that it was finished, on such-and-such a day.
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
    -- Rule 2 admits no exception: a write RPC always has a key. A take is closed
    -- once ever, so the document IS the canonical key.
    v_key := 'close_stock_take:' || p_stock_take_id::text;
  end if;

  -- --- GUARD 3: the state --------------------------------------------------
  if v_take.status <> 'open' then
    raise exception 'Count % is already %.', v_take.take_number, v_take.status
      using errcode = 'PT409',
            hint = 'A count settles once. Start a new one for this location if the shelves need counting again.';
  end if;

  -- --- GUARD 4: the posting lock (038 §4) ----------------------------------
  -- Against the COUNT's business date, which is the date every movement will
  -- carry. A period closed since the count started closes the count with it —
  -- correctly: the alternative is a movement landing inside a month that has
  -- already been reported.
  perform assert_posting_open(v_take.property_id, v_take.business_date);

  -- ------------------------------------------------------------------------
  -- PASS 1: value every counted line, and stamp the cost it will move at.
  -- ------------------------------------------------------------------------
  -- Nothing is posted in this pass, so the average each line reads is the
  -- average before the count posts anything — which is the cost the count found
  -- the stock at. Stamping it on the line here (rather than deriving it later)
  -- is what makes the finished report reproducible: the moving average is
  -- path-dependent and one more receipt makes it unrecoverable.
  --
  -- UNCOUNTED LINES ARE SKIPPED ENTIRELY. An item nobody visited is untouched
  -- and must never read as a variance of its full quantity.
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

    -- Only reachable if every movement of this item in this location vanished
    -- between the snapshot and now, which movements being permanent makes
    -- impossible. Refused rather than guessed: a variance posted at a made-up
    -- cost is a silent corruption of the average.
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

    -- THE ABSOLUTE value, per line, rounded once to money precision so the
    -- figures on the report sum to exactly this total.
    v_absolute := v_absolute + abs(round(v_variance * coalesce(v_cost, 0), 2));
  end loop;

  -- ------------------------------------------------------------------------
  -- THE APPROVAL. A value threshold, in the shape apply_charge_discount uses.
  -- ------------------------------------------------------------------------
  -- property_finance_settings is guaranteed to have a row (021 §3's AFTER INSERT
  -- trigger), but coalesce to 0 anyway: if it were ever missing, the safe
  -- reading is "everything needs approval", never "nothing does".
  select pfs.count_variance_threshold into v_threshold
  from property_finance_settings pfs
  where pfs.property_id = v_take.property_id;
  v_threshold := coalesce(v_threshold, 0);

  if v_absolute > v_threshold then
    v_manager := verify_manager_pin(v_take.tenant_id, p_manager_pin);
    if v_manager is null then
      -- THE FIGURE IS DELIBERATELY NOT IN THIS MESSAGE, and that is the one
      -- place this file departs from 038's habit of putting the number in the
      -- sentence. 038 names the resulting quantity because a person can compare
      -- it to the shelf in front of them. Here the number IS the blind data: a
      -- counter who could read "this count is out by ₦180,000" from a refusal
      -- would have learnt the variance while the sheet is still open and
      -- editable, which is exactly what §4 exists to prevent. Naming the
      -- THRESHOLD tells them what to do; naming the variance would tell them
      -- what to type.
      raise exception
        'This count''s variance is above this property''s approval threshold of %, so a manager must authorise it.',
        to_char(v_threshold, 'FM999,999,999,990.00')
        using errcode = 'insufficient_privilege',
              hint = 'Hand the terminal to a manager. The approval is recorded against them by name, permanently.';
    end if;
  end if;

  -- ------------------------------------------------------------------------
  -- PASS 2: post one 'count_adjustment' movement per NON-ZERO variance.
  -- ------------------------------------------------------------------------
  -- A line that matched the ledger produces NOTHING. Counting a shelf and
  -- finding it right is a real and common outcome, and a zero-quantity movement
  -- would be refused by the table anyway (036 §1: a movement of nothing is not a
  -- movement).
  --
  -- ONE MOVEMENT PER STATEMENT, which 038 §6.2 requires: set_stock_carried_cost
  -- is STABLE and reads the statement's snapshot, so a multi-row INSERT would
  -- stamp every stock-out with the same pre-batch average. The loop is not a
  -- style choice.
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
      -- 036's cost/direction constraint decides which one is populated, not
      -- preference: a stock-IN must state a cost, a stock-OUT must state none.
      -- Found stock is the SAME stock at the SAME cost, so the current average
      -- is the right figure and using it leaves the average exactly where it
      -- was — a count corrects the QUANTITY, never the valuation. A stock-OUT
      -- carries out the average, stamped as carried_unit_cost by 038 §6's
      -- trigger.
      case when v_variance > 0 then round(v_line.variance_unit_cost, 2) else null end,
      v_take.business_date,
      v_reason,
      format('Counted %s against %s expected',
             format_stock_quantity(v_line.counted_quantity),
             format_stock_quantity(v_line.expected_quantity)),
      'stock_take',
      'stock_take', v_take.id,
      -- Rules 2/3: DETERMINISTIC per (count, item). A count posts each item's
      -- variance once, ever, so the document and the item ARE the canonical key
      -- — and a replay can never produce a second movement even if it somehow
      -- reached this loop twice.
      'stock_take:' || v_take.id::text || ':' || v_line.inventory_item_id::text,
      v_actor
    )
    returning * into v_movement;

    update stock_take_lines
       set movement_id = v_movement.id,
           updated_by = v_actor
     where id = v_line.id;
  end loop;

  -- ------------------------------------------------------------------------
  -- STAMP THE DOCUMENT. Last, so any failure above rolls the whole count back
  -- and there is no state in which stock moved without the count that moved it
  -- being marked as the thing that did.
  -- ------------------------------------------------------------------------
  --
  -- The handler is scoped to THIS statement rather than to the whole function on
  -- purpose: a function-level handler would also catch a unique_violation raised
  -- by the movement loop above and answer it with "somebody else finished this",
  -- which would be a confident lie about a completely different failure.
  begin
    update stock_takes t
       set status = 'finished',
           finished_at = now(),
           finished_by = v_actor,
           approved_by = v_manager,      -- NULL when within the threshold
           close_idempotency_key = v_key,
           updated_by = v_actor
     where t.id = v_take.id
    returning * into v_take;
  exception
    when unique_violation then
      -- A concurrent finish with the same key won the race
      -- (stock_takes_close_idem_uniq): return its document rather than raising a
      -- raw 23505 at a user who did nothing wrong.
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

comment on function finish_stock_take(uuid, text, text) is
  'Finishes a count: values every counted line at the moving average it found the '
  'stock at (stamped on the line, so the report stays reproducible), requires a '
  'manager PIN when the ABSOLUTE variance value exceeds the property''s '
  'count_variance_threshold, and posts ONE ''count_adjustment'' movement per '
  'non-zero variance — the write path 036 reserved for that type and the only one '
  'in the system. Variance is measured against the SNAPSHOT taken at start, so a '
  'receipt landing mid-count is not absorbed into it. Uncounted lines produce '
  'nothing; a counted ZERO produces a variance of the full expected quantity. The '
  'refusal names the threshold and NOT the variance, because the variance is the '
  'blind figure the sheet exists to withhold. Checks the posting lock against the '
  'count''s business date. Staff-gated, idempotent by key and by state, one '
  'transaction throughout (rule 11).';


-- ----------------------------------------------------------------------------
-- 6.4 cancel_stock_take — an abandoned count, closed honestly
-- ----------------------------------------------------------------------------
-- POSTS NOTHING AND STAYS READABLE. Its counted lines remain — who counted what,
-- and when — because "the count that was abandoned halfway" is itself evidence,
-- and deleting it would be the tidy version of hiding it.
--
-- ITS EXPECTED QUANTITIES STAY HIDDEN, permanently (§4's header): a cancelled
-- count settled nothing, so revealing its snapshot would turn start-then-cancel
-- into a one-click way to read the answers before counting for real.
--
-- A REASON IS MANDATORY. A count abandoned with no reason is the shape of a count
-- abandoned because of what it was about to show, and the constraint on the
-- table refuses a blank one underneath this message.
create or replace function cancel_stock_take(
  p_stock_take_id   uuid,
  p_reason          text,
  p_idempotency_key text default null
)
returns stock_takes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_take     stock_takes;
  v_existing stock_takes;
  v_key      text;
  v_reason   text;
  v_actor    uuid := auth.uid();
begin
  select * into v_take from stock_takes where id = p_stock_take_id for update;
  if not found then
    raise exception 'Stock count % not found', p_stock_take_id using errcode = 'PT404';
  end if;

  if not is_tenant_staff(v_take.tenant_id) then
    raise exception 'Not authorised to cancel stock counts for this property'
      using errcode = 'insufficient_privilege',
            hint = 'Ask an administrator to add you to this hotel''s team.';
  end if;

  -- The SAME close key as finish (§2): a take is closed once, by one act or the
  -- other, so one key covers both intents.
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

  v_reason := nullif(btrim(coalesce(p_reason, '')), '');
  if v_reason is null then
    raise exception 'A cancelled count needs a reason.'
      using errcode = 'PT422',
            hint = 'It is recorded permanently against your name — an abandoned count with no explanation is itself a finding.';
  end if;

  begin
    update stock_takes t
       set status = 'cancelled',
           cancelled_at = now(),
           cancelled_by = v_actor,
           cancel_reason = v_reason,
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

comment on function cancel_stock_take(uuid, text, text) is
  'Abandons an open count: posts NOTHING, keeps every counted line readable, and '
  'demands a reason — a count abandoned with no explanation is itself a finding. '
  'The expected quantities stay hidden permanently, so start-then-cancel is not a '
  'way to read the answers (039 §4). Frees the location''s one open-count slot. '
  'Shares the close idempotency key with finish_stock_take, because a take is '
  'closed once, by one act or the other. Staff-gated, SECURITY DEFINER.';


-- ############################################################################
-- SECTION 7 — 'count_adjustment' IS NOW WRITABLE
-- ############################################################################
-- The type's own comment has said "RESERVED, no write path" since 036 and said
-- "039 and later" since 038. It now has exactly one write path and the comment
-- says which — so a reader who greps for how a count variance reaches the ledger
-- lands on the answer instead of on a promise.
comment on column stock_movements.movement_type is
  'The full set is declared up front so later tranches add a write path, not a '
  'column: opening/adjustment (036), reversal (038) and count_adjustment (039 — '
  'finish_stock_take, and NOTHING else) are writable now; receipt (2c), '
  'issue_in/issue_out/transfer_in/transfer_out (part 3), consumption and wastage '
  'are RESERVED and have no write path — the table has no write RLS policy and '
  'every RPC hardcodes its own type. ''reversal'' and ''count_adjustment'' are '
  'types of their own rather than adjustments so that a correction of a '
  'legitimate posting, and a variance a physical count found, can never be '
  'counted among the unexplained movements the theft reports look for.';


-- ############################################################################
-- SECTION 8 — GRANTS
-- ############################################################################
-- Every SECURITY DEFINER function defaults to EXECUTE for PUBLIC, so each is
-- revoked and then granted its intended audience only. §9 asserts the result
-- across the whole schema rather than trusting this list.

-- --- The four RPCs ---------------------------------------------------------
revoke all on function start_stock_take(uuid, uuid, date, text, text) from public, anon;
grant  execute on function start_stock_take(uuid, uuid, date, text, text) to authenticated;

revoke all on function record_count_line(uuid, uuid, numeric, text) from public, anon;
grant  execute on function record_count_line(uuid, uuid, numeric, text) to authenticated;

revoke all on function finish_stock_take(uuid, text, text) from public, anon;
grant  execute on function finish_stock_take(uuid, text, text) to authenticated;

revoke all on function cancel_stock_take(uuid, text, text) from public, anon;
grant  execute on function cancel_stock_take(uuid, text, text) to authenticated;

-- --- The settings writer, replaced in §1.1 ---------------------------------
revoke all on function update_property_finance_settings(uuid, jsonb, timestamptz) from public, anon;
grant  execute on function update_property_finance_settings(uuid, jsonb, timestamptz) to authenticated;

-- --- The two views ---------------------------------------------------------
-- The `revoke all ... from authenticated` before each grant is load-bearing and
-- NOT redundant with the revoke from public: Supabase's default privileges grant
-- ALL on every new relation in `public` to `authenticated`, so a bare
-- `grant select` would leave INSERT/UPDATE/DELETE in place — and on an
-- owner-rights view (§4) those would be writes straight past RLS.
revoke all on stock_take_sheet from public;
revoke all on stock_take_sheet from anon;
revoke all on stock_take_sheet from authenticated;
grant select on stock_take_sheet to authenticated;

revoke all on stock_take_progress from public;
revoke all on stock_take_progress from anon;
revoke all on stock_take_progress from authenticated;
grant select on stock_take_progress to authenticated;

-- --- The two tables --------------------------------------------------------
-- stock_takes: member SELECT, and nothing else. The write privileges Supabase
-- grants by default are removed so RLS is not the only thing standing between a
-- client and the table.
revoke all on stock_takes from public;
revoke all on stock_takes from anon;
revoke all on stock_takes from authenticated;
grant select on stock_takes to authenticated;

-- ------------------------------------------------------------------------
-- GUARD A OF §4 — THE COLUMN-LEVEL GRANT
-- ------------------------------------------------------------------------
-- This is the single most important statement in this file, and it is the one
-- that is easiest to undo by accident. `authenticated` holds SELECT on a NAMED
-- LIST of columns, and expected_quantity is not on it. Postgres itself then
-- refuses to return that column — to any query, under any policy, through any
-- client, including a `select=*` (which expands to every column and fails with
-- 42501 rather than quietly dropping the one it may not read).
--
-- A LATER MIGRATION THAT WRITES `grant select on stock_take_lines to
-- authenticated` — with no column list — SILENTLY REPLACES THIS WITH FULL ACCESS
-- and reopens the blind count. §9 asserts the column is not selectable, so that
-- migration fails instead of shipping.
--
-- variance_unit_cost IS on the list: it is NULL until the count is finished, so
-- it discloses nothing while the sheet is open, and it is what makes the
-- finished report reproducible.
revoke all on stock_take_lines from public;
revoke all on stock_take_lines from anon;
revoke all on stock_take_lines from authenticated;
grant select (
  id, tenant_id, stock_take_id, inventory_item_id,
  counted_quantity, counted_at, counted_by,
  variance_unit_cost, movement_id, idempotency_key,
  created_at, updated_at, created_by, updated_by
) on stock_take_lines to authenticated;


-- ############################################################################
-- SECTION 9 — IN-TRANSACTION SELF-VERIFY
-- ############################################################################
-- Counted assertions, inside the migration's own transaction, so a migration
-- that half-worked never commits. Everything here is checkable without fixtures:
-- the blind rule is asserted against the catalogue (privileges and view
-- definitions), not against data that does not exist yet.
do $$
declare
  v_count   integer;
  v_missing text;
  v_def     text;
begin
  -- --- 1. The two tables exist, with the columns that carry the design -----
  select count(*) into v_count
  from information_schema.columns
  where table_schema = 'public' and table_name = 'stock_takes'
    and column_name in ('take_number', 'business_date', 'status',
                        'started_at', 'started_by', 'finished_at', 'finished_by',
                        'approved_by', 'cancelled_at', 'cancelled_by',
                        'cancel_reason', 'idempotency_key', 'close_idempotency_key');
  if v_count <> 13 then
    raise exception 'ASSERT FAILED: expected 13 stock_takes design columns, found %', v_count;
  end if;

  select count(*) into v_count
  from information_schema.columns
  where table_schema = 'public' and table_name = 'stock_take_lines'
    and column_name in ('expected_quantity', 'counted_quantity', 'counted_at',
                        'counted_by', 'variance_unit_cost', 'movement_id',
                        'idempotency_key');
  if v_count <> 7 then
    raise exception 'ASSERT FAILED: expected 7 stock_take_lines design columns, found %', v_count;
  end if;

  select count(*) into v_count
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'property_finance_settings'
    and column_name = 'count_variance_threshold';
  if v_count <> 1 then
    raise exception 'ASSERT FAILED: count_variance_threshold is not on property_finance_settings';
  end if;

  -- --- 2. THE BLIND RULE, GUARD A: the column is NOT selectable -----------
  -- The assertion the whole shipment turns on. If a later migration replaces the
  -- column-level grant with a table-level one, this fails and that migration
  -- does not ship.
  if has_column_privilege('authenticated', 'stock_take_lines', 'expected_quantity', 'SELECT') then
    raise exception
      'ASSERT FAILED: authenticated can SELECT stock_take_lines.expected_quantity — the count is no longer blind. Re-issue the column-level GRANT in 039 §8 instead of a table-wide one.';
  end if;

  -- The columns a resumed count genuinely needs must still be readable, or the
  -- guard has been applied by breaking the feature.
  if not has_column_privilege('authenticated', 'stock_take_lines', 'counted_quantity', 'SELECT') then
    raise exception 'ASSERT FAILED: authenticated cannot read counted_quantity — the sheet cannot be resumed';
  end if;

  -- --- 3. THE BLIND RULE, GUARD B: no select policy on the lines ----------
  select count(*) into v_count
  from pg_policies
  where schemaname = 'public' and tablename = 'stock_take_lines';
  if v_count <> 0 then
    raise exception
      'ASSERT FAILED: stock_take_lines has % RLS policies; it must have none (039 §5) — the lines are read through stock_take_sheet, which is the only surface that knows when the expected figure may be shown', v_count;
  end if;

  select count(*) into v_count
  from pg_class where relname = 'stock_take_lines' and relrowsecurity;
  if v_count <> 1 then
    raise exception 'ASSERT FAILED: RLS is not enabled on stock_take_lines';
  end if;

  select count(*) into v_count
  from pg_class where relname = 'stock_takes' and relrowsecurity;
  if v_count <> 1 then
    raise exception 'ASSERT FAILED: RLS is not enabled on stock_takes';
  end if;

  -- --- 4. THE BLIND RULE, GUARD C: the view hides it until 'finished' -----
  v_def := pg_get_viewdef('stock_take_sheet'::regclass, true);
  if position('''finished''' in v_def) = 0 or position('expected_quantity' in v_def) = 0 then
    raise exception
      'ASSERT FAILED: stock_take_sheet no longer gates expected_quantity on the finished status';
  end if;

  -- --- 5. The owner-rights views carry their own tenant predicate ---------
  -- These two views deliberately do NOT use security_invoker (§4), so this
  -- predicate IS the isolation. An edit that drops it must fail here rather than
  -- leak every tenant's counts to every user.
  if position('get_tenant_ids' in v_def) = 0 then
    raise exception
      'ASSERT FAILED: stock_take_sheet lost its get_tenant_ids() predicate — an owner-rights view with no tenant predicate reads every tenant';
  end if;

  v_def := pg_get_viewdef('stock_take_progress'::regclass, true);
  if position('get_tenant_ids' in v_def) = 0 then
    raise exception
      'ASSERT FAILED: stock_take_progress lost its get_tenant_ids() predicate';
  end if;

  -- --- 6. NOTHING RETURNS THE LINE TYPE ------------------------------------
  -- §6.2's trap, asserted as a sweep rather than as a note. A SECURITY DEFINER
  -- function returning `stock_take_lines` serialises every column past all three
  -- guards, and the mistake is invisible in review because the signature reads
  -- like every other RPC in the product.
  select string_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', ', ')
    into v_missing
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prorettype = 'stock_take_lines'::regtype;
  if v_missing is not null then
    raise exception
      'ASSERT FAILED: these functions return the stock_take_lines row type, which serialises expected_quantity past every guard in §4: %. Return a narrow row type instead.',
      v_missing;
  end if;

  -- --- 7. The structural rules that make the document a document ----------
  select count(*) into v_count
  from pg_indexes
  where schemaname = 'public' and indexname = 'stock_takes_one_open_uniq';
  if v_count <> 1 then
    raise exception 'ASSERT FAILED: stock_takes_one_open_uniq is missing — two counts could run in one location';
  end if;

  select count(*) into v_count
  from pg_indexes
  where schemaname = 'public'
    and indexname in ('stock_takes_idem_uniq', 'stock_takes_close_idem_uniq',
                      'stock_take_lines_idem_uniq');
  if v_count <> 3 then
    raise exception
      'ASSERT FAILED: expected 3 idempotency indexes (rule 3), found %', v_count;
  end if;

  -- The audit trigger on both tables, and the change log on both. Missing either
  -- would leave "who counted this" unanswerable, which is the whole point.
  select count(*) into v_count
  from pg_trigger
  where tgrelid in ('stock_takes'::regclass, 'stock_take_lines'::regclass)
    and tgname in ('set_row_audit_stock_takes', 'set_row_audit_stock_take_lines',
                   'log_field_changes_stock_takes', 'log_field_changes_stock_take_lines')
    and not tgisinternal;
  if v_count <> 4 then
    raise exception 'ASSERT FAILED: expected 4 audit/change-log triggers, found %', v_count;
  end if;

  -- --- 8. 'count_adjustment' is still an accepted movement type ------------
  select count(*) into v_count
  from pg_constraint
  where conname = 'stock_movements_type_check'
    and pg_get_constraintdef(oid) like '%''count_adjustment''%';
  if v_count <> 1 then
    raise exception 'ASSERT FAILED: stock_movements_type_check does not admit ''count_adjustment''';
  end if;

  -- --- 9. The read surfaces resolve ---------------------------------------
  -- Cheap to prove rather than assume, exactly as 038 §12.6b does: a view that
  -- lost a column its definition depends on fails HERE rather than on a screen.
  perform 1 from stock_take_sheet    limit 1;
  perform 1 from stock_take_progress limit 1;
  perform 1 from stock_takes         limit 1;

  -- --- 10. NO SECURITY DEFINER FUNCTION IN public IS ANON-EXECUTABLE ------
  -- 038 §12.6's sweep, re-run across 035-039 unchanged. A REAL SWEEP, not a name
  -- list: the defect it exists to catch is precisely a function NOBODY THOUGHT
  -- TO LIST, so every SECURITY DEFINER function in `public` is in scope by
  -- default and anything holding anon EXECUTE must be explained by one of the
  -- two arrays below.
  --
  -- EXEMPTION 1 — the RLS helpers, which MUST stay anon-executable because the
  -- public storefront's own policies invoke them. They disclose nothing: with
  -- auth.uid() NULL, get_tenant_ids() returns the empty array and every
  -- predicate is false. Fail-closed by construction.
  --
  -- EXEMPTION 2 — the 1.3 quarantine, unchanged from 038: six pre-existing
  -- functions (008, 030) that all gate internally on is_tenant_admin() or on
  -- auth.uid() being non-null, so an anon call raises rather than acting. The
  -- list can only SHRINK; until 1.3 clears it, any NEW leak fails this
  -- migration.
  --
  -- Trigger-returning functions are exempt MECHANICALLY: Postgres refuses direct
  -- invocation of any `returns trigger` function whatever the privilege, and
  -- PostgREST does not expose them.
  select string_agg(leaks.fn, ', ' order by leaks.fn)
    into v_missing
  from (
    select p.proname as nm,
           p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as fn
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosecdef
      and p.prorettype <> 'pg_catalog.trigger'::regtype
      and has_function_privilege('anon', p.oid, 'EXECUTE')
  ) leaks
  where leaks.nm <> all (array[
          'get_tenant_ids', 'get_property_ids', 'is_tenant_admin', 'is_tenant_staff'
        ])
    and leaks.nm <> all (array[
          'claim_statement_email', 'complete_statement_email',
          'update_property_branding', 'update_property_config',
          'update_property_details', 'update_tenant_settings'
        ]);

  if v_missing is not null then
    raise exception
      'ASSERT FAILED: anon holds EXECUTE on these SECURITY DEFINER functions, and they are neither RLS helpers nor on the 1.3 quarantine list: %. Revoke them, or add them to the quarantine with a reason.',
      v_missing;
  end if;

  -- --- 11. The four new RPCs are executable by exactly the right audience --
  select string_agg(nm, ', ' order by nm) into v_missing
  from unnest(array['start_stock_take', 'record_count_line',
                    'finish_stock_take', 'cancel_stock_take']) as nm
  where not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = nm
      and has_function_privilege('authenticated', p.oid, 'EXECUTE')
  );
  if v_missing is not null then
    raise exception
      'ASSERT FAILED: authenticated cannot execute these count RPCs, so the feature is unreachable: %', v_missing;
  end if;

  -- --- 12. anon can read neither view -------------------------------------
  if has_table_privilege('anon', 'stock_take_sheet', 'SELECT')
     or has_table_privilege('anon', 'stock_take_progress', 'SELECT')
     or has_table_privilege('anon', 'stock_takes', 'SELECT')
     or has_table_privilege('anon', 'stock_take_lines', 'SELECT') then
    raise exception
      'ASSERT FAILED: anon can read a stock-count surface. What a hotel counted in its stores is not for the internet.';
  end if;

  raise notice '039 self-verify: all assertions passed.';
end $$;


-- PostgREST caches the schema it exposes. Two new tables, two new views, four
-- new functions and one replaced signature, so without this the API keeps
-- offering the old shape until the next unrelated reload.
notify pgrst, 'reload schema';

-- ============================================================================
-- End of 039_stock_takes.sql
--
-- A count is now a document: started, filled, left and resumed, finished. It
-- survives a refresh and a shift change; it is measured against one snapshot
-- taken when it began, so a receipt landing mid-count is stock the count did not
-- see rather than a variance the counter caused; its expected figures never
-- reach the browser until it is finished; a partial count leaves untouched
-- shelves untouched; and a material variance cannot be settled without a manager
-- named against it. Receive, write-offs and requisitions follow.
-- ============================================================================
