// THE PURCHASING PROOF (1.1h2, and rules 22/24/27 for how it is trusted).
//
// ---------------------------------------------------------------------------
// WHAT THIS EXISTS TO CATCH, AND NONE OF IT IS A CRASH
// ---------------------------------------------------------------------------
// Four screens land in this shipment and each has a failure mode that renders
// perfectly:
//
//   1. THE OUTSTANDING LIST reads purchase_order_summary, a view in which
//      line_count and receipt_count arrive as JSON NUMBERS (int8) while every
//      money field beside them arrives as a STRING (numeric). That mapping
//      exists ONLY in the browser — no SQL proof can see it — and it is the
//      exact shape of the three crashes rule 24 was written for. Worse than the
//      crash is the near miss: "60000.00" + "56400.00" is "60000.0056400.00",
//      which formats to a dash rather than throwing.
//
//   2. THE RECEIVE SCREEN decides, live, whether a reason is needed and whether
//      a manager is needed. Get either wrong in the permissive direction and the
//      screen simply does not ask — the server still refuses, but the person has
//      already sent the driver away.
//
//   3. THE COST DIFFERENCE is the figure this whole module exists to surface. A
//      sign error on it reads as a discount where there was a price rise, which
//      is a number that is confidently, quietly wrong.
//
//   4. THE SUPPLIER ACTIVITY VIEW must not grow anything that reads as a
//      balance, because nothing in this shipment can pay a supplier.
//
// ---------------------------------------------------------------------------
// MADE TO FAIL BEFORE IT WAS TRUSTED (rules 22, 27)
// ---------------------------------------------------------------------------
// Every assertion below was written to a named defect, and the code was broken
// to check that the defect turns it red. What went red, and one that did NOT:
//
//   A. lineDifference's `needsReason` narrowed to `quantityDifference < 0` — a
//      SHORT delivery asks and an OVER delivery does not. THIS IS THE ONE THAT
//      TAUGHT SOMETHING. It first turned exactly ONE assertion red, and it was
//      the pure-function one: the RENDERED reason field was asserted only at 47,
//      which is short and still asks under the broken rule, so the half of the
//      defect a person would actually meet was invisible. An over-receipt needs
//      explaining as much as a short one; PART 2 now asserts the field at 55 as
//      well, and the mutation turns TWO red. The defect matters because it fails
//      permissively: the screen stops asking, and the refusal arrives after the
//      driver has gone.
//
//   B. lineDifference's `unitCostDifference` flipped to `ordered - invoiced`.
//      THREE assertions went RED, reporting a price CUT of ₦40 where there was a
//      rise. Nothing throws on a sign error. (PART 3's receipt table did NOT go
//      red, and that is correct rather than a gap: it renders the difference the
//      VIEW computed, not this function's — two independent implementations of
//      the same figure, which is why both are asserted.)
//
//   C. purchaseOrderSummaryRows' `line_count` removed from the required list.
//      IT DOES NOT COMPILE, and the error names the field:
//        Property '__unparsedNumericFields' is missing … required in type
//        '{ __unparsedNumericFields: "line_count"; }'
//      That is rule 24's compiler check doing the work, so no runtime assertion
//      is needed for the missing-field half. PART 1's runtime assertion is for
//      the OTHER half, which the compiler cannot see: a money field arriving as
//      a STRING and being concatenated rather than added.
//
//   D. deliveryTotals' `needsManager` hard-wired to false. THREE went RED — the
//      manager panel disappeared from a delivery that was over by 5 kg, and the
//      sentence explaining why went with it.
//
//   E. `blankDraft` changed to pre-fill `quantity` with the outstanding figure.
//      ONE went RED, reporting value "50". That is rule 10's argument applied to
//      a delivery: a pre-filled quantity produces a full delivery nobody
//      counted, and this screen exists to catch the one that is three bags short.
//
//   F. THE FIXTURE FAULT, FOUND THE SAME WAY. `deliveryTotals` was changed to
//      sum `orderedValue` at the INVOICED cost, so the cost-difference sentence
//      would always read zero. The first version of PART 2 stayed GREEN, because
//      its only fixture line had the invoiced cost equal to the ordered one — a
//      fixture already in the state being asserted, rule 27's third shape. PART 2
//      now carries a second line whose invoiced cost is ₦40 higher, and the
//      mutation turns that assertion red (67,200 where 66,400 belongs).

import { Window } from 'happy-dom';

// The DOM has to exist BEFORE react-dom is imported, so the globals go up first
// and every React import below is dynamic — the same shim pickerRender and
// popoverRender use, and for the same reason: a portal is a DOM fact.
const win = new Window({ width: 1366, height: 768 });
const g = globalThis as unknown as Record<string, unknown>;
g.window = win;
g.document = win.document;
Object.defineProperty(globalThis, 'navigator', {
  value: win.navigator,
  configurable: true,
  writable: true,
});
g.HTMLElement = win.HTMLElement;
g.Element = win.Element;
g.Node = win.Node;
g.MouseEvent = win.MouseEvent;
g.KeyboardEvent = win.KeyboardEvent;
g.PointerEvent = win.PointerEvent ?? win.MouseEvent;
g.Event = win.Event;
g.getComputedStyle = win.getComputedStyle.bind(win);
g.CSS = { escape: (v: string) => v.replace(/([^\w-])/g, '\\$1') };
// Without this React logs "the current testing environment is not configured to
// support act(...)" on every flush and does not guarantee effects have run — so
// the proof would be asserting against a half-committed tree.
g.IS_REACT_ACT_ENVIRONMENT = true;
g.requestAnimationFrame = (cb: FrameRequestCallback) =>
  win.setTimeout(() => cb(0), 0) as unknown as number;
g.cancelAnimationFrame = (id: number) =>
  win.clearTimeout(id as unknown as ReturnType<typeof win.setTimeout>);

const React = await import('react');
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { renderToString } = await import('react-dom/server');
const { MemoryRouter } = await import('react-router-dom');
const { ToastProvider } = await import('../src/components/ui/Toast');

const {
  PurchaseOrderTable,
  PurchaseSummaryCard,
} = await import('../src/components/admin/purchasing/PurchasesScreen');
const { ReceiveForm } = await import(
  '../src/components/admin/purchasing/ReceiveForm'
);
const { ReceiptLinesTable, OrderLinesTable } = await import(
  '../src/components/admin/purchasing/PurchaseOrderScreen'
);
const { SupplierActivityTable } = await import(
  '../src/components/admin/purchasing/SupplierActivityPanel'
);
const { InventoryReconciliationCard } = await import(
  '../src/components/admin/settings/InventoryReconciliationPanel'
);
const {
  deliveryTotals,
  lineDifference,
  purchaseOrderSummaryRows,
  purchaseOrderLineRows,
  receiptLineRows,
  reconciliationRows,
  reconciliationPositionRows,
} = await import('../src/lib/purchasing');
const { supplierActivityRows } = await import('../src/lib/suppliers');
const { formatMoney } = await import('../src/lib/format');

type PurchaseOrderSummary = import('../src/types/purchasing').PurchaseOrderSummary;
type PurchaseOrderLineStatus =
  import('../src/types/purchasing').PurchaseOrderLineStatus;
type PurchaseReceiptLineDetail =
  import('../src/types/purchasing').PurchaseReceiptLineDetail;
type SupplierActivityRow = import('../src/types/purchasing').SupplierActivityRow;
type ReceiptLineDraft = import('../src/types/purchasing').ReceiptLineDraft;

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

const doc = win.document as unknown as Document;

// Intl puts a NON-BREAKING SPACE between currency and number, and renderToString
// encodes apostrophes and ampersands. Both sides of every comparison go through
// this, so a comparison is about the FIGURE and not about which invisible
// character separates it from its symbol.
const norm = (s: string) => s.replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
const strip = (html: string) =>
  norm(
    html
      .replace(/<[^>]+>/g, ' ')
      .replace(/&#x27;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"'),
  );
// THE EXPECTED STRING COMES FROM THE APP'S OWN FORMATTER. Node's ICU renders NGN
// as "NGN 1,000.00" while a browser renders "₦1,000.00"; hand-typing either one
// makes the proof pass or fail for a reason that has nothing to do with the
// component.
const money = (v: number) => norm(formatMoney(v, 'NGN'));

// ===========================================================================
// PART 1 — THE OUTSTANDING LIST, FROM RAW WIRE ROWS
// ===========================================================================
// The rows below are what PostgREST ACTUALLY SENDS: numeric as strings, int8 as
// numbers, in one row. They go through the REAL boundary — purchaseOrderSummaryRows,
// exported from lib/purchasing for exactly this — and then into the REAL table.
// A proof that declared its own parser would prove its own parser.
console.log('\n--- PART 1: the outstanding list, from raw wire rows ---');

const WIRE_ORDERS: unknown[] = [
  {
    id: 'po-1',
    seq: 12, // int8 -> NUMBER
    tenant_id: 't-1',
    property_id: 'p-1',
    order_number: 'PO-000012',
    status: 'part_received',
    order_date: '2026-08-10',
    expected_date: '2026-08-14', // in the past, and still open -> LATE
    note: null,
    cancel_reason: null,
    ordered_at: '2026-08-10T09:00:00Z',
    cancelled_at: null,
    created_at: '2026-08-10T09:00:00Z',
    created_by: 'u-1',
    supplier_id: 's-1',
    supplier_name: 'Bonny Fresh Foods',
    supplier_code: 'BFF',
    destination_location_id: 'l-1',
    destination_name: 'Main Store',
    destination_kind: 'store',
    is_open: true,
    line_count: 3, // int8 -> NUMBER
    ordered_value: '60000.00', // numeric -> STRING
    received_value: '56400.00', // numeric -> STRING
    outstanding_value: '3600.00', // numeric -> STRING
    last_receipt_date: '2026-08-13',
    receipt_count: 1, // int8 -> NUMBER
  },
  {
    id: 'po-2',
    seq: 11,
    tenant_id: 't-1',
    property_id: 'p-1',
    order_number: 'PO-000011',
    status: 'received',
    order_date: '2026-08-02',
    expected_date: '2026-08-05',
    note: null,
    cancel_reason: null,
    ordered_at: '2026-08-02T09:00:00Z',
    cancelled_at: null,
    created_at: '2026-08-02T09:00:00Z',
    created_by: 'u-1',
    supplier_id: 's-2',
    supplier_name: 'Island Drinks & Co',
    supplier_code: null,
    destination_location_id: 'l-1',
    destination_name: 'Main Store',
    destination_kind: 'store',
    is_open: false, // complete: NOT late, though its date has passed
    line_count: 1,
    ordered_value: '10000.00',
    received_value: '10000.00',
    outstanding_value: '0.00',
    last_receipt_date: '2026-08-04',
    receipt_count: 1,
  },
];

const orders: PurchaseOrderSummary[] = purchaseOrderSummaryRows.rows(WIRE_ORDERS);

ok(
  'the boundary turns the numeric STRINGS into numbers',
  typeof orders[0].ordered_value === 'number' &&
    typeof orders[0].outstanding_value === 'number',
  `${typeof orders[0].ordered_value}`,
);
ok(
  'and leaves the int8 NUMBERS as numbers',
  typeof orders[0].line_count === 'number' && orders[0].line_count === 3,
);
// THE ASSERTION THAT CATCHES THE NEAR MISS. Unparsed, "60000.00" + "10000.00"
// is "60000.0010000.00" — a string, which formats to a dash and never throws.
ok(
  'so the two orders ADD rather than concatenate',
  orders[0].ordered_value + orders[1].ordered_value === 70000,
  String(orders[0].ordered_value + orders[1].ordered_value),
);

const listHtml = renderToString(
  React.createElement(
    MemoryRouter,
    null,
    React.createElement(PurchaseOrderTable, {
      rows: orders,
      currency: 'NGN',
      propertySlug: 'finima',
      // The PROPERTY's today, passed in rather than read from the clock, so this
      // render is deterministic.
      today: '2026-08-24',
    }),
  ),
);
const listText = strip(listHtml);

ok('the list renders both orders', listText.includes('PO-000012') && listText.includes('PO-000011'));
ok('...with the money formatted, not dashed', listText.includes(money(56400)), money(56400));
ok(
  'an OPEN order past its expected date is marked Late',
  /PO-000012[\s\S]*?Late/.test(listText),
);
// RULE 27: without this the "Late" assertion would also pass for a badge that
// renders on every row. The fixture's second order is deliberately PAST its date
// AND complete, so the two cases differ by exactly the rule being asserted.
ok(
  'a COMPLETE order past its expected date is NOT marked Late',
  !/PO-000011[\s\S]*?Late/.test(listText),
);

// The four tiles, which must span the filter rather than the page — the figures
// are the caller's, so what is proven here is that they REACH the screen and are
// labelled apart.
const cardHtml = renderToString(
    React.createElement(PurchaseSummaryCard, {
      summary: {
        orderCount: 2,
        openCount: 1,
        orderedValue: 70000,
        receivedValue: 66400,
        outstandingValue: 3600,
      },
      currency: 'NGN',
    }),
);
const cardText = strip(cardHtml);
ok('the ordered and received totals are shown APART',
  cardText.includes(money(70000)) && cardText.includes(money(66400)));
// ASSERTED AGAINST THE RAW HTML, not the stripped text: rule 16's note is an
// aria-label and a title ATTRIBUTE, which is exactly what makes it reachable by
// a screen reader and by a keyboard — and exactly what strip() removes. The
// first version of this assertion read the stripped text and went red against a
// component that was working, which is the harness fault rule 22 warns about.
ok('...and each carries its "how this was calculated" note',
  cardHtml.includes('all pages') && cardHtml.includes('INVOICED'));
// A FAILED total shows a dash, never a confident zero.
const emptyCard = strip(
  renderToString(
    React.createElement(PurchaseSummaryCard, { summary: null, currency: 'NGN' }),
  ),
);
ok('a total that could not be loaded reads as no value, not as zero',
  emptyCard.includes('—') && !emptyCard.includes(money(0)));

// ===========================================================================
// PART 2 — THE RECEIVE SCREEN, DRIVEN
// ===========================================================================
console.log('\n--- PART 2: the receive screen, driven ---');

const WIRE_LINES: unknown[] = [
  {
    purchase_order_line_id: 'pol-1',
    tenant_id: 't-1',
    property_id: 'p-1',
    purchase_order_id: 'po-1',
    order_number: 'PO-000012',
    order_status: 'ordered',
    line_number: 1, // int4 -> NUMBER
    line_type: 'inventory',
    inventory_item_id: 'i-rice',
    item_name: 'Rice (long grain)',
    item_code: 'FD-001',
    base_unit: 'kg',
    tracks_expiry: false,
    description: null,
    ordered_quantity: '50.0000', // numeric -> STRING
    ordered_unit_cost: '1200.00', // numeric -> STRING
    note: null,
    received_quantity: '0.0000',
    received_value: '0.00',
    closed_short: false,
    outstanding_quantity: '50.0000',
    is_settled: false,
    last_unit_cost: null,
  },
  {
    // THE LINE THAT MAKES THE COST ASSERTIONS ABLE TO FAIL (finding F above):
    // its invoiced cost will differ from the ordered one, so a totals function
    // that used the wrong cost cannot come out the same by accident.
    purchase_order_line_id: 'pol-2',
    tenant_id: 't-1',
    property_id: 'p-1',
    purchase_order_id: 'po-1',
    order_number: 'PO-000012',
    order_status: 'ordered',
    line_number: 2,
    line_type: 'inventory',
    inventory_item_id: 'i-oil',
    item_name: 'Groundnut oil',
    item_code: 'FD-020',
    base_unit: 'litre',
    tracks_expiry: false,
    description: null,
    ordered_quantity: '20.0000',
    ordered_unit_cost: '500.00',
    note: null,
    received_quantity: '0.0000',
    received_value: '0.00',
    closed_short: false,
    outstanding_quantity: '20.0000',
    is_settled: false,
    last_unit_cost: null,
  },
];

const orderLines: PurchaseOrderLineStatus[] = purchaseOrderLineRows.rows(WIRE_LINES);
ok(
  'the line boundary parses the quantities and costs',
  orderLines[0].outstanding_quantity === 50 && orderLines[0].ordered_unit_cost === 1200,
);

// --- the pure arithmetic the screen runs, exercised rather than restated -----
const shortDraft: ReceiptLineDraft = {
  purchaseOrderLineId: 'pol-1',
  quantity: 47,
  unitCost: 1200,
  closedShort: false,
  reason: '',
  batchCode: '',
  expiryDate: '',
  note: '',
};
const dearerDraft: ReceiptLineDraft = {
  purchaseOrderLineId: 'pol-2',
  quantity: 20,
  unitCost: 540, // ₦40 a litre MORE than ordered
  closedShort: false,
  reason: '',
  batchCode: '',
  expiryDate: '',
  note: '',
};

const shortDiff = lineDifference(orderLines[0], shortDraft);
ok('47 of 50 is a difference of −3', shortDiff.quantityDifference === -3);
ok('...which NEEDS A REASON', shortDiff.needsReason);
ok('...and is not an over-receipt', !shortDiff.isOverReceipt);

const overDiff = lineDifference(orderLines[0], { ...shortDraft, quantity: 55 });
ok('55 of 50 IS an over-receipt', overDiff.isOverReceipt && overDiff.quantityDifference === 5);
ok('...and needs a reason too', overDiff.needsReason);

const exactDiff = lineDifference(orderLines[0], { ...shortDraft, quantity: 50 });
ok('exactly 50 needs no reason', !exactDiff.needsReason && !exactDiff.isOverReceipt);

const costDiff = lineDifference(orderLines[1], dearerDraft);
ok('a price RISE reads as positive', costDiff.unitCostDifference === 40);
ok('...and is worth ₦800 across 20 litres', costDiff.costDifferenceValue === 800);

const totals = deliveryTotals(orderLines, new Map([
  ['pol-1', shortDraft],
  ['pol-2', dearerDraft],
]));
ok('the delivery is worth the INVOICED total', totals.invoiceValue === 47 * 1200 + 20 * 540,
  String(totals.invoiceValue));
ok('...against the ORDERED prices for the same quantities',
  totals.orderedValue === 47 * 1200 + 20 * 500, String(totals.orderedValue));
ok('...so the cost difference is ₦800', totals.costDifferenceValue === 800);
// ONE, not two: the oil line arrives in full, so only the short rice line needs
// explaining. Asserting 2 here would have been an assertion that could not tell
// "counts lines with a difference" from "counts every line".
ok('only the line with a difference needs a reason typed into it',
   totals.linesNeedingReason === 1, String(totals.linesNeedingReason));
ok('and no manager is needed for a short delivery', !totals.needsManager);

const overTotals = deliveryTotals(orderLines, new Map([
  ['pol-1', { ...shortDraft, quantity: 55, reason: 'they sent more' }],
]));
ok('an OVER delivery needs a manager', overTotals.needsManager);

// --- and now the real component, driven ------------------------------------
const host = doc.createElement('div');
doc.body.appendChild(host);
const root = createRoot(host);

const ORDER: PurchaseOrderSummary = orders[0];

await act(async () => {
  root.render(
    React.createElement(
      ToastProvider,
      null,
      React.createElement(ReceiveForm, {
        order: ORDER,
        lines: orderLines,
        propertySlug: 'finima',
        currency: 'NGN',
        today: '2026-08-24',
        onReceived: () => {},
        onCancel: () => {},
      }),
    ),
  );
});

const text = () => norm(host.textContent ?? '');
const inputs = () => Array.from(host.querySelectorAll('input')) as HTMLInputElement[];

ok('the form shows what is outstanding on each line',
   text().includes('50 kg') && text().includes('20 litre'));
ok('...and nothing is on the delivery until a line is ticked',
   !text().includes('lines on this delivery') && !text().includes('line on this delivery'));

// TYPING AND TICKING MUST BOTH BYPASS REACT'S VALUE TRACKER. `el.value = x` and
// `el.checked = true` each update the tracker React keeps on the node through
// the same property, so the change looks to React like nothing happened and the
// component never re-renders. The PROTOTYPE setter is what makes React see it.
// The first version of this proof set `.checked` directly, the row never
// opened, and the failure read exactly like a broken component.
function setNative(el: HTMLInputElement, prop: 'value' | 'checked', value: unknown) {
  const setter = Object.getOwnPropertyDescriptor(
    win.HTMLInputElement.prototype,
    prop,
  )!.set!;
  setter.call(el, value);
}
function type(el: HTMLInputElement, value: string) {
  setNative(el, 'value', value);
  el.dispatchEvent(new win.Event('input', { bubbles: true }) as unknown as Event);
}

// Tick the rice line.
const checkbox = inputs().find((i) => i.type === 'checkbox');
await act(async () => {
  setNative(checkbox!, 'checked', true);
  checkbox!.dispatchEvent(new win.Event('click', { bubbles: true }) as unknown as Event);
  checkbox!.dispatchEvent(new win.Event('change', { bubbles: true }) as unknown as Event);
});
ok('ticking a line opens it for entry', Boolean(inputs().find((i) => i.type === 'number')));

const numberBox = () =>
  inputs().find((i) => i.type === 'number') as HTMLInputElement | undefined;

ok('the quantity box starts EMPTY, never pre-filled with what was expected',
   numberBox()?.value === '',
   `value "${numberBox()?.value}"`);

await act(async () => {
  type(numberBox()!, '47');
});

ok('47 against 50 shows the difference on the row', text().includes('-3'),
   text().slice(0, 400));
ok('...and asks for a reason', text().toLowerCase().includes('why the difference') ||
   Boolean(host.querySelector('input[placeholder="Why the difference"]')));
ok('...and does NOT ask for a manager', !text().includes('Manager PIN'));
ok('...while the effect names this delivery\'s own figure',
   text().includes(money(56400)), money(56400));

// Now push it over.
await act(async () => {
  type(numberBox()!, '55');
});

ok('55 against 50 asks for a MANAGER', text().includes('Manager PIN'));
ok('...and says why, in this delivery\'s own words',
   text().includes('More arrived than was ordered'));
// ADDED AFTER THE BREAKAGE PASS, and this is the finding rather than a
// footnote. Mutation A — needsReason narrowed to a SHORT delivery only — turned
// exactly ONE assertion red, and it was the pure-function one. The RENDERED
// reason field was asserted only at 47, which is short and still asks under the
// broken rule, so the screen half of that defect was invisible. An over-receipt
// needs explaining just as much as a short one, and now the row is asserted to
// ask for it.
ok('...and STILL asks for a reason on the way up',
   Boolean(host.querySelector('input[placeholder="Why the difference"]')));

// And back to exactly what was expected.
await act(async () => {
  type(numberBox()!, '50');
});
ok('50 against 50 asks for neither',
   !text().includes('Manager PIN') && !host.querySelector('input[placeholder="Why the difference"]'));

await act(async () => {
  root.unmount();
});

// ===========================================================================
// PART 3 — THE ORDER'S OWN TABLES
// ===========================================================================
console.log('\n--- PART 3: the order lines and the deliveries ---');

const linesText = strip(
  renderToString(
    React.createElement(OrderLinesTable, { lines: orderLines, currency: 'NGN' }),
  ),
);
ok('an unsettled line reads as Waiting', linesText.includes('Waiting'));
ok('...and nothing claims the order is complete',
   !linesText.includes('has arrived or been closed short'));

const settled: PurchaseOrderLineStatus[] = orderLines.map((l) => ({
  ...l,
  received_quantity: l.ordered_quantity,
  outstanding_quantity: 0,
  is_settled: true,
}));
const settledText = strip(
  renderToString(
    React.createElement(OrderLinesTable, { lines: settled, currency: 'NGN' }),
  ),
);
ok('a fully settled order says so', settledText.includes('has arrived or been closed short'));
ok('...and no line still reads as Waiting', !settledText.includes('Waiting'));

const WIRE_RECEIPT_LINES: unknown[] = [
  {
    id: 'prl-1',
    tenant_id: 't-1',
    property_id: 'p-1',
    purchase_receipt_id: 'gr-1',
    receipt_number: 'GRN-000001',
    business_date: '2026-08-13',
    delivery_note: 'DN-88',
    invoice_number: 'INV-4102',
    authorised_by: null,
    purchase_order_id: 'po-1',
    order_number: 'PO-000012',
    purchase_order_line_id: 'pol-1',
    line_number: 1,
    quantity: '47.0000',
    unit_cost: '1200.00',
    closed_short: false,
    reason: 'part delivery, rest Friday',
    batch_code: null,
    expiry_date: null,
    note: null,
    stock_movement_id: 'sm-1',
    created_at: '2026-08-13T10:00:00Z',
    created_by: 'u-1',
    ordered_quantity: '50.0000',
    ordered_unit_cost: '1200.00',
    inventory_item_id: 'i-rice',
    item_name: 'Rice (long grain)',
    item_code: 'FD-001',
    base_unit: 'kg',
    line_value: '56400.00',
    unit_cost_difference: '0.00',
    cost_difference_value: '0.00',
  },
  {
    id: 'prl-2',
    tenant_id: 't-1',
    property_id: 'p-1',
    purchase_receipt_id: 'gr-1',
    receipt_number: 'GRN-000001',
    business_date: '2026-08-13',
    delivery_note: 'DN-88',
    invoice_number: 'INV-4102',
    authorised_by: null,
    purchase_order_id: 'po-1',
    order_number: 'PO-000012',
    purchase_order_line_id: 'pol-2',
    line_number: 2,
    quantity: '20.0000',
    unit_cost: '540.00',
    closed_short: false,
    reason: null,
    batch_code: null,
    expiry_date: null,
    note: null,
    stock_movement_id: 'sm-2',
    created_at: '2026-08-13T10:00:00Z',
    created_by: 'u-1',
    ordered_quantity: '20.0000',
    ordered_unit_cost: '500.00',
    inventory_item_id: 'i-oil',
    item_name: 'Groundnut oil',
    item_code: 'FD-020',
    base_unit: 'litre',
    line_value: '10800.00',
    // A PRICE RISE, and it is a STRING on the wire like every other numeric.
    unit_cost_difference: '40.00',
    cost_difference_value: '800.00',
  },
];

const receiptLines: PurchaseReceiptLineDetail[] =
  receiptLineRows.rows(WIRE_RECEIPT_LINES);
ok('the receipt boundary parses the cost difference',
   receiptLines[1].unit_cost_difference === 40);

const receiptsText = strip(
  renderToString(
    React.createElement(ReceiptLinesTable, { rows: receiptLines, currency: 'NGN' }),
  ),
);
// THE SPACE IS THE HARNESS, NOT THE COMPONENT. React SSR separates two adjacent
// text children with an HTML comment, which strip() turns into a space — so the
// rendered "+₦40.00" reads as "+ ₦40.00" here. Asserting the exact string would
// have gone red against a component that renders correctly, which is the harness
// fault rule 22 warns about; the tolerance is for the separator only, never for
// the sign or the figure.
// The sign and the figure are two adjacent text children, so React SSR puts an
// HTML comment between them and strip() leaves a space. Closing that one gap is
// the harness admitting its own artefact; the SIGN and the FIGURE are still
// asserted exactly.
const signed = receiptsText.replace(/\+\s+/g, '+');
ok('a price RISE is shown with a plus', signed.includes(`+${money(40)}`),
   `expected +${money(40)}, got: ${signed.slice(0, 200)}`);
// RULE 27: the first line's difference is ZERO, so a component that rendered a
// figure on every row would show "+₦0.00" and this would catch it. Without the
// zero line, "shows the difference" could not tell a real figure from a
// decoration.
ok('...and a line at the agreed price shows NOTHING, not a zero',
   !receiptsText.includes(money(0)));
ok('the short line keeps its reason on the record',
   receiptsText.includes('part delivery, rest Friday'));

// ===========================================================================
// PART 4 — SUPPLIER ACTIVITY, AND WHAT IS NOT ON IT
// ===========================================================================
console.log('\n--- PART 4: supplier activity, and the balance that is not there ---');

const WIRE_ACTIVITY: unknown[] = [
  {
    purchase_order_id: 'po-1',
    tenant_id: 't-1',
    property_id: 'p-1',
    supplier_id: 's-1',
    supplier_name: 'Bonny Fresh Foods',
    supplier_code: 'BFF',
    order_number: 'PO-000012',
    status: 'part_received',
    order_date: '2026-08-10',
    expected_date: '2026-08-14',
    ordered_at: '2026-08-10T09:00:00Z',
    cancelled_at: null,
    cancel_reason: null,
    ordered_value: '60000.00',
    received_value: '56400.00',
    outstanding_value: '3600.00',
    last_receipt_date: '2026-08-13',
    receipt_count: 1, // int8 -> NUMBER, beside three STRINGS
    is_late: true,
  },
  {
    purchase_order_id: 'po-3',
    tenant_id: 't-1',
    property_id: 'p-1',
    supplier_id: 's-1',
    supplier_name: 'Bonny Fresh Foods',
    supplier_code: 'BFF',
    order_number: 'PO-000009',
    status: 'received',
    order_date: '2026-07-30',
    expected_date: '2026-08-01',
    ordered_at: '2026-07-30T09:00:00Z',
    cancelled_at: null,
    cancel_reason: null,
    ordered_value: '25000.00',
    received_value: '25000.00',
    outstanding_value: '0.00',
    last_receipt_date: '2026-08-01',
    receipt_count: 1,
    is_late: false,
  },
];

const activity: SupplierActivityRow[] = supplierActivityRows.rows(WIRE_ACTIVITY);
ok('the activity boundary parses the three money fields',
   activity[0].ordered_value === 60000 && activity[0].outstanding_value === 3600);
ok('...and leaves the int8 count a number', activity[0].receipt_count === 1);

const activityText = strip(
  renderToString(
    React.createElement(SupplierActivityTable, { rows: activity, currency: 'NGN' }),
  ),
);
ok('both orders are listed', activityText.includes('PO-000012') && activityText.includes('PO-000009'));
ok('the late one is flagged', /PO-000012[\s\S]*?Late/.test(activityText));
ok('the complete one is not', !/PO-000009[\s\S]*?Late/.test(activityText));

// THE ASSERTION THIS PART EXISTS FOR. Receiving credits supplier_payable and
// nothing in 1.1h2 debits it, so a figure here that reads as a balance would be
// right until the first payment and silently wrong forever after. This is what
// turns "we decided not to" into something a later edit cannot quietly undo.
const forbidden = ['balance', 'owed', 'owing', 'payable', 'statement', 'due'];
const lowered = activityText.toLowerCase();
const found = forbidden.filter((w) => lowered.includes(w));
ok('NOTHING on this table reads as a supplier balance', found.length === 0,
   found.length ? `found: ${found.join(', ')}` : 'none of ' + forbidden.join(', '));

// RULE 27: without a control, that assertion would also pass for an EMPTY table.
ok('...and the table is not empty, so the check above means something',
   activityText.includes(money(60000)));


// ===========================================================================
// PART 5 — THE RECONCILIATION CARD
// ===========================================================================
// TWO FIGURES THAT MUST NOT BE CONFLATED, and a card that treated them the same
// would make both useless: the ledger check must be zero and is an alarm, the
// valuation check is rounding and is not. A card that shouted about a kobo would
// train everybody to ignore the one that matters.
//
// 047 ADDS THE TWO THINGS THAT MAKE THE RESIDUE READABLE, and both are asserted
// here because both fail silently: the DENOMINATOR it accumulated over, and the
// NAMED shelf with the reason its average moved.
console.log('\n--- PART 5: does the ledger agree with the stock? ---');

const WIRE_RECON = (over: Record<string, unknown>): unknown => ({
  property_id: 'p-1',
  account_id: 'a-1300',
  account_code: '1300',
  account_name: 'Inventory',
  ledger_balance: '278500.00',
  expected_ledger_balance: '278500.00',
  ledger_difference: '0.00',
  pre_gl_value: '0.00',
  pre_wiring_value: '0.00',
  non_posting_value: '0.00',
  unvaluable_movement_count: 0,
  valuation_value: '278500.00',
  valuation_difference: '0.00',
  valued_movement_count: 40,
  reset_position_count: 0,
  negative_position_count: 0,
  ...over,
});

// A position row as the function sends it: numerics as STRINGS, counts as JSON
// numbers, the flag as a boolean. One row, all three mappings (rule 24).
const WIRE_POS = (over: Record<string, unknown>): unknown => ({
  location_id: 'l-1',
  location_name: 'Main Store',
  inventory_item_id: 'i-1',
  item_name: 'Rice (long grain)',
  item_code: 'FD-001',
  base_unit: 'kg',
  quantity_on_hand: '15.0000',
  movement_value: '27000.00',
  valuation_value: '21000.00',
  difference: '-6000.00',
  movement_count: 3,
  passed_through_negative: true,
  ...over,
});

type ReconPosition = import('../src/types/purchasing').InventoryReconciliationPosition;
const NO_POSITIONS: ReconPosition[] = [];

const card = (row: unknown, positions: ReconPosition[]) =>
  strip(
    renderToString(
      React.createElement(InventoryReconciliationCard, {
        row: row as import('../src/types/purchasing').InventoryGlReconciliation,
        positions,
        currency: 'NGN',
      }),
    ),
  );

const agrees = reconciliationRows.rows([WIRE_RECON({})])[0];
ok('the reconciliation boundary parses the balances',
   agrees.ledger_balance === 278500 && agrees.ledger_difference === 0);
ok('...and the two counts 047 added', agrees.valued_movement_count === 40 &&
   agrees.reset_position_count === 0);

const agreesText = card(agrees, NO_POSITIONS);
ok('a ledger that agrees says so', agreesText.includes('Agrees'));
ok('...and raises NO alarm', !agreesText.includes('needs looking at'));

// A KOBO OF ROUNDING. Normal, correct, and must NOT read as a failure — money
// has two decimals and a moving average does not.
const rounded = reconciliationRows.rows([
  WIRE_RECON({ valuation_value: '278500.01', valuation_difference: '0.01' }),
])[0];
const roundedText = card(rounded, NO_POSITIONS);
ok('a kobo of ROUNDING still reads as agreeing', roundedText.includes('Agrees'));
ok('...and still raises no alarm', !roundedText.includes('needs looking at'));

// A POSTING THAT WENT MISSING. This is the fifty thousand the ERP could not
// explain, and the assertion the whole shipment exists to make possible.
const broken = reconciliationRows.rows([
  WIRE_RECON({
    ledger_balance: '228500.00',
    ledger_difference: '-50000.00',
    valuation_difference: '50000.00',
  }),
])[0];
const brokenText = card(broken, NO_POSITIONS);
ok('a MISSING posting reads as not agreeing', brokenText.includes('Does NOT agree'));
ok('...names the size of the gap', brokenText.includes(money(50000)), money(50000));
ok('...says which way it is out', brokenText.includes('lower'));
ok('...and says it will not fix itself', brokenText.includes('needs looking at'));

// --- THE RESIDUE COMES WITH ITS DENOMINATOR -------------------------------
// A kobo across 40 movements is arithmetic; across 4,000 it is not. The figure
// cannot be judged without the count, so the count is on the FACE of the card
// rather than in its tooltip.
ok('the residue carries the number of movements it accumulated over',
   roundedText.includes('across 40 movements'), roundedText.slice(0, 200));

const busy = reconciliationRows.rows([
  WIRE_RECON({ valuation_value: '278500.01', valuation_difference: '0.01',
               valued_movement_count: 4000 }),
])[0];
const busyText = card(busy, NO_POSITIONS);
// RULE 27: the SAME kobo with a different denominator must render DIFFERENTLY,
// or the denominator is decoration. A hard-coded or dropped count turns this red
// while every other assertion on this card stays green.
ok('...and the SAME kobo across 4,000 movements reads differently',
   busyText.includes('across 4,000 movements') && !busyText.includes('across 40 movements'),
   busyText.slice(0, 200));

// --- THE NAMED EXCEPTION --------------------------------------------------
const negative = reconciliationRows.rows([
  WIRE_RECON({
    valuation_value: '270000.00',
    valuation_difference: '-8500.00',
    reset_position_count: 1,
    negative_position_count: 2,
  }),
])[0];

const positions: ReconPosition[] = reconciliationPositionRows.rows([
  // The reset shelf — the one that actually caused the divergence.
  WIRE_POS({}),
  // A shelf that reconciles EXACTLY. Must not be listed: a list padded with
  // rows that agree is a list nobody reads.
  WIRE_POS({
    inventory_item_id: 'i-2', item_name: 'Groundnut oil',
    movement_value: '5000.00', valuation_value: '5000.00',
    difference: '0.00', movement_count: 2, passed_through_negative: false,
  }),
  // A shelf a kobo out from ordinary rounding — a DIFFERENT sentence from the
  // reset one, which is what stops the explanation being boilerplate.
  WIRE_POS({
    inventory_item_id: 'i-3', item_name: 'Bleach', location_name: 'Housekeeping',
    movement_value: '1200.55', valuation_value: '1200.56',
    difference: '0.01', movement_count: 9, passed_through_negative: false,
  }),
]);

ok('the position boundary parses the difference and the count',
   positions[0].difference === -6000 && positions[0].movement_count === 3 &&
   positions[0].passed_through_negative === true);

const namedText = card(negative, positions);
ok('the differing shelf is NAMED, with its item and its location',
   namedText.includes('Rice (long grain), Main Store'), namedText.slice(0, 260));
ok('...and the RESET is stated in words an owner can act on',
   namedText.includes('has been below zero') &&
   namedText.includes('average was reset to the incoming cost'));
ok('...with the movement count that shelf accumulated over',
   namedText.includes('across 3 movements'));
// RULE 27, TWICE. Without the first, "names the reset" would also pass for a
// card printing the same sentence on every row; without the second, the list
// could be padded with shelves that agree and nobody would notice.
ok('...while a shelf that is merely ROUNDING gets the OTHER sentence',
   namedText.includes('Bleach, Housekeeping') &&
   namedText.includes('money carries two decimals'));
ok('...and a shelf that reconciles EXACTLY is not listed at all',
   !namedText.includes('Groundnut oil'));
ok('a property with no differences lists no shelves',
   !agreesText.includes('Where the difference is'));

// BELOW ZERO TODAY is a different question from HAS EVER BEEN, and 046 showed
// only the first. Both sentences exist and they must not be confused.
ok('a position below zero TODAY is called out separately',
   namedText.includes('2 positions') && namedText.includes('less than nothing right now'));
ok('...and is NOT printed when there are none',
   !agreesText.includes('less than nothing'));

// --- PRE-WIRING VALUE: the 047 fix, REPORTED and not absorbed --------------
const preWired = reconciliationRows.rows([
  WIRE_RECON({ pre_wiring_value: '533000.00', valuation_value: '811500.00' }),
])[0];
const preWiredText = card(preWired, NO_POSITIONS);
ok('build-era value is reported on its face, not silently netted off',
   preWiredText.includes(money(533000)) &&
   preWiredText.includes('before this property began posting'));
ok('...and the ledger still reads as AGREEING, which is the point of 047',
   preWiredText.includes('Agrees'));
ok('...and that sentence is absent when there is none',
   !agreesText.includes('before this property began posting'));

console.log(`\n${fail === 0 ? 'GREEN' : 'RED'}  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
