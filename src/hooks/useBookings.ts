import { useCallback, useEffect, useState } from 'react';
import {
  fetchBookingsPage,
  fetchBookingSummary,
  EMPTY_BOOKING_FILTERS,
  type BookingFilters,
  type BookingSummary,
} from '../lib/bookings';
import type { BookingListRow } from '../types/booking';

// Server-side paginated + filtered bookings for the booking screen (build 6b §3).
//
// TWO reads, deliberately separate (rule 20): the PAGE (one .range() window with
// an exact count) and the SUMMARY (aggregated across the WHOLE filtered set, not
// the page). The summary re-fetches on a FILTER change only — it is independent
// of which page you are on — while the page re-fetches on filter OR page change.
// Both use the SAME filters object, so the summary always describes exactly the
// set the list is paging.

const DEFAULT_PAGE_SIZE = 25;

export interface UseBookingsResult {
  rows: BookingListRow[];
  count: number;
  page: number;
  pageSize: number;
  filters: BookingFilters;
  summary: BookingSummary | null;
  summaryLoading: boolean;
  loading: boolean;
  // The RAW load error, preserved as-is (never wrapped in new Error(String(e)),
  // which would collapse a PostgREST error object to "[object Object]"). Rendered
  // through describeError so its message/details/hint/code all surface (rule 11).
  error: unknown;
  setPage: (page: number) => void;
  setPageSize: (size: number) => void;
  setFilters: (filters: BookingFilters) => void;
  reload: () => Promise<void>;
}

export function useBookings(
  tenantId: string | null,
  propertyId: string | null,
): UseBookingsResult {
  const [rows, setRows] = useState<BookingListRow[]>([]);
  const [count, setCount] = useState(0);
  const [page, setPageState] = useState(1);
  const [pageSize, setPageSizeState] = useState(DEFAULT_PAGE_SIZE);
  const [filters, setFiltersState] = useState<BookingFilters>(
    EMPTY_BOOKING_FILTERS,
  );
  const [summary, setSummary] = useState<BookingSummary | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [nonce, setNonce] = useState(0);

  const setPage = useCallback((next: number) => {
    setPageState(Math.max(1, next));
  }, []);

  const setPageSize = useCallback((size: number) => {
    setPageSizeState(size);
    setPageState(1);
  }, []);

  // A filter change resets to page 1 (filter, then page — rule 1b).
  const setFilters = useCallback((next: BookingFilters) => {
    setFiltersState(next);
    setPageState(1);
  }, []);

  const reload = useCallback(async () => {
    setNonce((n) => n + 1);
  }, []);

  // `filters` identity is stable across renders — it changes ONLY when setFilters
  // installs a new object — so it is a correct, minimal effect dependency (no need
  // to serialise it): the effects re-run exactly when the filter actually changes.

  // --- The page -------------------------------------------------------------
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
        const result = await fetchBookingsPage(
          tenantId,
          propertyId,
          page,
          pageSize,
          filters,
        );
        if (cancelled) return;
        const lastPage = Math.max(1, Math.ceil(result.count / pageSize));
        if (page > lastPage) {
          setPageState(lastPage);
          return; // effect re-runs with the corrected page
        }
        setRows(result.rows);
        setCount(result.count);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        // Preserve the raw error (PostgREST errors are plain objects, not Error
        // instances); describeError extracts message/details/hint/code (rule 11).
        setError(e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [tenantId, propertyId, page, pageSize, filters, nonce]);

  // --- The summary (filter-scoped, page-independent — rule 20) ---------------
  useEffect(() => {
    let cancelled = false;

    (async () => {
      setSummaryLoading(true);
      if (!tenantId || !propertyId) {
        if (cancelled) return;
        setSummary(null);
        setSummaryLoading(false);
        return;
      }
      try {
        const result = await fetchBookingSummary(tenantId, propertyId, filters);
        if (cancelled) return;
        setSummary(result);
      } catch {
        if (cancelled) return;
        // The summary is supplementary; a failure here must not blank the list.
        // The list effect surfaces read errors; here we simply drop the summary.
        setSummary(null);
      } finally {
        if (!cancelled) setSummaryLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [tenantId, propertyId, filters, nonce]);

  return {
    rows,
    count,
    page,
    pageSize,
    filters,
    summary,
    summaryLoading,
    loading,
    error,
    setPage,
    setPageSize,
    setFilters,
    reload,
  };
}
