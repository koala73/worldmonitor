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
  computeGulfShareFromPartners,
  GULF_PARTNER_ISO2,
  CHOKEPOINT_EXPOSURE,
  parseFuelMode,
  CHOKEPOINT_LNG_EXPOSURE,
  EU_GAS_STORAGE_COUNTRIES,
  computeGasDisruption,
  REFINERY_YIELD,
  REFINERY_YIELD_BASIS,
} from '../server/worldmonitor/intelligence/v1/_shock-compute.js';
import { computeEnergyShockScenario } from '../server/worldmonitor/intelligence/v1/compute-energy-shock.ts';
import { getCountryCostShock } from '../server/worldmonitor/supply-chain/v1/get-country-cost-shock.ts';
import { buildDecisionBrief } from '../src/utils/decision-brief.ts';
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

  it('returns "unsupported" when jodiOil is true but comtrade is false (a measured origin share is a required input)', () => {
    assert.equal(deriveCoverageLevel(true, false), 'unsupported');
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

  it('observed imports with an unsupported level name the missing origin share instead of modeling', () => {
    const msg = buildAssessment('ZZ', 'hormuz', true, 0.5, 60, 30, 50, [], 'unsupported', false);
    assert.ok(msg.includes('Crude import origin data is unavailable'), msg);
    assert.ok(msg.includes('not modeled'), msg);
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
  it('reports the oil exposure as not modeled when comtrade is missing, with no deficit figure and no proxy', () => {
    const products = [
      { product: 'Diesel', deficitPct: 20.0 },
      { product: 'Jet fuel', deficitPct: 15.0 },
    ];
    const msg = buildAssessment('XX', 'hormuz', true, 0.4, 60, 30, 50, products, 'partial', false, true, false);
    assert.ok(!msg.includes('20.0%'), msg);
    assert.ok(!msg.includes('proxied'), msg);
    assert.ok(msg.includes('origin data is unavailable') && msg.includes('not modeled'), msg);
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
// computeGulfShareFromPartners — partner-level HS 2709 rows from the bilateral seeder
// ---------------------------------------------------------------------------

describe('computeGulfShareFromPartners', () => {
  const partners = [
    { partnerCode: 682, partnerIso2: 'SA', value: 300 },
    { partnerCode: 634, partnerIso2: 'QA', value: 100 },
    { partnerCode: 512, partnerIso2: 'OM', value: 200 },
    { partnerCode: 842, partnerIso2: 'US', value: 400 },
  ];

  it('counts every Hormuz-interior exporter (Qatar included) and excludes Oman, over the reported World total', () => {
    const result = computeGulfShareFromPartners({ hs4: '2709', year: 2024, totalValue: 1000, partners, omittedCount: 0, omittedShare: 0 });
    assert.equal(result.hasData, true);
    assert.equal(result.share, 0.4);
    assert.equal(result.year, 2024);
    assert.equal(result.omittedShare, undefined);
    for (const iso2 of ['SA', 'AE', 'IQ', 'KW', 'IR', 'QA', 'BH']) assert.ok(GULF_PARTNER_ISO2.has(iso2), iso2);
    assert.ok(!GULF_PARTNER_ISO2.has('OM'));
  });

  it('matches on the numeric partner code when the ISO2 is absent', () => {
    const result = computeGulfShareFromPartners({ totalValue: 1000, partners: [{ partnerCode: 48, value: 250 }, { partnerCode: '842', value: 750 }] });
    assert.deepEqual(result, { share: 0.25, hasData: true, year: undefined, omittedShare: undefined });
  });

  it('surfaces the seeder\'s omitted share so the reader can bound the attribution gap', () => {
    const result = computeGulfShareFromPartners({ year: 2024, totalValue: 1000, partners, omittedCount: 8, omittedShare: 0.015 });
    assert.equal(result.omittedShare, 0.015);
  });

  for (const product of [undefined, null, {}, { totalValue: 0, partners }, { totalValue: NaN, partners }, { totalValue: 1000, partners: null }]) {
    it(`has no data for ${JSON.stringify(product)}`, () => {
      assert.deepEqual(computeGulfShareFromPartners(product), { share: 0, hasData: false });
    });
  }

  it('ignores non-positive and non-numeric partner values', () => {
    const result = computeGulfShareFromPartners({ totalValue: 1000, partners: [{ partnerIso2: 'SA', value: -5 }, { partnerIso2: 'AE', value: null }, { partnerIso2: 'KW', value: 100 }] });
    assert.equal(result.share, 0.1);
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

  it('returns "unsupported" when comtrade is false regardless of IEA/degraded (origin share is a required input)', () => {
    assert.equal(deriveCoverageLevel(true, false, true, false), 'unsupported');
    assert.equal(deriveCoverageLevel(true, false, false, true), 'unsupported');
  });

  it('returns "unsupported" when jodiOil is false', () => {
    assert.equal(deriveCoverageLevel(false, true, true, false), 'unsupported');
  });

  it('backward-compatible: two-arg call without IEA/degraded still works', () => {
    // ieaStocksCoverage=undefined → !undefined=true → passes; degraded=undefined → falsy → passes
    assert.equal(deriveCoverageLevel(true, true), 'full');
    assert.equal(deriveCoverageLevel(true, false), 'unsupported');
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

describe('buildAssessment not-modeled text is tied to comtradeCoverage, not coverageLevel', () => {
  const products = [
    { product: 'Diesel', deficitPct: 20.0 },
    { product: 'Jet fuel', deficitPct: 15.0 },
  ];
  const NOT_MODELED = /Crude import origin data is unavailable .* not modeled/;

  it('reports the exposure as not modeled when comtrade is missing (comtradeCoverage=false), never a proxy', () => {
    const msg = buildAssessment('XX', 'hormuz', true, 0.4, 60, 30, 50, products, 'partial', false, true, false);
    assert.match(msg, NOT_MODELED);
    assert.ok(!msg.includes('proxied') && !msg.includes('20.0%'), msg);
  });

  it('models normally when partial due to IEA anomaly (comtradeCoverage=true)', () => {
    const msg = buildAssessment('XX', 'hormuz', true, 0.4, 60, 30, 50, products, 'partial', false, false, true);
    assert.doesNotMatch(msg, NOT_MODELED);
    assert.ok(msg.includes('20.0%'), msg);
  });

  it('models normally when partial due to degraded PortWatch (comtradeCoverage=true)', () => {
    const msg = buildAssessment('XX', 'hormuz', true, 0.4, 60, 30, 50, products, 'partial', true, true, true);
    assert.doesNotMatch(msg, NOT_MODELED);
    assert.ok(msg.includes('live flow data unavailable'), msg);
  });

  it('models normally when full coverage (comtradeCoverage=true)', () => {
    const msg = buildAssessment('IN', 'hormuz', true, 0.4, 60, 30, 50, products, 'full', false, true, true);
    assert.doesNotMatch(msg, NOT_MODELED);
    assert.ok(!msg.includes('proxied'), msg);
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
    assert.equal(gas.gasSensitivity?.dataAvailable, true);
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

  it('suppresses gas sensitivity for zero totalDemandTj', () => {
    assert.equal(computeGasDisruption(1000, 0, 'hormuz_strait', 100), undefined);
  });

  it('preserves the loss-to-demand ratio when LNG imports exceed demand', () => {
    const { deficitPct } = computeGasDisruption(10000, 100, 'malacca_strait', 100);
    assert.equal(deficitPct, 5000);
  });
});

// ---------------------------------------------------------------------------
// exposureMult composes baseExposure with liveFlowRatio
// ---------------------------------------------------------------------------

describe('route exposure is the static chokepoint factor; the live flow ratio never scales it', () => {
  it('keeps the documented static factors', () => {
    assert.equal(CHOKEPOINT_EXPOSURE['hormuz_strait'], 1.0);
    assert.equal(CHOKEPOINT_EXPOSURE['bab_el_mandeb'], 1.0);
    assert.equal(CHOKEPOINT_EXPOSURE['suez'], 0.6);
    assert.equal(CHOKEPOINT_EXPOSURE['malacca_strait'], 0.7);
  });

  it('suez: measured share × 0.6 at any live flow ratio', async (t) => {
    t.after(restoreEnergyShockEnvironment);
    const request = { countryCode: 'US', chokepointId: 'suez', disruptionPct: 100, fuelMode: 'oil' };
    const seeds = { ...US_OIL_SEED, 'energy:chokepoint-flows:v1': { suez: { flowRatio: 0.85 } } };
    installEnergyShockRedis(seeds);
    const scaled = await computeShock(request);
    installEnergyShockRedis({ ...seeds, 'energy:chokepoint-flows:v1': { suez: { flowRatio: 1 } } });
    const full = await computeShock(request);
    assert.equal(scaled.liveFlowRatio, 0.85);
    assert.equal(scaled.gulfCrudeShare, 0.6, 'US_OIL_SEED is 100% Gulf; suez carries 60% of it');
    assert.equal(scaled.gulfCrudeShare, full.gulfCrudeShare);
    assert.equal(scaled.crudeLossKbd, full.crudeLossKbd);
    assert.equal(scaled.crudeLossKbd, 60);
  });

  it('malacca degraded uses the static factor only (0.7)', async (t) => {
    t.after(restoreEnergyShockEnvironment);
    installEnergyShockRedis(US_OIL_SEED);
    const response = await computeShock({ countryCode: 'US', chokepointId: 'malacca_strait', disruptionPct: 100, fuelMode: 'oil' });
    assert.equal(response.degraded, true);
    assert.equal(response.gulfCrudeShare, 0.7);
    assert.equal(response.crudeLossKbd, 70);
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
    assert.equal(response.gasSensitivity?.dataAvailable, true);
    assert.match(response.assessment, /recorded zero LNG imports/i);
  });

  it('reports missing JODI gas as unavailable through the production response', async (t) => {
    t.after(restoreEnergyShockEnvironment);
    installEnergyShockRedis(liveChokepointSeed());

    const response = await computeShock({
      countryCode: 'US', chokepointId: 'hormuz_strait', disruptionPct: 50, fuelMode: 'gas',
    });
    assert.equal(response.dataAvailable, false);
    assert.equal(response.gasSensitivity, undefined);
    assert.equal(response.coverageLevel, 'unsupported');
  });
});

// ---------------------------------------------------------------------------
// buildAssessment skips low-dependence dismissal when proxied
// ---------------------------------------------------------------------------

describe('buildAssessment skips low-dependence dismissal without a measured share', () => {
  it('does NOT dismiss low gulfCrudeShare when comtradeCoverage is false (nothing is modeled)', () => {
    const products = [{ product: 'Diesel', deficitPct: 5.0 }];
    const msg = buildAssessment('XX', 'suez', true, 0.06, 60, 30, 50, products, 'partial', false, true, false);
    assert.ok(!msg.includes('low Gulf crude dependence'), 'an unmeasured share cannot be called low');
    assert.ok(!msg.includes('deficit'), 'an unmeasured share cannot yield a deficit figure either');
    assert.ok(msg.includes('not modeled'), msg);
  });

  it('DOES dismiss low gulfCrudeShare when comtradeCoverage is true (measured)', () => {
    const products = [{ product: 'Diesel', deficitPct: 5.0 }];
    const msg = buildAssessment('XX', 'suez', true, 0.06, 60, 30, 50, products, 'full', false, true, true);
    assert.ok(msg.includes('low Gulf crude dependence'));
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
// gas-only mode coverage override
// ---------------------------------------------------------------------------

describe('gas-only mode response', () => {
  it('uses gas coverage and removes all oil-only response data', async (t) => {
    t.after(restoreEnergyShockEnvironment);
    installEnergyShockRedis({ ...liveChokepointSeed(), ...US_OIL_SEED, ...US_GAS_SEED });

    const response = await computeShock({
      countryCode: 'US', chokepointId: 'hormuz_strait', disruptionPct: 80, fuelMode: 'gas',
    });

    assert.equal(response.coverageLevel, 'partial');
    assert.equal(response.dataAvailable, true);
    assert.equal(response.gasSensitivity?.dataAvailable, true);
    assert.deepEqual(response.products, []);
    assert.equal(response.gulfCrudeShare, 0);
    assert.equal(response.crudeLossKbd, 0);
    assert.equal(response.effectiveCoverDays, 0);
    assert.equal(response.jodiOilCoverage, false);
    assert.equal(response.comtradeCoverage, false);
    assert.equal(response.ieaStocksCoverage, false);
    assert.ok(response.limitations.some((limitation) => limitation.includes('assumed route sensitivities')));
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

describe('gas sensitivity preserves measurement meaning', () => {
  for (const [disruptionPct, loss, deficit] of [[50, 6197.7, 1.3], [100, 12395.4, 2.7]]) {
    it(`replays captured DE inputs at ${disruptionPct}% without traffic scaling or endurance`, async (t) => {
      t.after(restoreEnergyShockEnvironment);
      const { body: profile } = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('./fixtures/energy-shock/de-profile-2026-09-10.json', import.meta.url), 'utf8'));
      const { body: old } = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('./fixtures/energy-shock/de-shock-100-2026-09-10.json', import.meta.url), 'utf8'));
      installEnergyShockRedis({
        ...liveChokepointSeed(old.liveFlowRatio),
        'energy:jodi-gas:v1:DE': {
          lngImportsTj: profile.gasLngImportsTj, totalDemandTj: profile.gasTotalDemandTj,
          lngShareOfImports: profile.gasLngShare / 100, dataMonth: profile.jodiGasDataMonth,
        },
        'energy:gas-storage:v1:DE': old.gasImpact.storage,
        [`energy:shock:v2:DE:hormuz_strait:${disruptionPct}:l:gas`]: old,
        [`energy:shock:v3:DE:hormuz_strait:${disruptionPct}:l:gas`]: old,
      });
      const response = await computeShock({ countryCode: 'DE', chokepointId: 'hormuz_strait', disruptionPct, fuelMode: 'gas' });
      assert.equal(response.gasSensitivity?.lngDisruptionTj, loss);
      assert.equal(response.gasSensitivity?.deficitPct, deficit);
      assert.equal(response.coverageLevel, 'partial');
      assert.notEqual(response.chokepointConfidence, 'high');
      assert.equal(response.gasSensitivity?.dataMonth, '2026-01');
      assert.equal(response.gasSensitivity?.storage?.date, '2026-09-07');
      assert.equal(response.gasSensitivity?.storage?.bufferDays, undefined);
      assert.match(response.assessment, /assumes 30%/i);
      assert.match(response.assessment, /not.*shortage forecast/i);
      assert.doesNotMatch(response.assessment, /days|can bridge|low.*dependence|faces/i);
    });
  }

  for (const invalid of [null, undefined, -1, '100', NaN, Infinity]) {
    for (const field of ['lngImportsTj', 'totalDemandTj']) {
      it(`suppresses ${field}=${String(invalid)} rather than claiming zero impact`, async (t) => {
        t.after(restoreEnergyShockEnvironment);
        installEnergyShockRedis({ ...liveChokepointSeed(), ...US_OIL_SEED,
          'energy:jodi-gas:v1:US': { ...US_GAS_SEED['energy:jodi-gas:v1:US'], [field]: invalid },
        });
        const response = await computeShock({ countryCode: 'US', chokepointId: 'hormuz_strait', disruptionPct: 100, fuelMode: 'gas' });
        assert.equal(response.dataAvailable, false);
        assert.equal(response.coverageLevel, 'unsupported');
        assert.equal(response.gasSensitivity, undefined);
        assert.deepEqual(response.products, []);
        assert.match(response.assessment, /insufficient gas/i);
      });
    }
  }

  it('cannot turn zero demand into a zero deficit', async (t) => {
    t.after(restoreEnergyShockEnvironment);
    installEnergyShockRedis({ 'energy:jodi-gas:v1:US': { lngImportsTj: 100, totalDemandTj: 0 } });
    const response = await computeShock({ countryCode: 'US', chokepointId: 'hormuz_strait', disruptionPct: 100, fuelMode: 'gas' });
    assert.equal(response.gasSensitivity, undefined);
    assert.equal(response.dataAvailable, false);
  });

  it('keeps missing gas separate from available oil in gas-only and combined modes', async (t) => {
    t.after(restoreEnergyShockEnvironment);
    installEnergyShockRedis({ ...liveChokepointSeed(), ...US_OIL_SEED });
    const request = { countryCode: 'US', chokepointId: 'hormuz_strait', disruptionPct: 100 };
    const gas = await computeShock({ ...request, fuelMode: 'gas' });
    assert.equal(gas.dataAvailable, false);
    assert.deepEqual(gas.products, []);
    const both = await computeShock({ ...request, fuelMode: 'both' });
    assert.equal(both.dataAvailable, true);
    assert.equal(both.coverageLevel, 'partial');
    assert.equal(both.chokepointConfidence, 'none');
    assert.ok(both.limitations.some(l => /insufficient gas/i.test(l)));
  });
});

describe('gas sensitivity edge cases through the handler', () => {
  for (const flow of [null, 0, 0.122, 1]) {
    it(`does not scale total assumed loss by shipping flow ${flow}`, async (t) => {
      t.after(restoreEnergyShockEnvironment);
      installEnergyShockRedis({ ...(flow === null ? {} : liveChokepointSeed(flow)), ...US_GAS_SEED });
      const response = await computeShock({ countryCode: 'US', chokepointId: 'hormuz_strait', disruptionPct: 100, fuelMode: 'gas' });
      assert.equal(response.gasSensitivity.lngDisruptionTj, 300);
      assert.equal(response.gasSensitivity.deficitPct, 6);
      assert.equal(response.coverageLevel, 'partial');
      assert.equal(response.chokepointConfidence, 'none');
      assert.equal(response.gasSensitivity.dataMonth, '');
      assert.ok(response.limitations.some(l => l.includes('no observation date')));
    });
  }

  for (const lngImportsTj of [0, 0.001]) {
    it(`preserves ${lngImportsTj} LNG without inventing share or endurance`, async (t) => {
      t.after(restoreEnergyShockEnvironment);
      installEnergyShockRedis({ ...liveChokepointSeed(),
        'energy:jodi-gas:v1:DE': { lngImportsTj, totalDemandTj: 1000, dataMonth: '2026-01' },
        'energy:gas-storage:v1:DE': { fillPct: 54.75, gasTwh: 135.5, date: '2026-09-07' },
      });
      const response = await computeShock({ countryCode: 'DE', chokepointId: 'hormuz_strait', disruptionPct: 100, fuelMode: 'gas' });
      assert.equal(response.gasSensitivity.dataAvailable, true);
      assert.equal(response.gasSensitivity.lngShareOfImports, undefined);
      assert.equal(response.gasSensitivity.storage.bufferDays, undefined);
      assert.equal(response.gasSensitivity.storage.gasTwh, 135.5);
      if (lngImportsTj === 0) {
        assert.equal(response.gasSensitivity.lngDisruptionTj, 0);
        assert.equal(response.gasSensitivity.deficitPct, 0);
        assert.match(response.assessment, /recorded zero LNG imports in 2026-01/);
        assert.doesNotMatch(response.assessment, /pipeline only|no direct LNG impact/);
      } else {
        assert.equal(response.gasSensitivity.lngDisruptionTj, 0.0003);
        assert.ok(response.gasSensitivity.deficitPct > 0);
        assert.match(response.assessment, /<0.1%/);
      }
    });
  }

  it('does not publish missing storage observations as zeros', async (t) => {
    t.after(restoreEnergyShockEnvironment);
    installEnergyShockRedis({ 'energy:jodi-gas:v1:DE': { lngImportsTj: 100, totalDemandTj: 1000 },
      'energy:gas-storage:v1:DE': { fillPct: null, gasTwh: null, date: '2026-09-07' } });
    const response = await computeShock({ countryCode: 'DE', chokepointId: 'hormuz_strait', disruptionPct: 100, fuelMode: 'gas' });
    assert.equal(response.gasSensitivity.storage, undefined);
  });
});

describe('gas response JSON contract', () => {
  it('preserves omitted measurements and dated sensitivity through the generated client', async (t) => {
    t.after(restoreEnergyShockEnvironment);
    installEnergyShockRedis({
      'energy:jodi-gas:v1:DE': { lngImportsTj: 1000, totalDemandTj: 5000, dataMonth: '2026-01' },
      'energy:gas-storage:v1:DE': { gasTwh: 135.5, fillPct: 54.75, date: '2026-09-07' },
    });
    const { IntelligenceServiceClient } = await import('../src/generated/client/worldmonitor/intelligence/v1/service_client.ts');
    const client = new IntelligenceServiceClient('https://fixture.invalid', {
      fetch: async (input, init) => {
        const url = new URL(input);
        assert.equal(init.method, 'GET');
        assert.equal(url.pathname, '/api/intelligence/v1/compute-energy-shock');
        return Response.json(await computeShock({
          countryCode: url.searchParams.get('country_code'),
          chokepointId: url.searchParams.get('chokepoint_id'),
          fuelMode: url.searchParams.get('fuel_mode'),
          disruptionPct: Number(url.searchParams.get('disruption_pct')),
        }));
      },
    });
    const response = await client.computeEnergyShockScenario({ countryCode: 'DE', chokepointId: 'hormuz_strait', disruptionPct: 100, fuelMode: 'gas' });
    assert.equal(response.gasSensitivity.lngDisruptionTj, 300);
    assert.equal(response.gasSensitivity.deficitPct, 6);
    assert.equal(response.gasSensitivity.modelBasis, 'assumed_route_sensitivity');
    assert.equal(Object.hasOwn(response, 'gasImpact'), false);
    const { assessment, dataAvailable, gasImpact } = await Response.json(response).json();
    assert.equal(dataAvailable, true);
    assert.equal(gasImpact, undefined);
    assert.match(assessment, /6.0% of JODI demand/);
    assert.match(assessment, /not measured country-specific exposure or a supply-shortage forecast/);
    assert.doesNotMatch(assessment, /days|no direct LNG impact|low LNG dependence|bridge/);
    assert.equal(response.gasSensitivity.dataMonth, '2026-01');
    assert.equal(response.gasSensitivity.storage.date, '2026-09-07');
    assert.equal(Object.hasOwn(response.gasSensitivity.storage, 'bufferDays'), false);
    assert.equal(Object.hasOwn(response.gasSensitivity, 'lngShareOfImports'), false);
  });
});


describe('observed oil imports through handler and Decision brief', () => {
  for (const importsKbd of [null, undefined, -1, '100', NaN, Infinity, 0, 100]) {
    it(`distinguishes crude imports ${String(importsKbd)} from missing data`, async (t) => {
      t.after(restoreEnergyShockEnvironment);
      installEnergyShockRedis({ ...liveChokepointSeed(),
        'energy:jodi-oil:v1:DE': { dataMonth: '2026-05', crude: { importsKbd }, diesel: { demandKbd: 80 } },
        // Measured 40% Gulf share so the loss is 20/40 at 50%/100% when imports are 100.
        'comtrade:bilateral-hs4-partners:DE:v1': { iso2: 'DE', products: [{ hs4: '2709', year: 2024, totalValue: 1000, partners: [{ partnerIso2: 'SA', partnerCode: 682, value: 400 }, { partnerIso2: 'US', partnerCode: 842, value: 600 }], omittedCount: 0, omittedShare: 0 }] },
      });
      const available = importsKbd === 0 || importsKbd === 100;
      const captures = [];
      for (const disruptionPct of [50, 100]) {
        const response = await computeShock({ countryCode: 'DE', chokepointId: 'hormuz_strait', disruptionPct, fuelMode: 'oil' });
        assert.equal(response.jodiOilCoverage, true);
        assert.equal(response.dataAvailable, available);
        // coverage_level must agree with data_available. jodi_oil_coverage stays true
        // (the row exists), so keying coverage off row presence reports "full"/"partial"
        // here and paints a coverage badge beside the insufficient-data assessment.
        if (!available) assert.equal(response.coverageLevel, 'unsupported');
        if (!available) assert.match(response.assessment, /insufficient/i);
        captures.push({ response, retrievedAt: '2026-09-10T10:00:00Z' });
      }
      const brief = buildDecisionBrief({ countryCode: 'DE', countryName: 'Germany', chokepointId: 'hormuz_strait', fuelMode: 'oil', baselinePct: 50, comparisonPct: 100 }, captures);
      assert.deepEqual(brief.results.map(r => r.loss), available ? importsKbd === 0 ? [0, 0] : [20, 40] : [null, null]);
      assert.match(brief.action.text, available ? importsKbd === 0 ? /modeled zero/ : /Compare Germany/ : /Recover the oil import/);
      if (!available) assert.match(brief.action.constraint, /baseline is incomplete/);
      const both = await computeShock({ countryCode: 'DE', chokepointId: 'hormuz_strait', disruptionPct: 100, fuelMode: 'both' });
      assert.equal(both.dataAvailable, available);
    });
  }

  it('isolates old oil and both caches while preserving gas-only cache reuse', async (t) => {
    t.after(restoreEnergyShockEnvironment);
    const request = { countryCode: 'US', chokepointId: 'hormuz_strait', disruptionPct: 100 };
    installEnergyShockRedis({ ...liveChokepointSeed(), ...US_GAS_SEED,
      'energy:jodi-oil:v1:US': { crude: { importsKbd: null }, diesel: { demandKbd: 80 } },
      'energy:shock:v2:US:hormuz_strait:100:l:oil': { dataAvailable: true, assessment: 'old oil' },
      'energy:shock:v4:US:hormuz_strait:100:l:both': { dataAvailable: false, assessment: 'old both' },
      'energy:shock:v4:US:hormuz_strait:100:l:gas': { dataAvailable: true, assessment: 'gas cache retained' },
    });
    const oil = await computeShock({ ...request, fuelMode: 'oil' });
    assert.equal(oil.dataAvailable, false);
    assert.notEqual(oil.assessment, 'old oil');
    const both = await computeShock({ ...request, fuelMode: 'both' });
    assert.equal(both.dataAvailable, true);
    assert.equal(both.gasSensitivity.dataAvailable, true);
    assert.notEqual(both.assessment, 'old both');
    assert.equal((await computeShock({ ...request, fuelMode: 'gas' })).assessment, 'gas cache retained');
  });
});


describe('bilateral Gulf share excludes World totals', () => {
  for (const partnerCode of [0, '0', '000', '0000']) {
    it(`does not treat World ${partnerCode} as bilateral evidence`, () => {
      assert.deepEqual(computeGulfShare([{ partnerCode, tradeValueUsd: 100 }]), { share: 0, hasData: false });
    });
  }
  it('excludes aggregate totals from mixed bilateral denominators', () => {
    assert.deepEqual(computeGulfShare([{ partnerCode: '000', tradeValueUsd: 200 }, { partnerCode: '682', tradeValueUsd: 100 }, { partnerCode: '840', tradeValueUsd: 100 }]), { share: 0.5, hasData: true });
    assert.deepEqual(computeGulfShare([{ partnerCode: '840', tradeValueUsd: 100 }]), { share: 0, hasData: true });
  });
  it('reports producer-shaped World data as unavailable, with no proxy, and ignores v5–v7 caches', async (t) => {
    t.after(restoreEnergyShockEnvironment);
    installEnergyShockRedis({ ...liveChokepointSeed(),
      'energy:jodi-oil:v1:CN': { crude: { importsKbd: 100 }, diesel: { demandKbd: 80 } },
      'comtrade:flows:156:2709': [{ reporterCode: '156', partnerCode: '000', partnerName: 'World', cmdCode: '2709', tradeValueUsd: 100 }],
      'energy:shock:v5:CN:hormuz_strait:50:l:oil': { dataAvailable: true, comtradeCoverage: true, crudeLossKbd: 0 },
      'energy:shock:v5:CN:hormuz_strait:50:l:both': { dataAvailable: true, comtradeCoverage: true, crudeLossKbd: 0 },
      'energy:shock:v7:CN:hormuz_strait:50:l:oil': { dataAvailable: true, comtradeCoverage: false, crudeLossKbd: 20, gulfCrudeShare: 0.4 },
      'energy:shock:v7:CN:hormuz_strait:50:l:both': { dataAvailable: true, comtradeCoverage: false, crudeLossKbd: 20, gulfCrudeShare: 0.4 },
    });
    const request = { countryCode: 'CN', chokepointId: 'hormuz_strait', disruptionPct: 50 };
    const response = await computeShock({ ...request, fuelMode: 'oil' });
    assert.equal(response.comtradeCoverage, false);
    assert.equal(response.dataAvailable, false);
    assert.equal(response.coverageLevel, 'unsupported');
    assert.equal(response.gulfCrudeShare, 0);
    assert.equal(response.crudeLossKbd, 0);
    assert.ok(!response.limitations.some(l => /proxied|40%/.test(l)), response.limitations.join('\n'));
    assert.ok(response.limitations.some(l => /partner-level crude \(HS 2709\)/.test(l)), response.limitations.join('\n'));
    const brief = buildDecisionBrief({ countryCode: 'CN', countryName: 'China', chokepointId: 'hormuz_strait', fuelMode: 'oil', baselinePct: 50, comparisonPct: 50 }, [{ response, retrievedAt: '2026-09-10T10:00:00Z' }, { response, retrievedAt: '2026-09-10T10:00:00Z' }]);
    assert.equal(brief.evidence.find(e => e.id === 'baseline-route').value, null);
    assert.match(brief.unknowns.join(' '), /not modeled without a measured origin share/);
    assert.equal(brief.results[0].loss, null);
    const both = await computeShock({ ...request, fuelMode: 'both' });
    assert.equal(both.crudeLossKbd, 0);
    assert.equal(both.dataAvailable, false);
  });
});

// ---------------------------------------------------------------------------
// Production replay, 2026-10-28: every country returned gulfCrudeShare 0.242
// (= 40% proxy × Hormuz flowRatio 0.606) because `comtrade:flows:*:2709` holds
// only World-aggregate rows, while `comtrade:bilateral-hs4-partners:*:v1`
// already carries partner-level HS 2709 imports. Values below are copied from
// the production keys read that day.
// ---------------------------------------------------------------------------

const HORMUZ_LIVE_SEED = { 'energy:chokepoint-flows:v1': { hormuz_strait: { currentMbd: 12.7, baselineMbd: 21, flowRatio: 0.606 } } };

function partnersSeed(iso2, totalValue, partners, extra = {}) {
  return {
    [`comtrade:bilateral-hs4-partners:${iso2}:v1`]: {
      iso2,
      fetchedAt: '2026-10-01T06:03:15.738Z',
      source: 'UN Comtrade data API',
      products: [
        { hs4: '8542', year: 2024, totalValue: 1, partners: [], omittedCount: 0, omittedShare: 0 },
        { hs4: '2709', year: 2024, denominatorBasis: 'reported_world', totalValue, partners, omittedCount: 0, omittedShare: 0, ...extra },
      ],
    },
  };
}

const JP_PARTNERS_2709 = [
  { partnerCode: 784, partnerIso2: 'AE', value: 31447434112.361 },
  { partnerCode: 682, partnerIso2: 'SA', value: 28747349248.979 },
  { partnerCode: 414, partnerIso2: 'KW', value: 4864837669.835 },
  { partnerCode: 634, partnerIso2: 'QA', value: 2868361947.893 },
  { partnerCode: 842, partnerIso2: 'US', value: 1866573960.694 },
  { partnerCode: 218, partnerIso2: 'EC', value: 907491256.37 },
];
const JP_TOTAL_2709 = 71811869887.915;
const JP_GULF_SHARE = (31447434112.361 + 28747349248.979 + 4864837669.835 + 2868361947.893) / JP_TOTAL_2709; // 0.946

const JP_CRUDE_IMPORTS_KBD = 2382.1742;
const JP_PROD_SEED = {
  'energy:jodi-oil:v1:JP': {
    iso2: 'JP', dataMonth: '2026-07',
    gasoline: { demandKbd: 790.8135 }, diesel: { demandKbd: 674.0471 }, jet: { demandKbd: 240.7139 }, lpg: { demandKbd: 304.2194 },
    crude: { productionKbd: 2.8529, refineryIntakeKbd: 2421.5529, importsKbd: JP_CRUDE_IMPORTS_KBD, exportsKbd: 0 },
  },
  'energy:iea-oil-stocks:v1:JP': { iso2: 'JP', dataMonth: '2026-07', daysOfCover: 178, netExporter: false, anomaly: false },
  ...partnersSeed('JP', JP_TOTAL_2709, JP_PARTNERS_2709, { omittedCount: 8, omittedShare: 0.015 }),
};

const IN_PARTNERS_2709 = [
  { partnerCode: 643, partnerIso2: 'RU', value: 52727893909.941 },
  { partnerCode: 368, partnerIso2: 'IQ', value: 28105033563.002 },
  { partnerCode: 682, partnerIso2: 'SA', value: 19606881972.92 },
  { partnerCode: 784, partnerIso2: 'AE', value: 13452491019.064 },
  { partnerCode: 566, partnerIso2: 'NG', value: 4147421218.557 },
  { partnerCode: 414, partnerIso2: 'KW', value: 3089863519.848 },
];
const IN_TOTAL_2709 = 141532322252.516;
const IN_GULF_SHARE = (28105033563.002 + 19606881972.92 + 13452491019.064 + 3089863519.848) / IN_TOTAL_2709; // 0.454

const WORLD_ONLY_FLOWS = (reporterCode) => [
  { reporterCode, partnerCode: '000', partnerName: 'World', cmdCode: '2709', year: 2024, tradeValueUsd: 650373198666 },
  { reporterCode, partnerCode: '000', partnerName: 'World', cmdCode: '2709', year: 2024, tradeValueUsd: 1_000_000 },
];

describe('production replay 2026-10-28: Gulf crude share comes from Comtrade partner rows, never a proxy', () => {
  it('Japan: measured partner share (AE+SA+KW+QA) replaces the 40% proxy and is not scaled by the live flow ratio', async (t) => {
    t.after(restoreEnergyShockEnvironment);
    installEnergyShockRedis({ ...HORMUZ_LIVE_SEED, ...JP_PROD_SEED });

    const response = await computeShock({ countryCode: 'JP', chokepointId: 'hormuz_strait', disruptionPct: 100, fuelMode: 'both' });

    assert.equal(response.comtradeCoverage, true, 'partner-level Comtrade rows are Comtrade coverage');
    assert.equal(response.liveFlowRatio, 0.606, 'the live ratio stays reported as context');
    assert.ok(Math.abs(response.gulfCrudeShare - JP_GULF_SHARE) < 0.001, `gulfCrudeShare ${response.gulfCrudeShare} should be the measured ${JP_GULF_SHARE.toFixed(3)}, not 0.242`);
    assert.ok(Math.abs(response.crudeLossKbd - JP_CRUDE_IMPORTS_KBD * JP_GULF_SHARE) < 0.1, `crudeLossKbd ${response.crudeLossKbd} must be imports × measured share`);
    assert.equal(response.effectiveCoverDays, Math.round(178 / JP_GULF_SHARE), '178 IEA days stretched over the Gulf-sourced fraction, no cap');
    assert.ok(!response.limitations.some((l) => /proxied|40%/.test(l)), 'no proxy wording');
    assert.ok(!/indefinitely bridgeable/.test(response.assessment), response.assessment);
    assert.ok(response.limitations.some((l) => /UN Comtrade 2024/.test(l)), 'the measured share cites its source and year');
    assert.equal(response.dataAvailable, true);
  });

  it('live flow ratio is context only: identical oil numbers at flowRatio 1.0 and 0.606', async (t) => {
    t.after(restoreEnergyShockEnvironment);
    const request = { countryCode: 'JP', chokepointId: 'hormuz_strait', disruptionPct: 100, fuelMode: 'oil' };

    installEnergyShockRedis({ ...liveChokepointSeed(1), ...JP_PROD_SEED });
    const baseline = await computeShock(request);
    installEnergyShockRedis({ ...HORMUZ_LIVE_SEED, ...JP_PROD_SEED });
    const disrupted = await computeShock(request);

    assert.equal(baseline.liveFlowRatio, 1);
    assert.equal(disrupted.liveFlowRatio, 0.606);
    assert.equal(disrupted.gulfCrudeShare, baseline.gulfCrudeShare);
    assert.equal(disrupted.crudeLossKbd, baseline.crudeLossKbd);
    assert.equal(disrupted.effectiveCoverDays, baseline.effectiveCoverDays);
    assert.ok(disrupted.limitations.some((l) => /flow ratio is context only/i.test(l)));
  });

  it('India: missing JODI crude imports is reported as not modeled, not as zero loss beside a proxy share', async (t) => {
    t.after(restoreEnergyShockEnvironment);
    installEnergyShockRedis({
      ...HORMUZ_LIVE_SEED,
      ...partnersSeed('IN', IN_TOTAL_2709, IN_PARTNERS_2709),
      'comtrade:flows:699:2709': WORLD_ONLY_FLOWS('699'),
      'energy:jodi-gas:v1:IN': { lngImportsTj: 111255.81, pipeImportsTj: 0, totalDemandTj: 185285.09, lngShareOfImports: 1, dataMonth: '2026-03' },
    });

    const response = await computeShock({ countryCode: 'IN', chokepointId: 'hormuz_strait', disruptionPct: 100, fuelMode: 'both' });

    assert.equal(response.jodiOilCoverage, false);
    assert.equal(response.comtradeCoverage, true, 'the partner share is measured even when JODI is missing');
    assert.ok(Math.abs(response.gulfCrudeShare - IN_GULF_SHARE) < 0.001, `gulfCrudeShare ${response.gulfCrudeShare} should be measured ${IN_GULF_SHARE.toFixed(3)}, not the 0.242 proxy`);
    assert.equal(response.crudeLossKbd, 0);
    assert.equal(response.effectiveCoverDays, 0);
    assert.deepEqual(response.products, []);
    assert.ok(response.limitations.some((l) => /JODI crude import observation unavailable for IN/.test(l) && /not modeled/.test(l)), response.limitations.join('\n'));
    assert.ok(!response.limitations.some((l) => /proxied|40%/.test(l)));
    assert.equal(response.gasSensitivity?.dataAvailable, true, 'gas stays modeled');
  });

  it('China: World-only Comtrade rows and no partner key yield an unavailable oil scenario with gulfCrudeShare 0', async (t) => {
    t.after(restoreEnergyShockEnvironment);
    installEnergyShockRedis({ ...HORMUZ_LIVE_SEED, 'comtrade:flows:156:2709': WORLD_ONLY_FLOWS('156') });

    const response = await computeShock({ countryCode: 'CN', chokepointId: 'hormuz_strait', disruptionPct: 100, fuelMode: 'both' });

    assert.equal(response.comtradeCoverage, false);
    assert.equal(response.gulfCrudeShare, 0, 'no measured share → 0, never 0.242');
    assert.equal(response.crudeLossKbd, 0);
    assert.equal(response.dataAvailable, false);
    assert.equal(response.coverageLevel, 'unsupported');
    assert.ok(response.limitations.some((l) => /partner-level/.test(l) && /unavailable for CN/.test(l)), response.limitations.join('\n'));
    assert.ok(!response.limitations.some((l) => /proxied|40%/.test(l)));
  });

  it('JODI present but no partner-level Comtrade: oil is unavailable instead of proxied', async (t) => {
    t.after(restoreEnergyShockEnvironment);
    installEnergyShockRedis({
      ...HORMUZ_LIVE_SEED,
      'energy:jodi-oil:v1:DE': { crude: { importsKbd: 1560 }, gasoline: { demandKbd: 454.4 }, diesel: { demandKbd: 766.7 } },
      'energy:iea-oil-stocks:v1:DE': { daysOfCover: 124, netExporter: false, anomaly: false },
      'comtrade:flows:276:2709': WORLD_ONLY_FLOWS('276'),
    });

    const response = await computeShock({ countryCode: 'DE', chokepointId: 'hormuz_strait', disruptionPct: 100, fuelMode: 'oil' });

    assert.equal(response.jodiOilCoverage, true);
    assert.equal(response.comtradeCoverage, false);
    assert.equal(response.dataAvailable, false, 'a scenario without a measured route share is not available');
    assert.equal(response.coverageLevel, 'unsupported');
    assert.equal(response.gulfCrudeShare, 0);
    assert.equal(response.crudeLossKbd, 0);
    assert.equal(response.effectiveCoverDays, 0);
    assert.deepEqual(response.products, []);
    assert.match(response.assessment, /origin/i);
    assert.ok(response.limitations.some((l) => /Crude import origin share unavailable for DE/.test(l)), response.limitations.join('\n'));
    assert.ok(!response.limitations.some((l) => /proxied|40%/.test(l)));
  });

  it('United States: the net-exporter sentinel is self-described and the loss uses the measured ~8% Gulf share', async (t) => {
    t.after(restoreEnergyShockEnvironment);
    const usTotal = 174423623898;
    installEnergyShockRedis({
      ...HORMUZ_LIVE_SEED,
      'energy:jodi-oil:v1:US': { crude: { importsKbd: 5888 }, gasoline: { demandKbd: 9316.5 }, diesel: { demandKbd: 3627.3 } },
      'energy:iea-oil-stocks:v1:US': { daysOfCover: null, netExporter: true, anomaly: false },
      'comtrade:flows:842:2709': WORLD_ONLY_FLOWS('842'),
      ...partnersSeed('US', usTotal, [
        { partnerCode: 124, partnerIso2: 'CA', value: 103300938691 },
        { partnerCode: 484, partnerIso2: 'MX', value: 12476631428 },
        { partnerCode: 682, partnerIso2: 'SA', value: 8353719321 },
        { partnerCode: 368, partnerIso2: 'IQ', value: 5809551979 },
      ], { omittedCount: 20, omittedShare: 0.072 }),
    });

    const response = await computeShock({ countryCode: 'US', chokepointId: 'hormuz_strait', disruptionPct: 100, fuelMode: 'oil' });

    const expectedShare = (8353719321 + 5809551979) / usTotal;
    assert.ok(Math.abs(response.gulfCrudeShare - expectedShare) < 0.001, `gulfCrudeShare ${response.gulfCrudeShare} vs ${expectedShare.toFixed(3)}`);
    assert.ok(response.crudeLossKbd < 600, `US Gulf-sourced loss ${response.crudeLossKbd} kbd must be far below the 1425 the proxy produced`);
    assert.equal(response.effectiveCoverDays, -1);
    assert.ok(response.limitations.some((l) => /effectiveCoverDays -1/.test(l) && /net oil exporter/.test(l)), response.limitations.join('\n'));
  });

  it('a net exporter without JODI crude imports reports cover 0, not -1, so the value matches the "reported as 0" limitation', async (t) => {
    t.after(restoreEnergyShockEnvironment);
    installEnergyShockRedis({
      ...HORMUZ_LIVE_SEED,
      'energy:iea-oil-stocks:v1:US': { daysOfCover: null, netExporter: true, anomaly: false },
      ...partnersSeed('US', 1000, [{ partnerCode: 682, partnerIso2: 'SA', value: 80 }, { partnerCode: 124, partnerIso2: 'CA', value: 920 }]),
    });

    const response = await computeShock({ countryCode: 'US', chokepointId: 'hormuz_strait', disruptionPct: 100, fuelMode: 'oil' });

    assert.equal(response.ieaStocksCoverage, true);
    assert.equal(response.jodiOilCoverage, false);
    assert.equal(response.dataAvailable, false);
    assert.equal(response.effectiveCoverDays, 0);
    assert.ok(response.limitations.some((l) => /JODI crude import observation unavailable for US/.test(l) && /effective cover are not modeled \(reported as 0\)/.test(l)), response.limitations.join('\n'));
    assert.ok(!response.limitations.some((l) => /effectiveCoverDays -1/.test(l)), 'no net-exporter sentinel explanation when nothing is modeled');
  });

  it('IEA reserves with no origin share give cover 0 and the not-modeled limitation, never a raw IEA figure', async (t) => {
    t.after(restoreEnergyShockEnvironment);
    installEnergyShockRedis({
      ...HORMUZ_LIVE_SEED,
      'energy:jodi-oil:v1:DE': { crude: { importsKbd: 1560 }, diesel: { demandKbd: 766.7 } },
      'energy:iea-oil-stocks:v1:DE': { daysOfCover: 124, netExporter: false, anomaly: false },
      'comtrade:flows:276:2709': WORLD_ONLY_FLOWS('276'),
      'energy:jodi-gas:v1:DE': { lngImportsTj: 25135, pipeImportsTj: 248000, totalDemandTj: 137779, lngShareOfImports: 0.092, dataMonth: '2026-07' },
    });

    const response = await computeShock({ countryCode: 'DE', chokepointId: 'hormuz_strait', disruptionPct: 100, fuelMode: 'both' });

    assert.equal(response.ieaStocksCoverage, true);
    assert.equal(response.dataAvailable, true, 'gas keeps the combined scenario available');
    assert.equal(response.effectiveCoverDays, 0);
    assert.ok(response.limitations.some((l) => /Crude import origin share unavailable for DE/.test(l) && /effective cover are not modeled \(reported as 0\)/.test(l)), response.limitations.join('\n'));
  });

  it('the 730-day cap is self-described when it binds', async (t) => {
    t.after(restoreEnergyShockEnvironment);
    installEnergyShockRedis({
      ...liveChokepointSeed(1),
      'energy:jodi-oil:v1:FR': { crude: { importsKbd: 1000 }, diesel: { demandKbd: 800 } },
      'energy:iea-oil-stocks:v1:FR': { daysOfCover: 120, netExporter: false, anomaly: false },
      ...partnersSeed('FR', 1000, [
        { partnerCode: 682, partnerIso2: 'SA', value: 50 },
        { partnerCode: 842, partnerIso2: 'US', value: 950 },
      ]),
    });

    const response = await computeShock({ countryCode: 'FR', chokepointId: 'hormuz_strait', disruptionPct: 100, fuelMode: 'oil' });

    assert.equal(response.gulfCrudeShare, 0.05);
    assert.equal(response.effectiveCoverDays, 730);
    assert.ok(response.limitations.some((l) => /capped at 730/.test(l)), response.limitations.join('\n'));
  });
});

// ---------------------------------------------------------------------------
// get-country-cost-shock consumes the oil scenario: an unmodeled scenario must
// surface as unavailable there too, not as coverageDays 0 / supplyDeficitPct 0
// beside hasEnergyModel true (CodeRabbit on #9781).
// ---------------------------------------------------------------------------

describe('get-country-cost-shock surfaces an unmodeled oil scenario as unavailable', () => {
  const ORIGINAL_VALID_KEYS = process.env.WORLDMONITOR_VALID_KEYS;
  const premiumCtx = () => ({
    request: new Request('https://api.worldmonitor.app/api/supply-chain/v1/get-country-cost-shock', {
      headers: { 'X-WorldMonitor-Key': 'wm_shock_fixture' },
    }),
  });
  const restore = () => {
    restoreEnergyShockEnvironment();
    if (ORIGINAL_VALID_KEYS == null) delete process.env.WORLDMONITOR_VALID_KEYS;
    else process.env.WORLDMONITOR_VALID_KEYS = ORIGINAL_VALID_KEYS;
  };

  it('reports hasEnergyModel false with the handler\'s reason when the oil inputs are missing', async (t) => {
    t.after(restore);
    process.env.WORLDMONITOR_VALID_KEYS = 'wm_shock_fixture';
    installEnergyShockRedis({ ...HORMUZ_LIVE_SEED, 'comtrade:flows:156:2709': WORLD_ONLY_FLOWS('156') });

    const result = await getCountryCostShock(premiumCtx(), { iso2: 'CN', chokepointId: 'hormuz_strait', hs2: '27' });

    assert.equal(result.hasEnergyModel, false);
    assert.equal(result.coverageDays, 0);
    assert.equal(result.supplyDeficitPct, 0);
    assert.match(result.unavailableReason, /Oil shock modelling is unavailable for CN/);
    assert.match(result.unavailableReason, /JODI crude import observation unavailable for CN/);
  });

  it('keeps the modeled path for a country with both inputs (positive control)', async (t) => {
    t.after(restore);
    process.env.WORLDMONITOR_VALID_KEYS = 'wm_shock_fixture';
    installEnergyShockRedis({ ...HORMUZ_LIVE_SEED, ...JP_PROD_SEED });

    const result = await getCountryCostShock(premiumCtx(), { iso2: 'JP', chokepointId: 'hormuz_strait', hs2: '27' });

    assert.equal(result.hasEnergyModel, true);
    assert.equal(result.unavailableReason, '');
    assert.equal(result.coverageDays, Math.round(178 / JP_GULF_SHARE));
    assert.ok(result.supplyDeficitPct > 0, `supplyDeficitPct ${result.supplyDeficitPct}`);
  });

  it('no IEA observation: the deficit stays modelled, coverageDays is named unavailable, and the joint flag is false', async (t) => {
    t.after(restore);
    process.env.WORLDMONITOR_VALID_KEYS = 'wm_shock_fixture';
    installEnergyShockRedis({
      ...HORMUZ_LIVE_SEED,
      'energy:jodi-oil:v1:IN': { crude: { importsKbd: 4800 }, diesel: { demandKbd: 1900 }, gasoline: { demandKbd: 900 } },
      ...partnersSeed('IN', IN_TOTAL_2709, IN_PARTNERS_2709),
    });

    const result = await getCountryCostShock(premiumCtx(), { iso2: 'IN', chokepointId: 'hormuz_strait', hs2: '27' });

    assert.equal(result.hasEnergyModel, false);
    assert.equal(result.coverageDays, 0);
    assert.ok(result.supplyDeficitPct > 0, `supplyDeficitPct ${result.supplyDeficitPct} must still carry the modelled deficit`);
    assert.match(result.unavailableReason, /coverageDays is unavailable: no IEA stock observation for IN/);
    assert.match(result.unavailableReason, /supplyDeficitPct is modelled/);
  });

  it('crude imports without any refined-product demand: coverage stays modelled, the deficit is named unavailable', async (t) => {
    t.after(restore);
    process.env.WORLDMONITOR_VALID_KEYS = 'wm_shock_fixture';
    installEnergyShockRedis({
      ...HORMUZ_LIVE_SEED,
      'energy:jodi-oil:v1:JP': { crude: { importsKbd: JP_CRUDE_IMPORTS_KBD }, gasoline: { refOutputKbd: 783.9 } },
      'energy:iea-oil-stocks:v1:JP': { daysOfCover: 178, netExporter: false, anomaly: false },
      ...partnersSeed('JP', JP_TOTAL_2709, JP_PARTNERS_2709),
    });

    const result = await getCountryCostShock(premiumCtx(), { iso2: 'JP', chokepointId: 'hormuz_strait', hs2: '27' });

    assert.equal(result.hasEnergyModel, false);
    assert.equal(result.supplyDeficitPct, 0);
    assert.equal(result.coverageDays, Math.round(178 / JP_GULF_SHARE));
    assert.match(result.unavailableReason, /supplyDeficitPct is unavailable: no refined-product demand observation for JP/);
    assert.match(result.unavailableReason, /coverageDays is modelled/);
  });
});
