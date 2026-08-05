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
// The approval digest is recomputable from the very file it constrains, so on its own it catches
// accidental drift but is not an anchor against a deliberate coordinated edit (fixture threshold +
// digest literal + approval field). These floors are therefore pinned here as independent literals,
// exactly as EXPECTED_BASELINE_REASONS pins the STOP record: weakening a gate must show up as a
// visible test-file edit, not as a fixture edit hidden behind a recomputed hash.
const APPROVED_FLOORS = {
  baseRate: {
    minimumCompanyYears: 150,
    minimumPointEstimate: 0.3,
    minimumLowerBound: 0.2,
    confidenceLevel: 0.9,
  },
  rediscovery: {
    minimumPairs: 100,
    minimumPointEstimate: 0.6,
    minimumLowerBound: 0.5,
    confidenceLevel: 0.9,
  },
  usefulness: {
    externalCustomerCount: 2,
    minimumIndependentCustomerCount: 1,
    sharedImpactCount: 10,
    minimumUsefulRatePerCustomer: 0.7,
  },
  maximumMonthlyCostUsd: 125,
  portfolioSize: 500,
};

// Every top-level key must be declared as either digest-covered or deliberately digest-exempt.
// frozenThresholds() is a hand-written projection, so without this a NEW top-level section would
// silently escape the approved digest.
const DIGEST_COVERED_TOP_LEVEL_KEYS = [
  'protocolVersion',
  'frozenAt',
  'baseRate',
  'rediscovery',
  'historicalUsefulness',
  'admissionQuality',
  'economics',
  'providerPolicy',
  'changeControl',
];
const DIGEST_EXEMPT_TOP_LEVEL_KEYS = [
  'approval',
  'firstScoredRunStartedAt',
  'syntheticVerification',
  'stage0',
];

const ROOT_KEYS = new Set([...DIGEST_COVERED_TOP_LEVEL_KEYS, ...DIGEST_EXEMPT_TOP_LEVEL_KEYS]);
const APPROVAL_KEYS = new Set([
  'status',
  'approverName',
  'approverRole',
  'approvedAt',
  'approvalEvidence',
  'approvedThresholdsSha256',
]);
const STAGE0_KEYS = new Set([
  'evaluatedAt',
  'decision',
  'reasons',
  'permittedImplementation',
  'forbiddenUntilContinue',
]);

const SHA256 = /^[a-f0-9]{64}$/;
// A digest is unverifiable from a unit test, but the degenerate self-certification shapes the
// suite itself used to model a pass (a single hex character repeated 64 times) must not satisfy
// an evidence gate.
const DEGENERATE_DIGEST = /^([a-f0-9])\1{63}$/;

function isEvidenceDigest(value: unknown): boolean {
  const text = String(value ?? '');
  return SHA256.test(text) && !DEGENERATE_DIGEST.test(text);
}

// Distinct, non-degenerate stand-ins for the synthetic transition fixtures. Deliberately not a
// repeated single character: the suite must not model a pass using a shape a real gate rejects.
function syntheticDigest(label: string): string {
  return createHash('sha256').update(`synthetic-evidence:${label}`).digest('hex');
}

const RESULT_STATUS_VALUES = new Set(['not_run', 'incomplete', 'complete']);
const RUNTIME_STATUS_VALUES = new Set(['blocked', 'approved']);

// Every legitimate string in this fixture is a snake_case enum token, a 64-hex digest, an opaque
// cm_* identifier, an RFC3339 timestamp, or one of a tiny set of codes. Free text is therefore made
// unrepresentable rather than denied by name, so an unlisted key cannot smuggle a value through.
const ALLOWED_FIXTURE_VALUE =
  /^(?:[a-z0-9]+(?:_[a-z0-9]+)*|[a-f0-9]{64}|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})|US|GB|USD)$/;
// The only two free-text values the contract legitimately carries; both are pinned to exact
// literals by evaluateStage0's named-approver check, so they cannot be used to smuggle content.
const LITERAL_PINNED_KEYS = new Set(['approverName', 'approverRole']);

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
// Defence in depth only. The load-bearing control is the ALLOWED_FIXTURE_VALUE allow-list plus the
// hasExactKeys pinning; this list is a second net, so it is matched on a normalized key
// (case-folded, separators stripped) to stop company_name / company-name style variants dodging it.
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
  'url',
  'link',
  'href',
  'uri',
  'email',
  'phone',
  'address',
  'name',
  'title',
  'headline',
  'summary',
  'notes',
  'text',
  'excerpt',
  'quote',
  'snippet',
  'portfolio',
  'holdings',
  'contact',
  'ticker',
  'isin',
  'lei',
  'cik',
  'entity',
  'firm',
  'account',
  'userid',
]);

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

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
  return percentileOrderStatistic(estimates, confidence, iterations);
}

// Extracted so the "-1" is directly observable. Asserting it through the bootstrap alone cannot
// kill an off-by-one mutant, because the committed vector's 8999th and 9000th estimates are equal.
function percentileOrderStatistic(sorted: number[], confidence: number, iterations: number): number {
  return sorted[Math.ceil(confidence * iterations) - 1];
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

  if (!isEvidenceDigest(result.privateSelectionManifestSha256)) {
    reasons.push('base_rate_private_manifest_digest_invalid');
  }
  if (!isEvidenceDigest(result.aggregateEvidenceSha256)) {
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

  if (!isEvidenceDigest(result.privatePairManifestSha256)) {
    reasons.push('rediscovery_private_manifest_digest_invalid');
  }
  if (!isEvidenceDigest(result.aggregateEvidenceSha256)) {
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
  if (!isEvidenceDigest(result.aggregateEvidenceSha256)) {
    reasons.push('usefulness_aggregate_evidence_digest_invalid');
  }
  // Derived from the frozen protocol rather than hardcoded, so amending the protocol through the
  // sanctioned fixture+digest path cannot leave a stale bar silently enforcing the old rule.
  const sharedImpactCount = asNumber(
    usefulness.sharedImpactCount,
    'historicalUsefulness.sharedImpactCount',
  );
  const externalCustomerCount = asNumber(
    usefulness.externalCustomerCount,
    'historicalUsefulness.externalCustomerCount',
  );
  const requiredUsefulPerCustomer = Math.ceil(
    asNumber(usefulness.minimumUsefulRatePerCustomer, 'historicalUsefulness.minimumUsefulRatePerCustomer')
      * sharedImpactCount,
  );

  const impacts = Array.isArray(result.impacts) ? result.impacts.map((value) => asObject(value, 'impact')) : [];
  if (impacts.length !== sharedImpactCount) reasons.push('usefulness_requires_same_ten_impacts');
  const impactIds = new Set<string>();
  const observedDirections = new Set<string>();
  for (const impact of impacts) {
    const impactId = String(impact.impactId ?? '');
    if (!OPAQUE_IMPACT_ID.test(impactId) || impactIds.has(impactId)) {
      reasons.push('usefulness_impact_id_invalid');
    }
    impactIds.add(impactId);
    const direction = String(impact.direction ?? '');
    // Previously accumulated without validation, so arbitrary text could ride into the direction
    // coverage check as long as the three required values were present somewhere in the set.
    if (!GOLD_DIRECTION_VALUES.has(direction)) reasons.push('usefulness_impact_direction_invalid');
    observedDirections.add(direction);
  }
  for (const direction of ['positive', 'negative', 'mixed']) {
    if (!observedDirections.has(direction)) reasons.push(`usefulness_result_missing_${direction}`);
  }

  const customerJudgments = Array.isArray(result.customerJudgments)
    ? result.customerJudgments.map((value) => asObject(value, 'customerJudgment'))
    : [];
  if (customerJudgments.length !== externalCustomerCount) {
    reasons.push('usefulness_requires_two_external_customers');
  }
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
    if (!isEvidenceDigest(judgment.qualificationEvidenceSha256)) {
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
    if (labels.length !== sharedImpactCount || labeledIds.size !== impactIds.size) {
      reasons.push('usefulness_impact_set_mismatch');
    }
    if (usefulCount < requiredUsefulPerCustomer) {
      reasons.push('usefulness_customer_below_seven_of_ten');
    }
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
    // Type was checked but range was not, so a numerator above the denominator produced a point
    // estimate above 1 that cleared every floor.
    const numerator = finiteNumber(result.numerator);
    if (
      numerator === null
      || !Number.isInteger(numerator)
      || numerator < 0
      || numerator > result.denominator
    ) {
      reasons.push('numerator_invalid');
      return { pass: false, reasons };
    }
    const point = numerator / result.denominator;
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
  // approvedAt lives in the digest-exempt approval block, so anchor the ordering on the
  // digest-covered frozenAt as well; otherwise an edit to approval alone moves the whole chain.
  const frozenAt = parseRfc3339Timestamp(candidate.frozenAt);
  if (frozenAt === null) reasons.push('protocol_frozen_timestamp_invalid');
  if (frozenAt !== null && approvedAt !== null && frozenAt > approvedAt) {
    reasons.push('protocol_not_frozen_before_approval');
  }
  if (frozenAt !== null && firstScore !== null && firstScore <= frozenAt) {
    reasons.push('protocol_not_frozen_before_first_score');
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
  if (!isEvidenceDigest(exaResult.paidRuntimeApprovalEvidenceSha256)) {
    reasons.push('exa_runtime_approval_evidence_missing');
  }
  if (xResult.status !== 'approved') reasons.push('x_paid_runtime_not_approved');
  if (!isEvidenceDigest(xResult.writtenCommercialUseApprovalEvidenceSha256)) {
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
  // The root, approval and stage0 objects were previously the only unpinned containers in the
  // fixture, so an arbitrary key planted in any of them was invisible to every schema check.
  if (!hasExactKeys(candidate, ROOT_KEYS)) reasons.push('root_field_forbidden');
  if (!hasExactKeys(asObject(candidate.approval, 'approval'), APPROVAL_KEYS)) {
    reasons.push('approval_field_forbidden');
  }
  if (!hasExactKeys(asObject(candidate.stage0, 'stage0'), STAGE0_KEYS)) {
    reasons.push('stage0_field_forbidden');
  }
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
  // Statuses were only ever compared for inequality against one expected value, so an unknown or
  // free-text status was indistinguishable from a legitimate not-yet-run state.
  for (const [label, statusHolder, allowed] of [
    ['base_rate', baseResult, RESULT_STATUS_VALUES],
    ['rediscovery', rediscoveryResult, RESULT_STATUS_VALUES],
    ['usefulness', usefulnessResult, RESULT_STATUS_VALUES],
    ['provider_runtime', providerResult, RUNTIME_STATUS_VALUES],
    ['provider_exa', asObject(providerResult.exa, 'providerResult.exa'), RUNTIME_STATUS_VALUES],
    ['provider_x', asObject(providerResult.x, 'providerResult.x'), RUNTIME_STATUS_VALUES],
    ['provider_model', asObject(providerResult.model, 'providerResult.model'), RUNTIME_STATUS_VALUES],
  ] as [string, JsonObject, Set<string>][]) {
    if (!allowed.has(String(statusHolder.status ?? ''))) {
      reasons.push(`${label}_status_invalid`);
    }
  }
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
    if (key) {
      assert.equal(RAW_EVIDENCE_KEYS.has(normalizeKey(key)), false, `raw fixture field: ${key}`);
    }
    if (typeof value === 'string' && !(key && LITERAL_PINNED_KEYS.has(key))) {
      // Allow-list, not deny-list: a bare domain, a protocol-relative //host, an s3:// URI, an
      // @handle, a phone number or a free-text company name all pass a URL/email deny-list, and
      // none of them can be represented here.
      assert.match(value, ALLOWED_FIXTURE_VALUE, `unconstrained fixture string: ${value}`);
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
          qualificationEvidenceSha256: syntheticDigest('customer_one_qualification'),
          independent: true,
          labels: labels(7),
        },
        {
          customerId: 'cm_customer_000000000002',
          externalTargetCustomer: true,
          qualificationEvidenceSha256: syntheticDigest('customer_two_qualification'),
          independent: false,
          labels: labels(8),
        },
      ],
      aggregateEvidenceSha256: syntheticDigest('usefulness_aggregate'),
    },
  );
}

function usefulnessResultOf(candidate: JsonObject): JsonObject {
  return asObject(
    asObject(candidate.historicalUsefulness, 'historicalUsefulness').result,
    'historicalUsefulness.result',
  );
}

function usefulnessImpacts(candidate: JsonObject): JsonObject[] {
  return usefulnessResultOf(candidate).impacts as JsonObject[];
}

function usefulnessJudgments(candidate: JsonObject): JsonObject[] {
  return usefulnessResultOf(candidate).customerJudgments as JsonObject[];
}

function providerResultOf(candidate: JsonObject): JsonObject {
  return asObject(
    asObject(candidate.providerPolicy, 'providerPolicy').result,
    'providerPolicy.result',
  );
}

function providersOf(candidate: JsonObject): { exa: JsonObject; x: JsonObject; model: JsonObject } {
  const providers = asObject(
    asObject(candidate.providerPolicy, 'providerPolicy').providers,
    'providerPolicy.providers',
  );
  return {
    exa: asObject(providers.exa, 'providers.exa'),
    x: asObject(providers.x, 'providers.x'),
    model: asObject(providers.model, 'providers.model'),
  };
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
    privateSelectionManifestSha256: syntheticDigest('base_rate_private_manifest'),
    aggregateEvidenceSha256: syntheticDigest('base_rate_aggregate'),
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
      privatePairManifestSha256: syntheticDigest('rediscovery_private_manifest'),
      aggregateEvidenceSha256: syntheticDigest('rediscovery_aggregate'),
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
    paidRuntimeApprovalEvidenceSha256: syntheticDigest('exa_paid_runtime_approval'),
  });
  Object.assign(asObject(providerResult.x, 'x'), {
    status: 'approved',
    writtenCommercialUseApprovalEvidenceSha256: syntheticDigest('x_commercial_use_approval'),
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

  it('pins every frozen floor to an independent literal, not just to the digest', () => {
    const baseThresholds = asObject(asObject(protocol.baseRate, 'baseRate').thresholds, 'thresholds');
    const rediscoveryThresholds = asObject(
      asObject(protocol.rediscovery, 'rediscovery').thresholds,
      'thresholds',
    );
    const usefulness = asObject(protocol.historicalUsefulness, 'historicalUsefulness');
    const economics = asObject(protocol.economics, 'economics');

    assert.deepEqual(withoutKey(baseThresholds, 'boundMethod'), APPROVED_FLOORS.baseRate);
    assert.deepEqual(withoutKey(rediscoveryThresholds, 'boundMethod'), APPROVED_FLOORS.rediscovery);
    assert.equal(economics.maximumMonthlyCostUsd, APPROVED_FLOORS.maximumMonthlyCostUsd);
    assert.equal(economics.portfolioSize, APPROVED_FLOORS.portfolioSize);
    for (const [field, expected] of Object.entries(APPROVED_FLOORS.usefulness)) {
      assert.equal(usefulness[field], expected, `usefulness.${field}`);
    }
  });

  it('declares every top-level protocol key as digest-covered or digest-exempt', () => {
    assert.deepEqual(Object.keys(protocol).sort(), [...ROOT_KEYS].sort());
    assert.deepEqual(
      Object.keys(frozenThresholds(protocol)).sort(),
      [...DIGEST_COVERED_TOP_LEVEL_KEYS].sort(),
    );
    // A new top-level section must fail loudly rather than silently escape the projection.
    const extended = structuredClone(protocol);
    extended.paidProviderRuntimeEnabled = true;
    assert.equal(thresholdDigest(extended), APPROVED_THRESHOLD_DIGEST);
    assert.ok(evaluateStage0(extended).reasons.includes('root_field_forbidden'));
    assert.equal(evaluateStage0(extended).decision, 'stop');
  });

  it('rejects unknown keys planted in the root, approval, or stage0 objects', () => {
    for (const [container, reason] of [
      [null, 'root_field_forbidden'],
      ['approval', 'approval_field_forbidden'],
      ['stage0', 'stage0_field_forbidden'],
    ] as [string | null, string][]) {
      const candidate = structuredClone(protocol);
      const target = container === null ? candidate : asObject(candidate[container], container);
      target.notes = 'raw_value_forbidden';
      assert.ok(
        evaluateEmpiricalResultSchemas(candidate).reasons.includes(reason),
        `expected ${reason}`,
      );
      assert.throws(() => validateProtocolFixture(candidate));
    }
  });

  it('rejects identifying values that a URL and email deny-list would admit', () => {
    for (const leak of [
      'acme-holdings.com',
      'www.acme.com/brief',
      '//cdn.acme.com/report',
      's3://acme-private/portfolio.json',
      '@acmeholdings',
      '+1 415 555 0134',
      'Acme Holdings Inc',
      'analyst at acme dot com',
      '1600 Pennsylvania Ave',
      'ACME:NASDAQ',
    ]) {
      const candidate = structuredClone(protocol);
      asObject(candidate.approval, 'approval').approvalEvidence = leak;
      assert.throws(
        () => validateProtocolFixture(candidate),
        `leak payload admitted: ${leak}`,
      );
    }
  });

  it('rejects an unlisted raw-evidence key even where no exact-key pin applies', () => {
    // The original privacy test planted only already-listed names into a hasExactKeys-pinned
    // object, so it passed even with the deny list emptied. This one targets the deny list itself.
    const candidate = structuredClone(protocol);
    asObject(asObject(candidate.baseRate, 'baseRate').population, 'population').company_name = 'acme';
    assert.throws(() => validateProtocolFixture(candidate), /raw fixture field/);
  });

  it('refuses degenerate and reused evidence digests', () => {
    assert.equal(isEvidenceDigest('a'.repeat(64)), false);
    assert.equal(isEvidenceDigest('0'.repeat(64)), false);
    assert.equal(isEvidenceDigest(syntheticDigest('sample')), true);
    assert.equal(isEvidenceDigest('not-a-digest'), false);

    const candidate = makePassingSyntheticCandidate();
    assert.equal(evaluateStage0(candidate).decision, 'continue');
    asObject(asObject(candidate.baseRate, 'baseRate').result, 'result')
      .aggregateEvidenceSha256 = 'f'.repeat(64);
    assert.ok(
      evaluateBaseRate(candidate).reasons.includes('base_rate_aggregate_evidence_digest_invalid'),
    );
    assert.equal(evaluateStage0(candidate).decision, 'stop');
  });

  it('rejects results whose point estimate falls below the frozen floor', () => {
    const baseCandidate = makePassingSyntheticCandidate();
    const baseResult = asObject(
      asObject(baseCandidate.baseRate, 'baseRate').result,
      'baseRate.result',
    );
    Object.assign(baseResult, {
      companyYears: 150,
      materialEventCount: 44,
      pointEstimate: 44 / 150,
      lowerBound: exactPoissonRateLowerBound(44, 150, 0.9),
    });
    assert.ok(evaluateBaseRate(baseCandidate).reasons.includes('base_rate_point_below_floor'));
    assert.equal(evaluateStage0(baseCandidate).decision, 'stop');

    const rediscoveryCandidate = makePassingSyntheticCandidate();
    const rediscoveryResult = asObject(
      asObject(rediscoveryCandidate.rediscovery, 'rediscovery').result,
      'rediscovery.result',
    );
    Object.assign(rediscoveryResult, {
      pairCount: 100,
      rediscoveredCount: 59,
      pointEstimate: 0.59,
      lowerBound: exactBinomialLowerBound(59, 100, 0.9),
    });
    assert.ok(
      evaluateRediscovery(rediscoveryCandidate).reasons.includes('rediscovery_point_below_floor'),
    );
    assert.equal(evaluateStage0(rediscoveryCandidate).decision, 'stop');
  });

  it('documents that each lower-bound floor is subsumed by its point floor at the minimum denominator', () => {
    // At the frozen minimum denominator, a result sitting exactly on the point floor already clears
    // its lower-bound floor, and the bound only tightens as the denominator grows. The lower-bound
    // guards therefore cannot fail a result that passes the point floor -- they are a backstop, not
    // an independent gate. If a future protocol raises a lower-bound floor past this point, this
    // test fails and the relationship must be re-derived rather than silently inverted.
    const baseLower = exactPoissonRateLowerBound(45, 150, APPROVED_FLOORS.baseRate.confidenceLevel);
    assert.equal(45 / 150, APPROVED_FLOORS.baseRate.minimumPointEstimate);
    assert.ok(baseLower > APPROVED_FLOORS.baseRate.minimumLowerBound, `base lower ${baseLower}`);

    const rediscoveryLower = exactBinomialLowerBound(
      60,
      100,
      APPROVED_FLOORS.rediscovery.confidenceLevel,
    );
    assert.equal(60 / 100, APPROVED_FLOORS.rediscovery.minimumPointEstimate);
    assert.ok(
      rediscoveryLower > APPROVED_FLOORS.rediscovery.minimumLowerBound,
      `rediscovery lower ${rediscoveryLower}`,
    );
  });

  it('rejects forged recorded values, not just missing ones', () => {
    const passing = makePassingSyntheticCandidate();
    const cases: [string, string, string, number][] = [
      ['baseRate', 'pointEstimate', 'base_rate_point_mismatch', 1e-6],
      ['baseRate', 'lowerBound', 'base_rate_lower_bound_mismatch', 0.05],
      ['rediscovery', 'pointEstimate', 'rediscovery_point_mismatch', 1e-6],
      ['rediscovery', 'lowerBound', 'rediscovery_lower_bound_mismatch', 0.05],
    ];
    for (const [gate, field, reason, delta] of cases) {
      const candidate = structuredClone(passing);
      const result = asObject(asObject(candidate[gate], gate).result, `${gate}.result`);
      result[field] = asNumber(result[field], field) + delta;
      const evaluation = gate === 'baseRate'
        ? evaluateBaseRate(candidate)
        : evaluateRediscovery(candidate);
      assert.ok(evaluation.reasons.includes(reason), `expected ${reason}`);
      assert.equal(evaluateStage0(candidate).decision, 'stop');
    }
  });

  it('stops on every individual Stage 0 guard, not just the two already covered', () => {
    const cases: [string, (candidate: JsonObject) => void, string][] = [
      ['approval status', (c) => { asObject(c.approval, 'approval').status = 'pending'; }, 'product_owner_approval_missing'],
      ['approver name', (c) => { asObject(c.approval, 'approval').approverName = 'Someone Else'; }, 'named_product_owner_approval_missing'],
      ['recorded digest', (c) => { asObject(c.approval, 'approval').approvedThresholdsSha256 = syntheticDigest('wrong'); }, 'approved_threshold_digest_mismatch'],
      ['frozen threshold', (c) => { asObject(asObject(c.baseRate, 'baseRate').thresholds, 'thresholds').minimumPointEstimate = 0.1; }, 'frozen_threshold_digest_mismatch'],
      ['admission freeze', (c) => { asObject(c.admissionQuality, 'admissionQuality').status = 'draft'; }, 'admission_contract_not_frozen'],
      ['cost arithmetic', (c) => { asObject(c.economics, 'economics').modeledMonthlyCostUsd = 1; }, 'economics_arithmetic_mismatch'],
      ['cost ceiling', (c) => { asObject(asObject(c.economics, 'economics').assumptions, 'assumptions').allocatedInfrastructureUsd = 500; }, 'economics_above_ceiling'],
      ['chronology wiring', (c) => { c.firstScoredRunStartedAt = asObject(c.approval, 'approval').approvedAt; }, 'approval_not_before_first_score'],
      ['schema wiring', (c) => { asObject(asObject(c.baseRate, 'baseRate').result, 'result').companyName = 'acme'; }, 'base_rate_result_field_forbidden'],
      ['provider policy', (c) => { asObject(asObject(asObject(c.providerPolicy, 'providerPolicy').result, 'result').model, 'model').zeroDataRetentionEnforcedByRuntime = false; }, 'provider_policy_not_approved'],
      ['status enum', (c) => { asObject(asObject(c.baseRate, 'baseRate').result, 'result').status = 'looks_fine'; }, 'base_rate_status_invalid'],
    ];
    for (const [label, mutate, reason] of cases) {
      const candidate = makePassingSyntheticCandidate();
      assert.equal(evaluateStage0(candidate).decision, 'continue', `${label}: control`);
      mutate(candidate);
      const evaluation = evaluateStage0(candidate);
      assert.ok(evaluation.reasons.includes(reason), `${label}: expected ${reason}, got ${evaluation.reasons.join(',')}`);
      assert.equal(evaluation.decision, 'stop', `${label}: decision`);
    }
  });

  it('enforces every usefulness protocol and identity guard', () => {
    const cases: [(candidate: JsonObject) => void, string][] = [
      [(c) => { asObject(c.historicalUsefulness, 'historicalUsefulness').status = 'draft'; }, 'usefulness_protocol_not_frozen'],
      [(c) => { asObject(c.historicalUsefulness, 'historicalUsefulness').minimumUsefulRatePerCustomer = 0.5; }, 'usefulness_rate_changed'],
      [(c) => { asObject(c.historicalUsefulness, 'historicalUsefulness').internalAnalystMayApprove = true; }, 'usefulness_internal_analyst_forbidden'],
      [(c) => {
        for (const judgment of usefulnessJudgments(c)) judgment.independent = false;
      }, 'usefulness_requires_independent_customer'],
      [(c) => {
        asObject(usefulnessJudgments(c)[0], 'judgment').qualificationEvidenceSha256 = null;
      }, 'usefulness_customer_qualification_evidence_invalid'],
      [(c) => {
        asObject(usefulnessImpacts(c)[0], 'impact').direction = 'sideways';
      }, 'usefulness_impact_direction_invalid'],
    ];
    for (const [mutate, reason] of cases) {
      const candidate = makePassingSyntheticCandidate();
      assert.equal(evaluateHistoricalUsefulness(candidate).pass, true, 'control');
      mutate(candidate);
      assert.ok(
        evaluateHistoricalUsefulness(candidate).reasons.includes(reason),
        `expected ${reason}`,
      );
      assert.equal(evaluateStage0(candidate).decision, 'stop');
    }
  });

  it('derives the per-customer useful bar from the frozen rate rather than a literal', () => {
    // Discriminating case: with the rate amended to 0.5 the bar becomes ceil(0.5 * 10) = 5, so a
    // customer at 5/10 must NOT trip the below-bar reason. A hardcoded `usefulCount < 7` would
    // still fire here, which is exactly the silent staleness this derivation removes. The protocol
    // pin still reports the amendment separately via usefulness_rate_changed.
    const candidate = makePassingSyntheticCandidate();
    const usefulness = asObject(candidate.historicalUsefulness, 'historicalUsefulness');
    usefulness.minimumUsefulRatePerCustomer = 0.5;
    for (const judgment of usefulnessJudgments(candidate)) {
      const labels = judgment.labels as JsonObject[];
      for (const [index, label] of labels.entries()) label.useful = index < 5;
    }
    const reasons = evaluateHistoricalUsefulness(candidate).reasons;
    assert.equal(reasons.includes('usefulness_customer_below_seven_of_ten'), false);
    assert.ok(reasons.includes('usefulness_rate_changed'));

    // And one below the derived bar still fails.
    for (const judgment of usefulnessJudgments(candidate)) {
      const labels = judgment.labels as JsonObject[];
      for (const [index, label] of labels.entries()) label.useful = index < 4;
    }
    assert.ok(
      evaluateHistoricalUsefulness(candidate).reasons.includes('usefulness_customer_below_seven_of_ten'),
    );
  });

  it('enforces the calibration ceilings, not only the rate floors', () => {
    const admission = asObject(protocol.admissionQuality, 'admissionQuality');
    const stage3 = asObject(
      (admission.metrics as JsonObject[]).find((metric) => metric.id === 'confidence_calibration_stage3'),
      'confidence_calibration_stage3',
    );
    assert.equal(stage3.kind, 'calibration');
    assert.equal(
      evaluateAdmissionMetric(admission, stage3, { denominator: 200, pointEstimate: 0.09, upperBound: 0.14 }).pass,
      true,
    );
    assert.ok(
      evaluateAdmissionMetric(admission, stage3, { denominator: 200, pointEstimate: 0.11, upperBound: 0.14 })
        .reasons.includes('point_above_ceiling'),
    );
    assert.ok(
      evaluateAdmissionMetric(admission, stage3, { denominator: 200, pointEstimate: 0.09, upperBound: 0.16 })
        .reasons.includes('upper_bound_above_ceiling'),
    );
    assert.ok(
      evaluateAdmissionMetric(admission, stage3, { denominator: 199, pointEstimate: 0.09, upperBound: 0.14 })
        .reasons.includes('denominator_insufficient'),
    );
    // A missing measurement must fail closed rather than read as zero error.
    assert.ok(
      evaluateAdmissionMetric(admission, stage3, { denominator: 200 }).reasons.includes('point_above_ceiling'),
    );

    const precision = asObject(
      (admission.metrics as JsonObject[]).find((metric) => metric.id === 'published_material_impact_precision'),
      'published_material_impact_precision',
    );
    assert.ok(
      evaluateAdmissionMetric(admission, precision, { denominator: 100, numerator: 101 })
        .reasons.includes('numerator_invalid'),
    );
  });

  it('pins the bootstrap percentile order statistic', () => {
    const distinct = Array.from({ length: 10_000 }, (_, index) => index);
    assert.equal(percentileOrderStatistic(distinct, 0.9, 10_000), 8_999);
    assert.equal(percentileOrderStatistic(distinct, 0.5, 10_000), 4_999);
    assert.equal(percentileOrderStatistic([0, 1, 2, 3], 0.5, 4), 1);
  });

  it('rejects an over-budget cost package', () => {
    const candidate = structuredClone(protocol);
    const economics = asObject(candidate.economics, 'economics');
    asObject(economics.assumptions, 'assumptions').allocatedInfrastructureUsd = 500;
    const recomputed = modeledMonthlyCost(candidate);
    economics.modeledMonthlyCostUsd = recomputed;
    economics.modeledMonthlyCostPerCompanyUsd = recomputed
      / asNumber(economics.portfolioSize, 'portfolioSize');
    const reasons = evaluateStage0(candidate).reasons;
    assert.ok(reasons.includes('economics_above_ceiling'));
    assert.equal(reasons.includes('economics_arithmetic_mismatch'), false);
  });

  it('rejects a forbidden field in every pinned result container', () => {
    const cases: [(candidate: JsonObject) => void, string][] = [
      [(c) => { asObject(asObject(c.rediscovery, 'rediscovery').result, 'result').note = 'x'; }, 'rediscovery_result_field_forbidden'],
      [(c) => { asObject(asObject(c.historicalUsefulness, 'historicalUsefulness').result, 'result').note = 'x'; }, 'usefulness_result_field_forbidden'],
      [(c) => { asObject(usefulnessImpacts(c)[0], 'impact').note = 'x'; }, 'usefulness_impact_field_forbidden'],
      [(c) => { asObject(usefulnessJudgments(c)[0], 'judgment').note = 'x'; }, 'usefulness_customer_field_forbidden'],
      [(c) => {
        (asObject(usefulnessJudgments(c)[0], 'judgment').labels as JsonObject[])[0].note = 'x';
      }, 'usefulness_label_field_forbidden'],
      [(c) => { providerResultOf(c).note = 'x'; }, 'provider_result_field_forbidden'],
      [(c) => { asObject(providerResultOf(c).exa, 'exa').note = 'x'; }, 'exa_result_field_forbidden'],
      [(c) => { asObject(providerResultOf(c).x, 'x').note = 'x'; }, 'x_result_field_forbidden'],
      [(c) => { asObject(providerResultOf(c).model, 'model').note = 'x'; }, 'model_result_field_forbidden'],
    ];
    for (const [mutate, reason] of cases) {
      const candidate = makePassingSyntheticCandidate();
      mutate(candidate);
      assert.ok(
        evaluateEmpiricalResultSchemas(candidate).reasons.includes(reason),
        `expected ${reason}`,
      );
    }
  });

  it('rejects a weakened provider policy declaration, not only a weakened result', () => {
    const cases: [(candidate: JsonObject) => void, string][] = [
      [(c) => { providersOf(c).exa.evaluationStatus = 'pending'; }, 'exa_evaluation_policy_invalid'],
      [(c) => { providersOf(c).exa.paidRuntimeApprovalRequired = false; }, 'exa_evaluation_policy_invalid'],
      [(c) => { providersOf(c).x.commercialApprovalRequired = false; }, 'x_runtime_policy_invalid'],
      [(c) => { providersOf(c).x.modelTrainingOnXContent = 'permitted'; }, 'x_runtime_policy_invalid'],
      [(c) => { providersOf(c).model.zeroDataRetentionRequired = false; }, 'model_zdr_not_enforced'],
      [(c) => { providersOf(c).model.trainingOnPromptsAllowed = true; }, 'model_no_training_not_enforced'],
      [(c) => { providersOf(c).model.reasoningEnabled = true; }, 'model_no_reasoning_not_enforced'],
      [(c) => { providersOf(c).model.modelAndProviderVersionMustBePinned = false; }, 'model_route_not_pinned'],
    ];
    for (const [mutate, reason] of cases) {
      const candidate = makePassingSyntheticCandidate();
      assert.equal(evaluateProviderPolicy(candidate).pass, true, 'control');
      mutate(candidate);
      assert.ok(evaluateProviderPolicy(candidate).reasons.includes(reason), `expected ${reason}`);
      assert.equal(evaluateStage0(candidate).decision, 'stop');
    }
  });

  it('anchors the scoring chronology on the digest-covered frozenAt', () => {
    const invalidFrozen = makePassingSyntheticCandidate();
    invalidFrozen.frozenAt = 'not-a-timestamp';
    assert.ok(evaluateChronology(invalidFrozen).reasons.includes('protocol_frozen_timestamp_invalid'));

    const frozenAfterApproval = makePassingSyntheticCandidate();
    frozenAfterApproval.frozenAt = '2026-09-01T00:00:00.000Z';
    assert.ok(
      evaluateChronology(frozenAfterApproval).reasons.includes('protocol_not_frozen_before_approval'),
    );

    const scoredBeforeFreeze = makePassingSyntheticCandidate();
    scoredBeforeFreeze.firstScoredRunStartedAt = '2026-08-04T00:00:00.000Z';
    assert.ok(
      evaluateChronology(scoredBeforeFreeze).reasons.includes('protocol_not_frozen_before_first_score'),
    );

    assert.equal(evaluateChronology(makePassingSyntheticCandidate()).pass, true);
  });

  it('parses RFC3339 boundaries the chronology gate depends on', () => {
    for (const valid of [
      '2026-08-05T00:00:00Z',
      '2026-08-05T00:00:00.000Z',
      '2024-02-29T12:00:00Z',
      '2026-08-05T00:00:00+05:30',
      '2026-08-05T23:59:59-05:30',
    ]) {
      assert.notEqual(parseRfc3339Timestamp(valid), null, `expected valid: ${valid}`);
    }
    for (const invalid of [
      '2023-02-29T00:00:00Z',
      '2026-13-01T00:00:00Z',
      '2026-08-05T24:00:00Z',
      '2026-08-32T00:00:00Z',
      '2026-08-05',
      'not-a-timestamp',
      42,
      null,
    ]) {
      assert.equal(parseRfc3339Timestamp(invalid), null, `expected invalid: ${String(invalid)}`);
    }
  });
});
