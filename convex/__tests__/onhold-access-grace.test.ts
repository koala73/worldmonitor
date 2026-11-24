import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { PRODUCT_CATALOG } from "../config/productCatalog";
import schema from "../schema";
import { internal } from "../_generated/api";
import { getFeaturesForPlan } from "../lib/entitlements";
import { ON_HOLD_ACCESS_GRACE_MS, accessEndAt, hasAccessAt, isCoveringAt } from "../payments/subscriptionHelpers";
import { buildDunningEmail } from "../payments/subscriptionEmails";
import { formatAccessEndDate } from "../payments/cancellationEmailCopy";

const modules = import.meta.glob("../**/*.ts");
const DAY_MS = 86_400_000;
const PRO = PRODUCT_CATALOG.pro_monthly.dodoProductId!;
const PRO_ANNUAL = PRODUCT_CATALOG.pro_annual.dodoProductId!;
const BUSINESS = PRODUCT_CATALOG.api_business.dodoProductId!;
const SUB_ID = "sub_grace_001";
const USER = "grace-user";

// Fixed timeline, never the real clock.
const ACTIVATED = Date.UTC(2026, 11, 1);
const RENEWAL = ACTIVATED + 31 * DAY_MS;
const HOLD = RENEWAL + 1000;
const GRACE_END = HOLD + ON_HOLD_ACCESS_GRACE_MS;
const NEXT_RENEWAL = RENEWAL + 31 * DAY_MS;
const iso = (ms: number) => new Date(ms).toISOString();

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  delete process.env.RESEND_API_KEY;
});

type T = ReturnType<typeof convexTest>;

function payload(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      payload_type: "Subscription",
      subscription_id: SUB_ID,
      product_id: PRO,
      status: "active",
      customer: { customer_id: "cust_grace_001", email: "grace@example.com", name: "Grace" },
      metadata: { wm_user_id: USER },
      previous_billing_date: iso(ACTIVATED),
      next_billing_date: iso(RENEWAL),
      ...overrides,
    },
  };
}

const UNPAID_MONTH = { previous_billing_date: iso(RENEWAL), next_billing_date: iso(NEXT_RENEWAL) };

/** A Dodo `subscriptions.retrieve` result for the unpaid month, in the reconciler's test shape. */
function remote(status: string, productId = PRO) {
  return {
    subscription_id: SUB_ID,
    product_id: productId,
    status,
    customer: { customer_id: "cust_grace_001", email: "grace@example.com" },
    metadata: { wm_user_id: USER },
    ...UNPAID_MONTH,
  };
}

async function setup(planKey = "pro_monthly", productId = PRO) {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    await ctx.db.insert("productPlans", { dodoProductId: productId, planKey, displayName: planKey, isActive: true });
    await ctx.db.insert("customers", {
      userId: USER,
      dodoCustomerId: "cust_grace_001",
      email: "grace@example.com",
      createdAt: ACTIVATED,
      updatedAt: ACTIVATED,
    });
  });
  return t;
}

async function event(t: T, id: string, type: string, body: Record<string, unknown>, at: number) {
  vi.setSystemTime(at);
  await t.mutation(internal.payments.webhookMutations.processWebhookEvent, {
    webhookId: id,
    eventType: type,
    rawPayload: body,
    timestamp: at,
  });
}

async function charge(t: T, id: string, at: number, status: "succeeded" | "failed" = "succeeded") {
  await t.run(async (ctx) => {
    await ctx.db.insert("paymentEvents", {
      userId: USER,
      dodoPaymentId: id,
      type: "charge",
      amount: 3900,
      currency: "USD",
      status,
      dodoSubscriptionId: SUB_ID,
      rawPayload: {},
      occurredAt: at,
    });
  });
}

/** Activation with its paid first month (a succeeded charge, as production records it). */
async function activate(t: T, productId = PRO) {
  await event(t, "wh_active", "subscription.active", payload({ product_id: productId }), ACTIVATED);
  await charge(t, "pay_first", ACTIVATED);
}

/** Dodo's failed-renewal sequence: renewed (dates advance to the unpaid month), a failed charge, then on_hold. */
async function failRenewal(t: T, productId = PRO, holdAt = HOLD) {
  await activate(t, productId);
  const advanced = { product_id: productId, ...UNPAID_MONTH };
  await event(t, "wh_renewed", "subscription.renewed", payload(advanced), RENEWAL);
  await charge(t, "pay_failed", RENEWAL, "failed");
  await event(t, "wh_hold", "subscription.on_hold", payload({ ...advanced, status: "on_hold" }), holdAt);
}

async function subscriptionOf(t: T) {
  return t.run(async (ctx) => ctx.db.query("subscriptions")
    .withIndex("by_dodoSubscriptionId", (q) => q.eq("dodoSubscriptionId", SUB_ID)).unique());
}

async function entitlementOf(t: T, userId = USER) {
  return t.run(async (ctx) => ctx.db.query("entitlements").withIndex("by_userId", (q) => q.eq("userId", userId)).first());
}

async function checkoutBlocker(t: T, at: number, productId = PRO_ANNUAL) {
  vi.setSystemTime(at);
  return t.query(internal.payments.billing.getCheckoutBlockingSubscription, { userId: USER, productId });
}

describe("accessEndAt / hasAccessAt", () => {
  const stamped = { status: "on_hold" as const, currentPeriodEnd: HOLD + 30 * DAY_MS, accessEndsAt: GRACE_END };

  test("a stamped hold keeps access to its grace end only", () => {
    expect(accessEndAt(stamped)).toBe(GRACE_END);
    expect(hasAccessAt(stamped, GRACE_END - 1)).toBe(true);
    expect(hasAccessAt(stamped, GRACE_END)).toBe(false);
  });

  test("a paused hold still covers for billing", () => {
    expect(isCoveringAt(stamped, HOLD + 10 * DAY_MS)).toBe(true);
  });

  test("an unstamped hold keeps currentPeriodEnd", () => {
    const { accessEndsAt: _ignored, ...unstamped } = stamped;
    expect(accessEndAt(unstamped)).toBe(unstamped.currentPeriodEnd);
  });

  test("a cancel during the hold keeps the stamp; active ignores a stray one", () => {
    expect(accessEndAt({ ...stamped, status: "cancelled" })).toBe(GRACE_END);
    expect(accessEndAt({ ...stamped, status: "active" })).toBe(stamped.currentPeriodEnd);
  });

  test("the grace never extends past currentPeriodEnd", () => {
    expect(accessEndAt({ ...stamped, currentPeriodEnd: HOLD + DAY_MS })).toBe(HOLD + DAY_MS);
  });
});

describe("stamping the grace on entering a hold", () => {
  test("a failed renewal is stamped and the entitlement ends at the grace", async () => {
    vi.useFakeTimers();
    const t = await setup();
    await failRenewal(t);
    expect((await subscriptionOf(t))?.accessEndsAt).toBe(GRACE_END);
    const entitlement = await entitlementOf(t);
    expect(entitlement?.planKey).toBe("pro_monthly");
    expect(entitlement?.validUntil).toBe(GRACE_END);
  });

  test("a hold during a paid period is not stamped and keeps the period", async () => {
    vi.useFakeTimers();
    const t = await setup();
    await activate(t);
    await event(t, "wh_renewed", "subscription.renewed", payload(UNPAID_MONTH), RENEWAL);
    await charge(t, "pay_second", RENEWAL);
    const midPeriod = RENEWAL + 10 * DAY_MS;
    await event(t, "wh_hold", "subscription.on_hold", payload({ ...UNPAID_MONTH, status: "on_hold" }), midPeriod);
    expect((await subscriptionOf(t))?.accessEndsAt).toBeUndefined();
    expect((await entitlementOf(t))?.validUntil).toBe(NEXT_RENEWAL);
  });

  test("a hold that lands days after the renewal (late-settling methods) is still a failed renewal", async () => {
    vi.useFakeTimers();
    const t = await setup();
    const lateHold = RENEWAL + 5 * DAY_MS;
    await failRenewal(t, PRO, lateHold);
    expect((await subscriptionOf(t))?.accessEndsAt).toBe(lateHold + ON_HOLD_ACCESS_GRACE_MS);
  });

  test("a charge that settled the previous period late does not count as paying this one", async () => {
    vi.useFakeTimers();
    const t = await setup();
    await activate(t);
    // The previous invoice settles in the last hours of its own period.
    await charge(t, "pay_previous_late", RENEWAL - 12 * 60 * 60 * 1000);
    const advanced = { product_id: PRO, ...UNPAID_MONTH };
    await event(t, "wh_renewed", "subscription.renewed", payload(advanced), RENEWAL);
    await charge(t, "pay_failed", RENEWAL, "failed");
    await event(t, "wh_hold", "subscription.on_hold", payload({ ...advanced, status: "on_hold" }), HOLD);
    expect((await subscriptionOf(t))?.accessEndsAt).toBe(GRACE_END);
  });

  test("a retry failing after the grace leaves the user on free and the stamp unchanged", async () => {
    vi.useFakeTimers();
    const t = await setup();
    await failRenewal(t);
    await event(t, "wh_hold_retry", "subscription.on_hold", payload({ ...UNPAID_MONTH, status: "on_hold" }), HOLD + 10 * DAY_MS);
    expect((await subscriptionOf(t))?.accessEndsAt).toBe(GRACE_END);
    expect((await entitlementOf(t))?.planKey).toBe("free");
  });

  test("a hold that began before stamping existed keeps currentPeriodEnd, even on a repeat webhook", async () => {
    vi.useFakeTimers();
    const t = await setup();
    await failRenewal(t);
    await t.run(async (ctx) => {
      const sub = await ctx.db.query("subscriptions")
        .withIndex("by_dodoSubscriptionId", (q) => q.eq("dodoSubscriptionId", SUB_ID)).unique();
      await ctx.db.patch(sub!._id, { accessEndsAt: undefined });
    });
    await event(t, "wh_hold_retry", "subscription.on_hold", payload({ ...UNPAID_MONTH, status: "on_hold" }), HOLD + 10 * DAY_MS);
    expect((await subscriptionOf(t))?.accessEndsAt).toBeUndefined();
    expect((await entitlementOf(t))?.validUntil).toBe(NEXT_RENEWAL);
  });
});

describe("returning to active clears the grace", () => {
  async function cancelLater(t: T, at: number) {
    await event(t, "wh_cancel", "subscription.cancelled", payload({ ...UNPAID_MONTH, status: "cancelled", cancelled_at: iso(at) }), at);
  }

  test("recovered by subscription.active, then cancelled: access runs to the period end", async () => {
    vi.useFakeTimers();
    const t = await setup();
    await failRenewal(t);
    await event(t, "wh_recovered", "subscription.active", payload(UNPAID_MONTH), HOLD + 10 * DAY_MS);
    expect((await subscriptionOf(t))?.accessEndsAt).toBeUndefined();
    expect((await entitlementOf(t))?.validUntil).toBe(NEXT_RENEWAL);
    await cancelLater(t, HOLD + 12 * DAY_MS);
    expect((await entitlementOf(t))?.validUntil).toBe(NEXT_RENEWAL);
  });

  test("recovered by subscription.renewed, then cancelled: access runs to the period end", async () => {
    vi.useFakeTimers();
    const t = await setup();
    await failRenewal(t);
    await event(t, "wh_recovered", "subscription.renewed", payload(UNPAID_MONTH), HOLD + 10 * DAY_MS);
    expect((await subscriptionOf(t))?.accessEndsAt).toBeUndefined();
    await cancelLater(t, HOLD + 12 * DAY_MS);
    expect((await entitlementOf(t))?.validUntil).toBe(NEXT_RENEWAL);
  });

  test("recovered by the locked-hold sweep, then cancelled: access runs to the period end", async () => {
    vi.useFakeTimers();
    const t = await setup();
    await failRenewal(t);
    const sweepAt = HOLD + 10 * DAY_MS;
    vi.setSystemTime(sweepAt);
    const summary = await t.action(internal.payments.billing.reconcileLockedOnHoldSubscriptions, {
      now: sweepAt,
      remoteSubscriptionsForTest: [remote("active")],
    });
    expect(summary).toMatchObject({ inspected: 1, recovered: 1, failed: 0 });
    const sub = await subscriptionOf(t);
    expect(sub?.status).toBe("active");
    expect(sub?.accessEndsAt).toBeUndefined();
    expect((await entitlementOf(t))?.validUntil).toBe(NEXT_RENEWAL);
    await cancelLater(t, HOLD + 12 * DAY_MS);
    expect((await entitlementOf(t))?.validUntil).toBe(NEXT_RENEWAL);
  });
});

describe("cancel during a failed-renewal hold", () => {
  test("access ends at the grace, not the unpaid period end", async () => {
    vi.useFakeTimers();
    const t = await setup();
    await failRenewal(t);
    const cancelAt = HOLD + 2 * DAY_MS;
    await event(t, "wh_cancel", "subscription.cancelled", payload({ ...UNPAID_MONTH, status: "cancelled", cancelled_at: iso(cancelAt) }), cancelAt);
    expect((await subscriptionOf(t))?.accessEndsAt).toBe(GRACE_END);
    expect((await entitlementOf(t))?.validUntil).toBe(GRACE_END);
  });

  test("after the grace the cancelled row no longer blocks a new checkout", async () => {
    vi.useFakeTimers();
    const t = await setup();
    await failRenewal(t);
    const cancelAt = HOLD + 2 * DAY_MS;
    await event(t, "wh_cancel", "subscription.cancelled", payload({ ...UNPAID_MONTH, status: "cancelled", cancelled_at: iso(cancelAt) }), cancelAt);
    expect(await checkoutBlocker(t, cancelAt + DAY_MS)).toMatchObject({ status: "cancelled" });
    expect(await checkoutBlocker(t, GRACE_END + DAY_MS)).toBeNull();
  });

  test("the cancellation email promises the grace date, not the unpaid period end", async () => {
    vi.useFakeTimers();
    process.env.RESEND_API_KEY = "re_test";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    const t = await setup();
    await failRenewal(t);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    fetchMock.mockClear();
    const cancelAt = HOLD + 2 * DAY_MS;
    await event(t, "wh_cancel", "subscription.cancelled", payload({ ...UNPAID_MONTH, status: "cancelled", cancelled_at: iso(cancelAt) }), cancelAt);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const sends = fetchMock.mock.calls
      .filter(([url]) => String(url).includes("api.resend.com"))
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as { html: string });
    expect(sends).toHaveLength(1);
    expect(sends[0]!.html).toContain(formatAccessEndDate(GRACE_END));
    expect(sends[0]!.html).not.toContain(formatAccessEndDate(NEXT_RENEWAL));
  });
});

describe("paused holds and the billing relationship", () => {
  test("a paused hold still blocks a second checkout in the same family", async () => {
    vi.useFakeTimers();
    const t = await setup();
    await failRenewal(t);
    expect(await checkoutBlocker(t, HOLD + 10 * DAY_MS)).toMatchObject({ status: "on_hold" });
  });

  test("the on-demand renewal fallback does not re-grant the unpaid month", async () => {
    vi.useFakeTimers();
    const t = await setup();
    await failRenewal(t);
    const inGrace = await t.query(internal.payments.billing.getOnDemandRenewalFallbackState, { userId: USER, now: HOLD + DAY_MS });
    expect(inGrace.currentEntitlement?.validUntil).toBe(GRACE_END);
    const paused = await t.query(internal.payments.billing.getOnDemandRenewalFallbackState, { userId: USER, now: HOLD + 10 * DAY_MS });
    expect(paused.currentEntitlement).toBeNull();
  });

  test("the day-10 reminder for a paused hold says Pro is off, not that it ends with the paid period", async () => {
    vi.useFakeTimers();
    process.env.RESEND_API_KEY = "re_test";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    const t = await setup();
    await failRenewal(t);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    fetchMock.mockClear();
    vi.setSystemTime(HOLD + 10 * DAY_MS + 60_000);
    await t.mutation(internal.payments.subscriptionEmails.runDunningScan, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const sends = fetchMock.mock.calls
      .filter(([url]) => String(url).includes("api.resend.com"))
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as { subject: string; html: string });
    expect(sends).toHaveLength(1);
    expect(sends[0]!.subject).toContain("restore");
    expect(sends[0]!.html).toContain("are off");
    expect(sends[0]!.html).not.toContain("Once your paid period ends");
  });
});

describe("reconciler-delivered holds", () => {
  test("a stale-active row that Dodo reports on_hold is anchored and stamped", async () => {
    vi.useFakeTimers();
    const t = await setup();
    await activate(t);
    const observedAt = RENEWAL + 2 * DAY_MS;
    vi.setSystemTime(observedAt);
    await t.action(internal.payments.billing.reconcileMissedDodoRenewals, {
      now: observedAt,
      remoteSubscriptionsForTest: [remote("on_hold")],
    });
    const sub = await subscriptionOf(t);
    expect(sub?.status).toBe("on_hold");
    expect(sub?.onHoldAt).toBe(observedAt);
    expect(sub?.accessEndsAt).toBe(observedAt + ON_HOLD_ACCESS_GRACE_MS);
  });
});

describe("locked-hold recovery sweep", () => {
  test("a hold Dodo still reports on_hold is only recorded, and rechecked no sooner than 6 hours", async () => {
    vi.useFakeTimers();
    const t = await setup();
    await failRenewal(t);
    const sweepAt = HOLD + 10 * DAY_MS;
    vi.setSystemTime(sweepAt);
    const stillHeld = [remote("on_hold")];
    expect(await t.action(internal.payments.billing.reconcileLockedOnHoldSubscriptions, { now: sweepAt, remoteSubscriptionsForTest: stillHeld }))
      .toMatchObject({ inspected: 1, recovered: 0 });
    expect((await subscriptionOf(t))?.status).toBe("on_hold");
    expect(await t.action(internal.payments.billing.reconcileLockedOnHoldSubscriptions, { now: sweepAt + 60 * 60 * 1000, remoteSubscriptionsForTest: stillHeld }))
      .toMatchObject({ inspected: 0 });
    expect(await t.action(internal.payments.billing.reconcileLockedOnHoldSubscriptions, { now: sweepAt + 6 * 60 * 60 * 1000, remoteSubscriptionsForTest: stillHeld }))
      .toMatchObject({ inspected: 1 });
  });

  test("every locked hold gets a turn when there are more than one batch", async () => {
    vi.useFakeTimers();
    const t = await setup();
    await failRenewal(t);
    const sweepAt = HOLD + 10 * DAY_MS;
    // 50 more locked holds that end their period before the original one, so
    // index order puts the original last.
    await t.run(async (ctx) => {
      const base = await ctx.db.query("subscriptions")
        .withIndex("by_dodoSubscriptionId", (q) => q.eq("dodoSubscriptionId", SUB_ID)).unique();
      const { _id, _creationTime, ...fields } = base!;
      for (let i = 0; i < 50; i++) {
        await ctx.db.insert("subscriptions", {
          ...fields,
          dodoSubscriptionId: `sub_grace_extra_${i}`,
          userId: `grace-extra-${i}`,
          currentPeriodEnd: fields.currentPeriodEnd - (i + 1) * 60_000,
        });
      }
    });
    vi.setSystemTime(sweepAt);
    // No remotes: every lookup fails and is recorded as a check.
    const first = await t.action(internal.payments.billing.reconcileLockedOnHoldSubscriptions, { now: sweepAt, remoteSubscriptionsForTest: [] });
    expect(first.inspected).toBe(50);
    const nextAt = sweepAt + 6 * 60 * 60 * 1000;
    const next = await t.query(internal.payments.billing.listLockedOnHoldForRecovery, { now: nextAt });
    expect(next.map((row) => row.dodoSubscriptionId)[0]).toBe(SUB_ID);
  });

  test("a hold whose unpaid period has just ended is still looked up", async () => {
    vi.useFakeTimers();
    const t = await setup();
    await failRenewal(t);
    // A 28-day period with a 30-day retry window: Dodo can still recover it.
    const afterPeriod = NEXT_RENEWAL + 2 * DAY_MS;
    vi.setSystemTime(afterPeriod);
    const listed = await t.query(internal.payments.billing.listLockedOnHoldForRecovery, { now: afterPeriod });
    expect(listed.map((row) => row.dodoSubscriptionId)).toContain(SUB_ID);
  });

  test("recovery applies a plan change Dodo made during the hold", async () => {
    vi.useFakeTimers();
    const t = await setup("api_business", BUSINESS);
    await t.run(async (ctx) => {
      await ctx.db.insert("productPlans", { dodoProductId: PRO, planKey: "pro_monthly", displayName: "pro_monthly", isActive: true });
    });
    await failRenewal(t, BUSINESS);
    const sweepAt = HOLD + 10 * DAY_MS;
    vi.setSystemTime(sweepAt);
    // Dodo moved the subscription to Pro while it was on hold; that webhook was lost.
    const summary = await t.action(internal.payments.billing.reconcileLockedOnHoldSubscriptions, {
      now: sweepAt,
      remoteSubscriptionsForTest: [remote("active", PRO)],
    });
    expect(summary.recovered).toBe(1);
    const sub = await subscriptionOf(t);
    expect(sub?.status).toBe("active");
    expect(sub?.dodoProductId).toBe(PRO);
    expect(sub?.planKey).toBe("pro_monthly");
    expect((await entitlementOf(t))?.planKey).toBe("pro_monthly");
  });

  test("holds inside their grace are not looked up", async () => {
    vi.useFakeTimers();
    const t = await setup();
    await failRenewal(t);
    vi.setSystemTime(HOLD + DAY_MS);
    expect(await t.action(internal.payments.billing.reconcileLockedOnHoldSubscriptions, { now: HOLD + DAY_MS, remoteSubscriptionsForTest: [] }))
      .toMatchObject({ inspected: 0 });
  });
});

describe("Business owners", () => {
  test("an accepted invitee loses access with the owner at the end of the grace", async () => {
    vi.useFakeTimers();
    const t = await setup("api_business", BUSINESS);
    await activate(t, BUSINESS);
    await t.run(async (ctx) => {
      await ctx.db.insert("businessProGrants", {
        businessSubscriptionId: SUB_ID,
        ownerUserId: USER,
        inviteeEmail: "invitee@example.com",
        domain: "example.com",
        status: "accepted",
        inviteeUserId: "grace-invitee",
        createdAt: ACTIVATED,
        acceptedAt: ACTIVATED,
        expiresAt: NEXT_RENEWAL + 365 * DAY_MS,
      });
      await ctx.db.insert("entitlements", {
        userId: "grace-invitee",
        planKey: "pro_monthly",
        features: getFeaturesForPlan("pro_monthly"),
        validUntil: RENEWAL,
        updatedAt: ACTIVATED,
      });
    });
    const advanced = { product_id: BUSINESS, ...UNPAID_MONTH };
    await event(t, "wh_renewed_b", "subscription.renewed", payload(advanced), RENEWAL);
    await event(t, "wh_hold_b", "subscription.on_hold", payload({ ...advanced, status: "on_hold" }), HOLD);
    expect((await entitlementOf(t))?.validUntil).toBe(GRACE_END);
    expect((await entitlementOf(t, "grace-invitee"))?.validUntil).toBe(GRACE_END);
  });

  test("a hold found by the reconciler gives accepted invitees the same grace", async () => {
    vi.useFakeTimers();
    const t = await setup("api_business", BUSINESS);
    await activate(t, BUSINESS);
    await t.run(async (ctx) => {
      await ctx.db.insert("businessProGrants", {
        businessSubscriptionId: SUB_ID,
        ownerUserId: USER,
        inviteeEmail: "invitee@example.com",
        domain: "example.com",
        status: "accepted",
        inviteeUserId: "grace-invitee",
        createdAt: ACTIVATED,
        acceptedAt: ACTIVATED,
        expiresAt: NEXT_RENEWAL + 365 * DAY_MS,
      });
      await ctx.db.insert("entitlements", {
        userId: "grace-invitee",
        planKey: "pro_monthly",
        features: getFeaturesForPlan("pro_monthly"),
        validUntil: RENEWAL,
        updatedAt: ACTIVATED,
      });
    });
    // Both the renewal and hold webhooks were missed; the reconciler finds the hold.
    const observedAt = RENEWAL + 2 * DAY_MS;
    vi.setSystemTime(observedAt);
    await t.action(internal.payments.billing.reconcileMissedDodoRenewals, {
      now: observedAt,
      remoteSubscriptionsForTest: [remote("on_hold", BUSINESS)],
    });
    expect((await entitlementOf(t))?.validUntil).toBe(observedAt + ON_HOLD_ACCESS_GRACE_MS);
    expect((await entitlementOf(t, "grace-invitee"))?.validUntil).toBe(observedAt + ON_HOLD_ACCESS_GRACE_MS);
  });
});

describe("day-0 email names the date access ends", () => {
  test("copy states the access end date", () => {
    vi.useFakeTimers();
    vi.setSystemTime(HOLD);
    const email = buildDunningEmail("dunning_day0", "Pro (Monthly)", "https://example.test/portal", GRACE_END);
    expect(email.html).toContain(formatAccessEndDate(GRACE_END));
  });

  test("the send uses the grace end, not the unpaid period end", async () => {
    vi.useFakeTimers();
    process.env.RESEND_API_KEY = "re_test";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    const t = await setup();
    await failRenewal(t);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const sends = fetchMock.mock.calls
      .filter(([url]) => String(url).includes("api.resend.com"))
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as { subject: string; html: string });
    const day0 = sends.find((send) => send.subject.includes("payment failed"));
    expect(day0?.html).toContain(formatAccessEndDate(GRACE_END));
    expect(day0?.html).not.toContain(formatAccessEndDate(NEXT_RENEWAL));
  });
});
