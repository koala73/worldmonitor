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
  isEndedCapAlert,
  isEndedSummaryEntry,
  mapSaskAlertSeverity,
  normalizeSaskAlertRecord,
  parseSaskAlertCap,
  parseSaskAlertCoordinates,
  parseSaskAlertFeed,
  saskAlertAfterPublish,
  saskAlertContentMeta,
  saskAlertPublishTransform,
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
  assert.equal(isAllowedSaskAlertHost('https://emergencyalert.saskatchewan.ca:8443/feed.json'), false);
  assert.equal(isAllowedSaskAlertHost('https://user:pass@emergencyalert.saskatchewan.ca/feed.json'), false);
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
  assert.equal(data._capVerification.failed, 0);
  assert.equal(saskAlertAfterPublish(data).freshnessMetaPatch.sourceState, 'ok');
});

test('skips a missing cap_link instead of aborting the SK tick', async () => {
  const broken = structuredClone(feed);
  delete broken.entries[1].cap_link;
  broken.entries = [broken.entries[1]];
  const fetchFn = async () => new Response(JSON.stringify(broken), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
  const data = await fetchSaskAlerts({ fetchFn, nowMs: NOW });
  assert.equal(data.alerts.length, 0);
  assert.equal(data._capVerification.failed, 1);
});

test('rejects an off-host feed URL before fetchFn runs', async () => {
  const requested = [];
  const fetchFn = async (url) => {
    requested.push(String(url));
    throw new Error(`unexpected fetch ${url}`);
  };
  await assert.rejects(
    fetchSaskAlerts({ url: 'https://evil.example/feed.json', fetchFn, nowMs: NOW }),
    /allowlist/,
  );
  assert.deepEqual(requested, []);
});

test('does not fetch an off-host cap_link and still publishes siblings', async () => {
  const mixed = structuredClone(feed);
  mixed.entries = [
    {
      ...feed.entries[1],
      identifier: 'good-cap',
      cap_link: feed.entries[1].cap_link,
    },
    {
      ...feed.entries[1],
      identifier: 'evil-cap',
      cap_link: 'https://evil.example/cap.json',
    },
  ];
  const requested = [];
  const fetchFn = async (url) => {
    requested.push(String(url));
    if (String(url).endsWith('feed.json')) {
      return new Response(JSON.stringify(mixed), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
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
  assert.equal(data.alerts[0].id, 'sk-saskalert-good-cap');
  assert.equal(data._capVerification.failed, 1);
  assert.ok(!requested.some((url) => url.includes('evil.example')));
});

test('one CAP HTTP failure still publishes the remaining SK records', async () => {
  const mixed = structuredClone(feed);
  mixed.entries = [
    { ...feed.entries[1], identifier: 'ok-1', cap_link: 'https://emergencyalert.saskatchewan.ca/sapublic/ok.json' },
    { ...feed.entries[1], identifier: 'bad-1', cap_link: 'https://emergencyalert.saskatchewan.ca/sapublic/bad.json' },
  ];
  const fetchFn = async (url) => {
    if (String(url).endsWith('feed.json')) {
      return new Response(JSON.stringify(mixed), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (String(url).endsWith('ok.json')) {
      return new Response(JSON.stringify(capActive), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('missing', { status: 404 });
  };
  const data = await fetchSaskAlerts({ fetchFn, nowMs: NOW, capConcurrency: 1 });
  assert.equal(data.alerts.length, 1);
  assert.equal(data._capVerification.failed, 1);
  assert.equal(saskAlertAfterPublish(data).freshnessMetaPatch.sourceState, 'degraded');
  assert.deepEqual(saskAlertPublishTransform(data), { alerts: data.alerts });
});

test('stops starting CAP fetches once the section budget is spent', async () => {
  const crowded = structuredClone(feed);
  crowded.entries = [
    { ...feed.entries[1], identifier: 'late-1', cap_link: 'https://emergencyalert.saskatchewan.ca/sapublic/late-1.json' },
    { ...feed.entries[1], identifier: 'late-2', cap_link: 'https://emergencyalert.saskatchewan.ca/sapublic/late-2.json' },
  ];
  const requested = [];
  const fetchFn = async (url) => {
    requested.push(String(url));
    if (String(url).endsWith('feed.json')) {
      return new Response(JSON.stringify(crowded), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`unexpected CAP fetch ${url}`);
  };
  const data = await fetchSaskAlerts({
    fetchFn,
    nowMs: NOW,
    nowWallMs: NOW,
    capBudgetMs: 0,
    capConcurrency: 1,
  });
  assert.equal(data.alerts.length, 0);
  assert.ok(data._capVerification.skippedDeadline >= 2);
  assert.equal(requested.length, 1);
  assert.ok(requested[0].endsWith('feed.json'));
});

test('drops expired, Exercise, Restricted, and Cancel CAP records without AllClear tokens', () => {
  const baseEntry = { ...feed.entries[1], summary_en: 'Active advisory', event_en: 'Drinking Water' };
  const cloneInfo = (patch) => {
    const copy = structuredClone(capActive);
    Object.assign(copy.alert, patch.alert || {});
    Object.assign(copy.alert.info[0], patch.info || {});
    return copy;
  };
  assert.equal(
    normalizeSaskAlertRecord(baseEntry, cloneInfo({ info: { expires: '2026-08-17T00:00:00.000Z', urgency: 'Immediate', responseType: 'Prepare', headline: 'Boil water', description: 'Stay tuned' } }), NOW),
    null,
  );
  assert.equal(isEndedCapAlert(cloneInfo({ alert: { status: 'Exercise' } }).alert, cloneInfo({ alert: { status: 'Exercise' } }).alert.info[0], NOW), true);
  assert.equal(
    normalizeSaskAlertRecord(baseEntry, cloneInfo({ alert: { status: 'Exercise' }, info: { headline: 'Drill', description: 'Practice only' } }), NOW),
    null,
  );
  assert.equal(
    normalizeSaskAlertRecord(baseEntry, cloneInfo({ alert: { scope: 'Restricted' }, info: { headline: 'Internal', description: 'Staff only' } }), NOW),
    null,
  );
  assert.equal(
    normalizeSaskAlertRecord(baseEntry, cloneInfo({ alert: { msgType: 'Cancel' }, info: { headline: 'Withdrawn', description: 'No longer in force' } }), NOW),
    null,
  );
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
  assert.match(seeder, /publishTransform: saskAlertPublishTransform/);
  assert.match(seeder, /CANADA_ALERT_UNION_REBUILD_FAILED/);
  // Both sibling acks were pruned on 2026-08-20 once the probes published, so
  // assert the pairing directionally: #6659 was allowed to own four rows only
  // because they share ONE first-Railway-tick anchor, and re-adding one sibling
  // without the other would quietly break that justification.
  const baseline = JSON.parse(readFileSync(join(root, 'scripts/seed-freshness-baseline.json'), 'utf8'));
  const sk = baseline.acknowledged.find((entry) => entry.name === 'canadaAlertsSkSource');
  const ab = baseline.acknowledged.find((entry) => entry.name === 'canadaAlertsAbSource');
  assert.equal(
    Boolean(sk),
    Boolean(ab),
    'the SaskAlert and Alberta sibling acknowledgements live and die together',
  );
  if (sk && ab) {
    assert.equal(sk.status, 'STALE_SEED');
    assert.equal(sk.expiresAt, ab.expiresAt);
    assert.equal(sk.cutover.firstScheduledRunAt, ab.cutover.firstScheduledRunAt);
  }
});

test('parses the live feed and CAP shapes used by the fixtures', () => {
  assert.equal(parseSaskAlertFeed(feed).length, 2);
  assert.equal(parseSaskAlertCap(capActive).alert.identifier, 'E746FB63-2A32-48EC-8AAF-D30FFC1CDDE0');
});
