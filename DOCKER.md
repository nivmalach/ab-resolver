# Docker Deployment Guide

## Local Development
To run the service locally with Docker:

```bash
# Start the service
docker compose up -d

# View logs
docker compose logs -f

# Stop the service
docker compose down
```

The service will be available at http://localhost:3001

## Environment Variables on the Server
When managing the server over SSH, keep production secrets in a server-only `.env` file next to `docker-compose.yml`, or export them in the shell before running Docker commands. Do not commit real secret values.

```
PORT=3000
NODE_ENV=production
TRUST_PROXY=true
SESSION_SECRET=<secure-random-string>
GOOGLE_CLIENT_ID=<google-oauth-client-id>
GOOGLE_CLIENT_SECRET=<google-oauth-client-secret>
GOOGLE_REDIRECT_URI=https://ab-resolver.YOURDOMAIN.com/admin/oauth/google/callback
ADMIN_ALLOWED_EMAILS=<first-owner-email-for-bootstrap>
ALLOWED_ORIGINS=<comma-separated-bootstrap-origins>
DATABASE_URL=postgresql://postgres.tbkrcihxjjorwlpwbdxw:<supabase-db-password>@aws-1-ap-northeast-1.pooler.supabase.com:5432/postgres
DB_SSL=true
```

`ADMIN_ALLOWED_EMAILS` is only used to bootstrap the first owner if the `team_members` table is empty. Manage daily admin access from the dashboard after first login.

`ALLOWED_ORIGINS` is only used to bootstrap/fallback the initial browser origins if the `allowed_origins` table is empty. Manage daily allowed-origin changes from the dashboard after first login.

Redeploy from SSH after updating code or environment:

```bash
git pull
docker compose up -d --build
docker compose logs -f ab-resolver
```

## Internal Port
The application listens on port 3000 internally.

## Caddy Route Configuration
Add the following snippet to your Caddyfile:

```caddy
ab-resolver.YOURDOMAIN.com {
    reverse_proxy ab-resolver:3000
}
```
