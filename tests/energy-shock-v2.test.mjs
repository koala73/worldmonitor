/**
 * Tests for shock model v2 contract additions:
 * - deriveCoverageLevel, deriveChokepointConfidence
 * - buildAssessment with unsupported / partial / degraded branches
 * - Integration-level mock tests for coverage flags and limitations
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import reporterOverrides from '../scripts/shared/comtrade-reporter-overrides.json' with { type: 'json' };

import {
  deriveCoverageLevel,
  deriveChokepointConfidence,
  buildAssessment,
  computeGulfShare,
  CHOKEPOINT_EXPOSURE,
  parseFuelMode,
  CHOKEPOINT_LNG_EXPOSURE,
  EU_GAS_STORAGE_COUNTRIES,
  computeGasDisruption,
  computeGasBufferDays,
  buildGasAssessment,
  REFINERY_YIELD,
  REFINERY_YIELD_BASIS,
} from '../server/worldmonitor/intelligence/v1/_shock-compute.js';
import { computeEnergyShockScenario } from '../server/worldmonitor/intelligence/v1/compute-energy-shock.ts';
import { installRedis } from './helpers/fake-upstash-redis.mts';

import { ISO2_TO_COMTRADE } from '../server/worldmonitor/intelligence/v1/_comtrade-reporters.js';

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_REDIS_ENV = {
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
  vercelEnv: process.env.VERCEL_ENV,
  localApiMode: process.env.LOCAL_API_MODE,
};
function restoreEnergyShockEnvironment() {
  globalThis.fetch = ORIGINAL_FETCH;
  for (const [name, value] of [
    ['UPSTASH_REDIS_REST_URL', ORIGINAL_REDIS_ENV.url],
    ['UPSTASH_REDIS_REST_TOKEN', ORIGINAL_REDIS_ENV.token],
    ['VERCEL_ENV', ORIGINAL_REDIS_ENV.vercelEnv],
    ['LOCAL_API_MODE', ORIGINAL_REDIS_ENV.localApiMode],
  ]) {
    if (value == null) delete process.env[name];
    else process.env[name] = value;
  }
}

function installEnergyShockRedis(seed = {}) {
  const { redis } = installRedis(seed);
  delete process.env.LOCAL_API_MODE;

  return {
    set(key, value) {
      redis.set(key, JSON.stringify(value));
    },
    delete(key) {
      redis.delete(key);
    },
  };
}

function liveChokepointSeed(flowRatio = 1) {
  return {
    'energy:chokepoint-flows:v1': {
      hormuz_strait: { flowRatio },
      malacca_strait: { flowRatio },
    },
  };
}

const US_OIL_SEED = {
  'energy:jodi-oil:v1:US': {
    crude: { importsKbd: 100 },
    gasoline: { demandKbd: 80 },
    diesel: { demandKbd: 60 },
  },
  'energy:iea-oil-stocks:v1:US': {
    daysOfCover: 90,
    netExporter: false,
    anomaly: false,
  },
  'comtrade:flows:842:2709': [
    { reporterCode: '842', partnerCode: '682', cmdCode: '2709', tradeValueUsd: 100, year: 2025 },
  ],
};

const US_GAS_SEED = {
  'energy:jodi-gas:v1:US': {
    lngImportsTj: 1_000,
    pipeImportsTj: 200,
    totalDemandTj: 5_000,
    lngShareOfImports: 0.8,
  },
};

async function computeShock(request) {
  return computeEnergyShockScenario({}, request);
}

// ---------------------------------------------------------------------------
// deriveCoverageLevel
// ---------------------------------------------------------------------------

describe('deriveCoverageLevel', () => {
  it('returns "unsupported" when jodiOil is false regardless of comtrade', () => {
    assert.equal(deriveCoverageLevel(false, false), 'unsupported');
    assert.equal(deriveCoverageLevel(false, true), 'unsupported');
  });

  it('returns "partial" when jodiOil is true but comtrade is false', () => {
    assert.equal(deriveCoverageLevel(true, false), 'partial');
  });

  it('returns "full" when both jodiOil and comtrade are true', () => {
    assert.equal(deriveCoverageLevel(true, true), 'full');
  });
});

// ---------------------------------------------------------------------------
// deriveChokepointConfidence
// ---------------------------------------------------------------------------

describe('deriveChokepointConfidence', () => {
  it('returns "none" when degraded is true regardless of liveFlowRatio', () => {
    assert.equal(deriveChokepointConfidence(0.9, true), 'none');
    assert.equal(deriveChokepointConfidence(null, true), 'none');
  });

  it('returns "none" when liveFlowRatio is null and not degraded', () => {
    assert.equal(deriveChokepointConfidence(null, false), 'none');
  });

  it('returns "high" when liveFlowRatio is present and not degraded', () => {
    assert.equal(deriveChokepointConfidence(0.9, false), 'high');
    assert.equal(deriveChokepointConfidence(1.0, false), 'high');
    assert.equal(deriveChokepointConfidence(0.0, false), 'high');
  });
});

// ---------------------------------------------------------------------------
// buildAssessment — unsupported country
// ---------------------------------------------------------------------------

describe('buildAssessment — unsupported country', () => {
  it('returns structured insufficient data message for unsupported country', () => {
    const msg = buildAssessment('ZZ', 'hormuz', false, 0, 0, 0, 50, [], 'unsupported', false);
    assert.ok(msg.includes('Insufficient import data'));
    // ZZ resolves to "Unknown Region" via Intl.DisplayNames; hormuz falls back to "hormuz" (no underscore)
    assert.ok(msg.includes('Unknown Region') || msg.includes('ZZ'));
    assert.ok(msg.includes('hormuz'));
  });

  it('unsupported message is returned even if dataAvailable is true but coverageLevel is unsupported', () => {
    const msg = buildAssessment('ZZ', 'hormuz', true, 0.5, 60, 30, 50, [], 'unsupported', false);
    assert.ok(msg.includes('Insufficient import data'));
  });

  it('dataAvailable=false without coverageLevel also returns insufficient data message', () => {
    const msg = buildAssessment('XY', 'suez', false, 0, 0, 0, 50, []);
    assert.ok(msg.includes('Insufficient import data'));
  });
});

// ---------------------------------------------------------------------------
// buildAssessment — partial coverage
// ---------------------------------------------------------------------------

describe('buildAssessment — partial coverage', () => {
  it('includes proxy note when partial due to missing comtrade', () => {
    const products = [
      { product: 'Diesel', deficitPct: 20.0 },
      { product: 'Jet fuel', deficitPct: 15.0 },
    ];
    const msg = buildAssessment('XX', 'hormuz', true, 0.4, 60, 30, 50, products, 'partial', false, true, false);
    assert.ok(msg.includes('20.0%'));
    assert.ok(msg.includes('Gulf share proxied'));
  });

  it('does not include proxy note in full coverage branch', () => {
    const products = [
      { product: 'Diesel', deficitPct: 20.0 },
      { product: 'Jet fuel', deficitPct: 15.0 },
    ];
    const msg = buildAssessment('IN', 'hormuz', true, 0.4, 60, 30, 50, products, 'full', false, true, true);
    assert.ok(!msg.includes('proxied'));
  });
});

// ---------------------------------------------------------------------------
// buildAssessment — degraded mode
// ---------------------------------------------------------------------------

describe('buildAssessment — degraded mode', () => {
  it('includes degraded note in cover-days branch when degraded=true', () => {
    const msg = buildAssessment('US', 'hormuz', true, 0.4, 180, 90, 50, [], 'full', true);
    assert.ok(msg.includes('live flow data unavailable'));
  });

  it('does not include degraded note when degraded=false', () => {
    const msg = buildAssessment('US', 'hormuz', true, 0.4, 180, 90, 50, [], 'full', false);
    assert.ok(!msg.includes('live flow data unavailable'));
  });

  it('net-exporter branch does not include degraded note (takes priority)', () => {
    const msg = buildAssessment('SA', 'hormuz', true, 0.8, -1, 0, 50, [], 'full', true);
    assert.ok(msg.includes('net oil exporter'));
    assert.ok(!msg.includes('live flow data unavailable'));
  });
});

// ---------------------------------------------------------------------------
// Mock test: PortWatch absent → degraded=true, liveFlowRatio=0, fallback to CHOKEPOINT_EXPOSURE
// ---------------------------------------------------------------------------

describe('mock: degraded mode falls back to CHOKEPOINT_EXPOSURE', () => {
  it('CHOKEPOINT_EXPOSURE values are used as fallback when portwatch absent', () => {
    const chokepointId = 'hormuz_strait';
    const degraded = true;
    const liveFlowRatio = null;

    const baseExposure = CHOKEPOINT_EXPOSURE[chokepointId] ?? 1.0;
    const exposureMult = liveFlowRatio !== null ? baseExposure * liveFlowRatio : baseExposure;
    assert.equal(exposureMult, 1.0);

    const confidence = deriveChokepointConfidence(liveFlowRatio, degraded);
    assert.equal(confidence, 'none');

    const computedLiveFlowRatioInResponse = liveFlowRatio !== null ? liveFlowRatio : undefined;
    assert.equal(computedLiveFlowRatioInResponse, undefined, 'liveFlowRatio should be absent (undefined) when PortWatch unavailable, not 0');
  });

  it('suez uses CHOKEPOINT_EXPOSURE[suez]=0.6 when portwatch absent', () => {
    const exposureMult = CHOKEPOINT_EXPOSURE['suez'] ?? 1.0;
    assert.equal(exposureMult, 0.6);
  });

  it('malacca uses CHOKEPOINT_EXPOSURE[malacca_strait]=0.7 when portwatch absent', () => {
    const exposureMult = CHOKEPOINT_EXPOSURE['malacca_strait'] ?? 1.0;
    assert.equal(exposureMult, 0.7);
  });
});

// ---------------------------------------------------------------------------
// Mock test: partial coverage → limitations includes proxy string
// ---------------------------------------------------------------------------

describe('mock: partial coverage limitations', () => {
  it('partial coverage level triggers Gulf share proxy limitation', () => {
    const jodiOilCoverage = true;
    const comtradeCoverage = false;
    const coverageLevel = deriveCoverageLevel(jodiOilCoverage, comtradeCoverage);
    assert.equal(coverageLevel, 'partial');

    const limitations = [];
    if (coverageLevel === 'partial') {
      limitations.push('Gulf crude share proxied at 40% (no Comtrade data)');
    }
    limitations.push(REFINERY_YIELD_BASIS);

    assert.ok(limitations.some((l) => l.includes('proxied at 40%')));
    assert.ok(limitations.some((l) => l.includes('refinery yield')));
  });

  it('full coverage does not add proxy limitation', () => {
    const coverageLevel = deriveCoverageLevel(true, true);
    const limitations = [];
    if (coverageLevel === 'partial') {
      limitations.push('Gulf crude share proxied at 40% (no Comtrade data)');
    }
    limitations.push(REFINERY_YIELD_BASIS);
    assert.ok(!limitations.some((l) => l.includes('proxied at 40%')));
  });
});

// ---------------------------------------------------------------------------
// Mock test: full coverage with live data → confidence='high', liveFlowRatio set
// ---------------------------------------------------------------------------

describe('mock: full coverage with live PortWatch data', () => {
  it('chokepointConfidence is high when liveFlowRatio present and not degraded', () => {
    const liveFlowRatio = 0.9;
    const degraded = false;
    const confidence = deriveChokepointConfidence(liveFlowRatio, degraded);
    assert.equal(confidence, 'high');
  });

  it('live flow ratio composes with CHOKEPOINT_EXPOSURE multiplier', () => {
    const chokepointId = 'suez';
    const liveFlowRatio = 0.85;
    const baseExposure = CHOKEPOINT_EXPOSURE[chokepointId]; // 0.6
    const exposureMult = liveFlowRatio !== null ? baseExposure * liveFlowRatio : baseExposure;
    assert.equal(Math.round(exposureMult * 1000) / 1000, 0.51);
  });

  it('full coverage returns "full" level with both jodiOil and comtrade true', () => {
    const level = deriveCoverageLevel(true, true);
    assert.equal(level, 'full');
  });
});

// ---------------------------------------------------------------------------
// ISO2_TO_COMTRADE completeness
// ---------------------------------------------------------------------------

describe('ISO2_TO_COMTRADE completeness', () => {
  const REQUIRED = ['US', 'CN', 'RU', 'IR', 'IN', 'TW', 'DE', 'FR', 'GB', 'IT',
    'JP', 'KR', 'SA', 'AE', 'TR', 'BR', 'AU', 'CA', 'MX', 'ID',
    'TH', 'MY', 'SG', 'PL', 'NL', 'BE', 'ES', 'PT', 'GR', 'SE',
    'NO', 'FI', 'DK', 'CH', 'AT', 'CZ', 'HU', 'RO', 'UA', 'EG',
    'ZA', 'NG', 'KE', 'MA', 'DZ', 'IQ', 'KW', 'QA', 'VN', 'PH',
    'PK', 'BD', 'NZ', 'CL', 'AR', 'CO', 'PE', 'VE', 'BO'];

  it('contains all 6 originally seeded Comtrade reporters', () => {
    for (const code of ['US', 'CN', 'RU', 'IR', 'IN', 'TW']) {
      assert.ok(code in ISO2_TO_COMTRADE, `Missing originally seeded reporter: ${code}`);
    }
  });

  it('contains all required major economies', () => {
    for (const code of REQUIRED) {
      assert.ok(code in ISO2_TO_COMTRADE, `Missing required country: ${code}`);
    }
  });

  it('has more than 50 entries', () => {
    assert.ok(Object.keys(ISO2_TO_COMTRADE).length > 50, `Expected >50 entries, got ${Object.keys(ISO2_TO_COMTRADE).length}`);
  });

  it('all values are numeric strings', () => {
    for (const [iso2, code] of Object.entries(ISO2_TO_COMTRADE)) {
      assert.ok(/^\d{3}$/.test(code), `${iso2} has non-3-digit code: ${code}`);
    }
  });

  it('applies every shared non-M49 reporter override', () => {
    for (const [iso2, code] of Object.entries(reporterOverrides)) {
      assert.equal(ISO2_TO_COMTRADE[iso2], code, `${iso2} must resolve through shared Comtrade override metadata`);
    }
  });

  it('US maps to 842', () => assert.equal(ISO2_TO_COMTRADE['US'], '842'));
  it('CN maps to 156', () => assert.equal(ISO2_TO_COMTRADE['CN'], '156'));
  it('DE maps to 276', () => assert.equal(ISO2_TO_COMTRADE['DE'], '276'));
  it('JP maps to 392', () => assert.equal(ISO2_TO_COMTRADE['JP'], '392'));
});

// ---------------------------------------------------------------------------
// NaN/Infinity guard — deriveChokepointConfidence
// ---------------------------------------------------------------------------

describe('deriveChokepointConfidence guards NaN and Infinity', () => {
  it('returns "none" for NaN flowRatio', () => {
    assert.equal(deriveChokepointConfidence(NaN, false), 'none');
  });

  it('returns "none" for Infinity flowRatio', () => {
    assert.equal(deriveChokepointConfidence(Infinity, false), 'none');
  });

  it('returns "none" for -Infinity flowRatio', () => {
    assert.equal(deriveChokepointConfidence(-Infinity, false), 'none');
  });

  it('returns "high" for a finite positive flowRatio with degraded=false', () => {
    assert.equal(deriveChokepointConfidence(0.85, false), 'high');
  });

  it('returns "high" for flowRatio=0 with degraded=false (true 0 flow is valid)', () => {
    assert.equal(deriveChokepointConfidence(0, false), 'high');
  });
});

// ---------------------------------------------------------------------------
// deriveCoverageLevel — IEA and degraded inputs
// ---------------------------------------------------------------------------

describe('deriveCoverageLevel accounts for IEA and degraded state', () => {
  it('returns "full" only when all inputs are good', () => {
    assert.equal(deriveCoverageLevel(true, true, true, false), 'full');
  });

  it('returns "partial" when ieaStocksCoverage is false (even with JODI+Comtrade)', () => {
    assert.equal(deriveCoverageLevel(true, true, false, false), 'partial');
  });

  it('returns "partial" when degraded=true (even with JODI+Comtrade+IEA)', () => {
    assert.equal(deriveCoverageLevel(true, true, true, true), 'partial');
  });

  it('returns "partial" when comtrade is false regardless of IEA/degraded', () => {
    assert.equal(deriveCoverageLevel(true, false, true, false), 'partial');
  });

  it('returns "unsupported" when jodiOil is false', () => {
    assert.equal(deriveCoverageLevel(false, true, true, false), 'unsupported');
  });

  it('backward-compatible: two-arg call without IEA/degraded still works', () => {
    // ieaStocksCoverage=undefined → !undefined=true → passes; degraded=undefined → falsy → passes
    assert.equal(deriveCoverageLevel(true, true), 'full');
    assert.equal(deriveCoverageLevel(true, false), 'partial');
    assert.equal(deriveCoverageLevel(false, true), 'unsupported');
  });
});

// ---------------------------------------------------------------------------
// Production response construction
// ---------------------------------------------------------------------------

describe('computeEnergyShockScenario response construction', () => {
  it('distinguishes a missing PortWatch ratio from a real zero-flow ratio', async (t) => {
    t.after(restoreEnergyShockEnvironment);
    const redis = installEnergyShockRedis();

    const missing = await computeShock({
      countryCode: 'US', chokepointId: 'hormuz_strait', disruptionPct: 40, fuelMode: 'oil',
    });
    assert.equal(missing.portwatchCoverage, false);
    assert.equal(missing.liveFlowRatio, undefined, 'missing PortWatch data must omit liveFlowRatio');

    redis.set('energy:chokepoint-flows:v1', { hormuz_strait: { flowRatio: 0 } });
    const zero = await computeShock({
      countryCode: 'US', chokepointId: 'hormuz_strait', disruptionPct: 41, fuelMode: 'oil',
    });
    assert.equal(zero.portwatchCoverage, true);
    assert.equal(zero.liveFlowRatio, 0, 'a real zero-flow ratio must remain distinct from missing data');

    redis.set('energy:chokepoint-flows:v1', { hormuz_strait: { flowRatio: -0.5 } });
    const clampedLow = await computeShock({
      countryCode: 'US', chokepointId: 'hormuz_strait', disruptionPct: 42, fuelMode: 'oil',
    });
    assert.equal(clampedLow.liveFlowRatio, 0, 'negative ratios must clamp to zero');

    redis.set('energy:chokepoint-flows:v1', { hormuz_strait: { flowRatio: 3 } });
    const clampedHigh = await computeShock({
      countryCode: 'US', chokepointId: 'hormuz_strait', disruptionPct: 43, fuelMode: 'oil',
    });
    assert.equal(clampedHigh.liveFlowRatio, 1.5, 'oversized ratios must clamp to 1.5');
  });

  it('derives IEA stock coverage from the production response path', async (t) => {
    t.after(restoreEnergyShockEnvironment);
    const redis = installEnergyShockRedis({ ...liveChokepointSeed(), ...US_OIL_SEED });

    redis.set('energy:iea-oil-stocks:v1:US', { daysOfCover: null, netExporter: false, anomaly: false });
    const missing = await computeShock({
      countryCode: 'US', chokepointId: 'hormuz_strait', disruptionPct: 20, fuelMode: 'oil',
    });
    assert.equal(missing.ieaStocksCoverage, false, 'a non-exporter needs finite, non-negative cover days');

    redis.set('energy:iea-oil-stocks:v1:US', { daysOfCover: 0, netExporter: false, anomaly: false });
    const exhausted = await computeShock({
      countryCode: 'US', chokepointId: 'hormuz_strait', disruptionPct: 21, fuelMode: 'oil',
    });
    assert.equal(exhausted.ieaStocksCoverage, true, 'zero cover days is valid observed data');

    redis.set('energy:iea-oil-stocks:v1:US', { daysOfCover: -1, netExporter: false, anomaly: false });
    const invalid = await computeShock({
      countryCode: 'US', chokepointId: 'hormuz_strait', disruptionPct: 22, fuelMode: 'oil',
    });
    assert.equal(invalid.ieaStocksCoverage, false, 'negative cover days must not count as coverage');

    redis.set('energy:iea-oil-stocks:v1:US', { daysOfCover: 90, netExporter: false, anomaly: true });
    const anomalous = await computeShock({
      countryCode: 'US', chokepointId: 'hormuz_strait', disruptionPct: 24, fuelMode: 'oil',
    });
    assert.equal(anomalous.ieaStocksCoverage, false, 'anomalous positive cover days must not count as coverage');

    redis.set('energy:iea-oil-stocks:v1:US', { daysOfCover: null, netExporter: true, anomaly: false });
    const exporter = await computeShock({
      countryCode: 'US', chokepointId: 'hormuz_strait', disruptionPct: 23, fuelMode: 'oil',
    });
    assert.equal(exporter.ieaStocksCoverage, true, 'net exporters do not require cover days');
  });
});

// ---------------------------------------------------------------------------
// computeGulfShare — NaN/Infinity guard
// ---------------------------------------------------------------------------

describe('computeGulfShare rejects NaN and Infinity tradeValueUsd', () => {
  it('returns { share: 0, hasData: false } when flow has tradeValueUsd: NaN', () => {
    const flows = [{ tradeValueUsd: NaN, partnerCode: '682' }];
    const result = computeGulfShare(flows);
    assert.deepEqual(result, { share: 0, hasData: false });
  });

  it('returns { share: 0, hasData: false } when flow has tradeValueUsd: Infinity', () => {
    const flows = [{ tradeValueUsd: Infinity, partnerCode: '682' }];
    const result = computeGulfShare(flows);
    assert.deepEqual(result, { share: 0, hasData: false });
  });

  it('returns { share: 0, hasData: false } when flow has tradeValueUsd: -Infinity', () => {
    const flows = [{ tradeValueUsd: -Infinity, partnerCode: '682' }];
    const result = computeGulfShare(flows);
    assert.deepEqual(result, { share: 0, hasData: false });
  });

  it('still computes correctly with valid finite values', () => {
    const flows = [
      { tradeValueUsd: 100, partnerCode: '682' },
      { tradeValueUsd: 100, partnerCode: '840' },
    ];
    const result = computeGulfShare(flows);
    assert.equal(result.hasData, true);
    assert.equal(result.share, 0.5);
  });

  it('skips NaN flows but computes from valid ones', () => {
    const flows = [
      { tradeValueUsd: NaN, partnerCode: '682' },
      { tradeValueUsd: 100, partnerCode: '682' },
      { tradeValueUsd: 100, partnerCode: '840' },
    ];
    const result = computeGulfShare(flows);
    assert.equal(result.hasData, true);
    assert.equal(result.share, 0.5);
  });
});

// ---------------------------------------------------------------------------
// buildAssessment — proxy text only when comtrade is missing
// ---------------------------------------------------------------------------

describe('buildAssessment proxy text is tied to comtradeCoverage, not coverageLevel', () => {
  const products = [
    { product: 'Diesel', deficitPct: 20.0 },
    { product: 'Jet fuel', deficitPct: 15.0 },
  ];

  it('shows proxy text when partial due to missing comtrade (comtradeCoverage=false)', () => {
    const msg = buildAssessment('XX', 'hormuz', true, 0.4, 60, 30, 50, products, 'partial', false, true, false);
    assert.ok(msg.includes('Gulf share proxied at 40%'), 'should mention proxy when comtrade missing');
  });

  it('does NOT show proxy text when partial due to IEA anomaly (comtradeCoverage=true)', () => {
    const msg = buildAssessment('XX', 'hormuz', true, 0.4, 60, 30, 50, products, 'partial', false, false, true);
    assert.ok(!msg.includes('proxied'), 'should not mention proxy when comtrade is present');
  });

  it('does NOT show proxy text when partial due to degraded PortWatch (comtradeCoverage=true)', () => {
    const msg = buildAssessment('XX', 'hormuz', true, 0.4, 60, 30, 50, products, 'partial', true, true, true);
    assert.ok(!msg.includes('proxied'), 'should not mention proxy when comtrade is present');
  });

  it('does NOT show proxy text when full coverage (comtradeCoverage=true)', () => {
    const msg = buildAssessment('IN', 'hormuz', true, 0.4, 60, 30, 50, products, 'full', false, true, true);
    assert.ok(!msg.includes('proxied'), 'should not mention proxy in full coverage');
  });
});

// ---------------------------------------------------------------------------
// cache key includes degraded state
// ---------------------------------------------------------------------------

describe('cache key includes degraded state and fuelMode', () => {
  it('does not reuse a live response after PortWatch degrades', async (t) => {
    t.after(restoreEnergyShockEnvironment);
    const redis = installEnergyShockRedis({ ...liveChokepointSeed(), ...US_OIL_SEED });

    const live = await computeShock({
      countryCode: 'US', chokepointId: 'hormuz_strait', disruptionPct: 50, fuelMode: 'oil',
    });
    assert.equal(live.degraded, false);

    redis.delete('energy:chokepoint-flows:v1');
    const degraded = await computeShock({
      countryCode: 'US', chokepointId: 'hormuz_strait', disruptionPct: 50, fuelMode: 'oil',
    });
    assert.equal(degraded.degraded, true, 'degraded and live requests must not share a cached response');
  });

  it('does not reuse an oil response for gas-only mode', async (t) => {
    t.after(restoreEnergyShockEnvironment);
    installEnergyShockRedis({ ...liveChokepointSeed(), ...US_OIL_SEED, ...US_GAS_SEED });

    const oil = await computeShock({
      countryCode: 'US', chokepointId: 'hormuz_strait', disruptionPct: 60, fuelMode: 'oil',
    });
    assert.ok(oil.products.length > 0);

    const gas = await computeShock({
      countryCode: 'US', chokepointId: 'hormuz_strait', disruptionPct: 60, fuelMode: 'gas',
    });
    assert.equal(gas.products.length, 0, 'gas-only mode must not receive the oil cache entry');
    assert.equal(gas.gasImpact?.dataAvailable, true);
  });
});

// ---------------------------------------------------------------------------
// parseFuelMode
// ---------------------------------------------------------------------------

describe('parseFuelMode', () => {
  it('defaults to "oil" for empty string', () => assert.equal(parseFuelMode(''), 'oil'));
  it('defaults to "oil" for null', () => assert.equal(parseFuelMode(null), 'oil'));
  it('defaults to "oil" for undefined', () => assert.equal(parseFuelMode(undefined), 'oil'));
  it('parses "gas"', () => assert.equal(parseFuelMode('gas'), 'gas'));
  it('parses "both"', () => assert.equal(parseFuelMode('both'), 'both'));
  it('parses "GAS" case-insensitive', () => assert.equal(parseFuelMode('GAS'), 'gas'));
  it('returns "oil" for invalid value', () => assert.equal(parseFuelMode('nuclear'), 'oil'));
});

// ---------------------------------------------------------------------------
// CHOKEPOINT_LNG_EXPOSURE
// ---------------------------------------------------------------------------

describe('CHOKEPOINT_LNG_EXPOSURE', () => {
  it('has all 4 chokepoints', () => {
    for (const cp of ['hormuz_strait', 'malacca_strait', 'suez', 'bab_el_mandeb']) {
      assert.ok(cp in CHOKEPOINT_LNG_EXPOSURE, `missing ${cp}`);
      assert.ok(CHOKEPOINT_LNG_EXPOSURE[cp] > 0 && CHOKEPOINT_LNG_EXPOSURE[cp] <= 1);
    }
  });
});

// ---------------------------------------------------------------------------
// EU_GAS_STORAGE_COUNTRIES
// ---------------------------------------------------------------------------

describe('EU_GAS_STORAGE_COUNTRIES', () => {
  it('includes DE, FR, IT', () => {
    for (const c of ['DE', 'FR', 'IT']) assert.ok(EU_GAS_STORAGE_COUNTRIES.has(c));
  });
  it('excludes JP, KR, TW', () => {
    for (const c of ['JP', 'KR', 'TW']) assert.ok(!EU_GAS_STORAGE_COUNTRIES.has(c));
  });
});

// ---------------------------------------------------------------------------
// computeGasDisruption
// ---------------------------------------------------------------------------

describe('computeGasDisruption', () => {
  it('computes hormuz LNG disruption correctly', () => {
    const { lngDisruptionTj, deficitPct } = computeGasDisruption(1000, 5000, 'hormuz_strait', 100);
    assert.equal(lngDisruptionTj, 300);
    assert.equal(deficitPct, 6);
  });

  it('computes malacca at 50% disruption', () => {
    const { lngDisruptionTj } = computeGasDisruption(2000, 10000, 'malacca_strait', 50);
    assert.equal(lngDisruptionTj, 500);
  });

  it('returns zero for zero lngImportsTj', () => {
    const { lngDisruptionTj, deficitPct } = computeGasDisruption(0, 5000, 'hormuz_strait', 100);
    assert.equal(lngDisruptionTj, 0);
    assert.equal(deficitPct, 0);
  });

  it('returns zero deficit for zero totalDemandTj', () => {
    const { deficitPct } = computeGasDisruption(1000, 0, 'hormuz_strait', 100);
    assert.equal(deficitPct, 0);
  });

  it('clamps deficit to 100%', () => {
    const { deficitPct } = computeGasDisruption(10000, 100, 'malacca_strait', 100);
    assert.equal(deficitPct, 100);
  });
});

// ---------------------------------------------------------------------------
// computeGasBufferDays
// ---------------------------------------------------------------------------

describe('computeGasBufferDays', () => {
  it('computes buffer from TWh and monthly disruption', () => {
    const days = computeGasBufferDays(10, 300);
    assert.equal(days, 3600);
  });

  it('returns 0 for zero disruption', () => {
    assert.equal(computeGasBufferDays(100, 0), 0);
  });

  it('returns 0 for zero storage', () => {
    assert.equal(computeGasBufferDays(0, 300), 0);
  });
});

// ---------------------------------------------------------------------------
// buildGasAssessment
// ---------------------------------------------------------------------------

describe('buildGasAssessment', () => {
  it('returns insufficient data message when not available', () => {
    const msg = buildGasAssessment('JP', 'hormuz', false, 0, 0, 0, 0, 50, false);
    assert.ok(msg.includes('Insufficient gas import data'));
  });

  it('returns low dependence for lngShare < 10%', () => {
    const msg = buildGasAssessment('US', 'hormuz', true, 100, 0.05, 1.0, 0, 50, false);
    assert.ok(msg.includes('low LNG dependence'));
  });

  it('returns buffer message for EU with >90 days', () => {
    const msg = buildGasAssessment('DE', 'hormuz', true, 500, 0.3, 5.0, 200, 50, true);
    assert.ok(msg.includes('200 days of gas storage buffer'));
  });

  it('returns deficit message for high exposure', () => {
    const msg = buildGasAssessment('JP', 'malacca', true, 1000, 0.9, 25.0, 0, 50, false);
    assert.ok(msg.includes('25.0% gas supply deficit'));
  });
});

// ---------------------------------------------------------------------------
// exposureMult composes baseExposure with liveFlowRatio
// ---------------------------------------------------------------------------

describe('exposureMult composes baseExposure with liveFlowRatio', () => {
  it('suez with flowRatio 0.85 yields 0.6 * 0.85 = 0.51', () => {
    const baseExposure = CHOKEPOINT_EXPOSURE['suez']; // 0.6
    const liveFlowRatio = 0.85;
    const exposureMult = baseExposure * liveFlowRatio;
    assert.equal(Math.round(exposureMult * 1000) / 1000, 0.51);
  });

  it('hormuz with flowRatio 1.0 yields 1.0 * 1.0 = 1.0', () => {
    const baseExposure = CHOKEPOINT_EXPOSURE['hormuz_strait'];
    const liveFlowRatio = 1.0;
    assert.equal(baseExposure * liveFlowRatio, 1.0);
  });

  it('malacca degraded uses baseExposure only (0.7)', () => {
    const baseExposure = CHOKEPOINT_EXPOSURE['malacca_strait'];
    const liveFlowRatio = null;
    const exposureMult = liveFlowRatio !== null ? baseExposure * liveFlowRatio : baseExposure;
    assert.equal(exposureMult, 0.7);
  });
});

// ---------------------------------------------------------------------------
// gasDataAvailable distinguishes zero-LNG from missing data
// ---------------------------------------------------------------------------

describe('gasDataAvailable distinguishes zero-LNG from missing data', () => {
  it('reports pipeline-only JODI gas as available through the production response', async (t) => {
    t.after(restoreEnergyShockEnvironment);
    installEnergyShockRedis({
      ...liveChokepointSeed(),
      'energy:jodi-gas:v1:US': { lngImportsTj: 0, totalDemandTj: 5_000, lngShareOfImports: 0 },
    });

    const response = await computeShock({
      countryCode: 'US', chokepointId: 'hormuz_strait', disruptionPct: 50, fuelMode: 'gas',
    });
    assert.equal(response.dataAvailable, true, 'an existing JODI gas record is available even with zero LNG');
    assert.equal(response.gasImpact?.dataAvailable, true);
    assert.match(response.assessment, /pipeline only/i);
  });

  it('reports missing JODI gas as unavailable through the production response', async (t) => {
    t.after(restoreEnergyShockEnvironment);
    installEnergyShockRedis(liveChokepointSeed());

    const response = await computeShock({
      countryCode: 'US', chokepointId: 'hormuz_strait', disruptionPct: 50, fuelMode: 'gas',
    });
    assert.equal(response.dataAvailable, false);
    assert.equal(response.gasImpact, undefined);
    assert.equal(response.coverageLevel, 'unsupported');
  });
});

// ---------------------------------------------------------------------------
// buildAssessment skips low-dependence dismissal when proxied
// ---------------------------------------------------------------------------

describe('buildAssessment skips low-dependence dismissal when proxied', () => {
  it('does NOT dismiss low gulfCrudeShare when comtradeCoverage is false (proxied)', () => {
    const products = [{ product: 'Diesel', deficitPct: 5.0 }];
    const msg = buildAssessment('XX', 'suez', true, 0.06, 60, 30, 50, products, 'partial', false, true, false);
    assert.ok(!msg.includes('low Gulf crude dependence'), 'should not dismiss when proxied');
    assert.ok(msg.includes('deficit') || msg.includes('disruption'), 'should show deficit info instead');
  });

  it('DOES dismiss low gulfCrudeShare when comtradeCoverage is true (measured)', () => {
    const products = [{ product: 'Diesel', deficitPct: 5.0 }];
    const msg = buildAssessment('XX', 'suez', true, 0.06, 60, 30, 50, products, 'full', false, true, true);
    assert.ok(msg.includes('low Gulf crude dependence'));
  });
});

// ---------------------------------------------------------------------------
// buildGasAssessment pipeline-only branch
// ---------------------------------------------------------------------------

describe('buildGasAssessment pipeline-only branch', () => {
  it('returns pipeline-only message for zero lngImportsTj', () => {
    const msg = buildGasAssessment('DE', 'hormuz', true, 0, 0, 0, 0, 50, false);
    assert.ok(msg.includes('pipeline only'));
  });

  it('returns insufficient data when dataAvailable=false', () => {
    const msg = buildGasAssessment('XX', 'hormuz', false, 0, 0, 0, 0, 50, false);
    assert.ok(msg.includes('Insufficient'));
  });
});

// ---------------------------------------------------------------------------
// grid-tightness limitation from Ember fossilShare
// ---------------------------------------------------------------------------

describe('grid-tightness limitation from Ember fossilShare', () => {
  it('appends the limitation from a high-fossil Ember record', async (t) => {
    t.after(restoreEnergyShockEnvironment);
    installEnergyShockRedis({
      ...liveChokepointSeed(),
      ...US_OIL_SEED,
      'energy:ember:v1:US': { fossilShare: 75.3 },
    });

    const response = await computeShock({
      countryCode: 'US', chokepointId: 'hormuz_strait', disruptionPct: 70, fuelMode: 'oil',
    });
    assert.ok(response.limitations.some((limitation) => limitation.includes('fossil grid dependency')));
  });

  it('does not append the limitation for a lower-fossil Ember record', async (t) => {
    t.after(restoreEnergyShockEnvironment);
    installEnergyShockRedis({
      ...liveChokepointSeed(),
      ...US_OIL_SEED,
      'energy:ember:v1:US': { fossilShare: 55 },
    });

    const response = await computeShock({
      countryCode: 'US', chokepointId: 'hormuz_strait', disruptionPct: 71, fuelMode: 'oil',
    });
    assert.ok(!response.limitations.some((limitation) => limitation.includes('fossil grid dependency')));
  });
});

// ---------------------------------------------------------------------------
// computeGasDisruption uses liveFlowRatio when available
// ---------------------------------------------------------------------------

describe('computeGasDisruption uses liveFlowRatio when available', () => {
  it('scales static exposure by liveFlowRatio', () => {
    const { lngDisruptionTj } = computeGasDisruption(1000, 5000, 'hormuz_strait', 100, 0.5);
    assert.equal(lngDisruptionTj, 150);
  });

  it('uses static exposure when liveFlowRatio is null (degraded)', () => {
    const { lngDisruptionTj } = computeGasDisruption(1000, 5000, 'hormuz_strait', 100, null);
    assert.equal(lngDisruptionTj, 300);
  });

  it('uses static exposure when liveFlowRatio is undefined', () => {
    const { lngDisruptionTj } = computeGasDisruption(1000, 5000, 'hormuz_strait', 100);
    assert.equal(lngDisruptionTj, 300);
  });
});

// ---------------------------------------------------------------------------
// gas-only mode coverage override
// ---------------------------------------------------------------------------

describe('gas-only mode response', () => {
  it('uses gas coverage and removes all oil-only response data', async (t) => {
    t.after(restoreEnergyShockEnvironment);
    installEnergyShockRedis({ ...liveChokepointSeed(), ...US_OIL_SEED, ...US_GAS_SEED });

    const response = await computeShock({
      countryCode: 'US', chokepointId: 'hormuz_strait', disruptionPct: 80, fuelMode: 'gas',
    });

    assert.equal(response.coverageLevel, 'full');
    assert.equal(response.dataAvailable, true);
    assert.equal(response.gasImpact?.dataAvailable, true);
    assert.deepEqual(response.products, []);
    assert.equal(response.gulfCrudeShare, 0);
    assert.equal(response.crudeLossKbd, 0);
    assert.equal(response.effectiveCoverDays, 0);
    assert.equal(response.jodiOilCoverage, false);
    assert.equal(response.comtradeCoverage, false);
    assert.equal(response.ieaStocksCoverage, false);
    assert.ok(response.limitations.some((limitation) => limitation.includes('LNG chokepoint exposure')));
    assert.ok(!response.limitations.some((limitation) => limitation.includes('refinery yield')));
    assert.ok(!response.limitations.some((limitation) => limitation.includes('Gulf crude share')));
    assert.ok(!response.limitations.some((limitation) => limitation.includes('IEA strategic stock')));
  });

  it('marks a valid degraded gas-only response as partial', async (t) => {
    t.after(restoreEnergyShockEnvironment);
    installEnergyShockRedis(US_GAS_SEED);

    const response = await computeShock({
      countryCode: 'US', chokepointId: 'hormuz_strait', disruptionPct: 80, fuelMode: 'gas',
    });
    assert.equal(response.degraded, true);
    assert.equal(response.coverageLevel, 'partial');
  });
});

// ---------------------------------------------------------------------------
// REFINERY_YIELD coefficients
// ---------------------------------------------------------------------------

describe('REFINERY_YIELD coefficients', () => {
  it('has entries for all four products', () => {
    for (const p of ['Gasoline', 'Diesel', 'Jet fuel', 'LPG']) {
      assert.ok(p in REFINERY_YIELD, `missing ${p}`);
      assert.ok(REFINERY_YIELD[p] > 0 && REFINERY_YIELD[p] < 1, `${p} yield out of range`);
    }
  });

  it('yields sum to < 1.0 (crude has residuals)', () => {
    const total = Object.values(REFINERY_YIELD).reduce((s, v) => s + v, 0);
    assert.ok(total < 1.0, `total yield ${total} should be < 1.0`);
    assert.ok(total > 0.8, `total yield ${total} should be > 0.8 (sanity check)`);
  });

  it('gasoline has highest yield', () => {
    assert.ok(REFINERY_YIELD['Gasoline'] > REFINERY_YIELD['Diesel']);
    assert.ok(REFINERY_YIELD['Gasoline'] > REFINERY_YIELD['Jet fuel']);
    assert.ok(REFINERY_YIELD['Gasoline'] > REFINERY_YIELD['LPG']);
  });
});

// ---------------------------------------------------------------------------
// per-product deficit divergence with named yields
// ---------------------------------------------------------------------------

describe('per-product deficit with correct yield formula', () => {
  it('outputLossKbd = crudeLossKbd * yieldFactor (not demand * ratio * yield)', () => {
    const crudeLossKbd = 100;
    const gasolineLoss = crudeLossKbd * REFINERY_YIELD['Gasoline']; // 100 * 0.44 = 44
    const dieselLoss = crudeLossKbd * REFINERY_YIELD['Diesel'];     // 100 * 0.30 = 30
    assert.equal(gasolineLoss, 44);
    assert.equal(dieselLoss, 30);
  });

  it('deficit depends on demand, not on yield alone', () => {
    const crudeLossKbd = 100;
    const gasolineDemand = 500;
    const jetDemand = 20;
    const gasolineLoss = crudeLossKbd * REFINERY_YIELD['Gasoline']; // 44
    const jetLoss = crudeLossKbd * REFINERY_YIELD['Jet fuel'];       // 10
    const gasolineDeficit = (gasolineLoss / gasolineDemand) * 100;   // 8.8%
    const jetDeficit = (jetLoss / jetDemand) * 100;                  // 50%
    assert.ok(jetDeficit > gasolineDeficit, 'low-demand product has higher deficit even with lower yield');
  });
});

// ---------------------------------------------------------------------------
// REFINERY_YIELD_BASIS string
// ---------------------------------------------------------------------------

describe('REFINERY_YIELD_BASIS string', () => {
  it('mentions all four products with percentages', () => {
    assert.ok(REFINERY_YIELD_BASIS.includes('gasoline 44%'));
    assert.ok(REFINERY_YIELD_BASIS.includes('diesel 30%'));
    assert.ok(REFINERY_YIELD_BASIS.includes('jet 10%'));
    assert.ok(REFINERY_YIELD_BASIS.includes('LPG 5%'));
    assert.ok(REFINERY_YIELD_BASIS.includes('EIA'));
  });
});

// ---------------------------------------------------------------------------
// buildAssessment picks actual worst product
// ---------------------------------------------------------------------------

describe('buildAssessment picks actual worst product', () => {
  it('names gasoline when it has highest deficit', () => {
    const products = [
      { product: 'Gasoline', deficitPct: 25.0 },
      { product: 'Diesel', deficitPct: 15.0 },
      { product: 'Jet fuel', deficitPct: 10.0 },
    ];
    const msg = buildAssessment('US', 'hormuz', true, 0.4, 60, 30, 50, products, 'full', false, true, true);
    assert.ok(msg.includes('25.0% gasoline deficit'), `expected gasoline deficit in: ${msg}`);
  });

  it('names jet fuel when it has highest deficit', () => {
    const products = [
      { product: 'Gasoline', deficitPct: 5.0 },
      { product: 'Diesel', deficitPct: 8.0 },
      { product: 'Jet fuel', deficitPct: 40.0 },
    ];
    const msg = buildAssessment('JP', 'malacca', true, 0.5, 60, 30, 50, products, 'full', false, true, true);
    assert.ok(msg.includes('40.0% jet fuel deficit'), `expected jet fuel deficit in: ${msg}`);
  });
});
