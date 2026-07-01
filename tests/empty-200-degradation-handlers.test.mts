import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { listClimateNews } from '../server/worldmonitor/climate/v1/list-climate-news.ts';
import { getVesselSnapshot } from '../server/worldmonitor/maritime/v1/get-vessel-snapshot.ts';
import { listNaturalEvents } from '../server/worldmonitor/natural/v1/list-natural-events.ts';
import { listPredictionMarkets } from '../server/worldmonitor/prediction/v1/list-prediction-markets.ts';
import { listRadiationObservations } from '../server/worldmonitor/radiation/v1/list-radiation-observations.ts';
import { listThermalEscalations } from '../server/worldmonitor/thermal/v1/list-thermal-escalations.ts';
import { listFireDetections } from '../server/worldmonitor/wildfire/v1/list-fire-detections.ts';

const CLEARED_ENV_KEYS = [
  'LOCAL_API_MODE',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
  'WS_RELAY_URL',
  'RELAY_SHARED_SECRET',
  'RELAY_AUTH_HEADER',
] as const;

const originalEnv = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of CLEARED_ENV_KEYS) {
    originalEnv.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
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
});
