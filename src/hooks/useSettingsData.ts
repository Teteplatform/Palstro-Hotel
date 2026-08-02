import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import type { SettingsRows } from '../lib/settings/values';
import type {
  Property,
  PropertyFinanceSettings,
  PropertySettings,
  TenantSettings,
} from '../types/tenant';

// Loads the four settings rows a property's settings surface reads — properties,
// property_settings, tenant_settings and property_finance_settings — in ONE pass
// (build 3, §3). Each is a single keyed row (not a list), so maybeSingle, no
// pagination needed (rule 1 is about unbounded list reads). Fetched fresh here
// rather than reused from the admin's property list, so the updated_at each
// carries is a current concurrency token for the save.
//
// Rule 19: reads are scoped to the active tenant/property EXPLICITLY, not left to
// RLS — properties and tenant_settings filter tenant_id; property_settings and
// property_finance_settings are keyed by the property_id (already tenant-bound).
// Rule 5: the property's soft-delete is filtered NULL-safe.

interface SettingsData {
  // Non-null only once all four rows are present.
  rows: SettingsRows | null;
  loading: boolean;
  error: Error | null;
  // Merge fresh rows into the baseline after a successful save, without a
  // refetch (the RPCs return the updated row).
  applyRows: (patch: Partial<SettingsRows>) => void;
  // Full reload — used when the admin chooses to reload after a concurrency
  // conflict.
  reload: () => void;
}

export function useSettingsData(
  propertyId: string,
  tenantId: string,
): SettingsData {
  const [rows, setRows] = useState<SettingsRows | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  // Bumped by reload() to re-run the effect.
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;

    // All state updates live inside the async body (never synchronously in the
    // effect) to avoid the cascading-render lint and keep one update path —
    // matching useTenantContext / useActiveProperty.
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const [propertyRes, settingsRes, tenantRes, financeRes] =
          await Promise.all([
            supabase
              .from('properties')
              .select('*')
              .eq('id', propertyId)
              .eq('tenant_id', tenantId) // rule 19: active tenant, explicit
              .is('deleted_at', null) // rule 5: NULL-safe soft-delete
              .maybeSingle<Property>(),
            supabase
              .from('property_settings')
              .select('*')
              .eq('property_id', propertyId)
              .maybeSingle<PropertySettings>(),
            supabase
              .from('tenant_settings')
              .select('*')
              .eq('tenant_id', tenantId)
              .maybeSingle<TenantSettings>(),
            supabase
              .from('property_finance_settings')
              .select('*')
              .eq('property_id', propertyId)
              .maybeSingle<PropertyFinanceSettings>(),
          ]);

        if (propertyRes.error) throw propertyRes.error;
        if (settingsRes.error) throw settingsRes.error;
        if (tenantRes.error) throw tenantRes.error;
        if (financeRes.error) throw financeRes.error;

        if (cancelled) return;

        if (
          !propertyRes.data ||
          !settingsRes.data ||
          !tenantRes.data ||
          !financeRes.data
        ) {
          // Every settings row is guaranteed by an AFTER INSERT trigger (001 for
          // the first three, 021 §3 for finance), so a missing row means the
          // property/tenant itself was not found or not accessible.
          throw new Error('Settings could not be loaded for this property.');
        }

        setRows({
          property: propertyRes.data,
          settings: settingsRes.data,
          tenant: tenantRes.data,
          finance: financeRes.data,
        });
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e : new Error(String(e)));
        setRows(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [propertyId, tenantId, nonce]);

  const applyRows = useCallback((patch: Partial<SettingsRows>) => {
    setRows((prev) => (prev ? { ...prev, ...patch } : prev));
  }, []);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  return { rows, loading, error, applyRows, reload };
}
