import { useState } from 'react';
import { ImageUpload } from '../ImageUpload';
import { useToast } from '../../ui/Toast';
import { brandingString } from '../../../lib/branding';
import { mediaUrl } from '../../../lib/mediaUrl';
import { canonicalAssetId, deleteMediaAsset } from '../../../lib/mediaAssets';
import type { MediaAsset } from '../../../types/media';
import type { ImageSettingsField } from '../../../lib/settings/schema';
import {
  commitBrandingPatch,
  mediaErrorMessage,
  type SettingsMediaContext,
} from './mediaFieldContext';

// The single-image renderer (build 4 §1) — logo, about image. Replaces the build
// 3 disabled placeholder. Persists immediately: an upload REPLACES the current
// image (new file first, old deleted only on success — never the reverse, which
// would strand the field empty on a failed upload). Storage/quota/processing all
// come from the existing ImageUpload + lib; this only wires them to the field.

interface ImageFieldProps {
  field: ImageSettingsField;
  ctx: SettingsMediaContext;
  disabled?: boolean;
}

export function ImageField({ field, ctx, disabled }: ImageFieldProps) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const brandingKey =
    field.storage && field.storage.target === 'branding'
      ? field.storage.brandingKey
      : field.key;
  const currentId = brandingString(ctx.branding, brandingKey);
  // Display uses the `card` variant, NEVER `full`: a settings thumbnail pulling a
  // 1920px file is wasted egress on every page load (build 4 §1).
  const currentUrl = mediaUrl(ctx.assets, currentId, 'card');
  const locked = disabled || busy;

  // Replace: the new file has already uploaded (ImageUpload), so its rows exist.
  // Commit the new id FIRST; only once that succeeds do we delete the old files —
  // so a failure never leaves the field pointing at nothing.
  async function handleReplace(images: MediaAsset[][]) {
    const newId = canonicalAssetId(images[0] ?? []);
    if (!newId) return;
    const oldAsset = currentId ? ctx.assets.get(currentId) : undefined;

    setBusy(true);
    try {
      await commitBrandingPatch(ctx, { [brandingKey]: newId });
      await ctx.reloadAssets(); // pull the new rows in so the preview resolves
      if (oldAsset && oldAsset.id !== newId) {
        await deleteMediaAsset(oldAsset); // files + rows, together (rule: §6)
        await ctx.reloadAssets();
      }
      toast.success('Image updated.');
    } catch (e) {
      toast.error(mediaErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  // Remove: clear the field FIRST (no dangling reference), then delete the files.
  // If the delete fails after the clear, the files become findable orphans — the
  // safe direction, never a branding key pointing at deleted bytes.
  async function handleRemove() {
    if (!currentId) return;
    const oldAsset = ctx.assets.get(currentId);
    setBusy(true);
    try {
      await commitBrandingPatch(ctx, { [brandingKey]: null });
      if (oldAsset) await deleteMediaAsset(oldAsset);
      await ctx.reloadAssets();
      toast.success('Image removed.');
    } catch (e) {
      toast.error(mediaErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <span className="mb-1 block text-sm font-medium text-charcoal">
        {field.label}
      </span>

      {currentUrl ? (
        <div className="mb-3 flex items-start gap-4">
          <div className="h-28 w-40 flex-shrink-0 overflow-hidden rounded-xl border border-sand-border bg-sand">
            <img
              src={currentUrl}
              alt={`${field.label} preview`}
              className="h-full w-full object-cover"
            />
          </div>
          <button
            type="button"
            onClick={() => void handleRemove()}
            disabled={locked}
            className="rounded-lg border border-sand-border px-3 py-1.5 text-xs font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? 'Working…' : 'Remove'}
          </button>
        </div>
      ) : (
        <div className="mb-3 flex items-center justify-center rounded-xl border border-dashed border-sand-border bg-white/40 px-4 py-6 text-center text-xs text-charcoal-muted">
          No image set — upload one below.
        </div>
      )}

      {/* Reuse the existing uploader in single-select mode; it carries the quota
          readout and blocks an over-quota upload itself (build 4 §1). Keyed by the
          current id so a successful replace remounts it, clearing its done list. */}
      <ImageUpload
        key={`image-${brandingKey}-${currentId ?? 'empty'}`}
        tenantId={ctx.tenantId}
        propertyId={ctx.propertyId}
        category={field.mediaCategory}
        multiple={false}
        onBatchUploaded={(images) => void handleReplace(images)}
      />

      {field.help ? (
        <p className="mt-1 text-xs text-charcoal-muted">{field.help}</p>
      ) : null}
    </div>
  );
}
