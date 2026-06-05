const crypto = require("crypto");
const express = require("express");
const { Pool } = require("pg");
const path = require("path");
const cookieParser = require("cookie-parser");

if (process.env.NODE_ENV !== "production" && process.env.NODE_ENV !== "test") {
  try {
    require("dotenv").config({ quiet: true });
  } catch {
    // dotenv is optional for local development.
  }
}

const VALID_STATUSES = new Set(["draft", "running", "paused", "stopped"]);
const VALID_ACCESS_ROLES = new Set(["owner", "manager", "viewer"]);
const EXPERIMENT_PATCH_FIELDS = new Set([
  "name",
  "baseline_url",
  "test_url",
  "allocation_b",
  "status",
  "start_at",
  "stop_at"
]);
const TEAM_MEMBER_PATCH_FIELDS = new Set(["role", "active"]);

const SESSION_COOKIE = "admin_session";
const OAUTH_STATE_COOKIE = "admin_oauth_state";
const OAUTH_RETURN_TO_COOKIE = "admin_oauth_return_to";
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || "development";
const IS_PRODUCTION = NODE_ENV === "production";
const ADMIN_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const config = {
  sessionSecret: process.env.SESSION_SECRET || (IS_PRODUCTION ? "" : "dev-session-secret"),
  databaseUrl: process.env.DATABASE_URL,
  allowedOrigins: (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
  dbSsl: parseBooleanEnv(process.env.DB_SSL, IS_PRODUCTION || /supabase\.(co|com)/.test(process.env.DATABASE_URL || "")),
  trustProxy: parseBooleanEnv(process.env.TRUST_PROXY, IS_PRODUCTION),
  googleClientId: process.env.GOOGLE_CLIENT_ID,
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
  googleRedirectUri: process.env.GOOGLE_REDIRECT_URI,
  adminAllowedEmails: parseEmailList(process.env.ADMIN_ALLOWED_EMAILS || "")
};

validateStartupConfig();

let pool = createPool(config);
let experiments = [];
let memoryAdminSessions = new Map();

const app = express();
if (config.trustProxy) {
  app.set("trust proxy", 1);
}
app.use(express.json({ limit: "32kb" }));
app.use(cookieParser(config.sessionSecret));

app.use(async (req, res, next) => {
  const origin = req.headers.origin;
  if (!origin) return next();

  if (config.allowedOrigins.includes(origin)) {
    setCorsHeaders(res, origin, "GET,POST,OPTIONS,PATCH,DELETE", true);
    if (req.method === "OPTIONS") return res.status(204).end();
    return next();
  }

  try {
    const originUrl = new URL(origin);
    const activeExperiments = await loadActiveExperiments();
    const matches = activeExperiments.some((exp) => matchesExperimentHost(originUrl, exp));

    if (matches) {
      setCorsHeaders(res, origin, "GET,POST,OPTIONS", false);
    }
  } catch (err) {
    console.warn("CORS origin check failed:", err.message);
  }

  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

app.get("/healthz", async (_req, res) => {
  const payload = {
    ok: true,
    storage: pool ? "postgres" : "memory"
  };

  if (!pool) return res.json(payload);

  try {
    await dbQuery("SELECT 1");
    return res.json({ ...payload, database: "ok" });
  } catch {
    return res.status(503).json({ ...payload, ok: false, database: "error" });
  }
});

app.get("/", async (req, res) => {
  try {
    if (await getActiveAdminSession(req)) return res.redirect("/admin");
    return redirectToLogin(req, res);
  } catch (err) {
    console.error("Root auth check failed:", err.message);
    return res.status(500).json({ error: "server_error" });
  }
});

app.get("/admin/login", (_req, res) => {
  res.sendFile(path.join(__dirname, "admin", "login.html"));
});

app.get("/admin/login/google", (req, res) => {
  if (!isGoogleOAuthConfigured(config)) {
    return renderAuthError(res, {
      status: 404,
      title: "Google OAuth is not configured",
      message: "Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, then restart the server."
    });
  }

  const state = crypto.randomBytes(32).toString("base64url");
  const redirectUri = getGoogleRedirectUri(req);
  const returnTo = getSafeReturnTo(req.query.return_to || req.query.next || "/admin");

  res.cookie(OAUTH_STATE_COOKIE, state, oauthStateCookieOptions());
  res.cookie(OAUTH_RETURN_TO_COOKIE, returnTo, oauthStateCookieOptions());
  res.redirect(buildGoogleAuthUrl({
    clientId: config.googleClientId,
    redirectUri,
    state
  }));
});

app.get("/admin/oauth/google/callback", async (req, res) => {
  if (!isGoogleOAuthConfigured(config)) {
    return renderAuthError(res, {
      status: 404,
      title: "Google OAuth is not configured",
      message: "Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, then restart the server."
    });
  }

  const { code, state, error } = req.query || {};
  const expectedState = req.signedCookies && req.signedCookies[OAUTH_STATE_COOKIE];
  const returnTo = getSafeReturnTo(req.signedCookies && req.signedCookies[OAUTH_RETURN_TO_COOKIE]);
  res.clearCookie(OAUTH_STATE_COOKIE, oauthStateCookieOptions({ maxAge: undefined }));
  res.clearCookie(OAUTH_RETURN_TO_COOKIE, oauthStateCookieOptions({ maxAge: undefined }));

  if (error) {
    return renderAuthError(res, {
      status: 401,
      title: "Google sign-in was cancelled",
      message: "You can return to the login page and try again.",
      returnTo
    });
  }

  if (!code || !state || !expectedState || !safeEqual(String(state), expectedState)) {
    return renderAuthError(res, {
      status: 400,
      title: "Invalid sign-in session",
      message: "The sign-in session expired or did not match. Please try again.",
      returnTo
    });
  }

  try {
    const redirectUri = getGoogleRedirectUri(req);
    const tokens = await exchangeGoogleCodeForTokens({ code: String(code), redirectUri });
    const profile = await fetchGoogleProfile(tokens.access_token);

    const adminUser = profile.email_verified ? await getAuthorizedTeamMember(profile.email) : null;

    if (!adminUser) {
      console.warn(`Rejected Google admin login for unauthorized email: ${profile.email}`);
      return renderAuthError(res, {
        status: 403,
        title: "This Google account is not allowed",
        message: `Signed in as ${profile.email}. Use an allowed Google account, or ask an owner to add this email as a team member.`,
        returnTo
      });
    }

    const adminSession = await createAdminSession(adminUser, req);
    res.cookie(SESSION_COOKIE, adminSession.token, adminCookieOptions());
    return res.redirect(returnTo);
  } catch (err) {
    console.error("Google OAuth callback failed:", err.message);
    return renderAuthError(res, {
      status: 502,
      title: "Google sign-in failed",
      message: "The server could not finish Google sign-in. Please try again.",
      returnTo
    });
  }
});

app.get("/admin/logout", async (req, res) => {
  await revokeCurrentAdminSession(req);
  res.clearCookie(SESSION_COOKIE, adminCookieOptions({ maxAge: undefined }));
  res.redirect("/");
});

app.get("/ab.js", (_req, res) => {
  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=3600, stale-while-revalidate=86400");
  res.setHeader("Vary", "Accept-Encoding");
  res.sendFile(path.join(__dirname, "public", "ab.js"));
});

const adminStatic = express.static(path.join(__dirname, "admin"));

app.post("/experiments", requireAdminRole("owner", "manager"), async (req, res) => {
  try {
    const input = validateExperimentPayload(req.body || {}, { partial: false });
    const created = await createExperiment(input);
    res.status(201).json(created);
  } catch (err) {
    sendError(res, err);
  }
});

app.get("/experiments", requireAdmin, async (_req, res) => {
  try {
    res.json(await listExperiments());
  } catch {
    res.status(500).json({ error: "server_error" });
  }
});

app.patch("/experiments/:id", requireAdminRole("owner", "manager"), async (req, res) => {
  try {
    const updates = validateExperimentPayload(req.body || {}, { partial: true });
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: "no_fields" });
    }

    const updated = await updateExperiment(req.params.id, updates);
    if (!updated) return res.status(404).json({ error: "not_found" });
    res.json(updated);
  } catch (err) {
    sendError(res, err);
  }
});

app.delete("/experiments/:id", requireAdminRole("owner", "manager"), async (req, res) => {
  try {
    await deleteExperiment(req.params.id);
    res.json({ ok: true });
  } catch {
    res.status(400).json({ error: "bad_request" });
  }
});

app.post("/experiments/:id/start", requireAdminRole("owner", "manager"), (req, res) => updateStatusRoute(req, res, "running"));
app.post("/experiments/:id/pause", requireAdminRole("owner", "manager"), (req, res) => updateStatusRoute(req, res, "paused"));
app.post("/experiments/:id/stop", requireAdminRole("owner", "manager"), (req, res) => updateStatusRoute(req, res, "stopped"));

app.get("/admin/me", requireAdmin, (req, res) => {
  res.json(req.adminUser);
});

app.get("/admin/team-members", requireAdminRole("owner"), async (_req, res) => {
  try {
    res.json(await listTeamMembers());
  } catch {
    res.status(500).json({ error: "server_error" });
  }
});

app.post("/admin/team-members", requireAdminRole("owner"), async (req, res) => {
  try {
    const input = validateTeamMemberPayload(req.body || {}, { partial: false });
    const created = await createTeamMember(input);
    res.status(201).json(created);
  } catch (err) {
    sendError(res, err);
  }
});

app.patch("/admin/team-members/:email", requireAdminRole("owner"), async (req, res) => {
  try {
    const email = normalizeEmail(req.params.email);
    const updates = validateTeamMemberPayload(req.body || {}, { partial: true });
    if (Object.keys(updates).length === 0) return res.status(400).json({ error: "no_fields" });
    if (email === req.adminUser.email && updates.active === false) {
      return res.status(400).json({ error: "cannot_deactivate_self" });
    }

    const updated = await updateTeamMember(email, updates);
    if (!updated) return res.status(404).json({ error: "not_found" });
    res.json(updated);
  } catch (err) {
    sendError(res, err);
  }
});

app.delete("/admin/team-members/:email", requireAdminRole("owner"), async (req, res) => {
  try {
    const email = normalizeEmail(req.params.email);
    if (email === req.adminUser.email) return res.status(400).json({ error: "cannot_delete_self" });
    await deleteTeamMember(email);
    res.json({ ok: true });
  } catch {
    res.status(400).json({ error: "bad_request" });
  }
});

app.use("/admin", async (req, res, next) => {
  if (req.path === "/login" || req.path === "/login.html" || req.path === "/style.css") {
    return adminStatic(req, res, next);
  }

  try {
    const adminUser = await getActiveAdminSession(req);
    if (adminUser) {
      req.adminUser = adminUser;
      return adminStatic(req, res, next);
    }

    res.clearCookie(SESSION_COOKIE, adminCookieOptions({ maxAge: undefined }));
    return redirectToLogin(req, res);
  } catch (err) {
    return next(err);
  }
});

app.post("/exp/resolve", async (req, res) => {
  try {
    const { url, cid, force, variant: existingVariant, experiment_id: existingExperimentId } = req.body || {};
    if (!url) return res.status(400).json({ active: false, error: "missing_url" });

    const exp = await findActiveExperimentForUrl(url);
    if (!exp) return res.json({ active: false });

    const canReuseVariant = existingExperimentId === exp.id && isVariant(existingVariant);
    const variant = isVariant(force)
      ? force
      : canReuseVariant
        ? existingVariant
        : assignVariant({ cid, id: exp.id, allocation_b: exp.allocation_b });

    return res.json({
      active: true,
      id: exp.id,
      baseline_url: exp.baseline_url,
      test_url: exp.test_url,
      allocation_b: exp.allocation_b,
      preserve_params: true,
      variant
    });
  } catch (err) {
    console.error("Resolve failed:", err.message);
    return res.status(500).json({ active: false, error: "server_error" });
  }
});

app.use((err, _req, res, _next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "server_error" });
});

if (require.main === module) {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running in ${NODE_ENV} mode`);
    console.log(`Listening on http://0.0.0.0:${PORT}`);
    console.log("Configuration:", {
      database: config.databaseUrl ? "configured" : "in-memory",
      dbSsl: config.dbSsl,
      trustProxy: config.trustProxy,
      allowedOrigins: config.allowedOrigins,
      googleOAuth: isGoogleOAuthConfigured(config)
    });
  });
}

function parseBooleanEnv(value, fallback) {
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function validateStartupConfig() {
  const missing = [];
  if (!config.sessionSecret) missing.push("SESSION_SECRET");
  if (IS_PRODUCTION && !config.databaseUrl) missing.push("DATABASE_URL");

  const hasGoogleOAuth = isGoogleOAuthConfigured(config);
  if (IS_PRODUCTION && !hasGoogleOAuth) {
    missing.push("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET");
  }

  if ((config.googleClientId || config.googleClientSecret) && !hasGoogleOAuth) {
    missing.push("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET");
  }

  if (missing.length > 0) {
    const message = `Missing required environment variables: ${missing.join(", ")}`;
    if (IS_PRODUCTION) throw new Error(message);
    console.warn(`${message}. Development fallbacks may be limited.`);
  }
}

function parseEmailList(value) {
  return value
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

function createPool(appConfig) {
  if (!appConfig.databaseUrl) {
    console.warn("DATABASE_URL not configured - using in-memory experiment storage");
    return null;
  }

  const dbConfig = {
    connectionString: appConfig.databaseUrl
  };

  if (appConfig.dbSsl) {
    dbConfig.ssl = { rejectUnauthorized: false };
  }

  const dbPool = new Pool(dbConfig);
  dbPool.on("error", (err) => {
    console.error("Unexpected database pool error:", err.message);
  });

  return dbPool;
}

function setCorsHeaders(res, origin, methods, credentials) {
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", methods);
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Vary", "Origin");
  if (credentials) res.setHeader("Access-Control-Allow-Credentials", "true");
}

function matchesExperimentHost(originUrl, exp) {
  try {
    const baselineHost = new URL(exp.baseline_url).hostname;
    const testHost = new URL(exp.test_url).hostname;
    return originUrl.hostname === baselineHost || originUrl.hostname === testHost;
  } catch {
    return false;
  }
}

function matchesSurface(urlStr, exp) {
  try {
    const current = new URL(urlStr);
    const baseline = new URL(exp.baseline_url);
    const test = new URL(exp.test_url);

    if (current.hostname !== baseline.hostname && current.hostname !== test.hostname) {
      return false;
    }

    const currentPath = normalizePath(current.pathname);
    return currentPath === normalizePath(baseline.pathname) || currentPath === normalizePath(test.pathname);
  } catch {
    return false;
  }
}

function normalizePath(pathname) {
  return pathname.replace(/\/$/, "") || "/";
}

async function dbQuery(text, params = []) {
  if (!pool) return { rows: [] };

  try {
    return await pool.query(text, params);
  } catch (err) {
    console.error("Database query error:", err.message);
    throw err;
  }
}

async function loadActiveExperiments() {
  if (!pool) {
    const now = Date.now();
    return experiments.filter((exp) => {
      const startsAt = exp.start_at ? new Date(exp.start_at).getTime() : null;
      const stopsAt = exp.stop_at ? new Date(exp.stop_at).getTime() : null;
      return exp.status === "running" && (!startsAt || startsAt <= now) && (!stopsAt || stopsAt >= now);
    });
  }

  const { rows } = await dbQuery(
    `SELECT id, name, baseline_url, test_url, allocation_b, status, start_at, stop_at
       FROM experiments
      WHERE status = 'running'
        AND (start_at IS NULL OR start_at <= NOW())
        AND (stop_at IS NULL OR stop_at >= NOW())`
  );
  return rows || [];
}

async function findActiveExperimentForUrl(urlStr) {
  const activeExperiments = await loadActiveExperiments();
  for (const exp of activeExperiments) {
    const normalized = normalizeExperiment(exp);
    if (matchesSurface(urlStr, normalized)) return normalized;
  }
  return null;
}

function normalizeExperiment(exp) {
  return {
    id: String(exp.id),
    name: exp.name,
    baseline_url: exp.baseline_url,
    test_url: exp.test_url,
    allocation_b: exp.allocation_b != null ? Number(exp.allocation_b) : 0.5,
    status: exp.status,
    preserve_params: true,
    start_at: exp.start_at,
    stop_at: exp.stop_at,
    created_at: exp.created_at
  };
}

async function requireAdmin(req, res, next) {
  try {
    const adminUser = await getActiveAdminSession(req);
    if (adminUser) {
      req.adminUser = adminUser;
      return next();
    }
  } catch (err) {
    return next(err);
  }

  res.clearCookie(SESSION_COOKIE, adminCookieOptions({ maxAge: undefined }));
  if ((req.headers.accept || "").includes("text/html")) return redirectToLogin(req, res);
  return res.status(401).json({ error: "unauthorized" });
}

function requireAdminRole(...allowedRoles) {
  return async (req, res, next) => {
    await requireAdmin(req, res, (err) => {
      if (err) return next(err);
      if (!req.adminUser) return;
      if (allowedRoles.includes(req.adminUser.role)) return next();
      return res.status(403).json({ error: "forbidden", detail: "This action requires a higher access role" });
    });
  };
}

async function getActiveAdminSession(req) {
  const sessionToken = getAdminSessionId(req);
  if (!sessionToken) return null;
  const sessionId = hashSessionToken(sessionToken);

  if (!pool) {
    const session = memoryAdminSessions.get(sessionId);
    if (!session || session.revokedAt || session.expiresAt <= Date.now()) return null;
    if (!isAllowedAdminEmail(session.email, config.adminAllowedEmails)) return null;
    session.lastSeenAt = Date.now();
    return { email: session.email, role: session.role, session_id: sessionId };
  }

  const { rows } = await dbQuery(
    `SELECT s.id AS session_id, u.email, u.role, u.active
       FROM access_sessions s
       JOIN team_members u ON u.email = s.email
      WHERE s.id = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > NOW()
        AND u.active = TRUE`,
    [sessionId]
  );

  const adminUser = rows[0] || null;
  if (!adminUser) return null;

  await dbQuery("UPDATE access_sessions SET last_seen_at = NOW() WHERE id = $1", [sessionId]);
  return adminUser;
}

function getAdminSessionId(req) {
  const value = req.signedCookies && req.signedCookies[SESSION_COOKIE];
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{32,}$/.test(value)) return "";
  return value;
}

async function createAdminSession(adminUser, req) {
  const token = crypto.randomBytes(32).toString("base64url");
  const session = {
    id: hashSessionToken(token),
    token,
    email: normalizeEmail(adminUser.email),
    role: adminUser.role,
    userAgent: req.headers && req.headers["user-agent"] ? String(req.headers["user-agent"]).slice(0, 512) : null,
    ipAddress: getRequestIp(req),
    expiresAt: new Date(Date.now() + ADMIN_SESSION_TTL_MS)
  };

  if (!pool) {
    memoryAdminSessions.set(session.id, {
      email: session.email,
      role: session.role,
      expiresAt: session.expiresAt.getTime(),
      revokedAt: null,
      lastSeenAt: Date.now()
    });
    return session;
  }

  const { rows } = await dbQuery(
    `INSERT INTO access_sessions (id, email, user_agent, ip_address, expires_at)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, email, created_at, expires_at`,
    [session.id, session.email, session.userAgent, session.ipAddress, session.expiresAt.toISOString()]
  );
  return { ...rows[0], token };
}

async function revokeCurrentAdminSession(req) {
  const sessionToken = getAdminSessionId(req);
  if (!sessionToken) return;
  const sessionId = hashSessionToken(sessionToken);

  if (!pool) {
    const session = memoryAdminSessions.get(sessionId);
    if (session) session.revokedAt = Date.now();
    return;
  }

  await dbQuery("UPDATE access_sessions SET revoked_at = NOW() WHERE id = $1", [sessionId]);
}

function hashSessionToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function getRequestIp(req) {
  const forwardedFor = firstHeaderValue(req.headers && req.headers["x-forwarded-for"]);
  return forwardedFor || req.ip || (req.socket && req.socket.remoteAddress) || null;
}

function adminCookieOptions(overrides = {}) {
  return {
    httpOnly: true,
    signed: true,
    sameSite: IS_PRODUCTION ? "strict" : "lax",
    secure: IS_PRODUCTION,
    path: "/",
    maxAge: ADMIN_SESSION_TTL_MS,
    ...overrides
  };
}

function oauthStateCookieOptions(overrides = {}) {
  return {
    httpOnly: true,
    signed: true,
    sameSite: "lax",
    secure: IS_PRODUCTION,
    path: "/admin",
    maxAge: 10 * 60 * 1000,
    ...overrides
  };
}

function redirectToGoogleLogin(req, res) {
  const returnTo = getSafeReturnTo(req.originalUrl || "/admin");
  const params = new URLSearchParams({ return_to: returnTo });
  return res.redirect(`/admin/login/google?${params.toString()}`);
}

function redirectToLogin(req, res) {
  const returnTo = getSafeReturnTo(req.originalUrl || "/admin");
  const params = new URLSearchParams({ return_to: returnTo });
  return res.redirect(`/admin/login?${params.toString()}`);
}

function renderAuthError(res, { status, title, message, returnTo = "/admin" }) {
  const safeReturnTo = getSafeReturnTo(returnTo);
  const loginHref = `/admin/login?${new URLSearchParams({ return_to: safeReturnTo }).toString()}`;

  return res.status(status).send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="/admin/style.css">
</head>
<body class="login">
  <main class="login-box auth-error">
    <h2>${escapeHtml(title)}</h2>
    <p>${escapeHtml(message)}</p>
    <a class="google-login" href="${escapeHtml(loginHref)}">Back to sign in</a>
  </main>
</body>
</html>`);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getSafeReturnTo(value) {
  if (typeof value !== "string" || value.trim() === "") return "/admin";

  try {
    const parsed = new URL(value, "http://local");
    if (parsed.origin !== "http://local") return "/admin";
    if (parsed.pathname === "/admin/login" || parsed.pathname === "/admin/login/google" || parsed.pathname === "/admin/oauth/google/callback") {
      return "/admin";
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}` || "/admin";
  } catch {
    return "/admin";
  }
}

function isGoogleOAuthConfigured(appConfig) {
  return Boolean(appConfig.googleClientId && appConfig.googleClientSecret);
}

function getGoogleRedirectUri(req) {
  if (config.googleRedirectUri) return config.googleRedirectUri;

  const proto = firstHeaderValue(req.headers["x-forwarded-proto"]) || req.protocol || "http";
  const host = firstHeaderValue(req.headers["x-forwarded-host"]) || req.headers.host;
  return `${proto}://${host}/admin/oauth/google/callback`;
}

function firstHeaderValue(value) {
  if (!value) return "";
  const raw = Array.isArray(value) ? value[0] : value;
  return String(raw).split(",")[0].trim();
}

function buildGoogleAuthUrl({ clientId, redirectUri, state }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state,
    prompt: "select_account"
  });

  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

async function exchangeGoogleCodeForTokens({ code, redirectUri }) {
  const body = new URLSearchParams({
    code,
    client_id: config.googleClientId,
    client_secret: config.googleClientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code"
  });

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) {
    throw new Error(payload.error_description || payload.error || "Token exchange failed");
  }

  return payload;
}

async function fetchGoogleProfile(accessToken) {
  const response = await fetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.email) {
    throw new Error(payload.error_description || payload.error || "Google profile fetch failed");
  }

  return {
    email: String(payload.email).toLowerCase(),
    email_verified: payload.email_verified === true || payload.email_verified === "true",
    name: payload.name,
    picture: payload.picture
  };
}

function isAllowedAdminEmail(email, allowedEmails) {
  if (typeof email !== "string") return false;
  return allowedEmails.includes(email.trim().toLowerCase());
}

function safeEqual(actual, expected) {
  if (typeof actual !== "string" || typeof expected !== "string") return false;
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

async function createExperiment(input) {
  if (!pool) {
    const created = { ...input, created_at: new Date().toISOString() };
    experiments.unshift(created);
    return created;
  }

  const { rows } = await dbQuery(
    `INSERT INTO experiments
      (id, name, baseline_url, test_url, allocation_b, status, start_at, stop_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING *`,
    [
      input.id,
      input.name,
      input.baseline_url,
      input.test_url,
      input.allocation_b,
      input.status,
      input.start_at,
      input.stop_at
    ]
  );
  return rows[0];
}

async function listExperiments() {
  if (!pool) return experiments;

  const { rows } = await dbQuery("SELECT * FROM experiments ORDER BY created_at DESC NULLS LAST, id");
  return rows;
}

async function updateExperiment(id, updates) {
  if (!pool) {
    const index = experiments.findIndex((exp) => exp.id === id);
    if (index === -1) return null;
    experiments[index] = { ...experiments[index], ...updates };
    return experiments[index];
  }

  const fields = [];
  const values = [];
  let idx = 1;

  for (const [key, value] of Object.entries(updates)) {
    fields.push(`${key} = $${idx++}`);
    values.push(value);
  }

  values.push(id);
  const { rows } = await dbQuery(
    `UPDATE experiments SET ${fields.join(", ")} WHERE id = $${idx} RETURNING *`,
    values
  );
  return rows[0] || null;
}

async function deleteExperiment(id) {
  if (!pool) {
    experiments = experiments.filter((exp) => exp.id !== id);
    return;
  }

  await dbQuery("DELETE FROM experiments WHERE id = $1", [id]);
}

async function getAuthorizedTeamMember(email) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return null;

  if (!pool) {
    return isAllowedAdminEmail(normalizedEmail, config.adminAllowedEmails)
      ? { email: normalizedEmail, role: "owner", active: true }
      : null;
  }

  await bootstrapTeamMembersIfEmpty();
  const { rows } = await dbQuery(
    `SELECT email, role, active, created_at, updated_at
       FROM team_members
      WHERE email = $1 AND active = TRUE`,
    [normalizedEmail]
  );
  return rows[0] || null;
}

async function bootstrapTeamMembersIfEmpty() {
  if (!pool || config.adminAllowedEmails.length === 0) return;

  const { rows } = await dbQuery("SELECT COUNT(*)::int AS count FROM team_members");
  if ((rows[0] && rows[0].count) > 0) return;

  for (const email of config.adminAllowedEmails) {
    await dbQuery(
      `INSERT INTO team_members (email, role, active)
       VALUES ($1, 'owner', TRUE)
       ON CONFLICT (email) DO NOTHING`,
      [email]
    );
  }
}

async function listTeamMembers() {
  if (!pool) {
    return config.adminAllowedEmails.map((email) => ({
      email,
      role: "owner",
      active: true
    }));
  }

  await bootstrapTeamMembersIfEmpty();
  const { rows } = await dbQuery(
    `SELECT email, role, active, created_at, updated_at
       FROM team_members
      ORDER BY active DESC, role DESC, email`
  );
  return rows;
}

async function createTeamMember(input) {
  if (!pool) {
    throw httpError(501, "database_required", "Admin user management requires DATABASE_URL");
  }

  const { rows } = await dbQuery(
    `INSERT INTO team_members (email, role, active)
     VALUES ($1, $2, $3)
     RETURNING email, role, active, created_at, updated_at`,
    [input.email, input.role, input.active]
  );
  return rows[0];
}

async function updateTeamMember(email, updates) {
  if (!pool) {
    throw httpError(501, "database_required", "Admin user management requires DATABASE_URL");
  }

  const fields = [];
  const values = [];
  let idx = 1;

  for (const [key, value] of Object.entries(updates)) {
    fields.push(`${key} = $${idx++}`);
    values.push(value);
  }

  values.push(email);
  const { rows } = await dbQuery(
    `UPDATE team_members SET ${fields.join(", ")} WHERE email = $${idx}
     RETURNING email, role, active, created_at, updated_at`,
    values
  );
  return rows[0] || null;
}

async function deleteTeamMember(email) {
  if (!pool) {
    throw httpError(501, "database_required", "Admin user management requires DATABASE_URL");
  }

  await dbQuery("DELETE FROM team_members WHERE email = $1", [email]);
}

async function updateStatusRoute(req, res, status) {
  try {
    const updated = await updateExperiment(req.params.id, { status });
    if (!updated) return res.status(404).json({ error: "not_found" });
    return res.json(updated);
  } catch {
    return res.status(400).json({ error: "bad_request" });
  }
}

function validateExperimentPayload(body, { partial }) {
  const result = {};
  const keys = Object.keys(body);

  for (const key of keys) {
    if (!EXPERIMENT_PATCH_FIELDS.has(key) && !(key === "id" && !partial)) {
      throw httpError(400, "invalid_field", `Unsupported field: ${key}`);
    }
  }

  if (!partial) {
    result.id = validateId(body.id || crypto.randomBytes(4).toString("hex"));
  } else if (body.id != null) {
    throw httpError(400, "invalid_field", "Experiment id cannot be changed");
  }

  if (body.name != null) result.name = validateRequiredString(body.name, "name", 160);
  if (body.baseline_url != null) result.baseline_url = validateUrl(body.baseline_url, "baseline_url");
  if (body.test_url != null) result.test_url = validateUrl(body.test_url, "test_url");
  if (body.allocation_b != null) result.allocation_b = validateAllocation(body.allocation_b);
  if (body.status != null) result.status = validateStatus(body.status);
  if (Object.prototype.hasOwnProperty.call(body, "start_at")) result.start_at = validateDateOrNull(body.start_at, "start_at");
  if (Object.prototype.hasOwnProperty.call(body, "stop_at")) result.stop_at = validateDateOrNull(body.stop_at, "stop_at");

  if (!partial) {
    for (const field of ["name", "baseline_url", "test_url"]) {
      if (!result[field]) throw httpError(400, "missing_field", `Missing required field: ${field}`);
    }
    if (result.allocation_b == null) result.allocation_b = 0.5;
    if (!result.status) result.status = "draft";
  }

  const startAt = result.start_at ? new Date(result.start_at).getTime() : null;
  const stopAt = result.stop_at ? new Date(result.stop_at).getTime() : null;
  if (startAt && stopAt && stopAt <= startAt) {
    throw httpError(400, "invalid_schedule", "stop_at must be after start_at");
  }

  return result;
}

function validateTeamMemberPayload(body, { partial }) {
  const result = {};
  const keys = Object.keys(body);

  for (const key of keys) {
    if (!TEAM_MEMBER_PATCH_FIELDS.has(key) && !(key === "email" && !partial)) {
      throw httpError(400, "invalid_field", `Unsupported field: ${key}`);
    }
  }

  if (!partial) {
    result.email = validateEmail(body.email);
  } else if (body.email != null) {
    throw httpError(400, "invalid_field", "Team member email cannot be changed");
  }

  if (body.role != null) result.role = validateAccessRole(body.role);
  if (Object.prototype.hasOwnProperty.call(body, "active")) result.active = validateBoolean(body.active, "active");

  if (!partial) {
    if (!result.role) result.role = "manager";
    if (result.active == null) result.active = true;
  }

  return result;
}

function validateEmail(value) {
  const email = normalizeEmail(value);
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw httpError(400, "invalid_email", "email must be a valid email address");
  }
  return email;
}

function normalizeEmail(value) {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase();
}

function validateAccessRole(value) {
  if (typeof value !== "string" || !VALID_ACCESS_ROLES.has(value)) {
    throw httpError(400, "invalid_role", "role must be owner, manager, or viewer");
  }
  return value;
}

function validateBoolean(value, field) {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  throw httpError(400, "invalid_field", `${field} must be a boolean`);
}

function validateId(value) {
  const id = validateRequiredString(value, "id", 80);
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw httpError(400, "invalid_id", "Experiment id may only contain letters, numbers, underscores, and hyphens");
  }
  return id;
}

function validateRequiredString(value, field, maxLength) {
  if (typeof value !== "string" || value.trim() === "") {
    throw httpError(400, "invalid_field", `${field} must be a non-empty string`);
  }

  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw httpError(400, "invalid_field", `${field} is too long`);
  }
  return trimmed;
}

function validateUrl(value, field) {
  const url = validateRequiredString(value, field, 2048);
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Invalid protocol");
    return parsed.toString();
  } catch {
    throw httpError(400, "invalid_url", `${field} must be a valid HTTP(S) URL`);
  }
}

function validateAllocation(value) {
  const allocation = Number(value);
  if (!Number.isFinite(allocation) || allocation < 0 || allocation > 1) {
    throw httpError(400, "invalid_allocation", "allocation_b must be between 0 and 1");
  }
  return allocation;
}

function validateStatus(value) {
  if (typeof value !== "string" || !VALID_STATUSES.has(value)) {
    throw httpError(400, "invalid_status", "status must be draft, running, paused, or stopped");
  }
  return value;
}

function validateDateOrNull(value, field) {
  if (value == null || value === "") return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw httpError(400, "invalid_date", `${field} must be a valid date`);
  }
  return date.toISOString();
}

function getRandomForSeed(seed) {
  const hash = crypto.createHash("sha256").update(seed).digest();
  let value = 0;
  for (let i = 0; i < 4; i += 1) value = (value << 8) | hash[i];
  return (value >>> 0) / 0xffffffff;
}

function assignVariant({ cid, id, allocation_b }) {
  const allocation = validateAllocation(allocation_b == null ? 0.5 : allocation_b);
  const identity = cid || crypto.randomUUID();
  const random = getRandomForSeed(`${identity}|${id}`);
  return random < allocation ? "B" : "A";
}

function isVariant(value) {
  return value === "A" || value === "B";
}

function httpError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

function sendError(res, err) {
  if (err.code === "23505") {
    return res.status(409).json({ error: "already_exists", detail: "A record with this id or email already exists" });
  }
  if (err.code === "23514") {
    return res.status(400).json({ error: "constraint_violation", detail: "The submitted data failed a database validation rule" });
  }
  const status = err.status || 400;
  res.status(status).json({ error: err.code || "bad_request", detail: err.message });
}

module.exports = {
  app,
  assignVariant,
  buildGoogleAuthUrl,
  getRandomForSeed,
  isAllowedAdminEmail,
  matchesSurface,
  parseEmailList,
  validateTeamMemberPayload,
  validateExperimentPayload,
  _internals: {
    adminCookieOptions,
    createAdminSession,
    getActiveAdminSession,
    getAdminSessionId,
    getGoogleRedirectUri,
    getSafeReturnTo,
    hashSessionToken,
    normalizeEmail,
    normalizePath,
    redirectToLogin,
    redirectToGoogleLogin,
    safeEqual,
    setPool(nextPool) {
      pool = nextPool;
    },
    setMemoryAdminSessions(nextSessions) {
      memoryAdminSessions = nextSessions;
    },
    setExperiments(nextExperiments) {
      experiments = nextExperiments;
    }
  }
};
