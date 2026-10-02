import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");
const identity = {
  subject: "user_deleting",
  tokenIdentifier: "clerk|user_deleting",
  email: "deleting@example.com",
  emailVerified: true,
};
const states: Array<Pick<Doc<"accountDeletions">, "status" | "step">> = [
  { status: "pending", step: "personal" },
  { status: "pending", step: "external" },
  { status: "failed", step: "external" },
  { status: "complete", step: "complete" },
];

async function makeT(state: (typeof states)[number]) {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    await ctx.db.insert("accountDeletions", {
      userId: identity.subject,
      userIdHash: "a".repeat(64),
      source: "self",
      ...state,
      startedAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
  return t;
}

// Object data, not a bare string: Convex's HTTP client drops string-data
// `errorData`, so the Edge would see an opaque "Server Error" it retries as a
// transient 503 (WORLDMONITOR-PD / -14D).
const rejected = async (request: Promise<unknown>) => {
  const error = await request.then(
    () => { throw new Error("expected the write fence to reject"); },
    (err: unknown) => err,
  );
  expect(JSON.parse(String((error as { data?: unknown }).data))).toEqual({
    kind: "ACCOUNT_DELETION_IN_PROGRESS",
  });
};

for (const state of states) {
  describe(`write fence with ${state.status}/${state.step}`, () => {
    test("an active session cannot recreate profile or preference data", async () => {
      const t = await makeT(state);
      const user = t.withIdentity(identity);
      expect(await user.mutation(api.users.ensureRecord, {
        localeTag: "en-US", localePrimary: "en",
      })).toEqual({ ok: false, reason: "account-deletion" });
      expect(await t.mutation(internal.users.recordTermsAcceptance, {
        userId: identity.subject, email: identity.email,
      })).toEqual({ ok: false, reason: "account-deletion" });
      await rejected(user.mutation(api.userPreferences.setPreferences, {
        variant: "full", data: {}, expectedSyncVersion: 0,
      }));
      await t.run(async (ctx) => {
        expect(await ctx.db.query("users").collect()).toEqual([]);
        expect(await ctx.db.query("userPreferences").collect()).toEqual([]);
        expect(await ctx.db.query("userPreferenceWriteRateLimits").collect()).toEqual([]);
      });
    });

    test("credentials and follow metadata cannot be recreated", async () => {
      const t = await makeT(state);
      const user = t.withIdentity(identity);
      const key = { name: "stale session", keyHash: "a".repeat(64), keyPrefix: "wm_abcdefgh" };
      await rejected(user.mutation(api.apiKeys.createApiKey, key));
      await rejected(user.mutation(api.embedKeys.createEmbedKey, { ...key, keyPrefix: "wme_abcdefgh" }));
      await rejected(t.mutation(internal.mcpProTokens.issueProMcpToken, { userId: identity.subject }));
      await rejected(user.mutation(api.followedCountries.followCountry, { country: "US" }));
      await rejected(user.mutation(api.followedCountries.unfollowCountry, { country: "US" }));
      await rejected(user.mutation(api.followedCountries.mergeAnonymousLocal, { countries: ["US"] }));
      await t.run(async (ctx) => {
        expect(await ctx.db.query("userApiKeys").collect()).toEqual([]);
        expect(await ctx.db.query("embedKeys").collect()).toEqual([]);
        expect(await ctx.db.query("mcpProTokens").collect()).toEqual([]);
        expect(await ctx.db.query("followedCountries").collect()).toEqual([]);
        expect(await ctx.db.query("followedCountriesUserMeta").collect()).toEqual([]);
      });
    });

    test("notification sessions and delayed OAuth or Telegram callbacks stay fenced", async () => {
      const t = await makeT(state);
      const user = t.withIdentity(identity);
      const userId = identity.subject;
      await rejected(user.mutation(api.notificationChannels.setChannel, {
        channelType: "email", email: identity.email,
      }));
      await rejected(user.mutation(api.notificationChannels.createPairingToken, {}));
      await rejected(t.mutation(internal.notificationChannels.setChannelForUser, {
        userId, channelType: "email", email: identity.email,
        verifiedAccountEmail: identity.email, scheduleWelcome: false,
      }));
      await rejected(t.mutation(internal.notificationChannels.setWebPushChannelForUser, {
        userId, endpoint: "https://push.example.com/sub", p256dh: "key", auth: "auth",
      }));
      await rejected(t.mutation(internal.notificationChannels.setSlackOAuthChannelForUser, {
        userId, webhookEnvelope: "encrypted-slack",
      }));
      await rejected(t.mutation(internal.notificationChannels.setDiscordOAuthChannelForUser, {
        userId, webhookEnvelope: "encrypted-discord",
      }));
      await rejected(t.mutation(internal.notificationChannels.createPairingTokenForUser, { userId }));
      const tokenId = await t.run((ctx) => ctx.db.insert("telegramPairingTokens", {
        userId, token: "before-deletion", used: false, expiresAt: Date.now() + 60_000,
      }));
      await rejected(t.mutation(internal.notificationChannels.claimPairingToken, {
        token: "before-deletion", chatId: "12345",
      }));
      await t.run(async (ctx) => {
        expect(await ctx.db.query("notificationChannels").collect()).toEqual([]);
        expect((await ctx.db.get(tokenId))?.used).toBe(false);
        expect(await ctx.db.query("telegramPairingTokens").collect()).toHaveLength(1);
      });
    });

    test("every public and internal alert-settings writer is fenced", async () => {
      const t = await makeT(state);
      const user = t.withIdentity(identity);
      const userId = identity.subject;
      const rules = { variant: "full", enabled: true, channels: [], eventTypes: [] };
      const digest = { variant: "full", digestMode: "daily" as const };
      const quiet = { variant: "full", quietHoursEnabled: false };
      await rejected(user.mutation(api.alertRules.setAlertRules, rules));
      await rejected(user.mutation(api.alertRules.setDigestSettings, digest));
      await rejected(user.mutation(api.alertRules.setQuietHours, quiet));
      await rejected(t.mutation(internal.alertRules.setAlertRulesForUser, { ...rules, userId }));
      await rejected(t.mutation(internal.alertRules.setDigestSettingsForUser, { ...digest, userId }));
      await rejected(t.mutation(internal.alertRules.setQuietHoursForUser, { ...quiet, userId }));
      await rejected(t.mutation(internal.alertRules.setNotificationConfigForUser, { userId, variant: "full" }));
      expect(await t.run((ctx) => ctx.db.query("alertRules").collect())).toEqual([]);
    });

    test("billing sessions cannot recreate admission, activation, grant or entitlement rows", async () => {
      const t = await makeT(state);
      const user = t.withIdentity(identity);
      const { subscriptionId, grantId } = await t.run(async (ctx) => {
        const subscriptionId = await ctx.db.insert("subscriptions", {
          userId: identity.subject, dodoSubscriptionId: "sub_before_deletion",
          dodoProductId: "pdt_pro", planKey: "pro", status: "active",
          currentPeriodStart: Date.now(), currentPeriodEnd: Date.now() + 86_400_000,
          rawPayload: {}, updatedAt: Date.now(),
        });
        const grantId = await ctx.db.insert("businessProGrants", {
          businessSubscriptionId: "sub_before_deletion", ownerUserId: identity.subject,
          inviteeEmail: "teammate@company.test", domain: "company.test", status: "pending",
          createdAt: Date.now(), expiresAt: Date.now() + 86_400_000,
        });
        return { subscriptionId, grantId };
      });
      await rejected(t.mutation(internal.payments.checkout.admitCheckout, { userId: identity.subject }));
      await rejected(t.mutation(internal.payments.billing.grantComplimentaryEntitlement, {
        userId: identity.subject, planKey: "pro", days: 30,
      }));
      const activation = { activationKey: subscriptionId, claimNonce: "stale-session" };
      await rejected(user.mutation(api.payments.billing.claimProActivationPresentation, activation));
      await rejected(user.mutation(api.payments.billing.confirmProActivationPresentation, activation));
      await rejected(user.mutation(api.payments.billing.openProActivationDay0Presentation, activation));
      await rejected(user.mutation(api.payments.billing.recordProActivationOutcome, {
        ...activation, confirmedSteps: [], skippedSteps: [], failedSteps: [], revision: 1, finalized: false,
      }));
      await rejected(user.mutation(api.payments.billing.claimSubscription, {
        anonId: "46e76f56-a3d1-41ee-aab2-589eef3565bf",
      }));
      await rejected(user.mutation(api.payments.businessSeats.inviteSeats, { emails: ["new@company.test"] }));
      await rejected(user.mutation(api.payments.businessSeats.acceptBusinessInvite, { grantId, token: "stale" }));
      // A surviving invitee must not claim an owner's seat after owner deletion started.
      await rejected(t.withIdentity({
        subject: "teammate", tokenIdentifier: "clerk|teammate", email: "teammate@company.test",
      }).mutation(api.payments.businessSeats.acceptBusinessInvite, { grantId, token: "stale" }));
      await t.run(async (ctx) => {
        expect(await ctx.db.query("checkoutAdmissions").collect()).toEqual([]);
        expect(await ctx.db.query("proActivationPresentations").collect()).toEqual([]);
        expect(await ctx.db.query("entitlements").collect()).toEqual([]);
        expect((await ctx.db.get(grantId))?.status).toBe("pending");
        expect(await ctx.db.query("businessProGrants").collect()).toHaveLength(1);
      });
    });

    test("delayed usage scans and referral minting cannot repopulate erased rows", async () => {
      const t = await makeT(state);
      await rejected(t.mutation(internal.registerInterest.registerUserReferralCode, {
        userId: identity.subject, code: "abc12345",
      }));
      await t.run((ctx) => ctx.db.insert("userReferralCodes", {
        userId: identity.subject, code: "before12", createdAt: Date.now(),
      }));
      await t.mutation(internal.registerInterest.register, {
        email: "new-person@example.com", referredBy: "before12",
      });
      expect(await t.mutation(internal.apiPlanLimitNotices.recordUsageEvaluation, {
        rollup: {
          userId: identity.subject, planKey: "api_starter", dimension: "api_daily_requests",
          windowKey: "today", windowStart: 1, windowEnd: 2, limit: 100, usage: 101,
          source: "test", sourceFreshAt: Date.now(), computedAt: Date.now(),
        },
        notice: { state: "over_limit", ctaKind: "checkout" },
      })).toEqual({ rollupId: null, noticeId: null });
      await t.run(async (ctx) => {
        expect(await ctx.db.query("userReferralCredits").collect()).toEqual([]);
        expect(await ctx.db.query("userReferralCodes").collect()).toHaveLength(1);
        expect(await ctx.db.query("apiUsageRollups").collect()).toEqual([]);
        expect(await ctx.db.query("apiPlanLimitNotices").collect()).toEqual([]);
      });
    });
  });
}

test("the fence is subject-specific and permits another account's writes", async () => {
  const t = await makeT(states[0]!);
  const user = t.withIdentity({ subject: "surviving", tokenIdentifier: "clerk|surviving" });
  expect(await user.mutation(api.users.ensureRecord, {
    localeTag: "en-US", localePrimary: "en",
  })).toEqual({ ok: true, action: "inserted" });
  expect(await user.mutation(api.userPreferences.setPreferences, {
    variant: "full", data: {}, expectedSyncVersion: 0,
  })).toMatchObject({ ok: true });
  await t.mutation(internal.notificationChannels.setSlackOAuthChannelForUser, {
    userId: "surviving", webhookEnvelope: "encrypted-slack",
  });
  await t.run(async (ctx) => {
    expect(await ctx.db.query("users").collect()).toHaveLength(1);
    expect(await ctx.db.query("userPreferences").collect()).toHaveLength(1);
    expect(await ctx.db.query("notificationChannels").collect()).toHaveLength(1);
  });
});

describe.each([false, true])("billing repair after anonymization=%s", (anonymized) => {
  test("reconciliation retains accounting evidence with contact data but without the identity bridge", async () => {
    const t = await makeT(anonymized ? states[3]! : states[0]!);
    const retainedUserId = `deleted:${"a".repeat(64)}`;
    const userId = anonymized ? retainedUserId : identity.subject;
    const payload = {
      customer: { customer_id: "cus_deleted", email: identity.email, name: "Private Name" },
      metadata: { wm_user_id: identity.subject, wm_login_email: identity.email },
      total_amount: 2900,
    };
    const subscriptionId = await t.run((ctx) => ctx.db.insert("subscriptions", {
      userId, dodoSubscriptionId: "sub_reconcile", dodoProductId: "pdt_pro", planKey: "pro",
      status: "active", currentPeriodStart: 1, currentPeriodEnd: 2, rawPayload: {}, updatedAt: 1,
    }));
    expect(await t.mutation(internal.payments.billing.applyDodoSubscriptionReconciliation, {
      subscriptionId, dodoSubscriptionId: "sub_reconcile", observedAt: Date.now(),
      remote: {
        dodoSubscriptionId: "sub_reconcile", productId: "pdt_pro", status: "active",
        currentPeriodStart: 1, currentPeriodEnd: Date.now() + 86_400_000, rawPayload: payload,
      },
    })).toMatchObject({ kind: "reconciled" });
    expect(await t.mutation(internal.payments.billing.claimStuckPaymentReconciliation, {
      userId, dodoPaymentId: "pay_deleted", amount: 2900, currency: "USD",
      pendingOccurredAt: 1, observedStatus: "succeeded", rawPayload: payload,
    })).toEqual({ action: "terminal_reconciled" });
    expect(await t.mutation(internal.payments.billing.claimStuckPaymentReconciliation, {
      userId, dodoPaymentId: "pay_pending", amount: 2900, currency: "USD",
      pendingOccurredAt: 1, observedStatus: "processing", rawPayload: payload,
    })).toEqual({ action: "account_deleted" });
    await t.run(async (ctx) => {
      const subscription = await ctx.db.get(subscriptionId);
      const [payment] = await ctx.db.query("paymentEvents").collect();
      expect(subscription?.userId).toBe(retainedUserId);
      expect(payment).toMatchObject({ userId: retainedUserId, amount: 2900 });
      expect(subscription?.rawPayload).toEqual((payment?.rawPayload as { data?: unknown }).data ?? payment?.rawPayload);
      expect(JSON.stringify(payment?.rawPayload)).toContain(identity.email);
      expect(JSON.stringify(payment?.rawPayload)).not.toContain(identity.subject);
      expect(JSON.stringify(payment?.rawPayload)).not.toContain("wm_user_id");
      expect(JSON.stringify(payment?.rawPayload)).not.toContain("wm_login_email");
      expect(await ctx.db.query("entitlements").collect()).toEqual([]);
    });
  });

  test("customer repair and operator backfill skip deleted owners", async () => {
    const t = await makeT(anonymized ? states[3]! : states[0]!);
    const userId = anonymized ? `deleted:${"a".repeat(64)}` : identity.subject;
    await t.run((ctx) => ctx.db.insert("subscriptions", {
      userId, dodoSubscriptionId: "sub_backfill", dodoProductId: "pdt_pro", planKey: "pro",
      status: "active", currentPeriodStart: 1, currentPeriodEnd: 2, updatedAt: 1,
      rawPayload: { customer: { customer_id: "cus_deleted", email: identity.email } },
    }));
    expect(await t.mutation(internal.payments.billing.repairCustomerFromSubscriptionPayload, { userId })).toBeNull();
    expect(await t.mutation(internal.payments.billing.backfillMissingCustomers, {}))
      .toMatchObject({ repaired: 0, skippedDeleted: 1 });
    expect(await t.run((ctx) => ctx.db.query("customers").collect())).toEqual([]);
  });
});
