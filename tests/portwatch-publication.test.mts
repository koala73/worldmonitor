import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createCountryResolvers } from '../scripts/_country-resolver.mjs';
import { PORTWATCH_CONTENT_FRESHNESS_CADENCE_MINUTES } from '../scripts/_portwatch-content-freshness.mjs';
import { __testing__ } from '../api/health.js';
import { getCountryPortActivity } from '../server/worldmonitor/intelligence/v1/get-country-port-activity';
import { installRedis } from './helpers/fake-upstash-redis.mts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PREFIX = 'supply_chain:portwatch-ports:v1:';
const CANONICAL = `${PREFIX}_countries`;
const META = 'seed-meta:supply_chain:portwatch-ports';
const DAY = 86_400_000;
const NOW = Date.parse('2026-09-10T00:00:00Z');
const countries = [...createCountryResolvers().iso3ToIso2.entries()]
  .sort(([a], [b]) => a.localeCompare(b)).slice(0, 174);

function fixtures() {
  const result: Record<string, any> = {
    [CANONICAL]: countries.slice(0, 168).map(([, iso2]) => iso2),
    [META]: { fetchedAt: NOW - DAY / 2, recordCount: 168, contentFreshness: { preserved: true } },
  };
  for (const [index, [, iso2]] of countries.entries()) {
    result[`${PREFIX}${iso2}`] = {
      iso2, ports: [{ portId: iso2, tankerCalls30d: 12 }],
      fetchedAt: new Date(NOW - DAY).toISOString(),
      cacheWrittenAt: index < 144 ? NOW - 7 * DAY : NOW - DAY,
      contentAsOfChangedAt: NOW - DAY,
      asof: index >= 170 ? '2026-09-09' : '2026-09-08',
    };
  }
  return result;
}

// Execute the real entry point with only HTTP/Redis and the clock substituted.
// A minimal child environment excludes local credentials and proxy transports.
function runProducer(input: Record<string, any>, mode = 'complete', now = NOW, corruptRaw?: string) {
  const code = `
    import { installRedis } from './tests/helpers/fake-upstash-redis.mts';
    const now = ${now};
    const RealDate = Date;
    globalThis.Date = class extends RealDate {
      constructor(...args) { super(...(args.length ? args : [now])); }
      static now() { return now; }
    };
    const realTimeout = setTimeout;
    globalThis.setTimeout = (fn, ms, ...args) => {
      if (ms === 5000 || ms === 2000) { queueMicrotask(() => fn(...args)); return 0; }
      return realTimeout(fn, ms, ...args);
    };
    const state = installRedis(${JSON.stringify(input)});
    const countries = ${JSON.stringify(countries)};
    const mode = ${JSON.stringify(mode)};
    const corruptRaw = ${JSON.stringify(corruptRaw) ?? 'undefined'};
    if (corruptRaw !== undefined) state.redis.set('${PREFIX}' + countries[0][1], corruptRaw);
    const currentDate = mode === 'moving'
      ? new RealDate(now - 86400000).toISOString().slice(0, 10) : '2026-09-09';
    const requests = [];
    globalThis.fetch = async (url, init) => {
      const u = new URL(url);
      if (u.origin === 'https://redis.example') {
        if (mode.startsWith('cache-read-') && u.pathname === '/pipeline'
          && JSON.parse(init.body).some(([verb]) => verb === 'GET')) {
          const replies = JSON.parse(init.body).map(() => ({ result: null }));
          if (mode === 'cache-read-short') return Response.json(replies.slice(1));
          if (mode === 'cache-read-envelope') return Response.json({ result: replies });
          replies[0] = mode === 'cache-read-missing' ? {}
            : mode === 'cache-read-type' ? { result: 42 } : { error: 'ERR read failed' };
          return Response.json(replies);
        }
        if (mode === 'canonical-expired' && u.pathname === '/pipeline'
          && JSON.parse(init.body).some(([verb]) => verb === 'EXPIRE')) {
          state.redis.delete('${CANONICAL}');
        }
        if (mode === 'canonical-unconfirmed' && u.pathname === '/pipeline'
          && JSON.parse(init.body).some(([verb]) => verb === 'EXPIRE')) {
          const response = await state.fetchImpl(url, init);
          const results = await response.json();
          results[0] = {};
          return Response.json(results);
        }
        if (u.pathname === '/multi-exec') {
          if (mode === 'transaction-rejected') return Response.json({ error: 'write rejected' }, { status: 503 });
          const response = await state.fetchImpl(url, init);
          if (mode === 'transaction-ambiguous') return Response.json({});
          console.log('TEST transaction confirmed');
          return response;
        }
        return state.fetchImpl(url, init);
      }
      if (!u.hostname.endsWith('arcgis.com')) throw new Error('Unexpected URL: ' + url);
      requests.push(u.search);
      if (!u.pathname.endsWith('/query')) return Response.json({ fields: [{ name: 'date', type: 'esriFieldTypeDateOnly' }] });
      const offset = Number(u.searchParams.get('resultOffset'));
      if (u.pathname.includes('PortWatch_ports_database')) {
        if (offset > 0 && mode === 'reference-page') return Response.json({ exceededTransferLimit: true });
        const page = countries.slice(offset, offset + 100);
        return Response.json({ features: page.map(([iso3, iso2]) => ({ attributes: { portid: iso2, ISO3: iso3, lat: 1, lon: 2 } })), exceededTransferLimit: offset + page.length < countries.length });
      }
      const where = u.searchParams.get('where');
      const iso3 = where.match(/ISO3='([^']+)'/)[1];
      const iso2 = countries.find(([code]) => code === iso3)[1];
      if (u.searchParams.has('outStatistics')) return Response.json({ features: [{ attributes: { max_date: mode === 'zero' ? null : currentDate } }] });
      if (mode === 'corrupt-failure' && iso3 === countries[0][0]) return Response.json({ features: [null] });
      if (mode === 'zero') return Response.json({ features: [], exceededTransferLimit: false });
      if (mode === 'activity-page' && iso3 === countries[0][0] && !where.includes('<=')) {
        if (offset > 0) return Response.json({ features: [], exceededTransferLimit: true });
        return Response.json({ features: [{ attributes: { portid: iso2, date: '2026-09-09', portcalls_tanker: 99 } }], exceededTransferLimit: true });
      }
      return Response.json({ features: [{ attributes: { portid: iso2, ISO3: iso3, date: where.includes('<=') ? new RealDate(now - 40 * 86400000).toISOString().slice(0, 10) : currentDate, portcalls_tanker: 1, import_tanker: 0, export_tanker: 0 } }], exceededTransferLimit: false });
    };
    const producer = await import('./scripts/seed-portwatch-port-activity.mjs');
    let error = null;
    try { await producer.main(); } catch (e) { error = e.message; }
    console.log('RESULT ' + JSON.stringify({ error, requests,
      rawRedis: Object.fromEntries(state.redis),
      redis: Object.fromEntries([...state.redis].map(([key, value]) => {
        try { return [key, JSON.parse(value)]; } catch { return [key, value]; }
      })),
    }));
  `;
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', code], {
    cwd: ROOT, encoding: 'utf8', timeout: 20_000, maxBuffer: 4 * 1024 * 1024,
    env: { PATH: process.env.PATH, NODE_TEST_CONTEXT: 'child-v8' },
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  const line = child.stdout.split('\n').find((entry) => entry.startsWith('RESULT '));
  assert.ok(line, child.stdout + child.stderr);
  return { ...JSON.parse(line.slice(7)), logs: child.stdout + child.stderr };
}

function health(redis: Record<string, any>, now = NOW) {
  return __testing__.classifyKey('portwatchPortActivity', CANONICAL, {}, {
    keyStrens: new Map([[CANONICAL, JSON.stringify(redis[CANONICAL]).length]]),
    keyErrors: new Map(), keyMetaErrors: new Map(),
    keyMetaValues: new Map([[META, JSON.stringify(redis[META])]]), now,
  });
}

async function readCountry(t: any, redis: Record<string, any>, code: string, now = NOW) {
  const realFetch = globalThis.fetch;
  const realNow = Date.now;
  const env = { ...process.env };
  t.after(() => { globalThis.fetch = realFetch; Date.now = realNow; process.env = env; });
  installRedis(redis);
  Date.now = () => now;
  return getCountryPortActivity({} as never, { countryCode: code });
}

test('natural 168-to-60 expiry cliff preserves publication and reports incomplete recovery', async (t) => {
  const input = fixtures();
  const result = runProducer(input);
  assert.match(result.error, /Incomplete PortWatch coverage/);
  assert.match(result.logs, /60\/174 usable countries/);
  assert.doesNotMatch(result.logs, /Seeded 60 countries/);
  assert.match(result.logs, /60 usable country payloads assembled.*persistence pending/);
  assert.match(result.logs, /Recovery state saved; canonical list retained at 168 countries; usable coverage 60\/174; full publication blocked; 0 unresolved refresh failures/);
  assert.match(result.logs, /TEST transaction confirmed/);
  assert.ok(result.logs.indexOf('TEST transaction confirmed') < result.logs.indexOf('Recovery state saved'));
  assert.doesNotMatch(result.logs, /countries published|unpublished countries|asof behind/);
  assert.deepEqual(result.redis[CANONICAL], input[CANONICAL]);
  assert.equal(result.redis[META].fetchedAt, input[META].fetchedAt);
  assert.equal(result.redis[META].recordCount, 168);
  assert.deepEqual(result.redis[META].contentFreshness, input[META].contentFreshness);
  assert.equal(result.redis[META].coverage.published, 60);
  assert.equal(result.redis[META].coverage.refreshFailures.length, 0);
  assert.equal(result.redis[META].sourceState, 'error');
  assert.equal(result.redis[META].lastAttemptAt, NOW);
  assert.equal(health(result.redis).status, 'SEED_ERROR');
  assert.equal(health(result.redis).errorCode, 'PORTWATCH_COVERAGE_PARTIAL');
  assert.equal(health(result.redis).coverage.status, 'partial');
  const retained = countries[150][1];
  const response = await readCountry(t, result.redis, retained);
  assert.equal(response.available, true);
  assert.equal(response.fetchedAt, input[`${PREFIX}${retained}`].fetchedAt);
  process.env.WORLDMONITOR_VALID_KEYS = 'test-key';
  const { handleSeedHealth } = await import('../api/seed-health.js');
  const seedHealthResponse = await handleSeedHealth(new Request('https://api.worldmonitor.app/api/seed-health', {
    headers: { 'X-WorldMonitor-Key': 'test-key' },
  }), { now: NOW });
  const entry = (await seedHealthResponse.json()).seeds['supply_chain:portwatch-ports'];
  assert.equal(entry.status, 'error');
  assert.equal(entry.recordCount, 168);
  Date.now = () => NOW + 7 * DAY;
  assert.equal((await getCountryPortActivity({} as never, { countryCode: retained })).available, false);
});

test('reference-page failure records diagnostics without replacing last-good keys', () => {
  const input = fixtures();
  const result = runProducer(input, 'reference-page');
  assert.match(result.error, /incomplete page/);
  assert.deepEqual(result.redis[CANONICAL], input[CANONICAL]);
  assert.equal(result.redis[META].fetchedAt, input[META].fetchedAt);
  assert.equal(result.redis[META].errorCode, 'PORTWATCH_INCOMPLETE_PAGE');
  assert.equal(result.redis[META].coverage.completionRatio, null);
  for (const [, code] of countries) assert.deepEqual(result.redis[`${PREFIX}${code}`], input[`${PREFIX}${code}`]);
});

test('a failed first run does not invent a successful observation timestamp', () => {
  const result = runProducer({}, 'reference-page');
  assert.match(result.error, /incomplete page/);
  assert.equal(result.redis[CANONICAL], undefined);
  assert.equal(result.redis[META].fetchedAt, undefined);
  assert.equal(result.redis[META].recordCount, undefined);
  assert.equal(result.redis[META].sourceState, 'error');
});

test('a bad second activity page retains the entire country payload and success clocks', async (t) => {
  const input = fixtures();
  const code = countries[0][1];
  input[`${PREFIX}${code}`].cacheWrittenAt = NOW - DAY;
  input[`${PREFIX}${code}`].refreshAttemptedAt = 1;
  const result = runProducer(input, 'activity-page');
  const retained = result.redis[`${PREFIX}${code}`];
  assert.deepEqual(retained.ports, input[`${PREFIX}${code}`].ports);
  assert.equal(retained.cacheWrittenAt, input[`${PREFIX}${code}`].cacheWrittenAt);
  assert.equal(retained.refreshFailure.code, 'incomplete_page');
  assert.equal(retained.refreshAttemptedAt, NOW);
  assert.equal(result.redis[META].fetchedAt, input[META].fetchedAt);
  assert.ok(result.redis[META].coverage.refreshFailures.some((entry: any) => entry.iso2 === code && entry.code === 'incomplete_page'));
  assert.equal((await readCountry(t, result.redis, code)).ports[0].tankerCalls30d, 12);
});

for (const mode of ['cache-read-failure', 'cache-read-short', 'cache-read-envelope', 'cache-read-missing', 'cache-read-type']) {
  test(`${mode} cannot erase an unreadable last-good country`, () => {
    const input = fixtures();
    const result = runProducer(input, mode);
    assert.match(result.error, /cache read/);
    for (const [, code] of countries) assert.deepEqual(result.redis[`${PREFIX}${code}`], input[`${PREFIX}${code}`]);
    assert.equal(result.redis[META].fetchedAt, input[META].fetchedAt);
    assert.equal(result.redis[META].sourceState, 'error');
  });
}

for (const raw of ['{broken', 'null', '[]']) {
  test(`confirmed corrupt country ${raw} is replaced only after validated recovery`, () => {
    const input = fixtures();
    const key = `${PREFIX}${countries[0][1]}`;
    const failed = runProducer(input, 'corrupt-failure', NOW, raw);
    assert.match(failed.error, /Incomplete PortWatch coverage/);
    assert.equal(failed.rawRedis[key], raw, 'failed repair must preserve original bytes');
    assert.equal(failed.redis[META].fetchedAt, input[META].fetchedAt);
    assert.ok(countries.some(([, code]) => code !== countries[0][1]
      && failed.redis[`${PREFIX}${code}`].cacheWrittenAt === NOW), 'other countries must refresh');
    const repaired = runProducer(failed.redis, 'complete', NOW + DAY / 8, raw);
    assert.equal(repaired.redis[key].cacheWrittenAt, NOW + DAY / 8);
    assert.ok(repaired.redis[key].ports.length > 0);
  });
}

test('deferred corrupt countries retain their exact stored value', () => {
  const input = fixtures();
  for (const [, code] of countries) input[`${PREFIX}${code}`] = [];
  const result = runProducer(input);
  const deferred = countries.filter(([, code]) => Array.isArray(result.redis[`${PREFIX}${code}`]));
  assert.equal(deferred.length, 144);
  for (const [, code] of deferred) assert.equal(result.rawRedis[`${PREFIX}${code}`], '[]');
});

test('one persistently corrupt country cannot stop healthy country recovery', () => {
  const input = fixtures();
  for (const [, code] of countries) input[`${PREFIX}${code}`].asof = '2026-09-08';
  const key = `${PREFIX}${countries[0][1]}`;
  input[key] = [];
  let state = input;
  for (let run = 0; run < 7; run++) {
    const now = NOW + run * PORTWATCH_CONTENT_FRESHNESS_CADENCE_MINUTES * 60_000;
    const result = runProducer(state, 'corrupt-failure', now);
    state = result.redis;
    assert.equal(result.rawRedis[key], '[]');
    assert.deepEqual(state[CANONICAL], input[CANONICAL]);
    assert.equal(state[META].fetchedAt, input[META].fetchedAt);
  }
  for (const [, code] of countries.slice(1)) {
    assert.ok(state[`${PREFIX}${code}`].cacheWrittenAt >= NOW, `${code} must recover`);
  }
});

test('12-hour rolling recovery stays complete across daily advances within the original traffic cap', () => {
  let state = fixtures();
  const cadenceMs = PORTWATCH_CONTENT_FRESHNESS_CADENCE_MINUTES * 60_000;
  assert.equal(cadenceMs, DAY / 2);
  let recovered = false;
  let successfulRuns = 0;
  for (let run = 0; run < 20; run++) {
    // Miss scheduled runs during both initial recovery and steady state.
    if (run === 6 || run === 14) continue;
    const now = NOW + run * cadenceMs;
    const result = runProducer(state, 'moving', now);
    const activityRequests = result.requests.map((query: string) => new URLSearchParams(query))
      .filter((query: URLSearchParams) => query.get('where')?.startsWith('ISO3=') && !query.has('outStatistics'));
    const refreshed = new Set(activityRequests.map((query: URLSearchParams) => query.get('where')!.match(/ISO3='([^']+)'/)![1]));
    assert.ok(refreshed.size <= 30, 'do not increase countries attempted per run');
    assert.ok(activityRequests.length <= 60, 'two one-page windows per country, no duplicate activity requests');
    if (result.error) {
      assert.equal(recovered, false, 'daily updates must not invalidate recovered coverage');
      assert.deepEqual(result.redis[CANONICAL], state[CANONICAL]);
      assert.equal(result.redis[META].fetchedAt, state[META].fetchedAt);
    } else {
      recovered = true;
      successfulRuns++;
      assert.equal(result.redis[META].recordCount, 174);
      assert.equal(result.redis[META].coverage.complete, true);
      assert.deepEqual(result.redis[META].coverage.refreshFailures, []);
      const coverage = result.redis[META].coverage;
      assert.equal(coverage.currentCountryCount + coverage.retainedCountryCount, 174);
      assert.ok(coverage.retainedCountryCount > 0, 'allow useful retained data as the source moves');
      assert.ok(now - coverage.oldestCountryCacheWrittenAt < 7 * DAY);
      assert.equal(health(result.redis, now).status, 'OK');
      assert.equal(health(result.redis, now).coverage.retainedCountryCount, coverage.retainedCountryCount);
      for (const [iso3, code] of countries) {
        const payload = result.redis[`${PREFIX}${code}`];
        assert.ok(now - payload.cacheWrittenAt < 7 * DAY);
        if (!refreshed.has(iso3)) {
          for (const field of ['fetchedAt', 'cacheWrittenAt', 'contentAsOfChangedAt', 'asof']) {
            assert.equal(payload[field], state[`${PREFIX}${code}`][field], `retention must preserve ${field}`);
          }
        }
      }
    }
    state = result.redis;
  }
  assert.ok(successfulRuns >= 10, 'recover within a rotation and remain complete over multiple rotations');
});

test('the 120-of-174 crash backlog recovers through persisted bounded batches', () => {
  let state = fixtures();
  for (const [index, [, code]] of countries.entries()) {
    state[`${PREFIX}${code}`].cacheWrittenAt = NOW - (index < 84 ? 8 : 1) * DAY;
    state[`${PREFIX}${code}`].asof = index >= 84 && index < 148 ? '2026-09-09' : '2026-09-08';
  }
  for (const [run, covered] of [120, 150, 174].entries()) {
    const now = NOW + run * PORTWATCH_CONTENT_FRESHNESS_CADENCE_MINUTES * 60_000;
    const result = runProducer(state, 'complete', now);
    assert.equal(result.redis[META].coverage.published, covered);
    if (covered < 174) {
      assert.match(result.error, /Incomplete PortWatch coverage/);
      assert.deepEqual(result.redis[CANONICAL], state[CANONICAL]);
      assert.equal(result.redis[META].fetchedAt, state[META].fetchedAt);
    } else {
      assert.equal(result.error, null);
      assert.equal(result.redis[META].sourceState, 'ok');
      assert.equal(result.redis[META].fetchedAt, now);
    }
    state = result.redis;
  }
});

test('unchanged upstream stays covered across cache expiry without exceeding the refresh cap', () => {
  let state = fixtures();
  state[CANONICAL] = countries.map(([, code]) => code);
  for (const [, code] of countries) {
    const payload = state[`${PREFIX}${code}`];
    payload.cacheWrittenAt = NOW;
    payload.fetchedAt = new Date(NOW).toISOString();
    payload.asof = '2026-09-09';
    payload.contentAsOfChangedAt = NOW - 10 * DAY;
  }
  const cadenceMs = PORTWATCH_CONTENT_FRESHNESS_CADENCE_MINUTES * 60_000;
  for (let run = 0; run < 30; run++) {
    if (run === 9 || run === 22) continue;
    const now = NOW + run * cadenceMs;
    const result = runProducer(state, 'complete', now);
    assert.equal(result.error, null, `run ${run}: ${result.redis[META].coverage.published}/174 covered`);
    assert.equal(result.redis[META].coverage.published, 174);
    const activityRequests = result.requests.map((query: string) => new URLSearchParams(query))
      .filter((query: URLSearchParams) => query.get('where')?.startsWith('ISO3=') && !query.has('outStatistics'));
    assert.ok(activityRequests.length <= 60, 'retain the 30-country, two-window cap');
    for (const [, code] of countries) {
      const payload = result.redis[`${PREFIX}${code}`];
      assert.ok(now - payload.cacheWrittenAt < 7 * DAY, `${code} expired at run ${run}`);
      assert.equal(payload.contentAsOfChangedAt, NOW - 10 * DAY, 'refetch must not renew frozen content');
    }
    state = result.redis;
  }
});

test('a deferred refresh failure cannot be hidden by otherwise complete retained coverage', () => {
  const input = fixtures();
  for (const [, code] of countries) {
    input[`${PREFIX}${code}`].cacheWrittenAt = NOW - DAY;
    input[`${PREFIX}${code}`].asof = '2026-09-08';
  }
  const code = countries[0][1];
  input[`${PREFIX}${code}`].refreshAttemptedAt = 1;
  const failed = runProducer(input, 'activity-page');
  assert.match(failed.error, /Incomplete PortWatch coverage/);
  assert.equal(failed.redis[META].coverage.published, 174);
  assert.match(failed.logs, /usable coverage 174\/174; full publication blocked; 1 unresolved refresh failures/);
  const deferred = runProducer(failed.redis, 'moving', NOW + DAY / 2);
  assert.match(deferred.error, /Incomplete PortWatch coverage/);
  assert.equal(deferred.redis[META].fetchedAt, input[META].fetchedAt);
  assert.ok(deferred.redis[META].coverage.refreshFailures.some((entry: any) => entry.iso2 === code));
  assert.equal(health(deferred.redis, NOW + DAY / 2).status, 'SEED_ERROR');
});

test('unchanged upstream data uses the cache without any activity downloads', () => {
  const input = fixtures();
  for (const [, code] of countries) {
    input[`${PREFIX}${code}`].cacheWrittenAt = NOW - DAY;
    input[`${PREFIX}${code}`].asof = '2026-09-09';
  }
  const result = runProducer(input);
  assert.equal(result.error, null);
  const activityRequests = result.requests.map((query: string) => new URLSearchParams(query))
    .filter((query: URLSearchParams) => query.get('where')?.startsWith('ISO3=') && !query.has('outStatistics'));
  assert.equal(activityRequests.length, 0);
  assert.equal(result.redis[META].coverage.currentCountryCount, 174);
  assert.equal(result.redis[META].coverage.retainedCountryCount, 0);
  assert.match(result.logs, /State saved; canonical list advanced to 174 countries; usable coverage 174\/174; 0 unresolved refresh failures/);
  assert.match(result.logs, /TEST transaction confirmed/);
  assert.ok(result.logs.indexOf('TEST transaction confirmed') < result.logs.indexOf('State saved'));
  for (const [, code] of countries) {
    assert.deepEqual(result.redis[`${PREFIX}${code}`], input[`${PREFIX}${code}`]);
  }
});

test('durable rotation replaces the snapshot only after complete validated recovery', () => {
  const input = fixtures();
  let state = input;
  let recovered = false;
  for (let run = 0; run < 6; run++) {
    const now = NOW + run * PORTWATCH_CONTENT_FRESHNESS_CADENCE_MINUTES * 60_000;
    const result = runProducer(state, 'complete', now);
    state = result.redis;
    if (result.error) {
      assert.deepEqual(state[CANONICAL], input[CANONICAL]);
      assert.equal(state[META].fetchedAt, input[META].fetchedAt);
      continue;
    }
    recovered = true;
    assert.equal(state[CANONICAL].length, 174);
    assert.equal(state[META].fetchedAt, now);
    assert.equal(state[META].recordCount, 174);
    assert.equal(state[META].sourceState, 'ok');
    assert.equal(state[META].errorCode, undefined);
    assert.equal(state[META].coverage.complete, true);
    assert.equal(health(state, now).status, 'OK');
    break;
  }
  assert.equal(recovered, true, 'rotation must converge within six natural-run equivalents');
});

test('complete verified zero activity is a successful observation, not a source failure', async (t) => {
  const input = fixtures();
  for (const [, code] of countries) {
    Object.assign(input[`${PREFIX}${code}`], { asof: null, zeroActivity: true, ports: [], cacheWrittenAt: NOW - DAY });
  }
  // Exercise the actual empty upstream path for one country as well as cache hits.
  input[`${PREFIX}${countries[0][1]}`].cacheWrittenAt = NOW - 7 * DAY;
  const result = runProducer(input, 'zero');
  assert.equal(result.error, null);
  assert.equal(result.redis[META].recordCount, 174);
  assert.equal(result.redis[META].sourceState, 'ok');
  const response = await readCountry(t, result.redis, countries[0][1]);
  assert.equal(response.available, true);
  assert.deepEqual(response.ports, []);
});

for (const canonical of [null, []]) {
  test(`partial cold start reports ${canonical === null ? 'absent' : 'empty'} canonical list`, () => {
    const result = runProducer(canonical === null ? {} : { [CANONICAL]: canonical, [META]: { recordCount: 60 } });
    assert.match(result.error, /Incomplete PortWatch coverage/);
    assert.match(result.logs, canonical === null
      ? /Recovery state saved; no prior canonical list; usable coverage 30\/174; full publication blocked/
      : /Recovery state saved; canonical list retained at 0 countries; usable coverage 30\/174; full publication blocked/);
  });
}

for (const mode of ['transaction-rejected', 'transaction-ambiguous']) {
  test(`${mode} never reports confirmed persistence or publication`, () => {
    const input = fixtures();
    for (const [, code] of countries) {
      input[`${PREFIX}${code}`].cacheWrittenAt = NOW - DAY;
      input[`${PREFIX}${code}`].asof = '2026-09-09';
    }
    const result = runProducer(input, mode);
    assert.match(result.error, /Redis transaction/);
    assert.doesNotMatch(result.logs, /State saved|Recovery state saved|canonical list advanced|canonical list retained/);
    assert.match(result.logs, /Persistence pending/);
    if (mode === 'transaction-rejected') assert.deepEqual(result.redis[CANONICAL], input[CANONICAL]);
    else assert.equal(result.redis[CANONICAL].length, 174, 'write can commit despite an unconfirmed response');
  });
}

for (const mode of ['canonical-expired', 'canonical-unconfirmed']) {
  test(`${mode} during a partial run is not reported as retained publication`, () => {
    const input = fixtures();
    const result = runProducer(input, mode);
    assert.match(result.error, /Incomplete PortWatch coverage/);
    if (mode === 'canonical-expired') assert.equal(result.redis[CANONICAL], undefined);
    else assert.deepEqual(result.redis[CANONICAL], input[CANONICAL]);
    assert.match(result.logs, /Recovery state saved; canonical retention unconfirmed \(168 countries at run start\); usable coverage 60\/174; full publication blocked/);
    assert.doesNotMatch(result.logs, /canonical list retained at/);
  });
}
