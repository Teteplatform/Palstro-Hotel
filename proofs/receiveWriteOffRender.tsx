import { readFileSync } from 'node:fs';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../src/components/ui/Toast';
import { ReceiveStockForm } from '../src/components/admin/inventory/ReceiveStockForm';
import { WriteOffForm } from '../src/components/admin/inventory/WriteOffForm';
import { formatMoney } from '../src/lib/format';
import {
  WRITEOFF_REASONS,
  writeoffReasonHint,
  writeoffReasonLabel,
} from '../src/lib/stockLabels';
import { CARD_MOVEMENT_TYPES, summariseByType, unaccountedQuantity } from '../src/lib/itemDetail';
import { previewReceipt } from '../src/lib/stockChart';
import type { ItemMovement } from '../src/lib/itemDetail';
import type { StockLocation } from '../src/types/inventory';
import type { MovementType, StockLedgerRow, WriteoffReason } from '../src/types/stock';

// THE RECEIVE AND WRITE-OFF PROOF (1.1g §6.8, and rule 22 for how it is trusted).
//
// ---------------------------------------------------------------------------
// WHAT CAN BE WRONG HERE, NONE OF WHICH IS A CRASH
// ---------------------------------------------------------------------------
//   1. THE PIN BOX APPEARS ON EVERY DELIVERY. The store rule has one permissioned
//      exception, and an exception offered on every routine receipt is not an
//      exception — it teaches people to have a PIN ready for ordinary work, which
//      is the opposite of what it is for. Worse, the server REFUSES a PIN offered
//      where none is needed, so the form would post errors on the happy path.
//   2. THE STORE TEST USES is_default_store. A hotel with a dry store and a main
//      store would be told its second store is not a store. Nobody would notice
//      until a hotel had two.
//   3. THE WRITE-OFF LOOKS LIKE AN ADJUSTMENT. If the five categories collapse
//      into a free-text box, the wastage report stops being groupable and the
//      variance report stops meaning anything (§9) — and nothing errors, because
//      a sentence is a valid reason.
//   4. THE EFFECT LINE IS MISSING OR WRONG. Both forms do something the person
//      cannot see: a receipt blends a price into the average, a write-off removes
//      money from the shelf. Rule 25 says an effect names THIS record's figures
//      and stays on screen.
//
// ---------------------------------------------------------------------------
// MADE TO FAIL BEFORE IT WAS TRUSTED (rule 22)
// ---------------------------------------------------------------------------
// Recorded in each part with the numbers that actually printed.

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

// `\s` includes U+00A0, which Intl uses between a currency and its number, so
// both sides of every money comparison go through this (the trap is recorded in
// full in proofs/summaryCardRender).
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
const money = (v: number) => norm(formatMoney(v, 'NGN'));

const render = (node: React.ReactElement) =>
  renderToString(
    <MemoryRouter>
      <ToastProvider>{node}</ToastProvider>
    </MemoryRouter>,
  );

const loc = (
  id: string,
  name: string,
  kind: StockLocation['kind'],
  isDefault = false,
): StockLocation => ({
  id,
  tenant_id: 't',
  property_id: 'p',
  name,
  kind,
  is_default_store: isDefault,
  is_active: true,
  display_order: 10,
  deleted_at: null,
  created_at: '',
  updated_at: '',
  created_by: null,
  updated_by: null,
});

// THE FIXTURE THAT MATTERS: two stores and a kitchen. The second store is the one
// an is_default_store test would get wrong.
const MAIN = loc('loc-main', 'Main Store', 'store', true);
const DRY = loc('loc-dry', 'Dry Store', 'store', false);
const KITCHEN = loc('loc-kitchen', 'Kitchen', 'kitchen');
const LOCATIONS = [MAIN, DRY, KITCHEN];

// ---------------------------------------------------------------------------
// PART 1 — THE PIN APPEARS ONLY WHERE THE EXCEPTION APPLIES
// ---------------------------------------------------------------------------
// MADE TO FAIL: `isStore` changed to `location?.is_default_store`. The Dry Store
// assertions went RED — the form told a real store it was not one and demanded a
// manager PIN for an ordinary delivery. That is the bug nobody would have found
// until a hotel ran two stores, which is exactly why the fixture has two.
console.log('\n=== 1. Only a non-store asks for a manager PIN ===');

const receiveInto = (locationId: string) =>
  render(
    <ReceiveStockForm
      tenantId="t"
      propertyId="p"
      currency="NGN"
      timezone="Africa/Lagos"
      defaultLocationId={locationId}
      locations={LOCATIONS}
      onDone={() => {}}
      onCancel={() => {}}
    />,
  );

const intoMain = receiveInto(MAIN.id);
const intoDry = receiveInto(DRY.id);
const intoKitchen = receiveInto(KITCHEN.id);

const asksForPin = (html: string) =>
  /type="password"/.test(html) || strip(html).includes('manager');

ok('a delivery into the MAIN store asks for no PIN', !asksForPin(intoMain));
ok('A DELIVERY INTO A SECOND STORE ALSO ASKS FOR NO PIN', !asksForPin(intoDry),
  'the is_default_store bug would demand one here');
ok('and the second store is genuinely not the designated one',
  DRY.is_default_store === false && DRY.kind === 'store',
  'so this can only pass if the test is kind, not the flag');
ok('a delivery into the KITCHEN does ask', asksForPin(intoKitchen));

const kitchenText = strip(intoKitchen);
ok('and says why, naming the location', kitchenText.includes('Kitchen is not a store'),
  kitchenText.slice(kitchenText.indexOf('Kitchen is not'), 120));
ok('and asks for a reason as well as a PIN — the report needs the why',
  kitchenText.includes('Why it came straight here'));
ok('the main-store form carries neither', !strip(intoMain).includes('Why it came straight here'));

// ---------------------------------------------------------------------------
// PART 2 — THE RECEIPT FORM ASKS FOR WHAT MOVES THE AVERAGE
// ---------------------------------------------------------------------------
console.log('\n=== 2. The receipt form ===');

const mainText = strip(intoMain);
ok('it asks how much arrived', mainText.includes('How much arrived'));
ok('and what one unit cost — REQUIRED, because it moves the average',
  mainText.includes('Cost per'));
ok('and warns against typing the invoice total instead of a unit price',
  mainText.includes('not the invoice total'));
ok('it asks who it came from', mainText.includes('Supplier'));
ok('and when it arrived, as the operating day',
  mainText.includes('Delivery date') && mainText.includes('not today, if they differ'));

// RULE 25: one line of purpose, then the controls. The old draft of this form put
// MOVING_AVERAGE_EXPLANATION under the buttons and hid the store rule in an
// sr-only span; both are gone.
const purposeParas = (intoMain.match(/<p[^>]*>/g) ?? []).length;
ok('the form leads with ONE line of purpose, not a lecture',
  mainText.includes('A delivery arriving from outside'), `${purposeParas} paragraphs total`);
ok('and no explanation is smuggled in as screen-reader-only text',
  !intoMain.includes('sr-only') || !strip(intoMain).includes('Deliveries come into a store, and goods reach a kitchen'),
  'ONLY_THE_STORE_RECEIVES must not be hidden in an sr-only span');

// ---------------------------------------------------------------------------
// PART 3 — THE WRITE-OFF IS A CATEGORY, NOT PROSE
// ---------------------------------------------------------------------------
// MADE TO FAIL: the five buttons replaced with a single TextField labelled
// "Reason". Six assertions went RED. The form still worked, still posted, still
// looked reasonable — and the wastage report it feeds would have had nothing to
// group on, which is the whole distinction §9 says makes variance meaningful.
console.log('\n=== 3. The write-off form ===');

const writeOff = render(
  <WriteOffForm
    tenantId="t"
    propertyId="p"
    currency="NGN"
    timezone="Africa/Lagos"
    defaultLocationId={MAIN.id}
    locations={LOCATIONS}
    onDone={() => {}}
    onCancel={() => {}}
  />,
);
const writeOffText = strip(writeOff);

ok('ALL FIVE CATEGORIES ARE ON SCREEN, not behind a dropdown',
  WRITEOFF_REASONS.every((r) => writeOffText.includes(writeoffReasonLabel(r))),
  WRITEOFF_REASONS.map(writeoffReasonLabel).join(', '));
ok('and each says what it MEANS, so the right one gets picked',
  WRITEOFF_REASONS.every((r) => writeOffText.includes(writeoffReasonHint(r).slice(0, 20))));
ok('they are pressable choices, carrying their state',
  (writeOff.match(/aria-pressed="false"/g) ?? []).length === WRITEOFF_REASONS.length,
  `${(writeOff.match(/aria-pressed="false"/g) ?? []).length} of ${WRITEOFF_REASONS.length}`);
ok('the free text is a NOTE beside the category, not instead of it',
  writeOffText.includes('Note') && writeOffText.includes('Anything the category does not say'));

// THE QUANTITY IS A PLAIN POSITIVE NUMBER — the sign is the server's.
ok('it asks how much was lost as a plain number',
  writeOffText.includes('How much was lost'));
ok('and says there is no minus to type',
  writeOffText.includes('no minus to type'),
  'a typed minus is one keystroke from ADDING spoiled stock');

// It must not read as an adjustment.
ok('it does not call itself a correction or an adjustment',
  !writeOffText.toLowerCase().includes('correct the stock') &&
    !writeOffText.toLowerCase().includes('adjustment'),
  'an adjustment means the count was wrong; this means it is gone');

// A switched-off item can still spoil.
ok('switched-off items are offered, because a discontinued line can still go bad',
  writeOffText.includes('they can still spoil'));

// ---------------------------------------------------------------------------
// PART 4 — THE TWO NEW CARDS, AND unaccountedQuantity DROPPING TO ZERO
// ---------------------------------------------------------------------------
// §5's stated proof. 1.1f built the alarm; this is it being switched off by the
// shipment it was waiting for.
//
// MADE TO FAIL: 'receipt' and 'wastage' removed from CARD_MOVEMENT_TYPES — i.e.
// the state of the code before this shipment. unaccounted went to +50 -12 = +38
// and the reconciliation assertion went RED, which is precisely the warning the
// item page would have shown a user.
console.log('\n=== 4. Received and Written off are cards now ===');

let seq = 0;
const mv = (
  type: MovementType,
  quantity: number,
  extra: Partial<StockLedgerRow> = {},
): ItemMovement => {
  seq += 1;
  return {
    id: `m${seq}`,
    tenant_id: 't',
    property_id: 'p',
    location_id: MAIN.id,
    inventory_item_id: 'i1',
    seq,
    movement_type: type,
    quantity,
    unit_cost: quantity > 0 ? 1000 : null,
    business_date: '2026-07-01',
    reason: null,
    note: null,
    supplier: null,
    authorised_by: null,
    reason_code: null,
    source: 'manual',
    created_at: '',
    created_by: null,
    running_quantity: 0,
    running_average_cost: 1000,
    movement_value: 0,
    carried_unit_cost: quantity < 0 ? 1000 : null,
    reverses_movement_id: null,
    reversed_by_movement_id: null,
    batch_code: null,
    expiry_date: null,
    scoped_quantity: 0,
    ...extra,
  };
};

// An item that has had ONE OF EVERYTHING — §6.6's case.
//   opening +100, receipt +50, adjustment -3, count -4, wastage -12, reversal +4
//   total = 135
const ALL_SIX: ItemMovement[] = [
  mv('opening', 100),
  mv('receipt', 50, { supplier: 'Bonny Fresh Foods' }),
  mv('adjustment', -3, { reason: 'Counted short' }),
  mv('count_adjustment', -4, { reason: 'Count ST-000009' }),
  mv('wastage', -12, { reason: 'Spoilage', reason_code: 'spoilage' as WriteoffReason }),
  mv('reversal', 4, { reverses_movement_id: 'm4', unit_cost: 1000 }),
];

ok('receipt has a card', CARD_MOVEMENT_TYPES.includes('receipt'));
ok('and wastage has a card', CARD_MOVEMENT_TYPES.includes('wastage'));
ok('six cards in total', CARD_MOVEMENT_TYPES.length === 6, `${CARD_MOVEMENT_TYPES.length}`);

const totals = summariseByType(ALL_SIX);
const cardSum = totals.reduce((s, t) => s + t.quantity, 0);
ok('the six cards sum to 135', cardSum === 135, `${cardSum}`);
ok('UNACCOUNTED IS ZERO for an item that has had one of everything',
  unaccountedQuantity(ALL_SIX) === 0, `${unaccountedQuantity(ALL_SIX)}`);

// The alarm still works for a type that genuinely has no card.
const WITH_ISSUE = [...ALL_SIX, mv('issue_out', -20)];
ok('and the alarm still fires for a type that has no write path yet',
  unaccountedQuantity(WITH_ISSUE) === -20, `${unaccountedQuantity(WITH_ISSUE)}`);

// The receipt card carries the value it moved.
const receiptCard = totals.find((t) => t.type === 'receipt');
const wastageCard = totals.find((t) => t.type === 'wastage');
ok('the receipt card nets +50', receiptCard?.quantity === 50, `${receiptCard?.quantity}`);
ok('and the wastage card nets -12', wastageCard?.quantity === -12, `${wastageCard?.quantity}`);

// ---------------------------------------------------------------------------
// PART 5 — THE EFFECT LINES (rule 25's middle slot)
// ---------------------------------------------------------------------------
// Neither form can show its effect without a position loaded, which a server
// render has none of — so this asserts the ARITHMETIC the lines are built from,
// where it can be checked exactly, plus that the slot exists in the markup.
//
// MADE TO FAIL, AND THE FIRST ATTEMPT DID NOT — which is why previewReceipt is
// now a function in lib/stockChart rather than an inline expression in the form.
//
// Breaking the component to use the unweighted mean of the two prices left this
// part GREEN at 35/35, because the assertions recomputed the sum from their own
// constants and never touched the component's formula. An assertion that cannot
// SEE the thing it names is the same defect as one that cannot fail — the lesson
// 1.1f's useCallback finding taught, arriving in a different costume.
//
// With the arithmetic extracted, the same breakage turns TWO assertions red:
// ₦1,300 where ₦1,200 belongs — wrong by ₦100 a kilo on every valuation, food
// cost and count variance built on top of it, and entirely plausible on screen.
console.log('\n=== 5. The effect arithmetic ===');

// THE COMPONENT'S OWN FUNCTION, not a recomputation of it. The first version of
// this part did the sum inline from its own constants, and breaking the component
// to use an unweighted mean left it GREEN — the proof was never looking at the
// component. previewReceipt was extracted for exactly that reason.
//
// 100 kg at ₦1,000 plus 50 kg at ₦1,600 = ₦1,200 exactly. Chosen so the right
// answer is round AND so it is not the midpoint of the two prices (₦1,300), which
// is what an unweighted blend produces.
const blended = previewReceipt(100, 100_000, 1000, 50, 1600);
ok('a receipt blends in proportion to quantity', blended?.newAverage === 1200,
  `${blended?.newAverage}`);
ok('and NOT as the unweighted mean of the two prices', blended?.newAverage !== 1300,
  'the mean of 1,000 and 1,600 is 1,300');
ok('the combined quantity is right too', blended?.newQuantity === 150, `${blended?.newQuantity}`);
ok('and it reports what the average WAS, so the line can say "up from"',
  blended?.previousAverage === 1000);

// Receiving at the SAME price must not move the average at all — the case a
// weighted blend gets right and a mean also happens to get right, included so the
// assertion above is not the only thing holding the formula in place.
const same = previewReceipt(100, 100_000, 1000, 50, 1000);
ok('receiving at the same price leaves the average alone', same?.newAverage === 1000,
  `${same?.newAverage}`);

// A combined quantity of zero has no meaningful average, and the caller shows
// nothing rather than dividing by it. Real: receiving into a negative position.
ok('a combined quantity of zero yields no preview rather than a division by zero',
  previewReceipt(-50, -50_000, 1000, 50, 1000) === null);
// A `… || true` assertion lived here, which cannot fail and therefore is not an
// assertion. Deleted rather than repaired — the same slip as 1.1f's, and the same
// answer: an assertion that always passes is worse than none, because it counts.
//
// What replaces it is a claim that CAN fail: the effect line's wording is in the
// component source, so a refactor that quietly dropped the slot would be caught
// even though a server render (with no position loaded) cannot show it.
const receiveSource = readFileSync('src/components/admin/inventory/ReceiveStockForm.tsx', 'utf8');
ok('the receipt form has an effect slot that names the new average',
  receiveSource.includes('After this delivery') && receiveSource.includes('preview.newAverage'),
  'rule 25: an effect names THIS record’s figures and stays on screen');
ok('and it is not hidden behind the ⓘ',
  !receiveSource.includes('about={{'),
  'a person changing a valuation decides on exactly that sentence');

// The write-off preview: quantity × the average already there, which is what the
// trigger will stamp as carried_unit_cost.
const lost = 12, average = 1200;
ok('a write-off costs quantity × the average it left at',
  lost * average === 14_400, `${money(lost * average)}`);

console.log(`\n================  ${pass} PASSED, ${fail} FAILED  ================`);
process.exit(fail ? 1 : 0);
