import { useCallback, useEffect, useState } from 'react';
import {
  EMPTY_SHEET_FILTERS,
  fetchSheetPage,
  type CountedState,
  type SheetFilters,
} from '../lib/stockTake';
import type { StockTakeSheetRow } from '../types/stockTake';

// ONE SECTION of a count sheet, server-paginated (039/040).
//
// Mirrors useStockOnHand: ONE .range() window with an exact count (rule 1b —
// never a client slice of a capped fetch), every filter applied SERVER-SIDE, and
// reload() so a save re-pulls the current page.
//
// ---------------------------------------------------------------------------
// WHY IT TAKES A FIXED `counted` AND WHY THAT IS NOT JUST A FILTER
// ---------------------------------------------------------------------------
// The sheet shows TWO lists at once — "still to count", which is the working
// list, and "already counted", which is the review list behind an accordion.
// They page INDEPENDENTLY, because a counter halfway down page three of the
// shelves they have left should not lose their place by opening the list of what
// they have done.
//
// So each list is its own instance of this hook with `counted` pinned, and the
// caller drives the shared search/category filters into both. Pinning it here
// rather than leaving it to the caller's filter object is what stops a stray
// setFilters from turning the "still to count" list into something else while
// the heading still says otherwise.
//
// ---------------------------------------------------------------------------
// PROGRESS IS NOT HERE ANY MORE
// ---------------------------------------------------------------------------
// It used to be fetched alongside the page. With two instances on one screen
// that meant fetching the same document-wide figures twice for every keystroke
// saved, so the count's progress belongs to the SCREEN, which holds one copy and
// refreshes it after a save.
//
// ---------------------------------------------------------------------------
// patchLine, AND WHY IT IS NOT A REFETCH
// ---------------------------------------------------------------------------
// A counter keys a number and moves to the next shelf. Refetching after every
// save would re-sort under their hands, lose their scroll position and cost a
// round trip per line on a phone in a cold store. So a saved line is patched in
// place from the RPC's own return value — the server's copy, not an optimistic
// guess.

const DEFAULT_PAGE_SIZE = 25;

export interface UseStockTakeSheetResult {
  rows: StockTakeSheetRow[];
  count: number;
  page: number;
  pageSize: number;
  filters: SheetFilters;
  loading: boolean;
  error: Error | null;
  setPage: (page: number) => void;
  setPageSize: (size: number) => void;
  setFilters: (filters: SheetFilters) => void;
  reload: () => Promise<void>;
  patchLine: (
    lineId: string,
    counted: string | null,
    countedAt: string | null,
    countedBy: string | null,
  ) => void;
}

export function useStockTakeSheet(
  tenantId: string | null,
  propertyId: string | null,
  stockTakeId: string | null,
  // '' = every line on the sheet (the finished report reads it this way).
  counted: CountedState = '',
): UseStockTakeSheetResult {
  const [rows, setRows] = useState<StockTakeSheetRow[]>([]);
  const [count, setCount] = useState(0);
  const [page, setPageState] = useState(1);
  const [pageSize, setPageSizeState] = useState(DEFAULT_PAGE_SIZE);
  const [filters, setFiltersState] = useState<SheetFilters>(EMPTY_SHEET_FILTERS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [nonce, setNonce] = useState(0);

  const setPage = useCallback((next: number) => {
    setPageState(Math.max(1, next));
  }, []);

  const setPageSize = useCallback((size: number) => {
    setPageSizeState(size);
    setPageState(1);
  }, []);

  // Changing a filter resets to page 1, so the counter never lands on a
  // now-empty high page after narrowing the sheet (rule 1b: filter then page).
  const setFilters = useCallback((next: SheetFilters) => {
    setFiltersState(next);
    setPageState(1);
  }, []);

  const reload = useCallback(async () => {
    setNonce((n) => n + 1);
  }, []);

  const patchLine = useCallback(
    (
      lineId: string,
      countedQuantity: string | null,
      countedAt: string | null,
      countedBy: string | null,
    ) => {
      setRows((prev) =>
        prev.map((r) =>
          r.line_id === lineId
            ? {
                ...r,
                counted_quantity: countedQuantity,
                // The view derives is_counted from NULL-ness; the patch has to
                // agree, or a cleared line would keep reading as counted.
                is_counted: countedQuantity !== null,
                counted_at: countedAt,
                counted_by: countedBy,
              }
            : r,
        ),
      );
    },
    [],
  );

  // Listed individually rather than as the object, so a caller re-creating an
  // equal filter object does not refetch.
  const { search, categoryId } = filters;

  useEffect(() => {
    let cancelled = false;

    (async () => {
      setLoading(true);
      if (!tenantId || !propertyId || !stockTakeId) {
        if (cancelled) return;
        setRows([]);
        setCount(0);
        setError(null);
        setLoading(false);
        return;
      }

      try {
        const result = await fetchSheetPage(
          tenantId,
          propertyId,
          stockTakeId,
          page,
          pageSize,
          // The pinned state wins over anything in the filter object.
          { search, categoryId, counted },
        );
        if (cancelled) return;

        const lastPage = Math.max(1, Math.ceil(result.count / pageSize));
        if (page > lastPage) {
          setPageState(lastPage);
          return; // the effect re-runs with the corrected page; stay loading
        }
        setRows(result.rows);
        setCount(result.count);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e : new Error(String(e)));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    tenantId,
    propertyId,
    stockTakeId,
    page,
    pageSize,
    search,
    categoryId,
    counted,
    nonce,
  ]);

  return {
    rows,
    count,
    pageSize,
    page,
    filters,
    loading,
    error,
    setPage,
    setPageSize,
    setFilters,
    reload,
    patchLine,
  };
}
