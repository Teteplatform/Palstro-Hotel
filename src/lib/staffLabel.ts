import { MISSING_VALUE } from './format';

// Turning a staff user id into something a person can read.
//
// THE GAP, STATED HONESTLY: the schema has no staff directory. tenant_users
// carries user_id and role and nothing else; auth.users is not readable by any
// client (correctly); and there is no profiles/staff table yet. So there is at
// present NO way for the app to render "approved by Ada Okonkwo" — the name does
// not exist anywhere the client can reach.
//
// That matters for exactly the two places this build needs it: the manager who
// approved a discount (folio_charges.discount_approved_by) and the person who
// received a payment (folio_payments.received_by) — which are the accountability
// records those columns exist to create.
//
// Until a staff directory lands (it belongs with the staff-permissions build,
// which 021 §7 already names as the home of PIN throttling), every such id is
// rendered through THIS ONE FUNCTION:
//   - the signed-in user reads as "you",
//   - anyone else reads as a short, stable id fragment that IS resolvable in the
//     database ("Staff 3f2a1c9e"), because a truncated uuid the owner can look up
//     is more honest than inventing a name or printing nothing.
// When the directory exists, this function is the only place that changes.
export function staffLabel(
  userId: string | null | undefined,
  currentUserId: string | null | undefined,
): string {
  if (!userId) return MISSING_VALUE;
  if (currentUserId && userId === currentUserId) return 'you';
  return `staff ${userId.slice(0, 8)}`;
}
