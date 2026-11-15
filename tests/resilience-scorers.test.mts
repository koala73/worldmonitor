import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  RESILIENCE_DIMENSION_DOMAINS,
  RESILIENCE_DIMENSION_ORDER,
  RESILIENCE_DIMENSION_SCORERS,
  RESILIENCE_DIMENSION_TYPES,
  RESILIENCE_DOMAIN_ORDER,
  scoreAllDimensions,
  scoreEnergy,
  scoreInfrastructure,
  scoreTradePolicy,
} from '../server/worldmonitor/resilience/v1/_dimension-scorers.ts';
import { __testing__, buildDimensionList, buildDomainList } from '../server/worldmonitor/resilience/v1/_shared.ts';
import { installRedis } from './helpers/fake-upstash-redis.mts';
import { RESILIENCE_FIXTURES } from './helpers/resilience-fixtures.mts';
import { getResilienceStressFactor, round } from '../server/_shared/resilience-stats.ts';

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
    // Exceptions:
    //   - scoreFoodWater reads per-country static data; fao=null in a loaded static
    //     record is a legitimate "not in active crisis" signal.
    //   - scoreCurrencyExternal (T1.7 source-failure wiring): the legacy absence
    //     branch (score=50, coverage=0, imputationClass=null) was deleted so every
    //     imputed return path carries a taxonomy tag. When BIS + IMF + reserves are
    //     all absent, the scorer falls through to IMPUTE.bisEer (curated_list_absent
    //     → unmonitored, coverage=0.3). The aggregation pass then re-tags to
    //     source-failure when the adapter is in seed-meta failedDatasets. This is the
    //     single source of truth for "no currency data"; null-imputationClass paths
    //     on non-real-data return branches are no longer permitted.
    // PR 3 §3.5: fuelStockDays retired (coverage=0 + imputationClass=null).
    // PR 2 §3.4: reserveAdequacy retired (same shape). Both pass the
    // default coverage=0 assertion below instead of the T1.7 fall-through
    // assertion.
    //
    // liquidReserveAdequacy (PR 2 §3.4) is NEW and falls through to
    // IMPUTE.recoveryLiquidReserveAdequacy (imputationClass=unmonitored)
    // when its seed is missing — same taxonomy as the other recovery
    // dims in this set.
    //
    // sovereignFiscalBuffer (PR 2 §3.4) falls through to
    // IMPUTE.recoverySovereignFiscalBuffer when the SWF seed key is
    // absent entirely. Added here alongside the other recovery
    // fall-throughs.
    const coverageZeroExempt = new Set([
      'currencyExternal',
      'fiscalSpace', 'externalDebtCoverage',
      'importConcentration', 'stateContinuity',
      'liquidReserveAdequacy', 'sovereignFiscalBuffer',
    ]);
    // #6460: `education` is FAIL-CLOSED, so on a total seed outage it throws
    // rather than returning a coverage=0 shape. That is the correct behaviour
    // and the point of the design — a missing envelope means the Railway bundle
    // is not publishing, which is an operator problem, and imputing every
    // country to the midpoint would hide it. Asserted explicitly here instead
    // of being exempted, so a regression that silently downgrades the throw to
    // a quiet coverage=0 still fails this test.
    const failClosedOnTotalOutage = new Set(['education']);
    for (const [dimensionId, scorer] of Object.entries(RESILIENCE_DIMENSION_SCORERS)) {
      if (failClosedOnTotalOutage.has(dimensionId)) {
        await assert.rejects(
          () => scorer('US'),
          (err: Error) => err.name === 'ResilienceConfigurationError'
            && /required seed-meta absent or unhealthy/.test(err.message),
          `${dimensionId} must fail closed when its seed-meta envelope is absent`,
        );
        continue;
      }
      const result = await scorer('US');
      assert.ok(result.score >= 0 && result.score <= 100, `${dimensionId} fallback score out of bounds: ${result.score}`);
      if (coverageZeroExempt.has(dimensionId)) {
        // The scorer emits the curated_list_absent taxonomy entry directly;
        // coverage is the taxonomy's certaintyCoverage (0.3) rather than 0.
        assert.ok(result.imputedWeight > 0, `${dimensionId} must emit imputed weight on T1.7 fall-through`);
        assert.equal(result.imputationClass, 'unmonitored',
          `${dimensionId} fall-through must tag unmonitored, got ${result.imputationClass}`);
        continue;
      }
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

    // This arithmetic-only assertion deliberately averages every serialized
    // row. Production aggregation is different: the domain blend drops zero
    // coverage, which is why the coverage-weighted assertion below moves by a
    // far smaller amount than this flat mean does.
    assert.deepEqual(domainAverages, {
      economic: 56.5,
      infrastructure: 79.67,
      energy: 80,
      'social-governance': 72.2,
      'health-food': 60.5,
      recovery: 49.63,
    });

    const { coverageWeightedMean } = __testing__;
    const dimensions = buildDimensionList(scoreMap);
    const baselineDims = dimensions.filter((d) => {
      const t = RESILIENCE_DIMENSION_TYPES[d.id];
      return t === 'baseline' || t === 'mixed';
    });
    const stressDims = dimensions.filter((d) => {
      const t = RESILIENCE_DIMENSION_TYPES[d.id];
      return t === 'stress' || t === 'mixed';
    });

    const baselineScore = round(coverageWeightedMean(baselineDims));
    const stressScore = round(coverageWeightedMean(stressDims));
    const stressFactor = round(getResilienceStressFactor(stressScore), 4);

    assert.equal(baselineScore, 63.21);
    assert.equal(stressScore, 71);
    assert.equal(stressFactor, 0.29);

    const overallScore = round(
      buildDomainList(dimensions).reduce((sum, domain) => sum + domain.score * domain.weight, 0),
    );
    assert.equal(overallScore, 65.75);
  });

  it('baselineScore is computed from baseline + mixed dimensions only', async () => {
    installRedis(RESILIENCE_FIXTURES);
    const scoreMap = await scoreAllDimensions('US');

    const baselineDimIds = RESILIENCE_DIMENSION_ORDER.filter((id) => {
      const t = RESILIENCE_DIMENSION_TYPES[id];
      return t === 'baseline' || t === 'mixed';
    });
    const stressOnlyDimIds = RESILIENCE_DIMENSION_ORDER.filter((id) => RESILIENCE_DIMENSION_TYPES[id] === 'stress');

    assert.ok(baselineDimIds.length > 0, 'should have baseline dims');
    for (const id of stressOnlyDimIds) {
      assert.ok(!baselineDimIds.includes(id), `stress-only dimension ${id} should not appear in baseline set`);
    }
    assert.ok(baselineDimIds.includes('macroFiscal'), 'macroFiscal should be in baseline set');
    assert.ok(baselineDimIds.includes('infrastructure'), 'infrastructure should be in baseline set');
    assert.ok(baselineDimIds.includes('logisticsSupply'), 'mixed logisticsSupply should be in baseline set');
  });

  it('stressScore is computed from stress + mixed dimensions only', async () => {
    installRedis(RESILIENCE_FIXTURES);
    const scoreMap = await scoreAllDimensions('US');

    const stressDimIds = RESILIENCE_DIMENSION_ORDER.filter((id) => {
      const t = RESILIENCE_DIMENSION_TYPES[id];
      return t === 'stress' || t === 'mixed';
    });
    const baselineOnlyDimIds = RESILIENCE_DIMENSION_ORDER.filter((id) => RESILIENCE_DIMENSION_TYPES[id] === 'baseline');

    assert.ok(stressDimIds.length > 0, 'should have stress dims');
    for (const id of baselineOnlyDimIds) {
      assert.ok(!stressDimIds.includes(id), `baseline-only dimension ${id} should not appear in stress set`);
    }
    assert.ok(stressDimIds.includes('currencyExternal'), 'currencyExternal should be in stress set');
    assert.ok(stressDimIds.includes('borderSecurity'), 'borderSecurity should be in stress set');
    assert.ok(stressDimIds.includes('energy'), 'mixed energy should be in stress set');
  });

  it('stressFactor is still computed (informational) and clamped to [0, 0.5]', () => {
    assert.equal(getResilienceStressFactor(100), 0, 'perfect stress score = zero factor');
    assert.equal(getResilienceStressFactor(0), 0.5, 'zero stress score = max factor 0.5');
    assert.equal(getResilienceStressFactor(50), 0.5, 'stress 50 = clamped to 0.5');
    assert.ok(getResilienceStressFactor(70) >= 0 && getResilienceStressFactor(70) <= 0.5, 'stress 70 within bounds');
    assert.ok(getResilienceStressFactor(110) >= 0, 'stress above 100 still clamped');
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

describe('scoreTradePolicy WB tariff rate', () => {
  it('WB tariff rate contributes to trade score', async () => {
    installRedis(RESILIENCE_FIXTURES);
    const result = await scoreTradePolicy('US');
    assert.ok(result.score >= 0 && result.score <= 100, `score out of bounds: ${result.score}`);
    assert.ok(result.coverage > 0, 'coverage should be > 0 when tariff data is present');
  });

  it('high tariff rate country scores lower than low tariff rate', async () => {
    installRedis(RESILIENCE_FIXTURES);
    const noResult = await scoreTradePolicy('NO');
    const yeResult = await scoreTradePolicy('YE');
    assert.ok(noResult.score > yeResult.score, `NO (${noResult.score}) should score higher than YE (${yeResult.score}) due to lower tariff rate`);
  });
});
