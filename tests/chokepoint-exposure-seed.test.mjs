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

  it('names no primary chokepoint when no nearby route crosses one', () => {
    assert.equal(computeCountryLevelExposure([], 'landlocked', '10').primaryChokepointId, '');
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

describe('bilateral chokepoint transit', () => {
  const hormuzScore = (importer, hs2, products) =>
    computeFlowWeightedExposures(importer, hs2, products).find(e => e.chokepointId === 'hormuz_strait').exposureScore;
  const product = (hs4, exporters) => [{
    hs4, description: hs4, totalValue: 1_000_000, year: 2024,
    topExporters: exporters.map(([partnerIso2, share]) => ({ partnerCode: 0, partnerIso2, value: share * 1_000_000, share })),
  }];

  it('a nearby Gulf corridor alone does not put an importer behind Hormuz', () => {
    assert.equal(hormuzScore('DJ', '12', product('1201', [['US', 0.6], ['BR', 0.4]])), 0, 'Djibouti soybeans from the Americas');
    assert.equal(hormuzScore('TR', '26', product('2612', [['KZ', 0.5], ['RU', 0.3], ['CA', 0.2]])), 0, 'Türkiye uranium ore');
    assert.equal(hormuzScore('MO', '27', product('2711', [['AU', 1]])), 0, 'Macao LNG from Australia');
  });

  it('counts a supplier share when exactly one partner is inside the Gulf', () => {
    assert.equal(hormuzScore('MO', '27', product('2711', [['QA', 0.4], ['AU', 0.6]])), 60, 'Qatari LNG share, energy-boosted');
    assert.equal(hormuzScore('IQ', '81', product('8112', [['CN', 0.7], ['SA', 0.3]])), 70, 'Saudi-Iraqi trade stays inside the Gulf');
    assert.equal(hormuzScore('US', '27', product('2709', [['SA', 0.3], ['CA', 0.7]])), 45, 'Saudi crude to the US');
  });

  it('splits a supplier share across alternative corridors instead of crediting each in full', () => {
    const exposures = computeFlowWeightedExposures('US', '85', product('8542', [['CN', 1]]));
    const score = id => exposures.find(e => e.chokepointId === id).exposureScore;
    assert.ok(score('suez') > 0 && score('suez') < 100, 'Suez carries part of China-US trade');
    assert.ok(score('panama') > 0 && score('panama') < 100, 'Panama carries part of China-US trade');
  });

  it('keeps India-Gulf trade off the Malacca leg of the Gulf-Asia corridor', () => {
    const exposures = computeFlowWeightedExposures('IN', '27', product('2709', [['SA', 1]]));
    assert.equal(exposures.find(e => e.chokepointId === 'malacca_strait').exposureScore, 0);
    assert.equal(exposures.find(e => e.chokepointId === 'hormuz_strait').exposureScore, 100);
  });
});

describe('seed coverage manifest', () => {
  it('publishes the exact country/sector universe with its exposure records', async () => {
    const { main, META_KEY, HS2_CODES } = await import('../scripts/seed-hs2-chokepoint-exposure.mjs');
    const originalFetch = globalThis.fetch;
    const env = { ...process.env };
    const writes = [];
    process.env.UPSTASH_REDIS_REST_URL = 'https://fixture.invalid';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fixture';
    globalThis.fetch = async (url, init) => {
      const commands = JSON.parse(init.body);
      if (!String(url).endsWith('/pipeline')) return Response.json({ result: 'OK' });
      return Response.json(commands.map(command => {
        if (command[0] === 'GET') return { result: null };
        writes.push(command);
        return { result: 'OK' };
      }));
    };
    try {
      await main();
      const meta = JSON.parse(writes.find(c => c[1] === META_KEY)[2]);
      const countries = Object.keys(CLUSTERS).filter(k => /^[A-Z]{2}$/.test(k));
      assert.deepEqual(meta.countryIds, countries);
      assert.deepEqual(meta.hs2Codes, HS2_CODES);
      assert.equal(meta.manifestVersion, 1);
      assert.equal(meta.recordCount, countries.length * HS2_CODES.length);
      assert.equal(meta.status, 'ok');
      assert.ok(meta.countryIds.includes('DE') && meta.countryIds.includes('JP'));
      const keys = new Set(writes.map(c => c[1]));
      for (const country of countries) for (const hs2 of HS2_CODES) {
        assert.ok(keys.has(`supply-chain:exposure:${country}:${hs2}:v1`));
      }
    } finally { globalThis.fetch = originalFetch; process.env = env; }
  });

  it('keeps a zero-crossing flow-weighted record instead of falling back to nearby routes', async () => {
    const { main } = await import('../scripts/seed-hs2-chokepoint-exposure.mjs');
    const originalFetch = globalThis.fetch;
    const env = { ...process.env };
    const writes = [];
    process.env.UPSTASH_REDIS_REST_URL = 'https://fixture.invalid';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fixture';
    const djiboutiCereals = {
      products: [{
        hs4: '1001', description: 'Wheat', totalValue: 1_000_000, year: 2024,
        topExporters: [
          { partnerCode: 842, partnerIso2: 'US', value: 600_000, share: 0.6 },
          { partnerCode: 76, partnerIso2: 'BR', value: 400_000, share: 0.4 },
        ],
      }],
    };
    globalThis.fetch = async (url, init) => {
      const commands = JSON.parse(init.body);
      if (!String(url).endsWith('/pipeline')) return Response.json({ result: 'OK' });
      return Response.json(commands.map(command => {
        if (command[0] === 'GET') {
          const fixture = ['comtrade:bilateral-hs4:DJ:v1', 'comtrade:bilateral-hs4:ET:v1'].includes(command[1]);
          return { result: fixture ? JSON.stringify(djiboutiCereals) : null };
        }
        writes.push(command);
        return { result: 'OK' };
      }));
    };
    try {
      await main();
      const record = JSON.parse(writes.find(c => c[1] === 'supply-chain:exposure:DJ:10:v1')[2]);
      assert.equal(record.coverage, 'flow_weighted');
      assert.equal(record.primaryChokepointId, '');
      assert.ok(record.exposures.every(e => e.exposureScore === 0), 'no chokepoint between Djibouti and the Americas');
      const landlocked = JSON.parse(writes.find(c => c[1] === 'supply-chain:exposure:ET:10:v1')[2]);
      assert.notEqual(landlocked.coverage, 'flow_weighted', 'landlocked Ethiopia has no modeled sea route to evaluate');
    } finally { globalThis.fetch = originalFetch; process.env = env; }
  });

  // The gap that let the manifest blackout ship: only the success path was covered, so
  // writeMeta's error output could silently drop the fields the scenario worker gates on.
  it('keeps the country/sector universe in seed-meta when the run fails', async () => {
    const { main, META_KEY, HS2_CODES } = await import('../scripts/seed-hs2-chokepoint-exposure.mjs');
    const originalFetch = globalThis.fetch;
    const env = { ...process.env };
    const writes = [];
    process.env.UPSTASH_REDIS_REST_URL = 'https://fixture.invalid';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fixture';
    globalThis.fetch = async (url, init) => {
      const commands = JSON.parse(init.body);
      if (!String(url).endsWith('/pipeline')) return Response.json({ result: 'OK' });
      // Fail the bulk data write, which is what drives main() into its catch block.
      if (commands.some(c => c[0] === 'SET' && String(c[1]).startsWith('supply-chain:exposure:'))) {
        return Response.json(commands.map(() => ({ error: 'ERR simulated write failure' })));
      }
      return Response.json(commands.map(command => {
        if (command[0] === 'GET') return { result: null };
        writes.push(command);
        return { result: 'OK' };
      }));
    };
    try {
      await assert.rejects(main());
      // Filter on SET: the catch block also issues an EXPIRE on META_KEY via
      // extendExistingTtl, whose argument would parse as a bare number.
      const metaWrite = writes.find(c => c[0] === 'SET' && c[1] === META_KEY);
      assert.ok(metaWrite, 'the error path must still publish seed-meta');
      const meta = JSON.parse(metaWrite[2]);
      // The run FAILED: status and recordCount say so...
      assert.equal(meta.status, 'error');
      assert.equal(meta.recordCount, 0);
      // ...but the universe is static config and stays true, so the scenario worker can
      // still resolve its country/sector scope instead of blacking the feature out.
      const countries = Object.keys(CLUSTERS).filter(k => /^[A-Z]{2}$/.test(k));
      assert.equal(meta.manifestVersion, 1);
      assert.deepEqual(meta.countryIds, countries);
      assert.deepEqual(meta.hs2Codes, HS2_CODES);
    } finally { globalThis.fetch = originalFetch; process.env = env; }
  });
});
