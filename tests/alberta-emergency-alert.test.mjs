import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  AEA_ATOM_URL,
  AEA_HOST,
  AEA_PROVINCE,
  AEA_SOURCE,
  ALBERTA_CENTROID,
  CHROME_UA,
  albertaAeaContentMeta,
  calculateCentroid,
  declareAlbertaAeaRecords,
  fetchAlbertaEmergencyAlerts,
  isAllowedAeaHost,
  mapAlertSeverity,
  parseAlbertaEmergencyAlertAtom,
  parseDateMs,
  parseGeorssCoordinates,
  validateAlbertaAeaEnvelope,
} from '../scripts/lib/alberta-emergency-alert.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_PATH = join(root, 'tests/fixtures/alberta-emergency-alert.atom');
// Captured 2026-08-13 from AEA_ATOM_URL with CHROME_UA (Chrome/134). HTTP 200 application/atom+xml.
const FIXTURE = readFileSync(FIXTURE_PATH, 'utf8');
const SEEDER_SOURCE = readFileSync(join(root, 'scripts/seed-alberta-emergency-alert.mjs'), 'utf8');
const RELAY_SOURCE = readFileSync(join(root, 'scripts/ais-relay.cjs'), 'utf8');
const LIB_SOURCE = readFileSync(join(root, 'scripts/lib/alberta-emergency-alert.mjs'), 'utf8');

function atomResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(body, {
    status,
    headers: { 'content-type': 'application/atom+xml', ...headers },
  });
}

function wrapEntry(inner) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:cap="urn:oasis:names:tc:emergency:cap:1.1" xmlns:georss="http://www.georss.org/georss">
  <title>Alberta Emergency Alert - Full Atom Feed</title>
  <updated>2026-08-13T14:06:02-06:00</updated>
  <entry>${inner}</entry>
</feed>`;
}

test('live fixture parses province AB and a mapped severity', () => {
  const alerts = parseAlbertaEmergencyAlertAtom(FIXTURE);
  assert.ok(alerts.length >= 1, 'live capture must include at least one entry');
  for (const alert of alerts) {
    assert.equal(alert.province, AEA_PROVINCE);
    assert.ok(['Extreme', 'Severe', 'Moderate', 'Minor'].includes(alert.severity), `severity ${alert.severity}`);
    assert.equal(alert.source, AEA_SOURCE);
    assert.ok(Array.isArray(alert.centroid) && alert.centroid.length === 2);
    assert.equal(typeof alert.headline, 'string');
    assert.ok(alert.headline.length > 0);
    assert.ok(alert.id);
    assert.ok(alert.updatedAt && Number.isFinite(alert.updatedAt));
  }
  const tornado = alerts.find((a) => /tornado/i.test(a.headline) || /tornado/i.test(a.event));
  assert.ok(tornado, 'captured feed included a tornado watch');
  assert.equal(tornado.severity, 'Moderate');
  assert.equal(tornado.province, 'AB');
  assert.ok(tornado.centroid[1] > 49 && tornado.centroid[1] < 60, 'centroid lat in Alberta');
  assert.ok(tornado.centroid[0] < -110 && tornado.centroid[0] > -120, 'centroid lon in Alberta');
  assert.match(tornado.expires, /2026-08-13T22:10:36/);
});

test('empty Atom feed is valid zero-record success', () => {
  const xml = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>empty</title></feed>`;
  const alerts = parseAlbertaEmergencyAlertAtom(xml);
  assert.deepEqual(alerts, []);
  assert.equal(declareAlbertaAeaRecords({ alerts: [] }), 0);
  assert.equal(validateAlbertaAeaEnvelope({ alerts: [] }), true);
  assert.equal(albertaAeaContentMeta({ alerts: [] }), null);
});

test('fail closed when severity cannot be mapped from the feed', () => {
  const xml = wrapEntry(`
    <id>no-severity</id>
    <updated>2026-08-13T12:00:00-06:00</updated>
    <title>tornado in effect</title>
    <summary>A tornado may develop.</summary>
    <georss:point>53.5 -113.5</georss:point>
  `);
  const alerts = parseAlbertaEmergencyAlertAtom(xml);
  assert.equal(alerts.length, 0);
});

test('maps cap:severity, category, and urgency; does not invent Unknown', () => {
  assert.equal(mapAlertSeverity({ capSeverity: 'Extreme' }), 'Extreme');
  assert.equal(mapAlertSeverity({ capSeverity: 'severe' }), 'Severe');
  assert.equal(mapAlertSeverity({ category: 'Minor' }), 'Minor');
  assert.equal(mapAlertSeverity({ capUrgency: 'Immediate' }), 'Extreme');
  assert.equal(mapAlertSeverity({ capUrgency: 'Expected' }), 'Severe');
  assert.equal(mapAlertSeverity({ capUrgency: 'Future' }), 'Moderate');
  assert.equal(mapAlertSeverity({ title: 'yellow watch - flood' }), 'Moderate');
  assert.equal(mapAlertSeverity({ title: 'red warning - wildfire' }), 'Extreme');
  assert.equal(mapAlertSeverity({ title: 'test alert' }), null);
  assert.equal(mapAlertSeverity({ title: 'something happening' }), null);
  assert.equal(mapAlertSeverity({}), null);
});

test('missing CAP area falls back to the Alberta province centroid', () => {
  const xml = wrapEntry(`
    <id>no-geo</id>
    <updated>2026-08-13T12:00:00-06:00</updated>
    <title>yellow watch - flood - in effect</title>
    <summary>Flooding possible.</summary>
    <cap:severity>Moderate</cap:severity>
  `);
  const [alert] = parseAlbertaEmergencyAlertAtom(xml);
  assert.ok(alert);
  assert.deepEqual(alert.centroid, [...ALBERTA_CENTROID]);
  assert.equal(alert.lat, ALBERTA_CENTROID[1]);
  assert.equal(alert.lon, ALBERTA_CENTROID[0]);
});

test('GeoRSS polygon is lat/lon pairs converted to [lon, lat] centroid', () => {
  const coords = parseGeorssCoordinates('54.0 -113.0 54.0 -112.0 53.0 -112.0 53.0 -113.0 54.0 -113.0');
  assert.deepEqual(coords[0], [-113, 54]);
  const centroid = calculateCentroid(coords);
  assert.ok(centroid);
  assert.equal(centroid[0].toFixed(1), '-112.6');
  assert.equal(centroid[1].toFixed(1), '53.6');
});

test('content-age uses entry updated/published and never Date.now()', () => {
  assert.equal(parseDateMs('2026-08-13T12:46:36-06:00'), Date.parse('2026-08-13T12:46:36-06:00'));
  assert.equal(parseDateMs(''), null);
  assert.equal(parseDateMs(undefined, 'not-a-date'), null);
  const xml = wrapEntry(`
    <id>dated</id>
    <updated>2026-08-13T12:46:36-06:00</updated>
    <title>yellow watch - blizzard</title>
    <cap:severity>Moderate</cap:severity>
  `);
  const [alert] = parseAlbertaEmergencyAlertAtom(xml);
  assert.equal(alert.updatedAt, Date.parse('2026-08-13T12:46:36-06:00'));
  const meta = albertaAeaContentMeta({ alerts: [alert] }, Date.parse('2026-08-13T20:00:00Z'));
  assert.equal(meta.newestItemAt, alert.updatedAt);
  assert.match(LIB_SOURCE, /nowMs = Date\.now\(\)/);
  assert.doesNotMatch(LIB_SOURCE, /updatedAt:\s*Date\.now/);
  assert.doesNotMatch(LIB_SOURCE, /publishedAt:\s*Date\.now/);
  assert.match(LIB_SOURCE, /updatedAt \?\? alert\.publishedAt/);
});

test('host allowlist is www.alberta.ca only', () => {
  assert.equal(isAllowedAeaHost(AEA_ATOM_URL), true);
  assert.equal(isAllowedAeaHost('https://alberta.ca/data/aea/rss/feed-full.atom'), false);
  assert.equal(isAllowedAeaHost('https://api.weather.gov/alerts/active'), false);
  assert.equal(isAllowedAeaHost('https://511on.ca/api/v2/get/event'), false);
});

test('fetchAlbertaEmergencyAlerts uses CHROME_UA, times out, and rejects off-allowlist redirects', async () => {
  const urls = [];
  const fetchFn = async (url, init) => {
    urls.push({ url: String(url), init });
    return atomResponse(FIXTURE);
  };
  const result = await fetchAlbertaEmergencyAlerts({ fetchFn, userAgent: CHROME_UA });
  assert.ok(result.alerts.length >= 1);
  assert.equal(result.alerts[0].province, 'AB');
  assert.ok(result.alerts[0].severity);
  assert.equal(urls[0].url, AEA_ATOM_URL);
  assert.equal(urls[0].init.redirect, 'error');
  assert.match(urls[0].init.headers['User-Agent'], /Chrome\/134/);
  assert.equal(typeof urls[0].init.fetch, 'undefined');

  await assert.rejects(
    () => fetchAlbertaEmergencyAlerts({
      url: 'https://example.com/feed.atom',
      fetchFn: async () => atomResponse(FIXTURE),
    }),
    /allowlist/,
  );
  await assert.rejects(
    () => fetchAlbertaEmergencyAlerts({
      fetchFn: async () => atomResponse('<html>not atom</html>'),
    }),
    /parseable Atom/,
  );
});

test('seeder is a standalone nixpacks job and does not loop ais-relay or weather:alerts:v1', () => {
  assert.match(SEEDER_SOURCE, /fetchAlbertaEmergencyAlerts/);
  assert.match(SEEDER_SOURCE, /zeroIsValid:\s*true/);
  assert.match(SEEDER_SOURCE, /alerts:alberta-aea:v1/);
  assert.match(SEEDER_SOURCE, /alberta-aea-v1/);
  assert.match(SEEDER_SOURCE, /maxStaleMin:\s*45/);
  assert.doesNotMatch(SEEDER_SOURCE, /CANONICAL_KEY = 'weather:alerts:v1'/);
  assert.match(SEEDER_SOURCE, /alerts:alberta-aea:v1/);
  assert.doesNotMatch(SEEDER_SOURCE, /fetch\.bind/);
  assert.doesNotMatch(SEEDER_SOURCE, /canadaRoads/);
  assert.doesNotMatch(SEEDER_SOURCE, /_511-rate-limit/);
  assert.doesNotMatch(LIB_SOURCE, /weather:alerts:v1/);
  assert.doesNotMatch(LIB_SOURCE, /canadaRoads/);
  assert.doesNotMatch(LIB_SOURCE, /fetch.bind/);
  assert.doesNotMatch(LIB_SOURCE, /511on\.ca/);
  assert.match(LIB_SOURCE, new RegExp(AEA_HOST.replace(/\./g, '\\.')));
  assert.doesNotMatch(RELAY_SOURCE, /alberta\.ca/);
  assert.doesNotMatch(RELAY_SOURCE, /alberta-aea/);
  assert.doesNotMatch(RELAY_SOURCE, /canadaAlerts/);
  assert.doesNotMatch(RELAY_SOURCE, /feed-full\.atom/);
});

test('this test file does not import the seeder module', () => {
  const self = readFileSync(new URL(import.meta.url), 'utf8');
  assert.equal(/from ['"][^'"]*seed-alberta-emergency-alert/.test(self), false);
});

test('canadaAlerts is a distinct MapLayers key from weather and canadaRoads', () => {
  const types = readFileSync(join(root, 'src/types/index.ts'), 'utf8');
  const layers = readFileSync(join(root, 'src/config/map-layer-definitions.ts'), 'utf8');
  const client = readFileSync(join(root, 'src/services/canada-alerts.ts'), 'utf8');
  assert.match(types, /canadaAlerts\?: boolean/);
  assert.doesNotMatch(types, /albertaAea\?: boolean/);
  assert.match(layers, /canadaAlerts:\s+def\('canadaAlerts'/);
  assert.match(layers, /Canada Alerts \(Alberta Emergency Alert\)/);
  assert.doesNotMatch(layers, /canadaRoads:\s+def\('canadaAlerts'/);
  assert.match(client, /getHydratedData\('canadaAlerts'\)/);
  assert.match(client, /keys=canadaAlerts/);
  assert.doesNotMatch(client, /weatherAlerts/);
  assert.doesNotMatch(client, /canadaRoads/);
});

test('responses larger than 8MB are rejected', async () => {
  const fetchFn = async () => atomResponse(FIXTURE, {
    headers: { 'content-length': String(8 * 1024 * 1024 + 1) },
  });
  await assert.rejects(
    () => fetchAlbertaEmergencyAlerts({ fetchFn }),
    /payload exceeds/,
  );
});
