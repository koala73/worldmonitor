import type { Prediction, PredictionSet } from './company-monitoring-blind-evaluation.ts';

export type OfflineProviderCoverage = 'complete' | 'not_applicable' | 'incomplete';

export type OfflineProviderObservation = {
  provider: 'exa' | 'x';
  providerLocator: string;
  providerReceiptSha256: string;
  queryVersion: string;
  url: string;
  title: string | null;
  text: string | null;
  author: string | null;
  authorAccountId: string | null;
  officialCompanyDomain: string | null;
  publisherOrigin: string;
  syndication: {
    relationship: 'independent' | 'syndicated' | 'unknown';
    upstreamUrl: string | null;
    groupIdentity: string;
  };
  publishedAt: number;
  observedAt: number;
  expiresAt: number | null;
  sourceAuthority: 'verified_first_party' | 'independent_source' | 'low_authority';
  verifiedCompany: boolean;
};

export type OfflineClassifierRuntimePin = {
  requestedModel: string;
  providerRoute: string;
  resolvedProvider: string;
};

export type OfflineClassifierConfiguration = Omit<OfflineClassifierRuntimePin, 'resolvedProvider'>;

export type OfflineClassifierResult = {
  providerResponseId: string;
  content: string;
  route: {
    resolvedModel: string;
    resolvedProvider: string;
    configuredProviderRoute: string;
  };
  costUsd: number;
};

export type OfflineProviderObservationManifest = {
  schemaVersion: 'cm_offline_provider_observations_v1';
  captureVersion: string;
  corpusVersion: string;
  corpusSha256: string;
  curationSha256: string;
  protocolVersion: string;
  policyVersion: string;
  modelVersion: string;
  queryVersion: string;
  capturedAt: string;
  providerQueryVersions: { exa: string; x: string };
  runtime: OfflineClassifierRuntimePin;
  custody: {
    storageClass: 'sealed_external';
    labelsVisibleToRuntime: false;
    referenceEvidenceVisibleToProviders: false;
  };
  rows: Array<{
    opaqueExampleId: string;
    coverage: { exa: OfflineProviderCoverage; x: OfflineProviderCoverage };
    providerReceipts: { exa: string | null; x: string | null };
    latencyMs: number;
    costUsd: number;
    evidence: OfflineProviderObservation[];
  }>;
};

export type OfflinePredictionRunReceipt = {
  schemaVersion: 'cm_offline_prediction_run_receipt_v1';
  protocolSha256: string;
  approvedThresholdDigest: string;
  corpusSha256: string;
  curationSha256: string;
  providerObservationsSha256: string;
  predictionSetSha256: string;
  protocolVersion: string;
  policyVersion: string;
  modelVersion: string;
  queryVersion: string;
  captureVersion: string;
  capturedAt: string;
  runtime: OfflineClassifierRuntimePin;
  custody: { storageClass: 'sealed_external'; labelsVisibleToRuntime: false };
};

export type OfflinePredictionBundle = {
  schemaVersion: 'cm_offline_prediction_bundle_v1';
  predictions: PredictionSet;
  receipt: OfflinePredictionRunReceipt;
  authentication: {
    algorithm: 'ed25519';
    signatureBase64: string;
  };
};

export type OfflinePredictionCheckpoint = {
  schemaVersion: 'cm_offline_prediction_checkpoint_v1';
  protocolSha256: string;
  approvedThresholdDigest: string;
  corpusSha256: string;
  curationSha256: string;
  providerObservationsSha256: string;
  runtime: OfflineClassifierRuntimePin;
  state: 'started' | 'completed';
  opaqueExampleId: string;
  attemptId: string;
  prediction: Prediction | null;
  authenticationSha256: string;
};

export type OfflinePredictionReconciliation = {
  schemaVersion: 'cm_offline_prediction_reconciliation_v1';
  opaqueExampleId: string;
  attemptId: string;
  providerResponseSha256: string;
  providerLatencyMs: number;
  classification: OfflineClassifierResult;
  authenticationSha256: string;
};

export type OfflineRetainedProviderResponse = {
  schemaVersion: 'cm_offline_retained_provider_response_v1';
  attemptId: string;
  providerResponseId: string;
  providerLatencyMs: number;
  response: unknown;
};

export type OfflineContinuationAuthorization = {
  schemaVersion: 'cm_offline_continuation_authorization_v1';
  outcome: 'incomplete';
  approvedThresholdDigest: string;
  parentCorpusSha256: string;
  parentPredictionSetSha256: string;
  parentGoldLabelSetSha256: string;
  parentReportSha256: string;
  classifierRuntimeSha256: string;
  childCorpusSha256: string;
  expansionManifestSha256: string;
  signatureBase64: string;
};

export class CompanyMonitoringOfflinePredictionError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'CompanyMonitoringOfflinePredictionError';
    this.code = code;
  }
}
