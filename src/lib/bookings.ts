import { supabase } from './supabase';
import { fetchAllPaged } from './fetchAllPaged';
import { parseNumeric } from './format';
import type {
  Booking,
  BookingDetail,
  BookingListRow,
  BookingStatus,
} from '../types/booking';
import type { Reversal } from '../types/folio';

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
  '*, guest:guests(id, first_name, last_name, middle_name, full_name, phone, email, nationality, id_type, id_number, id_expiry, preferences), room_type:room_types(name, max_adults, max_children), company:companies(name), booking_nights(stay_date, rate, rate_source)';

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
// The front-desk follow-up notice (migration 029)
// ---------------------------------------------------------------------------

// One outstanding follow-up: a booking the night audit no-showed and CHARGED to
// a company, which the desk should call about before the room is resold.
export interface BookingFollowUp {
  booking_id: string;
  booking_number: string;
  guest_id: string;
  check_in: string;
  check_out: string;
  note: string;
  company_name: string | null;
  room_type_name: string | null;
}

// PostgREST shape before the to-one embeds are flattened.
interface FollowUpRow {
  id: string;
  booking_number: string;
  guest_id: string;
  check_in: string;
  check_out: string;
  follow_up_note: string;
  company: { name: string } | null;
  room_type: { name: string } | null;
}

// Every OUTSTANDING follow-up at this property, oldest arrival first — optionally
// narrowed to one guest, which is how the guest home shows only theirs.
//
// "Outstanding" is `note is not null AND acknowledged_at is null`, which is
// exactly the predicate migration 029's partial index covers, so this stays a
// tiny read however many bookings the property accumulates.
//
// NOT PAGED, and that is a deliberate reading of rule 1b rather than an
// exception to it: this is not a browse surface, it is a set of alerts that a
// person clears, and it is empty on a healthy property. fetchAllPaged keeps each
// REQUEST bounded (rule 1a) while still returning every row, so nothing is ever
// silently unreachable — if a property somehow accumulated fifty of these, the
// desk sees fifty, which is the point.
export async function fetchOpenFollowUps(
  tenantId: string,
  propertyId: string,
  guestId?: string,
): Promise<BookingFollowUp[]> {
  const rows = await fetchAllPaged<FollowUpRow>((from, to) => {
    let q = supabase
      .from('bookings')
      .select(
        'id, booking_number, guest_id, check_in, check_out, follow_up_note, company:companies(name), room_type:room_types(name)',
      )
      .eq('tenant_id', tenantId) // rule 19
      .eq('property_id', propertyId) // rule 19
      .is('deleted_at', null) // rule 5
      .not('follow_up_note', 'is', null)
      .is('follow_up_acknowledged_at', null);

    if (guestId) q = q.eq('guest_id', guestId);

    return q
      .order('check_in', { ascending: true })
      .order('booking_number', { ascending: true }) // unique → stable paging
      .range(from, to)
      .returns<FollowUpRow[]>();
  });

  return rows.map((r) => ({
    booking_id: r.id,
    booking_number: r.booking_number,
    guest_id: r.guest_id,
    check_in: r.check_in,
    check_out: r.check_out,
    // The stored sentence, printed as-is. It was composed from this booking's own
    // rows at the moment it was raised (029 §4) — never re-rendered here, so the
    // desk reads the notice that was actually given.
    note: r.follow_up_note,
    company_name: r.company?.name ?? null,
    room_type_name: r.room_type?.name ?? null,
  }));
}

// Dismiss one follow-up, recording who and when (029 §3). bookings has no update
// RLS policy, so this goes through the RPC like every other booking mutation.
// Idempotent by state at the database: a second call leaves the FIRST
// acknowledger on the record rather than overwriting them.
export async function acknowledgeBookingFollowUp(
  bookingId: string,
): Promise<Booking> {
  const { data, error } = await supabase.rpc('acknowledge_booking_follow_up', {
    p_booking_id: bookingId,
    p_idempotency_key: null,
  });
  if (error) throw error;
  return data as Booking;
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

// ---------------------------------------------------------------------------
// Status reversal (migration 033) — the accountable un-doing of a no-show or a
// cancellation
// ---------------------------------------------------------------------------
//
// PARTS 1 AND 2 REVERSED MONEY; THIS PART REVERSES A STATUS, and a status is
// what holds a room. So the guard that matters here is not the PIN (inherited,
// always required, no threshold) but THE AVAILABILITY RE-CHECK:
//
//   A cancel FREED the room (015 RULE 4) and a no-show freed it too (029 §2), so
//   between the act and its reversal ANOTHER BOOKING MAY HOLD THAT ROOM. Both
//   RPCs therefore lock the room_types row and count availability under that
//   lock for EVERY night of the stay — the same discipline create_booking uses —
//   and REJECT, naming the nights that are full, rather than overbooking.
//
// THE REJECTION MUST REACH THE DESK VERBATIM. It names the dates and how many of
// the stay's nights are gone, and its hint says what to do instead; that is the
// whole value of it. Callers surface it with folioErrorMessage (lib/folio),
// which prefers the server's own message and appends its hint — never
// humanizeError, which would replace the PIN rejection (42501) with soft copy
// and drop the hint from the availability rejection.
//
// NEITHER TOUCHES MONEY BY ITSELF. reverse_cancel posts nothing at all (a
// cancelled booking had no room charges, and a deposit stays exactly where it
// is). reverse_no_show credits back the retention night — if one was posted —
// by calling reverse_charge on it, so the counter-entry, its tax and its audit
// row all flow through the engine parts 1 and 2 built.

export interface ReverseBookingStatusInput {
  bookingId: string;
  reason: string;
  // ALWAYS required, with no threshold: restoring a booking re-takes a room the
  // hotel may have re-sold and un-bills a night already invoiced. Never stored,
  // never logged, never put in an error message, and cleared from component
  // state the moment the call returns.
  managerPin: string;
  idempotencyKey: string;
}

// Reverse a no-show: the booking returns to CONFIRMED (never straight to
// checked_in — the desk runs the ordinary check-in so the arrival instant is
// captured) and any retention charge is credited back in the same transaction.
// Returns the permanent `reversals` audit row.
export async function reverseNoShow(
  input: ReverseBookingStatusInput,
): Promise<Reversal> {
  const { data, error } = await supabase.rpc('reverse_no_show', {
    p_booking_id: input.bookingId,
    p_reason: input.reason,
    p_manager_pin: input.managerPin,
    p_idempotency_key: input.idempotencyKey,
  });
  if (error) throw error;
  return data as Reversal;
}

// Reverse a cancellation: the booking returns to CONFIRMED, but only if every
// night is still available. Returns the permanent `reversals` audit row.
//
// IDEMPOTENT BY KEY AND BY STATE, under a FOR UPDATE lock on the booking. One
// case is deliberately NOT idempotent and it is worth knowing about: a booking
// that was restored and then CANCELLED AGAIN is refused rather than reported
// restored — a cancellation is reversed once, ever (reversals_target_uniq), and
// silently returning the first reversal would tell the desk a guest had a room
// when they do not.
export async function reverseCancel(
  input: ReverseBookingStatusInput,
): Promise<Reversal> {
  const { data, error } = await supabase.rpc('reverse_cancel', {
    p_booking_id: input.bookingId,
    p_reason: input.reason,
    p_manager_pin: input.managerPin,
    p_idempotency_key: input.idempotencyKey,
  });
  if (error) throw error;
  return data as Reversal;
}

// ---------------------------------------------------------------------------
// Checkout reversal (migration 034) — reopening a stay the guest has not left
// ---------------------------------------------------------------------------
//
// WHAT IT MEANS, and it is narrower than the other two status reversals: THE
// GUEST HAS NOT ACTUALLY LEFT. A checkout keyed at 09:00 for a guest who is
// still at breakfast and staying another night; a departure recorded on the
// wrong booking of a group. The stay reopens — status back to checked_in, and
// the folio back to open if anything had closed it — so charges and payments can
// be posted against it again.
//
// THE ROOM CHARGES STAY, and that is the decision the whole act turns on. Those
// nights were slept; reopening the stay says the guest has not gone, not that
// they were never here. A night that genuinely has to come off the bill is a
// separate reverse_charge on the folio, with its own PIN, reason and audit row.
//
// NO AVAILABILITY RE-CHECK, unlike un-cancel and un-no-show — and that is a
// verified property of count_available, not an optimisation: 'checked_in' and
// 'checked_out' are BOTH in its occupancy list (029 §2), so a checked-out stay
// still holds its room and this transition frees and re-takes nothing. There is
// no night on which reopening can overbook.
//
// THE ARRIVAL IS NOT RE-STAMPED. checked_in_at / actual_check_in still record
// the real arrival, so the nights the folio bills are exactly the nights it
// billed before — reopening never re-prices a stay.
//
// AFTERWARDS the desk checks the guest out again in the ordinary way when they
// really do leave. check_out_booking posts each night under the deterministic
// 'room:<booking>:<date>' key, so every night already on the bill no-ops and
// only nights the stay genuinely gained (an extended check_out) post.

// Reverse a checkout: the stay returns to CHECKED-IN and its folio is reopened.
// Returns the permanent `reversals` audit row.
//
// IDEMPOTENT BY KEY AND BY STATE, under a FOR UPDATE lock on the booking. One
// case is deliberately NOT idempotent, and here it is the ORDINARY ending rather
// than an edge case: a stay that was reopened and then CHECKED OUT AGAIN is
// refused rather than reported reopened — a checkout is reversed once, ever
// (reversals_target_uniq), and silently returning the first reversal would tell
// the desk a departed guest was back in the room.
export async function reverseCheckout(
  input: ReverseBookingStatusInput,
): Promise<Reversal> {
  const { data, error } = await supabase.rpc('reverse_checkout', {
    p_booking_id: input.bookingId,
    p_reason: input.reason,
    p_manager_pin: input.managerPin,
    p_idempotency_key: input.idempotencyKey,
  });
  if (error) throw error;
  return data as Reversal;
}

// The status reversals recorded against ONE booking, if any: at most one of
// each kind, because reversals_target_uniq allows exactly one reversal per
// (tenant, target_type, target) forever.
//
// Three fields rather than one row, because a booking can carry ALL of them over
// its life — no-showed and restored in August, cancelled and restored in
// September, checked out prematurely and reopened in October — and a single "the
// reversal" would silently drop the others.
export interface BookingStatusReversals {
  noShow: Reversal | null;
  cancel: Reversal | null;
  checkout: Reversal | null;
}

// Read them for the screens that must say a restored booking WAS restored, by
// whom and why. The `reversals` table is member-readable and writable by nobody
// (031 §5), so this is the only place that history lives — the booking row
// itself carries no "restored" column, deliberately: a reversal is a fact about
// an act, not a flag on a record.
//
// Rule 19: scoped to the active tenant and property on top of RLS. Bounded by
// construction — one booking has at most three of these rows — so no pager.
export async function fetchBookingStatusReversals(
  bookingId: string,
  tenantId: string,
  propertyId: string,
): Promise<BookingStatusReversals> {
  const { data, error } = await supabase
    .from('reversals')
    .select('*')
    .eq('tenant_id', tenantId) // rule 19
    .eq('property_id', propertyId) // rule 19
    .eq('target_id', bookingId)
    .in('target_type', ['no_show', 'cancel', 'checkout'])
    .order('reversed_at', { ascending: true });

  if (error) throw error;

  const rows = (data ?? []) as Reversal[];
  return {
    noShow: rows.find((r) => r.target_type === 'no_show') ?? null,
    cancel: rows.find((r) => r.target_type === 'cancel') ?? null,
    checkout: rows.find((r) => r.target_type === 'checkout') ?? null,
  };
}
