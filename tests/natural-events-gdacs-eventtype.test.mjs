import assert from 'node:assert/strict';
import { test } from 'node:test';

import { __testing__ as health } from '../api/health.js';
import {
  fetchGdacs,
  fetchNaturalEvents,
  naturalEventsAfterPublish,
  naturalEventsPublishTransform,
} from '../scripts/seed-natural-events.mjs';

// GDACS changed `/gdacsapi/api/events/geteventlist/MAP` on or before 2026-09-16:
// a request without `eventtype` now answers `400 {"message":"Eventtype is
// required."}`, and `eventtype=ALL` or a `;`-joined list answers
// `400 {"message":"Please specify only 1 eventtype."}` (both probed live). The
// seeder had issued one bare MAP request since #5276, so every run logged
// `[GDACS] GDACS 400` and, whenever EONET also blipped, crashed gracefully
// (seed-natural-events, 4 of 4 runs in the 36 h window on 2026-09-16).

const NOW = Date.parse('2026-09-16T18:00:00.000Z');
const GDACS_TYPES = ['EQ', 'FL', 'TC', 'VO', 'WF', 'DR'];

function feature(eventtype, eventid, alertlevel, extra = {}) {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [10 + (eventid % 90), 20 + (eventid % 60)] },
    properties: {
      eventtype,
      eventid,
      alertlevel,
      name: `${eventtype} ${eventid}`,
      description: `${eventtype} event`,
      fromdate: new Date(NOW - eventid * 60_000).toISOString(),
      url: { report: `https://www.gdacs.org/report.aspx?eventid=${eventid}&eventtype=${eventtype}` },
      ...extra,
    },
  };
}

/** Replicates the live endpoint contract observed on 2026-09-16. */
function gdacsStub(byType, { fail = {} } = {}) {
  const requests = [];
  const fetchFn = async (input) => {
    const url = new URL(String(input));
    requests.push(url);
    assert.ok(url.hostname === 'www.gdacs.org', `unexpected host ${url.hostname}`);
    const eventtype = url.searchParams.get('eventtype') || url.searchParams.get('eventlist');
    if (!eventtype) return Response.json({ message: 'Eventtype is required.' }, { status: 400 });
    if (eventtype.includes(';') || eventtype === 'ALL') {
      return Response.json({ message: 'Please specify only 1 eventtype.' }, { status: 400 });
    }
    if (fail[eventtype]) return new Response('upstream unavailable', { status: fail[eventtype] });
    return Response.json({ type: 'FeatureCollection', features: byType[eventtype] ?? [] });
  };
  return { fetchFn, requests };
}

test('requests one list per GDACS event type and merges the non-green events', async () => {
  const { fetchFn, requests } = gdacsStub({
    EQ: [feature('EQ', 1, 'Orange')],
    FL: [feature('FL', 2, 'Orange'), feature('FL', 3, 'Green')],
    TC: [feature('TC', 4, 'Red', { severitydata: { severitytext: 'Cat 3' } })],
  });

  const { events, failedTypes } = await fetchGdacs(fetchFn);

  assert.deepEqual(
    requests.map((u) => u.searchParams.get('eventtype') || u.searchParams.get('eventlist')).sort(),
    [...GDACS_TYPES].sort(),
    'one request per known GDACS event type',
  );
  assert.equal(requests.filter((u) => u.pathname.endsWith('/geteventlist/MAP')).length, 5);
  assert.equal(requests.filter((u) => u.pathname.endsWith('/geteventlist/SEARCH')).length, 1);
  assert.deepEqual(failedTypes, []);
  assert.deepEqual(events.map((e) => e.id).sort(), ['gdacs-EQ-1', 'gdacs-FL-2', 'gdacs-TC-4']);
  assert.equal(events.find((e) => e.id === 'gdacs-FL-2').category, 'floods');
  assert.equal(events.find((e) => e.id === 'gdacs-TC-4').description, 'TC event - Cat 3');
});

test('a failing type is reported as partial coverage, not dropped and not fatal', async () => {
  const { fetchFn } = gdacsStub({ EQ: [feature('EQ', 1, 'Orange')] }, { fail: { VO: 503 } });

  const { events, failedTypes } = await fetchGdacs(fetchFn);

  assert.deepEqual(events.map((e) => e.id), ['gdacs-EQ-1']);
  assert.deepEqual(failedTypes.map((t) => t.eventtype), ['VO']);
  assert.match(failedTypes[0].message, /GDACS 503 \(VO\)/);
});

test('rejects only when every type list failed — the pre-existing "no GDACS at all" path', async () => {
  const fail = Object.fromEntries(GDACS_TYPES.map((t) => [t, 503]));
  const { fetchFn } = gdacsStub({}, { fail });

  await assert.rejects(fetchGdacs(fetchFn), /GDACS unavailable: .*GDACS 503 \(EQ\)/);
});

test('the 100-event cap ranks by alert level then recency, so a flood of earthquakes cannot evict a Red cyclone', async () => {
  // Per-type lists arrive grouped; capping the raw concatenation would let
  // 120 Orange earthquakes (EQ is first in insertion order) push every TC out,
  // including the member the western-Pacific snapshot is built from.
  const earthquakes = Array.from({ length: 120 }, (_, i) => feature('EQ', 1000 + i, 'Orange'));
  const { fetchFn } = gdacsStub({
    EQ: earthquakes,
    TC: [feature('TC', 5000, 'Red', { fromdate: new Date(NOW - 7 * 24 * 60 * 60_000).toISOString() })],
    FL: [feature('FL', 6000, 'Orange', { fromdate: new Date(NOW).toISOString() })],
  });

  const { events } = await fetchGdacs(fetchFn);

  assert.equal(events.length, 100);
  assert.equal(events[0].id, 'gdacs-TC-5000', 'Red outranks Orange regardless of age');
  assert.equal(events[1].id, 'gdacs-FL-6000', 'among Orange, the newest event comes first');
  assert.equal(events.filter((e) => e.category === 'earthquakes').length, 98);
});

test('dedupes an event that GDACS lists under two types by eventtype+eventid, not eventid alone', async () => {
  const { fetchFn } = gdacsStub({
    EQ: [feature('EQ', 7, 'Orange'), feature('EQ', 7, 'Orange')],
    FL: [feature('FL', 7, 'Orange')],
  });

  const { events } = await fetchGdacs(fetchFn);

  assert.deepEqual(events.map((e) => e.id).sort(), ['gdacs-EQ-7', 'gdacs-FL-7']);
});

// ── the reader: fetchNaturalEvents + publish/after-publish ─────────────────

function hkoCoverage(dataAvailable = true) {
  return {
    warnings: [],
    dataAvailable,
    sourceDecision: {
      source: 'HKO warning summary',
      host: 'data.weather.gov.hk',
      status: dataAvailable ? 'used' : 'blocked',
      reason: dataAvailable ? 'VALID_EMPTY' : 'FETCH_FAILED',
      optional: false,
      requestCount: 1,
    },
  };
}

const retainedNhcSnapshot = {
  version: 1,
  fetchedAt: NOW - 5 * 60_000,
  retainedUntil: NOW - 5 * 60_000 + 540 * 60_000,
  events: [],
  lastAttemptAt: NOW - 5 * 60_000,
  consecutiveFailures: 0,
  firstFailureAt: null,
  errorCode: null,
};

function runNatural({
  gdacs,
  gdacsFail = {},
  eonet = { events: [] },
  hko = hkoCoverage(),
  nhc = async () => Response.json({ type: 'FeatureCollection', features: [] }),
  previousNhcSnapshot = null,
} = {}) {
  const { fetchFn: gdacsFetch } = gdacsStub(gdacs, { fail: gdacsFail });
  return fetchNaturalEvents({
    now: NOW,
    previousNhcSnapshot,
    fetchHkoWarningsFn: async () => hko,
    fetchFn: async (input, init) => {
      const { hostname } = new URL(String(input));
      if (hostname === 'eonet.gsfc.nasa.gov') return Response.json(eonet);
      if (hostname === 'www.gdacs.org') return gdacsFetch(input, init);
      if (hostname === 'mapservices.weather.noaa.gov') return nhc(input, init);
      throw new Error(`unexpected request ${hostname}`);
    },
  });
}

function classify(data, now = NOW) {
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

test('partial GDACS coverage publishes the answered types and marks the seed degraded', async () => {
  const data = await runNatural({
    gdacs: { EQ: [feature('EQ', 1, 'Orange')], FL: [feature('FL', 2, 'Orange')] },
    gdacsFail: { VO: 503 },
  });

  assert.equal(data._unsafePublication, false, 'a non-empty feed publishes');
  assert.deepEqual(data.events.map((e) => e.id).sort(), ['gdacs-EQ-1', 'gdacs-FL-2'], 'answered types are kept');
  assert.deepEqual(data._gdacsFailedTypes, ['VO']);
  assert.equal(naturalEventsPublishTransform(data)._gdacsFailedTypes, undefined, 'internal marker never reaches Redis');

  const after = naturalEventsAfterPublish(data);
  assert.equal(after.completionState, 'DEGRADED');
  assert.equal(after.freshnessMetaPatch.sourceState, 'degraded');
  assert.equal(after.freshnessMetaPatch.errorCode, 'GDACS_TYPE_COVERAGE_INCOMPLETE');
  assert.deepEqual(after.freshnessMetaPatch.failedSources, ['gdacs:VO']);

  const verdict = classify(data);
  assert.notEqual(verdict.status, 'ok', 'health must not show a clean badge over partial coverage');
});

test('complete GDACS coverage still reports ok', async () => {
  const data = await runNatural({ gdacs: { EQ: [feature('EQ', 1, 'Orange')] } });

  assert.deepEqual(data._gdacsFailedTypes, []);
  const { freshnessMetaPatch } = naturalEventsAfterPublish(data);
  assert.equal(freshnessMetaPatch.sourceState, 'ok');
  assert.deepEqual(freshnessMetaPatch.failedSources, []);
  assert.ok(Object.values(freshnessMetaPatch.sourceHealth).every(source => source.status === 'ok'));
});

test('an empty feed with a missing type is still refused — partial coverage never proves emptiness', async () => {
  await assert.rejects(
    runNatural({ gdacs: {}, gdacsFail: { DR: 503 } }),
    /cannot prove complete empty coverage/,
  );
});

test('western-Pacific cyclone coverage is proven by the TC list, not by any other type answering', async () => {
  const tcFailed = await runNatural({
    gdacs: { EQ: [feature('EQ', 1, 'Orange')] },
    gdacsFail: { TC: 503 },
    hko: hkoCoverage(false),
  });
  assert.equal(tcFailed.westernPacific.dataAvailable, false, 'five healthy lists say nothing about cyclones');

  const voFailed = await runNatural({
    gdacs: { EQ: [feature('EQ', 1, 'Orange')] },
    gdacsFail: { VO: 503 },
    hko: hkoCoverage(false),
  });
  assert.equal(voFailed.westernPacific.dataAvailable, true, 'the TC list answered, so the empty cyclone set is real');
});

test('the feed cap never decides whether a cyclone exists: TC events stay available uncapped', async () => {
  // 120 newer Orange earthquakes outrank an older Orange typhoon in the capped
  // feed, but the cyclone snapshot must still see it — its dataAvailable says
  // the TC list answered, so an omitted storm would be a vouched-for absence.
  const earthquakes = Array.from({ length: 120 }, (_, i) => feature('EQ', 1000 + i, 'Orange'));
  const typhoon = feature('TC', 5000, 'Orange', {
    fromdate: new Date(NOW - 30 * 24 * 60 * 60_000).toISOString(),
    eventname: 'Typhoon Fixture',
    severitydata: { severity: 120, severitytext: 'Typhoon' },
  });
  const { fetchFn } = gdacsStub({ EQ: earthquakes, TC: [typhoon] });

  const { events, cycloneEvents } = await fetchGdacs(fetchFn);

  assert.equal(events.length, 100);
  assert.equal(events.some((e) => e.id === 'gdacs-TC-5000'), false, 'capped out of the general feed');
  assert.deepEqual(cycloneEvents.map((e) => e.id), ['gdacs-TC-5000'], 'but retained for the cyclone snapshot');
});

test('a GDACS gap during an NHC failure is reported, not hidden behind the NHC grace period', async () => {
  const data = await runNatural({
    gdacs: { EQ: [feature('EQ', 1, 'Orange')] },
    gdacsFail: { FL: 503 },
    previousNhcSnapshot: retainedNhcSnapshot,
    nhc: async () => new Response('temporarily unavailable', { status: 503 }),
  });

  assert.equal(data._unsafePublication, false, 'the retained NHC snapshot keeps the run publishable');
  assert.equal(data._nhcSnapshot.consecutiveFailures, 1);

  const after = naturalEventsAfterPublish(data);
  assert.equal(after.completionState, 'DEGRADED');
  assert.equal(after.freshnessMetaPatch.errorCode, 'GDACS_TYPE_COVERAGE_INCOMPLETE', 'no health policy grants this code grace');
  assert.deepEqual(after.freshnessMetaPatch.failedSources, ['gdacs:FL', 'nhc']);
  assert.equal(after.freshnessMetaPatch.nhcErrorCode, data._nhcSnapshot.errorCode);
  assert.equal(after.freshnessMetaPatch.consecutiveSourceFailures, 1, 'NHC diagnostics ride along');

  const verdict = classify(data);
  assert.notEqual(verdict.status, 'ok');
  assert.equal(verdict.sourceFailurePendingUntil, undefined, 'not parked in the NHC pending bucket');
});
