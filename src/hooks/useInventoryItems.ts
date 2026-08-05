import { useCallback, useEffect, useState } from 'react';
import {
  fetchInventoryItemsPage,
  EMPTY_ITEM_FILTERS,
  type ItemFilters,
} from '../lib/inventory';
import type { InventoryItem } from '../types/inventory';

// Server-side paginated catalogue items for the inventory admin screen (part 1),
// mirroring useCompanies/useAdminRoomTypes: ONE .range() window with an exact
// count (rule 1b — never a client slice of a capped fetch), every filter applied
// SERVER-SIDE (rules 1b/20), and reload() so a create/edit/remove re-pulls the
// current page. Every state update lives inside the async body, and a cancelled
// guard drops a stale in-flight load.

const DEFAULT_PAGE_SIZE = 25;

export interface UseInventoryItemsResult {
  rows: InventoryItem[];
  count: number;
  page: number;
  pageSize: number;
  filters: ItemFilters;
  loading: boolean;
  error: Error | null;
  setPage: (page: number) => void;
  setPageSize: (size: number) => void;
  setFilters: (filters: ItemFilters) => void;
  reload: () => Promise<void>;
}

export function useInventoryItems(
  tenantId: string | null,
): UseInventoryItemsResult {
  const [rows, setRows] = useState<InventoryItem[]>([]);
  const [count, setCount] = useState(0);
  const [page, setPageState] = useState(1);
  const [pageSize, setPageSizeState] = useState(DEFAULT_PAGE_SIZE);
  const [filters, setFiltersState] = useState<ItemFilters>(EMPTY_ITEM_FILTERS);
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
  const setFilters = useCallback((next: ItemFilters) => {
    setFiltersState(next);
    setPageState(1);
  }, []);

  const reload = useCallback(async () => {
    setNonce((n) => n + 1);
  }, []);

  // The filter fields are listed individually in the dependency array rather
  // than the object, so a caller re-creating an equal object does not refetch.
  const { search, itemType, categoryId } = filters;

  useEffect(() => {
    let cancelled = false;

    (async () => {
      setLoading(true);
      if (!tenantId) {
        if (cancelled) return;
        setRows([]);
        setCount(0);
        setError(null);
        setLoading(false);
        return;
      }
      try {
        const result = await fetchInventoryItemsPage(tenantId, page, pageSize, {
          search,
          itemType,
          categoryId,
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
  }, [tenantId, page, pageSize, search, itemType, categoryId, nonce]);

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
