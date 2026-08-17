import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

// THE ONE FLOATING LAYER. Every popover in this product — kebab menu, dropdown,
// tooltip, date picker, autocomplete — renders through this.
//
// ---------------------------------------------------------------------------
// THE BUG THIS EXISTS TO END
// ---------------------------------------------------------------------------
// The kebab on a stock count row opened and was CUT IN HALF. It was an
// absolutely-positioned child of the table's `overflow-x-auto` wrapper, so the
// wrapper clipped it and most of the menu could not be reached — a menu whose
// items cannot be clicked is the same defect as a button that does nothing.
//
// The same markup was in four other places, so it was not one screen's mistake;
// it was the pattern. That is why this is a primitive and not a patch.
//
// AND IT WAS NOT ONLY THE CLIPPING. That wrapper had grown its own horizontal
// scrollbar, which read as a table-width problem and was not: an absolutely
// positioned child still contributes to its scroll container's scrollWidth, so
// the 15rem menu was widening the scrollable area of every table it sat in.
// Portalling the panel removes the scrollbar as a side effect, because there is
// no longer anything overhanging inside the container.
//
// ---------------------------------------------------------------------------
// WHY A PORTAL AND NOT `overflow: visible` ON THE PARENT
// ---------------------------------------------------------------------------
// Because that fixes one screen and breaks the next. The parent's overflow is
// not decoration — it is what lets a wide table scroll sideways on a phone, and
// removing it trades a clipped menu for a table that pushes the whole page
// sideways at 360px. There is also no single parent to fix: the clipping
// ancestor is whichever one happens to have overflow, which changes as layouts
// change, silently.
//
// A portal to document.body has NO ancestor that can clip it, whatever it is
// nested inside, forever.
//
// ---------------------------------------------------------------------------
// position: fixed, AND WHY THAT MAKES "CLOSE ON SCROLL" REQUIRED RATHER THAN NICE
// ---------------------------------------------------------------------------
// The panel is positioned in VIEWPORT coordinates, which is what makes it immune
// to every ancestor's scroll offset and transform. The price is that it does not
// travel with the trigger: scroll the table under an open menu and the menu
// would hang in space pointing at the wrong row.
//
// So scrolling any ancestor CLOSES it. That is the honest resolution — a menu
// detached from its row is worse than a menu that closed — and it is why the
// scroll listener is registered with capture: scroll events do not bubble, and
// capture is the only way to hear one from an arbitrary scrolling ancestor.

const GAP = 4;      // between trigger and panel
const MARGIN = 8;   // minimum breathing room against the viewport edge

export interface Rect {
  top: number;
  left: number;
  bottom: number;
  right: number;
  width: number;
  height: number;
}

export interface Placement {
  top: number;
  left: number;
  // Which side it ended up on. Exposed so the caller can flip a shadow or an
  // arrow, and so a proof can assert the flip happened rather than inferring it
  // from arithmetic it just repeated.
  side: 'below' | 'above';
}

// THE POSITIONING, AS A PURE FUNCTION.
//
// Extracted deliberately: this is the part with the arithmetic, the flip and the
// clamping, and it is the part most likely to be wrong at 360px or on the last
// row of a table. A pure function of two rectangles and a viewport can be proven
// exhaustively without a browser, a layout engine or a fake DOM that returns
// zeros for everything.
export function placePopover(
  anchor: Rect,
  panel: { width: number; height: number },
  viewport: { width: number; height: number },
  align: 'left' | 'right' = 'right',
): Placement {
  const roomBelow = viewport.height - anchor.bottom - GAP - MARGIN;
  const roomAbove = anchor.top - GAP - MARGIN;

  // FLIP ONLY WHEN IT ACTUALLY HELPS. The last row of a table is the case that
  // breaks, and it breaks by opening a menu whose lower half is past the bottom
  // of the window. But flipping into a space that is even smaller just moves the
  // problem, so above wins only when it genuinely has more room.
  const side: Placement['side'] =
    panel.height <= roomBelow || roomBelow >= roomAbove ? 'below' : 'above';

  let top =
    side === 'below' ? anchor.bottom + GAP : anchor.top - GAP - panel.height;

  // Whichever side it lands on, it must stay on screen. A very tall panel in a
  // short window is pinned to the top margin rather than allowed to run off it.
  top = Math.min(Math.max(MARGIN, top), Math.max(MARGIN, viewport.height - panel.height - MARGIN));

  // Right-aligned means the panel's RIGHT edge meets the trigger's right edge,
  // which is what keeps a menu under a right-hand action column from hanging off
  // the table.
  let left = align === 'right' ? anchor.right - panel.width : anchor.left;

  // THE 360px CASE. A 15rem panel is 240px, so a right-aligned menu near the
  // left edge of a narrow phone would otherwise be positioned at a negative x
  // and lose its first characters off-screen.
  left = Math.min(Math.max(MARGIN, left), Math.max(MARGIN, viewport.width - panel.width - MARGIN));

  return { top, left, side };
}

interface PopoverProps {
  open: boolean;
  onClose: () => void;
  // The trigger. Positioning is measured against it, and focus returns to it.
  anchor: HTMLElement | null;
  children: ReactNode;
  align?: 'left' | 'right';
  role?: 'menu' | 'dialog' | 'listbox' | 'tooltip';
  ariaLabel?: string;
  id?: string;
  className?: string;
}

export function Popover({
  open,
  onClose,
  anchor,
  children,
  align = 'right',
  role = 'menu',
  ariaLabel,
  id,
  className = '',
}: PopoverProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);

  // Measure AFTER the panel is in the DOM but BEFORE the browser paints, so the
  // panel is never seen at the wrong position. It renders invisible until
  // `placement` exists, which is what stops a one-frame flash at 0,0.
  useLayoutEffect(() => {
    if (!open || !anchor || !panelRef.current) {
      setPlacement(null);
      return;
    }
    const a = anchor.getBoundingClientRect();
    const p = panelRef.current.getBoundingClientRect();
    setPlacement(
      placePopover(
        { top: a.top, left: a.left, bottom: a.bottom, right: a.right, width: a.width, height: a.height },
        { width: p.width, height: p.height },
        { width: window.innerWidth, height: window.innerHeight },
        align,
      ),
    );
  }, [open, anchor, align]);

  const close = useCallback(() => {
    // RETURN FOCUS TO THE TRIGGER — but only when focus is still inside the
    // panel. Closing because the user clicked some other control must not yank
    // focus back off the thing they just chose.
    const active = document.activeElement;
    const focusWasInside = panelRef.current?.contains(active as Node) ?? false;
    onClose();
    if (focusWasInside) anchor?.focus();
  }, [onClose, anchor]);

  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node;
      // The panel is in a portal, so it is NOT inside the trigger's subtree —
      // both have to be tested. Missing the panel here is the classic portal
      // bug: the menu closes the instant you click one of its own items.
      if (panelRef.current?.contains(target)) return;
      if (anchor?.contains(target)) return;
      onClose();
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close();
      }
    }

    // CAPTURE. Scroll does not bubble, so this is the only way to hear a scroll
    // from whichever ancestor happens to be scrollable.
    function onScroll(event: Event) {
      // A scroll INSIDE the panel (a long menu) is not an ancestor scrolling.
      if (panelRef.current?.contains(event.target as Node)) return;
      onClose();
    }

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onClose);
    };
  }, [open, anchor, onClose, close]);

  if (!open) return null;
  // No document to portal into (a server render, or a test that forgot its DOM):
  // render nothing rather than throwing.
  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      ref={panelRef}
      id={id}
      role={role}
      aria-label={ariaLabel}
      data-popover="true"
      style={{
        position: 'fixed',
        top: placement ? `${placement.top}px` : 0,
        left: placement ? `${placement.left}px` : 0,
        // Hidden rather than unmounted for the measuring pass: it has to be laid
        // out to have a size at all.
        visibility: placement ? 'visible' : 'hidden',
        zIndex: 60,
      }}
      className={`overflow-hidden rounded-xl border border-sand-border bg-white text-left shadow-lg print:hidden ${className}`}
    >
      {children}
    </div>,
    document.body,
  );
}
