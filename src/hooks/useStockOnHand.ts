import { useCallback, useEffect, useState } from 'react';
import {
  EMPTY_STOCK_FILTERS,
  fetchStockPage,
  fetchStockSummary,
  type StockFilters,
  type StockSummary,
} from '../lib/stock';
import type { StockOnHandRow } from '../types/stock';

// One location's stock on hand, server-paginated (F&B/Inventory part 2a).
//
// Mirrors useInventoryItems/useBookings: ONE .range() window with an exact count
// (rule 1b — never a client slice of a capped fetch), every filter applied
// SERVER-SIDE, and reload() so a posting re-pulls the current page.
//
// THE SUMMARY IS FETCHED ALONGSIDE THE PAGE, from a SEPARATE query over the
// SAME filter (rule 20). It deliberately does NOT come from `rows`: a total
// summed from the visible page is a wrong number presented with confidence,
// which is worse than no number. Both are refreshed together so the figure above
// the table can never describe a different set from the table.

const DEFAULT_PAGE_SIZE = 25;

export interface UseStockOnHandResult {
  rows: StockOnHandRow[];
  count: number;
  summary: StockSummary | null;
  page: number;
  pageSize: number;
  filters: StockFilters;
  loading: boolean;
  error: Error | null;
  setPage: (page: number) => void;
  setPageSize: (size: number) => void;
  setFilters: (filters: StockFilters) => void;
  reload: () => Promise<void>;
}

export function useStockOnHand(
  tenantId: string | null,
  propertyId: string | null,
  locationId: string | null,
): UseStockOnHandResult {
  const [rows, setRows] = useState<StockOnHandRow[]>([]);
  const [count, setCount] = useState(0);
  const [summary, setSummary] = useState<StockSummary | null>(null);
  const [page, setPageState] = useState(1);
  const [pageSize, setPageSizeState] = useState(DEFAULT_PAGE_SIZE);
  const [filters, setFiltersState] = useState<StockFilters>(EMPTY_STOCK_FILTERS);
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

  // Changing a filter resets to page 1, so the user never lands on a now-empty
  // high page after narrowing the set (rule 1b: filter then page, never the
  // other way round).
  const setFilters = useCallback((next: StockFilters) => {
    setFiltersState(next);
    setPageState(1);
  }, []);

  const reload = useCallback(async () => {
    setNonce((n) => n + 1);
  }, []);

  // Listed individually rather than as the object, so a caller re-creating an
  // equal filter object does not refetch.
  const { search, categoryId, state } = filters;

  useEffect(() => {
    let cancelled = false;

    (async () => {
      setLoading(true);
      if (!tenantId || !propertyId || !locationId) {
        if (cancelled) return;
        setRows([]);
        setCount(0);
        setSummary(null);
        setError(null);
        setLoading(false);
        return;
      }

      const activeFilters: StockFilters = { search, categoryId, state };
      try {
        const [pageResult, summaryResult] = await Promise.all([
          fetchStockPage(
            tenantId,
            propertyId,
            locationId,
            page,
            pageSize,
            activeFilters,
          ),
          fetchStockSummary(tenantId, propertyId, locationId, activeFilters),
        ]);
        if (cancelled) return;

        const lastPage = Math.max(1, Math.ceil(pageResult.count / pageSize));
        if (page > lastPage) {
          setPageState(lastPage);
          return; // the effect re-runs with the corrected page; stay loading
        }
        setRows(pageResult.rows);
        setCount(pageResult.count);
        setSummary(summaryResult);
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
    locationId,
    page,
    pageSize,
    search,
    categoryId,
    state,
    nonce,
  ]);

  return {
    rows,
    count,
    summary,
    page,
    pageSize,
    filters,
    loading,
    error,
    setPage,
    setPageSize,
    setFilters,
    reload,
  };
}
