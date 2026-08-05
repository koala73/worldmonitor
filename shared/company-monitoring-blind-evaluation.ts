// Private/offline Company Monitoring blind-evaluation contracts.
//
// This module deliberately performs no provider calls, persistence, classification, or publication.
// It consumes the approved cm_eval_v1 protocol, opaque corpus manifests, sealed curator labels, and
// version-locked prediction sets to produce aggregate forecasts and deterministic score reports.
import { createHash } from 'node:crypto';
import {
  adaptiveExpectedCalibrationError,
  asNumber,
  asObject,
  canonicalJson,
  compareCodePoints,
  evaluateAdmissionMetric,
  exactBinomialLowerBound,
  isEvidenceDigest,
  parseRfc3339Timestamp,
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
  versions: {
    policyVersion: string;
    modelVersion: string;
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

export type Stage3MetricId =
  | 'published_material_impact_precision'
  | 'published_company_attribution_precision'
  | 'direction_accuracy_overall'
  | 'direction_accuracy_positive'
  | 'direction_accuracy_negative'
  | 'direction_accuracy_mixed'
  | 'confidence_calibration_stage3';

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
const MATERIALITIES: Materiality[] = ['material', 'immaterial'];
const OPAQUE_EXAMPLE_ID = /^cm_example_[a-f0-9]{6}$/;
const VERSION = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const STAGE3_METRIC_IDS: Stage3MetricId[] = [
  'published_material_impact_precision',
  'published_company_attribution_precision',
  'direction_accuracy_overall',
  'direction_accuracy_positive',
  'direction_accuracy_negative',
  'direction_accuracy_mixed',
  'confidence_calibration_stage3',
];
const EVALUATION_VERSION_FIELDS = [
  ['protocolVersion', 'protocol_version'],
  ['policyVersion', 'policy_version'],
  ['modelVersion', 'model_version'],
  ['queryVersion', 'query_version'],
] as const;

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

function requireVersion(value: unknown, code: string): string {
  if (typeof value !== 'string' || !VERSION.test(value)) fail(code);
  return value;
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

export function computeGoldLabelSetDigest(gold: GoldLabelSet): string {
  return sha256(canonicalJson(normalizedGoldLabelSet(gold)));
}

export function computePredictionSetDigest(predictions: PredictionSet): string {
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

function metricDefinitions(admission: JsonObject): Record<Stage3MetricId, JsonObject> {
  if (!Array.isArray(admission.metrics)) fail('admission_metrics_missing');
  const byId = new Map<string, JsonObject>();
  for (const value of admission.metrics) {
    const definition = asObject(value, 'admissionMetric');
    byId.set(String(definition.id ?? ''), definition);
  }
  const result = {} as Record<Stage3MetricId, JsonObject>;
  for (const id of STAGE3_METRIC_IDS) {
    const definition = byId.get(id);
    if (!definition) fail(`admission_metric_missing_${id}`);
    result[id] = definition;
  }
  if (!byId.has('confidence_calibration_stage4')) fail('stage4_metric_missing_from_protocol');
  return result;
}

function stage4MinimumExamples(admission: JsonObject): number {
  const metrics = admission.metrics as JsonObject[];
  const definition = metrics.find((metric) => metric.id === 'confidence_calibration_stage4');
  if (!definition) fail('stage4_metric_missing_from_protocol');
  return asNumber(definition.minimumDenominator, 'confidence_calibration_stage4.minimumDenominator');
}

function validateBlindExample(example: BlindExample): void {
  if (!OPAQUE_EXAMPLE_ID.test(example.opaqueExampleId)) fail('example_id_invalid');
  for (const [field, digest] of [
    ['occurrence', example.occurrenceDigest],
    ['content_fingerprint', example.contentFingerprint],
    ['corporate_family', example.corporateFamilyDigest],
    ['source_origin', example.sourceOriginDigest],
  ] as const) {
    if (!isEvidenceDigest(digest)) fail(`example_${field}_digest_invalid`);
  }
}

function assertUniqueExampleDimensions(examples: BlindExample[]): void {
  const dimensions = [
    'opaqueExampleId',
    'occurrenceDigest',
    'contentFingerprint',
    'corporateFamilyDigest',
    'sourceOriginDigest',
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
  if (corpus.schemaVersion !== 'cm_blind_corpus_v1') fail('corpus_schema_version_invalid');
  requireVersion(corpus.corpusVersion, 'corpus_version_invalid');
  requireVersion(corpus.protocolVersion, 'corpus_protocol_version_invalid');
  requireVersion(corpus.policyVersion, 'corpus_policy_version_invalid');
  requireVersion(corpus.modelVersion, 'corpus_model_version_invalid');
  requireVersion(corpus.queryVersion, 'corpus_query_version_invalid');
  requireVersion(corpus.curatorAccessVersion, 'curator_access_version_invalid');
  if (corpus.protocolVersion !== protocolVersion) fail('corpus_protocol_version_mismatch');
  if ((corpus.purpose as string) === 'stage4_gate') fail('stage4_out_of_scope');
  if (!['pilot', 'tracer_gate', 'stage3_gate'].includes(corpus.purpose)) fail('corpus_purpose_invalid');
  if (!Array.isArray(corpus.examples) || corpus.examples.length === 0) fail('corpus_examples_missing');
  for (const example of corpus.examples) validateBlindExample(example);
  assertUniqueExampleDimensions(corpus.examples);
  if (corpus.purpose === 'tracer_gate' && corpus.examples.length < 100) {
    fail('tracer_corpus_below_100');
  }
  if (corpus.purpose === 'stage3_gate' && corpus.examples.length < 200) {
    fail('stage3_corpus_below_200');
  }
  if (corpus.status === 'locked') {
    if (parseRfc3339Timestamp(corpus.lockedAt) === null) fail('corpus_lock_timestamp_invalid');
  } else if (corpus.status === 'draft') {
    if (corpus.lockedAt !== null) fail('draft_corpus_has_lock_timestamp');
  } else {
    fail('corpus_status_invalid');
  }
  if (corpus.sealedGoldLabelsSha256 !== null && !isEvidenceDigest(corpus.sealedGoldLabelsSha256)) {
    fail('sealed_gold_digest_invalid');
  }
  if (corpus.forecastSha256 !== null && !isEvidenceDigest(corpus.forecastSha256)) {
    fail('forecast_digest_invalid');
  }
  if (corpus.precommittedExpansion !== null) {
    if (!isEvidenceDigest(corpus.precommittedExpansion.manifestSha256)) {
      fail('precommitted_expansion_digest_invalid');
    }
    if (!Number.isInteger(corpus.precommittedExpansion.exampleCount)
      || corpus.precommittedExpansion.exampleCount <= 0) {
      fail('precommitted_expansion_count_invalid');
    }
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

function validateGoldLabels(corpus: BlindCorpus, gold: GoldLabelSet): Map<string, GoldLabel> {
  if (gold.schemaVersion !== 'cm_gold_labels_v1') fail('gold_schema_version_invalid');
  if (gold.corpusVersion !== corpus.corpusVersion) fail('gold_corpus_version_mismatch');
  requireVersion(gold.goldLabelVersion, 'gold_label_version_invalid');
  if (gold.curatorAccessVersion !== corpus.curatorAccessVersion) fail('curator_access_version_mismatch');
  if (computeGoldLabelSetDigest(gold) !== corpus.sealedGoldLabelsSha256) fail('sealed_gold_digest_mismatch');
  if (gold.labels.length !== corpus.examples.length) fail('gold_label_count_mismatch');
  const examplesById = new Map(corpus.examples.map((example) => [example.opaqueExampleId, example]));
  const labelsById = new Map<string, GoldLabel>();
  for (const label of gold.labels) {
    const example = examplesById.get(label.opaqueExampleId);
    if (!example || labelsById.has(label.opaqueExampleId)) fail('gold_label_membership_mismatch');
    if (typeof label.publicationEligible !== 'boolean') fail('gold_publication_eligibility_invalid');
    if (!MATERIALITIES.includes(label.goldMateriality)) fail('gold_materiality_invalid');
    if (!DIRECTIONS.includes(label.goldDirection)) fail('gold_direction_invalid');
    if (label.customerUseful !== null && typeof label.customerUseful !== 'boolean') {
      fail('gold_customer_usefulness_invalid');
    }
    if (label.canonicalCorporateFamilyDigest !== example.corporateFamilyDigest) {
      fail('gold_corporate_family_mismatch');
    }
    labelsById.set(label.opaqueExampleId, label);
  }
  return labelsById;
}

function validatePredictionSet(corpus: BlindCorpus, predictions: PredictionSet): Map<string, Prediction> {
  if (predictions.schemaVersion !== 'cm_predictions_v1') fail('prediction_schema_version_invalid');
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
    if (typeof prediction.discovered !== 'boolean' || typeof prediction.publish !== 'boolean') {
      fail('prediction_boolean_invalid');
    }
    if (!prediction.discovered && prediction.publish) fail('undiscovered_prediction_published');
    if (!MATERIALITIES.includes(prediction.predictedMateriality)) fail('predicted_materiality_invalid');
    if (prediction.predictedDirection !== null && !DIRECTIONS.includes(prediction.predictedDirection)) {
      fail('predicted_direction_invalid');
    }
    if (prediction.publish
      && (prediction.predictedDirection === null
        || !isEvidenceDigest(prediction.attributedCorporateFamilyDigest))) {
      fail('published_prediction_incomplete');
    }
    if (prediction.attributedCorporateFamilyDigest !== null
      && !isEvidenceDigest(prediction.attributedCorporateFamilyDigest)) {
      fail('prediction_attribution_digest_invalid');
    }
    if (typeof prediction.confidence !== 'number'
      || !Number.isFinite(prediction.confidence)
      || prediction.confidence < 0
      || prediction.confidence > 1) {
      fail('prediction_confidence_invalid');
    }
    finiteNonNegative(prediction.latencyMs, 'prediction_latency_invalid');
    finiteNonNegative(prediction.costUsd, 'prediction_cost_invalid');
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
  pilotGoldLabels: GoldLabelSet;
  pilotPredictions: PredictionSet;
  targetCorpus: BlindCorpus;
  targetGoldLabels: GoldLabelSet;
}): BlindForecast {
  const admission = validateApprovedProtocol(input.protocol, input.anchors.approvedThresholdDigest);
  const definitions = metricDefinitions(admission);
  validateCorpusShape(input.pilotCorpus, String(input.protocol.protocolVersion));
  validateCorpusShape(input.targetCorpus, String(input.protocol.protocolVersion));
  if (input.pilotCorpus.purpose !== 'pilot' || input.pilotCorpus.status !== 'locked') {
    fail('forecast_pilot_not_version_locked');
  }
  if (input.targetCorpus.purpose === 'pilot') fail('forecast_target_must_be_gate');
  if (input.targetCorpus.status !== 'draft') fail('forecast_must_precede_target_freeze');
  assertVersionsMatch(input.pilotCorpus, input.targetCorpus, 'pilot_target');
  const pilotLabels = validateGoldLabels(input.pilotCorpus, input.pilotGoldLabels);
  if (input.pilotPredictions.corpusVersion !== input.pilotCorpus.corpusVersion) {
    fail('forecast_predictions_must_reference_pilot');
  }
  const pilotPredictions = validatePredictionSet(input.pilotCorpus, input.pilotPredictions);
  const targetLabels = validateGoldLabels(input.targetCorpus, input.targetGoldLabels);

  const overlapFields = [
    'occurrenceDigest',
    'contentFingerprint',
    'corporateFamilyDigest',
    'sourceOriginDigest',
  ] as const;
  for (const field of overlapFields) {
    const pilotValues = new Set(input.pilotCorpus.examples.map((example) => example[field]));
    if (input.targetCorpus.examples.some((example) => pilotValues.has(example[field]))) {
      fail(`pilot_gate_overlap_${field}`);
    }
  }

  const targetDirectionCounts: Record<Direction, number> = { positive: 0, negative: 0, mixed: 0 };
  let targetEligible = 0;
  for (const label of targetLabels.values()) {
    if (label.publicationEligible) {
      targetEligible += 1;
      targetDirectionCounts[label.goldDirection] += 1;
    }
  }

  let published = 0;
  let correctlyAttributedMaterial = 0;
  const pilotDirectionEligible: Record<Direction, number> = { positive: 0, negative: 0, mixed: 0 };
  const pilotDirectionCorrect: Record<Direction, number> = { positive: 0, negative: 0, mixed: 0 };
  for (const [exampleId, label] of pilotLabels) {
    const prediction = pilotPredictions.get(exampleId)!;
    if (prediction.publish) published += 1;
    if (label.publicationEligible && label.goldMateriality === 'material') {
      pilotDirectionEligible[label.goldDirection] += 1;
      if (prediction.publish
        && prediction.attributedCorporateFamilyDigest === label.canonicalCorporateFamilyDigest) {
        correctlyAttributedMaterial += 1;
        pilotDirectionCorrect[label.goldDirection] += 1;
      }
    }
  }
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
    targetDirectionCounts[direction] * directionRates[direction],
  ])) as Record<Direction, number>;
  const expectedPublished = input.targetCorpus.examples.length * publishedRate;
  const expectedDirectionOverall = DIRECTIONS.reduce((sum, direction) => sum + expectedDirection[direction], 0);

  const minimum = (id: Stage3MetricId) => asNumber(definitions[id].minimumDenominator, `${id}.minimumDenominator`);
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
  const overallGrowth = ceilGrowth(
    denominatorForecasts.direction_accuracy_overall.gap,
    correctlyAttributedRate,
  );
  const eligibleGrowthValues = Object.values(eligibleGrowth);
  const directionGrowth = eligibleGrowthValues.some((value) => value === null)
    ? null
    : (eligibleGrowthValues as number[]).reduce((sum, value) => sum + value, 0);

  return {
    schemaVersion: 'cm_blind_forecast_v1',
    status: gaps.length === 0 ? 'forecast_ok' : 'forecast_warning',
    gating: false,
    protocolVersion: String(input.protocol.protocolVersion),
    approvedThresholdsSha256: input.anchors.approvedThresholdDigest,
    pilotCorpusVersion: input.pilotCorpus.corpusVersion,
    pilotCorpusSha256: computeBlindCorpusDigest(input.pilotCorpus),
    targetCorpusVersion: input.targetCorpus.corpusVersion,
    versions: {
      policyVersion: input.targetCorpus.policyVersion,
      modelVersion: input.targetCorpus.modelVersion,
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
      totalExamples: maximumFiniteGrowth([publishedGrowth, overallGrowth, directionGrowth]),
      eligibleByDirection: eligibleGrowth,
    },
    stage4Excluded: true,
  };
}

function validateForecast(corpus: BlindCorpus, forecast: BlindForecast, approvedThresholdDigest: string): void {
  if (forecast.schemaVersion !== 'cm_blind_forecast_v1' || forecast.gating !== false) {
    fail('forecast_schema_invalid');
  }
  if (forecast.approvedThresholdsSha256 !== approvedThresholdDigest) fail('forecast_protocol_digest_mismatch');
  if (forecast.protocolVersion !== corpus.protocolVersion) fail('forecast_protocol_version_mismatch');
  for (const [field, code] of [
    ['policyVersion', 'policy_version'],
    ['modelVersion', 'model_version'],
    ['queryVersion', 'query_version'],
    ['curatorAccessVersion', 'curator_access_version'],
  ] as const) {
    if (forecast.versions[field] !== corpus[field]) fail(`forecast_${code}_mismatch`);
  }
  const allowedTargetVersion = corpus.continuation?.parentCorpusVersion ?? corpus.corpusVersion;
  if (forecast.targetCorpusVersion !== allowedTargetVersion) fail('forecast_target_corpus_version_mismatch');
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
    goldLabels: GoldLabelSet;
    predictions: PredictionSet;
    report: ScoreReport;
  };
}): void {
  const { corpus, goldLabels, predictions, previous } = input;
  const samePolicy = EVALUATION_VERSION_FIELDS
    .every(([field]) => corpus[field] === previous.corpus[field]);
  if (!samePolicy) return;
  if (previous.report.outcome !== 'incomplete') fail('continuation_requires_incomplete_parent');
  if (corpus.continuation === null) fail('fresh_corpus_retry_forbidden');
  const reference = corpus.continuation;
  if (reference.reason !== 'denominator_shortfall'
    || reference.parentCorpusVersion !== previous.corpus.corpusVersion
    || reference.parentCorpusSha256 !== computeBlindCorpusDigest(previous.corpus)
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
  if (computeExpansionManifestDigest(appended) !== expansion.manifestSha256) {
    fail('continuation_expansion_not_precommitted');
  }
  const previousPredictionDigest = computePredictionSetDigest(previous.predictions);
  const previousGoldDigest = computeGoldLabelSetDigest(previous.goldLabels);
  if (predictions.parentPredictionSetSha256 !== previousPredictionDigest
    || predictions.parentGoldLabelSetSha256 !== previousGoldDigest) {
    fail('continuation_parent_score_set_mismatch');
  }
  assertPreservedRows(previous.predictions.predictions, predictions.predictions, 'continuation_changed_scored_prediction');
  assertPreservedRows(previous.goldLabels.labels, goldLabels.labels, 'continuation_changed_scored_gold_label');
}

function percentileNearestRank(sorted: number[], percentile: number): number {
  const index = Math.max(0, Math.ceil(percentile * sorted.length) - 1);
  return sorted[index]!;
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
    if (computeScoreReportDigest(input.previous.report) !== input.previous.report.reportSha256) {
      fail('previous_report_digest_invalid');
    }
    if (input.previous.report.corpus.version !== input.previous.corpus.corpusVersion
      || input.previous.report.corpus.sha256 !== computeBlindCorpusDigest(input.previous.corpus)) {
      fail('previous_report_corpus_mismatch');
    }
    validateContinuation({
      corpus: input.corpus,
      goldLabels: input.goldLabels,
      predictions: input.predictions,
      previous: input.previous,
    });
  }
  const labels = validateGoldLabels(input.corpus, input.goldLabels);
  const predictions = validatePredictionSet(input.corpus, input.predictions);
  validateForecast(input.corpus, input.forecast, input.anchors.approvedThresholdDigest);

  const publication = { truePositive: 0, falsePositive: 0, trueNegative: 0, falseNegative: 0 };
  const materiality = emptyMaterialityMatrix();
  const direction = emptyDirectionMatrix();
  const attribution = { correct: 0, incorrect: 0 };
  const directionDenominators: Record<Direction, number> = { positive: 0, negative: 0, mixed: 0 };
  const directionCorrect: Record<Direction, number> = { positive: 0, negative: 0, mixed: 0 };
  const calibrationExamples: CalibrationExample[] = [];
  let published = 0;
  let publishedMaterial = 0;
  let publishedAttributionCorrect = 0;
  let discoveryDenominator = 0;
  let discoveredEligible = 0;
  let usefulnessDenominator = 0;
  let usefulnessNumerator = 0;
  const latencies: number[] = [];
  let totalCost = 0;

  for (const example of [...input.corpus.examples].sort((left, right) =>
    compareCodePoints(left.opaqueExampleId, right.opaqueExampleId))) {
    const label = labels.get(example.opaqueExampleId)!;
    const prediction = predictions.get(example.opaqueExampleId)!;
    if (label.publicationEligible) {
      discoveryDenominator += 1;
      if (prediction.discovered) discoveredEligible += 1;
    }
    if (prediction.publish) {
      published += 1;
      if (label.goldMateriality === 'material') publishedMaterial += 1;
      const attributionCorrect = prediction.attributedCorporateFamilyDigest
        === label.canonicalCorporateFamilyDigest;
      if (attributionCorrect) {
        attribution.correct += 1;
        publishedAttributionCorrect += 1;
      } else {
        attribution.incorrect += 1;
      }
      if (label.customerUseful !== null) {
        usefulnessDenominator += 1;
        if (label.customerUseful) usefulnessNumerator += 1;
      }
      if (label.goldMateriality === 'material' && attributionCorrect) {
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

    const attributionCorrect = prediction.attributedCorporateFamilyDigest
      === label.canonicalCorporateFamilyDigest;
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
    totalCost += prediction.costUsd;
  }

  const directionOverallDenominator = DIRECTIONS.reduce(
    (sum, value) => sum + directionDenominators[value], 0,
  );
  const directionOverallCorrect = DIRECTIONS.reduce(
    (sum, value) => sum + directionCorrect[value], 0,
  );
  const calibrationDefinition = definitions.confidence_calibration_stage3;
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
      admission, definitions.published_material_impact_precision, published, publishedMaterial,
    ),
    published_company_attribution_precision: buildRateMetric(
      admission, definitions.published_company_attribution_precision, published, publishedAttributionCorrect,
    ),
    direction_accuracy_overall: buildRateMetric(
      admission, definitions.direction_accuracy_overall, directionOverallDenominator, directionOverallCorrect,
    ),
    direction_accuracy_positive: buildRateMetric(
      admission, definitions.direction_accuracy_positive,
      directionDenominators.positive, directionCorrect.positive,
    ),
    direction_accuracy_negative: buildRateMetric(
      admission, definitions.direction_accuracy_negative,
      directionDenominators.negative, directionCorrect.negative,
    ),
    direction_accuracy_mixed: buildRateMetric(
      admission, definitions.direction_accuracy_mixed,
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

  const reportBase: Omit<ScoreReport, 'reportSha256'> = {
    schemaVersion: 'cm_blind_score_report_v1',
    outcome,
    reasons,
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
      queryVersion: input.corpus.queryVersion,
      goldLabelVersion: input.goldLabels.goldLabelVersion,
      curatorAccessVersion: input.corpus.curatorAccessVersion,
    },
    forecast: input.forecast,
    observedDenominators,
    metrics,
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
    confusionMatrices: { publication, materiality, direction, attribution },
    calibration: {
      denominator: calibrationExamples.length,
      pointEstimate: calibrationPoint,
      upperBound: calibrationUpper,
      metric: String(calibrationConfig.metric),
      binning: String(calibrationConfig.binning),
      bootstrapMethod: String(calibrationConfig.bootstrapMethod),
      bootstrapIterations: asNumber(calibrationConfig.bootstrapIterations, 'bootstrapIterations'),
      bootstrapSeed: asNumber(calibrationConfig.bootstrapSeed, 'bootstrapSeed'),
    },
    latency: {
      count: latencies.length,
      minMs: latencies[0]!,
      p50Ms: percentileNearestRank(latencies, 0.5),
      p95Ms: percentileNearestRank(latencies, 0.95),
      maxMs: latencies[latencies.length - 1]!,
    },
    cost: {
      totalUsd: totalCost,
      averagePerExampleUsd: totalCost / input.corpus.examples.length,
    },
    predictionSetSha256: computePredictionSetDigest(input.predictions),
    goldLabelSetSha256: computeGoldLabelSetDigest(input.goldLabels),
    stage4: {
      included: false,
      minimumExamples: stage4MinimumExamples(admission),
      releaseInput: 'separate_post_v1',
    },
  };
  const report = { ...reportBase, reportSha256: '' } as ScoreReport;
  report.reportSha256 = computeScoreReportDigest(report);
  return report;
}
