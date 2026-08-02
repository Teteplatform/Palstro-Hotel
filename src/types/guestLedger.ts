// Row types for the guest-level read views
// (supabase/migrations/028_guest_home_and_standalone_folio.sql, which replaces
// 027's two views). Keep in sync with the migration.
//
// THESE ARE AGGREGATIONS, NOT A SECOND LEDGER. Every money figure below is
// produced by folio_totals (021 §8.2) over the underlying folios; the views add
// only three things, all computed on every read and none stored:
//   * the cross-account RUNNING BALANCE (guest_ledger.running_balance),
//   * the FIFO SETTLEMENT of the guest's payment pool, oldest item first
//     (allocated_amount / settlement_status), and
//   * the NIGHTS a stay is displayed with (see below).
//
// THE RECONCILES-TO INVARIANT (rule 9), stated once and depended on everywhere:
//   GuestAccountSummary.guest_balance
//     === the last GuestLedgerEntry.running_balance
//     === Σ folio_totals(f).balance over ALL of the guest's folios at this
//         property (their stays' folios AND their standalone folio).
// FIFO redistributes the same pool between items; it cannot change the total. So
// an old stay may read "settled" while its own folio still shows a balance (the
// money that settled it was taken later, or on the standalone folio) — and the
// surfaces still agree to the kobo about what the guest owes.
//
// NIGHTS: RESERVED vs ACTUAL vs DISPLAY (2.txt PART 1).
//   reserved_nights = check_out − check_in — what was BOOKED.
//   actual_nights   = check_out − charge_from — what the folio BILLS. NULL until
//                     the guest is checked in, because before that the arrival
//                     has not happened and a guessed number is worse than an
//                     honest absence.
//   display_nights  = coalesce(actual, reserved) — what a screen PRINTS.
// charge_from is greatest(coalesce(actual_check_in, check_in), check_in),
// COPIED from run_night_audit (024 §3) and check_out_booking (026 §1), so the
// nights shown are exactly the nights charged.
//
// MONEY IS A STRING. Every numeric(14,2) column arrives from PostgREST as a
// string (§6). Parse with parseNumeric before ANY arithmetic or comparison.

import type { BookingStatus } from './booking';
import type { FolioStatus, PaymentMethod } from './folio';

// How much of the guest's payment pool this item has absorbed under FIFO.
//   'nil'       — nothing billed on it yet (a future or cancelled stay).
//   'settled'   — the pool covers it in full.
//   'part_paid' — the pool reached it but ran out inside it.
//   'unpaid'    — the pool was exhausted by older items.
export type StaySettlementStatus = 'nil' | 'settled' | 'part_paid' | 'unpaid';

// One row of guest_stays: a stay, its OWN folio totals, its nights, and the
// guest-level FIFO settlement — plus the working, so the allocation and the
// night count can both be checked by hand from the row itself.
export interface GuestStayRow {
  booking_id: string;
  guest_id: string;
  tenant_id: string;
  property_id: string;
  booking_number: string;
  check_in: string;                 // 'YYYY-MM-DD' — RESERVED arrival
  check_out: string;
  // When the guest PHYSICALLY arrived (024). NULL until checked in.
  actual_check_in: string | null;
  // The date the folio bills from — the server's own expression, exposed so the
  // nights arithmetic is checkable rather than trusted.
  charge_from: string;
  reserved_nights: number;
  // NULL until checked in — see the header. Integers arrive as JS numbers.
  actual_nights: number | null;
  // What every screen prints: actual once arrived, reserved while confirmed.
  display_nights: number;
  status: BookingStatus;
  room_type_id: string;
  // NULL only if the room type row is gone entirely; a soft-deleted type still
  // names its stays (021 §8.1's inverted rule).
  room_type_name: string | null;
  folio_id: string;
  folio_status: FolioStatus;

  // --- this stay's OWN folio (identical to the booking's own bill) -----------
  charges_total: string;
  payments_total: string;
  // What the stays table's Balance column prints. Positive = owed on this stay.
  balance: string;

  // --- the guest-level working (exposed so the allocation is checkable) ------
  guest_charges_total: string;      // Σ charges across stays AND standalone items
  guest_payments_pool: string;      // Σ non-voided payments across ALL their folios
  charges_before: string;           // Σ charges of every OLDER item — the frontier

  // --- the FIFO result ------------------------------------------------------
  allocated_amount: string;         // clamp(pool − charges_before, 0, charges_total)
  unallocated_amount: string;
  settlement_status: StaySettlementStatus;
}

// A ledger line is one of four things: a stay collapsed to its charges, a
// standalone charge, a payment on a stay's folio, or a standalone payment.
export type GuestLedgerEntryType =
  | 'stay'
  | 'standalone_charge'
  | 'payment'
  | 'standalone_payment';

// One row of guest_ledger, in business-date order with its running balance
// already computed by the database.
export interface GuestLedgerEntry {
  guest_id: string;
  tenant_id: string;
  property_id: string;
  // The BUSINESS date (rules 8, 12): a stay line is dated by check_in, a
  // standalone charge by its charge_date, a payment by its payment_date.
  entry_date: string;
  // 0 for a charge-side line, 1 for a payment — the same-day ordering the view
  // sorts by.
  entry_rank: number;
  entry_created_at: string;
  // The row's own id (booking / charge / payment). The TOTAL tiebreak the view's
  // window orders by — a caller MUST order by it or the running balance column
  // will not add up.
  entry_key: string;
  entry_type: GuestLedgerEntryType;
  // True on the two standalone kinds. A standalone line has no stay to drill
  // into, which is exactly what this flag lets the screen respect.
  is_standalone: boolean;
  // NULL on a standalone line — there is no booking.
  booking_id: string | null;
  payment_id: string | null;
  charge_id: string | null;
  booking_number: string | null;
  booking_status: BookingStatus | null;
  room_type_name: string | null;
  // Standalone charge lines only: the tenant's own name for the charge category,
  // and the required explanation note the desk typed.
  charge_type_name: string | null;
  charge_description: string | null;
  // Stay lines only.
  reserved_nights: number | null;
  actual_nights: number | null;
  display_nights: number | null;
  charge_amount: string;            // stay lines: the stay's charges_total
  payment_amount: string;           // payment lines: the SIGNED amount
  payment_method: PaymentMethod | null;
  payment_reference: string | null;
  received_by: string | null;
  // Cumulative charge_amount − payment_amount to and including this line. The
  // LAST row's value is the guest's balance (see the invariant).
  running_balance: string;
}

// One row of guest_account_summary — the guest home's six tiles. EVERY figure
// spans all of the guest's stays and standalone items at this property, computed
// server-side, never the visible page (rule 20).
//
// Money arrives as strings (§6); the hook parses them once, at the edge.
export interface GuestAccountSummaryRow {
  tenant_id: string;
  property_id: string;
  guest_id: string;
  stay_count: number;
  standalone_count: number;
  // Σ display_nights over their stays — actual once arrived, reserved before.
  total_nights: number;
  first_stay: string | null;        // "with us since"
  last_stay: string | null;
  total_charged: string;
  total_paid: string;
  guest_balance: string;            // charged − paid; the reconciles-to figure
  outstanding: string;              // greatest(0, guest_balance)
  credit_balance: string;           // greatest(0, −guest_balance)
}

// The parsed form the tiles render from.
export interface GuestAccountSummary {
  stayCount: number;
  standaloneCount: number;
  firstStay: string | null;
  lastStay: string | null;
  totalNights: number;
  totalCharged: number;
  totalPaid: number;
  // charged − paid. Positive = the guest owes; negative = the hotel holds their
  // money. outstanding and creditBalance are its two sides and are never both
  // non-zero — at GUEST level the account has one balance, which is what the
  // statement's foot prints.
  guestBalance: number;
  outstanding: number;
  creditBalance: number;
}
