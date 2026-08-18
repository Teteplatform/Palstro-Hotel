import { supabase } from './supabase';
import { boundary } from './rowParse';
import type {
  Property,
  PropertySettings,
  Tenant,
  PropertyContext,
} from '../types/tenant';

// Shape returned by the embedded select below.
type PropertyRow = Property & {
  settings: PropertySettings | null;
  tenant: Tenant | null;
};

// The boundary (rule 24). The coordinates are numeric(10,7) and arrive as
// strings; the two embeds carry no numeric of their own.
const propertyRows = boundary<PropertyRow>('properties (guest site)')(
  [] as const,
  ['latitude', 'longitude'] as const,
);

/**
 * Resolve the property this app instance is rendering.
 *
 * Resolution order:
 *   1. In dev, if VITE_DEV_PROPERTY_SLUG is set, look up by slug.
 *   2. Otherwise look up by window.location.hostname against properties.domain.
 *   3. Return null if nothing matches.
 *
 * Runs as an anonymous user and relies on the public-read RLS policies in
 * migration 001, which already require the property to be active and its tenant
 * to be in good standing. We therefore do NOT duplicate those filters here and
 * treat an empty result as "no such property".
 */
export async function resolveProperty(): Promise<PropertyContext | null> {
  try {
    const devSlug = import.meta.env.DEV
      ? (import.meta.env.VITE_DEV_PROPERTY_SLUG as string | undefined)
      : undefined;

    let query = supabase
      .from('properties')
      .select(
        `*,
         settings:property_settings(*),
         tenant:tenants(*)`,
      );

    if (devSlug) {
      query = query.eq('slug', devSlug);
    } else {
      query = query.eq('domain', window.location.hostname);
    }

    // Single-row lookup. limit(1) keeps maybeSingle() from erroring if a dev
    // slug (unique only per tenant) ever matches more than one visible row.
    const { data, error } = await query.limit(1).maybeSingle();
    if (error) throw error;
    const row = propertyRows.maybeRow(data);
    if (!row) return null;

    const { settings, tenant, ...property } = row;
    // A visible property implies both are readable under the same policies; if
    // either is missing, treat it as no match rather than a partial context.
    if (!settings || !tenant) return null;

    return { property, settings, tenant };
  } catch (e) {
    console.error('resolveProperty failed', e);
    throw e;
  }
}
