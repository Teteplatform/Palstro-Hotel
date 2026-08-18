import { supabase } from './supabase';
import { fetchAllPagedRows } from './fetchAllPaged';
import { boundary, passthrough, scalarNumber } from './rowParse';
import type { Company, CompanyRate, CompanyRateMode } from '../types/company';

// The boundaries (rule 24) — completeness checked by the compiler.
const companies = passthrough<Company>('companies');
const rates = boundary<CompanyRate>('company_rates')(
  [] as const,
  ['fixed_rate', 'discount_percent'] as const,
);

// Data layer for companies + their negotiated rates (build 6b, §1/§2).
//
// Compliance, matching roomTypes.ts:
//   - Rule 19: RLS is the floor; every read AND write is additionally scoped to
//     the active tenant (companies are tenant-scoped, no property_id). Rate rows
//     also carry property_id, scoped on write.
//   - Rule 5: deleted_at NULL-safe — "live" is deleted_at IS NULL.
//   - Rule 11: every call is awaited and throws; the caller surfaces the error.
//   - Rule 24: both reads parse their numerics at the boundary, so a caller
//     receives a rate it can compare and add.
//
// Companies + company_rates are ADMIN-gated configuration master data (016's
// is_tenant_admin insert/update policies are the enforcement), NOT financial
// writes, so they go DIRECT to the tables — rule 2's idempotency machinery does
// not apply (there is no folio/charge/payment to double-post). The company-aware
// PRICING, by contrast, lives on the server (resolve_booking_rate) so it can
// never drift from what create_booking locks.

// ---------------------------------------------------------------------------
// Companies list
// ---------------------------------------------------------------------------

export interface CompaniesPage {
  rows: Company[];
  count: number; // exact total for the filter (rule 1b / 20), not the page length
}

// One SERVER-PAGINATED page of the tenant's live companies (rule 1b — never a
// client slice of a capped fetch). `page` is 1-based. An optional name filter is
// applied SERVER-SIDE so paging a filtered set is correct (rule 1b/20).
export async function fetchCompaniesPage(
  tenantId: string,
  page: number,
  pageSize: number,
  nameFilter = '',
): Promise<CompaniesPage> {
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  let q = supabase
    .from('companies')
    .select('*', { count: 'exact' })
    .eq('tenant_id', tenantId) // rule 19
    .is('deleted_at', null) // rule 5
    .order('name', { ascending: true })
    .order('created_at', { ascending: true }); // stable tiebreak

  const trimmed = nameFilter.trim();
  if (trimmed.length > 0) {
    const safe = trimmed.replace(/[,()*]/g, ' ').trim();
    if (safe.length > 0) q = q.ilike('name', `%${safe}%`);
  }

  const { data, error, count } = await q.range(from, to);
  if (error) throw error;
  return { rows: companies.rows(data), count: count ?? 0 };
}

// Every live company for a tenant — used where the WHOLE set is a picker (the
// booking flow's "bill to a company" select and the bookings filter), not a paged
// surface. fetchAllPaged (rule 1a). `activeOnly` limits to trading accounts for
// the booking select; the filter passes false to include dormant ones too.
export async function fetchAllCompanies(
  tenantId: string,
  activeOnly = false,
): Promise<Company[]> {
  return fetchAllPagedRows<Company>(companies, (from, to) => {
    let q = supabase
      .from('companies')
      .select('*')
      .eq('tenant_id', tenantId) // rule 19
      .is('deleted_at', null); // rule 5
    if (activeOnly) q = q.eq('is_active', true);
    return q.order('name', { ascending: true }).range(from, to);
  });
}

export interface CompanyWrite {
  name?: string;
  contact_name?: string | null;
  contact_phone?: string | null;
  contact_email?: string | null;
  address?: string | null;
  notes?: string | null;
  is_active?: boolean;
}

export async function createCompany(
  tenantId: string,
  values: CompanyWrite & { name: string },
): Promise<Company> {
  const { data, error } = await supabase
    .from('companies')
    .insert({ tenant_id: tenantId, ...values })
    .select()
    .single();

  if (error) throw error;
  return companies.row(data);
}

export async function updateCompany(
  id: string,
  tenantId: string,
  patch: CompanyWrite,
): Promise<Company> {
  const { data, error } = await supabase
    .from('companies')
    .update(patch)
    .eq('id', id)
    .eq('tenant_id', tenantId) // rule 19
    .is('deleted_at', null) // rule 5: only patch a live row
    .select()
    .single();

  if (error) throw error;
  return companies.row(data);
}

// Soft-delete a company (rule 5 / §6: master data is never hard-deleted). Its
// negotiated rates and any bookings against it survive.
export async function softDeleteCompany(
  id: string,
  tenantId: string,
): Promise<void> {
  const { error } = await supabase
    .from('companies')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id)
    .eq('tenant_id', tenantId) // rule 19
    .is('deleted_at', null); // idempotent: a retry after success is a no-op

  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Negotiated rates (one per company per room type)
// ---------------------------------------------------------------------------

// Every live negotiated rate for a company, keyed by room_type_id in the caller
// so a room-type list can show "which types have a deal". Small set (one row per
// type at most), so a single bounded read is correct — not a paged surface.
export async function fetchCompanyRates(
  companyId: string,
  tenantId: string,
): Promise<CompanyRate[]> {
  const { data, error } = await supabase
    .from('company_rates')
    .select('*')
    .eq('tenant_id', tenantId) // rule 19
    .eq('company_id', companyId)
    .is('deleted_at', null) // rule 5
    .order('created_at', { ascending: true });

  if (error) throw error;
  return rates.rows(data);
}

// The value side of a rate: exactly one of fixed_rate / discount_percent per the
// mode, matching 016's check constraint. The caller supplies numbers; the DB
// stores numeric(14,2) / numeric(5,2).
export interface CompanyRateWrite {
  rate_mode: CompanyRateMode;
  fixed_rate: number | null;
  discount_percent: number | null;
}

// Set (create) a negotiated rate for a company + room type. Callers guarantee
// the value matches the mode (fixed -> fixed_rate, percentage -> discount_percent);
// the DB check constraint is the backstop. property_id is required for the
// composite FK to room_types.
export async function createCompanyRate(
  tenantId: string,
  propertyId: string,
  companyId: string,
  roomTypeId: string,
  values: CompanyRateWrite,
): Promise<CompanyRate> {
  const { data, error } = await supabase
    .from('company_rates')
    .insert({
      tenant_id: tenantId,
      property_id: propertyId,
      company_id: companyId,
      room_type_id: roomTypeId,
      rate_mode: values.rate_mode,
      // Send only the side the mode uses; null the other so a mode switch never
      // leaves a contradictory leftover (the 016 constraint enforces this too).
      fixed_rate: values.rate_mode === 'fixed' ? values.fixed_rate : null,
      discount_percent:
        values.rate_mode === 'percentage' ? values.discount_percent : null,
    })
    .select()
    .single();

  if (error) throw error;
  return rates.row(data);
}

export async function updateCompanyRate(
  id: string,
  tenantId: string,
  values: CompanyRateWrite,
): Promise<CompanyRate> {
  const { data, error } = await supabase
    .from('company_rates')
    .update({
      rate_mode: values.rate_mode,
      fixed_rate: values.rate_mode === 'fixed' ? values.fixed_rate : null,
      discount_percent:
        values.rate_mode === 'percentage' ? values.discount_percent : null,
    })
    .eq('id', id)
    .eq('tenant_id', tenantId) // rule 19
    .is('deleted_at', null) // rule 5
    .select()
    .single();

  if (error) throw error;
  return rates.row(data);
}

export async function softDeleteCompanyRate(
  id: string,
  tenantId: string,
): Promise<void> {
  const { error } = await supabase
    .from('company_rates')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id)
    .eq('tenant_id', tenantId) // rule 19
    .is('deleted_at', null);

  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Company rate preview (§2: "what this company would pay versus rack")
// ---------------------------------------------------------------------------

export interface RatePreview {
  // The rack-side rate for the date (resolve_room_rate) and the company-aware
  // rate (resolve_booking_rate). Both parsed; null when the type has no price.
  rack: number | null;
  company: number | null;
}

// Resolve rack vs company price for a type on a date, via the SERVER functions
// (the single source of truth). Used by the companies preview so the owner can
// confirm the discount is right before a guest ever books. Numeric RPC results
// arrive as STRINGS (§6) — parse explicitly.
export async function previewCompanyRate(
  roomTypeId: string,
  date: string, // 'YYYY-MM-DD'
  companyId: string,
): Promise<RatePreview> {
  const [rack, company] = await Promise.all([
    supabase.rpc('resolve_booking_rate', {
      p_room_type_id: roomTypeId,
      p_date: date,
      p_company_id: null,
    }),
    supabase.rpc('resolve_booking_rate', {
      p_room_type_id: roomTypeId,
      p_date: date,
      p_company_id: companyId,
    }),
  ]);

  if (rack.error) throw rack.error;
  if (company.error) throw company.error;

  return {
    // A scalar RPC, not a row: resolve_booking_rate returns one numeric, which
    // arrives as a string. scalarNumber is the boundary for that shape (rule 24).
    rack: scalarNumber(rack.data),
    company: scalarNumber(company.data),
  };
}
