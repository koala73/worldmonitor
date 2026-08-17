import { convexTest } from "convex-test";
import { expect, test, describe } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";

const modules = import.meta.glob("../**/*.ts");

const BASE_TIMESTAMP = new Date("2026-03-21T10:00:00Z").getTime();

/**
 * Capture-and-attribute path for Dodo events we cannot own.
 *
 * Origin: 2026-08-03, two enterprise buyers on a $1,596 annual bundle bought
 * through a Dodo payment link. Payment links carry `metadata: {}` — only our
 * checkout attaches the signed `wm_user_id` — so nothing identified the buyer.
 * Their cards failed 3DS, which is the only reason it cost noise and not money.
 */
describe("unattributed Dodo events", () => {
  function subscriptionActivePayload(overrides: Record<string, unknown> = {}) {
    return {
      type: "subscription.active",
      business_id: "biz_test",
      timestamp: "2026-03-21T10:00:00Z",
      data: {
        payload_type: "Subscription",
        subscription_id: "sub_paylink_001",
        product_id: "pdt_test_pro",
        status: "active",
        customer: {
          customer_id: "cus_paylink_new",
          email: "buyer@enterprise.example",
          name: "Enterprise Buyer",
        },
        metadata: {},
        previous_billing_date: "2026-03-21T00:00:00Z",
        next_billing_date: "2027-03-21T00:00:00Z",
        ...overrides,
      },
    };
  }

  function failedPaymentPayload(overrides: Record<string, unknown> = {}) {
    return {
      type: "payment.failed",
      business_id: "biz_test",
      timestamp: "2026-03-21T10:00:00Z",
      data: {
        payload_type: "Payment",
        payment_id: "pay_paylink_3ds",
        subscription_id: "sub_paylink_3ds",
        total_amount: 159600,
        currency: "USD",
        status: "failed",
        error_code: "AUTHENTICATION_FAILURE",
        error_message: "The customer couldn't complete 3DS authentication.",
        customer: {
          customer_id: "cus_paylink_new",
          email: "buyer@enterprise.example",
          name: "Enterprise Buyer",
        },
        metadata: {},
        ...overrides,
      },
    };
  }

  test("a PAID activation nobody owns is captured instead of thrown away", async () => {
    const t = convexTest(schema, modules);

    // Must not throw: throwing burned all 8 Dodo retries and lost the event.
    await t.mutation(internal.payments.webhookMutations.processWebhookEvent, {
      webhookId: "wh_paylink_active",
      eventType: "subscription.active",
      rawPayload: subscriptionActivePayload(),
      timestamp: BASE_TIMESTAMP,
    });

    const rows = await t.run(async (ctx) =>
      ctx.db.query("unattributedPaymentEvents").collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].charged).toBe(true);
    expect(rows[0].resolved).toBe(false);
    expect(rows[0].customerEmail).toBe("buyer@enterprise.example");
    expect(rows[0].dodoSubscriptionId).toBe("sub_paylink_001");
    expect(rows[0].notifiedAt).toBeDefined();

    // Nothing invented: no subscription or entitlement for a user we can't name.
    const { subs, ents } = await t.run(async (ctx) => ({
      subs: await ctx.db.query("subscriptions").collect(),
      ents: await ctx.db.query("entitlements").collect(),
    }));
    expect(subs).toHaveLength(0);
    expect(ents).toHaveLength(0);
  });

  test("an active-status subscription.updated records its REAL envelope and counts as charged", async () => {
    const t = convexTest(schema, modules);

    // handleSubscriptionUpdated routes this to handleSubscriptionActive. The row
    // must say `subscription.updated` — that is what replay re-dispatches — and
    // must still be `charged`, which the event type alone cannot tell you.
    const payload = subscriptionActivePayload();
    payload.type = "subscription.updated";

    await t.mutation(internal.payments.webhookMutations.processWebhookEvent, {
      webhookId: "wh_paylink_updated",
      eventType: "subscription.updated",
      rawPayload: payload,
      timestamp: BASE_TIMESTAMP,
    });

    const rows = await t.run(async (ctx) =>
      ctx.db.query("unattributedPaymentEvents").collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].eventType).toBe("subscription.updated");
    expect(rows[0].charged).toBe(true);
    expect(rows[0].notifiedAt).toBeDefined();
  });

  test("attributing an active-status subscription.updated still grants entitlement", async () => {
    const t = convexTest(schema, modules);

    const payload = subscriptionActivePayload();
    payload.type = "subscription.updated";
    await t.mutation(internal.payments.webhookMutations.processWebhookEvent, {
      webhookId: "wh_paylink_updated",
      eventType: "subscription.updated",
      rawPayload: payload,
      timestamp: BASE_TIMESTAMP,
    });
    const [pending] = await t.run(async (ctx) =>
      ctx.db.query("unattributedPaymentEvents").collect(),
    );

    await t.mutation(
      internal.payments.webhookMutations.attributeUnattributedPayment,
      { rowId: pending._id, userId: "user_enterprise_buyer" },
    );

    // Replay must route updated -> active and land the same fulfillment.
    const { subs, ents } = await t.run(async (ctx) => ({
      subs: await ctx.db.query("subscriptions").collect(),
      ents: await ctx.db.query("entitlements").collect(),
    }));
    expect(subs).toHaveLength(1);
    expect(subs[0].userId).toBe("user_enterprise_buyer");
    expect(ents).toHaveLength(1);
    expect(ents[0].userId).toBe("user_enterprise_buyer");
  });

  test("attributing it replays the event and grants the entitlement", async () => {
    const t = convexTest(schema, modules);

    await t.mutation(internal.payments.webhookMutations.processWebhookEvent, {
      webhookId: "wh_paylink_active",
      eventType: "subscription.active",
      rawPayload: subscriptionActivePayload(),
      timestamp: BASE_TIMESTAMP,
    });
    const [pending] = await t.run(async (ctx) =>
      ctx.db.query("unattributedPaymentEvents").collect(),
    );

    const result = await t.mutation(
      internal.payments.webhookMutations.attributeUnattributedPayment,
      {
        rowId: pending._id,
        userId: "user_enterprise_buyer",
        note: "5-seat deal, sold via payment link",
      },
    );
    expect(result.attributedTo).toBe("user_enterprise_buyer");

    const { subs, ents, customers, row } = await t.run(async (ctx) => ({
      subs: await ctx.db.query("subscriptions").collect(),
      ents: await ctx.db.query("entitlements").collect(),
      customers: await ctx.db.query("customers").collect(),
      row: await ctx.db.get(pending._id),
    }));
    // The buyer now holds exactly what a normal checkout would have given them.
    expect(subs).toHaveLength(1);
    expect(subs[0].userId).toBe("user_enterprise_buyer");
    expect(subs[0].dodoSubscriptionId).toBe("sub_paylink_001");
    expect(ents).toHaveLength(1);
    expect(ents[0].userId).toBe("user_enterprise_buyer");
    // And the identity gap is closed, so future events resolve on their own.
    expect(customers).toHaveLength(1);
    expect(customers[0].dodoCustomerId).toBe("cus_paylink_new");
    expect(row?.resolved).toBe(true);
    expect(row?.resolvedUserId).toBe("user_enterprise_buyer");
  });

  test("attributing twice is refused rather than replayed", async () => {
    const t = convexTest(schema, modules);

    await t.mutation(internal.payments.webhookMutations.processWebhookEvent, {
      webhookId: "wh_paylink_active",
      eventType: "subscription.active",
      rawPayload: subscriptionActivePayload(),
      timestamp: BASE_TIMESTAMP,
    });
    const [pending] = await t.run(async (ctx) =>
      ctx.db.query("unattributedPaymentEvents").collect(),
    );
    await t.mutation(
      internal.payments.webhookMutations.attributeUnattributedPayment,
      { rowId: pending._id, userId: "user_enterprise_buyer" },
    );

    await expect(
      t.mutation(
        internal.payments.webhookMutations.attributeUnattributedPayment,
        { rowId: pending._id, userId: "user_someone_else" },
      ),
    ).rejects.toThrow(/already attributed/);
  });

  test("a customer already owned by someone else is never reassigned", async () => {
    const t = convexTest(schema, modules);

    await t.run(async (ctx) => {
      await ctx.db.insert("customers", {
        userId: "user_rightful_owner",
        dodoCustomerId: "cus_paylink_new",
        email: "buyer@enterprise.example",
        normalizedEmail: "buyer@enterprise.example",
        createdAt: BASE_TIMESTAMP,
        updatedAt: BASE_TIMESTAMP,
      });
    });
    // With a customers row present the event resolves normally, so force the
    // unattributed row to exist and then attempt a mismatched attribution.
    const rowId = await t.run(async (ctx) =>
      ctx.db.insert("unattributedPaymentEvents", {
        webhookId: "wh_conflict",
        eventType: "subscription.active",
        charged: true,
        dodoCustomerId: "cus_paylink_new",
        rawPayload: subscriptionActivePayload(),
        eventTimestamp: BASE_TIMESTAMP,
        receivedAt: BASE_TIMESTAMP,
        lastSeenAt: BASE_TIMESTAMP,
        occurrences: 1,
        resolved: false,
      }),
    );

    await expect(
      t.mutation(
        internal.payments.webhookMutations.attributeUnattributedPayment,
        { rowId, userId: "user_impostor" },
      ),
    ).rejects.toThrow(/already maps to user_rightful_owner/);
  });

  test("an uncharged failure is captured and flagged as not-charged", async () => {
    const t = convexTest(schema, modules);

    await t.mutation(internal.payments.webhookMutations.processWebhookEvent, {
      webhookId: "wh_paylink_3ds",
      eventType: "payment.failed",
      rawPayload: failedPaymentPayload(),
      timestamp: BASE_TIMESTAMP,
    });

    const rows = await t.run(async (ctx) =>
      ctx.db.query("unattributedPaymentEvents").collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].charged).toBe(false);
    expect(rows[0].errorCode).toBe("AUTHENTICATION_FAILURE");
    expect(rows[0].amount).toBe(159600);
    // Notified: a buyer failing to pay is a sales signal we asked to hear about.
    expect(rows[0].notifiedAt).toBeDefined();
  });

  test("repeat uncharged attempts from one customer alert only once per day", async () => {
    const t = convexTest(schema, modules);

    for (const n of [1, 2, 3]) {
      await t.mutation(internal.payments.webhookMutations.processWebhookEvent, {
        webhookId: `wh_burst_${n}`,
        eventType: "payment.failed",
        rawPayload: failedPaymentPayload({ payment_id: `pay_burst_${n}` }),
        timestamp: BASE_TIMESTAMP,
      });
    }

    const rows = await t.run(async (ctx) =>
      ctx.db.query("unattributedPaymentEvents").collect(),
    );
    // Every attempt is recorded — the throttle suppresses alerts, not evidence.
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.notifiedAt !== undefined)).toHaveLength(1);
  });

  test("alerting resumes once the quiet period since the last alert has passed", async () => {
    const t = convexTest(schema, modules);

    // Seed the shape that a naive "is there a recent row" throttle gets wrong:
    // an old ALERTED row outside the window, plus a newer THROTTLED row inside
    // it. The next attempt must alert — 24h have passed since we last spoke up.
    // Anchored to Date.now(), because that is the clock the throttle compares
    // against — seeding from BASE_TIMESTAMP puts every row outside the window
    // and makes the assertion vacuous.
    const now = Date.now();
    const staleAlert = now - 30 * 60 * 60 * 1000;
    const recentSilent = now - 2 * 60 * 60 * 1000;
    await t.run(async (ctx) => {
      await ctx.db.insert("unattributedPaymentEvents", {
        webhookId: "wh_old_alerted",
        eventType: "payment.failed",
        charged: false,
        dodoCustomerId: "cus_paylink_new",
        rawPayload: {},
        eventTimestamp: staleAlert,
        receivedAt: staleAlert,
        lastSeenAt: staleAlert,
        occurrences: 1,
        notifiedAt: staleAlert,
        resolved: false,
      });
      await ctx.db.insert("unattributedPaymentEvents", {
        webhookId: "wh_recent_throttled",
        eventType: "payment.failed",
        charged: false,
        dodoCustomerId: "cus_paylink_new",
        rawPayload: {},
        eventTimestamp: recentSilent,
        receivedAt: recentSilent,
        lastSeenAt: recentSilent,
        occurrences: 1,
        resolved: false,
      });
    });

    await t.mutation(internal.payments.webhookMutations.processWebhookEvent, {
      webhookId: "wh_after_quiet_period",
      eventType: "payment.failed",
      rawPayload: failedPaymentPayload({ payment_id: "pay_after_quiet" }),
      timestamp: BASE_TIMESTAMP,
    });

    const fresh = await t.run(async (ctx) =>
      ctx.db
        .query("unattributedPaymentEvents")
        .withIndex("by_webhookId", (q) => q.eq("webhookId", "wh_after_quiet_period"))
        .first(),
    );
    expect(fresh?.notifiedAt).toBeDefined();
  });

  test("the throttle honours the MOST RECENT alert, not the oldest", async () => {
    const t = convexTest(schema, modules);

    // Two alerted rows: one long outside the quiet period, one just inside it.
    // Judging by the oldest would conclude "last alert was 30h ago, speak up"
    // and re-alert every time an old row exists — the exact over-alerting the
    // throttle is for.
    const now = Date.now();
    const staleAlert = now - 30 * 60 * 60 * 1000;
    const freshAlert = now - 2 * 60 * 60 * 1000;
    await t.run(async (ctx) => {
      for (const [webhookId, at] of [
        ["wh_alerted_stale", staleAlert],
        ["wh_alerted_fresh", freshAlert],
      ] as const) {
        await ctx.db.insert("unattributedPaymentEvents", {
          webhookId,
          eventType: "payment.failed",
          charged: false,
          dodoCustomerId: "cus_paylink_new",
          rawPayload: {},
          eventTimestamp: at,
          receivedAt: at,
          lastSeenAt: at,
          occurrences: 1,
          notifiedAt: at,
          resolved: false,
        });
      }
    });

    await t.mutation(internal.payments.webhookMutations.processWebhookEvent, {
      webhookId: "wh_within_quiet_period",
      eventType: "payment.failed",
      rawPayload: failedPaymentPayload({ payment_id: "pay_within_quiet" }),
      timestamp: BASE_TIMESTAMP,
    });

    const fresh = await t.run(async (ctx) =>
      ctx.db
        .query("unattributedPaymentEvents")
        .withIndex("by_webhookId", (q) =>
          q.eq("webhookId", "wh_within_quiet_period"),
        )
        .first(),
    );
    expect(fresh).not.toBeNull();
    expect(fresh?.notifiedAt).toBeUndefined();
  });

  test("a charged event always alerts, even behind an uncharged burst", async () => {
    const t = convexTest(schema, modules);

    await t.mutation(internal.payments.webhookMutations.processWebhookEvent, {
      webhookId: "wh_burst_1",
      eventType: "payment.failed",
      rawPayload: failedPaymentPayload(),
      timestamp: BASE_TIMESTAMP,
    });
    await t.mutation(internal.payments.webhookMutations.processWebhookEvent, {
      webhookId: "wh_paid",
      eventType: "subscription.active",
      rawPayload: subscriptionActivePayload(),
      timestamp: BASE_TIMESTAMP,
    });

    const rows = await t.run(async (ctx) =>
      ctx.db.query("unattributedPaymentEvents").collect(),
    );
    const charged = rows.find((r) => r.charged);
    // Money moving must never be throttled behind a card-testing burst.
    expect(charged?.notifiedAt).toBeDefined();
  });

  test("a redelivery of the same message does not duplicate the row or the alert", async () => {
    const t = convexTest(schema, modules);

    // Same webhookId twice. The second is skipped by the webhookEvents
    // idempotency guard, so drive recordUnattributedEvent's own guard by
    // clearing that record between deliveries.
    await t.mutation(internal.payments.webhookMutations.processWebhookEvent, {
      webhookId: "wh_dupe",
      eventType: "payment.failed",
      rawPayload: failedPaymentPayload(),
      timestamp: BASE_TIMESTAMP,
    });
    await t.run(async (ctx) => {
      for (const e of await ctx.db.query("webhookEvents").collect()) {
        await ctx.db.delete(e._id);
      }
    });
    await t.mutation(internal.payments.webhookMutations.processWebhookEvent, {
      webhookId: "wh_dupe",
      eventType: "payment.failed",
      rawPayload: failedPaymentPayload(),
      timestamp: BASE_TIMESTAMP,
    });

    const rows = await t.run(async (ctx) =>
      ctx.db.query("unattributedPaymentEvents").collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].occurrences).toBe(2);
  });

  test("a known buyer's failed payment is still recorded — dunning signal intact", async () => {
    const t = convexTest(schema, modules);

    await t.run(async (ctx) => {
      await ctx.db.insert("customers", {
        userId: "user_known",
        dodoCustomerId: "cus_paylink_new",
        email: "buyer@enterprise.example",
        normalizedEmail: "buyer@enterprise.example",
        createdAt: BASE_TIMESTAMP,
        updatedAt: BASE_TIMESTAMP,
      });
    });

    await t.mutation(internal.payments.webhookMutations.processWebhookEvent, {
      webhookId: "wh_known_failed",
      eventType: "payment.failed",
      rawPayload: failedPaymentPayload(),
      timestamp: BASE_TIMESTAMP,
    });

    // The lenient unattributed path must not cost real users their dunning row.
    const { events, rows } = await t.run(async (ctx) => ({
      events: await ctx.db.query("paymentEvents").collect(),
      rows: await ctx.db.query("unattributedPaymentEvents").collect(),
    }));
    expect(rows).toHaveLength(0);
    expect(events).toHaveLength(1);
    expect(events[0].userId).toBe("user_known");
    expect(events[0].status).toBe("failed");
  });

  test("a known buyer is unaffected — no unattributed row, normal fulfillment", async () => {
    const t = convexTest(schema, modules);

    await t.run(async (ctx) => {
      await ctx.db.insert("customers", {
        userId: "user_known",
        dodoCustomerId: "cus_paylink_new",
        email: "buyer@enterprise.example",
        normalizedEmail: "buyer@enterprise.example",
        createdAt: BASE_TIMESTAMP,
        updatedAt: BASE_TIMESTAMP,
      });
    });

    await t.mutation(internal.payments.webhookMutations.processWebhookEvent, {
      webhookId: "wh_known",
      eventType: "subscription.active",
      rawPayload: subscriptionActivePayload(),
      timestamp: BASE_TIMESTAMP,
    });

    const { rows, subs } = await t.run(async (ctx) => ({
      rows: await ctx.db.query("unattributedPaymentEvents").collect(),
      subs: await ctx.db.query("subscriptions").collect(),
    }));
    expect(rows).toHaveLength(0);
    expect(subs).toHaveLength(1);
    expect(subs[0].userId).toBe("user_known");
  });
});
