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
  
  // If ALLOWED_ORIGINS is empty or if the origin matches an experiment URL, allow it
  const isAllowedOrigin = async () => {
    // If no ALLOWED_ORIGINS set, allow all in dev mode
    if (ALLOWED_ORIGINS.length === 0) return true;
    
    // Check if origin is in ALLOWED_ORIGINS
    if (origin && ALLOWED_ORIGINS.includes(origin)) return true;
    
    // Check if origin matches any active experiment URLs
    if (origin) {
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
    }
    return false;
  };

  // Set CORS headers based on origin check
  isAllowedOrigin().then(allowed => {
    if (allowed) {
      res.setHeader("Access-Control-Allow-Origin", origin || "*");
      if (origin) res.setHeader("Vary", "Origin");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") return res.status(204).end();
    next();
  }).catch(() => next());
});

// --- Experiments storage ---
// Primary: Postgres (via DATABASE_URL). Fallback: in-memory array (empty by default).
// Manage experiments via the API below; do not hardcode here.
let experiments = [];

// Treat BOTH baseline and test URLs as part of the experiment surface
function matchesSurface(urlStr, exp) {
  const u = new URL(urlStr);
  const base = new URL(exp.baseline_url);
  const test = new URL(exp.test_url);

  // host must match either baseline or test host
  if (u.hostname !== base.hostname && u.hostname !== test.hostname) return false;

  const clean = (p) => p.replace(/\/$/, "");
  const uPath    = clean(u.pathname);
  const basePath = clean(base.pathname);
  const testPath = clean(test.pathname);

  return uPath === basePath || uPath === testPath;
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

// Deterministic assignment based on cid (GA client hint) + experiment id
function assignVariant({ cid, id, allocation_b }) {
  const seed = (cid || crypto.randomUUID()) + id;
  const hash = crypto.createHash("sha256").update(seed).digest();
  // Use first 4 bytes as an unsigned 32-bit integer for a uniform 0..1 float
  const n = (hash[0] << 24) | (hash[1] << 16) | (hash[2] << 8) | hash[3];
  // Convert to unsigned and normalize
  const u32 = (n >>> 0); // 0..4294967295
  const r = u32 / 4294967296; // 0..~1
  return r < (allocation_b == null ? 0.5 : allocation_b) ? "B" : "A";
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
    const ip = (req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.ip || '').toString();
    const ua = (req.headers['user-agent'] || '').toString();
    const seed = ip + '|' + ua + '|' + exp.id;
    const hash = crypto.createHash('sha256').update(seed).digest();
    const n = (hash[0] << 24) | (hash[1] << 16) | (hash[2] << 8) | hash[3];
    const u32 = (n >>> 0);
    const r = u32 / 4294967296; // 0..1
    return r < (exp.allocation_b == null ? 0.5 : exp.allocation_b) ? 'B' : 'A';
  } catch {
    return 'A';
  }
}

// --- Blocking JS endpoint (VWO-style)
// Emits minimal JS that: (1) sets sticky cookie, (2) redirects baseline→test if B,
// (3) pushes exp_exposure to dataLayer, (4) unhides the page (removes ab-hide)
app.get('/exp/resolve.js', async (req, res) => {
  try {
    const pageUrl = req.query.url || req.get('referer') || '';
    const exp = pageUrl ? await findActiveExperimentForUrl(pageUrl) : null;

    res.set('Content-Type', 'application/javascript');
    res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');

    if (!exp) {
      return res.send("try{document.documentElement.classList.remove('ab-hide');}catch(e){}");
    }

    // Server-side deterministic assignment (IP+UA) unless client forces A/B via query
    const force = (req.query.force === 'A' || req.query.force === 'B') ? req.query.force : null;
    const sv = force || assignVariantFromRequest(req, exp);

    // Minified JS payload executed in the page
    const js =
      "!function(){try{var i='"+jsString(exp.id)+"',b=new URL('"+jsString(exp.baseline_url)+"'),t=new URL('"+jsString(exp.test_url)+"'),h=new URL(location.href)," +
      "C=function(n,v,d){var x=new Date;x.setTime(x.getTime()+864e5*d),document.cookie=n+'='+v+'; Path=/; Expires='+x.toUTCString()+'; SameSite=Lax'}," +
      "S=function(u){u.pathname=u.pathname.replace(/\\\\$/,'');return u}," +
      "P=function(a,b){a=S(new URL(a)),b=S(new URL(b));return a.origin===b.origin&&a.pathname===b.pathname};" +
      // QA override via URL (?__exp=forceA|forceB)
      "var fm=location.search.match(/__exp=(forceA|forceB)/),F=fm?fm[1].slice(-1):'',ck='expvar_'+i,m=document.cookie.match(new RegExp('(?:^|; )'+ck+'=(A|B)')),v=m?m[1]:null;" +
      "v=(F==='A'||F==='B')?F:(v||'"+jsString(sv)+"');C(ck,v,90);" +
      // redirect if needed
      "if(P(h,b)&&v==='B'){t.search||(t.search=h.search),t.hash||(t.hash=h.hash);if(t.toString()!==h.toString()){location.replace(t.toString());return}}" +
      // exposure → dataLayer
      "window.dataLayer=window.dataLayer||[];window.dataLayer.push({event:'exp_exposure',experiment_id:i,variant_id:v});" +
      "}catch(e){}try{document.documentElement.classList.remove('ab-hide')}catch(e){}}();";

    return res.send(js);
  } catch (e) {
    res.set('Content-Type', 'application/javascript');
    return res.send("try{document.documentElement.classList.remove('ab-hide');}catch(e){}");
  }
});

// /exp/resolve: A request is considered active if it is on either the baseline or test URL of any running experiment.
// Main resolver
app.post("/exp/resolve", async (req, res) => {
  try {
    const { url, cid, force } = req.body || {};
    if (!url) return res.status(400).json({ active: false, error: "missing url" });

    const exp = await findActiveExperimentForUrl(url);

    if (!exp) return res.json({ active: false });

    // Optional QA override (force A/B)
    let variant = (force === "A" || force === "B")
      ? force
      : assignVariant({ cid, id: exp.id, allocation_b: exp.allocation_b });

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
