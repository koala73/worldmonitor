import type { Doc } from "../_generated/dataModel";
import type { NormalizedCompanyEvidence } from "../../shared/company-monitoring-evidence";
import { companyMonitoringEvidenceForClassification } from "../../scripts/lib/company-monitoring-classification.mjs";
import { fingerprint } from "./_shared";

const CANDIDATE_EVIDENCE_SNAPSHOT_VERSION = "cm-candidate-evidence-snapshot-v2";

export function companyMonitoringEvidenceShape(
  row: Doc<"companyMonitoringEvidence">,
): NormalizedCompanyEvidence {
  return {
    ownerAccountId: row.ownerAccountId,
    companyId: row.companyId,
    provider: row.provider,
    providerLocator: row.providerLocator,
    ...(row.queryVersion ? { queryVersion: row.queryVersion } : {}),
    providerLocatorHash: row.providerLocatorHash,
    providerOrigin: row.providerOrigin,
    providerOriginFingerprint: row.providerOriginFingerprint,
    contentFingerprint: row.contentFingerprint,
    evidenceFingerprint: row.evidenceFingerprint,
    occurrenceDedupeKey: row.occurrenceDedupeKey,
    matchedClaimIds: row.matchedClaimIds,
    sourceAuthority: row.sourceAuthority,
    independence: row.independence,
    ...(row.url ? { url: row.url } : {}),
    ...(row.title ? { title: row.title } : {}),
    ...(row.text ? { text: row.text } : {}),
    ...(row.author ? { author: row.author } : {}),
    ...(row.authorAccountId ? { authorAccountId: row.authorAccountId } : {}),
    publishedAt: row.publishedAt,
    observedAt: row.observedAt,
    ...(row.expiresAt !== undefined ? { expiresAt: row.expiresAt } : {}),
  };
}

export function companyMonitoringCandidateEvidenceSnapshotDigest(input: {
  selectionPolicyVersion: string;
  referenceCount: number;
  referencesTruncated: boolean;
  evidence: NormalizedCompanyEvidence[];
}) {
  return fingerprint({
    version: CANDIDATE_EVIDENCE_SNAPSHOT_VERSION,
    selectionPolicyVersion: input.selectionPolicyVersion,
    referenceCount: input.referenceCount,
    referencesTruncated: input.referencesTruncated,
    // This is the exact canonical evidence projection placed in the model
    // request. Any model-visible reingest therefore invalidates the lease.
    references: [...input.evidence]
      .sort((left, right) =>
        left.evidenceFingerprint.localeCompare(right.evidenceFingerprint)
      )
      .map(companyMonitoringEvidenceForClassification),
  });
}
