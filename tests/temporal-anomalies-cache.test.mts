import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { __testing__ } from '../api/health.js';
import {
  TEMPORAL_ANOMALIES_TTL,
  TEMPORAL_ANOMALIES_REBUILD_AFTER_MS,
} from '../server/worldmonitor/infrastructure/v1/_shared.ts';
import { listTemporalAnomalies } from '../server/worldmonitor/infrastructure/v1/list-temporal-anomalies.ts';

/**
 * Drive the handler against a counting Redis stub.
 *
 * `getCachedJson` reads via GET /get/<key>; every write (lock, baselines, snapshot,
 * seed-meta) is a POST. Counting by method is therefore a direct measure of Redis
 * round trips, which is the quantity this route's latency is made of: measured p50
 * was ~3x the caller's RTT to the single us-east store.
 */
async function runWithRedisStub(
  keyValues: Record<string, unknown>,
  { lockGranted = true }: { lockGranted?: boolean } = {},
) {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.UPSTASH_REDIS_REST_URL;
  const originalToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  const calls: { method: string; key: string }[] = [];

  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  globalThis.fetch = (async (input: unknown, init: { method?: string; body?: string } = {}) => {
    if (init.method === 'POST') {
      calls.push({ method: 'POST', key: String(input) });
      return Response.json({ result: lockGranted ? 'OK' : null });
    }
    const key = decodeURIComponent(new URL(String(input)).pathname.replace('/get/', ''));
    calls.push({ method: 'GET', key });
    const value = key in keyValues ? keyValues[key] : null;
    return Response.json({ result: value == null ? null : JSON.stringify(value) });
  }) as typeof globalThis.fetch;

  try {
    const response = await listTemporalAnomalies({} as never, {});
    return { response, calls };
  } finally {
    globalThis.fetch = originalFetch;
    process.env.UPSTASH_REDIS_REST_URL = originalUrl;
    process.env.UPSTASH_REDIS_REST_TOKEN = originalToken;
  }
}

const freshSnapshot = (ageMs = 0) => ({
  anomalies: [],
  trackedTypes: ['news', 'satellite_fires'],
  computedAt: new Date(Date.now() - ageMs).toISOString(),
});

describe('temporal anomalies cache freshness', () => {
  it('rebuilds often enough that the health stale budget has real margin', () => {
    const maxStaleMin = __testing__.SEED_META.temporalAnomalies.maxStaleMin;
    const rebuildMin = TEMPORAL_ANOMALIES_REBUILD_AFTER_MS / 60_000;

    // seed-meta is stamped ONLY on a successful rebuild, so the rebuild cadence IS
    // the stamp cadence. The alarm window must not sit on the refresh period — one
    // late cycle would false-alarm. Require at least 2x headroom.
    assert.ok(
      rebuildMin * 2 <= maxStaleMin,
      `rebuild every ${rebuildMin}min vs maxStaleMin ${maxStaleMin}min leaves under 2x margin`,
    );

    // The Redis key must outlive the rebuild threshold so a lock loser can still be
    // served a stale body instead of an empty one.
    assert.ok(TEMPORAL_ANOMALIES_TTL * 1000 > TEMPORAL_ANOMALIES_REBUILD_AFTER_MS);
  });

  it('serves a fresh cache hit in exactly ONE Redis round trip, with no writes', async () => {
    const snapshot = freshSnapshot(60_000);
    const { response, calls } = await runWithRedisStub({
      'temporal:anomalies:v1': snapshot,
    });

    assert.deepEqual(response, snapshot, 'hot path must return the cached body unchanged');
    assert.equal(
      calls.length, 1,
      `expected 1 Redis round trip, got ${calls.length}: ${JSON.stringify(calls)}`,
    );
    assert.equal(calls[0]!.method, 'GET');
    assert.equal(calls[0]!.key, 'temporal:anomalies:v1');
  });

  it('positive control: the stub does observe writes when a rebuild runs', async () => {
    // Proves the assertion above can actually fail. A stale snapshot forces the
    // rebuild path, which legitimately writes (lock, baselines, snapshot, seed-meta).
    const { calls } = await runWithRedisStub({
      'temporal:anomalies:v1': freshSnapshot(TEMPORAL_ANOMALIES_REBUILD_AFTER_MS + 60_000),
    });

    const writes = calls.filter((c) => c.method === 'POST');
    assert.ok(writes.length > 0, 'rebuild path must write; otherwise the guard above is vacuous');
  });

  it('serves the stale body rather than an empty result when the rebuild lock is lost', async () => {
    // Removing the sliding-TTL refresh must not regress this: a lock loser during a
    // rebuild window still has a usable cached body and must return it.
    const stale = freshSnapshot(TEMPORAL_ANOMALIES_REBUILD_AFTER_MS + 60_000);
    const { response } = await runWithRedisStub(
      { 'temporal:anomalies:v1': stale },
      { lockGranted: false },
    );

    assert.deepEqual(response, stale, 'lock loser must fall back to the stale snapshot');
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
