import { renderToString } from 'react-dom/server';
import { MovementRow } from '../src/components/admin/inventory/MovementsList';
import { movementRows } from '../src/lib/stock';
import type { InventoryItem, StockLocation } from '../src/types/inventory';

// THE RENDER PROOF FOR THE ADJUSTMENTS / IMPORT-HISTORY LIST (rule 22).
//
// MovementsList had no render proof, which is why `row.quantity.trim is not a
// function` shipped from it — the third time that same sentence reached a
// storekeeper in one day, after the item ledger and the count sheet.
//
// WHAT THIS PROVES THAT THE OTHER TWO PROOFS DO NOT. The earlier proofs handed a
// component a row shaped the way somebody BELIEVED the wire shapes it. That
// tests the component and takes the boundary on trust — and the boundary was
// exactly what was wrong. So this one starts one step further back, at the raw
// JSON, and runs the SAME parser the data layer runs (lib/stock's exported
// `movementRows`, imported here rather than re-declared) before rendering the
// SAME component the screen renders.
//
// The two fixtures below are the same movement twice, and the whole point:
//
//   WIRE_AS_STRINGS   what PostgREST sends for numeric(14,4) — "-40.0000"
//   WIRE_AS_NUMBERS   what it sends for int8, for a jsonb payload, and for any
//                     column a future view casts to integer — -40
//
// Both must render, and must render IDENTICALLY. Nothing in this file may know
// which shape it is looking at, because nothing in the app can either.
//
// ---------------------------------------------------------------------------
// MADE TO FAIL BEFORE IT WAS TRUSTED
// ---------------------------------------------------------------------------
// Three breaks were applied to the real code, the proof re-run, and the code put
// back. What each one actually did, rather than what it was expected to do:
//
//   1. `row.quantity.trim().startsWith('-')` restored in MovementRow — the
//      shipped bug, verbatim. It no longer COMPILES (quantity is `number`), so
//      the break needed an `as unknown as string` to run at all. RED: 10 checks,
//      "row.quantity.trim is not a function".
//      THE EXPECTED RESULT WAS WRONG, and the way it was wrong is the point.
//      PART 1 was expected to stay green — string data hid this bug in
//      production. It went red too, because the boundary had ALREADY turned
//      "-40.0000" into -40 before the component saw it. That is the whole change
//      in one line: the component no longer has two shapes to survive, so the
//      bug can no longer hide behind the lucky one.
//   2. `quantity` dropped from the boundary's required list in lib/stock.
//      Caught TWICE, which is what a boundary should do. `tsc` fails first —
//      "Property '__unparsedNumericFields' is missing … required in type
//      '{ __unparsedNumericFields: \"quantity\" }'" — and if that were somehow
//      skipped, PART 4 goes RED on 4 checks: the unparsed field stops throwing
//      on rubbish and the empty string quietly becomes 0.
//   3. `formatSignedQuantity` narrowed back to `(q: string)` and trusting the
//      narrowing. Refused by the compiler at two call sites, and RED on 10
//      checks when built anyway. This is rule 22's corollary — never re-narrow a
//      boundary value's type — and the one most likely to creep back in a
//      "tidy-up" commit, because the narrower signature looks neater.

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}${extra ? ' ' + extra : ''}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${extra ? ' ' + extra : ''}`);
  }
};

const strip = (h: string) =>
  h
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

const item: InventoryItem = {
  id: 'i1',
  tenant_id: 't',
  name: 'Long grain rice',
  code: 'RICE-01',
  item_type: 'raw',
  base_unit: 'kg',
  category_id: 'c',
  is_perishable: false,
  tracks_expiry: false,
  reorder_level: 20,
  barcode: null,
  pack_size: null,
  purchase_cost: null,
  min_stock_level: null,
  max_stock_level: null,
  // 042. An Ingredient, so it has NO selling price — the database refuses one
  // (inventory_items_raw_has_no_price_check), and a fixture that carried one would
  // be a row the schema cannot hold.
  default_selling_price: null,
  image_asset_id: null,
  is_active: true,
  display_order: 1,
  deleted_at: null,
  created_at: '2026-08-01T09:00:00Z',
  updated_at: '2026-08-01T09:00:00Z',
  created_by: null,
  updated_by: null,
};

const location: StockLocation = {
  id: 'l1',
  tenant_id: 't',
  property_id: 'p',
  name: 'Main Store',
  kind: 'store',
  is_default_store: true,
  is_active: true,
  display_order: 1,
  deleted_at: null,
  created_at: '2026-08-01T09:00:00Z',
  updated_at: '2026-08-01T09:00:00Z',
  created_by: null,
  updated_by: null,
};

// The non-numeric half of the row, identical in both fixtures. Typed `unknown`
// rather than StockMovement on purpose: this is what the WIRE holds, and the
// wire does not hold the app's types — that is the whole subject of this proof.
const wireCommon = {
  id: 'm1',
  tenant_id: 't',
  property_id: 'p',
  location_id: 'l1',
  inventory_item_id: 'i1',
  movement_type: 'adjustment',
  business_date: '2026-08-17',
  reason: 'Spoilage found at the shelf check',
  note: null,
  source: 'manual',
  source_document_type: null,
  source_document_id: null,
  idempotency_key: 'k1',
  created_at: '2026-08-18T02:15:00Z',
  updated_at: '2026-08-18T02:15:00Z',
  created_by: 'u1',
  updated_by: null,
};

// numeric(14,4) and numeric(14,2) as PostgREST sends them.
const WIRE_AS_STRINGS: unknown = {
  ...wireCommon,
  seq: 412,
  quantity: '-40.0000',
  unit_cost: null,
};

// The same figures as JSON numbers — int8, a jsonb payload, or a view that casts
// to integer. THIS is the shape that crashed the screen.
const WIRE_AS_NUMBERS: unknown = {
  ...wireCommon,
  seq: 412,
  quantity: -40,
  unit_cost: null,
};

const render = (wire: unknown) =>
  renderToString(
    <table>
      <tbody>
        <MovementRow
          // THE REAL PARSER, imported from the data layer — not a copy, and not
          // a hand-built row. If lib/stock stops parsing `quantity`, this proof
          // renders whatever the wire held, exactly as the screen would.
          row={movementRows.row(wire)}
          item={item}
          location={location}
          currency="NGN"
          timezone="Africa/Lagos"
          viewerId="u1"
        />
      </tbody>
    </table>,
  );

// ---------------------------------------------------------------------------
// PART 1 — the shape everyone assumed: every numeric a STRING
// ---------------------------------------------------------------------------
console.log('\n=== 1. Every numeric arrives as a STRING ===');

let stringHtml = '';
try {
  stringHtml = render(WIRE_AS_STRINGS);
  ok('a row of string numerics renders', true);
} catch (e) {
  ok('a row of string numerics renders', false, (e as Error).message);
}
console.log(`\n  ${strip(stringHtml)}\n`);

ok('the quantity carries its sign', strip(stringHtml).includes('-40 kg'));
ok('it is marked as stock going OUT', stringHtml.includes('text-accent'));
// THE DATE COLUMN IS THE BUSINESS DATE (rules 8/12), and the fixture is built
// so the two disagree: business_date is the 17th, created_at the 18th. Compared
// cell by cell rather than against a formatted literal, so the assertion keeps
// its teeth under any locale the proof happens to run in.
// A row that THREW renders as '', and a proof must survive that to report the
// rest of its failures — the first break tried below took the whole file down
// with an unrelated TypeError until this returned '' instead of undefined.
const cells = (h: string) =>
  h ? h.split('</td>').slice(0, -1).map(strip) : [];
const cell = (h: string, i: number) => cells(h)[i] ?? '';
ok('the DATE column is the business date (the 17th)', cell(stringHtml, 0).includes('17'), cell(stringHtml, 0));
ok('and NOT the day it was keyed (the 18th)', !cell(stringHtml, 0).includes('18'));
ok('while the RECORDED column is the created_at (the 18th)', cell(stringHtml, 5).includes('18'), cell(stringHtml, 5));
ok('a stock-out states NO unit cost (036 §2)', cell(stringHtml, 4) === '—', cell(stringHtml, 4));
ok('the reason is shown against the line', strip(stringHtml).includes('Spoilage found'));

// ---------------------------------------------------------------------------
// PART 2 — the shape that actually crashed it: every numeric a JSON NUMBER
// ---------------------------------------------------------------------------
console.log('=== 2. Every numeric arrives as a JSON NUMBER (the crash) ===');

let numberHtml = '';
try {
  numberHtml = render(WIRE_AS_NUMBERS);
  ok('a row of NUMBER numerics renders at all', true);
} catch (e) {
  // This is the exact failure the storekeeper saw:
  //   row.quantity.trim is not a function
  ok('a row of NUMBER numerics renders at all', false, (e as Error).message);
}
console.log(`\n  ${strip(numberHtml)}\n`);

ok('the quantity still carries its sign', strip(numberHtml).includes('-40 kg'));
ok('it is still marked as stock going OUT', numberHtml.includes('text-accent'));

// THE ASSERTION THE WHOLE FILE EXISTS FOR. Not "both rendered" — both rendered
// THE SAME. A component that survived one shape by accident and rounded the
// other differently would pass every test above and still be wrong.
ok(
  'both wire shapes render BYTE-IDENTICAL output',
  stringHtml === numberHtml,
  stringHtml === numberHtml ? '' : '\n    strings: ' + strip(stringHtml) + '\n    numbers: ' + strip(numberHtml),
);

// ---------------------------------------------------------------------------
// PART 3 — inward stock, and the cost column that only a stock-IN carries
// ---------------------------------------------------------------------------
console.log('=== 3. A stock-IN, in both shapes ===');

const inwardStrings = render({
  ...wireCommon,
  seq: 413,
  quantity: '250.0000',
  unit_cost: '1850.00',
  reason: 'Recount after delivery',
});
const inwardNumbers = render({
  ...wireCommon,
  seq: 413,
  quantity: 250,
  unit_cost: 1850,
  reason: 'Recount after delivery',
});

console.log(`\n  ${strip(inwardStrings)}\n`);

ok('an inward quantity is shown with a PLUS', strip(inwardStrings).includes('+250 kg'));
ok('and is NOT toned as an outward movement', !inwardStrings.includes('text-accent'));
// To the KOBO, and the symbol is left out of the assertion deliberately: Intl
// renders NGN as '₦' in a browser and as 'NGN' under Node's ICU, and which one
// this proof sees says nothing about the code under test. The two decimal
// places do (§6: a bill's printed lines must add up to its printed total).
ok('a stock-IN shows the unit cost it stated', strip(inwardStrings).includes('1,850.00'));
ok('the number-shaped row agrees to the kobo', strip(inwardNumbers).includes('1,850.00'));
ok('and the two are byte-identical too', inwardStrings === inwardNumbers);

// ---------------------------------------------------------------------------
// PART 4 — the parse itself: what it does with what should never arrive
// ---------------------------------------------------------------------------
console.log('=== 4. The boundary, at its edges ===');

// A nullable numeric that is genuinely null stays null — and renders as the
// shared dash, never as a confident ₦0.00.
const noCost = movementRows.row(WIRE_AS_STRINGS);
ok('a NULL unit_cost parses to null, not 0', noCost.unit_cost === null);

// A REQUIRED numeric that is missing is a broken contract, and the boundary says
// so out loud rather than letting a NaN into a total (rule 11 carries it to the
// user as "we couldn't load these movements"). The message must name the read
// and the field, because a developer is the only person who can act on it.
try {
  movementRows.row({ ...wireCommon, seq: 1 });
  ok('a MISSING required numeric throws', false, 'it did not throw');
} catch (e) {
  const message = (e as Error).message;
  ok('a MISSING required numeric throws', true);
  ok('and the message names the read and the field', message.includes('stock_movements.quantity'), message);
}

try {
  movementRows.row({ ...wireCommon, seq: 1, quantity: 'not a number', unit_cost: null });
  ok('an UNPARSEABLE required numeric throws', false, 'it did not throw');
} catch (e) {
  ok('an UNPARSEABLE required numeric throws', true, (e as Error).message);
}

// The empty string is the one Number() gets wrong — Number('') is 0 — and a
// silent 0 in a quantity column is stock nobody moved.
try {
  movementRows.row({ ...wireCommon, seq: 1, quantity: '', unit_cost: null });
  ok('an EMPTY string never becomes 0', false, 'it became a number');
} catch {
  ok('an EMPTY string never becomes 0', true);
}

// `rows()` is what every list actually calls. It must take PostgREST's own
// `data` — including the null it sends for an empty result.
ok('rows(null) is an empty list, not a crash', movementRows.rows(null).length === 0);
ok(
  'rows() parses every element',
  movementRows.rows([WIRE_AS_STRINGS, WIRE_AS_NUMBERS]).every((r) => r.quantity === -40),
);

console.log(`\n================  ${pass} PASSED, ${fail} FAILED  ================`);
process.exit(fail ? 1 : 0);
