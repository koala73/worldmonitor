// Company Monitoring Stage 0 evaluation engine.
//
// Extracted from tests/company-monitoring-evaluation.test.mts so the frozen statistics and gate
// logic have exactly one implementation. Any future dark contract or runtime must call these
// functions rather than re-deriving the rules from prose.
//
// Deliberately NOT here: the approved threshold digest, the recorded STOP reasons and the frozen
// floors. Those are the independent comparison anchors and live in the test source, so weakening a
// gate cannot be done by editing this module alone. evaluateStage0 therefore takes the approved
// digest as an explicit argument.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export type JsonObject = Record<string, unknown>;

export type CalibrationExample = {
  opaqueExampleId: string;
  confidence: number;
  correct: boolean;
  goldMateriality: string;
  goldDirection: string;
};

// Independent of protocol.json by design: changing a frozen threshold requires a deliberate edit here.
// The approval digest is recomputable from the very file it constrains, so on its own it catches
// accidental drift but is not an anchor against a deliberate coordinated edit (fixture threshold +
// digest literal + approval field). These floors are therefore pinned here as independent literals,
// exactly as EXPECTED_BASELINE_REASONS pins the STOP record: weakening a gate must show up as a
// visible test-file edit, not as a fixture edit hidden behind a recomputed hash.
// Every top-level key must be declared as either digest-covered or deliberately digest-exempt.
// frozenThresholds() is a hand-written projection, so without this a NEW top-level section would
// silently escape the approved digest.
export const DIGEST_COVERED_TOP_LEVEL_KEYS = [
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
export const DIGEST_EXEMPT_TOP_LEVEL_KEYS = [
  'approval',
  'firstScoredRunStartedAt',
  'syntheticVerification',
  'stage0',
];

export const ROOT_KEYS = new Set([...DIGEST_COVERED_TOP_LEVEL_KEYS, ...DIGEST_EXEMPT_TOP_LEVEL_KEYS]);
export const APPROVAL_KEYS = new Set([
  'status',
  'approverName',
  'approverRole',
  'approvedAt',
  'approvalEvidence',
  'approvedThresholdsSha256',
]);
export const STAGE0_KEYS = new Set([
  'evaluatedAt',
  'decision',
  'reasons',
  'permittedImplementation',
  'forbiddenUntilContinue',
]);

export const SHA256 = /^[a-f0-9]{64}$/;
// A digest is unverifiable from a unit test, but the degenerate self-certification shapes the
// suite itself used to model a pass (a single hex character repeated 64 times) must not satisfy
// an evidence gate.
export const DEGENERATE_DIGEST = /^([a-f0-9])\1{63}$/;

export function isEvidenceDigest(value: unknown): boolean {
  const text = String(value ?? '');
  return SHA256.test(text) && !DEGENERATE_DIGEST.test(text);
}

// Distinct, non-degenerate stand-ins for the synthetic transition fixtures. Deliberately not a
// repeated single character: the suite must not model a pass using a shape a real gate rejects.
export function syntheticDigest(label: string): string {
  return createHash('sha256').update(`synthetic-evidence:${label}`).digest('hex');
}

export const RESULT_STATUS_VALUES = new Set(['not_run', 'incomplete', 'complete']);
export const RUNTIME_STATUS_VALUES = new Set(['blocked', 'approved']);

// Every legitimate string in this fixture is a snake_case enum token, a 64-hex digest, an opaque
// cm_* identifier, an RFC3339 timestamp, or one of a tiny set of codes. Free text is therefore made
// unrepresentable rather than denied by name, so an unlisted key cannot smuggle a value through.
export const ALLOWED_FIXTURE_VALUE =
  /^(?:[a-z0-9]+(?:_[a-z0-9]+)*|[a-f0-9]{64}|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})|US|GB|USD)$/;
// The only two free-text values the contract legitimately carries; both are pinned to exact
// literals by evaluateStage0's named-approver check, so they cannot be used to smuggle content.
export const LITERAL_PINNED_KEYS = new Set(['approverName', 'approverRole']);

export const OPAQUE_IMPACT_SET_ID = /^cm_impact_set_[a-f0-9]{12}$/;
export const OPAQUE_IMPACT_ID = /^cm_impact_[a-f0-9]{12}$/;
export const OPAQUE_CUSTOMER_ID = /^cm_customer_[a-f0-9]{12}$/;
export const OPAQUE_EXAMPLE_ID = /^cm_example_[a-f0-9]{6}$/;
export const RFC3339_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
export const BASE_RATE_RESULT_KEYS = new Set([
  'status',
  'companyYears',
  'materialEventCount',
  'pointEstimate',
  'lowerBound',
  'privateSelectionManifestSha256',
  'aggregateEvidenceSha256',
]);
export const REDISCOVERY_RESULT_KEYS = new Set([
  'status',
  'pairCount',
  'rediscoveredCount',
  'pointEstimate',
  'lowerBound',
  'privatePairManifestSha256',
  'aggregateEvidenceSha256',
]);
export const USEFULNESS_RESULT_KEYS = new Set([
  'status',
  'impactSetId',
  'impacts',
  'customerJudgments',
  'aggregateEvidenceSha256',
]);
export const USEFULNESS_IMPACT_KEYS = new Set(['impactId', 'direction']);
export const USEFULNESS_CUSTOMER_KEYS = new Set([
  'customerId',
  'externalTargetCustomer',
  'qualificationEvidenceSha256',
  'independent',
  'labels',
]);
export const USEFULNESS_LABEL_KEYS = new Set(['impactId', 'useful']);
export const PROVIDER_RESULT_KEYS = new Set(['status', 'exa', 'x', 'model']);
export const EXA_RESULT_KEYS = new Set(['status', 'paidRuntimeApprovalEvidenceSha256']);
export const X_RESULT_KEYS = new Set([
  'status',
  'writtenCommercialUseApprovalEvidenceSha256',
  'offlineContentComplianceEnforcedByRuntime',
  'modelTrainingProhibitionEnforcedByRuntime',
]);
export const MODEL_RESULT_KEYS = new Set([
  'status',
  'zeroDataRetentionEnforcedByRuntime',
  'noTrainingEnforcedByRuntime',
  'reasoningDisabledEnforcedByRuntime',
  'modelAndProviderPinnedByRuntime',
]);
export const SYNTHETIC_VERIFICATION_KEYS = new Set([
  'classification',
  'eligibleForViabilityDecision',
  'poisson',
  'binomial',
  'calibration',
]);
export const SYNTHETIC_POISSON_KEYS = new Set([
  'companyYears',
  'materialEventCount',
  'confidenceLevel',
  'expectedPointEstimate',
  'expectedLowerBound',
]);
export const SYNTHETIC_BINOMIAL_KEYS = new Set([
  'pairCount',
  'rediscoveredCount',
  'confidenceLevel',
  'expectedPointEstimate',
  'expectedLowerBound',
]);
export const SYNTHETIC_CALIBRATION_KEYS = new Set([
  'examples',
  'expectedPointEstimate',
  'expectedUpperBound',
]);
export const SYNTHETIC_CALIBRATION_EXAMPLE_KEYS = new Set([
  'opaqueExampleId',
  'confidence',
  'correct',
  'goldMateriality',
  'goldDirection',
]);
export const GOLD_MATERIALITY_VALUES = new Set(['material', 'immaterial']);
export const GOLD_DIRECTION_VALUES = new Set(['positive', 'negative', 'mixed']);
// Defence in depth only. The load-bearing control is the ALLOWED_FIXTURE_VALUE allow-list plus the
// hasExactKeys pinning; this list is a second net, so it is matched on a normalized key
// (case-folded, separators stripped) to stop company_name / company-name style variants dodging it.
export const RAW_EVIDENCE_KEYS = new Set([
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

export function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function compareCodePoints(left: string, right: string): number {
  const leftCodePoints = [...left];
  const rightCodePoints = [...right];
  const sharedLength = Math.min(leftCodePoints.length, rightCodePoints.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const difference = leftCodePoints[index]!.codePointAt(0)! - rightCodePoints[index]!.codePointAt(0)!;
    if (difference !== 0) return difference;
  }
  return leftCodePoints.length - rightCodePoints.length;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, child) => {
    if (!child || typeof child !== 'object' || Array.isArray(child)) return child;
    return Object.fromEntries(
      Object.entries(child as JsonObject).sort(([left], [right]) => compareCodePoints(left, right)),
    );
  });
}

export function asObject(value: unknown, label: string): JsonObject {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  return value as JsonObject;
}

export function asNumber(value: unknown, label: string): number {
  assert.equal(typeof value, 'number', `${label} must be numeric`);
  assert.ok(Number.isFinite(value as number), `${label} must be finite`);
  return value as number;
}

export function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function withoutKey(candidate: JsonObject, excludedKey: string): JsonObject {
  return Object.fromEntries(Object.entries(candidate).filter(([key]) => key !== excludedKey));
}

export function binomialTailAtLeast(trials: number, successes: number, probability: number): number {
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

export function exactBinomialLowerBound(successes: number, trials: number, confidence: number): number {
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

export function poissonTailAtLeast(observed: number, mean: number): number {
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

export function exactPoissonRateLowerBound(events: number, exposure: number, confidence: number): number {
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

export function adaptiveExpectedCalibrationError(examples: CalibrationExample[]): number {
  assert.ok(examples.length > 0, 'calibration examples must not be empty');
  const sorted = [...examples].sort(
    (left, right) => left.confidence - right.confidence
      || compareCodePoints(left.opaqueExampleId, right.opaqueExampleId),
  );
  const bins: CalibrationExample[][] = Array.from({ length: 10 }, () => []);
  for (const [index, example] of sorted.entries()) {
    bins[Math.min(9, Math.floor((index * 10) / sorted.length))]!.push(example);
  }
  return bins.reduce((ece, bin) => {
    if (bin.length === 0) return ece;
    const averageConfidence = bin.reduce((sum, example) => sum + example.confidence, 0) / bin.length;
    const averageAccuracy = bin.filter((example) => example.correct).length / bin.length;
    return ece + (bin.length / sorted.length) * Math.abs(averageConfidence - averageAccuracy);
  }, 0);
}

export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function stratifiedBootstrapUpperBound(examples: CalibrationExample[], calibration: JsonObject): number {
  const iterations = asNumber(calibration.bootstrapIterations, 'bootstrapIterations');
  const seed = asNumber(calibration.bootstrapSeed, 'bootstrapSeed');
  const confidence = asNumber(calibration.confidenceLevel, 'calibration.confidenceLevel');
  const random = mulberry32(seed);
  assert.ok(examples.length > 0, 'calibration examples must not be empty');
  const sorted = [...examples].sort(
    (left, right) => left.confidence - right.confidence
      || compareCodePoints(left.opaqueExampleId, right.opaqueExampleId),
  );
  const sortedRank = new Map(sorted.map((example, index) => [example, index]));
  const sampleCounts = new Uint32Array(sorted.length);
  const strata = new Map<string, CalibrationExample[]>();
  for (const example of examples) {
    const key = `${example.goldMateriality}\u0000${example.goldDirection}`;
    const stratum = strata.get(key) ?? [];
    stratum.push(example);
    strata.set(key, stratum);
  }
  const orderedStrata = [...strata.entries()].sort(
    ([left], [right]) => compareCodePoints(left, right),
  );
  const estimates: number[] = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    sampleCounts.fill(0);
    for (const [, stratum] of orderedStrata) {
      for (let index = 0; index < stratum.length; index += 1) {
        const example = stratum[Math.floor(random() * stratum.length)]!;
        const rank = sortedRank.get(example);
        assert.ok(rank !== undefined, 'bootstrap example must have a canonical rank');
        sampleCounts[rank] = sampleCounts[rank]! + 1;
      }
    }

    // Every bootstrap sample is a multiset of the same frozen examples. Sorting
    // that multiset 10,000 times produces the same order as walking this one
    // canonical sort and expanding each sampled count. Keep the original
    // per-example accumulation order so the frozen floating-point result is
    // byte-for-byte identical without the repeated allocations and O(n log n)
    // sorts that otherwise dominate the unit suite under concurrency.
    const bins = Array.from({ length: 10 }, () => ({
      count: 0,
      confidence: 0,
      correct: 0,
    }));
    let sampleIndex = 0;
    for (const [rank, example] of sorted.entries()) {
      for (let copy = 0; copy < sampleCounts[rank]!; copy += 1) {
        const bin = bins[Math.min(9, Math.floor((sampleIndex * 10) / sorted.length))]!;
        bin.count += 1;
        bin.confidence += example.confidence;
        if (example.correct) bin.correct += 1;
        sampleIndex += 1;
      }
    }
    estimates.push(bins.reduce((ece, bin) => {
      if (bin.count === 0) return ece;
      const averageConfidence = bin.confidence / bin.count;
      const averageAccuracy = bin.correct / bin.count;
      return ece + (bin.count / sorted.length) * Math.abs(averageConfidence - averageAccuracy);
    }, 0));
  }
  estimates.sort((left, right) => left - right);
  return percentileOrderStatistic(estimates, confidence, iterations);
}

// Extracted so the "-1" is directly observable. Asserting it through the bootstrap alone cannot
// kill an off-by-one mutant, because the committed vector's 8999th and 9000th estimates are equal.
export function percentileOrderStatistic(sorted: number[], confidence: number, iterations: number): number {
  const value = sorted[Math.ceil(confidence * iterations) - 1];
  // Fail closed rather than returning undefined: a silently missing order statistic would make an
  // exact-equality assertion compare against undefined instead of reporting a bad configuration.
  assert.ok(
    value !== undefined,
    `percentile order statistic out of range for ${sorted.length} estimates`,
  );
  return value;
}

export function frozenThresholds(candidate: JsonObject): JsonObject {
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

export function thresholdDigest(candidate: JsonObject): string {
  return createHash('sha256').update(canonicalJson(frozenThresholds(candidate))).digest('hex');
}

export function evaluateBaseRate(candidate: JsonObject): { pass: boolean; reasons: string[] } {
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

export function evaluateRediscovery(candidate: JsonObject): { pass: boolean; reasons: string[] } {
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

export function evaluateUsefulnessProtocol(candidate: JsonObject): { pass: boolean; reasons: string[] } {
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

export function evaluateHistoricalUsefulness(candidate: JsonObject): { pass: boolean; reasons: string[] } {
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

export function evaluateAdmissionMetric(
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
    const lower = exactBinomialLowerBound(numerator, result.denominator, confidence);
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

export type AdmissionMeasurement = {
  id: string;
  denominator: number;
  numerator?: number;
  pointEstimate?: number;
  upperBound?: number;
};

// The admission gate, and deliberately NOT part of evaluateStage0.
//
// Every admission metric is defined over published decisions or a Stage 3/Stage 4 blind corpus, so
// none of them can be measured before the product runs; folding them into Stage 0 would make the
// gate unsatisfiable rather than stricter. But evaluateAdmissionMetric previously had no caller at
// all, which left the frozen metric table inert and let a Stage 0 `continue` read as blanket
// authorization. This is that caller: a separate, later-stage gate over the same frozen contract.
//
// Fail-closed by construction: an unmeasured metric and an unrecognised measurement are both stop
// reasons, so an underfilled corpus is `incomplete`, never a pass.
export function evaluateAdmissionQuality(
  admission: JsonObject,
  measurements: AdmissionMeasurement[],
): { pass: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (admission.status !== 'frozen') reasons.push('admission_contract_not_frozen');

  const definitions = Array.isArray(admission.metrics)
    ? admission.metrics.map((value) => asObject(value, 'admissionQuality.metric'))
    : [];
  assert.ok(definitions.length > 0, 'admissionQuality.metrics must not be empty');

  const byId = new Map(measurements.map((measurement) => [measurement.id, measurement]));
  const knownIds = new Set<string>();
  for (const definition of definitions) {
    const id = String(definition.id ?? '');
    knownIds.add(id);
    const measurement = byId.get(id);
    if (!measurement) {
      reasons.push(`admission_${id}_not_measured`);
      continue;
    }
    for (const reason of evaluateAdmissionMetric(admission, definition, measurement).reasons) {
      reasons.push(`admission_${id}_${reason}`);
    }
  }
  for (const measurement of measurements) {
    if (!knownIds.has(measurement.id)) {
      reasons.push(`admission_${measurement.id}_not_in_frozen_contract`);
    }
  }
  return { pass: reasons.length === 0, reasons };
}

export function modeledMonthlyCost(candidate: JsonObject): number {
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

export function parseRfc3339Timestamp(value: unknown): number | null {
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

export function hasCompleteEmpiricalResult(candidate: JsonObject): boolean {
  return [
    asObject(asObject(candidate.baseRate, 'baseRate').result, 'baseRate.result'),
    asObject(asObject(candidate.rediscovery, 'rediscovery').result, 'rediscovery.result'),
    asObject(
      asObject(candidate.historicalUsefulness, 'historicalUsefulness').result,
      'historicalUsefulness.result',
    ),
  ].some((result) => result.status === 'complete');
}

export function evaluateChronology(candidate: JsonObject): { pass: boolean; reasons: string[] } {
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

export function evaluateProviderPolicy(candidate: JsonObject): { pass: boolean; reasons: string[] } {
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

export function hasExactKeys(candidate: JsonObject, allowed: Set<string>): boolean {
  const keys = Object.keys(candidate);
  return keys.length === allowed.size && keys.every((key) => allowed.has(key));
}

export function evaluateSyntheticVerificationSchema(candidate: JsonObject): {
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

export function evaluateEmpiricalResultSchemas(candidate: JsonObject): { pass: boolean; reasons: string[] } {
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

// The approved digest is passed in rather than defined here on purpose: it is the independent
// comparison anchor, and viability.md's change-control section promises it is compared against a
// literal held outside the frozen protocol. Keeping it out of this module means weakening a gate
// cannot be done by editing the engine alone.
export type Stage0Anchors = { approvedThresholdDigest: string };

export function evaluateStage0(
  candidate: JsonObject,
  anchors: Stage0Anchors,
): { decision: 'continue' | 'stop'; reasons: string[] } {
  const APPROVED_THRESHOLD_DIGEST = anchors.approvedThresholdDigest;
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

export function walk(value: unknown, visit: (key: string | null, child: unknown) => void, key: string | null = null): void {
  visit(key, value);
  if (Array.isArray(value)) {
    for (const child of value) walk(child, visit);
  } else if (value && typeof value === 'object') {
    for (const [childKey, child] of Object.entries(value as JsonObject)) walk(child, visit, childKey);
  }
}

export function validateProtocolFixture(candidate: JsonObject): void {
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
