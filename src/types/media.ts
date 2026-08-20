// DB row type for media_assets (supabase/migrations/005_storage.sql). Keep in
// sync with the migration — no fields the schema does not have.

// The fixed media categories (media_assets_category_check in 005, extended by
// 042). One place, so no component writes a category as a literal (rule 17-ish).
//
// FIVE ARE PROPERTY-LEVEL AND ONE IS NOT, and the database enforces the pairing
// rather than trusting it (media_assets_scope_check): 'items' rows are
// TENANT-level and carry a NULL property_id; every other category is
// property-level and must carry one. So the category decides the scope — which is
// why MediaScope below is derived from it and never passed separately.
export type MediaCategory =
  | 'hero'
  | 'gallery'
  | 'rooms'
  | 'logo'
  | 'about'
  | 'items';

// The one tenant-level category (042): the item picture. The catalogue is
// tenant-wide (035), so a picture of Rice is a picture of the same Rice at every
// property, and filing it under one would mean the second property either sees
// nothing or uploads its own copy of the identical bottle.
export const TENANT_LEVEL_CATEGORIES: readonly MediaCategory[] = ['items'];

// Whether a category's media belongs to a property or to the tenant. Derived, so
// no caller can pass a scope that disagrees with the category it is uploading —
// the database would refuse it, and this makes it a compile-time non-question.
export function isTenantLevelCategory(category: MediaCategory): boolean {
  return TENANT_LEVEL_CATEGORIES.includes(category);
}

// The three resized variants the client produces (media_assets_size_variant_check
// in 005). This is the domain vocabulary; imageProcessing.ts owns the pixel WIDTH
// each name maps to. Defined here so the row type and the processor agree.
export type SizeVariant = 'thumb' | 'card' | 'full';

export interface MediaAsset {
  id: string;
  tenant_id: string;
  // NULL for TENANT-LEVEL media — an item picture (042). Every other category is
  // property-level and carries one; media_assets_scope_check binds the two, so
  // this being null is exactly equivalent to category === 'items'.
  //
  // The null also does the work of keeping item pictures OUT of the property
  // gallery, out of fetchPropertyMedia and out of OrphanCleanup, all of which
  // filter on property_id — none of them needed changing.
  property_id: string | null;
  // Full object path in the property-media bucket. Five segments either way, so
  // variantPath()/bucketPathFamily() work on both:
  //   property-level  {tenant_id}/{property_id}/{category}/{size}/{filename}
  //   tenant-level    {tenant_id}/tenant/{category}/{size}/{filename}
  // The tenant id is FIRST in both, which is what the storage RLS policies parse
  // to decide who may write (005). Unique.
  bucket_path: string;
  category: MediaCategory;
  size_variant: SizeVariant;
  // byte_size is bigint, which PostgREST sends as a JS number today — and this
  // comment used to end "so it needs no parse", which is precisely the reasoning
  // rule 24 retired. It is parsed at the boundary like every other numeric, and
  // the assumption is now enforced instead of documented. A byte count is well
  // within Number's safe-integer range (a 500MB quota is ~5.2e8).
  byte_size: number;
  width: number | null;
  height: number | null;
  original_filename: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
}
