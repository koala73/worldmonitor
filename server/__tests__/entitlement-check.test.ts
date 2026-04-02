// @vitest-environment node

/**
 * Unit tests for gateway entitlement check logic.
 *
 * Mocking strategy: Controls the Redis mock return value to steer what
 * getEntitlements returns — no dependency injection needed. Since CONVEX_URL
 * is not set in tests, the Convex fallback is skipped and getCachedJson is
 * the sole source of entitlement data.
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
    },
    validUntil: FUTURE,
  };
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
    expect(body.requiredTier).toBe(2);
  });

  test("checkEntitlement returns 403 when getEntitlements returns null (fail-closed)", async () => {
    // getCachedJson returns null by default (no Redis data, no Convex URL) -> null entitlements
    const req = makeRequest("/api/market/v1/analyze-stock", { "x-user-id": "test-user" });
    const result = await checkEntitlement(req, "/api/market/v1/analyze-stock", {});
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);

    const body = await result!.json();
    expect(body.error).toBe("Unable to verify entitlements");
    expect(body.requiredTier).toBe(2);
  });

  test("checkEntitlement returns 403 for insufficient tier", async () => {
    vi.mocked(getCachedJson).mockResolvedValueOnce(makeEntitlements(0));

    const req = makeRequest("/api/market/v1/analyze-stock", { "x-user-id": "test-user" });
    const result = await checkEntitlement(req, "/api/market/v1/analyze-stock", {});

    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);

    const body = await result!.json();
    expect(body.error).toBe("Upgrade required");
    expect(body.requiredTier).toBe(2);
    expect(body.currentTier).toBe(0);
  });

  test("checkEntitlement returns null for sufficient tier", async () => {
    vi.mocked(getCachedJson).mockResolvedValueOnce(makeEntitlements(2, "api_starter"));

    const req = makeRequest("/api/market/v1/analyze-stock", { "x-user-id": "test-user" });
    const result = await checkEntitlement(req, "/api/market/v1/analyze-stock", {});
    expect(result).toBeNull();
  });
});
