import { useActiveProperty } from '../../hooks/useActiveProperty';
import { InventoryItemsScreen } from '../../components/admin/inventory/InventoryItemsScreen';

// Route: /admin/:propertySlug/inventory-items (F&B/Inventory part 1). The
// TENANT's shared item catalogue.
//
// The property is still in the URL and the screen still hangs off the active
// property — but only to resolve WHICH TENANT is active. The catalogue itself is
// tenant-wide: an item defined here is the same item in every property of the
// group, which is what makes one movement ledger (and therefore one food-cost
// figure) possible. Keyed by tenant id so switching to a property under a
// different tenant remounts cleanly rather than showing the previous catalogue.
export function InventoryItemsPage() {
  const { property } = useActiveProperty();
  if (!property) return null;

  return (
    <InventoryItemsScreen
      key={property.tenant_id}
      tenantId={property.tenant_id}
    />
  );
}
