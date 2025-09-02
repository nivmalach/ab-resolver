// server.js
const express = require("express");
const crypto  = require("crypto");
const { Pool } = require('pg');
const path = require("path");
const cookieParser = require("cookie-parser");
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || ""; // set on Render
const SESSION_SECRET = process.env.SESSION_SECRET || ADMIN_TOKEN || "change-me";
const DATABASE_URL = process.env.DATABASE_URL || null;
let pool = null;
if (DATABASE_URL) {
  pool = new Pool({ connectionString: DATABASE_URL });
  pool.on('error', (err) => {
    console.error('Unexpected error on idle client', err);
    // Don't exit the process, just log the error
  });
  // Test database connection
  pool.query('SELECT NOW()', (err) => {
    if (err) {
      console.error('Error connecting to the database:', err);
      // Don't exit the process, just log the error
      pool = null; // Disable database operations
    } else {
      console.log('Successfully connected to the database');
    }
  });
} else {
  console.warn('No DATABASE_URL provided - running without database');
}

const app = express();
app.use(express.json());
app.use(cookieParser(SESSION_SECRET));

// --- CORS configuration ---
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

if (ALLOWED_ORIGINS.length === 0) {
  console.warn('No ALLOWED_ORIGINS configured - CORS will be disabled');
}

app.use(async (req, res, next) => {
  const origin = req.headers.origin;
  if (!origin) return next();

  // In production, strictly check against allowed origins
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS,PATCH,DELETE");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");
    
    if (req.method === "OPTIONS") {
      return res.status(204).end();
    }
    return next();
  }

  // Also allow origins that match experiment URLs
  try {
    const originUrl = new URL(origin);
    const experiments = await loadActiveExperimentsFromDB();
    const matches = experiments.some(exp => {
      try {
        const baselineHost = new URL(exp.baseline_url).hostname;
        const testHost = new URL(exp.test_url).hostname;
        return originUrl.hostname === baselineHost || originUrl.hostname === testHost;
      } catch (e) {
        return false;
      }
    });

    if (matches) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.setHeader("Vary", "Origin");
    }
  } catch (e) {
    console.error('Error checking experiment origins:', e);
  }

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  next();
});

// --- Experiments storage ---
let experiments = [];

// Check if URL matches experiment surface
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
async function dbQuery(text, params) {
  if (!pool) {
    console.warn('Database query attempted but no database connection available');
    return { rows: [] };
  }
  
  let client;
  try {
    client = await pool.connect();
    const result = await client.query(text, params);
    return result;
  } catch (err) {
    console.error('Database query error:', err.message);
    console.error('Query:', text);
    console.error('Parameters:', params);
    throw err;
  } finally {
    if (client) client.release();
  }
}

async function loadActiveExperimentsFromDB(){
  if (!pool) return [];
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
  const list = pool ? await loadActiveExperimentsFromDB() : experiments;
  for (const e of list){
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

// --- Admin routes ---
app.get('/admin/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin', 'login.html'));
});

app.post('/admin/login', express.urlencoded({ extended: true }), (req, res) => {
  console.log('Login attempt received');
  
  const { username, password } = req.body;
  if (!username || !password) {
    console.warn('Login attempt with missing credentials');
    return res.status(400).json({ error: 'missing_credentials' });
  }

  const ADMIN_USER = process.env.ADMIN_USER;
  const ADMIN_PASS = process.env.ADMIN_PASS;
  
  if (!ADMIN_USER || !ADMIN_PASS) {
    console.error('Admin credentials not configured in environment');
    return res.status(500).json({ error: 'server_configuration_error' });
  }

  console.log('Validating credentials for user:', username);
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    console.log('Login successful for user:', username);
    
    // Set cookie with appropriate security settings for production
    const cookieOptions = {
      httpOnly: true,
      signed: true,
      sameSite: process.env.NODE_ENV === 'production' ? 'strict' : 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: 24 * 60 * 60 * 1000 // 24 hours
    };
    
    try {
      res.cookie('admin_session', 'yes', cookieOptions);
      console.log('Session cookie set successfully');
      return res.redirect('/admin');
    } catch (err) {
      console.error('Error setting session cookie:', err);
      return res.status(500).json({ error: 'session_error' });
    }
  }

  console.warn('Invalid login attempt for user:', username);
  res.status(401).json({ error: 'invalid_credentials' });
});

app.get('/admin/logout', (req, res) => {
  res.clearCookie('admin_session');
  res.redirect('/admin/login');
});

// Serve AB testing script
app.get('/ab.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
  res.setHeader('Vary', 'Accept-Encoding');
  res.sendFile(path.join(__dirname, 'public/ab.js'));
});

// Serve admin static files first
const adminStatic = express.static(path.join(__dirname, 'admin'));
app.use('/admin', (req, res, next) => {
  // Always allow access to login page and its assets
  if (req.path === '/login' || req.path === '/login.html' || req.path.startsWith('/style.css') || req.path.startsWith('/admin.js')) {
    return adminStatic(req, res, next);
  }
  
  // Check auth for other admin routes
  if (req.signedCookies && req.signedCookies.admin_session === 'yes') {
    return adminStatic(req, res, (err) => {
      if (err) {
        console.error('Error serving admin static files:', err);
        return res.status(500).send('Error loading admin interface');
      }
      next();
    });
  }
  
  // Redirect to login for unauthorized requests
  return res.redirect('/admin/login');
});

function requireAdmin(req, res, next){
  const hasCookie = req.signedCookies && req.signedCookies.admin_session === 'yes';
  if (hasCookie) return next();
  if ((req.headers.accept || '').includes('text/html')) return res.redirect('/admin/login');
  return res.status(401).json({ error: 'unauthorized' });
}

// --- Experiments CRUD API ---
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

app.get('/experiments', requireAdmin, async (_req, res) => {
  try {
    if (!pool) return res.json(experiments);
    const { rows } = await dbQuery(`SELECT * FROM experiments ORDER BY created_at DESC NULLS LAST, id`, []);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'server_error' }); }
});

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

// Variant assignment with consistent distribution
function getRandomForSeed(seed) {
  // Use full 32 bytes of hash for better distribution
  const hash = crypto.createHash('sha256').update(seed).digest();
  let value = 0;
  
  // Combine multiple bytes for better randomness
  for (let i = 0; i < 4; i++) {
    value = (value << 8) | hash[i];
  }
  
  // Convert to 0-1 range
  return (value >>> 0) / 0xFFFFFFFF;
}

function assignVariant({ cid, id, allocation_b }) {
  const allocation = allocation_b == null ? 0.5 : Number(allocation_b);
  
  // Use multiple factors for better distribution
  const timestamp = Math.floor(Date.now() / (30 * 60 * 1000)); // 30-minute buckets
  const seed = `${cid || crypto.randomUUID()}|${id}|${timestamp}`;
  const random = getRandomForSeed(seed);
  
  return random < allocation ? "B" : "A";
}

// Health check
app.get("/healthz", (_, res) => res.json({ ok: true }));

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

const PORT = process.env.PORT || 3000;
// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'server_error' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running in ${process.env.NODE_ENV || 'development'} mode`);
  console.log(`Listening on http://0.0.0.0:${PORT}`);
});