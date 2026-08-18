import { supabase } from './supabase';
import { MEDIA_BUCKET, variantPath, bucketPathFamily } from './mediaUrl';
import { SIZE_VARIANTS } from './imageProcessing';
import { fetchAllPagedRows } from './fetchAllPaged';
import { boundary } from './rowParse';
import { brandingString, brandingStringArray } from './branding';
import type { ProcessedImage } from './imageProcessing';
import type { MediaAsset, MediaCategory } from '../types/media';
import type { PropertyBranding } from '../types/tenant';

// The boundary (rule 24). byte_size is int8 and width/height are int4, so all
// three arrive as JSON numbers today — which is exactly the assumption that had
// to stop being made in a comment and start being enforced in code.
const assets = boundary<MediaAsset>('media_assets')(
  ['byte_size'] as const,
  ['width', 'height'] as const,
);

// The branding keys that hold media_asset ids (build 4). One list, shared by the
// orphan reference-collector below and the 009 migration's clear. `single` keys
// hold one id; `list` keys hold an ordered id array.
export const BRANDING_IMAGE_KEYS = {
  single: ['logo_url', 'about_image'] as const,
  list: ['hero_images', 'gallery_images'] as const,
};

// One year, in seconds, as the string the Storage API expects for cacheControl.
// These objects are content-addressed (a random filename per image) and NEVER
// overwritten in place, so a long immutable cache is safe: a returning guest
// re-fetches nothing, which is the biggest single repeat-egress saving.
const ONE_YEAR_SECONDS = '31536000';

// ---------------------------------------------------------------------------
// Quota
// ---------------------------------------------------------------------------
export interface QuotaStatus {
  usedBytes: number; // sum of the tenant's live media, from tenant_storage_bytes()
  quotaBytes: number; // tenant_settings.storage_quota_bytes (the ceiling)
  availableBytes: number; // max(0, quota - used)
}

// Read a tenant's current usage (via the SECURITY DEFINER RPC) and its limit.
// Both awaited with errors surfaced (rule 11). The RPC refuses tenants the
// caller is not a member of, so this only ever answers for the active tenant.
export async function fetchQuotaStatus(
  tenantId: string,
): Promise<QuotaStatus> {
  const { data: used, error: usedErr } = await supabase.rpc(
    'tenant_storage_bytes',
    { p_tenant_id: tenantId },
  );
  if (usedErr) throw usedErr;

  // The settings row is guaranteed to exist by the 001 AFTER INSERT trigger, so
  // .single() is safe and a missing row is a real error, not an empty state.
  const { data: settings, error: setErr } = await supabase
    .from('tenant_settings')
    .select('storage_quota_bytes')
    .eq('tenant_id', tenantId)
    .single();
  if (setErr) throw setErr;

  // bigint comes back as a JS number from PostgREST (not a numeric string).
  const usedBytes = Number(used ?? 0);
  const quotaBytes = Number(settings.storage_quota_bytes);
  return {
    usedBytes,
    quotaBytes,
    availableBytes: Math.max(0, quotaBytes - usedBytes),
  };
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------
export interface UploadImageArgs {
  tenantId: string;
  propertyId: string;
  category: MediaCategory;
  processed: ProcessedImage;
}

// Upload the three processed variants and index each with a media_assets row.
// A single random filename is shared across the three variants (only the size
// segment differs), so variantPath()/mediaVariantUrl() can derive any sibling
// from one path.
//
// PARTIAL-FAILURE SAFETY (brief): if some variant objects upload but a later one
// (or the metadata insert) fails, every object already written is removed before
// the error propagates — never leaving a half-set of orphaned files that would
// bill egress with no row to find them by. The original error is what surfaces
// (rule 11); cleanup failures are swallowed so they can't mask it.
export async function uploadProcessedImage(
  args: UploadImageArgs,
): Promise<MediaAsset[]> {
  const { tenantId, propertyId, category, processed } = args;

  // crypto.randomUUID keeps the path content-addressed and collision-free, so an
  // upload never overwrites an existing object (upsert:false enforces it too).
  const filename = `${crypto.randomUUID()}.webp`;
  const base = `${tenantId}/${propertyId}/${category}`;
  const pathFor = (size: string) => `${base}/${size}/${filename}`;

  const uploaded: string[] = [];
  try {
    // 1. Upload each variant, awaited one at a time so a failure stops
    //    immediately and cleanup removes exactly what was written.
    for (const v of processed.variants) {
      const path = pathFor(v.size);
      const { error } = await supabase.storage
        .from(MEDIA_BUCKET)
        .upload(path, v.blob, {
          contentType: 'image/webp',
          cacheControl: ONE_YEAR_SECONDS,
          upsert: false, // content-addressed paths are never overwritten in place
        });
      if (error) throw error;
      uploaded.push(path);
    }

    // 2. Index every uploaded object with a media_assets row (one insert).
    const rows = processed.variants.map((v) => ({
      tenant_id: tenantId,
      property_id: propertyId,
      bucket_path: pathFor(v.size),
      category,
      size_variant: v.size,
      byte_size: v.byteSize,
      width: v.width,
      height: v.height,
      original_filename: processed.originalFilename,
    }));
    const { data, error } = await supabase
      .from('media_assets')
      .insert(rows)
      .select();
    if (error) throw error;
    return assets.rows(data);
  } catch (e) {
    if (uploaded.length > 0) {
      try {
        await supabase.storage.from(MEDIA_BUCKET).remove(uploaded);
      } catch {
        // Swallow: the primary failure (thrown below) is the one the user needs.
      }
    }
    throw e;
  }
}

// The id branding should store for a freshly-uploaded image. uploadProcessedImage
// returns one row per variant; branding holds ONE id, and any variant's id
// resolves to every size (variantPath), so we pick the 'full' variant as the
// canonical reference (falling back to the first if, defensively, it is absent).
export function canonicalAssetId(assets: MediaAsset[]): string | null {
  const full = assets.find((a) => a.size_variant === 'full');
  return (full ?? assets[0])?.id ?? null;
}

// ---------------------------------------------------------------------------
// Read: a property's live media
// ---------------------------------------------------------------------------
// Load every non-deleted media_assets row for one property, paged (rule 1 — never
// an unbounded read; a busy gallery can exceed the row cap). Scoped explicitly to
// the active tenant AND property (rule 19 — RLS is the floor, not the ceiling)
// and NULL-safe on the soft-delete (rule 5). Ordered so callers get a stable
// sequence. The guest site reads these under the 010 public policy; the admin
// under the member policy.
export async function fetchPropertyMedia(
  propertyId: string,
  tenantId: string,
): Promise<MediaAsset[]> {
  return fetchAllPagedRows<MediaAsset>(assets, (from, to) =>
    supabase
      .from('media_assets')
      .select('*')
      .eq('tenant_id', tenantId) // rule 19: active tenant, explicit
      .eq('property_id', propertyId) // rule 19: active property, explicit
      .is('deleted_at', null) // rule 5: NULL-safe soft-delete
      .order('created_at', { ascending: true })
      .range(from, to),
  );
}

// ---------------------------------------------------------------------------
// Orphan detection (build 4 §4)
// ---------------------------------------------------------------------------
// A media_asset is ORPHANED when no branding image key and no room_type still
// references its image. This finds them and reports them; it NEVER deletes — the
// admin confirms each removal (see the §4 comment in OrphanCleanup for why manual
// is the safe choice). One group per image (its three variant rows), so the UI
// lists an image with a combined size, not three cryptic rows.

// Every media_asset id currently referenced by the property's content. Branding
// holds image ids (single keys + list keys); room_types.images holds ids too once
// the rooms module writes them (today they may still be empty or hold legacy URLs,
// which simply match no asset and reference nothing — harmless).
export function collectReferencedIds(
  branding: PropertyBranding,
  roomTypeImages: string[][],
): Set<string> {
  const ids = new Set<string>();
  for (const key of BRANDING_IMAGE_KEYS.single) {
    const id = brandingString(branding, key);
    if (id) ids.add(id);
  }
  for (const key of BRANDING_IMAGE_KEYS.list) {
    for (const id of brandingStringArray(branding, key)) ids.add(id);
  }
  for (const images of roomTypeImages) {
    for (const id of images) {
      if (typeof id === 'string' && id.trim()) ids.add(id.trim());
    }
  }
  return ids;
}

// One orphaned image: the variant rows that make it up, its combined byte size,
// its category, and a representative bucket_path (any variant — the UI derives a
// thumb from it for the preview).
export interface OrphanGroup {
  family: string; // size-independent path key
  category: MediaCategory;
  assets: MediaAsset[];
  totalBytes: number;
  sampleBucketPath: string;
}

// Group the property's live assets into images (by path family), then keep only
// those families NO referenced id resolves into. Referencing ANY one variant's id
// spares the whole family — so a branding id that stored the 'full' variant does
// not leave that image's 'thumb'/'card' rows looking orphaned.
export function findOrphanGroups(
  assets: MediaAsset[],
  referencedIds: Set<string>,
): OrphanGroup[] {
  // family -> its variant rows
  const byFamily = new Map<string, MediaAsset[]>();
  for (const a of assets) {
    const fam = bucketPathFamily(a.bucket_path);
    const list = byFamily.get(fam);
    if (list) list.push(a);
    else byFamily.set(fam, [a]);
  }

  // Families that ARE referenced: any asset in the family whose id is referenced.
  const referencedFamilies = new Set<string>();
  for (const a of assets) {
    if (referencedIds.has(a.id)) referencedFamilies.add(bucketPathFamily(a.bucket_path));
  }

  const orphans: OrphanGroup[] = [];
  for (const [family, group] of byFamily) {
    if (referencedFamilies.has(family)) continue;
    orphans.push({
      family,
      category: group[0].category,
      assets: group,
      totalBytes: group.reduce((sum, a) => sum + a.byte_size, 0),
      sampleBucketPath: group[0].bucket_path,
    });
  }
  // Biggest first — the admin clears the costliest dead weight before the rest.
  orphans.sort((a, b) => b.totalBytes - a.totalBytes);
  return orphans;
}

// ---------------------------------------------------------------------------
// Orphan handling
// ---------------------------------------------------------------------------
// Delete a media image: remove all three variant objects AND soft-delete their
// rows, together. Pass any one variant's row; the siblings are derived from its
// bucket_path.
//
// ORDER IS DELIBERATE — files first, then rows. The dangerous state is a file
// with no row: invisible to every screen and to the quota, yet billing egress
// forever. So we remove the objects first; if the row soft-delete then fails, we
// are left with rows pointing at already-gone files — visible and repairable —
// which is the safe direction. Both steps surface their error (rule 11); nothing
// is left behind silently.
export async function deleteMediaAsset(asset: MediaAsset): Promise<void> {
  const paths = SIZE_VARIANTS.map((size) =>
    variantPath(asset.bucket_path, size),
  );

  // 1. Remove all three objects from the bucket.
  const { error: rmErr } = await supabase.storage
    .from(MEDIA_BUCKET)
    .remove(paths);
  if (rmErr) throw rmErr;

  // 2. Soft-delete all three metadata rows (rule 5/§6: deleted_at, not a hard
  //    delete). Scoped to still-live rows so a retry is idempotent. The set_row_
  //    audit trigger stamps updated_at/updated_by; deleted_at is set explicitly.
  const { error: updErr } = await supabase
    .from('media_assets')
    .update({ deleted_at: new Date().toISOString() })
    .in('bucket_path', paths)
    .is('deleted_at', null);
  if (updErr) throw updErr;
}
