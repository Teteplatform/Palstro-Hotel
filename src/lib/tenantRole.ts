import { ADMIN_ROLES, type TenantMembership } from '../types/auth';

// IS THIS USER AN ADMIN OF THIS TENANT — the client's copy of the rule, in ONE
// place, for every surface that needs to decide whether to OFFER an admin-only
// control.
//
// EXTRACTED FROM managerPin.ts IN 044, and the extraction is the point. That file
// held the identical predicate under the name canHoldManagerPin, which was
// correct while the PIN was the only admin-gated surface. 044 adds a second one —
// the Accounts tab — and calling `canHoldManagerPin` to decide whether to show a
// chart of accounts would read as a bug to the next person, or worse, would get
// copied into a third surface as a fresh `if (role === 'owner')` that quietly
// disagrees about managers.
//
// Rule 19's shape: this HIDES a control, it does not protect anything. The
// guards are is_tenant_admin() inside set_manager_pin (021) and the RLS policies
// on accounts and account_mappings (044), and both refuse regardless of what any
// screen chose to render.
//
// The tenant that matters is always the one that OWNS THE ACTIVE PROPERTY, never
// "the user's first tenant" — a person who works for two hotel groups may be an
// owner in one and a receptionist in the other.
export function isTenantAdminMember(
  memberships: TenantMembership[],
  tenantId: string | null,
): boolean {
  if (!tenantId) return false;
  const owning = memberships.find((m) => m.tenant_id === tenantId) ?? null;
  return owning !== null && ADMIN_ROLES.includes(owning.role);
}
