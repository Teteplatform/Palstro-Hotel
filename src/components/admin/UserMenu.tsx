import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../../hooks/useAuth';
import { useToast } from '../ui/Toast';
import {
  ChevronDownIcon,
  SettingsIcon,
  SignOutIcon,
  UserIcon,
} from '../ui/icons';
import { MISSING_VALUE } from '../../lib/format';
import { ManagerPinDialog } from './ManagerPinDialog';

// The signed-in user's identity and sign-out control in the header (3.txt §2).
// A small dropdown: the trigger shows who is signed in; the menu holds the
// manager's approval-PIN setting and sign out. Closes on Escape and on outside
// click.

interface UserMenuProps {
  // The tenant that OWNS the active property — not "the user's first tenant".
  // A PIN is keyed on (tenant_id, user_id), so a multi-tenant manager holds a
  // separate PIN per hotel group and the right one must be addressed here.
  tenantId: string | null;
  // Whether this user is an owner/manager OF THAT TENANT. Front-desk, kitchen and
  // housekeeping accounts do not have an approval PIN and are not shown the
  // setting: a PIN on a front-desk account would let the front desk approve its
  // own above-threshold discounts, which is the exact hole the threshold exists to
  // close. set_manager_pin enforces this server-side regardless (021 §7.1) — this
  // flag only decides whether to OFFER a control the user could not use.
  canHoldManagerPin: boolean;
}

export function UserMenu({ tenantId, canHoldManagerPin }: UserMenuProps) {
  const { user, signOut } = useAuth();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [pinOpen, setPinOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  async function handleSignOut() {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await signOut();
      // No navigation call needed: the session clears, ProtectedRoute
      // re-evaluates and redirects to /login on the next render.
    } catch (e) {
      // Surface the failure (rule 11) — never leave the user believing they
      // signed out when they did not.
      toast.error(
        e instanceof Error ? e.message : 'Could not sign out. Please try again.',
      );
      setSigningOut(false);
    }
  }

  const email = user?.email ?? MISSING_VALUE;

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-2 rounded-full border border-sand-border bg-white/70 py-1.5 pr-2 pl-1.5 text-sm font-medium text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream"
      >
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-sand text-charcoal-muted">
          <UserIcon className="h-4 w-4" />
        </span>
        <span className="hidden max-w-[12rem] truncate sm:block">{email}</span>
        <ChevronDownIcon className="h-4 w-4 text-charcoal-muted" />
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute right-0 z-20 mt-2 w-56 overflow-hidden rounded-xl border border-sand-border bg-cream shadow-lg"
        >
          <div className="border-b border-sand-border px-4 py-3">
            <p className="text-xs text-charcoal-muted">Signed in as</p>
            <p className="truncate text-sm font-semibold text-charcoal">
              {email}
            </p>
          </div>
          {canHoldManagerPin && tenantId ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                setPinOpen(true);
              }}
              className="flex w-full items-center gap-2 border-b border-sand-border px-4 py-3 text-left text-sm font-medium text-charcoal transition-colors hover:bg-sand focus-visible:bg-sand focus-visible:outline-none"
            >
              <SettingsIcon className="h-4 w-4 text-charcoal-muted" />
              Manager PIN
            </button>
          ) : null}
          <button
            type="button"
            role="menuitem"
            onClick={handleSignOut}
            disabled={signingOut}
            className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-medium text-charcoal transition-colors hover:bg-sand focus-visible:bg-sand focus-visible:outline-none disabled:opacity-60"
          >
            <SignOutIcon className="h-4 w-4 text-charcoal-muted" />
            {signingOut ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      ) : null}

      {pinOpen && tenantId ? (
        <ManagerPinDialog tenantId={tenantId} onClose={() => setPinOpen(false)} />
      ) : null}
    </div>
  );
}
