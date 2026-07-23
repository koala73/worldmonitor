// @vitest-environment node

/**
 * #4611 — cancelled / downgraded customers must NOT keep programmatic API
 * access via an un-revoked `wm_` key.
 *
 * The pre-existing `apiAccess` gate only fired on PREMIUM_RPC_PATHS, so an
 * expired key still served the whole keyed RPC surface (the API Starter product
 * leaked past churn). These tests assert the generalized gate added at
 * server/gateway.ts, scoped to `isUserApiKey` (the wm_ key is the authenticating
 * credential), which is the actual paid surface:
 *   - regular non-tier-gated keyed RPC and PREMIUM_RPC_PATHS: a wm_ key whose
 *     owner lacks ACTIVE apiAccess (downgraded or past validUntil) → 403,
 *     BEFORE the #3199 rate-limit block; active keys unaffected.
 *   - transient/unresolvable entitlement (getEntitlements null) → retryable
 *     fail-closed 503, so a verification timeout cannot grant paid access.
 *   - PUBLIC_NO_AUTH_RPC_PATHS serve free data to everyone: the wm_ key is NOT
 *     re-validated there (no unauthenticated Convex-lookup amplification, no
 *     gating the anonymous lead forms) — served as anonymous.
 *   - enterprise operator keys (kind 'enterprise') are exempt.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

// --- Stub the per-account rate-limit module (never reached for an expired key,
//     but keep real Redis out of the picture for the allowed-key paths). ------
const checkBurst = vi.fn();
const reserveDailyMeter = vi.fn();
vi.mock("../_shared/api-key-rate-limit", () => ({
  checkBurst: (...a: unknown[]) => checkBurst(...a),
  reserveDailyMeter: (...a: unknown[]) => reserveDailyMeter(...a),
  rateLimitHeaders: () => ({ "X-RateLimit-Limit": "60", "Retry-After": "30" }),
  ENTERPRISE_API_RATE_LIMIT: 1000,
  CEILING_MULTIPLIER: 10,
}));

// --- Stub the per-IP layer: spy whether checkRateLimit runs. -----------------
const checkRateLimit = vi.fn().mockResolvedValue(null);
vi.mock("../_shared/rate-limit", async (importActual) => {
  const actual = await importActual<typeof import("../_shared/rate-limit")>();
  return {
    ...actual,
    checkRateLimit: (...a: unknown[]) => checkRateLimit(...a),
    checkEndpointRateLimit: vi.fn().mockResolvedValue(null),
    hasEndpointRatePolicy: () => false,
  };
});

// --- Stub entitlement resolution. getEntitlements returns whatever the
//     current test sets. getRequiredTier defaults to null so most routes stay
//     non-tier-gated; individual tests can opt into ENDPOINT_ENTITLEMENTS. -----
const ACTIVE = {
  planKey: "api_starter",
  features: {
    tier: 2,
    apiAccess: true,
    apiRateLimit: 60,
    apiDailyAllowance: 1000,
    maxDashboards: 25,
    prioritySupport: false,
    exportFormats: ["csv"],
    mcpAccess: true,
  },
  validUntil: Date.now() + 86_400_000,
};
type Ent = {
  planKey: string;
  features: Record<string, unknown>;
  validUntil: number;
  billingStatus?: "subscription_lapsed" | "renewal_verification_pending" | "renewal_verification_failed";
  retryAfterSeconds?: number;
} | null;
let entitlement: Ent = ACTIVE;
const requiredTiers = new Map<string, number>();
const entitlementsByUser = new Map<string, Ent>();
const getEntitlements = vi.fn(async (userId: string) => entitlementsByUser.get(userId) ?? entitlement);
let entitlementBackendConfigured = true;
const checkEntitlementDetailedMock = vi.fn(
  async (): Promise<{ response: Response | null; entitlements: unknown }> =>
    ({ response: null, entitlements: null }),
);
vi.mock("../_shared/entitlement-check", async (importActual) => {
  const actual = await importActual<typeof import("../_shared/entitlement-check")>();
  return {
    ...actual,
    getRequiredTier: (pathname: string) => requiredTiers.get(pathname) ?? null,
    checkEntitlement: vi.fn().mockResolvedValue(null),
    checkEntitlementDetailed: (...a: unknown[]) => checkEntitlementDetailedMock(...(a as [])),
    getEntitlements: (...a: unknown[]) => getEntitlements(...a),
    isEntitlementBackendConfigured: () => entitlementBackendConfigured,
  };
});

// --- Stub user-key validation: a valid wm_ key resolves to a userId. ---------
const validateUserApiKey = vi.fn(async () => ({ userId: "acct_lapsed", keyId: "k1", name: "t" }));
vi.mock("../_shared/user-api-key", () => ({
  validateUserApiKey: (...a: unknown[]) => validateUserApiKey(...a),
}));

// --- Stub Clerk session resolution for mixed bearer + wm_ requests. ----------
type MockClerkSession = { userId: string; orgId: string | null } | null;
let clerkSession: MockClerkSession = null;
const resolveClerkSession = vi.fn(async () => clerkSession);
const validateBearerToken = vi.fn(async () => ({
  valid: true,
  userId: "acct_lapsed",
  role: "free" as const,
}));
vi.mock("../_shared/auth-session", () => ({
  resolveClerkSession: (...a: unknown[]) => resolveClerkSession(...a),
  validateBearerToken: (...a: unknown[]) => validateBearerToken(...a),
}));
vi.mock("../auth-session", () => ({
  validateBearerToken: (...a: unknown[]) => validateBearerToken(...a),
}));

import { createDomainGateway } from "../gateway";

const REGULAR_PATH = "/api/news/v1/list-feed-digest";
const PUBLIC_NO_AUTH_PATH = "/api/conflict/v1/list-acled-events"; // in PUBLIC_NO_AUTH_RPC_PATHS
const PREMIUM_PATH = "/api/market/v1/analyze-stock"; // in PREMIUM_RPC_PATHS

function ok() {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function makeGateway() {
  return createDomainGateway([
    { method: "GET", path: REGULAR_PATH, handler: async () => ok() },
    { method: "GET", path: PUBLIC_NO_AUTH_PATH, handler: async () => ok() },
    { method: "POST", path: PREMIUM_PATH, handler: async () => ok() },
  ]);
}

function keyReq(
  path: string,
  method = "GET",
  key = "wm_lapsed_customer_key",
  extraHeaders: Record<string, string> = {},
) {
  const headers = new Headers(extraHeaders);
  headers.set("X-Api-Key", key);
  return new Request(`https://www.worldmonitor.app${path}`, { method, headers });
}

const ctx = { waitUntil: () => {} };
const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  entitlement = ACTIVE;
  requiredTiers.clear();
  entitlementsByUser.clear();
  clerkSession = null;
  checkBurst.mockReset().mockResolvedValue({ ok: true });
  reserveDailyMeter.mockReset().mockResolvedValue({
    count: 1, overCeiling: false, metered: true, retryAfterSec: 100, rollback: async () => {},
  });
  checkRateLimit.mockClear().mockResolvedValue(null);
  getEntitlements.mockClear();
  resolveClerkSession.mockClear();
  validateBearerToken.mockClear();
  entitlementBackendConfigured = true;
  checkEntitlementDetailedMock.mockReset().mockResolvedValue({ response: null, entitlements: null });
  validateUserApiKey.mockClear().mockResolvedValue({ userId: "acct_lapsed", keyId: "k1", name: "t" });
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.WORLDMONITOR_VALID_KEYS;
});

afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in ORIGINAL_ENV)) delete process.env[k];
  Object.assign(process.env, ORIGINAL_ENV);
});

describe("#4611 — expired wm_ key rejected on all route classes", () => {
  // --- apiAccess:false (downgraded) → 403 everywhere ------------------------
  const DOWNGRADED: Ent = { planKey: "pro", features: { tier: 1, apiAccess: false, apiRateLimit: 0 }, validUntil: Date.now() + 86_400_000 };

  test("regular RPC: downgraded key → 403, rejected before the rate-limit block", async () => {
    entitlement = DOWNGRADED;
    const res = await makeGateway()(keyReq(REGULAR_PATH), ctx);
    expect(res.status).toBe(403);
    // Gate runs before #3199 — neither the per-account nor per-IP limiter fires.
    expect(checkBurst).not.toHaveBeenCalled();
    expect(checkRateLimit).not.toHaveBeenCalled();
  });

  test("PUBLIC_NO_AUTH route: wm_ key NOT re-validated (no Convex amplification) — served as anonymous", async () => {
    entitlement = DOWNGRADED;
    const res = await makeGateway()(keyReq(PUBLIC_NO_AUTH_PATH), ctx);
    // Public-no-auth serves free data to everyone; the wm_ key is not the
    // authenticator, so the gate does NOT resolve it. This is deliberate: it
    // avoids an unauthenticated Convex-lookup amplification vector (a rotating
    // fake wm_ key per anonymous request) and keeps the intentionally-anonymous
    // lead-capture forms open. Public data is not the paid product.
    expect(res.status).toBe(200);
    expect(validateUserApiKey).not.toHaveBeenCalled();
    expect(getEntitlements).not.toHaveBeenCalled();
  });

  test("PREMIUM route: downgraded key → 403 (parity preserved)", async () => {
    entitlement = DOWNGRADED;
    const res = await makeGateway()(keyReq(PREMIUM_PATH, "POST"), ctx);
    expect(res.status).toBe(403);
  });

  test("tier-gated route: mixed bearer + downgraded wm_ key checks the wm_ owner", async () => {
    requiredTiers.set(PREMIUM_PATH, 1);
    clerkSession = { userId: "acct_active_session", orgId: "org_1" };
    entitlementsByUser.set("acct_active_session", ACTIVE);
    entitlementsByUser.set("acct_lapsed", DOWNGRADED);

    const res = await makeGateway()(
      keyReq(PREMIUM_PATH, "POST", "wm_lapsed_customer_key", {
        Authorization: "Bearer valid-clerk-session",
      }),
      ctx,
    );

    expect(res.status).toBe(403);
    expect(resolveClerkSession).toHaveBeenCalledTimes(1);
    expect(validateUserApiKey).toHaveBeenCalledWith("wm_lapsed_customer_key");
    expect(getEntitlements).toHaveBeenCalledWith("acct_lapsed");
    expect(checkBurst).not.toHaveBeenCalled();
    expect(checkRateLimit).not.toHaveBeenCalled();
  });

  // --- apiAccess:true but validUntil in the past (lapsed) → 403 -------------
  test("expired entitlement (apiAccess:true, validUntil < now) → 403", async () => {
    entitlement = { planKey: "api_starter", features: { tier: 2, apiAccess: true, apiRateLimit: 60 }, validUntil: Date.now() - 1_000 };
    const res = await makeGateway()(keyReq(REGULAR_PATH), ctx);
    expect(res.status).toBe(403);
  });

  test("renewal verification pending on a wm_ key returns retryable 503", async () => {
    entitlement = {
      planKey: "free",
      features: { tier: 0, apiAccess: false, apiRateLimit: 0 },
      validUntil: 0,
      billingStatus: "renewal_verification_pending",
      retryAfterSeconds: 13,
    };

    const res = await makeGateway()(keyReq(REGULAR_PATH), ctx);

    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("13");
    expect(await res.json()).toMatchObject({ code: "renewal_verification_pending" });
  });

  test("current Pro fallback still returns retryable 503 for API-key access", async () => {
    entitlement = {
      planKey: "pro_monthly",
      features: {
        tier: 1,
        apiAccess: false,
        apiRateLimit: 0,
        mcpAccess: true,
      },
      validUntil: Date.now() + 86_400_000,
      billingStatus: "renewal_verification_pending",
      retryAfterSeconds: 13,
    };

    const res = await makeGateway()(keyReq(REGULAR_PATH), ctx);

    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("13");
    expect(await res.json()).toMatchObject({
      code: "renewal_verification_pending",
    });
  });

  test("confirmed lapse on a wm_ key returns subscription_lapsed", async () => {
    entitlement = {
      planKey: "free",
      features: { tier: 0, apiAccess: false, apiRateLimit: 0 },
      validUntil: 0,
      billingStatus: "subscription_lapsed",
    };

    const res = await makeGateway()(keyReq(REGULAR_PATH), ctx);

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "subscription_lapsed" });
  });

  test("legacy premium bearer surfaces renewal verification failure", async () => {
    entitlement = {
      planKey: "free",
      features: { tier: 0, apiAccess: false, apiRateLimit: 0 },
      validUntil: 0,
      billingStatus: "renewal_verification_failed",
      retryAfterSeconds: 23,
    };
    const req = new Request(`https://www.worldmonitor.app${PREMIUM_PATH}`, {
      method: "POST",
      headers: { Authorization: "Bearer valid-legacy-session" },
    });

    const res = await makeGateway()(req, ctx);

    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("23");
    expect(await res.json()).toMatchObject({ code: "renewal_verification_failed" });
  });

  test("null entitlement (verification timeout/cache failure) → retryable no-store 503", async () => {
    entitlement = null;
    const res = await makeGateway()(keyReq(REGULAR_PATH), ctx);
    expect(res.status).toBe(503);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Retry-After")).toBe("5");
    expect(res.headers.get("X-Billing-Verification")).toBe("entitlement_verification_unavailable");
    expect(await res.json()).toMatchObject({ code: "entitlement_verification_unavailable" });
    expect(checkBurst).not.toHaveBeenCalled();
    expect(checkRateLimit).not.toHaveBeenCalled();
  });

  test("tier-gated route passes through a billing-verification 503 from checkEntitlementDetailed", async () => {
    entitlement = ACTIVE;
    checkEntitlementDetailedMock.mockResolvedValue({
      response: new Response(
        JSON.stringify({ error: "Renewal verification pending", code: "renewal_verification_pending" }),
        {
          status: 503,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
            "Retry-After": "17",
            "X-Billing-Verification": "renewal_verification_pending",
          },
        },
      ),
      entitlements: null,
    });

    const res = await makeGateway()(keyReq(REGULAR_PATH), ctx);

    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("17");
    expect(res.headers.get("X-Billing-Verification")).toBe("renewal_verification_pending");
    expect(await res.json()).toMatchObject({ code: "renewal_verification_pending" });
  });

  test("null entitlement with UNCONFIGURED backend → fail-open 200 (deploy defect, not billing state)", async () => {
    entitlement = null;
    entitlementBackendConfigured = false;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await makeGateway()(keyReq(REGULAR_PATH), ctx);
      // Missing CONVEX_SITE_URL / shared secret means NO lookup could ever
      // succeed: 503ing here would turn a config regression into a fleet-wide
      // outage for every wm_ key. Serve (pre-#4770 posture) and log loudly.
      expect(res.status).toBe(200);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("entitlement backend unconfigured"),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  // --- active subscription unaffected --------------------------------------
  test("active apiAccess key → served on regular RPC", async () => {
    entitlement = ACTIVE;
    const res = await makeGateway()(keyReq(REGULAR_PATH), ctx);
    expect(res.status).toBe(200);
  });

  test("active apiAccess key → served on PUBLIC_NO_AUTH route (key not re-validated)", async () => {
    entitlement = ACTIVE;
    const res = await makeGateway()(keyReq(PUBLIC_NO_AUTH_PATH), ctx);
    expect(res.status).toBe(200);
    expect(validateUserApiKey).not.toHaveBeenCalled();
  });

  test("re-subscribe restores the SAME key (no revocation) — active again → 200", async () => {
    entitlement = DOWNGRADED;
    expect((await makeGateway()(keyReq(REGULAR_PATH), ctx)).status).toBe(403);
    entitlement = ACTIVE; // subscription restored, same un-revoked key
    expect((await makeGateway()(keyReq(REGULAR_PATH), ctx)).status).toBe(200);
  });

  // --- enterprise operator keys are exempt ---------------------------------
  test("enterprise wm_-prefixed operator key is NOT gated (no entitlement row)", async () => {
    process.env.WORLDMONITOR_VALID_KEYS = "wm_enterprise_legacy_relay";
    entitlement = DOWNGRADED; // would 403 a user key — must be ignored here
    const res = await makeGateway()(keyReq(REGULAR_PATH, "GET", "wm_enterprise_legacy_relay"), ctx);
    expect(res.status).toBe(200);
    // The apiAccess gate must not resolve an entitlement for an enterprise key.
    expect(getEntitlements).not.toHaveBeenCalled();
  });
});
