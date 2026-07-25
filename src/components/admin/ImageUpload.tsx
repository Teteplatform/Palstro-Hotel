import { useCallback, useEffect, useRef, useState } from 'react';
import {
  processImage,
  ImageValidationError,
  type ProcessedImage,
} from '../../lib/imageProcessing';
import {
  fetchQuotaStatus,
  uploadProcessedImage,
  type QuotaStatus,
} from '../../lib/mediaAssets';
import type { MediaAsset, MediaCategory } from '../../types/media';

interface ImageUploadProps {
  // No hardcoded tenant/property ids (rule 17): the host screen passes the active
  // tenant (useTenantContext) and the property being edited.
  tenantId: string;
  propertyId: string;
  category: MediaCategory;
  // Called after each image's variants + rows are written, so the parent can
  // refresh its gallery. Receives the three inserted rows.
  onUploaded?: (assets: MediaAsset[]) => void;
  // Called ONCE after a batch finishes, with the trio of rows for each image that
  // uploaded successfully. The settings image fields use this to commit all new
  // ids to branding in a single write rather than one per image (build 4).
  onBatchUploaded?: (images: MediaAsset[][]) => void;
  // When false, only one file may be queued at a time — for a single-image field
  // (logo, about) where an upload REPLACES rather than adds. Defaults to true.
  multiple?: boolean;
  // Cap on how many files this instance may queue (the field's remaining slots:
  // e.g. 10 hero, 30 gallery, minus what is already stored). Selecting beyond it
  // is blocked with a message rather than silently dropped. Undefined = no cap.
  maxFiles?: number;
}

type Stage = 'processing' | 'ready' | 'uploading' | 'done' | 'error';

interface Item {
  id: string;
  file: File;
  stage: Stage;
  processed: ProcessedImage | null;
  previewUrl: string | null; // object URL of the thumb variant
  processedBytes: number; // sum of the three variants — what counts against quota
  message: string | null;
}

// Presentation-only byte formatter (MB/KB) for the "8.2 MB → 190 KB" readout and
// the quota bar. Not a money value, so it does not use the currency formatter.
function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Admin image uploader: drag-and-drop or pick, resize+re-encode client-side,
 * preview with the size reduction, then upload all three variants and index them
 * — with a quota check before any upload and per-file progress.
 *
 * Compliance notes:
 *  - Rule 11: every async step is awaited in try/catch and its error is surfaced
 *    to the user (per-file message or the shared alert), never swallowed.
 *  - Rule 17: tenant/property/category arrive as props; nothing tenant-specific
 *    is hardcoded.
 *  - Cost control: files are resized to WebP BEFORE upload, and the tenant quota
 *    is checked (usage + this batch) before a single byte is written.
 *  - No localStorage/sessionStorage anywhere.
 */
export function ImageUpload({
  tenantId,
  propertyId,
  category,
  onUploaded,
  onBatchUploaded,
  multiple = true,
  maxFiles,
}: ImageUploadProps) {
  const [items, setItems] = useState<Item[]>([]);
  const [dragging, setDragging] = useState(false);
  const [quota, setQuota] = useState<QuotaStatus | null>(null);
  const [quotaError, setQuotaError] = useState<string | null>(null);
  const [blockMessage, setBlockMessage] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const refreshQuota = useCallback(async () => {
    try {
      // Await FIRST, then setState — so nothing updates state synchronously when
      // this runs from the mount effect (react-hooks/set-state-in-effect).
      const status = await fetchQuotaStatus(tenantId);
      setQuota(status);
      setQuotaError(null);
    } catch (e) {
      setQuotaError(errorMessage(e));
    }
  }, [tenantId]);

  // Load quota on mount and whenever the tenant changes. Inlined (not a call to
  // refreshQuota) with a cancelled guard, matching the codebase's context hooks:
  // the async body await-firsts so no state updates synchronously in the effect.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const status = await fetchQuotaStatus(tenantId);
        if (cancelled) return;
        setQuota(status);
        setQuotaError(null);
      } catch (e) {
        if (!cancelled) setQuotaError(errorMessage(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tenantId]);

  // Revoke every object URL we created when the component unmounts, so previews
  // don't leak memory. (Per-item revocation on removal is handled in removeItem.)
  useEffect(() => {
    return () => {
      setItems((current) => {
        current.forEach((i) => {
          if (i.previewUrl) URL.revokeObjectURL(i.previewUrl);
        });
        return current;
      });
    };
  }, []);

  // Process one picked/dropped file into a ready (or error) item. Validation
  // failures (wrong type / too large) show their friendly message on the item.
  const addFile = useCallback(async (file: File) => {
    const id = crypto.randomUUID();
    setItems((cur) => [
      ...cur,
      {
        id,
        file,
        stage: 'processing',
        processed: null,
        previewUrl: null,
        processedBytes: 0,
        message: null,
      },
    ]);

    try {
      const processed = await processImage(file);
      const thumb =
        processed.variants.find((v) => v.size === 'thumb') ??
        processed.variants[0];
      const previewUrl = thumb ? URL.createObjectURL(thumb.blob) : null;
      const processedBytes = processed.variants.reduce(
        (sum, v) => sum + v.byteSize,
        0,
      );
      setItems((cur) =>
        cur.map((i) =>
          i.id === id
            ? { ...i, stage: 'ready', processed, previewUrl, processedBytes }
            : i,
        ),
      );
    } catch (e) {
      // ImageValidationError carries a user-ready message; other errors too.
      const message =
        e instanceof ImageValidationError
          ? e.message
          : `Could not process this image. ${errorMessage(e)}`;
      setItems((cur) =>
        cur.map((i) => (i.id === id ? { ...i, stage: 'error', message } : i)),
      );
    }
  }, []);

  const handleFiles = useCallback(
    (fileList: FileList | null) => {
      if (!fileList) return;
      setBlockMessage(null);
      const files = Array.from(fileList);

      // How many more may be queued: the single-select cap (1) or the field's
      // remaining slots, minus what is already queued (errored items don't count).
      const queued = items.filter((i) => i.stage !== 'error').length;
      const hardCap = multiple ? (maxFiles ?? Infinity) : 1;
      const room = Math.max(0, hardCap - queued);

      if (room <= 0) {
        setBlockMessage(
          multiple
            ? `You can add up to ${maxFiles} image${maxFiles === 1 ? '' : 's'} here. Remove one first to add another.`
            : 'Only one image can be uploaded here. Remove the queued one first.',
        );
        return;
      }
      if (files.length > room) {
        setBlockMessage(
          `Only ${room} more image${room === 1 ? '' : 's'} can be added here; the rest were skipped.`,
        );
      }
      files.slice(0, room).forEach((f) => void addFile(f));
    },
    [addFile, items, multiple, maxFiles],
  );

  const removeItem = useCallback((id: string) => {
    setItems((cur) => {
      const target = cur.find((i) => i.id === id);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return cur.filter((i) => i.id !== id);
    });
  }, []);

  // Upload every ready item. Quota is checked for the WHOLE batch first: current
  // usage + the sum of every ready item's processed bytes must fit under the
  // ceiling, otherwise nothing uploads and the user sees usage vs limit.
  const handleUploadAll = useCallback(async () => {
    if (uploading) return;
    const ready = items.filter((i) => i.stage === 'ready' && i.processed);
    if (ready.length === 0) return;

    if (!quota) {
      setBlockMessage(
        'Storage usage is still loading. Please try again in a moment.',
      );
      return;
    }

    const batchBytes = ready.reduce((sum, i) => sum + i.processedBytes, 0);
    if (quota.usedBytes + batchBytes > quota.quotaBytes) {
      setBlockMessage(
        `This upload needs ${formatBytes(batchBytes)}, but only ` +
          `${formatBytes(quota.availableBytes)} of your ` +
          `${formatBytes(quota.quotaBytes)} storage remains. Remove some media ` +
          `first, or ask your administrator to raise the limit.`,
      );
      return;
    }

    setBlockMessage(null);
    setUploading(true);
    // Rows for each image that uploaded cleanly, reported once at the end so the
    // parent commits all new ids in a single branding write (build 4).
    const succeeded: MediaAsset[][] = [];
    try {
      for (const item of ready) {
        setItems((cur) =>
          cur.map((i) =>
            i.id === item.id ? { ...i, stage: 'uploading', message: null } : i,
          ),
        );
        try {
          const assets = await uploadProcessedImage({
            tenantId,
            propertyId,
            category,
            processed: item.processed!,
          });
          setItems((cur) =>
            cur.map((i) =>
              i.id === item.id ? { ...i, stage: 'done' } : i,
            ),
          );
          succeeded.push(assets);
          onUploaded?.(assets);
        } catch (e) {
          setItems((cur) =>
            cur.map((i) =>
              i.id === item.id
                ? { ...i, stage: 'error', message: errorMessage(e) }
                : i,
            ),
          );
        }
      }
      if (succeeded.length > 0) onBatchUploaded?.(succeeded);
    } finally {
      setUploading(false);
      // Reflect the new usage after the batch (some may have failed; the RPC is
      // the source of truth either way).
      await refreshQuota();
    }
  }, [
    uploading,
    items,
    quota,
    tenantId,
    propertyId,
    category,
    onUploaded,
    onBatchUploaded,
    refreshQuota,
  ]);

  const readyCount = items.filter((i) => i.stage === 'ready').length;
  const usedPct =
    quota && quota.quotaBytes > 0
      ? Math.min(100, Math.round((quota.usedBytes / quota.quotaBytes) * 100))
      : 0;

  return (
    <section className="space-y-4">
      {/* Quota summary */}
      <div className="rounded-2xl border border-sand-border bg-white/60 p-4">
        <div className="flex items-center justify-between text-sm">
          <span className="font-medium text-charcoal-muted">Storage used</span>
          <span className="font-semibold text-charcoal">
            {quota
              ? `${formatBytes(quota.usedBytes)} of ${formatBytes(
                  quota.quotaBytes,
                )}`
              : quotaError
                ? 'Unavailable'
                : 'Loading…'}
          </span>
        </div>
        <div
          className="mt-2 h-2 w-full overflow-hidden rounded-full bg-sand"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={usedPct}
          aria-label="Storage used"
        >
          <div
            className="h-full bg-primary transition-all"
            style={{ width: `${usedPct}%` }}
          />
        </div>
        {quotaError ? (
          <p role="alert" className="mt-2 text-sm font-medium text-primary">
            Couldn't load storage usage: {quotaError}
          </p>
        ) : null}
      </div>

      {/* Drop zone */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          handleFiles(e.dataTransfer.files);
        }}
        className={`rounded-2xl border-2 border-dashed p-8 text-center transition-colors ${
          dragging
            ? 'border-primary bg-sand'
            : 'border-sand-border bg-white/40'
        }`}
      >
        <p className="text-sm text-charcoal-muted">
          Drag &amp; drop images here, or
        </p>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="mt-3 rounded-full border border-sand-border px-4 py-2 text-sm font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream"
        >
          Choose files
        </button>
        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          multiple={multiple}
          className="sr-only"
          onChange={(e) => {
            handleFiles(e.target.files);
            // Reset so picking the same file again re-triggers onChange.
            e.target.value = '';
          }}
        />
        <p className="mt-3 text-xs text-charcoal-muted">
          JPEG, PNG or WebP · up to 10 MB each · resized to WebP before upload
        </p>
      </div>

      {blockMessage ? (
        <p
          role="alert"
          className="rounded-xl border border-sand-border bg-sand px-4 py-3 text-sm font-medium text-charcoal"
        >
          {blockMessage}
        </p>
      ) : null}

      {/* Selected files */}
      {items.length > 0 ? (
        <ul className="space-y-3">
          {items.map((item) => (
            <li
              key={item.id}
              className="flex items-center gap-4 rounded-2xl border border-sand-border bg-white/60 p-3"
            >
              <div className="h-16 w-16 flex-shrink-0 overflow-hidden rounded-lg bg-sand">
                {item.previewUrl ? (
                  <img
                    src={item.previewUrl}
                    alt=""
                    className="h-full w-full object-cover"
                  />
                ) : null}
              </div>

              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-charcoal">
                  {item.file.name}
                </p>
                <p className="mt-0.5 text-xs text-charcoal-muted">
                  {item.stage === 'ready' ||
                  item.stage === 'uploading' ||
                  item.stage === 'done' ? (
                    <>
                      {formatBytes(item.file.size)} reduced to{' '}
                      <span className="font-semibold text-charcoal">
                        {formatBytes(item.processedBytes)}
                      </span>{' '}
                      across 3 sizes
                    </>
                  ) : (
                    formatBytes(item.file.size)
                  )}
                </p>
                {item.message ? (
                  <p
                    role="alert"
                    className="mt-1 text-xs font-medium text-primary"
                  >
                    {item.message}
                  </p>
                ) : null}
              </div>

              <div className="flex flex-shrink-0 items-center gap-3">
                <StatusBadge stage={item.stage} />
                {item.stage !== 'uploading' && item.stage !== 'done' ? (
                  <button
                    type="button"
                    onClick={() => removeItem(item.id)}
                    className="text-xs font-semibold text-charcoal-muted underline-offset-2 hover:text-charcoal hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream"
                  >
                    Remove
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      {/* Upload action */}
      {readyCount > 0 ? (
        <button
          type="button"
          onClick={() => void handleUploadAll()}
          disabled={uploading}
          className="rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:opacity-60"
        >
          {uploading
            ? 'Uploading…'
            : `Upload ${readyCount} image${readyCount === 1 ? '' : 's'}`}
        </button>
      ) : null}
    </section>
  );
}

function StatusBadge({ stage }: { stage: Stage }) {
  const label: Record<Stage, string> = {
    processing: 'Processing…',
    ready: 'Ready',
    uploading: 'Uploading…',
    done: 'Uploaded',
    error: 'Failed',
  };
  // Neutral chip; the row's own alert text carries any error detail.
  return (
    <span
      aria-live="polite"
      className="whitespace-nowrap rounded-full bg-sand px-2.5 py-1 text-xs font-semibold text-charcoal"
    >
      {label[stage]}
    </span>
  );
}
