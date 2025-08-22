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
// Replace the placeholder domain/paths with your real ones.
let experiments = [
  {
    id: "exp_lp_001",
    name: "Landing Page A/B (baseline vs test)",
    domain: "opsotools.com",         // e.g., "example.com" (no protocol)
    path_pattern: "/landing-pages/lp1",     // exact path of the baseline page, e.g., "/landing-1"
    baseline_url: "https://opsotools.com/landing-pages/lp1",
    test_url:     "https://opsotools.com/landing-pages/lp2/",
    allocation_b: 0.5,                  // traffic to test (B)
    status: "running",                  // draft | running | paused | stopped
    preserve_params: true,              // keep GCLID/UTMs/hash on redirect
    start_at: null,                     // ISO string or null
    stop_at:  null
  }
];

// Exact matcher for MVP (domain + exact path)
function matchesSurface(urlStr, exp) {
  const u = new URL(urlStr);
  if (u.hostname !== exp.domain) return false;
  const clean = (p) => p.replace(/\/$/, "");
  return clean(u.pathname) === clean(exp.path_pattern);
}

// Deterministic assignment based on cid (GA client hint) + experiment id
function assignVariant({ cid, id, allocation_b }) {
  const seed = (cid || crypto.randomUUID()) + id;
  const h = crypto.createHash("sha256").update(seed).digest();
  const r = h[0] / 255; // 0..1
  return r < (allocation_b ?? 0.5) ? "B" : "A";
}

// Health check
app.get("/healthz", (_, res) => res.json({ ok: true }));

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
