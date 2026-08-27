// @vitest-environment node

import { beforeEach, describe, expect, test, vi } from "vitest";

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
  buildAnalystSystemPrompt: () => "system prompt",
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
