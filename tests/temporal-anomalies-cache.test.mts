import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { __testing__ } from '../api/health.js';
import {
  TEMPORAL_ANOMALIES_TTL,
  TEMPORAL_ANOMALIES_REBUILD_AFTER_MS,
  BASELINE_SAMPLE_INTERVAL_MS,
  makeBaselineKeyV2,
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
  {
    lockGranted = true,
    failedPostKeys = [],
  }: { lockGranted?: boolean; failedPostKeys?: string[] } = {},
) {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.UPSTASH_REDIS_REST_URL;
  const originalToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  const calls: { method: string; key: string; recordCount?: number }[] = [];

  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  globalThis.fetch = (async (input: unknown, init: { method?: string; body?: string } = {}) => {
    if (init.method === 'POST') {
      // Writes POST to `${url}/` with the command in the BODY (`['SET', key, ...]`),
      // not in the URL path — matching on the URL would silently match nothing.
      let key = '';
      let recordCount: number | undefined;
      try {
        const cmd = JSON.parse(String(init.body ?? '[]'));
        if (Array.isArray(cmd)) {
          key = String(cmd[1] ?? '');
          // cmd[2] is the JSON-encoded value; capture recordCount so coverage
          // assertions can check WHAT was written, not just that a write happened.
          const written = JSON.parse(String(cmd[2] ?? 'null'));
          if (written && typeof written.recordCount === 'number') {
            recordCount = written.recordCount;
          }
        }
      } catch { /* leave undefined; assertions below surface it */ }
      calls.push({ method: 'POST', key, recordCount });
      if (failedPostKeys.includes(key)) {
        return Response.json({ error: `forced POST failure for ${key}` }, { status: 500 });
      }
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

    // The data key must also outlive the STALE alarm, so health reaches STALE_SEED
    // before the key goes EMPTY (the ordering api/health.js:789 depends on). The
    // bound above is weaker and would pass at any TTL over 20 minutes; dropping TTL
    // to 30min for a cost tune would silently invert this ordering.
    assert.ok(
      TEMPORAL_ANOMALIES_TTL / 60 > maxStaleMin,
      `data TTL ${TEMPORAL_ANOMALIES_TTL / 60}min must exceed maxStaleMin ${maxStaleMin}min `
      + 'so health reads STALE_SEED before the key disappears',
    );
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

  it('a successful rebuild stamps seed-meta -- the only remaining freshness producer', async () => {
    // Doubles as the positive control for the round-trip guard above (proving the
    // stub observes writes at all) AND as the guard for the single behaviour this
    // whole change hinges on: seed-meta:temporal:anomalies is now written ONLY here.
    // Three consumers alarm on it at maxStaleMin 45 (api/health.js,
    // mcp/registry/analysis-tools.ts, mcp/registry/cache-tools.ts), so a regression
    // that drops or mis-gates this one write takes all three to STALE_SEED 45
    // minutes after deploy. Asserting `writes.length > 0` did NOT catch that -- the
    // lock SET alone satisfies it.
    const { calls } = await runWithRedisStub({
      'temporal:anomalies:v1': freshSnapshot(TEMPORAL_ANOMALIES_REBUILD_AFTER_MS + 60_000),
      'news:insights:v1': { topStories: [{ id: 'a' }] },
    });

    const writes = calls.filter((c) => c.method === 'POST');
    assert.ok(writes.length > 0, 'rebuild path must write; otherwise the guard above is vacuous');

    const metaWrites = writes.filter((c) => c.key === 'seed-meta:temporal:anomalies');
    assert.equal(
      metaWrites.length, 1,
      'a successful rebuild must stamp seed-meta exactly once -- three health consumers '
      + `watch it at maxStaleMin 45. Writes seen: ${JSON.stringify(writes.map((w) => w.key))}`,
    );
  });

  it('preserves the last-good snapshot and writes nothing when count-source coverage is zero', async () => {
    const stale = freshSnapshot(TEMPORAL_ANOMALIES_REBUILD_AFTER_MS + 60_000);
    const { response, calls } = await runWithRedisStub({
      'temporal:anomalies:v1': stale,
      // news:insights:v1 and wildfire:fires:v1 deliberately absent
    });

    assert.deepEqual(response, stale, 'zero coverage must preserve the usable last-good snapshot');
    assert.deepEqual(
      calls.filter((c) => c.method === 'POST' && c.key !== 'baseline:lock'),
      [],
      'zero coverage must not write baselines, publish an empty snapshot, or stamp seed-meta',
    );
  });

  it('returns the canonical empty response without publishing when zero coverage has no fallback', async () => {
    const { response, calls } = await runWithRedisStub({});

    assert.deepEqual(response, { anomalies: [], trackedTypes: [], computedAt: '' });
    assert.deepEqual(
      calls.filter((c) => c.method === 'POST' && c.key !== 'baseline:lock'),
      [],
      'a cold zero-coverage rebuild must not write baselines, a snapshot, or seed-meta',
    );
  });

  it('stamps the partial coverage it ACHIEVED, not the coverage it configured', async () => {
    const { calls } = await runWithRedisStub({
      'temporal:anomalies:v1': freshSnapshot(TEMPORAL_ANOMALIES_REBUILD_AFTER_MS + 60_000),
      'news:insights:v1': { topStories: [{ id: 'a' }] },
      // wildfire:fires:v1 deliberately absent
    });

    const stamp = calls.find((c) => c.method === 'POST' && c.key === 'seed-meta:temporal:anomalies');
    assert.equal(stamp?.recordCount, 1, 'one source read must stamp recordCount 1');
  });

  it('stamps full coverage when both count sources are present', async () => {
    // Positive control: the assertion above must not pass merely because the
    // stamp is always 0.
    const { calls } = await runWithRedisStub({
      'temporal:anomalies:v1': freshSnapshot(TEMPORAL_ANOMALIES_REBUILD_AFTER_MS + 60_000),
      'news:insights:v1': { topStories: [{ id: 'a' }] },
      'wildfire:fires:v1': { fireDetections: [], pagination: { totalCount: 5 } },
    });

    const stamp = calls.find((c) => c.method === 'POST' && c.key === 'seed-meta:temporal:anomalies');
    assert.equal(stamp?.recordCount, 2, 'both sources read must stamp recordCount 2');
  });

  it('does not stamp seed-meta when snapshot publication fails', async () => {
    const stale = freshSnapshot(TEMPORAL_ANOMALIES_REBUILD_AFTER_MS + 60_000);
    const baseline = {
      mean: 1,
      m2: 0,
      sampleCount: 1,
      lastUpdated: new Date().toISOString(),
    };
    const baselineKey = makeBaselineKeyV2(
      'news',
      'global',
      new Date().getUTCDay(),
      new Date().getUTCMonth() + 1,
    );
    const { calls } = await runWithRedisStub(
      {
        'temporal:anomalies:v1': stale,
        'news:insights:v1': { topStories: [{ id: 'a' }] },
        [baselineKey]: baseline,
      },
      { failedPostKeys: ['temporal:anomalies:v1'] },
    );

    assert.ok(
      calls.some((c) => c.method === 'POST' && c.key === 'temporal:anomalies:v1'),
      'the test must exercise a failed snapshot publication',
    );
    assert.equal(
      calls.some((c) => c.method === 'POST' && c.key === 'seed-meta:temporal:anomalies'),
      false,
      'seed-meta must describe a published snapshot, never a failed publication',
    );
  });

  it('warns with the exact due-baseline failure count while the snapshot still publishes', async () => {
    const baselineKey = makeBaselineKeyV2(
      'news',
      'global',
      new Date().getUTCDay(),
      new Date().getUTCMonth() + 1,
    );
    const dueBaseline = {
      mean: 1,
      m2: 0,
      sampleCount: 1,
      lastUpdated: new Date(Date.now() - BASELINE_SAMPLE_INTERVAL_MS - 60_000).toISOString(),
    };
    const originalWarn = console.warn;
    const warnings: unknown[][] = [];
    console.warn = (...args: unknown[]) => { warnings.push(args); };

    try {
      const { calls } = await runWithRedisStub(
        {
          'news:insights:v1': { topStories: [{ id: 'a' }] },
          [baselineKey]: dueBaseline,
        },
        { failedPostKeys: [baselineKey] },
      );

      assert.ok(
        calls.some((c) => c.method === 'POST' && c.key === 'temporal:anomalies:v1'),
        'a failed baseline write must not prevent snapshot publication',
      );
      assert.ok(
        calls.some((c) => c.method === 'POST' && c.key === 'seed-meta:temporal:anomalies'),
        'a successfully published snapshot must still stamp seed-meta',
      );
      assert.ok(
        warnings.some(([message]) => message === '[TemporalBaseline] 1/1 baseline writes failed'),
        `missing exact baseline warning; saw ${JSON.stringify(warnings)}`,
      );
    } finally {
      console.warn = originalWarn;
    }
  });

  it('does not fold a new baseline sample when one was taken recently', async () => {
    // The rebuild cadence must not drive the statistical sampling rate. Shortening
    // the cache interval previously meant 3x more samples of a slow-moving signal,
    // which shrinks the variance estimate and shifts every z-score.
    const recentlySampled = {
      mean: 1000, m2: 290_000, sampleCount: 30,
      lastUpdated: new Date(Date.now() - 60_000).toISOString(),
    };
    const { calls } = await runWithRedisStub({
      'temporal:anomalies:v1': freshSnapshot(TEMPORAL_ANOMALIES_REBUILD_AFTER_MS + 60_000),
      'news:insights:v1': { topStories: [{ id: 'a' }] },
      'wildfire:fires:v1': { fireDetections: [], pagination: { totalCount: 5 } },
      ...Object.fromEntries(
        ['news', 'satellite_fires'].map((t) => [
          makeBaselineKeyV2(t, 'global', new Date().getUTCDay(), new Date().getUTCMonth() + 1),
          recentlySampled,
        ]),
      ),
    });

    const baselineWrites = calls.filter((c) => c.method === 'POST' && c.key.includes('baseline:v2:'));
    assert.equal(
      baselineWrites.length, 0,
      `baseline was resampled ${BASELINE_SAMPLE_INTERVAL_MS / 60000}min-clock too early: ${JSON.stringify(baselineWrites)}`,
    );
  });

  it('does not resample between the rebuild threshold and the sampling interval', async () => {
    // THE test that distinguishes the two clocks. The fixtures at 60s and 61min both
    // sit on the same side of BOTH constants, so neither can tell them apart: with
    // BASELINE_SAMPLE_INTERVAL_MS swapped for TEMPORAL_ANOMALIES_REBUILD_AFTER_MS --
    // i.e. the exact re-coupling this decoupling exists to prevent -- both still pass.
    // A fixture strictly between the two constants is the only thing that catches it.
    const between = (TEMPORAL_ANOMALIES_REBUILD_AFTER_MS + BASELINE_SAMPLE_INTERVAL_MS) / 2;
    assert.ok(
      between > TEMPORAL_ANOMALIES_REBUILD_AFTER_MS && between < BASELINE_SAMPLE_INTERVAL_MS,
      'precondition: the fixture must straddle the two constants to be discriminating',
    );

    const sampledBetween = {
      mean: 1000, m2: 290_000, sampleCount: 30,
      lastUpdated: new Date(Date.now() - between).toISOString(),
    };
    const { calls } = await runWithRedisStub({
      'temporal:anomalies:v1': freshSnapshot(TEMPORAL_ANOMALIES_REBUILD_AFTER_MS + 60_000),
      'news:insights:v1': { topStories: [{ id: 'a' }] },
      'wildfire:fires:v1': { fireDetections: [], pagination: { totalCount: 5 } },
      ...Object.fromEntries(
        ['news', 'satellite_fires'].map((t) => [
          makeBaselineKeyV2(t, 'global', new Date().getUTCDay(), new Date().getUTCMonth() + 1),
          sampledBetween,
        ]),
      ),
    });

    const baselineWrites = calls.filter((c) => c.method === 'POST' && c.key.includes('baseline:v2:'));
    assert.equal(
      baselineWrites.length, 0,
      'a baseline sampled more recently than BASELINE_SAMPLE_INTERVAL_MS must NOT resample, '
      + 'even though the snapshot is past its rebuild threshold',
    );
  });

  it('folds a baseline sample once the sampling interval has elapsed', async () => {
    // Positive control for the guard above.
    const dueForSample = {
      mean: 1000, m2: 290_000, sampleCount: 30,
      lastUpdated: new Date(Date.now() - BASELINE_SAMPLE_INTERVAL_MS - 60_000).toISOString(),
    };
    const { calls } = await runWithRedisStub({
      'temporal:anomalies:v1': freshSnapshot(TEMPORAL_ANOMALIES_REBUILD_AFTER_MS + 60_000),
      'news:insights:v1': { topStories: [{ id: 'a' }] },
      'wildfire:fires:v1': { fireDetections: [], pagination: { totalCount: 5 } },
      ...Object.fromEntries(
        ['news', 'satellite_fires'].map((t) => [
          makeBaselineKeyV2(t, 'global', new Date().getUTCDay(), new Date().getUTCMonth() + 1),
          dueForSample,
        ]),
      ),
    });

    const baselineWrites = calls.filter((c) => c.method === 'POST' && c.key.includes('baseline:v2:'));
    assert.ok(baselineWrites.length > 0, 'an overdue baseline must be resampled');
  });

  it('serves the stale body rather than an empty result when the rebuild lock is lost', async () => {
    // Removing the sliding-TTL refresh must not regress this: a lock loser during a
    // rebuild window still has a usable cached body and must return it.
    const stale = freshSnapshot(TEMPORAL_ANOMALIES_REBUILD_AFTER_MS + 60_000);
    const { response, calls } = await runWithRedisStub(
      { 'temporal:anomalies:v1': stale },
      { lockGranted: false },
    );

    assert.deepEqual(response, stale, 'lock loser must fall back to the stale snapshot');

    // Asserting the body alone does not prove the lock was contended: a regression
    // that returns the stale snapshot WITHOUT attempting the lock passes that check.
    // Pin the mechanism -- lock attempted, and nothing published on the losing path.
    assert.ok(
      calls.some((c) => c.method === 'POST' && c.key === 'baseline:lock'),
      'the lock must actually be attempted; otherwise this is not the lock-loser path',
    );
    assert.equal(
      calls.filter((c) => c.method === 'POST' && c.key !== 'baseline:lock').length, 0,
      'a lock loser must not publish a snapshot, a baseline, or a freshness stamp',
    );
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
