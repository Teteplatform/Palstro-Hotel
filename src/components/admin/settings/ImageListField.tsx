import { useState } from 'react';
import { ImageUpload } from '../ImageUpload';
import { useToast } from '../../ui/Toast';
import { brandingStringArray } from '../../../lib/branding';
import { mediaUrl } from '../../../lib/mediaUrl';
import { canonicalAssetId, deleteMediaAsset } from '../../../lib/mediaAssets';
import { ArrowUpIcon, ArrowDownIcon, CloseIcon } from '../../ui/icons';
import type { MediaAsset } from '../../../types/media';
import type { ImageSettingsField } from '../../../lib/settings/schema';
import {
  commitBrandingPatch,
  mediaErrorMessage,
  type SettingsMediaContext,
} from './mediaFieldContext';

// The ordered-image-list renderer (build 4 §1) — hero images, gallery. Order is
// not decoration: the FIRST hero image is what a visitor sees before the carousel
// advances, so reordering is a first-class action, available BOTH by drag and by
// keyboard-accessible up/down controls. Persists immediately like ImageField; the
// per-field maximum comes from the schema (10 hero, 30 gallery), never a literal.

interface ImageListFieldProps {
  field: ImageSettingsField;
  ctx: SettingsMediaContext;
  disabled?: boolean;
}

// Pure array move — pull `from` out and splice it back in at `to`.
function moveItem<T>(arr: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= arr.length || to >= arr.length) {
    return arr;
  }
  const next = arr.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

export function ImageListField({ field, ctx, disabled }: ImageListFieldProps) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  const brandingKey =
    field.storage && field.storage.target === 'branding'
      ? field.storage.brandingKey
      : field.key;
  const ids = brandingStringArray(ctx.branding, brandingKey);
  const max = field.max ?? Infinity;
  const remaining = Math.max(0, max - ids.length);
  const locked = disabled || busy;

  async function commitIds(nextIds: string[], successMsg: string) {
    setBusy(true);
    try {
      await commitBrandingPatch(ctx, { [brandingKey]: nextIds });
      toast.success(successMsg);
    } catch (e) {
      toast.error(mediaErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  // Append newly-uploaded images (their rows already exist). Commit the new order
  // once for the whole batch, then reload so the thumbnails resolve.
  async function handleAdd(images: MediaAsset[][]) {
    const newIds = images
      .map((trio) => canonicalAssetId(trio))
      .filter((id): id is string => Boolean(id));
    if (newIds.length === 0) return;
    const next = [...ids, ...newIds];
    setBusy(true);
    try {
      await commitBrandingPatch(ctx, { [brandingKey]: next });
      await ctx.reloadAssets();
      toast.success(`Added ${newIds.length} image${newIds.length === 1 ? '' : 's'}.`);
    } catch (e) {
      toast.error(mediaErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  // Remove one image: drop its id FIRST (no dangling reference), then delete its
  // files. A delete failure after the drop leaves findable orphans — safe.
  async function handleRemove(id: string) {
    const oldAsset = ctx.assets.get(id);
    const next = ids.filter((x) => x !== id);
    setBusy(true);
    try {
      await commitBrandingPatch(ctx, { [brandingKey]: next });
      if (oldAsset) await deleteMediaAsset(oldAsset);
      await ctx.reloadAssets();
      toast.success('Image removed.');
    } catch (e) {
      toast.error(mediaErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  function handleMove(from: number, to: number) {
    const next = moveItem(ids, from, to);
    if (next === ids) return;
    void commitIds(next, 'Order updated.');
  }

  function handleDrop(target: number) {
    if (dragIndex === null) return;
    handleMove(dragIndex, target);
    setDragIndex(null);
  }

  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-sm font-medium text-charcoal">{field.label}</span>
        <span className="text-xs text-charcoal-muted">
          {ids.length} / {max === Infinity ? '∞' : max}
        </span>
      </div>

      {ids.length > 0 ? (
        <ul className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
          {ids.map((id, i) => {
            const url = mediaUrl(ctx.assets, id, 'thumb');
            return (
              <li
                key={id}
                draggable={!locked}
                onDragStart={() => setDragIndex(i)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => handleDrop(i)}
                onDragEnd={() => setDragIndex(null)}
                className={`group relative overflow-hidden rounded-xl border bg-sand ${
                  dragIndex === i ? 'border-primary opacity-60' : 'border-sand-border'
                } ${locked ? '' : 'cursor-grab'}`}
              >
                <div className="aspect-[4/3] w-full">
                  {url ? (
                    <img
                      src={url}
                      alt={`${field.label} ${i + 1}`}
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    // The id resolved to no live asset (deleted since referenced).
                    // Show a labelled gap, not a broken image.
                    <div className="flex h-full w-full items-center justify-center px-2 text-center text-[11px] text-charcoal-muted">
                      Image unavailable
                    </div>
                  )}
                </div>

                {i === 0 ? (
                  <span className="absolute left-1.5 top-1.5 rounded-full bg-primary px-2 py-0.5 text-[10px] font-semibold text-white">
                    Shown first
                  </span>
                ) : null}

                {/* Keyboard-accessible reorder + remove. Buttons, not drag-only,
                    so order is reachable without a pointer (build 4 §1). */}
                <div className="flex items-center justify-between gap-1 bg-white/80 px-1.5 py-1">
                  <div className="flex gap-0.5">
                    <IconBtn
                      label={`Move ${field.label} ${i + 1} earlier`}
                      onClick={() => handleMove(i, i - 1)}
                      disabled={locked || i === 0}
                    >
                      <ArrowUpIcon className="h-3.5 w-3.5" />
                    </IconBtn>
                    <IconBtn
                      label={`Move ${field.label} ${i + 1} later`}
                      onClick={() => handleMove(i, i + 1)}
                      disabled={locked || i === ids.length - 1}
                    >
                      <ArrowDownIcon className="h-3.5 w-3.5" />
                    </IconBtn>
                  </div>
                  <IconBtn
                    label={`Remove ${field.label} ${i + 1}`}
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
          No images yet — upload some below.
        </div>
      )}

      {remaining > 0 ? (
        // Keyed by count so a successful add remounts the uploader, clearing its
        // done list. maxFiles caps the batch to the field's remaining slots.
        <ImageUpload
          key={`imagelist-${brandingKey}-${ids.length}`}
          tenantId={ctx.tenantId}
          propertyId={ctx.propertyId}
          category={field.mediaCategory}
          maxFiles={remaining}
          onBatchUploaded={(images) => void handleAdd(images)}
        />
      ) : (
        <p className="rounded-xl border border-sand-border bg-sand px-4 py-3 text-xs font-medium text-charcoal">
          You’ve reached the maximum of {max} image{max === 1 ? '' : 's'}. Remove one to add another.
        </p>
      )}

      {field.help ? (
        <p className="mt-1 text-xs text-charcoal-muted">{field.help}</p>
      ) : null}
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
