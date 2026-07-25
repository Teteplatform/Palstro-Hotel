import { useCallback, useEffect, useState } from 'react';
import { fetchRoomTypesPage } from '../lib/roomTypes';
import type { RoomType } from '../types/room';

// Server-side paginated room types for the ADMIN screen (build 5a). Distinct
// from useRoomTypes (guest, published-only, fetchAllPaged): this keeps page /
// pageSize state, fetches exactly one .range() window with an exact count (rule
// 1b — never a client slice of a capped fetch), and exposes reload() so a
// create/edit/delete re-pulls the current page.
//
// Follows the codebase's context-hook shape: every state update lives inside the
// async body (await-first), never synchronously in the effect, and a cancelled
// guard drops a stale in-flight load.

const DEFAULT_PAGE_SIZE = 10;

export interface UseAdminRoomTypesResult {
  rows: RoomType[];
  count: number;
  page: number;
  pageSize: number;
  loading: boolean;
  error: Error | null;
  setPage: (page: number) => void;
  setPageSize: (size: number) => void;
  reload: () => Promise<void>;
}

export function useAdminRoomTypes(
  propertyId: string | null,
  tenantId: string | null,
): UseAdminRoomTypesResult {
  const [rows, setRows] = useState<RoomType[]>([]);
  const [count, setCount] = useState(0);
  const [page, setPageState] = useState(1);
  const [pageSize, setPageSizeState] = useState(DEFAULT_PAGE_SIZE);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  // Bumped by reload() to force a re-fetch of the same page without changing
  // page/pageSize identity.
  const [nonce, setNonce] = useState(0);

  const setPage = useCallback((next: number) => {
    setPageState(Math.max(1, next));
  }, []);

  // Changing page size resets to page 1, so the user never lands on a now-empty
  // high page after enlarging the window.
  const setPageSize = useCallback((size: number) => {
    setPageSizeState(size);
    setPageState(1);
  }, []);

  const reload = useCallback(async () => {
    setNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      setLoading(true);
      if (!propertyId || !tenantId) {
        if (cancelled) return;
        setRows([]);
        setCount(0);
        setError(null);
        setLoading(false);
        return;
      }
      try {
        const result = await fetchRoomTypesPage(
          propertyId,
          tenantId,
          page,
          pageSize,
        );
        if (cancelled) return;
        // If a delete emptied the current page (page now past the end), step back
        // one page and let the effect re-run — so the user is never stranded on a
        // blank page that still shows rows exist.
        const lastPage = Math.max(1, Math.ceil(result.count / pageSize));
        if (page > lastPage) {
          setPageState(lastPage);
          return; // effect re-runs with the corrected page; keep loading true
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
  }, [propertyId, tenantId, page, pageSize, nonce]);

  return {
    rows,
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
