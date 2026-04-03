import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PREMIUM_RPC_PATHS } from '../src/shared/premium-paths';
import {
  LAYER_REGISTRY,
  getAllowedLayerKeys,
} from '../src/config/map-layer-definitions';
import {
  RESILIENCE_CHOROPLETH_COLORS,
  buildResilienceChoroplethMap,
  formatResilienceChoroplethLevel,
  getResilienceChoroplethLevel,
  normalizeExclusiveChoropleths,
} from '../src/components/resilience-choropleth-utils';

describe('resilience map layer contracts', () => {
  it('registers resilience RPCs as premium paths', () => {
    assert.ok(PREMIUM_RPC_PATHS.has('/api/resilience/v1/get-resilience-score'));
    assert.ok(PREMIUM_RPC_PATHS.has('/api/resilience/v1/get-resilience-ranking'));
  });

  it('registers resilienceScore as a locked flat layer in every variant', () => {
    assert.equal(LAYER_REGISTRY.resilienceScore.renderers.join(','), 'flat');
    assert.equal(LAYER_REGISTRY.resilienceScore.premium, 'locked');

    for (const variant of ['full', 'tech', 'finance', 'happy', 'commodity'] as const) {
      assert.ok(getAllowedLayerKeys(variant).has('resilienceScore'));
    }
  });
});

describe('resilience choropleth thresholds', () => {
  it('maps scores to the expected five-level scale', () => {
    assert.equal(getResilienceChoroplethLevel(10), 'very_low');
    assert.equal(getResilienceChoroplethLevel(25), 'low');
    assert.equal(getResilienceChoroplethLevel(45), 'moderate');
    assert.equal(getResilienceChoroplethLevel(65), 'high');
    assert.equal(getResilienceChoroplethLevel(85), 'very_high');
  });

  it('formats labels and keeps stable fill colors', () => {
    assert.equal(formatResilienceChoroplethLevel('very_high'), 'very high');
    assert.deepEqual(RESILIENCE_CHOROPLETH_COLORS.very_low, [239, 68, 68, 160]);
    assert.deepEqual(RESILIENCE_CHOROPLETH_COLORS.very_high, [34, 197, 94, 160]);
  });

  it('filters placeholder ranking rows and normalizes valid items', () => {
    const scores = buildResilienceChoroplethMap([
      { countryCode: 'NO', overallScore: 82, level: 'high', lowConfidence: false },
      { countryCode: 'US', overallScore: 61.234, level: 'medium', lowConfidence: true },
      { countryCode: 'YE', overallScore: -1, level: 'unknown', lowConfidence: true },
    ]);

    assert.equal(scores.size, 2);
    assert.deepEqual(scores.get('NO'), {
      overallScore: 82,
      level: 'very_high',
      lowConfidence: false,
    });
    assert.deepEqual(scores.get('US'), {
      overallScore: 61.2,
      level: 'high',
      lowConfidence: true,
    });
    assert.equal(scores.has('YE'), false);
  });
});

describe('resilience choropleth exclusivity', () => {
  it('drops ciiChoropleth when both choropleths are enabled', () => {
    const layers = normalizeExclusiveChoropleths({
      conflicts: false,
      bases: false,
      cables: false,
      pipelines: false,
      hotspots: false,
      ais: false,
      nuclear: false,
      irradiators: false,
      radiationWatch: false,
      sanctions: false,
      weather: false,
      economic: false,
      waterways: false,
      outages: false,
      cyberThreats: false,
      datacenters: false,
      protests: false,
      flights: false,
      military: false,
      natural: false,
      spaceports: false,
      minerals: false,
      fires: false,
      ucdpEvents: false,
      displacement: false,
      climate: false,
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
      iranAttacks: false,
      gpsJamming: false,
      satellites: false,
      ciiChoropleth: true,
      resilienceScore: true,
      dayNight: false,
      miningSites: false,
      processingPlants: false,
      commodityPorts: false,
      webcams: false,
      weatherRadar: false,
      diseaseOutbreaks: false,
    });

    assert.equal(layers.resilienceScore, true);
    assert.equal(layers.ciiChoropleth, false);
  });
});
