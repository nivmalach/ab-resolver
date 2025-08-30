# A/B Testing Service

A modern Node.js/Express service for running URL-vs-URL A/B tests with a clean admin dashboard. Features server-side variant assignment, client-side redirection, and GTM integration.

## Features

- 🎯 **URL-based A/B Testing**: Test different URLs against each other with configurable traffic allocation
- 🔄 **Server-side Assignment**: Deterministic and sticky variant assignment based on client ID
- 📊 **GTM Integration**: Automatic `exp_exposure` event pushing to dataLayer
- 🎨 **Modern Admin Dashboard**: Create, edit, and manage experiments with ease
- ⏰ **Scheduled Experiments**: Optional start and end dates for automated experiment lifecycle
- 🔍 **QA Tools**: Force variants for testing and preview
- 🔒 **Secure Admin Access**: Password-protected admin interface
- 💾 **PostgreSQL Storage**: Optional database storage (falls back to in-memory)

## Quick Start

### Prerequisites
- Node.js >= 18
- npm or yarn
- PostgreSQL database (optional)

### Installation

1. Clone and install:
   ```bash
   git clone https://github.com/nivmalach/ab-resolver.git
   cd ab-resolver
   npm install
   ```

2. Set environment variables:
   ```bash
   # Required for admin access
   ADMIN_TOKEN=your-secure-token
   
   # Optional: PostgreSQL connection
   DATABASE_URL=postgres://user:pass@host:5432/dbname
   
   # Optional: Allowed origins (comma-separated)
   ALLOWED_ORIGINS=https://example.com,https://www.example.com
   
   # Optional: Port (default: 8080)
   PORT=8080
   ```

3. Start the server:
   ```bash
   npm start
   ```

### Client Implementation

Add this single line to your HTML `<head>`:
```html
<script src="https://your-resolver-domain.com/ab.js" defer></script>
```

The script will:
- Hide the page temporarily to prevent flashing
- Check for active experiments
- Handle variant assignment and cookies
- Redirect if needed (preserving parameters)
- Push events to dataLayer
- Show the page

## Admin Dashboard

Access the admin interface at `/admin` to:
- Create and manage experiments
- Set traffic allocation
- Schedule experiment start/end dates
- Monitor experiment status
- Force variants for testing
- Search and filter experiments

### Experiment Configuration
- **Experiment Name**: Descriptive name for the test
- **Baseline/Test URLs**: The URLs to test against each other
- **Split Ratio**: Traffic allocation between variants (0-100%)
- **Preserve Parameters**: Option to maintain URL parameters across redirects
- **Start/End Dates**: Optional scheduling for automated experiment lifecycle

## API Endpoints

### POST `/exp/resolve`
Main resolver endpoint for variant assignment.

Request:
```json
{
  "url": "https://example.com/page",
  "cid": "ga-client-id",
  "force": "A"  // Optional: force "A" or "B" variant
}
```

Response:
```json
{
  "active": true,
  "id": "abc123xyz",
  "baseline_url": "https://example.com/control",
  "test_url": "https://example.com/variant",
  "allocation_b": 0.5,
  "preserve_params": true,
  "variant": "A"
}
```

### GET `/healthz`
Health check endpoint: `{ "ok": true }`

## Deployment

### Deploy on Render
1. Create a new GitHub repo and push the code
2. In Render: New → Web Service → connect repo
3. Runtime: Node 18+
4. Start Command: `node server.js`
5. Set environment variables (ADMIN_TOKEN required)

## Technical Details

### Variant Assignment
- Uses client ID (from GA) + experiment ID for deterministic assignment
- Supports forced variants via `?__exp=forceA` or `?__exp=forceB`
- Maintains sticky assignment via cookies
- Time-bucketed for consistent user experience

### CORS Configuration
- Dynamically allows origins matching experiment URLs
- Supports explicit allowed origins via ALLOWED_ORIGINS
- Falls back to `*` in development

### Storage
- PostgreSQL for production use
- In-memory fallback for development
- Automatic schema creation and migration

### Security
- Admin routes protected by token
- Signed session cookies
- CORS protection in production
- No hardcoded credentials

## Development

### Local Setup
1. Clone the repository
2. Install dependencies: `npm install`
3. Start server: `npm start`
4. Access admin: `http://localhost:8080/admin`

### Environment Variables
- `ADMIN_TOKEN`: Required for admin access
- `DATABASE_URL`: Optional PostgreSQL connection
- `ALLOWED_ORIGINS`: Optional CORS origins
- `PORT`: Optional custom port (default: 8080)
- `SESSION_SECRET`: Optional custom session secret