import { convexTest } from "convex-test";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import { PRODUCT_CATALOG } from "../config/productCatalog";
import {
  PENDING_PAYMENT_BLOCK_WINDOW_MS,
  STUCK_PAYMENT_RECONCILIATION_THRESHOLD_MS,
  safeMarkReconcileAttempt,
} from "../payments/billing";
import { upsertEntitlements } from "../payments/subscriptionHelpers";
import { getFeaturesForPlan } from "../lib/entitlements";
import { signAnonClaimToken } from "../lib/identitySigning";

// Mock the Dodo REST SDK so the reconciliation action's `payments.retrieve`
// is controllable per-test (no real network). billing.ts only news up
// DodoPayments inside getDodoClient(), so a class stub is sufficient. No
// other test in this file exercises the real SDK.
const { dodoRetrieveMock } = vi.hoisted(() => ({ dodoRetrieveMock: vi.fn() }));
vi.mock("dodopayments", () => ({
  DodoPayments: class {
    payments = { retrieve: dodoRetrieveMock };
    customers = { customerPortal: { create: vi.fn() } };
  },
}));

const modules = import.meta.glob("../**/*.ts");

const TEST_USER_ID = "user_billing_test_001";
const NOW = Date.now();
const DAY_MS = 24 * 60 * 60 * 1000;
const SIGNING_SECRET = "test-dodo-identity-signing-secret";
const ANON_USER_ID = "11111111-1111-4111-8111-111111111111";
const CLAIMANT_A = { subject: "user_claimant_a", tokenIdentifier: "clerk|user_claimant_a" };
const CLAIMANT_B = { subject: "user_claimant_b", tokenIdentifier: "clerk|user_claimant_b" };
type PlanKey = keyof typeof PRODUCT_CATALOG;

afterEach(() => {
  vi.restoreAllMocks();
  dodoRetrieveMock.mockReset();
  vi.useRealTimers();
  delete process.env.DODO_IDENTITY_SIGNING_SECRET;
  delete process.env.DODO_ANON_CLAIM_TOKEN_TTL_MS;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.DODO_API_KEY;
  delete process.env.RESEND_API_KEY;
});

async function seedSubscription(
  t: ReturnType<typeof convexTest>,
  opts: {
    planKey: string;
    dodoProductId: string;
    status: "active" | "on_hold" | "cancelled" | "expired";
    currentPeriodEnd: number;
    suffix: string;
    rawPayload?: unknown;
    userId?: string;
    renewalVerificationState?: "pending" | "failed" | "lapsed";
  },
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("subscriptions", {
      userId: opts.userId ?? TEST_USER_ID,
      dodoSubscriptionId: `sub_billing_${opts.suffix}`,
      dodoProductId: opts.dodoProductId,
      planKey: opts.planKey,
      status: opts.status,
      currentPeriodStart: NOW - DAY_MS,
      currentPeriodEnd: opts.currentPeriodEnd,
      rawPayload: opts.rawPayload ?? {},
      updatedAt: NOW,
      ...(opts.renewalVerificationState
        ? { renewalVerificationState: opts.renewalVerificationState }
        : {}),
    });
  });
}

async function seedAnonClaimState(
  t: ReturnType<typeof convexTest>,
  opts: {
    anonId?: string;
    planKey?: PlanKey;
    validUntil?: number;
    compUntil?: number;
    existingRealEntitlement?: {
      userId: string;
      planKey: PlanKey;
      validUntil: number;
      compUntil?: number;
    };
    includeAnonEntitlement?: boolean;
  } = {},
) {
  const anonId = opts.anonId ?? ANON_USER_ID;
  const planKey = opts.planKey ?? "pro_monthly";
  const dodoProductId = PRODUCT_CATALOG[planKey].dodoProductId!;
  await t.run(async (ctx) => {
    await ctx.db.insert("subscriptions", {
      userId: anonId,
      dodoSubscriptionId: "sub_anon_claim_001",
      dodoProductId,
      planKey,
      status: "active",
      currentPeriodStart: NOW - DAY_MS,
      currentPeriodEnd: NOW + 30 * DAY_MS,
      rawPayload: { metadata: { wm_anon_claim: "v2" } },
      updatedAt: NOW,
    });
    if (opts.includeAnonEntitlement !== false) {
      await ctx.db.insert("entitlements", {
        userId: anonId,
        planKey,
        features: getFeaturesForPlan(planKey),
        validUntil: opts.validUntil ?? NOW + 30 * DAY_MS,
        ...(opts.compUntil !== undefined ? { compUntil: opts.compUntil } : {}),
        updatedAt: NOW,
      });
    }
    await ctx.db.insert("customers", {
      userId: anonId,
      dodoCustomerId: "cus_anon_claim_001",
      email: "anon@example.com",
      normalizedEmail: "anon@example.com",
      createdAt: NOW,
      updatedAt: NOW,
    });
    await ctx.db.insert("paymentEvents", {
      userId: anonId,
      dodoPaymentId: "pay_anon_claim_001",
      type: "charge",
      amount: 3999,
      currency: "USD",
      status: "succeeded",
      dodoSubscriptionId: "sub_anon_claim_001",
      planKey,
      rawPayload: { metadata: { wm_anon_claim: "v2" } },
      occurredAt: NOW,
    });

    if (opts.existingRealEntitlement) {
      await ctx.db.insert("entitlements", {
        userId: opts.existingRealEntitlement.userId,
        planKey: opts.existingRealEntitlement.planKey,
        features: getFeaturesForPlan(opts.existingRealEntitlement.planKey),
        validUntil: opts.existingRealEntitlement.validUntil,
        ...(opts.existingRealEntitlement.compUntil !== undefined
          ? { compUntil: opts.existingRealEntitlement.compUntil }
          : {}),
        updatedAt: NOW - DAY_MS,
      });
    }
  });
}

describe("claimSubscription anonymous ownership proof", () => {
  test("rejects a bare anon UUID when protected payment rows exist", async () => {
    process.env.DODO_IDENTITY_SIGNING_SECRET = SIGNING_SECRET;
    const t = convexTest(schema, modules);
    await seedAnonClaimState(t);

    await expect(
      t.withIdentity(CLAIMANT_B).mutation(api.payments.billing.claimSubscription, {
        anonId: ANON_USER_ID,
      }),
    ).rejects.toThrow(/ANON_CLAIM_PROOF_REQUIRED/);

    const rows = await t.run(async (ctx) => {
      const [sub, entitlement, customer, payment] = await Promise.all([
        ctx.db.query("subscriptions").withIndex("by_userId", (q) => q.eq("userId", ANON_USER_ID)).first(),
        ctx.db.query("entitlements").withIndex("by_userId", (q) => q.eq("userId", ANON_USER_ID)).first(),
        ctx.db.query("customers").withIndex("by_userId", (q) => q.eq("userId", ANON_USER_ID)).first(),
        ctx.db.query("paymentEvents").withIndex("by_userId", (q) => q.eq("userId", ANON_USER_ID)).first(),
      ]);
      return { sub, entitlement, customer, payment };
    });
    expect(rows.sub?.userId).toBe(ANON_USER_ID);
    expect(rows.entitlement?.userId).toBe(ANON_USER_ID);
    expect(rows.customer?.userId).toBe(ANON_USER_ID);
    expect(rows.payment?.userId).toBe(ANON_USER_ID);
  });

  test("rejects the wrong proof token and leaves rows on the anon owner", async () => {
    process.env.DODO_IDENTITY_SIGNING_SECRET = SIGNING_SECRET;
    const t = convexTest(schema, modules);
    await seedAnonClaimState(t);
    const wrongToken = await signAnonClaimToken("22222222-2222-4222-8222-222222222222");

    await expect(
      t.withIdentity(CLAIMANT_B).mutation(api.payments.billing.claimSubscription, {
        anonId: ANON_USER_ID,
        claimToken: wrongToken,
      }),
    ).rejects.toThrow(/ANON_CLAIM_PROOF_REQUIRED/);

    const realSub = await t.run(async (ctx) =>
      ctx.db.query("subscriptions").withIndex("by_userId", (q) => q.eq("userId", CLAIMANT_B.subject)).first(),
    );
    expect(realSub).toBeNull();
  });

  test("rejects an expired proof token and leaves rows on the anon owner", async () => {
    vi.useFakeTimers();
    process.env.DODO_IDENTITY_SIGNING_SECRET = SIGNING_SECRET;
    const t = convexTest(schema, modules);
    await seedAnonClaimState(t);
    vi.setSystemTime(NOW - 31 * DAY_MS);
    const expiredToken = await signAnonClaimToken(ANON_USER_ID);
    vi.setSystemTime(NOW);

    await expect(
      t.withIdentity(CLAIMANT_B).mutation(api.payments.billing.claimSubscription, {
        anonId: ANON_USER_ID,
        claimToken: expiredToken,
      }),
    ).rejects.toThrow(/ANON_CLAIM_PROOF_REQUIRED/);

    const realSub = await t.run(async (ctx) =>
      ctx.db.query("subscriptions").withIndex("by_userId", (q) => q.eq("userId", CLAIMANT_B.subject)).first(),
    );
    expect(realSub).toBeNull();
  });

  test("accepts a valid proof token and migrates all anonymous payment rows", async () => {
    process.env.DODO_IDENTITY_SIGNING_SECRET = SIGNING_SECRET;
    const t = convexTest(schema, modules);
    await seedAnonClaimState(t);
    const claimToken = await signAnonClaimToken(ANON_USER_ID);

    const result = await t.withIdentity(CLAIMANT_A).mutation(
      api.payments.billing.claimSubscription,
      { anonId: ANON_USER_ID, claimToken },
    );

    expect(result).toEqual({
      claimed: { subscriptions: 1, entitlements: 1, customers: 1, payments: 1 },
    });
    const rows = await t.run(async (ctx) => {
      const [sub, entitlement, customer, payment, oldSub] = await Promise.all([
        ctx.db.query("subscriptions").withIndex("by_userId", (q) => q.eq("userId", CLAIMANT_A.subject)).first(),
        ctx.db.query("entitlements").withIndex("by_userId", (q) => q.eq("userId", CLAIMANT_A.subject)).first(),
        ctx.db.query("customers").withIndex("by_userId", (q) => q.eq("userId", CLAIMANT_A.subject)).first(),
        ctx.db.query("paymentEvents").withIndex("by_userId", (q) => q.eq("userId", CLAIMANT_A.subject)).first(),
        ctx.db.query("subscriptions").withIndex("by_userId", (q) => q.eq("userId", ANON_USER_ID)).first(),
      ]);
      return { sub, entitlement, customer, payment, oldSub };
    });
    expect(rows.sub?.userId).toBe(CLAIMANT_A.subject);
    expect(rows.entitlement?.planKey).toBe("pro_monthly");
    expect(rows.customer?.userId).toBe(CLAIMANT_A.subject);
    expect(rows.payment?.userId).toBe(CLAIMANT_A.subject);
    expect(rows.oldSub).toBeNull();
  });

  test("keeps existing higher-tier entitlement precedence when proof is valid", async () => {
    process.env.DODO_IDENTITY_SIGNING_SECRET = SIGNING_SECRET;
    const t = convexTest(schema, modules);
    await seedAnonClaimState(t, {
      planKey: "pro_monthly",
      validUntil: NOW + 90 * DAY_MS,
      existingRealEntitlement: {
        userId: CLAIMANT_A.subject,
        planKey: "api_business",
        validUntil: NOW + 10 * DAY_MS,
      },
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("subscriptions", {
        userId: CLAIMANT_A.subject,
        dodoSubscriptionId: "sub_real_api_business",
        dodoProductId: PRODUCT_CATALOG.api_business.dodoProductId!,
        planKey: "api_business",
        status: "active",
        currentPeriodStart: NOW - DAY_MS,
        currentPeriodEnd: NOW + 10 * DAY_MS,
        rawPayload: {},
        updatedAt: NOW - DAY_MS,
      });
    });
    const claimToken = await signAnonClaimToken(ANON_USER_ID);

    await t.withIdentity(CLAIMANT_A).mutation(api.payments.billing.claimSubscription, {
      anonId: ANON_USER_ID,
      claimToken,
    });

    const entitlement = await t.run(async (ctx) =>
      ctx.db.query("entitlements").withIndex("by_userId", (q) => q.eq("userId", CLAIMANT_A.subject)).first(),
    );
    expect(entitlement?.planKey).toBe("api_business");
    expect(entitlement?.features.tier).toBe(getFeaturesForPlan("api_business").tier);
  });

  test("does not let a lower-tier anon comp floor suppress a higher real subscription on claim", async () => {
    process.env.DODO_IDENTITY_SIGNING_SECRET = SIGNING_SECRET;
    const t = convexTest(schema, modules);
    const anonCompUntil = NOW + 90 * DAY_MS;
    const realPaidUntil = NOW + 30 * DAY_MS;
    await seedAnonClaimState(t, {
      planKey: "api_starter",
      validUntil: anonCompUntil,
      compUntil: anonCompUntil,
      existingRealEntitlement: {
        userId: CLAIMANT_A.subject,
        planKey: "pro_monthly",
        validUntil: realPaidUntil,
      },
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("subscriptions", {
        userId: CLAIMANT_A.subject,
        dodoSubscriptionId: "sub_real_api_business",
        dodoProductId: PRODUCT_CATALOG.api_business.dodoProductId!,
        planKey: "api_business",
        status: "active",
        currentPeriodStart: NOW - DAY_MS,
        currentPeriodEnd: realPaidUntil,
        rawPayload: {},
        updatedAt: NOW - DAY_MS,
      });
    });
    const claimToken = await signAnonClaimToken(ANON_USER_ID);

    await t.withIdentity(CLAIMANT_A).mutation(api.payments.billing.claimSubscription, {
      anonId: ANON_USER_ID,
      claimToken,
    });

    const entitlement = await t.run(async (ctx) =>
      ctx.db.query("entitlements").withIndex("by_userId", (q) => q.eq("userId", CLAIMANT_A.subject)).first(),
    );
    expect(entitlement?.planKey).toBe("api_business");
    expect(entitlement?.features.tier).toBe(getFeaturesForPlan("api_business").tier);
    expect(entitlement?.validUntil).toBe(realPaidUntil);
    expect(entitlement?.compUntil).toBeUndefined();
  });

  test("schedules anon cache delete and real-user cache sync after a proven claim", async () => {
    vi.useFakeTimers();
    process.env.DODO_IDENTITY_SIGNING_SECRET = SIGNING_SECRET;
    process.env.UPSTASH_REDIS_REST_URL = "https://redis.example";
    process.env.UPSTASH_REDIS_REST_TOKEN = "redis-token";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("OK", { status: 200 }),
    );
    const t = convexTest(schema, modules);
    await seedAnonClaimState(t);
    const claimToken = await signAnonClaimToken(ANON_USER_ID);

    await t.withIdentity(CLAIMANT_A).mutation(api.payments.billing.claimSubscription, {
      anonId: ANON_USER_ID,
      claimToken,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls.some((url) => url.includes("/del/") && url.includes(encodeURIComponent(ANON_USER_ID)))).toBe(true);
    expect(urls.some((url) => url.includes("/set/") && url.includes(encodeURIComponent(CLAIMANT_A.subject)))).toBe(true);
  });

  test("recomputes and syncs real entitlement when the anon entitlement row is missing", async () => {
    vi.useFakeTimers();
    process.env.DODO_IDENTITY_SIGNING_SECRET = SIGNING_SECRET;
    process.env.UPSTASH_REDIS_REST_URL = "https://redis.example";
    process.env.UPSTASH_REDIS_REST_TOKEN = "redis-token";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("OK", { status: 200 }),
    );
    const t = convexTest(schema, modules);
    await seedAnonClaimState(t, {
      planKey: "api_starter",
      includeAnonEntitlement: false,
    });
    const claimToken = await signAnonClaimToken(ANON_USER_ID);

    const result = await t.withIdentity(CLAIMANT_A).mutation(api.payments.billing.claimSubscription, {
      anonId: ANON_USER_ID,
      claimToken,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(result).toEqual({
      claimed: { subscriptions: 1, entitlements: 0, customers: 1, payments: 1 },
    });
    const rows = await t.run(async (ctx) => {
      const [sub, entitlement, oldEntitlement] = await Promise.all([
        ctx.db.query("subscriptions").withIndex("by_userId", (q) => q.eq("userId", CLAIMANT_A.subject)).first(),
        ctx.db.query("entitlements").withIndex("by_userId", (q) => q.eq("userId", CLAIMANT_A.subject)).first(),
        ctx.db.query("entitlements").withIndex("by_userId", (q) => q.eq("userId", ANON_USER_ID)).first(),
      ]);
      return { sub, entitlement, oldEntitlement };
    });
    expect(rows.sub?.userId).toBe(CLAIMANT_A.subject);
    expect(rows.entitlement?.planKey).toBe("api_starter");
    expect(rows.entitlement?.features.tier).toBe(getFeaturesForPlan("api_starter").tier);
    expect(rows.oldEntitlement).toBeNull();

    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls.some((url) => url.includes("/del/") && url.includes(encodeURIComponent(ANON_USER_ID)))).toBe(true);
    const realUserSetUrl = urls.find((url) =>
      url.includes("/set/") && url.includes(encodeURIComponent(CLAIMANT_A.subject)),
    );
    if (!realUserSetUrl) throw new Error("missing real-user Redis SET");
    const setPathParts = new URL(realUserSetUrl).pathname.split("/");
    const cachedEntitlement = JSON.parse(decodeURIComponent(setPathParts[3] ?? "{}"));
    expect(cachedEntitlement.planKey).toBe("api_starter");
    expect(cachedEntitlement.validUntil).toBe(NOW + 30 * DAY_MS);
    expect(cachedEntitlement.features.tier).toBe(getFeaturesForPlan("api_starter").tier);
  });

  test("returns a quiet zero claim for bare UUIDs with no payment rows", async () => {
    process.env.DODO_IDENTITY_SIGNING_SECRET = SIGNING_SECRET;
    const t = convexTest(schema, modules);

    await expect(
      t.withIdentity(CLAIMANT_B).mutation(api.payments.billing.claimSubscription, {
        anonId: ANON_USER_ID,
      }),
    ).resolves.toEqual({
      claimed: { subscriptions: 0, entitlements: 0, customers: 0, payments: 0 },
    });
  });

  test("rejects an invalid proof token even when there are no payment rows", async () => {
    process.env.DODO_IDENTITY_SIGNING_SECRET = SIGNING_SECRET;
    const t = convexTest(schema, modules);
    const wrongToken = await signAnonClaimToken("22222222-2222-4222-8222-222222222222");

    await expect(
      t.withIdentity(CLAIMANT_B).mutation(api.payments.billing.claimSubscription, {
        anonId: ANON_USER_ID,
        claimToken: wrongToken,
      }),
    ).rejects.toThrow(/ANON_CLAIM_PROOF_REQUIRED/);
  });
});

describe("payments billing duplicate-checkout guard", () => {
  test("does not block checkout when the user has no subscriptions", async () => {
    const t = convexTest(schema, modules);

    const result = await t.query(
      internal.payments.billing.getCheckoutBlockingSubscription,
      {
        userId: TEST_USER_ID,
        productId: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
      },
    );

    expect(result).toBeNull();
  });

  test("blocks checkout when an active subscription exists in the same tier group", async () => {
    const t = convexTest(schema, modules);

    await seedSubscription(t, {
      planKey: "pro_annual",
      dodoProductId: PRODUCT_CATALOG.pro_annual.dodoProductId!,
      status: "active",
      currentPeriodEnd: NOW + 30 * DAY_MS,
      suffix: "active_same_group",
    });

    const result = await t.query(
      internal.payments.billing.getCheckoutBlockingSubscription,
      {
        userId: TEST_USER_ID,
        productId: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
      },
    );

    expect(result).toMatchObject({
      planKey: "pro_annual",
      status: "active",
      displayName: "Pro Annual",
    });
  });

  test("blocks checkout when an on_hold subscription exists in the same tier group", async () => {
    const t = convexTest(schema, modules);

    await seedSubscription(t, {
      planKey: "pro_monthly",
      dodoProductId: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
      status: "on_hold",
      currentPeriodEnd: NOW + 7 * DAY_MS,
      suffix: "on_hold_same_group",
    });

    const result = await t.query(
      internal.payments.billing.getCheckoutBlockingSubscription,
      {
        userId: TEST_USER_ID,
        productId: PRODUCT_CATALOG.pro_annual.dodoProductId!,
      },
    );

    expect(result).toMatchObject({
      planKey: "pro_monthly",
      status: "on_hold",
    });
  });

  test("blocks checkout when a cancelled subscription still has time remaining", async () => {
    const t = convexTest(schema, modules);

    await seedSubscription(t, {
      planKey: "api_starter",
      dodoProductId: PRODUCT_CATALOG.api_starter.dodoProductId!,
      status: "cancelled",
      currentPeriodEnd: NOW + 14 * DAY_MS,
      suffix: "cancelled_future",
    });

    const result = await t.query(
      internal.payments.billing.getCheckoutBlockingSubscription,
      {
        userId: TEST_USER_ID,
        productId: PRODUCT_CATALOG.api_starter_annual.dodoProductId!,
      },
    );

    expect(result).toMatchObject({
      planKey: "api_starter",
      status: "cancelled",
    });
  });

  test("does not block checkout when a cancelled subscription has already expired", async () => {
    const t = convexTest(schema, modules);

    await seedSubscription(t, {
      planKey: "pro_monthly",
      dodoProductId: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
      status: "cancelled",
      currentPeriodEnd: NOW - DAY_MS,
      suffix: "cancelled_past",
    });

    const result = await t.query(
      internal.payments.billing.getCheckoutBlockingSubscription,
      {
        userId: TEST_USER_ID,
        productId: PRODUCT_CATALOG.pro_annual.dodoProductId!,
      },
    );

    expect(result).toBeNull();
  });

  test("does not block checkout for a different tier group", async () => {
    const t = convexTest(schema, modules);

    await seedSubscription(t, {
      planKey: "api_starter",
      dodoProductId: PRODUCT_CATALOG.api_starter.dodoProductId!,
      status: "active",
      currentPeriodEnd: NOW + 30 * DAY_MS,
      suffix: "active_different_group",
    });

    const result = await t.query(
      internal.payments.billing.getCheckoutBlockingSubscription,
      {
        userId: TEST_USER_ID,
        productId: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
      },
    );

    expect(result).toBeNull();
  });

  // #4946: api_starter and api_business are distinct tier groups but ONE
  // billing family — an active Starter buying Business from /pro must hit
  // the duplicate dialog (→ portal, where the #4634 collection upgrade
  // lives), not stack a second concurrent API subscription.
  test("blocks a Business checkout while an API Starter subscription is active", async () => {
    const t = convexTest(schema, modules);

    await seedSubscription(t, {
      planKey: "api_starter",
      dodoProductId: PRODUCT_CATALOG.api_starter.dodoProductId!,
      status: "active",
      currentPeriodEnd: NOW + 30 * DAY_MS,
      suffix: "starter_blocks_business",
    });

    const result = await t.query(
      internal.payments.billing.getCheckoutBlockingSubscription,
      {
        userId: TEST_USER_ID,
        productId: PRODUCT_CATALOG.api_business.dodoProductId!,
      },
    );

    expect(result).toMatchObject({
      planKey: "api_starter",
      status: "active",
      displayName: "API Starter Monthly",
    });
  });

  test("blocks a Starter checkout while an API Business subscription is active", async () => {
    const t = convexTest(schema, modules);

    await seedSubscription(t, {
      planKey: "api_business",
      dodoProductId: PRODUCT_CATALOG.api_business.dodoProductId!,
      status: "active",
      currentPeriodEnd: NOW + 30 * DAY_MS,
      suffix: "business_blocks_starter",
    });

    const result = await t.query(
      internal.payments.billing.getCheckoutBlockingSubscription,
      {
        userId: TEST_USER_ID,
        productId: PRODUCT_CATALOG.api_starter.dodoProductId!,
      },
    );

    expect(result).toMatchObject({
      planKey: "api_business",
      status: "active",
    });
  });

  test("an active Pro subscription does not block an API Business checkout", async () => {
    const t = convexTest(schema, modules);

    await seedSubscription(t, {
      planKey: "pro_monthly",
      dodoProductId: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
      status: "active",
      currentPeriodEnd: NOW + 30 * DAY_MS,
      suffix: "pro_not_blocking_business",
    });

    const result = await t.query(
      internal.payments.billing.getCheckoutBlockingSubscription,
      {
        userId: TEST_USER_ID,
        productId: PRODUCT_CATALOG.api_business.dodoProductId!,
      },
    );

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// #4438 — pending-payment dedup guard. The original incident let a customer
// stack 4–5 payments all in "Requires customer action" because the subscription
// guard above is blind to pending 3DS payments (no subscription row exists yet).
// This guard blocks a NEW checkout when a recent pending payment exists in the
// SAME tier group, fails open when a pending row's tier group is unresolvable,
// and never blocks across tier groups (a pending Pro payment must not block an
// API checkout — the reviewer's case).
// ---------------------------------------------------------------------------

const MIN_MS = 60 * 1000;

async function seedPaymentEvent(
  t: ReturnType<typeof convexTest>,
  opts: {
    status:
      | "processing"
      | "requires_customer_action"
      | "succeeded"
      | "failed"
      | "cancelled";
    planKey?: string;
    occurredAt: number;
    suffix: string;
    type?: "charge" | "refund";
    userId?: string;
    // Override to model the append-only history of ONE payment (same Dodo
    // payment id transitioning processing -> succeeded/failed across rows).
    dodoPaymentId?: string;
  },
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("paymentEvents", {
      userId: opts.userId ?? TEST_USER_ID,
      dodoPaymentId: opts.dodoPaymentId ?? `pay_billing_${opts.suffix}`,
      type: opts.type ?? "charge",
      amount: 3999,
      currency: "USD",
      status: opts.status,
      planKey: opts.planKey,
      rawPayload: {},
      occurredAt: opts.occurredAt,
    });
  });
}

describe("payments pending-payment dedup guard", () => {
  test("does not block when the user has no pending payments", async () => {
    const t = convexTest(schema, modules);

    const result = await t.query(
      internal.payments.billing.getBlockingPendingPayment,
      {
        userId: TEST_USER_ID,
        productId: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
      },
    );

    expect(result).toBeNull();
  });

  test("blocks a Pro checkout when a recent pending Pro payment exists", async () => {
    const t = convexTest(schema, modules);

    await seedPaymentEvent(t, {
      status: "requires_customer_action",
      planKey: "pro_monthly",
      occurredAt: NOW - 5 * MIN_MS,
      suffix: "pending_pro",
    });

    const result = await t.query(
      internal.payments.billing.getBlockingPendingPayment,
      {
        userId: TEST_USER_ID,
        productId: PRODUCT_CATALOG.pro_annual.dodoProductId!,
      },
    );

    expect(result).toMatchObject({
      planKey: "pro_monthly",
      displayName: "Pro Monthly",
    });
  });

  test("does NOT block an API checkout when the pending payment is Pro (different tier group)", async () => {
    const t = convexTest(schema, modules);

    await seedPaymentEvent(t, {
      status: "processing",
      planKey: "pro_monthly",
      occurredAt: NOW - 5 * MIN_MS,
      suffix: "pending_pro_vs_api",
    });

    const result = await t.query(
      internal.payments.billing.getBlockingPendingPayment,
      {
        userId: TEST_USER_ID,
        productId: PRODUCT_CATALOG.api_starter.dodoProductId!,
      },
    );

    expect(result).toBeNull();
  });

  test("does not block when the pending payment is older than the staleness window", async () => {
    const t = convexTest(schema, modules);

    await seedPaymentEvent(t, {
      status: "requires_customer_action",
      planKey: "pro_monthly",
      // Anchored to the real window so a retune of PENDING_PAYMENT_BLOCK_WINDOW_MS
      // can't silently flip this "stale" case to within-window and pass falsely.
      occurredAt: NOW - (PENDING_PAYMENT_BLOCK_WINDOW_MS + 5 * MIN_MS),
      suffix: "pending_stale",
    });

    const result = await t.query(
      internal.payments.billing.getBlockingPendingPayment,
      {
        userId: TEST_USER_ID,
        productId: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
      },
    );

    expect(result).toBeNull();
  });

  test("does not block on a terminal (succeeded) payment row", async () => {
    const t = convexTest(schema, modules);

    await seedPaymentEvent(t, {
      status: "succeeded",
      planKey: "pro_monthly",
      occurredAt: NOW - 2 * MIN_MS,
      suffix: "succeeded_recent",
    });

    const result = await t.query(
      internal.payments.billing.getBlockingPendingPayment,
      {
        userId: TEST_USER_ID,
        productId: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
      },
    );

    expect(result).toBeNull();
  });

  test("fails open: a pending row with no planKey never blocks", async () => {
    const t = convexTest(schema, modules);

    await seedPaymentEvent(t, {
      status: "requires_customer_action",
      planKey: undefined,
      occurredAt: NOW - 2 * MIN_MS,
      suffix: "pending_no_plankey",
    });

    const result = await t.query(
      internal.payments.billing.getBlockingPendingPayment,
      {
        userId: TEST_USER_ID,
        productId: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
      },
    );

    expect(result).toBeNull();
  });

  test("monthly/annual parity: a pending api_starter payment blocks an api_starter_annual checkout", async () => {
    const t = convexTest(schema, modules);

    await seedPaymentEvent(t, {
      status: "processing",
      planKey: "api_starter",
      occurredAt: NOW - 3 * MIN_MS,
      suffix: "pending_api_parity",
    });

    const result = await t.query(
      internal.payments.billing.getBlockingPendingPayment,
      {
        userId: TEST_USER_ID,
        productId: PRODUCT_CATALOG.api_starter_annual.dodoProductId!,
      },
    );

    expect(result).toMatchObject({ planKey: "api_starter" });
  });

  // Policy inverted by #4946 (api_business published): api_starter and
  // api_business are distinct tier groups but ONE billing family — a
  // pending Starter payment now BLOCKS a Business checkout so a user
  // mid-3DS on Starter can't stack a second concurrent API purchase.
  // Cross-line (pro vs api) stays non-blocking, covered below.
  test("blocks an api_business checkout while an api_starter payment is pending (same billing family)", async () => {
    const t = convexTest(schema, modules);

    await seedPaymentEvent(t, {
      status: "processing",
      planKey: "api_starter",
      occurredAt: NOW - 3 * MIN_MS,
      suffix: "pending_api_starter_vs_business",
    });

    const result = await t.query(
      internal.payments.billing.getBlockingPendingPayment,
      {
        userId: TEST_USER_ID,
        productId: PRODUCT_CATALOG.api_business.dodoProductId!,
      },
    );

    expect(result).toMatchObject({ planKey: "api_starter" });
  });

  test("does NOT block an api_business checkout when the pending payment is pro (different billing family)", async () => {
    const t = convexTest(schema, modules);

    await seedPaymentEvent(t, {
      status: "processing",
      planKey: "pro_monthly",
      occurredAt: NOW - 3 * MIN_MS,
      suffix: "pending_pro_vs_business",
    });

    const result = await t.query(
      internal.payments.billing.getBlockingPendingPayment,
      {
        userId: TEST_USER_ID,
        productId: PRODUCT_CATALOG.api_business.dodoProductId!,
      },
    );

    expect(result).toBeNull();
  });

  test("fails open: a pending row whose planKey is absent from PRODUCT_CATALOG never blocks", async () => {
    const t = convexTest(schema, modules);

    await seedPaymentEvent(t, {
      status: "requires_customer_action",
      planKey: "legacy_plan_no_longer_in_catalog",
      occurredAt: NOW - 2 * MIN_MS,
      suffix: "pending_unknown_plankey",
    });

    const result = await t.query(
      internal.payments.billing.getBlockingPendingPayment,
      {
        userId: TEST_USER_ID,
        productId: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
      },
    );

    expect(result).toBeNull();
  });

  // paymentEvents is append-only: a 3DS payment that goes processing -> failed
  // (or -> succeeded) leaves BOTH rows. The guard must not block on the lingering
  // pending row once the SAME dodoPaymentId reached a terminal state — otherwise
  // the failure-retry path this feature exists to smooth gets falsely blocked.
  test("does not block when the same payment later FAILED (append-only terminal row)", async () => {
    const t = convexTest(schema, modules);

    await seedPaymentEvent(t, {
      status: "requires_customer_action",
      planKey: "pro_monthly",
      occurredAt: NOW - 5 * MIN_MS,
      suffix: "appendonly_pending",
      dodoPaymentId: "pay_appendonly_001",
    });
    await seedPaymentEvent(t, {
      status: "failed",
      planKey: "pro_monthly",
      occurredAt: NOW - 4 * MIN_MS,
      suffix: "appendonly_failed",
      dodoPaymentId: "pay_appendonly_001",
    });

    const result = await t.query(
      internal.payments.billing.getBlockingPendingPayment,
      {
        userId: TEST_USER_ID,
        productId: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
      },
    );

    expect(result).toBeNull();
  });

  test("does not block when the same payment later SUCCEEDED (append-only terminal row)", async () => {
    const t = convexTest(schema, modules);

    await seedPaymentEvent(t, {
      status: "processing",
      planKey: "pro_monthly",
      occurredAt: NOW - 5 * MIN_MS,
      suffix: "appendonly_pending2",
      dodoPaymentId: "pay_appendonly_002",
    });
    await seedPaymentEvent(t, {
      status: "succeeded",
      planKey: "pro_monthly",
      occurredAt: NOW - 3 * MIN_MS,
      suffix: "appendonly_succeeded",
      dodoPaymentId: "pay_appendonly_002",
    });

    const result = await t.query(
      internal.payments.billing.getBlockingPendingPayment,
      {
        userId: TEST_USER_ID,
        productId: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
      },
    );

    expect(result).toBeNull();
  });

  // A genuinely-pending payment (no terminal row for its dodoPaymentId) must
  // still block, even when an UNRELATED payment has a terminal row.
  test("still blocks a genuinely-pending payment alongside an unrelated terminal payment", async () => {
    const t = convexTest(schema, modules);

    await seedPaymentEvent(t, {
      status: "failed",
      planKey: "pro_monthly",
      occurredAt: NOW - 6 * MIN_MS,
      suffix: "unrelated_failed",
      dodoPaymentId: "pay_unrelated_terminal",
    });
    await seedPaymentEvent(t, {
      status: "requires_customer_action",
      planKey: "pro_monthly",
      occurredAt: NOW - 2 * MIN_MS,
      suffix: "genuinely_pending",
      dodoPaymentId: "pay_genuinely_pending",
    });

    const result = await t.query(
      internal.payments.billing.getBlockingPendingPayment,
      {
        userId: TEST_USER_ID,
        productId: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
      },
    );

    expect(result).toMatchObject({ planKey: "pro_monthly" });
  });

  test("returns the most recent matching pending payment", async () => {
    const t = convexTest(schema, modules);

    await seedPaymentEvent(t, {
      status: "processing",
      planKey: "pro_monthly",
      occurredAt: NOW - 10 * MIN_MS,
      suffix: "pending_older",
    });
    await seedPaymentEvent(t, {
      status: "requires_customer_action",
      planKey: "pro_annual",
      occurredAt: NOW - 1 * MIN_MS,
      suffix: "pending_newer",
    });

    const result = await t.query(
      internal.payments.billing.getBlockingPendingPayment,
      {
        userId: TEST_USER_ID,
        productId: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
      },
    );

    expect(result).toMatchObject({ planKey: "pro_annual" });
  });
});

describe("payments stuck-pending reconciliation", () => {
  test("finds stale unresolved pending payments but skips recent, terminal, and already-marked rows", async () => {
    vi.setSystemTime(NOW);
    const t = convexTest(schema, modules);

    await seedPaymentEvent(t, {
      status: "requires_customer_action",
      planKey: "pro_monthly",
      occurredAt: NOW - STUCK_PAYMENT_RECONCILIATION_THRESHOLD_MS - MIN_MS,
      suffix: "stale_candidate",
      dodoPaymentId: "pay_reconcile_candidate",
    });
    await seedPaymentEvent(t, {
      status: "processing",
      planKey: "pro_monthly",
      occurredAt: NOW - 5 * MIN_MS,
      suffix: "recent_pending",
      dodoPaymentId: "pay_reconcile_recent",
    });
    await seedPaymentEvent(t, {
      status: "requires_customer_action",
      planKey: "pro_monthly",
      occurredAt: NOW - STUCK_PAYMENT_RECONCILIATION_THRESHOLD_MS - 2 * MIN_MS,
      suffix: "terminal_pending",
      dodoPaymentId: "pay_reconcile_terminal",
    });
    await seedPaymentEvent(t, {
      status: "failed",
      planKey: "pro_monthly",
      occurredAt: NOW - STUCK_PAYMENT_RECONCILIATION_THRESHOLD_MS - MIN_MS,
      suffix: "terminal_failed",
      dodoPaymentId: "pay_reconcile_terminal",
    });
    await seedPaymentEvent(t, {
      status: "requires_customer_action",
      planKey: "pro_monthly",
      occurredAt: NOW - STUCK_PAYMENT_RECONCILIATION_THRESHOLD_MS - 3 * MIN_MS,
      suffix: "marked_pending",
      dodoPaymentId: "pay_reconcile_marked",
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("paymentReconciliationAttempts", {
        dodoPaymentId: "pay_reconcile_marked",
        userId: TEST_USER_ID,
        planKey: "pro_monthly",
        action: "ops_notified",
        observedStatus: "requires_customer_action",
        pendingOccurredAt: NOW - STUCK_PAYMENT_RECONCILIATION_THRESHOLD_MS - 3 * MIN_MS,
        reconciledAt: NOW - MIN_MS,
      });
    });

    const candidates = await t.query(
      internal.payments.billing.listStuckPendingPaymentCandidates,
      { thresholdMs: STUCK_PAYMENT_RECONCILIATION_THRESHOLD_MS, batchSize: 10 },
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      dodoPaymentId: "pay_reconcile_candidate",
      planKey: "pro_monthly",
      pendingStatus: "requires_customer_action",
    });
  });

  test("candidate selection is bounded by batch size", async () => {
    vi.setSystemTime(NOW);
    const t = convexTest(schema, modules);

    for (let i = 0; i < 3; i++) {
      await seedPaymentEvent(t, {
        status: "processing",
        planKey: "pro_monthly",
        occurredAt: NOW - STUCK_PAYMENT_RECONCILIATION_THRESHOLD_MS - (i + 1) * MIN_MS,
        suffix: `batch_${i}`,
        dodoPaymentId: `pay_reconcile_batch_${i}`,
      });
    }

    const candidates = await t.query(
      internal.payments.billing.listStuckPendingPaymentCandidates,
      { thresholdMs: STUCK_PAYMENT_RECONCILIATION_THRESHOLD_MS, batchSize: 2 },
    );

    expect(candidates).toHaveLength(2);
  });

  test("scans newest-first so freshly-stuck rows win a limited batch (F5)", async () => {
    vi.setSystemTime(NOW);
    const t = convexTest(schema, modules);

    // Three stale pending payments, increasing age (i=0 newest, i=2 oldest).
    for (let i = 0; i < 3; i++) {
      await seedPaymentEvent(t, {
        status: "requires_customer_action",
        planKey: "pro_monthly",
        occurredAt: NOW - STUCK_PAYMENT_RECONCILIATION_THRESHOLD_MS - (i + 1) * MIN_MS,
        suffix: `scan_order_${i}`,
        dodoPaymentId: `pay_scan_order_${i}`,
      });
    }

    const candidates = await t.query(
      internal.payments.billing.listStuckPendingPaymentCandidates,
      { thresholdMs: STUCK_PAYMENT_RECONCILIATION_THRESHOLD_MS, batchSize: 2 },
    );

    // Descending scan yields the NEWEST two (0, 1), not the oldest two — the
    // regression fix so newly-stuck rows don't fall off the end of the window.
    expect(candidates.map((c) => c.dodoPaymentId)).toEqual([
      "pay_scan_order_0",
      "pay_scan_order_1",
    ]);
  });

  test("claims a dropped-webhook terminal payment once, backfilling the terminal row", async () => {
    vi.setSystemTime(NOW);
    const t = convexTest(schema, modules);

    await seedPaymentEvent(t, {
      status: "requires_customer_action",
      planKey: "pro_monthly",
      occurredAt: NOW - STUCK_PAYMENT_RECONCILIATION_THRESHOLD_MS - MIN_MS,
      suffix: "terminal_record",
      dodoPaymentId: "pay_reconcile_terminal_record",
    });

    const payload = {
      userId: TEST_USER_ID,
      dodoPaymentId: "pay_reconcile_terminal_record",
      dodoSubscriptionId: "sub_reconcile_terminal_record",
      planKey: "pro_monthly",
      amount: 3999,
      currency: "USD",
      pendingOccurredAt: NOW - STUCK_PAYMENT_RECONCILIATION_THRESHOLD_MS - MIN_MS,
      observedStatus: "succeeded",
      rawPayload: { status: "succeeded", payment_id: "pay_reconcile_terminal_record" },
    };
    const first = await t.mutation(
      internal.payments.billing.claimStuckPaymentReconciliation,
      payload,
    );
    const second = await t.mutation(
      internal.payments.billing.claimStuckPaymentReconciliation,
      payload,
    );

    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("paymentEvents")
        .withIndex("by_dodoPaymentId", (q) => q.eq("dodoPaymentId", "pay_reconcile_terminal_record"))
        .collect(),
    );
    const markers = await t.run(async (ctx) =>
      ctx.db
        .query("paymentReconciliationAttempts")
        .withIndex("by_dodoPaymentId", (q) => q.eq("dodoPaymentId", "pay_reconcile_terminal_record"))
        .collect(),
    );

    expect(first).toEqual({ action: "terminal_reconciled" });
    expect(second).toEqual({ action: "already_marked" });
    expect(rows.map((row) => row.status).sort()).toEqual(["requires_customer_action", "succeeded"]);
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ action: "terminal_reconciled", observedStatus: "succeeded" });
  });

  test("terminal SUCCEEDED with no subscription row pages ops (dropped subscription.active guard)", async () => {
    vi.setSystemTime(NOW);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const t = convexTest(schema, modules);

    await seedPaymentEvent(t, {
      status: "requires_customer_action",
      planKey: "pro_monthly",
      occurredAt: NOW - STUCK_PAYMENT_RECONCILIATION_THRESHOLD_MS - MIN_MS,
      suffix: "succeeded_nosub",
      dodoPaymentId: "pay_succeeded_nosub",
    });

    const result = await t.mutation(internal.payments.billing.claimStuckPaymentReconciliation, {
      userId: TEST_USER_ID,
      dodoPaymentId: "pay_succeeded_nosub",
      dodoSubscriptionId: "sub_never_activated",
      planKey: "pro_monthly",
      amount: 3999,
      currency: "USD",
      pendingOccurredAt: NOW - STUCK_PAYMENT_RECONCILIATION_THRESHOLD_MS - MIN_MS,
      observedStatus: "succeeded",
      rawPayload: {},
    });

    // Case is still closed (marker written) but ops is paged via console.error.
    expect(result).toEqual({ action: "terminal_reconciled" });
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("no subscription row"),
    );
  });

  test("terminal SUCCEEDED with a matching subscription row does NOT page ops", async () => {
    vi.setSystemTime(NOW);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const t = convexTest(schema, modules);

    await seedPaymentEvent(t, {
      status: "requires_customer_action",
      planKey: "pro_monthly",
      occurredAt: NOW - STUCK_PAYMENT_RECONCILIATION_THRESHOLD_MS - MIN_MS,
      suffix: "succeeded_withsub",
      dodoPaymentId: "pay_succeeded_withsub",
    });
    await seedSubscription(t, {
      planKey: "pro_monthly",
      dodoProductId: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
      status: "active",
      currentPeriodEnd: NOW + 30 * DAY_MS,
      suffix: "reconcile_covered",
    });
    // seedSubscription names the row sub_billing_<suffix>; point the payment at it.
    const result = await t.mutation(internal.payments.billing.claimStuckPaymentReconciliation, {
      userId: TEST_USER_ID,
      dodoPaymentId: "pay_succeeded_withsub",
      dodoSubscriptionId: "sub_billing_reconcile_covered",
      planKey: "pro_monthly",
      amount: 3999,
      currency: "USD",
      pendingOccurredAt: NOW - STUCK_PAYMENT_RECONCILIATION_THRESHOLD_MS - MIN_MS,
      observedStatus: "succeeded",
      rawPayload: {},
    });

    expect(result).toEqual({ action: "terminal_reconciled" });
    expect(errorSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("no subscription row"),
    );
  });

  test("claim returns already_terminal (no marker) when a terminal row already exists (race)", async () => {
    // A webhook delivered the terminal charge between candidate listing and the
    // claim. The claim must NOT insert a duplicate terminal row or a marker.
    vi.setSystemTime(NOW);
    const t = convexTest(schema, modules);

    await seedPaymentEvent(t, {
      status: "requires_customer_action",
      planKey: "pro_monthly",
      occurredAt: NOW - STUCK_PAYMENT_RECONCILIATION_THRESHOLD_MS - MIN_MS,
      suffix: "race_pending",
      dodoPaymentId: "pay_reconcile_race",
    });
    await seedPaymentEvent(t, {
      status: "succeeded",
      planKey: "pro_monthly",
      occurredAt: NOW - STUCK_PAYMENT_RECONCILIATION_THRESHOLD_MS + MIN_MS,
      suffix: "race_terminal",
      dodoPaymentId: "pay_reconcile_race",
    });

    const result = await t.mutation(internal.payments.billing.claimStuckPaymentReconciliation, {
      userId: TEST_USER_ID,
      dodoPaymentId: "pay_reconcile_race",
      planKey: "pro_monthly",
      amount: 3999,
      currency: "USD",
      pendingOccurredAt: NOW - STUCK_PAYMENT_RECONCILIATION_THRESHOLD_MS - MIN_MS,
      observedStatus: "requires_customer_action",
      rawPayload: {},
    });

    expect(result).toEqual({ action: "already_terminal" });
    const markers = await t.run(async (ctx) =>
      ctx.db
        .query("paymentReconciliationAttempts")
        .withIndex("by_dodoPaymentId", (q) => q.eq("dodoPaymentId", "pay_reconcile_race"))
        .collect(),
    );
    expect(markers).toHaveLength(0);
  });

  test("claim writes a provisional ops marker for a recognised pending status", async () => {
    vi.setSystemTime(NOW);
    const t = convexTest(schema, modules);

    await seedPaymentEvent(t, {
      status: "processing",
      planKey: "pro_monthly",
      occurredAt: NOW - STUCK_PAYMENT_RECONCILIATION_THRESHOLD_MS - MIN_MS,
      suffix: "ops_marker",
      dodoPaymentId: "pay_reconcile_ops_marker",
    });

    const payload = {
      userId: TEST_USER_ID,
      dodoPaymentId: "pay_reconcile_ops_marker",
      planKey: "pro_monthly",
      amount: 3999,
      currency: "USD",
      pendingOccurredAt: NOW - STUCK_PAYMENT_RECONCILIATION_THRESHOLD_MS - MIN_MS,
      observedStatus: "requires_customer_action",
      rawPayload: { status: "requires_customer_action", payment_id: "pay_reconcile_ops_marker" },
    };
    const first = await t.mutation(internal.payments.billing.claimStuckPaymentReconciliation, payload);
    const second = await t.mutation(internal.payments.billing.claimStuckPaymentReconciliation, payload);

    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("paymentEvents")
        .withIndex("by_dodoPaymentId", (q) => q.eq("dodoPaymentId", "pay_reconcile_ops_marker"))
        .collect(),
    );
    const markers = await t.run(async (ctx) =>
      ctx.db
        .query("paymentReconciliationAttempts")
        .withIndex("by_dodoPaymentId", (q) => q.eq("dodoPaymentId", "pay_reconcile_ops_marker"))
        .collect(),
    );

    expect(first).toEqual({ action: "pending_claimed" });
    expect(second).toEqual({ action: "already_marked" });
    expect(rows).toHaveLength(1); // no synthetic paymentEvents row for a non-terminal status
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({
      action: "ops_notified",
      observedStatus: "requires_customer_action",
    });
  });

  test("claim writes a marker recording the RAW status for an UNRECOGNISED non-terminal status (F1)", async () => {
    // `requires_payment_method` is the typical abandoned-3DS end-state. The old
    // fall-through returned `unknown_status` with NO marker, so the cron
    // re-polled it daily for 14 days and starved batch slots. It must now be
    // claimed with the raw status preserved.
    vi.setSystemTime(NOW);
    const t = convexTest(schema, modules);

    await seedPaymentEvent(t, {
      status: "processing",
      planKey: "pro_monthly",
      occurredAt: NOW - STUCK_PAYMENT_RECONCILIATION_THRESHOLD_MS - MIN_MS,
      suffix: "unknown_status",
      dodoPaymentId: "pay_reconcile_unknown",
    });

    const result = await t.mutation(internal.payments.billing.claimStuckPaymentReconciliation, {
      userId: TEST_USER_ID,
      dodoPaymentId: "pay_reconcile_unknown",
      planKey: "pro_monthly",
      amount: 3999,
      currency: "USD",
      pendingOccurredAt: NOW - STUCK_PAYMENT_RECONCILIATION_THRESHOLD_MS - MIN_MS,
      observedStatus: "requires_payment_method",
      rawPayload: { status: "requires_payment_method", payment_id: "pay_reconcile_unknown" },
    });

    expect(result).toEqual({ action: "pending_claimed" });
    const markers = await t.run(async (ctx) =>
      ctx.db
        .query("paymentReconciliationAttempts")
        .withIndex("by_dodoPaymentId", (q) => q.eq("dodoPaymentId", "pay_reconcile_unknown"))
        .collect(),
    );
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({
      action: "ops_notified",
      observedStatus: "requires_payment_method",
    });
  });

  test("finalize(notified) upgrades a claimed marker to customer_notified, and never downgrades", async () => {
    vi.setSystemTime(NOW);
    const t = convexTest(schema, modules);

    await seedPaymentEvent(t, {
      status: "requires_customer_action",
      planKey: "pro_monthly",
      occurredAt: NOW - STUCK_PAYMENT_RECONCILIATION_THRESHOLD_MS - MIN_MS,
      suffix: "finalize_customer",
      dodoPaymentId: "pay_reconcile_finalize_customer",
    });
    await t.mutation(internal.payments.billing.claimStuckPaymentReconciliation, {
      userId: TEST_USER_ID,
      dodoPaymentId: "pay_reconcile_finalize_customer",
      planKey: "pro_monthly",
      amount: 3999,
      currency: "USD",
      pendingOccurredAt: NOW - STUCK_PAYMENT_RECONCILIATION_THRESHOLD_MS - MIN_MS,
      observedStatus: "requires_customer_action",
      rawPayload: {},
    });

    const upgrade = await t.mutation(internal.payments.billing.finalizeStuckPaymentReconciliation, {
      dodoPaymentId: "pay_reconcile_finalize_customer",
      notified: true,
    });
    expect(upgrade).toEqual({ action: "customer_notified" });

    // A later ops finalize (notified:false) must be a no-op — never downgrade
    // a customer who was already emailed.
    const noDowngrade = await t.mutation(internal.payments.billing.finalizeStuckPaymentReconciliation, {
      dodoPaymentId: "pay_reconcile_finalize_customer",
      notified: false,
    });
    expect(noDowngrade).toEqual({ action: "customer_notified" });

    const markers = await t.run(async (ctx) =>
      ctx.db
        .query("paymentReconciliationAttempts")
        .withIndex("by_dodoPaymentId", (q) => q.eq("dodoPaymentId", "pay_reconcile_finalize_customer"))
        .collect(),
    );
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ action: "customer_notified" });
  });

  test("finalize(ops) keeps the marker ops_notified", async () => {
    vi.setSystemTime(NOW);
    const t = convexTest(schema, modules);

    await seedPaymentEvent(t, {
      status: "processing",
      planKey: "pro_monthly",
      occurredAt: NOW - STUCK_PAYMENT_RECONCILIATION_THRESHOLD_MS - MIN_MS,
      suffix: "finalize_ops",
      dodoPaymentId: "pay_reconcile_finalize_ops",
    });
    await t.mutation(internal.payments.billing.claimStuckPaymentReconciliation, {
      userId: TEST_USER_ID,
      dodoPaymentId: "pay_reconcile_finalize_ops",
      planKey: "pro_monthly",
      amount: 3999,
      currency: "USD",
      pendingOccurredAt: NOW - STUCK_PAYMENT_RECONCILIATION_THRESHOLD_MS - MIN_MS,
      observedStatus: "processing",
      rawPayload: {},
    });

    const result = await t.mutation(internal.payments.billing.finalizeStuckPaymentReconciliation, {
      dodoPaymentId: "pay_reconcile_finalize_ops",
      notified: false,
    });
    expect(result).toEqual({ action: "ops_notified" });

    const markers = await t.run(async (ctx) =>
      ctx.db
        .query("paymentReconciliationAttempts")
        .withIndex("by_dodoPaymentId", (q) => q.eq("dodoPaymentId", "pay_reconcile_finalize_ops"))
        .collect(),
    );
    expect(markers[0]).toMatchObject({ action: "ops_notified" });
  });

  test("action claims the marker BEFORE sending the customer email (F3 idempotency)", async () => {
    vi.setSystemTime(NOW);
    process.env.DODO_API_KEY = "test_dodo_key";
    process.env.RESEND_API_KEY = "test_resend_key";
    const t = convexTest(schema, modules);

    await seedPaymentEvent(t, {
      status: "requires_customer_action",
      planKey: "pro_monthly",
      occurredAt: NOW - STUCK_PAYMENT_RECONCILIATION_THRESHOLD_MS - MIN_MS,
      suffix: "action_order",
      dodoPaymentId: "pay_action_order",
    });

    dodoRetrieveMock.mockResolvedValue({
      status: "requires_customer_action",
      payment_id: "pay_action_order",
      customer: { email: "buyer@example.com" },
      payment_link: "https://checkout.dodopayments.com/session/x",
    });

    let markerExistedAtEmailTime = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
      if (String(input).includes("api.resend.com")) {
        const marker = await t.run(async (ctx) =>
          ctx.db
            .query("paymentReconciliationAttempts")
            .withIndex("by_dodoPaymentId", (q) => q.eq("dodoPaymentId", "pay_action_order"))
            .first(),
        );
        markerExistedAtEmailTime = marker !== null;
        return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });

    const summary = await t.action(internal.payments.billing.reconcileStuckPendingPayments, {});

    // The marker must already exist when the email is sent — that ordering is
    // what makes a post-send failure NON-re-emailing on the next run.
    expect(markerExistedAtEmailTime).toBe(true);
    expect(summary).toMatchObject({ candidates: 1, customerNotified: 1 });

    const marker = await t.run(async (ctx) =>
      ctx.db
        .query("paymentReconciliationAttempts")
        .withIndex("by_dodoPaymentId", (q) => q.eq("dodoPaymentId", "pay_action_order"))
        .first(),
    );
    expect(marker?.action).toBe("customer_notified");
  });

  test("action marks a payment whose Dodo status is NULL and never emails it (F1)", async () => {
    vi.setSystemTime(NOW);
    process.env.DODO_API_KEY = "test_dodo_key";
    process.env.RESEND_API_KEY = "test_resend_key";
    const t = convexTest(schema, modules);

    await seedPaymentEvent(t, {
      status: "requires_customer_action",
      planKey: "pro_monthly",
      occurredAt: NOW - STUCK_PAYMENT_RECONCILIATION_THRESHOLD_MS - MIN_MS,
      suffix: "null_status",
      dodoPaymentId: "pay_null_status",
    });

    // Dodo returns a payment object with no `status` field at all.
    dodoRetrieveMock.mockResolvedValue({
      payment_id: "pay_null_status",
      status: null,
      customer: { email: "buyer@example.com" },
      payment_link: "https://checkout.dodopayments.com/session/x",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 200 }),
    );

    const summary = await t.action(internal.payments.billing.reconcileStuckPendingPayments, {});

    // A marker is written (no 14-day re-poll), status recorded as the sentinel,
    // and NO customer email is sent for an unrecognised status.
    expect(summary).toMatchObject({ candidates: 1, unknownStatus: 1, customerNotified: 0 });
    expect(fetchMock).not.toHaveBeenCalled();

    const marker = await t.run(async (ctx) =>
      ctx.db
        .query("paymentReconciliationAttempts")
        .withIndex("by_dodoPaymentId", (q) => q.eq("dodoPaymentId", "pay_null_status"))
        .first(),
    );
    expect(marker).toMatchObject({ action: "ops_notified", observedStatus: "unknown" });
  });

  test("action marks a non-null UNRECOGNISED status without emailing (F1)", async () => {
    // Distinct from the null-status case: `requires_payment_method` is non-null,
    // so it exercises the SECOND operand of the email gate
    // (isPendingPaymentStatus). If that check regressed, this status would take
    // the email path — the null test alone would not catch it.
    vi.setSystemTime(NOW);
    process.env.DODO_API_KEY = "test_dodo_key";
    process.env.RESEND_API_KEY = "test_resend_key";
    const t = convexTest(schema, modules);

    await seedPaymentEvent(t, {
      status: "requires_customer_action",
      planKey: "pro_monthly",
      occurredAt: NOW - STUCK_PAYMENT_RECONCILIATION_THRESHOLD_MS - MIN_MS,
      suffix: "unrecognised_status",
      dodoPaymentId: "pay_unrecognised",
    });

    dodoRetrieveMock.mockResolvedValue({
      payment_id: "pay_unrecognised",
      status: "requires_payment_method",
      customer: { email: "buyer@example.com" },
      payment_link: "https://checkout.dodopayments.com/session/x",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 200 }),
    );

    const summary = await t.action(internal.payments.billing.reconcileStuckPendingPayments, {});

    expect(summary).toMatchObject({ candidates: 1, unknownStatus: 1, customerNotified: 0 });
    expect(fetchMock).not.toHaveBeenCalled();

    const marker = await t.run(async (ctx) =>
      ctx.db
        .query("paymentReconciliationAttempts")
        .withIndex("by_dodoPaymentId", (q) => q.eq("dodoPaymentId", "pay_unrecognised"))
        .first(),
    );
    expect(marker).toMatchObject({ action: "ops_notified", observedStatus: "requires_payment_method" });
  });

  test("action emails a stuck payment at most once across repeated daily runs (F3)", async () => {
    // The core idempotency guarantee stated end-to-end: two identical daily
    // runs over the same still-pending payment send exactly ONE email — the
    // marker claimed on run 1 removes the row from run 2's candidate set.
    vi.setSystemTime(NOW);
    process.env.DODO_API_KEY = "test_dodo_key";
    process.env.RESEND_API_KEY = "test_resend_key";
    const t = convexTest(schema, modules);

    await seedPaymentEvent(t, {
      status: "requires_customer_action",
      planKey: "pro_monthly",
      occurredAt: NOW - STUCK_PAYMENT_RECONCILIATION_THRESHOLD_MS - MIN_MS,
      suffix: "twice",
      dodoPaymentId: "pay_twice",
    });

    dodoRetrieveMock.mockResolvedValue({
      status: "requires_customer_action",
      payment_id: "pay_twice",
      customer: { email: "buyer@example.com" },
      payment_link: "https://checkout.dodopayments.com/session/x",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "email_1" }), { status: 200 }),
    );

    const first = await t.action(internal.payments.billing.reconcileStuckPendingPayments, {});
    const second = await t.action(internal.payments.billing.reconcileStuckPendingPayments, {});

    expect(first).toMatchObject({ candidates: 1, customerNotified: 1 });
    expect(second).toMatchObject({ candidates: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("action isolates a Resend failure to one candidate and still processes the rest (F6/F7)", async () => {
    // Fake timers so the failed candidate's fire-and-forget Sentry report
    // (a scheduled throwing mutation) is drained inside the test rather than
    // firing after teardown as an unhandled rejection.
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    process.env.DODO_API_KEY = "test_dodo_key";
    process.env.RESEND_API_KEY = "test_resend_key";
    const t = convexTest(schema, modules);

    // Two stale pending payments; pay_iso_a is newer so it is scanned first.
    await seedPaymentEvent(t, {
      status: "requires_customer_action",
      planKey: "pro_monthly",
      occurredAt: NOW - STUCK_PAYMENT_RECONCILIATION_THRESHOLD_MS - MIN_MS,
      suffix: "iso_a",
      dodoPaymentId: "pay_iso_a",
    });
    await seedPaymentEvent(t, {
      status: "requires_customer_action",
      planKey: "pro_monthly",
      occurredAt: NOW - STUCK_PAYMENT_RECONCILIATION_THRESHOLD_MS - 2 * MIN_MS,
      suffix: "iso_b",
      dodoPaymentId: "pay_iso_b",
    });

    dodoRetrieveMock.mockImplementation(async (id: string) => ({
      status: "requires_customer_action",
      payment_id: id,
      customer: { email: "buyer@example.com" },
      payment_link: "https://checkout.dodopayments.com/session/x",
    }));

    // First Resend call throws (hung socket); the second succeeds. Proves the
    // batch is not aborted by one candidate's email failure.
    let resendCalls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
      if (String(input).includes("api.resend.com")) {
        resendCalls++;
        if (resendCalls === 1) throw new Error("socket hang up");
        return new Response(JSON.stringify({ id: "email_ok" }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });

    const summary = await t.action(internal.payments.billing.reconcileStuckPendingPayments, {});
    // Drain the scheduled email-failure report (throws internally, captured by
    // Convex auto-Sentry in prod) so it doesn't leak past the test.
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(summary).toMatchObject({ candidates: 2, emailFailed: 1, customerNotified: 1 });

    // The failed-email candidate still has its claim marker (ops_notified), so
    // the next run skips it — no re-email. The other was notified.
    const markerA = await t.run(async (ctx) =>
      ctx.db
        .query("paymentReconciliationAttempts")
        .withIndex("by_dodoPaymentId", (q) => q.eq("dodoPaymentId", "pay_iso_a"))
        .first(),
    );
    const markerB = await t.run(async (ctx) =>
      ctx.db
        .query("paymentReconciliationAttempts")
        .withIndex("by_dodoPaymentId", (q) => q.eq("dodoPaymentId", "pay_iso_b"))
        .first(),
    );
    expect(markerA?.action).toBe("ops_notified");
    expect(markerB?.action).toBe("customer_notified");
  });

  test("registers the reconciliation cron on a 6-hourly cadence", () => {
    const source = readFileSync("convex/crons.ts", "utf8");

    expect(source).toContain("payments-stuck-pending-reconciliation");
    expect(source).toContain("internal.payments.billing.reconcileStuckPendingPayments");
    // 6-hourly, not daily: keeps a payment's age at first scan under the 24h
    // customer-email freshness gate (daily cadence silently dropped ~25% of
    // stuck payments to ops-only). Anchored so a revert to crons.daily reds.
    expect(source).toMatch(
      /crons\.interval\(\s*"payments-stuck-pending-reconciliation",\s*\{\s*hours:\s*6\s*\}/,
    );
  });
});

// ---------------------------------------------------------------------------
// repairCustomerFromSubscriptionPayload — self-heal data-integrity gap
//
// Webhook handler at `subscriptionHelpers.ts:520-549` writes the
// `customers` row only when `data.customer?.customer_id` is present in the
// webhook payload. Users whose `subscription.active` delivery omitted that
// field end up entitled (active sub written) but with no portal-resolvable
// customer row. WORLDMONITOR-R5 surfaced this for an active Pro Annual
// user — clicking "Manage Billing" threw `NO_CUSTOMER`. This repair runs
// at portal-open time and recovers the dodoCustomerId from the
// subscription's `rawPayload`.
// ---------------------------------------------------------------------------

describe("payments billing repairCustomerFromSubscriptionPayload", () => {
  test("inserts a customers row from rawPayload.customer.customer_id and returns it", async () => {
    const t = convexTest(schema, modules);
    await seedSubscription(t, {
      planKey: "pro_annual",
      dodoProductId: PRODUCT_CATALOG.pro_annual.dodoProductId!,
      status: "active",
      currentPeriodEnd: NOW + 30 * DAY_MS,
      suffix: "repair_happy",
      rawPayload: {
        customer: { customer_id: "cus_recovered_001", email: "Repair@Example.com" },
      },
    });

    const result = await t.mutation(
      internal.payments.billing.repairCustomerFromSubscriptionPayload,
      { userId: TEST_USER_ID },
    );

    expect(result).toMatchObject({
      userId: TEST_USER_ID,
      dodoCustomerId: "cus_recovered_001",
      email: "Repair@Example.com",
      // normalizedEmail mirrors `email.trim().toLowerCase()` — required for
      // O(1) email joins against `registrations`/`emailSuppressions`.
      normalizedEmail: "repair@example.com",
    });

    // Confirm the row landed in the table — a second call should idempotently
    // return the same row rather than insert a duplicate.
    const second = await t.mutation(
      internal.payments.billing.repairCustomerFromSubscriptionPayload,
      { userId: TEST_USER_ID },
    );
    expect(second?.dodoCustomerId).toBe("cus_recovered_001");
    expect(second?._id).toBe(result?._id);
  });

  test("returns null when no subscription payload carries a customer_id", async () => {
    const t = convexTest(schema, modules);
    await seedSubscription(t, {
      planKey: "pro_annual",
      dodoProductId: PRODUCT_CATALOG.pro_annual.dodoProductId!,
      status: "active",
      currentPeriodEnd: NOW + 30 * DAY_MS,
      suffix: "repair_no_payload",
      // Empty payload — exactly the symptomatic case behind WORLDMONITOR-R5.
      rawPayload: {},
    });

    const result = await t.mutation(
      internal.payments.billing.repairCustomerFromSubscriptionPayload,
      { userId: TEST_USER_ID },
    );
    expect(result).toBeNull();
  });

  test("returns null when the user has no subscriptions at all", async () => {
    const t = convexTest(schema, modules);
    const result = await t.mutation(
      internal.payments.billing.repairCustomerFromSubscriptionPayload,
      { userId: TEST_USER_ID },
    );
    expect(result).toBeNull();
  });

  test("prefers active subscription's payload over cancelled when both exist", async () => {
    const t = convexTest(schema, modules);
    await seedSubscription(t, {
      planKey: "pro_monthly",
      dodoProductId: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
      status: "cancelled",
      currentPeriodEnd: NOW - 7 * DAY_MS,
      suffix: "repair_old_cancelled",
      rawPayload: { customer: { customer_id: "cus_stale_old", email: "old@example.com" } },
    });
    await seedSubscription(t, {
      planKey: "pro_annual",
      dodoProductId: PRODUCT_CATALOG.pro_annual.dodoProductId!,
      status: "active",
      currentPeriodEnd: NOW + 30 * DAY_MS,
      suffix: "repair_active",
      rawPayload: { customer: { customer_id: "cus_active_winner", email: "new@example.com" } },
    });

    const result = await t.mutation(
      internal.payments.billing.repairCustomerFromSubscriptionPayload,
      { userId: TEST_USER_ID },
    );
    expect(result?.dodoCustomerId).toBe("cus_active_winner");
  });

  test("refuses to remap when the dodoCustomerId already belongs to a different userId", async () => {
    const t = convexTest(schema, modules);

    // A pre-existing customers row already maps cus_collision_001 to another user.
    await t.run(async (ctx) => {
      await ctx.db.insert("customers", {
        userId: "user_other_owner",
        dodoCustomerId: "cus_collision_001",
        email: "other@example.com",
        normalizedEmail: "other@example.com",
        createdAt: NOW - DAY_MS,
        updatedAt: NOW - DAY_MS,
      });
    });

    // TEST_USER_ID's subscription rawPayload happens to carry the same dodoCustomerId
    // — cross-user collision. The repair must refuse rather than silently remap.
    await seedSubscription(t, {
      planKey: "pro_annual",
      dodoProductId: PRODUCT_CATALOG.pro_annual.dodoProductId!,
      status: "active",
      currentPeriodEnd: NOW + 30 * DAY_MS,
      suffix: "repair_collision",
      rawPayload: { customer: { customer_id: "cus_collision_001", email: "x@x.com" } },
    });

    const result = await t.mutation(
      internal.payments.billing.repairCustomerFromSubscriptionPayload,
      { userId: TEST_USER_ID },
    );
    expect(result).toBeNull();

    // Defensive: confirm the original mapping was NOT clobbered.
    const stillOriginal = await t.run(async (ctx) =>
      ctx.db
        .query("customers")
        .withIndex("by_dodoCustomerId", (q) => q.eq("dodoCustomerId", "cus_collision_001"))
        .first(),
    );
    expect(stillOriginal?.userId).toBe("user_other_owner");
  });

  test("patches existing customers row that lacks dodoCustomerId instead of inserting a duplicate", async () => {
    // Greptile P1 — a customers row can exist for this userId without a
    // dodoCustomerId (the field is v.optional). Repair must update the
    // existing row, NOT insert a second one that getCustomerByUserId's
    // .first() would silently shadow.
    const t = convexTest(schema, modules);

    const existingId = await t.run(async (ctx) =>
      ctx.db.insert("customers", {
        userId: TEST_USER_ID,
        // dodoCustomerId intentionally omitted (v.optional schema state)
        email: "old@example.com",
        normalizedEmail: "old@example.com",
        createdAt: NOW - DAY_MS,
        updatedAt: NOW - DAY_MS,
      }),
    );

    await seedSubscription(t, {
      planKey: "pro_annual",
      dodoProductId: PRODUCT_CATALOG.pro_annual.dodoProductId!,
      status: "active",
      currentPeriodEnd: NOW + 30 * DAY_MS,
      suffix: "repair_patches_existing",
      rawPayload: {
        customer: { customer_id: "cus_patched_001", email: "fresh@example.com" },
      },
    });

    const result = await t.mutation(
      internal.payments.billing.repairCustomerFromSubscriptionPayload,
      { userId: TEST_USER_ID },
    );

    expect(result?._id).toBe(existingId);
    expect(result?.dodoCustomerId).toBe("cus_patched_001");
    expect(result?.email).toBe("fresh@example.com");

    // Exactly ONE customers row for this user — duplicate-avoidance verified.
    const rowsForUser = await t.run(async (ctx) =>
      ctx.db
        .query("customers")
        .withIndex("by_userId", (q) => q.eq("userId", TEST_USER_ID))
        .collect(),
    );
    expect(rowsForUser.length).toBe(1);
  });

  test("does NOT blank out a pre-existing email when payload email is missing", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) =>
      ctx.db.insert("customers", {
        userId: TEST_USER_ID,
        email: "keep@example.com",
        normalizedEmail: "keep@example.com",
        createdAt: NOW - DAY_MS,
        updatedAt: NOW - DAY_MS,
      }),
    );
    await seedSubscription(t, {
      planKey: "pro_annual",
      dodoProductId: PRODUCT_CATALOG.pro_annual.dodoProductId!,
      status: "active",
      currentPeriodEnd: NOW + 30 * DAY_MS,
      suffix: "repair_preserves_email",
      rawPayload: { customer: { customer_id: "cus_emailless" } },
    });

    const result = await t.mutation(
      internal.payments.billing.repairCustomerFromSubscriptionPayload,
      { userId: TEST_USER_ID },
    );
    expect(result?.dodoCustomerId).toBe("cus_emailless");
    expect(result?.email).toBe("keep@example.com");
    expect(result?.normalizedEmail).toBe("keep@example.com");
  });

  test("ignores non-string customer_id values (defensive)", async () => {
    const t = convexTest(schema, modules);
    await seedSubscription(t, {
      planKey: "pro_annual",
      dodoProductId: PRODUCT_CATALOG.pro_annual.dodoProductId!,
      status: "active",
      currentPeriodEnd: NOW + 30 * DAY_MS,
      suffix: "repair_bad_shape",
      // customer_id present but typed wrong (number) — guard rejects, walk continues.
      rawPayload: { customer: { customer_id: 42, email: "n@example.com" } },
    });

    const result = await t.mutation(
      internal.payments.billing.repairCustomerFromSubscriptionPayload,
      { userId: TEST_USER_ID },
    );
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// backfillMissingCustomers — proactive one-shot sweep for the same gap.
//
// The portal-open repair fixes affected users on their NEXT click, but the
// gap is silent until they click. The backfill closes that exposure by
// scanning every user with a subscription and repairing missing customers
// rows in one transaction. Idempotent: a second pass is a no-op.
// ---------------------------------------------------------------------------

describe("payments billing backfillMissingCustomers", () => {
  test("repairs users with subscriptions but no customers row, leaves healthy users alone", async () => {
    const t = convexTest(schema, modules);

    // User A — needs repair (active sub, payload has customer_id, no row yet)
    await seedSubscription(t, {
      planKey: "pro_annual",
      dodoProductId: PRODUCT_CATALOG.pro_annual.dodoProductId!,
      status: "active",
      currentPeriodEnd: NOW + 30 * DAY_MS,
      suffix: "backfill_user_a",
      userId: "user_backfill_a",
      rawPayload: { customer: { customer_id: "cus_a", email: "a@example.com" } },
    });

    // User B — already healthy (customers row exists, should be skipped)
    await seedSubscription(t, {
      planKey: "pro_monthly",
      dodoProductId: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
      status: "active",
      currentPeriodEnd: NOW + 30 * DAY_MS,
      suffix: "backfill_user_b",
      userId: "user_backfill_b",
      rawPayload: { customer: { customer_id: "cus_b", email: "b@example.com" } },
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("customers", {
        userId: "user_backfill_b",
        dodoCustomerId: "cus_b",
        email: "b@example.com",
        normalizedEmail: "b@example.com",
        createdAt: NOW - DAY_MS,
        updatedAt: NOW - DAY_MS,
      });
    });

    // User C — unresolvable (sub exists but rawPayload has no customer_id)
    await seedSubscription(t, {
      planKey: "pro_annual",
      dodoProductId: PRODUCT_CATALOG.pro_annual.dodoProductId!,
      status: "active",
      currentPeriodEnd: NOW + 30 * DAY_MS,
      suffix: "backfill_user_c",
      userId: "user_backfill_c",
      rawPayload: {},
    });

    const summary = await t.mutation(
      internal.payments.billing.backfillMissingCustomers,
      {},
    );

    expect(summary).toMatchObject({
      usersInspected: 3,
      alreadyHadCustomer: 1,
      repaired: 1,
      couldNotRepair: 1,
      unresolved: ["user_backfill_c"],
    });

    // Confirm A now has a customers row with the right dodoCustomerId.
    const aCustomer = await t.run(async (ctx) =>
      ctx.db
        .query("customers")
        .withIndex("by_userId", (q) => q.eq("userId", "user_backfill_a"))
        .first(),
    );
    expect(aCustomer?.dodoCustomerId).toBe("cus_a");

    // Confirm B was not duplicated.
    const bCustomers = await t.run(async (ctx) =>
      ctx.db
        .query("customers")
        .withIndex("by_userId", (q) => q.eq("userId", "user_backfill_b"))
        .collect(),
    );
    expect(bCustomers.length).toBe(1);

    // Confirm C has no customers row.
    const cCustomer = await t.run(async (ctx) =>
      ctx.db
        .query("customers")
        .withIndex("by_userId", (q) => q.eq("userId", "user_backfill_c"))
        .first(),
    );
    expect(cCustomer).toBeNull();
  });

  test("patches an existing customers row that lacks dodoCustomerId instead of inserting a duplicate", async () => {
    // Greptile P1 (backfill path): same duplicate-avoidance contract as
    // the portal-open repair — when the outer `existing` lookup finds a
    // row without dodoCustomerId, patch it rather than inserting.
    const t = convexTest(schema, modules);

    const existingId = await t.run(async (ctx) =>
      ctx.db.insert("customers", {
        userId: "user_backfill_patch",
        // dodoCustomerId intentionally omitted
        email: "stale@example.com",
        normalizedEmail: "stale@example.com",
        createdAt: NOW - DAY_MS,
        updatedAt: NOW - DAY_MS,
      }),
    );

    await seedSubscription(t, {
      planKey: "pro_annual",
      dodoProductId: PRODUCT_CATALOG.pro_annual.dodoProductId!,
      status: "active",
      currentPeriodEnd: NOW + 30 * DAY_MS,
      suffix: "backfill_patch",
      userId: "user_backfill_patch",
      rawPayload: { customer: { customer_id: "cus_backfill_patch", email: "n@example.com" } },
    });

    const summary = await t.mutation(
      internal.payments.billing.backfillMissingCustomers,
      {},
    );
    expect(summary).toMatchObject({ repaired: 1, alreadyHadCustomer: 0 });

    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("customers")
        .withIndex("by_userId", (q) => q.eq("userId", "user_backfill_patch"))
        .collect(),
    );
    expect(rows.length).toBe(1);
    expect(rows[0]?._id).toBe(existingId);
    expect(rows[0]?.dodoCustomerId).toBe("cus_backfill_patch");
    expect(rows[0]?.email).toBe("n@example.com");
  });

  test("is idempotent — second pass reports zero new repairs", async () => {
    const t = convexTest(schema, modules);
    await seedSubscription(t, {
      planKey: "pro_annual",
      dodoProductId: PRODUCT_CATALOG.pro_annual.dodoProductId!,
      status: "active",
      currentPeriodEnd: NOW + 30 * DAY_MS,
      suffix: "backfill_idempotent",
      userId: "user_idem_001",
      rawPayload: { customer: { customer_id: "cus_idem", email: "i@example.com" } },
    });

    const first = await t.mutation(
      internal.payments.billing.backfillMissingCustomers,
      {},
    );
    expect(first).toMatchObject({ repaired: 1, alreadyHadCustomer: 0 });

    const second = await t.mutation(
      internal.payments.billing.backfillMissingCustomers,
      {},
    );
    expect(second).toMatchObject({ repaired: 0, alreadyHadCustomer: 1 });
  });
});

// ---------------------------------------------------------------------------
// getDodoCustomerIdForUserPortal — read straight from the user's preferred
// subscription's rawPayload, bypass the customers table.
//
// The customers table races under concurrent `subscription.active`
// webhooks (latest-writer-wins patch in subscriptionHelpers.ts:533),
// so it's an unreliable anchor for "which Dodo customer should this
// Clerk userId's Manage Billing click open." The subscription's
// rawPayload is per-Clerk-userId and immutable — that's the truth.
// ---------------------------------------------------------------------------

describe("payments billing getDodoCustomerIdForUserPortal", () => {
  test("returns null when the user has no subscriptions at all", async () => {
    const t = convexTest(schema, modules);
    const result = await t.query(
      internal.payments.billing.getDodoCustomerIdForUserPortal,
      { userId: TEST_USER_ID },
    );
    expect(result).toBeNull();
  });

  test("returns the dodoCustomerId from the active subscription's rawPayload", async () => {
    const t = convexTest(schema, modules);
    await seedSubscription(t, {
      planKey: "pro_annual",
      dodoProductId: PRODUCT_CATALOG.pro_annual.dodoProductId!,
      status: "active",
      currentPeriodEnd: NOW + 30 * DAY_MS,
      suffix: "portal_active",
      rawPayload: {
        customer: { customer_id: "cus_active_winner", email: "a@example.com" },
      },
    });
    const result = await t.query(
      internal.payments.billing.getDodoCustomerIdForUserPortal,
      { userId: TEST_USER_ID },
    );
    expect(result).toBe("cus_active_winner");
  });

  test("prefers active over on_hold over cancelled, ignoring the customers table entirely", async () => {
    const t = convexTest(schema, modules);

    // A customers row exists for this user but with a STALE/WRONG dodoCustomerId
    // — this lookup must ignore it and read from the active subscription.
    await t.run(async (ctx) => {
      await ctx.db.insert("customers", {
        userId: TEST_USER_ID,
        dodoCustomerId: "cus_stale_from_customers_table",
        email: "stale@example.com",
        normalizedEmail: "stale@example.com",
        createdAt: NOW - 10 * DAY_MS,
        updatedAt: NOW - 10 * DAY_MS,
      });
    });

    await seedSubscription(t, {
      planKey: "pro_monthly",
      dodoProductId: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
      status: "cancelled",
      currentPeriodEnd: NOW - 5 * DAY_MS,
      suffix: "portal_cancelled_old",
      rawPayload: { customer: { customer_id: "cus_cancelled_loser" } },
    });
    await seedSubscription(t, {
      planKey: "pro_annual",
      dodoProductId: PRODUCT_CATALOG.pro_annual.dodoProductId!,
      status: "on_hold",
      currentPeriodEnd: NOW + 5 * DAY_MS,
      suffix: "portal_onhold_middle",
      rawPayload: { customer: { customer_id: "cus_onhold_middle" } },
    });
    await seedSubscription(t, {
      planKey: "pro_monthly",
      dodoProductId: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
      status: "active",
      currentPeriodEnd: NOW + 30 * DAY_MS,
      suffix: "portal_active_winner",
      rawPayload: { customer: { customer_id: "cus_active_winner" } },
    });

    const result = await t.query(
      internal.payments.billing.getDodoCustomerIdForUserPortal,
      { userId: TEST_USER_ID },
    );
    expect(result).toBe("cus_active_winner");
  });

  test("falls back to on_hold when no active sub exists", async () => {
    const t = convexTest(schema, modules);
    await seedSubscription(t, {
      planKey: "pro_monthly",
      dodoProductId: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
      status: "on_hold",
      currentPeriodEnd: NOW + 5 * DAY_MS,
      suffix: "portal_only_onhold",
      rawPayload: { customer: { customer_id: "cus_onhold_only" } },
    });
    const result = await t.query(
      internal.payments.billing.getDodoCustomerIdForUserPortal,
      { userId: TEST_USER_ID },
    );
    expect(result).toBe("cus_onhold_only");
  });

  test("falls back to cancelled when only cancelled subs exist (within or past grace)", async () => {
    const t = convexTest(schema, modules);
    await seedSubscription(t, {
      planKey: "pro_monthly",
      dodoProductId: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
      status: "cancelled",
      currentPeriodEnd: NOW - 10 * DAY_MS,
      suffix: "portal_only_cancelled",
      rawPayload: { customer: { customer_id: "cus_cancelled_only" } },
    });
    const result = await t.query(
      internal.payments.billing.getDodoCustomerIdForUserPortal,
      { userId: TEST_USER_ID },
    );
    expect(result).toBe("cus_cancelled_only");
  });

  test("returns null when every subscription's rawPayload lacks a customer_id", async () => {
    const t = convexTest(schema, modules);
    await seedSubscription(t, {
      planKey: "pro_annual",
      dodoProductId: PRODUCT_CATALOG.pro_annual.dodoProductId!,
      status: "active",
      currentPeriodEnd: NOW + 30 * DAY_MS,
      suffix: "portal_empty_payload",
      rawPayload: {},
    });
    const result = await t.query(
      internal.payments.billing.getDodoCustomerIdForUserPortal,
      { userId: TEST_USER_ID },
    );
    expect(result).toBeNull();
  });

  test("ignores non-string customer_id values (defensive)", async () => {
    const t = convexTest(schema, modules);
    await seedSubscription(t, {
      planKey: "pro_annual",
      dodoProductId: PRODUCT_CATALOG.pro_annual.dodoProductId!,
      status: "active",
      currentPeriodEnd: NOW + 30 * DAY_MS,
      suffix: "portal_bad_shape",
      rawPayload: { customer: { customer_id: 42 } },
    });
    const result = await t.query(
      internal.payments.billing.getDodoCustomerIdForUserPortal,
      { userId: TEST_USER_ID },
    );
    expect(result).toBeNull();
  });

  test("returns the right dodoCustomerId for each Clerk user when SAME Dodo customer is shared across multiple Clerk accounts (the WORLDMONITOR-R5 scenario)", async () => {
    // user_A and user_B both checked out with the same email; Dodo deduped
    // to one customer (cus_shared). Each has their OWN subscription row,
    // and the customers table's userId field may point at either one due
    // to webhook race. This query must work for BOTH users regardless of
    // who currently owns the customers row.
    const t = convexTest(schema, modules);

    // customers row currently owned by user_A (could just as easily be user_B).
    await t.run(async (ctx) => {
      await ctx.db.insert("customers", {
        userId: "user_A",
        dodoCustomerId: "cus_shared",
        email: "shared@example.com",
        normalizedEmail: "shared@example.com",
        createdAt: NOW - DAY_MS,
        updatedAt: NOW - DAY_MS,
      });
    });

    await seedSubscription(t, {
      planKey: "pro_monthly",
      dodoProductId: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
      status: "active",
      currentPeriodEnd: NOW + 30 * DAY_MS,
      suffix: "portal_userA",
      userId: "user_A",
      rawPayload: { customer: { customer_id: "cus_shared", email: "shared@example.com" } },
    });
    await seedSubscription(t, {
      planKey: "pro_monthly",
      dodoProductId: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
      status: "active",
      currentPeriodEnd: NOW + 30 * DAY_MS,
      suffix: "portal_userB",
      userId: "user_B",
      rawPayload: { customer: { customer_id: "cus_shared", email: "shared@example.com" } },
    });

    const resultA = await t.query(
      internal.payments.billing.getDodoCustomerIdForUserPortal,
      { userId: "user_A" },
    );
    const resultB = await t.query(
      internal.payments.billing.getDodoCustomerIdForUserPortal,
      { userId: "user_B" },
    );
    // Both Clerk accounts resolve to the SAME shared Dodo customer,
    // without needing to consult the customers table. Each Clerk
    // account's "Manage Billing" click opens the right portal.
    expect(resultA).toBe("cus_shared");
    expect(resultB).toBe("cus_shared");
  });

  test("resolves via the stable dodoCustomerId column even when a later lifecycle payload wiped the rawPayload customer field (P1 regression)", async () => {
    // Reviewer P1 scenario: `subscription.active` payload included
    // `customer.customer_id`, but a later lifecycle event
    // (`subscription.renewed` / `.on_hold` / `.cancelled` / `.plan_changed`
    // / `.expired`) overwrote `rawPayload` with a payload that lacks the
    // `customer` field. The stable top-level `dodoCustomerId` column
    // written by the webhook handler (via `mergeDodoCustomerId`)
    // preserves the value across these patches, so portal lookup
    // still succeeds.
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("subscriptions", {
        userId: TEST_USER_ID,
        dodoSubscriptionId: "sub_lifecycle_wiped",
        dodoProductId: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
        planKey: "pro_monthly",
        status: "active",
        currentPeriodStart: NOW - DAY_MS,
        currentPeriodEnd: NOW + 30 * DAY_MS,
        // Stable column has the correct value, written on subscription.active.
        dodoCustomerId: "cus_preserved_across_lifecycle",
        // rawPayload was overwritten by a later lifecycle event without customer.
        rawPayload: {
          subscription_id: "sub_lifecycle_wiped",
          product_id: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
          // intentionally no `customer` field
        },
        updatedAt: NOW,
      });
    });

    const result = await t.query(
      internal.payments.billing.getDodoCustomerIdForUserPortal,
      { userId: TEST_USER_ID },
    );
    expect(result).toBe("cus_preserved_across_lifecycle");
  });

  test("falls back to the same-user customers row when neither stable column nor rawPayload has the customer_id (P1 reviewer regression)", async () => {
    // Reviewer P1 scenario: a sub row pre-dates this PR AND its
    // rawPayload was already wiped by a lifecycle event before the
    // schema change shipped. Tier 1 misses (no column), tier 2 misses
    // (no rawPayload.customer), but the customers row for the same
    // userId still has a usable dodoCustomerId — that's the right
    // answer, better than NO_CUSTOMER for a paying user.
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("customers", {
        userId: TEST_USER_ID,
        dodoCustomerId: "cus_from_customers_tier3",
        email: "rescued@example.com",
        normalizedEmail: "rescued@example.com",
        createdAt: NOW - 10 * DAY_MS,
        updatedAt: NOW - 10 * DAY_MS,
      });
      await ctx.db.insert("subscriptions", {
        userId: TEST_USER_ID,
        dodoSubscriptionId: "sub_tier3_rescue",
        dodoProductId: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
        planKey: "pro_monthly",
        status: "active",
        currentPeriodStart: NOW - DAY_MS,
        currentPeriodEnd: NOW + 30 * DAY_MS,
        // dodoCustomerId column intentionally absent
        rawPayload: {}, // wiped
        updatedAt: NOW,
      });
    });

    const result = await t.query(
      internal.payments.billing.getDodoCustomerIdForUserPortal,
      { userId: TEST_USER_ID },
    );
    expect(result).toBe("cus_from_customers_tier3");
  });

  test("does NOT use the customers row when it belongs to a different userId (no silent re-attribution)", async () => {
    // Defensive: the customers row is matched by `by_userId` index, so
    // a cross-user race that pointed cus_X at user_B does NOT leak
    // through tier 3 when user_A clicks Manage Billing.
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      // Customer row owned by SOMEONE ELSE
      await ctx.db.insert("customers", {
        userId: "user_someone_else",
        dodoCustomerId: "cus_belongs_to_someone_else",
        email: "other@example.com",
        normalizedEmail: "other@example.com",
        createdAt: NOW - 10 * DAY_MS,
        updatedAt: NOW - 10 * DAY_MS,
      });
      // The user clicking Manage Billing has a sub but no customers row
      // and no rawPayload customer.
      await ctx.db.insert("subscriptions", {
        userId: TEST_USER_ID,
        dodoSubscriptionId: "sub_tier3_no_match",
        dodoProductId: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
        planKey: "pro_monthly",
        status: "active",
        currentPeriodStart: NOW - DAY_MS,
        currentPeriodEnd: NOW + 30 * DAY_MS,
        rawPayload: {},
        updatedAt: NOW,
      });
    });

    const result = await t.query(
      internal.payments.billing.getDodoCustomerIdForUserPortal,
      { userId: TEST_USER_ID },
    );
    // null — no silent cross-user fallback.
    expect(result).toBeNull();
  });

  test("falls back to rawPayload.customer.customer_id when the stable column is absent (pre-schema-change rows)", async () => {
    // Backfill safety net: rows that pre-date the schema change have no
    // top-level `dodoCustomerId`. The query falls back to the rawPayload
    // value so they keep working until the backfill mutation catches up.
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("subscriptions", {
        userId: TEST_USER_ID,
        dodoSubscriptionId: "sub_pre_schema",
        dodoProductId: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
        planKey: "pro_monthly",
        status: "active",
        currentPeriodStart: NOW - DAY_MS,
        currentPeriodEnd: NOW + 30 * DAY_MS,
        // dodoCustomerId intentionally omitted (pre-schema-change state)
        rawPayload: {
          customer: { customer_id: "cus_from_legacy_payload" },
        },
        updatedAt: NOW,
      });
    });

    const result = await t.query(
      internal.payments.billing.getDodoCustomerIdForUserPortal,
      { userId: TEST_USER_ID },
    );
    expect(result).toBe("cus_from_legacy_payload");
  });
});

// ---------------------------------------------------------------------------
// backfillSubscriptionDodoCustomerId — one-shot populate the new column
// from rawPayload for rows that pre-date the schema change.
// ---------------------------------------------------------------------------

describe("payments billing backfillSubscriptionDodoCustomerId", () => {
  test("populates from rawPayload, falls back to customers row, skips already-populated, reports unrecoverable count", async () => {
    const t = convexTest(schema, modules);

    // Row A — needs backfill from rawPayload (Source 1)
    await t.run(async (ctx) => {
      await ctx.db.insert("subscriptions", {
        userId: "user_backfill_A",
        dodoSubscriptionId: "sub_backfill_A",
        dodoProductId: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
        planKey: "pro_monthly",
        status: "active",
        currentPeriodStart: NOW - DAY_MS,
        currentPeriodEnd: NOW + 30 * DAY_MS,
        rawPayload: { customer: { customer_id: "cus_A" } },
        updatedAt: NOW,
      });
    });

    // Row B — already populated, must be skipped
    await t.run(async (ctx) => {
      await ctx.db.insert("subscriptions", {
        userId: "user_backfill_B",
        dodoSubscriptionId: "sub_backfill_B",
        dodoProductId: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
        planKey: "pro_monthly",
        status: "active",
        currentPeriodStart: NOW - DAY_MS,
        currentPeriodEnd: NOW + 30 * DAY_MS,
        dodoCustomerId: "cus_B_already",
        rawPayload: { customer: { customer_id: "cus_B_already" } },
        updatedAt: NOW,
      });
    });

    // Row C — rawPayload was wiped pre-PR, but same-user customers row
    // still has dodoCustomerId (P1 reviewer's scenario). Recoverable
    // via Source 2.
    await t.run(async (ctx) => {
      await ctx.db.insert("customers", {
        userId: "user_backfill_C",
        dodoCustomerId: "cus_C_from_customers",
        email: "c@example.com",
        normalizedEmail: "c@example.com",
        createdAt: NOW - 10 * DAY_MS,
        updatedAt: NOW - 10 * DAY_MS,
      });
      await ctx.db.insert("subscriptions", {
        userId: "user_backfill_C",
        dodoSubscriptionId: "sub_backfill_C",
        dodoProductId: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
        planKey: "pro_monthly",
        status: "active",
        currentPeriodStart: NOW - DAY_MS,
        currentPeriodEnd: NOW + 30 * DAY_MS,
        rawPayload: {}, // wiped
        updatedAt: NOW,
      });
    });

    // Row D — neither column nor rawPayload nor customers row.
    // Genuinely unrecoverable (needs manual triage).
    await t.run(async (ctx) => {
      await ctx.db.insert("subscriptions", {
        userId: "user_backfill_D",
        dodoSubscriptionId: "sub_backfill_D",
        dodoProductId: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
        planKey: "pro_monthly",
        status: "active",
        currentPeriodStart: NOW - DAY_MS,
        currentPeriodEnd: NOW + 30 * DAY_MS,
        rawPayload: {},
        updatedAt: NOW,
      });
    });

    const summary = await t.mutation(
      internal.payments.billing.backfillSubscriptionDodoCustomerId,
      {},
    );
    expect(summary).toMatchObject({
      inspected: 4,
      populatedFromPayload: 1,
      populatedFromCustomers: 1,
      alreadyPopulated: 1,
      unrecoverable: 1,
    });

    // A populated via rawPayload.
    const aRow = await t.run(async (ctx) =>
      ctx.db
        .query("subscriptions")
        .withIndex("by_userId", (q) => q.eq("userId", "user_backfill_A"))
        .first(),
    );
    expect(aRow?.dodoCustomerId).toBe("cus_A");

    // C populated via customers row fallback.
    const cRow = await t.run(async (ctx) =>
      ctx.db
        .query("subscriptions")
        .withIndex("by_userId", (q) => q.eq("userId", "user_backfill_C"))
        .first(),
    );
    expect(cRow?.dodoCustomerId).toBe("cus_C_from_customers");

    // D stays empty (unrecoverable).
    const dRow = await t.run(async (ctx) =>
      ctx.db
        .query("subscriptions")
        .withIndex("by_userId", (q) => q.eq("userId", "user_backfill_D"))
        .first(),
    );
    expect(dRow?.dodoCustomerId).toBeUndefined();

    // Re-running is a no-op (idempotent).
    const second = await t.mutation(
      internal.payments.billing.backfillSubscriptionDodoCustomerId,
      {},
    );
    expect(second).toMatchObject({
      populatedFromPayload: 0,
      populatedFromCustomers: 0,
      alreadyPopulated: 3,
      unrecoverable: 1,
    });
  });
});

describe("payments billing missed renewal reconciliation", () => {
  test("extends a stale local active subscription from active Dodo truth and recomputes entitlement", async () => {
    const t = convexTest(schema, modules);
    const stalePeriodEnd = NOW - DAY_MS;
    const remotePeriodStart = NOW;
    const remotePeriodEnd = NOW + 30 * DAY_MS;

    await t.run(async (ctx) => {
      await ctx.db.insert("subscriptions", {
        userId: TEST_USER_ID,
        dodoSubscriptionId: "sub_missed_renewal",
        dodoProductId: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
        planKey: "pro_monthly",
        status: "active",
        currentPeriodStart: NOW - 31 * DAY_MS,
        currentPeriodEnd: stalePeriodEnd,
        dodoCustomerId: "cus_missed_renewal",
        rawPayload: { subscription_id: "sub_missed_renewal" },
        updatedAt: NOW - DAY_MS,
      });
      await ctx.db.insert("entitlements", {
        userId: TEST_USER_ID,
        planKey: "pro_monthly",
        features: getFeaturesForPlan("pro_monthly"),
        validUntil: stalePeriodEnd,
        updatedAt: NOW - DAY_MS,
      });
    });

    const summary = await t.action(
      internal.payments.billing.reconcileMissedDodoRenewals,
      {
        now: NOW,
        remoteSubscriptionsForTest: [
          {
            subscription_id: "sub_missed_renewal",
            product_id: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
            status: "active",
            previous_billing_date: new Date(remotePeriodStart).toISOString(),
            next_billing_date: new Date(remotePeriodEnd).toISOString(),
            customer: {
              customer_id: "cus_missed_renewal",
              email: "renewal@example.com",
            },
            metadata: { wm_user_id: TEST_USER_ID },
            recurring_pre_tax_amount: 1200,
            currency: "USD",
            tax_inclusive: false,
          },
        ],
      },
    );

    expect(summary).toMatchObject({
      inspected: 1,
      reconciled: 1,
      failed: 0,
      skipped: 0,
    });

    const rows = await t.run(async (ctx) => {
      const [sub, entitlement] = await Promise.all([
        ctx.db
          .query("subscriptions")
          .withIndex("by_dodoSubscriptionId", (q) =>
            q.eq("dodoSubscriptionId", "sub_missed_renewal"),
          )
          .unique(),
        ctx.db
          .query("entitlements")
          .withIndex("by_userId", (q) => q.eq("userId", TEST_USER_ID))
          .first(),
      ]);
      return { sub, entitlement };
    });

    expect(rows.sub?.currentPeriodStart).toBe(remotePeriodStart);
    expect(rows.sub?.currentPeriodEnd).toBe(remotePeriodEnd);
    expect(rows.sub?.updatedAt).toBe(NOW);
    expect(rows.entitlement?.planKey).toBe("pro_monthly");
    expect(rows.entitlement?.validUntil).toBe(remotePeriodEnd);
    expect(rows.entitlement?.updatedAt).toBe(NOW);
  });

  test("continues reconciling other stale subscriptions when one Dodo lookup fails", async () => {
    const t = convexTest(schema, modules);
    const stalePeriodEnd = NOW - DAY_MS;
    const remotePeriodEnd = NOW + 14 * DAY_MS;

    await t.run(async (ctx) => {
      for (const suffix of ["ok", "missing"]) {
        const userId = `user_reconcile_${suffix}`;
        await ctx.db.insert("subscriptions", {
          userId,
          dodoSubscriptionId: `sub_reconcile_${suffix}`,
          dodoProductId: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
          planKey: "pro_monthly",
          status: "active",
          currentPeriodStart: NOW - 31 * DAY_MS,
          currentPeriodEnd: stalePeriodEnd,
          rawPayload: { subscription_id: `sub_reconcile_${suffix}` },
          updatedAt: NOW - DAY_MS,
        });
        await ctx.db.insert("entitlements", {
          userId,
          planKey: "pro_monthly",
          features: getFeaturesForPlan("pro_monthly"),
          validUntil: stalePeriodEnd,
          updatedAt: NOW - DAY_MS,
        });
      }
    });

    const summary = await t.action(
      internal.payments.billing.reconcileMissedDodoRenewals,
      {
        now: NOW,
        remoteSubscriptionsForTest: [
          {
            subscription_id: "sub_reconcile_ok",
            product_id: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
            status: "active",
            previous_billing_date: new Date(NOW).toISOString(),
            next_billing_date: new Date(remotePeriodEnd).toISOString(),
          },
        ],
      },
    );

    expect(summary).toMatchObject({
      inspected: 2,
      reconciled: 1,
      failed: 1,
      skipped: 0,
    });
    expect(summary.failures).toEqual([
      {
        dodoSubscriptionId: "sub_reconcile_missing",
        error: "missing test remote subscription",
      },
    ]);

    const okEntitlement = await t.run(async (ctx) =>
      ctx.db
        .query("entitlements")
        .withIndex("by_userId", (q) => q.eq("userId", "user_reconcile_ok"))
        .first(),
    );
    expect(okEntitlement?.validUntil).toBe(remotePeriodEnd);
  });

  async function seedStaleActiveForReconcile(
    t: ReturnType<typeof convexTest>,
    opts: {
      suffix: string;
      userId?: string;
      planKey?: string;
      dodoProductId?: string;
      currentPeriodEnd?: number;
      updatedAt?: number;
      dodoCustomerId?: string;
      seedEntitlement?: boolean;
    },
  ) {
    const userId = opts.userId ?? TEST_USER_ID;
    const planKey = opts.planKey ?? "pro_monthly";
    const currentPeriodEnd = opts.currentPeriodEnd ?? NOW - DAY_MS;
    const updatedAt = opts.updatedAt ?? NOW - DAY_MS;
    const id = await t.run(async (ctx) => {
      const subId = await ctx.db.insert("subscriptions", {
        userId,
        dodoSubscriptionId: `sub_${opts.suffix}`,
        dodoProductId: opts.dodoProductId ?? PRODUCT_CATALOG.pro_monthly.dodoProductId!,
        planKey,
        status: "active",
        currentPeriodStart: NOW - 31 * DAY_MS,
        currentPeriodEnd,
        ...(opts.dodoCustomerId ? { dodoCustomerId: opts.dodoCustomerId } : {}),
        rawPayload: { subscription_id: `sub_${opts.suffix}` },
        updatedAt,
      });
      if (opts.seedEntitlement !== false) {
        await ctx.db.insert("entitlements", {
          userId,
          planKey,
          features: getFeaturesForPlan(planKey),
          validUntil: currentPeriodEnd,
          updatedAt,
        });
      }
      return subId;
    });
    return id;
  }

  const readSub = (t: ReturnType<typeof convexTest>, suffix: string) =>
    t.run(async (ctx) =>
      ctx.db
        .query("subscriptions")
        .withIndex("by_dodoSubscriptionId", (q) =>
          q.eq("dodoSubscriptionId", `sub_${suffix}`),
        )
        .unique(),
    );

  const readEntitlement = (t: ReturnType<typeof convexTest>, userId: string) =>
    t.run(async (ctx) =>
      ctx.db
        .query("entitlements")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .first(),
    );

  test("maps a remote `failed` status to local expired and downgrades entitlement", async () => {
    const t = convexTest(schema, modules);
    const stalePeriodEnd = NOW - DAY_MS;
    await seedStaleActiveForReconcile(t, { suffix: "failed", currentPeriodEnd: stalePeriodEnd });

    const summary = await t.action(
      internal.payments.billing.reconcileMissedDodoRenewals,
      {
        now: NOW,
        remoteSubscriptionsForTest: [
          {
            subscription_id: "sub_failed",
            product_id: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
            status: "failed",
            previous_billing_date: new Date(NOW - 31 * DAY_MS).toISOString(),
            next_billing_date: new Date(stalePeriodEnd).toISOString(),
          },
        ],
      },
    );

    expect(summary).toMatchObject({ inspected: 1, reconciled: 1, skipped: 0, failed: 0 });

    const sub = await readSub(t, "failed");
    const entitlement = await readEntitlement(t, TEST_USER_ID);
    expect(sub?.status).toBe("expired");
    expect(entitlement?.planKey).toBe("free");
  });

  test("marks a remote-cancelled subscription cancelled and downgrades once the period has ended", async () => {
    const t = convexTest(schema, modules);
    const stalePeriodEnd = NOW - DAY_MS;
    await seedStaleActiveForReconcile(t, { suffix: "cancelled", currentPeriodEnd: stalePeriodEnd });

    const summary = await t.action(
      internal.payments.billing.reconcileMissedDodoRenewals,
      {
        now: NOW,
        remoteSubscriptionsForTest: [
          {
            subscription_id: "sub_cancelled",
            product_id: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
            status: "cancelled",
            previous_billing_date: new Date(NOW - 31 * DAY_MS).toISOString(),
            next_billing_date: new Date(stalePeriodEnd).toISOString(),
            cancelled_at: new Date(NOW - 2 * DAY_MS).toISOString(),
          },
        ],
      },
    );

    expect(summary).toMatchObject({ inspected: 1, reconciled: 1, skipped: 0, failed: 0 });

    const sub = await readSub(t, "cancelled");
    const entitlement = await readEntitlement(t, TEST_USER_ID);
    expect(sub?.status).toBe("cancelled");
    expect(sub?.cancelledAt).toBe(NOW - 2 * DAY_MS);
    expect(entitlement?.planKey).toBe("free");
  });

  test("falls back to an enterprise entitlement for an unknown Dodo product id", async () => {
    const t = convexTest(schema, modules);
    const remotePeriodEnd = NOW + 30 * DAY_MS;
    await seedStaleActiveForReconcile(t, { suffix: "unknown_product" });

    const summary = await t.action(
      internal.payments.billing.reconcileMissedDodoRenewals,
      {
        now: NOW,
        remoteSubscriptionsForTest: [
          {
            subscription_id: "sub_unknown_product",
            product_id: "pdt_unknown_reconcile_fallback",
            status: "active",
            previous_billing_date: new Date(NOW).toISOString(),
            next_billing_date: new Date(remotePeriodEnd).toISOString(),
          },
        ],
      },
    );

    expect(summary).toMatchObject({ inspected: 1, reconciled: 1, skipped: 0, failed: 0 });

    const sub = await readSub(t, "unknown_product");
    const entitlement = await readEntitlement(t, TEST_USER_ID);
    expect(sub?.dodoProductId).toBe("pdt_unknown_reconcile_fallback");
    expect(sub?.planKey).toBe("enterprise");
    expect(entitlement?.planKey).toBe("enterprise");
  });

  test("skips an unsupported remote status, escalates, and backs the row off", async () => {
    const t = convexTest(schema, modules);
    const stalePeriodEnd = NOW - DAY_MS;
    await seedStaleActiveForReconcile(t, { suffix: "paused", currentPeriodEnd: stalePeriodEnd });

    const summary = await t.action(
      internal.payments.billing.reconcileMissedDodoRenewals,
      {
        now: NOW,
        remoteSubscriptionsForTest: [
          {
            subscription_id: "sub_paused",
            product_id: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
            status: "paused",
            previous_billing_date: new Date(NOW - 31 * DAY_MS).toISOString(),
            next_billing_date: new Date(stalePeriodEnd).toISOString(),
          },
        ],
      },
    );

    expect(summary).toMatchObject({ inspected: 1, reconciled: 0, skipped: 1, failed: 0 });

    const sub = await readSub(t, "paused");
    expect(sub?.status).toBe("active");
    expect(sub?.currentPeriodEnd).toBe(stalePeriodEnd);
    expect(sub?.reconcileFailureCount).toBe(1);
    expect(sub?.lastReconcileAttemptAt).toBe(NOW);
  });

  test("skips a remote `pending` status and backs the row off", async () => {
    const t = convexTest(schema, modules);
    const stalePeriodEnd = NOW - DAY_MS;
    await seedStaleActiveForReconcile(t, { suffix: "pending", currentPeriodEnd: stalePeriodEnd });

    const summary = await t.action(
      internal.payments.billing.reconcileMissedDodoRenewals,
      {
        now: NOW,
        remoteSubscriptionsForTest: [
          {
            subscription_id: "sub_pending",
            product_id: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
            status: "pending",
            previous_billing_date: new Date(NOW - 31 * DAY_MS).toISOString(),
            next_billing_date: new Date(stalePeriodEnd).toISOString(),
          },
        ],
      },
    );

    expect(summary).toMatchObject({ inspected: 1, reconciled: 0, skipped: 1, failed: 0 });

    const sub = await readSub(t, "pending");
    expect(sub?.status).toBe("active");
    expect(sub?.reconcileFailureCount).toBe(1);
  });

  test("mutation skips when the local row is no longer stale", async () => {
    const t = convexTest(schema, modules);
    const subId = await seedStaleActiveForReconcile(t, {
      suffix: "no_longer_stale",
      currentPeriodEnd: NOW + DAY_MS, // already renewed by a concurrent webhook
      seedEntitlement: false,
    });

    const result = await t.mutation(
      internal.payments.billing.applyDodoSubscriptionReconciliation,
      {
        subscriptionId: subId,
        dodoSubscriptionId: "sub_no_longer_stale",
        observedAt: NOW,
        remote: {
          dodoSubscriptionId: "sub_no_longer_stale",
          productId: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
          status: "active",
          currentPeriodStart: NOW,
          currentPeriodEnd: NOW + 30 * DAY_MS,
          rawPayload: {},
        },
      },
    );

    expect(result).toEqual({ kind: "skipped", reason: "local_no_longer_stale" });
  });

  test("mutation skips when remote is not newer than the stale local row", async () => {
    const t = convexTest(schema, modules);
    const staleEnd = NOW - DAY_MS;
    const subId = await seedStaleActiveForReconcile(t, {
      suffix: "not_newer",
      currentPeriodEnd: staleEnd,
      updatedAt: NOW - 2 * DAY_MS,
      dodoCustomerId: "cus_not_newer",
      seedEntitlement: false,
    });

    const result = await t.mutation(
      internal.payments.billing.applyDodoSubscriptionReconciliation,
      {
        subscriptionId: subId,
        dodoSubscriptionId: "sub_not_newer",
        observedAt: NOW,
        remote: {
          dodoSubscriptionId: "sub_not_newer",
          productId: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
          status: "active",
          currentPeriodStart: NOW - 31 * DAY_MS,
          currentPeriodEnd: staleEnd - DAY_MS, // <= existing, nothing newer
          dodoCustomerId: "cus_not_newer",
          rawPayload: {},
        },
      },
    );

    expect(result).toEqual({ kind: "skipped", reason: "remote_not_newer" });
  });

  test("mutation refuses to clobber a concurrently-updated row (ordering guard)", async () => {
    const t = convexTest(schema, modules);
    // A subscription.plan_changed webhook landed AFTER the cron's stale read:
    // it patched planKey → enterprise and bumped updatedAt past observedAt, but
    // left currentPeriodEnd stale. The cron holds a stale snapshot and must not
    // overwrite the newer plan.
    const subId = await seedStaleActiveForReconcile(t, {
      suffix: "concurrent",
      planKey: "enterprise",
      dodoProductId: PRODUCT_CATALOG.enterprise.dodoProductId!,
      currentPeriodEnd: NOW - DAY_MS,
      updatedAt: NOW + DAY_MS, // newer than observedAt
      seedEntitlement: false,
    });
    // Map the REMOTE product id to pro_monthly so that IF the ordering guard
    // were removed, apply would fall through and resolvePlanKey would clobber
    // planKey enterprise -> pro_monthly. This makes the planKey assertion
    // below load-bearing (proves no-clobber) instead of coincidentally passing
    // via the unknown-product enterprise fallback.
    await t.run(async (ctx) => {
      await ctx.db.insert("productPlans", {
        dodoProductId: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
        planKey: "pro_monthly",
        displayName: "Pro Monthly",
        isActive: true,
      });
    });

    const result = await t.mutation(
      internal.payments.billing.applyDodoSubscriptionReconciliation,
      {
        subscriptionId: subId,
        dodoSubscriptionId: "sub_concurrent",
        observedAt: NOW,
        remote: {
          dodoSubscriptionId: "sub_concurrent",
          productId: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
          status: "active",
          currentPeriodStart: NOW,
          currentPeriodEnd: NOW + 30 * DAY_MS,
          rawPayload: {},
        },
      },
    );

    expect(result).toEqual({ kind: "skipped", reason: "local_updated_concurrently" });

    const sub = await readSub(t, "concurrent");
    expect(sub?.planKey).toBe("enterprise"); // not clobbered to pro_monthly
    expect(sub?.dodoProductId).toBe(PRODUCT_CATALOG.enterprise.dodoProductId);
    expect(sub?.updatedAt).toBe(NOW + DAY_MS);
  });

  test("does not let a permanently-failing row starve a healthy row sorted behind it", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const poisonPeriodEnd = NOW - 3 * DAY_MS; // stalest → sorts FIRST in the scan
    const healthyStaleEnd = NOW - DAY_MS;
    const healthyRenewedEnd = NOW + 30 * DAY_MS;

    await t.run(async (ctx) => {
      await ctx.db.insert("subscriptions", {
        userId: "user_poison",
        dodoSubscriptionId: "sub_poison",
        dodoProductId: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
        planKey: "pro_monthly",
        status: "active",
        currentPeriodStart: NOW - 33 * DAY_MS,
        currentPeriodEnd: poisonPeriodEnd,
        rawPayload: { subscription_id: "sub_poison" },
        updatedAt: NOW - DAY_MS,
      });
      await ctx.db.insert("subscriptions", {
        userId: "user_healthy",
        dodoSubscriptionId: "sub_healthy",
        dodoProductId: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
        planKey: "pro_monthly",
        status: "active",
        currentPeriodStart: NOW - 31 * DAY_MS,
        currentPeriodEnd: healthyStaleEnd,
        rawPayload: { subscription_id: "sub_healthy" },
        updatedAt: NOW - DAY_MS,
      });
      await ctx.db.insert("entitlements", {
        userId: "user_healthy",
        planKey: "pro_monthly",
        features: getFeaturesForPlan("pro_monthly"),
        validUntil: healthyStaleEnd,
        updatedAt: NOW - DAY_MS,
      });
    });

    // limit 1 forces the poison row (sorted first) to consume the only batch
    // slot on the first invocation; a continuation must reach the healthy row.
    const summary = await t.action(
      internal.payments.billing.reconcileMissedDodoRenewals,
      {
        now: NOW,
        limit: 1,
        remoteSubscriptionsForTest: [
          {
            subscription_id: "sub_healthy",
            product_id: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
            status: "active",
            previous_billing_date: new Date(NOW).toISOString(),
            next_billing_date: new Date(healthyRenewedEnd).toISOString(),
          },
        ],
      },
    );

    expect(summary).toMatchObject({
      inspected: 1,
      failed: 1,
      reconciled: 0,
      hasMore: true,
      continuationScheduled: true,
    });

    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const poison = await readSub(t, "poison");
    const healthy = await readSub(t, "healthy");
    const healthyEnt = await readEntitlement(t, "user_healthy");

    // Poison row was backed off (marked), not reconciled.
    expect(poison?.status).toBe("active");
    expect(poison?.currentPeriodEnd).toBe(poisonPeriodEnd);
    expect(poison?.reconcileFailureCount).toBe(1);
    expect(poison?.lastReconcileAttemptAt).toBe(NOW);

    // Healthy row sorted behind it still reconciled within the same cron cycle.
    expect(healthy?.currentPeriodEnd).toBe(healthyRenewedEnd);
    expect(healthy?.reconcileFailureCount).toBeUndefined();
    expect(healthyEnt?.validUntil).toBe(healthyRenewedEnd);

    vi.useRealTimers();
  });

  test("drains a backlog larger than the per-invocation batch across continuations", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const renewedEnd = NOW + 30 * DAY_MS;
    const suffixes = ["drain_a", "drain_b", "drain_c"];

    await t.run(async (ctx) => {
      let i = 0;
      for (const suffix of suffixes) {
        await ctx.db.insert("subscriptions", {
          userId: `user_${suffix}`,
          dodoSubscriptionId: `sub_${suffix}`,
          dodoProductId: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
          planKey: "pro_monthly",
          status: "active",
          currentPeriodStart: NOW - 31 * DAY_MS,
          currentPeriodEnd: NOW - (i + 1) * DAY_MS,
          rawPayload: { subscription_id: `sub_${suffix}` },
          updatedAt: NOW - 5 * DAY_MS,
        });
        i++;
      }
    });

    const summary = await t.action(
      internal.payments.billing.reconcileMissedDodoRenewals,
      {
        now: NOW,
        limit: 1,
        remoteSubscriptionsForTest: suffixes.map((suffix) => ({
          subscription_id: `sub_${suffix}`,
          product_id: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
          status: "active",
          previous_billing_date: new Date(NOW).toISOString(),
          next_billing_date: new Date(renewedEnd).toISOString(),
        })),
      },
    );

    expect(summary).toMatchObject({ reconciled: 1, hasMore: true, continuationScheduled: true });

    await t.finishAllScheduledFunctions(vi.runAllTimers);

    for (const suffix of suffixes) {
      const sub = await readSub(t, suffix);
      expect(sub?.currentPeriodEnd).toBe(renewedEnd);
    }

    vi.useRealTimers();
  });

  test("backs a failed row off within the cycle but retries it at the next daily run", async () => {
    const t = convexTest(schema, modules);
    await seedStaleActiveForReconcile(t, {
      suffix: "backoff",
      currentPeriodEnd: NOW - DAY_MS,
      seedEntitlement: false,
    });

    // Invocation 1: no remote for this sub -> Dodo lookup fails -> row is
    // marked (reconcileFailureCount 1, short first-failure backoff).
    const s1 = await t.action(internal.payments.billing.reconcileMissedDodoRenewals, {
      now: NOW,
      remoteSubscriptionsForTest: [],
    });
    expect(s1).toMatchObject({ inspected: 1, failed: 1, reconciled: 0 });
    let sub = await readSub(t, "backoff");
    expect(sub?.reconcileFailureCount).toBe(1);
    expect(sub?.lastReconcileAttemptAt).toBe(NOW);

    // A few minutes later (same cron cycle): still inside the first-failure
    // backoff -> ineligible, never attempted, bookkeeping unchanged. This is
    // what stops a poison row hogging a slot across a cycle's continuations.
    const s2 = await t.action(internal.payments.billing.reconcileMissedDodoRenewals, {
      now: NOW + 5 * 60 * 1000,
      remoteSubscriptionsForTest: [],
    });
    expect(s2).toMatchObject({ inspected: 0, failed: 0, reconciled: 0 });
    sub = await readSub(t, "backoff");
    expect(sub?.reconcileFailureCount).toBe(1);
    expect(sub?.lastReconcileAttemptAt).toBe(NOW);

    // The NEXT daily run (>= 1 day later) is past the short first-failure
    // backoff -> eligible again -> re-attempted so a transient error is not
    // over-delayed. It fails again here, so the failure count climbs (and the
    // backoff now grows exponentially).
    const now3 = NOW + DAY_MS;
    const s3 = await t.action(internal.payments.billing.reconcileMissedDodoRenewals, {
      now: now3,
      remoteSubscriptionsForTest: [],
    });
    expect(s3).toMatchObject({ inspected: 1, failed: 1, reconciled: 0 });
    sub = await readSub(t, "backoff");
    expect(sub?.reconcileFailureCount).toBe(2);
    expect(sub?.lastReconcileAttemptAt).toBe(now3);

    // At failureCount 2 the exponential base (2 days) kicks in: NOT eligible the
    // next day...
    const s4 = await t.action(internal.payments.billing.reconcileMissedDodoRenewals, {
      now: now3 + DAY_MS,
      remoteSubscriptionsForTest: [],
    });
    expect(s4).toMatchObject({ inspected: 0, failed: 0, reconciled: 0 });
    sub = await readSub(t, "backoff");
    expect(sub?.reconcileFailureCount).toBe(2); // untouched

    // ...but eligible again once the 2-day window elapses.
    const now5 = now3 + 2 * DAY_MS;
    const s5 = await t.action(internal.payments.billing.reconcileMissedDodoRenewals, {
      now: now5,
      remoteSubscriptionsForTest: [],
    });
    expect(s5).toMatchObject({ inspected: 1, failed: 1, reconciled: 0 });
    sub = await readSub(t, "backoff");
    expect(sub?.reconcileFailureCount).toBe(3);
  });

  test("bails out of the batch when the wall-clock time budget is exhausted", async () => {
    const t = convexTest(schema, modules);
    await seedStaleActiveForReconcile(t, {
      suffix: "budget",
      currentPeriodEnd: NOW - DAY_MS,
      seedEntitlement: false,
    });

    // Each Date.now() call jumps forward by more than the 8-minute budget, so
    // the first in-loop budget check (relative to startedAtWallClock, an earlier
    // Date.now() call) trips before any row is attempted — robust to however
    // many internal Date.now() calls happen in between.
    let clock = 1_000_000;
    const step = 9 * 60 * 1000; // > DODO_RENEWAL_RECONCILIATION_TIME_BUDGET_MS
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => {
      const t0 = clock;
      clock += step;
      return t0;
    });

    let summary;
    try {
      summary = await t.action(internal.payments.billing.reconcileMissedDodoRenewals, {
        now: NOW,
        remoteSubscriptionsForTest: [
          {
            subscription_id: "sub_budget",
            product_id: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
            status: "active",
            previous_billing_date: new Date(NOW).toISOString(),
            next_billing_date: new Date(NOW + 30 * DAY_MS).toISOString(),
          },
        ],
      });
    } finally {
      nowSpy.mockRestore();
    }

    expect(summary).toMatchObject({
      inspected: 0, // bailed before attempting the row
      reconciled: 0,
      timeBudgetExhausted: true,
      hasMore: true,
      continuationScheduled: false, // attempted 0 -> no chain
    });

    // Row untouched (not reconciled).
    const sub = await readSub(t, "budget");
    expect(sub?.currentPeriodEnd).toBe(NOW - DAY_MS);
  });

  test("advances the scan cursor past a backoff-saturated window to reach healthy rows behind it", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const healthyRenewedEnd = NOW + 30 * DAY_MS;

    await t.run(async (ctx) => {
      // Poison row sorts FIRST (stalest) but is already backed off
      // (failureCount 3 -> 8-day backoff, last attempted 1 day ago), so it is
      // ineligible now and, with scanLimit 1, fully saturates the first window.
      await ctx.db.insert("subscriptions", {
        userId: "user_saturate_poison",
        dodoSubscriptionId: "sub_saturate_poison",
        dodoProductId: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
        planKey: "pro_monthly",
        status: "active",
        currentPeriodStart: NOW - 33 * DAY_MS,
        currentPeriodEnd: NOW - 3 * DAY_MS,
        rawPayload: { subscription_id: "sub_saturate_poison" },
        updatedAt: NOW - 5 * DAY_MS,
        lastReconcileAttemptAt: NOW - DAY_MS,
        reconcileFailureCount: 3,
      });
      // Healthy row sorts behind the poison window.
      await ctx.db.insert("subscriptions", {
        userId: "user_saturate_healthy",
        dodoSubscriptionId: "sub_saturate_healthy",
        dodoProductId: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
        planKey: "pro_monthly",
        status: "active",
        currentPeriodStart: NOW - 31 * DAY_MS,
        currentPeriodEnd: NOW - DAY_MS,
        rawPayload: { subscription_id: "sub_saturate_healthy" },
        updatedAt: NOW - 5 * DAY_MS,
      });
      await ctx.db.insert("entitlements", {
        userId: "user_saturate_healthy",
        planKey: "pro_monthly",
        features: getFeaturesForPlan("pro_monthly"),
        validUntil: NOW - DAY_MS,
        updatedAt: NOW - 5 * DAY_MS,
      });
    });

    // scanLimit 1 => the first window is exactly the (ineligible) poison row.
    const summary = await t.action(internal.payments.billing.reconcileMissedDodoRenewals, {
      now: NOW,
      scanLimit: 1,
      remoteSubscriptionsForTest: [
        {
          subscription_id: "sub_saturate_healthy",
          product_id: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
          status: "active",
          previous_billing_date: new Date(NOW).toISOString(),
          next_billing_date: new Date(healthyRenewedEnd).toISOString(),
        },
      ],
    });

    // First window was entirely backed off -> flagged saturated, and a
    // continuation was scheduled with an advanced cursor (attempted was 0).
    expect(summary).toMatchObject({
      inspected: 0,
      windowSaturated: true,
      hasMore: true,
      continuationScheduled: true,
    });

    await t.finishAllScheduledFunctions(vi.runAllTimers);

    // The healthy row behind the poison window was reconciled via the
    // cursor-advanced continuation; the poison row was left untouched.
    const poison = await readSub(t, "saturate_poison");
    const healthy = await readSub(t, "saturate_healthy");
    const healthyEnt = await readEntitlement(t, "user_saturate_healthy");
    expect(poison?.currentPeriodEnd).toBe(NOW - 3 * DAY_MS);
    expect(poison?.reconcileFailureCount).toBe(3); // untouched
    expect(healthy?.currentPeriodEnd).toBe(healthyRenewedEnd);
    expect(healthyEnt?.validUntil).toBe(healthyRenewedEnd);

    vi.useRealTimers();
  });

  test("downgrades to expired only after a CONFIRMED (repeated) Dodo not-found", async () => {
    const t = convexTest(schema, modules);
    await seedStaleActiveForReconcile(t, {
      suffix: "gone",
      currentPeriodEnd: NOW - DAY_MS,
      // entitlement seeded so we can prove the downgrade
    });

    // First 404: unconfirmed (reconcileFailureCount 0) -> treated as transient,
    // row stays active + backed off. A single flaky 404 must NOT downgrade.
    const s1 = await t.action(internal.payments.billing.reconcileMissedDodoRenewals, {
      now: NOW,
      errorInjectionForTest: { sub_gone: "not_found" },
    });
    expect(s1).toMatchObject({ inspected: 1, failed: 1, expiredMissing: 0, reconciled: 0 });
    let sub = await readSub(t, "gone");
    expect(sub?.status).toBe("active");
    expect(sub?.reconcileFailureCount).toBe(1);
    let ent = await readEntitlement(t, TEST_USER_ID);
    expect(ent?.planKey).toBe("pro_monthly"); // still entitled

    // Second 404 the next day: now confirmed (failureCount 1 >= threshold) ->
    // downgrade the local row to expired and recompute the entitlement.
    const s2 = await t.action(internal.payments.billing.reconcileMissedDodoRenewals, {
      now: NOW + DAY_MS,
      errorInjectionForTest: { sub_gone: "not_found" },
    });
    expect(s2).toMatchObject({ inspected: 1, expiredMissing: 1, failed: 0, reconciled: 0 });
    sub = await readSub(t, "gone");
    expect(sub?.status).toBe("expired");
    ent = await readEntitlement(t, TEST_USER_ID);
    expect(ent?.planKey).toBe("free"); // downgraded
  });

  test("keeps a subscription active and backed off on a transient 5xx (never downgrades)", async () => {
    const t = convexTest(schema, modules);
    await seedStaleActiveForReconcile(t, {
      suffix: "flaky",
      currentPeriodEnd: NOW - DAY_MS,
      seedEntitlement: false,
    });

    // Two consecutive 5xx errors across two daily runs: the row is backed off
    // both times but NEVER expired — a transient error must not downgrade even
    // once the failure count passes the not-found confirmation threshold.
    const s1 = await t.action(internal.payments.billing.reconcileMissedDodoRenewals, {
      now: NOW,
      errorInjectionForTest: { sub_flaky: "server_error" },
    });
    expect(s1).toMatchObject({ inspected: 1, failed: 1, expiredMissing: 0 });
    let sub = await readSub(t, "flaky");
    expect(sub?.status).toBe("active");
    expect(sub?.reconcileFailureCount).toBe(1);

    const s2 = await t.action(internal.payments.billing.reconcileMissedDodoRenewals, {
      now: NOW + DAY_MS,
      errorInjectionForTest: { sub_flaky: "server_error" },
    });
    expect(s2).toMatchObject({ inspected: 1, failed: 1, expiredMissing: 0 });
    sub = await readSub(t, "flaky");
    expect(sub?.status).toBe("active"); // still active, never downgraded on 5xx
    expect(sub?.reconcileFailureCount).toBe(2);
  });

  test("a single 404 after an unrelated prior failure does NOT downgrade (needs consecutive 404s)", async () => {
    const t = convexTest(schema, modules);
    // The row already has a prior NON-404 failure (a 5xx yesterday): failureCount
    // 1 but the consecutive-404 streak (reconcileNotFoundCount) is 0.
    await t.run(async (ctx) => {
      await ctx.db.insert("subscriptions", {
        userId: TEST_USER_ID,
        dodoSubscriptionId: "sub_mixed",
        dodoProductId: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
        planKey: "pro_monthly",
        status: "active",
        currentPeriodStart: NOW - 31 * DAY_MS,
        currentPeriodEnd: NOW - DAY_MS,
        rawPayload: { subscription_id: "sub_mixed" },
        updatedAt: NOW - 5 * DAY_MS,
        lastReconcileAttemptAt: NOW - DAY_MS,
        reconcileFailureCount: 1,
        reconcileNotFoundCount: 0,
      });
    });

    // First 404: because the prior failure was NOT a 404, the streak is still 0
    // -> must be treated as unconfirmed (no downgrade), even though failureCount
    // already >= 1. This is the fix for conflating 404s with other failures.
    const s1 = await t.action(internal.payments.billing.reconcileMissedDodoRenewals, {
      now: NOW,
      errorInjectionForTest: { sub_mixed: "not_found" },
    });
    expect(s1).toMatchObject({ inspected: 1, failed: 1, expiredMissing: 0 });
    let sub = await readSub(t, "mixed");
    expect(sub?.status).toBe("active");
    expect(sub?.reconcileNotFoundCount).toBe(1); // streak now started

    // Second consecutive 404 -> confirmed -> downgrade. (failureCount is now 2,
    // so wait past the 2-day backoff before the row is eligible again.)
    const s2 = await t.action(internal.payments.billing.reconcileMissedDodoRenewals, {
      now: NOW + 3 * DAY_MS,
      errorInjectionForTest: { sub_mixed: "not_found" },
    });
    expect(s2).toMatchObject({ inspected: 1, expiredMissing: 1 });
    sub = await readSub(t, "mixed");
    expect(sub?.status).toBe("expired");
  });

  test("mass-404 circuit breaker caps downgrades per run and halts the rest", async () => {
    const t = convexTest(schema, modules);
    const N = 10;
    // All 10 rows are already confirmed (reconcileNotFoundCount 1) and eligible,
    // so every one is a confirmed-404 downgrade candidate this run — the shape a
    // wrong-environment misconfig would produce.
    await t.run(async (ctx) => {
      for (let i = 0; i < N; i++) {
        await ctx.db.insert("subscriptions", {
          userId: `user_mass_${i}`,
          dodoSubscriptionId: `sub_mass_${i}`,
          dodoProductId: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
          planKey: "pro_monthly",
          status: "active",
          currentPeriodStart: NOW - 31 * DAY_MS,
          currentPeriodEnd: NOW - (i + 1) * DAY_MS,
          rawPayload: { subscription_id: `sub_mass_${i}` },
          updatedAt: NOW - 10 * DAY_MS,
          lastReconcileAttemptAt: NOW - 10 * DAY_MS,
          reconcileFailureCount: 1,
          reconcileNotFoundCount: 1,
        });
      }
    });

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const summary = await t.action(internal.payments.billing.reconcileMissedDodoRenewals, {
      now: NOW,
      errorInjectionForTest: Object.fromEntries(
        Array.from({ length: N }, (_, i) => [`sub_mass_${i}`, "not_found" as const]),
      ),
    });

    // Threshold = min(5, ceil(min(limit, eligible)/2)) = min(5, ceil(10/2)) = 5.
    expect(summary.expiredMissing).toBe(5);
    expect(summary.inspected).toBe(N);
    // The 5 halted rows are routed to the backoff (failed) path.
    expect(summary.failed).toBe(N - 5);

    const statuses = await t.run(async (ctx) => {
      const rows = await Promise.all(
        Array.from({ length: N }, (_, i) =>
          ctx.db
            .query("subscriptions")
            .withIndex("by_dodoSubscriptionId", (q) =>
              q.eq("dodoSubscriptionId", `sub_mass_${i}`),
            )
            .unique(),
        ),
      );
      return rows.map((r) => r?.status);
    });
    expect(statuses.filter((s) => s === "expired").length).toBe(5);
    expect(statuses.filter((s) => s === "active").length).toBe(5);

    // The mass-404 alert fired.
    const massLogged = errorSpy.mock.calls.some((c) =>
      String(c[0]).includes("mass Dodo 404s"),
    );
    expect(massLogged).toBe(true);
    errorSpy.mockRestore();
  });

  test("mass-404 breaker is per cron cycle: halt latches across continuations", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const N = 12;
    await t.run(async (ctx) => {
      for (let i = 0; i < N; i++) {
        await ctx.db.insert("subscriptions", {
          userId: `user_cycle_${i}`,
          dodoSubscriptionId: `sub_cycle_${i}`,
          dodoProductId: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
          planKey: "pro_monthly",
          status: "active",
          currentPeriodStart: NOW - 31 * DAY_MS,
          currentPeriodEnd: NOW - (i + 1) * DAY_MS,
          rawPayload: { subscription_id: `sub_cycle_${i}` },
          updatedAt: NOW - 10 * DAY_MS,
          lastReconcileAttemptAt: NOW - 10 * DAY_MS,
          reconcileFailureCount: 1,
          reconcileNotFoundCount: 1,
        });
      }
    });

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // limit 3 -> the per-invocation majority cap is ceil(3/2)=2, so the FIRST
    // invocation downgrades 2 then latches the halt. If the breaker state did NOT
    // thread through continuations, each of the ~4 continuations would downgrade
    // another 2 (~8 total). With per-cycle threading, the whole cycle stops at 2.
    await t.action(internal.payments.billing.reconcileMissedDodoRenewals, {
      now: NOW,
      limit: 3,
      errorInjectionForTest: Object.fromEntries(
        Array.from({ length: N }, (_, i) => [`sub_cycle_${i}`, "not_found" as const]),
      ),
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    errorSpy.mockRestore();

    const statuses = await t.run(async (ctx) => {
      const rows = await Promise.all(
        Array.from({ length: N }, (_, i) =>
          ctx.db
            .query("subscriptions")
            .withIndex("by_dodoSubscriptionId", (q) =>
              q.eq("dodoSubscriptionId", `sub_cycle_${i}`),
            )
            .unique(),
        ),
      );
      return rows.map((r) => r?.status);
    });
    // At most the absolute per-cycle cap, and specifically 2 here (majority cap
    // latched in invocation 1). NOT 2-per-continuation.
    const expiredCount = statuses.filter((s) => s === "expired").length;
    expect(expiredCount).toBe(2);
    expect(statuses.filter((s) => s === "active").length).toBe(N - 2);

    vi.useRealTimers();
  });

  test("safeMarkReconcileAttempt swallows a throwing bookkeeping mutation", async () => {
    // Reliability P1-1: a failed best-effort backoff write must never propagate
    // out of the per-row loop (which would abort the batch AND skip continuation
    // scheduling). A fake ctx whose runMutation throws must resolve, not reject.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const throwingCtx = {
      runMutation: async () => {
        throw new Error("simulated OCC write conflict");
      },
    };
    await expect(
      safeMarkReconcileAttempt(
        throwingCtx as never,
        "sub_placeholder" as never,
        NOW,
        false,
      ),
    ).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  describe("on-demand renewal verification", () => {
    test("restores premium access immediately when Dodo reports a future active period", async () => {
      const t = convexTest(schema, modules);
      const renewedEnd = NOW + 30 * DAY_MS;
      await seedStaleActiveForReconcile(t, { suffix: "on_demand_active" });

      const result = await t.action(
        internal.payments.billing.verifyRecentlyStaleSubscriptionOnDemand,
        {
          userId: TEST_USER_ID,
          now: NOW,
          remoteSubscriptionsForTest: [
            {
              subscription_id: "sub_on_demand_active",
              product_id: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
              status: "active",
              previous_billing_date: new Date(NOW).toISOString(),
              next_billing_date: new Date(renewedEnd).toISOString(),
            },
          ],
        },
      );

      expect(result).toEqual({ status: "active" });
      expect((await readSub(t, "on_demand_active"))?.currentPeriodEnd).toBe(renewedEnd);
      expect((await readEntitlement(t, TEST_USER_ID))?.validUntil).toBe(renewedEnd);
    });

    test("corrects an inactive remote subscription and reports a confirmed lapse", async () => {
      const t = convexTest(schema, modules);
      const staleEnd = NOW - DAY_MS;
      await seedStaleActiveForReconcile(t, {
        suffix: "on_demand_expired",
        currentPeriodEnd: staleEnd,
      });

      const result = await t.action(
        internal.payments.billing.verifyRecentlyStaleSubscriptionOnDemand,
        {
          userId: TEST_USER_ID,
          now: NOW,
          remoteSubscriptionsForTest: [
            {
              subscription_id: "sub_on_demand_expired",
              product_id: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
              status: "expired",
              previous_billing_date: new Date(NOW - 31 * DAY_MS).toISOString(),
              next_billing_date: new Date(staleEnd).toISOString(),
            },
          ],
        },
      );

      expect(result).toEqual({ status: "subscription_lapsed" });
      expect((await readSub(t, "on_demand_expired"))?.status).toBe("expired");
      expect((await readEntitlement(t, TEST_USER_ID))?.planKey).toBe("free");
    });

    test("threads a sibling's failed cooldown into the resolution-stage Retry-After", async () => {
      const t = convexTest(schema, modules);
      const staleEnd = NOW - DAY_MS;
      const strongerId = await seedStaleActiveForReconcile(t, {
        suffix: "on_demand_sibling_failed_stronger",
        planKey: "enterprise",
        dodoProductId: PRODUCT_CATALOG.enterprise.dodoProductId!,
        currentPeriodEnd: staleEnd,
      });
      await seedStaleActiveForReconcile(t, {
        suffix: "on_demand_sibling_failed_weaker",
        currentPeriodEnd: staleEnd,
        seedEntitlement: false,
      });
      // The stronger sibling is 20s into its 60s failed cooldown, so the claim
      // skips it and verifies the weaker row.
      await t.run(async (ctx) => {
        await ctx.db.patch(strongerId, {
          renewalVerificationState: "failed",
          renewalVerificationAttemptAt: NOW - 20_000,
        });
      });

      const result = await t.action(
        internal.payments.billing.verifyRecentlyStaleSubscriptionOnDemand,
        {
          userId: TEST_USER_ID,
          now: NOW,
          remoteSubscriptionsForTest: [
            {
              subscription_id: "sub_on_demand_sibling_failed_weaker",
              product_id: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
              status: "expired",
              previous_billing_date: new Date(NOW - 31 * DAY_MS).toISOString(),
              next_billing_date: new Date(staleEnd).toISOString(),
            },
          ],
        },
      );

      // The resolution stage must quote the SIBLING's remaining failed
      // cooldown (60s - 20s elapsed = 40s), not the fixed 1s progress retry
      // the neighboring 'unresolved' branch returns.
      expect(result).toEqual({
        status: "renewal_verification_failed",
        retryAfterSeconds: 40,
      });
      expect((await readSub(t, "on_demand_sibling_failed_weaker"))?.status).toBe("expired");
    });

    test("getOnDemandRenewalResolution reports a live sibling lease as pending", async () => {
      const t = convexTest(schema, modules);
      const staleEnd = NOW - DAY_MS;
      const rowId = await seedStaleActiveForReconcile(t, {
        suffix: "on_demand_resolution_pending",
        currentPeriodEnd: staleEnd,
      });
      await t.run(async (ctx) => {
        await ctx.db.patch(rowId, {
          renewalVerificationState: "pending",
          renewalVerificationAttemptAt: NOW - 1_000,
        });
      });

      const resolution = await t.query(
        internal.payments.billing.getOnDemandRenewalResolution,
        { userId: TEST_USER_ID, now: NOW },
      );

      // Reachable only when a sibling lease starts between this request's
      // claim and its resolution read; the guard must quote the leader's
      // expected completion (3s - 1s elapsed = 2s), not lapsed/unresolved.
      expect(resolution).toEqual({ kind: "pending", retryAfterSeconds: 2 });
    });

    test("does not report a user-level lapse until every recently-stale subscription is resolved", async () => {
      const t = convexTest(schema, modules);
      const staleEnd = NOW - DAY_MS;
      const renewedEnd = NOW + 30 * DAY_MS;
      await seedStaleActiveForReconcile(t, {
        suffix: "on_demand_stronger_lapsed",
        planKey: "enterprise",
        dodoProductId: PRODUCT_CATALOG.enterprise.dodoProductId!,
        currentPeriodEnd: staleEnd,
      });
      await seedStaleActiveForReconcile(t, {
        suffix: "on_demand_weaker_renewed",
        planKey: "pro_monthly",
        dodoProductId: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
        currentPeriodEnd: staleEnd,
        seedEntitlement: false,
      });

      const strongerResult = await t.action(
        internal.payments.billing.verifyRecentlyStaleSubscriptionOnDemand,
        {
          userId: TEST_USER_ID,
          now: NOW,
          remoteSubscriptionsForTest: [
            {
              subscription_id: "sub_on_demand_stronger_lapsed",
              product_id: PRODUCT_CATALOG.enterprise.dodoProductId!,
              status: "expired",
              previous_billing_date: new Date(NOW - 31 * DAY_MS).toISOString(),
              next_billing_date: new Date(staleEnd).toISOString(),
            },
          ],
        },
      );

      expect(strongerResult).toEqual({
        status: "renewal_verification_pending",
        retryAfterSeconds: 1,
      });
      expect((await readSub(t, "on_demand_stronger_lapsed"))?.status).toBe("expired");

      const weakerResult = await t.action(
        internal.payments.billing.verifyRecentlyStaleSubscriptionOnDemand,
        {
          userId: TEST_USER_ID,
          now: NOW + 1,
          remoteSubscriptionsForTest: [
            {
              subscription_id: "sub_on_demand_weaker_renewed",
              product_id: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
              status: "active",
              previous_billing_date: new Date(NOW).toISOString(),
              next_billing_date: new Date(renewedEnd).toISOString(),
            },
          ],
        },
      );

      expect(weakerResult).toEqual({ status: "active" });
      expect((await readSub(t, "on_demand_weaker_renewed"))?.currentPeriodEnd).toBe(renewedEnd);
      expect((await readEntitlement(t, TEST_USER_ID))?.validUntil).toBe(renewedEnd);
    });

    test("treats an unchanged active provider period as verification uncertainty", async () => {
      const t = convexTest(schema, modules);
      const staleEnd = NOW - DAY_MS;
      await seedStaleActiveForReconcile(t, {
        suffix: "on_demand_active_unchanged",
        currentPeriodEnd: staleEnd,
      });
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const result = await t.action(
        internal.payments.billing.verifyRecentlyStaleSubscriptionOnDemand,
        {
          userId: TEST_USER_ID,
          now: NOW,
          remoteSubscriptionsForTest: [
            {
              subscription_id: "sub_on_demand_active_unchanged",
              product_id: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
              status: "active",
              previous_billing_date: new Date(NOW - 31 * DAY_MS).toISOString(),
              next_billing_date: new Date(staleEnd).toISOString(),
            },
          ],
          // The first failed-state finalization throws; the bounded best-effort
          // retry must contain it and durably leave this row in failed cooldown.
          convexFailureInjectionForTest: "finalize",
        },
      );

      expect(result).toEqual({
        status: "renewal_verification_failed",
        retryAfterSeconds: 60,
      });
      expect((await readSub(t, "on_demand_active_unchanged"))?.renewalVerificationState).toBe("failed");
      errorSpy.mockRestore();
    });

    test("treats a newer but still-past active provider period as verification uncertainty", async () => {
      const t = convexTest(schema, modules);
      const staleEnd = NOW - 2 * DAY_MS;
      const stillPastEnd = NOW - DAY_MS;
      await seedStaleActiveForReconcile(t, {
        suffix: "on_demand_active_still_past",
        currentPeriodEnd: staleEnd,
      });

      const result = await t.action(
        internal.payments.billing.verifyRecentlyStaleSubscriptionOnDemand,
        {
          userId: TEST_USER_ID,
          now: NOW,
          remoteSubscriptionsForTest: [
            {
              subscription_id: "sub_on_demand_active_still_past",
              product_id: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
              status: "active",
              previous_billing_date: new Date(NOW - 31 * DAY_MS).toISOString(),
              next_billing_date: new Date(stillPastEnd).toISOString(),
            },
          ],
        },
      );

      expect(result).toEqual({
        status: "renewal_verification_failed",
        retryAfterSeconds: 60,
      });
      expect((await readSub(t, "on_demand_active_still_past"))?.currentPeriodEnd).toBe(stillPastEnd);
      expect((await readSub(t, "on_demand_active_still_past"))?.renewalVerificationState).toBe("failed");
    });

    test("contains a post-reconcile Convex query failure and returns a retryable result", async () => {
      const t = convexTest(schema, modules);
      const staleEnd = NOW - DAY_MS;
      await seedStaleActiveForReconcile(t, {
        suffix: "on_demand_post_query_failure",
        currentPeriodEnd: staleEnd,
      });
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const result = await t.action(
        internal.payments.billing.verifyRecentlyStaleSubscriptionOnDemand,
        {
          userId: TEST_USER_ID,
          now: NOW,
          remoteSubscriptionsForTest: [
            {
              subscription_id: "sub_on_demand_post_query_failure",
              product_id: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
              status: "expired",
              previous_billing_date: new Date(NOW - 31 * DAY_MS).toISOString(),
              next_billing_date: new Date(staleEnd).toISOString(),
            },
          ],
          convexFailureInjectionForTest: "post_reconcile_query",
        },
      );

      expect(result).toEqual({
        status: "renewal_verification_failed",
        retryAfterSeconds: 60,
      });
      expect((await readSub(t, "on_demand_post_query_failure"))?.status).toBe("expired");
      errorSpy.mockRestore();
    });

    test("contains a finalize failure and preserves a confirmed active result", async () => {
      const t = convexTest(schema, modules);
      const renewedEnd = NOW + 30 * DAY_MS;
      await seedStaleActiveForReconcile(t, { suffix: "on_demand_finalize_failure" });
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const result = await t.action(
        internal.payments.billing.verifyRecentlyStaleSubscriptionOnDemand,
        {
          userId: TEST_USER_ID,
          now: NOW,
          remoteSubscriptionsForTest: [
            {
              subscription_id: "sub_on_demand_finalize_failure",
              product_id: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
              status: "active",
              previous_billing_date: new Date(NOW).toISOString(),
              next_billing_date: new Date(renewedEnd).toISOString(),
            },
          ],
          convexFailureInjectionForTest: "finalize",
        },
      );

      expect(result).toEqual({ status: "active" });
      expect((await readEntitlement(t, TEST_USER_ID))?.validUntil).toBe(renewedEnd);
      errorSpy.mockRestore();
    });

    test("surfaces Dodo failure and throttles an immediate retry", async () => {
      const t = convexTest(schema, modules);
      await seedStaleActiveForReconcile(t, { suffix: "on_demand_failure" });
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const first = await t.action(
        internal.payments.billing.verifyRecentlyStaleSubscriptionOnDemand,
        {
          userId: TEST_USER_ID,
          now: NOW,
          remoteSubscriptionsForTest: [],
        },
      );
      const second = await t.action(
        internal.payments.billing.verifyRecentlyStaleSubscriptionOnDemand,
        {
          userId: TEST_USER_ID,
          now: NOW + 1_000,
          remoteSubscriptionsForTest: [
            {
              subscription_id: "sub_on_demand_failure",
              product_id: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
              status: "active",
              previous_billing_date: new Date(NOW).toISOString(),
              next_billing_date: new Date(NOW + 30 * DAY_MS).toISOString(),
            },
          ],
        },
      );

      expect(first).toMatchObject({ status: "renewal_verification_failed" });
      expect(second).toMatchObject({
        status: "renewal_verification_failed",
        retryAfterSeconds: expect.any(Number),
      });
      expect((await readSub(t, "on_demand_failure"))?.currentPeriodEnd).toBe(NOW - DAY_MS);
      errorSpy.mockRestore();
    });

    test("on-demand Dodo failure does not inflate the cron's reconcile backoff", async () => {
      const t = convexTest(schema, modules);
      const subId = await seedStaleActiveForReconcile(t, { suffix: "on_demand_no_backoff" });
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const result = await t.action(
        internal.payments.billing.verifyRecentlyStaleSubscriptionOnDemand,
        {
          userId: TEST_USER_ID,
          now: NOW,
          remoteSubscriptionsForTest: [],
          errorInjectionForTest: { sub_on_demand_no_backoff: "server_error" },
        },
      );

      expect(result).toMatchObject({ status: "renewal_verification_failed" });
      // The request path owns its own cooldown (renewalVerificationState); the
      // cron's backoff pair must stay untouched, or a customer retrying through
      // a Dodo blip (one attempt per 60s cooldown) defers the nightly safety
      // net toward the 30-day backoff cap.
      const row = await t.run((ctx) => ctx.db.get(subId));
      expect(row?.reconcileFailureCount).toBeUndefined();
      expect(row?.lastReconcileAttemptAt).toBeUndefined();
      expect(row?.renewalVerificationState).toBe("failed");
      errorSpy.mockRestore();
    });

    test("on-demand definitive 404 advances the terminal not-found streak without backoff", async () => {
      const t = convexTest(schema, modules);
      const subId = await seedStaleActiveForReconcile(t, { suffix: "on_demand_streak" });
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const result = await t.action(
        internal.payments.billing.verifyRecentlyStaleSubscriptionOnDemand,
        {
          userId: TEST_USER_ID,
          now: NOW,
          remoteSubscriptionsForTest: [],
          errorInjectionForTest: { sub_on_demand_streak: "not_found" },
        },
      );

      expect(result).toMatchObject({ status: "renewal_verification_failed" });
      // A definitive 404 is provider evidence regardless of which path saw it:
      // it must advance reconcileNotFoundCount (the consecutive-404 streak
      // gating the terminal "deleted in Dodo" downgrade) while leaving the
      // cron-only backoff pair alone.
      const row = await t.run((ctx) => ctx.db.get(subId));
      expect(row?.reconcileNotFoundCount).toBe(1);
      expect(row?.reconcileFailureCount).toBeUndefined();
      expect(row?.lastReconcileAttemptAt).toBeUndefined();
      errorSpy.mockRestore();
    });

    test.each(["failed", "lapsed"] as const)(
      "progresses past a stronger subscription in the %s cooldown",
      async (verificationState) => {
        const t = convexTest(schema, modules);
        const strongerId = await seedStaleActiveForReconcile(t, {
          suffix: `on_demand_${verificationState}_stronger`,
          planKey: "enterprise",
          dodoProductId: PRODUCT_CATALOG.enterprise.dodoProductId!,
        });
        const weakerId = await seedStaleActiveForReconcile(t, {
          suffix: `on_demand_${verificationState}_weaker`,
          planKey: "pro_monthly",
          dodoProductId: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
          seedEntitlement: false,
        });
        await t.run(async (ctx) => {
          await ctx.db.patch(strongerId, {
            renewalVerificationState: verificationState,
            renewalVerificationAttemptAt: NOW,
          });
        });

        const claim = await t.mutation(
          internal.payments.billing.claimRecentlyStaleSubscriptionForVerification,
          { userId: TEST_USER_ID, now: NOW + 1_000 },
        );

        expect(claim.kind).toBe("claimed");
        if (claim.kind === "claimed") {
          expect(claim.subscription._id).toBe(weakerId);
        }
      },
    );

    test("coalesces at the user level when a different stale subscription is pending", async () => {
      const t = convexTest(schema, modules);
      const strongerId = await seedStaleActiveForReconcile(t, {
        suffix: "on_demand_pending_stronger",
        planKey: "enterprise",
        dodoProductId: PRODUCT_CATALOG.enterprise.dodoProductId!,
      });
      const weakerId = await seedStaleActiveForReconcile(t, {
        suffix: "on_demand_pending_weaker",
        planKey: "pro_monthly",
        dodoProductId: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
        seedEntitlement: false,
      });
      await t.run(async (ctx) => {
        await ctx.db.patch(weakerId, {
          renewalVerificationState: "pending",
          renewalVerificationAttemptAt: NOW,
        });
      });

      const claim = await t.mutation(
        internal.payments.billing.claimRecentlyStaleSubscriptionForVerification,
        { userId: TEST_USER_ID, now: NOW + 1_000 },
      );

      expect(claim).toEqual({ kind: "pending", retryAfterSeconds: 2 });
      expect((await t.run((ctx) => ctx.db.get(strongerId)))?.renewalVerificationState).toBeUndefined();
    });

    test("atomically coalesces concurrent claims for the same stale subscription", async () => {
      const t = convexTest(schema, modules);
      await seedStaleActiveForReconcile(t, { suffix: "on_demand_coalesce" });

      const claims = await Promise.all([
        t.mutation(
          internal.payments.billing.claimRecentlyStaleSubscriptionForVerification,
          { userId: TEST_USER_ID, now: NOW },
        ),
        t.mutation(
          internal.payments.billing.claimRecentlyStaleSubscriptionForVerification,
          { userId: TEST_USER_ID, now: NOW },
        ),
      ]);

      expect(claims.map((claim) => claim.kind).sort()).toEqual(["claimed", "pending"]);
    });

    test("does not call Dodo for an active row outside the recent-staleness window", async () => {
      const t = convexTest(schema, modules);
      await seedStaleActiveForReconcile(t, {
        suffix: "on_demand_old",
        currentPeriodEnd: NOW - 4 * DAY_MS,
      });

      const result = await t.action(
        internal.payments.billing.verifyRecentlyStaleSubscriptionOnDemand,
        {
          userId: TEST_USER_ID,
          now: NOW,
          remoteSubscriptionsForTest: [
            {
              subscription_id: "sub_on_demand_old",
              product_id: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
              status: "active",
              previous_billing_date: new Date(NOW).toISOString(),
              next_billing_date: new Date(NOW + 30 * DAY_MS).toISOString(),
            },
          ],
        },
      );

      expect(result).toEqual({ status: "subscription_lapsed" });
      expect((await readSub(t, "on_demand_old"))?.currentPeriodEnd).toBe(NOW - 4 * DAY_MS);
    });

    test("rejects test-injection args outside NODE_ENV=test", async () => {
      const t = convexTest(schema, modules);
      vi.stubEnv("NODE_ENV", "production");
      try {
        await expect(
          t.action(internal.payments.billing.verifyRecentlyStaleSubscriptionOnDemand, {
            userId: TEST_USER_ID,
            now: NOW,
            remoteSubscriptionsForTest: [],
          }),
        ).rejects.toThrow(/test injection args are only allowed under test/);
      } finally {
        vi.unstubAllEnvs();
      }
    });

    test("returns active via post-reconcile resolution when another subscription already covers", async () => {
      const t = convexTest(schema, modules);
      const staleEnd = NOW - DAY_MS;
      const coveredEnd = NOW + 20 * DAY_MS;
      await seedStaleActiveForReconcile(t, {
        suffix: "on_demand_resolution_expired",
        currentPeriodEnd: staleEnd,
        seedEntitlement: false,
      });
      await seedStaleActiveForReconcile(t, {
        suffix: "on_demand_resolution_cover",
        planKey: "enterprise",
        dodoProductId: PRODUCT_CATALOG.enterprise.dodoProductId!,
        currentPeriodEnd: coveredEnd,
      });

      const result = await t.action(
        internal.payments.billing.verifyRecentlyStaleSubscriptionOnDemand,
        {
          userId: TEST_USER_ID,
          now: NOW,
          remoteSubscriptionsForTest: [
            {
              subscription_id: "sub_on_demand_resolution_expired",
              product_id: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
              status: "expired",
              previous_billing_date: new Date(NOW - 31 * DAY_MS).toISOString(),
              next_billing_date: new Date(staleEnd).toISOString(),
            },
          ],
        },
      );

      // The claimed row is confirmed non-covering, so this "active" must come
      // from the post-reconcile resolution read of the covering subscription,
      // not the outcomeConfirmsCoveringPeriod short-circuit.
      expect(result).toEqual({ status: "active" });
      expect((await readSub(t, "on_demand_resolution_expired"))?.status).toBe("expired");
      expect((await readEntitlement(t, TEST_USER_ID))?.validUntil).toBe(coveredEnd);
    });

    test("serves the lapsed cooldown without a provider call when every stale row is lapsed", async () => {
      const t = convexTest(schema, modules);
      const subId = await seedStaleActiveForReconcile(t, { suffix: "on_demand_lapsed_cooldown" });
      await t.run(async (ctx) => {
        await ctx.db.patch(subId, {
          renewalVerificationState: "lapsed",
          renewalVerificationAttemptAt: NOW,
        });
      });

      const result = await t.action(
        internal.payments.billing.verifyRecentlyStaleSubscriptionOnDemand,
        {
          userId: TEST_USER_ID,
          now: NOW + 1_000,
          remoteSubscriptionsForTest: [
            {
              subscription_id: "sub_on_demand_lapsed_cooldown",
              product_id: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
              status: "active",
              previous_billing_date: new Date(NOW).toISOString(),
              next_billing_date: new Date(NOW + 30 * DAY_MS).toISOString(),
            },
          ],
        },
      );

      // The remote payload reports a covering renewal; a cooldown-honoring
      // claim never consults it, so the row must stay stale and lapsed.
      expect(result).toEqual({ status: "subscription_lapsed" });
      expect((await readSub(t, "on_demand_lapsed_cooldown"))?.currentPeriodEnd).toBe(NOW - DAY_MS);
      expect((await readSub(t, "on_demand_lapsed_cooldown"))?.renewalVerificationState).toBe("lapsed");
    });

    test("finalize is a no-op when a newer claim superseded the caller's lease", async () => {
      const t = convexTest(schema, modules);
      const subId = await seedStaleActiveForReconcile(t, { suffix: "on_demand_stale_finalize" });
      const claim = await t.mutation(
        internal.payments.billing.claimRecentlyStaleSubscriptionForVerification,
        { userId: TEST_USER_ID, now: NOW },
      );
      expect(claim.kind).toBe("claimed");

      // A newer claim supersedes the original lease (fresh attempt timestamp);
      // the original owner's finalize must not clobber it.
      await t.run(async (ctx) => {
        await ctx.db.patch(subId, { renewalVerificationAttemptAt: NOW + 20_000 });
      });
      await t.mutation(
        internal.payments.billing.finalizeRecentlyStaleSubscriptionVerification,
        { subscriptionId: subId, claimedAt: NOW, status: "lapsed" },
      );

      const row = await readSub(t, "on_demand_stale_finalize");
      expect(row?.renewalVerificationState).toBe("pending");
      expect(row?.renewalVerificationAttemptAt).toBe(NOW + 20_000);
    });

    test("an unusable remote status maps to a retryable verification failure", async () => {
      const t = convexTest(schema, modules);
      await seedStaleActiveForReconcile(t, { suffix: "on_demand_unusable" });
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const result = await t.action(
        internal.payments.billing.verifyRecentlyStaleSubscriptionOnDemand,
        {
          userId: TEST_USER_ID,
          now: NOW,
          remoteSubscriptionsForTest: [
            {
              subscription_id: "sub_on_demand_unusable",
              product_id: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
              status: "pending",
              previous_billing_date: new Date(NOW - 31 * DAY_MS).toISOString(),
              next_billing_date: new Date(NOW - DAY_MS).toISOString(),
            },
          ],
        },
      );

      expect(result).toEqual({
        status: "renewal_verification_failed",
        retryAfterSeconds: 60,
      });
      expect((await readSub(t, "on_demand_unusable"))?.renewalVerificationState).toBe("failed");
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    });
  });

  describe("entitlement cache re-sync (#4770 marker race)", () => {
    test("schedules an immediate snapshot sync and a delayed from-DB re-sync", async () => {
      const t = convexTest(schema, modules);
      vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://upstash.test");
      // Freeze timers so the enqueued jobs are inspectable but never execute —
      // convex-test runs a 0-delay scheduled action after the transaction
      // closes, which trips its "Write outside of transaction" guard.
      vi.useFakeTimers({ toFake: ["setTimeout", "setInterval"] });
      try {
        await t.run(async (ctx) => {
          await upsertEntitlements(ctx, TEST_USER_ID, "pro_monthly", NOW + 30 * DAY_MS, NOW);
        });

        const scheduled = await t.run((ctx) =>
          ctx.db.system.query("_scheduled_functions").collect(),
        );
        const jobs = scheduled
          .filter((job) => job.name.includes("cacheActions"))
          .sort((a, b) => a.scheduledTime - b.scheduledTime);

        // The delayed second sync overwrites any stale billing-denial marker a
        // still-in-flight request writes AFTER the immediate sync (bare SET,
        // last-writer-wins). It must be the from-DB variant: replaying this
        // upsert's snapshot could revert a NEWER entitlement write landing
        // inside the delay (a stale re-grant).
        expect(jobs).toHaveLength(2);
        expect(jobs[0].name).toContain("syncEntitlementCache");
        expect(jobs[0].name).not.toContain("resync");
        expect(jobs[1].name).toContain("resyncEntitlementCacheFromDb");
        expect(jobs[1].args).toEqual([{ userId: TEST_USER_ID }]);
        // Each runAfter stamps its own Date.now() (not faked), so the two
        // calls can straddle a millisecond tick — assert the delay with a
        // small tolerance instead of exact equality.
        const delta = jobs[1].scheduledTime - jobs[0].scheduledTime;
        expect(delta).toBeGreaterThanOrEqual(15_000);
        expect(delta).toBeLessThan(15_100);
      } finally {
        vi.useRealTimers();
        vi.unstubAllEnvs();
      }
    });

    test("delayed re-sync writes CURRENT entitlement state, not a caller snapshot", async () => {
      const t = convexTest(schema, modules);
      vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://upstash.test");
      vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "token-test");
      const setCalls: string[] = [];
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        setCalls.push(String(input));
        return new Response(JSON.stringify({ result: "OK" }), { status: 200 });
      });
      try {
        await t.run(async (ctx) => {
          await ctx.db.insert("entitlements", {
            userId: TEST_USER_ID,
            planKey: "pro_monthly",
            features: getFeaturesForPlan("pro_monthly"),
            validUntil: NOW + 30 * DAY_MS,
            updatedAt: NOW,
          });
        });
        await t.action(internal.payments.cacheActions.resyncEntitlementCacheFromDb, {
          userId: TEST_USER_ID,
        });
        expect(setCalls).toHaveLength(1);
        expect(setCalls[0]).toContain(encodeURIComponent('"planKey":"pro_monthly"'));

        // A downgrade landing before the delayed job fires must be what the
        // re-sync writes — the action reads at fire time by construction.
        await t.run(async (ctx) => {
          const row = await ctx.db
            .query("entitlements")
            .withIndex("by_userId", (q) => q.eq("userId", TEST_USER_ID))
            .first();
          if (row) {
            await ctx.db.patch(row._id, {
              planKey: "free",
              features: getFeaturesForPlan("free"),
              validUntil: 0,
              updatedAt: NOW + 1,
            });
          }
        });
        await t.action(internal.payments.cacheActions.resyncEntitlementCacheFromDb, {
          userId: TEST_USER_ID,
        });
        expect(setCalls).toHaveLength(2);
        expect(setCalls[1]).toContain(encodeURIComponent('"planKey":"free"'));
      } finally {
        fetchSpy.mockRestore();
        vi.unstubAllEnvs();
      }
    });
  });
});

describe("getSubscriptionForUser renewal verification exposure (#4771)", () => {
  const IDENTITY = { subject: TEST_USER_ID, tokenIdentifier: `clerk|${TEST_USER_ID}` };

  test("returns renewalVerificationState when the row carries a verification verdict", async () => {
    const t = convexTest(schema, modules);
    await seedSubscription(t, {
      planKey: "pro_monthly",
      dodoProductId: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
      status: "active",
      currentPeriodEnd: NOW - DAY_MS,
      suffix: "renewal_pending",
      renewalVerificationState: "pending",
    });

    const result = await t
      .withIdentity(IDENTITY)
      .query(api.payments.billing.getSubscriptionForUser, {});
    expect(result).not.toBeNull();
    expect(result!.renewalVerificationState).toBe("pending");
  });

  test("returns null renewalVerificationState for rows without a verdict (stable shape)", async () => {
    const t = convexTest(schema, modules);
    await seedSubscription(t, {
      planKey: "pro_monthly",
      dodoProductId: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
      status: "active",
      currentPeriodEnd: NOW + 30 * DAY_MS,
      suffix: "no_verdict",
    });

    const result = await t
      .withIdentity(IDENTITY)
      .query(api.payments.billing.getSubscriptionForUser, {});
    expect(result).not.toBeNull();
    expect(result!.renewalVerificationState).toBeNull();
  });

  test("multi-row: returns the priority-selected row's verdict, not another row's", async () => {
    const t = convexTest(schema, modules);
    // Older cancelled row carrying a stale verification verdict...
    await seedSubscription(t, {
      planKey: "pro_monthly",
      dodoProductId: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
      status: "cancelled",
      currentPeriodEnd: NOW - 30 * DAY_MS,
      suffix: "multi_row_cancelled",
      renewalVerificationState: "failed",
    });
    // ...must not leak onto the newer active row the priority sort selects.
    await seedSubscription(t, {
      planKey: "pro_monthly",
      dodoProductId: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
      status: "active",
      currentPeriodEnd: NOW + 30 * DAY_MS,
      suffix: "multi_row_active",
    });

    const result = await t
      .withIdentity(IDENTITY)
      .query(api.payments.billing.getSubscriptionForUser, {});
    expect(result).not.toBeNull();
    expect(result!.status).toBe("active");
    expect(result!.renewalVerificationState).toBeNull();
  });
});
