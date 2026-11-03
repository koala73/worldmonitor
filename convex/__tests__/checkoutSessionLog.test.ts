import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { PRODUCT_CATALOG } from "../config/productCatalog";
import { internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import { createDodoCheckoutSession } from "../lib/dodo";
import {
  CHECKOUT_SESSION_EVENT_RETENTION_MS,
  recordCreatedCheckoutSession,
} from "../payments/checkoutSessionLog";
import schema from "../schema";

vi.mock("../lib/dodo", () => ({
  CHECKOUT_PROVIDER_ATTEMPT_TIMEOUT_MS: 3_500,
  createDodoCheckoutSession: vi.fn(),
}));

const modules = import.meta.glob("../**/*.ts");
const PRODUCT_ID = PRODUCT_CATALOG.pro_monthly.dodoProductId!;
const USER_ID = "user_checkout_session_log";
const ANON_ID = "46e76f56-a3d1-41ee-aab2-589eef3565bf";
const SESSION = {
  checkout_url: "https://checkout.dodopayments.com/cks_funnel",
  session_id: "cks_funnel",
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(createDodoCheckoutSession).mockReset();
  delete process.env.DODO_IDENTITY_SIGNING_SECRET;
});

function setup() {
  process.env.DODO_IDENTITY_SIGNING_SECRET = "checkout-session-log-test-secret";
  return convexTest(schema, modules);
}

const rows = (t: ReturnType<typeof convexTest>) =>
  t.run((ctx) => ctx.db.query("checkoutSessionEvents").collect());

describe("checkout session log", () => {
  test("records the created session and keeps session_id out of the buyer response", async () => {
    vi.mocked(createDodoCheckoutSession).mockResolvedValue(SESSION);
    const t = setup();
    const result = await t.action(internal.payments.checkout.internalCreateCheckout, {
      userId: USER_ID,
      productId: PRODUCT_ID,
    });
    expect(result).toEqual({ checkout_url: SESSION.checkout_url });
    expect(await rows(t)).toEqual([
      expect.objectContaining({
        userId: USER_ID,
        productId: PRODUCT_ID,
        sessionId: "cks_funnel",
        anonymous: false,
      }),
    ]);
  });

  test("marks an anonymous buyer's session", async () => {
    vi.mocked(createDodoCheckoutSession).mockResolvedValue(SESSION);
    const t = setup();
    const result = await t.action(internal.payments.checkout.internalCreateCheckout, {
      userId: ANON_ID,
      productId: PRODUCT_ID,
    });
    expect(result).not.toHaveProperty("session_id");
    expect(result).toHaveProperty("anonymous_claim_token");
    expect(await rows(t)).toEqual([
      expect.objectContaining({ userId: ANON_ID, anonymous: true }),
    ]);
  });

  test("records nothing when Dodo creates no session", async () => {
    vi.mocked(createDodoCheckoutSession).mockRejectedValue(
      Object.assign(new Error("Server failure"), { status: 500 }),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    const t = setup();
    await expect(t.action(internal.payments.checkout.internalCreateCheckout, {
      userId: USER_ID,
      productId: PRODUCT_ID,
    })).rejects.toThrow();
    expect(await rows(t)).toEqual([]);
  });

  test("a failed log write never fails the checkout", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const ctx = { runMutation: vi.fn().mockRejectedValue(new Error("db down")) } as unknown as ActionCtx;
    await expect(recordCreatedCheckoutSession(ctx, {
      userId: USER_ID, productId: PRODUCT_ID, sessionId: "cks_x", anonymous: false,
    })).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("[checkout-session-log]"));
  });

  test("skips an account whose deletion has started", async () => {
    const t = setup();
    await t.run((ctx) => ctx.db.insert("accountDeletions", {
      userId: USER_ID, userIdHash: "hash", source: "self", status: "pending", step: "personal",
      dodoSubscriptionIds: [], cancelledDodoSubscriptionIds: [], startedAt: 1, updatedAt: 1,
    }));
    await t.mutation(internal.payments.checkoutSessionLog.recordCheckoutSessionCreated, {
      userId: USER_ID, productId: PRODUCT_ID, anonymous: false, occurredAt: Date.now(),
    });
    expect(await rows(t)).toEqual([]);
  });

  test("prunes rows past retention and counts a window", async () => {
    const t = setup();
    const now = 1_786_000_000_000;
    const record = (userId: string, occurredAt: number, anonymous = false) =>
      t.mutation(internal.payments.checkoutSessionLog.recordCheckoutSessionCreated, {
        userId, productId: PRODUCT_ID, anonymous, occurredAt,
      });
    await record("old", now - CHECKOUT_SESSION_EVENT_RETENTION_MS - 10_000);
    await record("a", now - 3_000);
    await record("a", now - 2_000);
    await record(ANON_ID, now - 1_000, true);
    expect((await rows(t)).map((r) => r.userId)).toEqual(["a", "a", ANON_ID]);
    expect(await t.query(internal.payments.checkoutSessionLog.countCheckoutSessions, {
      sinceMs: now - 10_000, untilMs: now,
    })).toEqual({
      sessions: 3, accounts: 2, signedInSessions: 2, signedInAccounts: 1, truncated: false,
    });
  });
});
