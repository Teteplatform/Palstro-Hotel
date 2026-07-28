import { useActiveProperty } from '../../hooks/useActiveProperty';
import { CompaniesScreen } from '../../components/admin/companies/CompaniesScreen';

// Route: /admin/:propertySlug/companies (build 6b §2). Corporate accounts and
// their negotiated rates. Under the 'settings' module (configuration, admin-
// gated) — see adminNav. Keyed by property id so switching property reloads
// cleanly, matching the other admin screens.
export function CompaniesPage() {
  const { property } = useActiveProperty();
  if (!property) return null;

  return (
    <CompaniesScreen
      key={property.id}
      propertyId={property.id}
      tenantId={property.tenant_id}
      currency={property.currency}
    />
  );
}
