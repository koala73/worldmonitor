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
  albertaAeaAfterPublish,
  albertaAeaContentMeta,
  albertaAeaPublishTransform,
  calculateCentroid,
  declareAlbertaAeaRecords,
  fetchAlbertaEmergencyAlerts,
  isAllowedAeaHost,
  isPublishableCapAlert,
  mapAlertSeverity,
  isEndedOrAllClear,
  parseAlbertaEmergencyAlertAtom,
  parseCapStatus,
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

  // Content age must track the FEED's clock, not the seeder's: an alert stamped
  // with Date.now() looks perpetually fresh and defeats the staleness monitor.
  // Parsing the same entry at two different wall-clock instants must therefore
  // produce the same timestamp — which the assertions above cannot show on
  // their own, and which the source greps here previously stood in for.
  const [reparsed] = parseAlbertaEmergencyAlertAtom(xml);
  assert.equal(reparsed.updatedAt, alert.updatedAt);
  const laterMeta = albertaAeaContentMeta({ alerts: [reparsed] }, Date.parse('2027-01-01T00:00:00Z'));
  assert.equal(laterMeta.newestItemAt, alert.updatedAt);
});

test('host allowlist is www.alberta.ca only', () => {
  assert.equal(isAllowedAeaHost(AEA_ATOM_URL), true);
  assert.equal(isAllowedAeaHost('http://www.alberta.ca/data/aea/rss/feed-full.atom'), false);
  assert.equal(isAllowedAeaHost('https://alberta.ca/data/aea/rss/feed-full.atom'), false);
  assert.equal(isAllowedAeaHost('https://api.weather.gov/alerts/active'), false);
  assert.equal(isAllowedAeaHost('https://511on.ca/api/v2/get/event'), false);
});

test('fetchAlbertaEmergencyAlerts uses CHROME_UA, times out, and rejects off-allowlist redirects', async () => {
  const urls = [];
  const fetchFn = async (url, init) => {
    urls.push({ url: String(url), init });
    return String(url) === AEA_ATOM_URL
      ? atomResponse(FIXTURE)
      : new Response(capAlert(), { status: 200 });
  };
  const result = await fetchAlbertaEmergencyAlerts({
    fetchFn,
    userAgent: CHROME_UA,
    nowMs: Date.parse('2026-08-13T20:00:00Z'),
  });
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

test('Alberta alerts stay isolated from the relay, the weather key, and the roads feed', () => {
  // This is an isolation policy, and the only assertion shape that can observe
  // it is the ABSENCE of a reference — no executable test can prove the relay
  // never reaches for this feed. The seeder's own config values (zeroIsValid,
  // maxStaleMin, the transform names) used to be echoed here too; those just
  // restated the object literal a few lines away in the seeder.
  //
  // Alberta ships as a standalone nixpacks job precisely so a relay incident
  // cannot take emergency alerts down with it, and so its fetch never inherits
  // the 511 rate limiter.
  assert.doesNotMatch(SEEDER_SOURCE, /CANONICAL_KEY = 'weather:alerts:v1'/);
  assert.doesNotMatch(SEEDER_SOURCE, /canadaRoads|_511-rate-limit|fetch\.bind/);
  assert.match(SEEDER_SOURCE, /extraKeys/);
  assert.match(SEEDER_SOURCE, /CANADA_ALERTS_LEGACY_KEY/);
  assert.doesNotMatch(LIB_SOURCE, /weather:alerts:v1|canadaRoads|fetch\.bind|511on\.ca/);
  assert.doesNotMatch(RELAY_SOURCE, /alberta\.ca|alberta-aea|canadaAlerts|feed-full\.atom/);

  // And it reaches only its own upstream host.
  assert.match(LIB_SOURCE, new RegExp(AEA_HOST.replace(/\./g, '\\.')));
});

test('this test file does not import the seeder module', () => {
  const self = readFileSync(new URL(import.meta.url), 'utf8');
  assert.equal(/from ['"][^'"]*seed-alberta-emergency-alert/.test(self), false);
});

test('canadaAlerts is a distinct MapLayers key from weather and canadaRoads', () => {
  const types = readFileSync(join(root, 'src/types/index.ts'), 'utf8');
  const layers = readFileSync(join(root, 'src/config/map-layer-definitions.ts'), 'utf8');
  const client = readFileSync(join(root, 'src/services/canada-alerts.ts'), 'utf8');
  assert.match(types, /canadaAlerts:\s*boolean/);
  assert.doesNotMatch(types, /albertaAea\?: boolean/);
  assert.match(layers, /canadaAlerts:\s+def\('canadaAlerts'/);
  assert.match(layers, /Canada Alerts \(AB \+ BC \+ SK\)/);
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

test('ended / cancelled / AllClear title tokens are dropped, not published as Moderate', () => {
  assert.equal(isEndedOrAllClear({ title: 'yellow watch - tornado - ended' }), true);
  assert.equal(isEndedOrAllClear({ title: 'yellow watch - tornado - cancelled' }), true);
  assert.equal(isEndedOrAllClear({ title: 'yellow watch - tornado - AllClear' }), true);
  assert.equal(isEndedOrAllClear({ summary: 'this alert is all clear' }), true);
  assert.equal(isEndedOrAllClear({ capResponseType: 'AllClear' }), true);
  assert.equal(isEndedOrAllClear({ capUrgency: 'Past' }), true);
  assert.equal(isEndedOrAllClear({ capMsgType: 'Cancel' }), true);
  assert.equal(isEndedOrAllClear({ title: 'yellow watch - tornado - in effect' }), false);

  const endedXml = wrapEntry(`
    <id>ended-tornado</id>
    <updated>2026-08-13T19:31:03-06:00</updated>
    <title>yellow watch - tornado - ended</title>
    <summary>Conditions are no longer favourable for the development of tornadoes.</summary>
    <georss:point>53.9 -111.3</georss:point>
  `);
  assert.deepEqual(parseAlbertaEmergencyAlertAtom(endedXml), []);
});

test('ended-tornado fixture is not published as an active Moderate Canada Alert', () => {
  const ended = readFileSync(join(root, 'tests/fixtures/alberta-emergency-alert-ended-tornado.atom'), 'utf8');
  const alerts = parseAlbertaEmergencyAlertAtom(ended);
  assert.deepEqual(alerts, []);
  assert.equal(alerts.some((a) => a.severity === 'Moderate'), false);
});

test('CAP enclosure AllClear / Past drops an in-effect yellow title', async () => {
  const cap = readFileSync(join(root, 'tests/fixtures/alberta-emergency-alert-ended-tornado.cap.xml'), 'utf8');
  const status = parseCapStatus(cap);
  assert.equal(status.capResponseType, 'AllClear');
  assert.equal(status.capUrgency, 'Past');
  assert.equal(status.capSeverity, 'Minor');
  assert.equal(isEndedOrAllClear(status), true);

  const atom = wrapEntry(`
    <id>in-effect-but-allclear</id>
    <updated>2026-08-13T12:46:36-06:00</updated>
    <title>yellow watch - tornado - in effect</title>
    <link href="https://www.alberta.ca/data/aea/cap/2026/08/13/ended-tornado.xml" rel="enclosure" type="application/common-alerting-protocol+xml"/>
    <summary>A tornado may develop.</summary>
    <georss:point>53.9 -111.3</georss:point>
  `);
  const fetchFn = async (url) => {
    if (String(url).includes('ended-tornado.xml')) {
      return new Response(cap, { status: 200, headers: { 'content-type': 'application/common-alerting-protocol+xml' } });
    }
    return atomResponse(atom);
  };
  const result = await fetchAlbertaEmergencyAlerts({ fetchFn, userAgent: CHROME_UA });
  assert.deepEqual(result.alerts, []);
  assert.deepEqual(result._capVerification, { attempted: 1, failed: 0, inactive: 1 });
});

function capAlert({
  status = 'Actual',
  msgType = 'Alert',
  scope = 'Public',
  urgency = 'Immediate',
  severity = 'Severe',
  expires = '2026-08-13T22:00:00Z',
} = {}) {
  return `<?xml version="1.0"?><alert xmlns="urn:oasis:names:tc:emergency:cap:1.2">
    <identifier>cap-1</identifier><sender>aea@gov.ab.ca</sender><sent>2026-08-13T19:00:00Z</sent>
    <status>${status}</status><msgType>${msgType}</msgType><scope>${scope}</scope>
    <info><urgency>${urgency}</urgency><severity>${severity}</severity><expires>${expires}</expires></info>
  </alert>`;
}

function activeAtomEntry(id = 'active-cap', capUrl = `https://${AEA_HOST}/data/aea/cap/active.xml`) {
  return wrapEntry(`
    <id>${id}</id><updated>2026-08-13T19:00:00Z</updated>
    <title>orange warning - wildfire - in effect</title>
    <link href="${capUrl}" rel="enclosure" type="application/common-alerting-protocol+xml"/>
    <summary>Wildfire conditions are dangerous.</summary><cap:severity>Severe</cap:severity>
  `);
}

test('CAP verification positively requires an Actual public Alert or Update before expiry', () => {
  const nowMs = Date.parse('2026-08-13T20:00:00Z');
  assert.equal(isPublishableCapAlert(parseCapStatus(capAlert()), nowMs), true);
  assert.equal(isPublishableCapAlert(parseCapStatus(capAlert({ msgType: 'Update' })), nowMs), true);
  for (const status of ['Test', 'Exercise', 'Draft', 'System']) {
    assert.equal(isPublishableCapAlert(parseCapStatus(capAlert({ status })), nowMs), false, status);
  }
  for (const msgType of ['Cancel', 'Ack', 'Error']) {
    assert.equal(isPublishableCapAlert(parseCapStatus(capAlert({ msgType })), nowMs), false, msgType);
  }
  for (const scope of ['Private', 'Restricted']) {
    assert.equal(isPublishableCapAlert(parseCapStatus(capAlert({ scope })), nowMs), false, scope);
  }
  assert.equal(isPublishableCapAlert(parseCapStatus(capAlert({ expires: '2026-08-13T20:00:00Z' })), nowMs), false);
  assert.equal(isPublishableCapAlert(parseCapStatus(capAlert({ expires: '2026-08-13T20:00:00.001Z' })), nowMs), true);
  assert.equal(isPublishableCapAlert(parseCapStatus(capAlert({ expires: '' })), nowMs), false);
  assert.equal(isPublishableCapAlert(parseCapStatus('<html>not CAP</html>'), nowMs), false);
});

test('unverifiable advertised CAP is dropped and records bounded degradation diagnostics', async () => {
  const atom = activeAtomEntry();
  const fetchFn = async (url) => String(url).endsWith('active.xml')
    ? new Response('upstream failure', { status: 503 })
    : atomResponse(atom);
  const result = await fetchAlbertaEmergencyAlerts({
    fetchFn,
    nowMs: Date.parse('2026-08-13T20:00:00Z'),
  });
  assert.deepEqual(result.alerts, []);
  assert.deepEqual(result._capVerification, { attempted: 1, failed: 1, inactive: 0 });
  assert.deepEqual(albertaAeaPublishTransform(result), { alerts: [] });
  assert.deepEqual(albertaAeaAfterPublish(result), {
    freshnessMetaPatch: {
      sourceState: 'degraded',
      errorCode: 'CAP_VERIFICATION_FAILED',
      capVerificationFailed: 1,
    },
  });
});

test('CAP transport, size, and shape failures all fail closed', async () => {
  const atom = activeAtomEntry();
  const failures = [
    async () => new Response('upstream failure', { status: 503 }),
    async () => { throw new Error('timeout'); },
    async () => new Response('<html>not CAP</html>', { status: 200 }),
    async () => new Response(capAlert(), {
      status: 200,
      headers: { 'content-length': String(8 * 1024 * 1024 + 1) },
    }),
  ];
  for (const capFetch of failures) {
    const result = await fetchAlbertaEmergencyAlerts({
      fetchFn: async (url) => String(url).endsWith('active.xml') ? capFetch() : atomResponse(atom),
      nowMs: Date.parse('2026-08-13T20:00:00Z'),
    });
    assert.deepEqual(result.alerts, []);
    assert.deepEqual(result._capVerification, { attempted: 1, failed: 1, inactive: 0 });
  }
});

test('verified active, verified inactive, and mixed CAP outcomes keep distinct health states', async () => {
  const atom = activeAtomEntry('verified-active').replace(
    '</feed>',
    activeAtomEntry('verified-cancelled', `https://${AEA_HOST}/data/aea/cap/cancelled.xml`)
      .replace(/^.*?<entry>/s, '<entry>')
      .replace(/<\/feed>.*$/s, '') + '</feed>',
  );
  const fetchFn = async (url) => {
    const href = String(url);
    if (href.endsWith('active.xml')) return new Response(capAlert(), { status: 200 });
    if (href.endsWith('cancelled.xml')) return new Response(capAlert({ msgType: 'Cancel' }), { status: 200 });
    return atomResponse(atom);
  };
  const result = await fetchAlbertaEmergencyAlerts({
    fetchFn,
    nowMs: Date.parse('2026-08-13T20:00:00Z'),
  });
  assert.deepEqual(result.alerts.map((alert) => alert.id), ['verified-active']);
  assert.deepEqual(result._capVerification, { attempted: 2, failed: 0, inactive: 1 });
  assert.deepEqual(albertaAeaAfterPublish(result), {
    freshnessMetaPatch: { sourceState: 'ok' },
  });
  assert.equal('_capVerification' in albertaAeaPublishTransform(result), false);
});

test('HTTP or off-host CAP enclosure is dropped without making a network request', async () => {
  for (const capUrl of [
    `http://${AEA_HOST}/data/aea/cap/active.xml`,
    'https://example.com/active.xml',
  ]) {
    let calls = 0;
    const atom = activeAtomEntry('bad-cap-url', capUrl);
    const result = await fetchAlbertaEmergencyAlerts({
      fetchFn: async () => {
        calls += 1;
        return atomResponse(atom);
      },
      nowMs: Date.parse('2026-08-13T20:00:00Z'),
    });
    assert.equal(calls, 1, capUrl);
    assert.deepEqual(result.alerts, []);
    assert.equal(result._capVerification.failed, 1);
  }
});
