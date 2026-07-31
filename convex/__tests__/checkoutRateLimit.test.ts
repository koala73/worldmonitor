import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";

import { api } from "../_generated/api";
import { checkout } from "../lib/dodo";
import {
  CHECKOUT_RATE_LIMITED,
  CHECKOUT_RETRY_AFTER_SECONDS,
  checkoutRateLimitedOutcomeFromError,
  isCheckoutRateLimitedOutcome,
} from "../payments/checkoutRateLimit";
import schema from "../schema";

vi.mock("../lib/dodo", () => ({
  checkout: vi.fn(),
}));

const modules = import.meta.glob("../**/*.ts");
const TEST_SIGNING_SECRET = "checkout-rate-limit-test-signing-secret";
const TEST_RELAY_SECRET = "checkout-rate-limit-test-relay-secret";
const TEST_USER = {
  subject: "user_checkout_rate_limit",
  tokenIdentifier: "clerk|user_checkout_rate_limit",
  email: "rate-limit@example.com",
};

function mockObservedProviderRateLimit() {
  vi.mocked(checkout).mockRejectedValueOnce(
    new Error("Failed to create checkout session: 429 status code (no body)"),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.DODO_IDENTITY_SIGNING_SECRET;
  delete process.env.RELAY_SHARED_SECRET;
});

describe("checkout rate-limit outcome", () => {
  test("recognizes the observed Dodo 429 error and returns a bounded retry hint", () => {
    const result = checkoutRateLimitedOutcomeFromError(
      new Error("Failed to create checkout session: 429 status code (no body)"),
    );

    expect(result).toEqual({
      checkoutFailed: true,
      code: CHECKOUT_RATE_LIMITED,
      retryAfterSeconds: CHECKOUT_RETRY_AFTER_SECONDS,
    });
    expect(isCheckoutRateLimitedOutcome(result)).toBe(true);
  });

  test("does not reclassify other upstream failures as rate limiting", () => {
    expect(
      checkoutRateLimitedOutcomeFromError(
        new Error("Failed to create checkout session: 503 no healthy upstream"),
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

  test("the internal relay preserves the real action outcome as HTTP 429", async () => {
    process.env.DODO_IDENTITY_SIGNING_SECRET = TEST_SIGNING_SECRET;
    process.env.RELAY_SHARED_SECRET = TEST_RELAY_SECRET;
    mockObservedProviderRateLimit();
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
    expect(await response.json()).toEqual({
      error: CHECKOUT_RATE_LIMITED,
      message: "Checkout is temporarily rate limited. Retry shortly.",
    });
  });

  test("the public action keeps provider rate limits on its error channel", async () => {
    process.env.DODO_IDENTITY_SIGNING_SECRET = TEST_SIGNING_SECRET;
    mockObservedProviderRateLimit();
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
