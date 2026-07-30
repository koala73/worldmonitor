import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeFlowWeightedExposures,
  computeCountryLevelExposure,
} from '../scripts/seed-hs2-chokepoint-exposure.mjs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const CLUSTERS = require('../scripts/shared/country-port-clusters.json');

function getCluster(iso2) {
  const c = CLUSTERS[iso2];
  if (!c || typeof c === 'string') return { nearestRouteIds: [], coastSide: 'unknown' };
  return c;
}

// Mock Comtrade data: Turkey imports
const TURKEY_COMTRADE = [
  {
    hs4: '2709', description: 'Crude Petroleum', totalValue: 10_000_000,
    topExporters: [
      { partnerCode: 682, partnerIso2: 'SA', value: 4_000_000, share: 0.4 },
      { partnerCode: 643, partnerIso2: 'RU', value: 3_000_000, share: 0.3 },
      { partnerCode: 368, partnerIso2: 'IQ', value: 2_000_000, share: 0.2 },
    ],
    year: 2023,
  },
  {
    hs4: '8542', description: 'Semiconductors', totalValue: 5_000_000,
    topExporters: [
      { partnerCode: 158, partnerIso2: 'TW', value: 2_000_000, share: 0.4 },
      { partnerCode: 156, partnerIso2: 'CN', value: 1_500_000, share: 0.3 },
      { partnerCode: 410, partnerIso2: 'KR', value: 1_000_000, share: 0.2 },
    ],
    year: 2023,
  },
  {
    hs4: '6204', description: 'Garments', totalValue: 2_000_000,
    topExporters: [
      { partnerCode: 156, partnerIso2: 'CN', value: 1_000_000, share: 0.5 },
      { partnerCode: 50, partnerIso2: 'BD', value: 600_000, share: 0.3 },
    ],
    year: 2023,
  },
];

// Mock Comtrade data: US imports
const US_COMTRADE = [
  {
    hs4: '2709', description: 'Crude Petroleum', totalValue: 100_000_000,
    topExporters: [
      { partnerCode: 682, partnerIso2: 'SA', value: 30_000_000, share: 0.3 },
      { partnerCode: 124, partnerIso2: 'CA', value: 50_000_000, share: 0.5 },
    ],
    year: 2023,
  },
  {
    hs4: '8542', description: 'Semiconductors', totalValue: 50_000_000,
    topExporters: [
      { partnerCode: 158, partnerIso2: 'TW', value: 20_000_000, share: 0.4 },
      { partnerCode: 156, partnerIso2: 'CN', value: 15_000_000, share: 0.3 },
      { partnerCode: 410, partnerIso2: 'KR', value: 10_000_000, share: 0.2 },
    ],
    year: 2023,
  },
];

describe('computeFlowWeightedExposures (seed)', () => {
  it('Turkey: Energy and Electronics produce different vulnerability indices', () => {
    const energy = computeFlowWeightedExposures('TR', '27', TURKEY_COMTRADE);
    const elec = computeFlowWeightedExposures('TR', '85', TURKEY_COMTRADE);

    assert.ok(energy.length > 0, 'Energy should have exposures');
    assert.ok(elec.length > 0, 'Electronics should have exposures');

    const energyVuln = energy.slice(0, 3).reduce((s, e, i) => s + e.exposureScore * [0.5, 0.3, 0.2][i], 0);
    const elecVuln = elec.slice(0, 3).reduce((s, e, i) => s + e.exposureScore * [0.5, 0.3, 0.2][i], 0);
    assert.notEqual(Math.round(energyVuln * 10) / 10, Math.round(elecVuln * 10) / 10,
      'Energy and Electronics vulnerability indices must differ');
  });

  it('Turkey: at least 2 of 3 sectors have different top chokepoints or scores', () => {
    const energy = computeFlowWeightedExposures('TR', '27', TURKEY_COMTRADE);
    const elec = computeFlowWeightedExposures('TR', '85', TURKEY_COMTRADE);
    const apparel = computeFlowWeightedExposures('TR', '62', TURKEY_COMTRADE);

    const tops = [energy[0], elec[0], apparel[0]].filter(Boolean);
    const uniqueScores = new Set(tops.map(t => `${t.chokepointId}:${t.exposureScore}`));
    assert.ok(uniqueScores.size >= 2, `At least 2 unique top chokepoint+score combos expected, got ${uniqueScores.size}`);
  });

  it('US: Energy and Electronics have different Hormuz exposure', () => {
    const energy = computeFlowWeightedExposures('US', '27', US_COMTRADE);
    const elec = computeFlowWeightedExposures('US', '85', US_COMTRADE);

    const energyHormuz = energy.find(e => e.chokepointId === 'hormuz_strait');
    const elecHormuz = elec.find(e => e.chokepointId === 'hormuz_strait');

    assert.ok(energyHormuz, 'Energy should have Hormuz entry');
    assert.ok(elecHormuz, 'Electronics should have Hormuz entry');
    assert.notEqual(energyHormuz.exposureScore, elecHormuz.exposureScore,
      'Energy and Electronics Hormuz scores must differ (different exporter mixes)');
  });

  it('no matching HS4 rows returns empty', () => {
    const result = computeFlowWeightedExposures('TR', '99', TURKEY_COMTRADE);
    assert.equal(result.length, 0);
  });

  it('unknown partnerIso2 is skipped gracefully', () => {
    const badData = [{
      hs4: '2709', description: 'Crude', totalValue: 1_000_000,
      topExporters: [
        { partnerCode: 999, partnerIso2: '', value: 500_000, share: 0.5 },
        { partnerCode: 682, partnerIso2: 'SA', value: 500_000, share: 0.5 },
      ],
      year: 2023,
    }];
    const result = computeFlowWeightedExposures('TR', '27', badData);
    assert.ok(result.length > 0, 'Should still produce results from valid exporter');
  });

  it('energy boost never exceeds 100', () => {
    const energy = computeFlowWeightedExposures('TR', '27', TURKEY_COMTRADE);
    for (const e of energy) {
      assert.ok(e.exposureScore <= 100, `Score ${e.exposureScore} for ${e.chokepointId} exceeds 100`);
    }
  });

  it('all scores in 0-100 range', () => {
    const result = computeFlowWeightedExposures('TR', '27', TURKEY_COMTRADE);
    for (const e of result) {
      assert.ok(e.exposureScore >= 0 && e.exposureScore <= 100,
        `Score ${e.exposureScore} for ${e.chokepointId} out of range`);
    }
  });
});

describe('computeCountryLevelExposure (seed fallback)', () => {
  it('produces non-empty exposures for countries with routes', () => {
    const trCluster = getCluster('TR');
    const result = computeCountryLevelExposure(trCluster.nearestRouteIds, trCluster.coastSide, '27');
    assert.ok(result.exposures.length > 0);
    assert.ok(result.primaryChokepointId !== '');
  });

  it('non-energy sectors produce identical scores (the original bug)', () => {
    const trCluster = getCluster('TR');
    const elec = computeCountryLevelExposure(trCluster.nearestRouteIds, trCluster.coastSide, '85');
    const apparel = computeCountryLevelExposure(trCluster.nearestRouteIds, trCluster.coastSide, '62');
    assert.deepEqual(
      elec.exposures.map(e => e.exposureScore),
      apparel.exposures.map(e => e.exposureScore),
      'Fallback should give identical scores for non-energy sectors (demonstrating the old bug)',
    );
  });

  it('energy boost clamps to 100', () => {
    const trCluster = getCluster('TR');
    const result = computeCountryLevelExposure(trCluster.nearestRouteIds, trCluster.coastSide, '27');
    for (const e of result.exposures) {
      assert.ok(e.exposureScore <= 100, `Fallback score ${e.exposureScore} exceeds 100`);
    }
  });
});

describe('algorithm parity with handler', () => {
  it('seed flow-weighted matches handler algorithm (union-based route coverage)', () => {
    // The handler (chokepoint-exposure-utils.ts) uses:
    //   if (importerRoutes.has(r) || exporterRoutes.has(r)) overlap++
    // Verify the seed produces the same pattern: SA→TR Energy should show
    // Hormuz (SA exporter route) even though TR importer doesn't have Gulf routes
    const energy = computeFlowWeightedExposures('TR', '27', TURKEY_COMTRADE);
    const hormuz = energy.find(e => e.chokepointId === 'hormuz_strait');
    assert.ok(hormuz && hormuz.exposureScore > 0,
      'Hormuz should appear from SA exporter routes via union-based coverage');
  });
});
