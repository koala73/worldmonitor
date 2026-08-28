import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { __testing__ } from '../api/health.js';
import { evaluateFreshness } from '../api/mcp/freshness.ts';
import { CACHE_TOOLS } from '../api/mcp/registry/cache-tools.ts';
import {
  TEMPORAL_ANOMALIES_TTL,
  TEMPORAL_ANOMALIES_REBUILD_AFTER_MS,
  TEMPORAL_ANOMALIES_MAX_CONTENT_AGE_MIN,
  BASELINE_SAMPLE_INTERVAL_MS,
  makeBaselineKeyV2,
  temporalAnomaliesContentMeta,
  temporalAnomaliesReadableContentMeta,
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
    failedGetKeys = [],
  }: { lockGranted?: boolean; failedPostKeys?: string[]; failedGetKeys?: string[] } = {},
) {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.UPSTASH_REDIS_REST_URL;
  const originalToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  const calls: { method: string; key: string; recordCount?: number; value?: unknown }[] = [];

  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  globalThis.fetch = (async (input: unknown, init: { method?: string; body?: string } = {}) => {
    if (init.method === 'POST') {
      // Writes POST to `${url}/` with the command in the BODY (`['SET', key, ...]`),
      // not in the URL path — matching on the URL would silently match nothing.
      let key = '';
      let recordCount: number | undefined;
      let value: unknown;
      try {
        const cmd = JSON.parse(String(init.body ?? '[]'));
        if (Array.isArray(cmd)) {
          key = String(cmd[1] ?? '');
          // cmd[2] is the JSON-encoded value; capture the written seed-meta so
          // content-age assertions can check WHAT was stamped, not just that
          // a write happened.
          const written = JSON.parse(String(cmd[2] ?? 'null'));
          value = written;
          if (written && typeof written.recordCount === 'number') {
            recordCount = written.recordCount;
          }
        }
      } catch { /* leave undefined; assertions below surface it */ }
      calls.push({ method: 'POST', key, recordCount, value });
      if (failedPostKeys.includes(key)) {
        return Response.json({ error: `forced POST failure for ${key}` }, { status: 500 });
      }
      return Response.json({ result: lockGranted ? 'OK' : null });
    }
    const key = decodeURIComponent(new URL(String(input)).pathname.replace('/get/', ''));
    calls.push({ method: 'GET', key });
    // A read ERROR is not a miss: readCachedJson reports status 'error', which
    // the route must treat as "unknown this cycle" rather than "absent".
    if (failedGetKeys.includes(key)) {
      return Response.json({ error: `forced GET failure for ${key}` }, { status: 500 });
    }
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

const HOUR_MS = 60 * 60 * 1000;

function liveNews(now = Date.now(), ageMs = 10 * 60_000) {
  const newest = now - ageMs;
  return {
    topStories: [{ id: 'a', pubDate: new Date(newest).toISOString() }],
    sourceAgeRange: { newestMs: newest, oldestMs: newest },
  };
}

function liveFires(now = Date.now(), ageMs = 15 * 60_000, totalCount = 5) {
  return {
    fireDetections: [{ id: 'fire-1', source: 'firms', detectedAt: now - ageMs }],
    pagination: { nextCursor: '', totalCount },
  };
}

function frozenNews(now = Date.now(), ageMs = 72 * HOUR_MS) {
  return liveNews(now, ageMs);
}

function frozenFires(now = Date.now(), ageMs = 72 * HOUR_MS, totalCount = 5) {
  return liveFires(now, ageMs, totalCount);
}

/** Canonical wildfire merge when FIRMS is down and CWFIS/BC still publish. */
function canadaOnlyDegradedFires(now = Date.now()) {
  return {
    fireDetections: [
      { id: 'cwfis-1', source: 'cwfis', detectedAt: now - 30 * 60_000 },
      { id: 'bc-1', source: 'bc', detectedAt: now - 20 * 60_000 },
    ],
    _firmsState: 'failed',
    _firmsErrorCode: 'FIRMS_SOURCE_FAILED',
    _cwfisState: 'ok',
    _bcState: 'ok',
  };
}

/** FIRMS rows present, but none carry a usable `detectedAt`. */
function undatableFires(totalCount = 5) {
  return {
    fireDetections: [{ id: 'fire-1', source: 'firms' }],
    pagination: { nextCursor: '', totalCount },
  };
}

function seedMetaStamp(calls: { method: string; key: string; value?: unknown }[]) {
  return calls.find((call) => call.method === 'POST' && call.key === 'seed-meta:temporal:anomalies');
}

function temporalAnomaliesCheck() {
  const tool = CACHE_TOOLS.find((candidate) => candidate.name === 'get_temporal_anomalies');
  assert.ok(tool, 'get_temporal_anomalies must exist');
  const check = tool._freshnessChecks?.find((candidate) => candidate.key === 'seed-meta:temporal:anomalies');
  assert.ok(check, 'get_temporal_anomalies must declare the temporal-anomalies freshness check');
  return check;
}

function classifyTemporalMeta(meta: Record<string, unknown>, now: number) {
  return __testing__.classifyKey(
    'temporalAnomalies',
    'temporal:anomalies:v1',
    { allowOnDemand: true },
    {
      keyStrens: new Map([['temporal:anomalies:v1', 96]]),
      keyErrors: new Map(),
      keyMetaValues: new Map([['seed-meta:temporal:anomalies', JSON.stringify(meta)]]),
      keyMetaErrors: new Map(),
      now,
    },
  );
}

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
      'news:insights:v1': liveNews(),
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
      'news:insights:v1': liveNews(),
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
      'news:insights:v1': liveNews(),
      'wildfire:fires:v1': liveFires(),
    });

    const stamp = calls.find((c) => c.method === 'POST' && c.key === 'seed-meta:temporal:anomalies');
    assert.equal(stamp?.recordCount, 2, 'both sources read must stamp recordCount 2');
    const meta = stamp?.value as { maxContentAgeMin?: number; newestItemAt?: number } | undefined;
    assert.equal(
      meta?.maxContentAgeMin,
      TEMPORAL_ANOMALIES_MAX_CONTENT_AGE_MIN,
      'a successful rebuild must opt into the content-age contract',
    );
    assert.equal(typeof meta?.newestItemAt, 'number', 'datable live sources must stamp a newestItemAt');
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
        'news:insights:v1': liveNews(),
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
          'news:insights:v1': liveNews(),
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
      'news:insights:v1': liveNews(),
      'wildfire:fires:v1': liveFires(),
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
      'news:insights:v1': liveNews(),
      'wildfire:fires:v1': liveFires(),
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
      'news:insights:v1': liveNews(),
      'wildfire:fires:v1': liveFires(),
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
      fireDetections: Array.from({ length: 10 }, (_, index) => ({
        id: `fire-${index}`,
        source: 'firms',
        detectedAt: Date.now() - 10 * 60_000,
      })),
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

describe('temporal anomalies content-age extractor (#7141)', () => {
  const NOW = Date.parse('2026-08-27T12:00:00.000Z');

  it('reduces independently-failing sources with min, not max', () => {
    const newsAge = 72 * HOUR_MS;
    const firesAge = 10 * 60_000;
    const meta = temporalAnomaliesContentMeta({
      news: frozenNews(NOW, newsAge),
      satellite_fires: liveFires(NOW, firesAge),
    }, NOW);

    assert.ok(meta, 'both sources datable');
    assert.equal(
      meta.newestItemAt,
      NOW - newsAge,
      'frozen news must win over live fires — max() would hide the freeze',
    );
    // oldestItemAt reduces with min() too: it is the oldest observation across
    // every contributing source, so the frozen news window bounds it. Without
    // this assertion a swapped reduction on either field ships green.
    assert.equal(
      meta.oldestItemAt,
      NOW - newsAge,
      'oldestItemAt is the min across sources, not the max',
    );
  });

  it('reduces oldestItemAt to the oldest observation across sources', () => {
    // Distinct newest/oldest per source so a newest/oldest swap cannot pass:
    // news spans [-90m, -30m], fires spans [-50m, -20m].
    const meta = temporalAnomaliesContentMeta({
      news: {
        topStories: [
          { id: 'old', pubDate: new Date(NOW - 90 * 60_000).toISOString() },
          { id: 'new', pubDate: new Date(NOW - 30 * 60_000).toISOString() },
        ],
      },
      satellite_fires: {
        fireDetections: [
          { id: 'f-old', source: 'firms', detectedAt: NOW - 50 * 60_000 },
          { id: 'f-new', source: 'firms', detectedAt: NOW - 20 * 60_000 },
        ],
        pagination: { nextCursor: '', totalCount: 2 },
      },
    }, NOW);

    assert.ok(meta);
    // news newest -30m vs fires newest -20m -> min is news at -30m.
    assert.equal(meta.newestItemAt, NOW - 30 * 60_000, 'newest is min of per-source newest');
    // news oldest -90m vs fires oldest -50m -> min is news at -90m.
    assert.equal(meta.oldestItemAt, NOW - 90 * 60_000, 'oldest is min of per-source oldest');
  });

  it('a live news clock must not hide frozen FIRMS detections', () => {
    const newsAge = 8 * 60_000;
    const firesAge = 72 * HOUR_MS;
    const meta = temporalAnomaliesContentMeta({
      news: liveNews(NOW, newsAge),
      satellite_fires: frozenFires(NOW, firesAge),
    }, NOW);

    assert.ok(meta);
    assert.equal(meta.newestItemAt, NOW - firesAge);
  });

  it('skips an empty FIRMS window rather than failing the news clock', () => {
    const newsAge = 12 * 60_000;
    const meta = temporalAnomaliesContentMeta({
      news: liveNews(NOW, newsAge),
      satellite_fires: { fireDetections: [], pagination: { totalCount: 0 } },
    }, NOW);

    assert.ok(meta);
    assert.equal(meta.newestItemAt, NOW - newsAge);
  });

  it('fails closed when a contributing news payload has items but no dates', () => {
    const meta = temporalAnomaliesContentMeta({
      news: { topStories: [{ id: 'a' }] },
      satellite_fires: liveFires(NOW),
    }, NOW);

    assert.equal(meta, null, 'undatable news items are STALE_CONTENT, not skipped');
  });

  it('fails closed when FIRMS rows exist but none have a usable detectedAt', () => {
    const meta = temporalAnomaliesContentMeta({
      news: liveNews(NOW),
      satellite_fires: undatableFires(),
    }, NOW);

    assert.equal(meta, null, 'undatable FIRMS rows are STALE_CONTENT, not skipped');
  });

  it('ignores agency ignition dates when FIRMS rows are present', () => {
    const firmsAt = NOW - 20 * 60_000;
    const agencyAt = NOW - 10 * 24 * HOUR_MS;
    const meta = temporalAnomaliesContentMeta({
      news: liveNews(NOW, 8 * 60_000),
      satellite_fires: {
        fireDetections: [
          { id: 'cwfis-1', source: 'cwfis', detectedAt: agencyAt },
          { id: 'firms-1', source: 'firms', detectedAt: firmsAt },
        ],
      },
    }, NOW);

    assert.ok(meta);
    assert.equal(meta.newestItemAt, firmsAt);
  });

  it('fails closed on an explicit FIRMS failure even when CWFIS/BC still publish', () => {
    const newsAge = 12 * 60_000;
    const meta = temporalAnomaliesContentMeta({
      news: liveNews(NOW, newsAge),
      satellite_fires: canadaOnlyDegradedFires(NOW),
    }, NOW);

    assert.equal(
      meta,
      null,
      'Canada-only degraded payload must fail closed, not skip so live news looks fresh',
    );
  });

  it('fails closed on declared partial FIRMS coverage even when surviving rows are live', () => {
    const meta = temporalAnomaliesContentMeta({
      news: liveNews(NOW, 12 * 60_000),
      satellite_fires: {
        ...liveFires(NOW, 15 * 60_000),
        _firmsState: 'ok',
        _firmsPartial: true,
      },
    }, NOW);

    assert.equal(
      meta,
      null,
      'known missing FIRMS regions must not let surviving rows stamp complete coverage as fresh',
    );
  });

  it('fails closed on a silent FIRMS outage (_firmsState ok, _firmsCount 0)', () => {
    // The shape the canonical merge published BEFORE the #7141 follow-up:
    // fetchAllRegions catches every per-region error and always resolves, so a
    // worldwide FIRMS outage settled 'fulfilled' with zero rows and graded
    // _firmsState 'ok'. CWFIS/BC rows keep fireDetections non-empty, so the
    // old code took the firmsRows === 0 SKIP arm and let live news stamp a
    // fresh clock while worldwide satellite coverage was gone.
    const meta = temporalAnomaliesContentMeta({
      news: liveNews(NOW, 12 * 60_000),
      satellite_fires: {
        fireDetections: [
          { id: 'cwfis-1', source: 'cwfis', detectedAt: NOW - 30 * 60_000 },
          { id: 'bc-1', source: 'bc-wildfire', detectedAt: NOW - 20 * 60_000 },
        ],
        _firmsState: 'ok',
        _firmsCount: 0,
      },
    }, NOW);

    assert.equal(
      meta,
      null,
      'zero declared FIRMS coverage must fail closed, not skip so live news reads fresh',
    );
  });

  it('still skips an agency-only payload that does not declare a FIRMS failure', () => {
    const newsAge = 12 * 60_000;
    const meta = temporalAnomaliesContentMeta({
      news: liveNews(NOW, newsAge),
      satellite_fires: {
        fireDetections: [
          { id: 'cwfis-1', source: 'cwfis', detectedAt: NOW - 30 * 60_000 },
        ],
      },
    }, NOW);

    assert.ok(meta);
    assert.equal(meta.newestItemAt, NOW - newsAge);
  });

  it('drops future-dated observations beyond the 1h clock-skew tolerance', () => {
    const real = NOW - 30 * 60_000;
    const future = NOW + 2 * HOUR_MS;
    const meta = temporalAnomaliesContentMeta({
      news: {
        topStories: [
          { id: 'future', pubDate: new Date(future).toISOString() },
          { id: 'real', pubDate: new Date(real).toISOString() },
        ],
      },
      // Present empty FIRMS window still skips; this isolates the news skew rule.
      satellite_fires: { fireDetections: [], pagination: { totalCount: 0 } },
    }, NOW);

    assert.ok(meta);
    assert.equal(meta.newestItemAt, real);
  });

  it('readable-only clock skips an unreadable source instead of failing closed', () => {
    // The transient-read-error path: news could not be read this cycle, fires
    // is live. temporalAnomaliesContentMeta fails closed here (absent = gone),
    // which is what made one Redis blip page on live data.
    const firesAge = 15 * 60_000;
    const readable = temporalAnomaliesReadableContentMeta({
      satellite_fires: liveFires(NOW, firesAge),
    }, NOW);

    assert.equal(readable.status, 'ok');
    assert.equal(readable.status === 'ok' && readable.clock.newestItemAt, NOW - firesAge);
    assert.equal(
      temporalAnomaliesContentMeta({ satellite_fires: liveFires(NOW, firesAge) }, NOW),
      null,
      'the strict variant still fails closed on an absent configured source',
    );
  });

  it('readable-only clock still fails closed on a readable source that is unhealthy', () => {
    // The masking case: news is unreadable, and the source we CAN read reports
    // an explicit FIRMS outage. Carrying a prior clock over this would hide a
    // known outage behind a healthy number.
    const readable = temporalAnomaliesReadableContentMeta({
      satellite_fires: canadaOnlyDegradedFires(NOW),
    }, NOW);

    assert.equal(readable.status, 'fail-closed');
  });

  it('readable-only clock reports no-signal when every readable source skips', () => {
    const readable = temporalAnomaliesReadableContentMeta({
      satellite_fires: { fireDetections: [], pagination: { totalCount: 0 } },
    }, NOW);

    assert.equal(readable.status, 'no-signal', 'an empty FIRMS window teaches us nothing');
  });

  it('fails closed when a configured COUNT_SOURCE_KEYS read is missing', () => {
    assert.equal(
      temporalAnomaliesContentMeta({ news: liveNews(NOW, 8 * 60_000) }, NOW),
      null,
      'live news plus absent wildfire must not stamp a news-only content clock',
    );
    assert.equal(
      temporalAnomaliesContentMeta({ satellite_fires: liveFires(NOW, 10 * 60_000) }, NOW),
      null,
      'live fires plus absent news must not stamp a fires-only content clock',
    );
  });
});

describe('temporal anomalies frozen-but-200 feed (#7141)', () => {
  it('stamps content age from the payloads, not the rebuild clock', async () => {
    const now = Date.now();
    const frozenAge = 72 * HOUR_MS;
    const { calls } = await runWithRedisStub({
      'temporal:anomalies:v1': freshSnapshot(TEMPORAL_ANOMALIES_REBUILD_AFTER_MS + 60_000),
      'news:insights:v1': frozenNews(now, frozenAge),
      'wildfire:fires:v1': liveFires(now, 12 * 60_000),
    });

    const stamp = seedMetaStamp(calls);
    const meta = stamp?.value as {
      fetchedAt?: number;
      newestItemAt?: number;
      maxContentAgeMin?: number;
    } | undefined;
    assert.ok(meta, 'rebuild must stamp seed-meta');
    assert.equal(typeof meta.fetchedAt, 'number');
    assert.ok(
      Math.abs((meta.fetchedAt ?? 0) - now) < 5_000,
      'fetchedAt is the rebuild clock and stays fresh on a frozen feed',
    );
    assert.equal(meta.maxContentAgeMin, TEMPORAL_ANOMALIES_MAX_CONTENT_AGE_MIN);
    assert.ok(
      Math.abs((meta.newestItemAt ?? 0) - (now - frozenAge)) < 5_000,
      `newestItemAt must be the frozen news observation, not rebuild time; got ${meta.newestItemAt}`,
    );
  });

  it('a frozen-but-200 feed does not read green on health or MCP', async () => {
    const now = Date.now();
    const frozenAge = 72 * HOUR_MS;
    const { calls } = await runWithRedisStub({
      'temporal:anomalies:v1': freshSnapshot(TEMPORAL_ANOMALIES_REBUILD_AFTER_MS + 60_000),
      'news:insights:v1': frozenNews(now, frozenAge),
      'wildfire:fires:v1': liveFires(now, 12 * 60_000),
    });

    const meta = seedMetaStamp(calls)?.value as Record<string, unknown> | undefined;
    assert.ok(meta, 'precondition: rebuild stamped seed-meta');

    const health = classifyTemporalMeta(meta, now);
    assert.equal(
      health.status,
      'STALE_CONTENT',
      'health must not stay OK when upstream observations are past the content budget',
    );

    const mcp = evaluateFreshness([temporalAnomaliesCheck()], [meta], now);
    assert.equal(
      mcp.stale,
      true,
      'MCP must not answer stale:false for the key health calls STALE_CONTENT',
    );
  });

  it('a partial FIRMS payload does not read green on health or MCP', async () => {
    const now = Date.now();
    const { calls } = await runWithRedisStub({
      'temporal:anomalies:v1': freshSnapshot(TEMPORAL_ANOMALIES_REBUILD_AFTER_MS + 60_000),
      'news:insights:v1': liveNews(now, 20 * 60_000),
      'wildfire:fires:v1': {
        ...liveFires(now, 25 * 60_000),
        _firmsState: 'ok',
        _firmsPartial: true,
      },
    });

    const meta = seedMetaStamp(calls)?.value as Record<string, unknown> | undefined;
    assert.ok(meta, 'partial FIRMS coverage must still stamp seed-meta');
    assert.equal(meta.newestItemAt, null);
    assert.equal(
      classifyTemporalMeta(meta, now).status,
      'STALE_CONTENT',
      'health must surface known partial FIRMS coverage',
    );
    assert.equal(
      evaluateFreshness([temporalAnomaliesCheck()], [meta], now).stale,
      true,
      'MCP must surface known partial FIRMS coverage',
    );
  });

  it('stays green on both surfaces when observations are inside the content budget', async () => {
    const now = Date.now();
    const { calls } = await runWithRedisStub({
      'temporal:anomalies:v1': freshSnapshot(TEMPORAL_ANOMALIES_REBUILD_AFTER_MS + 60_000),
      'news:insights:v1': liveNews(now, 20 * 60_000),
      'wildfire:fires:v1': liveFires(now, 25 * 60_000),
    });

    const meta = seedMetaStamp(calls)?.value as Record<string, unknown> | undefined;
    assert.ok(meta, 'precondition: rebuild stamped seed-meta');

    const health = classifyTemporalMeta(meta, now);
    assert.equal(health.status, 'OK', 'live payloads must not false-alarm as STALE_CONTENT');
    assert.equal(
      evaluateFreshness([temporalAnomaliesCheck()], [meta], now).stale,
      false,
      'MCP must stay fresh when content is inside budget',
    );
  });

  it('a Canada-only degraded FIRMS payload does not read green on seed-meta, health, or MCP', async () => {
    const now = Date.now();
    const { calls } = await runWithRedisStub({
      'temporal:anomalies:v1': freshSnapshot(TEMPORAL_ANOMALIES_REBUILD_AFTER_MS + 60_000),
      'news:insights:v1': liveNews(now, 12 * 60_000),
      'wildfire:fires:v1': canadaOnlyDegradedFires(now),
    });

    const meta = seedMetaStamp(calls)?.value as Record<string, unknown> | undefined;
    assert.ok(meta, 'rebuild must stamp seed-meta for the degraded Canada-only payload');
    assert.equal(
      meta.newestItemAt,
      null,
      'explicit FIRMS failure must stamp newestItemAt null, not the live news clock',
    );
    assert.equal(meta.maxContentAgeMin, TEMPORAL_ANOMALIES_MAX_CONTENT_AGE_MIN);

    assert.equal(
      classifyTemporalMeta(meta, now).status,
      'STALE_CONTENT',
      'health must fail closed when worldwide FIRMS coverage is missing',
    );
    assert.equal(
      evaluateFreshness([temporalAnomaliesCheck()], [meta], now).stale,
      true,
      'MCP must not answer stale:false for the Canada-only degraded payload',
    );
  });

  it('stamps newestItemAt null when a contributing payload is undatable', async () => {
    const now = Date.now();
    const { calls } = await runWithRedisStub({
      'temporal:anomalies:v1': freshSnapshot(TEMPORAL_ANOMALIES_REBUILD_AFTER_MS + 60_000),
      'news:insights:v1': { topStories: [{ id: 'a' }] },
      'wildfire:fires:v1': liveFires(),
    });

    const meta = seedMetaStamp(calls)?.value as Record<string, unknown> | undefined;
    assert.ok(meta);
    assert.equal(meta.newestItemAt, null);
    assert.equal(meta.maxContentAgeMin, TEMPORAL_ANOMALIES_MAX_CONTENT_AGE_MIN);
    assert.equal(
      classifyTemporalMeta(meta, now).status,
      'STALE_CONTENT',
      'undatable contributing payloads fail closed, matching runSeed contentMeta null',
    );
    assert.equal(
      evaluateFreshness([temporalAnomaliesCheck()], [meta], now).stale,
      true,
      'MCP must not answer stale:false for the key health calls STALE_CONTENT',
    );
  });

  it('a future-dated newestItemAt does not read green on health or MCP', () => {
    const now = Date.now();
    const meta = {
      fetchedAt: now - 5 * 60_000,
      recordCount: 2,
      newestItemAt: now + 60 * 60_000,
      maxContentAgeMin: TEMPORAL_ANOMALIES_MAX_CONTENT_AGE_MIN,
    };

    assert.equal(
      classifyTemporalMeta(meta, now).status,
      'STALE_CONTENT',
      'future-dated observations are suspicious data, not fresh data',
    );
    assert.equal(
      evaluateFreshness([temporalAnomaliesCheck()], [meta], now).stale,
      true,
      'MCP must not answer stale:false for the key health calls STALE_CONTENT',
    );
  });

  it('fails closed on health and MCP when one configured source is absent', async () => {
    const now = Date.now();
    const { calls } = await runWithRedisStub({
      'temporal:anomalies:v1': freshSnapshot(TEMPORAL_ANOMALIES_REBUILD_AFTER_MS + 60_000),
      'news:insights:v1': liveNews(now, 20 * 60_000),
      // wildfire:fires:v1 deliberately absent
    });

    const meta = seedMetaStamp(calls)?.value as Record<string, unknown> | undefined;
    assert.ok(meta, 'precondition: rebuild stamped seed-meta');
    assert.equal(meta.recordCount, 1, 'achieved coverage stays 1');
    assert.equal(
      meta.newestItemAt,
      null,
      'the remaining live source must not stamp a fresh content clock',
    );

    assert.equal(
      classifyTemporalMeta(meta, now).status,
      'STALE_CONTENT',
      'health must fail closed on incomplete configured-source coverage',
    );
    assert.equal(
      evaluateFreshness([temporalAnomaliesCheck()], [meta], now).stale,
      true,
      'MCP must fail closed on the same incomplete coverage',
    );
  });

  it('stamps newestItemAt null when FIRMS rows have no usable detectedAt', async () => {
    const now = Date.now();
    const { calls } = await runWithRedisStub({
      'temporal:anomalies:v1': freshSnapshot(TEMPORAL_ANOMALIES_REBUILD_AFTER_MS + 60_000),
      'news:insights:v1': liveNews(now),
      'wildfire:fires:v1': undatableFires(),
    });

    const meta = seedMetaStamp(calls)?.value as Record<string, unknown> | undefined;
    assert.ok(meta, 'rebuild must stamp seed-meta');
    assert.equal(meta.newestItemAt, null);
    assert.equal(meta.maxContentAgeMin, TEMPORAL_ANOMALIES_MAX_CONTENT_AGE_MIN);

    assert.equal(
      classifyTemporalMeta(meta, now).status,
      'STALE_CONTENT',
      'undatable FIRMS rows fail closed on health even when news is live',
    );
    assert.equal(
      evaluateFreshness([temporalAnomaliesCheck()], [meta], now).stale,
      true,
      'MCP must not answer stale:false for undatable FIRMS',
    );
  });

  it('a transient read error on one source does not stamp a false STALE_CONTENT', async () => {
    const now = Date.now();
    const priorNewest = now - 30 * 60_000;
    const { calls } = await runWithRedisStub({
      'temporal:anomalies:v1': freshSnapshot(TEMPORAL_ANOMALIES_REBUILD_AFTER_MS + 60_000),
      'news:insights:v1': liveNews(now, 20 * 60_000),
      'wildfire:fires:v1': liveFires(now, 25 * 60_000),
      'seed-meta:temporal:anomalies': {
        fetchedAt: now - 20 * 60_000,
        recordCount: 2,
        newestItemAt: priorNewest,
        oldestItemAt: priorNewest,
        maxContentAgeMin: TEMPORAL_ANOMALIES_MAX_CONTENT_AGE_MIN,
      },
    }, { failedGetKeys: ['news:insights:v1'] });

    const meta = seedMetaStamp(calls)?.value as Record<string, unknown> | undefined;
    assert.ok(meta, 'rebuild must still stamp seed-meta');
    assert.notEqual(
      meta.newestItemAt,
      null,
      'a Redis blip on one live source must not assert STALE_CONTENT on live data',
    );
    assert.equal(
      classifyTemporalMeta(meta, now).status,
      'OK',
      'health must stay green through a transient read error',
    );
  });

  it('preserves an older prior clock when a readable source is fresh after a read error', async () => {
    const now = Date.now();
    const priorNewest = now - 72 * HOUR_MS;
    const priorOldest = now - 73 * HOUR_MS;
    const { calls } = await runWithRedisStub({
      'temporal:anomalies:v1': freshSnapshot(TEMPORAL_ANOMALIES_REBUILD_AFTER_MS + 60_000),
      'wildfire:fires:v1': liveFires(now, 25 * 60_000),
      'seed-meta:temporal:anomalies': {
        fetchedAt: now - 20 * 60_000,
        recordCount: 2,
        newestItemAt: priorNewest,
        oldestItemAt: priorOldest,
        maxContentAgeMin: TEMPORAL_ANOMALIES_MAX_CONTENT_AGE_MIN,
      },
    }, { failedGetKeys: ['news:insights:v1'] });

    const meta = seedMetaStamp(calls)?.value as Record<string, unknown> | undefined;
    assert.ok(meta, 'the partial rebuild must stamp seed-meta');
    assert.equal(
      meta.newestItemAt,
      priorNewest,
      'the carried prior newest clock must win over a fresher readable source',
    );
    assert.equal(
      meta.oldestItemAt,
      priorOldest,
      'the carried prior oldest clock must win over a fresher readable source',
    );
    assert.equal(
      classifyTemporalMeta(meta, now).status,
      'STALE_CONTENT',
      'health must preserve the older prior content age rather than turn green',
    );
    assert.equal(
      evaluateFreshness([temporalAnomaliesCheck()], [meta], now).stale,
      true,
      'MCP must preserve the older prior content age rather than turn fresh',
    );
  });

  it('fails closed on health and MCP for a cold partial rebuild after a count-source read error', async () => {
    const now = Date.now();
    const { calls } = await runWithRedisStub({
      'temporal:anomalies:v1': freshSnapshot(TEMPORAL_ANOMALIES_REBUILD_AFTER_MS + 60_000),
      'wildfire:fires:v1': liveFires(now, 25 * 60_000),
      // No seed-meta:temporal:anomalies entry. This is a cold start, so no
      // last-known-good content clock may be carried over the read error.
    }, { failedGetKeys: ['news:insights:v1'] });

    const meta = seedMetaStamp(calls)?.value as Record<string, unknown> | undefined;
    assert.ok(meta, 'the partial rebuild must still stamp its fail-closed seed-meta');
    assert.equal(
      meta.newestItemAt,
      null,
      'a cold partial rebuild must not use the live source as a complete content clock',
    );
    assert.equal(
      classifyTemporalMeta(meta, now).status,
      'STALE_CONTENT',
      'health must not report a cold partial rebuild as healthy',
    );
    assert.equal(
      evaluateFreshness([temporalAnomaliesCheck()], [meta], now).stale,
      true,
      'MCP must not report a cold partial rebuild as fresh',
    );
  });

  it('a read error must not mask a readable source that failed closed', async () => {
    // The masking case: news is unreadable this cycle, and the source we CAN
    // read reports an explicit FIRMS outage. Carrying the previous healthy
    // clock forward would hide a known outage behind a fresh-looking number —
    // the exact freeze this contract exists to catch.
    const now = Date.now();
    const { calls } = await runWithRedisStub({
      'temporal:anomalies:v1': freshSnapshot(TEMPORAL_ANOMALIES_REBUILD_AFTER_MS + 60_000),
      'news:insights:v1': liveNews(now, 20 * 60_000),
      'wildfire:fires:v1': canadaOnlyDegradedFires(now),
      'seed-meta:temporal:anomalies': {
        fetchedAt: now - 20 * 60_000,
        recordCount: 2,
        newestItemAt: now - 30 * 60_000,
        oldestItemAt: now - 30 * 60_000,
        maxContentAgeMin: TEMPORAL_ANOMALIES_MAX_CONTENT_AGE_MIN,
      },
    }, { failedGetKeys: ['news:insights:v1'] });

    const meta = seedMetaStamp(calls)?.value as Record<string, unknown> | undefined;
    assert.ok(meta, 'rebuild must still stamp seed-meta');
    assert.equal(
      meta.newestItemAt,
      null,
      'a known FIRMS outage must not be papered over with the previous clock',
    );
    assert.equal(
      classifyTemporalMeta(meta, now).status,
      'STALE_CONTENT',
      'health must see the outage the readable source reported',
    );
  });

  it('diverges again if the content-age trio is dropped from the stamp', async () => {
    const now = Date.now();
    const { calls } = await runWithRedisStub({
      'temporal:anomalies:v1': freshSnapshot(TEMPORAL_ANOMALIES_REBUILD_AFTER_MS + 60_000),
      'news:insights:v1': frozenNews(now, 72 * HOUR_MS),
      'wildfire:fires:v1': liveFires(now, 12 * 60_000),
    });

    const stamped = seedMetaStamp(calls)?.value as Record<string, unknown> | undefined;
    assert.ok(stamped);
    const livenessOnly = {
      fetchedAt: stamped.fetchedAt,
      recordCount: stamped.recordCount,
    };

    assert.equal(
      classifyTemporalMeta(livenessOnly, now).status,
      'OK',
      'without the content-age trio the rebuild clock reads green — the #7141 gap',
    );
    assert.equal(
      evaluateFreshness([temporalAnomaliesCheck()], [livenessOnly], now).stale,
      false,
      'MCP liveness-only is also green, proving the trio is what closes the gap',
    );
    assert.equal(
      classifyTemporalMeta(stamped, now).status,
      'STALE_CONTENT',
      'while the stamped trio still alarms',
    );
  });
});
