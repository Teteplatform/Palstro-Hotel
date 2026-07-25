-- ============================================================================
-- 010_media_assets_public_read.sql
-- Palstro-Hotels: guest-facing public read on media_assets.
--
-- ----------------------------------------------------------------------------
-- WHY THIS EXISTS — a deliberate reversal of a 005 decision, stated plainly
-- ----------------------------------------------------------------------------
-- 005 gave media_assets a MEMBER-ONLY select policy and NO public policy, on the
-- reasoning that the FILES are public (the bucket is) but their METADATA is not —
-- a guest had no need to read the media inventory, so it stayed private.
--
-- Build 4 changes that premise. Branding now stores media_asset IDS, not URLs
-- (009). To render a property's logo, hero, gallery and about images, the
-- anonymous guest site must resolve those ids -> bucket_paths, which is a read of
-- media_assets. With only the member policy, an anon SELECT returns zero rows and
-- every guest image silently falls back to the placeholder — the site can never
-- show a real photo. media_assets has become guest-facing storefront data, which
-- is exactly the case CLAUDE.md rule 13 calls out ("explicit public-read policies
-- for guest-facing storefront data").
--
-- So we add a public read scoped IDENTICALLY to the 001 storefront policies
-- (tenants / properties / property_settings): visible only when the parent
-- property is active and not deleted AND its tenant is in good standing
-- (trial/active), and only for LIVE rows (deleted_at is null, rule 5). Suspending
-- a tenant takes its media offline with the rest of its site.
--
-- WHAT THIS EXPOSES, and why it is acceptable:
--   * bucket_path, size_variant, width, height — the bytes they point at are
--     ALREADY public (the bucket is public by design, 005), so publishing the
--     path is no new disclosure; it is what the guest needs to build the URL.
--   * original_filename — the only marginally-private column. It is the
--     customer's own marketing-photo filename ("beach-sunset.jpg"), not guest
--     data, and the row is only visible while the property is being publicly
--     served anyway. If column-level hiding is ever wanted, the tool is a view
--     over the public columns, not withholding the policy — withholding it breaks
--     rendering. We accept the whole-row read here.
--
-- WHAT DOES NOT CHANGE: writes stay admin-only (005's insert/update/delete
-- policies are untouched), so this is read-only exposure of already-public
-- imagery. No table holding guest data, bookings, folios, financials, staff or
-- inventory receives a public policy — media_assets qualifies solely because it
-- is the index over the public storefront photos.
--
-- Idempotent (drop-if-exists then create), matching every other policy migration.
-- ============================================================================

drop policy if exists media_assets_public_select on media_assets;
create policy media_assets_public_select on media_assets
  for select
  to anon, authenticated
  using (
    deleted_at is null
    and exists (
      select 1
      from properties p
      join tenants t on t.id = p.tenant_id
      where p.id = media_assets.property_id
        and p.status = 'active'
        and p.deleted_at is null
        and t.status in ('trial', 'active')
        and t.deleted_at is null
    )
  );

comment on policy media_assets_public_select on media_assets is
  'Guest storefront read: LIVE media rows are visible to anyone when the parent '
  'property is active and its tenant in good standing, so branding media ids can '
  'be resolved to URLs on the public site (rule 13). Reverses 005''s member-only '
  'stance now that branding references media_assets by id. Writes remain admin-only.';

-- ============================================================================
-- End of 010_media_assets_public_read.sql
-- ============================================================================
