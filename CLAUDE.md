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

## 2. Engineering non-negotiables (29)

Every one of these came from a real bug — most from a prior product, the last
nine from this one. They are binding.

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

### 21. Errors belong to the database — the client shows them, never authors them
A refusal is raised where the rule lives. The **message carries the rule**, the
**hint carries the way out**, and the client renders both verbatim and writes
neither.
*Why: a UI that restates a rule is a second source of truth, and it drifts the
first time the rule changes — silently, because nothing errors.*

Dropping the hint is the subtle half of this, and it is what makes the rule
achievable rather than aspirational: a refusal shown without its hint says "no"
without "instead", and the pressure is then to write the "instead" into a
component. Every error helper appends the hint.
```ts
const message = err?.message?.trim();
const hint = err?.hint?.trim();
return hint ? `${message} — ${hint}` : message;  // never re-worded
```

### 22. A screen needs a render proof, and the proof must have been made to fail
SQL proofs cannot render React. Any shipment that touches a surface ships a
render proof of the **real component** (extract a seam rather than copy it), and
that proof is not trusted until it has been made to fail against the bug it
claims to catch.
*Why: 1.1c shipped with forty passing SQL wiring proofs and a screen that
crashed on first render. `pg` returns int8 AND numeric alike as strings;
PostgREST returns int8 as a JSON **number** and numeric as a **string**. Only the
browser ever sees the second mapping, so no amount of SQL can catch a formatter
that assumes the first. Every green proof was honest and the screen was still
broken.*
```bash
npm run proof:render   # proofs/ledgerRender.tsx
```
A corollary that follows from the same fact: **never re-narrow a boundary value's
type.** `parseNumeric` accepts `string | number | null | undefined` because that
is the full range PostgREST emits; a helper that narrows its own parameter back
to `string` and then trusts the narrowing at runtime is the exact defect above.

### 23. Popovers are never clipped, and every action is reachable
Any floating layer — kebab menu, dropdown, tooltip, date picker, autocomplete —
renders in a **portal to `document.body`** and is positioned against its trigger.
It is **never a child of a scrolling or overflow-hidden container**. It closes on
outside click, on Escape and on ancestor scroll, returns focus to the trigger,
and **flips above the trigger when there is no room below**.
*Why: a menu whose items cannot be reached is the same defect as a button that
does nothing. The kebab on a stock count row opened and was cut in half — it was
an absolutely-positioned child of the table's `overflow-x-auto` wrapper, so the
wrapper clipped it. Four other menus in this codebase had the identical markup,
which makes it the pattern rather than one screen's mistake.*

**Do not fix this with `overflow: visible` on the parent.** It fixes one screen,
leaves the next one broken, and usually breaks the scrolling the parent needed —
the wrapper's overflow is what lets a wide table scroll sideways at 360px. There
is also no single parent to fix: the clipping ancestor is whichever one happens
to have overflow, and that changes as layouts change, silently.

A second symptom travels with this one and is routinely misread as a table-width
problem: **an absolutely-positioned child still contributes to its scroll
container's `scrollWidth`**, so an overhanging menu grows a horizontal scrollbar
on the card it sits in. Portalling the panel removes the scrollbar too. If a card
has a scrollbar it should not have, look for a floating layer inside it before
touching the table's widths.

```tsx
// One primitive owns the behaviour; each menu keeps its own look.
<Popover open={open} onClose={close} anchor={trigger} align="right" role="menu">
```
The anchor is held in **state via a callback ref**, never read from a ref during
render — React does not re-render when `.current` changes, so the popover would
position against whatever was there on the previous pass.

**Every action must be reachable at 1366×768 and at 360px wide.** The last row of
a table is the case that breaks, so it is the case to check — both in the render
proof and on the live site.

### 24. Parse at the boundary
PostgREST returns `numeric` as a **string**, and `int8`, `float` and JSON nulls as
**numbers**. Every read parses its numeric fields **once, in the data layer**, into
the type the app declares. **No component may call a string method on a value that
came from the database.** This has caused three identical crashes; the fix is the
boundary, never the call site.

*Why: the shape a numeric arrives in is decided by a column type and by casts
inside a view — `stock_take_progress` casts its counts to `integer` so they arrive
as numbers while the quantities beside them stay strings — and none of that is
visible from a component. A row type that describes the transport is a guess that
nothing re-checks, so it is right until the day a migration changes and then it is
wrong silently. The three crashes (`signedQuantity` in the item ledger,
`counted_quantity` in the count sheet, `row.quantity` in the adjustments list) were
the same bug at three call sites, and fixing a call site leaves the next one
waiting.*

The rule in four parts:

1. **The row types stop claiming `string` for something that arrives as either.**
   If a field is a number in the app, type it `number` and parse it on the way in.
   A string method on it is then a **compile error**, not a crash a storekeeper
   finds.
2. **Every read goes through `boundary<T>()`** (`src/lib/rowParse.ts`) — a select,
   an RPC's return, a jsonb payload, an embed. `fetchAllPagedRows` is the paged
   form, `scalarNumber` the one for an RPC that returns a bare numeric.
3. **The field lists are checked by the compiler.** `boundary<T>()` demands every
   numeric key of `T`, split by nullability; add a numeric column and the build
   fails, naming the field. A read with no numeric column declares
   `passthrough<T>()` — which itself refuses to compile if `T` turns out to have
   one. **No read is exempt by judgement**, because that is how the next one gets
   missed.
4. **Then delete the defensive parses.** A `parseNumeric` on a value the data layer
   already parsed is a second source of truth about the shape; keep the ones
   parsing genuine input (a form field) and the ones inside formatters.

```ts
// The declaration IS the check — this fails to compile until every numeric is listed.
const movementRows = boundary<StockMovement>('stock_movements')(
  ['seq', 'quantity'] as const,   // required — a missing one throws, naming the read
  ['unit_cost'] as const,         // nullable — null stays null, never 0
);
```
A required numeric that arrives absent or unparseable **throws**, and the fetch's
existing error path carries it to the user (rule 11). The two alternatives are
worse: a 0 is a wrong figure presented with confidence, and a NaN spreads through
every total it touches without erroring.

### 25. Screens are for doing, the guide is for explaining
**One line of purpose per page, then the controls.** Longer explanation lives
behind a single ⓘ and in [`docs/USER-GUIDE.md`](docs/USER-GUIDE.md). **No
paragraphs under buttons, no prose inside tables**, and field hints only where a
label genuinely cannot carry the meaning. Write the explanation as well as you
like — then put it where someone can choose to read it.

*Why: a screen that teaches is teaching the wrong person. The person who opens the
stock take came to work, and they read the same three paragraphs every morning
until they stop reading anything on the page — including the sentence that
mattered. The reasoning is not lost when it moves; it becomes findable in a second
by the one person who wants it, and invisible to the fifty who do not.*

**THIS IS THE DEFAULT FOR EVERY PAGE FROM HERE, NOT A CLEAN-UP THAT HAPPENED
ONCE.** A new screen is built this way on its first commit; it is not written
long and tidied later, because the tidying never gets scheduled and the reviewer
who would have asked for it is reading a diff, where three paragraphs look like
care.

### The shape, which is a component and not a convention

Every screen's top is `<ScreenHeader>` (`src/components/ui/ScreenHeader.tsx`).
Hand-rolling a header is how the Stock Take tab reached six things to read before
the first button, one helpful addition at a time.

```tsx
<ScreenHeader
  title="Bookings"                                   // a noun
  purpose="Every reservation for this property."     // ONE sentence
  about={{ title, paragraphs, guideAnchor, guideLabel }}  // the ⓘ
  propertySlug={propertySlug}
  actions={<Link …>New booking</Link>}               // level with the title
/>
```

The component enforces what the rule asks for: `purpose` is one string, so there
is nowhere to put a second paragraph; `about` cannot be given without a guide
anchor, so a panel always says where the rest of it is; `actions` sit beside the
title, so the thing you came to press is never below a wall of text. A tab is its
own screen to the person using it — `level={2}`, same shape, smaller type.

### In practice

- **The ⓘ is one icon, one panel, all of it.** Not three tooltips in three places.
  It links to the matching section of the guide, so the panel can stay short.
- **A paragraph under a button means the label is wrong.** Fix the label.
- **A field hint earns its place or goes.** "Count date — the day you walked the
  shelves" earns it. "A count covers one location's shelves" does not; the label
  already said Location.
- **Tables show headings and values.** Nothing else, and nothing above them.
- **Anything taken off a screen goes into the guide**, in the same commit. Moving
  it is the point; deleting it is not.

### The three things a form shows, which are not one thing

An action form (`FolioActionCard` is the worked example) separates them, because
conflating them is how a void form came to be five lines of teaching over the
line it was voiding:

| Slot | What it holds | Where it goes |
| --- | --- | --- |
| **subject** | What you are acting on, with its real figures — "Dinner · ₦12,500" | On screen, always |
| **effect** | What this act does to THIS bill, in its numbers — "the balance goes down by ₦12,500 and its tax" | On screen, always |
| **about** | The general rule — what a void is, when to reverse instead | Behind the ⓘ, and in the guide |

The test between the last two: **if it names a figure from the record in front of
you it is an effect; if it would read the same on a record you have never seen,
it is an about.** An effect is never hidden behind an icon — somebody at the
moment of an irreversible act is deciding on exactly that sentence.

### What is NOT teaching, and stays on the screen

The rule is about explanation, not about every word. These are not paragraphs to
move, and stripping them makes a screen worse:

- **Error and empty states.** "No counts yet. The first one starts above." tells
  somebody what to do when there is nothing to do.
- **Live consequences.** A line that appears only when the arrival date differs
  from the reserved one, naming both dates.
- **Warnings at the point of an irreversible action**, with the real figures in
  them.
- **Rule 16's per-figure note.** Different affordance, different job: the ⓘ is
  about the screen, the small i is about one number. A screen may carry both.

### 26. Pickers are searchable
**Any selector that can hold more than about twenty options is a typeahead** that
filters as you type, matched on **name and code**, searched on the **SERVER**
against the same filters the underlying list uses. Never a client-side filter over
one loaded page. Keyboard-navigable, and portalled like every other floating layer
(rule 23).

*Why: a hotel with a thousand items cannot scroll a dropdown — but the obvious fix
is worse than the problem it replaces. A box that filters the rows the page happens
to hold answers "no matches" for an item that exists: instantly, confidently, and
wrongly, because Zobo is item four hundred. Nothing errors, nothing looks broken,
and the storekeeper concludes the hotel does not stock a thing sitting on the
shelf. A client-side filter searches what happened to be fetched, not what
exists.*

```tsx
// One primitive owns the behaviour; the domain wrapper owns the query.
<Typeahead value={id} selectedLabel={label} onChange={pick} search={serverSearch} />
```

The four parts, each load-bearing:

- **The search is a QUERY**, using the same predicates as the list it picks from
  (`searchInventoryItems`, `searchLocations`), so the picker's answer and the
  list's answer can never disagree.
- **The cap is announced.** A picker may return one page — rule 1b's "no way to
  reach the rest" is satisfied because the way through is to type more — but only
  if the panel says so out loud: "showing the first 20, keep typing to narrow it".
  A silent cap is the same lie in a different costume.
- **A row that exists but cannot be chosen here is SHOWN, with the reason, and
  disabled** — never filtered out. An absent row is indistinguishable from an item
  that does not exist; and dropping rows from a server result means a query that
  matched twenty can display two, which reads as "no matches".
- **Enter with nothing highlighted chooses nothing.** Grabbing the first result
  commits a form to a row nobody looked at, which on a stock screen is a movement
  against the wrong product.

**The threshold is about what a selector CAN hold, not what today's data happens to
hold.** A property has four locations; a group with an outlet in every lounge
reaches twenty without anybody revisiting the decision, and the person who would
have revisited it is reading a diff where a `<select>` looks fine.

### 27. An assertion that cannot distinguish working from absent is not an assertion
Rule 22 says a proof must be **made to fail**. This is the sharper form of the
same rule, and it exists because breaking the code has SIX times revealed that
the *assertion* was the broken thing, not the code — each time from a different
direction, each time green.

An assertion earns its place only if there is a plausible defect it would go RED
for. SIX shapes fail that test, and every one of them looks like thorough
testing. The first four are about the figure being checked:

- **It recomputes the answer it is checking.** 1.1g's receipt preview: breaking
  the weighted average to an unweighted mean left the proof at 35/35, because the
  assertions rebuilt the expected figure from their own constants and never
  called the function. *Fix: exercise the function the screen runs, not a copy of
  its arithmetic.*
- **It asserts a TOTAL, and the total is insensitive to the rule.** 1.1h's
  mapping screen: `neverPostedCount` was changed to read the wrong side of the
  pairing and the headline count stayed green, because in that fixture both sides
  gave the same number. *A proof of a total is not a proof of the rule that
  produced it.* Two purpose-built two-row fixtures caught what the 35-row one
  could not.
- **Its fixture is already in the state being asserted.** 1.1h1's chart order: a
  sort that did nothing would pass against pre-sorted rows. *Fix: the fixture is
  deliberately shuffled, so "it came out right" cannot mean "nothing moved".*
- **Its fixture makes the correct and incorrect computations COINCIDE.** *A
  fixture in which the two answers are the same number cannot test either one.*
  1.1h2: a reversal valued at the CURRENT moving average instead of the basis it
  unwinds — precisely what §6 and 038 exist to prevent — left the dry run at
  76/76, because the fixture reversed a write-off while the average still stood
  at the same ₦1,100 that write-off had carried out. *Fix: move the value
  between the act and its reversal, so the two branches are on different
  numbers.* The same thought fixes a boundary assertion: 1.1h2 asserted that a
  short delivery asks for a reason, and narrowing the rule to short-only stayed
  green — because 47 of 50 asks under both the true rule and the broken one.
  **Assert on the side of the boundary where the two rules DISAGREE.**

**The test to apply before trusting any assertion: name the defect that turns it
red.** If you cannot, it is decoration — and worse than nothing, because a green
run buys confidence it did not earn. Write the defect into the proof's header
alongside what actually went red, so the next person inherits the reasoning
rather than the number.

This applies to database dry runs exactly as it applies to render proofs. 045's
ordering gate runs against the LIVE rows before the migration and again against a
shuffled fixture in the render proof, because the two catch different things: one
proves it of the data, the other of the function the screen calls.

**A FIFTH SHAPE, and it is the easiest of all to write:** an assertion satisfied
by **any** failure at all. `exception when others then null` around a call that
is supposed to refuse proves that *something* went wrong, which is not the same
as proving the right thing refused. 059's assertion 8 passed with the guard it
was testing deleted — the function fell through to a NOT NULL violation three
lines later, something raised, and the proof agreed, while what the front desk
would have met was `null value in column "account_role_key"` instead of the
sentence naming the retired category. **An assertion about a refusal reads the
SQLSTATE and the message**, never merely the fact of an exception.

**A SIXTH SHAPE, one layer deeper than the fifth:** an assertion that reads the
SQLSTATE *and* the message, and is still satisfied by the **wrong** refusal.

> **Reading the sqlstate and the message is not enough when two different
> refusals share both.**

The test to apply, which is what makes this usable rather than a thing to
remember:

> **Before trusting an assertion on a refusal, ask which OTHER layer could
> refuse this same act, and whether its refusal would satisfy your pattern. If
> it would, match on something only yours says.**

*Why: 063 added a refusal to `record_payment` for a payment dated in the future,
and asserted it by SQLSTATE `PT422` plus `message like '%cannot be dated in the
future%'`. Deleting the refusal left the assertion GREEN — the payment went in,
the posting call ran, and `post_journal` raised ITS own refusal, "A JOURNAL ENTRY
cannot be dated in the future", carrying the same SQLSTATE and containing the
same substring. Two layers, one act, one pattern. The fix was to match on "A
payment cannot be dated…", naming the subject.*

**And the distinction is never pedantry, which is the half worth keeping.** The
two refusals mean opposite things to the person in front of the screen:
`record_payment` refusing is a date rejected at the keystroke, while
`post_journal` refusing means **the row was already written and the transaction
died on the way to the ledger** — which tells a cashier the ledger rejected their
takings. An assertion that cannot tell those apart cannot tell you the refusal
moved.

**So prefer a DISTINCT ERRCODE wherever two layers can plausibly refuse the same
act.** A pattern on prose is the floor; the code is the interface — the same
sentence as the unique index and the lookup in rule 3. Prose gets reworded,
translated and reflowed; an errcode is a contract, and a client that switches on
it cannot be fooled by a sentence that merely reads alike.

### 28. A comment that promises stability while its mechanism promises freshness is a lie
Two comments in this codebase stated a goal and then described the mechanism that
defeated it — `src/types/folio.ts` on a captured tax figure, and 032's on the
category a counter charge is posted under. Both survived more than a year of
reading. The rule that catches them:

> **If the sentence promises stability and the mechanism promises freshness, one
> of the two is a lie, and it is never the mechanism.**

And the reason it is not caught by careful reading, which is the half worth
remembering, because it explains why *this* kind of comment and not others:

> **A comment that is half right in the reassuring direction gets agreed with.**

*Why: 032's comment said a counter charge "attracts exactly the same taxes at
exactly the same rates" because it is posted under the same category. The first
half was true — the category does fix which taxes apply — so a reader checking
the claim found it confirmed and stopped. The second half was never true, and the
code it was defending left a ₦2,480 tax residue on every reversal of a bill from
before a rate change: a pair of entries that balanced, reconciled, and did not
net. The comment was the only thing standing where a bug was, and it was
reassuring.*

**So: when a comment asserts that something cannot change, go and read what
actually produces the value.** A live `select`, a join to a configuration table,
a flag with an admin UPDATE policy — any of those under a sentence about
permanence is the bug, and the sentence is how it stayed. The fix is always to
capture the fact (rules 6, 24 and §6's "a fact captured when it was true"), never
to reword the comment. **And when you find the third one, the pattern is no
longer a coincidence: look for the fourth before closing the shipment.**

### 29. A grep that confirms a suspicion is not evidence until each match is read in place
Rule 28's family, and it earns its own line because the failure is in **how the
evidence was gathered** rather than in what a comment claimed.

> **A proximity window is not a parser, and a pattern that agrees with you
> agrees in the reassuring direction.**

*Twice in three shipments, and both times the cost would have been a wrong
build:*

- **062.** A census of which functions call `post_charge` reported that
  `post_charge_reversal` does. It does not — it INSERTs the counter itself, and
  the match was the function's name inside its own **comment text**. Believed,
  the wiring would have gone into one function and been skipped in the other,
  leaving every charge reversal unposted.
- **065.** A census of which functions write `is_voided` used a 300-character
  window between `set` and the column, and reported `reverse_no_show` as setting
  the flag directly — which, after 064 made voids post, would have been a void
  with no counter-entry and the no-show's revenue stranded in the books.
  `reverse_no_show` **reads** the flag, in `if found and v_charge.is_voided is
  not true then`, and routes the actual work through `reverse_charge`. Believed,
  item 7 would have shipped a posting call into a function that needed none and
  a tracker line claiming a gap that did not exist.

Both times the narrower, earlier census had been right, and the broader one was
run precisely because a gap was suspected.

**So, in order:**

1. **Strip comments and string literals before matching.** A function's own name
   appears in its own comments more often than anywhere else.
2. **Require the syntax you actually mean.** A call needs the open parenthesis
   with no word character before the name; an assignment needs the `=` and the
   value, not the column within shouting distance of a `set`.
3. **Then open every match and read it in place.** A `where is_voided` is not a
   `set is_voided`; a name in a comment is not a call. The count is a
   **shortlist, never a finding.**
4. **When two searches disagree, the one that looked at the syntax wins** — and
   if neither did, neither has told you anything yet.

*The corollary, which is the part that actually costs time: this applies hardest
when the grep says what you expected. A result that contradicts you gets checked
automatically. A result that confirms you gets written into a plan.*

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

**An applied migration is history.** Once a file has been applied it is not
edited; the correction goes in the next numbered file. The CLI records what it
has run and **skips the file next time**, so an edit to an applied migration
leaves the repo and the database disagreeing in silence — the worst failure
shape there is, because nothing errors and the file reads as the truth.

**The one exception, and all three parts must hold at the same time:**

1. **Minutes have passed**, inside the session that applied it.
2. **Exactly one database exists** — no second environment has seen it.
3. **The file is idempotent** (`create or replace`, `drop ... if exists`, a
   fixture that rolls itself back) **and you re-run and re-verify it**, rather
   than assuming the edit landed.

The moment any one of those stops holding — the session ends, a second
environment appears, anything is applied on top — it is history again. **This
does not bend for a cosmetic change**, which is exactly when it is tempting:
a typo in a user-facing string feels too small to spend a migration number on,
and it is the same silent divergence as a schema change.

*Used once, on 3 November, on 050, to restore em dashes an ASCII pass had
eaten out of storekeeper-facing sentences. Flagged before it was found, re-run
and re-verified, and noted in the file itself.*

**Never ASCII-ify a migration to protect the parser.** A migration reaches
Postgres as a **file**, never on a command line, and non-ASCII in a file —
comment or string literal — round-trips exactly, with or without
`PGCLIENTENCODING`. Measured in `scripts/ops/backup.mjs`'s header, along with
what actually breaks and why. Banning characters from strings people read, to
protect a boundary the file never crosses, is treating a symptom and damaging
the product's voice to do it.

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

1. **Read this file.** Confirm the 29 non-negotiables are fresh in mind.
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
11. **Touching inventory, F&B or housekeeping?** Read [§9, the inventory
    standing rules](#9-inventory-the-standing-rules) — one way in, only the store
    receives, base units only, adjustment ≠ write-off, blind counts, both sides
    of a requisition.
12. **Writing a user-facing error?** You probably should not be. The rule lives
    in the database and the client shows its message AND its hint, verbatim
    (rule 21).
13. **Touching a screen?** It ships a render proof, and you have made that proof
    fail before trusting it (rule 22). A passing SQL proof says nothing about
    what the browser does with the JSON.

    **JUDGE A CONSOLE ON A FRESH TAB, NEVER ON A RELOADED ONE.** On this setup
    the console buffer survives `location.reload()`, so errors Vite logged while
    a file was half-edited are still sitting there afterwards reading as live
    defects — complete with stack traces, pointing at real components, in a
    screen that is now working perfectly.

    *This happened on 3 November and cost a regression report that was about to
    be written for a bug that did not exist.* Mid-conversion the console held
    `ReferenceError: DataTable is not defined` and `Failed to reload … 500`; the
    page rendered correctly, `tsc -b` was clean, a reload did not clear a line of
    it. Opening a new tab gave `No console logs.` The giveaway, in hindsight, was
    the `?t=1793699754444` cache-buster in the stack frames: those URLs were from
    an earlier edit, not from the load being looked at.

    So: open a new tab, load the page there, and read that console. And when a
    console does show something, check the timestamps in the stack frames before
    believing it is about the code as it stands.

    *Why this is a rule and not a note: it is the same family as a dry run that
    is more permissive than production. A harness that lies in the reassuring
    direction wastes a bug; a harness that lies in the alarming direction wastes
    a day chasing one that was never there. Both are lies, and the second one
    feels like diligence while it is happening.*

    **THE TYPE CHECK IS `tsc -b`. `npx tsc --noEmit` CHECKS NOTHING IN THIS
    REPO, AND NEVER HAS.** The root `tsconfig.json` is a solution file —
    `"files": []` with `references` to `tsconfig.app.json` and
    `tsconfig.node.json`. TypeScript does not build referenced projects unless
    you ask it to with `-b`, so `tsc --noEmit` against the root compiles an
    empty file list, finds nothing, exits 0, and prints a reassuring blank.
    `npm run build` is `tsc -b && vite build`, so CI has always been honest;
    it is the quick check people run by hand that is not.

    *This is not a hypothetical, and it is not one person's slip.* It was found
    by accident on 3 November, testing whether rule 24's boundary check still
    worked: `over_quantity` was deleted from a `boundary<T>()` field list and
    `npx tsc --noEmit` passed. The first conclusion was that rule 24's compiler
    guarantee had quietly stopped holding — a far worse finding, and the wrong
    one. Under `tsc -b` the same edit fails immediately and names the field:

    ```
    error TS2345: Argument of type 'readonly ["ordered_quantity", …]' is not
    assignable to parameter of type 'readonly [...] &
    { __unparsedNumericFields: "over_quantity"; }'.
      Property '__unparsedNumericFields' is missing …
    ```

    So **every "type check clean" claimed on this repo from a bare
    `tsc --noEmit` was hollow**, including ones in this file's own history. The
    guarantees were all still there; nobody was reading them.

    Run `npx tsc -b` (add `--force` when you want it to ignore its build cache).
    A green run that took no time at all is the symptom: `tsc -b` on this
    project takes tens of seconds, and an instant exit 0 means it checked
    nothing or reused a stale cache.

    *Why this earns more words than a rule nobody doubts: a false green is worse
    than a missing check. A missing check is a known gap somebody will close. A
    false green is a gap everybody believes is closed, and it is trusted for
    months — this one was.*
14. **Reading from the database?** The read declares a boundary and parses its
    numerics there (rule 24) — never in the component, and never a string method
    on a value that came off the wire.
15. **Building or touching a screen?** Its top is `<ScreenHeader>` — one line of
    purpose, then the controls; the rest behind the ⓘ and in
    `docs/USER-GUIDE.md` (rule 25). This applies to a NEW page on its first
    commit, not as a later tidy-up.
16. **Writing an action form?** Split subject / effect / about (rule 25). The
    effect names this record's own figures and stays on screen; the general rule
    goes behind the ⓘ.
17. **Adding a selector?** If it can hold more than about twenty options it is a
    `Typeahead` searched on the SERVER, not a `<select>` and never a client-side
    filter over a loaded page (rule 26). Judge it by what the selector CAN hold,
    not by what today's data does.
18. **Finishing a shipment?** It ends by updating
    [`docs/build-tracker.json`](docs/build-tracker.json) and re-running
    `npm run tracker`, **in the same commit as the work** — exactly as
    `docs/USER-GUIDE.md` does (rule 25). The tracker is the build plan and the
    source of truth for what has shipped; a shipment whose status, proof line or
    note is a commit behind is a source of truth that lies. The renderer refuses
    to build the page if any shipment is missing its id, status, milestone, size,
    proof line or what-it-ships list, so a clean `npm run tracker` is also the
    validation pass. **Never hand-edit `docs/build-tracker.html`** — edit the
    JSON and re-render.
    **The rendered HTML is gitignored, and must stay that way.** The JSON is the
    source; the page is derived from it. A committed derived file is a second
    source of truth that can disagree with the first — the day somebody edits the
    JSON and forgets to re-render, the repo holds a page saying something untrue,
    and it reads as authoritative precisely because it is in git. The tracker is
    read as a published page, so committing the HTML buys nothing and costs that.
    Do not re-add it.
    *Why this is a rule and not a habit: the file existed from August and was
    never in git, so it was rebuilt from a published HTML page twice in one day.
    A build plan that lives in somebody's workspace is one wipe from gone.*

    **Edit the JSON SURGICALLY — never round-trip it through a serialiser.**
    `JSON.parse` then `JSON.stringify(j, null, 2)` reformats all ~1,700 lines and
    buries a two-field change in a diff of 1,706 insertions, which no reviewer
    will read. The file is written with 1-space indent; a default serialiser does
    not preserve that. Change the exact lines (an editor, or a targeted
    find-and-replace on unique text) and check `git diff --stat` says single
    figures before committing. *This happened: the reformat was caught on the
    diff and reverted. The next person will not catch it.*

    **`git rm --cached` does not survive a `git stash` round-trip.** Untracking
    the generated HTML and then stashing — to check something against `HEAD`, for
    instance — silently re-tracks it on `stash pop`, and the next `git add -A`
    commits the derived file straight back in. *This happened too, and was caught
    only by reading `git status` one last time before committing.* So: after any
    stash, rebase or checkout, re-read `git status --porcelain` and confirm
    `docs/build-tracker.html` is absent from it before you commit.
19. **Read a comment that promises permanence as a bug report** (rule 28). If a
    sentence says a figure, a rate or an account cannot change, go and read what
    produces the value before you believe it. Two such comments in this codebase
    were each hiding a real defect, and both had been read and agreed with for
    over a year because the half that was true was the half a reader checks.
20. **Ran a grep to confirm something?** It is a shortlist, not a finding —
    open every match and read it in place (rule 29). Strip comments and string
    literals first, and require the syntax you mean: a call needs its open
    parenthesis, an assignment needs its `=`. This bites hardest when the
    result agrees with you, because that is the result nobody re-checks.

---

## 7a. Never `git add -A` in this repository

**Stage by path. Every commit, every time.** `git add -A`, `git add .` and
`git commit -a` stage whatever happens to be lying in the working tree, and what
is lying there is not always what you wrote.

*On 3 November a mistyped flag — `--out /tmp/x` where the parser takes
`--out=PATH` — resolved to a directory called `true` in the repo root and put a
full production backup in it: 1.7 MB of encrypted database dump and storage
archive. The thing that carried it into a commit, and then onto a **public**
remote, was `git add -A`. It is still in history.*

The failure is not the flag. A flag was fixed that day and the next accident
will be a different one — a tool's scratch output, a downloaded file, a dump
somebody took to debug something. **`git add -A` is what turns any of them into
a commit**, and it is the only part of the chain that is always the same.

So:

```bash
git add src/lib/errors.ts docs/build-tracker.json    # yes
git add -A                                           # no
```

- **Read `git status --porcelain` before every commit**, and stage the paths it
  shows that you meant to change. If a path surprises you, stop — that is the
  warning this rule exists to deliver.
- **`git add -p`** when a file holds more than one change.
- **A new untracked directory is never staged without being looked into.**
  `.gitignore` covers the output directories known today; it cannot cover the
  one the next tool invents.
- This applies to generated and derived files too — it is the same rule that
  keeps `docs/build-tracker.html` out (item 18).

*Why a rule rather than more care: care is what was being exercised at the time.
The diff was read, the stat was read, and the three binary files went past
anyway because they were named like everything else in a nine-file commit. A
command that cannot stage what you did not name cannot make that mistake.*

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

---

## 9. Inventory: the standing rules

Decisions already made and agreed. They are **not** in the build tracker,
because the tracker records what *ships*; these record what is *true*. Read them
before touching anything in the inventory, F&B or housekeeping modules — every
one of them is load-bearing for a report further downstream.

**One way in.** The upload page creates items and, **for a brand-new item only**,
sets its opening balance. A row whose item name already exists is skipped
**whole** — definition and quantity both — so re-uploading the same file can
never double stock.

**After creation, stock moves only by a recorded movement.** An adjustment with
a mandatory reason, a counted stock take, a receipt, an issue, a write-off, or a
reversal. Opening balance is a one-time event per item per location and is
**never** a way in.

**Only the store receives.** Goods reach the kitchen, bar or housekeeping by
**leaving the store**, never by arriving from outside. A manager may authorise a
direct receipt elsewhere with a mandatory reason; every one of those appears on
the **received outside the store** report, alongside every opening balance posted
after go-live and every negative position.
*Why the exception exists on purpose: without it, staff who buy something
directly will fake a store receipt and an instant requisition, which is worse
than no paperwork.*

**Base units only, no conversion factors.** Stock is held in the smallest unit
actually measured — kg, litre, piece. The storekeeper converts and enters the
real measured quantity.
*Why: a "bag" is ambiguous, and entering real kilos is what catches a 50 kg bag
that weighs 47.*
Where the ergonomics hurt, an entry field may accept `12 x 25` and show
`300 kg` before saving. **That is a calculator, not a stored conversion factor**,
and nothing persists but the base quantity.

**Cost.** Valuation is the moving average, always. `inventory_items.purchase_cost`
is **informational** and must never be used to value stock. A receipt at a new
price recomputes the average; stock out carries at the current average and leaves
it unchanged. Cost of sale is read from `stock_movements.carried_unit_cost` and
never recomputed (§6).

**Price.** The **item** owns its selling price. **Blank means not sold, which is
not the same as zero.** Where an outlet price exists it overrides the item price
at the point of sale, and the price actually charged is **locked onto the sale**,
the way `booking_nights` locks the rate. Changing a price never rewrites a past
sale. The menu **reads** these prices and never defines its own.

**Adjustment and write-off are different things.** An adjustment means *the count
was wrong*. A write-off means *we lost it, and here is why* — spoilage, breakage,
expiry, staff meal, complimentary.
*Why: blur them and the variance report is worthless.*

**Negative stock is flagged, never blocked.** A negative on-hand means stock left
without a movement.
*Why: blocking an issue stops service and teaches staff to invent fake receipts,
which destroys the ledger far more thoroughly than an honest negative.*

**Counts are blind.** The counter types what they physically counted. Expected
quantity and variance appear **only after submitting**.
*Why: a count taken with the expected figure on screen proves nothing.*

**Requisitions need both sides.** The requester raises it, the store ticks what it
actually sends, the requester confirms receipt. **Stock does not move until both
agree.** That mutual confirmation is the theft control — and it only means
anything once two different people have two different logins.

Two further rules were first learned here and apply to the **whole product**, so
they live with the non-negotiables rather than in this section — but they bind
every inventory surface just the same:

- **Errors belong to the database** (rule 21). The message carries the rule, the
  hint carries the way out, the client authors neither.
- **A screen needs a render proof** (rule 22), and the proof must have been made
  to fail before it is trusted.
