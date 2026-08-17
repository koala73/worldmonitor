import type {
  NormalizedCompanyCandidate,
  NormalizedCompanyEvidence,
} from "../../shared/company-monitoring-evidence";

export const COMPANY_MONITORING_CLASSIFICATION_SCHEMA_VERSION: string;
export const COMPANY_MONITORING_ADMISSION_POLICY_VERSION: string;
export const COMPANY_MONITORING_SOURCE_POLICY_VERSION: string;

export const COMPANY_MONITORING_DEFAULT_CONFIDENCE_FLOORS: Readonly<{
  attribution: number;
  eventTruth: number;
  materialImpact: number;
  overall: "minimum_axis";
}>;

export const COMPANY_MONITORING_RETRY_POLICY: Readonly<{
  version: string;
  checkpointsMs: readonly number[];
  terminalExpiryMs: number;
}>;

export const COMPANY_MONITORING_CLASSIFICATION_JSON_SCHEMA: Readonly<Record<string, unknown>>;

export function companyMonitoringEvidenceForClassification(
  evidence: NormalizedCompanyEvidence,
): Record<string, unknown>;

export type CompanyMonitoringClassificationCandidate =
  Omit<NormalizedCompanyCandidate, "state"> & {
  state: "pending_classification" | "held" | "terminal";
};

export interface CompanyMonitoringClassificationAxis<Truth extends string> {
  truth: Truth;
  confidence: number;
  rationale: string;
  evidenceIds: string[];
}

export interface CompanyMonitoringClassification {
  attribution: CompanyMonitoringClassificationAxis<"confirmed" | "wrong_company" | "uncertain">;
  occurrence: CompanyMonitoringClassificationAxis<"confirmed" | "false" | "uncertain">;
  materiality: CompanyMonitoringClassificationAxis<"material" | "not_material" | "uncertain">;
  direction: "positive" | "negative" | "mixed";
  channels: Array<"financial" | "reputation">;
  magnitude: "low" | "medium" | "high" | "critical";
  category: string;
  title: string;
  neutralSummary: string;
  positiveRationale: string;
  negativeRationale: string;
  conflict: boolean;
}

export interface CompanyMonitoringAdmissionResultBase {
  ownerAccountId: string;
  companyId: string;
  occurrenceDedupeKey: string;
  decidedAt: number;
  terminalAt: number;
  queryVersions: string[];
  confidenceFloors: typeof COMPANY_MONITORING_DEFAULT_CONFIDENCE_FLOORS;
  versions: {
    classificationSchema: string;
    admissionPolicy: string;
    sourcePolicy: string;
    retryPolicy: string;
    evidenceSelection: string;
    model: string;
  };
  reasonCodes: string[];
  classification: CompanyMonitoringClassification | null;
  overallConfidence: number | null;
  authority: {
    hasVerifiedFirstPartyPrimary: boolean;
    independentOriginCount: number;
    satisfiesAuthority: boolean;
    qualifyingEvidenceIds: string[];
  } | null;
}

export type CompanyMonitoringAdmissionResult = CompanyMonitoringAdmissionResultBase & (
  | { decision: "hold"; retryAt: number }
  | { decision: "publish" | "reject" | "expire"; retryAt: null }
);

export function buildCompanyMonitoringClassificationRequest(input: {
  candidate: CompanyMonitoringClassificationCandidate;
  evidence: NormalizedCompanyEvidence[];
  model: string;
}): Record<string, unknown>;

export function evaluateCompanyMonitoringClassification(input: {
  candidate: CompanyMonitoringClassificationCandidate;
  evidence: NormalizedCompanyEvidence[];
  modelOutput?: unknown;
  now: number;
  modelVersion: string;
}): CompanyMonitoringAdmissionResult;

export function evaluateCompanyMonitoringClassifierTransportFailure(input: {
  candidate: CompanyMonitoringClassificationCandidate;
  evidence: NormalizedCompanyEvidence[];
  now: number;
  modelVersion: string;
}): CompanyMonitoringAdmissionResult;
