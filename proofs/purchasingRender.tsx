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
const { OverReceiptsTable } = await import(
  '../src/components/admin/inventory/ProvenanceTab'
);
const { overReceiptRows } = await import('../src/lib/stockProvenance');
const { formatMoney, MISSING_VALUE } = await import('../src/lib/format');
const { orderLinesSummary, SUPPLIER_ACTIVITY_ABOUT } = await import(
  '../src/lib/purchasingLabels'
);
const { humanizeError } = await import('../src/lib/errors');

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
    React.createElement(ReceiptLinesTable, {
      rows: receiptLines,
      currency: 'NGN',
      currentUserId: null,
    }),
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
// 1.1a CHANGED THIS ASSERTION, and the change is the finding. The cell used
// to be EMPTY when the cost had not moved, which on the live walk put '+NGN
// 50.00' on one row and a blank on the row under it -- and a blank is what a
// cell that failed to render also looks like. CLAUDE.md section 6: a figure
// that is not there reads as the em-dash. Still never a '0.00', which would be
// a different lie (a computed zero nobody computed).
ok('...and never a zero where the price simply did not move',
   !receiptsText.includes(money(0)));
// THE EM-DASH ASSERTION IS IN PART 6, ON A FIXTURE BUILT FOR IT. Written here
// first as `receiptsText.includes(MISSING_VALUE)`, it STAYED GREEN when the cell
// was reverted to a blank -- because WIRE_RECEIPT_LINES has a null reason on its
// second row, so there was an em-dash on screen either way. Rule 27's second
// shape exactly: an assertion whose fixture is already in the state being
// asserted.
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
  unvaluable_value: '0.00',
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

// --- 048: THE MOVEMENT WITH NO COST BASIS, IN WORDS SOMEBODY CAN ACT ON ---
// The card used to say these movements were "on neither side", which is the same
// false claim 047's comment made. They are on one side: absent from the ledger,
// PRESENT in the valuation, because the valuation is quantity times an average
// and the movement moved the quantity.
ok('with nothing unvaluable, the sentence is absent',
   !agreesText.includes('no cost history'));

const unvaluable = reconciliationRows.rows([
  WIRE_RECON({
    unvaluable_movement_count: 1,
    unvaluable_value: '-4000.00',
    valuation_value: '274500.00',
    valuation_difference: '0.00',
  }),
])[0];
ok('the boundary parses the new bucket as a number',
   unvaluable.unvaluable_value === -4000 &&
   typeof unvaluable.unvaluable_value === 'number');

const unvaluableText = card(unvaluable, NO_POSITIONS);
// RULE 27, and the defect each one turns red for:
// Dropping unvaluable_value from the sentence, or formatting the raw signed
// number, turns this red while every other assertion on the card stays green.
ok('...the card NAMES what the unvalued quantity is worth',
   unvaluableText.includes(money(4000)), unvaluableText.slice(0, 400));
// Reverting the sentence to 047's claim turns this red. It is asserted as an
// ABSENCE because the wrong version is a specific wrong sentence.
ok('...and no longer claims it is "on neither side"',
   !unvaluableText.includes('neither side'));
// A figure with no instruction is a figure an owner cannot act on (rule 16/25):
// the effect is on screen, the general rule is behind the information icon.
ok('...says which side it IS on',
   unvaluableText.includes('in the stock valuation and not on the books'),
   unvaluableText.slice(0, 400));
ok('...and says what to do about it',
   unvaluableText.includes('write-off'), unvaluableText.slice(0, 400));
// The whole point of 048: with the bucket reported, the headline figure is zero
// again, so the card must NOT read as a failure for a cause it has explained.
ok('...while the reconciliation still reads as agreeing',
   unvaluableText.includes('Agrees') && !unvaluableText.includes('needs looking at'));

// TWO unvaluable movements must read differently from one, or the count is
// decoration — the same test the residue denominator gets above.
const unvaluableTwo = reconciliationRows.rows([
  WIRE_RECON({
    unvaluable_movement_count: 2,
    unvaluable_value: '-4000.00',
    valuation_value: '274500.00',
  }),
])[0];
const unvaluableTwoText = card(unvaluableTwo, NO_POSITIONS);
ok('...and two of them read as a plural, not "1 movement"',
   unvaluableTwoText.includes('2 movements') &&
   unvaluableTwoText.includes('quantities they'),
   unvaluableTwoText.slice(0, 300));

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

// ===========================================================================
// PART 6 — 1.1a: WHAT THE LIVE WALK FOUND
// ===========================================================================
// Every assertion below names the defect that turns it red, because four of the
// five were written AFTER watching the real screen do the wrong thing and the
// temptation is to assert the thing you just saw rather than the rule behind it.
console.log('\n--- PART 6: the 1.1a fixes, each against the defect it caught ---');

// --- 6.1 humanizeError: the hint the generic layer was eating ---------------
// THE DEFECT: `case '42501': return 'You do not have permission to make this
// change.'` — which discarded the message AND the hint on all 98 of the
// migrations' insufficient_privilege refusals, 25 of them hand-written.
//
// THE FIXTURE MAKES THE TWO READINGS DISAGREE (rule 27). Under the OLD code
// both of these produce the identical sentence, so a fixture with only one of
// them could not tell the fix from the defect.
const OURS = {
  code: '42501',
  message: 'More arrived than was ordered, so a manager has to authorise accepting it.',
  hint: 'Hand the terminal to a manager.',
};
const POSTGRES_RLS = {
  code: '42501',
  message: 'new row violates row-level security policy for table "bookings"',
};
const POSTGRES_GRANT = {
  code: '42501',
  message: 'permission denied for table purchase_orders',
};

ok('a refusal the DATABASE wrote reaches the user in its own words',
   humanizeError(OURS).includes('a manager has to authorise accepting it'));
ok('...with its hint, which is the half that says what to do instead',
   humanizeError(OURS).includes('Hand the terminal to a manager'));
// RULE 27: without this, deleting the guard entirely would stay green and we
// would be showing storekeepers raw Postgres text.
ok('a real RLS denial still reads as the friendly sentence',
   humanizeError(POSTGRES_RLS) === 'You do not have permission to make this change.');
ok('...and so does a bare GRANT denial',
   humanizeError(POSTGRES_GRANT) === 'You do not have permission to make this change.');
// A 42501 with no message at all has nothing to show, so it takes the fallback.
ok('...and a 42501 carrying no message falls back rather than printing nothing',
   humanizeError({ code: '42501' }) ===
     'You do not have permission to make this change.');
// The other mapped codes are untouched, which is the blast radius staying small.
ok('the unique-violation mapping is unchanged',
   humanizeError({ code: '23505', message: 'duplicate key' }) ===
     'That already exists. Please use a different value.');

// --- 6.2 lineDifference: nothing typed is not zero arrived ------------------
// THE DEFECT: `const entered = draft.quantity ?? 0`, which read an untouched
// row as a delivery of none — so ticking a line immediately showed "-100"
// against stock nobody had counted and demanded a reason for it.
const UNTOUCHED_LINE = orderLines[0];
const blank = {
  purchaseOrderLineId: UNTOUCHED_LINE.purchase_order_line_id,
  quantity: null,
  unitCost: UNTOUCHED_LINE.ordered_unit_cost,
  closedShort: false,
  reason: '',
  batchCode: '',
  expiryDate: '',
  note: '',
};
const blankDiff = lineDifference(UNTOUCHED_LINE, blank);
ok('a ticked line with nothing typed reports NO difference',
   blankDiff.quantityDifference === 0 && blankDiff.isEntered === false);
ok('...and is not asked for a reason it has nothing to explain',
   blankDiff.needsReason === false);
// RULE 27, AND THIS IS THE ASSERTION THAT EARNS THE PAIR. Making the fix
// "always return 0 difference" would pass the two above and be useless. A TYPED
// zero is a real answer — "nothing came, nothing more is coming" — and must
// still behave exactly as before.
const typedZero = lineDifference(UNTOUCHED_LINE, { ...blank, quantity: 0 });
ok('...while a TYPED zero is still a short delivery that needs a reason',
   typedZero.isEntered === true &&
   typedZero.quantityDifference === -UNTOUCHED_LINE.outstanding_quantity &&
   typedZero.needsReason === true);
// And the over-receipt path must not have been softened on the way past.
const typedOver = lineDifference(UNTOUCHED_LINE, {
  ...blank,
  quantity: UNTOUCHED_LINE.outstanding_quantity + 5,
});
ok('...and an over-receipt still asks for a manager',
   typedOver.isOverReceipt === true && typedOver.needsReason === true);

// --- 6.3 orderLinesSummary: three states, not a fraction of one -------------
// THE DEFECT: `${settled} of ${lines.length} lines settled`, which read
// "0 of 2 lines settled" on an order where 90 of 100 kg had just arrived.
ok('an order where nothing has come says so',
   orderLinesSummary({ settled: 0, partly: 0, waiting: 2 }) ===
     '2 lines, none delivered yet.');
// THE ONE THE OLD SENTENCE GOT WRONG, and the only fixture on which the two
// implementations disagree in the way that matters.
ok('an order part-way through names the part-delivered line',
   orderLinesSummary({ settled: 0, partly: 1, waiting: 1 }) ===
     '2 lines — 1 part-delivered, 1 still waiting.');
ok('...and a finished order says all of it',
   orderLinesSummary({ settled: 2, partly: 0, waiting: 0 }) ===
     '2 lines, all settled.');
ok('...and one line reads as one line, not "1 lines"',
   orderLinesSummary({ settled: 1, partly: 0, waiting: 0 }) ===
     '1 line, all settled.');

// --- 6.4 the authoriser, which the PIN dialog promises ----------------------
// THE DEFECT: there was no column. The database recorded authorised_by and the
// application could not answer "who approved this" anywhere.
const AUTHORISED_LINES = receiptLineRows.rows([
  { ...(WIRE_RECEIPT_LINES[0] as object), authorised_by: null },
  { ...(WIRE_RECEIPT_LINES[1] as object), authorised_by: 'u-manager-7f3a1c9e' },
]);
const authorisedText = strip(
  renderToString(
    React.createElement(ReceiptLinesTable, {
      rows: AUTHORISED_LINES,
      currency: 'NGN',
      currentUserId: null,
    }),
  ),
);
ok('an authorised delivery names who approved it',
   authorisedText.includes('Authorised by') &&
   authorisedText.includes('staff u-manage'));
// RULE 27: the un-authorised line must read as a dash and not inherit the
// manager above it — a component rendering the same cell for every row would
// pass "names who approved it" and be wrong about the row that matters.
ok('...and the line that needed no authorisation reads as the em-dash',
   authorisedText.includes(MISSING_VALUE));
// RULE 27 AGAIN, FROM THE OTHER SIDE: the column is conditional, so a fixture
// where it is always present cannot test the condition. receiptsText above has
// authorised_by null on BOTH rows.
ok('...and an order with nothing authorised grows no such column',
   !receiptsText.includes('Authorised by'));
// The signed-in manager reads as "you", which is staffLabel's whole contract.
const asMeText = strip(
  renderToString(
    React.createElement(ReceiptLinesTable, {
      rows: AUTHORISED_LINES,
      currency: 'NGN',
      currentUserId: 'u-manager-7f3a1c9e',
    }),
  ),
);
ok('...and reads as "you" when it was you who approved it',
   asMeText.includes('you'));

// --- 6.4b the Cost change cell, on a fixture that can actually test it ------
// THE DEFECT: `row.unit_cost_difference !== 0 ? (figure) : null` — an EMPTY
// cell where the price had not moved, which on the walk sat directly under a
// "+NGN 50.00" and read as a cell that had failed to render.
//
// THE FIRST VERSION OF THIS ASSERTION WAS DECORATION AND THE BREAK PROVED IT.
// `receiptsText.includes(MISSING_VALUE)` stayed GREEN with the blank restored,
// because that fixture's second row has a null REASON and the reason cell emits
// a dash of its own. So this fixture gives every other dashable cell a value —
// both item names, both reasons, no authorisation — leaving the cost change as
// the only thing on the table that can produce one. Then the COUNT is the
// assertion, and the two implementations disagree on it: 1 against 0.
const dashes = (s: string) => s.split(MISSING_VALUE).length - 1;
const COST_FIXTURE = receiptLineRows.rows([
  { ...(WIRE_RECEIPT_LINES[0] as object), reason: 'short on the truck' },
  { ...(WIRE_RECEIPT_LINES[1] as object), reason: 'price rise' },
]);
const costText = strip(
  renderToString(
    React.createElement(ReceiptLinesTable, {
      rows: COST_FIXTURE,
      currency: 'NGN',
      currentUserId: null,
    }),
  ),
);
ok('a line whose price did not move reads as the em-dash, not a blank',
   dashes(costText) === 1,
   `expected exactly one em-dash on the table, found ${dashes(costText)}`);
// RULE 27 FROM THE OTHER SIDE: a component that printed a dash in every Cost
// change cell would pass the count above only by accident, so assert the row
// that DID move its price still shows the figure and not a dash.
ok('...while the line that did move its price still shows the figure',
   costText.replace(/\+\s+/g, '+').includes(`+${money(40)}`));

// --- 6.4c the provenance report's fourth section (049) ----------------------
// THE DEFECT: the report's three sections were all about stock arriving in the
// wrong PLACE, so an over-receipt — the only other act that spends a manager's
// PIN — appeared nowhere, and the report said "No deliveries have gone anywhere
// other than a store" on a day one had just been authorised.
//
// THE WIRE SHAPE IS THE HAZARD HERE (rule 24): stock_over_receipts returns six
// numerics, every one of them a STRING over PostgREST, and `+${over_quantity}`
// on an unparsed string is a figure that renders perfectly and is wrong.
const WIRE_OVER: unknown[] = [
  {
    id: 'ovr-1',
    tenant_id: 't-1',
    property_id: 'p-1',
    purchase_receipt_id: 'gr-9',
    purchase_order_id: 'po-9',
    purchase_order_line_id: 'pol-9',
    receipt_number: 'GRN-000002',
    order_number: 'PO-000001',
    business_date: '2026-11-03',
    created_at: '2026-11-03T09:00:00Z',
    delivery_note: 'DN-002',
    invoice_number: 'INV-002',
    authorised_by: 'u-manager-7f3a1c9e',
    created_by: 'u-store',
    supplier_id: 's-9',
    supplier_name: 'Bonny Fresh Foods',
    supplier_code: 'BFF',
    line_number: 1,
    inventory_item_id: 'i-oil',
    item_name: 'Vegetable oil',
    item_code: 'FD-022',
    base_unit: 'litre',
    location_name: 'Main Store',
    ordered_quantity: '20.0000',
    received_to_date: '25.0000',
    quantity: '25.0000',
    over_quantity: '5.0000',
    over_value: '17500.00',
    unit_cost: '3500.00',
    reason: 'supplier sent five litres extra',
    note: null,
    stock_movement_id: 'sm-9',
  },
];
const overRows = overReceiptRows.rows(WIRE_OVER);
ok('the over-receipt boundary parses the excess and its value',
   overRows[0].over_quantity === 5 && overRows[0].over_value === 17500);
const overText = strip(
  renderToString(
    React.createElement(OverReceiptsTable, {
      rows: overRows,
      currency: 'NGN',
      userId: null,
    }),
  ),
);
// RULE 27: the fixture's ORDERED and ARRIVED are different numbers from the
// EXCESS, so a table that printed the wrong one of the three in any cell goes
// red. A fixture where they coincided could not test any of them.
ok('the section shows what was ordered against what came',
   overText.includes('20') && overText.includes('25'));
ok('...and the excess on its own, which is the figure being authorised',
   overText.replace(/\+\s+/g, '+').includes('+5'));
ok('...valued at what the invoice charged for it',
   overText.includes(money(17500)));
ok('...with the reason given',
   overText.includes('supplier sent five litres extra'));
// THE WHOLE POINT OF THE SECTION.
ok('...and the manager whose PIN accepted it',
   overText.includes('staff u-manage'));

// --- 6.5 the supplier columns, which were lying by omission -----------------
// THE DEFECT: "Ordered / Arrived / Outstanding", three bases, nothing saying so,
// on a row reading 190,000 / 200,000 / 12,000.
ok('each money column says what it is measured on',
   activityText.includes('at the agreed price') &&
   activityText.includes('at the invoiced price'));
ok('...and "Outstanding" is now the plainer "Still to come"',
   activityText.includes('Still to come'));
// RULE 27: the explanation must be BEHIND the ⓘ and not pasted into the row,
// which is the lazy fix and the one rule 25 exists to stop.
ok('...while the explanation itself stays off the row',
   !activityText.includes('are measured on three different things'));
ok('...and is in the panel, where somebody can choose to read it',
   SUPPLIER_ACTIVITY_ABOUT.join(' ').includes(
     'not meant to add up'));

// ===========================================================================
// PART 7 — THE THREE KINDS OF PURCHASE LINE (1.1h3)
// ===========================================================================
// 052 to 055 made an order able to carry an asset or an expense. Four of the
// failure modes render perfectly, and none of them throws:
//
//   1. THE PAYLOAD. A draft row holds all four subject fields at once so a type
//      switch does not lose typing. If the mapper sends the ones that do not
//      apply, the server refuses by name -- or worse, an empty string reaches a
//      uuid cast and the person gets a type error instead of a sentence.
//
//   2. WHETHER SAVE IS PRESSABLE. Too strict blocks an order the server would
//      take; too loose sends one to be refused after all the typing is done.
//
//   3. THE MANAGER GATE. 053 narrowed the server's destination rule to
//      deliveries that actually MOVE STOCK. If the form keeps the old rule it
//      asks for a PIN the server then refuses as unnecessary: somebody fetches
//      a manager, the manager types their PIN, and the answer is that none was
//      wanted. THIS IS THE ONE THAT NEEDED A FIXTURE BUILT FOR IT -- see 7.3.
//
//   4. THE NAME OF A NON-STOCK LINE. item_name is null on one, so a delivered
//      freezer rendered as a quantity, a cost and an em-dash: the placeholder
//      doing its job over a row that had a name nothing read.
// ---------------------------------------------------------------------------
// PART 7 WAS MADE TO FAIL TEN WAYS (rules 22, 27)
// ---------------------------------------------------------------------------
// Each mutation is in the code the SCREENS run, and each turned the assertion
// named beside it red:
//
//   A  the payload sends the item on every type   -> an asset sends NO item
//   B  ...and the description on a stock line     -> a stock line sends none
//   C  an unchosen id travels as '' not null      -> travels as null
//   D  completeness stops wanting a category      -> an expense WITHOUT one
//   E  ...and wants one on every non-stock line   -> an asset needs none
//   F  the gate back to destination alone         -> asset alone asks for no
//                                                    manager (2 red)
//   G  movesStock ignores the line type           -> 3 red
//   H  movesStock counts a close-short of zero    -> moves no stock
//   I  the history falls back to the em-dash      -> names the freezer
//   J  the order line hides the category          -> says which account
//
// AND ONE ASSERTION WAS DELETED BECAUSE OF THIS RUN. It claimed neither line
// fell back to the placeholder, and its || ended in a condition asserted true
// two lines earlier, so it was true whatever the table did. Ten mutations and
// it never moved. See 7.4 for what it said and why nothing replaces it.
//
// F IS THE ONE THE FIXTURE HAD TO BE BUILT FOR, and it is rule 27's fourth
// shape: a delivery holding both rice and a freezer asks for a PIN under the
// true rule and the broken one alike, because the rice triggers the gate
// either way. The two rules disagree on exactly one case -- a non-store
// destination where nothing is stock -- so that is the fixture.
console.log('\n--- PART 7: the three kinds of purchase line ---');

const { purchaseLinePayload } = await import('../src/lib/purchasing');
const { lineComplete } = await import(
  '../src/components/admin/purchasing/PurchaseOrderForm'
);
type PurchaseOrderLineDraft =
  import('../src/types/purchasing').PurchaseOrderLineDraft;

// A row with EVERY subject field filled, which is what the form holds after
// somebody picks a kind, types a description, then switches kind and picks an
// item. The mapper's whole job is deciding which of these travel.
const FILLED: PurchaseOrderLineDraft = {
  key: 'r1',
  lineType: 'inventory',
  inventoryItemId: '11111111-1111-1111-1111-111111111111',
  description: 'left over from a previous choice',
  expenseCategoryId: '22222222-2222-2222-2222-222222222222',
  quantity: 2,
  unitCost: 100,
  note: '  ',
};

// --- 7.1 the payload sends only what the type owns -------------------------
// THE FUNCTION THE SCREEN RUNS, not a copy of its branches. An assertion that
// rebuilt these objects from its own constants would pass with the mapper
// broken -- rule 27's first shape, and what 1.1g's receipt preview did at 35/35.
const stockPayload = purchaseLinePayload(FILLED);
ok('a stock line sends its item',
   stockPayload.inventory_item_id === FILLED.inventoryItemId);
ok('...and sends NO description, though the row still holds one',
   stockPayload.description === null);
ok('...and no expense category',
   stockPayload.expense_category_id === null);

const assetPayload = purchaseLinePayload({ ...FILLED, lineType: 'asset' });
ok('an asset line sends its description',
   assetPayload.description === 'left over from a previous choice');
ok('...and NO item, though the row still holds one',
   assetPayload.inventory_item_id === null);
ok('...and no category, because only an expense has one',
   assetPayload.expense_category_id === null);

const expensePayload = purchaseLinePayload({ ...FILLED, lineType: 'expense' });
ok('an expense line sends its category',
   expensePayload.expense_category_id === FILLED.expenseCategoryId);
ok('...and its description', expensePayload.description !== null);

// NULL, NOT ''. An empty string reaches save_purchase_order's uuid cast and
// comes back as a Postgres type error instead of the sentence the function
// wrote for a missing choice (rule 21). The defect that turns this red is
// `l.inventoryItemId` without the `|| null`, which looks identical in a diff.
const EMPTY: PurchaseOrderLineDraft = {
  ...FILLED, inventoryItemId: '', description: '  ', expenseCategoryId: '',
};
ok('an unchosen item travels as null, never as an empty string',
   purchaseLinePayload(EMPTY).inventory_item_id === null);
ok('...and an unchosen category likewise',
   purchaseLinePayload({ ...EMPTY, lineType: 'expense' })
     .expense_category_id === null);
ok('...and a description of only spaces likewise',
   purchaseLinePayload({ ...EMPTY, lineType: 'asset' }).description === null);

// --- 7.2 what makes a line complete, per type ------------------------------
// ASSERTED ON BOTH SIDES OF EACH BOUNDARY, because one side alone cannot tell
// the rule from a broken one. A proof that only checked "a full expense line is
// complete" stays green if the category test is dropped altogether.
ok('a stock line with an item is complete',
   lineComplete({ ...FILLED, description: '', expenseCategoryId: '' }));
ok('...and without one is not',
   !lineComplete({ ...FILLED, inventoryItemId: '' }));
ok('an asset line with words is complete',
   lineComplete({ ...FILLED, lineType: 'asset', inventoryItemId: '' }));
ok('...and with none is not',
   !lineComplete({ ...FILLED, lineType: 'asset', description: '   ' }));
ok('an expense line with a category is complete',
   lineComplete({ ...FILLED, lineType: 'expense', inventoryItemId: '' }));
// THE SIDE WHERE THE TRUE RULE AND THE BROKEN ONE DISAGREE. Drop the category
// test and this is the only assertion in 7.2 that changes.
ok('...and WITHOUT one is not, which is the half a dropped check would pass',
   !lineComplete({ ...FILLED, lineType: 'expense', expenseCategoryId: '' }));
// An asset line must NOT be made to want a category it has nowhere to put.
ok('an asset line does not need a category',
   lineComplete({
     ...FILLED, lineType: 'asset', inventoryItemId: '', expenseCategoryId: '',
   }));

// --- 7.3 the manager gate, mirrored --------------------------------------
// THE FIXTURE IS A FREEZER ALONE, GOING TO THE BAR, and it has to be, which is
// rule 27's fourth shape. A delivery holding BOTH rice and a freezer asks for a
// PIN under the TRUE rule and the BROKEN one alike, because the rice triggers
// the gate either way -- so it cannot test this at all. The two rules disagree
// on exactly one case: a non-store destination where nothing is stock.
//
// THE DEFECT: `needsPin = needsManager || notAStore`, which is what this line
// said before 053 narrowed the server's gate to match. Under it, the form shows
// the PIN field and the required "why it went straight there" box, the person
// finds a manager, the manager types their PIN -- and
// receive_purchase_order answers "No manager PIN is needed for this delivery."
const FREEZER_ORDER: PurchaseOrderSummary = {
  ...orders[0],
  destination_name: 'Pool bar',
  destination_kind: 'bar',
};
const FREEZER_LINE = purchaseOrderLineRows.rows([
  {
    purchase_order_line_id: 'pol-asset',
    tenant_id: 't-1',
    property_id: 'p-1',
    purchase_order_id: 'po-1',
    order_number: 'PO-000012',
    order_status: 'ordered',
    line_number: 1,
    line_type: 'asset',
    inventory_item_id: null,
    item_name: null,
    item_code: null,
    base_unit: null,
    tracks_expiry: null,
    description: 'Chest freezer',
    ordered_quantity: '1.0000',
    ordered_unit_cost: '250000.00',
    note: null,
    received_quantity: '0.0000',
    received_value: '0.00',
    closed_short: false,
    outstanding_quantity: '1.0000',
    is_settled: false,
    last_unit_cost: null,
    expense_category_id: null,
    expense_category_code: null,
    expense_category_name: null,
  },
]);

const freezerHost = doc.createElement('div');
doc.body.appendChild(freezerHost);
const freezerRoot = createRoot(freezerHost);
await act(async () => {
  freezerRoot.render(
    React.createElement(
      ToastProvider,
      null,
      React.createElement(ReceiveForm, {
        order: FREEZER_ORDER,
        lines: FREEZER_LINE,
        propertySlug: 'finima',
        currency: 'NGN',
        today: '2026-08-24',
        onReceived: () => {},
        onCancel: () => {},
      }),
    ),
  );
});
const freezerText = () => norm(freezerHost.textContent ?? '');

// The line is named by its DESCRIPTION, because an asset has no item.
ok('an asset line is named on the receive screen',
   freezerText().includes('Chest freezer'));

// Tick it and receive exactly what was ordered -- no over-receipt, so the only
// thing that could ask for a manager is the destination.
// The SAME native-setter dance PART 2 documents: `.checked = true` updates the
// tracker React keeps on the node, so React sees nothing and the row never
// opens -- a failure that reads exactly like a broken component.
const freezerInputs = () =>
  Array.from(freezerHost.querySelectorAll('input')) as HTMLInputElement[];
const freezerTick = freezerInputs().find((i) => i.type === 'checkbox');
await act(async () => {
  setNative(freezerTick!, 'checked', true);
  freezerTick!.dispatchEvent(new win.Event('click', { bubbles: true }) as unknown as Event);
  freezerTick!.dispatchEvent(new win.Event('change', { bubbles: true }) as unknown as Event);
});
ok('ticking the asset line opens it for entry',
   Boolean(freezerInputs().find((i) => i.type === 'number')));
const freezerQty = freezerInputs().find((i) => i.type === 'number');
await act(async () => {
  type(freezerQty!, '1');
});

ok('a delivery of ONLY an asset, into a bar, asks for no manager',
   !freezerText().includes('A manager must authorise this delivery'));
ok('...and asks for no written reason either',
   !freezerText().includes('Why it went straight there'));

// AND THE OTHER SIDE OF THE SAME BOUNDARY, so this is not merely "the panel
// never appears". The same destination, with STOCK on it, still asks.
ok('...while the same destination WITH stock still asks for one',
   deliveryTotals(orderLines, new Map([['pol-1', {
     purchaseOrderLineId: 'pol-1', quantity: 50, unitCost: 1200,
     closedShort: false, reason: '', batchCode: '', expiryDate: '', note: '',
   }]])).movesStock);
ok('...and a delivery of only an asset reports moving no stock',
   !deliveryTotals(FREEZER_LINE, new Map([['pol-asset', {
     purchaseOrderLineId: 'pol-asset', quantity: 1, unitCost: 250000,
     closedShort: false, reason: '', batchCode: '', expiryDate: '', note: '',
   }]])).movesStock);
// A CLOSE-SHORT OF NOTHING IS NOT A STOCK MOVEMENT EITHER, which is the
// boundary `d.entered > 0` draws rather than "is there a stock line".
ok('...and a stock line closed short at zero moves no stock',
   !deliveryTotals(orderLines, new Map([['pol-1', {
     purchaseOrderLineId: 'pol-1', quantity: 0, unitCost: 1200,
     closedShort: true, reason: 'nothing came', batchCode: '', expiryDate: '', note: '',
   }]])).movesStock);

// --- 7.4 a non-stock line has a name, and an expense says where it posts ---
// THE DEFECT: `row.item_name ?? MISSING_VALUE`, which is what the delivery
// history said before 055. item_name is NULL on an asset or expense line, so a
// delivered freezer rendered as a quantity, a cost and an em-dash -- section 6's
// placeholder behaving exactly as intended, over a row that had a name in
// `description` that nothing was reading. Nothing throws, nothing looks broken,
// and the delivery history of the hotel's fixed assets is a column of dashes.
const MIXED_LINES = purchaseOrderLineRows.rows([
  {
    purchase_order_line_id: 'pol-m1',
    tenant_id: 't-1', property_id: 'p-1', purchase_order_id: 'po-9',
    order_number: 'PO-000019', order_status: 'received',
    line_number: 1, line_type: 'asset',
    inventory_item_id: null, item_name: null, item_code: null,
    base_unit: null, tracks_expiry: null,
    description: 'Chest freezer',
    ordered_quantity: '1.0000', ordered_unit_cost: '250000.00', note: null,
    received_quantity: '1.0000', received_value: '250000.00',
    closed_short: false, outstanding_quantity: '0.0000', is_settled: true,
    last_unit_cost: '250000.00',
    expense_category_id: null, expense_category_code: null,
    expense_category_name: null,
  },
  {
    purchase_order_line_id: 'pol-m2',
    tenant_id: 't-1', property_id: 'p-1', purchase_order_id: 'po-9',
    order_number: 'PO-000019', order_status: 'received',
    line_number: 2, line_type: 'expense',
    inventory_item_id: null, item_name: null, item_code: null,
    base_unit: null, tracks_expiry: null,
    description: 'Plumber call-out',
    ordered_quantity: '1.0000', ordered_unit_cost: '25000.00', note: null,
    received_quantity: '1.0000', received_value: '25000.00',
    closed_short: false, outstanding_quantity: '0.0000', is_settled: true,
    last_unit_cost: '25000.00',
    expense_category_id: 'cat-repairs',
    expense_category_code: 'repairs',
    expense_category_name: 'Repairs and maintenance',
  },
]);

const mixedHtml = renderToString(
  React.createElement(OrderLinesTable, {
    lines: MIXED_LINES, currency: 'NGN',
  } as never),
);
const mixedText = strip(mixedHtml);

ok('an asset line on the order is named by its description',
   mixedText.includes('Chest freezer'));
ok('...and an expense line likewise',
   mixedText.includes('Plumber call-out'));
// THE ASSERTION THAT MATTERS, and it is about the category rather than the
// name: an expense line with no category showing reads as a cost posting
// nowhere, which is the one question the category exists to answer.
ok('...and the expense line says WHICH account the cost lands in',
   mixedText.includes('Repairs and maintenance'));
// AND THE OTHER SIDE: an asset line must not sprout a category it has none of.
ok('...while the asset line shows no category, having none',
   !mixedText.includes('Repairs and maintenance Chest freezer'));
// AN ASSERTION WAS DELETED HERE, and that is worth more than the assertion was.
// It read:
//
//   ok('...and neither line falls back to the placeholder for its name',
//      !mixedText.includes(`${MISSING_VALUE} 1`) || mixedText.includes('Chest freezer'));
//
// The right-hand side of that `||` is asserted true two lines above, so the
// whole expression was true no matter what the table did. It could not go red
// for any defect, and the breakage run confirmed it: ten mutations, and this
// one never moved. Rule 27 -- an assertion that cannot distinguish working from
// absent is not an assertion, and a green one buys confidence it did not earn.
//
// There is nothing to replace it with: the order table renders the em-dash
// legitimately in its price-difference column, so "contains a placeholder" is
// true under the defect and the fix alike. The two assertions above already
// name both lines, which is the actual claim.

// THE DELIVERY HISTORY, which is where the dash actually appeared.
const MIXED_RECEIPT = receiptLineRows.rows([
  {
    id: 'prl-1', tenant_id: 't-1', property_id: 'p-1',
    purchase_receipt_id: 'pr-1', receipt_number: 'GRN-000007',
    business_date: '2026-08-24', delivery_note: null, invoice_number: 'INV-77',
    authorised_by: null, purchase_order_id: 'po-9', order_number: 'PO-000019',
    purchase_order_line_id: 'pol-m1', line_number: 1,
    quantity: '1.0000', unit_cost: '250000.00', closed_short: false,
    reason: null, batch_code: null, expiry_date: null, note: null,
    stock_movement_id: null, created_at: '2026-08-24T10:00:00Z',
    created_by: null,
    ordered_quantity: '1.0000', ordered_unit_cost: '250000.00',
    inventory_item_id: null, item_name: null, item_code: null, base_unit: null,
    line_value: '250000.00', unit_cost_difference: '0.00',
    cost_difference_value: '0.00',
    line_type: 'asset', description: 'Chest freezer',
    expense_category_id: null, expense_category_name: null,
  },
]);
const historyText = strip(
  renderToString(
    React.createElement(ReceiptLinesTable, {
      rows: MIXED_RECEIPT, currency: 'NGN',
    } as never),
  ),
);
ok('the delivery history names the freezer that arrived',
   historyText.includes('Chest freezer'));
// THE DEFECT'S OWN SIGNATURE, asserted directly: under
// `item_name ?? MISSING_VALUE` this row's name cell held the em-dash.
ok('...rather than the em-dash it showed before 055',
   !historyText.includes(`GRN-000007 ${MISSING_VALUE}`));

// ---------------------------------------------------------------------------
// PART 8 WAS MADE TO FAIL NINE WAYS (rules 22, 27)
// ---------------------------------------------------------------------------
// Each mutation is in the code the SCREENS run. All nine red:
//
//   A  the delivery value comes off the first line   -> value 250000, not
//                                                       310000 (2 red)
//   B  movesStock reads only the first line          -> the delivery that DOES
//                                                       move stock says it
//                                                       does not (2 red)
//   C  movesStock is always true                     -> the call-out is told
//                                                       its stock goes back
//                                                       (3 red)
//   D  the line count stops counting                 -> lineCount 1 (2 red)
//   E  the control attaches to the LAST row          -> prl-b, not prl-a
//   F  the control renders on every line             -> 2 buttons for one
//                                                       delivery
//   G  a reversed delivery is offered it again       -> 3 red
//   H  the effect drops the supplier figure          -> the sentence an
//                                                       irreversible act is
//                                                       decided on loses its
//                                                       number
//   I  the general rule moves onto the screen        -> rule 25 (4 red)
//
// B AND C ARE THE PAIR THAT MATTERS, and the fixture is ordered for them. Its
// FIRST line is the freezer (no movement) and its SECOND is the rice (a
// movement), so a movesStock that reads only the first row gives a DIFFERENT
// answer from one that folds across the lines. With the stock line first both
// are true and B is green -- the fixture would make the correct and the
// incorrect computation coincide, which is rule 27's fourth shape. C is the
// other side of the same boundary: without a non-stock delivery to assert on,
// a movesStock hardcoded to true passes everything B asserts.
//
// AND ONE ASSERTION WENT RED AGAINST CORRECT CODE before it was fixed, which
// is the alarming direction and the expensive one -- checklist item 13's point
// about a harness that lies while feeling like diligence. It asserted that a
// non-stock delivery does not say "goes back out", and the non-stock sentence
// reads "nothing goes back out of a store", so the assertion matched its own
// wording. It now anchors on a phrase that exists in only one of the two
// branches.
// ---------------------------------------------------------------------------
// PART 8 — UNDOING A DELIVERY (1.1h2d)
// ---------------------------------------------------------------------------
// WHAT THE SQL CANNOT REACH. 056 and 057 prove, against the real database, that
// a reversal moves the stock, mirrors the ledger, walks the order's status back
// and drops out of four reads while staying on the fifth. None of that says
// anything about the three things a person actually meets:
//
//   * the table is one row per receipt LINE and the act is per DELIVERY, so the
//     control has to appear once per delivery and on the right row;
//   * a reversed delivery has to be distinguishable from a standing one at a
//     glance, or somebody reverses it twice and meets a refusal instead of an
//     answer;
//   * the EFFECT sentence is what an irreversible act is decided on, and it has
//     to be true of THIS delivery — a delivery of a freezer and a plumber's
//     call-out moves no stock, and telling somebody the stock goes back out is
//     a false sentence at the worst possible moment.
//
// THE FIXTURE IS BUILT SO THE RIGHT AND WRONG ANSWERS DIFFER (rule 27). Its
// FIRST line is the non-stock one and its second carries the movement, so a
// `movesStock` that reads only the first row gives a DIFFERENT answer from one
// that folds across the lines. With the stock line first, both are true and the
// assertion proves nothing. The two lines are also 250,000 and 60,000, so a
// value taken from the first row and a value summed across them are different
// numbers.
console.log('\n=== 8. Undoing a delivery ===');

const { groupDeliveries } = await import('../src/lib/purchasing');
const { ReverseDeliveryForm } = await import(
  '../src/components/admin/purchasing/ReverseDeliveryForm'
);

const REV_BASE = {
  tenant_id: 't-1', property_id: 'p-1',
  purchase_order_id: 'po-9', order_number: 'PO-000019',
  business_date: '2026-08-24', delivery_note: 'DN-5', invoice_number: 'INV-77',
  closed_short: false, reason: null, batch_code: null, expiry_date: null,
  note: null, created_at: '2026-08-24T10:00:00Z', created_by: null,
  item_code: null, base_unit: null,
  unit_cost_difference: '0.00', cost_difference_value: '0.00',
  expense_category_id: null, expense_category_name: null,
  is_reversed: false, reversed_on: null, reversed_at: null,
  reversal_reason: null, reversal_recorded_by: null,
  reversal_approved_by: null,
};

// GRN-000008: the freezer FIRST (no movement), the rice SECOND (a movement).
const TWO_LINE_DELIVERY = receiptLineRows.rows([
  {
    ...REV_BASE, id: 'prl-a', purchase_receipt_id: 'pr-8',
    receipt_number: 'GRN-000008', authorised_by: null,
    purchase_order_line_id: 'pol-a', line_number: 1,
    quantity: '1.0000', unit_cost: '250000.00',
    ordered_quantity: '1.0000', ordered_unit_cost: '250000.00',
    inventory_item_id: null, item_name: null, line_value: '250000.00',
    line_type: 'asset', description: 'Chest freezer',
    stock_movement_id: null,
  },
  {
    ...REV_BASE, id: 'prl-b', purchase_receipt_id: 'pr-8',
    receipt_number: 'GRN-000008', authorised_by: null,
    purchase_order_line_id: 'pol-b', line_number: 2,
    quantity: '50.0000', unit_cost: '1200.00',
    ordered_quantity: '50.0000', ordered_unit_cost: '1200.00',
    inventory_item_id: 'item-1', item_name: 'Rice', line_value: '60000.00',
    line_type: 'inventory', description: null,
    stock_movement_id: 'sm-1',
  },
]);

const twoLine = groupDeliveries(TWO_LINE_DELIVERY);
ok('two lines of one delivery fold into ONE delivery',
   twoLine.length === 1, `${twoLine.length} groups`);
ok('...whose value is the SUM of its lines, not the first line',
   twoLine[0]?.value === 310000, `value ${twoLine[0]?.value}`);
ok('...and whose line count is both of them',
   twoLine[0]?.lineCount === 2, `lineCount ${twoLine[0]?.lineCount}`);
// THE ONE THE FIXTURE WAS ORDERED FOR. The first line has no movement.
ok('...and it moves stock because its SECOND line does',
   twoLine[0]?.movesStock === true);
ok('...and the control belongs to its first row',
   twoLine[0]?.firstRowId === 'prl-a', `${twoLine[0]?.firstRowId}`);

// A DELIVERY OF A FREEZER AND A CALL-OUT MOVES NO STOCK. The other side of the
// same boundary -- without this, `movesStock = true` always would pass above.
const nonStockOnly = groupDeliveries([TWO_LINE_DELIVERY[0]]);
ok('a delivery with no stock line does NOT move stock',
   nonStockOnly[0]?.movesStock === false);

// ---- the table: one control per delivery, on the right row ---------------
const revRows = [
  ...TWO_LINE_DELIVERY,
  ...receiptLineRows.rows([
    {
      ...REV_BASE, id: 'prl-c', purchase_receipt_id: 'pr-7',
      receipt_number: 'GRN-000007', authorised_by: 'mgr-1',
      purchase_order_line_id: 'pol-b', line_number: 1,
      quantity: '10.0000', unit_cost: '1200.00',
      ordered_quantity: '8.0000', ordered_unit_cost: '1200.00',
      inventory_item_id: 'item-1', item_name: 'Rice', line_value: '12000.00',
      line_type: 'inventory', description: null, stock_movement_id: 'sm-0',
      reason: 'Two extra on the truck',
      is_reversed: true, reversed_on: '2026-08-26',
      reversed_at: '2026-08-26T09:00:00Z',
      reversal_reason: 'Sent the whole delivery back',
      reversal_recorded_by: 'staff-1', reversal_approved_by: 'mgr-1',
    },
  ]),
];

const reverseClicks: string[] = [];
const tableHost = doc.createElement('div');
doc.body.appendChild(tableHost);
const tableRoot = createRoot(tableHost);
await act(async () => {
  tableRoot.render(
    React.createElement(ReceiptLinesTable, {
      rows: revRows,
      currency: 'NGN',
      currentUserId: null,
      onReverse: (id: string) => reverseClicks.push(id),
    } as never),
  );
});

const reverseButtons = () =>
  (Array.from(tableHost.querySelectorAll('button')) as HTMLButtonElement[])
    .filter((b) => norm(b.textContent ?? '') === 'Reverse');

// ONE button for the two-line delivery, and NONE for the reversed one -- so
// exactly one across three rows. A control rendered per LINE would give two.
ok('a two-line standing delivery offers ONE reverse control, not one per line',
   reverseButtons().length === 1, `${reverseButtons().length} buttons`);

await act(async () => { reverseButtons()[0]?.click(); });
ok('...and it names the delivery, not the row',
   reverseClicks.length === 1 && reverseClicks[0] === 'pr-8',
   JSON.stringify(reverseClicks));

const tableText = norm(tableHost.textContent ?? '');
ok('a reversed delivery is marked as reversed',
   tableText.includes('Reversed'));
// AND IT CANNOT BE REVERSED AGAIN FROM THE SCREEN. Not because the server
// would allow it -- it refuses by name -- but because offering a control whose
// only outcome is a refusal is the same defect as a button that does nothing.
const reversedRowHasButton = (
  Array.from(tableHost.querySelectorAll('button')) as HTMLButtonElement[]
).some((b) =>
  norm(b.textContent ?? '') === 'Reverse' &&
  norm(b.closest('tr')?.textContent ?? '').includes('GRN-000007'),
);
ok('...and offers no second reverse control', !reversedRowHasButton);

// The receipt number stays readable on a reversed row: the delivery happened,
// and what changed is that nothing is counted from it.
ok('...while still naming the delivery that was undone',
   tableText.includes('GRN-000007'));

tableRoot.unmount();
tableHost.remove();

// ---- the form: the EFFECT names THIS delivery's figures ------------------
const revFormHost = doc.createElement('div');
doc.body.appendChild(revFormHost);
const revFormRoot = createRoot(revFormHost);
await act(async () => {
  revFormRoot.render(
    React.createElement(
      ToastProvider,
      null,
      React.createElement(ReverseDeliveryForm, {
        delivery: twoLine[0],
        orderNumber: 'PO-000019',
        supplierName: 'Gbenga Supplies',
        currency: 'NGN',
        propertySlug: 'finima',
        onReversed: () => {},
        onCancel: () => {},
      }),
    ),
  );
});
const revFormText = norm(revFormHost.textContent ?? '');

ok('the subject names the delivery, its date and its lines',
   revFormText.includes('GRN-000008') && revFormText.includes('2 lines'));
ok('the effect names what comes off the supplier balance',
   revFormText.includes('comes off what Gbenga Supplies is owed'));
// THE FIGURE ITSELF, through the real formatter -- Intl puts a NON-BREAKING
// space after the currency, which `norm` collapses to an ordinary one.
ok('...with this delivery\'s own total in it',
   revFormText.includes(formatMoney(310000, 'NGN').replace(/ /g, ' ')),
   formatMoney(310000, 'NGN'));
// THE PHRASE HAS TO BE UNIQUE TO THE STOCK CASE. The first version asserted
// `goes back out`, and the NON-stock sentence reads "nothing goes back out of
// a store" -- so the negative assertion below matched its own wording and went
// red against correct code. An assertion whose substring appears in both
// branches is testing the English, not the rule.
ok('...and says the stock goes back, because this delivery moved stock',
   revFormText.includes('The stock this delivery brought in goes back out'));

// RULE 25: the general rule is BEHIND the icon, not on the screen.
ok('the general rule is not on screen',
   !revFormText.includes('A delivery is never edited or deleted'));

revFormRoot.unmount();
revFormHost.remove();

// THE OTHER SIDE OF THE EFFECT SENTENCE, which is the one that would be a lie.
const callOutOnly = groupDeliveries([TWO_LINE_DELIVERY[0]]);
const nsHost = doc.createElement('div');
doc.body.appendChild(nsHost);
const nsRoot = createRoot(nsHost);
await act(async () => {
  nsRoot.render(
    React.createElement(
      ToastProvider,
      null,
      React.createElement(ReverseDeliveryForm, {
        delivery: callOutOnly[0],
        orderNumber: 'PO-000019',
        supplierName: 'Gbenga Supplies',
        currency: 'NGN',
        propertySlug: 'finima',
        onReversed: () => {},
        onCancel: () => {},
      }),
    ),
  );
});
const nsText = norm(nsHost.textContent ?? '');
ok('a delivery that moved no stock says so',
   nsText.includes('moved no stock'));
ok('...and does NOT claim stock goes back out',
   !nsText.includes('The stock this delivery brought in goes back out'));

nsRoot.unmount();
nsHost.remove();


console.log(`\n${fail === 0 ? 'GREEN' : 'RED'}  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
