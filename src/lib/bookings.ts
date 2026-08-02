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
  // Booking-number substring (case-insensitive), matched on bookings.booking_number.
  bookingNumber: string;
  // Exact room type id, or '' for any.
  roomTypeId: string;
  // Exact company id, or '' for any (walk-ins included).
  companyId: string;
}

export const EMPTY_BOOKING_FILTERS: BookingFilters = {
  status: '',
  arrivalFrom: '',
  arrivalTo: '',
  guestName: '',
  bookingNumber: '',
  roomTypeId: '',
  companyId: '',
};

// Apply the shared filters to a query. ONE implementation, two relations: the
// `bookings` table (where the guest name is reached through an inner-joined embed)
// and the `booking_balances` view (022), which projects guest_name as a plain
// column precisely so the same filter set can be applied to it.
//
// The column MAP is the only difference between the two, and it exists so the
// filtering itself cannot diverge. Two hand-written filter functions would agree
// on the day they were written and drift the first time a filter changed — and
// the symptom would be a Balance column and an outstanding total describing a
// different set of bookings than the list, with nothing erroring.
//
// property_id + tenant_id (rule 19) and the deleted_at NULL-safe guard (rule 5)
// are applied here too, so no caller can forget them.
//
// Typed loosely (any) because supabase-js's builder generics do not compose
// across a shared helper; every filter below is a plain, safe method call.
interface FilterColumns {
  // 'guest.full_name' on bookings (requires guest:guests!inner in the select);
  // 'guest_name' on booking_balances.
  guestName: string;
}

const BOOKINGS_COLUMNS: FilterColumns = { guestName: 'guest.full_name' };
const BALANCE_VIEW_COLUMNS: FilterColumns = { guestName: 'guest_name' };

function applyFilters(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query: any,
  tenantId: string,
  propertyId: string,
  filters: BookingFilters,
  columns: FilterColumns,
) {
  let q = query
    .eq('tenant_id', tenantId) // rule 19
    .eq('property_id', propertyId) // rule 19
    .is('deleted_at', null); // rule 5

  if (filters.status) q = q.eq('status', filters.status);
  if (filters.arrivalFrom) q = q.gte('check_in', filters.arrivalFrom);
  if (filters.arrivalTo) q = q.lte('check_in', filters.arrivalTo);
  if (filters.roomTypeId) q = q.eq('room_type_id', filters.roomTypeId);
  if (filters.companyId) q = q.eq('company_id', filters.companyId);

  const name = filters.guestName.trim().replace(/[,()*]/g, ' ').trim();
  if (name.length > 0) q = q.ilike(columns.guestName, `%${name}%`);

  // Booking-number substring, same PostgREST-metacharacter scrub as the name.
  const number = filters.bookingNumber.trim().replace(/[,()*]/g, ' ').trim();
  if (number.length > 0) q = q.ilike('booking_number', `%${number}%`);

  return q;
}

// The bookings-table flavour (the guests embed must be inner-joined by the caller
// so a guest-name filter narrows PARENT rows, not just the embed).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyBookingFilters(query: any, tenantId: string, propertyId: string, filters: BookingFilters) {
  return applyFilters(query, tenantId, propertyId, filters, BOOKINGS_COLUMNS);
}

// The booking_balances flavour — same filters, same meaning, view columns.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyBalanceFilters(query: any, tenantId: string, propertyId: string, filters: BookingFilters) {
  return applyFilters(query, tenantId, propertyId, filters, BALANCE_VIEW_COLUMNS);
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
  const rows = (data ?? []) as unknown as BookingListRow[];

  return {
    rows: await attachBalances(rows, tenantId, propertyId),
    count: count ?? 0,
  };
}

// Attach each visible row's LIVE folio balance in ONE extra query (build 6c part
// 2 §7).
//
// HOW THIS AVOIDS N+1, EXPLICITLY: the naive version calls folio_balance(folio_id)
// once per visible row — 25 round trips for one page, 100 at the largest page
// size, every time a filter changes. Instead migration 022 ships the
// `booking_balances` VIEW (bookings ⋈ folios ⋈ lateral folio_totals), and this
// function reads it once for exactly the ids on the page.
//
// The `.in()` here is bounded BY CONSTRUCTION and is not the unbounded `.in()`
// rule 1a forbids: its argument is the id list of a single server-paginated page,
// so it is at most `pageSize` long (100 at the largest option the shared
// Pagination control offers). It cannot grow with the table.
//
// Nothing is cached (rule 6): the view computes folio_totals per row on every
// read, so the column is always the live balance — the honest price of not
// keeping a balance column that would drift and could not be repaired.
async function attachBalances(
  rows: BookingListRow[],
  tenantId: string,
  propertyId: string,
): Promise<BookingListRow[]> {
  if (rows.length === 0) return rows;

  const { data, error } = await supabase
    .from('booking_balances')
    .select('booking_id, balance')
    .eq('tenant_id', tenantId) // rule 19
    .eq('property_id', propertyId) // rule 19
    .in(
      'booking_id',
      rows.map((r) => r.id),
    );

  if (error) throw error;

  const balances = new Map<string, string>();
  for (const row of (data ?? []) as { booking_id: string; balance: string }[]) {
    balances.set(row.booking_id, row.balance);
  }
  // A missing entry stays null (not 0): the list shows a dash rather than
  // asserting "nothing owed" about a booking whose folio it could not read.
  return rows.map((r) => ({ ...r, balance: balances.get(r.id) ?? null }));
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
  // OUTSTANDING across the whole filtered set (rule 20) — the sum of every
  // POSITIVE folio balance, i.e. what the hotel is owed by the bookings currently
  // in view. Kept separate from refundsDue rather than netted: a hotel owed
  // ₦300,000 that also owes ₦300,000 back is not "settled", and a single net
  // figure would report exactly that. Two figures, two questions, both answerable.
  outstandingTotal: number;
  // The mirror: the sum of every NEGATIVE balance, as a positive number — money
  // the hotel owes guests (over-payments and unconsumed deposits).
  refundsDueTotal: number;
}

// A trimmed row used only for aggregation: status + the locked night rates.
interface SummaryRow {
  status: BookingStatus;
  booking_nights: { rate: string }[];
}

// A trimmed booking_balances row for the outstanding aggregate.
interface BalanceSummaryRow {
  balance: string;
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
  // Two aggregate reads over the SAME filter, in parallel: the booking values
  // (locked night rates) and the folio balances (booking_balances, 022). They are
  // separate queries because they answer separate questions — what these stays are
  // WORTH versus what is still OWED on them — and blending them into one number
  // would produce a figure nobody could reconcile to anything.
  const [rows, balanceRows] = await Promise.all([
    fetchAllPaged<SummaryRow>((from, to) => {
      const base = supabase
        .from('bookings')
        // Only what the aggregate needs. guests inner-joined for the name filter.
        .select('status, guest:guests!inner(full_name), booking_nights(rate)');
      return applyBookingFilters(base, tenantId, propertyId, filters)
        .order('id', { ascending: true }) // unique → stable range pagination
        .range(from, to);
    }),
    // The outstanding aggregate spans the WHOLE filtered set, not the page (rule
    // 20), and applies the SAME filters through the same implementation — so the
    // total and the page's Balance column provably describe the same bookings.
    fetchAllPaged<BalanceSummaryRow>((from, to) => {
      const base = supabase.from('booking_balances').select('balance');
      return applyBalanceFilters(base, tenantId, propertyId, filters)
        .order('booking_id', { ascending: true }) // unique → stable pagination
        .range(from, to);
    }),
  ]);

  let outstandingTotal = 0;
  let refundsDueTotal = 0;
  for (const row of balanceRows) {
    // numeric -> STRING (§6); parse before comparing or adding.
    const balance = parseNumeric(row.balance) ?? 0;
    if (balance > 0) outstandingTotal += balance;
    else if (balance < 0) refundsDueTotal += -balance;
  }

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

  return { byStatus, totalCount, totalValue, outstandingTotal, refundsDueTotal };
}

// Sum a booking's locked night rates (its total, never a recompute — brief §3).
export function bookingTotal(nights: { rate: string }[]): number {
  return (nights ?? []).reduce((sum, n) => sum + (parseNumeric(n.rate) ?? 0), 0);
}

// ---------------------------------------------------------------------------
// Detail (per-night breakdown)
// ---------------------------------------------------------------------------

// The detail PAGE (build A) shows and edits the guest's identity, so the embed
// carries the whole structured name and the ID fields — not just the display
// name. id is included because the Guest Details tab writes back to that row.
const DETAIL_SELECT =
  '*, guest:guests(id, first_name, last_name, middle_name, full_name, phone, email, nationality, id_type, id_number, id_expiry), room_type:room_types(name, max_adults, max_children), company:companies(name), booking_nights(stay_date, rate, rate_source)';

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
  // 'HH:MM' as typed by the desk, or null. INFORMATIONAL ONLY (migration 025):
  // it is stored on the booking and read by nothing — not the night audit, not
  // availability, not the no-show guard. A heads-up so a 22:00 arrival is
  // expected instead of chased.
  expectedArrivalTime: string | null;
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
    // 025. The RPC stores it and nothing else; it takes no part in the
    // availability lock, the pricing loop, or the past-date guard.
    p_expected_arrival_time: input.expectedArrivalTime,
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

// The lifecycle transitions the screen exposes (016, extended by 024). Each is a
// distinct RPC because each touches the folio differently; the screen calls them
// by name rather than through a generic setter. There is no confirmBooking:
// create_booking already creates a booking 'confirmed', so enquiry -> confirmed
// is unreachable in 6b.

// Check in, RECORDING THE ARRIVAL (024). arrivalAt is an ISO-8601 instant built
// from the date and time the front desk typed, interpreted in the PROPERTY's
// timezone (see zonedDateTimeToIso) — the RPC derives the arrival's business
// date from that same timezone, and that date is what the night audit bills
// from. Passing null lets the RPC default to now(), which is only correct when
// the desk is checking the guest in as they stand there.
export async function checkInBooking(
  bookingId: string,
  arrivalAt: string | null,
): Promise<Booking> {
  const { data, error } = await supabase.rpc('check_in_booking', {
    p_booking_id: bookingId,
    p_idempotency_key: null,
    p_arrival_at: arrivalAt,
  });
  if (error) throw error;
  return data as Booking;
}

// Mark a confirmed booking whose reserved arrival has passed as a no-show (024).
//
// THE CHARGE IS THE SERVER'S DECISION, NOT THIS FUNCTION'S: mark_no_show posts
// one night at the locked rate for a GUARANTEED booking (a company held the
// room) and posts nothing for a walk-in, in the same transaction as the status
// change. The screen's confirmation step states which outcome applies so the
// user is never surprised, but it does not compute or send an amount — a client
// that could name the charge could name the wrong one.
//
// The charge carries the deterministic 'noshow:<booking>' key server-side, so a
// double-click cannot post two of them; no key is passed from here.
export async function markNoShow(bookingId: string): Promise<Booking> {
  const { data, error } = await supabase.rpc('mark_no_show', {
    p_booking_id: bookingId,
    p_idempotency_key: null,
  });
  if (error) throw error;
  return data as Booking;
}

// CHECKOUT COMPLETES THE BILL (migration 026), so it no longer returns a bare
// booking row: check_out_booking posts every unbilled room night of the stay in
// the same transaction as the status change and returns a SUMMARY of what that
// did to the folio. The desk needs all three facts — what was posted, what was
// already there, and what is now owed — because a guest leaving at 02:00 is
// standing in front of them waiting to settle.
//
// THE NIGHTS CANNOT DOUBLE-POST, and this function passes no key to make that
// true: the server posts each night through post_room_night_charge's
// deterministic 'room:<booking>:<date>' key, the same key run_night_audit uses,
// so whichever of the two reaches a night first wins and the other no-ops. A
// double-clicked checkout is likewise idempotent by state.
export interface CheckOutSummary {
  booking: Booking;
  // True when the booking was ALREADY checked out — a re-run. Nothing was posted
  // and nothing was written; the counts below are a read-only report.
  alreadyCheckedOut: boolean;
  // The date billing ran from: the actual arrival, floored at the reserved
  // check-in (the server's own expression, not recomputed here).
  chargeFrom: string | null;
  nightsTotal: number;
  // Posted BY THIS CHECKOUT — the nights the audit had not reached yet.
  nightsPosted: number;
  // Already on the bill when checkout ran (the audit got there first).
  nightsAlreadyPosted: number;
  // Nights in the billable range carrying NO charge at all. Always 0 after a
  // successful checkout — the server posts every night it counts — so a non-zero
  // value can only come from a re-run of an already-departed stay. Not the voided
  // case: a voided charge keeps its idempotency key and counts as already posted.
  nightsUnbilled: number;
  // What this checkout added to the folio, in money. 0 on a re-run.
  amountPosted: number;
  // The LIVE balance after posting, straight from folio_totals — positive means
  // the guest still owes. null only if the booking somehow has no folio.
  balance: number | null;
}

// numeric values inside a jsonb result arrive as JSON numbers rather than the
// strings a top-level numeric column would give (§6) — parseNumeric accepts both,
// so the parsing is explicit either way and never an implicit coercion.
function toCount(value: unknown): number {
  return parseNumeric(value as string | number | null) ?? 0;
}

export async function checkOutBooking(
  bookingId: string,
): Promise<CheckOutSummary> {
  const { data, error } = await supabase.rpc('check_out_booking', {
    p_booking_id: bookingId,
    p_idempotency_key: null,
  });
  if (error) throw error;

  const row = (data ?? {}) as Record<string, unknown>;
  return {
    booking: row.booking as Booking,
    alreadyCheckedOut: row.already_checked_out === true,
    chargeFrom: (row.charge_from as string | null) ?? null,
    nightsTotal: toCount(row.nights_total),
    nightsPosted: toCount(row.nights_posted),
    nightsAlreadyPosted: toCount(row.nights_already_posted),
    nightsUnbilled: toCount(row.nights_unbilled),
    amountPosted: toCount(row.amount_posted),
    balance: parseNumeric(row.balance as string | number | null),
  };
}
