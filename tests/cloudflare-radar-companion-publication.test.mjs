/**
 * Cloudflare Radar companion publication contract (issue #7845).
 *
 * seed-internet-outages.mjs publishes three independent Radar products: the
 * canonical outage annotations plus two companion keys (DDoS summaries, traffic
 * anomalies) that their own RPCs read. This suite drives the REAL seeder in a
 * child process with controlled HTTP, Redis and clock, then reads the resulting
 * store back through the REAL RPC handlers and the REAL health classifier.
 *
 * The invariants under test:
 *   - a confirmed empty Radar result publishes an empty payload (readers stop
 *     serving the previous event/summary), not metadata alone;
 *   - an HTTP-200 error envelope is a FAILURE, never an empty result — it may
 *     not overwrite last-good data nor advance the success clock;
 *   - each source publishes independently: one failure never discards a healthy
 *     sibling's update;
 *   - a failed source's consumer key keeps its own TTL through the existing
 *     retention path;
 *   - provider work that already succeeded is never replayed by a retry.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { __testing__ as health } from '../api/health.js';
import { resolveSeedMetaTtl, SEED_META_MIN_TTL_SECONDS } from '../scripts/_seed-utils.mjs';

const OUTAGES_KEY = 'infra:outages:v1';
const DDOS_KEY = 'cf:radar:ddos:v1';
const TRAFFIC_KEY = 'cf:radar:traffic-anomalies:v1';
const DDOS_META_KEY = 'seed-meta:cf:radar:ddos';
const TRAFFIC_META_KEY = 'seed-meta:cf:radar:traffic-anomalies';
// Parsed from the seeder rather than retyped: the suite asserts these exact
// values as EXPIRE arguments, so a copy that drifts from the implementation
// would keep passing while testing the wrong contract. Same technique the fleet
// guard in tests/seed-ttl-outlives-staleness-fleet.test.mjs uses.
const SEEDER_SOURCE = readFileSync(new URL('../scripts/seed-internet-outages.mjs', import.meta.url), 'utf8');
const seederTtl = (name) => {
  const match = SEEDER_SOURCE.match(new RegExp(`^const ${name} = (\\d+);`, 'm'));
  assert.ok(match, `seed-internet-outages.mjs no longer declares ${name}`);
  return Number(match[1]);
};
const DDOS_TTL = seederTtl('DDOS_TTL');
const ANOMALIES_TTL = seederTtl('ANOMALIES_TTL');

const NOW = Date.parse('2026-09-07T12:00:00Z');
const REDIS_ORIGIN = 'https://redis.radar-fixture.test';
const GRACEFUL_FETCH_FAILURE_EXIT_CODE = 75;

/**
 * The child body. Serialized into `node --eval`, so it must stay
 * self-contained: everything it needs arrives as an argument, never as a free
 * identifier this module happens to have in scope.
 */
async function seedFixture(entries, plan, now, redisOrigin) {
  Date.now = () => now;
  const store = new Map(entries);
  const radarCalls = [];
  const redisCommands = [];
  let rejectedWrites = 0;

  const apply = (command) => {
    redisCommands.push(command);
    const [name, key] = command;
    if (name === 'SET') {
      store.set(key, command[2]);
      return 'OK';
    }
    if (name === 'DEL') return Number(store.delete(key));
    if (name === 'EXPIRE') return store.has(key) ? 1 : 0;
    if (name === 'EVAL') return 1;
    throw new Error(`unexpected Redis command ${name}`);
  };

  const radar = (spec, body) => {
    if (spec === 'ok') return Response.json(body);
    if (spec === 'http-503') return new Response('upstream down', { status: 503 });
    if (spec === 'success-false') return Response.json({ success: false, errors: [{ code: 7000, message: 'nope' }] });
    if (spec === 'errors-present') return Response.json({ ...body, errors: [{ code: 7000 }] });
    if (spec === 'errors-not-array') return Response.json({ ...body, errors: { code: 7000 } });
    if (spec === 'no-result') return Response.json({ success: true });
    if (spec === 'not-configured') return Response.json({ configured: false, success: true, result: {} });
    // Envelope is a valid success, but the REQUIRED result field is absent or
    // the wrong type — the field-level guards, not the envelope guard.
    if (spec === 'field-missing') return Response.json({ success: true, result: { meta: { dateRange: [] } } });
    if (spec === 'field-wrong-type') {
      return Response.json({ success: true, result: { annotations: {}, summary_0: [], trafficAnomalies: 'nope', top_0: {}, meta: { dateRange: [] } } });
    }
    throw new Error(`unknown response spec ${spec}`);
  };

  const EMPTY = {
    annotations: { success: true, result: { annotations: [] } },
    protocol: { success: true, result: { summary_0: {}, meta: { dateRange: [] } } },
    vector: { success: true, result: { summary_0: {}, meta: { dateRange: [] } } },
    target: { success: true, result: { top_0: [] } },
    traffic: { success: true, result: { trafficAnomalies: [] } },
  };
  const FULL = {
    annotations: {
      success: true,
      result: {
        annotations: [{
          id: 'ann-1',
          locations: ['US'],
          locationsDetails: [{ name: 'United States' }],
          scope: 'Nationwide',
          startDate: '2026-09-01T00:00:00Z',
          outage: { outageType: 'NATIONWIDE', outageCause: 'POWER_OUTAGE' },
        }],
      },
    },
    protocol: { success: true, result: { summary_0: { TCP: '70', UDP: '30' }, meta: { dateRange: [{ startTime: 'S', endTime: 'E' }] } } },
    vector: { success: true, result: { summary_0: { SYN: '100' }, meta: { dateRange: [] } } },
    target: { success: true, result: { top_0: [{ clientCountryAlpha2: 'US', clientCountryName: 'United States', value: '55' }] } },
    traffic: {
      success: true,
      result: {
        trafficAnomalies: [{
          uuid: 'anom-1',
          type: 'LOCATION',
          status: 'ONGOING',
          startDate: '2026-09-01T00:00:00Z',
          locationDetails: { code: 'US', name: 'United States' },
          asnDetails: { asn: 1234, name: 'Acme' },
        }],
      },
    },
  };

  const bodyFor = (leg) => (plan.payload === 'full' ? FULL[leg] : EMPTY[leg]);

  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);

    if (url.origin === redisOrigin) {
      if (url.pathname.startsWith('/get/')) {
        const key = decodeURIComponent(url.pathname.slice('/get/'.length));
        return Response.json({ result: store.get(key) ?? null });
      }
      const body = JSON.parse(init.body);
      // Upstash reports a command-level failure with HTTP 200 and a per-command
      // `error`. Redis does NOT roll back siblings in that case, so the reject
      // is applied per command: every other command in the batch still executes.
      // Scoped to SET so it models a failing PUBLISH, not an unreachable key:
      // the retention EXPIRE on the same key must still be observable.
      const rejects = (command) => (
        command[0] === 'SET' && plan.redisRejectKey === command[1]
        && (plan.redisRejectAttempts == null || ++rejectedWrites <= plan.redisRejectAttempts)
      );
      if (url.pathname === '/pipeline' || url.pathname === '/multi-exec') {
        return Response.json(body.map((command) => (
          rejects(command) ? { error: 'READONLY injected failure' } : { result: apply(command) }
        )));
      }
      if (rejects(body)) return Response.json({ error: 'READONLY injected failure' });
      return Response.json({ result: apply(body) });
    }

    if (url.hostname !== 'api.cloudflare.com') throw new Error(`unexpected host ${url.hostname}`);
    radarCalls.push(url.pathname);
    if (url.pathname.endsWith('/annotations/outages')) return radar(plan.annotations, bodyFor('annotations'));
    if (url.pathname.endsWith('/summary/protocol')) return radar(plan.protocol, bodyFor('protocol'));
    if (url.pathname.endsWith('/summary/vector')) return radar(plan.vector, bodyFor('vector'));
    if (url.pathname.endsWith('/top/locations/target')) return radar(plan.target, bodyFor('target'));
    if (url.pathname.endsWith('/traffic_anomalies')) return radar(plan.traffic, bodyFor('traffic'));
    throw new Error(`unexpected Radar path ${url.pathname}`);
  };

  process.on('exit', () => {
    console.log(`FIXTURE_RESULT=${JSON.stringify({ store: [...store], radarCalls, redisCommands })}`);
  });
  await import(process.env.TEST_SEED_URL);
}

const DEFAULT_PLAN = {
  annotations: 'ok',
  protocol: 'ok',
  vector: 'ok',
  target: 'ok',
  traffic: 'ok',
  payload: 'empty',
  redisRejectKey: null,
  // null = reject that key's writes forever; a number = reject only the first N,
  // which is how a transient Upstash blip is modelled.
  redisRejectAttempts: null,
};

function runSeeder({ entries = [], plan = {}, now = NOW } = {}) {
  const merged = { ...DEFAULT_PLAN, ...plan };
  const args = [entries, merged, now, REDIS_ORIGIN].map((value) => JSON.stringify(value)).join(', ');
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `await (${seedFixture.toString()})(${args});`,
    ],
    {
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        CLOUDFLARE_API_TOKEN: 'fixture-token',
        NODE_TEST_CONTEXT: 'child',
        WM_SEED_RETRY_DELAY_MS: '1',
        TEST_SEED_URL: new URL('../scripts/seed-internet-outages.mjs', import.meta.url).href,
        UPSTASH_REDIS_REST_URL: REDIS_ORIGIN,
        UPSTASH_REDIS_REST_TOKEN: 'fixture-token',
      },
    },
  );
  const output = `${result.stdout}${result.stderr}`;
  const match = output.match(/FIXTURE_RESULT=(.+)/);
  assert.ok(match, `fixture produced no result:\n${output}`);
  const parsed = JSON.parse(match[1]);
  return {
    ...parsed,
    store: new Map(parsed.store),
    exitCode: result.status,
    output,
  };
}

function lastGoodEntries(fetchedAt = NOW - 30 * 60_000) {
  const meta = JSON.stringify({ fetchedAt, recordCount: 1, sourceVersion: 'cloudflare-radar-28d' });
  return [
    [DDOS_KEY, JSON.stringify({
      protocol: [{ label: 'TCP', percentage: 90 }],
      vector: [{ label: 'SYN', percentage: 90 }],
      dateRangeStart: 'OLD',
      dateRangeEnd: 'OLD',
      topTargetLocations: [{ countryCode: 'US', countryName: 'United States', percentage: 90, latitude: 37.09, longitude: -95.71 }],
    })],
    [TRAFFIC_KEY, JSON.stringify({ anomalies: [{ uuid: 'old-event', status: 'ONGOING' }], totalCount: 1 })],
    [DDOS_META_KEY, meta],
    [TRAFFIC_META_KEY, meta],
    [OUTAGES_KEY, JSON.stringify({ _seed: { fetchedAt, recordCount: 1, state: 'OK' }, data: { outages: [{ id: 'cf-old' }] } })],
    ['seed-meta:infra:outages', meta],
  ];
}

/** Radar request paths only — the fixture also records Redis traffic. */
function radarPaths(radarCalls) {
  return radarCalls.map((path) => path.replace('/client/v4/radar/', ''));
}

function expireCommandsFor(redisCommands, key) {
  return redisCommands.filter((command) => command[0] === 'EXPIRE' && command[1] === key);
}

/** Drive the REAL RPC handlers against the store the seeder actually produced. */
async function readThroughRpcs(store) {
  const originalFetch = globalThis.fetch;
  const original = {
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  };
  process.env.UPSTASH_REDIS_REST_URL = REDIS_ORIGIN;
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fixture-token';
  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    assert.equal(url.origin, REDIS_ORIGIN, `RPC read escaped the fixture: ${url}`);
    const key = decodeURIComponent(url.pathname.slice('/get/'.length));
    return Response.json({ result: store.get(key) ?? null });
  };
  try {
    const [ddosModule, trafficModule] = await Promise.all([
      import('../server/worldmonitor/infrastructure/v1/list-ddos-attacks.ts'),
      import('../server/worldmonitor/infrastructure/v1/list-traffic-anomalies.ts'),
    ]);
    return {
      ddos: await ddosModule.listInternetDdosAttacks({}, {}),
      traffic: await trafficModule.listInternetTrafficAnomalies({}, {}),
    };
  } finally {
    globalThis.fetch = originalFetch;
    if (original.url === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = original.url;
    if (original.token === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = original.token;
  }
}

function classifyCompanion(name, dataKey, metaKey, store, now = NOW + 1_000) {
  return health.classifyKey(name, dataKey, { allowOnDemand: false }, {
    keyStrens: new Map(store.has(dataKey) ? [[dataKey, Buffer.byteLength(store.get(dataKey))]] : []),
    keyErrors: new Map(),
    keyMetaErrors: new Map(),
    keyMetaValues: new Map([[metaKey, store.get(metaKey)]]),
    now,
  });
}

test('a confirmed empty Radar result publishes empty companion payloads', () => {
  const run = runSeeder({ entries: lastGoodEntries() });

  assert.equal(run.exitCode, 0, run.output);
  assert.deepEqual(JSON.parse(run.store.get(DDOS_KEY)), {
    protocol: [],
    vector: [],
    dateRangeStart: '',
    dateRangeEnd: '',
    topTargetLocations: [],
  }, 'a valid empty DDoS result must replace the old summary');
  assert.deepEqual(JSON.parse(run.store.get(TRAFFIC_KEY)), {
    anomalies: [],
    totalCount: 0,
  }, 'a valid empty traffic result must remove the old ongoing event');

  const ddosMeta = JSON.parse(run.store.get(DDOS_META_KEY));
  const trafficMeta = JSON.parse(run.store.get(TRAFFIC_META_KEY));
  assert.equal(ddosMeta.fetchedAt, NOW, 'a confirmed empty publish advances the DDoS success clock');
  assert.equal(ddosMeta.recordCount, 0);
  assert.equal(trafficMeta.fetchedAt, NOW, 'a confirmed empty publish advances the traffic success clock');
  assert.equal(trafficMeta.recordCount, 0);

  assert.equal(classifyCompanion('ddosAttacks', DDOS_KEY, DDOS_META_KEY, run.store).status, 'OK');
  assert.equal(classifyCompanion('trafficAnomalies', TRAFFIC_KEY, TRAFFIC_META_KEY, run.store).status, 'OK');
});

test('the real RPC readers stop serving the prior event and summary', async () => {
  const run = runSeeder({ entries: lastGoodEntries() });
  const served = await readThroughRpcs(run.store);

  assert.deepEqual(served.ddos.protocol, []);
  assert.deepEqual(served.ddos.vector, []);
  assert.deepEqual(served.ddos.topTargetLocations, []);
  assert.deepEqual(served.traffic.anomalies, []);
  assert.equal(served.traffic.totalCount, 0);
});

test('an HTTP-200 error envelope is a failure, not an empty result', () => {
  for (const spec of ['success-false', 'errors-present', 'errors-not-array', 'no-result', 'not-configured']) {
    const entries = lastGoodEntries();
    const before = new Map(entries);
    const run = runSeeder({ entries, plan: { protocol: spec, traffic: spec } });

    for (const key of [DDOS_KEY, TRAFFIC_KEY, DDOS_META_KEY, TRAFFIC_META_KEY]) {
      assert.equal(
        run.store.get(key), before.get(key),
        `${spec}: ${key} must keep its last-good value and success clock`,
      );
    }
    assert.deepEqual(
      expireCommandsFor(run.redisCommands, DDOS_KEY).map((command) => command[2]), [DDOS_TTL],
      `${spec}: the failed DDoS key is retained at its own TTL`,
    );
    assert.deepEqual(
      expireCommandsFor(run.redisCommands, TRAFFIC_KEY).map((command) => command[2]), [ANOMALIES_TTL],
      `${spec}: the failed traffic key is retained at its own TTL`,
    );
  }
});

test('a companion failure never discards a healthy sibling update', () => {
  const cases = [
    { name: 'ddos alone', plan: { protocol: 'http-503' }, failed: DDOS_KEY, healthy: TRAFFIC_KEY },
    { name: 'vector alone', plan: { vector: 'success-false' }, failed: DDOS_KEY, healthy: TRAFFIC_KEY },
    { name: 'traffic alone', plan: { traffic: 'http-503' }, failed: TRAFFIC_KEY, healthy: DDOS_KEY },
  ];
  for (const { name, plan, failed, healthy } of cases) {
    const entries = lastGoodEntries();
    const before = new Map(entries);
    const run = runSeeder({ entries, plan });

    assert.equal(run.exitCode, 0, `${name}: a companion failure must not block the annotations publish\n${run.output}`);
    assert.equal(run.store.get(failed), before.get(failed), `${name}: the failed companion keeps last-good data`);
    assert.notEqual(run.store.get(healthy), before.get(healthy), `${name}: the healthy companion still publishes`);
    assert.notEqual(
      run.store.get(OUTAGES_KEY), before.get(OUTAGES_KEY),
      `${name}: the canonical outages publish still happens`,
    );
  }
});

test('successful companions publish even when the annotations fetch fails', () => {
  const entries = lastGoodEntries();
  const before = new Map(entries);
  const run = runSeeder({ entries, plan: { annotations: 'http-503' } });

  assert.equal(run.exitCode, GRACEFUL_FETCH_FAILURE_EXIT_CODE, run.output);
  assert.deepEqual(JSON.parse(run.store.get(DDOS_KEY)).protocol, [], 'DDoS publishes despite the annotations failure');
  assert.deepEqual(JSON.parse(run.store.get(TRAFFIC_KEY)), { anomalies: [], totalCount: 0 });
  assert.equal(run.store.get(OUTAGES_KEY), before.get(OUTAGES_KEY), 'the canonical outages payload is retained');
  assert.equal(
    radarPaths(run.radarCalls).filter((path) => path !== 'annotations/outages').length, 4,
    'already-successful companion work is never replayed by the annotations retry',
  );
});

test('an optional DDoS target slice failure still publishes the required summaries', () => {
  for (const spec of ['http-503', 'success-false', 'no-result']) {
    const run = runSeeder({ entries: lastGoodEntries(), plan: { target: spec, payload: 'full' } });

    assert.equal(run.exitCode, 0, `${spec}: ${run.output}`);
    const ddos = JSON.parse(run.store.get(DDOS_KEY));
    assert.deepEqual(ddos.protocol, [{ label: 'TCP', percentage: 70 }, { label: 'UDP', percentage: 30 }], spec);
    assert.deepEqual(ddos.vector, [{ label: 'SYN', percentage: 100 }], spec);
    assert.deepEqual(ddos.topTargetLocations, [], `${spec}: the optional slice degrades to empty`);
    assert.equal(JSON.parse(run.store.get(DDOS_META_KEY)).fetchedAt, NOW, spec);
  }
});

test('a cache write failure leaves the payload and its success clock untouched', () => {
  const entries = lastGoodEntries();
  const before = new Map(entries);
  const run = runSeeder({ entries, plan: { redisRejectKey: TRAFFIC_KEY } });

  assert.equal(run.store.get(TRAFFIC_KEY), before.get(TRAFFIC_KEY), 'a rejected write cannot publish');
  assert.equal(
    run.store.get(TRAFFIC_META_KEY), before.get(TRAFFIC_META_KEY),
    'a rejected write cannot report a fresh success for the older payload',
  );
  assert.notEqual(run.store.get(DDOS_KEY), before.get(DDOS_KEY), 'the sibling companion still publishes');
  assert.deepEqual(
    expireCommandsFor(run.redisCommands, TRAFFIC_KEY).map((command) => command[2]), [ANOMALIES_TTL],
    'the unpublished key is retained at its own TTL',
  );
});

test('a transient cache write failure is retried instead of costing a whole cron interval', () => {
  const entries = lastGoodEntries();
  const run = runSeeder({
    entries,
    plan: { payload: 'full', redisRejectKey: TRAFFIC_KEY, redisRejectAttempts: 1 },
  });

  // Assert the identity, not the count: the last-good fixture also has one
  // record, so a count check would pass on an unpublished retention.
  assert.equal(
    JSON.parse(run.store.get(TRAFFIC_KEY)).anomalies[0].uuid, 'anom-1',
    'the second attempt publishes; one Upstash blip must not skip the cycle',
  );
  assert.equal(JSON.parse(run.store.get(TRAFFIC_META_KEY)).fetchedAt, NOW);
  assert.equal(
    radarPaths(run.radarCalls).filter((path) => path === 'traffic_anomalies').length, 1,
    'the write retry must not replay the provider request',
  );
});

test('the success clock is never advanced ahead of the payload it reports on', () => {
  // Redis EXEC does not roll back, so a torn pair is reachable in principle.
  // Rejecting the seed-meta write proves the ordering leaves only the harmless
  // direction: a fresh payload whose clock lagged, never a fresh clock over an
  // older payload.
  const entries = lastGoodEntries();
  const before = new Map(entries);
  const run = runSeeder({ entries, plan: { payload: 'full', redisRejectKey: TRAFFIC_META_KEY } });

  assert.equal(JSON.parse(run.store.get(TRAFFIC_KEY)).anomalies[0].uuid, 'anom-1', 'the payload still publishes');
  assert.equal(
    run.store.get(TRAFFIC_META_KEY), before.get(TRAFFIC_META_KEY),
    'the clock stays where it was rather than claiming a success for the old payload',
  );
});

test('a required result field that is absent or the wrong type is a failure, not zero records', () => {
  for (const spec of ['field-missing', 'field-wrong-type']) {
    const entries = lastGoodEntries();
    const before = new Map(entries);
    const run = runSeeder({ entries, plan: { protocol: spec, traffic: spec } });

    for (const key of [DDOS_KEY, TRAFFIC_KEY, DDOS_META_KEY, TRAFFIC_META_KEY]) {
      assert.equal(run.store.get(key), before.get(key), `${spec}: ${key} must keep its last-good value`);
    }
  }
});

test('the annotations leg rejects an invalid envelope instead of publishing zero outages', () => {
  for (const spec of ['success-false', 'errors-present', 'no-result', 'field-missing']) {
    const entries = lastGoodEntries();
    const before = new Map(entries);
    const run = runSeeder({ entries, plan: { annotations: spec } });

    assert.equal(run.exitCode, GRACEFUL_FETCH_FAILURE_EXIT_CODE, `${spec}: ${run.output}`);
    assert.equal(
      run.store.get(OUTAGES_KEY), before.get(OUTAGES_KEY),
      `${spec}: an invalid annotations envelope must not publish an empty outage list`,
    );
    assert.equal(run.store.get('seed-meta:infra:outages'), before.get('seed-meta:infra:outages'), spec);
  }
});

test('retention keeps the alarm alive: a failed companion extends its clock key too', () => {
  const entries = lastGoodEntries();
  const run = runSeeder({ entries, plan: { traffic: 'http-503' } });

  // Extending the payload alone would make it immortal under a sustained outage
  // while the 7-day meta expired out from under it — and a present payload with
  // no meta classifies as plain OK, decaying a week-long failure back to green.
  //
  // Asserted through resolveSeedMetaTtl rather than against the bare floor: the
  // marker is written at max(floor, dataTtl), so a companion whose data TTL ever
  // exceeds 7 days would have its marker SHORTENED by a floor-valued EXPIRE.
  // Deriving it here means this test keeps meaning the right thing if a TTL moves.
  assert.deepEqual(
    expireCommandsFor(run.redisCommands, TRAFFIC_META_KEY).map((command) => command[2]),
    [resolveSeedMetaTtl(undefined, ANOMALIES_TTL)],
    'the seed-meta key is extended at its own resolved TTL, never at the data TTL',
  );
  assert.equal(
    JSON.parse(run.store.get(TRAFFIC_META_KEY)).fetchedAt, NOW - 30 * 60_000,
    'extending the clock key must not rewrite the clock',
  );
});

test('an optional slice that could not be confirmed is recorded on the success metadata', () => {
  const degraded = runSeeder({ entries: lastGoodEntries(), plan: { target: 'http-503', payload: 'full' } });
  assert.equal(
    JSON.parse(degraded.store.get(DDOS_META_KEY)).targetLocationsDegraded, true,
    'a silently-empty optional slice must be visible somewhere other than a log line',
  );

  const healthy = runSeeder({ entries: lastGoodEntries(), plan: { payload: 'full' } });
  assert.equal(
    JSON.parse(healthy.store.get(DDOS_META_KEY)).targetLocationsDegraded, undefined,
    'a confirmed slice adds no marker',
  );
  assert.equal(
    JSON.parse(healthy.store.get(DDOS_KEY))._targetLocationsDegraded, undefined,
    'the diagnostic stays on seed-meta and never reaches the published payload',
  );
  const healthyEntry = classifyCompanion('ddosAttacks', DDOS_KEY, DDOS_META_KEY, healthy.store);
  const degradedEntry = classifyCompanion('ddosAttacks', DDOS_KEY, DDOS_META_KEY, degraded.store);
  assert.equal(healthyEntry.status, 'OK');
  assert.deepEqual(degradedEntry, { ...healthyEntry, targetLocationsDegraded: true });
});

test('runSeed retains both companion keys at their own TTLs when the fetch phase fails', () => {
  const run = runSeeder({
    entries: lastGoodEntries(),
    plan: { annotations: 'http-503', protocol: 'http-503', vector: 'http-503', traffic: 'http-503', target: 'http-503' },
  });

  const ttlsFor = (key) => new Set(expireCommandsFor(run.redisCommands, key).map((command) => command[2]));
  assert.deepEqual(ttlsFor(DDOS_KEY), new Set([DDOS_TTL]), 'the DDoS key is never extended at the canonical TTL');
  assert.deepEqual(ttlsFor(TRAFFIC_KEY), new Set([ANOMALIES_TTL]), 'the anomalies key keeps its own TTL, not the canonical one');
  assert.deepEqual(ttlsFor(DDOS_META_KEY), new Set([resolveSeedMetaTtl(undefined, DDOS_TTL)]));
  assert.deepEqual(ttlsFor(TRAFFIC_META_KEY), new Set([resolveSeedMetaTtl(undefined, ANOMALIES_TTL)]));
});

test('each companion payload outlives the health gate that grades it', () => {
  // #7876 moved both keys into MISSING_DATA_IS_FAILURE_KEYS, so an absent
  // payload is now EMPTY (crit) rather than OK. That makes TTL > maxStaleMin
  // load-bearing: health computes seedAge with Math.round and tests
  // `seedAge > maxStaleMin`, so a TTL equal to the gate lets the payload vanish
  // while the meta still reads fresh — a dead seeder reports crit for ~30s
  // before settling into the truthful STALE_SEED warn. Same invariant as
  // tests/seed-ttl-outlives-staleness-fleet.test.mjs, pinned here because these
  // two keys are the ones the strict classification now applies to.
  for (const [name, ttlSeconds] of [['ddosAttacks', DDOS_TTL], ['trafficAnomalies', ANOMALIES_TTL]]) {
    const maxStaleSeconds = health.SEED_META[name].maxStaleMin * 60;
    assert.ok(
      ttlSeconds > maxStaleSeconds,
      `${name}: data TTL (${ttlSeconds}s) must strictly exceed maxStaleMin (${maxStaleSeconds}s), `
      + 'or the key expires before STALE_SEED can fire and a late seeder reports EMPTY/crit',
    );
  }
});

test('a marker whose data TTL exceeds the floor is never re-armed below its own TTL', () => {
  // The rule the two assertions above ride on, pinned directly: EXPIRE replaces
  // rather than extends, and resolveSeedMetaTtl writes a marker at
  // max(floor, dataTtl) — so a retention path that hardcodes the floor would
  // SHORTEN the marker of any key whose data TTL is longer than seven days,
  // recreating the alarm-before-data failure the retention exists to prevent.
  const longDataTtl = SEED_META_MIN_TTL_SECONDS + 86400;
  assert.equal(resolveSeedMetaTtl(undefined, longDataTtl), longDataTtl);
  assert.ok(
    resolveSeedMetaTtl(undefined, longDataTtl) > SEED_META_MIN_TTL_SECONDS,
    'the floor is not always the longest TTL a marker is written with',
  );
  // Today's companions sit below the floor, so both resolve to it — this is what
  // makes the derived assertions above equivalent to the old literal ones.
  assert.equal(resolveSeedMetaTtl(undefined, DDOS_TTL), SEED_META_MIN_TTL_SECONDS);
  assert.equal(resolveSeedMetaTtl(undefined, ANOMALIES_TTL), SEED_META_MIN_TTL_SECONDS);
});

test('a total Radar failure retains every companion payload and clock', () => {
  const entries = lastGoodEntries();
  const before = new Map(entries);
  const run = runSeeder({
    entries,
    plan: { annotations: 'http-503', protocol: 'http-503', vector: 'http-503', traffic: 'http-503', target: 'http-503' },
  });

  assert.equal(run.exitCode, GRACEFUL_FETCH_FAILURE_EXIT_CODE, run.output);
  for (const key of [OUTAGES_KEY, DDOS_KEY, TRAFFIC_KEY, DDOS_META_KEY, TRAFFIC_META_KEY]) {
    assert.equal(run.store.get(key), before.get(key), `${key} must survive a total source failure`);
  }
  assert.equal(
    radarPaths(run.radarCalls).filter((path) => path !== 'annotations/outages').length, 4,
    'a failed companion pass is bounded to one attempt per run',
  );
});

test('healthy to empty to source error to recovery never resurrects an old event', async () => {
  const healthy = runSeeder({ entries: lastGoodEntries(), plan: { payload: 'full' } });
  assert.equal(JSON.parse(healthy.store.get(TRAFFIC_KEY)).anomalies[0].uuid, 'anom-1', healthy.output);

  const emptied = runSeeder({ entries: [...healthy.store], now: NOW + 60_000 });
  assert.deepEqual(JSON.parse(emptied.store.get(TRAFFIC_KEY)), { anomalies: [], totalCount: 0 });

  const errored = runSeeder({
    entries: [...emptied.store],
    plan: { traffic: 'success-false' },
    now: NOW + 120_000,
  });
  assert.equal(
    errored.store.get(TRAFFIC_KEY), emptied.store.get(TRAFFIC_KEY),
    'a source error must not resurrect the pre-empty event',
  );
  assert.equal(
    JSON.parse(errored.store.get(TRAFFIC_META_KEY)).fetchedAt, NOW + 60_000,
    'a source error must not advance the success clock',
  );

  const recovered = runSeeder({ entries: [...errored.store], now: NOW + 180_000 });
  assert.deepEqual(JSON.parse(recovered.store.get(TRAFFIC_KEY)), { anomalies: [], totalCount: 0 });
  assert.equal(JSON.parse(recovered.store.get(TRAFFIC_META_KEY)).fetchedAt, NOW + 180_000);

  const served = await readThroughRpcs(recovered.store);
  assert.deepEqual(served.traffic.anomalies, []);
});
