import test from 'node:test';
import assert from 'node:assert/strict';

import { buildMapUrl, parseMapUrlState } from '../src/utils/urlState.ts';

test('buildMapUrl and parseMapUrlState round-trip compressed layer state', () => {
  const layers = {
    conflicts: true,
    bases: true,
    cables: true,
    pipelines: false,
    hotspots: true,
    ais: false,
    nuclear: true,
    irradiators: false,
    sanctions: true,
    weather: true,
    economic: true,
    waterways: false,
    outages: true,
    cyberThreats: false,
    datacenters: false,
    protests: false,
    flights: false,
    military: true,
    natural: true,
    spaceports: false,
    minerals: false,
    fires: false,
    ucdpEvents: false,
    displacement: true,
    climate: true,
    startupHubs: false,
    cloudRegions: false,
    accelerators: false,
    techHQs: false,
    techEvents: false,
    stockExchanges: false,
    financialCenters: false,
    centralBanks: false,
    commodityHubs: false,
    gulfInvestments: false,
    positiveEvents: false,
    kindness: false,
    happiness: false,
    speciesRecovery: false,
    renewableInstallations: false,
    tradeRoutes: false,
    iranAttacks: true,
    gpsJamming: false,
    dayNight: false,
  };

  const url = buildMapUrl('https://example.com', {
    view: 'global',
    zoom: 4.25,
    center: { lat: 33.5138, lon: 36.2765 },
    timeRange: '7d',
    layers,
    country: 'SY',
  });

  const parsed = parseMapUrlState(new URL(url).search, { ...layers, conflicts: false });

  assert.equal(parsed.view, 'global');
  assert.equal(parsed.timeRange, '7d');
  assert.equal(parsed.country, 'SY');
  assert.equal(parsed.layers?.conflicts, true);
  assert.equal(parsed.layers?.iranAttacks, true);
  assert.equal(parsed.layers?.pipelines, false);
});
