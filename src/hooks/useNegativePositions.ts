import { useCallback, useEffect, useState } from 'react';
import {
  EMPTY_NEGATIVE_FILTERS,
  fetchNegativePositionsPage,
  fetchNegativeSummary,
  type NegativeFilters,
  type NegativeSummary,
} from '../lib/stock';
import type { StockNegativePositionRow } from '../types/stock';

// Every position in the property holding LESS THAN NOTHING, server-paginated
// (038 §9).
//
// Mirrors useInventoryProducts / useStockOnHand exactly, and deliberately so:
// ONE .range() window with an exact count (rule 1b — never a client slice of a
// capped fetch), every filter applied SERVER-SIDE, and reload() so a correction
// re-pulls the current page.
//
// THE SUMMARY IS FETCHED ALONGSIDE THE PAGE, from a SEPARATE query over the SAME
// filter (rule 20). It deliberately does NOT come from `rows`: a shortfall
// totalled from the visible page would understate the problem, and understating
// it is the one direction this figure must never err in.
//
// PROPERTY-WIDE, not per-location. A negative is a question about the property,
// and asking it one location at a time is how one gets missed. Location is a
// filter here, not a scope.

const DEFAULT_PAGE_SIZE = 25;

export interface UseNegativePositionsResult {
  rows: StockNegativePositionRow[];
  count: number;
  summary: NegativeSummary | null;
  page: number;
  pageSize: number;
  filters: NegativeFilters;
  loading: boolean;
  error: Error | null;
  setPage: (page: number) => void;
  setPageSize: (size: number) => void;
  setFilters: (filters: NegativeFilters) => void;
  reload: () => Promise<void>;
}

export function useNegativePositions(
  tenantId: string | null,
  propertyId: string | null,
): UseNegativePositionsResult {
  const [rows, setRows] = useState<StockNegativePositionRow[]>([]);
  const [count, setCount] = useState(0);
  const [summary, setSummary] = useState<NegativeSummary | null>(null);
  const [page, setPageState] = useState(1);
  const [pageSize, setPageSizeState] = useState(DEFAULT_PAGE_SIZE);
  const [filters, setFiltersState] = useState<NegativeFilters>(
    EMPTY_NEGATIVE_FILTERS,
  );
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
  const setFilters = useCallback((next: NegativeFilters) => {
    setFiltersState(next);
    setPageState(1);
  }, []);

  const reload = useCallback(async () => {
    setNonce((n) => n + 1);
  }, []);

  // Listed individually rather than as the object, so a caller re-creating an
  // equal filter object does not refetch.
  const { search, categoryId, locationId, onlyUncorrectable } = filters;

  useEffect(() => {
    let cancelled = false;

    (async () => {
      setLoading(true);
      if (!tenantId || !propertyId) {
        if (cancelled) return;
        setRows([]);
        setCount(0);
        setSummary(null);
        setError(null);
        setLoading(false);
        return;
      }

      const activeFilters: NegativeFilters = {
        search,
        categoryId,
        locationId,
        onlyUncorrectable,
      };

      try {
        const [pageResult, summaryResult] = await Promise.all([
          fetchNegativePositionsPage(
            tenantId,
            propertyId,
            page,
            pageSize,
            activeFilters,
          ),
          fetchNegativeSummary(tenantId, propertyId, activeFilters),
        ]);
        if (cancelled) return;

        // A filter that shrank the set can leave the user on a page past the
        // end. Correct it and stay loading — the effect re-runs with the fixed
        // page rather than flashing an empty table.
        const lastPage = Math.max(1, Math.ceil(pageResult.count / pageSize));
        if (page > lastPage) {
          setPageState(lastPage);
          return;
        }
        setRows(pageResult.rows);
        setCount(pageResult.count);
        setSummary(summaryResult);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        // Rule 11: surfaced, never swallowed. The screen shows it.
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
    page,
    pageSize,
    search,
    categoryId,
    locationId,
    onlyUncorrectable,
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
