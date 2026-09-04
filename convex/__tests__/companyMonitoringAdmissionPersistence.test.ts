import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import {
  installCompanyMonitoringTestEnvironment,
  modules,
  NOW,
  schema,
} from "./companyMonitoring.helpers";

const EVIDENCE = internal.companyMonitoring.evidence;
const ADMISSION = (internal as any).companyMonitoring.admission;
const COMPANIES = internal.companyMonitoring.companies;
const PUBLIC_ORCHESTRATION = (api as any).companyMonitoring.orchestration;
const ACCOUNT_ID = "cm_account_admission";
const COMPANY_ID = "cm_company_01K27ADMISSIONAAAAAAAAAA";
const HOUR_MS = 60 * 60 * 1000;
const REQUESTED_MODEL_VERSION = "openrouter/google/gemini-2.5-flash";

function claimArgs(workerId: string, classificationRunId = `claim-${workerId}`) {
  return { workerId, classificationRunId, requestedModelVersion: REQUESTED_MODEL_VERSION };
}

installCompanyMonitoringTestEnvironment();

async function seedCandidate(t: ReturnType<typeof convexTest>) {
  await t.run(async (ctx) => {
    await ctx.db.insert("companyMonitoringAccounts", {
      logicalAccountId: ACCOUNT_ID,
      ownerUserId: "user_admission",
      ownerFenceHash: "fence_admission",
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
      ownerAccountId: ACCOUNT_ID,
      companyId: COMPANY_ID,
      name: "Admission Company",
      sortName: "admission company",
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
  await t.mutation(EVIDENCE.ingestEvidenceForTest, {
    ownerAccountId: ACCOUNT_ID,
    companyIds: [COMPANY_ID],
    evidence: [{
      provider: "x",
      providerLocator: "19000000000000006011",
      url: "https://x.com/i/status/19000000000000006011",
      text: "Admission Company signed a material customer contract.",
      author: "admissionco",
      authorAccountId: "123456789",
      publishedAt: NOW - HOUR_MS,
      observedAt: NOW,
      expiresAt: NOW + 72 * HOUR_MS,
      candidateCompanyIds: [COMPANY_ID],
      verifiedCompanyIds: [COMPANY_ID],
      sourceAuthority: "verified_first_party",
      queryVersion: "x-company-discovery-v1",
    }],
  });
  return t.run(async (ctx) => ctx.db.query("companyMonitoringCandidates").unique());
}

function publishOutput(evidenceId: string) {
  const axis = (truth: string, confidence: number) => ({
    truth,
    confidence,
    rationale: "The first-party evidence directly supports this axis.",
    evidenceIds: [evidenceId],
  });
  return {
    attribution: axis("confirmed", 0.97),
    occurrence: axis("confirmed", 0.94),
    materiality: axis("material", 0.86),
    direction: "positive",
    channels: ["financial"],
    magnitude: "high",
    category: "commercial_contract",
    title: "Admission Company signs material customer contract",
    neutralSummary: "Admission Company announced a material customer contract.",
    positiveRationale: "The contract can increase revenue.",
    negativeRationale: "",
    conflict: false,
  };
}

function holdOutput(evidenceId: string) {
  const output = publishOutput(evidenceId);
  return {
    ...output,
    materiality: { ...output.materiality, confidence: 0.69 },
  };
}

async function claimAndFinalize(
  t: ReturnType<typeof convexTest>,
  options: {
    workerId: string;
    classificationRunId: string;
    output: (evidenceId: string) => unknown;
  },
) {
  const claim = await t.mutation(
    ADMISSION.claimNextAdmissionCandidateForTest,
    claimArgs(options.workerId, options.classificationRunId),
  );
  expect(claim.status).toBe("claimed");
  const args = {
    workerId: options.workerId,
    leaseToken: claim.leaseToken!,
    ownerAccountId: claim.candidate!.ownerAccountId,
    companyId: claim.candidate!.companyId,
    occurrenceDedupeKey: claim.candidate!.occurrenceDedupeKey,
    expectedEvidenceRevision: claim.expectedEvidenceRevision!,
    classificationRunId: options.classificationRunId,
    requestedModelVersion: REQUESTED_MODEL_VERSION,
    modelVersion: "openrouter/google/gemini-2.5-flash@2026-08-11",
    modelOutput: options.output(claim.candidate!.referenceEvidenceFingerprints[0]!),
  };
  return {
    claim,
    args,
    result: await t.mutation(ADMISSION.recordAdmissionDecisionForTest, args),
  };
}

async function claimAndRecordTransportFailure(
  t: ReturnType<typeof convexTest>,
  options: { workerId: string; classificationRunId: string },
) {
  const claim = await t.mutation(
    ADMISSION.claimNextAdmissionCandidateForTest,
    claimArgs(options.workerId, options.classificationRunId),
  );
  expect(claim.status).toBe("claimed");
  const args = {
    workerId: options.workerId,
    leaseToken: claim.leaseToken!,
    ownerAccountId: claim.candidate!.ownerAccountId,
    companyId: claim.candidate!.companyId,
    occurrenceDedupeKey: claim.candidate!.occurrenceDedupeKey,
    expectedEvidenceRevision: claim.expectedEvidenceRevision!,
    classificationRunId: options.classificationRunId,
    requestedModelVersion: REQUESTED_MODEL_VERSION,
  };
  return {
    claim,
    args,
    result: await t.mutation(ADMISSION.recordAdmissionTransportFailureForTest, args),
  };
}

describe("Company Monitoring admission decision persistence", () => {
  test("evaluates a direct candidate and appends its immutable provenance", async () => {
    const t = convexTest(schema, modules);
    const candidate = await seedCandidate(t);
    const claim = await t.mutation(
      ADMISSION.claimNextAdmissionCandidateForTest,
      claimArgs("worker-admission-1", "classification-run-direct-1"),
    );
    expect(claim.status).toBe("claimed");

    const result = await t.mutation(ADMISSION.recordAdmissionDecisionForTest, {
      workerId: "worker-admission-1",
      leaseToken: claim.leaseToken!,
      ownerAccountId: ACCOUNT_ID,
      companyId: COMPANY_ID,
      occurrenceDedupeKey: candidate!.occurrenceDedupeKey,
      expectedEvidenceRevision: candidate!.evidenceRevision,
      classificationRunId: "classification-run-direct-1",
      requestedModelVersion: REQUESTED_MODEL_VERSION,
      modelVersion: "openrouter/google/gemini-2.5-flash@2026-08-11",
      modelOutput: publishOutput(candidate!.referenceEvidenceFingerprints[0]!),
    });

    expect(result).toMatchObject({ status: "recorded", decision: "publish" });
    const state = await t.run(async (ctx) => ({
      candidate: await ctx.db.query("companyMonitoringCandidates").unique(),
      decisions: await ctx.db.query("companyMonitoringAdmissionDecisions").collect(),
    }));
    expect(state.candidate).toMatchObject({
      state: "terminal",
      terminalReason: "admitted",
      attemptCount: 1,
    });
    expect(state.decisions).toHaveLength(1);
    expect(state.decisions[0]).toMatchObject({
      decision: "publish",
      reasonCodes: ["policy_gates_satisfied"],
      modelVersion: "openrouter/google/gemini-2.5-flash@2026-08-11",
      queryVersions: ["x-company-discovery-v1"],
      admissionPolicyVersion: "cm-admission-policy-v1",
      sourcePolicyVersion: "cm-source-policy-v1",
      retryPolicyVersion: "cm-retry-policy-v1",
      evidenceSelectionPolicyVersion: "cm-evidence-selection-v1",
      referenceEvidenceFingerprints: candidate!.referenceEvidenceFingerprints,
      confidenceFloors: {
        attribution: 0.9,
        eventTruth: 0.8,
        materialImpact: 0.7,
        overall: "minimum_axis",
      },
    });
  });

  test("exposes a targetless service-secret claim and fenced finalize seam", async () => {
    const t = convexTest(schema, modules);
    await seedCandidate(t);
    const priorSecret = process.env.COMPANY_MONITORING_WORKER_SECRET;
    process.env.COMPANY_MONITORING_WORKER_SECRET = "test-admission-worker-secret";
    try {
      await expect(t.mutation(PUBLIC_ORCHESTRATION.claimNextAdmissionCandidate, {
        secret: "wrong-secret",
        workerId: "public-worker-1",
        classificationRunId: "public-classification-run-unauthorized",
        requestedModelVersion: REQUESTED_MODEL_VERSION,
      })).rejects.toThrow(/COMPANY_MONITORING_WORKER_UNAUTHORIZED/);
      const claim = await t.mutation(PUBLIC_ORCHESTRATION.claimNextAdmissionCandidate, {
        secret: "test-admission-worker-secret",
        workerId: "public-worker-1",
        classificationRunId: "public-classification-run-1",
        requestedModelVersion: REQUESTED_MODEL_VERSION,
      });
      expect(claim.status).toBe("claimed");
      expect(await t.mutation(PUBLIC_ORCHESTRATION.finalizeAdmissionCandidate, {
        secret: "test-admission-worker-secret",
        workerId: "public-worker-1",
        leaseToken: claim.leaseToken,
        ownerAccountId: claim.candidate.ownerAccountId,
        companyId: claim.candidate.companyId,
        occurrenceDedupeKey: claim.candidate.occurrenceDedupeKey,
        expectedEvidenceRevision: claim.expectedEvidenceRevision,
        classificationRunId: "public-classification-run-1",
        requestedModelVersion: REQUESTED_MODEL_VERSION,
        modelVersion: "provider/classifier-v1@2026-08-11",
        modelOutput: publishOutput(claim.candidate.referenceEvidenceFingerprints[0]),
      })).toEqual({ status: "recorded", decision: "publish" });
    } finally {
      if (priorSecret === undefined) delete process.env.COMPANY_MONITORING_WORKER_SECRET;
      else process.env.COMPANY_MONITORING_WORKER_SECRET = priorSecret;
    }
  });

  test("exposes a targetless service-secret transport-failure finalize seam", async () => {
    const t = convexTest(schema, modules);
    await seedCandidate(t);
    const priorSecret = process.env.COMPANY_MONITORING_WORKER_SECRET;
    process.env.COMPANY_MONITORING_WORKER_SECRET = "test-admission-worker-secret";
    try {
      const claim = await t.mutation(PUBLIC_ORCHESTRATION.claimNextAdmissionCandidate, {
        secret: "test-admission-worker-secret",
        workerId: "public-transport-worker-1",
        classificationRunId: "public-classification-transport-run-1",
        requestedModelVersion: REQUESTED_MODEL_VERSION,
      });
      expect(await t.mutation(PUBLIC_ORCHESTRATION.finalizeAdmissionTransportFailure, {
        secret: "test-admission-worker-secret",
        workerId: "public-transport-worker-1",
        leaseToken: claim.leaseToken,
        ownerAccountId: claim.candidate.ownerAccountId,
        companyId: claim.candidate.companyId,
        occurrenceDedupeKey: claim.candidate.occurrenceDedupeKey,
        expectedEvidenceRevision: claim.expectedEvidenceRevision,
        classificationRunId: "public-classification-transport-run-1",
        requestedModelVersion: REQUESTED_MODEL_VERSION,
      })).toEqual({ status: "recorded", decision: "hold" });
    } finally {
      if (priorSecret === undefined) delete process.env.COMPANY_MONITORING_WORKER_SECRET;
      else process.env.COMPANY_MONITORING_WORKER_SECRET = priorSecret;
    }
  });

  test("uses absolute 6h, 24h, 48h checkpoints and expires once by 72h", async () => {
    const t = convexTest(schema, modules);
    await seedCandidate(t);
    const expectedRetries = [6, 24, 48, 72].map((hours) => NOW + hours * HOUR_MS);

    for (const [index, retryAt] of expectedRetries.entries()) {
      const attempt = await claimAndFinalize(t, {
        workerId: `worker-hold-${index}`,
        classificationRunId: `classification-run-hold-${index}`,
        output: holdOutput,
      });
      expect(attempt.result).toEqual({ status: "recorded", decision: "hold" });
      expect((await t.run(async (ctx) =>
        ctx.db.query("companyMonitoringCandidates").unique()
      ))?.holdUntil).toBe(retryAt);
      if (retryAt < NOW + 72 * HOUR_MS) {
        vi.advanceTimersByTime(retryAt - Date.now());
        await t.finishInProgressScheduledFunctions();
      }
    }

    vi.advanceTimersByTime(NOW + 72 * HOUR_MS - Date.now());
    await t.finishInProgressScheduledFunctions();
    const state = await t.run(async (ctx) => ({
      candidate: await ctx.db.query("companyMonitoringCandidates").unique(),
      decisions: await ctx.db.query("companyMonitoringAdmissionDecisions").collect(),
    }));
    expect(state.candidate).toMatchObject({
      state: "terminal",
      terminalReason: "hold_expired",
      attemptCount: 4,
    });
    expect(state.decisions.map((row) => row.decision)).toEqual([
      "hold",
      "hold",
      "hold",
      "hold",
      "expire",
    ]);
    expect(state.decisions.at(-1)).toMatchObject({
      reasonCodes: ["candidate_expired", "materiality_confidence_below_floor"],
      requestedModelVersion: REQUESTED_MODEL_VERSION,
      modelVersion: "openrouter/google/gemini-2.5-flash@2026-08-11",
      queryVersions: ["x-company-discovery-v1"],
    });
  });

  test("durably holds fenced classifier transport failures through the fixed retry timeline", async () => {
    const t = convexTest(schema, modules);
    await seedCandidate(t);
    const expectedRetries = [6, 24, 48, 72].map((hours) => NOW + hours * HOUR_MS);

    for (const [index, retryAt] of expectedRetries.entries()) {
      const attempt = await claimAndRecordTransportFailure(t, {
        workerId: `worker-transport-${index}`,
        classificationRunId: `classification-run-transport-${index}`,
      });
      expect(attempt.result).toEqual({ status: "recorded", decision: "hold" });
      if (index === 0) {
        expect(await t.mutation(ADMISSION.recordAdmissionTransportFailureForTest, attempt.args))
          .toEqual({ status: "replayed", decision: "hold" });
        await expect(t.mutation(ADMISSION.recordAdmissionDecisionForTest, {
          ...attempt.args,
          modelVersion: "provider/classifier-v1",
          modelOutput: "{not-json",
        })).rejects.toThrow(/COMPANY_MONITORING_CLASSIFICATION_REPLAY_CONFLICT/);
        await expect(t.mutation(ADMISSION.recordAdmissionTransportFailureForTest, {
          ...attempt.args,
          classificationRunId: "classification-run-transport-fenced",
          leaseToken: "different-lease",
        })).rejects.toThrow(/COMPANY_MONITORING_CLASSIFICATION_FENCED/);
      }
      const state = await t.run(async (ctx) => ({
        candidate: await ctx.db.query("companyMonitoringCandidates").unique(),
        decisions: await ctx.db.query("companyMonitoringAdmissionDecisions").collect(),
      }));
      expect(state.candidate).toMatchObject({
        state: "held",
        holdUntil: retryAt,
      });
      expect(state.candidate).not.toHaveProperty("classificationWorkerId");
      expect(state.candidate).not.toHaveProperty("classificationLeaseToken");
      expect(state.candidate).not.toHaveProperty("classificationLeaseExpiresAt");
      expect(state.decisions[index]).toMatchObject({
        decision: "hold",
        reasonCodes: ["classifier_transport_failure"],
        retryAt,
        queryVersions: ["x-company-discovery-v1"],
        classificationSchemaVersion: "cm-classification-schema-v1",
        admissionPolicyVersion: "cm-admission-policy-v1",
        sourcePolicyVersion: "cm-source-policy-v1",
        retryPolicyVersion: "cm-retry-policy-v1",
        evidenceSelectionPolicyVersion: "cm-evidence-selection-v1",
        requestedModelVersion: REQUESTED_MODEL_VERSION,
        modelVersion: "not-resolved",
      });
      expect(state.decisions[index]?.classification).toBeUndefined();
      if (retryAt < NOW + 72 * HOUR_MS) {
        vi.advanceTimersByTime(retryAt - Date.now());
        await t.finishInProgressScheduledFunctions();
      }
    }

    vi.advanceTimersByTime(NOW + 72 * HOUR_MS - Date.now());
    await t.finishInProgressScheduledFunctions();
    const terminal = await t.run(async (ctx) => ({
      candidate: await ctx.db.query("companyMonitoringCandidates").unique(),
      decisions: await ctx.db.query("companyMonitoringAdmissionDecisions").collect(),
    }));
    expect(terminal.candidate).toMatchObject({
      state: "terminal",
      terminalReason: "hold_expired",
      attemptCount: 4,
    });
    expect(terminal.decisions.map((row) => row.decision)).toEqual([
      "hold",
      "hold",
      "hold",
      "hold",
      "expire",
    ]);
    expect(terminal.decisions.at(-1)).toMatchObject({
      reasonCodes: ["candidate_expired", "classifier_transport_failure"],
      requestedModelVersion: REQUESTED_MODEL_VERSION,
      modelVersion: "not-resolved",
      queryVersions: ["x-company-discovery-v1"],
    });
  });

  test("admits held evidence at the next absolute checkpoint", async () => {
    const t = convexTest(schema, modules);
    await seedCandidate(t);
    expect((await claimAndFinalize(t, {
      workerId: "worker-held-admitted-1",
      classificationRunId: "classification-run-held-admitted-1",
      output: holdOutput,
    })).result.decision).toBe("hold");

    vi.advanceTimersByTime(6 * HOUR_MS);
    await t.finishInProgressScheduledFunctions();
    expect((await claimAndFinalize(t, {
      workerId: "worker-held-admitted-2",
      classificationRunId: "classification-run-held-admitted-2",
      output: publishOutput,
    })).result.decision).toBe("publish");

    const state = await t.run(async (ctx) => ({
      candidate: await ctx.db.query("companyMonitoringCandidates").unique(),
      decisions: await ctx.db.query("companyMonitoringAdmissionDecisions").collect(),
    }));
    expect(state.candidate).toMatchObject({
      state: "terminal",
      terminalReason: "admitted",
      attemptCount: 2,
    });
    expect(state.decisions.map((row) => row.decision)).toEqual(["hold", "publish"]);
    expect(state.decisions[1]?.previousDecisionId).toBe(state.decisions[0]?._id);
  });

  test("persists malformed model output as a fail-closed reject", async () => {
    const t = convexTest(schema, modules);
    await seedCandidate(t);
    const attempt = await claimAndFinalize(t, {
      workerId: "worker-malformed",
      classificationRunId: "classification-run-malformed",
      output: () => "{not-json",
    });
    expect(attempt.result).toEqual({ status: "recorded", decision: "reject" });
    const decision = await t.run(async (ctx) =>
      ctx.db.query("companyMonitoringAdmissionDecisions").unique()
    );
    expect(decision).toMatchObject({
      decision: "reject",
      reasonCodes: ["classification_output_malformed_json"],
      queryVersions: ["x-company-discovery-v1"],
    });
    expect(decision?.classification).toBeUndefined();
  });

  test("persists missing model output as a fail-closed reject", async () => {
    const t = convexTest(schema, modules);
    await seedCandidate(t);
    const claim = await t.mutation(
      ADMISSION.claimNextAdmissionCandidateForTest,
      claimArgs("worker-missing-output", "classification-run-missing-output"),
    );
    expect(await t.mutation(ADMISSION.recordAdmissionDecisionForTest, {
      workerId: "worker-missing-output",
      leaseToken: claim.leaseToken!,
      ownerAccountId: claim.candidate!.ownerAccountId,
      companyId: claim.candidate!.companyId,
      occurrenceDedupeKey: claim.candidate!.occurrenceDedupeKey,
      expectedEvidenceRevision: claim.expectedEvidenceRevision!,
      classificationRunId: "classification-run-missing-output",
      requestedModelVersion: REQUESTED_MODEL_VERSION,
      modelVersion: "provider/classifier-v1",
    })).toEqual({ status: "recorded", decision: "reject" });
    expect(await t.run(async (ctx) =>
      ctx.db.query("companyMonitoringAdmissionDecisions").unique()
    )).toMatchObject({
      decision: "reject",
      reasonCodes: ["classification_output_not_object"],
    });
  });

  test("fails closed when persisted evidence has no query provenance", async () => {
    const t = convexTest(schema, modules);
    await seedCandidate(t);
    await t.run(async (ctx) => {
      const row = await ctx.db.query("companyMonitoringEvidence").unique();
      await ctx.db.patch(row!._id, { queryVersion: undefined });
    });
    expect(await t.mutation(ADMISSION.claimNextAdmissionCandidateForTest, claimArgs("worker-missing-query-version"))).toEqual({ status: "idle" });
    const state = await t.run(async (ctx) => ({
      candidate: await ctx.db.query("companyMonitoringCandidates").unique(),
      decision: await ctx.db.query("companyMonitoringAdmissionDecisions").unique(),
    }));
    expect(state.candidate).toMatchObject({ state: "terminal", terminalReason: "rejected" });
    expect(state.decision).toMatchObject({
      decision: "reject",
      reasonCodes: ["trusted_evidence_query_version_missing"],
      queryVersions: [],
      modelVersion: "not-invoked",
    });
  });

  test("canonicalizes replay payloads, rejects conflicts, and appends only once", async () => {
    const t = convexTest(schema, modules);
    await seedCandidate(t);
    const first = await claimAndFinalize(t, {
      workerId: "worker-replay",
      classificationRunId: "classification-run-replay",
      output: publishOutput,
    });
    const reordered = Object.fromEntries(Object.entries(first.args.modelOutput).reverse());
    expect(await t.mutation(ADMISSION.recordAdmissionDecisionForTest, {
      ...first.args,
      modelOutput: reordered,
    })).toEqual({ status: "replayed", decision: "publish" });
    await expect(t.mutation(ADMISSION.recordAdmissionDecisionForTest, {
      ...first.args,
      modelOutput: { ...reordered, title: "Conflicting retry title" },
    })).rejects.toThrow(/COMPANY_MONITORING_CLASSIFICATION_REPLAY_CONFLICT/);
    expect(await t.run(async (ctx) =>
      ctx.db.query("companyMonitoringAdmissionDecisions").collect()
    )).toHaveLength(1);
  });

  test("turns an expired unfinalized lease into the fixed admission hold", async () => {
    const t = convexTest(schema, modules);
    await seedCandidate(t);
    const staleClaim = await t.mutation(ADMISSION.claimNextAdmissionCandidateForTest, claimArgs("worker-expired-lease"));

    vi.advanceTimersByTime(5 * 60 * 1000);
    const freshClaim = await t.mutation(ADMISSION.claimNextAdmissionCandidateForTest, claimArgs("worker-fresh-lease"));
    expect(freshClaim).toEqual({ status: "idle" });
    const recovered = await t.run(async (ctx) => ({
      candidate: await ctx.db.query("companyMonitoringCandidates").unique(),
      decision: await ctx.db.query("companyMonitoringAdmissionDecisions").unique(),
    }));
    expect(recovered.candidate).toMatchObject({
      state: "held",
      holdUntil: NOW + 6 * HOUR_MS,
      attemptCount: 1,
    });
    expect(recovered.decision).toMatchObject({
      classificationRunId: "claim-worker-expired-lease",
      decision: "hold",
      reasonCodes: ["classifier_transport_failure"],
      requestedModelVersion: REQUESTED_MODEL_VERSION,
      modelVersion: "not-resolved",
    });

    await expect(t.mutation(ADMISSION.recordAdmissionDecisionForTest, {
      workerId: "worker-expired-lease",
      leaseToken: staleClaim.leaseToken!,
      ownerAccountId: staleClaim.candidate!.ownerAccountId,
      companyId: staleClaim.candidate!.companyId,
      occurrenceDedupeKey: staleClaim.candidate!.occurrenceDedupeKey,
      expectedEvidenceRevision: staleClaim.expectedEvidenceRevision!,
      classificationRunId: "classification-run-expired-lease",
      requestedModelVersion: REQUESTED_MODEL_VERSION,
      modelVersion: "provider/classifier-v1",
      modelOutput: publishOutput(staleClaim.candidate!.referenceEvidenceFingerprints[0]!),
    })).rejects.toThrow(/COMPANY_MONITORING_CLASSIFICATION_FENCED/);

    vi.advanceTimersByTime(6 * HOUR_MS - 5 * 60 * 1000);
    await t.finishInProgressScheduledFunctions();
    const retryClaim = await t.mutation(
      ADMISSION.claimNextAdmissionCandidateForTest,
      claimArgs("worker-after-hold"),
    );
    expect(retryClaim.status).toBe("claimed");
  });

  test("fences a classification when query provenance changes on the same evidence", async () => {
    const t = convexTest(schema, modules);
    const original = await seedCandidate(t);
    const claim = await t.mutation(ADMISSION.claimNextAdmissionCandidateForTest, claimArgs("worker-stale-revision"));
    await t.mutation(EVIDENCE.ingestEvidenceForTest, {
      ownerAccountId: ACCOUNT_ID,
      companyIds: [COMPANY_ID],
      evidence: [{
        provider: "x",
        providerLocator: "19000000000000006011",
        url: "https://x.com/i/status/19000000000000006011",
        text: "Admission Company signed a material customer contract.",
        author: "admissionco",
        authorAccountId: "123456789",
        publishedAt: NOW - HOUR_MS,
        observedAt: NOW,
        expiresAt: NOW + 72 * HOUR_MS,
        candidateCompanyIds: [COMPANY_ID],
        verifiedCompanyIds: [COMPANY_ID],
        sourceAuthority: "verified_first_party",
        queryVersion: "x-company-discovery-v2",
      }],
    });
    const current = await t.run(async (ctx) =>
      ctx.db.query("companyMonitoringCandidates").unique()
    );
    expect(current?.evidenceRevision).toBe(original!.evidenceRevision + 1);
    await expect(t.mutation(ADMISSION.recordAdmissionDecisionForTest, {
      workerId: "worker-stale-revision",
      leaseToken: claim.leaseToken!,
      ownerAccountId: ACCOUNT_ID,
      companyId: COMPANY_ID,
      occurrenceDedupeKey: original!.occurrenceDedupeKey,
      expectedEvidenceRevision: original!.evidenceRevision,
      classificationRunId: "classification-run-stale-revision",
      requestedModelVersion: REQUESTED_MODEL_VERSION,
      modelVersion: "openrouter/google/gemini-2.5-flash@2026-08-11",
      modelOutput: publishOutput(original!.referenceEvidenceFingerprints[0]!),
    })).rejects.toThrow(/COMPANY_MONITORING_CLASSIFICATION_FENCED/);
    expect(await t.run(async (ctx) =>
      ctx.db.query("companyMonitoringAdmissionDecisions").collect()
    )).toEqual([]);
  });

  test("fences an active lease when same-fingerprint model input changes", async () => {
    const t = convexTest(schema, modules);
    const original = await seedCandidate(t);
    const claim = await t.mutation(
      ADMISSION.claimNextAdmissionCandidateForTest,
      claimArgs("worker-model-input-fence"),
    );
    await t.mutation(EVIDENCE.ingestEvidenceForTest, {
      ownerAccountId: ACCOUNT_ID,
      companyIds: [COMPANY_ID],
      evidence: [{
        provider: "x",
        providerLocator: "19000000000000006011",
        url: "https://x.com/i/status/19000000000000006011",
        text: "Admission Company signed a material customer contract.",
        author: "admissionco",
        authorAccountId: "123456789",
        publishedAt: NOW - HOUR_MS,
        observedAt: NOW + 1_000,
        expiresAt: NOW + 72 * HOUR_MS,
        candidateCompanyIds: [COMPANY_ID],
        verifiedCompanyIds: [COMPANY_ID],
        sourceAuthority: "verified_first_party",
        queryVersion: "x-company-discovery-v1",
      }],
    });
    const current = await t.run(async (ctx) =>
      ctx.db.query("companyMonitoringCandidates").unique()
    );
    expect(current).toMatchObject({
      evidenceRevision: original!.evidenceRevision + 1,
      state: "pending_classification",
    });
    expect(current).not.toHaveProperty("classificationLeaseToken");
    await expect(t.mutation(ADMISSION.recordAdmissionDecisionForTest, {
      workerId: "worker-model-input-fence",
      leaseToken: claim.leaseToken!,
      ownerAccountId: ACCOUNT_ID,
      companyId: COMPANY_ID,
      occurrenceDedupeKey: original!.occurrenceDedupeKey,
      expectedEvidenceRevision: original!.evidenceRevision,
      classificationRunId: "claim-worker-model-input-fence",
      requestedModelVersion: REQUESTED_MODEL_VERSION,
      modelVersion: "provider/classifier-v1",
      modelOutput: publishOutput(original!.referenceEvidenceFingerprints[0]!),
    })).rejects.toThrow(/COMPANY_MONITORING_CLASSIFICATION_FENCED/);
  });

  test("does not copy old-revision model provenance into a system decision", async () => {
    const t = convexTest(schema, modules);
    await seedCandidate(t);
    const held = await claimAndFinalize(t, {
      workerId: "worker-held-revision-change",
      classificationRunId: "classification-held-revision-change",
      output: holdOutput,
    });
    await t.mutation(EVIDENCE.ingestEvidenceForTest, {
      ownerAccountId: ACCOUNT_ID,
      companyIds: [COMPANY_ID],
      evidence: [{
        provider: "x",
        providerLocator: "19000000000000006011",
        url: "https://x.com/i/status/19000000000000006011",
        text: "Admission Company signed a material customer contract.",
        author: "admissionco",
        authorAccountId: "123456789",
        publishedAt: NOW - HOUR_MS,
        observedAt: NOW + 1_000,
        expiresAt: NOW + 72 * HOUR_MS,
        candidateCompanyIds: [COMPANY_ID],
        verifiedCompanyIds: [COMPANY_ID],
        sourceAuthority: "verified_first_party",
        queryVersion: "x-company-discovery-v2",
      }],
    });
    await t.run(async (ctx) => {
      const company = await ctx.db.query("companyMonitoringCompanies").unique();
      await ctx.db.patch(company!._id, { lifecycle: "removed", removedAt: Date.now() });
    });
    expect(await t.mutation(
      ADMISSION.claimNextAdmissionCandidateForTest,
      claimArgs("worker-system-terminal"),
    )).toEqual({ status: "idle" });
    const decisions = await t.run(async (ctx) =>
      ctx.db.query("companyMonitoringAdmissionDecisions").collect()
    );
    expect(decisions).toHaveLength(2);
    expect(decisions[1]).toMatchObject({
      evidenceRevision: held.claim.expectedEvidenceRevision! + 1,
      decision: "reject",
      reasonCodes: ["candidate_owner_inactive"],
      queryVersions: ["x-company-discovery-v2"],
      modelVersion: "not-invoked",
      previousDecisionId: decisions[0]!._id,
    });
    expect(decisions[1]?.classification).toBeUndefined();
    expect(decisions[1]?.overallConfidence).toBeUndefined();
    expect(decisions[1]?.authority).toBeUndefined();
    expect(decisions[1]?.requestedModelVersion).toBeUndefined();
  });

  test("fences finalize metadata that does not match the claimed lease", async () => {
    const t = convexTest(schema, modules);
    await seedCandidate(t);
    const claim = await t.mutation(
      ADMISSION.claimNextAdmissionCandidateForTest,
      claimArgs("worker-bound-metadata", "bound-classification-run"),
    );
    const args = {
      workerId: "worker-bound-metadata",
      leaseToken: claim.leaseToken!,
      ownerAccountId: claim.candidate!.ownerAccountId,
      companyId: claim.candidate!.companyId,
      occurrenceDedupeKey: claim.candidate!.occurrenceDedupeKey,
      expectedEvidenceRevision: claim.expectedEvidenceRevision!,
      requestedModelVersion: REQUESTED_MODEL_VERSION,
      modelVersion: "provider/classifier-v1",
      modelOutput: publishOutput(claim.candidate!.referenceEvidenceFingerprints[0]!),
    };
    await expect(t.mutation(ADMISSION.recordAdmissionDecisionForTest, {
      ...args,
      classificationRunId: "swapped-classification-run",
    })).rejects.toThrow(/COMPANY_MONITORING_CLASSIFICATION_FENCED/);
    await expect(t.mutation(ADMISSION.recordAdmissionDecisionForTest, {
      ...args,
      classificationRunId: "bound-classification-run",
      requestedModelVersion: "different/requested-model",
    })).rejects.toThrow(/COMPANY_MONITORING_CLASSIFICATION_FENCED/);
  });

  test("fences an in-flight classification when the company becomes inactive", async () => {
    const t = convexTest(schema, modules);
    await seedCandidate(t);
    const claim = await t.mutation(ADMISSION.claimNextAdmissionCandidateForTest, claimArgs("worker-inactive-finalize"));
    await t.run(async (ctx) => {
      const company = await ctx.db.query("companyMonitoringCompanies").unique();
      await ctx.db.patch(company!._id, { lifecycle: "removed", removedAt: NOW });
    });

    await expect(t.mutation(ADMISSION.recordAdmissionDecisionForTest, {
      workerId: "worker-inactive-finalize",
      leaseToken: claim.leaseToken!,
      ownerAccountId: claim.candidate!.ownerAccountId,
      companyId: claim.candidate!.companyId,
      occurrenceDedupeKey: claim.candidate!.occurrenceDedupeKey,
      expectedEvidenceRevision: claim.expectedEvidenceRevision!,
      classificationRunId: "classification-run-inactive-finalize",
      requestedModelVersion: REQUESTED_MODEL_VERSION,
      modelVersion: "provider/classifier-v1",
      modelOutput: publishOutput(claim.candidate!.referenceEvidenceFingerprints[0]!),
    })).rejects.toThrow(/COMPANY_MONITORING_CLASSIFICATION_FENCED/);
    expect(await t.run(async (ctx) =>
      ctx.db.query("companyMonitoringAdmissionDecisions").collect()
    )).toEqual([]);
  });

  test("purges decisions and delayed retry work cannot resurrect a removed company", async () => {
    const t = convexTest(schema, modules);
    await seedCandidate(t);
    await claimAndFinalize(t, {
      workerId: "worker-purge",
      classificationRunId: "classification-run-purge-hold",
      output: holdOutput,
    });
    await t.run(async (ctx) => {
      const company = await ctx.db.query("companyMonitoringCompanies").unique();
      await ctx.db.patch(company!._id, {
        lifecycle: "removed",
        purgeGeneration: 1,
        purgePhase: "scan",
        removedAt: NOW,
      });
    });
    const purgeArgs = {
      ownerAccountId: ACCOUNT_ID,
      companyId: COMPANY_ID,
      purgeGeneration: 1,
    };
    for (let index = 0; index < 10; index += 1) {
      const result = await t.mutation(COMPANIES.advanceCompanyPurge, purgeArgs);
      if (result.status === "complete") break;
    }
    expect(await t.run(async (ctx) => ({
      evidence: await ctx.db.query("companyMonitoringEvidence").collect(),
      candidates: await ctx.db.query("companyMonitoringCandidates").collect(),
      decisions: await ctx.db.query("companyMonitoringAdmissionDecisions").collect(),
    }))).toEqual({ evidence: [], candidates: [], decisions: [] });

    vi.advanceTimersByTime(6 * HOUR_MS);
    await t.finishInProgressScheduledFunctions();
    expect(await t.run(async (ctx) => ({
      candidates: await ctx.db.query("companyMonitoringCandidates").collect(),
      decisions: await ctx.db.query("companyMonitoringAdmissionDecisions").collect(),
    }))).toEqual({ candidates: [], decisions: [] });
  });

  test("resumes company purge across a bounded page of more than 25 decisions", async () => {
    const t = convexTest(schema, modules);
    await seedCandidate(t);
    await claimAndFinalize(t, {
      workerId: "worker-bounded-purge",
      classificationRunId: "classification-run-bounded-purge",
      output: holdOutput,
    });
    await t.run(async (ctx) => {
      const decision = await ctx.db.query("companyMonitoringAdmissionDecisions").unique();
      const { _id, _creationTime, ...copy } = decision!;
      void _id;
      void _creationTime;
      for (let index = 1; index < 26; index += 1) {
        await ctx.db.insert("companyMonitoringAdmissionDecisions", {
          ...copy,
          classificationRunId: `bulk-purge-run-${index}`,
          submissionDigest: `bulk-purge-digest-${index}`,
          decidedAt: NOW + index,
        });
      }
      const company = await ctx.db.query("companyMonitoringCompanies").unique();
      await ctx.db.patch(company!._id, {
        lifecycle: "removed",
        purgeGeneration: 1,
        purgePhase: "scan",
        removedAt: NOW,
      });
    });
    const args = {
      ownerAccountId: ACCOUNT_ID,
      companyId: COMPANY_ID,
      purgeGeneration: 1,
    };
    expect(await t.mutation(COMPANIES.advanceCompanyPurge, args)).toEqual({
      status: "candidates",
    });
    expect(await t.mutation(COMPANIES.advanceCompanyPurge, args)).toEqual({
      status: "candidates",
    });
    expect(await t.run(async (ctx) => ({
      decisions: await ctx.db.query("companyMonitoringAdmissionDecisions").collect(),
      candidates: await ctx.db.query("companyMonitoringCandidates").collect(),
    }))).toMatchObject({ decisions: [{}], candidates: [{}] });
    expect(await t.mutation(COMPANIES.advanceCompanyPurge, args)).toEqual({
      status: "candidates",
    });
    expect(await t.mutation(COMPANIES.advanceCompanyPurge, args)).toEqual({
      status: "complete",
    });
    expect(await t.run(async (ctx) => ({
      decisions: await ctx.db.query("companyMonitoringAdmissionDecisions").collect(),
      candidates: await ctx.db.query("companyMonitoringCandidates").collect(),
    }))).toEqual({ decisions: [], candidates: [] });
  });
});
