import { supabase } from './supabase';
import {
  canonicalAssetId,
  deleteMediaAsset,
  fetchMediaAssetsByIds,
} from './mediaAssets';
import type { MediaAsset, MediaCategory } from '../types/media';
import type { MediaAssetMap } from './mediaUrl';

// THE ITEM PICTURE (1.1e §3) — one image per catalogue item, TENANT-level,
// through the media path that already exists.
//
// ---------------------------------------------------------------------------
// WHAT THIS FILE IS FOR, AND WHY IT IS NOT INSIDE THE COMPONENT
// ---------------------------------------------------------------------------
// "Deleting or replacing an image releases its quota" sounds like one line of UI
// work and is actually an ORDERING RULE with a wrong answer that looks right. Two
// facts constrain it:
//
//   * A FILE WITH NO ROW IS INVISIBLE (CLAUDE.md §6). No screen lists it, the
//     quota never counts it, and it bills egress forever. The row is the only
//     handle on the bytes.
//   * A ROW REFERENCED BY NOTHING IS MERELY WASTE. It shows up, it counts against
//     the quota, and somebody can remove it.
//
// So the safe direction is always: make the item point at the NEW picture (or at
// nothing) FIRST, and only then remove the old bytes. Backwards, a failed second
// step leaves an item pointing at deleted files — a broken image on a screen with
// no way back. In this order, the same failure leaves an unreferenced picture,
// which is visible and repairable.
//
// That is the settings ImageField's reasoning (build 4) and it is written down HERE
// rather than repeated there, so the next surface that gives something a picture
// calls this instead of re-deriving the order from scratch.
//
// ---------------------------------------------------------------------------
// WHY ITEM PICTURES HAVE NO ORPHAN SWEEPER, AND WHY THAT IS ACCEPTABLE
// ---------------------------------------------------------------------------
// OrphanCleanup finds unreferenced PROPERTY media by loading a property's assets
// (fetchPropertyMedia, which filters `.eq('property_id', …)`) and comparing them
// with the ids branding and room types reference. An item picture has a NULL
// property_id, so it is invisible to that sweep — deliberate, because it must not
// appear in a property's gallery, but it does mean nothing comes along later to
// tidy up after this module.
//
// The answer is that every path here releases the bytes in the SAME ACT that stops
// referencing them, so there is nothing for a sweeper to find. Two things follow
// from that and are enforced elsewhere:
//   * the upload always has an item to attach to at the moment it happens
//     (ItemImageField does not offer one on a form for an item that does not exist
//     yet — see its header), so no picture is ever created unreferenced;
//   * the only residue possible is a crash BETWEEN commit and release, which
//     leaves a countable row the quota readout shows.
// A sweeper over tenant-level media is a small honest addition the day a second
// tenant-level category exists; with one category and one referencing column it
// would be a second source of truth about what "referenced" means.

// The category every item picture is filed under (media_assets_category_check,
// extended by 042). A constant, so no caller writes it as a literal — and it is
// what makes the upload tenant-level, because scopeSegment() derives the scope
// from the category: passing 'items' IS saying "this belongs to the tenant".
export const ITEM_IMAGE_CATEGORY: MediaCategory = 'items';

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

// Resolve a page of items' image ids to their media rows, keyed by id, so a list
// can render a thumbnail per row. Pass the ids of ONE page (rule 1a: the `.in()`
// inside is bounded by the page, and paged regardless).
//
// An item with no picture contributes no id, and an id whose asset has since been
// soft-deleted resolves to nothing — both render as no picture rather than as a
// broken image.
export async function fetchItemImages(
  tenantId: string,
  imageAssetIds: (string | null)[],
): Promise<MediaAssetMap> {
  return fetchMediaAssetsByIds(
    tenantId,
    imageAssetIds.filter((id): id is string => Boolean(id)),
  );
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

// Point an item at a media asset, or at nothing. A plain admin-gated update, the
// same shape as every other write in lib/inventory.ts — scoped to the active
// tenant (rule 19) and to a live row (rule 5), awaited, and throwing so the caller
// surfaces the reason (rule 11).
//
// SEPARATE FROM updateInventoryItem ON PURPOSE. The item form's save writes the
// whole field set from a form somebody may still be editing; a picture is committed
// the moment it finishes uploading, which is a different act at a different time.
// Folding it into the form's patch would mean a half-typed name was either written
// with the picture or silently lost when the picture was.
export async function setItemImageId(
  itemId: string,
  tenantId: string,
  imageAssetId: string | null,
): Promise<void> {
  const { error } = await supabase
    .from('inventory_items')
    .update({ image_asset_id: imageAssetId })
    .eq('id', itemId)
    .eq('tenant_id', tenantId) // rule 19
    .is('deleted_at', null); // rule 5: only patch a live row
  if (error) throw error;
}

export interface CommitItemImageArgs {
  tenantId: string;
  itemId: string;
  // The variant rows ImageUpload has just written — one per size. The canonical
  // ('full') one becomes the item's reference; any variant's id resolves to every
  // size, so which one is stored only matters for consistency.
  uploaded: MediaAsset[];
  // The asset the item points at NOW, if any — the one whose bytes are released
  // once the new id is committed. The ROW rather than the id, because
  // deleteMediaAsset derives its three sibling paths from the bucket_path; handing
  // it an id would mean re-reading a row the caller already holds.
  currentAsset: MediaAsset | null;
}

// Attach a freshly-uploaded picture to an item and release the one it replaces.
//
// THE ORDER, which is the entire content of this function:
//   1. point the item at the new asset   (the item now has a live picture)
//   2. release the old bytes and rows    (nothing references them any more)
//
// A failure at 1 leaves an unreferenced NEW picture — waste, visible in the quota
// readout. A failure at 2 leaves an unreferenced OLD picture — the same waste. At
// no point does the item reference bytes that are gone, which is the one outcome
// that would show a user a broken image.
//
// The upload itself happened before this call, inside ImageUpload, where the quota
// is checked and the database's BEFORE INSERT trigger (005 §6) refuses an
// over-quota write with its own sentence. So an over-quota picture never reaches
// here and the item keeps the picture it had.
//
// Returns the row the item now references, so the caller can render it immediately
// rather than waiting for a refetch.
export async function commitItemImage(
  args: CommitItemImageArgs,
): Promise<MediaAsset> {
  const { tenantId, itemId, uploaded, currentAsset } = args;

  const newId = canonicalAssetId(uploaded);
  if (!newId) {
    // uploadProcessedImage returns one row per variant, so an empty list means the
    // insert returned nothing. Surfaced rather than silently leaving the item
    // unchanged with three new files sitting in the bucket.
    throw new Error('The picture uploaded but was not recorded. Please try again.');
  }

  await setItemImageId(itemId, tenantId, newId);

  // Only now, and only when it is genuinely a different image.
  if (currentAsset && currentAsset.id !== newId) {
    await deleteMediaAsset(currentAsset);
  }

  return uploaded.find((a) => a.id === newId) ?? uploaded[0];
}

// Take an item's picture away and release its bytes.
//
// Clear the reference FIRST, then delete: if the delete fails after the clear, the
// files become an unreferenced picture (waste, countable), never a reference to
// deleted bytes (a broken image on the products list).
export async function removeItemImage(
  tenantId: string,
  itemId: string,
  currentAsset: MediaAsset | null,
): Promise<void> {
  await setItemImageId(itemId, tenantId, null);
  if (currentAsset) await deleteMediaAsset(currentAsset);
}
