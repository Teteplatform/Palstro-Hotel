import { useEffect, useState } from 'react';
import { ImageUpload } from '../ImageUpload';
import { useToast } from '../../ui/Toast';
import { describeError } from '../../../lib/errors';
import { fetchMediaAssetsByIds } from '../../../lib/mediaAssets';
import { mediaVariantUrl } from '../../../lib/mediaUrl';
import { commitItemImage, removeItemImage } from '../../../lib/itemImages';
import type { MediaAsset } from '../../../types/media';

// ONE PICTURE PER ITEM (1.1e §3), on the item's own form.
//
// ---------------------------------------------------------------------------
// IT REUSES THE EXISTING UPLOADER, WHICH IS THE POINT OF THE SHIPMENT
// ---------------------------------------------------------------------------
// ImageUpload already does the whole job: it rejects a file over 10MB before any
// decode, resizes to three WebP variants in the browser, shows the reduction
// ("8.2 MB reduced to 190 KB"), reads the tenant's quota and refuses a batch that
// would exceed it, and reports each failure against the file it belongs to. Every
// one of those is a thing a second uploader would have to get right again.
//
// So this component owns exactly two things ImageUpload cannot know about: WHERE
// the id gets committed, and WHEN the old bytes are released. Both live in
// lib/itemImages, in one function each, with the ordering rule written down.
//
// ---------------------------------------------------------------------------
// WHY THE PICTURE IS ONLY EDITABLE ON AN ITEM THAT EXISTS
// ---------------------------------------------------------------------------
// The add form says so in one line rather than offering an upload. This is not a
// limitation that was easier — it is the only version with no orphan in it.
//
// To upload during "add", the files would have to be written BEFORE the item, and
// their media_assets rows would then be referenced by nothing until the form was
// submitted. Abandon the form — close it, navigate away, lose the connection at
// the wrong moment — and those bytes are unreferenced, counting against the quota,
// with nothing pointing at them. Property media has OrphanCleanup to find that
// case; tenant-level item media deliberately does not (see lib/itemImages), so
// the correct answer is to make it unreachable rather than to sweep up after it.
//
// An upload therefore always has an item to attach to at the moment it happens.

interface ItemImageFieldProps {
  tenantId: string;
  itemId: string;
  itemName: string;
  // The item's current picture id, as the row holds it. NULL for none.
  imageAssetId: string | null;
  // Called after the item's image_asset_id has changed, so the list behind the
  // panel re-pulls rather than showing the previous picture until a refresh.
  onChanged: () => Promise<void> | void;
  disabled?: boolean;
}

export function ItemImageField({
  tenantId,
  itemId,
  itemName,
  imageAssetId,
  onChanged,
  disabled,
}: ItemImageFieldProps) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  // The current asset ROW, not just its id: replace and remove both need its
  // bucket_path to derive the three variant paths they are releasing.
  const [current, setCurrent] = useState<MediaAsset | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Resolve the stored id to its row. Await-first then setState, matching the
  // codebase's other loaders (react-hooks/set-state-in-effect).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!imageAssetId) {
        if (!cancelled) {
          setCurrent(null);
          setLoadError(null);
        }
        return;
      }
      try {
        const map = await fetchMediaAssetsByIds(tenantId, [imageAssetId]);
        if (cancelled) return;
        // An id whose asset is gone resolves to null, and the field then reads as
        // "no picture" — a dangling reference is never a broken image.
        setCurrent(map.get(imageAssetId) ?? null);
        setLoadError(null);
      } catch (e) {
        // Rule 11: surfaced. Shown as "could not load the picture", never as an
        // empty well, which would invite somebody to upload a second copy of a
        // picture that is already there and already costing quota.
        if (!cancelled) setLoadError(describeError(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tenantId, imageAssetId]);

  // ImageUpload has already written the new variants and their rows by the time
  // this runs — it reports them here. commitItemImage points the item at the new
  // asset and only THEN releases the old bytes; see lib/itemImages for why that
  // order, and what each possible failure leaves behind.
  async function handleUploaded(images: MediaAsset[][]) {
    // Single-select, so there is at most one image and `images[0]` is its variants.
    const uploaded = images[0];
    if (!uploaded || uploaded.length === 0) return;
    setBusy(true);
    try {
      const referenced = await commitItemImage({
        tenantId,
        itemId,
        uploaded,
        currentAsset: current,
      });
      // Held locally as well as reported upward: the local copy is what renders the
      // new picture on THIS pass, so the preview never blanks while the list behind
      // the panel refetches.
      setCurrent(referenced);
      toast.success('Picture saved.');
      await onChanged();
    } catch (e) {
      // Rule 11: surfaced, never swallowed. The item keeps whatever picture it had.
      toast.error(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove() {
    setBusy(true);
    try {
      await removeItemImage(tenantId, itemId, current);
      setCurrent(null);
      toast.success('Picture removed. Its space is free again.');
      await onChanged();
    } catch (e) {
      toast.error(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  const locked = disabled || busy;
  // The 'card' variant for a 160px preview, never 'full': a settings-sized preview
  // pulling the 1920px file is wasted egress on every panel open (build 4 §1).
  const previewUrl = current ? mediaVariantUrl(current.bucket_path, 'card') : null;

  return (
    <div>
      {loadError ? (
        <p
          role="alert"
          className="mb-3 rounded-xl border border-sand-border bg-white/60 p-3 text-xs text-charcoal-muted"
        >
          This item’s picture could not be loaded, so it is not shown: {loadError}
        </p>
      ) : null}

      {previewUrl ? (
        <div className="mb-3 flex items-start gap-4">
          <div className="h-28 w-28 flex-shrink-0 overflow-hidden rounded-xl border border-sand-border bg-sand">
            <img
              src={previewUrl}
              alt={`${itemName}`}
              className="h-full w-full object-cover"
            />
          </div>
          <button
            type="button"
            onClick={() => void handleRemove()}
            disabled={locked}
            className="rounded-lg border border-sand-border px-3 py-1.5 text-xs font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? 'Working…' : 'Remove picture'}
          </button>
        </div>
      ) : null}

      {/* Single-select: an item has ONE picture, so uploading replaces rather than
          adds. Keyed by the current id so a successful replace remounts the
          uploader and clears its finished list. */}
      <ImageUpload
        key={`item-image-${current?.id ?? 'empty'}`}
        tenantId={tenantId}
        // NULL: 'items' is the tenant-level category, because the catalogue is
        // tenant-wide and a picture of Rice is the same Rice at every property.
        propertyId={null}
        category="items"
        multiple={false}
        onBatchUploaded={(images) => void handleUploaded(images)}
      />
    </div>
  );
}
