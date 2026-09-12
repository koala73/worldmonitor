import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import * as sask from '../scripts/lib/saskalert.mjs';
import { runSeed } from '../scripts/_seed-utils.mjs';
import { CANADA_ALERT_SOURCES, CANADA_ALERTS_KEY, rebuildCanadaAlertsUnion } from '../scripts/lib/canada-alerts-union.mjs';
import { __testing__ } from '../api/health.js';
import { readSectionFreshness } from '../scripts/_bundle-runner.mjs';

const feed = JSON.parse(readFileSync(new URL('./fixtures/saskalert-feed.json', import.meta.url)));
const cap = JSON.parse(readFileSync(new URL('./fixtures/saskalert-cap-active.json', import.meta.url)));
const SOURCE = CANADA_ALERT_SOURCES.find(s => s.province === 'SK');
const COMPLETE = 'seed-completion:alerts:saskalert';
const NOW = Date.parse('2026-08-18T06:00:00Z');

async function fixture(fn) {
  const oldFetch = globalThis.fetch;
  const oldExit = process.exit;
  const oldNow = Date.now;
  const oldLog = console.log;
  const oldWarn = console.warn;
  const oldError = console.error;
  const env = { ...process.env };
  const listeners = new Set(process.rawListeners('SIGTERM'));
  const values = new Map();
  const logs = [];
  const state = { now: NOW, feed: structuredClone(feed), fail: false, values, logs };
  Date.now = () => state.now;
  console.log = console.warn = console.error = (...args) => logs.push(args.join(' '));
  Object.assign(process.env, {
    UPSTASH_REDIS_REST_URL: 'https://redis.fixture', UPSTASH_REDIS_REST_TOKEN: 'fixture',
    WM_BUNDLE_COMPLETION_META_KEY: COMPLETE, WM_SEED_RETRY_DELAY_MS: '0',
  });
  process.exit = code => { throw Object.assign(new Error('fixture exit'), { exitCode: code }); };
  const response = result => new Response(JSON.stringify({ result }));
  function command(cmd) {
    const [op, key, value] = cmd;
    if (op === 'SET') { values.set(key, value); return 'OK'; }
    if (op === 'GET') return values.get(key) ?? null;
    if (op === 'EXPIRE' || op === 'EXISTS') return values.has(key) ? 1 : 0;
    if (op === 'DEL') return Number(values.delete(key));
    if (op === 'EVAL') return 1;
    throw new Error(`Unexpected Redis command ${op}`);
  }
  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.hostname === 'redis.fixture') {
      if (state.rejectRead && parsed.pathname === `/get/${encodeURIComponent(SOURCE.key)}`) return new Response('{}', { status: 403 });
      if (parsed.pathname.startsWith('/get/')) return response(values.get(decodeURIComponent(parsed.pathname.slice(5))) ?? null);
      const body = JSON.parse(options.body);
      if (body[0] === 'SET' && body[1] === state.rejectWrite) return new Response(JSON.stringify({ error: 'fixture write rejected' }), { status: 403 });
      if (Array.isArray(body[0])) return new Response(JSON.stringify(body.map(c => ({ result: command(c) }))));
      return response(command(body));
    }
    if (String(url) === sask.SASKALERT_FEED_URL) return new Response(JSON.stringify(state.feed));
    if (state.fail && (!state.failUrl || String(url) === state.failUrl)) return new Response('private upstream body', { status: 503 });
    return new Response(JSON.stringify(cap));
  };
  for (const source of CANADA_ALERT_SOURCES.filter(s => s.province !== 'SK')) {
    values.set(source.key, JSON.stringify({ alerts: [] }));
    values.set(source.metaKey, JSON.stringify({ fetchedAt: NOW, recordCount: 0, sourceState: 'ok' }));
  }
  state.read = key => JSON.parse(values.get(key) ?? 'null');
  state.health = (name, key) => __testing__.classifyKey(name, key, { allowOnDemand: false }, {
    keyStrens: new Map([[key, values.get(key)?.length ?? 0]]), keyErrors: new Map(),
    keyMetaValues: new Map([...values].filter(([key]) => key.startsWith('seed-meta:'))),
    keyMetaErrors: new Map(), now: state.now,
  });
  state.run = async () => {
    try {
      await runSeed('alerts', 'saskalert', SOURCE.key, () => sask.fetchSaskAlerts(), {
        validateFn: sask.validateSaskAlertEnvelope, ttlSeconds: 5400, sourceVersion: 'saskalert-v1',
        declareRecords: sask.declareSaskAlertRecords, zeroIsValid: true, schemaVersion: 1,
        maxStaleMin: 45, contentMeta: sask.saskAlertContentMeta,
        maxContentAgeMin: sask.SASKALERT_MAX_CONTENT_AGE_MIN,
        publishTransform: sask.saskAlertPublishTransform,
        beforePublish: sask.saskAlertBeforePublish,
        afterPublish: async data => {
          const diagnostics = sask.saskAlertAfterPublish(data);
          await rebuildCanadaAlertsUnion({ currentSource: {
            province: 'SK', snapshot: sask.saskAlertPublishTransform(data), metaPatch: diagnostics.freshnessMetaPatch,
          } });
          return diagnostics;
        },
      });
    } catch (error) {
      if (error.exitCode !== undefined) return error.exitCode;
      if (error.code === 'CAP_VERIFICATION_FAILED') return 1;
      throw error;
    }
  };
  try { await fn(state); }
  finally {
    globalThis.fetch = oldFetch; process.exit = oldExit; Date.now = oldNow;
    console.log = oldLog; console.warn = oldWarn; console.error = oldError;
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
    for (const listener of process.rawListeners('SIGTERM')) if (!listeners.has(listener)) process.removeListener('SIGTERM', listener);
  }
}

test('CAP failure retains the active alert and success clocks, then recovers', async () => fixture(async f => {
  assert.equal(await f.run(), 0);
  const previous = f.read(SOURCE.key);
  assert.equal(previous.data.alerts.length, 1);
  const completion = f.read(COMPLETE);
  f.now += 15 * 60_000;
  f.fail = true;
  const exit = await f.run();
  assert.equal(f.read(SOURCE.key).data.alerts.length, 1, 'CAP failure must not publish an empty alert snapshot');
  assert.equal(exit, 1);
  assert.equal(f.read(SOURCE.key)._seed.fetchedAt, NOW);
  assert.equal(f.read(SOURCE.metaKey).fetchedAt, NOW);
  assert.deepEqual(f.read(COMPLETE), completion);
  assert.equal(f.read(SOURCE.metaKey).errorCode, 'CAP_VERIFICATION_FAILED');
  assert.equal(f.read(CANADA_ALERTS_KEY).data.alerts.length, 1);
  assert.equal(f.read('seed-meta:alerts:canada-union').sourceState, 'degraded');
  assert.equal(f.health('canadaAlertsSkSource', SOURCE.key).status, 'SEED_ERROR');
  assert.equal(f.health('canadaAlerts', CANADA_ALERTS_KEY).status, 'SEED_ERROR');
  assert.equal(f.read(SOURCE.metaKey).capFailureReasons.http, 1);
  assert.deepEqual(await readSectionFreshness({ canonicalKey: SOURCE.key, seedMetaKey: SOURCE.metaKey,
    completionMetaKey: COMPLETE }, async key => f.read(key)), { fetchedAt: NOW });
  assert.equal(f.logs.filter(line => line.includes('seed_complete')).length, 1);
  assert.equal(f.logs.some(line => line.includes('private upstream body')), false);
  f.fail = false;
  f.now += 5 * 60_000;
  assert.equal(await f.run(), 0);
  assert.equal(f.read(SOURCE.metaKey).sourceState, 'ok');
  assert.equal(f.read(SOURCE.metaKey).fetchedAt, f.now);
  assert.equal(f.read('seed-meta:alerts:canada-union').sourceState, 'ok');
}));

test('successfully verified empty clears active alerts and records OK_ZERO', async () => fixture(async f => {
  assert.equal(await f.run(), 0);
  f.now += 15 * 60_000;
  f.feed.entries = [];
  assert.equal(await f.run(), 0);
  assert.deepEqual(f.read(SOURCE.key).data.alerts, []);
  assert.equal(f.read(SOURCE.key)._seed.state, 'OK_ZERO');
  assert.equal(f.read(SOURCE.metaKey).fetchedAt, f.now);
  assert.equal(f.read(SOURCE.metaKey).sourceState, 'ok');
  assert.equal(f.read(CANADA_ALERTS_KEY)._seed.state, 'OK_ZERO');
}));

test('partial verification retains failed siblings while serving verified records', async () => fixture(async f => {
  assert.equal(await f.run(), 0);
  f.feed.entries.push({ ...feed.entries[1], identifier: 'new', cap_link: 'https://emergencyalert.saskatchewan.ca/new.json' });
  f.now += 15 * 60_000;
  f.fail = true;
  f.failUrl = feed.entries[1].cap_link;
  assert.equal(await f.run(), 1);
  assert.deepEqual(f.read(SOURCE.key).data.alerts.map(a => a.id).sort(), [
    'sk-saskalert-E746FB63-2A32-48EC-8AAF-D30FFC1CDDE0', 'sk-saskalert-new',
  ]);
  assert.equal(f.read(SOURCE.key)._seed.fetchedAt, NOW);
  assert.equal(f.read(CANADA_ALERTS_KEY).data.alerts.length, 2);
}));

for (const reason of ['expired', 'cancelled', 'stale', 'old-content', 'missing']) {
  test(`does not retain ${reason} last-good data or report unknown zero as OK_ZERO`, async () => fixture(async f => {
    assert.equal(await f.run(), 0);
    const oldCompletion = f.read(COMPLETE);
    const old = f.read(SOURCE.key);
    if (reason === 'expired') {
      old.data.alerts[0].expires = new Date(NOW + 60_000).toISOString();
      f.values.set(SOURCE.key, JSON.stringify(old));
    }
    if (reason === 'missing') f.values.delete(SOURCE.key);
    if (reason === 'old-content') {
      old.data.alerts[0].updatedAt = NOW - 4 * 24 * 60 * 60_000;
      f.values.set(SOURCE.key, JSON.stringify(old));
    }
    if (reason === 'cancelled') {
      f.feed.entries[1].state = 'ended';
      f.feed.entries.push({ ...feed.entries[1], state: 'active', identifier: 'unknown', cap_link: 'https://emergencyalert.saskatchewan.ca/unknown.json' });
      f.values.delete(CANADA_ALERT_SOURCES[0].key);
    }
    f.now += (reason === 'stale' ? 46 : 15) * 60_000;
    f.fail = true;
    assert.equal(await f.run(), 1);
    assert.deepEqual(f.read(SOURCE.key).data.alerts, []);
    assert.equal(f.read(SOURCE.key)._seed.state, 'ERROR');
    assert.equal(f.read(SOURCE.key)._seed.fetchedAt, reason === 'missing' ? 0 : NOW);
    assert.deepEqual(f.read(CANADA_ALERTS_KEY).data.alerts, []);
    assert.notEqual(f.read(CANADA_ALERTS_KEY)._seed.state, 'OK_ZERO');
    assert.deepEqual(f.read(COMPLETE), oldCompletion);
    assert.notEqual(f.health('canadaAlertsSkSource', SOURCE.key).status, 'OK');
  }));
}

for (const failure of ['read', 'write']) {
  test(`Redis ${failure} failure cannot claim retention or completion`, async () => fixture(async f => {
    assert.equal(await f.run(), 0);
    const previous = f.read(SOURCE.key);
    const completion = f.read(COMPLETE);
    f.now += 15 * 60_000;
    f.fail = true;
    if (failure === 'read') f.rejectRead = true;
    else f.rejectWrite = SOURCE.key;
    await assert.rejects(f.run(), /403/);
    assert.deepEqual(f.read(SOURCE.key), previous);
    assert.deepEqual(f.read(COMPLETE), completion);
    assert.equal(f.logs.filter(line => line.includes('seed_complete')).length, 1);
    assert.ok(f.logs.some(line => line.includes('CAP_VERIFICATION_FAILED')));
  }));
}
