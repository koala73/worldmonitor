/**
 * The running promotion's code is applied by the server to every checkout for
 * its product, whatever surface started it, until its end instant. Clients
 * only display the offer.
 *
 * Mocks `../lib/dodo` like checkoutAcquisitionMetadata.test.ts. The clock is
 * pinned on both sides of the end instant so these cases do not change meaning
 * when the real offer ends.
 */
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { APIError, NotFoundError } from "dodopayments";

import { internal } from "../_generated/api";
import { isDiscountRejection } from "../payments/checkout";
import { PRODUCT_CATALOG } from "../config/productCatalog";
import { createDodoCheckoutSession } from "../lib/dodo";
import schema from "../schema";
import { ACTIVE_PROMO } from "../../shared/promo-campaign";

vi.mock("../lib/dodo", () => ({
  CHECKOUT_PROVIDER_ATTEMPT_TIMEOUT_MS: 3_500,
  createDodoCheckoutSession: vi.fn(),
}));

const modules = import.meta.glob("../**/*.ts");
const USER_ID = "user_promo_checkout";
const PROMO = ACTIVE_PROMO!;
const DURING = PROMO.endsAtMs - 60 * 60 * 1000;
const AFTER = PROMO.endsAtMs;

type Payload = { discount_code?: string; metadata?: Record<string, string> };

function payloads(): Payload[] {
  return vi.mocked(createDodoCheckoutSession).mock.calls.map((call) => call[0] as Payload);
}

// The error Dodo's SDK threw live (2026-11-26) for a discount code that does
// not exist, on checkoutSessions.create and on previewChangePlan alike: a
// NotFoundError, built here the way the SDK builds it from the response.
const MISSING_CODE_BODY = { code: "NOT_FOUND", message: "Discount code 'BLACKFRIDAY50' doesn't exist" };
function discountRejection(): Error {
  return APIError.generate(404, { ...MISSING_CODE_BODY }, undefined, new Headers());
}

async function checkout(productId: string, extra: { discountCode?: string } = {}) {
  const t = convexTest(schema, modules);
  return t.action(internal.payments.checkout.internalCreateCheckout, {
    userId: USER_ID,
    productId,
    ...extra,
  });
}

beforeEach(() => {
  process.env.DODO_IDENTITY_SIGNING_SECRET = "promo-checkout-signing-secret";
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.mocked(createDodoCheckoutSession).mockResolvedValue({
    checkout_url: "https://checkout.example/session",
    session_id: "cks_promo",
  });
});

afterEach(() => {
  vi.mocked(createDodoCheckoutSession).mockReset();
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete process.env.DODO_IDENTITY_SIGNING_SECRET;
});

describe("checkout applies the running promotion", () => {
  test("the promotion targets the catalog's Pro Yearly product", () => {
    expect(PROMO.productId).toBe(PRODUCT_CATALOG.pro_annual.dodoProductId);
    expect(PROMO.planKey).toBe("pro_annual");
  });

  test("a Pro Yearly checkout before the end gets the code and the wm_promo marker", async () => {
    vi.setSystemTime(DURING);
    await checkout(PROMO.productId);
    expect(payloads()).toHaveLength(1);
    expect(payloads()[0].discount_code).toBe(PROMO.discountCode);
    expect(payloads()[0].metadata?.wm_promo).toBe(PROMO.id);
    expect(payloads()[0].metadata?.wm_user_id).toBe(USER_ID);
  });

  test("at the end instant the code is no longer applied", async () => {
    vi.setSystemTime(AFTER);
    await checkout(PROMO.productId);
    expect(payloads()[0].discount_code).toBeUndefined();
    expect(payloads()[0].metadata?.wm_promo).toBeUndefined();
  });

  test("another product never gets the code", async () => {
    vi.setSystemTime(DURING);
    await checkout(PRODUCT_CATALOG.pro_monthly.dodoProductId!);
    expect(payloads()[0].discount_code).toBeUndefined();
    expect(payloads()[0].metadata?.wm_promo).toBeUndefined();
  });

  test("a code the caller sent wins over the promotion", async () => {
    vi.setSystemTime(DURING);
    await checkout(PROMO.productId, { discountCode: "PARTNER20" });
    expect(payloads()[0].discount_code).toBe("PARTNER20");
    expect(payloads()[0].metadata?.wm_promo).toBeUndefined();
  });

  test("an empty caller code counts as no code, so the promotion applies", async () => {
    vi.setSystemTime(DURING);
    await checkout(PROMO.productId, { discountCode: "" });
    expect(payloads()[0].discount_code).toBe(PROMO.discountCode);
    expect(payloads()[0].metadata?.wm_promo).toBe(PROMO.id);
  });

  test("a rejected promo code retries once at list price and the buyer still gets a session", async () => {
    vi.setSystemTime(DURING);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(createDodoCheckoutSession)
      .mockRejectedValueOnce(discountRejection())
      .mockResolvedValueOnce({ checkout_url: "https://checkout.example/list", session_id: "cks_list" });

    const result = await checkout(PROMO.productId);

    expect(result).toMatchObject({ checkout_url: "https://checkout.example/list" });
    expect(payloads()).toHaveLength(2);
    expect(payloads()[0].discount_code).toBe(PROMO.discountCode);
    expect(payloads()[1].discount_code).toBeUndefined();
    expect(payloads()[1].metadata?.wm_promo).toBeUndefined();
    expect(payloads()[1].metadata?.wm_user_id).toBe(USER_ID);
    expect(warn.mock.calls.some((args) => String(args[0]).includes("promo_code_rejected"))).toBe(true);
  });

  test("the list-price retry shares the first attempt's time budget", async () => {
    // The edge relay aborts at 15s; the ladder's budget is 8s. A discount
    // rejection that arrives late must not open a second 8s budget.
    vi.setSystemTime(DURING);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(createDodoCheckoutSession).mockImplementationOnce(async () => {
      vi.setSystemTime(Date.now() + 6_000);
      throw discountRejection();
    });

    const result = await checkout(PROMO.productId);

    expect(payloads()).toHaveLength(1);
    expect(result).toMatchObject({ checkoutFailed: true, code: "CHECKOUT_TIMED_OUT" });
  });

  test("a rejected caller-supplied code is not retried", async () => {
    vi.setSystemTime(DURING);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(createDodoCheckoutSession).mockRejectedValueOnce(discountRejection());

    await expect(checkout(PROMO.productId, { discountCode: "PARTNER20" })).rejects.toThrow();
    expect(payloads()).toHaveLength(1);
  });

  test("a non-discount failure with the promo applied is not retried without the code", async () => {
    vi.setSystemTime(DURING);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(createDodoCheckoutSession).mockRejectedValueOnce(
      Object.assign(new Error("500 internal error"), { status: 500, error: { code: "INTERNAL" } }),
    );

    await expect(checkout(PROMO.productId)).rejects.toThrow();
    expect(payloads()).toHaveLength(1);
  });
});

// Recorded live on 2026-11-26 with BLACKFRIDAY50, a code that does not exist.
// Both calls threw a NotFoundError (APIError, DodoPaymentsError, Error) whose
// own keys are status, headers and error; `err.code` and `err.error.error`
// are absent.
describe("isDiscountRejection on the shapes Dodo returned live", () => {
  test("probe A: checkoutSessions.create with an unknown code", () => {
    const err = APIError.generate(404, { ...MISSING_CODE_BODY }, undefined, new Headers());
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.message).toBe("404 Discount code 'BLACKFRIDAY50' doesn't exist");
    expect((err as { error?: unknown }).error).toEqual(MISSING_CODE_BODY);
    expect(isDiscountRejection(err)).toBe(true);
  });

  test("probe B: previewChangePlan with an unknown code", () => {
    const err = APIError.generate(404, { ...MISSING_CODE_BODY }, undefined, new Headers());
    expect(err.status).toBe(404);
    expect(isDiscountRejection(err)).toBe(true);
  });

  // NOT_FOUND is Dodo's generic code, so only the message ties it to a discount.
  test("a 404 for something other than the code is not a discount rejection", () => {
    const err = APIError.generate(
      404,
      { code: "NOT_FOUND", message: "Subscription 'sub_x' doesn't exist" },
      undefined,
      new Headers(),
    );
    expect(isDiscountRejection(err)).toBe(false);
  });
});
