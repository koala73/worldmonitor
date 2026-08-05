import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import {
  BlindEvaluationError,
  canonicalReportJson,
  computeBlindCorpusDigest,
  computeExpansionManifestDigest,
  computeForecastDigest,
  computeGoldLabelSetDigest,
  computePredictionSetDigest,
  forecastBlindEvaluation,
  scoreBlindEvaluation,
  type BlindCorpus,
  type BlindExample,
  type BlindForecast,
  type GoldLabel,
  type GoldLabelSet,
  type Prediction,
  type PredictionSet,
  type ScoreReport,
} from '../shared/company-monitoring-blind-evaluation.ts';
import {
  syntheticDigest,
  thresholdDigest,
  type JsonObject,
} from '../shared/company-monitoring-evaluation.ts';

const protocol = JSON.parse(readFileSync(
  new URL('./fixtures/company-monitoring-evaluation/protocol.json', import.meta.url),
  'utf8',
)) as JsonObject;
const APPROVED_THRESHOLD_DIGEST = '29ce1d431086f3b7a9a955776f0c2c009d87c809f810f32f8b10aef53f8ecfc2';
const anchors = { approvedThresholdDigest: APPROVED_THRESHOLD_DIGEST };
const versions = {
  protocolVersion: 'cm_eval_v1',
  policyVersion: 'cm_policy_v1',
  modelVersion: 'deepseek_v4_flash_2026_08_05',
  queryVersion: 'cm_query_v1',
};
const directions = ['positive', 'negative', 'mixed'] as const;

function expectCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof BlindEvaluationError && error.code === code;
}

function examples(namespace: string, count: number, offset = 0): BlindExample[] {
  return Array.from({ length: count }, (_, index) => {
    const ordinal = index + offset + 1;
    return {
      opaqueExampleId: `cm_example_${ordinal.toString(16).padStart(6, '0')}`,
      occurrenceDigest: syntheticDigest(`${namespace}:occurrence:${ordinal}`),
      contentFingerprint: syntheticDigest(`${namespace}:content:${ordinal}`),
      corporateFamilyDigest: syntheticDigest(`${namespace}:family:${ordinal}`),
      sourceOriginDigest: syntheticDigest(`${namespace}:source:${ordinal}`),
    };
  });
}

function labelsFor(corpus: BlindCorpus, eligibleCount: number): GoldLabelSet {
  const labels: GoldLabel[] = corpus.examples.map((example, index) => {
    const publicationEligible = index < eligibleCount;
    return {
      opaqueExampleId: example.opaqueExampleId,
      publicationEligible,
      goldMateriality: publicationEligible ? 'material' : 'immaterial',
      goldDirection: directions[index % directions.length]!,
      canonicalCorporateFamilyDigest: example.corporateFamilyDigest,
      customerUseful: publicationEligible ? index % 5 !== 0 : null,
    };
  });
  return {
    schemaVersion: 'cm_gold_labels_v1',
    corpusVersion: corpus.corpusVersion,
    goldLabelVersion: `${corpus.corpusVersion}_gold_v1`,
    curatorAccessVersion: corpus.curatorAccessVersion,
    labels,
  };
}

function baseCorpus(
  namespace: string,
  purpose: BlindCorpus['purpose'],
  count: number,
  status: BlindCorpus['status'],
  offset = 0,
): BlindCorpus {
  return {
    schemaVersion: 'cm_blind_corpus_v1',
    corpusVersion: `cm_corpus_${namespace}_v1`,
    purpose,
    status,
    ...versions,
    curatorAccessVersion: 'cm_curator_access_v1',
    lockedAt: status === 'locked' ? '2026-08-05T01:00:00.000Z' : null,
    forecastSha256: null,
    sealedGoldLabelsSha256: null,
    continuation: null,
    precommittedExpansion: null,
    examples: examples(namespace, count, offset),
  };
}

function predictionsFor(
  corpus: BlindCorpus,
  gold: GoldLabelSet,
  options: { publishLimit?: number; mistakes?: number } = {},
): PredictionSet {
  let published = 0;
  const predictions: Prediction[] = gold.labels.map((label, index) => {
    const eligibleToPublish = label.publicationEligible
      && (options.publishLimit === undefined || published < options.publishLimit);
    if (eligibleToPublish) published += 1;
    const mistaken = index < (options.mistakes ?? 0);
    return {
      opaqueExampleId: label.opaqueExampleId,
      discovered: eligibleToPublish,
      publish: eligibleToPublish,
      predictedMateriality: mistaken
        ? (label.goldMateriality === 'material' ? 'immaterial' : 'material')
        : label.goldMateriality,
      predictedDirection: eligibleToPublish
        ? (mistaken ? directions[(index + 1) % directions.length]! : label.goldDirection)
        : null,
      attributedCorporateFamilyDigest: eligibleToPublish
        ? (mistaken ? syntheticDigest(`wrong-family:${index}`) : label.canonicalCorporateFamilyDigest)
        : null,
      confidence: mistaken ? 0.99 : 0.98,
      latencyMs: 100 + index,
      costUsd: 0.005 + index / 1_000_000,
    };
  });
  return {
    schemaVersion: 'cm_predictions_v1',
    corpusVersion: corpus.corpusVersion,
    corpusSha256: computeBlindCorpusDigest(corpus),
    ...versions,
    parentPredictionSetSha256: null,
    parentGoldLabelSetSha256: null,
    predictions,
  };
}

function setSealedGold(corpus: BlindCorpus, gold: GoldLabelSet): BlindCorpus {
  return { ...corpus, sealedGoldLabelsSha256: computeGoldLabelSetDigest(gold) };
}

function makeForecast(targetDraft: BlindCorpus, targetGold: GoldLabelSet): BlindForecast {
  let pilot = baseCorpus('pilot', 'pilot', 200, 'locked', 10_000);
  const pilotGold = labelsFor(pilot, 120);
  pilot = setSealedGold(pilot, pilotGold);
  const pilotPredictions = predictionsFor(pilot, pilotGold);
  return forecastBlindEvaluation({
    protocol,
    anchors,
    pilotCorpus: pilot,
    pilotGoldLabels: pilotGold,
    pilotPredictions,
    targetCorpus: targetDraft,
    targetGoldLabels: targetGold,
  });
}

function lockedBundle(options: {
  namespace?: string;
  count?: number;
  eligibleCount?: number;
  purpose?: 'tracer_gate' | 'stage3_gate';
  publishLimit?: number;
  mistakes?: number;
  precommittedExpansion?: BlindExample[];
} = {}): {
  corpus: BlindCorpus;
  gold: GoldLabelSet;
  predictions: PredictionSet;
  forecast: BlindForecast;
} {
  const namespace = options.namespace ?? 'gate';
  const count = options.count ?? 200;
  const eligibleCount = options.eligibleCount ?? 105;
  let draft = baseCorpus(namespace, options.purpose ?? 'stage3_gate', count, 'draft');
  if (options.precommittedExpansion) {
    draft = {
      ...draft,
      precommittedExpansion: {
        manifestSha256: computeExpansionManifestDigest(options.precommittedExpansion),
        exampleCount: options.precommittedExpansion.length,
      },
    };
  }
  let gold = labelsFor(draft, eligibleCount);
  draft = setSealedGold(draft, gold);
  const forecast = makeForecast(draft, gold);
  const corpus: BlindCorpus = {
    ...draft,
    status: 'locked',
    lockedAt: '2026-08-05T02:00:00.000Z',
    forecastSha256: computeForecastDigest(forecast),
  };
  gold = { ...gold, corpusVersion: corpus.corpusVersion };
  const predictions = predictionsFor(corpus, gold, options);
  return { corpus, gold, predictions, forecast };
}

function score(bundle: ReturnType<typeof lockedBundle>, previous?: {
  corpus: BlindCorpus;
  goldLabels: GoldLabelSet;
  predictions: PredictionSet;
  report: ScoreReport;
}): ScoreReport {
  return scoreBlindEvaluation({
    protocol,
    anchors,
    corpus: bundle.corpus,
    expectedCorpusSha256: computeBlindCorpusDigest(bundle.corpus),
    goldLabels: bundle.gold,
    predictions: bundle.predictions,
    forecast: bundle.forecast,
    previous,
  });
}

function continuationScenario(): {
  previousBundle: ReturnType<typeof lockedBundle>;
  previousReport: ScoreReport;
  childBundle: ReturnType<typeof lockedBundle>;
  previous: {
    corpus: BlindCorpus;
    goldLabels: GoldLabelSet;
    predictions: PredictionSet;
    report: ScoreReport;
  };
} {
  const expansion = examples('expansion', 60, 40_000);
  const previousBundle = lockedBundle({
    namespace: 'continuation-base',
    eligibleCount: 90,
    publishLimit: 90,
    precommittedExpansion: expansion,
  });
  const previousReport = score(previousBundle);
  const childCorpus: BlindCorpus = {
    ...previousBundle.corpus,
    corpusVersion: 'cm_corpus_continuation_v2',
    lockedAt: '2026-08-05T03:00:00.000Z',
    continuation: {
      parentCorpusVersion: previousBundle.corpus.corpusVersion,
      parentCorpusSha256: computeBlindCorpusDigest(previousBundle.corpus),
      parentReportSha256: previousReport.reportSha256,
      reason: 'denominator_shortfall',
    },
    precommittedExpansion: null,
    examples: [...previousBundle.corpus.examples, ...expansion],
  };
  let childGold = labelsFor(childCorpus, 150);
  const preservedLabels = new Map(previousBundle.gold.labels.map((label) => [label.opaqueExampleId, label]));
  childGold = {
    ...childGold,
    labels: childGold.labels.map((label) => preservedLabels.get(label.opaqueExampleId) ?? label),
  };
  childCorpus.sealedGoldLabelsSha256 = computeGoldLabelSetDigest(childGold);
  const childPredictions = predictionsFor(childCorpus, childGold);
  childPredictions.parentPredictionSetSha256 = computePredictionSetDigest(previousBundle.predictions);
  childPredictions.parentGoldLabelSetSha256 = computeGoldLabelSetDigest(previousBundle.gold);
  const preservedPredictions = new Map(
    previousBundle.predictions.predictions.map((prediction) => [prediction.opaqueExampleId, prediction]),
  );
  childPredictions.predictions = childPredictions.predictions.map(
    (prediction) => preservedPredictions.get(prediction.opaqueExampleId) ?? prediction,
  );
  childPredictions.corpusSha256 = computeBlindCorpusDigest(childCorpus);
  const childBundle = {
    corpus: childCorpus,
    gold: childGold,
    predictions: childPredictions,
    forecast: previousBundle.forecast,
  };
  return {
    previousBundle,
    previousReport,
    childBundle,
    previous: {
      corpus: previousBundle.corpus,
      goldLabels: previousBundle.gold,
      predictions: previousBundle.predictions,
      report: previousReport,
    },
  };
}

describe('Company Monitoring blind evaluation forecast', () => {
  it('uses only a locked, version-matched, four-way-disjoint pilot and returns aggregate forecasts', () => {
    let target = baseCorpus('forecast-target', 'stage3_gate', 200, 'draft');
    const targetGold = labelsFor(target, 105);
    target = setSealedGold(target, targetGold);
    const forecast = makeForecast(target, targetGold);
    assert.equal(forecast.status, 'forecast_ok');
    assert.deepEqual(forecast.candidateStrata.eligibleDirections, {
      positive: 35,
      negative: 35,
      mixed: 35,
    });
    assert.equal(forecast.denominatorForecasts.published_material_impact_precision.minimum, 100);
    assert.equal(forecast.denominatorForecasts.direction_accuracy_mixed.minimum, 25);
    assert.equal(JSON.stringify(forecast).includes('cm_example_'), false);
    assert.equal(JSON.stringify(forecast).includes('goldLabel'), false);

    let pilot = baseCorpus('overlap-pilot', 'pilot', 200, 'locked', 20_000);
    const pilotGold = labelsFor(pilot, 120);
    pilot = setSealedGold(pilot, pilotGold);
    const pilotPredictions = predictionsFor(pilot, pilotGold);
    const overlapDimensions = [
      'occurrenceDigest',
      'contentFingerprint',
      'corporateFamilyDigest',
      'sourceOriginDigest',
    ] as const;
    for (const dimension of overlapDimensions) {
      const overlapping = structuredClone(target);
      overlapping.examples[0]![dimension] = pilot.examples[0]![dimension];
      const overlappingGold = labelsFor(overlapping, 105);
      overlapping.sealedGoldLabelsSha256 = computeGoldLabelSetDigest(overlappingGold);
      assert.throws(() => forecastBlindEvaluation({
        protocol,
        anchors,
        pilotCorpus: pilot,
        pilotGoldLabels: pilotGold,
        pilotPredictions,
        targetCorpus: overlapping,
        targetGoldLabels: overlappingGold,
      }), expectCode(`pilot_gate_overlap_${dimension}`));
    }

    assert.throws(() => forecastBlindEvaluation({
      protocol,
      anchors,
      pilotCorpus: pilot,
      pilotGoldLabels: pilotGold,
      pilotPredictions: predictionsFor(target, targetGold),
      targetCorpus: target,
      targetGoldLabels: targetGold,
    }), expectCode('forecast_predictions_must_reference_pilot'));
  });

  it('keeps weak forecasts non-gating and reports denominator gaps with untouched growth', () => {
    let target = baseCorpus('weak-target', 'stage3_gate', 200, 'draft');
    const targetGold = labelsFor(target, 60);
    target = setSealedGold(target, targetGold);
    let pilot = baseCorpus('weak-pilot', 'pilot', 200, 'locked', 30_000);
    const pilotGold = labelsFor(pilot, 40);
    pilot = setSealedGold(pilot, pilotGold);
    const pilotPredictions = predictionsFor(pilot, pilotGold, { publishLimit: 20 });
    const forecast = forecastBlindEvaluation({
      protocol,
      anchors,
      pilotCorpus: pilot,
      pilotGoldLabels: pilotGold,
      pilotPredictions,
      targetCorpus: target,
      targetGoldLabels: targetGold,
    });
    assert.equal(forecast.status, 'forecast_warning');
    assert.ok(forecast.gaps.length > 0);
    assert.ok((forecast.recommendedUntouchedGrowth.totalExamples ?? 0) > 0);
    assert.equal(forecast.gating, false);
  });

  it('reports no finite growth recommendation when the pilot realized rate is zero', () => {
    let target = baseCorpus('zero-rate-target', 'stage3_gate', 200, 'draft');
    const targetGold = labelsFor(target, 105);
    target = setSealedGold(target, targetGold);
    let pilot = baseCorpus('zero-rate-pilot', 'pilot', 200, 'locked', 35_000);
    const pilotGold = labelsFor(pilot, 0);
    pilot = setSealedGold(pilot, pilotGold);
    const forecast = forecastBlindEvaluation({
      protocol,
      anchors,
      pilotCorpus: pilot,
      pilotGoldLabels: pilotGold,
      pilotPredictions: predictionsFor(pilot, pilotGold),
      targetCorpus: target,
      targetGoldLabels: targetGold,
    });
    assert.equal(forecast.status, 'forecast_warning');
    assert.equal(forecast.recommendedUntouchedGrowth.totalExamples, null);
    assert.deepEqual(forecast.recommendedUntouchedGrowth.eligibleByDirection, {
      positive: null,
      negative: null,
      mixed: null,
    });
  });
});

describe('Company Monitoring deterministic blind scorer', () => {
  it('fails before scoring when the approved protocol anchor, corpus lock, or versions drift', () => {
    const bundle = lockedBundle();
    const changedProtocol = structuredClone(protocol);
    const admission = changedProtocol.admissionQuality as JsonObject;
    const metrics = admission.metrics as JsonObject[];
    metrics[0]!.minimumDenominator = 99;
    assert.throws(() => scoreBlindEvaluation({
      protocol: changedProtocol,
      anchors,
      corpus: bundle.corpus,
      expectedCorpusSha256: computeBlindCorpusDigest(bundle.corpus),
      goldLabels: bundle.gold,
      predictions: bundle.predictions,
      forecast: bundle.forecast,
    }), expectCode('frozen_threshold_digest_mismatch'));

    const unapproved = structuredClone(protocol);
    (unapproved.approval as JsonObject).status = 'pending';
    assert.throws(() => scoreBlindEvaluation({
      protocol: unapproved,
      anchors,
      corpus: bundle.corpus,
      expectedCorpusSha256: computeBlindCorpusDigest(bundle.corpus),
      goldLabels: bundle.gold,
      predictions: bundle.predictions,
      forecast: bundle.forecast,
    }), expectCode('protocol_not_approved'));

    assert.throws(() => scoreBlindEvaluation({
      protocol,
      anchors,
      corpus: { ...bundle.corpus, status: 'draft', lockedAt: null },
      expectedCorpusSha256: computeBlindCorpusDigest(bundle.corpus),
      goldLabels: bundle.gold,
      predictions: bundle.predictions,
      forecast: bundle.forecast,
    }), expectCode('corpus_not_locked'));

    assert.throws(() => scoreBlindEvaluation({
      protocol,
      anchors,
      corpus: { ...bundle.corpus, policyVersion: 'cm_policy_v2' },
      expectedCorpusSha256: computeBlindCorpusDigest({ ...bundle.corpus, policyVersion: 'cm_policy_v2' }),
      goldLabels: bundle.gold,
      predictions: bundle.predictions,
      forecast: bundle.forecast,
    }), expectCode('prediction_policy_version_mismatch'));

    const mutatedCorpus = structuredClone(bundle.corpus);
    mutatedCorpus.examples[0]!.contentFingerprint = syntheticDigest('post-lock-mutation');
    assert.throws(() => scoreBlindEvaluation({
      protocol,
      anchors,
      corpus: mutatedCorpus,
      expectedCorpusSha256: computeBlindCorpusDigest(bundle.corpus),
      goldLabels: bundle.gold,
      predictions: bundle.predictions,
      forecast: bundle.forecast,
    }), expectCode('corpus_mutated_after_lock'));
  });

  it('binds a forecast to the exact pre-lock target candidate and sealed gold set', () => {
    const candidateA = lockedBundle({ namespace: 'forecast-candidate-a' });
    const candidateBCorpus: BlindCorpus = {
      ...candidateA.corpus,
      examples: examples('forecast-candidate-b', 200, 60_000),
    };
    const candidateBGold = labelsFor(candidateBCorpus, 105);
    candidateBCorpus.sealedGoldLabelsSha256 = computeGoldLabelSetDigest(candidateBGold);
    candidateBCorpus.forecastSha256 = computeForecastDigest(candidateA.forecast);
    const candidateBPredictions = predictionsFor(candidateBCorpus, candidateBGold);

    assert.throws(() => scoreBlindEvaluation({
      protocol,
      anchors,
      corpus: candidateBCorpus,
      expectedCorpusSha256: computeBlindCorpusDigest(candidateBCorpus),
      goldLabels: candidateBGold,
      predictions: candidateBPredictions,
      forecast: candidateA.forecast,
    }), expectCode('forecast_target_candidate_mismatch'));

    const goldMutationCorpus = structuredClone(candidateA.corpus);
    const goldMutation = structuredClone(candidateA.gold);
    goldMutation.labels[0]!.customerUseful = true;
    goldMutationCorpus.sealedGoldLabelsSha256 = computeGoldLabelSetDigest(goldMutation);
    goldMutationCorpus.forecastSha256 = computeForecastDigest(candidateA.forecast);
    const goldMutationPredictions = predictionsFor(goldMutationCorpus, goldMutation);
    assert.throws(() => scoreBlindEvaluation({
      protocol,
      anchors,
      corpus: goldMutationCorpus,
      expectedCorpusSha256: computeBlindCorpusDigest(goldMutationCorpus),
      goldLabels: goldMutation,
      predictions: goldMutationPredictions,
      forecast: candidateA.forecast,
    }), expectCode('forecast_target_gold_label_set_mismatch'));

    const goldVersionCorpus = structuredClone(candidateA.corpus);
    const goldVersion = {
      ...structuredClone(candidateA.gold),
      goldLabelVersion: 'cm_corpus_forecast-candidate-a_v1_gold_v2',
    };
    goldVersionCorpus.sealedGoldLabelsSha256 = computeGoldLabelSetDigest(goldVersion);
    goldVersionCorpus.forecastSha256 = computeForecastDigest(candidateA.forecast);
    const goldVersionPredictions = predictionsFor(goldVersionCorpus, goldVersion);
    assert.throws(() => scoreBlindEvaluation({
      protocol,
      anchors,
      corpus: goldVersionCorpus,
      expectedCorpusSha256: computeBlindCorpusDigest(goldVersionCorpus),
      goldLabels: goldVersion,
      predictions: goldVersionPredictions,
      forecast: candidateA.forecast,
    }), expectCode('forecast_target_gold_label_version_mismatch'));
  });

  it('emits a byte-stable complete report with exact bounds, matrices, latency, cost, and Stage 4 exclusion', () => {
    const bundle = lockedBundle();
    const report = score(bundle);
    assert.equal(report.outcome, 'pass');
    assert.equal(report.protocol.approvedThresholdsSha256, APPROVED_THRESHOLD_DIGEST);
    assert.equal(report.corpus.exampleCount, 200);
    assert.equal(report.versions.policyVersion, versions.policyVersion);
    assert.equal(report.metrics.published_material_impact_precision.denominator, 105);
    assert.equal(report.metrics.direction_accuracy_positive.denominator, 35);
    const positiveDirection = report.metrics.direction_accuracy_positive;
    assert.equal(positiveDirection.kind, 'rate');
    if (positiveDirection.kind === 'rate') {
      assert.equal(positiveDirection.boundMethod, 'exact_one_sided_clopper_pearson');
      assert.equal(positiveDirection.confidenceLevel, 0.9);
      assert.ok((positiveDirection.lowerBound ?? 0) > 0.75);
    }
    assert.equal(report.confusionMatrices.publication.truePositive, 105);
    assert.equal(report.discovery.denominator, 105);
    assert.ok(report.calibration.pointEstimate <= 0.1);
    assert.ok(report.latency.p95Ms >= report.latency.p50Ms);
    assert.ok(report.cost.totalUsd > 0);
    assert.equal(report.stage4.included, false);
    assert.equal(report.stage4.minimumExamples, 500);

    const reordered = {
      ...bundle,
      predictions: {
        ...bundle.predictions,
        predictions: [...bundle.predictions.predictions].reverse(),
      },
      gold: { ...bundle.gold, labels: [...bundle.gold.labels].reverse() },
    };
    assert.equal(canonicalReportJson(report), canonicalReportJson(score(reordered)));
  });

  it('returns blocking incomplete before fail whenever any frozen denominator is short', () => {
    const bundle = lockedBundle({ publishLimit: 90, mistakes: 20 });
    const report = score(bundle);
    assert.equal(report.outcome, 'incomplete');
    assert.ok(report.reasons.includes('published_material_impact_precision_denominator_insufficient'));
    assert.ok(report.reasons.some((reason) => reason.endsWith('_point_below_floor')));
  });

  it('rejects Stage 4 corpora in this v1 lane', () => {
    const bundle = lockedBundle();
    assert.throws(() => scoreBlindEvaluation({
      protocol,
      anchors,
      corpus: { ...bundle.corpus, purpose: 'stage4_gate' as BlindCorpus['purpose'] },
      expectedCorpusSha256: computeBlindCorpusDigest({
        ...bundle.corpus,
        purpose: 'stage4_gate' as BlindCorpus['purpose'],
      }),
      goldLabels: bundle.gold,
      predictions: bundle.predictions,
      forecast: bundle.forecast,
    }), expectCode('stage4_out_of_scope'));
  });
});

describe('Company Monitoring cumulative continuation', () => {
  it('retains every scored row, appends only the precommitted untouched expansion, and rescores cumulatively', () => {
    const { previousBundle, previousReport, childBundle, previous } = continuationScenario();
    assert.equal(previousReport.outcome, 'incomplete');
    assert.throws(() => score(childBundle), expectCode('continuation_parent_inputs_missing'));
    const childReport = score(childBundle, previous);
    assert.equal(childReport.corpus.exampleCount, 260);
    assert.equal(childReport.corpus.parentCorpusVersion, previousBundle.corpus.corpusVersion);

    const dropped = structuredClone(childBundle);
    dropped.corpus.examples.splice(0, 1);
    dropped.predictions.corpusSha256 = computeBlindCorpusDigest(dropped.corpus);
    assert.throws(() => score(dropped, previous), expectCode('continuation_dropped_scored_example'));

    const freshRetry = lockedBundle({ namespace: 'fresh-retry', eligibleCount: 150 });
    assert.throws(() => score(freshRetry, previous), expectCode('fresh_corpus_retry_forbidden'));
  });

  it('rejects continuation under drift in every frozen evaluation version', () => {
    const versionDrifts = [
      ['protocolVersion', 'cm_eval_v2'],
      ['policyVersion', 'cm_policy_v2'],
      ['modelVersion', 'deepseek_v4_flash_2026_08_06'],
      ['queryVersion', 'cm_query_v2'],
    ] as const;

    for (const [field, driftedVersion] of versionDrifts) {
      const { childBundle, previous } = continuationScenario();
      const drifted = structuredClone(childBundle);
      const driftedProtocol = structuredClone(protocol);
      const driftedAnchors = { ...anchors };
      drifted.corpus[field] = driftedVersion;
      drifted.predictions[field] = driftedVersion;
      if (field === 'protocolVersion') {
        drifted.forecast.protocolVersion = driftedVersion;
        driftedProtocol.protocolVersion = driftedVersion;
        const digest = thresholdDigest(driftedProtocol);
        (driftedProtocol.approval as JsonObject).approvedThresholdsSha256 = digest;
        driftedAnchors.approvedThresholdDigest = digest;
      } else {
        drifted.forecast.versions[field] = driftedVersion;
      }
      drifted.corpus.forecastSha256 = computeForecastDigest(drifted.forecast);
      drifted.predictions.corpusSha256 = computeBlindCorpusDigest(drifted.corpus);

      assert.throws(() => scoreBlindEvaluation({
        protocol: driftedProtocol,
        anchors: driftedAnchors,
        corpus: drifted.corpus,
        expectedCorpusSha256: computeBlindCorpusDigest(drifted.corpus),
        goldLabels: drifted.gold,
        predictions: drifted.predictions,
        forecast: drifted.forecast,
        previous,
      }), expectCode('continuation_version_mismatch'), field);
    }
  });

  it('rejects supplied parent score sets that do not match the retained parent report', () => {
    const predictionMutation = continuationScenario();
    const mutatedPredictions = structuredClone(predictionMutation.previous);
    mutatedPredictions.predictions.predictions[0]!.confidence = 0.42;
    assert.throws(
      () => score(predictionMutation.childBundle, mutatedPredictions),
      expectCode('previous_prediction_set_digest_mismatch'),
    );

    const goldMutation = continuationScenario();
    const mutatedGold = structuredClone(goldMutation.previous);
    mutatedGold.goldLabels.labels[0]!.customerUseful = true;
    assert.throws(
      () => score(goldMutation.childBundle, mutatedGold),
      expectCode('previous_gold_label_set_digest_mismatch'),
    );
  });
});

describe('Company Monitoring blind evaluation CLI', () => {
  it('refuses to seal an artifact under the wrong digest command', () => {
    const result = spawnSync(
      fileURLToPath(new URL('../node_modules/.bin/tsx', import.meta.url)),
      [
        fileURLToPath(new URL('../scripts/company-monitoring-blind-evaluation.mts', import.meta.url)),
        'digest-corpus',
        fileURLToPath(new URL('./fixtures/company-monitoring-evaluation/protocol.json', import.meta.url)),
      ],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /digest-corpus input schema invalid/);
  });
});
