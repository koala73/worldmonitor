import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import {
  fetchCwfisFires,
  CWFIS_ACTIVE_LAYER,
  CWFIS_RETAIN_MS,
  CWFIS_SNAPSHOT_TTL_SECONDS,
  CWFIS_WARN_AFTER_CONSECUTIVE_FAILURES,
} from '../scripts/wildfire/cwfis-wfs.mjs';
import { mergeWildfireSourcesWithBc, canadianWildfireAfterPublish } from '../scripts/wildfire/bc-fire-points.mjs';
import { __testing__ as health } from '../api/health.js';

process.env.WM_SEED_RETRY_DELAY_MS = '1';
const NOW = Date.parse('2026-09-07T06:20:00Z');
const MIN = 60_000;
const active = JSON.parse(readFileSync(new URL('fixtures/wildfire/cwfis-national-activefires.json', import.meta.url), 'utf8'));
const bc = JSON.parse(readFileSync(new URL('fixtures/wildfire/bc-current-fire-points.json', import.meta.url), 'utf8'));
const empty = { type: 'FeatureCollection', features: [], numberMatched: 0, numberReturned: 0 };
const goodFetch = async (url) => Response.json(new URL(url).searchParams.get('typeNames') === CWFIS_ACTIVE_LAYER
  ? { ...active, numberMatched: active.features.length, numberReturned: active.features.length, links: [] } : empty);
const fail = () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }) }); };

async function run({ previousSnapshot, nowMs = NOW, fetchFn = goodFetch } = {}) {
  return mergeWildfireSourcesWithBc({
    fetchFirms: async () => ({ fireDetections: [{ id: 'firms:fixture', source: 'firms' }], _firmsFulfilledCalls: 27, _firmsFailedCalls: 0 }),
    fetchCwfis: () => fetchCwfisFires({ previousSnapshot, nowMs, fetchFn }),
    fetchBcWildfire: async () => ({ fireDetections: [] }),
  });
}

function verdict(data, now = NOW, metaOverrides = {}) {
  const key = health.BOOTSTRAP_KEYS.wildfires;
  const meta = { fetchedAt: now, recordCount: data.fireDetections.length,
    ...canadianWildfireAfterPublish(data).freshnessMetaPatch, ...metaOverrides };
  return health.classifyKey('wildfires', key, { allowOnDemand: false }, {
    keyStrens: new Map([[key, 1000]]), keyErrors: new Map(), keyMetaErrors: new Map(),
    keyMetaValues: new Map([[health.SEED_META.wildfires.key, JSON.stringify(meta)]]), now,
  });
}

test('CWFIS retries the failed active request once without replaying prescribed', async () => {
  const calls = { active: 0, prescribed: 0 };
  const data = await run({ fetchFn: async (url) => {
    const key = new URL(url).searchParams.get('typeNames') === CWFIS_ACTIVE_LAYER ? 'active' : 'prescribed';
    if (++calls[key] === 1 && key === 'active') return fail();
    return goodFetch(url);
  } });
  assert.deepEqual(calls, { active: 2, prescribed: 1 });
  assert.equal(data._cwfisState, 'ok');
  assert.equal(verdict(data).status, 'OK');
});

test('CWFIS retains source rows through two transient misses, warns on the third, and recovers', async () => {
  const good = await run();
  assert.equal(good._cwfisSnapshot.fetchedAt, NOW);
  const first = await run({ previousSnapshot: good._cwfisSnapshot, nowMs: NOW + 10 * MIN, fetchFn: fail });
  assert.equal(first._cwfisCount, good._cwfisCount);
  assert.equal(first._cwfisSnapshot.fetchedAt, NOW);
  assert.equal(first._cwfisSnapshot.consecutiveFailures, 1);
  assert.equal(first.fireDetections.some(row => row.source === 'firms'), true);
  const entry = verdict(first, NOW + 10 * MIN);
  assert.equal(entry.sourceFailurePendingUntil, new Date(NOW + 180 * MIN).toISOString());
  assert.equal(verdict(first, NOW + 13 * MIN).sourceFailurePendingUntil, entry.sourceFailurePendingUntil);
  assert.equal(verdict(first, NOW + 180 * MIN).sourceFailurePendingUntil, undefined);
  const second = await run({ previousSnapshot: first._cwfisSnapshot, nowMs: NOW + 20 * MIN, fetchFn: fail });
  assert.equal(second._cwfisSnapshot.consecutiveFailures, 2);
  assert.equal(second._cwfisSnapshot.firstFailureAt, NOW + 10 * MIN);
  const secondEntry = verdict(second, NOW + 20 * MIN);
  assert.equal(secondEntry.status, 'SEED_ERROR');
  assert.equal(secondEntry.sourceFailurePendingUntil, entry.sourceFailurePendingUntil);
  assert.equal(health.healthStatusBucket(secondEntry, NOW + 20 * MIN), 'ok');
  const third = await run({ previousSnapshot: second._cwfisSnapshot, nowMs: NOW + 30 * MIN, fetchFn: fail });
  assert.equal(third._cwfisSnapshot.consecutiveFailures, 3);
  assert.equal(verdict(third, NOW + 30 * MIN).status, 'SEED_ERROR');
  assert.equal(verdict(third, NOW + 30 * MIN).sourceFailurePendingUntil, undefined);
  const recovered = await run({ previousSnapshot: third._cwfisSnapshot, nowMs: NOW + 31 * MIN });
  assert.equal(recovered._cwfisSnapshot.consecutiveFailures, 0);
  assert.equal(recovered._cwfisSnapshot.fetchedAt, NOW + 31 * MIN);
  assert.equal(verdict(recovered, NOW + 31 * MIN).status, 'OK');
});

test('CWFIS missing, expired, malformed, future or unknown-streak snapshots earn no grace', async () => {
  const good = await run();
  for (const previousSnapshot of [
    null, {}, { ...good._cwfisSnapshot, fetchedAt: NOW - 170 * MIN },
    { ...good._cwfisSnapshot, fetchedAt: NOW + 11 * MIN },
    { ...good._cwfisSnapshot, fireDetections: [{}] },
    { ...good._cwfisSnapshot, consecutiveFailures: undefined },
    { ...good._cwfisSnapshot, errorCode: 'UNKNOWN', consecutiveFailures: 1, firstFailureAt: NOW },
  ]) {
    const data = await run({ previousSnapshot, nowMs: NOW + 10 * MIN, fetchFn: fail });
    const entry = verdict(data, NOW + 10 * MIN);
    assert.equal(entry.status, 'SEED_ERROR');
    assert.equal(entry.sourceFailurePendingUntil, undefined);
  }
});

test('CWFIS retention expires at three hours even during a pending episode', async () => {
  const good = await run();
  const data = await run({ previousSnapshot: good._cwfisSnapshot, nowMs: NOW + 179 * MIN, fetchFn: fail });
  assert.equal(verdict(data, NOW + 179 * MIN).sourceFailurePendingUntil, new Date(NOW + 180 * MIN).toISOString());
  assert.equal(verdict(data, NOW + 180 * MIN).sourceFailurePendingUntil, undefined);
  const expired = await run({ previousSnapshot: data._cwfisSnapshot, nowMs: NOW + 180 * MIN, fetchFn: fail });
  assert.equal(expired._cwfisCount, 0);
});

test('the persisted CWFIS snapshot outlives its three-hour retention window', () => {
  assert.equal(CWFIS_RETAIN_MS, 3 * 60 * MIN);
  assert.ok(CWFIS_SNAPSHOT_TTL_SECONDS * 1000 > CWFIS_RETAIN_MS);
  const policy = health.SEED_META.wildfires.sourceFailure.find(candidate =>
    candidate.failureCodePattern.test('CWFIS_SOURCE_FAILED'));
  assert.equal(policy.warnAfterConsecutive, CWFIS_WARN_AFTER_CONSECUTIVE_FAILURES);
  assert.equal(policy.maxPendingMin * MIN, CWFIS_RETAIN_MS);
});

test('a complete empty CWFIS response clears previous fires and remains a valid last-good snapshot', async () => {
  const good = await run();
  const zero = await run({ previousSnapshot: good._cwfisSnapshot, nowMs: NOW + MIN, fetchFn: async () => Response.json(empty) });
  assert.equal(zero._cwfisCount, 0);
  assert.deepEqual(zero._cwfisSnapshot.fireDetections, []);
  assert.equal(verdict(zero, NOW + MIN).status, 'OK');
  const failed = await run({ previousSnapshot: zero._cwfisSnapshot, nowMs: NOW + 10 * MIN, fetchFn: fail });
  assert.equal(failed._cwfisCount, 0);
  assert.equal(failed._cwfisSnapshot.fetchedAt, NOW + MIN);
  assert.ok(verdict(failed, NOW + 10 * MIN).sourceFailurePendingUntil);
});

test('CWFIS contract failures do not retry or receive pending even with recent source data', async () => {
  const good = await run();
  let calls = 0;
  const data = await run({ previousSnapshot: good._cwfisSnapshot, nowMs: NOW + MIN, fetchFn: async () => {
    calls++;
    return Response.json({ broken: true });
  } });
  assert.equal(calls, 2);
  assert.equal(verdict(data, NOW + MIN).status, 'SEED_ERROR');
  assert.equal(verdict(data, NOW + MIN).sourceFailurePendingUntil, undefined);
});

test('nonempty CWFIS pages with no usable rows are not accepted as a successful empty source', async () => {
  const data = await run({ fetchFn: async () => Response.json({
    type: 'FeatureCollection', features: [{ type: 'Feature', properties: {} }], numberMatched: 1, numberReturned: 1,
  }) });
  assert.equal(data._cwfisState, 'failed');
  assert.equal(verdict(data).status, 'SEED_ERROR');
});

test('exhausted wildfire sources prevent an outer retry of the entire source batch', async () => {
  await assert.rejects(mergeWildfireSourcesWithBc({
    fetchFirms: async () => fail(), fetchCwfis: async () => fail(), fetchBcWildfire: async () => fail(),
  }), error => error.nonRetryable === true);
});

test('exhausted CWFIS transport errors keep their bounded native cause and attempt count', async () => {
  let calls = 0;
  await assert.rejects(fetchCwfisFires({ fetchFn: async () => { calls++; return fail(); } }), error => {
    assert.equal(error.cause?.cause?.code, 'ECONNRESET');
    assert.equal(error.cause?.attempts, 2);
    return true;
  });
  assert.equal(calls, 4);
});

test('CWFIS retries transient HTTP failures only and keeps its request timeout', async () => {
  const good = await run();
  for (const [status, attempts] of [[503, 2], [429, 2], [403, 1]]) {
    let calls = 0;
    const data = await run({ previousSnapshot: good._cwfisSnapshot, nowMs: NOW + MIN, fetchFn: async (url, init) => {
      assert.equal(init.redirect, 'error');
      assert.ok(init.signal instanceof AbortSignal);
      if (new URL(url).searchParams.get('typeNames') !== CWFIS_ACTIVE_LAYER) return goodFetch(url);
      calls++;
      return new Response('', { status });
    } });
    assert.equal(calls, attempts);
    assert.equal(verdict(data, NOW + MIN).status, 'SEED_ERROR');
    assert.equal(Boolean(verdict(data, NOW + MIN).sourceFailurePendingUntil), status !== 403);
  }
});

test('a prescribed-layer failure cannot replace the complete last-good snapshot or receive grace', async () => {
  const good = await run();
  const partial = await run({ previousSnapshot: good._cwfisSnapshot, nowMs: NOW + MIN, fetchFn: async (url) => {
    if (new URL(url).searchParams.get('typeNames') !== CWFIS_ACTIVE_LAYER) return fail();
    return goodFetch(url);
  } });
  assert.equal(partial._cwfisState, 'degraded');
  assert.equal(partial._cwfisSnapshot.fetchedAt, NOW);
  assert.deepEqual(partial._cwfisSnapshot.fireDetections, good._cwfisSnapshot.fireDetections);
  assert.equal(verdict(partial, NOW + MIN).errorCode, 'CWFIS_PRESCRIBED_FAILED');
  assert.equal(verdict(partial, NOW + MIN).sourceFailurePendingUntil, undefined);
});

test('a transient Retry-After beyond the request budget keeps first-failure grace without another request', async () => {
  const good = await run();
  let calls = 0;
  const data = await run({ previousSnapshot: good._cwfisSnapshot, nowMs: NOW + MIN, fetchFn: async (url) => {
    if (new URL(url).searchParams.get('typeNames') !== CWFIS_ACTIVE_LAYER) return goodFetch(url);
    calls++;
    return new Response('', { status: 429, headers: { 'Retry-After': '60' } });
  } });
  assert.equal(calls, 1);
  assert.ok(verdict(data, NOW + 3 * MIN).sourceFailurePendingUntil);
});

function runSeedFixture(initial, now, mode, activeFixture = active) {
  const result = spawnSync(process.execPath, [...(mode.startsWith('bc-') ? ['--import', 'tsx'] : []), '--input-type=module', '--eval', `(${seedProcess.toString()})(${JSON.stringify(initial)}, ${now}, ${JSON.stringify(mode)}, ${JSON.stringify(activeFixture)}, ${JSON.stringify(bc)})`], {
    encoding: 'utf8', timeout: 10_000,
    env: {
      PATH: process.env.PATH, NODE_TEST_CONTEXT: 'child', WM_SEED_RETRY_DELAY_MS: '1',
      WM_SEED_ENV_FILE: '/dev/null', TEST_MODULE_URL: import.meta.url, NASA_FIRMS_API_KEY: 'fixture-only',
      UPSTASH_REDIS_REST_URL: 'https://redis.cwfis.test', UPSTASH_REDIS_REST_TOKEN: 'fixture-only',
    },
  });
  const output = result.stdout + result.stderr;
  assert.ok(result.stdout.includes('FIXTURE_RESULT='), output);
  return { ...JSON.parse(result.stdout.split('FIXTURE_RESULT=')[1].trim()), status: result.status, output };
}

async function seedProcess(initial, now, mode, activeFixture, bcFixture) {
  let clock = now;
  Date.now = () => clock;
  const timer = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...args) => timer(fn, ms === 6000 ? 0 : ms, ...args);
  const store = new Map(initial);
  const expiries = new Map();
  const calls = { firms: 0, active: 0, prescribed: 0 };
  const redis = ([command, key, value, expiryMode, ttlSeconds]) => {
    if (command === 'SET') {
      store.set(key, value);
      if (expiryMode === 'EX') expiries.set(key, ttlSeconds);
      return 'OK';
    }
    if (command === 'GET') return store.get(key) ?? null;
    if (command === 'DEL') return Number(store.delete(key));
    if (command === 'EXPIRE' || command === 'EVAL') return 1;
    throw new Error(`unexpected Redis command ${command}`);
  };
  globalThis.fetch = async (input, init) => {
    const url = new URL(input);
    if (url.origin === 'https://redis.cwfis.test') {
      if (mode === 'bc-read-fail' && decodeURIComponent(url.pathname) === '/get/wildfire:bc-source:v1') return new Response('', { status: 403 });
      if (url.pathname.startsWith('/get/')) return Response.json({ result: store.get(decodeURIComponent(url.pathname.slice(5))) ?? null });
      const body = JSON.parse(init.body);
      if (mode.endsWith('state-write-fail') && body[0] === 'SET' && body[1] === 'wildfire:cwfis-source:v1') return new Response('', { status: 403 });
      if (mode.endsWith('meta-write-fail') && body[0] === 'SET' && body[1] === 'seed-meta:wildfire:cwfis-source') return new Response('', { status: 403 });
      if ((mode === 'bc-write-fail' && body[1] === 'wildfire:bc-source:v1'
        || mode === 'bc-meta-fail' && body[1] === 'seed-meta:wildfire:bc-source') && body[0] === 'SET') return new Response('', { status: 403 });
      return Response.json(Array.isArray(body[0]) ? body.map(command => ({ result: redis(command) })) : { result: redis(body) });
    }
    if (url.hostname === 'firms.modaps.eosdis.nasa.gov') {
      calls.firms++;
      if (calls.firms === 27) clock += 3 * 60_000;
      if (mode.startsWith('all-sources-fail') || (mode === 'firms-partial' && calls.firms === 1)) return new Response('', { status: 403 });
      const iso = new Date(now - 60_000).toISOString();
      return new Response(`latitude,longitude,acq_date,acq_time,confidence,bright_ti4,frp\n49,-120,${iso.slice(0, 10)},${iso.slice(11, 16).replace(':', '')},h,340,12`);
    }
    if (url.hostname === 'geoserver.cwfif.nrcan.gc.ca') {
      const layer = url.searchParams.get('typeNames').endsWith('activefires') ? 'active' : 'prescribed';
      calls[layer]++;
      if (layer === 'active' && mode !== 'ok' && !mode.startsWith('bc-')) throw new TypeError('fetch failed', { cause: Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }) });
      return Response.json(layer === 'active'
        ? { ...activeFixture, numberMatched: activeFixture.features.length, numberReturned: activeFixture.features.length, links: [] }
        : { type: 'FeatureCollection', features: [], numberMatched: 0, numberReturned: 0 });
    }
    if (url.hostname === 'openmaps.gov.bc.ca') {
      if (mode.startsWith('bc-')) {
        if (url.pathname.includes('/kml/')) return new Response('<kml/>');
        calls.bc = (calls.bc || 0) + 1;
        if (mode === 'bc-fail' || mode === 'bc-read-fail') return new Response('<ows:ExceptionReport/>', { status: 400 });
        if (mode === 'bc-empty-fail' && calls.bc > 1) return new Response('', { status: 400 });
        if (mode !== 'bc-empty' && !(mode.startsWith('bc-empty-') && calls.bc === 1)) return Response.json(bcFixture);
      }
      return mode.startsWith('all-sources-fail') ? new Response('', { status: 403 })
        : Response.json({ type: 'FeatureCollection', features: [], numberMatched: 0, numberReturned: 0 });
    }
    throw new Error(`unexpected network request ${url}`);
  };
  let reader;
  if (mode.startsWith('bc-')) {
    const exit = process.exit;
    process.exit = async code => {
      if (code === 0) {
        const { listFireDetections } = await import(new URL('../server/worldmonitor/wildfire/v1/list-fire-detections.ts', process.env.TEST_MODULE_URL));
        reader = await listFireDetections({}, {});
      }
      exit(code);
    };
  }
  process.on('exit', () => console.log('FIXTURE_RESULT=' + JSON.stringify({ store: [...store], expiries: [...expiries], calls, reader })));
  await import(new URL('../scripts/seed-fire-detections.mjs', process.env.TEST_MODULE_URL));
}

test('BC failures and unconfirmed empty results keep source coverage through the real seeder and RPC reader', () => {
  let previous = [];
  let goodSnapshot;
  for (const [minute, mode] of [[0, 'bc-ok'], [10, 'bc-fail'], [20, 'bc-fail'], [30, 'bc-empty-fail'], [40, 'bc-empty-fail'], [120, 'bc-fail'], [130, 'bc-ok'], [135, 'bc-read-fail'], [140, 'bc-write-fail'], [145, 'bc-meta-fail'], [150, 'bc-empty-recovered'], [160, 'bc-empty'], [170, 'bc-fail']]) {
    const now = NOW + minute * MIN;
    const captured = runSeedFixture(previous, now, mode);
    const persistenceFailed = ['bc-read-fail', 'bc-write-fail', 'bc-meta-fail'].includes(mode);
    assert.equal(captured.status, persistenceFailed ? 1 : 0, captured.output);
    const store = new Map(captured.store);
    if (persistenceFailed) {
      for (const key of ['wildfire:fires:v1', 'wildfire:fires-bootstrap:v1']) {
        assert.equal(store.get(key), new Map(previous).get(key));
      }
      assert.equal(captured.calls.bc || 0, mode === 'bc-read-fail' ? 0 : 1);
      continue;
    }
    const snapshot = JSON.parse(store.get('wildfire:bc-source:v1'));
    const sourceMeta = JSON.parse(store.get('seed-meta:wildfire:bc-source'));
    assert.equal(sourceMeta.fetchedAt, snapshot.fetchedAt);
    assert.equal(sourceMeta.lastAttemptAt, now);
    assert.equal(sourceMeta.errorCode, snapshot.errorCode);
    assert.equal(sourceMeta.recordCount, snapshot.fireDetections.length);
    assert.equal(sourceMeta.sourceState, snapshot.errorCode ? 'degraded' : 'ok');
    if (mode === 'bc-ok' || mode === 'bc-empty' || mode === 'bc-empty-recovered') goodSnapshot = snapshot;
    const sourceFailed = mode === 'bc-fail' || mode === 'bc-empty-fail';
    const expired = minute === 120;
    assert.equal(snapshot.fireDetections.length, expired || minute >= 160 ? 0 : 4);
    assert.equal(snapshot.fetchedAt, expired ? null : goodSnapshot.fetchedAt);
    assert.equal(snapshot.lastAttemptAt, now);
    assert.deepEqual(snapshot.fireDetections, expired ? [] : goodSnapshot.fireDetections);
    assert.equal(captured.calls.bc, mode.startsWith('bc-empty') ? 2 : 1, captured.output);
    assert.equal(captured.calls.firms, 27);
    assert.equal(JSON.parse(store.get('wildfire:cwfis-source:v1')).fetchedAt, now);
    for (const key of ['wildfire:fires:v1', 'wildfire:fires-bootstrap:v1']) {
      const payload = JSON.parse(store.get(key)).data;
      assert.equal('_bcSnapshot' in payload, false);
      assert.equal(new Map(captured.expiries).get(key), 7200);
    }
    const canonical = JSON.parse(store.get('wildfire:fires:v1')).data;
    assert.equal(canonical._bcCount, snapshot.fireDetections.length);
    const metaKey = health.SEED_META.wildfires.key;
    const meta = JSON.parse(store.get(metaKey));
    assert.equal(meta.fetchedAt, now + 3 * MIN);
    assert.equal(meta.sourceState, sourceFailed ? 'degraded' : 'ok');
    if (sourceFailed) assert.equal(meta.errorCode, 'BC_WILDFIRE_SOURCE_FAILED');
    const expectedPublic = JSON.parse(store.get('wildfire:fires-bootstrap:v1')).data.fireDetections;
    assert.deepEqual(captured.reader.fireDetections, expectedPublic);
    assert.ok(captured.reader.fireDetections.some(row => row.source === 'firms' && row.detectedAt === now - MIN));
    const retainedBc = captured.reader.fireDetections.filter(row => row.source === 'bc-wildfire');
    const expectedBc = snapshot.fireDetections.filter(row => row.fireNumber === 'C31543');
    assert.deepEqual(retainedBc.map(row => [row.id, row.detectedAt]), expectedBc.map(row => [row.id, row.detectedAt]));
    const enriched = captured.reader.fireDetections.find(row => row.bcFireNumber === 'V10742');
    assert.equal(Boolean(enriched), snapshot.fireDetections.length > 0);
    if (enriched) assert.equal(enriched.bcFireStatus, 'Fire of Note');
    const entry = health.classifyKey('wildfires', health.BOOTSTRAP_KEYS.wildfires, { allowOnDemand: false }, {
      keyStrens: new Map([[health.BOOTSTRAP_KEYS.wildfires, store.get('wildfire:fires:v1').length]]),
      keyErrors: new Map(), keyMetaErrors: new Map(), keyMetaValues: new Map([[metaKey, store.get(metaKey)]]),
      now: now + 3 * MIN,
    });
    assert.equal(entry.status, sourceFailed ? 'SEED_ERROR' : 'OK');
    assert.equal(entry.sourceFailurePendingUntil, undefined);
    previous = captured.store;
  }
});

test('real wildfire seeder persists failure history and keeps canonical/bootstrap coverage across cron processes', () => {
  let previous = [];
  for (const [index, mode] of ['ok', 'fail', 'firms-partial', 'fail', 'ok', 'state-write-fail', 'meta-write-fail'].entries()) {
    const now = NOW + index * 10 * MIN;
    const captured = runSeedFixture(previous, now, mode);
    const persistenceFailure = mode.endsWith('write-fail');
    assert.equal(captured.status, persistenceFailure ? 1 : 0, captured.output);
    const store = new Map(captured.store);
    const key = health.BOOTSTRAP_KEYS.wildfires;
    const bootstrapKey = 'wildfire:fires-bootstrap:v1';
    if (persistenceFailure) {
      for (const target of [key, bootstrapKey]) assert.equal(store.get(target), new Map(previous).get(target));
      assert.equal(captured.calls.active, 2, 'a publish failure must not repeat upstream fetches');
      continue;
    }
    const expiries = new Map(captured.expiries);
    assert.equal(expiries.get('wildfire:cwfis-source:v1'), CWFIS_SNAPSHOT_TTL_SECONDS);
    assert.equal(expiries.get('seed-meta:wildfire:cwfis-source'), CWFIS_SNAPSHOT_TTL_SECONDS);
    if (mode === 'firms-partial') {
      for (const target of [key, bootstrapKey]) assert.equal(store.get(target), new Map(previous).get(target));
      assert.equal(JSON.parse(store.get('wildfire:cwfis-source:v1')).consecutiveFailures, 2);
    }
    previous = captured.store;
    for (const target of [key, bootstrapKey]) {
      const payload = JSON.parse(store.get(target)).data;
      assert.equal('_cwfisSnapshot' in payload, false);
      assert.equal(payload.fireDetections.filter(row => row.source === 'cwfis').length, 2);
    }
    const snapshot = JSON.parse(store.get('wildfire:cwfis-source:v1'));
    const sourceMeta = JSON.parse(store.get('seed-meta:wildfire:cwfis-source'));
    assert.equal(snapshot.fetchedAt, mode === 'ok' ? now : NOW);
    assert.equal(sourceMeta.fetchedAt, snapshot.fetchedAt);
    assert.equal(captured.calls.firms, 27);
    assert.equal(captured.calls.active, mode === 'ok' ? 1 : 2);
    assert.equal(captured.calls.prescribed, 1);
    const entry = health.classifyKey('wildfires', key, { allowOnDemand: false }, {
      keyStrens: new Map([[key, store.get(key).length]]), keyErrors: new Map(), keyMetaErrors: new Map(),
      keyMetaValues: new Map([[health.SEED_META.wildfires.key, store.get(health.SEED_META.wildfires.key)]]), now: now + 3 * MIN,
    });
    assert.equal(health.healthStatusBucket(entry, now + 3 * MIN), index === 2 || index === 3 ? 'warn' : 'ok', `${mode}: ${JSON.stringify(entry)}`);
  }
});

test('an all-source outage preserves the CWFIS streak even when its last-good snapshot is empty', () => {
  const key = health.BOOTSTRAP_KEYS.wildfires;
  const metaKey = health.SEED_META.wildfires.key;
  for (const fixture of [active, empty]) {
    const good = runSeedFixture([], NOW, 'ok', fixture);
    assert.equal(good.status, 0, good.output);
    const initial = new Map(good.store);
    const outage = runSeedFixture(good.store, NOW + 10 * MIN, 'all-sources-fail', fixture);
    assert.equal(outage.status, 0, outage.output);
    const during = new Map(outage.store);
    for (const target of [key, 'wildfire:fires-bootstrap:v1']) assert.equal(during.get(target), initial.get(target));
    assert.equal(JSON.parse(during.get(metaKey)).fetchedAt, JSON.parse(initial.get(metaKey)).fetchedAt);
    const first = JSON.parse(during.get('wildfire:cwfis-source:v1'));
    assert.equal(first.consecutiveFailures, 1);
    assert.equal(first.firstFailureAt, NOW + 10 * MIN);
    assert.equal(first.fetchedAt, NOW);
    assert.deepEqual(outage.calls, { firms: 27, active: 2, prescribed: 1 });

    const next = runSeedFixture(outage.store, NOW + 20 * MIN, 'fail', fixture);
    assert.equal(next.status, 0, next.output);
    const secondStore = new Map(next.store);
    const second = JSON.parse(secondStore.get('wildfire:cwfis-source:v1'));
    assert.equal(second.consecutiveFailures, 2);
    assert.equal(second.firstFailureAt, first.firstFailureAt);
    assert.equal(second.fetchedAt, NOW);
    const pending = health.classifyKey('wildfires', key, { allowOnDemand: false }, {
      keyStrens: new Map([[key, secondStore.get(key).length]]), keyErrors: new Map(), keyMetaErrors: new Map(),
      keyMetaValues: new Map([[metaKey, secondStore.get(metaKey)]]), now: NOW + 23 * MIN,
    });
    assert.equal(pending.status, 'SEED_ERROR');
    assert.ok(pending.sourceFailurePendingUntil);
    assert.equal(health.healthStatusBucket(pending, NOW + 23 * MIN), 'ok');

    const thirdRun = runSeedFixture(next.store, NOW + 30 * MIN, 'fail', fixture);
    assert.equal(thirdRun.status, 0, thirdRun.output);
    const store = new Map(thirdRun.store);
    const third = JSON.parse(store.get('wildfire:cwfis-source:v1'));
    assert.equal(third.consecutiveFailures, 3);
    assert.equal(third.firstFailureAt, first.firstFailureAt);
    assert.equal(third.fetchedAt, NOW);
    const entry = health.classifyKey('wildfires', key, { allowOnDemand: false }, {
      keyStrens: new Map([[key, store.get(key).length]]), keyErrors: new Map(), keyMetaErrors: new Map(),
      keyMetaValues: new Map([[metaKey, store.get(metaKey)]]), now: NOW + 33 * MIN,
    });
    assert.equal(entry.status, 'SEED_ERROR');
    assert.equal(entry.sourceFailurePendingUntil, undefined);
    assert.equal(health.healthStatusBucket(entry, NOW + 33 * MIN), 'warn');
  }
});

test('empty-result snapshot write failures preserve worldwide data without replaying sources', () => {
  const good = runSeedFixture([], NOW, 'ok', empty);
  assert.equal(good.status, 0, good.output);
  const initial = new Map(good.store);
  for (const target of ['state', 'meta']) {
    const failed = runSeedFixture(good.store, NOW + 10 * MIN, `all-sources-fail-${target}-write-fail`, empty);
    assert.equal(failed.status, 75, failed.output);
    const store = new Map(failed.store);
    for (const key of [health.BOOTSTRAP_KEYS.wildfires, 'wildfire:fires-bootstrap:v1', health.SEED_META.wildfires.key]) {
      assert.equal(store.get(key), initial.get(key));
    }
    assert.deepEqual(failed.calls, { firms: 27, active: 2, prescribed: 1 });
  }
});
