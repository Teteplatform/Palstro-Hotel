import { supabase } from './supabase';
import { fetchAllPaged } from './fetchAllPaged';
import { parseNumeric } from './format';
import type {
  Booking,
  BookingDetail,
  BookingListRow,
  BookingStatus,
} from '../types/booking';

// Data layer for the booking screen (build 6b, §3).
//
// THE ONE HARD RULE (015): a booking is created ONLY through the create_booking
// RPC — never a direct insert — because the RPC's SELECT ... FOR UPDATE is the
// overbooking guard. Status changes and cancellation likewise go through RPCs
// (bookings has no update RLS policy). This module wraps those RPCs; it never
// writes the bookings table directly.
//
// Compliance:
//   - Rule 19: every read is scoped to the active property AND tenant.
//   - Rule 1b: the list pages SERVER-SIDE via .range() with an exact count.
//   - Rule 20: the status summary is computed across the WHOLE filtered set
//     (fetchAllPaged), never from the visible page — see fetchBookingSummary.
//   - Rule 11: every call is awaited and throws; the caller surfaces the error.
//   - §6: numeric columns (night rates, resolved rates) arrive as STRINGS; parse
//     with parseNumeric before any arithmetic.

// ---------------------------------------------------------------------------
// Filters — one definition, applied identically to the list and the summary so
// the two can never disagree about what "the current filter" means (rule 20).
// ---------------------------------------------------------------------------

export interface BookingFilters {
  // '' means "any status".
  status: BookingStatus | '';
  // Arrival (check_in) window, inclusive. '' means unbounded on that side. The
  // list is arrival-sorted, so filtering by arrival date is the natural pairing.
  arrivalFrom: string;
  arrivalTo: string;
  // Guest name substring (case-insensitive), matched via an inner join on guests.
  guestName: string;
  // Exact company id, or '' for any (walk-ins included).
  companyId: string;
}

export const EMPTY_BOOKING_FILTERS: BookingFilters = {
  status: '',
  arrivalFrom: '',
  arrivalTo: '',
  guestName: '',
  companyId: '',
};

// Apply the shared filters to a bookings query. The caller's select MUST alias
// the guests embed as `guest` with an inner join (guest:guests!inner(...)) so the
// guest-name filter narrows the PARENT rows, not just the embed. property_id +
// tenant_id (rule 19) and the deleted_at NULL-safe guard (rule 5) are applied
// here too, so no caller can forget them.
//
// Typed loosely (any) because supabase-js's builder generics do not compose
// across a shared helper; every filter below is a plain, safe method call.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyBookingFilters(query: any, tenantId: string, propertyId: string, filters: BookingFilters) {
  let q = query
    .eq('tenant_id', tenantId) // rule 19
    .eq('property_id', propertyId) // rule 19
    .is('deleted_at', null); // rule 5

  if (filters.status) q = q.eq('status', filters.status);
  if (filters.arrivalFrom) q = q.gte('check_in', filters.arrivalFrom);
  if (filters.arrivalTo) q = q.lte('check_in', filters.arrivalTo);
  if (filters.companyId) q = q.eq('company_id', filters.companyId);

  const name = filters.guestName.trim().replace(/[,()*]/g, ' ').trim();
  if (name.length > 0) q = q.ilike('guest.full_name', `%${name}%`);

  return q;
}

// The embed used everywhere the list/summary needs guest for filtering + display.
// !inner so a guest-name filter narrows parent rows (every booking has a guest,
// so inner never drops a legitimate row).
const LIST_SELECT =
  '*, guest:guests!inner(full_name, phone), room_type:room_types(name), company:companies(name), booking_nights(rate)';

// ---------------------------------------------------------------------------
// List (rule 1b)
// ---------------------------------------------------------------------------

export interface BookingsPage {
  rows: BookingListRow[];
  count: number; // exact total for the CURRENT FILTER, not the page length
}

// One SERVER-PAGINATED, SERVER-FILTERED page of the property's bookings, newest
// arrival first (rule 1b). `page` is 1-based.
export async function fetchBookingsPage(
  tenantId: string,
  propertyId: string,
  page: number,
  pageSize: number,
  filters: BookingFilters,
): Promise<BookingsPage> {
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  const base = supabase.from('bookings').select(LIST_SELECT, { count: 'exact' });
  const { data, error, count } = await applyBookingFilters(
    base,
    tenantId,
    propertyId,
    filters,
  )
    .order('check_in', { ascending: false }) // newest arrival first (brief)
    .order('booking_number', { ascending: false }) // stable tiebreak
    .range(from, to);

  if (error) throw error;
  // PostgREST types to-one embeds (guest/room_type/company) as arrays it can't
  // prove singular; at runtime they are single objects. Cast to the row shape,
  // as useTenantContext does for its tenant embed.
  return { rows: (data ?? []) as unknown as BookingListRow[], count: count ?? 0 };
}

// ---------------------------------------------------------------------------
// Status summary (rule 20 — spans the FILTER, not the page)
// ---------------------------------------------------------------------------

export interface BookingStatusBucket {
  count: number;
  // Sum of the LOCKED booking_nights rates for the bookings in this bucket —
  // never a recompute (brief §3). numeric strings parsed and summed.
  total: number;
}

export interface BookingSummary {
  // One bucket per status PRESENT in the filtered set (absent statuses omitted).
  byStatus: Partial<Record<BookingStatus, BookingStatusBucket>>;
  totalCount: number;
  totalValue: number;
}

// A trimmed row used only for aggregation: status + the locked night rates.
interface SummaryRow {
  status: BookingStatus;
  booking_nights: { rate: string }[];
}

// Compute the status summary across the WHOLE filtered set (rule 20), NOT the
// visible page. We fetch every matching row's status + locked night rates via
// fetchAllPaged (rule 1a — an internal read consumed in full) and aggregate in
// code. This is deliberately a SEPARATE query from the page fetch, using the
// SAME applyBookingFilters, so "the total for this filter" is honest and never a
// page-derived figure. The per-booking value is the sum of its locked nights, a
// read of stored rates — not a re-price.
export async function fetchBookingSummary(
  tenantId: string,
  propertyId: string,
  filters: BookingFilters,
): Promise<BookingSummary> {
  const rows = await fetchAllPaged<SummaryRow>((from, to) => {
    const base = supabase
      .from('bookings')
      // Only what the aggregate needs. guests inner-joined for the name filter.
      .select('status, guest:guests!inner(full_name), booking_nights(rate)');
    return applyBookingFilters(base, tenantId, propertyId, filters)
      .order('id', { ascending: true }) // unique → stable range pagination
      .range(from, to);
  });

  const byStatus: Partial<Record<BookingStatus, BookingStatusBucket>> = {};
  let totalCount = 0;
  let totalValue = 0;

  for (const row of rows) {
    const value = (row.booking_nights ?? []).reduce((sum, n) => {
      const r = parseNumeric(n.rate);
      return sum + (r ?? 0);
    }, 0);
    const bucket = byStatus[row.status] ?? { count: 0, total: 0 };
    bucket.count += 1;
    bucket.total += value;
    byStatus[row.status] = bucket;
    totalCount += 1;
    totalValue += value;
  }

  return { byStatus, totalCount, totalValue };
}

// Sum a booking's locked night rates (its total, never a recompute — brief §3).
export function bookingTotal(nights: { rate: string }[]): number {
  return (nights ?? []).reduce((sum, n) => sum + (parseNumeric(n.rate) ?? 0), 0);
}

// ---------------------------------------------------------------------------
// Detail (per-night breakdown)
// ---------------------------------------------------------------------------

const DETAIL_SELECT =
  '*, guest:guests(full_name, phone, email), room_type:room_types(name, max_adults, max_children), company:companies(name), booking_nights(stay_date, rate, rate_source)';

// One booking with its embeds and every night ordered by date — the manage view's
// per-night breakdown. Scoped to the active tenant + property (rule 19).
export async function fetchBookingDetail(
  bookingId: string,
  tenantId: string,
  propertyId: string,
): Promise<BookingDetail | null> {
  const { data, error } = await supabase
    .from('bookings')
    .select(DETAIL_SELECT)
    .eq('id', bookingId)
    .eq('tenant_id', tenantId) // rule 19
    .eq('property_id', propertyId) // rule 19
    .is('deleted_at', null) // rule 5
    .order('stay_date', { referencedTable: 'booking_nights', ascending: true })
    .maybeSingle();

  if (error) throw error;
  // To-one embeds arrive as single objects at runtime; cast to the detail shape.
  return (data ?? null) as unknown as BookingDetail | null;
}

// ---------------------------------------------------------------------------
// Availability + pricing (read-only server functions)
// ---------------------------------------------------------------------------

// Free units of a room type for [checkIn, checkOut) via count_available (015).
// Returns an integer (PostgREST returns integers as JS numbers, not strings).
export async function countAvailable(
  propertyId: string,
  roomTypeId: string,
  checkIn: string,
  checkOut: string,
): Promise<number> {
  const { data, error } = await supabase.rpc('count_available', {
    p_property_id: propertyId,
    p_room_type_id: roomTypeId,
    p_check_in: checkIn,
    p_check_out: checkOut,
  });
  if (error) throw error;
  return typeof data === 'number' ? data : Number(data ?? 0);
}

// The company-aware nightly rate for a date via resolve_booking_rate (016).
// companyId null -> rack. numeric result arrives as a STRING (§6) — parse.
export async function resolveBookingRate(
  roomTypeId: string,
  date: string,
  companyId: string | null,
): Promise<number | null> {
  const { data, error } = await supabase.rpc('resolve_booking_rate', {
    p_room_type_id: roomTypeId,
    p_date: date,
    p_company_id: companyId,
  });
  if (error) throw error;
  return parseNumeric(data as string | number | null);
}

// ---------------------------------------------------------------------------
// Writes — ALL through RPCs (never a direct table write, 015 §7/§9)
// ---------------------------------------------------------------------------

export interface CreateBookingInput {
  propertyId: string;
  roomTypeId: string;
  guestId: string;
  checkIn: string;
  checkOut: string;
  adults: number;
  children: number;
  specialRequests: string | null;
  companyId: string | null;
  // 'company' bill_to is only valid with a company; the caller enforces this.
  billTo: 'guest' | 'company';
  // A fresh key per submit attempt (crypto.randomUUID) so a double-click / retry
  // cannot double-book — the DB's partial unique index is the true guard (rule 2/3).
  idempotencyKey: string;
}

// Create a booking through the ONLY sanctioned path (create_booking, 016). The
// availability exception (a full room type) surfaces as a check_violation the
// caller detects via isNoAvailabilityError to show "no longer available" and
// refresh availability (brief §3).
export async function createBooking(
  input: CreateBookingInput,
): Promise<Booking> {
  const { data, error } = await supabase.rpc('create_booking', {
    p_property_id: input.propertyId,
    p_room_type_id: input.roomTypeId,
    p_guest_id: input.guestId,
    p_check_in: input.checkIn,
    p_check_out: input.checkOut,
    p_adults: input.adults,
    p_idempotency_key: input.idempotencyKey,
    p_children: input.children,
    p_special_requests: input.specialRequests,
    p_bill_to: input.billTo,
    p_company_id: input.companyId,
  });
  if (error) throw error;
  return data as Booking;
}

// True when an error is the overbooking guard firing (create_booking raises a
// check_violation whose message names availability). The booking flow uses this
// to distinguish "someone booked the last room between viewing and submitting"
// from any other failure, so it can refresh availability rather than just error.
export function isNoAvailabilityError(e: unknown): boolean {
  const err = e as { code?: string; message?: string } | null;
  return (
    err?.code === '23514' &&
    typeof err.message === 'string' &&
    err.message.toLowerCase().includes('no availability')
  );
}

export async function cancelBooking(
  bookingId: string,
  reason: string,
): Promise<Booking> {
  const { data, error } = await supabase.rpc('cancel_booking', {
    p_booking_id: bookingId,
    p_reason: reason,
    p_idempotency_key: null,
  });
  if (error) throw error;
  return data as Booking;
}

// The two lifecycle transitions the screen exposes (016). Each is a distinct RPC
// because each will touch the folio in 6c; the screen calls them by name rather
// than a generic setter. There is no confirmBooking: create_booking already
// creates a booking 'confirmed', so enquiry -> confirmed is unreachable in 6b.
export async function checkInBooking(bookingId: string): Promise<Booking> {
  const { data, error } = await supabase.rpc('check_in_booking', {
    p_booking_id: bookingId,
    p_idempotency_key: null,
  });
  if (error) throw error;
  return data as Booking;
}

export async function checkOutBooking(bookingId: string): Promise<Booking> {
  const { data, error } = await supabase.rpc('check_out_booking', {
    p_booking_id: bookingId,
    p_idempotency_key: null,
  });
  if (error) throw error;
  return data as Booking;
}
