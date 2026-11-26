import { ConvexError, v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { COMPANY_MONITORING_LIMITS } from "../../shared/company-monitoring-contract";
import {
  COMPANY_MONITORING_CLAIM_POLICY_VERSION,
  customerClaimAllowedUses,
  hasCurrentCompanyMonitoringClaimPolicy,
  logicalId,
} from "./_shared";

export const CLAIM_POLICY_MIGRATION_COMPANY_PAGE_SIZE = 25;
const CLAIM_READ_LIMIT = COMPANY_MONITORING_LIMITS.maxClaimsPerCompany + 1;

/**
 * Repair one bounded company page for one account.
 *
 * The caller threads `nextCursor` through later invocations. New writes already
 * carry the current policy, so companies created while this sequence runs do
 * not need to be captured by the legacy page walk. The account version is
 * written only after Convex reports the final company page complete.
 */
export const migrateAccountClaimPolicy = internalMutation({
  args: {
    ownerAccountId: v.string(),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const account = await ctx.db
      .query("companyMonitoringAccounts")
      .withIndex("by_logicalAccountId", (q) =>
        q.eq("logicalAccountId", args.ownerAccountId)
      )
      .unique();
    if (!account) throw new ConvexError("COMPANY_MONITORING_ACCOUNT_NOT_FOUND");
    if (hasCurrentCompanyMonitoringClaimPolicy(account)) {
      return {
        status: "complete" as const,
        companiesProcessed: 0,
        claimsPatched: 0,
        aliasesInserted: 0,
        aliasesSkippedAtCap: 0,
        nextCursor: null,
        claimPolicyVersion: account.claimPolicyVersion,
      };
    }

    const page = await ctx.db
      .query("companyMonitoringCompanies")
      .withIndex("by_account_companyId", (q) =>
        q.eq("ownerAccountId", args.ownerAccountId)
      )
      .paginate({
        cursor: args.cursor ?? null,
        numItems: CLAIM_POLICY_MIGRATION_COMPANY_PAGE_SIZE,
      });

    const now = Date.now();
    let claimsPatched = 0;
    let aliasesInserted = 0;
    let aliasesSkippedAtCap = 0;
    for (const company of page.page) {
      if (company.lifecycle === "removed" || company.purgePhase !== "none") continue;
      const claims = await ctx.db
        .query("companyMonitoringClaims")
        .withIndex("by_account_company", (q) =>
          q
            .eq("ownerAccountId", args.ownerAccountId)
            .eq("companyId", company.companyId)
        )
        .take(CLAIM_READ_LIMIT);
      if (claims.length > COMPANY_MONITORING_LIMITS.maxClaimsPerCompany) {
        throw new ConvexError("COMPANY_MONITORING_CLAIM_LIMIT_EXCEEDED");
      }

      for (const claim of claims) {
        if (claim.provenance !== "customer" || claim.allowedUses !== undefined) continue;
        await ctx.db.patch(claim._id, {
          allowedUses: [...customerClaimAllowedUses(claim.type)],
          updatedAt: now,
        });
        claimsPatched += 1;
      }

      const hasCurrentNameAlias = company.name !== undefined && claims.some((claim) =>
        claim.provenance === "customer" &&
        claim.type === "alias" &&
        claim.value === company.name
      );
      if (company.name !== undefined && !hasCurrentNameAlias) {
        if (claims.length >= COMPANY_MONITORING_LIMITS.maxClaimsPerCompany) {
          // A company sitting exactly at the cap is a legal state —
          // `assertCompanyClaimBudget` accepts a resulting count of
          // `maxClaimsPerCompany` — so there is no invariant to fail on here.
          // The genuine invariant guard is the `claims.length > max` check
          // above. Throwing instead rolled back the whole page: the
          // `allowedUses` patches for every other company were discarded,
          // `claimPolicyVersion` was never stamped, and every retry of the
          // same cursor hit this company and threw again, so the account's
          // monitoring stayed permanently blocked behind
          // COMPANY_MONITORING_CLAIM_POLICY_MIGRATION_REQUIRED with no
          // self-healing path. The alias is a convenience; skip it, count it,
          // and let the account finish migrating.
          aliasesSkippedAtCap += 1;
          continue;
        }
        await ctx.db.insert("companyMonitoringClaims", {
          ownerAccountId: args.ownerAccountId,
          companyId: company.companyId,
          claimId: logicalId("claim", now),
          type: "alias",
          value: company.name,
          provenance: "customer",
          trustState: "unverified",
          allowedUses: [...customerClaimAllowedUses("alias")],
          createdAt: now,
          updatedAt: now,
        });
        aliasesInserted += 1;
      }
    }

    if (page.isDone) {
      await ctx.db.patch(account._id, {
        claimPolicyVersion: COMPANY_MONITORING_CLAIM_POLICY_VERSION,
        updatedAt: now,
      });
      return {
        status: "complete" as const,
        companiesProcessed: page.page.length,
        claimsPatched,
        aliasesInserted,
        aliasesSkippedAtCap,
        nextCursor: null,
        claimPolicyVersion: COMPANY_MONITORING_CLAIM_POLICY_VERSION,
      };
    }

    return {
      status: "in_progress" as const,
      companiesProcessed: page.page.length,
      claimsPatched,
      aliasesInserted,
      aliasesSkippedAtCap,
      nextCursor: page.continueCursor,
      claimPolicyVersion: null,
    };
  },
});
