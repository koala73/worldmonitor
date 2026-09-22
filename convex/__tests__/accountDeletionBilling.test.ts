import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import type { MutationCtx } from "../_generated/server";
import { tombstoneUserId } from "../accountDeletion/registry";
import { PRODUCT_CATALOG } from "../config/productCatalog";
import { signUserId } from "../lib/identitySigning";
import {
  handleSubscriptionActive, handleSubscriptionRenewed, handleSubscriptionOnHold,
  handleSubscriptionCancelled, handleSubscriptionPlanChanged, handleSubscriptionExpired,
  handleSubscriptionUpdated, recomputeEntitlementFromAllSubs, upsertEntitlements,
} from "../payments/subscriptionHelpers";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");
const NOW = 1_800_000_000_000;
const END = NOW + 30 * 86_400_000;
const USER = "user_deleted_billing";
const HASH = "a".repeat(64);
const REPLACEMENT = tombstoneUserId(HASH);
const EMAIL = "deleted.billing@example.com";
const PRODUCT = PRODUCT_CATALOG.pro_monthly.dodoProductId!;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
  vi.stubEnv("RESEND_API_KEY", "must-not-send");
  vi.stubEnv("DODO_IDENTITY_SIGNING_SECRET", "test-deletion-billing-secret");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function setup(complete = true) {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => ({
    deletion: await ctx.db.insert("accountDeletions", {
      userId: USER, userIdHash: HASH, source: "self",
      status: complete ? "complete" : "pending", step: complete ? "complete" : "grants",
      dodoSubscriptionIds: ["sub_deleted"], cancelledDodoSubscriptionIds: complete ? ["sub_deleted"] : [],
      startedAt: NOW - 2, updatedAt: NOW - 1,
      ...(complete ? { completedAt: NOW - 1, redisClearedAt: NOW - 1, clerkDeletedAt: NOW - 1 } : {}),
    }),
    subscription: await ctx.db.insert("subscriptions", {
      userId: complete ? REPLACEMENT : USER, dodoSubscriptionId: "sub_deleted", dodoProductId: PRODUCT,
      planKey: "pro_monthly", status: "active", currentPeriodStart: NOW - 1000,
      currentPeriodEnd: END, dodoCustomerId: "cus_deleted", rawPayload: {}, updatedAt: NOW - 1,
    }),
    customer: await ctx.db.insert("customers", {
      userId: complete ? REPLACEMENT : USER, dodoCustomerId: "cus_deleted",
      email: complete ? REPLACEMENT : EMAIL, normalizedEmail: complete ? REPLACEMENT : EMAIL,
      createdAt: NOW - 1000, updatedAt: NOW - 1,
    }),
  }));
  return { t, ids };
}

function payload() {
  return {
    subscription_id: "sub_deleted", product_id: PRODUCT,
    previous_billing_date: new Date(NOW).toISOString(), next_billing_date: new Date(END).toISOString(),
    customer: { customer_id: "cus_deleted", email: EMAIL, name: "Deleted Customer", phone_number: "+15555550123" },
    metadata: { wm_user_id: USER, wm_login_email: EMAIL, wm_user_id_sig: "stale-sig" },
    recurring_pre_tax_amount: 2900, currency: "USD",
  };
}

type SubscriptionHandler = (ctx: MutationCtx, data: ReturnType<typeof payload>) => Promise<void>;
const lifecycleHandlers: Array<[string, SubscriptionHandler]> = [
  ["active", (ctx, data) => handleSubscriptionActive(ctx, data, NOW, "late-active", { data })],
  ["renewed", (ctx, data) => handleSubscriptionRenewed(ctx, data, NOW)],
  ["on_hold", (ctx, data) => handleSubscriptionOnHold(ctx, data, NOW)],
  ["cancelled", (ctx, data) => handleSubscriptionCancelled(ctx, data, NOW)],
  ["plan_changed", (ctx, data) => handleSubscriptionPlanChanged(ctx, data, NOW)],
  ["expired", (ctx, data) => handleSubscriptionExpired(ctx, data, NOW)],
  ["updated", (ctx, data) => handleSubscriptionUpdated(ctx, { ...data, status: "active" }, NOW, "late-updated", { data })],
  ["unknown update", (ctx, data) => handleSubscriptionUpdated(ctx, { ...data, status: "unknown" }, NOW, "late-unknown", { data })],
];

describe("late billing events during account deletion", () => {
  test.each(lifecycleHandlers)("direct %s handler retains billing audit without access or email work", async (_name, handler) => {
    const { t, ids } = await setup();
    await t.run((ctx) => handler(ctx, payload()));
    const state = await t.run(async (ctx) => ({
      sub: await ctx.db.get(ids.subscription), customers: await ctx.db.query("customers").collect(),
      entitlements: await ctx.db.query("entitlements").collect(),
      jobs: await ctx.db.system.query("_scheduled_functions").collect(),
    }));
    expect(state.sub?.userId).toBe(REPLACEMENT);
    expect(state.sub?.rawPayload.customer).toEqual(payload().customer);
    expect(state.sub?.rawPayload.metadata).toEqual({});
    expect(state.sub?.rawPayload.recurring_pre_tax_amount).toBe(2900);
    expect(state.customers).toHaveLength(1);
    // The complete-deletion fixture already seeded the tombstoned email;
    // the late handler must preserve it (no live-owner rewrite).
    expect(state.customers[0]?.email).toBe(REPLACEMENT);
    expect(state.entitlements).toEqual([]);
    expect(state.jobs).toEqual([]);
  });

  test.each([false, true])("payment and webhook audit retain billing evidence (complete=%s)", async (complete) => {
    const { t } = await setup(complete);
    for (const type of ["payment.succeeded", "refund.succeeded", "dispute.lost"]) {
      const data = { ...payload(), payment_id: `pay_${type}`, total_amount: 2900 };
      await t.mutation(internal.payments.webhookMutations.processWebhookEvent, {
        webhookId: `hook_${type}`, eventType: type, timestamp: NOW,
        rawPayload: { type, data },
      });
    }
    const state = await t.run(async (ctx) => ({
      payments: await ctx.db.query("paymentEvents").collect(),
      events: await ctx.db.query("webhookEvents").collect(),
      entitlements: await ctx.db.query("entitlements").collect(),
    }));
    expect(state.payments).toHaveLength(3);
    for (const row of state.payments) {
      expect(row.userId).toBe(REPLACEMENT);
      expect(row.amount).toBe(2900);
      expect(row.rawPayload.customer).toEqual(payload().customer);
      expect(row.rawPayload.metadata).toEqual({});
    }
    expect(state.events).toHaveLength(3);
    for (const row of state.events) {
      expect(row.rawPayload.data.customer).toEqual(payload().customer);
      expect(row.rawPayload.data.metadata).toEqual({});
    }
    expect(state.entitlements).toEqual([]);
  });

  test.each(["customer", "signed metadata"])("late first activation via %s resumes cancellation once", async (identitySource) => {
    const { t, ids } = await setup();
    const data = {
      ...payload(), subscription_id: "sub_arrived_after_delete",
      customer: { ...payload().customer, customer_id: identitySource === "customer" ? "cus_deleted" : "cus_new" },
      metadata: { wm_user_id: USER, wm_user_id_sig: await signUserId(USER), wm_login_email: EMAIL },
    };
    if (identitySource === "customer") data.metadata.wm_user_id_sig = "untrusted-signature";
    for (const index of [1, 2]) await t.mutation(internal.payments.webhookMutations.processWebhookEvent, {
      webhookId: `late_activation_${index}`, eventType: "subscription.active", timestamp: NOW + index,
      rawPayload: { data },
    });
    await t.mutation(internal.payments.webhookMutations.processWebhookEvent, {
      webhookId: "late_customer_only_payment", eventType: "payment.succeeded", timestamp: NOW + 3,
      rawPayload: { data: { customer: data.customer, payment_id: "pay_customer_only", total_amount: 2900 } },
    });
    const state = await t.run(async (ctx) => ({
      deletion: await ctx.db.get(ids.deletion),
      sub: await ctx.db.query("subscriptions").withIndex("by_dodoSubscriptionId", (q) =>
        q.eq("dodoSubscriptionId", data.subscription_id)).unique(),
      entitlements: await ctx.db.query("entitlements").collect(),
      customers: await ctx.db.query("customers").collect(),
      payments: await ctx.db.query("paymentEvents").collect(),
      unattributed: await ctx.db.query("unattributedPaymentEvents").collect(),
      jobs: await ctx.db.system.query("_scheduled_functions").collect(),
    }));
    expect(state.sub?.userId).toBe(REPLACEMENT);
    expect(state.sub?.rawPayload.metadata).toEqual({});
    expect(state.deletion).toMatchObject({ status: "pending", step: "external", externalAttempts: 0,
      redisClearedAt: NOW - 1, clerkDeletedAt: NOW - 1 });
    expect(state.deletion?.dodoSubscriptionIds).toEqual(["sub_deleted", data.subscription_id]);
    expect(state.deletion?.subscriptionDocIds).toEqual([state.sub?._id]);
    expect(state.deletion?.cancelledDodoSubscriptionIds).toEqual(["sub_deleted"]);
    expect(state.deletion?.completedAt).toBeUndefined();
    expect(state.entitlements).toEqual([]);
    expect(state.customers).toHaveLength(identitySource === "customer" ? 1 : 2);
    expect(state.customers.every((row) => row.email === REPLACEMENT)).toBe(true);
    expect(state.payments).toHaveLength(1);
    expect(state.payments[0]?.userId).toBe(REPLACEMENT);
    expect(state.payments[0]?.rawPayload.customer).toEqual(data.customer);
    expect(state.unattributed).toEqual([]);
    expect(state.jobs).toHaveLength(1);
    expect(state.jobs[0]?.name).toContain("accountDeletion/sideEffects");
  });

  test("central entitlement writers cannot restore original or tombstoned owners", async () => {
    const { t } = await setup();
    for (const userId of [USER, REPLACEMENT]) {
      await t.run((ctx) => upsertEntitlements(ctx, userId, "pro_monthly", END, NOW));
      await t.run((ctx) => recomputeEntitlementFromAllSubs(ctx, userId, NOW));
    }
    expect(await t.run((ctx) => ctx.db.query("entitlements").collect())).toEqual([]);
  });

  test("new subscriptions join the pending external chain without resetting retries or scheduling another", async () => {
    const { t, ids } = await setup(false);
    await t.run((ctx) => ctx.db.patch(ids.deletion, { step: "external", externalAttempts: 3 }));
    await t.mutation(internal.payments.webhookMutations.processWebhookEvent, {
      webhookId: "late_pending_activation", eventType: "subscription.active", timestamp: NOW,
      rawPayload: { data: { ...payload(), subscription_id: "sub_pending_external" } },
    });
    const state = await t.run(async (ctx) => ({
      deletion: await ctx.db.get(ids.deletion), jobs: await ctx.db.system.query("_scheduled_functions").collect(),
    }));
    expect(state.deletion).toMatchObject({ status: "pending", step: "external", externalAttempts: 3,
      dodoSubscriptionIds: ["sub_deleted", "sub_pending_external"] });
    expect(state.jobs).toEqual([]);
  });

  test("queued welcome and reactivation jobs do not send after deletion starts", async () => {
    const { t } = await setup(false);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await t.action(internal.payments.subscriptionEmails.sendSubscriptionEmails, {
      userId: USER, userEmail: EMAIL, planKey: "pro_monthly", checkoutEmail: "checkout@example.com",
    });
    await t.action(internal.payments.subscriptionEmails.sendReactivationEmail, {
      userId: USER, userEmail: EMAIL, planKey: "pro_monthly", checkoutEmail: "checkout@example.com",
    });
    await t.action(internal.payments.subscriptionEmails.sendReactivationEmail, {
      userEmail: EMAIL, planKey: "pro_monthly",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // The operator repair command must refuse a deleted account. Without a test,
  // deleting the guard would not fail anything -- and attributing a payment to
  // an erased user re-creates the entitlement the cascade just removed.
  test.each([false, true])(
    "attributeUnattributedPayment refuses an account being deleted (complete=%s)",
    async (complete) => {
      const { t } = await setup(complete);
      const rowId = await t.run((ctx) => ctx.db.insert("unattributedPaymentEvents", {
        webhookId: "evt_unattributed_1",
        eventType: "payment.succeeded",
        charged: true,
        dodoCustomerId: "cus_deleted",
        dodoPaymentId: "pay_1",
        rawPayload: {},
        eventTimestamp: NOW,
        receivedAt: NOW,
        lastSeenAt: NOW,
        occurrences: 1,
        resolved: false,
      }));
      await expect(
        t.mutation(internal.payments.webhookMutations.attributeUnattributedPayment, {
          rowId, userId: USER,
        }),
      ).rejects.toThrow(/being deleted/i);
      // Still unresolved: the refusal must not half-apply the attribution.
      const row = await t.run((ctx) => ctx.db.get(rowId));
      expect(row?.resolved).toBe(false);
      expect(row?.resolvedUserId).toBeUndefined();
    },
  );

  test.each([false, true])("late dunning send keeps recipient identity but never re-sends (complete=%s)", async (complete) => {
    const { t } = await setup(complete);
    expect(await t.query(internal.payments.subscriptionEmails.getDunningContext, {
      dodoSubscriptionId: "sub_deleted",
    })).toBeNull();
    // The provider send can finish after deletion passed its cleanup stage.
    await t.mutation(internal.payments.subscriptionEmails.recordDunningStepSent, {
      dodoSubscriptionId: "sub_deleted", step: "dunning_day0", episodeAt: NOW, email: EMAIL,
    });
    const rows = await t.run((ctx) => ctx.db.query("dunningEmails").collect());
    expect(rows).toHaveLength(0);
  });
});
