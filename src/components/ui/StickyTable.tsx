import type { ReactNode } from 'react';

// A TABLE WHOSE HEADINGS STAY PUT (1.1h1).
//
// ---------------------------------------------------------------------------
// WHY THIS IS A PRIMITIVE AND NOT THREE CLASSES ON ONE SCREEN
// ---------------------------------------------------------------------------
// Getting a sticky table header right takes two non-obvious decisions, and
// getting either wrong produces a header that silently does NOTHING — it
// renders, it looks correct, and it scrolls away. That is precisely the kind of
// thing that gets re-guessed per screen until four tables have four behaviours.
// Several tables in this app will want it; the knowledge lives here once.
//
// ---------------------------------------------------------------------------
// THE TWO DECISIONS, EACH MEASURED IN A REAL BROWSER RATHER THAN REASONED ABOUT
// ---------------------------------------------------------------------------
// 1. THE PANE MUST HAVE A HEIGHT, AND ITS OWN VERTICAL SCROLL.
//
//    The obvious wrapper — `overflow-x-auto`, which every other table in this
//    codebase uses so a wide table scrolls sideways at 360px — DOES NOT WORK.
//    Per CSS, setting one overflow axis to a non-visible value computes the
//    OTHER axis to `auto` as well: `overflow-x: auto` gives you
//    `overflow-y: auto` whether you asked for it or not. The wrapper is then a
//    vertical scroll container with no height limit, so it never scrolls
//    vertically, so a sticky child inside it sticks to a scrollport that never
//    moves. Nothing errors and the header simply scrolls off.
//
//    MEASURED: with `overflow-x-auto`, after scrolling the page 400px the header
//    row sat at −233px — gone, past the layout header. In a height-capped
//    `overflow: auto` pane, after scrolling the pane 400px the header sat at
//    1314px against a pane top of 1313px: stuck, one pixel of border away.
//
//    So the pane caps its height and scrolls BOTH ways itself. The sticky offset
//    is then measured from the PANE, not from the page, which is why `top-0` is
//    correct here and no layout-header offset is involved.
//
// 2. STICKY GOES ON THE `<th>`, NEVER ON THE `<tr>`.
//
//    Chrome computes `position: sticky` on a `<tr>` (the probe confirmed it), but
//    Safari has historically not laid it out, and the failure is invisible on the
//    machine you developed on. Sticky on the cells themselves is supported
//    everywhere and costs nothing.
//
// ---------------------------------------------------------------------------
// THE COST, STATED RATHER THAN HIDDEN
// ---------------------------------------------------------------------------
// A capped pane means the table scrolls inside a box instead of with the page.
// For a reference list somebody scans — a chart of accounts — that is the better
// behaviour and it is what "like a spreadsheet" means. For a list somebody reads
// top to bottom once, it is worse, and those tables should keep the plain
// `overflow-x-auto` wrapper. This primitive is opt-in for that reason.

interface StickyTablePaneProps {
  children: ReactNode;
  // Tailwind max-height class. Defaults to something that leaves the page
  // header and the tab strip visible on a laptop at 1366×768.
  maxHeightClass?: string;
  className?: string;
}

export function StickyTablePane({
  children,
  maxHeightClass = 'max-h-[65vh]',
  className = '',
}: StickyTablePaneProps) {
  return (
    <div
      className={`${maxHeightClass} overflow-auto rounded-2xl border border-sand-border bg-white/60 ${className}`}
    >
      {children}
    </div>
  );
}

// THE CLASSES, EXPORTED SO A CALLER CANNOT GET THE OFFSETS OUT OF STEP.
//
// The column header is `top-0` because the pane is the scroll context. The group
// header sits exactly one header-row lower — which is why the column header has
// an EXPLICIT HEIGHT (`h-9` = 36px) rather than being sized by its padding: a
// group header offset that has to guess the row above it is an offset that goes
// wrong the first time somebody changes the font size.
export const STICKY_HEAD_CELL =
  'sticky top-0 z-20 h-9 bg-sand text-xs font-medium text-charcoal-muted';

export const STICKY_GROUP_CELL =
  'sticky top-9 z-10 border-y border-sand-border bg-sand/95 px-3 py-1.5 text-left text-xs font-semibold uppercase tracking-wide text-charcoal backdrop-blur-sm';
