import { useCallback, useEffect, useState } from 'react';
import { fetchGuestById } from '../lib/guests';
import {
  fetchGuestHistorySummary,
  fetchGuestStaysPage,
} from '../lib/guestLedger';
import type { Guest } from '../types/guest';
import type { GuestHistorySummary, GuestStayRow } from '../types/guestLedger';

// The guest detail page's data (2.txt §2): the guest record, their stay history
// summary, and one server-paginated page of their stays.
//
// THREE READS, DELIBERATELY SEPARATE — the same shape useBookings uses:
//   * the GUEST row (tenant-scoped; a guest is shared across a tenant's
//     properties, so no property filter here — 014),
//   * the SUMMARY, aggregated across EVERY stay at this property (rule 20), so
//     it is independent of which page is showing and never a page-derived
//     lifetime figure,
//   * the PAGE, one .range() window with an exact count (rule 1b).
// The summary re-fetches only when the guest/property changes or something is
// reloaded; the page also re-fetches on a page/size change.
//
// NOTHING IS CACHED (rule 6): after any mutation the caller calls reload() and
// every figure is re-read from the views, which recompute folio_totals and the
// FIFO allocation from scratch.

const DEFAULT_PAGE_SIZE = 10;

export interface UseGuestHistoryResult {
  guest: Guest | null;
  // True once the guest read has completed and found nothing — a deleted or
  // cross-tenant id. Distinct from "still loading" so the page can say so.
  notFound: boolean;
  summary: GuestHistorySummary | null;
  summaryLoading: boolean;
  stays: GuestStayRow[];
  count: number;
  page: number;
  pageSize: number;
  loading: boolean;
  // The RAW error, preserved (a PostgREST error is a plain object, not an Error);
  // rendered through describeError so message/details/hint/code surface (rule 11).
  error: unknown;
  setPage: (page: number) => void;
  setPageSize: (size: number) => void;
  reload: () => Promise<void>;
}

export function useGuestHistory(
  guestId: string | null,
  tenantId: string | null,
  propertyId: string | null,
): UseGuestHistoryResult {
  const [guest, setGuest] = useState<Guest | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [summary, setSummary] = useState<GuestHistorySummary | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [stays, setStays] = useState<GuestStayRow[]>([]);
  const [count, setCount] = useState(0);
  const [page, setPageState] = useState(1);
  const [pageSize, setPageSizeState] = useState(DEFAULT_PAGE_SIZE);
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

  const reload = useCallback(async () => {
    setNonce((n) => n + 1);
  }, []);

  // --- the guest row + the lifetime summary ---------------------------------
  useEffect(() => {
    let cancelled = false;

    (async () => {
      if (!guestId || !tenantId || !propertyId) {
        if (cancelled) return;
        setGuest(null);
        setNotFound(false);
        setSummary(null);
        setSummaryLoading(false);
        return;
      }

      setSummaryLoading(true);
      try {
        const [row, totals] = await Promise.all([
          fetchGuestById(guestId, tenantId),
          fetchGuestHistorySummary(guestId, tenantId, propertyId),
        ]);
        if (cancelled) return;
        setGuest(row);
        setNotFound(row === null);
        setSummary(totals);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        setError(e);
        setSummary(null);
      } finally {
        if (!cancelled) setSummaryLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [guestId, tenantId, propertyId, nonce]);

  // --- one page of stays ----------------------------------------------------
  useEffect(() => {
    let cancelled = false;

    (async () => {
      setLoading(true);
      if (!guestId || !tenantId || !propertyId) {
        if (cancelled) return;
        setStays([]);
        setCount(0);
        setLoading(false);
        return;
      }
      try {
        const result = await fetchGuestStaysPage(
          guestId,
          tenantId,
          propertyId,
          page,
          pageSize,
        );
        if (cancelled) return;
        const lastPage = Math.max(1, Math.ceil(result.count / pageSize));
        if (page > lastPage) {
          setPageState(lastPage);
          return; // the effect re-runs with the corrected page
        }
        setStays(result.rows);
        setCount(result.count);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        setError(e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [guestId, tenantId, propertyId, page, pageSize, nonce]);

  return {
    guest,
    notFound,
    summary,
    summaryLoading,
    stays,
    count,
    page,
    pageSize,
    loading,
    error,
    setPage,
    setPageSize,
    reload,
  };
}
