import { useId, useRef, useState } from 'react';
import { KebabIcon } from './icons';
import { Popover } from './Popover';

// THE KEBAB MENU, built once and — since the clipping fix — floating through the
// shared Popover, so no ancestor's overflow can ever cut it off again. See
// Popover's header for why a portal rather than `overflow: visible` on whichever
// parent happened to be clipping this week.
//
// WHY A KEBAB AND NOT A ROW OF BUTTONS. On a list of documents, most rows want
// the same three or four actions and none of them is the primary one. Spelling
// them out per row turns a scannable table into a wall of buttons, and on a
// phone it pushes the table sideways. The kebab keeps the row readable and puts
// every action one press away — but it is NOT for the primary action, which
// should always be a real control the eye can find.
//
// KEYBOARD. Opening moves focus to the first item, so the menu is usable without
// a mouse; arrows and Home/End move between items; Escape closes and puts focus
// back on the trigger. Moving focus in is what makes "return focus to the
// trigger" mean anything — without it there would be nothing to return.

export interface ActionMenuItem {
  key: string;
  label: string;
  // What choosing it does, in one line. Shown under the label, because a menu
  // that offers "Undo" and "Abandon" on the same document is a menu where
  // guessing wrong is expensive.
  hint?: string;
  onSelect: () => void;
  // A destructive or irreversible action reads differently, so it cannot be
  // picked by accident from muscle memory.
  tone?: 'default' | 'danger';
  disabled?: boolean;
}

interface ActionMenuProps {
  items: ActionMenuItem[];
  // Names the SUBJECT, not the menu: "Actions for count ST-000004". A screen
  // reader user hearing "Actions" on the fortieth row of a table has learnt
  // nothing.
  label: string;
  align?: 'left' | 'right';
}

export function ActionMenu({ items, label, align = 'right' }: ActionMenuProps) {
  const [open, setOpen] = useState(false);
  // THE ANCHOR IS STATE, NOT A REF. Reading trigger.current during render to
  // hand it to Popover is exactly the "cannot access refs during render" defect:
  // React does not re-render when a ref's .current changes, so the anchor would
  // be whatever happened to be there from the previous pass. A callback ref into
  // state makes the element a real reactive value — the pattern every floating
  // library uses — so Popover re-measures when the trigger actually changes.
  const [trigger, setTrigger] = useState<HTMLButtonElement | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);
  const menuId = useId();

  // An empty menu renders nothing rather than a button that opens a blank box.
  if (items.length === 0) return null;

  const enabled = () =>
    Array.from(
      panel.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? [],
    );

  function focusAt(index: number) {
    const buttons = enabled();
    if (buttons.length === 0) return;
    const wrapped = (index + buttons.length) % buttons.length;
    // preventScroll matters more than it looks: focusing an item can scroll an
    // ancestor, and an ancestor scrolling is exactly what Popover closes on — so
    // without this the menu would shut itself the instant it opened.
    buttons[wrapped]?.focus({ preventScroll: true });
  }

  function onMenuKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const buttons = enabled();
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusAt(at + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      focusAt(at - 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      focusAt(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      focusAt(buttons.length - 1);
    }
  }

  return (
    <>
      <button
        ref={setTrigger}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={label}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          // Down-arrow opens and lands on the first item, which is what a menu
          // button is expected to do.
          if (!open && (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ')) {
            if (e.key === 'ArrowDown') e.preventDefault();
            setOpen(true);
          }
        }}
        className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-sand-border bg-white/70 text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream print:hidden"
      >
        <KebabIcon className="h-4 w-4" />
      </button>

      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchor={trigger}
        align={align}
        role="menu"
        ariaLabel={label}
        id={menuId}
        className="w-60 max-w-[calc(100vw-1rem)]"
      >
        <div
          // A CALLBACK ref rather than an effect: it fires the moment the node
          // is attached, which is exactly when there is something to focus, and
          // it keeps `panel` populated for the keyboard handler.
          ref={(node: HTMLDivElement | null) => {
            panel.current = node;
            if (node) {
              node
                .querySelector<HTMLButtonElement>('button:not([disabled])')
                ?.focus({ preventScroll: true });
            }
          }}
          onKeyDown={onMenuKeyDown}
        >
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onClick={() => {
                setOpen(false);
                trigger?.focus({ preventScroll: true });
                item.onSelect();
              }}
              className="block w-full border-b border-sand-border/60 px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-sand focus-visible:bg-sand focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span
                className={`block text-sm font-semibold ${
                  item.tone === 'danger' ? 'text-accent' : 'text-charcoal'
                }`}
              >
                {item.label}
              </span>
              {item.hint ? (
                <span className="mt-0.5 block text-xs leading-relaxed text-charcoal-muted">
                  {item.hint}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      </Popover>
    </>
  );
}
