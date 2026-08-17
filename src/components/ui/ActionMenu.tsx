import { useEffect, useId, useRef, useState } from 'react';
import { KebabIcon } from './icons';

// THE KEBAB MENU, built once.
//
// It is the third menu in this codebase — UserMenu, StatementExportMenu and now
// this — and the first that is shared. The other two are each welded to their
// own contents; this one takes items, so the next row of actions is a data
// array rather than a fourth copy of the same open/close/Escape/outside-press
// dance. Same reason Pagination exists (§6): built per screen, a menu is four
// different behaviours and four places to fix the next accessibility bug.
//
// THE BEHAVIOUR IS StatementExportMenu's, deliberately and to the letter: it
// closes on Escape, on an outside pointer press, and on choosing an item — the
// three ways a person expects a menu to close — and the trigger is a real button
// in the tab order with aria-haspopup/aria-expanded wired up.
//
// WHY A KEBAB AND NOT A ROW OF BUTTONS. On a list of documents, most rows want
// the same three or four actions and none of them is the primary one. Spelling
// them out per row turns a scannable table into a wall of buttons, and on a
// phone it pushes the table sideways. The kebab keeps the row readable and puts
// every action one press away — but it is NOT for the primary action, which
// should always be a real control the eye can find.
//
// print:hidden, like every other control: a menu on paper is noise.

export interface ActionMenuItem {
  key: string;
  label: string;
  // What choosing it does, in one line. Shown under the label, because a menu
  // that offers "Reverse" and "Abandon" on the same document is a menu where
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
  const wrapper = useRef<HTMLDivElement | null>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  // An empty menu renders nothing rather than a button that opens a blank box.
  if (items.length === 0) return null;

  return (
    <div ref={wrapper} className="relative inline-block print:hidden">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={label}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-sand-border bg-white/70 text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream"
      >
        <KebabIcon className="h-4 w-4" />
      </button>

      {open ? (
        <div
          id={menuId}
          role="menu"
          aria-label={label}
          className={`absolute z-20 mt-1 w-60 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-sand-border bg-white text-left shadow-lg ${
            align === 'right' ? 'right-0' : 'left-0'
          } top-full`}
        >
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onClick={() => {
                setOpen(false);
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
      ) : null}
    </div>
  );
}
