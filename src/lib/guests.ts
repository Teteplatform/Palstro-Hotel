import { supabase } from './supabase';
import type { Guest } from '../types/guest';

// Data layer for guests as the booking flow (6b) uses them: SEARCH an existing
// returning guest (front desk finds them by name or phone before creating a
// booking, 014) and REGISTER a new one inline.
//
// Compliance:
//   - Rule 19: RLS is the floor; every read is ALSO scoped to the active tenant
//     (.eq('tenant_id', tenantId)).
//   - Rule 5: deleted_at NULL-safe — live guests only.
//   - Rule 1: the search is BOUNDED with a small .range() cap AND surfaced as a
//     "showing first N — refine your search" affordance in the UI, so it is a
//     type-ahead, not a silently-truncated list. (A booking picks exactly one
//     guest; the operator narrows by typing, they do not page a full roster.)
//   - Rule 11: every call is awaited and throws; the caller surfaces the error.
//   - Guest creation goes through the create_guest RPC (016), STAFF-gated, so
//     front desk — not just admins — can register a walk-in.

// The cap on a guest search result. Small on purpose: this is a picker, not a
// browse surface, and the UI tells the user to refine when the cap is hit.
export const GUEST_SEARCH_LIMIT = 20;

// Government ID document types a Nigerian hotel records at check-in (014/018).
// Stored as the `value` text on the guest row; the `label` is what staff read.
export interface GuestIdTypeOption {
  value: string;
  label: string;
}
export const GUEST_ID_TYPE_OPTIONS: GuestIdTypeOption[] = [
  { value: 'national_id', label: 'National ID (NIN)' },
  { value: 'passport', label: 'International Passport' },
  { value: 'drivers_license', label: "Driver's License" },
  { value: 'voters_card', label: "Voter's Card" },
];

export interface GuestSearchResult {
  rows: Guest[];
  // True when the result was capped — the UI shows "refine your search".
  capped: boolean;
}

// Search a tenant's live guests by name OR phone. An empty query returns the
// most recently updated guests (a sensible starting set) rather than nothing.
export async function searchGuests(
  tenantId: string,
  query: string,
): Promise<GuestSearchResult> {
  let q = supabase
    .from('guests')
    .select('*')
    .eq('tenant_id', tenantId) // rule 19
    .is('deleted_at', null) // rule 5
    .order('updated_at', { ascending: false })
    .range(0, GUEST_SEARCH_LIMIT); // one extra row tells us the result was capped

  const trimmed = query.trim();
  if (trimmed.length > 0) {
    // Match name OR phone. Commas/parens in user input would break PostgREST's
    // or() grammar, so strip them before interpolating.
    const safe = trimmed.replace(/[,()*]/g, ' ').trim();
    if (safe.length > 0) {
      q = q.or(`full_name.ilike.%${safe}%,phone.ilike.%${safe}%`);
    }
  }

  const { data, error } = await q;
  if (error) throw error;

  const all = (data ?? []) as Guest[];
  const capped = all.length > GUEST_SEARCH_LIMIT;
  return { rows: capped ? all.slice(0, GUEST_SEARCH_LIMIT) : all, capped };
}

export interface GuestWrite {
  // Structured name (018): first/last required, middle optional. full_name is
  // GENERATED in the DB and is never written by the app.
  first_name: string;
  last_name: string;
  middle_name?: string | null;
  phone?: string | null;
  email?: string | null;
  nationality?: string | null;
  id_type?: string | null;
  id_number?: string | null;
  id_expiry?: string | null;
  notes?: string | null;
}

// Register a new guest via the staff-gated create_guest RPC (016, restructured by
// 018). Returns the created row so the booking flow can attach it immediately.
// Awaited + throws (rule 11); the caller wraps in try/catch and surfaces the error.
export async function createGuest(
  tenantId: string,
  values: GuestWrite,
): Promise<Guest> {
  const { data, error } = await supabase.rpc('create_guest', {
    p_tenant_id: tenantId,
    p_first_name: values.first_name,
    p_last_name: values.last_name,
    p_middle_name: values.middle_name ?? null,
    p_phone: values.phone ?? null,
    p_email: values.email ?? null,
    p_nationality: values.nationality ?? null,
    p_id_type: values.id_type ?? null,
    p_id_number: values.id_number ?? null,
    p_id_expiry: values.id_expiry ?? null,
    p_notes: values.notes ?? null,
  });

  if (error) throw error;
  return data as Guest;
}
