import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import { getFeaturesForPlan } from "../lib/entitlements";
import {
  companyMonitoringOwnerFenceCandidates,
  signAnonClaimToken,
  signCompanyMonitoringOwnerFence,
  signUserId,
} from "../lib/identitySigning";
import {
  accountFor,
  CM,
  company,
  FUTURE,
  grant,
  grantProvisioned,
  installCompanyMonitoringTestEnvironment,
  INTERMEDIATE_OWNER_FENCE_SECRET,
  modules,
  NEW_OWNER_FENCE_SECRET,
  NOW,
  OLD_OWNER_FENCE_SECRET,
  OWNER_A,
  OWNER_B,
  ROTATED_DODO_IDENTITY_SIGNING_SECRET,
  schema,
  setStoredEntitlement,
  TEST_OWNER_FENCE_SECRET,
} from "./companyMonitoring.helpers";

installCompanyMonitoringTestEnvironment();

describe("Company Monitoring account lifecycle", () => {
  // #6256 acceptance criterion, proven by ablation rather than by asserting an
  // absence: with the fence secret deleted, ANY Company Monitoring work on this
  // path would throw. The grant succeeding is positive evidence that the
  // entitlement write never reached Company Monitoring at all.
  test.each([
    ["grantComplimentaryEntitlement", async (t: ReturnType<typeof convexTest>) => {
      await grant(t, OWNER_A);
    }],
    ["a Dodo subscription webhook", async (t: ReturnType<typeof convexTest>) => {
      await t.run(async (ctx) => {
        await ctx.db.insert("productPlans", {
          dodoProductId: "pdt-decoupled",
          planKey: "pro_monthly",
          displayName: "Pro Monthly",
          isActive: true,
        });
      });
      await t.mutation(internal.payments.webhookMutations.processWebhookEvent, {
        webhookId: "wh-decoupled",
        eventType: "subscription.active",
        rawPayload: {
          type: "subscription.active",
          business_id: "biz-test",
          timestamp: new Date(NOW).toISOString(),
          data: {
            payload_type: "Subscription",
            subscription_id: "sub-decoupled",
            product_id: "pdt-decoupled",
            status: "active",
            previous_billing_date: new Date(NOW - 1000).toISOString(),
            next_billing_date: new Date(FUTURE).toISOString(),
            customer: { customer_id: "cust-decoupled", email: "owner@example.com" },
            // Signed so tryResolveUserId attributes the event and a REAL
            // entitlement is written — otherwise the event lands unattributed
            // and the assertion below would pass vacuously. The point of this
            // case is that a genuinely attributed entitlement write still does
            // no Company Monitoring work.
            metadata: {
              wm_user_id: OWNER_A,
              wm_user_id_sig: await signUserId(OWNER_A),
            },
          },
        },
        timestamp: NOW,
      });
    }],
  ])(
    "%s performs no Company Monitoring work for a user with no root",
    async (_caseName, writeEntitlement) => {
      const t = convexTest(schema, modules);
      delete process.env.COMPANY_MONITORING_OWNER_FENCE_SECRET;

      await expect(writeEntitlement(t)).resolves.not.toThrow();

      const state = await t.run(async (ctx) => ({
        entitlements: await ctx.db.query("entitlements").collect(),
        accounts: await ctx.db.query("companyMonitoringAccounts").collect(),
      }));
      expect(state.entitlements.length).toBeGreaterThan(0);
      expect(state.accounts).toEqual([]);
    },
  );

  test("first authenticated use provisions the root the entitlement write did not", async () => {
    const t = convexTest(schema, modules);
    await grant(t, OWNER_A);
    expect(await accountFor(t, OWNER_A)).toBeNull();

    const created = await t.mutation(CM.companies.createCompanyForOwner, {
      ownerUserId: OWNER_A,
      clientRequestId: "first-use",
      company: company("First Use", "first-use"),
    });

    expect(created.status).toBe("created");
    expect(await accountFor(t, OWNER_A)).toMatchObject({
      ownerUserId: OWNER_A,
      lifecycle: "entitled",
      lifecycleSequence: 1,
      companyCount: 1,
    });
  });

  test("first use cannot resurrect a deleted owner", async () => {
    const t = convexTest(schema, modules);
    await grantProvisioned(t, OWNER_A);
    await t.mutation(CM.accounts.markOwnerDeleted, { ownerUserId: OWNER_A });

    // Re-entitled, then tries to use the feature: the tombstone must still win.
    await grant(t, OWNER_A);
    await expect(
      t.mutation(CM.companies.createCompanyForOwner, {
        ownerUserId: OWNER_A,
        clientRequestId: "post-deletion",
        company: company("Post Deletion", "post-deletion"),
      }),
    ).rejects.toThrow(/COMPANY_MONITORING_ACCESS_DENIED/);
    expect(await accountFor(t, OWNER_A)).toBeNull();
  });

  test("the reconciler lapses an entitled root whose entitlement expired", async () => {
    const t = convexTest(schema, modules);
    await grantProvisioned(t, OWNER_A);
    expect(await accountFor(t, OWNER_A)).toMatchObject({ lifecycle: "entitled" });

    // Expire the entitlement WITHOUT driving the sync — exactly what happens now
    // that billing no longer pushes into Company Monitoring.
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("entitlements")
        .withIndex("by_userId", (q) => q.eq("userId", OWNER_A))
        .unique();
      await ctx.db.patch(row!._id, { planKey: "free", validUntil: NOW - 1 });
    });
    expect(await accountFor(t, OWNER_A)).toMatchObject({ lifecycle: "entitled" });

    // The root must age past the recheck window before the reconciler sees it.
    vi.setSystemTime(NOW + 2 * 60 * 60 * 1000);
    const result = await t.mutation(CM.accounts.reconcileAccountEntitlements, {});

    expect(result).toMatchObject({ scanned: 1, scheduled: 1 });
    vi.advanceTimersByTime(1);
    await t.finishInProgressScheduledFunctions();
    expect(await accountFor(t, OWNER_A)).toMatchObject({
      lifecycle: "entitlement_lapsed",
      purgePhase: "pending",
    });
  });

  // The safety property the whole lazy design rests on. Moving lapse detection
  // to an hourly cron opens a window where a root still reads "entitled" after
  // the entitlement expired. That window is only acceptable because access is
  // re-derived from the entitlements row on every call, so it delays purge
  // SCHEDULING and never grants access. If this test goes green while
  // activeAccountForOwner trusts account.lifecycle, the refactor is an
  // access-control hole.
  test("an expired entitlement denies access immediately, before the reconciler runs", async () => {
    const t = convexTest(schema, modules);
    await grantProvisioned(t, OWNER_A);
    await t.mutation(CM.companies.createCompanyForOwner, {
      ownerUserId: OWNER_A,
      clientRequestId: "while-entitled",
      company: company("While Entitled", "while-entitled"),
    });

    // Expire the entitlement without running the reconciler.
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("entitlements")
        .withIndex("by_userId", (q) => q.eq("userId", OWNER_A))
        .unique();
      await ctx.db.patch(row!._id, { planKey: "free", validUntil: NOW - 1 });
    });
    // The root is deliberately still stale-"entitled" at this point.
    expect(await accountFor(t, OWNER_A)).toMatchObject({ lifecycle: "entitled" });

    // Every surface must already refuse: writes, reads, and key issuance.
    await expect(
      t.mutation(CM.companies.createCompanyForOwner, {
        ownerUserId: OWNER_A,
        clientRequestId: "after-expiry",
        company: company("After Expiry", "after-expiry"),
      }),
    ).rejects.toThrow(/COMPANY_MONITORING_ACCESS_DENIED/);
    await expect(
      t.query(CM.companies.listCompaniesForOwner, { ownerUserId: OWNER_A }),
    ).rejects.toThrow(/COMPANY_MONITORING_ACCESS_DENIED/);
    await expect(
      t.withIdentity({ subject: OWNER_A, tokenIdentifier: `clerk|${OWNER_A}` }).mutation(
        api.apiKeys.createApiKey,
        {
          name: "after-expiry",
          keyPrefix: "wm_abcde",
          keyHash: "a".repeat(64),
          scopes: ["company_monitoring:read"],
        },
      ),
    ).rejects.toThrow();
  });

  // The regression both review lenses caught. The 24h grace exists so a late
  // renewal can land before anything is scrubbed, and its only wire into
  // Company Monitoring was the entitlement-write call #6256 removed. Without
  // the purge-time recheck AND the lapsed-bucket scan, a customer who paid
  // again stays locked out and then loses their portfolio.
  test("a renewal during the grace window restores the root and cancels the purge", async () => {
    const t = convexTest(schema, modules);
    await grantProvisioned(t, OWNER_A);
    await t.mutation(CM.companies.createCompanyForOwner, {
      ownerUserId: OWNER_A,
      clientRequestId: "pre-lapse",
      company: company("Pre Lapse", "pre-lapse"),
    });

    // Renewal is late: entitlement expires and the reconciler lapses the root.
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("entitlements")
        .withIndex("by_userId", (q) => q.eq("userId", OWNER_A))
        .unique();
      await ctx.db.patch(row!._id, { planKey: "free", validUntil: NOW - 1 });
    });
    vi.setSystemTime(NOW + 2 * 60 * 60 * 1000);
    await t.mutation(CM.accounts.reconcileAccountEntitlements, {});
    vi.advanceTimersByTime(1);
    await t.finishInProgressScheduledFunctions();
    expect(await accountFor(t, OWNER_A)).toMatchObject({
      lifecycle: "entitlement_lapsed",
      purgePhase: "pending",
    });

    // The renewal lands — a raw entitlement write, exactly as production now
    // does it, with nothing pushing into Company Monitoring.
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("entitlements")
        .withIndex("by_userId", (q) => q.eq("userId", OWNER_A))
        .unique();
      await ctx.db.patch(row!._id, {
        planKey: "api_starter",
        features: getFeaturesForPlan("api_starter"),
        validUntil: NOW + 60 * 24 * 60 * 60 * 1000,
      });
    });

    // The reconciler must restore it, not just detect lapses.
    vi.setSystemTime(NOW + 4 * 60 * 60 * 1000);
    await t.mutation(CM.accounts.reconcileAccountEntitlements, {});
    vi.advanceTimersByTime(1);
    await t.finishInProgressScheduledFunctions();
    expect(await accountFor(t, OWNER_A)).toMatchObject({
      lifecycle: "entitled",
      purgePhase: "none",
    });

    // And the portfolio must have survived.
    const companies = await t.query(CM.companies.listCompaniesForOwner, {
      ownerUserId: OWNER_A,
    });
    expect(companies).toHaveLength(1);
    expect(companies[0]).toMatchObject({ name: "Pre Lapse" });
  });

  test("purge refuses to start destroying data for an owner who has paid again", async () => {
    const t = convexTest(schema, modules);
    await grantProvisioned(t, OWNER_A);
    await t.mutation(CM.companies.createCompanyForOwner, {
      ownerUserId: OWNER_A,
      clientRequestId: "paid-again",
      company: company("Paid Again", "paid-again"),
    });
    const root = await accountFor(t, OWNER_A);

    // Lapse it, then let the entitlement come back WITHOUT any reconciler run —
    // the scheduled purge job is already armed and about to fire.
    await setStoredEntitlement(t, OWNER_A, "free", NOW - 1);
    expect(await accountFor(t, OWNER_A)).toMatchObject({ purgePhase: "pending" });
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("entitlements")
        .withIndex("by_userId", (q) => q.eq("userId", OWNER_A))
        .unique();
      await ctx.db.patch(row!._id, {
        planKey: "api_starter",
        features: getFeaturesForPlan("api_starter"),
        validUntil: NOW + 60 * 24 * 60 * 60 * 1000,
      });
    });

    // The armed job fires after the grace deadline. It must re-derive the
    // entitlement and refuse rather than scrub a paying customer.
    vi.setSystemTime(NOW + 25 * 60 * 60 * 1000);
    const lapsed = await accountFor(t, OWNER_A);
    const result = await t.mutation(CM.accounts.advanceAccountPurge, {
      ownerFenceHash: lapsed!.ownerFenceHash,
      purgeGeneration: lapsed!.purgeGeneration,
    });

    expect(result).toEqual({ status: "reactivated" });
    expect(await accountFor(t, OWNER_A)).toMatchObject({
      _id: root?._id,
      lifecycle: "entitled",
      destructivePurgeStarted: false,
    });
    const surviving = await t.query(CM.companies.listCompaniesForOwner, {
      ownerUserId: OWNER_A,
    });
    expect(surviving).toHaveLength(1);
    expect(surviving[0]).toMatchObject({ name: "Paid Again" });
  });

  test("the reconciler ignores a root that is not yet stale", async () => {
    const t = convexTest(schema, modules);
    await grantProvisioned(t, OWNER_A);
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("entitlements")
        .withIndex("by_userId", (q) => q.eq("userId", OWNER_A))
        .unique();
      await ctx.db.patch(row!._id, { planKey: "free", validUntil: NOW - 1 });
    });

    // No time jump: the root was touched at NOW, so it sits inside the
    // ENTITLED_RECHECK_AGE_MS window. Without this case, deleting the
    // .lt("updatedAt", staleBefore) clause would leave the suite green.
    expect(await t.mutation(CM.accounts.reconcileAccountEntitlements, {}))
      .toMatchObject({ scanned: 0, scheduled: 0 });
    expect(await accountFor(t, OWNER_A)).toMatchObject({ lifecycle: "entitled" });

    vi.setSystemTime(NOW + 2 * 60 * 60 * 1000);
    expect(await t.mutation(CM.accounts.reconcileAccountEntitlements, {}))
      .toMatchObject({ scanned: 1, scheduled: 1 });
  });

  test("the reconciler caps each tick at its batch size and resumes on the next", async () => {
    const t = convexTest(schema, modules);
    const staleAt = NOW - 2 * 60 * 60 * 1000;
    // 51 entitled roots with no entitlement row: every one must lapse, so the
    // only thing bounding the first tick is the batch cap.
    // Real fence hashes: the reconciler re-resolves each row through
    // findAccountByOwnerFence, so a synthetic hash would make it scan the row
    // and then silently find nothing.
    const fences = await Promise.all(
      Array.from({ length: 51 }, (_, i) => signCompanyMonitoringOwnerFence(`user_batch_${i}`)),
    );
    await t.run(async (ctx) => {
      for (let i = 0; i < 51; i += 1) {
        await ctx.db.insert("companyMonitoringAccounts", {
          logicalAccountId: `cm_account_batch_${String(i).padStart(20, "0")}`,
          ownerUserId: `user_batch_${i}`,
          ownerFenceHash: fences[i]!,
          lifecycle: "entitled",
          lifecycleSequence: 1,
          companyCount: 0,
          companyLimit: 500,
          snapshotGeneration: 0,
          purgeGeneration: 0,
          purgePhase: "none",
          destructivePurgeStarted: false,
          pendingReactivation: false,
          createdAt: staleAt,
          updatedAt: staleAt,
        });
      }
    });

    const first = await t.mutation(CM.accounts.reconcileAccountEntitlements, {});
    expect(first).toMatchObject({ scanned: 50 });
    vi.advanceTimersByTime(1);
    await t.finishInProgressScheduledFunctions();

    // The cursor advance must let the 51st through rather than rescanning the
    // same 50 forever.
    const second = await t.mutation(CM.accounts.reconcileAccountEntitlements, {});
    expect(second.scanned).toBeGreaterThan(0);
    vi.advanceTimersByTime(1);
    await t.finishInProgressScheduledFunctions();

    const remaining = await t.run(async (ctx) =>
      ctx.db
        .query("companyMonitoringAccounts")
        .withIndex("by_lifecycle_updatedAt", (q) => q.eq("lifecycle", "entitled"))
        .collect(),
    );
    expect(remaining).toEqual([]);
  });

  test("the reconciler reserves room for a renewed lapsed root when entitled rows fill the batch", async () => {
    const t = convexTest(schema, modules);
    await grantProvisioned(t, OWNER_A);
    await setStoredEntitlement(t, OWNER_A, "free", NOW - 1);

    // Renew the canonical entitlement without pushing the change into Company
    // Monitoring. This stale lapsed root must compete with a full old-style
    // first bucket during the next scheduled reconciliation tick.
    await t.run(async (ctx) => {
      const entitlement = await ctx.db
        .query("entitlements")
        .withIndex("by_userId", (q) => q.eq("userId", OWNER_A))
        .unique();
      await ctx.db.patch(entitlement!._id, {
        planKey: "api_starter",
        features: getFeaturesForPlan("api_starter"),
        validUntil: FUTURE,
      });
    });

    const fences = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        signCompanyMonitoringOwnerFence(`user_mixed_batch_${i}`),
      ),
    );
    await t.run(async (ctx) => {
      for (let i = 0; i < 50; i += 1) {
        await ctx.db.insert("companyMonitoringAccounts", {
          logicalAccountId: `cm_account_mixed_${String(i).padStart(20, "0")}`,
          ownerUserId: `user_mixed_batch_${i}`,
          ownerFenceHash: fences[i]!,
          lifecycle: "entitled",
          lifecycleSequence: 1,
          companyCount: 0,
          companyLimit: 500,
          snapshotGeneration: 0,
          purgeGeneration: 0,
          purgePhase: "none",
          destructivePurgeStarted: false,
          pendingReactivation: false,
          createdAt: NOW,
          updatedAt: NOW,
        });
      }
    });

    vi.setSystemTime(NOW + 2 * 60 * 60 * 1000);
    const result = await t.mutation(CM.accounts.reconcileAccountEntitlements, {});
    expect(result).toEqual({ scanned: 50, scheduled: 50 });
    vi.advanceTimersByTime(1);
    await t.finishInProgressScheduledFunctions();

    expect(await accountFor(t, OWNER_A)).toMatchObject({
      lifecycle: "entitled",
      purgePhase: "none",
    });
  });

  test("the reconciler leaves a still-entitled root alone", async () => {
    const t = convexTest(schema, modules);
    await grantProvisioned(t, OWNER_A);
    const before = await accountFor(t, OWNER_A);

    vi.setSystemTime(NOW + 2 * 60 * 60 * 1000);
    const result = await t.mutation(CM.accounts.reconcileAccountEntitlements, {});

    expect(result).toMatchObject({ scanned: 1, scheduled: 1 });
    vi.advanceTimersByTime(1);
    await t.finishInProgressScheduledFunctions();
    const after = await accountFor(t, OWNER_A);
    expect(after).toMatchObject({
      lifecycle: "entitled",
      lifecycleSequence: before!.lifecycleSequence,
      purgePhase: "none",
    });
  });

  test("explicit owner deletion still fails loudly on a misconfigured fence", async () => {
    const t = convexTest(schema, modules);
    await grantProvisioned(t, OWNER_A);
    delete process.env.COMPANY_MONITORING_OWNER_FENCE_SECRET;

    // terminalize keeps the throwing accessor: deletion is an explicit
    // operation off the billing path, so a config fault must not be swallowed.
    await expect(
      t.mutation(CM.accounts.markOwnerDeleted, { ownerUserId: OWNER_A }),
    ).rejects.toThrow(/COMPANY_MONITORING_OWNER_FENCE_SECRET not set/);
  });

  test("authenticated grants create one immutable root and semantic replays do not advance sequence", async () => {
    const t = convexTest(schema, modules);

    await grantProvisioned(t, OWNER_A);
    const first = await accountFor(t, OWNER_A);
    expect(first).toMatchObject({
      ownerUserId: OWNER_A,
      lifecycle: "entitled",
      lifecycleSequence: 1,
      companyCount: 0,
      companyLimit: 500,
    });

    await t.mutation(CM.accounts.syncStoredEntitlement, { userId: OWNER_A });
    const replay = await accountFor(t, OWNER_A);
    expect(replay?._id).toBe(first?._id);
    expect(replay?.logicalAccountId).toBe(first?.logicalAccountId);
    expect(replay?.ownerFenceHash).toBe(first?.ownerFenceHash);
    expect(replay?.lifecycleSequence).toBe(1);
  });

  test("anonymous entitlement rows provision nothing until a proven authenticated claim", async () => {
    const t = convexTest(schema, modules);
    const anonId = "11111111-1111-4111-8111-111111111111";
    await setStoredEntitlement(t, anonId, "pro_monthly", FUTURE);

    const roots = await t.run(async (ctx) => ctx.db.query("companyMonitoringAccounts").collect());
    expect(roots).toEqual([]);

    await t.run(async (ctx) => {
      await ctx.db.insert("subscriptions", {
        userId: anonId,
        dodoSubscriptionId: "sub-company-monitoring-anon",
        dodoProductId: "pdt-company-monitoring-anon",
        planKey: "pro_monthly",
        status: "active",
        currentPeriodStart: NOW - 1000,
        currentPeriodEnd: FUTURE,
        rawPayload: {},
        updatedAt: NOW,
      });
    });
    const claimToken = await signAnonClaimToken(anonId);
    const realOwner = "user_company_monitoring_claimed";
    await t.withIdentity({ subject: realOwner, tokenIdentifier: `clerk|${realOwner}` }).mutation(
      api.payments.billing.claimSubscription,
      { anonId, claimToken },
    );

    // Claiming moves the entitlement to the real owner but provisions nothing:
    // it is still an entitlement write (#6256). The anon id must never gain a
    // root either, before or after the claim.
    expect(await accountFor(t, realOwner)).toBeNull();
    expect(await accountFor(t, anonId)).toBeNull();

    // The claimed owner can then provision on first use — the anon id cannot,
    // because ANON_ID_V4_REGEX still fences it out of the state machine.
    await t.mutation(CM.accounts.syncStoredEntitlement, { userId: realOwner });
    expect(await accountFor(t, realOwner)).toMatchObject({
      ownerUserId: realOwner,
      lifecycle: "entitled",
      lifecycleSequence: 1,
    });
    await t.mutation(CM.accounts.syncStoredEntitlement, { userId: anonId });
    expect(await accountFor(t, anonId)).toBeNull();
  });

  test("dispute loss lapses the root through the reconciler, not the webhook", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("subscriptions", {
        userId: OWNER_A,
        dodoSubscriptionId: "sub-company-monitoring-disputed",
        dodoProductId: "pdt-company-monitoring-disputed",
        planKey: "pro_monthly",
        status: "active",
        currentPeriodStart: NOW - 1000,
        currentPeriodEnd: FUTURE,
        rawPayload: {},
        updatedAt: NOW - 1000,
      });
      await ctx.db.insert("entitlements", {
        userId: OWNER_A,
        planKey: "pro_monthly",
        features: getFeaturesForPlan("pro_monthly"),
        validUntil: FUTURE,
        updatedAt: NOW - 1000,
      });
    });
    await t.mutation(CM.accounts.syncStoredEntitlement, { userId: OWNER_A });

    await t.mutation(internal.payments.webhookMutations.processWebhookEvent, {
      webhookId: "wh-company-monitoring-dispute-lost",
      eventType: "dispute.lost",
      rawPayload: {
        type: "dispute.lost",
        business_id: "biz-test",
        timestamp: new Date(NOW + 1000).toISOString(),
        data: {
          payload_type: "Payment",
          payment_id: "pay-company-monitoring-disputed",
          subscription_id: "sub-company-monitoring-disputed",
          total_amount: 1000,
          currency: "USD",
          customer: { customer_id: "cust-company-monitoring", email: "owner@example.com" },
          metadata: { wm_user_id: OWNER_A },
        },
      },
      timestamp: NOW + 1000,
    });

    // The webhook revokes the entitlement but must not touch the root (#6256).
    expect(await accountFor(t, OWNER_A)).toMatchObject({
      lifecycle: "entitled",
      lifecycleSequence: 1,
    });

    // The reconciler is what converges it.
    vi.setSystemTime(NOW + 2 * 60 * 60 * 1000);
    await t.mutation(CM.accounts.reconcileAccountEntitlements, {});
    vi.advanceTimersByTime(1);
    await t.finishInProgressScheduledFunctions();
    expect(await accountFor(t, OWNER_A)).toMatchObject({
      lifecycle: "entitlement_lapsed",
      lifecycleSequence: 2,
      purgePhase: "pending",
    });
  });

  test("lapse can reactivate before destructive purge but not after owner deletion", async () => {
    const t = convexTest(schema, modules);
    await grantProvisioned(t, OWNER_A);
    const original = await accountFor(t, OWNER_A);

    await setStoredEntitlement(t, OWNER_A, "free", NOW - 1);
    const lapsed = await accountFor(t, OWNER_A);
    expect(lapsed).toMatchObject({
      lifecycle: "entitlement_lapsed",
      lifecycleSequence: 2,
      destructivePurgeStarted: false,
    });

    await setStoredEntitlement(t, OWNER_A, "api_starter", FUTURE, NOW - 10_000);
    const reactivated = await accountFor(t, OWNER_A);
    expect(reactivated).toMatchObject({
      _id: original?._id,
      lifecycle: "entitled",
      lifecycleSequence: 3,
      destructivePurgeStarted: false,
      purgeGeneration: lapsed!.purgeGeneration + 1,
    });
    const stalePurge = await t.mutation(CM.accounts.advanceAccountPurge, {
      ownerFenceHash: lapsed!.ownerFenceHash,
      purgeGeneration: lapsed!.purgeGeneration,
    });
    expect(stalePurge).toEqual({ status: "stale" });
    expect(await accountFor(t, OWNER_A)).toEqual(reactivated);

    await t.mutation(CM.accounts.markOwnerDeleted, { ownerUserId: OWNER_A });
    const terminal = await t.run(async (ctx) =>
      ctx.db
        .query("companyMonitoringAccounts")
        .withIndex("by_ownerFenceHash", (q) => q.eq("ownerFenceHash", original!.ownerFenceHash))
        .unique(),
    );
    expect(terminal).toMatchObject({
      _id: original?._id,
      lifecycle: "denied",
      terminalReason: "owner_deleted",
      lifecycleSequence: 4,
    });
    expect(terminal?.ownerUserId).toBeUndefined();

    await setStoredEntitlement(t, OWNER_A, "api_starter", FUTURE + 1);
    const afterReplay = await t.run(async (ctx) =>
      ctx.db
        .query("companyMonitoringAccounts")
        .withIndex("by_ownerFenceHash", (q) => q.eq("ownerFenceHash", original!.ownerFenceHash))
        .unique(),
    );
    expect(afterReplay).toMatchObject({
      _id: original?._id,
      lifecycle: "denied",
      terminalReason: "owner_deleted",
      lifecycleSequence: 4,
    });
  });

  test("account deletion is the same durable terminal fence", async () => {
    const t = convexTest(schema, modules);
    await grantProvisioned(t, OWNER_A);
    const original = await accountFor(t, OWNER_A);
    await t.mutation(CM.accounts.markAccountDeleted, {
      ownerAccountId: original!.logicalAccountId,
    });
    await setStoredEntitlement(t, OWNER_A, "api_starter", FUTURE + 10_000);
    const terminal = await t.run(async (ctx) =>
      ctx.db
        .query("companyMonitoringAccounts")
        .withIndex("by_ownerFenceHash", (q) => q.eq("ownerFenceHash", original!.ownerFenceHash))
        .unique(),
    );
    expect(terminal).toMatchObject({
      _id: original?._id,
      lifecycle: "denied",
      terminalReason: "account_deleted",
      lifecycleSequence: 2,
    });
  });

  test("re-entitlement during destructive purge waits for the fenced generation to finish", async () => {
    const t = convexTest(schema, modules);
    await grantProvisioned(t, OWNER_A);
    await t.mutation(CM.companies.createCompanyForOwner, {
      ownerUserId: OWNER_A,
      clientRequestId: "before-purge",
      company: company("Purge Me", "purge-me"),
    });

    await setStoredEntitlement(t, OWNER_A, "free", NOW - 1);
    const lapsed = await accountFor(t, OWNER_A);
    vi.setSystemTime(lapsed!.purgeAfter!);
    await t.mutation(CM.accounts.advanceAccountPurge, {
      ownerFenceHash: lapsed!.ownerFenceHash,
      purgeGeneration: lapsed!.purgeGeneration,
    });
    expect(await accountFor(t, OWNER_A)).toMatchObject({ destructivePurgeStarted: true });

    await setStoredEntitlement(t, OWNER_A, "api_starter", FUTURE);
    expect(await accountFor(t, OWNER_A)).toMatchObject({
      lifecycle: "entitlement_lapsed",
      pendingReactivation: true,
    });

    await setStoredEntitlement(t, OWNER_A, "free", NOW - 1);
    expect(await accountFor(t, OWNER_A)).toMatchObject({
      lifecycle: "entitlement_lapsed",
      destructivePurgeStarted: true,
      pendingReactivation: false,
      purgeGeneration: lapsed!.purgeGeneration,
    });
    await setStoredEntitlement(t, OWNER_A, "api_starter", FUTURE);
    expect(await accountFor(t, OWNER_A)).toMatchObject({
      lifecycle: "entitlement_lapsed",
      destructivePurgeStarted: true,
      pendingReactivation: true,
      purgeGeneration: lapsed!.purgeGeneration,
    });

    for (let i = 0; i < 5; i += 1) {
      await t.mutation(CM.accounts.advanceAccountPurge, {
        ownerFenceHash: lapsed!.ownerFenceHash,
        purgeGeneration: lapsed!.purgeGeneration,
      });
    }
    expect(await accountFor(t, OWNER_A)).toMatchObject({
      lifecycle: "entitled",
      companyCount: 0,
      pendingReactivation: false,
      purgePhase: "none",
    });
  });

  test("re-entitlement after completed destructive purge restores a clean reusable root", async () => {
    const t = convexTest(schema, modules);
    await grantProvisioned(t, OWNER_A);
    const original = await accountFor(t, OWNER_A);
    const removedByPurge = await t.mutation(CM.companies.createCompanyForOwner, {
      ownerUserId: OWNER_A,
      clientRequestId: "completed-purge-old-company",
      company: company("Completed Purge Old Company", "completed-purge-old"),
    });

    await setStoredEntitlement(t, OWNER_A, "free", NOW - 1);
    const lapsed = await accountFor(t, OWNER_A);
    const purgeArgs = {
      ownerFenceHash: lapsed!.ownerFenceHash,
      purgeGeneration: lapsed!.purgeGeneration,
    };
    vi.setSystemTime(lapsed!.purgeAfter!);
    expect(await t.mutation(CM.accounts.advanceAccountPurge, purgeArgs)).toEqual({
      status: "started",
    });
    expect(await t.mutation(CM.accounts.advanceAccountPurge, purgeArgs)).toEqual({
      status: "finalizing",
    });
    expect(await t.mutation(CM.accounts.advanceAccountPurge, purgeArgs)).toEqual({
      status: "complete",
    });
    expect(await accountFor(t, OWNER_A)).toMatchObject({
      _id: original?._id,
      lifecycle: "entitlement_lapsed",
      companyCount: 0,
      purgePhase: "complete",
      destructivePurgeStarted: true,
    });

    await setStoredEntitlement(t, OWNER_A, "api_starter", FUTURE);
    expect(await accountFor(t, OWNER_A)).toMatchObject({
      _id: original?._id,
      lifecycle: "entitled",
      companyCount: 0,
      purgePhase: "none",
      destructivePurgeStarted: false,
      pendingReactivation: false,
    });
    const replacement = await t.mutation(CM.companies.createCompanyForOwner, {
      ownerUserId: OWNER_A,
      clientRequestId: "completed-purge-new-company",
      company: company("Completed Purge New Company", "completed-purge-new"),
    });
    expect(replacement.status).toBe("created");
    expect(replacement.companyId).not.toBe(removedByPurge.companyId);
    expect(await accountFor(t, OWNER_A)).toMatchObject({ companyCount: 1 });
    expect(await t.query(CM.companies.listCompaniesForOwner, { ownerUserId: OWNER_A })).toEqual([
      expect.objectContaining({
        companyId: replacement.companyId,
        name: "Completed Purge New Company",
      }),
    ]);
  });

  test("dense destructive purge continues across the bounded 93-company page", async () => {
    const t = convexTest(schema, modules);
    await grantProvisioned(t, OWNER_A);
    const root = await accountFor(t, OWNER_A);
    await t.run(async (ctx) => {
      for (let i = 0; i < 94; i += 1) {
        const companyId = `cm_company_${String(i).padStart(26, "0")}`;
        await ctx.db.insert("companyMonitoringCompanies", {
          ownerAccountId: root!.logicalAccountId,
          companyId,
          name: `Paged ${i}`,
          sortName: `paged ${String(i).padStart(3, "0")}`,
          domicileCountry: "US",
          lifecycle: "active",
          coverageState: "awaiting_first_scan",
          observationState: "unknown",
          snapshotGeneration: 1,
          purgeGeneration: 0,
          purgePhase: "none",
          createdAt: NOW,
          updatedAt: NOW,
        });
        for (let claimOrdinal = 0; claimOrdinal < 81; claimOrdinal += 1) {
          const claimNumber = i * 81 + claimOrdinal;
          await ctx.db.insert("companyMonitoringClaims", {
            ownerAccountId: root!.logicalAccountId,
            companyId,
            claimId: `cm_claim_${String(claimNumber).padStart(26, "0")}`,
            type: "alias",
            value: `Dense claim ${i}-${claimOrdinal}`,
            provenance: "customer",
            trustState: "unverified",
            createdAt: NOW,
            updatedAt: NOW,
          });
        }
      }
      await ctx.db.patch(root!._id, { companyCount: 94 });
    });
    await setStoredEntitlement(t, OWNER_A, "free", NOW - 1);
    const lapsed = await accountFor(t, OWNER_A);
    const purgeArgs = {
      ownerFenceHash: lapsed!.ownerFenceHash,
      purgeGeneration: lapsed!.purgeGeneration,
    };
    vi.setSystemTime(lapsed!.purgeAfter!);
    expect(await t.mutation(CM.accounts.advanceAccountPurge, purgeArgs)).toEqual({
      status: "started",
    });
    expect(await t.mutation(CM.accounts.advanceAccountPurge, purgeArgs)).toEqual({
      status: "companies",
    });
    expect(await accountFor(t, OWNER_A)).toMatchObject({
      purgePhase: "companies",
      destructivePurgeStarted: true,
    });
    const afterFirstPage = await t.run(async (ctx) => ({
      companies: await ctx.db
        .query("companyMonitoringCompanies")
        .withIndex("by_account_companyId", (q) => q.eq("ownerAccountId", root!.logicalAccountId))
        .collect(),
      claims: await ctx.db.query("companyMonitoringClaims").collect(),
    }));
    expect(afterFirstPage.companies.filter((row) => row.purgePhase === "complete")).toHaveLength(93);
    expect(afterFirstPage.companies.filter((row) => row.purgePhase === "none")).toHaveLength(1);
    expect(afterFirstPage.claims).toHaveLength(81);

    expect(await t.mutation(CM.accounts.advanceAccountPurge, purgeArgs)).toEqual({
      status: "finalizing",
    });
    expect(await accountFor(t, OWNER_A)).toMatchObject({ purgePhase: "finalizing" });
    expect(await t.mutation(CM.accounts.advanceAccountPurge, purgeArgs)).toEqual({
      status: "complete",
    });
    expect(await accountFor(t, OWNER_A)).toMatchObject({
      lifecycle: "entitlement_lapsed",
      purgePhase: "complete",
      companyCount: 0,
    });
    const completed = await t.run(async (ctx) =>
      ctx.db
        .query("companyMonitoringCompanies")
        .withIndex("by_account_companyId", (q) => q.eq("ownerAccountId", root!.logicalAccountId))
        .collect(),
    );
    expect(completed).toHaveLength(94);
    expect(completed.every((row) => row.lifecycle === "removed" && row.purgePhase === "complete")).toBe(true);
    expect(await t.run(async (ctx) => ctx.db.query("companyMonitoringClaims").collect())).toEqual([]);
  }, 15_000);

  test("Dodo identity-secret rotation cannot change a Company Monitoring owner fence", async () => {
    const originalFence = await signCompanyMonitoringOwnerFence(OWNER_A);
    const originalCheckoutSignature = await signUserId(OWNER_A);

    process.env.DODO_IDENTITY_SIGNING_SECRET = ROTATED_DODO_IDENTITY_SIGNING_SECRET;

    expect(await signCompanyMonitoringOwnerFence(OWNER_A)).toBe(originalFence);
    expect(await signUserId(OWNER_A)).not.toBe(originalCheckoutSignature);
  });

  test("dedicated owner-fence rotation finds and migrates an old nonterminal root", async () => {
    const t = convexTest(schema, modules);
    process.env.COMPANY_MONITORING_OWNER_FENCE_SECRET = OLD_OWNER_FENCE_SECRET;
    await grantProvisioned(t, OWNER_A);
    const oldRoot = await accountFor(t, OWNER_A);

    process.env.COMPANY_MONITORING_OWNER_FENCE_SECRET = NEW_OWNER_FENCE_SECRET;
    process.env.COMPANY_MONITORING_OWNER_FENCE_PREVIOUS_SECRETS = OLD_OWNER_FENCE_SECRET;
    const currentFenceHash = await signCompanyMonitoringOwnerFence(OWNER_A);
    await t.mutation(CM.accounts.syncStoredEntitlement, { userId: OWNER_A });

    const migrated = await accountFor(t, OWNER_A);
    expect(migrated).toMatchObject({
      _id: oldRoot?._id,
      logicalAccountId: oldRoot?.logicalAccountId,
      ownerFenceHash: currentFenceHash,
      lifecycle: "entitled",
    });
    expect(currentFenceHash).not.toBe(oldRoot?.ownerFenceHash);
    expect(await t.run(async (ctx) =>
      ctx.db
        .query("companyMonitoringAccounts")
        .withIndex("by_ownerFenceHash", (q) => q.eq("ownerFenceHash", oldRoot!.ownerFenceHash))
        .unique()
    )).toBeNull();
  });

  test("scheduled sync migrates a renewed lapsed root when old fence history was dropped", async () => {
    const t = convexTest(schema, modules);
    process.env.COMPANY_MONITORING_OWNER_FENCE_SECRET = OLD_OWNER_FENCE_SECRET;
    await grantProvisioned(t, OWNER_A);
    await setStoredEntitlement(t, OWNER_A, "free", NOW - 1);
    const oldRoot = await accountFor(t, OWNER_A);

    // The billing renewal only updates canonical entitlement state. Rotate the
    // current key without retaining history before the reconciler schedules the
    // per-owner sync.
    await t.run(async (ctx) => {
      const entitlement = await ctx.db
        .query("entitlements")
        .withIndex("by_userId", (q) => q.eq("userId", OWNER_A))
        .unique();
      await ctx.db.patch(entitlement!._id, {
        planKey: "api_starter",
        features: getFeaturesForPlan("api_starter"),
        validUntil: FUTURE,
      });
    });
    process.env.COMPANY_MONITORING_OWNER_FENCE_SECRET = NEW_OWNER_FENCE_SECRET;
    delete process.env.COMPANY_MONITORING_OWNER_FENCE_PREVIOUS_SECRETS;
    const currentFenceHash = await signCompanyMonitoringOwnerFence(OWNER_A);

    vi.setSystemTime(NOW + 2 * 60 * 60 * 1000);
    expect(await t.mutation(CM.accounts.reconcileAccountEntitlements, {}))
      .toEqual({ scanned: 1, scheduled: 1 });
    vi.advanceTimersByTime(1);
    await t.finishInProgressScheduledFunctions();

    const state = await t.run(async (ctx) => ({
      roots: await ctx.db.query("companyMonitoringAccounts").collect(),
      current: await ctx.db
        .query("companyMonitoringAccounts")
        .withIndex("by_ownerFenceHash", (q) => q.eq("ownerFenceHash", currentFenceHash))
        .unique(),
      old: await ctx.db
        .query("companyMonitoringAccounts")
        .withIndex("by_ownerFenceHash", (q) => q.eq("ownerFenceHash", oldRoot!.ownerFenceHash))
        .unique(),
    }));
    expect(state.roots).toHaveLength(1);
    expect(state.current).toMatchObject({
      _id: oldRoot?._id,
      logicalAccountId: oldRoot?.logicalAccountId,
      ownerUserId: OWNER_A,
      ownerFenceHash: currentFenceHash,
      lifecycle: "entitled",
      purgePhase: "none",
    });
    expect(state.old).toBeNull();
  });

  test("dedicated owner-fence rotation keeps two historical tombstones discoverable in candidate order", async () => {
    const t = convexTest(schema, modules);
    process.env.COMPANY_MONITORING_OWNER_FENCE_SECRET = OLD_OWNER_FENCE_SECRET;
    await grantProvisioned(t, OWNER_A);
    const oldestRoot = await accountFor(t, OWNER_A);
    const oldestFenceForOwnerA = await signCompanyMonitoringOwnerFence(OWNER_A);
    await t.mutation(CM.accounts.markOwnerDeleted, { ownerUserId: OWNER_A });

    process.env.COMPANY_MONITORING_OWNER_FENCE_SECRET = INTERMEDIATE_OWNER_FENCE_SECRET;
    const intermediateFenceForOwnerA = await signCompanyMonitoringOwnerFence(OWNER_A);
    await grantProvisioned(t, OWNER_B);
    const intermediateRoot = await accountFor(t, OWNER_B);
    await t.mutation(CM.accounts.markOwnerDeleted, { ownerUserId: OWNER_B });

    process.env.COMPANY_MONITORING_OWNER_FENCE_SECRET = NEW_OWNER_FENCE_SECRET;
    const currentFenceForOwnerA = await signCompanyMonitoringOwnerFence(OWNER_A);
    process.env.COMPANY_MONITORING_OWNER_FENCE_PREVIOUS_SECRETS =
      `${OLD_OWNER_FENCE_SECRET},${INTERMEDIATE_OWNER_FENCE_SECRET}`;
    expect((await companyMonitoringOwnerFenceCandidates(OWNER_A)).all).toEqual([
      currentFenceForOwnerA,
      oldestFenceForOwnerA,
      intermediateFenceForOwnerA,
    ]);
    await setStoredEntitlement(t, OWNER_A, "api_starter", FUTURE + 10_000);
    await setStoredEntitlement(t, OWNER_B, "api_starter", FUTURE + 20_000);

    const roots = await t.run(async (ctx) => ctx.db.query("companyMonitoringAccounts").collect());
    expect(roots).toHaveLength(2);
    expect(roots).toEqual(expect.arrayContaining([
      expect.objectContaining({
        _id: oldestRoot?._id,
        ownerFenceHash: oldestRoot?.ownerFenceHash,
        lifecycle: "denied",
        terminalReason: "owner_deleted",
      }),
      expect.objectContaining({
        _id: intermediateRoot?._id,
        ownerFenceHash: intermediateRoot?.ownerFenceHash,
        lifecycle: "denied",
        terminalReason: "owner_deleted",
      }),
    ]));
    expect(roots.every((root) => root.ownerUserId === undefined)).toBe(true);
    expect(roots.find((root) => root._id === oldestRoot?._id)).toMatchObject({
      lifecycle: "denied",
      terminalReason: "owner_deleted",
    });
  });

  test("dedicated owner-fence rotation rejects split roots across current and previous keys", async () => {
    const t = convexTest(schema, modules);
    process.env.COMPANY_MONITORING_OWNER_FENCE_SECRET = OLD_OWNER_FENCE_SECRET;
    await grantProvisioned(t, OWNER_A);

    process.env.COMPANY_MONITORING_OWNER_FENCE_SECRET = NEW_OWNER_FENCE_SECRET;
    process.env.COMPANY_MONITORING_OWNER_FENCE_PREVIOUS_SECRETS = OLD_OWNER_FENCE_SECRET;
    const currentFenceHash = await signCompanyMonitoringOwnerFence(OWNER_A);
    await t.run(async (ctx) => {
      await ctx.db.insert("companyMonitoringAccounts", {
        logicalAccountId: "split-current-root",
        ownerFenceHash: currentFenceHash,
        lifecycle: "denied",
        terminalReason: "account_deleted",
        lifecycleSequence: 1,
        purgeGeneration: 1,
        purgePhase: "complete",
        destructivePurgeStarted: true,
        pendingReactivation: false,
        createdAt: NOW,
        updatedAt: NOW,
      });
    });

    await expect(
      t.mutation(CM.accounts.syncStoredEntitlement, { userId: OWNER_A }),
    ).rejects.toThrow(/ACCOUNT_OWNER_FENCE_CONFLICT/);
  });

  test.each([
    ["missing current secret", undefined],
    ["empty current secret", ""],
    ["leading whitespace", ` ${TEST_OWNER_FENCE_SECRET}`],
    ["trailing whitespace", `${TEST_OWNER_FENCE_SECRET} `],
  ])("dedicated owner-fence rotation rejects %s", async (_caseName, currentSecret) => {
    if (currentSecret === undefined) delete process.env.COMPANY_MONITORING_OWNER_FENCE_SECRET;
    else process.env.COMPANY_MONITORING_OWNER_FENCE_SECRET = currentSecret;
    await expect(signCompanyMonitoringOwnerFence(OWNER_A)).rejects.toThrow(
      /COMPANY_MONITORING_OWNER_FENCE_SECRET (?:not set|is invalid)/,
    );
  });

  test.each([
    ["empty history", ""],
    ["blank history entry", `${OLD_OWNER_FENCE_SECRET},`],
    ["surrounding whitespace", ` ${OLD_OWNER_FENCE_SECRET}`],
    ["duplicate history", `${OLD_OWNER_FENCE_SECRET},${OLD_OWNER_FENCE_SECRET}`],
  ])("owner-fence rotation rejects %s", async (_caseName, previousSecrets) => {
    process.env.COMPANY_MONITORING_OWNER_FENCE_SECRET = NEW_OWNER_FENCE_SECRET;
    process.env.COMPANY_MONITORING_OWNER_FENCE_PREVIOUS_SECRETS = previousSecrets;
    await expect(signCompanyMonitoringOwnerFence(OWNER_A)).rejects.toThrow(
      /invalid|duplicate key/,
    );
  });

  test("owner-fence rotation permits pre-staging the current key without duplicate candidates", async () => {
    process.env.COMPANY_MONITORING_OWNER_FENCE_SECRET = NEW_OWNER_FENCE_SECRET;
    process.env.COMPANY_MONITORING_OWNER_FENCE_PREVIOUS_SECRETS =
      `${OLD_OWNER_FENCE_SECRET},${NEW_OWNER_FENCE_SECRET}`;

    const candidates = await companyMonitoringOwnerFenceCandidates(OWNER_A);
    expect(candidates.all).toHaveLength(2);
    expect(new Set(candidates.all).size).toBe(2);
    expect(candidates.all[0]).toBe(candidates.current);
  });
});
