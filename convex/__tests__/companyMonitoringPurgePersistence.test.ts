import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import { getFeaturesForPlan } from "../lib/entitlements";
import {
  accountFor,
  CM,
  company,
  FUTURE,
  grant,
  grantProvisioned,
  installCompanyMonitoringTestEnvironment,
  modules,
  NOW,
  OWNER_A,
  schema,
  setStoredEntitlement,
} from "./companyMonitoring.helpers";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

installCompanyMonitoringTestEnvironment();

describe("Company Monitoring purge persistence", () => {
  test("duplicate entitlement rows use the first canonical row for sync and access", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("entitlements", {
        userId: OWNER_A,
        planKey: "api_starter",
        features: getFeaturesForPlan("api_starter"),
        validUntil: FUTURE,
        updatedAt: NOW,
      });
      await ctx.db.insert("entitlements", {
        userId: OWNER_A,
        planKey: "free",
        features: getFeaturesForPlan("free"),
        validUntil: NOW - 1,
        updatedAt: NOW,
      });
    });

    await expect(
      t.mutation(CM.accounts.syncStoredEntitlement, { userId: OWNER_A }),
    ).resolves.toMatchObject({ lifecycle: "entitled" });
    await expect(
      t.mutation(CM.companies.createCompanyForOwner, {
        ownerUserId: OWNER_A,
        clientRequestId: "duplicate-entitlement-first",
        company: company("Duplicate Entitlement Corp", "duplicate-entitlement"),
      }),
    ).resolves.toMatchObject({ status: "created" });
  });

  test("ordinary lapse waits 24 hours while terminal deletion bypasses grace", async () => {
    const t = convexTest(schema, modules);
    await grantProvisioned(t, OWNER_A);
    await t.mutation(CM.companies.createCompanyForOwner, {
      ownerUserId: OWNER_A,
      clientRequestId: "grace-company",
      company: company("Grace Corp", "grace-corp"),
    });

    await setStoredEntitlement(t, OWNER_A, "free", NOW - 1);
    const lapsed = await accountFor(t, OWNER_A);
    expect(lapsed).toMatchObject({
      lifecycle: "entitlement_lapsed",
      purgePhase: "pending",
      purgeAfter: NOW + DAY_MS,
      destructivePurgeStarted: false,
    });
    const purgeArgs = {
      ownerFenceHash: lapsed!.ownerFenceHash,
      purgeGeneration: lapsed!.purgeGeneration,
    };
    expect(await t.mutation(CM.accounts.advanceAccountPurge, purgeArgs)).toEqual({
      status: "waiting",
      purgeAfter: NOW + DAY_MS,
    });
    expect(await accountFor(t, OWNER_A)).toMatchObject({
      purgePhase: "pending",
      destructivePurgeStarted: false,
    });

    vi.setSystemTime(NOW + 2 * HOUR_MS);
    expect(await t.mutation(CM.accounts.reapStalledAccountPurges, {})).toEqual({
      scanned: 1,
      scheduled: 0,
      deferred: 1,
    });

    const terminal = await t.mutation(CM.accounts.markOwnerDeleted, { ownerUserId: OWNER_A });
    expect(terminal).toMatchObject({
      lifecycle: "denied",
      terminalReason: "owner_deleted",
      purgePhase: "pending",
    });
    expect(terminal?.purgeAfter).toBeUndefined();
    expect(await t.mutation(CM.accounts.advanceAccountPurge, {
      ownerFenceHash: terminal!.ownerFenceHash,
      purgeGeneration: terminal!.purgeGeneration,
    })).toEqual({ status: "started" });
  });

  test("stalled-purge reaper is bounded and defers ordinary pending grace", async () => {
    const t = convexTest(schema, modules);
    const staleAt = NOW - 2 * HOUR_MS;
    await t.run(async (ctx) => {
      for (let index = 0; index < 51; index += 1) {
        await ctx.db.insert("companyMonitoringAccounts", {
          logicalAccountId: `reaper-account-${index}`,
          ownerUserId: `reaper-owner-${index}`,
          ownerFenceHash: `reaper-fence-${index}`,
          lifecycle: "entitlement_lapsed",
          lifecycleSequence: 1,
          companyCount: 0,
          companyLimit: 500,
          snapshotGeneration: 0,
          purgeGeneration: 1,
          purgePhase: "finalizing",
          destructivePurgeStarted: true,
          pendingReactivation: false,
          createdAt: staleAt,
          updatedAt: staleAt,
        });
      }
      await ctx.db.insert("companyMonitoringAccounts", {
        logicalAccountId: "reaper-grace-account",
        ownerUserId: "reaper-grace-owner",
        ownerFenceHash: "reaper-grace-fence",
        lifecycle: "entitlement_lapsed",
        lifecycleSequence: 1,
        companyCount: 0,
        companyLimit: 500,
        snapshotGeneration: 0,
        purgeGeneration: 1,
        purgePhase: "pending",
        destructivePurgeStarted: false,
        pendingReactivation: false,
        purgeAfter: NOW + DAY_MS,
        createdAt: staleAt,
        updatedAt: staleAt,
      });
    });

    expect(await t.mutation(CM.accounts.reapStalledAccountPurges, {})).toEqual({
      scanned: 50,
      scheduled: 50,
      deferred: 0,
    });
    expect(await t.mutation(CM.accounts.reapStalledAccountPurges, {})).toEqual({
      scanned: 2,
      scheduled: 1,
      deferred: 1,
    });
    let scheduled = await t.run(async (ctx) =>
      ctx.db.system.query("_scheduled_functions").collect()
    );
    expect(scheduled.filter((job) => job.name.includes("advanceAccountPurge"))).toHaveLength(51);

    // Leave every continuation unexecuted to model a dropped scheduler drain.
    // Once the reaper's one-hour stale threshold elapses, the same fenced
    // generations are enqueued again instead of remaining stuck forever.
    vi.setSystemTime(NOW + 2 * HOUR_MS);
    expect(await t.mutation(CM.accounts.reapStalledAccountPurges, {})).toEqual({
      scanned: 50,
      scheduled: 50,
      deferred: 0,
    });
    scheduled = await t.run(async (ctx) =>
      ctx.db.system.query("_scheduled_functions").collect()
    );
    expect(scheduled.filter((job) => job.name.includes("advanceAccountPurge"))).toHaveLength(101);
  });

  test("account purge clears replay metadata while individual removal retains it", async () => {
    const t = convexTest(schema, modules);
    await grantProvisioned(t, OWNER_A);
    const root = await accountFor(t, OWNER_A);
    const direct = await t.mutation(CM.companies.createCompanyForOwner, {
      ownerUserId: OWNER_A,
      clientRequestId: "replay-metadata-direct",
      company: company("Replay Metadata Direct", "replay-metadata-direct"),
    });
    const imported = await t.action(CM.imports.importCompaniesForOwner, {
      ownerUserId: OWNER_A,
      rows: [{
        ...company("Replay Metadata Import", "replay-metadata-import"),
        clientImportId: "replay-metadata-import-batch",
        ordinal: 0,
      }],
    });
    const importedBeforePurge = await t.run(async (ctx) =>
      ctx.db
        .query("companyMonitoringCompanies")
        .withIndex("by_account_companyId", (q) =>
          q
            .eq("ownerAccountId", root!.logicalAccountId)
            .eq("companyId", imported.results[0]!.companyId!),
        )
        .unique()
    );
    expect(importedBeforePurge).toMatchObject({
      clientImportId: "replay-metadata-import-batch",
      importOrdinal: 0,
      importFingerprint: expect.any(String),
    });

    await t.mutation(CM.companies.setCompanyStateForOwner, {
      ownerUserId: OWNER_A,
      companyId: direct.companyId,
      state: "removed",
    });
    const individuallyRemoved = await t.run(async (ctx) =>
      ctx.db
        .query("companyMonitoringCompanies")
        .withIndex("by_account_companyId", (q) =>
          q.eq("ownerAccountId", root!.logicalAccountId).eq("companyId", direct.companyId),
        )
        .unique()
    );
    await t.mutation(CM.companies.advanceCompanyPurge, {
      ownerAccountId: root!.logicalAccountId,
      companyId: direct.companyId,
      purgeGeneration: individuallyRemoved!.purgeGeneration,
    });
    const individuallyPurged = await t.run(async (ctx) => ctx.db.get(individuallyRemoved!._id));
    expect(individuallyPurged).toMatchObject({ purgePhase: "complete" });
    expect(individuallyPurged?.directRequestId).toBeUndefined();
    expect(individuallyPurged?.directFingerprint).toBeUndefined();

    await setStoredEntitlement(t, OWNER_A, "free", NOW - 1);
    const lapsed = await accountFor(t, OWNER_A);
    vi.setSystemTime(NOW + DAY_MS);
    const purgeArgs = {
      ownerFenceHash: lapsed!.ownerFenceHash,
      purgeGeneration: lapsed!.purgeGeneration,
    };
    expect(await t.mutation(CM.accounts.advanceAccountPurge, purgeArgs)).toEqual({
      status: "started",
    });
    expect(await t.mutation(CM.accounts.advanceAccountPurge, purgeArgs)).toEqual({
      status: "finalizing",
    });
    expect(await t.mutation(CM.accounts.advanceAccountPurge, purgeArgs)).toEqual({
      status: "complete",
    });

    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("companyMonitoringCompanies")
        .withIndex("by_account_companyId", (q) => q.eq("ownerAccountId", root!.logicalAccountId))
        .collect()
    );
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.companyId === imported.results[0]?.companyId)).toBeDefined();
    for (const row of rows) {
      expect(row.directRequestId).toBeUndefined();
      expect(row.directFingerprint).toBeUndefined();
      expect(row.clientImportId).toBeUndefined();
      expect(row.importOrdinal).toBeUndefined();
      expect(row.importFingerprint).toBeUndefined();
    }
  });

  test("finalization rechecks entitlement and clears stale pending reactivation", async () => {
    const t = convexTest(schema, modules);
    await grantProvisioned(t, OWNER_A);
    await t.mutation(CM.companies.createCompanyForOwner, {
      ownerUserId: OWNER_A,
      clientRequestId: "stale-reactivation-company",
      company: company("Stale Reactivation Corp", "stale-reactivation"),
    });
    await setStoredEntitlement(t, OWNER_A, "free", NOW - 1);
    const lapsed = await accountFor(t, OWNER_A);
    vi.setSystemTime(NOW + DAY_MS);
    const purgeArgs = {
      ownerFenceHash: lapsed!.ownerFenceHash,
      purgeGeneration: lapsed!.purgeGeneration,
    };
    await t.mutation(CM.accounts.advanceAccountPurge, purgeArgs);

    await setStoredEntitlement(t, OWNER_A, "api_starter", FUTURE);
    const pending = await accountFor(t, OWNER_A);
    expect(pending).toMatchObject({ pendingReactivation: true });
    await t.run(async (ctx) => {
      const entitlement = await ctx.db
        .query("entitlements")
        .withIndex("by_userId", (q) => q.eq("userId", OWNER_A))
        .first();
      await ctx.db.patch(entitlement!._id, {
        planKey: "free",
        features: getFeaturesForPlan("free"),
        validUntil: NOW - 1,
        updatedAt: NOW + DAY_MS,
      });
    });

    expect(await t.mutation(CM.accounts.advanceAccountPurge, purgeArgs)).toEqual({
      status: "finalizing",
    });
    expect(await t.mutation(CM.accounts.advanceAccountPurge, purgeArgs)).toEqual({
      status: "complete",
    });
    expect(await accountFor(t, OWNER_A)).toMatchObject({
      lifecycle: "entitlement_lapsed",
      lifecycleSequence: pending!.lifecycleSequence + 1,
      pendingReactivation: false,
      destructivePurgeStarted: true,
      purgePhase: "complete",
    });
    expect((await accountFor(t, OWNER_A))?.purgeAfter).toBeUndefined();
  });
});
