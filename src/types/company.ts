// DB row types for companies + company_rates (supabase/migrations/016_companies.sql).
// Keep in sync with the migration — no fields the schema does not have.
//
// A company is a corporate account a hotel bills (NLNG, Shell, contractors),
// tenant-scoped and shared across the tenant's properties (like a guest). Its
// negotiated rate is per property + room type and is COMMERCIALLY SENSITIVE —
// neither table ever gets a public read policy.

export interface Company {
  id: string;
  tenant_id: string;
  name: string;
  contact_name: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  address: string | null;
  notes: string | null;
  is_active: boolean;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
}

export type CompanyRateMode = 'fixed' | 'percentage';

export interface CompanyRate {
  id: string;
  tenant_id: string;
  property_id: string;
  company_id: string;
  room_type_id: string;
  rate_mode: CompanyRateMode;
  // numeric(14,2) / numeric(5,2) — PostgREST returns numeric as STRINGS to
  // preserve precision (§6). Parse with parseNumeric before any arithmetic.
  // Exactly one of these is set per the 016 check constraint: fixed_rate when
  // mode='fixed', discount_percent when mode='percentage'.
  fixed_rate: string | null;
  discount_percent: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
}
