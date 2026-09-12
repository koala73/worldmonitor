// @vitest-environment node

import { beforeEach, describe, expect, test, vi } from "vitest";

const checkEndpointRateLimit = vi.fn().mockResolvedValue(null);
const checkRateLimit = vi.fn().mockResolvedValue(null);
vi.mock("../_shared/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../_shared/rate-limit")>();
  return {
    ...actual,
    checkEndpointRateLimit: (...a: unknown[]) => checkEndpointRateLimit(...a),
    checkRateLimit: (...a: unknown[]) => checkRateLimit(...a),
  };
});

const checkEntitlementDetailed = vi.fn().mockResolvedValue({ response: null, entitlements: null });
const getEntitlements = vi.fn().mockResolvedValue(null);
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

const reserveDirectLlmQuota = vi.fn();
vi.mock("../_shared/direct-llm-quota", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../_shared/direct-llm-quota")>();
  return {
    ...actual,
    reserveDirectLlmQuota: (...a: unknown[]) => reserveDirectLlmQuota(...a),
  };
});

const deliverUsageEvents = vi.fn().mockResolvedValue(undefined);
vi.mock("../_shared/usage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../_shared/usage")>();
  return {
    ...actual,
    deliverUsageEvents: (...a: unknown[]) => deliverUsageEvents(...a),
  };
});

import { createDomainGateway } from "../gateway";
import { getRequiredTier } from "../_shared/entitlement-check";
import { createIntelligenceServiceRoutes } from "../../src/generated/server/worldmonitor/intelligence/v1/service_server";
import { intelligenceHandler } from "../worldmonitor/intelligence/v1/handler";

const callLlm = vi.fn();
vi.mock("../_shared/llm", async (importOriginal) => ({
  ...await importOriginal<typeof import("../_shared/llm")>(),
  callLlm: (...args: unknown[]) => callLlm(...args),
}));

const cachedFetchJson = vi.fn();
vi.mock("../_shared/redis", async (importOriginal) => ({
  ...await importOriginal<typeof import("../_shared/redis")>(),
  cachedFetchJson: (...args: unknown[]) => cachedFetchJson(...args),
}));

const CLASSIFY_PATH = "/api/intelligence/v1/classify-event";
const DEDUCT_PATH = "/api/intelligence/v1/deduct-situation";
const COUNTRY_BRIEF_PATH = "/api/intelligence/v1/get-country-intel-brief";
const ANALYZE_PATH = "/api/market/v1/analyze-stock";
const BACKTEST_PATH = "/api/market/v1/backtest-stock";
// A Pro-fresh market route with NO endpoint rate policy, so it reaches the
// GLOBAL limiter these tests exercise. The gateway skips the global limiter for
// any route carrying an endpoint policy (gateway.ts, `!hasEndpointRatePolicy`),
// so a policied route here would silently stop testing what it claims to.
// Crypto quotes now has an endpoint policy for its paid-provider gap fetch.
const GLOBAL_LIMITED_PATH = "/api/market/v1/list-gulf-quotes";
const CACHE_PATH = "/api/news/v1/summarize-article-cache";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeGateway(handlerCalls: Record<string, number>) {
  return createDomainGateway([
    {
      method: "GET",
      path: CLASSIFY_PATH,
      handler: async () => {
        handlerCalls.classify += 1;
        return json({ ok: true, route: "classify" });
      },
    },
    {
      method: "POST",
      path: DEDUCT_PATH,
      handler: async () => {
        handlerCalls.deduct += 1;
        return json({ ok: true, route: "deduct" });
      },
    },
    {
      method: "GET",
      path: COUNTRY_BRIEF_PATH,
      handler: async () => {
        handlerCalls.country += 1;
        return json({ ok: true, route: "country" });
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

function makeAnalyzeGateway(handlerCalls: { analyze: number }) {
  return createDomainGateway([
    {
      method: "GET",
      path: ANALYZE_PATH,
      handler: async () => {
        handlerCalls.analyze += 1;
        return json({ ok: true, route: "analyze" });
      },
    },
  ]);
}

function makeBacktestGateway(handlerCalls: { backtest: number }) {
  return createDomainGateway([
    {
      method: "GET",
      path: BACKTEST_PATH,
      handler: async () => {
        handlerCalls.backtest += 1;
        return json({ ok: true, route: "backtest" });
      },
    },
  ]);
}

function makeMarketQuotesGateway(handlerCalls: { quotes: number }) {
  return createDomainGateway([
    {
      method: "GET",
      path: GLOBAL_LIMITED_PATH,
      handler: async () => {
        handlerCalls.quotes += 1;
        return json({ ok: true, route: "quotes" });
      },
    },
  ]);
}

function req(path: string, init: RequestInit = {}) {
  return new Request(`https://www.worldmonitor.app${path}`, init);
}

function makeRecordingCtx() {
  const pending: Promise<unknown>[] = [];
  return {
    ctx: { waitUntil: (promise: Promise<unknown>) => pending.push(promise) },
    settle: async () => {
      await Promise.allSettled(pending);
    },
  };
}

function lastTelemetryReason(): string | undefined {
  const events = deliverUsageEvents.mock.calls.at(-1)?.[0] as
    | Array<{ reason?: string }>
    | undefined;
  return events?.[0]?.reason;
}

beforeEach(() => {
  checkEndpointRateLimit.mockReset().mockResolvedValue(null);
  checkRateLimit.mockReset().mockResolvedValue(null);
  checkEntitlementDetailed.mockReset().mockResolvedValue({ response: null, entitlements: null });
  getEntitlements.mockReset().mockResolvedValue(null);
  resolveClerkSession.mockReset().mockResolvedValue(null);
  validateApiKey.mockReset().mockResolvedValue({
    valid: false,
    required: true,
    error: "API key required",
  });
  reserveDirectLlmQuota.mockReset().mockResolvedValue({
    ok: true,
    newCount: 1,
    rollback: async () => {},
  });
  deliverUsageEvents.mockReset().mockResolvedValue(undefined);
  cachedFetchJson.mockReset().mockImplementation(async (_key, _ttl, fetcher) => fetcher());
  callLlm.mockReset().mockImplementation(async (options) => {
    options.validate(JSON.stringify({ level: "high", category: "conflict" }));
    return { content: JSON.stringify({ level: "high", category: "conflict" }) };
  });
});

describe("gateway direct LLM quota", () => {
  describe.each([CLASSIFY_PATH, COUNTRY_BRIEF_PATH, ANALYZE_PATH])("GET compatibility quota: %s", (path) => {
    beforeEach(() => {
      const entitlements = {
        planKey: "pro",
        features: { tier: 1, planLimits: { dashboardAiCallsPerDay: 50 } },
        validUntil: Date.now() + 60_000,
      };
      resolveClerkSession.mockResolvedValue({ userId: "user_pro", orgId: null, role: "pro" });
      checkEntitlementDetailed.mockResolvedValue({ response: null, entitlements });
      getEntitlements.mockResolvedValue(entitlements);
    });

    function request(method: string, body = JSON.stringify({ title: "Novel headline" })) {
      return req(method === "POST" ? path : `${path}?title=Novel%20headline`, {
        method,
        headers: {
          Authorization: "Bearer pro", "Content-Type": "application/json",
          ...(method === "POST" ? { "Content-Length": String(new TextEncoder().encode(body).length) } : {}),
        },
        ...(method === "POST" ? { body } : {}),
      });
    }

    test.each(["GET", "POST", "HEAD"])("exhausted %s allowance blocks dispatch", async (method) => {
      const handler = vi.fn().mockResolvedValue(json({ ok: true }));
      reserveDirectLlmQuota.mockResolvedValue({ ok: false, reason: "cap-exceeded", floor: 50, retryAfterSec: 123 });
      const res = await createDomainGateway([{ method: "GET", path, handler }])(request(method), { waitUntil: () => {} });
      expect(res.status).toBe(429);
      expect(reserveDirectLlmQuota).toHaveBeenCalledTimes(1);
      expect(reserveDirectLlmQuota).toHaveBeenCalledWith(expect.objectContaining({ userId: "user_pro", limit: 50 }));
      expect(handler).not.toHaveBeenCalled();
    });

    test.each(["GET", "POST", "HEAD"])("allowed %s reserves once before dispatch", async (method) => {
      const handler = vi.fn(async (routed: Request) => {
        expect(reserveDirectLlmQuota).toHaveBeenCalledTimes(1);
        expect(routed.method).toBe(method === "POST" ? "GET" : method);
        expect(new URL(routed.url).searchParams.get("title")).toBe("Novel headline");
        return json({ ok: true });
      });
      const res = await createDomainGateway([{ method: "GET", path, handler }])(request(method), { waitUntil: () => {} });
      expect(res.status).toBe(200);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(reserveDirectLlmQuota).toHaveBeenCalledTimes(1);
      expect(reserveDirectLlmQuota).toHaveBeenCalledWith(expect.objectContaining({ userId: "user_pro", limit: 50 }));
    });

    if (path === CLASSIFY_PATH) {
      test.each(["GET", "POST"])("real classification %s respects exhaustion before LLM transport", async (method) => {
        const gateway = createDomainGateway(createIntelligenceServiceRoutes(intelligenceHandler));
        reserveDirectLlmQuota.mockResolvedValue({ ok: false, reason: "cap-exceeded", floor: 50, retryAfterSec: 123 });
        const blocked = await gateway(request(method), { waitUntil: () => {} });
        expect(blocked.status).toBe(429);
        expect(callLlm).not.toHaveBeenCalled();
        expect(cachedFetchJson).not.toHaveBeenCalled();

        reserveDirectLlmQuota.mockReset().mockResolvedValue({ ok: true, newCount: 1, rollback: async () => {} });
        const allowed = await gateway(request(method), { waitUntil: () => {} });
        expect(allowed.status).toBe(200);
        expect(await allowed.json()).toMatchObject({ classification: { category: "conflict", subcategory: "high" } });
        expect(callLlm).toHaveBeenCalledTimes(1);
        expect(callLlm).toHaveBeenCalledWith(expect.objectContaining({
          messages: expect.arrayContaining([{ role: "user", content: "Novel headline" }]),
        }));
        expect(reserveDirectLlmQuota).toHaveBeenCalledTimes(1);
      });

      test.each(["GET", "POST"])("real classification %s cache hit reserves once without LLM work", async (method) => {
        cachedFetchJson.mockResolvedValue({ level: "high", category: "conflict", timestamp: Date.now() });
        const gateway = createDomainGateway(createIntelligenceServiceRoutes(intelligenceHandler));
        const res = await gateway(request(method), { waitUntil: () => {} });
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ classification: { category: "conflict" } });
        expect(reserveDirectLlmQuota).toHaveBeenCalledTimes(1);
        expect(callLlm).not.toHaveBeenCalled();
      });
    }

    test.each(["GET", "POST"])("unlimited enterprise %s skips daily reservation", async (method) => {
      const entitlements = {
        planKey: "enterprise", features: { tier: 2, planLimits: { dashboardAiCallsPerDay: null } },
        validUntil: Date.now() + 60_000,
      };
      checkEntitlementDetailed.mockResolvedValue({ response: null, entitlements });
      getEntitlements.mockResolvedValue(entitlements);
      const handler = vi.fn().mockResolvedValue(json({ ok: true }));
      const res = await createDomainGateway([{ method: "GET", path, handler }])(request(method), { waitUntil: () => {} });
      expect(res.status).toBe(200);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(reserveDirectLlmQuota).not.toHaveBeenCalled();
    });

    test.each([null, "1048576"])("ineligible POST content length %s never dispatches or charges", async (length) => {
      const post = request("POST");
      if (length === null) post.headers.delete("Content-Length");
      else post.headers.set("Content-Length", length);
      const handler = vi.fn();
      const res = await createDomainGateway([{ method: "GET", path, handler }])(post, { waitUntil: () => {} });
      expect(res.status).toBe(405);
      expect(handler).not.toHaveBeenCalled();
      expect(reserveDirectLlmQuota).not.toHaveBeenCalled();
    });

    test.each(["{bad json", JSON.stringify({ title: { nested: true } })])("invalid POST body %s never dispatches or charges", async (body) => {
      const handler = vi.fn();
      const res = await createDomainGateway([{ method: "GET", path, handler }])(request("POST", body), { waitUntil: () => {} });
      expect(res.status).toBe(400);
      expect(checkEndpointRateLimit).toHaveBeenCalledTimes(1);
      expect(handler).not.toHaveBeenCalled();
      expect(reserveDirectLlmQuota).not.toHaveBeenCalled();
    });

    test("unsupported method never dispatches or charges", async () => {
      const handler = vi.fn();
      const res = await createDomainGateway([{ method: "GET", path, handler }])(request("PUT"), { waitUntil: () => {} });
      expect(res.status).toBe(405);
      expect(handler).not.toHaveBeenCalled();
      expect(reserveDirectLlmQuota).not.toHaveBeenCalled();
    });
  });

  test("country brief is declared as a tier-1 Pro endpoint", () => {
    expect(getRequiredTier(COUNTRY_BRIEF_PATH)).toBe(1);
  });

  test("free bearer country brief is rejected before quota or handler spend", async () => {
    const calls = { classify: 0, deduct: 0, country: 0, cache: 0 };
    resolveClerkSession.mockResolvedValue({ userId: "user_free", orgId: null, role: "free" });
    checkEntitlementDetailed.mockResolvedValue({
      response: json({ error: "Upgrade required", requiredTier: 1, currentTier: 0 }, 403),
      entitlements: null,
    });

    const res = await makeGateway(calls)(
      req(`${COUNTRY_BRIEF_PATH}?country_code=US`, {
        headers: { Authorization: "Bearer free" },
      }),
      { waitUntil: () => {} },
    );

    expect(res.status).toBe(403);
    expect(checkEntitlementDetailed).toHaveBeenCalledWith(
      "user_free",
      COUNTRY_BRIEF_PATH,
      expect.any(Object),
      { clerkRole: "free" },
    );
    expect(calls.country).toBe(0);
    expect(reserveDirectLlmQuota).not.toHaveBeenCalled();
  });

  test("Pro bearer HEAD country brief reserves the same GET quota and suppresses the body", async () => {
    const calls = { classify: 0, deduct: 0, country: 0, cache: 0 };
    resolveClerkSession.mockResolvedValue({ userId: "user_pro", orgId: null, role: "pro" });

    const res = await makeGateway(calls)(
      req(`${COUNTRY_BRIEF_PATH}?country_code=US`, {
        method: "HEAD",
        headers: { Authorization: "Bearer pro" },
      }),
      { waitUntil: () => {} },
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect(calls.country).toBe(1);
    expect(reserveDirectLlmQuota).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user_pro" }),
    );
  });

  test("Pro bearer country brief reserves quota and reaches the handler", async () => {
    const calls = { classify: 0, deduct: 0, country: 0, cache: 0 };
    resolveClerkSession.mockResolvedValue({ userId: "user_pro", orgId: null, role: "pro" });

    const res = await makeGateway(calls)(
      req(`${COUNTRY_BRIEF_PATH}?country_code=US`, {
        headers: { Authorization: "Bearer pro" },
      }),
      { waitUntil: () => {} },
    );

    expect(res.status).toBe(200);
    expect(calls.country).toBe(1);
    expect(reserveDirectLlmQuota).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user_pro" }),
    );
  });

  test("Pro Business entitlement uses its dashboard-AI allowance", async () => {
    const calls = { classify: 0, deduct: 0, country: 0, cache: 0 };
    resolveClerkSession.mockResolvedValue({ userId: "user_business", orgId: null, role: "free" });
    checkEntitlementDetailed.mockResolvedValue({
      response: null,
      entitlements: {
        planKey: "pro_business_monthly",
        features: {
          tier: 1,
          planLimits: {
            mcpCallsPerDay: 250,
            dashboardAiCallsPerDay: 2_500,
          },
        },
        validUntil: Date.now() + 60_000,
      },
    });

    const res = await makeGateway(calls)(
      req(`${COUNTRY_BRIEF_PATH}?country_code=US`, {
        headers: { Authorization: "Bearer business" },
      }),
      { waitUntil: () => {} },
    );

    expect(res.status).toBe(200);
    expect(reserveDirectLlmQuota).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user_business", limit: 2_500 }),
    );
  });

  test("anonymous wms-only classify-event is blocked before handler spend", async () => {
    const calls = { classify: 0, deduct: 0, cache: 0 };
    validateApiKey.mockResolvedValue({ valid: true, required: false, kind: "session" });
    checkEntitlementDetailed.mockResolvedValue({
      response: json({ error: "Authentication required" }, 403),
      entitlements: null,
    });

    const res = await makeGateway(calls)(
      req(`${CLASSIFY_PATH}?title=Novel%20headline`, {
        headers: { "X-WorldMonitor-Key": "wms_anonymous" },
      }),
      { waitUntil: () => {} },
    );

    expect(res.status).toBe(403);
    expect(calls.classify).toBe(0);
    expect(reserveDirectLlmQuota).not.toHaveBeenCalled();
  });

  test("signed-out classify-event is rejected before quota or handler spend", async () => {
    const calls = { classify: 0, deduct: 0, cache: 0 };

    const res = await makeGateway(calls)(
      req(`${CLASSIFY_PATH}?title=Novel%20headline`),
      { waitUntil: () => {} },
    );

    expect(res.status).toBe(401);
    expect(calls.classify).toBe(0);
    expect(reserveDirectLlmQuota).not.toHaveBeenCalled();
  });

  test("Pro bearer HEAD classify-event reserves the same GET quota before the handler", async () => {
    const calls = { classify: 0, deduct: 0, cache: 0 };
    resolveClerkSession.mockResolvedValue({ userId: "user_pro", orgId: null, role: "pro" });
    validateApiKey.mockResolvedValue({ valid: false, required: true, error: "API key required" });

    const res = await makeGateway(calls)(
      req(`${CLASSIFY_PATH}?title=Novel%20headline`, {
        method: "HEAD",
        headers: { Authorization: "Bearer pro" },
      }),
      { waitUntil: () => {} },
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect(calls.classify).toBe(1);
    expect(reserveDirectLlmQuota).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user_pro" }),
    );
  });

  test("Pro bearer classify-event reserves direct LLM quota before the handler", async () => {
    const calls = { classify: 0, deduct: 0, cache: 0 };
    resolveClerkSession.mockResolvedValue({ userId: "user_pro", orgId: null, role: "pro" });
    validateApiKey.mockResolvedValue({ valid: false, required: true, error: "API key required" });

    const res = await makeGateway(calls)(
      req(`${CLASSIFY_PATH}?title=Novel%20headline`, {
        headers: { Authorization: "Bearer pro" },
      }),
      { waitUntil: () => {} },
    );

    expect(res.status).toBe(200);
    expect(calls.classify).toBe(1);
    expect(checkEndpointRateLimit).toHaveBeenCalledWith(
      expect.any(Request),
      CLASSIFY_PATH,
      expect.any(Object),
      { principalUserId: "user_pro", principalScope: "session" },
    );
    expect(reserveDirectLlmQuota).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user_pro" }),
    );
  });

  test("Pro bearer analyze-stock uses a principal-scoped endpoint bucket", async () => {
    const calls = { analyze: 0 };
    resolveClerkSession.mockResolvedValue({ userId: "user_pro", orgId: null, role: "pro" });
    validateApiKey.mockResolvedValue({ valid: false, required: true, error: "API key required" });

    const res = await makeAnalyzeGateway(calls)(
      req(`${ANALYZE_PATH}?symbol=AAPL`, {
        headers: { Authorization: "Bearer pro" },
      }),
      { waitUntil: () => {} },
    );

    expect(res.status).toBe(200);
    expect(calls.analyze).toBe(1);
    expect(checkEndpointRateLimit).toHaveBeenCalledWith(
      expect.any(Request),
      ANALYZE_PATH,
      expect.any(Object),
      { principalUserId: "user_pro", principalScope: "session" },
    );
    expect(checkRateLimit).not.toHaveBeenCalled();
  });

  test("Pro bearer backtest-stock does not reserve the direct-LLM daily counter", async () => {
    const calls = { backtest: 0 };
    resolveClerkSession.mockResolvedValue({ userId: "user_pro", orgId: null, role: "pro" });
    validateApiKey.mockResolvedValue({ valid: false, required: true, error: "API key required" });

    const res = await makeBacktestGateway(calls)(
      req(`${BACKTEST_PATH}?symbol=AAPL`, {
        headers: { Authorization: "Bearer pro" },
      }),
      { waitUntil: () => {} },
    );

    expect(res.status).toBe(200);
    expect(calls.backtest).toBe(1);
    expect(checkEndpointRateLimit).toHaveBeenCalledWith(
      expect.any(Request),
      BACKTEST_PATH,
      expect.any(Object),
      { principalUserId: "user_pro", principalScope: "session" },
    );
    expect(reserveDirectLlmQuota).not.toHaveBeenCalled();
  });

  test("active Pro freshness bearer uses a principal-scoped global fallback bucket", async () => {
    const calls = { quotes: 0 };
    resolveClerkSession.mockResolvedValue({ userId: "user_pro", orgId: null, role: "pro" });
    validateApiKey.mockResolvedValue({ valid: false, required: true, error: "API key required" });
    getEntitlements.mockResolvedValue({
      planKey: "pro_monthly",
      features: { tier: 1 },
      validUntil: Date.now() + 60_000,
    });

    const res = await makeMarketQuotesGateway(calls)(
      req(`${GLOBAL_LIMITED_PATH}?ids=bitcoin`, {
        headers: { Authorization: "Bearer pro" },
      }),
      { waitUntil: () => {} },
    );

    expect(res.status).toBe(200);
    expect(calls.quotes).toBe(1);
    expect(checkRateLimit).toHaveBeenCalledWith(
      expect.any(Request),
      expect.any(Object),
      { principalUserId: "user_pro", principalScope: "session" },
    );
  });

  test("endpoint limiter 429s emit a distinct telemetry reason", async () => {
    const calls = { classify: 0, deduct: 0, cache: 0 };
    resolveClerkSession.mockResolvedValue({ userId: "user_pro", orgId: null, role: "pro" });
    validateApiKey.mockResolvedValue({ valid: false, required: true, error: "API key required" });
    checkEndpointRateLimit.mockResolvedValue(json({ error: "Too many requests" }, 429));
    const recorder = makeRecordingCtx();

    const res = await makeGateway(calls)(
      req(`${CLASSIFY_PATH}?title=Novel%20headline`, {
        headers: { Authorization: "Bearer pro" },
      }),
      recorder.ctx,
    );
    await recorder.settle();

    expect(res.status).toBe(429);
    expect(lastTelemetryReason()).toBe("rate_limit_429_endpoint");
    expect(calls.classify).toBe(0);
  });

  test("endpoint limiter degradation keeps the degraded telemetry reason", async () => {
    const calls = { classify: 0, deduct: 0, cache: 0 };
    resolveClerkSession.mockResolvedValue({ userId: "user_pro", orgId: null, role: "pro" });
    validateApiKey.mockResolvedValue({ valid: false, required: true, error: "API key required" });
    checkEndpointRateLimit.mockResolvedValue(new Response(
      JSON.stringify({ error: "Rate limiting temporarily unavailable" }),
      { status: 503, headers: { "X-RateLimit-Mode": "degraded" } },
    ));
    const recorder = makeRecordingCtx();

    const res = await makeGateway(calls)(
      req(`${CLASSIFY_PATH}?title=Novel%20headline`, {
        headers: { Authorization: "Bearer pro" },
      }),
      recorder.ctx,
    );
    await recorder.settle();

    expect(res.status).toBe(503);
    expect(lastTelemetryReason()).toBe("rate_limit_degraded");
    expect(calls.classify).toBe(0);
  });

  test("global limiter 429s emit a distinct telemetry reason", async () => {
    const calls = { quotes: 0 };
    resolveClerkSession.mockResolvedValue({ userId: "user_pro", orgId: null, role: "pro" });
    validateApiKey.mockResolvedValue({ valid: false, required: true, error: "API key required" });
    checkRateLimit.mockResolvedValue(json({ error: "Too many requests" }, 429));
    const recorder = makeRecordingCtx();

    const res = await makeMarketQuotesGateway(calls)(
      req(`${GLOBAL_LIMITED_PATH}?ids=bitcoin`, {
        headers: { Authorization: "Bearer pro" },
      }),
      recorder.ctx,
    );
    await recorder.settle();

    expect(res.status).toBe(429);
    expect(lastTelemetryReason()).toBe("rate_limit_429_global");
    expect(calls.quotes).toBe(0);
  });

  test("global limiter degradation keeps the degraded telemetry reason", async () => {
    const calls = { quotes: 0 };
    resolveClerkSession.mockResolvedValue({ userId: "user_pro", orgId: null, role: "pro" });
    validateApiKey.mockResolvedValue({ valid: false, required: true, error: "API key required" });
    checkRateLimit.mockResolvedValue(new Response(
      JSON.stringify({ error: "Rate limiting temporarily unavailable" }),
      { status: 503, headers: { "X-RateLimit-Mode": "degraded" } },
    ));
    const recorder = makeRecordingCtx();

    const res = await makeMarketQuotesGateway(calls)(
      req(`${GLOBAL_LIMITED_PATH}?ids=bitcoin`, {
        headers: { Authorization: "Bearer pro" },
      }),
      recorder.ctx,
    );
    await recorder.settle();

    expect(res.status).toBe(503);
    expect(lastTelemetryReason()).toBe("rate_limit_degraded");
    expect(calls.quotes).toBe(0);
  });

  test("direct LLM quota 429s emit a distinct telemetry reason", async () => {
    const calls = { classify: 0, deduct: 0, cache: 0 };
    resolveClerkSession.mockResolvedValue({ userId: "user_pro", orgId: null, role: "pro" });
    validateApiKey.mockResolvedValue({ valid: false, required: true, error: "API key required" });
    reserveDirectLlmQuota.mockResolvedValue({
      ok: false,
      reason: "cap-exceeded",
      floor: 50,
      retryAfterSec: 123,
    });
    const recorder = makeRecordingCtx();

    const res = await makeGateway(calls)(
      req(`${CLASSIFY_PATH}?title=Novel%20headline`, {
        headers: { Authorization: "Bearer pro" },
      }),
      recorder.ctx,
    );
    await recorder.settle();

    expect(res.status).toBe(429);
    expect(lastTelemetryReason()).toBe("rate_limit_429_direct_llm");
    expect(calls.classify).toBe(0);
  });

  test("direct LLM quota degradation keeps the degraded telemetry reason", async () => {
    const calls = { classify: 0, deduct: 0, cache: 0 };
    resolveClerkSession.mockResolvedValue({ userId: "user_pro", orgId: null, role: "pro" });
    validateApiKey.mockResolvedValue({ valid: false, required: true, error: "API key required" });
    reserveDirectLlmQuota.mockResolvedValue({
      ok: false,
      reason: "redis-unavailable",
      retryAfterSec: 30,
    });
    const recorder = makeRecordingCtx();

    const res = await makeGateway(calls)(
      req(`${CLASSIFY_PATH}?title=Novel%20headline`, {
        headers: { Authorization: "Bearer pro" },
      }),
      recorder.ctx,
    );
    await recorder.settle();

    expect(res.status).toBe(503);
    expect(lastTelemetryReason()).toBe("rate_limit_degraded");
    expect(calls.classify).toBe(0);
  });

  test("direct LLM quota exhaustion returns 429 with Retry-After and skips handler", async () => {
    const calls = { classify: 0, deduct: 0, cache: 0 };
    resolveClerkSession.mockResolvedValue({ userId: "user_pro", orgId: null, role: "pro" });
    validateApiKey.mockResolvedValue({ valid: false, required: true, error: "API key required" });
    reserveDirectLlmQuota.mockResolvedValue({
      ok: false,
      reason: "cap-exceeded",
      floor: 50,
      retryAfterSec: 123,
    });

    const res = await makeGateway(calls)(
      req(DEDUCT_PATH, {
        method: "POST",
        headers: { Authorization: "Bearer pro", "Content-Type": "application/json" },
        body: JSON.stringify({ query: "Will tensions escalate?" }),
      }),
      { waitUntil: () => {} },
    );

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("123");
    await expect(res.json()).resolves.toMatchObject({ error: "Direct LLM daily quota exceeded" });
    expect(calls.deduct).toBe(0);
  });

  test("summarize-article-cache remains quota-exempt read-only behavior", async () => {
    const calls = { classify: 0, deduct: 0, cache: 0 };
    validateApiKey.mockResolvedValue({ valid: true, required: false, kind: "session" });

    const res = await makeGateway(calls)(
      req(`${CACHE_PATH}?cache_key=summary:v1:test`, {
        headers: { "X-WorldMonitor-Key": "wms_anonymous" },
      }),
      { waitUntil: () => {} },
    );

    expect(res.status).toBe(200);
    expect(calls.cache).toBe(1);
    expect(reserveDirectLlmQuota).not.toHaveBeenCalled();
  });
});

// #6105 review: `deduct-situation` and `summarize-article` carry NO
// ENDPOINT_ENTITLEMENTS tier gate, and deduct-situation's handler spends
// provider budget for anyone who reaches it. These pin the limit that each
// caller class is actually reserved against, so raising the PAID default can
// never again raise what an unconfirmed caller can spend.
describe("direct LLM limit resolution by caller class", () => {
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
        ...(dashboardAiCallsPerDay === undefined
          ? {}
          : { planLimits: { dashboardAiCallsPerDay } }),
      },
      validUntil,
      ...extra,
    };
  }

  async function reserveDeductAs(entitlements: unknown) {
    const calls = { classify: 0, deduct: 0, cache: 0 };
    resolveClerkSession.mockResolvedValue({ userId: "user_x", orgId: null, role: "free" });
    getEntitlements.mockResolvedValue(entitlements);
    const res = await makeGateway(calls)(
      req(DEDUCT_PATH, {
        method: "POST",
        headers: { Authorization: "Bearer x", "Content-Type": "application/json" },
        body: JSON.stringify({ query: "Will tensions escalate?" }),
      }),
      { waitUntil: () => {} },
    );
    return { res, calls };
  }

  test("signed-in FREE tier is capped at the unverified floor, not the paid default", async () => {
    const { res } = await reserveDeductAs(entitlement(0, 0, ACTIVE()));

    expect(res.status).toBe(200);
    expect(reserveDirectLlmQuota).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user_x", limit: 50 }),
    );
  });

  test("LAPSED Pro Business does not keep its paid allowance", async () => {
    const { res } = await reserveDeductAs(entitlement(1, 2_500, LAPSED()));

    expect(res.status).toBe(200);
    expect(reserveDirectLlmQuota).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 50 }),
    );
  });

  test("an entitlement-verification outage does not grant the paid default", async () => {
    // getEntitlements never throws; it answers with a truthy tier-0 marker.
    const { res } = await reserveDeductAs(
      entitlement(0, undefined, 0, { verificationUnavailable: true }),
    );

    expect(res.status).toBe(200);
    expect(reserveDirectLlmQuota).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 50 }),
    );
  });

  test("a missing entitlement row falls back to the unverified floor", async () => {
    const { res } = await reserveDeductAs(null);

    expect(res.status).toBe(200);
    expect(reserveDirectLlmQuota).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 50 }),
    );
  });

  test("ACTIVE Pro Business receives its catalog allowance on an ungated path", async () => {
    const { res } = await reserveDeductAs(entitlement(1, 2_500, ACTIVE()));

    expect(res.status).toBe(200);
    expect(reserveDirectLlmQuota).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 2_500 }),
    );
  });

  test("an active PAID row missing the dimension inherits the Pro default", async () => {
    const { res } = await reserveDeductAs(entitlement(1, undefined, ACTIVE()));

    expect(res.status).toBe(200);
    expect(reserveDirectLlmQuota).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 500 }),
    );
  });

  test("an active Enterprise row is unlimited and skips the reservation", async () => {
    const { res, calls } = await reserveDeductAs(entitlement(3, null, ACTIVE()));

    expect(res.status).toBe(200);
    expect(calls.deduct).toBe(1);
    expect(reserveDirectLlmQuota).not.toHaveBeenCalled();
  });
});
