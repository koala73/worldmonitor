import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  DIGEST_COVERED_TOP_LEVEL_KEYS,
  ROOT_KEYS,
  adaptiveExpectedCalibrationError,
  asNumber,
  asObject,
  evaluateAdmissionMetric,
  evaluateAdmissionQuality,
  evaluateBaseRate,
  evaluateChronology,
  evaluateEmpiricalResultSchemas,
  evaluateHistoricalUsefulness,
  evaluateProviderPolicy,
  evaluateRediscovery,
  evaluateStage0 as evaluateStage0Engine,
  exactBinomialLowerBound,
  exactPoissonRateLowerBound,
  frozenThresholds,
  isEvidenceDigest,
  modeledMonthlyCost,
  parseRfc3339Timestamp,
  percentileOrderStatistic,
  stratifiedBootstrapUpperBound,
  syntheticDigest,
  thresholdDigest,
  validateProtocolFixture,
  withoutKey,
  type CalibrationExample,
  type JsonObject,
} from '../shared/company-monitoring-evaluation.ts';

const fixtureDirectory = new URL('./fixtures/company-monitoring-evaluation/', import.meta.url);
const protocolPath = new URL('protocol.json', fixtureDirectory);
const protocol = JSON.parse(readFileSync(protocolPath, 'utf8')) as JsonObject;

const APPROVED_THRESHOLD_DIGEST = '29ce1d431086f3b7a9a955776f0c2c009d87c809f810f32f8b10aef53f8ecfc2';

// The engine takes the approved digest as an argument so this literal can stay outside it. Every
// call site below goes through this wrapper, which supplies the one approved anchor.
function evaluateStage0(candidate: JsonObject) {
  return evaluateStage0Engine(candidate, { approvedThresholdDigest: APPROVED_THRESHOLD_DIGEST });
}
const EXPECTED_BASELINE_REASONS = [
  'base_rate_not_complete',
  'historical_usefulness_not_complete',
  'provider_policy_not_approved',
  'rediscovery_not_complete',
];
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

const BASE_RATE_BOUND_METHOD = 'exact_one_sided_poisson_garwood';
const RATE_BOUND_METHOD = 'exact_one_sided_clopper_pearson';
const CALIBRATION_METRIC = 'adaptive_expected_calibration_error';
const CALIBRATION_BINNING = 'ten_equal_frequency_bins_sorted_by_confidence_then_opaque_id';
const BOOTSTRAP_METHOD = 'stratified_percentile';
const BOOTSTRAP_STRATA = ['gold_materiality', 'gold_direction'];
const BOOTSTRAP_ITERATIONS = 10_000;
const BOOTSTRAP_SEED = 6003;
const BOOTSTRAP_ORDER_STATISTIC = 'ceil_confidence_times_iterations_minus_one';

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
      const validator = FIXTURE_VALIDATORS[fileName];
      assert.ok(validator, `no schema validator registered for ${fileName}`);
      validator(candidate);
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
    ] as [string, string][]) {
      const candidate = structuredClone(passing);
      asObject(asObject(candidate.baseRate, 'baseRate').result, 'baseRate.result')[field] = null;
      assert.ok(evaluateBaseRate(candidate).reasons.includes(reason));
    }
    for (const [field, reason] of [
      ['pointEstimate', 'rediscovery_point_missing'],
      ['lowerBound', 'rediscovery_lower_bound_missing'],
      ['privatePairManifestSha256', 'rediscovery_private_manifest_digest_invalid'],
      ['aggregateEvidenceSha256', 'rediscovery_aggregate_evidence_digest_invalid'],
    ] as [string, string][]) {
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

  it('treats admission quality as a separate gate that Stage 0 continue does not clear', () => {
    const admission = asObject(protocol.admissionQuality, 'admissionQuality');
    const definitions = admission.metrics as JsonObject[];

    // Unmeasured is a stop, not a pass: every frozen metric must be reported.
    const unmeasured = evaluateAdmissionQuality(admission, []);
    assert.equal(unmeasured.pass, false);
    assert.equal(unmeasured.reasons.length, definitions.length);
    for (const definition of definitions) {
      assert.ok(unmeasured.reasons.includes(`admission_${String(definition.id)}_not_measured`));
    }

    // A fully-measured, in-spec corpus passes.
    const passing = definitions.map((definition) => (
      definition.kind === 'rate'
        ? {
          id: String(definition.id),
          denominator: asNumber(definition.minimumDenominator, 'minimumDenominator'),
          numerator: asNumber(definition.minimumDenominator, 'minimumDenominator'),
        }
        : {
          id: String(definition.id),
          denominator: asNumber(definition.minimumDenominator, 'minimumDenominator'),
          pointEstimate: 0,
          upperBound: 0,
        }
    ));
    assert.deepEqual(evaluateAdmissionQuality(admission, passing), { pass: true, reasons: [] });

    // A single metric below its floor stops the gate, named by metric id.
    const weakened = structuredClone(passing);
    const precision = weakened.find((m) => m.id === 'published_material_impact_precision')!;
    precision.numerator = Math.floor(precision.denominator * 0.5);
    assert.ok(
      evaluateAdmissionQuality(admission, weakened).reasons
        .includes('admission_published_material_impact_precision_point_below_floor'),
    );

    // An unrecognised measurement cannot be smuggled past the frozen contract.
    assert.ok(
      evaluateAdmissionQuality(admission, [...passing, { id: 'invented_metric', denominator: 1000, numerator: 1000 }])
        .reasons.includes('admission_invented_metric_not_in_frozen_contract'),
    );

    // The boundary this gate exists to make explicit: a Stage 0 `continue` says nothing about
    // admission quality, so it must never be read as authorizing publication on its own.
    const stage0Continue = makePassingSyntheticCandidate();
    assert.equal(evaluateStage0(stage0Continue).decision, 'continue');
    assert.equal(evaluateAdmissionQuality(admission, []).pass, false);
  });

  it('pins the bootstrap percentile order statistic', () => {
    const distinct = Array.from({ length: 10_000 }, (_, index) => index);
    assert.equal(percentileOrderStatistic(distinct, 0.9, 10_000), 8_999);
    assert.equal(percentileOrderStatistic(distinct, 0.5, 10_000), 4_999);
    assert.equal(percentileOrderStatistic([0, 1, 2, 3], 0.5, 4), 1);
  });

  it('keeps calibration ordering independent of the host locale', () => {
    const originalLocaleCompare = String.prototype.localeCompare;
    let localeCompareCalls = 0;
    String.prototype.localeCompare = (() => {
      localeCompareCalls += 1;
      return 0;
    }) as typeof String.prototype.localeCompare;
    const examples: CalibrationExample[] = [
      {
        opaqueExampleId: 'cm_example_000002',
        confidence: 0.9,
        correct: true,
        goldMateriality: 'material',
        goldDirection: 'positive',
      },
      {
        opaqueExampleId: 'cm_example_000001',
        confidence: 0.9,
        correct: false,
        goldMateriality: 'material',
        goldDirection: 'negative',
      },
    ];
    const admission = asObject(protocol.admissionQuality, 'admissionQuality');
    const calibration = asObject(admission.calibration, 'admissionQuality.calibration');
    try {
      adaptiveExpectedCalibrationError(examples);
      stratifiedBootstrapUpperBound(examples, calibration);
    } finally {
      String.prototype.localeCompare = originalLocaleCompare;
    }
    assert.equal(localeCompareCalls, 0);
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
        (asObject(usefulnessJudgments(c)[0], 'judgment').labels as JsonObject[])[0]!.note = 'x';
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
