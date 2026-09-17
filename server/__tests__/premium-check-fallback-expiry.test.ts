// @vitest-environment node

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "../../convex/schema";
import { PRODUCT_CATALOG } from "../../convex/config/productCatalog";
import { getFeaturesForPlan } from "../../convex/lib/entitlements";

vi.mock("../_shared/redis", () => ({
  getCachedJson: vi.fn(),
  setCachedJson: vi.fn(),
}));
vi.mock("../../api/_api-key.js", () => ({
  validateApiKey: vi.fn().mockResolvedValue({ valid: false, required: true }),
}));
vi.mock("../auth-session", () => ({ validateBearerToken: vi.fn() }));
vi.mock("../_shared/user-api-key", () => ({ validateUserApiKey: vi.fn() }));

import { getCachedJson, setCachedJson } from "../_shared/redis";
import { validateBearerToken } from "../auth-session";
import { validateUserApiKey } from "../_shared/user-api-key";
import {
  __resetEntitlementNegativeCacheForTests,
  getEntitlements,
  type CachedEntitlements,
} from "../_shared/entitlement-check";
import { resolvePremiumCallerIdentity } from "../_shared/premium-check";
import {
  getInternalMcpVerifiedNonce,
  INTERNAL_MCP_VERIFIED_HEADER,
  TRUSTED_USER_ID_HEADER,
} from "../_shared/mcp-internal-hmac";

const modules = import.meta.glob("../../convex/**/*.ts");
const NOW = 1_750_000_000_000;
const DAY = 86_400_000;
const USER = "user-fallback-expiry";
const SECRET = "test-convex-secret-fallback-expiry";
const cache = new Map<string, { value: unknown; expiresAt: number }>();

type Caller = "bearer" | "user-api-key" | "internal-mcp";
function requestFor(caller: Caller): Request {
  const headers: Record<string, string> = caller === "bearer"
    ? { Authorization: "Bearer test-token" }
    : caller === "user-api-key"
      ? { "X-WorldMonitor-Key": "wm_test-key" }
      : {
          [INTERNAL_MCP_VERIFIED_HEADER]: getInternalMcpVerifiedNonce(),
          [TRUSTED_USER_ID_HEADER]: USER,
        };
  return new Request("https://www.worldmonitor.app/api/chat-analyst", { headers });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubEnv("CONVEX_SITE_URL", "https://example.convex.site");
  vi.stubEnv("CONVEX_SERVER_SHARED_SECRET", SECRET);
  vi.stubEnv("WORLDMONITOR_VALID_KEYS", "operator-test-key");
  __resetEntitlementNegativeCacheForTests();
  cache.clear();
  vi.clearAllMocks();
  vi.mocked(validateBearerToken).mockResolvedValue({ valid: true, role: "free", userId: USER });
  vi.mocked(validateUserApiKey).mockResolvedValue({ userId: USER });
  vi.mocked(getCachedJson).mockImplementation(async (key) => {
    const entry = cache.get(key);
    return entry && entry.expiresAt > Date.now() ? structuredClone(entry.value) : null;
  });
  vi.mocked(setCachedJson).mockImplementation(async (key, value, ttl) => {
    cache.set(key, { value: structuredClone(value), expiresAt: Date.now() + ttl * 1_000 });
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  __resetEntitlementNegativeCacheForTests();
});

describe("Convex paid fallback through the marker cache and premium resolver", () => {
  for (const caller of ["bearer", "user-api-key", "internal-mcp"] as const) {
    test.each([
      ["pending", "renewal_verification_pending", 3],
      ["failed", "renewal_verification_failed", 60],
    ] as const)(`${caller}: current fallback survives %s marker, expired fallback denies`, async (
      verificationState, billingStatus, ttl,
    ) => {
      const t = convexTest(schema, modules);
      const planKey = caller === "user-api-key" ? "api_starter" : "pro_monthly";
      const validUntil = NOW + 1_000;
      await t.run(async (ctx) => {
        await ctx.db.insert("subscriptions", {
          userId: USER,
          dodoSubscriptionId: "sub_stale_enterprise",
          dodoProductId: PRODUCT_CATALOG.enterprise.dodoProductId!,
          planKey: "enterprise",
          status: "active",
          currentPeriodStart: NOW - 31 * DAY,
          currentPeriodEnd: NOW - DAY,
          renewalVerificationState: verificationState,
          renewalVerificationAttemptAt: NOW,
          rawPayload: {},
          updatedAt: NOW - DAY,
        });
        await ctx.db.insert("subscriptions", {
          userId: USER,
          dodoSubscriptionId: "sub_current_fallback",
          dodoProductId: PRODUCT_CATALOG[planKey].dodoProductId!,
          planKey,
          status: "active",
          currentPeriodStart: NOW - DAY,
          currentPeriodEnd: validUntil,
          rawPayload: {},
          updatedAt: NOW,
        });
        await ctx.db.insert("entitlements", {
          userId: USER,
          planKey: "enterprise",
          features: getFeaturesForPlan("enterprise"),
          validUntil: NOW - DAY,
          updatedAt: NOW - DAY,
        });
      });
      // Only the transport is replaced: execute the real Convex HTTP action,
      // queries and renewal fallback selection against actual test DB rows.
      const producerFetch = vi.fn(async (_url: unknown, init?: RequestInit) =>
        t.fetch("/api/internal-entitlements", init));
      vi.stubGlobal("fetch", producerFetch);

      const request = requestFor(caller);
      expect(await resolvePremiumCallerIdentity(request)).toMatchObject({
        isPremium: true,
        userId: USER,
        kind: caller,
        ...(caller === "internal-mcp" ? { quotaExempt: true } : {
          directLlmDailyLimit: getFeaturesForPlan(planKey).planLimits.dashboardAiCallsPerDay,
        }),
      });
      expect(vi.mocked(setCachedJson).mock.calls[0]?.[2]).toBe(ttl);
      expect(await getEntitlements(USER)).toMatchObject({ planKey, billingStatus, validUntil });

      vi.setSystemTime(validUntil);
      expect(await resolvePremiumCallerIdentity(request)).toMatchObject({ isPremium: true });
      vi.setSystemTime(validUntil + 1);
      // The marker remains cached with paid flags, by design, until its retry
      // TTL ends. Authorization must not mistake that TTL for paid coverage.
      expect(await getEntitlements(USER)).toMatchObject({
        planKey, billingStatus, validUntil, features: { tier: caller === "user-api-key" ? 2 : 1 },
      });
      expect(await resolvePremiumCallerIdentity(request)).toMatchObject({
        isPremium: false,
        billingDenial: { code: billingStatus, status: 503, retryable: true },
      });
      expect(producerFetch).toHaveBeenCalledTimes(1);
    });
  }

  test.each([NaN, Infinity, -Infinity])("non-finite validUntil %s cannot grant through any entitlement arm", async (validUntil) => {
    vi.mocked(getCachedJson).mockResolvedValue({
      planKey: "enterprise",
      features: getFeaturesForPlan("enterprise"),
      validUntil,
      billingStatus: "renewal_verification_pending",
    } satisfies CachedEntitlements);
    for (const caller of ["bearer", "user-api-key", "internal-mcp"] as const) {
      expect(await resolvePremiumCallerIdentity(requestFor(caller))).toMatchObject({
        isPremium: false, billingDenial: { code: "renewal_verification_pending" },
      });
    }
  });

  test("operator and complimentary role grants do not depend on an entitlement", async () => {
    expect(await resolvePremiumCallerIdentity(new Request("https://www.worldmonitor.app/api/chat-analyst", {
      headers: { "X-WorldMonitor-Key": "operator-test-key" },
    }))).toMatchObject({ isPremium: true, kind: "enterprise", quotaExempt: true });
    vi.mocked(validateBearerToken).mockResolvedValue({ valid: true, role: "pro", userId: USER });
    expect(await resolvePremiumCallerIdentity(requestFor("bearer"))).toMatchObject({
      isPremium: true, kind: "bearer", directLlmDailyLimit: 50,
    });
    expect(getCachedJson).not.toHaveBeenCalled();
  });
});
