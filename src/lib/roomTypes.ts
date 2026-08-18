import { supabase } from './supabase';
import { fetchAllPagedRows } from './fetchAllPaged';
import { boundary, scalarNumber } from './rowParse';
import type { RoomType, SeasonalRate } from '../types/room';

// The boundaries (rule 24) — completeness checked by the compiler.
const roomTypes = boundary<RoomType>('room_types')(
  ['base_rate', 'max_adults', 'max_children', 'display_order'] as const,
  ['weekend_rate', 'size_sqm'] as const,
);

const seasonalRates = boundary<SeasonalRate>('seasonal_rates')(
  ['rate'] as const,
  [] as const,
);

// The data layer for the room-types admin screen (build 5a). Every function here
// follows the same compliance rules as mediaAssets.ts / useRoomTypes:
//   - Rule 19: RLS is the floor. Every read AND write is additionally scoped to
//     the ACTIVE tenant AND property (.eq('tenant_id') / .eq('property_id')), so
//     a multi-tenant user's data can never blend across their own tenants.
//   - Rule 5: deleted_at is NULL-safe — "live" means deleted_at IS NULL, never
//     .eq(..., false)-style filters.
//   - Rule 11: every call is awaited and throws its error; the calling component
//     surfaces it via toast and never swallows it.
//   - Rule 24: every read parses its rates at the boundary; a caller receives
//     numbers, and the two scalar RPCs go through scalarNumber.
//
// Writes go DIRECT to the tables (not through RPCs), matching mediaAssets.ts:
// room types and seasonal rates are admin-gated configuration master data, and
// 002/012's admin insert/update RLS policies are the enforcement. They are NOT
// financial writes, so rule 2's idempotency-key machinery does not apply (there
// is no folio/charge/payment to double-post); the DB-level admin policies plus
// per-row scoping are the correctness boundary.

export interface RoomTypesPage {
  rows: RoomType[];
  count: number; // exact total for the filter (rule 1b / 20), not the page length
}

// One page of the property's room types for the ADMIN list. Unlike the guest
// useRoomTypes, this returns UNPUBLISHED types too (an admin edits drafts) and
// pages SERVER-SIDE with an exact count via .range() (rule 1b) — never a
// client-side slice of a capped fetch. `page` is 1-based.
export async function fetchRoomTypesPage(
  propertyId: string,
  tenantId: string,
  page: number,
  pageSize: number,
): Promise<RoomTypesPage> {
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  const { data, error, count } = await supabase
    .from('room_types')
    .select('*', { count: 'exact' })
    .eq('tenant_id', tenantId) // rule 19: active tenant, explicit
    .eq('property_id', propertyId) // rule 19: active property, explicit
    .is('deleted_at', null) // rule 5: NULL-safe soft-delete
    .order('display_order', { ascending: true })
    .order('name', { ascending: true })
    .order('created_at', { ascending: true }) // stable final tiebreak
    .range(from, to);

  if (error) throw error;
  return { rows: roomTypes.rows(data), count: count ?? 0 };
}

// Every live room type for a property — used where the WHOLE set is consumed at
// once (the booking create flow lists all bookable types and their availability,
// and the company-rates editor shows one row per type), not a paged surface. Uses
// fetchAllPaged (rule 1a) so it is never a silently-truncated read. Returns ALL
// live types regardless of is_published: publication is a guest-site concern;
// staff can book (and negotiate rates for) any live type. Ordered by
// display_order so both consumers read in the owner's chosen order.
export async function fetchAllRoomTypes(
  propertyId: string,
  tenantId: string,
): Promise<RoomType[]> {
  return fetchAllPagedRows<RoomType>(roomTypes, (from, to) =>
    supabase
      .from('room_types')
      .select('*')
      .eq('tenant_id', tenantId) // rule 19
      .eq('property_id', propertyId) // rule 19
      .is('deleted_at', null) // rule 5
      .order('display_order', { ascending: true })
      .order('name', { ascending: true })
      .order('created_at', { ascending: true })
      .range(from, to),
  );
}

// Columns an admin may create/patch on a room type. Money fields are numbers here
// (the form parses them); the DB stores numeric(14,2). display_order and the
// arrays follow the schema types.
export interface RoomTypeWrite {
  name?: string;
  description?: string | null;
  bed_configuration?: string | null;
  size_sqm?: number | null;
  max_adults?: number;
  max_children?: number;
  amenities?: string[];
  has_air_conditioning?: boolean;
  is_smoking?: boolean;
  images?: string[];
  display_order?: number;
  is_published?: boolean;
  base_rate?: number;
  weekend_rate?: number | null;
  weekend_days?: number[];
}

// Create a room type. name and base_rate are the only genuinely-required fields
// (base_rate is NOT NULL in 002); everything else takes a schema default. The
// caller supplies the active tenant/property (never hardcoded — rule 17). The
// set_row_audit trigger stamps created_by/created_at.
export async function createRoomType(
  tenantId: string,
  propertyId: string,
  values: RoomTypeWrite & { name: string; base_rate: number; display_order: number },
): Promise<RoomType> {
  const { data, error } = await supabase
    .from('room_types')
    .insert({ tenant_id: tenantId, property_id: propertyId, ...values })
    .select()
    .single();

  if (error) throw error;
  return roomTypes.row(data);
}

// Patch a room type. Scoped to the active tenant+property AND live rows only, so
// a stale id can never touch a soft-deleted or cross-tenant row. Returns the
// fresh row so the caller re-bases its state without a refetch.
export async function updateRoomType(
  id: string,
  tenantId: string,
  propertyId: string,
  patch: RoomTypeWrite,
): Promise<RoomType> {
  const { data, error } = await supabase
    .from('room_types')
    .update(patch)
    .eq('id', id)
    .eq('tenant_id', tenantId) // rule 19
    .eq('property_id', propertyId) // rule 19
    .is('deleted_at', null) // rule 5: only patch a live row
    .select()
    .single();

  if (error) throw error;
  return roomTypes.row(data);
}

// Soft-delete a room type (rule 5 / §6: master data is never hard-deleted). Its
// history and any future bookings against it survive; it simply leaves the guest
// site and the admin list. Scoped to the active tenant+property.
export async function softDeleteRoomType(
  id: string,
  tenantId: string,
  propertyId: string,
): Promise<void> {
  const { error } = await supabase
    .from('room_types')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id)
    .eq('tenant_id', tenantId) // rule 19
    .eq('property_id', propertyId) // rule 19
    .is('deleted_at', null); // idempotent: a retry after success is a no-op

  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Seasonal rates (sub-list of a room type)
// ---------------------------------------------------------------------------

// Live seasonal rates for one room type, newest first (the same order the
// resolver's tiebreak favours, so the list reads top-down by precedence).
export async function fetchSeasonalRates(
  roomTypeId: string,
  tenantId: string,
): Promise<SeasonalRate[]> {
  const { data, error } = await supabase
    .from('seasonal_rates')
    .select('*')
    .eq('tenant_id', tenantId) // rule 19
    .eq('room_type_id', roomTypeId)
    .is('deleted_at', null) // rule 5
    .order('created_at', { ascending: false });

  if (error) throw error;
  return seasonalRates.rows(data);
}

export interface SeasonalRateWrite {
  name: string;
  start_date: string; // 'YYYY-MM-DD'
  end_date: string; // 'YYYY-MM-DD'
  rate: number;
}

// Create a seasonal rate under a room type. tenant/property/room_type come from
// the active context; the composite FKs in 012 guarantee they stay consistent.
export async function createSeasonalRate(
  tenantId: string,
  propertyId: string,
  roomTypeId: string,
  values: SeasonalRateWrite,
): Promise<SeasonalRate> {
  const { data, error } = await supabase
    .from('seasonal_rates')
    .insert({
      tenant_id: tenantId,
      property_id: propertyId,
      room_type_id: roomTypeId,
      ...values,
    })
    .select()
    .single();

  if (error) throw error;
  return seasonalRates.row(data);
}

export async function updateSeasonalRate(
  id: string,
  tenantId: string,
  patch: Partial<SeasonalRateWrite>,
): Promise<SeasonalRate> {
  const { data, error } = await supabase
    .from('seasonal_rates')
    .update(patch)
    .eq('id', id)
    .eq('tenant_id', tenantId) // rule 19
    .is('deleted_at', null) // rule 5
    .select()
    .single();

  if (error) throw error;
  return seasonalRates.row(data);
}

export async function softDeleteSeasonalRate(
  id: string,
  tenantId: string,
): Promise<void> {
  const { error } = await supabase
    .from('seasonal_rates')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id)
    .eq('tenant_id', tenantId) // rule 19
    .is('deleted_at', null);

  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Rate preview
// ---------------------------------------------------------------------------

// Resolve a room type's price on a date via the server function — the SINGLE
// source of truth (012). Used by the admin preview so the owner can confirm a
// weekend/seasonal rule fires when they expect. Returns a parsed number, or null
// when the type has no price / does not exist (caller shows MISSING_VALUE).
// Numeric RPC results arrive as strings from PostgREST (§6) — parse explicitly.
export async function resolveRoomRate(
  roomTypeId: string,
  date: string, // 'YYYY-MM-DD'
): Promise<number | null> {
  const { data, error } = await supabase.rpc('resolve_room_rate', {
    p_room_type_id: roomTypeId,
    p_date: date,
  });

  if (error) throw error;
  // A scalar RPC — one numeric, which arrives as a string (rule 24).
  return scalarNumber(data);
}
