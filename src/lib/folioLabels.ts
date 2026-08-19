import type { PaymentMethod } from '../types/folio';

// Display labels for the folio's fixed enum values. Generic banking/UI words
// only — nothing tenant-specific ever lives here (rule 17): the hotel's name, its
// currency, its tax names, its charge categories and its discount threshold all
// come from the database. What IS here is the payment-method union, which is
// fixed by a CHECK constraint in record_payment (021 §9.4) — a label list for a
// closed set the DB defines, exactly like bookingLabels.ts does for statuses.

// ---------------------------------------------------------------------------
// THE ⓘ PANELS (rule 25)
// ---------------------------------------------------------------------------
// The folio's forms used to teach inside themselves: what a void does to a bill,
// when to reverse instead, what stays on the record. Every one of those is a
// GENERAL fact about the system, and the folio is where somebody is trying to
// take ₦40,000 off a guest before they leave.
//
// So the general half moved here and into docs/USER-GUIDE.md. What stayed on the
// forms is the SPECIFIC half — what this act will do to THIS bill, with the real
// figures in it — because that is the thing the person is deciding about, and
// hiding it behind an icon at the moment of an irreversible action would be the
// opposite of the point.

export const FOLIO_ABOUT_TITLE = 'About the folio';

export const FOLIO_ABOUT: string[] = [
  'The guest’s running account for this stay: what they have been charged, what ' +
    'they have paid, and what is left. Room nights arrive automatically; food, ' +
    'laundry and extras are posted here as they happen.',
  'Nothing on a folio is ever deleted. A mistake caught now is VOIDED — the line ' +
    'stays on the bill, marked, and drops out of the totals. Something real that ' +
    'has to be undone is REVERSED — a matching counter-entry is posted beside it ' +
    'with a manager’s approval, and both lines stay on the record forever.',
  'The balance is never stored. It is recomputed from the live charges, their ' +
    'tax and the payments every time this panel loads, so it cannot drift away ' +
    'from the lines it is made of.',
];

export const VOID_ABOUT_TITLE = 'Void, or reverse?';

export const VOID_ABOUT: string[] = [
  'VOID is for a mistake caught now — mistyped, wrong folio, a transfer that ' +
    'never cleared. The line stays on the bill marked as voided and stops ' +
    'counting. It is never deleted.',
  'REVERSE is for something that was real and was relied upon: a receipt issued, ' +
    'a statement sent, a balance quoted, money going back. It posts a visible ' +
    'counter-entry that a manager approves, and leaves both lines on the record.',
  'If you are not sure which you need, that usually means reverse: it is the one ' +
    'that leaves a reader able to see what happened.',
];

export const PAYMENT_ABOUT_TITLE = 'About taking money';

export const PAYMENT_ABOUT: string[] = [
  'The amount starts EMPTY on purpose, and is never pre-filled with the balance ' +
    'due. A figure already in the box gets accepted without being read, and a ' +
    'payment recorded for money that never arrived is worse than no record at all.',
  'The amount is signed by what you are doing: a payment or a deposit goes in, a ' +
    'refund goes out. Both land on the same bill, so the account reads as one ' +
    'story rather than two lists.',
  'A payment is dated by the day it was TAKEN, which may not be today — the ' +
    'business date is what every report and statement groups by.',
];

export const CHARGE_ABOUT_TITLE = 'About charges';

export const CHARGE_ABOUT: string[] = [
  'This is for extras signed to the room — food and beverage, laundry, ' +
    'internet, transport. Room nights are posted automatically at the night ' +
    'audit and are never added here.',
  'Tax is worked out by the hotel’s own rules from the charge’s category, and ' +
    'is shown on the bill under the line it belongs to. The estimate on this ' +
    'form is exactly that until the charge is posted.',
  'A charge is dated by the day it HAPPENED, which may not be today. Everything ' +
    'downstream — the bill, the statement, the night’s takings — groups by that ' +
    'date.',
];

export const STANDALONE_CHARGE_ABOUT_TITLE = 'About charges outside a stay';

export const STANDALONE_CHARGE_ABOUT: string[] = [
  'A standalone charge belongs to the GUEST rather than to a stay: a ' +
    'non-resident bar tab, a hall hire, a late charge after departure. It ' +
    'appears on their ledger as its own line and counts towards their ' +
    'outstanding balance.',
  'Because there is no stay to explain it, the description is required — a ' +
    'charge tied to nothing is unexplainable a month later, and this is what ' +
    'prints on the guest’s statement.',
];

export const STANDALONE_PAYMENT_ABOUT_TITLE = 'About payments outside a stay';

export const STANDALONE_PAYMENT_ABOUT: string[] = [
  'A payment received against the guest’s ACCOUNT rather than against one stay. ' +
    'It joins their payment pool and settles their oldest unpaid item first, ' +
    'exactly as a payment taken at the desk does.',
  'That is why an old stay can read as settled while its own folio still shows ' +
    'a balance: the money that settled it was taken later, or on the standalone ' +
    'account. The guest-level total is the one that reconciles.',
];

export const DISCOUNT_ABOUT: string[] = [
  'A discount is its OWN LINE, not a smaller charge. The bill reads rack price, ' +
    'then the discount, then the net — so the hotel can always see what was ' +
    'given away, on what, and by whom.',
  'Anything above this property’s approval limit needs a manager’s PIN, and so ' +
    'does a full comp whatever it is worth. The approval is recorded against the ' +
    'MANAGER, by name, not against whoever started it.',
  'A discount can be undone later without touching the charge: reversing it puts ' +
    'the line back to full price and leaves the original discount, its reason and ' +
    'its approver on the record.',
];

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
