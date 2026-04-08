import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  RESILIENCE_DIMENSION_DOMAINS,
  RESILIENCE_DIMENSION_ORDER,
  RESILIENCE_DIMENSION_SCORERS,
  RESILIENCE_DOMAIN_ORDER,
  getResilienceDomainWeight,
  scoreAllDimensions,
  scoreEnergy,
  scoreInfrastructure,
  scoreTradeSanctions,
} from '../server/worldmonitor/resilience/v1/_dimension-scorers.ts';
import { installRedis } from './helpers/fake-upstash-redis.mts';
import { RESILIENCE_FIXTURES } from './helpers/resilience-fixtures.mts';

const originalFetch = globalThis.fetch;
const originalRedisUrl = process.env.UPSTASH_REDIS_REST_URL;
const originalRedisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
const originalVercelEnv = process.env.VERCEL_ENV;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalRedisUrl == null) delete process.env.UPSTASH_REDIS_REST_URL;
  else process.env.UPSTASH_REDIS_REST_URL = originalRedisUrl;
  if (originalRedisToken == null) delete process.env.UPSTASH_REDIS_REST_TOKEN;
  else process.env.UPSTASH_REDIS_REST_TOKEN = originalRedisToken;
  if (originalVercelEnv == null) delete process.env.VERCEL_ENV;
  else process.env.VERCEL_ENV = originalVercelEnv;
});

describe('resilience scorer contracts', () => {
  it('keeps every dimension scorer within the 0..100 range for known countries', async () => {
    installRedis(RESILIENCE_FIXTURES);

    for (const countryCode of ['NO', 'US', 'YE']) {
      for (const [dimensionId, scorer] of Object.entries(RESILIENCE_DIMENSION_SCORERS)) {
        const result = await scorer(countryCode);
        assert.ok(result.score >= 0 && result.score <= 100, `${countryCode}/${dimensionId} score out of bounds: ${result.score}`);
        assert.ok(result.coverage >= 0 && result.coverage <= 1, `${countryCode}/${dimensionId} coverage out of bounds: ${result.coverage}`);
      }
    }
  });

  it('returns coverage=0 when all backing seeds are missing (source outage must not impute)', async () => {
    installRedis({});

    // Imputation only applies when the source is loaded but the country is absent.
    // A null source (seed outage) must NOT be reclassified as a "stable country" signal.
    // Exception: scoreFoodWater reads per-country static data; fao=null in a loaded static
    // record is a legitimate "not in active crisis" signal, so coverage may be > 0.
    for (const [dimensionId, scorer] of Object.entries(RESILIENCE_DIMENSION_SCORERS)) {
      const result = await scorer('US');
      assert.ok(result.score >= 0 && result.score <= 100, `${dimensionId} fallback score out of bounds: ${result.score}`);
      assert.equal(result.coverage, 0, `${dimensionId} must have coverage=0 when all seeds missing (source outage ≠ country absence)`);
    }
  });

  it('produces the expected weighted overall score from the known fixture dimensions', async () => {
    installRedis(RESILIENCE_FIXTURES);

    const scoreMap = await scoreAllDimensions('US');
    const domainAverages = Object.fromEntries(RESILIENCE_DOMAIN_ORDER.map((domainId) => {
      const dimensionScores = RESILIENCE_DIMENSION_ORDER
        .filter((dimensionId) => RESILIENCE_DIMENSION_DOMAINS[dimensionId] === domainId)
        .map((dimensionId) => scoreMap[dimensionId].score);
      const average = Number((dimensionScores.reduce((sum, value) => sum + value, 0) / dimensionScores.length).toFixed(2));
      return [domainId, average];
    }));

    const overallScore = Number(RESILIENCE_DOMAIN_ORDER.reduce((sum, domainId) => {
      return sum + domainAverages[domainId] * getResilienceDomainWeight(domainId);
    }, 0).toFixed(2));

    assert.deepEqual(domainAverages, {
      economic: 66.33,
      infrastructure: 79,
      energy: 80,
      'social-governance': 61.75,
      'health-food': 60.5,
    });
    assert.equal(overallScore, 68.72);
  });
});

const DE_BASE_FIXTURES = {
  ...RESILIENCE_FIXTURES,
  'resilience:static:DE': {
    iea: { energyImportDependency: { value: 65, year: 2024, source: 'IEA' } },
  },
  'energy:mix:v1:DE': {
    iso2: 'DE', country: 'Germany', year: 2023,
    coalShare: 30, gasShare: 15, oilShare: 1, renewShare: 46,
  },
};

describe('scoreEnergy storageBuffer metric', () => {
  it('EU country with high storage (>80% fill) contributes near-zero storageStress', async () => {
    installRedis({
      ...DE_BASE_FIXTURES,
      'energy:gas-storage:v1:DE': { iso2: 'DE', fillPct: 90, trend: 'stable' },
    });
    const result = await scoreEnergy('DE');
    assert.ok(result.score >= 0 && result.score <= 100, `score out of bounds: ${result.score}`);
    assert.ok(result.coverage > 0, 'coverage should be > 0 when static data present');
  });

  it('EU country with low storage (20% fill) scores lower than with high storage', async () => {
    installRedis({
      ...DE_BASE_FIXTURES,
      'energy:gas-storage:v1:DE': { iso2: 'DE', fillPct: 20, trend: 'withdrawing' },
    });
    const resultLow = await scoreEnergy('DE');

    installRedis({
      ...DE_BASE_FIXTURES,
      'energy:gas-storage:v1:DE': { iso2: 'DE', fillPct: 90, trend: 'stable' },
    });
    const resultHigh = await scoreEnergy('DE');

    assert.ok(resultLow.score < resultHigh.score, `low storage (${resultLow.score}) should score lower than high storage (${resultHigh.score})`);
  });

  it('non-EU country with no gas-storage key drops storageBuffer weight gracefully', async () => {
    installRedis(RESILIENCE_FIXTURES);
    const result = await scoreEnergy('US');
    assert.ok(result.score >= 0 && result.score <= 100, `score out of bounds: ${result.score}`);
    assert.ok(result.coverage > 0, 'coverage should be > 0 when other data is present');
    assert.ok(result.coverage < 1, 'coverage < 1 when storageBuffer is missing');
  });

  it('EU country with null fillPct falls back gracefully (excludes storageBuffer from weighted avg)', async () => {
    installRedis({
      ...DE_BASE_FIXTURES,
      'energy:gas-storage:v1:DE': { iso2: 'DE', fillPct: null },
    });
    const resultNull = await scoreEnergy('DE');

    installRedis(DE_BASE_FIXTURES);
    const resultMissing = await scoreEnergy('DE');

    assert.ok(resultNull.score >= 0 && resultNull.score <= 100, `score out of bounds: ${resultNull.score}`);
    assert.equal(resultNull.score, resultMissing.score, 'null fillPct should behave identically to missing key');
  });
});

describe('scoreInfrastructure: broadband penetration', () => {
  it('pins expected numeric score and coverage for US with broadband data', async () => {
    installRedis(RESILIENCE_FIXTURES);
    const result = await scoreInfrastructure('US');

    assert.equal(result.score, 84, 'pinned infrastructure score for US fixture');
    assert.equal(result.coverage, 1, 'full coverage when all four metrics present');
  });

  it('broadband removal lowers score and coverage', async () => {
    installRedis(RESILIENCE_FIXTURES);
    const withBroadband = await scoreInfrastructure('US');

    const noBroadbandFixtures = structuredClone(RESILIENCE_FIXTURES);
    const usStatic = noBroadbandFixtures['resilience:static:US'] as Record<string, unknown>;
    const infra = usStatic.infrastructure as { indicators: Record<string, unknown> };
    delete infra.indicators['IT.NET.BBND.P2'];
    installRedis(noBroadbandFixtures);
    const withoutBroadband = await scoreInfrastructure('US');

    assert.equal(withoutBroadband.score, 83, 'pinned infrastructure score without broadband');
    assert.equal(withoutBroadband.coverage, 0.85, 'coverage drops to 0.85 without broadband (0.15 weight missing)');
    assert.ok(withBroadband.score > withoutBroadband.score, 'broadband presence increases infrastructure score');
    assert.ok(withBroadband.coverage > withoutBroadband.coverage, 'broadband presence increases coverage');
  });
});

describe('scoreTradeSanctions WB tariff rate', () => {
  it('WB tariff rate contributes to trade score', async () => {
    installRedis(RESILIENCE_FIXTURES);
    const result = await scoreTradeSanctions('US');
    assert.ok(result.score >= 0 && result.score <= 100, `score out of bounds: ${result.score}`);
    assert.ok(result.coverage > 0, 'coverage should be > 0 when tariff data is present');
  });

  it('high tariff rate country scores lower than low tariff rate', async () => {
    installRedis(RESILIENCE_FIXTURES);
    const noResult = await scoreTradeSanctions('NO');
    const yeResult = await scoreTradeSanctions('YE');
    assert.ok(noResult.score > yeResult.score, `NO (${noResult.score}) should score higher than YE (${yeResult.score}) due to lower tariff rate`);
  });
});
