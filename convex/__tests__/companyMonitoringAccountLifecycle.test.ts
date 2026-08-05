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
} from "./companyMonitoringTestHelpers";

installCompanyMonitoringTestEnvironment();

describe("Company Monitoring account lifecycle", () => {
  test.each([
    ["missing fence secret", () => {
      delete process.env.COMPANY_MONITORING_OWNER_FENCE_SECRET;
    }],
    ["malformed fence keyring", () => {
      process.env.COMPANY_MONITORING_OWNER_FENCE_PREVIOUS_SECRETS = `${TEST_OWNER_FENCE_SECRET},`;
    }],
  ])(
    "a %s degrades Company Monitoring instead of rolling back the entitlement write",
    async (_caseName, breakConfig) => {
      const t = convexTest(schema, modules);
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
      breakConfig();

      // The entitlement write must survive: this runs inside the Dodo webhook
      // transaction, and a config fault fails every retry identically.
      await expect(grant(t, OWNER_A)).resolves.not.toThrow();

      const state = await t.run(async (ctx) => ({
        entitlements: await ctx.db.query("entitlements").collect(),
        accounts: await ctx.db.query("companyMonitoringAccounts").collect(),
      }));
      expect(state.entitlements).toHaveLength(1);
      expect(state.accounts).toEqual([]);
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining("owner fence unavailable"),
      );
    },
  );

  test("the account root converges on the next entitlement write once config is repaired", async () => {
    const t = convexTest(schema, modules);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    delete process.env.COMPANY_MONITORING_OWNER_FENCE_SECRET;

    await grant(t, OWNER_A);
    expect(await accountFor(t, OWNER_A)).toBeNull();

    process.env.COMPANY_MONITORING_OWNER_FENCE_SECRET = TEST_OWNER_FENCE_SECRET;
    await t.mutation(CM.accounts.syncStoredEntitlement, { userId: OWNER_A });
    expect(await accountFor(t, OWNER_A)).toMatchObject({
      ownerUserId: OWNER_A,
      lifecycle: "entitled",
      lifecycleSequence: 1,
    });
  });

  test("explicit owner deletion still fails loudly on a misconfigured fence", async () => {
    const t = convexTest(schema, modules);
    await grant(t, OWNER_A);
    delete process.env.COMPANY_MONITORING_OWNER_FENCE_SECRET;

    // terminalize keeps the throwing accessor: deletion is an explicit
    // operation off the billing path, so a config fault must not be swallowed.
    await expect(
      t.mutation(CM.accounts.markOwnerDeleted, { ownerUserId: OWNER_A }),
    ).rejects.toThrow(/COMPANY_MONITORING_OWNER_FENCE_SECRET not set/);
  });

  test("authenticated grants create one immutable root and semantic replays do not advance sequence", async () => {
    const t = convexTest(schema, modules);

    await grant(t, OWNER_A);
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
    expect(await accountFor(t, realOwner)).toMatchObject({
      ownerUserId: realOwner,
      lifecycle: "entitled",
      lifecycleSequence: 1,
    });
  });

  test("dispute loss recomputes the canonical root synchronously", async () => {
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
    expect(await accountFor(t, OWNER_A)).toMatchObject({
      lifecycle: "entitlement_lapsed",
      lifecycleSequence: 2,
      purgePhase: "pending",
    });
  });

  test("lapse can reactivate before destructive purge but not after owner deletion", async () => {
    const t = convexTest(schema, modules);
    await grant(t, OWNER_A);
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
    await grant(t, OWNER_A);
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
    await grant(t, OWNER_A);
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
    await grant(t, OWNER_A);
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
    await grant(t, OWNER_A);
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
    await grant(t, OWNER_A);
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

  test("dedicated owner-fence rotation keeps two historical tombstones discoverable in candidate order", async () => {
    const t = convexTest(schema, modules);
    process.env.COMPANY_MONITORING_OWNER_FENCE_SECRET = OLD_OWNER_FENCE_SECRET;
    await grant(t, OWNER_A);
    const oldestRoot = await accountFor(t, OWNER_A);
    const oldestFenceForOwnerA = await signCompanyMonitoringOwnerFence(OWNER_A);
    await t.mutation(CM.accounts.markOwnerDeleted, { ownerUserId: OWNER_A });

    process.env.COMPANY_MONITORING_OWNER_FENCE_SECRET = INTERMEDIATE_OWNER_FENCE_SECRET;
    const intermediateFenceForOwnerA = await signCompanyMonitoringOwnerFence(OWNER_A);
    await grant(t, OWNER_B);
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
    await grant(t, OWNER_A);

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
