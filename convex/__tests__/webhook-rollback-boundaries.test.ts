import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { PRODUCT_CATALOG } from "../config/productCatalog";
import schema from "../schema";
import { internal } from "../_generated/api";
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIUserAbortError,
  AuthenticationError,
  InternalServerError,
  NotFoundError,
  RateLimitError,
} from "dodopayments";
import {
  isDefinitiveDodoNotFound,
  PENDING_PAYMENT_BLOCK_WINDOW_MS,
} from "../payments/billing";
import { isNewerEvent } from "../payments/subscriptionHelpers";

const modules = import.meta.glob("../**/*.ts");

// Permanent regressions for #5380: malformed-late-webhook transactional
// rollback, exact TTL/paid-through boundaries, and equal-timestamp lifecycle
// ordering — each previously proven only by temporary tests or untested.

const BASE_TIMESTAMP = new Date("2026-03-21T10:00:00Z").getTime();
// Wall clock for the boundary suites below, which pin `Date.now()` so a seeded
// row can sit EXACTLY on the comparison edge.
const FROZEN_NOW = new Date("2026-03-21T12:00:00Z").getTime();

function makeSubscriptionPayload(overrides: Record<string, unknown> = {}) {
  return {
    type: "subscription.active",
    business_id: "biz_test",
    timestamp: "2026-03-21T10:00:00Z",
    data: {
      payload_type: "Subscription",
      subscription_id: "sub_test_001",
      product_id: "pdt_test_pro",
      status: "active",
      customer: {
        customer_id: "cust_test_001",
        email: "test@example.com",
        name: "Test User",
      },
      metadata: { wm_user_id: "test-user-001" },
      previous_billing_date: "2026-03-21T00:00:00Z",
      next_billing_date: "2026-04-21T00:00:00Z",
      ...overrides,
    },
  };
}

async function seedProductPlan(t: ReturnType<typeof convexTest>) {
  await t.run(async (ctx) => {
    await ctx.db.insert("productPlans", {
      dodoProductId: "pdt_test_pro",
      planKey: "pro_monthly",
      displayName: "Pro Monthly",
      isActive: true,
    });
  });
}

async function seedCustomer(t: ReturnType<typeof convexTest>) {
  await t.run(async (ctx) => {
    await ctx.db.insert("customers", {
      userId: "test-user-001",
      dodoCustomerId: "cust_test_001",
      email: "test@example.com",
      createdAt: BASE_TIMESTAMP,
      updatedAt: BASE_TIMESTAMP,
    });
  });
}

async function processEvent(
  t: ReturnType<typeof convexTest>,
  webhookId: string,
  eventType: string,
  rawPayload: Record<string, unknown>,
  timestamp: number,
) {
  await t.mutation(internal.payments.webhookMutations.processWebhookEvent, {
    webhookId,
    eventType,
    rawPayload,
    timestamp,
  });
}

// ---------------------------------------------------------------------------
// #5380 High-2: malformed late webhook must roll back atomically
// ---------------------------------------------------------------------------

describe("malformed webhook transactional rollback", () => {
  test("a crash mid-handler leaves ZERO subscription/entitlement/webhook rows", async () => {
    const t = convexTest(schema, modules);
    await seedProductPlan(t);
    await seedCustomer(t);

    // `customer.email` as a number crashes the post-insert customer upsert
    // (`email.trim()`), i.e. AFTER the subscription insert and entitlement
    // recompute in the same mutation — the exact partial-write hazard.
    const malformed = makeSubscriptionPayload({
      customer: { customer_id: "cust_test_001", email: 12345, name: "Bad" },
    });

    // Pin the CRASH SITE, not just "it threw". `email.trim` is reached after
    // the subscription insert and entitlement recompute, which is what makes
    // this a rollback proof at all. If a future refactor validates the payload
    // up front, this assertion reds and forces a new post-write crash site
    // rather than silently degrading into an "early validation rejects" test.
    await expect(
      processEvent(t, "wh_malformed_1", "subscription.active", malformed, BASE_TIMESTAMP),
    ).rejects.toThrow(/trim is not a function/);

    const { subs, ents, events } = await t.run(async (ctx) => ({
      subs: await ctx.db.query("subscriptions").collect(),
      ents: await ctx.db.query("entitlements").collect(),
      events: await ctx.db.query("webhookEvents").collect(),
    }));
    expect(subs).toHaveLength(0);
    expect(ents).toHaveLength(0);
    // No dedup ledger row either — the retry must be able to re-process.
    expect(events).toHaveLength(0);
  });

  test("Dodo's retry of the rolled-back webhookId then processes cleanly", async () => {
    const t = convexTest(schema, modules);
    await seedProductPlan(t);
    await seedCustomer(t);

    const malformed = makeSubscriptionPayload({
      customer: { customer_id: "cust_test_001", email: 12345, name: "Bad" },
    });
    await expect(
      processEvent(t, "wh_retry_1", "subscription.active", malformed, BASE_TIMESTAMP),
    ).rejects.toThrow();

    // Same webhookId, corrected payload — must NOT be treated as a duplicate.
    await processEvent(t, "wh_retry_1", "subscription.active", makeSubscriptionPayload(), BASE_TIMESTAMP + 1);

    const { subs, ents } = await t.run(async (ctx) => ({
      subs: await ctx.db.query("subscriptions").collect(),
      ents: await ctx.db.query("entitlements").collect(),
    }));
    expect(subs).toHaveLength(1);
    expect(subs[0]?.status).toBe("active");
    expect(ents).toHaveLength(1);
    expect(ents[0]?.planKey).toBe("pro_monthly");
  });
});

// ---------------------------------------------------------------------------
// #5380 Medium-11 (PARTIAL): exactly-once under concurrent DISPATCH
// ---------------------------------------------------------------------------

// Scope, stated precisely so this test is not mistaken for a race proof:
// `convex-test` runs mutations to completion one at a time, so dispatching both
// deliveries without awaiting between them does NOT interleave their
// transactions. What this pins is the invariant at the boundary the HTTP action
// actually uses — two in-flight deliveries of one webhookId leave exactly one
// activation — with the second landing on the dedup-ledger branch.
//
// The genuine interleaving (both handlers reading an empty `by_webhookId` index
// before either inserts) is not reproducible in this harness. In production
// Convex's serializable isolation is what closes it: the first insert
// invalidates the second transaction's read set, so it retries and then sees
// the ledger row. That is a property of the Convex runtime, not of this code,
// and it is why census #11 stays open rather than being claimed here.
describe("concurrent dispatch of one webhookId", () => {
  test("two in-flight deliveries activate exactly one subscription", async () => {
    const t = convexTest(schema, modules);
    await seedProductPlan(t);
    await seedCustomer(t);

    const payload = makeSubscriptionPayload();
    const settled = await Promise.allSettled([
      processEvent(t, "wh_concurrent_1", "subscription.active", payload, BASE_TIMESTAMP),
      processEvent(t, "wh_concurrent_1", "subscription.active", payload, BASE_TIMESTAMP),
    ]);
    // Neither delivery may error: the loser is a dedup skip, not a failure —
    // a rejection here would make the HTTP action return 500 and have Dodo
    // retry an event that was already applied.
    expect(settled.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);

    const { subs, ents, events } = await t.run(async (ctx) => ({
      subs: await ctx.db.query("subscriptions").collect(),
      ents: await ctx.db.query("entitlements").collect(),
      events: await ctx.db.query("webhookEvents").collect(),
    }));
    expect(subs).toHaveLength(1);
    expect(ents).toHaveLength(1);
    expect(events).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// #5380 Medium-10: Dodo error contract, against REAL SDK error instances
// ---------------------------------------------------------------------------

// `isDefinitiveDodoNotFound` decides whether reconciliation may downgrade a
// paying customer. Every existing test drives it through the action's
// `errorInjectionForTest` seam, which throws a hand-rolled
// `Object.assign(new Error(), { status: 404 | 500 })` — so the assertions only
// ever proved our own stub matches our own reader. billing.test.ts additionally
// replaces the whole `dodopayments` module with a two-property class, so the
// real error classes are absent there by construction.
//
// This table feeds the classifier the SDK's actual exported errors. It fails if
// the vendor renames `.status`, moves to a different error hierarchy, or ever
// starts stamping a status onto a connection/timeout error — each of which
// would silently convert a transient blip into a customer downgrade.
describe("dodo error classification (real SDK instances)", () => {
  test("a real NotFoundError is the ONLY definitive-404 shape", () => {
    expect(isDefinitiveDodoNotFound(new NotFoundError(404, { detail: "gone" }, "Not Found", {})))
      .toBe(true);
  });

  test.each([
    ["AuthenticationError (401)", new AuthenticationError(401, {}, "Unauthorized", {})],
    ["RateLimitError (429)", new RateLimitError(429, {}, "Too Many Requests", {})],
    ["InternalServerError (500)", new InternalServerError(500, {}, "Server Error", {})],
    ["APIConnectionError (no status)", new APIConnectionError({ message: "socket hang up" })],
    ["APIConnectionTimeoutError (no status)", new APIConnectionTimeoutError({ message: "timed out" })],
    ["APIUserAbortError (no status)", new APIUserAbortError()],
  ])("%s must NOT downgrade — it is transient/ambiguous", (_label, err) => {
    expect(isDefinitiveDodoNotFound(err)).toBe(false);
  });

  test("non-Error throwables never downgrade", () => {
    for (const value of [null, undefined, 404, "404", { status: "404" }, {}]) {
      expect(isDefinitiveDodoNotFound(value)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// #5380 Medium-9: equal-timestamp lifecycle ordering
// ---------------------------------------------------------------------------

describe("equal-timestamp lifecycle ordering", () => {
  test("isNewerEvent rejects an equal timestamp (replay must not reorder state)", () => {
    expect(isNewerEvent(1_000, 1_000)).toBe(false);
    expect(isNewerEvent(1_000, 999)).toBe(false);
    expect(isNewerEvent(1_000, 1_001)).toBe(true);
  });

  test("a cancellation carrying the SAME timestamp as the activation is ignored", async () => {
    const t = convexTest(schema, modules);
    await seedProductPlan(t);
    await seedCustomer(t);

    await processEvent(t, "wh_eq_1", "subscription.active", makeSubscriptionPayload(), BASE_TIMESTAMP);
    await processEvent(
      t,
      "wh_eq_2",
      "subscription.cancelled",
      makeSubscriptionPayload({ status: "cancelled" }),
      BASE_TIMESTAMP,
    );

    const sub = await t.run(async (ctx) =>
      ctx.db
        .query("subscriptions")
        .withIndex("by_dodoSubscriptionId", (q) => q.eq("dodoSubscriptionId", "sub_test_001"))
        .unique(),
    );
    expect(sub?.status).toBe("active");
  });
});

// ---------------------------------------------------------------------------
// #5380 Medium-7: pending-payment block window boundary
// ---------------------------------------------------------------------------

describe("pending-payment block window boundary", () => {
  async function seedPendingCharge(t: ReturnType<typeof convexTest>, occurredAt: number) {
    await t.run(async (ctx) => {
      await ctx.db.insert("paymentEvents", {
        userId: "test-user-001",
        dodoPaymentId: "pay_pending_001",
        type: "charge",
        amount: 999,
        currency: "USD",
        status: "requires_customer_action",
        planKey: "pro_monthly",
        rawPayload: {},
        occurredAt,
      });
    });
  }

  // Time MUST be frozen for these two. Seeding `Date.now() - WINDOW` and
  // letting real time advance puts the row a few ms PAST the edge, where `.gt`
  // and `.gte` agree — a `.gt` -> `.gte` mutant survived that version of this
  // test. With the clock pinned, `occurredAt === windowStart` exactly, which is
  // the only seed value that can tell the two operators apart.
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("a pending payment exactly AT the window edge does not block (.gt is exclusive)", async () => {
    const t = convexTest(schema, modules);
    await seedPendingCharge(t, FROZEN_NOW - PENDING_PAYMENT_BLOCK_WINDOW_MS);

    const blocking = await t.query(internal.payments.billing.getBlockingPendingPayment, {
      userId: "test-user-001",
      productId: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
    });
    expect(blocking).toBeNull();
  });

  test("one millisecond inside the window still blocks — the edge is exactly windowStart", async () => {
    const t = convexTest(schema, modules);
    // Partner to the test above: together they pin the boundary to the ms.
    // Alone, the exclusion test would also pass if the window were shorter.
    await seedPendingCharge(t, FROZEN_NOW - PENDING_PAYMENT_BLOCK_WINDOW_MS + 1);

    const blocking = await t.query(internal.payments.billing.getBlockingPendingPayment, {
      userId: "test-user-001",
      productId: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
    });
    expect(blocking).not.toBeNull();
  });

  test("a pending payment well inside the window still blocks the same tier group", async () => {
    const t = convexTest(schema, modules);
    await seedPendingCharge(t, FROZEN_NOW - PENDING_PAYMENT_BLOCK_WINDOW_MS + 60_000);

    const blocking = await t.query(internal.payments.billing.getBlockingPendingPayment, {
      userId: "test-user-001",
      productId: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
    });
    expect(blocking).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// #5380 Medium-8: cancelled paid-through period-end boundary (checkout guard)
// ---------------------------------------------------------------------------

describe("cancelled paid-through boundary at checkout", () => {
  async function seedCancelledSub(t: ReturnType<typeof convexTest>, currentPeriodEnd: number) {
    await t.run(async (ctx) => {
      await ctx.db.insert("subscriptions", {
        userId: "test-user-001",
        dodoSubscriptionId: "sub_cancelled_boundary",
        dodoProductId: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
        planKey: "pro_monthly",
        status: "cancelled",
        currentPeriodStart: currentPeriodEnd - 30 * 86_400_000,
        currentPeriodEnd,
        rawPayload: {},
        updatedAt: currentPeriodEnd - 86_400_000,
      });
    });
  }

  // Frozen for the same reason as the pending-payment window above: with a
  // live clock, `currentPeriodEnd = Date.now()` is already in the past by the
  // time the query reads it, so `>` and `>=` behave identically and a `>=`
  // mutant survives.
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("a cancellation whose period ends exactly NOW does not block (> is strict)", async () => {
    const t = convexTest(schema, modules);
    await seedCancelledSub(t, FROZEN_NOW);

    const blocking = await t.query(internal.payments.billing.getCheckoutBlockingSubscription, {
      userId: "test-user-001",
      productId: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
    });
    expect(blocking).toBeNull();
  });

  test("one millisecond of paid-through time still blocks — the edge is exactly now", async () => {
    const t = convexTest(schema, modules);
    await seedCancelledSub(t, FROZEN_NOW + 1);

    const blocking = await t.query(internal.payments.billing.getCheckoutBlockingSubscription, {
      userId: "test-user-001",
      productId: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
    });
    expect(blocking).toMatchObject({ status: "cancelled" });
  });

  test("a cancellation still paid-through blocks checkout in the same family", async () => {
    const t = convexTest(schema, modules);
    await seedCancelledSub(t, FROZEN_NOW + 5 * 60_000);

    const blocking = await t.query(internal.payments.billing.getCheckoutBlockingSubscription, {
      userId: "test-user-001",
      productId: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
    });
    expect(blocking).toMatchObject({ status: "cancelled" });
  });
});
