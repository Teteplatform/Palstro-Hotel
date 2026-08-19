# Palstro-Hotels — Architecture & System Map

The whole-system map for Palstro-Hotels. This is a **planning document, not a
spec to build from — build nothing from this file.** It exists so that every new
module is placed in the right layer, hangs off the right shared engine, and is
built in the right order. Read it before starting any new module; the specifics
of each module arrive in their own build brief.

---

## The four layers

Every table and module belongs to exactly one of four layers. Lower layers are
depended on by higher ones; nothing in a higher layer may be built before the
foundation it rests on exists.

### 1. Foundation — **built** (migrations 001–006)

The multi-tenant spine everything else assumes. Already shipped:

- Tenancy (`tenants`), properties, users and roles (`tenant_users`,
  `user_properties`) — 001
- RLS on every table, with `get_tenant_ids()` / `get_property_ids()` /
  `is_tenant_admin()` — 001
- Settings split: `tenant_settings` (accounting-level) vs `property_settings`
  (guest-facing) — 001
- Room types and physical rooms — 002
- Property location — 003
- Auth bootstrap — 004
- Storage (`media_assets`, bucket paths, storage RLS) — 005
- Change log (`change_log` + generic `log_field_changes()` trigger) and per-tenant
  module flags (`enabled_modules`) — 006

Foundation is the floor. Do not add a table without `tenant_id` + RLS in the same
migration (rule 13).

### 2. Configuration — set up once, changed rarely

Per-tenant reference data that operations read but rarely write:

- Room types (built, 002), **rate plans** (nightly rates / min-stay / seasonal —
  distinct from a room type's flat `base_rate`)
- **Tax settings** (VAT rate lives in `tenant_settings`; WHT config)
- **Chart of accounts** and **`account_mappings`** (per-tenant, role-keyed — rule 4)
- **Item catalogue** (inventory items, categories, units of measure)
- **Menus and recipes** (each menu item → a recipe of catalogue items)
- **Email templates** (booking confirmations, receipts)

Configuration changes are infrequent and admin-gated. Most carry `deleted_at`
soft-delete (master data), not `is_voided`.

### 3. Operations — daily staff work

What front-of-house and back-of-house touch every shift. **Every record here
carries a `business_date`** (rule: night audit means a 02:00 sale belongs to the
previous operating day):

- Bookings, front desk (check-in/out, room assignment)
- Housekeeping (room status board, amenity issue)
- F&B orders, stock movements, requisitions
- Maintenance, laundry

Operations records are transactional: `is_voided` soft-delete, business-date
grouped, actor-stamped. **Everything in Operations posts into Financial.**

### 4. Financial — the money layer

Everything Operations produces settles here:

- **Folios** (the guest's running tab)
- Invoices, payments
- **General ledger** (journal entries)
- VAT and WHT
- Reports

Every money movement in Financial books a journal entry through
`account_mappings` (rule 4), sorts ledgers by `entry_date` (rule 8), and states a
reconciles-to invariant (rule 9).

---

## The three shared engines

Three subsystems are consumed by many modules. Each must be built **once**, as a
single engine with multiple consumers — never re-implemented per module.

### Inventory — one catalogue, one movement ledger

One item catalogue, multiple stores per property, one movement ledger, weighted
average cost (WAC). Housekeeping amenity kits, kitchen ingredients, bar stock and
maintenance spares are **the same engine with different consumers**, not four
separate stock systems.

> Built twice, the food cost report and the amenity cost report never agree —
> because two ledgers value the same carton of soap at two different costs. One
> movement ledger is the only way the variance reports reconcile.

### Folio — the guest's running tab

One folio per stay accumulates every charge: room charges, F&B, laundry, minibar
all post to it. **Bookings, F&B and housekeeping write to it; accounting reads
it.** A single posting surface means the guest's bill and the ledger can never
disagree about what was charged.

> Built per module, each module keeps its own idea of "what the guest owes", and
> the front desk cannot produce one correct bill at checkout.

### Ledger — every money movement is a journal entry

Every money movement books a journal entry through `account_mappings` (rule 4).
One ledger, one posting path, accounts resolved by role key (never hardcoded
codes). This is what makes every financial report reconcile to something upstream
(rule 9).

> Built per module, each module posts to accounts its own way, and the trial
> balance never balances.

---

## The dependency order (hard constraints)

These are not preferences. A module built before its dependency is a module that
must be torn up and redone:

1. **Account mappings before anything that touches money.** No charge, payment or
   posting can resolve an account until the mappings exist.
2. **Bookings before folio** — a folio belongs to a stay; there is nothing to
   attach a running tab to until the booking exists.
3. **Folio before F&B and laundry** — both post their charges *to* the folio, so
   the folio must be able to receive charges first.
4. **Inventory before F&B** — a menu item without a recipe (of catalogue items)
   cannot compute food cost, and food cost is the point of F&B.
5. **Inventory before housekeeping** — issuing an amenity kit *is* a stock
   movement, so there must be a stock ledger to move against.

### Plan correction — build sequence was revised

The original 12-week plan placed **F&B at weeks 7–8** and **housekeeping at
9–10**, with **inventory absent entirely**. That inverts two of the constraints
above: F&B and housekeeping both depend on inventory, which was not scheduled to
exist. Building them first would mean F&B could not compute food cost and
housekeeping could not record an amenity issue as a stock movement — both would
be rebuilt once inventory arrived.

**Revised sequence:** bookings and folio → **inventory** → F&B and housekeeping →
accounting. Inventory moves ahead of the two modules that consume it, and
accounting lands last, after everything that posts into it exists.

---

## Inventory scope

Inventory is the least obvious module, so its scope is spelled out here. It is a
full stock engine, not a product list:

- **Items** with categories and **units of measure**, including
  **purchase-to-issue conversions** — stock is *bought* by the carton and
  *issued* by the piece, so a purchase unit and an issue unit differ and the
  conversion factor is part of the item.
- **Multiple stores within a property**: main store, housekeeping, kitchen, bar.
  Each store holds its own quantities of shared catalogue items.
- **Movements**: receipts, issues, transfers, adjustments, wastage — the five
  movement types that make up the one movement ledger.
- **Requisitions** with an **approval step** — a store requests, an approver
  releases, then the issue posts.
- **Suppliers and purchase orders.**
- **Stock counts and variance** — periodic physical counts reconciled against the
  ledger; the difference is the variance report.
- **WAC valuation posting to the GL** — weighted average cost, and stock value
  changes book journal entries through the ledger engine.

---

## Department hooks — how Operations touches the engines

The engines are only worth building once because operations reach into them
constantly. The three hooks that matter most:

- **Housekeeping → Inventory.** Cleaning a room and issuing an amenity kit is a
  **stock movement** against the housekeeping store — not a separate housekeeping
  count. Amenity cost comes straight out of the one movement ledger.
- **Minibar → Folio *and* Inventory, together.** A minibar consumption creates
  **both** a folio charge (the guest pays) **and** a stock movement (the bottle
  leaves stock). The two must be **written together** — a charge without the
  movement, or a movement without the charge, is exactly the discrepancy the
  system exists to catch.
- **F&B → Inventory, via recipes.** Each menu item carries a **recipe**, so a
  sale deducts its ingredients from stock. The gap between **theoretical**
  consumption (what the recipes say should have been used) and **actual**
  consumption (what the counts show was used) **is the theft report.** This is
  precisely what the `numeric(14,4)` quantity convention exists for — recipe
  measures like 0.0250 kg per plate must not round away, or the variance the
  report is built to surface disappears into rounding drift.

---

## What every screen in a new module looks like

The layers above decide *what* a module contains. This decides what its screens
look like on the day they are first written, and it is not a later polish pass —
CLAUDE.md rules 24 and 25, restated here because this file is the one that gets
read before a new module is started.

**Every screen opens with `<ScreenHeader>`:** the module's name, ONE sentence of
purpose, the primary action beside it, and a single **ⓘ** holding the
explanation. The explanation is also written into `docs/USER-GUIDE.md`, which
the ⓘ links to by section anchor.

```tsx
<ScreenHeader
  title="Requisitions"
  purpose="Ask the store for stock, and confirm what actually arrived."
  about={{ title, paragraphs, guideAnchor, guideLabel }}
  propertySlug={propertySlug}
  actions={<button …>New requisition</button>}
/>
```

Write the reasoning as well as you like — a module nobody understands is a module
nobody uses — and then put it where a person can choose to read it. The screen
itself is for doing the job. Three concrete consequences:

- **A new page is built this way on its first commit.** Written long and tidied
  later means never: the tidying is not scheduled, and in a diff three paragraphs
  read as care rather than as clutter.
- **An action form splits subject / effect / about.** What you are acting on and
  what this act does to *this* record stay on screen with their real figures; the
  general rule goes behind the ⓘ. `FolioActionCard` is the worked example.
- **Every read parses its numerics at the boundary** (rule 24) before any of this
  renders. A module's data layer declares `boundary<T>()` per read; the compiler
  refuses the declaration until every numeric field is listed.

The three affordances are different and a screen may carry all three: the **ⓘ**
explains the screen, the **small i** (`CalculationNote`) explains one figure, and
an **error or empty state** says what to do when there is nothing to do.
