const assert = require("node:assert/strict");
const test = require("node:test");

process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-secret";

const {
  assignVariant,
  buildGoogleAuthUrl,
  matchesSurface,
  isAllowedAdminEmail,
  parseEmailList,
  parseOriginList,
  validateAllowedOriginPayload,
  validateTeamMemberPayload,
  validateExperimentPayload,
  _internals
} = require("../server");

const {
  adminCookieOptions,
  createAdminSession,
  getActiveAdminSession,
  getAdminSessionId,
  getGoogleRedirectUri,
  getSafeReturnTo,
  hashSessionToken,
  normalizeOrigin,
  setMemoryAdminSessions,
  setPool
} = _internals;

test("matchesSurface matches baseline and test URLs by host and path", () => {
  const exp = {
    baseline_url: "https://example.com/pricing/",
    test_url: "https://example.com/pricing-v2"
  };

  assert.equal(matchesSurface("https://example.com/pricing?utm=x", exp), true);
  assert.equal(matchesSurface("https://example.com/pricing-v2#plans", exp), true);
  assert.equal(matchesSurface("https://example.com/about", exp), false);
  assert.equal(matchesSurface("https://other.example.com/pricing", exp), false);
});

test("assignVariant is deterministic for the same client and experiment", () => {
  const first = assignVariant({ cid: "visitor-123", id: "exp-1", allocation_b: 0.5 });
  const second = assignVariant({ cid: "visitor-123", id: "exp-1", allocation_b: 0.5 });

  assert.equal(first, second);
});

test("assignVariant respects allocation boundaries", () => {
  assert.equal(assignVariant({ cid: "visitor-123", id: "exp-1", allocation_b: 0 }), "A");
  assert.equal(assignVariant({ cid: "visitor-123", id: "exp-1", allocation_b: 1 }), "B");
});

test("validateExperimentPayload normalizes a valid create payload", () => {
  const payload = validateExperimentPayload({
    id: "homepage_test",
    name: "Homepage Test",
    baseline_url: "https://example.com/",
    test_url: "https://example.com/new",
    allocation_b: "0.25",
    status: "draft",
    start_at: "",
    stop_at: ""
  }, { partial: false });

  assert.equal(payload.id, "homepage_test");
  assert.equal(payload.baseline_url, "https://example.com/");
  assert.equal(payload.test_url, "https://example.com/new");
  assert.equal(payload.allocation_b, 0.25);
  assert.equal(payload.start_at, null);
  assert.equal(payload.stop_at, null);
});

test("validateExperimentPayload rejects unsupported update fields", () => {
  assert.throws(() => {
    validateExperimentPayload({
      status: "running",
      arbitrary_sql: "nope"
    }, { partial: true });
  }, /Unsupported field/);
});

test("validateExperimentPayload rejects invalid schedule order", () => {
  assert.throws(() => {
    validateExperimentPayload({
      start_at: "2026-01-02T00:00:00.000Z",
      stop_at: "2026-01-01T00:00:00.000Z"
    }, { partial: true });
  }, /stop_at must be after start_at/);
});

test("parseEmailList normalizes admin email allowlist", () => {
  assert.deepEqual(parseEmailList(" Alice@Example.com, bob@example.com ,, "), [
    "alice@example.com",
    "bob@example.com"
  ]);
});

test("isAllowedAdminEmail checks normalized email membership", () => {
  const allowlist = ["alice@example.com"];

  assert.equal(isAllowedAdminEmail("ALICE@example.com", allowlist), true);
  assert.equal(isAllowedAdminEmail("bob@example.com", allowlist), false);
});

test("parseOriginList normalizes resolver origins", () => {
  assert.deepEqual(parseOriginList(" https://Example.com/path, http://localhost:3000/admin ,, "), [
    "https://example.com",
    "http://localhost:3000"
  ]);
});

test("validateAllowedOriginPayload normalizes create payload", () => {
  const payload = validateAllowedOriginPayload({
    origin: "https://Example.com/pricing?x=1",
    active: "false"
  }, { partial: false });

  assert.deepEqual(payload, {
    origin: "https://example.com",
    active: false
  });
});

test("normalizeOrigin rejects non-http origins", () => {
  assert.equal(normalizeOrigin("ftp://example.com"), "");
  assert.equal(normalizeOrigin("https://user:pass@example.com"), "");
});

test("buildGoogleAuthUrl includes required OAuth parameters", () => {
  const url = new URL(buildGoogleAuthUrl({
    clientId: "client-123",
    redirectUri: "https://resolver.example.com/admin/oauth/google/callback",
    state: "state-123"
  }));

  assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(url.searchParams.get("client_id"), "client-123");
  assert.equal(url.searchParams.get("redirect_uri"), "https://resolver.example.com/admin/oauth/google/callback");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("scope"), "openid email profile");
  assert.equal(url.searchParams.get("state"), "state-123");
});

test("getGoogleRedirectUri honors forwarded proxy headers", () => {
  const redirectUri = getGoogleRedirectUri({
    headers: {
      "x-forwarded-proto": "https, http",
      "x-forwarded-host": "resolver.example.com, internal.local"
    },
    protocol: "http"
  });

  assert.equal(redirectUri, "https://resolver.example.com/admin/oauth/google/callback");
});

test("getSafeReturnTo keeps local paths and rejects external URLs", () => {
  assert.equal(getSafeReturnTo("/admin?tab=running#top"), "/admin?tab=running#top");
  assert.equal(getSafeReturnTo("https://evil.example/admin"), "/admin");
  assert.equal(getSafeReturnTo("/admin/login/google"), "/admin");
});

test("root redirects unauthenticated users to login with return path", async () => {
  const { redirectToLogin } = _internals;
  const res = {
    statusCode: 200,
    redirect(location) {
      this.statusCode = 302;
      this.location = location;
    }
  };

  redirectToLogin({ originalUrl: "/" }, res);

  assert.equal(res.statusCode, 302);
  assert.equal(res.location, "/admin/login?return_to=%2F");
});

test("validateTeamMemberPayload normalizes create payload", () => {
  const payload = validateTeamMemberPayload({
    email: " Alice@Example.com ",
    role: "owner",
    active: "true"
  }, { partial: false });

  assert.deepEqual(payload, {
    email: "alice@example.com",
    role: "owner",
    active: true
  });
});

test("validateTeamMemberPayload rejects invalid roles", () => {
  assert.throws(() => {
    validateTeamMemberPayload({ role: "superuser" }, { partial: true });
  }, /role must be owner, manager, or viewer/);
});

test("admin session cookie stores only an opaque token", async () => {
  setMemoryAdminSessions(new Map());
  const session = await createAdminSession({ email: "Alice@Example.com", role: "manager" }, {
    headers: { "user-agent": "test-agent" },
    ip: "127.0.0.1"
  });
  const sessionToken = getAdminSessionId({
    signedCookies: {
      admin_session: session.token
    }
  });

  assert.equal(sessionToken, session.token);
  assert.notEqual(session.id, session.token);
  assert.equal(session.id, hashSessionToken(session.token));
  assert.equal(session.token.includes("alice"), false);
  assert.equal(session.token.includes("@"), false);
  setMemoryAdminSessions(new Map());
});

test("admin cookie lasts 30 days", () => {
  assert.equal(adminCookieOptions().maxAge, 30 * 24 * 60 * 60 * 1000);
});

test("active admin session is rechecked against database", async () => {
  const sessionToken = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKL";
  const sessionId = hashSessionToken(sessionToken);
  const queries = [];
  setPool({
    async query(text, params) {
      queries.push({ text, params });
      if (String(text).startsWith("UPDATE")) return { rows: [] };
      return { rows: [{ session_id: sessionId, email: "alice@example.com", role: "owner", active: true }] };
    }
  });

  try {
    const session = await getActiveAdminSession({
      signedCookies: {
        admin_session: sessionToken
      }
    });

    assert.deepEqual(session, { session_id: sessionId, email: "alice@example.com", role: "owner", active: true });
    assert.deepEqual(queries[0].params, [sessionId]);
  } finally {
    setPool(null);
  }
});
