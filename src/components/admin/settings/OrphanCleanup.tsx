import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import { fetchAllPaged } from '../../../lib/fetchAllPaged';
import { useToast } from '../../ui/Toast';
import { mediaVariantUrl } from '../../../lib/mediaUrl';
import {
  collectReferencedIds,
  findOrphanGroups,
  deleteMediaAsset,
  type OrphanGroup,
} from '../../../lib/mediaAssets';
import type { MediaAsset } from '../../../types/media';
import type { PropertyBranding } from '../../../types/tenant';

// Orphaned-media cleanup (build 4 §4). Finds media_assets for this property that
// NO branding key and NO room type still references — files a replaced or removed
// image left behind, which otherwise bill egress forever with nothing on screen
// pointing at them — and lists them with a size total and an explicit per-image
// delete.
//
// WHY IT IS MANUAL, NEVER AN AUTOMATIC SWEEP: the reference check spans two
// sources (branding + room types) and the rooms module is still to come. An
// automatic sweep that gets that check wrong deletes a customer's photos with no
// undo — the single worst outcome for a system whose whole promise is that their
// data is safe. A list the admin reads and confirms is slower and safe; deleting
// the wrong thing is not recoverable, so we never take that risk on their behalf.

interface OrphanCleanupProps {
  propertyId: string;
  tenantId: string;
  // Live branding (from the page baseline) — reflects image edits made above, so
  // an image just removed shows up here immediately.
  branding: PropertyBranding;
  // The property's live media, shared with the image renderers.
  assets: MediaAsset[];
  reloadMedia: () => Promise<void>;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

// A room_types row reduced to its image id array (jsonb, validated defensively).
function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
}

export function OrphanCleanup({
  propertyId,
  tenantId,
  branding,
  assets,
  reloadMedia,
}: OrphanCleanupProps) {
  const toast = useToast();
  const [roomImages, setRoomImages] = useState<string[][]>([]);
  const [roomsError, setRoomsError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(true);
  const [deleting, setDeleting] = useState<string | null>(null);
  // Bumped by Rescan to re-run the room-image load (mirrors useSettingsData).
  const [nonce, setNonce] = useState(0);

  // Load every room type's image ids (paged, scoped, NULL-safe) so a room's photo
  // counts as a reference and is never flagged as an orphan. Rules 1/5/19. Every
  // state update is inside the async body (await-first), never synchronously in
  // the effect.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setScanning(true);
      try {
        const rows = await fetchAllPaged<{ images: unknown }>((from, to) =>
          supabase
            .from('room_types')
            .select('images')
            .eq('tenant_id', tenantId) // rule 19
            .eq('property_id', propertyId) // rule 19
            .is('deleted_at', null) // rule 5
            .range(from, to),
        );
        if (cancelled) return;
        setRoomImages(rows.map((r) => toStringArray(r.images)));
        setRoomsError(null);
      } catch (e) {
        if (cancelled) return;
        setRoomsError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setScanning(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [propertyId, tenantId, nonce]);

  const orphans = useMemo<OrphanGroup[]>(() => {
    const referenced = collectReferencedIds(branding, roomImages);
    return findOrphanGroups(assets, referenced);
  }, [branding, roomImages, assets]);

  const totalBytes = orphans.reduce((sum, g) => sum + g.totalBytes, 0);

  async function handleDelete(group: OrphanGroup) {
    setDeleting(group.family);
    try {
      // deleteMediaAsset removes all variant files AND soft-deletes their rows,
      // together, given any one of the group's rows (rule §6).
      await deleteMediaAsset(group.assets[0]);
      await reloadMedia();
      toast.success('Orphaned image deleted.');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleting(null);
    }
  }

  function handleRescan() {
    // reloadMedia refreshes the shared asset list (orphans recompute reactively);
    // the nonce bump re-runs the room-image load. scanning is set by the effect.
    void reloadMedia();
    setNonce((n) => n + 1);
  }

  return (
    <section
      aria-labelledby="orphan-heading"
      className="mt-8 rounded-2xl border border-sand-border bg-white/60 p-5 sm:p-6"
    >
      <header className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h2 id="orphan-heading" className="text-lg font-semibold text-charcoal">
            Unused media
          </h2>
          <p className="mt-1 text-sm text-charcoal-muted">
            Images no longer used by any setting or room. Deleting them frees
            storage. Review each before removing — this cannot be undone.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void handleRescan()}
          disabled={scanning}
          className="shrink-0 rounded-lg border border-sand-border px-3 py-1.5 text-xs font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:opacity-50"
        >
          {scanning ? 'Scanning…' : 'Rescan'}
        </button>
      </header>

      {roomsError ? (
        <p role="alert" className="text-sm font-medium text-primary">
          Couldn’t check room images: {roomsError}
        </p>
      ) : scanning ? (
        <p className="text-sm text-charcoal-muted">Scanning for unused media…</p>
      ) : orphans.length === 0 ? (
        <p className="rounded-xl border border-dashed border-sand-border bg-sand/40 px-4 py-6 text-center text-sm text-charcoal-muted">
          No unused media. Every stored image is in use.
        </p>
      ) : (
        <>
          <p className="mb-3 text-sm font-medium text-charcoal">
            {orphans.length} unused image{orphans.length === 1 ? '' : 's'} ·{' '}
            {formatBytes(totalBytes)} total
          </p>
          <ul className="space-y-3">
            {orphans.map((group) => {
              const preview = mediaVariantUrl(group.sampleBucketPath, 'thumb');
              const isDeleting = deleting === group.family;
              return (
                <li
                  key={group.family}
                  className="flex items-center gap-4 rounded-xl border border-sand-border bg-white/60 p-3"
                >
                  <div className="h-14 w-20 flex-shrink-0 overflow-hidden rounded-lg bg-sand">
                    <img
                      src={preview}
                      alt=""
                      className="h-full w-full object-cover"
                    />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold capitalize text-charcoal">
                      {group.category}
                    </p>
                    <p className="mt-0.5 text-xs text-charcoal-muted">
                      {group.assets.length} file
                      {group.assets.length === 1 ? '' : 's'} ·{' '}
                      {formatBytes(group.totalBytes)}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleDelete(group)}
                    disabled={isDeleting}
                    className="shrink-0 rounded-lg border border-primary/40 px-3 py-1.5 text-xs font-semibold text-primary transition-colors hover:bg-primary hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {isDeleting ? 'Deleting…' : 'Delete'}
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
