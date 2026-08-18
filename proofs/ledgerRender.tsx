import { renderToString } from 'react-dom/server';
import { LedgerRow } from '../src/components/admin/inventory/StockItemLedger';
import { formatSignedQuantity } from '../src/lib/format';
import { ledgerRows } from '../src/lib/stock';
import type { StockLedgerRow } from '../src/types/stock';

// THE PROOF THE SQL PROOFS COULD NOT BE.
//
// 1.1c shipped with 40 passing wiring proofs and a screen that crashed on first
// render: "value.trim is not a function". Every one of those proofs ran in
// Postgres, where the `pg` driver hands back int8 AND numeric as strings. The
// browser talks to PostgREST, which emits JSON — and there `int8` becomes a
// NUMBER while `numeric` stays a string. No amount of SQL can catch a formatter
// that assumes the wrong one, because SQL never renders React.
//
// So this renders the REAL LedgerRow — the same component the screen uses, not a
// copy — against the shapes PostgREST actually sends, including a reversal row.

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name} ${extra}`); }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
};

// ---------------------------------------------------------------------------
// PART 1 — the formatter, across every shape the boundary can produce
// ---------------------------------------------------------------------------
console.log('\n=== 1. formatSignedQuantity, over every PostgREST shape ===');
console.log('    (the old signedQuantity threw on all four of the non-string ones)');

const cases: Array<[unknown, string, string]> = [
  ['40.0000', '+40', 'numeric as a string — the normal case'],
  ['-40.0000', '-40', 'negative numeric as a string'],
  [40, '+40', 'a NUMBER — what int8 arrives as, and what crashed'],
  [-40, '-40', 'a negative number'],
  [0, '+0', 'zero (refused by the DB, but must not throw)'],
  [null, '—', 'a JSON null'],
  [undefined, '—', 'an absent key'],
  ['', '—', 'an empty string'],
  ['  50.5  ', '+50.5', 'whitespace-padded string'],
  ['-0.0250', '-0.025', 'a fractional negative — recipe scale'],
  ['not a number', '—', 'unparseable text'],
];

for (const [input, expected, why] of cases) {
  let actual: string;
  try {
    actual = formatSignedQuantity(input as never);
  } catch (e) {
    actual = `THREW: ${(e as Error).message}`;
  }
  ok(
    `${JSON.stringify(input)} → ${JSON.stringify(actual)}`,
    actual === expected,
    actual === expected ? `(${why})` : `expected ${JSON.stringify(expected)}`,
  );
}

// ---------------------------------------------------------------------------
// PART 2 — the real row, rendered, with PostgREST's real types
// ---------------------------------------------------------------------------
console.log('\n=== 2. LedgerRow rendered against PostgREST-shaped rows ===');

// seq is int8 → a NUMBER. Every numeric is a STRING. Absent values are null.
// This is the exact shape the browser receives, and the shape the SQL proofs
// could not observe.
//
// TYPED `unknown` AND PARSED, rather than typed as the row: this fixture is what
// the WIRE holds, and since rule 24 the app's row type is what comes out of
// lib/stock's parser, not what goes into it. Building the fixture as a
// StockLedgerRow would have meant writing numbers here — proving the component
// against a shape nothing produces, and skipping the parse that is now the part
// most worth proving.
const originalWire: unknown = {
  id: 'aaaaaaaa-0000-0000-0000-000000000001',
  tenant_id: 't', property_id: 'p', location_id: 'l', inventory_item_id: 'i',
  seq: 330,                       // <-- NUMBER, not a string
  movement_type: 'adjustment',
  quantity: '50.0000',            // <-- string
  unit_cost: '2100.00',
  business_date: '2026-08-16',
  reason: 'second lot', note: null, source: 'manual',
  created_at: '2026-08-16T09:00:00Z', created_by: 'u',
  running_quantity: '170.0000',
  running_average_cost: '1676.4706',
  movement_value: '105000.00',
  carried_unit_cost: null,        // <-- null on a stock-in
  reverses_movement_id: null,
  reversed_by_movement_id: 'aaaaaaaa-0000-0000-0000-000000000002',
  batch_code: null, expiry_date: null,
};

// THE REVERSAL ROW the brief asked for explicitly.
const counterWire: unknown = {
  ...(originalWire as Record<string, unknown>),
  id: 'aaaaaaaa-0000-0000-0000-000000000002',
  seq: 331,
  movement_type: 'reversal',
  quantity: '-50.0000',
  unit_cost: null,
  reason: 'delivery rejected at the gate',
  running_quantity: '120.0000',
  running_average_cost: '1500.0000',
  movement_value: '-105000.00',
  carried_unit_cost: '2100.0000',  // the basis being unwound
  reverses_movement_id: 'aaaaaaaa-0000-0000-0000-000000000001',
  reversed_by_movement_id: null,
  batch_code: 'LOT-4471',
  expiry_date: '2026-12-01',
};

// THE REAL PARSER, imported from the data layer (rule 22: a seam, not a copy).
const original: StockLedgerRow = ledgerRows.row(originalWire);
const counter: StockLedgerRow = ledgerRows.row(counterWire);

const rows = [original, counter];
const render = (row: StockLedgerRow, canReverse = true) =>
  renderToString(
    <table><tbody>
      <LedgerRow
        row={row} rows={rows} baseUnit="kg" currency="NGN"
        canReverse={canReverse} onReverse={() => {}}
      />
    </tbody></table>,
  );

let originalHtml = '';
let counterHtml = '';
try {
  originalHtml = render(original);
  ok('the ORIGINAL row renders without throwing', true);
} catch (e) {
  ok('the ORIGINAL row renders without throwing', false, (e as Error).message);
}
try {
  counterHtml = render(counter);
  ok('the REVERSAL row renders without throwing', true);
} catch (e) {
  ok('the REVERSAL row renders without throwing', false, (e as Error).message);
}

const strip = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'")
  .replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

console.log(`\n  original: ${strip(originalHtml)}`);
console.log(`  reversal: ${strip(counterHtml)}\n`);

ok('the original shows its signed quantity', strip(originalHtml).includes('+50 kg'));
ok('the reversal shows a NEGATIVE signed quantity', strip(counterHtml).includes('-50 kg'));
ok('the original is marked as reversed', strip(originalHtml).includes('Reversed'));
ok('the reversal names what it undid', strip(counterHtml).includes('Reverses the adjustment'));
ok('the reversal is labelled Reversal, never Adjustment',
  strip(counterHtml).includes('Reversal') && !strip(counterHtml).includes('Adjustment'));
ok('the batch and expiry render on the row that has them',
  strip(counterHtml).includes('LOT-4471') && strip(counterHtml).includes('expires'));
ok('the already-reversed original offers NO Reverse button', !originalHtml.includes('>Reverse<'));
ok('the reversal itself offers NO Reverse button', !counterHtml.includes('>Reverse<'));

// A plain, reversible row SHOULD offer the button.
const plain: StockLedgerRow = { ...original, reversed_by_movement_id: null };
ok('a plain adjustment DOES offer the button', render(plain).includes('>Reverse<'));
ok('and not when the ledger is read-only', !render(plain, false).includes('>Reverse<'));

// ---------------------------------------------------------------------------
// PART 3 — the regression itself, pinned
// ---------------------------------------------------------------------------
console.log('=== 3. The exact regression, pinned ===');
// THE SAME MOVEMENT, sent as JSON NUMBERS instead of strings — int8, a jsonb
// payload, or any column a future view casts. This is what the crash proved was
// actually happening, and it used to need an `as unknown as string` to express,
// because the row type insisted the wire spoke strings. It does not need one now:
// the fixture is wire-shaped, so this is simply the other thing the wire sends.
const hostileWire: unknown = {
  ...(counterWire as Record<string, unknown>),
  quantity: -50,
  running_quantity: 120,
  running_average_cost: 1500,
  movement_value: -105000,
  carried_unit_cost: 2100,
};
try {
  const html = render(ledgerRows.row(hostileWire));
  ok('a row whose numerics arrive as NUMBERS still renders', true);
  ok('and still shows the right sign', strip(html).includes('-50 kg'), strip(html).slice(0, 90));
  // The assertion the earlier version could not make, because it had no
  // string-shaped counterpart to compare against: the two wire shapes are not
  // merely both survivable, they are indistinguishable downstream.
  ok('and renders BYTE-IDENTICALLY to the string-shaped row', html === counterHtml);
} catch (e) {
  ok('a row whose numerics arrive as NUMBERS still renders', false, (e as Error).message);
}

console.log(`\n================  ${pass} PASSED, ${fail} FAILED  ================`);
process.exit(fail ? 1 : 0);
