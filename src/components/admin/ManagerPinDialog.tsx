import { useEffect, useRef, useState } from 'react';
import { useToast } from '../ui/Toast';
import { CloseIcon } from '../ui/icons';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { describeError } from '../../lib/errors';
import { folioErrorMessage, hasManagerPin, setManagerPin } from '../../lib/folio';

// The manager's own approval PIN (build 6c part 2 §6).
//
// WHO SEES THIS: owners and managers only, and the check is not decoration. A PIN
// on a front-desk account would let the front desk approve its own above-threshold
// discounts and its own comps — the exact hole the threshold exists to close — so
// set_manager_pin refuses any caller who is not is_tenant_admin() for the tenant.
// The menu item is hidden for everyone else purely so nobody is offered a setting
// they cannot use; the RPC is the guard (rule 19's shape again).
//
// WHOSE PIN: only your own. set_manager_pin takes no user id at all — it uses
// auth.uid() — so there is no parameter an administrator could pass to plant a PIN
// on a colleague's account and then approve discounts in their name. A forgotten
// PIN therefore cannot be recovered by anyone, only reset by its owner: a PIN an
// administrator could read is a PIN an administrator could use as someone else,
// which would destroy the whole accountability chain.
//
// THE PIN ITSELF: entered twice, never displayed (type="password"), never
// pre-filled, never logged, never put in an error message, and cleared from state
// the moment the call returns — success or failure.

interface ManagerPinDialogProps {
  tenantId: string;
  onClose: () => void;
}

export function ManagerPinDialog({ tenantId, onClose }: ManagerPinDialogProps) {
  const toast = useToast();
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef, true, onClose);

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
      onClose();
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
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-charcoal/40 p-4 sm:p-6">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Manager approval PIN"
        className="w-full max-w-md rounded-2xl bg-cream shadow-xl"
      >
        <header className="flex items-center justify-between gap-3 border-b border-sand-border px-5 py-4">
          <h2 className="text-lg font-bold tracking-tight text-charcoal">
            Manager PIN
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-2 text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream"
          >
            <CloseIcon className="h-5 w-5" />
          </button>
        </header>

        <div className="space-y-4 px-5 py-5">
          <p className="text-sm text-charcoal-muted">
            Your PIN authorises discounts above the property's approval limit, and
            every full comp. The approval is recorded against you by name on the
            charge, so treat it as your signature.
          </p>

          {loadError ? (
            <p className="rounded-lg border border-sand-border bg-white/70 px-3 py-2 text-xs text-charcoal">
              {loadError}
            </p>
          ) : (
            <p className="rounded-lg border border-sand-border bg-white/70 px-3 py-2 text-sm text-charcoal">
              {hasPin === null
                ? 'Checking…'
                : hasPin
                  ? 'You have an approval PIN set. Entering a new one replaces it.'
                  : 'You have not set an approval PIN yet.'}
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
            owner and this application, can read it back. If you forget it, set a
            new one here.
          </p>
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-sand-border px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-full border border-sand-border bg-white/70 px-5 py-2.5 text-sm font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={submitting || !canSubmit}
            className="rounded-full bg-accent px-6 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? 'Saving…' : hasPin ? 'Change PIN' : 'Set PIN'}
          </button>
        </footer>
      </div>
    </div>
  );
}

// A PIN entry: masked, never auto-filled by the browser, digits keypad on mobile.
// Deliberately NOT the shared TextField — that primitive is for readable text and
// has no masked mode, and a PIN must never render as characters on a screen a
// guest can see over the desk. No autofocus: the focus trap already places focus
// inside the dialog, and yanking it onto a password field is disorienting for
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
