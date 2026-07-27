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
  classifyBillingVerification,
  getBillingVerificationDenial,
  __negativeCacheMaxEntriesForTests,
  __negativeCacheSizeForTests,
  __negativeCacheTtlMsForTests,
  __resetEntitlementNegativeCacheForTests,
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
      exportFormats: tier >= 2 ? ["csv", "json", "pdf"] : [],
      // Plan 2026-05-10-001 U10 added mcpAccess to the feature set. Cache
      // entries lacking this field are now treated as stale by
      // _getEntitlementsImpl (round-2 P2-cache fix), so test fixtures
      // must include it to be considered fresh.
      mcpAccess: tier >= 1,
      // Plan 2026-07-25-001 U1 added dataExport. Mirrors the catalog for the
      // tiers this factory can express — Pro Business also exports at tier 1,
      // but it is not reachable through a tier-only fixture. Deliberately NOT
      // part of the cache-staleness gate (undefined fail-opens at tier >= 2).
      dataExport: tier >= 2,
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

  test("a not-applicable freshness marker past the bounded window falls through to Convex", async () => {
    // #5600: a fresh Pro checkout races the Dodo webhook. The pre-purchase
    // no-history answer must stop being served-sticky within a minute so the
    // new subscriber's next request re-reads Convex instead of eating a
    // 15-minute wrongful 403 on every tier-gated endpoint.
    vi.mocked(getCachedJson).mockResolvedValueOnce({
      ...makeEntitlements(0),
      validUntil: 0,
      renewalVerificationFreshness: {
        status: "not_applicable",
        checkedAt: Date.now() - 61_000,
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

  test("caches a not-applicable freshness marker for at most 60 seconds", async () => {
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

    // Pin the exact value, not a window. `checkedAt` is Date.now() immediately
    // before the write and setCachedJson is mocked, so the computed
    // Math.ceil((checkedAt + 60_000 - now) / 1000) is deterministically 60 — a
    // range of (30, 60] let a drift to any value in [31, 59] pass both this and
    // the api/_user-api-key.test.mjs mirror undetected, and cross-mirror parity
    // would not catch a symmetric drift either.
    const ttl = vi.mocked(setCachedJson).mock.calls.at(-1)?.[2];
    expect(ttl).toBe(60);
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

  test("confirmed Convex entitlement survives a Redis cache-write failure", async () => {
    vi.mocked(getCachedJson).mockResolvedValueOnce(null);
    vi.mocked(setCachedJson).mockRejectedValueOnce(new Error("upstash unavailable"));

    const originalSiteUrl = process.env.CONVEX_SITE_URL;
    const originalSecret = process.env.CONVEX_SERVER_SHARED_SECRET;
    const confirmed = makeEntitlements(2, "api_starter");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(confirmed), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    process.env.CONVEX_SITE_URL = "https://example-deployment.convex.site";
    process.env.CONVEX_SERVER_SHARED_SECRET = "test-secret";
    vi.stubGlobal("fetch", fetchMock);

    try {
      const result = await getEntitlements("user_cache_write_failure");
      expect(result).toEqual(confirmed);
      expect(setCachedJson).toHaveBeenCalledWith(
        "entitlements:test:user_cache_write_failure",
        confirmed,
        900,
        true,
      );
    } finally {
      if (originalSiteUrl === undefined) delete process.env.CONVEX_SITE_URL;
      else process.env.CONVEX_SITE_URL = originalSiteUrl;
      if (originalSecret === undefined) delete process.env.CONVEX_SERVER_SHARED_SECRET;
      else process.env.CONVEX_SERVER_SHARED_SECRET = originalSecret;
      vi.unstubAllGlobals();
    }
  });
});

// ---------------------------------------------------------------------------
// #5622 — classifyBillingVerification: the decision, as an executable table
// ---------------------------------------------------------------------------

/**
 * Three consumers cannot take a `Response` (an HTML page, the OAuth-grant
 * handshake's own error vocabulary, and a boolean premium check), so the
 * retryable-vs-terminal decision was extracted here. Pin it as a truth table
 * rather than through any one renderer: a source-level guard on the renderers
 * would stay green with the decision itself inverted.
 */
describe("classifyBillingVerification (#5622)", () => {
  test("no billing metadata is not a denial", () => {
    expect(classifyBillingVerification(null)).toBeNull();
    expect(classifyBillingVerification(undefined)).toBeNull();
    expect(classifyBillingVerification({})).toBeNull();
  });

  test("an unrecognised billingStatus string is not a denial (fail-open on vocabulary drift)", () => {
    expect(
      classifyBillingVerification({
        billingStatus: "something_new" as never,
      }),
    ).toBeNull();
  });

  test("a transient lookup failure is retryable with the advertised 5s default", () => {
    expect(classifyBillingVerification({ verificationUnavailable: true })).toEqual({
      retryable: true,
      code: "entitlement_verification_unavailable",
      retryAfterSeconds: 5,
      message: "Unable to verify API access",
      status: 503,
    });
  });

  test("verificationUnavailable outranks a stale billingStatus on the same row", () => {
    // The marker is synthesized over whatever shape the failed lookup had; a
    // lapsed status carried alongside it is unverified, so it must not turn a
    // transient failure into a terminal 403.
    const denial = classifyBillingVerification({
      verificationUnavailable: true,
      billingStatus: "subscription_lapsed",
    });
    expect(denial?.retryable).toBe(true);
    expect(denial?.code).toBe("entitlement_verification_unavailable");
  });

  test("a provider-confirmed lapse is the only terminal member", () => {
    expect(classifyBillingVerification({ billingStatus: "subscription_lapsed" })).toEqual({
      retryable: false,
      code: "subscription_lapsed",
      retryAfterSeconds: 0,
      message: "Subscription lapsed",
      status: 403,
    });
  });

  test.each([
    ["renewal_verification_pending", "Renewal verification pending"],
    ["renewal_verification_failed", "Renewal verification failed"],
  ] as const)("%s is retryable and carries the provider's own delay", (billingStatus, message) => {
    expect(classifyBillingVerification({ billingStatus, retryAfterSeconds: 17 })).toEqual({
      retryable: true,
      code: billingStatus,
      retryAfterSeconds: 17,
      message,
      status: 503,
    });
  });

  test("retryAfterSeconds is clamped into 1-60 whatever the provider sent", () => {
    const delay = (raw: unknown) =>
      classifyBillingVerification({
        billingStatus: "renewal_verification_pending",
        retryAfterSeconds: raw as number,
      })?.retryAfterSeconds;
    expect(delay(0)).toBe(1);
    expect(delay(-5)).toBe(1);
    expect(delay(0.2)).toBe(1);
    // 2.1 -> 3 is the case that actually distinguishes ceil from floor; the 0.2
    // case above is masked by the outer Math.max(1, ...) clamp.
    expect(delay(2.1)).toBe(3);
    expect(delay(600)).toBe(60);
    expect(delay(Number.NaN)).toBe(5);
    expect(delay(undefined)).toBe(5);
    expect(delay("11")).toBe(5);
  });

  test("every retryable member advertises a delay and the terminal one does not", () => {
    for (const input of [
      { verificationUnavailable: true as const },
      { billingStatus: "renewal_verification_pending" as const },
      { billingStatus: "renewal_verification_failed" as const },
    ]) {
      const denial = classifyBillingVerification(input);
      expect(denial?.retryable).toBe(true);
      expect(denial?.status).toBe(503);
      expect(denial!.retryAfterSeconds).toBeGreaterThan(0);
    }
    const lapsed = classifyBillingVerification({ billingStatus: "subscription_lapsed" });
    expect(lapsed?.retryable).toBe(false);
    expect(lapsed?.status).toBe(403);
    expect(lapsed?.retryAfterSeconds).toBe(0);
  });
});

describe("getBillingVerificationDenial renders the classification (#5622)", () => {
  test("a terminal denial carries no Retry-After — a lapse must not invite a retry loop", async () => {
    const res = getBillingVerificationDenial({ billingStatus: "subscription_lapsed" }, {}, 1);
    expect(res?.status).toBe(403);
    expect(res?.headers.get("Retry-After")).toBeNull();
    expect(res?.headers.get("X-Billing-Verification")).toBe("subscription_lapsed");
    expect(await res?.json()).toEqual({
      error: "Subscription lapsed",
      code: "subscription_lapsed",
      requiredTier: 1,
    });
  });

  test("requiredTier is omitted, not null, when the caller does not supply one", async () => {
    const res = getBillingVerificationDenial({ verificationUnavailable: true }, {});
    expect(await res?.json()).toEqual({
      error: "Unable to verify API access",
      code: "entitlement_verification_unavailable",
    });
  });

  test("cors headers are merged and cannot clobber the verification header", () => {
    const res = getBillingVerificationDenial({ verificationUnavailable: true }, {
      "Access-Control-Allow-Origin": "https://worldmonitor.app",
    });
    expect(res?.headers.get("Access-Control-Allow-Origin")).toBe("https://worldmonitor.app");
    expect(res?.headers.get("X-Billing-Verification")).toBe("entitlement_verification_unavailable");
    expect(res?.headers.get("Cache-Control")).toBe("no-store");
  });

  test("returns null when there is nothing to deny", () => {
    expect(getBillingVerificationDenial(null, {})).toBeNull();
    expect(getBillingVerificationDenial({}, {})).toBeNull();
  });

  test("the contract headers win over a corsHeaders map that collides with them", () => {
    // The refactor changed this precedence (the pre-#5622 version let corsHeaders
    // clobber X-Billing-Verification but not Retry-After — inconsistent). No cors
    // helper in the repo emits either name, so it is inert today; pinned so it
    // stays that way rather than being rediscovered from a wrong header in prod.
    const res = getBillingVerificationDenial({ verificationUnavailable: true }, {
      "Access-Control-Allow-Origin": "https://worldmonitor.app",
      "X-Billing-Verification": "spoofed",
      "Retry-After": "999",
      "Cache-Control": "public, max-age=600",
    });
    expect(res?.headers.get("X-Billing-Verification")).toBe("entitlement_verification_unavailable");
    expect(res?.headers.get("Retry-After")).toBe("5");
    // no-store is load-bearing: a cached denial is a wrongful denial for everyone
    // behind the same CDN entry.
    expect(res?.headers.get("Cache-Control")).toBe("no-store");
    expect(res?.headers.get("Access-Control-Allow-Origin")).toBe("https://worldmonitor.app");
  });
});

// ---------------------------------------------------------------------------
// #5622 — transient failures are negative-cached so an outage is not amplified
// ---------------------------------------------------------------------------

describe("transient-failure negative cache (#5622)", () => {
  test("a repeat lookup inside the window reuses the transient answer without another backend call", async () => {
    __resetEntitlementNegativeCacheForTests();
    const originalSiteUrl = process.env.CONVEX_SITE_URL;
    const originalSecret = process.env.CONVEX_SERVER_SHARED_SECRET;
    process.env.CONVEX_SITE_URL = "https://example-deployment.convex.site";
    process.env.CONVEX_SERVER_SHARED_SECRET = "test-secret";
    vi.mocked(getCachedJson).mockResolvedValue(null);
    const fetchMock = vi.fn().mockRejectedValue(new Error("fetch failed"));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const first = await getEntitlements("user-negcache-hit");
      const second = await getEntitlements("user-negcache-hit");

      expect(first?.verificationUnavailable).toBe(true);
      // Same deny-side answer, so every gate still emits the retryable 503.
      expect(second?.verificationUnavailable).toBe(true);
      expect(second?.features.tier).toBe(0);
      expect(second?.validUntil).toBe(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      if (originalSiteUrl === undefined) delete process.env.CONVEX_SITE_URL;
      else process.env.CONVEX_SITE_URL = originalSiteUrl;
      if (originalSecret === undefined) delete process.env.CONVEX_SERVER_SHARED_SECRET;
      else process.env.CONVEX_SERVER_SHARED_SECRET = originalSecret;
      vi.unstubAllGlobals();
      vi.mocked(getCachedJson).mockResolvedValue(null);
      __resetEntitlementNegativeCacheForTests();
    }
  });

  test("the cached failure expires, so recovery is not held back past the window", async () => {
    __resetEntitlementNegativeCacheForTests();
    const originalSiteUrl = process.env.CONVEX_SITE_URL;
    const originalSecret = process.env.CONVEX_SERVER_SHARED_SECRET;
    process.env.CONVEX_SITE_URL = "https://example-deployment.convex.site";
    process.env.CONVEX_SERVER_SHARED_SECRET = "test-secret";
    vi.mocked(getCachedJson).mockResolvedValue(null);
    const recovered = makeEntitlements(1, "pro_monthly");
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockResolvedValue(
        new Response(JSON.stringify(recovered), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    // Advance past the window rather than sleeping for it — the TTL is real
    // seconds and this assertion is about the boundary, not the wall clock.
    const realNow = Date.now;
    try {
      expect((await getEntitlements("user-negcache-expiry"))?.verificationUnavailable).toBe(true);
      Date.now = () => realNow() + __negativeCacheTtlMsForTests + 1;
      const after = await getEntitlements("user-negcache-expiry");
      expect(after?.verificationUnavailable).toBeUndefined();
      expect(after?.features.tier).toBe(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      Date.now = realNow;
      if (originalSiteUrl === undefined) delete process.env.CONVEX_SITE_URL;
      else process.env.CONVEX_SITE_URL = originalSiteUrl;
      if (originalSecret === undefined) delete process.env.CONVEX_SERVER_SHARED_SECRET;
      else process.env.CONVEX_SERVER_SHARED_SECRET = originalSecret;
      vi.unstubAllGlobals();
      vi.mocked(getCachedJson).mockResolvedValue(null);
      __resetEntitlementNegativeCacheForTests();
    }
  });

  test("the window stays strictly inside the Retry-After the same state advertises", () => {
    // Load-bearing inequality, not a style preference: if the negative cache
    // outlived the advertised delay, a client that correctly honors
    // `Retry-After: 5` would retry straight back into the cached failure and the
    // outage would outlive the outage.
    const advertised = classifyBillingVerification({ verificationUnavailable: true });
    expect(__negativeCacheTtlMsForTests).toBeLessThan(advertised!.retryAfterSeconds * 1_000);
  });

  test("a confirmed row is never negative-cached", async () => {
    __resetEntitlementNegativeCacheForTests();
    const originalSiteUrl = process.env.CONVEX_SITE_URL;
    const originalSecret = process.env.CONVEX_SERVER_SHARED_SECRET;
    process.env.CONVEX_SITE_URL = "https://example-deployment.convex.site";
    process.env.CONVEX_SERVER_SHARED_SECRET = "test-secret";
    vi.mocked(getCachedJson).mockResolvedValue(null);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(makeEntitlements(1, "pro_monthly")), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      await getEntitlements("user-negcache-confirmed");
      await getEntitlements("user-negcache-confirmed");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      if (originalSiteUrl === undefined) delete process.env.CONVEX_SITE_URL;
      else process.env.CONVEX_SITE_URL = originalSiteUrl;
      if (originalSecret === undefined) delete process.env.CONVEX_SERVER_SHARED_SECRET;
      else process.env.CONVEX_SERVER_SHARED_SECRET = originalSecret;
      vi.unstubAllGlobals();
      vi.mocked(getCachedJson).mockResolvedValue(null);
      __resetEntitlementNegativeCacheForTests();
    }
  });

  test("stays bounded under a fleet-wide outage, and eviction does not break the answer", async () => {
    // The cap's whole purpose is the fleet-wide-outage case: one entry per active
    // user for the life of the isolate. That branch only fires above the cap, so
    // it is unreachable from any test that does not actually cross it.
    __resetEntitlementNegativeCacheForTests();
    const originalSiteUrl = process.env.CONVEX_SITE_URL;
    const originalSecret = process.env.CONVEX_SERVER_SHARED_SECRET;
    process.env.CONVEX_SITE_URL = "https://example-deployment.convex.site";
    process.env.CONVEX_SERVER_SHARED_SECRET = "test-secret";
    vi.mocked(getCachedJson).mockResolvedValue(null);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("fetch failed")));
    try {
      const overflow = __negativeCacheMaxEntriesForTests + 200;
      for (let i = 0; i < overflow; i++) {
        const ent = await getEntitlements(`user-negcache-flood-${i}`);
        // Every user still gets the correct deny-side answer while evicting.
        expect(ent?.verificationUnavailable).toBe(true);
      }

      expect(__negativeCacheSizeForTests()).toBeLessThanOrEqual(
        __negativeCacheMaxEntriesForTests,
      );
      // Eviction drops the OLDEST insertions, so the most recent user is still
      // cached — an eviction policy that dropped the newest would make the cache
      // useless precisely when it is needed.
      const lastUser = `user-negcache-flood-${overflow - 1}`;
      const fetchMock = vi.fn().mockRejectedValue(new Error("fetch failed"));
      vi.stubGlobal("fetch", fetchMock);
      expect((await getEntitlements(lastUser))?.verificationUnavailable).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      if (originalSiteUrl === undefined) delete process.env.CONVEX_SITE_URL;
      else process.env.CONVEX_SITE_URL = originalSiteUrl;
      if (originalSecret === undefined) delete process.env.CONVEX_SERVER_SHARED_SECRET;
      else process.env.CONVEX_SERVER_SHARED_SECRET = originalSecret;
      vi.unstubAllGlobals();
      vi.mocked(getCachedJson).mockResolvedValue(null);
      __resetEntitlementNegativeCacheForTests();
    }
  });

  test.each([
    "renewal_verification_pending",
    "renewal_verification_failed",
  ] as const)("a CONFIRMED %s row is never negative-cached", async (billingStatus) => {
    // Scope pin for the TTL/Retry-After inequality above. That invariant is
    // verified against the synthesized marker's fixed 5s delay. The renewal codes
    // carry a PROVIDER-supplied delay that can be as low as 1s — below the 3s
    // window — so if a future change ever negative-cached them, the inequality
    // would silently invert and an honoring client would retry into a cached
    // failure. These rows have their own (Redis) marker TTL and must stay out.
    __resetEntitlementNegativeCacheForTests();
    const row = {
      ...makeEntitlements(0),
      validUntil: 0,
      billingStatus,
      retryAfterSeconds: 1,
    };
    await withConvexEntitlementResponse(row, async () => {
      const ent = await getEntitlements(`user-negcache-${billingStatus}`);
      expect(ent?.billingStatus).toBe(billingStatus);
    });
    expect(__negativeCacheSizeForTests()).toBe(0);
    __resetEntitlementNegativeCacheForTests();
  });

  test("a fail-closed null is never negative-cached (a 4xx deploy defect keeps its hard posture)", async () => {
    __resetEntitlementNegativeCacheForTests();
    const originalSiteUrl = process.env.CONVEX_SITE_URL;
    const originalSecret = process.env.CONVEX_SERVER_SHARED_SECRET;
    process.env.CONVEX_SITE_URL = "https://example-deployment.convex.site";
    process.env.CONVEX_SERVER_SHARED_SECRET = "test-secret";
    vi.mocked(getCachedJson).mockResolvedValue(null);
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("forbidden", { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      expect(await getEntitlements("user-negcache-4xx")).toBeNull();
      expect(await getEntitlements("user-negcache-4xx")).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      if (originalSiteUrl === undefined) delete process.env.CONVEX_SITE_URL;
      else process.env.CONVEX_SITE_URL = originalSiteUrl;
      if (originalSecret === undefined) delete process.env.CONVEX_SERVER_SHARED_SECRET;
      else process.env.CONVEX_SERVER_SHARED_SECRET = originalSecret;
      vi.unstubAllGlobals();
      vi.mocked(getCachedJson).mockResolvedValue(null);
      __resetEntitlementNegativeCacheForTests();
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

  // #5379 — the misconfiguration edge of the null contract.
  test("MISCONFIG: absent Convex env returns null for everyone, permanently (not a transient blip)", async () => {
    // A deploy missing CONVEX_SITE_URL / CONVEX_SERVER_SHARED_SECRET takes the
    // early return at entitlement-check.ts, so every user resolves to null on
    // every request with no self-healing path — the 15-min cache cannot warm
    // what never resolves.
    //
    // Why this test lives here and matters elsewhere: the #4611 apiAccess gate
    // in server/gateway.ts deliberately fail-OPENS on null. Its "warm path
    // re-resolves" bound assumes the entitlement EVENTUALLY resolves, which this
    // case violates — so a missing env var silently disables that gate fleet-wide
    // and indefinitely. Pinning it here keeps the premise of that bound honest.
    // Save/restore in finally, matching this file's convention above — without
    // it the deleted env leaks into any test appended after this one.
    const originalSiteUrl = process.env.CONVEX_SITE_URL;
    const originalSecret = process.env.CONVEX_SERVER_SHARED_SECRET;
    delete process.env.CONVEX_SITE_URL;
    delete process.env.CONVEX_SERVER_SHARED_SECRET;
    vi.mocked(getCachedJson).mockResolvedValue(null); // cold cache, every call

    try {
      // Distinct userIds: repeated nulls, not one coalesced in-flight promise.
      expect(await getEntitlements("user_misconfig_a")).toBeNull();
      expect(await getEntitlements("user_misconfig_b")).toBeNull();
      // Same user twice — still null, i.e. no recovery on retry.
      expect(await getEntitlements("user_misconfig_a")).toBeNull();
    } finally {
      if (originalSiteUrl === undefined) delete process.env.CONVEX_SITE_URL;
      else process.env.CONVEX_SITE_URL = originalSiteUrl;
      if (originalSecret === undefined) delete process.env.CONVEX_SERVER_SHARED_SECRET;
      else process.env.CONVEX_SERVER_SHARED_SECRET = originalSecret;
    }
  });
});
