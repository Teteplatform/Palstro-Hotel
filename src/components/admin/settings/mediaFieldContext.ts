import { supabase } from '../../../lib/supabase';
import type { MediaAssetMap } from '../../../lib/mediaUrl';
import type { PropertyBranding, PropertySettings } from '../../../types/tenant';

// Everything an image / imageList renderer needs to display, persist and clean up
// media, threaded down from the settings page (build 4). It is passed to EVERY
// FieldControl uniformly — the non-image renderers ignore it — so SettingsForm
// keeps its "no field-specific branching" rule; only the per-type image renderers
// read it.
//
// Image fields commit IMMEDIATELY on upload/remove/reorder, not through the tab's
// "Save changes" button (an uploaded file cannot sit un-persisted). Each commit
// goes through the same update_property_branding RPC the text fields use, so it
// merges (never clobbers a sibling key) and threads the optimistic-concurrency
// token. `settingsUpdatedAt` is read from the live baseline row every render, and
// onBrandingCommitted swaps the fresh row back in — so a later text Save uses the
// token this write produced, and vice versa.
export interface SettingsMediaContext {
  tenantId: string;
  propertyId: string;
  // The committed branding object (rows.settings.branding), the source of truth
  // for what each image field currently holds — NOT the form's local value map,
  // which image fields deliberately bypass since they persist on their own.
  branding: PropertyBranding;
  // rows.settings.updated_at — the concurrency token every branding write must
  // present. Fresh each render as commits update the baseline.
  settingsUpdatedAt: string;
  // id -> live media_assets row, for resolving a stored id to a URL.
  assets: MediaAssetMap;
  // Swap the fresh property_settings row into the page baseline after a commit,
  // so updated_at and branding stay current without a refetch.
  onBrandingCommitted: (row: PropertySettings) => void;
  // Re-pull the property's media after an upload/delete so newly-inserted rows
  // resolve and removed ones drop out of the map.
  reloadAssets: () => Promise<void>;
}

// Merge a branding patch (one image key -> id / id[] / null) through the shared
// RPC under the optimistic-concurrency guard, then hand the fresh row back to the
// page. Throws on error (rule 11 — the caller awaits in try/catch and surfaces
// it); the DB is the single source of truth for the new updated_at.
export async function commitBrandingPatch(
  ctx: SettingsMediaContext,
  patch: Record<string, unknown>,
): Promise<void> {
  const { data, error } = await supabase.rpc('update_property_branding', {
    p_property_id: ctx.propertyId,
    p_patch: patch,
    p_expected_updated_at: ctx.settingsUpdatedAt,
  });
  if (error) throw error;
  ctx.onBrandingCommitted(data as PropertySettings);
}

// Human-friendly message for the custom SQLSTATEs migration 008 raises (mirrors
// SettingsForm), so an image commit that races another admin reads the same way a
// text save does.
export function mediaErrorMessage(e: unknown): string {
  const err = e as { code?: string; message?: string };
  if (err?.code === 'PT409') {
    return 'Someone else changed these settings while you were editing. Reload the page, then try again.';
  }
  if (err?.code === 'PT403') {
    return 'You do not have permission to change these settings.';
  }
  return err?.message || 'Something went wrong. Please try again.';
}
