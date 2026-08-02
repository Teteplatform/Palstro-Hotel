-- ============================================================================
-- 030_statement_emails.sql
-- Palstro-Hotels: THE RECORD OF EVERY STATEMENT EMAILED TO A GUEST.
--
-- ----------------------------------------------------------------------------
-- WHAT THIS IS FOR
-- ----------------------------------------------------------------------------
-- "Did the guest get their bill?" is a question the desk is asked days later,
-- usually by a guest who says they never received it. Without a record the
-- honest answer is "we think so", and the desk sends it again to the same wrong
-- address. One row per send attempt answers it exactly: WHO sent WHICH document
-- to WHAT address, WHEN, and whether the provider actually accepted it.
--
-- ----------------------------------------------------------------------------
-- WHAT THIS IS NOT
-- ----------------------------------------------------------------------------
-- NOT a financial table, and it touches none. folio_totals, folio_charge_tax,
-- folio_balance, post_charge, record_payment, void_charge, void_payment,
-- check_in_booking, check_out_booking, run_night_audit, create_booking and every
-- pricing path are BYTE-FOR-BYTE as 015/016/021/023/024/025/026/029 left them.
-- No figure in this system changes because a statement was emailed.
--
-- It also carries NO MONEY COLUMN — deliberately, under rule 6. A balance
-- snapshotted here would be a cache with no recompute path: the folio moves on
-- (a payment lands, a charge is voided) and the snapshot silently becomes a
-- second, wrong answer to "what did they owe". What is recorded instead is the
-- document's REFERENCE — the booking number, or the standalone account's short
-- reference — which is stable, and from which the actual figures are always
-- re-derivable through folio_totals.
--
-- ----------------------------------------------------------------------------
-- WHY THE WRITES ARE RPCs AND THE TABLE HAS NO WRITE POLICY
-- ----------------------------------------------------------------------------
-- The row is EVIDENCE. If the browser could insert into this table directly,
-- "sent to the guest on the 4th" would be a claim a staff member could type,
-- which is exactly the property an audit record must not have. So the table has
-- a member SELECT policy and NO insert/update/delete policy at all — the same
-- shape 021 gives folios/folio_charges/folio_payments, and for the same reason.
-- Both writes go through SECURITY DEFINER RPCs that gate on is_tenant_staff()
-- and on the caller's own property grants.
--
-- ----------------------------------------------------------------------------
-- TWO PHASES, AND WHY A SEND IS CLAIMED BEFORE IT IS MADE
-- ----------------------------------------------------------------------------
-- Sending an email is not idempotent. Nothing in SMTP lets us ask "did this
-- already go?", so the only way a double-click or a retried request cannot mail
-- a guest twice is for the DATABASE to decide who is allowed to send:
--
--   1. claim_statement_email() inserts the row as 'sending' under the caller's
--      idempotency key. The partial unique index on (tenant_id,
--      idempotency_key) is what actually arbitrates (rule 3) — a second
--      concurrent call cannot insert, reads the existing row, and returns it
--      with claimed = false. The endpoint then sends NOTHING and reports the
--      first attempt's outcome.
--   2. complete_statement_email() records what the provider said: 'sent' with
--      its message id, or 'failed' with the error. Only a 'sending' row may be
--      completed, so an outcome can never be rewritten.
--
-- A row left at 'sending' therefore means exactly one thing: the function died
-- between the provider call and the completion, and NOBODY KNOWS whether the
-- mail went. That is the truth, and it is far more useful than a default that
-- guesses either way.
--
-- A FAILED SEND DOES NOT RELEASE ITS KEY, by design: the client mints a FRESH
-- idempotency key per send INTENT (lib/folio's newIdempotencyKey, same
-- convention as every other write), so "try again" is a new intent with a new
-- key and a new row. The key collapses the retry of ONE in-flight intent, never
-- the desk's decision to try again — and the failed attempt stays on the record.
-- ============================================================================


-- ############################################################################
-- SECTION 1 — the table
-- ############################################################################

create table if not exists statement_emails (
  id                  uuid primary key default gen_random_uuid(),

  -- Scoping. property_id is not-null: a statement is always a property's
  -- document, even when its subject (a guest) is tenant-scoped.
  tenant_id           uuid not null references tenants(id),
  property_id         uuid not null,

  -- WHICH DOCUMENT. Mirrors lib/statementLoad's StatementTarget exactly: a stay
  -- statement is built from a booking's folio, a standalone one from a guest's
  -- non-resident folio (028 §2). guest_id is recorded for BOTH — on a stay it is
  -- the guest who slept in the room — so "everything ever emailed to this
  -- person" is one predicate rather than a join through bookings.
  subject_kind        text not null
                        constraint statement_emails_kind_check
                        check (subject_kind in ('stay', 'standalone')),
  booking_id          uuid,
  guest_id            uuid,

  -- The document's own handle as the guest received it: bookings.booking_number
  -- for a stay, the short account reference for a standalone folio. Copied, not
  -- joined, because it is what the guest quotes down the phone and it must stay
  -- readable even if the subject row is later soft-deleted.
  document_reference  text not null,

  -- WHERE IT WENT. The address as typed at the desk for THIS send, which is not
  -- necessarily guests.email — the whole point of the confirm step is that a
  -- desk may correct a bad address without touching the guest record.
  to_email            text not null
                        constraint statement_emails_to_email_check
                        check (to_email = btrim(to_email) and to_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),

  -- The provider that carried it ('resend' today). Recorded rather than assumed
  -- so a later switch does not make every historical row ambiguous.
  provider            text not null,
  provider_message_id text,

  status              text not null
                        constraint statement_emails_status_check
                        check (status in ('sending', 'sent', 'failed')),
  -- Populated only on 'failed', and it is the provider's / function's own words
  -- (rule 11: surfaced, never swallowed) so a recurring failure is diagnosable
  -- from the table alone.
  error_message       text,

  -- §6: every operational table carries the property's operating day, separate
  -- from created_at. A statement emailed at 00:30 belongs to the day the desk is
  -- still working, and every report groups by this.
  business_date       date not null,

  -- Rules 2/3. See the header for why a claim, not a check.
  idempotency_key     text not null,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  created_by          uuid default auth.uid() references auth.users(id),
  updated_by          uuid references auth.users(id),

  -- The subject discriminator is enforced, not trusted: a 'stay' row without a
  -- booking would be a record of a document that cannot be rebuilt.
  constraint statement_emails_subject_check check (
    (subject_kind = 'stay'       and booking_id is not null) or
    (subject_kind = 'standalone' and guest_id   is not null)
  ),

  -- §6 composite-key consistency. Each pair binds to the parent's own unique
  -- key, so a row whose tenant_id disagrees with its property's (or its
  -- booking's, or its guest's) is impossible rather than merely unlikely — the
  -- cross-tenant leak RLS cannot see, because every policy trusts tenant_id.
  -- MATCH SIMPLE (the default) means a NULL booking_id / guest_id simply skips
  -- its constraint, which is what lets one table hold both subject shapes.
  constraint statement_emails_property_fk
    foreign key (property_id, tenant_id)
    references properties (id, tenant_id),
  constraint statement_emails_booking_fk
    foreign key (booking_id, tenant_id, property_id)
    references bookings (id, tenant_id, property_id),
  constraint statement_emails_guest_fk
    foreign key (guest_id, tenant_id)
    references guests (id, tenant_id)
);

comment on table statement_emails is
  'One row per attempt to email a guest their statement: who sent which '
  'document to what address, when, and what the provider said. Evidence, not '
  'state — no money column (rule 6), no write policy (writes go through '
  'claim_statement_email / complete_statement_email only).';
comment on column statement_emails.status is
  'sending -> sent | failed. A row LEFT at sending means the send was claimed '
  'but never completed — the function died mid-flight and nobody knows whether '
  'the mail went. Never guess it into sent or failed.';
comment on column statement_emails.business_date is
  'The PROPERTY''s operating day of the send (rules 8, 12) — never the server''s '
  'calendar day, and never the basis of created_at.';
comment on column statement_emails.to_email is
  'The address this send actually went to, which may differ from guests.email: '
  'the desk may correct a bad address for one send without editing the record.';

-- Rule 3: the constraint is the arbiter, not app code. Written partial (the
-- column is NOT NULL today) so the shape matches every other idempotency index
-- in this schema and stays correct if a future backfill ever needs a null.
create unique index if not exists statement_emails_idem_uniq
  on statement_emails (tenant_id, idempotency_key)
  where idempotency_key is not null;

-- "Has this stay's statement been emailed, and to where?" — the read the send
-- dialog makes to show the desk the last successful send. business_date first
-- (rule 8), created_at only as the tiebreak within a day.
create index if not exists statement_emails_booking_idx
  on statement_emails (tenant_id, property_id, booking_id, business_date desc, created_at desc)
  where booking_id is not null;

create index if not exists statement_emails_guest_idx
  on statement_emails (tenant_id, property_id, guest_id, business_date desc, created_at desc)
  where guest_id is not null;

drop trigger if exists set_row_audit_statement_emails on statement_emails;
create trigger set_row_audit_statement_emails
  before insert or update on statement_emails
  for each row execute function set_row_audit();


-- ############################################################################
-- SECTION 2 — Row-Level Security: read for members, writes for nobody
-- ############################################################################
--
-- Rule 13 from day one. SELECT is membership-scoped (a colleague must be able to
-- answer "did we send it?"); there is deliberately NO insert, update or delete
-- policy, so the only path to a row is through §3's RPCs. No public policy — a
-- guest's email address and stay reference must never reach an anon reader.

alter table statement_emails enable row level security;

drop policy if exists statement_emails_member_select on statement_emails;
create policy statement_emails_member_select on statement_emails
  for select to authenticated
  using (tenant_id = any(get_tenant_ids()));


-- ############################################################################
-- SECTION 3 — the two writes
-- ############################################################################

-- ----------------------------------------------------------------------------
-- 3.1 claim_statement_email — take the right to send, once
-- ----------------------------------------------------------------------------
-- Returns the row plus whether THIS call created it. The caller sends the email
-- only when claimed is true; when it is false another attempt under the same key
-- already owns the send, and its status says what became of it.
--
-- THE GATE IS TWO CHECKS, NOT ONE:
--   * is_tenant_staff(tenant) — an active member of the tenant that owns the
--     property (015 §6.5 / 023 §1). Emailing a bill is a staff act.
--   * property_id = any(get_property_ids()) — the caller's OWN property grants,
--     the same set the admin resolves its property switcher from
--     (lib/fetchAccessibleProperties). Rule 19's shape: RLS alone would let a
--     multi-property user act on a property they were never granted, because
--     get_tenant_ids() returns every tenant they belong to.
-- The tenant is DERIVED from the property row, never accepted as a parameter:
-- a caller who could pass their own tenant_id could bind a row to a tenant the
-- property does not belong to.
create or replace function claim_statement_email(
  p_property_id        uuid,
  p_subject_kind       text,
  p_booking_id         uuid,
  p_guest_id           uuid,
  p_document_reference text,
  p_to_email           text,
  p_idempotency_key    text
)
returns table (
  claim_id            uuid,
  claim_status        text,
  claim_to_email      text,
  claim_created_at    timestamptz,
  claimed             boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant   uuid;
  v_timezone text;
  v_date     date;
  v_actor    uuid := auth.uid();
  v_email    text := btrim(coalesce(p_to_email, ''));
  v_row      statement_emails;
begin
  if v_actor is null then
    raise exception 'Not authenticated' using errcode = 'insufficient_privilege';
  end if;

  select p.tenant_id, p.timezone into v_tenant, v_timezone
  from properties p
  where p.id = p_property_id and p.deleted_at is null;  -- rule 5

  if v_tenant is null then
    raise exception 'That property does not exist' using errcode = 'no_data_found';
  end if;

  if not is_tenant_staff(v_tenant) or not (p_property_id = any(get_property_ids())) then
    raise exception 'You do not have access to this property'
      using errcode = 'insufficient_privilege';
  end if;

  if p_idempotency_key is null or btrim(p_idempotency_key) = '' then
    raise exception 'An idempotency key is required'
      using errcode = 'check_violation';
  end if;

  -- The address is validated HERE as well as in the browser and the endpoint,
  -- because this is the only one of the three a caller cannot skip. The CHECK
  -- constraint would refuse it anyway; this raises the message a person can act
  -- on instead of a constraint name.
  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'That does not look like an email address: %', v_email
      using errcode = 'check_violation',
            hint = 'Check the address with the guest and try again.';
  end if;

  if coalesce(btrim(p_document_reference), '') = '' then
    raise exception 'A document reference is required'
      using errcode = 'check_violation';
  end if;

  -- The property's operating day (§6, rules 8/12), derived the same way every
  -- other business_date in this schema is.
  v_date := (now() at time zone
              coalesce(nullif(btrim(v_timezone), ''), 'Africa/Lagos'))::date;

  -- SECURITY DEFINER, so auth.uid() inside the trigger still resolves to the
  -- caller — but §6 requires such RPCs to set the actor explicitly rather than
  -- rely on that, and this row's whole value is knowing who sent it.
  insert into statement_emails (
    tenant_id, property_id, subject_kind, booking_id, guest_id,
    document_reference, to_email, provider, status, business_date,
    idempotency_key, created_by
  )
  values (
    v_tenant, p_property_id, p_subject_kind, p_booking_id, p_guest_id,
    btrim(p_document_reference), v_email, 'resend', 'sending', v_date,
    p_idempotency_key, v_actor
  )
  on conflict (tenant_id, idempotency_key) where idempotency_key is not null
    do nothing
  returning * into v_row;

  if found and v_row.id is not null then
    return query select v_row.id, v_row.status, v_row.to_email, v_row.created_at, true;
    return;
  end if;

  -- Somebody else got there first (a double-click, a retried request). Hand back
  -- THEIR row: the caller must report that attempt's outcome, not start a second
  -- one.
  select * into v_row
  from statement_emails
  where tenant_id = v_tenant and idempotency_key = p_idempotency_key;

  if v_row.id is null then
    -- Unreachable in practice: the insert conflicted, so a row with this key
    -- exists in this tenant. Raised rather than returning a null row, because a
    -- silent null here would let the endpoint send an email it never claimed.
    raise exception 'The send could not be claimed'
      using errcode = 'internal_error';
  end if;

  return query select v_row.id, v_row.status, v_row.to_email, v_row.created_at, false;
end;
$$;

comment on function claim_statement_email(uuid, text, uuid, uuid, text, text, text) is
  'Claims the right to email one statement, under the caller''s idempotency key. '
  'Returns claimed = true only for the call that created the row; every other '
  'caller under the same key gets the existing row and must NOT send. Staff-gated '
  'via is_tenant_staff() plus the caller''s own get_property_ids() grants.';

revoke execute on function claim_statement_email(uuid, text, uuid, uuid, text, text, text) from anon;

-- ----------------------------------------------------------------------------
-- 3.2 complete_statement_email — record what the provider said
-- ----------------------------------------------------------------------------
-- Only a 'sending' row may be completed, and only into 'sent' or 'failed'. An
-- outcome is therefore written once and can never be rewritten — a 'failed' send
-- cannot be quietly upgraded to 'sent' by a later call, which is the property
-- that makes this table worth reading in a dispute.
create or replace function complete_statement_email(
  p_id                  uuid,
  p_status              text,
  p_provider_message_id text,
  p_error_message       text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row   statement_emails;
  v_actor uuid := auth.uid();
begin
  if v_actor is null then
    raise exception 'Not authenticated' using errcode = 'insufficient_privilege';
  end if;

  if p_status not in ('sent', 'failed') then
    raise exception 'A send completes as sent or failed, not %', p_status
      using errcode = 'check_violation';
  end if;

  select * into v_row from statement_emails where id = p_id;
  if v_row.id is null then
    raise exception 'That send record does not exist' using errcode = 'no_data_found';
  end if;

  if not is_tenant_staff(v_row.tenant_id)
     or not (v_row.property_id = any(get_property_ids())) then
    raise exception 'You do not have access to this property'
      using errcode = 'insufficient_privilege';
  end if;

  -- Not an error worth failing the request over: the email either went or it did
  -- not, and that outcome is already recorded. Returning quietly keeps a retried
  -- completion from turning a successful send into a red toast.
  if v_row.status <> 'sending' then
    return;
  end if;

  update statement_emails
  set status              = p_status,
      provider_message_id = nullif(btrim(coalesce(p_provider_message_id, '')), ''),
      -- The failure's own words, capped so a provider that returns an HTML error
      -- page cannot bloat the row. Cleared on success.
      error_message       = case
                              when p_status = 'failed'
                                then left(nullif(btrim(coalesce(p_error_message, '')), ''), 1000)
                              else null
                            end,
      updated_by          = v_actor
  where id = p_id;
end;
$$;

comment on function complete_statement_email(uuid, text, text, text) is
  'Records the provider''s outcome against a claimed send. Only a ''sending'' row '
  'may be completed, so an outcome is written once and never rewritten. '
  'Staff-gated exactly as claim_statement_email.';

revoke execute on function complete_statement_email(uuid, text, text, text) from anon;
