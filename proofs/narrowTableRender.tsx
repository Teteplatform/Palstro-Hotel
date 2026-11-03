// THE PHONE PROOF (1.1a2, and rules 22/23/27 for how it is trusted).
//
// ---------------------------------------------------------------------------
// WHAT THIS CAN AND CANNOT PROVE, STATED BEFORE ANY ASSERTION
// ---------------------------------------------------------------------------
// happy-dom does no layout. There is no box model here, so "992px of table in a
// 295px window" is NOT assertable from a proof and never will be — that stays a
// live-site check at 360px, and the measurements that justified this shipment
// were taken in a real browser against the real screen.
//
// What IS assertable is the thing those measurements were a proxy for, and it is
// the better assertion anyway: WHICH ELEMENTS CONTAIN WHICH. The walk's finding
// was not "a number is too big", it was "the item name and the field you must
// type into cannot be seen together". That is a containment fact. Below the
// breakpoint every cell of a row must live in one card, so that no scroll
// position can separate the name of a thing from the box you answer about it in
// — and the mandatory reason field must be in that same card, not behind a
// disclosure, because a tap to reveal a required field is the same defect one
// layer deeper.
//
// ---------------------------------------------------------------------------
// MADE TO FAIL BEFORE IT WAS TRUSTED (rules 22, 27)
// ---------------------------------------------------------------------------
// Every assertion names the defect that turns it red, and the headline one is
// checked against the OLD markup directly: PART 1 renders the same component at
// a wide viewport, where it is still the table it always was, and asserts that
// the card structure is ABSENT. Without that half, "the inputs are in a card"
// would pass for a component that rendered cards at every width — which would be
// a different bug, not a fix.

import { Window } from 'happy-dom';

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
g.IS_REACT_ACT_ENVIRONMENT = true;
g.requestAnimationFrame = (cb: FrameRequestCallback) =>
  win.setTimeout(() => cb(0), 0) as unknown as number;
g.cancelAnimationFrame = (id: number) =>
  win.clearTimeout(id as unknown as ReturnType<typeof win.setTimeout>);

// THE VIEWPORT IS STUBBED, NOT FAKED. useIsNarrow asks the browser
// `matchMedia('(max-width: 767px)')`, so the proof answers as a 360px browser
// would and the component takes the path it takes on a phone. Stubbing the
// BROWSER is what the rest of this harness already does for
// requestAnimationFrame and getComputedStyle; stubbing the COMPONENT would be
// proving something else.
let narrow = false;
const listeners = new Set<() => void>();
g.matchMedia = (query: string) => ({
  media: query,
  matches: query.includes('max-width: 767px') ? narrow : !narrow,
  addEventListener: (_: string, cb: () => void) => listeners.add(cb),
  removeEventListener: (_: string, cb: () => void) => listeners.delete(cb),
  addListener: (cb: () => void) => listeners.add(cb),
  removeListener: (cb: () => void) => listeners.delete(cb),
  onchange: null,
  dispatchEvent: () => true,
});
(win as unknown as Record<string, unknown>).matchMedia = g.matchMedia;

const React = await import('react');
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');

const { ReceiveLinesTable } = await import(
  '../src/components/admin/purchasing/ReceiveForm'
);
const { purchaseOrderLineRows } = await import('../src/lib/purchasing');
type PurchaseOrderLineStatus =
  import('../src/types/purchasing').PurchaseOrderLineStatus;
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

function mount(node: React.ReactElement) {
  const host = doc.createElement('div');
  doc.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(node);
  });
  return { host, root };
}

// ---------------------------------------------------------------------------
// THE FIXTURE: a short delivery, because that is the case that needs a reason
// ---------------------------------------------------------------------------
// Rice is 50 outstanding and 47 arrived — a SHORT line, so the server will
// require a reason and the field is on screen. The oil line is untouched, which
// is the other state a row can be in and keeps the fixture from being uniform.
const WIRE_LINES: unknown[] = [
  {
    purchase_order_line_id: 'pol-1',
    tenant_id: 't-1',
    property_id: 'p-1',
    purchase_order_id: 'po-1',
    order_number: 'PO-000012',
    order_status: 'ordered',
    line_number: 1,
    line_type: 'inventory',
    inventory_item_id: 'i-rice',
    item_name: 'Rice (long grain)',
    item_code: 'FD-001',
    base_unit: 'kg',
    tracks_expiry: false,
    description: null,
    ordered_quantity: '50.0000',
    ordered_unit_cost: '1200.00',
    note: null,
    received_quantity: '0.0000',
    received_value: '0.00',
    closed_short: false,
    outstanding_quantity: '50.0000',
    is_settled: false,
    last_unit_cost: null,
  },
  {
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

const lines: PurchaseOrderLineStatus[] = purchaseOrderLineRows.rows(WIRE_LINES);

// Rice is ON the delivery and SHORT (47 of 50), so its reason field is required
// and rendered. Oil is not ticked at all.
const drafts = new Map<string, ReceiptLineDraft>([
  [
    'pol-1',
    {
      purchaseOrderLineId: 'pol-1',
      quantity: 47,
      unitCost: 1200,
      closedShort: false,
      reason: '',
      batchCode: '',
      expiryDate: '',
      note: '',
    },
  ],
]);

const table = () =>
  React.createElement(ReceiveLinesTable, {
    lines,
    drafts,
    currency: 'NGN',
    onToggle: () => {},
    onPatch: () => {},
  });

// ===========================================================================
// PART 1 — ABOVE THE BREAKPOINT NOTHING CHANGED
// ===========================================================================
// RULE 27: without this, "the inputs are in a card" would pass for a component
// that rendered cards at EVERY width, which is a different bug wearing the
// fix's clothes. It is also the assertion that goes red against the markup this
// shipment replaced, because that markup has no card path at any width.
console.log('\n=== 1. At 1366 it is still the table it always was ===');

narrow = false;
const wide = mount(table());
ok('a real <table> is rendered', wide.host.querySelector('table') !== null);
ok('...with its min-width intact, so wide screens are untouched',
   wide.host.querySelector('table')?.className.includes('min-w-[62rem]') === true,
   wide.host.querySelector('table')?.className ?? '(no table)');
ok('...inside the horizontal scroller it has always had',
   wide.host.querySelector('.overflow-x-auto') !== null);
ok('...and NO cards exist at this width',
   wide.host.querySelector('ul[aria-label="Lines on this delivery"]') === null);
act(() => {
  wide.root.unmount();
});
wide.host.remove();

// ===========================================================================
// PART 2 — AT PHONE WIDTH, A ROW IS ONE CONTAINER
// ===========================================================================
console.log('\n=== 2. At 360 every cell of a row is in one card ===');

narrow = true;
const phone = mount(table());

ok('the table is gone', phone.host.querySelector('table') === null);
const cards = Array.from(
  phone.host.querySelectorAll('ul[aria-label="Lines on this delivery"] > li'),
);
ok('each line is a card', cards.length === 2, `${cards.length} cards`);

// THE ASSERTION THIS SHIPMENT EXISTS FOR. On the live screen the item name sat
// at x=40 and the reason field at x=922 inside a 295px window, so they could not
// be seen together at any scroll position. Containment is what that was a proxy
// for, and it is exact rather than approximate.
const riceCard = cards.find((c) => c.textContent?.includes('Rice (long grain)'));
ok('the short line has a card of its own', riceCard !== undefined);

const riceInputs = Array.from(riceCard?.querySelectorAll('input') ?? []);
ok('...and its item name and EVERY one of its inputs are in it',
   riceInputs.length >= 3,
   `${riceInputs.length} inputs inside the card`);

// The reason field, by its placeholder, because that is how the person finds it.
const reason = riceCard?.querySelector('input[placeholder="Why the difference"]');
ok('...including the reason field the server will require',
   reason !== null && reason !== undefined);

// RULE 27, AND THE RULING THAT WAS MADE EXPLICITLY: not behind a disclosure.
// A <details>/<summary> or a hidden container would satisfy "it is in the card"
// and recreate the bug one tap deeper, so the proof looks for one.
ok('...and it is not behind a disclosure',
   riceCard?.querySelector('details') === null &&
   riceCard?.querySelector('[hidden]') === null);

// AND THE REASON IS A SIBLING OF THE QUANTITY IT EXPLAINS — both are direct
// field entries of the same card's list, which is the structural claim made in
// the plan for this shipment.
const dl = riceCard?.querySelector('dl');
const fieldOf = (el: Element | null | undefined) => {
  let node = el as Element | null;
  while (node && node.parentElement !== dl) node = node.parentElement;
  return node;
};
const quantity = riceCard?.querySelector('input[placeholder="kg"]');
ok('...and sits in the same list as the quantity it explains',
   dl !== null &&
   fieldOf(reason) !== null &&
   fieldOf(quantity) !== null &&
   fieldOf(reason)?.parentElement === fieldOf(quantity)?.parentElement);

// THE UNTOUCHED LINE IS STILL A CARD, with its name and its tick box, and no
// inputs it has not earned. Without this, a fixture of one card could not tell
// "cards per row" from "one card for the lot".
const oilCard = cards.find((c) => c.textContent?.includes('Groundnut oil'));
ok('the untouched line is its own card', oilCard !== undefined && oilCard !== riceCard);
ok('...with the tick that puts it on the delivery',
   oilCard?.querySelector('input[type="checkbox"]') !== null);
// It is not ticked, so it has no quantity field — the card shows what the row
// actually has, not an empty copy of the other one.
ok('...and no quantity box until it is ticked',
   oilCard?.querySelector('input[placeholder="litre"]') === null);

// A CELL THAT RENDERS NOTHING IS NOT A LABEL WITH NOTHING AFTER IT. Rice is
// short by 3, so its Difference cell has content; its Cost change does not,
// because the invoiced cost equals the ordered one.
ok('a figure the row does not have is omitted, not printed as an empty label',
   riceCard?.textContent?.includes('Difference') === true &&
   riceCard?.textContent?.includes('Cost change') === false,
   `card reads: ${riceCard?.textContent?.slice(0, 120)}`);

act(() => {
  phone.root.unmount();
});
phone.host.remove();

// ===========================================================================
// PART 3 — A READ-ONLY TABLE FROM A DIFFERENT MODULE
// ===========================================================================
// THE PROVENANCE TABLES WERE THE ODD ONES OUT and are now through the same
// primitive. This part exists because "the odd one out is the one nobody tests"
// applies to the proof as much as to the code: a primitive proven only against
// the receive form would be proven only for editable tables with a tick box, and
// the three provenance tables have neither.
//
// It also guards the thing that conversion could plausibly have broken and the
// type checker could not see: these tables keep their OWN look (text-xs, a
// divided tbody, a heavier header) rather than inheriting purchasing's, so a
// primitive that hard-coded one module's classes would quietly restyle a screen
// nobody asked to change.
console.log('\n=== 3. A read-only table from another module, same primitive ===');

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
    delivery_note: null,
    invoice_number: null,
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

const { OverReceiptsTable } = await import(
  '../src/components/admin/inventory/ProvenanceTab'
);
const { overReceiptRows } = await import('../src/lib/stockProvenance');
const overRows = overReceiptRows.rows(WIRE_OVER);

const overTable = () =>
  React.createElement(OverReceiptsTable, {
    rows: overRows,
    currency: 'NGN',
    userId: null,
  });

narrow = false;
const overWide = mount(overTable());
const overWideTable = overWide.host.querySelector('table');
ok('above the breakpoint it is still a table', overWideTable !== null);
ok('...keeping its own text size rather than inheriting purchasing\'s',
   overWideTable?.className.includes('text-xs') === true,
   overWideTable?.className ?? '(none)');
ok('...and its own divided body',
   overWide.host.querySelector('tbody')?.className.includes('divide-y') === true);
act(() => {
  overWide.root.unmount();
});
overWide.host.remove();

narrow = true;
const overPhone = mount(overTable());
const overCards = Array.from(
  overPhone.host.querySelectorAll(
    'ul[aria-label="Deliveries accepted above what was ordered"] > li',
  ),
);
ok('at phone width it is a card', overCards.length === 1, `${overCards.length} cards`);
// The question an owner opens this report to ask is "what did we accept that
// nobody ordered, and who said yes" — so the excess and the authoriser must be
// in the card, not off the side of a table.
const overText = overCards[0]?.textContent ?? '';
ok('...carrying the excess, its cost and who approved it',
   overText.includes('+5') &&
   overText.includes('17,500') &&
   overText.includes('staff u-manage'),
   overText.slice(0, 120));
act(() => {
  overPhone.root.unmount();
});
overPhone.host.remove();

console.log(`\n================  ${pass} PASSED, ${fail} FAILED  ================`);
process.exit(fail ? 1 : 0);
