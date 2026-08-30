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
  cacheResilienceIndicatorResponse,
  createGetResilienceIndicators,
  toGetResilienceIndicatorsResponse,
} from '../server/worldmonitor/resilience/v1/get-resilience-indicators.ts';
import { __clearLocalUnavailableBackoffForTests } from '../server/_shared/redis.ts';
import {
  ENDPOINT_RATE_POLICIES,
  FAIL_CLOSED_ENDPOINT_RATE_POLICY_REQUIRED,
} from '../server/_shared/rate-limit.ts';
import { createRedisFetch } from './helpers/fake-upstash-redis.mts';

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
      retrievedAt: '2026-08-29T12:00:00.000Z',
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
    assert.equal(row.retrievedAtAvailable, true);
    assert.equal(row.retrievedAt, '2026-08-29T12:00:00.000Z');
    assert.equal(row.sources[0]?.observationProvenance, true);
    assert.equal(row.sources[0]?.licenseUrl, 'https://www.worldbank.org/en/about/legal/terms-of-use-for-datasets');
    assert.equal(row.sources[0]?.attributionUrl, '');
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

  test('withholds an otherwise auditable raw value when its extraction timestamp is unavailable', () => {
    const trace = createIndicatorTraceCollector();
    trace.recordManual('currencyExternal', 100, [{
      indicatorId: 'fxReservesAdequacy',
      score: 100,
      weight: 1,
      rawValue: 12,
      observedSources: [{
        providerName: 'World Bank Open Data',
        sourceUrl: 'https://api.worldbank.org/v2/country/all/indicator/FI.RES.TOTL.MO',
      }],
    }]);
    const scores = scoreMap({ currencyExternal: { ...emptyScore(100), coverage: 1 } });
    const response = toGetResilienceIndicatorsResponse(
      'DE', scores, materializeIndicatorTrace(trace, scores),
      { now: new Date('2026-08-30T00:00:00.000Z'), dataVersion: '' },
    );
    const row = response.indicators.find((indicator) => indicator.id === 'fxReservesAdequacy');
    assert.ok(row);
    assert.equal(row.rawValue?.available, false);
    assert.equal(row.rawValue?.status, 'conditional');
    assert.equal(row.rawValue?.reason, 'retrieval-timestamp-required');
    assert.equal(row.retrievedAtAvailable, false);
  });

  test('computes literal contribution totals from the serialized row values', () => {
    const trace = createIndicatorTraceCollector();
    trace.recordBlend('macroFiscal', 1, [
      { indicatorId: 'govRevenuePct', score: 1, weight: 1 },
      { indicatorId: 'debtGrowthRate', score: 1, weight: 1 },
      { indicatorId: 'currentAccountPct', score: 1, weight: 1 },
    ]);
    const scores = scoreMap({ macroFiscal: { ...emptyScore(1), coverage: 1 } });
    const response = toGetResilienceIndicatorsResponse(
      'DE', scores, materializeIndicatorTrace(trace, scores),
      { now: new Date('2026-08-30T00:00:00.000Z'), dataVersion: '' },
    );
    const rows = response.indicators.filter((indicator) => indicator.dimension === 'macroFiscal');
    const dimension = response.dimensions.find((candidate) => candidate.id === 'macroFiscal');
    assert.ok(dimension);
    assert.equal(dimension.literalContributionTotal, 0.9999);
    assert.equal(dimension.literalContributionTotal, rows.reduce((sum, row) => sum + row.literalContribution, 0));
  });

  test('serializes runtime weights as unavailable when a source fails before branch selection', () => {
    const trace = createIndicatorTraceCollector();
    trace.recordSelectedIndicators('currencyExternal', ['inflationStability', 'fxReservesAdequacy']);
    trace.recordSourceFailure('currencyExternal');
    const scores = scoreMap({ currencyExternal: emptyScore() });
    const response = toGetResilienceIndicatorsResponse(
      'DE', scores, materializeIndicatorTrace(trace, scores),
      { now: new Date('2026-08-30T00:00:00.000Z'), dataVersion: '' },
    );
    const rows = response.indicators.filter((indicator) => indicator.dimension === 'currencyExternal');
    const selected = rows.filter((row) => ['inflationStability', 'fxReservesAdequacy'].includes(row.id));
    const dormant = rows.filter((row) => !selected.includes(row));
    assert.ok(selected.every((row) => row.state === 'source-failure'));
    assert.ok(selected.every((row) => row.reason === 'dimension-source-failure'));
    assert.ok(dormant.every((row) => row.state === 'inactive'));
    assert.ok(rows.every((row) => row.runtimeWeightAvailable === false));
    assert.ok(rows.every((row) => row.scoringWeightShareAvailable === false));
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
        sourceUrl: 'https://api.worldbank.org/v2/country/all/indicator/FI.RES.TOTL.MO',
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
      observedSources: [{ providerName: 'World Bank Open Data', sourceUrl: 'https://api.worldbank.org/v2/country/all/indicator/FI.RES.TOTL.MO' }],
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

  test('uses the static seed extraction time only for raw values produced by that batch', async () => {
    const handler = createGetResilienceIndicators({
      reader: async (key) => key === 'resilience:static:DE'
        ? { seededAt: '2026-08-29T12:00:00.000Z', fxReservesMonths: { months: 12, year: 2024 } }
        : null,
      readStaticMeta: async () => ({ fetchedAt: '2026-08-29T12:00:00.000Z' }),
      now: () => new Date('2026-08-30T00:00:00.000Z'),
    });
    const response = await handler(
      { request: new Request('https://example.test/api/resilience/v1/get-resilience-indicators?countryCode=DE') } as never,
      { countryCode: 'DE' },
    );
    const reserves = response.indicators.find((row) => row.id === 'fxReservesAdequacy');
    assert.ok(reserves);
    assert.equal(reserves.rawValue?.available, true);
    assert.equal(reserves.retrievedAtAvailable, true);
    assert.equal(reserves.retrievedAt, '2026-08-29T12:00:00.000Z');

    const separateSeed = response.indicators.find((row) => row.id === 'recoveryLiquidReserveMonths');
    assert.ok(separateSeed);
    assert.equal(separateSeed.retrievedAtAvailable, false);
  });

  test('publishes the oldest contributing WGI year for continuity raw data', async () => {
    const indicators = Object.fromEntries([
      ['VA.EST', 2024],
      ['PV.EST', 2023],
      ['GE.EST', 2022],
      ['RQ.EST', 2021],
      ['RL.EST', 2020],
      ['CC.EST', 2019],
    ].map(([key, year]) => [key, { value: 1, year }]));
    const handler = createGetResilienceIndicators({
      reader: async (key) => key === 'resilience:static:DE'
        ? { seededAt: '2026-08-29T12:00:00.000Z', wgi: { indicators } }
        : null,
      readStaticMeta: async () => ({ fetchedAt: '2026-08-29T12:00:00.000Z' }),
      now: () => new Date('2026-08-30T00:00:00.000Z'),
    });
    const response = await handler(
      { request: new Request('https://example.test/api/resilience/v1/get-resilience-indicators?countryCode=DE') } as never,
      { countryCode: 'DE' },
    );
    const continuity = response.indicators.find((row) => row.id === 'recoveryWgiContinuity');
    assert.ok(continuity);
    assert.equal(continuity.rawValue?.available, true);
    assert.equal(continuity.sourceYear, 2019);
    assert.equal(continuity.observationAgeValue, 7);
    assert.equal(continuity.observationAgeBasis, 'source-year');
  });

  test('keeps a recovered static dataset on its original extraction timestamp', async () => {
    const handler = createGetResilienceIndicators({
      reader: async (key) => key === 'resilience:static:DE'
        ? {
            seededAt: '2026-08-30T00:00:00.000Z',
            fxReservesMonths: {
              months: 12,
              year: 2024,
              _recovered: { seededAt: '2026-08-01T00:00:00.000Z' },
            },
          }
        : null,
      readStaticMeta: async () => ({ fetchedAt: '2026-08-30T00:00:00.000Z' }),
      now: () => new Date('2026-08-30T00:00:00.000Z'),
    });
    const response = await handler(
      { request: new Request('https://example.test/api/resilience/v1/get-resilience-indicators?countryCode=DE') } as never,
      { countryCode: 'DE' },
    );
    const reserves = response.indicators.find((row) => row.id === 'fxReservesAdequacy');
    assert.ok(reserves);
    assert.equal(reserves.rawValue?.available, true);
    assert.equal(reserves.retrievedAt, '2026-08-01T00:00:00.000Z');
  });

  test('withholds recovered raw data when its original extraction timestamp is absent', async () => {
    const handler = createGetResilienceIndicators({
      reader: async (key) => key === 'resilience:static:DE'
        ? {
            seededAt: '2026-08-30T00:00:00.000Z',
            fxReservesMonths: { months: 12, year: 2024, _recovered: {} },
          }
        : null,
      readStaticMeta: async () => ({ fetchedAt: '2026-08-30T00:00:00.000Z' }),
      now: () => new Date('2026-08-30T00:00:00.000Z'),
    });
    const response = await handler(
      { request: new Request('https://example.test/api/resilience/v1/get-resilience-indicators?countryCode=DE') } as never,
      { countryCode: 'DE' },
    );
    const reserves = response.indicators.find((row) => row.id === 'fxReservesAdequacy');
    assert.ok(reserves);
    assert.equal(reserves.rawValue?.available, false);
    assert.equal(reserves.rawValue?.reason, 'retrieval-timestamp-required');
    assert.equal(reserves.retrievedAtAvailable, false);
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

  test('separates injected response-cache entries across financial-system construct flips', async () => {
    const original = process.env.RESILIENCE_FIN_SYS_EXPOSURE_ENABLED;
    const keys: string[] = [];
    const cache = new Map<string, Awaited<ReturnType<ReturnType<typeof createGetResilienceIndicators>>>>();
    const handler = createGetResilienceIndicators({
      reader: async () => null,
      readStaticMeta: async () => null,
      responseCache: async (key, fetcher) => {
        keys.push(key);
        const existing = cache.get(key);
        if (existing) return existing;
        const built = await fetcher();
        cache.set(key, built);
        return built;
      },
    });
    const ctx = { request: new Request('https://example.test/api/resilience/v1/get-resilience-indicators?countryCode=DE') } as never;
    try {
      process.env.RESILIENCE_FIN_SYS_EXPOSURE_ENABLED = 'false';
      const rollback = await handler(ctx, { countryCode: 'DE' });
      process.env.RESILIENCE_FIN_SYS_EXPOSURE_ENABLED = 'true';
      const active = await handler(ctx, { countryCode: 'DE' });
      assert.equal(cache.size, 2);
      assert.ok(keys.some((key) => key.includes('financial-system-rollback')));
      assert.ok(keys.some((key) => key.includes('financial-system-active')));
      assert.equal(rollback.constructVersions?.financialSystemExposure, 'rollback');
      assert.equal(active.constructVersions?.financialSystemExposure, 'active');
    } finally {
      if (original == null) delete process.env.RESILIENCE_FIN_SYS_EXPOSURE_ENABLED;
      else process.env.RESILIENCE_FIN_SYS_EXPOSURE_ENABLED = original;
    }
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

  test('does not cache a static-meta read failure as a valid response', async () => {
    let fail = true;
    const cache = new Map<string, Awaited<ReturnType<ReturnType<typeof createGetResilienceIndicators>>>>();
    const handler = createGetResilienceIndicators({
      reader: async () => null,
      readStaticMeta: async () => {
        if (fail) throw new Error('static meta unavailable');
        return { fetchedAt: '2026-08-30T00:00:00.000Z' };
      },
      responseCache: async (key, fetcher) => {
        const existing = cache.get(key);
        if (existing) return existing;
        const built = await fetcher();
        cache.set(key, built);
        return built;
      },
    });
    const ctx = { request: new Request('https://example.test/api/resilience/v1/get-resilience-indicators?countryCode=DE') } as never;
    await assert.rejects(handler(ctx, { countryCode: 'DE' }), /static meta unavailable/);
    assert.equal(cache.size, 0);
    fail = false;
    const response = await handler(ctx, { countryCode: 'DE' });
    assert.equal(response.dataVersion, '2026-08-30');
    assert.equal(cache.size, 1);
  });

  test('does not persist a negative sentinel after the production response builder fails', async () => {
    const originalUrl = process.env.UPSTASH_REDIS_REST_URL;
    const originalToken = process.env.UPSTASH_REDIS_REST_TOKEN;
    const originalFetch = globalThis.fetch;
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
    const { fetchImpl } = createRedisFetch({});
    globalThis.fetch = fetchImpl as typeof fetch;
    let builds = 0;
    const key = 'resilience:indicator-trace:v1:test-negative-cache';
    try {
      await assert.rejects(cacheResilienceIndicatorResponse(key, async () => {
        builds += 1;
        throw new Error('diagnostic read failed');
      }), /diagnostic read failed/);
      __clearLocalUnavailableBackoffForTests();
      const recovered = await cacheResilienceIndicatorResponse(key, async () => {
        builds += 1;
        return { countryCode: 'DE' } as never;
      });
      assert.equal(recovered?.countryCode, 'DE');
      assert.equal(builds, 2);
    } finally {
      __clearLocalUnavailableBackoffForTests();
      globalThis.fetch = originalFetch;
      if (originalUrl == null) delete process.env.UPSTASH_REDIS_REST_URL;
      else process.env.UPSTASH_REDIS_REST_URL = originalUrl;
      if (originalToken == null) delete process.env.UPSTASH_REDIS_REST_TOKEN;
      else process.env.UPSTASH_REDIS_REST_TOKEN = originalToken;
    }
  });
});
