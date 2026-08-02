# React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

## Deployment

This is a single-page app that uses client-side routing (react-router) for real
URLs like `/login` and `/admin`. On Vercel there is only one built HTML file
(`/index.html`) — there is no `/login.html` or `/admin.html` on disk. Without a
rewrite, a **direct visit or a browser refresh** on `/login` or `/admin` hits
Vercel's filesystem, finds no matching file, and returns a **404**.

`vercel.json` fixes this by rewriting non-asset paths to `/index.html`, letting
react-router resolve the route in the browser. `vercel.json` must be strict JSON
matching Vercel's schema (no comments, no extra keys), which is why this
explanation lives here rather than in that file.

The rewrite `source` deliberately **excludes real static assets** so they are
still served as files and never rewritten to HTML — anything under `/assets/`
(Vite's hashed JS/CSS bundles), common top-level static files (favicon,
`robots.txt`, `sitemap.xml`, web manifest), and any path with a file extension.
Only extensionless app routes fall through to the SPA fallback. If you change the
pattern, keep that exclusion intact: a rewrite that swallows `/assets/…` would
serve HTML in place of the app's own scripts and styles and break the site.

`/api/` is excluded for the same reason: it holds real serverless functions (the
night-audit cron below), and a rewrite that swallowed it would answer the
scheduler with the SPA's HTML and the audit would silently never run.

### The night-audit cron

`vercel.json` schedules `/api/cron/night-audit` at `0 5 * * *` — **05:00 UTC**,
which is **06:00 in Africa/Lagos**, the default `properties.night_audit_time`.
Vercel cron expressions are always UTC and there is one schedule for all
properties, so the offset is chosen rather than derived. The **business date is
not** chosen here: `run_night_audit` derives it per property as "yesterday in
that property's own timezone", which is correct at any hour of that property's
operating day. See the header comment in `api/cron/night-audit.ts` for the
timezone limitation this leaves and the recommended fix (an hourly schedule
filtered per property) if properties ever span far-western timezones.

Three environment variables must be set on the Vercel project (Production and
Preview). None is `VITE_`-prefixed, so none can reach the browser bundle:

| Variable | Purpose |
| --- | --- |
| `CRON_SECRET` | Vercel's scheduler sends it automatically as `Authorization: Bearer …` on every cron invocation. The endpoint requires it and **refuses every request when it is unset** — it fails closed rather than accepting anonymous callers. |
| `SUPABASE_SERVICE_ROLE_KEY` | Lets one invocation audit every tenant's properties. Server-only, never in the client bundle. |
| `SUPABASE_URL` | The project URL. Falls back to `VITE_SUPABASE_URL` if absent, since the URL is not a secret. |

Re-running the endpoint is harmless: every posting is idempotent per
(booking, night) via a deterministic key and a unique index, so a retry returns
the existing charges and posts nothing. Its JSON response reports
`posted` / `already_posted` / `booking_errors` per property so a failed or
partial run is diagnosable without opening the logs.

### Emailing a statement to a guest

`POST /api/statements/email` sends one guest their statement as a PDF
attachment. A browser cannot send email, so this is the only part of the export
build that leaves the tab.

**The PDF is generated on the server**, from the folio, by the same
`assembleStatement` and `buildStatementPdfDefinition` the screen and the
downloads use (`src/lib/statement.ts`, `src/lib/export/statementPdfDefinition.ts`
— both deliberately free of any browser-only import so a Node function can
compile them). The request carries ids and an address, never a figure, so a
tampered client cannot email a doctored bill. The one exception is the
letterhead image: every stored variant is WebP, which no PDF can embed, so the
browser sends the PNG it already decoded and the server validates and bounds it
(`api/_lib/statementLogoServer.ts` sets out that trade in full).

**Who may send.** The caller must present their own Supabase access token; every
read then runs as that user under RLS — there is no service-role key on this
path — and they must additionally hold a grant to the property
(`get_property_ids()`), checked in the endpoint and again inside
`claim_statement_email`. A public caller cannot reach it.

**Not sent twice.** Every send is claimed in `statement_emails` (migration 030)
under an idempotency key before the mail is made, so a double-click or a retried
request reports the first attempt's outcome instead of sending a second copy.
The table also answers "did the guest get their bill?" — who sent which document
to what address, when, and what the provider said.

Four more environment variables, none `VITE_`-prefixed:

| Variable | Purpose |
| --- | --- |
| `RESEND_API_KEY` | The transactional email provider's key. **Server-only** — it exists in this runtime and nowhere else in the repo, is never returned to the client and is never logged. The endpoint refuses to run when it is unset. |
| `STATEMENT_FROM_EMAIL` | The platform's verified sender (e.g. `statements@yourdomain`). Used as the from-address until a hotel verifies its own domain. Required; the endpoint fails closed without it. |
| `STATEMENT_SENDER_DOMAINS` | Optional, comma-separated. The domains verified on the Resend account. A property may set `statement_from_email` in its branding, and it is honoured **only** if its domain appears here — Resend rejects mail from an unverified domain, so an unchecked override would make every send fail. |
| `SUPABASE_ANON_KEY` | Falls back to `VITE_SUPABASE_ANON_KEY`. The anon key is public by design; it is the caller's token, not this key, that grants access. |

Whatever the from-address, the sender's display name is the property's own name
and Reply-To is the property's own email, so the mail reads as the hotel's and a
guest who replies reaches the desk.

Note that `vite dev` does not serve `/api` — use `vercel dev` or a deployment to
exercise this endpoint locally.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend updating the configuration to enable type-aware lint rules:

```js
export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...

      // Remove tseslint.configs.recommended and replace with this
      tseslint.configs.recommendedTypeChecked,
      // Alternatively, use this for stricter rules
      tseslint.configs.strictTypeChecked,
      // Optionally, add this for stylistic rules
      tseslint.configs.stylisticTypeChecked,

      // Other configs...
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])

```

You can also install [eslint-plugin-react-x](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-x) and [eslint-plugin-react-dom](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-dom) for React-specific lint rules:

```js
// eslint.config.js
import reactX from 'eslint-plugin-react-x'
import reactDom from 'eslint-plugin-react-dom'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...
      // Enable lint rules for React
      reactX.configs['recommended-typescript'],
      // Enable lint rules for React DOM
      reactDom.configs.recommended,
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])

```
