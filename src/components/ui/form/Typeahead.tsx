import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { FieldShell, controlClasses, type BaseFieldProps } from './FieldShell';
import { Popover } from '../Popover';
import { ChevronDownIcon, SearchIcon } from '../icons';

// THE SEARCHABLE PICKER (CLAUDE.md rule 26) — one primitive, so every selector
// that can outgrow a dropdown behaves the same way.
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS
// ---------------------------------------------------------------------------
// A hotel with a thousand items cannot scroll a dropdown. That is the visible
// half of the problem and the easy half to fix. The half that actually costs
// something is what a naive fix does:
//
//   A CLIENT-SIDE FILTER SEARCHES WHAT WAS FETCHED, NOT WHAT EXISTS. Type "zobo"
//   into a box filtering the twenty-five rows the page happens to hold and it
//   answers "no matches" — instantly, confidently, and wrongly, because Zobo is
//   item four hundred. Nothing errors. Nothing looks broken. The storekeeper
//   concludes the hotel does not stock it and raises a purchase for something
//   already on the shelf.
//
// So `search` is a QUERY, run against the same table and the same filters the
// underlying list uses. This component owns the debounce, the keyboard, the
// cancellation and the panel; it owns NO opinion about what is searchable, which
// is what keeps one implementation serving items, locations and whatever comes
// next.
//
// ---------------------------------------------------------------------------
// THE CAP IS ANNOUNCED, NEVER SILENT
// ---------------------------------------------------------------------------
// A search returns at most a page, and rule 1b is explicit that a capped surface
// with no way to reach the rest is worse than an uncapped one. A picker's way to
// reach the rest is TO TYPE MORE — that is the control, and it is why a cap is
// legitimate here and not on a list. But it only works if the person knows the
// list is cut: `capped` renders "showing the first N — keep typing to narrow it",
// out loud, in the panel. Without that line this would be the same lie as the
// client-side filter, wearing a server-side costume.
//
// ---------------------------------------------------------------------------
// THE SELECTED LABEL COMES FROM THE CALLER, AND THAT IS DELIBERATE
// ---------------------------------------------------------------------------
// Once something is chosen, the row that describes it is usually NOT in the
// current search result — the box has been cleared, or the user has typed
// something else since. A component that displayed `options.find(o => o.value ===
// value)?.label` would show the chosen item's name until the next keystroke and
// then show an empty box, which reads as having lost the selection. So the caller
// passes `selectedLabel`: it holds the chosen row anyway (it needs it to submit),
// and it is the only place that can answer for certain.
//
// ---------------------------------------------------------------------------
// PORTALLED, LIKE EVERY OTHER FLOATING LAYER (rule 23)
// ---------------------------------------------------------------------------
// The panel goes through the shared Popover, so no ancestor's overflow can clip
// it, it flips above the field when there is no room below, and it cannot grow a
// scrollbar on the card it sits in. Forms live inside scrolling slide-overs and
// overflow-hidden cards in this codebase; a listbox positioned any other way is
// one layout change away from being cut in half.

export interface TypeaheadOption {
  value: string;
  // The primary line — what the thing is called.
  label: string;
  // The second line: a code, a unit, a location kind. Optional, and worth having
  // where two items can share a name ("Coke" in two pack sizes).
  hint?: string;
  // LISTED BUT NOT CHOOSABLE, with the reason in `hint`. This exists instead of
  // filtering the row out, because a row that is absent is indistinguishable from
  // a row that does not exist — the storekeeper searches, finds nothing, and
  // cannot tell whether the item is missing or merely unavailable here. Shown and
  // explained is the honest version. (It is also what keeps the search
  // server-side: dropping rows after they arrive would cap-then-filter, and a
  // search returning twenty rows of which eighteen were dropped would look empty.)
  disabled?: boolean;
}

export interface TypeaheadResult {
  options: TypeaheadOption[];
  // TRUE when more matched than were returned — announced in the panel.
  capped: boolean;
}

interface TypeaheadProps extends BaseFieldProps {
  // The chosen option's value, or '' for nothing chosen.
  value: string;
  // What to show for the chosen value. See the header: the caller owns this
  // because the chosen row is usually not in the current result.
  selectedLabel?: string | null;
  onChange: (value: string, option: TypeaheadOption | null) => void;
  // THE SEARCH. Server-side, against the same filters the underlying list uses.
  // Called with '' when the panel first opens, so the picker offers a starting set
  // rather than an empty box that hides what it is.
  search: (term: string) => Promise<TypeaheadResult>;
  placeholder?: string;
  // What the panel says when a search matched nothing. Written by the caller
  // because "no items match" and "no locations match" are different sentences, and
  // the caller knows which noun it is picking.
  emptyMessage?: string;
  // Offer a way to un-choose. Off by default: most pickers here are required.
  clearable?: boolean;
}

// How long after the last keystroke the query runs. 250ms, matching the guest
// picker: long enough that typing a word is one query rather than five, short
// enough that it does not feel like waiting.
const DEBOUNCE_MS = 250;

export function Typeahead({
  value,
  selectedLabel,
  onChange,
  search,
  placeholder,
  emptyMessage = 'Nothing matches that.',
  clearable = false,
  ...base
}: TypeaheadProps) {
  // THE ANCHOR IS STATE, NOT A REF (the ActionMenu note, and the same defect):
  // React does not re-render when a ref's .current changes, so a Popover handed
  // trigger.current during render would position against whatever was there on the
  // previous pass. A callback ref into state makes the input a real reactive value.
  const [input, setInput] = useState<HTMLInputElement | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);

  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState('');
  const [options, setOptions] = useState<TypeaheadOption[]>([]);
  const [capped, setCapped] = useState(false);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Which row the keyboard is on. -1 means none — Enter then does nothing rather
  // than choosing whatever happened to be first, which is how a picker silently
  // selects the wrong thing.
  const [active, setActive] = useState(-1);

  const listId = useId();
  const optionId = (index: number) => `${listId}-option-${index}`;

  // Debounced, cancellable search. `cancelled` guards the state writes rather than
  // the request: a slow first query must not overwrite a fast second one's results
  // (the classic out-of-order autocomplete bug, where the list flickers back to
  // the previous term's answers).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const handle = setTimeout(() => {
      (async () => {
        setSearching(true);
        try {
          const result = await search(term);
          if (cancelled) return;
          setOptions(result.options);
          setCapped(result.capped);
          setError(null);
          // Reset the cursor on every new result: keeping index 3 across a
          // different set of rows points it at an unrelated item.
          setActive(-1);
        } catch (e) {
          if (cancelled) return;
          // Rule 11: surfaced in the panel, never swallowed. A picker that returns
          // nothing because the query failed is indistinguishable from a picker
          // that returns nothing because there is nothing.
          setError(e instanceof Error ? e.message : String(e));
          setOptions([]);
          setCapped(false);
        } finally {
          if (!cancelled) setSearching(false);
        }
      })();
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [open, term, search]);

  const close = useCallback(() => {
    setOpen(false);
    setActive(-1);
    // The typed term is dropped on close, so re-opening offers the starting set
    // rather than the leftovers of a search the user abandoned.
    setTerm('');
  }, []);

  const choose = useCallback(
    (option: TypeaheadOption) => {
      if (option.disabled) return;
      onChange(option.value, option);
      close();
      input?.focus({ preventScroll: true });
    },
    [onChange, close, input],
  );

  // The rows a keystroke may land on. A disabled row is skipped by the arrows
  // rather than being a dead stop the cursor has to be pushed past.
  const selectable = options.filter((o) => !o.disabled);

  function moveTo(nextSelectableIndex: number) {
    if (selectable.length === 0) return;
    const wrapped =
      (nextSelectableIndex + selectable.length) % selectable.length;
    const target = selectable[wrapped];
    setActive(options.indexOf(target));
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      const current = active >= 0 ? selectable.indexOf(options[active]) : -1;
      moveTo(event.key === 'ArrowDown' ? current + 1 : current - 1);
      return;
    }
    if (event.key === 'Enter') {
      if (open && active >= 0 && options[active]) {
        // Only when a row is actually highlighted. Otherwise Enter belongs to the
        // form, and stealing it to choose the first result is how a picker commits
        // to something the user never looked at.
        event.preventDefault();
        choose(options[active]);
      }
      return;
    }
    if (event.key === 'Escape') {
      if (open) {
        // Stopped so an Escape aimed at the list does not also close the
        // slide-over the field is sitting in.
        event.stopPropagation();
        close();
      }
      return;
    }
    if (event.key === 'Tab' && open) {
      // Moving on with the keyboard closes the list. Left open it would float over
      // whatever the user tabbed to, pointing at a field they have left.
      close();
    }
  }

  // Keep the highlighted row in view inside the panel's own scroller. scrollIntoView
  // with block:'nearest' scrolls the PANEL, not the page — and Popover ignores
  // scrolls originating inside itself, so this cannot close the list it is
  // scrolling.
  useEffect(() => {
    if (!open || active < 0) return;
    panel.current
      ?.querySelector<HTMLElement>(`#${CSS.escape(optionId(active))}`)
      ?.scrollIntoView({ block: 'nearest' });
    // optionId is derived from a stable useId; only the index moves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, active]);

  const chosen = Boolean(value);
  // Closed with something chosen → the chosen thing's name. Open → what is being
  // typed. Never both: an input that shows a selection while you type over it
  // leaves you unsure which one Enter will take.
  const shown = open ? term : chosen ? (selectedLabel ?? '') : '';

  return (
    <FieldShell {...base}>
      {({ id, describedBy, invalid }) => (
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-charcoal-muted" />
          <input
            ref={setInput}
            id={id}
            type="text"
            role="combobox"
            aria-expanded={open}
            aria-controls={open ? listId : undefined}
            aria-autocomplete="list"
            aria-activedescendant={
              open && active >= 0 ? optionId(active) : undefined
            }
            autoComplete="off"
            value={shown}
            placeholder={
              chosen && !open ? undefined : (placeholder ?? 'Type to search…')
            }
            required={base.required}
            disabled={base.disabled}
            aria-describedby={describedBy}
            aria-invalid={invalid || undefined}
            onChange={(e) => {
              setTerm(e.target.value);
              if (!open) setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={onKeyDown}
            className={`${controlClasses} pr-16 pl-9`}
          />

          <div className="absolute top-1/2 right-2 flex -translate-y-1/2 items-center gap-1">
            {clearable && chosen && !base.disabled ? (
              <button
                type="button"
                onClick={() => {
                  onChange('', null);
                  close();
                  input?.focus({ preventScroll: true });
                }}
                className="rounded-md px-1.5 py-0.5 text-xs font-semibold text-charcoal-muted transition-colors hover:bg-sand hover:text-charcoal focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none"
              >
                Clear
              </button>
            ) : null}
            <ChevronDownIcon className="pointer-events-none h-4 w-4 text-charcoal-muted" />
          </div>

          <Popover
            open={open && !base.disabled}
            onClose={close}
            anchor={input}
            align="left"
            // The results list is the field's width — see the Popover note.
            width="anchor"
            role="listbox"
            ariaLabel={base.label}
            id={listId}
          >
            <div ref={panel} className="max-h-64 overflow-y-auto">
              {error ? (
                <p
                  role="alert"
                  className="px-3 py-3 text-sm font-medium text-primary"
                >
                  {error}
                </p>
              ) : searching && options.length === 0 ? (
                <p
                  className="px-3 py-3 text-sm text-charcoal-muted"
                  aria-live="polite"
                >
                  Searching…
                </p>
              ) : options.length === 0 ? (
                <p className="px-3 py-3 text-sm text-charcoal-muted">
                  {emptyMessage}
                </p>
              ) : (
                <ul className="divide-y divide-sand-border/60">
                  {options.map((option, index) => (
                    <li key={option.value}>
                      <button
                        type="button"
                        id={optionId(index)}
                        role="option"
                        aria-selected={option.value === value}
                        aria-disabled={option.disabled || undefined}
                        disabled={option.disabled}
                        // Pointer-down rather than click: the Popover closes on an
                        // outside pointerdown, and a mousedown that lands on a row
                        // must be the row's, not a dismissal that beats the click.
                        onMouseDown={(e) => {
                          e.preventDefault();
                          choose(option);
                        }}
                        onMouseEnter={() =>
                          option.disabled ? undefined : setActive(index)
                        }
                        className={`block w-full px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                          index === active ? 'bg-sand' : 'hover:bg-sand/60'
                        }`}
                      >
                        <span
                          className={`block truncate text-sm ${
                            option.value === value
                              ? 'font-semibold text-primary'
                              : 'font-medium text-charcoal'
                          }`}
                        >
                          {option.label}
                        </span>
                        {option.hint ? (
                          <span className="mt-0.5 block truncate text-xs text-charcoal-muted">
                            {option.hint}
                          </span>
                        ) : null}
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {/* THE CAP, SAID OUT LOUD. Without this line a capped picker is the
                  same lie as a client-side filter. */}
              {capped ? (
                <p className="border-t border-sand-border bg-sand/40 px-3 py-2 text-xs text-charcoal-muted">
                  Showing the first {options.length}. Keep typing to narrow it.
                </p>
              ) : null}
            </div>
          </Popover>
        </div>
      )}
    </FieldShell>
  );
}
