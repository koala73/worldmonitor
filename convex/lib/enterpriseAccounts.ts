/**
 * Read helpers for Enterprise contract accounts (convex/enterpriseAccounts.ts
 * holds the operator mutations). Kept dependency-free so the entitlement
 * recompute, the edge entitlement query, the AI routing lookup and the
 * plan-limit scan can all import them without an import cycle.
 */

import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

type ReadCtx = Pick<QueryCtx, "db">;

/** The `account` block the edge entitlement carries for a live member. */
export type EnterpriseAccountBlock = {
  id: Id<"enterpriseAccounts">;
  dailyAllowance: number;
  perMinuteBurst: number;
  breakerMultiple: number;
  monthlyInputTokens: number;
  monthlyOutputTokens: number;
};

/** What the AI routing lookup returns. Account fields appear only for active members. */
export type AiRoutingPolicy = {
  allowedProviders: string[];
  accountId?: Id<"enterpriseAccounts">;
  monthlyInputTokens?: number;
  monthlyOutputTokens?: number;
  breakerMultiple?: number;
};

/** A contract is live on [contractStart, contractEnd). */
export function isContractLive(
  account: Pick<Doc<"enterpriseAccounts">, "contractStart" | "contractEnd">,
  at: number,
): boolean {
  return account.contractStart <= at && at < account.contractEnd;
}

export function toAccountBlock(account: Doc<"enterpriseAccounts">): EnterpriseAccountBlock {
  return {
    id: account._id,
    dailyAllowance: account.dailyRequestAllowance,
    perMinuteBurst: account.perMinuteBurst,
    breakerMultiple: account.breakerMultiple,
    monthlyInputTokens: account.monthlyInputTokens,
    monthlyOutputTokens: account.monthlyOutputTokens,
  };
}

/**
 * Accounts where the user is an ACTIVE member, whatever the contract state.
 * Sorted by contractEnd descending, then id, so every reader picks the same
 * account if an operator ever leaves a user in two (the add mutation refuses
 * that).
 */
export async function activeMemberAccounts(
  ctx: ReadCtx,
  userId: string,
): Promise<Array<Doc<"enterpriseAccounts">>> {
  const rows = await ctx.db
    .query("enterpriseMembers")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .collect();
  const accounts: Array<Doc<"enterpriseAccounts">> = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.status !== "active" || seen.has(row.accountId)) continue;
    seen.add(row.accountId);
    const account = await ctx.db.get(row.accountId);
    if (account) accounts.push(account);
  }
  return accounts.sort((a, b) =>
    b.contractEnd - a.contractEnd || (a._id < b._id ? -1 : a._id > b._id ? 1 : 0));
}

/** The live-contract account a member draws from at `at`, if any. */
export async function liveMemberAccount(
  ctx: ReadCtx,
  userId: string,
  at: number,
): Promise<Doc<"enterpriseAccounts"> | null> {
  const accounts = await activeMemberAccounts(ctx, userId);
  return accounts.find((account) => isContractLive(account, at)) ?? null;
}

/** Entitlement-recompute candidate: Enterprise until contract end, only while the contract is live. */
export async function enterpriseMembershipCandidate(
  ctx: ReadCtx,
  userId: string,
  at: number,
): Promise<{ planKey: string; currentPeriodEnd: number } | null> {
  const account = await liveMemberAccount(ctx, userId, at);
  return account ? { planKey: "enterprise", currentPeriodEnd: account.contractEnd } : null;
}

export async function liveAccountBlockForUser(
  ctx: ReadCtx,
  userId: string,
  at: number,
): Promise<EnterpriseAccountBlock | null> {
  const account = await liveMemberAccount(ctx, userId, at);
  return account ? toAccountBlock(account) : null;
}

/**
 * The AI routing policy that applies to a user's own input.
 *
 * A per-user `aiRoutingPolicies` row decides the providers when present.
 * Otherwise an active membership in any account (live or ended contract)
 * supplies the account's providers; with several, only providers every one of
 * them allows survive, so a stray second membership can only narrow routing.
 * `null` means unrestricted.
 */
export async function resolveAiRoutingPolicy(
  ctx: ReadCtx,
  userId: string,
): Promise<AiRoutingPolicy | null> {
  const row = await ctx.db
    .query("aiRoutingPolicies")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .first();
  const accounts = await activeMemberAccounts(ctx, userId);
  const primary = accounts[0];
  if (!row && !primary) return null;
  // A provider is allowed only when the per-user row (if any) and every
  // account the user belongs to allow it. A per-user row can narrow an
  // account's contract policy but never widen it (Hexion clause 6.1).
  const candidates = row ? row.allowedProviders : primary!.allowedProviders;
  const allowedProviders = candidates.filter((provider) =>
    accounts.every((account) => account.allowedProviders.includes(provider)));
  if (!primary) return { allowedProviders };
  return {
    allowedProviders,
    accountId: primary._id,
    monthlyInputTokens: primary.monthlyInputTokens,
    monthlyOutputTokens: primary.monthlyOutputTokens,
    breakerMultiple: primary.breakerMultiple,
  };
}

/** userIds with an active membership in a contract live at `at`. */
export async function liveEnterpriseMemberUserIds(ctx: ReadCtx, at: number): Promise<Set<string>> {
  const rows = await ctx.db
    .query("enterpriseMembers")
    .withIndex("by_status", (q) => q.eq("status", "active"))
    .collect();
  const accounts = new Map<string, Doc<"enterpriseAccounts"> | null>();
  const out = new Set<string>();
  for (const row of rows) {
    if (!row.userId) continue;
    if (!accounts.has(row.accountId)) accounts.set(row.accountId, await ctx.db.get(row.accountId));
    const account = accounts.get(row.accountId);
    if (account && isContractLive(account, at)) out.add(row.userId);
  }
  return out;
}
