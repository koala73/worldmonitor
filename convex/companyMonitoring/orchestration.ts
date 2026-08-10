import { ConvexError, type Infer, v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import {
  internalMutation,
  mutation,
  type MutationCtx,
} from "../_generated/server";
import { COMPANY_MONITORING_ROLLOUT_FLAGS } from "../config/productCatalog";
import { fingerprint } from "./_shared";
import {
  companyMonitoringFinalizeResultValidator,
  companyMonitoringNonReassuringReasonValidator,
  companyMonitoringProviderErrorReasonValidator,
  companyMonitoringScanSourceValidator,
} from "./validators";

type Source = Infer<typeof companyMonitoringScanSourceValidator>;
type FinalizeResult = Infer<typeof companyMonitoringFinalizeResultValidator>;
type NonReassuringReason = Infer<typeof companyMonitoringNonReassuringReasonValidator>;
type ProviderErrorReason = Infer<typeof companyMonitoringProviderErrorReasonValidator>;
type Work = Doc<"companyMonitoringScanWorkItems">;
type Obligation = Doc<"companyMonitoringScanObligations">;

const ACCOUNT_DUE_PAGE_SIZE = 32;
const ACCOUNT_WORK_PAGE_SIZE = 8;
export const COMPANY_MONITORING_SCAN_COHORT_LIMIT = 25;
const SCAN_PURGE_WORK_BATCH_SIZE = 8;
const SCAN_PURGE_OBLIGATION_BATCH_SIZE = 16;
const SCAN_PURGE_RECEIPT_LINK_BATCH_SIZE = 16;
const LEASE_MS = 5 * 60 * 1000;
const WINDOW_MS = 24 * 60 * 60 * 1000;
const WINDOW_BUCKET_MS = 60 * 60 * 1000;
const MAX_CHECKPOINT_BYTES = 512;
const MAX_COST_USD_MICROS = 1_000_000_000_000;
const WORKER_ID = /^[A-Za-z0-9._:-]{1,64}$/;

const QUERY_VERSION: Record<Source, string> = {
  exa: "exa-company-discovery-v1",
  x: "x-company-discovery-v1",
};

// Provider limits are Convex-owned. A worker receives the selected value in a
// lease and cannot raise it in claim or finalize arguments.
const RESULT_CAP: Record<Source, number> = { exa: 100, x: 100 };

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

function randomFence(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function enabledSources(): Source[] {
  const flags: Record<Source, boolean> = {
    exa: COMPANY_MONITORING_ROLLOUT_FLAGS.exaProvider,
    x: COMPANY_MONITORING_ROLLOUT_FLAGS.xProvider,
  };
  return (Object.keys(flags) as Source[]).filter((source) => flags[source]);
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
  await updateAccountDueFromWork(ctx, ownerAccountId);
  return {
    complete:
      page.length <= SCAN_PURGE_OBLIGATION_BATCH_SIZE &&
      receiptLinkPage.length <= SCAN_PURGE_RECEIPT_LINK_BATCH_SIZE,
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
  await updateAccountDueFromWork(ctx, ownerAccountId);
  return {
    complete:
      obligationPage.length <= SCAN_PURGE_OBLIGATION_BATCH_SIZE &&
      receiptLinkPage.length <= SCAN_PURGE_RECEIPT_LINK_BATCH_SIZE,
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
    })),
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
  };
}

function classifyResult(result: FinalizeResult, work: Work, now: number) {
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
    return nonReassuringReceipt("capped", now, result, work);
  }
  if (result.coverage === "partial") {
    return nonReassuringReceipt("partial", now, result, work);
  }
  if (result.itemCount === 0 && !result.emptyValidated) {
    return nonReassuringReceipt("invalid_empty", now, result, work);
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

  const receipt = classifyResult(args.result, work, now);
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
