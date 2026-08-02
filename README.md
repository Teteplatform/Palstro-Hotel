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
