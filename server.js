// server.js
// Minimal /exp/resolve service for URL-vs-URL A/B tests
// Deploy on Render (Node >= 18). CommonJS, no build step.

const express = require("express");
const crypto  = require("crypto");

const app = express();
app.use(express.json());

// --- CORS (allow your site to call this endpoint from the browser) ---
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  // If you set ALLOWED_ORIGINS, echo back only if it's allowed; otherwise allow all (MVP/dev).
  const allowAll = ALLOWED_ORIGINS.length === 0;
  if (allowAll) {
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

// --- TEMP in-memory experiment store (Phase 2: move to Postgres) ---
// Use baseline_url and test_url as the source of truth for matching.
let experiments = [
  {
    id: "exp_lp_001",
    name: "Landing Page A/B (baseline vs test)",
    // domain/path_pattern kept only for reference; matching uses baseline_url/test_url
    domain: "opsotools.com",
    path_pattern: "/landing-pages/lp1",
    baseline_url: "https://opsotools.com/landing-pages/lp1",
    test_url:     "https://opsotools.com/landing-pages/lp2/",
    allocation_b: 0.5,                  // traffic share to test (B)
    status: "running",                  // draft | running | paused | stopped
    preserve_params: true,              // keep GCLID/UTMs/hash on redirect
    start_at: null,                     // ISO string or null
    stop_at:  null
  }
];

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
app.get('/exp/resolve.js', (req, res) => {
  try {
    const pageUrl = req.query.url || req.get('referer') || '';
    const now = new Date();

    const exp = experiments.find(e =>
      e.status === 'running' &&
      (!e.start_at || new Date(e.start_at) <= now) &&
      (!e.stop_at  || new Date(e.stop_at)  >= now) &&
      (pageUrl ? matchesSurface(pageUrl, e) : true)
    );

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
app.post("/exp/resolve", (req, res) => {
  try {
    const { url, cid, force } = req.body || {};
    if (!url) return res.status(400).json({ active: false, error: "missing url" });

    const now = new Date();
    const exp = experiments.find(e =>
      e.status === "running" &&
      (!e.start_at || new Date(e.start_at) <= now) &&
      (!e.stop_at  || new Date(e.stop_at)  >= now) &&
      matchesSurface(url, e)
    );

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
