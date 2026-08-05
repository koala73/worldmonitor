import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  computeScoreReportDigest,
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

// materialCount defaults to eligibleCount so existing fixtures keep their shape, but it is a
// SEPARATE axis on purpose: publicationEligible and goldMateriality are independent fields in
// the contract, and tying them together makes the whole material-vs-eligible distinction
// unobservable -- including the forecast's projection basis and the materiality matrix.
function labelsFor(
  corpus: BlindCorpus,
  eligibleCount: number,
  materialCount: number = eligibleCount,
): GoldLabelSet {
  const labels: GoldLabel[] = corpus.examples.map((example, index) => {
    const publicationEligible = index < eligibleCount;
    return {
      opaqueExampleId: example.opaqueExampleId,
      publicationEligible,
      goldMateriality: index < materialCount ? 'material' : 'immaterial',
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

function makeForecast(
  targetDraft: BlindCorpus,
  targetGold: GoldLabelSet,
  targetExpansion?: BlindExample[],
): BlindForecast {
  let pilot = baseCorpus('pilot', 'pilot', 200, 'locked', 10_000);
  const pilotGold = labelsFor(pilot, 120);
  pilot = setSealedGold(pilot, pilotGold);
  const pilotPredictions = predictionsFor(pilot, pilotGold);
  return forecastBlindEvaluation({
    protocol,
    anchors,
    pilotCorpus: pilot,
    expectedPilotCorpusSha256: computeBlindCorpusDigest(pilot),
    pilotGoldLabels: pilotGold,
    pilotPredictions,
    targetCorpus: targetDraft,
    targetGoldLabels: targetGold,
    targetExpansion,
  });
}

function lockedBundle(options: {
  namespace?: string;
  count?: number;
  eligibleCount?: number;
  materialCount?: number;
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
  const gold = labelsFor(draft, eligibleCount, options.materialCount ?? eligibleCount);
  draft = setSealedGold(draft, gold);
  const forecast = makeForecast(draft, gold, options.precommittedExpansion);
  const corpus: BlindCorpus = {
    ...draft,
    status: 'locked',
    lockedAt: '2026-08-05T02:00:00.000Z',
    forecastSha256: computeForecastDigest(forecast),
  };
  const predictions = predictionsFor(corpus, gold, options);
  return { corpus, gold, predictions, forecast };
}

function score(bundle: ReturnType<typeof lockedBundle>, previous?: {
  corpus: BlindCorpus;
  expectedCorpusSha256: string;
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

function continuationScenario(options: {
  namespace?: string;
  eligibleCount?: number;
  publishLimit?: number;
} = {}): {
  previousBundle: ReturnType<typeof lockedBundle>;
  previousReport: ScoreReport;
  childBundle: ReturnType<typeof lockedBundle>;
  previous: {
    corpus: BlindCorpus;
    expectedCorpusSha256: string;
    goldLabels: GoldLabelSet;
    predictions: PredictionSet;
    report: ScoreReport;
  };
} {
  const expansion = examples('expansion', 60, 40_000);
  const previousBundle = lockedBundle({
    namespace: options.namespace ?? 'continuation-base',
    eligibleCount: options.eligibleCount ?? 90,
    publishLimit: options.publishLimit ?? 90,
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
      expectedCorpusSha256: computeBlindCorpusDigest(previousBundle.corpus),
      goldLabels: previousBundle.gold,
      predictions: previousBundle.predictions,
      report: previousReport,
    },
  };
}

function rebindContinuationParent(
  scenario: ReturnType<typeof continuationScenario>,
  mutate: (corpus: BlindCorpus) => void,
): { childBundle: ReturnType<typeof lockedBundle>; previous: typeof scenario.previous } {
  const childBundle = structuredClone(scenario.childBundle);
  const previous = structuredClone(scenario.previous);
  mutate(previous.corpus);
  previous.expectedCorpusSha256 = computeBlindCorpusDigest(previous.corpus);
  previous.predictions.corpusSha256 = previous.expectedCorpusSha256;
  previous.report.corpus.sha256 = previous.expectedCorpusSha256;
  previous.report.predictionSetSha256 = computePredictionSetDigest(previous.predictions);
  previous.report.reportSha256 = computeScoreReportDigest(previous.report);
  childBundle.corpus.continuation!.parentCorpusSha256 = previous.expectedCorpusSha256;
  childBundle.corpus.continuation!.parentReportSha256 = previous.report.reportSha256;
  childBundle.predictions.parentPredictionSetSha256 = previous.report.predictionSetSha256;
  childBundle.predictions.corpusSha256 = computeBlindCorpusDigest(childBundle.corpus);
  return { childBundle, previous };
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
    // Assert on the real GoldLabel field names. The forecast's own keys are pilotGoldLabel-
    // Version / targetGoldLabelVersion / targetGoldLabelSetSha256 (capital G), so a needle of
    // 'goldLabel' matches nothing the type can ever contain and cannot fail -- and a genuinely
    // leaked label would surface as these fields, not that token.
    // Note `publicationEligible` is deliberately NOT in this list: candidateStrata reports it
    // as an aggregate count, which is exactly what the forecast is allowed to carry. These are
    // the per-row GoldLabel fields that must never appear.
    const serializedForecast = JSON.stringify(forecast);
    for (const leakedField of [
      'goldMateriality',
      'goldDirection',
      'canonicalCorporateFamilyDigest',
      'customerUseful',
      'opaqueExampleId',
    ]) {
      assert.equal(serializedForecast.includes(leakedField), false, leakedField);
    }

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
        expectedPilotCorpusSha256: computeBlindCorpusDigest(pilot),
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
      expectedPilotCorpusSha256: computeBlindCorpusDigest(pilot),
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
      expectedPilotCorpusSha256: computeBlindCorpusDigest(pilot),
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

  it('projects direction denominators from eligible-AND-material rows, not eligibility alone', () => {
    // publicationEligible and goldMateriality are independent fields. directionRates is a rate
    // over eligible-AND-material pilot rows, and the scorer only counts eligible-and-material
    // rows into direction_accuracy_* denominators -- so projecting with a plain eligibility
    // count over-states the forecast by 1/P(material|eligible) and can report forecast_ok for
    // a corpus that will actually come up short.
    let draft = baseCorpus('basis', 'stage3_gate', 200, 'draft', 70_000);
    // 150 eligible, but only 60 of those are material.
    const gold = labelsFor(draft, 150, 60);
    draft = setSealedGold(draft, gold);
    const forecast = makeForecast(draft, gold);

    // candidateStrata keeps reporting ELIGIBILITY, as the docs describe.
    assert.equal(forecast.candidateStrata.publicationEligible, 150);
    const eligibleByDirection = forecast.candidateStrata.eligibleDirections;
    assert.equal(
      eligibleByDirection.positive + eligibleByDirection.negative + eligibleByDirection.mixed,
      150,
    );

    // The projection must be bounded by the 60 material-and-eligible rows, not the 150
    // eligible ones. Summed across directions it cannot exceed 60.
    const projected = (['positive', 'negative', 'mixed'] as const).reduce(
      (sum, direction) => sum + forecast.denominatorForecasts[`direction_accuracy_${direction}`].estimated,
      0,
    );
    assert.ok(projected <= 60, `projected ${projected} exceeds the 60 material-eligible rows`);
    assert.equal(forecast.denominatorForecasts.direction_accuracy_overall.estimated, projected);
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
      expectedPilotCorpusSha256: computeBlindCorpusDigest(pilot),
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

  it('holds the pilot corpus digest independently of resealed pilot artifacts', () => {
    let pilot = baseCorpus('anchored-pilot', 'pilot', 200, 'locked', 100_000);
    const pilotGold = labelsFor(pilot, 120);
    pilot = setSealedGold(pilot, pilotGold);
    const expectedPilotCorpusSha256 = computeBlindCorpusDigest(pilot);
    const mutatedPilot = structuredClone(pilot);
    mutatedPilot.examples[0]!.contentFingerprint = syntheticDigest('resealed-pilot-content');
    const mutatedPredictions = predictionsFor(mutatedPilot, pilotGold);
    let target = baseCorpus('anchored-target', 'stage3_gate', 200, 'draft', 110_000);
    const targetGold = labelsFor(target, 105);
    target = setSealedGold(target, targetGold);

    assert.throws(() => forecastBlindEvaluation({
      protocol,
      anchors,
      pilotCorpus: mutatedPilot,
      expectedPilotCorpusSha256,
      pilotGoldLabels: pilotGold,
      pilotPredictions: mutatedPredictions,
      targetCorpus: target,
      targetGoldLabels: targetGold,
    }), expectCode('pilot_corpus_mutated_after_lock'));
  });

  it('converts balanced and skewed direction gaps through candidate-specific arrival rates', () => {
    let balanced = baseCorpus('balanced-growth', 'stage3_gate', 200, 'draft', 120_000);
    const balancedGold = labelsFor(balanced, 150, 60);
    balanced = setSealedGold(balanced, balancedGold);
    assert.equal(makeForecast(balanced, balancedGold).recommendedUntouchedGrowth.totalExamples, 50);

    let skewed = baseCorpus('skewed-growth', 'stage3_gate', 200, 'draft', 130_000);
    const skewedGold = labelsFor(skewed, 100, 100);
    skewedGold.labels.forEach((label, index) => {
      if (index < 10) label.goldDirection = 'positive';
      else if (index < 80) label.goldDirection = 'negative';
      else if (index < 100) label.goldDirection = 'mixed';
    });
    skewed = setSealedGold(skewed, skewedGold);
    assert.equal(makeForecast(skewed, skewedGold).recommendedUntouchedGrowth.totalExamples, 300);
  });

  it('requires and validates precommitted expansion rows before forecasting', () => {
    let pilot = baseCorpus('expansion-pilot', 'pilot', 200, 'locked', 140_000);
    const pilotGold = labelsFor(pilot, 120);
    pilot = setSealedGold(pilot, pilotGold);
    const pilotPredictions = predictionsFor(pilot, pilotGold);
    const expansion = examples('forecast-expansion', 60, 150_000);
    let target = baseCorpus('expansion-target', 'stage3_gate', 200, 'draft', 160_000);
    target.precommittedExpansion = {
      manifestSha256: computeExpansionManifestDigest(expansion),
      exampleCount: expansion.length,
    };
    const targetGold = labelsFor(target, 105);
    target = setSealedGold(target, targetGold);
    const forecastInput = {
      protocol,
      anchors,
      pilotCorpus: pilot,
      expectedPilotCorpusSha256: computeBlindCorpusDigest(pilot),
      pilotGoldLabels: pilotGold,
      pilotPredictions,
      targetCorpus: target,
      targetGoldLabels: targetGold,
    };

    assert.throws(
      () => forecastBlindEvaluation(forecastInput),
      expectCode('forecast_expansion_rows_missing'),
    );
    assert.doesNotThrow(() => forecastBlindEvaluation({ ...forecastInput, targetExpansion: expansion }));

    for (const dimension of [
      'occurrenceDigest',
      'contentFingerprint',
      'corporateFamilyDigest',
      'sourceOriginDigest',
    ] as const) {
      const overlapping = structuredClone(expansion);
      overlapping[0]![dimension] = pilot.examples[0]![dimension];
      const overlappingTarget = structuredClone(target);
      overlappingTarget.precommittedExpansion = {
        manifestSha256: computeExpansionManifestDigest(overlapping),
        exampleCount: overlapping.length,
      };
      assert.throws(() => forecastBlindEvaluation({
        ...forecastInput,
        targetCorpus: overlappingTarget,
        targetExpansion: overlapping,
      }), expectCode(`pilot_gate_overlap_${dimension}`));
    }

    for (const dimension of ['opaqueExampleId', 'occurrenceDigest', 'contentFingerprint'] as const) {
      const duplicate = structuredClone(expansion);
      duplicate[0]![dimension] = target.examples[0]![dimension];
      const duplicateTarget = structuredClone(target);
      duplicateTarget.precommittedExpansion = {
        manifestSha256: computeExpansionManifestDigest(duplicate),
        exampleCount: duplicate.length,
      };
      assert.throws(() => forecastBlindEvaluation({
        ...forecastInput,
        targetCorpus: duplicateTarget,
        targetExpansion: duplicate,
      }), expectCode(`corpus_duplicate_${dimension}`));
    }

    const wrongCount = structuredClone(target);
    wrongCount.precommittedExpansion!.exampleCount -= 1;
    assert.throws(() => forecastBlindEvaluation({
      ...forecastInput,
      targetCorpus: wrongCount,
      targetExpansion: expansion,
    }), expectCode('forecast_expansion_count_mismatch'));

    const wrongManifest = structuredClone(target);
    wrongManifest.precommittedExpansion!.manifestSha256 = syntheticDigest('wrong-expansion-manifest');
    assert.throws(() => forecastBlindEvaluation({
      ...forecastInput,
      targetCorpus: wrongManifest,
      targetExpansion: expansion,
    }), expectCode('forecast_expansion_manifest_mismatch'));

    const noPrecommit = { ...target, precommittedExpansion: null };
    assert.throws(() => forecastBlindEvaluation({
      ...forecastInput,
      targetCorpus: noPrecommit,
      targetExpansion: expansion,
    }), expectCode('forecast_expansion_not_precommitted'));
  });

  it('allows company and source strata to repeat within one corpus', () => {
    let target = baseCorpus('repeated-strata', 'stage3_gate', 200, 'draft', 170_000);
    target.examples[1]!.corporateFamilyDigest = target.examples[0]!.corporateFamilyDigest;
    target.examples[1]!.sourceOriginDigest = target.examples[0]!.sourceOriginDigest;
    const gold = labelsFor(target, 105);
    target = setSealedGold(target, gold);
    assert.doesNotThrow(() => makeForecast(target, gold));
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

  it('binds predictions to every frozen evaluation version', () => {
    const cases: Array<{
      field: 'protocolVersion' | 'modelVersion' | 'queryVersion';
      value: string;
      code: string;
    }> = [
      { field: 'protocolVersion', value: 'cm_eval_v2', code: 'prediction_protocol_version_mismatch' },
      { field: 'modelVersion', value: 'deepseek_v4_flash_2026_08_06', code: 'prediction_model_version_mismatch' },
      { field: 'queryVersion', value: 'cm_query_v2', code: 'prediction_query_version_mismatch' },
    ];
    for (const [index, { field, value, code }] of cases.entries()) {
      const bundle = lockedBundle({ namespace: `prediction-version-${index}` });
      bundle.predictions[field] = value;
      assert.throws(() => score(bundle), expectCode(code), field);
    }
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
    // Pin the arithmetic, not an inequality. `p95 >= p50` holds for ANY sorted array, so it
    // cannot distinguish a correct percentile from one that always returns sorted[0].
    // latencyMs is 100 + index over 200 examples => 100..299.
    assert.equal(report.latency.count, 200);
    assert.equal(report.latency.minMs, 100);
    assert.equal(report.latency.maxMs, 299);
    assert.equal(report.latency.p50Ms, 199);
    assert.equal(report.latency.p95Ms, 289);
    // costUsd is 0.005 + index/1e6 over 200 examples => 200*0.005 + (0+..+199)/1e6.
    const expectedCost = 200 * 0.005 + (199 * 200 / 2) / 1_000_000;
    assert.ok(Math.abs(report.cost.totalUsd - expectedCost) < 1e-9, String(report.cost.totalUsd));
    assert.ok(
      Math.abs(report.cost.averagePerExampleUsd - expectedCost / 200) < 1e-9,
      String(report.cost.averagePerExampleUsd),
    );
    // Matrices, which this test's own name promises but never checked.
    assert.equal(report.confusionMatrices.publication.falsePositive, 0);
    assert.equal(report.confusionMatrices.publication.falseNegative, 0);
    assert.equal(report.confusionMatrices.publication.trueNegative, 95);
    assert.equal(report.confusionMatrices.materiality.material.material, 105);
    assert.equal(report.confusionMatrices.materiality.material.immaterial, 0);
    assert.equal(report.confusionMatrices.materiality.immaterial.immaterial, 95);
    assert.equal(report.confusionMatrices.attribution.correct, 105);
    assert.equal(report.confusionMatrices.attribution.incorrect, 0);
    assert.equal(report.discovery.numerator, 105);
    assert.equal(report.discovery.rate, 1);
    // customerUseful is `index % 5 !== 0` across the 105 eligible rows => 21 falses.
    assert.equal(report.customerUsefulness.denominator, 105);
    assert.equal(report.customerUsefulness.numerator, 84);
    assert.equal(report.customerUsefulness.rate, 84 / 105);
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

  it('rejects an aggregate prediction cost that overflows a finite report', () => {
    const bundle = lockedBundle({ namespace: 'cost-overflow' });
    for (const prediction of bundle.predictions.predictions) {
      prediction.costUsd = Number.MAX_VALUE;
    }
    assert.throws(() => score(bundle), expectCode('prediction_cost_total_overflow'));
  });

  it('returns contract codes for malformed public digest inputs', () => {
    const bundle = lockedBundle({ namespace: 'digest-shape' });
    const malformedGold = { ...bundle.gold, labels: null } as unknown as GoldLabelSet;
    assert.throws(
      () => computeGoldLabelSetDigest(malformedGold),
      expectCode('gold_labels_missing'),
    );

    const malformedPredictions = {
      ...bundle.predictions,
      predictions: [null],
    } as unknown as PredictionSet;
    assert.throws(
      () => computePredictionSetDigest(malformedPredictions),
      expectCode('prediction_field_forbidden'),
    );
  });

  it('does not let published ineligible false positives inflate direction denominators', () => {
    const bundle = lockedBundle({ namespace: 'direction-false-positive' });
    const ineligibleIndex = 105;
    const label = bundle.gold.labels[ineligibleIndex]!;
    label.goldMateriality = 'material';
    bundle.corpus.sealedGoldLabelsSha256 = computeGoldLabelSetDigest(bundle.gold);
    bundle.forecast.targetGoldLabelSetSha256 = computeGoldLabelSetDigest(bundle.gold);
    bundle.corpus.forecastSha256 = computeForecastDigest(bundle.forecast);

    const prediction = bundle.predictions.predictions[ineligibleIndex]!;
    prediction.discovered = true;
    prediction.publish = true;
    prediction.predictedMateriality = 'material';
    prediction.predictedDirection = label.goldDirection;
    prediction.attributedCorporateFamilyDigest = label.canonicalCorporateFamilyDigest;
    bundle.predictions.corpusSha256 = computeBlindCorpusDigest(bundle.corpus);

    const report = score(bundle);
    assert.equal(report.confusionMatrices.publication.falsePositive, 1);
    assert.equal(report.metrics.direction_accuracy_positive.denominator, 35);
  });

  it('returns blocking incomplete before fail whenever any frozen denominator is short', () => {
    const bundle = lockedBundle({ publishLimit: 90, mistakes: 20 });
    const report = score(bundle);
    assert.equal(report.outcome, 'incomplete');
    assert.ok(report.reasons.includes('published_material_impact_precision_denominator_insufficient'));
    assert.ok(report.reasons.some((reason) => reason.endsWith('_point_below_floor')));
  });

  it('returns fail when every denominator is met but a frozen floor is breached', () => {
    // The counterpart to the incomplete case above, and the arm nothing exercised: with all
    // 200 rows eligible and published, every rate denominator clears its minimum, so the only
    // surviving reasons are quality breaches. Mutating the `fail` arm to `pass` must go red.
    const bundle = lockedBundle({ eligibleCount: 200, mistakes: 60 });
    const report = score(bundle);
    assert.equal(report.outcome, 'fail');
    assert.equal(
      report.reasons.some((reason) => reason.endsWith('_denominator_insufficient')),
      false,
      report.reasons.join(','),
    );
    assert.ok(report.reasons.some((reason) => reason.endsWith('_point_below_floor')));
  });

  it('rejects duplicate identity dimensions across corpus rows', () => {
    for (const dimension of [
      'opaqueExampleId',
      'occurrenceDigest',
      'contentFingerprint',
    ] as const) {
      const bundle = lockedBundle({ namespace: `dup-${dimension.toLowerCase()}` });
      const mutated = structuredClone(bundle);
      mutated.corpus.examples[1]![dimension] = mutated.corpus.examples[0]![dimension];
      assert.throws(() => scoreBlindEvaluation({
        protocol,
        anchors,
        corpus: mutated.corpus,
        expectedCorpusSha256: computeBlindCorpusDigest(mutated.corpus),
        goldLabels: mutated.gold,
        predictions: mutated.predictions,
        forecast: mutated.forecast,
      }), expectCode(`corpus_duplicate_${dimension}`), dimension);
    }
  });

  it('rejects a gold label whose corporate family diverges from its corpus row', () => {
    const bundle = lockedBundle({ namespace: 'gold-family' });
    const mutated = structuredClone(bundle);
    mutated.gold.labels[0]!.canonicalCorporateFamilyDigest = syntheticDigest('unrelated-family');
    mutated.corpus.sealedGoldLabelsSha256 = computeGoldLabelSetDigest(mutated.gold);
    assert.throws(() => scoreBlindEvaluation({
      protocol,
      anchors,
      corpus: mutated.corpus,
      expectedCorpusSha256: computeBlindCorpusDigest(mutated.corpus),
      goldLabels: mutated.gold,
      predictions: mutated.predictions,
      forecast: mutated.forecast,
    }), expectCode('gold_corporate_family_mismatch'));
  });

  it('rejects a prediction that publishes what it never discovered', () => {
    const bundle = lockedBundle({ namespace: 'undiscovered' });
    const mutated = structuredClone(bundle);
    mutated.predictions.predictions[0]!.discovered = false;
    assert.throws(() => score(mutated), expectCode('undiscovered_prediction_published'));
  });

  it('enforces the frozen corpus size floors at their exact boundary', () => {
    // 199 is the largest stage-3 corpus that must still be rejected; 99 likewise for tracer.
    // validateCorpusShape guards both the forecast and the score path, so the rejection
    // surfaces while the bundle is still being built.
    assert.throws(
      () => lockedBundle({ namespace: 'short-stage3', count: 199, eligibleCount: 105 }),
      expectCode('stage3_corpus_below_200'),
    );
    assert.throws(
      () => lockedBundle({
        namespace: 'short-tracer',
        purpose: 'tracer_gate',
        count: 99,
        eligibleCount: 50,
      }),
      expectCode('tracer_corpus_below_100'),
    );
    // One row more and the floor is satisfied, so the rejection is the size and nothing else.
    assert.equal(lockedBundle({ namespace: 'exact-stage3', count: 200 }).corpus.examples.length, 200);
  });

  it('rejects a frozen contract carrying a metric this engine does not score', () => {
    const extended = structuredClone(protocol);
    const admission = extended.admissionQuality as JsonObject;
    (admission.metrics as JsonObject[]).push({
      id: 'published_sentiment_precision',
      kind: 'rate',
      minimumDenominator: 100,
      minimumPointEstimate: 0.9,
      minimumLowerBound: 0.8,
    });
    const digest = thresholdDigest(extended);
    (extended.approval as JsonObject).approvedThresholdsSha256 = digest;
    const bundle = lockedBundle({ namespace: 'extra-metric' });
    assert.throws(() => scoreBlindEvaluation({
      protocol: extended,
      anchors: { approvedThresholdDigest: digest },
      corpus: bundle.corpus,
      expectedCorpusSha256: computeBlindCorpusDigest(bundle.corpus),
      goldLabels: bundle.gold,
      predictions: bundle.predictions,
      forecast: bundle.forecast,
    }), expectCode('admission_metric_not_scored'));

    // A duplicate id used to last-win silently, quietly choosing one of two conflicting
    // threshold sets for the same metric.
    const duplicated = structuredClone(protocol);
    const duplicatedAdmission = duplicated.admissionQuality as JsonObject;
    const metrics = duplicatedAdmission.metrics as JsonObject[];
    metrics.push({ ...metrics[0]!, minimumPointEstimate: 0.1 });
    const duplicateDigest = thresholdDigest(duplicated);
    (duplicated.approval as JsonObject).approvedThresholdsSha256 = duplicateDigest;
    assert.throws(() => scoreBlindEvaluation({
      protocol: duplicated,
      anchors: { approvedThresholdDigest: duplicateDigest },
      corpus: bundle.corpus,
      expectedCorpusSha256: computeBlindCorpusDigest(bundle.corpus),
      goldLabels: bundle.gold,
      predictions: bundle.predictions,
      forecast: bundle.forecast,
    }), expectCode('admission_metric_duplicate_id'));
  });

  it('rejects a frozen contract that omits a required admission metric', () => {
    const missing = structuredClone(protocol);
    const admission = missing.admissionQuality as JsonObject;
    const metrics = admission.metrics as JsonObject[];
    const missingId = 'published_material_impact_precision';
    admission.metrics = metrics.filter((metric) => metric.id !== missingId);
    const digest = thresholdDigest(missing);
    (missing.approval as JsonObject).approvedThresholdsSha256 = digest;
    const bundle = lockedBundle({ namespace: 'missing-metric' });
    assert.throws(() => scoreBlindEvaluation({
      protocol: missing,
      anchors: { approvedThresholdDigest: digest },
      corpus: bundle.corpus,
      expectedCorpusSha256: computeBlindCorpusDigest(bundle.corpus),
      goldLabels: bundle.gold,
      predictions: bundle.predictions,
      forecast: bundle.forecast,
    }), expectCode(`admission_metric_missing_${missingId}`));
  });

  it('rejects a forecast carrying an unknown field or a violated literal', () => {
    const bundle = lockedBundle({ namespace: 'forecast-shape' });
    // Rebinding forecastSha256 changes the corpus digest, so the prediction set's recorded
    // corpusSha256 has to follow or the rejection lands on that guard instead of this one.
    const reseal = (mutant: ReturnType<typeof lockedBundle>): ReturnType<typeof lockedBundle> => {
      mutant.corpus.forecastSha256 = computeForecastDigest(mutant.forecast);
      mutant.predictions.corpusSha256 = computeBlindCorpusDigest(mutant.corpus);
      return mutant;
    };

    const extraField = structuredClone(bundle);
    (extraField.forecast as unknown as JsonObject).curatorNote = 'looks fine to me';
    assert.throws(() => score(reseal(extraField)), expectCode('forecast_field_forbidden'));

    const badStatus = structuredClone(bundle);
    (badStatus.forecast as unknown as JsonObject).status = 'forecast_excellent';
    assert.throws(() => score(reseal(badStatus)), expectCode('forecast_status_invalid'));

    const badStage4 = structuredClone(bundle);
    (badStage4.forecast as unknown as JsonObject).stage4Excluded = false;
    assert.throws(() => score(reseal(badStage4)), expectCode('forecast_stage4_exclusion_invalid'));

    const nestedEvidence = structuredClone(bundle);
    (nestedEvidence.forecast.candidateStrata as unknown as JsonObject).rawContent = 'private evidence';
    assert.throws(
      () => score(reseal(nestedEvidence)),
      expectCode('forecast_candidate_strata_field_forbidden'),
    );

    const malformedRate = structuredClone(bundle);
    malformedRate.forecast.pilotRealizedRates.publishedDecisionRate = 2;
    assert.throws(
      () => score(reseal(malformedRate)),
      expectCode('forecast_pilot_rate_invalid'),
    );

    const inconsistentGap = structuredClone(bundle);
    inconsistentGap.forecast.denominatorForecasts.direction_accuracy_positive.gap = 1;
    assert.throws(
      () => score(reseal(inconsistentGap)),
      expectCode('forecast_denominator_gap_invalid'),
    );

    const inconsistentStatus = structuredClone(bundle);
    inconsistentStatus.forecast.status = 'forecast_warning';
    assert.throws(
      () => score(reseal(inconsistentStatus)),
      expectCode('forecast_status_inconsistent'),
    );
  });

  it('binds a forecast to every frozen corpus version', () => {
    const cases: Array<{
      mutate: (forecast: BlindForecast) => void;
      code: string;
    }> = [
      {
        mutate: (forecast) => { forecast.protocolVersion = 'cm_eval_v2'; },
        code: 'forecast_protocol_version_mismatch',
      },
      {
        mutate: (forecast) => { forecast.versions.policyVersion = 'cm_policy_v2'; },
        code: 'forecast_policy_version_mismatch',
      },
      {
        mutate: (forecast) => { forecast.versions.modelVersion = 'deepseek_v4_flash_2026_08_06'; },
        code: 'forecast_model_version_mismatch',
      },
      {
        mutate: (forecast) => { forecast.versions.queryVersion = 'cm_query_v2'; },
        code: 'forecast_query_version_mismatch',
      },
      {
        mutate: (forecast) => { forecast.versions.curatorAccessVersion = 'cm_curator_access_v2'; },
        code: 'forecast_curator_access_version_mismatch',
      },
    ];
    for (const [index, { mutate, code }] of cases.entries()) {
      const bundle = lockedBundle({ namespace: `forecast-version-${index}` });
      mutate(bundle.forecast);
      assert.throws(() => score(bundle), expectCode(code), code);
    }
  });

  it('rejects a published prediction missing direction or attribution', () => {
    const cases: Array<(prediction: Prediction) => void> = [
      (prediction) => { prediction.predictedDirection = null; },
      (prediction) => { prediction.attributedCorporateFamilyDigest = null; },
    ];
    for (const [index, mutate] of cases.entries()) {
      const bundle = lockedBundle({ namespace: `published-incomplete-${index}` });
      mutate(bundle.predictions.predictions[0]!);
      assert.throws(() => score(bundle), expectCode('published_prediction_incomplete'));
    }
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

  it('recomputes the parent verdict instead of trusting the retained report', () => {
    // The self-digest proves the parent report is internally consistent, not that anybody
    // authorised it -- computeScoreReportDigest is exported and unsalted, so a curator whose
    // gate run said `pass` (or `fail`) can edit `outcome` to `incomplete`, re-digest, and
    // reopen a closed gate. The scorer holds the parent's corpus, gold labels and predictions,
    // so the verdict must be re-derived from rows.
    const scenario = continuationScenario({
      namespace: 'forged-parent',
      eligibleCount: 150,
      publishLimit: 150,
    });
    assert.equal(scenario.previousReport.outcome, 'pass');

    const forgedReport = structuredClone(scenario.previousReport);
    forgedReport.outcome = 'incomplete';
    forgedReport.reportSha256 = computeScoreReportDigest(forgedReport);
    // The forgery is internally perfect: the digest verifies against its own contents.
    assert.equal(computeScoreReportDigest(forgedReport), forgedReport.reportSha256);

    const child = structuredClone(scenario.childBundle);
    child.corpus.continuation!.parentReportSha256 = forgedReport.reportSha256;
    child.predictions.corpusSha256 = computeBlindCorpusDigest(child.corpus);

    assert.throws(() => score(child, {
      corpus: scenario.previousBundle.corpus,
      expectedCorpusSha256: computeBlindCorpusDigest(scenario.previousBundle.corpus),
      goldLabels: scenario.previousBundle.gold,
      predictions: scenario.previousBundle.predictions,
      report: forgedReport,
    }), expectCode('previous_report_outcome_not_reproducible'));
  });

  it('rejects a continuation that changes the corpus purpose or curator access version', () => {
    // A tracer_gate corpus is structurally always `incomplete` (its 100-example floor sits
    // below confidence_calibration_stage3's minimumDenominator of 200), so without a purpose
    // check it could be continued into a stage3_gate child that is forced to carry every
    // tracer row -- silently merging two populations the lifecycle keeps apart.
    const { childBundle, previous } = continuationScenario({ namespace: 'purpose-drift' });
    const drifted = structuredClone(childBundle);
    drifted.corpus.purpose = 'tracer_gate';
    drifted.predictions.corpusSha256 = computeBlindCorpusDigest(drifted.corpus);
    assert.throws(() => score(drifted, previous), expectCode('continuation_purpose_mismatch'));

    const curatorDrift = structuredClone(childBundle);
    curatorDrift.corpus.curatorAccessVersion = 'cm_curator_access_v2';
    curatorDrift.gold.curatorAccessVersion = 'cm_curator_access_v2';
    curatorDrift.corpus.sealedGoldLabelsSha256 = computeGoldLabelSetDigest(curatorDrift.gold);
    curatorDrift.predictions.corpusSha256 = computeBlindCorpusDigest(curatorDrift.corpus);
    assert.throws(
      () => score(curatorDrift, previous),
      expectCode('continuation_curator_access_version_mismatch'),
    );
  });

  it('distinguishes an uncommitted expansion from one that is not the precommitted manifest', () => {
    const { childBundle, previous } = continuationScenario({ namespace: 'expansion-codes' });
    // Same row count, different rows: the parent DID precommit, these are not those rows.
    const swapped = structuredClone(childBundle);
    const substitute = examples('substitute-expansion', 60, 90_000);
    swapped.corpus.examples.splice(200, 60, ...substitute);
    swapped.gold.labels = swapped.gold.labels.map((label, index) => (
      index >= 200
        ? { ...label, opaqueExampleId: swapped.corpus.examples[index]!.opaqueExampleId,
            canonicalCorporateFamilyDigest: swapped.corpus.examples[index]!.corporateFamilyDigest }
        : label
    ));
    swapped.predictions.predictions = swapped.predictions.predictions.map((prediction, index) => (
      index >= 200
        ? { ...prediction, opaqueExampleId: swapped.corpus.examples[index]!.opaqueExampleId,
            attributedCorporateFamilyDigest: prediction.publish
              ? swapped.corpus.examples[index]!.corporateFamilyDigest
              : null }
        : prediction
    ));
    swapped.corpus.sealedGoldLabelsSha256 = computeGoldLabelSetDigest(swapped.gold);
    swapped.predictions.corpusSha256 = computeBlindCorpusDigest(swapped.corpus);
    assert.throws(
      () => score(swapped, previous),
      expectCode('continuation_expansion_manifest_mismatch'),
    );
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

  it('requires the retained parent digest independently of the parent artifact', () => {
    const scenario = continuationScenario({ namespace: 'parent-anchor' });
    const previous = {
      ...scenario.previous,
      expectedCorpusSha256: syntheticDigest('wrong-parent-anchor'),
    };
    assert.throws(
      () => score(scenario.childBundle, previous),
      expectCode('corpus_mutated_after_lock'),
    );
  });

  it('rejects resealed draft and invalid-lock parents', () => {
    const draftScenario = continuationScenario({ namespace: 'draft-parent' });
    const draft = rebindContinuationParent(draftScenario, (corpus) => {
      corpus.status = 'draft';
      corpus.lockedAt = null;
    });
    assert.throws(
      () => score(draft.childBundle, draft.previous),
      expectCode('corpus_not_locked'),
    );

    const invalidLockScenario = continuationScenario({ namespace: 'invalid-lock-parent' });
    const invalidLock = rebindContinuationParent(invalidLockScenario, (corpus) => {
      corpus.lockedAt = 'not-a-timestamp';
    });
    assert.throws(
      () => score(invalidLock.childBundle, invalidLock.previous),
      expectCode('corpus_lock_timestamp_invalid'),
    );
  });

  it('requires the parent lock to strictly precede the child lock', () => {
    const scenario = continuationScenario({ namespace: 'lock-order' });
    const rebound = rebindContinuationParent(scenario, (corpus) => {
      corpus.lockedAt = '2026-08-05T04:00:00.000Z';
    });
    assert.throws(
      () => score(rebound.childBundle, rebound.previous),
      expectCode('continuation_parent_lock_not_before_child'),
    );
  });

  it('rejects a parent report bound to a different corpus identity', () => {
    const cases: Array<(report: ScoreReport) => void> = [
      (report) => { report.corpus.version = 'cm_corpus_other_v1'; },
      (report) => { report.corpus.sha256 = syntheticDigest('other-parent-corpus'); },
    ];
    for (const [index, mutate] of cases.entries()) {
      const scenario = continuationScenario({ namespace: `parent-report-corpus-${index}` });
      const previous = structuredClone(scenario.previous);
      mutate(previous.report);
      previous.report.reportSha256 = computeScoreReportDigest(previous.report);
      assert.throws(
        () => score(scenario.childBundle, previous),
        expectCode('previous_report_corpus_mismatch'),
      );
    }
  });
});

describe('Company Monitoring blind evaluation CLI', () => {
  it('requires the independently retained pilot digest for forecast', () => {
    const result = spawnSync(
      fileURLToPath(new URL('../node_modules/.bin/tsx', import.meta.url)),
      [
        fileURLToPath(new URL('../scripts/company-monitoring-blind-evaluation.mts', import.meta.url)),
        'forecast',
        '--protocol', fileURLToPath(
          new URL('./fixtures/company-monitoring-evaluation/protocol.json', import.meta.url),
        ),
        '--approved-threshold-digest', APPROVED_THRESHOLD_DIGEST,
        '--pilot-corpus', 'unused.json',
        '--pilot-gold', 'unused.json',
        '--pilot-predictions', 'unused.json',
        '--target-corpus', 'unused.json',
        '--target-gold', 'unused.json',
      ],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /missing required option: --expected-pilot-corpus-digest/);
  });

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

  it('rejects incomplete and nested-field artifacts in every digest command', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'cm-blind-digest-cli-'));
    const cli = fileURLToPath(new URL('../scripts/company-monitoring-blind-evaluation.mts', import.meta.url));
    const tsx = fileURLToPath(new URL('../node_modules/.bin/tsx', import.meta.url));
    const bundle = lockedBundle({ namespace: 'digest-shapes' });
    const expansion = examples('digest-expansion', 2, 180_000);
    const cases = [
      {
        command: 'digest-corpus',
        value: bundle.corpus,
        remove: (value: unknown) => { delete (value as JsonObject).purpose; },
        nest: (value: unknown) => {
          ((value as BlindCorpus).examples[0] as unknown as JsonObject).rawContent = 'private';
        },
      },
      {
        command: 'digest-gold',
        value: bundle.gold,
        remove: (value: unknown) => { delete (value as JsonObject).goldLabelVersion; },
        nest: (value: unknown) => {
          ((value as GoldLabelSet).labels[0] as unknown as JsonObject).sourceUrl = 'https://private.invalid';
        },
      },
      {
        command: 'digest-predictions',
        value: bundle.predictions,
        remove: (value: unknown) => { delete (value as JsonObject).modelVersion; },
        nest: (value: unknown) => {
          ((value as PredictionSet).predictions[0] as unknown as JsonObject).prompt = 'private';
        },
      },
      {
        command: 'digest-forecast',
        value: bundle.forecast,
        remove: (value: unknown) => { delete (value as JsonObject).status; },
        nest: (value: unknown) => {
          ((value as BlindForecast).candidateStrata as unknown as JsonObject).rawContent = 'private';
        },
      },
      {
        command: 'digest-expansion',
        value: expansion,
        remove: (value: unknown) => {
          delete (((value as BlindExample[])[0] as unknown) as JsonObject).occurrenceDigest;
        },
        nest: (value: unknown) => {
          (((value as BlindExample[])[0] as unknown) as JsonObject).sourceUrl = 'https://private.invalid';
        },
      },
    ];
    const run = (command: string, value: unknown, name: string) => {
      const path = join(workspace, `${name}.json`);
      writeFileSync(path, JSON.stringify(value));
      return spawnSync(tsx, [cli, command, path], { encoding: 'utf8' });
    };

    try {
      for (const testCase of cases) {
        const incomplete = structuredClone(testCase.value);
        testCase.remove(incomplete);
        assert.equal(run(testCase.command, incomplete, `${testCase.command}-missing`).status, 1);

        const nested = structuredClone(testCase.value);
        testCase.nest(nested);
        assert.equal(run(testCase.command, nested, `${testCase.command}-nested`).status, 1);
      }
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('separates a passing gate, a rejected gate, and an engine error by exit code', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'cm-blind-cli-'));
    const cli = fileURLToPath(new URL('../scripts/company-monitoring-blind-evaluation.mts', import.meta.url));
    const tsx = fileURLToPath(new URL('../node_modules/.bin/tsx', import.meta.url));
    const protocolPath = fileURLToPath(
      new URL('./fixtures/company-monitoring-evaluation/protocol.json', import.meta.url),
    );

    const runScore = (bundle: ReturnType<typeof lockedBundle>): { status: number | null; stdout: string } => {
      const write = (name: string, value: unknown): string => {
        const path = join(workspace, name);
        writeFileSync(path, JSON.stringify(value));
        return path;
      };
      const result = spawnSync(tsx, [
        cli, 'score',
        '--protocol', protocolPath,
        '--approved-threshold-digest', APPROVED_THRESHOLD_DIGEST,
        '--corpus', write('corpus.json', bundle.corpus),
        '--expected-corpus-digest', computeBlindCorpusDigest(bundle.corpus),
        '--gold', write('gold.json', bundle.gold),
        '--predictions', write('predictions.json', bundle.predictions),
        '--forecast', write('forecast.json', bundle.forecast),
      ], { encoding: 'utf8' });
      return { status: result.status, stdout: result.stdout };
    };

    try {
      const passing = runScore(lockedBundle({ namespace: 'cli-pass' }));
      assert.equal(passing.status, 0);
      assert.equal((JSON.parse(passing.stdout) as ScoreReport).outcome, 'pass');

      // A rejected gate must NOT look like success to a wrapper checking $?.
      const rejected = runScore(lockedBundle({
        namespace: 'cli-fail',
        eligibleCount: 200,
        mistakes: 60,
      }));
      assert.equal(rejected.status, 2);
      assert.equal((JSON.parse(rejected.stdout) as ScoreReport).outcome, 'fail');

      const shortfall = runScore(lockedBundle({
        namespace: 'cli-incomplete',
        publishLimit: 90,
        mistakes: 20,
      }));
      assert.equal(shortfall.status, 2);
      assert.equal((JSON.parse(shortfall.stdout) as ScoreReport).outcome, 'incomplete');

      const usageError = spawnSync(tsx, [cli, 'score', '--corpus'], { encoding: 'utf8' });
      assert.equal(usageError.status, 1);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('requires all five continuation inputs together', () => {
    const result = spawnSync(
      fileURLToPath(new URL('../node_modules/.bin/tsx', import.meta.url)),
      [
        fileURLToPath(new URL('../scripts/company-monitoring-blind-evaluation.mts', import.meta.url)),
        'score',
        '--protocol', 'unused.json',
        '--approved-threshold-digest', APPROVED_THRESHOLD_DIGEST,
        '--corpus', 'unused.json',
        '--expected-corpus-digest', APPROVED_THRESHOLD_DIGEST,
        '--gold', 'unused.json',
        '--predictions', 'unused.json',
        '--forecast', 'unused.json',
        '--previous-corpus', 'unused.json',
        '--previous-gold', 'unused.json',
        '--previous-predictions', 'unused.json',
        '--previous-report', 'unused.json',
      ],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /continuation requires all five previous inputs/);
  });
});
