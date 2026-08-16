# CLAUDE.md — Palstro-Hotels

Repo-root operating manual. Read this before writing any code. Every PR is
reviewed against it. These are rules, not suggestions — most exist because the
matching bug already cost us real money on Palstro.

---

## 1. Project summary

Palstro-Hotels is a **multi-tenant Hotel Property Management System (PMS)** for
Nigerian hotels. It covers end-to-end operations (rooms, F&B, housekeeping,
laundry, maintenance, guest folios, accounting) plus a customer-facing website
with online booking.

- **Stack:** React + TypeScript + Vite, deployed on Vercel, backed by Supabase
  (Postgres + Auth + Storage + RLS).
- **First tenant:** Heledon Hotels and Suites — a 30-room family-friendly
  property in Finima, Bonny Island, Rivers State. Paying customer, 12-week
  delivery. Their guest site must feel warm and family-friendly, but the theme
  system is tenant-configurable for future hotels.

Separate product from Palstro (the ERP): separate codebase, Supabase project,
Vercel deployment, auth, and data. They share patterns and standards only.

**System map:** [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) is the whole-system
map — the four layers (foundation / configuration / operations / financial), the
three shared engines (inventory, folio, ledger), the hard dependency order, and
the revised module build sequence. **Read it before starting any new module** so
the module lands in the right layer, hangs off the right engine, and is built in
the right order.

---

## 2. Engineering non-negotiables (20)

Every one of these came from a real bug on a prior product. They are binding.

### 1. Every list read is bounded correctly — two cases, split below
A bounded query with no way to reach the rest is **worse** than an unbounded one:
an unbounded query at least breaks loudly at the row cap, while a hard
`.limit(100)` with no pager quietly lies — older rows are silently unreachable,
nothing errors or warns, and the screen looks correct. This shipped on the sister
product, Palstro ERP: sales, purchases, journal and contacts each capped at
50–200 rows with no pagination at all, and older records simply vanished off the
end. So a hard `.limit()` on a user-facing list is a **defect, not a performance
optimisation** — the failure was never "we forgot to paginate", it was "we capped
and moved on". The two cases below are enforced separately because they fail
differently.

**Rule 1a — internal fetches (unchanged).** Any query whose result the code
consumes in full uses the `fetchAllPaged` helper. No unbounded reads; never a
bare `.in()` on an unbounded list; never a multi-row `SELECT` without `.range()`
for anything that can grow.
*Why: unbounded queries silently truncate at Supabase's row cap and quietly
return wrong data.*
```ts
async function fetchAllPaged<T>(
  build: (from: number, to: number) => PostgrestFilterBuilder<any, any, T[]>,
  page = 1000,
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += page) {
    const { data, error } = await build(from, from + page - 1);
    if (error) throw error;
    if (!data?.length) break;
    rows.push(...data);
    if (data.length < page) break;
  }
  return rows;
}
```

**Rule 1b — user-facing list surfaces.** A screen showing rows to a person is
never capped without controls to reach the rest. Every such surface provides:

- **Server-side pagination** via `.range()` with an exact `count` — never a
  client-side slice of a capped fetch.
- An **always-visible page-of-N display**, so the user can see there are more
  pages.
- **Jump to first and last**, and **direct entry of a page number**.
- A **page size selector**.
- **Filters applied server-side**, so paging through a filtered set is correct
  rather than paging then filtering.

*Why: a bounded list with no pager makes older records silently unreachable — the
screen looks correct while lying about what exists (the Palstro ERP bug above).*

### 2. Every write RPC accepts and uses `p_idempotency_key`
Booking creation, folio charges, payment recording — everything. No exceptions.
*Why: retries and double-clicks must not create duplicate bookings, charges, or
payments.*
```sql
create function create_booking(
  p_tenant_id uuid,
  p_payload   jsonb,
  p_idempotency_key text
) returns bookings as $$
  -- first look up by (tenant_id, idempotency_key); return the existing row
  -- if found, otherwise insert.
$$ language plpgsql;
```

### 3. Every `idempotency_key` column has a partial unique index from day one
Enforce uniqueness at the DB, not in app code. No dormant 23505 handlers waiting
for an index that never shipped.
*Why: without the constraint, concurrent writes race past the app-level check.*
```sql
create unique index bookings_idem_uniq
  on bookings (tenant_id, idempotency_key)
  where idempotency_key is not null;
```

### 4. Every account resolved via `account_mappings`, never hardcoded codes
Chart of accounts is per-tenant and configurable. Look accounts up by role key.
*Why: hardcoded account codes break the moment a tenant's CoA differs from
Heledon's.*
```ts
const ar = await resolveAccount(tenantId, 'accounts_receivable'); // not '1200'
```

### 5. Void/posted filters are NULL-safe — in opposite directions
The two flags are NOT symmetric. Get the direction right for each:

- **Voids — include NULL.** "Not voided" means every row that is not explicitly
  voided, and an un-set flag counts as not-voided. Use
  `.not('is_voided', 'is', true)`, never `.eq('is_voided', false)` (which drops
  NULL rows).
- **Posted — exclude NULL.** "Posted only" means the flag is genuinely `true`; a
  NULL is an un-posted/unknown row and must be excluded. Use
  `.eq('is_posted', true)`, never `.not('is_posted', 'is', false)` (which would
  pull NULL rows *in*).

*Why: NULL-safety runs the opposite way for the two flags. For `is_voided` a
NULL should be kept (treated as not-voided); for `is_posted` a NULL should be
dropped (treated as not-posted). A single "same for both" filter is wrong for
one of them.*
```ts
// exclude voided rows, keeping rows where the flag was never set
query.not('is_voided', 'is', true);

// keep only genuinely-posted rows, dropping NULLs
query.eq('is_posted', true);
```

### 6. Cache columns forbidden unless justified
If you cache a balance, you snapshot the invalidation logic in the same PR and
write the recompute function alongside it.
*Why: an un-recomputable cache column drifts from truth and can't be repaired.*

### 7. Cancel/reversal RPCs update all three data stores in lockstep
Ledger, cache, and any denormalized columns — together, in one transaction. No
`GREATEST(0, ...)` floors on cache decrements, no null-warehouse skips.
*Why: partial reversals leave the ledger and the cache permanently disagreeing.*

### 8. Ledgers sort by business date (`entry_date`), not `created_at`
Show a separate **Posted** column for `created_at` when it differs.
*Why: back-dated and late-posted entries land in the wrong order and break the
audit trail.*
```ts
query.order('entry_date', { ascending: true });
```

### 9. Every ledger has a documented "reconciles to" invariant
State it in code. Aged Debtors reconciles to Contacts; Chart-of-Accounts AR
reconciles to Contacts; every summary reconciles to something upstream.
*Why: a number nobody can reconcile is a number nobody can trust.*
```ts
// INVARIANT: sum(aged_debtors.balance) === sum(contacts.ar_balance) per tenant.
```

### 10. Every payment/settlement screen starts empty
No auto-fill of balance due. The user types the amount.
*Why: pre-filled amounts produce false-positive full payments the user never
verified.*

### 11. Every write wrapped in a real transaction with error handling
No fire-and-forget promises. Always `await`, always `try/catch`, always surface
the error to the user.
*Why: silent write failures corrupt data and leave the user believing it saved.*
```ts
try {
  const { error } = await supabase.rpc('record_payment', args);
  if (error) throw error;
} catch (e) {
  toast.error(humanize(e)); // never swallow
  throw e;
}
```

### 12. Every user-facing status uses date-of-truth (business date)
Booking dates, folio dates, F&B order dates — the business date, not the
creation timestamp.
*Why: creation timestamps misreport what happened on which operating day.*

### 13. RLS policies from day one on every table
Not "we'll add it later." Includes explicit public-read policies for
guest-facing storefront data.
*Why: one table shipped without RLS leaks every tenant's data.*

Tenant scoping in RLS uses a **`tenant_users`-table lookup**, reusing the
pattern already running in production on Palstro (the ERP). We do **not** use
JWT `tenant_id` claims. The canonical helper — use it verbatim; every part is
load-bearing:
```sql
CREATE OR REPLACE FUNCTION get_tenant_ids()
RETURNS uuid[]
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN COALESCE(ARRAY(
    SELECT tenant_id FROM tenant_users
    WHERE user_id = auth.uid() AND is_active = TRUE
  ), '{}');
END;
$$;
```
Why each part matters:
- **Returns `uuid[]` (an array)** — a user can belong to multiple tenants.
- **`SECURITY DEFINER`** — avoids recursive RLS evaluation on `tenant_users`
  (the policy would otherwise re-invoke itself while checking that table).
- **`STABLE`** — lets Postgres cache the result within a single statement
  instead of re-running the lookup once per row.
- **`SET search_path = public`** — guards against search_path injection.
- **`COALESCE(..., '{}')`** — a NULL array makes `= ANY(...)` return NULL
  rather than FALSE, which fails **open**. The empty-array fallback keeps an
  unmatched user locked out.
- **`plpgsql`, not `sql`** — table references resolve at runtime, so the
  function compiles even when `tenant_users` does not yet exist at creation
  time.

Policies scope with `tenant_id = ANY(get_tenant_ids())`:
```sql
alter table bookings enable row level security;
create policy tenant_isolation on bookings
  using (tenant_id = ANY(get_tenant_ids()));
```

### 14. "Export All Data" from day one
Any tenant can download their full dataset as JSON/CSV.
*Why: customer trust and continuity — their data must be theirs to take.*

### 15. Automated Supabase backups from day one
Daily backup to a separate location (S3 or similar). Not "later."
*Why: a single-region DB with no off-site backup is one incident from total
loss.*

### 16. Every dashboard summary shows how it was calculated
A small info tooltip, e.g. "Includes finalized invoices only. Excludes returns
and voids."
*Why: an unexplained number gets distrusted and second-guessed.*

### 17. No hardcoded tenant strings anywhere
Not a hotel name, not brand colors, nothing tenant-specific. All from
`tenant_settings`.
*Why: any hardcoded tenant value breaks the multi-tenant promise the instant a
second hotel joins.*
```ts
const name = settings.hotel_name;      // never "Heledon"
const brand = settings.colors.primary; // never a literal hex in a component
```

### 18. Multi-tenant coding rules live in this CLAUDE.md
Same convention as Palstro. Reviewed before every PR.
*Why: rules that aren't written down aren't followed.*

### 19. RLS is the floor, not the ceiling
Because `get_tenant_ids()` returns **every** tenant the user belongs to, RLS
alone lets a multi-tenant user read rows from all of their tenants at once.
Every application query must **additionally** scope to the single active tenant
held in tenant context (`.eq('tenant_id', activeTenantId)`).
*Why: the two layers guard different things. RLS prevents cross-tenant leakage
between different users; the active-tenant filter prevents blending data across
a single user's own tenants. Neither replaces the other.*
```ts
// RLS already restricts to the user's tenants; still scope to the active one:
query.eq('tenant_id', activeTenantId);
```

### 20. Aggregates and exports span the filter, not the page
Two things sit beside a list (rule 1b) and are routinely got wrong. Both must be
computed across the **whole filtered set**, never the visible page:

- **Totals and summary figures** are computed server-side across every row
  matching the current filter, never summed from the visible page. A user who
  filters by date range and reads a total expects the total for that range; a
  page-derived total is a wrong number presented with confidence, which is worse
  than no number.
- **Export** returns every row matching the current filter, across all pages.
  Filters apply; pagination does not. Someone who filters and clicks Export wants
  their filtered set, not the twenty rows they happen to be looking at.

*Why: a figure or export silently scoped to the current page misreports the data
the user actually asked for.*

Cross-references rule 16: as a dashboard number carries a tooltip of what it
includes and excludes, a list total needs the same — and the tooltip must state
that it covers the **whole filtered set, not the page**.

---

## 3. Multi-tenancy model

- **One codebase, one Supabase project, one Vercel deployment** shared by all
  tenants. Standard SaaS pattern.
- **`tenant_id` scoping:** every domain table carries a `tenant_id`. Every query
  is scoped to it.
- **RLS enforced at the database level:** isolation is a Postgres policy, not app
  code, so it cannot be bypassed by a forgotten `.eq()`.
- **Tenant resolution:**
  - *Guest-facing sites → URL-based.* The host/slug identifies the tenant
    (e.g. `heledonhotels.com` → Heledon), and the visitor sees that tenant's
    storefront. Storefront reads run through public-read RLS policies.
  - *Admin → user-based.* The user logs in; their tenant memberships come from
    a `tenant_users`-table lookup, and the active tenant loads into tenant
    context. RLS derives the user's tenants via `get_tenant_ids()` — a
    `tenant_users` lookup, not a JWT claim. See Rule 13.
- **Config split — tenant vs property:** `tenant_settings` holds only genuinely
  company-wide values the accounting module reads (e.g. `default_vat_rate`;
  Nigerian VAT is federal). `property_settings` holds everything the guest site
  renders (template, `booking_enabled`, and a `branding` JSONB of colors, logo,
  hero images, fonts, tagline, section visibility/order). Rule of thumb:
  **anything a guest sees is property-level; anything accounting reads is
  tenant-level.** Every tenant and every property is guaranteed a settings row
  by an `AFTER INSERT` trigger, so no query ever handles a missing settings row.
- **No client path to create tenants or grant membership.** Neither `tenants`
  nor `tenant_users` has an insert policy, by design. During early operation the
  operator creates tenants and adds members manually via the SQL editor; this
  will later move to `SECURITY DEFINER` RPCs with an audit trail. Do not add an
  insert policy to either table until that RPC exists.
- **RLS enforces both tenant isolation and role-gated writes at the database
  level.** Reads are membership-scoped; destructive writes (update/delete of
  tenants, properties, and settings) additionally require an admin role via
  `is_tenant_admin()`. Application-level permission checks are for user
  experience only and are **never** the sole guard on a destructive action.

---

## 4. Project structure conventions

```
src/
  components/   Reusable UI components (presentational + small stateful widgets)
  pages/        Route-level views (guest-facing and admin screens)
  hooks/        Custom React hooks (data fetching, tenant context, auth)
  lib/          Clients, helpers, cross-cutting utilities (supabase.ts lives here)
  types/        Shared TypeScript types (DB row types, domain models, API shapes)
  assets/       Static bundled assets
supabase/
  migrations/   SQL migrations (schema, RLS policies, RPCs) — source of truth
  config.toml   Supabase CLI config
public/         Static files served as-is
```

- Tenant-configurable values are read from `tenant_settings` via the tenant
  context/hook — never imported as constants.
- DB row types live in `src/types`; keep them in sync with migrations.

---

## 5. Naming conventions

**Migrations** — one concern per file, **sequential three-digit numbering**
(matches Palstro). No timestamp prefixes.
```
supabase/migrations/NNN_<snake_case_description>.sql
# e.g. 001_initial_tenancy.sql
#      002_rooms_and_rates.sql
```
Numbers are assigned in strict order and never reused.

**RPCs** — `snake_case`, verb-first, tenant-aware, idempotent on writes:
- Parameters prefixed `p_` (e.g. `p_tenant_id`, `p_payload`, `p_idempotency_key`).
- Write RPCs always take `p_idempotency_key` (see rule 2).
- Examples: `create_booking`, `record_payment`, `post_folio_charge`,
  `cancel_reservation`, `resolve_account`.

---

## 6. Schema & data conventions

These apply to every migration and every table. They match Palstro.

**Money.** All monetary columns are `numeric(14,2)`. Never `float` / `double
precision`, never money in JSONB. *Floating point can't represent currency
exactly; JSONB money can't be validated, constrained, or aggregated by the DB.*

Postgres `numeric` columns are returned by PostgREST as **strings**, never
JavaScript numbers (this preserves the exact precision a JS `number` would lose).
Type them as `string` in row types and parse explicitly (`parseNumeric`) before
any arithmetic or comparison. Never rely on implicit coercion — `typeof col ===
'number'` is always false, and `Number(col)` hidden inside a template literal is
a silent bug waiting to happen.

**Missing values.** When a formatter cannot produce a value (missing or
unparseable input), it returns the shared `MISSING_VALUE` em-dash (`—`) from
`src/lib/format.ts`, never an empty string. An empty string renders as a silent
gap that looks like a layout bug and signals nothing; a visible dash reads as "no
value", the way accounting reports show it. Every formatter uses the same
placeholder so a missing number looks identical everywhere in the app.

**Quantities.** All quantity columns are `numeric(14,4)`. Four decimals, not
two, because recipe ingredients (0.0250 kg per plate) and bar shot measures are
fractional. Rounding to 2 dp introduces drift that destroys the variance
reports the system exists to produce.

**Cost of sale is READ, never recomputed.** When stock leaves, what it cost is
written onto the movement (`stock_movements.carried_unit_cost`) at that instant,
and every consumption figure, food-cost report and P&L line reads that column.
Nothing re-derives it from the movement history. *Why: a moving average is
path-dependent, so the cost of an issue is knowable only at the moment it
happens — one more receipt and the fold produces a different number. A report
that recomputes will disagree with the one that read, and neither will be
reproducible. This is the same principle as `booking_nights` locking the nightly
rate: a fact captured when it was true.* This does **not** make it a cache under
rule 6 — a cache stores something also derivable now and must ship a recompute
function; this stores something derivable **only** at write time, and there is
deliberately no recompute function because a correct one cannot exist.

**Business date.** Every operational table (something that *happened*) carries
`business_date date not null`, separate from `created_at timestamptz`. Hotels
run a night audit, so a bar sale at 02:00 belongs to the previous business day.
All reports, ledgers, and dashboards group by `business_date`; `created_at` is
audit metadata only and is never the basis for a user-facing figure. Reinforces
rules 8 and 12.

**Actor columns.** Every table carries `created_by uuid references
auth.users(id)` and `updated_by uuid references auth.users(id)`. **Audit columns
are enforced by the shared `set_row_audit()` trigger, never trusted from the
client, and no table may opt out** — a client that sends its own
`created_by`/`updated_by` has it overwritten. The trigger fires `before insert
or update` and is the actual mechanism; the column defaults are belt-and-braces.
On INSERT it forces `created_at`/`created_by` (`coalesce(auth.uid(),
new.created_by)`); on UPDATE it forces `updated_at`/`updated_by` and pins
`created_at`/`created_by` back to their OLD values, so an update can never
rewrite who created a row. The `coalesce(auth.uid(), ...)` preserves an explicit
actor only when there is no session (a `SECURITY DEFINER` RPC or service_role),
and **those RPCs must set the columns explicitly** because `auth.uid()` inside
them resolves to the caller, not the intended actor. The customer's primary pain
is staff theft, so "who did this" must be answerable for every row — an audit
column the actor could set themselves would make the theft-detection reports
worthless. *(An immutable, insert-only join table carries `created_by` only and
gets an INSERT-only trigger; `updated_by` stays NULL until first update — NULL
means "never edited".)*

**Timestamps.** Every table carries `created_at` and `updated_at timestamptz`.
`updated_at` (and `updated_by`) are maintained by the shared `set_row_audit()`
trigger, never by application code.

**Soft delete.** Records are never hard-deleted. Use `is_voided boolean` for
transactional records and `deleted_at timestamptz` for master data. Filters
stay NULL-safe per rule 5.

**Document numbering.** Booking, invoice, receipt, and similar numbers are
generated by a `SECURITY DEFINER` function backed by a per-tenant counter
table — never by counting rows and adding one. Unique per tenant per document
type. *Row-counting races under concurrency and reuses numbers after voids.*

**Storage paths.** Every uploaded file is stored under
`{tenant_id}/{property_id}/{category}/{size}/{filename}`. No file is ever written
to a bucket root. Storage RLS parses the `tenant_id` from the first path segment
to gate writes, so a malformed first segment fails closed.

**Storage files and their `media_assets` row are deleted together, ALWAYS.** A
file is only ever created alongside its row and only ever removed alongside it
(remove the objects first, then soft-delete the rows — see `deleteMediaAsset`).
*Why: a file with no row is invisible — no screen lists it, the quota never
counts it — yet it bills egress forever. The row is the only handle we have on
the bytes; lose it and the file is unrecoverable dead weight on the bill.*

**Property scoping.** A tenant is a company; a property is a physical hotel.
Operational tables carry `property_id` in addition to `tenant_id`. Reports may
aggregate across properties within a tenant, but operational screens are always
scoped to one property. Property access is resolved via `get_property_ids()`
alongside `get_tenant_ids()`; role-gated writes use `is_tenant_admin()`.

**Composite-key consistency.** Where a table carries both `tenant_id` and a
parent reference (a `property_id`, or a `room_type_id` that implies a property),
consistency between them is enforced by a **composite foreign key** pointing at
a unique key on the parent's paired columns — never by application discipline.
*A row whose `tenant_id` disagrees with its parent's tenant is a cross-tenant
leak that RLS cannot detect, because every policy trusts `tenant_id` directly.*
The parent gets a `unique (id, tenant_id)` (or `unique (id, property_id)`) to
serve as the FK target.
```sql
-- child binds the pair to the parent instead of two independent FKs:
foreign key (property_id, tenant_id) references properties (id, tenant_id)
```
**Warning — soft-deleted parents do not cascade.** The FK cascade fires only on
a *hard* delete; setting `deleted_at` on a room type leaves its rooms pointing at
a still-present but deleted parent. Every query that joins `rooms` to
`room_types` (or any child to a soft-deleted parent) must filter the parent's
`deleted_at` itself, NULL-safe per rule 5 (`deleted_at is null`).

**Pagination is a shared component, built once before the first list screen.**
No list surface (rule 1b) ships until a single reusable `Pagination` component
exists, and every list then uses it. Building it per screen guarantees four
different behaviours and four separate places to fix the next bug — the same
reason the settings framework was built before any settings tab. `change_log` is
where this bites hardest: it grows **without bound by design**, so its viewer
cannot ship with a cap and is the clearest reason to have the component ready
first.

---

## 7. Before-you-write-code checklist (run every session)

1. **Read this file.** Confirm the 19 non-negotiables are fresh in mind.
   **Starting a new module?** Read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
   first — the system map, shared engines, and dependency order that decide where
   the module fits and what must exist before it.
2. **Does this touch a new table?** Add `tenant_id` + enable RLS + write the
   isolation policy in the same migration (rule 13).
3. **Is this a list query?** Paginate it — no unbounded `.in()` / no `SELECT`
   without `.range()` (rule 1).
4. **Is this a write RPC?** It takes `p_idempotency_key` and has a partial
   unique index (rules 2, 3), runs in a transaction, and surfaces errors
   (rule 11).
5. **Filtering voided/posted rows?** Use the correct NULL-safe filter for each:
   `.not('is_voided', 'is', true)` for voids, `.eq('is_posted', true)` for
   posted-only (rule 5).
6. **Touching money or accounts?** Resolve via `account_mappings`; sort ledgers
   by `entry_date`; document the reconciles-to invariant (rules 4, 8, 9).
7. **Any tenant-specific value?** It comes from `tenant_settings`, not a literal
   (rules 17, 4).
8. **Adding a cache/denormalized column?** Justify it, ship the recompute
   function, keep cancel/reversal in lockstep (rules 6, 7).
9. **Showing a summary number?** Add the "how this was calculated" tooltip
   (rule 16).
10. **Handle the edge cases:** empty, error, loading, network-drop, concurrent
    actions — with clear user-facing messages. No silent failures.

---

## 8. Design conventions

- **Contrast is a property of the token, not the component.** Every foreground
  and background pairing must clear WCAG AA: **4.5:1 for normal text, 3:1 for
  large text** (>=24px, or >=18.66px bold). Contrast is checked **when a token
  is defined, not when a component is reviewed** — each color token in
  `src/index.css` documents, beside its declaration, which foregrounds are safe
  on it (and at what measured ratio), so building a component never requires
  recomputing contrast. If a new pairing is needed, prove it at the token and
  record the ratio there.
