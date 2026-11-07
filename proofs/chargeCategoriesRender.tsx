import { renderToString } from 'react-dom/server';
import { ToastProvider } from '../src/components/ui/Toast';
import {
  ChargeCategoryRow,
  NoMappedRevenueNotice,
  toOption,
} from '../src/components/admin/settings/ChargeCategoriesTab';
import { CategoriesHereCell } from '../src/components/admin/settings/AccountsPanel';
import { TakePaymentForm } from '../src/components/admin/folio/TakePaymentForm';
import {
  categoriesByRoleKey,
  orderOfferings,
  MISC_ROLE_KEY,
  NOT_A_CHARGE_DESTINATION,
  type RevenueKeyOption,
} from '../src/lib/chargeCategories';
import { PAYMENT_METHODS, paymentMethodLabel } from '../src/lib/folioLabels';
import type { ChargeCategory } from '../src/types/folio';

// THE FOLIO'S FIRST RENDER PROOF (1.1h4 item 10, and rule 22 for how it is
// trusted). It covers two screens' worth of decisions that SQL cannot reach.
//
// ---------------------------------------------------------------------------
// WHAT THIS EXISTS TO CATCH, AND NONE OF IT IS A CRASH
// ---------------------------------------------------------------------------
//   1. A ROLE KEY SHOWN WITHOUT THE ACCOUNT IT RESOLVES TO. A charge category
//      stores a role key; what the money DOES is decided by the account that
//      key points at. "Miscellaneous" and "4100 Other revenue" are the same
//      choice described two ways, and a picker that offers only the first is
//      the silent choice this whole shipment exists to end. Nothing throws:
//      every row renders, reads cleanly, and tells the owner less than it
//      should.
//
//   2. "NOTHING POSTS HERE" RENDERED THE SAME AS "NOT LOADED YET". On the
//      mapping tab these are different facts about a hotel: a revenue account
//      no category can be billed to is a setup mistake somebody must see, and a
//      table still waking up is a finding about nothing. Render them alike and
//      the first becomes invisible — which is exactly the gap the reverse
//      direction was added to close, so getting it wrong would make the feature
//      cosmetic.
//
//   3. THE PAYMENT PICKER OFFERING A METHOD WITH NO ACCOUNT, or
//      paymentMethodLabel failing to name 'other'. 059 took 'other' off the
//      picker because 044 settled that a missing mapping is a LOUD failure and
//      never a suspense account — so offering it means resolve_account refusing
//      at the counter with a guest standing there. The VALUE is still legal in
//      the database on purpose, so a hotel that recorded one stays
//      representable, which means the LABEL must still name it or a historical
//      payment renders as a raw string on a bill.
//
// WHY renderToString AND NOT happy-dom: every floating layer here is Typeahead,
// already proven portal-and-all by proofs/pickerRender. What is unproven is the
// pairing, the ordering and the WORDS — all of which are in the server-rendered
// string, and the string is the harsher test because it catches a value computed
// correctly and then never displayed.
//
// ---------------------------------------------------------------------------
// MADE TO FAIL BEFORE IT WAS TRUSTED (rule 22) — see the bottom of this file
// ---------------------------------------------------------------------------

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

const strip = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/ /g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const category = (
  over: Partial<ChargeCategory> & Pick<ChargeCategory, 'code' | 'name' | 'account_role_key'>,
): ChargeCategory => ({
  id: `id-${over.code}`,
  tenant_id: 't1',
  is_taxable: true,
  service_chargeable: true,
  is_active: true,
  display_order: 10,
  deleted_at: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  created_by: null,
  updated_by: null,
  ...over,
});

// THE OFFERINGS ARE DELIBERATELY SHUFFLED, and their account codes are chosen
// so that ordering by code and ordering by label DISAGREE. A fixture already in
// the order being asserted cannot tell a sort that works from one that does
// nothing (rule 27's third shape), and one where the two orderings coincide
// cannot tell which rule produced the answer (its fourth).
const offerings: RevenueKeyOption[] = [
  { roleKey: MISC_ROLE_KEY, accountCode: '4100', accountName: 'Other revenue' },
  { roleKey: 'revenue_laundry', accountCode: '4020', accountName: 'Laundry revenue' },
  { roleKey: 'revenue_aardvark', accountCode: '4900', accountName: 'Aardvark hire' },
  { roleKey: 'revenue_room', accountCode: '4000', accountName: 'Room revenue' },
];

console.log('\nPART 1 — the picker shows the ACCOUNT, not only the key');

{
  const opts = orderOfferings(offerings).map(toOption);

  ok(
    '1.1 every option names its account',
    opts.every((o) => /\d{4} · /.test(o.label)),
    opts.map((o) => o.label).join(' | '),
  );
  ok(
    '1.2 and carries the role key as its hint, because that is what refusals name',
    opts.every((o) => o.hint !== undefined && o.hint.startsWith('revenue_')),
    opts.map((o) => o.hint).join(' | '),
  );
  ok(
    '1.3 the option VALUE is the role key, never the account id',
    opts.every((o) => o.value.startsWith('revenue_')),
  );

  // THE ORDERING, which is a ruling rather than a preference: misc is never the
  // first thing offered.
  ok(
    '1.4 Miscellaneous is LAST',
    opts[opts.length - 1].value === MISC_ROLE_KEY,
    opts.map((o) => o.value).join(' > '),
  );
  ok(
    '1.5 and the rest are by account code, so 4000 Room beats 4020 Laundry',
    opts[0].value === 'revenue_room' && opts[1].value === 'revenue_laundry',
    opts.map((o) => o.value).join(' > '),
  );
  // 4900 Aardvark sorts after 4100 Other revenue BY CODE, so if misc were not
  // pushed to the end this assertion and 1.4 would disagree. That is the point
  // of the fixture: the two rules give different answers here.
  ok(
    '1.6 a key whose code sorts AFTER misc still comes before it',
    opts.findIndex((o) => o.value === 'revenue_aardvark') <
      opts.findIndex((o) => o.value === MISC_ROLE_KEY),
    opts.map((o) => o.value).join(' > '),
  );
  ok(
    '1.7 contra-revenue is not a destination a charge can be sent to',
    NOT_A_CHARGE_DESTINATION.includes('discounts_allowed'),
  );
}

console.log('\nPART 2 — a row says where it posts, in both modes');

{
  const row = (c: ChargeCategory, canEdit: boolean) =>
    strip(
      renderToString(
        <ToastProvider>
          <table>
            <tbody>
              <ChargeCategoryRow
                category={c}
                canEdit={canEdit}
                busy={false}
                search={async () => ({ options: [], capped: false })}
                onSave={() => {}}
              />
            </tbody>
          </table>
        </ToastProvider>,
      ),
    );

  const laundry = category({
    code: 'laundry',
    name: 'Laundry',
    account_role_key: 'revenue_laundry',
  });

  const readOnly = row(laundry, false);
  ok('2.1 read-only shows the human label for the key', readOnly.includes('Laundry'), readOnly.slice(0, 120));
  ok(
    '2.2 and shows the RAW KEY too, because that is the string a refusal names',
    readOnly.includes('revenue_laundry'),
  );
  ok('2.3 and the category code, which is permanent', readOnly.includes('laundry'));

  const editable = row(laundry, true);
  ok(
    '2.4 editable still names the chosen key rather than blanking it',
    editable.includes('Laundry'),
    editable.slice(0, 160),
  );

  // A RETIRED CATEGORY STILL SAYS WHERE IT POSTS. Switching one off takes it off
  // the desk's list; it does not move the charges that already used it, so a
  // row that hid its account would hide where real history went.
  const retired = category({
    code: 'minibar',
    name: 'Minibar',
    account_role_key: 'revenue_minibar',
    is_active: false,
  });
  const retiredHtml = row(retired, false);
  ok(
    '2.5 a retired category still shows its account',
    retiredHtml.includes('Minibar') && retiredHtml.includes('revenue_minibar'),
  );
}

console.log('\nPART 3 — "nothing posts here" is not "not loaded yet"');

{
  const cell = (c: Parameters<typeof CategoriesHereCell>[0]['categories']) =>
    strip(renderToString(<CategoriesHereCell categories={c} />));

  const notLoaded = cell(null);
  const empty = cell({ active: [], retired: [] });
  const oneActive = cell({ active: [category({ code: 'room', name: 'Room', account_role_key: 'revenue_room' })], retired: [] });
  const onlyRetired = cell({
    active: [],
    retired: [category({ code: 'minibar', name: 'Minibar', account_role_key: 'revenue_minibar', is_active: false })],
  });

  ok('3.1 not loaded renders SOMETHING', notLoaded.length > 0, JSON.stringify(notLoaded));
  ok('3.2 nothing-posts-here renders something else', empty.length > 0, JSON.stringify(empty));
  // THE ASSERTION THAT MATTERS. These two must not be the same string.
  ok(
    '3.3 and the two are DIFFERENT — a setup mistake must not look like a loading state',
    notLoaded !== empty,
    `notLoaded=${JSON.stringify(notLoaded)} empty=${JSON.stringify(empty)}`,
  );
  ok(
    '3.4 nothing-posts-here says so in words rather than a dash',
    /no charge category/i.test(empty),
    JSON.stringify(empty),
  );
  ok('3.5 a category that posts here is named', oneActive.includes('Room'), oneActive);
  ok(
    '3.6 a retired-only account still lists it, and marks it retired',
    onlyRetired.includes('Minibar') && /retired/i.test(onlyRetired),
    onlyRetired,
  );
  // AND IT IS NOT THE EMPTY STATE. An account whose only categories are retired
  // still has history in it; reporting "nothing posts here" would say the
  // opposite of the truth.
  ok(
    '3.7 retired-only is NOT reported as nothing',
    !/no charge category/i.test(onlyRetired),
    onlyRetired,
  );
}

console.log('\nPART 4 — the fold, which is what the cell renders');

{
  const cats = [
    category({ code: 'room', name: 'Room', account_role_key: 'revenue_room' }),
    category({ code: 'suite', name: 'Suite', account_role_key: 'revenue_room' }),
    category({ code: 'minibar', name: 'Minibar', account_role_key: 'revenue_minibar', is_active: false }),
  ];
  const byKey = categoriesByRoleKey(cats);

  ok('4.1 two categories on one key are both kept', byKey.get('revenue_room')?.active.length === 2);
  ok(
    '4.2 an inactive category is separated rather than dropped',
    byKey.get('revenue_minibar')?.retired.length === 1 &&
      byKey.get('revenue_minibar')?.active.length === 0,
  );
  ok(
    '4.3 a key nothing points at is ABSENT from the map, so the caller supplies the empty',
    byKey.get('revenue_laundry') === undefined,
  );
}

console.log('\nPART 5 — the payment picker, carried since 059');

{
  ok(
    '5.1 the picker does not offer a method with no account',
    !PAYMENT_METHODS.includes('other' as never),
    PAYMENT_METHODS.join(', '),
  );
  ok(
    '5.2 but the LABEL still names it, so a historical payment does not render raw',
    paymentMethodLabel('other') !== 'other' && paymentMethodLabel('other').length > 0,
    paymentMethodLabel('other'),
  );
  ok(
    '5.3 every offered method has a label of its own',
    PAYMENT_METHODS.every((m) => paymentMethodLabel(m) !== m),
    PAYMENT_METHODS.map((m) => `${m}=${paymentMethodLabel(m)}`).join(' | '),
  );

  const form = strip(
    renderToString(
      <ToastProvider>
        <TakePaymentForm
          folioId="f1"
          currency="NGN"
          // The PROPERTY's timezone, never the browser's (rules 8, 12).
          timezone="Africa/Lagos"
          onDone={() => {}}
          onCancel={() => {}}
        />
      </ToastProvider>,
    ),
  );
  ok('5.4 the form renders', form.length > 0);
  // 067: THE HELP TEXT MUST NOT INVITE WHAT THE DATABASE REFUSES. It used to
  // read "Enter a negative amount to record a refund", and a negative amount is
  // now refused by name. A screen instructing the desk to do what the server
  // rejects is the hint-names-the-wrong-remedy defect pointing the other way.
  ok(
    '5.5 and it no longer tells the desk to type a negative amount',
    !/negative/i.test(form),
    form.slice(0, 200),
  );
  ok('5.6 it still says what the field is for', /amount received/i.test(form), form.slice(0, 200));
  for (const m of PAYMENT_METHODS) {
    ok(`5.7 ${m} is offered as "${paymentMethodLabel(m)}"`, form.includes(paymentMethodLabel(m)));
  }
  ok('5.8 and "other" is not offered on the form', !/\bOther\b/.test(form), form.slice(0, 240));
}

console.log('\nPART 6 — the empty state that names a remedy');

{
  const notice = strip(renderToString(<NoMappedRevenueNotice />));
  ok('6.1 it says what is wrong', /no revenue account is mapped/i.test(notice), notice.slice(0, 160));
  // AN EMPTY STATE THAT NAMES NO REMEDY IS A DEAD END, and this one is reachable
  // on any fresh tenant — the one screen that is supposed to explain where money
  // goes, explaining nothing.
  ok(
    '6.2 and names the tab that fixes it, by its actual label',
    notice.includes('Where money posts'),
    notice,
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

// ---------------------------------------------------------------------------
// WHAT WENT RED WHEN THE CODE WAS BROKEN (rule 22, and rule 27's test: name the
// defect that turns each assertion red)
// ---------------------------------------------------------------------------
//   1. orderOfferings' misc clause deleted, so ordering fell back to account
//      code alone. 1.4 and 1.6 went RED and nothing else moved — which is why
//      the fixture gives Aardvark hire the code 4900: with every other revenue
//      account numbered below 4100, ordering by code alone puts misc last by
//      accident and the ruling would have looked enforced when it was not.
//   2. toOption's label changed to roleKeyLabel(o.roleKey) — the key's human
//      name without its account. 1.1 went RED. That is defect (1) in the header
//      and the one most likely to be written by somebody tidying: the label
//      reads perfectly well, and says nothing about where the money lands.
//   3. CategoriesHereCell's null branch changed to return the same "Nothing"
//      text as the empty branch. 3.3 went RED on its own. 3.1, 3.2 and 3.4 all
//      stayed green, which is the finding: three assertions about those cells
//      existing and reading correctly cannot see that they say the same thing.
//   4. The retired list dropped from the cell. 3.6 and 3.7 went RED. An account
//      holding real history reported as holding nothing.
//   5. categoriesByRoleKey changed to put every category in `active`. 4.2 went
//      RED, and 3.6 did NOT — the cell was rendering a correct fold of a wrong
//      map, which is why PART 4 exists beside PART 3 rather than being trusted
//      through it.
//   6. 'other' added back to PAYMENT_METHODS. 5.1 and 5.8 went RED. 5.2 stayed
//      green, correctly: the label must keep naming it either way.
//   7. paymentMethodLabel's 'other' case deleted so it returns the raw value.
//      5.2 went RED while 5.1 stayed green — the two halves of 059's decision
//      are independent and both are asserted.
//   8. The help text restored to "Enter a negative amount to record a refund".
//      5.5 went RED. 067 closed that path in the database; this is what stops
//      the screen inviting it again.
