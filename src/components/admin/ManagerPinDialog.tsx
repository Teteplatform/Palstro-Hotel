import { useRef } from 'react';
import { CloseIcon } from '../ui/icons';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { ManagerPinPanel } from './ManagerPinPanel';

// The user-menu route to the manager's approval PIN: dialog chrome around the
// shared ManagerPinPanel, which is the feature itself.
//
// THIS FILE HOLDS NO PIN LOGIC ANY MORE, on purpose. The same panel is the
// Settings screen's "Manager PIN" tab (2.txt part 1 §UI), and a PIN screen
// implemented twice is a PIN screen that clears its state in one place and
// forgets to in the other. Everything about who may hold a PIN, whose PIN can be
// set, and how it is handled lives in ManagerPinPanel's header.
//
// Why a dialog here and a page there: the user menu is a "quick, from anywhere"
// affordance — a manager standing at a colleague's terminal should not have to
// navigate away from whatever is on screen. The settings tab is the findable,
// linkable home for the same thing.

interface ManagerPinDialogProps {
  tenantId: string;
  onClose: () => void;
}

export function ManagerPinDialog({ tenantId, onClose }: ManagerPinDialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef, true, onClose);

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

        <div className="px-5 py-5">
          <ManagerPinPanel
            tenantId={tenantId}
            onCancel={onClose}
            onSaved={onClose}
          />
        </div>
      </div>
    </div>
  );
}
