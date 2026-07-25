import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { PlatformMark } from '../components/ui/PlatformMark';

// Where to land after a successful sign in when we have no remembered origin.
const DEFAULT_DESTINATION = '/admin';

// User-facing copy. Wrong email and wrong password MUST map to the SAME message
// (3.txt constraint): the app never reveals whether an email is registered.
const MSG = {
  credentials: 'That email or password is incorrect.',
  network: "We couldn't reach the server. Check your connection and try again.",
  generic: 'Something went wrong. Please try again.',
} as const;

// Map a thrown Supabase auth error to one of the three messages above. We never
// surface the raw error text or a stack trace to the user.
function classifyError(e: unknown): string {
  const err = e as { name?: string; status?: number; message?: string } | null;
  const name = err?.name ?? '';
  const message = err?.message ?? '';

  // Supabase returns AuthRetryableFetchError (or a plain fetch TypeError) when
  // it cannot reach the server — a distinct, actionable failure.
  if (
    name.includes('Retryable') ||
    /fetch|network|failed to fetch/i.test(message)
  ) {
    return MSG.network;
  }

  // Invalid credentials come back as a 400 with "Invalid login credentials" —
  // identical for a wrong email and a wrong password, which is exactly the
  // non-disclosure we want.
  if (err?.status === 400 || /invalid login credentials/i.test(message)) {
    return MSG.credentials;
  }

  return MSG.generic;
}

/**
 * Email + password sign in. Warm palette matching the landing page (cream
 * surface, terracotta/accent CTA). Distinguishes loading, wrong-credentials and
 * network failure with clear messages, and never shows a stack trace.
 */
export function LoginPage() {
  const { session, loading: authLoading, signIn } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // The route the user was heading to before being bounced here, if any.
  const from =
    (location.state as { from?: { pathname?: string } } | null)?.from
      ?.pathname ?? DEFAULT_DESTINATION;

  // Already signed in: don't show the form at all — go where they were headed.
  // (Waits for auth to settle so we don't redirect on a not-yet-known session.)
  if (!authLoading && session) {
    return <Navigate to={from} replace />;
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitting) return;

    setErrorMsg(null);
    setSubmitting(true);
    try {
      await signIn(email.trim(), password);
      // onAuthStateChange updates session; navigate straight to the target.
      navigate(from, { replace: true });
    } catch (err) {
      setErrorMsg(classifyError(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-cream px-6 py-12">
      <div className="w-full max-w-sm">
        {/* Branding on the sign-in screen. /login is NOT property-scoped — there
            is no active property here, so there is no property logo to read.
            Show the Palstro-Hotels PLATFORM mark instead: at this point the user
            is signing into the platform, not into a specific hotel. Do not wire a
            property lookup into this route — it has no property (3.txt §2). */}
        <div className="mb-6 flex justify-center">
          <PlatformMark />
        </div>
        <div className="rounded-2xl border border-sand-border bg-white/60 p-8 shadow-sm">
          <h1 className="text-2xl font-bold tracking-tight text-charcoal">
            Sign in
          </h1>
          <p className="mt-1 text-sm text-charcoal-muted">
            Enter your details to access the admin.
          </p>

          <form className="mt-6 space-y-4" onSubmit={handleSubmit} noValidate>
            <div>
              <label
                htmlFor="email"
                className="block text-sm font-medium text-charcoal"
              >
                Email
              </label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={submitting}
                className="mt-1 w-full rounded-lg border border-sand-border bg-cream px-3 py-2.5 text-charcoal placeholder:text-charcoal-muted focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-60"
              />
            </div>

            <div>
              <label
                htmlFor="password"
                className="block text-sm font-medium text-charcoal"
              >
                Password
              </label>
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={submitting}
                className="mt-1 w-full rounded-lg border border-sand-border bg-cream px-3 py-2.5 text-charcoal placeholder:text-charcoal-muted focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-60"
              />
            </div>

            {errorMsg ? (
              <p
                role="alert"
                className="rounded-lg bg-primary/10 px-3 py-2 text-sm font-medium text-primary"
              >
                {errorMsg}
              </p>
            ) : null}

            <button
              type="submit"
              disabled={submitting}
              className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:cursor-not-allowed disabled:opacity-70"
            >
              {submitting ? (
                <>
                  <span
                    className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white"
                    aria-hidden="true"
                  />
                  Signing in…
                </>
              ) : (
                'Sign in'
              )}
            </button>
          </form>
        </div>
      </div>
    </main>
  );
}
