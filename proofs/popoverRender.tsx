// THE CLIPPING PROOF.
//
// A kebab on a stock count row opened and was cut in half: it was an
// absolutely-positioned child of the table's `overflow-x-auto` wrapper, so the
// wrapper clipped it and most of the menu could not be reached.
//
// A SQL proof cannot see this, and neither can renderToString — portals are not
// supported by the server renderer, which is itself the point: a portal is a DOM
// fact, so proving it needs a DOM. This mounts the REAL ActionMenu inside a
// container with `overflow: hidden` and asserts the panel is not a descendant of
// that container.
//
// ---------------------------------------------------------------------------
// AND IT WAS MADE TO FAIL FIRST (rule 22)
// ---------------------------------------------------------------------------
// PART 2 runs every assertion against LegacyInlineMenu — a copy of the markup
// this fix replaced, kept in this file for no other purpose. It is clipped, and
// the proof says so. Without that, "the panel is not inside the container" would
// also pass for a menu that never rendered at all, which is the failure mode a
// clipping assertion is most likely to have.

import { Window } from 'happy-dom';

// The DOM has to exist BEFORE react-dom is imported, so the globals go up first
// and every React import below is dynamic.
const win = new Window({ width: 1366, height: 768 });
const g = globalThis as unknown as Record<string, unknown>;
g.window = win;
g.document = win.document;
// `navigator` is a getter-only property on Node's globalThis, so it is defined
// rather than assigned. React reads it during hydration checks.
Object.defineProperty(globalThis, 'navigator', {
  value: win.navigator,
  configurable: true,
  writable: true,
});
g.HTMLElement = win.HTMLElement;
g.Element = win.Element;
g.Node = win.Node;
g.MouseEvent = win.MouseEvent;
g.KeyboardEvent = win.KeyboardEvent;
g.PointerEvent = win.PointerEvent ?? win.MouseEvent;
g.Event = win.Event;
g.getComputedStyle = win.getComputedStyle.bind(win);
// The DOM says a frame handle is a `number`; happy-dom's timers hand back a
// Timeout object. The two casts are the shim admitting that, in the one place
// the mismatch exists — this file is the adapter between the two, and an
// adapter is where a cast belongs. (Only visible since the proofs began being
// typechecked; it ran correctly all along.)
g.requestAnimationFrame = (cb: FrameRequestCallback) =>
  win.setTimeout(() => cb(0), 0) as unknown as number;
g.cancelAnimationFrame = (id: number) =>
  win.clearTimeout(id as unknown as ReturnType<typeof win.setTimeout>);

const React = await import('react');
const { flushSync } = await import('react-dom');
const { createRoot } = await import('react-dom/client');
const { ActionMenu } = await import('../src/components/ui/ActionMenu');
const { AboutNote } = await import('../src/components/ui/AboutNote');
const { MemoryRouter } = await import('react-router-dom');
const { placePopover } = await import('../src/components/ui/Popover');

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
};

const doc = win.document as unknown as Document;

// ---------------------------------------------------------------------------
// PART 1 — the positioning arithmetic, which is pure and can be proven exactly
// ---------------------------------------------------------------------------
console.log('\n=== 1. placePopover: flip, clamp and the last row of a table ===');

const VIEW = { width: 1366, height: 768 };
const PANEL = { width: 240, height: 180 };
const anchorAt = (top: number, left: number, w = 32, h = 32) => ({
  top, left, bottom: top + h, right: left + w, width: w, height: h,
});

// A row in the middle of the page: straight down, no drama.
const middle = placePopover(anchorAt(300, 1000), PANEL, VIEW);
ok('a mid-page trigger opens BELOW', middle.side === 'below');
ok('directly under the trigger', middle.top === 336, `top ${middle.top}`);
ok('right-aligned to the trigger', middle.left === 1032 - 240 + 0, `left ${middle.left}`);

// THE CASE THAT BREAKS: the last row of a table, near the bottom of the window.
const lastRow = placePopover(anchorAt(700, 1000), PANEL, VIEW);
ok('a trigger near the BOTTOM flips ABOVE', lastRow.side === 'above', `side ${lastRow.side}`);
ok('and sits entirely on screen', lastRow.top >= 8 && lastRow.top + PANEL.height <= 768,
  `top ${lastRow.top}, bottom ${lastRow.top + PANEL.height}`);
ok('clearing the trigger rather than covering it', lastRow.top + PANEL.height <= 700,
  `panel bottom ${lastRow.top + PANEL.height} vs trigger top 700`);

// 360px — the other mandated width. A 240px right-aligned panel under a trigger
// near the left edge would be placed at a negative x without clamping.
const narrow = placePopover(anchorAt(300, 20), PANEL, { width: 360, height: 640 });
ok('at 360px the panel never starts off the left edge', narrow.left >= 8, `left ${narrow.left}`);
ok('and never runs off the right edge', narrow.left + PANEL.width <= 360 - 8,
  `right ${narrow.left + PANEL.width}`);

// A panel taller than the window has nowhere good to go; it must still be on it.
const huge = placePopover(anchorAt(700, 1000), { width: 240, height: 900 }, VIEW);
ok('a panel taller than the window is pinned on screen, not off it', huge.top === 8, `top ${huge.top}`);

// Flipping must only happen when above is genuinely roomier.
const tightBoth = placePopover(anchorAt(360, 1000), PANEL, { width: 1366, height: 760 });
ok('with more room below than above it stays below', tightBoth.side === 'below');

// ---------------------------------------------------------------------------
// PART 2 — THE ASSERTION, MADE TO FAIL against the markup this replaced
// ---------------------------------------------------------------------------
console.log('\n=== 2. The clipping assertion, proven against the OLD markup ===');

// The shape every menu in this codebase used before the fix: an absolutely
// positioned panel inside the row. Kept ONLY so the assertion below can be shown
// to catch it.
function LegacyInlineMenu({ label }: { label: string }) {
  const [open, setOpen] = React.useState(false);
  return (
    <div style={{ position: 'relative' }}>
      <button type="button" aria-label={label} onClick={() => setOpen((v) => !v)}>
        ⋮
      </button>
      {open ? (
        <div role="menu" aria-label={label} data-legacy="true" style={{ position: 'absolute' }}>
          <button type="button" role="menuitem">Open the report</button>
          <button type="button" role="menuitem">Undo this count</button>
        </div>
      ) : null}
    </div>
  );
}

// Mount a row inside a container that clips, exactly as the counts table does.
function mount(node: React.ReactElement) {
  const host = doc.createElement('div');
  doc.body.appendChild(host);
  const clip = doc.createElement('div');
  clip.setAttribute('id', 'clip');
  clip.style.overflow = 'hidden';
  host.appendChild(clip);
  const root = createRoot(clip);
  flushSync(() => root.render(node));
  return { clip, root, host };
}

const openMenu = (clip: Element, label: string) => {
  const trigger = doc.querySelector(`button[aria-label="${label}"]`) as HTMLElement;
  flushSync(() => trigger.click());
  return {
    trigger,
    panel: doc.querySelector(`[role="menu"][aria-label="${label}"]`),
    clip,
  };
};

// --- the OLD component: the assertion must FAIL it ---
const legacy = mount(<LegacyInlineMenu label="Legacy count" />);
const legacyOpen = openMenu(legacy.clip, 'Legacy count');
ok('(control) the legacy menu does open', legacyOpen.panel !== null);
const legacyClipped = legacy.clip.contains(legacyOpen.panel as Node);
ok('THE OLD MARKUP IS CLIPPED — the assertion catches it', legacyClipped === true,
  legacyClipped ? 'panel is a descendant of the overflow:hidden container' : 'assertion did NOT catch it');
legacy.root.unmount();
legacy.host.remove();

// --- the REAL component: the same assertion must PASS it ---
console.log('\n=== 3. The real ActionMenu, mounted inside overflow: hidden ===');
const items = [
  { key: 'open', label: 'Open the report', hint: 'Line by line', onSelect: () => {} },
  { key: 'print', label: 'Print or save as PDF', onSelect: () => {} },
  { key: 'undo', label: 'Undo this count', tone: 'danger' as const, onSelect: () => {} },
];
const real = mount(
  <table><tbody><tr><td>
    <ActionMenu label="Actions for count ST-000004" items={items} />
  </td></tr></tbody></table>,
);
const realOpen = openMenu(real.clip, 'Actions for count ST-000004');

ok('the menu opens', realOpen.panel !== null);
ok('THE PANEL IS NOT INSIDE THE CLIPPING CONTAINER',
  realOpen.panel !== null && !real.clip.contains(realOpen.panel as Node));
ok('it is a child of document.body',
  realOpen.panel?.parentElement === (doc.body as unknown as HTMLElement));
ok('it is fixed-positioned, so no ancestor scroll offset applies',
  (realOpen.panel as HTMLElement)?.style.position === 'fixed');
ok('every item is present and reachable',
  (realOpen.panel?.querySelectorAll('[role="menuitem"]').length ?? 0) === 3,
  `${realOpen.panel?.querySelectorAll('[role="menuitem"]').length} items`);
ok('the trigger reports it is expanded',
  realOpen.trigger.getAttribute('aria-expanded') === 'true');
ok('focus moved to the first item, so a keyboard user is in the menu',
  (doc.activeElement as HTMLElement)?.textContent?.includes('Open the report') === true,
  `focus on "${(doc.activeElement as HTMLElement)?.textContent?.slice(0, 24)}"`);

// --- dismissal ---
console.log('\n=== 4. It closes the three ways, and hands focus back ===');

// Escape
flushSync(() => {
  doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }) as unknown as Event);
});
ok('Escape closes it', doc.querySelector('[role="menu"][aria-label="Actions for count ST-000004"]') === null);
ok('and focus returns to the trigger', doc.activeElement === realOpen.trigger);

// Outside pointer press
const again = openMenu(real.clip, 'Actions for count ST-000004');
ok('(control) it reopens', again.panel !== null);
flushSync(() => {
  doc.body.dispatchEvent(new win.MouseEvent('pointerdown', { bubbles: true }) as unknown as Event);
});
ok('an outside press closes it',
  doc.querySelector('[role="menu"][aria-label="Actions for count ST-000004"]') === null);

// Ancestor scroll — the one that `position: fixed` makes mandatory.
const third = openMenu(real.clip, 'Actions for count ST-000004');
ok('(control) it reopens again', third.panel !== null);
flushSync(() => {
  real.clip.dispatchEvent(new win.Event('scroll', { bubbles: false }) as unknown as Event);
});
ok('scrolling an ancestor closes it, rather than leaving it pointing at nothing',
  doc.querySelector('[role="menu"][aria-label="Actions for count ST-000004"]') === null);

// A click on an item must NOT be swallowed by the outside-press handler — the
// classic portal bug, since the panel is not inside the trigger's subtree.
console.log('\n=== 5. Choosing an item works (the classic portal own-goal) ===');
let chose = '';
const chooser = mount(
  <ActionMenu
    label="Actions for count ST-000005"
    items={[{ key: 'undo', label: 'Undo this count', onSelect: () => { chose = 'undo'; } }]}
  />,
);
const chooserOpen = openMenu(chooser.clip, 'Actions for count ST-000005');
const item = chooserOpen.panel?.querySelector('[role="menuitem"]') as HTMLElement;
flushSync(() => {
  item.dispatchEvent(new win.MouseEvent('pointerdown', { bubbles: true }) as unknown as Event);
});
ok('a pointerdown on an ITEM does not close the menu first',
  doc.querySelector('[role="menu"][aria-label="Actions for count ST-000005"]') !== null);
flushSync(() => item.click());
ok('and choosing it runs the action', chose === 'undo', `chose "${chose}"`);
ok('then closes the menu',
  doc.querySelector('[role="menu"][aria-label="Actions for count ST-000005"]') === null);

real.root.unmount();
real.host.remove();
chooser.root.unmount();
chooser.host.remove();

// ---------------------------------------------------------------------------
// PART 6 — the ⓘ (rule 25), which is the same primitive with a different job
// ---------------------------------------------------------------------------
// It is proven HERE rather than in its own file because everything that can go
// wrong with it is floating-layer behaviour, and this is where that lives. What
// is specific to it: the panel holds PARAGRAPHS and a link into the staff guide,
// and the link is the half most likely to be quietly dropped in a later edit —
// a summary with nowhere to go is just a smaller wall of text.
//
// MADE TO FAIL: the <Link> was deleted from AboutNote and the proof re-run. RED
// on 4 — the link is gone, its href is gone, and the two focus assertions go
// with it, because with nothing focusable inside the panel Escape has nowhere to
// return focus FROM and leaves it on <body>. That second consequence was not
// designed for and is worth keeping: a panel with no way out is also a panel a
// keyboard user cannot get into.
console.log('\n=== 6. The ⓘ: a panel of paragraphs, and the way out of it ===');

const about = mount(
  <MemoryRouter>
    <div style={{ overflow: 'hidden' }}>
      <AboutNote
        title="About stock takes"
        paragraphs={['Starting a count takes a snapshot.', 'One count at a time per location.']}
        propertySlug="heledon"
        guideAnchor="counting-a-location"
        guideLabel="Counting a location"
      />
    </div>
  </MemoryRouter>,
);

const noteTrigger = doc.querySelector('button[aria-label="About stock takes"]') as HTMLElement;
ok('the ⓘ is a real button, so touch and keyboard reach it', noteTrigger !== null);
ok('and it is closed until asked', noteTrigger?.getAttribute('aria-expanded') === 'false');

flushSync(() => noteTrigger.click());
const notePanel = doc.querySelector('[role="dialog"][aria-label="About stock takes"]');
ok('it opens', notePanel !== null);
ok('OUTSIDE the clipping container, like every other floating layer',
  notePanel !== null && !about.clip.contains(notePanel as Node));
ok('it holds every paragraph it was given',
  (notePanel?.querySelectorAll('p').length ?? 0) === 2,
  `${notePanel?.querySelectorAll('p').length} paragraphs`);

// THE LINK. Not decoration: the panel is a summary, and rule 25 says the full
// text lives in the guide. This asserts the href lands on the SECTION, not on
// the top of a 1,600-line document.
const guideLink = notePanel?.querySelector('a') as HTMLAnchorElement | null;
ok('it offers the guide', guideLink !== null);
ok('and links to the right section of it',
  guideLink?.getAttribute('href') === '/admin/heledon/help#counting-a-location',
  guideLink?.getAttribute('href') ?? '(no href)');

// A keyboard user tabs INTO the panel to reach the guide link. Escape from
// there must put them back on the ⓘ, not drop them at the top of the document —
// which is the whole reason the primitive tracks where focus was. Focus is moved
// explicitly here because a synthetic .click() does not focus a button the way a
// real pointer does, so asserting it without this would be asserting happy-dom.
flushSync(() => guideLink?.focus());
ok('(setup) focus can reach the guide link inside the panel',
  doc.activeElement === guideLink);
flushSync(() => {
  doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }) as unknown as Event);
});
ok('Escape closes it',
  doc.querySelector('[role="dialog"][aria-label="About stock takes"]') === null);
ok('and hands focus back to the ⓘ, not to the document',
  doc.activeElement === noteTrigger,
  `focus on <${(doc.activeElement as HTMLElement)?.tagName?.toLowerCase()}>`);

about.root.unmount();
about.host.remove();

console.log(`\n================  ${pass} PASSED, ${fail} FAILED  ================`);
process.exit(fail ? 1 : 0);
