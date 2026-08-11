import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import {
  installCompanyMonitoringTestEnvironment,
  modules,
  NOW,
  schema,
} from "./companyMonitoring.helpers";
import { internal } from "../_generated/api";

const EVIDENCE = (internal as any).companyMonitoring.evidence;
const COMPANIES = (internal as any).companyMonitoring.companies;
const ACCOUNT_A = "cm_account_evidence_a";
const ACCOUNT_B = "cm_account_evidence_b";
const COMPANY_A = "cm_company_01K27AAAAAAAAAAAAAAAAAAAAA";
const COMPANY_B = "cm_company_01K27BBBBBBBBBBBBBBBBBBBBB";
const DAY_MS = 24 * 60 * 60 * 1000;

installCompanyMonitoringTestEnvironment();

async function seedCompany(
  t: ReturnType<typeof convexTest>,
  ownerAccountId: string,
  companyId: string,
  legalIdentifier: string,
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("companyMonitoringAccounts", {
      logicalAccountId: ownerAccountId,
      ownerUserId: `user_${ownerAccountId}`,
      ownerFenceHash: `fence_${ownerAccountId}`,
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
      name: `Company ${companyId.at(-1)}`,
      sortName: `company ${companyId.at(-1)}`,
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
      claimId: `claim_${legalIdentifier}`,
      type: "legal_identifier",
      value: legalIdentifier,
      provenance: "independent_provider",
      trustState: "verified",
      allowedUses: ["attribution"],
      expiresAt: NOW + 30 * DAY_MS,
      createdAt: NOW,
      updatedAt: NOW,
    });
  });
}

function subject(companyId: string, legalIdentifier: string) {
  return {
    companyId,
    name: `Company ${companyId.at(-1)}`,
    claims: [{
      claimId: `claim_${legalIdentifier}`,
      type: "legal_identifier",
      value: legalIdentifier,
      trustState: "verified",
      allowedUses: ["attribution"],
      expiresAt: NOW + 30 * DAY_MS,
    }],
  };
}

function exaEvidence(
  companyId: string,
  legalIdentifier: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    provider: "exa",
    providerLocator: "shared-provider-locator",
    url: "https://independent.example/company-update",
    title: `Company update (${legalIdentifier})`,
    publishedAt: NOW - 1_000,
    observedAt: NOW,
    expiresAt: NOW + DAY_MS,
    candidateCompanyIds: [companyId],
    sourceAuthority: "independent_source",
    ...overrides,
  };
}

async function candidateFor(
  t: ReturnType<typeof convexTest>,
  ownerAccountId: string,
  companyId: string,
) {
  return t.run(async (ctx) => ctx.db
    .query("companyMonitoringCandidates")
    .withIndex("by_account_company", (q) =>
      q.eq("ownerAccountId", ownerAccountId).eq("companyId", companyId),
    )
    .unique());
}

describe("Company Monitoring evidence persistence and candidate lifecycle", () => {
  test("duplicates provider locators inside each tenant and never shares lookup rows", async () => {
    const t = convexTest(schema, modules);
    await seedCompany(t, ACCOUNT_A, COMPANY_A, "lei:A123");
    await seedCompany(t, ACCOUNT_B, COMPANY_B, "lei:B456");

    await t.mutation(EVIDENCE.ingestEvidenceForTest, {
      ownerAccountId: ACCOUNT_A,
      subjects: [subject(COMPANY_A, "lei:A123")],
      evidence: [exaEvidence(COMPANY_A, "lei:A123")],
    });
    await t.mutation(EVIDENCE.ingestEvidenceForTest, {
      ownerAccountId: ACCOUNT_B,
      subjects: [subject(COMPANY_B, "lei:B456")],
      evidence: [exaEvidence(COMPANY_B, "lei:B456")],
    });

    const rows = await t.run(async (ctx) => ctx.db.query("companyMonitoringEvidence").collect());
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.ownerAccountId))).toEqual(new Set([ACCOUNT_A, ACCOUNT_B]));
    expect(rows[0]?.providerLocatorHash).toBe(rows[1]?.providerLocatorHash);
    expect(rows[0]?.evidenceFingerprint).not.toBe(rows[1]?.evidenceFingerprint);
    expect((await candidateFor(t, ACCOUNT_A, COMPANY_A))?.referenceCount).toBe(1);
    expect((await candidateFor(t, ACCOUNT_B, COMPANY_B))?.referenceCount).toBe(1);
  });

  test("records attempts and holds, then recomputes expiry and restored authority", async () => {
    const t = convexTest(schema, modules);
    await seedCompany(t, ACCOUNT_A, COMPANY_A, "lei:A123");
    await t.mutation(EVIDENCE.ingestEvidenceForTest, {
      ownerAccountId: ACCOUNT_A,
      subjects: [subject(COMPANY_A, "lei:A123")],
      evidence: [exaEvidence(COMPANY_A, "lei:A123")],
    });
    const original = await candidateFor(t, ACCOUNT_A, COMPANY_A);
    expect(original).toMatchObject({
      state: "pending_classification",
      attemptCount: 0,
      observationBlocking: true,
    });

    await t.mutation(EVIDENCE.recordCandidateAttempt, {
      ownerAccountId: ACCOUNT_A,
      companyId: COMPANY_A,
      occurrenceDedupeKey: original!.occurrenceDedupeKey,
      outcome: "held",
      holdUntil: NOW + 6 * 60 * 60 * 1000,
    });
    expect(await candidateFor(t, ACCOUNT_A, COMPANY_A)).toMatchObject({
      state: "held",
      attemptCount: 1,
      holdUntil: NOW + 6 * 60 * 60 * 1000,
    });

    vi.setSystemTime(NOW + 2 * DAY_MS);
    await t.mutation(EVIDENCE.recomputeCompanyEvidenceForTest, {
      ownerAccountId: ACCOUNT_A,
      companyId: COMPANY_A,
      occurrenceDedupeKey: original!.occurrenceDedupeKey,
    });
    expect(await candidateFor(t, ACCOUNT_A, COMPANY_A)).toMatchObject({
      state: "terminal",
      terminalReason: "evidence_expired",
      attemptCount: 1,
      observationBlocking: false,
      referenceCount: 0,
    });

    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("companyMonitoringEvidence")
        .withIndex("by_account_company", (q) =>
          q.eq("ownerAccountId", ACCOUNT_A).eq("companyId", COMPANY_A),
        )
        .unique();
      await ctx.db.patch(row!._id, { state: "active", expiresAt: NOW + 5 * DAY_MS });
    });
    await t.mutation(EVIDENCE.recomputeCompanyEvidenceForTest, {
      ownerAccountId: ACCOUNT_A,
      companyId: COMPANY_A,
      occurrenceDedupeKey: original!.occurrenceDedupeKey,
    });
    expect(await candidateFor(t, ACCOUNT_A, COMPANY_A)).toMatchObject({
      state: "pending_classification",
      attemptCount: 1,
      observationBlocking: true,
    });
    expect((await candidateFor(t, ACCOUNT_A, COMPANY_A))?.terminalReason).toBeUndefined();

    vi.setSystemTime(NOW + 4 * DAY_MS);
    await t.mutation(EVIDENCE.recomputeCompanyEvidenceForTest, {
      ownerAccountId: ACCOUNT_A,
      companyId: COMPANY_A,
      occurrenceDedupeKey: original!.occurrenceDedupeKey,
    });
    expect(await candidateFor(t, ACCOUNT_A, COMPANY_A)).toMatchObject({
      state: "terminal",
      terminalReason: "hold_expired",
      attemptCount: 1,
      observationBlocking: false,
    });
  });

  test("purges evidence and candidates in resumable company phases before payload", async () => {
    const t = convexTest(schema, modules);
    await seedCompany(t, ACCOUNT_A, COMPANY_A, "lei:A123");
    const evidence = Array.from({ length: 26 }, (_, index) => exaEvidence(
      COMPANY_A,
      "lei:A123",
      {
        providerLocator: `purge-locator-${index}`,
        url: `https://source-${index}.example/company-update`,
        title: `Company update ${index} (lei:A123)`,
      },
    ));
    await t.mutation(EVIDENCE.ingestEvidenceForTest, {
      ownerAccountId: ACCOUNT_A,
      subjects: [subject(COMPANY_A, "lei:A123")],
      evidence,
    });
    await t.run(async (ctx) => {
      const company = await ctx.db
        .query("companyMonitoringCompanies")
        .withIndex("by_account_companyId", (q) =>
          q.eq("ownerAccountId", ACCOUNT_A).eq("companyId", COMPANY_A),
        )
        .unique();
      await ctx.db.patch(company!._id, {
        lifecycle: "removed",
        purgeGeneration: 1,
        purgePhase: "scan",
        removedAt: NOW,
      });
    });
    const args = { ownerAccountId: ACCOUNT_A, companyId: COMPANY_A, purgeGeneration: 1 };
    expect(await t.mutation(COMPANIES.advanceCompanyPurge, args)).toEqual({ status: "evidence" });
    expect(await t.mutation(COMPANIES.advanceCompanyPurge, args)).toEqual({ status: "candidates" });
    expect(await t.mutation(COMPANIES.advanceCompanyPurge, args)).toEqual({ status: "candidates" });
    expect(await t.mutation(COMPANIES.advanceCompanyPurge, args)).toEqual({ status: "candidates" });
    expect(await t.mutation(COMPANIES.advanceCompanyPurge, args)).toEqual({ status: "complete" });

    const state = await t.run(async (ctx) => ({
      evidence: await ctx.db.query("companyMonitoringEvidence").collect(),
      candidates: await ctx.db.query("companyMonitoringCandidates").collect(),
      company: await ctx.db
        .query("companyMonitoringCompanies")
        .withIndex("by_account_companyId", (q) =>
          q.eq("ownerAccountId", ACCOUNT_A).eq("companyId", COMPANY_A),
        )
        .unique(),
    }));
    expect(state.evidence).toEqual([]);
    expect(state.candidates).toEqual([]);
    expect(state.company).toMatchObject({ purgePhase: "complete" });
    expect(state.company?.name).toBeUndefined();
  });
});
