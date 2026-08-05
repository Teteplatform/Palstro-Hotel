import { useCallback, useEffect, useState } from 'react';
import { fetchAllCategories, fetchAllUnits } from '../lib/inventory';
import type { InventoryCategory, UnitOfMeasure } from '../types/inventory';

// The tenant's inventory REFERENCE data — units of measure and item categories —
// loaded once for the whole items screen. Both are consumed in full (they are
// pickers and filter lists, not paged surfaces), so both go through
// fetchAllPaged in the data layer (rule 1a).
//
// Loaded TOGETHER in one hook because every consumer needs both at once: the
// item form picks a unit and a category, the filter bar lists categories, and
// the list renders a unit label and a category name per row. Two hooks would
// mean two loading flags and two error states to reconcile on one screen.
//
// reload() re-pulls both after a category is added/renamed/removed, so the
// pickers stay in step with the manage panel without a page refresh.

export interface UseInventoryReferenceResult {
  units: UnitOfMeasure[];
  categories: InventoryCategory[];
  loading: boolean;
  error: Error | null;
  reload: () => Promise<void>;
}

export function useInventoryReference(
  tenantId: string | null,
): UseInventoryReferenceResult {
  const [units, setUnits] = useState<UnitOfMeasure[]>([]);
  const [categories, setCategories] = useState<InventoryCategory[]>([]);
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
      if (!tenantId) {
        if (cancelled) return;
        setUnits([]);
        setCategories([]);
        setError(null);
        setLoading(false);
        return;
      }
      try {
        // Independent reads, so they run concurrently rather than in sequence.
        const [unitRows, categoryRows] = await Promise.all([
          fetchAllUnits(tenantId),
          fetchAllCategories(tenantId),
        ]);
        if (cancelled) return;
        setUnits(unitRows);
        setCategories(categoryRows);
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
  }, [tenantId, nonce]);

  return { units, categories, loading, error, reload };
}
