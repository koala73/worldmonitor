/**
 * #6716 — the MCP paid-funnel attribution round trip.
 *
 * The whole point of the feature is being able to count conversions that
 * started from an MCP denial, and the value has to survive two hops to do that:
 * the checkout action must stamp `metadata.wm_attribution`, and the activation
 * webhook must copy it onto the subscription row — on the FIRST activation only,
 * so a renewal or a webhook replay cannot rewrite the origin of a conversion.
 *
 * Neither hop had any coverage. Both are allowlist-guarded, so the negative
 * cases below matter as much as the positive ones: an unvalidated marker would
 * let a crafted `?utm_campaign=` value ride into payment-provider metadata and
 * into the analytics that drive spend decisions.
 *
 * Mocks `../lib/dodo` for the same reason checkoutLoginEmailMetadata.test.ts
 * does: the sibling checkout.test.ts runs with DODO_API_KEY unset so that
 * reaching the provider is itself an assertion.
 */
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { internal } from "../_generated/api";
import { createDodoCheckoutSession } from "../lib/dodo";
import { signUserId } from "../lib/identitySigning";
import { MCP_ATTRIBUTION_SOURCE } from "../../shared/mcp-attribution";
import schema from "../schema";

vi.mock("../lib/dodo", () => ({
  CHECKOUT_PROVIDER_ATTEMPT_TIMEOUT_MS: 3_500,
  createDodoCheckoutSession: vi.fn(),
}));

const modules = import.meta.glob("../**/*.ts");
const PRODUCT_ID = "pdt_0Nbtt71uObulf7fGXhQup";
const USER_ID = "user_mcp_attribution";

function capturedMetadata(): Record<string, string> {
  expect(createDodoCheckoutSession).toHaveBeenCalledTimes(1);
  const payload = vi.mocked(createDodoCheckoutSession).mock.calls[0][0] as {
    metadata?: Record<string, string>;
  };
  return payload.metadata ?? {};
}

const SIGNING_SECRET = "mcp-attribution-round-trip-signing-secret";

beforeEach(() => {
  // The activation webhook only trusts `wm_user_id` when it arrives with a
  // valid `wm_user_id_sig`; without the secret no subscription row is created
  // at all and every assertion below would pass vacuously on an absent row.
  process.env.DODO_IDENTITY_SIGNING_SECRET = SIGNING_SECRET;
  vi.mocked(createDodoCheckoutSession).mockResolvedValue({
    checkout_url: "https://checkout.example/session",
  });
});

afterEach(() => {
  vi.mocked(createDodoCheckoutSession).mockReset();
  vi.restoreAllMocks();
  delete process.env.DODO_IDENTITY_SIGNING_SECRET;
});

describe("checkout stamps the MCP campaign marker (#6716)", () => {
  test("an allowlisted attributionSource reaches provider metadata as wm_attribution", async () => {
    const t = convexTest(schema, modules);
    await t.action(internal.payments.checkout.internalCreateCheckout, {
      userId: USER_ID,
      productId: PRODUCT_ID,
      attributionSource: MCP_ATTRIBUTION_SOURCE,
    });
    expect(capturedMetadata().wm_attribution).toBe(MCP_ATTRIBUTION_SOURCE);
  });

  test("an arbitrary attributionSource is dropped, never forwarded", async () => {
    // The value originates in a URL query param, so the allowlist is the only
    // thing standing between a crafted link and the conversion analytics.
    const t = convexTest(schema, modules);
    await t.action(internal.payments.checkout.internalCreateCheckout, {
      userId: USER_ID,
      productId: PRODUCT_ID,
      attributionSource: "competitor-campaign",
    });
    expect(capturedMetadata().wm_attribution).toBeUndefined();
  });

  test("it is never confused with affiliate referral attribution", async () => {
    const t = convexTest(schema, modules);
    await t.action(internal.payments.checkout.internalCreateCheckout, {
      userId: USER_ID,
      productId: PRODUCT_ID,
      attributionSource: MCP_ATTRIBUTION_SOURCE,
    });
    const metadata = capturedMetadata();
    expect(metadata.wm_attribution).toBe(MCP_ATTRIBUTION_SOURCE);
    // affonso_referral drives real affiliate payouts — an internal source tag
    // must never land there.
    expect(metadata.affonso_referral).toBeUndefined();
  });

  test("omitting it stamps nothing", async () => {
    const t = convexTest(schema, modules);
    await t.action(internal.payments.checkout.internalCreateCheckout, {
      userId: USER_ID,
      productId: PRODUCT_ID,
    });
    expect(capturedMetadata().wm_attribution).toBeUndefined();
  });
});

describe("first activation stamps attributionSource onto the subscription (#6716)", () => {
  async function activate(t: ReturnType<typeof convexTest>, metadata: Record<string, unknown>) {
    await t.mutation(internal.payments.webhookMutations.processWebhookEvent, {
      webhookId: `msg_mcp_attr_${Math.random().toString(36).slice(2, 8)}`,
      eventType: "subscription.active",
      rawPayload: {
        type: "subscription.active",
        data: {
          subscription_id: "sub_mcp_attr",
          product_id: PRODUCT_ID,
          status: "active",
          customer: { customer_id: "cus_mcp_attr" },
          metadata: { wm_user_id: USER_ID, wm_user_id_sig: await signUserId(USER_ID), ...metadata },
          previous_billing_date: new Date(Date.now() - 23 * 86_400_000).toISOString(),
          next_billing_date: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        },
      },
      timestamp: Date.now(),
    });
  }

  const readRow = (t: ReturnType<typeof convexTest>) =>
    t.run(async (ctx) =>
      ctx.db
        .query("subscriptions")
        .filter((q) => q.eq(q.field("dodoSubscriptionId"), "sub_mcp_attr"))
        .first());

  test("the marker is copied onto the inserted row", async () => {
    const t = convexTest(schema, modules);
    await activate(t, { wm_attribution: MCP_ATTRIBUTION_SOURCE });
    const row = await readRow(t);
    // Guard against the vacuous pass: if identity resolution ever stops working
    // there is no row, and `undefined?.attributionSource` would quietly satisfy
    // the negative tests below.
    expect(row, "the activation must actually insert a subscription row").toBeTruthy();
    expect(row?.attributionSource).toBe(MCP_ATTRIBUTION_SOURCE);
  });

  test("an arbitrary metadata value is not persisted", async () => {
    // The webhook body is provider-controlled; the reader validates through the
    // same shared allowlist the writer uses, so the two cannot drift.
    const t = convexTest(schema, modules);
    await activate(t, { wm_attribution: "not-our-campaign" });
    const row = await readRow(t);
    expect(row, "the row must exist for this assertion to mean anything").toBeTruthy();
    expect(row?.attributionSource).toBeUndefined();
  });

  test("a later activation does not overwrite the original attribution", async () => {
    // Renewals and webhook replays must not rewrite where a conversion came
    // from — otherwise the funnel's own numbers drift with retry traffic.
    const t = convexTest(schema, modules);
    await activate(t, { wm_attribution: MCP_ATTRIBUTION_SOURCE });
    await activate(t, {});
    expect((await readRow(t))?.attributionSource).toBe(MCP_ATTRIBUTION_SOURCE);
  });
});
