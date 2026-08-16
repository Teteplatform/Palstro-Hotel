import { LockIcon } from '../ui/icons';

// THE MANAGER-PIN BLOCK, extracted so a fifth reversal surface does not become a
// fifth copy of it.
//
// ----------------------------------------------------------------------------
// WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT
// ----------------------------------------------------------------------------
// Four reversal forms exist already — ReverseChargeForm, ReversePaymentForm,
// ReverseBookingStatusForm, ReverseCheckoutForm. Every one of them renders this
// panel: the lock heading, a sentence about why THIS act needs approval, the
// password input, and the footnote about the PIN never being stored. They share
// FolioActionCard for the shell and nothing else, so the panel is written out
// four times.
//
// It has NOT drifted — all four use the same type/inputMode/autoComplete/
// maxLength — and it is code duplication rather than two sources of truth about
// a rule, so retrofitting those four is a deliberate, separate decision and not
// this shipment's business. They are proven-live money paths, and rewriting all
// four during a UI shipment about stock is how something proven breaks for no
// functional gain. The deferral is recorded on the tracker, not left as folklore.
//
// What this file changes is the direction of travel: the shared component now
// exists, stock reversal is its first consumer, and the next surface that needs
// a PIN has somewhere to get one.
//
// ----------------------------------------------------------------------------
// THE PIN ITSELF — the constraint every consumer must honour
// ----------------------------------------------------------------------------
// This component is CONTROLLED and holds nothing. The PIN is one piece of the
// caller's component state for the duration of one call, cleared in a `finally`
// block whether the call succeeded or failed. It is never written anywhere else,
// never logged, and never included in an error message. There is no browser
// storage anywhere in this app.
//
// The server is the guard, not this field (rule 19): verify_manager_pin is
// revoked from every client role, so the PIN is only ever checked inside a
// SECURITY DEFINER RPC, and the RPC refuses the whole call without a valid one.
// A user who bypassed this input entirely would get exactly as far.

interface ManagerPinFieldProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  // WHY THIS PARTICULAR ACT NEEDS A MANAGER, in one sentence, written by the
  // consumer. This is the part that SHOULD differ between surfaces and the
  // reason the component takes it as a prop rather than owning a generic line:
  // "this re-takes a room the hotel may have re-sold" and "this puts stock back
  // that the ledger says left" are different warnings, and collapsing them into
  // one would make the panel say less at every site than the four copies do now.
  reason: string;
}

export function ManagerPinField({
  value,
  onChange,
  disabled = false,
  reason,
}: ManagerPinFieldProps) {
  return (
    <div className="rounded-xl border-2 border-primary/40 bg-primary/5 p-3 sm:p-4">
      <p className="flex flex-wrap items-center gap-2 text-sm font-bold text-primary">
        <LockIcon className="h-5 w-5 shrink-0" />A manager must authorise this
        reversal
      </p>
      <p className="mt-1.5 text-xs text-charcoal">
        Every reversal needs a PIN, whatever the amount — {reason} Hand the
        terminal to a manager: the approval is recorded{' '}
        <strong>against them by name</strong>, permanently, and it can never be
        edited or deleted.
      </p>

      <label className="mt-3 block">
        <span className="mb-1 block text-sm font-semibold text-charcoal">
          Manager PIN{' '}
          <span className="text-primary" aria-hidden="true">
            *
          </span>
          <span className="sr-only">(required)</span>
        </span>
        <input
          type="password"
          inputMode="numeric"
          autoComplete="off"
          // 021 §7.1 accepts 4-8 digits; the RPC is the authority on format and
          // rejects anything else in its own words.
          maxLength={8}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          aria-label="Manager PIN"
          className="w-full max-w-[14rem] rounded-lg border border-sand-border bg-white/80 px-3 py-2.5 text-base tracking-[0.4em] text-charcoal transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream disabled:cursor-not-allowed disabled:opacity-60"
        />
      </label>

      <p className="mt-2 text-[11px] text-charcoal-muted">
        The PIN is sent only to the approval check and is cleared from this
        screen the moment it is used. It is never stored or displayed, and no PIN
        is ever kept in this browser.
      </p>
    </div>
  );
}
