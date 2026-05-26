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

import { getCachedJson } from "../_shared/redis";
import {
  getRequiredTier,
  checkEntitlement,
} from "../_shared/entitlement-check";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FUTURE = Date.now() + 86400000 * 30;

function makeRequest(
  pathname: string,
  headers: Record<string, string> = {},
): Request {
  return new Request(`https://worldmonitor.app${pathname}`, { headers });
}

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("gateway entitlement check", () => {
  test.each([
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
    const req = makeRequest("/api/seismology/v1/list-earthquakes");
    const result = await checkEntitlement(req, "/api/seismology/v1/list-earthquakes", {});
    expect(result).toBeNull();
  });

  test("checkEntitlement returns 403 when no userId in request (fail-closed)", async () => {
    const req = makeRequest("/api/market/v1/analyze-stock");
    const result = await checkEntitlement(req, "/api/market/v1/analyze-stock", {});
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);

    const body = await result!.json();
    expect(body.error).toBe("Authentication required");
    expect(body.requiredTier).toBe(1);
  });

  test("checkEntitlement returns 403 when getEntitlements returns null (fail-closed)", async () => {
    // getCachedJson returns null by default (no Redis data, no Convex URL) -> null entitlements
    const req = makeRequest("/api/market/v1/analyze-stock", { "x-user-id": "test-user" });
    const result = await checkEntitlement(req, "/api/market/v1/analyze-stock", {});
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);

    const body = await result!.json();
    expect(body.error).toBe("Unable to verify entitlements");
    expect(body.requiredTier).toBe(1);
  });

  test("checkEntitlement returns 403 for insufficient tier", async () => {
    vi.mocked(getCachedJson).mockResolvedValueOnce(makeEntitlements(0));

    const req = makeRequest("/api/market/v1/analyze-stock", { "x-user-id": "test-user" });
    const result = await checkEntitlement(req, "/api/market/v1/analyze-stock", {});

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

    const req = makeRequest("/api/market/v1/analyze-stock", { "x-user-id": "test-user" });
    const result = await checkEntitlement(req, "/api/market/v1/analyze-stock", {});
    expect(result).toBeNull();
  });

  test("checkEntitlement returns null for sufficient tier", async () => {
    vi.mocked(getCachedJson).mockResolvedValueOnce(makeEntitlements(2, "api_starter"));

    const req = makeRequest("/api/market/v1/analyze-stock", { "x-user-id": "test-user" });
    const result = await checkEntitlement(req, "/api/market/v1/analyze-stock", {});
    expect(result).toBeNull();
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
      const req = makeRequest("/api/market/v1/analyze-stock", { "x-user-id": "test-user" });
      const result = await checkEntitlement(req, "/api/market/v1/analyze-stock", {});

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
      const req = makeRequest("/api/market/v1/analyze-stock", { "x-user-id": "test-user" });
      const result = await checkEntitlement(req, "/api/market/v1/analyze-stock", {});

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
      const req = makeRequest("/api/market/v1/analyze-stock", { "x-user-id": "test-user" });
      const result = await checkEntitlement(req, "/api/market/v1/analyze-stock", {});
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
