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
  // numeric(10,7), parsed at the boundary (rule 24).
  latitude: number | null;
  longitude: number | null;
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
  // numeric(5,4) — a FRACTION, not a percent. It arrives from PostgREST as a
  // string and is parsed at the boundary (rule 24); this field claimed `number`
  // for a year while holding a string, which is the bug class in miniature.
  default_vat_rate: number;
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
  // numeric(14,2), parsed at the boundary (rule 24). 0 means EVERY discount
  // needs a manager PIN.
  discount_threshold: number;
  // 039 §1. The VALUE of variance above which finishing a stock take needs a
  // manager PIN — numeric(14,2). Money, never a quantity: 3 kg of saffron and 3 kg of rice are not the same event, and
  // quantities across units cannot be compared at all. Measured as the sum of
  // the ABSOLUTE value of every counted line's variance. 0 (the default) means
  // every count with any variance at all needs a manager.
  count_variance_threshold: number;
  // 038 §4. The last CLOSED business date: every posting RPC refuses a movement
  // dated on or before it, naming both the lock and the attempted date. A
  // Postgres `date` arrives as an ISO 'YYYY-MM-DD' string. NULL — the default —
  // means nothing is locked, and is a real value the settings form can write
  // back by clearing the field.
  posting_locked_through: string | null;
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
