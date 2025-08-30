// server.js
// Minimal /exp/resolve service for URL-vs-URL A/B tests
// Deploy on Render (Node >= 18). CommonJS, no build step.

const express = require("express");
const crypto  = require("crypto");
const { Pool } = require('pg');
const path = require("path");
const cookieParser = require("cookie-parser");
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || ""; // set on Render
const SESSION_SECRET = process.env.SESSION_SECRET || ADMIN_TOKEN || "change-me";
const DATABASE_URL = process.env.DATABASE_URL || null;
const pool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } }) : null;

const app = express();
app.use(express.json());
app.use(cookieParser(SESSION_SECRET));

// --- CORS (allow your site to call this endpoint from the browser) ---
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  
  // Always allow the origin in development
  if (ALLOWED_ORIGINS.length === 0) {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") return res.status(204).end();
    return next();
  }
  
  // In production, check if origin is allowed
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Vary", "Origin");
    if (req.method === "OPTIONS") return res.status(204).end();
    return next();
  }
  
  // Check if origin matches any experiment URLs
  const matchesExperiment = async () => {
    if (!origin) return false;
    try {
      const originUrl = new URL(origin);
      const experiments = pool ? await loadActiveExperimentsFromDB() : experiments;
      return experiments.some(exp => {
        try {
          const baselineHost = new URL(exp.baseline_url).hostname;
          const testHost = new URL(exp.test_url).hostname;
          return originUrl.hostname === baselineHost || originUrl.hostname === testHost;
        } catch (e) {
          return false;
        }
      });
    } catch (e) {
      return false;
    }
  };

  matchesExperiment().then(matches => {
    if (matches) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.setHeader("Vary", "Origin");
    }
    if (req.method === "OPTIONS") return res.status(204).end();
    next();
  }).catch(() => next());
});

// --- Experiments storage ---
// Primary: Postgres (via DATABASE_URL). Fallback: in-memory array (empty by default).
// Manage experiments via the API below; do not hardcode here.
let experiments = [];

// Check if URL matches experiment surface (baseline or test URL)
function matchesSurface(urlStr, exp) {
  try {
    const urls = {
      current: new URL(urlStr),
      base: new URL(exp.baseline_url),
      test: new URL(exp.test_url)
    };

    // Host must match either baseline or test
    if (urls.current.hostname !== urls.base.hostname && 
        urls.current.hostname !== urls.test.hostname) {
      return false;
    }

    // Compare paths without trailing slashes
    const clean = p => p.replace(/\/$/, '');
    const currentPath = clean(urls.current.pathname);
    return currentPath === clean(urls.base.pathname) || 
           currentPath === clean(urls.test.pathname);
  } catch {
    return false;
  }
}

// --- DB helpers ---
async function dbQuery(text, params){
  if (!pool) return { rows: [] };
  const client = await pool.connect();
  try { return await client.query(text, params); }
  finally { client.release(); }
}

async function loadActiveExperimentsFromDB(){
  if (!pool) return [];
  const now = new Date();
  const { rows } = await dbQuery(
    `SELECT id, name, baseline_url, test_url, allocation_b, status, preserve_params, start_at, stop_at
       FROM experiments
      WHERE status = 'running'
        AND (start_at IS NULL OR start_at <= NOW())
        AND (stop_at  IS NULL OR stop_at  >= NOW())`,
    []
  );
  return rows || [];
}

async function findActiveExperimentForUrl(urlStr){
  // Prefer DB; fallback to in-memory array if DB not configured
  const list = pool ? await loadActiveExperimentsFromDB() : experiments;
  for (const e of list){
    // shape-normalize fields from DB (snake_case already matches)
    const exp = {
      id: e.id,
      name: e.name,
      baseline_url: e.baseline_url,
      test_url: e.test_url,
      allocation_b: e.allocation_b != null ? Number(e.allocation_b) : 0.5,
      status: e.status,
      preserve_params: (e.preserve_params !== false),
      start_at: e.start_at,
      stop_at: e.stop_at
    };
    try { if (matchesSurface(urlStr, exp)) return exp; } catch(_){}
  }
  return null;
}

// --- Admin UI routes ---
app.get('/admin/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin', 'login.html'));
});

app.post('/admin/login', express.urlencoded({ extended: true }), (req, res) => {
  if (!ADMIN_TOKEN || req.body.password === ADMIN_TOKEN) {
    res.cookie('admin_session', 'yes', {
      httpOnly: true,
      signed: true,
      sameSite: 'lax',
      secure: true,
    });
    return res.redirect('/admin');
  }
  res.status(401).send('Invalid password');
});

app.get('/admin/logout', (req, res) => {
  res.clearCookie('admin_session');
  res.redirect('/admin/login');
});

// Serve public AB testing script with aggressive caching
app.get('/ab.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
  res.setHeader('Vary', 'Accept-Encoding');
  res.sendFile(path.join(__dirname, 'public/ab.js'));
});

// Protect /admin assets with cookie session (or open if no ADMIN_TOKEN)
app.use('/admin', (req, res, next) => {
  if (!ADMIN_TOKEN) return next();
  if (req.path === '/login') return next();
  if (req.signedCookies && req.signedCookies.admin_session === 'yes') return next();
  return res.redirect('/admin/login');
});

// Serve static admin dashboard files
app.use('/admin', express.static(path.join(__dirname, 'admin')));

// --- Admin auth: allow either Bearer token or signed cookie session ---
function requireAdmin(req, res, next){
  const token = ADMIN_TOKEN;
  if (!token) return next(); // if not set, allow everything (MVP)
  const hasCookie = req.signedCookies && req.signedCookies.admin_session === 'yes';
  const auth = req.headers['authorization'] || '';
  const hasBearer = auth === `Bearer ${token}`;
  if (hasCookie || hasBearer) return next();
  // If the client expects HTML, redirect to login; otherwise JSON 401
  if ((req.headers.accept || '').includes('text/html')) return res.redirect('/admin/login');
  return res.status(401).json({ error: 'unauthorized' });
}

// --- Experiments CRUD API ---
// Create
app.post('/experiments', requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    if (!pool) return res.status(501).json({ error: 'db_not_configured' });
    const q = `INSERT INTO experiments
      (id, name, baseline_url, test_url, allocation_b, status, preserve_params, start_at, stop_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING *`;
    const params = [
      b.id, b.name, b.baseline_url, b.test_url,
      b.allocation_b ?? 0.5,
      b.status ?? 'draft',
      b.preserve_params ?? true,
      b.start_at ?? null,
      b.stop_at ?? null
    ];
    const { rows } = await dbQuery(q, params);
    res.json(rows[0]);
  } catch (e) { res.status(400).json({ error: 'bad_request', detail: String(e) }); }
});

// List
app.get('/experiments', requireAdmin, async (_req, res) => {
  try {
    if (!pool) return res.json(experiments);
    const { rows } = await dbQuery(`SELECT * FROM experiments ORDER BY created_at DESC NULLS LAST, id`, []);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'server_error' }); }
});

// Update (PATCH)
app.patch('/experiments/:id', requireAdmin, async (req, res) => {
  try {
    if (!pool) return res.status(501).json({ error: 'db_not_configured' });
    const id = req.params.id;
    const b = req.body || {};
    const fields = [];
    const vals = [];
    let idx = 1;
    for (const [k,v] of Object.entries(b)){
      fields.push(`${k} = $${idx++}`); vals.push(v);
    }
    if (!fields.length) return res.status(400).json({ error: 'no_fields' });
    vals.push(id);
    const { rows } = await dbQuery(`UPDATE experiments SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`, vals);
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    res.json(rows[0]);
  } catch (e) { res.status(400).json({ error: 'bad_request', detail: String(e) }); }
});

// Delete
app.delete('/experiments/:id', requireAdmin, async (req, res) => {
  try {
    if (!pool) return res.status(501).json({ error: 'db_not_configured' });
    const id = req.params.id;
    await dbQuery(`DELETE FROM experiments WHERE id = $1`, [id]);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: 'bad_request', detail: String(e) }); }
});

// Status helpers
app.post('/experiments/:id/start', requireAdmin, async (req,res)=>{
  if (!pool) return res.status(501).json({ error: 'db_not_configured' });
  const id = req.params.id;
  const { rows } = await dbQuery(`UPDATE experiments SET status='running' WHERE id=$1 RETURNING *`, [id]);
  if (!rows.length) return res.status(404).json({ error: 'not_found' });
  res.json(rows[0]);
});
app.post('/experiments/:id/pause', requireAdmin, async (req,res)=>{
  if (!pool) return res.status(501).json({ error: 'db_not_configured' });
  const id = req.params.id;
  const { rows } = await dbQuery(`UPDATE experiments SET status='paused' WHERE id=$1 RETURNING *`, [id]);
  if (!rows.length) return res.status(404).json({ error: 'not_found' });
  res.json(rows[0]);
});
app.post('/experiments/:id/stop', requireAdmin, async (req,res)=>{
  if (!pool) return res.status(501).json({ error: 'db_not_configured' });
  const id = req.params.id;
  const { rows } = await dbQuery(`UPDATE experiments SET status='stopped' WHERE id=$1 RETURNING *`, [id]);
  if (!rows.length) return res.status(404).json({ error: 'not_found' });
  res.json(rows[0]);
});

// Deterministic variant assignment based on client ID
function assignVariant({ cid, id, allocation_b }) {
  const allocation = allocation_b == null ? 0.5 : Number(allocation_b);
  const seed = (cid || crypto.randomUUID()) + id;
  const hash = crypto.createHash("sha256").update(seed).digest();
  const n = (hash[0] << 24) | (hash[1] << 16) | (hash[2] << 8) | hash[3];
  const r = (n >>> 0) / 0xFFFFFFFF;
  return r < allocation ? "B" : "A";
}

// Health check

app.get("/healthz", (_, res) => res.json({ ok: true }));

// --- Helper: escape for JS string literals
function jsString(s) {
  return String(s || '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r?\n/g, '\\n');
}

// --- Server-side variant from IP + UA (no GA cookie needed)
function assignVariantFromRequest(req, exp) {
  try {
    // Default allocation is 50/50
    const allocation = exp.allocation_b == null ? 0.5 : Number(exp.allocation_b);
    
    // Generate deterministic hash from IP + UA
    const ip = (req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.ip || '').toString();
    const ua = (req.headers['user-agent'] || '').toString();
    const seed = ip + '|' + ua + '|' + exp.id;
    
    // Use first 4 bytes of hash for random number
    const hash = crypto.createHash('sha256').update(seed).digest();
    const n = (hash[0] << 24) | (hash[1] << 16) | (hash[2] << 8) | hash[3];
    const random = (n >>> 0) / 0xFFFFFFFF; // Normalize to 0..1
    
    // Force exact 50/50 split
    const variant = random < allocation ? 'B' : 'A';
    
    // Log assignment for debugging
    console.log('Server variant assignment:', {
      ip: ip.split('.')[0] + '.x.x.x',
      allocation,
      random,
      variant,
      hash: hash.slice(0, 4).toString('hex')
    });
    
    return variant;
  } catch (e) {
    console.error('Error in variant assignment:', e);
    return 'A';
  }
}



// /exp/resolve: A request is considered active if it is on either the baseline or test URL of any running experiment.
// Main resolver
app.post("/exp/resolve", async (req, res) => {
  try {
    const { url, cid, force, variant: existingVariant } = req.body || {};
    if (!url) return res.status(400).json({ active: false, error: "missing url" });

    const exp = await findActiveExperimentForUrl(url);
    if (!exp) return res.json({ active: false });

    // Determine variant (force → existing → new)
    const variant = (force === "A" || force === "B") ? force :
                   (existingVariant === "A" || existingVariant === "B") ? existingVariant :
                   assignVariant({ cid, id: exp.id, allocation_b: exp.allocation_b });

    return res.json({
      active: true,
      id: exp.id,
      baseline_url: exp.baseline_url,
      test_url: exp.test_url,
      allocation_b: exp.allocation_b,
      preserve_params: exp.preserve_params !== false,
      variant
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ active: false, error: "server_error" });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`exp resolver up on :${PORT}`));
