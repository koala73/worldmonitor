// @vitest-environment node

/**
 * The edge entitlement carries an optional `account` block for members of a
 * live Enterprise contract (convex/entitlements.ts getEntitlementsByUserId).
 * These tests pin that the block reaches callers from both the Convex
 * fallback and the Redis cache, and that the cache write keeps it.
 */

import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("../_shared/redis", () => ({
  getCachedJson: vi.fn().mockResolvedValue(null),
  setCachedJson: vi.fn().mockResolvedValue(undefined),
}));

import { getCachedJson, setCachedJson } from "../_shared/redis";
import { getEntitlements, type CachedEntitlements } from "../_shared/entitlement-check";

const FUTURE = Date.now() + 30 * 86_400_000;

const ACCOUNT: NonNullable<CachedEntitlements["account"]> = {
  id: "k17acct0000000000000000000000",
  dailyAllowance: 50_000,
  perMinuteBurst: 300,
  breakerMultiple: 5,
  monthlyInputTokens: 50_000_000,
  monthlyOutputTokens: 5_000_000,
};

function enterpriseEntitlement(account?: CachedEntitlements["account"]): CachedEntitlements {
  return {
    planKey: "enterprise",
    features: {
      tier: 3,
      apiAccess: true,
      apiRateLimit: 1_000,
      maxDashboards: 100,
      prioritySupport: true,
      exportFormats: ["csv", "json", "pdf"],
      mcpAccess: true,
      embedAccess: true,
      dataExport: true,
      // The catalog's Enterprise shape: MCP spends the shared API budget. A
      // numeric mcpCallsPerDay beside apiAccess is a pre-marker cache entry,
      // which the cache read treats as stale.
      planLimits: {
        apiRequestsPerDay: 10_000,
        apiBurstRequestsPerMinute: 300,
        mcpCallsPerDay: "shared-api-budget",
        dashboardAiCallsPerDay: 10_000,
        mcpBurstRequestsPerMinute: 300,
      },
    },
    validUntil: FUTURE,
    ...(account ? { account } : {}),
  };
}

async function withConvexResponse<T>(payload: unknown, run: () => Promise<T>): Promise<T> {
  vi.stubEnv("CONVEX_SITE_URL", "https://example-deployment.convex.site");
  vi.stubEnv("CONVEX_SERVER_SHARED_SECRET", "test-secret");
  vi.mocked(getCachedJson).mockResolvedValueOnce(null);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(payload)));
  try {
    return await run();
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
}

afterEach(() => {
  vi.mocked(getCachedJson).mockReset().mockResolvedValue(null);
  vi.mocked(setCachedJson).mockReset().mockResolvedValue(true);
});

describe("edge entitlement account block", () => {
  test("a member's Convex answer reaches the caller with the account block and is cached with it", async () => {
    const ent = await withConvexResponse(enterpriseEntitlement(ACCOUNT), () => getEntitlements("user_member_convex"));
    expect(ent?.account).toEqual(ACCOUNT);
    expect(vi.mocked(setCachedJson)).toHaveBeenCalledTimes(1);
    const [key, value] = vi.mocked(setCachedJson).mock.calls[0]!;
    expect(key).toMatch(/^entitlements:[a-z]+:user_member_convex$/);
    expect((value as CachedEntitlements).account).toEqual(ACCOUNT);
  });

  test("a non-member's answer has no account block", async () => {
    const ent = await withConvexResponse(enterpriseEntitlement(), () => getEntitlements("user_non_member"));
    expect(ent).not.toBeNull();
    expect(ent && "account" in ent).toBe(false);
  });

  test("a cached entry with an account block is served unchanged", async () => {
    const cached = enterpriseEntitlement(ACCOUNT);
    vi.mocked(getCachedJson).mockResolvedValueOnce(structuredClone(cached));
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const ent = await getEntitlements("user_member_cached");
      expect(ent).toEqual(cached);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
