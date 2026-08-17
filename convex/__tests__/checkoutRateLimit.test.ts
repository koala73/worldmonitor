import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";

import { api, internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
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
import {
  CHECKOUT_RATE_LIMIT_ALARM_COOLDOWN_MS,
  CHECKOUT_RATE_LIMIT_ALARM_DAY_THRESHOLD,
  CHECKOUT_RATE_LIMIT_EVENT_RETENTION_MS,
  recordTerminalCheckoutRateLimit,
} from "../payments/checkoutRateLimitAlarm";
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

/**
 * Fixed wall clock for the absolute-timestamp header cases. Whole seconds, so
 * an HTTP-date round-trip (which truncates to seconds) stays exact.
 */
const FIXED_NOW = 1_786_000_000_000;

/** Pin only the clock, leaving sleep/jitter untouched. */
function pinRetryClockNow() {
  return vi.spyOn(checkoutRetryClock, "now").mockReturnValue(FIXED_NOW);
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

  test("reads Retry-After in its RFC 9110 HTTP-date form", () => {
    pinRetryClockNow();

    expect(
      retryAfterMsFromError(
        sdkRateLimitError({
          "retry-after": new Date(FIXED_NOW + 5_000).toUTCString(),
        }),
      ),
    ).toBe(5_000);
  });

  /**
   * A numeric Retry-After must never reach the HTTP-date branch. V8 parses
   * "-5" as a real date (May 2001), so falling through would launder a
   * negative delta into a stale timestamp and clamp it to 0 — reporting "wait
   * zero" where the header was simply invalid and no floor was advertised.
   * Every RFC 9110 date form starts with a day name, so no valid date is lost.
   */
  test("rejects a negative numeric Retry-After instead of reading it as a date", () => {
    pinRetryClockNow();

    expect(
      retryAfterMsFromError(sdkRateLimitError({ "retry-after": "-5" })),
    ).toBeNull();
    expect(
      retryAfterMsFromError(sdkRateLimitError({ "retry-after": "-0.5" })),
    ).toBeNull();
    // A zero delta is advertised, not invalid — it stays 0, not null.
    expect(
      retryAfterMsFromError(sdkRateLimitError({ "retry-after": "0" })),
    ).toBe(0);
  });

  /**
   * Dodo advertises X-RateLimit-Reset on a limited response but does not
   * publish its unit, and the header is genuinely ambiguous in the wild — this
   * repo's own API emits it as epoch-MILLISECONDS
   * (server/_shared/api-key-rate-limit.ts) while the IETF draft's
   * RateLimit-Reset is delta-SECONDS. Reading an epoch as a delta would yield a
   * ~57-year floor and silently disable the ladder's retries, so each encoding
   * is pinned.
   */
  test("honors X-RateLimit-Reset across delta, epoch-seconds, and epoch-ms encodings", () => {
    pinRetryClockNow();

    // Delta-seconds (IETF RateLimit-Reset convention).
    expect(
      retryAfterMsFromError(sdkRateLimitError({ "x-ratelimit-reset": "30" })),
    ).toBe(30_000);

    // Epoch-seconds.
    expect(
      retryAfterMsFromError(
        sdkRateLimitError({
          "x-ratelimit-reset": String(FIXED_NOW / 1_000 + 30),
        }),
      ),
    ).toBe(30_000);

    // Epoch-milliseconds (this repo's own legacy convention).
    expect(
      retryAfterMsFromError(
        sdkRateLimitError({ "x-ratelimit-reset": String(FIXED_NOW + 45_000) }),
      ),
    ).toBe(45_000);
  });

  test("clamps an already-elapsed X-RateLimit-Reset to zero rather than going negative", () => {
    pinRetryClockNow();

    // A reset in the past must not produce a negative floor, which would
    // subtract from the jittered ladder wait.
    expect(
      retryAfterMsFromError(
        sdkRateLimitError({ "x-ratelimit-reset": String(FIXED_NOW - 60_000) }),
      ),
    ).toBe(0);
  });

  test("prefers an explicit Retry-After over the weaker X-RateLimit-Reset window hint", () => {
    pinRetryClockNow();

    expect(
      retryAfterMsFromError(
        sdkRateLimitError({
          "retry-after-ms": "1500",
          "retry-after": "3",
          "x-ratelimit-reset": "30",
        }),
      ),
    ).toBe(1_500);
    expect(
      retryAfterMsFromError(
        sdkRateLimitError({ "retry-after": "3", "x-ratelimit-reset": "30" }),
      ),
    ).toBe(3_000);
  });

  test("ignores an unparseable or negative X-RateLimit-Reset", () => {
    pinRetryClockNow();

    expect(
      retryAfterMsFromError(sdkRateLimitError({ "x-ratelimit-reset": "soon" })),
    ).toBeNull();
    expect(
      retryAfterMsFromError(sdkRateLimitError({ "x-ratelimit-reset": "-5" })),
    ).toBeNull();
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

// ---------------------------------------------------------------------------
// #6698 — the alarm on the tail of the ladder above.
//
// These run the REAL producer (the checkout action) into the REAL reducer (the
// recording mutation) with only the provider network stubbed. Pinning the two
// halves separately against hand-written literals would let the seam drift and
// leave the alarm silent with every test still green.
// ---------------------------------------------------------------------------
describe("terminal rate-limit alarm", () => {
  const ALARM_USER = "user_alarm_probe";
  const ALARM_PRODUCT = "prod_alarm_probe";

  async function readAlarmRows(t: ReturnType<typeof convexTest>) {
    return t.run(async (ctx) =>
      ctx.db.query("checkoutRateLimitEvents").withIndex("by_occurredAt").collect(),
    );
  }

  /** Drive one real relay checkout to a terminal 429. */
  async function exhaustLadderViaRelay(
    t: ReturnType<typeof convexTest>,
    productId = ALARM_PRODUCT,
  ) {
    const response = await t.fetch("/relay/create-checkout", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_RELAY_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ userId: ALARM_USER, productId }),
    });
    expect(response.status).toBe(429);
    return response;
  }

  test("an exhausted ladder records exactly one occurrence with its buyer context", async () => {
    process.env.DODO_IDENTITY_SIGNING_SECRET = TEST_SIGNING_SECRET;
    process.env.RELAY_SHARED_SECRET = TEST_RELAY_SECRET;
    mockSustainedProviderRateLimit();
    pinRetryClock();
    const t = convexTest(schema, modules);

    await exhaustLadderViaRelay(t);

    const rows = await readAlarmRows(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: ALARM_USER,
      productId: ALARM_PRODUCT,
    });
    expect(rows[0].occurredAt).toBeGreaterThan(0);
    // One buyer, one occurrence — the alarm must count terminal outcomes, not
    // the provider attempts the ladder made getting there.
    expect(createDodoCheckoutSession).toHaveBeenCalledTimes(
      CHECKOUT_RATE_LIMIT_MAX_ATTEMPTS,
    );
    expect(rows[0].alertedAt).toBeUndefined();
  });

  test("a checkout the ladder rescues records nothing", async () => {
    process.env.DODO_IDENTITY_SIGNING_SECRET = TEST_SIGNING_SECRET;
    process.env.RELAY_SHARED_SECRET = TEST_RELAY_SECRET;
    pinRetryClock();
    // 429 once, then success — #6027 working as designed. Counting this would
    // make the alarm measure provider turbulence the buyer never saw.
    vi.mocked(createDodoCheckoutSession)
      .mockRejectedValueOnce(sdkRateLimitError())
      .mockResolvedValue({ checkout_url: "https://checkout.dodopayments.com/ok" });
    const t = convexTest(schema, modules);

    const response = await t.fetch("/relay/create-checkout", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_RELAY_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ userId: ALARM_USER, productId: ALARM_PRODUCT }),
    });

    expect(response.status).toBe(200);
    expect(await readAlarmRows(t)).toHaveLength(0);
  });

  test("the public action path records too, so neither entry point is blind", async () => {
    process.env.DODO_IDENTITY_SIGNING_SECRET = TEST_SIGNING_SECRET;
    mockSustainedProviderRateLimit();
    pinRetryClock();
    const t = convexTest(schema, modules);

    await t
      .withIdentity(TEST_USER)
      .action(api.payments.checkout.createCheckout, { productId: ALARM_PRODUCT })
      .catch(() => undefined);

    const rows = await readAlarmRows(t);
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(TEST_USER.subject);
  });

  test("crossing the 24h threshold pages once and stamps the alert", async () => {
    const t = convexTest(schema, modules);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const base = Date.UTC(2026, 7, 14, 9, 0, 0);

    for (let i = 0; i < CHECKOUT_RATE_LIMIT_ALARM_DAY_THRESHOLD - 1; i += 1) {
      const verdict = await t.mutation(
        internal.payments.checkoutRateLimitAlarm.recordCheckoutRateLimited,
        { userId: ALARM_USER, productId: ALARM_PRODUCT, occurredAt: base + i * 60_000 },
      );
      expect(verdict.kind).toBe("below-threshold");
    }
    expect(errors).not.toHaveBeenCalled();

    const breach = await t.mutation(
      internal.payments.checkoutRateLimitAlarm.recordCheckoutRateLimited,
      {
        userId: ALARM_USER,
        productId: ALARM_PRODUCT,
        occurredAt: base + CHECKOUT_RATE_LIMIT_ALARM_DAY_THRESHOLD * 60_000,
      },
    );

    expect(breach.kind).toBe("alert");
    expect(errors).toHaveBeenCalledTimes(1);
    expect(String(errors.mock.calls[0][0])).toContain("[checkout-rate-limit-alarm]");
    expect(String(errors.mock.calls[0][0])).toContain(
      `day=${CHECKOUT_RATE_LIMIT_ALARM_DAY_THRESHOLD}/${CHECKOUT_RATE_LIMIT_ALARM_DAY_THRESHOLD}`,
    );

    const stamped = (await readAlarmRows(t)).filter((row) => row.alertedAt !== undefined);
    expect(stamped).toHaveLength(1);
  });

  test("a re-breach inside the cooldown does not page a second time", async () => {
    const t = convexTest(schema, modules);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const base = Date.UTC(2026, 7, 14, 9, 0, 0);

    for (let i = 0; i < CHECKOUT_RATE_LIMIT_ALARM_DAY_THRESHOLD; i += 1) {
      await t.mutation(
        internal.payments.checkoutRateLimitAlarm.recordCheckoutRateLimited,
        { userId: ALARM_USER, productId: ALARM_PRODUCT, occurredAt: base + i * 60_000 },
      );
    }
    expect(errors).toHaveBeenCalledTimes(1);
    // The cooldown runs from the ALERT, not from the first occurrence — the
    // breach happened on the last write of the loop above.
    const firstAlertAt = base + (CHECKOUT_RATE_LIMIT_ALARM_DAY_THRESHOLD - 1) * 60_000;

    const suppressed = await t.mutation(
      internal.payments.checkoutRateLimitAlarm.recordCheckoutRateLimited,
      {
        userId: ALARM_USER,
        productId: ALARM_PRODUCT,
        occurredAt: firstAlertAt + CHECKOUT_RATE_LIMIT_ALARM_COOLDOWN_MS - 1,
      },
    );
    expect(suppressed.kind).toBe("cooldown");
    expect(errors).toHaveBeenCalledTimes(1);

    // Exactly one cooldown later the alarm speaks again: a live incident must
    // stay visible, not go quiet after its first event.
    const reopened = await t.mutation(
      internal.payments.checkoutRateLimitAlarm.recordCheckoutRateLimited,
      {
        userId: ALARM_USER,
        productId: ALARM_PRODUCT,
        occurredAt: firstAlertAt + CHECKOUT_RATE_LIMIT_ALARM_COOLDOWN_MS,
      },
    );
    expect(reopened.kind).toBe("alert");
    expect(errors).toHaveBeenCalledTimes(2);
  });

  test("retention prunes only what both windows have finished with", async () => {
    const t = convexTest(schema, modules);
    const now = Date.UTC(2026, 7, 14, 9, 0, 0);
    const expired = now - CHECKOUT_RATE_LIMIT_EVENT_RETENTION_MS - 60_000;
    const insideRetention = now - CHECKOUT_RATE_LIMIT_EVENT_RETENTION_MS + 60_000;

    await t.mutation(
      internal.payments.checkoutRateLimitAlarm.recordCheckoutRateLimited,
      { userId: ALARM_USER, productId: ALARM_PRODUCT, occurredAt: expired },
    );
    await t.mutation(
      internal.payments.checkoutRateLimitAlarm.recordCheckoutRateLimited,
      { userId: ALARM_USER, productId: ALARM_PRODUCT, occurredAt: insideRetention },
    );
    // Only this third write carries a `now` recent enough to age the first row out.
    await t.mutation(
      internal.payments.checkoutRateLimitAlarm.recordCheckoutRateLimited,
      { userId: ALARM_USER, productId: ALARM_PRODUCT, occurredAt: now },
    );

    const remaining = (await readAlarmRows(t)).map((row) => row.occurredAt).sort();
    expect(remaining).toEqual([insideRetention, now]);
  });

  test("a failed recording keeps the buyer's outcome and reports the blind alarm", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const brokenCtx = {
      runMutation: vi.fn().mockRejectedValue(new Error("write conflict")),
    } as unknown as ActionCtx;

    // Fail-open: the wrapper must resolve, or a degraded alarm would convert a
    // retryable rate limit into a hard checkout failure for the buyer.
    await expect(
      recordTerminalCheckoutRateLimit(brokenCtx, {
        userId: ALARM_USER,
        productId: ALARM_PRODUCT,
      }),
    ).resolves.toBeUndefined();

    // ...but silence here would leave the alarm dead with nothing to show for
    // it, so the failure is itself an ops signal.
    expect(errors).toHaveBeenCalledTimes(1);
    expect(String(errors.mock.calls[0][0])).toContain("the rate alarm is blind");
    expect(String(errors.mock.calls[0][0])).toContain("write conflict");
  });
});
