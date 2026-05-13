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
    rawPayload?: unknown;
    userId?: string;
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
