// @vitest-environment node

/**
 * Handler side channels for authenticated callers (server/_shared/response-headers.ts
 * -> server/gateway.ts). Once auth resolves a rate-limit principal, the gateway
 * hands the handler a clone stamped with that principal (withTrustedRateLimitPrincipal).
 * Every side channel is a WeakMap/WeakSet keyed by the Request object the handler
 * wrote on, so the gateway must drain them from that clone. The sibling suites
 * (gateway-status-override, gateway-idempotency) drive the public no-auth leads
 * path, where no principal is stamped and the clone never exists.
 */

import { beforeEach, describe, expect, test, vi } from "vitest";

const runRedisPipeline = vi.fn();
vi.mock("../_shared/redis", async (importActual) => {
  const actual = await importActual<typeof import("../_shared/redis")>();
  return {
    ...actual,
    runRedisPipeline: (...a: unknown[]) => runRedisPipeline(...a),
  };
});

const checkRateLimit = vi.fn();
const checkEndpointRateLimit = vi.fn();
vi.mock("../_shared/rate-limit", async (importActual) => {
  const actual = await importActual<typeof import("../_shared/rate-limit")>();
  return {
    ...actual,
    checkRateLimit: (...a: unknown[]) => checkRateLimit(...a),
    checkEndpointRateLimit: (...a: unknown[]) => checkEndpointRateLimit(...a),
  };
});

const checkEntitlementDetailed = vi.fn();
const getEntitlements = vi.fn();
vi.mock("../_shared/entitlement-check", async (importActual) => {
  const actual =
    await importActual<typeof import("../_shared/entitlement-check")>();
  return {
    ...actual,
    checkEntitlementDetailed: (...a: unknown[]) =>
      checkEntitlementDetailed(...a),
    getEntitlements: (...a: unknown[]) => getEntitlements(...a),
  };
});

const resolveClerkSession = vi.fn();
vi.mock("../_shared/auth-session", () => ({
  resolveClerkSession: (...a: unknown[]) => resolveClerkSession(...a),
}));

const validateApiKey = vi.fn();
vi.mock("../../api/_api-key.js", async (importActual) => ({
  ...(await importActual<Record<string, unknown>>()),
  USER_API_KEY_GATEWAY_VALIDATION_ERROR:
    "User API key requires gateway validation",
  validateApiKey: (...a: unknown[]) => validateApiKey(...a),
}));

const deliverUsageEvents = vi.fn();
vi.mock("../_shared/usage", async (importActual) => {
  const actual = await importActual<typeof import("../_shared/usage")>();
  return {
    ...actual,
    deliverUsageEvents: (...a: unknown[]) => deliverUsageEvents(...a),
  };
});

import { createDomainGateway } from "../gateway";
import {
  markRetryableResponse,
  setResponseHeader,
  setSuccessStatusOverride,
} from "../_shared/response-headers";
import { IDEMPOTENCY_HEADER } from "../_shared/idempotency";
import { TRUSTED_RATE_LIMIT_PRINCIPAL_HEADER } from "../_shared/rate-limit";
import {
  createScenarioServiceRoutes,
  type RunScenarioResponse,
  type ScenarioServiceHandler,
} from "../../src/generated/server/worldmonitor/scenario/v1/service_server";

const RUN_PATH = "/api/scenario/v1/run-scenario";
const STATUS_URL =
  "/api/scenario/v1/get-scenario-status?jobId=scenario%3A1717200000000%3Aabcd1234";
const ctx = { waitUntil: () => {} };

const ACCEPTED: RunScenarioResponse = {
  jobId: "scenario:1717200000000:abcd1234",
  status: "pending",
  statusUrl: STATUS_URL,
};

const runScenario = vi.fn<ScenarioServiceHandler["runScenario"]>();
const scenarioHandler = {
  runScenario: (...a: Parameters<ScenarioServiceHandler["runScenario"]>) =>
    runScenario(...a),
} as unknown as ScenarioServiceHandler;

// The generated route, so the handler writes on ctx.request exactly as the
// production run-scenario handler does.
function makeGateway() {
  return createDomainGateway(createScenarioServiceRoutes(scenarioHandler));
}

function post(headers: Record<string, string> = {}): Request {
  return new Request(`https://www.worldmonitor.app${RUN_PATH}`, {
    method: "POST",
    headers: {
      Authorization: "Bearer pro",
      "Content-Type": "application/json",
      "cf-connecting-ip": "203.0.113.7",
      ...headers,
    },
    body: JSON.stringify({ scenarioId: "hormuz-closure", iso2: "US" }),
  });
}

beforeEach(() => {
  runRedisPipeline.mockReset().mockResolvedValue([]);
  checkRateLimit.mockReset().mockResolvedValue(null);
  checkEndpointRateLimit.mockReset().mockResolvedValue(null);
  const entitlements = {
    planKey: "pro",
    features: { tier: 1, planLimits: { dashboardAiCallsPerDay: 50 } },
    validUntil: Date.now() + 60_000,
  };
  resolveClerkSession
    .mockReset()
    .mockResolvedValue({ userId: "user_pro", orgId: null, role: "pro" });
  checkEntitlementDetailed
    .mockReset()
    .mockResolvedValue({ response: null, entitlements });
  getEntitlements.mockReset().mockResolvedValue(entitlements);
  validateApiKey
    .mockReset()
    .mockResolvedValue({
      valid: false,
      required: true,
      error: "API key required",
    });
  deliverUsageEvents.mockReset().mockResolvedValue(undefined);
  runScenario.mockReset().mockImplementation(async (handlerCtx) => {
    setSuccessStatusOverride(handlerCtx.request, 202);
    setResponseHeader(handlerCtx.request, "Location", STATUS_URL);
    return ACCEPTED;
  });
});

describe("gateway side channels for an authenticated caller", () => {
  test("the handler receives the principal-stamped clone", async () => {
    await makeGateway()(post(), ctx);

    expect(runScenario).toHaveBeenCalledTimes(1);
    const handlerRequest = runScenario.mock.calls[0]![0].request;
    expect(
      handlerRequest.headers.get(TRUSTED_RATE_LIMIT_PRINCIPAL_HEADER),
    ).toBeTruthy();
  });

  test("a Pro run-scenario enqueue answers 202 with its Location header", async () => {
    const res = await makeGateway()(post(), ctx);

    expect(res.status).toBe(202);
    expect(res.headers.get("Location")).toBe(STATUS_URL);
    expect(await res.json()).toMatchObject({
      status: "pending",
      statusUrl: STATUS_URL,
    });
  });

  test("an in-band retryable response releases the idempotency lock", async () => {
    runScenario.mockReset().mockImplementation(async (handlerCtx) => {
      markRetryableResponse(handlerCtx.request);
      setResponseHeader(handlerCtx.request, "Retry-After", "5");
      return ACCEPTED;
    });
    runRedisPipeline
      .mockResolvedValueOnce([{ result: null }]) // peek miss
      .mockResolvedValueOnce([{ result: "OK" }, { result: null }]) // claim
      .mockResolvedValueOnce([{ result: 1 }]); // release or store

    const res = await makeGateway()(
      post({ [IDEMPOTENCY_HEADER]: "key-pro-retryable" }),
      ctx,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Retry-After")).toBe("5");
    const finalCommand = runRedisPipeline.mock.calls[2]![0][0];
    expect(finalCommand[0]).toBe("DEL");
  });
});
