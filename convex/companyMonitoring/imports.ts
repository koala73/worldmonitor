import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction, internalMutation } from "../_generated/server";
import {
  normalizeCompanyImportBatch,
  type CompanyImportRowInput,
  type NormalizedCompanyImportRow,
} from "../../shared/company-monitoring-contract";
import { COMPANY_LIMIT, fingerprint } from "./_shared";
import { requireProvisionedAccount } from "./accounts";
import { findNoopByCustomerReference, insertNormalizedCompany } from "./companies";
import { COMPANY_MONITORING_SCAN_COHORT_LIMIT } from "./orchestration";
import {
  companyImportRowInputValidator,
  normalizedCompanyImportRowValidator,
} from "./validators";

type ImportRowResult = {
  ordinal: number;
  status: "created" | "replayed" | "noop" | "rejected" | "conflict";
  companyId?: string;
  reason?: string;
};

type ImportRowMutationResult = ImportRowResult & { companyCount: number };
type InternalImportRowMutationResult = ImportRowMutationResult & { ownerAccountId: string };

export const importCompanyRowForOwner = internalMutation({
  args: {
    ownerUserId: v.string(),
    row: normalizedCompanyImportRowValidator,
    rowFingerprint: v.string(),
  },
  handler: async (ctx, args): Promise<InternalImportRowMutationResult> => {
    const account = await requireProvisionedAccount(ctx, args.ownerUserId);
    const row = args.row as NormalizedCompanyImportRow;
    const companyCount = account.companyCount ?? 0;
    const replay = await ctx.db
      .query("companyMonitoringCompanies")
      .withIndex("by_account_import_tuple", (q) =>
        q
          .eq("ownerAccountId", account.logicalAccountId)
          .eq("clientImportId", row.clientImportId)
          .eq("importOrdinal", row.ordinal),
      )
      .unique();
    if (replay) {
      return replay.importFingerprint === args.rowFingerprint
        ? {
            ordinal: row.ordinal,
            status: "replayed",
            companyId: replay.companyId,
            companyCount,
            ownerAccountId: account.logicalAccountId,
          }
        : {
            ordinal: row.ordinal,
            status: "conflict",
            reason: "REPLAY_CONFLICT",
            companyCount,
            ownerAccountId: account.logicalAccountId,
          };
    }

    // No-op rows intentionally do not consume the replay tuple. Retrying
    // must re-evaluate the current portfolio rather than replaying a stale
    // no-op if the original matching company was removed in the meantime.
    const noop = await findNoopByCustomerReference(
      ctx,
      account.logicalAccountId,
      row.customerReference,
    );
    if (noop) {
      return {
        ordinal: row.ordinal,
        status: "noop",
        companyId: noop.companyId,
        companyCount,
        ownerAccountId: account.logicalAccountId,
      };
    }

    if (companyCount >= (account.companyLimit ?? COMPANY_LIMIT)) {
      return {
        ordinal: row.ordinal,
        status: "rejected",
        reason: "COMPANY_LIMIT_REACHED",
        companyCount,
        ownerAccountId: account.logicalAccountId,
      };
    }

    const companyId = await insertNormalizedCompany(ctx, account, row, {
      clientImportId: row.clientImportId,
      importOrdinal: row.ordinal,
      importFingerprint: args.rowFingerprint,
    });
    const nextCompanyCount = companyCount + 1;
    await ctx.db.patch(account._id, {
      companyCount: nextCompanyCount,
      snapshotGeneration: (account.snapshotGeneration ?? 0) + 1,
      updatedAt: Date.now(),
    });
    return {
      ordinal: row.ordinal,
      status: "created",
      companyId,
      companyCount: nextCompanyCount,
      ownerAccountId: account.logicalAccountId,
    };
  },
});

export const importCompaniesForOwner = internalAction({
  args: { ownerUserId: v.string(), rows: v.array(companyImportRowInputValidator) },
  handler: async (ctx, args) => {
    const rows = normalizeCompanyImportBatch(args.rows as CompanyImportRowInput[]);
    const rowFingerprints = await Promise.all(rows.map((row) => fingerprint(row)));
    const results: ImportRowResult[] = [];
    const schedulableCompanyIds: string[] = [];
    let ownerAccountId: string | undefined;
    let companyCount = 0;

    for (const [index, row] of rows.entries()) {
      const result = await ctx.runMutation(
        internal.companyMonitoring.imports.importCompanyRowForOwner,
        {
          ownerUserId: args.ownerUserId,
          row,
          rowFingerprint: rowFingerprints[index]!,
        },
      ) as InternalImportRowMutationResult;
      companyCount = result.companyCount;
      ownerAccountId = result.ownerAccountId;
      if (
        (result.status === "created" || result.status === "replayed") &&
        result.companyId
      ) {
        schedulableCompanyIds.push(result.companyId);
      }
      const {
        companyCount: _companyCount,
        ownerAccountId: _ownerAccountId,
        ...rowResult
      } = result;
      results.push(rowResult);
    }

    // Imports already run one mutation per normalized row. Cohort created and
    // replayed rows into at most 25 IDs, then materialize two source work
    // items per cohort. Work-key replay heals an action interrupted after row
    // commits without duplicating work; no-op rows never join the cohort.
    if (ownerAccountId) {
      for (
        let offset = 0;
        offset < schedulableCompanyIds.length;
        offset += COMPANY_MONITORING_SCAN_COHORT_LIMIT
      ) {
        const companyIds = schedulableCompanyIds.slice(
          offset,
          offset + COMPANY_MONITORING_SCAN_COHORT_LIMIT,
        );
        for (const source of ["exa", "x"] as const) {
          await ctx.runMutation(internal.companyMonitoring.orchestration.ensureAccountWork, {
            ownerAccountId,
            source,
            companyIds,
          });
        }
      }
    }

    return { results, companyCount };
  },
});
