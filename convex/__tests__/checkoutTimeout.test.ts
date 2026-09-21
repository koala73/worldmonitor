import { APIConnectionError, APIConnectionTimeoutError, APIUserAbortError } from "dodopayments";
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { PRODUCT_CATALOG } from "../config/productCatalog";
import { api, internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import { createDodoCheckoutSession } from "../lib/dodo";
import {
  CHECKOUT_RATE_LIMITED,
  checkoutRetryClock,
  runCheckoutWithRateLimitRetry,
} from "../payments/checkoutRateLimit";
import {
  CHECKOUT_RATE_LIMIT_EVENT_RETENTION_MS,
  recordTerminalCheckoutTimeout,
} from "../payments/checkoutRateLimitAlarm";
import schema from "../schema";

vi.mock("../lib/dodo", () => ({
  CHECKOUT_PROVIDER_ATTEMPT_TIMEOUT_MS: 3_500,
  createDodoCheckoutSession: vi.fn(),
}));

const modules = import.meta.glob("../**/*.ts");
const TEST_SIGNING_SECRET = "checkout-timeout-test-signing-secret";
const TEST_RELAY_SECRET = "checkout-timeout-test-relay-secret";
const TEST_RETRY_OPTIONS = { attemptTimeoutMs: 3_500 };
const TEST_USER = {
  subject: "user_checkout_timeout",
  tokenIdentifier: "clerk|user_checkout_timeout",
  email: "timeout@example.com",
};
const FIXED_NOW = 1_786_000_000_000;

function sdkRateLimitError() {
  return Object.assign(new Error("Rate limited by provider"), { status: 429 });
}

function pinRetryClock() {
  vi.spyOn(checkoutRetryClock, "random").mockReturnValue(0.5);
  return vi.spyOn(checkoutRetryClock, "sleep").mockResolvedValue(undefined);
}

function pinRetryClockNow() {
  return vi.spyOn(checkoutRetryClock, "now").mockReturnValue(FIXED_NOW);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(createDodoCheckoutSession).mockReset();
  delete process.env.DODO_IDENTITY_SIGNING_SECRET;
  delete process.env.CONVEX_TENANT_RELAY_SECRET;
});

describe("checkout session timeout retry", () => {
  test("returns the session after one SDK timeout", async () => {
    pinRetryClock();
    const attempt = vi.fn().mockRejectedValueOnce(new APIConnectionTimeoutError())
      .mockResolvedValue({ checkout_url: "https://checkout.example/session" });
    expect(await runCheckoutWithRateLimitRetry(attempt, TEST_RETRY_OPTIONS))
      .toEqual({ checkout_url: "https://checkout.example/session" });
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  test.each([
    new APIConnectionError({ message: "network down" }),
    new APIUserAbortError(),
    Object.assign(new Error("Request timeout"), { status: 408 }),
    Object.assign(new Error("Server failure"), { status: 500 }),
  ])("does not retry other provider failures: %s", async (error) => {
    const attempt = vi.fn().mockRejectedValue(error);
    await expect(runCheckoutWithRateLimitRetry(attempt, TEST_RETRY_OPTIONS)).rejects.toBe(error);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  test("the real public action returns the recovered session without recording a failure", async () => {
    process.env.DODO_IDENTITY_SIGNING_SECRET = TEST_SIGNING_SECRET;
    pinRetryClock();
    const session = { checkout_url: "https://checkout.example/recovered" };
    vi.mocked(createDodoCheckoutSession)
      .mockRejectedValueOnce(new APIConnectionTimeoutError())
      .mockResolvedValueOnce(session);
    const t = convexTest(schema, modules);
    expect(await t.withIdentity(TEST_USER).action(api.payments.checkout.createCheckout, {
      productId: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
    })).toEqual(session);
    expect(createDodoCheckoutSession).toHaveBeenCalledTimes(2);
    expect(vi.mocked(createDodoCheckoutSession).mock.calls[0])
      .toEqual(vi.mocked(createDodoCheckoutSession).mock.calls[1]);
    expect(await t.run((ctx) => ctx.db.query("checkoutTimeoutEvents").collect())).toHaveLength(0);
  });

  test("returns a typed failure after a second timeout even with time remaining", async () => {
    pinRetryClock();
    pinRetryClockNow();
    const attempt = vi.fn().mockRejectedValue(new APIConnectionTimeoutError());
    expect(await runCheckoutWithRateLimitRetry(attempt, TEST_RETRY_OPTIONS))
      .toEqual({ checkoutFailed: true, code: "CHECKOUT_TIMED_OUT" });
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  test("refuses a timeout retry that cannot fit the budget", async () => {
    pinRetryClock();
    vi.spyOn(checkoutRetryClock, "now").mockReturnValueOnce(0).mockReturnValue(4_501);
    const attempt = vi.fn().mockRejectedValue(new APIConnectionTimeoutError());
    expect(await runCheckoutWithRateLimitRetry(attempt, TEST_RETRY_OPTIONS))
      .toEqual({ checkoutFailed: true, code: "CHECKOUT_TIMED_OUT" });
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  test("records a recurring timeout once and returns relay HTTP 500", async () => {
    process.env.DODO_IDENTITY_SIGNING_SECRET = TEST_SIGNING_SECRET;
    process.env.CONVEX_TENANT_RELAY_SECRET = TEST_RELAY_SECRET;
    pinRetryClock();
    vi.mocked(createDodoCheckoutSession).mockRejectedValue(new APIConnectionTimeoutError());
    const t = convexTest(schema, modules);
    const response = await t.fetch("/relay/create-checkout", {
      method: "POST",
      headers: { Authorization: `Bearer ${TEST_RELAY_SECRET}`, "Content-Type": "application/json" },
      body: JSON.stringify({ userId: TEST_USER.subject, productId: PRODUCT_CATALOG.pro_monthly.dodoProductId! }),
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: "CHECKOUT_TIMED_OUT" });
    expect(createDodoCheckoutSession).toHaveBeenCalledTimes(2);
    const events = await t.run((ctx) => ctx.db.query("checkoutTimeoutEvents").collect());
    expect(events).toHaveLength(1);
    expect(await t.run((ctx) => ctx.db.query("checkoutRateLimitEvents").collect())).toHaveLength(0);
  });

  test.each(["timeout-first", "rate-limit-first"])("mixed failures stay bounded: %s", async (order) => {
    pinRetryClock();
    let now = 0;
    vi.spyOn(checkoutRetryClock, "now").mockImplementation(() => now);
    vi.spyOn(checkoutRetryClock, "sleep").mockImplementation(async (ms) => { now += ms; });
    const failures = order === "timeout-first"
      ? [new APIConnectionTimeoutError(), sdkRateLimitError()]
      : [sdkRateLimitError(), new APIConnectionTimeoutError()];
    const attempt = vi.fn().mockImplementation(async () => {
      const error = failures.shift();
      if (error instanceof APIConnectionTimeoutError) now += 3_500;
      if (error) throw error;
      return { checkout_url: "https://checkout.example/recovered" };
    });
    const result = await runCheckoutWithRateLimitRetry(attempt, TEST_RETRY_OPTIONS);
    if (order === "timeout-first") {
      expect(result).toMatchObject({ code: CHECKOUT_RATE_LIMITED });
      expect(attempt).toHaveBeenCalledTimes(2);
    } else {
      expect(result).toEqual({ checkout_url: "https://checkout.example/recovered" });
      expect(attempt).toHaveBeenCalledTimes(3);
    }
  });

  test("late timers cannot admit a timeout retry past the budget", async () => {
    pinRetryClock();
    vi.spyOn(checkoutRetryClock, "now").mockReturnValueOnce(0)
      .mockReturnValueOnce(3_500).mockReturnValue(4_501);
    const attempt = vi.fn().mockRejectedValue(new APIConnectionTimeoutError());
    expect(await runCheckoutWithRateLimitRetry(attempt, TEST_RETRY_OPTIONS))
      .toMatchObject({ code: "CHECKOUT_TIMED_OUT" });
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  test("public action rejects a terminal timeout with its typed code", async () => {
    process.env.DODO_IDENTITY_SIGNING_SECRET = TEST_SIGNING_SECRET;
    pinRetryClock();
    vi.mocked(createDodoCheckoutSession).mockRejectedValue(new APIConnectionTimeoutError());
    const t = convexTest(schema, modules);
    await expect(t.withIdentity(TEST_USER).action(api.payments.checkout.createCheckout, {
      productId: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
    })).rejects.toThrow("CHECKOUT_TIMED_OUT");
    expect(await t.run((ctx) => ctx.db.query("checkoutTimeoutEvents").collect())).toHaveLength(1);
  });

  test("timeout recording fails open", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const ctx = { runMutation: vi.fn().mockRejectedValue(new Error("write unavailable")) } as unknown as ActionCtx;
    await expect(recordTerminalCheckoutTimeout(ctx, {
      userId: TEST_USER.subject, productId: "product",
    })).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("failed to record terminal CHECKOUT_TIMED_OUT"));
  });

  test("timeout recording prunes only expired timeout events", async () => {
    const t = convexTest(schema, modules);
    const now = FIXED_NOW;
    await t.run(async (ctx) => {
      for (const occurredAt of [now - CHECKOUT_RATE_LIMIT_EVENT_RETENTION_MS - 1, now - 1]) {
        await ctx.db.insert("checkoutTimeoutEvents", { userId: "user", productId: "product", occurredAt });
      }
    });
    await t.mutation(internal.payments.checkoutRateLimitAlarm.recordCheckoutTimedOut, {
      userId: "user", productId: "product", occurredAt: now,
    });
    const rows = await t.run((ctx) => ctx.db.query("checkoutTimeoutEvents").collect());
    expect(rows.map((row) => row.occurredAt).sort()).toEqual([now - 1, now].sort());
  });

});
