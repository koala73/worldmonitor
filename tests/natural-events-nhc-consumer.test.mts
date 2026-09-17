import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { listNaturalEvents } from '../server/worldmonitor/natural/v1/list-natural-events.ts';
import { fetchNaturalEvents, naturalEventsAfterPublish, naturalEventsPublishTransform } from '../scripts/seed-natural-events.mjs';
import { __testing__ as health } from '../api/health.js';

const NOW = Date.parse('2026-09-07T10:05:00.000Z');
const originalFetch = globalThis.fetch;
const originalUrl = process.env.UPSTASH_REDIS_REST_URL;
const originalToken = process.env.UPSTASH_REDIS_REST_TOKEN;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
  else process.env.UPSTASH_REDIS_REST_URL = originalUrl;
  if (originalToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
  else process.env.UPSTASH_REDIS_REST_TOKEN = originalToken;
});

test('natural-events consumer serves a retained NHC storm from the seeded envelope', async () => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.nhc-consumer.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fixture-only';
  const storm = {
    id: 'nhc-AL01-7',
    title: 'Tropical Storm Alpha',
    category: 'severeStorms',
    lat: 20,
    lon: -60,
    date: NOW - 60_000,
    sourceName: 'NHC',
  };
  const values = new Map([
    ['natural:events:v1', JSON.stringify({
      _seed: { fetchedAt: NOW, recordCount: 1, sourceVersion: 'fixture', schemaVersion: 2, state: 'OK' },
      data: { events: [storm] },
    })],
    ['seed-meta:natural:events', JSON.stringify({ fetchedAt: NOW, recordCount: 1, sourceState: 'degraded' })],
  ]);
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const key = decodeURIComponent(url.pathname.slice('/get/'.length));
    return Response.json({ result: values.get(key) ?? null });
  };

  const response = await listNaturalEvents({} as never, {});

  assert.equal(response.dataAvailable, true);
  assert.equal(response.fetchedAt, NOW);
  assert.deepEqual(response.events, [storm]);
});

test('producer, RPC and health keep a failed EONET source visible without renewing its age', async () => {
  let failEonet = false;
  const fetchFn = async (input: string) => {
    if (new URL(input).hostname === 'eonet.gsfc.nasa.gov') {
      if (failEonet) return new Response('', { status: 503 });
      return Response.json({ events: [{
        id: 'eonet-consumer', title: 'Volcano', categories: [{ id: 'volcanoes' }],
        geometry: [{ type: 'Point', coordinates: [10, 20], date: new Date(NOW).toISOString() }],
        sources: [], closed: null,
      }] });
    }
    return Response.json({ type: 'FeatureCollection', features: [] });
  };
  const options = {
    fetchFn,
    fetchHkoWarningsFn: async () => ({ warnings: [], dataAvailable: true, sourceDecision: { status: 'used' } }),
  };
  const first = await fetchNaturalEvents({ ...options, now: NOW });
  failEonet = true;
  const now = NOW + 3_600_000;
  const retained = await fetchNaturalEvents({ ...options, now, previousSources: first._sourceSnapshots });
  const meta = { fetchedAt: now, recordCount: retained.events.length, ...naturalEventsAfterPublish(retained).freshnessMetaPatch };
  const values = new Map([
    ['natural:events:v1', JSON.stringify({ _seed: { fetchedAt: now, recordCount: 1, schemaVersion: 2, state: 'OK' }, data: naturalEventsPublishTransform(retained) })],
    ['seed-meta:natural:events', JSON.stringify(meta)],
  ]);
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.nhc-consumer.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fixture-only';
  globalThis.fetch = async (input) => Response.json({ result: values.get(decodeURIComponent(new URL(String(input)).pathname.slice('/get/'.length))) ?? null });
  const response = await listNaturalEvents({} as never, {});
  assert.equal(response.dataAvailable, true);
  assert.equal(response.fetchedAt, NOW);
  assert.deepEqual(response.events.map(event => event.id), ['eonet-consumer']);
  const result = health.classifyKey('naturalEvents', 'natural:events:v1', { allowOnDemand: false }, {
    keyStrens: new Map([['natural:events:v1', 1000]]), keyErrors: new Map(), keyMetaErrors: new Map(),
    keyMetaValues: new Map([['seed-meta:natural:events', JSON.stringify(meta)]]), now,
  });
  assert.equal(result.status, 'SEED_ERROR');
  assert.equal(result.errorCode, 'EONET_SOURCE_FAILED');
  assert.equal(meta.sourceHealth.eonet.lastSuccessAt, NOW);
});
