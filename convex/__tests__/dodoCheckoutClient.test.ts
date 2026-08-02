import { afterEach, describe, expect, test, vi } from "vitest";

const { checkoutCreate, constructorCalls } = vi.hoisted(() => ({
  checkoutCreate: vi.fn(),
  constructorCalls: [] as unknown[],
}));

vi.mock("dodopayments", () => ({
  DodoPayments: class {
    checkoutSessions = { create: checkoutCreate };

    constructor(options: unknown) {
      constructorCalls.push(options);
    }
  },
}));

import {
  CHECKOUT_PROVIDER_ATTEMPT_TIMEOUT_MS,
  createDodoCheckoutSession,
  type CheckoutSessionPayload,
} from "../lib/dodo";

const originalApiKey = process.env.DODO_API_KEY;
const originalEnvironment = process.env.DODO_PAYMENTS_ENVIRONMENT;

afterEach(() => {
  checkoutCreate.mockReset();
  constructorCalls.length = 0;
  if (originalApiKey === undefined) delete process.env.DODO_API_KEY;
  else process.env.DODO_API_KEY = originalApiKey;
  if (originalEnvironment === undefined) {
    delete process.env.DODO_PAYMENTS_ENVIRONMENT;
  } else {
    process.env.DODO_PAYMENTS_ENVIRONMENT = originalEnvironment;
  }
});

describe("Dodo checkout production client seam", () => {
  test("constructs the SDK with retries disabled and creates the payload exactly once", async () => {
    process.env.DODO_API_KEY = "test-dodo-api-key";
    process.env.DODO_PAYMENTS_ENVIRONMENT = "live_mode";
    checkoutCreate.mockResolvedValue({
      session_id: "cks_retry_owner",
      checkout_url: "https://checkout.dodopayments.com/cks_retry_owner",
    });
    const payload: CheckoutSessionPayload = {
      product_cart: [{ product_id: "prod_retry_owner", quantity: 1 }],
      return_url: "https://worldmonitor.app/?wm_checkout=return",
    };

    const result = await createDodoCheckoutSession(payload);

    expect(constructorCalls).toHaveLength(1);
    expect(constructorCalls[0]).toMatchObject({
      bearerToken: "test-dodo-api-key",
      maxRetries: 0,
      timeout: CHECKOUT_PROVIDER_ATTEMPT_TIMEOUT_MS,
    });
    expect(checkoutCreate).toHaveBeenCalledTimes(1);
    expect(checkoutCreate).toHaveBeenCalledWith(payload);
    expect(result).toEqual({
      checkout_url: "https://checkout.dodopayments.com/cks_retry_owner",
    });
  });
});
