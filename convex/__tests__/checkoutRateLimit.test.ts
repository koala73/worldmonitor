import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";

import { api } from "../_generated/api";
import { createDodoCheckoutSession } from "../lib/dodo";
import {
  CHECKOUT_RATE_LIMITED,
  CHECKOUT_RATE_LIMIT_MAX_ATTEMPTS,
  CHECKOUT_RATE_LIMIT_RETRY_BUDGET_MS,
  CHECKOUT_RATE_LIMIT_RETRY_DELAYS_MS,
  CHECKOUT_RETRY_AFTER_SECONDS,
  checkoutRateLimitedOutcomeFromError,
  checkoutRetryClock,
  isCheckoutRateLimitedOutcome,
  retryAfterMsFromError,
  runCheckoutWithRateLimitRetry,
} from "../payments/checkoutRateLimit";
import schema from "../schema";

vi.mock("../lib/dodo", () => ({
  CHECKOUT_PROVIDER_ATTEMPT_TIMEOUT_MS: 3_500,
  createDodoCheckoutSession: vi.fn(),
}));

const modules = import.meta.glob("../**/*.ts");
const TEST_SIGNING_SECRET = "checkout-rate-limit-test-signing-secret";
const TEST_RELAY_SECRET = "checkout-rate-limit-test-relay-secret";
const TEST_PROVIDER_ATTEMPT_TIMEOUT_MS = 3_500;
const TEST_RETRY_OPTIONS = {
  attemptTimeoutMs: TEST_PROVIDER_ATTEMPT_TIMEOUT_MS,
} as const;
const TEST_USER = {
  subject: "user_checkout_rate_limit",
  tokenIdentifier: "clerk|user_checkout_rate_limit",
  email: "rate-limit@example.com",
};
// Matches ANON_ID_V4_REGEX (lowercase hex, version 4, variant [89ab]) so the
// anonymous-claim-token merge path activates.
const ANON_USER_ID = "1f2e3d4c-5b6a-4789-8abc-def012345678";

/** SDK-shaped rate-limit error: typed status, no 429 wording in the message. */
function sdkRateLimitError(headers?: Record<string, string>) {
  return Object.assign(new Error("Rate limited by provider"), {
    status: 429,
    ...(headers ? { headers: new Headers(headers) } : {}),
  });
}

// Persistent (not *Once) rejection: the action retries 429s through the
// bounded ladder, so a sustained provider limit must fail EVERY attempt to
// exercise the exhaustion path.
function mockSustainedProviderRateLimit() {
  vi.mocked(createDodoCheckoutSession).mockRejectedValue(sdkRateLimitError());
}

/**
 * Compress the retry ladder to zero wall-clock and pin jitter to its midpoint
 * (factor 1.0), so waits equal their base values exactly; every other code
 * path stays real.
 */
function pinRetryClock() {
  vi.spyOn(checkoutRetryClock, "random").mockReturnValue(0.5);
  return vi.spyOn(checkoutRetryClock, "sleep").mockResolvedValue(undefined);
}

afterEach(() => {
  vi.restoreAllMocks();
  // restoreAllMocks does not reset module-factory vi.fn()s — clear queued
  // once-values/implementations so no test inherits another's provider script.
  vi.mocked(createDodoCheckoutSession).mockReset();
  delete process.env.DODO_IDENTITY_SIGNING_SECRET;
  delete process.env.RELAY_SHARED_SECRET;
});

describe("checkout rate-limit classification", () => {
  test("recognizes a typed SDK 429 by status even without 429 wording", () => {
    const result = checkoutRateLimitedOutcomeFromError(sdkRateLimitError());

    expect(result).toEqual({
      checkoutFailed: true,
      code: CHECKOUT_RATE_LIMITED,
      retryAfterSeconds: CHECKOUT_RETRY_AFTER_SECONDS,
    });
    expect(isCheckoutRateLimitedOutcome(result)).toBe(true);
  });

  test("keeps recognizing the legacy component-era 429 message shape", () => {
    const result = checkoutRateLimitedOutcomeFromError(
      new Error("Failed to create checkout session: 429 status code (no body)"),
    );

    expect(result).toMatchObject({ code: CHECKOUT_RATE_LIMITED });
  });

  test("does not reclassify other upstream failures as rate limiting", () => {
    expect(
      checkoutRateLimitedOutcomeFromError(
        new Error("Failed to create checkout session: 503 no healthy upstream"),
      ),
    ).toBeNull();
    expect(
      checkoutRateLimitedOutcomeFromError(
        Object.assign(new Error("Bad request"), { status: 400 }),
      ),
    ).toBeNull();
    expect(
      isCheckoutRateLimitedOutcome({
        checkoutFailed: true,
        code: CHECKOUT_RATE_LIMITED,
        retryAfterSeconds: 999,
      }),
    ).toBe(false);
  });

  test("extracts an advertised Retry-After in ms, seconds, or not at all", () => {
    expect(
      retryAfterMsFromError(sdkRateLimitError({ "retry-after-ms": "1500" })),
    ).toBe(1500);
    expect(
      retryAfterMsFromError(sdkRateLimitError({ "retry-after": "3" })),
    ).toBe(3000);
    expect(retryAfterMsFromError(sdkRateLimitError())).toBeNull();
    expect(
      retryAfterMsFromError(sdkRateLimitError({ "retry-after": "soon" })),
    ).toBeNull();
    expect(retryAfterMsFromError(new Error("no headers"))).toBeNull();
  });
});

describe("relay and public action contracts", () => {
  test("a transient provider 429 is absorbed by the bounded retry and checkout succeeds (#6027)", async () => {
    process.env.DODO_IDENTITY_SIGNING_SECRET = TEST_SIGNING_SECRET;
    process.env.RELAY_SHARED_SECRET = TEST_RELAY_SECRET;
    const sleeps = pinRetryClock();
    // Local call counter instead of chained *Once mocks: an unconsumed once-
    // queue entry would leak into the next test (restoreAllMocks does not
    // clear module-factory vi.fn queues).
    let providerCalls = 0;
    vi.mocked(createDodoCheckoutSession).mockImplementation(async () => {
      providerCalls += 1;
      if (providerCalls === 1) {
        throw sdkRateLimitError();
      }
      return {
        checkout_url: "https://test.checkout.dodopayments.com/session/cks_transient",
      };
    });
    const t = convexTest(schema, modules);

    const response = await t.fetch("/relay/create-checkout", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_RELAY_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        userId: TEST_USER.subject,
        productId: "prod_rate_limited",
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      checkout_url: "https://test.checkout.dodopayments.com/session/cks_transient",
    });
    expect(providerCalls).toBe(2);
    expect(sleeps.mock.calls).toEqual([[CHECKOUT_RATE_LIMIT_RETRY_DELAYS_MS[0]]]);
  });

  test("an anonymous user keeps the claim token through an absorbed 429", async () => {
    process.env.DODO_IDENTITY_SIGNING_SECRET = TEST_SIGNING_SECRET;
    process.env.RELAY_SHARED_SECRET = TEST_RELAY_SECRET;
    pinRetryClock();
    let providerCalls = 0;
    vi.mocked(createDodoCheckoutSession).mockImplementation(async () => {
      providerCalls += 1;
      if (providerCalls === 1) {
        throw sdkRateLimitError();
      }
      return {
        checkout_url: "https://test.checkout.dodopayments.com/session/cks_anon",
      };
    });
    const t = convexTest(schema, modules);

    const response = await t.fetch("/relay/create-checkout", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_RELAY_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        userId: ANON_USER_ID,
        productId: "prod_rate_limited",
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      checkout_url: "https://test.checkout.dodopayments.com/session/cks_anon",
    });
    expect(typeof body.anonymous_claim_token).toBe("string");
    expect(body.anonymous_claim_token.length).toBeGreaterThan(0);
  });

  test("the internal relay preserves the real action outcome as HTTP 429", async () => {
    process.env.DODO_IDENTITY_SIGNING_SECRET = TEST_SIGNING_SECRET;
    process.env.RELAY_SHARED_SECRET = TEST_RELAY_SECRET;
    mockSustainedProviderRateLimit();
    const sleeps = pinRetryClock();
    const t = convexTest(schema, modules);

    const response = await t.fetch("/relay/create-checkout", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_RELAY_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        userId: TEST_USER.subject,
        productId: "prod_rate_limited",
      }),
    });

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe(
      String(CHECKOUT_RETRY_AFTER_SECONDS),
    );
    const body = await response.json();
    expect(body).toEqual({
      error: CHECKOUT_RATE_LIMITED,
      message: "Checkout is temporarily rate limited. Retry shortly.",
    });
    // The typed outcome must never leak an anonymous claim token.
    expect(body.anonymous_claim_token).toBeUndefined();
    // The whole bounded ladder ran before the typed outcome surfaced.
    expect(sleeps.mock.calls).toEqual(
      CHECKOUT_RATE_LIMIT_RETRY_DELAYS_MS.map((ms) => [ms]),
    );
  });

  test("a non-429 provider timeout remains relay HTTP 500 after one provider call", async () => {
    process.env.DODO_IDENTITY_SIGNING_SECRET = TEST_SIGNING_SECRET;
    process.env.RELAY_SHARED_SECRET = TEST_RELAY_SECRET;
    const sleeps = pinRetryClock();
    vi.mocked(createDodoCheckoutSession).mockRejectedValue(
      Object.assign(new Error("Request timed out."), { name: "TimeoutError" }),
    );
    const t = convexTest(schema, modules);

    const response = await t.fetch("/relay/create-checkout", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_RELAY_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        userId: TEST_USER.subject,
        productId: "prod_provider_timeout",
      }),
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining("Checkout failed: Request timed out."),
    });
    expect(createDodoCheckoutSession).toHaveBeenCalledTimes(1);
    expect(sleeps).not.toHaveBeenCalled();
  });

  test("the public action keeps provider rate limits on its error channel", async () => {
    process.env.DODO_IDENTITY_SIGNING_SECRET = TEST_SIGNING_SECRET;
    mockSustainedProviderRateLimit();
    pinRetryClock();
    const t = convexTest(schema, modules);

    const request = t.withIdentity(TEST_USER).action(
      api.payments.checkout.createCheckout,
      {
        productId: "prod_rate_limited",
      },
    );
    await expect(request).rejects.toBeInstanceOf(Error);
    await request.catch((error: unknown) => {
      const data = JSON.parse(String((error as { data?: unknown }).data));
      expect(data).toMatchObject({
        code: CHECKOUT_RATE_LIMITED,
        retryAfterSeconds: CHECKOUT_RETRY_AFTER_SECONDS,
      });
    });
  });
});

describe("runCheckoutWithRateLimitRetry", () => {
  test("a first-attempt success makes exactly one provider call and never sleeps", async () => {
    const sleeps = pinRetryClock();
    const attempt = vi.fn().mockResolvedValue({ checkout_url: "https://x" });
    const retries: number[] = [];

    const result = await runCheckoutWithRateLimitRetry(attempt, {
      ...TEST_RETRY_OPTIONS,
      onRetry: (ms) => retries.push(ms),
    });

    expect(result).toEqual({ checkout_url: "https://x" });
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(retries).toEqual([]);
    expect(sleeps).not.toHaveBeenCalled();
  });

  test("returns the typed outcome only after exhausting every ladder step", async () => {
    const sleeps = pinRetryClock();
    const attempt = vi.fn().mockRejectedValue(sdkRateLimitError());
    const retries: number[] = [];

    const result = await runCheckoutWithRateLimitRetry(attempt, {
      ...TEST_RETRY_OPTIONS,
      onRetry: (ms) => retries.push(ms),
    });

    expect(isCheckoutRateLimitedOutcome(result)).toBe(true);
    expect(attempt).toHaveBeenCalledTimes(CHECKOUT_RATE_LIMIT_MAX_ATTEMPTS);
    expect(retries).toEqual([...CHECKOUT_RATE_LIMIT_RETRY_DELAYS_MS]);
    expect(sleeps.mock.calls).toEqual(
      CHECKOUT_RATE_LIMIT_RETRY_DELAYS_MS.map((ms) => [ms]),
    );
  });

  test("jitter spreads the wait around the ladder step", async () => {
    const sleeps = vi
      .spyOn(checkoutRetryClock, "sleep")
      .mockResolvedValue(undefined);
    // random() = 1 -> factor 1.25 (upper jitter bound).
    vi.spyOn(checkoutRetryClock, "random").mockReturnValue(1);
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(sdkRateLimitError())
      .mockResolvedValueOnce({ checkout_url: "https://x" });

    await runCheckoutWithRateLimitRetry(attempt, TEST_RETRY_OPTIONS);

    expect(sleeps.mock.calls).toEqual([
      [Math.round(CHECKOUT_RATE_LIMIT_RETRY_DELAYS_MS[0] * 1.25)],
    ]);
  });

  test("low jitter never reduces an advertised Retry-After provider floor", async () => {
    const sleeps = vi
      .spyOn(checkoutRetryClock, "sleep")
      .mockResolvedValue(undefined);
    vi.spyOn(checkoutRetryClock, "random").mockReturnValue(0);
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(sdkRateLimitError({ "retry-after": "3" }))
      .mockResolvedValueOnce({ checkout_url: "https://x" });

    const result = await runCheckoutWithRateLimitRetry(
      attempt,
      TEST_RETRY_OPTIONS,
    );

    expect(result).toEqual({ checkout_url: "https://x" });
    // random() = 0 jitters the 1000ms ladder step down to 750ms, but the
    // provider's Retry-After remains a hard 3000ms floor.
    expect(sleeps.mock.calls).toEqual([[3000]]);
  });

  test("an advertised Retry-After beyond the budget bails to the typed outcome", async () => {
    const sleeps = pinRetryClock();
    const attempt = vi
      .fn()
      .mockRejectedValue(sdkRateLimitError({ "retry-after": "60" }));

    const result = await runCheckoutWithRateLimitRetry(
      attempt,
      TEST_RETRY_OPTIONS,
    );

    expect(isCheckoutRateLimitedOutcome(result)).toBe(true);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(sleeps).not.toHaveBeenCalled();
  });

  test("stops retrying once the next wait would cross the wall-clock budget", async () => {
    const sleeps = pinRetryClock();
    // First now() call anchors the deadline; every later check sits at the
    // deadline, so even the first retry's wait would cross it.
    vi.spyOn(checkoutRetryClock, "now")
      .mockReturnValueOnce(0)
      .mockReturnValue(CHECKOUT_RATE_LIMIT_RETRY_BUDGET_MS);
    const attempt = vi.fn().mockRejectedValue(sdkRateLimitError());
    const retries: number[] = [];

    const result = await runCheckoutWithRateLimitRetry(attempt, {
      ...TEST_RETRY_OPTIONS,
      onRetry: (ms) => retries.push(ms),
    });

    expect(isCheckoutRateLimitedOutcome(result)).toBe(true);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(retries).toEqual([]);
    expect(sleeps).not.toHaveBeenCalled();
  });

  test("a mid-ladder budget exhaustion bails after the retries that fit", async () => {
    const sleeps = pinRetryClock();
    // Deadline anchored at 0; the first pre- and post-wait checks pass, then
    // the second pre-wait check sits at the deadline and bails.
    vi.spyOn(checkoutRetryClock, "now")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValue(CHECKOUT_RATE_LIMIT_RETRY_BUDGET_MS);
    const attempt = vi.fn().mockRejectedValue(sdkRateLimitError());

    const result = await runCheckoutWithRateLimitRetry(
      attempt,
      TEST_RETRY_OPTIONS,
    );

    expect(isCheckoutRateLimitedOutcome(result)).toBe(true);
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(sleeps.mock.calls).toEqual([[CHECKOUT_RATE_LIMIT_RETRY_DELAYS_MS[0]]]);
  });

  test("does not start a retry unless its wait and maximum attempt fit the deadline", async () => {
    let nowMs = 0;
    vi.spyOn(checkoutRetryClock, "now").mockImplementation(() => nowMs);
    vi.spyOn(checkoutRetryClock, "random").mockReturnValue(0.5);
    const sleeps = vi
      .spyOn(checkoutRetryClock, "sleep")
      .mockImplementation(async (ms) => {
        nowMs += ms;
      });
    const attemptStarts: number[] = [];
    const attempt = vi.fn().mockImplementation(async () => {
      attemptStarts.push(nowMs);
      nowMs += 3_000;
      throw sdkRateLimitError();
    });

    const result = await runCheckoutWithRateLimitRetry(
      attempt,
      TEST_RETRY_OPTIONS,
    );

    expect(isCheckoutRateLimitedOutcome(result)).toBe(true);
    expect(attemptStarts).toEqual([0, 4_000]);
    expect(
      attemptStarts[1] + TEST_PROVIDER_ATTEMPT_TIMEOUT_MS,
    ).toBeLessThanOrEqual(CHECKOUT_RATE_LIMIT_RETRY_BUDGET_MS);
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(sleeps.mock.calls).toEqual([[CHECKOUT_RATE_LIMIT_RETRY_DELAYS_MS[0]]]);
  });

  test("rechecks the deadline after a late timer wakeup before starting the attempt", async () => {
    let nowMs = 0;
    vi.spyOn(checkoutRetryClock, "now").mockImplementation(() => nowMs);
    vi.spyOn(checkoutRetryClock, "random").mockReturnValue(0.5);
    const sleeps = vi
      .spyOn(checkoutRetryClock, "sleep")
      .mockImplementation(async () => {
        nowMs = 5_000;
      });
    const attempt = vi.fn().mockRejectedValue(sdkRateLimitError());

    const result = await runCheckoutWithRateLimitRetry(
      attempt,
      TEST_RETRY_OPTIONS,
    );

    expect(isCheckoutRateLimitedOutcome(result)).toBe(true);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(sleeps).toHaveBeenCalledTimes(1);
  });

  test("rethrows a non-429 failure immediately without retrying", async () => {
    const sleeps = pinRetryClock();
    const attempt = vi
      .fn()
      .mockRejectedValue(
        new Error("Failed to create checkout session: 503 no healthy upstream"),
      );

    await expect(
      runCheckoutWithRateLimitRetry(attempt, TEST_RETRY_OPTIONS),
    ).rejects.toThrow("503 no healthy upstream");
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(sleeps).not.toHaveBeenCalled();
  });

  test("rethrows a non-429 failure that follows an absorbed 429", async () => {
    pinRetryClock();
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(sdkRateLimitError())
      .mockRejectedValueOnce(new Error("Failed to create checkout session: 500"));

    await expect(
      runCheckoutWithRateLimitRetry(attempt, TEST_RETRY_OPTIONS),
    ).rejects.toThrow("500");
    expect(attempt).toHaveBeenCalledTimes(2);
  });
});

describe("provider client retry contract", () => {
  test("the checkout client pins maxRetries to 0 so the ladder is the only retry layer", async () => {
    // The dodopayments SDK defaults to maxRetries=2, retries 429s, and honors
    // Retry-After verbatim (uncapped). Composed under the action ladder that
    // would mean up to 9 raw provider requests per checkout and unboundable
    // in-flight attempts — the #6027 review's cross-model P1. This pins the
    // contract: the ladder owns ALL retry policy.
    const { buildCheckoutClientOptions, CHECKOUT_PROVIDER_ATTEMPT_TIMEOUT_MS } =
      await vi.importActual<typeof import("../lib/dodo")>("../lib/dodo");

    const options = buildCheckoutClientOptions({
      DODO_API_KEY: "test-key",
      DODO_PAYMENTS_ENVIRONMENT: "live_mode",
    });

    expect(options.maxRetries).toBe(0);
    expect(options.timeout).toBe(CHECKOUT_PROVIDER_ATTEMPT_TIMEOUT_MS);
    expect(options.bearerToken).toBe("test-key");
    // live_mode omits the environment override (SDK default is live).
    expect("environment" in options).toBe(false);

    const testOptions = buildCheckoutClientOptions({ DODO_API_KEY: "k" });
    expect(testOptions.environment).toBe("test_mode");

    expect(() => buildCheckoutClientOptions({})).toThrow(/DODO_API_KEY/);
  });
});
