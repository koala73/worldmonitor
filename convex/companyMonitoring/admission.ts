import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import { internalMutation, type MutationCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import type { NormalizedCompanyEvidence } from "../../shared/company-monitoring-evidence";
import {
  COMPANY_MONITORING_ADMISSION_POLICY_VERSION,
  COMPANY_MONITORING_CLASSIFICATION_SCHEMA_VERSION,
  COMPANY_MONITORING_DEFAULT_CONFIDENCE_FLOORS,
  COMPANY_MONITORING_RETRY_POLICY,
  COMPANY_MONITORING_SOURCE_POLICY_VERSION,
  evaluateCompanyMonitoringClassifierTransportFailure,
  evaluateCompanyMonitoringClassification,
} from "../../scripts/lib/company-monitoring-classification.mjs";
import { fingerprint, randomFence } from "./_shared";
import { assertValidCandidateState } from "./validators";
import {
  companyMonitoringCandidateEvidenceSnapshotDigest as candidateEvidenceSnapshotDigest,
  companyMonitoringEvidenceShape as evidenceShape,
} from "./admissionSnapshot";

const ADMISSION_LEASE_MS = 5 * 60 * 1000;
const ADMISSION_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const ADMISSION_MODEL_VERSION = /^[^\u0000-\u001f\u007f]{1,200}$/u;

function admissionIdentifier(value: string, field: string) {
  if (!ADMISSION_ID.test(value)) {
    throw new ConvexError(`COMPANY_MONITORING_${field}_INVALID`);
  }
  return value;
}

function admissionModelVersion(value: string) {
  if (
    value !== value.trim() ||
    !ADMISSION_MODEL_VERSION.test(value)
  ) {
    throw new ConvexError("COMPANY_MONITORING_MODEL_VERSION_INVALID");
  }
  return value;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(row).sort().map((key) => [key, canonicalValue(row[key])]),
    );
  }
  return value;
}

function admissionTerminalReason(decision: string) {
  if (decision === "publish") return "admitted" as const;
  if (decision === "reject") return "rejected" as const;
  return "hold_expired" as const;
}

async function referencedEvidence(
  ctx: MutationCtx,
  candidate: Doc<"companyMonitoringCandidates">,
  now: number,
  allowExpired = false,
) {
  if (
    candidate.referenceEvidenceFingerprints.length === 0 ||
    new Set(candidate.referenceEvidenceFingerprints).size !==
      candidate.referenceEvidenceFingerprints.length ||
    candidate.referenceCount < candidate.referenceEvidenceFingerprints.length
  ) {
    throw new ConvexError("COMPANY_MONITORING_ADMISSION_EVIDENCE_INVALID");
  }
  const rows = await Promise.all(candidate.referenceEvidenceFingerprints.map((evidenceFingerprint) =>
    ctx.db
      .query("companyMonitoringEvidence")
      .withIndex("by_account_company_fingerprint", (q) =>
        q
          .eq("ownerAccountId", candidate.ownerAccountId)
          .eq("companyId", candidate.companyId)
          .eq("evidenceFingerprint", evidenceFingerprint),
      )
      .unique()
  ));
  if (rows.some((row) => !row)) {
    throw new ConvexError("COMPANY_MONITORING_ADMISSION_EVIDENCE_MISSING");
  }
  const evidence = rows.map((row) => row!);
  for (const row of evidence) {
    if (
      row.occurrenceDedupeKey !== candidate.occurrenceDedupeKey ||
      (!allowExpired && (
        row.state !== "active" ||
        (row.expiresAt !== undefined && row.expiresAt <= now)
      )) ||
      (row.sourceAuthority === "verified_first_party" &&
        (
          row.independence !== "first_party" ||
          (row.provider === "exa" && row.matchedClaimIds.length === 0)
        ))
    ) {
      throw new ConvexError("COMPANY_MONITORING_ADMISSION_EVIDENCE_INVALID");
    }
    if (!row.queryVersion || !ADMISSION_ID.test(row.queryVersion)) {
      throw new ConvexError("COMPANY_MONITORING_ADMISSION_QUERY_VERSION_INVALID");
    }
  }
  const shaped = evidence.map(evidenceShape);
  const evidenceSnapshotDigest = await candidateEvidenceSnapshotDigest({
    selectionPolicyVersion: candidate.selectionPolicyVersion,
    referenceCount: candidate.referenceCount,
    referencesTruncated: candidate.referencesTruncated,
    evidence: shaped,
  });
  if (candidate.evidenceSnapshotDigest !== evidenceSnapshotDigest) {
    throw new ConvexError("COMPANY_MONITORING_ADMISSION_EVIDENCE_STALE");
  }
  return shaped;
}

function decisionVersions(candidate: Doc<"companyMonitoringCandidates">, modelVersion: string) {
  return {
    classificationSchemaVersion: COMPANY_MONITORING_CLASSIFICATION_SCHEMA_VERSION,
    admissionPolicyVersion: COMPANY_MONITORING_ADMISSION_POLICY_VERSION,
    sourcePolicyVersion: COMPANY_MONITORING_SOURCE_POLICY_VERSION,
    retryPolicyVersion: COMPANY_MONITORING_RETRY_POLICY.version,
    evidenceSelectionPolicyVersion: candidate.selectionPolicyVersion,
    modelVersion,
  };
}

async function appendSystemDecision(
  ctx: MutationCtx,
  candidate: Doc<"companyMonitoringCandidates">,
  decision: "reject" | "expire",
  reasonCode: string,
  now: number,
) {
  const classificationRunId = `system-${decision}-${candidate.candidateId}-${candidate.evidenceRevision}`
    .slice(0, 128);
  const existing = await ctx.db
    .query("companyMonitoringAdmissionDecisions")
    .withIndex("by_replay_fence", (q) =>
      q
        .eq("ownerAccountId", candidate.ownerAccountId)
        .eq("companyId", candidate.companyId)
        .eq("occurrenceDedupeKey", candidate.occurrenceDedupeKey)
        .eq("evidenceRevision", candidate.evidenceRevision)
        .eq("classificationRunId", classificationRunId),
    )
    .unique();
  if (existing) return existing._id;
  const previous = candidate.lastAdmissionDecisionId
    ? await ctx.db.get(candidate.lastAdmissionDecisionId)
    : null;
  const sameRevisionPrevious = previous?.evidenceRevision === candidate.evidenceRevision
    ? previous
    : null;
  let evidence: NormalizedCompanyEvidence[] = [];
  try {
    evidence = await referencedEvidence(ctx, candidate, now, true);
  } catch {
    // A system terminal decision must still be durable when evidence was
    // removed. Empty provenance is explicit and cannot admit the candidate.
  }
  const queryVersions = [...new Set(
    evidence.flatMap((row) => row.queryVersion ? [row.queryVersion] : []),
  )].sort();
  return ctx.db.insert("companyMonitoringAdmissionDecisions", {
    ownerAccountId: candidate.ownerAccountId,
    companyId: candidate.companyId,
    candidateId: candidate.candidateId,
    occurrenceDedupeKey: candidate.occurrenceDedupeKey,
    evidenceRevision: candidate.evidenceRevision,
    classificationRunId,
    submissionDigest: await fingerprint({ decision, reasonCode, classificationRunId }),
    decision,
    reasonCodes: [...new Set([
      ...(decision === "expire" && sameRevisionPrevious?.decision === "hold"
        ? sameRevisionPrevious.reasonCodes
        : []),
      reasonCode,
    ])].sort(),
    referenceEvidenceFingerprints: [...candidate.referenceEvidenceFingerprints],
    confidenceFloors: sameRevisionPrevious?.confidenceFloors ??
      COMPANY_MONITORING_DEFAULT_CONFIDENCE_FLOORS,
    ...(sameRevisionPrevious?.classification
      ? { classification: sameRevisionPrevious.classification }
      : {}),
    ...(sameRevisionPrevious?.overallConfidence !== undefined
      ? { overallConfidence: sameRevisionPrevious.overallConfidence }
      : {}),
    ...(sameRevisionPrevious?.authority ? { authority: sameRevisionPrevious.authority } : {}),
    queryVersions,
    ...(sameRevisionPrevious
      ? {
          classificationSchemaVersion: sameRevisionPrevious.classificationSchemaVersion,
          admissionPolicyVersion: sameRevisionPrevious.admissionPolicyVersion,
          sourcePolicyVersion: sameRevisionPrevious.sourcePolicyVersion,
          retryPolicyVersion: sameRevisionPrevious.retryPolicyVersion,
          evidenceSelectionPolicyVersion: sameRevisionPrevious.evidenceSelectionPolicyVersion,
          modelVersion: sameRevisionPrevious.modelVersion,
          ...(sameRevisionPrevious.requestedModelVersion
            ? { requestedModelVersion: sameRevisionPrevious.requestedModelVersion }
            : {}),
        }
      : decisionVersions(candidate, "not-invoked")),
    evidenceSnapshotDigest: candidate.evidenceSnapshotDigest,
    ...(previous ? { previousDecisionId: previous._id } : {}),
    terminalAt: candidate.expiresAt,
    decidedAt: now,
  });
}

async function admissionScopeIsActive(
  ctx: MutationCtx,
  candidate: Doc<"companyMonitoringCandidates">,
) {
  const [account, company] = await Promise.all([
    ctx.db
      .query("companyMonitoringAccounts")
      .withIndex("by_logicalAccountId", (q) =>
        q.eq("logicalAccountId", candidate.ownerAccountId),
      )
      .unique(),
    ctx.db
      .query("companyMonitoringCompanies")
      .withIndex("by_account_companyId", (q) =>
        q
          .eq("ownerAccountId", candidate.ownerAccountId)
          .eq("companyId", candidate.companyId),
      )
      .unique(),
  ]);
  return Boolean(
    account &&
    account.lifecycle === "entitled" &&
    !account.terminalReason &&
    company &&
    company.lifecycle === "active",
  );
}

export async function terminalizeSystemDecision(
  ctx: MutationCtx,
  candidate: Doc<"companyMonitoringCandidates">,
  decision: "reject" | "expire",
  reasonCode: string,
  terminalReason: "rejected" | "hold_expired" | "evidence_deleted" |
    "evidence_expired" | "authority_lost" | "evidence_unavailable",
  now: number,
) {
  assertValidCandidateState(candidate);
  if (candidate.state === "terminal") return candidate.lastAdmissionDecisionId;
  const decisionId = await appendSystemDecision(ctx, candidate, decision, reasonCode, now);
  assertValidCandidateState({ state: "terminal", holdUntil: undefined, terminalReason });
  await ctx.db.patch(candidate._id, {
    state: "terminal",
    terminalReason,
    holdUntil: undefined,
    observationBlocking: false,
    classificationWorkerId: undefined,
    classificationLeaseToken: undefined,
    classificationLeaseExpiresAt: undefined,
    classificationRunId: undefined,
    classificationRequestedModelVersion: undefined,
    lastAdmissionDecisionId: decisionId,
    updatedAt: now,
  });
  return decisionId;
}

export async function claimNextAdmissionCandidateHandler(
  ctx: MutationCtx,
  args: {
    workerId: string;
    classificationRunId: string;
    requestedModelVersion: string;
  },
) {
  const workerId = admissionIdentifier(args.workerId, "ADMISSION_WORKER_ID");
  const classificationRunId = admissionIdentifier(
    args.classificationRunId,
    "CLASSIFICATION_RUN_ID",
  );
  const requestedModelVersion = admissionModelVersion(args.requestedModelVersion);
  const now = Date.now();
  const candidates = await ctx.db
    .query("companyMonitoringCandidates")
    .withIndex("by_state_updatedAt", (q) => q.eq("state", "pending_classification"))
    .take(32);
  for (const candidate of candidates) {
    assertValidCandidateState(candidate);
    if (!await admissionScopeIsActive(ctx, candidate)) {
      await terminalizeSystemDecision(
        ctx,
        candidate,
        "reject",
        "candidate_owner_inactive",
        "rejected",
        now,
      );
      continue;
    }
    if (candidate.expiresAt <= now) {
      await terminalizeSystemDecision(
        ctx,
        candidate,
        "expire",
        "candidate_expired",
        "hold_expired",
        now,
      );
      continue;
    }
    if (candidate.classificationLeaseExpiresAt !== undefined) {
      if (candidate.classificationLeaseExpiresAt > now) continue;
      let abandonedEvidence;
      try {
        abandonedEvidence = await referencedEvidence(ctx, candidate, now);
      } catch (error) {
        const reason = error instanceof ConvexError &&
            String(error.data).includes("QUERY_VERSION")
          ? "trusted_evidence_query_version_missing"
          : "trusted_evidence_invalid";
        await terminalizeSystemDecision(ctx, candidate, "reject", reason, "rejected", now);
        continue;
      }
      const abandonedRunId = candidate.classificationRunId ??
        `abandoned-${candidate.candidateId}-${candidate.evidenceRevision}`.slice(0, 128);
      const abandonedRequestedModel = candidate.classificationRequestedModelVersion ??
        "not-recorded";
      const result = evaluateCompanyMonitoringClassifierTransportFailure({
        candidate,
        evidence: abandonedEvidence,
        now,
        modelVersion: "not-resolved",
      });
      await persistAdmissionResult(
        ctx,
        candidate,
        result,
        abandonedEvidence,
        abandonedRunId,
        await fingerprint(canonicalValue({
          failure: "classifier_lease_abandoned",
          requestedModelVersion: abandonedRequestedModel,
        })),
        now,
        abandonedRequestedModel,
      );
      continue;
    }
    let evidence;
    try {
      evidence = await referencedEvidence(ctx, candidate, now);
    } catch (error) {
      const reason = error instanceof ConvexError &&
          String(error.data).includes("QUERY_VERSION")
        ? "trusted_evidence_query_version_missing"
        : "trusted_evidence_invalid";
      await terminalizeSystemDecision(ctx, candidate, "reject", reason, "rejected", now);
      continue;
    }
    const leaseToken = randomFence();
    const leaseExpiresAt = Math.min(candidate.expiresAt, now + ADMISSION_LEASE_MS);
    await ctx.db.patch(candidate._id, {
      classificationWorkerId: workerId,
      classificationLeaseToken: leaseToken,
      classificationLeaseExpiresAt: leaseExpiresAt,
      classificationRunId,
      classificationRequestedModelVersion: requestedModelVersion,
      updatedAt: now,
    });
    return {
      status: "claimed" as const,
      leaseToken,
      leaseExpiresAt,
      expectedEvidenceRevision: candidate.evidenceRevision,
      candidate: {
        ownerAccountId: candidate.ownerAccountId,
        companyId: candidate.companyId,
        candidateId: candidate.candidateId,
        occurrenceDedupeKey: candidate.occurrenceDedupeKey,
        firstDiscoveredAt: candidate.firstDiscoveredAt,
        attemptCount: candidate.attemptCount,
        expiresAt: candidate.expiresAt,
        referenceEvidenceFingerprints: candidate.referenceEvidenceFingerprints,
        referencesTruncated: candidate.referencesTruncated,
        selectionPolicyVersion: candidate.selectionPolicyVersion,
      },
      evidence,
    };
  }
  return { status: "idle" as const };
}

export async function recordAdmissionDecisionHandler(
  ctx: MutationCtx,
  args: {
    workerId: string;
    leaseToken: string;
    ownerAccountId: string;
    companyId: string;
    occurrenceDedupeKey: string;
    expectedEvidenceRevision: number;
    classificationRunId: string;
    requestedModelVersion: string;
    modelVersion: string;
    modelOutput?: unknown;
  },
) {
  const workerId = admissionIdentifier(args.workerId, "ADMISSION_WORKER_ID");
  const leaseToken = admissionIdentifier(args.leaseToken, "ADMISSION_LEASE");
  const classificationRunId = admissionIdentifier(
    args.classificationRunId,
    "CLASSIFICATION_RUN_ID",
  );
  const modelVersion = admissionModelVersion(args.modelVersion);
  const requestedModelVersion = admissionModelVersion(args.requestedModelVersion);
  if (!Number.isSafeInteger(args.expectedEvidenceRevision) || args.expectedEvidenceRevision < 1) {
    throw new ConvexError("COMPANY_MONITORING_EVIDENCE_REVISION_INVALID");
  }
  const replay = await ctx.db
    .query("companyMonitoringAdmissionDecisions")
    .withIndex("by_replay_fence", (q) =>
      q
        .eq("ownerAccountId", args.ownerAccountId)
        .eq("companyId", args.companyId)
        .eq("occurrenceDedupeKey", args.occurrenceDedupeKey)
        .eq("evidenceRevision", args.expectedEvidenceRevision)
        .eq("classificationRunId", classificationRunId),
    )
    .unique();
  if (replay) {
    const submissionDigest = await fingerprint(canonicalValue({
      requestedModelVersion,
      modelVersion,
      modelOutput: args.modelOutput,
    }));
    if (replay.submissionDigest !== submissionDigest) {
      throw new ConvexError("COMPANY_MONITORING_CLASSIFICATION_REPLAY_CONFLICT");
    }
    return { status: "replayed" as const, decision: replay.decision };
  }
  const candidate = await ctx.db
    .query("companyMonitoringCandidates")
    .withIndex("by_account_company_occurrence", (q) =>
      q
        .eq("ownerAccountId", args.ownerAccountId)
        .eq("companyId", args.companyId)
        .eq("occurrenceDedupeKey", args.occurrenceDedupeKey),
    )
    .unique();
  const now = Date.now();
  if (
    !candidate ||
    candidate.state !== "pending_classification" ||
    candidate.evidenceRevision !== args.expectedEvidenceRevision ||
    candidate.classificationWorkerId !== workerId ||
    candidate.classificationLeaseToken !== leaseToken ||
    candidate.classificationRunId !== classificationRunId ||
    candidate.classificationRequestedModelVersion !== requestedModelVersion ||
    candidate.classificationLeaseExpiresAt === undefined ||
    candidate.classificationLeaseExpiresAt <= now
  ) {
    throw new ConvexError("COMPANY_MONITORING_CLASSIFICATION_FENCED");
  }
  if (!await admissionScopeIsActive(ctx, candidate)) {
    throw new ConvexError("COMPANY_MONITORING_CLASSIFICATION_FENCED");
  }
  if (candidate.expiresAt <= now) {
    await terminalizeSystemDecision(
      ctx,
      candidate,
      "expire",
      "candidate_expired",
      "hold_expired",
      now,
    );
    return { status: "recorded" as const, decision: "expire" as const };
  }
  const submissionDigest = await fingerprint(canonicalValue({
    requestedModelVersion,
    modelVersion,
    modelOutput: args.modelOutput,
  }));
  const evidence = await referencedEvidence(ctx, candidate, now);
  const result = evaluateCompanyMonitoringClassification({
    candidate,
    evidence,
    modelOutput: args.modelOutput,
    now,
    modelVersion,
  });
  return persistAdmissionResult(
    ctx,
    candidate,
    result,
    evidence,
    classificationRunId,
    submissionDigest,
    now,
    requestedModelVersion,
  );
}

async function persistAdmissionResult(
  ctx: MutationCtx,
  candidate: Doc<"companyMonitoringCandidates">,
  result: ReturnType<typeof evaluateCompanyMonitoringClassification> |
    ReturnType<typeof evaluateCompanyMonitoringClassifierTransportFailure>,
  evidence: NormalizedCompanyEvidence[],
  classificationRunId: string,
  submissionDigest: string,
  now: number,
  requestedModelVersion?: string,
) {
  assertValidCandidateState(candidate);
  const derivedQueryVersions = [...new Set(evidence.map((row) => row.queryVersion!))].sort();
  if (
    result.queryVersions.length !== derivedQueryVersions.length ||
    result.queryVersions.some((version: string, index: number) =>
      version !== derivedQueryVersions[index]
    )
  ) {
    throw new ConvexError("COMPANY_MONITORING_ADMISSION_QUERY_VERSIONS_INVALID");
  }
  const decisionId = await ctx.db.insert("companyMonitoringAdmissionDecisions", {
    ownerAccountId: candidate.ownerAccountId,
    companyId: candidate.companyId,
    candidateId: candidate.candidateId,
    occurrenceDedupeKey: candidate.occurrenceDedupeKey,
    evidenceRevision: candidate.evidenceRevision,
    classificationRunId,
    submissionDigest,
    decision: result.decision,
    reasonCodes: result.reasonCodes,
    referenceEvidenceFingerprints: [...candidate.referenceEvidenceFingerprints],
    confidenceFloors: result.confidenceFloors,
    ...(result.classification ? { classification: result.classification } : {}),
    ...(result.overallConfidence !== null
      ? { overallConfidence: result.overallConfidence }
      : {}),
    ...(result.authority ? { authority: result.authority } : {}),
    queryVersions: derivedQueryVersions,
    classificationSchemaVersion: result.versions.classificationSchema,
    admissionPolicyVersion: result.versions.admissionPolicy,
    sourcePolicyVersion: result.versions.sourcePolicy,
    retryPolicyVersion: result.versions.retryPolicy,
    evidenceSelectionPolicyVersion: result.versions.evidenceSelection,
    modelVersion: result.versions.model,
    ...(requestedModelVersion ? { requestedModelVersion } : {}),
    evidenceSnapshotDigest: candidate.evidenceSnapshotDigest,
    ...(result.retryAt !== null ? { retryAt: result.retryAt } : {}),
    terminalAt: result.terminalAt,
    decidedAt: result.decidedAt,
    ...(candidate.lastAdmissionDecisionId
      ? { previousDecisionId: candidate.lastAdmissionDecisionId }
      : {}),
  });
  const attemptCount = candidate.attemptCount + 1;
  if (result.decision === "hold") {
    if (
      !Number.isSafeInteger(result.retryAt) ||
      result.retryAt <= now ||
      result.retryAt > candidate.expiresAt
    ) {
      throw new ConvexError("COMPANY_MONITORING_CANDIDATE_HOLD_INVALID");
    }
    assertValidCandidateState({
      state: "held",
      holdUntil: result.retryAt,
      terminalReason: undefined,
    });
    await ctx.db.patch(candidate._id, {
      state: "held",
      holdUntil: result.retryAt,
      terminalReason: undefined,
      attemptCount,
      lastAdmissionDecisionId: decisionId,
      classificationWorkerId: undefined,
      classificationLeaseToken: undefined,
      classificationLeaseExpiresAt: undefined,
      classificationRunId: undefined,
      classificationRequestedModelVersion: undefined,
      updatedAt: now,
    });
    await ctx.scheduler.runAt(
      result.retryAt,
      (internal as any).companyMonitoring.admission.releaseHeldAdmissionCandidate,
      {
        ownerAccountId: candidate.ownerAccountId,
        companyId: candidate.companyId,
        occurrenceDedupeKey: candidate.occurrenceDedupeKey,
        expectedEvidenceRevision: candidate.evidenceRevision,
        expectedDecisionId: decisionId,
        expectedHoldUntil: result.retryAt,
      },
    );
  } else {
    assertValidCandidateState({
      state: "terminal",
      holdUntil: undefined,
      terminalReason: admissionTerminalReason(result.decision),
    });
    await ctx.db.patch(candidate._id, {
      state: "terminal",
      holdUntil: undefined,
      terminalReason: admissionTerminalReason(result.decision),
      observationBlocking: false,
      attemptCount,
      lastAdmissionDecisionId: decisionId,
      classificationWorkerId: undefined,
      classificationLeaseToken: undefined,
      classificationLeaseExpiresAt: undefined,
      classificationRunId: undefined,
      classificationRequestedModelVersion: undefined,
      updatedAt: now,
    });
  }
  return { status: "recorded" as const, decision: result.decision };
}

export async function recordAdmissionTransportFailureHandler(
  ctx: MutationCtx,
  args: {
    workerId: string;
    leaseToken: string;
    ownerAccountId: string;
    companyId: string;
    occurrenceDedupeKey: string;
    expectedEvidenceRevision: number;
    classificationRunId: string;
    requestedModelVersion: string;
  },
) {
  const workerId = admissionIdentifier(args.workerId, "ADMISSION_WORKER_ID");
  const leaseToken = admissionIdentifier(args.leaseToken, "ADMISSION_LEASE");
  const classificationRunId = admissionIdentifier(
    args.classificationRunId,
    "CLASSIFICATION_RUN_ID",
  );
  const requestedModelVersion = admissionModelVersion(args.requestedModelVersion);
  if (!Number.isSafeInteger(args.expectedEvidenceRevision) || args.expectedEvidenceRevision < 1) {
    throw new ConvexError("COMPANY_MONITORING_EVIDENCE_REVISION_INVALID");
  }
  const submissionDigest = await fingerprint(canonicalValue({
    failure: "classifier_transport_failure",
    requestedModelVersion,
  }));
  const replay = await ctx.db
    .query("companyMonitoringAdmissionDecisions")
    .withIndex("by_replay_fence", (q) =>
      q
        .eq("ownerAccountId", args.ownerAccountId)
        .eq("companyId", args.companyId)
        .eq("occurrenceDedupeKey", args.occurrenceDedupeKey)
        .eq("evidenceRevision", args.expectedEvidenceRevision)
        .eq("classificationRunId", classificationRunId),
    )
    .unique();
  if (replay) {
    if (replay.submissionDigest !== submissionDigest) {
      throw new ConvexError("COMPANY_MONITORING_CLASSIFICATION_REPLAY_CONFLICT");
    }
    return { status: "replayed" as const, decision: replay.decision };
  }
  const candidate = await ctx.db
    .query("companyMonitoringCandidates")
    .withIndex("by_account_company_occurrence", (q) =>
      q
        .eq("ownerAccountId", args.ownerAccountId)
        .eq("companyId", args.companyId)
        .eq("occurrenceDedupeKey", args.occurrenceDedupeKey),
    )
    .unique();
  const now = Date.now();
  if (
    !candidate ||
    candidate.state !== "pending_classification" ||
    candidate.evidenceRevision !== args.expectedEvidenceRevision ||
    candidate.classificationWorkerId !== workerId ||
    candidate.classificationLeaseToken !== leaseToken ||
    candidate.classificationRunId !== classificationRunId ||
    candidate.classificationRequestedModelVersion !== requestedModelVersion ||
    candidate.classificationLeaseExpiresAt === undefined ||
    candidate.classificationLeaseExpiresAt <= now ||
    !await admissionScopeIsActive(ctx, candidate)
  ) {
    throw new ConvexError("COMPANY_MONITORING_CLASSIFICATION_FENCED");
  }
  const evidence = await referencedEvidence(ctx, candidate, now);
  const result = evaluateCompanyMonitoringClassifierTransportFailure({
    candidate,
    evidence,
    now,
    modelVersion: "not-resolved",
  });
  return persistAdmissionResult(
    ctx,
    candidate,
    result,
    evidence,
    classificationRunId,
    submissionDigest,
    now,
    requestedModelVersion,
  );
}

export const releaseHeldAdmissionCandidate = internalMutation({
  args: {
    ownerAccountId: v.string(),
    companyId: v.string(),
    occurrenceDedupeKey: v.string(),
    expectedEvidenceRevision: v.number(),
    expectedDecisionId: v.id("companyMonitoringAdmissionDecisions"),
    expectedHoldUntil: v.number(),
  },
  handler: async (ctx, args) => {
    const candidate = await ctx.db
      .query("companyMonitoringCandidates")
      .withIndex("by_account_company_occurrence", (q) =>
        q
          .eq("ownerAccountId", args.ownerAccountId)
          .eq("companyId", args.companyId)
          .eq("occurrenceDedupeKey", args.occurrenceDedupeKey),
      )
      .unique();
    const now = Date.now();
    if (
      !candidate ||
      candidate.state !== "held" ||
      candidate.evidenceRevision !== args.expectedEvidenceRevision ||
      candidate.lastAdmissionDecisionId !== args.expectedDecisionId ||
      candidate.holdUntil !== args.expectedHoldUntil ||
      args.expectedHoldUntil > now
    ) return { status: "stale" as const };
    if (candidate.expiresAt <= now) {
      await terminalizeSystemDecision(
        ctx,
        candidate,
        "expire",
        "candidate_expired",
        "hold_expired",
        now,
      );
      return { status: "expired" as const };
    }
    assertValidCandidateState({
      state: "pending_classification",
      holdUntil: undefined,
      terminalReason: candidate.terminalReason,
    });
    await ctx.db.patch(candidate._id, {
      state: "pending_classification",
      holdUntil: undefined,
      updatedAt: now,
    });
    return { status: "released" as const };
  },
});

export const claimNextAdmissionCandidateForTest = internalMutation({
  args: {
    workerId: v.string(),
    classificationRunId: v.string(),
    requestedModelVersion: v.string(),
  },
  handler: claimNextAdmissionCandidateHandler,
});

export const recordAdmissionDecisionForTest = internalMutation({
  args: {
    workerId: v.string(),
    leaseToken: v.string(),
    ownerAccountId: v.string(),
    companyId: v.string(),
    occurrenceDedupeKey: v.string(),
    expectedEvidenceRevision: v.number(),
    classificationRunId: v.string(),
    requestedModelVersion: v.string(),
    modelVersion: v.string(),
    modelOutput: v.optional(v.any()),
  },
  handler: recordAdmissionDecisionHandler,
});

export const recordAdmissionTransportFailureForTest = internalMutation({
  args: {
    workerId: v.string(),
    leaseToken: v.string(),
    ownerAccountId: v.string(),
    companyId: v.string(),
    occurrenceDedupeKey: v.string(),
    expectedEvidenceRevision: v.number(),
    classificationRunId: v.string(),
    requestedModelVersion: v.string(),
  },
  handler: recordAdmissionTransportFailureHandler,
});
