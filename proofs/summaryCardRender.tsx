import { renderToString } from 'react-dom/server';
import { InventorySummaryCard } from '../src/components/admin/inventory/InventorySummaryCard';
import { formatMoney } from '../src/lib/format';
import {
  summaryMargin,
  summaryMarginPercent,
  type ProductsSummary,
} from '../src/lib/inventoryProducts';

// THE SUMMARY CARD PROOF (1.1e §2, and rule 22 for how it is trusted).
//
// ---------------------------------------------------------------------------
// THE BUG THIS EXISTS TO CATCH, WHICH IS A WRONG NUMBER AND NOT A CRASH
// ---------------------------------------------------------------------------
// Retail value and margin arrived on this card in this shipment, and the obvious
// way to compute margin is wrong in a way that looks completely plausible:
//
//     margin = retail tile − cost tile
//
// The cost tile covers EVERY position on the shelf. The retail tile covers only
// the positions whose item has a selling price, because the others have no price
// to be valued at. Subtract one from the other and every sack of rice in the store
// is counted as pure loss — a large negative number, on an owner's dashboard, that
// is arithmetically explicable and completely false. Nothing throws. The tiles look
// like tiles.
//
// So this proof does two things a type check cannot: it fixes a summary with a
// known hand-computed answer and asserts the RENDERED TEXT contains it, and it
// asserts the wrong subtraction is NOT what appears.
//
// ---------------------------------------------------------------------------
// WHY renderToString AND NOT happy-dom HERE
// ---------------------------------------------------------------------------
// Nothing on this card floats, portals or listens for a key. What can be wrong is
// arithmetic and words, both of which are in the server-rendered string — and the
// string is the harsher test, because it catches a figure that is computed
// correctly and then not displayed.
//
// The corollary from rule 22 applies to this card in particular: the numbers it
// receives crossed the boundary as a mix of PostgREST strings (numeric) and JSON
// numbers (int8), and ProductsSummary declares every one of them `number`. Feeding
// it numbers here is therefore feeding it what the boundary promises, and the
// boundary's own promise is checked by the compiler in inventoryProducts.
//
// ---------------------------------------------------------------------------
// MADE TO FAIL BEFORE IT WAS TRUSTED (rule 22)
// ---------------------------------------------------------------------------
//   1. summaryMargin changed to `retailValue - totalValue` — THE wrong subtraction.
//      Five assertions went RED, reporting a margin of −500,000 and a margin
//      percentage of −100%. That is what would have shipped onto an owner's
//      dashboard, and it is the reason this file exists.
//   2. The unpriced stock absorbed into retail as if it were priced (retail and
//      retail-cost each raised by the ingredients' ₦758,000, excluded count set to
//      0) — i.e. what treating retail_value as 0 instead of NULL produces. SEVEN
//      assertions went RED, including the excluded count, the sentence explaining
//      it, and the button that leads to the rows behind it. The margin percentage
//      dropped from 51.6% to 20.5% — a plausible-looking figure, which is exactly
//      why the count beside it has to be asserted too.
//   3. The `sub` line dropped from the Tile component. THREE assertions went RED:
//      "before tax" is a UNIT on the figure, and so is "51.6% of retail". A figure
//      whose unit is hidden behind an icon gets misread once per reader.
//   4. summaryMarginPercent's zero-retail guard removed. PART 5 went RED with NaN
//      where a dash belongs — and "nothing priced yet" vanished with it. A property
//      that has priced nothing has NO margin, which is a different statement from a
//      margin of zero.

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}${extra ? ' — ' + extra : ''}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`);
  }
};

// Whitespace collapsed, so an assertion is about the WORDS rather than about the
// markup's indentation. `\s` in a JS regex includes U+00A0, which matters below.
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

const strip = (h: string) =>
  norm(
    h
      .replace(/<[^>]+>/g, ' ')
      .replace(/&#x27;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
      .replace(/&#x2F;/g, '/'),
  );

// THE EXPECTED STRINGS COME FROM THE APP'S OWN FORMATTER, and are normalised the
// same way the rendered text is. Getting here took two wrong turns, both of which
// are rule 22's corollary in new costumes — a formatting fact that exists only in
// the render, invisible to any amount of SQL or type checking:
//
//   1. Hand-typed '₦1,000,000.00' failed against a perfectly correct card, because
//      Intl.NumberFormat renders NGN as 'NGN 1,000,000.00' under Node's ICU here
//      and as '₦1,000,000.00' in a browser carrying the full locale data. So the
//      expected string has to come from the app's formatter, not from a guess about
//      which ICU build is running.
//   2. Even then it failed, on strings that were IDENTICAL to the eye: Intl puts a
//      NON-BREAKING space (U+00A0) between the currency and the number, and strip()
//      had already collapsed the rendered one to an ordinary space. Both sides now
//      go through norm(), so the comparison is about the figure and not about which
//      kind of space ICU chose.
const money = (value: number) => norm(formatMoney(value, 'NGN'));

const render = (summary: ProductsSummary | null) =>
  renderToString(
    <InventorySummaryCard
      summary={summary}
      loading={false}
      currency="NGN"
      scopeName="Main Store"
      onShowLow={() => {}}
      onShowNegative={() => {}}
      onShowUnpriced={() => {}}
    />,
  );

// ---------------------------------------------------------------------------
// THE FIXTURE, WITH THE ARITHMETIC DONE BY HAND
// ---------------------------------------------------------------------------
// A store holding both kinds of stock, which is the only case where the wrong
// subtraction and the right one differ:
//
//   PRICED merchandise (bottled water, beer):
//     cost   ₦242,000.00     retail   ₦500,000.00
//   UNPRICED ingredients (rice, oil) — three items, one of them in two locations:
//     cost   ₦758,000.00     retail   none, because there is no price
//
//   Value at cost   = 242,000 + 758,000 = ₦1,000,000.00   (every position)
//   Retail value    =                      ₦500,000.00    (priced positions only)
//   Margin          = 500,000 − 242,000 =  ₦258,000.00    (the SAME positions)
//   Margin %        = 258,000 / 500,000 =  51.6%
//   Excluded        = 3 items                             (not 4 rows)
//
// THE WRONG ANSWER, kept here on purpose so the assertion can name it:
//   500,000 − 1,000,000 = −₦500,000.00
const SUMMARY: ProductsSummary = {
  itemCount: 12,
  itemsWithStock: 9,
  totalUnits: 1840.5,
  totalValue: 1_000_000,
  belowReorderCount: 2,
  negativeCount: 1,
  retailValue: 500_000,
  retailCostValue: 242_000,
  retailExcludedCount: 3,
};

// ---------------------------------------------------------------------------
// PART 1 — the two money figures are LABELLED so they cannot be confused
// ---------------------------------------------------------------------------
console.log('\n=== 1. Cost and retail, labelled apart ===');

const html = render(SUMMARY);
const text = strip(html);
console.log(`\n  ${text.slice(0, 420)}…\n`);

ok('the cost figure says it is at COST', text.includes('Value at cost'));
ok('the retail figure says it is RETAIL', text.includes('Retail value'));
ok('neither is called just "Stock value"', !/\bStock value\b/.test(text));
ok('the margin has its own tile', text.includes('Margin'));

ok('value at cost renders the whole shelf', text.includes(money(1_000_000)),
  `expected ${money(1_000_000)}`);
ok('retail value renders the priced positions', text.includes(money(500_000)),
  `expected ${money(500_000)}`);

// ---------------------------------------------------------------------------
// PART 2 — THE ASSERTION THIS FILE EXISTS FOR
// ---------------------------------------------------------------------------
console.log('\n=== 2. Margin is retail − the cost of THE SAME positions ===');

ok('summaryMargin is 500,000 − 242,000', summaryMargin(SUMMARY) === 258_000,
  `got ${summaryMargin(SUMMARY)}`);
ok('and the card renders that figure', text.includes(money(258_000)),
  `expected ${money(258_000)}`);

// The two ways of getting it wrong, named and excluded. A component that computed
// either would still render a plausible tile.
ok(
  'it is NOT retail minus the cost tile',
  !text.includes(money(-500_000)),
  `the wrong subtraction would show ${money(-500_000)}`,
);
ok(
  'and NOT retail alone masquerading as margin',
  summaryMargin(SUMMARY) !== SUMMARY.retailValue,
);

const percent = summaryMarginPercent(SUMMARY);
ok('the margin percentage is a share of RETAIL, not of cost',
  percent !== null && Math.abs(percent - 51.6) < 0.05, `got ${percent}`);
ok('and it is rendered beside the figure', text.includes('51.6% of retail'));

// ---------------------------------------------------------------------------
// PART 3 — WHAT WAS LEFT OUT IS COUNTED, AND SAID
// ---------------------------------------------------------------------------
// "A total that silently ignores half the shelf is worse than no total" (§2). The
// count is the size of the hole in the figure above it, and it is a control.
console.log('\n=== 3. The excluded items are counted and reachable ===');

ok('the card says how many items were left out of retail', text.includes('3 items'),
  'expected "3 items … no selling price"');
ok('and says WHY they were left out', text.includes('no selling price'));
ok('and that they are absent from retail', /left out of retail/.test(text));
ok('it is a button, so the count is a way in rather than a dead end',
  (html.match(/<button/g) ?? []).length >= 3,
  `${(html.match(/<button/g) ?? []).length} buttons (excluded, low, negative)`);

// The excluded count must be ITEMS, not position rows: one unpriced item held in
// two locations is one item somebody has to price.
ok('the count is of items and not of rows', !text.includes('4 items'),
  'the fixture has 4 unpriced POSITIONS across 3 items');

// With nothing excluded, the line disappears rather than reading "0 items".
const nothingExcluded = strip(
  render({ ...SUMMARY, retailExcludedCount: 0, belowReorderCount: 0, negativeCount: 0 }),
);
ok('with nothing excluded the line is absent, not "0 items"',
  !nothingExcluded.includes('no selling price'));

// ---------------------------------------------------------------------------
// PART 4 — "before tax" is on the figure, not behind the icon
// ---------------------------------------------------------------------------
// A price in this system is pre-tax, because 021 adds tax on top of a charge's
// net_amount — and that holds even at a property that has switched VAT off, since
// tax_charges.is_compulsory is an ordinary boolean with no CHECK pinning it. Which
// makes "before tax" a UNIT on the retail figure, and a unit hidden behind an ⓘ is
// a figure that gets misread once per reader.
console.log('\n=== 4. The pre-tax caveat is visible without opening anything ===');

ok('retail is marked "before tax" on the card itself', text.includes('before tax'));
ok('and the note behind the small i also says so',
  html.includes('BEFORE tax') || html.includes('before tax'));

// ---------------------------------------------------------------------------
// PART 5 — nothing priced is a DASH, never 0%
// ---------------------------------------------------------------------------
// A property that has priced nothing yet has no margin, which is a different
// statement from a margin of zero. Rule §6's MISSING_VALUE em-dash is the mark for
// the first; "0%" would be a confident answer to a question nobody can answer yet.
console.log('\n=== 5. A property with nothing priced ===');

const UNPRICED: ProductsSummary = {
  ...SUMMARY,
  retailValue: 0,
  retailCostValue: 0,
  retailExcludedCount: 9,
};
const unpricedText = strip(render(UNPRICED));

ok('summaryMarginPercent returns null, not 0', summaryMarginPercent(UNPRICED) === null,
  `got ${summaryMarginPercent(UNPRICED)}`);
ok('the card does not claim a 0% margin', !unpricedText.includes('0.0% of retail'));
ok('it says nothing is priced yet', unpricedText.includes('nothing priced yet'));
ok('and it still shows the value at cost, which is knowable',
  unpricedText.includes(money(1_000_000)));

// ---------------------------------------------------------------------------
// PART 6 — the loading and no-data states show dashes, not zeros
// ---------------------------------------------------------------------------
// A card that renders ₦0.00 while its query is in flight is a wrong figure
// presented with confidence for as long as the network takes.
console.log('\n=== 6. No summary yet ===');

const empty = strip(render(null));
ok('every figure is the shared em-dash while there is no summary',
  (empty.match(/—/g) ?? []).length >= 6,
  `${(empty.match(/—/g) ?? []).length} dashes`);
ok('and not a single confident zero', !empty.includes(money(0)));
ok('the labels are still there, so the card does not collapse',
  empty.includes('Value at cost') && empty.includes('Retail value'));

console.log(`\n================  ${pass} PASSED, ${fail} FAILED  ================`);
process.exit(fail ? 1 : 0);
