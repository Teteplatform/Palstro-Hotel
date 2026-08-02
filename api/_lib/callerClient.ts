import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// ============================================================================
// THE CALLER'S OWN SUPABASE CLIENT — how a serverless function stays inside RLS
// ============================================================================
//
// The night-audit cron (api/cron/night-audit.ts) runs as the SERVICE ROLE, which
// bypasses RLS, because it must audit every tenant's properties on nobody's
// behalf. This endpoint is the opposite case: it acts FOR one signed-in staff
// member, so it must be able to see exactly what they can see and nothing more.
//
// So it builds a client from the ANON key plus the caller's own access token.
// Every read then runs as that user, under the same policies the browser is
// subject to:
//
//   * a caller who is not a member of the tenant reads no property, no booking
//     and no folio — the endpoint answers "not found" because there genuinely is
//     nothing there for them, not because it remembered to check;
//   * a forged or expired token never resolves to a user at all;
//   * a bug in this function cannot leak another tenant's statement, because the
//     database would have to hand the rows over first.
//
// THE SERVICE-ROLE KEY IS DELIBERATELY NOT USED HERE, and must not be added: a
// single missed `.eq('tenant_id', …)` in a service-role function is a
// cross-tenant data leak, while the same mistake under the caller's token is a
// query that returns nothing. RLS is the floor (rule 19) — the reads still scope
// to the active tenant AND property on top of it.
//
// The ANON key is public by design (it ships in the browser bundle), so reading
// it from a VITE_-prefixed variable as a fallback costs nothing. THE PROVIDER
// API KEY IS NOT LIKE THAT — see api/_lib/resend.ts.

export interface CallerContext {
  supabase: SupabaseClient;
  userId: string;
}

// The bearer token the browser attached, or null. Nothing is trusted about it
// here; it is handed to Supabase, which is the only thing that can validate it.
export function bearerToken(request: Request): string | null {
  const header = request.headers.get('authorization') ?? '';
  if (!header.toLowerCase().startsWith('bearer ')) return null;
  const token = header.slice(7).trim();
  return token.length > 0 ? token : null;
}

export function supabaseServerConfig(): { url: string; anonKey: string } | null {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;
  return { url, anonKey };
}

// Resolve the caller, or null when the token is missing, expired or forged.
//
// getUser() is a round trip to Supabase Auth that VERIFIES the token's
// signature and expiry against the project's own keys. Decoding the JWT locally
// would be faster and completely worthless: an unverified JWT is a string the
// caller wrote.
export async function resolveCaller(
  request: Request,
): Promise<CallerContext | null> {
  const config = supabaseServerConfig();
  if (!config) return null;

  const token = bearerToken(request);
  if (!token) return null;

  const supabase = createClient(config.url, config.anonKey, {
    // Stateless: one invocation, one request, no storage of any kind.
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    // Every PostgREST request from this client carries the caller's token, so
    // auth.uid() inside a policy or an RPC resolves to THEM.
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;

  return { supabase, userId: data.user.id };
}

// The properties this caller may OPERATE — get_property_ids(), the same set the
// admin's property switcher is built from (lib/fetchAccessibleProperties).
//
// Membership of a tenant is NOT enough: properties_member_select (001) admits
// every property in the caller's tenants, so a user granted only the Bonny
// Island property could otherwise read — and email — a sister hotel's
// statements. This is rule 19's shape applied to an endpoint: RLS restricts the
// tenant, this restricts the property.
//
// The claim RPC re-checks the same thing inside the database, which is the
// authoritative gate. This one exists so the endpoint refuses early, with a
// message that says which of the two things went wrong.
export async function callerMayOperateProperty(
  supabase: SupabaseClient,
  propertyId: string,
): Promise<boolean> {
  const { data, error } = await supabase.rpc('get_property_ids');
  if (error) throw error;
  const ids = (data ?? []) as string[];
  return ids.includes(propertyId);
}
