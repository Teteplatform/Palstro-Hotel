import { useEffect, useState } from 'react';
import { useToast } from '../ui/Toast';
import { LockIcon } from '../ui/icons';
import { describeError } from '../../lib/errors';
import { folioErrorMessage, hasManagerPin, setManagerPin } from '../../lib/folio';

// THE MANAGER'S OWN APPROVAL PIN — one implementation, two homes.
//
// This panel is the whole feature; ManagerPinDialog wraps it in dialog chrome for
// the user menu, and the Settings screen renders it as its "Manager PIN" tab so
// there is a findable, linkable page for it. Two entry points, ONE piece of code:
// a PIN screen duplicated per surface is a PIN screen that clears its state in
// one place and forgets to in the other.
//
// WHAT THE PIN IS FOR, and why it is worth a page of its own: it authorises
//   * discounts above the property's approval limit, and every full comp
//     (apply_charge_discount, 021 §9.3), and
//   * EVERY payment reversal, with no threshold at all (reverse_payment, 031 §3).
// In both cases the approval is recorded against the manager BY NAME, permanently
// — so a manager with no PIN set is a manager who cannot approve anything, and a
// front desk with no manager on shift is a desk that cannot reverse a payment.
// That makes "have you set your PIN?" an operational question, not a setting.
//
// WHO MAY HOLD ONE: owners and managers only, and the check is not decoration. A
// PIN on a front-desk account would let the front desk approve its own
// above-threshold discounts and reverse its own payments — the exact hole the
// approval requirement exists to close — so set_manager_pin refuses any caller
// who is not is_tenant_admin() for the tenant. The surfaces hide the control for
// everyone else purely so nobody is offered a setting they cannot use; the RPC is
// the guard (rule 19).
//
// WHOSE PIN: only your own. set_manager_pin takes no user id at all — it uses
// auth.uid() — so there is no parameter an administrator could pass to plant a
// PIN on a colleague's account and then approve in their name. A forgotten PIN
// therefore cannot be recovered by anyone, only reset by its owner.
//
// THE PIN ITSELF: entered twice, never displayed (type="password"), never
// pre-filled, never logged, never put in an error message, and cleared from state
// the moment the call returns — success or failure. No browser storage anywhere
// (constraint).

interface ManagerPinPanelProps {
  // The tenant that OWNS the active property — a PIN is keyed on
  // (tenant_id, user_id), so a multi-tenant manager holds a separate PIN per
  // hotel group and the right one must be addressed.
  tenantId: string;
  // Rendered as a secondary button beside Save when the surface has somewhere to
  // go back to (the dialog). Omitted on the settings page, which has no "cancel".
  onCancel?: () => void;
  // Called after a successful save. The dialog closes on it; the settings page
  // simply stays put with its status line updated.
  onSaved?: () => void;
}

export function ManagerPinPanel({
  tenantId,
  onCancel,
  onSaved,
}: ManagerPinPanelProps) {
  const toast = useToast();
  const [hasPin, setHasPin] = useState<boolean | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Whether a PIN exists is answered by has_manager_pin — manager_pins has no
  // select policy for anyone, not even its owner, so there is no other way to ask
  // and no way for a client to read a hash.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const value = await hasManagerPin(tenantId);
        if (!cancelled) setHasPin(value);
      } catch (e) {
        if (!cancelled) setLoadError(describeError(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tenantId]);

  const mismatch = confirm.length > 0 && pin !== confirm;
  const canSubmit = pin.length > 0 && confirm.length > 0 && !mismatch;

  async function handleSubmit() {
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    try {
      await setManagerPin(tenantId, pin);
      toast.success(
        hasPin ? 'Your approval PIN has been changed.' : 'Your approval PIN is set.',
      );
      setHasPin(true);
      onSaved?.();
    } catch (e) {
      // The RPC's OWN message, verbatim — "A PIN must be 4 to 8 digits", "That PIN
      // is too easy to guess; avoid repeated digits and simple sequences", "Only
      // an owner or manager may set an approval PIN". Each tells the manager
      // exactly what to do differently; a generic "could not save" would not.
      toast.error(folioErrorMessage(e));
    } finally {
      // The PIN never outlives the call.
      setPin('');
      setConfirm('');
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-charcoal-muted">
        Your PIN authorises discounts above this property's approval limit, every
        full comp, and <strong>every payment reversal</strong> — reversals need a
        PIN whatever the amount. Each approval is recorded against you by name and
        cannot be edited or deleted afterwards, so treat it as your signature.
      </p>

      {loadError ? (
        <p className="rounded-lg border border-sand-border bg-white/70 px-3 py-2 text-xs text-charcoal">
          {loadError}
        </p>
      ) : (
        <p className="flex items-start gap-2 rounded-lg border border-sand-border bg-white/70 px-3 py-2 text-sm text-charcoal">
          <LockIcon className="mt-0.5 h-4 w-4 shrink-0 text-charcoal-muted" />
          <span>
            {hasPin === null
              ? 'Checking…'
              : hasPin
                ? 'You have an approval PIN set. Entering a new one replaces it.'
                : 'You have not set an approval PIN yet — until you do, you cannot approve a discount or a reversal.'}
          </span>
        </p>
      )}

      <PinInput
        label={hasPin ? 'New PIN' : 'PIN'}
        value={pin}
        onChange={setPin}
        disabled={submitting}
        help="4 to 8 digits. Avoid repeated digits and simple sequences — they are rejected."
      />
      <PinInput
        label="Confirm PIN"
        value={confirm}
        onChange={setConfirm}
        disabled={submitting}
        error={mismatch ? 'The two PINs do not match.' : undefined}
      />

      <p className="text-[11px] text-charcoal-muted">
        Your PIN is stored only as a one-way hash — nobody, including the hotel
        owner and this application, can read it back. If you forget it, set a new
        one here.
      </p>

      <div className="flex flex-wrap items-center justify-end gap-2">
        {onCancel ? (
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className="rounded-full border border-sand-border bg-white/70 px-5 py-2.5 text-sm font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:opacity-60"
          >
            Cancel
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => void handleSubmit()}
          disabled={submitting || !canSubmit}
          className="rounded-full bg-accent px-6 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? 'Saving…' : hasPin ? 'Change PIN' : 'Set PIN'}
        </button>
      </div>
    </div>
  );
}

// A PIN entry: masked, never auto-filled by the browser, digits keypad on mobile.
// Deliberately NOT the shared TextField — that primitive is for readable text and
// has no masked mode, and a PIN must never render as characters on a screen a
// guest can see over the desk. No autofocus: in the dialog the focus trap already
// places focus inside, and yanking it onto a password field is disorienting for
// screen-reader users.
function PinInput({
  label,
  value,
  onChange,
  disabled,
  help,
  error,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  help?: string;
  error?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-charcoal">
        {label}{' '}
        <span className="text-primary" aria-hidden="true">
          *
        </span>
        <span className="sr-only">(required)</span>
      </span>
      <input
        type="password"
        inputMode="numeric"
        autoComplete="off"
        // Strip anything that is not a digit as it is typed, so the RPC's format
        // rejection is reserved for genuine problems (too short, too guessable)
        // rather than a stray space.
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 8))}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        className="w-full max-w-[12rem] rounded-lg border border-sand-border bg-white/70 px-3 py-2 text-sm tracking-[0.4em] text-charcoal transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream disabled:cursor-not-allowed disabled:opacity-60"
      />
      {error ? (
        <p className="mt-1 text-xs font-medium text-primary" role="alert">
          {error}
        </p>
      ) : help ? (
        <p className="mt-1 text-xs text-charcoal-muted">{help}</p>
      ) : null}
    </label>
  );
}
