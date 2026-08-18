import { renderToString } from 'react-dom/server';
import {
  CountSheetRow,
  FinishConfirmation,
} from '../src/components/admin/inventory/CountSheet';
import { VarianceRow } from '../src/components/admin/inventory/CountVarianceReport';
import { sheetRows } from '../src/lib/stockTake';
import type { StockTakeSheetRow } from '../src/types/stockTake';

// THE RENDER PROOF FOR THE COUNT SHEET (rule 22).
//
// The 039 dry run proved forty-odd things in Postgres: that the snapshot holds,
// that the payload carries no expected quantity, that a partial count posts
// nothing for the shelves nobody visited. Every one of those ran in SQL, where
// the `pg` driver hands back int8 AND numeric alike as strings. The browser
// talks to PostgREST, where int8 arrives as a JSON NUMBER and numeric stays a
// STRING — and NULL arrives as a JSON null that a formatter can turn into "0"
// without anything erroring.
//
// That last one is not a hypothetical here. This screen turns on telling three
// NULLs apart, and getting any of them wrong is silent:
//
//   * counted_quantity NULL   = NOBODY WENT TO THAT SHELF. Rendered as "0" it
//     reads as a shelf that was found empty — which, when finished, would write
//     off its entire contents.
//   * a counted ZERO          = COUNTED, AND EMPTY. Rendered as blank it reads
//     as not counted, and the single most consequential answer on the sheet
//     disappears.
//   * expected_quantity NULL  = THE COUNT IS BLIND (039 §4). Rendered as "0" it
//     is a number the server deliberately refused to send.
//
// So this renders the REAL rows — the same components the screens use, not
// copies — against the shapes PostgREST actually sends.
//
// MADE TO FAIL BEFORE IT WAS TRUSTED, and the first attempt did not fail, which
// is the part worth writing down. Both breaks below were applied to the real
// components, the proof was re-run, and the components were put back:
//
//   * `const saved = row.counted_quantity || ''` in CountSheetRow, instead of an
//     explicit null check. THE PROOF STAYED GREEN. With the column arriving as
//     the STRING '0.0000' the `||` is harmless — a non-empty string is truthy —
//     so every assertion about a counted zero passed while the bug sat there.
//     It is the JSON NUMBER 0 that `||` swallows, and only the input's own value
//     attribute shows it, because the status text beside the field is derived
//     from is_counted rather than from the field. The proof was missing that
//     assertion; it has it now (PART 3), and with it the break goes red.
//   * `formatQuantity(row.expected_quantity ?? 0)` in VarianceRow — "a blind
//     expected renders as the dash, never as 0" FAILED, as intended.
//
// A proof that has never failed is a proof that has never been tested, and a
// proof that failed to fail is worth more than one that passed: this one was
// only sound after the attempt.

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}${extra ? ' ' + extra : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? ' ' + extra : ''}`); }
};

const strip = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'")
  .replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

// The exact shape PostgREST sends for a line of an OPEN count: every numeric is
// a STRING, the blind columns are JSON nulls, and is_counted is a real boolean
// computed by the view.
//
// A WIRE FIXTURE, PARSED THROUGH THE REAL BOUNDARY (`line` below), not a row
// literal. Since rule 24 the app's row type is what comes OUT of lib/stockTake's
// parser; writing numbers here would prove the components against a shape the
// wire never sends and skip the parse entirely. This file learned that the hard
// way — it kept building and running with string literals in a `number | null`
// field until the proofs were typechecked (tsconfig.proofs.json).
const baseWire: Record<string, unknown> = {
  line_id: 'aaaaaaaa-0000-0000-0000-000000000001',
  tenant_id: 't',
  stock_take_id: 's',
  property_id: 'p',
  location_id: 'l',
  take_status: 'open',
  business_date: '2026-08-17',
  inventory_item_id: 'i',
  item_name: 'Long grain rice',
  item_code: 'RICE-01',
  base_unit: 'kg',
  category_id: 'c',
  item_is_active: true,
  category_name: 'Dry goods',
  counted_quantity: null,
  is_counted: false,
  counted_at: null,
  counted_by: null,
  // BLIND: not withheld by the component — never sent by the server (039 §4).
  expected_quantity: null,
  variance_quantity: null,
  variance_unit_cost: null,
  variance_value: null,
  movement_id: null,
  movement_reversed: false,
};

// One wire row through the real parser. Every fixture below is built with this,
// so nothing in this file can accidentally hand a component a shape the data
// layer would never produce.
const line = (patch: Record<string, unknown> = {}): StockTakeSheetRow =>
  sheetRows.row({ ...baseWire, ...patch });

const base: StockTakeSheetRow = line();

const renderSheetRow = (
  row: StockTakeSheetRow,
  opts: {
    draft?: string;
    state?: 'idle' | 'saving' | 'error';
    message?: string | null;
  } = {},
) =>
  renderToString(
    <table><tbody>
      <CountSheetRow
        row={row}
        draft={opts.draft}
        state={opts.state ?? 'idle'}
        message={opts.message ?? null}
        disabled={false}
        onDraftChange={() => {}}
        onCommit={() => {}}
      />
    </tbody></table>,
  );

// ---------------------------------------------------------------------------
// PART 1 — the open sheet, and the two NULLs that must never look alike
// ---------------------------------------------------------------------------
console.log('\n=== 1. CountSheetRow — not counted is not zero, and zero is not blank ===');

const notCounted = renderSheetRow(base);
console.log(`\n  not counted: ${strip(notCounted)}\n`);

ok('a shelf nobody visited says so IN WORDS', strip(notCounted).includes('Not counted'));
ok('and its input is EMPTY, not "0"', /value=""/.test(notCounted) || !/value="0/.test(notCounted));
ok('the row shows no quantity at all for it',
  !strip(notCounted).includes('Counted 0'));

// THE ONE THAT CATCHES `|| ''`.
const countedZero: StockTakeSheetRow = line({
  counted_quantity: '0.0000',
  is_counted: true,
  counted_at: '2026-08-17T09:00:00Z',
  counted_by: 'u',
});
const zeroHtml = renderSheetRow(countedZero);
console.log(`  counted zero: ${strip(zeroHtml)}\n`);

// The field holds the PARSED number rendered as text — '0', not the wire's
// '0.0000'. What matters is unchanged and is the whole point of the assertion:
// a counted zero reaches the input as a zero and not as an empty field.
ok('a counted ZERO keeps its 0 in the field (the `|| \'\'` bug)',
  /value="0"/.test(zeroHtml), zeroHtml.match(/value="[^"]*"/)?.[0] ?? '(no value attr)');
ok('and reads as COUNTED, not as an empty shelf',
  strip(zeroHtml).includes('Counted 0 kg'), strip(zeroHtml).slice(0, 80));
ok('it never says "Not counted"', !strip(zeroHtml).includes('Not counted'));

const counted = renderSheetRow(line({ counted_quantity: '12.5000', is_counted: true }));
ok('an ordinary counted line trims its trailing zeros',
  strip(counted).includes('Counted 12.5 kg'), strip(counted).slice(0, 80));

// BLINDNESS, checked on the rendered output rather than trusted.
ok('NOTHING in an open row renders an expected quantity',
  !strip(zeroHtml).toLowerCase().includes('expected'));

// A draft in progress must win over the saved value, or a counter's keystrokes
// get overwritten by the last save on every re-render.
const drafting = renderSheetRow(countedZero, { draft: '7.' });
ok('a half-typed draft survives a re-render', /value="7\."/.test(drafting));

// The two transient states.
ok('a saving line says so', strip(renderSheetRow(base, { state: 'saving' })).includes('Saving'));
const failed = renderSheetRow(base, {
  state: 'error',
  // Rule 21: the SERVER's sentence and its hint, verbatim. The component writes
  // neither, and this proves it renders what it was handed.
  message:
    'Count ST-000004 is finished and cannot be added to. — Start a new count for this location if the shelves need counting again.',
});
ok('a failed save shows the SERVER\'s message verbatim, hint included',
  strip(failed).includes('cannot be added to') && strip(failed).includes('Start a new count'));
ok('and marks the line as not saved', strip(failed).includes('Not saved'));

// ---------------------------------------------------------------------------
// PART 2 — the finished variance report
// ---------------------------------------------------------------------------
console.log('=== 2. VarianceRow — the report, over PostgREST shapes ===');

const renderVariance = (row: StockTakeSheetRow) =>
  renderToString(
    <table><tbody><VarianceRow row={row} currency="NGN" /></tbody></table>,
  );

// A counted ZERO against 40 expected: the full quantity written off. This is the
// single most consequential line a count can produce.
const wroteOff: StockTakeSheetRow = line({
  take_status: 'finished',
  item_name: 'London dry gin',
  base_unit: 'ltr',
  counted_quantity: '0.0000',
  is_counted: true,
  expected_quantity: '40.0000',
  variance_quantity: '-40.0000',
  variance_unit_cost: '2000.0000',
  variance_value: '-80000.00',
  movement_id: 'm',
});
const wroteOffHtml = renderVariance(wroteOff);
console.log(`\n  wrote off: ${strip(wroteOffHtml)}\n`);

ok('the expected figure appears once the count is finished',
  strip(wroteOffHtml).includes('40'));
ok('the counted ZERO renders as 0, not as blank or "Not counted"',
  !strip(wroteOffHtml).includes('Not counted'));
ok('the difference carries its SIGN', strip(wroteOffHtml).includes('-40'));
ok('and its value is formatted as money', /80,000\.00/.test(strip(wroteOffHtml)),
  strip(wroteOffHtml).slice(-60));

// A shelf nobody counted: no difference, no value — NOT a variance of its full
// quantity, which is the whole partial-count rule.
const skipped: StockTakeSheetRow = line({
  take_status: 'finished',
  counted_quantity: null,
  is_counted: false,
  expected_quantity: '10.0000',
  variance_quantity: null,
  variance_value: null,
});
const skippedHtml = renderVariance(skipped);
console.log(`  not counted: ${strip(skippedHtml)}\n`);
ok('an uncounted line says "Not counted"', strip(skippedHtml).includes('Not counted'));
ok('its difference is the shared dash, NOT its full quantity',
  strip(skippedHtml).includes('—') && !strip(skippedHtml).includes('-10'));

// A shelf that matched.
const matched: StockTakeSheetRow = line({
  take_status: 'finished',
  counted_quantity: '100.0000',
  is_counted: true,
  expected_quantity: '100.0000',
  variance_quantity: '0.0000',
  variance_unit_cost: '1.5000',
  variance_value: '0.00',
});
ok('a line that agreed with the ledger reads "Matches"',
  strip(renderVariance(matched)).includes('Matches'));
ok('and shows no value for it', strip(renderVariance(matched)).includes('—'));

// THE BLIND CASE, in the report component: an ABANDONED count still renders
// through this row, and its expected quantity is null forever (039 §4).
const abandoned: StockTakeSheetRow = line({
  take_status: 'cancelled',
  counted_quantity: '95.0000',
  is_counted: true,
  expected_quantity: null,
  variance_quantity: null,
  variance_value: null,
});
const abandonedHtml = renderVariance(abandoned);
console.log(`  abandoned: ${strip(abandonedHtml)}\n`);
ok('a blind expected renders as the dash, never as 0',
  strip(abandonedHtml).includes('—') && !/(^|\s)0(\s|$)/.test(strip(abandonedHtml)),
  strip(abandonedHtml));
ok('while what WAS counted still shows', strip(abandonedHtml).includes('95'));

// A line whose movement has since been UNDONE (040) — either because the whole
// count was reversed, or because somebody reversed that one movement from the
// item's own ledger. The figures still show what the count FOUND; the row has to
// say that they no longer stand, because the document's status cannot
// distinguish the second case.
const undone: StockTakeSheetRow = { ...wroteOff, movement_reversed: true };
const undoneHtml = renderVariance(undone);
console.log(`  undone: ${strip(undoneHtml)}\n`);
ok('a reversed line says its difference no longer stands',
  strip(undoneHtml).includes('no longer stands'));
ok('but still shows what the count found', strip(undoneHtml).includes('-40'));
ok('while an unreversed line says nothing of the kind',
  !strip(wroteOffHtml).includes('no longer stands'));

// ---------------------------------------------------------------------------
// PART 3 — the 1.1c regression class, pinned on this screen too
// ---------------------------------------------------------------------------
console.log('=== 3. Numerics arriving as NUMBERS, which is what crashed 1.1c ===');

// THE SAME LINE, sent as JSON NUMBERS instead of strings. It used to need four
// `as unknown as string` casts to express, because the row type insisted the
// wire spoke strings; the fixture is wire-shaped now, so this is simply the
// other thing the wire sends — and it goes through the same parser as the first.
const hostileWire = {
  ...baseWire,
  take_status: 'finished',
  item_name: 'London dry gin',
  base_unit: 'ltr',
  is_counted: true,
  movement_id: 'm',
  counted_quantity: 0,
  expected_quantity: 40,
  variance_quantity: -40,
  variance_unit_cost: 2000,
  variance_value: -80000,
};
const hostile = sheetRows.row(hostileWire);

try {
  const html = renderVariance(hostile);
  ok('a report row whose numerics arrive as NUMBERS still renders', true);
  ok('and still shows the right signed difference', strip(html).includes('-40'),
    strip(html).slice(0, 90));
  ok('and a numeric ZERO is still not mistaken for "not counted"',
    !strip(html).includes('Not counted'));
  // The assertion the cast-based version could not make: the two wire shapes are
  // not merely both survivable, they are indistinguishable downstream.
  ok('and renders BYTE-IDENTICALLY to the string-shaped line',
    html === wroteOffHtml);
} catch (e) {
  ok('a report row whose numerics arrive as NUMBERS still renders', false,
    (e as Error).message);
}

try {
  const html = renderSheetRow(
    line({
      counted_quantity: 0,
      is_counted: true,
      counted_at: '2026-08-17T09:00:00Z',
      counted_by: 'u',
    }),
  );
  ok('a sheet row with a NUMERIC zero still renders it as a counted 0',
    strip(html).includes('Counted 0 kg'), strip(html).slice(0, 80));
  // THE ASSERTION THAT CATCHES `|| ''`, and it took breaking the component to
  // find out that it had to be this one. With counted_quantity arriving as the
  // STRING '0.0000' the `||` is harmless — a non-empty string is truthy — so
  // every assertion above stayed green while the bug was in. It is a JSON
  // NUMBER 0 that `||` swallows, and only the input's own value attribute shows
  // it: the status text beside the field reads "Counted 0 kg" either way,
  // because it comes from is_counted rather than from the field.
  ok('and KEEPS THE 0 IN THE FIELD rather than emptying it',
    /value="0"/.test(html), html.match(/value="[^"]*"/)?.[0] ?? '(no value attr)');
} catch (e) {
  ok('a sheet row with a NUMERIC zero still renders', false, (e as Error).message);
}

// ---------------------------------------------------------------------------
// PART 4 — the mid-count confirmation (041)
// ---------------------------------------------------------------------------
console.log('=== 4. FinishConfirmation — the server\'s words, and two ways out ===');

// The exact string the client receives: message + hint, joined by
// stockErrorMessage. It names the items, and only the server knows them.
const serverSays =
  'Stock moved in this location while this count was running, and 2 of the items ' +
  'you counted were counted AFTER it moved: London dry gin, Long grain rice. ' +
  'Counting a shelf after a delivery has been put on it records that delivery ' +
  'twice — once as the receipt, and again as a difference the count appears to ' +
  'have found. — Check those shelves against their movements. Clear the affected ' +
  'lines and count them again, or confirm to finish anyway and record the ' +
  'differences exactly as they stand.';

const confirmHtml = renderToString(
  <FinishConfirmation
    message={serverSays}
    busy={false}
    onConfirm={() => {}}
    onCancel={() => {}}
  />,
);
console.log(`\n  confirmation: ${strip(confirmHtml).slice(0, 150)}…\n`);

ok('it renders the server\'s sentence VERBATIM, item names included',
  strip(confirmHtml).includes('London dry gin, Long grain rice'));
ok('including the hint the server appended',
  strip(confirmHtml).includes('Clear the affected lines and count them again'));
ok('it offers going back to check', strip(confirmHtml).includes('Go back and check'));
ok('and finishing anyway', strip(confirmHtml).includes('Finish anyway'));
// The client must not author the rule. If a future edit starts explaining the
// double-count in its own words, this catches it: the only prose on the panel
// is the heading and the two buttons.
ok('the panel writes no rule of its own',
  !strip(confirmHtml.replace(serverSays, '')).toLowerCase().includes('delivery'),
  strip(confirmHtml.replace(serverSays, '')));
ok('while busy, both buttons are disabled',
  (renderToString(
    <FinishConfirmation message={serverSays} busy onConfirm={() => {}} onCancel={() => {}} />,
  ).match(/disabled=""/g) ?? []).length === 2);

console.log(`\n================  ${pass} PASSED, ${fail} FAILED  ================`);
process.exit(fail ? 1 : 0);
