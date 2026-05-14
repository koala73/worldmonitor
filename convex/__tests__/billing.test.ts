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
