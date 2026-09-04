import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { projectMineralProduction } from '../server/worldmonitor/supply-chain/v1/get-mineral-production.ts';

const payload = {
  fetchedAt: '2026-02-06T00:00:00.000Z',
  dataYear: 2025,
  commodities: {
    cobalt: {
      id: 'cobalt',
      label: 'Cobalt',
      year: 2025,
      unit: 'metric tons',
      sources: ['usgs-mcs'],
      stages: {
        mine: {
          year: 2025,
          unit: 'metric tons',
          hhi: 5770,
          worldTotal: 310000,
          withheldCount: 0,
          countries: [
            { iso2: 'CD', country: 'Congo (Kinshasa)', output: 230000, share: 74.2, withheld: false, estimated: true, residual: false },
            { iso2: 'ID', country: 'Indonesia', output: 44000, share: 14.2, withheld: false, estimated: true, residual: false },
          ],
        },
        refinery: null,
      },
    },
    copper: {
      id: 'copper',
      label: 'Copper',
      year: 2025,
      unit: 'thousand metric tons',
      sources: ['usgs-mcs'],
      stages: {
        mine: {
          year: 2025,
          unit: 'thousand metric tons',
          hhi: 1200,
          withheldCount: 0,
          countries: [
            { iso2: 'CL', country: 'Chile', output: 5300, share: 23, withheld: false, estimated: true, residual: false },
          ],
        },
        refinery: {
          year: 2025,
          unit: 'thousand metric tons',
          hhi: 2400,
          withheldCount: 0,
          countries: [
            { iso2: 'CN', country: 'China', output: 14000, share: 48, withheld: false, estimated: true, residual: false },
            { iso2: 'CL', country: 'Chile', output: 1700, share: 6, withheld: false, estimated: true, residual: false },
          ],
        },
      },
    },
  },
};

describe('projectMineralProduction', () => {
  it('returns all commodities when unfiltered', () => {
    const res = projectMineralProduction(payload, { commodity: '', iso2: '', stage: '' });
    assert.equal(res.upstreamUnavailable, false);
    assert.equal(res.commodities.length, 2);
    assert.equal(res.dataYear, 2025);
  });

  it('filters by commodity and refinery stage', () => {
    const res = projectMineralProduction(payload, { commodity: 'copper', iso2: '', stage: 'refinery' });
    assert.equal(res.commodities.length, 1);
    assert.equal(res.commodities[0].commodityId, 'copper');
    assert.ok(res.commodities[0].refinery);
    assert.equal(res.commodities[0].mine, undefined);
    assert.equal(res.commodities[0].refinery?.countries[0].iso2, 'CN');
  });

  it('builds a country portfolio for iso2', () => {
    const res = projectMineralProduction(payload, { commodity: '', iso2: 'CL', stage: '' });
    assert.equal(res.countries.length, 1);
    assert.equal(res.countries[0].iso2, 'CL');
    assert.ok(res.countries[0].holdings.some((h) => h.commodityId === 'copper' && h.stage === 'mine'));
    assert.ok(res.countries[0].holdings.some((h) => h.commodityId === 'copper' && h.stage === 'refinery'));
    assert.ok(!res.commodities.some((c) => c.commodityId === 'cobalt'));
  });

  it('omits a stage when iso2 is not in that stage', () => {
    const res = projectMineralProduction(payload, { commodity: 'copper', iso2: 'CN', stage: '' });
    assert.equal(res.commodities.length, 1);
    assert.equal(res.commodities[0].mine, undefined);
    assert.equal(res.commodities[0].refinery?.countries.length, 1);
    assert.equal(res.commodities[0].refinery?.countries[0].iso2, 'CN');
  });

  it('treats smelter as the refinery stage', () => {
    const res = projectMineralProduction(payload, { commodity: 'copper', iso2: '', stage: 'smelter' });
    assert.equal(res.commodities.length, 1);
    assert.ok(res.commodities[0].refinery);
    assert.equal(res.commodities[0].mine, undefined);
  });

  it('marks missing seed as unavailable', () => {
    const res = projectMineralProduction(null, { commodity: '', iso2: '', stage: '' });
    assert.equal(res.upstreamUnavailable, true);
    assert.equal(res.commodities.length, 0);
  });
});
