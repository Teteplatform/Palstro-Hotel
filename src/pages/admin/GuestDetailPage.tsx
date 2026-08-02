import { useParams } from 'react-router-dom';
import { useActiveProperty } from '../../hooks/useActiveProperty';
import { useTenantContext } from '../../hooks/useTenantContext';
import { ADMIN_ROLES } from '../../types/auth';
import { GuestDetailScreen } from '../../components/admin/guests/GuestDetailScreen';

// Route: /admin/:propertySlug/guests/:guestId (2.txt §2). The guest's own page —
// their history across every stay, and the running ledger over those stays.
//
// Keyed by guest id so navigating from one guest to another remounts cleanly
// (fresh load, fresh tab state), matching BookingDetailPage.
export function GuestDetailPage() {
  const { guestId } = useParams();
  const { property } = useActiveProperty();
  const { memberships } = useTenantContext();

  if (!property || !guestId) return null;

  // Admin-ness is decided against the tenant that OWNS this property, not the
  // tenant context's "active" one — a multi-tenant user's active property may
  // belong to a different membership, and the guest-correction policy is checked
  // per tenant at the database.
  const owningMembership =
    memberships.find((m) => m.tenant_id === property.tenant_id) ?? null;
  const isAdmin =
    owningMembership !== null && ADMIN_ROLES.includes(owningMembership.role);

  return (
    <GuestDetailScreen
      key={guestId}
      guestId={guestId}
      tenantId={property.tenant_id}
      propertyId={property.id}
      propertySlug={property.slug}
      propertyName={property.name}
      currency={property.currency}
      isAdmin={isAdmin}
    />
  );
}
