import { renderToString } from 'react-dom/server';
import { ToastProvider } from '../src/components/ui/Toast';
import { MappingTableRow } from '../src/components/admin/settings/AccountsPanel';
import {
  groupMappings,
  neverPostedCount,
  roleKeyLabel,
} from '../src/lib/accounting';
import { formatDisplayDate } from '../src/lib/date';
import type { AccountMappingStatus } from '../src/types/accounting';

// THE ACCOUNTS TAB PROOF (1.1h, and rule 22 for how it is trusted).
//
// ---------------------------------------------------------------------------
// WHAT THIS EXISTS TO CATCH, AND IT IS NOT A CRASH
// ---------------------------------------------------------------------------
// The Accounts tab has one column worth reading — LAST POSTED — and one job:
// saying, truthfully, where each kind of money goes. Both failure modes are
// silent and both look completely normal on screen:
//
//   1. "NEVER" RENDERED AS A DATE, OR A DATE RENDERED AS "NEVER". last_posted_on
//      is NULL for a key nothing has ever posted through, and that NULL is the
//      entire signal that a posting site is unwired. A formatter that turns null
//      into today's date, or an empty string, or the epoch, destroys the one
//      thing this screen is for — and nothing throws, because every other cell
//      still renders.
//
//   2. THE WRONG MAPPING SHOWN AS EFFECTIVE. A property override must win over
//      the tenant default, exactly as resolve_account decides it in SQL. Show
//      the default where an override exists and an owner reads that their second
//      hotel's cash posts to the group till — a sentence that is wrong, specific,
//      and impossible to distinguish from the truth by looking.
//
// Neither is reachable by a SQL proof: 044's dry run proves resolve_account picks
// the override, and proves the view reports NULL. What it cannot prove is what
// the browser does with that JSON — which is rule 22's whole point, and rule 24's
// corollary: line_count arrives as a JSON NUMBER (int8) while every numeric
// beside it in this app arrives as a STRING, and only the browser ever sees that.
//
// ---------------------------------------------------------------------------
// WHY renderToString AND NOT happy-dom
// ---------------------------------------------------------------------------
// The one floating layer on this screen is the account picker's panel, and that
// is Typeahead — already proven, portal and all, by proofs/pickerRender. What is
// unproven HERE is the pairing arithmetic and the words, both of which are in the
// server-rendered string. The string is also the harsher test for this screen:
// it catches a value that is computed correctly and then never displayed.
//
// ---------------------------------------------------------------------------
// MADE TO FAIL BEFORE IT WAS TRUSTED (rule 22)
// ---------------------------------------------------------------------------
//   1. groupMappings changed to `existing.effective = existing.fallback ?? existing.override`
//      — the override losing to the default, which is the wrong-mapping bug above.
//      SEVEN assertions went RED: the effective account id, the account shown on
//      the rendered row, the last-posted date in two directions, and both
//      neverPostedCount checks. The fixture gives the override and the default
//      DIFFERENT dates for exactly this reason — with the same date on both, four
//      of those seven could not have moved.
//   2. The "Never" branch changed to render the shared em-dash instead. TWO
//      assertions went RED. The dash reads as "no value"; this cell means
//      "nothing has ever posted here". They are not the same sentence, and this
//      screen is the one place the difference decides whether somebody notices a
//      module was never wired.
//   3. neverPostedCount changed to count rows whose FALLBACK never posted rather
//      than whose EFFECTIVE never posted. TWO assertions went red — AND THE MAIN
//      SUMMARY ASSERTION STAYED GREEN, which is the finding rather than a
//      footnote. In the main fixture cash's default has also posted, so counting
//      defaults gives the same total of 1: the headline number cannot see this
//      bug at all. What catches it is the pair of two-row fixtures at the end of
//      PART 5, built for that one purpose. A proof of a total is not a proof of
//      the rule that produced it, and the totals here are the assertions most
//      likely to be mistaken for coverage they do not have.
//   4. The leftover-key branch deleted from groupMappings. THREE assertions went
//      RED: an unrecognised key vanished from the screen entirely. That is the
//      one this proof was least likely to have caught by accident — a mapping the
//      screen cannot show is a mapping nobody can change, and 1.1h2 adds keys
//      this file's MAPPING_GROUPS list will not know about on the day it lands.

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

// Intl and the entity encoder both bite here: renderToString emits &#x27; for an
// apostrophe and &amp; for an ampersand, and "Food & Beverage" is a real label.
const strip = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    // WRITTEN AS AN ESCAPE, not as the character itself. A literal non-breaking
    // space here is invisible in every editor and every diff, and eslint rejects
    // it for exactly that reason — the first version of this line held one and
    // looked identical to this one on screen.
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// ---------------------------------------------------------------------------
// The fixture
// ---------------------------------------------------------------------------
// Shaped like the view: every field the boundary declares, with line_count as a
// NUMBER (int8 over PostgREST) and last_posted_on as a string-or-null.
const TENANT = 't-1';
const PROPERTY = 'p-2';

function row(over: Partial<AccountMappingStatus>): AccountMappingStatus {
  return {
    mapping_id: 'm-' + (over.role_key ?? 'x') + (over.property_id ? '-ov' : ''),
    tenant_id: TENANT,
    property_id: null,
    role_key: 'cash',
    account_id: 'a-1000',
    note: null,
    account_code: '1000',
    account_name: 'Cash',
    account_type: 'asset',
    account_is_active: true,
    last_posted_on: null,
    line_count: 0,
    ...over,
  };
}

const ROWS: AccountMappingStatus[] = [
  // A tenant default that HAS posted.
  row({
    role_key: 'guest_ledger',
    account_id: 'a-1200',
    account_code: '1200',
    account_name: 'Guest ledger',
    last_posted_on: '2026-08-19',
    line_count: 412,
  }),
  // A key with BOTH a default and a property override, each posted on a
  // DIFFERENT day — so an assertion on the date can tell which one won.
  row({
    role_key: 'cash',
    account_id: 'a-1000',
    account_code: '1000',
    account_name: 'Cash',
    last_posted_on: '2026-08-01',
    line_count: 90,
  }),
  row({
    role_key: 'cash',
    property_id: PROPERTY,
    account_id: 'a-1001',
    account_code: '1001',
    account_name: 'Bonny Island till',
    last_posted_on: '2026-08-22',
    line_count: 7,
  }),
  // Never posted — the signal this screen exists for.
  row({
    role_key: 'wastage_spoilage',
    account_id: 'a-5200',
    account_code: '5200',
    account_name: 'Spoilage',
    account_type: 'expense',
  }),
  // Mapped to an account somebody switched off. resolve_account refuses to post
  // through it, so the screen has to say so.
  row({
    role_key: 'revenue_fnb',
    account_id: 'a-4010',
    account_code: '4010',
    account_name: 'Food & Beverage revenue',
    account_type: 'revenue',
    account_is_active: false,
    last_posted_on: '2026-07-30',
    line_count: 55,
  }),
  // A key MAPPING_GROUPS has never heard of — what 1.1h2 and a tenant's own key
  // both look like on the day they arrive.
  row({
    role_key: 'revenue_spa',
    account_id: 'a-4110',
    account_code: '4110',
    account_name: 'Spa revenue',
    account_type: 'revenue',
    last_posted_on: '2026-08-20',
    line_count: 3,
  }),
];

const groups = groupMappings(ROWS);

const render = (node: React.ReactNode) =>
  renderToString(
    <ToastProvider>
      <table>
        <tbody>{node}</tbody>
      </table>
    </ToastProvider>,
  );

// ---------------------------------------------------------------------------
// PART 1 — the override wins, exactly as resolve_account decides it
// ---------------------------------------------------------------------------
console.log('\n=== 1. Which mapping is effective ===');

const cash = groups
  .flatMap((g) => g.rows)
  .find((r) => r.roleKey === 'cash');

ok('the cash row pairs its default and its override', !!cash?.fallback && !!cash?.override);
ok('the OVERRIDE is effective, not the default',
  cash?.effective?.account_id === 'a-1001',
  `got ${cash?.effective?.account_id}`);
ok('and it is the override that supplies the last-posted date',
  cash?.effective?.last_posted_on === '2026-08-22',
  `got ${cash?.effective?.last_posted_on}`);

const cashHtml = strip(
  render(
    <MappingTableRow
      row={cash!}
      tenantId={TENANT}
      canEdit={false}
      busy={false}
      onRepoint={() => {}}
      onAddOverride={() => {}}
      onDropOverride={() => {}}
    />,
  ),
);

ok('the rendered row shows the override account', cashHtml.includes('1001 · Bonny Island till'));
ok('it says the override applies to this property only',
  cashHtml.includes('This property only'));
ok('and it NAMES the group account being overridden, so the choice is legible',
  cashHtml.includes('1000 · Cash'));

// ---------------------------------------------------------------------------
// PART 2 — "Never" is a word, and it is not a dash
// ---------------------------------------------------------------------------
// A missing FIGURE renders as the shared em-dash (§6). A key nothing has ever
// posted through is not a missing figure — it is a known, meaningful state, and
// it earns a word. Collapsing the two would hide the one signal this column
// carries.
console.log('\n=== 2. Nothing has ever posted here ===');

const spoilage = groups.flatMap((g) => g.rows).find((r) => r.roleKey === 'wastage_spoilage');
const spoilageHtml = strip(
  render(
    <MappingTableRow
      row={spoilage!}
      tenantId={TENANT}
      canEdit={false}
      busy={false}
      onRepoint={() => {}}
      onAddOverride={() => {}}
      onDropOverride={() => {}}
    />,
  ),
);

ok('a key nothing has posted through says Never', spoilageHtml.includes('Never'));
ok('and NOT the missing-value em-dash, which means something else',
  !spoilageHtml.includes('—'));
ok('the row still shows its account, so the screen does not collapse',
  spoilageHtml.includes('5200 · Spoilage'));

const ledger = groups.flatMap((g) => g.rows).find((r) => r.roleKey === 'guest_ledger');
const ledgerHtml = strip(
  render(
    <MappingTableRow
      row={ledger!}
      tenantId={TENANT}
      canEdit={false}
      busy={false}
      onRepoint={() => {}}
      onAddOverride={() => {}}
      onDropOverride={() => {}}
    />,
  ),
);
ok('a key that HAS posted shows a date, not the word', !ledgerHtml.includes('Never'));

// THE EXPECTED STRING COMES FROM formatDisplayDate, NOT FROM A LITERAL, and the
// first version of this assertion did the opposite and went red for the wrong
// reason. It asserted '19 Aug 2026'; Node's default ICU locale renders
// 'Aug 19, 2026'. The code was right and the proof was wrong — a red that costs a
// round trip and teaches nothing.
//
// This is not the tautology the 1.1g receipt preview was. What is under test here
// is the WIRING — does the row display the effective mapping's last_posted_on —
// not whether date.ts formats correctly, which is date.ts's own concern and has
// its own callers. The assertion that carries the weight is the NEGATIVE one
// below: the row must show the override's date and must NOT show the default's.
ok('and the date is the business date it was given',
  ledgerHtml.includes(formatDisplayDate('2026-08-19')),
  `looking for ${formatDisplayDate('2026-08-19')}`);
ok('the cash row shows the OVERRIDE date',
  cashHtml.includes(formatDisplayDate('2026-08-22')));
ok('and NOT the tenant default it overrides',
  !cashHtml.includes(formatDisplayDate('2026-08-01')));

// ---------------------------------------------------------------------------
// PART 3 — a deactivated account is called out
// ---------------------------------------------------------------------------
// resolve_account skips an inactive account, so a mapping pointing at one is a
// posting that will be refused. The row that would fail has to say so where
// somebody can see it, not only when the refusal reaches the front desk.
console.log('\n=== 3. A mapping pointing at a switched-off account ===');

const fnb = groups.flatMap((g) => g.rows).find((r) => r.roleKey === 'revenue_fnb');
const fnbHtml = strip(
  render(
    <MappingTableRow
      row={fnb!}
      tenantId={TENANT}
      canEdit={false}
      busy={false}
      onRepoint={() => {}}
      onAddOverride={() => {}}
      onDropOverride={() => {}}
    />,
  ),
);

ok('the row warns that the account is switched off',
  fnbHtml.includes('switched off'));
ok('and says what that means: postings here will be refused',
  fnbHtml.includes('refused'));
ok('the ampersand in the account name survives encoding',
  fnbHtml.includes('Food & Beverage revenue'));

// ---------------------------------------------------------------------------
// PART 4 — an unrecognised key is SHOWN, never dropped
// ---------------------------------------------------------------------------
// 1.1h2 adds keys. A tenant may add their own. MAPPING_GROUPS decides ORDER and
// WORDING, never membership — a mapping the screen cannot show is a mapping
// nobody can change, and it would be invisible rather than obviously missing.
console.log('\n=== 4. A key this version does not know ===');

const allKeys = groups.flatMap((g) => g.rows.map((r) => r.roleKey));
ok('the unrecognised key is somewhere on the screen', allKeys.includes('revenue_spa'));
ok('it lands in the Other group rather than inventing one per key',
  groups.find((g) => g.group.id === 'other')?.rows.some((r) => r.roleKey === 'revenue_spa') === true);
ok('every fixture row reached the screen', allKeys.length === 5,
  `${allKeys.length} rows for 5 distinct keys`);

const spa = groups.flatMap((g) => g.rows).find((r) => r.roleKey === 'revenue_spa');
const spaHtml = strip(
  render(
    <MappingTableRow
      row={spa!}
      tenantId={TENANT}
      canEdit={false}
      busy={false}
      onRepoint={() => {}}
      onAddOverride={() => {}}
      onDropOverride={() => {}}
    />,
  ),
);
ok('an unlabelled key shows its raw key rather than inventing a name',
  spaHtml.includes('revenue_spa'));
ok('roleKeyLabel falls back to the key itself', roleKeyLabel('revenue_spa') === 'revenue_spa');
ok('and a known key is given its human label', roleKeyLabel('guest_ledger') === 'Guest ledger');

// ---------------------------------------------------------------------------
// PART 5 — the one summary figure
// ---------------------------------------------------------------------------
// Hand-counted against the fixture, NOT re-derived from the same fold the screen
// uses — a proof that recomputes the thing it is checking cannot fail. (That is
// the 1.1g lesson: breaking previewReceipt to an unweighted mean left 35/35
// green because the assertions rebuilt the answer from their own constants.)
//
// Five distinct keys. guest_ledger posted, cash posted (via its override),
// revenue_fnb posted, revenue_spa posted, wastage_spoilage never. So: 1.
console.log('\n=== 5. How many have never had anything posted ===');

ok('exactly one mapping has never been posted through', neverPostedCount(groups) === 1,
  `got ${neverPostedCount(groups)}`);

// The override is what decides this for `cash`, and that is worth its own
// assertion: counting the DEFAULT's history would call this key "never posted"
// at a property whose own till has been used all week — or the reverse.
const cashOnly = groupMappings([
  row({ role_key: 'cash', last_posted_on: null, line_count: 0 }),
  row({
    role_key: 'cash',
    property_id: PROPERTY,
    account_id: 'a-1001',
    account_code: '1001',
    account_name: 'Bonny Island till',
    last_posted_on: '2026-08-22',
    line_count: 7,
  }),
]);
ok('a key whose OVERRIDE has posted is not counted as never posted',
  neverPostedCount(cashOnly) === 0, `got ${neverPostedCount(cashOnly)}`);

const overrideNever = groupMappings([
  row({ role_key: 'cash', last_posted_on: '2026-08-01', line_count: 90 }),
  row({
    role_key: 'cash',
    property_id: PROPERTY,
    account_id: 'a-1001',
    account_code: '1001',
    account_name: 'Bonny Island till',
    last_posted_on: null,
    line_count: 0,
  }),
]);
ok('and a key whose override has NOT posted is counted, even though the default has',
  neverPostedCount(overrideNever) === 1, `got ${neverPostedCount(overrideNever)}`);

// ---------------------------------------------------------------------------
// PART 6 — a key with no mapping at all
// ---------------------------------------------------------------------------
// The seed cannot produce this, but a tenant can delete a mapping — and 044
// grants exactly that policy, because removing an override is the only way back
// to the default. The row that results must read as broken, not as loading.
console.log('\n=== 6. A role key with nothing mapped ===');

const orphanHtml = strip(
  render(
    <MappingTableRow
      row={{ roleKey: 'supplier_payable', fallback: null, override: null, effective: null }}
      tenantId={TENANT}
      canEdit
      busy={false}
      onRepoint={() => {}}
      onAddOverride={() => {}}
      onDropOverride={() => {}}
    />,
  ),
);
ok('an unmapped key says it is not mapped', orphanHtml.includes('Not mapped'));
ok('and says what will happen: anything posting there is refused',
  orphanHtml.includes('refused'));
ok('it still names the key, so somebody can go and map it',
  orphanHtml.includes('Suppliers'));

// ---------------------------------------------------------------------------
// PART 7 — the controls a non-admin is not offered
// ---------------------------------------------------------------------------
// Rule 19's shape: this hides a control, the RLS policy is the guard. Worth an
// assertion because the failure is invisible — a read-only user seeing an
// override button gets a refusal from the database and no idea why.
console.log('\n=== 7. Read-only rendering ===');

const readOnly = strip(
  render(
    <MappingTableRow
      row={ledger!}
      tenantId={TENANT}
      canEdit={false}
      busy={false}
      onRepoint={() => {}}
      onAddOverride={() => {}}
      onDropOverride={() => {}}
    />,
  ),
);
ok('a read-only row offers no way to change the account',
  !readOnly.includes('Use a different account here'));
ok('but still shows which account it is', readOnly.includes('1200 · Guest ledger'));

const editable = strip(
  render(
    <MappingTableRow
      row={ledger!}
      tenantId={TENANT}
      canEdit
      busy={false}
      onRepoint={() => {}}
      onAddOverride={() => {}}
      onDropOverride={() => {}}
    />,
  ),
);
ok('an admin row offers the property override',
  editable.includes('Use a different account here'));

const withOverride = strip(
  render(
    <MappingTableRow
      row={cash!}
      tenantId={TENANT}
      canEdit
      busy={false}
      onRepoint={() => {}}
      onAddOverride={() => {}}
      onDropOverride={() => {}}
    />,
  ),
);
ok('a row that already has an override offers the way back to the group account',
  withOverride.includes('Use the group account'));
ok('and does not also offer to add a second one',
  !withOverride.includes('Use a different account here'));

console.log(`\n================  ${pass} PASSED, ${fail} FAILED  ================`);
process.exit(fail ? 1 : 0);
