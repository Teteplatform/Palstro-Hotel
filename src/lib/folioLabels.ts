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

// How a balance READS to a human, which is the whole point of §1's instruction
// not to show a bare negative.
//
// The engine deliberately does NOT floor the balance at zero (021 §8.3): a
// negative balance is real money the hotel owes back — an over-payment, or a
// deposit taken before any charge has posted — and hiding it would hide a
// liability. But "-₦50,000.00" at a front desk is read as a mistake, or worse, as
// something owed. So the SIGN carries the meaning and the LABEL states it:
//   > 0  the guest owes the hotel
//   = 0  settled
//   < 0  the hotel owes the guest (a refund is due), shown as a positive amount
//        under an explicit "Refund due" label — never as a bare minus.
export type BalanceDirection = 'owing' | 'settled' | 'refund_due';

export function balanceDirection(balance: number): BalanceDirection {
  if (balance > 0) return 'owing';
  if (balance < 0) return 'refund_due';
  return 'settled';
}

export function balanceLabel(direction: BalanceDirection): string {
  switch (direction) {
    case 'owing':
      return 'Guest owes';
    case 'refund_due':
      return 'Refund due to guest';
    case 'settled':
      return 'Settled — nothing outstanding';
  }
}
