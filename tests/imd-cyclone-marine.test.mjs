import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { __testing__ as healthTesting } from '../api/health.js';
import {
  IMD_API_REFERENCE_URL,
  IMD_CANONICAL_KEY,
  IMD_HOST,
  IMD_MAX_CONTENT_AGE_MIN,
  IMD_PRODUCTS,
  assembleImdSnapshot,
  buildDisabledSnapshot,
  cycloneEventsFromSnapshot,
  declareImdRecords,
  dropExpiredRecords,
  fetchImdCycloneMarine,
  imdAfterPublish,
  imdLiveFetchEnabled,
  imdProductUrl,
  isAllowedImdHost,
  isNilText,
  marineBulletinsFromSnapshot,
  parseCoastalBulletinPayload,
  parseCycloneCouPayload,
  parseCycloneTrackPayload,
  parseCycloneWindPayload,
  parseImdTrackDateTime,
  parsePortWarningPayload,
  parseSeaBulletinPayload,
  validateImdEnvelope,
  weatherAlertsFromSnapshot,
} from '../scripts/lib/imd-cyclone-marine.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = (name) => JSON.parse(readFileSync(join(root, 'tests/fixtures', name), 'utf8'));
const NOW = Date.parse('2023-11-05T12:00:00.000Z');
const CYCLONE_NOW = Date.parse('2019-11-06T00:00:00.000Z');

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('allows only https://api.imd.gov.in product URLs', () => {
  assert.equal(isAllowedImdHost(imdProductUrl(IMD_PRODUCTS.cycloneTrack)), true);
  assert.equal(isAllowedImdHost('http://api.imd.gov.in/api/v1/cyclone_track'), false);
  assert.equal(isAllowedImdHost('https://evil.example/api/v1/cyclone_track'), false);
  assert.equal(isAllowedImdHost('https://api.imd.gov.in.evil/api/v1/cyclone_track'), false);
  assert.equal(IMD_HOST, 'api.imd.gov.in');
});

test('parses observed and forecast cyclone positions as distinct kinds', () => {
  const records = parseCycloneTrackPayload(fixture('imd-cyclone-track.json'));
  const observed = records.filter((row) => row.pointKind === 'observed');
  const forecast = records.filter((row) => row.pointKind === 'forecast');
  assert.equal(observed.length, 2);
  assert.equal(forecast.length, 2);
  assert.ok(observed.every((row) => row.geometryKind === 'observed-position'));
  assert.ok(forecast.every((row) => row.geometryKind === 'forecast-position'));
  assert.equal(observed[0].stormName, 'BULBUL');
  assert.equal(observed[0].lat, 13.2);
  assert.equal(observed[0].lon, 91.2);
  assert.equal(parseImdTrackDateTime('05.11.19/1200'), Date.UTC(2019, 10, 5, 12, 0));
});

test('tags wind radii and cone geometry as forecast/uncertainty, never observed footprint', () => {
  const winds = parseCycloneWindPayload(fixture('imd-cyclone-wind.json'));
  const cones = parseCycloneCouPayload(fixture('imd-cyclone-cou.json'));
  assert.equal(winds.length, 2);
  assert.ok(winds.every((row) => row.geometryKind === 'forecast-wind-radii'));
  assert.equal(winds[0].thresholdKt, 27);
  assert.equal(cones[0].geometryKind, 'cone-of-uncertainty');
  assert.notEqual(cones[0].geometryKind, 'observed-position');
  assert.ok(Array.isArray(cones[0].polygons[0][0]));
});

test('preserves port authority, issue time, warning text, and does not treat NIL as a warning', () => {
  const rows = parsePortWarningPayload(fixture('imd-port-warning.json'));
  assert.equal(rows.length, 2);
  const chennai = rows.find((row) => row.portName === 'Chennai');
  const mumbai = rows.find((row) => row.portName === 'Mumbai');
  assert.equal(chennai.issuedBy, 'ACWC CHENNAI');
  assert.equal(chennai.isWarning, true);
  assert.equal(chennai.warning, 'Distant Cautionary Signal 1 hoisted');
  assert.equal(mumbai.isWarning, false);
  assert.equal(mumbai.isNil, true);
  assert.ok(chennai.centroid);
  assert.equal(isNilText('NIL at all Ports'), true);
});

test('preserves marine bulletin sea state, wind, visibility, and TTT separately from forecasts', () => {
  const sea = parseSeaBulletinPayload(fixture('imd-sea-bulletin.json'));
  const coastal = parseCoastalBulletinPayload(fixture('imd-coastal-bulletin.json'));
  assert.equal(sea[0].hasTttWarning, false);
  assert.equal(sea[0].isForecastBulletin, true);
  assert.match(sea[0].wind, /East\/ South Easterly/);
  assert.match(sea[0].visibility, /Good Becoming Moderate/);
  assert.match(sea[0].seaCondition, /Smooth/);
  assert.equal(sea[0].issuedBy, 'ACWC KOLKATA');
  assert.equal(sea[1].hasTttWarning, true);
  assert.equal(coastal[0].hasPortSignal, false);
  assert.equal(coastal[1].hasPortSignal, true);
  assert.match(coastal[1].portSignal, /Local Cautionary Signal 3/);
});

test('does not flatten products into a single generic alert list', () => {
  const snapshot = assembleImdSnapshot({
    now: CYCLONE_NOW,
    productResults: {
      cycloneTrack: { status: 'ok', records: parseCycloneTrackPayload(fixture('imd-cyclone-track.json')) },
      cycloneWind: { status: 'ok', records: parseCycloneWindPayload(fixture('imd-cyclone-wind.json')) },
      cycloneCou: { status: 'ok', records: parseCycloneCouPayload(fixture('imd-cyclone-cou.json')) },
      portWarning: { status: 'ok', records: parsePortWarningPayload(fixture('imd-port-warning.json')) },
      seaBulletin: { status: 'ok', records: parseSeaBulletinPayload(fixture('imd-sea-bulletin.json')) },
      coastalBulletin: { status: 'ok', records: parseCoastalBulletinPayload(fixture('imd-coastal-bulletin.json')) },
      fishermenWarning: { status: 'disabled', reason: 'INDEXED_WITHOUT_FIELD_REFERENCE', records: [] },
    },
  });
  assert.equal(validateImdEnvelope(snapshot), true);
  assert.ok(snapshot.cyclones.length > 0);
  assert.ok(Array.isArray(snapshot.cycloneEvents) && snapshot.cycloneEvents.length === 1);
  assert.ok(Array.isArray(snapshot.portAlerts) && snapshot.portAlerts.length === 1);
  assert.ok(snapshot.portWarnings.length > 0);
  assert.ok(snapshot.seaBulletins.length > 0);
  const alerts = weatherAlertsFromSnapshot(snapshot);
  assert.ok(alerts.every((row) => row.productKind === 'imd-port-warning'));
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].issuedBy, 'ACWC CHENNAI');
  const bulletins = marineBulletinsFromSnapshot(snapshot);
  assert.ok(bulletins.some((row) => row.productKind === 'sea-area-bulletin'));
  assert.ok(bulletins.some((row) => row.productKind === 'coastal-bulletin'));
  const events = cycloneEventsFromSnapshot(snapshot);
  assert.equal(events.length, 1);
  assert.equal(events[0].pastTrack[0].geometryKind, 'observed-position');
  assert.equal(events[0].forecastTrack[0].geometryKind, 'forecast-position');
  assert.equal(events[0].coneGeometryKind, 'cone-of-uncertainty');
  assert.equal(events[0].windRadii[0].geometryKind, 'forecast-wind-radii');
});

test('drops expired marine bulletins and keeps independent storm ids', () => {
  const sea = parseSeaBulletinPayload(fixture('imd-sea-bulletin.json'));
  const expired = dropExpiredRecords(sea, Date.parse('2023-04-10T00:00:00Z'));
  assert.equal(expired.some((row) => row.bulletinId === '109'), false);
  const live = dropExpiredRecords(sea, NOW);
  assert.ok(live.some((row) => row.bulletinId === '110'));
});

test('a failed product carries last-good for that product only', () => {
  const previous = assembleImdSnapshot({
    now: CYCLONE_NOW,
    productResults: {
      cycloneTrack: { status: 'ok', records: parseCycloneTrackPayload(fixture('imd-cyclone-track.json')) },
      portWarning: { status: 'ok', records: parsePortWarningPayload(fixture('imd-port-warning.json')) },
      seaBulletin: { status: 'ok', records: parseSeaBulletinPayload(fixture('imd-sea-bulletin.json')) },
      coastalBulletin: { status: 'ok', records: [] },
      cycloneWind: { status: 'ok', records: [] },
      cycloneCou: { status: 'ok', records: [] },
    },
  });
  const snapshot = assembleImdSnapshot({
    now: CYCLONE_NOW,
    previous,
    productResults: {
      cycloneTrack: { status: 'failed', reason: 'HTTP 401', records: [] },
      portWarning: { status: 'ok', records: parsePortWarningPayload(fixture('imd-port-warning.json')) },
      seaBulletin: { status: 'ok', records: [] },
      coastalBulletin: { status: 'ok', records: [] },
      cycloneWind: { status: 'ok', records: [] },
      cycloneCou: { status: 'ok', records: [] },
    },
  });
  assert.equal(snapshot.coverageState, 'degraded');
  assert.equal(snapshot.products.cycloneTrack.status, 'failed');
  assert.equal(snapshot.products.cycloneTrack.carried, true);
  assert.ok(snapshot.cyclones.length > 0);
  assert.equal(snapshot.products.portWarning.status, 'ok');
  assert.equal(snapshot.failedProducts.includes('cycloneTrack'), true);
  assert.equal(snapshot.failedProducts.includes('portWarning'), false);
  const meta = imdAfterPublish(snapshot);
  assert.equal(meta.freshnessMetaPatch.sourceState, 'degraded');
  assert.equal(meta.freshnessMetaPatch.errorCode, 'IMD_PRODUCT_PARTIAL');
});

test('stamps successful wind and cone geometry and omits it after an aged failed fetch', () => {
  const previous = assembleImdSnapshot({
    now: CYCLONE_NOW,
    productResults: {
      cycloneTrack: { status: 'ok', records: parseCycloneTrackPayload(fixture('imd-cyclone-track.json')) },
      cycloneWind: { status: 'ok', records: parseCycloneWindPayload(fixture('imd-cyclone-wind.json')) },
      cycloneCou: { status: 'ok', records: parseCycloneCouPayload(fixture('imd-cyclone-cou.json')) },
      portWarning: { status: 'ok', records: [] },
      seaBulletin: { status: 'ok', records: [] },
      coastalBulletin: { status: 'ok', records: [] },
    },
  });
  assert.ok(previous.windRadii.length > 0);
  assert.ok(previous.cones.length > 0);
  assert.ok(previous.windRadii.every((row) => row.updatedAt === CYCLONE_NOW));
  assert.ok(previous.cones.every((row) => row.updatedAt === CYCLONE_NOW));

  const freshFailed = assembleImdSnapshot({
    now: CYCLONE_NOW + 60 * 60 * 1000,
    previous,
    productResults: {
      cycloneTrack: { status: 'ok', records: parseCycloneTrackPayload(fixture('imd-cyclone-track.json')) },
      cycloneWind: { status: 'failed', reason: 'HTTP 500', records: [] },
      cycloneCou: { status: 'failed', reason: 'HTTP 500', records: [] },
      portWarning: { status: 'ok', records: [] },
      seaBulletin: { status: 'ok', records: [] },
      coastalBulletin: { status: 'ok', records: [] },
    },
  });
  assert.equal(freshFailed.products.cycloneWind.carried, true);
  assert.equal(freshFailed.products.cycloneCou.carried, true);
  assert.equal(freshFailed.windRadii.length, previous.windRadii.length);
  assert.equal(freshFailed.cones.length, previous.cones.length);

  const agedNow = CYCLONE_NOW + (IMD_MAX_CONTENT_AGE_MIN * 60 * 1000) + 1;
  const currentTrack = parseCycloneTrackPayload(fixture('imd-cyclone-track.json')).map((row) => ({
    ...row,
    at: agedNow,
  }));
  const agedFailed = assembleImdSnapshot({
    now: agedNow,
    previous,
    productResults: {
      cycloneTrack: { status: 'ok', records: currentTrack },
      cycloneWind: { status: 'failed', reason: 'HTTP 500', records: [] },
      cycloneCou: { status: 'failed', reason: 'HTTP 500', records: [] },
      portWarning: { status: 'ok', records: [] },
      seaBulletin: { status: 'ok', records: [] },
      coastalBulletin: { status: 'ok', records: [] },
    },
  });
  assert.equal(agedFailed.windRadii.length, 0);
  assert.equal(agedFailed.cones.length, 0);
  assert.equal(agedFailed.products.cycloneWind.carried, false);
  assert.equal(agedFailed.products.cycloneCou.carried, false);
  const events = cycloneEventsFromSnapshot(agedFailed);
  assert.equal(events.length, 1);
  assert.equal(events[0].windRadii.length, 0);
  assert.deepEqual(events[0].conePolygon, []);
});

test('omits unstamped previous wind or cone geometry when the product fetch fails', () => {
  const previous = assembleImdSnapshot({
    now: CYCLONE_NOW,
    productResults: {
      cycloneTrack: { status: 'ok', records: parseCycloneTrackPayload(fixture('imd-cyclone-track.json')) },
      cycloneWind: { status: 'ok', records: [] },
      cycloneCou: { status: 'ok', records: [] },
      portWarning: { status: 'ok', records: [] },
      seaBulletin: { status: 'ok', records: [] },
      coastalBulletin: { status: 'ok', records: [] },
    },
  });
  const snapshot = assembleImdSnapshot({
    now: CYCLONE_NOW,
    previous: {
      ...previous,
      windRadii: parseCycloneWindPayload(fixture('imd-cyclone-wind.json')),
      cones: parseCycloneCouPayload(fixture('imd-cyclone-cou.json')),
    },
    productResults: {
      cycloneTrack: { status: 'ok', records: parseCycloneTrackPayload(fixture('imd-cyclone-track.json')) },
      cycloneWind: { status: 'failed', reason: 'HTTP 500', records: [] },
      cycloneCou: { status: 'failed', reason: 'HTTP 500', records: [] },
      portWarning: { status: 'ok', records: [] },
      seaBulletin: { status: 'ok', records: [] },
      coastalBulletin: { status: 'ok', records: [] },
    },
  });
  assert.equal(snapshot.windRadii.length, 0);
  assert.equal(snapshot.cones.length, 0);
  assert.equal(snapshot.products.cycloneWind.carried, false);
  assert.equal(snapshot.products.cycloneCou.carried, false);
});

test('requires only IMD_API_KEY and reports a missing key as explicitly disabled', async () => {
  assert.equal(imdLiveFetchEnabled({}), false);
  assert.equal(imdLiveFetchEnabled({ IMD_API_KEY: 'secret' }), true);
  assert.equal(imdLiveFetchEnabled({ IMD_API_KEY: 'bad\r\nkey' }), false);
  assert.equal(imdLiveFetchEnabled({ IMD_API_KEY: 'bad\u2028key' }), false);
  const requested = [];
  const snapshot = await fetchImdCycloneMarine({
    env: {},
    fetchFn: async (url) => {
      requested.push(url);
      throw new Error('a missing API key must not make an IMD request');
    },
    now: NOW,
  });
  assert.equal(snapshot.coverageState, 'disabled');
  assert.equal(snapshot.skipReason, 'IMD_API_KEY_MISSING');
  assert.equal(snapshot.rights.status, 'reviewed');
  assert.deepEqual(requested, []);
  assert.equal(declareImdRecords(snapshot), 0);
  assert.equal(validateImdEnvelope(snapshot), true);
  assert.equal(snapshot.products.fishermenWarning.reason, 'INDEXED_WITHOUT_FIELD_REFERENCE');
  const meta = imdAfterPublish(snapshot);
  assert.equal(meta.freshnessMetaPatch.sourceState, 'unavailable');
  assert.notEqual(snapshot.coverageState, 'ok');

  const invalidKey = await fetchImdCycloneMarine({
    env: { IMD_API_KEY: 'bad\r\nkey' },
    fetchFn: async (url) => {
      requested.push(url);
      throw new Error('an invalid API key must not make an IMD request');
    },
    now: NOW,
  });
  assert.equal(invalidKey.coverageState, 'disabled');
  assert.equal(invalidKey.skipReason, 'IMD_API_KEY_INVALID');
  assert.deepEqual(requested, []);

  const invalidHeader = await fetchImdCycloneMarine({
    env: { IMD_API_KEY: 'test-key', IMD_API_KEY_HEADER: 'bad header' },
    fetchFn: async (url) => {
      requested.push(url);
      throw new Error('an invalid API key header must not make an IMD request');
    },
    now: NOW,
  });
  assert.equal(invalidHeader.coverageState, 'disabled');
  assert.equal(invalidHeader.skipReason, 'IMD_API_KEY_HEADER_INVALID');
  assert.deepEqual(requested, []);
});

test('redacts IMD transport errors before they reach the cached public snapshot', async () => {
  const snapshot = await fetchImdCycloneMarine({
    env: { IMD_API_KEY: 'test-key' },
    fetchFn: async () => {
      throw new Error('upstream rejected key secret-imd-key');
    },
    now: NOW,
  });

  assert.equal(snapshot.coverageState, 'unavailable');
  assert.equal(snapshot.products.cycloneTrack.reason, 'IMD_FETCH_FAILED');
  assert.doesNotMatch(JSON.stringify(snapshot), /secret-imd-key/);

  const timeout = await fetchImdCycloneMarine({
    env: { IMD_API_KEY: 'test-key' },
    fetchFn: async () => {
      const error = new Error('timeout details must not be public');
      error.name = 'TimeoutError';
      throw error;
    },
    now: NOW,
  });
  assert.equal(timeout.products.cycloneTrack.reason, 'IMD_FETCH_TIMEOUT');
  assert.doesNotMatch(JSON.stringify(timeout), /timeout details/);
});

test('marks a missing IMD key as an error after the source has activated', () => {
  const { ACTIVATION_MARKERS, SEED_META, STANDALONE_KEYS, STATUS_COUNTS, classifyKey } = healthTesting;
  const name = 'imdCycloneMarine';
  const dataKey = STANDALONE_KEYS[name];
  const metaKey = SEED_META[name].key;
  const now = Date.parse('2026-08-28T00:00:00.000Z');
  const ctx = (activated) => ({
    keyStrens: new Map([[dataKey, 128]]),
    keyErrors: new Map(),
    keyMetaValues: new Map([[metaKey, JSON.stringify({
      fetchedAt: now,
      recordCount: 0,
      sourceState: 'unavailable',
      errorCode: 'IMD_API_KEY_MISSING',
      coverageState: 'disabled',
    })]]),
    keyMetaErrors: new Map(),
    activationStates: new Map([[name, activated]]),
    now,
  });

  assert.equal(ACTIVATION_MARKERS[name], 'seed-activated:weather:imd-cyclone-marine');
  assert.equal(classifyKey(name, dataKey, { allowOnDemand: true }, ctx(false)).status, 'NOT_CONFIGURED');
  const afterActivation = classifyKey(name, dataKey, { allowOnDemand: true }, ctx(true));
  assert.equal(afterActivation.status, 'SEED_ERROR');
  assert.equal(STATUS_COUNTS[afterActivation.status], 'warn');
});

test('never fetches fishermen warning even when live fetch is enabled', async () => {
  const requested = [];
  const fetchFn = async (url) => {
    requested.push(url);
    if (String(url).includes('fishermen')) {
      throw new Error('fishermen must not be requested');
    }
    if (String(url).includes('cyclone_track')) return jsonResponse(fixture('imd-cyclone-track.json'));
    if (String(url).includes('cyclone_wind')) return jsonResponse(fixture('imd-cyclone-wind.json'));
    if (String(url).includes('cyclone_cou')) return jsonResponse(fixture('imd-cyclone-cou.json'));
    if (String(url).includes('portwarning')) return jsonResponse(fixture('imd-port-warning.json'));
    if (String(url).includes('seabulletin')) return jsonResponse(fixture('imd-sea-bulletin.json'));
    if (String(url).includes('coastalbulletin')) return jsonResponse(fixture('imd-coastal-bulletin.json'));
    return jsonResponse({ error: 'API key missing' }, 401);
  };
  const snapshot = await fetchImdCycloneMarine({
    env: { IMD_API_KEY: 'test-key' },
    fetchFn,
    now: CYCLONE_NOW,
  });
  assert.equal(requested.some((url) => String(url).includes('fishermen')), false);
  assert.equal(snapshot.products.fishermenWarning.status, 'disabled');
  assert.equal(snapshot.coverageState, 'ok');
  assert.ok(snapshot.cyclones.length > 0);
});

test('rejects untrusted hosts and does not treat 401 as all-clear', async () => {
  const snapshot = await fetchImdCycloneMarine({
    env: { IMD_API_KEY: 'test-key' },
    fetchFn: async () => jsonResponse({ error: 'API key missing' }, 401),
    now: NOW,
  });
  assert.equal(snapshot.coverageState, 'unavailable');
  assert.ok(snapshot.failedProducts.includes('cycloneTrack'));
  assert.equal(snapshot.cyclones.length, 0);
  const meta = imdAfterPublish(snapshot);
  assert.equal(meta.freshnessMetaPatch.sourceState, 'degraded');
});

test('seeder stays off weather:alerts:v1 and uses the dedicated canonical key', () => {
  const seeder = readFileSync(join(root, 'scripts/seed-imd-cyclone-marine.mjs'), 'utf8');
  assert.match(seeder, /IMD_CANONICAL_KEY/);
  assert.doesNotMatch(seeder, /runSeed\('weather', 'alerts'/);
  assert.equal(IMD_CANONICAL_KEY, 'weather:imd-cyclone-marine:v1');
  assert.match(seeder, /#7005/);
  assert.match(seeder, /seed-activated:weather:imd-cyclone-marine/);
  const lib = readFileSync(join(root, 'scripts/lib/imd-cyclone-marine.mjs'), 'utf8');
  assert.doesNotMatch(lib, /\/api\/v1\/districtnowcast/);
  assert.doesNotMatch(lib, /\/api\/v1\/districtwarning/);
  assert.equal(IMD_API_REFERENCE_URL, 'https://api.imd.gov.in/public/api_reference.html');
});
