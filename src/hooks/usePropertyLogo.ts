import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { fetchPropertyMedia } from '../lib/mediaAssets';
import { buildMediaMap, mediaUrl } from '../lib/mediaUrl';
import { brandingString } from '../lib/branding';
import type { PropertySettings } from '../types/tenant';

// Resolves the active property's logo to a THUMB URL for the admin sidebar
// (3.txt §3). Branding stores a media_asset id (009), so this loads that id from
// property_settings.branding.logo_url and the property's media rows, then
// resolves the id to the thumb variant. Thumb is deliberate: a sidebar logo
// renders small and loads on every admin page, so pulling a card or full variant
// would be pure wasted egress.
//
// Returns null — never a broken image — while loading, when no logo is set, or
// when the stored id is dangling (asset deleted since it was referenced). The
// caller falls back to the property name text, matching the guest header.
//
// Rule 19: both reads are scoped to the active tenant/property explicitly
// (property_settings is keyed by property_id, already tenant-bound; the media
// fetch filters both). State updates live inside the async body with a cancelled
// guard, matching the codebase's other data hooks.
export function usePropertyLogo(
  propertyId: string | null,
  tenantId: string | null,
): string | null {
  const [logoUrl, setLogoUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      // Reset when the property changes so a stale logo never lingers across a
      // property switch (and while the active property is still resolving, when
      // the ids are null).
      setLogoUrl(null);
      if (!propertyId || !tenantId) return;
      try {
        const [settingsRes, mediaRows] = await Promise.all([
          supabase
            .from('property_settings')
            .select('branding')
            .eq('property_id', propertyId)
            .maybeSingle<Pick<PropertySettings, 'branding'>>(),
          fetchPropertyMedia(propertyId, tenantId),
        ]);
        if (cancelled) return;
        if (settingsRes.error) throw settingsRes.error;

        const id = settingsRes.data
          ? brandingString(settingsRes.data.branding, 'logo_url')
          : null;
        setLogoUrl(mediaUrl(buildMediaMap(mediaRows), id, 'thumb'));
      } catch {
        // A failed lookup must never yield a broken image — fall back to the
        // name text by leaving the URL null. The sidebar is chrome, not the
        // page's primary data, so this failure is silent by design.
        if (!cancelled) setLogoUrl(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [propertyId, tenantId]);

  return logoUrl;
}
