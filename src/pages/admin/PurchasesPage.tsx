import { useActiveProperty } from '../../hooks/useActiveProperty';
import { PurchasesScreen } from '../../components/admin/purchasing/PurchasesScreen';

// Route: /admin/:propertySlug/purchases — every purchase order this hotel has
// raised, and the way to raise another.
//
// PROPERTY-SCOPED, even though the SUPPLIER list is tenant-wide. A supplier is
// one company however many hotels buy from it; an ORDER is a commitment this
// hotel made, to be delivered to this hotel's store. Both scopes come off the
// active property, so the page is keyed by property id: switching hotel remounts
// cleanly rather than showing the previous one's orders while the new one loads.
export function PurchasesPage() {
  const { property } = useActiveProperty();
  if (!property) return null;

  return (
    <PurchasesScreen
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
