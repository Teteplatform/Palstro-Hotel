import { supabase } from './supabase';
import { passthrough } from './rowParse';
import type { Guest } from '../types/guest';

// The boundary (rule 24). A guest record carries no numeric column — every
// figure about a guest is money on their folios — and it still crosses the
// boundary, because "every read is parsed" has to be checkable rather than
// judged case by case.
const guests = passthrough<Guest>('guests');

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

  const all = guests.rows(data);
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
  // Free-text stay preferences (027). Not passed to create_guest — the RPC's
  // signature is fixed and a preference is something learned over stays, not
  // asked at the desk in the middle of a booking. It is set by correction.
  preferences?: string | null;
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
  return guests.row(data);
}

// Correct an existing guest's details (build A §2 — the Guest Details tab).
//
// THERE IS NO update_guest RPC, AND THIS DOES NOT INVENT ONE. The guest-update
// path that already exists is the `guests_member_update` RLS policy from 014,
// whose own comment states its purpose: "direct admin edits are for corrections".
// That is the same shape every other piece of master data in this app uses —
// updateRoomType and updateCompany are direct .update() calls under an
// admin-only policy — so a guest correction follows the established pattern
// rather than a new one.
//
// TWO CONSEQUENCES, BOTH DELIBERATE AND BOTH VISIBLE IN THE UI:
//   1. ONLY AN OWNER/MANAGER MAY SAVE. The policy requires is_tenant_admin, so a
//      front-desk user cannot fix a mistyped phone number — the screen hides the
//      Edit action for them rather than offering a save that RLS will refuse.
//      Widening that to front desk needs a staff-gated update_guest RPC (the
//      mirror of create_guest, which IS staff-gated). That is a schema change and
//      is NOT made here.
//   2. full_name is GENERATED (018) and is never written — Postgres recomputes it
//      from first/middle/last on every write, so the display name follows
//      automatically and cannot drift from its parts.
//
// Scoped to the active tenant and to LIVE rows only (rules 19, 5), so a stale id
// can never touch a soft-deleted or cross-tenant guest. The change_log trigger on
// guests records the before/after of every field against the acting user.
export async function updateGuest(
  guestId: string,
  tenantId: string,
  values: GuestWrite,
): Promise<Guest> {
  // preferences is written ONLY when the caller supplied the key. A screen that
  // edits the name and contact fields must not blank a preference it never
  // showed — and `emptyToNull(undefined)` is null, so an unconditional spread
  // would do exactly that.
  const preferencesPatch =
    'preferences' in values
      ? { preferences: emptyToNull(values.preferences) }
      : {};

  const { data, error } = await supabase
    .from('guests')
    .update({
      first_name: values.first_name.trim(),
      last_name: values.last_name.trim(),
      ...preferencesPatch,
      // Empty strings become NULL so "no middle name" is one value in the
      // database, not two ('' and NULL) that render and sort differently.
      middle_name: emptyToNull(values.middle_name),
      phone: emptyToNull(values.phone),
      email: emptyToNull(values.email),
      nationality: emptyToNull(values.nationality),
      id_type: emptyToNull(values.id_type),
      id_number: emptyToNull(values.id_number),
      // A date column: '' would be a cast error, NULL is "not recorded".
      id_expiry: emptyToNull(values.id_expiry),
      notes: emptyToNull(values.notes),
    })
    .eq('id', guestId)
    .eq('tenant_id', tenantId) // rule 19
    .is('deleted_at', null) // rule 5: only patch a live row
    .select()
    .single();

  if (error) throw error;
  return guests.row(data);
}

// One guest by id, for the guest detail page (2.txt §2). Scoped to the active
// tenant and to LIVE rows only (rules 19, 5) — a stale or cross-tenant id simply
// does not resolve, and the page says "not found" rather than rendering a shell.
//
// NOT property-scoped, deliberately: a guest belongs to the TENANT and is shared
// across its properties (014). What IS property-scoped is their stay history and
// ledger, which is where rule 19's property filter belongs.
export async function fetchGuestById(
  guestId: string,
  tenantId: string,
): Promise<Guest | null> {
  const { data, error } = await supabase
    .from('guests')
    .select('*')
    .eq('id', guestId)
    .eq('tenant_id', tenantId) // rule 19
    .is('deleted_at', null) // rule 5
    .maybeSingle();

  if (error) throw error;
  return (data ?? null) as Guest | null;
}

// Save just the preferences (2.txt §1). ONE column, so a preference edit can
// never touch a name, a phone number or an ID — and change_log records exactly
// the one field that changed.
//
// Same path and the same guard as every other guest correction: the admin-only
// `guests_member_update` policy from 014. A front-desk user is not offered the
// action, and the database refuses it regardless (rule 19).
export async function updateGuestPreferences(
  guestId: string,
  tenantId: string,
  preferences: string,
): Promise<Guest> {
  const { data, error } = await supabase
    .from('guests')
    .update({ preferences: emptyToNull(preferences) })
    .eq('id', guestId)
    .eq('tenant_id', tenantId) // rule 19
    .is('deleted_at', null) // rule 5
    .select()
    .single();

  if (error) throw error;
  return guests.row(data);
}

// Save just the email address, from the "send the statement by email" dialog
// (2.txt §UI: offer to save a corrected address to the guest record). ONE column,
// for the same reason updateGuestPreferences is one column: a desk correcting an
// address must not be able to blank a passport number by writing back a form it
// never showed.
//
// Same guard as every other guest correction — the admin-only
// `guests_member_update` policy from 014. The dialog offers the save only to an
// owner or manager; the database refuses it regardless (rule 19).
export async function updateGuestEmail(
  guestId: string,
  tenantId: string,
  email: string,
): Promise<Guest> {
  const { data, error } = await supabase
    .from('guests')
    .update({ email: emptyToNull(email) })
    .eq('id', guestId)
    .eq('tenant_id', tenantId) // rule 19
    .is('deleted_at', null) // rule 5
    .select()
    .single();

  if (error) throw error;
  return guests.row(data);
}

function emptyToNull(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed.length > 0 ? trimmed : null;
}
