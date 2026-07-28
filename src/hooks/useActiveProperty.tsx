import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from './useAuth';
import { fetchAccessibleProperties } from '../lib/fetchAccessibleProperties';
import type { Property } from '../types/tenant';

// Active-property context for the admin (3.txt §1). The active property lives in
// the URL (/admin/:propertySlug/...), NOT in component state or browser storage,
// so a refresh keeps it, links are shareable, and there is nothing to fall out
// of sync.
//
// A user with a single property never sees the switcher, but the plumbing is
// identical either way — the list is resolved the same way, the URL carries the
// slug the same way, and adding a second property Just Works. That uniformity is
// the point.
//
// SPLIT OF RESPONSIBILITIES:
//   - The PROVIDER holds only the list-level state: every property this user may
//     operate, plus loading/error. It does not read the slug (it can sit above
//     the :propertySlug route, e.g. wrapping the bare /admin redirect too).
//   - The HOOK resolves the ACTIVE property by matching the current route's
//     :propertySlug against that list, and adds switchProperty. Reading the slug
//     in the hook (where the consumer actually renders under :propertySlug)
//     avoids depending on where the provider sits.

interface ActivePropertyListValue {
  properties: Property[];
  loading: boolean;
  error: Error | null;
}

const ActivePropertyContext = createContext<ActivePropertyListValue | undefined>(
  undefined,
);

export function ActivePropertyProvider({ children }: { children: ReactNode }) {
  const { user, loading: authLoading } = useAuth();

  const [properties, setProperties] = useState<Property[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  // Key the fetch on the STABLE user id, not the `user` object. Supabase mints a
  // fresh Session (and a fresh `user` reference) for the same person on every
  // window refocus (TOKEN_REFRESHED / SIGNED_IN); depending on the object would
  // refetch the property list on every focus. See the same note in
  // useTenantContext — there the needless refetch also flips a `loading` that
  // ProtectedRoute gates on, unmounting the booking draft.
  const userId = user?.id ?? null;

  useEffect(() => {
    let cancelled = false;

    // Wait for auth to settle before deciding there is no user.
    if (authLoading) return;

    (async () => {
      if (!userId) {
        if (cancelled) return;
        setProperties([]);
        setError(null);
        setLoading(false);
        return;
      }

      setLoading(true);
      setError(null);
      try {
        const rows = await fetchAccessibleProperties(userId);
        if (cancelled) return;
        setProperties(rows);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e : new Error(String(e)));
        setProperties([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [userId, authLoading]);

  return (
    <ActivePropertyContext.Provider value={{ properties, loading, error }}>
      {children}
    </ActivePropertyContext.Provider>
  );
}

export interface ActiveProperty {
  // The property matching the current :propertySlug, or null when the slug is
  // absent (bare /admin) or does not match one the user may access. Consumers
  // distinguish "still loading" from "genuinely not found" via `loading`.
  property: Property | null;
  properties: Property[];
  loading: boolean;
  error: Error | null;
  // Navigate to the same admin sub-page under a different property. Keeps the
  // user on the screen they were on (e.g. Settings) rather than dumping them at
  // a property root.
  switchProperty: (slug: string) => void;
}

export function useActiveProperty(): ActiveProperty {
  const ctx = useContext(ActivePropertyContext);
  if (ctx === undefined) {
    throw new Error(
      'useActiveProperty must be used within an ActivePropertyProvider',
    );
  }

  const { propertySlug } = useParams();
  const navigate = useNavigate();
  const location = useLocation();

  const property =
    (propertySlug
      ? ctx.properties.find((p) => p.slug === propertySlug)
      : undefined) ?? null;

  function switchProperty(slug: string) {
    // Preserve the current sub-page: /admin/<old>/settings -> /admin/<new>/settings.
    // parts = ['admin', '<slug>', ...rest]; rest defaults to 'settings'.
    const parts = location.pathname.split('/').filter(Boolean);
    const rest = parts.slice(2);
    const sub = rest.length > 0 ? rest.join('/') : 'settings';
    navigate(`/admin/${slug}/${sub}`);
  }

  return {
    property,
    properties: ctx.properties,
    loading: ctx.loading,
    error: ctx.error,
    switchProperty,
  };
}
