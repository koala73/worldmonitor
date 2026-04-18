import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import { PRODUCT_CATALOG } from "../config/productCatalog";

const modules = import.meta.glob("../**/*.ts");

const TEST_USER_ID = "user_billing_test_001";
const NOW = Date.now();
const DAY_MS = 24 * 60 * 60 * 1000;

async function seedSubscription(
  t: ReturnType<typeof convexTest>,
  opts: {
    planKey: string;
    dodoProductId: string;
    status: "active" | "on_hold" | "cancelled" | "expired";
    currentPeriodEnd: number;
    suffix: string;
  },
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("subscriptions", {
      userId: TEST_USER_ID,
      dodoSubscriptionId: `sub_billing_${opts.suffix}`,
      dodoProductId: opts.dodoProductId,
      planKey: opts.planKey,
      status: opts.status,
      currentPeriodStart: NOW - DAY_MS,
      currentPeriodEnd: opts.currentPeriodEnd,
      rawPayload: {},
      updatedAt: NOW,
    });
  });
}

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
});
