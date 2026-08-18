import { supabase } from './supabase';
import { fetchAllPagedRows } from './fetchAllPaged';
import { boundary, passthrough } from './rowParse';
import type { Property } from '../types/tenant';

// The properties a given user may OPERATE in the admin — the same set
// get_property_ids() returns, resolved from the client via the user_properties
// grant table (3.txt §1).
//
// Why filter by the user here: user_properties' RLS
// (user_properties_member_select) admits every grant in the user's tenants,
// including OTHER users' grants. So we scope the read to THIS user's own
// memberships via the tenant_users embed (tu.user_id = current user), which
// mirrors get_property_ids() exactly. Without that filter the switcher would
// list properties the current user has no personal grant to.
//
// Rule 1: paginated through fetchAllPaged — a hotel group could grant many
// properties. Rule 5: the parent property's soft-delete is filtered NULL-safe
// (deleted_at is null) because a soft-deleted property must not appear.

// Shape of one user_properties row with the property embedded. `!inner` makes
// the join a filter target so we can constrain the embedded property's columns.
interface GrantRow {
  property: Property | null;
}

// The boundary (rule 24). The numeric here is one level down, in the embedded
// property, so the embed is parsed as the rows are unwrapped below.
const grants = passthrough<GrantRow>('user_properties');

const properties = boundary<Property>('properties (accessible)')(
  [] as const,
  ['latitude', 'longitude'] as const,
);

export async function fetchAccessibleProperties(
  userId: string,
): Promise<Property[]> {
  const rows = await fetchAllPagedRows<GrantRow>(grants, (from, to) =>
    supabase
      .from('user_properties')
      .select(
        `property:properties!inner(*),
         membership:tenant_users!inner(user_id)`,
      )
      // Only this user's own grants (mirrors get_property_ids()).
      .eq('membership.user_id', userId)
      // Rule 5: exclude soft-deleted properties, NULL-safe by construction
      // (`is null` keeps only genuinely-live rows).
      .is('property.deleted_at', null)
      // Stable ordering for pagination: user_properties.created_at is a real,
      // non-null column on the base row (ordering an embedded column would not
      // page deterministically).
      .order('created_at', { ascending: true })
      .range(from, to)
      .returns<GrantRow[]>(),
  );

  // Unwrap the embed and drop any row whose join came back empty. A user cannot
  // hold two grants to the same property (unique per membership, and a property
  // belongs to exactly one tenant), so no dedup is needed.
  return rows
    .map((r) => r.property)
    .filter((p): p is Property => p !== null)
    // The embed carries the coordinates, and the top-level parse cannot see
    // into it — so it is parsed here, as the rows are unwrapped (rule 24).
    .map((p) => properties.row(p));
}
