import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { fetchAllPagedRows } from '../lib/fetchAllPaged';
import { boundary } from '../lib/rowParse';
import type { RoomType } from '../types/room';

// The boundary (rule 24) — the guest site's own read of room_types, so its own
// declaration. The rates are numeric and arrive as strings.
const roomTypeRows = boundary<RoomType>('room_types (guest site)')(
  ['base_rate', 'max_adults', 'max_children', 'display_order'] as const,
  ['weekend_rate', 'size_sqm'] as const,
);

export interface UseRoomTypesResult {
  roomTypes: RoomType[];
  loading: boolean;
  error: Error | null;
}

/**
 * Published room types for the guest site, ordered for display.
 *
 * Reads room_types ONLY (never rooms) — that is the bookable, advertisable
 * category. Compliance notes:
 *  - Rule 1: paginated via fetchAllPaged, never an unbounded read.
 *  - Rule 19: RLS is the floor. The room_types public policy admits every
 *    published type of every good-standing tenant, so the app MUST additionally
 *    scope to this one property and tenant or it would blend other hotels'
 *    rooms. Hence the explicit .eq('property_id') AND .eq('tenant_id').
 *  - Rule 5: deleted_at is NULL-safe — "not deleted" means deleted_at IS NULL.
 *  - is_published filtered explicitly too, so the query is correct even if it
 *    is ever run by an authenticated member (whose RLS would return unpublished
 *    types as well).
 *  - Rule 11: awaited inside try/catch; the error is surfaced to the caller,
 *    never swallowed.
 */
export function useRoomTypes(
  propertyId: string | null,
  tenantId: string | null,
): UseRoomTypesResult {
  const [roomTypes, setRoomTypes] = useState<RoomType[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    // Hold in the loading state until the property has resolved upstream.
    if (!propertyId || !tenantId) return;

    let cancelled = false;

    (async () => {
      setLoading(true);
      setError(null);
      try {
        const rows = await fetchAllPagedRows<RoomType>(roomTypeRows, (from, to) =>
          supabase
            .from('room_types')
            .select('*')
            .eq('property_id', propertyId)
            .eq('tenant_id', tenantId)
            .eq('is_published', true)
            .is('deleted_at', null)
            .order('display_order', { ascending: true })
            .order('name', { ascending: true })
            .range(from, to),
        );
        if (!cancelled) setRoomTypes(rows);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e : new Error(String(e)));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [propertyId, tenantId]);

  return { roomTypes, loading, error };
}
