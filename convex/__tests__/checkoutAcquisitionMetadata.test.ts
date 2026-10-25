/**
 * The checkout stamps the buyer's first-touch acquisition source onto provider
 * metadata as `wm_acq_*`, so subscriptions carry channel next to billing
 * country. The value starts in a browser cookie, so the action re-validates it:
 * a crafted value must be dropped, and it must never land in the identity or
 * affiliate keys.
 *
 * Mocks `../lib/dodo` for the same reason checkoutLoginEmailMetadata.test.ts
 * does: the sibling checkout.test.ts runs with DODO_API_KEY unset so that
 * reaching the provider is itself an assertion.
 */
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { internal } from "../_generated/api";
import { createDodoCheckoutSession } from "../lib/dodo";
import schema from "../schema";

vi.mock("../lib/dodo", () => ({
  CHECKOUT_PROVIDER_ATTEMPT_TIMEOUT_MS: 3_500,
  createDodoCheckoutSession: vi.fn(),
}));

const modules = import.meta.glob("../**/*.ts");
const PRODUCT_ID = "pdt_0Nbtt71uObulf7fGXhQup";
const USER_ID = "user_acquisition_metadata";

function capturedMetadata(): Record<string, string> {
  expect(createDodoCheckoutSession).toHaveBeenCalledTimes(1);
  const payload = vi.mocked(createDodoCheckoutSession).mock.calls[0][0] as {
    metadata?: Record<string, string>;
  };
  return payload.metadata ?? {};
}

beforeEach(() => {
  process.env.DODO_IDENTITY_SIGNING_SECRET = "acquisition-metadata-signing-secret";
  vi.mocked(createDodoCheckoutSession).mockResolvedValue({
    checkout_url: "https://checkout.example/session",
  });
});

afterEach(() => {
  vi.mocked(createDodoCheckoutSession).mockReset();
  vi.restoreAllMocks();
  delete process.env.DODO_IDENTITY_SIGNING_SECRET;
});

describe("checkout stamps the first-touch acquisition source", () => {
  test("each field reaches provider metadata under its wm_acq_* key", async () => {
    const t = convexTest(schema, modules);
    await t.action(internal.payments.checkout.internalCreateCheckout, {
      userId: USER_ID,
      productId: PRODUCT_ID,
      acquisition: {
        source: "twitter",
        medium: "social",
        campaign: "hormuz-launch",
        referrer: "t.co",
        landing: "pricing",
        firstSeen: "2026-10-24",
      },
    });
    const metadata = capturedMetadata();
    expect(metadata).toMatchObject({
      wm_acq_source: "twitter",
      wm_acq_medium: "social",
      wm_acq_campaign: "hormuz-launch",
      wm_acq_referrer: "t.co",
      wm_acq_landing: "pricing",
      wm_acq_first_seen: "2026-10-24",
      wm_user_id: USER_ID,
    });
  });

  test("malformed values are dropped and never reach identity or affiliate keys", async () => {
    const t = convexTest(schema, modules);
    await t.action(internal.payments.checkout.internalCreateCheckout, {
      userId: USER_ID,
      productId: PRODUCT_ID,
      acquisition: { referrer: "evil host/path", landing: "admin", firstSeen: "yesterday", medium: "cpc" },
    });
    const metadata = capturedMetadata();
    expect(metadata.wm_acq_medium).toBe("cpc");
    expect(metadata.wm_acq_referrer).toBeUndefined();
    expect(metadata.wm_acq_landing).toBeUndefined();
    expect(metadata.wm_acq_first_seen).toBeUndefined();
    expect(metadata.wm_user_id).toBe(USER_ID);
    expect(metadata.affonso_referral).toBeUndefined();
    expect(metadata.wm_attribution).toBeUndefined();
  });

  test("the /relay/create-checkout route forwards it, and a stray key cannot fail the checkout", async () => {
    vi.stubEnv("CONVEX_TENANT_RELAY_SECRET", "acq-relay-secret");
    try {
      const t = convexTest(schema, modules);
      const response = await t.fetch("/relay/create-checkout", {
        method: "POST",
        headers: { Authorization: "Bearer acq-relay-secret", "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: USER_ID,
          productId: PRODUCT_ID,
          acquisition: { source: "reddit", referrer: "reddit.com", unexpected: "x" },
        }),
      });
      expect(response.status).toBe(200);
      const metadata = capturedMetadata();
      expect(metadata.wm_acq_source).toBe("reddit");
      expect(metadata.wm_acq_referrer).toBe("reddit.com");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("omitting it stamps no wm_acq_* key", async () => {
    const t = convexTest(schema, modules);
    await t.action(internal.payments.checkout.internalCreateCheckout, {
      userId: USER_ID,
      productId: PRODUCT_ID,
    });
    expect(Object.keys(capturedMetadata()).filter((key) => key.startsWith("wm_acq_"))).toEqual([]);
  });
});
