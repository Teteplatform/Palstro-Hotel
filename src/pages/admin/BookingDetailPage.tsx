import { useParams } from 'react-router-dom';
import { useActiveProperty } from '../../hooks/useActiveProperty';
import { useTenantContext } from '../../hooks/useTenantContext';
import { ADMIN_ROLES } from '../../types/auth';
import { BookingDetailScreen } from '../../components/admin/bookings/BookingDetailScreen';

// Route: /admin/:propertySlug/bookings/:bookingId (build A §1). The booking
// detail is a page of its own, so it can be linked to, refreshed into and shared.
//
// Keyed by booking id so navigating from one booking to another remounts cleanly
// (fresh load, fresh tab state), matching how the other admin screens key on the
// property.
export function BookingDetailPage() {
  const { bookingId } = useParams();
  const { property } = useActiveProperty();
  const { memberships } = useTenantContext();

  if (!property || !bookingId) return null;

  // Admin-ness is decided against the tenant that OWNS this property, not the
  // tenant context's "active" one — a multi-tenant user's active property may
  // belong to a different membership, and the guest-correction policy is checked
  // per tenant at the database.
  const owningMembership =
    memberships.find((m) => m.tenant_id === property.tenant_id) ?? null;
  const isAdmin =
    owningMembership !== null && ADMIN_ROLES.includes(owningMembership.role);

  return (
    <BookingDetailScreen
      key={bookingId}
      bookingId={bookingId}
      tenantId={property.tenant_id}
      propertyId={property.id}
      propertySlug={property.slug}
      currency={property.currency}
      timezone={property.timezone}
      isAdmin={isAdmin}
    />
  );
}
