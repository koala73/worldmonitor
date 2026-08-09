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
import {
  activeAccountForOwner,
  COMPANY_LIMIT,
  deleteCompanyClaims,
  fingerprint,
  logicalId,
} from "./_shared";
import { purgeAccountScanStateBatch } from "./orchestration";

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
// Ordinary billing lapses wait one full day before destructive work. This
// matches the daily missed-renewal reconciliation bound: a lost successful
// renewal webhook gets one authoritative Dodo sweep before customer data is
// scrubbed. Explicit owner/account deletion bypasses this grace.
const ORDINARY_LAPSE_PURGE_GRACE_MS = 24 * 60 * 60 * 1000;
const STALLED_PURGE_AGE_MS = 60 * 60 * 1000;
const STALLED_PURGE_REAPER_BATCH_SIZE = 50;
// Entitled roots are re-derived from the entitlements row on this cadence.
// Detection latency is bounded by (age + cron period) and is absorbed by the
// 24h purgeAfter grace that already delays destructive work.
const ENTITLED_RECHECK_AGE_MS = 60 * 60 * 1000;
const ENTITLED_RECHECK_BATCH_SIZE = 50;
const REAPABLE_PURGE_PHASES = ["finalizing", "companies", "scan", "pending"] as const;
// Both directions: "entitled" rows may need lapsing, "entitlement_lapsed" rows
// may need restoring after a late renewal. "denied" is terminal and excluded.
const RECONCILABLE_LIFECYCLES = ["entitled", "entitlement_lapsed"] as const;

async function canonicalEntitlement(ctx: MutationCtx, userId: string) {
  const entitlement = await ctx.db
    .query("entitlements")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .first();
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
    internal.payments.cacheActions.invalidateUserApiKeyCaches,
    { keyHashes },
  );
}

async function scheduleAccountPurge(
  ctx: MutationCtx,
  ownerFenceHash: string,
  purgeGeneration: number,
  delayMs = 0,
) {
  await ctx.scheduler.runAfter(
    Math.max(0, delayMs),
    internal.companyMonitoring.accounts.advanceAccountPurge,
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

async function findAccountByOwnerUserId(
  ctx: MutationCtx,
  ownerUserId: string,
): Promise<Doc<"companyMonitoringAccounts"> | null> {
  const accounts = await ctx.db
    .query("companyMonitoringAccounts")
    .withIndex("by_ownerUserId", (q) => q.eq("ownerUserId", ownerUserId))
    .take(2);
  if (accounts.length > 1) throw new ConvexError("ACCOUNT_OWNER_FENCE_CONFLICT");
  return accounts[0] ?? null;
}

/** Apply the canonical stored entitlement to the single keyed account root. */
export async function syncCompanyMonitoringAccountFromEntitlement(
  ctx: MutationCtx,
  userId: string,
) {
  // Browser UUID purchases are deliberately invisible to Company Monitoring
  // until claimSubscription has recomputed the real authenticated owner.
  if (ANON_ID_V4_REGEX.test(userId)) return null;
  // Throws on a misconfigured fence keyring, which is correct now that this
  // runs only from Company Monitoring's own entry points (#6256): the caller is
  // actively using the feature, so failing loudly beats silently skipping.
  // The degrade path this used to need existed only because entitlement writes
  // called in here.
  const canonical = await canonicalEntitlement(ctx, userId);
  const ownerFence = await companyMonitoringOwnerFenceCandidates(userId);
  const ownerFenceHash = ownerFence.current;
  const match = await findAccountByOwnerFence(ctx, ownerFence);
  // The owner binding is the invariant that survives an operator dropping an
  // old fence key from history. Reconcile it before insert so a scheduled sync
  // migrates the one nonterminal root instead of creating a duplicate root.
  const ownerAccount = await findAccountByOwnerUserId(ctx, userId);
  if (match && ownerAccount && match.account._id !== ownerAccount._id) {
    throw new ConvexError("ACCOUNT_OWNER_FENCE_CONFLICT");
  }
  let existing = match?.account ?? ownerAccount;

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

  if (existing.ownerFenceHash !== ownerFenceHash) {
    await ctx.db.patch(existing._id, { ownerFenceHash });
    if (existing.purgePhase !== "none" && existing.purgePhase !== "complete") {
      // Jobs scheduled before rotation still carry the old hash and will become
      // stale after migration. Seed the same generation under the current key.
      const delayMs = existing.purgePhase === "pending" && existing.purgeAfter
        ? existing.purgeAfter - Date.now()
        : 0;
      await scheduleAccountPurge(ctx, ownerFenceHash, existing.purgeGeneration, delayMs);
    }
    existing = { ...existing, ownerFenceHash };
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
      purgeAfter: undefined,
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
        purgeAfter: undefined,
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
    const purgeAfter = now + ORDINARY_LAPSE_PURGE_GRACE_MS;
    await ctx.db.patch(existing._id, {
      lifecycle: "entitlement_lapsed",
      entitlementDigest: canonical.digest,
      lifecycleSequence: existing.lifecycleSequence + (semanticChanged ? 1 : 0),
      purgeGeneration,
      purgePhase: "pending",
      destructivePurgeStarted: false,
      pendingReactivation: false,
      purgeAfter,
      updatedAt: now,
    });
    await scheduleScopedKeyCacheInvalidation(ctx, userId);
    await scheduleAccountPurge(
      ctx,
      ownerFenceHash,
      purgeGeneration,
      ORDINARY_LAPSE_PURGE_GRACE_MS,
    );
  }
  return ctx.db.get(existing._id);
}

/** Internal repair/test seam; nothing on the entitlement write path calls this. */
export const syncStoredEntitlement = internalMutation({
  args: { userId: v.string() },
  handler: async (ctx, args) => syncCompanyMonitoringAccountFromEntitlement(ctx, args.userId),
});

/**
 * Resolve the caller's account root, provisioning it on first use.
 *
 * This is the lazy half of #6256: entitlement writes no longer push a root at
 * every subscriber, so the root is created the first time someone actually
 * uses Company Monitoring. Mutation-only by construction — `activeAccountForOwner`
 * stays the read-only resolver for query callers such as
 * `apiKeys.validateKeyByHash`, which cannot write.
 *
 * Provisioning delegates to the same state machine the reaper uses, so a
 * terminal tombstone still refuses to yield an active account: the sync returns
 * the terminal row untouched and the re-resolve below rejects it.
 */
export async function ensureActiveAccount(
  ctx: MutationCtx,
  ownerUserId: string,
  knownEntitlement?: Doc<"entitlements"> | null,
) {
  const existing = await activeAccountForOwner(ctx, ownerUserId, knownEntitlement);
  if (existing) return existing;
  await syncCompanyMonitoringAccountFromEntitlement(ctx, ownerUserId);
  return activeAccountForOwner(ctx, ownerUserId, knownEntitlement);
}

/** `requireActiveAccount` for the entry points that may provision. */
export async function requireProvisionedAccount(ctx: MutationCtx, ownerUserId: string) {
  const account = await ensureActiveAccount(ctx, ownerUserId);
  if (!account) throw new ConvexError("COMPANY_MONITORING_ACCESS_DENIED");
  return account;
}

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
      purgeAfter: undefined,
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
    purgeAfter: undefined,
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
      const isOrdinaryLapse = !account.terminalReason && account.lifecycle !== "denied";
      const purgeAfter = account.purgeAfter ?? account.updatedAt + ORDINARY_LAPSE_PURGE_GRACE_MS;
      if (isOrdinaryLapse && account.purgeAfter === undefined) {
        // Backfill a deadline for any pending row written before purgeAfter was
        // introduced. Do not move updatedAt: the reaper still needs its age.
        await ctx.db.patch(account._id, { purgeAfter });
      }
      if (isOrdinaryLapse && now < purgeAfter) {
        await scheduleAccountPurge(
          ctx,
          args.ownerFenceHash,
          args.purgeGeneration,
          purgeAfter - now,
        );
        return { status: "waiting", purgeAfter };
      }
      // Last line of defence before anything irreversible. The 24h grace exists
      // so a late renewal can land first, and entitlement writes no longer push
      // that restoration in (#6256) — so re-derive it here rather than trusting
      // a lifecycle set up to a full reconciler sweep ago. The finalizing branch
      // already does this recheck; by then the payload is gone.
      if (isOrdinaryLapse && account.ownerUserId) {
        const canonical = await canonicalEntitlement(ctx, account.ownerUserId);
        if (canonical.active) {
          await syncCompanyMonitoringAccountFromEntitlement(ctx, account.ownerUserId);
          return { status: "reactivated" };
        }
      }
      const scanPurge = await purgeAccountScanStateBatch(ctx, account.logicalAccountId);
      await ctx.db.patch(account._id, {
        purgePhase: scanPurge.complete ? "companies" : "scan",
        destructivePurgeStarted: true,
        purgeAfter: undefined,
        updatedAt: now,
      });
      await scheduleAccountPurge(ctx, args.ownerFenceHash, args.purgeGeneration);
      return { status: "started" };
    }

    if (account.purgePhase === "scan") {
      const scanPurge = await purgeAccountScanStateBatch(ctx, account.logicalAccountId);
      if (!scanPurge.complete) {
        await ctx.db.patch(account._id, { updatedAt: now });
        await scheduleAccountPurge(ctx, args.ownerFenceHash, args.purgeGeneration);
        return { status: "scan" };
      }
      await ctx.db.patch(account._id, { purgePhase: "companies", updatedAt: now });
      await scheduleAccountPurge(ctx, args.ownerFenceHash, args.purgeGeneration);
      return { status: "companies" };
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
          directRequestId: undefined,
          directFingerprint: undefined,
          clientImportId: undefined,
          importOrdinal: undefined,
          importFingerprint: undefined,
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
      const canonical = account.ownerUserId && !account.terminalReason
        ? await canonicalEntitlement(ctx, account.ownerUserId)
        : null;
      const canonicalChanged = Boolean(
        canonical && account.entitlementDigest !== canonical.digest,
      );
      if (account.pendingReactivation && account.ownerUserId && canonical?.active) {
        await ctx.db.patch(account._id, {
          lifecycle: "entitled",
          entitlementDigest: canonical.digest,
          lifecycleSequence: account.lifecycleSequence + (canonicalChanged ? 1 : 0),
          companyCount: 0,
          companyLimit: COMPANY_LIMIT,
          snapshotGeneration: (account.snapshotGeneration ?? 0) + 1,
          purgePhase: "none",
          destructivePurgeStarted: false,
          pendingReactivation: false,
          purgeAfter: undefined,
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
        entitlementDigest: canonical?.digest ?? account.entitlementDigest,
        lifecycleSequence: account.lifecycleSequence + (canonicalChanged ? 1 : 0),
        purgePhase: "complete",
        pendingReactivation: false,
        purgeAfter: undefined,
        purgeCursor: undefined,
        updatedAt: now,
      });
      return { status: "complete" };
    }

    return { status: "complete" };
  },
});

/** Hourly bounded recovery for purge jobs lost after their account transition. */
export const reapStalledAccountPurges = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const staleBefore = now - STALLED_PURGE_AGE_MS;
    let remaining = STALLED_PURGE_REAPER_BATCH_SIZE;
    let scanned = 0;
    let scheduled = 0;
    let deferred = 0;

    for (const purgePhase of REAPABLE_PURGE_PHASES) {
      if (remaining === 0) break;
      const accounts = await ctx.db
        .query("companyMonitoringAccounts")
        .withIndex("by_purgePhase_updatedAt", (q) =>
          q.eq("purgePhase", purgePhase).lt("updatedAt", staleBefore),
        )
        .take(remaining);
      scanned += accounts.length;
      remaining -= accounts.length;

      for (const account of accounts) {
        if (purgePhase === "pending" && !account.terminalReason) {
          const purgeAfter = account.purgeAfter ??
            account.updatedAt + ORDINARY_LAPSE_PURGE_GRACE_MS;
          if (account.purgeAfter === undefined) {
            await ctx.db.patch(account._id, { purgeAfter });
          }
          if (now < purgeAfter) {
            deferred += 1;
            continue;
          }
        }
        await ctx.db.patch(account._id, { updatedAt: now });
        await scheduleAccountPurge(ctx, account.ownerFenceHash, account.purgeGeneration);
        scheduled += 1;
      }
    }

    return { scanned, scheduled, deferred };
  },
});

/**
 * Pull-side replacement for the entitlement-write push removed in #6256.
 *
 * Scans entitled roots oldest-first and re-derives each owner's canonical
 * entitlement. `syncCompanyMonitoringAccountFromEntitlement` is the same state
 * machine first-use provisioning calls, so a lapse transitions and schedules
 * purge here exactly as it used to when billing drove it.
 *
 * Scanning `companyMonitoringAccounts` rather than `entitlements` is the whole
 * point: this table holds only owners who actually use the feature, so
 * subscribers who never touch Company Monitoring cost nothing.
 */
export const reconcileAccountEntitlements = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const staleBefore = now - ENTITLED_RECHECK_AGE_MS;
    let remaining = ENTITLED_RECHECK_BATCH_SIZE;
    let scanned = 0;
    let scheduled = 0;

    const scanLifecycle = async (
      lifecycle: (typeof RECONCILABLE_LIFECYCLES)[number],
      limit: number,
    ) => {
      if (limit === 0) return 0;
      const accounts = await ctx.db
        .query("companyMonitoringAccounts")
        .withIndex("by_lifecycle_updatedAt", (q) =>
          q.eq("lifecycle", lifecycle).lt("updatedAt", staleBefore),
        )
        .take(limit);

      for (const account of accounts) {
        scanned += 1;
        // Advance the cursor FIRST and unconditionally, including for rows we
        // skip — otherwise a skipped row keeps its slot at the head of the
        // index forever and starves everything behind it.
        await ctx.db.patch(account._id, { updatedAt: now });
        const ownerUserId = account.ownerUserId;
        // A terminal row never carries an owner; skip rather than resurrect.
        if (!ownerUserId || account.terminalReason) continue;
        // Schedule rather than sync inline: this is one transaction over 50
        // rows, so an inline throw (a fence conflict is reachable) would roll
        // back every cursor advance and stall lapse detection fleet-wide,
        // permanently. Per-row scheduling costs one bad row per sweep instead.
        // Same shape as reapStalledAccountPurges.
        await ctx.scheduler.runAfter(
          0,
          internal.companyMonitoring.accounts.syncStoredEntitlement,
          { userId: ownerUserId },
        );
        scheduled += 1;
      }
      return accounts.length;
    };

    // BOTH directions. Reserve half the shared budget for each lifecycle so a
    // full entitled bucket cannot starve late renewals forever. The second
    // bucket can spend unused capacity from the first; if it also has spare,
    // the first bucket receives the remainder. Each query remains oldest-first,
    // and scanLifecycle advances every fetched row before a later page runs.
    const reservedPerLifecycle = Math.floor(
      ENTITLED_RECHECK_BATCH_SIZE / RECONCILABLE_LIFECYCLES.length,
    );
    const firstLifecycle = RECONCILABLE_LIFECYCLES[0];
    const secondLifecycle = RECONCILABLE_LIFECYCLES[1];

    const firstScanned = await scanLifecycle(firstLifecycle, reservedPerLifecycle);
    remaining -= firstScanned;
    const secondScanned = await scanLifecycle(secondLifecycle, remaining);
    remaining -= secondScanned;
    if (remaining > 0) {
      remaining -= await scanLifecycle(firstLifecycle, remaining);
    }

    return { scanned, scheduled };
  },
});
