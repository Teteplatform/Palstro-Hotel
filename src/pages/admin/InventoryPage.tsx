import { useActiveProperty } from '../../hooks/useActiveProperty';
import { InventoryScreen } from '../../components/admin/inventory/InventoryScreen';

// Route: /admin/:propertySlug/inventory — the whole inventory module on one
// page. It replaces the three routes this build consolidated: the item
// catalogue, the stock locations and the per-location stock screen.
//
// PROPERTY-SCOPED, even though the CATALOGUE is tenant-wide. An item defined
// here is the same item in every property of the group (which is what makes one
// movement ledger, and therefore one food-cost figure, possible), but its STOCK
// is physical and belongs to this hotel's locations. Both scopes come off the
// active property, so the page is keyed by property id: switching hotel remounts
// cleanly rather than showing the previous one's stock while the new one loads.
export function InventoryPage() {
  const { property } = useActiveProperty();
  if (!property) return null;

  return (
    <InventoryScreen
      key={property.id}
      tenantId={property.tenant_id}
      propertyId={property.id}
      propertySlug={property.slug}
      // Both from the property row, never a literal (rule 17): the currency
      // every figure is formatted in, and the timezone the business date is
      // resolved in (rules 8/12).
      currency={property.currency}
      timezone={property.timezone}
    />
  );
}
