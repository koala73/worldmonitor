import { v } from "convex/values";
import { COMPANY_MONITORING_IMPORT_VERSION } from "../../shared/company-monitoring-contract";

const monitoredCompanyInputFields = {
  name: v.string(),
  domicileCountry: v.string(),
  aliases: v.optional(v.array(v.string())),
  domains: v.optional(v.array(v.string())),
  identifiers: v.optional(v.array(v.string())),
  xHandles: v.optional(v.array(v.string())),
  locations: v.optional(v.array(v.string())),
  customerReference: v.optional(v.string()),
};

export const monitoredCompanyInputValidator = v.object(monitoredCompanyInputFields);

export const companyImportRowInputValidator = v.object({
  ...monitoredCompanyInputFields,
  clientImportId: v.string(),
  ordinal: v.number(),
});

export const normalizedCompanyImportRowValidator = v.object({
  name: v.string(),
  domicileCountry: v.union(v.literal("US"), v.literal("GB")),
  aliases: v.array(v.string()),
  domains: v.array(v.string()),
  identifiers: v.array(v.string()),
  xHandles: v.array(v.string()),
  locations: v.array(v.string()),
  customerReference: v.optional(v.string()),
  contractVersion: v.literal(COMPANY_MONITORING_IMPORT_VERSION),
  clientImportId: v.string(),
  ordinal: v.number(),
});

export const companyPatchValidator = v.object({
  name: v.optional(v.string()),
  domicileCountry: v.optional(v.string()),
  customerReference: v.optional(v.string()),
  addClaims: v.optional(v.array(v.object({
    type: v.string(),
    value: v.string(),
  }))),
  removeClaimIds: v.optional(v.array(v.string())),
});

export const companyMonitoringScanSourceValidator = v.union(
  v.literal("exa"),
  v.literal("x"),
);

export const companyMonitoringProviderErrorReasonValidator = v.union(
  v.literal("timeout"),
  v.literal("rate_limited"),
  v.literal("authentication_failed"),
  v.literal("provider_unavailable"),
  v.literal("request_rejected"),
);

export const companyMonitoringNonReassuringReasonValidator = v.union(
  v.literal("capped"),
  v.literal("partial"),
  v.literal("malformed"),
  v.literal("invalid_empty"),
  v.literal("provider_error"),
);

export const companyMonitoringReturnedRangeValidator = v.object({
  startAt: v.number(),
  endAt: v.number(),
});

export const companyMonitoringFinalizeResultValidator = v.union(
  v.object({
    type: v.literal("result"),
    itemCount: v.number(),
    hasMore: v.boolean(),
    coverage: v.union(v.literal("complete"), v.literal("partial")),
    returnedRange: v.optional(companyMonitoringReturnedRangeValidator),
    checkpoint: v.optional(v.string()),
    emptyValidated: v.boolean(),
    costUsdMicros: v.number(),
  }),
  v.object({
    type: v.literal("provider_error"),
    reason: companyMonitoringProviderErrorReasonValidator,
    costUsdMicros: v.number(),
  }),
);

export const companyMonitoringCompleteReceiptValidator = v.object({
  kind: v.literal("complete"),
  reason: v.literal("complete"),
  completedAt: v.number(),
  returnedRange: companyMonitoringReturnedRangeValidator,
  itemCount: v.number(),
  costUsdMicros: v.number(),
  sourceCoverage: v.literal("complete"),
  checkpointAfter: v.string(),
});

export const companyMonitoringNonReassuringReceiptValidator = v.object({
  kind: v.literal("non_reassuring"),
  reason: companyMonitoringNonReassuringReasonValidator,
  providerReason: v.optional(companyMonitoringProviderErrorReasonValidator),
  completedAt: v.number(),
  returnedRange: v.optional(companyMonitoringReturnedRangeValidator),
  itemCount: v.optional(v.number()),
  costUsdMicros: v.number(),
  sourceCoverage: v.union(
    v.literal("partial"),
    v.literal("failed"),
    v.literal("unknown"),
  ),
});
