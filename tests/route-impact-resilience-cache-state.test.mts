import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

const originalEnv = {
  LOCAL_API_MODE: process.env.LOCAL_API_MODE,
  WORLDMONITOR_VALID_KEYS: process.env.WORLDMONITOR_VALID_KEYS,
  RESILIENCE_EDUCATION_ENABLED: process.env.RESILIENCE_EDUCATION_ENABLED,
  RESILIENCE_PILLAR_COMBINE_ENABLED: process.env.RESILIENCE_PILLAR_COMBINE_ENABLED,
};

process.env.LOCAL_API_MODE = 'tauri-sidecar';
process.env.WORLDMONITOR_VALID_KEYS = 'route-impact-test-key';
process.env.RESILIENCE_EDUCATION_ENABLED = 'true';
process.env.RESILIENCE_PILLAR_COMBINE_ENABLED = 'true';

const [{ sidecarCacheSet }, { ROUTE_IMPACT_KEY }, routeImpact, resilienceShared] = await Promise.all([
  import('../server/_shared/sidecar-cache.js'),
  import('../server/_shared/cache-keys.js'),
  import('../server/worldmonitor/supply-chain/v1/get-route-impact.js'),
  import('../server/worldmonitor/resilience/v1/_shared.js'),
]);

before(() => {
  process.env.LOCAL_API_MODE = 'tauri-sidecar';
  process.env.WORLDMONITOR_VALID_KEYS = 'route-impact-test-key';
});

after(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
});

test('an outer Route Impact cache hit overlays the current education-state score', async () => {
  const request = new Request('https://worldmonitor.app/api/supply-chain/v1/get-route-impact', {
    headers: { 'X-WorldMonitor-Key': 'route-impact-test-key' },
  });
  const req = { fromIso2: 'US', toIso2: 'FR', hs2: '27' };
  sidecarCacheSet(ROUTE_IMPACT_KEY('US', 'FR', '27'), {
    laneValueUsd: 123,
    primaryExporterIso2: 'NO',
    primaryExporterShare: 0.4,
    topStrategicProducts: [],
    resilienceScore: 11,
    dependencyFlags: [],
    hs2InSeededUniverse: true,
    comtradeSource: 'bilateral-hs4',
    fetchedAt: '2026-08-11T00:00:00.000Z',
  }, 86_400);
  sidecarCacheSet(`${resilienceShared.RESILIENCE_SCORE_CACHE_PREFIX}FR`, {
    countryCode: 'FR',
    overallScore: 77,
    _formula: resilienceShared.getCurrentCacheFormula(),
    _educationState: 'education-on',
  }, 21_600);

  const active = await routeImpact.getRouteImpact({ request } as never, req);
  assert.equal(active.laneValueUsd, 123, 'slow bilateral fields still come from the outer cache');
  assert.equal(active.resilienceScore, 77, 'the pre-flip embedded score is not served');

  process.env.RESILIENCE_EDUCATION_ENABLED = 'false';
  sidecarCacheSet(`${resilienceShared.RESILIENCE_SCORE_CACHE_PREFIX}FR`, {
    countryCode: 'FR',
    overallScore: 66,
    _formula: resilienceShared.getCurrentCacheFormula(),
    _educationState: 'education-off',
  }, 21_600);
  const rolledBack = await routeImpact.getRouteImpact({ request } as never, req);
  assert.equal(rolledBack.laneValueUsd, 123);
  assert.equal(rolledBack.resilienceScore, 66, 'rollback also bypasses the stale outer score');
});

test('Route Impact rejects stale, untagged, and out-of-range resilience scores', async () => {
  process.env.RESILIENCE_EDUCATION_ENABLED = 'true';
  for (const [label, payload] of [
    ['opposite education state', {
      countryCode: 'DE',
      overallScore: 88,
      _formula: resilienceShared.getCurrentCacheFormula(),
      _educationState: 'education-off',
    }],
    ['wrong formula', {
      countryCode: 'DE',
      overallScore: 88,
      _formula: resilienceShared.getCurrentCacheFormula() === 'pc' ? 'd6' : 'pc',
      _educationState: 'education-on',
    }],
    ['untagged payload', { countryCode: 'DE', overallScore: 88 }],
    ['out-of-range score', {
      countryCode: 'DE',
      overallScore: 101,
      _formula: resilienceShared.getCurrentCacheFormula(),
      _educationState: 'education-on',
    }],
  ] as const) {
    sidecarCacheSet(`${resilienceShared.RESILIENCE_SCORE_CACHE_PREFIX}DE`, payload, 21_600);
    assert.equal(await routeImpact.readResilienceScore('DE'), 0, label);
  }
});
