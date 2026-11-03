import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Doc } from "../_generated/dataModel";
import { runEraseBatch } from "../accountDeletion/batches";
import { ERASE_WRITE_BUDGET, tombstoneUserId } from "../accountDeletion/registry";
import { getFeaturesForPlan } from "../lib/entitlements";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");
const NOW = 1_800_000_000_000;
const END = NOW + 30 * 86_400_000;
const USER = "user_cleanup";
const EMAIL = "cleanup@example.com";
const HASH = "a".repeat(64);
const REPLACEMENT = tombstoneUserId(HASH);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

async function seedDeletion(
  t: ReturnType<typeof convexTest>,
  step: Doc<"accountDeletions">["step"],
) {
  return t.run((ctx) => ctx.db.insert("accountDeletions", {
    userId: USER, userIdHash: HASH, verifiedEmail: EMAIL,
    source: "self", status: "pending", step,
    dodoSubscriptionIds: ["sub_cleanup"], startedAt: NOW, updatedAt: NOW,
  }));
}

describe("account deletion cleanup", () => {
  test("retains checkout and customer evidence while stripping the internal identity bridge", async () => {
    const t = convexTest(schema, modules);
    const deletionId = await seedDeletion(t, "anonymize");
    const payload = {
      subscription_id: "sub_cleanup", payment_id: "pay_cleanup", total_amount: 2900,
      currency: "USD", next_billing_date: new Date(END).toISOString(),
      customer: { customer_id: "cus_cleanup", email: EMAIL, name: "Deleted Person",
        phone_number: "+15555550123", address: { street: "Private Street" } },
      billing: { street: "Private Street", city: "Private City", zipcode: "12345" },
      metadata: { wm_login_email: EMAIL, wm_login_email_sig: "email-signature",
        wm_user_id: USER, wm_user_id_sig: "user-signature", campaign: "launch" },
      items: [{ billing_address: { street: "Private Street" }, phone: "+15555550123", amount: 2900 }],
    };
    const ids = await t.run(async (ctx) => ({
      subscription: await ctx.db.insert("subscriptions", {
        userId: USER, dodoSubscriptionId: "sub_cleanup", dodoProductId: "prod_test",
        planKey: "pro_monthly", status: "active", currentPeriodStart: NOW,
        currentPeriodEnd: END, rawPayload: payload, updatedAt: NOW,
      }),
      payment: await ctx.db.insert("paymentEvents", {
        userId: USER, dodoPaymentId: "pay_cleanup", type: "charge", amount: 2900,
        currency: "USD", status: "succeeded", rawPayload: { data: payload }, occurredAt: NOW,
      }),
    }));
    await t.run((ctx) => runEraseBatch(ctx, deletionId));
    const retained = await t.run(async (ctx) => ({
      subscription: await ctx.db.get(ids.subscription), payment: await ctx.db.get(ids.payment),
    }));
    const expected = {
      subscription_id: "sub_cleanup", payment_id: "pay_cleanup", total_amount: 2900,
      currency: "USD", next_billing_date: new Date(END).toISOString(),
      customer: payload.customer,
      billing: payload.billing,
      metadata: { campaign: "launch" },
      items: payload.items,
    };
    expect(retained.subscription?.rawPayload).toEqual(expected);
    expect(retained.payment?.rawPayload).toEqual({ data: expected });
    expect(retained.subscription?.userId).toBe(REPLACEMENT);
    expect(retained.payment?.userId).toBe(REPLACEMENT);
  });

  test("keeps every dunning ledger row with its real recipient email", async () => {
    const t = convexTest(schema, modules);
    const deletionId = await seedDeletion(t, "anonymize");
    const total = 5;
    await t.run(async (ctx) => {
      for (let i = 0; i < total; i++) {
        await ctx.db.insert("dunningEmails", {
          dodoSubscriptionId: "sub_cleanup", step: "dunning_day0", episodeAt: NOW + i,
          email: EMAIL, sentAt: NOW + i,
        });
      }
    });
    let batches = 0;
    let reachedExternal = false;
    for (; batches < 5; batches++) {
      const result = await t.run((ctx) => runEraseBatch(ctx, deletionId));
      const rows = await t.run((ctx) => ctx.db.query("dunningEmails").collect());
      if (result?.step === "external") {
        reachedExternal = true;
        expect(rows.every((row) => row.email === EMAIL)).toBe(true);
        break;
      }
    }
    expect(reachedExternal).toBe(true);
    const retained = await t.run((ctx) => ctx.db.query("dunningEmails").collect());
    expect(retained).toHaveLength(total);
    expect(new Set(retained.map((row) => row.episodeAt)).size).toBe(total);
  });

  test("revokes surviving invitees immediately while preserving independently paid access", async () => {
    const t = convexTest(schema, modules);
    const deletionId = await seedDeletion(t, "grants");
    await t.run(async (ctx) => {
      for (const invitee of ["user_seat_only", "user_paid", USER]) {
        await ctx.db.insert("businessProGrants", {
          businessSubscriptionId: "sub_cleanup", ownerUserId: USER,
          inviteeEmail: `${invitee}@example.com`, domain: "example.com", status: "accepted",
          inviteeUserId: invitee, createdAt: NOW, acceptedAt: NOW, expiresAt: END,
        });
        if (invitee !== USER) await ctx.db.insert("entitlements", {
          userId: invitee, planKey: "pro_monthly", features: getFeaturesForPlan("pro_monthly"),
          validUntil: END, updatedAt: NOW,
        });
      }
      await ctx.db.insert("subscriptions", {
        userId: "user_paid", dodoSubscriptionId: "sub_independent", dodoProductId: "prod_test",
        planKey: "pro_annual", status: "active", currentPeriodStart: NOW,
        currentPeriodEnd: END, rawPayload: {}, updatedAt: NOW,
      });
    });
    await t.run((ctx) => runEraseBatch(ctx, deletionId));
    const rows = await t.run((ctx) => ctx.db.query("entitlements").collect());
    expect(rows.find((row) => row.userId === "user_seat_only")?.planKey).toBe("free");
    expect(rows.find((row) => row.userId === "user_paid")?.planKey).toBe("pro_annual");
    expect(rows.find((row) => row.userId === USER)).toBeUndefined();
    expect(await t.run((ctx) => ctx.db.query("businessProGrants").collect())).toEqual([]);
  });

  test("does not recreate the entitlement of an invitee whose own deletion has started", async () => {
    const t = convexTest(schema, modules);
    const deletionId = await seedDeletion(t, "grants");
    await t.run(async (ctx) => {
      await ctx.db.insert("accountDeletions", {
        userId: "user_deleting_invitee", userIdHash: "b".repeat(64), source: "self",
        status: "pending", step: "external", startedAt: NOW, updatedAt: NOW,
      });
      await ctx.db.insert("businessProGrants", {
        businessSubscriptionId: "sub_cleanup", ownerUserId: USER, domain: "example.com",
        inviteeEmail: "invitee@example.com", inviteeUserId: "user_deleting_invitee",
        status: "accepted", createdAt: NOW, acceptedAt: NOW, expiresAt: END,
      });
    });
    await t.run((ctx) => runEraseBatch(ctx, deletionId));
    expect(await t.run((ctx) => ctx.db.query("entitlements").collect())).toEqual([]);
  });

  test("anonymizes referee identity across batches without deleting or duplicating earned credits", async () => {
    const t = convexTest(schema, modules);
    const deletionId = await seedDeletion(t, "email_keyed");
    const ids = await t.run(async (ctx) => {
      const inserted = [];
      for (let i = 0; i < ERASE_WRITE_BUDGET + 1; i++) {
        inserted.push(await ctx.db.insert("userReferralCredits", {
          referrerUserId: `user_referrer_${i}`, refereeEmail: EMAIL, createdAt: NOW + i,
        }));
      }
      await ctx.db.insert("userReferralCredits", {
        referrerUserId: "user_referrer_0", refereeEmail: "other@example.com", createdAt: NOW,
      });
      return inserted;
    });
    const first = await t.run((ctx) => runEraseBatch(ctx, deletionId));
    expect(first?.step).toBe("email_keyed");
    const second = await t.run((ctx) => runEraseBatch(ctx, deletionId));
    expect(second?.step).toBe("external");
    await t.run((ctx) => runEraseBatch(ctx, deletionId));
    const credits = await t.run((ctx) => ctx.db.query("userReferralCredits").collect());
    expect(credits).toHaveLength(ids.length + 1);
    for (const id of ids) expect(credits.find((row) => row._id === id)?.refereeEmail).toBe(REPLACEMENT);
    expect(credits.some((row) => row.refereeEmail === "other@example.com")).toBe(true);
    const originalPair = await t.run((ctx) => ctx.db.query("userReferralCredits")
      .withIndex("by_referrer_email", (q) => q.eq("referrerUserId", "user_referrer_0")
        .eq("refereeEmail", REPLACEMENT)).unique());
    expect(originalPair?._id).toBe(ids[0]);
  });
});
