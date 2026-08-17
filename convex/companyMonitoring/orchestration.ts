import { ConvexError, type Infer, v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import {
  internalMutation,
  mutation,
  type MutationCtx,
} from "../_generated/server";
import { COMPANY_MONITORING_ROLLOUT_FLAGS } from "../config/productCatalog";
import {
  COMPANY_MONITORING_LIMITS,
  normalizeCompanyClaimInput,
  normalizeMonitoredCompanyInput,
} from "../../shared/company-monitoring-contract";
import {
  fingerprint,
  hasCurrentCompanyMonitoringClaimPolicy,
  randomFence,
} from "./_shared";
import {
  companyMonitoringFinalizeResultValidator,
  companyMonitoringExaIngestionValidator,
  companyMonitoringNonReassuringReasonValidator,
  companyMonitoringProviderErrorReasonValidator,
  companyMonitoringScanSourceValidator,
  companyMonitoringXIngestionValidator,
} from "./validators";
import {
  ingestCompanyEvidenceForCompanyIds,
  purgeAccountCandidatesBatch,
  purgeAccountEvidenceBatch,
  setAllCompanyProviderEvidenceState,
  setCompanyEvidenceStateForProviderLocators,
} from "./evidence";
import {
  claimNextAdmissionCandidateHandler,
  recordAdmissionDecisionHandler,
  recordAdmissionTransportFailureHandler,
} from "./admission";
import {
  COMPANY_MONITORING_EVIDENCE_POLICY,
  type ProviderEvidence,
} from "../../shared/company-monitoring-evidence";

type Source = Infer<typeof companyMonitoringScanSourceValidator>;
type FinalizeResult = Infer<typeof companyMonitoringFinalizeResultValidator>;
type NonReassuringReason = Infer<typeof companyMonitoringNonReassuringReasonValidator>;
type ProviderErrorReason = Infer<typeof companyMonitoringProviderErrorReasonValidator>;
type ExaIngestion = Infer<typeof companyMonitoringExaIngestionValidator>;
type XIngestion = Infer<typeof companyMonitoringXIngestionValidator>;
type Work = Doc<"companyMonitoringScanWorkItems">;
type Obligation = Doc<"companyMonitoringScanObligations">;
type XPostAlias = Pick<
  Doc<"companyMonitoringXPostAliases">,
  | "_id"
  | "ownerAccountId"
  | "companyId"
  | "postId"
  | "canonicalPostId"
  | "authorAccountId"
  | "createdAt"
  | "updatedAt"
>;
type NormalizedXPostInput = Pick<
  Doc<"companyMonitoringXEvidence">,
  | "companyId"
  | "authorAccountId"
  | "currentHandle"
  | "createdAt"
  | "observedAt"
  | "contentState"
  | "storageState"
  | "text"
> & { canonicalPostId: string };

const ACCOUNT_DUE_PAGE_SIZE = 32;
const ACCOUNT_WORK_PAGE_SIZE = 8;
export const COMPANY_MONITORING_SCAN_COHORT_LIMIT = 25;
const SCAN_PURGE_WORK_BATCH_SIZE = 8;
const SCAN_PURGE_OBLIGATION_BATCH_SIZE = 16;
const SCAN_PURGE_RECEIPT_LINK_BATCH_SIZE = 16;
const X_PURGE_IDENTITY_BATCH_SIZE = 8;
const X_PURGE_EVIDENCE_BATCH_SIZE = 16;
const LEASE_MS = 5 * 60 * 1000;
const WINDOW_MS = 24 * 60 * 60 * 1000;
const WINDOW_BUCKET_MS = 60 * 60 * 1000;
const MAX_CHECKPOINT_BYTES = 512;
const MAX_COST_USD_MICROS = 1_000_000_000_000;
const WORKER_ID = /^[A-Za-z0-9._:-]{1,64}$/;
const X_ACCOUNT_ID = /^[1-9]\d{1,18}$/;
const X_HANDLE = /^[A-Za-z0-9_]{1,15}$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const X_PACK_QUERY = /^\(from:[A-Za-z0-9_]{1,15}(?: OR from:[A-Za-z0-9_]{1,15})*\) -is:retweet$/;
const MAX_X_PACKS = 25;
const MAX_X_POSTS = 100;
const MAX_X_EDIT_HISTORY_POST_IDS = 10;
const X_PURGE_POST_ALIAS_BATCH_SIZE =
  X_PURGE_EVIDENCE_BATCH_SIZE * MAX_X_EDIT_HISTORY_POST_IDS;
const MAX_X_IDENTITIES = COMPANY_MONITORING_SCAN_COHORT_LIMIT;
const MAX_X_UNEXPECTED_AUTHORS = 100;
const MAX_X_TEXT_BYTES = 32 * 1024;
const MAX_EXA_PROVIDER_ID_BYTES = 512;
const MAX_EXA_REQUEST_ID_BYTES = 512;
const MAX_EXA_URL_BYTES = 2_048;
const MAX_EXA_TITLE_BYTES = 512;
const MAX_EXA_AUTHOR_BYTES = 256;
const X_IDENTITY_CLOCK_SKEW_MS = 30 * 1000;
const EXA_RETRIEVAL_CLOCK_SKEW_MS = 30 * 1000;
const X_TRACKED_POSTS_PER_COMPANY = Math.max(
  1,
  Math.floor(MAX_X_POSTS / COMPANY_MONITORING_SCAN_COHORT_LIMIT),
);

const QUERY_VERSION: Record<Source, string> = {
  exa: "exa-company-discovery-v1",
  x: "x-company-discovery-v1",
};

// Provider limits are Convex-owned. A worker receives the selected value in a
// lease and cannot raise it in claim or finalize arguments.
const RESULT_CAP: Record<Source, number> = { exa: 25, x: 100 };
const EXA_DISCOVERY_CLAIM_LIMIT_PER_COMPANY = 12;
const EXA_DISCOVERY_CLAIM_TYPES = new Set([
  "alias",
  "domain",
  "legal_identifier",
  "location",
]);
const EXA_DISCOVERY_CLAIM_PRIORITY: Record<string, number> = {
  legal_identifier: 0,
  domain: 1,
  alias: 2,
  location: 3,
};

function workIdentity(work: Work) {
  return {
    workId: work.workId,
    workKey: work.workKey,
    ownerAccountId: work.ownerAccountId,
    cohortKey: work.cohortKey,
    source: work.source,
    windowStart: work.windowStart,
    windowEnd: work.windowEnd,
    queryVersion: work.queryVersion,
    scheduledDueAt: work.scheduledDueAt,
    selectionDueAt: work.selectionDueAt,
    resultCap: work.resultCap,
    attemptCount: work.attemptCount,
    createdAt: work.createdAt,
    updatedAt: work.updatedAt,
  };
}

function obligationIdentity(obligation: Obligation) {
  return {
    obligationId: obligation.obligationId,
    ownerAccountId: obligation.ownerAccountId,
    companyId: obligation.companyId,
    source: obligation.source,
    queryVersion: obligation.queryVersion,
    dueAt: obligation.dueAt,
    checkpoint: obligation.checkpoint,
    createdAt: obligation.createdAt,
    updatedAt: obligation.updatedAt,
  };
}

function scanWindowAt(timestamp: number) {
  const windowEnd = Math.floor(timestamp / WINDOW_BUCKET_MS) * WINDOW_BUCKET_MS;
  return { windowStart: windowEnd - WINDOW_MS, windowEnd };
}

async function scanWorkKey(args: {
  ownerAccountId: string;
  cohortKey: string;
  source: Source;
  windowStart: number;
  windowEnd: number;
  queryVersion: string;
}) {
  return fingerprint({ version: "cm-work-v1", ...args });
}

function normalizeWorkerId(workerId: string): string {
  if (!WORKER_ID.test(workerId)) {
    throw new ConvexError("INVALID_COMPANY_MONITORING_WORKER_ID");
  }
  return workerId;
}

async function timingSafeEqualStrings(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [leftDigest, rightDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const leftBytes = new Uint8Array(leftDigest);
  const rightBytes = new Uint8Array(rightDigest);
  let mismatch = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    mismatch |= leftBytes[index]! ^ rightBytes[index]!;
  }
  return mismatch === 0;
}

async function requireWorkerSecret(secret: string): Promise<void> {
  const expected = process.env.COMPANY_MONITORING_WORKER_SECRET ?? "";
  if (!expected || !(await timingSafeEqualStrings(secret, expected))) {
    throw new ConvexError("COMPANY_MONITORING_WORKER_UNAUTHORIZED");
  }
}

function providerRolloutEnabled(source: Source): boolean {
  const flags: Record<Source, boolean> = {
    exa: COMPANY_MONITORING_ROLLOUT_FLAGS.exaProvider,
    x: COMPANY_MONITORING_ROLLOUT_FLAGS.xProvider,
  };
  return flags[source];
}

function enabledSources(): Source[] {
  return (["exa", "x"] as const).filter(providerRolloutEnabled);
}

function requireProviderClaimPolicy(
  account: Doc<"companyMonitoringAccounts">,
  source: Source,
): void {
  if (
    providerRolloutEnabled(source) &&
    !hasCurrentCompanyMonitoringClaimPolicy(account)
  ) {
    throw new ConvexError("COMPANY_MONITORING_CLAIM_POLICY_MIGRATION_REQUIRED");
  }
}

async function updateAccountDueFromWork(ctx: MutationCtx, ownerAccountId: string) {
  const account = await ctx.db
    .query("companyMonitoringAccounts")
    .withIndex("by_logicalAccountId", (q) => q.eq("logicalAccountId", ownerAccountId))
    .unique();
  if (!account) return;
  const nextForSource = async (source: Source) => {
    const [due, leased] = await Promise.all([
      ctx.db
        .query("companyMonitoringScanWorkItems")
        .withIndex("by_account_source_state_selectionDueAt", (q) =>
          q.eq("ownerAccountId", ownerAccountId).eq("source", source).eq("state", "due"),
        )
        .first(),
      ctx.db
        .query("companyMonitoringScanWorkItems")
        .withIndex("by_account_source_state_selectionDueAt", (q) =>
          q.eq("ownerAccountId", ownerAccountId).eq("source", source).eq("state", "leased"),
        )
        .first(),
    ]);
    if (due && leased) return Math.min(due.selectionDueAt, leased.selectionDueAt);
    return due?.selectionDueAt ?? leased?.selectionDueAt;
  };
  const [nextExaScanDueAt, nextXScanDueAt] = await Promise.all([
    nextForSource("exa"),
    nextForSource("x"),
  ]);
  await ctx.db.patch(account._id, {
    nextExaScanDueAt,
    nextXScanDueAt,
    updatedAt: Date.now(),
  });
}

async function scheduleAccountWorkHandler(
  ctx: MutationCtx,
  args: { ownerAccountId: string; source: Source; companyIds: string[] },
  mode: "strict" | "missing_only" = "strict",
) {
  const now = Date.now();
  const account = await ctx.db
    .query("companyMonitoringAccounts")
    .withIndex("by_logicalAccountId", (q) => q.eq("logicalAccountId", args.ownerAccountId))
    .unique();
  if (!account || account.lifecycle !== "entitled" || account.terminalReason) {
    throw new ConvexError("COMPANY_MONITORING_ACCOUNT_INACTIVE");
  }
  requireProviderClaimPolicy(account, args.source);

  const requestedCompanyIds = [...new Set(args.companyIds)].sort();
  if (
    requestedCompanyIds.length === 0 ||
    requestedCompanyIds.length > COMPANY_MONITORING_SCAN_COHORT_LIMIT
  ) {
    throw new ConvexError("INVALID_COMPANY_MONITORING_COHORT");
  }

  const rows = await Promise.all(requestedCompanyIds.map(async (companyId) => {
    const [company, obligation] = await Promise.all([
      ctx.db
        .query("companyMonitoringCompanies")
        .withIndex("by_account_companyId", (q) =>
          q.eq("ownerAccountId", args.ownerAccountId).eq("companyId", companyId),
        )
        .unique(),
      ctx.db
        .query("companyMonitoringScanObligations")
        .withIndex("by_account_company_source", (q) =>
          q
            .eq("ownerAccountId", args.ownerAccountId)
            .eq("companyId", companyId)
            .eq("source", args.source),
        )
        .unique(),
    ]);
    return { companyId, company, obligation };
  }));

  if (
    mode === "strict" &&
    rows.some(({ company }) => !company || company.lifecycle !== "active")
  ) {
    throw new ConvexError("COMPANY_MONITORING_COMPANY_NOT_ACTIVE");
  }
  const selectedRows = mode === "strict"
    ? rows
    : rows.filter(({ company, obligation }) =>
      company?.lifecycle === "active" &&
      (!obligation || obligation.state === "cancelled")
    );
  if (selectedRows.length === 0) return { status: "replayed" as const };
  const companyIds = selectedRows.map(({ companyId }) => companyId);

  const { windowStart, windowEnd } = scanWindowAt(now);
  const queryVersion = QUERY_VERSION[args.source];
  const cohortKey = await fingerprint({ version: "cm-cohort-v1", companyIds });
  let workKey = await scanWorkKey({
    ownerAccountId: args.ownerAccountId,
    cohortKey,
    source: args.source,
    windowStart,
    windowEnd,
    queryVersion,
  });
  for (const { obligation } of selectedRows) {
    if (obligation && (obligation.state === "due" || obligation.state === "leased")) {
      throw new ConvexError("COMPANY_MONITORING_OBLIGATION_ALREADY_ACTIVE");
    }
  }

  const priorWorkIds = new Set<string>();
  for (const { obligation } of selectedRows) {
    if (obligation?.workId) priorWorkIds.add(obligation.workId);
  }

  let existing = await ctx.db
    .query("companyMonitoringScanWorkItems")
    .withIndex("by_workKey", (q) => q.eq("workKey", workKey))
    .unique();
  if (
    mode === "missing_only" &&
    existing &&
    (existing.state === "complete" || existing.state === "non_reassuring")
  ) {
    // The hourly key is also the immutable identity of the terminal receipt.
    // A same-hour lifecycle change must preserve that receipt while creating
    // a new scheduled occurrence for the cancelled obligation.
    workKey = await fingerprint({
      version: "cm-lifecycle-reschedule-v1",
      originalWorkKey: workKey,
      supersededWorkIds: [...priorWorkIds].sort(),
    });
    existing = await ctx.db
      .query("companyMonitoringScanWorkItems")
      .withIndex("by_workKey", (q) => q.eq("workKey", workKey))
      .unique();
  }
  if (existing && existing.state !== "cancelled") {
    await updateAccountDueFromWork(ctx, args.ownerAccountId);
    return { status: "replayed" as const, workId: existing.workId };
  }

  const workId = existing?.workId ?? `cm_work_${workKey.slice(0, 40)}`;
  priorWorkIds.delete(workId);

  const dueWork = {
    workId,
    workKey,
    ownerAccountId: args.ownerAccountId,
    cohortKey,
    source: args.source,
    windowStart,
    windowEnd,
    queryVersion,
    scheduledDueAt: now,
    selectionDueAt: now,
    resultCap: RESULT_CAP[args.source],
    attemptCount: existing?.attemptCount ?? 0,
    state: "due" as const,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  if (existing) await ctx.db.replace(existing._id, dueWork);
  else await ctx.db.insert("companyMonitoringScanWorkItems", dueWork);

  for (const { companyId, obligation } of selectedRows) {
    if (obligation) {
      await ctx.db.replace(obligation._id, {
        ...obligationIdentity(obligation),
        queryVersion,
        dueAt: now,
        state: "due",
        workId,
        updatedAt: now,
      });
    } else {
      const obligationHash = await fingerprint({
        version: "cm-obligation-v1",
        ownerAccountId: args.ownerAccountId,
        companyId,
        source: args.source,
      });
      await ctx.db.insert("companyMonitoringScanObligations", {
        obligationId: `cm_obligation_${obligationHash.slice(0, 40)}`,
        ownerAccountId: args.ownerAccountId,
        companyId,
        source: args.source,
        queryVersion,
        dueAt: now,
        state: "due",
        workId,
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  // Re-scheduling after a cohort cancellation moves every surviving
  // obligation to fresh work. Remove only unreferenced cancelled work. A
  // terminal work row is an immutable receipt and remains available for audit
  // and same-lease replay after its obligations move to the next scan.
  for (const priorWorkId of priorWorkIds) {
    const remaining = await ctx.db
      .query("companyMonitoringScanObligations")
      .withIndex("by_workId", (q) => q.eq("workId", priorWorkId))
      .first();
    if (remaining) continue;
    const priorWork = await ctx.db
      .query("companyMonitoringScanWorkItems")
      .withIndex("by_workId", (q) => q.eq("workId", priorWorkId))
      .unique();
    if (priorWork?.state === "cancelled") await ctx.db.delete(priorWork._id);
  }

  const sourceDueField = args.source === "exa" ? "nextExaScanDueAt" : "nextXScanDueAt";
  const currentSourceDue = account[sourceDueField];
  await ctx.db.patch(account._id, {
    [sourceDueField]: currentSourceDue === undefined ? now : Math.min(currentSourceDue, now),
    updatedAt: now,
  });
  return { status: "scheduled" as const, workId };
}

/** Queue one bounded mutation that materializes both source obligations. */
export async function queueCompanySources(
  ctx: MutationCtx,
  ownerAccountId: string,
  companyId: string,
) {
  await ctx.scheduler.runAfter(
    0,
    internal.companyMonitoring.orchestration.scheduleCompanySources,
    { ownerAccountId, companyId },
  );
}

async function queueAccountSourceWork(
  ctx: MutationCtx,
  ownerAccountId: string,
  source: Source,
  companyIds: string[],
) {
  await ctx.scheduler.runAfter(
    0,
    internal.companyMonitoring.orchestration.ensureAccountWork,
    { ownerAccountId, source, companyIds },
  );
}

async function activeCompany(
  ctx: MutationCtx,
  ownerAccountId: string,
  companyId: string,
) {
  const company = await ctx.db
    .query("companyMonitoringCompanies")
    .withIndex("by_account_companyId", (q) =>
      q.eq("ownerAccountId", ownerAccountId).eq("companyId", companyId),
    )
    .unique();
  return company?.lifecycle === "active" ? company : null;
}

/**
 * Fence every active cohort that contains this company. Surviving peers keep
 * cancelled obligations until a trusted queued mutation moves them to fresh
 * server-shaped work, so no peer can disappear between cancellation and
 * re-scheduling.
 */
export async function cancelCompanyScanWork(
  ctx: MutationCtx,
  args: {
    ownerAccountId: string;
    companyId: string;
    reason: "company_removed" | "superseded";
  },
) {
  const companyObligations = await ctx.db
    .query("companyMonitoringScanObligations")
    .withIndex("by_account_company_source", (q) =>
      q.eq("ownerAccountId", args.ownerAccountId).eq("companyId", args.companyId),
    )
    .take(3);
  if (companyObligations.length > 2) {
    throw new ConvexError("COMPANY_MONITORING_COMPANY_OBLIGATIONS_INVALID");
  }

  const now = Date.now();
  const handledWorkIds = new Set<string>();
  const peerCandidates: Record<Source, Set<string>> = {
    exa: new Set<string>(),
    x: new Set<string>(),
  };
  for (const companyObligation of companyObligations) {
    if (!companyObligation.workId || handledWorkIds.has(companyObligation.workId)) continue;
    handledWorkIds.add(companyObligation.workId);
    const work = await ctx.db
      .query("companyMonitoringScanWorkItems")
      .withIndex("by_workId", (q) => q.eq("workId", companyObligation.workId!))
      .unique();
    if (!work || (work.state !== "due" && work.state !== "leased")) continue;

    const cohortObligations = await ctx.db
      .query("companyMonitoringScanObligations")
      .withIndex("by_workId", (q) => q.eq("workId", work.workId))
      .take(COMPANY_MONITORING_SCAN_COHORT_LIMIT + 1);
    if (cohortObligations.length > COMPANY_MONITORING_SCAN_COHORT_LIMIT) {
      throw new ConvexError("COMPANY_MONITORING_WORK_OBLIGATIONS_INVALID");
    }
    await ctx.db.replace(work._id, {
      ...workIdentity(work),
      state: "cancelled",
      cancelledAt: now,
      cancelReason: args.reason,
      updatedAt: now,
    });
    for (const obligation of cohortObligations) {
      if (obligation.state !== "due" && obligation.state !== "leased") continue;
      const isTarget = obligation.companyId === args.companyId;
      await ctx.db.replace(obligation._id, {
        ...obligationIdentity(obligation),
        state: "cancelled",
        workId: work.workId,
        cancelledAt: now,
        reason: isTarget ? args.reason : "superseded",
        updatedAt: now,
      });
      if (!isTarget) peerCandidates[work.source].add(obligation.companyId);
    }
  }

  const requeuedPeers = new Set<string>();
  for (const source of ["exa", "x"] as const) {
    const candidates = [...peerCandidates[source]].sort();
    const activePeers = (await Promise.all(candidates.map(async (companyId) => ({
      companyId,
      active: Boolean(await activeCompany(ctx, args.ownerAccountId, companyId)),
    })))).filter(({ active }) => active).map(({ companyId }) => companyId);
    for (
      let offset = 0;
      offset < activePeers.length;
      offset += COMPANY_MONITORING_SCAN_COHORT_LIMIT
    ) {
      const cohort = activePeers.slice(
        offset,
        offset + COMPANY_MONITORING_SCAN_COHORT_LIMIT,
      );
      await queueAccountSourceWork(ctx, args.ownerAccountId, source, cohort);
      for (const companyId of cohort) requeuedPeers.add(companyId);
    }
  }
  await updateAccountDueFromWork(ctx, args.ownerAccountId);
  return { cancelledWork: handledWorkIds.size, requeuedPeers: requeuedPeers.size };
}

async function deleteTerminalReceiptLink(
  ctx: MutationCtx,
  link: Doc<"companyMonitoringScanReceiptLinks">,
) {
  await ctx.db.delete(link._id);
  const [remainingLink, remainingObligation] = await Promise.all([
    ctx.db
      .query("companyMonitoringScanReceiptLinks")
      .withIndex("by_workId", (q) => q.eq("workId", link.workId))
      .first(),
    ctx.db
      .query("companyMonitoringScanObligations")
      .withIndex("by_workId", (q) => q.eq("workId", link.workId))
      .first(),
  ]);
  if (remainingLink || remainingObligation) return;
  const work = await ctx.db
    .query("companyMonitoringScanWorkItems")
    .withIndex("by_workId", (q) => q.eq("workId", link.workId))
    .unique();
  if (work && (work.state === "complete" || work.state === "non_reassuring")) {
    await ctx.db.delete(work._id);
  }
}

/** Delete one bounded page of scan state associated with a removed company. */
export async function purgeCompanyScanStateBatch(
  ctx: MutationCtx,
  ownerAccountId: string,
  companyId: string,
) {
  const page = await ctx.db
    .query("companyMonitoringScanObligations")
    .withIndex("by_account_company_source", (q) =>
      q.eq("ownerAccountId", ownerAccountId).eq("companyId", companyId),
    )
    .take(SCAN_PURGE_OBLIGATION_BATCH_SIZE + 1);
  const batch = page.slice(0, SCAN_PURGE_OBLIGATION_BATCH_SIZE);
  for (const obligation of batch) {
    const workId = obligation.workId;
    await ctx.db.delete(obligation._id);
    if (!workId) continue;
    const remaining = await ctx.db
      .query("companyMonitoringScanObligations")
      .withIndex("by_workId", (q) => q.eq("workId", workId))
      .first();
    if (remaining) continue;
    const receiptLink = await ctx.db
      .query("companyMonitoringScanReceiptLinks")
      .withIndex("by_workId", (q) => q.eq("workId", workId))
      .first();
    if (receiptLink) continue;
    const work = await ctx.db
      .query("companyMonitoringScanWorkItems")
      .withIndex("by_workId", (q) => q.eq("workId", workId))
      .unique();
    if (work) await ctx.db.delete(work._id);
  }
  const receiptLinkPage = await ctx.db
    .query("companyMonitoringScanReceiptLinks")
    .withIndex("by_account_company", (q) =>
      q.eq("ownerAccountId", ownerAccountId).eq("companyId", companyId),
    )
    .take(SCAN_PURGE_RECEIPT_LINK_BATCH_SIZE + 1);
  for (const link of receiptLinkPage.slice(0, SCAN_PURGE_RECEIPT_LINK_BATCH_SIZE)) {
    await deleteTerminalReceiptLink(ctx, link);
  }
  const identityPage = await ctx.db
    .query("companyMonitoringXIdentities")
    .withIndex("by_account_company", (q) =>
      q.eq("ownerAccountId", ownerAccountId).eq("companyId", companyId),
    )
    .take(X_PURGE_IDENTITY_BATCH_SIZE + 1);
  for (const identity of identityPage.slice(0, X_PURGE_IDENTITY_BATCH_SIZE)) {
    await ctx.db.delete(identity._id);
  }
  const evidencePage = await ctx.db
    .query("companyMonitoringXEvidence")
    .withIndex("by_account_company", (q) =>
      q.eq("ownerAccountId", ownerAccountId).eq("companyId", companyId),
    )
    .take(X_PURGE_EVIDENCE_BATCH_SIZE + 1);
  for (const evidence of evidencePage.slice(0, X_PURGE_EVIDENCE_BATCH_SIZE)) {
    await ctx.db.delete(evidence._id);
  }
  const postAliasPage = await ctx.db
    .query("companyMonitoringXPostAliases")
    .withIndex("by_account_company", (q) =>
      q.eq("ownerAccountId", ownerAccountId).eq("companyId", companyId),
    )
    .take(X_PURGE_POST_ALIAS_BATCH_SIZE + 1);
  for (const alias of postAliasPage.slice(0, X_PURGE_POST_ALIAS_BATCH_SIZE)) {
    await ctx.db.delete(alias._id);
  }
  await updateAccountDueFromWork(ctx, ownerAccountId);
  return {
    complete:
      page.length <= SCAN_PURGE_OBLIGATION_BATCH_SIZE &&
      receiptLinkPage.length <= SCAN_PURGE_RECEIPT_LINK_BATCH_SIZE &&
      identityPage.length <= X_PURGE_IDENTITY_BATCH_SIZE &&
      evidencePage.length <= X_PURGE_EVIDENCE_BATCH_SIZE &&
      postAliasPage.length <= X_PURGE_POST_ALIAS_BATCH_SIZE,
  };
}

/** Delete one bounded, account-leading page during destructive account purge. */
export async function purgeAccountScanStateBatch(
  ctx: MutationCtx,
  ownerAccountId: string,
) {
  const states = ["due", "leased", "complete", "non_reassuring", "cancelled"] as const;
  const works: Work[] = [];
  for (const state of states) {
    const remaining = SCAN_PURGE_WORK_BATCH_SIZE + 1 - works.length;
    if (remaining <= 0) break;
    works.push(...await ctx.db
      .query("companyMonitoringScanWorkItems")
      .withIndex("by_account_state_selectionDueAt", (q) =>
        q.eq("ownerAccountId", ownerAccountId).eq("state", state),
      )
      .take(remaining));
  }
  const workBatch = works.slice(0, SCAN_PURGE_WORK_BATCH_SIZE);
  for (const work of workBatch) {
    const obligations = await ctx.db
      .query("companyMonitoringScanObligations")
      .withIndex("by_workId", (q) => q.eq("workId", work.workId))
      .take(COMPANY_MONITORING_SCAN_COHORT_LIMIT + 1);
    if (obligations.length > COMPANY_MONITORING_SCAN_COHORT_LIMIT) {
      throw new ConvexError("COMPANY_MONITORING_WORK_OBLIGATIONS_INVALID");
    }
    const receiptLinks = await ctx.db
      .query("companyMonitoringScanReceiptLinks")
      .withIndex("by_workId", (q) => q.eq("workId", work.workId))
      .take(COMPANY_MONITORING_SCAN_COHORT_LIMIT + 1);
    if (receiptLinks.length > COMPANY_MONITORING_SCAN_COHORT_LIMIT) {
      throw new ConvexError("COMPANY_MONITORING_WORK_RECEIPT_LINKS_INVALID");
    }
    for (const obligation of obligations) await ctx.db.delete(obligation._id);
    for (const link of receiptLinks) await ctx.db.delete(link._id);
    await ctx.db.delete(work._id);
  }
  if (works.length > SCAN_PURGE_WORK_BATCH_SIZE) {
    await updateAccountDueFromWork(ctx, ownerAccountId);
    return { complete: false };
  }

  const obligationPage = await ctx.db
    .query("companyMonitoringScanObligations")
    .withIndex("by_account_company_source", (q) => q.eq("ownerAccountId", ownerAccountId))
    .take(SCAN_PURGE_OBLIGATION_BATCH_SIZE + 1);
  for (const obligation of obligationPage.slice(0, SCAN_PURGE_OBLIGATION_BATCH_SIZE)) {
    await ctx.db.delete(obligation._id);
  }
  const receiptLinkPage = await ctx.db
    .query("companyMonitoringScanReceiptLinks")
    .withIndex("by_account_company", (q) => q.eq("ownerAccountId", ownerAccountId))
    .take(SCAN_PURGE_RECEIPT_LINK_BATCH_SIZE + 1);
  for (const link of receiptLinkPage.slice(0, SCAN_PURGE_RECEIPT_LINK_BATCH_SIZE)) {
    await deleteTerminalReceiptLink(ctx, link);
  }
  const identityPage = await ctx.db
    .query("companyMonitoringXIdentities")
    .withIndex("by_account_company", (q) => q.eq("ownerAccountId", ownerAccountId))
    .take(X_PURGE_IDENTITY_BATCH_SIZE + 1);
  for (const identity of identityPage.slice(0, X_PURGE_IDENTITY_BATCH_SIZE)) {
    await ctx.db.delete(identity._id);
  }
  const evidencePage = await ctx.db
    .query("companyMonitoringXEvidence")
    .withIndex("by_account_company", (q) => q.eq("ownerAccountId", ownerAccountId))
    .take(X_PURGE_EVIDENCE_BATCH_SIZE + 1);
  for (const evidence of evidencePage.slice(0, X_PURGE_EVIDENCE_BATCH_SIZE)) {
    await ctx.db.delete(evidence._id);
  }
  const postAliasPage = await ctx.db
    .query("companyMonitoringXPostAliases")
    .withIndex("by_account_company", (q) => q.eq("ownerAccountId", ownerAccountId))
    .take(X_PURGE_POST_ALIAS_BATCH_SIZE + 1);
  for (const alias of postAliasPage.slice(0, X_PURGE_POST_ALIAS_BATCH_SIZE)) {
    await ctx.db.delete(alias._id);
  }
  const normalizedEvidence = await purgeAccountEvidenceBatch(ctx, ownerAccountId);
  const normalizedCandidates = await purgeAccountCandidatesBatch(ctx, ownerAccountId);
  await updateAccountDueFromWork(ctx, ownerAccountId);
  return {
    complete:
      obligationPage.length <= SCAN_PURGE_OBLIGATION_BATCH_SIZE &&
      receiptLinkPage.length <= SCAN_PURGE_RECEIPT_LINK_BATCH_SIZE &&
      identityPage.length <= X_PURGE_IDENTITY_BATCH_SIZE &&
      evidencePage.length <= X_PURGE_EVIDENCE_BATCH_SIZE &&
      postAliasPage.length <= X_PURGE_POST_ALIAS_BATCH_SIZE &&
      normalizedEvidence.complete &&
      normalizedCandidates.complete,
  };
}

async function dueWorkForAccount(
  ctx: MutationCtx,
  ownerAccountId: string,
  now: number,
  source: Source,
) {
  for (const state of ["leased", "due"] as const) {
    const page = await ctx.db
      .query("companyMonitoringScanWorkItems")
      .withIndex("by_account_source_state_selectionDueAt", (q) =>
        q
          .eq("ownerAccountId", ownerAccountId)
          .eq("source", source)
          .eq("state", state)
          .lte("selectionDueAt", now),
      )
      .take(ACCOUNT_WORK_PAGE_SIZE);
    const work = page[0];
    if (work && (work.state === "due" || work.state === "leased")) return work;
  }
  return null;
}

function xIdentityForWorker(identity: Doc<"companyMonitoringXIdentities">) {
  return {
    companyId: identity.companyId,
    domainClaimId: identity.domainClaimId,
    xHandleClaimId: identity.xHandleClaimId,
    officialDomain: identity.officialDomain,
    officialPageUrl: identity.officialPageUrl,
    accountId: identity.accountId,
    currentHandle: identity.currentHandle,
    profileName: identity.profileName,
    domicileCountry: identity.domicileCountry,
    authorityRole: identity.authorityRole,
    state: identity.state,
    ...(identity.demotionReason ? { demotionReason: identity.demotionReason } : {}),
    badgeVerified: identity.badgeVerified,
    allowedUses: identity.allowedUses,
    checkedAt: identity.checkedAt,
    expiresAt: identity.expiresAt,
    evidenceHash: identity.evidenceHash,
  };
}

const X_RECONCILABLE_CONTENT_STATES = [
  "active",
  "edited",
  "protected",
  "withheld",
  "deleted",
] as const;

async function xEvidenceForReconciliation(
  ctx: MutationCtx,
  ownerAccountId: string,
  companyId: string,
) {
  const pages = await Promise.all(X_RECONCILABLE_CONTENT_STATES.map((contentState) =>
    ctx.db
      .query("companyMonitoringXEvidence")
      .withIndex("by_account_company_contentState_lastReconciledAt", (q) =>
        q
          .eq("ownerAccountId", ownerAccountId)
          .eq("companyId", companyId)
          .eq("contentState", contentState),
      )
      .order("asc")
      .take(X_TRACKED_POSTS_PER_COMPANY)
  ));
  return pages
    .flat()
    .sort((left, right) =>
      (left.lastReconciledAt ?? Number.MIN_SAFE_INTEGER) -
        (right.lastReconciledAt ?? Number.MIN_SAFE_INTEGER) ||
      left.postId.localeCompare(right.postId)
    )
    .slice(0, X_TRACKED_POSTS_PER_COMPANY);
}

async function xSubjectsForClaim(
  ctx: MutationCtx,
  ownerAccountId: string,
  obligations: Obligation[],
  now: number,
) {
  return Promise.all([...obligations]
    .sort((left, right) => left.companyId.localeCompare(right.companyId))
    .map(async (obligation) => {
      const [company, claimPage, storedIdentity, reconciliationEvidence] = await Promise.all([
        ctx.db
          .query("companyMonitoringCompanies")
          .withIndex("by_account_companyId", (q) =>
            q.eq("ownerAccountId", ownerAccountId).eq("companyId", obligation.companyId),
          )
          .unique(),
        ctx.db
          .query("companyMonitoringClaims")
          .withIndex("by_account_company", (q) =>
            q.eq("ownerAccountId", ownerAccountId).eq("companyId", obligation.companyId),
          )
          .take(101),
        ctx.db
          .query("companyMonitoringXIdentities")
          .withIndex("by_account_company", (q) =>
            q.eq("ownerAccountId", ownerAccountId).eq("companyId", obligation.companyId),
          )
          .unique(),
        xEvidenceForReconciliation(ctx, ownerAccountId, obligation.companyId),
      ]);
      if (!company || company.lifecycle !== "active" || !company.name || !company.domicileCountry) {
        throw new ConvexError("COMPANY_MONITORING_X_SUBJECT_INVALID");
      }
      if (claimPage.length > 100) {
        throw new ConvexError("COMPANY_MONITORING_X_SUBJECT_CLAIMS_INVALID");
      }
      let currentIdentity = storedIdentity;
      const boundDomainClaim = storedIdentity
        ? claimPage.find((claim) => claim.claimId === storedIdentity.domainClaimId)
        : undefined;
      const boundHandleClaim = storedIdentity
        ? claimPage.find((claim) => claim.claimId === storedIdentity.xHandleClaimId)
        : undefined;
      const boundClaimsCurrent = Boolean(
        storedIdentity &&
        claimHasIndependentDomainAuthority(boundDomainClaim, now) &&
        normalizedDomain(boundDomainClaim.value) === normalizedDomain(storedIdentity.officialDomain) &&
        boundHandleClaim?.type === "x_handle"
      );
      const demotionReason = storedIdentity?.state === "authoritative"
        ? storedIdentity.expiresAt <= now
          ? "expired" as const
          : !boundClaimsCurrent
            ? "official_link_lost" as const
            : undefined
        : undefined;
      if (storedIdentity && demotionReason) {
        await ctx.db.patch(storedIdentity._id, {
          state: "demoted",
          demotionReason,
          allowedUses: [],
          updatedAt: now,
        });
        currentIdentity = {
          ...storedIdentity,
          state: "demoted",
          demotionReason,
          allowedUses: [],
          updatedAt: now,
        };
        await setAllCompanyProviderEvidenceState(ctx, {
          ownerAccountId,
          companyId: obligation.companyId,
          provider: "x",
          state: "authority_lost",
        });
      }
      const claimValue = (claim: Doc<"companyMonitoringClaims">) => ({
        claimId: claim.claimId,
        value: claim.value,
      });
      return {
        companyId: company.companyId,
        name: company.name,
        domicileCountry: company.domicileCountry,
        domains: claimPage
          .filter((claim) => claimHasIndependentDomainAuthority(claim, now))
          .map(claimValue),
        xHandles: claimPage.filter((claim) => claim.type === "x_handle").map(claimValue),
        trackedPosts: reconciliationEvidence
          .map((evidence) => ({
            postId: evidence.postId,
            authorAccountId: evidence.authorAccountId,
            contentState: evidence.contentState,
            observedAt: evidence.observedAt,
          })),
        ...(currentIdentity ? { currentIdentity: xIdentityForWorker(currentIdentity) } : {}),
      };
    }));
}

async function projectExaCompanyClaims(
  ctx: MutationCtx,
  ownerAccountId: string,
  obligation: Obligation,
) {
  const company = await ctx.db
    .query("companyMonitoringCompanies")
    .withIndex("by_account_companyId", (q) =>
      q.eq("ownerAccountId", ownerAccountId).eq("companyId", obligation.companyId),
    )
    .unique();
  if (
    !company ||
    company.lifecycle !== "active" ||
    !company.name ||
    !company.domicileCountry
  ) {
    throw new ConvexError("COMPANY_MONITORING_WORK_COMPANY_INVALID");
  }
  const normalizedCompany = normalizeMonitoredCompanyInput({
    name: company.name,
    domicileCountry: company.domicileCountry,
  });
  const claimRows = await ctx.db
    .query("companyMonitoringClaims")
    .withIndex("by_account_company", (q) =>
      q.eq("ownerAccountId", ownerAccountId).eq("companyId", obligation.companyId),
    )
    .take(COMPANY_MONITORING_LIMITS.maxClaimsPerCompany + 1);
  if (claimRows.length > COMPANY_MONITORING_LIMITS.maxClaimsPerCompany) {
    throw new ConvexError("COMPANY_MONITORING_WORK_CLAIMS_INVALID");
  }
  const eligibleClaims = claimRows
    .filter((claim) => EXA_DISCOVERY_CLAIM_TYPES.has(claim.type))
    .map((claim) => {
      const normalized = normalizeCompanyClaimInput({ type: claim.type, value: claim.value });
      if (normalized.type !== claim.type || normalized.value !== claim.value) {
        throw new ConvexError("COMPANY_MONITORING_WORK_CLAIMS_INVALID");
      }
      return { claimId: claim.claimId, ...normalized };
    })
    .sort((left, right) =>
      EXA_DISCOVERY_CLAIM_PRIORITY[left.type]! - EXA_DISCOVERY_CLAIM_PRIORITY[right.type]! ||
      left.value.localeCompare(right.value) ||
      left.claimId.localeCompare(right.claimId)
    );
  return {
    companyId: obligation.companyId,
    company: {
      name: normalizedCompany.name,
      domicileCountry: normalizedCompany.domicileCountry,
      claims: eligibleClaims.slice(0, EXA_DISCOVERY_CLAIM_LIMIT_PER_COMPANY),
      claimProjection: {
        available: eligibleClaims.length,
        included: Math.min(eligibleClaims.length, EXA_DISCOVERY_CLAIM_LIMIT_PER_COMPANY),
        omitted: Math.max(0, eligibleClaims.length - EXA_DISCOVERY_CLAIM_LIMIT_PER_COMPANY),
      },
    },
  };
}

async function claimSelectedWork(
  ctx: MutationCtx,
  work: Extract<Work, { state: "due" | "leased" }>,
  workerId: string,
  now: number,
) {
  const leaseToken = randomFence();
  const leaseExpiresAt = now + LEASE_MS;
  const attemptCount = work.attemptCount + 1;
  // A due row can wait while a provider rollout flag is dark. Bind the
  // execution range when a worker actually claims it, not when lifecycle code
  // first scheduled it. The stable work id/key still fence retries of this
  // scheduled occurrence while the persisted range governs finalization.
  const { windowStart, windowEnd } = scanWindowAt(now);
  const obligations = await ctx.db
    .query("companyMonitoringScanObligations")
    .withIndex("by_workId", (q) => q.eq("workId", work.workId))
    .take(COMPANY_MONITORING_SCAN_COHORT_LIMIT + 1);
  if (
    obligations.length === 0 ||
    obligations.length > COMPANY_MONITORING_SCAN_COHORT_LIMIT
  ) {
    throw new ConvexError("COMPANY_MONITORING_WORK_OBLIGATIONS_INVALID");
  }
  for (const obligation of obligations) {
    if (
      obligation.workId !== work.workId ||
      (obligation.state !== "due" && obligation.state !== "leased")
    ) {
      throw new ConvexError("COMPANY_MONITORING_WORK_OBLIGATIONS_INVALID");
    }
  }

  const projectedCompanies = work.source === "exa"
    ? await Promise.all(obligations.map((obligation) =>
      projectExaCompanyClaims(ctx, work.ownerAccountId, obligation)
    ))
    : [];
  const projectedByCompanyId = new Map(projectedCompanies.map((row) => [row.companyId, row.company]));

  await ctx.db.replace(work._id, {
    ...workIdentity(work),
    windowStart,
    windowEnd,
    state: "leased",
    selectionDueAt: leaseExpiresAt,
    attemptCount,
    leaseToken,
    leaseExpiresAt,
    workerId,
    updatedAt: now,
  });
  for (const obligation of obligations) {
    await ctx.db.replace(obligation._id, {
      ...obligationIdentity(obligation),
      state: "leased",
      workId: work.workId,
      leaseToken,
      leaseExpiresAt,
      workerId,
      updatedAt: now,
    });
  }

  const account = await ctx.db
    .query("companyMonitoringAccounts")
    .withIndex("by_logicalAccountId", (q) => q.eq("logicalAccountId", work.ownerAccountId))
    .unique();
  if (!account || account.lifecycle !== "entitled" || account.terminalReason) {
    throw new ConvexError("COMPANY_MONITORING_ACCOUNT_INACTIVE");
  }
  const sourceDueField = work.source === "exa" ? "nextExaScanDueAt" : "nextXScanDueAt";
  await ctx.db.patch(account._id, {
    [sourceDueField]: leaseExpiresAt,
    updatedAt: now,
  });

  const subjects = work.source === "x"
    ? await xSubjectsForClaim(ctx, work.ownerAccountId, obligations, now)
    : undefined;

  return {
    ownerAccountId: work.ownerAccountId,
    workId: work.workId,
    cohortKey: work.cohortKey,
    source: work.source,
    windowStart,
    windowEnd,
    queryVersion: work.queryVersion,
    resultCap: work.resultCap,
    attempt: attemptCount,
    leaseToken,
    leaseExpiresAt,
    obligations: obligations.map((obligation) => ({
      companyId: obligation.companyId,
      ...(obligation.checkpoint ? { checkpoint: obligation.checkpoint } : {}),
      ...(work.source === "exa"
        ? { company: projectedByCompanyId.get(obligation.companyId)! }
        : {}),
    })),
    ...(subjects ? { subjects } : {}),
  };
}

async function rearmNextScan(
  ctx: MutationCtx,
  work: Work,
  obligations: Obligation[],
  now: number,
  checkpointAfter?: string,
) {
  const nextDueAt = now + WINDOW_MS;
  const companyIds = obligations.map((obligation) => obligation.companyId).sort();
  const cohortKey = await fingerprint({ version: "cm-cohort-v1", companyIds });
  const queryVersion = QUERY_VERSION[work.source];
  const { windowStart, windowEnd } = scanWindowAt(nextDueAt);
  // Recurring work keys identify a durable scheduled occurrence. Its window
  // is provisional until claim time, when Convex atomically binds the actual
  // execution range without changing the replay/fencing identity.
  const workKey = await fingerprint({
    version: "cm-recurring-work-v1",
    ownerAccountId: work.ownerAccountId,
    cohortKey,
    source: work.source,
    scheduledDueAt: nextDueAt,
    queryVersion,
  });
  const nextWorkId = `cm_work_${workKey.slice(0, 40)}`;
  const existing = await ctx.db
    .query("companyMonitoringScanWorkItems")
    .withIndex("by_workKey", (q) => q.eq("workKey", workKey))
    .unique();
  if (!existing) {
    await ctx.db.insert("companyMonitoringScanWorkItems", {
      workId: nextWorkId,
      workKey,
      ownerAccountId: work.ownerAccountId,
      cohortKey,
      source: work.source,
      windowStart,
      windowEnd,
      queryVersion,
      scheduledDueAt: nextDueAt,
      selectionDueAt: nextDueAt,
      resultCap: RESULT_CAP[work.source],
      attemptCount: 0,
      state: "due",
      createdAt: now,
      updatedAt: now,
    });
  }

  // Finalization and rearming share one Convex transaction, so a retry sees
  // the terminal work and replays before reaching this point. The guard also
  // makes the helper safe if that invariant is relaxed later.
  const durableNextWorkId = existing?.workId ?? nextWorkId;
  for (const obligation of obligations) {
    if (obligation.workId === durableNextWorkId && obligation.state === "due") continue;
    await ctx.db.replace(obligation._id, {
      ...obligationIdentity(obligation),
      queryVersion,
      dueAt: nextDueAt,
      ...(checkpointAfter ? { checkpoint: checkpointAfter } : {}),
      state: "due",
      workId: durableNextWorkId,
      updatedAt: now,
    });
  }
}

async function linkTerminalReceipt(
  ctx: MutationCtx,
  work: Work,
  obligations: Obligation[],
  now: number,
) {
  for (const obligation of obligations) {
    const existing = await ctx.db
      .query("companyMonitoringScanReceiptLinks")
      .withIndex("by_workId_company", (q) =>
        q.eq("workId", work.workId).eq("companyId", obligation.companyId),
      )
      .unique();
    if (existing) continue;
    await ctx.db.insert("companyMonitoringScanReceiptLinks", {
      ownerAccountId: work.ownerAccountId,
      companyId: obligation.companyId,
      workId: work.workId,
      createdAt: now,
    });
  }
}

async function claimNextWorkHandler(
  ctx: MutationCtx,
  workerIdInput: string,
  sources: readonly Source[],
) {
  const workerId = normalizeWorkerId(workerIdInput);
  const now = Date.now();
  let accountsExamined = 0;
  for (const source of sources) {
    const index = source === "exa"
      ? "by_lifecycle_nextExaScanDueAt" as const
      : "by_lifecycle_nextXScanDueAt" as const;
    const dueField = source === "exa" ? "nextExaScanDueAt" as const : "nextXScanDueAt" as const;
    const accounts = await ctx.db
      .query("companyMonitoringAccounts")
      .withIndex(index, (q) =>
        q
          .eq("lifecycle", "entitled")
          .gte(dueField, 0)
          .lte(dueField, now),
      )
      .take(ACCOUNT_DUE_PAGE_SIZE);

    for (const account of accounts) {
      accountsExamined += 1;
      if (account.terminalReason) continue;
      requireProviderClaimPolicy(account, source);
      const work = await dueWorkForAccount(ctx, account.logicalAccountId, now, source);
      if (!work) {
        await updateAccountDueFromWork(ctx, account.logicalAccountId);
        continue;
      }
      const claimed = await claimSelectedWork(ctx, work, workerId, now);
      return { status: "claimed" as const, accountsExamined, work: claimed };
    }
  }
  return { status: "idle" as const, accountsExamined };
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function validXWindow(
  range: { startAt: number; endAt: number },
  outer: { startAt: number; endAt: number },
): boolean {
  return Number.isSafeInteger(range.startAt) &&
    Number.isSafeInteger(range.endAt) &&
    range.startAt < range.endAt &&
    range.startAt >= outer.startAt &&
    range.endAt <= outer.endAt;
}

function normalizedDomain(value: string): string {
  return value.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
}

function claimHasIndependentDomainAuthority(
  claim: Doc<"companyMonitoringClaims"> | undefined,
  now: number,
): claim is Doc<"companyMonitoringClaims"> {
  return Boolean(
    claim?.type === "domain" &&
    claim.provenance === "independent_provider" &&
    claim.trustState === "verified" &&
    claim.allowedUses?.includes("attribution") &&
    Number.isSafeInteger(claim.expiresAt) &&
    claim.expiresAt! > now,
  );
}

function officialUrlMatchesDomain(rawUrl: string, domain: string): boolean {
  try {
    const url = new URL(rawUrl);
    const hostname = normalizedDomain(url.hostname);
    const expected = normalizedDomain(domain);
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      (!url.port || url.port === "443") &&
      (hostname === expected || hostname.endsWith(`.${expected}`));
  } catch {
    return false;
  }
}

function validXIdentityObservation(
  identity: XIngestion["identities"][number],
  work: Extract<Work, { state: "leased" }>,
  now: number,
) {
  const allowedUses = new Set(identity.allowedUses);
  if (
    !X_ACCOUNT_ID.test(identity.accountId) ||
    !X_HANDLE.test(identity.currentHandle) ||
    !SHA256_HEX.test(identity.evidenceHash) ||
    !Number.isSafeInteger(identity.checkedAt) ||
    !Number.isSafeInteger(identity.expiresAt) ||
    identity.checkedAt < work.updatedAt - X_IDENTITY_CLOCK_SKEW_MS ||
    identity.checkedAt > work.leaseExpiresAt ||
    identity.checkedAt > now + X_IDENTITY_CLOCK_SKEW_MS ||
    identity.expiresAt <= identity.checkedAt ||
    !officialUrlMatchesDomain(identity.officialPageUrl, identity.officialDomain) ||
    allowedUses.size !== identity.allowedUses.length
  ) return false;
  if (identity.state === "authoritative") {
    return identity.demotionReason === undefined &&
      identity.authorityRole !== "unknown" &&
      identity.allowedUses.length > 0;
  }
  return identity.demotionReason !== undefined && identity.allowedUses.length === 0;
}

function validXPostObservation(
  post: XIngestion["posts"][number],
  permittedStorage: XIngestion["permittedStorage"],
) {
  if (
    !X_ACCOUNT_ID.test(post.postId) ||
    !X_ACCOUNT_ID.test(post.authorAccountId) ||
    !X_HANDLE.test(post.currentHandle) ||
    !Number.isSafeInteger(post.createdAt) ||
    !Number.isSafeInteger(post.observedAt) ||
    post.observedAt < post.createdAt ||
    post.editHistoryPostIds.length === 0 ||
    post.editHistoryPostIds.length > MAX_X_EDIT_HISTORY_POST_IDS ||
    post.editHistoryPostIds.some((id) => !X_ACCOUNT_ID.test(id)) ||
    new Set(post.editHistoryPostIds).size !== post.editHistoryPostIds.length
  ) return false;
  const mayHaveText = permittedStorage === "full_text" &&
    (post.contentState === "active" || post.contentState === "edited");
  if (post.storageState === "full_text") {
    return mayHaveText &&
      typeof post.text === "string" &&
      post.text.length > 0 &&
      byteLength(post.text) <= MAX_X_TEXT_BYTES &&
      post.withheldCountryCodes === undefined;
  }
  if (post.text !== undefined) return false;
  if (post.contentState === "deleted") return post.storageState === "tombstone";
  if (post.storageState !== "metadata_only") return false;
  if (post.contentState === "withheld") {
    return Boolean(
      post.withheldCountryCodes?.length &&
      post.withheldCountryCodes.every((code) => /^[A-Z]{2}$/.test(code)),
    );
  }
  return post.withheldCountryCodes === undefined;
}

function validXPacking(
  packing: XIngestion["packing"],
  companyIds: Set<string>,
) {
  if (packing.length > MAX_X_PACKS) return false;
  const seenPackIds = new Set<string>();
  for (const pack of packing) {
    const itemCount = pack.companyIds.length;
    if (
      !SHA256_HEX.test(pack.packId) ||
      seenPackIds.has(pack.packId) ||
      itemCount === 0 ||
      itemCount > COMPANY_MONITORING_SCAN_COHORT_LIMIT ||
      pack.accountIds.length !== itemCount ||
      pack.handles.length !== itemCount ||
      pack.companyIds.some((companyId) => !companyIds.has(companyId)) ||
      pack.accountIds.some((accountId) => !X_ACCOUNT_ID.test(accountId)) ||
      pack.handles.some((handle) => !X_HANDLE.test(handle)) ||
      !X_PACK_QUERY.test(pack.query) ||
      byteLength(pack.query) > 512 ||
      pack.query !== `(${pack.handles.map((handle) => `from:${handle}`).join(" OR ")}) -is:retweet`
    ) return false;
    seenPackIds.add(pack.packId);
  }
  return true;
}

async function validXIngestionForWork(
  ctx: MutationCtx,
  result: FinalizeResult,
  work: Extract<Work, { state: "leased" }>,
  obligations: Obligation[],
  now: number,
): Promise<{ valid: boolean; payload?: XIngestion }> {
  if (result.type === "provider_error") return { valid: true };
  if (work.source !== "x") return { valid: result.xIngestion === undefined };
  const payload = result.xIngestion;
  if (!payload) return { valid: false };
  const outer = { startAt: work.windowStart, endAt: work.windowEnd };
  const companyIds = new Set(obligations.map((obligation) => obligation.companyId));
  if (
    payload.requestedWindow.startAt !== work.windowStart ||
    payload.requestedWindow.endAt !== work.windowEnd ||
    !validXWindow(payload.returnedWindow, outer) ||
    payload.checkpoints.length !== obligations.length ||
    payload.identities.length > MAX_X_IDENTITIES ||
    payload.posts.length > MAX_X_POSTS ||
    payload.posts.length !== result.itemCount ||
    payload.unexpectedAuthorAccountIds.length > MAX_X_UNEXPECTED_AUTHORS ||
    payload.unexpectedAuthorAccountIds.some((id) => !X_ACCOUNT_ID.test(id)) ||
    !Number.isSafeInteger(payload.requestCount) ||
    payload.requestCount < payload.packing.length ||
    payload.requestCount > 100 ||
    !Number.isSafeInteger(payload.complianceEventCount) ||
    payload.complianceEventCount < 0 ||
    payload.complianceEventCount > payload.posts.length ||
    !validXPacking(payload.packing, companyIds)
  ) return { valid: false };

  const checkpoints = new Map<string, XIngestion["checkpoints"][number]>();
  for (const checkpoint of payload.checkpoints) {
    if (
      checkpoints.has(checkpoint.companyId) ||
      !companyIds.has(checkpoint.companyId) ||
      checkpoint.checkpointAfter !== result.checkpoint ||
      !validCheckpoint(checkpoint.checkpointAfter)
    ) return { valid: false };
    checkpoints.set(checkpoint.companyId, checkpoint);
  }
  for (const obligation of obligations) {
    const checkpoint = checkpoints.get(obligation.companyId);
    if (!checkpoint || checkpoint.checkpointBefore !== obligation.checkpoint) {
      return { valid: false };
    }
  }

  let priorGapEnd = work.windowStart;
  for (const gap of payload.gaps) {
    if (!validXWindow(gap, outer) || gap.startAt < priorGapEnd) return { valid: false };
    priorGapEnd = gap.endAt;
  }
  const incomplete = result.coverage === "partial" ||
    result.hasMore ||
    result.itemCount === work.resultCap;
  if (
    !incomplete &&
    (payload.returnedWindow.startAt !== work.windowStart ||
      payload.returnedWindow.endAt !== work.windowEnd)
  ) return { valid: false };
  if ((incomplete && payload.gaps.length === 0) || (!incomplete && payload.gaps.length > 0)) {
    return { valid: false };
  }

  const seenIdentityCompanies = new Set<string>();
  for (const identity of payload.identities) {
    if (
      seenIdentityCompanies.has(identity.companyId) ||
      !companyIds.has(identity.companyId) ||
      !validXIdentityObservation(identity, work, now)
    ) return { valid: false };
    seenIdentityCompanies.add(identity.companyId);
    const [company, claims] = await Promise.all([
      ctx.db
        .query("companyMonitoringCompanies")
        .withIndex("by_account_companyId", (q) =>
          q.eq("ownerAccountId", work.ownerAccountId).eq("companyId", identity.companyId),
        )
        .unique(),
      ctx.db
        .query("companyMonitoringClaims")
        .withIndex("by_account_company", (q) =>
          q.eq("ownerAccountId", work.ownerAccountId).eq("companyId", identity.companyId),
        )
        .take(101),
    ]);
    if (!company || company.lifecycle !== "active" || claims.length > 100) return { valid: false };
    const domainClaim = claims.find((claim) => claim.claimId === identity.domainClaimId);
    const handleClaim = claims.find((claim) => claim.claimId === identity.xHandleClaimId);
    if (
      company.domicileCountry !== identity.domicileCountry ||
      !claimHasIndependentDomainAuthority(domainClaim, now) ||
      normalizedDomain(domainClaim.value) !== normalizedDomain(identity.officialDomain) ||
      handleClaim?.type !== "x_handle"
    ) return { valid: false };
  }
  if (payload.posts.some((post) =>
    !companyIds.has(post.companyId) ||
    !validXPostObservation(post, payload.permittedStorage)
  )) return { valid: false };
  return { valid: true, payload };
}

function validExaUrl(rawUrl: string): boolean {
  if (
    rawUrl !== rawUrl.trim() ||
    CONTROL_CHARACTER.test(rawUrl) ||
    byteLength(rawUrl) > MAX_EXA_URL_BYTES
  ) return false;
  try {
    const url = new URL(rawUrl);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

function validExaCandidate(
  candidate: ExaIngestion["candidates"][number],
  companyIds: Set<string>,
  work: Extract<Work, { state: "leased" }>,
  now: number,
) {
  const candidateCompanyIds = new Set(candidate.candidateCompanyIds);
  return candidate.providerResultId === candidate.providerResultId.trim() &&
    candidate.providerResultId.length > 0 &&
    !CONTROL_CHARACTER.test(candidate.providerResultId) &&
    byteLength(candidate.providerResultId) <= MAX_EXA_PROVIDER_ID_BYTES &&
    (candidate.providerRequestId === undefined || (
      candidate.providerRequestId === candidate.providerRequestId.trim() &&
      candidate.providerRequestId.length > 0 &&
      !CONTROL_CHARACTER.test(candidate.providerRequestId) &&
      byteLength(candidate.providerRequestId) <= MAX_EXA_REQUEST_ID_BYTES
    )) &&
    Number.isSafeInteger(candidate.providerRank) &&
    candidate.providerRank >= 1 &&
    candidate.providerRank <= work.resultCap &&
    validExaUrl(candidate.url) &&
    (candidate.title === undefined || (
      !CONTROL_CHARACTER.test(candidate.title) && byteLength(candidate.title) <= MAX_EXA_TITLE_BYTES
    )) &&
    (candidate.author === undefined || (
      !CONTROL_CHARACTER.test(candidate.author) && byteLength(candidate.author) <= MAX_EXA_AUTHOR_BYTES
    )) &&
    Number.isSafeInteger(candidate.publishedAt) &&
    candidate.publishedAt >= work.windowStart &&
    candidate.publishedAt <= work.windowEnd &&
    Number.isSafeInteger(candidate.retrievedAt) &&
    candidate.retrievedAt >= work.windowEnd &&
    candidate.retrievedAt <= now + EXA_RETRIEVAL_CLOCK_SKEW_MS &&
    candidateCompanyIds.size > 0 &&
    candidateCompanyIds.size === candidate.candidateCompanyIds.length &&
    candidateCompanyIds.size <= COMPANY_MONITORING_SCAN_COHORT_LIMIT &&
    candidateCompanyIds.size === companyIds.size &&
    [...candidateCompanyIds].every((companyId) => companyIds.has(companyId));
}

function validExaIngestionForWork(
  result: FinalizeResult,
  work: Extract<Work, { state: "leased" }>,
  obligations: Obligation[],
  now: number,
): { valid: boolean; payload?: ExaIngestion } {
  if (result.type === "provider_error") return { valid: true };
  if (work.source !== "exa") return { valid: result.exaIngestion === undefined };
  const payload = result.exaIngestion;
  if (!payload || result.xIngestion !== undefined || payload.candidates.length > work.resultCap) {
    return { valid: false };
  }
  const companyIds = new Set(obligations.map((obligation) => obligation.companyId));
  const providerRanks = new Set<number>();
  const providerResultIds = new Set<string>();
  for (const candidate of payload.candidates) {
    if (
      providerRanks.has(candidate.providerRank) ||
      providerResultIds.has(candidate.providerResultId) ||
      !validExaCandidate(candidate, companyIds, work, now)
    ) return { valid: false };
    providerRanks.add(candidate.providerRank);
    providerResultIds.add(candidate.providerResultId);
  }
  if (payload.candidates.length !== result.itemCount) {
    return { valid: false };
  }
  return { valid: true, payload };
}

function xReceipt(payload: XIngestion) {
  return {
    requestedWindow: payload.requestedWindow,
    returnedWindow: payload.returnedWindow,
    checkpoints: payload.checkpoints,
    packing: payload.packing,
    gaps: payload.gaps,
    permittedStorage: payload.permittedStorage,
    unexpectedAuthorAccountIds: payload.unexpectedAuthorAccountIds,
    requestCount: payload.requestCount,
    complianceEventCount: payload.complianceEventCount,
    identityCount: payload.identities.length,
    postCount: payload.posts.length,
  };
}

async function applyXIdentities(
  ctx: MutationCtx,
  work: Work,
  identities: XIngestion["identities"],
  now: number,
) {
  for (const observation of [...identities].sort((left, right) =>
    left.companyId.localeCompare(right.companyId)
  )) {
    const [existing, accountBindings, handleBindings] = await Promise.all([
      ctx.db
        .query("companyMonitoringXIdentities")
        .withIndex("by_account_company", (q) =>
          q.eq("ownerAccountId", work.ownerAccountId).eq("companyId", observation.companyId),
        )
        .unique(),
      ctx.db
        .query("companyMonitoringXIdentities")
        .withIndex("by_account_accountId", (q) =>
          q.eq("ownerAccountId", work.ownerAccountId).eq("accountId", observation.accountId),
        )
        .collect(),
      ctx.db
        .query("companyMonitoringXIdentities")
        .withIndex("by_account_currentHandle", (q) =>
          q.eq("ownerAccountId", work.ownerAccountId).eq("currentHandle", observation.currentHandle),
        )
        .collect(),
    ]);
    const conflicts = [...accountBindings, ...handleBindings].some((binding) =>
      binding.companyId !== observation.companyId &&
      binding.state === "authoritative" &&
      binding.expiresAt > now
    );
    const accountChanged = Boolean(existing && existing.accountId !== observation.accountId);
    const expired = observation.state === "authoritative" && observation.expiresAt <= now;
    const state = conflicts || accountChanged || expired ? "demoted" as const : observation.state;
    let demotionReason = observation.demotionReason;
    if (conflicts) demotionReason = "family_conflict";
    else if (accountChanged) {
      demotionReason = existing?.currentHandle === observation.currentHandle
        ? "account_reassigned"
        : "account_changed";
    } else if (expired) demotionReason = "expired";
    const row = {
      ownerAccountId: work.ownerAccountId,
      companyId: observation.companyId,
      domainClaimId: observation.domainClaimId,
      xHandleClaimId: observation.xHandleClaimId,
      officialDomain: observation.officialDomain,
      officialPageUrl: observation.officialPageUrl,
      accountId: existing?.accountId ?? observation.accountId,
      currentHandle: observation.currentHandle,
      profileName: observation.profileName,
      domicileCountry: observation.domicileCountry,
      authorityRole: observation.authorityRole,
      state,
      ...(demotionReason ? { demotionReason } : {}),
      badgeVerified: observation.badgeVerified,
      allowedUses: state === "authoritative" ? observation.allowedUses : [],
      evidenceHash: observation.evidenceHash,
      checkedAt: observation.checkedAt,
      expiresAt: observation.expiresAt,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    if (existing) await ctx.db.replace(existing._id, row);
    else await ctx.db.insert("companyMonitoringXIdentities", row);
  }
}

async function applyXPosts(
  ctx: MutationCtx,
  work: Work,
  posts: XIngestion["posts"],
  now: number,
) {
  const normalizedPosts = new Map<string, NormalizedXPostInput>();
  const companyRevisions = new Map<string, number>();
  const identities = new Map<string, Doc<"companyMonitoringXIdentities"> | null>();
  const companies = new Map<string, Doc<"companyMonitoringCompanies"> | null>();
  const identityFor = async (companyId: string) => {
    if (!identities.has(companyId)) {
      identities.set(companyId, await ctx.db
        .query("companyMonitoringXIdentities")
        .withIndex("by_account_company", (q) =>
          q.eq("ownerAccountId", work.ownerAccountId).eq("companyId", companyId),
        )
        .unique());
    }
    return identities.get(companyId);
  };
  const companyFor = async (companyId: string) => {
    if (!companies.has(companyId)) {
      companies.set(companyId, await ctx.db
        .query("companyMonitoringCompanies")
        .withIndex("by_account_companyId", (q) =>
          q.eq("ownerAccountId", work.ownerAccountId).eq("companyId", companyId),
        )
        .unique());
    }
    return companies.get(companyId);
  };
  const aliases = new Map<string, XPostAlias | null>();
  const deletedCanonicalPostIds = new Set<string>();
  const aliasFor = async (postId: string) => {
    if (!aliases.has(postId)) {
      aliases.set(postId, await ctx.db
        .query("companyMonitoringXPostAliases")
        .withIndex("by_account_postId", (q) =>
          q.eq("ownerAccountId", work.ownerAccountId).eq("postId", postId),
        )
        .unique());
    }
    return aliases.get(postId) ?? null;
  };
  for (const post of posts) {
    const firstEditPostId = post.editHistoryPostIds[0];
    if (!firstEditPostId) continue;
    const observedPostIds = [...new Set([...post.editHistoryPostIds, post.postId])];
    const [identity, observedAliases] = await Promise.all([
      identityFor(post.companyId),
      Promise.all(observedPostIds.map(aliasFor)),
    ]);
    const aliasRows = observedAliases.filter((row): row is XPostAlias => Boolean(row));
    if (aliasRows.some((row) =>
      row.companyId !== post.companyId || row.authorAccountId !== post.authorAccountId
    )) continue;
    const canonicalIds = new Set(aliasRows.map((row) => row.canonicalPostId));
    if (canonicalIds.size > 1) continue;
    const canonicalPostId = aliasRows[0]?.canonicalPostId ?? firstEditPostId;
    const existing = await ctx.db
      .query("companyMonitoringXEvidence")
      .withIndex("by_account_postId", (q) =>
        q.eq("ownerAccountId", work.ownerAccountId).eq("postId", canonicalPostId),
      )
      .unique();
    if (existing && existing.companyId !== post.companyId) continue;
    const authoritativeRecentSearch = Boolean(
      identity?.state === "authoritative" &&
      identity.expiresAt > now &&
      identity.accountId === post.authorAccountId &&
      identity.allowedUses.includes("recent_search")
    );
    const complianceReconciliation = Boolean(
      existing &&
      identity?.accountId === post.authorAccountId &&
      existing.authorAccountId === post.authorAccountId
    );
    if (!authoritativeRecentSearch && !complianceReconciliation) continue;

    const editHistoryPostIds = [...new Set([
      ...(existing?.editHistoryPostIds ?? []),
      ...post.editHistoryPostIds,
      post.postId,
    ])];
    if (editHistoryPostIds.length > MAX_X_EDIT_HISTORY_POST_IDS) continue;
    const editHistoryAliases = await Promise.all(editHistoryPostIds.map(aliasFor));
    if (editHistoryAliases.some((alias) =>
      alias && (
        alias.companyId !== post.companyId ||
        alias.authorAccountId !== post.authorAccountId ||
        alias.canonicalPostId !== canonicalPostId
      )
    )) continue;
    let evidenceRevision = companyRevisions.get(post.companyId);
    if (evidenceRevision === undefined) {
      const company = await companyFor(post.companyId);
      if (!company || company.lifecycle !== "active") continue;
      evidenceRevision = company.evidenceRevision ?? 0;
      companyRevisions.set(post.companyId, evidenceRevision);
    }
    for (const [index, postId] of editHistoryPostIds.entries()) {
      const alias = editHistoryAliases[index];
      const aliasRow = {
        ownerAccountId: work.ownerAccountId,
        companyId: post.companyId,
        postId,
        canonicalPostId,
        authorAccountId: post.authorAccountId,
        createdAt: alias?.createdAt ?? now,
        updatedAt: now,
      };
      const aliasId = alias?._id ?? await ctx.db.insert("companyMonitoringXPostAliases", aliasRow);
      if (alias && (
        alias.ownerAccountId !== aliasRow.ownerAccountId ||
        alias.companyId !== aliasRow.companyId ||
        alias.postId !== aliasRow.postId ||
        alias.canonicalPostId !== aliasRow.canonicalPostId ||
        alias.authorAccountId !== aliasRow.authorAccountId ||
        alias.createdAt !== aliasRow.createdAt ||
        alias.updatedAt !== aliasRow.updatedAt
      )) await ctx.db.replace(aliasId, aliasRow);
      aliases.set(postId, { _id: aliasId, ...aliasRow });
    }
    if (existing && post.contentState !== "deleted" && deletedCanonicalPostIds.has(canonicalPostId)) {
      await ctx.db.patch(existing._id, {
        editHistoryPostIds,
        lastReconciledAt: now,
        updatedAt: now,
      });
      normalizedPosts.set(`${post.companyId}\u0000${canonicalPostId}`, {
        companyId: existing.companyId,
        canonicalPostId,
        authorAccountId: existing.authorAccountId,
        currentHandle: existing.currentHandle,
        createdAt: existing.createdAt,
        observedAt: existing.observedAt,
        contentState: existing.contentState,
        storageState: existing.storageState,
        ...(existing.text ? { text: existing.text } : {}),
      });
      continue;
    }
    if (post.contentState === "deleted") deletedCanonicalPostIds.add(canonicalPostId);
    const deletionStateChanged = post.contentState === "deleted"
      ? existing?.contentState !== "deleted"
      : existing?.contentState === "deleted";
    if (deletionStateChanged) {
      evidenceRevision += 1;
      companyRevisions.set(post.companyId, evidenceRevision);
      const company = await companyFor(post.companyId);
      if (company) {
        await ctx.db.patch(company._id, {
          evidenceRevision,
          recomputeRequiredAt: now,
          updatedAt: now,
        });
      }
    }
    const redactForCompliance = complianceReconciliation && !authoritativeRecentSearch;
    const storageState = redactForCompliance && post.contentState !== "deleted"
      ? "metadata_only" as const
      : post.storageState;
    const row = {
      ownerAccountId: work.ownerAccountId,
      companyId: post.companyId,
      postId: canonicalPostId,
      authorAccountId: post.authorAccountId,
      currentHandle: post.currentHandle,
      createdAt: existing?.createdAt ?? post.createdAt,
      observedAt: post.observedAt,
      contentState: post.contentState,
      storageState,
      ...(!redactForCompliance && post.text !== undefined ? { text: post.text } : {}),
      editHistoryPostIds,
      ...(post.withheldCountryCodes ? { withheldCountryCodes: post.withheldCountryCodes } : {}),
      evidenceRevision,
      lastReconciledAt: now,
      firstSeenAt: existing?.firstSeenAt ?? now,
      updatedAt: now,
    };
    if (existing) await ctx.db.replace(existing._id, row);
    else await ctx.db.insert("companyMonitoringXEvidence", row);
    normalizedPosts.set(`${post.companyId}\u0000${canonicalPostId}`, {
      companyId: row.companyId,
      canonicalPostId,
      authorAccountId: row.authorAccountId,
      currentHandle: row.currentHandle,
      createdAt: row.createdAt,
      observedAt: row.observedAt,
      contentState: row.contentState,
      storageState: row.storageState,
      ...(row.text ? { text: row.text } : {}),
    });
  }
  return [...normalizedPosts.values()];
}

async function applyXIngestion(
  ctx: MutationCtx,
  work: Work,
  payload: XIngestion,
  obligations: Obligation[],
  now: number,
) {
  await applyXIdentities(ctx, work, payload.identities, now);
  const normalizedPosts = await applyXPosts(ctx, work, payload.posts, now);
  await syncNormalizedXEvidence(ctx, work, normalizedPosts, obligations, now);
}

async function applyExaIngestion(
  ctx: MutationCtx,
  work: Work,
  payload: ExaIngestion,
  obligations: Obligation[],
) {
  if (payload.candidates.length === 0) return;
  await ingestCompanyEvidenceForCompanyIds(ctx, {
    ownerAccountId: work.ownerAccountId,
    companyIds: obligations.map((obligation) => obligation.companyId),
    evidence: payload.candidates.map((candidate) => ({
      provider: "exa" as const,
      providerLocator: candidate.providerResultId,
      queryVersion: work.queryVersion,
      url: candidate.url,
      ...(candidate.title ? { title: candidate.title } : {}),
      ...(candidate.author ? { author: candidate.author } : {}),
      publishedAt: candidate.publishedAt,
      observedAt: candidate.retrievedAt,
      expiresAt: candidate.retrievedAt + COMPANY_MONITORING_EVIDENCE_POLICY.candidateTtlMs,
      candidateCompanyIds: candidate.candidateCompanyIds,
      sourceAuthority: "low_authority",
    })),
  });
}

async function syncNormalizedXEvidence(
  ctx: MutationCtx,
  work: Work,
  posts: NormalizedXPostInput[],
  obligations: Obligation[],
  now: number,
) {
  const companyIds = [...new Set(obligations.map((obligation) => obligation.companyId))].sort();
  for (const companyId of companyIds) {
    const identity = await ctx.db
      .query("companyMonitoringXIdentities")
      .withIndex("by_account_company", (q) =>
        q.eq("ownerAccountId", work.ownerAccountId).eq("companyId", companyId),
      )
      .unique();
    const authoritative = Boolean(
      identity?.state === "authoritative" &&
      identity.expiresAt > now &&
      identity.allowedUses.includes("primary_evidence")
    );
    if (!authoritative) {
      await setAllCompanyProviderEvidenceState(ctx, {
        ownerAccountId: work.ownerAccountId,
        companyId,
        provider: "x",
        state: "authority_lost",
      });
    }

    const normalizedRows: ProviderEvidence[] = [];
    const deletedLocators: string[] = [];
    const unavailableLocators: string[] = [];
    for (const stored of posts.filter((row) => row.companyId === companyId)) {
      const canonicalPostId = stored.canonicalPostId;
      if (stored.contentState === "deleted") {
        deletedLocators.push(canonicalPostId);
        continue;
      }
      if (stored.storageState !== "full_text" || !stored.text) {
        unavailableLocators.push(canonicalPostId);
        continue;
      }
      if (
        !authoritative ||
        !identity ||
        identity.accountId !== stored.authorAccountId
      ) continue;
      normalizedRows.push({
        provider: "x",
        providerLocator: canonicalPostId,
        queryVersion: work.queryVersion,
        url: `https://x.com/i/status/${canonicalPostId}`,
        text: stored.text,
        author: stored.currentHandle,
        authorAccountId: stored.authorAccountId,
        publishedAt: stored.createdAt,
        observedAt: stored.observedAt,
        expiresAt: identity.expiresAt,
        candidateCompanyIds: [companyId],
        verifiedCompanyIds: [companyId],
        sourceAuthority: "verified_first_party",
      });
    }
    if (deletedLocators.length > 0) {
      await setCompanyEvidenceStateForProviderLocators(ctx, {
        ownerAccountId: work.ownerAccountId,
        companyId,
        provider: "x",
        providerLocators: deletedLocators,
        state: "deleted",
      });
    }
    if (unavailableLocators.length > 0) {
      await setCompanyEvidenceStateForProviderLocators(ctx, {
        ownerAccountId: work.ownerAccountId,
        companyId,
        provider: "x",
        providerLocators: unavailableLocators,
        state: "unavailable",
      });
    }
    if (normalizedRows.length > 0) {
      await ingestCompanyEvidenceForCompanyIds(ctx, {
        ownerAccountId: work.ownerAccountId,
        companyIds: [companyId],
        evidence: normalizedRows,
      });
    }
  }
}

function validCost(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_COST_USD_MICROS;
}

function validRange(
  range: { startAt: number; endAt: number } | undefined,
  work: Work,
): range is { startAt: number; endAt: number } {
  return Boolean(
    range &&
    Number.isSafeInteger(range.startAt) &&
    Number.isSafeInteger(range.endAt) &&
    range.startAt === work.windowStart &&
    range.endAt === work.windowEnd,
  );
}

function validCheckpoint(value: string | undefined): value is string {
  if (!value || value !== value.trim()) return false;
  return new TextEncoder().encode(value).byteLength <= MAX_CHECKPOINT_BYTES;
}

function nonReassuringSourceCoverage(result: FinalizeResult) {
  if (result.type === "provider_error") return "failed" as const;
  if (result.coverage === "partial") return "partial" as const;
  return "unknown" as const;
}

function nonReassuringReceipt(
  reason: NonReassuringReason,
  now: number,
  result: FinalizeResult,
  work: Work,
  trustedXPayload?: XIngestion,
) {
  const range = result.type === "result" && validRange(result.returnedRange, work)
    ? result.returnedRange
    : undefined;
  const itemCount = result.type === "result" && Number.isSafeInteger(result.itemCount) && result.itemCount >= 0
    ? result.itemCount
    : undefined;
  const providerReason: ProviderErrorReason | undefined = result.type === "provider_error"
    ? result.reason
    : undefined;
  return {
    kind: "non_reassuring" as const,
    reason,
    ...(providerReason ? { providerReason } : {}),
    completedAt: now,
    ...(range ? { returnedRange: range } : {}),
    ...(itemCount !== undefined ? { itemCount } : {}),
    costUsdMicros: validCost(result.costUsdMicros) ? result.costUsdMicros : 0,
    sourceCoverage: nonReassuringSourceCoverage(result),
    ...(trustedXPayload ? { xIngestion: xReceipt(trustedXPayload) } : {}),
  };
}

function classifyResult(
  result: FinalizeResult,
  work: Work,
  now: number,
  xValidation: { valid: boolean; payload?: XIngestion },
  exaValidation: { valid: boolean; payload?: ExaIngestion },
) {
  if (!xValidation.valid || !exaValidation.valid) {
    return nonReassuringReceipt("malformed", now, result, work);
  }
  if (!validCost(result.costUsdMicros)) {
    return nonReassuringReceipt("malformed", now, result, work);
  }
  if (result.type === "provider_error") {
    return nonReassuringReceipt("provider_error", now, result, work);
  }
  if (
    !Number.isSafeInteger(result.itemCount) ||
    result.itemCount < 0 ||
    result.itemCount > work.resultCap ||
    !validRange(result.returnedRange, work) ||
    !validCheckpoint(result.checkpoint)
  ) {
    return nonReassuringReceipt("malformed", now, result, work);
  }
  if (result.hasMore || result.itemCount === work.resultCap) {
    return nonReassuringReceipt("capped", now, result, work, xValidation.payload);
  }
  if (result.coverage === "partial") {
    return nonReassuringReceipt("partial", now, result, work, xValidation.payload);
  }
  if (result.itemCount === 0 && !result.emptyValidated) {
    return nonReassuringReceipt("invalid_empty", now, result, work, xValidation.payload);
  }
  return {
    kind: "complete" as const,
    reason: "complete" as const,
    completedAt: now,
    returnedRange: result.returnedRange,
    itemCount: result.itemCount,
    costUsdMicros: result.costUsdMicros,
    sourceCoverage: "complete" as const,
    checkpointAfter: result.checkpoint,
    ...(xValidation.payload ? { xIngestion: xReceipt(xValidation.payload) } : {}),
  };
}

async function finalizeWorkHandler(
  ctx: MutationCtx,
  args: {
    workerId: string;
    workId: string;
    leaseToken: string;
    result: FinalizeResult;
  },
) {
  const workerId = normalizeWorkerId(args.workerId);
  const work = await ctx.db
    .query("companyMonitoringScanWorkItems")
    .withIndex("by_workId", (q) => q.eq("workId", args.workId))
    .unique();
  if (!work) return { status: "fenced" as const };
  if (work.state === "complete" || work.state === "non_reassuring") {
    if (work.terminalLeaseToken !== args.leaseToken || work.terminalWorkerId !== workerId) {
      return { status: "fenced" as const };
    }
    return {
      status: "replayed" as const,
      reason: work.terminalReceipt.reason,
      receipt: work.terminalReceipt,
    };
  }
  const now = Date.now();
  if (
    work.state !== "leased" ||
    work.leaseToken !== args.leaseToken ||
    work.workerId !== workerId ||
    work.leaseExpiresAt <= now
  ) {
    return { status: "fenced" as const };
  }

  const account = await ctx.db
    .query("companyMonitoringAccounts")
    .withIndex("by_logicalAccountId", (q) => q.eq("logicalAccountId", work.ownerAccountId))
    .unique();
  if (!account || account.lifecycle !== "entitled" || account.terminalReason) {
    return { status: "fenced" as const };
  }

  const obligations = await ctx.db
    .query("companyMonitoringScanObligations")
    .withIndex("by_workId", (q) => q.eq("workId", work.workId))
    .take(COMPANY_MONITORING_SCAN_COHORT_LIMIT + 1);
  if (
    obligations.length === 0 ||
    obligations.length > COMPANY_MONITORING_SCAN_COHORT_LIMIT ||
    obligations.some((obligation) =>
      obligation.state !== "leased" ||
      obligation.leaseToken !== args.leaseToken ||
      obligation.workerId !== workerId,
    )
  ) {
    return { status: "fenced" as const };
  }

  const xValidation = await validXIngestionForWork(ctx, args.result, work, obligations, now);
  const exaValidation = validExaIngestionForWork(args.result, work, obligations, now);
  const receipt = classifyResult(args.result, work, now, xValidation, exaValidation);
  if (
    xValidation.payload &&
    (receipt.reason === "complete" || receipt.reason === "partial" || receipt.reason === "capped")
  ) {
    await applyXIngestion(ctx, work, xValidation.payload, obligations, now);
  }
  if (
    exaValidation.payload &&
    (receipt.reason === "complete" || receipt.reason === "partial" || receipt.reason === "capped")
  ) {
    await applyExaIngestion(ctx, work, exaValidation.payload, obligations);
  }
  if (receipt.kind === "complete") {
    await ctx.db.replace(work._id, {
      ...workIdentity(work),
      state: "complete",
      selectionDueAt: now,
      terminalLeaseToken: args.leaseToken,
      terminalWorkerId: workerId,
      terminalReceipt: receipt,
      updatedAt: now,
    });
    await linkTerminalReceipt(ctx, work, obligations, now);
    await rearmNextScan(ctx, work, obligations, now, receipt.checkpointAfter);
  } else {
    await ctx.db.replace(work._id, {
      ...workIdentity(work),
      state: "non_reassuring",
      selectionDueAt: now,
      terminalLeaseToken: args.leaseToken,
      terminalWorkerId: workerId,
      terminalReceipt: receipt,
      updatedAt: now,
    });
    await linkTerminalReceipt(ctx, work, obligations, now);
    await rearmNextScan(ctx, work, obligations, now);
  }
  await updateAccountDueFromWork(ctx, work.ownerAccountId);
  return {
    status: receipt.kind === "complete" ? "completed" as const : "non_reassuring" as const,
    reason: receipt.reason,
    receipt,
  };
}

// Internal scheduling is the trusted seam for lifecycle/cron integration. It
// accepts an account cohort, but creates the due time, time window, query
// version, cap, uniqueness key, and durable obligations inside Convex.
export const scheduleAccountWork = internalMutation({
  args: {
    ownerAccountId: v.string(),
    source: companyMonitoringScanSourceValidator,
    companyIds: v.array(v.string()),
  },
  handler: scheduleAccountWorkHandler,
});

// Import actions can be retried after row mutations committed but before all
// cohort scheduling finished. Filter each fixed-size cohort in Convex so only
// companies missing this source join new work; already durable obligations are
// left untouched even when created and replayed rows are mixed.
export const ensureAccountWork = internalMutation({
  args: {
    ownerAccountId: v.string(),
    source: companyMonitoringScanSourceValidator,
    companyIds: v.array(v.string()),
  },
  handler: (ctx, args) => scheduleAccountWorkHandler(ctx, args, "missing_only"),
});

export async function scheduleCompanySourcesHandler(
  ctx: MutationCtx,
  args: { ownerAccountId: string; companyId: string },
) {
  if (!await activeCompany(ctx, args.ownerAccountId, args.companyId)) {
    return { status: "inactive" as const, sources: 0 };
  }
  const results = [];
  for (const source of ["exa", "x"] as const) {
    results.push(await scheduleAccountWorkHandler(ctx, {
      ownerAccountId: args.ownerAccountId,
      source,
      companyIds: [args.companyId],
    }, "missing_only"));
  }
  return {
    status: results.some((result) => result.status === "scheduled")
      ? "scheduled" as const
      : "replayed" as const,
    sources: results.length,
  };
}

export const scheduleCompanySources = internalMutation({
  args: { ownerAccountId: v.string(), companyId: v.string() },
  handler: scheduleCompanySourcesHandler,
});

// Public worker claims are intentionally targetless. The worker can identify
// only itself; Convex selects the account and work from the bounded due index.
export const claimNextWork = mutation({
  args: { secret: v.string(), workerId: v.string() },
  handler: async (ctx, args) => {
    await requireWorkerSecret(args.secret);
    const sources = enabledSources();
    if (sources.length === 0) return { status: "disabled" as const };
    const result = await claimNextWorkHandler(ctx, args.workerId, sources);
    if (result.status === "claimed") return { status: result.status, work: result.work };
    return { status: result.status };
  },
});

export const finalizeWork = mutation({
  args: {
    secret: v.string(),
    workerId: v.string(),
    workId: v.string(),
    leaseToken: v.string(),
    result: companyMonitoringFinalizeResultValidator,
  },
  handler: async (ctx, args) => {
    await requireWorkerSecret(args.secret);
    return finalizeWorkHandler(ctx, args);
  },
});

/** Claim one exact normalized-evidence snapshot for deterministic classification. */
export const claimNextAdmissionCandidate = mutation({
  args: {
    secret: v.string(),
    workerId: v.string(),
    classificationRunId: v.string(),
    requestedModelVersion: v.string(),
  },
  handler: async (ctx, args) => {
    await requireWorkerSecret(args.secret);
    return claimNextAdmissionCandidateHandler(ctx, args);
  },
});

/** Validate untrusted model output and append the fenced policy decision. */
export const finalizeAdmissionCandidate = mutation({
  args: {
    secret: v.string(),
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
  handler: async (ctx, { secret, ...args }) => {
    await requireWorkerSecret(secret);
    return recordAdmissionDecisionHandler(ctx, args);
  },
});

/** Record a fenced classifier transport failure without accepting model output. */
export const finalizeAdmissionTransportFailure = mutation({
  args: {
    secret: v.string(),
    workerId: v.string(),
    leaseToken: v.string(),
    ownerAccountId: v.string(),
    companyId: v.string(),
    occurrenceDedupeKey: v.string(),
    expectedEvidenceRevision: v.number(),
    classificationRunId: v.string(),
    requestedModelVersion: v.string(),
  },
  handler: async (ctx, { secret, ...args }) => {
    await requireWorkerSecret(secret);
    return recordAdmissionTransportFailureHandler(ctx, args);
  },
});

// Convex-test cannot override compile-time-dark provider flags. These internal
// seams exercise the exact selection/finalization handlers without widening
// the worker API or introducing an environment bypass in production.
export const claimNextWorkForTest = internalMutation({
  args: { workerId: v.string() },
  handler: (ctx, args) => claimNextWorkHandler(ctx, args.workerId, ["exa", "x"]),
});

export const finalizeWorkForTest = internalMutation({
  args: {
    workerId: v.string(),
    workId: v.string(),
    leaseToken: v.string(),
    result: companyMonitoringFinalizeResultValidator,
  },
  handler: finalizeWorkHandler,
});
