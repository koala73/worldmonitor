import assert from 'node:assert/strict';
import { describe, mock, test } from 'node:test';

import {
  RESILIENCE_DIMENSION_ORDER,
  type ResilienceDimensionId,
  type ResilienceDimensionScore,
} from '../server/worldmonitor/resilience/v1/_dimension-scorers.ts';
import {
  createIndicatorTraceCollector,
  materializeIndicatorTrace,
} from '../server/worldmonitor/resilience/v1/_indicator-trace.ts';
import {
  createGetResilienceIndicators,
  toGetResilienceIndicatorsResponse,
} from '../server/worldmonitor/resilience/v1/get-resilience-indicators.ts';
import {
  ENDPOINT_RATE_POLICIES,
  FAIL_CLOSED_ENDPOINT_RATE_POLICY_REQUIRED,
} from '../server/_shared/rate-limit.ts';

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

function scoreMap(overrides: Partial<Record<ResilienceDimensionId, ResilienceDimensionScore>> = {}) {
  return Object.fromEntries(
    RESILIENCE_DIMENSION_ORDER.map((dimensionId) => [dimensionId, overrides[dimensionId] ?? emptyScore()]),
  ) as Record<ResilienceDimensionId, ResilienceDimensionScore>;
}

describe('GetResilienceIndicators materialization', () => {
  test('exposes an audited observed raw value and uses source-year age without false day precision', () => {
    const trace = createIndicatorTraceCollector();
    trace.recordManual('currencyExternal', 100, [{
      indicatorId: 'fxReservesAdequacy',
      score: 100,
      weight: 1,
      rawValue: 12,
      rawUnit: 'months_of_imports',
      sourceYear: 2024,
      observedSources: [{
        providerName: 'World Bank Open Data',
        sourceUrl: 'https://api.worldbank.org/v2/country/DE/indicator/FI.RES.TOTL.MO',
      }],
    }]);
    const scores = scoreMap({ currencyExternal: { ...emptyScore(100), coverage: 1 } });
    const response = toGetResilienceIndicatorsResponse(
      'DE',
      scores,
      materializeIndicatorTrace(trace, scores),
      { now: new Date('2026-08-30T00:00:00.000Z'), dataVersion: '2026-08-29' },
    );

    const row = response.indicators.find((indicator) => indicator.id === 'fxReservesAdequacy');
    assert.ok(row);
    assert.equal(row.rawValue?.available, true);
    assert.equal(row.rawValue?.numericValue, 12);
    assert.equal(row.sourceYear, 2024);
    assert.equal(row.observationAgeValue, 2);
    assert.equal(row.observationAgeUnit, 'years');
    assert.equal(row.observationAgeBasis, 'source-year');
    assert.equal(row.retrievedAtAvailable, false);
    assert.equal(row.sources[0]?.observationProvenance, true);
  });

  test('withholds restricted raw values while preserving derived score and contribution', () => {
    const trace = createIndicatorTraceCollector();
    trace.recordBlend('macroFiscal', 75, [{
      indicatorId: 'householdDebtService',
      score: 75,
      weight: 1,
      rawValue: 5,
      rawUnit: 'percent_income',
      observedSources: [{ providerName: 'Bank for International Settlements', sourceUrl: 'https://data.bis.org/' }],
    }]);
    const scores = scoreMap({ macroFiscal: { ...emptyScore(75), coverage: 1 } });
    const response = toGetResilienceIndicatorsResponse(
      'DE',
      scores,
      materializeIndicatorTrace(trace, scores),
      { now: new Date('2026-08-30T00:00:00.000Z'), dataVersion: '' },
    );
    const row = response.indicators.find((indicator) => indicator.id === 'householdDebtService');
    assert.ok(row);
    assert.equal(row.normalizedScore, 75);
    assert.equal(row.effectiveContribution, 75);
    assert.equal(row.rawValue?.available, false);
    assert.equal(row.rawValue?.status, 'restricted');
    assert.ok(row.sources[0]?.attribution.includes('Bank for International Settlements'));
    assert.equal(row.sources[0]?.observationProvenance, true);
  });

  test('marks only exact observed composite sources as provenance', () => {
    const trace = createIndicatorTraceCollector();
    trace.recordBlend('liquidReserveAdequacy', 50, [{
      indicatorId: 'recoveryLiquidReserveMonths',
      score: 50,
      weight: 1,
      rawValue: 6.5,
      observedSources: [{
        providerName: 'World Bank Open Data',
        sourceUrl: 'https://api.worldbank.org/v2/',
      }],
    }]);
    const scores = scoreMap({ liquidReserveAdequacy: { ...emptyScore(50), coverage: 1 } });
    const response = toGetResilienceIndicatorsResponse(
      'DE', scores, materializeIndicatorTrace(trace, scores),
      { now: new Date('2026-08-30T00:00:00.000Z'), dataVersion: '' },
    );
    const row = response.indicators.find((indicator) => indicator.id === 'recoveryLiquidReserveMonths');
    assert.ok(row);
    assert.equal(row.sources.length, 2);
    assert.equal(row.sources[0]?.observationProvenance, true);
    assert.equal(row.sources[0]?.name, 'World Bank Open Data');
    assert.equal(row.sources[1]?.observationProvenance, false);
  });

  test('does not claim observation provenance for a missing or imputed source', () => {
    const trace = createIndicatorTraceCollector();
    trace.recordBlend('currencyExternal', 50, [{
      indicatorId: 'fxReservesAdequacy',
      score: 50,
      weight: 1,
      imputed: true,
      rawValue: null,
      observedSources: [{ providerName: 'World Bank Open Data', sourceUrl: 'https://api.worldbank.org/v2/' }],
    }]);
    const scores = scoreMap({ currencyExternal: emptyScore(50) });
    const response = toGetResilienceIndicatorsResponse(
      'DE', scores, materializeIndicatorTrace(trace, scores),
      { now: new Date('2026-08-30T00:00:00.000Z'), dataVersion: '' },
    );
    const row = response.indicators.find((indicator) => indicator.id === 'fxReservesAdequacy');
    assert.ok(row);
    assert.equal(row.state, 'imputed');
    assert.equal(row.sources[0]?.observationProvenance, false);
  });

  test('labels an observed Eurostat override with its own audit status', () => {
    const trace = createIndicatorTraceCollector();
    trace.recordBlend('energy', 50, [{
      indicatorId: 'energyImportDependency',
      score: 50,
      weight: 1,
      rawValue: 50,
      observedSources: [{ providerName: 'Eurostat', sourceUrl: 'https://ec.europa.eu/eurostat/' }],
    }]);
    const scores = scoreMap({ energy: { ...emptyScore(50), coverage: 1 } });
    const response = toGetResilienceIndicatorsResponse(
      'DE', scores, materializeIndicatorTrace(trace, scores),
      { now: new Date('2026-08-30T00:00:00.000Z'), dataVersion: '' },
    );
    const row = response.indicators.find((indicator) => indicator.id === 'energyImportDependency');
    assert.ok(row);
    assert.equal(row.sources[0]?.name, 'Eurostat');
    assert.equal(row.sources[0]?.license, 'Redistribution audit incomplete');
    assert.match(row.sources[0]?.attribution ?? '', /Eurostat/);
  });
});

describe('GetResilienceIndicators handler', () => {
  test('uses a fail-closed route budget for cold scorer fan-out', () => {
    const path = '/api/resilience/v1/get-resilience-indicators';
    assert.deepEqual(ENDPOINT_RATE_POLICIES[path], { limit: 60, window: '60 s' });
    assert.ok(path in FAIL_CLOSED_ENDPOINT_RATE_POLICY_REQUIRED);
  });
  test('rejects an invalid country before source reads', async () => {
    let reads = 0;
    const handler = createGetResilienceIndicators({
      reader: async () => {
        reads += 1;
        return null;
      },
      readStaticMeta: async () => null,
    });
    await assert.rejects(
      handler(
        { request: new Request('https://example.test/api/resilience/v1/get-resilience-indicators?countryCode=DEU') } as never,
        { countryCode: 'DEU' },
      ),
      (error) => error instanceof Error && error.name === 'ValidationError',
    );
    assert.equal(reads, 0);
  });

  test('exercises the real scorer trace once and returns all 72 registry rows', async () => {
    const warnings = mock.method(console, 'warn', () => {});
    const infos = mock.method(console, 'info', () => {});
    const reads = new Map<string, number>();
    const handler = createGetResilienceIndicators({
      reader: async (key) => {
        reads.set(key, (reads.get(key) ?? 0) + 1);
        return null;
      },
      readStaticMeta: async () => ({ fetchedAt: '2026-08-29T12:00:00.000Z' }),
      now: () => new Date('2026-08-30T00:00:00.000Z'),
    });
    try {
      const response = await handler(
        { request: new Request('https://example.test/api/resilience/v1/get-resilience-indicators?countryCode=de') } as never,
        { countryCode: 'de' },
      );
      assert.equal(response.countryCode, 'DE');
      assert.equal(response.dataVersion, '2026-08-29');
      assert.equal(response.indicators.length, 72);
      assert.equal(new Set(response.indicators.map((row) => row.id)).size, 72);
      for (const dimension of response.dimensions) {
        if (!dimension.reconciliationAvailable) {
          assert.equal(dimension.active, false, dimension.id);
          assert.ok(dimension.reason.length > 0, dimension.id);
          continue;
        }
        assert.equal(
          Number(dimension.effectiveContributionTotal.toFixed(4)),
          Number(dimension.score.toFixed(4)),
          dimension.id,
        );
      }
      assert.ok([...reads.values()].every((count) => count === 1), 'memoized source reads must occur at most once');
    } finally {
      warnings.mock.restore();
      infos.mock.restore();
    }
  });

  test('uses the same versioned response cache entry for repeated country requests', async () => {
    let cacheBuilds = 0;
    const cache = new Map<string, Awaited<ReturnType<ReturnType<typeof createGetResilienceIndicators>>>>();
    const handler = createGetResilienceIndicators({
      reader: async () => null,
      readStaticMeta: async () => null,
      responseCache: async (key, fetcher) => {
        const existing = cache.get(key);
        if (existing) return existing;
        cacheBuilds += 1;
        const built = await fetcher();
        cache.set(key, built);
        return built;
      },
    });
    const ctx = { request: new Request('https://example.test/api/resilience/v1/get-resilience-indicators?countryCode=DE') } as never;
    const first = await handler(ctx, { countryCode: 'DE' });
    const second = await handler(ctx, { countryCode: 'de' });
    assert.equal(cacheBuilds, 1);
    assert.deepEqual(second, first);
  });

  test('does not cache a diagnostic seed-read failure as a valid response', async () => {
    let fail = true;
    const cache = new Map<string, Awaited<ReturnType<ReturnType<typeof createGetResilienceIndicators>>>>();
    const handler = createGetResilienceIndicators({
      reader: async () => {
        if (fail) throw new Error('redis unavailable');
        return null;
      },
      readStaticMeta: async () => null,
      responseCache: async (key, fetcher) => {
        const existing = cache.get(key);
        if (existing) return existing;
        const built = await fetcher();
        cache.set(key, built);
        return built;
      },
    });
    const ctx = { request: new Request('https://example.test/api/resilience/v1/get-resilience-indicators?countryCode=DE') } as never;
    await assert.rejects(handler(ctx, { countryCode: 'DE' }), /redis unavailable/);
    assert.equal(cache.size, 0);
    fail = false;
    const response = await handler(ctx, { countryCode: 'DE' });
    assert.equal(response.indicators.length, 72);
    assert.equal(cache.size, 1);
  });
});
