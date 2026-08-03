-- ============================================================================
-- 031_reversals.sql
-- Palstro-Hotels: THE REVERSAL SUBSYSTEM, PART 1 — payments.
--
-- ----------------------------------------------------------------------------
--  ┌────────────────────────────────────────────────────────────────────────┐
--  │  THE POWER TO REVERSE A POSTING IS THE POWER TO ERASE MONEY.           │
--  │  So a reversal is a VISIBLE COUNTER-ENTRY, never a delete and never    │
--  │  an edit — tied to a named manager by PIN, with a mandatory reason,    │
--  │  and a permanent audit row linking original → counter-entry → who →    │
--  │  when → why.                                                           │
--  └────────────────────────────────────────────────────────────────────────┘
-- ----------------------------------------------------------------------------
--
-- THE CORE PRINCIPLE, STATED ONCE FOR EVERY PART OF THIS SUBSYSTEM
-- ----------------------------------------------------------------
-- A reversal NEVER touches the original row. It posts an equal-and-opposite
-- entry THROUGH THE SAME ENGINE the original went through, so every downstream
-- figure — folio_totals, folio_balance, the 027 FIFO allocation, the guest
-- ledger, the statement — flows unchanged, with no new arithmetic anywhere. Both
-- rows then stay on the record forever: the original says money came in, the
-- counter-entry says it went back out, and the reversals row says who authorised
-- that and why.
--
-- WHY NOT JUST VOID IT? Because void and reverse answer different questions, and
-- collapsing them loses the answer to one of them:
--
--   VOID    = "this never should have been recorded." A keying mistake caught in
--             the same breath. The line drops out of every total (the NULL-safe
--             `is_voided is not true` filter, rule 5) and reads as a scratched-out
--             entry. No PIN, because nothing was ever relied upon.
--   REVERSE = "this WAS recorded, it WAS relied upon, and now it must be undone."
--             A receipt was issued, a statement was emailed, a balance was quoted
--             down the phone. The original must keep counting — it happened — and
--             the undoing is a SECOND, equally visible fact with a manager's name
--             on it.
--
-- Voiding money that was genuinely received and then refunded would leave the
-- bill silent about the refund ever happening. That is the hole this closes.
--
-- WHAT THIS MIGRATION DOES *NOT* TOUCH — deliberately, and it must stay that way:
--   folio_totals, folio_balance, folio_charge_tax, the 022 read views, the 027
--   guest_stays / guest_ledger FIFO views, post_charge, post_room_night_charge,
--   apply_charge_discount, record_payment, void_charge, create_booking, checkout,
--   night audit and every pricing path are BYTE-FOR-BYTE as 015–030 left them.
--   The counter-entry is an ordinary folio_payments row posted through the
--   ordinary record_payment path, so the existing math consumes it with no
--   change of any kind. See §3.3 for the walk-through of exactly why.
--
--   ONE EXCEPTION, AND IT IS A CORRECTNESS FIX, NOT A FEATURE: void_payment is
--   re-created in §4 with two new guards. It is not in the untouchable list
--   above and it MUST change — see §4's header for the double-count it would
--   otherwise allow.
--
-- WHY THE TABLE HAS NO WRITE POLICY
-- ---------------------------------
-- A reversals row is EVIDENCE. If a browser could insert one, "a manager
-- approved this" would be a claim a staff member could type — the exact property
-- an audit record must not have. Member SELECT, no insert/update/delete policy
-- at all; the only path to a row is a SECURITY DEFINER RPC that verified a PIN
-- first. Same shape as folios / folio_charges / folio_payments (021 §11) and
-- statement_emails (030 §2), for the same reason.
--
-- LATER PARTS INHERIT THIS FILE
-- -----------------------------
-- target_type already carries the FULL list — 'payment' is live, and 'charge',
-- 'discount', 'no_show', 'cancel', 'checkout' are declared now so that parts 2..n
-- add an RPC and NOT a migration that alters this constraint. The table, its
-- indexes, its RLS and its permanence rule are the shared foundation; each later
-- part contributes only its own reverse_* function.
-- ============================================================================


-- ############################################################################
-- SECTION 1 — the reversals audit table
-- ############################################################################

create table if not exists reversals (
  id               uuid primary key default gen_random_uuid(),

  -- Scoping. A reversal is always a property's act, even when the thing reversed
  -- (a payment) belongs to a folio that may be tenant-scoped in other ways.
  tenant_id        uuid not null,
  property_id      uuid not null,

  -- WHEN. Distinct from created_at only in principle (they are the same instant
  -- today), kept as its own column because it is the fact the audit report reads
  -- and created_at is metadata by convention (§6).
  reversed_at      timestamptz not null default now(),

  -- WHO DID IT — the staff member at the keyboard. Non-forgeable: the RPC sets it
  -- from auth.uid(), and there is no write policy through which a client could
  -- send its own value.
  reversed_by      uuid not null references auth.users(id),

  -- WHO AUTHORISED IT — the manager whose PIN verified. May EQUAL reversed_by
  -- when a manager reverses something themselves, which is normal and is recorded
  -- as such rather than being suppressed. Identifying WHICH manager is the entire
  -- point (021 §7.2): "a manager approved this" names nobody.
  approved_by      uuid not null references auth.users(id),

  -- WHY. Mandatory in the column, not only in the RPC, so no future caller can
  -- write a reasonless reversal. A blank string is refused as firmly as a NULL —
  -- ' ' would satisfy `not null` and say nothing.
  reason           text not null
                     constraint reversals_reason_check check (btrim(reason) <> ''),

  -- WHAT KIND OF THING WAS REVERSED. The full list is declared now, on purpose:
  -- part 1 writes only 'payment', and parts 2..n (charge, discount, no-show,
  -- cancel, checkout) then need no ALTER of this constraint. An unknown value is
  -- refused, so a typo in a later RPC fails loudly at the first call.
  target_type      text not null
                     constraint reversals_target_type_check
                     check (target_type in (
                       'payment',    -- part 1 (this migration)
                       'charge',     -- reserved
                       'discount',   -- reserved
                       'no_show',    -- reserved
                       'cancel',     -- reserved
                       'checkout'    -- reserved
                     )),

  -- The ORIGINAL row that was reversed, and the COUNTER-ENTRY produced.
  --
  -- NEITHER CARRIES A FOREIGN KEY, and that is a decision, not an oversight:
  -- both are POLYMORPHIC over target_type. Today a target is a folio_payments
  -- row; tomorrow it is a folio_charges row, and for 'cancel' a bookings row. A
  -- FK can only point at ONE table, so adding one now would have to be dropped
  -- and replaced by part 2 — which is exactly the "later parts alter this
  -- migration" outcome the full target_type list above exists to avoid. The
  -- integrity that matters instead is enforced where it CAN be: the counter-entry
  -- side is bound by folio_payments.reversal_of_payment_id in §2, which IS a real
  -- composite FK, and the (target_type, target_id) pair is unique below.
  target_id        uuid not null,
  counter_entry_id uuid,

  -- §6: every operational table carries the PROPERTY's operating day, separate
  -- from created_at (rules 8, 12). A reversal keyed at 01:00 belongs to the shift
  -- that is still working, and it is the same business date the counter-payment
  -- is posted on — the two must agree or the day's cash-up will not.
  business_date    date not null,

  -- Rules 2 & 3, enforced by the partial unique index below.
  idempotency_key  text,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid default auth.uid() references auth.users(id),
  updated_by       uuid references auth.users(id),

  -- A 'payment' reversal ALWAYS produces a counter-payment; a row without one
  -- would be an audit record of something that did not happen to the money. The
  -- column stays nullable at the table level because a later target type may
  -- legitimately have no single counter row (a cancel reverses a state, not a
  -- posting), and this constraint is then extended per type rather than relaxed.
  constraint reversals_payment_counter_check
    check (target_type <> 'payment' or counter_entry_id is not null),

  -- §6 composite-key consistency: the pair binds to the property's own unique
  -- key, so a row whose tenant_id disagrees with its property's tenant is
  -- impossible rather than merely unlikely — the cross-tenant leak RLS cannot
  -- see, because every policy trusts tenant_id directly.
  constraint reversals_property_fk
    foreign key (property_id, tenant_id)
    references properties (id, tenant_id)
);

comment on table reversals is
  'THE PERMANENT RECORD OF EVERY REVERSAL: which row was reversed, which '
  'counter-entry undid it, which manager''s PIN authorised it, who keyed it, '
  'when, and why. A reversals row is NEVER UPDATED AND NEVER DELETED — not by '
  'the application, not by an admin, not by a later migration. Member SELECT '
  'only; the sole write path is the SECURITY DEFINER reverse_* RPCs, because a '
  'row a staff member could type is not evidence.';
comment on column reversals.approved_by is
  'The ACTIVE owner/manager whose PIN verified (021 §7.2). May equal reversed_by '
  'when a manager reverses their own posting — recorded, not suppressed. A '
  'reversal ALWAYS requires a PIN: unlike a discount there is no threshold, '
  'because there is no amount at which erasing recorded money is routine.';
comment on column reversals.target_id is
  'The ORIGINAL row reversed. Polymorphic over target_type, so deliberately NO '
  'foreign key — see the column comment block in the DDL. Unique per '
  '(tenant, target_type, target_id): a thing is reversed once, ever.';
comment on column reversals.counter_entry_id is
  'The equal-and-opposite entry this reversal posted (a folio_payments row for '
  'target_type = ''payment''). The original row is untouched; this is what makes '
  'the balance move.';
comment on column reversals.business_date is
  'The PROPERTY''s operating day of the reversal (rules 8, 12) — the same date '
  'the counter-entry is posted on, never the server''s calendar day.';

-- Rules 2 & 3: the constraint is the arbiter, not app code. Written partial to
-- match every other idempotency index in this schema.
create unique index if not exists reversals_idem_uniq
  on reversals (tenant_id, idempotency_key)
  where idempotency_key is not null;

-- ONE REVERSAL PER TARGET, EVER — the invariant the RPC's state check depends on.
-- The check ("is there already a reversal for this payment?") is the friendly
-- guard that returns the first reversal's outcome; THIS index is what makes the
-- guard true under concurrency, when two terminals reverse the same payment in
-- the same instant.
create unique index if not exists reversals_target_uniq
  on reversals (tenant_id, target_type, target_id);

-- "What was reversed at this property this week?" — the manager's audit read
-- (and the shape the reversal report of a later build will page over). Business
-- date first (rule 8), created_at only as the tiebreak within a day.
create index if not exists reversals_property_date_idx
  on reversals (tenant_id, property_id, business_date desc, created_at desc);

-- "Who has been approving reversals?" — the theft-detection read. A manager whose
-- PIN authorises a reversal every Friday night is precisely the pattern the
-- customer bought this system to see.
create index if not exists reversals_approved_by_idx
  on reversals (tenant_id, approved_by, business_date desc);

create index if not exists reversals_counter_entry_idx
  on reversals (counter_entry_id)
  where counter_entry_id is not null;

drop trigger if exists set_row_audit_reversals on reversals;
create trigger set_row_audit_reversals
  before insert or update on reversals
  for each row execute function set_row_audit();

-- THE TRIPWIRE. A reversals row is never updated, so in normal operation this
-- trigger never fires — which is exactly why it is here. If some future path
-- (a migration, a service_role script, a mistake) ever does rewrite a reason or
-- re-point an approver, change_log records the before and after against the
-- actor. An audit table that could be silently edited is not an audit table.
drop trigger if exists log_field_changes_reversals on reversals;
create trigger log_field_changes_reversals
  after update on reversals for each row execute function log_field_changes();


-- ############################################################################
-- SECTION 2 — the link from the counter-payment back to its original
-- ############################################################################
-- The reversals row already says "payment X was reversed by counter-entry Y".
-- This column says the same thing from the other end, ON THE PAYMENT ROW ITSELF,
-- and it earns its place three times over:
--
--   1. THE BILL AND THE STATEMENT read it with no extra query and no join to
--      reversals: a payment line that carries it prints as a reversal rather
--      than as a mysterious negative "Refund", and the line it reverses prints
--      as reversed. One fetch of the folio's payments already has both.
--   2. IT IS A REAL FOREIGN KEY. reversals.target_id cannot have one (it is
--      polymorphic — §1); this can, and it is the composite form (§6), so a
--      counter-payment can never point at a payment in another tenant or another
--      property.
--   3. IT MAKES A SECOND COUNTER-PAYMENT IMPOSSIBLE at the database level, via
--      the unique index below — independently of the reversals table.
--
-- It is NOT a cache (rule 6): it stores no money and no derived figure, only the
-- identity of another row, which cannot drift.

alter table folio_payments
  add column if not exists reversal_of_payment_id uuid;

comment on column folio_payments.reversal_of_payment_id is
  'Set ONLY on a counter-payment posted by reverse_payment: the id of the '
  'ORIGINAL payment this row reverses. NULL on every ordinary payment, deposit '
  'and refund. Not a cache (rule 6) — an identity, not a figure. The bill and '
  'the statement read it to print "Payment reversal" instead of a bare negative '
  'line, and the unique index below makes a second counter-payment impossible.';

-- The composite FK target (§6). folio_payments' primary key is `id` alone, so the
-- pair a child needs to bind to does not exist yet; this adds it. Guarded rather
-- than `if not exists` because ADD CONSTRAINT has no such clause.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'folio_payments_id_scope_uniq'
  ) then
    alter table folio_payments
      add constraint folio_payments_id_scope_uniq unique (id, tenant_id, property_id);
  end if;
end;
$$;

-- The self-reference, bound on all three columns: a counter-payment always sits
-- on the same tenant AND the same property as the payment it reverses. Two
-- independent FKs would allow the pair to disagree; this cannot.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'folio_payments_reversal_of_fk'
  ) then
    alter table folio_payments
      add constraint folio_payments_reversal_of_fk
      foreign key (reversal_of_payment_id, tenant_id, property_id)
      references folio_payments (id, tenant_id, property_id);
  end if;
end;
$$;

-- AT MOST ONE COUNTER-PAYMENT PER ORIGINAL. Belt to reversals_target_uniq's
-- braces: even if a future code path forgot the reversals row entirely, the
-- money could still only be reversed once.
create unique index if not exists folio_payments_reversal_of_uniq
  on folio_payments (reversal_of_payment_id)
  where reversal_of_payment_id is not null;


-- ############################################################################
-- SECTION 3 — reverse_payment
-- ############################################################################
--
-- 3.1 THE GUARD ORDER, AND WHY IT IS THIS ORDER
-- ---------------------------------------------
--   1. RESOLVE AND LOCK the payment (`select ... for update`). The lock is FIRST
--      because it is what makes every check below atomic: two terminals reversing
--      the same payment in the same second serialise here, and the loser reads
--      the winner's committed reversals row at step 4 instead of posting a second
--      counter-payment.
--   2. STAFF GATE, then the caller's own PROPERTY GRANT. Rule 19's two layers:
--      RLS keeps other tenants out, is_tenant_staff() + get_property_ids() keep a
--      multi-property user out of a property they were never granted.
--   3. IDEMPOTENCY BY KEY — a replay of the same intent returns the first
--      outcome. BEFORE the PIN check, deliberately: a retry after a network drop
--      must not send the desk to fetch a manager a second time for an approval
--      that already happened. (Same reasoning apply_charge_discount states in
--      021 §9.3.)
--   4. IDEMPOTENCY BY STATE — already reversed? Return that reversal. This is
--      the STRONGER guard: it also catches a retry that arrives with a DIFFERENT
--      key, which a key check by definition cannot.
--   5. NOT VOIDED. A voided payment counts for nothing already; reversing it
--      would post a counter-entry against money the totals never included, and
--      the balance would go WRONG by the amount.
--   6. NOT ITSELF A COUNTER-ENTRY. Reversing a reversal is a ping-pong that makes
--      the audit trail unreadable, and there is no operation it enables: the
--      money is where it started. (If a reversal was itself a mistake, void the
--      counter-entry — a same-moment keying error — or post a fresh payment.)
--   7. FOLIO NOT CLOSED. record_payment refuses a closed folio anyway; this
--      raises the sentence a person can act on instead of a deeper error from a
--      call they did not make.
--   8. REASON NON-EMPTY. In the RPC, not only the UI (rule 19) — and in the
--      column CHECK besides.
--   9. MANAGER PIN, ALWAYS. Last, so a call that was going to be rejected anyway
--      never consumes a PIN entry.
--
-- 3.2 WHY THE PIN HAS NO THRESHOLD
-- --------------------------------
-- A discount is threshold-gated (021 §9.3): a receptionist may take ₦2,000 off a
-- bill on their own authority because giving a small discount is part of the job.
-- A REVERSAL IS NOT. It says money that was recorded as received is no longer
-- recorded as received — the single most useful act to a person stealing cash,
-- and worth exactly as much at ₦5,000 as at ₦500,000, because it is the RECORD
-- being changed, not a price. There is therefore no amount below which it is
-- routine, and no property setting that can make it so. Do not add one.
--
-- 3.3 WHY folio_totals AND THE FIFO VIEWS NEED NO CHANGE
-- ------------------------------------------------------
-- Because the counter-entry is an ORDINARY PAYMENT. Walk it through:
--
--   * folio_totals (021 §8.2) computes payments_total as
--       sum(fp.amount) where fp.is_voided is not true
--     over SIGNED amounts. The counter-payment is -X, so payments_total drops by
--     X and `balance = charges_total - payments_total` RISES BY EXACTLY X. The
--     guest owes again what the reversed payment had settled. No new branch, no
--     CASE for reversals, not one character changed in the function.
--   * NOTHING IS CACHED (rule 6), so there is no stored balance to decrement, no
--     denormalised column to keep in lockstep and no GREATEST(0, ...) floor to
--     get wrong (rule 7). The lockstep review rule 7 demands is therefore trivial
--     here and is stated rather than performed: ledger, cache and denormalised
--     columns number one, zero and zero.
--   * THE 027 FIFO ALLOCATION IS COMPUTED AT READ TIME, in a window function
--     inside guest_stays, over the same non-voided folio_payments rows. Reducing
--     the guest's payment pool by X re-runs the water-fill on the NEXT READ and
--     re-allocates every stay automatically — the newest stay loses its
--     allocation first, exactly as it would if the payment had never been taken.
--     There is no stored allocation to repair, which is precisely why 027 refused
--     to store one.
--   * guest_ledger (027 §4) unions folio_payments rows as payment lines and
--     recomputes running_balance in the same window. The counter-payment appears
--     as its own dated line and the running balance steps back up from there.
--   * assembleStatement (lib/statement.ts) prints non-voided payment rows and
--     reads its totals from folio_totals, so the printed lines and the printed
--     balance both include the counter-entry with no change to the exporter.
--
-- The rule this expresses: A REVERSAL IS A POSTING, NOT AN EXCEPTION. The moment
-- one of these functions needs to know what a reversal is, the design has gone
-- wrong.
--
-- 3.4 THE TRANSACTION BOUNDARY
-- ----------------------------
-- One function call is one transaction (rule 11). The counter-payment, the link
-- column and the reversals row are written inside it, so there is no state in
-- which a counter-payment exists without its audit row, or an audit row points at
-- a counter-entry that was never posted. A failure anywhere — the PIN check, the
-- insert, a constraint — rolls the whole thing back and RAISEs with a meaningful
-- SQLSTATE the client shows verbatim; nothing is swallowed.

create or replace function reverse_payment(
  p_payment_id      uuid,
  p_reason          text,
  p_manager_pin     text,
  p_idempotency_key text default null
)
returns reversals
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payment     folio_payments;
  v_folio       folios;
  v_counter     folio_payments;
  v_reversal    reversals;
  v_existing    reversals;
  v_manager     uuid;
  v_reason      text;
  v_key         text;
  v_counter_key text;
  v_timezone    text;
  v_date        date;
  v_actor       uuid := auth.uid();
begin
  -- --- GUARD 1: resolve and LOCK the original ------------------------------
  -- FOR UPDATE before anything else: this lock is what serialises two
  -- simultaneous reversals of the same payment. The second call blocks here,
  -- and when it proceeds its guards see the first's committed work.
  select * into v_payment from folio_payments where id = p_payment_id for update;
  if not found then
    raise exception 'Payment % not found', p_payment_id using errcode = 'no_data_found';
  end if;

  -- --- GUARD 2: staff gate, then this caller's own property grant -----------
  if not is_tenant_staff(v_payment.tenant_id) then
    raise exception 'Not authorised to reverse payments for this tenant'
      using errcode = 'insufficient_privilege';
  end if;
  if not (v_payment.property_id = any(get_property_ids())) then
    raise exception 'You do not have access to this property'
      using errcode = 'insufficient_privilege';
  end if;

  -- The reversals row's key: the caller's, or the deterministic one. The
  -- COUNTER-PAYMENT's key (below) is ALWAYS the deterministic one, whatever the
  -- caller passed — see the comment at the record_payment call.
  v_counter_key := 'reversal:payment:' || p_payment_id::text;
  v_key := coalesce(nullif(btrim(p_idempotency_key), ''), v_counter_key);

  -- --- GUARD 3: idempotency BY KEY (rules 2 & 3) ---------------------------
  -- Before the PIN check on purpose: a retried intent returns the first
  -- outcome without demanding the manager come back to the terminal.
  select * into v_existing
  from reversals
  where tenant_id = v_payment.tenant_id and idempotency_key = v_key
  limit 1;
  if found then
    return v_existing;
  end if;

  -- --- GUARD 4: idempotency BY STATE — already reversed? -------------------
  -- The stronger of the two: it catches a retry arriving with a different key,
  -- and (holding the row lock from GUARD 1) it is what makes "a payment is
  -- reversed at most once" true under concurrency rather than merely likely.
  select * into v_existing
  from reversals
  where tenant_id = v_payment.tenant_id
    and target_type = 'payment'
    and target_id = p_payment_id
  limit 1;
  if found then
    return v_existing;
  end if;

  -- --- GUARD 5: the original must not be voided ----------------------------
  if v_payment.is_voided is true then
    raise exception
      'Payment % is voided; it counts for nothing and cannot be reversed', p_payment_id
      using errcode = 'check_violation',
            hint = 'A voided payment is already out of every total. Reversing it would move the balance by an amount the bill never included.';
  end if;

  -- --- GUARD 6: the original must not itself be a counter-entry ------------
  if v_payment.reversal_of_payment_id is not null then
    raise exception 'This line is itself a payment reversal and cannot be reversed'
      using errcode = 'check_violation',
            hint = 'The money is already back where it started. Post a fresh payment if it needs to be taken again.';
  end if;

  -- --- GUARD 7: the folio must not be closed -------------------------------
  select * into v_folio from folios where id = v_payment.folio_id;
  if v_folio.status = 'closed' then
    raise exception 'Folio % is closed; its payments cannot be reversed', v_folio.id
      using errcode = 'check_violation';
  end if;

  -- --- GUARD 8: the reason is mandatory HERE, not only in the UI (rule 19) --
  v_reason := btrim(coalesce(p_reason, ''));
  if v_reason = '' then
    raise exception 'A reversal needs a reason' using errcode = 'check_violation';
  end if;

  -- --- GUARD 9: A MANAGER PIN. ALWAYS. NO THRESHOLD. -----------------------
  -- §3.2 says why there is no amount below which this is skipped. verify_manager_pin
  -- returns the user_id of the ACTIVE owner/manager whose PIN matched, or NULL —
  -- fail closed. It is revoked from every client role (021 §12), so this is the
  -- only kind of place it can be called from.
  v_manager := verify_manager_pin(v_payment.tenant_id, p_manager_pin);
  if v_manager is null then
    raise exception 'Reversing a payment always requires a valid manager PIN'
      using errcode = 'insufficient_privilege',
            hint = 'Hand the terminal to a manager. The reversal is recorded against them by name.';
  end if;

  -- --- THE EFFECT, all of it inside this one transaction (§3.4) ------------

  -- The business date (rules 8, 12), resolved in the PROPERTY's timezone exactly
  -- as record_payment and create_booking do. It is the date the REVERSAL happens,
  -- never the original payment's date: the money goes back out today, and today's
  -- cash-up is what must show it.
  select p.timezone into v_timezone from properties p where p.id = v_payment.property_id;
  v_date := (now() at time zone coalesce(nullif(btrim(v_timezone), ''), 'Africa/Lagos'))::date;

  -- THE COUNTER-ENTRY, THROUGH THE EXISTING PAYMENT PATH. Not a hand-rolled
  -- insert: record_payment (021 §9.4) re-checks the folio status, validates the
  -- method, stamps the actor and arbitrates its own idempotency against
  -- folio_payments_idem_uniq. Reversal money must not travel a second, parallel
  -- road that could diverge from the first.
  --
  --   * amount = -amount. Payments are SIGNED (021 DECISION 3), so the negation
  --     IS the reversal — a +₦200,000 settlement reverses to -₦200,000, and a
  --     -₦50,000 refund reverses to +₦50,000. No direction flag, no CASE.
  --   * method = the original's. Cash reversed is cash out; the cash-up must see
  --     the two against the same tender.
  --   * reference = the human marker. folio_payments has no description column,
  --     and reference is its free-text field ("transfer ref, POS STAN, etc."), so
  --     this is where the line's own words live. The bill, the guest ledger view
  --     (027 §4 projects p.reference) and the statement all already print it, so
  --     the counter-line reads as "Payment reversal — <reason>" everywhere with
  --     no renderer change. The reason is COPIED, not joined: a reversals row is
  --     permanent and never updated, so the copy cannot drift from its source.
  --   * key = the DETERMINISTIC key, always, even when the caller passed one of
  --     their own. Two different caller keys must not be able to post two counter
  --     payments; with one fixed key, folio_payments_idem_uniq refuses the second
  --     outright. It also cannot collide with an ordinary payment's key, which a
  --     caller-supplied value could.
  v_counter := record_payment(
    v_payment.folio_id,
    - v_payment.amount,
    v_payment.method,
    'Payment reversal — ' || v_reason,
    v_date,
    v_counter_key
  );

  -- The link back (§2). A separate statement because record_payment deliberately
  -- takes no reversal parameter — widening the signature of the ONE payment RPC
  -- for one caller's benefit is how a shared path starts growing special cases.
  -- Same transaction, so no window exists in which the counter-payment is
  -- unlinked.
  update folio_payments
     set reversal_of_payment_id = p_payment_id,
         updated_by             = v_actor
   where id = v_counter.id
  returning * into v_counter;

  -- THE AUDIT ROW. Written last, so it can name the counter-entry it produced.
  begin
    insert into reversals (
      tenant_id, property_id, reversed_by, approved_by, reason,
      target_type, target_id, counter_entry_id, business_date,
      idempotency_key, created_by
    ) values (
      v_payment.tenant_id, v_payment.property_id, v_actor, v_manager, v_reason,
      'payment', p_payment_id, v_counter.id, v_date,
      v_key, v_actor
    )
    returning * into v_reversal;
  exception
    when unique_violation then
      -- A concurrent caller won a race the GUARD 1 lock should already have
      -- prevented. Return THEIR row — but only if it genuinely exists: re-raising
      -- otherwise aborts the whole call, rolling the counter-payment back with
      -- it, so this handler can never leave a counter-payment without its audit
      -- row.
      select * into v_existing
      from reversals
      where tenant_id = v_payment.tenant_id
        and (idempotency_key = v_key
             or (target_type = 'payment' and target_id = p_payment_id))
      limit 1;
      if found then
        return v_existing;
      end if;
      raise;
  end;

  return v_reversal;
end;
$$;

comment on function reverse_payment(uuid, text, text, text) is
  'Reverses a payment by posting an EQUAL AND OPPOSITE counter-payment through '
  'record_payment and writing a permanent reversals audit row. The original is '
  'never edited or deleted; both lines stay on the bill. ALWAYS requires a valid '
  'manager PIN — no threshold, because erasing recorded money is never routine — '
  'and a non-empty reason, both enforced here and not only in the UI (rule 19). '
  'Idempotent by key AND by state, under a FOR UPDATE lock on the original, so a '
  'double-click or a retry can never post two counter-payments. folio_totals and '
  'the 027 FIFO views need no change: the counter-entry is an ordinary signed '
  'payment, so the balance rises by the reversed amount and FIFO re-allocates on '
  'the next read (nothing is cached — rule 6).';


-- ############################################################################
-- SECTION 4 — void_payment gains two guards (a CORRECTNESS FIX)
-- ############################################################################
-- THE BUG THIS CLOSES, in figures. A ₦200,000 cash payment is reversed: the
-- original stays +200,000 and the counter-entry is -200,000, so payments_total
-- is 0 and the guest owes the full bill again. Correct.
--
-- Now suppose the ORIGINAL could still be voided. folio_totals drops it, leaving
-- payments_total = -200,000, and `balance = charges - payments` OVERSTATES the
-- debt by ₦200,000 — the hotel now believes a guest who paid and was refunded
-- owes them the money twice over. Voiding the COUNTER-ENTRY instead is the mirror
-- image: payments_total returns to +200,000, silently UN-REVERSING an accountable
-- reversal with no PIN, no reason and no audit row.
--
-- Neither is a hypothetical: both are two clicks apart in the same ⋯ menu. So
-- void_payment now refuses both, and the UI hides the action to match (rule 19:
-- the client hides it for a clean screen, the database is the guard).
--
-- EVERYTHING ELSE IN THIS FUNCTION IS BYTE-FOR-BYTE 021 §9.5 — same signature,
-- same lock, same staff gate, same idempotent-by-state return, same reason
-- requirement, same columns written. Only the two guards are new.
create or replace function void_payment(
  p_payment_id      uuid,
  p_reason          text,
  p_idempotency_key text default null
)
returns folio_payments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payment folio_payments;
  v_folio   folios;
  v_actor   uuid := auth.uid();
begin
  select * into v_payment from folio_payments where id = p_payment_id for update;
  if not found then
    raise exception 'Payment % not found', p_payment_id using errcode = 'no_data_found';
  end if;

  if not is_tenant_staff(v_payment.tenant_id) then
    raise exception 'Not authorised to void payments for this tenant'
      using errcode = 'insufficient_privilege';
  end if;

  if v_payment.is_voided is true then
    return v_payment;
  end if;

  -- NEW (031 §4): a payment that has been REVERSED cannot also be voided — the
  -- counter-entry already took it out of the balance, and voiding the original
  -- on top of that would subtract the same money twice.
  if exists (
    select 1 from reversals r
    where r.tenant_id = v_payment.tenant_id
      and r.target_type = 'payment'
      and r.target_id = v_payment.id
  ) then
    raise exception 'Payment % has been reversed and cannot also be voided', p_payment_id
      using errcode = 'check_violation',
            hint = 'The reversal already removed it from the balance. Voiding it as well would subtract the same money twice.';
  end if;

  -- NEW (031 §4): a COUNTER-ENTRY cannot be voided either — that would silently
  -- un-reverse an approved reversal, with no PIN, no reason and no audit row,
  -- while the permanent reversals row still says the money went back.
  if v_payment.reversal_of_payment_id is not null then
    raise exception 'This line is a payment reversal and cannot be voided'
      using errcode = 'check_violation',
            hint = 'Voiding it would undo an approved reversal without a manager''s authorisation. Post a fresh payment instead.';
  end if;

  select * into v_folio from folios where id = v_payment.folio_id;
  if v_folio.status = 'closed' then
    raise exception 'Folio % is closed; its payments cannot be voided', v_folio.id
      using errcode = 'check_violation';
  end if;

  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'A void needs a reason' using errcode = 'check_violation';
  end if;

  update folio_payments
     set is_voided   = true,
         voided_at   = now(),
         voided_by   = v_actor,
         void_reason = btrim(p_reason),
         updated_by  = v_actor
   where id = p_payment_id
  returning * into v_payment;

  return v_payment;
end;
$$;

comment on function void_payment(uuid, text, text) is
  'Voids a payment — sets is_voided with a reason, time and actor; NEVER deletes '
  '(rule 5). Excluded from folio_balance by the NULL-safe filter. Idempotent by '
  'state. REFUSES a payment that has been reversed, and refuses a reversal '
  'counter-entry: the first would subtract the same money twice, the second would '
  'un-reverse an approved reversal without a PIN (031 §4).';


-- ############################################################################
-- SECTION 5 — Row-Level Security
-- ############################################################################
-- Rule 13, from day one. Member SELECT so a colleague can answer "who reversed
-- this, and why?" without a support ticket. NO insert, update or delete policy
-- for anyone — see the header: the row is evidence, and the only write path is
-- reverse_payment (and its siblings in later parts), which run as the function
-- owner and verified a manager PIN first.
--
-- NO public/anon policy, ever. A reversal names staff and exposes a hotel's
-- internal controls; the guest storefront has no business reading it.

alter table reversals enable row level security;

drop policy if exists reversals_member_select on reversals;
create policy reversals_member_select on reversals
  for select to authenticated
  using (tenant_id = any(get_tenant_ids()));

-- Stated as explicit drops, the same way 021 §11 does, so the absence is
-- deliberate and visible rather than merely unwritten. DO NOT ADD ONE.
drop policy if exists reversals_member_insert on reversals;
drop policy if exists reversals_member_update on reversals;
drop policy if exists reversals_member_delete on reversals;

-- Supabase's default privileges grant ALL on a new table in `public` to
-- `authenticated`, so a bare policy is not enough: revoke the table privileges
-- and grant back only SELECT. Without this, the missing UPDATE/DELETE policies
-- would be the only thing standing between a client and an edited audit row.
revoke all on reversals from public;
revoke all on reversals from anon;
revoke all on reversals from authenticated;
grant select on reversals to authenticated;


-- ############################################################################
-- SECTION 6 — Function grants
-- ############################################################################
-- SECURITY DEFINER defaults to EXECUTE for PUBLIC. Revoke, then grant only
-- authenticated staff — never anon.
revoke execute on function reverse_payment(uuid, text, text, text) from public;
revoke execute on function reverse_payment(uuid, text, text, text) from anon;
grant  execute on function reverse_payment(uuid, text, text, text) to authenticated;

-- Re-stated for the re-created void_payment: CREATE OR REPLACE preserves the
-- existing grants, but stating them keeps this file readable on its own.
revoke execute on function void_payment(uuid, text, text) from public;
revoke execute on function void_payment(uuid, text, text) from anon;
grant  execute on function void_payment(uuid, text, text) to authenticated;

-- ============================================================================
-- End of 031_reversals.sql
-- ============================================================================
