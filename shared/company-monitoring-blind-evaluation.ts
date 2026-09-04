// Private/offline Company Monitoring blind-evaluation contracts.
//
// This module deliberately performs no provider calls, persistence, classification, or publication.
// It consumes the approved cm_eval_v1 protocol, opaque corpus manifests, sealed curator labels, and
// version-locked prediction sets to produce aggregate forecasts and deterministic score reports.
import { createHash } from 'node:crypto';
import {
  GOLD_DIRECTION_VALUES,
  GOLD_MATERIALITY_VALUES,
  OPAQUE_EXAMPLE_ID,
  adaptiveExpectedCalibrationError,
  asNumber,
  asObject,
  canonicalJson,
  compareCodePoints,
  evaluateAdmissionMetric,
  exactBinomialLowerBound,
  hasExactKeys,
  isEvidenceDigest,
  parseRfc3339Timestamp,
  percentileOrderStatistic,
  stratifiedBootstrapUpperBound,
  thresholdDigest,
  validateProtocolFixture,
  type CalibrationExample,
  type JsonObject,
} from './company-monitoring-evaluation.ts';

export type EvaluationPurpose = 'pilot' | 'tracer_gate' | 'stage3_gate';
export type Materiality = 'material' | 'immaterial';
export type Direction = 'positive' | 'negative' | 'mixed';
export type ScoreOutcome = 'pass' | 'incomplete' | 'fail';

export type BlindExample = {
  opaqueExampleId: string;
  occurrenceDigest: string;
  contentFingerprint: string;
  corporateFamilyDigest: string;
  sourceOriginDigest: string;
};

export type ContinuationReference = {
  parentCorpusVersion: string;
  parentCorpusSha256: string;
  parentReportSha256: string;
  reason: 'denominator_shortfall';
};

export type PrecommittedExpansion = {
  manifestSha256: string;
  exampleCount: number;
};

export type BlindCorpus = {
  schemaVersion: 'cm_blind_corpus_v1';
  corpusVersion: string;
  purpose: EvaluationPurpose;
  status: 'draft' | 'locked';
  protocolVersion: string;
  policyVersion: string;
  modelVersion: string;
  classifierRuntimeSha256: string;
  queryVersion: string;
  curatorAccessVersion: string;
  lockedAt: string | null;
  forecastSha256: string | null;
  sealedGoldLabelsSha256: string | null;
  continuation: ContinuationReference | null;
  precommittedExpansion: PrecommittedExpansion | null;
  examples: BlindExample[];
};

export type GoldLabel = {
  opaqueExampleId: string;
  publicationEligible: boolean;
  goldMateriality: Materiality;
  goldDirection: Direction;
  canonicalCorporateFamilyDigest: string;
  customerUseful: boolean | null;
};

export type GoldLabelSet = {
  schemaVersion: 'cm_gold_labels_v1';
  corpusVersion: string;
  goldLabelVersion: string;
  curatorAccessVersion: string;
  labels: GoldLabel[];
};

export type Prediction = {
  opaqueExampleId: string;
  discovered: boolean;
  publish: boolean;
  predictedMateriality: Materiality;
  predictedDirection: Direction | null;
  attributedCorporateFamilyDigest: string | null;
  confidence: number;
  latencyMs: number;
  costUsd: number;
};

export type PredictionSet = {
  schemaVersion: 'cm_predictions_v1';
  corpusVersion: string;
  corpusSha256: string;
  protocolVersion: string;
  policyVersion: string;
  modelVersion: string;
  classifierRuntimeSha256: string;
  queryVersion: string;
  parentPredictionSetSha256: string | null;
  parentGoldLabelSetSha256: string | null;
  predictions: Prediction[];
};

export type DenominatorForecast = {
  minimum: number;
  estimated: number;
  gap: number;
};

export type BlindForecast = {
  schemaVersion: 'cm_blind_forecast_v1';
  status: 'forecast_ok' | 'forecast_warning';
  gating: false;
  protocolVersion: string;
  approvedThresholdsSha256: string;
  pilotCorpusVersion: string;
  pilotCorpusSha256: string;
  targetCorpusVersion: string;
  targetCandidateSha256: string;
  targetGoldLabelSetSha256: string;
  versions: {
    policyVersion: string;
    modelVersion: string;
    classifierRuntimeSha256: string;
    queryVersion: string;
    pilotGoldLabelVersion: string;
    targetGoldLabelVersion: string;
    curatorAccessVersion: string;
  };
  candidateStrata: {
    total: number;
    publicationEligible: number;
    publicationEligibleRate: number;
    eligibleDirections: Record<Direction, number>;
  };
  pilotRealizedRates: {
    publishedDecisionRate: number;
    correctlyAttributedMaterialRateOverall: number;
    correctlyAttributedMaterialRateByDirection: Record<Direction, number>;
  };
  denominatorForecasts: Record<Stage3MetricId, DenominatorForecast>;
  gaps: Array<{ metricId: Stage3MetricId; missing: number }>;
  recommendedUntouchedGrowth: {
    totalExamples: number | null;
    eligibleByDirection: Record<Direction, number | null>;
  };
  stage4Excluded: true;
};

export type RateMetricReport = {
  kind: 'rate';
  boundMethod: string;
  confidenceLevel: number;
  denominator: number;
  numerator: number;
  pointEstimate: number | null;
  lowerBound: number | null;
  reasons: string[];
};

export type CalibrationMetricReport = {
  kind: 'calibration';
  denominator: number;
  pointEstimate: number;
  upperBound: number;
  reasons: string[];
};

export type Stage3MetricReport = RateMetricReport | CalibrationMetricReport;

export type Stage3MetricId = (typeof STAGE3_METRIC_IDS)[number];

export type ScoreReport = {
  schemaVersion: 'cm_blind_score_report_v1';
  reportSha256: string;
  outcome: ScoreOutcome;
  reasons: string[];
  protocol: {
    version: string;
    approvedThresholdsSha256: string;
  };
  corpus: {
    version: string;
    sha256: string;
    purpose: Exclude<EvaluationPurpose, 'pilot'>;
    exampleCount: number;
    parentCorpusVersion: string | null;
  };
  versions: {
    policyVersion: string;
    modelVersion: string;
    classifierRuntimeSha256: string;
    queryVersion: string;
    goldLabelVersion: string;
    curatorAccessVersion: string;
  };
  forecast: BlindForecast;
  observedDenominators: Record<Stage3MetricId, number>;
  metrics: Record<Stage3MetricId, Stage3MetricReport>;
  discovery: {
    denominator: number;
    numerator: number;
    rate: number | null;
  };
  customerUsefulness: {
    denominator: number;
    numerator: number;
    rate: number | null;
  };
  confusionMatrices: {
    publication: {
      truePositive: number;
      falsePositive: number;
      trueNegative: number;
      falseNegative: number;
    };
    materiality: Record<Materiality, Record<Materiality, number>>;
    direction: Record<Direction, Record<Direction | 'none', number>>;
    attribution: { correct: number; incorrect: number };
  };
  calibration: {
    denominator: number;
    pointEstimate: number;
    upperBound: number;
    metric: string;
    binning: string;
    bootstrapMethod: string;
    bootstrapIterations: number;
    bootstrapSeed: number;
  };
  latency: {
    count: number;
    minMs: number;
    p50Ms: number;
    p95Ms: number;
    maxMs: number;
  };
  cost: {
    totalUsd: number;
    averagePerExampleUsd: number;
  };
  predictionSetSha256: string;
  goldLabelSetSha256: string;
  stage4: {
    included: false;
    minimumExamples: number;
    releaseInput: 'separate_post_v1';
  };
};

export class BlindEvaluationError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'BlindEvaluationError';
    this.code = code;
  }
}

const DIRECTIONS: Direction[] = ['positive', 'negative', 'mixed'];
const VERSION = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const STAGE3_METRIC_IDS = [
  'published_material_impact_precision',
  'published_company_attribution_precision',
  'direction_accuracy_overall',
  'direction_accuracy_positive',
  'direction_accuracy_negative',
  'direction_accuracy_mixed',
  'confidence_calibration_stage3',
] as const;
const EVALUATION_VERSION_FIELDS = [
  ['protocolVersion', 'protocol_version'],
  ['policyVersion', 'policy_version'],
  ['modelVersion', 'model_version'],
  ['classifierRuntimeSha256', 'classifier_runtime_digest'],
  ['queryVersion', 'query_version'],
] as const;
const OPAQUE_EXAMPLE_ID_PREFIX = 'cm_example_';
const FORECAST_KEYS = new Set([
  'schemaVersion',
  'status',
  'gating',
  'protocolVersion',
  'approvedThresholdsSha256',
  'pilotCorpusVersion',
  'pilotCorpusSha256',
  'targetCorpusVersion',
  'targetCandidateSha256',
  'targetGoldLabelSetSha256',
  'versions',
  'candidateStrata',
  'pilotRealizedRates',
  'denominatorForecasts',
  'gaps',
  'recommendedUntouchedGrowth',
  'stage4Excluded',
]);
const FORECAST_VERSIONS_KEYS = new Set([
  'policyVersion',
  'modelVersion',
  'classifierRuntimeSha256',
  'queryVersion',
  'pilotGoldLabelVersion',
  'targetGoldLabelVersion',
  'curatorAccessVersion',
]);
const BLIND_EXAMPLE_KEYS = new Set([
  'opaqueExampleId',
  'occurrenceDigest',
  'contentFingerprint',
  'corporateFamilyDigest',
  'sourceOriginDigest',
]);
const CORPUS_KEYS = new Set([
  'schemaVersion',
  'corpusVersion',
  'purpose',
  'status',
  'protocolVersion',
  'policyVersion',
  'modelVersion',
  'classifierRuntimeSha256',
  'queryVersion',
  'curatorAccessVersion',
  'lockedAt',
  'forecastSha256',
  'sealedGoldLabelsSha256',
  'continuation',
  'precommittedExpansion',
  'examples',
]);
const CONTINUATION_KEYS = new Set([
  'parentCorpusVersion',
  'parentCorpusSha256',
  'parentReportSha256',
  'reason',
]);
const PRECOMMITTED_EXPANSION_KEYS = new Set(['manifestSha256', 'exampleCount']);
const GOLD_LABEL_SET_KEYS = new Set([
  'schemaVersion',
  'corpusVersion',
  'goldLabelVersion',
  'curatorAccessVersion',
  'labels',
]);
const GOLD_LABEL_KEYS = new Set([
  'opaqueExampleId',
  'publicationEligible',
  'goldMateriality',
  'goldDirection',
  'canonicalCorporateFamilyDigest',
  'customerUseful',
]);
const PREDICTION_SET_KEYS = new Set([
  'schemaVersion',
  'corpusVersion',
  'corpusSha256',
  'protocolVersion',
  'policyVersion',
  'modelVersion',
  'classifierRuntimeSha256',
  'queryVersion',
  'parentPredictionSetSha256',
  'parentGoldLabelSetSha256',
  'predictions',
]);
const PREDICTION_KEYS = new Set([
  'opaqueExampleId',
  'discovered',
  'publish',
  'predictedMateriality',
  'predictedDirection',
  'attributedCorporateFamilyDigest',
  'confidence',
  'latencyMs',
  'costUsd',
]);
const CANDIDATE_STRATA_KEYS = new Set([
  'total',
  'publicationEligible',
  'publicationEligibleRate',
  'eligibleDirections',
]);
const PILOT_REALIZED_RATES_KEYS = new Set([
  'publishedDecisionRate',
  'correctlyAttributedMaterialRateOverall',
  'correctlyAttributedMaterialRateByDirection',
]);
const DENOMINATOR_FORECAST_KEYS = new Set(['minimum', 'estimated', 'gap']);
const FORECAST_GAP_KEYS = new Set(['metricId', 'missing']);
const RECOMMENDED_GROWTH_KEYS = new Set(['totalExamples', 'eligibleByDirection']);
const DIRECTION_KEYS = new Set<string>(DIRECTIONS);
const STAGE3_METRIC_KEYS = new Set<string>(STAGE3_METRIC_IDS);

function fail(code: string): never {
  throw new BlindEvaluationError(code);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function finiteNonNegative(value: unknown, code: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail(code);
  return value;
}

function exactObject(value: unknown, keys: Set<string>, code: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
  const candidate = value as JsonObject;
  if (!hasExactKeys(candidate, keys)) fail(code);
  return candidate;
}

function nonNegativeInteger(value: unknown, code: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) fail(code);
  return value as number;
}

function rate(value: unknown, code: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) fail(code);
  return value;
}

function nullableEvidenceDigest(value: unknown, code: string): void {
  if (value !== null && !isEvidenceDigest(value)) fail(code);
}

function requireVersion(value: unknown, code: string): string {
  if (typeof value !== 'string' || !VERSION.test(value)) fail(code);
  return value;
}

function validateBlindExampleArtifact(value: unknown): asserts value is BlindExample {
  const example = exactObject(value, BLIND_EXAMPLE_KEYS, 'example_field_forbidden');
  if (!OPAQUE_EXAMPLE_ID.test(String(example.opaqueExampleId ?? ''))) fail('example_id_invalid');
  for (const [field, code] of [
    ['occurrenceDigest', 'example_occurrence_digest_invalid'],
    ['contentFingerprint', 'example_content_fingerprint_digest_invalid'],
    ['corporateFamilyDigest', 'example_corporate_family_digest_invalid'],
    ['sourceOriginDigest', 'example_source_origin_digest_invalid'],
  ] as const) {
    if (!isEvidenceDigest(example[field])) fail(code);
  }
}

export function validateExpansionManifestArtifact(value: unknown): asserts value is BlindExample[] {
  if (!Array.isArray(value) || value.length === 0) fail('expansion_examples_missing');
  for (const example of value) validateBlindExampleArtifact(example);
  assertUniqueExampleDimensions(value as BlindExample[]);
}

export function validateBlindCorpusArtifact(value: unknown): asserts value is BlindCorpus {
  const corpus = exactObject(value, CORPUS_KEYS, 'corpus_field_forbidden');
  if (corpus.schemaVersion !== 'cm_blind_corpus_v1') fail('corpus_schema_version_invalid');
  requireVersion(corpus.corpusVersion, 'corpus_version_invalid');
  requireVersion(corpus.protocolVersion, 'corpus_protocol_version_invalid');
  requireVersion(corpus.policyVersion, 'corpus_policy_version_invalid');
  requireVersion(corpus.modelVersion, 'corpus_model_version_invalid');
  if (!isEvidenceDigest(corpus.classifierRuntimeSha256)) {
    fail('corpus_classifier_runtime_digest_invalid');
  }
  requireVersion(corpus.queryVersion, 'corpus_query_version_invalid');
  requireVersion(corpus.curatorAccessVersion, 'curator_access_version_invalid');
  if (!['pilot', 'tracer_gate', 'stage3_gate'].includes(String(corpus.purpose))) {
    if (corpus.purpose === 'stage4_gate') fail('stage4_out_of_scope');
    fail('corpus_purpose_invalid');
  }
  if (corpus.status === 'locked') {
    if (typeof corpus.lockedAt !== 'string' || parseRfc3339Timestamp(corpus.lockedAt) === null) {
      fail('corpus_lock_timestamp_invalid');
    }
  } else if (corpus.status === 'draft') {
    if (corpus.lockedAt !== null) fail('draft_corpus_has_lock_timestamp');
  } else {
    fail('corpus_status_invalid');
  }
  nullableEvidenceDigest(corpus.forecastSha256, 'forecast_digest_invalid');
  nullableEvidenceDigest(corpus.sealedGoldLabelsSha256, 'sealed_gold_digest_invalid');
  if (corpus.continuation !== null) {
    const continuation = exactObject(
      corpus.continuation,
      CONTINUATION_KEYS,
      'continuation_field_forbidden',
    );
    requireVersion(continuation.parentCorpusVersion, 'continuation_parent_corpus_version_invalid');
    if (!isEvidenceDigest(continuation.parentCorpusSha256)) fail('continuation_parent_corpus_digest_invalid');
    if (!isEvidenceDigest(continuation.parentReportSha256)) fail('continuation_parent_report_digest_invalid');
    if (continuation.reason !== 'denominator_shortfall') fail('continuation_reason_invalid');
  }
  if (corpus.precommittedExpansion !== null) {
    const expansion = exactObject(
      corpus.precommittedExpansion,
      PRECOMMITTED_EXPANSION_KEYS,
      'precommitted_expansion_field_forbidden',
    );
    if (!isEvidenceDigest(expansion.manifestSha256)) fail('precommitted_expansion_digest_invalid');
    if (nonNegativeInteger(expansion.exampleCount, 'precommitted_expansion_count_invalid') === 0) {
      fail('precommitted_expansion_count_invalid');
    }
  }
  if (!Array.isArray(corpus.examples) || corpus.examples.length === 0) fail('corpus_examples_missing');
  for (const example of corpus.examples) validateBlindExampleArtifact(example);
  assertUniqueExampleDimensions(corpus.examples as BlindExample[]);
}

export function validateGoldLabelSetArtifact(value: unknown): asserts value is GoldLabelSet {
  const gold = exactObject(value, GOLD_LABEL_SET_KEYS, 'gold_field_forbidden');
  if (gold.schemaVersion !== 'cm_gold_labels_v1') fail('gold_schema_version_invalid');
  requireVersion(gold.corpusVersion, 'gold_corpus_version_invalid');
  requireVersion(gold.goldLabelVersion, 'gold_label_version_invalid');
  requireVersion(gold.curatorAccessVersion, 'gold_curator_access_version_invalid');
  if (!Array.isArray(gold.labels) || gold.labels.length === 0) fail('gold_labels_missing');
  for (const value of gold.labels) {
    const label = exactObject(value, GOLD_LABEL_KEYS, 'gold_label_field_forbidden');
    if (!OPAQUE_EXAMPLE_ID.test(String(label.opaqueExampleId ?? ''))) fail('gold_example_id_invalid');
    if (typeof label.publicationEligible !== 'boolean') fail('gold_publication_eligibility_invalid');
    if (typeof label.goldMateriality !== 'string'
      || !GOLD_MATERIALITY_VALUES.has(label.goldMateriality)) fail('gold_materiality_invalid');
    if (typeof label.goldDirection !== 'string'
      || !GOLD_DIRECTION_VALUES.has(label.goldDirection)) fail('gold_direction_invalid');
    if (!isEvidenceDigest(label.canonicalCorporateFamilyDigest)) fail('gold_corporate_family_digest_invalid');
    if (label.customerUseful !== null && typeof label.customerUseful !== 'boolean') {
      fail('gold_customer_usefulness_invalid');
    }
  }
}

export function validatePredictionSetArtifact(value: unknown): asserts value is PredictionSet {
  const set = exactObject(value, PREDICTION_SET_KEYS, 'prediction_set_field_forbidden');
  if (set.schemaVersion !== 'cm_predictions_v1') fail('prediction_schema_version_invalid');
  requireVersion(set.corpusVersion, 'prediction_corpus_version_invalid');
  requireVersion(set.protocolVersion, 'prediction_protocol_version_invalid');
  requireVersion(set.policyVersion, 'prediction_policy_version_invalid');
  requireVersion(set.modelVersion, 'prediction_model_version_invalid');
  if (!isEvidenceDigest(set.classifierRuntimeSha256)) {
    fail('prediction_classifier_runtime_digest_invalid');
  }
  requireVersion(set.queryVersion, 'prediction_query_version_invalid');
  if (!isEvidenceDigest(set.corpusSha256)) fail('prediction_corpus_digest_invalid');
  nullableEvidenceDigest(set.parentPredictionSetSha256, 'parent_prediction_set_digest_invalid');
  nullableEvidenceDigest(set.parentGoldLabelSetSha256, 'parent_gold_label_set_digest_invalid');
  if (!Array.isArray(set.predictions) || set.predictions.length === 0) fail('predictions_missing');
  for (const value of set.predictions) {
    const prediction = exactObject(value, PREDICTION_KEYS, 'prediction_field_forbidden');
    if (!OPAQUE_EXAMPLE_ID.test(String(prediction.opaqueExampleId ?? ''))) fail('prediction_example_id_invalid');
    if (typeof prediction.discovered !== 'boolean' || typeof prediction.publish !== 'boolean') {
      fail('prediction_boolean_invalid');
    }
    if (typeof prediction.predictedMateriality !== 'string'
      || !GOLD_MATERIALITY_VALUES.has(prediction.predictedMateriality)) fail('predicted_materiality_invalid');
    if (prediction.predictedDirection !== null
      && (typeof prediction.predictedDirection !== 'string'
        || !GOLD_DIRECTION_VALUES.has(prediction.predictedDirection))) {
      fail('predicted_direction_invalid');
    }
    nullableEvidenceDigest(prediction.attributedCorporateFamilyDigest, 'prediction_attribution_digest_invalid');
    rate(prediction.confidence, 'prediction_confidence_invalid');
    finiteNonNegative(prediction.latencyMs, 'prediction_latency_invalid');
    finiteNonNegative(prediction.costUsd, 'prediction_cost_invalid');
  }
}

function validateDirectionRecord(
  value: unknown,
  code: string,
  validate: (child: unknown) => number,
): Record<Direction, number> {
  const record = exactObject(value, DIRECTION_KEYS, code);
  for (const direction of DIRECTIONS) validate(record[direction]);
  return record as Record<Direction, number>;
}

export function validateBlindForecastArtifact(value: unknown): asserts value is BlindForecast {
  const forecast = exactObject(value, FORECAST_KEYS, 'forecast_field_forbidden');
  if (forecast.schemaVersion !== 'cm_blind_forecast_v1' || forecast.gating !== false) {
    fail('forecast_schema_invalid');
  }
  if (forecast.status !== 'forecast_ok' && forecast.status !== 'forecast_warning') {
    fail('forecast_status_invalid');
  }
  if (forecast.stage4Excluded !== true) fail('forecast_stage4_exclusion_invalid');
  requireVersion(forecast.protocolVersion, 'forecast_protocol_version_invalid');
  requireVersion(forecast.pilotCorpusVersion, 'forecast_pilot_corpus_version_invalid');
  requireVersion(forecast.targetCorpusVersion, 'forecast_target_corpus_version_invalid');
  for (const [field, code] of [
    ['approvedThresholdsSha256', 'forecast_approved_threshold_digest_invalid'],
    ['pilotCorpusSha256', 'forecast_pilot_corpus_digest_invalid'],
    ['targetCandidateSha256', 'forecast_target_candidate_digest_invalid'],
    ['targetGoldLabelSetSha256', 'forecast_target_gold_label_set_digest_invalid'],
  ] as const) {
    if (!isEvidenceDigest(forecast[field])) fail(code);
  }

  const forecastVersions = exactObject(
    forecast.versions,
    FORECAST_VERSIONS_KEYS,
    'forecast_versions_field_forbidden',
  );
  for (const field of FORECAST_VERSIONS_KEYS) {
    requireVersion(forecastVersions[field], `forecast_${field}_invalid`);
  }

  const candidate = exactObject(
    forecast.candidateStrata,
    CANDIDATE_STRATA_KEYS,
    'forecast_candidate_strata_field_forbidden',
  );
  const total = nonNegativeInteger(candidate.total, 'forecast_candidate_total_invalid');
  if (total === 0) fail('forecast_candidate_total_invalid');
  const eligible = nonNegativeInteger(
    candidate.publicationEligible,
    'forecast_candidate_eligible_invalid',
  );
  if (eligible > total) fail('forecast_candidate_eligible_invalid');
  const eligibleRate = rate(candidate.publicationEligibleRate, 'forecast_candidate_rate_invalid');
  if (eligibleRate !== eligible / total) fail('forecast_candidate_rate_invalid');
  const directions = validateDirectionRecord(
    candidate.eligibleDirections,
    'forecast_candidate_directions_invalid',
    (child) => nonNegativeInteger(child, 'forecast_candidate_direction_count_invalid'),
  );
  if (DIRECTIONS.reduce((sum, direction) => sum + directions[direction], 0) !== eligible) {
    fail('forecast_candidate_directions_invalid');
  }

  const pilotRates = exactObject(
    forecast.pilotRealizedRates,
    PILOT_REALIZED_RATES_KEYS,
    'forecast_pilot_rates_field_forbidden',
  );
  rate(pilotRates.publishedDecisionRate, 'forecast_pilot_rate_invalid');
  rate(pilotRates.correctlyAttributedMaterialRateOverall, 'forecast_pilot_rate_invalid');
  validateDirectionRecord(
    pilotRates.correctlyAttributedMaterialRateByDirection,
    'forecast_pilot_direction_rates_invalid',
    (child) => rate(child, 'forecast_pilot_rate_invalid'),
  );

  const denominatorForecasts = exactObject(
    forecast.denominatorForecasts,
    STAGE3_METRIC_KEYS,
    'forecast_denominator_metrics_invalid',
  );
  const expectedGaps: Array<{ metricId: Stage3MetricId; missing: number }> = [];
  for (const metricId of STAGE3_METRIC_IDS) {
    const denominator = exactObject(
      denominatorForecasts[metricId],
      DENOMINATOR_FORECAST_KEYS,
      'forecast_denominator_field_forbidden',
    );
    const minimum = nonNegativeInteger(denominator.minimum, 'forecast_denominator_minimum_invalid');
    const estimated = finiteNonNegative(denominator.estimated, 'forecast_denominator_estimate_invalid');
    const gap = finiteNonNegative(denominator.gap, 'forecast_denominator_gap_invalid');
    if (gap !== Math.max(0, minimum - estimated)) fail('forecast_denominator_gap_invalid');
    if (gap > 0) expectedGaps.push({ metricId, missing: gap });
  }

  if (!Array.isArray(forecast.gaps)) fail('forecast_gaps_invalid');
  const gaps = forecast.gaps.map((value) => {
    const gap = exactObject(value, FORECAST_GAP_KEYS, 'forecast_gap_field_forbidden');
    if (!STAGE3_METRIC_KEYS.has(String(gap.metricId))) fail('forecast_gap_metric_invalid');
    const missing = finiteNonNegative(gap.missing, 'forecast_gap_missing_invalid');
    if (missing <= 0) fail('forecast_gap_missing_invalid');
    return { metricId: gap.metricId as Stage3MetricId, missing };
  });
  if (canonicalJson(gaps) !== canonicalJson(expectedGaps)) fail('forecast_gaps_inconsistent');
  if ((gaps.length === 0) !== (forecast.status === 'forecast_ok')) {
    fail('forecast_status_inconsistent');
  }

  const growth = exactObject(
    forecast.recommendedUntouchedGrowth,
    RECOMMENDED_GROWTH_KEYS,
    'forecast_growth_field_forbidden',
  );
  if (growth.totalExamples !== null) {
    nonNegativeInteger(growth.totalExamples, 'forecast_total_growth_invalid');
  }
  const eligibleGrowth = exactObject(
    growth.eligibleByDirection,
    DIRECTION_KEYS,
    'forecast_growth_directions_invalid',
  );
  for (const direction of DIRECTIONS) {
    if (eligibleGrowth[direction] !== null) {
      nonNegativeInteger(eligibleGrowth[direction], 'forecast_direction_growth_invalid');
    }
  }
  if (canonicalJson(forecast).includes(OPAQUE_EXAMPLE_ID_PREFIX)) {
    fail('forecast_contains_example_id');
  }
}

function normalizedGoldLabelSet(gold: GoldLabelSet): GoldLabelSet {
  return { ...gold, labels: [...gold.labels].sort((left, right) =>
    compareCodePoints(left.opaqueExampleId, right.opaqueExampleId)) };
}

function normalizedPredictionSet(predictions: PredictionSet): PredictionSet {
  return { ...predictions, predictions: [...predictions.predictions].sort((left, right) =>
    compareCodePoints(left.opaqueExampleId, right.opaqueExampleId)) };
}

export function computeBlindCorpusDigest(corpus: BlindCorpus): string {
  return sha256(canonicalJson(corpus));
}

function computeBlindCorpusCandidateDigest(corpus: BlindCorpus): string {
  return sha256(canonicalJson({
    ...corpus,
    status: 'draft',
    lockedAt: null,
    forecastSha256: null,
    sealedGoldLabelsSha256: null,
  }));
}

export function computeGoldLabelSetDigest(gold: GoldLabelSet): string {
  validateGoldLabelSetArtifact(gold);
  return sha256(canonicalJson(normalizedGoldLabelSet(gold)));
}

export function computePredictionSetDigest(predictions: PredictionSet): string {
  validatePredictionSetArtifact(predictions);
  return sha256(canonicalJson(normalizedPredictionSet(predictions)));
}

export function computeExpansionManifestDigest(expansion: BlindExample[]): string {
  return sha256(canonicalJson(expansion));
}

export function computeForecastDigest(forecast: BlindForecast): string {
  return sha256(canonicalJson(forecast));
}

function reportWithoutDigest(report: ScoreReport): Omit<ScoreReport, 'reportSha256'> {
  const { reportSha256: _reportSha256, ...rest } = report;
  return rest;
}

export function computeScoreReportDigest(report: ScoreReport): string {
  return sha256(canonicalJson(reportWithoutDigest(report)));
}

export function canonicalReportJson(report: ScoreReport): string {
  return canonicalJson(report);
}

function validateApprovedProtocol(protocol: JsonObject, approvedThresholdDigest: string): JsonObject {
  if (!isEvidenceDigest(approvedThresholdDigest)) fail('approved_threshold_anchor_invalid');
  try {
    validateProtocolFixture(protocol);
  } catch {
    fail('protocol_schema_invalid');
  }
  const approval = asObject(protocol.approval, 'approval');
  if (approval.status !== 'approved') fail('protocol_not_approved');
  if (approval.approvedThresholdsSha256 !== approvedThresholdDigest) {
    fail('approved_threshold_digest_mismatch');
  }
  if (thresholdDigest(protocol) !== approvedThresholdDigest) {
    fail('frozen_threshold_digest_mismatch');
  }
  const admission = asObject(protocol.admissionQuality, 'admissionQuality');
  if (admission.status !== 'frozen') fail('admission_contract_not_frozen');
  if (admission.rateBoundMethod !== 'exact_one_sided_clopper_pearson') {
    fail('rate_bound_method_mismatch');
  }
  return admission;
}

type AdmissionMetricDefinitions = {
  stage3: Record<Stage3MetricId, JsonObject>;
  stage4: JsonObject;
};

function metricDefinitions(admission: JsonObject): AdmissionMetricDefinitions {
  if (!Array.isArray(admission.metrics)) fail('admission_metrics_missing');
  const byId = new Map<string, JsonObject>();
  for (const value of admission.metrics) {
    const definition = asObject(value, 'admissionMetric');
    const id = String(definition.id ?? '');
    // Last-wins on a duplicate id would silently pick one of two conflicting thresholds.
    if (byId.has(id)) fail('admission_metric_duplicate_id');
    byId.set(id, definition);
  }
  const stage3 = {} as Record<Stage3MetricId, JsonObject>;
  for (const id of STAGE3_METRIC_IDS) {
    const definition = byId.get(id);
    if (!definition) fail(`admission_metric_missing_${id}`);
    stage3[id] = definition;
  }
  const stage4 = byId.get('confidence_calibration_stage4');
  if (!stage4) fail('stage4_metric_missing_from_protocol');
  // Closed-world: the engine scores exactly these metrics. A metric added to the frozen
  // contract that this engine cannot score must stop the run, not be dropped from it.
  if (byId.size !== STAGE3_METRIC_IDS.length + 1) fail('admission_metric_not_scored');
  return { stage3, stage4 };
}

function stage4MinimumExamples(stage4: JsonObject): number {
  return asNumber(stage4.minimumDenominator, 'confidence_calibration_stage4.minimumDenominator');
}

function assertUniqueExampleDimensions(examples: BlindExample[]): void {
  const dimensions = [
    'opaqueExampleId',
    'occurrenceDigest',
    'contentFingerprint',
  ] as const;
  for (const dimension of dimensions) {
    const seen = new Set<string>();
    for (const example of examples) {
      if (seen.has(example[dimension])) fail(`corpus_duplicate_${dimension}`);
      seen.add(example[dimension]);
    }
  }
}

function validateCorpusShape(corpus: BlindCorpus, protocolVersion: string): void {
  validateBlindCorpusArtifact(corpus);
  if (corpus.protocolVersion !== protocolVersion) fail('corpus_protocol_version_mismatch');
  if (corpus.purpose === 'tracer_gate' && corpus.examples.length < 100) {
    fail('tracer_corpus_below_100');
  }
  if (corpus.purpose === 'stage3_gate' && corpus.examples.length < 200) {
    fail('stage3_corpus_below_200');
  }
}

function validateLockedCorpus(corpus: BlindCorpus, protocolVersion: string, expectedDigest: string): void {
  validateCorpusShape(corpus, protocolVersion);
  if (corpus.purpose === 'pilot') fail('pilot_cannot_be_scored_as_gate');
  if (corpus.status !== 'locked') fail('corpus_not_locked');
  if (!isEvidenceDigest(expectedDigest)) fail('expected_corpus_digest_invalid');
  if (computeBlindCorpusDigest(corpus) !== expectedDigest) fail('corpus_mutated_after_lock');
  if (corpus.forecastSha256 === null) fail('locked_corpus_forecast_missing');
  if (corpus.sealedGoldLabelsSha256 === null) fail('locked_corpus_gold_digest_missing');
}

function validateLockedPilotCorpus(
  corpus: BlindCorpus,
  protocolVersion: string,
  expectedDigest: string,
): void {
  validateCorpusShape(corpus, protocolVersion);
  if (corpus.purpose !== 'pilot' || corpus.status !== 'locked') {
    fail('forecast_pilot_not_version_locked');
  }
  if (!isEvidenceDigest(expectedDigest)) fail('expected_pilot_corpus_digest_invalid');
  if (computeBlindCorpusDigest(corpus) !== expectedDigest) fail('pilot_corpus_mutated_after_lock');
  if (corpus.sealedGoldLabelsSha256 === null) fail('locked_pilot_gold_digest_missing');
}

function validateGoldLabels(corpus: BlindCorpus, gold: GoldLabelSet): Map<string, GoldLabel> {
  validateGoldLabelSetArtifact(gold);
  if (gold.corpusVersion !== corpus.corpusVersion) fail('gold_corpus_version_mismatch');
  if (gold.curatorAccessVersion !== corpus.curatorAccessVersion) fail('curator_access_version_mismatch');
  if (computeGoldLabelSetDigest(gold) !== corpus.sealedGoldLabelsSha256) fail('sealed_gold_digest_mismatch');
  if (gold.labels.length !== corpus.examples.length) fail('gold_label_count_mismatch');
  const examplesById = new Map(corpus.examples.map((example) => [example.opaqueExampleId, example]));
  const labelsById = new Map<string, GoldLabel>();
  for (const label of gold.labels) {
    const example = examplesById.get(label.opaqueExampleId);
    if (!example || labelsById.has(label.opaqueExampleId)) fail('gold_label_membership_mismatch');
    if (label.canonicalCorporateFamilyDigest !== example.corporateFamilyDigest) {
      fail('gold_corporate_family_mismatch');
    }
    labelsById.set(label.opaqueExampleId, label);
  }
  return labelsById;
}

function validatePredictionSet(corpus: BlindCorpus, predictions: PredictionSet): Map<string, Prediction> {
  validatePredictionSetArtifact(predictions);
  if (predictions.corpusVersion !== corpus.corpusVersion) fail('prediction_corpus_version_mismatch');
  for (const [field, code] of EVALUATION_VERSION_FIELDS) {
    if (predictions[field] !== corpus[field]) fail(`prediction_${code}_mismatch`);
  }
  if (predictions.corpusSha256 !== computeBlindCorpusDigest(corpus)) fail('prediction_corpus_digest_mismatch');
  if (predictions.predictions.length !== corpus.examples.length) fail('prediction_count_mismatch');
  const exampleIds = new Set(corpus.examples.map((example) => example.opaqueExampleId));
  const byId = new Map<string, Prediction>();
  for (const prediction of predictions.predictions) {
    if (!exampleIds.has(prediction.opaqueExampleId) || byId.has(prediction.opaqueExampleId)) {
      fail('prediction_membership_mismatch');
    }
    if (!prediction.discovered && prediction.publish) fail('undiscovered_prediction_published');
    if (prediction.publish
      && (prediction.predictedDirection === null
        || !isEvidenceDigest(prediction.attributedCorporateFamilyDigest))) {
      fail('published_prediction_incomplete');
    }
    byId.set(prediction.opaqueExampleId, prediction);
  }
  return byId;
}

function assertVersionsMatch(left: BlindCorpus, right: BlindCorpus, prefix: string): void {
  for (const [field, code] of EVALUATION_VERSION_FIELDS) {
    if (left[field] !== right[field]) fail(`${prefix}_${code}_mismatch`);
  }
}

function forecastDenominator(
  minimum: number,
  estimated: number,
): DenominatorForecast {
  return { minimum, estimated, gap: Math.max(0, minimum - estimated) };
}

function ceilGrowth(gap: number, realizedRate: number): number | null {
  if (gap <= 0) return 0;
  if (realizedRate <= 0) return null;
  return Math.ceil(gap / realizedRate);
}

function maximumFiniteGrowth(values: Array<number | null>): number | null {
  return values.some((value) => value === null) ? null : Math.max(...values as number[]);
}

export function forecastBlindEvaluation(input: {
  protocol: JsonObject;
  anchors: { approvedThresholdDigest: string };
  pilotCorpus: BlindCorpus;
  expectedPilotCorpusSha256: string;
  pilotGoldLabels: GoldLabelSet;
  pilotPredictions: PredictionSet;
  targetCorpus: BlindCorpus;
  targetGoldLabels: GoldLabelSet;
  targetExpansion?: BlindExample[];
}): BlindForecast {
  const admission = validateApprovedProtocol(input.protocol, input.anchors.approvedThresholdDigest);
  const definitions = metricDefinitions(admission);
  validateLockedPilotCorpus(
    input.pilotCorpus,
    String(input.protocol.protocolVersion),
    input.expectedPilotCorpusSha256,
  );
  validateCorpusShape(input.targetCorpus, String(input.protocol.protocolVersion));
  if (input.targetCorpus.purpose === 'pilot') fail('forecast_target_must_be_gate');
  if (input.targetCorpus.status !== 'draft') fail('forecast_must_precede_target_freeze');
  assertVersionsMatch(input.pilotCorpus, input.targetCorpus, 'pilot_target');
  const pilotLabels = validateGoldLabels(input.pilotCorpus, input.pilotGoldLabels);
  if (input.pilotPredictions.corpusVersion !== input.pilotCorpus.corpusVersion) {
    fail('forecast_predictions_must_reference_pilot');
  }
  const pilotPredictions = validatePredictionSet(input.pilotCorpus, input.pilotPredictions);
  const targetLabels = validateGoldLabels(input.targetCorpus, input.targetGoldLabels);

  const precommit = input.targetCorpus.precommittedExpansion;
  if (precommit === null) {
    if (input.targetExpansion !== undefined) fail('forecast_expansion_not_precommitted');
  } else {
    if (input.targetExpansion === undefined) fail('forecast_expansion_rows_missing');
    validateExpansionManifestArtifact(input.targetExpansion);
    if (input.targetExpansion.length !== precommit.exampleCount) {
      fail('forecast_expansion_count_mismatch');
    }
    if (computeExpansionManifestDigest(input.targetExpansion) !== precommit.manifestSha256) {
      fail('forecast_expansion_manifest_mismatch');
    }
    assertUniqueExampleDimensions([...input.targetCorpus.examples, ...input.targetExpansion]);
  }
  const targetAndExpansion = [
    ...input.targetCorpus.examples,
    ...(input.targetExpansion ?? []),
  ];

  const overlapFields = [
    'occurrenceDigest',
    'contentFingerprint',
    'corporateFamilyDigest',
    'sourceOriginDigest',
  ] as const;
  for (const field of overlapFields) {
    const pilotValues = new Set(input.pilotCorpus.examples.map((example) => example[field]));
    if (targetAndExpansion.some((example) => pilotValues.has(example[field]))) {
      fail(`pilot_gate_overlap_${field}`);
    }
  }

  // candidateStrata.eligibleDirections reports ELIGIBILITY, as documented. The projection basis
  // below must instead be eligible-AND-material, because that is the population whose rate
  // directionRates measures (see pilotDirectionEligible) and whose rows the scorer actually
  // counts into direction_accuracy_* denominators. Multiplying one by the other's rate
  // over-projects by 1/P(material|eligible) and can report forecast_ok for a short corpus.
  const targetDirectionCounts: Record<Direction, number> = { positive: 0, negative: 0, mixed: 0 };
  const targetMaterialDirectionCounts: Record<Direction, number> = { positive: 0, negative: 0, mixed: 0 };
  for (const label of targetLabels.values()) {
    if (label.publicationEligible) {
      targetDirectionCounts[label.goldDirection] += 1;
      if (label.goldMateriality === 'material') {
        targetMaterialDirectionCounts[label.goldDirection] += 1;
      }
    }
  }

  let published = 0;
  const pilotDirectionEligible: Record<Direction, number> = { positive: 0, negative: 0, mixed: 0 };
  const pilotDirectionCorrect: Record<Direction, number> = { positive: 0, negative: 0, mixed: 0 };
  for (const [exampleId, label] of pilotLabels) {
    const prediction = pilotPredictions.get(exampleId)!;
    if (prediction.publish) published += 1;
    if (label.publicationEligible && label.goldMateriality === 'material') {
      pilotDirectionEligible[label.goldDirection] += 1;
      if (prediction.publish
        && prediction.attributedCorporateFamilyDigest === label.canonicalCorporateFamilyDigest) {
        pilotDirectionCorrect[label.goldDirection] += 1;
      }
    }
  }
  const targetEligible = DIRECTIONS.reduce((sum, direction) => sum + targetDirectionCounts[direction], 0);
  const correctlyAttributedMaterial = DIRECTIONS.reduce(
    (sum, direction) => sum + pilotDirectionCorrect[direction],
    0,
  );
  const publishedRate = published / input.pilotCorpus.examples.length;
  const correctlyAttributedRate = correctlyAttributedMaterial / input.pilotCorpus.examples.length;
  const directionRates = Object.fromEntries(DIRECTIONS.map((direction) => [
    direction,
    pilotDirectionEligible[direction] === 0
      ? 0
      : pilotDirectionCorrect[direction] / pilotDirectionEligible[direction],
  ])) as Record<Direction, number>;
  const expectedDirection = Object.fromEntries(DIRECTIONS.map((direction) => [
    direction,
    targetMaterialDirectionCounts[direction] * directionRates[direction],
  ])) as Record<Direction, number>;
  const expectedPublished = input.targetCorpus.examples.length * publishedRate;
  const expectedDirectionOverall = DIRECTIONS.reduce((sum, direction) => sum + expectedDirection[direction], 0);

  const minimum = (id: Stage3MetricId) =>
    asNumber(definitions.stage3[id].minimumDenominator, `${id}.minimumDenominator`);
  const denominatorForecasts: Record<Stage3MetricId, DenominatorForecast> = {
    published_material_impact_precision: forecastDenominator(
      minimum('published_material_impact_precision'), expectedPublished,
    ),
    published_company_attribution_precision: forecastDenominator(
      minimum('published_company_attribution_precision'), expectedPublished,
    ),
    direction_accuracy_overall: forecastDenominator(
      minimum('direction_accuracy_overall'), expectedDirectionOverall,
    ),
    direction_accuracy_positive: forecastDenominator(
      minimum('direction_accuracy_positive'), expectedDirection.positive,
    ),
    direction_accuracy_negative: forecastDenominator(
      minimum('direction_accuracy_negative'), expectedDirection.negative,
    ),
    direction_accuracy_mixed: forecastDenominator(
      minimum('direction_accuracy_mixed'), expectedDirection.mixed,
    ),
    confidence_calibration_stage3: forecastDenominator(
      minimum('confidence_calibration_stage3'), input.targetCorpus.examples.length,
    ),
  };
  const gaps = STAGE3_METRIC_IDS
    .filter((id) => denominatorForecasts[id].gap > 0)
    .map((metricId) => ({ metricId, missing: denominatorForecasts[metricId].gap }));
  const eligibleGrowth = {
    positive: ceilGrowth(denominatorForecasts.direction_accuracy_positive.gap, directionRates.positive),
    negative: ceilGrowth(denominatorForecasts.direction_accuracy_negative.gap, directionRates.negative),
    mixed: ceilGrowth(denominatorForecasts.direction_accuracy_mixed.gap, directionRates.mixed),
  };
  const publishedGrowth = maximumFiniteGrowth([
    ceilGrowth(denominatorForecasts.published_material_impact_precision.gap, publishedRate),
    ceilGrowth(denominatorForecasts.published_company_attribution_precision.gap, publishedRate),
  ]);
  const targetWeightedOverallRate = expectedDirectionOverall / input.targetCorpus.examples.length;
  const overallGrowth = ceilGrowth(
    denominatorForecasts.direction_accuracy_overall.gap,
    targetWeightedOverallRate,
  );
  // Each direction gap is a required count of successful arrivals. Convert it through that
  // direction's candidate-specific arrival rate; summing eligible-row gaps and dividing through
  // one overall rate hides sparse strata. The overall metric uses the candidate-weighted mixture.
  const directionGrowth = Object.fromEntries(DIRECTIONS.map((direction) => [
    direction,
    ceilGrowth(
      denominatorForecasts[`direction_accuracy_${direction}`].gap,
      targetMaterialDirectionCounts[direction]
        / input.targetCorpus.examples.length * directionRates[direction],
    ),
  ])) as Record<Direction, number | null>;

  return {
    schemaVersion: 'cm_blind_forecast_v1',
    status: gaps.length === 0 ? 'forecast_ok' : 'forecast_warning',
    gating: false,
    protocolVersion: String(input.protocol.protocolVersion),
    approvedThresholdsSha256: input.anchors.approvedThresholdDigest,
    pilotCorpusVersion: input.pilotCorpus.corpusVersion,
    pilotCorpusSha256: input.expectedPilotCorpusSha256,
    targetCorpusVersion: input.targetCorpus.corpusVersion,
    targetCandidateSha256: computeBlindCorpusCandidateDigest(input.targetCorpus),
    targetGoldLabelSetSha256: computeGoldLabelSetDigest(input.targetGoldLabels),
    versions: {
      policyVersion: input.targetCorpus.policyVersion,
      modelVersion: input.targetCorpus.modelVersion,
      classifierRuntimeSha256: input.targetCorpus.classifierRuntimeSha256,
      queryVersion: input.targetCorpus.queryVersion,
      pilotGoldLabelVersion: input.pilotGoldLabels.goldLabelVersion,
      targetGoldLabelVersion: input.targetGoldLabels.goldLabelVersion,
      curatorAccessVersion: input.targetCorpus.curatorAccessVersion,
    },
    candidateStrata: {
      total: input.targetCorpus.examples.length,
      publicationEligible: targetEligible,
      publicationEligibleRate: targetEligible / input.targetCorpus.examples.length,
      eligibleDirections: targetDirectionCounts,
    },
    pilotRealizedRates: {
      publishedDecisionRate: publishedRate,
      correctlyAttributedMaterialRateOverall: correctlyAttributedRate,
      correctlyAttributedMaterialRateByDirection: directionRates,
    },
    denominatorForecasts,
    gaps,
    recommendedUntouchedGrowth: {
      totalExamples: maximumFiniteGrowth([
        publishedGrowth,
        overallGrowth,
        ...Object.values(directionGrowth),
      ]),
      eligibleByDirection: eligibleGrowth,
    },
    stage4Excluded: true,
  };
}

function validateForecast(input: {
  corpus: BlindCorpus;
  goldLabels: GoldLabelSet;
  forecast: BlindForecast;
  approvedThresholdDigest: string;
  previous?: {
    corpus: BlindCorpus;
    goldLabels: GoldLabelSet;
  };
}): void {
  const { corpus, forecast, approvedThresholdDigest } = input;
  validateBlindForecastArtifact(forecast);
  if (forecast.approvedThresholdsSha256 !== approvedThresholdDigest) fail('forecast_protocol_digest_mismatch');
  if (forecast.protocolVersion !== corpus.protocolVersion) fail('forecast_protocol_version_mismatch');
  for (const [field, code] of [
    ['policyVersion', 'policy_version'],
    ['modelVersion', 'model_version'],
    ['classifierRuntimeSha256', 'classifier_runtime_digest'],
    ['queryVersion', 'query_version'],
    ['curatorAccessVersion', 'curator_access_version'],
  ] as const) {
    if (forecast.versions[field] !== corpus[field]) fail(`forecast_${code}_mismatch`);
  }
  const targetCorpus = corpus.continuation === null ? corpus : input.previous?.corpus;
  const targetGoldLabels = corpus.continuation === null ? input.goldLabels : input.previous?.goldLabels;
  if (!targetCorpus || !targetGoldLabels) fail('continuation_parent_inputs_missing');
  if (forecast.targetCorpusVersion !== targetCorpus.corpusVersion) {
    fail('forecast_target_corpus_version_mismatch');
  }
  if (forecast.targetCandidateSha256 !== computeBlindCorpusCandidateDigest(targetCorpus)) {
    fail('forecast_target_candidate_mismatch');
  }
  if (forecast.versions.targetGoldLabelVersion !== targetGoldLabels.goldLabelVersion) {
    fail('forecast_target_gold_label_version_mismatch');
  }
  if (forecast.targetGoldLabelSetSha256 !== computeGoldLabelSetDigest(targetGoldLabels)) {
    fail('forecast_target_gold_label_set_mismatch');
  }
  if (computeForecastDigest(forecast) !== corpus.forecastSha256) fail('forecast_digest_mismatch');
}

function assertPreservedRows<T extends { opaqueExampleId: string }>(
  previous: T[],
  current: T[],
  code: string,
): void {
  const currentById = new Map(current.map((row) => [row.opaqueExampleId, row]));
  for (const row of previous) {
    const preserved = currentById.get(row.opaqueExampleId);
    if (!preserved || canonicalJson(preserved) !== canonicalJson(row)) fail(code);
  }
}

function validateContinuation(input: {
  corpus: BlindCorpus;
  goldLabels: GoldLabelSet;
  predictions: PredictionSet;
  previous: {
    corpus: BlindCorpus;
    expectedCorpusSha256: string;
    goldLabels: GoldLabelSet;
    predictions: PredictionSet;
    report: ScoreReport;
  };
}): { labels: Map<string, GoldLabel>; predictions: Map<string, Prediction> } {
  const { corpus, goldLabels, predictions, previous } = input;
  // The curator-access contract is as much a frozen version as policy/model/query: a
  // continuation that changes who may see what is not the same evaluation.
  if (corpus.curatorAccessVersion !== previous.corpus.curatorAccessVersion) {
    fail('continuation_curator_access_version_mismatch');
  }
  // Purpose continuity. Without this, a tracer_gate corpus -- which is structurally always
  // `incomplete`, since its 100-example floor sits below confidence_calibration_stage3's
  // minimumDenominator -- can be continued into a stage3_gate child that is forced to carry
  // every tracer row. That silently merges two populations the lifecycle keeps separate, the
  // same separation pilot_gate_overlap_* enforces for pilot vs gate.
  if (corpus.purpose !== previous.corpus.purpose) fail('continuation_purpose_mismatch');
  if (previous.report.outcome !== 'incomplete') fail('continuation_requires_incomplete_parent');
  if (corpus.continuation === null) fail('fresh_corpus_retry_forbidden');
  const reference = corpus.continuation;
  if (reference.parentCorpusVersion !== previous.corpus.corpusVersion
    || reference.parentCorpusSha256 !== previous.expectedCorpusSha256
    || reference.parentReportSha256 !== previous.report.reportSha256) {
    fail('continuation_parent_mismatch');
  }
  const expansion = previous.corpus.precommittedExpansion;
  if (expansion === null) fail('continuation_expansion_not_precommitted');
  for (let index = 0; index < previous.corpus.examples.length; index += 1) {
    if (canonicalJson(corpus.examples[index]) !== canonicalJson(previous.corpus.examples[index])) {
      fail('continuation_dropped_scored_example');
    }
  }
  if (corpus.examples.length !== previous.corpus.examples.length + expansion.exampleCount) {
    fail('continuation_expansion_count_mismatch');
  }
  const appended = corpus.examples.slice(previous.corpus.examples.length);
  // Distinct from continuation_expansion_not_precommitted above (parent committed to no
  // expansion at all): here the parent DID precommit, but these are not the rows it named.
  // The two need different remediation, so they need different codes.
  if (computeExpansionManifestDigest(appended) !== expansion.manifestSha256) {
    fail('continuation_expansion_manifest_mismatch');
  }
  const previousPredictionDigest = computePredictionSetDigest(previous.predictions);
  const previousGoldDigest = computeGoldLabelSetDigest(previous.goldLabels);
  if (previousPredictionDigest !== previous.report.predictionSetSha256) {
    fail('previous_prediction_set_digest_mismatch');
  }
  if (previousGoldDigest !== previous.report.goldLabelSetSha256) {
    fail('previous_gold_label_set_digest_mismatch');
  }
  const previousPredictions = validatePredictionSet(previous.corpus, previous.predictions);
  const previousLabels = validateGoldLabels(previous.corpus, previous.goldLabels);
  if (predictions.parentPredictionSetSha256 !== previousPredictionDigest
    || predictions.parentGoldLabelSetSha256 !== previousGoldDigest) {
    fail('continuation_parent_score_set_mismatch');
  }
  assertPreservedRows(previous.predictions.predictions, predictions.predictions, 'continuation_changed_scored_prediction');
  assertPreservedRows(previous.goldLabels.labels, goldLabels.labels, 'continuation_changed_scored_gold_label');
  return { labels: previousLabels, predictions: previousPredictions };
}

function emptyMaterialityMatrix(): Record<Materiality, Record<Materiality, number>> {
  return {
    material: { material: 0, immaterial: 0 },
    immaterial: { material: 0, immaterial: 0 },
  };
}

function emptyDirectionMatrix(): Record<Direction, Record<Direction | 'none', number>> {
  return {
    positive: { positive: 0, negative: 0, mixed: 0, none: 0 },
    negative: { positive: 0, negative: 0, mixed: 0, none: 0 },
    mixed: { positive: 0, negative: 0, mixed: 0, none: 0 },
  };
}

function buildRateMetric(
  admission: JsonObject,
  definition: JsonObject,
  denominator: number,
  numerator: number,
): RateMetricReport {
  const reasons = evaluateAdmissionMetric(admission, definition, { denominator, numerator }).reasons;
  const boundMethod = String(admission.rateBoundMethod);
  const confidenceLevel = asNumber(admission.rateConfidenceLevel, 'admissionQuality.rateConfidenceLevel');
  if (denominator === 0) {
    return {
      kind: 'rate',
      boundMethod,
      confidenceLevel,
      denominator,
      numerator,
      pointEstimate: null,
      lowerBound: null,
      reasons,
    };
  }
  return {
    kind: 'rate',
    boundMethod,
    confidenceLevel,
    denominator,
    numerator,
    pointEstimate: numerator / denominator,
    lowerBound: exactBinomialLowerBound(numerator, denominator, confidenceLevel),
    reasons,
  };
}

function metricReasons(metrics: Record<Stage3MetricId, Stage3MetricReport>): string[] {
  const reasons: string[] = [];
  for (const id of STAGE3_METRIC_IDS) {
    for (const reason of metrics[id].reasons) reasons.push(`${id}_${reason}`);
  }
  return [...new Set(reasons)].sort();
}

type ScoredAggregates = {
  publication: { truePositive: number; falsePositive: number; trueNegative: number; falseNegative: number };
  materiality: Record<Materiality, Record<Materiality, number>>;
  direction: Record<Direction, Record<Direction | 'none', number>>;
  attribution: { correct: number; incorrect: number };
  metrics: Record<Stage3MetricId, Stage3MetricReport>;
  observedDenominators: Record<Stage3MetricId, number>;
  reasons: string[];
  outcome: ScoreOutcome;
  discovery: { denominator: number; numerator: number; rate: number | null };
  customerUsefulness: { denominator: number; numerator: number; rate: number | null };
  calibration: { denominator: number; pointEstimate: number; upperBound: number };
  latencies: number[];
  totalCost: number;
};

// The scoring core, isolated from every validation and identity concern so that the SAME
// computation can be replayed over a continuation parent. An `outcome` must always be
// derived from rows -- never read from an artifact a caller supplied.
function computeScoredAggregates(
  admission: JsonObject,
  definitions: AdmissionMetricDefinitions,
  corpus: BlindCorpus,
  labels: Map<string, GoldLabel>,
  predictions: Map<string, Prediction>,
): ScoredAggregates {
  const publication = { truePositive: 0, falsePositive: 0, trueNegative: 0, falseNegative: 0 };
  const materiality = emptyMaterialityMatrix();
  const direction = emptyDirectionMatrix();
  const attribution = { correct: 0, incorrect: 0 };
  const directionDenominators: Record<Direction, number> = { positive: 0, negative: 0, mixed: 0 };
  const directionCorrect: Record<Direction, number> = { positive: 0, negative: 0, mixed: 0 };
  const calibrationExamples: CalibrationExample[] = [];
  let published = 0;
  let publishedMaterial = 0;
  let discoveryDenominator = 0;
  let discoveredEligible = 0;
  let usefulnessDenominator = 0;
  let usefulnessNumerator = 0;
  const latencies: number[] = [];
  let totalCost = 0;

  for (const example of [...corpus.examples].sort((left, right) =>
    compareCodePoints(left.opaqueExampleId, right.opaqueExampleId))) {
    const label = labels.get(example.opaqueExampleId)!;
    const prediction = predictions.get(example.opaqueExampleId)!;
    if (label.publicationEligible) {
      discoveryDenominator += 1;
      if (prediction.discovered) discoveredEligible += 1;
    }
    const attributionCorrect = prediction.attributedCorporateFamilyDigest
      === label.canonicalCorporateFamilyDigest;
    if (prediction.publish) {
      published += 1;
      if (label.goldMateriality === 'material') publishedMaterial += 1;
      if (attributionCorrect) {
        attribution.correct += 1;
      } else {
        attribution.incorrect += 1;
      }
      if (label.customerUseful !== null) {
        usefulnessDenominator += 1;
        if (label.customerUseful) usefulnessNumerator += 1;
      }
      if (label.publicationEligible
        && label.goldMateriality === 'material'
        && attributionCorrect) {
        directionDenominators[label.goldDirection] += 1;
        if (prediction.predictedDirection === label.goldDirection) {
          directionCorrect[label.goldDirection] += 1;
        }
      }
    }
    if (label.publicationEligible && prediction.publish) publication.truePositive += 1;
    else if (!label.publicationEligible && prediction.publish) publication.falsePositive += 1;
    else if (!label.publicationEligible) publication.trueNegative += 1;
    else publication.falseNegative += 1;
    materiality[label.goldMateriality][prediction.predictedMateriality] += 1;
    direction[label.goldDirection][prediction.predictedDirection ?? 'none'] += 1;

    const publishCorrect = prediction.publish === label.publicationEligible;
    const detailCorrect = !prediction.publish || (
      prediction.predictedMateriality === label.goldMateriality
      && attributionCorrect
      && prediction.predictedDirection === label.goldDirection
    );
    calibrationExamples.push({
      opaqueExampleId: example.opaqueExampleId,
      confidence: prediction.confidence,
      correct: publishCorrect && detailCorrect,
      goldMateriality: label.goldMateriality,
      goldDirection: label.goldDirection,
    });
    latencies.push(prediction.latencyMs);
    const nextTotalCost = totalCost + prediction.costUsd;
    if (!Number.isFinite(nextTotalCost)) fail('prediction_cost_total_overflow');
    totalCost = nextTotalCost;
  }

  const directionOverallDenominator = DIRECTIONS.reduce(
    (sum, value) => sum + directionDenominators[value], 0,
  );
  const directionOverallCorrect = DIRECTIONS.reduce(
    (sum, value) => sum + directionCorrect[value], 0,
  );
  const calibrationDefinition = definitions.stage3.confidence_calibration_stage3;
  const calibrationConfig = asObject(admission.calibration, 'admissionQuality.calibration');
  const calibrationPoint = adaptiveExpectedCalibrationError(calibrationExamples);
  const calibrationUpper = stratifiedBootstrapUpperBound(calibrationExamples, calibrationConfig);
  const calibrationReasons = evaluateAdmissionMetric(admission, calibrationDefinition, {
    denominator: calibrationExamples.length,
    pointEstimate: calibrationPoint,
    upperBound: calibrationUpper,
  }).reasons;
  const metrics: Record<Stage3MetricId, Stage3MetricReport> = {
    published_material_impact_precision: buildRateMetric(
      admission, definitions.stage3.published_material_impact_precision, published, publishedMaterial,
    ),
    published_company_attribution_precision: buildRateMetric(
      admission, definitions.stage3.published_company_attribution_precision,
      published, attribution.correct,
    ),
    direction_accuracy_overall: buildRateMetric(
      admission, definitions.stage3.direction_accuracy_overall,
      directionOverallDenominator, directionOverallCorrect,
    ),
    direction_accuracy_positive: buildRateMetric(
      admission, definitions.stage3.direction_accuracy_positive,
      directionDenominators.positive, directionCorrect.positive,
    ),
    direction_accuracy_negative: buildRateMetric(
      admission, definitions.stage3.direction_accuracy_negative,
      directionDenominators.negative, directionCorrect.negative,
    ),
    direction_accuracy_mixed: buildRateMetric(
      admission, definitions.stage3.direction_accuracy_mixed,
      directionDenominators.mixed, directionCorrect.mixed,
    ),
    confidence_calibration_stage3: {
      kind: 'calibration',
      denominator: calibrationExamples.length,
      pointEstimate: calibrationPoint,
      upperBound: calibrationUpper,
      reasons: calibrationReasons,
    },
  };
  const reasons = metricReasons(metrics);
  const outcome: ScoreOutcome = reasons.some((reason) => reason.endsWith('_denominator_insufficient'))
    ? 'incomplete'
    : reasons.length > 0 ? 'fail' : 'pass';
  latencies.sort((left, right) => left - right);
  const observedDenominators = Object.fromEntries(STAGE3_METRIC_IDS.map((id) => [
    id,
    metrics[id].denominator,
  ])) as Record<Stage3MetricId, number>;

  return {
    publication,
    materiality,
    direction,
    attribution,
    metrics,
    observedDenominators,
    reasons,
    outcome,
    discovery: {
      denominator: discoveryDenominator,
      numerator: discoveredEligible,
      rate: discoveryDenominator === 0 ? null : discoveredEligible / discoveryDenominator,
    },
    customerUsefulness: {
      denominator: usefulnessDenominator,
      numerator: usefulnessNumerator,
      rate: usefulnessDenominator === 0 ? null : usefulnessNumerator / usefulnessDenominator,
    },
    calibration: {
      denominator: calibrationExamples.length,
      pointEstimate: calibrationPoint,
      upperBound: calibrationUpper,
    },
    latencies,
    totalCost,
  };
}

export function scoreBlindEvaluation(input: {
  protocol: JsonObject;
  anchors: { approvedThresholdDigest: string };
  corpus: BlindCorpus;
  expectedCorpusSha256: string;
  goldLabels: GoldLabelSet;
  predictions: PredictionSet;
  forecast: BlindForecast;
  previous?: {
    corpus: BlindCorpus;
    expectedCorpusSha256: string;
    goldLabels: GoldLabelSet;
    predictions: PredictionSet;
    report: ScoreReport;
  };
}): ScoreReport {
  const admission = validateApprovedProtocol(input.protocol, input.anchors.approvedThresholdDigest);
  const definitions = metricDefinitions(admission);
  const protocolVersion = String(input.protocol.protocolVersion);
  validateLockedCorpus(input.corpus, protocolVersion, input.expectedCorpusSha256);
  if (input.corpus.continuation !== null && !input.previous) {
    fail('continuation_parent_inputs_missing');
  }
  if (input.previous) {
    if (!EVALUATION_VERSION_FIELDS.every(([field]) =>
      input.corpus[field] === input.previous!.corpus[field])) {
      fail('continuation_version_mismatch');
    }
    validateLockedCorpus(
      input.previous.corpus,
      protocolVersion,
      input.previous.expectedCorpusSha256,
    );
    if (input.corpus.continuation !== null) {
      const previousLockedAt = parseRfc3339Timestamp(input.previous.corpus.lockedAt)!;
      const childLockedAt = parseRfc3339Timestamp(input.corpus.lockedAt)!;
      if (previousLockedAt >= childLockedAt) fail('continuation_parent_lock_not_before_child');
    }
    if (input.previous.report.schemaVersion !== 'cm_blind_score_report_v1') {
      fail('previous_report_schema_version_invalid');
    }
    // Self-consistency only: computeScoreReportDigest is exported and unsalted, so this
    // proves the file was not corrupted -- it proves nothing about who wrote it.
    if (computeScoreReportDigest(input.previous.report) !== input.previous.report.reportSha256) {
      fail('previous_report_digest_invalid');
    }
    if (input.previous.report.corpus.version !== input.previous.corpus.corpusVersion
      || input.previous.report.corpus.sha256 !== input.previous.expectedCorpusSha256) {
      fail('previous_report_corpus_mismatch');
    }
    if (input.previous.report.versions.policyVersion !== input.previous.corpus.policyVersion
      || input.previous.report.versions.modelVersion !== input.previous.corpus.modelVersion
      || input.previous.report.versions.classifierRuntimeSha256
        !== input.previous.corpus.classifierRuntimeSha256
      || input.previous.report.versions.queryVersion !== input.previous.corpus.queryVersion
      || input.previous.report.versions.curatorAccessVersion
        !== input.previous.corpus.curatorAccessVersion) {
      fail('previous_report_versions_mismatch');
    }
    const previousSets = validateContinuation({
      corpus: input.corpus,
      goldLabels: input.goldLabels,
      predictions: input.predictions,
      previous: input.previous,
    });
    // The parent must have been scored under the SAME approved protocol. Otherwise a corpus
    // can be scored under a variant protocol (same protocolVersion string, inflated
    // minimumDenominator, re-anchored digest) purely to manufacture the `incomplete` that
    // unlocks a continuation, then continued under the real one -- every other parent check
    // survives, because the corpus/gold/prediction digests are protocol-independent and the
    // report digest is self-consistent by construction. Ordered after validateContinuation so
    // plain corpus-vs-corpus version drift still reports continuation_version_mismatch.
    if (input.previous.report.protocol.version !== protocolVersion
      || input.previous.report.protocol.approvedThresholdsSha256
        !== input.anchors.approvedThresholdDigest) {
      fail('previous_report_protocol_mismatch');
    }
    // THE continuation gate. validateContinuation has by now re-validated the parent's gold
    // labels and predictions against the parent corpus, so replaying the scoring core over
    // them re-derives the parent verdict from rows instead of reading it out of a
    // caller-supplied artifact. Without this, editing `outcome` to "incomplete" and
    // recomputing the self-digest reopens a gate that already said fail.
    const parentScored = computeScoredAggregates(
      admission,
      definitions,
      input.previous.corpus,
      previousSets.labels,
      previousSets.predictions,
    );
    if (parentScored.outcome !== input.previous.report.outcome) {
      fail('previous_report_outcome_not_reproducible');
    }
    if (canonicalJson(parentScored.reasons) !== canonicalJson(input.previous.report.reasons)) {
      fail('previous_report_reasons_not_reproducible');
    }
  }
  const labels = validateGoldLabels(input.corpus, input.goldLabels);
  const predictions = validatePredictionSet(input.corpus, input.predictions);
  validateForecast({
    corpus: input.corpus,
    goldLabels: input.goldLabels,
    forecast: input.forecast,
    approvedThresholdDigest: input.anchors.approvedThresholdDigest,
    previous: input.previous,
  });

  const scored = computeScoredAggregates(admission, definitions, input.corpus, labels, predictions);

  const calibrationConfig = asObject(admission.calibration, 'admissionQuality.calibration');
  const { latencies } = scored;
  const reportBase: Omit<ScoreReport, 'reportSha256'> = {
    schemaVersion: 'cm_blind_score_report_v1',
    outcome: scored.outcome,
    reasons: scored.reasons,
    protocol: {
      version: protocolVersion,
      approvedThresholdsSha256: input.anchors.approvedThresholdDigest,
    },
    corpus: {
      version: input.corpus.corpusVersion,
      sha256: input.expectedCorpusSha256,
      purpose: input.corpus.purpose as Exclude<EvaluationPurpose, 'pilot'>,
      exampleCount: input.corpus.examples.length,
      parentCorpusVersion: input.corpus.continuation?.parentCorpusVersion ?? null,
    },
    versions: {
      policyVersion: input.corpus.policyVersion,
      modelVersion: input.corpus.modelVersion,
      classifierRuntimeSha256: input.corpus.classifierRuntimeSha256,
      queryVersion: input.corpus.queryVersion,
      goldLabelVersion: input.goldLabels.goldLabelVersion,
      curatorAccessVersion: input.corpus.curatorAccessVersion,
    },
    forecast: input.forecast,
    observedDenominators: scored.observedDenominators,
    metrics: scored.metrics,
    discovery: scored.discovery,
    customerUsefulness: scored.customerUsefulness,
    confusionMatrices: {
      publication: scored.publication,
      materiality: scored.materiality,
      direction: scored.direction,
      attribution: scored.attribution,
    },
    calibration: {
      denominator: scored.calibration.denominator,
      pointEstimate: scored.calibration.pointEstimate,
      upperBound: scored.calibration.upperBound,
      metric: String(calibrationConfig.metric),
      binning: String(calibrationConfig.binning),
      bootstrapMethod: String(calibrationConfig.bootstrapMethod),
      bootstrapIterations: asNumber(calibrationConfig.bootstrapIterations, 'bootstrapIterations'),
      bootstrapSeed: asNumber(calibrationConfig.bootstrapSeed, 'bootstrapSeed'),
    },
    latency: {
      count: latencies.length,
      minMs: latencies[0]!,
      p50Ms: percentileOrderStatistic(latencies, 0.5, latencies.length),
      p95Ms: percentileOrderStatistic(latencies, 0.95, latencies.length),
      maxMs: latencies[latencies.length - 1]!,
    },
    cost: {
      totalUsd: scored.totalCost,
      averagePerExampleUsd: scored.totalCost / input.corpus.examples.length,
    },
    predictionSetSha256: computePredictionSetDigest(input.predictions),
    goldLabelSetSha256: computeGoldLabelSetDigest(input.goldLabels),
    stage4: {
      included: false,
      minimumExamples: stage4MinimumExamples(definitions.stage4),
      releaseInput: 'separate_post_v1',
    },
  };
  const report = { ...reportBase, reportSha256: '' } as ScoreReport;
  report.reportSha256 = computeScoreReportDigest(report);
  return report;
}
