import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  RESILIENCE_DIMENSION_DOMAINS,
  RESILIENCE_DIMENSION_ORDER,
  RESILIENCE_DIMENSION_SCORERS,
  RESILIENCE_DIMENSION_TYPES,
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
    // PR 3 §3.5: fuelStockDays removed from this set — scoreFuelStockDays
    // now returns coverage=0 + imputationClass=null for every country
    // (retired), so it passes the default coverage=0 assertion below
    // instead of the T1.7 fall-through assertion. The `null` tag (rather
    // than 'source-failure') reflects the intentional retirement — see
    // the widget `formatDimensionConfidence` absent-path which would
    // otherwise surface a false "Source down" label on every country.
    const coverageZeroExempt = new Set([
      'currencyExternal',
      'fiscalSpace', 'reserveAdequacy', 'externalDebtCoverage',
      'importConcentration', 'stateContinuity',
    ]);
    for (const [dimensionId, scorer] of Object.entries(RESILIENCE_DIMENSION_SCORERS)) {
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

    // PR 3 §3.5: economic 68.33 → 66.33 after currencyExternal rebuild.
    // Recovery 54.83 → 47.33 after externalDebtCoverage goalpost was
    // tightened from (0..5) to (0..2) per §3.5 point 3 (US ratio=1.5
    // now scores 25 instead of 70).
    assert.deepEqual(domainAverages, {
      economic: 66.33,
      infrastructure: 79,
      energy: 80,
      'social-governance': 61.75,
      'health-food': 60.5,
      recovery: 47.33,
    });

    function round(v: number, d = 2) { return Number(v.toFixed(d)); }
    function coverageWeightedMean(dims: { score: number; coverage: number }[]) {
      const totalCov = dims.reduce((s, d) => s + d.coverage, 0);
      if (!totalCov) return 0;
      return dims.reduce((s, d) => s + d.score * d.coverage, 0) / totalCov;
    }

    const dimensions = RESILIENCE_DIMENSION_ORDER.map((id) => ({
      id,
      score: round(scoreMap[id].score),
      coverage: round(scoreMap[id].coverage),
    }));
    const baselineDims = dimensions.filter((d) => {
      const t = RESILIENCE_DIMENSION_TYPES[d.id as keyof typeof RESILIENCE_DIMENSION_TYPES];
      return t === 'baseline' || t === 'mixed';
    });
    const stressDims = dimensions.filter((d) => {
      const t = RESILIENCE_DIMENSION_TYPES[d.id as keyof typeof RESILIENCE_DIMENSION_TYPES];
      return t === 'stress' || t === 'mixed';
    });

    const baselineScore = round(coverageWeightedMean(baselineDims));
    const stressScore = round(coverageWeightedMean(stressDims));
    const stressFactor = round(Math.max(0, Math.min(1 - stressScore / 100, 0.5)), 4);

    // PR 3 §3.5: 62.64 → 63.63 (fuelStockDays retirement) → 60.12
    // (externalDebtCoverage goalpost tightened; US score drops from 70
    // to 25, pulling the coverage-weighted baseline mean down).
    assert.equal(baselineScore, 60.12);
    // PR 3 §3.5: 65.84 → 67.85 (fuelStockDays retirement) → 67.21
    // (currencyExternal rebuilt on IMF inflation + WB reserves, coverage
    // shifts and US stress score moves). stressFactor updates in lockstep:
    //   1 - 67.21/100 = 0.3279, clamped to 0.5.
    assert.equal(stressScore, 67.21);
    assert.equal(stressFactor, 0.3279);

    const overallScore = round(
      RESILIENCE_DOMAIN_ORDER.map((domainId) => {
        const dimScores = RESILIENCE_DIMENSION_ORDER
          .filter((id) => RESILIENCE_DIMENSION_DOMAINS[id] === domainId)
          .map((id) => ({ score: round(scoreMap[id].score), coverage: round(scoreMap[id].coverage) }));
        const totalCov = dimScores.reduce((sum, d) => sum + d.coverage, 0);
        const cwMean = totalCov ? dimScores.reduce((sum, d) => sum + d.score * d.coverage, 0) / totalCov : 0;
        return round(cwMean) * getResilienceDomainWeight(domainId);
      }).reduce((sum, v) => sum + v, 0),
    );
    // PR 3 §3.5: 65.57 → 65.82 (fuelStockDays retirement) → 65.52
    // (currencyExternal rebuild) → 63.27 (externalDebtCoverage goalpost
    // tightened 0..5 → 0..2; US recovery-domain contribution drops).
    assert.equal(overallScore, 63.27);
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

  it('overallScore = sum(domainScore * domainWeight)', async () => {
    installRedis(RESILIENCE_FIXTURES);
    const scoreMap = await scoreAllDimensions('US');
    function round(v: number, d = 2) { return Number(v.toFixed(d)); }
    function coverageWeightedMean(dims: { score: number; coverage: number }[]) {
      const totalCov = dims.reduce((s, d) => s + d.coverage, 0);
      if (!totalCov) return 0;
      return dims.reduce((s, d) => s + d.score * d.coverage, 0) / totalCov;
    }

    const dimensions = RESILIENCE_DIMENSION_ORDER.map((id) => ({
      id, score: round(scoreMap[id].score), coverage: round(scoreMap[id].coverage),
    }));

    const grouped = new Map<string, typeof dimensions>();
    for (const domainId of RESILIENCE_DOMAIN_ORDER) grouped.set(domainId, []);
    for (const dim of dimensions) {
      const domainId = RESILIENCE_DIMENSION_DOMAINS[dim.id as keyof typeof RESILIENCE_DIMENSION_DOMAINS];
      grouped.get(domainId)?.push(dim);
    }

    const expected = round(
      RESILIENCE_DOMAIN_ORDER.reduce((sum, domainId) => {
        const domainDims = grouped.get(domainId) ?? [];
        const domainScore = round(coverageWeightedMean(domainDims));
        return sum + domainScore * getResilienceDomainWeight(domainId);
      }, 0),
    );

    assert.ok(expected > 0, 'overall should be positive');
    // PR 3 §3.5: 65.82 → 65.52 (currencyExternal rebuild) → 63.27 after
    // externalDebtCoverage goalpost tightened from (0..5) to (0..2).
    assert.equal(expected, 63.27, 'overallScore should match sum(domainScore * domainWeight); 65.52 → 63.27 after PR 3 §3.5 externalDebtCoverage re-goalpost');
  });

  it('stressFactor is still computed (informational) and clamped to [0, 0.5]', () => {
    function clampStressFactor(stressScore: number) {
      return Math.max(0, Math.min(1 - stressScore / 100, 0.5));
    }
    assert.equal(clampStressFactor(100), 0, 'perfect stress score = zero factor');
    assert.equal(clampStressFactor(0), 0.5, 'zero stress score = max factor 0.5');
    assert.equal(clampStressFactor(50), 0.5, 'stress 50 = clamped to 0.5');
    assert.ok(clampStressFactor(70) >= 0 && clampStressFactor(70) <= 0.5, 'stress 70 within bounds');
    assert.ok(clampStressFactor(110) >= 0, 'stress above 100 still clamped');
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
