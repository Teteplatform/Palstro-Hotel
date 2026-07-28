import { useCallback, useEffect, useState } from 'react';
import { fetchCompaniesPage } from '../lib/companies';
import type { Company } from '../types/company';

// Server-side paginated companies for the admin screen (build 6b §2), mirroring
// useAdminRoomTypes: one .range() window with an exact count (rule 1b — never a
// client slice of a capped fetch), a server-side name filter (rule 1b/20), and
// reload() so a create/edit/delete re-pulls the current page. Every state update
// lives inside the async body; a cancelled guard drops a stale in-flight load.

const DEFAULT_PAGE_SIZE = 10;

export interface UseCompaniesResult {
  rows: Company[];
  count: number;
  page: number;
  pageSize: number;
  nameFilter: string;
  loading: boolean;
  error: Error | null;
  setPage: (page: number) => void;
  setPageSize: (size: number) => void;
  setNameFilter: (name: string) => void;
  reload: () => Promise<void>;
}

export function useCompanies(tenantId: string | null): UseCompaniesResult {
  const [rows, setRows] = useState<Company[]>([]);
  const [count, setCount] = useState(0);
  const [page, setPageState] = useState(1);
  const [pageSize, setPageSizeState] = useState(DEFAULT_PAGE_SIZE);
  const [nameFilter, setNameFilterState] = useState('');
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

  // Changing the filter resets to page 1 so the user never lands on a now-empty
  // high page after narrowing the set (rule 1b: filter then page, not reverse).
  const setNameFilter = useCallback((name: string) => {
    setNameFilterState(name);
    setPageState(1);
  }, []);

  const reload = useCallback(async () => {
    setNonce((n) => n + 1);
  }, []);

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
        const result = await fetchCompaniesPage(
          tenantId,
          page,
          pageSize,
          nameFilter,
        );
        if (cancelled) return;
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
  }, [tenantId, page, pageSize, nameFilter, nonce]);

  return {
    rows,
    count,
    page,
    pageSize,
    nameFilter,
    loading,
    error,
    setPage,
    setPageSize,
    setNameFilter,
    reload,
  };
}
