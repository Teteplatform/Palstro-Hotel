import { useActiveProperty } from '../../hooks/useActiveProperty';
import { ProductImportScreen } from '../../components/admin/inventory/ProductImportScreen';

// Route: /admin/:propertySlug/products/import — bringing a whole CATALOGUE in
// from a spreadsheet.
//
// Its own route rather than a modal, for the same reasons as the opening-stock
// import: it is a multi-step job with a preview a person reads carefully, it
// survives a refresh, and it can be linked to. Same 'store' module guard.
//
// SIBLING, NOT SUBSTITUTE. /stock/import loads QUANTITIES for items that
// already exist; this creates the items. Two routes because they are two jobs,
// done in that order.
//
// The screen is keyed on the TENANT, not the property: the catalogue is
// tenant-wide (035) — one definition of "Rice" for every hotel in the group —
// so switching property must not reset a half-reviewed import.
export function ProductImportPage() {
  const { property } = useActiveProperty();
  if (!property) return null;

  return (
    <ProductImportScreen
      key={property.tenant_id}
      tenantId={property.tenant_id}
      propertySlug={property.slug}
      currency={property.currency}
      timezone={property.timezone}
    />
  );
}
