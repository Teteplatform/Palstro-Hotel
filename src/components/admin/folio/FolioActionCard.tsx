import type { ReactNode } from 'react';
import { AboutNote } from '../../ui/AboutNote';

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
// ---------------------------------------------------------------------------
// SUBJECT, EFFECT, AND THE ⓘ — three slots, because they are three things
// ---------------------------------------------------------------------------
// There used to be one `description`, and every form put all three in it. The
// Void form's ran to five lines: what you are voiding, what voiding does, and a
// lesson on when to reverse instead. Rule 25 splits them by what they are FOR:
//
//   subject  WHAT YOU ARE ACTING ON, with its real figures — "Food & Beverage —
//            Dinner · ₦12,500". Always on screen. Without it the form is a
//            box of fields floating over an unnamed line.
//   effect   WHAT THIS ACT WILL DO TO THIS BILL, with the real figures — "the
//            balance goes down by ₦12,500 and its tax". Also always on screen,
//            and deliberately NOT behind the icon: this is the thing the person
//            is deciding about, at the moment of an irreversible act, and hiding
//            it would be the opposite of the point rule 25 is making.
//   about    THE GENERAL RULE — what a void is, when to reverse instead, what
//            stays on the record. True of every folio, on every day, and read
//            once. Behind the ⓘ, and in the staff guide.
//
// The test between `effect` and `about`: if it names a figure from THIS bill it
// is an effect; if it would read the same on a bill you have never seen, it is
// an about.
//
// The submit button is DISABLED while a write is in flight. The idempotency key
// is the real guard against a double-click posting twice (rules 2/3 — the DB's
// partial unique index is what actually enforces it), but a button that stays
// clickable while a payment is being recorded invites the click, and the honest
// response to "did that go through?" is a control that visibly cannot be pressed
// again.
export function FolioActionCard({
  title,
  subject,
  effect,
  about,
  propertySlug,
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
  // The line being acted on, with its figures.
  subject?: ReactNode;
  // What this act does to THIS bill, in this bill's numbers.
  effect?: ReactNode;
  // The general rule, behind one icon (rule 25).
  about?: {
    title: string;
    paragraphs: string[];
    guideAnchor: string;
    guideLabel: string;
  };
  propertySlug?: string;
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
      <div className="flex items-center gap-2">
        <h4 className="text-sm font-semibold text-charcoal">{title}</h4>
        {about && propertySlug ? (
          <AboutNote
            title={about.title}
            paragraphs={about.paragraphs}
            propertySlug={propertySlug}
            guideAnchor={about.guideAnchor}
            guideLabel={about.guideLabel}
          />
        ) : null}
      </div>
      {subject ? (
        <p className="mt-1 text-xs text-charcoal-muted">{subject}</p>
      ) : null}
      {effect ? (
        <p className="mt-1 text-xs text-charcoal">{effect}</p>
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
