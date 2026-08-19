import type { BookingStatus, RateSource } from '../types/booking';

// Generic UI copy for booking enums — no tenant content (rule 17), just the
// human labels for the DB's status / rate_source values, defined once so every
// screen reads them identically. Kept out of format.ts (presentation numbers)
// because these are domain vocabulary, not number formatting.

const STATUS_LABELS: Record<BookingStatus, string> = {
  enquiry: 'Enquiry',
  confirmed: 'Confirmed',
  checked_in: 'Checked in',
  checked_out: 'Checked out',
  cancelled: 'Cancelled',
  no_show: 'No-show',
};

// ---------------------------------------------------------------------------
// THE ⓘ PANELS (rule 25)
// ---------------------------------------------------------------------------
// What the bookings screens used to say above their controls. The screens keep
// one line of purpose each; this is the rest of it, behind one icon per screen
// and in docs/USER-GUIDE.md, which each panel links to.

export const BOOKINGS_ABOUT_TITLE = 'About the bookings list';

export const BOOKINGS_ABOUT: string[] = [
  'Every reservation for this property, newest arrival first. A booking moves ' +
    'through its life here — confirmed, checked in, checked out, cancelled or ' +
    'no-showed — and each of those is a recorded act with a name against it, ' +
    'not a field somebody edits.',
  'The value column is the sum of the nightly rates LOCKED onto the booking ' +
    'when it was taken, so a later price change never rewrites what a past stay ' +
    'was worth. The balance beside it is the live folio balance: red means the ' +
    'guest owes, green means nothing is owed or the hotel is holding their money.',
  'The figures above the list cover every booking matching your filters, across ' +
    'all pages — never just the rows on screen.',
];

export const NEW_BOOKING_ABOUT_TITLE = 'About taking a booking';

export const NEW_BOOKING_ABOUT: string[] = [
  'The price updates as you go, and every night is quoted separately: a weekend ' +
    'night, a seasonal rate and a company rate can all appear in one stay. What ' +
    'you see quoted is what is locked onto the booking when you confirm it.',
  'Choosing a company switches pricing to its negotiated rate and bills the ' +
    'folio to that company rather than to the guest.',
  'An unfinished booking is kept if you step away — come back to New booking ' +
    'and it is where you left it, including the guest you had picked.',
];

export const STAY_ABOUT_TITLE = 'About this stay';

export const STAY_ABOUT: string[] = [
  'Reserved nights are what was booked; billed nights run from the guest’s ' +
    'ACTUAL arrival. A guest who books the 30th and walks in on the 1st is ' +
    'charged from the 1st, and both dates stay on the record because they ' +
    'legitimately disagree.',
  'Arrival time defaults to now. Change it if the guest arrived earlier — a ' +
    '2 a.m. arrival is routinely keyed the next morning, and this is the date ' +
    'the room nights are charged from. The reserved check-in date is left ' +
    'untouched either way.',
  'Room nights are posted to the folio automatically at checkout, so anything ' +
    'else the guest owes — food, laundry, the minibar — has to be on the bill ' +
    'before then. It cannot be added afterwards.',
];

export function bookingStatusLabel(status: BookingStatus): string {
  return STATUS_LABELS[status] ?? status;
}

// The statuses a filter/summary offers, in lifecycle order.
export const BOOKING_STATUSES: BookingStatus[] = [
  'enquiry',
  'confirmed',
  'checked_in',
  'checked_out',
  'cancelled',
  'no_show',
];

// A tone token per status so chips/badges read consistently. Maps to the design
// tokens already in index.css; kept generic (no literal hex — rule 17 / §8).
export function bookingStatusTone(status: BookingStatus): string {
  switch (status) {
    case 'confirmed':
      return 'bg-primary/10 text-primary';
    case 'checked_in':
      return 'bg-accent/15 text-accent';
    case 'checked_out':
      return 'bg-sand text-charcoal-muted';
    case 'cancelled':
      return 'bg-charcoal/10 text-charcoal-muted';
    case 'no_show':
      return 'bg-charcoal/10 text-charcoal-muted';
    case 'enquiry':
    default:
      return 'bg-sand text-charcoal';
  }
}

// Why a night cost what it did (booking_nights.rate_source). Rack-side sources
// come from 012/015; the company-deal sources from 016.
const RATE_SOURCE_LABELS: Record<RateSource, string> = {
  rack: 'Rack rate',
  weekend: 'Weekend rate',
  seasonal: 'Seasonal rate',
  company_fixed: 'Company fixed rate',
  company_percentage: 'Company discount',
};

export function rateSourceLabel(source: RateSource | null): string | null {
  if (source === null) return null;
  return RATE_SOURCE_LABELS[source] ?? source;
}

// "3 nights" / "1 night".
export function formatNights(count: number): string {
  return `${count} ${count === 1 ? 'night' : 'nights'}`;
}
