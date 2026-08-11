import { convexTest } from "convex-test";
import { api, internal } from "../_generated/api";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  installCompanyMonitoringTestEnvironment,
  modules,
  NOW,
  schema,
} from "./companyMonitoring.helpers";

const ORCHESTRATION = (internal as any).companyMonitoring.orchestration;
const PUBLIC_ORCHESTRATION = (api as any).companyMonitoring.orchestration;
const WORKER_SECRET = "test-company-monitoring-worker-secret";
const LEASE_MS = 5 * 60 * 1000;
const WINDOW_MS = 24 * 60 * 60 * 1000;
const WINDOW_BUCKET_MS = 60 * 60 * 1000;
const ORIGINAL_WORKER_SECRET = process.env.COMPANY_MONITORING_WORKER_SECRET;

installCompanyMonitoringTestEnvironment();

beforeEach(() => {
  process.env.COMPANY_MONITORING_WORKER_SECRET = WORKER_SECRET;
});

afterEach(() => {
  if (ORIGINAL_WORKER_SECRET === undefined) delete process.env.COMPANY_MONITORING_WORKER_SECRET;
  else process.env.COMPANY_MONITORING_WORKER_SECRET = ORIGINAL_WORKER_SECRET;
});

async function seedAccountWithCompany(
  t: ReturnType<typeof convexTest>,
  suffix: string,
  options: { initialCheckpoint?: string; source?: "exa" | "x" } = {},
) {
  const source = options.source ?? "exa";
  const ownerAccountId = `cm_account_${suffix}`;
  const companyId = `cm_company_${suffix.padStart(26, "0").slice(-26)}`;
  await t.run(async (ctx) => {
    await ctx.db.insert("companyMonitoringAccounts", {
      logicalAccountId: ownerAccountId,
      ownerUserId: `user_${suffix}`,
      ownerFenceHash: `fence_${suffix}`,
      lifecycle: "entitled",
      lifecycleSequence: 1,
      companyCount: 1,
      companyLimit: 500,
      snapshotGeneration: 1,
      purgeGeneration: 0,
      purgePhase: "none",
      destructivePurgeStarted: false,
      pendingReactivation: false,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await ctx.db.insert("companyMonitoringCompanies", {
      ownerAccountId,
      companyId,
      name: `Company ${suffix}`,
      sortName: `company ${suffix}`,
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
    await ctx.db.insert("companyMonitoringClaims", {
      ownerAccountId,
      companyId,
      claimId: `cm_claim_${suffix.padStart(26, "0").slice(-26)}`,
      type: "alias",
      value: `Alias ${suffix}`,
      provenance: "customer",
      trustState: "unverified",
      allowedUses: ["attribution", "discovery"],
      createdAt: NOW,
      updatedAt: NOW,
    });
  });

  const scheduled = await t.mutation(ORCHESTRATION.scheduleAccountWork, {
    ownerAccountId,
    source,
    companyIds: [companyId],
  });
  if (options.initialCheckpoint) {
    await t.run(async (ctx) => {
      const obligation = await ctx.db
        .query("companyMonitoringScanObligations")
        .withIndex("by_account_company_source", (q) =>
          q.eq("ownerAccountId", ownerAccountId).eq("companyId", companyId).eq("source", source),
        )
        .unique();
      await ctx.db.patch(obligation!._id, { checkpoint: options.initialCheckpoint });
    });
  }
  return { ownerAccountId, companyId, ...scheduled };
}

async function seedAccountWithAliasCollision(
  t: ReturnType<typeof convexTest>,
  suffix: string,
) {
  const ownerAccountId = `cm_account_${suffix}`;
  const companyIds = [0, 1].map((index) =>
    `cm_company_${`${suffix}_${index}`.padStart(26, "0").slice(-26)}`
  );
  await t.run(async (ctx) => {
    await ctx.db.insert("companyMonitoringAccounts", {
      logicalAccountId: ownerAccountId,
      ownerUserId: `user_${suffix}`,
      ownerFenceHash: `fence_${suffix}`,
      lifecycle: "entitled",
      lifecycleSequence: 1,
      companyCount: companyIds.length,
      companyLimit: 500,
      snapshotGeneration: 1,
      purgeGeneration: 0,
      purgePhase: "none",
      destructivePurgeStarted: false,
      pendingReactivation: false,
      createdAt: NOW,
      updatedAt: NOW,
    });
    for (const [index, companyId] of companyIds.entries()) {
      await ctx.db.insert("companyMonitoringCompanies", {
        ownerAccountId,
        companyId,
        name: `Collision Company ${index}`,
        sortName: `collision company ${index}`,
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
      await ctx.db.insert("companyMonitoringClaims", {
        ownerAccountId,
        companyId,
        claimId: `cm_claim_${`${suffix}_${index}`.padStart(26, "0").slice(-26)}`,
        type: "alias",
        value: "Shared Collision Brand",
        provenance: "customer",
        trustState: "unverified",
        allowedUses: ["attribution", "discovery"],
        createdAt: NOW,
        updatedAt: NOW,
      });
    }
  });
  await t.mutation(ORCHESTRATION.scheduleAccountWork, {
    ownerAccountId,
    source: "exa",
    companyIds,
  });
  return { ownerAccountId, companyIds };
}

async function claimForTest(t: ReturnType<typeof convexTest>, workerId = "worker-a") {
  return t.mutation(ORCHESTRATION.claimNextWorkForTest, { workerId });
}

async function finalizeComplete(
  t: ReturnType<typeof convexTest>,
  claim: any,
  overrides: Record<string, unknown> = {},
) {
  return t.mutation(ORCHESTRATION.finalizeWorkForTest, {
    workerId: "worker-a",
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
      costUsdMicros: 125,
      exaIngestion: {
        candidates: [{
          providerResultId: `exa-${claim.work.workId}`,
          providerRank: 1,
          url: `https://independent.example/${claim.work.workId}`,
          title: `${claim.work.obligations[0].company.claims[0].value} update`,
          publishedAt: claim.work.windowEnd - 1,
          retrievedAt: NOW,
          candidateCompanyIds: claim.work.obligations.map(
            (obligation: { companyId: string }) => obligation.companyId,
          ),
        }],
      },
      ...overrides,
    },
  });
}

describe("Company Monitoring durable scan orchestration", () => {
  test("claims server-shaped work, advances checkpoints, and durably rearms the next scan", async () => {
    const t = convexTest(schema, modules);
    const seeded = await seedAccountWithCompany(t, "happy", {
      initialCheckpoint: "checkpoint-before",
    });

    const claim = await claimForTest(t);
    expect(claim).toMatchObject({
      status: "claimed",
      accountsExamined: 1,
      work: {
        ownerAccountId: seeded.ownerAccountId,
        source: "exa",
        queryVersion: "exa-company-discovery-v1",
        resultCap: 25,
        attempt: 1,
        obligations: [{
          companyId: seeded.companyId,
          checkpoint: "checkpoint-before",
          company: {
            name: "Company happy",
            domicileCountry: "US",
            claims: [{
              claimId: `cm_claim_${"happy".padStart(26, "0").slice(-26)}`,
              type: "alias",
              value: "Alias happy",
            }],
          },
        }],
      },
    });
    expect(claim.work.leaseToken).toMatch(/^[a-f0-9]{64}$/);
    expect(claim.work.leaseExpiresAt).toBe(NOW + LEASE_MS);

    const finalized = await finalizeComplete(t, claim);
    expect(finalized).toMatchObject({ status: "completed", reason: "complete" });
    const state = await t.run(async (ctx) => {
      const work = await ctx.db
        .query("companyMonitoringScanWorkItems")
        .withIndex("by_workId", (q) => q.eq("workId", claim.work.workId))
        .unique();
      const obligation = await ctx.db
        .query("companyMonitoringScanObligations")
        .withIndex("by_account_company_source", (q) =>
          q
            .eq("ownerAccountId", seeded.ownerAccountId)
            .eq("companyId", seeded.companyId)
            .eq("source", "exa"),
        )
        .unique();
      const nextWork = obligation?.workId
        ? await ctx.db
          .query("companyMonitoringScanWorkItems")
          .withIndex("by_workId", (q) => q.eq("workId", obligation.workId!))
          .unique()
        : null;
      const account = await ctx.db
        .query("companyMonitoringAccounts")
        .withIndex("by_logicalAccountId", (q) => q.eq("logicalAccountId", seeded.ownerAccountId))
        .unique();
      const receiptLinks = await ctx.db
        .query("companyMonitoringScanReceiptLinks")
        .withIndex("by_workId", (q) => q.eq("workId", claim.work.workId))
        .collect();
      const evidence = await ctx.db
        .query("companyMonitoringEvidence")
        .withIndex("by_account_company", (q) =>
          q.eq("ownerAccountId", seeded.ownerAccountId).eq("companyId", seeded.companyId),
        )
        .collect();
      const candidates = await ctx.db
        .query("companyMonitoringCandidates")
        .withIndex("by_account_company", (q) =>
          q.eq("ownerAccountId", seeded.ownerAccountId).eq("companyId", seeded.companyId),
        )
        .collect();
      return { work, obligation, nextWork, account, receiptLinks, evidence, candidates };
    });
    expect(state.work).toMatchObject({
      state: "complete",
      terminalReceipt: {
        reason: "complete",
        costUsdMicros: 125,
        sourceCoverage: "complete",
        returnedRange: { startAt: claim.work.windowStart, endAt: claim.work.windowEnd },
      },
    });
    expect(state.obligation).toMatchObject({
      state: "due",
      dueAt: NOW + WINDOW_MS,
      checkpoint: `checkpoint-${claim.work.workId}`,
    });
    expect(state.nextWork).toMatchObject({
      state: "due",
      scheduledDueAt: NOW + WINDOW_MS,
      selectionDueAt: NOW + WINDOW_MS,
    });
    expect(state.nextWork?.workId).not.toBe(claim.work.workId);
    expect(state.account?.nextExaScanDueAt).toBe(NOW + WINDOW_MS);
    expect(state.receiptLinks).toMatchObject([{
      ownerAccountId: seeded.ownerAccountId,
      companyId: seeded.companyId,
      workId: claim.work.workId,
    }]);
    expect(state.evidence).toHaveLength(1);
    expect(state.evidence[0]).toMatchObject({ sourceAuthority: "low_authority" });
    expect(state.candidates).toMatchObject([{
      state: "pending_classification",
      referenceCount: 1,
      observationBlocking: false,
    }]);

    vi.setSystemTime(NOW + 1_000);
    await expect(t.mutation(ORCHESTRATION.scheduleAccountWork, {
      ownerAccountId: seeded.ownerAccountId,
      source: "exa",
      companyIds: [seeded.companyId],
    })).rejects.toThrow(/COMPANY_MONITORING_OBLIGATION_ALREADY_ACTIVE/);
    expect(await t.run(async (ctx) => ({
      workItems: (await ctx.db.query("companyMonitoringScanWorkItems").collect()).length,
      obligations: (await ctx.db.query("companyMonitoringScanObligations").collect()).length,
    }))).toEqual({ workItems: 2, obligations: 1 });
  });

  test("rejects an Exa candidate that omits a colliding company from its leased cohort", async () => {
    const t = convexTest(schema, modules);
    const seeded = await seedAccountWithAliasCollision(t, "exa_alias_collision");
    const claim = await claimForTest(t);
    expect(claim.work.obligations.map((obligation: { companyId: string }) => obligation.companyId))
      .toEqual(seeded.companyIds);

    const finalized = await finalizeComplete(t, claim, {
      exaIngestion: {
        candidates: [{
          providerResultId: "exa-ambiguous-subset",
          providerRank: 1,
          url: "https://independent.example/shared-collision-brand-update",
          title: "Shared Collision Brand update",
          publishedAt: claim.work.windowEnd - 1,
          retrievedAt: NOW,
          candidateCompanyIds: [seeded.companyIds[0]],
        }],
      },
    });

    expect(finalized).toMatchObject({ status: "non_reassuring", reason: "malformed" });
    const state = await t.run(async (ctx) => ({
      evidence: await ctx.db.query("companyMonitoringEvidence").collect(),
      candidates: await ctx.db.query("companyMonitoringCandidates").collect(),
      terminalWork: await ctx.db
        .query("companyMonitoringScanWorkItems")
        .withIndex("by_workId", (q) => q.eq("workId", claim.work.workId))
        .unique(),
    }));
    expect(state.evidence).toEqual([]);
    expect(state.candidates).toEqual([]);
    expect(state.terminalWork).toMatchObject({
      state: "non_reassuring",
      terminalReceipt: { reason: "malformed" },
    });
  });

  test("projects the strongest bounded Exa claims and leaves X obligations unchanged", async () => {
    const exa = convexTest(schema, modules);
    const seeded = await seedAccountWithCompany(exa, "claim_cap");
    await exa.run(async (ctx) => {
      for (let index = 0; index < 12; index += 1) {
        await ctx.db.insert("companyMonitoringClaims", {
          ownerAccountId: seeded.ownerAccountId,
          companyId: seeded.companyId,
          claimId: `cm_claim_${String(index + 100).padStart(26, "0")}`,
          type: "alias",
          value: `Alias cap ${index}`,
          provenance: "customer",
          trustState: "unverified",
          createdAt: NOW + index + 1,
          updatedAt: NOW + index + 1,
        });
      }
      await ctx.db.insert("companyMonitoringClaims", {
        ownerAccountId: seeded.ownerAccountId,
        companyId: seeded.companyId,
        claimId: `cm_claim_${String(999).padStart(26, "0")}`,
        type: "domain",
        value: "claim-cap.example",
        provenance: "customer",
        trustState: "unverified",
        createdAt: NOW + 20,
        updatedAt: NOW + 20,
      });
    });

    const exaClaim = await claimForTest(exa);
    expect(exaClaim.work.obligations[0].company.claims).toHaveLength(12);
    expect(exaClaim.work.obligations[0].company.claims[0]).toMatchObject({
      type: "domain",
      value: "claim-cap.example",
    });
    expect(exaClaim.work.obligations[0].company.claimProjection).toEqual({
      available: 14,
      included: 12,
      omitted: 2,
    });

    const x = convexTest(schema, modules);
    const xSeeded = await seedAccountWithCompany(x, "x_contract", { source: "x" });
    const xClaim = await claimForTest(x);
    expect(xClaim.work.source).toBe("x");
    expect(xClaim.work.obligations).toEqual([{ companyId: xSeeded.companyId }]);
  });

  test("rebinds materially old due work to the claim-time scan window", async () => {
    const t = convexTest(schema, modules);
    const seeded = await seedAccountWithCompany(t, "old_due");
    const claimAt = NOW + (3 * WINDOW_MS) + (17 * 60 * 1000);
    vi.setSystemTime(claimAt);

    const claim = await claimForTest(t);
    const expectedWindowEnd = Math.floor(claimAt / WINDOW_BUCKET_MS) * WINDOW_BUCKET_MS;
    expect(claim).toMatchObject({
      status: "claimed",
      work: {
        ownerAccountId: seeded.ownerAccountId,
        windowStart: expectedWindowEnd - WINDOW_MS,
        windowEnd: expectedWindowEnd,
      },
    });
    const persisted = await t.run(async (ctx) =>
      ctx.db
        .query("companyMonitoringScanWorkItems")
        .withIndex("by_workId", (q) => q.eq("workId", claim.work.workId))
        .unique()
    );
    expect(persisted).toMatchObject({
      state: "leased",
      windowStart: expectedWindowEnd - WINDOW_MS,
      windowEnd: expectedWindowEnd,
    });
  });

  test("duplicate lifecycle scheduling is replay-safe while explicit scheduling stays strict", async () => {
    const t = convexTest(schema, modules);
    const seeded = await seedAccountWithCompany(t, "lifecycle_replay");

    expect(await t.mutation(ORCHESTRATION.scheduleCompanySources, {
      ownerAccountId: seeded.ownerAccountId,
      companyId: seeded.companyId,
    })).toEqual({ status: "scheduled", sources: 2 });
    expect(await t.mutation(ORCHESTRATION.scheduleCompanySources, {
      ownerAccountId: seeded.ownerAccountId,
      companyId: seeded.companyId,
    })).toEqual({ status: "replayed", sources: 2 });
    await expect(t.mutation(ORCHESTRATION.scheduleAccountWork, {
      ownerAccountId: seeded.ownerAccountId,
      source: "exa",
      companyIds: [seeded.companyId],
    })).rejects.toThrow(/COMPANY_MONITORING_OBLIGATION_ALREADY_ACTIVE/);
    expect(await t.run(async (ctx) => ({
      obligations: (await ctx.db.query("companyMonitoringScanObligations").collect()).length,
      work: (await ctx.db.query("companyMonitoringScanWorkItems").collect()).length,
    }))).toEqual({ obligations: 2, work: 2 });
  });

  test("starts from the indexed account due page and stays bounded beyond 5,000 rows", async () => {
    const t = convexTest(schema, modules);
    const totalAccounts = 5_005;
    const targetIndex = 31;
    for (let start = 0; start < totalAccounts; start += 250) {
      const end = Math.min(totalAccounts, start + 250);
      await t.run(async (ctx) => {
        for (let index = start; index < end; index += 1) {
          await ctx.db.insert("companyMonitoringAccounts", {
            logicalAccountId: `cm_account_scale_${String(index).padStart(5, "0")}`,
            ownerFenceHash: `fence_scale_${index}`,
            lifecycle: "entitled",
            lifecycleSequence: 1,
            companyCount: index === targetIndex ? 1 : 0,
            companyLimit: 500,
            snapshotGeneration: 1,
            purgeGeneration: 0,
            purgePhase: "none",
            destructivePurgeStarted: false,
            pendingReactivation: false,
            nextExaScanDueAt: NOW,
            createdAt: NOW + index,
            updatedAt: NOW,
          });
        }
      });
    }
    const ownerAccountId = `cm_account_scale_${String(targetIndex).padStart(5, "0")}`;
    const companyId = `cm_company_${String(targetIndex).padStart(26, "0")}`;
    await t.run(async (ctx) => {
      await ctx.db.insert("companyMonitoringCompanies", {
        ownerAccountId,
        companyId,
        name: "Scale Target",
        sortName: "scale target",
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
    });
    await t.mutation(ORCHESTRATION.scheduleAccountWork, {
      ownerAccountId,
      source: "exa",
      companyIds: [companyId],
    });

    const claim = await claimForTest(t, "scale-worker");
    expect(claim.status).toBe("claimed");
    expect(claim.work.ownerAccountId).toBe(ownerAccountId);
    expect(claim.accountsExamined).toBeLessThanOrEqual(32);
  }, 20_000);

  test("public claims and finalization are secret-gated, targetless, and dark by provider flag", async () => {
    const t = convexTest(schema, modules);
    await seedAccountWithCompany(t, "auth");

    await expect(t.mutation(PUBLIC_ORCHESTRATION.claimNextWork, {
      secret: "wrong-secret",
      workerId: "worker-a",
    })).rejects.toThrow(/COMPANY_MONITORING_WORKER_UNAUTHORIZED/);
    await expect(t.mutation(PUBLIC_ORCHESTRATION.claimNextWork, {
      secret: WORKER_SECRET,
      workerId: "worker-a",
      ownerAccountId: "cm_account_attacker_selected",
    } as any)).rejects.toThrow();
    await expect(t.mutation(PUBLIC_ORCHESTRATION.finalizeWork, {
      secret: "wrong-secret",
      workerId: "worker-a",
      workId: "cm_work_unknown",
      leaseToken: "a".repeat(64),
      result: { type: "provider_error", reason: "timeout", costUsdMicros: 0 },
    })).rejects.toThrow(/COMPANY_MONITORING_WORKER_UNAUTHORIZED/);

    expect(await t.mutation(PUBLIC_ORCHESTRATION.claimNextWork, {
      secret: WORKER_SECRET,
      workerId: "worker-a",
    })).toEqual({ status: "disabled" });
  });

  test("expired claims replay with a fresh fence; stale holders cannot commit; same-lease terminal retries replay", async () => {
    const t = convexTest(schema, modules);
    await seedAccountWithCompany(t, "lease");
    const first = await claimForTest(t);

    vi.setSystemTime(NOW + LEASE_MS + 1);
    const replay = await claimForTest(t);
    expect(replay).toMatchObject({ status: "claimed", work: { attempt: 2 } });
    expect(replay.work.workId).toBe(first.work.workId);
    expect(replay.work.leaseToken).not.toBe(first.work.leaseToken);

    expect(await finalizeComplete(t, first)).toEqual({ status: "fenced" });
    const completed = await finalizeComplete(t, replay);
    expect(completed).toMatchObject({ status: "completed", reason: "complete" });
    expect(await finalizeComplete(t, replay)).toMatchObject({
      status: "replayed",
      reason: "complete",
    });
    expect(await t.run(async (ctx) =>
      ctx.db
        .query("companyMonitoringScanReceiptLinks")
        .withIndex("by_workId", (q) => q.eq("workId", replay.work.workId))
        .collect()
    )).toHaveLength(1);
  });

  test.each([
    ["capped", { itemCount: 25, hasMore: false }, "capped"],
    ["partial", { coverage: "partial" }, "partial"],
    [
      "partial payload count mismatch",
      { coverage: "partial", exaIngestion: { candidates: [] } },
      "malformed",
    ],
    ["malformed range", { returnedRange: { startAt: NOW, endAt: NOW - 1 } }, "malformed"],
    ["invalid empty", { itemCount: 0, emptyValidated: false }, "invalid_empty"],
  ])("%s results preserve the previous checkpoint and remain non-reassuring", async (_label, overrides, reason) => {
    const t = convexTest(schema, modules);
    const seeded = await seedAccountWithCompany(t, `preserve_${reason}`, {
      initialCheckpoint: "checkpoint-before",
    });
    const claim = await claimForTest(t);
    const resultOverrides = reason === "capped"
      ? {
          ...overrides,
          exaIngestion: {
            candidates: Array.from({ length: 25 }, (_, index) => ({
              providerResultId: `exa-capped-${index}`,
              providerRank: index + 1,
              url: `https://independent.example/capped-${index}`,
              title: `${claim.work.obligations[0].company.claims[0].value} update`,
              publishedAt: claim.work.windowEnd - 1,
              retrievedAt: NOW,
              candidateCompanyIds: [seeded.companyId],
            })),
          },
        }
      : reason === "invalid_empty"
        ? { ...overrides, exaIngestion: { candidates: [] } }
        : overrides;

    expect(await finalizeComplete(t, claim, resultOverrides)).toMatchObject({
      status: "non_reassuring",
      reason,
    });
    const state = await t.run(async (ctx) => ({
      obligation: await ctx.db
        .query("companyMonitoringScanObligations")
        .withIndex("by_account_company_source", (q) =>
          q
            .eq("ownerAccountId", seeded.ownerAccountId)
            .eq("companyId", seeded.companyId)
            .eq("source", "exa"),
        )
        .unique(),
      terminalWork: await ctx.db
        .query("companyMonitoringScanWorkItems")
        .withIndex("by_workId", (q) => q.eq("workId", claim.work.workId))
        .unique(),
    }));
    expect(state.obligation).toMatchObject({
      state: "due",
      dueAt: NOW + WINDOW_MS,
      checkpoint: "checkpoint-before",
    });
    expect(state.terminalWork).toMatchObject({
      state: "non_reassuring",
      terminalReceipt: { reason },
    });
  });

  test.each([
    ["blank checkpoint", "   "],
    ["checkpoint over 512 UTF-8 bytes", "😀".repeat(129)],
  ])("%s is malformed, preserves the prior checkpoint, and keeps valid receipt cost", async (_label, checkpoint) => {
    const t = convexTest(schema, modules);
    const seeded = await seedAccountWithCompany(t, `malformed_checkpoint_${checkpoint.length}`, {
      initialCheckpoint: "checkpoint-before",
    });
    const claim = await claimForTest(t);

    expect(await finalizeComplete(t, claim, { checkpoint })).toMatchObject({
      status: "non_reassuring",
      reason: "malformed",
    });
    const state = await t.run(async (ctx) => ({
      obligation: await ctx.db
        .query("companyMonitoringScanObligations")
        .withIndex("by_account_company_source", (q) =>
          q
            .eq("ownerAccountId", seeded.ownerAccountId)
            .eq("companyId", seeded.companyId)
            .eq("source", "exa"),
        )
        .unique(),
      terminalWork: await ctx.db
        .query("companyMonitoringScanWorkItems")
        .withIndex("by_workId", (q) => q.eq("workId", claim.work.workId))
        .unique(),
    }));
    expect(state.obligation).toMatchObject({
      state: "due",
      checkpoint: "checkpoint-before",
    });
    expect(state.terminalWork).toMatchObject({
      state: "non_reassuring",
      terminalReceipt: { reason: "malformed", costUsdMicros: 125 },
    });
  });

  test.each([
    ["negative", -1],
    ["above maximum", 1_000_000_000_001],
  ])("%s cost is malformed, preserves the prior checkpoint, and records zero cost", async (_label, costUsdMicros) => {
    const t = convexTest(schema, modules);
    const seeded = await seedAccountWithCompany(t, `invalid_cost_${String(costUsdMicros)}`, {
      initialCheckpoint: "checkpoint-before",
    });
    const claim = await claimForTest(t);

    expect(await finalizeComplete(t, claim, { costUsdMicros })).toMatchObject({
      status: "non_reassuring",
      reason: "malformed",
      receipt: { costUsdMicros: 0 },
    });
    const state = await t.run(async (ctx) => ({
      obligation: await ctx.db
        .query("companyMonitoringScanObligations")
        .withIndex("by_account_company_source", (q) =>
          q
            .eq("ownerAccountId", seeded.ownerAccountId)
            .eq("companyId", seeded.companyId)
            .eq("source", "exa"),
        )
        .unique(),
      terminalWork: await ctx.db
        .query("companyMonitoringScanWorkItems")
        .withIndex("by_workId", (q) => q.eq("workId", claim.work.workId))
        .unique(),
    }));
    expect(state.obligation).toMatchObject({
      state: "due",
      checkpoint: "checkpoint-before",
    });
    expect(state.terminalWork).toMatchObject({
      state: "non_reassuring",
      terminalReceipt: { reason: "malformed", costUsdMicros: 0 },
    });
  });

  test("provider errors preserve checkpoints with a closed reason code", async () => {
    const t = convexTest(schema, modules);
    const seeded = await seedAccountWithCompany(t, "provider_error", {
      initialCheckpoint: "checkpoint-before",
    });
    const claim = await claimForTest(t);
    const result = await t.mutation(ORCHESTRATION.finalizeWorkForTest, {
      workerId: "worker-a",
      workId: claim.work.workId,
      leaseToken: claim.work.leaseToken,
      result: { type: "provider_error", reason: "timeout", costUsdMicros: 25 },
    });
    expect(result).toMatchObject({ status: "non_reassuring", reason: "provider_error" });
    const obligation = await t.run(async (ctx) =>
      ctx.db
        .query("companyMonitoringScanObligations")
        .withIndex("by_account_company_source", (q) =>
          q
            .eq("ownerAccountId", seeded.ownerAccountId)
            .eq("companyId", seeded.companyId)
            .eq("source", "exa"),
        )
        .unique(),
    );
    expect(obligation).toMatchObject({
      state: "due",
      checkpoint: "checkpoint-before",
    });
  });
});
