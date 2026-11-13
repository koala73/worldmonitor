import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readUkmtoSnapshot } from '../shared/ukmto-incidents.ts';
import { normalizeIncidents } from '../scripts/seed-ukmto-incidents.mjs';
import { __testing__ as health } from '../api/health.js';
import { listUkmtoIncidents } from '../server/worldmonitor/maritime/v1/list-ukmto-incidents';

const now = Date.parse('2026-10-29T10:00:00Z');
const snapshot = { incidents: [], fetchedAt: now, dataAvailable: true, stale: false };

test('fresh empty results differ from unavailable snapshots', () => {
  assert.deepEqual(readUkmtoSnapshot(snapshot, now), snapshot);
  assert.equal(readUkmtoSnapshot(null, now).dataAvailable, false);
  assert.equal(readUkmtoSnapshot({ ...snapshot, dataAvailable: undefined }, now).dataAvailable, false);
  assert.equal(readUkmtoSnapshot({ ...snapshot, incidents: [null] }, now).dataAvailable, false);
  assert.equal(readUkmtoSnapshot({ ...snapshot, dataAvailable: false }, now).dataAvailable, false);
});

test('freshness follows retrieval time and expires retained data', () => {
  assert.equal(readUkmtoSnapshot(snapshot, now + 75 * 60000).stale, false);
  assert.equal(readUkmtoSnapshot(snapshot, now + 75 * 60000 + 1).stale, true);
  assert.equal(readUkmtoSnapshot(snapshot, now + 86400001).dataAvailable, false);
  assert.equal(readUkmtoSnapshot(snapshot, now - 300001).dataAvailable, false);
  assert.equal(readUkmtoSnapshot({ ...snapshot, fetchedAt: 'today' }, now).dataAvailable, false);
});

test('producer records survive the reader without promoting claims or incident dates', () => {
  const incidents = normalizeIncidents({
    v: 1,
    t: { c: ['id', 'type', 'lat', 'lon', 'ts', 'place', 'text'], k: [0, 1, 5, 6], r: [[0, 1, 26.43, 56.48, 1790636400, 2, 3]] },
    s: ['UKMTO-143', 'Suspicious Activity', 'Hormuz', '<img src=x> suspected'],
  });
  assert.equal(incidents[0].reportedAt, 0);
  const result = readUkmtoSnapshot({ ...snapshot, incidents }, now);
  assert.equal(result.dataAvailable, true);
  assert.equal(result.stale, false);
  assert.deepEqual(result.incidents, incidents);
  assert.equal(readUkmtoSnapshot({ ...snapshot, incidents: [{ ...incidents[0], occurredAt: 1e100 }] }, now).dataAvailable, false);
});

test('health is pending before activation and strict after it, including valid empty snapshots', () => {
  const name = 'ukmtoIncidents';
  const key = health.STANDALONE_KEYS[name];
  assert.equal(key, 'maritime:ukmto-incidents:v1');
  const classify = (present: boolean, active: boolean, ageMinutes = 1) => health.classifyKey(name, key, { allowOnDemand: true }, {
    keyStrens: new Map(present ? [[key, 100]] : []), keyErrors: new Map(), keyMetaErrors: new Map(), now,
    activationStates: new Map([[name, active]]),
    keyMetaValues: new Map(present ? [[health.SEED_META[name].key, JSON.stringify({
      fetchedAt: now - ageMinutes * 60000, recordCount: 0, status: 'ok',
    })]] : []),
  });
  assert.equal(health.ACTIVATION_MARKERS[name], 'seed-activated:maritime:ukmto-incidents');
  assert.equal(classify(false, false).status, 'EMPTY_ON_DEMAND');
  assert.equal(classify(false, true).status, 'EMPTY');
  assert.equal(classify(true, true).status, 'OK');
  assert.equal(classify(true, true, 60).status, 'OK');
  assert.equal(classify(true, true, 76).status, 'STALE_SEED');
});

test('RPC unwraps the producer envelope from the bare key without fetching the publisher', async () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.UPSTASH_REDIS_REST_URL;
  const originalToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  const fresh = { ...snapshot, fetchedAt: Date.now() };
  const requests: string[] = [];
  globalThis.fetch = async (input) => {
    requests.push(String(input));
    assert.equal(String(input), 'https://redis.example.test/get/maritime%3Aukmto-incidents%3Av1');
    return Response.json({ result: JSON.stringify({ _seed: { state: 'OK_ZERO', fetchedAt: fresh.fetchedAt, recordCount: 0 }, data: fresh }) });
  };
  try {
    const result = await listUkmtoIncidents({} as never, {});
    assert.deepEqual(result, fresh);
    assert.equal(requests.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = originalUrl;
    if (originalToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = originalToken;
  }
});
