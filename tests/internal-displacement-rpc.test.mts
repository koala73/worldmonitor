import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { createDisplacementServiceRoutes } from '../src/generated/server/worldmonitor/displacement/v1/service_server.ts';
import { displacementHandler } from '../server/worldmonitor/displacement/v1/handler.ts';
import { DTM_CANONICAL_KEY } from '../server/worldmonitor/displacement/v1/get-internal-displacement.ts';
import { __resetKeyPrefixCacheForTests } from '../server/_shared/redis.ts';
import { serverOptions } from '../server/gateway.ts';
import { installRedis } from './helpers/fake-upstash-redis.mts';
import { toInternalDisplacementData } from '../src/services/displacement/internal.ts';
import type { GetInternalDisplacementResponse } from '../src/generated/client/worldmonitor/displacement/v1/service_client.ts';
import { readFile } from 'node:fs/promises';

const route = createDisplacementServiceRoutes(displacementHandler, serverOptions).find((r) => r.path.endsWith('/get-internal-displacement'))!;
const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
const fetchedAt = Date.now() - 60_000;

const sudan = {
  countryCode: 'SDN', countryName: 'Sudan', operation: 'Armed Clashes in Sudan (Overview)', reportingDate: '2026-07-31', roundNumber: 38, totalIdps: 1500,
  reasons: [{ reason: 'Conflict', idps: 1500 }],
  regions: [{ pcode: 'SD11', name: 'Kassala', idps: 1500, location: { latitude: 15.66, longitude: 35.87 } }],
  flows: [],
};
const drcCountrywide = {
  countryCode: 'COD', countryName: 'DRC', operation: 'Countrywide monitoring', reportingDate: '2026-02-28', roundNumber: 5, totalIdps: 900,
  reasons: [],
  regions: [{ pcode: 'CD54', name: 'Ituri', idps: 900, location: { latitude: 1.44, longitude: 28.93 } }],
  flows: [{ originPcode: 'CD61', originName: 'Nord-Kivu', destinationPcode: 'CD54', destinationName: 'Ituri', idps: 100, originLocation: { latitude: 0.5, longitude: 29.1 }, destinationLocation: { latitude: 1.44, longitude: 28.93 } }],
};
const drcIturi = {
  ...drcCountrywide, operation: 'Ituri', reportingDate: '2026-07-31', roundNumber: 15, totalIdps: 1200,
  regions: [{ ...drcCountrywide.regions[0], idps: 1200 }],
  flows: [{ ...drcCountrywide.flows[0], idps: 60 }],
};
const snapshot = { source: 'IOM DTM', lookbackFrom: '2025-04-01', operations: [sudan, drcIturi, drcCountrywide] };

beforeEach(() => {
  for (const k of ['LOCAL_API_MODE', 'VERCEL_ENV', 'VERCEL_GIT_COMMIT_SHA']) delete process.env[k];
  __resetKeyPrefixCacheForTests();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const k of Object.keys(process.env)) if (!(k in originalEnv)) delete process.env[k];
  Object.assign(process.env, originalEnv);
  __resetKeyPrefixCacheForTests();
});

function install(fixtures: Record<string, unknown>, fail = false) {
  const redis = installRedis(fixtures);
  const upstream: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname !== 'redis.example') {
      upstream.push(url.hostname);
      return Response.json({});
    }
    if (fail) return Response.json({ error: 'synthetic unavailable' }, { status: 503 });
    return redis.fetchImpl(input, init);
  }) as typeof fetch;
  return upstream;
}

async function request(query = '') {
  return route.handler(new Request(`https://worldmonitor.app/api/displacement/v1/get-internal-displacement${query}`));
}

test('handler and seeder agree on the canonical key', async () => {
  const producer = await readFile(new URL('../scripts/seed-dtm-displacement.mjs', import.meta.url), 'utf8');
  assert.match(producer, new RegExp(`export const DTM_CANONICAL_KEY = '${DTM_CANONICAL_KEY}';`));
});

test('returns every operation from the seeded snapshot without calling DTM', async () => {
  const upstream = install({ [DTM_CANONICAL_KEY]: { _seed: { fetchedAt, recordCount: 3, schemaVersion: 1 }, data: snapshot } });
  const body = await (await request()).json();
  assert.deepEqual(body, { operations: snapshot.operations, fetchedAt, dataAvailable: true });
  assert.deepEqual(upstream, []);
});

test('country_code narrows to one country, case-insensitively', async () => {
  install({ [DTM_CANONICAL_KEY]: { _seed: { fetchedAt, recordCount: 3, schemaVersion: 1 }, data: snapshot } });
  const body = await (await request('?country_code=cod')).json();
  assert.deepEqual(body.operations.map((op: { operation: string }) => op.operation), ['Ituri', 'Countrywide monitoring']);
  assert.equal(body.dataAvailable, true);
});

test('rejects a country code that is not ISO3', async () => {
  install({});
  const response = await request('?country_code=SD');
  assert.equal(response.status, 400);
});

test('reports unavailable when the snapshot is missing or Redis fails', async () => {
  install({});
  assert.deepEqual(await (await request()).json(), { operations: [], fetchedAt: 0, dataAvailable: false });
  install({ [DTM_CANONICAL_KEY]: { _seed: { fetchedAt, recordCount: 3, schemaVersion: 1 }, data: snapshot } }, true);
  assert.deepEqual(await (await request()).json(), { operations: [], fetchedAt: 0, dataAvailable: false });
});

test('client map data keeps the largest overlapping count instead of summing operations', () => {
  const data = toInternalDisplacementData({ ...snapshot, fetchedAt, dataAvailable: true } as GetInternalDisplacementResponse);
  assert.deepEqual(data.operations.map((op) => [op.operation, op.totalIdps, op.lat]), [
    ['Armed Clashes in Sudan (Overview)', 1500, 15.66],
    ['Ituri', 1200, 1.44],
    ['Countrywide monitoring', 900, 1.44],
  ]);
  assert.deepEqual(data.regions.map((r) => [r.pcode, r.idps, r.operation]), [
    ['SD11', 1500, 'Armed Clashes in Sudan (Overview)'],
    ['CD54', 1200, 'Ituri'],
  ]);
  assert.deepEqual(data.routes.map((r) => [r.originName, r.idps, r.operation]), [['Nord-Kivu', 100, 'Countrywide monitoring']]);
});

test('client map data is empty when the snapshot is unavailable', () => {
  const data = toInternalDisplacementData({ operations: [sudan], fetchedAt: 0, dataAvailable: false } as GetInternalDisplacementResponse);
  assert.deepEqual(data, { operations: [], regions: [], routes: [] });
});
