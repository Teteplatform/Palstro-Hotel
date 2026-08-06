import { useActiveProperty } from '../../hooks/useActiveProperty';
import { StockImportScreen } from '../../components/admin/inventory/StockImportScreen';

// Route: /admin/:propertySlug/stock/import (F&B/Inventory part 2a). The
// day-one bulk load of existing stock from a spreadsheet.
//
// Its own route rather than a modal on the stock screen: it is a multi-step job
// with a preview a person reads carefully, it survives a refresh, and it can be
// linked to — none of which a dialog gives. Same 'store' module guard as the
// stock screen itself.
export function StockImportPage() {
  const { property } = useActiveProperty();
  if (!property) return null;

  return (
    <StockImportScreen
      key={property.id}
      tenantId={property.tenant_id}
      propertyId={property.id}
      propertySlug={property.slug}
      currency={property.currency}
      timezone={property.timezone}
    />
  );
}
