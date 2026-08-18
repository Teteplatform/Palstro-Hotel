import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { supabase } from '../lib/supabase';
import { fetchAllPagedRows } from '../lib/fetchAllPaged';
import { passthrough } from '../lib/rowParse';
import { ADMIN_ROLES, type TenantMembership } from '../types/auth';
import { useAuth } from './useAuth';

// The boundary (rule 24). A membership is ids and a role — no numeric column —
// and it declares that rather than being quietly skipped.
const membershipRows = passthrough<TenantMembership>('tenant_users');

interface TenantContextValue {
  // The active tenant: for now, the first membership. A tenant switcher will
  // let a multi-tenant user change this later (see note below).
  tenantId: string | null;
  tenantName: string | null;
  role: TenantMembership['role'] | null;
  isAdmin: boolean;
  // Every tenant the user belongs to, so a future switcher has the full list
  // without re-querying.
  memberships: TenantMembership[];
  loading: boolean;
  error: Error | null;
}

const TenantContext = createContext<TenantContextValue | undefined>(undefined);

const EMBED = `
  id,
  tenant_id,
  role,
  is_active,
  tenant:tenants ( id, name, slug )
`;

/**
 * Resolves the authenticated user's tenant memberships from tenant_users.
 *
 * Depends on useAuth: it only queries once there is a user, and clears itself on
 * sign out. RLS (tenant_users_member_select in 001) already restricts the rows
 * to the caller's own memberships, and the join to tenants is admitted by
 * tenants_member_select — so no explicit user_id filter is needed for
 * correctness, though we keep the query scoped to active memberships.
 */
export function TenantContextProvider({ children }: { children: ReactNode }) {
  const { user, loading: authLoading } = useAuth();

  const [memberships, setMemberships] = useState<TenantMembership[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  // Key the fetch effect on the STABLE user id, never the `user` OBJECT. Supabase
  // re-emits an auth event (TOKEN_REFRESHED / SIGNED_IN) every time the window
  // regains focus and hands us a brand-new Session — and thus a new `user` object
  // reference — for the same signed-in person. Depending on the object would
  // re-run this effect on every refocus, flip `loading` to true, and make
  // ProtectedRoute swap the whole admin subtree for its spinner, unmounting the
  // in-memory booking draft (BookingDraftProvider) and wiping a half-filled form.
  // The id only changes on a real sign-in/out/switch, which is exactly when the
  // memberships must actually be re-resolved.
  const userId = user?.id ?? null;

  useEffect(() => {
    let cancelled = false;

    // Wait for auth to settle before touching state.
    if (authLoading) return;

    // All state updates live inside this async body (never synchronously in the
    // effect) to avoid the cascading-render lint and keep one update path.
    (async () => {
      // No user → nothing to resolve; clear and stop.
      if (!userId) {
        if (cancelled) return;
        setMemberships([]);
        setError(null);
        setLoading(false);
        return;
      }

      setLoading(true);
      setError(null);
      try {
        // Paginated per rule 1 — a user could theoretically belong to many
        // tenants, so we never issue an unbounded read.
        const rows = await fetchAllPagedRows<TenantMembership>(membershipRows, (from, to) =>
          supabase
            .from('tenant_users')
            .select(EMBED)
            .eq('is_active', true)
            .order('created_at', { ascending: true })
            .range(from, to)
            // PostgREST types a to-one embed (`tenant:tenants(...)`) as an
            // array it can't prove is singular; at runtime it is one object.
            // Override the inferred row type, as resolveProperty does via its
            // maybeSingle generic.
            .returns<TenantMembership[]>(),
        );
        if (cancelled) return;
        setMemberships(rows);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e : new Error(String(e)));
        setMemberships([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [userId, authLoading]);

  // Active tenant = first membership FOR NOW. A tenant switcher (letting a
  // multi-tenant user pick which of `memberships` is active, and persisting the
  // choice) is a later feature; until then we deterministically take the first,
  // ordered by created_at so it is stable across loads.
  const active = memberships[0] ?? null;
  const role = active?.role ?? null;

  const value: TenantContextValue = {
    tenantId: active?.tenant_id ?? null,
    tenantName: active?.tenant?.name ?? null,
    role,
    isAdmin: role !== null && ADMIN_ROLES.includes(role),
    memberships,
    loading,
    error,
  };

  return (
    <TenantContext.Provider value={value}>{children}</TenantContext.Provider>
  );
}

export function useTenantContext(): TenantContextValue {
  const value = useContext(TenantContext);
  if (value === undefined) {
    throw new Error(
      'useTenantContext must be used within a TenantContextProvider',
    );
  }
  return value;
}
