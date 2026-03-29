// @vitest-environment node

/**
 * Unit tests for gateway entitlement check logic.
 *
 * Mocking strategy: Uses the dependency injection pattern via _testCheckEntitlement
 * which accepts a getEntitlementsFn parameter. This avoids needing to mock Redis
 * or ConvexHttpClient -- we inject a fake getEntitlements directly.
 *
 * For pure function tests (getRequiredTier, checkEntitlement with ungated),
 * we use the real functions without mocking.
 *
 * Per-file @vitest-environment node override avoids edge-runtime's missing
 * process.env (the module reads process.env.CONVEX_URL on import).
 */

import { describe, test, expect, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock the Redis dependency so the module loads without a real Redis connection
// ---------------------------------------------------------------------------
vi.mock("../_shared/redis", () => ({
  getCachedJson: vi.fn().mockResolvedValue(null),
  setCachedJson: vi.fn().mockResolvedValue(undefined),
}));

import {
  getRequiredTier,
  _testCheckEntitlement,
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("gateway entitlement check", () => {
  test("getRequiredTier returns tier for gated endpoint", () => {
    expect(getRequiredTier("/api/market/v1/analyze-stock")).toBe(2);
  });

  test("getRequiredTier returns null for ungated endpoint", () => {
    expect(getRequiredTier("/api/seismology/v1/list-earthquakes")).toBeNull();
  });

  test("checkEntitlement returns null for ungated endpoint", async () => {
    const req = makeRequest("/api/seismology/v1/list-earthquakes");
    // Use _testCheckEntitlement with a dummy fn -- it won't be called for ungated
    const result = await _testCheckEntitlement(
      req,
      "/api/seismology/v1/list-earthquakes",
      {},
      async () => null,
    );
    expect(result).toBeNull();
  });

  test("checkEntitlement returns 403 when no userId in request (fail-closed)", async () => {
    // Gated endpoint but no x-user-id header -> 403 (authentication required)
    const req = makeRequest("/api/market/v1/analyze-stock");
    const result = await _testCheckEntitlement(
      req,
      "/api/market/v1/analyze-stock",
      {},
      async () => {
        throw new Error("should not be called");
      },
    );
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);

    const body = await result!.json();
    expect(body.error).toBe("Authentication required");
    expect(body.requiredTier).toBe(2);
  });

  test("checkEntitlement returns 403 when getEntitlements returns null (fail-closed)", async () => {
    // Gated endpoint with userId but entitlement lookup fails -> 403
    const req = makeRequest("/api/market/v1/analyze-stock", {
      "x-user-id": "test-user",
    });
    const result = await _testCheckEntitlement(
      req,
      "/api/market/v1/analyze-stock",
      {},
      async () => null,
    );
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);

    const body = await result!.json();
    expect(body.error).toBe("Unable to verify entitlements");
    expect(body.requiredTier).toBe(2);
  });

  test("checkEntitlement returns 403 for insufficient tier", async () => {
    const mockGetEntitlements = vi.fn().mockResolvedValue({
      planKey: "free",
      features: {
        tier: 0,
        apiAccess: false,
        apiRateLimit: 0,
        maxDashboards: 3,
        prioritySupport: false,
        exportFormats: ["csv"],
      },
      validUntil: FUTURE,
    });

    const req = makeRequest("/api/market/v1/analyze-stock", {
      "x-user-id": "test-user",
    });
    const result = await _testCheckEntitlement(
      req,
      "/api/market/v1/analyze-stock",
      {},
      mockGetEntitlements,
    );

    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);

    const body = await result!.json();
    expect(body.error).toBe("Upgrade required");
    expect(body.requiredTier).toBe(2);
    expect(body.currentTier).toBe(0);
  });

  test("checkEntitlement returns null for sufficient tier", async () => {
    const mockGetEntitlements = vi.fn().mockResolvedValue({
      planKey: "api_starter",
      features: {
        tier: 2,
        apiAccess: true,
        apiRateLimit: 60,
        maxDashboards: 25,
        prioritySupport: false,
        exportFormats: ["csv", "pdf", "json"],
      },
      validUntil: FUTURE,
    });

    const req = makeRequest("/api/market/v1/analyze-stock", {
      "x-user-id": "test-user",
    });
    const result = await _testCheckEntitlement(
      req,
      "/api/market/v1/analyze-stock",
      {},
      mockGetEntitlements,
    );
    expect(result).toBeNull();
  });
});
