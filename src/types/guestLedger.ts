// Row types for the two guest-level read views
// (supabase/migrations/027_guest_ledger.sql). Keep in sync with the migration.
//
// THESE ARE AGGREGATIONS, NOT A SECOND LEDGER. Every money figure below is
// produced by folio_totals (021 §8.2) over the stays' own folios; the views add
// only two things, both computed on every read and neither stored:
//   * the cross-stay RUNNING BALANCE (guest_ledger.running_balance), and
//   * the FIFO SETTLEMENT of the guest's payment pool, oldest stay first
//     (guest_stays.allocated_amount / settlement_status).
//
// THE RECONCILES-TO INVARIANT (rule 9), stated once and depended on everywhere:
//   Σ GuestStayRow.balance  ===  the last GuestLedgerEntry.running_balance
//                           ===  the guest's outstanding balance.
// FIFO redistributes the same pool between stays; it cannot change the total. So
// a stay may read "settled" here while its own folio still shows a balance (the
// money that settled it was taken against a later stay) — and the two surfaces
// still agree to the kobo about what the guest owes.
//
// MONEY IS A STRING. Every numeric(14,2) column arrives from PostgREST as a
// string (§6). Parse with parseNumeric before ANY arithmetic or comparison.

import type { BookingStatus } from './booking';
import type { FolioStatus, PaymentMethod } from './folio';

// How much of the guest's payment pool this stay has absorbed under FIFO.
//   'nil'       — nothing billed on this stay yet (a future or cancelled stay).
//   'settled'   — the pool covers this stay in full.
//   'part_paid' — the pool reached this stay but ran out inside it.
//   'unpaid'    — the pool was exhausted by older stays.
export type StaySettlementStatus = 'nil' | 'settled' | 'part_paid' | 'unpaid';

// One row of guest_stays: a stay, its OWN folio totals, and the guest-level FIFO
// settlement of it — plus the working, so the allocation can be checked by hand.
export interface GuestStayRow {
  booking_id: string;
  guest_id: string;
  tenant_id: string;
  property_id: string;
  booking_number: string;
  check_in: string;                 // 'YYYY-MM-DD'
  check_out: string;
  // check_out − check_in: the RESERVED nights, matching what the stays table and
  // the booking list call a stay's length. Integers arrive as JS numbers.
  nights: number;
  status: BookingStatus;
  room_type_id: string;
  // NULL only if the room type row is gone entirely; a soft-deleted type still
  // names its stays (027 §3, the inverted rule from 021 §8.1).
  room_type_name: string | null;
  folio_id: string;
  folio_status: FolioStatus;

  // --- this stay's OWN folio (identical to the booking's Folio tab) ----------
  charges_total: string;
  payments_total: string;
  // What the stays table's Balance column prints. Positive = owed on this stay.
  balance: string;

  // --- the guest-level working (exposed so the allocation is checkable) ------
  guest_charges_total: string;      // Σ charges across all this guest's stays
  guest_payments_pool: string;      // Σ non-voided payments across all of them
  charges_before: string;           // Σ charges of every OLDER stay — the frontier

  // --- the FIFO result ------------------------------------------------------
  // clamp(pool − charges_before, 0, charges_total).
  allocated_amount: string;
  unallocated_amount: string;       // charges_total − allocated_amount
  settlement_status: StaySettlementStatus;
}

// A ledger line is either a whole STAY collapsed to its charges, or one payment.
export type GuestLedgerEntryType = 'stay' | 'payment';

// One row of guest_ledger, in business-date order with its running balance
// already computed by the database.
export interface GuestLedgerEntry {
  guest_id: string;
  tenant_id: string;
  property_id: string;
  // The BUSINESS date (rules 8, 12): a stay line is dated by check_in, a payment
  // line by payment_date.
  entry_date: string;
  // 0 for a stay, 1 for a payment — the same-day ordering the view sorts by.
  entry_rank: number;
  entry_created_at: string;
  entry_type: GuestLedgerEntryType;
  // Always present: a payment line carries the stay it was taken against, which
  // is what makes "paid on stay 3, settled stay 1" auditable.
  booking_id: string;
  payment_id: string | null;
  booking_number: string;
  booking_status: BookingStatus;
  room_type_name: string | null;
  nights: number | null;            // stay lines only
  charge_amount: string;            // stay lines carry the stay's charges_total
  payment_amount: string;           // payment lines carry the SIGNED amount
  payment_method: PaymentMethod | null;
  payment_reference: string | null;
  received_by: string | null;
  // Cumulative charge_amount − payment_amount to and including this line. The
  // LAST row's value is the guest's outstanding balance (see the invariant).
  running_balance: string;
}

// The history strip above the stays table. Every figure spans ALL of the guest's
// stays at this property, never the visible page (rule 20).
export interface GuestHistorySummary {
  stayCount: number;
  // Earliest check_in across their stays — "with us since". null when they have
  // no stays at this property yet.
  firstStay: string | null;
  lastStay: string | null;
  totalNights: number;
  // Σ charges_total: what the guest has been BILLED across every stay.
  totalCharged: number;
  // Σ payments_total: what they have actually PAID (net of refunds).
  totalPaid: number;
  // What is still owed: Σ balance, i.e. totalCharged − totalPaid when positive.
  // Kept apart from creditBalance rather than netted, for the same reason the
  // bookings summary keeps outstanding and refunds-due apart — a guest owed
  // money and owing money is not "settled".
  outstanding: number;
  // The mirror: unapplied credit (deposits / over-payments) as a positive number.
  creditBalance: number;
}
