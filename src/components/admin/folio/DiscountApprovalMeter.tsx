import { formatMoney } from '../../../lib/format';
import {
  approvalStateFor,
  needsPin,
  type ApprovalState,
} from '../../../lib/discountApproval';
import { CheckIcon, LockIcon } from '../../ui/icons';

// THE LIVE APPROVAL SIGNAL for the discount screen (brief §4).
//
// WHAT PROBLEM THIS SOLVES. Before it, a staff member typed an amount and the
// PIN field either appeared or did not — the rule was inferable only from that
// jump, and the number that decided it was never on screen. Someone typing
// ₦52,000 against a ₦50,000 limit could not see that ₦2,000 was the whole
// difference between "apply this yourself" and "go and find a manager". Now the
// answer updates with every keystroke, and it shows the arithmetic: the limit,
// what has been used of it, and how much headroom is left or how far over it is.
//
//  ┌──────────────────────────────────────────────────────────────────────────┐
//  │  THIS IS CONVENIENCE. apply_charge_discount IS THE GUARD.                 │
//  └──────────────────────────────────────────────────────────────────────────┘
// Rule 19, exactly: the RPC re-reads discount_threshold from
// property_finance_settings and re-applies BOTH rules (the threshold, and
// "a comp always needs a PIN") on the server, so a stale threshold in this
// component, a tampered client, or a submit that skips the PIN field is rejected
// by the database and the rejection is shown verbatim. Nothing here decides
// whether a discount is allowed — it only predicts what the server will say, so
// the person at the desk is not surprised. Never move the decision into the UI.
//
// TONE CHOICE, and why it is not green/red. --brand-positive and
// --brand-negative are documented in index.css as meaning NOTHING OWED and MONEY
// OWED — they are the folio balance's semantics, not "good" and "bad" in the
// abstract. Reusing them for approval state would make one red thing on the
// folio mean "the guest owes money" and another mean "you need a PIN". So the
// two states here use the brand's own attention colour (primary, proven 5.9:1 on
// cream / 5.0:1 on sand as text) against a neutral charcoal, with an icon and
// wording carrying the meaning — never colour alone, which also keeps it legible
// to anyone who cannot distinguish the two hues.
//
// RESPONSIVE: everything wraps; the bar is fluid; nothing has a fixed width, so
// it reads on a 360px phone at the front desk and on a desktop.

export function DiscountApprovalMeter({
  amount,
  threshold,
  gross,
  currency,
}: {
  // The live field value — null while the field is empty.
  amount: number | null;
  // The property's PIN-free ceiling. 0 means EVERY discount needs a manager PIN
  // (021 §3's deliberately strict default).
  threshold: number;
  gross: number;
  currency: string;
}) {
  const state = approvalStateFor(amount, threshold, gross);
  const entered = amount ?? 0;
  const pinRequired = needsPin(state);

  // The bar spans 0 .. max(threshold, entered), so the limit marker stays put
  // while the fill runs past it once the amount goes over. With a zero threshold
  // there is no scale to draw — every amount is over — so the bar is omitted and
  // the sentence carries it instead.
  const showBar = threshold > 0 && state !== 'invalid';
  const scale = Math.max(threshold, entered) || 1;
  const fillPct = Math.min(100, (entered / scale) * 100);
  const limitPct = Math.min(100, (threshold / scale) * 100);
  const overLimit = state === 'over' || state === 'comp';

  const headroom = threshold - entered;

  return (
    <div
      className={`rounded-lg border p-3 ${
        pinRequired
          ? 'border-primary/40 bg-primary/5'
          : 'border-sand-border bg-white/60'
      }`}
    >
      {/* aria-live so the state change is ANNOUNCED as the amount is typed, not
          only shown. polite, because it updates on every keystroke. */}
      <p
        role="status"
        aria-live="polite"
        className="flex flex-wrap items-center gap-1.5 text-sm font-semibold text-charcoal"
      >
        {pinRequired ? (
          <LockIcon className="h-4 w-4 shrink-0 text-primary" />
        ) : (
          <CheckIcon className="h-4 w-4 shrink-0 text-charcoal-muted" />
        )}
        <span className={pinRequired ? 'text-primary' : undefined}>
          {headline(state, threshold, currency)}
        </span>
      </p>

      <p className="mt-1 text-xs text-charcoal-muted">
        {detail(state, entered, threshold, gross, headroom, currency)}
      </p>

      {showBar ? (
        <div className="mt-2.5">
          {/* Decorative: every number it encodes is already in the text above,
              so it carries no information a screen reader would miss. */}
          <div
            aria-hidden="true"
            className="relative h-2 w-full overflow-hidden rounded-full bg-sand"
          >
            <div
              className={`h-full rounded-full transition-[width] duration-150 ${
                overLimit ? 'bg-primary' : 'bg-charcoal/50'
              }`}
              style={{ width: `${fillPct}%` }}
            />
            {/* The limit marker — where a PIN starts being required. */}
            <div
              className="absolute inset-y-0 w-px bg-charcoal/60"
              style={{ left: `${limitPct}%` }}
            />
          </div>
          <div className="mt-1 flex flex-wrap justify-between gap-x-3 text-[11px] text-charcoal-muted">
            <span>{formatMoney(entered, currency)} entered</span>
            <span>
              PIN-free limit {formatMoney(threshold, currency)}
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function headline(
  state: ApprovalState,
  threshold: number,
  currency: string,
): string {
  switch (state) {
    case 'idle':
      return threshold > 0
        ? `Discounts up to ${formatMoney(threshold, currency)} need no approval`
        : 'Every discount here needs a manager PIN';
    case 'within':
      return 'Within your own approval limit — no PIN needed';
    case 'over':
      return 'Manager PIN required';
    case 'comp':
      return 'Full comp — manager PIN always required';
    case 'invalid':
      return 'More than the charge';
  }
}

function detail(
  state: ApprovalState,
  entered: number,
  threshold: number,
  gross: number,
  headroom: number,
  currency: string,
): string {
  switch (state) {
    case 'idle':
      return threshold > 0
        ? `Anything above ${formatMoney(threshold, currency)} — and any full comp, whatever the amount — must be authorised by a manager, and is recorded against them.`
        : 'This property’s approval threshold is set to zero, so a manager must authorise any discount on this charge.';
    case 'within':
      return `${formatMoney(headroom, currency)} of your ${formatMoney(threshold, currency)} limit still to go. This will be recorded against you as the approver.`;
    case 'over':
      return `${formatMoney(entered, currency)} is ${formatMoney(entered - threshold, currency)} above the ${formatMoney(threshold, currency)} limit. A manager must enter their PIN below, and the approval is recorded against them.`;
    case 'comp':
      return `This writes off the whole ${formatMoney(gross, currency)} charge. A comp always needs a manager, whatever the threshold — it is the single easiest way to make a real sale disappear.`;
    case 'invalid':
      return `A discount cannot exceed the charge of ${formatMoney(gross, currency)}. Enter ${formatMoney(gross, currency)} or less — entering exactly ${formatMoney(gross, currency)} is a full comp.`;
  }
}
