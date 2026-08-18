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
  // ACTUAL ARRIVAL (migration 024). checked_in_at is the instant the guest
  // physically arrived — a timestamptz, so an ISO-8601 string; actual_check_in
  // is that instant's date in the PROPERTY's timezone ('YYYY-MM-DD'), and it is
  // what the night audit charges from. Both null until the booking is checked
  // in. Distinct from check_in, which is what was RESERVED: a guest who books
  // the 30th and arrives on the 1st has both, and they disagree legitimately.
  checked_in_at: string | null;
  actual_check_in: string | null;
  // EXPECTED ARRIVAL TIME (migration 025). A bare `time` — PostgREST returns
  // 'HH:MM:SS' — noted at booking when the guest says roughly when they will
  // reach the desk ("arriving ~22:00"). PURELY INFORMATIONAL: nothing reads it.
  // It does not affect charging, availability, or the no-show guard; it exists
  // so a late arrival is expected rather than mistaken for one. Distinct from
  // checked_in_at, which is the arrival that actually HAPPENED.
  expected_arrival_time: string | null;
  company_id: string | null;
  bill_to: BillTo;
  special_requests: string | null;
  cancelled_at: string | null;
  cancellation_reason: string | null;
  // THE FRONT-DESK FOLLOW-UP (migration 029). Raised automatically when the
  // night audit no-showed and CHARGED a corporate booking, because releasing a
  // room a company held — and has just been billed for — without a phone call is
  // how a corporate account is lost. A REMINDER ONLY: the room is already free
  // (029 §2 makes count_available release a no_show) and this blocks nothing.
  // The note is a rendered sentence stored at the moment it was raised, so it
  // records what was true THEN rather than a reconstruction from today's rows.
  // acknowledged_at NULL = still outstanding, which is what the notice filters on.
  follow_up_note: string | null;
  follow_up_acknowledged_at: string | null;
  follow_up_acknowledged_by: string | null;
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
  // numeric(14,2), parsed at the boundary (rule 24).
  rate: number;
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
  // Parsed with the row (rule 24): an embed is part of the read, so it crosses
  // the boundary with everything else.
  booking_nights: { rate: number }[];
  // The booking's LIVE folio balance, attached by fetchBookingsPage from the
  // booking_balances view (022) in ONE extra query for the whole page — never a
  // folio_balance() call per row. numeric(14,2), parsed at the boundary (rule
  // 24). Positive = the guest owes; negative = a refund is due. null only if the
  // view returned no row for this booking, which should be impossible (every
  // booking has a folio) and is shown as a dash rather than as a confident zero.
  balance: number | null;
}

// A booking's full detail: the row, its embeds, and every night ordered by date
// with its locked rate + source (the per-night breakdown the manage view shows).
export interface BookingDetail extends Booking {
  // The guest as the detail PAGE needs them (build A §2): the structured name and
  // the ID fields, editable in the Guest Details tab, plus the generated
  // full_name for display. `id` is here because the tab writes back to that row.
  guest: {
    id: string;
    first_name: string;
    last_name: string;
    middle_name: string | null;
    full_name: string;
    phone: string | null;
    email: string | null;
    nationality: string | null;
    id_type: string | null;
    id_number: string | null;
    id_expiry: string | null;
    // Stay preferences (027). Editable here as well as on the guest's own page —
    // both write through updateGuest, the same admin-gated correction path.
    preferences: string | null;
  } | null;
  room_type: { name: string; max_adults: number; max_children: number } | null;
  company: { name: string } | null;
  booking_nights: {
    stay_date: string;
    rate: number;
    rate_source: RateSource | null;
  }[];
}
