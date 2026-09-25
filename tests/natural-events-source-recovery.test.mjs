import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  fetchNaturalEvents,
  naturalEventsAfterPublish,
  naturalEventsPublishTransform,
} from '../scripts/seed-natural-events.mjs';

const NOW = Date.parse('2026-09-17T06:00:00Z');
const HOUR = 3_600_000;

test('EONET survives nine-hour freshness with a fixed eighteen-hour expiry independently of GDACS', async () => {
  const first = await run();
  assert.equal(first._sourceSnapshots.eonet.retainedUntil, NOW + 18 * HOUR);
  assert.equal(first._sourceSnapshots['gdacs:FL'].retainedUntil, NOW + 9 * HOUR);
  const retained = await run({ previousSources: first._sourceSnapshots, now: NOW + 10 * HOUR, failures: ['eonet'], types: { EQ: [feature('EQ', 2)] } });
  assert.ok(retained.events.some(event => event.id === 'eonet-volcano'));
  assert.ok(retained.events.some(event => event.id === 'gdacs-EQ-2'));
  assert.equal(retained.fetchedAt, NOW);
  const repeated = await run({ previousSources: retained._sourceSnapshots, now: NOW + 17 * HOUR, failures: ['eonet'] });
  assert.deepEqual(repeated._sourceSnapshots.eonet, first._sourceSnapshots.eonet);
  const expired = await run({ previousSources: repeated._sourceSnapshots, now: NOW + 18 * HOUR, failures: ['eonet'] });
  assert.equal(expired._sourceSnapshots.eonet, null);
  assert.ok(!expired.events.some(event => event.id === 'eonet-volcano'));
});
const eonet = [{
  id: 'eonet-volcano', title: 'Volcano', categories: [{ id: 'volcanoes' }],
  geometry: [{ type: 'Point', coordinates: [10, 20], date: new Date(NOW).toISOString() }],
  sources: [], closed: null,
}];
const feature = (type, id = 1) => ({
  type: 'Feature', geometry: { type: 'Point', coordinates: [id % 180, 40] },
  properties: { eventtype: type, eventid: id, alertlevel: 'Orange', name: type, fromdate: new Date(NOW).toISOString(), iscurrent: 'false' },
});

async function run({ previousSources, now = NOW, failures = [], eonetBody = { events: eonet }, types = { FL: [feature('FL')] }, requests = [] } = {}) {
  return fetchNaturalEvents({
    now, previousSources,
    fetchHkoWarningsFn: async () => ({ warnings: [], dataAvailable: true, sourceDecision: { status: 'used' } }),
    fetchFn: async (input) => {
      const url = new URL(input);
      requests.push(url);
      const type = url.searchParams.get('eventtype') || url.searchParams.get('eventlist');
      const source = url.hostname.includes('eonet') ? 'eonet' : `gdacs:${type}`;
      if (failures.includes(source)) return new Response('', { status: 503 });
      if (url.hostname.includes('eonet')) return Response.json(eonetBody);
      if (url.hostname === 'www.gdacs.org') {
        // The real VO MAP route is unavailable; it must not be treated as empty.
        if (type === 'VO' && url.pathname.endsWith('/MAP')) return new Response('', { status: 404 });
        return Response.json({ type: 'FeatureCollection', features: types[type] || [] });
      }
      if (url.hostname === 'mapservices.weather.noaa.gov') return Response.json({ type: 'FeatureCollection', features: [] });
      throw new Error(`Unexpected request: ${url}`);
    },
  });
}

test('VO uses bounded SEARCH, not the unavailable MAP route', async () => {
  const requests = [];
  const data = await run({ requests, types: { VO: [feature('VO', 1000148)] } });
  assert.ok(data.events.some(event => event.id === 'gdacs-VO-1000148'));
  assert.deepEqual(data._gdacsFailedTypes, []);
  const vo = requests.find(url => url.searchParams.get('eventlist') === 'VO');
  assert.equal(vo.pathname.split('/').at(-1), 'SEARCH');
  assert.equal(vo.searchParams.get('fromDate'), '2026-08-18');
  assert.equal(vo.searchParams.get('toDate'), '2026-09-17');
  assert.equal(vo.searchParams.get('pageSize'), '100');
  assert.equal(requests.filter(url => url.hostname === 'www.gdacs.org').length, 6);
});

test('VO closure follows SEARCH current state, including during retention and recovery', async () => {
  for (const [iscurrent, closed] of [['false', true], [false, true], ['true', false], [true, false]]) {
    const volcano = feature('VO', 1000148);
    volcano.properties.iscurrent = iscurrent;
    const first = await run({ types: { VO: [volcano] } });
    const second = await run({ previousSources: first._sourceSnapshots, now: NOW + HOUR, failures: ['gdacs:VO'] });
    for (const data of [first, second]) {
      assert.equal(naturalEventsPublishTransform(data).events.find(event => event.id === 'gdacs-VO-1000148').closed, closed);
    }
    volcano.properties.iscurrent = closed ? 'true' : 'false';
    const recovered = await run({ previousSources: second._sourceSnapshots, now: NOW + 2 * HOUR, types: { VO: [volcano] } });
    assert.equal(recovered.events.find(event => event.id === 'gdacs-VO-1000148').closed, !closed);
  }
});

test('VO with missing or malformed current state retains validated coverage instead of claiming activity', async () => {
  const first = await run({ types: { VO: [feature('VO', 1000148)] } });
  for (const iscurrent of [undefined, null, '', 'unknown', 0]) {
    const volcano = feature('VO', 1000148);
    volcano.properties.iscurrent = iscurrent;
    const data = await run({ previousSources: first._sourceSnapshots, now: NOW + HOUR, types: { VO: [volcano] } });
    assert.deepEqual(data._gdacsFailedTypes, ['VO']);
    assert.equal(data._sourceSnapshots['gdacs:VO'].fetchedAt, NOW);
    assert.equal(data.events.find(event => event.id === 'gdacs-VO-1000148').closed, true);
  }
});

test('source failure preserves pre-merge data while healthy companions update, without resetting clocks', async () => {
  const first = await run();
  const second = await run({ previousSources: first._sourceSnapshots, now: NOW + HOUR, failures: ['eonet', 'gdacs:FL'], types: { EQ: [feature('EQ', 2)] } });
  assert.deepEqual(second.events.map(event => event.id).sort(), ['eonet-volcano', 'gdacs-EQ-2', 'gdacs-FL-1']);
  assert.equal(second.fetchedAt, NOW);
  for (const source of ['eonet', 'gdacs:FL']) {
    assert.equal(second._sourceSnapshots[source].fetchedAt, NOW);
    assert.equal(second._sourceSnapshots[source].retainedUntil, NOW + (source === 'eonet' ? 18 : 9) * HOUR);
    const health = naturalEventsAfterPublish(second).freshnessMetaPatch.sourceHealth[source];
    assert.equal(health.status, 'retained');
    assert.equal(health.lastSuccessAt, NOW);
    assert.equal(health.lastAttemptAt, NOW + HOUR);
  }
  assert.deepEqual(naturalEventsAfterPublish(second).freshnessMetaPatch.failedSources, ['gdacs:FL', 'eonet']);
  const third = await run({ previousSources: second._sourceSnapshots, now: NOW + 8 * HOUR, failures: ['eonet', 'gdacs:FL'] });
  assert.equal(third._sourceSnapshots.eonet.retainedUntil, NOW + 18 * HOUR);
  assert.equal(naturalEventsPublishTransform(third)._sourceSnapshots, undefined);
});

test('a valid empty response clears retained records and restores source health', async () => {
  const first = await run();
  const second = await run({ previousSources: first._sourceSnapshots, now: NOW + HOUR, eonetBody: { events: [] }, types: {} });
  assert.deepEqual(second.events, []);
  assert.equal(second._sourceSnapshots.eonet.fetchedAt, NOW + HOUR);
  assert.equal(naturalEventsAfterPublish(second).freshnessMetaPatch.sourceState, 'ok');
});

test('validated empty source observations are retained, but never renewed by failures', async () => {
  const first = await run({ eonetBody: { events: [] }, types: {} });
  const second = await run({ previousSources: first._sourceSnapshots, now: NOW + HOUR, failures: ['eonet', 'gdacs:VO'], types: {} });
  assert.deepEqual(second.events, []);
  assert.equal(second.fetchedAt, NOW);
  assert.equal(naturalEventsAfterPublish(second).freshnessMetaPatch.sourceHealth.eonet.status, 'retained');
  await assert.rejects(run({ previousSources: second._sourceSnapshots, now: NOW + 9 * HOUR, failures: ['eonet', 'gdacs:VO'], types: {} }), /cannot prove complete empty coverage/);
});

test('expired, future or malformed source snapshots cannot be reused', async () => {
  const first = await run();
  const variants = [
    [first._sourceSnapshots, NOW + 18 * HOUR],
    [{ ...first._sourceSnapshots, eonet: { ...first._sourceSnapshots?.eonet, fetchedAt: NOW + HOUR } }, NOW],
    [{ ...first._sourceSnapshots, eonet: { ...first._sourceSnapshots?.eonet, records: [{}] } }, NOW],
  ];
  for (const [previousSources, now] of variants) {
    const data = await run({ previousSources, now, failures: ['eonet'], types: { EQ: [feature('EQ', 2)] } });
    assert.equal(data.events.some(event => event.id === 'eonet-volcano'), false);
    assert.equal(naturalEventsAfterPublish(data).freshnessMetaPatch.sourceHealth.eonet.status, 'unavailable');
  }
});

test('malformed success and full VO search pages retain coverage instead of accepting false success', async () => {
  const first = await run({ types: { VO: [feature('VO', 3)] } });
  const second = await run({
    previousSources: first._sourceSnapshots, now: NOW + HOUR,
    eonetBody: { events: [{ ...eonet[0], geometry: [{ type: 'Point', coordinates: [null, 20], date: 'invalid' }] }] },
    types: { VO: Array.from({ length: 100 }, (_, id) => feature('VO', id)) },
  });
  assert.deepEqual(second.events.map(event => event.id).sort(), ['eonet-volcano', 'gdacs-VO-3']);
  assert.equal(naturalEventsAfterPublish(second).freshnessMetaPatch.sourceHealth.eonet.status, 'retained');
  assert.deepEqual(second._gdacsFailedTypes, ['VO']);
});

test('an EONET event with missing geometry cannot replace last-good data as a valid empty source', async () => {
  const first = await run();
  const second = await run({ previousSources: first._sourceSnapshots, now: NOW + HOUR, eonetBody: { events: [{ ...eonet[0], geometry: [] }] } });
  assert.ok(second.events.some(event => event.id === 'eonet-volcano'));
  assert.equal(naturalEventsAfterPublish(second).freshnessMetaPatch.sourceHealth.eonet.status, 'retained');
});

test('GDACS impact polygons and tracks do not invalidate Point coverage or enter retained snapshots', async () => {
  const point = feature('TC');
  const data = await run({ types: { TC: [point,
    { ...point, geometry: { type: 'Polygon', coordinates: [[[1, 2], [2, 3], [1, 2]]] } },
    { ...point, geometry: { type: 'MultiPolygon', coordinates: [] } },
    { ...point, geometry: { type: 'LineString', coordinates: [[1, 2], [2, 3]] } },
  ] } });
  assert.deepEqual(data._gdacsFailedTypes, []);
  assert.deepEqual(data._sourceSnapshots['gdacs:TC'].records, [point]);
});

test('retention uses source records hidden by the previous aggregate deduplication', async () => {
  const duplicate = { ...eonet[0], categories: [{ id: 'floods' }], geometry: [{ type: 'Point', coordinates: [1, 40], date: new Date(NOW).toISOString() }] };
  const first = await run({ eonetBody: { events: [duplicate] } });
  assert.deepEqual(first.events.map(event => event.id), ['gdacs-FL-1']);
  const second = await run({ previousSources: first._sourceSnapshots, now: NOW + HOUR, failures: ['eonet'], types: {} });
  assert.deepEqual(second.events.map(event => event.id), ['eonet-volcano']);
});

test('all GDACS type requests can fail without discarding valid uncapped last-good sources', async () => {
  const types = { EQ: Array.from({ length: 101 }, (_, id) => feature('EQ', id)) };
  const first = await run({ types });
  assert.equal(first._sourceSnapshots['gdacs:EQ'].records.length, 101);
  const failures = ['EQ', 'FL', 'TC', 'VO', 'WF', 'DR'].map(type => `gdacs:${type}`);
  const second = await run({ previousSources: first._sourceSnapshots, now: NOW + HOUR, failures });
  assert.equal(second.events.filter(event => event.sourceName === 'GDACS').length, 100);
  assert.equal(second._sourceSnapshots['gdacs:EQ'].records.length, 101);
  assert.equal(naturalEventsAfterPublish(second).freshnessMetaPatch.failedSources.length, 6);
});

test('failure logs report fixed retention clocks without changing published health', async (t) => {
  const first = await run();
  const retained = await run({ previousSources: first._sourceSnapshots, now: NOW + HOUR, failures: ['eonet'] });
  const expired = await run({ previousSources: first._sourceSnapshots, now: NOW + 18 * HOUR, failures: ['eonet'] });
  const warnings = [];
  t.mock.method(console, 'warn', message => warnings.push(message));
  const before = structuredClone(retained);
  const result = naturalEventsAfterPublish(retained);
  const prefix = '[natural-events] failed source health=';
  const logged = JSON.parse(warnings.find(message => message.startsWith(prefix)).slice(prefix.length));
  assert.deepEqual(Object.keys(logged), ['eonet']);
  assert.deepEqual(logged.eonet, { ...result.freshnessMetaPatch.sourceHealth.eonet, remainingRetentionMs: 17 * HOUR });
  assert.deepEqual(retained, before);
  assert.equal('remainingRetentionMs' in result.freshnessMetaPatch.sourceHealth.eonet, false);
  warnings.length = 0;
  naturalEventsAfterPublish(expired);
  const unavailable = JSON.parse(warnings.find(message => message.startsWith(prefix)).slice(prefix.length));
  assert.equal(unavailable.eonet.status, 'unavailable');
  assert.equal(unavailable.eonet.lastSuccessAt, null);
  assert.equal(unavailable.eonet.remainingRetentionMs, null);
  warnings.length = 0;
  naturalEventsAfterPublish(first);
  assert.deepEqual(warnings, []);
});
