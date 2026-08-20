import { supabase } from './supabase';
import type { MediaAsset, MediaCategory, SizeVariant } from '../types/media';
import { isTenantLevelCategory } from '../types/media';
import placeholderImage from '../assets/hero.png';

// The single public bucket (005). Named once here so no caller writes it as a
// literal.
export const MEDIA_BUCKET = 'property-media';

// The segment that stands in for a property id on TENANT-LEVEL media (042).
//
// WHY A LITERAL IN THE PROPERTY SLOT rather than a four-segment path. Two things
// depend on the shape and neither is negotiable:
//   * the storage RLS policies (005) parse the FIRST segment as a tenant id and
//     pass it to is_tenant_admin(), so the tenant id must stay first;
//   * variantPath() and bucketPathFamily() find a sibling variant by rewriting the
//     SECOND-TO-LAST segment, and both give up below five segments — a shorter
//     path would silently return the same variant for every size, so a list
//     thumbnail would quietly serve the 1920px file.
// Keeping five segments with 'tenant' in the property slot satisfies both without
// a special case anywhere else in this file.
//
// It is not a valid uuid, so it can never collide with a real property id.
export const TENANT_SCOPE_SEGMENT = 'tenant';

// The scope segment for a category: the property id, or the tenant literal for
// the one tenant-level category. DERIVED from the category, never passed
// alongside it — the database refuses a mismatch (media_assets_scope_check), and
// deriving it means no caller can construct one.
export function scopeSegment(
  category: MediaCategory,
  propertyId: string | null,
): string {
  if (isTenantLevelCategory(category)) return TENANT_SCOPE_SEGMENT;
  if (!propertyId) {
    throw new Error(
      `${category} media is property-level and needs a property id.`,
    );
  }
  return propertyId;
}

// Public URL for an exact object path. The bucket is public, so this is a plain,
// long-lived CDN URL — no signing, no expiry, cacheable by the browser for the
// one-year cacheControl the upload sets.
export function mediaPublicUrl(bucketPath: string): string {
  return supabase.storage.from(MEDIA_BUCKET).getPublicUrl(bucketPath).data
    .publicUrl;
}

// Rewrite the {size} segment of a path to another variant.
// Paths follow {tenant_id}/{scope}/{category}/{size}/{filename} (5 segments,
// where scope is a property id or the tenant literal — see TENANT_SCOPE_SEGMENT),
// and all three variants of one image share EVERY other segment,
// including the filename — so the sibling variant's exact path is this path with
// just the size segment (second-to-last) swapped. No second DB lookup needed.
// A path that does not match the convention is returned unchanged.
export function variantPath(bucketPath: string, size: SizeVariant): string {
  const parts = bucketPath.split('/');
  if (parts.length < 5) return bucketPath;
  parts[parts.length - 2] = size;
  return parts.join('/');
}

// Public URL for a given image at the size the CONSUMER needs. Pass any variant's
// bucket_path plus the size to render: a room card asks for 'card', a hero for
// 'full', a thumbnail for 'thumb'. This is the read-time egress saving made real
// — a card must never load the full variant, and this is how it avoids doing so.
export function mediaVariantUrl(bucketPath: string, size: SizeVariant): string {
  return mediaPublicUrl(variantPath(bucketPath, size));
}

// ---------------------------------------------------------------------------
// id -> URL resolution (build 4)
// ---------------------------------------------------------------------------
// Branding stores a media_asset ID, not a URL (009). Rendering resolves that id
// to the exact variant a surface needs. Because all three variants of one image
// share every path segment but the size (variantPath), a SINGLE loaded row for
// the image is enough to derive any size — so the caller loads the property's
// live media once (buildMediaMap) and passes the map plus the stored id and the
// size it wants.

export type MediaAssetMap = Map<string, MediaAsset>;

// Index a property's loaded media_assets rows by id. Every variant row is keyed
// individually, so whichever variant's id branding happens to store resolves.
export function buildMediaMap(assets: MediaAsset[]): MediaAssetMap {
  const map: MediaAssetMap = new Map();
  for (const a of assets) map.set(a.id, a);
  return map;
}

// Resolve a stored branding id to the public URL for `size`, or null when the id
// is unset or points at an asset that is not present (e.g. it was deleted since
// it was referenced — a dangling reference the caller renders as a placeholder,
// never a broken image). The size is the SURFACE's need, not what was stored:
// one id renders as a thumb on a logo and a full on a hero.
export function mediaUrl(
  map: MediaAssetMap,
  id: string | null | undefined,
  size: SizeVariant,
): string | null {
  if (!id) return null;
  const asset = map.get(id);
  if (!asset) return null;
  return mediaVariantUrl(asset.bucket_path, size);
}

// The bundled platform default placeholder — a neutral warm image shown by the
// RENDER layer (never the data, per 009) when an image field is empty, so an
// unconfigured property still looks deliberate. A URL string, so it drops into an
// <img src> exactly where a resolved media URL would.
export const platformPlaceholder: string = placeholderImage;

// ---------------------------------------------------------------------------
// Path families — for orphan grouping (build 4 §4)
// ---------------------------------------------------------------------------
// The three variant rows of one image differ ONLY in the size path segment. This
// collapses a bucket_path to a size-independent FAMILY key, so all variants of an
// image group together: referencing any one variant's id marks the whole family
// as referenced, and orphan cleanup lists a family (3 files) as a single image.
export function bucketPathFamily(bucketPath: string): string {
  const parts = bucketPath.split('/');
  if (parts.length < 5) return bucketPath;
  parts[parts.length - 2] = '*'; // neutralise the size segment
  return parts.join('/');
}
