import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import {
  installCompanyMonitoringTestEnvironment,
  modules,
  NOW,
  schema,
} from "./companyMonitoring.helpers";
import { assertValidCandidateState } from "../companyMonitoring/validators";
import { internal } from "../_generated/api";

const EVIDENCE = internal.companyMonitoring.evidence;
const ADMISSION = (internal as any).companyMonitoring.admission;
const ACCOUNT = "cm_account_candidate_state";
const COMPANY = "cm_company_01K27CCCCCCCCCCCCCCCCCCCCC";
const DAY_MS = 24 * 60 * 60 * 1000;
const REQUESTED_MODEL_VERSION = "openrouter/google/gemini-2.5-flash";
const STATE_INVALID = /COMPANY_MONITORING_CANDIDATE_STATE_INVALID/;

installCompanyMonitoringTestEnvironment();

async function seedCompany(t: ReturnType<typeof convexTest>) {
  await t.run(async (ctx) => {
    await ctx.db.insert("companyMonitoringAccounts", {
      logicalAccountId: ACCOUNT,
      ownerUserId: `user_${ACCOUNT}`,
      ownerFenceHash: `fence_${ACCOUNT}`,
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
      ownerAccountId: ACCOUNT,
      companyId: COMPANY,
      name: "Candidate State Co",
      sortName: "candidate state co",
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
      ownerAccountId: ACCOUNT,
      companyId: COMPANY,
      claimId: `cm_claim_${COMPANY.slice(-26)}`,
      type: "legal_identifier",
      value: "lei:CANDSTATE",
      provenance: "independent_provider",
      trustState: "verified",
      allowedUses: ["attribution"],
      expiresAt: NOW + 30 * DAY_MS,
      createdAt: NOW,
      updatedAt: NOW,
    });
  });
}

async function storedCandidate(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => ctx.db
    .query("companyMonitoringCandidates")
    .withIndex("by_account_company", (q) =>
      q.eq("ownerAccountId", ACCOUNT).eq("companyId", COMPANY),
    )
    .unique());
}

function exaEvidence() {
  return {
    provider: "exa" as const,
    providerLocator: "candidate-state-locator",
    queryVersion: "exa-company-discovery-v1",
    url: "https://independent.example/candidate-state-update",
    title: "Company update (lei:CANDSTATE)",
    publishedAt: NOW - 1_000,
    observedAt: NOW,
    expiresAt: NOW + DAY_MS,
    candidateCompanyIds: [COMPANY],
    sourceAuthority: "independent_source" as const,
  };
}

describe("Company Monitoring candidate state invariant", () => {
  describe("assertValidCandidateState accepts every legal state", () => {
    test("pending_classification with no siblings", () => {
      expect(() =>
        assertValidCandidateState({ state: "pending_classification" })
      ).not.toThrow();
    });

    test("held with a holdUntil", () => {
      expect(() =>
        assertValidCandidateState({ state: "held", holdUntil: NOW + DAY_MS })
      ).not.toThrow();
    });

    test("terminal with a terminalReason", () => {
      expect(() =>
        assertValidCandidateState({ state: "terminal", terminalReason: "rejected" })
      ).not.toThrow();
    });
  });

  describe("assertValidCandidateState rejects every illegal combination", () => {
    test("held without a holdUntil", () => {
      expect(() => assertValidCandidateState({ state: "held" })).toThrow(STATE_INVALID);
    });

    test("terminal without a terminalReason", () => {
      expect(() => assertValidCandidateState({ state: "terminal" })).toThrow(STATE_INVALID);
    });

    test("terminalReason stranded on a pending candidate", () => {
      expect(() =>
        assertValidCandidateState({
          state: "pending_classification",
          terminalReason: "rejected",
        })
      ).toThrow(STATE_INVALID);
    });

    test("holdUntil stranded on a terminal candidate", () => {
      expect(() =>
        assertValidCandidateState({
          state: "terminal",
          terminalReason: "rejected",
          holdUntil: NOW + DAY_MS,
        })
      ).toThrow(STATE_INVALID);
    });

    test("holdUntil stranded on a pending candidate", () => {
      expect(() =>
        assertValidCandidateState({
          state: "pending_classification",
          holdUntil: NOW + DAY_MS,
        })
      ).toThrow(STATE_INVALID);
    });

    test("terminalReason stranded on a held candidate", () => {
      expect(() =>
        assertValidCandidateState({
          state: "held",
          holdUntil: NOW + DAY_MS,
          terminalReason: "admitted",
        })
      ).toThrow(STATE_INVALID);
    });
  });

  test("a writer path (recompute) fails closed on an out-of-band corrupt candidate row", async () => {
    const t = convexTest(schema, modules);
    await seedCompany(t);
    await t.mutation(EVIDENCE.ingestEvidenceForTest, {
      ownerAccountId: ACCOUNT,
      companyIds: [COMPANY],
      evidence: [exaEvidence()],
    });
    const candidate = await t.run(async (ctx) => ctx.db
      .query("companyMonitoringCandidates")
      .withIndex("by_account_company", (q) =>
        q.eq("ownerAccountId", ACCOUNT).eq("companyId", COMPANY),
      )
      .unique());
    expect(candidate).toMatchObject({ state: "pending_classification" });

    // The flat schema permits this illegal write; a tagged union would not.
    await t.run(async (ctx) => {
      await ctx.db.patch(candidate!._id, { terminalReason: "rejected" });
    });

    await expect(
      t.mutation(EVIDENCE.recomputeCompanyEvidenceForTest, {
        ownerAccountId: ACCOUNT,
        companyId: COMPANY,
        occurrenceDedupeKey: candidate!.occurrenceDedupeKey,
      }),
    ).rejects.toThrow(STATE_INVALID);
  });

  test("admission claim fails closed before leasing an out-of-band corrupt candidate", async () => {
    const t = convexTest(schema, modules);
    await seedCompany(t);
    await t.mutation(EVIDENCE.ingestEvidenceForTest, {
      ownerAccountId: ACCOUNT,
      companyIds: [COMPANY],
      evidence: [exaEvidence()],
    });
    const candidate = await storedCandidate(t);
    expect(candidate).toMatchObject({ state: "pending_classification" });

    await t.run(async (ctx) => {
      await ctx.db.patch(candidate!._id, { terminalReason: "rejected" });
    });

    await expect(
      t.mutation(ADMISSION.claimNextAdmissionCandidateForTest, {
        workerId: "candidate-state-worker",
        classificationRunId: "candidate-state-run",
        requestedModelVersion: REQUESTED_MODEL_VERSION,
      }),
    ).rejects.toThrow(STATE_INVALID);

    expect(await storedCandidate(t)).not.toHaveProperty("classificationLeaseToken");
  });

  test("evidence refresh fails closed before normalizing a corrupt held candidate", async () => {
    const t = convexTest(schema, modules);
    await seedCompany(t);
    await t.mutation(EVIDENCE.ingestEvidenceForTest, {
      ownerAccountId: ACCOUNT,
      companyIds: [COMPANY],
      evidence: [exaEvidence()],
    });
    const candidate = await storedCandidate(t);
    expect(candidate).toMatchObject({ state: "pending_classification" });

    await t.run(async (ctx) => {
      await ctx.db.patch(candidate!._id, {
        state: "held",
        holdUntil: NOW + DAY_MS,
        terminalReason: "admitted",
        evidenceSnapshotDigest: "out-of-band-stale-digest",
      });
    });

    await expect(
      t.mutation(EVIDENCE.recomputeCompanyEvidenceForTest, {
        ownerAccountId: ACCOUNT,
        companyId: COMPANY,
        occurrenceDedupeKey: candidate!.occurrenceDedupeKey,
      }),
    ).rejects.toThrow(STATE_INVALID);

    expect(await storedCandidate(t)).toMatchObject({
      state: "held",
      holdUntil: NOW + DAY_MS,
      terminalReason: "admitted",
    });
  });
});
