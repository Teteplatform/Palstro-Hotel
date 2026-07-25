import { useCallback, useEffect, useState } from 'react';
import { fetchPropertyMedia } from '../lib/mediaAssets';
import { buildMediaMap, type MediaAssetMap } from '../lib/mediaUrl';
import type { MediaAsset } from '../types/media';

// Loads a property's live media_assets once and keeps them as both a flat list
// (orphan scans, totals) and an id -> asset map (id -> URL resolution). Used by
// BOTH the guest render path (anon, under the 010 public policy) and the admin
// settings surface (member policy). reload() re-fetches after an upload or delete
// so the resolved images and the orphan list stay current without a page refresh.
//
// Follows the codebase's context-hook shape: every state update lives inside the
// async body (await-first), never synchronously in the effect, so nothing trips
// the cascading-render lint. A cancelled guard drops a stale in-flight load.

export interface PropertyMedia {
  assets: MediaAsset[];
  map: MediaAssetMap;
  loading: boolean;
  error: Error | null;
  reload: () => Promise<void>;
}

export function usePropertyMedia(
  propertyId: string | null,
  tenantId: string | null,
): PropertyMedia {
  const [assets, setAssets] = useState<MediaAsset[]>([]);
  const [map, setMap] = useState<MediaAssetMap>(() => new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const load = useCallback(async () => {
    if (!propertyId || !tenantId) {
      setAssets([]);
      setMap(new Map());
      setLoading(false);
      setError(null);
      return;
    }
    try {
      const rows = await fetchPropertyMedia(propertyId, tenantId);
      setAssets(rows);
      setMap(buildMediaMap(rows));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setLoading(false);
    }
  }, [propertyId, tenantId]);

  useEffect(() => {
    let cancelled = false;
    // Every state update lives inside the async body (await-first), never
    // synchronously in the effect, matching the codebase's context hooks.
    (async () => {
      setLoading(true);
      if (!propertyId || !tenantId) {
        if (cancelled) return;
        setAssets([]);
        setMap(new Map());
        setLoading(false);
        setError(null);
        return;
      }
      try {
        const rows = await fetchPropertyMedia(propertyId, tenantId);
        if (cancelled) return;
        setAssets(rows);
        setMap(buildMediaMap(rows));
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
  }, [propertyId, tenantId]);

  return { assets, map, loading, error, reload: load };
}
