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
  GLOBAL_MEDIAN_REFINERY_YIELD,
  GLOBAL_MEDIAN_REFINERY_YIELD_SOURCE,
  computeMonthlyGulfShares,
  computeEffectiveCoverDaysWithRamp,
  computeProductBalance,
} from '../server/worldmonitor/intelligence/v1/_shock-compute.js';
import { buildCrudeImportOrigin, crudeImportOriginPeriods } from '../scripts/seed-oil-trade-series.mjs';
import { computeEnergyShockScenario } from '../server/worldmonitor/intelligence/v1/compute-energy-shock.ts';
import { getCountryCostShock } from '../server/worldmonitor/supply-chain/v1/get-country-cost-shock.ts';
import { buildDecisionBrief } from '../src/utils/decision-brief.ts';
import { installRedis } from './helpers/fake-upstash-redis.mts';
import { parseCsv, extractCountryData } from '../scripts/seed-jodi-oil.mjs';
import { createCountryDeepDivePanelHarness } from './helpers/country-deep-dive-panel-harness.mjs';
import { readFileSync } from 'node:fs';

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

/**
 * A measured Hormuz LNG share (`comtrade:lng-hormuz-share:v1`) for gas tests
 * whose subject is not the share: coverage, flow scaling, storage, rounding.
 * Hormuz has no fixed route fraction, so without it these importers are
 * unavailable. 0.30 keeps the figures those tests were written against.
 */
function lngShareSeed(shares) {
  const preCrisis = (share) => ({ basis: 'comtrade_annual', fromMonth: '2025-01', toMonth: '2025-12', monthsCovered: 12, share, measure: 'weight', unattributedShare: 0 });
  return {
    'comtrade:lng-hormuz-share:v1': {
      fetchedAt: '2026-11-01T06:00:00.000Z',
      countries: Object.fromEntries(Object.entries(shares).map(([iso2, share]) => [iso2, { preCrisis: preCrisis(share), current: null, currentUnavailable: 'no_rows' }])),
    },
  };
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
    // Bahrain (048) has no Hormuz bypass, so no per-exporter share is listed.
    assert.deepEqual(result, { share: 0.25, hasData: true, year: undefined, omittedShare: undefined, byPartner: {} });
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
    installEnergyShockRedis({ ...liveChokepointSeed(), ...US_OIL_SEED, ...US_GAS_SEED, ...lngShareSeed({ US: 0.3 }) });

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
  it('has a fixed fraction for every chokepoint except Hormuz', () => {
    for (const cp of ['malacca_strait', 'suez', 'bab_el_mandeb']) {
      assert.ok(cp in CHOKEPOINT_LNG_EXPOSURE, `missing ${cp}`);
      assert.ok(CHOKEPOINT_LNG_EXPOSURE[cp] > 0 && CHOKEPOINT_LNG_EXPOSURE[cp] <= 1);
    }
    assert.equal('hormuz_strait' in CHOKEPOINT_LNG_EXPOSURE, false, 'Hormuz uses the measured Qatar + UAE share');
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
  it('computes hormuz LNG disruption at the measured share it is given', () => {
    const { lngDisruptionTj, deficitPct } = computeGasDisruption(1000, 5000, 'hormuz_strait', 100, 0.3);
    assert.equal(lngDisruptionTj, 300);
    assert.equal(deficitPct, 6);
  });

  it('has no hormuz loss without a measured share', () => {
    assert.equal(computeGasDisruption(1000, 5000, 'hormuz_strait', 100), undefined);
  });

  it('computes malacca at 50% disruption', () => {
    const { lngDisruptionTj } = computeGasDisruption(2000, 10000, 'malacca_strait', 50);
    assert.equal(lngDisruptionTj, 500);
  });

  it('returns zero for zero lngImportsTj', () => {
    const { lngDisruptionTj, deficitPct } = computeGasDisruption(0, 5000, 'hormuz_strait', 100, 0);
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
    installEnergyShockRedis({ ...liveChokepointSeed(), ...US_OIL_SEED, ...US_GAS_SEED, ...lngShareSeed({ US: 0.3 }) });

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
    assert.ok(response.limitations.some((limitation) => limitation.startsWith('LNG Hormuz share: UN Comtrade HS 271111')));
    assert.ok(!response.limitations.some((limitation) => limitation.includes('assumed route sensitivities')));
    assert.ok(!response.limitations.some((limitation) => limitation.includes('refinery yield')));
    assert.ok(!response.limitations.some((limitation) => limitation.includes('Gulf crude share')));
    assert.ok(!response.limitations.some((limitation) => limitation.includes('IEA strategic stock')));
  });

  it('marks a valid degraded gas-only response as partial', async (t) => {
    t.after(restoreEnergyShockEnvironment);
    installEnergyShockRedis({ ...US_GAS_SEED, ...lngShareSeed({ US: 0.3 }) });

    const response = await computeShock({
      countryCode: 'US', chokepointId: 'hormuz_strait', disruptionPct: 80, fuelMode: 'gas',
    });
    assert.equal(response.degraded, true);
    assert.equal(response.coverageLevel, 'partial');
  });
});

// ---------------------------------------------------------------------------
// Refinery yields: each country's own JODI yields, or a labelled global median.
// The US-average constants (gasoline 44%, diesel 30%, jet 10%, LPG 5%) applied
// to every country overstated KR gasoline 2.5x and understated DE diesel 1.6x.
// ---------------------------------------------------------------------------

// The exact rows scripts/seed-jodi-oil.mjs publishes from the public JODI files
// (read 2026-10-28), so these tests run the producer-to-reader path.
const JODI_WINDOW_ROWS = parseCsv(readFileSync(new URL('./fixtures/energy-shock/jodi-oil-refinery-window-2026-10-28.csv', import.meta.url), 'utf8'));
const seededJodiRow = (iso2) => extractCountryData(JODI_WINDOW_ROWS, iso2);

function refineryYieldSeed(iso2, row = seededJodiRow(iso2)) {
  return {
    ...liveChokepointSeed(),
    [`energy:jodi-oil:v1:${iso2}`]: row,
    [`energy:iea-oil-stocks:v1:${iso2}`]: { daysOfCover: 200, netExporter: false, anomaly: false },
    // A measured 70% Gulf crude share keeps the arithmetic readable. Kuwait has
    // no Hormuz bypass, so no rerouting reduces the loss these yields apply to.
    [`comtrade:bilateral-hs4-partners:${iso2}:v1`]: { iso2, products: [{ hs4: '2709', year: 2024, totalValue: 1000, partners: [{ partnerIso2: 'KW', partnerCode: 414, value: 700 }, { partnerIso2: 'US', partnerCode: 842, value: 300 }], omittedCount: 0, omittedShare: 0 }] },
  };
}

const yieldLimitation = (response) => response.limitations.find((l) => l.startsWith('refinery yields'));
const productRow = (response, name) => response.products.find((p) => p.product === name);
const round1 = (v) => Math.round(v * 10) / 10;

describe('refinery yields are per country, from the JODI row', () => {
  it('KR: product losses use Korea\'s own yields, not the US average, and naphtha is a product row', async (t) => {
    t.after(restoreEnergyShockEnvironment);
    const row = seededJodiRow('KR');
    installEnergyShockRedis(refineryYieldSeed('KR', row));

    const response = await computeShock({ countryCode: 'KR', chokepointId: 'hormuz_strait', disruptionPct: 100, fuelMode: 'oil' });

    const crudeLoss = row.crude.importsKbd * 0.7;
    assert.equal(response.crudeLossKbd, round1(crudeLoss));
    assert.deepEqual(response.products.map((p) => p.product), ['Gasoline', 'Diesel', 'Jet fuel', 'LPG', 'Naphtha']);
    for (const [name, key] of [['Gasoline', 'gasoline'], ['Diesel', 'diesel'], ['Jet fuel', 'jet'], ['LPG', 'lpg'], ['Naphtha', 'naphtha']]) {
      const p = productRow(response, name);
      const expectedLoss = crudeLoss * row.refineryYields.products[key];
      assert.equal(p.outputLossKbd, round1(expectedLoss), `${name} loss`);
    }
    assert.ok(productRow(response, 'Gasoline').outputLossKbd < crudeLoss * 0.2, 'KR gasoline yield is ~18%, not 44%');

    const basis = yieldLimitation(response);
    assert.match(basis, /^refinery yields: KR JODI product output ÷ crude refinery intake, 2025-09–2026-08 \(12 months\)/);
    assert.match(basis, /gasoline 17\.8%, diesel 33\.6%, jet fuel 15\.0%, LPG 3\.1%, naphtha 28\.3%/);
    assert.ok(!response.limitations.some((l) => /US-average|EIA basis/.test(l)), response.limitations.join('\n'));
  });

  it('DE: diesel uses Germany\'s 48.9% yield, not 30%', async (t) => {
    t.after(restoreEnergyShockEnvironment);
    const row = seededJodiRow('DE');
    installEnergyShockRedis(refineryYieldSeed('DE', row));
    const response = await computeShock({ countryCode: 'DE', chokepointId: 'hormuz_strait', disruptionPct: 100, fuelMode: 'oil' });
    assert.equal(productRow(response, 'Diesel').outputLossKbd, round1(row.crude.importsKbd * 0.7 * 0.4886));
  });

  it('a product without a country yield takes the labelled global median; the others keep the country yield', async (t) => {
    t.after(restoreEnergyShockEnvironment);
    const row = seededJodiRow('KR');
    row.refineryYields = { ...row.refineryYields, products: { ...row.refineryYields.products, jet: null } };
    installEnergyShockRedis(refineryYieldSeed('KR', row));

    const response = await computeShock({ countryCode: 'KR', chokepointId: 'hormuz_strait', disruptionPct: 100, fuelMode: 'oil' });

    const crudeLoss = row.crude.importsKbd * 0.7;
    assert.equal(productRow(response, 'Jet fuel').outputLossKbd, round1(crudeLoss * GLOBAL_MEDIAN_REFINERY_YIELD.jet));
    assert.equal(productRow(response, 'Gasoline').outputLossKbd, round1(crudeLoss * row.refineryYields.products.gasoline));
    const basis = yieldLimitation(response);
    assert.match(basis, /gasoline 17\.8%, diesel 33\.6%, LPG 3\.1%, naphtha 28\.3%/);
    assert.match(basis, /jet fuel 6\.9% is the global median/);
    assert.ok(basis.includes(GLOBAL_MEDIAN_REFINERY_YIELD_SOURCE), basis);
  });

  it('a JODI row without trailing-12-month yields uses the global median for every product, never the US average', async (t) => {
    t.after(restoreEnergyShockEnvironment);
    const { refineryYields, ...legacy } = seededJodiRow('KR');
    assert.ok(refineryYields, 'fixture row has yields to drop');
    installEnergyShockRedis(refineryYieldSeed('KR', legacy));

    const response = await computeShock({ countryCode: 'KR', chokepointId: 'hormuz_strait', disruptionPct: 100, fuelMode: 'oil' });

    const crudeLoss = legacy.crude.importsKbd * 0.7;
    for (const [name, key] of [['Gasoline', 'gasoline'], ['Diesel', 'diesel'], ['Naphtha', 'naphtha']]) {
      assert.equal(productRow(response, name).outputLossKbd, round1(crudeLoss * GLOBAL_MEDIAN_REFINERY_YIELD[key]), name);
    }
    const basis = yieldLimitation(response);
    assert.match(basis, /^refinery yields: no JODI country yields for KR; global median used: gasoline 24\.2%, diesel 39\.4%, jet fuel 6\.9%, LPG 3\.6%, naphtha 8\.5%/);
    assert.ok(basis.includes(GLOBAL_MEDIAN_REFINERY_YIELD_SOURCE), basis);
  });

  it('CN: the limitation says total refinery output is the denominator and why', async (t) => {
    t.after(restoreEnergyShockEnvironment);
    installEnergyShockRedis(refineryYieldSeed('CN'));
    const response = await computeShock({ countryCode: 'CN', chokepointId: 'hormuz_strait', disruptionPct: 100, fuelMode: 'oil' });
    const basis = yieldLimitation(response);
    assert.match(basis, /^refinery yields: CN JODI product output ÷ total refinery output, 2025-09–2026-08 \(12 months\)/);
    assert.match(basis, /crude refinery intake is a balancing item/);
    assert.match(basis, /gasoline 23\.2%, diesel 25\.2%/);
  });

  it('a malformed yield is not trusted: out-of-range or non-numeric values fall back to the median', async (t) => {
    t.after(restoreEnergyShockEnvironment);
    const row = seededJodiRow('KR');
    row.refineryYields = { ...row.refineryYields, products: { ...row.refineryYields.products, gasoline: 1.4, diesel: '0.3', lpg: -0.1 } };
    installEnergyShockRedis(refineryYieldSeed('KR', row));
    const response = await computeShock({ countryCode: 'KR', chokepointId: 'hormuz_strait', disruptionPct: 100, fuelMode: 'oil' });
    const crudeLoss = row.crude.importsKbd * 0.7;
    assert.equal(productRow(response, 'Gasoline').outputLossKbd, round1(crudeLoss * GLOBAL_MEDIAN_REFINERY_YIELD.gasoline));
    assert.equal(productRow(response, 'Diesel').outputLossKbd, round1(crudeLoss * GLOBAL_MEDIAN_REFINERY_YIELD.diesel));
    assert.equal(productRow(response, 'LPG').outputLossKbd, round1(crudeLoss * GLOBAL_MEDIAN_REFINERY_YIELD.lpg));
  });

  it('ignores oil caches written with the US-average yields (v8)', async (t) => {
    t.after(restoreEnergyShockEnvironment);
    installEnergyShockRedis({
      ...refineryYieldSeed('KR'),
      'energy:shock:v8:KR:hormuz_strait:100:l:oil': { dataAvailable: true, assessment: 'v8 US-average yields', products: [] },
      'energy:shock:v8:KR:hormuz_strait:100:l:both': { dataAvailable: true, assessment: 'v8 US-average yields', products: [] },
    });
    for (const fuelMode of ['oil', 'both']) {
      const response = await computeShock({ countryCode: 'KR', chokepointId: 'hormuz_strait', disruptionPct: 100, fuelMode });
      assert.notEqual(response.assessment, 'v8 US-average yields', fuelMode);
      assert.ok(productRow(response, 'Naphtha'), fuelMode);
    }
  });
});

describe('GLOBAL_MEDIAN_REFINERY_YIELD', () => {
  it('is the measured JODI median, not the US average', () => {
    assert.deepEqual(GLOBAL_MEDIAN_REFINERY_YIELD, { gasoline: 0.242, diesel: 0.394, jet: 0.069, lpg: 0.036, naphtha: 0.085 });
    assert.match(GLOBAL_MEDIAN_REFINERY_YIELD_SOURCE, /44 JODI refiners/);
    assert.match(GLOBAL_MEDIAN_REFINERY_YIELD_SOURCE, /2026-10-28/);
  });
});

// ---------------------------------------------------------------------------
// Product shortfalls net product trade: exports are redirected home before
// demand is hit, and Gulf-origin product imports are lost with the route.
// ---------------------------------------------------------------------------

// UN Comtrade 2024 HS 2710 partner rows for KR (production key, 2026-10-28):
// AE + QA + KW + SA hold 46.1% of import value.
const KR_GULF_PRODUCT_SHARE = 0.461;
function productTradeSeed(iso2, row = seededJodiRow(iso2), { productShare = KR_GULF_PRODUCT_SHARE } = {}) {
  const seed = refineryYieldSeed(iso2, row);
  const partnersKey = `comtrade:bilateral-hs4-partners:${iso2}:v1`;
  if (productShare != null) {
    seed[partnersKey].products.push({ hs4: '2710', year: 2024, totalValue: 1000, partners: [{ partnerIso2: 'AE', partnerCode: 784, value: productShare * 1000 }, { partnerIso2: 'SG', partnerCode: 702, value: (1 - productShare) * 1000 }], omittedCount: 0, omittedShare: 0 });
  }
  return seed;
}
const balanceLine = (response, basis) => response.limitations.find((l) => l.startsWith(`product balance, ${basis}`));

describe('computeProductBalance', () => {
  it('nets exports before demand is hit and adds Gulf-origin import losses', () => {
    // KR diesel 2026-07, research example: 703.6 lost, 591.0 exported, 443.7 demand -> 25.4%.
    const diesel = computeProductBalance({ crudeLossKbd: 2125.8, yieldFactor: 0.331, demandKbd: 443.7, importsKbd: 0, exportsKbd: 591.0, gulfImportLossFactor: 0.461 });
    assert.deepEqual(Object.fromEntries(Object.entries(diesel).map(([k, v]) => [k, Math.round(v * 1e4) / 1e4])),
      { outputLossKbd: 703.6398, gulfImportLossKbd: 0, exportBufferKbd: 591, shortfallKbd: 112.6398, deficitPct: 25.3865 });
    const naphtha = computeProductBalance({ crudeLossKbd: 1000, yieldFactor: 0.2, demandKbd: 1000, importsKbd: 600, exportsKbd: 100, gulfImportLossFactor: 0.5 });
    assert.equal(naphtha.gulfImportLossKbd, 300);
    assert.equal(naphtha.shortfallKbd, 400);
    assert.equal(naphtha.deficitPct, 40);
  });

  it('exports above the loss leave no shortfall; unknown trade is never invented', () => {
    assert.equal(computeProductBalance({ crudeLossKbd: 2125.8, yieldFactor: 0.162, demandKbd: 160.9, importsKbd: 0, exportsKbd: 349.2, gulfImportLossFactor: null }).deficitPct, 0);
    const unknown = computeProductBalance({ crudeLossKbd: 100, yieldFactor: 0.5, demandKbd: 100, importsKbd: null, exportsKbd: null, gulfImportLossFactor: 0.5 });
    assert.deepEqual([unknown.gulfImportLossKbd, unknown.exportBufferKbd, unknown.deficitPct], [0, 0, 50]);
    assert.equal(computeProductBalance({ crudeLossKbd: 100, yieldFactor: 0.5, demandKbd: 100, importsKbd: 80, exportsKbd: 0, gulfImportLossFactor: null }).gulfImportLossKbd, 0, 'no attributed share, no import loss');
    assert.equal(computeProductBalance({ crudeLossKbd: 1000, yieldFactor: 0.5, demandKbd: 100, importsKbd: 0, exportsKbd: 0, gulfImportLossFactor: null }).deficitPct, 100, 'capped at 100%');
  });
});

describe('product shortfalls net product trade', () => {
  it('KR: pre-crisis exports cover the gasoline, diesel and jet losses; naphtha also loses its Gulf imports', async (t) => {
    t.after(restoreEnergyShockEnvironment);
    const row = seededJodiRow('KR');
    installEnergyShockRedis(productTradeSeed('KR', row));

    const response = await computeShock({ countryCode: 'KR', chokepointId: 'hormuz_strait', disruptionPct: 100, fuelMode: 'oil' });

    const crudeLoss = row.crude.importsKbd * 0.7;
    const pre = row.productTrade.preCrisisBaseline.products;
    for (const [name, key, gulfShare] of [['Gasoline', 'gasoline', KR_GULF_PRODUCT_SHARE], ['Diesel', 'diesel', KR_GULF_PRODUCT_SHARE], ['Jet fuel', 'jet', KR_GULF_PRODUCT_SHARE], ['LPG', 'lpg', null], ['Naphtha', 'naphtha', KR_GULF_PRODUCT_SHARE]]) {
      const p = productRow(response, name);
      const outputLoss = crudeLoss * row.refineryYields.products[key];
      const importLoss = gulfShare == null ? 0 : pre[key].importsKbd * gulfShare;
      const shortfall = Math.max(0, outputLoss + importLoss - pre[key].exportsKbd);
      assert.equal(p.outputLossKbd, round1(outputLoss), `${name} output loss`);
      assert.equal(p.demandKbd, round1(pre[key].demandKbd), `${name} demand is the pre-crisis average`);
      assert.equal(p.deficitPct, round1(Math.min(100, (shortfall / pre[key].demandKbd) * 100)), `${name} deficit`);
    }
    for (const name of ['Gasoline', 'Diesel', 'Jet fuel']) {
      assert.ok(productRow(response, name).deficitPct < 50, `${name}: Korea exports most of its output (was 100% gross)`);
    }
    assert.ok(productRow(response, 'Naphtha').deficitPct > 50, 'naphtha loses refinery output and Gulf imports');

    const line = balanceLine(response, 'pre-crisis baseline');
    assert.match(line, /^product balance, pre-crisis baseline \(2025-02–2026-01\): deficit = refinery output loss \+ Gulf-origin import loss − exports redirected home, ÷ demand, kb\/d averaged over the window: /);
    const jetOut = crudeLoss * row.refineryYields.products.jet;
    const jetShort = Math.max(0, jetOut - pre.jet.exportsKbd);
    assert.ok(line.includes(`jet fuel ${jetOut.toFixed(1)} + 0.0 − 252.8 = ${jetShort.toFixed(1)} of 157.7 (${(jetShort / 157.7 * 100).toFixed(1)}%)`), line);
    assert.ok(line.includes('LPG ') && /LPG [\d.]+ \+ n\/a − 5\.6/.test(line), `LPG imports are unattributed: ${line}`);
    assert.match(balanceLine(response, 'current flows'), /^product balance, current flows \(2026-06–2026-08, 3 months; crude loss as in the headline\): gasoline \d+\.\d%, diesel \d+\.\d%, jet fuel 0\.0%, LPG \d+\.\d%, naphtha \d+\.\d%\.$/);
    const imports = response.limitations.find((l) => l.startsWith('Gulf-origin product imports'));
    assert.match(imports, /UN Comtrade 2024 HS 2710 import value share from SA, AE, IQ, KW, IR, QA, BH: 46\.1%/);
    assert.match(imports, /LPG imports are not attributed/);
  });

  it('the current-flows line uses the latest 3 months of trade, not the pre-crisis averages', async (t) => {
    t.after(restoreEnergyShockEnvironment);
    const row = seededJodiRow('KR');
    installEnergyShockRedis(productTradeSeed('KR', row));
    const response = await computeShock({ countryCode: 'KR', chokepointId: 'hormuz_strait', disruptionPct: 100, fuelMode: 'oil' });
    const crudeLoss = row.crude.importsKbd * 0.7;
    const cur = row.productTrade.currentFlows.products.naphtha;
    const expected = Math.min(100, Math.max(0, crudeLoss * row.refineryYields.products.naphtha + cur.importsKbd * KR_GULF_PRODUCT_SHARE - cur.exportsKbd) / cur.demandKbd * 100);
    assert.match(balanceLine(response, 'current flows'), new RegExp(`naphtha ${expected.toFixed(1).replace('.', '\\.')}%`));
  });

  it('the current-flows line nets the current-flows crude loss when that share is measured (JP)', async (t) => {
    t.after(restoreEnergyShockEnvironment);
    const row = seededJodiRow('JP');
    installEnergyShockRedis({ ...productTradeSeed('JP', row), ...originSeed() });
    const response = await computeShock({ countryCode: 'JP', chokepointId: 'hormuz_strait', disruptionPct: 100, fuelMode: 'oil' });
    const cur = response.currentFlows;
    // The headline is after bypass rerouting; current flows get no bypass recovery.
    assert.ok(cur && cur.crudeLossKbd > 0 && cur.crudeLossKbd !== response.crudeLossKbd, JSON.stringify(cur));
    const line = balanceLine(response, 'current flows');
    assert.ok(line?.includes(`crude loss at the current-flows Gulf share, ${cur.crudeLossKbd} kbd`), line);
    const flows = row.productTrade.currentFlows.products.gasoline;
    const shortfall = Math.max(0, cur.crudeLossKbd * row.refineryYields.products.gasoline + (flows.importsKbd ?? 0) * KR_GULF_PRODUCT_SHARE - (flows.exportsKbd ?? 0));
    assert.match(line, new RegExp(`gasoline ${Math.min(100, shortfall / flows.demandKbd * 100).toFixed(1).replace('.', '\\.')}%`));
  });

  it('a JODI row without windowed trade nets the latest month and says so; no separate current-flows line', async (t) => {
    t.after(restoreEnergyShockEnvironment);
    const { productTrade, ...legacy } = seededJodiRow('KR');
    assert.ok(productTrade);
    installEnergyShockRedis(productTradeSeed('KR', legacy));

    const response = await computeShock({ countryCode: 'KR', chokepointId: 'hormuz_strait', disruptionPct: 100, fuelMode: 'oil' });

    const crudeLoss = legacy.crude.importsKbd * 0.7;
    const diesel = productRow(response, 'Diesel');
    assert.equal(diesel.demandKbd, round1(legacy.diesel.demandKbd));
    assert.equal(diesel.deficitPct, round1(Math.min(100, Math.max(0, crudeLoss * legacy.refineryYields.products.diesel - legacy.diesel.exportsKbd) / legacy.diesel.demandKbd * 100)));
    assert.match(balanceLine(response, 'latest month'), /^product balance, latest month \(2026-08; no usable pre-crisis product trade in this JODI row\)/);
    assert.equal(balanceLine(response, 'current flows'), undefined);
  });

  // Greptile on #9790: the basis label followed the window's presence, not
  // the rows that actually used it.
  it('a pre-crisis window without demand is labelled by the latest month the rows actually use', async (t) => {
    t.after(restoreEnergyShockEnvironment);
    const row = seededJodiRow('KR');
    const empty = Object.fromEntries(Object.keys(row.productTrade.preCrisisBaseline.products).map((k) => [k, { demandKbd: null, importsKbd: null, exportsKbd: null }]));
    row.productTrade = { ...row.productTrade, preCrisisBaseline: { ...row.productTrade.preCrisisBaseline, months: 3, products: empty } };
    installEnergyShockRedis(productTradeSeed('KR', row));

    const response = await computeShock({ countryCode: 'KR', chokepointId: 'hormuz_strait', disruptionPct: 100, fuelMode: 'oil' });

    assert.equal(productRow(response, 'Diesel').demandKbd, round1(row.diesel.demandKbd));
    assert.match(balanceLine(response, 'latest month'), /^product balance, latest month \(2026-08; no usable pre-crisis product trade in this JODI row\): /);
    assert.equal(balanceLine(response, 'pre-crisis baseline'), undefined);
    assert.equal(balanceLine(response, 'current flows'), undefined);
    const harness = await createCountryDeepDivePanelHarness();
    t.after(() => harness.cleanup());
    assert.match(harness.createPanel().renderShockResult(response).textContent, /\(latest month 2026-08; no usable pre-crisis product trade in this JODI row\)/);
  });

  it('when only some products fall back, the basis names the latest month and those products', async (t) => {
    t.after(restoreEnergyShockEnvironment);
    const row = seededJodiRow('KR');
    const pre = row.productTrade.preCrisisBaseline;
    row.productTrade = { ...row.productTrade, preCrisisBaseline: { ...pre, products: { ...pre.products, naphtha: { demandKbd: null, importsKbd: null, exportsKbd: null } } } };
    installEnergyShockRedis(productTradeSeed('KR', row));

    const response = await computeShock({ countryCode: 'KR', chokepointId: 'hormuz_strait', disruptionPct: 100, fuelMode: 'oil' });

    assert.equal(productRow(response, 'Naphtha').demandKbd, round1(row.naphtha.demandKbd));
    assert.equal(productRow(response, 'Gasoline').demandKbd, round1(pre.products.gasoline.demandKbd));
    assert.match(balanceLine(response, 'pre-crisis baseline'), /^product balance, pre-crisis baseline \(2025-02–2026-01; latest month 2026-08 for naphtha\): /);
    assert.ok(balanceLine(response, 'current flows'));
    const harness = await createCountryDeepDivePanelHarness();
    t.after(() => harness.cleanup());
    assert.match(harness.createPanel().renderShockResult(response).textContent, /\(pre-crisis baseline 2025-02–2026-01; latest month 2026-08 for naphtha\)/);
  });

  it('without HS 2710 partner rows only exports are netted, and the limitation says imports are not modeled', async (t) => {
    t.after(restoreEnergyShockEnvironment);
    const row = seededJodiRow('KR');
    installEnergyShockRedis(productTradeSeed('KR', row, { productShare: null }));
    const response = await computeShock({ countryCode: 'KR', chokepointId: 'hormuz_strait', disruptionPct: 100, fuelMode: 'oil' });
    const pre = row.productTrade.preCrisisBaseline.products.naphtha;
    const outputLoss = row.crude.importsKbd * 0.7 * row.refineryYields.products.naphtha;
    assert.equal(productRow(response, 'Naphtha').deficitPct, round1(Math.max(0, outputLoss - pre.exportsKbd) / pre.demandKbd * 100));
    assert.ok(response.limitations.some((l) => /^Gulf-origin product imports are not modeled for KR: no UN Comtrade partner-level HS 2710 import rows/.test(l)), response.limitations.join('\n'));
    // CodeRabbit on #9790: the table note must not claim an import loss the model did not add.
    const harness = await createCountryDeepDivePanelHarness();
    t.after(() => harness.cleanup());
    const text = harness.createPanel().renderShockResult(response).textContent;
    assert.match(text, /Deficit nets exports redirected home \(pre-crisis baseline 2025-02–2026-01\); see Model assumptions\./);
    assert.doesNotMatch(text, /adds lost Gulf-origin imports/);
  });

  it('gas-only mode drops the product-balance lines with the other oil limitations', async (t) => {
    t.after(restoreEnergyShockEnvironment);
    installEnergyShockRedis({ ...productTradeSeed('KR'), 'energy:jodi-gas:v1:KR': { lngImportsTj: 193604, pipeImportsTj: 0, totalDemandTj: 115795, lngShareOfImports: 1, dataMonth: '2026-07' } });
    const response = await computeShock({ countryCode: 'KR', chokepointId: 'hormuz_strait', disruptionPct: 100, fuelMode: 'gas' });
    assert.ok(!response.limitations.some((l) => /^product balance|^Gulf-origin product imports/.test(l)), response.limitations.join('\n'));
  });

  it('the Country brief table labels the refinery loss and says the deficit nets product trade', async (t) => {
    t.after(restoreEnergyShockEnvironment);
    installEnergyShockRedis(productTradeSeed('KR'));
    const response = await computeShock({ countryCode: 'KR', chokepointId: 'hormuz_strait', disruptionPct: 100, fuelMode: 'oil' });
    restoreEnergyShockEnvironment();
    const harness = await createCountryDeepDivePanelHarness();
    t.after(() => harness.cleanup());
    const text = harness.createPanel().renderShockResult(response).textContent;
    assert.match(text, /ProductDemandRefinery lossDeficit/);
    assert.match(text, /Deficit nets exports redirected home and adds lost Gulf-origin imports \(pre-crisis baseline 2025-02–2026-01\)/);
    assert.match(text, /Naphtha1193\.3 kbd/);
  });

  it('ignores oil caches written before product trade was netted (v9)', async (t) => {
    t.after(restoreEnergyShockEnvironment);
    installEnergyShockRedis({
      ...productTradeSeed('KR'),
      'energy:shock:v9:KR:hormuz_strait:100:l:oil': { dataAvailable: true, assessment: 'v9 gross deficits', products: [] },
      'energy:shock:v9-g2:KR:hormuz_strait:100:l:both': { dataAvailable: true, assessment: 'v9 gross deficits', products: [] },
    });
    for (const fuelMode of ['oil', 'both']) {
      const response = await computeShock({ countryCode: 'KR', chokepointId: 'hormuz_strait', disruptionPct: 100, fuelMode });
      assert.notEqual(response.assessment, 'v9 gross deficits', fuelMode);
    }
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
  // Before the measured Hormuz share, these captured inputs gave 6197.7 / 12395.4
  // TJ: 30% of DE's recorded LNG imports. UN Comtrade books every German LNG
  // import to partner 899 "Areas, nes" (recorded 2026-10-28), so the origin
  // share, and with it the Hormuz loss, is unavailable rather than assumed.
  for (const disruptionPct of [50, 100]) {
    it(`replays captured DE inputs at ${disruptionPct}% as an unavailable origin share, without old caches or endurance`, async (t) => {
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
        'comtrade:lng-hormuz-share:v1': { fetchedAt: '2026-10-28T09:00:00.000Z', countries: {
          DE: { preCrisis: null, preCrisisUnavailable: 'partners_unattributed', current: null, currentUnavailable: 'partners_unattributed' },
        } },
        [`energy:shock:v2:DE:hormuz_strait:${disruptionPct}:l:gas`]: old,
        [`energy:shock:v3:DE:hormuz_strait:${disruptionPct}:l:gas`]: old,
        [`energy:shock:v4:DE:hormuz_strait:${disruptionPct}:l:gas`]: old,
      });
      const response = await computeShock({ countryCode: 'DE', chokepointId: 'hormuz_strait', disruptionPct, fuelMode: 'gas' });
      assert.equal(response.gasSensitivity, undefined, 'no loss without a measured share');
      assert.equal(response.gasImpact, undefined, 'an old cached gasImpact response is not reused');
      assert.equal(response.dataAvailable, false);
      assert.equal(response.coverageLevel, 'unsupported');
      assert.notEqual(response.chokepointConfidence, 'high');
      assert.equal(response.assessment, 'LNG origin share unavailable for DE; Strait of Hormuz LNG exposure is not modeled.');
      assert.ok(response.limitations.some((l) => /LNG origin share unavailable for DE: UN Comtrade books more than 10% of its LNG imports to unspecified partners/.test(l)), response.limitations.join('\n'));
      assert.doesNotMatch(response.assessment, /30%|days|can bridge|low.*dependence|faces/i);
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
    it(`does not scale total loss by shipping flow ${flow}`, async (t) => {
      t.after(restoreEnergyShockEnvironment);
      installEnergyShockRedis({ ...(flow === null ? {} : liveChokepointSeed(flow)), ...US_GAS_SEED, ...lngShareSeed({ US: 0.3 }) });
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
      installEnergyShockRedis({ ...liveChokepointSeed(), ...lngShareSeed({ DE: 0.3 }),
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
    installEnergyShockRedis({ 'energy:jodi-gas:v1:DE': { lngImportsTj: 100, totalDemandTj: 1000 }, ...lngShareSeed({ DE: 0.3 }),
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
      ...lngShareSeed({ DE: 0.3 }),
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
    assert.equal(response.gasSensitivity.modelBasis, 'comtrade_lng_origin_share');
    assert.deepEqual(response.gasSensitivity.preCrisisBaseline, {
      basis: 'comtrade_annual', fromMonth: '2025-01', toMonth: '2025-12', monthsCovered: 12, hormuzLngShare: 0.3, lngDisruptionTj: 300,
    }, 'the baseline survives the generated client');
    assert.equal(response.gasSensitivity.currentFlows, undefined);
    assert.equal(Object.hasOwn(response, 'gasImpact'), false);
    const { assessment, dataAvailable, gasImpact } = await Response.json(response).json();
    assert.equal(dataAvailable, true);
    assert.equal(gasImpact, undefined);
    assert.match(assessment, /6.0% of JODI demand/);
    assert.match(assessment, /not a supply-shortage forecast/);
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
        // Kuwait has no Hormuz bypass, so no rerouting reduces the loss.
        'comtrade:bilateral-hs4-partners:DE:v1': { iso2: 'DE', products: [{ hs4: '2709', year: 2024, totalValue: 1000, partners: [{ partnerIso2: 'KW', partnerCode: 414, value: 400 }, { partnerIso2: 'US', partnerCode: 842, value: 600 }], omittedCount: 0, omittedShare: 0 }] },
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

  it('isolates old oil, both and gas caches', async (t) => {
    t.after(restoreEnergyShockEnvironment);
    const request = { countryCode: 'US', chokepointId: 'hormuz_strait', disruptionPct: 100 };
    installEnergyShockRedis({ ...liveChokepointSeed(), ...US_GAS_SEED, ...lngShareSeed({ US: 0.3 }),
      'energy:jodi-oil:v1:US': { crude: { importsKbd: null }, diesel: { demandKbd: 80 } },
      'energy:shock:v2:US:hormuz_strait:100:l:oil': { dataAvailable: true, assessment: 'old oil' },
      'energy:shock:v4:US:hormuz_strait:100:l:both': { dataAvailable: false, assessment: 'old both' },
      // Written by the assumed 30% route model; the measured Hormuz share replaces it.
      'energy:shock:v4:US:hormuz_strait:100:l:gas': { dataAvailable: true, assessment: 'old gas' },
    });
    const oil = await computeShock({ ...request, fuelMode: 'oil' });
    assert.equal(oil.dataAvailable, false);
    assert.notEqual(oil.assessment, 'old oil');
    const both = await computeShock({ ...request, fuelMode: 'both' });
    assert.equal(both.dataAvailable, true);
    assert.equal(both.gasSensitivity.dataAvailable, true);
    assert.notEqual(both.assessment, 'old both');
    const gas = await computeShock({ ...request, fuelMode: 'gas' });
    assert.notEqual(gas.assessment, 'old gas');
    assert.equal(gas.gasSensitivity.modelBasis, 'comtrade_lng_origin_share');
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
    const before = response.preCrisisBaseline.crudeLossKbd;
    assert.ok(Math.abs(before - JP_CRUDE_IMPORTS_KBD * JP_GULF_SHARE) < 0.1, `loss before bypass ${before} must be imports × measured share`);
    // Bypass rerouting (Saudi and UAE) lowers the headline; cover draws the first month at the before-bypass rate.
    assert.equal(response.crudeLossKbd, response.preCrisisBaseline.crudeLossAfterBypassKbd);
    assert.ok(response.crudeLossKbd < before);
    assert.ok(Math.abs(response.effectiveCoverDays - computeEffectiveCoverDaysWithRamp(178, false, before, response.crudeLossKbd, JP_CRUDE_IMPORTS_KBD)) <= 1, `cover ${response.effectiveCoverDays}`);
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
      // India's measured pre-crisis Hormuz LNG share (UN Comtrade, recorded 2026-10-28).
      ...lngShareSeed({ IN: 0.5824 }),
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
      // UN Comtrade books every German LNG import to "Areas, nes" (recorded 2026-10-28).
      'comtrade:lng-hormuz-share:v1': { countries: { DE: { preCrisis: null, preCrisisUnavailable: 'partners_unattributed', current: null, currentUnavailable: 'partners_unattributed' } } },
    });

    const response = await computeShock({ countryCode: 'DE', chokepointId: 'hormuz_strait', disruptionPct: 100, fuelMode: 'both' });

    assert.equal(response.ieaStocksCoverage, true);
    // Neither origin is measured, so neither fuel's Hormuz loss is modeled.
    assert.equal(response.dataAvailable, false);
    assert.equal(response.gasSensitivity, undefined);
    assert.ok(response.limitations.some((l) => /LNG origin share unavailable for DE/.test(l)), response.limitations.join('\n'));
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
// Pre-crisis and current-flows baselines (follow-up to #9781). The 2024
// annual value share put Japan at 94.6% Gulf while METI measured 60.7% Middle
// East in Aug 2026. Both figures are now reported, each labelled: the
// pre-crisis baseline (the 12 full months before the Hormuz crisis) drives the
// headline "if it closed" numbers, and current flows (the latest 3 importer
// filings since 2026-03) are shown beside it. Inputs are the importers' own
// Comtrade monthly HS 2709 declarations, recorded 2026-10-28.
// ---------------------------------------------------------------------------

const ORIGIN_FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/energy-shock/comtrade-crude-origin-2026-10-28.json', import.meta.url), 'utf8'));
const ORIGIN_MONTHS = crudeImportOriginPeriods(Date.parse('2026-10-28T12:00:00Z')).flat();
const ORIGIN_SECTION = {
  status: 'ok',
  fetchedAt: '2026-10-28T03:00:00.000Z',
  source: 'UN Comtrade monthly HS 2709 imports declared by each importer',
  months: ORIGIN_MONTHS,
  importers: buildCrudeImportOrigin(ORIGIN_FIXTURE.rows, ORIGIN_MONTHS),
};
const originSeed = (section = ORIGIN_SECTION) => ({ 'energy:oil-trade-series:v1': { countries: {}, crudeImportOrigin: section } });

describe('computeMonthlyGulfShares', () => {
  const months = ['2025-02', '2025-03', '2025-04', '2025-05', '2025-06', '2025-07', '2025-08', '2025-09', '2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05'];
  const origin = (worldUsdM, gulfUsdM) => ({ status: 'ok', months, importers: { XX: { worldUsdM, gulfUsdM } } });

  it('pre-crisis share is the Gulf sum over the World sum across the filed months of 2025-02..2026-01', () => {
    const world = months.map(() => 100);
    const gulf = months.map((m) => (m < '2026-02' ? 50 : 10));
    const { preCrisis } = computeMonthlyGulfShares(origin(world, gulf), 'XX');
    assert.deepEqual(preCrisis, { share: 0.5, fromMonth: '2025-02', toMonth: '2026-01', monthsCovered: 12 });
  });

  it('pre-crisis needs at least 9 of the 12 months filed', () => {
    const world = months.map((m, i) => (i < 8 ? 100 : null));
    const gulf = world.map((w) => (w == null ? null : 50));
    assert.equal(computeMonthlyGulfShares(origin(world, gulf), 'XX').preCrisis, null);
  });

  it('current flows are the latest 3 filings since 2026-03; February 2026 never counts', () => {
    const world = months.map(() => 100);
    const gulf = months.map((m) => (m >= '2026-03' ? 20 : m === '2026-02' ? 90 : 50));
    assert.deepEqual(computeMonthlyGulfShares(origin(world, gulf), 'XX').current, { share: 0.2, fromMonth: '2026-03', toMonth: '2026-05', monthsCovered: 3 });
    const twoMonths = world.map((w, i) => (months[i] === '2026-05' ? null : w));
    assert.equal(computeMonthlyGulfShares(origin(twoMonths, gulf), 'XX').current, null, 'two crisis-period filings are not a 3-month current figure');
  });

  it('an importer whose filings stop before the crisis has no current figure (Korea after 2025-12)', () => {
    const world = months.map((m) => (m <= '2025-12' ? 100 : null));
    const gulf = world.map((w) => (w == null ? null : 70));
    const shares = computeMonthlyGulfShares(origin(world, gulf), 'XX');
    assert.equal(shares.preCrisis?.monthsCovered, 11);
    assert.equal(shares.current, null);
  });

  it('a missing importer or malformed section yields no monthly share', () => {
    assert.deepEqual(computeMonthlyGulfShares(origin(months.map(() => 1), months.map(() => 1)), 'JP'), { preCrisis: null, current: null });
    assert.deepEqual(computeMonthlyGulfShares(null, 'JP'), { preCrisis: null, current: null });
    assert.deepEqual(computeMonthlyGulfShares({ months: 'x', importers: {} }, 'JP'), { preCrisis: null, current: null });
  });
});

describe('pre-crisis and current-flows Gulf share baselines (Comtrade monthly, recorded 2026-10-28)', () => {
  it('Japan: headline uses the pre-crisis 92.7% share; current flows (Jun-Aug 2026) 60.5% are reported beside it', async (t) => {
    t.after(restoreEnergyShockEnvironment);
    installEnergyShockRedis({ ...HORMUZ_LIVE_SEED, ...JP_PROD_SEED, ...originSeed() });

    const r = await computeShock({ countryCode: 'JP', chokepointId: 'hormuz_strait', disruptionPct: 100, fuelMode: 'oil' });

    const pre = r.preCrisisBaseline;
    const cur = r.currentFlows;
    assert.ok(pre && cur, 'both baselines are reported');
    assert.deepEqual({ basis: pre.basis, fromMonth: pre.fromMonth, toMonth: pre.toMonth, monthsCovered: pre.monthsCovered },
      { basis: 'comtrade_monthly', fromMonth: '2025-02', toMonth: '2026-01', monthsCovered: 12 });
    assert.ok(Math.abs(pre.gulfCrudeShare - 0.927) < 0.001, `pre-crisis ${pre.gulfCrudeShare}`);
    assert.deepEqual({ basis: cur.basis, fromMonth: cur.fromMonth, toMonth: cur.toMonth, monthsCovered: cur.monthsCovered },
      { basis: 'comtrade_monthly', fromMonth: '2026-06', toMonth: '2026-08', monthsCovered: 3 });
    assert.ok(Math.abs(cur.gulfCrudeShare - 0.605) < 0.001, `current ${cur.gulfCrudeShare}`);

    // The headline figures are the pre-crisis baseline, not the 2024 annual 94.6%.
    // The headline loss is that baseline after Hormuz bypass rerouting.
    assert.equal(r.gulfCrudeShare, pre.gulfCrudeShare);
    assert.equal(r.crudeLossKbd, pre.crudeLossAfterBypassKbd);
    assert.ok(Math.abs(pre.crudeLossKbd - JP_CRUDE_IMPORTS_KBD * 0.927) < 2, `pre-crisis loss ${pre.crudeLossKbd}`);
    assert.ok(Math.abs(cur.crudeLossKbd - JP_CRUDE_IMPORTS_KBD * 0.605) < 2, `current loss ${cur.crudeLossKbd}`);
    assert.ok(Math.abs(r.effectiveCoverDays - computeEffectiveCoverDaysWithRamp(178, false, pre.crudeLossKbd, r.crudeLossKbd, JP_CRUDE_IMPORTS_KBD)) <= 1, `cover ${r.effectiveCoverDays}`);

    assert.ok(r.limitations.some((l) => /pre-crisis baseline/.test(l) && /2025-02\.\.2026-01/.test(l) && /12 of 12 months/.test(l) && /JODI crude imports for 2026-07/.test(l)), r.limitations.join('\n'));
    assert.ok(r.limitations.some((l) => /^Current flows/.test(l) && /2026-06\.\.2026-08/.test(l) && /60\.5%/.test(l) && /not used for the products table or cover/.test(l)), r.limitations.join('\n'));
    assert.match(r.assessment, /pre-crisis supply mix/);
  });

  it('a cached v8, v9 or v10 response (annual share, no baselines) is not served after the change', async (t) => {
    t.after(restoreEnergyShockEnvironment);
    installEnergyShockRedis({
      ...HORMUZ_LIVE_SEED, ...JP_PROD_SEED, ...originSeed(),
      'energy:shock:v8:JP:hormuz_strait:100:l:oil': { countryCode: 'JP', gulfCrudeShare: 0.946, limitations: [] },
      // v9 (per-country refinery yields) and v10 (product-trade netting) are main's, still on the annual share.
      'energy:shock:v9:JP:hormuz_strait:100:l:oil': { countryCode: 'JP', gulfCrudeShare: 0.946, limitations: [] },
      'energy:shock:v10:JP:hormuz_strait:100:l:oil': { countryCode: 'JP', gulfCrudeShare: 0.946, limitations: [] },
    });
    const r = await computeShock({ countryCode: 'JP', chokepointId: 'hormuz_strait', disruptionPct: 100, fuelMode: 'oil' });
    assert.ok(r.preCrisisBaseline, 'a stale v8, v9 or v10 entry must not answer');
  });

  it('Korea: pre-crisis from 11 monthly filings; no current figure because Korea files nothing since 2025-12', async (t) => {
    t.after(restoreEnergyShockEnvironment);
    installEnergyShockRedis({
      ...HORMUZ_LIVE_SEED, ...originSeed(),
      'energy:jodi-oil:v1:KR': { iso2: 'KR', dataMonth: '2026-07', crude: { importsKbd: 3005.8 }, gasoline: { demandKbd: 285.9 }, diesel: { demandKbd: 443.7 } },
      'energy:iea-oil-stocks:v1:KR': { daysOfCover: 214, netExporter: false, anomaly: false },
      ...partnersSeed('KR', 1000, [{ partnerCode: 682, partnerIso2: 'SA', value: 707 }, { partnerCode: 842, partnerIso2: 'US', value: 293 }]),
    });
    const r = await computeShock({ countryCode: 'KR', chokepointId: 'hormuz_strait', disruptionPct: 100, fuelMode: 'oil' });
    assert.equal(r.preCrisisBaseline?.basis, 'comtrade_monthly');
    assert.equal(r.preCrisisBaseline?.monthsCovered, 11);
    assert.ok(Math.abs(r.preCrisisBaseline.gulfCrudeShare - 0.686) < 0.001, `${r.preCrisisBaseline.gulfCrudeShare}`);
    assert.equal(r.currentFlows, undefined);
    assert.ok(r.limitations.some((l) => /Current flows unavailable for KR/.test(l) && /since 2026-03/.test(l)), r.limitations.join('\n'));
  });

  it('China: no monthly filings, so the pre-crisis baseline is the labelled 2024 annual share and current flows are unavailable', async (t) => {
    t.after(restoreEnergyShockEnvironment);
    installEnergyShockRedis({
      ...HORMUZ_LIVE_SEED, ...originSeed(),
      'energy:jodi-oil:v1:CN': { iso2: 'CN', dataMonth: '2026-08', crude: { importsKbd: 8955.9 }, gasoline: { demandKbd: 3300 }, diesel: { demandKbd: 3500 } },
      ...partnersSeed('CN', 1000, [{ partnerCode: 682, partnerIso2: 'SA', value: 200 }, { partnerCode: 368, partnerIso2: 'IQ', value: 178 }, { partnerCode: 643, partnerIso2: 'RU', value: 622 }]),
    });
    const r = await computeShock({ countryCode: 'CN', chokepointId: 'hormuz_strait', disruptionPct: 100, fuelMode: 'oil' });
    assert.deepEqual({ basis: r.preCrisisBaseline?.basis, fromMonth: r.preCrisisBaseline?.fromMonth, toMonth: r.preCrisisBaseline?.toMonth },
      { basis: 'comtrade_annual', fromMonth: '2024-01', toMonth: '2024-12' });
    assert.equal(r.preCrisisBaseline.gulfCrudeShare, 0.378);
    assert.equal(r.gulfCrudeShare, 0.378);
    assert.equal(r.currentFlows, undefined);
    assert.ok(r.limitations.some((l) => /pre-crisis baseline/.test(l) && /UN Comtrade 2024 annual/.test(l) && /no UN Comtrade monthly crude filings for CN in 2025-02\.\.2026-01/.test(l)), r.limitations.join('\n'));
    assert.ok(r.limitations.some((l) => /Current flows unavailable for CN/.test(l)), r.limitations.join('\n'));
    assert.match(r.assessment, /2024 supply mix/);
  });

  it('India without JODI imports: both shares are measured, both losses are not modeled', async (t) => {
    t.after(restoreEnergyShockEnvironment);
    installEnergyShockRedis({ ...HORMUZ_LIVE_SEED, ...originSeed(), ...partnersSeed('IN', IN_TOTAL_2709, IN_PARTNERS_2709) });
    const r = await computeShock({ countryCode: 'IN', chokepointId: 'hormuz_strait', disruptionPct: 100, fuelMode: 'oil' });
    assert.ok(Math.abs(r.preCrisisBaseline.gulfCrudeShare - 0.482) < 0.001);
    assert.ok(Math.abs(r.currentFlows.gulfCrudeShare - 0.261) < 0.001);
    assert.equal(r.preCrisisBaseline.crudeLossKbd, 0);
    assert.equal(r.currentFlows.crudeLossKbd, 0);
    assert.equal(r.dataAvailable, false);
  });

  it('United States: 8.9% pre-crisis, 1.9% in May-Jul 2026; loss scales with disruption_pct under both', async (t) => {
    t.after(restoreEnergyShockEnvironment);
    installEnergyShockRedis({
      ...HORMUZ_LIVE_SEED, ...originSeed(),
      'energy:jodi-oil:v1:US': { dataMonth: '2026-07', crude: { importsKbd: 5888 }, gasoline: { demandKbd: 9316.5 }, diesel: { demandKbd: 3627.3 } },
      'energy:iea-oil-stocks:v1:US': { daysOfCover: null, netExporter: true, anomaly: false },
    });
    const r = await computeShock({ countryCode: 'US', chokepointId: 'hormuz_strait', disruptionPct: 50, fuelMode: 'oil' });
    assert.ok(Math.abs(r.preCrisisBaseline.gulfCrudeShare - 0.089) < 0.001);
    assert.equal(r.currentFlows.fromMonth, '2026-05');
    assert.ok(Math.abs(r.currentFlows.gulfCrudeShare - 0.019) < 0.001);
    // The reported share is rounded to 3 decimals; the loss uses the unrounded share.
    const tolerance = 5888 * 0.0005 * 0.5 + 0.1;
    assert.ok(Math.abs(r.preCrisisBaseline.crudeLossKbd - 5888 * r.preCrisisBaseline.gulfCrudeShare * 0.5) < tolerance);
    assert.ok(Math.abs(r.currentFlows.crudeLossKbd - 5888 * r.currentFlows.gulfCrudeShare * 0.5) < tolerance);
    assert.equal(r.comtradeCoverage, true, 'a monthly share is Comtrade coverage without any annual partner row');
  });

  it('a carried-forward section keeps the fixed pre-crisis baseline but withholds current flows', async (t) => {
    t.after(restoreEnergyShockEnvironment);
    installEnergyShockRedis({ ...HORMUZ_LIVE_SEED, ...JP_PROD_SEED, ...originSeed({ ...ORIGIN_SECTION, status: 'unavailable', carriedForward: true }) });
    const r = await computeShock({ countryCode: 'JP', chokepointId: 'hormuz_strait', disruptionPct: 100, fuelMode: 'oil' });
    assert.equal(r.preCrisisBaseline?.basis, 'comtrade_monthly');
    assert.ok(r.limitations.some((l) => /carried forward from the 2026-10-28 fetch/.test(l)), r.limitations.join('\n'));
    // The latest filings from a failed refresh are not current data.
    assert.equal(r.currentFlows, undefined);
    assert.ok(r.limitations.some((l) => /Current flows unavailable for JP: the latest monthly UN Comtrade fetch failed/.test(l)), r.limitations.join('\n'));
  });

  it('gas-only mode carries no oil baselines', async (t) => {
    t.after(restoreEnergyShockEnvironment);
    installEnergyShockRedis({ ...HORMUZ_LIVE_SEED, ...JP_PROD_SEED, ...originSeed(), 'energy:jodi-gas:v1:JP': { lngImportsTj: 274197, totalDemandTj: 299947, dataMonth: '2026-07' } });
    const r = await computeShock({ countryCode: 'JP', chokepointId: 'hormuz_strait', disruptionPct: 100, fuelMode: 'gas' });
    assert.equal(r.preCrisisBaseline, undefined);
    assert.equal(r.currentFlows, undefined);
    assert.ok(!r.limitations.some((l) => /pre-crisis baseline|Current flows/.test(l)), r.limitations.join('\n'));
  });

  it('without the monthly section the pre-crisis baseline is the labelled annual share (production before the first seeder run)', async (t) => {
    t.after(restoreEnergyShockEnvironment);
    installEnergyShockRedis({ ...HORMUZ_LIVE_SEED, ...JP_PROD_SEED });
    const r = await computeShock({ countryCode: 'JP', chokepointId: 'hormuz_strait', disruptionPct: 100, fuelMode: 'oil' });
    assert.equal(r.preCrisisBaseline?.basis, 'comtrade_annual');
    assert.ok(Math.abs(r.gulfCrudeShare - JP_GULF_SHARE) < 0.001);
    assert.equal(r.currentFlows, undefined);
    // A missing series is not the same claim as "Japan filed nothing".
    assert.ok(!r.limitations.some((l) => /no UN Comtrade monthly crude filings for JP|fewer than 3 UN Comtrade monthly/.test(l)), r.limitations.join('\n'));
    assert.ok(r.limitations.some((l) => /pre-crisis baseline/.test(l) && /UN Comtrade 2024 annual/.test(l) && /monthly UN Comtrade crude-origin series is not available/.test(l)), r.limitations.join('\n'));
    assert.ok(r.limitations.some((l) => /Current flows unavailable for JP: the monthly UN Comtrade crude-origin series is not available/.test(l)), r.limitations.join('\n'));
  });

  it('an importer with too few pre-crisis filings falls back to the annual share and says why', async (t) => {
    t.after(restoreEnergyShockEnvironment);
    const months = ORIGIN_SECTION.months;
    const sparse = months.map((m) => (m >= '2025-02' && m <= '2025-07' ? 100 : null));
    installEnergyShockRedis({
      ...HORMUZ_LIVE_SEED, ...JP_PROD_SEED,
      ...originSeed({ ...ORIGIN_SECTION, importers: { ...ORIGIN_SECTION.importers, JP: { worldUsdM: sparse, gulfUsdM: sparse.map((v) => (v == null ? null : 90)) } } }),
    });
    const r = await computeShock({ countryCode: 'JP', chokepointId: 'hormuz_strait', disruptionPct: 100, fuelMode: 'oil' });
    assert.equal(r.preCrisisBaseline?.basis, 'comtrade_annual');
    assert.ok(r.limitations.some((l) => /fewer than 9 of the 12 months 2025-02\.\.2026-01 have UN Comtrade monthly crude filings for JP/.test(l)), r.limitations.join('\n'));
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
    const scenario = await computeShock({ countryCode: 'JP', chokepointId: 'hormuz_strait', disruptionPct: 100, fuelMode: 'oil' });
    assert.equal(result.coverageDays, scenario.effectiveCoverDays);
    assert.ok(result.coverageDays > Math.round(178 / JP_GULF_SHARE), 'bypass rerouting stretches cover beyond the no-bypass figure');
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
    const scenario = await computeShock({ countryCode: 'JP', chokepointId: 'hormuz_strait', disruptionPct: 100, fuelMode: 'oil' });
    assert.equal(result.coverageDays, scenario.effectiveCoverDays);
    assert.ok(result.coverageDays > 0);
    assert.match(result.unavailableReason, /supplyDeficitPct is unavailable: no refined-product demand observation for JP/);
    assert.match(result.unavailableReason, /coverageDays is modelled/);
  });
});
