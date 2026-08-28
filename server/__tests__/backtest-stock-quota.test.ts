// @vitest-environment node

import { describe, expect, test } from "vitest";

import { DIRECT_LLM_DAILY_QUOTA_LIMIT } from "../_shared/direct-llm-quota";
import { TRUSTED_USER_ID_HEADER } from "../_shared/mcp-internal-hmac";
import {
  BACKTEST_STOCK_DAILY_PROVIDER_QUOTA_LIMIT,
  BACKTEST_STOCK_REDIS_UNAVAILABLE_RETRY_AFTER_SECONDS,
  backtestStockProviderQuotaKey,
  backtestStockQuotaUserId,
  reserveBacktestStockProviderQuota,
} from "../_shared/backtest-stock-quota";

describe("backtest-stock provider-work quota", () => {
  test("uses a UTC daily key outside the direct-LLM namespace", () => {
    const key = backtestStockProviderQuotaKey("user_123", new Date(Date.UTC(2026, 6, 4, 23, 59, 0)));
    expect(key).toBe("provider:backtest-yahoo:user_123:2026-07-04");
    expect(key.startsWith("llm:")).toBe(false);
  });

  test("sizes the daily budget to four full 50-symbol watchlist hydrations", () => {
    expect(BACKTEST_STOCK_DAILY_PROVIDER_QUOTA_LIMIT).toBe(200);
    expect(BACKTEST_STOCK_DAILY_PROVIDER_QUOTA_LIMIT).toBeLessThan(DIRECT_LLM_DAILY_QUOTA_LIMIT);
  });

  test("reads the trusted gateway user id and ignores blanks", () => {
    expect(backtestStockQuotaUserId(undefined)).toBeNull();
    expect(backtestStockQuotaUserId(new Request("https://worldmonitor.app/api/market/v1/backtest-stock"))).toBeNull();
    expect(backtestStockQuotaUserId(new Request("https://worldmonitor.app/api/market/v1/backtest-stock", {
      headers: { [TRUSTED_USER_ID_HEADER]: "  " },
    }))).toBeNull();
    expect(backtestStockQuotaUserId(new Request("https://worldmonitor.app/api/market/v1/backtest-stock", {
      headers: { [TRUSTED_USER_ID_HEADER]: "user_pro" },
    }))).toBe("user_pro");
  });

  test("reserves with INCR-first semantics and sets the 48h TTL", async () => {
    const calls: Array<Array<Array<string | number>>> = [];
    const result = await reserveBacktestStockProviderQuota({
      userId: "user_123",
      date: new Date(Date.UTC(2026, 6, 4, 12, 0, 0)),
      pipeline: async (cmds) => {
        calls.push(cmds);
        return [{ result: 1 }, { result: "1" }];
      },
    });

    expect(result.ok).toBe(true);
    expect(calls[0]).toEqual([
      ["INCR", "provider:backtest-yahoo:user_123:2026-07-04"],
      ["EXPIRE", "provider:backtest-yahoo:user_123:2026-07-04", 172800],
    ]);
  });

  test("rolls back and returns cap-exceeded on the first over-limit reservation", async () => {
    const calls: Array<Array<Array<string | number>>> = [];
    const result = await reserveBacktestStockProviderQuota({
      userId: "user_123",
      date: new Date(Date.UTC(2026, 6, 4, 12, 0, 0)),
      pipeline: async (cmds) => {
        calls.push(cmds);
        if (cmds[0]?.[0] === "DECR") return [{ result: BACKTEST_STOCK_DAILY_PROVIDER_QUOTA_LIMIT }];
        return [{ result: BACKTEST_STOCK_DAILY_PROVIDER_QUOTA_LIMIT + 1 }, { result: 1 }];
      },
    });

    expect(result).toMatchObject({
      ok: false,
      reason: "cap-exceeded",
      floor: BACKTEST_STOCK_DAILY_PROVIDER_QUOTA_LIMIT,
      retryAfterSec: 43_200,
    });
    expect(calls.at(-1)).toEqual([["DECR", "provider:backtest-yahoo:user_123:2026-07-04"]]);
  });

  test("fails closed with a short retry window when Redis reservation cannot be proven", async () => {
    const result = await reserveBacktestStockProviderQuota({
      userId: "user_123",
      date: new Date(Date.UTC(2026, 6, 4, 12, 0, 0)),
      pipeline: async () => [],
    });

    expect(result).toMatchObject({
      ok: false,
      reason: "redis-unavailable",
      retryAfterSec: BACKTEST_STOCK_REDIS_UNAVAILABLE_RETRY_AFTER_SECONDS,
    });
  });

  test("rolls back a proven INCR when the pipeline response is short", async () => {
    const calls: Array<Array<Array<string | number>>> = [];
    const result = await reserveBacktestStockProviderQuota({
      userId: "user_123",
      date: new Date(Date.UTC(2026, 6, 4, 12, 0, 0)),
      pipeline: async (cmds) => {
        calls.push(cmds);
        if (cmds[0]?.[0] === "DECR") return [{ result: 0 }];
        return [{ result: 1 }];
      },
    });

    expect(result).toMatchObject({
      ok: false,
      reason: "redis-unavailable",
      retryAfterSec: BACKTEST_STOCK_REDIS_UNAVAILABLE_RETRY_AFTER_SECONDS,
    });
    expect(calls).toEqual([
      [
        ["INCR", "provider:backtest-yahoo:user_123:2026-07-04"],
        ["EXPIRE", "provider:backtest-yahoo:user_123:2026-07-04", 172800],
      ],
      [
        ["DECR", "provider:backtest-yahoo:user_123:2026-07-04"],
        ["EXPIRE", "provider:backtest-yahoo:user_123:2026-07-04", 172800],
      ],
    ]);
  });

  test.each([
    { label: "reports a command error", expireEntry: { error: "ERR expire failed" } },
    { label: "does not confirm expiry", expireEntry: { result: 0 } },
  ])("rolls back when EXPIRE $label", async ({ expireEntry }) => {
    const calls: Array<Array<Array<string | number>>> = [];
    const result = await reserveBacktestStockProviderQuota({
      userId: "user_123",
      date: new Date(Date.UTC(2026, 6, 4, 12, 0, 0)),
      pipeline: async (cmds) => {
        calls.push(cmds);
        if (cmds[0]?.[0] === "DECR") return [{ result: 0 }];
        return [{ result: 1 }, expireEntry];
      },
    });

    expect(result).toMatchObject({
      ok: false,
      reason: "redis-unavailable",
      retryAfterSec: BACKTEST_STOCK_REDIS_UNAVAILABLE_RETRY_AFTER_SECONDS,
    });
    expect(calls.at(-1)).toEqual([
      ["DECR", "provider:backtest-yahoo:user_123:2026-07-04"],
      ["EXPIRE", "provider:backtest-yahoo:user_123:2026-07-04", 172800],
    ]);
  });

  test("keeps the Redis-unavailable result when the best-effort rollback fails", async () => {
    const calls: Array<Array<Array<string | number>>> = [];
    const result = await reserveBacktestStockProviderQuota({
      userId: "user_123",
      date: new Date(Date.UTC(2026, 6, 4, 12, 0, 0)),
      pipeline: async (cmds) => {
        calls.push(cmds);
        if (cmds[0]?.[0] === "DECR") throw new Error("Redis rollback unavailable");
        return [{ result: 1 }];
      },
    });

    expect(result).toMatchObject({
      ok: false,
      reason: "redis-unavailable",
      retryAfterSec: BACKTEST_STOCK_REDIS_UNAVAILABLE_RETRY_AFTER_SECONDS,
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual([
      ["DECR", "provider:backtest-yahoo:user_123:2026-07-04"],
      ["EXPIRE", "provider:backtest-yahoo:user_123:2026-07-04", 172800],
    ]);
  });
});
