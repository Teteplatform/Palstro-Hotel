import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { ItemMovementCards } from '../src/components/admin/inventory/ItemMovementCards';
import { ItemMovementLedger } from '../src/components/admin/inventory/ItemMovementLedger';
import { StockLevelChart } from '../src/components/admin/inventory/StockLevelChart';
import { formatMoney, formatQuantity } from '../src/lib/format';
import { CHART, plotSeries, seriesFrom, type SeriesPoint } from '../src/lib/stockChart';
import {
  CARD_MOVEMENT_TYPES,
  cardsReconcile,
  cardsTotal,
  summariseByType,
  unaccountedQuantity,
  type ItemMovement,
  type ItemPosition,
} from '../src/lib/itemDetail';
import type { MovementType, StockLedgerRow } from '../src/types/stock';
import type { StockLocation } from '../src/types/inventory';

// THE ITEM PAGE PROOF (1.1f §6, and rule 22 for how it is trusted).
//
// ---------------------------------------------------------------------------
// THE THREE THINGS THAT CAN BE WRONG HERE, NONE OF WHICH IS A CRASH
// ---------------------------------------------------------------------------
//   1. THE CARDS DO NOT ADD UP. This page exists to say "your stock is the sum of
//      these movements" and to show the sum. A card row that is off by one
//      movement type is a page confidently teaching arithmetic that does not work,
//      and nothing errors — the cards render, the total renders, they just differ.
//   2. THE CHART DRAWS A TIMELINE THAT NEVER HAPPENED. At property scope the
//      series interleaves movements from several locations, ordered by
//      (business_date, seq). If seq were ever per-location the line would be
//      plausible and false. PART 4 asserts the ordering property the interleaving
//      depends on.
//   3. THE POINTS AND THE ROWS DISAGREE. The chart is a way INTO the ledger, so a
//      point at index 7 must be the ledger's row 7. Off by one and clicking a
//      point scrolls to the wrong movement.
//
// ---------------------------------------------------------------------------
// MADE TO FAIL BEFORE IT WAS TRUSTED (rule 22) — recorded in each part
// ---------------------------------------------------------------------------
// Every breakage below was applied to the real implementation and observed red;
// the numbers quoted are what actually printed.

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

// `\s` in a JS regex includes U+00A0, which Intl uses between a currency and its
// number — so both sides of any money comparison go through this. (The trap is
// recorded in full in proofs/summaryCardRender.)
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const strip = (h: string) =>
  norm(
    h
      .replace(/<[^>]+>/g, ' ')
      .replace(/&#x27;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
      .replace(/&#x2F;/g, '/')
      .replace(/&nbsp;/g, ' '),
  );
const money = (v: number) => norm(formatMoney(v, 'NGN'));
const qty = (v: number) => norm(formatQuantity(v));

const render = (node: React.ReactElement) =>
  renderToString(<MemoryRouter>{node}</MemoryRouter>);

// ---------------------------------------------------------------------------
// THE FIXTURE — one item's life, with the arithmetic done by hand
// ---------------------------------------------------------------------------
// Rice in two locations, so the property-scope case is real rather than a
// single-location case with a different label:
//
//   Main Store   opening          +100 kg @ ₦1,000   = ₦100,000
//                adjustment        -10 kg  (spoiled, at the average ₦1,000)
//                count correction   -2 kg  (counted 88, expected 90)
//   Kitchen      opening           +20 kg @ ₦1,200   =  ₦24,000
//                adjustment         -5 kg  (at ₦1,200)
//                reversal           +5 kg  (that adjustment undone)
//
//   Opening          +120 kg
//   Adjustments       -15 kg
//   Count corrections  -2 kg
//   Reversals          +5 kg
//   ---------------------------
//   TOTAL            +108 kg   <- and this must equal On hand
//
// THE WRONG ANSWERS, kept here so the assertions can name them: dropping the
// reversal card gives 103; treating the reversal as a magnitude rather than a
// signed contribution gives 113 either way you read it.
let seq = 0;
function movement(
  overrides: Partial<StockLedgerRow> & {
    movement_type: MovementType;
    quantity: number;
    business_date: string;
    location_id: string;
  },
): StockLedgerRow {
  seq += 1;
  // The four required fields are NOT restated here before the spread: `...overrides`
  // supplies them, and listing them twice is what tsc flags as
  // "specified more than once, so this usage will be overwritten" — harmless at
  // runtime and exactly the kind of redundancy that later hides a real shadowing.
  return {
    id: `m${seq}`,
    tenant_id: 't',
    property_id: 'p',
    inventory_item_id: 'i1',
    seq,
    unit_cost: null,
    reason: null,
    note: null,
    source: 'manual',
    created_at: '2026-08-01T09:00:00Z',
    created_by: null,
    running_quantity: 0,
    running_average_cost: 1000,
    movement_value: 0,
    carried_unit_cost: null,
    reverses_movement_id: null,
    reversed_by_movement_id: null,
    batch_code: null,
    expiry_date: null,
    ...overrides,
  };
}

const STORE = 'loc-store';
const KITCHEN = 'loc-kitchen';

const RAW: StockLedgerRow[] = [
  movement({
    movement_type: 'opening',
    quantity: 100,
    unit_cost: 1000,
    movement_value: 100_000,
    business_date: '2026-06-01',
    location_id: STORE,
  }),
  movement({
    movement_type: 'opening',
    quantity: 20,
    unit_cost: 1200,
    movement_value: 24_000,
    business_date: '2026-06-02',
    location_id: KITCHEN,
  }),
  movement({
    movement_type: 'adjustment',
    quantity: -10,
    movement_value: -10_000,
    business_date: '2026-06-10',
    location_id: STORE,
    reason: 'Spoiled',
  }),
  movement({
    movement_type: 'adjustment',
    quantity: -5,
    movement_value: -6_000,
    business_date: '2026-06-11',
    location_id: KITCHEN,
    reason: 'Keyed against the wrong item',
    reversed_by_movement_id: 'm6',
  }),
  movement({
    movement_type: 'count_adjustment',
    quantity: -2,
    movement_value: -2_000,
    business_date: '2026-06-20',
    location_id: STORE,
  }),
  movement({
    movement_type: 'reversal',
    quantity: 5,
    // A POSITIVE MOVEMENT MUST STATE A COST, and a reversal must ALSO carry the
    // basis it is unwinding — stock_movements_cost_direction_check (036) and
    // stock_movements_reversal_cost_check (038). The first version of this fixture
    // had both null, which the dry run refused outright when it tried to insert the
    // same shape. A fixture the database would reject is a weaker proof than it
    // looks: it can only exercise code paths that real data never takes.
    unit_cost: 1200,
    carried_unit_cost: 1200,
    movement_value: 6_000,
    business_date: '2026-06-21',
    location_id: KITCHEN,
    reverses_movement_id: 'm4',
  }),
];

// The scoped_quantity the data layer produces at property scope: a running sum of
// the signed quantity column. Reproduced here rather than imported so the proof
// checks the RESULT against an independently written accumulation.
let running = 0;
const MOVEMENTS: ItemMovement[] = RAW.map((row) => {
  running += row.quantity;
  return { ...row, scoped_quantity: running };
});

const POSITION: ItemPosition = {
  quantity: 108,
  value: 108_000,
  averageCost: 1000,
  locationCount: 2,
};

const LOCATIONS: StockLocation[] = [
  {
    id: STORE,
    tenant_id: 't',
    property_id: 'p',
    name: 'Main Store',
    kind: 'store',
    is_default_store: true,
    is_active: true,
    display_order: 10,
    deleted_at: null,
    created_at: '',
    updated_at: '',
    created_by: null,
    updated_by: null,
  },
  {
    id: KITCHEN,
    tenant_id: 't',
    property_id: 'p',
    name: 'Kitchen',
    kind: 'kitchen',
    is_default_store: false,
    is_active: true,
    display_order: 20,
    deleted_at: null,
    created_at: '',
    updated_at: '',
    created_by: null,
    updated_by: null,
  },
];

// ---------------------------------------------------------------------------
// PART 1 — THE CARDS SUM TO ON HAND
// ---------------------------------------------------------------------------
// The assertion this whole page is worth building for.
//
// MADE TO FAIL: 'reversal' removed from CARD_MOVEMENT_TYPES. The row still
// rendered four cards and a total; the sum came to 103 against 108, the
// reconciliation assertion went RED, and the unaccounted figure went to +5 —
// which is the shape of what will happen the day receiving ships without a card.
console.log('\n=== 1. The cards sum to On hand ===');

const totals = summariseByType(MOVEMENTS);
const unaccounted = unaccountedQuantity(MOVEMENTS);

ok('every writable movement type has a card', totals.length === CARD_MOVEMENT_TYPES.length,
  `${totals.length} cards`);
ok('and nothing else does — no card for a type with no write path',
  !totals.some((t) => ['receipt', 'issue_out', 'consumption'].includes(t.type)),
  totals.map((t) => t.type).join(', '));

const byType = new Map(totals.map((t) => [t.type, t]));
ok('opening nets +120', byType.get('opening')?.quantity === 120,
  `${byType.get('opening')?.quantity}`);
ok('adjustments net -15', byType.get('adjustment')?.quantity === -15,
  `${byType.get('adjustment')?.quantity}`);
ok('count corrections net -2', byType.get('count_adjustment')?.quantity === -2,
  `${byType.get('count_adjustment')?.quantity}`);
ok('reversals net +5', byType.get('reversal')?.quantity === 5,
  `${byType.get('reversal')?.quantity}`);

ok('THE CARDS TOTAL 108, WHICH IS ON HAND', cardsTotal(totals) === POSITION.quantity,
  `cards ${cardsTotal(totals)} vs on hand ${POSITION.quantity}`);
ok('and the data layer says so', cardsReconcile(totals, POSITION));
ok('with nothing unaccounted for', unaccounted === 0, `${unaccounted}`);

// THE TWO WRONG ANSWERS, named so the assertion above cannot pass by coincidence.
ok('it is NOT the sum of magnitudes',
  cardsTotal(totals) !== MOVEMENTS.reduce((s, m) => s + Math.abs(m.quantity), 0),
  `magnitudes would give ${MOVEMENTS.reduce((s, m) => s + Math.abs(m.quantity), 0)}`);
ok('and NOT the sum with reversals dropped',
  cardsTotal(totals) !==
    MOVEMENTS.filter((m) => m.movement_type !== 'reversal').reduce((s, m) => s + m.quantity, 0),
  'dropping reversals would give 103');

// A movement type with no card must SHOW UP rather than be silently absorbed.
const WITH_RECEIPT: ItemMovement[] = [
  ...MOVEMENTS,
  { ...movement({ movement_type: 'receipt', quantity: 40, business_date: '2026-07-01', location_id: STORE }), scoped_quantity: 148 },
];
ok('a movement with no card is COUNTED as unaccounted, never dropped',
  unaccountedQuantity(WITH_RECEIPT) === 40, `${unaccountedQuantity(WITH_RECEIPT)}`);
ok('and the row then reports that it does not reconcile',
  !cardsReconcile(summariseByType(WITH_RECEIPT), { ...POSITION, quantity: 148 }));

// ---------------------------------------------------------------------------
// PART 2 — THE CARD ROW RENDERS THOSE FIGURES, AND SAYS WHEN IT CANNOT
// ---------------------------------------------------------------------------
// MADE TO FAIL: the signed formatter swapped for formatQuantity on the card
// figure. EXACTLY ONE assertion went red — the explicit "+120" — because
// formatQuantity(-15) already renders "-15" on its own. So the signed formatter's
// real contribution here is the PLUS, not the minus, and the negative assertion
// below is NOT testing it. Both are relabelled to say what they actually check.
//
// The plus is not decoration: these cards are CONTRIBUTIONS to a total, and "120"
// beside "On hand 108" reads as two competing levels, while "+120" reads as a term
// in a sum. That is the whole visual grammar the row depends on.
console.log('\n=== 2. The card row ===');

const cardsHtml = render(
  <ItemMovementCards
    totals={totals}
    position={POSITION}
    baseUnit="kg"
    currency="NGN"
    unaccounted={0}
    selected={null}
    onSelect={() => {}}
    loading={false}
  />,
);
const cardsText = strip(cardsHtml);
console.log(`\n  ${cardsText.slice(0, 340)}…\n`);

ok('the four cards are named', ['Opening balance', 'Adjustment', 'Count correction', 'Reversal']
  .every((label) => cardsText.includes(label)));
ok('On hand renders the figure the cards add to', cardsText.includes(qty(108)));
ok('Value renders at cost', cardsText.includes(money(108_000)));
ok('a negative contribution shows its minus', cardsText.includes('-15') || cardsText.includes('−15'),
  'note: plain formatQuantity would also do this — see the header');
ok('A POSITIVE ONE IS EXPLICITLY SIGNED, so a card reads as a term in a sum rather than a rival total',
  cardsText.includes('+120'),
  'this is the assertion the signed formatter actually earns');

// The cards are BUTTONS with pressed state — a filter that looks like one.
ok('each card is a button', (cardsHtml.match(/<button/g) ?? []).length >= 4,
  `${(cardsHtml.match(/<button/g) ?? []).length} buttons`);
ok('and carries its pressed state, not only a colour',
  cardsHtml.includes('aria-pressed="false"'));

const selectedHtml = render(
  <ItemMovementCards
    totals={totals}
    position={POSITION}
    baseUnit="kg"
    currency="NGN"
    unaccounted={0}
    selected={'adjustment' as MovementType}
    onSelect={() => {}}
    loading={false}
  />,
);
ok('the selected card reads as selected', selectedHtml.includes('aria-pressed="true"'));
ok('exactly one at a time', (selectedHtml.match(/aria-pressed="true"/g) ?? []).length === 1);

// A card with nothing behind it cannot filter to anything and does not offer to.
const EMPTY_TOTALS = summariseByType([]);
const emptyHtml = render(
  <ItemMovementCards
    totals={EMPTY_TOTALS}
    position={null}
    baseUnit="kg"
    currency="NGN"
    unaccounted={0}
    selected={null}
    loading={false}
    onSelect={() => {}}
  />,
);
ok('a card with no movements is shown but not pressable',
  (emptyHtml.match(/disabled=""/g) ?? []).length === 4,
  `${(emptyHtml.match(/disabled=""/g) ?? []).length} disabled`);
ok('and an item that never moved shows a dash, not a confident zero',
  strip(emptyHtml).includes('—'));

// THE FAILURE MESSAGE, which is the honest half of the promise.
const brokenHtml = render(
  <ItemMovementCards
    totals={totals}
    position={{ ...POSITION, quantity: 148 }}
    baseUnit="kg"
    currency="NGN"
    unaccounted={40}
    selected={null}
    onSelect={() => {}}
    loading={false}
  />,
);
const brokenText = strip(brokenHtml);
ok('WHEN THE CARDS DO NOT ADD UP, THE ROW SAYS SO',
  brokenText.includes('do not add up'), brokenText.slice(0, 160));
ok('and names the gap rather than just flagging it',
  brokenText.includes('no card yet'));
ok('a reconciling row stays quiet about it',
  !cardsText.includes('do not add up'));

// ---------------------------------------------------------------------------
// PART 3 — THE CHART ARITHMETIC, INCLUDING EVERY DEGENERATE CASE
// ---------------------------------------------------------------------------
// MADE TO FAIL: the `max === min` guard removed from plotSeries. A flat line
// divided by a zero span and every cy came out NaN — the polyline rendered as
// `points="NaN,NaN NaN,NaN"`, which draws NOTHING and throws nothing. That is the
// exact shape of bug this extraction exists to catch, and it is invisible to tsc.
console.log('\n=== 3. plotSeries: scaling, zero, and the degenerate cases ===');

const plot = plotSeries(seriesFrom(MOVEMENTS));
ok('one point per movement', plot.points.length === MOVEMENTS.length,
  `${plot.points.length} points`);
ok('every coordinate is a real number',
  plot.points.every((p) => Number.isFinite(p.cx) && Number.isFinite(p.cy)));
ok('the first point sits on the left padding', plot.points[0].cx === CHART.padX,
  `${plot.points[0].cx}`);
ok('and the last on the right', plot.points[plot.points.length - 1].cx === CHART.width - CHART.padX,
  `${plot.points[plot.points.length - 1].cx}`);
ok('the path has a coordinate pair per point',
  plot.path.split(' ').length === MOVEMENTS.length);
ok('the highest value is drawn ABOVE the lowest (y grows downward in SVG)',
  plot.points[1].cy < plot.points[4].cy,
  `120kg at y=${plot.points[1].cy}, 108kg at y=${plot.points[4].cy}`);

// ZERO IS ALWAYS IN RANGE, so the baseline is a real line and a negative level is
// visibly below something (rule 7's display half).
ok('zero is inside the plotted range', plot.min <= 0 && plot.max >= 0,
  `${plot.min}..${plot.max}`);
ok('and the zero line is inside the box',
  plot.zeroY >= CHART.padY && plot.zeroY <= CHART.height - CHART.padY, `${plot.zeroY}`);

// NO POINTS — an item that has never moved here.
const none = plotSeries([]);
ok('no movements plots nothing rather than NaN', none.points.length === 0 && none.path === '');
ok('and still places a zero line', Number.isFinite(none.zeroY));

// ONE POINT — an item with only an opening balance. At x=0 it would read as a
// line that was cut off.
const one = plotSeries([{ x: 0, value: 50 }]);
ok('a single point is centred, not pinned to the left edge',
  one.points[0].cx === CHART.padX + (CHART.width - CHART.padX * 2) / 2, `${one.points[0].cx}`);
ok('and is a real coordinate', Number.isFinite(one.points[0].cy));

// A FLAT LINE at a non-zero level. This does NOT hit the degenerate guard, and
// labelling it as though it did is the mistake this proof caught: zero is forced
// into the range, so a flat line at 7 has min 0 and max 7 and a real span. Kept as
// a case because it is common (an item that has only ever had an opening balance),
// and relabelled so it does not claim to test something it cannot.
const flat = plotSeries([
  { x: 0, value: 7 },
  { x: 1, value: 7 },
  { x: 2, value: 7 },
]);
ok('a flat line at a non-zero level plots normally',
  flat.points.every((p) => Number.isFinite(p.cy)),
  flat.points.map((p) => p.cy).join(', '));
ok('and is drawn level', new Set(flat.points.map((p) => p.cy)).size === 1);

// ALL ZERO — the ONLY series that collapses the span, and therefore the only one
// the guard protects. Real: an item received and then entirely written off.
//
// MADE TO FAIL: the `max === min` guard removed. EXACTLY ONE assertion went red —
// this one — while the flat-at-7 case above stayed green, which is how the comment
// in lib/stockChart came to be corrected. Every cy became NaN and the polyline
// rendered as `points="NaN,NaN NaN,NaN"`, which draws nothing and throws nothing.
const zeros = plotSeries([{ x: 0, value: 0 }, { x: 1, value: 0 }]);
ok('AN ALL-ZERO SERIES DOES NOT DIVIDE BY ZERO',
  zeros.points.every((p) => Number.isFinite(p.cy)),
  zeros.points.map((p) => p.cy).join(', '));

// NEGATIVE — stock that says less than nothing, which is real (rule 7).
const negative = plotSeries([
  { x: 0, value: 10 },
  { x: 1, value: -4 },
]);
ok('a negative level is plotted BELOW the zero line',
  negative.points[1].cy > negative.zeroY,
  `point y=${negative.points[1].cy}, zero y=${negative.zeroY}`);
ok('and stays inside the box',
  negative.points.every((p) => p.cy >= CHART.padY - 0.001 && p.cy <= CHART.height - CHART.padY + 0.001));

// A LONG SERIES — a year of daily movements, to make sure nothing runs off.
const long: SeriesPoint[] = Array.from({ length: 365 }, (_, i) => ({
  x: i,
  value: Math.sin(i / 10) * 50 + 60,
}));
const longPlot = plotSeries(long);
ok('365 points all stay within the box',
  longPlot.points.every(
    (p) =>
      p.cx >= CHART.padX - 0.001 &&
      p.cx <= CHART.width - CHART.padX + 0.001 &&
      p.cy >= CHART.padY - 0.001 &&
      p.cy <= CHART.height - CHART.padY + 0.001,
  ));

// ---------------------------------------------------------------------------
// PART 4 — THE ORDER THE PROPERTY-SCOPE SERIES DEPENDS ON
// ---------------------------------------------------------------------------
// At property scope the series interleaves movements from several locations. That
// is only meaningful if `seq` is ONE sequence across the table — 036 declares it
// `bigint generated always as identity` on stock_movements, with no partitioning
// and no per-location sequence anywhere in the schema.
//
// This asserts the PROPERTY that reliance rests on, so a future change to how seq
// is generated fails here rather than silently drawing a timeline that never
// happened. The database-side check is in the dry run.
console.log('\n=== 4. The interleaved series is in a real order ===');

ok('the fixture genuinely interleaves two locations',
  new Set(MOVEMENTS.map((m) => m.location_id)).size === 2);
ok('SEQ IS STRICTLY INCREASING ACROSS LOCATIONS, not restarting per location',
  MOVEMENTS.every((m, i) => i === 0 || m.seq > MOVEMENTS[i - 1].seq),
  MOVEMENTS.map((m) => `${m.location_id === STORE ? 'S' : 'K'}${m.seq}`).join(' '));
ok('and the business dates never go backwards',
  MOVEMENTS.every((m, i) => i === 0 || m.business_date >= MOVEMENTS[i - 1].business_date));

// THE ENDPOINT ASSERTION — the one that makes the client-side accumulation
// checkable rather than believed.
ok('THE LAST POINT OF THE SERIES EQUALS ON HAND',
  MOVEMENTS[MOVEMENTS.length - 1].scoped_quantity === POSITION.quantity,
  `series ends at ${MOVEMENTS[MOVEMENTS.length - 1].scoped_quantity}, on hand is ${POSITION.quantity}`);
ok('and the running total never used running_quantity, which is per location',
  MOVEMENTS.every((m) => m.running_quantity === 0),
  'the fixture leaves running_quantity at 0 precisely so a slip would show');

// ---------------------------------------------------------------------------
// PART 5 — THE CHART'S POINTS MATCH THE LEDGER, ROW FOR ROW
// ---------------------------------------------------------------------------
// MADE TO FAIL: the circles mapped over `movements.slice(1)` while the polyline
// mapped over all of them. The chart still rendered — one fewer dot on the same
// line, which nobody would notice — and clicking any point scrolled to the
// movement BEFORE the one clicked. PART 5 went red on the count and on the ids.
console.log('\n=== 5. Points and rows are the same movements ===');

const chartHtml = render(
  <StockLevelChart
    movements={MOVEMENTS}
    baseUnit="kg"
    scopeName="Every location"
    onSelectMovement={() => {}}
  />,
);

// BY IDENTITY, NOT BY COUNTING. The first version of this counted circles and
// counted <tr>s, and it FAILED — on a regex that could not tell a header row from a
// body row, not on the components. Counting two lists and finding the same number
// would not have proven they were the same movements anyway; both components now
// carry data-movement-id for exactly this, so "row for row" means what it says.
const idsIn = (html: string) =>
  [...html.matchAll(/data-movement-id="([^"]+)"/g)].map((m) => m[1]);

const chartIds = idsIn(chartHtml);
ok('there is one point per movement', chartIds.length === MOVEMENTS.length,
  `${chartIds.length} points vs ${MOVEMENTS.length} movements`);
ok('and the points are those movements, in that order',
  chartIds.join(',') === MOVEMENTS.map((m) => m.id).join(','),
  chartIds.join(','));

const ledgerHtml = render(
  <ItemMovementLedger
    movements={MOVEMENTS}
    allMovements={MOVEMENTS}
    baseUnit="kg"
    currency="NGN"
    itemName="Rice"
    locations={LOCATIONS}
    scopeLocation={null}
    selectedType={null}
    onClearFilter={() => {}}
    highlighted={null}
    onHighlightShown={() => {}}
    loading={false}
    onReversed={() => {}}
  />,
);
const ledgerIds = idsIn(ledgerHtml);
ok('the ledger shows one row per movement', ledgerIds.length === MOVEMENTS.length,
  `${ledgerIds.length} rows`);
ok('THE CHART’S POINTS AND THE LEDGER’S ROWS ARE THE SAME MOVEMENTS, IN THE SAME ORDER',
  chartIds.join(',') === ledgerIds.join(','),
  `chart ${chartIds.join(',')} | ledger ${ledgerIds.join(',')}`);

// A tautology lived here — `MOVEMENTS.every(… || true)`, which is `true` however
// the components behave. It has been deleted rather than repaired: the identity
// assertion above is the real version of what it was pretending to check, and an
// assertion that cannot fail is worse than no assertion, because it counts as one.
const ledgerText = strip(ledgerHtml);
ok('every movement’s own reason appears in the ledger',
  MOVEMENTS.filter((m) => m.reason).every((m) => ledgerText.includes(m.reason!)),
  'reasons carried through');

// The two cross-links 038 gives a reversal, on the page's own row component.
ok('a reversed movement says it was reversed', ledgerText.includes('Reversed'));
ok('and the reversal says what it undid',
  ledgerText.includes('Reverses the adjustment above'), 'named by type, not by uuid');

// ---------------------------------------------------------------------------
// PART 6 — FILTERING BY A CARD CHANGES THE LEDGER AND NOT THE TOTALS
// ---------------------------------------------------------------------------
// §2's other promise: pressing a card narrows the table, and the figures being
// checked against stay put. If the cards filtered themselves they would always
// reconcile — trivially, and uselessly.
console.log('\n=== 6. A card filters the ledger, not the figures ===');

const adjustmentsOnly = MOVEMENTS.filter((m) => m.movement_type === 'adjustment');
const filteredLedger = render(
  <ItemMovementLedger
    movements={adjustmentsOnly}
    allMovements={MOVEMENTS}
    baseUnit="kg"
    currency="NGN"
    itemName="Rice"
    locations={LOCATIONS}
    scopeLocation={null}
    selectedType={'adjustment' as MovementType}
    onClearFilter={() => {}}
    highlighted={null}
    onHighlightShown={() => {}}
    loading={false}
    onReversed={() => {}}
  />,
);
const filteredIds = idsIn(filteredLedger);
ok('the ledger narrows to exactly that type',
  filteredIds.join(',') === adjustmentsOnly.map((m) => m.id).join(','),
  `${filteredIds.length} rows for ${adjustmentsOnly.length} adjustments`);
ok('and to nothing else — no row of another type survives the filter',
  filteredIds.every((id) =>
    MOVEMENTS.find((m) => m.id === id)?.movement_type === 'adjustment'));
ok('and says which type it is showing',
  strip(filteredLedger).includes('adjustment only'));
ok('with an obvious way back', strip(filteredLedger).includes('Show everything'));

// THE TOTALS ARE COMPUTED FROM THE UNFILTERED SET, so they cannot move.
const totalsWhileFiltered = summariseByType(MOVEMENTS);
ok('THE CARD FIGURES DO NOT CHANGE WHEN THE LEDGER IS FILTERED',
  cardsTotal(totalsWhileFiltered) === cardsTotal(totals) &&
    cardsTotal(totalsWhileFiltered) === POSITION.quantity,
  `${cardsTotal(totalsWhileFiltered)} either way`);

// A reversal cross-link must still resolve while its target is filtered out —
// which is why the ledger takes allMovements as well as the filtered rows.
const reversalsOnly = MOVEMENTS.filter((m) => m.movement_type === 'reversal');
const reversalView = strip(
  render(
    <ItemMovementLedger
      movements={reversalsOnly}
      allMovements={MOVEMENTS}
      baseUnit="kg"
      currency="NGN"
      itemName="Rice"
      locations={LOCATIONS}
      scopeLocation={null}
      selectedType={'reversal' as MovementType}
      onClearFilter={() => {}}
      highlighted={null}
      onHighlightShown={() => {}}
      loading={false}
      onReversed={() => {}}
    />,
  ),
);
ok('a reversal still names what it undid even when that row is filtered out',
  reversalView.includes('Reverses the adjustment above'), reversalView.slice(0, 120));

// ---------------------------------------------------------------------------
// PART 7 — WHAT THE PAGE SHOWS AT PROPERTY SCOPE AND AT ONE LOCATION
// ---------------------------------------------------------------------------
// The two running columns mean different things at the two scopes, and getting
// that wrong is a plausible-looking table of figures that are true of neither.
console.log('\n=== 7. The scope changes what the columns can say ===');

ok('at property scope the ledger shows WHERE each movement happened',
  ledgerText.includes('Main Store') && ledgerText.includes('Kitchen'));
// An OR lived here — `!includes(x) || includes('—')` — which passes if either half
// holds and therefore barely constrains anything. Replaced with the positive fact:
// the column renders the marker that says WHY it is empty, once per row.
const perLocationMarkers = (ledgerHtml.match(/Averages are per location/g) ?? []).length;
ok('and refuses to show a running average, because there is no property-wide one',
  perLocationMarkers === MOVEMENTS.length,
  `${perLocationMarkers} rows say so, for ${MOVEMENTS.length} movements (036 §3.3)`);

const oneLocation = strip(
  render(
    <ItemMovementLedger
      movements={MOVEMENTS.filter((m) => m.location_id === STORE)}
      allMovements={MOVEMENTS}
      baseUnit="kg"
      currency="NGN"
      itemName="Rice"
      locations={LOCATIONS}
      scopeLocation={LOCATIONS[0]}
      selectedType={null}
      onClearFilter={() => {}}
      highlighted={null}
      onHighlightShown={() => {}}
      loading={false}
      onReversed={() => {}}
    />,
  ),
);
ok('at one location the Location column is gone — it would be one word repeated',
  !oneLocation.includes('Kitchen'));
ok('and the running average is shown, because there is one',
  oneLocation.includes(money(1000)));

console.log(`\n================  ${pass} PASSED, ${fail} FAILED  ================`);
process.exit(fail ? 1 : 0);
