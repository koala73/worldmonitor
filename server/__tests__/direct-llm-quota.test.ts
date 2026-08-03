// @vitest-environment node

import { describe, expect, test } from "vitest";

import {
  DIRECT_LLM_DAILY_QUOTA_LIMIT,
  DIRECT_LLM_GATEWAY_QUOTA_PATHS,
  DIRECT_LLM_QUOTA_PATHS,
  DIRECT_LLM_REDIS_UNAVAILABLE_RETRY_AFTER_SECONDS,
  DIRECT_LLM_SELF_METERED_QUOTA_PATHS,
  directLlmDailyQuotaKey,
  directLlmDailyLimitFromEntitlements,
  reserveDirectLlmQuota,
  resolveDirectLlmDailyLimit,
} from "../_shared/direct-llm-quota";

describe("direct LLM daily quota", () => {
  test("uses the dashboard-AI default for legacy Pro rows and preserves explicit plan limits", () => {
    expect(resolveDirectLlmDailyLimit()).toBe(500);
    expect(resolveDirectLlmDailyLimit(500)).toBe(500);
    expect(resolveDirectLlmDailyLimit(2_500)).toBe(2_500);
    expect(resolveDirectLlmDailyLimit(null)).toBeNull();
    expect(resolveDirectLlmDailyLimit(0)).toBe(0);
    expect(resolveDirectLlmDailyLimit(Number.NaN)).toBe(500);
  });

  test("reads the dashboard-AI allowance without touching MCP limits", () => {
    expect(directLlmDailyLimitFromEntitlements({
      features: {
        planLimits: {
          dashboardAiCallsPerDay: 2_500,
        },
      },
    })).toBe(2_500);
    expect(directLlmDailyLimitFromEntitlements({
      features: {
        planLimits: {
          mcpCallsPerDay: 250,
        },
      },
    })).toBeUndefined();
  });

  test("uses a UTC daily key in the direct-LLM namespace", () => {
    const key = directLlmDailyQuotaKey("user_123", new Date(Date.UTC(2026, 6, 4, 23, 59, 0)));
    expect(key).toBe("llm:direct-usage:user_123:2026-07-04");
  });

  test("reserves with INCR-first semantics and sets the 48h TTL", async () => {
    const calls: Array<Array<Array<string | number>>> = [];
    const result = await reserveDirectLlmQuota({
      userId: "user_123",
      date: new Date(Date.UTC(2026, 6, 4, 12, 0, 0)),
      pipeline: async (cmds) => {
        calls.push(cmds);
        return [{ result: 1 }, { result: "OK" }];
      },
    });

    expect(result.ok).toBe(true);
    expect(calls[0]).toEqual([
      ["INCR", "llm:direct-usage:user_123:2026-07-04"],
      ["EXPIRE", "llm:direct-usage:user_123:2026-07-04", 172800],
    ]);
  });

  test("rolls back and returns cap-exceeded on the first over-limit reservation", async () => {
    const calls: Array<Array<Array<string | number>>> = [];
    const result = await reserveDirectLlmQuota({
      userId: "user_123",
      date: new Date(Date.UTC(2026, 6, 4, 12, 0, 0)),
      pipeline: async (cmds) => {
        calls.push(cmds);
        if (cmds[0]?.[0] === "DECR") return [{ result: DIRECT_LLM_DAILY_QUOTA_LIMIT }];
        return [{ result: DIRECT_LLM_DAILY_QUOTA_LIMIT + 1 }, { result: "OK" }];
      },
    });

    expect(result).toMatchObject({
      ok: false,
      reason: "cap-exceeded",
      floor: DIRECT_LLM_DAILY_QUOTA_LIMIT,
      retryAfterSec: 43_200,
    });
    expect(calls.at(-1)).toEqual([["DECR", "llm:direct-usage:user_123:2026-07-04"]]);
  });

  test("honors a Pro Business dashboard-AI allowance independently of MCP", async () => {
    const calls: Array<Array<Array<string | number>>> = [];
    const result = await reserveDirectLlmQuota({
      userId: "user_business",
      limit: 2_500,
      date: new Date(Date.UTC(2026, 6, 4, 12, 0, 0)),
      pipeline: async (cmds) => {
        calls.push(cmds);
        if (cmds[0]?.[0] === "DECR") return [{ result: 2_500 }];
        return [{ result: 2_501 }, { result: "OK" }];
      },
    });

    expect(result).toMatchObject({
      ok: false,
      reason: "cap-exceeded",
      floor: 2_500,
    });
    expect(calls.at(-1)).toEqual([["DECR", "llm:direct-usage:user_business:2026-07-04"]]);
  });

  test("fails closed with a short retry window when Redis reservation cannot be proven", async () => {
    const result = await reserveDirectLlmQuota({
      userId: "user_123",
      date: new Date(Date.UTC(2026, 6, 4, 12, 0, 0)),
      pipeline: async () => [],
    });

    expect(result).toMatchObject({
      ok: false,
      reason: "redis-unavailable",
      retryAfterSec: DIRECT_LLM_REDIS_UNAVAILABLE_RETRY_AFTER_SECONDS,
    });
  });

  test("documents gateway-managed and self-metered direct LLM quota paths", () => {
    expect([...DIRECT_LLM_GATEWAY_QUOTA_PATHS].sort()).toEqual([
      "/api/intelligence/v1/classify-event",
      "/api/intelligence/v1/deduct-situation",
      "/api/intelligence/v1/get-country-intel-brief",
      "/api/market/v1/analyze-stock",
      "/api/news/v1/summarize-article",
    ]);
    expect([...DIRECT_LLM_SELF_METERED_QUOTA_PATHS]).toEqual(["/api/chat-analyst"]);
    expect([...DIRECT_LLM_QUOTA_PATHS].sort()).toEqual([
      "/api/chat-analyst",
      ...[...DIRECT_LLM_GATEWAY_QUOTA_PATHS].sort(),
    ]);
  });
});
