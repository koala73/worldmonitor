// @vitest-environment node

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const resolvePremiumCallerIdentity = vi.fn();
vi.mock("../_shared/premium-check", () => ({
  resolvePremiumCallerIdentity: (...args: unknown[]) => resolvePremiumCallerIdentity(...args),
}));

vi.mock("../_shared/entitlement-check", () => ({
  renderBillingVerificationDenial: () => null,
}));

const checkRateLimit = vi.fn();
vi.mock("../_shared/rate-limit", () => ({
  checkRateLimit: (...args: unknown[]) => checkRateLimit(...args),
}));

vi.mock("../_shared/redis", () => ({
  runRedisPipeline: vi.fn(),
}));

let quotaCounter = 0;
const reserveDirectLlmQuota = vi.fn();
vi.mock("../_shared/direct-llm-quota", () => ({
  DIRECT_LLM_DAILY_QUOTA_LIMIT: 500,
  reserveDirectLlmQuota: (...args: unknown[]) => reserveDirectLlmQuota(...args),
}));

const assembleAnalystContext = vi.fn();
vi.mock("../worldmonitor/intelligence/v1/chat-analyst-context", () => ({
  assembleAnalystContext: (...args: unknown[]) => assembleAnalystContext(...args),
}));

vi.mock("../worldmonitor/intelligence/v1/chat-analyst-prompt", () => ({
  buildAnalystMessages: ({ query }: { query: string }) => [
    { role: "system", content: "system prompt" },
    { role: "user", content: query },
  ],
}));

vi.mock("../worldmonitor/intelligence/v1/chat-analyst-actions", () => ({
  buildActionEvents: () => [],
}));

const callLlmReasoningStream = vi.fn();
vi.mock("../_shared/llm", () => ({
  callLlmReasoningStream: (...args: unknown[]) => callLlmReasoningStream(...args),
}));

vi.mock("../_shared/llm-sanitize.js", () => ({
  sanitizeForPrompt: (value: string) => value.trim(),
}));

vi.mock("../../api/_cors.js", () => ({
  getCorsHeaders: () => ({ "Access-Control-Allow-Origin": "https://worldmonitor.app" }),
}));

vi.mock("../../api/_sentry-edge.js", () => ({
  captureSilentError: vi.fn(),
}));

import handler from "../../api/chat-analyst";
import { runRedisPipeline } from "../_shared/redis";
import { desktopKeyDailyKey, desktopKeyMinuteKey } from "../_shared/desktop-key-meter";

const encoder = new TextEncoder();

function analystRequest(body: BodyInit): Request {
  return new Request("https://api.worldmonitor.app/api/chat-analyst", {
    method: "POST",
    headers: {
      Authorization: "Bearer premium-token",
      "Content-Type": "application/json",
      Origin: "https://worldmonitor.app",
    },
    body,
  });
}

function llmEvents(events: Array<Record<string, unknown>>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      controller.close();
    },
  });
}

beforeEach(() => {
  quotaCounter = 0;
  resolvePremiumCallerIdentity.mockReset().mockResolvedValue({
    isPremium: true,
    userId: "user_pro",
    kind: "bearer",
    quotaExempt: false,
    directLlmDailyLimit: 500,
  });
  checkRateLimit.mockReset().mockResolvedValue(null);
  assembleAnalystContext.mockReset().mockResolvedValue({
    activeSources: ["Brief"],
    degraded: false,
  });
  callLlmReasoningStream.mockReset().mockReturnValue(llmEvents([
    { delta: "answer" },
    { done: true },
  ]));
  reserveDirectLlmQuota.mockReset().mockImplementation(async () => {
    quotaCounter += 1;
    let rolledBack = false;
    return {
      ok: true,
      newCount: quotaCounter,
      rollback: async () => {
        if (rolledBack) return;
        rolledBack = true;
        quotaCounter -= 1;
      },
    };
  });
});

describe("api/chat-analyst direct LLM quota lifecycle", () => {
  test("malformed JSON does not reserve quota", async () => {
    const response = await handler(analystRequest("{"));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid JSON body" });
    expect(reserveDirectLlmQuota).not.toHaveBeenCalled();
    expect(quotaCounter).toBe(0);
  });

  test.each(["", "   "])("query %j does not reserve quota", async (query) => {
    const response = await handler(analystRequest(JSON.stringify({ query })));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "query is required" });
    expect(reserveDirectLlmQuota).not.toHaveBeenCalled();
    expect(quotaCounter).toBe(0);
  });

  test("a completed answer reserves quota exactly once", async () => {
    const response = await handler(analystRequest(JSON.stringify({ query: "What changed?" })));

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toContain('data: {"done":true}');
    expect(reserveDirectLlmQuota).toHaveBeenCalledTimes(1);
    expect(quotaCounter).toBe(1);
  });

  test("an operator key reserves on its per-key bucket, never under a null userId", async () => {
    resolvePremiumCallerIdentity.mockResolvedValue({
      isPremium: true,
      userId: null,
      kind: "enterprise",
      quotaExempt: false,
      quotaUserId: "wm:0123456789abcdef0123456789abcdef",
      alarmPrincipal: "hashed-operator",
      directLlmDailyLimit: 5_000,
    });

    const response = await handler(analystRequest(JSON.stringify({ query: "What changed?" })));

    expect(response.status).toBe(200);
    expect(reserveDirectLlmQuota).toHaveBeenCalledWith(expect.objectContaining({
      userId: "wm:0123456789abcdef0123456789abcdef",
      limit: 5_000,
    }));
  });

  test("an upstream failure after reservation rolls quota back", async () => {
    callLlmReasoningStream.mockReturnValue(llmEvents([{ error: "llm_unavailable" }]));

    const response = await handler(analystRequest(JSON.stringify({ query: "What changed?" })));

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toContain('data: {"error":"llm_unavailable"}');
    expect(reserveDirectLlmQuota).toHaveBeenCalledTimes(1);
    expect(quotaCounter).toBe(0);
  });

  test("a thrown upstream stream failure rolls quota back", async () => {
    callLlmReasoningStream.mockReturnValue(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("provider stream failed"));
      },
    }));

    const response = await handler(analystRequest(JSON.stringify({ query: "What changed?" })));

    await expect(response.text()).rejects.toThrow("provider stream failed");
    expect(reserveDirectLlmQuota).toHaveBeenCalledTimes(1);
    expect(quotaCounter).toBe(0);
  });

  test("a pre-stream dependency failure after reservation rolls quota back", async () => {
    assembleAnalystContext.mockRejectedValue(new Error("context unavailable"));

    const response = await handler(analystRequest(JSON.stringify({ query: "What changed?" })));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "service_unavailable" });
    expect(reserveDirectLlmQuota).toHaveBeenCalledTimes(1);
    expect(quotaCounter).toBe(0);
  });

  test("a client abort before answer content rolls quota back", async () => {
    let cancelCalled = false;
    callLlmReasoningStream.mockReturnValue(new ReadableStream<Uint8Array>({
      start() {},
      cancel() {
        cancelCalled = true;
      },
    }));

    const response = await handler(analystRequest(JSON.stringify({ query: "What changed?" })));
    await response.body?.cancel("client disconnected");

    expect(cancelCalled).toBe(true);
    expect(quotaCounter).toBe(0);
  });

  // GHSA-cgm2-fpj5-427h: cancelling after a provider accepted the request but
  // before answer content refunded work the provider had already taken on.
  test("a client abort after a provider accepted the request keeps the quota charge", async () => {
    let cancelCalled = false;
    callLlmReasoningStream.mockImplementation((opts: { onProviderAccepted?: () => void }) =>
      new ReadableStream<Uint8Array>({
        start() {
          opts.onProviderAccepted?.();
        },
        cancel() {
          cancelCalled = true;
        },
      }));

    const response = await handler(analystRequest(JSON.stringify({ query: "What changed?" })));
    await response.body?.cancel("client disconnected");

    expect(cancelCalled).toBe(true);
    expect(quotaCounter).toBe(1);
  });

  test("an accepted request that ends without an answer keeps the quota charge", async () => {
    callLlmReasoningStream.mockImplementation((opts: { onProviderAccepted?: () => void }) => {
      opts.onProviderAccepted?.();
      return llmEvents([{ error: "llm_unavailable" }]);
    });

    const response = await handler(analystRequest(JSON.stringify({ query: "What changed?" })));
    await response.text();

    expect(quotaCounter).toBe(1);
  });

  test("a client abort after answer content keeps the quota charge", async () => {
    let cancelCalled = false;
    callLlmReasoningStream.mockReturnValue(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"delta":"partial"}\n\n'));
      },
      cancel() {
        cancelCalled = true;
      },
    }));

    const response = await handler(analystRequest(JSON.stringify({ query: "What changed?" })));
    await response.body?.cancel("client disconnected");

    expect(cancelCalled).toBe(true);
    expect(quotaCounter).toBe(1);
  });

  test("an incomplete stream after answer content keeps the quota charge", async () => {
    callLlmReasoningStream.mockReturnValue(llmEvents([{ delta: "Partial answer" }]));

    const response = await handler(analystRequest(JSON.stringify({ query: "What changed?" })));
    await response.text();

    expect(quotaCounter).toBe(1);
  });
});

// Plan 2026-10-25-001 KTD6 / R6: this route is not served by the gateway, so
// it charges the per-account desktop meter itself. The identity arm carries
// the meter inputs; the real meter module runs over a counter-emulating
// pipeline mock, on a frozen clock so the counter names cannot straddle a UTC
// midnight or minute boundary between the handler and the assertion.
describe("api/chat-analyst desktop-key meter", () => {
  const FROZEN_NOW = Date.UTC(2026, 9, 25, 12, 0, 30);
  const counters = new Map<string, number>();
  const seen: Array<Array<Array<string | number>>> = [];

  function desktopIdentity() {
    return {
      isPremium: true,
      userId: "user_pro",
      kind: "desktop-key",
      quotaExempt: false,
      directLlmDailyLimit: 500,
      enterprisePlan: false,
      desktopKeyMeter: { planKey: "pro_monthly", features: { planLimits: { desktopKeyRequestsPerDay: 7_500, desktopKeyBurstPerMinute: 120 } } },
    };
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: FROZEN_NOW });
    counters.clear();
    seen.length = 0;
    vi.mocked(runRedisPipeline).mockReset().mockImplementation(async (commands: Array<Array<string | number>>) => {
      seen.push(commands);
      return commands.map(([verb, key]) => {
        const k = String(key);
        if (verb === "INCR") { const n = (counters.get(k) ?? 0) + 1; counters.set(k, n); return { result: n }; }
        if (verb === "DECR") { const n = (counters.get(k) ?? 0) - 1; counters.set(k, n); return { result: n }; }
        return { result: 1 };
      });
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("a desktop-key request charges the owner's day counter and burst bucket once, then streams", async () => {
    resolvePremiumCallerIdentity.mockResolvedValue(desktopIdentity());

    const response = await handler(analystRequest(JSON.stringify({ query: "What changed?" })));

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toContain('data: {"done":true}');
    expect(counters.get(desktopKeyDailyKey("user_pro"))).toBe(1);
    expect(counters.get(desktopKeyMinuteKey("user_pro"))).toBe(1);
    expect(seen[0]!.map((c) => c[0])).toEqual(["INCR", "EXPIRE", "INCR", "EXPIRE"]);

    await handler(analystRequest(JSON.stringify({ query: "And now?" })));
    expect(counters.get(desktopKeyDailyKey("user_pro"))).toBe(2);
  });

  test("an owner past the daily ceiling gets the shared 429 before the body is read or quota reserved", async () => {
    resolvePremiumCallerIdentity.mockResolvedValue(desktopIdentity());
    counters.set(desktopKeyDailyKey("user_pro"), 7_500);

    const response = await handler(analystRequest(JSON.stringify({ query: "What changed?" })));

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({
      error: "Daily request limit reached",
      plan: "pro_monthly",
      limit: 7_500,
      limit_type: "daily",
      reset: new Date(Date.UTC(2026, 9, 26)).toISOString(),
    });
    expect(response.headers.get("Retry-After")).toBe(String(12 * 3600 - 30));
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://worldmonitor.app");
    expect(counters.get(desktopKeyDailyKey("user_pro"))).toBe(7_500);
    expect(reserveDirectLlmQuota).not.toHaveBeenCalled();
    expect(callLlmReasoningStream).not.toHaveBeenCalled();
  });

  test("a burst over the per-minute limit is a 429 that does not spend the day", async () => {
    resolvePremiumCallerIdentity.mockResolvedValue(desktopIdentity());
    counters.set(desktopKeyMinuteKey("user_pro"), 120);

    const response = await handler(analystRequest(JSON.stringify({ query: "What changed?" })));

    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ error: "Too many requests", limit: 120, limit_type: "per_minute" });
    expect(response.headers.get("Retry-After")).toBe("30");
    expect(counters.get(desktopKeyDailyKey("user_pro")) ?? 0).toBe(0);
  });

  test("a Redis failure on the meter is the degraded 503, not an unmetered answer", async () => {
    resolvePremiumCallerIdentity.mockResolvedValue(desktopIdentity());
    vi.mocked(runRedisPipeline).mockResolvedValue([]);

    const response = await handler(analystRequest(JSON.stringify({ query: "What changed?" })));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Rate-limit service temporarily unavailable" });
    expect(response.headers.get("X-RateLimit-Mode")).toBe("degraded");
    expect(response.headers.get("Retry-After")).toBe("5");
    expect(callLlmReasoningStream).not.toHaveBeenCalled();
  });

  test("a bearer or api-key identity never touches the desktop meter", async () => {
    await handler(analystRequest(JSON.stringify({ query: "What changed?" })));
    expect(runRedisPipeline).not.toHaveBeenCalled();

    resolvePremiumCallerIdentity.mockResolvedValue({
      isPremium: true, userId: "user_api", kind: "user-api-key", quotaExempt: false, directLlmDailyLimit: 10_000, enterprisePlan: false,
    });
    await handler(analystRequest(JSON.stringify({ query: "What changed?" })));
    expect(runRedisPipeline).not.toHaveBeenCalled();
  });
});
