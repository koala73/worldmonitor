// @vitest-environment node

/**
 * #4771 — the widget-agent Clerk-bearer path must surface structured
 * billing-verification denials (403/503 + `code` + X-Billing-Verification +
 * Retry-After) BEFORE its legacy generic 403, using the same
 * getBillingVerificationDenial helper as the gateway (server/gateway.ts) and
 * MCP (api/mcp/auth.ts). Mirrors the vi.mock pattern of
 * gateway-user-key-apiaccess.test.ts: auth-session and getEntitlements are
 * stubbed, the denial helper itself is the REAL implementation, and the
 * assertions run against the actual Response the handler returns.
 */

import { describe, test, expect, vi, beforeEach } from "vitest";

const validateBearerToken = vi.fn();
vi.mock("../auth-session", () => ({
  validateBearerToken: (...a: unknown[]) => validateBearerToken(...a),
}));

const getEntitlements = vi.fn();
vi.mock("../_shared/entitlement-check", async (importActual) => {
  const actual = await importActual<typeof import("../_shared/entitlement-check")>();
  return {
    ...actual,
    getEntitlements: (...a: unknown[]) => getEntitlements(...a),
  };
});

// api/widget-agent.ts reads these at module load.
process.env.WIDGET_AGENT_KEY = "server-widget-key";
process.env.PRO_WIDGET_KEY = "server-pro-key";

const { default: handler } = await import("../../api/widget-agent");

const FREE_FEATURES = {
  tier: 0,
  apiAccess: false,
  apiRateLimit: 0,
  maxDashboards: 1,
  prioritySupport: false,
  exportFormats: [] as string[],
};

function bearerRequest(): Request {
  return new Request("https://www.worldmonitor.app/api/widget-agent", {
    method: "POST",
    headers: {
      Origin: "https://www.worldmonitor.app",
      "Content-Type": "application/json",
      Authorization: "Bearer test-session-token",
    },
    body: JSON.stringify({ prompt: "Build a widget", mode: "create", tier: "basic" }),
  });
}

beforeEach(() => {
  validateBearerToken.mockReset();
  getEntitlements.mockReset();
  validateBearerToken.mockResolvedValue({ valid: true, userId: "user_wa_billing", role: "free" });
});

describe("widget-agent billing-verification denial (#4771)", () => {
  test("renewal_verification_pending: 503 + code + marker header + Retry-After", async () => {
    getEntitlements.mockResolvedValue({
      planKey: "pro_monthly",
      features: FREE_FEATURES,
      validUntil: 0,
      billingStatus: "renewal_verification_pending",
      retryAfterSeconds: 60,
    });

    const res = await handler(bearerRequest());
    expect(res.status).toBe(503);
    expect(res.headers.get("X-Billing-Verification")).toBe("renewal_verification_pending");
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://www.worldmonitor.app");
    const body = await res.json();
    expect(body.code).toBe("renewal_verification_pending");
  });

  test("subscription_lapsed: confirmed denial stays a 403 with the stable code", async () => {
    getEntitlements.mockResolvedValue({
      planKey: "pro_monthly",
      features: FREE_FEATURES,
      validUntil: 0,
      billingStatus: "subscription_lapsed",
    });

    const res = await handler(bearerRequest());
    expect(res.status).toBe(403);
    expect(res.headers.get("X-Billing-Verification")).toBe("subscription_lapsed");
    const body = await res.json();
    expect(body.code).toBe("subscription_lapsed");
  });

  test("verificationUnavailable marker: retryable 503, not a hard denial", async () => {
    getEntitlements.mockResolvedValue({
      planKey: "free",
      features: FREE_FEATURES,
      validUntil: 0,
      verificationUnavailable: true,
    });

    const res = await handler(bearerRequest());
    expect(res.status).toBe(503);
    expect(res.headers.get("X-Billing-Verification")).toBe("entitlement_verification_unavailable");
    expect(res.headers.get("Retry-After")).toBeTruthy();
    const body = await res.json();
    expect(body.code).toBe("entitlement_verification_unavailable");
  });

  test("plain free-tier row: legacy generic 403, no billing marker", async () => {
    getEntitlements.mockResolvedValue({
      planKey: "free",
      features: FREE_FEATURES,
      validUntil: 0,
    });

    const res = await handler(bearerRequest());
    expect(res.status).toBe(403);
    expect(res.headers.get("X-Billing-Verification")).toBeNull();
    const body = await res.json();
    expect(body.error).toBe("Pro subscription required");
    expect(body.code).toBeUndefined();
  });

  test("null entitlement lookup: fail-closed generic 403, no billing marker", async () => {
    getEntitlements.mockResolvedValue(null);

    const res = await handler(bearerRequest());
    expect(res.status).toBe(403);
    expect(res.headers.get("X-Billing-Verification")).toBeNull();
    const body = await res.json();
    expect(body.error).toBe("Pro subscription required");
  });
});
