// @vitest-environment node

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const checkEndpointRateLimit = vi.fn().mockResolvedValue(null);
const checkRateLimit = vi.fn().mockResolvedValue(null);
const checkFailClosedScopedIpRateLimit = vi.fn().mockResolvedValue(null);
vi.mock("../_shared/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../_shared/rate-limit")>();
  return {
    ...actual,
    checkRateLimit: (...a: unknown[]) => checkRateLimit(...a),
    checkEndpointRateLimit: (...a: unknown[]) => checkEndpointRateLimit(...a),
    checkFailClosedScopedIpRateLimit: (...a: unknown[]) => checkFailClosedScopedIpRateLimit(...a),
  };
});

const getEntitlements = vi.fn();
const checkEntitlementDetailed = vi.fn();
vi.mock("../_shared/entitlement-check", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../_shared/entitlement-check")>();
  return {
    ...actual,
    checkEntitlementDetailed: (...a: unknown[]) => checkEntitlementDetailed(...a),
    getEntitlements: (...a: unknown[]) => getEntitlements(...a),
  };
});

const resolveClerkSession = vi.fn();
vi.mock("../_shared/auth-session", () => ({
  resolveClerkSession: (...a: unknown[]) => resolveClerkSession(...a),
}));

const validateApiKey = vi.fn();
vi.mock("../../api/_api-key.js", () => ({
  USER_API_KEY_GATEWAY_VALIDATION_ERROR: "User API key requires gateway validation",
  validateApiKey: (...a: unknown[]) => validateApiKey(...a),
}));

const validateUserApiKey = vi.fn();
vi.mock("../_shared/user-api-key", () => ({
  validateUserApiKey: (...a: unknown[]) => validateUserApiKey(...a),
}));

const reserveDirectLlmQuota = vi.fn();
vi.mock("../_shared/direct-llm-quota", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../_shared/direct-llm-quota")>();
  return {
    ...actual,
    reserveDirectLlmQuota: (...a: unknown[]) => reserveDirectLlmQuota(...a),
  };
});

import { createDomainGateway } from "../gateway";
import { ENDPOINT_RATE_POLICIES } from "../_shared/rate-limit";
import { getRequiredTier } from "../_shared/entitlement-check";
import { PREMIUM_RPC_PATHS } from "../../src/shared/premium-paths";

const SUMMARIZE_PATH = "/api/news/v1/summarize-article";
const CACHE_PATH = "/api/news/v1/summarize-article-cache";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeRequest(path: string, headers: Record<string, string> = {}, method = "POST") {
  const init: RequestInit = { method, headers };
  if (method !== "GET" && method !== "HEAD") {
    init.body = JSON.stringify({ provider: "groq", headlines: ["headline"] });
  }
  return new Request(`https://www.worldmonitor.app${path}`, {
    ...init,
  });
}

function makeGateway(handlerCalls: { summarize: number; cache: number }) {
  return createDomainGateway([
    {
      method: "POST",
      path: SUMMARIZE_PATH,
      handler: async () => {
        handlerCalls.summarize += 1;
        return json({ ok: true, route: "summarize" });
      },
    },
    {
      method: "GET",
      path: CACHE_PATH,
      handler: async () => {
        handlerCalls.cache += 1;
        return json({ ok: true, route: "cache" });
      },
    },
  ]);
}

beforeEach(() => {
  checkEndpointRateLimit.mockReset().mockResolvedValue(null);
  checkRateLimit.mockReset().mockResolvedValue(null);
  checkFailClosedScopedIpRateLimit.mockReset().mockResolvedValue(null);
  checkEntitlementDetailed.mockReset().mockResolvedValue({ response: null, entitlements: null });
  getEntitlements.mockReset().mockResolvedValue(null);
  resolveClerkSession.mockReset().mockResolvedValue(null);
  validateApiKey.mockReset().mockResolvedValue({
    valid: false,
    required: true,
    error: "API key required",
  });
  validateUserApiKey.mockReset().mockResolvedValue(null);
  reserveDirectLlmQuota.mockReset().mockResolvedValue({
    ok: true,
    newCount: 1,
    rollback: async () => {},
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("summarize-article gateway spend controls", () => {
  test("route is explicitly premium-gated and endpoint-rate-limited", () => {
    expect(getRequiredTier(SUMMARIZE_PATH)).toBeNull();
    expect(PREMIUM_RPC_PATHS.has(SUMMARIZE_PATH)).toBe(false);
    expect(ENDPOINT_RATE_POLICIES[SUMMARIZE_PATH]).toEqual({ limit: 30, window: "60 s" });
  });

  test("anonymous wms_ sessions cannot reach non-translate summarize handler spend", async () => {
    validateApiKey.mockResolvedValue({ valid: true, required: false, kind: "session" });
    const calls = { summarize: 0, cache: 0 };

    const res = await makeGateway(calls)(
      makeRequest(SUMMARIZE_PATH, { "X-WorldMonitor-Key": "wms_anonymous_session" }),
      { waitUntil: () => {} },
    );

    expect(res.status).toBe(401);
    expect(calls.summarize).toBe(0);
    expect(checkEndpointRateLimit).toHaveBeenCalledWith(
      expect.any(Request),
      SUMMARIZE_PATH,
      expect.any(Object),
    );
    expect(reserveDirectLlmQuota).not.toHaveBeenCalled();
  });

  test("basic bearer sessions also pass through the scoped endpoint limiter", async () => {
    resolveClerkSession.mockResolvedValue({ userId: "free_user", orgId: null, role: "free" });
    validateApiKey.mockResolvedValue({ valid: true, required: false, kind: "session" });
    const calls = { summarize: 0, cache: 0 };

    const res = await makeGateway(calls)(
      makeRequest(SUMMARIZE_PATH, { Authorization: "Bearer free-session" }),
      { waitUntil: () => {} },
    );

    expect(res.status).toBe(200);
    expect(calls.summarize).toBe(1);
    expect(checkEndpointRateLimit).toHaveBeenCalledWith(
      expect.any(Request),
      SUMMARIZE_PATH,
      expect.any(Object),
    );
    expect(checkEntitlementDetailed).toHaveBeenCalledWith(
      "free_user",
      SUMMARIZE_PATH,
      expect.any(Object),
      { clerkRole: "free" },
    );
    expect(reserveDirectLlmQuota).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "free_user" }),
    );
  });

  test("active Pro bearer sessions use a principal-scoped endpoint rate-limit bucket", async () => {
    resolveClerkSession.mockResolvedValue({ userId: "pro_user", orgId: null, role: "pro" });
    getEntitlements.mockResolvedValue({
      planKey: "pro_monthly",
      features: { tier: 1 },
      validUntil: Date.now() + 86_400_000,
    });
    validateApiKey.mockResolvedValue({ valid: true, required: false, kind: "session" });
    const calls = { summarize: 0, cache: 0 };

    const res = await makeGateway(calls)(
      makeRequest(SUMMARIZE_PATH, { Authorization: "Bearer pro-session" }),
      { waitUntil: () => {} },
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, route: "summarize" });
    expect(checkEndpointRateLimit).toHaveBeenCalledWith(
      expect.any(Request),
      SUMMARIZE_PATH,
      expect.any(Object),
      { principalUserId: "pro_user" },
    );
    expect(checkFailClosedScopedIpRateLimit).toHaveBeenCalledWith(
      expect.any(Request),
      "summarize-article:principal-attribution",
      600,
      "60 s",
      expect.any(Object),
    );
    expect(reserveDirectLlmQuota).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "pro_user" }),
    );
    expect(calls.summarize).toBe(1);
  });

  test("pre-attribution IP guard rejects before entitlement lookup or handler execution", async () => {
    resolveClerkSession.mockResolvedValue({ userId: "pro_user", orgId: null, role: "pro" });
    validateApiKey.mockResolvedValue({ valid: true, required: false, kind: "session" });
    checkFailClosedScopedIpRateLimit.mockResolvedValue(json({ error: "Too many requests" }, 429));
    const calls = { summarize: 0, cache: 0 };

    const res = await makeGateway(calls)(
      makeRequest(SUMMARIZE_PATH, { Authorization: "Bearer pro-session" }),
      { waitUntil: () => {} },
    );

    expect(res.status).toBe(429);
    expect(getEntitlements).not.toHaveBeenCalled();
    expect(checkEndpointRateLimit).not.toHaveBeenCalled();
    expect(calls.summarize).toBe(0);
  });

  test("pre-attribution IP guard fails closed on degradation before entitlement lookup", async () => {
    resolveClerkSession.mockResolvedValue({ userId: "pro_user", orgId: null, role: "pro" });
    validateApiKey.mockResolvedValue({ valid: true, required: false, kind: "session" });
    checkFailClosedScopedIpRateLimit.mockResolvedValue(new Response(
      JSON.stringify({ error: "Rate-limit service temporarily unavailable" }),
      { status: 503, headers: { "X-RateLimit-Mode": "degraded" } },
    ));
    const calls = { summarize: 0, cache: 0 };

    const res = await makeGateway(calls)(
      makeRequest(SUMMARIZE_PATH, { Authorization: "Bearer pro-session" }),
      { waitUntil: () => {} },
    );

    expect(res.status).toBe(503);
    expect(getEntitlements).not.toHaveBeenCalled();
    expect(checkEndpointRateLimit).not.toHaveBeenCalled();
    expect(calls.summarize).toBe(0);
  });

  test("active user API keys reuse the resolved entitlement and use the principal bucket", async () => {
    const activeEntitlement = {
      planKey: "api_starter",
      features: { tier: 1, apiAccess: true, apiRateLimit: 60 },
      validUntil: Date.now() + 86_400_000,
    };
    validateUserApiKey.mockResolvedValue({ userId: "api_user", keyId: "key_1", name: "test" });
    getEntitlements.mockResolvedValue(activeEntitlement);
    const calls = { summarize: 0, cache: 0 };

    const res = await makeGateway(calls)(
      makeRequest(SUMMARIZE_PATH, { "X-Api-Key": "wm_active_user_key" }),
      { waitUntil: () => {} },
    );

    expect(res.status).toBe(200);
    expect(getEntitlements).toHaveBeenCalledTimes(1);
    expect(getEntitlements).toHaveBeenCalledWith("api_user");
    expect(checkEndpointRateLimit).toHaveBeenCalledWith(
      expect.any(Request),
      SUMMARIZE_PATH,
      expect.any(Object),
      { principalUserId: "api_user" },
    );
    expect(calls.summarize).toBe(1);
  });

  test("expired tier-1 bearer sessions retain the per-IP endpoint bucket", async () => {
    resolveClerkSession.mockResolvedValue({ userId: "expired_user", orgId: null, role: "pro" });
    getEntitlements.mockResolvedValue({
      planKey: "pro_monthly",
      features: { tier: 1 },
      validUntil: Date.now() - 1,
    });
    validateApiKey.mockResolvedValue({ valid: true, required: false, kind: "session" });
    checkEndpointRateLimit.mockResolvedValue(json({ error: "Too many requests" }, 429));
    const calls = { summarize: 0, cache: 0 };

    const res = await makeGateway(calls)(
      makeRequest(SUMMARIZE_PATH, { Authorization: "Bearer expired-session" }),
      { waitUntil: () => {} },
    );

    expect(res.status).toBe(429);
    expect(checkEndpointRateLimit).toHaveBeenCalledWith(
      expect.any(Request),
      SUMMARIZE_PATH,
      expect.any(Object),
    );
    expect(checkFailClosedScopedIpRateLimit).toHaveBeenCalledWith(
      expect.any(Request),
      "summarize-article:principal-attribution",
      600,
      "60 s",
      expect.any(Object),
    );
    expect(checkFailClosedScopedIpRateLimit.mock.invocationCallOrder[0]).toBeLessThan(
      getEntitlements.mock.invocationCallOrder[0]!,
    );
    expect(calls.summarize).toBe(0);
  });

  test("unresolved Pro bearer sessions retain the per-IP endpoint bucket", async () => {
    resolveClerkSession.mockResolvedValue({ userId: "unresolved_user", orgId: null, role: "pro" });
    getEntitlements.mockResolvedValue(null);
    validateApiKey.mockResolvedValue({ valid: true, required: false, kind: "session" });
    checkEndpointRateLimit.mockResolvedValue(json({ error: "Too many requests" }, 429));
    const calls = { summarize: 0, cache: 0 };

    const res = await makeGateway(calls)(
      makeRequest(SUMMARIZE_PATH, { Authorization: "Bearer unresolved-session" }),
      { waitUntil: () => {} },
    );

    expect(res.status).toBe(429);
    expect(checkEndpointRateLimit).toHaveBeenCalledWith(
      expect.any(Request),
      SUMMARIZE_PATH,
      expect.any(Object),
    );
    expect(checkFailClosedScopedIpRateLimit).toHaveBeenCalledWith(
      expect.any(Request),
      "summarize-article:principal-attribution",
      600,
      "60 s",
      expect.any(Object),
    );
    expect(checkFailClosedScopedIpRateLimit.mock.invocationCallOrder[0]).toBeLessThan(
      getEntitlements.mock.invocationCallOrder[0]!,
    );
    expect(calls.summarize).toBe(0);
  });

  test("signed-in free sessions remain on the shared per-IP endpoint bucket", async () => {
    resolveClerkSession.mockResolvedValue({ userId: "free_user", orgId: null, role: "free" });
    getEntitlements.mockResolvedValue({
      planKey: "free",
      features: { tier: 0 },
      validUntil: Date.now() + 86_400_000,
    });
    validateApiKey.mockResolvedValue({ valid: true, required: false, kind: "session" });
    checkEndpointRateLimit.mockResolvedValue(json({ error: "Too many requests" }, 429));
    const calls = { summarize: 0, cache: 0 };

    const res = await makeGateway(calls)(
      makeRequest(SUMMARIZE_PATH, { Authorization: "Bearer free-session" }),
      { waitUntil: () => {} },
    );

    expect(res.status).toBe(429);
    expect(calls.summarize).toBe(0);
    expect(checkEndpointRateLimit).toHaveBeenCalledWith(
      expect.any(Request),
      SUMMARIZE_PATH,
      expect.any(Object),
    );
    expect(checkFailClosedScopedIpRateLimit).toHaveBeenCalledWith(
      expect.any(Request),
      "summarize-article:principal-attribution",
      600,
      "60 s",
      expect.any(Object),
    );
    expect(checkFailClosedScopedIpRateLimit.mock.invocationCallOrder[0]).toBeLessThan(
      getEntitlements.mock.invocationCallOrder[0]!,
    );
  });

  test("translate mode remains public and quota-exempt", async () => {
    validateApiKey.mockResolvedValue({ valid: true, required: false, kind: "session" });
    const calls = { summarize: 0, cache: 0 };

    const res = await makeGateway(calls)(
      makeRequest(SUMMARIZE_PATH, { "X-WorldMonitor-Key": "wms_anonymous_session" }, "POST"),
      { waitUntil: () => {} },
    );

    // makeRequest defaults to a brief body, so use a fresh request with the
    // translate mode body for the actual assertion.
    const translate = await makeGateway(calls)(
      new Request(`https://www.worldmonitor.app${SUMMARIZE_PATH}`, {
        method: "POST",
        headers: {
          "X-WorldMonitor-Key": "wms_anonymous_session",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ provider: "groq", mode: "translate", headlines: ["hola"] }),
      }),
      { waitUntil: () => {} },
    );

    expect(res.status).toBe(401);
    expect(translate.status).toBe(200);
    expect(calls.summarize).toBe(1);
    expect(reserveDirectLlmQuota).not.toHaveBeenCalled();
  });

  test("Redis-degraded endpoint rate limiting fails closed before the provider handler", async () => {
    resolveClerkSession.mockResolvedValue({ userId: "pro_user", orgId: null, role: "pro" });
    validateApiKey.mockResolvedValue({ valid: true, required: false, kind: "session" });
    checkEndpointRateLimit.mockResolvedValue(json({ error: "Rate-limit service temporarily unavailable" }, 503));
    const calls = { summarize: 0, cache: 0 };

    const res = await makeGateway(calls)(
      makeRequest(SUMMARIZE_PATH, { Authorization: "Bearer pro-session" }),
      { waitUntil: () => {} },
    );

    expect(res.status).toBe(503);
    expect(calls.summarize).toBe(0);
  });

  test("summarize-article-cache remains ungated read-only cache lookup behavior", async () => {
    validateApiKey.mockResolvedValue({ valid: true, required: false, kind: "session" });
    const calls = { summarize: 0, cache: 0 };

    const res = await makeGateway(calls)(
      makeRequest(`${CACHE_PATH}?cache_key=test-cache-key`, { "X-WorldMonitor-Key": "wms_anonymous_session" }, "GET"),
      { waitUntil: () => {} },
    );

    expect(getRequiredTier(CACHE_PATH)).toBeNull();
    expect(PREMIUM_RPC_PATHS.has(CACHE_PATH)).toBe(false);
    expect(res.status).toBe(200);
    expect(calls.cache).toBe(1);
    expect(calls.summarize).toBe(0);
  });
});
