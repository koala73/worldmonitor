import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import { internalMutation, type MutationCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import {
  ANON_ID_V4_REGEX,
  companyMonitoringOwnerFenceCandidates,
  type CompanyMonitoringOwnerFenceCandidates,
} from "../lib/identitySigning";
import { COMPANY_MONITORING_LIMITS } from "../../shared/company-monitoring-contract";
import { COMPANY_LIMIT, deleteCompanyClaims, fingerprint, logicalId } from "./_shared";

const PURGE_TRANSACTION_DOCUMENT_LIMIT = 8_192;
// Reserve room for the account read/write, the lookahead company, scheduler
// bookkeeping, and future transaction-local metadata without approaching the
// hard bound. Each processed company can touch all 81 claims plus its row.
const PURGE_TRANSACTION_DOCUMENT_HEADROOM = 512;
const PURGE_DOCUMENTS_PER_COMPANY = COMPANY_MONITORING_LIMITS.maxClaimsPerCompany + 1;
const PURGE_BATCH_SIZE = Math.floor(
  (PURGE_TRANSACTION_DOCUMENT_LIMIT - PURGE_TRANSACTION_DOCUMENT_HEADROOM) /
    PURGE_DOCUMENTS_PER_COMPANY,
);

async function canonicalEntitlement(ctx: MutationCtx, userId: string) {
  const entitlement = await ctx.db
    .query("entitlements")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .unique();
  if (!entitlement) return { active: false as const, digest: await fingerprint({ active: false }) };

  // The entitlement row is also the pre-existing serialization document for
  // first-root creation. A same-value patch is intentional: two concurrent
  // entitlement mutations for a new owner cannot both create roots.
  await ctx.db.patch(entitlement._id, { updatedAt: entitlement.updatedAt });
  const active =
    entitlement.planKey !== "free" &&
    entitlement.features.tier > 0 &&
    entitlement.validUntil >= Date.now();
  if (!active) return { active: false as const, digest: await fingerprint({ active: false }) };
  return {
    active: true as const,
    digest: await fingerprint({
      active: true,
      planKey: entitlement.planKey,
      validUntil: entitlement.validUntil,
      compUntil: entitlement.compUntil ?? null,
      features: entitlement.features,
    }),
  };
}

async function scheduleScopedKeyCacheInvalidation(ctx: MutationCtx, ownerUserId: string) {
  if (!process.env.UPSTASH_REDIS_REST_URL && !process.env.UPSTASH_REDIS_REST_TOKEN) return;
  const keys = await ctx.db
    .query("userApiKeys")
    .withIndex("by_userId_revokedAt", (q) =>
      q.eq("userId", ownerUserId).eq("revokedAt", undefined),
    )
    .collect();
  const keyHashes = keys
    .filter((key) =>
      key.scopes?.some((scope) => scope.startsWith("company_monitoring:")),
    )
    .map((key) => key.keyHash);
  if (keyHashes.length === 0) return;
  await ctx.scheduler.runAfter(
    0,
    (internal as any).payments.cacheActions.invalidateUserApiKeyCaches,
    { keyHashes },
  );
}

async function scheduleAccountPurge(
  ctx: MutationCtx,
  ownerFenceHash: string,
  purgeGeneration: number,
) {
  await ctx.scheduler.runAfter(
    0,
    (internal as any).companyMonitoring.accounts.advanceAccountPurge,
    { ownerFenceHash, purgeGeneration },
  );
}

async function findAccountByOwnerFence(
  ctx: MutationCtx,
  ownerFence: CompanyMonitoringOwnerFenceCandidates,
): Promise<{ account: Doc<"companyMonitoringAccounts">; matchedHash: string } | null> {
  let match: { account: Doc<"companyMonitoringAccounts">; matchedHash: string } | null = null;
  for (const ownerFenceHash of ownerFence.all) {
    const account = await ctx.db
      .query("companyMonitoringAccounts")
      .withIndex("by_ownerFenceHash", (q) => q.eq("ownerFenceHash", ownerFenceHash))
      .unique();
    if (!account) continue;
    if (match && match.account._id !== account._id) {
      throw new ConvexError("ACCOUNT_OWNER_FENCE_CONFLICT");
    }
    match = { account, matchedHash: ownerFenceHash };
  }
  return match;
}

/** Apply the canonical stored entitlement to the single keyed account root. */
export async function syncCompanyMonitoringAccountFromEntitlement(
  ctx: MutationCtx,
  userId: string,
) {
  // Browser UUID purchases are deliberately invisible to Company Monitoring
  // until claimSubscription has recomputed the real authenticated owner.
  if (ANON_ID_V4_REGEX.test(userId)) return null;
  const canonical = await canonicalEntitlement(ctx, userId);
  const ownerFence = await companyMonitoringOwnerFenceCandidates(userId);
  const ownerFenceHash = ownerFence.current;
  const match = await findAccountByOwnerFence(ctx, ownerFence);
  let existing = match?.account ?? null;

  if (!existing) {
    if (!canonical.active) return null;
    const now = Date.now();
    const id = await ctx.db.insert("companyMonitoringAccounts", {
      logicalAccountId: logicalId("account", now),
      ownerUserId: userId,
      ownerFenceHash,
      lifecycle: "entitled",
      entitlementDigest: canonical.digest,
      lifecycleSequence: 1,
      companyCount: 0,
      companyLimit: COMPANY_LIMIT,
      snapshotGeneration: 0,
      purgeGeneration: 0,
      purgePhase: "none",
      destructivePurgeStarted: false,
      pendingReactivation: false,
      createdAt: now,
      updatedAt: now,
    });
    await scheduleScopedKeyCacheInvalidation(ctx, userId);
    return ctx.db.get(id);
  }

  // Terminal rows intentionally retain only the keyed fence and logical id.
  // A replayed or delayed activation can find the row, but can never mutate it.
  if (existing.terminalReason || existing.lifecycle === "denied") return existing;
  if (existing.ownerUserId !== userId) throw new ConvexError("ACCOUNT_OWNER_BINDING_MISMATCH");

  if (match && match.matchedHash !== ownerFenceHash) {
    await ctx.db.patch(existing._id, { ownerFenceHash });
    if (existing.purgePhase !== "none" && existing.purgePhase !== "complete") {
      // Jobs scheduled before rotation still carry the old hash and will become
      // stale after migration. Seed the same generation under the current key.
      await scheduleAccountPurge(ctx, ownerFenceHash, existing.purgeGeneration);
    }
    existing = (await ctx.db.get(existing._id)) ?? existing;
  }

  const semanticChanged = existing.entitlementDigest !== canonical.digest;
  const now = Date.now();
  // A completed generation proves every company payload and claim was scrubbed.
  // Reuse the same nonterminal owner root as an empty portfolio; terminal roots
  // returned above can never reach this branch. Convex OCC makes this race-safe
  // with finalization: activation either records pending before finalization or
  // observes the committed complete phase here.
  if (
    canonical.active &&
    existing.destructivePurgeStarted &&
    existing.purgePhase === "complete"
  ) {
    await ctx.db.patch(existing._id, {
      lifecycle: "entitled",
      entitlementDigest: canonical.digest,
      lifecycleSequence: existing.lifecycleSequence + (semanticChanged ? 1 : 0),
      companyCount: 0,
      companyLimit: COMPANY_LIMIT,
      snapshotGeneration: existing.snapshotGeneration ?? 0,
      purgePhase: "none",
      destructivePurgeStarted: false,
      pendingReactivation: false,
      purgeCursor: undefined,
      updatedAt: now,
    });
    await scheduleScopedKeyCacheInvalidation(ctx, userId);
    return ctx.db.get(existing._id);
  }

  if (canonical.active && existing.destructivePurgeStarted) {
    if (semanticChanged || !existing.pendingReactivation) {
      await ctx.db.patch(existing._id, {
        entitlementDigest: canonical.digest,
        lifecycleSequence: existing.lifecycleSequence + (semanticChanged ? 1 : 0),
        pendingReactivation: true,
        updatedAt: now,
      });
      await scheduleScopedKeyCacheInvalidation(ctx, userId);
    }
    return ctx.db.get(existing._id);
  }

  if (canonical.active) {
    if (semanticChanged || existing.lifecycle !== "entitled") {
      await ctx.db.patch(existing._id, {
        lifecycle: "entitled",
        entitlementDigest: canonical.digest,
        lifecycleSequence: existing.lifecycleSequence + (semanticChanged ? 1 : 0),
        companyCount: existing.companyCount ?? 0,
        companyLimit: COMPANY_LIMIT,
        snapshotGeneration: existing.snapshotGeneration ?? 0,
        purgeGeneration:
          existing.lifecycle === "entitlement_lapsed"
            ? existing.purgeGeneration + 1
            : existing.purgeGeneration,
        purgePhase: "none",
        destructivePurgeStarted: false,
        pendingReactivation: false,
        updatedAt: now,
      });
      await scheduleScopedKeyCacheInvalidation(ctx, userId);
    }
    return ctx.db.get(existing._id);
  }

  // Once a generation has crossed the destructive boundary, later semantic
  // changes must stay on that same fence. Starting a fresh "pending" purge
  // would let a subsequent activation revive a partially scrubbed portfolio.
  if (existing.destructivePurgeStarted) {
    if (semanticChanged || existing.pendingReactivation) {
      await ctx.db.patch(existing._id, {
        entitlementDigest: canonical.digest,
        lifecycleSequence: existing.lifecycleSequence + (semanticChanged ? 1 : 0),
        pendingReactivation: false,
        updatedAt: now,
      });
      await scheduleScopedKeyCacheInvalidation(ctx, userId);
    }
    return ctx.db.get(existing._id);
  }

  if (semanticChanged || existing.lifecycle === "entitled") {
    const purgeGeneration = existing.purgeGeneration + 1;
    await ctx.db.patch(existing._id, {
      lifecycle: "entitlement_lapsed",
      entitlementDigest: canonical.digest,
      lifecycleSequence: existing.lifecycleSequence + (semanticChanged ? 1 : 0),
      purgeGeneration,
      purgePhase: "pending",
      destructivePurgeStarted: false,
      pendingReactivation: false,
      updatedAt: now,
    });
    await scheduleScopedKeyCacheInvalidation(ctx, userId);
    await scheduleAccountPurge(ctx, ownerFenceHash, purgeGeneration);
  }
  return ctx.db.get(existing._id);
}

/** Internal repair/test seam; production entitlement writers call the helper directly. */
export const syncStoredEntitlement = internalMutation({
  args: { userId: v.string() },
  handler: async (ctx, args) => syncCompanyMonitoringAccountFromEntitlement(ctx, args.userId),
});

async function terminalize(
  ctx: MutationCtx,
  ownerUserId: string,
  terminalReason: "owner_deleted" | "account_deleted",
  existing?: Doc<"companyMonitoringAccounts"> | null,
) {
  const ownerFence = await companyMonitoringOwnerFenceCandidates(ownerUserId);
  const ownerFenceHash = ownerFence.current;
  const match = await findAccountByOwnerFence(ctx, ownerFence);
  if (existing && match && existing._id !== match.account._id) {
    throw new ConvexError("ACCOUNT_OWNER_FENCE_CONFLICT");
  }
  const account = existing ?? match?.account ?? null;
  const now = Date.now();
  if (!account) {
    const purgeGeneration = 1;
    const id = await ctx.db.insert("companyMonitoringAccounts", {
      logicalAccountId: logicalId("account", now),
      ownerFenceHash,
      lifecycle: "denied",
      terminalReason,
      lifecycleSequence: 1,
      purgeGeneration,
      purgePhase: "pending",
      destructivePurgeStarted: true,
      pendingReactivation: false,
      createdAt: now,
      updatedAt: now,
    });
    await scheduleScopedKeyCacheInvalidation(ctx, ownerUserId);
    await scheduleAccountPurge(ctx, ownerFenceHash, purgeGeneration);
    return ctx.db.get(id);
  }
  if (account.terminalReason) return account;
  const purgeGeneration = account.purgeGeneration + 1;
  await ctx.db.patch(account._id, {
    ownerUserId: undefined,
    ownerFenceHash,
    lifecycle: "denied",
    terminalReason,
    entitlementDigest: undefined,
    lifecycleSequence: account.lifecycleSequence + 1,
    companyCount: undefined,
    companyLimit: undefined,
    snapshotGeneration: undefined,
    purgeGeneration,
    purgePhase: "pending",
    destructivePurgeStarted: true,
    pendingReactivation: false,
    purgeCursor: undefined,
    updatedAt: now,
  });
  await scheduleScopedKeyCacheInvalidation(ctx, ownerUserId);
  await scheduleAccountPurge(ctx, ownerFenceHash, purgeGeneration);
  return ctx.db.get(account._id);
}

export const markOwnerDeleted = internalMutation({
  args: { ownerUserId: v.string() },
  handler: async (ctx, args) => terminalize(ctx, args.ownerUserId, "owner_deleted"),
});

export const markAccountDeleted = internalMutation({
  args: { ownerAccountId: v.string() },
  handler: async (ctx, args) => {
    const account = await ctx.db
      .query("companyMonitoringAccounts")
      .withIndex("by_logicalAccountId", (q) => q.eq("logicalAccountId", args.ownerAccountId))
      .unique();
    if (!account || !account.ownerUserId) throw new ConvexError("ACCOUNT_NOT_FOUND");
    return terminalize(ctx, account.ownerUserId, "account_deleted", account);
  },
});

export const advanceAccountPurge = internalMutation({
  args: { ownerFenceHash: v.string(), purgeGeneration: v.number() },
  handler: async (ctx, args) => {
    const account = await ctx.db
      .query("companyMonitoringAccounts")
      .withIndex("by_ownerFenceHash", (q) => q.eq("ownerFenceHash", args.ownerFenceHash))
      .unique();
    if (!account || account.purgeGeneration !== args.purgeGeneration) return { status: "stale" };
    if (account.purgePhase === "none" || account.purgePhase === "complete") {
      return { status: "complete" };
    }

    const now = Date.now();
    if (account.purgePhase === "pending") {
      await ctx.db.patch(account._id, {
        purgePhase: "companies",
        destructivePurgeStarted: true,
        updatedAt: now,
      });
      await scheduleAccountPurge(ctx, args.ownerFenceHash, args.purgeGeneration);
      return { status: "started" };
    }

    if (account.purgePhase === "companies") {
      const page = await ctx.db
        .query("companyMonitoringCompanies")
        .withIndex("by_account_companyId", (q) => {
          const ownerQuery = q.eq("ownerAccountId", account.logicalAccountId);
          return account.purgeCursor
            ? ownerQuery.gt("companyId", account.purgeCursor)
            : ownerQuery;
        })
        .take(PURGE_BATCH_SIZE + 1);
      const batch = page.slice(0, PURGE_BATCH_SIZE);
      for (const company of batch) {
        await deleteCompanyClaims(ctx, account.logicalAccountId, company.companyId);
        await ctx.db.patch(company._id, {
          name: undefined,
          sortName: undefined,
          domicileCountry: undefined,
          customerReference: undefined,
          lifecycle: "removed",
          coverageState: undefined,
          observationState: undefined,
          purgeGeneration: args.purgeGeneration,
          purgePhase: "complete",
          removedAt: company.removedAt ?? now,
          updatedAt: now,
        });
      }
      const hasMore = page.length > PURGE_BATCH_SIZE;
      const nextPhase = hasMore ? "companies" : "finalizing";
      await ctx.db.patch(account._id, {
        purgePhase: nextPhase,
        purgeCursor: hasMore ? batch[batch.length - 1]?.companyId : undefined,
        updatedAt: now,
      });
      await scheduleAccountPurge(ctx, args.ownerFenceHash, args.purgeGeneration);
      return { status: nextPhase };
    }

    if (account.purgePhase === "finalizing") {
      if (account.pendingReactivation && account.ownerUserId && !account.terminalReason) {
        await ctx.db.patch(account._id, {
          lifecycle: "entitled",
          companyCount: 0,
          companyLimit: COMPANY_LIMIT,
          snapshotGeneration: (account.snapshotGeneration ?? 0) + 1,
          purgePhase: "none",
          destructivePurgeStarted: false,
          pendingReactivation: false,
          purgeCursor: undefined,
          updatedAt: now,
        });
        await scheduleScopedKeyCacheInvalidation(ctx, account.ownerUserId);
        return { status: "reactivated" };
      }
      await ctx.db.patch(account._id, {
        companyCount: account.terminalReason ? undefined : 0,
        companyLimit: account.terminalReason ? undefined : COMPANY_LIMIT,
        snapshotGeneration: account.terminalReason
          ? undefined
          : (account.snapshotGeneration ?? 0) + 1,
        purgePhase: "complete",
        pendingReactivation: false,
        purgeCursor: undefined,
        updatedAt: now,
      });
      return { status: "complete" };
    }

    return { status: "complete" };
  },
});
