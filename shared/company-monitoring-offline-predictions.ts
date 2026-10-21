import { createHash, createPrivateKey, createPublicKey, randomUUID, sign, verify } from 'node:crypto';
import {
  COMPANY_MONITORING_ADMISSION_POLICY_VERSION,
  evaluateCompanyMonitoringClassification,
} from '../scripts/lib/company-monitoring-classification.mjs';
import {
  projectCompanyMonitoringCandidate,
  type NormalizedCompanyCandidate,
  type NormalizedCompanyEvidence,
} from './company-monitoring-evidence.ts';
import {
  computeBlindCorpusDigest,
  computeExpansionManifestDigest,
  computePredictionSetDigest,
  computeScoreReportDigest,
  validateBlindCorpusArtifact,
  validatePredictionSetArtifact,
  type BlindCorpus,
  type Materiality,
  type Prediction,
  type PredictionSet,
  type ScoreReport,
} from './company-monitoring-blind-evaluation.ts';
import {
  compileCompanyMonitoringBlindCorpus,
  computeCompanyMonitoringCurationManifestDigest,
  type CompanyMonitoringCurationManifest,
} from './company-monitoring-curation.ts';
import {
  canonicalJson,
  evaluateStage0,
  hasExactKeys,
  isEvidenceDigest,
  parseRfc3339Timestamp,
  validateProtocolFixture,
  type JsonObject,
} from './company-monitoring-evaluation.ts';
import {
  CompanyMonitoringOfflinePredictionError,
  type OfflineClassifierConfiguration,
  type OfflineClassifierResult,
  type OfflineContinuationAuthorization,
  type OfflinePredictionBundle,
  type OfflinePredictionCheckpoint,
  type OfflinePredictionReconciliation,
  type OfflinePredictionRunReceipt,
  type OfflineProviderObservation,
  type OfflineProviderObservationManifest,
  type OfflineProviderCoverage,
} from './company-monitoring-offline-prediction-contracts.ts';
import {
  authenticateOfflineArtifact,
  computeOfflineClassifierRuntimeDigest,
  decodeOfflineCheckpointAuthenticationKey,
  verifyOfflineArtifactAuthentication,
} from './company-monitoring-offline-checkpoints.ts';
import {
  normalizeOfflineEvaluationEvidence,
  validateOfflineFirstPartyIdentityBindings,
} from './company-monitoring-offline-evidence.ts';

export * from './company-monitoring-offline-prediction-contracts.ts';
export {
  computeOfflineClassifierRuntimeDigest,
  createOfflinePredictionReconciliation,
  validateOfflineRetainedProviderResponse,
} from './company-monitoring-offline-checkpoints.ts';

const ROOT_KEYS = new Set([
  'schemaVersion', 'captureVersion', 'corpusVersion', 'corpusSha256',
  'curationSha256', 'protocolVersion', 'policyVersion', 'modelVersion', 'queryVersion',
  'capturedAt', 'providerQueryVersions', 'runtime', 'custody', 'rows',
]);
const PROVIDER_QUERY_VERSION_KEYS = new Set(['exa', 'x']);
const RUNTIME_KEYS = new Set(['requestedModel', 'providerRoute', 'resolvedProvider']);
const CUSTODY_KEYS = new Set([
  'storageClass', 'labelsVisibleToRuntime', 'referenceEvidenceVisibleToProviders',
]);
const ROW_KEYS = new Set([
  'opaqueExampleId', 'coverage', 'providerReceipts', 'latencyMs', 'costUsd', 'evidence',
]);
const COVERAGE_KEYS = new Set(['exa', 'x']);
const PROVIDER_RECEIPT_KEYS = new Set(['exa', 'x']);
const EVIDENCE_KEYS = new Set([
  'provider', 'providerLocator', 'providerReceiptSha256', 'queryVersion', 'url',
  'title', 'text', 'author', 'authorAccountId', 'publishedAt', 'observedAt',
  'expiresAt', 'sourceAuthority', 'verifiedCompany', 'officialCompanyDomain',
  'publisherOrigin', 'syndication',
]);
const SYNDICATION_KEYS = new Set(['relationship', 'upstreamUrl', 'groupIdentity']);
const VERSION = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const OPAQUE_ID = /^cm_example_[a-f0-9]{6}$/;
const COVERAGE = new Set<OfflineProviderCoverage>(['complete', 'not_applicable', 'incomplete']);
const AUTHORITY = new Set(['verified_first_party', 'independent_source', 'low_authority']);
const MAX_CLASSIFIER_CONCURRENCY = 4;
const CHECKPOINT_KEYS = new Set([
  'schemaVersion', 'protocolSha256', 'approvedThresholdDigest', 'corpusSha256',
  'curationSha256', 'providerObservationsSha256', 'runtime', 'state',
  'opaqueExampleId', 'attemptId', 'prediction',
  'authenticationSha256',
]);
const RECONCILIATION_KEYS = new Set([
  'schemaVersion', 'opaqueExampleId', 'attemptId', 'providerResponseSha256',
  'providerLatencyMs', 'classification', 'authenticationSha256',
]);
const BUNDLE_KEYS = new Set(['schemaVersion', 'predictions', 'receipt', 'authentication']);
const BUNDLE_AUTHENTICATION_KEYS = new Set(['algorithm', 'signatureBase64']);
const RECEIPT_KEYS = new Set([
  'schemaVersion', 'protocolSha256', 'approvedThresholdDigest', 'corpusSha256',
  'curationSha256', 'providerObservationsSha256', 'predictionSetSha256',
  'protocolVersion', 'policyVersion', 'modelVersion', 'queryVersion',
  'captureVersion', 'capturedAt', 'runtime', 'custody',
]);
const CONTINUATION_AUTHORIZATION_KEYS = new Set([
  'schemaVersion', 'outcome', 'approvedThresholdDigest', 'parentCorpusSha256',
  'parentPredictionSetSha256', 'parentGoldLabelSetSha256', 'parentReportSha256',
  'classifierRuntimeSha256', 'childCorpusSha256', 'expansionManifestSha256', 'signatureBase64',
]);
const ATTEMPT_ID = /^cm_attempt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function fail(code: string): never { throw new CompanyMonitoringOfflinePredictionError(code); }

function exact(value: unknown, keys: Set<string>, code: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
  if (!hasExactKeys(value as JsonObject, keys)) fail(code);
  return value as Record<string, unknown>;
}

function text(value: unknown, code: string, maximum = 2_048): string {
  if (
    typeof value !== 'string' || value.length === 0 || value !== value.trim() ||
    value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)
  ) fail(code);
  return value;
}

function nullableText(value: unknown, code: string, maximum = 32_768): string | null { return value === null ? null : text(value, code, maximum); }
function finiteNonNegative(value: unknown, code: string): number { if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail(code); return value; }
function safeInteger(value: unknown, code: string): number { if (!Number.isSafeInteger(value) || (value as number) < 0) fail(code); return value as number; }

function version(value: unknown, code: string): string {
  const result = text(value, code, 200);
  if (!VERSION.test(result)) fail(code);
  return result;
}

function httpsUrl(value: unknown, code: string): string {
  const result = text(value, code);
  try {
    const url = new URL(result);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) fail(code);
  } catch {
    fail(code);
  }
  return result;
}

function officialDomain(value: unknown, code: string): string | null {
  if (value === null) return null;
  const result = text(value, code, 253);
  if (result !== result.toLowerCase()) fail(code);
  try {
    const url = new URL(`https://${result}`);
    if (url.hostname !== result || url.port || url.pathname !== '/' || !result.includes('.')) fail(code);
  } catch {
    fail(code);
  }
  return result;
}

function validateObservation(value: unknown): OfflineProviderObservation {
  const row = exact(value, EVIDENCE_KEYS, 'offline_observation_field_forbidden');
  if (row.provider !== 'exa' && row.provider !== 'x') fail('offline_observation_provider_invalid');
  text(row.providerLocator, 'offline_observation_locator_invalid');
  if (!isEvidenceDigest(row.providerReceiptSha256)) fail('offline_observation_receipt_digest_invalid');
  version(row.queryVersion, 'offline_observation_query_version_invalid');
  const url = httpsUrl(row.url, 'offline_observation_url_invalid');
  nullableText(row.title, 'offline_observation_title_invalid', 512);
  nullableText(row.text, 'offline_observation_text_invalid');
  nullableText(row.author, 'offline_observation_author_invalid', 256);
  nullableText(row.authorAccountId, 'offline_observation_author_id_invalid', 256);
  const companyDomain = officialDomain(
    row.officialCompanyDomain,
    'offline_observation_official_domain_invalid',
  );
  const publisherOrigin = text(row.publisherOrigin, 'offline_observation_publisher_origin_invalid', 253);
  const urlOrigin = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  const expectedPublisherOrigin = row.provider === 'x' ? row.authorAccountId : urlOrigin;
  if (expectedPublisherOrigin === null || publisherOrigin !== expectedPublisherOrigin) {
    fail('offline_observation_publisher_origin_mismatch');
  }
  const syndication = exact(
    row.syndication,
    SYNDICATION_KEYS,
    'offline_observation_syndication_forbidden',
  );
  if (!['independent', 'syndicated', 'unknown'].includes(String(syndication.relationship))) {
    fail('offline_observation_syndication_invalid');
  }
  nullableText(syndication.upstreamUrl, 'offline_observation_upstream_url_invalid');
  if (syndication.upstreamUrl !== null) httpsUrl(syndication.upstreamUrl, 'offline_observation_upstream_url_invalid');
  text(syndication.groupIdentity, 'offline_observation_syndication_group_invalid', 512);
  if (
    (syndication.relationship === 'syndicated') !== (syndication.upstreamUrl !== null)
  ) fail('offline_observation_syndication_invalid');
  const publishedAt = safeInteger(row.publishedAt, 'offline_observation_published_at_invalid');
  const observedAt = safeInteger(row.observedAt, 'offline_observation_observed_at_invalid');
  if (publishedAt > observedAt) fail('offline_observation_time_order_invalid');
  if (row.expiresAt !== null) {
    const expiresAt = safeInteger(row.expiresAt, 'offline_observation_expiry_invalid');
    if (expiresAt <= observedAt) fail('offline_observation_expiry_invalid');
  }
  if (!AUTHORITY.has(String(row.sourceAuthority))) fail('offline_observation_authority_invalid');
  if (typeof row.verifiedCompany !== 'boolean') fail('offline_observation_verification_invalid');
  if ((row.sourceAuthority === 'verified_first_party') !== row.verifiedCompany) {
    fail('offline_observation_verification_invalid');
  }
  if (row.verifiedCompany) {
    if (row.sourceAuthority !== 'verified_first_party') fail('offline_observation_verification_invalid');
    if (row.provider === 'x' && (row.authorAccountId === null || companyDomain !== null)) {
      fail('offline_observation_verification_invalid');
    }
    if (row.provider === 'exa') {
      const hostname = new URL(url).hostname.toLowerCase();
      if (
        companyDomain === null || row.authorAccountId !== null ||
        (hostname !== companyDomain && !hostname.endsWith(`.${companyDomain}`))
      ) fail('offline_observation_verification_invalid');
    }
  } else if (companyDomain !== null) {
    fail('offline_observation_verification_invalid');
  }
  return row as OfflineProviderObservation;
}

function validateManifest(
  value: unknown,
  corpus: BlindCorpus,
): OfflineProviderObservationManifest {
  const manifest = exact(value, ROOT_KEYS, 'offline_manifest_field_forbidden');
  if (manifest.schemaVersion !== 'cm_offline_provider_observations_v1') {
    fail('offline_manifest_schema_invalid');
  }
  version(manifest.captureVersion, 'offline_capture_version_invalid');
  for (const field of ['corpusVersion', 'protocolVersion', 'policyVersion', 'modelVersion', 'queryVersion'] as const) {
    version(manifest[field], `offline_${field}_invalid`);
    if (manifest[field] !== corpus[field]) fail(`offline_${field}_mismatch`);
  }
  if (manifest.corpusSha256 !== computeBlindCorpusDigest(corpus)) fail('offline_corpus_digest_mismatch');
  if (!isEvidenceDigest(manifest.curationSha256)) fail('offline_curation_digest_invalid');
  const capturedAt = parseRfc3339Timestamp(manifest.capturedAt);
  if (capturedAt === null) fail('offline_capture_timestamp_invalid');

  const providerQueryVersions = exact(
    manifest.providerQueryVersions,
    PROVIDER_QUERY_VERSION_KEYS,
    'offline_provider_query_versions_forbidden',
  );
  for (const provider of ['exa', 'x'] as const) {
    version(providerQueryVersions[provider], 'offline_provider_query_version_invalid');
  }

  const runtime = exact(manifest.runtime, RUNTIME_KEYS, 'offline_runtime_field_forbidden');
  text(runtime.requestedModel, 'offline_runtime_model_invalid', 200);
  text(runtime.providerRoute, 'offline_runtime_provider_invalid', 200);
  text(runtime.resolvedProvider, 'offline_runtime_provider_invalid', 200);
  const custody = exact(manifest.custody, CUSTODY_KEYS, 'offline_custody_field_forbidden');
  if (
    custody.storageClass !== 'sealed_external' || custody.labelsVisibleToRuntime !== false ||
    custody.referenceEvidenceVisibleToProviders !== false
  ) fail('offline_custody_boundary_invalid');
  if (!Array.isArray(manifest.rows)) fail('offline_rows_invalid');

  const exampleIds = new Set(corpus.examples.map((example) => example.opaqueExampleId));
  const seenExamples = new Set<string>();
  const seenLocators = new Set<string>();
  for (const value of manifest.rows) {
    const row = exact(value, ROW_KEYS, 'offline_row_field_forbidden');
    const opaqueId = text(row.opaqueExampleId, 'offline_example_id_invalid', 40);
    if (!OPAQUE_ID.test(opaqueId) || !exampleIds.has(opaqueId) || seenExamples.has(opaqueId)) {
      fail('offline_example_membership_invalid');
    }
    seenExamples.add(opaqueId);
    const coverage = exact(row.coverage, COVERAGE_KEYS, 'offline_coverage_field_forbidden');
    const providerReceipts = exact(
      row.providerReceipts,
      PROVIDER_RECEIPT_KEYS,
      'offline_provider_receipts_forbidden',
    );
    for (const provider of ['exa', 'x'] as const) {
      if (!COVERAGE.has(coverage[provider] as OfflineProviderCoverage)) {
        fail('offline_coverage_status_invalid');
      }
      if (coverage[provider] === 'incomplete') fail('offline_provider_coverage_incomplete');
      if (
        (coverage[provider] === 'complete' && !isEvidenceDigest(providerReceipts[provider])) ||
        (coverage[provider] === 'not_applicable' && providerReceipts[provider] !== null)
      ) fail('offline_provider_receipt_invalid');
    }
    if (coverage.exa !== 'complete') fail('offline_exa_coverage_required');
    finiteNonNegative(row.latencyMs, 'offline_latency_invalid');
    finiteNonNegative(row.costUsd, 'offline_cost_invalid');
    if (!Array.isArray(row.evidence)) fail('offline_evidence_invalid');
    for (const evidenceValue of row.evidence) {
      const evidence = validateObservation(evidenceValue);
      if (coverage[evidence.provider] !== 'complete') fail('offline_evidence_without_coverage');
      if (evidence.queryVersion !== providerQueryVersions[evidence.provider]) {
        fail('offline_observation_query_version_mismatch');
      }
      if (evidence.observedAt > capturedAt) fail('offline_observation_after_capture');
      const locatorKey = `${evidence.provider}\u0000${evidence.providerLocator}`;
      if (seenLocators.has(locatorKey)) fail('offline_observation_reused');
      seenLocators.add(locatorKey);
    }
  }
  if (seenExamples.size !== exampleIds.size) fail('offline_prediction_denominator_incomplete');
  return manifest as OfflineProviderObservationManifest;
}

export function assertCompanyMonitoringOfflineRuntimePermitted(
  protocol: JsonObject,
  approvedThresholdDigest: string,
): void {
  try {
    validateProtocolFixture(protocol);
  } catch {
    fail('offline_protocol_schema_invalid');
  }
  const result = evaluateStage0(protocol, { approvedThresholdDigest });
  if (result.decision !== 'continue') fail('offline_runtime_protocol_stop');
}

function assertCurationMatchesCorpus(
  curation: CompanyMonitoringCurationManifest,
  corpus: BlindCorpus,
): Map<string, CompanyMonitoringCurationManifest['candidates'][number]> {
  validateBlindCorpusArtifact(corpus);
  if (corpus.status !== 'locked') fail('offline_corpus_not_locked');
  if (corpus.sealedGoldLabelsSha256 === null) fail('offline_sealed_gold_digest_missing');
  if (corpus.policyVersion !== COMPANY_MONITORING_ADMISSION_POLICY_VERSION) {
    fail('offline_policy_version_mismatch');
  }
  let compiled;
  try {
    compiled = compileCompanyMonitoringBlindCorpus(curation).corpus;
  } catch {
    fail('offline_curation_invalid');
  }
  for (const field of [
    'corpusVersion', 'purpose', 'protocolVersion', 'policyVersion', 'modelVersion',
    'queryVersion', 'curatorAccessVersion',
  ] as const) {
    if (compiled[field] !== corpus[field]) fail('offline_curation_corpus_mismatch');
  }
  if (canonicalJson(compiled.examples) !== canonicalJson(corpus.examples)) {
    fail('offline_curation_corpus_mismatch');
  }
  return new Map(curation.candidates.flatMap((candidate) =>
    candidate.disposition === 'included' && candidate.opaqueExampleId
      ? [[candidate.opaqueExampleId, candidate] as const]
      : []
  ));
}

function emptyPrediction(
  opaqueExampleId: string,
  discovered: boolean,
  latencyMs: number,
  costUsd: number,
): Prediction {
  return {
    opaqueExampleId,
    discovered,
    publish: false,
    predictedMateriality: 'immaterial',
    predictedDirection: null,
    attributedCorporateFamilyDigest: null,
    confidence: 0,
    latencyMs,
    costUsd,
  };
}

export async function runCompanyMonitoringOfflinePredictions(input: {
  protocol: JsonObject;
  approvedThresholdDigest: string;
  curation: CompanyMonitoringCurationManifest;
  expectedCurationSha256?: string;
  corpus: BlindCorpus;
  observations: OfflineProviderObservationManifest;
  expectedObservationsSha256?: string;
  runtime: OfflineClassifierConfiguration;
  previous?: {
    corpus: BlindCorpus;
    expectedCorpusSha256: string;
    predictions: PredictionSet;
    expectedPredictionSetSha256: string;
    report: ScoreReport;
    expectedReportSha256: string;
    authorization: OfflineContinuationAuthorization;
    authorizationPublicKeyPem: string;
  };
  checkpoints?: OfflinePredictionCheckpoint[];
  reconciliations?: OfflinePredictionReconciliation[];
  checkpointAuthenticationKey?: string;
  onCheckpoint?: (checkpoint: OfflinePredictionCheckpoint) => Promise<void> | void;
  createAttemptId?: () => string;
  classify: (input: {
    candidate: NormalizedCompanyCandidate;
    evidence: NormalizedCompanyEvidence[];
    attemptId: string;
  }) => Promise<OfflineClassifierResult>;
  monotonicNow?: () => number;
}): Promise<PredictionSet> {
  assertCompanyMonitoringOfflineRuntimePermitted(input.protocol, input.approvedThresholdDigest);
  const curationById = assertCurationMatchesCorpus(input.curation, input.corpus);
  const curationSha256 = computeCompanyMonitoringCurationManifestDigest(input.curation);
  if (
    !isEvidenceDigest(input.expectedCurationSha256) ||
    curationSha256 !== input.expectedCurationSha256
  ) fail('offline_curation_digest_mismatch');
  if (!input.previous
    && input.curation.classifierRuntimeSha256 !== input.corpus.classifierRuntimeSha256) {
    fail('offline_curation_corpus_mismatch');
  }
  const observations = validateManifest(input.observations, input.corpus);
  validateOfflineFirstPartyIdentityBindings(curationById, observations);
  const corpusSha256 = computeBlindCorpusDigest(input.corpus);
  const protocolSha256 = createHash('sha256').update(canonicalJson(input.protocol)).digest('hex');
  const providerObservationsSha256 = computeOfflineProviderObservationDigest(
    observations,
    input.corpus,
  );
  if (observations.curationSha256 !== curationSha256) fail('offline_observation_curation_mismatch');
  if (
    !isEvidenceDigest(input.expectedObservationsSha256) ||
    providerObservationsSha256 !== input.expectedObservationsSha256
  ) fail('offline_observation_digest_mismatch');
  if (
    input.runtime.requestedModel !== observations.runtime.requestedModel ||
    input.runtime.providerRoute !== observations.runtime.providerRoute
  ) fail('offline_classifier_configuration_mismatch');
  if (
    input.curation.classifierRuntimeSha256 !==
      computeOfflineClassifierRuntimeDigest(observations.runtime)
  ) fail('offline_classifier_runtime_digest_mismatch');
  const capturedAt = parseRfc3339Timestamp(observations.capturedAt)!;
  const rows = new Map(observations.rows.map((row) => [row.opaqueExampleId, row]));
  const examples = new Map(input.corpus.examples.map((example) => [example.opaqueExampleId, example]));
  const monotonicNow = input.monotonicNow ?? (() => performance.now());
  const predictions = input.previous
    ? validatePreviousPredictions(
      input.corpus,
      input.previous,
      input.approvedThresholdDigest,
      input.curation.classifierRuntimeSha256,
    )
    : new Map<string, Prediction>();
  const opaqueExampleIds = [...examples.keys()].sort();
  const checkpointAuthenticationKeyValue = decodeOfflineCheckpointAuthenticationKey(
    input.checkpointAuthenticationKey,
  );
  const authenticateCheckpoint = (
    checkpoint: Omit<OfflinePredictionCheckpoint, 'authenticationSha256'>,
  ): string => authenticateOfflineArtifact(checkpoint, checkpointAuthenticationKeyValue);
  const reconciliations = new Map<string, OfflinePredictionReconciliation>();
  for (const value of input.reconciliations ?? []) {
    const reconciliation = exact(
      value,
      RECONCILIATION_KEYS,
      'offline_reconciliation_field_forbidden',
    );
    verifyOfflineArtifactAuthentication(reconciliation, checkpointAuthenticationKeyValue);
    if (
      reconciliation.schemaVersion !== 'cm_offline_prediction_reconciliation_v1' ||
      !examples.has(String(reconciliation.opaqueExampleId)) ||
      !ATTEMPT_ID.test(String(reconciliation.attemptId)) ||
      !isEvidenceDigest(reconciliation.providerResponseSha256) ||
      reconciliations.has(String(reconciliation.opaqueExampleId))
    ) fail('offline_reconciliation_invalid');
    finiteNonNegative(reconciliation.providerLatencyMs, 'offline_reconciliation_invalid');
    reconciliations.set(
      String(reconciliation.opaqueExampleId),
      reconciliation as OfflinePredictionReconciliation,
    );
  }
  const checkpointGroups = new Map<string, {
    started?: OfflinePredictionCheckpoint;
    completed?: OfflinePredictionCheckpoint;
  }>();
  for (const checkpointValue of input.checkpoints ?? []) {
    const checkpoint = exact(
      checkpointValue,
      CHECKPOINT_KEYS,
      'offline_checkpoint_field_forbidden',
    );
    verifyOfflineArtifactAuthentication(checkpoint, checkpointAuthenticationKeyValue);
    if (
      checkpoint.schemaVersion !== 'cm_offline_prediction_checkpoint_v1' ||
      checkpoint.protocolSha256 !== protocolSha256 ||
      checkpoint.approvedThresholdDigest !== input.approvedThresholdDigest ||
      checkpoint.corpusSha256 !== corpusSha256 ||
      checkpoint.curationSha256 !== curationSha256 ||
      checkpoint.providerObservationsSha256 !== providerObservationsSha256 ||
      canonicalJson(checkpoint.runtime) !== canonicalJson(observations.runtime)
    ) fail('offline_checkpoint_anchor_mismatch');
    if (!examples.has(String(checkpoint.opaqueExampleId))) fail('offline_checkpoint_membership_invalid');
    if (!ATTEMPT_ID.test(String(checkpoint.attemptId))) fail('offline_checkpoint_attempt_invalid');
    const typedCheckpoint = checkpoint as OfflinePredictionCheckpoint;
    if (checkpoint.state === 'started') {
      if (checkpoint.prediction !== null) fail('offline_checkpoint_state_invalid');
    } else if (
      checkpoint.state !== 'completed' || checkpoint.prediction === null ||
      checkpoint.prediction.opaqueExampleId !== checkpoint.opaqueExampleId
    ) fail('offline_checkpoint_state_invalid');
    const group = checkpointGroups.get(typedCheckpoint.opaqueExampleId) ?? {};
    if (checkpoint.state === 'started') {
      if (group.started) fail('offline_checkpoint_state_invalid');
      group.started = typedCheckpoint;
    } else {
      if (group.completed) fail('offline_checkpoint_state_invalid');
      group.completed = typedCheckpoint;
    }
    checkpointGroups.set(typedCheckpoint.opaqueExampleId, group);
  }
  const matchedReconciliationIds = new Set<string>();
  for (const [opaqueExampleId, group] of checkpointGroups) {
    if (group.started && group.completed && group.started.attemptId !== group.completed.attemptId) {
      fail('offline_checkpoint_attempt_mismatch');
    }
    if (!group.completed) {
      const reconciliation = reconciliations.get(opaqueExampleId);
      if (!group.started || !reconciliation || reconciliation.attemptId !== group.started.attemptId) {
        fail('offline_checkpoint_reconciliation_required');
      }
      matchedReconciliationIds.add(opaqueExampleId);
      continue;
    }
    const checkpoint = group.completed;
    validatePredictionSetArtifact({
      schemaVersion: 'cm_predictions_v1',
      corpusVersion: input.corpus.corpusVersion,
      corpusSha256: checkpoint.corpusSha256,
      protocolVersion: input.corpus.protocolVersion,
      policyVersion: input.corpus.policyVersion,
      modelVersion: input.corpus.modelVersion,
      classifierRuntimeSha256: input.curation.classifierRuntimeSha256,
      queryVersion: input.corpus.queryVersion,
      parentPredictionSetSha256: input.previous
        ? computePredictionSetDigest(input.previous.predictions)
        : null,
      parentGoldLabelSetSha256: input.previous
        ? input.previous.corpus.sealedGoldLabelsSha256
        : null,
      predictions: [checkpoint.prediction],
    });
    if (predictions.has(opaqueExampleId)) fail('offline_checkpoint_membership_invalid');
    predictions.set(opaqueExampleId, checkpoint.prediction);
  }
  if ([...reconciliations.keys()].some((opaqueExampleId) =>
    !matchedReconciliationIds.has(opaqueExampleId)
  )) fail('offline_reconciliation_checkpoint_invalid');
  const pendingExampleIds = opaqueExampleIds.filter((opaqueExampleId) => !predictions.has(opaqueExampleId));

  const predict = async (
    opaqueExampleId: string,
    attemptId: string,
    reconciliation?: OfflinePredictionReconciliation,
  ): Promise<Prediction> => {
    const example = examples.get(opaqueExampleId)!;
    const row = rows.get(opaqueExampleId)!;
    if (row.evidence.length === 0) {
      return emptyPrediction(opaqueExampleId, false, row.latencyMs, row.costUsd);
    }
    const curatorCandidate = curationById.get(opaqueExampleId);
    if (!curatorCandidate) fail('offline_curation_membership_mismatch');
    const evidence = await normalizeOfflineEvaluationEvidence(
      opaqueExampleId,
      curatorCandidate.company.legalName,
      row.evidence,
      capturedAt,
      example.occurrenceDigest,
    );
    if (evidence.length === 0) {
      return emptyPrediction(opaqueExampleId, true, row.latencyMs, row.costUsd);
    }
    const candidate = projectCompanyMonitoringCandidate(evidence, example.occurrenceDigest);
    const startedAt = monotonicNow();
    const classification = reconciliation?.classification ?? await input.classify({
      candidate,
      evidence,
      attemptId,
    });
    const completedAt = monotonicNow();
    if (
      typeof classification.providerResponseId !== 'string' ||
      classification.providerResponseId.length === 0 ||
      classification.providerResponseId !== classification.providerResponseId.trim() ||
      classification.providerResponseId.length > 200 ||
      classification.route.resolvedModel !== observations.runtime.requestedModel ||
      classification.route.configuredProviderRoute !== observations.runtime.providerRoute ||
      classification.route.resolvedProvider !== observations.runtime.resolvedProvider ||
      typeof classification.content !== 'string' ||
      !Number.isFinite(classification.costUsd) || classification.costUsd < 0
    ) fail('offline_classifier_runtime_mismatch');
    const policy = evaluateCompanyMonitoringClassification({
      candidate,
      evidence,
      modelOutput: classification.content,
      now: Math.max(...evidence.map((item) => item.observedAt)),
      modelVersion: input.corpus.modelVersion,
    });
    const materiality: Materiality = policy.classification?.materiality.truth === 'material'
      ? 'material'
      : 'immaterial';
    return {
      opaqueExampleId,
      discovered: true,
      publish: policy.decision === 'publish',
      predictedMateriality: materiality,
      predictedDirection: policy.classification?.direction ?? null,
      attributedCorporateFamilyDigest:
        policy.classification?.attribution.truth === 'confirmed'
          ? example.corporateFamilyDigest
          : null,
      confidence: policy.overallConfidence ?? 0,
      latencyMs: row.latencyMs + (
        reconciliation?.providerLatencyMs ?? Math.max(0, completedAt - startedAt)
      ),
      costUsd: row.costUsd + classification.costUsd,
    };
  };

  let cursor = 0;
  let stopped = false;
  let failure: unknown;
  const worker = async (): Promise<void> => {
    while (!stopped) {
      const index = cursor;
      if (index >= pendingExampleIds.length) return;
      cursor += 1;
      const opaqueExampleId = pendingExampleIds[index]!;
      try {
        const reconciliation = reconciliations.get(opaqueExampleId);
        const attemptId = reconciliation?.attemptId ??
          (input.createAttemptId ?? (() => `cm_attempt_${randomUUID()}`))();
        if (!ATTEMPT_ID.test(attemptId)) fail('offline_checkpoint_attempt_invalid');
        const startedCheckpoint = {
          schemaVersion: 'cm_offline_prediction_checkpoint_v1',
          protocolSha256,
          approvedThresholdDigest: input.approvedThresholdDigest,
          corpusSha256,
          curationSha256,
          providerObservationsSha256,
          runtime: observations.runtime,
          state: 'started',
          opaqueExampleId,
          attemptId,
          prediction: null,
        } satisfies Omit<OfflinePredictionCheckpoint, 'authenticationSha256'>;
        if (!reconciliation) {
          await input.onCheckpoint?.({
            ...startedCheckpoint,
            authenticationSha256: authenticateCheckpoint(startedCheckpoint),
          });
        }
        const prediction = await predict(
          opaqueExampleId,
          attemptId,
          reconciliation,
        );
        const completedCheckpoint = {
          schemaVersion: 'cm_offline_prediction_checkpoint_v1',
          protocolSha256,
          approvedThresholdDigest: input.approvedThresholdDigest,
          corpusSha256,
          curationSha256,
          providerObservationsSha256,
          runtime: observations.runtime,
          state: 'completed',
          opaqueExampleId,
          attemptId,
          prediction,
        } satisfies Omit<OfflinePredictionCheckpoint, 'authenticationSha256'>;
        await input.onCheckpoint?.({
          ...completedCheckpoint,
          authenticationSha256: authenticateCheckpoint(completedCheckpoint),
        });
        predictions.set(opaqueExampleId, prediction);
      } catch (error) {
        if (!stopped) failure = error;
        stopped = true;
      }
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(MAX_CLASSIFIER_CONCURRENCY, pendingExampleIds.length) },
    () => worker(),
  ));
  if (stopped) throw failure;

  const predictionSet: PredictionSet = {
    schemaVersion: 'cm_predictions_v1',
    corpusVersion: input.corpus.corpusVersion,
    corpusSha256,
    protocolVersion: input.corpus.protocolVersion,
    policyVersion: input.corpus.policyVersion,
    modelVersion: input.corpus.modelVersion,
    classifierRuntimeSha256: input.curation.classifierRuntimeSha256,
    queryVersion: input.corpus.queryVersion,
    parentPredictionSetSha256: input.previous
      ? computePredictionSetDigest(input.previous.predictions)
      : null,
    parentGoldLabelSetSha256: input.previous
      ? input.previous.corpus.sealedGoldLabelsSha256
      : null,
    predictions: opaqueExampleIds.map((opaqueExampleId) => predictions.get(opaqueExampleId)!),
  };
  validatePredictionSetArtifact(predictionSet);
  return predictionSet;
}

function validatePreviousPredictions(
  corpus: BlindCorpus,
  previous: NonNullable<Parameters<typeof runCompanyMonitoringOfflinePredictions>[0]['previous']>,
  approvedThresholdDigest: string,
  inputCurationRuntimeDigest: string,
): Map<string, Prediction> {
  validateBlindCorpusArtifact(previous.corpus);
  validatePredictionSetArtifact(previous.predictions);
  if (
    !isEvidenceDigest(previous.expectedCorpusSha256) ||
    computeBlindCorpusDigest(previous.corpus) !== previous.expectedCorpusSha256 ||
    !isEvidenceDigest(previous.expectedPredictionSetSha256) ||
    computePredictionSetDigest(previous.predictions) !== previous.expectedPredictionSetSha256 ||
    previous.report.schemaVersion !== 'cm_blind_score_report_v1' ||
    previous.report.outcome !== 'incomplete' ||
    !isEvidenceDigest(previous.expectedReportSha256) ||
    previous.report.reportSha256 !== previous.expectedReportSha256 ||
    computeScoreReportDigest(previous.report) !== previous.report.reportSha256 ||
    previous.report.corpus.version !== previous.corpus.corpusVersion ||
    previous.report.corpus.sha256 !== previous.expectedCorpusSha256 ||
    previous.report.predictionSetSha256 !== previous.expectedPredictionSetSha256 ||
    previous.report.goldLabelSetSha256 !== previous.corpus.sealedGoldLabelsSha256 ||
    previous.report.protocol.version !== previous.corpus.protocolVersion ||
    previous.report.protocol.approvedThresholdsSha256 !== approvedThresholdDigest ||
    previous.report.corpus.purpose !== previous.corpus.purpose ||
    previous.report.corpus.exampleCount !== previous.corpus.examples.length ||
    previous.report.versions.policyVersion !== previous.corpus.policyVersion ||
    previous.report.versions.modelVersion !== previous.corpus.modelVersion ||
    previous.report.versions.classifierRuntimeSha256 !== previous.corpus.classifierRuntimeSha256 ||
    previous.report.versions.queryVersion !== previous.corpus.queryVersion ||
    previous.report.versions.curatorAccessVersion !== previous.corpus.curatorAccessVersion ||
    previous.corpus.status !== 'locked' ||
    previous.corpus.sealedGoldLabelsSha256 === null ||
    previous.corpus.precommittedExpansion === null
  ) fail('offline_previous_corpus_invalid');
  for (const field of [
    'purpose', 'protocolVersion', 'policyVersion', 'modelVersion', 'queryVersion',
    'classifierRuntimeSha256', 'curatorAccessVersion',
  ] as const) {
    if (corpus[field] !== previous.corpus[field]) fail('offline_continuation_version_mismatch');
  }
  if (previous.predictions.classifierRuntimeSha256 !== inputCurationRuntimeDigest) {
    fail('offline_continuation_classifier_runtime_mismatch');
  }
  const continuation = corpus.continuation;
  if (
    continuation === null ||
    continuation.parentCorpusVersion !== previous.corpus.corpusVersion ||
    continuation.parentCorpusSha256 !== previous.expectedCorpusSha256 ||
    continuation.parentReportSha256 !== previous.expectedReportSha256
  ) fail('offline_continuation_parent_mismatch');
  for (let index = 0; index < previous.corpus.examples.length; index += 1) {
    if (canonicalJson(corpus.examples[index]) !== canonicalJson(previous.corpus.examples[index])) {
      fail('offline_continuation_changed_example');
    }
  }
  const appended = corpus.examples.slice(previous.corpus.examples.length);
  if (
    appended.length !== previous.corpus.precommittedExpansion.exampleCount ||
    computeExpansionManifestDigest(appended) !== previous.corpus.precommittedExpansion.manifestSha256
  ) fail('offline_continuation_expansion_mismatch');
  const authorization = exact(
    previous.authorization,
    CONTINUATION_AUTHORIZATION_KEYS,
    'offline_continuation_authorization_invalid',
  ) as OfflineContinuationAuthorization;
  const { signatureBase64, ...authorizationBody } = authorization;
  if (
    authorization.schemaVersion !== 'cm_offline_continuation_authorization_v1' ||
    authorization.outcome !== 'incomplete' ||
    authorization.approvedThresholdDigest !== approvedThresholdDigest ||
    authorization.parentCorpusSha256 !== previous.expectedCorpusSha256 ||
    authorization.parentPredictionSetSha256 !== previous.expectedPredictionSetSha256 ||
    authorization.parentGoldLabelSetSha256 !== previous.corpus.sealedGoldLabelsSha256 ||
    authorization.parentReportSha256 !== previous.expectedReportSha256 ||
    authorization.classifierRuntimeSha256 !== previous.predictions.classifierRuntimeSha256 ||
    authorization.classifierRuntimeSha256 !== inputCurationRuntimeDigest ||
    authorization.childCorpusSha256 !== computeBlindCorpusDigest(corpus) ||
    authorization.expansionManifestSha256 !== previous.corpus.precommittedExpansion.manifestSha256 ||
    typeof signatureBase64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(signatureBase64)
  ) fail('offline_continuation_authorization_invalid');
  try {
    const publicKey = createPublicKey(previous.authorizationPublicKeyPem);
    const valid = verify(
      null,
      Buffer.from(canonicalJson(authorizationBody)),
      publicKey,
      Buffer.from(signatureBase64, 'base64'),
    );
    if (!valid) fail('offline_continuation_authorization_invalid');
  } catch (error) {
    if (error instanceof CompanyMonitoringOfflinePredictionError) throw error;
    fail('offline_continuation_authorization_invalid');
  }
  for (const field of [
    'corpusVersion', 'protocolVersion', 'policyVersion', 'modelVersion',
    'classifierRuntimeSha256', 'queryVersion',
  ] as const) {
    const expected = field === 'corpusVersion'
      ? previous.corpus.corpusVersion
      : previous.corpus[field];
    if (previous.predictions[field] !== expected) fail('offline_previous_predictions_mismatch');
  }
  if (previous.predictions.corpusSha256 !== previous.expectedCorpusSha256) {
    fail('offline_previous_predictions_mismatch');
  }
  const previousExampleIds = new Set(previous.corpus.examples.map((example) => example.opaqueExampleId));
  const previousPredictionIds = new Set(
    previous.predictions.predictions.map((prediction) => prediction.opaqueExampleId),
  );
  if (
    previous.predictions.predictions.length !== previousExampleIds.size ||
    previousPredictionIds.size !== previous.predictions.predictions.length ||
    previous.predictions.predictions.some((prediction) => !previousExampleIds.has(prediction.opaqueExampleId))
  ) fail('offline_previous_predictions_mismatch');
  return new Map(previous.predictions.predictions.map((prediction) => [prediction.opaqueExampleId, prediction]));
}

export function computeOfflineProviderObservationDigest(
  observations: OfflineProviderObservationManifest,
  corpus: BlindCorpus,
): string {
  validateManifest(observations, corpus);
  return createHash('sha256').update(canonicalJson(observations)).digest('hex');
}

export function createOfflinePredictionRunReceipt(input: {
  protocol: JsonObject;
  approvedThresholdDigest: string;
  curation: CompanyMonitoringCurationManifest;
  corpus: BlindCorpus;
  observations: OfflineProviderObservationManifest;
  predictions: PredictionSet;
}): OfflinePredictionRunReceipt {
  assertCompanyMonitoringOfflineRuntimePermitted(input.protocol, input.approvedThresholdDigest);
  validatePredictionSetArtifact(input.predictions);
  const curationSha256 = computeCompanyMonitoringCurationManifestDigest(input.curation);
  const corpusSha256 = computeBlindCorpusDigest(input.corpus);
  const providerObservationsSha256 = computeOfflineProviderObservationDigest(
    input.observations,
    input.corpus,
  );
  if (
    input.predictions.corpusSha256 !== corpusSha256 ||
    input.observations.curationSha256 !== curationSha256 ||
    input.curation.classifierRuntimeSha256 !== input.corpus.classifierRuntimeSha256 ||
    input.predictions.classifierRuntimeSha256 !== input.corpus.classifierRuntimeSha256 ||
    computeOfflineClassifierRuntimeDigest(input.observations.runtime)
      !== input.corpus.classifierRuntimeSha256
  ) fail('offline_prediction_receipt_input_mismatch');
  return {
    schemaVersion: 'cm_offline_prediction_run_receipt_v1',
    protocolSha256: createHash('sha256').update(canonicalJson(input.protocol)).digest('hex'),
    approvedThresholdDigest: input.approvedThresholdDigest,
    corpusSha256,
    curationSha256,
    providerObservationsSha256,
    predictionSetSha256: computePredictionSetDigest(input.predictions),
    protocolVersion: input.corpus.protocolVersion,
    policyVersion: input.corpus.policyVersion,
    modelVersion: input.corpus.modelVersion,
    queryVersion: input.corpus.queryVersion,
    captureVersion: input.observations.captureVersion,
    capturedAt: input.observations.capturedAt,
    runtime: input.observations.runtime,
    custody: { storageClass: 'sealed_external', labelsVisibleToRuntime: false },
  };
}

export function createOfflinePredictionBundle(input: {
  predictions: PredictionSet;
  receipt: OfflinePredictionRunReceipt;
  signingPrivateKeyPem: string;
}): OfflinePredictionBundle {
  const body = {
    schemaVersion: 'cm_offline_prediction_bundle_v1' as const,
    predictions: input.predictions,
    receipt: input.receipt,
  };
  try {
    const privateKey = createPrivateKey(input.signingPrivateKeyPem);
    if (privateKey.asymmetricKeyType !== 'ed25519') fail('offline_bundle_signing_key_invalid');
    return {
      ...body,
      authentication: {
        algorithm: 'ed25519',
        signatureBase64: sign(
          null,
          Buffer.from(canonicalJson(body)),
          privateKey,
        ).toString('base64'),
      },
    };
  } catch (error) {
    if (error instanceof CompanyMonitoringOfflinePredictionError) throw error;
    fail('offline_bundle_signing_key_invalid');
  }
}

export function validateOfflinePredictionBundle(input: {
  bundle: unknown;
  verificationPublicKeyPem: string;
  protocol: JsonObject;
  approvedThresholdDigest: string;
  curation: CompanyMonitoringCurationManifest;
  expectedCurationSha256: string;
  corpus: BlindCorpus;
  observations: OfflineProviderObservationManifest;
  expectedObservationsSha256: string;
}): PredictionSet {
  const bundle = exact(input.bundle, BUNDLE_KEYS, 'offline_prediction_bundle_invalid');
  if (bundle.schemaVersion !== 'cm_offline_prediction_bundle_v1') {
    fail('offline_prediction_bundle_invalid');
  }
  const authentication = exact(
    bundle.authentication,
    BUNDLE_AUTHENTICATION_KEYS,
    'offline_prediction_bundle_invalid',
  );
  if (authentication.algorithm !== 'ed25519' || typeof authentication.signatureBase64 !== 'string') {
    fail('offline_prediction_bundle_invalid');
  }
  const signature = Buffer.from(authentication.signatureBase64, 'base64');
  if (
    signature.length !== 64 ||
    signature.toString('base64') !== authentication.signatureBase64
  ) fail('offline_prediction_bundle_invalid');
  try {
    const publicKey = createPublicKey(input.verificationPublicKeyPem);
    const body = {
      schemaVersion: bundle.schemaVersion,
      predictions: bundle.predictions,
      receipt: bundle.receipt,
    };
    if (
      publicKey.asymmetricKeyType !== 'ed25519' ||
      !verify(null, Buffer.from(canonicalJson(body)), publicKey, signature)
    ) fail('offline_prediction_bundle_invalid');
  } catch (error) {
    if (error instanceof CompanyMonitoringOfflinePredictionError) throw error;
    fail('offline_prediction_bundle_invalid');
  }
  validatePredictionSetArtifact(bundle.predictions);
  const predictions = bundle.predictions as PredictionSet;
  const corpusSha256 = computeBlindCorpusDigest(input.corpus);
  for (const field of [
    'corpusVersion', 'protocolVersion', 'policyVersion', 'modelVersion',
    'classifierRuntimeSha256', 'queryVersion',
  ] as const) {
    if (predictions[field] !== input.corpus[field]) fail('offline_prediction_bundle_invalid');
  }
  const exampleIds = new Set(input.corpus.examples.map((example) => example.opaqueExampleId));
  if (
    predictions.corpusSha256 !== corpusSha256 ||
    predictions.predictions.length !== exampleIds.size ||
    new Set(predictions.predictions.map((prediction) => prediction.opaqueExampleId)).size !== exampleIds.size ||
    predictions.predictions.some((prediction) => !exampleIds.has(prediction.opaqueExampleId))
  ) fail('offline_prediction_bundle_invalid');
  const receipt = exact(bundle.receipt, RECEIPT_KEYS, 'offline_prediction_bundle_invalid');
  const curationSha256 = computeCompanyMonitoringCurationManifestDigest(input.curation);
  if (curationSha256 !== input.expectedCurationSha256) fail('offline_prediction_bundle_invalid');
  const observationsSha256 = computeOfflineProviderObservationDigest(input.observations, input.corpus);
  if (observationsSha256 !== input.expectedObservationsSha256) fail('offline_prediction_bundle_invalid');
  const expectedReceipt = createOfflinePredictionRunReceipt({
    protocol: input.protocol,
    approvedThresholdDigest: input.approvedThresholdDigest,
    curation: input.curation,
    corpus: input.corpus,
    observations: input.observations,
    predictions,
  });
  if (canonicalJson(receipt) !== canonicalJson(expectedReceipt)) {
    fail('offline_prediction_bundle_invalid');
  }
  return predictions;
}
