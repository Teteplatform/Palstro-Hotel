import { useState } from 'react';
import { ImageUpload } from '../ImageUpload';
import { useToast } from '../../ui/Toast';
import { mediaUrl, type MediaAssetMap } from '../../../lib/mediaUrl';
import { canonicalAssetId, deleteMediaAsset } from '../../../lib/mediaAssets';
import { humanizeError } from '../../../lib/errors';
import { ArrowUpIcon, ArrowDownIcon, CloseIcon } from '../../ui/icons';
import type { MediaAsset } from '../../../types/media';

// The room-type image editor — the SAME id-based media pattern as the settings
// ImageListField (build 4), but the ids are stored on room_types.images (a jsonb
// ordered array) instead of on branding. Order matters: the FIRST image is the
// room card's photo on the guest site (RoomsSection.resolveRoomImage), so
// reordering is a first-class action, by drag AND keyboard-accessible up/down.
//
// Persistence mirrors ImageListField exactly:
//   - add: append the new ids, persist, then reload the media map so thumbnails
//     resolve,
//   - remove: drop the id FIRST (no dangling reference), then delete its files —
//     a delete failure after the drop leaves findable orphans, the safe direction,
//   - reorder: persist the new id order.
// Every write is awaited in try/catch and its error surfaced (rule 11).

const MAX_ROOM_IMAGES = 12;

interface RoomTypeImagesProps {
  tenantId: string;
  propertyId: string;
  imageIds: string[];
  mediaMap: MediaAssetMap;
  // Persist the next id order to room_types.images and adopt the returned row.
  // Provided by the parent editor (updateRoomType). Throws on failure.
  onPersist: (nextIds: string[]) => Promise<void>;
  reloadMedia: () => Promise<void>;
  disabled?: boolean;
}

function moveItem<T>(arr: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= arr.length || to >= arr.length) {
    return arr;
  }
  const next = arr.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

export function RoomTypeImages({
  tenantId,
  propertyId,
  imageIds,
  mediaMap,
  onPersist,
  reloadMedia,
  disabled,
}: RoomTypeImagesProps) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  const remaining = Math.max(0, MAX_ROOM_IMAGES - imageIds.length);
  const locked = disabled || busy;

  async function handleAdd(images: MediaAsset[][]) {
    const newIds = images
      .map((trio) => canonicalAssetId(trio))
      .filter((id): id is string => Boolean(id));
    if (newIds.length === 0) return;
    setBusy(true);
    try {
      await onPersist([...imageIds, ...newIds]);
      await reloadMedia();
      toast.success(
        `Added ${newIds.length} image${newIds.length === 1 ? '' : 's'}.`,
      );
    } catch (e) {
      toast.error(humanizeError(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove(id: string) {
    const oldAsset = mediaMap.get(id);
    setBusy(true);
    try {
      await onPersist(imageIds.filter((x) => x !== id));
      if (oldAsset) await deleteMediaAsset(oldAsset);
      await reloadMedia();
      toast.success('Image removed.');
    } catch (e) {
      toast.error(humanizeError(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleMove(from: number, to: number) {
    const next = moveItem(imageIds, from, to);
    if (next === imageIds) return;
    setBusy(true);
    try {
      await onPersist(next);
      toast.success('Order updated.');
    } catch (e) {
      toast.error(humanizeError(e));
    } finally {
      setBusy(false);
    }
  }

  function handleDrop(target: number) {
    if (dragIndex === null) return;
    void handleMove(dragIndex, target);
    setDragIndex(null);
  }

  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-sm font-medium text-charcoal">Photos</span>
        <span className="text-xs text-charcoal-muted">
          {imageIds.length} / {MAX_ROOM_IMAGES}
        </span>
      </div>

      {imageIds.length > 0 ? (
        <ul className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
          {imageIds.map((id, i) => {
            const url = mediaUrl(mediaMap, id, 'thumb');
            return (
              <li
                key={id}
                draggable={!locked}
                onDragStart={() => setDragIndex(i)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => handleDrop(i)}
                onDragEnd={() => setDragIndex(null)}
                className={`group relative overflow-hidden rounded-xl border bg-sand ${
                  dragIndex === i
                    ? 'border-primary opacity-60'
                    : 'border-sand-border'
                } ${locked ? '' : 'cursor-grab'}`}
              >
                <div className="aspect-[4/3] w-full">
                  {url ? (
                    <img
                      src={url}
                      alt={`Room photo ${i + 1}`}
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center px-2 text-center text-[11px] text-charcoal-muted">
                      Image unavailable
                    </div>
                  )}
                </div>

                {i === 0 ? (
                  <span className="absolute left-1.5 top-1.5 rounded-full bg-primary px-2 py-0.5 text-[10px] font-semibold text-white">
                    Card photo
                  </span>
                ) : null}

                <div className="flex items-center justify-between gap-1 bg-white/80 px-1.5 py-1">
                  <div className="flex gap-0.5">
                    <IconBtn
                      label={`Move photo ${i + 1} earlier`}
                      onClick={() => void handleMove(i, i - 1)}
                      disabled={locked || i === 0}
                    >
                      <ArrowUpIcon className="h-3.5 w-3.5" />
                    </IconBtn>
                    <IconBtn
                      label={`Move photo ${i + 1} later`}
                      onClick={() => void handleMove(i, i + 1)}
                      disabled={locked || i === imageIds.length - 1}
                    >
                      <ArrowDownIcon className="h-3.5 w-3.5" />
                    </IconBtn>
                  </div>
                  <IconBtn
                    label={`Remove photo ${i + 1}`}
                    onClick={() => void handleRemove(id)}
                    disabled={locked}
                  >
                    <CloseIcon className="h-3.5 w-3.5" />
                  </IconBtn>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="mb-3 flex items-center justify-center rounded-xl border border-dashed border-sand-border bg-white/40 px-4 py-6 text-center text-xs text-charcoal-muted">
          No photos yet — upload some below. The first one becomes the card photo.
        </div>
      )}

      {remaining > 0 ? (
        // Keyed by count so a successful add remounts the uploader (clears its
        // done list). category 'rooms' routes the files to the right bucket path.
        <ImageUpload
          key={`roomimages-${imageIds.length}`}
          tenantId={tenantId}
          propertyId={propertyId}
          category="rooms"
          maxFiles={remaining}
          onBatchUploaded={(images) => void handleAdd(images)}
        />
      ) : (
        <p className="rounded-xl border border-sand-border bg-sand px-4 py-3 text-xs font-medium text-charcoal">
          You’ve reached the maximum of {MAX_ROOM_IMAGES} photos. Remove one to
          add another.
        </p>
      )}
    </div>
  );
}

function IconBtn({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className="rounded-md p-1 text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}
