import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  BC_ALERTS_CATALOGUE_URL,
  BC_ALERTS_HOST,
  BC_ALERTS_PROVINCE,
  BC_ALERTS_QUERY_URL,
  BC_ALERTS_SOURCE,
  BRITISH_COLUMBIA_CENTROID,
  bcAlertsContentMeta,
  declareBcAlertRecords,
  fetchBcEmergencyInfoAlerts,
  isAllowedBcAlertsHost,
  mapBcAlertSeverity,
  parseBcEmergencyInfoGeoJson,
  validateBcAlertsEnvelope,
} from '../scripts/lib/bc-emergency-info.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// First two records were captured from BC_ALERTS_QUERY_URL on 2026-08-17.
// The All Clear and missing-status records are negative lifecycle test cases.
const fixture = JSON.parse(readFileSync(join(root, 'tests/fixtures/bc-emergency-info.geojson'), 'utf8'));

test('maps only official active B.C. evacuation levels and fails closed otherwise', () => {
  assert.equal(mapBcAlertSeverity('Order'), 'Extreme');
  assert.equal(mapBcAlertSeverity('Tactical Evacuation'), 'Extreme');
  assert.equal(mapBcAlertSeverity('Alert'), 'Severe');
  assert.equal(mapBcAlertSeverity('All Clear'), null);
  assert.equal(mapBcAlertSeverity(''), null);
  assert.equal(mapBcAlertSeverity('unexpected'), null);
});

test('normalizes official Alert and Order polygons onto canadaAlerts', () => {
  const alerts = parseBcEmergencyInfoGeoJson(fixture);
  assert.equal(alerts.length, 2);

  const alert = alerts.find((record) => record.id === 'bc-evacuation-7');
  const order = alerts.find((record) => record.id === 'bc-evacuation-69');
  assert.equal(alert.province, BC_ALERTS_PROVINCE);
  assert.equal(alert.source, BC_ALERTS_SOURCE);
  assert.equal(alert.severity, 'Severe');
  assert.equal(alert.event, 'Fire');
  assert.equal(alert.headline, 'Brunswick Wildfire — Boothroyd IB');
  assert.equal(alert.areaDesc, 'Boothroyd IB');
  assert.equal(alert.updatedAt, 1786956961000);
  assert.ok(Number.isFinite(alert.lat));
  assert.ok(Number.isFinite(alert.lon));
  assert.equal(alert.url, BC_ALERTS_CATALOGUE_URL);

  assert.equal(order.id, 'bc-evacuation-69');
  assert.equal(order.severity, 'Extreme');
  assert.equal(order.areaDesc, 'Greata Ranch to Summerland Boundary on Highway 97');
});

test('uses a province centroid only after severity has passed the fail-closed gate', () => {
  const copy = structuredClone(fixture);
  copy.features = [{
    ...copy.features[0],
    geometry: null,
    properties: { ...copy.features[0].properties, EMRG_OAA_SYSID: 72 },
  }];
  const [record] = parseBcEmergencyInfoGeoJson(copy);
  assert.deepEqual(record.centroid, BRITISH_COLUMBIA_CENTROID);
});

test('fails closed when the source system ID is absent or blank', () => {
  for (const sysId of [null, '', '   ']) {
    const copy = structuredClone(fixture);
    copy.features = [{
      ...copy.features[0],
      properties: { ...copy.features[0].properties, EMRG_OAA_SYSID: sysId },
    }];
    assert.throws(
      () => parseBcEmergencyInfoGeoJson(copy),
      /missing EMRG_OAA_SYSID/,
    );
  }
});

test('fails closed on an unknown ORDER_ALERT_STATUS instead of skipping the feature', () => {
  const copy = structuredClone(fixture);
  copy.features = [{
    ...copy.features[0],
    properties: { ...copy.features[0].properties, ORDER_ALERT_STATUS: 'Warning' },
  }];
  assert.throws(
    () => parseBcEmergencyInfoGeoJson(copy),
    /unknown ORDER_ALERT_STATUS: Warning/,
  );
});

test('pins the official ArcGIS host and rejects redirects to lookalikes', () => {
  assert.equal(BC_ALERTS_HOST, 'services6.arcgis.com');
  assert.equal(isAllowedBcAlertsHost(BC_ALERTS_QUERY_URL), true);
  assert.equal(isAllowedBcAlertsHost('http://services6.arcgis.com/path'), false);
  assert.equal(isAllowedBcAlertsHost('https://services6.arcgis.com.evil.test/path'), false);
  assert.equal(isAllowedBcAlertsHost('https://user@services6.arcgis.com/path'), false);
});

test('fetches bounded GeoJSON pages and requests only active source levels', async () => {
  const requested = [];
  const fetchFn = async (url, options) => {
    requested.push({ url: String(url), options });
    return new Response(JSON.stringify(fixture), {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  };

  const data = await fetchBcEmergencyInfoAlerts({ fetchFn });
  assert.equal(data.alerts.length, 2);
  assert.equal(requested.length, 1);
  const url = new URL(requested[0].url);
  assert.match(url.searchParams.get('where'), /ORDER_ALERT_STATUS IN/);
  assert.equal(url.searchParams.get('f'), 'geojson');
  assert.equal(url.searchParams.get('returnGeometry'), 'true');
  assert.equal(requested[0].options.redirect, 'error');
  assert.match(requested[0].options.headers['User-Agent'], /Mozilla/);
});

test('advances ArcGIS pagination by returned rows when a page is server-capped', async () => {
  const offsets = [];
  const pages = [
    {
      type: 'FeatureCollection',
      properties: { exceededTransferLimit: true },
      features: [fixture.features[0]],
    },
    {
      type: 'FeatureCollection',
      properties: { exceededTransferLimit: false },
      features: [fixture.features[1]],
    },
  ];
  const fetchFn = async (url) => {
    offsets.push(new URL(url).searchParams.get('resultOffset'));
    return new Response(JSON.stringify(pages.shift()), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const data = await fetchBcEmergencyInfoAlerts({ fetchFn });
  assert.deepEqual(offsets, ['0', '1']);
  assert.equal(data.alerts.length, 2);
});

test('fails closed when ArcGIS still reports more rows after the page budget', async () => {
  let requests = 0;
  const fetchFn = async () => {
    requests += 1;
    const feature = structuredClone(fixture.features[0]);
    feature.properties.EMRG_OAA_SYSID = requests;
    return new Response(JSON.stringify({
      type: 'FeatureCollection',
      properties: { exceededTransferLimit: true },
      features: [feature],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  await assert.rejects(
    fetchBcEmergencyInfoAlerts({ fetchFn }),
    /pagination remains incomplete after 6 pages/,
  );
  assert.equal(requests, 6);
});

test('fails closed instead of truncating when normalized valid alerts exceed the cap', () => {
  const feature = fixture.features[0];
  const features = Array.from({ length: 1_001 }, (_, index) => ({
    ...feature,
    properties: {
      ...feature.properties,
      EMRG_OAA_SYSID: index + 1,
    },
  }));

  assert.throws(
    () => parseBcEmergencyInfoGeoJson({ type: 'FeatureCollection', features }),
    /normalized alert count exceeds 1000/,
  );
});

test('exposes the zero-valid envelope and content-age contract', () => {
  const alerts = parseBcEmergencyInfoGeoJson(fixture);
  const envelope = { alerts };
  assert.equal(validateBcAlertsEnvelope(envelope), true);
  assert.equal(validateBcAlertsEnvelope({ alerts: 'nope' }), false);
  assert.equal(declareBcAlertRecords(envelope), 2);
  assert.equal(declareBcAlertRecords({ alerts: [] }), 0);
  assert.deepEqual(bcAlertsContentMeta(envelope), {
    newestItemAt: 1786956961000,
    oldestItemAt: 1786894936000,
  });
});

test('map time filter uses DATE_MODIFIED so long-running evacuations stay visible', () => {
  const deck = readFileSync(join(root, 'src/components/DeckGLMap.ts'), 'utf8');
  assert.match(deck, /filterByTimeCached\(this\.canadaAlerts, \(alert\) => alert\.updatedAt\)/);
  assert.doesNotMatch(deck, /filterByTimeCached\(this\.canadaAlerts, \(alert\) => alert\.onset\)/);
});

test('registers the province seeder in the Canada bundle without touching roads or weather', () => {
  const seeder = readFileSync(join(root, 'scripts/seed-bc-emergency-info.mjs'), 'utf8');
  const bundle = readFileSync(join(root, 'scripts/seed-bundle-canada.mjs'), 'utf8');
  assert.match(seeder, /runSeed\('alerts', 'bc-emergency-info'/);
  assert.match(seeder, /rebuildCanadaAlertsUnion/);
  assert.doesNotMatch(seeder, /weather:alerts|canadaRoads|511|ais-relay/);
  assert.match(bundle, /label: 'BC-Emergency-Info'/);
  assert.match(bundle, /dependsOn: \['Alberta-Emergency-Alert'\]/);
});
