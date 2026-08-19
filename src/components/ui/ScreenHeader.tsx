import type { ReactNode } from 'react';
import { AboutNote } from './AboutNote';

// THE TOP OF EVERY SCREEN (CLAUDE.md rule 25), as a component rather than as a
// convention.
//
// ---------------------------------------------------------------------------
// WHY THIS IS A PRIMITIVE AND NOT A HOUSE STYLE
// ---------------------------------------------------------------------------
// The rule — one line of purpose, then the controls; the rest behind a single ⓘ
// and in the staff guide — was first applied to the inventory tabs by hand. Hand
// application lasts exactly as long as somebody remembers it. The Stock Take tab
// had drifted to six things to read before the first button, one paragraph at a
// time, each of them added by somebody being helpful.
//
// So the shape is the component's, not the author's:
//
//   * `purpose` is ONE STRING, not a node and not a list. There is nowhere to
//     put a second paragraph without deleting this component and writing your
//     own header, which is a thing a reviewer can see.
//   * `about` is at most ONE ⓘ, and it CANNOT be given without a guide anchor —
//     the type requires it. A panel with nowhere to go is just a smaller wall of
//     text (see AboutNote).
//   * `actions` sit on the same row as the title, so the thing you came to press
//     is level with the thing that names the screen — never below a paragraph.
//
// WHAT DOES NOT BELONG IN `purpose`: how the figures are worked out, why the
// screen is shaped the way it is, what a word means, what happens if you press
// the button. All of that goes in `about` and in docs/USER-GUIDE.md. The test is
// blunt — if it is not what the screen is FOR, it is not the purpose line.
//
// ---------------------------------------------------------------------------
// LEVEL 1 AND LEVEL 2
// ---------------------------------------------------------------------------
// A page has one <h1>. A tab inside a page is its own screen to the person using
// it and gets an <h2> — same shape, same rule, smaller type. The inventory tabs
// are level 2 under one level-1 page header; a page with no tabs uses level 1
// and nothing else.

interface AboutSpec {
  // "About stock takes" — what the panel is about, not "More information".
  title: string;
  // One string per paragraph. Written in the module's labels file, never inline.
  paragraphs: string[];
  // The heading slug in docs/USER-GUIDE.md this explanation lives in, and how
  // that section is called. Both required: the panel is a summary, and a summary
  // must say where the rest of it is.
  guideAnchor: string;
  guideLabel: string;
}

interface ScreenHeaderProps {
  // The screen's name. A noun: "Bookings", "Adjustments".
  title: string;
  // ONE SENTENCE saying what the screen is for, in the words the person using it
  // would use. Optional only because a few screens are named so plainly that a
  // line under them would be repeating the title.
  purpose?: string;
  about?: AboutSpec;
  // Required when `about` is given — the ⓘ links into this property's guide.
  propertySlug?: string;
  // The screen's primary controls, level with the title.
  actions?: ReactNode;
  level?: 1 | 2;
  className?: string;
}

export function ScreenHeader({
  title,
  purpose,
  about,
  propertySlug,
  actions,
  level = 1,
  className = '',
}: ScreenHeaderProps) {
  const Heading = level === 1 ? 'h1' : 'h2';
  const headingClass =
    level === 1
      ? 'text-2xl font-bold tracking-tight text-charcoal'
      : 'text-base font-semibold text-charcoal';

  return (
    <header
      className={`flex flex-wrap items-start justify-between gap-3 ${className}`}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <Heading className={headingClass}>{title}</Heading>
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
        {/* ONE line, and the component renders exactly one <p> — there is no
            prop that produces a second. */}
        {purpose ? (
          <p className="mt-1 max-w-2xl text-sm text-charcoal-muted">{purpose}</p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      ) : null}
    </header>
  );
}
