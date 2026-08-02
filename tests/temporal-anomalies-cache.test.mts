import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { __testing__ } from '../api/health.js';
import { TEMPORAL_ANOMALIES_TTL } from '../server/worldmonitor/infrastructure/v1/_shared.ts';
import { listTemporalAnomalies } from '../server/worldmonitor/infrastructure/v1/list-temporal-anomalies.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');

describe('temporal anomalies cache freshness', () => {
  it('keeps the data TTL beyond the strict health stale budget', () => {
    const maxStaleMin = __testing__.SEED_META.temporalAnomalies.maxStaleMin;

    assert.equal(TEMPORAL_ANOMALIES_TTL, 3600);
    assert.ok(TEMPORAL_ANOMALIES_TTL / 60 > maxStaleMin);
  });

  it('refreshes the data key and seed-meta on fresh cache hits', () => {
    const src = readFileSync(
      resolve(ROOT, 'server/worldmonitor/infrastructure/v1/list-temporal-anomalies.ts'),
      'utf8',
    );

    assert.match(src, /async function refreshTemporalAnomaliesCacheHit/);
    assert.match(src, /setCachedJson\(TEMPORAL_ANOMALIES_KEY, snapshot, TEMPORAL_ANOMALIES_TTL\)/);
    assert.match(src, /writeTemporalAnomaliesSeedMeta\(snapshot\)/);
    assert.match(src, /await refreshTemporalAnomaliesCacheHit\(cached\)/);
  });

  it('counts the pre-cap FIRMS total, not the capped canonical array (#5866)', async () => {
    const originalFetch = globalThis.fetch;
    const originalUrl = process.env.UPSTASH_REDIS_REST_URL;
    const originalToken = process.env.UPSTASH_REDIS_REST_TOKEN;

    // Stands in for the capped wildfire:fires:v1: seed-fire-detections publishes at most
    // WILDFIRE_CANONICAL_DETECTION_LIMIT detections and records the real FIRMS count in
    // `pagination`. Counting the array would report the cap as the fire volume.
    const FIRMS_TOTAL = 21_600;
    const firesPayload = {
      fireDetections: Array.from({ length: 10 }, (_, index) => ({ id: `fire-${index}` })),
      pagination: { nextCursor: '', totalCount: FIRMS_TOTAL },
    };
    // stdDev 100 around a mean of 1000: both the correct count (21,600) and the buggy one (10)
    // clear the anomaly threshold, so the assertion below turns on currentCount alone.
    const baseline = { mean: 1000, m2: 290_000, sampleCount: 30, lastUpdated: '' };

    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
    globalThis.fetch = (async (input: unknown, init: { method?: string } = {}) => {
      if (init.method === 'POST') return Response.json({ result: 'OK' }); // lock + every write
      const key = decodeURIComponent(new URL(String(input)).pathname.replace('/get/', ''));
      const value = key === 'wildfire:fires:v1'
        ? firesPayload
        : key.startsWith('baseline:v2:satellite_fires:global:')
          ? baseline
          : null; // no cached snapshot, no news payload
      return Response.json({ result: value == null ? null : JSON.stringify(value) });
    }) as typeof globalThis.fetch;

    try {
      const response = await listTemporalAnomalies({} as never, {});
      const fires = response.anomalies.find((anomaly) => anomaly.type === 'satellite_fires');

      assert.ok(fires, 'satellite_fires anomaly should be emitted');
      assert.equal(fires.currentCount, FIRMS_TOTAL);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
      else process.env.UPSTASH_REDIS_REST_URL = originalUrl;
      if (originalToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
      else process.env.UPSTASH_REDIS_REST_TOKEN = originalToken;
    }
  });
});
