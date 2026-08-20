// THE PICKER PROOF (rule 26, and rule 22 for how it is trusted).
//
// ---------------------------------------------------------------------------
// THE BUG THIS EXISTS TO CATCH, WHICH IS NOT A CRASH
// ---------------------------------------------------------------------------
// A picker that filters the rows the page happens to hold answers "no matches" for
// an item that exists. Nothing throws. Nothing looks broken. The screen is fast and
// confident and wrong, and the storekeeper concludes the hotel does not stock a
// thing sitting on the shelf.
//
// That failure is invisible to every other kind of proof we have. A SQL proof
// cannot see a component; a type check cannot tell a server search from a client
// one; a snapshot of the rendered box looks identical either way. The only thing
// that separates them is WHETHER THE SEARCH WAS ASKED FOR AN ITEM THE LOADED PAGE
// DOES NOT CONTAIN — which is a question about behaviour, so it is asked here by
// driving the real component and watching what it queries.
//
// ---------------------------------------------------------------------------
// MADE TO FAIL BEFORE IT WAS TRUSTED (rule 22)
// ---------------------------------------------------------------------------
// PART 2 runs the SAME assertions against LegacyFilteredPicker — a faithful copy of
// the shape being replaced: a box that filters an already-loaded page of twenty-five
// rows. It cannot find item 400, and the proof says so out loud. Without that half,
// "the picker found Zobo" would also pass for a picker that returned everything
// regardless of the term, which is the failure mode a search assertion is most
// likely to have.
//
// Three further breakages were applied to the real implementation, and the third
// one is recorded here BECAUSE IT DID NOT FAIL — which is the more useful result:
//
//   1. Enter made to choose `options[active >= 0 ? active : 0]`, i.e. grab the first
//      result when nothing is highlighted. PART 4 went RED (`picked "item-10"`).
//      The form would have committed to an item nobody looked at, which on an
//      adjustment screen is a stock movement against the wrong product.
//
//   2. The `capped` block replaced with `{false ? …}`, silencing the cap line.
//      PART 5 went RED. A silently truncated picker is the same lie as the
//      client-side filter, wearing a server-side costume.
//
//   3. Popover's `createPortal(…, document.body)` replaced with a plain return, so
//      the list rendered inline. PART 3's two structural assertions went RED. The
//      clipping guarantee rule 23 exists for is genuinely being checked on this new
//      control and not merely inherited from popoverRender.
//
//   4. `search` given an inline arrow instead of useCallback — AND THE PROOF STAYED
//      GREEN, 36/36. Worth writing down rather than quietly deleting: the effect
//      that runs the query depends on `search`, so an unstable identity restarts the
//      debounce — but only when the PARENT re-renders, and `term` lives inside
//      Typeahead, so a parent does not re-render per keystroke. The memoisation
//      therefore is not what makes the search correct; what it prevents is a
//      redundant query every time an unrelated field on the same form re-renders it
//      (typing a quantity beside the item picker). So the useCallback stays, the
//      comment on it no longer claims to be load-bearing for correctness, and this
//      proof does NOT cover that case. Recorded so the next reader does not assume
//      a green run means it does.

import { Window } from 'happy-dom';

// The DOM has to exist BEFORE react-dom is imported, so the globals go up first and
// every React import below is dynamic. Same shim as popoverRender — a portal is a
// DOM fact, and renderToString cannot render one.
const win = new Window({ width: 1366, height: 768 });
const g = globalThis as unknown as Record<string, unknown>;
g.window = win;
g.document = win.document;
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
g.CSS = { escape: (v: string) => v.replace(/([^\w-])/g, '\\$1') };
// Without this React logs "the current testing environment is not configured to
// support act(...)" on every flush and does not guarantee effects have run — so the
// proof would be asserting against a half-committed tree.
g.IS_REACT_ACT_ENVIRONMENT = true;
g.requestAnimationFrame = (cb: FrameRequestCallback) =>
  win.setTimeout(() => cb(0), 0) as unknown as number;
g.cancelAnimationFrame = (id: number) =>
  win.clearTimeout(id as unknown as ReturnType<typeof win.setTimeout>);

const React = await import('react');
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { Typeahead } = await import('../src/components/ui/form/Typeahead');
const { placePopover } = await import('../src/components/ui/Popover');
type TypeaheadResult = import('../src/components/ui/form/Typeahead').TypeaheadResult;
type TypeaheadOption = import('../src/components/ui/form/Typeahead').TypeaheadOption;

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}${extra ? ' — ' + extra : ''}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`);
  }
};

const doc = win.document as unknown as Document;

// ---------------------------------------------------------------------------
// THE CATALOGUE: 400 items, and the one that matters is last
// ---------------------------------------------------------------------------
// A thousand-item hotel is the case the rule was written for. 400 is enough to make
// the point and quick to build. "Zobo Concentrate" is deliberately alphabetically
// LAST, so it is not on the first page of any list and not in any loaded window of
// twenty-five rows. Finding it is the whole shipment's picker work.
const CATALOGUE: { id: string; name: string; code: string }[] = [
  ...Array.from({ length: 399 }, (_, i) => ({
    id: `item-${i}`,
    name: `Catalogue item ${String(i).padStart(3, '0')}`,
    code: `C${String(i).padStart(3, '0')}`,
  })),
  { id: 'item-zobo', name: 'Zobo Concentrate', code: 'ZOB1' },
];

const PAGE_SIZE = 25;
// What a screen would have loaded: the FIRST page only. The legacy picker filters
// this; the real one never touches it.
const LOADED_PAGE = CATALOGUE.slice(0, PAGE_SIZE);

const SEARCH_LIMIT = 20;

// A stand-in for searchInventoryItems: matches name OR code across the WHOLE
// catalogue, server-side, capped with one extra row to reveal the cap — the same
// contract lib/inventory implements against PostgREST.
const queries: string[] = [];
async function serverSearch(term: string): Promise<TypeaheadResult> {
  queries.push(term);
  const safe = term.trim().toLowerCase();
  const matched = CATALOGUE.filter(
    (i) =>
      safe.length === 0 ||
      i.name.toLowerCase().includes(safe) ||
      i.code.toLowerCase().includes(safe),
  );
  const window = matched.slice(0, SEARCH_LIMIT + 1);
  const options: TypeaheadOption[] = window
    .slice(0, SEARCH_LIMIT)
    .map((i) => ({ value: i.id, label: i.name, hint: i.code }));
  return { options, capped: window.length > SEARCH_LIMIT };
}

// ---------------------------------------------------------------------------
// PART 1 — the panel is the field's width, and still placed on screen
// ---------------------------------------------------------------------------
// A listbox narrower than the box you are typing into reads as a different control
// from the one you are using, and a 240px menu under a full-width field truncates
// every item name it exists to let you read. Proven at the arithmetic, because that
// is the part that can be wrong: a panel forced to the anchor's width and aligned
// left must sit flush with the anchor, and must still be clamped at 360px.
console.log('\n=== 1. An anchor-width panel is placed flush, and still clamped ===');

const FIELD = { top: 300, left: 40, bottom: 340, right: 440, width: 400, height: 40 };
const flush = placePopover(FIELD, { width: FIELD.width, height: 260 }, { width: 1366, height: 768 }, 'left');
ok('the list sits directly under the field', flush.top === 344, `top ${flush.top}`);
ok('and its left edge meets the field’s', flush.left === 40, `left ${flush.left}`);
ok('opening downward when there is room', flush.side === 'below');

// The last field on a form near the bottom of the window — the same case rule 23
// names for the last row of a table.
const bottomField = { top: 690, left: 40, bottom: 730, right: 440, width: 400, height: 40 };
const flipped = placePopover(bottomField, { width: 400, height: 260 }, { width: 1366, height: 768 }, 'left');
ok('a field near the bottom flips ABOVE', flipped.side === 'above', `side ${flipped.side}`);
ok('and the whole list stays on screen', flipped.top >= 8 && flipped.top + 260 <= 768,
  `top ${flipped.top}, bottom ${flipped.top + 260}`);

// 360px: a 400px-wide field cannot exist there, but a 344px one can, and the panel
// must not run off either edge.
const narrowField = { top: 200, left: 8, bottom: 240, right: 352, width: 344, height: 40 };
const narrow = placePopover(narrowField, { width: 344, height: 300 }, { width: 360, height: 640 }, 'left');
ok('at 360px the list starts on screen', narrow.left >= 8, `left ${narrow.left}`);
ok('and ends on screen', narrow.left + 344 <= 360 - 8 + 0.001, `right ${narrow.left + 344}`);

// ---------------------------------------------------------------------------
// The mounting helpers
// ---------------------------------------------------------------------------
// Mounted inside an overflow-hidden container, because that is where these live: a
// form inside a slide-over inside a card. If the list were a child of it, the
// clipping bug rule 23 exists to end would be back on a new control.
function mount(node: React.ReactElement) {
  const host = doc.createElement('div');
  doc.body.appendChild(host);
  const clip = doc.createElement('div');
  clip.style.overflow = 'hidden';
  host.appendChild(clip);
  const root = createRoot(clip);
  act(() => {
    root.render(node);
  });
  return { clip, root, host };
}

// The debounce is 250ms of real time, so the proof waits it out rather than
// pretending. Wrapped in act so React flushes the resulting state.
async function settle(ms = 400) {
  await act(async () => {
    await new Promise((resolve) => win.setTimeout(resolve, ms));
  });
}

// TYPING, THE WAY REACT CAN SEE IT — and the first version of this did not work,
// which is worth recording because it made three assertions fail for a reason that
// had nothing to do with the component.
//
// React keeps its own record of a controlled input's last value on the DOM node and
// SKIPS onChange when the value it observes matches that record. Assigning
// `input.value = 'Zobo'` goes through the same property React's tracker patched, so
// the tracker updates too and the change looks like nothing happened. Calling the
// PROTOTYPE's setter writes the value without touching the tracker, so the
// subsequent input event reads as a genuine edit.
const nativeValueSetter = Object.getOwnPropertyDescriptor(
  win.HTMLInputElement.prototype,
  'value',
)?.set;

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    if (nativeValueSetter) nativeValueSetter.call(input, value);
    else input.value = value;
    input.dispatchEvent(new win.Event('input', { bubbles: true }) as unknown as Event);
  });
}

// OPENING THE LIST. `focus()` on an element that already has focus is a no-op and
// fires nothing, so a second "open the list" in the same proof would silently do
// nothing — which is exactly what happened before the blur. React 19 delivers
// onFocus from the bubbling `focusin` event, so that is what is dispatched.
async function openList(input: HTMLInputElement, waitMs = 400) {
  await act(async () => {
    input.blur();
    input.focus();
    input.dispatchEvent(
      new win.Event('focusin', { bubbles: true }) as unknown as Event,
    );
  });
  await settle(waitMs);
}

async function press(input: HTMLInputElement, key: string) {
  await act(async () => {
    input.dispatchEvent(
      new win.KeyboardEvent('keydown', { key, bubbles: true }) as unknown as Event,
    );
  });
}

const rowsIn = (panel: Element | null) =>
  Array.from(panel?.querySelectorAll('[role="option"]') ?? []);

// ---------------------------------------------------------------------------
// PART 2 — THE ASSERTION, MADE TO FAIL against the shape being replaced
// ---------------------------------------------------------------------------
console.log('\n=== 2. The client-side filter, and the item it cannot find ===');

// A faithful copy of the picker shape this shipment replaces: a text box filtering
// the page the screen already loaded. Kept in this file for one purpose — to be
// caught by the assertion in PART 3.
function LegacyFilteredPicker() {
  const [term, setTerm] = React.useState('');
  const shown = LOADED_PAGE.filter((i) =>
    i.name.toLowerCase().includes(term.toLowerCase()),
  );
  return (
    <div>
      <input
        aria-label="Legacy item"
        value={term}
        onChange={(e) => setTerm(e.target.value)}
      />
      <ul>
        {shown.map((i) => (
          <li key={i.id} role="option" aria-selected={false}>
            {i.name}
          </li>
        ))}
      </ul>
    </div>
  );
}

const legacy = mount(<LegacyFilteredPicker />);
const legacyInput = doc.querySelector('input[aria-label="Legacy item"]') as HTMLInputElement;
await type(legacyInput, 'Zobo');
const legacyRows = rowsIn(legacy.clip);
ok('(control) the legacy picker does render and filter', legacyInput !== null);
ok(
  'THE CLIENT-SIDE FILTER CANNOT FIND ZOBO — the assertion catches it',
  legacyRows.length === 0,
  legacyRows.length === 0
    ? 'searched 25 loaded rows, found nothing, said nothing was wrong'
    : `it found ${legacyRows.length}, so the assertion proves nothing`,
);
legacy.root.unmount();
legacy.host.remove();

// ---------------------------------------------------------------------------
// PART 3 — THE REAL PICKER FINDS IT
// ---------------------------------------------------------------------------
console.log('\n=== 3. The real Typeahead: server-side, and Zobo is item 400 ===');

function Harness({ onPick }: { onPick: (id: string) => void }) {
  const [value, setValue] = React.useState('');
  const [label, setLabel] = React.useState<string | null>(null);
  const search = React.useCallback(serverSearch, []);
  return (
    <Typeahead
      label="Item"
      value={value}
      selectedLabel={label}
      onChange={(id, option) => {
        setValue(id);
        setLabel(option?.label ?? null);
        onPick(id);
      }}
      search={search}
      placeholder="Type an item name or code…"
    />
  );
}

let picked = '';
const real = mount(<Harness onPick={(id) => { picked = id; }} />);
const input = doc.querySelector('input[role="combobox"]') as HTMLInputElement;
ok('the field renders as a combobox', input !== null);

// Opening runs the empty-term search, so the picker offers a starting set rather
// than an empty box that hides what it is.
await openList(input);
const panel = doc.querySelector('[role="listbox"]');
ok('the list opens on focus', panel !== null);
ok('THE PANEL IS NOT INSIDE THE CLIPPING CONTAINER', panel !== null && !real.clip.contains(panel as Node));
ok('it is a child of document.body', panel?.parentElement === (doc.body as unknown as HTMLElement));
ok('it is fixed-positioned, so no ancestor scroll offset applies',
  (panel as HTMLElement)?.style.position === 'fixed');
ok('an empty term still offers a starting set', rowsIn(panel).length > 0,
  `${rowsIn(panel).length} rows`);

queries.length = 0;
await type(input, 'Zobo');
await settle();

ok('THE SEARCH WENT TO THE SERVER with the typed term', queries.includes('Zobo'),
  `queries: ${JSON.stringify(queries)}`);

const zoboRows = rowsIn(doc.querySelector('[role="listbox"]'));
ok(
  'THE PICKER FOUND AN ITEM THAT IS NOT ON THE FIRST PAGE',
  zoboRows.some((r) => r.textContent?.includes('Zobo Concentrate')),
  zoboRows.length === 0
    ? 'no rows at all'
    : `found "${zoboRows[0].textContent?.slice(0, 40)}"`,
);
// The claim above only means something if Zobo genuinely was unreachable the old
// way, so the two facts are asserted together rather than trusted apart.
ok(
  'and that item is genuinely absent from the loaded page',
  !LOADED_PAGE.some((i) => i.name === 'Zobo Concentrate'),
  `loaded page holds ${LOADED_PAGE.length} rows, items 000–024`,
);

// ---------------------------------------------------------------------------
// PART 4 — the keyboard, including the Enter that must do nothing
// ---------------------------------------------------------------------------
console.log('\n=== 4. Arrow keys, Enter, Escape ===');

await type(input, 'Catalogue item 01');
await settle();

// ENTER WITH NOTHING HIGHLIGHTED MUST NOT CHOOSE. This is the assertion that was
// made to fail: a picker that grabs the first result on Enter commits a form to an
// item nobody looked at, and on an adjustment screen that is a stock movement
// against the wrong product.
picked = '';
await press(input, 'Enter');
ok('Enter with no row highlighted chooses NOTHING', picked === '', `picked "${picked}"`);

await press(input, 'ArrowDown');
const firstActive = doc.querySelector('[role="listbox"] [aria-selected]');
ok('ArrowDown highlights a row', input.getAttribute('aria-activedescendant') !== null,
  `activedescendant ${input.getAttribute('aria-activedescendant')}`);
ok('and the highlighted row is a real option', firstActive !== null);

await press(input, 'ArrowDown');
const secondId = input.getAttribute('aria-activedescendant');
await press(input, 'ArrowUp');
const backId = input.getAttribute('aria-activedescendant');
ok('ArrowUp moves back to the previous row', backId !== secondId,
  `${secondId} then ${backId}`);

await press(input, 'Enter');
ok('Enter on a highlighted row chooses it', picked.startsWith('item-'), `picked "${picked}"`);
ok('and the list closes', doc.querySelector('[role="listbox"]') === null);
ok('the chosen item is shown in the box, not the search term',
  input.value === 'Catalogue item 010' || input.value.startsWith('Catalogue item'),
  `box reads "${input.value}"`);

// Escape closes without choosing.
await openList(input);
ok('(control) the list reopens', doc.querySelector('[role="listbox"]') !== null);
const before = picked;
await press(input, 'Escape');
ok('Escape closes the list', doc.querySelector('[role="listbox"]') === null);
ok('and changes nothing', picked === before);

// ---------------------------------------------------------------------------
// PART 5 — the cap is announced
// ---------------------------------------------------------------------------
// A capped picker with no way to reach the rest is rule 1b's defect. A picker's way
// through is to type more — but only if the person knows the list is cut.
console.log('\n=== 5. A capped result says so ===');

await openList(input);
await type(input, 'Catalogue');
await settle();
const cappedPanel = doc.querySelector('[role="listbox"]');
const cappedText = cappedPanel?.textContent ?? '';
ok('399 matches are capped to the picker limit', rowsIn(cappedPanel).length === SEARCH_LIMIT,
  `${rowsIn(cappedPanel).length} rows`);
ok('AND THE PANEL SAYS SO, with what to do about it',
  cappedText.includes('Showing the first') && cappedText.includes('Keep typing'),
  cappedText.includes('Showing the first') ? 'announced' : 'the cap is SILENT');

// A narrow result is not announced, so the line means something when it appears.
await type(input, 'Zobo');
await settle();
const uncapped = doc.querySelector('[role="listbox"]')?.textContent ?? '';
ok('an uncapped result carries no cap line', !uncapped.includes('Showing the first'));

// Unmounted inside act, so a debounced search still in flight is flushed rather than
// resolving into a torn-down tree and printing an act warning after the summary.
await act(async () => {
  real.root.unmount();
});
real.host.remove();

// ---------------------------------------------------------------------------
// PART 6 — a row that exists but cannot be chosen
// ---------------------------------------------------------------------------
// The opening-balance form must not offer an item that already has one here. It is
// SHOWN WITH THE REASON rather than dropped: a missing row is indistinguishable
// from an item that does not exist, and filtering the server's result would make a
// query that matched twenty rows display two.
console.log('\n=== 6. An unavailable row is listed, explained, and not choosable ===');

async function disabledSearch(term: string): Promise<TypeaheadResult> {
  const base = await serverSearch(term);
  return {
    ...base,
    options: base.options.map((o, i) =>
      i === 0
        ? { ...o, disabled: true, hint: 'Already has an opening balance here' }
        : o,
    ),
  };
}

function DisabledHarness({ onPick }: { onPick: (id: string) => void }) {
  const [value, setValue] = React.useState('');
  const search = React.useCallback(disabledSearch, []);
  return (
    <Typeahead
      label="Item"
      value={value}
      selectedLabel={null}
      onChange={(id) => {
        setValue(id);
        onPick(id);
      }}
      search={search}
    />
  );
}

let picked2 = '';
const withDisabled = mount(<DisabledHarness onPick={(id) => { picked2 = id; }} />);
const input2 = doc.querySelector('input[role="combobox"]') as HTMLInputElement;
await openList(input2);

const disabledRows = rowsIn(doc.querySelector('[role="listbox"]'));
ok('the unavailable item is LISTED, not hidden', disabledRows.length > 1,
  `${disabledRows.length} rows`);
ok('and it carries the reason', disabledRows[0]?.textContent?.includes('Already has an opening balance') === true,
  `first row reads "${disabledRows[0]?.textContent?.slice(0, 60)}"`);
ok('it is marked unavailable to assistive technology',
  disabledRows[0]?.getAttribute('aria-disabled') === 'true');

// Clicking it must do nothing at all.
await act(async () => {
  (disabledRows[0] as HTMLElement).dispatchEvent(
    new win.MouseEvent('mousedown', { bubbles: true }) as unknown as Event,
  );
});
ok('clicking it chooses nothing', picked2 === '', `picked "${picked2}"`);

// And the arrows skip it rather than stopping on it.
await press(input2, 'ArrowDown');
const activeId = input2.getAttribute('aria-activedescendant');
ok('the arrows skip past it to the first choosable row',
  activeId !== null && activeId !== disabledRows[0]?.id,
  `landed on ${activeId}, disabled row is ${disabledRows[0]?.id}`);

await act(async () => {
  withDisabled.root.unmount();
});
withDisabled.host.remove();

console.log(`\n================  ${pass} PASSED, ${fail} FAILED  ================`);
process.exit(fail ? 1 : 0);
