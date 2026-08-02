// DB row types for the 001 tenancy migration. Keep in sync with
// supabase/migrations/001_initial_tenancy.sql — do not add fields the schema
// does not have.

export type TenantStatus = 'trial' | 'active' | 'suspended' | 'cancelled';
export type PropertyStatus = 'active' | 'inactive' | 'closed';
export type PropertyTemplate = 'warm_family' | 'luxury_modern' | 'minimalist';

// property_settings.branding is presentation-only freeform JSONB (colors, logo,
// hero images, fonts, tagline, section visibility/order). The schema does not
// constrain its shape, so neither do we — no invented fields.
export type PropertyBranding = Record<string, unknown>;

// tenants
export interface Tenant {
  id: string;
  name: string;
  slug: string;
  status: TenantStatus;
  trial_ends_at: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
}

// properties
export interface Property {
  id: string;
  tenant_id: string;
  name: string;
  slug: string;
  domain: string | null;
  timezone: string;
  currency: string;
  night_audit_time: string; // sql `time`
  // Location & contact — real columns (003), not branding: read by invoices,
  // receipts, booking confirmations and tax documents, not only the guest site.
  address_line: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string; // not null, defaults to 'Nigeria'
  // numeric(10,7). PostgREST returns numeric columns as STRINGS (e.g.
  // "4.3968311"), never JS numbers, to preserve precision — parse with
  // parseNumeric before any arithmetic (CLAUDE.md §6, Money).
  latitude: string | null;
  longitude: string | null;
  phone: string | null;
  email: string | null;
  status: PropertyStatus;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
}

// tenant_settings (company-wide; accounting-level, not guest-facing)
export interface TenantSettings {
  tenant_id: string;
  default_vat_rate: number; // numeric(5,4)
  // Which admin modules this tenant sees (006). Values are AdminModule keys
  // (adminNav.ts); typed as string[] here to keep this row type free of a
  // components import, and narrowed by useEnabledModules. Never empty of
  // 'settings' — a DB check constraint guarantees it.
  enabled_modules: string[];
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
}

// property_settings (everything the guest site renders)
export interface PropertySettings {
  property_id: string;
  template: PropertyTemplate;
  booking_enabled: boolean;
  branding: PropertyBranding;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
}

// property_finance_settings (per-property INTERNAL finance config, 021 §3).
//
// Deliberately NOT part of property_settings: that table carries a public (anon)
// read policy for the guest site, and Postgres RLS is row-level, so a threshold
// placed there would be readable by the entire internet. This one is
// member-read / admin-write with no public policy, and exactly one row per
// property is guaranteed by an AFTER INSERT trigger.
export interface PropertyFinanceSettings {
  property_id: string;
  // numeric(14,2) — a STRING over PostgREST (§6). Parse with parseNumeric before
  // any arithmetic or comparison. 0 means EVERY discount needs a manager PIN.
  discount_threshold: string;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
}

// A resolved property plus its guest-facing settings and its parent tenant.
// (property_settings, not tenant_settings — tenant_settings is not public.)
export interface PropertyContext {
  property: Property;
  settings: PropertySettings;
  tenant: Tenant;
}
