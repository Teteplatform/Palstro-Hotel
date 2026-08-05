import { useCallback, useEffect, useState } from 'react';
import { fetchLocations } from '../lib/inventory';
import type { StockLocation } from '../types/inventory';

// The active property's stock locations, loaded COMPLETE (fetchAllPaged in the
// data layer, rule 1a) rather than paged. See the note on fetchLocations: rule
// 1b forbids a CAPPED list with no way to reach the rest, and this is not capped
// — every row is present. Reordering needs the whole ordered list in hand, which
// a page boundary would break.
//
// reload() re-pulls after a create/rename/reorder/remove so the screen and the
// database agree without a refresh.

export interface UseLocationsResult {
  rows: StockLocation[];
  loading: boolean;
  error: Error | null;
  reload: () => Promise<void>;
}

export function useLocations(
  propertyId: string | null,
  tenantId: string | null,
): UseLocationsResult {
  const [rows, setRows] = useState<StockLocation[]>([]);
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
      if (!propertyId || !tenantId) {
        if (cancelled) return;
        setRows([]);
        setError(null);
        setLoading(false);
        return;
      }
      try {
        const result = await fetchLocations(propertyId, tenantId);
        if (cancelled) return;
        setRows(result);
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
  }, [propertyId, tenantId, nonce]);

  return { rows, loading, error, reload };
}
