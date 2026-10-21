import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { __testing__ } from '../api/health.js';
import { ANALYSIS_TOOLS } from '../api/mcp/registry/analysis-tools.ts';
import { CACHE_TOOLS } from '../api/mcp/registry/cache-tools.ts';
import { evaluateFreshness } from '../api/mcp/freshness.ts';
import { getOceanIceData } from '../server/worldmonitor/climate/v1/get-ocean-ice-data';
import * as oceanIce from '../scripts/seed-climate-ocean-ice.mjs';
import * as submarineCables from '../scripts/seed-submarine-cables.mjs';
import { createRedisFetch, type FakeRedisState } from './helpers/fake-upstash-redis.mts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const START = Date.parse('2026-09-01T00:00:00.000Z');

type SeedName = 'ocean' | 'cables';
type FailureMode = 'all' | 'partial' | 'none';
type ProducerResult = {
  exitCode: number;
  redis: Record<string, unknown>;
  expires: Record<string, number>;
  output: string;
};

type CacheCase = {
  name: SeedName;
  healthName: 'oceanIce' | 'submarineCables';
  dataKey: string;
  observedAgeMs: number;
  failedRefreshAtMs: number;
};

const CASES: CacheCase[] = [
  {
    name: 'ocean',
    healthName: 'oceanIce',
    dataKey: oceanIce.CLIMATE_OCEAN_ICE_KEY,
    observedAgeMs: 25 * 60 * MINUTE_MS,
    failedRefreshAtMs: 20 * 60 * MINUTE_MS,
  },
  {
    name: 'cables',
    healthName: 'submarineCables',
    dataKey: submarineCables.CANONICAL_KEY,
    observedAgeMs: 8 * DAY_MS,
    failedRefreshAtMs: 6 * DAY_MS,
  },
];

function sourceMock(name: SeedName) {
  if (name === 'cables') {
    return `
      const realSetTimeout = globalThis.setTimeout;
      globalThis.setTimeout = (callback, ms, ...args) => {
        if (ms === 150) { queueMicrotask(() => callback(...args)); return 0; }
        return realSetTimeout(callback, ms, ...args);
      };
      globalThis.fetch = async (url, init) => {
        const href = String(url);
        if (href.startsWith('https://redis.example')) return fake.fetchImpl(url, init);
        if (failureMode === 'all') return new Response('', { status: 503 });
        if (href.endsWith('/cable/cable-geo.json')) return Response.json({ features: [] });
        if (href.endsWith('/landing-point/landing-point-geo.json')) return Response.json({ features: [] });
        if (href.includes('/cable/')) {
          const id = href.split('/').pop().replace('.json', '');
          return Response.json({ name: id, landing_points: [], owners: [], rfs_year: null });
        }
        throw new Error('Unexpected cable URL: ' + href);
      };
    `;
  }
  return `
    globalThis.fetch = async (url, init) => {
      const href = String(url);
      if (href.startsWith('https://redis.example')) return fake.fetchImpl(url, init);
      if (failureMode === 'all') return new Response('', { status: 503 });
      if (failureMode === 'partial' && !href.includes('N_seaice_extent_daily_v4.0.csv') && !href.includes('N_seaice_extent_climatology')) return new Response('', { status: 503 });
      if (href.includes('N_seaice_extent_daily_v4.0.csv')) return new Response('2026,9,7,' + (failureMode === 'partial' ? '4.7' : '4.5') + ',4.0\\n');
      if (href.includes('N_seaice_extent_climatology')) return new Response('250,0,0,0,0,5.0\\n');
      if (href.includes('overlay-global-mean-sea-level')) return new Response('RISE SINCE 1993 106.3 millimeters. Current yearly rate of 0.15 inches/year (0.38 centimeters/year).');
      if (href.includes('h22-w0-700m.dat')) return new Response('YEAR WORLD\\n2025.5 12.3\\n');
      if (href.endsWith('/timeseries/')) return new Response('<a href="aravg.mon.ocean.90S.90N.v6.0.0.202609.asc">latest</a>');
      if (href.includes('v5.1.0.202312.asc')) return new Response('2000 9 0.10\\n');
      if (href.includes('v6.0.0.202609.asc')) return new Response('2026 9 0.40\\n');
      throw new Error('Unexpected ocean URL: ' + href);
    };
  `;
}

function runProducer(
  name: SeedName,
  now: number,
  fixtures: Record<string, unknown> = {},
  failureMode: FailureMode = 'none',
  initialExpiresAt: Record<string, number> = {},
): ProducerResult {
  const modulePath = name === 'ocean'
    ? './scripts/seed-climate-ocean-ice.mjs'
    : './scripts/seed-submarine-cables.mjs';
  const invocation = name === 'ocean'
    ? `await runSeed('climate', 'ocean-ice', producer.CLIMATE_OCEAN_ICE_KEY, producer.fetchOceanIceData, producer.OCEAN_ICE_SEED_OPTIONS);`
    : `await runSeed('infrastructure', 'submarine-cables', producer.CANONICAL_KEY, producer.fetchSubmarineCables, producer.SUBMARINE_CABLES_SEED_OPTIONS);`;
  const code = `
    import { installRedis } from './tests/helpers/fake-upstash-redis.mts';
    import { runSeed } from './scripts/_seed-utils.mjs';
    const realDate = Date;
    globalThis.Date = class extends realDate {
      constructor(...args) { super(...(args.length ? args : [${now}])); }
      static now() { return ${now}; }
    };
    const fake = installRedis(${JSON.stringify(fixtures)}, { now: () => ${now}, initialExpiresAt: ${JSON.stringify(initialExpiresAt)} });
    const failureMode = ${JSON.stringify(failureMode)};
    ${sourceMock(name)}
    const halt = Symbol('halt');
    let exitCode = null;
    const realExit = process.exit;
    process.exit = (code = 0) => { exitCode = code; throw halt; };
    try {
      const producer = await import(${JSON.stringify(modulePath)});
      ${invocation}
    } catch (error) {
      if (error !== halt) throw error;
    } finally {
      process.exit = realExit;
    }
    console.log('RESULT ' + JSON.stringify({
      exitCode,
      redis: Object.fromEntries([...fake.redis]
        .filter(([key]) => !key.includes(':staging:'))
        .map(([key, value]) => [key, JSON.parse(value)])),
      expires: Object.fromEntries(fake.expires),
    }));
  `;
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', code], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 20_000,
    env: { PATH: process.env.PATH, NODE_TEST_CONTEXT: 'child-v8', WM_SEED_RETRY_DELAY_MS: '0' },
  });
  assert.ifError(child.error);
  const output = child.stdout + child.stderr;
  const line = child.stdout.split('\n').find((candidate) => candidate.startsWith('RESULT '));
  assert.ok(line, output);
  return { ...JSON.parse(line.slice(7)), output };
}

function makeCache(clock: { now: number }) {
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
  return createRedisFetch({}, { now: () => clock.now });
}

async function writeCache(
  state: FakeRedisState,
  key: string,
  value: unknown,
  ttlSeconds: number,
) {
  const response = await state.fetchImpl('https://redis.example/', {
    method: 'POST',
    body: JSON.stringify(['SET', key, JSON.stringify(value), 'EX', ttlSeconds]),
  });
  assert.equal(response.status, 200);
}

async function writePublishedCache(state: FakeRedisState, result: ProducerResult, entry: CacheCase) {
  const metaKey = __testing__.SEED_META[entry.healthName].key;
  for (const key of [entry.dataKey, metaKey]) {
    assert.ok(result.redis[key] != null, `${entry.name} producer did not write ${key}`);
    assert.ok(result.expires[key] != null, `${entry.name} producer did not set TTL for ${key}`);
    await writeCache(state, key, result.redis[key], result.expires[key]!);
  }
}

async function applyPreservedTtls(state: FakeRedisState, result: ProducerResult, entry: CacheCase) {
  const metaKey = __testing__.SEED_META[entry.healthName].key;
  for (const key of [entry.dataKey, metaKey]) {
    const response = await state.fetchImpl('https://redis.example/', {
      method: 'POST',
      body: JSON.stringify(['EXPIRE', key, result.expires[key]]),
    });
    const body = await response.json() as { result: number };
    assert.equal(body.result, 1, `${entry.name} failed refresh must extend ${key}`);
  }
}

async function rawValue(state: FakeRedisState, key: string) {
  const response = await state.fetchImpl(`https://redis.example/get/${encodeURIComponent(key)}`);
  const body = await response.json() as { result: string | null };
  return body.result;
}

function health(entry: CacheCase, state: FakeRedisState, now: number) {
  const metaKey = __testing__.SEED_META[entry.healthName].key;
  return Promise.all([rawValue(state, entry.dataKey), rawValue(state, metaKey)]).then(([data, meta]) => (
    __testing__.classifyKey(entry.healthName, entry.dataKey, {}, {
      keyStrens: new Map(data == null ? [] : [[entry.dataKey, Buffer.byteLength(data)]]),
      keyErrors: new Map(),
      keyMetaValues: new Map(meta == null ? [] : [[metaKey, meta]]),
      keyMetaErrors: new Map(),
      now,
    })
  ));
}

async function consumerStatus(entry: CacheCase, state: FakeRedisState, now: number) {
  const realFetch = globalThis.fetch;
  const realNow = Date.now;
  globalThis.fetch = state.fetchImpl;
  Date.now = () => now;
  try {
    if (entry.name === 'ocean') {
      const response = await getOceanIceData({ request: new Request('https://test.invalid') } as never, {});
      return { hasData: response.data?.arcticExtentMkm2 != null };
    }
    const tool = ANALYSIS_TOOLS.find((candidate) => candidate.name === 'simulate_infrastructure_cascade');
    assert.ok(tool && tool._execute, 'cascade tool must exist');
    const response = await tool._execute({}, '', {}, {}) as {
      stale: boolean;
      unavailable_inputs: string[];
    };
    return {
      hasData: !response.unavailable_inputs.includes(entry.dataKey),
      stale: response.stale,
    };
  } finally {
    globalThis.fetch = realFetch;
    Date.now = realNow;
  }
}

async function consumerHasData(entry: CacheCase, state: FakeRedisState, now: number) {
  return (await consumerStatus(entry, state, now)).hasData;
}

function climateToolIsStale(now: number, oceanAgeMs: number) {
  const tool = CACHE_TOOLS.find((candidate) => candidate.name === 'get_climate_data') as {
    _freshnessChecks: Array<{ key: string; maxStaleMin: number }>;
  } | undefined;
  assert.ok(tool, 'get_climate_data must exist');
  return evaluateFreshness(
    tool._freshnessChecks,
    tool._freshnessChecks.map((check) => ({
      fetchedAt: now - (check.key === 'seed-meta:climate:ocean-ice' ? oceanAgeMs : 0),
    })),
    now,
  ).stale;
}

test('ocean ice and submarine reference publications outlive their stale windows', async () => {
  for (const entry of CASES) {
    const first = runProducer(entry.name, START);
    const { key: metaKey, maxStaleMin: healthLimitMin } = __testing__.SEED_META[entry.healthName];
    const expectedTtlSeconds = entry.name === 'ocean' ? oceanIce.CACHE_TTL : submarineCables.CACHE_TTL;
    assert.equal(first.exitCode, 0, first.output);
    assert.equal(first.expires[entry.dataKey], expectedTtlSeconds);
    assert.ok(
      first.expires[metaKey] > healthLimitMin * 60,
      `${entry.name} metadata must outlive the health stale window`,
    );

    const clock = { now: START };
    const cache = makeCache(clock);
    await writePublishedCache(cache, first, entry);

    clock.now = START + entry.observedAgeMs;
    const observed = await consumerStatus(entry, cache, clock.now);
    assert.equal(observed.hasData, true, `${entry.name} must remain readable at its observed missed-run age`);
    assert.equal((await health(entry, cache, clock.now)).status, 'OK');

    if (entry.name === 'ocean') {
      const climateTool = CACHE_TOOLS.find((candidate) => candidate.name === 'get_climate_data') as {
        _freshnessChecks: Array<{ key: string; maxStaleMin: number }>;
      } | undefined;
      assert.ok(climateTool, 'get_climate_data must exist');
      assert.equal(
        climateTool._freshnessChecks.find((check) => check.key === metaKey)?.maxStaleMin,
        healthLimitMin,
      );
      assert.equal(climateToolIsStale(clock.now, entry.observedAgeMs), false);
      assert.equal(climateToolIsStale(clock.now, healthLimitMin * MINUTE_MS), false);
      assert.equal(climateToolIsStale(clock.now, (healthLimitMin + 1) * MINUTE_MS), true);
    }

    const staleAt = START + healthLimitMin * MINUTE_MS;
    for (const [offset, expected] of [[-MINUTE_MS, 'OK'], [0, 'OK'], [MINUTE_MS, 'STALE_SEED']] as const) {
      clock.now = staleAt + offset;
      const status = await consumerStatus(entry, cache, clock.now);
      assert.equal(status.hasData, true, `${entry.name} must remain readable at stale-window offset ${offset}`);
      assert.equal((await health(entry, cache, clock.now)).status, expected);
      if (entry.name === 'cables') {
        assert.equal(status.stale, expected === 'STALE_SEED');
      }
    }

    clock.now = START + expectedTtlSeconds * 1000 + MINUTE_MS;
    assert.equal(await consumerHasData(entry, cache, clock.now), false, `${entry.name} must become unavailable only after its retention cutoff`);
    assert.equal((await health(entry, cache, clock.now)).status, 'EMPTY');

    const malformedClock = { now: START };
    const malformedCache = makeCache(malformedClock);
    await writeCache(malformedCache, metaKey, first.redis[metaKey], first.expires[metaKey]!);
    malformedCache.redis.set(entry.dataKey, '{not-json');
    assert.equal(await consumerHasData(entry, malformedCache, malformedClock.now), false, `${entry.name} consumer must reject a malformed cache value`);

    if (entry.name === 'ocean') {
      const partial = runProducer(entry.name, START + MINUTE_MS, first.redis, 'partial');
      assert.equal(partial.exitCode, 0, partial.output);
      assert.match(partial.output, /Merging failed source groups with prior cache/);
      const partialData = (partial.redis[entry.dataKey] as { data: Record<string, unknown> }).data;
      const firstData = (first.redis[entry.dataKey] as { data: Record<string, unknown> }).data;
      assert.equal(partialData.arctic_extent_mkm2, 4.7);
      assert.equal(partialData.sea_level_mm_above_1993, firstData.sea_level_mm_above_1993);
    }

    const retryClock = { now: START };
    const retryCache = makeCache(retryClock);
    await writePublishedCache(retryCache, first, entry);
    retryClock.now = START + entry.failedRefreshAtMs;
    const initialExpiresAt = Object.fromEntries(
      Object.entries(first.expires).map(([key, ttlSeconds]) => [key, START + ttlSeconds * 1000]),
    );
    const failed = runProducer(entry.name, retryClock.now, first.redis, 'all', initialExpiresAt);
    assert.equal(failed.exitCode, 75, failed.output);
    assert.deepEqual(failed.redis[entry.dataKey], first.redis[entry.dataKey]);
    assert.deepEqual(failed.redis[metaKey], first.redis[metaKey]);
    assert.equal(failed.expires[entry.dataKey], expectedTtlSeconds);
    assert.equal(failed.expires[metaKey], expectedTtlSeconds);
    await applyPreservedTtls(retryCache, failed, entry);

    retryClock.now = staleAt + MINUTE_MS;
    assert.equal(await consumerHasData(entry, retryCache, retryClock.now), true, `${entry.name} failed refresh must preserve last-good through STALE_SEED`);
    assert.equal((await health(entry, retryCache, retryClock.now)).status, 'STALE_SEED');

    retryClock.now = START + expectedTtlSeconds * 1000 + MINUTE_MS;
    assert.equal(await consumerHasData(entry, retryCache, retryClock.now), true, `${entry.name} failed refresh must extend data beyond the original expiry`);
    assert.equal((await health(entry, retryCache, retryClock.now)).status, 'STALE_SEED');

    retryClock.now = START + entry.failedRefreshAtMs + expectedTtlSeconds * 1000 + MINUTE_MS;
    assert.equal(await consumerHasData(entry, retryCache, retryClock.now), false, `${entry.name} data must expire after the failed-refresh retention`);
    assert.equal((await health(entry, retryCache, retryClock.now)).status, 'EMPTY');

    const recovered = runProducer(entry.name, retryClock.now, failed.redis);
    assert.equal(recovered.exitCode, 0, recovered.output);
    await writePublishedCache(retryCache, recovered, entry);
    assert.equal(await consumerHasData(entry, retryCache, retryClock.now), true);
    assert.equal((await health(entry, retryCache, retryClock.now)).status, 'OK');
  }
});
