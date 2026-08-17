import { useCallback, useEffect, useState } from 'react';
import {
  EMPTY_TAKE_FILTERS,
  fetchOpenTake,
  fetchTakesPage,
  type TakeHistoryFilters,
} from '../lib/stockTake';
import type { StockTakeProgressRow } from '../types/stockTake';

// Two reads that answer two different questions about counts, kept in one file
// because they are one concept (the count history) seen from two distances.
//
//   useOpenStockTake  — "is a count already running on these shelves?"
//   useStockTakes     — "what counts has this hotel run?"
//
// THE FIRST ONE IS WHAT MAKES A COUNT RESUMABLE. The screen asks the DATABASE
// what is open in this location rather than asking its own memory, so a reload,
// a different browser and a different person on the next shift all arrive at the
// same sheet. There can only ever be one open count per location (039 §2.1), so
// the answer is a row or null — never a list with a silent "first" pick.

export interface UseOpenStockTakeResult {
  take: StockTakeProgressRow | null;
  loading: boolean;
  error: Error | null;
  reload: () => Promise<void>;
}

export function useOpenStockTake(
  tenantId: string | null,
  propertyId: string | null,
  locationId: string | null,
): UseOpenStockTakeResult {
  const [take, setTake] = useState<StockTakeProgressRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(async () => {
    setNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      setLoading(true);
      if (!tenantId || !propertyId || !locationId) {
        if (cancelled) return;
        setTake(null);
        setError(null);
        setLoading(false);
        return;
      }
      try {
        const row = await fetchOpenTake(tenantId, propertyId, locationId);
        if (cancelled) return;
        setTake(row);
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
  }, [tenantId, propertyId, locationId, nonce]);

  return { take, loading, error, reload };
}

// ---------------------------------------------------------------------------
// The history list (rule 1b)
// ---------------------------------------------------------------------------

const DEFAULT_PAGE_SIZE = 10;

export interface UseStockTakesResult {
  rows: StockTakeProgressRow[];
  count: number;
  page: number;
  pageSize: number;
  filters: TakeHistoryFilters;
  loading: boolean;
  error: Error | null;
  setPage: (page: number) => void;
  setPageSize: (size: number) => void;
  setFilters: (filters: TakeHistoryFilters) => void;
  reload: () => Promise<void>;
}

export function useStockTakes(
  tenantId: string | null,
  propertyId: string | null,
): UseStockTakesResult {
  const [rows, setRows] = useState<StockTakeProgressRow[]>([]);
  const [count, setCount] = useState(0);
  const [page, setPageState] = useState(1);
  const [pageSize, setPageSizeState] = useState(DEFAULT_PAGE_SIZE);
  const [filters, setFiltersState] = useState<TakeHistoryFilters>(EMPTY_TAKE_FILTERS);
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

  const setFilters = useCallback((next: TakeHistoryFilters) => {
    setFiltersState(next);
    setPageState(1);
  }, []);

  const reload = useCallback(async () => {
    setNonce((n) => n + 1);
  }, []);

  const { locationId, status } = filters;

  useEffect(() => {
    let cancelled = false;

    (async () => {
      setLoading(true);
      if (!tenantId || !propertyId) {
        if (cancelled) return;
        setRows([]);
        setCount(0);
        setError(null);
        setLoading(false);
        return;
      }
      try {
        const result = await fetchTakesPage(tenantId, propertyId, page, pageSize, {
          locationId,
          status,
        });
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
  }, [tenantId, propertyId, page, pageSize, locationId, status, nonce]);

  return {
    rows,
    count,
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
