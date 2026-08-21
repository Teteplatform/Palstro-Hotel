import { supabase } from './supabase';
import { boundary } from './rowParse';
import type { WriteoffReason } from '../types/stock';

// THE PROVENANCE REPORT'S DATA LAYER (1.1g §4) — things that did not come
// through the front door.
//
// ---------------------------------------------------------------------------
// THREE QUESTIONS, NOT THREE ACCUSATIONS
// ---------------------------------------------------------------------------
// Every row this module returns has an innocent explanation and most of them are
// innocent. A direct receipt is usually a real delivery that really did go
// straight to the bar. A late opening balance is usually somebody adding an item
// they forgot. A negative is usually a delivery nobody keyed.
//
// The report's job is to make them ASKABLE — which is why every read here carries
// the actor, the reason and the dates, so the answer is normally visible without
// anybody having to be asked at all. A screen that listed the rows without the
// reasons would turn a five-second glance into a conversation, and the
// conversation is the expensive part.
//
// ---------------------------------------------------------------------------
// THE NEGATIVES ARE NOT HERE, AND THAT IS THE POINT
// ---------------------------------------------------------------------------
// §4's third section reads stock_negative_positions through the functions that
// already exist in lib/stock (fetchNegativePositionsPage and its summary). A
// second implementation of "what is negative" would drift from the first, and the
// two screens showing it would then disagree — with no way to tell which was
// right. This file adds the two things that had no reader yet and joins the third.
//
// Compliance: rule 1b (server-side paging with an exact count, every filter
// server-side), rule 19 (RLS is the floor; every read also scopes to the active
// tenant AND property), rule 24 (numerics parsed at the boundary).

// ---------------------------------------------------------------------------
// Direct receipts — stock that arrived somewhere other than a store
// ---------------------------------------------------------------------------

export interface DirectReceiptRow {
  id: string;
  business_date: string;
  created_at: string;
  quantity: number;
  unit_cost: number;
  receipt_value: number;
  supplier: string | null;
  reason: string | null;
  note: string | null;
  created_by: string | null;
  // The manager who authorised it. The whole reason this report can be read
  // rather than investigated.
  authorised_by: string | null;
  item_name: string;
  item_code: string | null;
  base_unit: string;
  location_name: string;
  location_kind: string;
}

const directReceiptRows = boundary<DirectReceiptRow>('stock_direct_receipts')(
  ['quantity', 'unit_cost', 'receipt_value'] as const,
  [] as const,
);

export interface ProvenancePage<T> {
  rows: T[];
  // Exact total for the CURRENT FILTER, not the page length — what makes "of N"
  // honest (rule 1b).
  count: number;
}

export interface ProvenanceFilters {
  // Both inclusive, both server-side. The business date, never created_at: a
  // report about an operating period groups by the operating day (rules 8/12).
  fromDate: string;
  toDate: string;
}

export const EMPTY_PROVENANCE_FILTERS: ProvenanceFilters = {
  fromDate: '',
  toDate: '',
};

export function hasProvenanceFilters(f: ProvenanceFilters): boolean {
  return Boolean(f.fromDate) || Boolean(f.toDate);
}

export async function fetchDirectReceiptsPage(
  tenantId: string,
  propertyId: string,
  page: number,
  pageSize: number,
  filters: ProvenanceFilters = EMPTY_PROVENANCE_FILTERS,
): Promise<ProvenancePage<DirectReceiptRow>> {
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  let q = supabase
    .from('stock_direct_receipts')
    .select('*', { count: 'exact' })
    .eq('tenant_id', tenantId) // rule 19
    .eq('property_id', propertyId); // rule 19 — stock is physical

  if (filters.fromDate) q = q.gte('business_date', filters.fromDate);
  if (filters.toDate) q = q.lte('business_date', filters.toDate);

  const { data, error, count } = await q
    // Newest first: the question is "what has been happening", and the most
    // recent exception is the one somebody can still remember.
    .order('business_date', { ascending: false })
    .order('id', { ascending: true }) // unique → stable paging
    .range(from, to);

  if (error) throw error;
  return { rows: directReceiptRows.rows(data), count: count ?? 0 };
}

// ---------------------------------------------------------------------------
// Late openings — an opening balance in a location already in use
// ---------------------------------------------------------------------------

export interface LateOpeningRow {
  id: string;
  business_date: string;
  created_at: string;
  quantity: number;
  unit_cost: number;
  opening_value: number;
  note: string | null;
  created_by: string | null;
  // What was already happening in that location when this opening appeared —
  // the fact that makes the row a question rather than a flag.
  first_movement_at: string;
  first_movement_date: string;
  first_movement_type: string;
  item_name: string;
  item_code: string | null;
  base_unit: string;
  location_name: string;
  location_kind: string;
}

const lateOpeningRows = boundary<LateOpeningRow>('stock_late_openings')(
  ['quantity', 'unit_cost', 'opening_value'] as const,
  [] as const,
);

export async function fetchLateOpeningsPage(
  tenantId: string,
  propertyId: string,
  page: number,
  pageSize: number,
  filters: ProvenanceFilters = EMPTY_PROVENANCE_FILTERS,
): Promise<ProvenancePage<LateOpeningRow>> {
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  let q = supabase
    .from('stock_late_openings')
    .select('*', { count: 'exact' })
    .eq('tenant_id', tenantId) // rule 19
    .eq('property_id', propertyId); // rule 19

  if (filters.fromDate) q = q.gte('business_date', filters.fromDate);
  if (filters.toDate) q = q.lte('business_date', filters.toDate);

  const { data, error, count } = await q
    .order('business_date', { ascending: false })
    .order('id', { ascending: true })
    .range(from, to);

  if (error) throw error;
  return { rows: lateOpeningRows.rows(data), count: count ?? 0 };
}

// ---------------------------------------------------------------------------
// Wastage by category (043 §3) — the loss report the reason_code exists for
// ---------------------------------------------------------------------------
// NOT ONE OF §4's THREE SECTIONS, and included here anyway for one reason: a
// write-off records what the lost stock COST (038's trigger stamps
// carried_unit_cost), and a category nobody ever groups on is a field that gets
// filled in carelessly. This is the surface that makes the category worth
// choosing correctly.

export interface WastageTotal {
  reason_code: WriteoffReason;
  // Positive magnitude — the report asks "how much did we lose", and a column of
  // negatives to be mentally negated is a column that gets misread.
  quantity: number;
  value: number;
  movements: number;
}

interface WastageRow {
  reason_code: WriteoffReason;
  quantity: number;
  carried_unit_cost: number | null;
}

const wastageRows = boundary<WastageRow>('stock_movements (wastage report)')(
  ['quantity'] as const,
  ['carried_unit_cost'] as const,
);

// Wastage grouped by category, over a date range.
//
// GROUPED IN THE CLIENT over a bounded read, deliberately — and the bound is what
// makes it legitimate. PostgREST cannot express `group by`, and the honest
// alternatives were a view (a fourth surface for a figure that is one sum) or an
// RPC. The read is one property's wastage over a stated date range, which is a
// handful of rows per month; the range is REQUIRED by the caller for exactly that
// reason, so this can never become an unbounded scan of a year's losses.
//
// THE VALUE IS READ, NEVER RECOMPUTED (§6). carried_unit_cost is what the stock
// actually cost when it left, stamped at that instant. Multiplying today's
// average by the quantity would produce a different, wrong, and confidently
// presented figure.
export async function fetchWastageByReason(
  tenantId: string,
  propertyId: string,
  fromDate: string,
  toDate: string,
): Promise<WastageTotal[]> {
  const { data, error } = await supabase
    .from('stock_movements')
    .select('reason_code,quantity,carried_unit_cost')
    .eq('tenant_id', tenantId) // rule 19
    .eq('property_id', propertyId) // rule 19
    .eq('movement_type', 'wastage')
    .gte('business_date', fromDate)
    .lte('business_date', toDate)
    .order('business_date', { ascending: true })
    .range(0, 999);

  if (error) throw error;
  const rows = wastageRows.rows(data);

  const totals = new Map<WriteoffReason, WastageTotal>();
  for (const row of rows) {
    if (!row.reason_code) continue;
    const entry = totals.get(row.reason_code) ?? {
      reason_code: row.reason_code,
      quantity: 0,
      value: 0,
      movements: 0,
    };
    // The quantity is stored NEGATIVE (a write-off removes stock); the report
    // shows the magnitude, because "we lost 12 kg" is the sentence.
    entry.quantity += -row.quantity;
    // A write-off with no carried cost cannot happen through the RPC — 038's
    // trigger stamps every stock-out — but a null is skipped rather than treated
    // as zero, which would understate a loss and look like a bargain.
    if (row.carried_unit_cost !== null) {
      entry.value += -row.quantity * row.carried_unit_cost;
    }
    entry.movements += 1;
    totals.set(row.reason_code, entry);
  }

  // Biggest loss first — the one worth doing something about.
  return [...totals.values()].sort((a, b) => b.value - a.value);
}
