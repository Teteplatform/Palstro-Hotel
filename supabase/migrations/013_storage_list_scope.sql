-- ============================================================================
-- 013_storage_list_scope.sql
-- Palstro-Hotels: close the cross-tenant bucket-listing hole on property-media.
--
-- ----------------------------------------------------------------------------
-- THE FLAG, stated plainly
-- ----------------------------------------------------------------------------
-- 005 gave storage.objects a SELECT policy scoped only to the bucket:
--
--     using (bucket_id = 'property-media')                       -- to anon, authenticated
--
-- That is broader than it needs to be. The Supabase dashboard flagged that this
-- lets ANY client call the storage LIST endpoint (storage.from('property-media')
-- .list(prefix)) and walk the whole bucket — every tenant's folder, every
-- filename — across all tenants. The bytes were always public (the bucket is
-- public by design), but the ABILITY TO ENUMERATE them was not intended: it
-- discloses how many properties exist, their ids, and every original object path.
--
-- ----------------------------------------------------------------------------
-- WHAT THE SUPABASE MODEL CAN AND CANNOT DO — read this before "fixing" it
-- ----------------------------------------------------------------------------
-- Two DIFFERENT request paths hit objects in a PUBLIC bucket, and only one is
-- governed by this policy:
--
--   A. Public read-by-path (what the guest site uses).
--        GET /storage/v1/object/public/property-media/{path}
--      A public bucket serves individual objects at their EXACT path through the
--      CDN endpoint WITHOUT consulting storage.objects RLS at all. Our guest site
--      only ever builds these URLs (mediaUrl.ts -> getPublicUrl), so it does NOT
--      depend on any SELECT policy here. Nothing in the app calls the authenticated
--      object endpoint or .list() (verified: only getPublicUrl and .remove()).
--
--   B. The authenticated object + LIST endpoints (what enumeration uses).
--        GET  /storage/v1/object/property-media/{path}      (authenticated read)
--        POST /storage/v1/object/list/property-media         (directory listing)
--      BOTH filter rows through this SELECT policy. And here is the model's hard
--      limit: RLS on storage.objects cannot distinguish "read this one object by
--      exact path" from "list the objects under this prefix" — LIST is just a
--      SELECT with a prefix filter, so ANY policy that admits a row for read also
--      admits it for listing. There is no policy that grants read-by-path yet
--      denies list on the same rows.
--
-- CONSEQUENCE — the honest scope of this fix:
--   * We CANNOT make individual objects non-listable-yet-readable via RLS on a
--     public bucket. Read-by-path on a public bucket is served by path B's public
--     sibling (path A), which bypasses RLS entirely; and the authenticated read
--     and list share one policy. The only way to force read-by-path through RLS
--     would be to make the bucket PRIVATE and issue signed URLs — which would
--     break anonymous guest image loading (or add a signing round-trip and expiry
--     management to every guest image), the exact trade 005 rejected on cost
--     grounds. We are NOT doing that.
--   * We CAN, and do, remove ANONYMOUS and CROSS-TENANT enumeration: scope the
--     SELECT policy so only an authenticated member of the tenant that OWNS the
--     first path segment may read/list, and drop the anon grant entirely.
--
-- RESIDUAL EXPOSURE, not hidden:
--   Because the bucket stays PUBLIC (required for anonymous guest photos), any
--   individual object remains downloadable by anyone who ALREADY KNOWS its exact
--   path, via the public CDN endpoint (path A). That is unchanged and intended —
--   the photos are public marketing images. What an attacker can no longer do is
--   DISCOVER those paths by listing the bucket, anonymously or across tenants.
--   The content-addressed random filenames (mediaAssets.ts) mean an unknown path
--   is not guessable, so closing enumeration is the meaningful boundary.
--
-- Idempotent (drop-if-exists then create), matching every other policy migration.
-- ============================================================================

-- Remove the broad bucket-wide SELECT policy from 005: it is what admitted
-- anonymous and cross-tenant LIST calls.
drop policy if exists "property_media_public_read" on storage.objects;

-- Replace it with a member-scoped SELECT: only an authenticated user who belongs
-- to the tenant named in the FIRST path segment may read/list objects, and only
-- within that tenant's own folder. anon is intentionally NOT granted — anonymous
-- clients keep working through the public CDN endpoint (path A above), which does
-- not consult this policy, so guest image loading is untouched.
--
-- Path convention (005): {tenant_id}/{property_id}/{category}/{size}/{filename}.
-- storage.foldername(name) returns the folder segments as text[] (filename
-- excluded); [1] is the tenant_id. A non-uuid/empty first segment makes the cast
-- fail or = any(...) yield no match, so a malformed path fails closed — the same
-- fail-closed shape as the write policies. get_tenant_ids() (not is_tenant_admin)
-- because listing one's own media is a read; any active member may do it.
--
-- (This reasoning lived in a `comment on policy` statement, but the Supabase CLI
-- role does not OWN storage.objects and so cannot comment on a policy attached to
-- it — the statement failed with "must be owner of relation objects" while the
-- policy itself created fine. The commentary is kept here as plain SQL comments,
-- which need no ownership, so the file re-runs cleanly.)
--
-- WHAT THIS POLICY DOES: replaces 005's bucket-wide SELECT. Only an authenticated
-- member of the tenant in the first path segment may read/list objects in
-- property-media, closing the anonymous + cross-tenant LIST hole the dashboard
-- flagged. anon is not granted: anonymous guest reads use the PUBLIC CDN endpoint,
-- which bypasses this policy, so image loading is unaffected. RESIDUAL (documented
-- in the migration header): the bucket stays public, so an object is still
-- downloadable by anyone who already knows its exact (unguessable,
-- content-addressed) path — enumeration is closed, read-by-known-path is not,
-- which the public-bucket model cannot separate.
drop policy if exists "property_media_member_list" on storage.objects;
create policy "property_media_member_list" on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'property-media'
    and ((storage.foldername(name))[1])::uuid = any(get_tenant_ids())
  );

-- The write policies from 005 (admin insert/update/delete, parsing tenant from
-- the first path segment) are UNCHANGED and remain in force.

-- ============================================================================
-- End of 013_storage_list_scope.sql
-- ============================================================================
