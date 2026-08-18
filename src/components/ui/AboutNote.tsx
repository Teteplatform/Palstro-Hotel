import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Popover } from './Popover';

// THE ⓘ (CLAUDE.md rule 25).
//
// ---------------------------------------------------------------------------
// WHAT THIS REPLACED
// ---------------------------------------------------------------------------
// The Stock Take tab opened with a paragraph about snapshots, a paragraph about
// saving as you go, a paragraph about one count per location, three field hints,
// and a paragraph under the Start button about counts versus write-offs. All of
// it good writing, and all of it in the way: the person who opens that screen
// came to work, and by the third morning they are reading none of it — including
// the sentence that mattered.
//
// So the reasoning did not get deleted. It moved: one icon, one panel, and the
// same words in full in docs/USER-GUIDE.md, which the in-app Help page renders.
// Somebody who wants the why finds it in a second; somebody who does this daily
// never sees it again.
//
// ---------------------------------------------------------------------------
// WHY IT IS A BUTTON AND A POPOVER, not a `title` tooltip
// ---------------------------------------------------------------------------
// CalculationNote (rule 16) is the other affordance and stays what it is: a
// one-sentence "how this figure was worked out", hovered beside a number. This
// one holds PARAGRAPHS and a link, which a native tooltip cannot do, cannot be
// reached on touch, and cannot be tabbed into.
//
// It goes through the shared Popover (rule 23) rather than positioning itself:
// portalled to document.body, so no card, table wrapper or overflow-x-auto
// ancestor can clip it; closes on outside click, Escape and ancestor scroll;
// returns focus to the trigger; flips above when there is no room below.
//
// THE GUIDE LINK IS NOT OPTIONAL, and that is the rule rather than a nicety: the
// panel is a summary, and a summary with nowhere to go is just a smaller wall of
// text. `guideAnchor` is the slug of a heading in docs/USER-GUIDE.md — an H3
// there becomes `#counting-a-location` — so the link lands on the task, not at
// the top of a 1,600-line document.

interface AboutNoteProps {
  // What the panel is about, shown as its heading and used as the button's
  // accessible name: "About stock takes", not "More information".
  title: string;
  // The explanation, one string per paragraph. Written wherever the module's
  // other copy lives (lib/*Labels.ts), never inline in a screen.
  paragraphs: string[];
  // The active property's slug, for the in-app guide link.
  propertySlug: string;
  // The heading slug in docs/USER-GUIDE.md this explanation was moved into.
  guideAnchor: string;
  // How that section is called, so the link says where it goes.
  guideLabel: string;
}

export function AboutNote({
  title,
  paragraphs,
  propertySlug,
  guideAnchor,
  guideLabel,
}: AboutNoteProps) {
  const [open, setOpen] = useState(false);
  // State, via a callback ref, never a ref read during render: React does not
  // re-render when `.current` changes, so the popover would position against
  // whatever was there on the previous pass (rule 23).
  const [trigger, setTrigger] = useState<HTMLButtonElement | null>(null);

  return (
    <>
      <button
        ref={setTrigger}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={title}
        className="inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border border-sand-border bg-white/70 text-xs font-semibold leading-none text-charcoal-muted transition-colors hover:bg-sand hover:text-charcoal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream"
      >
        <span aria-hidden="true">i</span>
      </button>

      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchor={trigger}
        align="left"
        role="dialog"
        ariaLabel={title}
        // Capped against the VIEWPORT, not against a parent: at 360px the panel
        // has to fit the phone, and its parent card is not what constrains it
        // once it is portalled to the body.
        className="w-[min(22rem,calc(100vw-1.5rem))] p-4"
      >
        <h2 className="text-sm font-semibold text-charcoal">{title}</h2>
        {paragraphs.map((text) => (
          <p key={text.slice(0, 40)} className="mt-2 text-sm text-charcoal-muted">
            {text}
          </p>
        ))}
        <Link
          to={`/admin/${propertySlug}/help#${guideAnchor}`}
          onClick={() => setOpen(false)}
          className="mt-3 inline-block text-sm font-semibold text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream"
        >
          {guideLabel} — in the staff guide
        </Link>
      </Popover>
    </>
  );
}
