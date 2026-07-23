// @vitest-environment node

/**
 * Unit tests for gateway entitlement check logic.
 *
 * Mocking strategy: Controls the Redis mock return value to steer what
 * getEntitlements returns — no dependency injection needed. Since CONVEX_SITE_URL
 * is not set in most tests, the Convex fallback is skipped and getCachedJson is
 * the sole source of entitlement data.
 *
 * Per-file @vitest-environment node override avoids edge-runtime's missing
 * process.env for these helpers.
 */

import { describe, test, expect, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock the Redis dependency so the module loads without a real Redis connection
// ---------------------------------------------------------------------------
vi.mock("../_shared/redis", () => ({
  getCachedJson: vi.fn().mockResolvedValue(null),
  setCachedJson: vi.fn().mockResolvedValue(undefined),
}));

import { getCachedJson, setCachedJson } from "../_shared/redis";
import {
  getRequiredTier,
  checkEntitlement,
  getEntitlements,
} from "../_shared/entitlement-check";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FUTURE = Date.now() + 86400000 * 30;

function makeEntitlements(tier: number, planKey = "free") {
  return {
    planKey,
    features: {
      tier,
      apiAccess: tier >= 2,
      apiRateLimit: tier >= 2 ? 60 : 0,
      maxDashboards: tier >= 1 ? 10 : 3,
      prioritySupport: tier >= 2,
      exportFormats: tier >= 2 ? ["csv", "pdf", "json"] : ["csv"],
      // Plan 2026-05-10-001 U10 added mcpAccess to the feature set. Cache
      // entries lacking this field are now treated as stale by
      // _getEntitlementsImpl (round-2 P2-cache fix), so test fixtures
      // must include it to be considered fresh.
      mcpAccess: tier >= 1,
    },
    validUntil: FUTURE,
  };
}

async function withConvexEntitlementResponse<T>(
  payload: unknown,
  run: () => Promise<T>,
): Promise<T> {
  const originalSiteUrl = process.env.CONVEX_SITE_URL;
  const originalSecret = process.env.CONVEX_SERVER_SHARED_SECRET;
  process.env.CONVEX_SITE_URL = "https://example-deployment.convex.site";
  process.env.CONVEX_SERVER_SHARED_SECRET = "test-secret";
  vi.mocked(getCachedJson).mockResolvedValueOnce(null);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  ));
  try {
    return await run();
  } finally {
    if (originalSiteUrl === undefined) delete process.env.CONVEX_SITE_URL;
    else process.env.CONVEX_SITE_URL = originalSiteUrl;
    if (originalSecret === undefined) delete process.env.CONVEX_SERVER_SHARED_SECRET;
    else process.env.CONVEX_SERVER_SHARED_SECRET = originalSecret;
    vi.unstubAllGlobals();
  }
}

// Like withConvexEntitlementResponse, but with full control over the fetch
// outcome (throw, 5xx, 4xx) — used to pin the transient-vs-confirmed split.
async function withConvexEntitlementFetch<T>(
  fetchImpl: () => Promise<Response>,
  run: () => Promise<T>,
): Promise<T> {
  const originalSiteUrl = process.env.CONVEX_SITE_URL;
  const originalSecret = process.env.CONVEX_SERVER_SHARED_SECRET;
  process.env.CONVEX_SITE_URL = "https://example-deployment.convex.site";
  process.env.CONVEX_SERVER_SHARED_SECRET = "test-secret";
  vi.mocked(getCachedJson).mockResolvedValueOnce(null);
  vi.stubGlobal("fetch", vi.fn().mockImplementation(fetchImpl));
  try {
    return await run();
  } finally {
    if (originalSiteUrl === undefined) delete process.env.CONVEX_SITE_URL;
    else process.env.CONVEX_SITE_URL = originalSiteUrl;
    if (originalSecret === undefined) delete process.env.CONVEX_SERVER_SHARED_SECRET;
    else process.env.CONVEX_SERVER_SHARED_SECRET = originalSecret;
    vi.unstubAllGlobals();
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("gateway entitlement check", () => {
  test.each([
    "/api/intelligence/v1/classify-event",
    "/api/market/v1/analyze-stock",
    "/api/market/v1/get-stock-analysis-history",
    "/api/market/v1/backtest-stock",
    "/api/market/v1/list-stored-stock-backtests",
  ])("getRequiredTier returns 1 for %s (regression-lock against tier-2 revert)", (path) => {
    expect(getRequiredTier(path)).toBe(1);
  });

  test("getRequiredTier returns null for ungated endpoint", () => {
    expect(getRequiredTier("/api/seismology/v1/list-earthquakes")).toBeNull();
  });

  test("checkEntitlement returns null for ungated endpoint", async () => {
    const result = await checkEntitlement(null, "/api/seismology/v1/list-earthquakes", {});
    expect(result).toBeNull();
  });

  test("checkEntitlement returns 403 when no resolved userId is provided (fail-closed)", async () => {
    const result = await checkEntitlement(null, "/api/market/v1/analyze-stock", {});
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);

    const body = await result!.json();
    expect(body.error).toBe("Authentication required");
    expect(body.requiredTier).toBe(1);
  });

  test("checkEntitlement returns 403 when getEntitlements returns null (fail-closed)", async () => {
    // getCachedJson returns null by default (no Redis data, no Convex URL) -> null entitlements
    const result = await checkEntitlement("test-user", "/api/market/v1/analyze-stock", {});
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);

    const body = await result!.json();
    expect(body.error).toBe("Unable to verify entitlements");
    expect(body.requiredTier).toBe(1);
  });

  test("transient Convex fetch failure returns a verificationUnavailable marker, not null", async () => {
    await withConvexEntitlementFetch(
      () => Promise.reject(Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" })),
      async () => {
        const ent = await getEntitlements("user-transient-timeout");
        expect(ent).not.toBeNull();
        expect(ent?.verificationUnavailable).toBe(true);
        // Deny-side: the marker must never carry an affirmative grant.
        expect(ent?.features.tier).toBe(0);
        expect(ent?.features.apiAccess).toBe(false);
        expect(ent?.validUntil).toBe(0);
      },
    );
  });

  test("Convex 5xx returns the verificationUnavailable marker; 4xx stays a fail-closed null", async () => {
    await withConvexEntitlementFetch(
      () => Promise.resolve(new Response("upstream error", { status: 503 })),
      async () => {
        const ent = await getEntitlements("user-transient-5xx");
        expect(ent?.verificationUnavailable).toBe(true);
      },
    );
    await withConvexEntitlementFetch(
      () => Promise.resolve(new Response("forbidden", { status: 403 })),
      async () => {
        // A 4xx (bad shared secret / contract rejection) is a deploy defect,
        // not a transient — the hard fail-closed null posture must hold.
        const ent = await getEntitlements("user-config-4xx");
        expect(ent).toBeNull();
      },
    );
  });

  test("checkEntitlement answers a transient lookup failure with the retryable 503 contract, not a hard 403", async () => {
    await withConvexEntitlementFetch(
      () => Promise.reject(new Error("fetch failed")),
      async () => {
        const result = await checkEntitlement("user-transient-check", "/api/market/v1/analyze-stock", {});
        expect(result).not.toBeNull();
        expect(result!.status).toBe(503);
        expect(result!.headers.get("X-Billing-Verification")).toBe("entitlement_verification_unavailable");
        expect(result!.headers.get("Retry-After")).toBe("5");
        expect(result!.headers.get("Cache-Control")).toBe("no-store");

        const body = await result!.json();
        expect(body.error).toBe("Unable to verify API access");
        expect(body.code).toBe("entitlement_verification_unavailable");
        expect(body.requiredTier).toBe(1);
      },
    );
  });

  test.each([
    ["renewal_verification_pending", "Renewal verification pending"],
    ["renewal_verification_failed", "Renewal verification failed"],
  ] as const)("%s returns a distinct retryable 503", async (billingStatus, error) => {
    const result = await withConvexEntitlementResponse(
      {
        ...makeEntitlements(0),
        validUntil: 0,
        billingStatus,
        retryAfterSeconds: 17,
      },
      () => checkEntitlement("test-user", "/api/market/v1/analyze-stock", {}),
    );

    expect(result?.status).toBe(503);
    expect(result?.headers.get("Retry-After")).toBe("17");
    expect(result?.headers.get("X-Billing-Verification")).toBe(billingStatus);
    expect(await result?.json()).toMatchObject({ error, code: billingStatus });
  });

  test.each([
    "renewal_verification_pending",
    "renewal_verification_failed",
  ] as const)(
    "current Pro fallback authorizes tier-1 REST while stronger verification is %s",
    async (billingStatus) => {
      const result = await withConvexEntitlementResponse(
        {
          ...makeEntitlements(1, "pro_monthly"),
          billingStatus,
          retryAfterSeconds: 17,
        },
        () => checkEntitlement(
          "test-user",
          "/api/market/v1/analyze-stock",
          {},
        ),
      );

      expect(result).toBeNull();
    },
  );

  test("subscription_lapsed returns a distinct hard-denial code", async () => {
    const result = await withConvexEntitlementResponse(
      {
        ...makeEntitlements(0),
        validUntil: 0,
        billingStatus: "subscription_lapsed",
      },
      () => checkEntitlement("test-user", "/api/market/v1/analyze-stock", {}),
    );

    expect(result?.status).toBe(403);
    expect(result?.headers.get("X-Billing-Verification")).toBe("subscription_lapsed");
    expect(await result?.json()).toMatchObject({
      error: "Subscription lapsed",
      code: "subscription_lapsed",
    });
  });

  test("serves a short-lived verification marker from Redis without another Convex request", async () => {
    vi.mocked(getCachedJson).mockResolvedValueOnce({
      ...makeEntitlements(0),
      validUntil: 0,
      billingStatus: "renewal_verification_pending",
      retryAfterSeconds: 11,
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      const result = await checkEntitlement(
        "test-user",
        "/api/market/v1/analyze-stock",
        {},
      );

      expect(result?.status).toBe(503);
      expect(result?.headers.get("Retry-After")).toBe("11");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("serves a recent not-applicable freshness marker without another Convex request", async () => {
    vi.mocked(getCachedJson).mockResolvedValueOnce({
      ...makeEntitlements(0),
      validUntil: 0,
      renewalVerificationFreshness: {
        status: "not_applicable",
        checkedAt: Date.now(),
      },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      const result = await checkEntitlement(
        "test-user",
        "/api/market/v1/analyze-stock",
        {},
      );

      expect(result?.status).toBe(403);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("an expired not-applicable freshness marker falls through to Convex", async () => {
    vi.mocked(getCachedJson).mockResolvedValueOnce({
      ...makeEntitlements(0),
      validUntil: 0,
      renewalVerificationFreshness: {
        status: "not_applicable",
        checkedAt: Date.now() - 900_001,
      },
    });
    const originalSiteUrl = process.env.CONVEX_SITE_URL;
    const originalSecret = process.env.CONVEX_SERVER_SHARED_SECRET;
    process.env.CONVEX_SITE_URL = "https://example-deployment.convex.site";
    process.env.CONVEX_SERVER_SHARED_SECRET = "test-secret";
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(makeEntitlements(1, "pro_monthly")), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const result = await checkEntitlement(
        "test-user",
        "/api/market/v1/analyze-stock",
        {},
      );

      expect(result).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      if (originalSiteUrl === undefined) delete process.env.CONVEX_SITE_URL;
      else process.env.CONVEX_SITE_URL = originalSiteUrl;
      if (originalSecret === undefined) delete process.env.CONVEX_SERVER_SHARED_SECRET;
      else process.env.CONVEX_SERVER_SHARED_SECRET = originalSecret;
      vi.unstubAllGlobals();
    }
  });

  test("caches a not-applicable freshness marker for at most 900 seconds", async () => {
    const marker = {
      ...makeEntitlements(0),
      validUntil: 0,
      renewalVerificationFreshness: {
        status: "not_applicable",
        checkedAt: Date.now(),
      },
    };
    await withConvexEntitlementResponse(marker, async () => {
      await getEntitlements("test-user-marker-ttl");
    });

    const ttl = vi.mocked(setCachedJson).mock.calls.at(-1)?.[2];
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(900);
  });

  test("checkEntitlement accepts Clerk role=pro for tier-1 gates without Convex entitlements", async () => {
    const result = await checkEntitlement(
      "test-user",
      "/api/market/v1/analyze-stock",
      {},
      { clerkRole: "pro" },
    );

    expect(result).toBeNull();
  });

  test("checkEntitlement returns 403 for insufficient tier", async () => {
    vi.mocked(getCachedJson).mockResolvedValueOnce(makeEntitlements(0));

    const result = await checkEntitlement("test-user", "/api/market/v1/analyze-stock", {});

    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);

    const body = await result!.json();
    expect(body.error).toBe("Upgrade required");
    expect(body.requiredTier).toBe(1);
    expect(body.currentTier).toBe(0);
  });

  test("checkEntitlement returns null for Pro tier (tier=1) on stock analysis", async () => {
    // Regression: previous tier=2 requirement 403'd real Pro subscribers
    // calling via Clerk session (no tester key in localStorage). Stock
    // analysis is marketed as a Pro feature and must accept tier >= 1.
    vi.mocked(getCachedJson).mockResolvedValueOnce(makeEntitlements(1, "pro_monthly"));

    const result = await checkEntitlement("test-user", "/api/market/v1/analyze-stock", {});
    expect(result).toBeNull();
  });

  test("checkEntitlement returns null for sufficient tier", async () => {
    vi.mocked(getCachedJson).mockResolvedValueOnce(makeEntitlements(2, "api_starter"));

    const result = await checkEntitlement("test-user", "/api/market/v1/analyze-stock", {});
    expect(result).toBeNull();
  });

  test("checkEntitlement ignores spoofable request headers and uses explicit userId contract", async () => {
    vi.mocked(getCachedJson).mockResolvedValueOnce(makeEntitlements(1, "pro_monthly"));

    const result = await checkEntitlement("trusted-user", "/api/market/v1/analyze-stock", {});

    expect(result).toBeNull();
    expect(getCachedJson).toHaveBeenLastCalledWith("entitlements:test:trusted-user", true);
  });

  test("reviewer round-2 P2-cache: legacy cache entry without mcpAccess is treated as stale and falls through to Convex", async () => {
    // Seed Redis with a pre-U10 cached entitlement: tier-1 Pro, but the
    // stored features object is the OLD shape WITHOUT mcpAccess. The cache
    // predicate must detect this and fall through to Convex (which does
    // the read-time catalog merge), rather than returning a row that
    // would block the user at the grant/MCP gates with mcpAccess !== true.
    const legacyCache = {
      planKey: "pro_monthly",
      features: {
        tier: 1,
        apiAccess: false,
        apiRateLimit: 0,
        maxDashboards: 10,
        prioritySupport: false,
        exportFormats: ["csv"],
        // NO mcpAccess field — pre-U10 cache entry
      },
      validUntil: FUTURE,
    };
    vi.mocked(getCachedJson).mockResolvedValueOnce(legacyCache);

    // Mock Convex fallback to return the post-U10 merged shape.
    const originalSiteUrl = process.env.CONVEX_SITE_URL;
    const originalSecret = process.env.CONVEX_SERVER_SHARED_SECRET;
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(makeEntitlements(1, "pro_monthly")), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    process.env.CONVEX_SITE_URL = "https://example-deployment.convex.site";
    process.env.CONVEX_SERVER_SHARED_SECRET = "test-secret";
    vi.stubGlobal("fetch", fetchMock);

    try {
      const result = await checkEntitlement("test-user", "/api/market/v1/analyze-stock", {});

      // Expect: cache rejected as stale → Convex round-trip → tier-1 row
      // with mcpAccess: true → checkEntitlement passes (returns null).
      expect(result).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      process.env.CONVEX_SITE_URL = originalSiteUrl;
      process.env.CONVEX_SERVER_SHARED_SECRET = originalSecret;
      vi.unstubAllGlobals();
    }
  });

  test("reviewer round-2 P2-cache: cache entry WITH mcpAccess is honored without Convex round-trip", async () => {
    // Sanity check the inverse: a post-U10 cache entry should be returned
    // directly without falling through to Convex.
    vi.mocked(getCachedJson).mockResolvedValueOnce(makeEntitlements(1, "pro_monthly"));

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    try {
      const result = await checkEntitlement("test-user", "/api/market/v1/analyze-stock", {});

      expect(result).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(0); // cache hit, no Convex call
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("getEntitlements uses CONVEX_SITE_URL for HTTP fallback", async () => {
    vi.mocked(getCachedJson).mockResolvedValueOnce(null);

    const originalSiteUrl = process.env.CONVEX_SITE_URL;
    const originalSecret = process.env.CONVEX_SERVER_SHARED_SECRET;
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(makeEntitlements(2, "api_starter")), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    process.env.CONVEX_SITE_URL = "https://example-deployment.convex.site";
    process.env.CONVEX_SERVER_SHARED_SECRET = "test-secret";
    vi.stubGlobal("fetch", fetchMock);

    try {
      const result = await checkEntitlement("test-user", "/api/market/v1/analyze-stock", {});
      expect(result).toBeNull();
      expect(fetchMock).toHaveBeenCalledWith(
        "https://example-deployment.convex.site/api/internal-entitlements",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "x-convex-shared-secret": "test-secret",
          }),
        }),
      );
      const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
      expect(init.signal).toBeInstanceOf(AbortSignal);
    } finally {
      if (originalSiteUrl === undefined) {
        delete process.env.CONVEX_SITE_URL;
      } else {
        process.env.CONVEX_SITE_URL = originalSiteUrl;
      }
      if (originalSecret === undefined) {
        delete process.env.CONVEX_SERVER_SHARED_SECRET;
      } else {
        process.env.CONVEX_SERVER_SHARED_SECRET = originalSecret;
      }
      vi.unstubAllGlobals();
    }
  });
});

// ---------------------------------------------------------------------------
// #3199 U2 — apiDailyAllowance threads through to the resolved entitlement
// ---------------------------------------------------------------------------

describe("getEntitlements surfaces apiDailyAllowance (#3199 U2)", () => {
  test("a fresh Starter cache row exposes apiDailyAllowance", async () => {
    const fresh = makeEntitlements(2, "api_starter");
    vi.mocked(getCachedJson).mockResolvedValueOnce({
      ...fresh,
      features: { ...fresh.features, apiDailyAllowance: 1000 },
    } as never);

    const result = await getEntitlements("user_starter");
    expect(result?.features.apiDailyAllowance).toBe(1000);
  });

  test("a legacy cache row lacking apiDailyAllowance resolves to undefined (fail-open), no throw", async () => {
    // makeEntitlements sets mcpAccess (boolean) so the row passes the
    // staleness gate, but does NOT set apiDailyAllowance — the field is
    // intentionally absent from the staleness gate so legacy rows are served
    // from cache and the rate-limit consumer fail-opens on undefined.
    vi.mocked(getCachedJson).mockResolvedValueOnce(
      makeEntitlements(2, "api_starter") as never,
    );

    const result = await getEntitlements("user_legacy");
    expect(result).not.toBeNull();
    expect(result?.features.apiDailyAllowance).toBeUndefined();
  });
});
