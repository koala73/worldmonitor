import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { __testing__ } from '../api/health.js';
import { CANADA_ALERT_SOURCES, CANADA_ALERTS_KEY } from '../scripts/lib/canada-alerts-union.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/bc-emergency-info.geojson', import.meta.url)));
const source = CANADA_ALERT_SOURCES.find(({ province }) => province === 'BC');
const now = Date.UTC(2026, 8, 7);
const prior = { id: 'bc-evacuation-removed', province: 'BC', severity: 'Extreme', updatedAt: now - 10 * 86400000 };

// Execute the actual seeder and Redis writer with network I/O confined to this child.
const harness = `
import { readFileSync } from 'node:fs';
const { feed, initial, now, unavailable } = JSON.parse(readFileSync(0, 'utf8'));
const cache = new Map(initial);
Date.now = () => now;
process.env.UPSTASH_REDIS_REST_URL = 'https://bc-redis.test';
process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
const timer = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => timer(fn, ms >= 500 && ms <= 30000 ? 0 : ms, ...args);
const command = ([op, key, value]) => {
  if (op === 'SET') { cache.set(key, value); return 'OK'; }
  if (op === 'GET') return cache.get(key) ?? null;
  if (op === 'DEL') return Number(cache.delete(key));
  if (op === 'EXPIRE') return Number(cache.has(key));
  if (op === 'EVAL') return 1;
  throw new Error('Unexpected Redis command ' + op);
};
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(input);
  if (url.hostname === 'services6.arcgis.com') {
    if (unavailable) return new Response('unavailable', { status: 503 });
    return Response.json(feed);
  }
  if (url.hostname !== 'bc-redis.test') throw new Error('Unexpected network ' + url.hostname);
  if (url.pathname.startsWith('/get/')) return Response.json({ result: cache.get(decodeURIComponent(url.pathname.slice(5))) ?? null });
  const body = JSON.parse(options.body);
  return Response.json(Array.isArray(body[0]) ? body.map(cmd => ({ result: command(cmd) })) : { result: command(body) });
};
process.on('exit', () => console.log('BC_RESULT=' + JSON.stringify([...cache])));
await import(process.argv[1]);
`;

function publish(feed, { unavailable = false, initialCache } = {}) {
  const initial = initialCache ? [...initialCache] : CANADA_ALERT_SOURCES.flatMap(entry => [
    [entry.key, JSON.stringify({ alerts: entry.province === 'BC' ? [prior] : [] })],
    [entry.metaKey, JSON.stringify({ fetchedAt: now - 60000, recordCount: entry.province === 'BC' ? 1 : 0, sourceState: 'ok',
      ...(entry.province === 'BC' ? { newestItemAt: prior.updatedAt, maxContentAgeMin: 4320 } : {}) })],
  ]);
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', harness, new URL('../scripts/seed-bc-emergency-info.mjs', import.meta.url).href], {
    input: JSON.stringify({ feed, initial, now, unavailable }), encoding: 'utf8', timeout: 10000,
    env: { PATH: process.env.PATH, NODE_ENV: 'test' },
  });
  assert.ifError(result.error);
  const output = result.stdout.split('\n').find(line => line.startsWith('BC_RESULT='));
  assert.ok(output, result.stderr + result.stdout);
  return { exitCode: result.status, cache: new Map(JSON.parse(output.slice('BC_RESULT='.length))) };
}

function classify(cache, at = now) {
  return __testing__.classifyKey('canadaAlertsBcSource', source.key, {}, {
    now: at,
    keyStrens: new Map([[source.key, cache.get(source.key)?.length ?? 0]]),
    keyErrors: new Map(), keyMetaErrors: new Map(),
    keyMetaValues: new Map([[source.metaKey, cache.get(source.metaKey)]]),
  });
}

test('a newly verified unchanged BC active list is healthy and preserves event dates', () => {
  const { exitCode, cache } = publish(fixture);
  assert.equal(exitCode, 0);
  const snapshot = JSON.parse(cache.get(source.key));
  assert.equal(snapshot.data.alerts.length, 2);
  const alert = snapshot.data.alerts.find(a => a.id === 'bc-evacuation-7');
  assert.equal(alert.updatedAt, 1786956961000);
  assert.equal(alert.publishedAt, 1782993600000);
  assert.equal(alert.onset, new Date(1782993600000).toISOString());
  assert.equal(snapshot._seed.maxContentAgeMin, undefined);
  assert.equal(classify(cache).status, 'OK');
  assert.equal(JSON.parse(cache.get(source.metaKey)).fetchedAt, now);
  assert.equal(classify(cache, now + 46 * 60000).status, 'STALE_SEED');
  cache.delete(source.key);
  assert.equal(classify(cache).status, 'EMPTY');
});

test('BC publication replaces removed orders, applies status changes, and accepts a verified empty list', () => {
  const changed = structuredClone(fixture);
  changed.features = [changed.features[0]];
  changed.features[0].properties.ORDER_ALERT_STATUS = 'Order';
  const { cache, exitCode } = publish(changed);
  assert.equal(exitCode, 0);
  const alerts = JSON.parse(cache.get(CANADA_ALERTS_KEY)).data.alerts;
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].id, 'bc-evacuation-7');
  assert.equal(alerts[0].severity, 'Extreme');
  changed.features[0].properties.ORDER_ALERT_STATUS = 'All Clear';
  for (const feed of [changed, { type: 'FeatureCollection', features: [] }]) {
    const result = publish(feed);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(JSON.parse(result.cache.get(CANADA_ALERTS_KEY)).data.alerts, []);
    assert.equal(classify(result.cache).status, 'OK');
  }
});

test('malformed and unavailable BC feeds preserve the previous snapshot and success clock', () => {
  const missingStatus = structuredClone(fixture.features[0]);
  missingStatus.properties.ORDER_ALERT_STATUS = '';
  const missingDate = structuredClone(fixture.features[0]);
  missingDate.properties.DATE_MODIFIED = null;
  missingDate.properties.EVENT_START_DATE = null;
  for (const [feed, options] of [
    [{ error: { message: 'invalid query' } }, {}],
    [{ type: 'FeatureCollection', features: [null] }, {}],
    [{ type: 'FeatureCollection', features: [missingStatus] }, {}],
    [{ type: 'FeatureCollection', features: [missingDate] }, {}],
    [fixture, { unavailable: true }],
  ]) {
    const { exitCode, cache } = publish(feed, options);
    assert.notEqual(exitCode, 0);
    assert.deepEqual(JSON.parse(cache.get(source.key)).alerts, [prior]);
    assert.equal(JSON.parse(cache.get(source.metaKey)).fetchedAt, now - 60000);
    assert.equal(classify(cache).status, 'SEED_ERROR');
  }
});

test('a successful BC fetch clears a previous source failure without changing event dates', () => {
  const failed = publish(fixture, { unavailable: true });
  const recovered = publish(fixture, { initialCache: failed.cache });
  assert.equal(recovered.exitCode, 0);
  assert.equal(classify(recovered.cache).status, 'OK');
  const meta = JSON.parse(recovered.cache.get(source.metaKey));
  assert.equal(meta.sourceState, 'ok');
  assert.equal(meta.errorCode, undefined);
  assert.equal(meta.maxContentAgeMin, undefined);
});
