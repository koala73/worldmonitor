import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import { __testing__ } from '../api/health.js';
import seedHealthHandler from '../api/seed-health.js';
import { atomicPublish, runSeed } from '../scripts/_seed-utils.mjs';
import { CROSS_STRAIT_ACTIVITY_KEY } from '../scripts/cross-strait-activity/adapters.mjs';
import {
  CROSS_STRAIT_ACTIVITY_BOOTSTRAP_KEY,
  CROSS_STRAIT_ACTIVITY_BOOTSTRAP_MAX_BYTES,
  CROSS_STRAIT_ACTIVITY_BOOTSTRAP_META_KEY,
  CROSS_STRAIT_ACTIVITY_COMPLETION_META_KEY,
  CROSS_STRAIT_ACTIVITY_FETCH_PHASE_TIMEOUT_MS,
  CROSS_STRAIT_ACTIVITY_LOCK_TTL_MS,
  CROSS_STRAIT_ACTIVITY_PUBLISH_CLEANUP_HEADROOM_MS,
  CROSS_STRAIT_ACTIVITY_TTL_SECONDS,
  crossStraitActivityAfterPublish,
  crossStraitActivityBeforePublish,
  projectCrossStraitActivityBootstrap,
  writePublicationCompletion,
  writeSourceHealth,
} from '../scripts/seed-cross-strait-activity.mjs';

const root = resolve(import.meta.dirname, '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

function observation(sourceId: string, reportingDay: string, history = []) {
  return {
    id: `${sourceId}:${reportingDay}`,
    sourceId,
    observationKind: sourceId === 'japan-mod' ? 'reviewed_regional_augmentation' : 'daily_activity_report',
    reportingDay,
    reportingPeriod: { end: `${reportingDay}T06:00:00+08:00` },
    revision: { sequence: 2 },
    history,
  };
}

test('cross-Strait bootstrap is a bounded current projection, not the durable revision archive', () => {
  const snapshot = {
    schemaVersion: 1,
    generatedAt: '2026-07-25T12:00:00.000Z',
    status: 'degraded',
    sources: [
      { id: 'taiwan-mnd', transportStatus: 'error' },
      {
        id: 'japan-mod',
        transportStatus: 'error',
        blockedReason: 'HTTP_403',
        proxyFailureDetail: {
          stage: 'response',
          httpStatus: 403,
          contentType: null,
          bodyPrefix: null,
          errorCode: null,
          errorMessage: 'HTTP_403',
        },
      },
    ],
    coverage: { latestMndReportingDay: '2026-07-25' },
    observations: [
      observation('taiwan-mnd', '2026-07-24', [{ obsolete: true }]),
      observation('taiwan-mnd', '2026-07-25', [{ corrected: true }]),
      observation('japan-mod', '2026-07-20', [{ reviewed: true }]),
      { ...observation('japan-mod', '2026-07-19'), observationKind: 'unreviewed_candidate' },
    ],
    baselines: { sourceId: 'taiwan-mnd' },
  };

  const projection = projectCrossStraitActivityBootstrap(snapshot);
  assert.equal(CROSS_STRAIT_ACTIVITY_BOOTSTRAP_KEY, 'military:cross-strait-activity-bootstrap:v1');
  assert.deepEqual(projection.observations.map((row) => row.id), [
    'taiwan-mnd:2026-07-25',
    'japan-mod:2026-07-20',
  ]);
  assert.ok(projection.observations.every((row) => !('history' in row)));
  assert.deepEqual(projection.sources, snapshot.sources.map((source) => {
    const { proxyFailureDetail: _proxyFailureDetail, ...publicSource } = source;
    return publicSource;
  }));
  assert.equal(
    projection.sources.some((source) => 'proxyFailureDetail' in source),
    false,
  );
  assert.deepEqual(projection.coverage, snapshot.coverage);
  assert.deepEqual(projection.baselines, snapshot.baselines);
  assert.ok(Buffer.byteLength(JSON.stringify(projection), 'utf8') <= CROSS_STRAIT_ACTIVITY_BOOTSTRAP_MAX_BYTES);
  assert.throws(
    () => projectCrossStraitActivityBootstrap({ ...snapshot, sources: [{ padding: 'x'.repeat(CROSS_STRAIT_ACTIVITY_BOOTSTRAP_MAX_BYTES) }] }),
    /bootstrap projection is .* bytes; maximum is/,
  );
});

test('cross-Strait source transport health degrades immediately without discarding last-good records', () => {
  const { classifyKey, SEED_META, STANDALONE_KEYS } = __testing__;
  const now = Date.parse('2026-07-25T12:00:00.000Z');
  for (const name of ['crossStraitActivityTaiwanMnd', 'crossStraitActivityJapanMod']) {
    const dataKey = STANDALONE_KEYS[name];
    const metaKey = SEED_META[name].key;
    const entry = classifyKey(name, dataKey, { allowOnDemand: true }, {
      keyStrens: new Map([[dataKey, 1024]]),
      keyErrors: new Map(),
      keyMetaValues: new Map([[metaKey, JSON.stringify({
        fetchedAt: now - 60_000,
        recordCount: 91,
        sourceState: 'error',
        stale: true,
      })]]),
      keyMetaErrors: new Map(),
      now,
    });

    assert.equal(entry.status, 'SEED_ERROR', name);
    assert.equal(entry.records, 91, name);
  }
});

test('a freshly classified blocked source is explicit and does not pin fleet health', async () => {
  const { classifyKey, STATUS_COUNTS, SEED_META, STANDALONE_KEYS } = __testing__;
  const now = Date.parse('2026-07-27T20:00:00.000Z');
  const writes = new Map<string, unknown>();
  const snapshot = {
    generatedAt: new Date(now).toISOString(),
    observations: [
      { sourceId: 'japan-mod' },
      { sourceId: 'japan-mod' },
    ],
    sources: [{
      id: 'japan-mod',
      transportStatus: 'error',
      blockedReason: 'HTTP_403',
      lastSuccessAt: null,
    }],
  };

  await writeSourceHealth(snapshot, async (key: string, value: unknown) => {
    writes.set(key, value);
  });

  const metaKey = SEED_META.crossStraitActivityJapanMod.key;
  const dataKey = STANDALONE_KEYS.crossStraitActivityJapanMod;
  assert.deepEqual([...writes.keys()], [dataKey, metaKey]);
  assert.deepEqual(writes.get(metaKey), {
    fetchedAt: now,
    recordCount: 2,
    sourceState: 'blocked',
    stale: false,
  });

  const entry = classifyKey('crossStraitActivityJapanMod', dataKey, { allowOnDemand: true }, {
    keyStrens: new Map([[dataKey, 1024]]),
    keyErrors: new Map(),
    keyMetaValues: new Map([[metaKey, JSON.stringify(writes.get(metaKey))]]),
    keyMetaErrors: new Map(),
    now,
  });

  assert.equal(entry.status, 'SOURCE_BLOCKED');
  assert.equal(entry.records, 2);
  assert.equal(STATUS_COUNTS.SOURCE_BLOCKED, 'ok');

  const mndMetaKey = SEED_META.crossStraitActivityTaiwanMnd.key;
  const mndDataKey = STANDALONE_KEYS.crossStraitActivityTaiwanMnd;
  const mndEntry = classifyKey(
    'crossStraitActivityTaiwanMnd',
    mndDataKey,
    { allowOnDemand: true },
    {
      keyStrens: new Map([[mndDataKey, 1024]]),
      keyErrors: new Map(),
      keyMetaValues: new Map([[
        mndMetaKey,
        JSON.stringify({
          fetchedAt: now,
          recordCount: 2,
          sourceState: 'blocked',
          stale: false,
        }),
      ]]),
      keyMetaErrors: new Map(),
      now,
    },
  );

  assert.equal(mndEntry.status, 'SEED_ERROR');
  assert.equal(STATUS_COUNTS[mndEntry.status], 'warn');

  const staleEntry = classifyKey(
    'crossStraitActivityJapanMod',
    dataKey,
    { allowOnDemand: true },
    {
      keyStrens: new Map([[dataKey, 1024]]),
      keyErrors: new Map(),
      keyMetaValues: new Map([[
        metaKey,
        JSON.stringify({
          fetchedAt: now - ((SEED_META.crossStraitActivityJapanMod.maxStaleMin + 1) * 60_000),
          recordCount: 2,
          sourceState: 'blocked',
          stale: false,
        }),
      ]]),
      keyMetaErrors: new Map(),
      now,
    },
  );
  assert.equal(staleEntry.status, 'STALE_SEED');

  const missingEntry = classifyKey(
    'crossStraitActivityJapanMod',
    dataKey,
    { allowOnDemand: true },
    {
      keyStrens: new Map([[dataKey, 0]]),
      keyErrors: new Map(),
      keyMetaValues: new Map([[metaKey, JSON.stringify(writes.get(metaKey))]]),
      keyMetaErrors: new Map(),
      now,
    },
  );
  assert.notEqual(missingEntry.status, 'SOURCE_BLOCKED');
  assert.equal(STATUS_COUNTS[missingEntry.status], 'crit');
});

test('blocked source health never publishes fresh metadata before its detail record', async () => {
  const writes: string[] = [];
  await assert.rejects(
    writeSourceHealth({
      generatedAt: '2026-07-27T20:00:00.000Z',
      observations: [{ sourceId: 'japan-mod' }],
      sources: [{
        id: 'japan-mod',
        transportStatus: 'error',
        blockedReason: 'HTTP_403',
        lastSuccessAt: null,
      }],
    }, async (key: string) => {
      writes.push(key);
      if (key === 'military:cross-strait-activity:v1:source:japan-mod') {
        throw new Error('injected blocked detail write failure');
      }
    }),
    /blocked detail write failure/,
  );

  assert.deepEqual(writes, ['military:cross-strait-activity:v1:source:japan-mod']);
});

test('a proxy CONNECT refusal remains an operator-visible source error', async () => {
  const writes = new Map<string, unknown>();
  await writeSourceHealth({
    generatedAt: '2026-07-27T20:00:00.000Z',
    observations: [{ sourceId: 'japan-mod' }],
    sources: [{
      id: 'japan-mod',
      transportStatus: 'error',
      blockedReason: 'PROXY_CONNECT_FORBIDDEN',
      lastSuccessAt: null,
    }],
  }, async (key: string, value: unknown) => {
    writes.set(key, value);
  });

  assert.deepEqual(
    writes.get('seed-meta:military:cross-strait-activity:japan-mod'),
    {
      fetchedAt: 0,
      recordCount: 1,
      sourceState: 'error',
      stale: true,
    },
  );
});

test('operator seed-health matches the fail-closed Japan blocked classification', async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = {
    UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
    UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
    WORLDMONITOR_VALID_KEYS: process.env.WORLDMONITOR_VALID_KEYS,
    RESILIENCE_PILLAR_COMBINE_ENABLED: process.env.RESILIENCE_PILLAR_COMBINE_ENABLED,
    RESILIENCE_SCHEMA_V2_ENABLED: process.env.RESILIENCE_SCHEMA_V2_ENABLED,
  };
  const operatorKey = 'cross-strait-source-health-test-key';
  const japanMetaKey = 'seed-meta:military:cross-strait-activity:japan-mod';
  const taiwanMetaKey = 'seed-meta:military:cross-strait-activity:taiwan-mnd';
  const probeKey = 'resilience:intervals:v9:US';

  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'redis-token';
  process.env.WORLDMONITOR_VALID_KEYS = operatorKey;
  process.env.RESILIENCE_PILLAR_COMBINE_ENABLED = 'false';
  process.env.RESILIENCE_SCHEMA_V2_ENABLED = 'true';

  const readEntry = async ({
    japanMeta,
    taiwanMeta,
  }: {
    japanMeta: Record<string, unknown> | null;
    taiwanMeta?: Record<string, unknown>;
  }) => {
    globalThis.fetch = async (_url, init) => {
      const commands = JSON.parse(String(init?.body));
      const results = commands.map(([operation, key]: [string, string]) => {
        if (operation === 'EXISTS') return { result: 0 };
        assert.equal(operation, 'GET');
        if (key === japanMetaKey) {
          return { result: japanMeta == null ? null : JSON.stringify(japanMeta) };
        }
        if (key === taiwanMetaKey && taiwanMeta) {
          return { result: JSON.stringify(taiwanMeta) };
        }
        if (key === probeKey) {
          return {
            result: JSON.stringify({
              p05: 65.2,
              p95: 72.8,
              _formula: 'd6',
              methodology: 'weight-perturbation-sensitivity-v3',
              computedAt: new Date().toISOString(),
            }),
          };
        }
        return {
          result: JSON.stringify({
            fetchedAt: Date.now(),
            recordCount: 10_000,
            sourceVersion: key === 'seed-meta:resilience:intervals'
              ? 'resilience-intervals:resilience:intervals:v9:weight-perturbation-sensitivity-v3'
              : 'test',
          }),
        };
      });
      return new Response(JSON.stringify(results), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const response = await seedHealthHandler(new Request(
      'https://api.worldmonitor.app/api/seed-health',
      { headers: { 'X-WorldMonitor-Key': operatorKey } },
    ));
    return {
      response,
      body: await response.json(),
    };
  };

  try {
    const fresh = await readEntry({
      japanMeta: {
        fetchedAt: Date.now(),
        recordCount: 2,
        sourceState: 'blocked',
      },
    });
    assert.equal(fresh.response.status, 200);
    assert.equal(
      fresh.body.seeds['military:cross-strait-activity:japan-mod'].status,
      'source_blocked',
    );
    assert.equal(
      fresh.body.seeds['military:cross-strait-activity:japan-mod'].stale,
      false,
    );

    const stale = await readEntry({
      japanMeta: {
        fetchedAt: Date.now() - (361 * 60_000),
        recordCount: 2,
        sourceState: 'blocked',
      },
    });
    assert.equal(stale.body.seeds['military:cross-strait-activity:japan-mod'].status, 'stale');

    const zeroCount = await readEntry({
      japanMeta: {
        fetchedAt: Date.now(),
        recordCount: 0,
        sourceState: 'blocked',
      },
    });
    assert.equal(zeroCount.body.seeds['military:cross-strait-activity:japan-mod'].status, 'error');

    const wrongDomain = await readEntry({
      japanMeta: {
        fetchedAt: Date.now(),
        recordCount: 2,
        sourceState: 'ok',
      },
      taiwanMeta: {
        fetchedAt: Date.now(),
        recordCount: 2,
        sourceState: 'blocked',
      },
    });
    assert.equal(wrongDomain.body.seeds['military:cross-strait-activity:taiwan-mnd'].status, 'error');

    const missing = await readEntry({ japanMeta: null });
    assert.equal(missing.response.status, 503);
    assert.equal(missing.body.seeds['military:cross-strait-activity:japan-mod'].status, 'missing');
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('health monitors the compact activity projection independently of the durable archive', () => {
  const { classifyKey, BOOTSTRAP_KEYS, SEED_META } = __testing__;
  const now = Date.parse('2026-07-25T12:00:00.000Z');
  const dataKey = BOOTSTRAP_KEYS.crossStraitActivityBootstrap;
  const metaKey = SEED_META.crossStraitActivityBootstrap.key;
  assert.equal(dataKey, CROSS_STRAIT_ACTIVITY_BOOTSTRAP_KEY);
  assert.equal(metaKey, CROSS_STRAIT_ACTIVITY_BOOTSTRAP_META_KEY);

  const context = (bootstrapBytes: number, meta?: object) => ({
    keyStrens: new Map([
      [BOOTSTRAP_KEYS.crossStraitActivity, 2_000_000],
      [dataKey, bootstrapBytes],
    ]),
    keyErrors: new Map(),
    keyMetaValues: new Map(meta ? [[metaKey, JSON.stringify(meta)]] : []),
    keyMetaErrors: new Map(),
    now,
  });
  assert.equal(
    classifyKey(
      'crossStraitActivityBootstrap',
      dataKey,
      { allowOnDemand: false },
      context(64_000, { fetchedAt: now - 60_000, recordCount: 3 }),
    ).status,
    'OK',
  );
  assert.equal(
    classifyKey(
      'crossStraitActivityBootstrap',
      dataKey,
      { allowOnDemand: false },
      context(0, { fetchedAt: now - 60_000, recordCount: 3 }),
    ).status,
    'EMPTY',
    'fresh canonical data must not hide a missing UI projection',
  );
  assert.equal(
    classifyKey(
      'crossStraitActivityBootstrap',
      dataKey,
      { allowOnDemand: false },
      context(0),
    ).status,
    'STALE_SEED',
    'the projection remains non-critical before its first successful publish',
  );
});

test('cross-Strait shipping budgets preserve Railway cleanup headroom', () => {
  assert.ok(
    CROSS_STRAIT_ACTIVITY_LOCK_TTL_MS > (
      CROSS_STRAIT_ACTIVITY_FETCH_PHASE_TIMEOUT_MS + CROSS_STRAIT_ACTIVITY_PUBLISH_CLEANUP_HEADROOM_MS
    ),
  );
  assert.match(read('scripts/seed-bundle-derived-signals.mjs'), /maxBundleMs:\s*570_000/);
  assert.match(
    read('scripts/seed-bundle-derived-signals.mjs'),
    new RegExp(`seedMetaKey:\\s*'${CROSS_STRAIT_ACTIVITY_COMPLETION_META_KEY.replace('seed-meta:', '')}'`),
  );
  assert.ok(CROSS_STRAIT_ACTIVITY_LOCK_TTL_MS > 310_000);
});

test('degraded cross-Strait source health publishes the error metadata before its detail record', async () => {
  const snapshot = {
    observations: [{ sourceId: 'taiwan-mnd' }],
    sources: [{
      id: 'taiwan-mnd',
      transportStatus: 'error',
      lastSuccessAt: '2026-07-24T08:00:00.000Z',
    }],
  };
  const writes: string[] = [];
  await writeSourceHealth(snapshot, async (key: string) => { writes.push(key); });

  assert.deepEqual(writes, [
    'seed-meta:military:cross-strait-activity:taiwan-mnd',
    'military:cross-strait-activity:v1:source:taiwan-mnd',
  ]);
});

test('cross-Strait publish hooks ignore runSeed metadata instead of treating it as a writer', async () => {
  const originalFetch = globalThis.fetch;
  const originalRedisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const originalRedisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  const writes: string[] = [];
  const snapshot = {
    observations: [{ sourceId: 'taiwan-mnd' }, { sourceId: 'japan-mod' }],
    sources: [
      { id: 'taiwan-mnd', transportStatus: 'fresh', lastSuccessAt: '2026-07-25T08:00:00.000Z' },
      { id: 'japan-mod', transportStatus: 'fresh', lastSuccessAt: '2026-07-25T08:00:00.000Z' },
    ],
  };
  const publishMeta = {
    canonicalKey: CROSS_STRAIT_ACTIVITY_KEY,
    ttlSeconds: CROSS_STRAIT_ACTIVITY_TTL_SECONDS,
    recordCount: snapshot.observations.length,
    runId: 'production-shape',
  };
  process.env.UPSTASH_REDIS_REST_URL = 'https://test.upstash.io';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  globalThis.fetch = async (_url, init) => {
    const command = JSON.parse(String(init?.body));
    if (command[0] === 'SET') writes.push(String(command[1]));
    return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
  };

  try {
    await Reflect.apply(crossStraitActivityBeforePublish, null, [snapshot, publishMeta]);
    await Reflect.apply(crossStraitActivityAfterPublish, null, [snapshot, publishMeta]);
    assert.deepEqual(new Set(writes), new Set([
      'military:cross-strait-activity:v1:source:taiwan-mnd',
      'seed-meta:military:cross-strait-activity:taiwan-mnd',
      'military:cross-strait-activity:v1:source:japan-mod',
      'seed-meta:military:cross-strait-activity:japan-mod',
      CROSS_STRAIT_ACTIVITY_COMPLETION_META_KEY,
    ]));
  } finally {
    globalThis.fetch = originalFetch;
    if (originalRedisUrl == null) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = originalRedisUrl;
    if (originalRedisToken == null) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = originalRedisToken;
  }
});

test('cross-Strait source-health failure settles every write before canonical publication', async () => {
  const originalFetch = globalThis.fetch;
  const originalRedisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const originalRedisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  let releaseTaiwanWrite = () => {};
  let settled = false;
  let canonicalFetches = 0;
  const writes: string[] = [];
  const snapshot = {
    observations: [{ sourceId: 'taiwan-mnd' }, { sourceId: 'japan-mod' }],
    sources: [
      { id: 'taiwan-mnd', transportStatus: 'fresh', lastSuccessAt: '2026-07-25T08:00:00.000Z' },
      { id: 'japan-mod', transportStatus: 'fresh', lastSuccessAt: '2026-07-25T08:00:00.000Z' },
    ],
  };
  process.env.UPSTASH_REDIS_REST_URL = 'https://test.upstash.io';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  globalThis.fetch = async () => {
    canonicalFetches += 1;
    return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
  };

  try {
    const outcome = atomicPublish(
      CROSS_STRAIT_ACTIVITY_KEY,
      snapshot,
      () => true,
      CROSS_STRAIT_ACTIVITY_TTL_SECONDS,
      {
        beforePublish: () => writeSourceHealth(snapshot, async (key: string) => {
          writes.push(key);
          if (key === 'military:cross-strait-activity:v1:source:taiwan-mnd') {
            await new Promise<void>((resolveWrite) => { releaseTaiwanWrite = resolveWrite; });
          }
          if (key === 'seed-meta:military:cross-strait-activity:japan-mod') {
            throw new Error('injected source-health failure');
          }
        }),
      },
    ).then(
      () => ({ error: null }),
      (error: Error) => ({ error }),
    ).finally(() => { settled = true; });

    await new Promise<void>((resolveTick) => setImmediate(resolveTick));
    const settledBeforeRelease = settled;
    releaseTaiwanWrite();
    const result = await outcome;

    assert.equal(settledBeforeRelease, false);
    assert.match(result.error?.message ?? '', /injected source-health failure/);
    assert.ok(writes.includes('seed-meta:military:cross-strait-activity:taiwan-mnd'));
    assert.equal(canonicalFetches, 0, 'canonical staging must not start after source-health failure');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalRedisUrl == null) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = originalRedisUrl;
    if (originalRedisToken == null) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = originalRedisToken;
  }
});

test('runSeed forwards cross-Strait source health through the pre-publication boundary', async () => {
  const originalFetch = globalThis.fetch;
  const originalRedisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const originalRedisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  const originalSigtermListeners = new Set(process.rawListeners('SIGTERM'));
  const redisCommands: unknown[][] = [];
  const snapshot = {
    observations: [{ sourceId: 'taiwan-mnd' }],
    sources: [{
      id: 'taiwan-mnd',
      transportStatus: 'fresh',
      lastSuccessAt: '2026-07-25T08:00:00.000Z',
    }],
  };
  process.env.UPSTASH_REDIS_REST_URL = 'https://test.upstash.io';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  globalThis.fetch = async (_url, init) => {
    const command = JSON.parse(String(init?.body));
    redisCommands.push(command);
    return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
  };

  try {
    await assert.rejects(
      runSeed(
        'military',
        'cross-strait-activity',
        CROSS_STRAIT_ACTIVITY_KEY,
        async () => snapshot,
        {
          validateFn: () => true,
          ttlSeconds: CROSS_STRAIT_ACTIVITY_TTL_SECONDS,
          declareRecords: data => data.observations.length,
          sourceVersion: 'test-v1',
          schemaVersion: 1,
          maxStaleMin: 120,
          beforePublish: data => writeSourceHealth(data, async () => {
            throw new Error('injected source-health failure');
          }),
        },
      ),
      /injected source-health failure/,
    );
    assert.equal(
      redisCommands.some(command =>
        command[0] === 'SET'
        && (
          command[1] === CROSS_STRAIT_ACTIVITY_KEY
          || String(command[1]).startsWith(`${CROSS_STRAIT_ACTIVITY_KEY}:staging:`)
        )),
      false,
      'runSeed must not stage or publish canonical data after the source-health barrier fails',
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalRedisUrl == null) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = originalRedisUrl;
    if (originalRedisToken == null) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = originalRedisToken;
    for (const listener of process.rawListeners('SIGTERM')) {
      if (!originalSigtermListeners.has(listener)) process.removeListener('SIGTERM', listener);
    }
  }
});

test('runSeed withholds cross-Strait completion when primary freshness metadata fails', async () => {
  const originalFetch = globalThis.fetch;
  const originalRedisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const originalRedisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  const originalSigtermListeners = new Set(process.rawListeners('SIGTERM'));
  const writtenKeys: string[] = [];
  const snapshot = {
    observations: [{ sourceId: 'taiwan-mnd' }],
    sources: [{
      id: 'taiwan-mnd',
      transportStatus: 'fresh',
      lastSuccessAt: '2026-07-25T08:00:00.000Z',
    }],
  };
  process.env.UPSTASH_REDIS_REST_URL = 'https://test.upstash.io';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  globalThis.fetch = async (_url, init) => {
    const command = JSON.parse(String(init?.body));
    const key = String(command[1] ?? '');
    if (command[0] === 'SET') writtenKeys.push(key);
    if (key === 'seed-meta:military:cross-strait-activity') {
      return new Response('injected primary freshness failure', { status: 503 });
    }
    return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
  };

  try {
    await assert.rejects(
      runSeed(
        'military',
        'cross-strait-activity',
        CROSS_STRAIT_ACTIVITY_KEY,
        async () => snapshot,
        {
          validateFn: () => true,
          ttlSeconds: CROSS_STRAIT_ACTIVITY_TTL_SECONDS,
          declareRecords: data => data.observations.length,
          sourceVersion: 'test-v1',
          schemaVersion: 1,
          maxStaleMin: 120,
          beforePublish: crossStraitActivityBeforePublish,
          afterFreshness: crossStraitActivityAfterPublish,
        },
      ),
      /freshness metadata write failed before completion/,
    );
    assert.equal(
      writtenKeys.includes(CROSS_STRAIT_ACTIVITY_COMPLETION_META_KEY),
      false,
      'the bundle completion marker must remain absent so the next bundle run retries',
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalRedisUrl == null) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = originalRedisUrl;
    if (originalRedisToken == null) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = originalRedisToken;
    for (const listener of process.rawListeners('SIGTERM')) {
      if (!originalSigtermListeners.has(listener)) process.removeListener('SIGTERM', listener);
    }
  }
});

test('cross-Strait source health runs before canonical publication and completion stays last', () => {
  const source = read('scripts/seed-cross-strait-activity.mjs');
  assert.match(source, /beforePublish:\s*crossStraitActivityBeforePublish/);
  assert.match(source, /afterFreshness:\s*crossStraitActivityAfterPublish/);
  assert.notEqual(
    CROSS_STRAIT_ACTIVITY_BOOTSTRAP_META_KEY,
    CROSS_STRAIT_ACTIVITY_COMPLETION_META_KEY,
    'bundle freshness must not fall back to a projection write',
  );
});

// #5614: the seeder crashed on every bundle tick because runSeed passes its
// meta object where writePublicationCompletion expects an injectable writer.
// Existing coverage always supplied a writer explicitly, so the production
// call shape was never exercised. Pin it here.
test('completion hook survives runSeed passing its meta object in slot 2', async () => {
  const writes: string[] = [];
  const writer = async (key: string) => {
    writes.push(key);
  };
  await crossStraitActivityAfterPublish(
    {
      observations: [{ sourceId: 'taiwan-mnd' }],
      sources: [{
        id: 'taiwan-mnd',
        transportStatus: 'fresh',
        lastSuccessAt: '2026-07-25T08:00:00.000Z',
      }],
    },
    // The exact shape runSeed hands the hook (scripts/_seed-utils.mjs).
    {
      canonicalKey: 'military:cross-strait-activity:v1',
      ttlSeconds: 15_552_000,
      recordCount: 1,
      runId: 'run-5614',
    },
    writer,
  );
  assert.deepEqual(writes, [CROSS_STRAIT_ACTIVITY_COMPLETION_META_KEY]);
});

test('runSeed wires the meta-tolerant hook, not the writer-injected helper', () => {
  const source = read('scripts/seed-cross-strait-activity.mjs');
  assert.match(source, /afterFreshness:\s*crossStraitActivityAfterPublish,/);
  assert.doesNotMatch(
    source,
    /afterFreshness:\s*writePublicationCompletion,/,
    'wiring the writer-injected helper straight into the hook puts runSeed meta in the writer slot (#5614)',
  );
});

test('cross-Strait completion marker is the final cohort write', async () => {
  const writes: string[] = [];
  await writePublicationCompletion({
    observations: [{ sourceId: 'taiwan-mnd' }],
  }, async (key: string) => {
    writes.push(key);
  }, Date.parse('2026-07-25T09:00:00.000Z'));
  assert.deepEqual(writes, [CROSS_STRAIT_ACTIVITY_COMPLETION_META_KEY]);
});
