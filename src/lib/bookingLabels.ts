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
