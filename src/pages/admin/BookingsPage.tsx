import { useActiveProperty } from '../../hooks/useActiveProperty';
import { BookingsScreen } from '../../components/admin/bookings/BookingsScreen';

// Route: /admin/:propertySlug/bookings (build 6b §3). The staff-facing booking
// screen — replaces the "coming soon" placeholder. Under the 'bookings' module.
// Keyed by property id so switching property reloads cleanly, matching the other
// admin screens.
export function BookingsPage() {
  const { property } = useActiveProperty();
  if (!property) return null;

  return (
    <BookingsScreen
      key={property.id}
      propertyId={property.id}
      tenantId={property.tenant_id}
      timezone={property.timezone}
      currency={property.currency}
    />
  );
}
