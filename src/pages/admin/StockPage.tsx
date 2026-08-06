import { useActiveProperty } from '../../hooks/useActiveProperty';
import { StockScreen } from '../../components/admin/inventory/StockScreen';

// Route: /admin/:propertySlug/stock (F&B/Inventory part 2a). What each of THIS
// property's locations is holding, and what it is worth.
//
// Property-scoped, unlike the item catalogue: stock is physical, so a carton in
// this hotel's kitchen is not a carton anywhere else. Keyed by property id so
// switching property remounts cleanly rather than showing the previous hotel's
// stock while the new one loads.
export function StockPage() {
  const { property } = useActiveProperty();
  if (!property) return null;

  return (
    <StockScreen
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
