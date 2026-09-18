import { useActiveProperty } from '../../hooks/useActiveProperty';
import { SuppliersScreen } from '../../components/admin/purchasing/SuppliersScreen';

// Route: /admin/:propertySlug/suppliers — the address book, beside Purchases.
//
// THE LIST IS TENANT-WIDE AND THE ACTIVITY IS PROPERTY-SCOPED, which is why both
// ids are handed down. A supplier is one company however many hotels in the
// group buy from it — one TIN, one bank account, one payment history — while
// what was ORDERED from them belongs to a particular hotel.
export function SuppliersPage() {
  const { property } = useActiveProperty();
  if (!property) return null;

  return (
    <SuppliersScreen
      key={property.id}
      tenantId={property.tenant_id}
      propertyId={property.id}
      propertySlug={property.slug}
      currency={property.currency}
      timezone={property.timezone}
    />
  );
}
