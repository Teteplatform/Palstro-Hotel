// DB row types for bookings + booking_nights (supabase/migrations/015_bookings.sql).
// Keep in sync with the migration.
//
// A booking is a reservation of nights for a room TYPE, created ONLY through the
// create_booking RPC (never a direct insert — that would bypass the overbooking
// guard). Its total is the sum of its LOCKED booking_nights, never a recompute.

export type BookingStatus =
  | 'enquiry'
  | 'confirmed'
  | 'checked_in'
  | 'checked_out'
  | 'cancelled'
  | 'no_show';

export type BillTo = 'guest' | 'company';

// rate_source explains WHY a night cost what it did. Rack-side values come from
// 012/015; the company-deal values come from 016's resolve_booking_rate_detail.
export type RateSource =
  | 'rack'
  | 'weekend'
  | 'seasonal'
  | 'company_fixed'
  | 'company_percentage';

export interface Booking {
  id: string;
  tenant_id: string;
  property_id: string;
  room_type_id: string;
  guest_id: string;
  booking_number: string;
  // sql `date` columns arrive as 'YYYY-MM-DD' strings.
  check_in: string;
  check_out: string;
  adults: number;
  children: number;
  status: BookingStatus;
  company_id: string | null;
  bill_to: BillTo;
  special_requests: string | null;
  cancelled_at: string | null;
  cancellation_reason: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
}

export interface BookingNight {
  id: string;
  tenant_id: string;
  property_id: string;
  booking_id: string;
  stay_date: string;
  // numeric(14,2) -> STRING from PostgREST (§6); parse before arithmetic.
  rate: string;
  rate_source: RateSource | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
}

// A booking as it appears in the LIST: the row plus the to-one embeds the list
// renders (guest, room type, company) and the locked night rates it sums into a
// total. The embeds are typed as single objects (PostgREST types a to-one embed
// as an array it can't prove singular; we override the row type at the query —
// see lib/bookings.ts — exactly as useTenantContext does).
export interface BookingListRow extends Booking {
  guest: { full_name: string; phone: string | null } | null;
  room_type: { name: string } | null;
  company: { name: string } | null;
  // Only the rate is selected — the list sums these for the per-booking total.
  booking_nights: { rate: string }[];
  // The booking's LIVE folio balance, attached by fetchBookingsPage from the
  // booking_balances view (022) in ONE extra query for the whole page — never a
  // folio_balance() call per row. numeric(14,2) -> STRING (§6); parse before any
  // arithmetic or comparison. Positive = the guest owes; negative = a refund is
  // due. null only if the view returned no row for this booking, which should be
  // impossible (every booking has a folio) and is shown as a dash rather than as
  // a confident zero.
  balance: string | null;
}

// A booking's full detail: the row, its embeds, and every night ordered by date
// with its locked rate + source (the per-night breakdown the manage view shows).
export interface BookingDetail extends Booking {
  guest: {
    full_name: string;
    phone: string | null;
    email: string | null;
  } | null;
  room_type: { name: string; max_adults: number; max_children: number } | null;
  company: { name: string } | null;
  booking_nights: {
    stay_date: string;
    rate: string;
    rate_source: RateSource | null;
  }[];
}
