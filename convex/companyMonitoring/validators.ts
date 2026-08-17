import { ConvexError, v } from "convex/values";
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

export const companyMonitoringXAuthorityRoleValidator = v.union(
  v.literal("company"),
  v.literal("newsroom"),
  v.literal("investor_relations"),
  v.literal("support"),
  v.literal("developer"),
  v.literal("regional"),
  v.literal("unknown"),
);

export const companyMonitoringXDemotionReasonValidator = v.union(
  v.literal("account_reassigned"),
  v.literal("account_changed"),
  v.literal("official_link_lost"),
  v.literal("name_mismatch"),
  v.literal("domicile_mismatch"),
  v.literal("expired"),
  v.literal("family_conflict"),
);

export const companyMonitoringXAllowedUseValidator = v.union(
  v.literal("primary_evidence"),
  v.literal("recent_search"),
);

const companyMonitoringXCheckpointValidator = v.object({
  companyId: v.string(),
  checkpointBefore: v.optional(v.string()),
  checkpointAfter: v.string(),
});

const companyMonitoringXPackingValidator = v.object({
  packId: v.string(),
  query: v.string(),
  companyIds: v.array(v.string()),
  accountIds: v.array(v.string()),
  handles: v.array(v.string()),
});

const companyMonitoringXGapValidator = v.object({
  startAt: v.number(),
  endAt: v.number(),
  reason: v.union(
    v.literal("provider_retention"),
    v.literal("pagination_cap"),
    v.literal("provider_partial"),
    v.literal("compliance_unavailable"),
  ),
});

export const companyMonitoringXPermittedStorageValidator = v.union(
  v.literal("full_text"),
  v.literal("metadata_only"),
);

export const companyMonitoringXIdentityObservationValidator = v.object({
  companyId: v.string(),
  domainClaimId: v.string(),
  xHandleClaimId: v.string(),
  officialDomain: v.string(),
  officialPageUrl: v.string(),
  accountId: v.string(),
  currentHandle: v.string(),
  profileName: v.string(),
  domicileCountry: v.union(v.literal("US"), v.literal("GB")),
  authorityRole: companyMonitoringXAuthorityRoleValidator,
  state: v.union(v.literal("authoritative"), v.literal("demoted")),
  demotionReason: v.optional(companyMonitoringXDemotionReasonValidator),
  badgeVerified: v.boolean(),
  allowedUses: v.array(companyMonitoringXAllowedUseValidator),
  checkedAt: v.number(),
  expiresAt: v.number(),
  evidenceHash: v.string(),
});

export const companyMonitoringXContentStateValidator = v.union(
  v.literal("active"),
  v.literal("edited"),
  v.literal("deleted"),
  v.literal("protected"),
  v.literal("withheld"),
);

export const companyMonitoringXStorageStateValidator = v.union(
  v.literal("full_text"),
  v.literal("metadata_only"),
  v.literal("tombstone"),
);

export const companyMonitoringEvidenceProviderValidator = v.union(
  v.literal("exa"),
  v.literal("x"),
);

export const companyMonitoringEvidenceAuthorityValidator = v.union(
  v.literal("verified_first_party"),
  v.literal("independent_source"),
  v.literal("low_authority"),
);

export const companyMonitoringEvidenceIndependenceValidator = v.union(
  v.literal("first_party"),
  v.literal("independent"),
  v.literal("syndicated"),
  v.literal("unknown"),
);

export const companyMonitoringEvidenceStateValidator = v.union(
  v.literal("active"),
  v.literal("deleted"),
  v.literal("expired"),
  v.literal("authority_lost"),
  v.literal("unavailable"),
);

export const companyMonitoringCandidateStateValidator = v.union(
  v.literal("pending_classification"),
  v.literal("held"),
  v.literal("terminal"),
);

export const companyMonitoringCandidateTerminalReasonValidator = v.union(
  v.literal("admitted"),
  v.literal("rejected"),
  v.literal("evidence_deleted"),
  v.literal("evidence_expired"),
  v.literal("authority_lost"),
  v.literal("evidence_unavailable"),
  v.literal("hold_expired"),
  v.literal("company_removed"),
);

// Defense-in-depth guard for the flat candidate state product (#6778 / R16).
// `companyMonitoringCandidates` encodes its lifecycle as `state` plus two
// optional siblings (`holdUntil`, `terminalReason`) rather than a Convex tagged
// union, so the schema alone permits illegal combinations — a `held` row with
// no `holdUntil`, or a `terminalReason` stranded on a live candidate. Every
// writer already clears the sibling it must not carry, but an out-of-band
// `ctx.db.patch` could persist an illegal row. Call this at every candidate
// write boundary and on every row `candidateLifecycle` reads so an illegal
// combination fails closed instead of silently degrading. Bound checks
// (`holdUntil > now`, `holdUntil <= expiresAt`) stay with their writers; this
// asserts only presence/consistency of the state trio.
export function assertValidCandidateState(candidate: {
  state: "pending_classification" | "held" | "terminal";
  holdUntil?: number;
  terminalReason?: string;
}) {
  const hasHoldUntil = candidate.holdUntil !== undefined;
  const hasTerminalReason = candidate.terminalReason !== undefined;
  if (candidate.state === "held" ? !hasHoldUntil : hasHoldUntil) {
    throw new ConvexError("COMPANY_MONITORING_CANDIDATE_STATE_INVALID");
  }
  if (candidate.state === "terminal" ? !hasTerminalReason : hasTerminalReason) {
    throw new ConvexError("COMPANY_MONITORING_CANDIDATE_STATE_INVALID");
  }
}

const companyMonitoringAdmissionAxisFields = {
  confidence: v.number(),
  rationale: v.string(),
  evidenceIds: v.array(v.string()),
};

export const companyMonitoringAdmissionClassificationValidator = v.object({
  attribution: v.object({
    truth: v.union(
      v.literal("confirmed"),
      v.literal("wrong_company"),
      v.literal("uncertain"),
    ),
    ...companyMonitoringAdmissionAxisFields,
  }),
  occurrence: v.object({
    truth: v.union(v.literal("confirmed"), v.literal("false"), v.literal("uncertain")),
    ...companyMonitoringAdmissionAxisFields,
  }),
  materiality: v.object({
    truth: v.union(v.literal("material"), v.literal("not_material"), v.literal("uncertain")),
    ...companyMonitoringAdmissionAxisFields,
  }),
  direction: v.union(v.literal("positive"), v.literal("negative"), v.literal("mixed")),
  channels: v.array(v.union(v.literal("financial"), v.literal("reputation"))),
  magnitude: v.union(
    v.literal("low"),
    v.literal("medium"),
    v.literal("high"),
    v.literal("critical"),
  ),
  category: v.string(),
  title: v.string(),
  neutralSummary: v.string(),
  positiveRationale: v.string(),
  negativeRationale: v.string(),
  conflict: v.boolean(),
});

export const companyMonitoringAdmissionAuthorityValidator = v.object({
  hasVerifiedFirstPartyPrimary: v.boolean(),
  independentOriginCount: v.number(),
  satisfiesAuthority: v.boolean(),
  qualifyingEvidenceIds: v.array(v.string()),
});

export const companyMonitoringAdmissionConfidenceFloorsValidator = v.object({
  attribution: v.number(),
  eventTruth: v.number(),
  materialImpact: v.number(),
  overall: v.literal("minimum_axis"),
});

export const companyMonitoringProviderEvidenceValidator = v.object({
  provider: companyMonitoringEvidenceProviderValidator,
  providerLocator: v.string(),
  // Optional only for rows written before #6011. Admission fails closed when
  // a referenced row has no query version; every live ingestion path sets it.
  queryVersion: v.optional(v.string()),
  url: v.optional(v.string()),
  title: v.optional(v.string()),
  text: v.optional(v.string()),
  author: v.optional(v.string()),
  authorAccountId: v.optional(v.string()),
  publishedAt: v.number(),
  observedAt: v.number(),
  expiresAt: v.optional(v.number()),
  candidateCompanyIds: v.array(v.string()),
  verifiedCompanyIds: v.optional(v.array(v.string())),
  sourceAuthority: companyMonitoringEvidenceAuthorityValidator,
});

export const companyMonitoringXPostObservationValidator = v.object({
  companyId: v.string(),
  postId: v.string(),
  authorAccountId: v.string(),
  currentHandle: v.string(),
  createdAt: v.number(),
  observedAt: v.number(),
  contentState: companyMonitoringXContentStateValidator,
  storageState: companyMonitoringXStorageStateValidator,
  text: v.optional(v.string()),
  editHistoryPostIds: v.array(v.string()),
  withheldCountryCodes: v.optional(v.array(v.string())),
});

const companyMonitoringXAuditFields = {
  requestedWindow: companyMonitoringReturnedRangeValidator,
  returnedWindow: companyMonitoringReturnedRangeValidator,
  checkpoints: v.array(companyMonitoringXCheckpointValidator),
  packing: v.array(companyMonitoringXPackingValidator),
  gaps: v.array(companyMonitoringXGapValidator),
  permittedStorage: companyMonitoringXPermittedStorageValidator,
  unexpectedAuthorAccountIds: v.array(v.string()),
  requestCount: v.number(),
  complianceEventCount: v.number(),
};

export const companyMonitoringXIngestionValidator = v.object({
  ...companyMonitoringXAuditFields,
  identities: v.array(companyMonitoringXIdentityObservationValidator),
  posts: v.array(companyMonitoringXPostObservationValidator),
});

export const companyMonitoringXReceiptValidator = v.object({
  ...companyMonitoringXAuditFields,
  identityCount: v.number(),
  postCount: v.number(),
});

export const companyMonitoringExaCandidateValidator = v.object({
  providerResultId: v.string(),
  providerRequestId: v.optional(v.string()),
  providerRank: v.number(),
  url: v.string(),
  title: v.optional(v.string()),
  author: v.optional(v.string()),
  publishedAt: v.number(),
  retrievedAt: v.number(),
  candidateCompanyIds: v.array(v.string()),
});

export const companyMonitoringExaIngestionValidator = v.object({
  candidates: v.array(companyMonitoringExaCandidateValidator),
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
    exaIngestion: v.optional(companyMonitoringExaIngestionValidator),
    xIngestion: v.optional(companyMonitoringXIngestionValidator),
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
  xIngestion: v.optional(companyMonitoringXReceiptValidator),
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
  xIngestion: v.optional(companyMonitoringXReceiptValidator),
});
