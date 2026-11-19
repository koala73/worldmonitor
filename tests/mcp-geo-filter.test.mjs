import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';

import handler from '../api/mcp.ts';
import { executeTool } from '../api/mcp/dispatch.ts';
import { TOOL_REGISTRY, buildPublicTool } from '../api/mcp/registry/index.ts';
import { validateToolArgs } from '../api/mcp/_validate-args.ts';
import { RpcValidationError } from '../api/mcp/billing-denial.ts';
import { CII_RISK_SCORE_CACHE_KEYS } from '../api/_cii-risk-cache-keys.js';
import { filterNaturalDisastersPanelData } from '../api/mcp/_natural-disasters-reuse.ts';
import { filterConflictPanelEvents } from '../api/mcp/registry/cache-tools.ts';
import { filterRows, locationPoint, locator } from '../api/mcp/_geo-filter.ts';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
const DAY = 86_400_000;
const KM_PER_DEGREE = 6371.0088 * Math.PI / 180;
const ATHENS = { lat: 37.9838, lon: 23.7275 };
const northOfAthens = km => ATHENS.lat + km / KM_PER_DEGREE;
const at = (latitude, longitude) => ({ latitude, longitude });
const ago = days => Date.now() - days * DAY;

const tool = name => TOOL_REGISTRY.find(candidate => candidate.name === name);
const ids = rows => rows.map(row => row.id);
const outputValidator = name => new Ajv2020({ allowUnionTypes: true, strict: true, strictRequired: false, validateFormats: false })
  .compile(buildPublicTool(tool(name), { compressDescriptions: true }).outputSchema.anyOf[0]);

let store;
let fetched;

function seed() {
  const ucdp = (id, lat, lon, days) => ({ id, country: 'X', location: at(lat, lon), dateStart: ago(days), deathsBest: 1 });
  const unrest = (id, location, days) => ({ id, country: 'X', location, occurredAt: days === null ? 0 : ago(days), fatalities: 0 });
  store = new Map(Object.entries({
    'conflict:ucdp-events:v1': { events: [
      ucdp('donetsk', 48.0, 37.8, 2), ucdp('kyiv', 50.45, 30.52, 2), ucdp('fiji', -17.7, 179.5, 3),
      ucdp('tonga', -21.1, -175.2, 3), ucdp('sydney', -33.9, 151.2, 3), ucdp('old-horlivka', 48.3, 38.05, 8),
    ] },
    'unrest:events:v1': { events: [
      unrest('kramatorsk', at(48.72, 37.56), 1), unrest('athens', at(37.98, 23.73), 1),
      unrest('no-coords', null, 1), unrest('undated-mariupol', at(47.1, 37.55), null),
    ], clusters: [] },
    [CII_RISK_SCORE_CACHE_KEYS.stale]: { ciiScores: [{ region: 'UA', score: 80 }, { region: 'GR', score: 20 }], strategicRisks: [] },
    'seismology:earthquakes:v1': { earthquakes: [
      { id: 'aegean', magnitude: 5.1, location: at(38.5, 25.0), occurredAt: ago(1) },
      { id: 'unlocated', magnitude: 4.8, location: null, occurredAt: ago(1) },
      { id: 'gulf-of-guinea', magnitude: 4.7, location: at(0, 0), occurredAt: ago(1) },
    ] },
    'wildfire:fires:v1': { fireDetections: [
      { id: 'sydney', location: at(-33.9, 151.2), detectedAt: ago(0.5) },
      { id: 'parnitha', location: at(northOfAthens(20), ATHENS.lon), detectedAt: ago(0.5) },
      { id: 'kalamos-99km', location: at(northOfAthens(99), ATHENS.lon), detectedAt: ago(0.9) },
      { id: 'lamia-101km', location: at(northOfAthens(101), ATHENS.lon), detectedAt: ago(0.9) },
      { id: 'marathon', location: at(38.15, 23.96), detectedAt: ago(2) },
      { id: 'unlocated', detectedAt: ago(0.9) },
    ] },
    'natural:events:v1': { events: [
      { id: 'storm', title: 'Storm', category: 'severeStorms', lat: 14.0, lon: 120.0, date: ago(1), closed: false },
      { id: 'tonga-volcano', title: 'Volcano', category: 'volcanoes', lat: -20.55, lon: -175.39, date: ago(2), closed: false },
    ], westernPacific: { dataAvailable: true, events: [
      { id: 'cyclone:wp', title: 'Typhoon', category: 'severeStorms', lat: 21.0, lon: 120.0, date: ago(1), closed: false },
    ] }, hkoWarnings: { dataAvailable: true, warnings: [
      { agency: 'HKO', title: 'Hong Kong Signal 8', observedAt: ago(1), lat: 22.3193, lon: 114.1694 },
    ] } },
  }));
  for (const key of [...store.keys()]) store.set(`seed-meta:${key.replace(/:v\d+$/, '').replace(/:sebuf:stale$/, '')}`, { fetchedAt: Date.now(), recordCount: 3 });
}

beforeEach(() => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://geo-redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fixture-token';
  process.env.WORLDMONITOR_VALID_KEYS = 'wm_geo_fixture';
  seed();
  fetched = [];
  globalThis.fetch = async input => {
    const url = new URL(String(input?.url ?? input));
    assert.equal(url.origin, 'https://geo-redis.test', 'cached reads must not reach a provider');
    const key = decodeURIComponent(url.pathname.replace(/^\/get\//, ''));
    fetched.push(key);
    if (url.pathname.startsWith('/get/')) return Response.json({ result: store.has(key) ? JSON.stringify(store.get(key)) : null });
    return Response.json({ result: null });
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});

const disasters = args => executeTool(tool('get_natural_disasters'), { limit: 0, ...args });
const conflict = args => executeTool(tool('get_conflict_events'), { limit: 0, ...args });

describe('get_natural_disasters geo and time filters', () => {
  it('a 100 km radius around Athens keeps the Greek fires inside it and drops the one at 101 km', async () => {
    const result = await disasters({ dataset: ['wildfires'], lat: ATHENS.lat, lon: ATHENS.lon, radius_km: 100 });
    assert.deepEqual(ids(result.data.fires.fireDetections), ['parnitha', 'kalamos-99km', 'marathon']);
    assert.deepEqual(Object.keys(result.data).sort(), ['fires', 'geo_filter']);
    assert.deepEqual(result.data.geo_filter, {
      area: { kind: 'radius', lat: ATHENS.lat, lon: ATHENS.lon, radius_km: 100 },
      since_days: null,
      excluded: { fires: { without_location: 1, without_time: 0 } },
      oldest_held: {},
    });
    assert.ok(outputValidator('get_natural_disasters')(result), 'advertised outputSchema accepts geo_filter');
  });

  it('excludes rows without coordinates from every dataset and counts them; (0,0) is a real point', async () => {
    const result = await disasters({ bbox: { sw_lat: -1, sw_lon: -1, ne_lat: 1, ne_lon: 1 } });
    assert.deepEqual(ids(result.data.earthquakes.earthquakes), ['gulf-of-guinea']);
    assert.deepEqual(result.data.fires.fireDetections, []);
    assert.deepEqual(result.data.events.events, []);
    assert.deepEqual(result.data.geo_filter.excluded, {
      earthquakes: { without_location: 1, without_time: 0 },
      fires: { without_location: 1, without_time: 0 },
    });
  });

  it('an antimeridian bbox keeps Tonga natural events and drops the Philippines storm', async () => {
    const result = await disasters({ dataset: ['other'], bbox: { sw_lat: -25, sw_lon: 170, ne_lat: -10, ne_lon: -170 } });
    assert.deepEqual(ids(result.data.events.events), ['tonga-volcano']);
    assert.deepEqual(result.data.geo_filter.excluded, {});
  });

  it('applies limit to the filtered rows, not before the filter', async () => {
    const result = await disasters({ dataset: ['wildfires'], lat: ATHENS.lat, lon: ATHENS.lon, radius_km: 100, limit: 2 });
    assert.deepEqual(ids(result.data.fires.fireDetections), ['parnitha', 'kalamos-99km']);
  });

  it('since_days keeps rows dated within the window', async () => {
    const result = await disasters({ dataset: ['wildfires'], since_days: 1 });
    assert.deepEqual(ids(result.data.fires.fireDetections), ['sydney', 'parnitha', 'kalamos-99km', 'lamia-101km', 'unlocated']);
    assert.deepEqual(result.data.geo_filter.oldest_held, {}, 'a one-day window is covered by the held rows');
  });

  it('since_days wider than the held rows names the oldest held row instead of implying full coverage', async () => {
    const result = await disasters({ dataset: ['wildfires'], since_days: 365 });
    const times = result.data.fires.fireDetections.map(row => row.detectedAt).filter(time => time > 0);
    assert.deepEqual(result.data.geo_filter.oldest_held, { fires: Math.min(...times) });
    assert.ok(outputValidator('get_natural_disasters')(result), 'advertised outputSchema accepts oldest_held');
  });
});

describe('get_natural_disasters regional sub-lists', () => {
  it('filters the western-Pacific and HKO lists with the main event list', async () => {
    const athens = (await disasters({ dataset: ['other'], lat: 37.98, lon: 23.73, radius_km: 100 })).data.events;
    assert.deepEqual([athens.westernPacific.events, athens.hkoWarnings.warnings], [[], []]);
    const hongKong = (await disasters({ dataset: ['other'], lat: 22.3, lon: 114.2, radius_km: 900 })).data.events;
    assert.deepEqual(ids(hongKong.westernPacific.events), ['cyclone:wp']);
    assert.equal(hongKong.hkoWarnings.warnings.length, 1);
  });

  it('applies the same filter on a dedicated panel read', () => {
    const data = filterNaturalDisastersPanelData({ events: structuredClone(store.get('natural:events:v1')) }, { dataset: ['other'], lat: 37.98, lon: 23.73, radius_km: 100 });
    assert.deepEqual([data.events.westernPacific.events, data.events.hkoWarnings.warnings], [[], []]);
  });
});

describe('get_conflict_events geo and time filters', () => {
  it('a 47-49N 36-39E bbox keeps only the Donbas rows and leaves country scores alone', async () => {
    const result = await conflict({ bbox: { sw_lat: 47, sw_lon: 36, ne_lat: 49, ne_lon: 39 } });
    assert.deepEqual(ids(result.data['ucdp-events'].events), ['donetsk', 'old-horlivka']);
    assert.deepEqual(ids(result.data.events.events), ['kramatorsk', 'undated-mariupol']);
    assert.equal(result.data.scores.ciiScores.length, 2);
    assert.deepEqual(result.data.geo_filter, {
      area: { kind: 'bbox', sw_lat: 47, sw_lon: 36, ne_lat: 49, ne_lon: 39 },
      since_days: null,
      excluded: { events: { without_location: 1, without_time: 0 } },
      oldest_held: {},
    });
    assert.ok(outputValidator('get_conflict_events')(result), 'advertised outputSchema accepts geo_filter');
  });

  it('an antimeridian bbox keeps the Fiji and Tonga rows', async () => {
    const result = await conflict({ bbox: { sw_lat: -25, sw_lon: 170, ne_lat: -10, ne_lon: -170 } });
    assert.deepEqual(ids(result.data['ucdp-events'].events), ['fiji', 'tonga']);
    assert.deepEqual(result.data.events.events, []);
  });

  it('since_days=7 drops an 8-day-old row and counts undated rows', async () => {
    const result = await conflict({ bbox: { sw_lat: 47, sw_lon: 36, ne_lat: 49, ne_lon: 39 }, since_days: 7 });
    assert.deepEqual(ids(result.data['ucdp-events'].events), ['donetsk']);
    assert.deepEqual(ids(result.data.events.events), ['kramatorsk']);
    assert.deepEqual(result.data.geo_filter.since_days, 7);
    assert.deepEqual(result.data.geo_filter.excluded, { events: { without_location: 1, without_time: 1 } });
  });

  it('applies limit after the area filter', async () => {
    const result = await conflict({ bbox: { sw_lat: -25, sw_lon: 170, ne_lat: -10, ne_lon: -170 }, limit: 1 });
    assert.deepEqual(ids(result.data['ucdp-events'].events), ['fiji']);
  });

  it('without geo or time arguments the response carries no geo_filter key', async () => {
    for (const result of [await conflict({}), await disasters({})]) {
      assert.equal('geo_filter' in result.data, false);
    }
    assert.equal((await conflict({})).data['ucdp-events'].events.length, 6);
  });
});

describe('dedicated panel filters apply the same geo rules', () => {
  const stored = key => structuredClone(store.get(key));

  it('the disaster panel filter narrows before the cap and reports exclusions', () => {
    const data = filterNaturalDisastersPanelData({ earthquakes: stored('seismology:earthquakes:v1'), fires: stored('wildfire:fires:v1'), events: stored('natural:events:v1') },
      { dataset: ['wildfires'], lat: ATHENS.lat, lon: ATHENS.lon, radius_km: 100, limit: 2 });
    assert.deepEqual(ids(data.fires.fireDetections), ['parnitha', 'kalamos-99km']);
    assert.deepEqual(data.geo_filter.excluded, { fires: { without_location: 1, without_time: 0 } });
  });

  it('the conflict panel filter narrows events and keeps scores', () => {
    const data = filterConflictPanelEvents({ 'ucdp-events': stored('conflict:ucdp-events:v1'), events: stored('unrest:events:v1'), scores: stored(CII_RISK_SCORE_CACHE_KEYS.stale) },
      { bbox: { sw_lat: -25, sw_lon: 170, ne_lat: -10, ne_lon: -170 }, limit: 0 });
    assert.deepEqual(ids(data['ucdp-events'].events), ['fiji', 'tonga']);
    assert.equal(data.scores.ciiScores.length, 2);
    assert.deepEqual(data.geo_filter.excluded, { events: { without_location: 1, without_time: 0 } });
  });
});

describe('oldest_held describes the stored lists', () => {
  it('ignores rows dropped by other filters when deciding the window is wider than the data held', async () => {
    store.get('conflict:ucdp-events:v1').events.find(row => row.id === 'old-horlivka').deathsBest = 0;
    const result = await conflict({ min_fatalities: 1, since_days: 7 });
    assert.ok(!ids(result.data['ucdp-events'].events).includes('old-horlivka'));
    assert.equal('ucdp-events' in result.data.geo_filter.oldest_held, false, 'the stored UCDP list reaches past the 7-day cutoff');
  });

  it('still names a list whose stored rows are all newer than the cutoff', async () => {
    const result = await conflict({ min_fatalities: 1, since_days: 30 });
    const stored = Math.min(...store.get('conflict:ucdp-events:v1').events.map(row => row.dateStart));
    assert.equal(result.data.geo_filter.oldest_held['ucdp-events'], stored);
  });
});

describe('geo filter exclusion counts', () => {
  const at = (latitude, longitude) => ({ latitude, longitude });
  const locate = locator(locationPoint, 'occurredAt');
  const now = Date.UTC(2026, 9, 20);

  it('counts an undated row only when it lies inside the area', () => {
    const rows = [
      { id: 'near-undated', location: at(48.0, 37.8) },
      { id: 'far-undated', location: at(51.5, -0.1) },
      { id: 'unlocated-undated' },
      { id: 'near-dated', location: at(48.1, 37.9), occurredAt: now - 86_400_000 },
    ];
    const filter = { area: { kind: 'radius', lat: 48.0, lon: 37.8, radiusKm: 50 }, sinceMs: 7 * 86_400_000 };
    const result = filterRows(rows, locate, filter, now);
    assert.deepEqual(ids(result.rows), ['near-dated']);
    assert.equal(result.withoutLocation, 1, 'the unlocated row is reported once, for its location');
    assert.equal(result.withoutTime, 1, 'only the in-area undated row was dropped for lacking a date');
  });
});

describe('geo filter argument validation', () => {
  const invalid = [
    ['bbox with a radius', { bbox: { sw_lat: 1, sw_lon: 1, ne_lat: 2, ne_lon: 2 }, lat: 1, lon: 1, radius_km: 5 }],
    ['bbox with a lone lat', { bbox: { sw_lat: 1, sw_lon: 1, ne_lat: 2, ne_lon: 2 }, lat: 1 }],
    ['lat and lon without radius_km', { lat: 1, lon: 1 }],
    ['radius_km without a centre', { radius_km: 10 }],
    ['sw_lat above ne_lat', { bbox: { sw_lat: 3, sw_lon: 1, ne_lat: 2, ne_lon: 2 } }],
    ['bbox missing a corner', { bbox: { sw_lat: 1, sw_lon: 1, ne_lat: 2 } }],
    ['radius_km of 0', { lat: 1, lon: 1, radius_km: 0 }],
    ['radius_km of 2001', { lat: 1, lon: 1, radius_km: 2001 }],
    ['latitude out of range', { lat: 91, lon: 1, radius_km: 5 }],
    ['since_days of 0', { since_days: 0 }],
    ['since_days of 366', { since_days: 366 }],
    ['fractional since_days', { since_days: 1.5 }],
  ];
  for (const name of ['get_conflict_events', 'get_natural_disasters']) {
    for (const [label, args] of invalid) {
      it(`${name} rejects ${label}`, () => {
        assert.throws(() => validateToolArgs(tool(name), args), RpcValidationError);
      });
    }
    it(`${name} accepts a radius, an antimeridian bbox and since_days`, () => {
      validateToolArgs(tool(name), { lat: 37.98, lon: 23.73, radius_km: 2000, since_days: 365 });
      validateToolArgs(tool(name), { bbox: { sw_lat: -25, sw_lon: 170, ne_lat: -10, ne_lon: -170 }, since_days: 1 });
    });
  }

  it('the MCP handler answers an invalid combination with -32602 before reading any data', async () => {
    const response = await handler(new Request('https://worldmonitor.app/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-WorldMonitor-Key': 'wm_geo_fixture' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_natural_disasters',
        arguments: { bbox: { sw_lat: 37, sw_lon: 23, ne_lat: 39, ne_lon: 25 }, lat: 38, lon: 24, radius_km: 50 } } }),
    }));
    const body = await response.json();
    assert.equal(body.error?.code, -32602, JSON.stringify(body));
    assert.deepEqual(fetched.filter(key => tool('get_natural_disasters')._cacheKeys.includes(key)), []);
  });
});
