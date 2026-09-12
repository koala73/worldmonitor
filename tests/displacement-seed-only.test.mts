import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createDisplacementServiceRoutes, ValidationError } from '../src/generated/server/worldmonitor/displacement/v1/service_server.ts';
import { displacementHandler } from '../server/worldmonitor/displacement/v1/handler.ts';
import { getDisplacementSummary } from '../server/worldmonitor/displacement/v1/get-displacement-summary.ts';
import { __resetKeyPrefixCacheForTests } from '../server/_shared/redis.ts';
import { installRedis } from './helpers/fake-upstash-redis.mts';
import { createDomainGateway, serverOptions } from '../server/gateway.ts';
import { issueSessionToken } from '../api/_session.js';

const route = createDisplacementServiceRoutes(displacementHandler, serverOptions).find(r => r.path.endsWith('/get-displacement-summary'))!;
const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
const year = new Date().getFullYear();
const seedKey = `displacement:summary:v1:${year}`;
const metaKey = 'seed-meta:displacement:summary';
const fetchedAt = Date.now() - 60_000;
const country = { code: 'SYR', name: 'Syria', refugees: 12, asylumSeekers: 3, idps: 4, stateless: 0, totalDisplaced: 19, hostRefugees: 0, hostAsylumSeekers: 0, hostTotal: 0 };
const flow = { originCode: 'SYR', originName: 'Syria', asylumCode: 'TUR', asylumName: 'Turkiye', refugees: 12 };
const snapshot = { summary: { year: year - 1, globalTotals: { refugees: 12, asylumSeekers: 3, idps: 4, stateless: 0, total: 19 }, countries: [country, { ...country, code: 'UKR' }], topFlows: [flow, { ...flow, asylumCode: 'DEU' }] } };
let keys: string[];
let upstream: string[];
beforeEach(() => {
  for (const k of ['LOCAL_API_MODE', 'VERCEL_ENV', 'VERCEL_GIT_COMMIT_SHA', 'SEED_FALLBACK_DISPLACEMENT']) delete process.env[k];
  __resetKeyPrefixCacheForTests();
  keys = [];
  upstream = [];
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const k of Object.keys(process.env)) if (!(k in originalEnv)) delete process.env[k];
  Object.assign(process.env, originalEnv);
  __resetKeyPrefixCacheForTests();
});
function install(fixtures: Record<string, unknown>, fail = false, failedKeys: string[] = []) {
  const redis = installRedis(fixtures);
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname !== 'redis.example') {
      upstream.push(url.hostname);
      return Response.json({ items: [] });
    }
    const key = url.pathname.startsWith('/get/') ? decodeURIComponent(url.pathname.slice(5)) : null;
    if (key) keys.push(key);
    if (fail || (key !== null && failedKeys.includes(key))) {
      return Response.json({ error: 'synthetic unavailable' }, { status: 503 });
    }
    return redis.fetchImpl(input, init);
  }) as typeof fetch;
  return redis;
}
async function request(query = '') {
  return route.handler(new Request(`https://worldmonitor.app/api/displacement/v1/get-displacement-summary${query}`));
}

test('default and matching actual year reuse raw current-year seed and preserve limits', async () => {
  const producer = await readFile(new URL('../scripts/seed-displacement-summary.mjs', import.meta.url), 'utf8');
  assert.match(producer, /canonicalKey = `\$\{CANONICAL_KEY_PREFIX\}:\$\{currentYear\}`/);
  const redis = install({ [seedKey]: { _seed: { fetchedAt, recordCount: 2, schemaVersion: 1 }, data: snapshot }, [metaKey]: { fetchedAt } });
  assert.deepEqual(await (await request()).json(), { ...snapshot, fetchedAt, dataAvailable: true });
  process.env.VERCEL_ENV = 'preview';
  process.env.VERCEL_GIT_COMMIT_SHA = 'synthetic-preview-sha';
  __resetKeyPrefixCacheForTests();
  const result = await (await request(`?year=${year - 1}&country_limit=1&flow_limit=1`)).json();
  assert.deepEqual(result, { summary: { ...snapshot.summary, countries: [country], topFlows: [flow] }, fetchedAt, dataAvailable: true });
  assert.ok(keys.every(k => k === seedKey || k === metaKey));
  assert.deepEqual([...redis.redis.keys()].sort(), [seedKey, metaKey].sort());
  assert.deepEqual(JSON.parse(redis.redis.get(seedKey)!).data, snapshot);
  assert.deepEqual(upstream, []);
});

test('nonmatching explicit years return unavailable without reading caller-selected data keys', async () => {
  install({ [seedKey]: snapshot, [metaKey]: { fetchedAt } });
  for (const value of [1951, year - 2, year]) {
    const response = await request(`?year=${value}`);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.dataAvailable, false);
    assert.equal(result.fetchedAt, 0);
    assert.equal(result.summary.year, value);
    assert.deepEqual(result.summary.countries, []);
  }
  assert.ok(keys.every(k => k === seedKey || k === metaKey));
  assert.deepEqual(upstream, []);
});

test('invalid year values fail before storage or provider I/O, including direct callers', async () => {
  install({});
  for (const value of [-1, 1, 1950, year + 1, 9999, 10000, 1e15, 2020.5]) {
    assert.equal((await request(`?year=${value}`)).status, 400, String(value));
  }
  for (const value of [-1, 1950, year + 1, 1e15, NaN, Infinity, 2020.5]) {
    await assert.rejects(getDisplacementSummary({} as never, { year: value, countryLimit: 0, flowLimit: 0 }), ValidationError);
  }
  assert.deepEqual(keys, []);
  assert.deepEqual(upstream, []);
});

test('missing and unreadable seeds never fetch UNHCR or write negative query keys; reads recover', async () => {
  for (const fail of [false, true]) {
    const redis = install({}, fail);
    for (const value of [0, year - 1, 1951]) {
      const result = await (await request(`?year=${value}`)).json();
      assert.equal(result.dataAvailable, false);
      assert.equal(result.fetchedAt, 0);
    }
    assert.equal(redis.redis.size, 0);
  }
  assert.deepEqual(upstream, []);
  assert.ok(keys.every(k => k === seedKey || k === metaKey));
  install({ [seedKey]: snapshot, [metaKey]: { fetchedAt } });
  assert.equal((await (await request()).json()).dataAvailable, true);
});

test('a seed metadata outage returns an unavailable response without upstream I/O', async () => {
  install({ [seedKey]: snapshot, [metaKey]: { fetchedAt } }, false, [metaKey]);
  const result = await (await request()).json();
  assert.equal(result.dataAvailable, false);
  assert.equal(result.fetchedAt, 0);
  assert.ok(keys.every(k => k === seedKey || k === metaKey));
  assert.deepEqual(upstream, []);
});

test('stale seed stays readable without a live fallback even when the former flag is enabled', async () => {
  const staleAt = fetchedAt - 24 * 60 * 60 * 1000;
  process.env.SEED_FALLBACK_DISPLACEMENT = '1';
  install({ [seedKey]: snapshot, [metaKey]: { fetchedAt: staleAt } });
  assert.deepEqual(await (await request()).json(), { ...snapshot, fetchedAt: staleAt, dataAvailable: true });
  assert.deepEqual(upstream, []);
});

test('real gateway retains session and canonical public access while keeping unavailable responses no-store', async () => {
  process.env.WM_SESSION_SECRET = 'synthetic-displacement-session-secret-at-least32';
  const token = (await issueSessionToken()).token;
  const gateway = createDomainGateway([route]);
  install({ [seedKey]: snapshot, [metaKey]: { fetchedAt } });
  const url = 'https://worldmonitor.app/api/displacement/v1/get-displacement-summary';
  assert.equal((await gateway(new Request(`${url}?year=${year - 1}`))).status, 401);
  const session = await gateway(new Request(`${url}?year=${year - 1}`, { headers: { 'X-WorldMonitor-Key': token } }));
  assert.equal(session.status, 200);
  assert.equal((await session.json()).dataAvailable, true);
  const publicResponse = await gateway(new Request(`${url}?flow_limit=50&public=1`));
  assert.equal(publicResponse.status, 200);
  assert.equal((await publicResponse.json()).dataAvailable, true);
  install({});
  const missing = await gateway(new Request(`${url}?flow_limit=50&public=1`));
  assert.equal(missing.status, 200);
  assert.equal((await missing.json()).dataAvailable, false);
  assert.equal(missing.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(upstream, []);
});

test('published year example is accepted by the real generated route', async () => {
  const spec = JSON.parse(await readFile(new URL('../docs/api/DisplacementService.openapi.json', import.meta.url), 'utf8'));
  const operation = spec.paths['/api/displacement/v1/get-displacement-summary'].get;
  const yearParameter = operation.parameters.find(p => p.name === 'year');
  const example = yearParameter.example;
  const yearSchema = spec.components.schemas.GetDisplacementSummaryRequest.properties.year;
  const responseExample = operation.responses['200'].content['application/json'].example;
  assert.equal(example, 0);
  assert.deepEqual(yearSchema.oneOf, [
    { const: 0, type: 'integer' },
    { type: 'integer', format: 'int32', minimum: 1951, maximum: year },
  ]);
  assert.deepEqual(yearParameter.schema, { oneOf: yearSchema.oneOf });
  assert.equal(responseExample.dataAvailable, true);
  assert.ok(responseExample.summary.year >= 1951);
  install({ [seedKey]: snapshot, [metaKey]: { fetchedAt } });
  const response = await request(`?year=${example}`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ...snapshot, fetchedAt, dataAvailable: true });
});
