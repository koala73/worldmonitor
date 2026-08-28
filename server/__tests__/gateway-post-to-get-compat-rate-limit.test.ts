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

import { createDomainGateway } from "../gateway";

const ENDPOINT_LIMITED_PATH = "/api/market/v1/list-market-quotes";
// No endpoint policy, so the gateway falls through to the global limiter.
const GLOBAL_LIMITED_PATH = "/api/market/v1/list-crypto-quotes";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeGateway(path: string, handlerCalls: { count: number }) {
  return createDomainGateway([
    {
      method: "GET",
      path,
      handler: async () => {
        handlerCalls.count += 1;
        return json({ ok: true });
      },
    },
  ]);
}

function compatPost(path: string, body: string) {
  return new Request(`https://www.worldmonitor.app${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": String(new TextEncoder().encode(body).length),
      "X-WorldMonitor-Key": "wms_anonymous",
    },
    body,
  });
}

function lastLimitedRequest(): Request {
  const request = checkEndpointRateLimit.mock.calls.at(-1)?.[0];
  expect(request).toBeInstanceOf(Request);
  return request as Request;
}

beforeEach(() => {
  checkEndpointRateLimit.mockReset().mockResolvedValue(null);
  checkRateLimit.mockReset().mockResolvedValue(null);
  checkEntitlementDetailed.mockReset().mockResolvedValue({ response: null, entitlements: null });
  getEntitlements.mockReset().mockResolvedValue(null);
  resolveClerkSession.mockReset().mockResolvedValue(null);
  validateApiKey.mockReset().mockResolvedValue({
    valid: true,
    required: false,
    kind: "session",
  });
  reserveDirectLlmQuota.mockReset().mockResolvedValue({
    ok: true,
    newCount: 1,
    rollback: async () => {},
  });
});

describe("POST-to-GET compatibility abuse limiting", () => {
  test("malformed compatibility POSTs traverse the GET route endpoint limiter", async () => {
    const calls = { count: 0 };
    checkEndpointRateLimit.mockResolvedValue(json({ error: "Too many requests" }, 429));

    const res = await makeGateway(ENDPOINT_LIMITED_PATH, calls)(
      compatPost(ENDPOINT_LIMITED_PATH, "{not json"),
      { waitUntil: () => {} },
    );

    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "Too many requests" });
    expect(checkEndpointRateLimit).toHaveBeenCalledTimes(1);
    expect(checkEndpointRateLimit).toHaveBeenCalledWith(
      expect.any(Request),
      ENDPOINT_LIMITED_PATH,
      expect.any(Object),
    );
    expect(lastLimitedRequest().method).toBe("GET");
    expect(calls.count).toBe(0);
    expect(reserveDirectLlmQuota).not.toHaveBeenCalled();
  });

  test("nested compatibility POSTs return 400 only after the endpoint limiter allows", async () => {
    const calls = { count: 0 };

    const res = await makeGateway(ENDPOINT_LIMITED_PATH, calls)(
      compatPost(ENDPOINT_LIMITED_PATH, JSON.stringify({ filter: { nested: true } })),
      { waitUntil: () => {} },
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Unsupported value for POST compatibility parameter",
      parameter: "filter",
    });
    expect(checkEndpointRateLimit).toHaveBeenCalledTimes(1);
    expect(lastLimitedRequest().method).toBe("GET");
    expect(calls.count).toBe(0);
    expect(reserveDirectLlmQuota).not.toHaveBeenCalled();
  });

  test("malformed compatibility POSTs traverse the global fallback limiter", async () => {
    const calls = { count: 0 };
    checkRateLimit.mockResolvedValue(json({ error: "Too many requests" }, 429));

    const res = await makeGateway(GLOBAL_LIMITED_PATH, calls)(
      compatPost(GLOBAL_LIMITED_PATH, "{not json"),
      { waitUntil: () => {} },
    );

    expect(res.status).toBe(429);
    expect(checkEndpointRateLimit).toHaveBeenCalledTimes(1);
    expect(lastLimitedRequest().method).toBe("GET");
    expect(checkRateLimit).toHaveBeenCalledTimes(1);
    const globalRequest = checkRateLimit.mock.calls[0]?.[0];
    expect(globalRequest).toBeInstanceOf(Request);
    expect((globalRequest as Request).method).toBe("GET");
    expect(calls.count).toBe(0);
    expect(reserveDirectLlmQuota).not.toHaveBeenCalled();
  });
});
