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
  type NormalizedCompanyEvidence,
  type ProviderEvidence,
} from "../../shared/company-monitoring-evidence";
import { COMPANY_MONITORING_LIMITS } from "../../shared/company-monitoring-contract";
import {
  companyMonitoringProviderEvidenceValidator,
} from "./validators";

const EVIDENCE_BATCH_SIZE = 25;
const CANDIDATE_BATCH_SIZE = 25;
const MAX_INGESTION_ROWS = 100;

type EvidenceDoc = Doc<"companyMonitoringEvidence">;

function evidenceShape(row: EvidenceDoc): NormalizedCompanyEvidence {
  return {
    ownerAccountId: row.ownerAccountId,
    companyId: row.companyId,
    provider: row.provider,
    providerLocator: row.providerLocator,
    providerLocatorHash: row.providerLocatorHash,
    providerOrigin: row.providerOrigin,
    providerOriginFingerprint: row.providerOriginFingerprint,
    contentFingerprint: row.contentFingerprint,
    evidenceFingerprint: row.evidenceFingerprint,
    occurrenceDedupeKey: row.occurrenceDedupeKey,
    matchedClaimIds: row.matchedClaimIds,
    sourceAuthority: row.sourceAuthority,
    independence: row.independence,
    ...(row.url ? { url: row.url } : {}),
    ...(row.title ? { title: row.title } : {}),
    ...(row.text ? { text: row.text } : {}),
    ...(row.author ? { author: row.author } : {}),
    ...(row.authorAccountId ? { authorAccountId: row.authorAccountId } : {}),
    publishedAt: row.publishedAt,
    observedAt: row.observedAt,
    ...(row.expiresAt !== undefined ? { expiresAt: row.expiresAt } : {}),
  };
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
  return "evidence_expired" as const;
}

function candidateLifecycle(
  candidate: Doc<"companyMonitoringCandidates"> | null,
  now: number,
) {
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
  const active = activePage.filter((row) => row.state === "active");
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
  if (active.length > 0) {
    const ranked = active.map(evidenceShape).sort(compareCompanyEvidence);
    const selected = ranked.slice(0, COMPANY_MONITORING_EVIDENCE_POLICY.maxReferences);
    const first = [...active].sort((left, right) =>
      left.observedAt - right.observedAt || left.evidenceFingerprint.localeCompare(right.evidenceFingerprint)
    )[0]!;
    const lifecycle = candidateLifecycle(existing, now);
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
      evidenceRevision: (existing?.evidenceRevision ?? 0) + 1,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    if (existing) await ctx.db.replace(existing._id, row);
    else await ctx.db.insert("companyMonitoringCandidates", row);
    return;
  }
  if (!existing) return;
  if (existing.terminalReason === "admitted" || existing.terminalReason === "rejected") {
    await ctx.db.patch(existing._id, {
      observationBlocking: false,
      referenceEvidenceFingerprints: [],
      referenceCount: 0,
      referencesTruncated: false,
      evidenceRevision: existing.evidenceRevision + 1,
      updatedAt: now,
    });
    return;
  }
  await ctx.db.patch(existing._id, {
      state: "terminal",
      holdUntil: undefined,
      terminalReason: await occurrenceLossReason(
        ctx,
        ownerAccountId,
        companyId,
        occurrenceDedupeKey,
      ),
      observationBlocking: false,
      referenceEvidenceFingerprints: [],
      referenceCount: 0,
      referencesTruncated: false,
      evidenceRevision: existing.evidenceRevision + 1,
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
  const now = Date.now();
  const affected = new Map<string, Set<string>>();
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
      firstSeenAt: existing?.firstSeenAt ?? now,
      updatedAt: now,
    };
    if (existing) await ctx.db.replace(existing._id, row);
    else await ctx.db.insert("companyMonitoringEvidence", row);
    const occurrences = affected.get(evidence.companyId) ?? new Set<string>();
    occurrences.add(evidence.occurrenceDedupeKey);
    affected.set(evidence.companyId, occurrences);
    if (evidence.expiresAt !== undefined && evidence.expiresAt > now) {
      await ctx.scheduler.runAt(
        evidence.expiresAt,
        (internal as any).companyMonitoring.evidence.recomputeCompanyEvidence,
        {
          ownerAccountId: input.ownerAccountId,
          companyId: evidence.companyId,
          occurrenceDedupeKey: evidence.occurrenceDedupeKey,
        },
      );
    }
  }
  for (const [companyId, occurrences] of [...affected].sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    for (const occurrenceDedupeKey of [...occurrences].sort()) {
      const existingCandidate = await ctx.db
        .query("companyMonitoringCandidates")
        .withIndex("by_account_company_occurrence", (q) =>
          q
            .eq("ownerAccountId", input.ownerAccountId)
            .eq("companyId", companyId)
            .eq("occurrenceDedupeKey", occurrenceDedupeKey),
        )
        .unique();
      await recomputeOccurrenceCandidate(
        ctx,
        input.ownerAccountId,
        companyId,
        occurrenceDedupeKey,
      );
      if (!existingCandidate) {
        const candidate = await ctx.db
          .query("companyMonitoringCandidates")
          .withIndex("by_account_company_occurrence", (q) =>
            q
              .eq("ownerAccountId", input.ownerAccountId)
              .eq("companyId", companyId)
              .eq("occurrenceDedupeKey", occurrenceDedupeKey),
          )
          .unique();
        if (candidate && candidate.expiresAt > now) {
          await ctx.scheduler.runAt(
            candidate.expiresAt,
            (internal as any).companyMonitoring.evidence.recomputeCompanyEvidence,
            { ownerAccountId: input.ownerAccountId, companyId, occurrenceDedupeKey },
          );
        }
      }
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

export async function setAllCompanyProviderEvidenceState(
  ctx: MutationCtx,
  args: {
    ownerAccountId: string;
    companyId: string;
    provider: "exa" | "x";
    state: "deleted" | "authority_lost";
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
    );
  }
  if (page.length > EVIDENCE_BATCH_SIZE) {
    await ctx.scheduler.runAfter(
      0,
      (internal as any).companyMonitoring.evidence.continueCompanyProviderStateTransition,
      args,
    );
  }
  return { complete: page.length <= EVIDENCE_BATCH_SIZE };
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
  const page = await ctx.db
    .query("companyMonitoringCandidates")
    .withIndex("by_account_company", (q) =>
      q.eq("ownerAccountId", ownerAccountId).eq("companyId", companyId),
    )
    .take(CANDIDATE_BATCH_SIZE + 1);
  const batch = page.slice(0, CANDIDATE_BATCH_SIZE);
  for (const row of batch) await ctx.db.delete(row._id);
  return { complete: page.length <= CANDIDATE_BATCH_SIZE, deleted: batch.length };
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

export const continueCompanyProviderStateTransition = internalMutation({
  args: {
    ownerAccountId: v.string(),
    companyId: v.string(),
    provider: v.union(v.literal("exa"), v.literal("x")),
    state: v.union(v.literal("deleted"), v.literal("authority_lost")),
  },
  handler: setAllCompanyProviderEvidenceState,
});

// Classifier state changes stay behind an internal mutation.
export const recordCandidateAttempt = internalMutation({
  args: {
    ownerAccountId: v.string(),
    companyId: v.string(),
    occurrenceDedupeKey: v.string(),
    outcome: v.union(
      v.literal("pending"),
      v.literal("held"),
      v.literal("admitted"),
      v.literal("rejected"),
    ),
    holdUntil: v.optional(v.number()),
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
    if (!candidate || candidate.state === "terminal") {
      throw new ConvexError("COMPANY_MONITORING_CANDIDATE_NOT_ACTIVE");
    }
    const now = Date.now();
    const attemptCount = candidate.attemptCount + 1;
    if (args.outcome === "held") {
      if (
        !Number.isSafeInteger(args.holdUntil) ||
        args.holdUntil! <= now ||
        args.holdUntil! > candidate.expiresAt
      ) {
        throw new ConvexError("COMPANY_MONITORING_CANDIDATE_HOLD_INVALID");
      }
      await ctx.db.patch(candidate._id, {
        state: "held",
        holdUntil: args.holdUntil,
        terminalReason: undefined,
        attemptCount,
        updatedAt: now,
      });
    } else if (args.outcome === "pending") {
      await ctx.db.patch(candidate._id, {
        state: "pending_classification",
        holdUntil: undefined,
        terminalReason: undefined,
        attemptCount,
        updatedAt: now,
      });
    } else {
      await ctx.db.patch(candidate._id, {
        state: "terminal",
        holdUntil: undefined,
        terminalReason: args.outcome,
        observationBlocking: false,
        attemptCount,
        updatedAt: now,
      });
    }
    return { status: args.outcome, attemptCount };
  },
});
