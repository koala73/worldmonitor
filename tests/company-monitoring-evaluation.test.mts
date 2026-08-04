import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, it } from 'node:test';

type JsonObject = Record<string, unknown>;

type CalibrationExample = {
  opaqueExampleId: string;
  confidence: number;
  correct: boolean;
  goldMateriality: string;
  goldDirection: string;
};

const fixtureDirectory = new URL('./fixtures/company-monitoring-evaluation/', import.meta.url);
const protocolPath = new URL('protocol.json', fixtureDirectory);
const protocol = JSON.parse(readFileSync(protocolPath, 'utf8')) as JsonObject;

// Independent of protocol.json by design: changing a frozen threshold requires a deliberate edit here.
const APPROVED_THRESHOLD_DIGEST = '29ce1d431086f3b7a9a955776f0c2c009d87c809f810f32f8b10aef53f8ecfc2';
const EXPECTED_BASELINE_REASONS = [
  'base_rate_not_complete',
  'historical_usefulness_not_complete',
  'provider_policy_not_approved',
  'rediscovery_not_complete',
];
const SHA256 = /^[a-f0-9]{64}$/;
const OPAQUE_IMPACT_SET_ID = /^cm_impact_set_[a-f0-9]{12}$/;
const OPAQUE_IMPACT_ID = /^cm_impact_[a-f0-9]{12}$/;
const OPAQUE_CUSTOMER_ID = /^cm_customer_[a-f0-9]{12}$/;
const OPAQUE_EXAMPLE_ID = /^cm_example_[a-f0-9]{6}$/;
const RFC3339_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const BASE_RATE_BOUND_METHOD = 'exact_one_sided_poisson_garwood';
const RATE_BOUND_METHOD = 'exact_one_sided_clopper_pearson';
const CALIBRATION_METRIC = 'adaptive_expected_calibration_error';
const CALIBRATION_BINNING = 'ten_equal_frequency_bins_sorted_by_confidence_then_opaque_id';
const BOOTSTRAP_METHOD = 'stratified_percentile';
const BOOTSTRAP_STRATA = ['gold_materiality', 'gold_direction'];
const BOOTSTRAP_ITERATIONS = 10_000;
const BOOTSTRAP_SEED = 6003;
const BOOTSTRAP_ORDER_STATISTIC = 'ceil_confidence_times_iterations_minus_one';

const BASE_RATE_RESULT_KEYS = new Set([
  'status',
  'companyYears',
  'materialEventCount',
  'pointEstimate',
  'lowerBound',
  'privateSelectionManifestSha256',
  'aggregateEvidenceSha256',
]);
const REDISCOVERY_RESULT_KEYS = new Set([
  'status',
  'pairCount',
  'rediscoveredCount',
  'pointEstimate',
  'lowerBound',
  'privatePairManifestSha256',
  'aggregateEvidenceSha256',
]);
const USEFULNESS_RESULT_KEYS = new Set([
  'status',
  'impactSetId',
  'impacts',
  'customerJudgments',
  'aggregateEvidenceSha256',
]);
const USEFULNESS_IMPACT_KEYS = new Set(['impactId', 'direction']);
const USEFULNESS_CUSTOMER_KEYS = new Set([
  'customerId',
  'externalTargetCustomer',
  'qualificationEvidenceSha256',
  'independent',
  'labels',
]);
const USEFULNESS_LABEL_KEYS = new Set(['impactId', 'useful']);
const PROVIDER_RESULT_KEYS = new Set(['status', 'exa', 'x', 'model']);
const EXA_RESULT_KEYS = new Set(['status', 'paidRuntimeApprovalEvidenceSha256']);
const X_RESULT_KEYS = new Set([
  'status',
  'writtenCommercialUseApprovalEvidenceSha256',
  'offlineContentComplianceEnforcedByRuntime',
  'modelTrainingProhibitionEnforcedByRuntime',
]);
const MODEL_RESULT_KEYS = new Set([
  'status',
  'zeroDataRetentionEnforcedByRuntime',
  'noTrainingEnforcedByRuntime',
  'reasoningDisabledEnforcedByRuntime',
  'modelAndProviderPinnedByRuntime',
]);
const SYNTHETIC_VERIFICATION_KEYS = new Set([
  'classification',
  'eligibleForViabilityDecision',
  'poisson',
  'binomial',
  'calibration',
]);
const SYNTHETIC_POISSON_KEYS = new Set([
  'companyYears',
  'materialEventCount',
  'confidenceLevel',
  'expectedPointEstimate',
  'expectedLowerBound',
]);
const SYNTHETIC_BINOMIAL_KEYS = new Set([
  'pairCount',
  'rediscoveredCount',
  'confidenceLevel',
  'expectedPointEstimate',
  'expectedLowerBound',
]);
const SYNTHETIC_CALIBRATION_KEYS = new Set([
  'examples',
  'expectedPointEstimate',
  'expectedUpperBound',
]);
const SYNTHETIC_CALIBRATION_EXAMPLE_KEYS = new Set([
  'opaqueExampleId',
  'confidence',
  'correct',
  'goldMateriality',
  'goldDirection',
]);
const GOLD_MATERIALITY_VALUES = new Set(['material', 'immaterial']);
const GOLD_DIRECTION_VALUES = new Set(['positive', 'negative', 'mixed']);
const RAW_EVIDENCE_KEYS = new Set([
  'company',
  'companyname',
  'companydomain',
  'customer',
  'customername',
  'customerdomain',
  'prompt',
  'prompttext',
  'content',
  'contenttext',
  'domain',
  'handle',
  'sourceurl',
  'canonicalurl',
]);

function compareCodePoints(left: string, right: string): number {
  const leftCodePoints = [...left];
  const rightCodePoints = [...right];
  const sharedLength = Math.min(leftCodePoints.length, rightCodePoints.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const difference = leftCodePoints[index].codePointAt(0)! - rightCodePoints[index].codePointAt(0)!;
    if (difference !== 0) return difference;
  }
  return leftCodePoints.length - rightCodePoints.length;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, child) => {
    if (!child || typeof child !== 'object' || Array.isArray(child)) return child;
    return Object.fromEntries(
      Object.entries(child as JsonObject).sort(([left], [right]) => compareCodePoints(left, right)),
    );
  });
}

function asObject(value: unknown, label: string): JsonObject {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  return value as JsonObject;
}

function asNumber(value: unknown, label: string): number {
  assert.equal(typeof value, 'number', `${label} must be numeric`);
  assert.ok(Number.isFinite(value as number), `${label} must be finite`);
  return value as number;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function withoutKey(candidate: JsonObject, excludedKey: string): JsonObject {
  return Object.fromEntries(Object.entries(candidate).filter(([key]) => key !== excludedKey));
}

function binomialTailAtLeast(trials: number, successes: number, probability: number): number {
  if (successes <= 0) return 1;
  if (successes > trials || probability <= 0) return 0;
  if (probability >= 1) return 1;

  let logCombination = 0;
  for (let index = 0; index < successes; index += 1) {
    logCombination += Math.log(trials - index) - Math.log(index + 1);
  }
  let term = Math.exp(
    logCombination
      + successes * Math.log(probability)
      + (trials - successes) * Math.log1p(-probability),
  );
  let tail = term;
  for (let observed = successes; observed < trials; observed += 1) {
    term *= ((trials - observed) / (observed + 1)) * (probability / (1 - probability));
    tail += term;
  }
  return Math.min(1, tail);
}

function exactBinomialLowerBound(successes: number, trials: number, confidence: number): number {
  if (successes === 0) return 0;
  const alpha = 1 - confidence;
  let low = 0;
  let high = successes / trials;
  for (let iteration = 0; iteration < 100; iteration += 1) {
    const midpoint = (low + high) / 2;
    if (binomialTailAtLeast(trials, successes, midpoint) < alpha) low = midpoint;
    else high = midpoint;
  }
  return (low + high) / 2;
}

function poissonTailAtLeast(observed: number, mean: number): number {
  if (observed <= 0) return 1;
  if (mean <= 0) return 0;
  let logFactorial = 0;
  for (let value = 2; value <= observed; value += 1) logFactorial += Math.log(value);
  let term = Math.exp(-mean + observed * Math.log(mean) - logFactorial);
  let tail = term;
  for (let value = observed + 1; value < observed + 10_000; value += 1) {
    term *= mean / value;
    tail += term;
    if (value > mean && term <= tail * Number.EPSILON) break;
  }
  return Math.min(1, tail);
}

function exactPoissonRateLowerBound(events: number, exposure: number, confidence: number): number {
  if (events === 0) return 0;
  const alpha = 1 - confidence;
  let low = 0;
  let high = events;
  for (let iteration = 0; iteration < 100; iteration += 1) {
    const midpoint = (low + high) / 2;
    if (poissonTailAtLeast(events, midpoint) < alpha) low = midpoint;
    else high = midpoint;
  }
  return ((low + high) / 2) / exposure;
}

function adaptiveExpectedCalibrationError(examples: CalibrationExample[]): number {
  assert.ok(examples.length > 0, 'calibration examples must not be empty');
  const sorted = [...examples].sort(
    (left, right) => left.confidence - right.confidence
      || left.opaqueExampleId.localeCompare(right.opaqueExampleId),
  );
  const bins: CalibrationExample[][] = Array.from({ length: 10 }, () => []);
  for (const [index, example] of sorted.entries()) {
    bins[Math.min(9, Math.floor((index * 10) / sorted.length))].push(example);
  }
  return bins.reduce((ece, bin) => {
    if (bin.length === 0) return ece;
    const averageConfidence = bin.reduce((sum, example) => sum + example.confidence, 0) / bin.length;
    const averageAccuracy = bin.filter((example) => example.correct).length / bin.length;
    return ece + (bin.length / sorted.length) * Math.abs(averageConfidence - averageAccuracy);
  }, 0);
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function stratifiedBootstrapUpperBound(examples: CalibrationExample[], calibration: JsonObject): number {
  const iterations = asNumber(calibration.bootstrapIterations, 'bootstrapIterations');
  const seed = asNumber(calibration.bootstrapSeed, 'bootstrapSeed');
  const confidence = asNumber(calibration.confidenceLevel, 'calibration.confidenceLevel');
  const random = mulberry32(seed);
  const strata = new Map<string, CalibrationExample[]>();
  for (const example of examples) {
    const key = `${example.goldMateriality}\u0000${example.goldDirection}`;
    const stratum = strata.get(key) ?? [];
    stratum.push(example);
    strata.set(key, stratum);
  }
  const orderedStrata = [...strata.entries()].sort(([left], [right]) => left.localeCompare(right));
  const estimates: number[] = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const sample: CalibrationExample[] = [];
    for (const [, stratum] of orderedStrata) {
      for (let index = 0; index < stratum.length; index += 1) {
        sample.push(stratum[Math.floor(random() * stratum.length)]);
      }
    }
    estimates.push(adaptiveExpectedCalibrationError(sample));
  }
  estimates.sort((left, right) => left - right);
  return estimates[Math.ceil(confidence * iterations) - 1];
}

function frozenThresholds(candidate: JsonObject): JsonObject {
  const baseRate = asObject(candidate.baseRate, 'baseRate');
  const rediscovery = asObject(candidate.rediscovery, 'rediscovery');
  const usefulness = asObject(candidate.historicalUsefulness, 'historicalUsefulness');
  return {
    protocolVersion: candidate.protocolVersion,
    frozenAt: candidate.frozenAt,
    baseRate: withoutKey(baseRate, 'result'),
    rediscovery: withoutKey(rediscovery, 'result'),
    historicalUsefulness: withoutKey(usefulness, 'result'),
    admissionQuality: candidate.admissionQuality,
    economics: candidate.economics,
    providerPolicy: withoutKey(asObject(candidate.providerPolicy, 'providerPolicy'), 'result'),
    changeControl: candidate.changeControl,
  };
}

function thresholdDigest(candidate: JsonObject): string {
  return createHash('sha256').update(canonicalJson(frozenThresholds(candidate))).digest('hex');
}

function evaluateBaseRate(candidate: JsonObject): { pass: boolean; reasons: string[] } {
  const gate = asObject(candidate.baseRate, 'baseRate');
  const thresholds = asObject(gate.thresholds, 'baseRate.thresholds');
  const result = asObject(gate.result, 'baseRate.result');
  if (result.status !== 'complete') return { pass: false, reasons: ['base_rate_not_complete'] };

  const reasons: string[] = [];
  const exposure = finiteNumber(result.companyYears);
  const events = finiteNumber(result.materialEventCount);
  const pointRecorded = finiteNumber(result.pointEstimate);
  const lowerRecorded = finiteNumber(result.lowerBound);
  const minimumExposure = asNumber(thresholds.minimumCompanyYears, 'baseRate.thresholds.minimumCompanyYears');
  const minimumPoint = asNumber(thresholds.minimumPointEstimate, 'baseRate.thresholds.minimumPointEstimate');
  const minimumLower = asNumber(thresholds.minimumLowerBound, 'baseRate.thresholds.minimumLowerBound');
  const confidence = asNumber(thresholds.confidenceLevel, 'baseRate.thresholds.confidenceLevel');

  if (!SHA256.test(String(result.privateSelectionManifestSha256 ?? ''))) {
    reasons.push('base_rate_private_manifest_digest_invalid');
  }
  if (!SHA256.test(String(result.aggregateEvidenceSha256 ?? ''))) {
    reasons.push('base_rate_aggregate_evidence_digest_invalid');
  }
  if (pointRecorded === null) reasons.push('base_rate_point_missing');
  if (lowerRecorded === null) reasons.push('base_rate_lower_bound_missing');
  if (exposure === null || events === null || exposure <= 0 || events < 0 || !Number.isInteger(events)) {
    reasons.push('base_rate_counts_invalid');
    return { pass: false, reasons };
  }
  if (exposure < minimumExposure) reasons.push('base_rate_denominator_insufficient');
  const pointEstimate = events / exposure;
  const lowerBound = exactPoissonRateLowerBound(events, exposure, confidence);
  if (pointEstimate < minimumPoint) reasons.push('base_rate_point_below_floor');
  if (lowerBound < minimumLower) reasons.push('base_rate_lower_bound_below_floor');
  if (pointRecorded !== null && Math.abs(pointRecorded - pointEstimate) > 1e-12) {
    reasons.push('base_rate_point_mismatch');
  }
  if (lowerRecorded !== null && Math.abs(lowerRecorded - lowerBound) > 1e-12) {
    reasons.push('base_rate_lower_bound_mismatch');
  }
  return { pass: reasons.length === 0, reasons };
}

function evaluateRediscovery(candidate: JsonObject): { pass: boolean; reasons: string[] } {
  const gate = asObject(candidate.rediscovery, 'rediscovery');
  const thresholds = asObject(gate.thresholds, 'rediscovery.thresholds');
  const result = asObject(gate.result, 'rediscovery.result');
  if (result.status !== 'complete') return { pass: false, reasons: ['rediscovery_not_complete'] };

  const reasons: string[] = [];
  const pairs = finiteNumber(result.pairCount);
  const rediscovered = finiteNumber(result.rediscoveredCount);
  const pointRecorded = finiteNumber(result.pointEstimate);
  const lowerRecorded = finiteNumber(result.lowerBound);
  const minimumPairs = asNumber(thresholds.minimumPairs, 'rediscovery.thresholds.minimumPairs');
  const minimumPoint = asNumber(thresholds.minimumPointEstimate, 'rediscovery.thresholds.minimumPointEstimate');
  const minimumLower = asNumber(thresholds.minimumLowerBound, 'rediscovery.thresholds.minimumLowerBound');
  const confidence = asNumber(thresholds.confidenceLevel, 'rediscovery.thresholds.confidenceLevel');

  if (!SHA256.test(String(result.privatePairManifestSha256 ?? ''))) {
    reasons.push('rediscovery_private_manifest_digest_invalid');
  }
  if (!SHA256.test(String(result.aggregateEvidenceSha256 ?? ''))) {
    reasons.push('rediscovery_aggregate_evidence_digest_invalid');
  }
  if (pointRecorded === null) reasons.push('rediscovery_point_missing');
  if (lowerRecorded === null) reasons.push('rediscovery_lower_bound_missing');
  if (
    pairs === null
    || rediscovered === null
    || !Number.isInteger(pairs)
    || !Number.isInteger(rediscovered)
    || pairs <= 0
    || rediscovered < 0
    || rediscovered > pairs
  ) {
    reasons.push('rediscovery_counts_invalid');
    return { pass: false, reasons };
  }
  if (pairs < minimumPairs) reasons.push('rediscovery_denominator_insufficient');
  const pointEstimate = rediscovered / pairs;
  const lowerBound = exactBinomialLowerBound(rediscovered, pairs, confidence);
  if (pointEstimate < minimumPoint) reasons.push('rediscovery_point_below_floor');
  if (lowerBound < minimumLower) reasons.push('rediscovery_lower_bound_below_floor');
  if (pointRecorded !== null && Math.abs(pointRecorded - pointEstimate) > 1e-12) {
    reasons.push('rediscovery_point_mismatch');
  }
  if (lowerRecorded !== null && Math.abs(lowerRecorded - lowerBound) > 1e-12) {
    reasons.push('rediscovery_lower_bound_mismatch');
  }
  return { pass: reasons.length === 0, reasons };
}

function evaluateUsefulnessProtocol(candidate: JsonObject): { pass: boolean; reasons: string[] } {
  const usefulness = asObject(candidate.historicalUsefulness, 'historicalUsefulness');
  const reasons: string[] = [];
  const directions = new Set(usefulness.requiredDirections as string[]);
  if (usefulness.status !== 'frozen') reasons.push('usefulness_protocol_not_frozen');
  if (usefulness.externalCustomerCount !== 2) reasons.push('usefulness_requires_two_external_customers');
  if (usefulness.minimumIndependentCustomerCount !== 1) reasons.push('usefulness_requires_independent_customer');
  if (usefulness.sharedImpactCount !== 10 || usefulness.sameImpactSetForEveryCustomer !== true) {
    reasons.push('usefulness_requires_same_ten_impacts');
  }
  for (const direction of ['positive', 'negative', 'mixed']) {
    if (!directions.has(direction)) reasons.push(`usefulness_missing_${direction}`);
  }
  if (usefulness.minimumUsefulRatePerCustomer !== 0.7) reasons.push('usefulness_rate_changed');
  if (usefulness.internalAnalystMayApprove !== false) reasons.push('usefulness_internal_analyst_forbidden');
  return { pass: reasons.length === 0, reasons };
}

function evaluateHistoricalUsefulness(candidate: JsonObject): { pass: boolean; reasons: string[] } {
  const protocolEvaluation = evaluateUsefulnessProtocol(candidate);
  const usefulness = asObject(candidate.historicalUsefulness, 'historicalUsefulness');
  const result = asObject(usefulness.result, 'historicalUsefulness.result');
  if (result.status !== 'complete') {
    return {
      pass: false,
      reasons: [...protocolEvaluation.reasons, 'historical_usefulness_not_complete'],
    };
  }

  const reasons = [...protocolEvaluation.reasons];
  if (!OPAQUE_IMPACT_SET_ID.test(String(result.impactSetId ?? ''))) {
    reasons.push('usefulness_impact_set_id_invalid');
  }
  if (!SHA256.test(String(result.aggregateEvidenceSha256 ?? ''))) {
    reasons.push('usefulness_aggregate_evidence_digest_invalid');
  }
  const impacts = Array.isArray(result.impacts) ? result.impacts.map((value) => asObject(value, 'impact')) : [];
  if (impacts.length !== 10) reasons.push('usefulness_requires_same_ten_impacts');
  const impactIds = new Set<string>();
  const observedDirections = new Set<string>();
  for (const impact of impacts) {
    const impactId = String(impact.impactId ?? '');
    if (!OPAQUE_IMPACT_ID.test(impactId) || impactIds.has(impactId)) {
      reasons.push('usefulness_impact_id_invalid');
    }
    impactIds.add(impactId);
    observedDirections.add(String(impact.direction ?? ''));
  }
  for (const direction of ['positive', 'negative', 'mixed']) {
    if (!observedDirections.has(direction)) reasons.push(`usefulness_result_missing_${direction}`);
  }

  const customerJudgments = Array.isArray(result.customerJudgments)
    ? result.customerJudgments.map((value) => asObject(value, 'customerJudgment'))
    : [];
  if (customerJudgments.length !== 2) reasons.push('usefulness_requires_two_external_customers');
  const customerIds = new Set<string>();
  let independentCustomers = 0;
  for (const judgment of customerJudgments) {
    const customerId = String(judgment.customerId ?? '');
    if (!OPAQUE_CUSTOMER_ID.test(customerId) || customerIds.has(customerId)) {
      reasons.push('usefulness_customer_id_invalid');
    }
    customerIds.add(customerId);
    if (judgment.externalTargetCustomer !== true) {
      reasons.push('usefulness_requires_external_target_customers');
    }
    if (!SHA256.test(String(judgment.qualificationEvidenceSha256 ?? ''))) {
      reasons.push('usefulness_customer_qualification_evidence_invalid');
    }
    if (judgment.independent === true) independentCustomers += 1;
    const labels = Array.isArray(judgment.labels)
      ? judgment.labels.map((value) => asObject(value, 'usefulnessLabel'))
      : [];
    const labeledIds = new Set<string>();
    let usefulCount = 0;
    for (const label of labels) {
      const impactId = String(label.impactId ?? '');
      if (!impactIds.has(impactId) || labeledIds.has(impactId)) reasons.push('usefulness_impact_set_mismatch');
      labeledIds.add(impactId);
      if (label.useful === true) usefulCount += 1;
      else if (label.useful !== false && label.useful !== null) reasons.push('usefulness_label_invalid');
    }
    if (labels.length !== 10 || labeledIds.size !== impactIds.size) reasons.push('usefulness_impact_set_mismatch');
    if (usefulCount < 7) reasons.push('usefulness_customer_below_seven_of_ten');
  }
  if (independentCustomers < 1) reasons.push('usefulness_requires_independent_customer');
  return { pass: reasons.length === 0, reasons: [...new Set(reasons)] };
}

function evaluateAdmissionMetric(
  admission: JsonObject,
  definition: JsonObject,
  result: { denominator: number; numerator?: number; pointEstimate?: number; upperBound?: number },
): { pass: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const minimumDenominator = asNumber(definition.minimumDenominator, 'metric.minimumDenominator');
  if (result.denominator < minimumDenominator) reasons.push('denominator_insufficient');
  if (definition.kind === 'rate') {
    assert.equal(typeof result.numerator, 'number');
    const point = result.numerator / result.denominator;
    const confidence = asNumber(admission.rateConfidenceLevel, 'admissionQuality.rateConfidenceLevel');
    const lower = exactBinomialLowerBound(result.numerator, result.denominator, confidence);
    if (point < asNumber(definition.minimumPointEstimate, 'metric.minimumPointEstimate')) {
      reasons.push('point_below_floor');
    }
    if (lower < asNumber(definition.minimumLowerBound, 'metric.minimumLowerBound')) {
      reasons.push('lower_bound_below_floor');
    }
  } else {
    if (
      (result.pointEstimate ?? Number.POSITIVE_INFINITY)
      > asNumber(definition.maximumPointEstimate, 'metric.maximumPointEstimate')
    ) {
      reasons.push('point_above_ceiling');
    }
    if (
      (result.upperBound ?? Number.POSITIVE_INFINITY)
      > asNumber(definition.maximumUpperBound, 'metric.maximumUpperBound')
    ) {
      reasons.push('upper_bound_above_ceiling');
    }
  }
  return { pass: reasons.length === 0, reasons };
}

function modeledMonthlyCost(candidate: JsonObject): number {
  const economics = asObject(candidate.economics, 'economics');
  const assumptions = asObject(economics.assumptions, 'economics.assumptions');
  const days = asNumber(assumptions.daysPerMonth, 'daysPerMonth');
  const exaSearches = asNumber(assumptions.exaSearchesPerDay, 'exaSearchesPerDay');
  const exaResults = asNumber(assumptions.exaResultsPerSearch, 'exaResultsPerSearch');
  const exaSearchCost = asNumber(assumptions.exaBaseUsdPerSearch, 'exaBaseUsdPerSearch')
    + Math.max(0, exaResults - 10)
      * asNumber(assumptions.exaAdditionalResultUsd, 'exaAdditionalResultUsd');
  const exaCost = days * exaSearches * (
    exaSearchCost
      + exaResults
        * asNumber(assumptions.exaContentTypeUsdPerPage, 'exaContentTypeUsdPerPage')
  );
  const xCost = days * asNumber(assumptions.xPostsReadPerDay, 'xPostsReadPerDay')
    * asNumber(assumptions.xPostReadUsd, 'xPostReadUsd')
    + asNumber(assumptions.xUserReadsPerMonth, 'xUserReadsPerMonth')
      * asNumber(assumptions.xUserReadUsd, 'xUserReadUsd');
  const modelCostBeforeFee = days
    * asNumber(assumptions.classifierCandidatesPerDay, 'classifierCandidatesPerDay')
    * (
      asNumber(assumptions.classifierInputTokensPerCandidate, 'classifierInputTokensPerCandidate')
        * asNumber(assumptions.modelInputUsdPerMillionTokens, 'modelInputUsdPerMillionTokens')
        / 1_000_000
      + asNumber(
        assumptions.classifierOutputTokensPerCandidate,
        'classifierOutputTokensPerCandidate',
      )
        * asNumber(assumptions.modelOutputUsdPerMillionTokens, 'modelOutputUsdPerMillionTokens')
        / 1_000_000
    );
  const modelCost = modelCostBeforeFee
    * (1 + asNumber(assumptions.openRouterCreditFeeRate, 'openRouterCreditFeeRate'));
  const subtotal = exaCost
    + xCost
    + modelCost
    + asNumber(assumptions.allocatedInfrastructureUsd, 'allocatedInfrastructureUsd');
  return subtotal * (1 + asNumber(assumptions.contingencyRate, 'contingencyRate'));
}

function parseRfc3339Timestamp(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = RFC3339_TIMESTAMP.exec(value);
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (
    month < 1
    || month > 12
    || day < 1
    || day > new Date(Date.UTC(year, month, 0)).getUTCDate()
    || hour > 23
    || minute > 59
    || second > 59
  ) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function hasCompleteEmpiricalResult(candidate: JsonObject): boolean {
  return [
    asObject(asObject(candidate.baseRate, 'baseRate').result, 'baseRate.result'),
    asObject(asObject(candidate.rediscovery, 'rediscovery').result, 'rediscovery.result'),
    asObject(
      asObject(candidate.historicalUsefulness, 'historicalUsefulness').result,
      'historicalUsefulness.result',
    ),
  ].some((result) => result.status === 'complete');
}

function evaluateChronology(candidate: JsonObject): { pass: boolean; reasons: string[] } {
  const approval = asObject(candidate.approval, 'approval');
  const reasons: string[] = [];
  const approvedAt = parseRfc3339Timestamp(approval.approvedAt);
  if (approvedAt === null) reasons.push('approval_timestamp_invalid');
  const firstScoreValue = candidate.firstScoredRunStartedAt;
  const firstScore = parseRfc3339Timestamp(firstScoreValue);
  if (firstScoreValue !== null && firstScore === null) reasons.push('first_scored_run_timestamp_invalid');
  if (hasCompleteEmpiricalResult(candidate) && firstScoreValue === null) {
    reasons.push('first_scored_run_timestamp_missing');
  }
  if (approvedAt !== null && firstScore !== null && firstScore <= approvedAt) {
    reasons.push('approval_not_before_first_score');
  }
  return { pass: reasons.length === 0, reasons };
}

function evaluateProviderPolicy(candidate: JsonObject): { pass: boolean; reasons: string[] } {
  const providerPolicy = asObject(candidate.providerPolicy, 'providerPolicy');
  const providers = asObject(providerPolicy.providers, 'providerPolicy.providers');
  const exa = asObject(providers.exa, 'providerPolicy.providers.exa');
  const x = asObject(providers.x, 'providerPolicy.providers.x');
  const model = asObject(providers.model, 'providerPolicy.providers.model');
  const result = asObject(providerPolicy.result, 'providerPolicy.result');
  const exaResult = asObject(result.exa, 'providerPolicy.result.exa');
  const xResult = asObject(result.x, 'providerPolicy.result.x');
  const modelResult = asObject(result.model, 'providerPolicy.result.model');
  const reasons: string[] = [];

  if (exa.evaluationStatus !== 'approved' || exa.paidRuntimeApprovalRequired !== true) {
    reasons.push('exa_evaluation_policy_invalid');
  }
  if (
    x.commercialApprovalRequired !== true
    || x.offlineContentMustTrackEditsProtectionAndWithholding !== true
    || x.modelTrainingOnXContent !== 'prohibited'
  ) {
    reasons.push('x_runtime_policy_invalid');
  }
  if (result.status !== 'approved') reasons.push('provider_runtime_result_not_approved');
  if (exaResult.status !== 'approved') {
    reasons.push('exa_paid_runtime_not_approved');
  }
  if (!SHA256.test(String(exaResult.paidRuntimeApprovalEvidenceSha256 ?? ''))) {
    reasons.push('exa_runtime_approval_evidence_missing');
  }
  if (xResult.status !== 'approved') reasons.push('x_paid_runtime_not_approved');
  if (!SHA256.test(String(xResult.writtenCommercialUseApprovalEvidenceSha256 ?? ''))) {
    reasons.push('x_commercial_use_evidence_missing');
  }
  if (xResult.offlineContentComplianceEnforcedByRuntime !== true) {
    reasons.push('x_content_compliance_not_enforced');
  }
  if (xResult.modelTrainingProhibitionEnforcedByRuntime !== true) {
    reasons.push('x_model_training_prohibition_not_enforced');
  }
  if (modelResult.status !== 'approved') reasons.push('model_paid_runtime_not_approved');
  if (model.zeroDataRetentionRequired !== true || modelResult.zeroDataRetentionEnforcedByRuntime !== true) {
    reasons.push('model_zdr_not_enforced');
  }
  if (model.trainingOnPromptsAllowed !== false || modelResult.noTrainingEnforcedByRuntime !== true) {
    reasons.push('model_no_training_not_enforced');
  }
  if (model.reasoningEnabled !== false || modelResult.reasoningDisabledEnforcedByRuntime !== true) {
    reasons.push('model_no_reasoning_not_enforced');
  }
  if (
    model.modelAndProviderVersionMustBePinned !== true
    || modelResult.modelAndProviderPinnedByRuntime !== true
  ) {
    reasons.push('model_route_not_pinned');
  }
  return { pass: reasons.length === 0, reasons };
}

function hasExactKeys(candidate: JsonObject, allowed: Set<string>): boolean {
  const keys = Object.keys(candidate);
  return keys.length === allowed.size && keys.every((key) => allowed.has(key));
}

function evaluateSyntheticVerificationSchema(candidate: JsonObject): {
  pass: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];
  const synthetic = asObject(candidate.syntheticVerification, 'syntheticVerification');
  const poisson = asObject(synthetic.poisson, 'syntheticVerification.poisson');
  const binomial = asObject(synthetic.binomial, 'syntheticVerification.binomial');
  const calibration = asObject(synthetic.calibration, 'syntheticVerification.calibration');
  if (!hasExactKeys(synthetic, SYNTHETIC_VERIFICATION_KEYS)) {
    reasons.push('synthetic_verification_field_forbidden');
  }
  if (synthetic.classification !== 'synthetic_arithmetic_only') {
    reasons.push('synthetic_verification_classification_invalid');
  }
  if (synthetic.eligibleForViabilityDecision !== false) {
    reasons.push('synthetic_verification_viability_use_forbidden');
  }
  if (!hasExactKeys(poisson, SYNTHETIC_POISSON_KEYS)) {
    reasons.push('synthetic_poisson_field_forbidden');
  }
  if (!hasExactKeys(binomial, SYNTHETIC_BINOMIAL_KEYS)) {
    reasons.push('synthetic_binomial_field_forbidden');
  }
  if (!hasExactKeys(calibration, SYNTHETIC_CALIBRATION_KEYS)) {
    reasons.push('synthetic_calibration_field_forbidden');
  }

  if (!Array.isArray(calibration.examples)) {
    reasons.push('synthetic_calibration_examples_invalid');
    return { pass: false, reasons };
  }
  const exampleIds = new Set<string>();
  for (const value of calibration.examples) {
    const example = asObject(value, 'syntheticCalibrationExample');
    if (!hasExactKeys(example, SYNTHETIC_CALIBRATION_EXAMPLE_KEYS)) {
      reasons.push('synthetic_calibration_example_field_forbidden');
    }
    const opaqueExampleId = String(example.opaqueExampleId ?? '');
    if (!OPAQUE_EXAMPLE_ID.test(opaqueExampleId) || exampleIds.has(opaqueExampleId)) {
      reasons.push('synthetic_calibration_example_id_invalid');
    }
    exampleIds.add(opaqueExampleId);
    const confidence = finiteNumber(example.confidence);
    if (confidence === null || confidence < 0 || confidence > 1) {
      reasons.push('synthetic_calibration_confidence_invalid');
    }
    if (typeof example.correct !== 'boolean') {
      reasons.push('synthetic_calibration_correct_invalid');
    }
    if (!GOLD_MATERIALITY_VALUES.has(String(example.goldMateriality ?? ''))) {
      reasons.push('synthetic_calibration_materiality_invalid');
    }
    if (!GOLD_DIRECTION_VALUES.has(String(example.goldDirection ?? ''))) {
      reasons.push('synthetic_calibration_direction_invalid');
    }
  }
  return { pass: reasons.length === 0, reasons: [...new Set(reasons)] };
}

function evaluateEmpiricalResultSchemas(candidate: JsonObject): { pass: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const baseResult = asObject(asObject(candidate.baseRate, 'baseRate').result, 'baseRate.result');
  const rediscoveryResult = asObject(
    asObject(candidate.rediscovery, 'rediscovery').result,
    'rediscovery.result',
  );
  const usefulnessResult = asObject(
    asObject(candidate.historicalUsefulness, 'historicalUsefulness').result,
    'historicalUsefulness.result',
  );
  const providerResult = asObject(
    asObject(candidate.providerPolicy, 'providerPolicy').result,
    'providerPolicy.result',
  );
  if (!hasExactKeys(baseResult, BASE_RATE_RESULT_KEYS)) {
    reasons.push('base_rate_result_field_forbidden');
  }
  if (!hasExactKeys(rediscoveryResult, REDISCOVERY_RESULT_KEYS)) {
    reasons.push('rediscovery_result_field_forbidden');
  }
  if (!hasExactKeys(usefulnessResult, USEFULNESS_RESULT_KEYS)) {
    reasons.push('usefulness_result_field_forbidden');
  }
  if (Array.isArray(usefulnessResult.impacts)) {
    for (const impact of usefulnessResult.impacts) {
      if (!hasExactKeys(asObject(impact, 'impact'), USEFULNESS_IMPACT_KEYS)) {
        reasons.push('usefulness_impact_field_forbidden');
      }
    }
  }
  if (Array.isArray(usefulnessResult.customerJudgments)) {
    for (const judgmentValue of usefulnessResult.customerJudgments) {
      const judgment = asObject(judgmentValue, 'customerJudgment');
      if (!hasExactKeys(judgment, USEFULNESS_CUSTOMER_KEYS)) {
        reasons.push('usefulness_customer_field_forbidden');
      }
      if (Array.isArray(judgment.labels)) {
        for (const label of judgment.labels) {
          if (!hasExactKeys(asObject(label, 'label'), USEFULNESS_LABEL_KEYS)) {
            reasons.push('usefulness_label_field_forbidden');
          }
        }
      }
    }
  }
  if (!hasExactKeys(providerResult, PROVIDER_RESULT_KEYS)) {
    reasons.push('provider_result_field_forbidden');
  }
  if (!hasExactKeys(asObject(providerResult.exa, 'providerResult.exa'), EXA_RESULT_KEYS)) {
    reasons.push('exa_result_field_forbidden');
  }
  if (!hasExactKeys(asObject(providerResult.x, 'providerResult.x'), X_RESULT_KEYS)) {
    reasons.push('x_result_field_forbidden');
  }
  if (
    !hasExactKeys(asObject(providerResult.model, 'providerResult.model'), MODEL_RESULT_KEYS)
  ) {
    reasons.push('model_result_field_forbidden');
  }
  reasons.push(...evaluateSyntheticVerificationSchema(candidate).reasons);
  return { pass: reasons.length === 0, reasons: [...new Set(reasons)] };
}

function evaluateStage0(candidate: JsonObject): { decision: 'continue' | 'stop'; reasons: string[] } {
  const reasons = [
    ...evaluateBaseRate(candidate).reasons,
    ...evaluateRediscovery(candidate).reasons,
    ...evaluateHistoricalUsefulness(candidate).reasons,
    ...evaluateChronology(candidate).reasons,
    ...evaluateEmpiricalResultSchemas(candidate).reasons,
  ];
  const admission = asObject(candidate.admissionQuality, 'admissionQuality');
  const approval = asObject(candidate.approval, 'approval');
  if (approval.status !== 'approved') reasons.push('product_owner_approval_missing');
  if (approval.approverName !== 'Elie Habib' || approval.approverRole !== 'WorldMonitor product owner') {
    reasons.push('named_product_owner_approval_missing');
  }
  if (approval.approvedThresholdsSha256 !== APPROVED_THRESHOLD_DIGEST) {
    reasons.push('approved_threshold_digest_mismatch');
  }
  if (thresholdDigest(candidate) !== APPROVED_THRESHOLD_DIGEST) {
    reasons.push('frozen_threshold_digest_mismatch');
  }
  if (admission.status !== 'frozen') reasons.push('admission_contract_not_frozen');
  if (!evaluateProviderPolicy(candidate).pass) reasons.push('provider_policy_not_approved');
  const economics = asObject(candidate.economics, 'economics');
  if (
    economics.workloadId !== 'cm_500_company_account_shared_discovery_v1'
    || economics.accountCount !== 1
    || economics.portfolioSize !== 500
    || economics.discoveryMode !== 'account_level_shared_discovery'
    || economics.workloadOrPortfolioChangeRequiresNewCostPackage !== true
  ) {
    reasons.push('economics_workload_package_mismatch');
  }
  const computedCost = modeledMonthlyCost(candidate);
  if (
    Math.abs(computedCost - asNumber(economics.modeledMonthlyCostUsd, 'economics.modeledMonthlyCostUsd'))
    > 1e-9
  ) {
    reasons.push('economics_arithmetic_mismatch');
  }
  const costPerCompany = computedCost / asNumber(economics.portfolioSize, 'economics.portfolioSize');
  if (
    Math.abs(
      costPerCompany
        - asNumber(economics.modeledMonthlyCostPerCompanyUsd, 'economics.modeledMonthlyCostPerCompanyUsd'),
    ) > 1e-9
  ) {
    reasons.push('economics_arithmetic_mismatch');
  }
  if (computedCost > asNumber(economics.maximumMonthlyCostUsd, 'economics.maximumMonthlyCostUsd')) {
    reasons.push('economics_above_ceiling');
  }
  const uniqueReasons = [...new Set(reasons)].sort();
  return { decision: uniqueReasons.length === 0 ? 'continue' : 'stop', reasons: uniqueReasons };
}

function walk(value: unknown, visit: (key: string | null, child: unknown) => void, key: string | null = null): void {
  visit(key, value);
  if (Array.isArray(value)) {
    for (const child of value) walk(child, visit);
  } else if (value && typeof value === 'object') {
    for (const [childKey, child] of Object.entries(value as JsonObject)) walk(child, visit, childKey);
  }
}

function validateProtocolFixture(candidate: JsonObject): void {
  assert.equal(evaluateEmpiricalResultSchemas(candidate).pass, true);
  walk(candidate, (key, value) => {
    if (key) assert.equal(RAW_EVIDENCE_KEYS.has(key.toLowerCase()), false, `raw fixture field: ${key}`);
    if (typeof value === 'string') {
      assert.doesNotMatch(value, /https?:\/\//i, 'fixtures must not contain URLs');
      assert.doesNotMatch(
        value,
        /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
        'fixtures must not contain email addresses',
      );
    }
  });
  const synthetic = asObject(candidate.syntheticVerification, 'syntheticVerification');
  assert.equal(synthetic.classification, 'synthetic_arithmetic_only');
  assert.equal(synthetic.eligibleForViabilityDecision, false);
}

const FIXTURE_VALIDATORS: Record<string, (candidate: JsonObject) => void> = {
  'protocol.json': validateProtocolFixture,
};

function completeSyntheticUsefulness(candidate: JsonObject): void {
  const directions = ['positive', 'negative', 'mixed'];
  const impacts = Array.from({ length: 10 }, (_, index) => ({
    impactId: `cm_impact_${(index + 1).toString(16).padStart(12, '0')}`,
    direction: directions[index % directions.length],
  }));
  const labels = (usefulCount: number) => impacts.map((impact, index) => ({
    impactId: impact.impactId,
    useful: index < usefulCount,
  }));
  Object.assign(
    asObject(
      asObject(candidate.historicalUsefulness, 'historicalUsefulness').result,
      'historicalUsefulness.result',
    ),
    {
      status: 'complete',
      impactSetId: 'cm_impact_set_000000000001',
      impacts,
      customerJudgments: [
        {
          customerId: 'cm_customer_000000000001',
          externalTargetCustomer: true,
          qualificationEvidenceSha256: '3'.repeat(64),
          independent: true,
          labels: labels(7),
        },
        {
          customerId: 'cm_customer_000000000002',
          externalTargetCustomer: true,
          qualificationEvidenceSha256: '4'.repeat(64),
          independent: false,
          labels: labels(8),
        },
      ],
      aggregateEvidenceSha256: 'c'.repeat(64),
    },
  );
}

function makePassingSyntheticCandidate(): JsonObject {
  const candidate = structuredClone(protocol);
  const baseThresholds = asObject(asObject(candidate.baseRate, 'baseRate').thresholds, 'thresholds');
  const rediscoveryThresholds = asObject(
    asObject(candidate.rediscovery, 'rediscovery').thresholds,
    'thresholds',
  );
  Object.assign(asObject(asObject(candidate.baseRate, 'baseRate').result, 'baseRate.result'), {
    status: 'complete',
    companyYears: 150,
    materialEventCount: 45,
    pointEstimate: 45 / 150,
    lowerBound: exactPoissonRateLowerBound(
      45,
      150,
      asNumber(baseThresholds.confidenceLevel, 'baseRate confidence'),
    ),
    privateSelectionManifestSha256: 'a'.repeat(64),
    aggregateEvidenceSha256: 'b'.repeat(64),
  });
  Object.assign(
    asObject(asObject(candidate.rediscovery, 'rediscovery').result, 'rediscovery.result'),
    {
      status: 'complete',
      pairCount: 100,
      rediscoveredCount: 70,
      pointEstimate: 70 / 100,
      lowerBound: exactBinomialLowerBound(
        70,
        100,
        asNumber(rediscoveryThresholds.confidenceLevel, 'rediscovery confidence'),
      ),
      privatePairManifestSha256: 'd'.repeat(64),
      aggregateEvidenceSha256: 'e'.repeat(64),
    },
  );
  completeSyntheticUsefulness(candidate);
  candidate.firstScoredRunStartedAt = '2026-08-05T00:00:01.000Z';
  const providerResult = asObject(
    asObject(candidate.providerPolicy, 'providerPolicy').result,
    'providerPolicy.result',
  );
  providerResult.status = 'approved';
  Object.assign(asObject(providerResult.exa, 'exa'), {
    status: 'approved',
    paidRuntimeApprovalEvidenceSha256: '1'.repeat(64),
  });
  Object.assign(asObject(providerResult.x, 'x'), {
    status: 'approved',
    writtenCommercialUseApprovalEvidenceSha256: '2'.repeat(64),
    offlineContentComplianceEnforcedByRuntime: true,
    modelTrainingProhibitionEnforcedByRuntime: true,
  });
  Object.assign(asObject(providerResult.model, 'model'), {
    status: 'approved',
    zeroDataRetentionEnforcedByRuntime: true,
    noTrainingEnforcedByRuntime: true,
    reasoningDisabledEnforcedByRuntime: true,
    modelAndProviderPinnedByRuntime: true,
  });
  return candidate;
}

describe('Company Monitoring U0 evaluation contract', () => {
  it('requires every committed JSON fixture to have a deliberate schema validator', () => {
    const fixtureFiles = readdirSync(fixtureDirectory)
      .filter((fileName) => fileName.endsWith('.json'))
      .sort();
    assert.deepEqual(fixtureFiles, Object.keys(FIXTURE_VALIDATORS).sort());
    for (const fileName of fixtureFiles) {
      const candidate = JSON.parse(readFileSync(new URL(fileName, fixtureDirectory), 'utf8')) as JsonObject;
      FIXTURE_VALIDATORS[fileName](candidate);
    }
  });

  it('binds the frozen projection and approval to an independent digest literal', () => {
    const approval = asObject(protocol.approval, 'approval');
    assert.equal(thresholdDigest(protocol), APPROVED_THRESHOLD_DIGEST);
    assert.equal(approval.approvedThresholdsSha256, APPROVED_THRESHOLD_DIGEST);
    assert.notEqual(APPROVED_THRESHOLD_DIGEST, '0'.repeat(64));
  });

  it('recomputes the committed Stage 0 stop decision and preserves the dark-only boundary', () => {
    const result = evaluateStage0(protocol);
    const stage0 = asObject(protocol.stage0, 'stage0');
    assert.equal(stage0.decision, result.decision);
    assert.deepEqual(stage0.reasons, EXPECTED_BASELINE_REASONS);
    assert.deepEqual(result.reasons, EXPECTED_BASELINE_REASONS);
    assert.equal(result.decision, 'stop');
    assert.equal(result.reasons.includes('approved_threshold_digest_mismatch'), false);
    assert.equal(result.reasons.includes('frozen_threshold_digest_mismatch'), false);
    assert.deepEqual(stage0.permittedImplementation, ['fixtures', 'dark_contracts']);
    assert.deepEqual(stage0.forbiddenUntilContinue, [
      'paid_provider_runtime',
      'publication',
      'rest_writes',
      'workspace',
      'alerts',
    ]);
  });

  it('independently recomputes every synthetic arithmetic verification fixture', () => {
    const synthetic = asObject(protocol.syntheticVerification, 'syntheticVerification');
    assert.equal(synthetic.eligibleForViabilityDecision, false);
    const poisson = asObject(synthetic.poisson, 'syntheticVerification.poisson');
    const poissonPoint = asNumber(poisson.materialEventCount, 'materialEventCount')
      / asNumber(poisson.companyYears, 'companyYears');
    const poissonLower = exactPoissonRateLowerBound(
      asNumber(poisson.materialEventCount, 'materialEventCount'),
      asNumber(poisson.companyYears, 'companyYears'),
      asNumber(poisson.confidenceLevel, 'confidenceLevel'),
    );
    assert.equal(poissonPoint, asNumber(poisson.expectedPointEstimate, 'expectedPointEstimate'));
    assert.equal(poissonLower, asNumber(poisson.expectedLowerBound, 'expectedLowerBound'));

    const binomial = asObject(synthetic.binomial, 'syntheticVerification.binomial');
    const binomialPoint = asNumber(binomial.rediscoveredCount, 'rediscoveredCount')
      / asNumber(binomial.pairCount, 'pairCount');
    const binomialLower = exactBinomialLowerBound(
      asNumber(binomial.rediscoveredCount, 'rediscoveredCount'),
      asNumber(binomial.pairCount, 'pairCount'),
      asNumber(binomial.confidenceLevel, 'confidenceLevel'),
    );
    assert.equal(binomialPoint, asNumber(binomial.expectedPointEstimate, 'expectedPointEstimate'));
    assert.equal(binomialLower, asNumber(binomial.expectedLowerBound, 'expectedLowerBound'));

    const calibrationFixture = asObject(synthetic.calibration, 'syntheticVerification.calibration');
    const examples = calibrationFixture.examples as CalibrationExample[];
    const admission = asObject(protocol.admissionQuality, 'admissionQuality');
    const calibration = asObject(admission.calibration, 'admissionQuality.calibration');
    const point = adaptiveExpectedCalibrationError(examples);
    const upper = stratifiedBootstrapUpperBound(examples, calibration);
    assert.equal(point, asNumber(calibrationFixture.expectedPointEstimate, 'expectedPointEstimate'));
    assert.equal(upper, asNumber(calibrationFixture.expectedUpperBound, 'expectedUpperBound'));
  });

  it('requires bound result records and leaves the approved threshold digest unchanged', () => {
    const passing = makePassingSyntheticCandidate();
    assert.equal(evaluateBaseRate(passing).pass, true);
    assert.equal(evaluateRediscovery(passing).pass, true);
    assert.equal(thresholdDigest(passing), thresholdDigest(protocol));

    for (const [field, reason] of [
      ['pointEstimate', 'base_rate_point_missing'],
      ['lowerBound', 'base_rate_lower_bound_missing'],
      ['privateSelectionManifestSha256', 'base_rate_private_manifest_digest_invalid'],
      ['aggregateEvidenceSha256', 'base_rate_aggregate_evidence_digest_invalid'],
    ]) {
      const candidate = structuredClone(passing);
      asObject(asObject(candidate.baseRate, 'baseRate').result, 'baseRate.result')[field] = null;
      assert.ok(evaluateBaseRate(candidate).reasons.includes(reason));
    }
    for (const [field, reason] of [
      ['pointEstimate', 'rediscovery_point_missing'],
      ['lowerBound', 'rediscovery_lower_bound_missing'],
      ['privatePairManifestSha256', 'rediscovery_private_manifest_digest_invalid'],
      ['aggregateEvidenceSha256', 'rediscovery_aggregate_evidence_digest_invalid'],
    ]) {
      const candidate = structuredClone(passing);
      asObject(asObject(candidate.rediscovery, 'rediscovery').result, 'rediscovery.result')[field] = null;
      assert.ok(evaluateRediscovery(candidate).reasons.includes(reason));
    }
  });

  it('enforces exact denominators and threshold boundaries', () => {
    const candidate = makePassingSyntheticCandidate();
    const baseResult = asObject(asObject(candidate.baseRate, 'baseRate').result, 'baseRate.result');
    assert.equal(evaluateBaseRate(candidate).pass, true);
    baseResult.companyYears = 149;
    baseResult.pointEstimate = asNumber(baseResult.materialEventCount, 'materialEventCount') / 149;
    baseResult.lowerBound = exactPoissonRateLowerBound(45, 149, 0.9);
    assert.ok(evaluateBaseRate(candidate).reasons.includes('base_rate_denominator_insufficient'));

    const rediscoveryResult = asObject(
      asObject(candidate.rediscovery, 'rediscovery').result,
      'rediscovery.result',
    );
    Object.assign(rediscoveryResult, {
      pairCount: 100,
      rediscoveredCount: 60,
      pointEstimate: 0.6,
      lowerBound: exactBinomialLowerBound(60, 100, 0.9),
    });
    assert.equal(evaluateRediscovery(candidate).pass, true);
    rediscoveryResult.pairCount = 99;
    rediscoveryResult.pointEstimate = 60 / 99;
    rediscoveryResult.lowerBound = exactBinomialLowerBound(60, 99, 0.9);
    assert.ok(evaluateRediscovery(candidate).reasons.includes('rediscovery_denominator_insufficient'));

    const admission = asObject(protocol.admissionQuality, 'admissionQuality');
    const metrics = admission.metrics as JsonObject[];
    const precision = asObject(
      metrics.find((metric) => metric.id === 'published_material_impact_precision'),
      'precision',
    );
    assert.equal(evaluateAdmissionMetric(admission, precision, { denominator: 100, numerator: 92 }).pass, true);
    assert.ok(
      evaluateAdmissionMetric(admission, precision, { denominator: 99, numerator: 92 }).reasons.includes(
        'denominator_insufficient',
      ),
    );
  });

  it('requires valid approval chronology before any completed empirical score', () => {
    const invalidApproval = makePassingSyntheticCandidate();
    asObject(invalidApproval.approval, 'approval').approvedAt = '2026-02-30T00:00:00Z';
    assert.ok(evaluateChronology(invalidApproval).reasons.includes('approval_timestamp_invalid'));

    const missingScoreStart = makePassingSyntheticCandidate();
    missingScoreStart.firstScoredRunStartedAt = null;
    assert.ok(
      evaluateChronology(missingScoreStart).reasons.includes('first_scored_run_timestamp_missing'),
    );

    const invalidScoreStart = makePassingSyntheticCandidate();
    invalidScoreStart.firstScoredRunStartedAt = 'not-a-timestamp';
    assert.ok(
      evaluateChronology(invalidScoreStart).reasons.includes('first_scored_run_timestamp_invalid'),
    );

    const equalTimestamps = makePassingSyntheticCandidate();
    equalTimestamps.firstScoredRunStartedAt = asObject(equalTimestamps.approval, 'approval').approvedAt;
    assert.ok(evaluateChronology(equalTimestamps).reasons.includes('approval_not_before_first_score'));

    const valid = makePassingSyntheticCandidate();
    assert.equal(evaluateChronology(valid).pass, true);
  });

  it('does not let approved provider status bypass runtime prerequisites', () => {
    const candidate = structuredClone(protocol);
    const result = asObject(
      asObject(candidate.providerPolicy, 'providerPolicy').result,
      'providerPolicy.result',
    );
    result.status = 'approved';
    asObject(result.exa, 'exa').status = 'approved';
    asObject(result.x, 'x').status = 'approved';
    asObject(result.model, 'model').status = 'approved';
    const evaluation = evaluateProviderPolicy(candidate);
    assert.equal(evaluation.pass, false);
    assert.deepEqual(evaluation.reasons, [
      'exa_runtime_approval_evidence_missing',
      'x_commercial_use_evidence_missing',
      'x_content_compliance_not_enforced',
      'x_model_training_prohibition_not_enforced',
      'model_zdr_not_enforced',
      'model_no_training_not_enforced',
      'model_no_reasoning_not_enforced',
      'model_route_not_pinned',
    ]);
    assert.equal(evaluateProviderPolicy(makePassingSyntheticCandidate()).pass, true);
  });

  it('keeps historical usefulness stopped until both customers pass the same ten impacts', () => {
    assert.deepEqual(evaluateHistoricalUsefulness(protocol).reasons, [
      'historical_usefulness_not_complete',
    ]);
    const candidate = makePassingSyntheticCandidate();
    assert.equal(evaluateHistoricalUsefulness(candidate).pass, true);
    assert.equal(thresholdDigest(candidate), thresholdDigest(protocol));

    const usefulnessResult = asObject(
      asObject(candidate.historicalUsefulness, 'historicalUsefulness').result,
      'historicalUsefulness.result',
    );
    const judgments = usefulnessResult.customerJudgments as JsonObject[];
    const secondLabels = asObject(judgments[1], 'secondCustomer').labels as JsonObject[];
    for (const [index, label] of secondLabels.entries()) label.useful = index < 6;
    assert.ok(
      evaluateHistoricalUsefulness(candidate).reasons.includes('usefulness_customer_below_seven_of_ten'),
    );
    assert.equal(evaluateStage0(candidate).decision, 'stop');

    const wrongImpactSet = makePassingSyntheticCandidate();
    const wrongJudgments = asObject(
      asObject(wrongImpactSet.historicalUsefulness, 'historicalUsefulness').result,
      'historicalUsefulness.result',
    ).customerJudgments as JsonObject[];
    const wrongLabels = asObject(wrongJudgments[1], 'secondCustomer').labels as JsonObject[];
    asObject(wrongLabels[0], 'firstLabel').impactId = 'cm_impact_ffffffffffff';
    assert.ok(
      evaluateHistoricalUsefulness(wrongImpactSet).reasons.includes('usefulness_impact_set_mismatch'),
    );

    const unqualified = makePassingSyntheticCandidate();
    const unqualifiedJudgments = asObject(
      asObject(unqualified.historicalUsefulness, 'historicalUsefulness').result,
      'historicalUsefulness.result',
    ).customerJudgments as JsonObject[];
    asObject(unqualifiedJudgments[1], 'secondCustomer').externalTargetCustomer = false;
    assert.ok(
      evaluateHistoricalUsefulness(unqualified).reasons.includes(
        'usefulness_requires_external_target_customers',
      ),
    );

    const missingDirection = makePassingSyntheticCandidate();
    const directionImpacts = asObject(
      asObject(missingDirection.historicalUsefulness, 'historicalUsefulness').result,
      'historicalUsefulness.result',
    ).impacts as JsonObject[];
    for (const impact of directionImpacts) impact.direction = 'positive';
    assert.ok(
      evaluateHistoricalUsefulness(missingDirection).reasons.includes(
        'usefulness_result_missing_negative',
      ),
    );
    assert.ok(
      evaluateHistoricalUsefulness(missingDirection).reasons.includes(
        'usefulness_result_missing_mixed',
      ),
    );
  });

  it('rejects raw evidence fields and values from empirical result fixtures', () => {
    for (const field of [
      'companyName',
      'customerName',
      'promptText',
      'content',
      'domain',
      'handle',
      'sourceUrl',
    ]) {
      const candidate = structuredClone(protocol);
      const result = asObject(asObject(candidate.baseRate, 'baseRate').result, 'baseRate.result');
      result[field] = field === 'sourceUrl' ? 'https://fixture.invalid/raw' : 'raw-value-forbidden';
      assert.deepEqual(evaluateEmpiricalResultSchemas(candidate).reasons, [
        'base_rate_result_field_forbidden',
      ]);
      assert.throws(() => validateProtocolFixture(candidate));
    }

    const syntheticCandidate = structuredClone(protocol);
    const synthetic = asObject(syntheticCandidate.syntheticVerification, 'syntheticVerification');
    const calibration = asObject(synthetic.calibration, 'syntheticVerification.calibration');
    const examples = calibration.examples as JsonObject[];
    asObject(examples[0], 'syntheticExample').subjectName = 'raw-value-forbidden';
    assert.ok(
      evaluateEmpiricalResultSchemas(syntheticCandidate).reasons.includes(
        'synthetic_calibration_example_field_forbidden',
      ),
    );
    assert.throws(() => validateProtocolFixture(syntheticCandidate));
  });

  it('binds statistical method metadata to the routines under test', () => {
    const baseThresholds = asObject(asObject(protocol.baseRate, 'baseRate').thresholds, 'thresholds');
    const rediscoveryThresholds = asObject(
      asObject(protocol.rediscovery, 'rediscovery').thresholds,
      'thresholds',
    );
    const admission = asObject(protocol.admissionQuality, 'admissionQuality');
    const calibration = asObject(admission.calibration, 'admissionQuality.calibration');
    assert.equal(baseThresholds.boundMethod, BASE_RATE_BOUND_METHOD);
    assert.equal(baseThresholds.confidenceLevel, 0.9);
    assert.equal(rediscoveryThresholds.boundMethod, RATE_BOUND_METHOD);
    assert.equal(rediscoveryThresholds.confidenceLevel, 0.9);
    assert.equal(admission.rateBoundMethod, RATE_BOUND_METHOD);
    assert.equal(admission.rateConfidenceLevel, 0.9);
    assert.equal(calibration.metric, CALIBRATION_METRIC);
    assert.equal(calibration.binning, CALIBRATION_BINNING);
    assert.equal(calibration.bootstrapMethod, BOOTSTRAP_METHOD);
    assert.deepEqual(calibration.bootstrapStrata, BOOTSTRAP_STRATA);
    assert.equal(calibration.bootstrapIterations, BOOTSTRAP_ITERATIONS);
    assert.equal(calibration.bootstrapSeed, BOOTSTRAP_SEED);
    assert.equal(calibration.confidenceLevel, 0.9);
    assert.equal(calibration.upperBoundOrderStatistic, BOOTSTRAP_ORDER_STATISTIC);

    const changedConfidence = structuredClone(admission);
    changedConfidence.rateConfidenceLevel = 0.99;
    const precision = asObject(
      (admission.metrics as JsonObject[]).find(
        (metric) => metric.id === 'published_material_impact_precision',
      ),
      'precision',
    );
    assert.equal(
      evaluateAdmissionMetric(admission, precision, { denominator: 100, numerator: 92 }).pass,
      true,
    );
    assert.ok(
      evaluateAdmissionMetric(changedConfidence, precision, { denominator: 100, numerator: 92 })
        .reasons.includes('lower_bound_below_floor'),
    );
  });

  it('recomputes the exact one-account 500-company cost package', () => {
    const economics = asObject(protocol.economics, 'economics');
    assert.equal(economics.accountCount, 1);
    assert.equal(economics.portfolioSize, 500);
    assert.equal(economics.discoveryMode, 'account_level_shared_discovery');
    assert.ok(
      Math.abs(
        modeledMonthlyCost(protocol)
          - asNumber(economics.modeledMonthlyCostUsd, 'modeledMonthlyCostUsd'),
      ) < 1e-9,
    );
    const changedWorkload = structuredClone(protocol);
    asObject(changedWorkload.economics, 'economics').portfolioSize = 499;
    assert.ok(evaluateStage0(changedWorkload).reasons.includes('economics_workload_package_mismatch'));
  });

  it('allows a wholly synthetic positive transition without weakening the committed STOP record', () => {
    const candidate = makePassingSyntheticCandidate();
    assert.deepEqual(evaluateStage0(candidate), { decision: 'continue', reasons: [] });
    assert.equal(asObject(protocol.stage0, 'stage0').decision, 'stop');
    assert.equal(asObject(asObject(protocol.baseRate, 'baseRate').result, 'result').status, 'not_run');
    assert.equal(
      asObject(asObject(protocol.historicalUsefulness, 'historicalUsefulness').result, 'result').status,
      'not_run',
    );
  });
});
