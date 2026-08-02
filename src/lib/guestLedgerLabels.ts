import type { StaySettlementStatus } from '../types/guestLedger';

// Generic UI copy for the guest ledger's FIFO settlement status (027 §3) — no
// tenant content (rule 17), the same shape as bookingLabels/folioLabels so every
// screen reads the enum identically.
//
// THE WORDING IS DELIBERATE AND IS NOT THE SAME AS A FOLIO BALANCE. These labels
// describe the GUEST-LEVEL position: how far the guest's payment pool reaches
// down their stays, oldest first. A stay can read "Settled" here while its own
// folio still shows money outstanding, because the payment that settled it was
// taken against a later stay. The two never disagree in total — see the
// reconciles-to invariant in types/guestLedger.ts — and the stays table carries a
// note saying so, so nobody has to guess.

const SETTLEMENT_LABELS: Record<StaySettlementStatus, string> = {
  settled: 'Settled',
  part_paid: 'Part paid',
  unpaid: 'Unpaid',
  // Nothing has been billed on this stay yet (a future booking, or a cancelled
  // one that attracted no fee). "Unpaid" would be a false accusation.
  nil: 'Not billed',
};

export function settlementStatusLabel(status: StaySettlementStatus): string {
  return SETTLEMENT_LABELS[status] ?? status;
}

// A tone token per status, mapping to the design tokens in index.css (never a
// literal hex — rule 17 / §8). Settled is the positive token, unpaid the
// negative one, so the chip agrees with the colour rule the Balance column and
// the folio's Outstanding Balance already use.
//
// EVERY PAIRING BELOW IS ONE ALREADY PROVEN AT ITS TOKEN (§8: contrast is checked
// when a token is defined, not when a component is reviewed) — no new pairing is
// introduced here:
//   text-positive on sand ....... 5.21:1 (index.css, --brand-positive)
//   text-negative on negative/10  6.23:1 over cream, the darkest surface it sits
//                                 on (index.css, --brand-negative)
//   accent/15 + text-accent ..... the chip bookingStatusTone already uses for
//                                 'checked_in'
export function settlementStatusTone(status: StaySettlementStatus): string {
  switch (status) {
    case 'settled':
      return 'bg-sand text-positive';
    case 'part_paid':
      return 'bg-accent/15 text-accent';
    case 'unpaid':
      return 'bg-negative/10 text-negative';
    case 'nil':
    default:
      return 'bg-sand text-charcoal-muted';
  }
}
