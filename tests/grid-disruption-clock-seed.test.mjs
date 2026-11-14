import assert from 'node:assert/strict';
import test from 'node:test';
import bootstrap from '../api/bootstrap.js';
import { buildEnvelope } from '../scripts/_seed-envelope-source.mjs';
import {
  afterGridClockPublish, buildGridClockSnapshot, gridClockHealth, GRID_CLOCK_ACTIVATION_KEY,
} from '../scripts/seed-grid-disruption-clock.mjs';
import { __testing__ as health } from '../api/health.js';
import { deriveGridClock, isGridClockSnapshot } from '../shared/grid-disruption-clock.js';
import { BOOTSTRAP_CACHE_KEYS, bootstrapTierKeyNames } from '../shared/bootstrap-tier-keys.js';
import { assertPublicBootstrapCorsHeaders, assertPublicBootstrapSharedCacheHeaders } from './helpers/public-bootstrap-contract.mjs';

const start = Date.UTC(2026, 10, 13, 12);
const tick = 600_000;
function regions(time, count) {
  return ['CA', 'TN'].map(code => ({
    code,
    current: count === null ? null : {
      observedAt: time, customersOut: count, customersTracked: null, coverageKey: code,
      coverageLabel: 'Participating providers', sourceName: 'Provider', sourceUrl: 'https://example.org/',
    },
    warnings: [],
    warningsCheckedAt: time,
    warningSources: [{ kind: 'weather', sourceName: 'Authority', sourceUrl: 'https://example.org/',
      checkedAt: time, status: 'available' }],
  }));
}

test('duplicate snapshots and revised totals only produce one observation per source instant', () => {
  let result = buildGridClockSnapshot(regions(start, 15), null, start);
  result = buildGridClockSnapshot(regions(start, 12), result, start + tick);
  assert.equal(result.regions[0].history.length, 0);
  result = buildGridClockSnapshot(regions(start + 2 * tick, 7), result, start + 2 * tick);
  assert.ok(isGridClockSnapshot(result));
  assert.equal(result.regions[0].history.length, 1);
  assert.equal(deriveGridClock(result.regions[0], start + 2 * tick).changeCustomers, -5);
});

test('after a failed or regressed report, keep history and suppress the next comparison', () => {
  const first = buildGridClockSnapshot(regions(start, 500), null, start);
  for (const unavailable of [regions(start + tick, null), regions(start - tick, 7)]) {
    const gap = buildGridClockSnapshot(unavailable, first, start + tick);
    assert.equal(gap.regions[0].current, null);
    assert.equal(gap.regions[0].history[0].customersOut, 500);
    assert.equal(gridClockHealth(gap, start + tick).freshnessMetaPatch.sourceState, 'degraded');
    const next = buildGridClockSnapshot(regions(start + 2 * tick, 200), gap, start + 2 * tick);
    assert.ok(isGridClockSnapshot(next));
    assert.equal(deriveGridClock(next.regions[0], start + 2 * tick).changeCustomers, null);
  }
});

test('prior notice survives removal and never becomes an active warning on replay', () => {
  const initial = regions(start, 0);
  const warning = { kind: 'weather', sourceName: 'Authority', title: 'Storm warning',
    sourceUrl: 'https://example.org/', issuedAt: start, expiresAt: start + 2 * tick };
  initial[0].warnings.push(warning);
  let result = buildGridClockSnapshot(initial, null, start);
  result = buildGridClockSnapshot(regions(start + tick, 0), result, start + tick);
  assert.deepEqual(result.regions[0].recentWarnings, [warning]);
  assert.equal(deriveGridClock(result.regions[0], start + tick).activeWarnings.length, 0);
  const later = start + 2 * 86400_000;
  result = buildGridClockSnapshot(regions(later, 0), result, later);
  assert.deepEqual(result.regions[0].history, []);
  assert.deepEqual(result.regions[0].recentWarnings, []);
});

test('the consumer selects only the registered public on-demand key', () => {
  assert.equal(BOOTSTRAP_CACHE_KEYS.gridDisruptionClock, 'infra:grid-disruption-clock:v1');
  assert.ok(bootstrapTierKeyNames('on-demand').includes('gridDisruptionClock'));
  for (const tier of ['fast', 'slow']) assert.ok(!bootstrapTierKeyNames(tier).includes('gridDisruptionClock'));
});

test('the first usable publish sets a durable one-way marker, including mixed-age observations', async () => {
  const writes = [];
  const options = { now: start, credentials: () => ({ url: 'fixture', token: 'fixture' }),
    command: async (_url, _token, command) => { writes.push(command); } };
  const unavailable = regions(start, null);
  for (const region of unavailable) region.warningSources[0].status = 'unavailable';
  assert.equal((await afterGridClockPublish({ regions: unavailable }, options)).freshnessMetaPatch.sourceState, 'degraded');
  assert.deepEqual(writes, []);
  const usable = regions(start, 0);
  usable[0].current.partial = true;
  assert.equal((await afterGridClockPublish({ regions: usable }, options)).freshnessMetaPatch.sourceState, 'degraded');
  assert.deepEqual(writes, [['SET', GRID_CLOCK_ACTIVATION_KEY, '1', 'NX']]);
  assert.equal(await afterGridClockPublish({ regions: regions(start, 0) }, options), undefined);
});

test('clock health grants pre-activation grace and enforces missing data and degraded publication afterward', () => {
  const name = 'gridDisruptionClock';
  const key = health.STANDALONE_KEYS[name];
  const metaKey = health.SEED_META[name].key;
  assert.equal(health.ACTIVATION_MARKERS[name], GRID_CLOCK_ACTIVATION_KEY);
  function classify(activated, sourceState) {
    const meta = { fetchedAt: start, recordCount: 2, sourceState };
    return health.classifyKey(name, key, { allowOnDemand: true }, {
      keyStrens: new Map(sourceState ? [[key, 100]] : []),
      keyMetaValues: new Map(sourceState ? [[metaKey, JSON.stringify(meta)]] : []),
      activationStates: new Map([[name, activated]]), keyErrors: new Map(), keyMetaErrors: new Map(), now: start,
    }).status;
  }
  assert.equal(classify(false), 'EMPTY_ON_DEMAND');
  assert.equal(classify(true), 'EMPTY');
  assert.equal(classify(true, 'degraded'), 'SEED_ERROR');
  assert.equal(classify(true, 'ok'), 'OK');
});

test('public on-demand bootstrap preserves reported zero, missing impact and the last known observation', async (t) => {
  for (const [name, value] of Object.entries({
    UPSTASH_REDIS_REST_URL: 'https://redis.test', UPSTASH_REDIS_REST_TOKEN: 'fixture-token',
  })) {
    const original = process.env[name];
    process.env[name] = value;
    t.after(() => {
      if (original === undefined) delete process.env[name];
      else process.env[name] = original;
    });
  }

  const now = start + tick;
  const previous = buildGridClockSnapshot(regions(start, 47), null, start);
  const polled = regions(now, 0);
  polled.find(region => region.code === 'TN').current = null;
  const snapshot = buildGridClockSnapshot(polled, previous, now);
  const envelope = buildEnvelope({ fetchedAt: now, recordCount: snapshot.regions.length,
    sourceVersion: 'grid-disruption-clock-v1', schemaVersion: 1, state: 'OK', data: snapshot });
  let redisValue = JSON.stringify(envelope);
  const fetchMock = t.mock.method(globalThis, 'fetch', async (input, init) => {
    assert.equal(String(input), 'https://redis.test/pipeline');
    assert.deepEqual(JSON.parse(init.body), [['GET', 'infra:grid-disruption-clock:v1']]);
    return Response.json([{ result: redisValue }]);
  });

  const url = 'https://api.worldmonitor.app/api/bootstrap?keys=gridDisruptionClock&public=1';
  const resp = await bootstrap(new Request(url));
  assert.equal(resp.status, 200);
  assertPublicBootstrapCorsHeaders({ assert, resp });
  assertPublicBootstrapSharedCacheHeaders({ assert, resp });
  const body = await resp.json();
  assert.deepEqual(body, { data: { gridDisruptionClock: snapshot }, missing: [] });
  const wire = body.data.gridDisruptionClock;
  assert.ok(isGridClockSnapshot(wire));
  const [california, tennessee] = wire.regions;
  assert.equal(california.current.customersOut, 0);
  assert.equal(deriveGridClock(california, now).phase, 'monitoring');
  assert.equal(tennessee.current, null);
  assert.equal(tennessee.history[0].customersOut, 47);
  assert.equal(deriveGridClock(tennessee, now).phase, 'unknown');

  redisValue = null;
  const miss = await bootstrap(new Request(url));
  assert.equal(miss.status, 200);
  assert.deepEqual(await miss.json(), { data: {}, missing: ['gridDisruptionClock'] });
  assert.equal(miss.headers.get('cache-control'), 'no-store');
  assert.equal(fetchMock.mock.callCount(), 2);
});
