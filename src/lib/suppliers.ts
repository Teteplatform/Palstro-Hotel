import { supabase } from './supabase';
import { boundary } from './rowParse';
import { fetchAllPagedRows } from './fetchAllPaged';
import { PICKER_SEARCH_LIMIT, safeSearchTerm, type PickerSearchResult } from './inventory';
import type { Supplier, SupplierActivityRow, SupplierWrite } from '../types/purchasing';

// THE SUPPLIER ADDRESS BOOK (046 §1), and the one-sided activity view beside it.
//
// ---------------------------------------------------------------------------
// WHY SUPPLIERS ARE TENANT-SCOPED AND ORDERS ARE PROPERTY-SCOPED
// ---------------------------------------------------------------------------
// Same split the catalogue draws. A group that buys rice from Bonny Fresh Foods
// for two hotels has ONE supplier record — one TIN, one bank account, one
// payment history — and two properties raising orders against it. Splitting the
// supplier per property would mean the same company keyed twice and a history
// that adds up to nothing.
//
// So every read here scopes to tenant_id (rule 19) and NOT to property_id.
// supplier_activity is the exception and scopes to both, because an ORDER
// belongs to a hotel.
//
// ---------------------------------------------------------------------------
// THERE IS NO BALANCE HERE, AND THAT IS THE POINT
// ---------------------------------------------------------------------------
// Receiving credits supplier_payable and NOTHING in 1.1h2 ever debits it, so a
// figure called "owed" computed from receipts would be right until the first
// payment and silently wrong forever after. Supplier payments are 1.1h5. This
// module lists what was ordered and what arrived, and stops there.

// ---------------------------------------------------------------------------
// The boundaries (rule 24)
// ---------------------------------------------------------------------------
// EXPORTED, because that is the seam rule 22 asks for rather than a copy:
// proofs/purchasingRender pushes RAW WIRE ROWS — numerics as strings, then the
// same numerics as JSON numbers — through THESE parsers and renders the result
// with the real components.

export const supplierRows = boundary<Supplier>('suppliers')(
  [] as const,
  ['withholding_tax_rate'] as const,
);

export const supplierActivityRows = boundary<SupplierActivityRow>('supplier_activity')(
  // receipt_count is int8 over PostgREST — a JSON NUMBER — while the three money
  // fields beside it are STRINGS. One row, both mappings, and only the browser
  // ever sees the difference (rule 24).
  ['ordered_value', 'received_value', 'outstanding_value', 'receipt_count'] as const,
  [] as const,
);

// ---------------------------------------------------------------------------
// Filters (rule 1b — server-side, so paging a filtered set is correct)
// ---------------------------------------------------------------------------

export interface SupplierFilters {
  search: string;
  // '' = both. A switched-off supplier still has history worth reading, so
  // "every supplier" is the honest default for a list and 'active' is a choice.
  state: '' | 'active' | 'inactive';
}

export const EMPTY_SUPPLIER_FILTERS: SupplierFilters = { search: '', state: '' };

export function hasSupplierFilters(f: SupplierFilters): boolean {
  return Boolean(f.search.trim()) || Boolean(f.state);
}

// THE SINGLE FILTER IMPLEMENTATION. The page query, the count and the export all
// go through it, which is what makes "the total for this filter" honest rather
// than a second, drifting definition of the same set (rules 1b, 20).
function applySupplierFilters(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query: any,
  tenantId: string,
  filters: SupplierFilters,
) {
  let q = query
    .eq('tenant_id', tenantId) // rule 19 — RLS is the floor, not the ceiling
    .is('deleted_at', null); // rule 5

  const safe = safeSearchTerm(filters.search);
  if (safe.length > 0) {
    // Name, code, contact and phone: four things somebody might have in front of
    // them when they are looking a supplier up.
    q = q.or(
      `name.ilike.%${safe}%,code.ilike.%${safe}%,contact_name.ilike.%${safe}%,phone.ilike.%${safe}%`,
    );
  }

  if (filters.state === 'active') q = q.eq('is_active', true);
  if (filters.state === 'inactive') q = q.eq('is_active', false);

  return q;
}

export interface SuppliersPage {
  rows: Supplier[];
  count: number; // exact total for the CURRENT FILTER, never the page length
}

export async function fetchSuppliersPage(
  tenantId: string,
  page: number,
  pageSize: number,
  filters: SupplierFilters = EMPTY_SUPPLIER_FILTERS,
): Promise<SuppliersPage> {
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  const base = supabase.from('suppliers').select('*', { count: 'exact' });

  const { data, error, count } = await applySupplierFilters(base, tenantId, filters)
    .order('name', { ascending: true })
    .order('id', { ascending: true }) // unique → a stable window
    .range(from, to);

  if (error) throw error;
  return { rows: supplierRows.rows(data), count: count ?? 0 };
}

// Every row matching the current filter, across ALL pages — what Export writes
// (rule 20: filters apply, pagination does not).
export async function fetchSuppliersForExport(
  tenantId: string,
  filters: SupplierFilters = EMPTY_SUPPLIER_FILTERS,
): Promise<Supplier[]> {
  return fetchAllPagedRows<Supplier>(supplierRows, (from, to) => {
    const base = supabase.from('suppliers').select('*');
    return applySupplierFilters(base, tenantId, filters)
      .order('name', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to);
  });
}

export async function fetchSupplier(id: string): Promise<Supplier | null> {
  const { data, error } = await supabase
    .from('suppliers')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return supplierRows.maybeRow(data);
}

// ---------------------------------------------------------------------------
// The picker (rule 26)
// ---------------------------------------------------------------------------
// A QUERY, using the same predicates the list uses, so the picker's answer and
// the list's answer can never disagree. A hotel with two hundred suppliers is
// ordinary and a dropdown of two hundred is not.
export async function searchSuppliers(
  tenantId: string,
  term: string,
  options: { activeOnly?: boolean; limit?: number } = {},
): Promise<PickerSearchResult<Supplier>> {
  const limit = options.limit ?? PICKER_SEARCH_LIMIT;

  let q = supabase
    .from('suppliers')
    .select('*')
    .eq('tenant_id', tenantId) // rule 19
    .is('deleted_at', null); // rule 5

  if (options.activeOnly) q = q.eq('is_active', true);

  const safe = safeSearchTerm(term);
  if (safe.length > 0) q = q.or(`name.ilike.%${safe}%,code.ilike.%${safe}%`);

  const { data, error } = await q
    .order('name', { ascending: true })
    .order('id', { ascending: true })
    .range(0, limit); // limit + 1 rows: the extra one reveals the cap

  if (error) throw error;
  const rows = supplierRows.rows(data);
  return { rows: rows.slice(0, limit), capped: rows.length > limit };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------
// DIRECT TABLE WRITES, not an RPC, and the same shape inventory_items uses: a
// supplier record is master data with no ledger consequence, RLS gates it to an
// admin, and the constraints are on the table. Every write that MOVES MONEY goes
// through an RPC; this one moves none.

export async function createSupplier(
  tenantId: string,
  write: SupplierWrite,
): Promise<Supplier> {
  const { data, error } = await supabase
    .from('suppliers')
    .insert({ tenant_id: tenantId, ...normalise(write) })
    .select('*')
    .single();
  if (error) throw error; // rule 11 — the caller surfaces the server's own words
  return supplierRows.row(data);
}

export async function updateSupplier(
  id: string,
  write: SupplierWrite,
): Promise<Supplier> {
  const { data, error } = await supabase
    .from('suppliers')
    .update(normalise(write))
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw error;
  return supplierRows.row(data);
}

// Soft delete (rule 5, master data). A supplier with orders against it must stay
// readable forever — the purchase history is what a payment will be allocated
// against.
export async function softDeleteSupplier(id: string): Promise<void> {
  const { error } = await supabase
    .from('suppliers')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}

// Blank strings become NULL on the way in. An empty text box means "not
// recorded", and storing '' makes "have we got their TIN?" a question with two
// false answers.
function normalise(w: SupplierWrite) {
  const t = (v: string | null) => {
    const s = (v ?? '').trim();
    return s.length > 0 ? s : null;
  };
  return {
    name: w.name.trim(),
    code: t(w.code),
    contact_name: t(w.contact_name),
    phone: t(w.phone),
    email: t(w.email),
    address: t(w.address),
    tax_id: t(w.tax_id),
    withholding_tax_rate: w.withholding_tax_rate,
    bank_name: t(w.bank_name),
    bank_account_name: t(w.bank_account_name),
    bank_account_number: t(w.bank_account_number),
    note: t(w.note),
    is_active: w.is_active,
  };
}

// ---------------------------------------------------------------------------
// Activity — ONE-SIDED, and it keeps that name
// ---------------------------------------------------------------------------
// What was ordered from this supplier and what arrived, newest first. Scoped to
// the PROPERTY as well as the tenant, because an order belongs to a hotel even
// though the supplier belongs to the group.
// A CAPPED READ THAT RETURNS ITS TOTAL, because rule 1b's objection is to a cap
// with NO WAY TO REACH THE REST, not to a cap as such. This is a summary panel
// beside an address book; the way through is the Purchases list filtered to this
// supplier, which is a full list surface with real paging. The count is what
// lets the panel SAY the list is cut instead of quietly ending — a silent cap
// here would be the ERP's lie in a smaller costume.
export interface SupplierActivityPage {
  rows: SupplierActivityRow[];
  count: number; // exact total for this supplier at this property
}

export async function fetchSupplierActivity(
  tenantId: string,
  propertyId: string,
  supplierId: string,
  limit = 25,
): Promise<SupplierActivityPage> {
  const { data, error, count } = await supabase
    .from('supplier_activity')
    .select('*', { count: 'exact' })
    .eq('tenant_id', tenantId) // rule 19
    .eq('property_id', propertyId) // rule 19
    .eq('supplier_id', supplierId)
    .order('order_date', { ascending: false })
    .order('order_number', { ascending: false })
    .range(0, limit - 1);
  if (error) throw error;
  return { rows: supplierActivityRows.rows(data), count: count ?? 0 };
}
