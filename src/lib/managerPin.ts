import type { TenantMembership } from '../types/auth';
import { isTenantAdminMember } from './tenantRole';

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
// THE TEST ITSELF MOVED TO tenantRole.ts IN 044, and this stayed as the name the
// PIN surfaces call. The predicate is not about PINs — 044's Accounts tab needs
// the same one — and a second surface calling `canHoldManagerPin` to decide
// whether to show a chart of accounts would read as a bug. Keeping this wrapper
// means neither caller has to know about the other's naming.
//
// The tenant that matters is the one that OWNS THE ACTIVE PROPERTY, not "the
// user's first tenant". A PIN is keyed on (tenant_id, user_id), so a manager who
// works for two hotel groups holds a separate PIN for each — addressing the wrong
// one would set a PIN nobody can use.
export function canHoldManagerPin(
  memberships: TenantMembership[],
  tenantId: string | null,
): boolean {
  return isTenantAdminMember(memberships, tenantId);
}
