import { supabase } from './supabase';
import { boundary, passthrough, scalarNumber } from './rowParse';
import { fetchAllPagedRows } from './fetchAllPaged';
import { PICKER_SEARCH_LIMIT, safeSearchTerm, type PickerSearchResult } from './inventory';
import { newIdempotencyKey } from './stock';
import type {
  ExpenseCategory,
  InventoryGlReconciliation,
  InventoryReconciliationPosition,
  PurchaseOrder,
  PurchaseOrderLineDraft,
  PurchaseOrderLineStatus,
  PurchaseOrderStatus,
  PurchaseOrderSummary,
  PurchaseReceipt,
  PurchaseReceiptLineDetail,
  ReceiptLineDraft,
  Reversal,
} from '../types/purchasing';

export { newIdempotencyKey };

// PURCHASE ORDERS AND GOODS RECEIPTS (046) — the reads the two screens make and
// the four RPCs they call.
//
// ---------------------------------------------------------------------------
// THIS MODULE AUTHORS NO REFUSAL (rule 21)
// ---------------------------------------------------------------------------
// Every rule about what may be ordered, what may be received, when a reason is
// needed and when a manager is needed lives in 046 and comes back as a message
// with a hint. Nothing here restates one, INCLUDING the two that a client is most
// tempted to restate — "only the store receives" and "an over-receipt needs a
// PIN" — because a UI that says them is a second source of truth that drifts the
// first time the rule changes, silently, because nothing errors.
//
// What this module DOES author is the LIVE ARITHMETIC the receiving screen shows
// before anything is submitted: the difference between what is outstanding and
// what is being entered, and between the ordered cost and the invoiced one.
// Those are not rules, they are the figures on the document in front of the
// person — CLAUDE.md rule 25 calls them the EFFECT, and an effect never hides.

// ---------------------------------------------------------------------------
// The boundaries (rule 24)
// ---------------------------------------------------------------------------
// Each names its READ, then every numeric key of the row type split by
// nullability. The lists are checked for completeness by the compiler: add a
// numeric column to one of these row types and the build fails here until it is
// parsed. EXPORTED, so the render proof can push raw wire rows through the real
// parser rather than declaring its own (rule 22).

export const purchaseOrderRows = boundary<PurchaseOrder>('purchase_orders')(
  ['seq'] as const,
  [] as const,
);

export const purchaseOrderSummaryRows = boundary<PurchaseOrderSummary>(
  'purchase_order_summary',
)(
  // seq, line_count and receipt_count are int8/int4 — JSON NUMBERS on the wire.
  // The three values beside them are numeric — STRINGS. Same row, both mappings.
  [
    'seq',
    'line_count',
    'ordered_value',
    'received_value',
    'outstanding_value',
    'receipt_count',
  ] as const,
  [] as const,
);

export const purchaseOrderLineRows = boundary<PurchaseOrderLineStatus>(
  'purchase_order_line_status',
)(
  [
    'line_number',
    'ordered_quantity',
    'ordered_unit_cost',
    'received_quantity',
    'received_value',
    'outstanding_quantity',
  ] as const,
  ['last_unit_cost'] as const,
);

export const purchaseReceiptRows = boundary<PurchaseReceipt>('purchase_receipts')(
  ['seq'] as const,
  [] as const,
);

export const receiptLineRows = boundary<PurchaseReceiptLineDetail>(
  'purchase_receipt_line_detail',
)(
  [
    'line_number',
    'quantity',
    'unit_cost',
    'ordered_quantity',
    'ordered_unit_cost',
    'line_value',
    'unit_cost_difference',
    'cost_difference_value',
  ] as const,
  [] as const,
);

export const reconciliationRows = boundary<InventoryGlReconciliation>(
  'inventory_gl_reconciliation',
)(
  [
    'ledger_balance',
    'expected_ledger_balance',
    'ledger_difference',
    'pre_gl_value',
    'pre_wiring_value',
    'non_posting_value',
    'unvaluable_movement_count',
    'unvaluable_value',
    'valuation_value',
    'valuation_difference',
    'valued_movement_count',
    'reset_position_count',
    'negative_position_count',
  ] as const,
  [] as const,
);

export const reconciliationPositionRows = boundary<InventoryReconciliationPosition>(
  'inventory_gl_reconciliation_positions',
)(
  [
    'quantity_on_hand',
    'movement_value',
    'valuation_value',
    'difference',
    'movement_count',
  ] as const,
  [] as const,
);

// ---------------------------------------------------------------------------
// The SQLSTATEs 046 raises, as constants so callers branch on one rather than on
// a magic string. THE SENTENCE THE USER READS IS ALWAYS THE SERVER'S.
// ---------------------------------------------------------------------------
export const PURCHASE_NOT_FOUND = 'PT404';
export const PURCHASE_FORBIDDEN = 'PT403';
// A resolvable conflict: the order has moved on, the key has been reused with a
// different payload, the delivery is already recorded.
export const PURCHASE_CONFLICT = 'PT409';
export const PURCHASE_INVALID = 'PT422';
// Not built yet, and the message names the shipment that brings it. Asset and
// expense purchase lines, and recipe consumption.
export const PURCHASE_NOT_YET = 'PT501';

// ---------------------------------------------------------------------------
// Filters (rule 1b)
// ---------------------------------------------------------------------------

export interface PurchaseFilters {
  search: string;
  supplierId: string;
  // '' = every state. 'open' is the pair (ordered, part_received) — the question
  // somebody actually opens this screen to ask.
  state: '' | 'open' | PurchaseOrderStatus;
  fromDate: string;
  toDate: string;
}

export const EMPTY_PURCHASE_FILTERS: PurchaseFilters = {
  search: '',
  supplierId: '',
  state: '',
  fromDate: '',
  toDate: '',
};

export function hasPurchaseFilters(f: PurchaseFilters): boolean {
  return (
    Boolean(f.search.trim()) ||
    Boolean(f.supplierId) ||
    Boolean(f.state) ||
    Boolean(f.fromDate) ||
    Boolean(f.toDate)
  );
}

// THE SINGLE FILTER IMPLEMENTATION — page, count, totals and export all go
// through it. Two definitions of "the current filter" is how a total comes to
// describe a different set from the rows under it (rule 20).
function applyPurchaseFilters(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query: any,
  tenantId: string,
  propertyId: string,
  filters: PurchaseFilters,
) {
  let q = query
    .eq('tenant_id', tenantId) // rule 19
    .eq('property_id', propertyId); // rule 19 — an order belongs to a hotel

  const safe = safeSearchTerm(filters.search);
  if (safe.length > 0) {
    q = q.or(`order_number.ilike.%${safe}%,supplier_name.ilike.%${safe}%`);
  }

  if (filters.supplierId) q = q.eq('supplier_id', filters.supplierId);

  if (filters.state === 'open') q = q.eq('is_open', true);
  else if (filters.state) q = q.eq('status', filters.state);

  // BUSINESS DATES (rules 8/12) — the day the order was raised, never created_at.
  if (filters.fromDate) q = q.gte('order_date', filters.fromDate);
  if (filters.toDate) q = q.lte('order_date', filters.toDate);

  return q;
}

export interface PurchaseOrdersPage {
  rows: PurchaseOrderSummary[];
  count: number; // exact total for the CURRENT FILTER
}

export async function fetchPurchaseOrdersPage(
  tenantId: string,
  propertyId: string,
  page: number,
  pageSize: number,
  filters: PurchaseFilters = EMPTY_PURCHASE_FILTERS,
): Promise<PurchaseOrdersPage> {
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  const base = supabase
    .from('purchase_order_summary')
    .select('*', { count: 'exact' });

  const { data, error, count } = await applyPurchaseFilters(
    base,
    tenantId,
    propertyId,
    filters,
  )
    // Newest first: a purchases list is read from the top, unlike a stock list.
    // seq is the tiebreak, because two orders raised on one day must not swap
    // between pages.
    .order('order_date', { ascending: false })
    .order('seq', { ascending: false })
    .range(from, to);

  if (error) throw error;
  return { rows: purchaseOrderSummaryRows.rows(data), count: count ?? 0 };
}

// ---------------------------------------------------------------------------
// The totals (rule 20 — the FILTER, never the page)
// ---------------------------------------------------------------------------

export interface PurchaseSummary {
  orderCount: number;
  openCount: number;
  orderedValue: number;
  receivedValue: number;
  outstandingValue: number;
}

// COMPUTED ACROSS EVERY ROW MATCHING THE FILTER, by paging the filtered set and
// summing it — not from the visible page, which would be a wrong number
// presented with confidence.
//
// WHY THIS PAGES RATHER THAN ASKING POSTGREST FOR A SUM: PostgREST has no
// aggregate this client can reach without a view per total, and a view per total
// is four more places for the definition of "the current filter" to drift. The
// paged sum reuses applyPurchaseFilters, so the figure and the list describe the
// same set by construction. A property's purchase orders are in the thousands,
// not the millions; when that stops being true this becomes an RPC and the
// filter moves into SQL with it.
export async function fetchPurchaseSummary(
  tenantId: string,
  propertyId: string,
  filters: PurchaseFilters = EMPTY_PURCHASE_FILTERS,
): Promise<PurchaseSummary> {
  const rows = await fetchAllPagedRows<PurchaseOrderSummary>(
    purchaseOrderSummaryRows,
    (from, to) => {
      const base = supabase
        .from('purchase_order_summary')
        .select(
          'id,seq,tenant_id,property_id,order_number,status,order_date,expected_date,note,cancel_reason,ordered_at,cancelled_at,created_at,created_by,supplier_id,supplier_name,supplier_code,destination_location_id,destination_name,destination_kind,is_open,line_count,ordered_value,received_value,outstanding_value,last_receipt_date,receipt_count',
        );
      return applyPurchaseFilters(base, tenantId, propertyId, filters)
        .order('seq', { ascending: true })
        .range(from, to);
    },
  );

  return {
    orderCount: rows.length,
    openCount: rows.filter((r) => r.is_open).length,
    orderedValue: rows.reduce((t, r) => t + r.ordered_value, 0),
    receivedValue: rows.reduce((t, r) => t + r.received_value, 0),
    outstandingValue: rows.reduce((t, r) => t + r.outstanding_value, 0),
  };
}

// Every row matching the current filter, across ALL pages (rule 20).
export async function fetchPurchaseOrdersForExport(
  tenantId: string,
  propertyId: string,
  filters: PurchaseFilters = EMPTY_PURCHASE_FILTERS,
): Promise<PurchaseOrderSummary[]> {
  return fetchAllPagedRows<PurchaseOrderSummary>(
    purchaseOrderSummaryRows,
    (from, to) => {
      const base = supabase.from('purchase_order_summary').select('*');
      return applyPurchaseFilters(base, tenantId, propertyId, filters)
        .order('order_date', { ascending: false })
        .order('seq', { ascending: false })
        .range(from, to);
    },
  );
}

// ---------------------------------------------------------------------------
// One order
// ---------------------------------------------------------------------------

export async function fetchPurchaseOrder(
  id: string,
): Promise<PurchaseOrderSummary | null> {
  const { data, error } = await supabase
    .from('purchase_order_summary')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return purchaseOrderSummaryRows.maybeRow(data);
}

// Its lines, with what has arrived against each. Bounded by the order, so a
// straight read rather than a pager (rule 1a): an order with a thousand lines is
// not a thing, and if it ever is, this becomes a paged surface of its own.
export async function fetchPurchaseOrderLines(
  orderId: string,
): Promise<PurchaseOrderLineStatus[]> {
  return fetchAllPagedRows<PurchaseOrderLineStatus>(
    purchaseOrderLineRows,
    (from, to) =>
      supabase
        .from('purchase_order_line_status')
        .select('*')
        .eq('purchase_order_id', orderId)
        .order('line_number', { ascending: true })
        .range(from, to),
  );
}

// Every delivery against this order, line by line, in business-date order
// (rule 8) with the line number as the tiebreak.
export async function fetchPurchaseReceiptLines(
  orderId: string,
): Promise<PurchaseReceiptLineDetail[]> {
  return fetchAllPagedRows<PurchaseReceiptLineDetail>(receiptLineRows, (from, to) =>
    supabase
      .from('purchase_receipt_line_detail')
      .select('*')
      .eq('purchase_order_id', orderId)
      .order('business_date', { ascending: true })
      .order('receipt_number', { ascending: true })
      .order('line_number', { ascending: true })
      .range(from, to),
  );
}

// ---------------------------------------------------------------------------
// The four RPCs
// ---------------------------------------------------------------------------
// Every one is awaited, wrapped, and its error re-thrown for the caller to
// surface verbatim (rules 11, 21). None of them re-words a refusal.

export interface SavePurchaseOrderInput {
  propertyId: string;
  // NULL creates. A non-null id REWRITES A DRAFT — and the server refuses
  // anything that is not a draft, which is where that rule belongs.
  purchaseOrderId: string | null;
  supplierId: string;
  orderDate: string;
  expectedDate: string | null;
  destinationLocationId: string;
  note: string | null;
  lines: PurchaseOrderLineDraft[];
  idempotencyKey: string;
}

// Expense categories are CONFIGURED, so there is no view to read them from --
// the table is the list.
//
// `sort_order` IS A NUMERIC KEY AND HAS TO BE DECLARED. The first draft of this
// read used passthrough<ExpenseCategory>(), and `tsc -b` refused it by name:
// `sort_order` is an integer, which PostgREST returns as a JSON number while
// the quantities elsewhere in this app arrive as strings. That is rule 24 part
// 3 doing exactly what it is for, and it is worth noting that the bare
// `tsc --noEmit` the repo used to run by hand would have let it through.
export const expenseCategoryRows = boundary<ExpenseCategory>(
  'expense_categories',
)(['sort_order'] as const, [] as const);

// CHOOSE AN EXPENSE CATEGORY — the picker's query (rule 26).
//
// SIX TODAY, AND STILL A TYPEAHEAD. The rule is about what a selector CAN hold:
// categories are tenant-configurable, and a hotel that wants one per cost centre
// reaches twenty without anybody revisiting the decision. Searching on the
// server also means the picker's answer and the settings list's answer can never
// disagree, which a client-side filter over one loaded page cannot promise.
//
// MATCHED ON NAME AND CODE, because the configured code ('cleaning') is what
// somebody who uses this daily will type.
//
// RETIRED CATEGORIES ARE EXCLUDED SERVER-SIDE, not filtered after: a retired
// category cannot be chosen on a NEW order at all, so dropping it here is
// correct rather than a hidden row. A line raised before it was retired still
// names it, which 054's unfiltered join is what delivers.
export async function searchExpenseCategories(
  tenantId: string,
  term: string,
  options: { limit?: number } = {},
): Promise<PickerSearchResult<ExpenseCategory>> {
  const limit = options.limit ?? PICKER_SEARCH_LIMIT;

  let q = supabase
    .from('expense_categories')
    .select('*')
    .eq('tenant_id', tenantId) // rule 19
    .is('deleted_at', null) // rule 5
    .eq('is_active', true);

  const safe = safeSearchTerm(term);
  if (safe.length > 0) q = q.or(`name.ilike.%${safe}%,code.ilike.%${safe}%`);

  const { data, error } = await q
    .order('sort_order', { ascending: true })
    .order('name', { ascending: true })
    .order('id', { ascending: true }) // unique -> a stable window
    .range(0, limit);

  if (error) throw error;
  const rows = expenseCategoryRows.rows(data);
  return { rows: rows.slice(0, limit), capped: rows.length > limit };
}

export async function savePurchaseOrder(
  input: SavePurchaseOrderInput,
): Promise<PurchaseOrder> {
  const { data, error } = await supabase.rpc('save_purchase_order', {
    p_property_id: input.propertyId,
    p_purchase_order_id: input.purchaseOrderId,
    p_supplier_id: input.supplierId,
    p_order_date: input.orderDate,
    p_expected_date: input.expectedDate,
    p_destination_location_id: input.destinationLocationId,
    p_note: input.note,
    p_lines: input.lines.map(purchaseLinePayload),
    p_idempotency_key: input.idempotencyKey,
  });

  if (error) throw error;
  return purchaseOrderRows.row(data);
}

// WHAT ONE DRAFT LINE SENDS, by its type. EXPORTED so the render proof drives
// this rather than restating it: an assertion that rebuilt this object from its
// own constants would pass with the function broken, which is exactly what
// 1.1g's receipt preview did at 35 of 35.
export function purchaseLinePayload(l: PurchaseOrderLineDraft) {
  return {
    line_type: l.lineType,
    // ONLY THE FIELDS THAT TYPE OWNS, and `null` rather than '' for the rest:
    // save_purchase_order casts these to uuid, and an empty string reaches that
    // cast as a type error instead of as the sentence the function wrote for a
    // missing choice (rule 21). The form keeps all four fields in the row so a
    // type switch does not lose what was typed; this is where the ones that do
    // not apply to the chosen type are dropped.
    inventory_item_id:
      l.lineType === 'inventory' ? l.inventoryItemId || null : null,
    description: l.lineType === 'inventory' ? null : l.description.trim() || null,
    expense_category_id:
      l.lineType === 'expense' ? l.expenseCategoryId || null : null,
    quantity: l.quantity,
    unit_cost: l.unitCost,
    note: l.note.trim() || null,
  };
}

export async function placePurchaseOrder(
  purchaseOrderId: string,
  idempotencyKey: string,
): Promise<PurchaseOrder> {
  const { data, error } = await supabase.rpc('place_purchase_order', {
    p_purchase_order_id: purchaseOrderId,
    p_idempotency_key: idempotencyKey,
  });
  if (error) throw error;
  return purchaseOrderRows.row(data);
}

export async function cancelPurchaseOrder(
  purchaseOrderId: string,
  reason: string,
  idempotencyKey: string,
): Promise<PurchaseOrder> {
  const { data, error } = await supabase.rpc('cancel_purchase_order', {
    p_purchase_order_id: purchaseOrderId,
    p_reason: reason,
    p_idempotency_key: idempotencyKey,
  });
  if (error) throw error;
  return purchaseOrderRows.row(data);
}

export interface ReceiveInput {
  purchaseOrderId: string;
  businessDate: string | null;
  lines: ReceiptLineDraft[];
  deliveryNote: string | null;
  invoiceNumber: string | null;
  note: string | null;
  idempotencyKey: string;
  // Required by the server for an over-receipt, and for a destination that is
  // not a store. Held in component state for the length of one call and cleared
  // in a finally block — never stored anywhere, exactly as the reversal form
  // does it.
  managerPin?: string | null;
  reason?: string | null;
}

// ---------------------------------------------------------------------------
// Undoing a delivery (056) — the seam the screen and the proof share
// ---------------------------------------------------------------------------
// purchase_receipt_line_detail is one row per receipt LINE, and a reversal acts
// on a whole RECEIPT (056: a partial undo is indistinguishable from a second,
// corrected delivery). So the screen needs the lines folded back into
// deliveries, and that fold is where the mistakes live: which delivery a
// reverse button belongs to, whether it has already been undone, and what the
// act would be worth. Extracted rather than written inline so the render proof
// exercises the real thing (rule 22).
export interface DeliveryGroup {
  receiptId: string;
  receiptNumber: string;
  businessDate: string;
  // The row the action attaches to, so a per-receipt control appears ONCE in a
  // per-line table rather than on every line of the delivery.
  firstRowId: string;
  lineCount: number;
  // What the delivery was invoiced at, across its lines — the figure the effect
  // sentence names, because it is what comes off the supplier balance.
  value: number;
  // Whether undoing it moves stock. A delivery of a freezer and a plumber's
  // call-out moves none, and saying it does would be a sentence somebody
  // decides an irreversible act on.
  movesStock: boolean;
  isReversed: boolean;
  reversedOn: string | null;
  reversalReason: string | null;
  reversalApprovedBy: string | null;
}

export function groupDeliveries(
  rows: PurchaseReceiptLineDetail[],
): DeliveryGroup[] {
  const byReceipt = new Map<string, DeliveryGroup>();

  for (const row of rows) {
    const existing = byReceipt.get(row.purchase_receipt_id);
    if (!existing) {
      byReceipt.set(row.purchase_receipt_id, {
        receiptId: row.purchase_receipt_id,
        receiptNumber: row.receipt_number,
        businessDate: row.business_date,
        firstRowId: row.id,
        lineCount: 1,
        value: row.line_value,
        movesStock: row.stock_movement_id !== null,
        isReversed: row.is_reversed,
        reversedOn: row.reversed_on,
        reversalReason: row.reversal_reason,
        reversalApprovedBy: row.reversal_approved_by,
      });
      continue;
    }
    existing.lineCount += 1;
    existing.value += row.line_value;
    // ANY stock line makes the delivery one that moves stock. Written as `||`
    // rather than as a check on the first row, because the first line of a
    // delivery can perfectly well be the plumber's call-out.
    existing.movesStock = existing.movesStock || row.stock_movement_id !== null;
  }

  return [...byReceipt.values()];
}

// ---------------------------------------------------------------------------
// Undoing a delivery (056)
// ---------------------------------------------------------------------------
// A reversals row carries no numeric column, so this reads through
// `passthrough` — which is not a way out of rule 24 but the other half of it:
// it refuses to COMPILE if the type ever gains a numeric field, naming it, the
// same way `boundary` refuses when a field list is short. The day somebody adds
// an amount to this table, the build stops here rather than a component calling
// a string method on it.
export const reversalRows = passthrough<Reversal>('reversals');

export async function reversePurchaseReceipt(input: {
  purchaseReceiptId: string;
  reason: string;
  // Held for the length of one call and cleared in a `finally`, exactly as the
  // receive form does it. Never stored, never logged, never put in state that
  // outlives the submit.
  managerPin: string;
  idempotencyKey: string;
}): Promise<Reversal> {
  const { data, error } = await supabase.rpc('reverse_purchase_receipt', {
    p_purchase_receipt_id: input.purchaseReceiptId,
    p_reason: input.reason,
    p_manager_pin: input.managerPin,
    p_idempotency_key: input.idempotencyKey,
  });
  if (error) throw error;
  return reversalRows.row(data);
}

export async function receivePurchaseOrder(
  input: ReceiveInput,
): Promise<PurchaseReceipt> {
  const { data, error } = await supabase.rpc('receive_purchase_order', {
    p_purchase_order_id: input.purchaseOrderId,
    p_business_date: input.businessDate,
    p_lines: input.lines.map((l) => ({
      purchase_order_line_id: l.purchaseOrderLineId,
      quantity: l.quantity,
      unit_cost: l.unitCost,
      closed_short: l.closedShort,
      reason: l.reason.trim() || null,
      batch_code: l.batchCode.trim() || null,
      expiry_date: l.expiryDate || null,
      note: l.note.trim() || null,
    })),
    p_delivery_note: input.deliveryNote,
    p_invoice_number: input.invoiceNumber,
    p_note: input.note,
    p_idempotency_key: input.idempotencyKey,
    p_manager_pin: input.managerPin ?? null,
    p_reason: input.reason ?? null,
  });

  if (error) throw error;
  return purchaseReceiptRows.row(data);
}

// ---------------------------------------------------------------------------
// The reconciliation (046 §7.6)
// ---------------------------------------------------------------------------
// The check that makes the posting worth having, and the reason it is exposed
// rather than left as a dry-run assertion: a check nobody can run is a check
// that is true on the day it was written.
export async function fetchInventoryReconciliation(
  propertyId: string,
): Promise<InventoryGlReconciliation | null> {
  const { data, error } = await supabase.rpc('inventory_gl_reconciliation', {
    p_property_id: propertyId,
  });
  if (error) throw error;
  const rows = reconciliationRows.rows(data);
  return rows[0] ?? null;
}

// The per-shelf breakdown, ordered by the SIZE of the difference. A gap at the
// property level is a number; a gap on one shelf, with "this position has been
// below zero" beside it, is a sentence somebody can act on.
//
// Bounded by the property's own position count (rule 1a) — every position is
// returned, including the ones that reconcile exactly, because those are the
// evidence that the others are the exception. The CARD shows only the ones that
// differ; the honesty is in the data layer not throwing any of them away.
export async function fetchInventoryReconciliationPositions(
  propertyId: string,
): Promise<InventoryReconciliationPosition[]> {
  const { data, error } = await supabase.rpc(
    'inventory_gl_reconciliation_positions',
    { p_property_id: propertyId },
  );
  if (error) throw error;
  return reconciliationPositionRows.rows(data);
}

// ---------------------------------------------------------------------------
// The live arithmetic the receiving screen shows
// ---------------------------------------------------------------------------
// PURE, and exported for exactly that reason: proofs/purchasingRender exercises
// THESE functions rather than rebuilding their arithmetic from its own constants
// — which is rule 27's first shape and the way an assertion comes to prove
// itself (1.1g's receipt preview stayed at 35/35 with the weighted average
// broken, because the proof never called the function).

export interface LineDifference {
  // What is still expected on this line.
  outstanding: number;
  // What is being entered.
  entered: number;
  // HAS A QUANTITY ACTUALLY BEEN TYPED. Null and zero are different facts and
  // this is the flag that keeps them apart — see the note on lineDifference.
  isEntered: boolean;
  // Positive = more arrived than was expected. Negative = short. Zero while
  // nothing has been typed, because "no answer" is not "none arrived".
  quantityDifference: number;
  // TRUE when the server will require a reason on this line.
  needsReason: boolean;
  // TRUE when the server will require a manager PIN for the whole delivery.
  isOverReceipt: boolean;
  // Positive = the invoice is higher than the order, per base unit.
  unitCostDifference: number;
  costDifferenceValue: number;
  lineValue: number;
}

// NOTHING TYPED IS NOT THE SAME FACT AS ZERO ARRIVED, and conflating them is
// what the walk saw.
//
// Ticking a line to put it on the delivery used to read its empty quantity as 0
// and compute a difference from it, so an untouched row immediately showed a red
// "-100" against a hundred kilos nobody had counted yet — and, from the same
// `quantityDifference !== 0`, demanded a reason for a shortfall that had not
// been reported. The person has said "this line is on this delivery"; they have
// not yet said how much came.
//
// THE DATA PATH WAS NEVER AT RISK, and that is worth writing down because it is
// why this is a display fix: `submit` sends the RAW draft, so the untyped
// quantity reaches 046 as a JSON null, and 046 refuses it by name — "enter how
// much arrived. Zero is allowed, a negative is not." No zero-quantity line could
// ever be written. The screen was telling a story the server would not have
// accepted.
//
// A TYPED zero is a different thing again and still means something: it is
// "nothing came and nothing more is coming", which 046 pairs with closed_short.
// So `isEntered` is about whether an answer exists, never about its value.
export function lineDifference(
  line: PurchaseOrderLineStatus,
  draft: ReceiptLineDraft,
): LineDifference {
  const isEntered = draft.quantity !== null && draft.quantity !== undefined;
  const entered = draft.quantity ?? 0;
  const cost = draft.unitCost ?? 0;
  const outstanding = line.outstanding_quantity;
  const quantityDifference = isEntered ? round4(entered - outstanding) : 0;
  const unitCostDifference = round2(cost - line.ordered_unit_cost);

  return {
    outstanding,
    entered,
    isEntered,
    quantityDifference,
    // MIRRORS THE SERVER, and deliberately does not restate its sentence: this
    // decides whether the reason FIELD is shown, and the refusal — if the field
    // is left empty anyway — comes back from 046 in its own words.
    needsReason: isEntered && quantityDifference !== 0,
    isOverReceipt: isEntered && quantityDifference > 0,
    unitCostDifference,
    costDifferenceValue: round2(entered * unitCostDifference),
    lineValue: round2(entered * cost),
  };
}

export interface DeliveryTotals {
  lineCount: number;
  // What the whole delivery is worth at the INVOICED costs — which is what the
  // journal entry will credit to the supplier.
  invoiceValue: number;
  // What those quantities would have cost at the ORDERED prices.
  orderedValue: number;
  costDifferenceValue: number;
  // TRUE when any line is over, so the form can ask for the PIN BEFORE the
  // server refuses — the manager is fetched once, rather than being sent away
  // and called back.
  needsManager: boolean;
  linesNeedingReason: number;
  // TRUE when at least one TICKED line is stock arriving in a quantity above
  // zero. The destination half of the manager gate turns on this and not on the
  // destination alone (053): a freezer delivered to the bar moves no stock, so
  // section 9's rule about stock arriving outside the store does not reach it.
  movesStock: boolean;
}

export function deliveryTotals(
  lines: PurchaseOrderLineStatus[],
  drafts: Map<string, ReceiptLineDraft>,
): DeliveryTotals {
  let invoiceValue = 0;
  let orderedValue = 0;
  let costDifferenceValue = 0;
  let lineCount = 0;
  let needsManager = false;
  let linesNeedingReason = 0;
  let movesStock = false;

  for (const line of lines) {
    const draft = drafts.get(line.purchase_order_line_id);
    if (!draft) continue;
    lineCount += 1;
    const d = lineDifference(line, draft);
    invoiceValue += d.lineValue;
    orderedValue += round2(d.entered * line.ordered_unit_cost);
    costDifferenceValue += d.costDifferenceValue;
    if (d.isOverReceipt) needsManager = true;
    if (d.needsReason && draft.reason.trim().length === 0) linesNeedingReason += 1;
    // DOES THIS DELIVERY ACTUALLY MOVE STOCK? 053 narrowed the server's
    // destination gate to exactly this question, because section 9's rule is
    // about stock arriving outside the store and a freezer is not stock. The
    // form has to ask the same question or it will demand a PIN that
    // receive_purchase_order then refuses as unnecessary — which is the worst
    // shape of all: the person finds a manager, types the PIN and is told no
    // PIN was needed.
    if (line.line_type === 'inventory' && d.entered > 0) movesStock = true;
  }

  return {
    lineCount,
    invoiceValue: round2(invoiceValue),
    orderedValue: round2(orderedValue),
    costDifferenceValue: round2(costDifferenceValue),
    needsManager,
    linesNeedingReason,
    movesStock,
  };
}

// Money is two decimals and quantities are four (CLAUDE.md §6). Rounded at the
// same points the database rounds, so the figure on screen is the figure that
// will be posted rather than one that is close to it.
function round2(v: number): number {
  return Math.round((v + Number.EPSILON) * 100) / 100;
}
function round4(v: number): number {
  return Math.round((v + Number.EPSILON) * 10000) / 10000;
}

// Re-exported so a caller that needs a bare numeric from an RPC does not reach
// past this module for it.
export { scalarNumber };
