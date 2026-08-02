import { useParams } from 'react-router-dom';
import { useActiveProperty } from '../../hooks/useActiveProperty';
import { BookingDetailScreen } from '../../components/admin/bookings/BookingDetailScreen';

// Route: /admin/:propertySlug/bookings/:bookingId. One stay, as a page of its
// own, so it can be linked to, refreshed into and shared.
//
// NO isAdmin HERE ANY MORE. It existed solely for the Guest Details tab, whose
// save went through the admin-only guests_member_update policy (014). That tab
// is gone — guest details are edited on the guest home and nowhere else (2.txt
// §2) — so this page has nothing left that is admin-gated, and passing a role
// flag it does not use would invite the next screen to guard on it by habit
// instead of at the database.
//
// Keyed by booking id so navigating from one booking to another remounts cleanly.
export function BookingDetailPage() {
  const { bookingId } = useParams();
  const { property } = useActiveProperty();

  if (!property || !bookingId) return null;

  return (
    <BookingDetailScreen
      key={bookingId}
      bookingId={bookingId}
      tenantId={property.tenant_id}
      propertyId={property.id}
      propertySlug={property.slug}
      currency={property.currency}
      timezone={property.timezone}
    />
  );
}
