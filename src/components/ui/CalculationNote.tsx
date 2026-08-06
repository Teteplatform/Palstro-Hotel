// THE "how this was calculated" AFFORDANCE (rule 16), built once.
//
// Every summary figure in this app has to be able to say what it includes and
// what it excludes — "an unexplained number gets distrusted and second-guessed",
// and a number nobody trusts is a number nobody uses. Rule 20 adds the other
// half for a figure that sits beside a list: it must also say that it covers the
// WHOLE FILTERED SET rather than the visible page.
//
// It started as a private helper inside FolioBill and is shared from here now
// that the stock screens need the same thing. One implementation means one
// place to fix its accessibility, not one per screen.
//
// ACCESSIBILITY, and why `title` alone was not enough: a native tooltip is
// invisible to touch and to the keyboard. So the note is ALSO the element's
// aria-label and the element is focusable — a screen reader announces it, and a
// keyboard user can tab to it. It is deliberately not a <button>: there is
// nothing to activate, and announcing it as a button would promise an action
// that does not exist.
export function CalculationNote({ note }: { note: string }) {
  return (
    <span
      className="inline-flex h-5 w-5 cursor-help items-center justify-center rounded-full border border-sand-border bg-white/70 text-[11px] leading-none text-charcoal-muted"
      tabIndex={0}
      role="note"
      aria-label={`How this is calculated: ${note}`}
      title={note}
    >
      <span aria-hidden="true">i</span>
    </span>
  );
}
