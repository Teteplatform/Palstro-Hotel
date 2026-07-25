import { useActiveProperty } from '../../hooks/useActiveProperty';
import { SiteEditor } from '../../components/admin/site/SiteEditor';

// Route: /admin/:propertySlug/site (3.txt §1). Renders the real guest LandingPage
// inside the admin shell with edit mode on. AdminLayout resolves and guards the
// active property before this renders; the guard here is belt-and-braces.
//
// Keyed by property id so switching property tears the editor down and reloads
// cleanly — no draft, media map or baseline row bleeds across properties.
export function SiteEditorPage() {
  const { property } = useActiveProperty();
  if (!property) return null;

  return (
    <SiteEditor
      key={property.id}
      propertyId={property.id}
      tenantId={property.tenant_id}
      slug={property.slug}
    />
  );
}
