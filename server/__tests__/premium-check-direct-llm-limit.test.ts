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

const validateUserApiKey = vi.fn();
vi.mock("../_shared/user-api-key", () => ({
  validateUserApiKey: (...a: unknown[]) => validateUserApiKey(...a),
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
});

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

  test("LAPSED Pro Business bearer loses the paid allowance", async () => {
    validateBearerToken.mockResolvedValue({ valid: true, role: "free", userId: "u1" });
    getEntitlements.mockResolvedValue(entitlement(1, 2_500, LAPSED()));

    const identity = await resolvePremiumCallerIdentity(bearerRequest());

    // Premium-ness itself keys on tier alone (pre-existing); the SPEND limit
    // must not inherit a lapsed plan's allowance.
    expect(identity).toMatchObject({
      directLlmDailyLimit: DIRECT_LLM_UNVERIFIED_DAILY_QUOTA_LIMIT,
    });
  });

  test("LAPSED Enterprise bearer does not stay unlimited (null would skip the meter)", async () => {
    validateBearerToken.mockResolvedValue({ valid: true, role: "free", userId: "u1" });
    getEntitlements.mockResolvedValue(entitlement(3, null, LAPSED()));

    const identity = await resolvePremiumCallerIdentity(bearerRequest());

    expect(identity).toMatchObject({
      directLlmDailyLimit: DIRECT_LLM_UNVERIFIED_DAILY_QUOTA_LIMIT,
    });
    // A null here would make api/chat-analyst.ts skip reserveDirectLlmQuota
    // entirely -- no counter, and no fail-closed-on-Redis-outage path.
    expect((identity as { directLlmDailyLimit?: number | null }).directLlmDailyLimit).not.toBeNull();
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

  test("user-api-key caller with a LAPSED row loses the paid allowance", async () => {
    validateUserApiKey.mockResolvedValue({ userId: "u2" });
    getEntitlements.mockResolvedValue(entitlement(2, 10_000, LAPSED()));

    const identity = await resolvePremiumCallerIdentity(
      new Request("https://www.worldmonitor.app/api/chat-analyst", {
        method: "POST",
        headers: { "X-WorldMonitor-Key": "wm_key" },
      }),
    );

    expect(identity).toMatchObject({
      kind: "user-api-key",
      directLlmDailyLimit: DIRECT_LLM_UNVERIFIED_DAILY_QUOTA_LIMIT,
    });
  });

  test("user-api-key caller with an ACTIVE row keeps its catalog allowance", async () => {
    validateUserApiKey.mockResolvedValue({ userId: "u2" });
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
