import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import { PRODUCT_CATALOG } from "../config/productCatalog";
import { signBusinessInviteToken } from "../lib/identitySigning";

const modules = import.meta.glob("../**/*.ts");
const NOW = 1_800_000_000_000;
const END = NOW + 365 * 86_400_000;
const owner = { subject: "annual_owner", email: "owner@acme.test" };
const invitee = { subject: "annual_invitee", email: "member@other.test" };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubEnv("DODO_IDENTITY_SIGNING_SECRET", "synthetic-annual-seat-secret");
  vi.stubEnv("RESEND_API_KEY", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

async function setup(planKey = "api_business_annual") {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    await ctx.db.insert("subscriptions", {
      userId: owner.subject, dodoSubscriptionId: "sub_annual",
      dodoProductId: PRODUCT_CATALOG[planKey].dodoProductId!, planKey,
      status: "active", currentPeriodStart: NOW - 1000,
      currentPeriodEnd: END, rawPayload: {}, updatedAt: NOW,
    });
  });
  return t;
}

async function seedGrant(t: ReturnType<typeof convexTest>, accepted = true) {
  return t.run((ctx) => ctx.db.insert("businessProGrants", {
    businessSubscriptionId: "sub_annual", ownerUserId: owner.subject,
    inviteeEmail: invitee.email, domain: "other.test",
    status: accepted ? "accepted" : "pending", createdAt: NOW,
    expiresAt: NOW + 86_400_000,
    ...(accepted ? { inviteeUserId: invitee.subject, acceptedAt: NOW } : {}),
  }));
}

async function entitlement(t: ReturnType<typeof convexTest>) {
  return t.run((ctx) => ctx.db.query("entitlements")
    .withIndex("by_userId", (q) => q.eq("userId", invitee.subject)).unique());
}

async function webhook(t: ReturnType<typeof convexTest>, type: string, planKey: string, timestamp: number) {
  await t.mutation(internal.payments.webhookMutations.processWebhookEvent, {
    webhookId: `annual_${type}_${timestamp}`, eventType: type, timestamp,
    rawPayload: { type, data: {
      subscription_id: "sub_annual", product_id: PRODUCT_CATALOG[planKey].dodoProductId!,
      customer: { customer_id: "cus_synthetic" },
      next_billing_date: new Date(END).toISOString(),
    } },
  });
}

test("annual owner issues four seats and can list them, with the same cap", async () => {
  const t = await setup();
  const result = await t.withIdentity(owner).mutation(api.payments.businessSeats.inviteSeats, {
    emails: [invitee.email, "two@other.test", "three@other.test", "four@other.test"],
  });
  expect(result.invited).toHaveLength(4);
  const listed = await t.withIdentity(owner).query(api.payments.businessSeats.listSeats, {});
  expect(listed.businessSubscriptionId).toBe("sub_annual");
  expect(listed.seats).toHaveLength(4);
  await expect(t.withIdentity(owner).mutation(api.payments.businessSeats.inviteSeats, {
    emails: ["five@other.test"],
  })).rejects.toThrow("SEAT_CAP_REACHED");
});

test.each(["api_starter_annual", "pro_business_annual"])("%s cannot issue Business seats", async (planKey) => {
  const t = await setup(planKey);
  await expect(t.withIdentity(owner).mutation(api.payments.businessSeats.inviteSeats, {
    emails: [invitee.email],
  })).rejects.toThrow("OWNER_NOT_BUSINESS");
});

test("expired annual coverage cannot issue or redeem seats", async () => {
  const t = await setup();
  const grantId = await seedGrant(t, false);
  await t.run(async (ctx) => {
    const sub = await ctx.db.query("subscriptions").unique();
    await ctx.db.patch(sub!._id, { status: "expired" });
  });
  await expect(t.withIdentity(owner).mutation(api.payments.businessSeats.inviteSeats, {
    emails: [invitee.email],
  })).rejects.toThrow("OWNER_NOT_BUSINESS");
  await expect(t.withIdentity(invitee).mutation(api.payments.businessSeats.acceptBusinessInvite, {
    grantId, token: await signBusinessInviteToken(grantId),
  })).rejects.toThrow("BUSINESS_NOT_ACTIVE");
});

test("annual invite redemption grants Pro and reconciliation retains it", async () => {
  const t = await setup();
  const grantId = await seedGrant(t, false);
  await t.withIdentity(invitee).mutation(api.payments.businessSeats.acceptBusinessInvite, {
    grantId, token: await signBusinessInviteToken(grantId),
  });
  expect(await entitlement(t)).toMatchObject({ planKey: "pro_monthly", validUntil: END });
  expect(await t.mutation(internal.payments.subscriptionHelpers.reconcileBusinessProGrants, {}))
    .toMatchObject({ revoked: 0, failed: 0 });
  expect(await t.run((ctx) => ctx.db.get(grantId))).toMatchObject({ status: "accepted" });
});

test("existing annual grants confer Pro on recompute and survive reconciliation", async () => {
  const t = await setup();
  await seedGrant(t);
  await t.mutation(internal.payments.subscriptionHelpers.recomputeEntitlementForUser, { userId: invitee.subject });
  expect(await entitlement(t)).toMatchObject({ planKey: "pro_monthly", validUntil: END });
  expect(await t.mutation(internal.payments.subscriptionHelpers.reconcileBusinessProGrants, {}))
    .toMatchObject({ revoked: 0 });
});

test("monthly to annual and back retains seats; leaving Business revokes them", async () => {
  const t = await setup("api_business");
  const grantId = await seedGrant(t);
  await webhook(t, "subscription.plan_changed", "api_business_annual", NOW + 1000);
  expect(await t.run((ctx) => ctx.db.get(grantId))).toMatchObject({ status: "accepted" });
  await webhook(t, "subscription.plan_changed", "api_business", NOW + 2000);
  expect(await t.run((ctx) => ctx.db.get(grantId))).toMatchObject({ status: "accepted" });
  await webhook(t, "subscription.plan_changed", "api_business_annual", NOW + 3000);
  await webhook(t, "subscription.plan_changed", "api_starter_annual", NOW + 4000);
  expect(await t.run((ctx) => ctx.db.get(grantId))).toMatchObject({ status: "revoked" });
  expect(await entitlement(t)).toMatchObject({ planKey: "free" });
});

test("annual expiration immediately revokes accepted seats", async () => {
  const t = await setup();
  const grantId = await seedGrant(t);
  await webhook(t, "subscription.expired", "api_business_annual", NOW + 1000);
  expect(await t.run((ctx) => ctx.db.get(grantId))).toMatchObject({ status: "revoked" });
  expect(await entitlement(t)).toMatchObject({ planKey: "free" });
});

test("paid-through annual cancellation retains seats until scheduled revocation", async () => {
  const t = await setup();
  const grantId = await seedGrant(t);
  vi.setSystemTime(NOW + 1000);
  await webhook(t, "subscription.cancelled", "api_business_annual", NOW + 1000);
  expect(await t.run((ctx) => ctx.db.get(grantId))).toMatchObject({ status: "accepted" });
  await t.mutation(internal.payments.subscriptionHelpers.recomputeEntitlementForUser, { userId: invitee.subject });
  expect(await entitlement(t)).toMatchObject({ planKey: "pro_monthly", validUntil: END });
  vi.setSystemTime(END + 1);
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(await t.run((ctx) => ctx.db.get(grantId))).toMatchObject({ status: "revoked" });
});
