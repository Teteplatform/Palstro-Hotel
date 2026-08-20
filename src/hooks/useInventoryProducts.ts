import { useCallback, useEffect, useState } from 'react';
import {
  EMPTY_PRODUCT_FILTERS,
  fetchProductsPage,
  fetchProductsSummary,
  type ProductFilters,
  type ProductRow,
  type ProductsSummary,
} from '../lib/inventoryProducts';

// The consolidated inventory list, server-paginated.
//
// Mirrors useStockOnHand/useInventoryItems: ONE .range() window with an exact
// count (rule 1b — never a client slice of a capped fetch), every filter applied
// SERVER-SIDE, and reload() so a posting re-pulls the current page.
//
// THE SUMMARY IS FETCHED ALONGSIDE THE PAGE, from a SEPARATE query over the SAME
// filter (rule 20). It deliberately does NOT come from `rows`: a total summed
// from the visible page is a wrong number presented with confidence. Both are
// refreshed together, so the card above the table can never describe a different
// set from the table.
//
// locationId NULL means "every location in this property" — the roll-up the
// screen calls All locations, not a missing filter.

const DEFAULT_PAGE_SIZE = 25;

export interface UseInventoryProductsResult {
  rows: ProductRow[];
  count: number;
  // TRUE when a stock-state filter made POSITIONS the base of the list, so an
  // item held in two locations is legitimately two rows. The screen says so
  // rather than letting the user wonder why a name appears twice.
  byPosition: boolean;
  summary: ProductsSummary | null;
  page: number;
  pageSize: number;
  filters: ProductFilters;
  loading: boolean;
  error: Error | null;
  setPage: (page: number) => void;
  setPageSize: (size: number) => void;
  setFilters: (filters: ProductFilters) => void;
  reload: () => Promise<void>;
}

export function useInventoryProducts(
  tenantId: string | null,
  propertyId: string | null,
  locationId: string | null,
): UseInventoryProductsResult {
  const [rows, setRows] = useState<ProductRow[]>([]);
  const [count, setCount] = useState(0);
  const [byPosition, setByPosition] = useState(false);
  const [summary, setSummary] = useState<ProductsSummary | null>(null);
  const [page, setPageState] = useState(1);
  const [pageSize, setPageSizeState] = useState(DEFAULT_PAGE_SIZE);
  const [filters, setFiltersState] = useState<ProductFilters>(EMPTY_PRODUCT_FILTERS);
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
  const setFilters = useCallback((next: ProductFilters) => {
    setFiltersState(next);
    setPageState(1);
  }, []);

  const reload = useCallback(async () => {
    setNonce((n) => n + 1);
  }, []);

  // Listed individually rather than as the object, so a caller re-creating an
  // equal filter object does not refetch.
  const { search, categoryId, itemType, state, includeInactive, unpricedSellable } =
    filters;

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

      const activeFilters: ProductFilters = {
        search,
        categoryId,
        itemType,
        state,
        includeInactive,
        unpricedSellable,
      };

      try {
        const [pageResult, summaryResult] = await Promise.all([
          fetchProductsPage(
            tenantId,
            propertyId,
            locationId,
            page,
            pageSize,
            activeFilters,
          ),
          fetchProductsSummary(tenantId, propertyId, locationId, activeFilters),
        ]);
        if (cancelled) return;

        const lastPage = Math.max(1, Math.ceil(pageResult.count / pageSize));
        if (page > lastPage) {
          setPageState(lastPage);
          return; // the effect re-runs with the corrected page; stay loading
        }
        setRows(pageResult.rows);
        setCount(pageResult.count);
        setByPosition(pageResult.byPosition);
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
    itemType,
    state,
    includeInactive,
    unpricedSellable,
    nonce,
  ]);

  return {
    rows,
    count,
    byPosition,
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
