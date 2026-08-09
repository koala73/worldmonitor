import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import { internalMutation, internalQuery, type MutationCtx } from "../_generated/server";
import {
  normalizeMonitoredCompanyInput,
  normalizeCompanyClaimInput,
  assertCompanyClaimBudget,
  assertLogicalId,
  COMPANY_MONITORING_LIMITS,
  assertLifecycleTransition,
  type MonitoredCompanyInput,
  type NormalizedMonitoredCompanyInput,
} from "../../shared/company-monitoring-contract";
import {
  deleteCompanyClaims,
  fingerprint,
  insertClaims,
  logicalId,
  normalizeRequestId,
  requireActiveAccount,
  COMPANY_LIMIT,
} from "./_shared";
import { requireProvisionedAccount } from "./accounts";
import { companyPatchValidator, monitoredCompanyInputValidator } from "./validators";

type ReplayMetadata =
  | { directRequestId: string; directFingerprint: string }
  | { clientImportId: string; importOrdinal: number; importFingerprint: string };

export async function insertNormalizedCompany(
  ctx: MutationCtx,
  account: { logicalAccountId: string; snapshotGeneration?: number },
  company: NormalizedMonitoredCompanyInput,
  metadata: ReplayMetadata,
) {
  const now = Date.now();
  const companyId = logicalId("company", now);
  await ctx.db.insert("companyMonitoringCompanies", {
    ownerAccountId: account.logicalAccountId,
    companyId,
    name: company.name,
    sortName: company.name.toLocaleLowerCase("en-US"),
    domicileCountry: company.domicileCountry,
    customerReference: company.customerReference,
    lifecycle: "active",
    coverageState: "awaiting_first_scan",
    observationState: "unknown",
    snapshotGeneration: (account.snapshotGeneration ?? 0) + 1,
    ...metadata,
    purgeGeneration: 0,
    purgePhase: "none",
    createdAt: now,
    updatedAt: now,
  });
  await insertClaims(ctx, account.logicalAccountId, companyId, company, now);
  return companyId;
}

export async function findNoopByCustomerReference(
  ctx: MutationCtx,
  ownerAccountId: string,
  customerReference: string | undefined,
) {
  if (!customerReference) return null;
  const [active, paused] = await Promise.all([
    ctx.db
      .query("companyMonitoringCompanies")
      .withIndex("by_account_customerReference_lifecycle", (q) =>
        q
          .eq("ownerAccountId", ownerAccountId)
          .eq("customerReference", customerReference)
          .eq("lifecycle", "active"),
      )
      .first(),
    ctx.db
      .query("companyMonitoringCompanies")
      .withIndex("by_account_customerReference_lifecycle", (q) =>
        q
          .eq("ownerAccountId", ownerAccountId)
          .eq("customerReference", customerReference)
          .eq("lifecycle", "paused"),
      )
      .first(),
  ]);
  return active ?? paused;
}

// Adding the first company is a first-use entry point, so it provisions the
// root; update/setState/list resolve read-only because a company cannot exist
// without one.
export const createCompanyForOwner = internalMutation({
  args: {
    ownerUserId: v.string(),
    clientRequestId: v.string(),
    company: monitoredCompanyInputValidator,
  },
  handler: async (ctx, args) => {
    const account = await requireProvisionedAccount(ctx, args.ownerUserId);
    const clientRequestId = normalizeRequestId(args.clientRequestId);
    const company = normalizeMonitoredCompanyInput(args.company as MonitoredCompanyInput);
    const directFingerprint = await fingerprint({ version: "cm-direct-v1", company });

    const replay = await ctx.db
      .query("companyMonitoringCompanies")
      .withIndex("by_account_directRequestId", (q) =>
        q.eq("ownerAccountId", account.logicalAccountId).eq("directRequestId", clientRequestId),
      )
      .unique();
    if (replay) {
      if (replay.directFingerprint !== directFingerprint) {
        throw new ConvexError("REPLAY_CONFLICT");
      }
      return { status: "replayed", companyId: replay.companyId };
    }

    const noop = await findNoopByCustomerReference(
      ctx,
      account.logicalAccountId,
      company.customerReference,
    );
    if (noop) return { status: "noop", companyId: noop.companyId };

    const companyCount = account.companyCount ?? 0;
    if (companyCount >= (account.companyLimit ?? COMPANY_LIMIT)) {
      throw new ConvexError("COMPANY_LIMIT_REACHED");
    }

    const companyId = await insertNormalizedCompany(ctx, account, company, {
      directRequestId: clientRequestId,
      directFingerprint,
    });
    await ctx.db.patch(account._id, {
      companyCount: companyCount + 1,
      snapshotGeneration: (account.snapshotGeneration ?? 0) + 1,
      updatedAt: Date.now(),
    });
    return { status: "created", companyId };
  },
});

export const listCompaniesForOwner = internalQuery({
  args: { ownerUserId: v.string() },
  handler: async (ctx, args) => {
    const account = await requireActiveAccount(ctx, args.ownerUserId);
    const [active, paused] = await Promise.all([
      ctx.db
        .query("companyMonitoringCompanies")
        .withIndex("by_account_lifecycle_sortName", (q) =>
          q.eq("ownerAccountId", account.logicalAccountId).eq("lifecycle", "active"),
        )
        .collect(),
      ctx.db
        .query("companyMonitoringCompanies")
        .withIndex("by_account_lifecycle_sortName", (q) =>
          q.eq("ownerAccountId", account.logicalAccountId).eq("lifecycle", "paused"),
        )
        .collect(),
    ]);
    return [...active, ...paused]
      .sort((left, right) => (left.sortName ?? "").localeCompare(right.sortName ?? ""))
      .map((row) => ({
        companyId: row.companyId,
        name: row.name,
        domicileCountry: row.domicileCountry,
        customerReference: row.customerReference,
        lifecycle: row.lifecycle,
      }));
  },
});

export const updateCompanyForOwner = internalMutation({
  args: {
    ownerUserId: v.string(),
    companyId: v.string(),
    patch: companyPatchValidator,
  },
  handler: async (ctx, args) => {
    const account = await requireActiveAccount(ctx, args.ownerUserId);
    const company = await ctx.db
      .query("companyMonitoringCompanies")
      .withIndex("by_account_companyId", (q) =>
        q.eq("ownerAccountId", account.logicalAccountId).eq("companyId", args.companyId),
      )
      .unique();
    if (!company || company.lifecycle === "removed" || !company.name || !company.domicileCountry) {
      throw new ConvexError("NOT_FOUND");
    }
    const patch = args.patch;
    const addClaimInputs = patch.addClaims ?? [];
    const removeClaimInputs = patch.removeClaimIds ?? [];
    if (
      addClaimInputs.length > COMPANY_MONITORING_LIMITS.maxClaimsPerCompany ||
      removeClaimInputs.length > COMPANY_MONITORING_LIMITS.maxClaimsPerCompany
    ) {
      throw new ConvexError("INVALID_COMPANY_PATCH");
    }

    const hasName = Object.prototype.hasOwnProperty.call(patch, "name");
    const hasDomicile = Object.prototype.hasOwnProperty.call(patch, "domicileCountry");
    const hasCustomerReference = Object.prototype.hasOwnProperty.call(patch, "customerReference");
    const normalizedFields = normalizeMonitoredCompanyInput({
      name: hasName ? patch.name! : company.name,
      domicileCountry: hasDomicile ? patch.domicileCountry! : company.domicileCountry,
      customerReference: hasCustomerReference
        ? patch.customerReference
        : company.customerReference,
    });
    if (hasCustomerReference && normalizedFields.customerReference) {
      const conflict = await findNoopByCustomerReference(
        ctx,
        account.logicalAccountId,
        normalizedFields.customerReference,
      );
      if (conflict && conflict.companyId !== company.companyId) {
        throw new ConvexError("CUSTOMER_REFERENCE_CONFLICT");
      }
    }

    const currentClaims = await ctx.db
      .query("companyMonitoringClaims")
      .withIndex("by_account_company", (q) =>
        q.eq("ownerAccountId", account.logicalAccountId).eq("companyId", company.companyId),
      )
      .collect();
    const currentById = new Map(currentClaims.map((claim) => [claim.claimId, claim]));
    const removeIds = new Set(
      removeClaimInputs.map((claimId) => assertLogicalId("claim", String(claimId))),
    );
    for (const claimId of removeIds) {
      if (!currentById.has(claimId)) throw new ConvexError("CLAIM_NOT_FOUND");
    }
    if (hasCustomerReference && normalizedFields.customerReference !== company.customerReference) {
      for (const claim of currentClaims) {
        if (claim.type === "customer_reference") removeIds.add(claim.claimId);
      }
    }

    const remainingKeys = new Set(
      currentClaims
        .filter((claim) => !removeIds.has(claim.claimId))
        .map((claim) => `${claim.type}\u0000${claim.value}`),
    );
    const normalizedAdditions = addClaimInputs.map(normalizeCompanyClaimInput);
    if (hasCustomerReference && normalizedFields.customerReference) {
      normalizedAdditions.push({
        type: "customer_reference",
        value: normalizedFields.customerReference,
      });
    }
    const additions = normalizedAdditions.filter((claim) => {
      const key = `${claim.type}\u0000${claim.value}`;
      if (remainingKeys.has(key)) return false;
      remainingKeys.add(key);
      return true;
    });
    assertCompanyClaimBudget({
      currentCount: currentClaims.length,
      removedCount: removeIds.size,
      addedCount: additions.length,
    });

    const fieldsChanged =
      normalizedFields.name !== company.name ||
      normalizedFields.domicileCountry !== company.domicileCountry ||
      normalizedFields.customerReference !== company.customerReference;
    if (!fieldsChanged && removeIds.size === 0 && additions.length === 0) {
      return { status: "unchanged", companyId: company.companyId };
    }

    const now = Date.now();
    for (const claimId of removeIds) await ctx.db.delete(currentById.get(claimId)!._id);
    for (const claim of additions) {
      await ctx.db.insert("companyMonitoringClaims", {
        ownerAccountId: account.logicalAccountId,
        companyId: company.companyId,
        claimId: logicalId("claim", now),
        ...claim,
        provenance: "customer",
        trustState: "unverified",
        createdAt: now,
        updatedAt: now,
      });
    }
    await ctx.db.patch(company._id, {
      name: normalizedFields.name,
      sortName: normalizedFields.name.toLocaleLowerCase("en-US"),
      domicileCountry: normalizedFields.domicileCountry,
      customerReference: normalizedFields.customerReference,
      snapshotGeneration: company.snapshotGeneration + 1,
      updatedAt: now,
    });
    await ctx.db.patch(account._id, {
      snapshotGeneration: (account.snapshotGeneration ?? 0) + 1,
      updatedAt: now,
    });
    return { status: "updated", companyId: company.companyId };
  },
});

export const setCompanyStateForOwner = internalMutation({
  args: {
    ownerUserId: v.string(),
    companyId: v.string(),
    state: v.union(v.literal("active"), v.literal("paused"), v.literal("removed")),
  },
  handler: async (ctx, args) => {
    const account = await requireActiveAccount(ctx, args.ownerUserId);
    const company = await ctx.db
      .query("companyMonitoringCompanies")
      .withIndex("by_account_companyId", (q) =>
        q.eq("ownerAccountId", account.logicalAccountId).eq("companyId", args.companyId),
      )
      .unique();
    if (!company) throw new ConvexError("NOT_FOUND");
    try {
      assertLifecycleTransition("company", company.lifecycle, args.state);
    } catch {
      throw new ConvexError("REMOVED_COMPANY_IS_TERMINAL");
    }
    if (company.lifecycle === "removed") {
      if (args.state === "removed") return { status: "already_removed", companyId: company.companyId };
      throw new ConvexError("REMOVED_COMPANY_IS_TERMINAL");
    }
    if (company.lifecycle === args.state) return { status: "unchanged", companyId: company.companyId };

    const now = Date.now();
    if (args.state !== "removed") {
      await ctx.db.patch(company._id, {
        lifecycle: args.state,
        snapshotGeneration: company.snapshotGeneration + 1,
        updatedAt: now,
      });
      await ctx.db.patch(account._id, {
        snapshotGeneration: (account.snapshotGeneration ?? 0) + 1,
        updatedAt: now,
      });
      return { status: args.state, companyId: company.companyId };
    }

    const purgeGeneration = company.purgeGeneration + 1;
    await deleteCompanyClaims(ctx, account.logicalAccountId, company.companyId);
    await ctx.db.patch(company._id, {
      lifecycle: "removed",
      removedAt: now,
      purgeGeneration,
      purgePhase: "payload",
      snapshotGeneration: company.snapshotGeneration + 1,
      updatedAt: now,
    });
    await ctx.db.patch(account._id, {
      companyCount: Math.max(0, (account.companyCount ?? 0) - 1),
      snapshotGeneration: (account.snapshotGeneration ?? 0) + 1,
      updatedAt: now,
    });
    await ctx.scheduler.runAfter(
      0,
      internal.companyMonitoring.companies.advanceCompanyPurge,
      {
        ownerAccountId: account.logicalAccountId,
        companyId: company.companyId,
        purgeGeneration,
      },
    );
    return { status: "removed", companyId: company.companyId };
  },
});

export const advanceCompanyPurge = internalMutation({
  args: {
    ownerAccountId: v.string(),
    companyId: v.string(),
    purgeGeneration: v.number(),
  },
  handler: async (ctx, args) => {
    const company = await ctx.db
      .query("companyMonitoringCompanies")
      .withIndex("by_account_companyId", (q) =>
        q.eq("ownerAccountId", args.ownerAccountId).eq("companyId", args.companyId),
      )
      .unique();
    if (
      !company ||
      company.lifecycle !== "removed" ||
      company.purgeGeneration !== args.purgeGeneration
    ) {
      return { status: "stale" };
    }
    if (company.purgePhase === "complete") return { status: "complete" };
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
      coverageState: undefined,
      observationState: undefined,
      purgePhase: "complete",
      updatedAt: Date.now(),
    });
    return { status: "complete" };
  },
});
