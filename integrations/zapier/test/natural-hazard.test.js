'use strict';

const assert = require('node:assert/strict');
const nock = require('nock');
const zapier = require('zapier-platform-core');

const App = require('../index');
const { signedRequest } = require('./helpers/signed-request');
const { BASE_URL, PATHS, EVENT_REGISTRY } = require('../constants');

const appTester = zapier.createAppTester(App);
const trigger = App.triggers.natural_hazard.operation;
const EVENT = EVENT_REGISTRY.events['natural.hazard'];

const AUTH = { apiKey: 'wm_test' };
const TARGET = 'https://hooks.zapier.com/hooks/standard/1/hazard/';
const SECRET = '7c'.repeat(32);
const DELIVERY_ID = 'whd_1f3e5d7c9b2a4c6e8d0f1a3b5c7d9e20';

// The body scripts/shipping-webhook-worker.mjs builds for a new earthquake
// (tests/event-triggers-registry.test.mjs pins it to the registry sample);
// signed here with a fixture secret.
const BODY = JSON.stringify({ ...EVENT.sample, subscriberId: 'wh_041fef6d0657b56b75fb62cb' });
const rawRequest = (body, overrides = {}) => signedRequest(body, { secret: SECRET, event: 'natural.hazard', deliveryId: DELIVERY_ID, overrides });

const HOUR = 3_600_000;
const T0 = Date.parse('2026-10-16T03:35:31.925Z');

// Trimmed list-earthquakes and list-natural-events responses.
const EARTHQUAKES = {
  earthquakes: [
    { id: 'us6000u2mq', place: '76 km NE of Ozernovskiy, Russia', magnitude: 6.9, depthKm: 135, location: { latitude: 51.98, longitude: 157.27 }, occurredAt: T0, sourceUrl: 'https://earthquake.usgs.gov/earthquakes/eventpage/us6000u2mq', source: 'usgs' },
    { id: 'us6000u2y1', place: '48 km WNW of Khuzdar, Pakistan', magnitude: 5.7, depthKm: 10, location: { latitude: 28.02, longitude: 66.17 }, occurredAt: T0 + 25 * HOUR, sourceUrl: 'https://earthquake.usgs.gov/earthquakes/eventpage/us6000u2y1', source: 'usgs', nearTestSite: true },
    { id: 'us6000small', place: '10 km S of Ndoi Island, Fiji', magnitude: 4.8, depthKm: 550, location: { latitude: -20.7, longitude: -178.7 }, occurredAt: T0 + 26 * HOUR, sourceUrl: '', source: 'usgs' },
  ],
};
const NATURAL = {
  events: [
    { id: 'nhc-AL13-30', title: 'Hurricane Melissa', category: 'severeStorms', categoryTitle: 'Tropical Cyclone', lat: 18, lon: -76.6, date: T0 + 2 * HOUR, magnitude: 140, magnitudeUnit: 'kt', sourceUrl: 'https://www.nhc.noaa.gov/', sourceName: 'NHC', closed: false, stormName: 'Melissa', stormCategory: 5, windKt: 140 },
    { id: 'gdacs-FL-1103', title: '\u{1F534} Flood in Nigeria', category: 'floods', categoryTitle: 'Flood', lat: 9, lon: 7, date: T0 + 3 * HOUR, magnitude: 0, magnitudeUnit: '', sourceUrl: 'https://www.gdacs.org/report.aspx?eventid=1103', sourceName: 'GDACS', closed: false },
    { id: 'gdacs-DR-1', title: '\u{1F7E0} Drought in Kenya', category: 'drought', categoryTitle: 'Drought', lat: 0, lon: 38, date: T0 + 4 * HOUR, magnitude: 0, magnitudeUnit: '', sourceUrl: '', sourceName: 'GDACS', closed: false },
    { id: 'gdacs-EQ-1500', title: '\u{1F7E0} Earthquake in Russia', category: 'earthquakes', categoryTitle: 'Earthquake', lat: 51.9, lon: 157.2, date: T0, magnitude: 0, magnitudeUnit: '', sourceUrl: '', sourceName: 'GDACS', closed: false },
    { id: 'EONET_25232', title: 'Wildfire CYRUS, Kern, California', category: 'wildfires', categoryTitle: 'Wildfires', lat: 35.7, lon: -118.42, date: T0 + 5 * HOUR, magnitude: 543, magnitudeUnit: 'acres', sourceUrl: 'https://irwin.doi.gov/observer/incidents/1', sourceName: 'IRWIN', closed: false },
    { id: 'EONET_25240', title: 'Prescribed Fire Newman Piles RX, Coconino, Arizona', category: 'wildfires', categoryTitle: 'Wildfires', lat: 35.1, lon: -111.6, date: T0 + 5 * HOUR, magnitude: 120, magnitudeUnit: 'acres', sourceUrl: '', sourceName: 'IRWIN', closed: false },
    { id: 'hko-warning:TC8NE', title: 'Hong Kong No. 8 Northeast Gale or Storm Signal', category: 'severeStorms', categoryTitle: 'Tropical Cyclone Warning', lat: 22.3, lon: 114.17, date: T0 + 7 * HOUR, magnitude: 0, magnitudeUnit: '', sourceUrl: '', sourceName: 'HKO', closed: false },
    { id: 'EONET_10', title: 'Old closed flood', category: 'floods', categoryTitle: 'Floods', lat: 1, lon: 1, date: T0 + 6 * HOUR, magnitude: 0, magnitudeUnit: '', sourceUrl: '', sourceName: 'EO', closed: true },
  ],
  fetchedAt: T0 + 6 * HOUR,
  dataAvailable: true,
};

const mockFeeds = () => {
  nock(BASE_URL).get(PATHS.earthquakes).reply(200, EARTHQUAKES);
  nock(BASE_URL).get(PATHS.naturalEvents).reply(200, NATURAL);
};

describe('trigger natural_hazard (REST hook)', () => {
  afterEach(() => nock.cleanAll());

  it('subscribes with a scope built from the inputs: hazard types, numeric magnitude, alert level, upper-cased countries', async () => {
    let posted;
    nock(BASE_URL).post(PATHS.webhooks, (body) => { posted = body; return true; }).reply(200, { subscriberId: 'wh_h', secret: SECRET });
    const result = await appTester(trigger.performSubscribe, {
      authData: AUTH,
      targetUrl: TARGET,
      inputData: { hazard_types: ['earthquakes', 'severeStorms'], min_magnitude: '6.5', min_alert_level: 'Red', countries: ['jp', ' tw'] },
    });
    assert.deepEqual(posted, {
      callbackUrl: TARGET,
      eventType: 'natural.hazard',
      chokepointIds: [],
      countries: [],
      scope: { hazardTypes: ['earthquakes', 'severeStorms'], minMagnitude: 6.5, minAlertLevel: 'Red', countries: ['JP', 'TW'] },
    });
    assert.equal(result.eventType, 'natural.hazard');
  });

  it('sends the registry defaults (magnitude 5.5, Orange) and no empty lists when the inputs are blank', async () => {
    let posted;
    nock(BASE_URL).post(PATHS.webhooks, (body) => { posted = body; return true; }).reply(200, { subscriberId: 'wh_h', secret: SECRET });
    await appTester(trigger.performSubscribe, { authData: AUTH, targetUrl: TARGET, inputData: { hazard_types: 'wildfires, floods', min_magnitude: '' } });
    assert.deepEqual(posted.scope, { hazardTypes: ['wildfires', 'floods'], minMagnitude: 5.5, minAlertLevel: 'Orange' });
  });

  it('accepts a signed delivery keyed by X-WM-Delivery-Id with the sample field set, and a retry keeps the id', async () => {
    const run = () => appTester(trigger.perform, {
      authData: AUTH, subscribeData: { subscriberId: 'wh_041fef6d0657b56b75fb62cb', secret: SECRET },
      cleanedRequest: JSON.parse(BODY), rawRequest: rawRequest(BODY),
    });
    const rows = await run();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, DELIVERY_ID);
    assert.equal(rows[0].eventId, 'eq:us6000u2mq');
    assert.equal(rows[0].magnitude, 6.9);
    assert.deepEqual(rows[0].countryCodes, ['RU']);
    assert.deepEqual(Object.keys(rows[0]).sort(), Object.keys(trigger.sample).sort(), 'deliveries and the sample share one field set');
    assert.equal((await run())[0].id, rows[0].id);
  });

  it('rejects a delivery without a valid V2 signature and ignores one for another event', async () => {
    await assert.rejects(
      () => appTester(trigger.perform, { authData: AUTH, subscribeData: { secret: SECRET }, cleanedRequest: JSON.parse(BODY), rawRequest: rawRequest(BODY, { 'Http-X-Wm-Signature-V2': undefined }) }),
      /did not verify/,
    );
    await assert.rejects(
      () => appTester(trigger.perform, { authData: AUTH, subscribeData: { secret: 'f'.repeat(64) }, cleanedRequest: JSON.parse(BODY), rawRequest: rawRequest(BODY) }),
      /did not verify/,
    );
    const rows = await appTester(trigger.perform, { authData: AUTH, subscribeData: { secret: SECRET }, cleanedRequest: JSON.parse(BODY), rawRequest: rawRequest(BODY, { 'Http-X-Wm-Event': 'market.move' }) });
    assert.deepEqual(rows, []);
  });

  it('performList shapes both feeds like deliveries, newest first, with unique ids and the default floors applied', async () => {
    mockFeeds();
    const rows = await appTester(trigger.performList, { authData: AUTH, inputData: {} });
    assert.deepEqual(rows.map((r) => r.eventId), [
      'eq:us6000u2y1',
      'nat:EONET_25232',
      'nat:gdacs-DR-1',
      'nat:gdacs-FL-1103:red',
      'nat:nhc-AL13',
      'eq:us6000u2mq',
    ], 'M4.8 is under the 5.5 default; closed, GDACS earthquake, prescribed-burn and HKO signal rows are skipped; the NHC advisory number is dropped; a Red GDACS id ends in :red');
    for (const row of rows) {
      assert.deepEqual(Object.keys(row).sort(), Object.keys(trigger.sample).sort(), `${row.eventId}: sample rows and deliveries share one field set`);
      assert.deepEqual(row.countryCodes, [], 'samples are not geocoded; deliveries are');
    }
    assert.equal(new Set(rows.map((r) => r.id)).size, rows.length);
    const quake = rows.find((r) => r.eventId === 'eq:us6000u2mq');
    assert.equal(quake.title, 'M6.9 - 76 km NE of Ozernovskiy, Russia');
    assert.equal(quake.occurredAt, '2026-10-16T03:35:31.925Z');
    assert.equal(quake.nearTestSite, false);
    assert.equal(rows.find((r) => r.eventId === 'eq:us6000u2y1').nearTestSite, true);
    const flood = rows.find((r) => r.eventId === 'nat:gdacs-FL-1103:red');
    assert.equal(flood.title, 'Flood in Nigeria');
    assert.equal(flood.alertLevel, 'Red');
    assert.equal(flood.source, 'gdacs');
    assert.equal(flood.magnitude, null);
    const storm = rows.find((r) => r.eventId === 'nat:nhc-AL13');
    assert.deepEqual([storm.source, storm.stormName, storm.stormCategory, storm.windKt], ['nhc', 'Melissa', 5, 140]);
    assert.equal(rows.find((r) => r.eventId === 'nat:EONET_25232').windKt, null, 'acres are not knots');
  });

  it('performList applies hazard types, the magnitude floor and Red', async () => {
    mockFeeds();
    const quakes = await appTester(trigger.performList, { authData: AUTH, inputData: { hazard_types: ['earthquakes'], min_magnitude: '6' } });
    assert.deepEqual(quakes.map((r) => r.eventId), ['eq:us6000u2mq']);
    mockFeeds();
    const red = await appTester(trigger.performList, { authData: AUTH, inputData: { hazard_types: ['floods', 'drought'], min_alert_level: 'Red' } });
    assert.deepEqual(red.map((r) => r.eventId), ['nat:gdacs-FL-1103:red']);
  });

  it('performList keeps the other feed when one list fails, and fails only when both do', async () => {
    nock(BASE_URL).get(PATHS.earthquakes).reply(503, { message: 'unavailable' });
    nock(BASE_URL).get(PATHS.naturalEvents).reply(200, NATURAL);
    const rows = await appTester(trigger.performList, { authData: AUTH, inputData: {} });
    assert.ok(rows.length > 0);
    assert.ok(rows.every((r) => r.eventId.startsWith('nat:')));

    nock(BASE_URL).get(PATHS.earthquakes).reply(401, { message: 'invalid key' });
    nock(BASE_URL).get(PATHS.naturalEvents).reply(401, { message: 'invalid key' });
    await assert.rejects(() => appTester(trigger.performList, { authData: AUTH, inputData: {} }), /rejected the API key/);
  });

  it('when the scope leaves nothing, the newest hazards are shown so the editor has rows', async () => {
    mockFeeds();
    const rows = await appTester(trigger.performList, { authData: AUTH, inputData: { hazard_types: ['volcanoes'] } });
    assert.ok(rows.length > 0);
    assert.equal(rows[0].eventId, 'eq:us6000small');
  });
});
