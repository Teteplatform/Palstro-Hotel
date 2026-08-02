import type { PaymentMethod } from '../types/folio';

// Display labels for the folio's fixed enum values. Generic banking/UI words
// only — nothing tenant-specific ever lives here (rule 17): the hotel's name, its
// currency, its tax names, its charge categories and its discount threshold all
// come from the database. What IS here is the payment-method union, which is
// fixed by a CHECK constraint in record_payment (021 §9.4) — a label list for a
// closed set the DB defines, exactly like bookingLabels.ts does for statuses.

export const PAYMENT_METHODS: readonly PaymentMethod[] = [
  'cash',
  'bank_transfer',
  'pos',
  'company_account',
  'other',
];

export function paymentMethodLabel(method: PaymentMethod | string): string {
  switch (method) {
    case 'cash':
      return 'Cash';
    case 'bank_transfer':
      return 'Bank transfer';
    case 'pos':
      return 'POS / card';
    case 'company_account':
      return 'Company account';
    case 'other':
      return 'Other';
    default:
      return method;
  }
}

// NOTE ON THE BALANCE LABEL, REMOVED IN BUILD A.
//
// This file used to export balanceDirection/balanceLabel, which rendered a
// balance as "Guest owes" / "Settled — nothing outstanding" / "Refund due to
// guest". Build A replaced that with a colour rule and one plain label
// ("Outstanding Balance"), because the words were saying what the figure and its
// colour already said. The rule now lives beside the balance row in FolioBill:
//   > 0  → text-negative (red), money is owed;
//   <= 0 → text-positive (green), nothing is owed.
// The only surviving caption is "refund due" in the bookings list's Balance
// column, where a minus sign in a dense table genuinely needs the words.
