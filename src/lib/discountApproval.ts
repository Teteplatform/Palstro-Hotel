// THE CLIENT-SIDE PREDICTION of what apply_charge_discount will decide
// (brief §4). One module, so the approval meter's wording, the PIN field's
// visibility and the submit button's enabled state cannot drift apart — three
// places in the discount screen ask this, and three copies of a comparison is
// how they end up disagreeing about the same amount.
//
//  ┌──────────────────────────────────────────────────────────────────────────┐
//  │  THIS IS A PREDICTION, NOT A GUARD. THE RPC IS THE GUARD.                 │
//  └──────────────────────────────────────────────────────────────────────────┘
// apply_charge_discount (021 §9.3) re-reads discount_threshold from
// property_finance_settings and re-applies BOTH rules server-side, so a stale
// threshold here, a tampered client, or a submit that skips the PIN field is
// rejected by the database and the rejection is shown verbatim. This file only
// decides what to SHOW, so the person at the desk is not surprised by the
// server's answer. Rule 19: the client's copy is a convenience, never the guard.
//
// THE RULES, in the order the RPC evaluates them:
//   1. a COMP (100% off the charge) ALWAYS needs a manager PIN, whatever the
//      threshold, however small the amount;
//   2. otherwise, above the property's discount_threshold needs a PIN; at or
//      below it is the staff member's own authority, and they are named as the
//      approver. A threshold of 0 means every discount takes the manager branch.

export type ApprovalState =
  // Nothing usable typed yet.
  | 'idle'
  // Within the staff member's own authority — no PIN.
  | 'within'
  // Above the property's threshold — a manager PIN is required.
  | 'over'
  // 100% off — a manager PIN is required whatever the threshold.
  | 'comp'
  // Larger than the charge: not a discount state at all, and the RPC rejects it.
  | 'invalid';

export function approvalStateFor(
  amount: number | null,
  threshold: number,
  gross: number,
): ApprovalState {
  if (amount === null || amount <= 0) return 'idle';
  // Checked BEFORE the comp test: calling an over-sized amount a "comp" would be
  // a promise this screen cannot keep, since the RPC refuses it outright.
  if (amount > gross) return 'invalid';
  // A comp is 100% off, compared against GROSS because a discount is absolute
  // and replaces whatever was there — the same comparison the RPC makes.
  if (amount >= gross) return 'comp';
  return amount > threshold ? 'over' : 'within';
}

export function needsPin(state: ApprovalState): boolean {
  return state === 'over' || state === 'comp';
}
