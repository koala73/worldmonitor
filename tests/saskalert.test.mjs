import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  SASKALERT_FEED_URL,
  SASKALERT_HOST,
  SASKALERT_HOME_URL,
  SASKALERT_PROVINCE,
  SASKALERT_SOURCE,
  SASKATCHEWAN_CENTROID,
  declareSaskAlertRecords,
  fetchSaskAlerts,
  isAllowedSaskAlertHost,
  isEndedSummaryEntry,
  mapSaskAlertSeverity,
  normalizeSaskAlertRecord,
  parseSaskAlertCap,
  parseSaskAlertCoordinates,
  parseSaskAlertFeed,
  saskAlertContentMeta,
  validateSaskAlertEnvelope,
} from '../scripts/lib/saskalert.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const feed = JSON.parse(readFileSync(join(root, 'tests/fixtures/saskalert-feed.json'), 'utf8'));
const capActive = JSON.parse(readFileSync(join(root, 'tests/fixtures/saskalert-cap-active.json'), 'utf8'));
const capEnded = JSON.parse(readFileSync(join(root, 'tests/fixtures/saskalert-cap-ended.json'), 'utf8'));
const NOW = Date.parse('2026-08-18T06:00:00.000Z');

test('maps only CAP severity and fails closed on colour/level tokens', () => {
  assert.equal(mapSaskAlertSeverity('Moderate'), 'Moderate');
  assert.equal(mapSaskAlertSeverity('Extreme'), 'Extreme');
  assert.equal(mapSaskAlertSeverity('advisory'), null);
  assert.equal(mapSaskAlertSeverity('warning'), null);
  assert.equal(mapSaskAlertSeverity('yellow'), null);
  assert.equal(mapSaskAlertSeverity(''), null);
});

test('drops ended summary entries before a CAP fetch is required', () => {
  assert.equal(isEndedSummaryEntry(feed.entries[0]), true);
  assert.equal(isEndedSummaryEntry(feed.entries[1]), false);
});

test('normalizes an active CAP record onto canadaAlerts and ignores summary level', () => {
  const record = normalizeSaskAlertRecord(feed.entries[1], capActive, NOW);
  assert.equal(record.id, 'sk-saskalert-E746FB63-2A32-48EC-8AAF-D30FFC1CDDE0');
  assert.equal(record.province, SASKALERT_PROVINCE);
  assert.equal(record.source, SASKALERT_SOURCE);
  assert.equal(record.severity, 'Moderate');
  assert.equal(record.event, 'Drinking Water');
  assert.equal(record.headline, 'Precautionary Drinking Water Advisory for the Village of Macoun');
  assert.equal(record.areaDesc, 'Village of Macoun');
  assert.equal(record.url, feed.entries[1].html_link);
  assert.ok(record.lat > 49 && record.lat < 50);
  assert.ok(record.lon < -103 && record.lon > -104);
});

test('uses the province centroid only after CAP severity has passed', () => {
  const copy = structuredClone(capActive);
  copy.alert.info[0].area = [];
  const entry = { ...feed.entries[1], point: '' };
  const record = normalizeSaskAlertRecord(entry, copy, NOW);
  assert.equal(record.severity, 'Moderate');
  assert.deepEqual(record.centroid, SASKATCHEWAN_CENTROID);
});

test('fails closed when an active CAP record has no severity', () => {
  const copy = structuredClone(capActive);
  delete copy.alert.info[0].severity;
  assert.throws(
    () => normalizeSaskAlertRecord(feed.entries[1], copy, NOW),
    /missing CAP severity/,
  );
});

test('fails closed when an active entry has no CAP document', () => {
  assert.throws(
    () => normalizeSaskAlertRecord(feed.entries[1], null, NOW),
    /missing a CAP alert\/info block/,
  );
});

test('drops AllClear / Past CAP updates instead of publishing them', () => {
  assert.equal(normalizeSaskAlertRecord({
    ...feed.entries[0],
    state: 'active',
    type_en: 'Issued',
  }, capEnded, NOW), null);
});

test('parses CAP lat,lon polygons and summary lat lon points', () => {
  const polygon = parseSaskAlertCoordinates('49.3074,-103.2553 49.3117,-103.2553');
  assert.deepEqual(polygon[0], [-103.2553, 49.3074]);
  assert.deepEqual(parseSaskAlertCoordinates('49.314226 -103.261935'), [[-103.261935, 49.314226]]);
});

test('pins the official SaskAlert host and rejects lookalikes', () => {
  assert.equal(SASKALERT_HOST, 'emergencyalert.saskatchewan.ca');
  assert.equal(isAllowedSaskAlertHost(SASKALERT_FEED_URL), true);
  assert.equal(isAllowedSaskAlertHost(SASKALERT_HOME_URL), true);
  assert.equal(isAllowedSaskAlertHost('http://emergencyalert.saskatchewan.ca/sapublic/feed.json'), false);
  assert.equal(isAllowedSaskAlertHost('https://emergencyalert.saskatchewan.ca.evil.test/feed.json'), false);
  assert.equal(isAllowedSaskAlertHost('https://user@emergencyalert.saskatchewan.ca/feed.json'), false);
});

test('fetches the summary feed then only active CAP details', async () => {
  const requested = [];
  const fetchFn = async (url, options) => {
    requested.push({ url: String(url), options });
    if (String(url).endsWith('feed.json')) {
      return new Response(JSON.stringify(feed), {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    }
    if (String(url).endsWith('48404.json')) {
      return new Response(JSON.stringify(capActive), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const data = await fetchSaskAlerts({ fetchFn, nowMs: NOW });
  assert.equal(data.alerts.length, 1);
  assert.equal(data.alerts[0].severity, 'Moderate');
  assert.equal(requested.length, 2);
  assert.equal(requested[0].url, SASKALERT_FEED_URL);
  assert.equal(requested[0].options.redirect, 'error');
  assert.match(requested[0].options.headers['User-Agent'], /Mozilla/);
  assert.equal(requested[1].url, feed.entries[1].cap_link);
});

test('fails closed when an active entry has no cap_link', async () => {
  const broken = structuredClone(feed);
  delete broken.entries[1].cap_link;
  broken.entries = [broken.entries[1]];
  const fetchFn = async () => new Response(JSON.stringify(broken), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
  await assert.rejects(fetchSaskAlerts({ fetchFn, nowMs: NOW }), /missing cap_link/);
});

test('exposes the zero-valid envelope and content-age contract', () => {
  const record = normalizeSaskAlertRecord(feed.entries[1], capActive, NOW);
  const envelope = { alerts: [record] };
  assert.equal(validateSaskAlertEnvelope(envelope), true);
  assert.equal(validateSaskAlertEnvelope({ alerts: 'nope' }), false);
  assert.equal(declareSaskAlertRecords(envelope), 1);
  assert.equal(declareSaskAlertRecords({ alerts: [] }), 0);
  assert.deepEqual(saskAlertContentMeta(envelope, NOW), {
    newestItemAt: record.updatedAt,
    oldestItemAt: record.updatedAt,
  });
});

test('registers the province seeder in the Canada bundle without touching roads or weather', () => {
  const seeder = readFileSync(join(root, 'scripts/seed-saskalert.mjs'), 'utf8');
  const bundle = readFileSync(join(root, 'scripts/seed-bundle-canada.mjs'), 'utf8');
  const union = readFileSync(join(root, 'scripts/lib/canada-alerts-union.mjs'), 'utf8');
  assert.match(seeder, /runSeed\('alerts', 'saskalert'/);
  assert.match(seeder, /rebuildCanadaAlertsUnion/);
  assert.doesNotMatch(seeder, /weather:alerts|canadaRoads|511|ais-relay|pelmorex/i);
  assert.match(bundle, /label: 'SaskAlert'/);
  assert.match(bundle, /dependsOn: \['BC-Emergency-Info'\]/);
  assert.match(union, /province: 'SK'/);
  assert.match(union, /alerts:canada:saskalert:v1/);
});

test('parses the live feed and CAP shapes used by the fixtures', () => {
  assert.equal(parseSaskAlertFeed(feed).length, 2);
  assert.equal(parseSaskAlertCap(capActive).alert.identifier, 'E746FB63-2A32-48EC-8AAF-D30FFC1CDDE0');
});
