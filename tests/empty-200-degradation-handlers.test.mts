import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { listClimateNews } from '../server/worldmonitor/climate/v1/list-climate-news.ts';
import { getDisplacementSummary } from '../server/worldmonitor/displacement/v1/get-displacement-summary.ts';
import { getGivingSummary } from '../server/worldmonitor/giving/v1/get-giving-summary.ts';
import { getVesselSnapshot } from '../server/worldmonitor/maritime/v1/get-vessel-snapshot.ts';
import { listNaturalEvents } from '../server/worldmonitor/natural/v1/list-natural-events.ts';
import { listPredictionMarkets } from '../server/worldmonitor/prediction/v1/list-prediction-markets.ts';
import { listRadiationObservations } from '../server/worldmonitor/radiation/v1/list-radiation-observations.ts';
import { routeIntelligence } from '../server/worldmonitor/shipping/v2/route-intelligence.ts';
import { getChokepointStatus } from '../server/worldmonitor/supply-chain/v1/get-chokepoint-status.ts';
import { listThermalEscalations } from '../server/worldmonitor/thermal/v1/list-thermal-escalations.ts';
import { listFireDetections } from '../server/worldmonitor/wildfire/v1/list-fire-detections.ts';

const CLEARED_ENV_KEYS = [
  'LOCAL_API_MODE',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
  'WS_RELAY_URL',
  'RELAY_SHARED_SECRET',
  'RELAY_AUTH_HEADER',
  'WORLDMONITOR_VALID_KEYS',
] as const;

const originalEnv = new Map<string, string | undefined>();
const originalFetch = globalThis.fetch;

beforeEach(() => {
  for (const key of CLEARED_ENV_KEYS) {
    originalEnv.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of CLEARED_ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  originalEnv.clear();
});

describe('empty 200 degraded handler responses', () => {
  it('marks seed cache misses as degraded instead of ambiguous empty data', async () => {
    const [climate, natural, prediction, radiation, thermal, wildfire] = await Promise.all([
      listClimateNews({} as never, {}),
      listNaturalEvents({} as never, {}),
      listPredictionMarkets({} as never, {}),
      listRadiationObservations({} as never, { maxItems: 0 }),
      listThermalEscalations({} as never, { maxItems: 0 }),
      listFireDetections({} as never, {}),
    ]);

    assert.deepEqual(climate, { items: [], fetchedAt: 0, dataAvailable: false });
    assert.deepEqual(natural, { events: [], fetchedAt: 0, dataAvailable: false });
    assert.deepEqual(prediction, { markets: [], pagination: undefined, fetchedAt: 0, dataAvailable: false });
    assert.equal(radiation.dataAvailable, false);
    assert.equal(radiation.fetchedAt, 0);
    assert.deepEqual(radiation.observations, []);
    assert.equal(thermal.dataAvailable, false);
    assert.equal(thermal.fetchedAt, '');
    assert.deepEqual(thermal.clusters, []);
    assert.deepEqual(wildfire, {
      fireDetections: [],
      pagination: undefined,
      fetchedAt: 0,
      dataAvailable: false,
    });
  });

  it('marks an unavailable AIS relay snapshot as degraded', async () => {
    const response = await getVesselSnapshot({} as never, {
      includeCandidates: false,
      includeTankers: false,
      swLat: 0,
      swLon: 0,
      neLat: 0,
      neLon: 0,
    });

    assert.deepEqual(response, {
      snapshot: undefined,
      fetchedAt: 0,
      dataAvailable: false,
    });
  });

  it('marks displacement upstream misses as degraded', async () => {
    globalThis.fetch = async () => new Response('upstream unavailable', { status: 503 });

    const response = await getDisplacementSummary({} as never, {
      year: 2025,
      countryLimit: 0,
      flowLimit: 0,
    });

    assert.equal(response.dataAvailable, false);
    assert.equal(response.fetchedAt, 0);
    assert.equal(response.summary?.countries.length, 0);
    assert.equal(response.summary?.topFlows.length, 0);
  });

  it('keeps published-estimate giving summaries marked available', async () => {
    const response = await getGivingSummary({} as never, {
      platformLimit: 2,
      categoryLimit: 2,
    });

    assert.equal(response.dataAvailable, true);
    assert.ok(response.fetchedAt > 0);
    assert.ok(response.summary);
    assert.equal(response.summary.platforms.length, 2);
    assert.equal(response.summary.categories.length, 2);
    assert.equal(response.summary.dataMode, 'partial_estimate');
    assert.equal(response.summary.activityIndexAvailable, false);
    assert.equal(response.summary.trendAvailable, false);
    assert.ok(response.summary.provenance.length > 0);
  });

  it('keeps Giving unavailable when the v2 cache has a negative sentinel', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://fake-upstash.example';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
    let requestedUrl = '';
    globalThis.fetch = async (input) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify({ result: JSON.stringify('__WM_NEG__') }), { status: 200 });
    };

    const response = await getGivingSummary({} as never, { platformLimit: 0, categoryLimit: 0 });

    assert.equal(response.dataAvailable, false);
    assert.equal(response.fetchedAt, 0);
    assert.equal(response.summary, undefined);
    assert.match(requestedUrl, /giving%3Asummary%3Av2/);
  });

  it('keeps Giving unavailable when a cached response has no summary', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://fake-upstash.example';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
    globalThis.fetch = async () => new Response(JSON.stringify({
      result: JSON.stringify({ fetchedAt: 1717200000000, dataAvailable: true }),
    }), { status: 200 });

    const response = await getGivingSummary({} as never, { platformLimit: 0, categoryLimit: 0 });

    assert.equal(response.dataAvailable, false);
    assert.equal(response.fetchedAt, 0);
    assert.equal(response.summary, undefined);
  });

  it('keeps Giving unavailable when response projection throws', async () => {
    const response = await getGivingSummary({} as never, undefined as never);

    assert.equal(response.dataAvailable, false);
    assert.equal(response.fetchedAt, 0);
    assert.equal(response.summary, undefined);
  });

  it('marks chokepoint status cache misses with the documented empty fetchedAt sentinel', async () => {
    const response = await getChokepointStatus({} as never, {});

    assert.deepEqual(response, {
      chokepoints: [],
      fetchedAt: '',
      upstreamUnavailable: true,
    });
  });

  it('ties ShippingV2 route freshness to the chokepoint status snapshot, not static routes', async () => {
    process.env.WORLDMONITOR_VALID_KEYS = 'pro-test-key';

    const ctx = {
      request: new Request('https://worldmonitor.app/api/v2/shipping/route-intelligence', {
        headers: { 'X-WorldMonitor-Key': 'pro-test-key' },
      }),
      pathParams: {},
      headers: {},
    };

    const degraded = await routeIntelligence(ctx as never, {
      fromIso2: 'AE',
      toIso2: 'NL',
      cargoType: 'tanker',
      hs2: '27',
    });
    assert.notEqual(degraded.primaryRouteId, '');
    assert.equal(degraded.fetchedAt, '');

    process.env.UPSTASH_REDIS_REST_URL = 'https://fake-upstash.example';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
    globalThis.fetch = async () => new Response(JSON.stringify({
      result: JSON.stringify({
        chokepoints: [{ id: 'suez', disruptionScore: 12, warRiskTier: 'WAR_RISK_TIER_ELEVATED' }],
        upstreamUnavailable: false,
      }),
    }), { status: 200 });

    const healthyNoStaticRoute = await routeIntelligence(ctx as never, {
      fromIso2: 'ZZ',
      toIso2: 'NL',
      cargoType: 'tanker',
      hs2: '27',
    });
    assert.equal(healthyNoStaticRoute.primaryRouteId, '');
    assert.match(healthyNoStaticRoute.fetchedAt, /^\d{4}-\d{2}-\d{2}T/);
  });

  it('treats an existing empty radiation seed snapshot as available empty data', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://fake-upstash.example';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
    globalThis.fetch = async () => new Response(JSON.stringify({
      result: JSON.stringify({
        observations: [],
        fetchedAt: 1700000000000,
        dataAvailable: true,
        epaCount: 0,
        safecastCount: 0,
        anomalyCount: 0,
        elevatedCount: 0,
        spikeCount: 0,
        corroboratedCount: 0,
        lowConfidenceCount: 0,
        conflictingCount: 0,
        convertedFromCpmCount: 0,
      }),
    }), { status: 200 });

    const response = await listRadiationObservations({} as never, { maxItems: 10 });

    assert.equal(response.dataAvailable, true);
    assert.equal(response.fetchedAt, 1700000000000);
    assert.deepEqual(response.observations, []);
  });
});
