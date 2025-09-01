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

## Environment Variables for Portainer
Set the following environment variables in Portainer:

```
PORT=3000
NODE_ENV=production
ADMIN_TOKEN=<secure-random-string>
SESSION_SECRET=<secure-random-string>
ALLOWED_ORIGINS=<comma-separated-list-of-domains>
DATABASE_URL=postgres://niv:your-password@postgres:5432/ab-resolver
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
