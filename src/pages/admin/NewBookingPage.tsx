import { useActiveProperty } from '../../hooks/useActiveProperty';
import { NewBookingScreen } from '../../components/admin/bookings/NewBookingScreen';

// Route: /admin/:propertySlug/bookings/new (build B §1). Creating a booking is a
// page of its own, not a dialog over the list — see NewBookingScreen for why.
//
// Keyed by property id like the other admin screens, so switching property
// remounts against that property's own draft, room types and availability rather
// than showing one property's work under another's name.
export function NewBookingPage() {
  const { property } = useActiveProperty();
  if (!property) return null;

  return (
    <NewBookingScreen
      key={property.id}
      propertyId={property.id}
      tenantId={property.tenant_id}
      propertySlug={property.slug}
      timezone={property.timezone}
      currency={property.currency}
    />
  );
}
