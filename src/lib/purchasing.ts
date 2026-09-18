import { supabase } from './supabase';
import { boundary, scalarNumber } from './rowParse';
import { fetchAllPagedRows } from './fetchAllPaged';
import { safeSearchTerm } from './inventory';
import { newIdempotencyKey } from './stock';
import type {
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
    p_lines: input.lines.map((l) => ({
      line_type: 'inventory',
      inventory_item_id: l.inventoryItemId,
      quantity: l.quantity,
      unit_cost: l.unitCost,
      note: l.note.trim() || null,
    })),
    p_idempotency_key: input.idempotencyKey,
  });

  if (error) throw error;
  return purchaseOrderRows.row(data);
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
  // Positive = more arrived than was expected. Negative = short.
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

export function lineDifference(
  line: PurchaseOrderLineStatus,
  draft: ReceiptLineDraft,
): LineDifference {
  const entered = draft.quantity ?? 0;
  const cost = draft.unitCost ?? 0;
  const outstanding = line.outstanding_quantity;
  const quantityDifference = round4(entered - outstanding);
  const unitCostDifference = round2(cost - line.ordered_unit_cost);

  return {
    outstanding,
    entered,
    quantityDifference,
    // MIRRORS THE SERVER, and deliberately does not restate its sentence: this
    // decides whether the reason FIELD is shown, and the refusal — if the field
    // is left empty anyway — comes back from 046 in its own words.
    needsReason: quantityDifference !== 0,
    isOverReceipt: quantityDifference > 0,
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
  }

  return {
    lineCount,
    invoiceValue: round2(invoiceValue),
    orderedValue: round2(orderedValue),
    costDifferenceValue: round2(costDifferenceValue),
    needsManager,
    linesNeedingReason,
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
