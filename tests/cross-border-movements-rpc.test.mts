import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createDisplacementServiceRoutes } from '../src/generated/server/worldmonitor/displacement/v1/service_server.ts';
import { displacementHandler } from '../server/worldmonitor/displacement/v1/handler.ts';
import { __resetKeyPrefixCacheForTests } from '../server/_shared/redis.ts';
import { serverOptions } from '../server/gateway.ts';
import { installRedis } from './helpers/fake-upstash-redis.mts';
import { isPublicSharedRpcRequest } from '../src/shared/public-rpc-cache.ts';
import { toMovementData } from '../src/services/displacement/cross-border.ts';
import { parsePanamaText } from '../scripts/lib/border-authorized-reports.mjs';

const route = createDisplacementServiceRoutes(displacementHandler, serverOptions).find(r => r.path.endsWith('/get-cross-border-movements'))!;
const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  __resetKeyPrefixCacheForTests();
});
const url = 'https://worldmonitor.app/api/displacement/v1/get-cross-border-movements';

test('cached RPC returns a filtered source figure and tolerates another source failure without provider fetches', async () => {
  for (const key of ['LOCAL_API_MODE', 'VERCEL_ENV', 'VERCEL_GIT_COMMIT_SHA']) delete process.env[key];
  __resetKeyPrefixCacheForTests();
  const redis = installRedis({ 'displacement:border-uk:v1': { _seed: { fetchedAt: Date.now() - 1000 }, data: {
    routes: [{ id: 'english-channel', name: 'Channel', kind: 'arrival', measure: 'daily', countryCode: 'GB', asOf: new Date(Date.now() - 86400000).toISOString().slice(0, 10), latestCount: 0, last7Days: 0, last30Days: 0 }],
  } } });
  globalThis.fetch = async (input, init) => {
    assert.equal(new URL(String(input)).hostname, 'redis.example');
    return redis.fetchImpl(input, init);
  };
  const response = await route.handler(new Request(`${url}?country_code=gb&route=english-channel`));
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.movements.length, 1);
  assert.equal(data.movements[0].count, 0);
  assert.equal(data.movements[0].last30Days, 0);
  assert.equal(data.movements[0].source, 'UK Home Office');
  assert.equal(data.sources.find(s => s.id === 'cbp').status, 'unavailable');
  const empty = await (await route.handler(new Request(`${url}?country_code=US`))).json();
  assert.equal(empty.dataAvailable, true);
  assert.deepEqual(empty.movements, []);
  assert.equal((await route.handler(new Request(`${url}?country_code=GBR`))).status, 400);
  assert.equal((await route.handler(new Request(`${url}?route=${'x'.repeat(121)}`))).status, 400);
});

test('only the unfiltered aggregate is shared publicly', () => {
  assert.equal(isPublicSharedRpcRequest(`${url}?public=1`), true);
  assert.equal(isPublicSharedRpcRequest(`${url}?public=1&country_code=GB`), false);
  assert.equal(isPublicSharedRpcRequest(`${url}?public=1&route=english-channel`), false);
});

test('authorized route reports reach the cached RPC and map with attribution, separate measures and failure isolation', async () => {
  const now = Date.now();
  const current = new Date(now);
  const asOf = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), 0)).toISOString().slice(0, 10);
  const panama = parsePanamaText('TRANSITO IRREGULAR DE EXTRANJEROS POR LA FRONTERA CON COLOMBIA\nRegion Total Ene. Feb. Mar. Abr. May. Jun. Jul. Ago. Sep. Oct. Nov. Dic.\nTotal 539 34 19 39 43 43 102 40 148 71 - - -\nCifras preliminares sujetas a revision y actualizacion al 30 de septiembre de 2026');
  const frontex = { id: 'frontex-central-mediterranean', name: 'Central Mediterranean detections', kind: 'encounter', measure: 'monthly', countryCode: '', latestCount: 2995, asOf, period: asOf.slice(0, 7), surge: true, latitude: 35, longitude: 14 };
  const fixtures = {
    'displacement:border-frontex:v1': { _seed: { fetchedAt: now }, data: { routes: [frontex] } },
    'displacement:border-panama:v1': { _seed: { fetchedAt: now }, data: { routes: panama.map(row => ({ ...row, asOf, period: asOf.slice(0, 7) })) } },
  };
  const redis = installRedis(fixtures);
  globalThis.fetch = async (input, init) => {
    assert.equal(new URL(String(input)).hostname, 'redis.example');
    return redis.fetchImpl(input, init);
  };
  const data = await (await route.handler(new Request(url))).json();
  assert.equal(data.movements.length, 2);
  assert.equal(data.sources.find(s => s.id === 'uk').status, 'unavailable');
  const detection = data.movements.find(m => m.source === 'Frontex');
  assert.equal(detection.kind, 'encounter');
  assert.equal(detection.surge, false, 'detections cannot trigger an arrival surge');
  assert.equal(detection.countryCode, '');
  assert.equal(detection.license, 'Used with permission');
  assert.match(detection.notice, /not unique people/);
  const arrivals = data.movements.find(m => m.countryCode === 'PA');
  assert.equal(arrivals.count, 71);
  assert.equal(arrivals.kind, 'arrival');
  assert.match(arrivals.notice, /permission/);
  const map = toMovementData(data);
  assert.deepEqual(map.points.map(p => p.individuals), [2995, 71]);
  assert.ok(map.points.every(p => p.sourceUrl.startsWith('https://')));
  const filtered = await (await route.handler(new Request(`${url}?country_code=CO`))).json();
  assert.deepEqual(filtered.movements.map(m => m.id), ['darien-gap']);
});

test('map adapter separates deaths, drops stale markers and avoids summing overlapping stocks', () => {
  const now = Date.parse('2026-10-19T12:00:00Z');
  const movement = { id: 'a', route: 'a', name: 'A', kind: 'outflow', measure: 'stock', countryCode: 'TD', originCode: 'SD', asOf: '2026-10-18', period: '', count: 100, stockChange: 20, stockChangeSince: '2026-10-04', stale: false, surge: false, source: 'UNHCR', sourceUrl: 'https://data.unhcr.org/', license: 'CC BY 4.0', licenseUrl: '', notice: 'Derived view', location: { latitude: 15, longitude: 19 } };
  const data = toMovementData({ sources: [{ id: 'odp', name: 'UNHCR', status: 'ok', fetchedAt: now, contentAt: Date.parse(movement.asOf), maxContentAgeMin: 45 * 1440 }], dataAvailable: true, movements: [movement, { ...movement, id: 'overlap', count: 80 }, { ...movement, id: 'stale', count: 500, stale: true }, { ...movement, id: 'death', kind: 'death', measure: 'monthly', count: 5 }] }, now);
  assert.equal(data.situations.length, 4);
  assert.deepEqual(data.situations[0]?.latestChange, { delta: 20, days: 14 });
  assert.equal(data.points[0]?.change, 20);
  assert.deepEqual(data.points.map(p => p.individuals), [100]);
  assert.deepEqual(data.deaths?.map(p => p.individuals), [5]);
  assert.equal(data.deaths?.[0]?.sourceUrl, movement.sourceUrl);
});


test('country filter accepts letter shape without claiming ISO assignment validation', async () => {
  const now = Date.now();
  const asOf = new Date(now - 86400000).toISOString().slice(0, 10);
  const redis = installRedis({ 'displacement:border-uk:v1': { _seed: { fetchedAt: now }, data: { routes: [{ id: 'english-channel', kind: 'arrival', measure: 'daily', countryCode: 'GB', latestCount: 0, asOf }] } } });
  globalThis.fetch = redis.fetchImpl;
  assert.equal((await route.handler(new Request(`${url}?country_code=gB`))).status, 200);
  const unknown = await route.handler(new Request(`${url}?country_code=ZZ`));
  assert.equal(unknown.status, 200);
  assert.deepEqual((await unknown.json()).movements, []);
  assert.equal((await route.handler(new Request(`${url}?country_code=123`))).status, 400);
});
