import { useEffect, useState } from 'react';

// IS THIS A PHONE (1.1a2). Lives here rather than beside DataTable because it is
// a hook, this is where the hooks are, and a file that exports both a hook and a
// component is one Fast Refresh cannot reload cleanly.
//
// WHY THE BREAKPOINT IS JAVASCRIPT AND NOT CSS, which is the arguable part of
// that shipment. The cheap version is to let the cells restack with
// `display:block` and put the header text in `data-label` attributes. Rejected
// for three reasons, none of them about testing:
//
//   1. A CARD IS A REGROUPING, NOT A RESTACK. The card puts the item name and
//      the inputs that belong to it in one container; CSS can reorder and
//      restack cells but cannot nest them differently.
//   2. `data-label` IS A STRING. Two of the tables it serves carry two-line
//      headers ("Ordered / at the agreed price") and one carries a ReactNode,
//      and a string attribute cannot hold either.
//   3. RENDERING BOTH SHAPES AND HIDING ONE is the other CSS answer, and it puts
//      every input in the document twice — two nodes bound to one piece of
//      state, two ids, two things a screen reader finds. Unacceptable on a form.
//
// So the shape is chosen here, which means there is exactly one input per field
// at any width.

const NARROW_QUERY = '(max-width: 767px)';

// THE BREAKPOINT IS TAILWIND'S `md`, NOT A NEW ONE. 768px is already the token
// every other responsive decision in this codebase is made against; inventing a
// breakpoint for one module is how a product ends up with four of them, each
// correct for the screen somebody had open at the time.
export function useIsNarrow(): boolean {
  // Read synchronously rather than defaulting to false and correcting after
  // mount: this is a client-only SPA, so the first paint can be right, and a
  // table that flashes before becoming cards is a flash on the one device the
  // cards exist for.
  const [narrow, setNarrow] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia(NARROW_QUERY).matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia(NARROW_QUERY);
    const onChange = () => setNarrow(mq.matches);
    // Re-read on mount as well as on change: a value captured in useState's
    // initialiser is from before any CSS settled, and rotating a phone fires
    // the listener but nothing else would.
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  return narrow;
}
