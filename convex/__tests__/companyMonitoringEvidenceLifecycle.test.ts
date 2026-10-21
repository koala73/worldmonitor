import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import {
  grant,
  installCompanyMonitoringTestEnvironment,
  modules,
  NOW,
  schema,
} from "./companyMonitoring.helpers";
import { internal } from "../_generated/api";

const EVIDENCE = internal.companyMonitoring.evidence;
const ADMISSION = (internal as any).companyMonitoring.admission;
const COMPANIES = internal.companyMonitoring.companies;
const ACCOUNT_A = "cm_account_evidence_a";
const ACCOUNT_B = "cm_account_evidence_b";
const COMPANY_A = "cm_company_01K27AAAAAAAAAAAAAAAAAAAAA";
const COMPANY_B = "cm_company_01K27BBBBBBBBBBBBBBBBBBBBB";
const DAY_MS = 24 * 60 * 60 * 1000;
const REQUESTED_MODEL_VERSION = "cm-classifier-model-test";

function claimArgs(workerId: string, classificationRunId = `claim-${workerId}`) {
  return { workerId, classificationRunId, requestedModelVersion: REQUESTED_MODEL_VERSION };
}

installCompanyMonitoringTestEnvironment();

async function seedCompany(
  t: ReturnType<typeof convexTest>,
  ownerAccountId: string,
  companyId: string,
  legalIdentifier: string,
  claimExpiresAt = NOW + 30 * DAY_MS,
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
      claimId: `cm_claim_${companyId.slice(-26)}`,
      type: "legal_identifier",
      value: legalIdentifier,
      provenance: "independent_provider",
      trustState: "verified",
      allowedUses: ["attribution"],
      expiresAt: claimExpiresAt,
      createdAt: NOW,
      updatedAt: NOW,
    });
  });
}

function xEvidence(
  companyId: string,
  index: number,
  overrides: Record<string, unknown> = {},
) {
  const postId = String(1_900_000_000_000_000_000n + BigInt(index));
  return {
    provider: "x",
    providerLocator: postId,
    queryVersion: "x-company-discovery-v1",
    url: `https://x.com/i/status/${postId}`,
    text: `Official update ${index}`,
    author: "companya",
    authorAccountId: "123456789",
    publishedAt: NOW - 1_000 + index,
    observedAt: NOW,
    expiresAt: NOW + DAY_MS,
    candidateCompanyIds: [companyId],
    verifiedCompanyIds: [companyId],
    sourceAuthority: "verified_first_party",
    ...overrides,
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
    queryVersion: "exa-company-discovery-v1",
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

function validMaterialOutput(evidenceId: string) {
  const axis = (truth: string, confidence: number) => ({
    truth,
    confidence,
    rationale: "The normalized evidence supports this conclusion.",
    evidenceIds: [evidenceId],
  });
  return {
    attribution: axis("confirmed", 0.96),
    occurrence: axis("confirmed", 0.92),
    materiality: axis("material", 0.84),
    direction: "negative",
    channels: ["financial"],
    magnitude: "high",
    category: "material_event",
    title: "Company reports material event",
    neutralSummary: "The company reported a material event.",
    positiveRationale: "",
    negativeRationale: "The event can reduce financial performance.",
    conflict: false,
  };
}

describe("Company Monitoring evidence persistence and candidate lifecycle", () => {
  test("duplicates provider locators inside each tenant and never shares lookup rows", async () => {
    const t = convexTest(schema, modules);
    await seedCompany(t, ACCOUNT_A, COMPANY_A, "lei:A123");
    await seedCompany(t, ACCOUNT_B, COMPANY_B, "lei:B456");

    await t.mutation(EVIDENCE.ingestEvidenceForTest, {
      ownerAccountId: ACCOUNT_A,
      companyIds: [COMPANY_A],
      evidence: [exaEvidence(COMPANY_A, "lei:A123")],
    });
    await t.mutation(EVIDENCE.ingestEvidenceForTest, {
      ownerAccountId: ACCOUNT_B,
      companyIds: [COMPANY_B],
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

  test("does not revise an unchanged candidate snapshot during provider refresh", async () => {
    const t = convexTest(schema, modules);
    await seedCompany(t, ACCOUNT_A, COMPANY_A, "lei:A123");
    const evidence = exaEvidence(COMPANY_A, "lei:A123");
    await t.mutation(EVIDENCE.ingestEvidenceForTest, {
      ownerAccountId: ACCOUNT_A,
      companyIds: [COMPANY_A],
      evidence: [evidence],
    });
    const original = await candidateFor(t, ACCOUNT_A, COMPANY_A);

    vi.advanceTimersByTime(1_000);
    await t.mutation(EVIDENCE.ingestEvidenceForTest, {
      ownerAccountId: ACCOUNT_A,
      companyIds: [COMPANY_A],
      evidence: [evidence],
    });

    expect(await candidateFor(t, ACCOUNT_A, COMPANY_A)).toMatchObject({
      evidenceRevision: original!.evidenceRevision,
      evidenceSnapshotDigest: original!.evidenceSnapshotDigest,
      updatedAt: original!.updatedAt,
    });
  });

  test("records attempts and holds, then recomputes expiry and restored authority", async () => {
    const t = convexTest(schema, modules);
    await seedCompany(t, ACCOUNT_A, COMPANY_A, "lei:A123");
    await t.mutation(EVIDENCE.ingestEvidenceForTest, {
      ownerAccountId: ACCOUNT_A,
      companyIds: [COMPANY_A],
      evidence: [exaEvidence(COMPANY_A, "lei:A123")],
    });
    const original = await candidateFor(t, ACCOUNT_A, COMPANY_A);
    expect(original).toMatchObject({
      state: "pending_classification",
      attemptCount: 0,
      observationBlocking: true,
    });

    const claim = await t.mutation(
      ADMISSION.claimNextAdmissionCandidateForTest,
      claimArgs("worker-evidence-lifecycle", "lifecycle-hold-1"),
    );
    expect(claim.status).toBe("claimed");
    await t.mutation(ADMISSION.recordAdmissionDecisionForTest, {
      workerId: "worker-evidence-lifecycle",
      leaseToken: claim.leaseToken!,
      ownerAccountId: ACCOUNT_A,
      companyId: COMPANY_A,
      occurrenceDedupeKey: original!.occurrenceDedupeKey,
      expectedEvidenceRevision: original!.evidenceRevision,
      classificationRunId: "lifecycle-hold-1",
      requestedModelVersion: REQUESTED_MODEL_VERSION,
      modelVersion: "cm-classifier-model-test-v1",
      modelOutput: validMaterialOutput(original!.referenceEvidenceFingerprints[0]!),
    });
    expect(await candidateFor(t, ACCOUNT_A, COMPANY_A)).toMatchObject({
      state: "held",
      attemptCount: 1,
      holdUntil: NOW + 6 * 60 * 60 * 1000,
    });

    vi.advanceTimersByTime(6 * 60 * 60 * 1000 + 1);
    await t.finishInProgressScheduledFunctions();
    expect(await candidateFor(t, ACCOUNT_A, COMPANY_A)).toMatchObject({
      state: "pending_classification",
      attemptCount: 1,
      observationBlocking: true,
    });
    expect((await candidateFor(t, ACCOUNT_A, COMPANY_A))?.holdUntil).toBeUndefined();

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

  test("recomputes the old occurrence when one provider locator changes content", async () => {
    const t = convexTest(schema, modules);
    await seedCompany(t, ACCOUNT_A, COMPANY_A, "lei:A123");
    await t.mutation(EVIDENCE.ingestEvidenceForTest, {
      ownerAccountId: ACCOUNT_A,
      companyIds: [COMPANY_A],
      evidence: [exaEvidence(COMPANY_A, "lei:A123")],
    });
    const original = await candidateFor(t, ACCOUNT_A, COMPANY_A);

    vi.setSystemTime(NOW + 1_000);
    await t.mutation(EVIDENCE.ingestEvidenceForTest, {
      ownerAccountId: ACCOUNT_A,
      companyIds: [COMPANY_A],
      evidence: [exaEvidence(COMPANY_A, "lei:A123", {
        title: "Corrected company update (lei:A123)",
        observedAt: NOW + 1_000,
      })],
    });

    const state = await t.run(async (ctx) => ({
      evidence: await ctx.db
        .query("companyMonitoringEvidence")
        .withIndex("by_account_company", (q) =>
          q.eq("ownerAccountId", ACCOUNT_A).eq("companyId", COMPANY_A),
        )
        .collect(),
      candidates: await ctx.db
        .query("companyMonitoringCandidates")
        .withIndex("by_account_company", (q) =>
          q.eq("ownerAccountId", ACCOUNT_A).eq("companyId", COMPANY_A),
        )
        .collect(),
    }));
    expect(state.evidence).toHaveLength(1);
    expect(state.evidence[0]).toMatchObject({ firstSeenAt: NOW + 1_000 });
    expect(state.candidates).toHaveLength(2);
    expect(state.candidates.find((row) => row.occurrenceDedupeKey === original?.occurrenceDedupeKey))
      .toMatchObject({
        state: "terminal",
        terminalReason: "evidence_unavailable",
        observationBlocking: false,
        referenceCount: 0,
      });
    expect(state.candidates.find((row) => row.occurrenceDedupeKey !== original?.occurrenceDedupeKey))
      .toMatchObject({
        state: "pending_classification",
        observationBlocking: true,
        referenceCount: 1,
      });

    vi.setSystemTime(NOW + DAY_MS + 1);
    await t.mutation(EVIDENCE.recomputeCompanyEvidenceForTest, {
      ownerAccountId: ACCOUNT_A,
      companyId: COMPANY_A,
      occurrenceDedupeKey: original!.occurrenceDedupeKey,
    });
    const oldCandidate = await t.run(async (ctx) => ctx.db
      .query("companyMonitoringCandidates")
      .withIndex("by_account_company_occurrence", (q) =>
        q
          .eq("ownerAccountId", ACCOUNT_A)
          .eq("companyId", COMPANY_A)
          .eq("occurrenceDedupeKey", original!.occurrenceDedupeKey),
      )
      .unique());
    expect(oldCandidate).toMatchObject({ terminalReason: "evidence_unavailable" });
  });

  test("persists the maximal 25 by 25 Exa expansion with one expiry chain per occurrence", async () => {
    const t = convexTest(schema, modules);
    const companyIds = Array.from(
      { length: 25 },
      (_, index) => `cm_company_${String(index + 1).padStart(26, "0")}`,
    );
    const identifiers = companyIds.map((_, index) => `lei:BOUNDARY${index + 1}`);
    await t.run(async (ctx) => {
      await ctx.db.insert("companyMonitoringAccounts", {
        logicalAccountId: ACCOUNT_A,
        ownerUserId: `user_${ACCOUNT_A}`,
        ownerFenceHash: `fence_${ACCOUNT_A}`,
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
          ownerAccountId: ACCOUNT_A,
          companyId,
          name: `Boundary Company ${index + 1}`,
          sortName: `boundary company ${index + 1}`,
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
          ownerAccountId: ACCOUNT_A,
          companyId,
          claimId: `cm_claim_${String(index + 1).padStart(26, "0")}`,
          type: "legal_identifier",
          value: identifiers[index]!,
          provenance: "independent_provider",
          trustState: "verified",
          allowedUses: ["attribution"],
          expiresAt: NOW + 30 * DAY_MS,
          createdAt: NOW,
          updatedAt: NOW,
        });
      }
    });
    const allIdentifiers = identifiers.join(" ");
    const evidence = Array.from({ length: 25 }, (_, index) => ({
      provider: "exa",
      providerLocator: `boundary-result-${index}`,
      url: `https://source-${index}.example/boundary-update`,
      title: `Boundary report ${index} ${allIdentifiers}`,
      publishedAt: NOW - index,
      observedAt: NOW,
      expiresAt: NOW + DAY_MS,
      candidateCompanyIds: companyIds,
      sourceAuthority: "independent_source",
    }));

    await expect(t.mutation(EVIDENCE.ingestEvidenceForTest, {
      ownerAccountId: ACCOUNT_A,
      companyIds,
      evidence,
    })).resolves.toMatchObject({ evidenceCount: 625, candidateCount: 625, companyCount: 25 });

    const stored = await t.run(async (ctx) => ({
      evidence: await ctx.db.query("companyMonitoringEvidence").collect(),
      candidates: await ctx.db.query("companyMonitoringCandidates").collect(),
      scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
    }));
    expect(stored.evidence).toHaveLength(625);
    expect(stored.candidates).toHaveLength(625);
    expect(stored.scheduled.filter((job) =>
      job.name.includes("recomputeCompanyEvidence") ||
      job.name.includes("revalidateExpiredCompanyEvidenceClaims")
    )).toHaveLength(650);
  }, 30_000);

  test("re-attributes evidence to a remaining claim, then invalidates it after final removal", async () => {
    const t = convexTest(schema, modules);
    const ownerUserId = `user_${ACCOUNT_A}`;
    await grant(t, ownerUserId);
    await seedCompany(t, ACCOUNT_A, COMPANY_A, "lei:A123");
    const firstClaimId = `cm_claim_${COMPANY_A.slice(-26)}`;
    const replacementClaimId = "cm_claim_01K28AAAAAAAAAAAAAAAAAAAAA";
    await t.run(async (ctx) => {
      await ctx.db.insert("companyMonitoringClaims", {
        ownerAccountId: ACCOUNT_A,
        companyId: COMPANY_A,
        claimId: replacementClaimId,
        type: "legal_identifier",
        value: "lei:A123",
        provenance: "independent_provider",
        trustState: "verified",
        allowedUses: ["attribution"],
        expiresAt: NOW + 30 * DAY_MS,
        createdAt: NOW,
        updatedAt: NOW,
      });
    });
    const evidence = Array.from({ length: 26 }, (_, index) => exaEvidence(
      COMPANY_A,
      "lei:A123",
      {
        providerLocator: `claim-revalidation-${index}`,
        url: `https://claim-source-${index}.example/company-update`,
      },
    ));
    await t.mutation(EVIDENCE.ingestEvidenceForTest, {
      ownerAccountId: ACCOUNT_A,
      companyIds: [COMPANY_A],
      evidence,
    });
    await t.run(async (ctx) => {
      const company = await ctx.db
        .query("companyMonitoringCompanies")
        .withIndex("by_account_companyId", (q) =>
          q.eq("ownerAccountId", ACCOUNT_A).eq("companyId", COMPANY_A),
        )
        .unique();
      await ctx.db.patch(company!._id, { lifecycle: "paused" });
    });

    await t.mutation(COMPANIES.updateCompanyForOwner, {
      ownerUserId,
      companyId: COMPANY_A,
      patch: { removeClaimIds: [firstClaimId] },
    });
    vi.advanceTimersByTime(1);
    await t.finishInProgressScheduledFunctions();
    let rows = await t.run(async (ctx) => ctx.db.query("companyMonitoringEvidence").collect());
    expect(rows).toHaveLength(26);
    expect(rows.every((row) =>
      row.state === "active" && row.matchedClaimIds.join() === replacementClaimId
    )).toBe(true);
    expect((await candidateFor(t, ACCOUNT_A, COMPANY_A))?.observationBlocking).toBe(true);

    await t.mutation(COMPANIES.updateCompanyForOwner, {
      ownerUserId,
      companyId: COMPANY_A,
      patch: { removeClaimIds: [replacementClaimId] },
    });
    vi.advanceTimersByTime(1);
    await t.finishInProgressScheduledFunctions();
    rows = await t.run(async (ctx) => ctx.db.query("companyMonitoringEvidence").collect());
    expect(rows.every((row) => row.state === "authority_lost")).toBe(true);
    expect(await candidateFor(t, ACCOUNT_A, COMPANY_A)).toMatchObject({
      state: "terminal",
      terminalReason: "authority_lost",
      observationBlocking: false,
      referenceCount: 0,
    });
  });

  test("re-earns Exa first-party authority from current claims during revalidation", async () => {
    const t = convexTest(schema, modules);
    await seedCompany(t, ACCOUNT_A, COMPANY_A, "lei:A123");
    const domainClaimId = `cm_claim_${COMPANY_A.slice(-26)}`;
    const aliasClaimId = "cm_claim_01K2AAAAAAAAAAAAAAAAAAAAAA";
    await t.run(async (ctx) => {
      const legalIdentifier = await ctx.db
        .query("companyMonitoringClaims")
        .withIndex("by_account_company", (q) =>
          q.eq("ownerAccountId", ACCOUNT_A).eq("companyId", COMPANY_A),
        )
        .unique();
      await ctx.db.delete(legalIdentifier!._id);
      await ctx.db.insert("companyMonitoringClaims", {
        ownerAccountId: ACCOUNT_A,
        companyId: COMPANY_A,
        claimId: domainClaimId,
        type: "domain",
        value: "companya.example",
        provenance: "independent_provider",
        trustState: "verified",
        allowedUses: ["attribution"],
        createdAt: NOW,
        updatedAt: NOW,
      });
      await ctx.db.insert("companyMonitoringClaims", {
        ownerAccountId: ACCOUNT_A,
        companyId: COMPANY_A,
        claimId: aliasClaimId,
        type: "alias",
        value: "Company A",
        provenance: "customer",
        trustState: "unverified",
        allowedUses: ["attribution", "discovery"],
        createdAt: NOW,
        updatedAt: NOW,
      });
    });
    await t.mutation(EVIDENCE.ingestEvidenceForTest, {
      ownerAccountId: ACCOUNT_A,
      companyIds: [COMPANY_A],
      evidence: [exaEvidence(COMPANY_A, "Company A", {
        url: "https://companya.example/official-update",
        title: "Company A official update",
      })],
    });
    expect(await candidateFor(t, ACCOUNT_A, COMPANY_A)).toMatchObject({
      observationBlocking: true,
    });

    await t.run(async (ctx) => {
      const [company, claims] = await Promise.all([
        ctx.db
          .query("companyMonitoringCompanies")
          .withIndex("by_account_companyId", (q) =>
            q.eq("ownerAccountId", ACCOUNT_A).eq("companyId", COMPANY_A),
          )
          .unique(),
        ctx.db
          .query("companyMonitoringClaims")
          .withIndex("by_account_company", (q) =>
            q.eq("ownerAccountId", ACCOUNT_A).eq("companyId", COMPANY_A),
          )
          .collect(),
      ]);
      const domainClaim = claims.find((claim) => claim.claimId === domainClaimId);
      await ctx.db.delete(domainClaim!._id);
      await ctx.db.patch(company!._id, { snapshotGeneration: 2, updatedAt: NOW + 1 });
    });
    await t.mutation(EVIDENCE.continueCompanyEvidenceClaimRevalidation, {
      ownerAccountId: ACCOUNT_A,
      companyId: COMPANY_A,
      expectedSnapshotGeneration: 2,
    });

    const row = await t.run(async (ctx) => ctx.db.query("companyMonitoringEvidence").unique());
    expect(row).toMatchObject({
      state: "active",
      matchedClaimIds: [aliasClaimId],
      sourceAuthority: "low_authority",
      independence: "unknown",
    });
    expect(await candidateFor(t, ACCOUNT_A, COMPANY_A)).toMatchObject({
      observationBlocking: false,
    });
  });

  test("expires claim authority through the scheduled bounded revalidation", async () => {
    const t = convexTest(schema, modules);
    const claimExpiresAt = NOW + 60 * 60 * 1000;
    await seedCompany(t, ACCOUNT_A, COMPANY_A, "lei:A123", claimExpiresAt);
    await t.mutation(EVIDENCE.ingestEvidenceForTest, {
      ownerAccountId: ACCOUNT_A,
      companyIds: [COMPANY_A],
      evidence: [exaEvidence(COMPANY_A, "lei:A123")],
    });

    vi.advanceTimersByTime(claimExpiresAt - NOW);
    await t.finishInProgressScheduledFunctions();

    const row = await t.run(async (ctx) => ctx.db.query("companyMonitoringEvidence").unique());
    expect(row?.state).toBe("authority_lost");
    expect(await candidateFor(t, ACCOUNT_A, COMPANY_A)).toMatchObject({
      state: "terminal",
      terminalReason: "authority_lost",
      observationBlocking: false,
    });
  });

  test("fences a delayed X authority-loss continuation after authority is restored", async () => {
    const t = convexTest(schema, modules);
    await seedCompany(t, ACCOUNT_A, COMPANY_A, "lei:A123");
    await t.run(async (ctx) => {
      await ctx.db.insert("companyMonitoringXIdentities", {
        ownerAccountId: ACCOUNT_A,
        companyId: COMPANY_A,
        domainClaimId: `cm_claim_${COMPANY_A.slice(-26)}`,
        xHandleClaimId: "cm_claim_01K29AAAAAAAAAAAAAAAAAAAAA",
        officialDomain: "companya.example",
        officialPageUrl: "https://companya.example/",
        accountId: "123456789",
        currentHandle: "companya",
        profileName: "Company A",
        domicileCountry: "US",
        authorityRole: "company",
        state: "demoted",
        demotionReason: "official_link_lost",
        badgeVerified: false,
        allowedUses: [],
        checkedAt: NOW,
        expiresAt: NOW + 7 * DAY_MS,
        evidenceHash: "a".repeat(64),
        createdAt: NOW,
        updatedAt: NOW,
      });
    });
    const rows = Array.from({ length: 26 }, (_, index) => xEvidence(COMPANY_A, index, {
      text: "Shared official update",
    }));
    await t.mutation(EVIDENCE.ingestEvidenceForTest, {
      ownerAccountId: ACCOUNT_A,
      companyIds: [COMPANY_A],
      evidence: rows,
    });
    expect(await t.mutation(EVIDENCE.setAllCompanyProviderEvidenceStateForTest, {
      ownerAccountId: ACCOUNT_A,
      companyId: COMPANY_A,
      provider: "x",
      state: "authority_lost",
    })).toMatchObject({ complete: false, status: "transitioned" });
    expect(await candidateFor(t, ACCOUNT_A, COMPANY_A)).toMatchObject({
      observationBlocking: false,
      referenceCount: 0,
    });

    await t.run(async (ctx) => {
      const identity = await ctx.db
        .query("companyMonitoringXIdentities")
        .withIndex("by_account_company", (q) =>
          q.eq("ownerAccountId", ACCOUNT_A).eq("companyId", COMPANY_A),
        )
        .unique();
      await ctx.db.patch(identity!._id, {
        state: "authoritative",
        demotionReason: undefined,
        allowedUses: ["primary_evidence", "recent_search"],
        updatedAt: NOW + 1,
      });
    });
    await t.mutation(EVIDENCE.ingestEvidenceForTest, {
      ownerAccountId: ACCOUNT_A,
      companyIds: [COMPANY_A],
      evidence: rows,
    });
    vi.advanceTimersByTime(1);
    await t.finishInProgressScheduledFunctions();

    const restored = await t.run(async (ctx) => ({
      evidence: await ctx.db.query("companyMonitoringEvidence").collect(),
      candidates: await ctx.db.query("companyMonitoringCandidates").collect(),
    }));
    expect(restored.evidence).toHaveLength(26);
    expect(restored.evidence.every((row) => row.state === "active")).toBe(true);
    expect(restored.candidates.every((candidate) => candidate.observationBlocking)).toBe(true);
  });

  test("rejects a candidate attempt when the expiry scheduler is delayed", async () => {
    const t = convexTest(schema, modules);
    await seedCompany(t, ACCOUNT_A, COMPANY_A, "lei:A123");
    await t.mutation(EVIDENCE.ingestEvidenceForTest, {
      ownerAccountId: ACCOUNT_A,
      companyIds: [COMPANY_A],
      evidence: [exaEvidence(COMPANY_A, "lei:A123")],
    });
    const candidate = await candidateFor(t, ACCOUNT_A, COMPANY_A);
    vi.setSystemTime(candidate!.expiresAt);

    expect(await t.mutation(ADMISSION.claimNextAdmissionCandidateForTest, claimArgs("worker-delayed-expiry"))).toEqual({ status: "idle" });
    expect((await candidateFor(t, ACCOUNT_A, COMPANY_A))?.attemptCount).toBe(0);
    expect(await t.run(async (ctx) =>
      ctx.db.query("companyMonitoringAdmissionDecisions").collect()
    )).toMatchObject([{ decision: "expire", reasonCodes: ["candidate_expired"] }]);
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
      companyIds: [COMPANY_A],
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
