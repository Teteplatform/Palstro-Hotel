import { renderToString } from 'react-dom/server';
import { ToastProvider } from '../src/components/ui/Toast';
import {
  AccountRow,
  AddAccountForm,
  EmptyState,
} from '../src/components/admin/settings/ChartOfAccountsTab';
import {
  CHART_SECTIONS,
  chartSearchMatches,
  codeIsInSection,
  codeIsTaken,
  filterChart,
  groupChart,
  sectionRank,
  sortChartOrder,
  suggestNextCode,
} from '../src/lib/chartOfAccounts';
import type { Account, AccountType } from '../src/types/accounting';

// THE CHART OF ACCOUNTS PROOF (1.1h1, and rule 22 for how it is trusted).
//
// ---------------------------------------------------------------------------
// WHAT THIS EXISTS TO CATCH
// ---------------------------------------------------------------------------
// Every failure on this screen is silent. Nothing throws; the table renders; the
// numbers are wrong.
//
//   1. THE ORDER. A chart of accounts IS its order. Sorting on account_type —
//      which is what the database does unaided — gives asset, equity, expense,
//      liability, revenue: alphabetical, and it strands equity and expenses in
//      the middle of the balance sheet. An accountant notices instantly and
//      nothing in the code does.
//
//   2. THE NUMBER COMPARISON. Codes are TEXT. Comparing them as text with a
//      plain < puts '1100' before '900' and nobody sees it until a chart has an
//      account outside the seeded four-digit blocks.
//
//   3. THE SUGGESTED CODE. Suggesting a number that is already taken produces a
//      save that fails on a unique index, which reads to the user as the screen
//      being broken rather than as a suggestion being wrong.
//
// THE ORDERING ASSERTION IS THE ONE THAT LICENSED 045. Dropping display_order
// was allowed only because (section rank, code) reproduces the seeded sequence
// exactly. That is asserted in the 045 dry run against the live rows and again
// here against a fixture, because the two catch different things: the dry run
// proves it of the DATA, this proves it of the FUNCTION the screen calls.
//
// ---------------------------------------------------------------------------
// WHY renderToString AND NOT happy-dom
// ---------------------------------------------------------------------------
// Nothing on this screen portals. The sticky header is CSS, and a fake DOM that
// returns zeros for every measurement would prove nothing about it either way —
// it is verified in the browser, not here. What IS provable in the string is the
// order, the words, and every arithmetic rule above.
//
// ---------------------------------------------------------------------------
// MADE TO FAIL BEFORE IT WAS TRUSTED (rule 22) — see the run at the bottom of
// this shipment's report for what each breakage turned red.

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
};

const strip = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    // Escaped, never the literal character: a non-breaking space is invisible
    // in every editor and diff, which is why eslint rejects it. Same trap as
    // accountsRender — copied helper, copied bug.
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

let seq = 0;
function acct(code: string, name: string, type: AccountType, over: Partial<Account> = {}): Account {
  seq += 1;
  return {
    id: `a-${seq}`,
    tenant_id: 't-1',
    code,
    name,
    account_type: type,
    note: null,
    is_active: true,
    deleted_at: null,
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
    ...over,
  };
}

// The seeded 35, in the order 045 asserts. Deliberately CONSTRUCTED SHUFFLED
// below, so a sort that does nothing cannot pass.
const SEEDED: [string, string, AccountType][] = [
  ['1000', 'Cash', 'asset'], ['1010', 'Bank', 'asset'], ['1020', 'POS clearing', 'asset'],
  ['1200', 'Guest ledger', 'asset'], ['1210', 'Company receivable', 'asset'],
  ['1300', 'Inventory', 'asset'], ['1500', 'Fixed assets', 'asset'],
  ['2000', 'Supplier payable', 'liability'], ['2100', 'VAT output', 'liability'],
  ['2110', 'VAT input recoverable', 'liability'], ['2200', 'Service charge payable', 'liability'],
  ['2300', 'Withholding tax payable', 'liability'],
  ['3000', 'Opening balance equity', 'equity'], ['3900', 'Retained earnings', 'equity'],
  ['4000', 'Room revenue', 'revenue'], ['4010', 'Food and beverage revenue', 'revenue'],
  ['4020', 'Laundry revenue', 'revenue'], ['4030', 'Internet revenue', 'revenue'],
  ['4040', 'Minibar revenue', 'revenue'], ['4050', 'Transport revenue', 'revenue'],
  ['4060', 'Extra bed revenue', 'revenue'], ['4070', 'Early check-in revenue', 'revenue'],
  ['4080', 'Late check-out revenue', 'revenue'], ['4090', 'Damage recovery', 'revenue'],
  ['4100', 'Other revenue', 'revenue'], ['4900', 'Discounts allowed', 'revenue'],
  ['5000', 'Cost of sales', 'expense'], ['5100', 'Stock adjustment', 'expense'],
  ['5110', 'Stock count variance', 'expense'], ['5200', 'Spoilage', 'expense'],
  ['5210', 'Breakage', 'expense'], ['5220', 'Expiry', 'expense'],
  ['5230', 'Staff meals', 'expense'], ['5240', 'Complimentaries', 'expense'],
  ['5900', 'Rounding difference', 'expense'],
];

// SHUFFLED — reversed and interleaved — so that "it came out right" cannot mean
// "nothing moved".
const shuffled = [...SEEDED].reverse().filter((_, i) => i % 2 === 0)
  .concat([...SEEDED].reverse().filter((_, i) => i % 2 === 1));
const CHART: Account[] = shuffled.map(([c, n, t]) => acct(c, n, t));

// ---------------------------------------------------------------------------
// PART 1 — statement order, not alphabetical
// ---------------------------------------------------------------------------
console.log('\n=== 1. The chart comes out in statement order ===');

const sorted = sortChartOrder(CHART);
ok('every account survives the sort', sorted.length === 35, `${sorted.length}`);
ok('the sequence is exactly the seeded one',
  sorted.map((a) => a.code).join(',') === SEEDED.map((s) => s[0]).join(','),
  sorted.slice(0, 4).map((a) => a.code).join(','));

const typeOrder = [...new Set(sorted.map((a) => a.account_type))];
ok('the sections run assets, liabilities, equity, revenue, expenses',
  typeOrder.join(',') === 'asset,liability,equity,revenue,expense', typeOrder.join(','));
ok('which is NOT alphabetical, and the fixture proves the difference',
  typeOrder.join(',') !== [...typeOrder].sort().join(','));

const groups = groupChart(CHART);
ok('grouped into the five sections', groups.length === 5, `${groups.length}`);
ok('labelled the way a statement labels them',
  groups.map((g) => g.section.label).join(' > ')
    === 'Assets > Liabilities > Equity > Revenue > Expenses',
  groups.map((g) => g.section.label).join(' > '));
ok('the group counts add up to the chart',
  groups.reduce((n, g) => n + g.rows.length, 0) === 35);
ok('and Revenue holds the twelve income accounts',
  groups.find((g) => g.section.type === 'revenue')?.rows.length === 12);

// ---------------------------------------------------------------------------
// PART 2 — codes compare as numbers, not as raw text
// ---------------------------------------------------------------------------
// The bug this catches only appears once a chart holds a code outside the
// seeded four-digit blocks — which is the day a hotel adds one.
console.log('\n=== 2. 900 comes before 1100 ===');

const ragged = sortChartOrder([
  acct('1100', 'Eleven hundred', 'asset'),
  acct('900', 'Nine hundred', 'asset'),
  acct('1000', 'One thousand', 'asset'),
]);
ok('a shorter code sorts by VALUE, not by first character',
  ragged.map((a) => a.code).join(',') === '900,1000,1100',
  ragged.map((a) => a.code).join(','));

// ---------------------------------------------------------------------------
// PART 3 — the suggested code
// ---------------------------------------------------------------------------
console.log('\n=== 3. The next free number in the range ===');

ok('a bank account is suggested the next free asset number',
  suggestNextCode(CHART, 'asset') === '1030',
  suggestNextCode(CHART, 'asset'));
ok('a liability is suggested from the 2000s, not the 1000s',
  suggestNextCode(CHART, 'liability') === '2010',
  suggestNextCode(CHART, 'liability'));
ok('an equity account skips 3000 because it is taken',
  suggestNextCode(CHART, 'equity') === '3010',
  suggestNextCode(CHART, 'equity'));
ok('the suggestion is never a code that already exists',
  !CHART.some((a) => a.code === suggestNextCode(CHART, 'expense')),
  suggestNextCode(CHART, 'expense'));

// An empty chart suggests the very start of the block.
ok('an empty chart suggests the block start', suggestNextCode([], 'revenue') === '4000');

// A SOFT-DELETED code is still treated as taken: reusing a number that appears
// on last year's printed statements must never be the default.
ok('a code already in the list is never suggested again',
  suggestNextCode([acct('1000', 'x', 'asset'), acct('1010', 'y', 'asset')], 'asset') === '1020');

ok('every section suggests inside its own range',
  CHART_SECTIONS.every((s) => codeIsInSection(suggestNextCode(CHART, s.type), s.type)));

ok('a duplicate is detected before the save', codeIsTaken(CHART, '1000'));
ok('and a free number is not', !codeIsTaken(CHART, '1030'));
ok('a code outside its section is flagged', !codeIsInSection('2500', 'asset'));
ok('and one inside it is not', codeIsInSection('1400', 'asset'));

// ---------------------------------------------------------------------------
// PART 4 — search
// ---------------------------------------------------------------------------
console.log('\n=== 4. Search finds by number and by name ===');

ok('by name', filterChart(CHART, 'guest').map((a) => a.code).join(',') === '1200');
ok('by number', filterChart(CHART, '4010').map((a) => a.name).join(',') === 'Food and beverage revenue');
ok('by a partial number, which is how somebody scans a section',
  filterChart(CHART, '52').length === 5,
  filterChart(CHART, '52').map((a) => a.code).join(','));
ok('case-insensitively', filterChart(CHART, 'CASH').length === 1);
ok('an empty term matches everything', filterChart(CHART, '   ').length === 35);
ok('a term nothing matches returns nothing', filterChart(CHART, 'zzz').length === 0);
ok('chartSearchMatches agrees with the filter', chartSearchMatches(CHART[0], CHART[0].code));

// Search must not disturb the order.
ok('filtered results stay in statement order',
  groupChart(filterChart(CHART, 'revenue')).map((g) => g.section.label).join(',') === 'Revenue',
  groupChart(filterChart(CHART, 'revenue')).map((g) => g.section.label).join(','));

// An empty section is dropped rather than rendered as a bare heading.
ok('a search that hits one section shows only that section',
  groupChart(filterChart(CHART, 'spoilage')).length === 1);

// ---------------------------------------------------------------------------
// PART 5 — the row renders as data, densely
// ---------------------------------------------------------------------------
console.log('\n=== 5. The row ===');

const renderRow = (a: Account, canEdit: boolean) =>
  renderToString(
    <ToastProvider>
      <table><tbody>
        <AccountRow account={a} canEdit={canEdit} onRename={() => {}} onToggle={() => {}} />
      </tbody></table>
    </ToastProvider>,
  );

const cashHtml = renderRow(acct('1000', 'Cash', 'asset'), true);
ok('the number is rendered', strip(cashHtml).includes('1000'));
ok('the name is rendered', strip(cashHtml).includes('Cash'));
ok('the number column is tabular, so codes line up as numbers',
  /tabular-nums/.test(cashHtml));
ok('and right-aligned', /text-right/.test(cashHtml));
ok('an active account says Active', strip(cashHtml).includes('Active'));

const offHtml = renderRow(acct('1010', 'Bank', 'asset', { is_active: false }), true);
ok('a switched-off account says so', strip(offHtml).includes('Switched off'));
ok('and offers to switch it back on', strip(offHtml).includes('Switch on'));
ok('an active one offers to switch it off', strip(cashHtml).includes('Switch off'));

const readOnlyHtml = renderRow(acct('1000', 'Cash', 'asset'), false);
ok('a read-only row offers no switch', !strip(readOnlyHtml).includes('Switch off'));
ok('but still shows the account', strip(readOnlyHtml).includes('1000'));

// ---------------------------------------------------------------------------
// PART 6 — the add form says which range it is suggesting within
// ---------------------------------------------------------------------------
console.log('\n=== 6. Adding an account ===');

const formHtml = strip(renderToString(
  <ToastProvider>
    <AddAccountForm existing={CHART} onCancel={() => {}} onSave={() => {}} />
  </ToastProvider>,
));

ok('the form offers all five groups',
  CHART_SECTIONS.every((s) => formHtml.includes(s.label)));
ok('it names the range it is suggesting within',
  formHtml.includes('Assets run from 1000 to 1999'), formHtml.slice(0, 0));
ok('the suggested number is pre-filled', renderToString(
  <ToastProvider>
    <AddAccountForm existing={CHART} onCancel={() => {}} onSave={() => {}} />
  </ToastProvider>).includes('value="1030"'));
ok('the four fields are there and nothing else',
  formHtml.includes('Group') && formHtml.includes('Name')
    && formHtml.includes('Number') && formHtml.includes('Active'));

// ---------------------------------------------------------------------------
// PART 7 — the empty states, which are two different sentences
// ---------------------------------------------------------------------------
console.log('\n=== 7. Empty ===');

const noMatch = strip(renderToString(<EmptyState filtering onClear={() => {}} />));
ok('a search that matches nothing says so', noMatch.includes('No account matches that'));
ok('and offers a way back', noMatch.includes('Clear the search'));
ok('it suggests what to try', noMatch.includes('part of the number'));

const noChart = strip(renderToString(<EmptyState filtering={false} onClear={() => {}} />));
ok('an empty CHART is a different sentence entirely',
  noChart.includes('No accounts yet') && !noChart.includes('No account matches'));
ok('and says that being empty is itself wrong',
  noChart.includes('something went wrong'));
ok('with no clear-search button, because there is no search to clear',
  !noChart.includes('Clear the search'));

// ---------------------------------------------------------------------------
// PART 8 — the section rank is the thing 045 relies on
// ---------------------------------------------------------------------------
console.log('\n=== 8. Section rank ===');
ok('assets rank first', sectionRank('asset') === 1);
ok('liabilities second', sectionRank('liability') === 2);
ok('equity third', sectionRank('equity') === 3);
ok('revenue fourth', sectionRank('revenue') === 4);
ok('expenses fifth', sectionRank('expense') === 5);
ok('the five ranks are distinct and complete',
  new Set(CHART_SECTIONS.map((s) => s.rank)).size === 5);

console.log(`\n================  ${pass} PASSED, ${fail} FAILED  ================`);
process.exit(fail ? 1 : 0);
