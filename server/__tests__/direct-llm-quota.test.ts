// @vitest-environment node

import { describe, expect, test } from "vitest";

import {
  DIRECT_LLM_DAILY_QUOTA_LIMIT,
  DIRECT_LLM_GATEWAY_QUOTA_PATHS,
  DIRECT_LLM_QUOTA_PATHS,
  DIRECT_LLM_REDIS_UNAVAILABLE_RETRY_AFTER_SECONDS,
  DIRECT_LLM_SELF_METERED_QUOTA_PATHS,
  DIRECT_LLM_UNVERIFIED_DAILY_QUOTA_LIMIT,
  directLlmDailyQuotaKey,
  directLlmDailyLimitFromEntitlements,
  reserveDirectLlmQuota,
  resolveActiveDirectLlmLimit,
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
    expect(DIRECT_LLM_GATEWAY_QUOTA_PATHS.has("/api/market/v1/backtest-stock")).toBe(false);
    expect([...DIRECT_LLM_SELF_METERED_QUOTA_PATHS]).toEqual(["/api/chat-analyst"]);
    expect([...DIRECT_LLM_QUOTA_PATHS].sort()).toEqual([
      "/api/chat-analyst",
      ...[...DIRECT_LLM_GATEWAY_QUOTA_PATHS].sort(),
    ]);
  });
});

// #6105 review: `resolveDirectLlmDailyLimit` alone cannot tell "legacy PAID row
// missing the field" (Pro default is right) from "caller is not paying"
// (Pro default is a 10x spend grant). `resolveActiveDirectLlmLimit` owns that
// distinction and is the only entry point either enforcement surface may use.
describe("resolveActiveDirectLlmLimit", () => {
  const ACTIVE = () => Date.now() + 60_000;
  const LAPSED = () => Date.now() - 60_000;
  const row = (
    tier: number,
    dashboardAiCallsPerDay: number | null | undefined,
    validUntil: number,
    extra: Record<string, unknown> = {},
  ) => ({
    features: {
      tier,
      ...(dashboardAiCallsPerDay === undefined
        ? {}
        : { planLimits: { dashboardAiCallsPerDay } }),
    },
    validUntil,
    ...extra,
  });

  test("an active paid row gets its catalog allowance", () => {
    expect(resolveActiveDirectLlmLimit(row(1, 500, ACTIVE()))).toBe(500);
    expect(resolveActiveDirectLlmLimit(row(1, 2_500, ACTIVE()))).toBe(2_500);
    expect(resolveActiveDirectLlmLimit(row(2, 10_000, ACTIVE()))).toBe(10_000);
  });

  test("an active Enterprise row is unlimited", () => {
    expect(resolveActiveDirectLlmLimit(row(3, null, ACTIVE()))).toBeNull();
  });

  test("an active paid row predating the dimension inherits the Pro default", () => {
    expect(resolveActiveDirectLlmLimit(row(1, undefined, ACTIVE()))).toBe(
      DIRECT_LLM_DAILY_QUOTA_LIMIT,
    );
  });

  test("everything unconfirmed lands on the floor, never the paid default", () => {
    // Free tier -- the catalog sells it 0, and it must never inherit Pro's.
    expect(resolveActiveDirectLlmLimit(row(0, 0, ACTIVE()))).toBe(
      DIRECT_LLM_UNVERIFIED_DAILY_QUOTA_LIMIT,
    );
    // Lapsed paid rows, including Enterprise -- a lapsed null would skip the meter.
    expect(resolveActiveDirectLlmLimit(row(1, 2_500, LAPSED()))).toBe(
      DIRECT_LLM_UNVERIFIED_DAILY_QUOTA_LIMIT,
    );
    expect(resolveActiveDirectLlmLimit(row(3, null, LAPSED()))).toBe(
      DIRECT_LLM_UNVERIFIED_DAILY_QUOTA_LIMIT,
    );
    // Verification outage: getEntitlements answers with a truthy tier-0 marker.
    expect(
      resolveActiveDirectLlmLimit(row(0, undefined, 0, { verificationUnavailable: true })),
    ).toBe(DIRECT_LLM_UNVERIFIED_DAILY_QUOTA_LIMIT);
    // A marker that somehow carries a paid shape is still unverified.
    expect(
      resolveActiveDirectLlmLimit(row(1, 2_500, ACTIVE(), { verificationUnavailable: true })),
    ).toBe(DIRECT_LLM_UNVERIFIED_DAILY_QUOTA_LIMIT);
    // No row at all.
    expect(resolveActiveDirectLlmLimit(null)).toBe(DIRECT_LLM_UNVERIFIED_DAILY_QUOTA_LIMIT);
    expect(resolveActiveDirectLlmLimit(undefined)).toBe(DIRECT_LLM_UNVERIFIED_DAILY_QUOTA_LIMIT);
    // Malformed rows must not read as paid.
    expect(resolveActiveDirectLlmLimit(row(1, 2_500, Number.NaN))).toBe(
      DIRECT_LLM_UNVERIFIED_DAILY_QUOTA_LIMIT,
    );
    expect(
      resolveActiveDirectLlmLimit({ features: { planLimits: { dashboardAiCallsPerDay: 2_500 } } }),
    ).toBe(DIRECT_LLM_UNVERIFIED_DAILY_QUOTA_LIMIT);
  });

  test("the unverified floor never exceeds the pre-split ceiling", () => {
    // Before the plan-scoped split every non-enterprise caller was capped at 50.
    // Raising the PAID default must never raise an unconfirmed caller's budget.
    expect(DIRECT_LLM_UNVERIFIED_DAILY_QUOTA_LIMIT).toBeLessThanOrEqual(50);
    expect(DIRECT_LLM_UNVERIFIED_DAILY_QUOTA_LIMIT).toBeLessThan(DIRECT_LLM_DAILY_QUOTA_LIMIT);
  });
});
