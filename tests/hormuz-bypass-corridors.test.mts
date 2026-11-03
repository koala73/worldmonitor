/**
 * The bypass corridor registries listed the Cape, the Aqaba land bridge and
 * BTC for Hormuz, but not the two pipelines that actually move Gulf crude
 * around the Strait: Saudi East-West to Yanbu and UAE ADCOP to Fujairah. They
 * carry only their own country's crude, so they are offered only to shipments
 * from that country and never stand in as a generic bypass.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import * as serverRegistry from '../server/_shared/bypass-corridors.ts';
import * as browserRegistry from '../src/config/bypass-corridors.ts';
import { pickBestBypass } from '../server/worldmonitor/supply-chain/v1/_multi-sector-shock.ts';
import { computeLane } from '../server/worldmonitor/supply-chain/v1/get-route-explorer-lane.ts';
import { BYPASS_CORRIDOR_GEOMETRY_BY_ID } from '../server/worldmonitor/supply-chain/v1/_route-explorer-static-tables.ts';

const hormuz = (registry: typeof serverRegistry) => registry.BYPASS_CORRIDORS_BY_CHOKEPOINT.hormuz_strait ?? [];

describe('Hormuz crude pipelines in the bypass registries', () => {
  it('lists East-West and ADCOP as origin-restricted crude pipelines', () => {
    const byId = new Map(hormuz(serverRegistry).map((c) => [c.id, c]));
    const eastWest = byId.get('hormuz_east_west_pipeline');
    const adcop = byId.get('hormuz_adcop_pipeline');
    assert.ok(eastWest && adcop, [...byId.keys()].join(', '));
    assert.deepEqual(eastWest.originIso2, ['SA']);
    assert.deepEqual(adcop.originIso2, ['AE']);
    for (const c of [eastWest, adcop]) {
      assert.equal(c.type, 'pipeline');
      assert.deepEqual(c.suitableCargoTypes, ['tanker']);
      assert.ok((c.capacityConstraintTonnage ?? 0) > 0);
    }
    // Yanbu cargoes reach Asia through Bab el-Mandeb.
    assert.deepEqual(eastWest.waypointChokepointIds, ['bab_el_mandeb']);
  });

  it('the server and browser registries stay identical', () => {
    assert.deepEqual(serverRegistry.BYPASS_CORRIDORS, browserRegistry.BYPASS_CORRIDORS);
  });

  it('corridorServesOrigin offers an origin-restricted pipeline only to its own exporter', () => {
    const eastWest = hormuz(serverRegistry).find((c) => c.id === 'hormuz_east_west_pipeline')!;
    const cape = hormuz(serverRegistry).find((c) => c.id === 'hormuz_cape_of_good_hope')!;
    assert.equal(serverRegistry.corridorServesOrigin(eastWest, 'SA'), true);
    assert.equal(serverRegistry.corridorServesOrigin(eastWest, 'QA'), false);
    assert.equal(serverRegistry.corridorServesOrigin(cape, 'QA'), true);
  });

  it('the multi-sector best bypass for Hormuz is unchanged: a pipeline for one exporter is not a generic bypass', () => {
    assert.equal(pickBestBypass('hormuz_strait')?.id, 'btc_pipeline');
  });

  it('route explorer offers East-West to a Saudi tanker lane and neither pipeline to a Qatari one', async () => {
    const lane = (fromIso2: string) => computeLane({ fromIso2, toIso2: 'JP', hs2: '27', cargoType: 'tanker' } as never, new Map());
    const saudi = await lane('SA');
    const qatar = await lane('QA');
    assert.equal(saudi.chokepointExposures[0]?.chokepointId, 'hormuz_strait');
    const saudiIds = saudi.bypassOptions.map((b) => b.id);
    assert.ok(saudiIds.includes('hormuz_east_west_pipeline'), saudiIds.join(', '));
    assert.ok(!saudiIds.includes('hormuz_adcop_pipeline'), saudiIds.join(', '));
    const qatarIds = qatar.bypassOptions.map((b) => b.id);
    assert.ok(!qatarIds.some((id) => id === 'hormuz_east_west_pipeline' || id === 'hormuz_adcop_pipeline'), qatarIds.join(', '));
  });

  it('every usable corridor has its own map endpoints; the fallback draws a zero-length arc at the chokepoint', () => {
    for (const c of serverRegistry.BYPASS_CORRIDORS) {
      if (c.suitableCargoTypes.length === 0) continue; // "no bypass" placeholders
      const g = BYPASS_CORRIDOR_GEOMETRY_BY_ID[c.id];
      assert.ok(g, `${c.id} has no geometry`);
      assert.notDeepEqual(g.fromPort, g.toPort, `${c.id} is a zero-length arc`);
    }
  });

  it('the route explorer draws East-West from Abqaiq to Yanbu and ADCOP from Habshan to Fujairah', async () => {
    const pipeline = async (fromIso2: string, id: string) => (await computeLane({ fromIso2, toIso2: 'JP', hs2: '27', cargoType: 'tanker' } as never, new Map()))
      .bypassOptions.find((b) => b.id === id)!;
    const eastWest = await pipeline('SA', 'hormuz_east_west_pipeline');
    const adcop = await pipeline('AE', 'hormuz_adcop_pipeline');
    // Abqaiq lies on the Gulf side; Yanbu on the Red Sea, west of 40E.
    assert.ok(eastWest.fromPort!.lon > 49 && eastWest.toPort!.lon < 40, JSON.stringify(eastWest));
    // Habshan lies inside the Gulf, west of the Strait (56.5E); Fujairah outside it, on the Gulf of Oman.
    assert.ok(adcop.fromPort!.lon < 54 && adcop.toPort!.lon > 56, JSON.stringify(adcop));
  });
});
