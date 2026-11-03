import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import * as weather from '../scripts/_weather-alert-select.mjs';
import { __testing__ as health } from '../api/health.js';

const relay = readFileSync(new URL('../scripts/ais-relay.cjs', import.meta.url), 'utf8');
const weatherLoop = relay.slice(relay.indexOf('const WEATHER_SEED_INTERVAL_MS ='), relay.indexOf('async function startWeatherSeedLoop()'));
const envelopes = relay.slice(relay.indexOf('function buildEnvelope('), relay.indexOf('function notifySimpleHash('));
const KEY = 'weather:alerts:v1';
const META = 'seed-meta:weather:alerts';
const MINUTE = 60_000;
const START = Date.parse('2026-09-07T01:41:21Z');
const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));

function fixture(source, index, expires) {
  const id = `${source}-${index}`;
  const geometry = { type: 'Polygon', coordinates: [[[-100, 40], [-99, 40], [-99, 41], [-100, 40]]] };
  if (source === 'nws') return { id, geometry, properties: { severity: 'Severe', event: 'Flood', expires } };
  if (source === 'eccc') return { id, geometry, properties: { status_en: 'issued', risk_colour_en: 'red', alert_name_en: 'Flood', expiration_datetime: expires } };
  return { id, url: 'gb-alert', mid: '1', s: 3, u: 3, c: 3, event: 'Flood', lat: 51, lon: 0, expires };
}

function harness({ store = new Map() } = {}) {
  let now = START;
  let failed = [];
  let empty = [];
  let failedWrites = [];
  let nwsDelay = 0;
  let writeDelay = 0;
  let ecccFetch;
  let expires = new Date(START + 120 * MINUTE).toISOString();
  const logs = [];
  const requests = [];
  const notifications = [];
  const writes = [];
  const context = {
    Date: class extends Date { static now() { return now; } },
    console: { log: (...args) => logs.push(args.join(' ')), warn: (...args) => logs.push(args.join(' ')) },
    weatherAlertSelectPromise: Promise.resolve(weather),
    CHROME_UA: 'H4 fixture', PROXY_URL: 'http://fixture.invalid',
    parseProxyUrl: () => ({ host: 'fixture.invalid', port: 8080 }),
    require: (name) => {
      assert.equal(name, './_proxy-utils.cjs');
      return { proxyFetch: async () => { requests.push('nws-proxy'); throw new Error('Proxy CONNECT HTTP/1.1 522 Server Error'); } };
    },
    fetch: async (url, options) => {
      const source = url.includes(weather.NWS_HOST) ? 'nws' : url.includes(weather.ECCC_HOST) ? 'eccc' : 'swic';
      requests.push(source);
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal);
      if (source === 'nws' && nwsDelay) {
        await new Promise((resolve) => setImmediate(resolve));
        now += nwsDelay;
      }
      if (failed.includes(source)) throw new Error(source === 'nws' ? 'The operation was aborted due to timeout' : 'HTTP 503');
      if (source === 'eccc' && ecccFetch) return ecccFetch(url, expires);
      if (url === weather.SWIC_MEMBERS_URL) return Response.json([{ members: [{ mid: '1', code: 'GBR' }] }]);
      const count = empty.includes(source) ? 0 : source === 'nws' ? 227 : source === 'eccc' ? (url.includes('continued') ? 0 : 207) : 946;
      const items = Array.from({ length: count }, (_, i) => fixture(source, i, expires));
      return Response.json(source === 'swic' ? { items } : { type: 'FeatureCollection', numberMatched: count, numberReturned: count, features: items });
    },
    upstashGet: async (key) => clone(store.get(key)),
    upstashSet: async (key, value, ttl) => {
      now += writeDelay;
      if (failedWrites.includes(key)) return false;
      store.set(key, clone(value)); writes.push({ key, ttl }); return true;
    },
    nwsVtec: () => undefined,
    publishNotificationEvent: async (event) => notifications.push(clone(event)),
  };
  const seed = runInNewContext(`${envelopes}\n${weatherLoop}\nseedWeatherAlerts`, context);
  return {
    store, logs, requests, notifications, writes,
    async run({ at = now, failures = [], emptySources = [], expiry = expires, writeFailures = [], nwsDelayMs = 0, writeDelayMs = 0, ecccFetchFn } = {}) {
      now = at; failed = failures; empty = emptySources; expires = expiry; failedWrites = writeFailures; nwsDelay = nwsDelayMs; writeDelay = writeDelayMs;
      ecccFetch = ecccFetchFn;
      await seed();
      assert.ok(!logs.some((line) => line.startsWith('[Weather] Seed error:')), logs.join('\n'));
      return { payload: clone(store.get(KEY)?.data), meta: clone(store.get(META)) };
    },
    classify(at = now) {
      return health.classifyKey('weatherAlerts', KEY, { allowOnDemand: false }, {
        now: at,
        keyStrens: new Map([[KEY, store.has(KEY) ? JSON.stringify(store.get(KEY)).length : 0]]),
        keyErrors: new Map(), keyMetaErrors: new Map(),
        keyMetaValues: new Map([[META, JSON.stringify(store.get(META))]]),
      });
    },
  };
}

test('relay NWS timeout/proxy 522 is pending once with retained coverage, then recovers', async () => {
  const h = harness();
  const good = await h.run();
  assert.equal(good.payload.alerts.length, 50);
  assert.equal(h.classify().status, 'OK');
  const expiry = new Date(START + 120 * MINUTE).toISOString();
  h.store.get(KEY).data.alerts = [
    ...weather.rankEligibleAlerts(Array.from({ length: 19 }, (_, i) => fixture('nws', i, expiry))),
    ...weather.selectEcccAlerts(Array.from({ length: 15 }, (_, i) => fixture('eccc', i, expiry))),
    ...weather.selectSwicAlerts(Array.from({ length: 16 }, (_, i) => fixture('swic', i, expiry))),
  ];
  const failed = await h.run({ at: START + 15 * MINUTE, failures: ['nws'] });
  assert.ok(h.requests.includes('nws-proxy'));
  assert.ok(h.logs.some((line) => line.includes('522')));
  assert.ok(h.logs.some((line) => line.includes('nws=19 eccc=0 swic=0')));
  assert.equal(failed.meta.sourceState, 'degraded');
  assert.equal(failed.payload.alerts.length, 50);
  assert.ok(failed.payload.alerts.some((alert) => alert.source === 'nws'));
  assert.equal(h.classify().status, 'SEED_ERROR');
  assert.equal(health.healthStatusBucket(h.classify(), START + 15 * MINUTE), 'ok');
  assert.equal(h.classify().sourceFailurePendingUntil, new Date(START + 35 * MINUTE).toISOString());
  assert.equal(failed.meta.sourceHealth.nws.lastSuccessAt, START);
  assert.equal(failed.meta.sourceHealth.eccc.lastSuccessAt, START + 15 * MINUTE);
  const recovered = await h.run({ at: START + 30 * MINUTE });
  assert.equal(recovered.meta.sourceState, 'ok');
  assert.equal(h.classify().status, 'OK');
  assert.equal(h.writes.find(({ key }) => key === KEY).ttl, 5400);
});

function assertWarn(h, at) {
  const entry = h.classify(at);
  assert.equal(entry.sourceFailurePendingUntil, undefined);
  assert.equal(health.healthStatusBucket(entry, at), 'warn', JSON.stringify(entry));
}

test('repeat failure survives a relay restart and recovery resets only successful sources', async () => {
  const first = harness();
  await first.run();
  await first.run({ at: START + 15 * MINUTE, failures: ['nws'] });
  const restarted = harness({ store: first.store });
  const second = await restarted.run({ at: START + 30 * MINUTE, failures: ['nws'] });
  assert.equal(second.meta.sourceHealth.nws.consecutiveFailures, 2);
  assert.equal(second.meta.sourceHealth.nws.firstFailureAt, START + 15 * MINUTE);
  assert.equal(second.meta.sourceHealth.nws.lastSuccessAt, START);
  assertWarn(restarted, START + 30 * MINUTE);
  const recovered = await restarted.run({ at: START + 31 * MINUTE, failures: ['swic'] });
  assert.equal(recovered.meta.sourceHealth.nws.lastSuccessAt, START + 31 * MINUTE);
  assert.equal(recovered.meta.sourceHealth.nws.consecutiveFailures, 0);
  assert.equal(recovered.meta.sourceHealth.nws.firstFailureAt, null);
  assert.equal(recovered.meta.sourceHealth.swic.lastSuccessAt, START + 30 * MINUTE);
  assert.ok(restarted.classify().sourceFailurePendingUntil);
});

test('deadline expires without a producer run or a new health poll', async () => {
  const h = harness();
  await h.run();
  await h.run({ at: START + 15 * MINUTE, failures: ['nws'] });
  const entry = h.classify();
  const deadline = START + 35 * MINUTE;
  assert.deepEqual(h.classify(), entry);
  const compact = health.healthResponseBody({ status: 'HEALTHY', summary: { pending: 1 }, checks: { weatherAlerts: entry } }, true);
  assert.deepEqual(compact.pending.weatherAlerts, entry);
  assert.equal(compact.problems, undefined);
  assert.equal(health.snapshotTtlSeconds(compact, deadline - 20_000), 20);
  assert.equal(health.hasExpiredActivationGrace(compact, deadline), true);
  assert.equal(health.healthStatusBucket(entry, deadline), 'warn');
  assertWarn(h, deadline);
});

test('pending ends at selected retained alert expiry or source freshness, whichever comes first', async () => {
  for (const [expiry, failedAt, deadline] of [
    [START + 18 * MINUTE, START + 15 * MINUTE, START + 18 * MINUTE],
    [START + 120 * MINUTE, START + 40 * MINUTE, START + 45 * MINUTE],
  ]) {
    const h = harness();
    await h.run({ expiry: new Date(expiry).toISOString() });
    await h.run({ at: failedAt, failures: ['nws'] });
    assert.equal(h.classify().sourceFailurePendingUntil, new Date(deadline).toISOString());
    assertWarn(h, deadline);
  }
});

test('missing, expired, or invalid retained NWS coverage warns while other sources stay fresh', async () => {
  for (const alter of [
    (h) => { h.store.get(KEY).data.alerts = h.store.get(KEY).data.alerts.filter((a) => a.source !== 'nws'); },
    (h) => { h.store.delete(KEY); },
    (h) => { for (const a of h.store.get(KEY).data.alerts) if (a.source === 'nws') a.expires = new Date(START + 15 * MINUTE).toISOString(); },
    (h) => { for (const a of h.store.get(KEY).data.alerts) if (a.source === 'nws') a.expires = ''; },
    (h) => { h.store.delete(META); },
    (h) => { delete h.store.get(META).sourceHealth; },
    (h) => { h.store.get(META).sourceHealth.nws.lastSuccessAt = START - 46 * MINUTE; },
  ]) {
    const h = harness();
    await h.run();
    alter(h);
    const result = await h.run({ at: START + 15 * MINUTE, failures: ['nws'] });
    assert.equal(result.meta.fetchedAt, START + 15 * MINUTE);
    assert.ok(result.payload.alerts.some((a) => a.source === 'eccc'));
    assert.ok(result.payload.alerts.every((a) => Date.parse(a.expires) > START + 15 * MINUTE));
    assertWarn(h, START + 15 * MINUTE);
  }
});

test('successful empty sources purge old alerts and cannot grant pending on the next failure', async () => {
  const h = harness();
  await h.run();
  const empty = await h.run({ at: START + 15 * MINUTE, emptySources: ['nws'] });
  assert.ok(empty.payload.alerts.every((a) => a.source !== 'nws'));
  assert.equal(h.classify().status, 'OK');
  await h.run({ at: START + 30 * MINUTE, failures: ['nws'] });
  assertWarn(h, START + 30 * MINUTE);
  const cleared = await h.run({ at: START + 45 * MINUTE, emptySources: ['nws', 'eccc', 'swic'] });
  assert.deepEqual(cleared.payload.alerts, []);
  assert.equal(h.classify().status, 'OK');
});

test('a total source outage records failures without renewing the canonical envelope', async () => {
  const h = harness();
  await h.run();
  const before = clone(h.store.get(KEY));
  const failed = await h.run({ at: START + 15 * MINUTE, failures: ['nws', 'eccc', 'swic'] });
  assert.deepEqual(h.store.get(KEY), before);
  assert.equal(failed.meta.fetchedAt, START);
  assertWarn(h, START + 15 * MINUTE);
  await h.run({ at: START + 30 * MINUTE, failures: ['nws'] });
  assert.equal(h.store.get(META).sourceHealth.nws.consecutiveFailures, 2);
  assertWarn(h, START + 30 * MINUTE);
});

test('expired carried alerts are purged before ranking and notification selection', async () => {
  const h = harness();
  await h.run();
  h.notifications.length = 0;
  const oldNws = h.store.get(KEY).data.alerts.filter((a) => a.source === 'nws');
  oldNws[0].expires = new Date(START + 15 * MINUTE).toISOString();
  oldNws[0].headline = 'Ended alert';
  const failed = await h.run({ at: START + 15 * MINUTE, failures: ['nws'] });
  assert.ok(failed.payload.alerts.every((a) => a.id !== oldNws[0].id));
  assert.ok(h.notifications.every((n) => n.payload.title !== 'Ended alert'));
  assert.ok(failed.payload.alerts.some((a) => a.source === 'nws'));
  assert.equal(failed.payload.alerts.length, 50);
  assert.ok(h.classify().sourceFailurePendingUntil);
});

test('malformed source evidence and missing payload fail closed at the health reader', async () => {
  const h = harness();
  await h.run();
  await h.run({ at: START + 15 * MINUTE, failures: ['nws'] });
  const original = clone(h.store.get(META));
  for (const corrupt of [
    (m) => { m.failedSources = []; },
    (m) => { m.failedSources = ['nws', 'nws']; },
    (m) => { m.failedSources = ['unknown']; },
    (m) => { m.sourceHealth.nws.retainedUntil = null; },
    (m) => { m.sourceHealth.nws.consecutiveFailures = '1'; },
    (m) => { m.sourceHealth.nws.firstFailureAt = START + 16 * MINUTE; },
    (m) => { m.sourceHealth.nws.lastSuccessAt = START + 16 * MINUTE; },
    (m) => { m.lastSourceAttemptAt = START + 16 * MINUTE; },
    (m) => { m.sourceState = 'error'; },
    (m) => { m.status = 'error'; },
  ]) {
    const meta = clone(original); corrupt(meta); h.store.set(META, meta);
    assertWarn(h, START + 15 * MINUTE);
  }
  h.store.set(META, original); h.store.delete(KEY);
  assertWarn(h, START + 15 * MINUTE);
  assert.equal(h.classify().sourceFailurePendingUntil, undefined);
});

test('a failed payload write cannot qualify old alerts using a newer unpublished success', async () => {
  const h = harness();
  await h.run();
  const old = clone(h.store.get(KEY));
  await h.run({ at: START + 15 * MINUTE, writeFailures: [KEY] });
  assert.deepEqual(h.store.get(KEY), old);
  assertWarn(h, START + 15 * MINUTE);
  await h.run({ at: START + 30 * MINUTE, failures: ['nws'] });
  assertWarn(h, START + 30 * MINUTE);
});

test('a lost metadata write cannot restart pending from an older successful publication', async () => {
  const h = harness();
  await h.run();
  const previousMeta = clone(h.store.get(META));
  await h.run({ at: START + 15 * MINUTE, failures: ['nws'], writeFailures: [META] });
  assert.deepEqual(h.store.get(META), previousMeta);
  assert.equal(h.store.get(KEY)._seed.fetchedAt, START + 15 * MINUTE);
  const restarted = harness({ store: h.store });
  await restarted.run({ at: START + 30 * MINUTE, failures: ['nws'] });
  assertWarn(restarted, START + 30 * MINUTE);
  await restarted.run({ at: START + 31 * MINUTE });
  await restarted.run({ at: START + 32 * MINUTE, failures: ['nws'] });
  assert.ok(restarted.classify().sourceFailurePendingUntil);
});

test('publication clocks match despite Redis latency and unpaired legacy state cannot grant pending', async () => {
  const h = harness();
  await h.run({ writeDelayMs: 1000 });
  assert.equal(h.store.get(KEY)._seed.fetchedAt, h.store.get(META).fetchedAt);
  await h.run({ at: START + 15 * MINUTE, failures: ['nws'], writeDelayMs: 1000 });
  assert.ok(h.classify().sourceFailurePendingUntil);
  const legacy = harness();
  await legacy.run();
  legacy.store.set(KEY, legacy.store.get(KEY).data);
  const result = await legacy.run({ at: START + 15 * MINUTE, failures: ['nws'] });
  assert.ok(result.payload.alerts.some((alert) => alert.source === 'nws'));
  assertWarn(legacy, START + 15 * MINUTE);
});

test('every failed provider needs usable retained coverage, including a two-source failure', async () => {
  for (const failures of [['eccc'], ['swic'], ['nws', 'eccc']]) {
    const h = harness();
    await h.run();
    await h.run({ at: START + 15 * MINUTE, failures });
    assert.ok(h.classify().sourceFailurePendingUntil, failures.join(','));
    for (const source of failures) assert.equal(h.store.get(META).sourceHealth[source].lastSuccessAt, START);
    await h.run({ at: START + 30 * MINUTE, failures });
    assertWarn(h, START + 30 * MINUTE);
  }
});


test('provider success clocks precede a slower failed source and aggregate publication', async () => {
  const h = harness();
  await h.run();
  const result = await h.run({ at: START + 15 * MINUTE, failures: ['nws'], nwsDelayMs: 15_000 });
  assert.equal(result.meta.sourceHealth.nws.lastSuccessAt, START);
  assert.equal(result.meta.sourceHealth.eccc.lastSuccessAt, START + 15 * MINUTE);
  assert.equal(result.meta.sourceHealth.swic.lastSuccessAt, START + 15 * MINUTE);
  assert.equal(result.meta.sourceHealth.nws.firstFailureAt, START + 15 * MINUTE + 15_000);
  assert.equal(result.meta.fetchedAt, START + 15 * MINUTE + 15_000);
});


test('paged ECCC success, late-page failure, recovery and valid zero reach relay health', async () => {
  const h = harness();
  const ecccFetch = (fail = false) => async (url, expiry) => {
    const p = new URL(url).searchParams;
    const offset = Number(p.get('offset'));
    const count = p.get('status_en') === 'issued' ? 300 : 0;
    if (fail && offset > 0) throw new Error('late-page failure');
    const features = Array.from({ length: Math.min(250, count - offset) }, (_, i) => ({
      ...fixture('eccc', offset + i, expiry), padding: 'x'.repeat(15_000),
    }));
    return Response.json({ type: 'FeatureCollection', numberMatched: count, numberReturned: features.length, features });
  };
  const good = await h.run({ ecccFetchFn: ecccFetch() });
  const ids = (payload) => payload.alerts.filter((a) => a.source === 'eccc').map((a) => a.id);
  assert.ok(ids(good.payload).length > 0);
  assert.equal(h.classify().status, 'OK');
  const failed = await h.run({ at: START + 15 * MINUTE, ecccFetchFn: ecccFetch(true) });
  assert.deepEqual(ids(failed.payload), ids(good.payload));
  assert.equal(failed.meta.sourceHealth.eccc.lastSuccessAt, good.meta.sourceHealth.eccc.lastSuccessAt);
  assert.equal(failed.meta.sourceHealth.nws.lastSuccessAt, START + 15 * MINUTE);
  assert.equal(failed.meta.sourceState, 'degraded');
  assert.equal(h.classify().status, 'SEED_ERROR');
  const recovered = await h.run({ at: START + 30 * MINUTE, ecccFetchFn: ecccFetch() });
  assert.equal(recovered.meta.sourceHealth.eccc.lastSuccessAt, START + 30 * MINUTE);
  assert.equal(h.classify().status, 'OK');
  const zero = await h.run({ at: START + 45 * MINUTE, emptySources: ['eccc'] });
  assert.deepEqual(ids(zero.payload), []);
  assert.equal(zero.meta.sourceHealth.eccc.lastSuccessAt, START + 45 * MINUTE);
  assert.equal(h.classify().status, 'OK');
});
