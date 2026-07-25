import { useState } from 'react';
import {
  ArrowLeftIcon,
  ArrowRightIcon,
} from './icons';

// The ONE shared pagination control (CLAUDE.md §6: "Pagination is a shared
// component, built once before the first list screen"). Every list surface —
// room types here, and the change_log viewer that grows without bound — uses
// THIS, so paging behaves identically everywhere and the next bug is fixed once.
//
// PRESENTATIONAL ONLY, and that is deliberate. The list-surface standard (rule
// 1b) requires SERVER-SIDE paging via .range() with an exact count; that lives in
// the data hook (the caller owns the query). This component renders the controls
// over the caller's { page, pageSize, totalCount } and reports intent back — it
// never fetches, never slices a client array. Slicing a capped client fetch is
// the exact defect rule 1b exists to prevent, so this component cannot do it.
//
// It provides every affordance the standard mandates:
//   * an always-visible "showing X–Y of N" + "page P of T" readout, so the user
//     can SEE there are more pages (never a silently truncated list),
//   * jump to first and last, and previous/next,
//   * direct entry of a page number,
//   * a page-size selector.
// Filters/totals/export are the caller's concern (rules 1b, 20); this is paging.

// Module-local (not exported) so this file only exports the component — the
// codebase's react-refresh rule. Callers override via the pageSizeOptions prop.
const DEFAULT_PAGE_SIZE_OPTIONS = [10, 25, 50, 100];

interface PaginationProps {
  // 1-based current page and the current page size, both owned by the caller.
  page: number;
  pageSize: number;
  // Exact total row count for the CURRENT FILTER (from the query's { count }),
  // not the length of the visible page — that is what makes "of N" honest.
  totalCount: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  pageSizeOptions?: number[];
  // Disable every control while a page is loading, so a user cannot queue a
  // second jump before the first resolves.
  disabled?: boolean;
  // Plural noun for the readout ("rooms", "entries"); defaults to "items".
  itemNoun?: string;
}

export function Pagination({
  page,
  pageSize,
  totalCount,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = DEFAULT_PAGE_SIZE_OPTIONS,
  disabled = false,
  itemNoun = 'items',
}: PaginationProps) {
  // At least one page even when empty, so "page 1 of 1" always reads sensibly.
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  // Clamp defensively: a stale page (e.g. after the filter shrank the set) must
  // never render "page 7 of 3".
  const current = Math.min(Math.max(1, page), totalPages);

  // The 1-based inclusive row range shown on this page, e.g. "11–20 of 57".
  const firstRow = totalCount === 0 ? 0 : (current - 1) * pageSize + 1;
  const lastRow = Math.min(current * pageSize, totalCount);

  function go(target: number) {
    const clamped = Math.min(Math.max(1, target), totalPages);
    if (clamped !== current) onPageChange(clamped);
  }

  const atFirst = current <= 1;
  const atLast = current >= totalPages;

  return (
    <nav
      aria-label="Pagination"
      className="flex flex-col gap-3 border-t border-sand-border pt-4 sm:flex-row sm:items-center sm:justify-between"
    >
      {/* Always-visible readout: how many rows exist and where the user is. */}
      <p className="text-xs text-charcoal-muted" aria-live="polite">
        {totalCount === 0 ? (
          <>No {itemNoun} to show</>
        ) : (
          <>
            Showing{' '}
            <span className="font-semibold text-charcoal">
              {firstRow}–{lastRow}
            </span>{' '}
            of{' '}
            <span className="font-semibold text-charcoal">{totalCount}</span>{' '}
            {itemNoun} · page{' '}
            <span className="font-semibold text-charcoal">{current}</span> of{' '}
            <span className="font-semibold text-charcoal">{totalPages}</span>
          </>
        )}
      </p>

      <div className="flex flex-wrap items-center gap-2">
        {/* Page size selector. */}
        <label className="flex items-center gap-1.5 text-xs text-charcoal-muted">
          <span className="whitespace-nowrap">Per page</span>
          <select
            value={pageSize}
            disabled={disabled}
            onChange={(e) => onPageSizeChange(Number(e.target.value))}
            className="rounded-lg border border-sand-border bg-white/70 px-2 py-1.5 text-sm text-charcoal transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream disabled:cursor-not-allowed disabled:opacity-60"
            aria-label="Rows per page"
          >
            {pageSizeOptions.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
        </label>

        <div className="flex items-center gap-1">
          {/* Jump to first. */}
          <PageButton
            label="First page"
            onClick={() => go(1)}
            disabled={disabled || atFirst}
          >
            <span aria-hidden="true" className="text-sm font-semibold">
              «
            </span>
          </PageButton>
          {/* Previous. */}
          <PageButton
            label="Previous page"
            onClick={() => go(current - 1)}
            disabled={disabled || atFirst}
          >
            <ArrowLeftIcon className="h-4 w-4" />
          </PageButton>

          {/* Direct page-number entry. */}
          <PageJump
            current={current}
            totalPages={totalPages}
            disabled={disabled}
            onGo={go}
          />

          {/* Next. */}
          <PageButton
            label="Next page"
            onClick={() => go(current + 1)}
            disabled={disabled || atLast}
          >
            <ArrowRightIcon className="h-4 w-4" />
          </PageButton>
          {/* Jump to last. */}
          <PageButton
            label="Last page"
            onClick={() => go(totalPages)}
            disabled={disabled || atLast}
          >
            <span aria-hidden="true" className="text-sm font-semibold">
              »
            </span>
          </PageButton>
        </div>
      </div>
    </nav>
  );
}

function PageButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-sand-border bg-white/70 text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}

// Direct page-number entry: type a page and press Enter (or blur) to jump. Keeps
// a local draft so partial typing does not fight the committed page; re-seeds
// when the page changes from outside (a first/last jump, or a clamp).
function PageJump({
  current,
  totalPages,
  disabled,
  onGo,
}: {
  current: number;
  totalPages: number;
  disabled?: boolean;
  onGo: (page: number) => void;
}) {
  const [draft, setDraft] = useState(String(current));

  // Re-seed the field when the page changes from OUTSIDE (a first/last jump, a
  // clamp) via React's "adjust state on prop change" pattern — a conditional
  // setState during render, not an effect, so no cascading re-render.
  const [lastCurrent, setLastCurrent] = useState(current);
  if (current !== lastCurrent) {
    setLastCurrent(current);
    setDraft(String(current));
  }

  function commit() {
    const n = Number(draft);
    if (Number.isFinite(n) && n >= 1) {
      onGo(Math.floor(n));
    }
    // Snap the field back to the (possibly clamped) current page.
    setDraft(String(current));
  }

  return (
    <label className="flex items-center gap-1 text-xs text-charcoal-muted">
      <span className="sr-only">Go to page</span>
      <input
        type="text"
        inputMode="numeric"
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value.replace(/[^0-9]/g, ''))}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
        }}
        onBlur={commit}
        aria-label={`Page number, of ${totalPages}`}
        className="w-12 rounded-lg border border-sand-border bg-white/70 px-2 py-1.5 text-center text-sm text-charcoal transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream disabled:cursor-not-allowed disabled:opacity-60"
      />
      <span className="whitespace-nowrap">/ {totalPages}</span>
    </label>
  );
}
