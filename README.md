# A/B Resolver

A small Express service for URL-vs-URL A/B tests. It serves a browser script, resolves active experiments from Postgres/Supabase, assigns a sticky variant, redirects variant B traffic when needed, and pushes exposure events to `dataLayer`.

## Current Shape

- Node.js/Express server in `server.js`
- Supabase/Postgres-backed experiment table
- Static admin UI under `/admin`
- Public client script at `/ab.js`
- Deterministic variant assignment from visitor id + experiment id
- Local in-memory fallback when `DATABASE_URL` is not set

## Setup

Install dependencies:

```bash
npm install
```

Copy the environment template:

```bash
cp .env.example .env
```

Required production variables:

```bash
NODE_ENV=production
PORT=3000
TRUST_PROXY=true
SESSION_SECRET=<long-random-secret>
GOOGLE_CLIENT_ID=<google-oauth-client-id>
GOOGLE_CLIENT_SECRET=<google-oauth-client-secret>
GOOGLE_REDIRECT_URI=https://your-resolver-domain.com/admin/oauth/google/callback
ADMIN_ALLOWED_EMAILS=you@example.com
DATABASE_URL=<supabase-postgres-connection-string>
DB_SSL=true
ALLOWED_ORIGINS=https://example.com,https://www.example.com
```

The Supabase schema is already applied. The running app still needs `DATABASE_URL` set in its environment so it can connect to that database. In Supabase, use Connect → Direct → Session pooler → Type: URI. For this project, the URI should use user `postgres.tbkrcihxjjorwlpwbdxw`, host `aws-1-ap-northeast-1.pooler.supabase.com`, port `5432`, and database `postgres`; replace the password placeholder with the database password from Supabase. Keep it server-side only. The app uses `pg`, not `supabase-js`, so no anon/service-role key is needed for runtime.

The current schema has been applied to Supabase through MCP. For a fresh project, run `schema.sql` in the Supabase SQL editor or with the Supabase MCP migration tool:

```sql
-- paste schema.sql
```

Start locally:

```bash
npm start
```

Run tests:

```bash
npm test
```

## Client Integration

Add the resolver script to the tested site:

```html
<script src="https://your-resolver-domain.com/ab.js" defer></script>
```

If the script is served from a CDN or different asset host, set the resolver origin explicitly:

```html
<script src="https://cdn.example.com/ab.js" data-resolver-origin="https://your-resolver-domain.com" defer></script>
```

The script:

- creates a first-party `ab_cid` visitor cookie
- calls `/exp/resolve`
- stores `expvar_<experiment_id>` for sticky assignment
- redirects baseline visitors assigned to B
- pushes `exp_exposure` to `window.dataLayer`

QA forcing is supported with `?__exp=forceA` or `?__exp=forceB`.

## Admin

Open `/admin/login` and sign in with Google. Admin access is stored in the `team_members` database table. `ADMIN_ALLOWED_EMAILS` is only a bootstrap setting: when `team_members` is empty, those emails are inserted as active `owner` users on first login.

Admin login uses a 30-day signed, HTTP-only cookie containing only a random session token. The database stores the SHA-256 hash of that token in `access_sessions`, linked to the team member email, expiry, revocation status, user agent, and IP. Every admin request checks both `access_sessions` and `team_members.active`, so disabling a team member or logging out invalidates access server-side.

Access roles are:

- `owner`: manage experiments and team members.
- `manager`: manage experiments.
- `viewer`: view experiments without changing them.

Create an OAuth client in Google Cloud Console:

- Application type: Web application
- Authorized JavaScript origins: leave empty unless Google requires one in your console
- Local authorized redirect URI: `http://localhost:3000/admin/oauth/google/callback`
- Production authorized redirect URI: `https://your-resolver-domain.com/admin/oauth/google/callback`

The production URL is the public domain where this Express resolver is deployed, not the Supabase project URL. If no domain or reverse-proxy route has been configured yet, there is no production URL yet; add the local redirect URI now and add the production redirect URI after choosing the resolver domain.

The dashboard supports creating, editing, starting, stopping, deleting, searching, and previewing experiments. It also includes owner-only sections for managing Team Members and Allowed Origins without changing environment variables.

Allowed origins control which website origins may call `/exp/resolve` from a browser. `ALLOWED_ORIGINS` is a bootstrap/fallback setting: when `allowed_origins` is empty, those origins are inserted as active origins. After first deploy, manage this list from the dashboard.

## API

Resolve:

```http
POST /exp/resolve
Content-Type: application/json
```

```json
{
  "url": "https://example.com/pricing",
  "cid": "visitor-id",
  "experiment_id": "pricing_test",
  "variant": "A",
  "force": "B"
}
```

Admin CRUD routes are cookie-authenticated:

- `GET /experiments`
- `POST /experiments`
- `PATCH /experiments/:id`
- `DELETE /experiments/:id`
- `POST /experiments/:id/start`
- `POST /experiments/:id/pause`
- `POST /experiments/:id/stop`

## Production Notes

- Set `NODE_ENV=production`.
- Set `DB_SSL=true` for Supabase.
- Set `TRUST_PROXY=true` when the app runs behind a reverse proxy or HTTPS terminator so Google OAuth callback URLs honor forwarded HTTPS headers.
- Use Google OAuth for admin access and keep `ADMIN_ALLOWED_EMAILS` tight.
- Run `npm audit --omit=dev` before deploy.
- Keep `DATABASE_URL`, `GOOGLE_CLIENT_SECRET`, and `SESSION_SECRET` out of frontend code.
- Configure `ALLOWED_ORIGINS` with initial site origins, then manage ongoing changes from the dashboard.
- Use `/healthz` for health checks.
- Supabase currently has Row Level Security disabled on the server-managed tables. That is acceptable only if access stays server-side through `DATABASE_URL` and no Supabase anon/service-role key is used in the browser for these tables. To use Supabase client libraries against them later, design policies first, then enable RLS.
