// DB row type for media_assets (supabase/migrations/005_storage.sql). Keep in
// sync with the migration — no fields the schema does not have.

// The fixed guest-site media categories (media_assets_category_check in 005).
// One place, so no component writes a category as a literal (rule 17-ish).
export type MediaCategory = 'hero' | 'gallery' | 'rooms' | 'logo' | 'about';

// The three resized variants the client produces (media_assets_size_variant_check
// in 005). This is the domain vocabulary; imageProcessing.ts owns the pixel WIDTH
// each name maps to. Defined here so the row type and the processor agree.
export type SizeVariant = 'thumb' | 'card' | 'full';

export interface MediaAsset {
  id: string;
  tenant_id: string;
  property_id: string;
  // Full object path in the property-media bucket:
  // {tenant_id}/{property_id}/{category}/{size}/{filename}. Unique.
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
