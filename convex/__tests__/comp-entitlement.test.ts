import { convexTest } from "convex-test";
import { expect, test, describe } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";

const modules = import.meta.glob("../**/*.ts");

const USER_ID = "user_comp_test_001";
const DAY_MS = 24 * 60 * 60 * 1000;

async function readEntitlement(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
    return ctx.db
      .query("entitlements")
      .withIndex("by_userId", (q) => q.eq("userId", USER_ID))
      .first();
  });
}

// ---------------------------------------------------------------------------
// grantComplimentaryEntitlement
// ---------------------------------------------------------------------------

describe("grantComplimentaryEntitlement", () => {
  test("creates a new entitlement with matching validUntil + compUntil", async () => {
    const t = convexTest(schema, modules);
    const before = Date.now();
    const result = await t.mutation(
      internal.payments.billing.grantComplimentaryEntitlement,
      { userId: USER_ID, planKey: "pro_monthly", days: 90 },
    );
    const after = Date.now();

    // Grant returns validUntil and compUntil roughly now+90d.
    const expectedUntilMin = before + 90 * DAY_MS;
    const expectedUntilMax = after + 90 * DAY_MS;
    expect(result.validUntil).toBeGreaterThanOrEqual(expectedUntilMin);
    expect(result.validUntil).toBeLessThanOrEqual(expectedUntilMax);
    expect(result.compUntil).toBe(result.validUntil);

    const row = await readEntitlement(t);
    expect(row).not.toBeNull();
    expect(row!.planKey).toBe("pro_monthly");
    expect(row!.features.tier).toBe(1);
    expect(row!.validUntil).toBe(result.validUntil);
    expect(row!.compUntil).toBe(result.compUntil);
  });

  test("extends an existing entitlement (never shrinks)", async () => {
    const t = convexTest(schema, modules);
    // Seed a long-lived entitlement manually.
    const longUntil = Date.now() + 365 * DAY_MS;
    await t.run(async (ctx) => {
      await ctx.db.insert("entitlements", {
        userId: USER_ID,
        planKey: "pro_monthly",
        features: {
          tier: 1,
          maxDashboards: 10,
          apiAccess: false,
          apiRateLimit: 0,
          prioritySupport: false,
          exportFormats: ["csv", "pdf"],
        },
        validUntil: longUntil,
        compUntil: longUntil,
        updatedAt: Date.now(),
      });
    });

    // Granting 30 days must NOT shrink the 365-day comp.
    const result = await t.mutation(
      internal.payments.billing.grantComplimentaryEntitlement,
      { userId: USER_ID, planKey: "pro_monthly", days: 30 },
    );
    expect(result.validUntil).toBe(longUntil);
    expect(result.compUntil).toBe(longUntil);
  });

  test("upgrades planKey to the requested tier on existing row", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("entitlements", {
        userId: USER_ID,
        planKey: "free",
        features: {
          tier: 0,
          maxDashboards: 3,
          apiAccess: false,
          apiRateLimit: 0,
          prioritySupport: false,
          exportFormats: ["csv"],
        },
        validUntil: 0,
        updatedAt: Date.now(),
      });
    });

    await t.mutation(
      internal.payments.billing.grantComplimentaryEntitlement,
      { userId: USER_ID, planKey: "pro_monthly", days: 7 },
    );
    const row = await readEntitlement(t);
    expect(row!.planKey).toBe("pro_monthly");
    expect(row!.features.tier).toBe(1);
  });

  test("rejects unknown planKey", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(internal.payments.billing.grantComplimentaryEntitlement, {
        userId: USER_ID,
        planKey: "unicorn_tier",
        days: 30,
      }),
    ).rejects.toThrow(/unknown planKey/i);
  });

  test("rejects non-positive days", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(internal.payments.billing.grantComplimentaryEntitlement, {
        userId: USER_ID,
        planKey: "pro_monthly",
        days: 0,
      }),
    ).rejects.toThrow(/positive finite/i);
    await expect(
      t.mutation(internal.payments.billing.grantComplimentaryEntitlement, {
        userId: USER_ID,
        planKey: "pro_monthly",
        days: -5,
      }),
    ).rejects.toThrow(/positive finite/i);
  });
});

// ---------------------------------------------------------------------------
// handleSubscriptionExpired guard
// ---------------------------------------------------------------------------

async function seedSubAndEntitlement(
  t: ReturnType<typeof convexTest>,
  opts: {
    subscriptionId: string;
    compUntil?: number;
    entitlementValidUntil: number;
  },
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("subscriptions", {
      userId: USER_ID,
      dodoSubscriptionId: opts.subscriptionId,
      dodoProductId: "pdt_0Nbtt71uObulf7fGXhQup",
      planKey: "pro_monthly",
      status: "active",
      currentPeriodStart: Date.now() - 30 * DAY_MS,
      currentPeriodEnd: Date.now() + 1 * DAY_MS,
      rawPayload: {},
      updatedAt: Date.now() - 1000,
    });
    await ctx.db.insert("entitlements", {
      userId: USER_ID,
      planKey: "pro_monthly",
      features: {
        tier: 1,
        maxDashboards: 10,
        apiAccess: false,
        apiRateLimit: 0,
        prioritySupport: false,
        exportFormats: ["csv", "pdf"],
      },
      validUntil: opts.entitlementValidUntil,
      ...(opts.compUntil !== undefined ? { compUntil: opts.compUntil } : {}),
      updatedAt: Date.now() - 1000,
    });
  });
}

async function fireSubscriptionExpired(
  t: ReturnType<typeof convexTest>,
  subscriptionId: string,
) {
  await t.mutation(
    internal.payments.webhookMutations.processWebhookEvent,
    {
      webhookId: `msg_test_${subscriptionId}_expired`,
      eventType: "subscription.expired",
      rawPayload: {
        type: "subscription.expired",
        data: {
          subscription_id: subscriptionId,
          product_id: "pdt_0Nbtt71uObulf7fGXhQup",
          customer: { customer_id: "cus_test" },
          metadata: { wm_user_id: USER_ID },
          previous_billing_date: new Date(Date.now() - 30 * DAY_MS).toISOString(),
          next_billing_date: new Date(Date.now() + DAY_MS).toISOString(),
        },
      },
      timestamp: Date.now(),
    },
  );
}

describe("handleSubscriptionExpired comp guard", () => {
  test("revokes to free when no comp is set (original behavior)", async () => {
    const t = convexTest(schema, modules);
    await seedSubAndEntitlement(t, {
      subscriptionId: "sub_no_comp",
      entitlementValidUntil: Date.now() + DAY_MS,
      // no compUntil
    });
    await fireSubscriptionExpired(t, "sub_no_comp");

    const row = await readEntitlement(t);
    expect(row!.planKey).toBe("free");
    expect(row!.features.tier).toBe(0);
  });

  test("revokes to free when compUntil is already in the past", async () => {
    const t = convexTest(schema, modules);
    await seedSubAndEntitlement(t, {
      subscriptionId: "sub_stale_comp",
      entitlementValidUntil: Date.now() + DAY_MS,
      compUntil: Date.now() - DAY_MS, // expired comp
    });
    await fireSubscriptionExpired(t, "sub_stale_comp");

    const row = await readEntitlement(t);
    expect(row!.planKey).toBe("free");
  });

  test("preserves the entitlement when compUntil is still in the future", async () => {
    const t = convexTest(schema, modules);
    const futureCompUntil = Date.now() + 60 * DAY_MS;
    await seedSubAndEntitlement(t, {
      subscriptionId: "sub_with_comp",
      entitlementValidUntil: futureCompUntil,
      compUntil: futureCompUntil,
    });
    await fireSubscriptionExpired(t, "sub_with_comp");

    const row = await readEntitlement(t);
    // Entitlement must stay pro_monthly; validUntil and compUntil untouched.
    expect(row!.planKey).toBe("pro_monthly");
    expect(row!.features.tier).toBe(1);
    expect(row!.compUntil).toBe(futureCompUntil);
    expect(row!.validUntil).toBe(futureCompUntil);
  });

  test("grantComplimentaryEntitlement + subscription.expired end-to-end: entitlement survives", async () => {
    const t = convexTest(schema, modules);
    // Seed subscription without touching entitlement yet.
    await t.run(async (ctx) => {
      await ctx.db.insert("subscriptions", {
        userId: USER_ID,
        dodoSubscriptionId: "sub_e2e",
        dodoProductId: "pdt_0Nbtt71uObulf7fGXhQup",
        planKey: "pro_monthly",
        status: "active",
        currentPeriodStart: Date.now() - 30 * DAY_MS,
        currentPeriodEnd: Date.now() + DAY_MS,
        rawPayload: {},
        updatedAt: Date.now() - 1000,
      });
    });

    // Grant comp via the new mutation.
    await t.mutation(
      internal.payments.billing.grantComplimentaryEntitlement,
      { userId: USER_ID, planKey: "pro_monthly", days: 90, reason: "support credit" },
    );

    // Now Dodo fires expired on the sub.
    await fireSubscriptionExpired(t, "sub_e2e");

    const row = await readEntitlement(t);
    expect(row!.planKey).toBe("pro_monthly");
    expect(row!.features.tier).toBe(1);
    expect(row!.compUntil).toBeGreaterThan(Date.now() + 80 * DAY_MS);
  });
});

// ---------------------------------------------------------------------------
// Multi-active-sub guard
//
// The entitlements table is keyed by_userId (one row per user), but Dodo
// allows multiple concurrent subscriptions per user. Without this guard,
// expiring or replacing one sub would clobber the entitlement to "free"
// (or to a lower tier) even when another paid sub still covers the user.
// ---------------------------------------------------------------------------

describe("multi-active-sub guard", () => {
  async function seedTwoActiveSubs(
    t: ReturnType<typeof convexTest>,
    opts: {
      lower: { subscriptionId: string; planKey: string; productId: string };
      higher: { subscriptionId: string; planKey: string; productId: string; tier: number };
    },
  ) {
    await t.run(async (ctx) => {
      await ctx.db.insert("subscriptions", {
        userId: USER_ID,
        dodoSubscriptionId: opts.lower.subscriptionId,
        dodoProductId: opts.lower.productId,
        planKey: opts.lower.planKey,
        status: "active",
        currentPeriodStart: Date.now() - 30 * DAY_MS,
        currentPeriodEnd: Date.now() + DAY_MS,
        rawPayload: {},
        updatedAt: Date.now() - 1000,
      });
      await ctx.db.insert("subscriptions", {
        userId: USER_ID,
        dodoSubscriptionId: opts.higher.subscriptionId,
        dodoProductId: opts.higher.productId,
        planKey: opts.higher.planKey,
        status: "active",
        currentPeriodStart: Date.now() - 30 * DAY_MS,
        currentPeriodEnd: Date.now() + 30 * DAY_MS,
        rawPayload: {},
        updatedAt: Date.now() - 1000,
      });
      // Entitlement reflects the higher-tier sub (last-write-wins from when
      // the user upgraded).
      await ctx.db.insert("entitlements", {
        userId: USER_ID,
        planKey: opts.higher.planKey,
        features: {
          tier: opts.higher.tier,
          maxDashboards: 25,
          apiAccess: true,
          apiRateLimit: 60,
          prioritySupport: false,
          exportFormats: ["csv", "pdf", "json"],
        },
        validUntil: Date.now() + 30 * DAY_MS,
        updatedAt: Date.now() - 1000,
      });
    });
  }

  test("subscription.expired on the lower-tier sub preserves higher-tier entitlement", async () => {
    const t = convexTest(schema, modules);
    await seedTwoActiveSubs(t, {
      lower: {
        subscriptionId: "sub_pro_monthly",
        planKey: "pro_monthly",
        productId: "pdt_0Nbtt71uObulf7fGXhQup",
      },
      higher: {
        subscriptionId: "sub_api_starter",
        planKey: "api_starter",
        productId: "pdt_0NbttVmG1SERrxhygbbUq",
        tier: 2,
      },
    });

    await fireSubscriptionExpired(t, "sub_pro_monthly");

    const row = await readEntitlement(t);
    // CRITICAL: must NOT downgrade to free — the api_starter sub is still active.
    expect(row!.planKey).toBe("api_starter");
    expect(row!.features.tier).toBe(2);
    // validUntil should track the surviving sub's currentPeriodEnd.
    expect(row!.validUntil).toBeGreaterThan(Date.now() + 25 * DAY_MS);
  });

  test("subscription.expired on the only sub still downgrades to free", async () => {
    const t = convexTest(schema, modules);
    await seedSubAndEntitlement(t, {
      subscriptionId: "sub_solo",
      entitlementValidUntil: Date.now() + DAY_MS,
    });
    await fireSubscriptionExpired(t, "sub_solo");

    const row = await readEntitlement(t);
    expect(row!.planKey).toBe("free");
    expect(row!.features.tier).toBe(0);
  });

  test("subscription.expired on cancelled-but-still-covering other sub is treated as covering", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      // Sub A: active, lower tier — about to expire.
      await ctx.db.insert("subscriptions", {
        userId: USER_ID,
        dodoSubscriptionId: "sub_a_active_lower",
        dodoProductId: "pdt_0Nbtt71uObulf7fGXhQup",
        planKey: "pro_monthly",
        status: "active",
        currentPeriodStart: Date.now() - 30 * DAY_MS,
        currentPeriodEnd: Date.now() + DAY_MS,
        rawPayload: {},
        updatedAt: Date.now() - 1000,
      });
      // Sub B: cancelled but currentPeriodEnd is in the future — still covers.
      await ctx.db.insert("subscriptions", {
        userId: USER_ID,
        dodoSubscriptionId: "sub_b_cancelled_higher",
        dodoProductId: "pdt_0NbttVmG1SERrxhygbbUq",
        planKey: "api_starter",
        status: "cancelled",
        currentPeriodStart: Date.now() - 30 * DAY_MS,
        currentPeriodEnd: Date.now() + 60 * DAY_MS,
        cancelledAt: Date.now() - 5 * DAY_MS,
        rawPayload: {},
        updatedAt: Date.now() - 1000,
      });
      await ctx.db.insert("entitlements", {
        userId: USER_ID,
        planKey: "api_starter",
        features: {
          tier: 2,
          maxDashboards: 25,
          apiAccess: true,
          apiRateLimit: 60,
          prioritySupport: false,
          exportFormats: ["csv", "pdf", "json"],
        },
        validUntil: Date.now() + 60 * DAY_MS,
        updatedAt: Date.now() - 1000,
      });
    });

    await fireSubscriptionExpired(t, "sub_a_active_lower");

    const row = await readEntitlement(t);
    // Sub B is cancelled but its paid period extends 60 days — the user
    // should keep tier 2 access for that period.
    expect(row!.planKey).toBe("api_starter");
    expect(row!.features.tier).toBe(2);
  });
});
