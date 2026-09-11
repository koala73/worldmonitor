import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createConflictServiceRoutes } from '../src/generated/server/worldmonitor/conflict/v1/service_server.ts';
import { conflictHandler } from '../server/worldmonitor/conflict/v1/handler.ts';
import { ACLED_DEFAULT_WINDOW_MS } from '../server/worldmonitor/conflict/v1/list-acled-events.ts';
import { drainResponseHeaders } from '../server/_shared/response-headers.ts';
import { __resetKeyPrefixCacheForTests } from '../server/_shared/redis.ts';
import { installRedis } from './helpers/fake-upstash-redis.mts';
import { mapGdeltExportToConflictEvents } from '../scripts/_conflict-gdelt-bulk.mjs';

const seedKey = 'conflict:acled:v1:all:0:0';
const route = createConflictServiceRoutes(conflictHandler).find(route => route.path.endsWith('/list-acled-events'))!;
const originalFetch = globalThis.fetch;
const originalNow = Date.now;
const originalEnv = { ...process.env };
const snapshot = { events: [{ id: 'acled-synthetic-1', eventType: 'Battles', country: 'Ukraine', location: { latitude: 48, longitude: 31 }, occurredAt: 1789000000000, fatalities: 0, actors: ['Synthetic actor'], source: 'Synthetic source', admin1: '' }] };
let now: number;
let keys: string[];
let upstreamCalls: string[];
let responseHeaders: Record<string, string> | undefined;
beforeEach(() => {
  now = Date.UTC(2026, 8, 11, 12);
  Date.now = () => now;
  for (const key of ['LOCAL_API_MODE', 'VERCEL_ENV', 'VERCEL_GIT_COMMIT_SHA', 'ACLED_EMAIL', 'ACLED_PASSWORD', 'ACLED_ACCESS_TOKEN']) delete process.env[key];
  __resetKeyPrefixCacheForTests();
  keys = [];
  upstreamCalls = [];
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  Date.now = originalNow;
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  __resetKeyPrefixCacheForTests();
});
function install(fixtures: Record<string, unknown>, failSeed = false) {
  const redis = installRedis(fixtures);
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname !== 'redis.example') {
      upstreamCalls.push(url.hostname);
      return Response.json({ data: [] });
    }
    if (url.pathname.startsWith('/get/')) {
      const key = decodeURIComponent(url.pathname.slice(5));
      keys.push(key);
      if (failSeed && key === seedKey) return Response.json({ error: 'synthetic read failure' }, { status: 503 });
    }
    return redis.fetchImpl(input, init);
  }) as typeof fetch;
  return redis;
}
async function request(query = '') {
  const req = new Request(`https://api.worldmonitor.app/api/conflict/v1/list-acled-events${query}`);
  const response = await route.handler(req);
  responseHeaders = drainResponseHeaders(req);
  assert.equal(response.status, 200);
  return response.json();
}

test('raw default and supported explicit-zero requests read the producer seed across time and preview prefixes', async () => {
  const producer = await readFile(new URL('../scripts/seed-conflict-intel.mjs', import.meta.url), 'utf8');
  assert.match(producer, /const ACLED_CACHE_KEY = 'conflict:acled:v1:all:0:0'/);
  assert.match(producer, /runSeed\('conflict', 'acled-intel', ACLED_CACHE_KEY, fetchAll/);
  const redis = install({ [seedKey]: { _seed: { fetchedAt: now, recordCount: 1, sourceVersion: 'acled-hapi-pizzint', schemaVersion: 1, state: 'OK' }, data: snapshot } });
  assert.deepEqual(await request(), snapshot);
  now += 123456;
  process.env.VERCEL_ENV = 'preview';
  process.env.VERCEL_GIT_COMMIT_SHA = '12345678abcdef';
  __resetKeyPrefixCacheForTests();
  assert.deepEqual(await request('?country=&start=0&end=0&page_size=0&cursor='), snapshot);
  assert.deepEqual(keys, [seedKey, seedKey]);
  assert.deepEqual([...redis.redis.keys()], [seedKey], 'reader must not create or replace seed/cache entries on a hit');
  assert.deepEqual(JSON.parse(redis.redis.get(seedKey)!).data, snapshot);
});

test('an empty seed is authoritative and does not trigger live fallback', async () => {
  install({ [seedKey]: { events: [] } });
  assert.deepEqual(await request(), { events: [] });
  assert.deepEqual(keys, [seedKey]);
});

test('real GDELT fallback rows without coordinates do not become geographic RPC events', async () => {
  const fields = Array<string>(61).fill('');
  Object.assign(fields, { 0: 'synthetic-44', 25: '1', 26: '180', 28: '18', 29: '4', 53: 'UP', 59: '20260911120000', 60: 'https://example.com/report' });
  const fallback = mapGdeltExportToConflictEvents(fields.join('\t'));
  assert.equal(fallback.length, 1);
  assert.equal(fallback[0].location, undefined);
  const redis = install({ [seedKey]: { events: [...snapshot.events, ...fallback] } });
  assert.deepEqual(await request(), snapshot);
  redis.redis.set(seedKey, JSON.stringify({ events: fallback }));
  assert.deepEqual(await request(), { events: [] });
  assert.deepEqual(keys, [seedKey, seedKey]);
});

test('country and inclusive date filters read the same seed without writes or provider calls', async () => {
  const event = snapshot.events[0]!;
  const other = { ...event, id: 'acled-other', country: 'Sudan' };
  const redis = install({ [seedKey]: { events: [event, other] } });
  const cases = [
    ['?country=UA', [event]],
    ['?country=Ukraine', [event]],
    ['?country=ua', [event]],
    ['?country=SD', [other]],
    ['?country=unknown', []],
    [`?start=${event.occurredAt}&end=${event.occurredAt}`, [event, other]],
    [`?start=${event.occurredAt + 1}`, []],
    [`?end=${event.occurredAt - 1}`, []],
    ['?start=1000&end=2000', []],
    [`?start=${now}&end=${now - 1}`, []],
    ['?page_size=1&cursor=ignored', [event, other]],
  ] as const;
  for (const [query, events] of cases) assert.deepEqual(await request(query), { events }, query);
  for (let i = 0; i < 20; i++) {
    assert.deepEqual(await request(`?country=unknown-${i}&start=${now + i}`), { events: [] });
  }
  assert.deepEqual(keys, Array(cases.length + 20).fill(seedKey));
  assert.deepEqual([...redis.redis.keys()], [seedKey]);
  assert.deepEqual(upstreamCalls, []);
});

test('seed misses and failures never read per-query caches or call ACLED and can recover', async () => {
  process.env.ACLED_ACCESS_TOKEN = 'synthetic-token';
  const key = `conflict:acled:v1:all:${now - ACLED_DEFAULT_WINDOW_MS}:${now}`;
  for (const failSeed of [false, true]) {
    keys = [];
    install({ [key]: snapshot }, failSeed);
    assert.deepEqual(await request(), { events: [] });
    assert.deepEqual(await request('?country=UA'), { events: [] });
    assert.deepEqual(keys, [seedKey, seedKey]);
    assert.equal(responseHeaders?.['X-No-Cache'], '1');
    assert.deepEqual(upstreamCalls, []);
  }
  install({ [seedKey]: snapshot });
  assert.deepEqual(await request(), snapshot);
  assert.equal(responseHeaders?.['X-No-Cache'], undefined);
});

test('varying cold queries cannot reach ACLED even when provider credentials are configured', async () => {
  process.env.ACLED_ACCESS_TOKEN = 'synthetic-token';
  const redis = install({});
  for (const query of ['', '?country=Ukraine', '?start=1000&end=2000']) {
    assert.deepEqual(await request(query), { events: [] });
  }
  assert.deepEqual(upstreamCalls, [], 'request handling must never contact ACLED');
  assert.deepEqual(keys, [seedKey, seedKey, seedKey]);
  assert.equal(redis.redis.size, 0);
});
