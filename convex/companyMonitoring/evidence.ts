import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import { internalMutation, type MutationCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import {
  COMPANY_MONITORING_EVIDENCE_POLICY,
  compareCompanyEvidence,
  companyEvidenceProviderLocatorHash,
  companyEvidenceCanBlockObservation,
  normalizeCompanyEvidence,
  type EvidenceSubject,
  type ProviderEvidence,
} from "../../shared/company-monitoring-evidence";
import { COMPANY_MONITORING_LIMITS } from "../../shared/company-monitoring-contract";
import {
  assertValidCandidateState,
  companyMonitoringProviderEvidenceValidator,
} from "./validators";
import { terminalizeSystemDecision } from "./admission";
import {
  companyMonitoringCandidateEvidenceSnapshotDigest as candidateEvidenceSnapshotDigest,
  companyMonitoringEvidenceShape as evidenceShape,
} from "./admissionSnapshot";

const EVIDENCE_BATCH_SIZE = 25;
const CANDIDATE_BATCH_SIZE = 25;
const CLAIM_REVALIDATION_BATCH_SIZE = 25;
const MAX_INGESTION_ROWS = 100;
// One Exa receipt contains at most 25 results routed across at most 25
// companies. Reject a wider internal expansion before the first write so the
// receipt remains atomic and the mutation cannot exceed its scheduler budget.
const MAX_EXPANDED_EVIDENCE_ROWS = 25 * 25;
type EvidenceDoc = Doc<"companyMonitoringEvidence">;

function nextUpdatedAt(row: { updatedAt: number } | null | undefined, now: number) {
  return Math.max(now, (row?.updatedAt ?? now - 1) + 1);
}

async function canonicalSubjects(
  ctx: MutationCtx,
  ownerAccountId: string,
  requestedCompanyIds: string[],
) {
  if (
    requestedCompanyIds.length === 0 ||
    requestedCompanyIds.length > COMPANY_MONITORING_LIMITS.maxCompaniesPerAccount
  ) {
    throw new ConvexError("COMPANY_MONITORING_EVIDENCE_SUBJECTS_INVALID");
  }
  const subjectIds = [...new Set(requestedCompanyIds)].sort();
  if (subjectIds.length !== requestedCompanyIds.length) {
    throw new ConvexError("COMPANY_MONITORING_EVIDENCE_SUBJECTS_INVALID");
  }
  const canonical = await Promise.all(subjectIds.map(async (companyId): Promise<EvidenceSubject> => {
    const [company, claims] = await Promise.all([
      ctx.db
        .query("companyMonitoringCompanies")
        .withIndex("by_account_companyId", (q) =>
          q.eq("ownerAccountId", ownerAccountId).eq("companyId", companyId),
        )
        .unique(),
      ctx.db
        .query("companyMonitoringClaims")
        .withIndex("by_account_company", (q) =>
          q.eq("ownerAccountId", ownerAccountId).eq("companyId", companyId),
        )
        .take(COMPANY_MONITORING_LIMITS.maxClaimsPerCompany + 1),
    ]);
    if (
      !company ||
      company.lifecycle !== "active" ||
      !company.name ||
      claims.length > COMPANY_MONITORING_LIMITS.maxClaimsPerCompany
    ) {
      throw new ConvexError("COMPANY_MONITORING_EVIDENCE_SUBJECTS_INVALID");
    }
    return {
      companyId,
      name: company.name,
      claims: claims.map((claim) => ({
        claimId: claim.claimId,
        type: claim.type,
        value: claim.value,
        trustState: claim.trustState,
        ...(claim.allowedUses ? { allowedUses: claim.allowedUses } : {}),
        ...(claim.expiresAt !== undefined ? { expiresAt: claim.expiresAt } : {}),
      })),
    };
  }));
  // Only the requested company IDs are routing input. Names, claims, trust,
  // expiry, and allowed-use values are always re-read from this account.
  return canonical;
}

async function setSyndicationForActiveRows(ctx: MutationCtx, rows: EvidenceDoc[]) {
  const independent = rows
    .filter((row) =>
      row.sourceAuthority !== "low_authority" && row.independence !== "first_party"
    )
    .sort((left, right) =>
      left.publishedAt - right.publishedAt ||
      left.providerOriginFingerprint.localeCompare(right.providerOriginFingerprint) ||
      left.evidenceFingerprint.localeCompare(right.evidenceFingerprint)
    );
  const leaderId = independent[0]?._id;
  const now = Date.now();
  for (const row of independent) {
    const independence = row._id === leaderId ? "independent" as const : "syndicated" as const;
    if (row.independence !== independence) {
      await ctx.db.patch(row._id, { independence, updatedAt: now });
      row.independence = independence;
    }
  }
}

async function occurrenceLossReason(
  ctx: MutationCtx,
  ownerAccountId: string,
  companyId: string,
  occurrenceDedupeKey: string,
) {
  for (const [state, reason] of [
    ["deleted", "evidence_deleted"],
    ["unavailable", "evidence_unavailable"],
    ["authority_lost", "authority_lost"],
    ["expired", "evidence_expired"],
  ] as const) {
    const row = await ctx.db
      .query("companyMonitoringEvidence")
      .withIndex("by_account_company_occurrence_state", (q) =>
        q
          .eq("ownerAccountId", ownerAccountId)
          .eq("companyId", companyId)
          .eq("occurrenceDedupeKey", occurrenceDedupeKey)
          .eq("state", state),
      )
      .first();
    if (row) return reason;
  }
  return "evidence_unavailable" as const;
}

function candidateLifecycle(
  candidate: Doc<"companyMonitoringCandidates"> | null,
  now: number,
) {
  if (candidate) assertValidCandidateState(candidate);
  if (
    candidate?.state === "terminal" &&
    (candidate.terminalReason === "admitted" || candidate.terminalReason === "rejected")
  ) {
    return { state: "terminal" as const, terminalReason: candidate.terminalReason };
  }
  if (candidate && candidate.expiresAt <= now) {
    return { state: "terminal" as const, terminalReason: "hold_expired" as const };
  }
  if (
    candidate?.state === "held" &&
    candidate.holdUntil !== undefined &&
    candidate.holdUntil > now
  ) {
    return { state: "held" as const, holdUntil: candidate.holdUntil };
  }
  return { state: "pending_classification" as const };
}

async function recomputeOccurrenceCandidate(
  ctx: MutationCtx,
  ownerAccountId: string,
  companyId: string,
  occurrenceDedupeKey: string,
  fallbackLossReason?: "evidence_unavailable",
  excludeProvider?: "exa" | "x",
  scheduleDeadline = true,
) {
  const now = Date.now();
  const activePage = await ctx.db
    .query("companyMonitoringEvidence")
    .withIndex("by_account_company_occurrence_state", (q) =>
      q
        .eq("ownerAccountId", ownerAccountId)
        .eq("companyId", companyId)
        .eq("occurrenceDedupeKey", occurrenceDedupeKey)
        .eq("state", "active"),
    )
    .collect();
  for (const row of activePage) {
    if (row.expiresAt !== undefined && row.expiresAt <= now) {
      await ctx.db.patch(row._id, { state: "expired", updatedAt: now });
      row.state = "expired";
    }
  }
  const active = activePage.filter((row) =>
    row.state === "active" && row.provider !== excludeProvider
  );
  await setSyndicationForActiveRows(ctx, active);
  const existing = await ctx.db
    .query("companyMonitoringCandidates")
    .withIndex("by_account_company_occurrence", (q) =>
      q
        .eq("ownerAccountId", ownerAccountId)
        .eq("companyId", companyId)
        .eq("occurrenceDedupeKey", occurrenceDedupeKey),
    )
    .unique();
  if (existing) assertValidCandidateState(existing);
  if (
    existing &&
    existing.expiresAt <= now &&
    existing.state !== "terminal"
  ) {
    await terminalizeSystemDecision(
      ctx,
      existing,
      "expire",
      "candidate_expired",
      "hold_expired",
      now,
    );
    return;
  }
  if (active.length > 0) {
    const ranked = active.map(evidenceShape).sort(compareCompanyEvidence);
    const selected = ranked.slice(0, COMPANY_MONITORING_EVIDENCE_POLICY.maxReferences);
    const evidenceSnapshotDigest = await candidateEvidenceSnapshotDigest({
      selectionPolicyVersion: COMPANY_MONITORING_EVIDENCE_POLICY.version,
      referenceCount: active.length,
      referencesTruncated: active.length > selected.length,
      evidence: selected,
    });
    const evidenceChanged = existing?.evidenceSnapshotDigest !== evidenceSnapshotDigest;
    const first = [...active].sort((left, right) =>
      left.observedAt - right.observedAt || left.evidenceFingerprint.localeCompare(right.evidenceFingerprint)
    )[0]!;
    const lifecycle = evidenceChanged && existing?.state === "held"
      ? { state: "pending_classification" as const }
      : candidateLifecycle(existing, now);
    const lifecycleChanged = Boolean(
      existing && (
        existing.state !== lifecycle.state ||
        (lifecycle.state === "held" && existing.holdUntil !== lifecycle.holdUntil)
      )
    );
    if (existing && !evidenceChanged && !lifecycleChanged) return;
    const row = {
      ownerAccountId,
      companyId,
      candidateId: existing?.candidateId ?? `cm_candidate_${occurrenceDedupeKey.slice(0, 40)}`,
      occurrenceDedupeKey,
      ...lifecycle,
      firstDiscoveredAt: existing?.firstDiscoveredAt ?? first.observedAt,
      firstDiscoveredPath: existing?.firstDiscoveredPath ?? `${first.provider}:${first.providerLocatorHash}`,
      attemptCount: existing?.attemptCount ?? 0,
      expiresAt: existing?.expiresAt ?? first.observedAt + COMPANY_MONITORING_EVIDENCE_POLICY.candidateTtlMs,
      observationBlocking: lifecycle.state !== "terminal" && active.some((evidence) =>
        companyEvidenceCanBlockObservation(evidenceShape(evidence))
      ),
      referenceEvidenceFingerprints: selected.map((evidence) => evidence.evidenceFingerprint),
      referenceCount: active.length,
      referencesTruncated: active.length > selected.length,
      selectionPolicyVersion: COMPANY_MONITORING_EVIDENCE_POLICY.version,
      evidenceRevision: existing
        ? existing.evidenceRevision + (evidenceChanged ? 1 : 0)
        : 1,
      evidenceSnapshotDigest,
      ...(existing?.lastAdmissionDecisionId
        ? { lastAdmissionDecisionId: existing.lastAdmissionDecisionId }
        : {}),
      ...(!evidenceChanged && existing?.classificationWorkerId &&
          existing.classificationLeaseToken && existing.classificationLeaseExpiresAt !== undefined
        ? {
            classificationWorkerId: existing.classificationWorkerId,
            classificationLeaseToken: existing.classificationLeaseToken,
            classificationLeaseExpiresAt: existing.classificationLeaseExpiresAt,
            ...(existing.classificationRunId
              ? { classificationRunId: existing.classificationRunId }
              : {}),
            ...(existing.classificationRequestedModelVersion
              ? {
                  classificationRequestedModelVersion:
                    existing.classificationRequestedModelVersion,
                }
              : {}),
          }
        : {}),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    assertValidCandidateState(row);
    if (existing) await ctx.db.replace(existing._id, row);
    else await ctx.db.insert("companyMonitoringCandidates", row);
    const nextDeadline = [
      ...(lifecycle.state === "terminal" || row.expiresAt <= now ? [] : [row.expiresAt]),
      ...active.flatMap((evidence) =>
        evidence.expiresAt !== undefined && evidence.expiresAt > now
          ? [evidence.expiresAt]
          : []
      ),
    ].sort((left, right) => left - right)[0];
    if (scheduleDeadline && nextDeadline !== undefined) {
      await ctx.scheduler.runAt(
        nextDeadline,
        internal.companyMonitoring.evidence.recomputeCompanyEvidence,
        { ownerAccountId, companyId, occurrenceDedupeKey },
      );
    }
    return;
  }
  if (!existing) return;
  const emptyEvidenceSnapshotDigest = await candidateEvidenceSnapshotDigest({
    selectionPolicyVersion: existing.selectionPolicyVersion,
    referenceCount: 0,
    referencesTruncated: false,
    evidence: [],
  });
  const evidenceAlreadyEmpty =
    existing.referenceEvidenceFingerprints.length === 0 &&
    existing.referenceCount === 0 &&
    !existing.referencesTruncated &&
    existing.evidenceSnapshotDigest === emptyEvidenceSnapshotDigest;
  if (existing.terminalReason === "admitted" || existing.terminalReason === "rejected") {
    if (evidenceAlreadyEmpty) return;
    await ctx.db.patch(existing._id, {
      observationBlocking: false,
      referenceEvidenceFingerprints: [],
      referenceCount: 0,
      referencesTruncated: false,
      evidenceRevision: existing.evidenceRevision + 1,
      evidenceSnapshotDigest: emptyEvidenceSnapshotDigest,
      updatedAt: now,
    });
    return;
  }
  const terminalReason = fallbackLossReason ?? await occurrenceLossReason(
    ctx,
    ownerAccountId,
    companyId,
    occurrenceDedupeKey,
  );
  await terminalizeSystemDecision(
    ctx,
    existing,
    "expire",
    `candidate_${terminalReason}`,
    terminalReason,
    now,
  );
  if (evidenceAlreadyEmpty) return;
  await ctx.db.patch(existing._id, {
    referenceEvidenceFingerprints: [],
    referenceCount: 0,
    referencesTruncated: false,
    evidenceRevision: existing.evidenceRevision + 1,
    evidenceSnapshotDigest: emptyEvidenceSnapshotDigest,
    updatedAt: now,
  });
}

export async function ingestCompanyEvidenceForCompanyIds(
  ctx: MutationCtx,
  input: {
    ownerAccountId: string;
    companyIds: string[];
    evidence: ProviderEvidence[];
  },
) {
  if (input.evidence.length === 0 || input.evidence.length > MAX_INGESTION_ROWS) {
    throw new ConvexError("COMPANY_MONITORING_EVIDENCE_BATCH_INVALID");
  }
  const account = await ctx.db
    .query("companyMonitoringAccounts")
    .withIndex("by_logicalAccountId", (q) => q.eq("logicalAccountId", input.ownerAccountId))
    .unique();
  if (!account || account.lifecycle !== "entitled" || account.terminalReason) {
    throw new ConvexError("COMPANY_MONITORING_ACCOUNT_INACTIVE");
  }
  const subjects = await canonicalSubjects(ctx, input.ownerAccountId, input.companyIds);
  const normalized = await normalizeCompanyEvidence({
    ownerAccountId: input.ownerAccountId,
    subjects,
    evidence: input.evidence,
    now: Date.now(),
  });
  if (normalized.evidence.length > MAX_EXPANDED_EVIDENCE_ROWS) {
    throw new ConvexError("COMPANY_MONITORING_EVIDENCE_EXPANSION_INVALID");
  }
  const now = Date.now();
  const affected = new Map<string, Map<string, "evidence_unavailable" | undefined>>();
  const rememberOccurrence = (
    companyId: string,
    occurrenceDedupeKey: string,
    fallbackLossReason?: "evidence_unavailable",
  ) => {
    const occurrences = affected.get(companyId) ?? new Map();
    if (!occurrences.has(occurrenceDedupeKey) || fallbackLossReason === undefined) {
      occurrences.set(occurrenceDedupeKey, fallbackLossReason);
    }
    affected.set(companyId, occurrences);
  };
  for (const evidence of normalized.evidence) {
    const existing = await ctx.db
      .query("companyMonitoringEvidence")
      .withIndex("by_account_company_locator", (q) =>
        q
          .eq("ownerAccountId", evidence.ownerAccountId)
          .eq("companyId", evidence.companyId)
          .eq("provider", evidence.provider)
          .eq("providerLocatorHash", evidence.providerLocatorHash),
      )
      .unique();
    const row = {
      ...evidence,
      evidenceId: `cm_evidence_${evidence.evidenceFingerprint.slice(0, 40)}`,
      state: "active" as const,
      firstSeenAt: existing?.evidenceFingerprint === evidence.evidenceFingerprint
        ? existing.firstSeenAt
        : now,
      updatedAt: nextUpdatedAt(existing, now),
    };
    if (existing) await ctx.db.replace(existing._id, row);
    else await ctx.db.insert("companyMonitoringEvidence", row);
    if (existing && existing.occurrenceDedupeKey !== evidence.occurrenceDedupeKey) {
      rememberOccurrence(
        evidence.companyId,
        existing.occurrenceDedupeKey,
        "evidence_unavailable",
      );
    }
    rememberOccurrence(evidence.companyId, evidence.occurrenceDedupeKey);
  }
  for (const [companyId, occurrences] of [...affected].sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    for (const [occurrenceDedupeKey, fallbackLossReason] of [...occurrences].sort()) {
      await recomputeOccurrenceCandidate(
        ctx,
        input.ownerAccountId,
        companyId,
        occurrenceDedupeKey,
        fallbackLossReason,
        undefined,
        fallbackLossReason === undefined,
      );
    }
  }
  const referencedClaimIds = new Map<string, Set<string>>();
  for (const evidence of normalized.evidence) {
    const ids = referencedClaimIds.get(evidence.companyId) ?? new Set<string>();
    for (const claimId of evidence.matchedClaimIds) ids.add(claimId);
    referencedClaimIds.set(evidence.companyId, ids);
  }
  for (const subject of subjects) {
    const ids = referencedClaimIds.get(subject.companyId);
    const nextClaimExpiry = subject.claims
      .filter((claim) =>
        ids?.has(claim.claimId) && claim.expiresAt !== undefined && claim.expiresAt > now
      )
      .map((claim) => claim.expiresAt!)
      .sort((left, right) => left - right)[0];
    if (nextClaimExpiry !== undefined) {
      await ctx.scheduler.runAt(
        nextClaimExpiry,
        internal.companyMonitoring.evidence.revalidateExpiredCompanyEvidenceClaims,
        { ownerAccountId: input.ownerAccountId, companyId: subject.companyId },
      );
    }
  }
  return {
    evidenceCount: normalized.evidence.length,
    candidateCount: normalized.candidates.length,
    companyCount: affected.size,
  };
}

export async function setCompanyEvidenceStateForProviderLocators(
  ctx: MutationCtx,
  args: {
    ownerAccountId: string;
    companyId: string;
    provider: "exa" | "x";
    providerLocators: string[];
    state: "deleted" | "authority_lost" | "unavailable";
  },
) {
  const affected = new Set<string>();
  for (const providerLocator of [...new Set(args.providerLocators)].sort()) {
    const providerLocatorHash = await companyEvidenceProviderLocatorHash(
      args.provider,
      providerLocator,
    );
    const row = await ctx.db
      .query("companyMonitoringEvidence")
      .withIndex("by_account_company_locator", (q) =>
        q
          .eq("ownerAccountId", args.ownerAccountId)
          .eq("companyId", args.companyId)
          .eq("provider", args.provider)
          .eq("providerLocatorHash", providerLocatorHash),
      )
      .unique();
    if (
      row &&
      row.state !== args.state &&
      (args.state === "deleted" || row.state === "active")
    ) {
      await ctx.db.patch(row._id, { state: args.state, updatedAt: Date.now() });
      affected.add(row.occurrenceDedupeKey);
    }
  }
  for (const occurrenceDedupeKey of [...affected].sort()) {
    await recomputeOccurrenceCandidate(
      ctx,
      args.ownerAccountId,
      args.companyId,
      occurrenceDedupeKey,
    );
  }
}

async function currentEvidenceSubject(
  ctx: MutationCtx,
  ownerAccountId: string,
  companyId: string,
): Promise<EvidenceSubject | null> {
  const [company, claims] = await Promise.all([
    ctx.db
      .query("companyMonitoringCompanies")
      .withIndex("by_account_companyId", (q) =>
        q.eq("ownerAccountId", ownerAccountId).eq("companyId", companyId),
      )
      .unique(),
    ctx.db
      .query("companyMonitoringClaims")
      .withIndex("by_account_company", (q) =>
        q.eq("ownerAccountId", ownerAccountId).eq("companyId", companyId),
      )
      .take(COMPANY_MONITORING_LIMITS.maxClaimsPerCompany + 1),
  ]);
  if (
    !company ||
    company.lifecycle === "removed" ||
    !company.name ||
    claims.length > COMPANY_MONITORING_LIMITS.maxClaimsPerCompany
  ) return null;
  return {
    companyId,
    name: company.name,
    claims: claims.map((claim) => ({
      claimId: claim.claimId,
      type: claim.type,
      value: claim.value,
      trustState: claim.trustState,
      ...(claim.allowedUses ? { allowedUses: claim.allowedUses } : {}),
      ...(claim.expiresAt !== undefined ? { expiresAt: claim.expiresAt } : {}),
    })),
  };
}

function providerEvidenceFromRow(row: EvidenceDoc): ProviderEvidence {
  return {
    provider: row.provider,
    providerLocator: row.providerLocator,
    ...(row.queryVersion ? { queryVersion: row.queryVersion } : {}),
    ...(row.url ? { url: row.url } : {}),
    ...(row.title ? { title: row.title } : {}),
    ...(row.text ? { text: row.text } : {}),
    ...(row.author ? { author: row.author } : {}),
    ...(row.authorAccountId ? { authorAccountId: row.authorAccountId } : {}),
    publishedAt: row.publishedAt,
    observedAt: row.observedAt,
    ...(row.expiresAt !== undefined ? { expiresAt: row.expiresAt } : {}),
    candidateCompanyIds: [row.companyId],
    // Exa first-party authority is derived from a currently verified official
    // domain claim. Revalidation must earn it again instead of treating the
    // stored derived value as provider-supplied authority.
    sourceAuthority: row.provider === "exa" && row.sourceAuthority === "verified_first_party"
      ? "low_authority"
      : row.sourceAuthority,
  };
}

export async function revalidateCompanyEvidenceClaims(
  ctx: MutationCtx,
  args: {
    ownerAccountId: string;
    companyId: string;
    expectedSnapshotGeneration: number;
    cursor?: string;
  },
) {
  const company = await ctx.db
    .query("companyMonitoringCompanies")
    .withIndex("by_account_companyId", (q) =>
      q.eq("ownerAccountId", args.ownerAccountId).eq("companyId", args.companyId),
    )
    .unique();
  if (
    !company ||
    company.lifecycle === "removed" ||
    company.snapshotGeneration !== args.expectedSnapshotGeneration
  ) return { status: "stale" as const, complete: true };

  const subject = await currentEvidenceSubject(ctx, args.ownerAccountId, args.companyId);
  if (!subject) return { status: "stale" as const, complete: true };
  const now = Date.now();
  const page = await ctx.db
    .query("companyMonitoringEvidence")
    .withIndex("by_account_company", (q) =>
      q.eq("ownerAccountId", args.ownerAccountId).eq("companyId", args.companyId),
    )
    .paginate({ cursor: args.cursor ?? null, numItems: CLAIM_REVALIDATION_BATCH_SIZE });
  const affected = new Set<string>();
  let changed = 0;
  for (const row of page.page) {
    if (
      (row.state !== "active" && row.state !== "authority_lost") ||
      row.matchedClaimIds.length === 0
    ) continue;
    if (row.expiresAt !== undefined && row.expiresAt <= now) {
      await ctx.db.patch(row._id, {
        state: "expired",
        updatedAt: nextUpdatedAt(row, now),
      });
      affected.add(row.occurrenceDedupeKey);
      changed += 1;
      continue;
    }
    const normalized = await normalizeCompanyEvidence({
      ownerAccountId: args.ownerAccountId,
      subjects: [subject],
      evidence: [providerEvidenceFromRow(row)],
      now,
    });
    const replacement = normalized.evidence[0];
    if (!replacement) {
      if (row.state !== "authority_lost") {
        await ctx.db.patch(row._id, {
          state: "authority_lost",
          updatedAt: nextUpdatedAt(row, now),
        });
        affected.add(row.occurrenceDedupeKey);
        changed += 1;
      }
      continue;
    }
    const attributionChanged =
      row.state !== "active" ||
      row.sourceAuthority !== replacement.sourceAuthority ||
      row.independence !== replacement.independence ||
      row.matchedClaimIds.length !== replacement.matchedClaimIds.length ||
      row.matchedClaimIds.some((claimId, index) =>
        claimId !== replacement.matchedClaimIds[index]
      );
    if (!attributionChanged) continue;
    await ctx.db.patch(row._id, {
      state: "active",
      matchedClaimIds: replacement.matchedClaimIds,
      sourceAuthority: replacement.sourceAuthority,
      independence: replacement.independence,
      updatedAt: nextUpdatedAt(row, now),
    });
    affected.add(row.occurrenceDedupeKey);
    changed += 1;
  }
  for (const occurrenceDedupeKey of [...affected].sort()) {
    await recomputeOccurrenceCandidate(
      ctx,
      args.ownerAccountId,
      args.companyId,
      occurrenceDedupeKey,
    );
  }
  if (!page.isDone) {
    await ctx.scheduler.runAfter(
      0,
      internal.companyMonitoring.evidence.continueCompanyEvidenceClaimRevalidation,
      { ...args, cursor: page.continueCursor },
    );
  }
  return {
    status: "revalidated" as const,
    complete: page.isDone,
    changed,
  };
}

async function xAuthorityGeneration(
  ctx: MutationCtx,
  ownerAccountId: string,
  companyId: string,
) {
  const identity = await ctx.db
    .query("companyMonitoringXIdentities")
    .withIndex("by_account_company", (q) =>
      q.eq("ownerAccountId", ownerAccountId).eq("companyId", companyId),
    )
    .unique();
  return identity
    ? [
        identity._id,
        identity.state,
        identity.accountId,
        identity.allowedUses.join(","),
        identity.evidenceHash,
        identity.expiresAt,
        identity.updatedAt,
      ].join(":")
    : "missing";
}

async function continueCompanyProviderStateTransitionBatch(
  ctx: MutationCtx,
  args: {
    ownerAccountId: string;
    companyId: string;
    provider: "exa" | "x";
    state: "deleted" | "authority_lost";
    authorityGeneration: string;
  },
) {
  if (
    args.provider === "x" &&
    await xAuthorityGeneration(ctx, args.ownerAccountId, args.companyId) !==
      args.authorityGeneration
  ) return { complete: true, status: "stale" as const };
  return transitionCurrentCompanyProviderEvidence(ctx, args);
}

export async function setAllCompanyProviderEvidenceState(
  ctx: MutationCtx,
  args: {
    ownerAccountId: string;
    companyId: string;
    provider: "exa" | "x";
    state: "deleted" | "authority_lost";
  },
) {
  const authorityGeneration = args.provider === "x"
    ? await xAuthorityGeneration(ctx, args.ownerAccountId, args.companyId)
    : "exa";
  return continueCompanyProviderStateTransitionBatch(ctx, {
    ...args,
    authorityGeneration,
  });
}

async function transitionCurrentCompanyProviderEvidence(
  ctx: MutationCtx,
  args: {
    ownerAccountId: string;
    companyId: string;
    provider: "exa" | "x";
    state: "deleted" | "authority_lost";
    authorityGeneration: string;
  },
) {
  const page = await ctx.db
    .query("companyMonitoringEvidence")
    .withIndex("by_account_company_provider_state", (q) =>
      q
        .eq("ownerAccountId", args.ownerAccountId)
        .eq("companyId", args.companyId)
        .eq("provider", args.provider)
        .eq("state", "active"),
    )
    .take(EVIDENCE_BATCH_SIZE + 1);
  const active = page.slice(0, EVIDENCE_BATCH_SIZE);
  const now = Date.now();
  for (const row of active) {
    await ctx.db.patch(row._id, { state: args.state, updatedAt: now });
  }
  const occurrences = [...new Set(active.map((row) => row.occurrenceDedupeKey))].sort();
  for (const occurrenceDedupeKey of occurrences) {
    await recomputeOccurrenceCandidate(
      ctx,
      args.ownerAccountId,
      args.companyId,
      occurrenceDedupeKey,
      undefined,
      args.provider,
    );
  }
  if (page.length > EVIDENCE_BATCH_SIZE) {
    await ctx.scheduler.runAfter(
      0,
      internal.companyMonitoring.evidence.continueCompanyProviderStateTransition,
      args,
    );
  }
  return { complete: page.length <= EVIDENCE_BATCH_SIZE, status: "transitioned" as const };
}

export async function purgeCompanyEvidenceBatch(
  ctx: MutationCtx,
  ownerAccountId: string,
  companyId: string,
) {
  const page = await ctx.db
    .query("companyMonitoringEvidence")
    .withIndex("by_account_company", (q) =>
      q.eq("ownerAccountId", ownerAccountId).eq("companyId", companyId),
    )
    .take(EVIDENCE_BATCH_SIZE + 1);
  const batch = page.slice(0, EVIDENCE_BATCH_SIZE);
  for (const row of batch) await ctx.db.delete(row._id);
  return { complete: page.length <= EVIDENCE_BATCH_SIZE, deleted: batch.length };
}

export async function purgeCompanyCandidatesBatch(
  ctx: MutationCtx,
  ownerAccountId: string,
  companyId: string,
) {
  const decisions = await ctx.db
    .query("companyMonitoringAdmissionDecisions")
    .withIndex("by_account_company", (q) =>
      q.eq("ownerAccountId", ownerAccountId).eq("companyId", companyId),
    )
    .take(CANDIDATE_BATCH_SIZE + 1);
  for (const row of decisions.slice(0, CANDIDATE_BATCH_SIZE)) await ctx.db.delete(row._id);
  if (decisions.length > CANDIDATE_BATCH_SIZE) {
    return { complete: false, deleted: decisions.length - 1 };
  }
  const page = await ctx.db
    .query("companyMonitoringCandidates")
    .withIndex("by_account_company", (q) =>
      q.eq("ownerAccountId", ownerAccountId).eq("companyId", companyId),
    )
    .take(CANDIDATE_BATCH_SIZE + 1);
  const batch = page.slice(0, CANDIDATE_BATCH_SIZE);
  for (const row of batch) await ctx.db.delete(row._id);
  return {
    complete: page.length <= CANDIDATE_BATCH_SIZE,
    deleted: batch.length + decisions.length,
  };
}

export async function purgeAccountEvidenceBatch(ctx: MutationCtx, ownerAccountId: string) {
  const page = await ctx.db
    .query("companyMonitoringEvidence")
    .withIndex("by_account_company", (q) => q.eq("ownerAccountId", ownerAccountId))
    .take(EVIDENCE_BATCH_SIZE + 1);
  for (const row of page.slice(0, EVIDENCE_BATCH_SIZE)) await ctx.db.delete(row._id);
  return { complete: page.length <= EVIDENCE_BATCH_SIZE };
}

export async function purgeAccountCandidatesBatch(ctx: MutationCtx, ownerAccountId: string) {
  const decisions = await ctx.db
    .query("companyMonitoringAdmissionDecisions")
    .withIndex("by_account_company", (q) => q.eq("ownerAccountId", ownerAccountId))
    .take(CANDIDATE_BATCH_SIZE + 1);
  for (const row of decisions.slice(0, CANDIDATE_BATCH_SIZE)) await ctx.db.delete(row._id);
  if (decisions.length > CANDIDATE_BATCH_SIZE) return { complete: false };
  const page = await ctx.db
    .query("companyMonitoringCandidates")
    .withIndex("by_account_company", (q) => q.eq("ownerAccountId", ownerAccountId))
    .take(CANDIDATE_BATCH_SIZE + 1);
  for (const row of page.slice(0, CANDIDATE_BATCH_SIZE)) await ctx.db.delete(row._id);
  return { complete: page.length <= CANDIDATE_BATCH_SIZE };
}

export const ingestEvidenceForTest = internalMutation({
  args: {
    ownerAccountId: v.string(),
    companyIds: v.array(v.string()),
    evidence: v.array(companyMonitoringProviderEvidenceValidator),
  },
  handler: (ctx, args) => ingestCompanyEvidenceForCompanyIds(ctx, args as {
    ownerAccountId: string;
    companyIds: string[];
    evidence: ProviderEvidence[];
  }),
});

export const recomputeCompanyEvidence = internalMutation({
  args: {
    ownerAccountId: v.string(),
    companyId: v.string(),
    occurrenceDedupeKey: v.string(),
  },
  handler: (ctx, args) => recomputeOccurrenceCandidate(
    ctx,
    args.ownerAccountId,
    args.companyId,
    args.occurrenceDedupeKey,
  ),
});

export const recomputeCompanyEvidenceForTest = internalMutation({
  args: {
    ownerAccountId: v.string(),
    companyId: v.string(),
    occurrenceDedupeKey: v.string(),
  },
  handler: (ctx, args) => recomputeOccurrenceCandidate(
    ctx,
    args.ownerAccountId,
    args.companyId,
    args.occurrenceDedupeKey,
  ),
});

export const continueCompanyEvidenceClaimRevalidation = internalMutation({
  args: {
    ownerAccountId: v.string(),
    companyId: v.string(),
    expectedSnapshotGeneration: v.number(),
    cursor: v.optional(v.string()),
  },
  handler: revalidateCompanyEvidenceClaims,
});

export const revalidateExpiredCompanyEvidenceClaims = internalMutation({
  args: {
    ownerAccountId: v.string(),
    companyId: v.string(),
  },
  handler: async (ctx, args) => {
    const [company, claims] = await Promise.all([
      ctx.db
        .query("companyMonitoringCompanies")
        .withIndex("by_account_companyId", (q) =>
          q.eq("ownerAccountId", args.ownerAccountId).eq("companyId", args.companyId),
        )
        .unique(),
      ctx.db
        .query("companyMonitoringClaims")
        .withIndex("by_account_company", (q) =>
          q.eq("ownerAccountId", args.ownerAccountId).eq("companyId", args.companyId),
        )
        .take(COMPANY_MONITORING_LIMITS.maxClaimsPerCompany + 1),
    ]);
    if (
      !company ||
      company.lifecycle === "removed" ||
      claims.length > COMPANY_MONITORING_LIMITS.maxClaimsPerCompany
    ) return { status: "stale" as const, complete: true };
    const now = Date.now();
    const attributionClaims = claims.filter((claim) =>
      claim.allowedUses?.includes("attribution") &&
      claim.trustState !== "expired" &&
      claim.trustState !== "rejected"
    );
    const nextExpiry = attributionClaims
      .flatMap((claim) =>
        claim.expiresAt !== undefined && claim.expiresAt > now ? [claim.expiresAt] : []
      )
      .sort((left, right) => left - right)[0];
    if (nextExpiry !== undefined) {
      await ctx.scheduler.runAt(
        nextExpiry,
        internal.companyMonitoring.evidence.revalidateExpiredCompanyEvidenceClaims,
        args,
      );
    }
    if (!claims.some((claim) =>
      claim.allowedUses?.includes("attribution") &&
      (
        claim.trustState === "expired" ||
        claim.trustState === "rejected" ||
        (claim.expiresAt !== undefined && claim.expiresAt <= now)
      )
    )) return { status: "current" as const, complete: true };
    return revalidateCompanyEvidenceClaims(ctx, {
      ...args,
      expectedSnapshotGeneration: company.snapshotGeneration,
    });
  },
});

export const continueCompanyProviderStateTransition = internalMutation({
  args: {
    ownerAccountId: v.string(),
    companyId: v.string(),
    provider: v.union(v.literal("exa"), v.literal("x")),
    state: v.union(v.literal("deleted"), v.literal("authority_lost")),
    authorityGeneration: v.string(),
  },
  handler: continueCompanyProviderStateTransitionBatch,
});

export const setAllCompanyProviderEvidenceStateForTest = internalMutation({
  args: {
    ownerAccountId: v.string(),
    companyId: v.string(),
    provider: v.union(v.literal("exa"), v.literal("x")),
    state: v.union(v.literal("deleted"), v.literal("authority_lost")),
  },
  handler: setAllCompanyProviderEvidenceState,
});
