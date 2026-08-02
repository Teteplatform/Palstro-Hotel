import { useEffect, useId, useRef, useState } from 'react';
import { ChevronDownIcon, DownloadIcon, WhatsappIcon } from '../../ui/icons';
import { useActiveProperty } from '../../../hooks/useActiveProperty';
import {
  useStatementExport,
  type StatementExportFormat,
} from '../../../hooks/useStatementExport';
import type { StatementData } from '../../../lib/statement';
import type { StatementTarget } from '../../../lib/statementLoad';
import type { Property } from '../../../types/tenant';

// THE EXPORT / SHARE CONTROL.
//
// One button, four ways out of the document: PDF, Excel, Word and WhatsApp. It
// sits beside Print rather than replacing it — printing makes paper for the file
// and for a guest standing at the desk; these make a FILE, which is what gets
// emailed, attached, or sent to a company's accounts department.
//
// IT WORKS THE SAME ON A PHONE. The menu is anchored to the right edge and sized
// in rems, so at 360px it opens inside the viewport instead of pushing the page
// sideways; every item is a full-width row with a touch-sized hit area. That
// matters most for WhatsApp, which is a phone action first.
//
// THE MENU'S BEHAVIOUR is the folio bill's, deliberately: it closes on Escape,
// on an outside pointer press, and on choosing an item — the three ways a person
// expects a menu to close — and the trigger is a real button in the tab order.
//
// PRIMING: opening the menu starts loading the statement on surfaces that do not
// already have it. WhatsApp's native share must be reached while the browser
// still considers the click a user gesture, and a read in the middle of the
// handler is exactly what spends it.

interface StatementExportMenuProps {
  // Passed by the statement page, which already has the document; omitted by the
  // stay page and the guest home, which load it when the menu opens.
  statement?: StatementData | null;
  target: StatementTarget;
  // Passed where the caller already holds it (the statement page); otherwise
  // taken from the active-property context, which is the same object — a page
  // that has only ids should not have to thread a whole Property through to put
  // an export button on a header.
  property?: Property;
  // The statement page's control is the secondary one beside Print; elsewhere it
  // is the only export affordance on the row.
  tone?: 'default' | 'quiet';
}

interface MenuItem {
  format: StatementExportFormat;
  label: string;
  hint: string;
}

const ITEMS: MenuItem[] = [
  { format: 'pdf', label: 'PDF', hint: 'The statement as issued, ready to send' },
  { format: 'xlsx', label: 'Excel', hint: 'Figures as numbers, for checking' },
  { format: 'docx', label: 'Word', hint: 'Editable copy' },
  { format: 'whatsapp', label: 'WhatsApp', hint: 'Send the guest a summary' },
];

export function StatementExportMenu({
  statement,
  target,
  property,
  tone = 'default',
}: StatementExportMenuProps) {
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement | null>(null);
  const menuId = useId();
  const active = useActiveProperty();
  // The context's property is the same object the pages pass down; either is
  // fine, and one of them is always there on an admin route.
  const resolvedProperty = property ?? active.property;
  const { run, busy, prime } = useStatementExport({
    statement,
    property: resolvedProperty,
  });

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

  const busyLabel = busy
    ? (ITEMS.find((item) => item.format === busy)?.label ?? null)
    : null;

  return (
    <div ref={wrapper} className="relative print:hidden">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => {
          const next = !open;
          setOpen(next);
          // Opening is itself the gesture that pays for the read.
          if (next) prime(target);
        }}
        className={
          tone === 'quiet'
            ? 'inline-flex items-center gap-2 rounded-full border border-sand-border bg-white/70 px-4 py-1 text-xs font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream'
            : 'inline-flex items-center gap-2 rounded-full border border-sand-border bg-white/70 px-4 py-2 text-xs font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream'
        }
      >
        <DownloadIcon className="h-4 w-4" />
        {/* The busy format is named in the button itself, because a PDF of a
            long folio takes a moment and a control that looks idle invites a
            second click. */}
        {busyLabel ? `Preparing ${busyLabel}…` : 'Export / Share'}
        <ChevronDownIcon className="h-3.5 w-3.5" />
      </button>

      {open ? (
        <div
          id={menuId}
          role="menu"
          aria-label="Export or share this statement"
          className="absolute right-0 top-full z-20 mt-1 w-64 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-sand-border bg-white shadow-lg"
        >
          {ITEMS.map((item) => (
            <button
              key={item.format}
              type="button"
              role="menuitem"
              disabled={busy !== null}
              onClick={() => {
                setOpen(false);
                void run(item.format, target);
              }}
              className="flex w-full items-start gap-3 border-b border-sand-border/60 px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-sand focus-visible:bg-sand focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60"
            >
              <span className="mt-0.5 text-charcoal-muted">
                {item.format === 'whatsapp' ? (
                  <WhatsappIcon className="h-4 w-4" />
                ) : (
                  <DownloadIcon className="h-4 w-4" />
                )}
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-charcoal">
                  {item.label}
                </span>
                {/* Four formats is enough for "which one do I want?" to be a real
                    question at the desk, so each says what it is for. */}
                <span className="block text-xs leading-relaxed text-charcoal-muted">
                  {item.hint}
                </span>
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
