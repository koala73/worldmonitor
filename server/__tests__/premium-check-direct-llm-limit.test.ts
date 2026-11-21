// @vitest-environment node
//
// #6105 review: `api/chat-analyst.ts` forwards `premiumIdentity.directLlmDailyLimit`
// straight into `reserveDirectLlmQuota`, and it INCRs the SAME
// `llm:direct-usage:<userId>:<date>` key the gateway does. Nothing covered that
// forwarding, so an arm could be added without a limit — and an absent field
// used to fall through to the paid default, making one counter enforce two
// caps. These pin the limit every identity arm resolves.

import { beforeEach, describe, expect, test, vi } from "vitest";

const validateApiKey = vi.fn();
vi.mock("../../api/_api-key.js", () => ({
  validateApiKey: (...a: unknown[]) => validateApiKey(...a),
}));

vi.mock("../../api/_crypto.js", () => ({
  timingSafeIncludes: () => false,
}));

const validateBearerToken = vi.fn();
vi.mock("../auth-session", () => ({
  validateBearerToken: (...a: unknown[]) => validateBearerToken(...a),
}));

const getEntitlements = vi.fn();
vi.mock("../_shared/entitlement-check", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../_shared/entitlement-check")>();
  return {
    ...actual,
    getEntitlements: (...a: unknown[]) => getEntitlements(...a),
  };
});

// The premium resolver reads the desktop-aware principal (plan 2026-10-25-001
// U4); the generic validator stays mocked for any sibling import.
const validateUserApiKey = vi.fn();
const validateUserApiKeyPrincipal = vi.fn();
vi.mock("../_shared/user-api-key", () => ({
  validateUserApiKey: (...a: unknown[]) => validateUserApiKey(...a),
  validateUserApiKeyPrincipal: (...a: unknown[]) => validateUserApiKeyPrincipal(...a),
}));

vi.mock("../_shared/mcp-internal-hmac", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../_shared/mcp-internal-hmac")>();
  return { ...actual, getInternalMcpVerifiedNonce: () => null };
});

import { resolvePremiumCallerIdentity } from "../_shared/premium-check";
import { DIRECT_LLM_UNVERIFIED_DAILY_QUOTA_LIMIT } from "../_shared/direct-llm-quota";

const ACTIVE = () => Date.now() + 60_000;
const LAPSED = () => Date.now() - 60_000;

function entitlement(
  tier: number,
  dashboardAiCallsPerDay: number | null | undefined,
  validUntil: number,
  extra: Record<string, unknown> = {},
) {
  return {
    planKey: "test",
    features: {
      tier,
      apiAccess: tier >= 2,
      apiRateLimit: 0,
      maxDashboards: 10,
      prioritySupport: false,
      exportFormats: [],
      ...(dashboardAiCallsPerDay === undefined
        ? {}
        : { planLimits: { dashboardAiCallsPerDay } }),
    },
    validUntil,
    ...extra,
  };
}

function bearerRequest() {
  return new Request("https://www.worldmonitor.app/api/chat-analyst", {
    method: "POST",
    headers: { Authorization: "Bearer token" },
  });
}

beforeEach(() => {
  validateApiKey.mockReset().mockResolvedValue({ valid: false, required: true });
  validateBearerToken.mockReset();
  getEntitlements.mockReset().mockResolvedValue(null);
  validateUserApiKey.mockReset().mockResolvedValue(null);
  validateUserApiKeyPrincipal.mockReset().mockResolvedValue(null);
});

function principal(keyKind: "api" | "desktop", activeKeyRank?: number) {
  return {
    userId: "u2",
    keyId: "key_2",
    keyKind,
    keyHash: "a".repeat(64),
    ...(activeKeyRank === undefined ? {} : { activeKeyRank }),
  };
}

function keyRequest(path = "/api/chat-analyst") {
  return new Request(`https://www.worldmonitor.app${path}`, {
    method: "POST",
    headers: { "X-WorldMonitor-Key": "wm_key" },
  });
}

/** Catalog-shaped Pro row: desktopKeyAccess on, two keys, no apiAccess. */
function proRow(validUntil: number, extra: Record<string, unknown> = {}) {
  return {
    planKey: "pro_monthly",
    features: {
      tier: 1,
      apiAccess: false,
      apiRateLimit: 0,
      maxDashboards: 10,
      prioritySupport: false,
      exportFormats: [],
      mcpAccess: true,
      desktopKeyAccess: true,
      maxDesktopKeys: 2,
      planLimits: { dashboardAiCallsPerDay: 500, desktopKeyRequestsPerDay: 7_500, desktopKeyBurstPerMinute: 120 },
    },
    validUntil,
    ...extra,
  };
}

describe("premium identity carries a direct-LLM limit for every arm", () => {
  test("active Pro Business bearer gets its catalog allowance", async () => {
    validateBearerToken.mockResolvedValue({ valid: true, role: "free", userId: "u1" });
    getEntitlements.mockResolvedValue(entitlement(1, 2_500, ACTIVE()));

    const identity = await resolvePremiumCallerIdentity(bearerRequest());

    expect(identity).toMatchObject({
      isPremium: true,
      kind: "bearer",
      directLlmDailyLimit: 2_500,
    });
  });

  test("LAPSED Pro Business bearer loses premium access", async () => {
    validateBearerToken.mockResolvedValue({ valid: true, role: "free", userId: "u1" });
    getEntitlements.mockResolvedValue(entitlement(1, 2_500, LAPSED()));

    const identity = await resolvePremiumCallerIdentity(bearerRequest());

    expect(identity).toMatchObject({
      isPremium: false,
    });
  });

  test("LAPSED Enterprise bearer loses premium access", async () => {
    validateBearerToken.mockResolvedValue({ valid: true, role: "free", userId: "u1" });
    getEntitlements.mockResolvedValue(entitlement(3, null, LAPSED()));

    const identity = await resolvePremiumCallerIdentity(bearerRequest());

    expect(identity).toMatchObject({
      isPremium: false,
    });
    expect(identity).not.toHaveProperty("directLlmDailyLimit");
  });

  test("active Enterprise bearer IS unlimited", async () => {
    validateBearerToken.mockResolvedValue({ valid: true, role: "free", userId: "u1" });
    getEntitlements.mockResolvedValue(entitlement(3, null, ACTIVE()));

    const identity = await resolvePremiumCallerIdentity(bearerRequest());

    expect(identity).toMatchObject({ isPremium: true, directLlmDailyLimit: null });
  });

  test("Clerk-role 'pro' grant states the unverified floor rather than omitting it", async () => {
    validateBearerToken.mockResolvedValue({ valid: true, role: "pro", userId: "u1" });

    const identity = await resolvePremiumCallerIdentity(bearerRequest());

    expect(identity).toMatchObject({
      isPremium: true,
      kind: "bearer",
      directLlmDailyLimit: DIRECT_LLM_UNVERIFIED_DAILY_QUOTA_LIMIT,
    });
  });

  test("user-api-key caller with a LAPSED row loses premium access", async () => {
    validateUserApiKeyPrincipal.mockResolvedValue(principal("api", 0));
    getEntitlements.mockResolvedValue(entitlement(2, 10_000, LAPSED()));

    const identity = await resolvePremiumCallerIdentity(
      new Request("https://www.worldmonitor.app/api/chat-analyst", {
        method: "POST",
        headers: { "X-WorldMonitor-Key": "wm_key" },
      }),
    );

    expect(identity).toMatchObject({
      isPremium: false,
    });
  });

  test("user-api-key caller with an ACTIVE row keeps its catalog allowance", async () => {
    validateUserApiKeyPrincipal.mockResolvedValue(principal("api", 0));
    getEntitlements.mockResolvedValue(entitlement(2, 10_000, ACTIVE()));

    const identity = await resolvePremiumCallerIdentity(
      new Request("https://www.worldmonitor.app/api/chat-analyst", {
        method: "POST",
        headers: { "X-WorldMonitor-Key": "wm_key" },
      }),
    );

    expect(identity).toMatchObject({
      kind: "user-api-key",
      directLlmDailyLimit: 10_000,
    });
  });
});

describe("desktop-key principals in the premium resolver (plan 2026-10-25-001 U4)", () => {
  test("AE1: a desktop key of a covered Pro owner is premium with the Pro direct-LLM allowance and its meter inputs", async () => {
    validateUserApiKeyPrincipal.mockResolvedValue(principal("desktop", 0));
    getEntitlements.mockResolvedValue(proRow(ACTIVE()));

    const identity = await resolvePremiumCallerIdentity(keyRequest());

    expect(identity).toMatchObject({
      isPremium: true,
      userId: "u2",
      kind: "desktop-key",
      quotaExempt: false,
      directLlmDailyLimit: 500,
      enterprisePlan: false,
      // What a standalone edge needs to charge the desktop meter (KTD6 / R6)
      // without a second entitlement read: the plan and its sold limits.
      desktopKeyMeter: {
        planKey: "pro_monthly",
        features: { planLimits: { desktopKeyRequestsPerDay: 7_500, desktopKeyBurstPerMinute: 120 } },
      },
    });
    expect(getEntitlements).toHaveBeenCalledTimes(1);
  });

  test("R5: desktop-kind keys of an owner without apiAccess are capped by rank; an unknown rank fails closed", async () => {
    getEntitlements.mockResolvedValue(proRow(ACTIVE()));

    validateUserApiKeyPrincipal.mockResolvedValue(principal("desktop", 1));
    expect(await resolvePremiumCallerIdentity(keyRequest())).toMatchObject({ isPremium: true, kind: "desktop-key" });

    validateUserApiKeyPrincipal.mockResolvedValue(principal("desktop", 2));
    const third = await resolvePremiumCallerIdentity(keyRequest());
    expect(third).toMatchObject({ isPremium: false });
    expect((third as { billingDenial?: unknown }).billingDenial).toBeUndefined();

    validateUserApiKeyPrincipal.mockResolvedValue(principal("desktop"));
    expect(await resolvePremiumCallerIdentity(keyRequest())).toMatchObject({ isPremium: false });
  });

  test("a warm pre-deploy Pro entry (no desktopKeyAccess) is re-read with the desktop shape required", async () => {
    const legacy = proRow(ACTIVE());
    delete (legacy.features as { desktopKeyAccess?: boolean }).desktopKeyAccess;
    getEntitlements.mockImplementation(async (_userId: string, options?: { requireDesktopKeyShape?: boolean }) =>
      options?.requireDesktopKeyShape ? proRow(ACTIVE()) : legacy);
    validateUserApiKeyPrincipal.mockResolvedValue(principal("desktop", 0));

    expect(await resolvePremiumCallerIdentity(keyRequest())).toMatchObject({ isPremium: true, kind: "desktop-key" });
    expect(getEntitlements).toHaveBeenCalledTimes(2);
    expect(getEntitlements).toHaveBeenLastCalledWith("u2", { requireDesktopKeyShape: true });
  });

  test("an api key whose owner has apiAccess never asks for the desktop shape", async () => {
    getEntitlements.mockResolvedValue(entitlement(2, 10_000, ACTIVE()));
    validateUserApiKeyPrincipal.mockResolvedValue(principal("api", 0));

    expect(await resolvePremiumCallerIdentity(keyRequest())).toMatchObject({ isPremium: true, kind: "user-api-key" });
    expect(getEntitlements).toHaveBeenCalledTimes(1);
    expect(getEntitlements).toHaveBeenCalledWith("u2");
  });

  test("AE2: a desktop key on an API-only path is denied without a billing upsell", async () => {
    validateUserApiKeyPrincipal.mockResolvedValue(principal("desktop", 0));
    getEntitlements.mockResolvedValue(proRow(ACTIVE()));

    for (const path of ["/api/v2/shipping/route-intelligence", "/api/v2/shipping/webhooks", "/api/mcp", "/api/oauth/authorize"]) {
      const identity = await resolvePremiumCallerIdentity(keyRequest(path));
      expect(identity).toMatchObject({ isPremium: false });
      expect((identity as { billingDenial?: unknown }).billingDenial).toBeUndefined();
    }
  });

  test("AE4: a lapsed Pro owner's desktop key carries the lapse classification", async () => {
    validateUserApiKeyPrincipal.mockResolvedValue(principal("desktop", 0));
    getEntitlements.mockResolvedValue(proRow(LAPSED(), { billingStatus: "subscription_lapsed" }));

    const identity = await resolvePremiumCallerIdentity(keyRequest());

    expect(identity).toMatchObject({ isPremium: false, billingDenial: { code: "subscription_lapsed" } });
  });

  test("AE6: a downgraded owner's api key within maxDesktopKeys is a desktop principal; beyond it is denied", async () => {
    getEntitlements.mockResolvedValue(proRow(ACTIVE()));

    validateUserApiKeyPrincipal.mockResolvedValue(principal("api", 1));
    expect(await resolvePremiumCallerIdentity(keyRequest())).toMatchObject({
      isPremium: true,
      kind: "desktop-key",
      directLlmDailyLimit: 500,
    });

    validateUserApiKeyPrincipal.mockResolvedValue(principal("api", 2));
    const beyond = await resolvePremiumCallerIdentity(keyRequest());
    expect(beyond).toMatchObject({ isPremium: false });
    expect((beyond as { billingDenial?: unknown }).billingDenial).toBeUndefined();

    // A rank the cache does not carry yet fails closed, never open.
    validateUserApiKeyPrincipal.mockResolvedValue(principal("api"));
    expect(await resolvePremiumCallerIdentity(keyRequest())).toMatchObject({ isPremium: false });
  });

  test("AE7: a desktop key of an API-plan owner stays premium (no rank needed: API plans sell 0 slots) and is still denied on REST v2", async () => {
    validateUserApiKeyPrincipal.mockResolvedValue(principal("desktop"));
    getEntitlements.mockResolvedValue(entitlement(2, 10_000, ACTIVE()));

    expect(await resolvePremiumCallerIdentity(keyRequest())).toMatchObject({
      isPremium: true,
      kind: "desktop-key",
      directLlmDailyLimit: 10_000,
    });
    expect(await resolvePremiumCallerIdentity(keyRequest("/api/v2/shipping/route-intelligence"))).toMatchObject({
      isPremium: false,
    });
  });

  test("an api key whose owner has apiAccess keeps today's identity on API-only paths", async () => {
    validateUserApiKeyPrincipal.mockResolvedValue(principal("api", 0));
    getEntitlements.mockResolvedValue(entitlement(2, 10_000, ACTIVE()));

    expect(await resolvePremiumCallerIdentity(keyRequest("/api/v2/shipping/route-intelligence"))).toMatchObject({
      isPremium: true,
      kind: "user-api-key",
    });
  });

  test("a desktop key whose owner has no desktop entitlement (free) is denied", async () => {
    validateUserApiKeyPrincipal.mockResolvedValue(principal("desktop"));
    getEntitlements.mockResolvedValue(entitlement(0, undefined, ACTIVE()));

    expect(await resolvePremiumCallerIdentity(keyRequest())).toMatchObject({ isPremium: false });
  });
});
