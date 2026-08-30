import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  RESILIENCE_DIMENSION_ORDER,
  scoreCurrencyExternal,
  weightedBlend,
  type ResilienceDimensionId,
  type ResilienceDimensionScore,
} from '../server/worldmonitor/resilience/v1/_dimension-scorers.ts';
import {
  RESILIENCE_INDICATOR_IDS,
  createIndicatorTraceCollector,
  materializeIndicatorTrace,
} from '../server/worldmonitor/resilience/v1/_indicator-trace.ts';
import { INDICATOR_REGISTRY } from '../server/worldmonitor/resilience/v1/_indicator-registry.ts';

function emptyScore(score = 0): ResilienceDimensionScore {
  return {
    score,
    coverage: 0,
    observedWeight: 0,
    imputedWeight: 0,
    imputationClass: null,
    freshness: { lastObservedAtMs: 0, staleness: '' },
  };
}

function scoreMap(overrides: Partial<Record<ResilienceDimensionId, number>> = {}) {
  return Object.fromEntries(
    RESILIENCE_DIMENSION_ORDER.map((dimensionId) => [dimensionId, emptyScore(overrides[dimensionId] ?? 0)]),
  ) as Record<ResilienceDimensionId, ResilienceDimensionScore>;
}

function rowsFor(
  collector: ReturnType<typeof createIndicatorTraceCollector>,
  dimensionId: ResilienceDimensionId,
  score: number,
) {
  return materializeIndicatorTrace(collector, scoreMap({ [dimensionId]: score }))
    .indicators.filter((row) => row.dimension === dimensionId);
}

describe('resilience indicator trace', () => {
  it('renormalizes missing metric weight and reconciles the published score', () => {
    const trace = createIndicatorTraceCollector();
    const result = weightedBlend([
      { indicatorId: 'govRevenuePct', score: 80, weight: 0.4, rawValue: 37, rawUnit: 'percent_gdp' },
      { indicatorId: 'debtGrowthRate', score: null, weight: 0.6 },
    ], { dimensionId: 'macroFiscal', trace });

    const rows = rowsFor(trace, 'macroFiscal', result.score);
    const observed = rows.find((row) => row.indicatorId === 'govRevenuePct')!;
    const missing = rows.find((row) => row.indicatorId === 'debtGrowthRate')!;
    assert.equal(observed.scoringWeightShare, 1);
    assert.equal(observed.literalContribution, 80);
    assert.equal(observed.effectiveContribution, 80);
    assert.equal(missing.state, 'missing');
    assert.equal(observed.runtimeWeightsAvailable, true);
    assert.equal(missing.runtimeWeightsAvailable, true);
    assert.equal(missing.effectiveContribution, 0);
  });

  it('keeps fallback scoring weight without calling it observed', () => {
    const trace = createIndicatorTraceCollector();
    const result = weightedBlend([
      { indicatorId: 'bisLbsXborderPctGdp', score: null, fallbackScore: 0, weight: 0.5 },
      { indicatorId: 'fatfListingStatus', score: 100, weight: 0.5, rawValue: 'compliant', rawUnit: 'fatf_status' },
    ], { dimensionId: 'financialSystemExposure', trace });

    const rows = rowsFor(trace, 'financialSystemExposure', result.score);
    assert.equal(rows.find((row) => row.indicatorId === 'bisLbsXborderPctGdp')?.state, 'fallback');
    assert.equal(rows.find((row) => row.indicatorId === 'bisLbsXborderPctGdp')?.includedInDimensionScore, true);
    assert.equal(rows.reduce((sum, row) => sum + row.effectiveContribution, 0), result.score);
  });

  it('records imputation separately from certainty coverage', () => {
    const trace = createIndicatorTraceCollector();
    const result = weightedBlend([
      {
        indicatorId: 'tradeRestrictions',
        score: 60,
        weight: 1,
        certaintyCoverage: 0.4,
        imputed: true,
        imputationClass: 'unmonitored',
      },
    ], { dimensionId: 'tradePolicy', trace });

    const row = rowsFor(trace, 'tradePolicy', result.score)
      .find((candidate) => candidate.indicatorId === 'tradeRestrictions')!;
    assert.equal(row.state, 'imputed');
    assert.equal(row.imputationClass, 'unmonitored');
    assert.equal(row.certaintyCoverage, 0.4);
    assert.equal(row.effectiveContribution, 60);
  });

  it('uses runtime weight for scoring share and preserves nominal weight', () => {
    const trace = createIndicatorTraceCollector();
    const result = weightedBlend([
      { indicatorId: 'rsfPressFreedom', score: 50, weight: 0.55 },
      { indicatorId: 'socialVelocity', score: 0, weight: 0.03, nominalWeight: 0.15 },
      { indicatorId: 'newsThreatScore', score: 100, weight: 0.06, nominalWeight: 0.30 },
    ], { dimensionId: 'informationCognitive', trace });

    const rows = rowsFor(trace, 'informationCognitive', result.score);
    const velocity = rows.find((row) => row.indicatorId === 'socialVelocity')!;
    assert.equal(velocity.runtimeWeight, 0.03);
    assert.equal(velocity.nominalWeight, 0.15);
    assert.equal(rows.reduce((sum, row) => sum + row.effectiveContribution, 0), result.score);
  });

  it('traces the manual currency formula with raw years', async () => {
    const trace = createIndicatorTraceCollector();
    const values = new Map<string, unknown>([
      ['economic:imf:macro:v2', { countries: { PT: { inflationPct: 2, year: 2025 } } }],
      ['resilience:static:PT', { fxReservesMonths: { months: 12, year: 2024 } }],
    ]);
    const result = await scoreCurrencyExternal('PT', async (key) => values.get(key) ?? null, { trace });
    const rows = rowsFor(trace, 'currencyExternal', result.score);

    const inflation = rows.find((row) => row.indicatorId === 'inflationStability')!;
    const reserves = rows.find((row) => row.indicatorId === 'fxReservesAdequacy')!;
    assert.equal(inflation.rawValue, 2);
    assert.equal(inflation.sourceYear, 2025);
    assert.equal(inflation.effectiveContribution, 60);
    assert.equal(reserves.sourceYear, 2024);
    assert.equal(reserves.effectiveContribution, 40);
    assert.deepEqual(reserves.observedSources, [
      { providerName: 'World Bank Open Data', sourceUrl: 'https://api.worldbank.org/v2/country/all/indicator/FI.RES.TOTL.MO' },
    ]);
  });

  it('retains literal pre-cap contributions and applies a named cap factor', () => {
    const trace = createIndicatorTraceCollector();
    trace.recordBlend('financialSystemExposure', 80, [
      { indicatorId: 'shortTermExternalDebtPctGni', score: 80, weight: 0.5 },
      { indicatorId: 'fatfListingStatus', score: 80, weight: 0.5 },
    ]);
    trace.recordPolicyCap('financialSystemExposure', 'comprehensive-embargo-cap', 80, 15);

    const snapshot = materializeIndicatorTrace(trace, scoreMap({ financialSystemExposure: 15 }));
    const dimension = snapshot.dimensions.find((candidate) => candidate.id === 'financialSystemExposure')!;
    assert.equal(dimension.policyCapName, 'comprehensive-embargo-cap');
    assert.equal(dimension.policyCapFactor, 15 / 80);
    assert.equal(dimension.indicators.reduce((sum, row) => sum + row.literalContribution, 0), 80);
    assert.equal(dimension.indicators.reduce((sum, row) => sum + row.effectiveContribution, 0), 15);
  });

  it('materializes all 72 registry rows once and in canonical order', () => {
    const snapshot = materializeIndicatorTrace(createIndicatorTraceCollector(), scoreMap());
    assert.equal(snapshot.indicators.length, 72);
    assert.deepEqual(snapshot.indicators.map((row) => row.indicatorId), RESILIENCE_INDICATOR_IDS);
    assert.deepEqual(snapshot.indicators.map((row) => row.indicatorId), INDICATOR_REGISTRY.map((row) => row.id));
    assert.equal(new Set(snapshot.indicators.map((row) => row.indicatorId)).size, 72);
    assert.ok(snapshot.indicators.every((row) => !row.includedInDimensionScore && row.effectiveContribution === 0));
    assert.ok(snapshot.indicators.every((row) => row.runtimeWeightsAvailable === false));
    assert.deepEqual(
      snapshot.indicators.map((row) => row.nominalWeight),
      INDICATOR_REGISTRY.map((row) => row.weight),
    );
  });

  it('reconciles every traced dimension exactly at four decimals', () => {
    const trace = createIndicatorTraceCollector();
    trace.recordBlend('macroFiscal', 66.67, [
      { indicatorId: 'govRevenuePct', score: 100, weight: 1 },
      { indicatorId: 'debtGrowthRate', score: 50, weight: 1 },
      { indicatorId: 'currentAccountPct', score: 50, weight: 1 },
    ]);
    const snapshot = materializeIndicatorTrace(trace, scoreMap({ macroFiscal: 66.67 }));
    for (const dimension of snapshot.dimensions) {
      const sum = Number(dimension.indicators.reduce((total, row) => total + row.effectiveContribution, 0).toFixed(4));
      assert.equal(sum, Number(dimension.score.toFixed(4)), dimension.id);
    }
  });

  it('keeps substituted source-failure rows in the published score reconciliation', () => {
    const trace = createIndicatorTraceCollector();
    trace.recordManual('currencyExternal', 50, [
      { indicatorId: 'inflationStability', score: 50, weight: 0.6, imputed: true },
      { indicatorId: 'fxReservesAdequacy', score: 50, weight: 0.4, imputed: true },
    ]);
    trace.recordSourceFailure('currencyExternal');

    const rows = rowsFor(trace, 'currencyExternal', 50);
    const included = rows.filter((row) => row.includedInDimensionScore);
    assert.equal(included.length, 2);
    assert.ok(included.every((row) => row.state === 'source-failure'));
    assert.ok(included.every((row) => row.reason === 'dimension-source-failure'));
    assert.ok(included.every((row) => row.imputationClass === 'source-failure'));
    assert.ok(included.every((row) => row.runtimeWeightsAvailable));
    assert.equal(included.reduce((sum, row) => sum + row.effectiveContribution, 0), 50);
  });

  it('does not invent runtime weights when a source fails before the scorer records a branch', () => {
    const trace = createIndicatorTraceCollector();
    trace.recordSelectedIndicators('currencyExternal', ['inflationStability', 'fxReservesAdequacy']);
    trace.recordSourceFailure('currencyExternal');

    const rows = rowsFor(trace, 'currencyExternal', 0);
    const selected = rows.filter((row) => ['inflationStability', 'fxReservesAdequacy'].includes(row.indicatorId));
    const dormant = rows.filter((row) => !selected.includes(row));
    assert.ok(selected.every((row) => row.state === 'source-failure'));
    assert.ok(selected.every((row) => row.reason === 'dimension-source-failure'));
    assert.ok(dormant.every((row) => row.state === 'inactive'));
    assert.ok(rows.every((row) => row.runtimeWeightsAvailable === false));
  });
});
