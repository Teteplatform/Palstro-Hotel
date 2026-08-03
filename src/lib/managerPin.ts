import { ADMIN_ROLES, type TenantMembership } from '../types/auth';

// WHO MAY HOLD AN APPROVAL PIN — the client's copy of the rule, in ONE place.
//
// The rule itself is enforced by set_manager_pin, which refuses any caller who is
// not is_tenant_admin() for the tenant (021 §7.1). This function exists only so
// the surfaces that OFFER the setting — the user menu and the Settings screen's
// Manager PIN tab — agree with each other about whom to offer it to. Two copies
// of the test would eventually disagree, and the one that was wrong would show a
// front-desk user a control that always fails.
//
// Rule 19's shape, again: this hides a control, it does not protect anything.
//
// The tenant that matters is the one that OWNS THE ACTIVE PROPERTY, not "the
// user's first tenant". A PIN is keyed on (tenant_id, user_id), so a manager who
// works for two hotel groups holds a separate PIN for each — addressing the wrong
// one would set a PIN nobody can use.
export function canHoldManagerPin(
  memberships: TenantMembership[],
  tenantId: string | null,
): boolean {
  if (!tenantId) return false;
  const owning = memberships.find((m) => m.tenant_id === tenantId) ?? null;
  return owning !== null && ADMIN_ROLES.includes(owning.role);
}
