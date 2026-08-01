import type { ReactNode } from 'react';

// The shell every folio action renders into: take payment, add charge, discount,
// void. One card, one place the submit/cancel affordance is decided.
//
// WHY AN INLINE CARD AND NOT A NESTED MODAL: the folio lives inside the booking
// detail dialog, which already traps focus (useFocusTrap). A dialog inside a
// dialog means two traps fighting over the same keystrokes and an Escape that has
// to guess which layer it closes. The actions render inline instead, in the same
// scroll flow as the bill they act on — which also keeps the charge you are
// discounting visible while you type the reason.
//
// The submit button is DISABLED while a write is in flight. The idempotency key
// is the real guard against a double-click posting twice (rules 2/3 — the DB's
// partial unique index is what actually enforces it), but a button that stays
// clickable while a payment is being recorded invites the click, and the honest
// response to "did that go through?" is a control that visibly cannot be pressed
// again.
export function FolioActionCard({
  title,
  description,
  submitLabel,
  submittingLabel,
  submitting,
  canSubmit,
  destructive = false,
  onSubmit,
  onCancel,
  children,
}: {
  title: string;
  description?: ReactNode;
  submitLabel: string;
  submittingLabel: string;
  submitting: boolean;
  canSubmit: boolean;
  // Voids get the primary (warm) button rather than the accent one, so a
  // money-reversing action never looks like the routine happy path.
  destructive?: boolean;
  onSubmit: () => void;
  onCancel: () => void;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-sand-border bg-white/70 p-4">
      <h4 className="text-sm font-semibold text-charcoal">{title}</h4>
      {description ? (
        <p className="mt-1 text-xs text-charcoal-muted">{description}</p>
      ) : null}

      <div className="mt-3 space-y-3">{children}</div>

      <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={submitting}
          className="rounded-full border border-sand-border bg-white/70 px-4 py-2 text-xs font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:opacity-60"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onSubmit}
          disabled={submitting || !canSubmit}
          className={`rounded-full px-5 py-2 text-xs font-semibold text-white transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:cursor-not-allowed disabled:opacity-50 ${
            destructive
              ? 'bg-primary hover:bg-primary-hover focus-visible:ring-primary'
              : 'bg-accent hover:bg-accent-hover focus-visible:ring-accent'
          }`}
        >
          {submitting ? submittingLabel : submitLabel}
        </button>
      </div>
    </section>
  );
}
