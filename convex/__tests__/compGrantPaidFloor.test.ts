import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import { PRODUCT_CATALOG } from "../config/productCatalog";

const modules = import.meta.glob("../**/*.ts");
afterEach(() => vi.useRealTimers());

test.each(["api_business", "api_business_annual"])("a Pro goodwill grant preserves paid %s and remains Pro after paid expiry", async (paidPlan) => {
  vi.useFakeTimers();
  const now = 1_800_000_000_000;
  const day = 86_400_000;
  vi.setSystemTime(now);
  const t = convexTest(schema, modules);
  const subscriptionId = await t.run((ctx) => ctx.db.insert("subscriptions", {
    userId: "synthetic_paid_comp", planKey: paidPlan, status: "active",
    dodoSubscriptionId: "sub_synthetic_paid_comp", dodoProductId: PRODUCT_CATALOG[paidPlan].dodoProductId!,
    currentPeriodStart: now, currentPeriodEnd: now + 30 * day, rawPayload: {}, updatedAt: now,
  }));
  const read = () => t.run((ctx) => ctx.db.query("entitlements")
    .withIndex("by_userId", (q) => q.eq("userId", "synthetic_paid_comp")).unique());
  await t.mutation(internal.payments.subscriptionHelpers.recomputeEntitlementForUser, { userId: "synthetic_paid_comp" });
  await t.mutation(internal.payments.billing.grantComplimentaryEntitlement, {
    userId: "synthetic_paid_comp", planKey: "pro_monthly", days: 90,
  });
  expect(await read()).toMatchObject({ planKey: paidPlan, validUntil: now + 30 * day });
  await t.run((ctx) => ctx.db.patch(subscriptionId, { status: "expired" }));
  await t.mutation(internal.payments.subscriptionHelpers.recomputeEntitlementForUser, { userId: "synthetic_paid_comp" });
  expect(await read()).toMatchObject({ planKey: "pro_monthly", validUntil: now + 90 * day });
});
