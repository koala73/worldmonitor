import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { __testing__ as health } from '../api/health.js';
import { isSourceFailurePendingProblem } from '../scripts/check-seed-freshness.mjs';
import {
  fetchMergedEarthquakes, earthquakesAfterPublish, earthquakesContentMeta, fetchNrcanAtom, NRCAN_ATOM_URL,
} from '../scripts/seismology/nrcan-atom.mjs';

const NOW = Date.parse('2026-09-06T10:00:00Z');
const MIN = 60_000;
process.env.WM_SEED_RETRY_DELAY_MS = '1';
const event = (source, now = NOW) => ({
  id: `${source}:event`, source, magnitude: 5, depthKm: 10,
  location: { latitude: source === 'usgs' ? 0 : 50, longitude: 0 },
  occurredAt: now - MIN, place: source, sourceUrl: 'https://example.test/event',
});
const feed = (source, now = NOW) => ({ earthquakes: [event(source, now)], newestAt: now, oldestAt: now - MIN });
const fail = async () => { throw new TypeError('fetch failed', { cause: new Error('ECONNRESET') }); };
const firstRun = () => fetchMergedEarthquakes({ fetchUsgs: async () => feed('usgs'), fetchNrcan: async () => feed('nrcan'), nowMs: NOW });

function verdict(data, now, overrides = {}, bytes = 1024) {
  const meta = {
    fetchedAt: now, recordCount: data.earthquakes.length,
    ...earthquakesContentMeta(data, now), maxContentAgeMin: 2880,
    ...earthquakesAfterPublish(data)?.freshnessMetaPatch, ...overrides,
  };
  const key = health.BOOTSTRAP_KEYS.earthquakes;
  return health.classifyKey('earthquakes', key, { allowOnDemand: false }, {
    keyStrens: new Map([[key, bytes]]), keyErrors: new Map(), keyMetaErrors: new Map(),
    keyMetaValues: new Map([['seed-meta:seismology:earthquakes', JSON.stringify(meta)]]), now,
  });
}

test('retries a transient provider once before recording a failed run', async () => {
  let calls = 0;
  const data = await fetchMergedEarthquakes({
    fetchUsgs: async () => feed('usgs'),
    fetchNrcan: async () => { if (++calls === 1) return fail(); return feed('nrcan'); },
    nowMs: NOW,
  });
  assert.equal(calls, 2);
  assert.deepEqual(data._failedSources, []);
  assert.equal(data.earthquakes.length, 2);
});

test('first transient miss retains provider events and clock; second run warns; recovery clears', async () => {
  const good = await firstRun();
  let calls = 0;
  const run = (previousSources, nowMs) => fetchMergedEarthquakes({
    fetchUsgs: async () => feed('usgs', nowMs),
    fetchNrcan: async () => { calls++; return fail(); }, previousSources, nowMs,
  });
  const first = await run(good._providerSnapshots, NOW + 5 * MIN);
  assert.equal(calls, 2);
  assert.deepEqual(first.earthquakes.map(e => e.source), ['usgs', 'nrcan']);
  assert.equal(first._nrcanNewestAt, NOW);
  assert.equal(first._providerSnapshots.nrcan.fetchedAt, NOW);
  assert.equal(earthquakesContentMeta(first).newestItemAt, NOW);
  const pending = verdict(first, NOW + 5 * MIN);
  assert.equal(pending.status, 'SEED_ERROR', 'diagnosis remains visible');
  assert.equal(health.healthStatusBucket(pending, NOW + 5 * MIN), 'ok');
  assert.equal(pending.sourceFailurePendingUntil, new Date(NOW + 15 * MIN).toISOString());
  assert.equal(isSourceFailurePendingProblem(pending, NOW + 5 * MIN), true);
  const compact = health.healthResponseBody({ status: 'HEALTHY', summary: { pending: 1 }, checkedAt: new Date(NOW + 5 * MIN).toISOString(), checks: { earthquakes: pending } }, true);
  assert.deepEqual(compact.pending, { earthquakes: pending });
  assert.equal(health.snapshotTtlSeconds(compact, NOW + 15 * MIN - 20_000), 20);
  assert.equal(health.hasExpiredActivationGrace(compact, NOW + 15 * MIN), true);
  assert.equal(health.healthStatusBucket(pending, NOW + 15 * MIN), 'warn', 'expires without another run');
  assert.equal(health.healthStatusBucket(verdict(first, NOW + 5 * MIN, {}, 0), NOW + 5 * MIN), 'crit');

  const second = await run(first._providerSnapshots, NOW + 10 * MIN);
  assert.equal(second._providerSnapshots.nrcan.fetchedAt, NOW);
  assert.equal(health.healthStatusBucket(verdict(second, NOW + 10 * MIN), NOW + 10 * MIN), 'warn');
  const recovered = await fetchMergedEarthquakes({
    fetchUsgs: async () => feed('usgs', NOW + 15 * MIN), fetchNrcan: async () => feed('nrcan', NOW + 15 * MIN),
    previousSources: second._providerSnapshots, nowMs: NOW + 15 * MIN,
  });
  assert.deepEqual(recovered._failedSources, []);
  assert.equal(recovered._providerSnapshots.nrcan.consecutiveFailures, 0);
  assert.equal(verdict(recovered, NOW + 15 * MIN).status, 'OK');
});

test('missing, malformed, future, or expired provider coverage never gets pending', async () => {
  const good = await firstRun();
  for (const previousSources of [
    undefined,
    { ...good._providerSnapshots, nrcan: null },
    { ...good._providerSnapshots, nrcan: { ...good._providerSnapshots?.nrcan, fetchedAt: NOW + 6 * MIN } },
    { ...good._providerSnapshots, nrcan: { ...good._providerSnapshots?.nrcan, fetchedAt: NOW - 25 * MIN } },
    { ...good._providerSnapshots, nrcan: { ...good._providerSnapshots?.nrcan, newestAt: NOW - 3 * 1440 * MIN } },
    { ...good._providerSnapshots, nrcan: { ...good._providerSnapshots?.nrcan, earthquakes: [{}] } },
  ]) {
    const data = await fetchMergedEarthquakes({ fetchUsgs: async () => feed('usgs'), fetchNrcan: fail, previousSources, nowMs: NOW + 5 * MIN });
    assert.equal(data.earthquakes.length, 1);
    const failed = verdict(data, NOW + 5 * MIN);
    assert.equal(health.healthStatusBucket(failed, NOW + 5 * MIN), 'warn');
    assert.equal(failed.sourceFailurePendingUntil, undefined);
  }
});

test('verified quiet NRCan coverage is retained and different provider failures do not combine streaks', async () => {
  const good = await fetchMergedEarthquakes({ fetchUsgs: async () => feed('usgs'), fetchNrcan: async () => ({ ...feed('nrcan'), earthquakes: [] }), nowMs: NOW });
  const first = await fetchMergedEarthquakes({ fetchUsgs: async () => feed('usgs'), fetchNrcan: fail, previousSources: good._providerSnapshots, nowMs: NOW + 5 * MIN });
  assert.equal(first.earthquakes.length, 1);
  assert.equal(health.healthStatusBucket(verdict(first, NOW + 5 * MIN), NOW + 5 * MIN), 'ok');
  const different = await fetchMergedEarthquakes({ fetchUsgs: fail, fetchNrcan: async () => feed('nrcan', NOW + 10 * MIN), previousSources: first._providerSnapshots, nowMs: NOW + 10 * MIN });
  assert.equal(different._providerSnapshots.usgs.consecutiveFailures, 1);
  assert.equal(different._providerSnapshots.nrcan.consecutiveFailures, 0);
  assert.equal(health.healthStatusBucket(verdict(different, NOW + 10 * MIN), NOW + 10 * MIN), 'ok');
});

test('both exhausted providers do not trigger outer runSeed retries when there is no retained data', async () => {
  let calls = 0;
  const failing = async () => { calls++; return fail(); };
  await assert.rejects(fetchMergedEarthquakes({ fetchUsgs: failing, fetchNrcan: failing, nowMs: NOW }), err => err.nonRetryable === true);
  assert.equal(calls, 4);
});

test('both provider failures retain bounded coverage, not an unlimited fallback', async () => {
  const good = await firstRun();
  const first = await fetchMergedEarthquakes({ fetchUsgs: fail, fetchNrcan: fail, previousSources: good._providerSnapshots, nowMs: NOW + 5 * MIN });
  assert.equal(first.earthquakes.length, 2);
  assert.equal(health.healthStatusBucket(verdict(first, NOW + 5 * MIN), NOW + 5 * MIN), 'ok');
  const second = await fetchMergedEarthquakes({ fetchUsgs: fail, fetchNrcan: fail, previousSources: first._providerSnapshots, nowMs: NOW + 10 * MIN });
  assert.equal(health.healthStatusBucket(verdict(second, NOW + 10 * MIN), NOW + 10 * MIN), 'warn');
  await assert.rejects(fetchMergedEarthquakes({ fetchUsgs: fail, fetchNrcan: fail, previousSources: second._providerSnapshots, nowMs: NOW + 30 * MIN }), /All earthquake upstreams failed/);
});

test('real NRCan transport retries 503 but not permanent HTTP, unsafe hosts, oversized or malformed pages', async () => {
  const good = await firstRun();
  for (const scenario of ['503', '403', '429-long', 'oversized', 'malformed', 'host']) {
    let calls = 0;
    const data = await fetchMergedEarthquakes({
      fetchUsgs: async () => feed('usgs'),
      fetchNrcan: () => fetchNrcanAtom({
        url: scenario === 'host' ? 'https://untrusted.test/feed' : NRCAN_ATOM_URL,
        fetchFn: async (_url, init) => {
          calls++;
          assert.equal(init.redirect, 'error');
          assert.ok(init.signal instanceof AbortSignal);
          assert.ok(init.headers['User-Agent']);
          if (scenario === '503' && calls === 1) return new Response('', { status: 503 });
          if (scenario === '403') return new Response('', { status: 403 });
          if (scenario === '429-long') return new Response('', { status: 429, headers: { 'Retry-After': '60' } });
          if (scenario === 'oversized') return new Response('x', { headers: { 'content-length': '2000000' } });
          if (scenario === 'malformed') return new Response('<html>bad gateway</html>');
          return new Response(`<feed><updated>${new Date(NOW).toISOString()}</updated></feed>`);
        },
      }),
      previousSources: good._providerSnapshots, nowMs: NOW + 5 * MIN,
    });
    assert.equal(calls, scenario === 'host' ? 0 : scenario === '503' ? 2 : 1, scenario);
    assert.equal(health.healthStatusBucket(verdict(data, NOW + 5 * MIN), NOW + 5 * MIN), scenario === '503' ? 'ok' : 'warn', scenario);
  }
});

test('pending ends at the provider deadline and cannot hide absent clocks, stale content, or missing data', async () => {
  const good = await firstRun();
  const first = await fetchMergedEarthquakes({ fetchUsgs: async () => feed('usgs', NOW + 29 * MIN), fetchNrcan: fail, previousSources: good._providerSnapshots, nowMs: NOW + 29 * MIN });
  const entry = verdict(first, NOW + 29 * MIN);
  assert.equal(entry.sourceFailurePendingUntil, new Date(NOW + 30 * MIN).toISOString());
  for (const overrides of [
    { lastSourceSuccessAt: null }, { lastSourceSuccessAt: NOW + 30 * MIN },
    { firstSourceFailureAt: null }, { lastSourceAttemptAt: null },
    { newestItemAt: NOW - 3 * 1440 * MIN }, { consecutiveSourceFailures: 2 },
  ]) {
    assert.notEqual(health.healthStatusBucket(verdict(first, NOW + 29 * MIN, overrides), NOW + 29 * MIN), 'ok');
  }
  assert.equal(isSourceFailurePendingProblem({ ...entry, sourceFailurePendingUntil: new Date(NOW + 60 * MIN).toISOString() }, NOW + 29 * MIN), false);
});

// Exercise the actual entrypoint and runSeed writes in separate cron processes.
// Every fetch is intercepted; unknown requests fail rather than reaching a network.
async function seedProcess(initial, now, nrcanMode, failStateWrite = false) {
  Date.now = () => now;
  const store = new Map(initial);
  const calls = { usgs: 0, nrcan: 0 };
  const redis = command => {
    const [name, key, value] = command;
    if (name === 'SET') { store.set(key, value); return 'OK'; }
    if (name === 'GET') return store.get(key) ?? null;
    if (name === 'DEL') return Number(store.delete(key));
    if (name === 'EXPIRE' || name === 'EVAL') return 1;
    throw new Error(`unexpected Redis command ${name}`);
  };
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith('https://redis.earthquake.test/get/')) return Response.json({ result: store.get(decodeURIComponent(url.split('/get/')[1])) ?? null });
    if (url === 'https://redis.earthquake.test' || url === 'https://redis.earthquake.test/pipeline') {
      const body = JSON.parse(init.body);
      if (failStateWrite && body[0] === 'SET' && body[1] === 'seismology:earthquakes:providers:v1') return new Response('', { status: 403 });
      return Response.json(Array.isArray(body[0]) ? body.map(command => ({ result: redis(command) })) : { result: redis(body) });
    }
    if (url === 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_week.geojson') {
      calls.usgs++;
      // Verify that the real USGS path also gets the bounded transient retry.
      if (calls.usgs === 1) return new Response('', { status: 503 });
      return Response.json({ metadata: { generated: now }, features: [{ id: 'usgs-event', properties: { mag: 5, time: now - 60000, place: 'USGS' }, geometry: { coordinates: [0, 0, 10] } }] });
    }
    if (url === 'https://www.earthquakescanada.nrcan.gc.ca/cache/earthquakes/canada-en.atom') {
      calls.nrcan++;
      if (nrcanMode === 'fail') return new Response('', { status: 503 });
      const date = new Date(now - 60000).toISOString().replace('T', ' ').replace('.000Z', '');
      return new Response(`<feed><updated>${new Date(now).toISOString()}</updated><entry><title>${date} UTC: M5.0 Canada</title><id>https://www.earthquakescanada.nrcan.gc.ca/?eventid=fixture</id><georss:point>50 -120</georss:point></entry></feed>`);
    }
    throw new Error(`unexpected network request ${url}`);
  };
  process.on('exit', () => console.log('FIXTURE_RESULT=' + JSON.stringify({ store: [...store], calls })));
  await import(new URL('../scripts/seed-earthquakes.mjs', process.env.TEST_MODULE_URL));
}

test('real seeder persists provider history across cron processes and publishes matching health metadata', () => {
  let previous = [];
  for (const [index, mode] of ['ok', 'fail', 'fail', 'ok', 'state-write-fail'].entries()) {
    const now = NOW + index * 5 * MIN;
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', `(${seedProcess.toString()})(${JSON.stringify(previous)}, ${now}, ${JSON.stringify(mode === 'state-write-fail' ? 'fail' : mode)}, ${mode === 'state-write-fail'})`], {
      encoding: 'utf8', timeout: 10_000,
      env: {
        PATH: process.env.PATH, NODE_TEST_CONTEXT: 'child', WM_SEED_RETRY_DELAY_MS: '1',
        WM_SEED_ENV_FILE: '/dev/null', TEST_MODULE_URL: import.meta.url,
        UPSTASH_REDIS_REST_URL: 'https://redis.earthquake.test', UPSTASH_REDIS_REST_TOKEN: 'fixture-only',
      },
    });
    assert.equal(result.status, mode === 'state-write-fail' ? 1 : 0, result.stdout + result.stderr);
    const captured = JSON.parse(result.stdout.split('FIXTURE_RESULT=')[1].trim());
    if (mode === 'state-write-fail') {
      for (const key of ['seismology:earthquakes:v1', 'seed-meta:seismology:earthquakes', 'seismology:earthquakes:providers:v1']) {
        assert.equal(new Map(captured.store).get(key), new Map(previous).get(key), `${key} must remain unchanged when recovery-state persistence fails`);
      }
      continue;
    }
    previous = captured.store;
    const store = new Map(previous);
    const canonical = JSON.parse(store.get('seismology:earthquakes:v1'));
    const meta = JSON.parse(store.get('seed-meta:seismology:earthquakes'));
    const providers = JSON.parse(store.get('seismology:earthquakes:providers:v1'));
    assert.equal(canonical.data.earthquakes.length, 2);
    assert.deepEqual(Object.keys(canonical.data), ['earthquakes'], 'internal provider records stay out of the API');
    assert.equal(captured.calls.usgs, 2);
    assert.equal(captured.calls.nrcan, mode === 'ok' ? 1 : 2);
    assert.match(result.stdout, mode === 'ok' ? /"state":"OK"/ : /"state":"DEGRADED"/);
    assert.equal(providers.nrcan.fetchedAt, mode === 'ok' ? now : NOW);
    assert.equal(meta.newestItemAt, mode === 'ok' ? now : NOW);
    const key = health.BOOTSTRAP_KEYS.earthquakes;
    const entry = health.classifyKey('earthquakes', key, { allowOnDemand: false }, {
      keyStrens: new Map([[key, store.get(key).length]]), keyErrors: new Map(), keyMetaErrors: new Map(),
      keyMetaValues: new Map([['seed-meta:seismology:earthquakes', JSON.stringify(meta)]]), now,
    });
    assert.equal(health.healthStatusBucket(entry, now), index === 2 ? 'warn' : 'ok');
  }
});
