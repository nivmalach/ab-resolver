# A/B Experiment Resolver (MVP)

This is a tiny Node/Express service that powers your client-side URL-vs-URL A/B tests.
Your GTM bootstrap calls **POST `/exp/resolve`** to get the active experiment and (if needed) a variant.

## Quick Start

### Prerequisites
- Node.js >= 18
- npm or yarn
- PostgreSQL database (optional, falls back to in-memory storage)

### Installation
1. Clone the repository:
   ```bash
   git clone https://github.com/nivmalach/ab-resolver.git
   cd ab-resolver
   ```

2. Install dependencies:
   ```bash
   npm install
   # or
   yarn install
   ```

3. Set up environment variables:
   ```bash
   # Required for admin access (change in production)
   ADMIN_TOKEN=your-secure-token
   
   # Optional: PostgreSQL connection string
   DATABASE_URL=postgres://user:pass@host:5432/dbname
   
   # Optional: Comma-separated allowed origins
   ALLOWED_ORIGINS=https://example.com,https://www.example.com
   
   # Optional: Custom port (default: 8080)
   PORT=8080
   ```

4. Start the server:
   ```bash
   npm start
   # or
   yarn start
   ```

### Implementation

Add this single line to your HTML `<head>` section:
```html
<script src="https://your-resolver-domain.com/admin/ab-helper.js" defer></script>
```

That's it! The script will:
- Automatically detect experiments for the current page
- Handle variant assignment
- Push events to dataLayer
- Manage page transitions
- Handle all error cases

## What it does
- Matches the current page by **domain + exact path** (MVP).
- Returns experiment config (baseline/test URLs, allocation).
- Assigns a sticky variant deterministically from the GA `_ga` client hint (`cid`) + experiment id.
- Supports QA override (`force` = "A" or "B").
- Handles CORS for browser calls.

---

## 1) Edit your experiment
Open `server.js` and replace the placeholders in the `experiments` array:

```js
domain: "YOUR_DOMAIN_HERE",         // e.g., "example.com"
path_pattern: "/baseline-path",     // e.g., "/landing-1"
baseline_url: "https://YOUR_DOMAIN_HERE/baseline-path",
test_url:     "https://YOUR_DOMAIN_HERE/test-path",
allocation_b: 0.5
```

> For MVP the `path_pattern` must be an exact match. (We can add wildcards later.)

---

## 2) Deploy on Render
1. Create a **new GitHub repo** and upload these files (`server.js`, `package.json`).
2. In Render: **New +** → **Web Service** → connect the repo.
3. **Runtime:** Node 18+ (Render detects from `engines`).
4. **Build Command:** *(leave empty)*
5. **Start Command:** `node server.js`
6. (Optional) set env var **ALLOWED_ORIGINS** to your site origins, comma-separated, e.g.  
   `https://example.com,https://www.example.com`  
   If you skip it, CORS is open (`*`) for MVP/dev.

When it goes live you’ll have an endpoint like:  
`https://YOUR-SERVICE.onrender.com/exp/resolve`

---

## 3) Test the endpoint
Use `curl` (replace the URL and host/path to your baseline page):

```bash
curl -s -X POST https://YOUR-SERVICE.onrender.com/exp/resolve   -H "Content-Type: application/json"   -d '{"url":"https://example.com/baseline-path?gclid=123","cid":"1222333444"}' | jq
```

Expected JSON:
```json
{
  "active": true,
  "id": "exp_lp_001",
  "baseline_url": "https://example.com/baseline-path",
  "test_url": "https://example.com/test-path",
  "allocation_b": 0.5,
  "preserve_params": true,
  "variant": "A"   // or "B"
}
```

### Health check
`GET https://YOUR-SERVICE.onrender.com/healthz` → `{ "ok": true }`

---

## 4) Wire GTM (next step)
Once this is deployed, you’ll paste the **GTM bootstrap tag** (I’ll give you next) and set `API` to your Render URL.

---

## Notes
- This service stores experiments **in memory** for MVP. In Phase 2 we’ll move them to Postgres with CRUD APIs.
- Variant assignment is deterministic and sticky when you set a client cookie in GTM. The resolver just gives you the same decision each time for a given `cid`.
- `preserve_params` tells the client to carry **GCLID/UTMs/hash** across the redirect.
