import { useActiveProperty } from '../../hooks/useActiveProperty';
import { LocationsScreen } from '../../components/admin/inventory/LocationsScreen';

// Route: /admin/:propertySlug/locations (F&B/Inventory part 1). The stock
// locations of ONE property — unlike the item catalogue, these are per hotel,
// because stock is physical. Keyed by property id so switching property reloads
// cleanly, matching the other property-scoped admin screens.
export function LocationsPage() {
  const { property } = useActiveProperty();
  if (!property) return null;

  return (
    <LocationsScreen
      key={property.id}
      propertyId={property.id}
      tenantId={property.tenant_id}
    />
  );
}
