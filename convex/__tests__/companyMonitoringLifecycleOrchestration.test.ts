import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import {
  accountFor,
  CM,
  company,
  grantProvisioned,
  installCompanyMonitoringTestEnvironment,
  modules,
  NOW,
  OWNER_A,
  schema,
  setStoredEntitlement,
} from "./companyMonitoring.helpers";

const ORCHESTRATION = (CM as any).orchestration;
const DAY_MS = 24 * 60 * 60 * 1000;

installCompanyMonitoringTestEnvironment();

async function createCompany(t: ReturnType<typeof convexTest>, name: string) {
  const created = await t.mutation(CM.companies.createCompanyForOwner, {
    ownerUserId: OWNER_A,
    clientRequestId: `request-${name}`,
    company: company(name, `customer-${name}`),
  });
  const account = await accountFor(t, OWNER_A);
  return { account: account!, companyId: created.companyId };
}

async function scanRows(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => ({
    obligations: await ctx.db.query("companyMonitoringScanObligations").collect(),
    work: await ctx.db.query("companyMonitoringScanWorkItems").collect(),
  }));
}

async function receiptLinks(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => ctx.db.query("companyMonitoringScanReceiptLinks").collect());
}

async function finalizeComplete(t: ReturnType<typeof convexTest>, claim: any) {
  return t.mutation(ORCHESTRATION.finalizeWorkForTest, {
    workerId: "lifecycle-worker",
    workId: claim.work.workId,
    leaseToken: claim.work.leaseToken,
    result: {
      type: "result",
      itemCount: 1,
      hasMore: false,
      coverage: "complete",
      returnedRange: {
        startAt: claim.work.windowStart,
        endAt: claim.work.windowEnd,
      },
      checkpoint: `checkpoint-${claim.work.workId}`,
      emptyValidated: false,
      costUsdMicros: 10,
    },
  });
}

describe("Company Monitoring lifecycle scan integration", () => {
  test("creation materializes trusted source scheduling while public provider flags remain dark", async () => {
    const t = convexTest(schema, modules);
    await grantProvisioned(t, OWNER_A);
    const created = await createCompany(t, "Lifecycle Queue");

    expect(await t.mutation(ORCHESTRATION.scheduleCompanySources, {
      ownerAccountId: created.account.logicalAccountId,
      companyId: created.companyId,
    })).toEqual({ status: "replayed", sources: 2 });
    const rows = await scanRows(t);
    expect(rows.obligations).toHaveLength(2);
    expect(rows.obligations.every((row) => row.state === "due")).toBe(true);
    expect(rows.work).toHaveLength(2);
  });

  test.each([
    ["complete", "completed"],
    ["non_reassuring", "non_reassuring"],
  ] as const)("same-hour reactivation replaces a %s terminal work-key collision", async (
    terminalState,
    expectedStatus,
  ) => {
    const t = convexTest(schema, modules);
    await grantProvisioned(t, OWNER_A);
    const created = await createCompany(
      t,
      `Same Hour Reactivation ${terminalState.replace("_", " ")}`,
    );

    const firstClaim = await t.mutation(ORCHESTRATION.claimNextWorkForTest, {
      workerId: "lifecycle-worker",
    });
    expect(firstClaim).toMatchObject({ status: "claimed", work: { source: "exa" } });
    const finalized = terminalState === "complete"
      ? await finalizeComplete(t, firstClaim)
      : await t.mutation(ORCHESTRATION.finalizeWorkForTest, {
        workerId: "lifecycle-worker",
        workId: firstClaim.work.workId,
        leaseToken: firstClaim.work.leaseToken,
        result: { type: "provider_error", reason: "timeout", costUsdMicros: 10 },
      });
    expect(finalized).toMatchObject({ status: expectedStatus });

    expect(await t.mutation(CM.companies.setCompanyStateForOwner, {
      ownerUserId: OWNER_A,
      companyId: created.companyId,
      state: "paused",
    })).toMatchObject({ status: "paused" });
    expect(await t.mutation(CM.companies.setCompanyStateForOwner, {
      ownerUserId: OWNER_A,
      companyId: created.companyId,
      state: "active",
    })).toMatchObject({ status: "active" });
    await t.mutation(ORCHESTRATION.scheduleCompanySources, {
      ownerAccountId: created.account.logicalAccountId,
      companyId: created.companyId,
    });

    const rows = await scanRows(t);
    const exaObligation = rows.obligations.find((row) => row.source === "exa");
    expect(exaObligation).toMatchObject({ state: "due" });
    expect(exaObligation?.workId).not.toBe(firstClaim.work.workId);
    expect(await t.mutation(ORCHESTRATION.claimNextWorkForTest, {
      workerId: "lifecycle-worker",
    })).toMatchObject({ status: "claimed", work: { source: "exa" } });
  });

  test("removal immediately cancels due and leased work, fences stale holders, and purges scan state first", async () => {
    const t = convexTest(schema, modules);
    await grantProvisioned(t, OWNER_A);
    const created = await createCompany(t, "Lease Removal");
    await t.mutation(ORCHESTRATION.scheduleCompanySources, {
      ownerAccountId: created.account.logicalAccountId,
      companyId: created.companyId,
    });
    const claim = await t.mutation(ORCHESTRATION.claimNextWorkForTest, {
      workerId: "lifecycle-worker",
    });
    expect(claim.status).toBe("claimed");

    await expect(t.mutation(CM.companies.setCompanyStateForOwner, {
      ownerUserId: OWNER_A,
      companyId: created.companyId,
      state: "removed",
    })).resolves.toMatchObject({ status: "removed" });

    const removed = await t.run(async (ctx) =>
      ctx.db
        .query("companyMonitoringCompanies")
        .withIndex("by_account_companyId", (q) =>
          q
            .eq("ownerAccountId", created.account.logicalAccountId)
            .eq("companyId", created.companyId),
        )
        .unique()
    );
    expect(removed).toMatchObject({ lifecycle: "removed", purgePhase: "scan" });
    const cancelled = await scanRows(t);
    expect(cancelled.work.every((row) => row.state === "cancelled")).toBe(true);
    expect(cancelled.obligations.every((row) =>
      row.state === "cancelled" && row.reason === "company_removed"
    )).toBe(true);
    expect(await t.mutation(ORCHESTRATION.finalizeWorkForTest, {
      workerId: "lifecycle-worker",
      workId: claim.work.workId,
      leaseToken: claim.work.leaseToken,
      result: {
        type: "provider_error",
        reason: "timeout",
        costUsdMicros: 0,
      },
    })).toEqual({ status: "fenced" });

    expect(await t.mutation(CM.companies.advanceCompanyPurge, {
      ownerAccountId: created.account.logicalAccountId,
      companyId: created.companyId,
      purgeGeneration: removed!.purgeGeneration,
    })).toEqual({ status: "complete" });
    expect(await scanRows(t)).toEqual({ obligations: [], work: [] });
    const purged = await t.run(async (ctx) => ctx.db.get(removed!._id));
    expect(purged).toMatchObject({ purgePhase: "complete" });
    expect(purged?.name).toBeUndefined();
  });

  test("removing one company cancels its shared cohort but preserves and requeues the active peer", async () => {
    const t = convexTest(schema, modules);
    await grantProvisioned(t, OWNER_A);
    const first = await createCompany(t, "Shared First");
    const second = await createCompany(t, "Shared Second");
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("companyMonitoringScanObligations").collect()) {
        await ctx.db.delete(row._id);
      }
      for (const row of await ctx.db.query("companyMonitoringScanWorkItems").collect()) {
        await ctx.db.delete(row._id);
      }
      await ctx.db.patch(first.account._id, {
        nextExaScanDueAt: undefined,
        nextXScanDueAt: undefined,
      });
    });
    await t.mutation(ORCHESTRATION.scheduleAccountWork, {
      ownerAccountId: first.account.logicalAccountId,
      source: "exa",
      companyIds: [first.companyId, second.companyId],
    });

    await t.mutation(CM.companies.setCompanyStateForOwner, {
      ownerUserId: OWNER_A,
      companyId: first.companyId,
      state: "removed",
    });
    const beforeRequeue = await scanRows(t);
    expect(beforeRequeue.work).toHaveLength(1);
    expect(beforeRequeue.work[0]).toMatchObject({ state: "cancelled" });
    expect(beforeRequeue.obligations.find((row) => row.companyId === second.companyId))
      .toMatchObject({ state: "cancelled", reason: "superseded" });

    await t.mutation(ORCHESTRATION.scheduleCompanySources, {
      ownerAccountId: first.account.logicalAccountId,
      companyId: second.companyId,
    });
    const afterRequeue = await scanRows(t);
    expect(afterRequeue.obligations.find((row) =>
      row.companyId === second.companyId && row.source === "exa"
    )).toMatchObject({ state: "due" });
    const secondRow = await t.run(async (ctx) =>
      ctx.db
        .query("companyMonitoringCompanies")
        .withIndex("by_account_companyId", (q) =>
          q.eq("ownerAccountId", first.account.logicalAccountId).eq("companyId", second.companyId),
        )
        .unique()
    );
    expect(secondRow).toMatchObject({ lifecycle: "active", name: "Shared Second" });
  });

  test("company purge removes current scan state and its retained terminal receipts", async () => {
    const t = convexTest(schema, modules);
    await grantProvisioned(t, OWNER_A);
    const created = await createCompany(t, "Receipt Purge");
    await t.mutation(ORCHESTRATION.scheduleCompanySources, {
      ownerAccountId: created.account.logicalAccountId,
      companyId: created.companyId,
    });
    const claim = await t.mutation(ORCHESTRATION.claimNextWorkForTest, {
      workerId: "lifecycle-worker",
    });
    expect(await finalizeComplete(t, claim)).toMatchObject({ status: "completed" });
    expect(await receiptLinks(t)).toHaveLength(1);

    await t.mutation(CM.companies.setCompanyStateForOwner, {
      ownerUserId: OWNER_A,
      companyId: created.companyId,
      state: "removed",
    });
    const removed = await t.run(async (ctx) =>
      ctx.db
        .query("companyMonitoringCompanies")
        .withIndex("by_account_companyId", (q) =>
          q
            .eq("ownerAccountId", created.account.logicalAccountId)
            .eq("companyId", created.companyId),
        )
        .unique()
    );
    expect(await t.mutation(CM.companies.advanceCompanyPurge, {
      ownerAccountId: created.account.logicalAccountId,
      companyId: created.companyId,
      purgeGeneration: removed!.purgeGeneration,
    })).toEqual({ status: "complete" });
    expect(await scanRows(t)).toEqual({ obligations: [], work: [] });
    expect(await receiptLinks(t)).toEqual([]);
  });

  test("company purge resumes after a full terminal receipt-link page", async () => {
    const t = convexTest(schema, modules);
    await grantProvisioned(t, OWNER_A);
    const created = await createCompany(t, "Paged Receipt Purge");

    for (let scan = 0; scan < 17; scan += 1) {
      vi.setSystemTime(NOW + scan * DAY_MS);
      const claim = await t.mutation(ORCHESTRATION.claimNextWorkForTest, {
        workerId: "lifecycle-worker",
      });
      expect(claim).toMatchObject({ status: "claimed", work: { source: "exa" } });
      expect(await finalizeComplete(t, claim)).toMatchObject({ status: "completed" });
    }
    expect(await receiptLinks(t)).toHaveLength(17);

    await t.mutation(CM.companies.setCompanyStateForOwner, {
      ownerUserId: OWNER_A,
      companyId: created.companyId,
      state: "removed",
    });
    const removed = await t.run(async (ctx) =>
      ctx.db
        .query("companyMonitoringCompanies")
        .withIndex("by_account_companyId", (q) =>
          q
            .eq("ownerAccountId", created.account.logicalAccountId)
            .eq("companyId", created.companyId),
        )
        .unique()
    );
    vi.advanceTimersByTime(1);
    await t.finishInProgressScheduledFunctions();
    expect(await t.run(async (ctx) => ctx.db.get(removed!._id)))
      .toMatchObject({ name: "Paged Receipt Purge", purgePhase: "scan" });
    expect(await receiptLinks(t)).toHaveLength(1);

    vi.advanceTimersByTime(1);
    await t.finishInProgressScheduledFunctions();

    const purged = await t.run(async (ctx) => ctx.db.get(removed!._id));
    expect(purged).toMatchObject({ purgePhase: "complete" });
    expect(purged?.name).toBeUndefined();
    expect(await receiptLinks(t)).toEqual([]);
    expect(await scanRows(t)).toEqual({ obligations: [], work: [] });
  });

  test("shared terminal receipt survives one member purge and leaves with its final member", async () => {
    const t = convexTest(schema, modules);
    await grantProvisioned(t, OWNER_A);
    const first = await createCompany(t, "Receipt Shared First");
    const second = await createCompany(t, "Receipt Shared Second");
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("companyMonitoringScanObligations").collect()) {
        await ctx.db.delete(row._id);
      }
      for (const row of await ctx.db.query("companyMonitoringScanWorkItems").collect()) {
        await ctx.db.delete(row._id);
      }
      await ctx.db.patch(first.account._id, {
        nextExaScanDueAt: undefined,
        nextXScanDueAt: undefined,
      });
    });
    await t.mutation(ORCHESTRATION.scheduleAccountWork, {
      ownerAccountId: first.account.logicalAccountId,
      source: "exa",
      companyIds: [first.companyId, second.companyId],
    });
    const claim = await t.mutation(ORCHESTRATION.claimNextWorkForTest, {
      workerId: "lifecycle-worker",
    });
    expect(await finalizeComplete(t, claim)).toMatchObject({ status: "completed" });
    expect(await receiptLinks(t)).toHaveLength(2);

    await t.mutation(CM.companies.setCompanyStateForOwner, {
      ownerUserId: OWNER_A,
      companyId: first.companyId,
      state: "removed",
    });
    const removedFirst = await t.run(async (ctx) =>
      ctx.db
        .query("companyMonitoringCompanies")
        .withIndex("by_account_companyId", (q) =>
          q.eq("ownerAccountId", first.account.logicalAccountId).eq("companyId", first.companyId),
        )
        .unique()
    );
    expect(await t.mutation(CM.companies.advanceCompanyPurge, {
      ownerAccountId: first.account.logicalAccountId,
      companyId: first.companyId,
      purgeGeneration: removedFirst!.purgeGeneration,
    })).toEqual({ status: "complete" });
    expect(await receiptLinks(t)).toMatchObject([{
      companyId: second.companyId,
      workId: claim.work.workId,
    }]);
    expect(await t.run(async (ctx) =>
      ctx.db
        .query("companyMonitoringScanWorkItems")
        .withIndex("by_workId", (q) => q.eq("workId", claim.work.workId))
        .unique()
    )).toMatchObject({ state: "complete" });

    await t.mutation(CM.companies.setCompanyStateForOwner, {
      ownerUserId: OWNER_A,
      companyId: second.companyId,
      state: "removed",
    });
    const removedSecond = await t.run(async (ctx) =>
      ctx.db
        .query("companyMonitoringCompanies")
        .withIndex("by_account_companyId", (q) =>
          q.eq("ownerAccountId", first.account.logicalAccountId).eq("companyId", second.companyId),
        )
        .unique()
    );
    expect(await t.mutation(CM.companies.advanceCompanyPurge, {
      ownerAccountId: first.account.logicalAccountId,
      companyId: second.companyId,
      purgeGeneration: removedSecond!.purgeGeneration,
    })).toEqual({ status: "complete" });
    expect(await receiptLinks(t)).toEqual([]);
    expect(await scanRows(t)).toEqual({ obligations: [], work: [] });
  });

  test("account destructive purge clears durable scan state before company payloads", async () => {
    const t = convexTest(schema, modules);
    await grantProvisioned(t, OWNER_A);
    const created = await createCompany(t, "Account Scan Purge");
    for (let index = 1; index < 5; index += 1) {
      await createCompany(t, `Account Scan Purge ${index}`);
    }
    expect((await scanRows(t)).work).toHaveLength(10);

    await setStoredEntitlement(t, OWNER_A, "free", NOW - 1);
    const lapsed = await accountFor(t, OWNER_A);
    vi.setSystemTime(NOW + DAY_MS);
    expect(await t.mutation(CM.accounts.advanceAccountPurge, {
      ownerFenceHash: lapsed!.ownerFenceHash,
      purgeGeneration: lapsed!.purgeGeneration,
    })).toEqual({ status: "started" });

    expect(await accountFor(t, OWNER_A)).toMatchObject({ purgePhase: "scan" });
    expect((await scanRows(t)).work).toHaveLength(2);
    expect(await t.mutation(CM.accounts.advanceAccountPurge, {
      ownerFenceHash: lapsed!.ownerFenceHash,
      purgeGeneration: lapsed!.purgeGeneration,
    })).toEqual({ status: "companies" });
    expect(await scanRows(t)).toEqual({ obligations: [], work: [] });
    const scanClearedAccount = await accountFor(t, OWNER_A);
    expect(scanClearedAccount?.nextExaScanDueAt).toBeUndefined();
    expect(scanClearedAccount?.nextXScanDueAt).toBeUndefined();
    const companyBeforePayload = await t.run(async (ctx) =>
      ctx.db
        .query("companyMonitoringCompanies")
        .withIndex("by_account_companyId", (q) =>
          q.eq("ownerAccountId", created.account.logicalAccountId).eq("companyId", created.companyId),
        )
        .unique()
    );
    expect(companyBeforePayload).toMatchObject({ name: "Account Scan Purge", purgePhase: "none" });
  });
});
