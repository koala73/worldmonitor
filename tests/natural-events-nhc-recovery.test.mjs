import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

import { __testing__ as health } from '../api/health.js';
import {
  fetchNaturalEvents,
  naturalEventsAfterPublish,
  naturalEventsPublishTransform,
} from '../scripts/seed-natural-events.mjs';

const NOW = Date.parse('2026-09-07T10:00:00.000Z');
const MIN = 60_000;
process.env.WM_SEED_RETRY_DELAY_MS = '1';

const collection = (features = []) => ({ type: 'FeatureCollection', features });
const currentStormPoint = {
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [-60, 20] },
  properties: {
    tau: 0,
    stormname: 'Alpha',
    maxwind: 45,
    ssnum: 0,
    stormtype: 'TS',
    advisnum: 7,
    stormnum: 1,
    advdate: new Date(NOW).toISOString(),
  },
};

const retainedStorm = {
  id: 'nhc-AL01-7',
  title: 'Tropical Storm Alpha',
  description: 'Tropical Storm Alpha, Max wind 45 kt',
  category: 'severeStorms',
  categoryTitle: 'Tropical Cyclone',
  lat: 20,
  lon: -60,
  date: NOW - 60_000,
  magnitude: 45,
  magnitudeUnit: 'kt',
  sourceUrl: 'https://www.nhc.noaa.gov/',
  sourceName: 'NHC',
  closed: false,
  stormId: 'nhc-AL01-7',
  stormName: 'Alpha',
  basin: 'AL',
  stormCategory: 0,
  classification: 'Tropical Storm',
  windKt: 45,
  forecastTrack: [],
  conePolygon: [],
  pastTrack: [],
};

const previousNhcSnapshot = {
  version: 1,
  fetchedAt: NOW,
  retainedUntil: NOW + 540 * 60_000,
  events: [retainedStorm],
  lastAttemptAt: NOW,
  consecutiveFailures: 0,
  firstFailureAt: null,
  errorCode: null,
};

function hkoCoverage() {
  return {
    warnings: [],
    dataAvailable: true,
    sourceDecision: {
      source: 'HKO warning summary',
      host: 'data.weather.gov.hk',
      status: 'used',
      reason: 'VALID_EMPTY',
      optional: false,
      requestCount: 1,
    },
  };
}

function eonetEvents(events = [{
  id: 'eonet-volcano-1',
  title: 'Volcano fixture',
  description: '',
  categories: [{ id: 'volcanoes', title: 'Volcanoes' }],
  geometry: [{ date: new Date(NOW).toISOString(), type: 'Point', coordinates: [1, 2] }],
  sources: [],
  closed: null,
}]) {
  return { events };
}

function layerId(input) {
  return Number(new URL(String(input)).pathname.match(/MapServer\/(\d+)\/query$/)?.[1]);
}

function verdict(data, now = NOW) {
  const key = health.BOOTSTRAP_KEYS.naturalEvents;
  const meta = {
    fetchedAt: now,
    recordCount: data.events.length,
    ...naturalEventsAfterPublish(data).freshnessMetaPatch,
  };
  return health.classifyKey('naturalEvents', key, { allowOnDemand: false }, {
    keyStrens: new Map([[key, 1000]]),
    keyErrors: new Map(),
    keyMetaErrors: new Map(),
    keyMetaValues: new Map([[health.SEED_META.naturalEvents.key, JSON.stringify(meta)]]),
    now,
  });
}

async function runNhc({
  now = NOW,
  previous = previousNhcSnapshot,
  eonet = eonetEvents(),
  gdacs = { features: [] },
  hko = hkoCoverage(),
  nhc,
  calls = null,
} = {}) {
  return fetchNaturalEvents({
    now,
    previousNhcSnapshot: previous,
    fetchHkoWarningsFn: async () => {
      if (calls) calls.hko += 1;
      return hko;
    },
    fetchFn: async (input) => {
      const url = String(input);
      if (url.includes('eonet.gsfc.nasa.gov')) {
        if (calls) calls.eonet += 1;
        return Response.json(eonet);
      }
      if (url.includes('gdacs.org')) {
        if (calls) calls.gdacs += 1;
        return Response.json(gdacs);
      }
      if (url.includes('mapservices.weather.noaa.gov')) {
        if (calls) calls.nhc += 1;
        return nhc(input, layerId(input));
      }
      throw new Error(`unexpected request ${url}`);
    },
  });
}

test('retains validated NHC coverage after required point requests fail without replaying healthy providers', async () => {
  const calls = { eonet: 0, gdacs: 0, nhc: 0, hko: 0 };
  const payload = await runNhc({
    now: NOW + 5 * 60_000,
    previous: previousNhcSnapshot,
    calls,
    nhc: async () => new Response('temporarily unavailable', { status: 503 }),
  });

  assert.ok(payload);
  assert.deepEqual(
    payload.events.filter((event) => event.sourceName === 'NHC'),
    [retainedStorm],
  );
  assert.deepEqual(calls, { eonet: 1, gdacs: 6, nhc: 30, hko: 1 });
  assert.equal(payload._nhcSnapshot.fetchedAt, NOW);
  assert.equal(payload._nhcSnapshot.consecutiveFailures, 1);
  assert.equal(verdict(payload, NOW + 5 * MIN).sourceFailurePendingUntil, new Date(NOW + 215 * MIN).toISOString());
});

test('one failed required point layer rejects the whole current NHC slice', async () => {
  const calls = new Map();
  const payload = await runNhc({
    now: NOW + MIN,
    nhc: async (_input, id) => {
      calls.set(id, (calls.get(id) || 0) + 1);
      if (id === 32) return new Response('', { status: 503 });
      if (id === 6) return Response.json(collection([currentStormPoint]));
      return Response.json(collection());
    },
  });

  assert.deepEqual(payload.events.filter(event => event.sourceName === 'NHC'), [retainedStorm]);
  assert.equal(calls.get(32), 2);
  assert.equal(calls.get(6), 1);
  assert.equal(calls.has(8), false, 'optional details are not fetched for an incomplete point slice');
});

test('non-retryable required HTTP failures do not repeat the failed layer', async () => {
  const calls = new Map();
  const payload = await runNhc({
    now: NOW + MIN,
    nhc: async (_input, id) => {
      calls.set(id, (calls.get(id) || 0) + 1);
      return id === 32
        ? new Response('', { status: 400 })
        : Response.json(collection());
    },
  });

  assert.equal(calls.get(32), 1);
  assert.equal(payload._nhcSnapshot.errorCode, 'NHC_POINT_REQUEST_FAILED');
  assert.equal(payload._nhcSnapshot.consecutiveFailures, 2);
});

test('response-body transport failures retry only the failed required layer', async () => {
  const calls = new Map();
  const payload = await runNhc({
    previous: null,
    nhc: async (_input, id) => {
      const attempt = (calls.get(id) || 0) + 1;
      calls.set(id, attempt);
      if (id === 32 && attempt === 1) {
        return {
          ok: true,
          status: 200,
          json: async () => { throw new TypeError('response body terminated'); },
        };
      }
      return Response.json(collection());
    },
  });

  assert.equal(calls.get(32), 2);
  assert.equal(calls.get(6), 1);
  assert.equal(payload._nhcSnapshot.consecutiveFailures, 0);
  assert.deepEqual(payload._nhcSnapshot.events, []);
});

test('malformed required GeoJSON is actionable and cannot earn first-failure pending', async () => {
  let malformedCalls = 0;
  const payload = await runNhc({
    now: NOW + MIN,
    nhc: async (_input, id) => {
      if (id === 32) {
        malformedCalls += 1;
        return Response.json({ features: [] });
      }
      return Response.json(collection(id === 6 ? [currentStormPoint] : []));
    },
  });

  assert.equal(malformedCalls, 1);
  assert.equal(payload._nhcSnapshot.errorCode, 'NHC_POINT_RESPONSE_INVALID');
  assert.equal(payload._nhcSnapshot.consecutiveFailures, 2);
  assert.equal(verdict(payload, NOW + MIN).sourceFailurePendingUntil, undefined);
});

test('non-empty required coverage with invalid current or future points cannot clear retained coverage', async () => {
  for (const invalidPoints of [
    [{ ...currentStormPoint, properties: { ...currentStormPoint.properties, tau: 12 } }],
    [{ ...currentStormPoint, geometry: { type: 'Point', coordinates: [-181, 20] } }],
    [currentStormPoint, {
      ...currentStormPoint,
      geometry: { type: 'Point', coordinates: [-60, 91] },
      properties: { ...currentStormPoint.properties, tau: 12 },
    }],
    [currentStormPoint, {
      ...currentStormPoint,
      properties: { ...currentStormPoint.properties, tau: undefined, fcstprd: undefined },
    }],
  ]) {
    const payload = await runNhc({
      now: NOW + MIN,
      nhc: async (_input, id) => Response.json(collection(id === 6 ? invalidPoints : [])),
    });

    assert.deepEqual(payload.events.filter(event => event.sourceName === 'NHC'), [retainedStorm]);
    assert.equal(payload._nhcSnapshot.errorCode, 'NHC_POINT_RESPONSE_INVALID');
    assert.equal(payload._nhcSnapshot.consecutiveFailures, 2);
  }
});

test('optional cone and past-point failures do not remove a point-confirmed storm', async () => {
  const calls = new Map();
  const payload = await runNhc({
    previous: null,
    nhc: async (_input, id) => {
      calls.set(id, (calls.get(id) || 0) + 1);
      if (id === 8 || id === 11) return new Response('', { status: 503 });
      return Response.json(collection(id === 6 ? [currentStormPoint] : []));
    },
  });

  const storm = payload.events.find(event => event.sourceName === 'NHC');
  assert.equal(storm.id, 'nhc-AL01-7');
  assert.deepEqual(storm.conePolygon, []);
  assert.deepEqual(storm.pastTrack, []);
  assert.equal(calls.get(8), 2);
  assert.equal(calls.get(11), 2);
  assert.equal(payload._nhcSnapshot.consecutiveFailures, 0);
});

test('accepts time-first advisory dates across NHC time zones', async () => {
  for (const [advdate, expectedDate] of [
    ['800 AM PDT Mon Sep 07 2026', '2026-09-07T15:00:00.000Z'],
    ['800 AM AST Mon Sep 07 2026', '2026-09-07T12:00:00.000Z'],
    ['800 AM HST Mon Sep 07 2026', '2026-09-07T18:00:00.000Z'],
    ['1230 PM AST Mon Sep 07 2026', '2026-09-07T16:30:00.000Z'],
  ]) {
    const mariePoint = {
      ...currentStormPoint,
      geometry: { type: 'Point', coordinates: [-124.4, 24.7] },
      properties: {
        ...currentStormPoint.properties,
        stormname: 'Marie',
        stormnum: 13,
        advisnum: '26',
        maxwind: 55,
        advdate,
      },
    };
    const payload = await runNhc({
      previous: null,
      nhc: async (_input, id) => Response.json(collection(id === 188 ? [mariePoint] : [])),
    });

    const storm = payload.events.find(event => event.sourceName === 'NHC');
    assert.ok(storm, advdate);
    assert.equal(storm.id, 'nhc-EP13-26');
    assert.equal(storm.date, Date.parse(expectedDate));
    assert.equal(payload._nhcSnapshot.errorCode, null);
  }
});

test('rejects malformed time-first NHC advisory dates', async () => {
  for (const advdate of [
    '1299 AM PDT Mon Sep 07 2026',
    '0000 AM PDT Mon Sep 07 2026',
    '1300 AM PDT Mon Sep 07 2026',
    '800 AM XYZ Mon Sep 07 2026',
    '800 AM PDT Mon Feb 31 2026',
    '800 AM PDT Tue Sep 07 2026',
  ]) {
    const invalidPoint = {
      ...currentStormPoint,
      properties: { ...currentStormPoint.properties, advdate },
    };
    const payload = await runNhc({
      now: NOW + MIN,
      nhc: async (_input, id) => Response.json(collection(id === 6 ? [invalidPoint] : [])),
    });

    assert.deepEqual(payload.events.filter(event => event.sourceName === 'NHC'), [retainedStorm], advdate);
    assert.equal(payload._nhcSnapshot.errorCode, 'NHC_POINT_RESPONSE_INVALID', advdate);
  }
});

test('invalid optional past-point properties do not remove a point-confirmed storm', async () => {
  const payload = await runNhc({
    previous: null,
    nhc: async (_input, id) => Response.json(collection(
      id === 6 ? [currentStormPoint] : id === 11 ? [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [-61, 19] },
          properties: { intensity: '45', dtg: NOW - MIN },
        },
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [-62, 18] },
          properties: { intensity: 40, dtg: 'not-a-timestamp' },
        },
      ] : [],
    )),
  });

  const storm = payload.events.find(event => event.sourceName === 'NHC');
  assert.equal(storm.id, 'nhc-AL01-7');
  assert.deepEqual(storm.pastTrack, []);
  assert.equal(payload._nhcSnapshot.consecutiveFailures, 0);
});

test('complete valid empty NHC coverage replaces prior storms and all-provider empty is publishable', async () => {
  const payload = await runNhc({
    now: NOW + MIN,
    eonet: eonetEvents([]),
    previous: previousNhcSnapshot,
    nhc: async () => Response.json(collection()),
  });

  assert.deepEqual(payload.events, []);
  assert.deepEqual(payload._nhcSnapshot.events, []);
  assert.equal(payload._nhcSnapshot.fetchedAt, NOW + MIN);
  assert.equal(payload._nhcSnapshot.consecutiveFailures, 0);
});

test('repeated failures preserve the first failure and increment across reason changes', async () => {
  const first = await runNhc({
    now: NOW + MIN,
    nhc: async () => new Response('', { status: 503 }),
  });
  const second = await runNhc({
    now: NOW + 2 * MIN,
    previous: first._nhcSnapshot,
    nhc: async (_input, id) => Response.json(id === 32 ? { broken: true } : collection()),
  });

  assert.equal(first._nhcSnapshot.consecutiveFailures, 1);
  assert.equal(second._nhcSnapshot.consecutiveFailures, 2);
  assert.equal(second._nhcSnapshot.firstFailureAt, NOW + MIN);
  assert.equal(second._nhcSnapshot.fetchedAt, NOW);
  assert.deepEqual(second._nhcSnapshot.events, [retainedStorm]);
  assert.equal(verdict(second, NOW + 2 * MIN).sourceFailurePendingUntil, undefined);
});

test('a complete response recovers the NHC source and replaces the failure episode', async () => {
  const failed = await runNhc({
    now: NOW + MIN,
    nhc: async () => new Response('', { status: 503 }),
  });
  const recovered = await runNhc({
    now: NOW + 2 * MIN,
    previous: failed._nhcSnapshot,
    nhc: async (_input, id) => Response.json(collection(id === 6 ? [currentStormPoint] : [])),
  });

  assert.equal(recovered._nhcSnapshot.fetchedAt, NOW + 2 * MIN);
  assert.equal(recovered._nhcSnapshot.consecutiveFailures, 0);
  assert.equal(recovered._nhcSnapshot.firstFailureAt, null);
  assert.equal(recovered._nhcSnapshot.errorCode, null);
  assert.equal(naturalEventsAfterPublish(recovered).freshnessMetaPatch.sourceState, 'ok');
});

test('a valid empty predecessor keeps its original clock during first-failure pending', async () => {
  const emptyPrevious = { ...previousNhcSnapshot, events: [] };
  const payload = await runNhc({
    now: NOW + MIN,
    previous: emptyPrevious,
    nhc: async () => new Response('', { status: 503 }),
  });

  assert.deepEqual(payload._nhcSnapshot.events, []);
  assert.equal(payload._nhcSnapshot.fetchedAt, NOW);
  assert.equal(payload._nhcSnapshot.consecutiveFailures, 1);
  assert.ok(verdict(payload, NOW + MIN).sourceFailurePendingUntil);
});

test('missing, expired, malformed, or future NHC state is neither retained nor pending', async () => {
  for (const previous of [
    null,
    { ...previousNhcSnapshot, fetchedAt: NOW - 541 * MIN, retainedUntil: NOW - MIN },
    { ...previousNhcSnapshot, events: [{}] },
    { ...previousNhcSnapshot, events: [{
      ...retainedStorm,
      forecastTrack: [{ lat: 91, lon: -60, hour: 12, windKt: 50, category: 0 }],
    }] },
    { ...previousNhcSnapshot, events: [retainedStorm, retainedStorm] },
    { ...previousNhcSnapshot, events: Array.from({ length: 16 }, (_, index) => ({
      ...retainedStorm,
      id: `nhc-AL${String(index + 1).padStart(2, '0')}-7`,
      stormId: `nhc-AL${String(index + 1).padStart(2, '0')}-7`,
    })) },
    { ...previousNhcSnapshot, fetchedAt: NOW + 2 * MIN, retainedUntil: NOW + 542 * MIN },
    { ...previousNhcSnapshot, retainedUntil: NOW + 541 * MIN },
  ]) {
    const payload = await runNhc({
      now: NOW + MIN,
      previous,
      nhc: async () => new Response('', { status: 503 }),
    });
    assert.equal(payload._nhcSnapshot.fetchedAt, null, JSON.stringify(previous));
    assert.deepEqual(payload._nhcSnapshot.events, [], JSON.stringify(previous));
    assert.equal(payload._nhcSnapshot.consecutiveFailures, 2, JSON.stringify(previous));
    assert.equal(verdict(payload, NOW + MIN).sourceFailurePendingUntil, undefined, JSON.stringify(previous));
  }
});

test('provider failure without safe retained coverage cannot publish a blanket empty aggregate', async () => {
  const nhcFailure = await runNhc({
    previous: null,
    eonet: eonetEvents([]),
    nhc: async () => new Response('', { status: 503 }),
  });
  assert.equal(nhcFailure._unsafePublication, true);
  assert.deepEqual(nhcFailure.events, []);
  await assert.rejects(runNhc({
    previous: null,
    eonet: eonetEvents([]),
    hko: { ...hkoCoverage(), dataAvailable: false },
    nhc: async () => Response.json(collection()),
  }), /complete empty coverage/);
});

test('NHC failure without usable retained state cannot replace canonical storms with other providers', async () => {
  const payload = await runNhc({
    previous: null,
    nhc: async () => new Response('', { status: 503 }),
  });

  assert.equal(payload.events.some(event => event.id === 'eonet-volcano-1'), true);
  assert.equal(payload._nhcSnapshot.fetchedAt, null);
  assert.equal(payload._unsafePublication, true);
  assert.equal(naturalEventsPublishTransform(payload), null);
});

test('malformed successful EONET or GDACS bodies cannot prove a complete empty aggregate', async () => {
  await assert.rejects(runNhc({
    previous: null,
    eonet: {},
    nhc: async () => Response.json(collection()),
  }), /complete empty coverage/);
  await assert.rejects(runNhc({
    previous: null,
    eonet: eonetEvents([]),
    gdacs: {},
    nhc: async () => Response.json(collection()),
  }), /complete empty coverage/);
});

test('canonical publication strips NHC recovery state and diagnostics', () => {
  const data = {
    events: [retainedStorm],
    westernPacific: { events: [] },
    hkoWarnings: { warnings: [] },
    _nhcSnapshot: previousNhcSnapshot,
    _nhcFailureDetail: 'private transport detail',
    _unsafePublication: false,
  };
  assert.deepEqual(naturalEventsPublishTransform(data), {
    events: [retainedStorm],
    westernPacific: { events: [] },
    hkoWarnings: { warnings: [] },
  });
});

async function seedProcess(initial, now, {
  failStateWrite = false, eonetEmpty = false, eonetFails = false, eonetTransient = false,
  gdacsFails = [], gdacsFeatures = {}, nhcHealthy = false, failSourceStateWrite = false,
} = {}) {
  Date.now = () => now;
  const store = new Map(initial);
  const calls = { eonet: 0, gdacs: 0, nhc: 0, hko: 0 };
  const redis = ([command, key, value]) => {
    if (command === 'SET') { store.set(key, value); return 'OK'; }
    if (command === 'GET') return store.get(key) ?? null;
    if (command === 'DEL') return Number(store.delete(key));
    if (command === 'EXPIRE' || command === 'EVAL') return 1;
    throw new Error(`unexpected Redis command ${command}`);
  };
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input);
    if (url.origin === 'https://redis.nhc.test') {
      if (url.pathname.startsWith('/get/')) {
        return Response.json({ result: store.get(decodeURIComponent(url.pathname.slice(5))) ?? null });
      }
      const body = JSON.parse(init.body);
      if (failStateWrite && body[0] === 'SET' && body[1] === 'natural:events:nhc-snapshot:v1') {
        return new Response('', { status: 403 });
      }
      if (failSourceStateWrite && body[0] === 'SET' && body[1] === 'natural:events:source-snapshots:v1') {
        return new Response('', { status: 403 });
      }
      return Response.json(Array.isArray(body[0])
        ? body.map(command => ({ result: redis(command) }))
        : { result: redis(body) });
    }
    if (url.hostname === 'eonet.gsfc.nasa.gov') {
      calls.eonet += 1;
      if (eonetTransient && calls.eonet === 1) throw new TypeError('fetch failed');
      if (eonetFails) return new Response('', { status: 503 });
      return Response.json({ events: eonetEmpty ? [] : [{
        id: 'eonet-volcano-process', title: 'Volcano process fixture', description: '',
        categories: [{ id: 'volcanoes', title: 'Volcanoes' }],
        geometry: [{ date: new Date(now).toISOString(), type: 'Point', coordinates: [1, 2] }],
        sources: [], closed: null,
      }] });
    }
    if (url.hostname === 'www.gdacs.org') {
      calls.gdacs += 1;
      const type = url.searchParams.get('eventtype') || url.searchParams.get('eventlist');
      if (gdacsFails.includes(type)) return new Response('', { status: 503 });
      return Response.json({ features: gdacsFeatures[type] || [] });
    }
    if (url.hostname === 'mapservices.weather.noaa.gov') {
      calls.nhc += 1;
      if (nhcHealthy) return Response.json({ type: 'FeatureCollection', features: [] });
      return new Response('', { status: 503 });
    }
    if (url.hostname === 'data.weather.gov.hk') {
      calls.hko += 1;
      return Response.json([]);
    }
    throw new Error(`unexpected network request ${url}`);
  };
  process.on('exit', () => console.log(`FIXTURE_RESULT=${JSON.stringify({ store: [...store], calls })}`));
  const module = await import(new URL('../scripts/seed-natural-events.mjs', process.env.TEST_MODULE_URL));
  await module.runNaturalEventsSeed();
}

function runSeedFixture(initial, now, options = {}) {
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', `(${seedProcess.toString()})(${JSON.stringify(initial)}, ${now}, ${JSON.stringify(options)})`], {
    encoding: 'utf8',
    timeout: 10_000,
    env: {
      PATH: process.env.PATH,
      NODE_TEST_CONTEXT: 'child',
      WM_SEED_RETRY_DELAY_MS: '1',
      WM_SEED_ENV_FILE: '/dev/null',
      TEST_MODULE_URL: import.meta.url,
      UPSTASH_REDIS_REST_URL: 'https://redis.nhc.test',
      UPSTASH_REDIS_REST_TOKEN: 'fixture-only',
    },
  });
  const output = result.stdout + result.stderr;
  assert.ok(result.stdout.includes('FIXTURE_RESULT='), output);
  return {
    status: result.status,
    output,
    ...JSON.parse(result.stdout.split('FIXTURE_RESULT=')[1].trim()),
  };
}

test('real seeder persists NHC recovery state before replacing the canonical payload', () => {
  const canonical = JSON.stringify({
    _seed: { fetchedAt: NOW, recordCount: 1, sourceVersion: 'fixture', schemaVersion: 2, state: 'OK' },
    data: { events: [retainedStorm], westernPacific: { events: [] }, hkoWarnings: { warnings: [] } },
  });
  const meta = JSON.stringify({ fetchedAt: NOW, recordCount: 1, sourceState: 'ok' });
  const initial = [
    ['natural:events:v1', canonical],
    ['seed-meta:natural:events', meta],
    ['natural:events:nhc-snapshot:v1', JSON.stringify(previousNhcSnapshot)],
  ];

  const published = runSeedFixture(initial, NOW + 5 * MIN);
  assert.equal(published.status, 0, published.output);
  assert.deepEqual(published.calls, { eonet: 1, gdacs: 6, nhc: 30, hko: 1 });
  const store = new Map(published.store);
  const state = JSON.parse(store.get('natural:events:nhc-snapshot:v1'));
  const publicData = JSON.parse(store.get('natural:events:v1')).data;
  const publishedMeta = JSON.parse(store.get('seed-meta:natural:events'));
  assert.equal(state.fetchedAt, NOW);
  assert.equal(state.consecutiveFailures, 1);
  assert.equal(publicData.events.length, 2);
  assert.equal('_nhcSnapshot' in publicData, false);
  assert.equal('_nhcFailureDetail' in publicData, false);
  assert.equal(publishedMeta.errorCode, 'NHC_POINT_REQUEST_FAILED');
  assert.equal(publishedMeta.lastSourceSuccessAt, NOW);

  const failed = runSeedFixture(initial, NOW + 5 * MIN, { failStateWrite: true });
  assert.notEqual(failed.status, 0, failed.output);
  const failedStore = new Map(failed.store);
  assert.equal(failedStore.get('natural:events:v1'), canonical);
  assert.equal(failedStore.get('seed-meta:natural:events'), meta);
  assert.equal(failedStore.get('natural:events:nhc-snapshot:v1'), JSON.stringify(previousNhcSnapshot));
  assert.deepEqual(failed.calls, { eonet: 1, gdacs: 6, nhc: 30, hko: 1 });
});

test('real seeder preserves canonical data and advances repeated unsafe-empty failures', () => {
  const canonical = JSON.stringify({
    _seed: { fetchedAt: NOW, recordCount: 1, sourceVersion: 'fixture', schemaVersion: 2, state: 'OK' },
    data: { events: [retainedStorm], westernPacific: { events: [] }, hkoWarnings: { warnings: [] } },
  });
  const emptySnapshot = { ...previousNhcSnapshot, events: [] };
  const initial = [
    ['natural:events:v1', canonical],
    ['seed-meta:natural:events', JSON.stringify({ fetchedAt: NOW, recordCount: 1, sourceState: 'ok' })],
    ['natural:events:nhc-snapshot:v1', JSON.stringify(emptySnapshot)],
  ];

  const first = runSeedFixture(initial, NOW + 5 * MIN, { eonetEmpty: true });
  assert.equal(first.status, 0, first.output);
  const firstStore = new Map(first.store);
  assert.equal(firstStore.get('natural:events:v1'), canonical);
  assert.equal(JSON.parse(firstStore.get('natural:events:nhc-snapshot:v1')).consecutiveFailures, 1);
  assert.equal(JSON.parse(firstStore.get('seed-meta:natural:events')).consecutiveSourceFailures, 1);

  const second = runSeedFixture(first.store, NOW + 10 * MIN, { eonetEmpty: true });
  assert.equal(second.status, 0, second.output);
  const secondStore = new Map(second.store);
  assert.equal(secondStore.get('natural:events:v1'), canonical);
  assert.equal(JSON.parse(secondStore.get('natural:events:nhc-snapshot:v1')).consecutiveFailures, 2);
  assert.equal(JSON.parse(secondStore.get('seed-meta:natural:events')).consecutiveSourceFailures, 2);
});

test('real seeder keeps first-failure diagnostics after a valid zero-record aggregate', () => {
  const canonical = JSON.stringify({
    _seed: { fetchedAt: NOW, recordCount: 0, sourceVersion: 'fixture', schemaVersion: 2, state: 'OK_ZERO' },
    data: { events: [], westernPacific: { events: [] }, hkoWarnings: { warnings: [] } },
  });
  const emptySnapshot = { ...previousNhcSnapshot, events: [] };
  const initial = [
    ['natural:events:v1', canonical],
    ['seed-meta:natural:events', JSON.stringify({ fetchedAt: NOW, recordCount: 0, sourceState: 'ok' })],
    ['natural:events:nhc-snapshot:v1', JSON.stringify(emptySnapshot)],
  ];

  const result = runSeedFixture(initial, NOW + 5 * MIN, { eonetEmpty: true });
  assert.equal(result.status, 0, result.output);
  const store = new Map(result.store);
  const meta = JSON.parse(store.get('seed-meta:natural:events'));
  assert.equal(store.get('natural:events:v1'), canonical);
  assert.equal(meta.recordCount, 0);
  assert.equal(meta.sourceState, 'degraded');
  assert.equal(meta.lastSourceSuccessAt, NOW);
  assert.equal(meta.consecutiveSourceFailures, 1);
});

test('real seeder retains failed EONET/GDACS sources and writes their honest success times', () => {
  const flood = { type: 'Feature', geometry: { type: 'Point', coordinates: [20, 30] }, properties: {
    eventtype: 'FL', eventid: 1, alertlevel: 'Orange', fromdate: new Date(NOW).toISOString(), name: 'Flood',
  } };
  const first = runSeedFixture([], NOW, { nhcHealthy: true, gdacsFeatures: { FL: [flood] } });
  assert.equal(first.status, 0, first.output);
  const second = runSeedFixture(first.store, NOW + 60 * MIN, { nhcHealthy: true, eonetFails: true, gdacsFails: ['FL'] });
  assert.equal(second.status, 0, second.output);
  const store = new Map(second.store);
  const envelope = JSON.parse(store.get('natural:events:v1'));
  const meta = JSON.parse(store.get('seed-meta:natural:events'));
  assert.equal(envelope._seed.fetchedAt, NOW + 60 * MIN, 'publication time advances');
  assert.equal(envelope.data.fetchedAt, NOW, 'full-source observation time does not');
  assert.deepEqual(envelope.data.events.map(event => event.id).sort(), ['eonet-volcano-process', 'gdacs-FL-1']);
  assert.equal('_sourceSnapshots' in envelope.data, false);
  assert.equal('_eonetFailed' in envelope.data, false);
  assert.deepEqual(meta.failedSources, ['gdacs:FL', 'eonet']);
  assert.equal(meta.sourceHealth.eonet.lastSuccessAt, NOW);
  assert.equal(meta.sourceHealth.eonet.status, 'retained');
  assert.equal(meta.sourceHealth['gdacs:FL'].lastSuccessAt, NOW);
  assert.deepEqual(second.calls, { eonet: 2, gdacs: 7, nhc: 15, hko: 1 });

  const recovered = runSeedFixture(second.store, NOW + 120 * MIN, { nhcHealthy: true, eonetTransient: true });
  assert.equal(recovered.status, 0, recovered.output);
  const recoveredStore = new Map(recovered.store);
  const recoveredEnvelope = JSON.parse(recoveredStore.get('natural:events:v1'));
  const recoveredMeta = JSON.parse(recoveredStore.get('seed-meta:natural:events'));
  assert.deepEqual(recoveredEnvelope.data.events.map(event => event.id), ['eonet-volcano-process']);
  assert.equal(recoveredEnvelope.data.fetchedAt, NOW + 120 * MIN);
  assert.equal(recoveredMeta.sourceHealth.eonet.lastSuccessAt, NOW + 120 * MIN);
  assert.equal(recoveredMeta.sourceState, 'ok');
  assert.deepEqual(recoveredMeta.failedSources, []);
  assert.deepEqual(recovered.calls, { eonet: 2, gdacs: 6, nhc: 15, hko: 1 });

  const failed = runSeedFixture(first.store, NOW + 60 * MIN, { nhcHealthy: true, failSourceStateWrite: true });
  assert.notEqual(failed.status, 0, failed.output);
  const failedStore = new Map(failed.store);
  for (const key of ['natural:events:v1', 'seed-meta:natural:events', 'natural:events:source-snapshots:v1']) {
    assert.equal(failedStore.get(key), new Map(first.store).get(key), key);
  }
  assert.deepEqual(failed.calls, { eonet: 1, gdacs: 6, nhc: 15, hko: 1 });
});
