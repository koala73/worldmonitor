import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { __testing__ as limiterTesting } from '../scripts/_511-rate-limit.mjs';
import { __testing__ as healthTesting } from '../api/health.js';
import {
  ALBERTA_511,
  CHROME_UA,
  MANITOBA_511,
  MAX_RECORDS,
  ONTARIO_511,
  VENDOR_511_HOSTS,
  centroidOfPath,
  decodeEncodedPolyline,
  declareVendor511Records,
  fetchVendor511,
  get,
  isCompleteVendor511,
  isVendor511Host,
  normalize511List,
  normalize511Record,
  redactVendor511Secret,
  select511Records,
  validateVendor511Envelope,
  vendor511Path,
  vendor511RequestIdentity,
} from '../scripts/lib/provincial-511.mjs';

test.afterEach(() => {
  limiterTesting.reset();
});

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

test('vendor paths use /api/v2/get except roadconditions which uses v3', () => {
  assert.equal(vendor511Path('event'), '/api/v2/get/event');
  assert.equal(vendor511Path('alerts'), '/api/v2/get/alerts');
  assert.equal(vendor511Path('roadconditions'), '/api/v3/get/roadconditions');
});

test('Ontario is the first vendor config; BC Open511 is not on the allowlist', () => {
  assert.equal(ONTARIO_511.jurisdiction, 'ON');
  assert.equal(VENDOR_511_HOSTS['511on.ca'].jurisdiction, 'ON');
  assert.equal(isVendor511Host('511on.ca'), true);
  assert.equal(isVendor511Host('api.open511.gov.bc.ca'), false);
  assert.equal(isVendor511Host('open511.gov.bc.ca'), false);
  assert.equal(isVendor511Host('has'), false);
  assert.equal(Object.hasOwn(VENDOR_511_HOSTS, 'has'), false);
});

test('Alberta 511 is on the vendor allowlist', () => {
  assert.equal(ALBERTA_511.jurisdiction, 'AB');
  assert.equal(ALBERTA_511.baseUrl, 'https://511.alberta.ca');
  assert.deepEqual(ALBERTA_511.resources.map((r) => r.resource), ['event', 'alerts']);
  assert.equal(VENDOR_511_HOSTS['511.alberta.ca'].jurisdiction, 'AB');
  assert.equal(isVendor511Host('511.alberta.ca'), true);
  assert.equal(isVendor511Host('511.gov.mb.ca'), false);
});

test('Manitoba 511 is the third vendor config and requires key= plus lang=en', () => {
  assert.equal(MANITOBA_511.jurisdiction, 'MB');
  assert.equal(MANITOBA_511.baseUrl, 'https://www.manitoba511.ca');
  assert.equal(MANITOBA_511.lang, 'en');
  assert.deepEqual(MANITOBA_511.resources.map((r) => r.resource), ['event', 'alerts']);
  assert.equal(VENDOR_511_HOSTS['www.manitoba511.ca'].jurisdiction, 'MB');
  assert.equal(isVendor511Host('www.manitoba511.ca'), true);
  assert.equal(isVendor511Host('manitoba511.ca'), false);
});

test('empty event/alert/condition lists are valid', () => {
  assert.deepEqual(normalize511List([], 'event', 'ON'), []);
  assert.equal(declareVendor511Records({ events: [], alerts: [], conditions: [] }), 0);
  assert.equal(validateVendor511Envelope({ events: [], alerts: [], conditions: [] }), true);
});

test('event lat/lon are preserved as centroid [lon, lat]', () => {
  const record = normalize511Record({
    ID: 216791,
    Latitude: 42.853554,
    Longitude: -81.27517,
    EventType: 'roadwork',
    IsFullClosure: true,
    Severity: 'Unknown',
    Description: 'ALL LANES CLOSED',
    LanesAffected: 'ALL LANES CLOSED',
    EncodedPolyline: null,
  }, { kind: 'event', jurisdiction: 'ON' });
  assert.equal(record.id, '216791');
  assert.equal(record.lat, 42.853554);
  assert.equal(record.lon, -81.27517);
  assert.deepEqual(record.centroid, [-81.27517, 42.853554]);
  assert.equal(record.isFullClosure, true);
  assert.equal(record.jurisdiction, 'ON');
  assert.equal(record.severity, 'Extreme');
});

test('missing lat/lon falls back to a polyline centroid', () => {
  const encoded = 'yklkG|jqcNC?aDd@mCd@eC`@sARe@HqAR}Cf@{@LsARqBZaBVUBqEp@{@L{@JwAP_CRu@DkF^qJp@}F';
  const path = decodeEncodedPolyline(encoded);
  assert.ok(path.length > 1);
  const expected = centroidOfPath(path);
  const record = normalize511Record({
    ID: 225175,
    EncodedPolyline: encoded,
    EventType: 'roadwork',
    Description: 'lane restriction',
  }, { kind: 'event', jurisdiction: 'ON' });
  assert.equal(record.lat, null);
  assert.equal(record.lon, null);
  assert.ok(record.centroid);
  assert.equal(record.centroid[0].toFixed(3), expected[0].toFixed(3));
  assert.equal(record.centroid[1].toFixed(3), expected[1].toFixed(3));
  assert.ok(record.centroid[1] > 40 && record.centroid[1] < 50);
  assert.ok(record.centroid[0] < -74 && record.centroid[0] > -90);
});

test('roadconditions EncodedPolyline arrays decode to a path and centroid', () => {
  const encoded = 'yklkG|jqcNC?aDd@mCd@eC`@sARe@HqAR}Cf@{@LsARqBZaBVUBqEp@{@L{@JwAP_CRu@DkF^qJp@}F';
  const record = normalize511Record({
    LocationDescription: 'From Highway 17 to Pukaskwa Park',
    Condition: ['No Report'],
    RoadwayName: '627',
    EncodedPolyline: [encoded],
  }, { kind: 'condition', jurisdiction: 'ON' });
  assert.equal(record.eventType, 'roadcondition');
  assert.ok(Array.isArray(record.path) && record.path.length > 1);
  assert.ok(record.centroid);
});

test('ended/empty alerts without coordinates stay valid map-less records', () => {
  const record = normalize511Record({
    Id: 635,
    Message: 'Restricted Fire Zone',
    Regions: ['Northeastern'],
    HighImportance: true,
  }, { kind: 'alert', jurisdiction: 'ON' });
  assert.equal(record.kind, 'alert');
  assert.equal(record.lat, null);
  assert.equal(record.centroid, null);
  assert.equal(record.severity, 'Severe');
});

test('get() fetches Ontario event over /api/v2/get/event?format=json', async () => {
  const urls = [];
  const fetchFn = async (url, init) => {
    urls.push({ url: String(url), init });
    return jsonResponse([{
      ID: 1,
      Latitude: 43.65,
      Longitude: -79.38,
      EventType: 'accidentsAndIncidents',
      Description: 'collision',
    }]);
  };
  const result = await get('https://511on.ca', 'event', { fetchFn });
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].lat, 43.65);
  assert.equal(result.records[0].lon, -79.38);
  assert.match(urls[0].url, /^https:\/\/511on\.ca\/api\/v2\/get\/event\?format=json$/);
  assert.equal(urls[0].init.redirect, 'error');
  assert.equal(typeof urls[0].init.fetch, 'undefined');
  assert.equal(limiterTesting.pendingTokens('511on.ca'), 1);
});

test('get() uses /api/v3/get/roadconditions for that resource', async () => {
  const urls = [];
  const fetchFn = async (url) => {
    urls.push(String(url));
    return jsonResponse([]);
  };
  const result = await get('https://511on.ca', 'roadconditions', { fetchFn });
  assert.equal(result.records.length, 0);
  assert.match(urls[0], /\/api\/v3\/get\/roadconditions\?format=json$/);
});

test('three Ontario resources consume 3 tokens', async () => {
  const fetchFn = async () => jsonResponse([]);
  await fetchVendor511(ONTARIO_511, { fetchFn, staggerMs: 0 });
  assert.equal(limiterTesting.pendingTokens('511on.ca'), 3);
});

test('one endpoint failure does not empty the others', async () => {
  const fetchFn = async (url) => {
    if (String(url).includes('/alerts')) {
      return new Response('nope', { status: 503 });
    }
    if (String(url).includes('/event')) {
      return jsonResponse([{ ID: 1, Latitude: 43.6, Longitude: -79.4, EventType: 'closures', IsFullClosure: true }]);
    }
    return jsonResponse([{ LocationDescription: 'Hwy 401', EncodedPolyline: ['yklkG|jqcNC?'] }]);
  };
  const envelope = await fetchVendor511(ONTARIO_511, { fetchFn, staggerMs: 0 });
  assert.equal(envelope.events.length, 1);
  assert.equal(envelope.alerts.length, 0);
  assert.equal(envelope.conditions.length, 1);
  assert.deepEqual(envelope.failedResources, ['alerts']);
  assert.equal(declareVendor511Records(envelope), 2);
});

test('all-endpoint failure throws so last-good is preserved', async () => {
  const fetchFn = async () => new Response('down', { status: 500 });
  await assert.rejects(
    () => fetchVendor511(ONTARIO_511, { fetchFn, staggerMs: 0 }),
    /all endpoints failed/,
  );
});

test('Ontario partial poll must not replace last-good or flip health green', async () => {
  // events fail, alerts+conditions empty-success — surviving [] must not be a successor
  const eventsDownOthersEmpty = async (url) => {
    if (String(url).includes('/event')) return new Response('nope', { status: 503 });
    return jsonResponse([]);
  };
  limiterTesting.reset();
  const partialEmpty = await fetchVendor511(ONTARIO_511, {
    fetchFn: eventsDownOthersEmpty,
    staggerMs: 0,
  });
  assert.equal(partialEmpty.events.length, 0);
  assert.equal(partialEmpty.alerts.length, 0);
  assert.equal(partialEmpty.conditions.length, 0);
  assert.deepEqual(partialEmpty.failedResources, ['event']);
  assert.equal(isCompleteVendor511(partialEmpty, ONTARIO_511), false);

  // one resource errors while the others return records
  const eventsDownOthersOk = async (url) => {
    if (String(url).includes('/event')) return new Response('nope', { status: 500 });
    if (String(url).includes('/alerts')) {
      return jsonResponse([{
        Id: 635,
        Message: 'Restricted Fire Zone',
        HighImportance: true,
      }]);
    }
    return jsonResponse([{
      LocationDescription: 'Hwy 401',
      Condition: ['Bare and dry'],
      RoadwayName: '401',
      EncodedPolyline: ['yklkG|jqcNC?'],
    }]);
  };
  limiterTesting.reset();
  const partialOthers = await fetchVendor511(ONTARIO_511, {
    fetchFn: eventsDownOthersOk,
    staggerMs: 0,
  });
  assert.equal(partialOthers.alerts.length, 1);
  assert.equal(partialOthers.conditions.length, 1);
  assert.deepEqual(partialOthers.failedResources, ['event']);
  assert.equal(isCompleteVendor511(partialOthers, ONTARIO_511), false);

  const alertsDownOthersOk = async (url) => {
    if (String(url).includes('/alerts')) return new Response('nope', { status: 502 });
    if (String(url).includes('/event')) {
      return jsonResponse([{
        ID: 216791,
        Latitude: 42.853554,
        Longitude: -81.27517,
        EventType: 'closures',
        IsFullClosure: true,
      }]);
    }
    return jsonResponse([]);
  };
  limiterTesting.reset();
  const partialAlerts = await fetchVendor511(ONTARIO_511, {
    fetchFn: alertsDownOthersOk,
    staggerMs: 0,
  });
  assert.equal(partialAlerts.events.length, 1);
  assert.deepEqual(partialAlerts.failedResources, ['alerts']);
  assert.equal(isCompleteVendor511(partialAlerts, ONTARIO_511), false);

  const conditionsDownOthersOk = async (url) => {
    if (String(url).includes('/roadconditions')) return new Response('nope', { status: 504 });
    return jsonResponse([]);
  };
  limiterTesting.reset();
  const partialConditions = await fetchVendor511(ONTARIO_511, {
    fetchFn: conditionsDownOthersOk,
    staggerMs: 0,
  });
  assert.equal(partialConditions.events.length, 0);
  assert.equal(partialConditions.alerts.length, 0);
  assert.deepEqual(partialConditions.failedResources, ['roadconditions']);
  assert.equal(isCompleteVendor511(partialConditions, ONTARIO_511), false);

  // complete successor: every configured Ontario resource succeeds (empty lists OK).
  const completeQuiet = async (url) => {
    if (String(url).includes('/event')) {
      return jsonResponse([{
        ID: 216791,
        Latitude: 42.853554,
        Longitude: -81.27517,
        EventType: 'closures',
        IsFullClosure: true,
      }]);
    }
    return jsonResponse([]);
  };
  limiterTesting.reset();
  const complete = await fetchVendor511(ONTARIO_511, {
    fetchFn: completeQuiet,
    staggerMs: 0,
  });
  assert.equal(complete.events.length, 1);
  assert.equal(complete.alerts.length, 0);
  assert.equal(complete.conditions.length, 0);
  assert.deepEqual(complete.failedResources, []);
  assert.equal(isCompleteVendor511(complete, ONTARIO_511), true);
  assert.deepEqual(
    ONTARIO_511.resources.map((r) => r.resource),
    ['event', 'alerts', 'roadconditions'],
  );

  // Seeder maps !complete → throw → runSeed preserveExistingKeys (TTL only).
  // That keeps last-good and does not write fresh seed-meta / OK_ZERO
  // (health stays put).
  const seeder = readFileSync(new URL('../scripts/seed-provincial-511.mjs', import.meta.url), 'utf8');
  assert.match(seeder, /isCompleteVendor511\(envelope, ONTARIO_511\)/);
  assert.match(seeder, /partial poll \(\$\{failed\} failed\); keeping last-good/);
  assert.match(seeder, /runSeed\('infra', 'ontario-511'/);
  assert.doesNotMatch(seeder, /publishing \$\{records\.length\} surviving/);
  const fetchOntario = seeder.slice(
    seeder.indexOf('async function fetchOntario511'),
    seeder.indexOf('export function declareRecords'),
  );
  assert.match(fetchOntario, /if \(!isCompleteVendor511\(envelope, ONTARIO_511\)\)/);
  assert.match(fetchOntario, /new Error\(`Ontario 511: partial poll/);
  assert.match(fetchOntario, /nonRetryable = true/);
  assert.match(fetchOntario, /throw err/);
  assert.ok(
    fetchOntario.indexOf('new Error')
    < fetchOntario.indexOf('return { records:'),
    'partial ticks must throw before any last-good successor is returned',
  );
});

test('last-good complete; next poll partial → last-good unchanged, health not green', async () => {
  const completeFn = async (url) => {
    if (String(url).includes('/event')) {
      return jsonResponse([{
        ID: 216791,
        Latitude: 42.853554,
        Longitude: -81.27517,
        EventType: 'closures',
        IsFullClosure: true,
      }]);
    }
    if (String(url).includes('/alerts')) {
      return jsonResponse([{
        Id: 635,
        Message: 'Restricted Fire Zone',
        HighImportance: true,
      }]);
    }
    return jsonResponse([{
      LocationDescription: 'Hwy 401',
      Condition: ['Bare and dry'],
      RoadwayName: '401',
      EncodedPolyline: ['yklkG|jqcNC?'],
    }]);
  };
  const complete = await fetchVendor511(ONTARIO_511, { fetchFn: completeFn, staggerMs: 0 });
  assert.equal(isCompleteVendor511(complete, ONTARIO_511), true);
  const lastGood = {
    records: select511Records([...complete.events, ...complete.alerts, ...complete.conditions]),
  };
  assert.ok(lastGood.records.length >= 3);
  const lastGoodIds = lastGood.records.map((r) => r.id).sort();

  const { classifyKey, STATUS_COUNTS, BOOTSTRAP_KEYS, SEED_META } = healthTesting;
  const NOW = 1_700_000_000_000;
  const redisKey = BOOTSTRAP_KEYS.canadaRoads;
  const metaKey = SEED_META.canadaRoads.key;
  const lastGoodHealth = classifyKey('canadaRoads', redisKey, { allowOnDemand: false }, {
    keyStrens: new Map([[redisKey, 256]]),
    keyErrors: new Map(),
    keyMetaValues: new Map([[metaKey, JSON.stringify({
      fetchedAt: NOW - 5 * 60_000,
      recordCount: lastGood.records.length,
    })]]),
    keyMetaErrors: new Map(),
    now: NOW,
  });
  assert.equal(lastGoodHealth.status, 'OK');
  assert.equal(STATUS_COUNTS[lastGoodHealth.status], 'ok');

  const partialFn = async (url) => {
    if (String(url).includes('/alerts')) return new Response('nope', { status: 503 });
    if (String(url).includes('/event')) {
      return jsonResponse([{
        ID: 1,
        Latitude: 43.6,
        Longitude: -79.4,
        EventType: 'roadwork',
      }]);
    }
    return jsonResponse([]);
  };
  const partial = await fetchVendor511(ONTARIO_511, { fetchFn: partialFn, staggerMs: 0 });
  assert.equal(isCompleteVendor511(partial, ONTARIO_511), false);
  assert.deepEqual(partial.failedResources, ['alerts']);
  assert.ok(partial.records.length > 0, 'surviving records would have replaced last-good');

  let stored = lastGood;
  let tickHealthGreen = false;
  if (isCompleteVendor511(partial, ONTARIO_511)) {
    stored = {
      records: select511Records([...partial.events, ...partial.alerts, ...partial.conditions]),
    };
    tickHealthGreen = true;
  }
  assert.equal(stored, lastGood);
  assert.deepEqual(stored.records.map((r) => r.id).sort(), lastGoodIds);
  assert.equal(tickHealthGreen, false);

  // Throwing skips runSeed publish + fresh seed-meta. A leaked partial write
  // with fresh fetchedAt would classify OK (the hole); this tick must not.
  const leakedPartialHealth = classifyKey('canadaRoads', redisKey, { allowOnDemand: false }, {
    keyStrens: new Map([[redisKey, 128]]),
    keyErrors: new Map(),
    keyMetaValues: new Map([[metaKey, JSON.stringify({
      fetchedAt: NOW,
      recordCount: partial.records.length,
    })]]),
    keyMetaErrors: new Map(),
    now: NOW,
  });
  assert.equal(leakedPartialHealth.status, 'OK', 'fixture: publishing the partial would flip health green');
  assert.equal(STATUS_COUNTS[leakedPartialHealth.status], 'ok');
  assert.equal(tickHealthGreen, false, 'partial poll must not be a health-green successor');
});

test('Alberta partial poll must not replace last-good or flip health green', async () => {
  // events fail, alerts empty-success — surviving [] must not be a successor
  const eventsDownAlertsEmpty = async (url) => {
    if (String(url).includes('/event')) return new Response('nope', { status: 503 });
    return jsonResponse([]);
  };
  const partialEmpty = await fetchVendor511(ALBERTA_511, {
    fetchFn: eventsDownAlertsEmpty,
    staggerMs: 0,
  });
  assert.equal(partialEmpty.events.length, 0);
  assert.equal(partialEmpty.alerts.length, 0);
  assert.deepEqual(partialEmpty.failedResources, ['event']);
  assert.equal(isCompleteVendor511(partialEmpty, ALBERTA_511), false);

  // one resource errors while the other returns records
  const eventsDownAlertsOk = async (url) => {
    if (String(url).includes('/event')) return new Response('nope', { status: 500 });
    return jsonResponse(ALBERTA_ALERTS_FIXTURE);
  };
  const partialAlerts = await fetchVendor511(ALBERTA_511, {
    fetchFn: eventsDownAlertsOk,
    staggerMs: 0,
  });
  assert.equal(partialAlerts.alerts.length, 2);
  assert.deepEqual(partialAlerts.failedResources, ['event']);
  assert.equal(isCompleteVendor511(partialAlerts, ALBERTA_511), false);

  const alertsDownEventsOk = async (url) => {
    if (String(url).includes('/alerts')) return new Response('nope', { status: 502 });
    return jsonResponse([{
      ID: 44001,
      Latitude: 51.0447,
      Longitude: -114.0719,
      EventType: 'closures',
      IsFullClosure: true,
    }]);
  };
  const partialEvents = await fetchVendor511(ALBERTA_511, {
    fetchFn: alertsDownEventsOk,
    staggerMs: 0,
  });
  assert.equal(partialEvents.events.length, 1);
  assert.deepEqual(partialEvents.failedResources, ['alerts']);
  assert.equal(isCompleteVendor511(partialEvents, ALBERTA_511), false);

  // complete successor: both configured resources succeed (empty alerts is OK).
  // roadconditions 404s and is not in ALBERTA_511.resources.
  const completeQuietAlerts = async (url) => {
    assert.equal(String(url).includes('roadconditions'), false);
    if (String(url).includes('/event')) {
      return jsonResponse([{
        ID: 44001,
        Latitude: 51.0447,
        Longitude: -114.0719,
        EventType: 'closures',
        IsFullClosure: true,
      }]);
    }
    return jsonResponse([]);
  };
  const complete = await fetchVendor511(ALBERTA_511, {
    fetchFn: completeQuietAlerts,
    staggerMs: 0,
  });
  assert.equal(complete.events.length, 1);
  assert.equal(complete.alerts.length, 0);
  assert.deepEqual(complete.failedResources, []);
  assert.equal(isCompleteVendor511(complete, ALBERTA_511), true);
  assert.deepEqual(ALBERTA_511.resources.map((r) => r.resource), ['event', 'alerts']);

  // Seeder maps !complete → throw → preserveAlberta (TTL only). That keeps
  // last-good and does not write fresh seed-meta / OK_ZERO (health stays put).
  const seeder = readFileSync(new URL('../scripts/seed-provincial-511.mjs', import.meta.url), 'utf8');
  assert.match(seeder, /isCompleteVendor511\(envelope, ALBERTA_511\)/);
  assert.match(seeder, /partial poll \(\$\{failed\} failed\); keeping last-good/);
  assert.match(seeder, /preserving last-good \(fetch failed this tick\)/);
  assert.match(seeder, /extendExistingTtl\(\[ALBERTA_KEY, ALBERTA_META_KEY\]/);
  assert.doesNotMatch(seeder, /publishing \$\{records\.length\} surviving/);
  assert.equal(seeder.includes('writeExtraKey(ALBERTA_KEY') && seeder.includes('writeSeedMeta(ALBERTA_KEY'), true);
  const fetchAlberta = seeder.slice(seeder.indexOf('async function fetchAlberta511'), seeder.indexOf('async function fetchProvincial511Tick'));
  const publishAlberta = seeder.slice(seeder.indexOf('async function publishAlbertaFromTick'));
  assert.match(fetchAlberta, /if \(!isCompleteVendor511\(envelope, ALBERTA_511\)\)/);
  assert.match(fetchAlberta, /new Error\(`Alberta 511: partial poll/);
  assert.match(fetchAlberta, /nonRetryable = true/);
  assert.match(fetchAlberta, /throw err/);
  assert.match(publishAlberta, /if \(!data \|\| data\._albertaFailed\)/);
  assert.match(publishAlberta, /await preserveAlberta\(\)/);
  assert.ok(
    publishAlberta.indexOf('await preserveAlberta()')
    < publishAlberta.indexOf('await publishAlbertaEnvelope'),
    'partial/failed ticks must preserve last-good before any envelope write',
  );
});

test('BC Open511 host is rejected and does not use this /api/v2/get client', async () => {
  let called = false;
  const fetchFn = async () => {
    called = true;
    return jsonResponse([]);
  };
  await assert.rejects(
    () => get('https://api.open511.gov.bc.ca', 'events', { fetchFn }),
    /not on the vendor \/api\/v2\/get allowlist/,
  );
  assert.equal(called, false);
  assert.equal(limiterTesting.pendingTokens('api.open511.gov.bc.ca'), 0);
});

test('responses larger than 5MB are rejected', async () => {
  const fetchFn = async () => jsonResponse([], {
    headers: { 'content-length': String(5 * 1024 * 1024 + 1) },
  });
  await assert.rejects(
    () => get('https://511on.ca', 'event', { fetchFn }),
    /exceeds 5242880 bytes/,
  );
});

const ALBERTA_ALERTS_FIXTURE = JSON.parse(
  readFileSync(new URL('./fixtures/alberta-511-alerts.json', import.meta.url), 'utf8'),
);
const ADAPTER_SOURCE = readFileSync(new URL('../scripts/lib/provincial-511.mjs', import.meta.url), 'utf8');

test('get() fetches Alberta alerts over /api/v2/get/alerts?format=json from the captured fixture', async () => {
  const urls = [];
  const fetchFn = async (url, init) => {
    urls.push({ url: String(url), init });
    return jsonResponse(ALBERTA_ALERTS_FIXTURE);
  };
  const result = await get('https://511.alberta.ca', 'alerts', { fetchFn });
  assert.equal(result.records.length, 2);
  assert.equal(result.records[0].id, '1676');
  assert.equal(result.records[0].kind, 'alert');
  assert.equal(result.records[0].jurisdiction, 'AB');
  assert.equal(result.records[0].headline.includes('Rainfall warning'), true);
  assert.equal(result.records[1].severity, 'Severe');
  assert.equal(result.records[1].centroid, null);
  assert.match(urls[0].url, /^https:\/\/511\.alberta\.ca\/api\/v2\/get\/alerts\?format=json$/);
  assert.equal(urls[0].init.redirect, 'error');
  assert.equal(urls[0].init.headers['User-Agent'], CHROME_UA);
  assert.equal(typeof urls[0].init.fetch, 'undefined');
  assert.equal(limiterTesting.pendingTokens('511.alberta.ca'), 1);
  assert.equal(limiterTesting.pendingTokens('511on.ca'), 0);
});

test('Alberta events+alerts consume 2 tokens of the 511.alberta.ca bucket, not Ontario\'s', async () => {
  const fetchFn = async () => jsonResponse([]);
  await fetchVendor511(ALBERTA_511, { fetchFn, staggerMs: 0 });
  assert.equal(limiterTesting.pendingTokens('511.alberta.ca'), 2);
  assert.equal(limiterTesting.pendingTokens('511on.ca'), 0);
});

test('fetchVendor511(ALBERTA_511) pulls events and alerts from the vendor adapter', async () => {
  const urls = [];
  const fetchFn = async (url) => {
    urls.push(String(url));
    if (String(url).includes('/event')) {
      return jsonResponse([{
        ID: 44001,
        Latitude: 51.0447,
        Longitude: -114.0719,
        EventType: 'closures',
        IsFullClosure: true,
        Description: 'Deerfoot Trail closed',
      }]);
    }
    return jsonResponse(ALBERTA_ALERTS_FIXTURE);
  };
  const envelope = await fetchVendor511(ALBERTA_511, { fetchFn, staggerMs: 0 });
  assert.equal(envelope.events.length, 1);
  assert.equal(envelope.alerts.length, 2);
  assert.equal(envelope.events[0].jurisdiction, 'AB');
  assert.equal(envelope.events[0].kind, 'event');
  assert.equal(envelope.events[0].isFullClosure, true);
  assert.ok(urls.some((url) => /\/api\/v2\/get\/event\?format=json$/.test(url)));
  assert.ok(urls.some((url) => /\/api\/v2\/get\/alerts\?format=json$/.test(url)));
});

test('adapter uses CHROME_UA, no fetch.bind, and allowlists 511.alberta.ca', () => {
  assert.match(ADAPTER_SOURCE, /CHROME_UA/);
  assert.match(ADAPTER_SOURCE, /511\.alberta\.ca/);
  assert.match(ADAPTER_SOURCE, /www\.manitoba511\.ca/);
  assert.match(ADAPTER_SOURCE, /acquire511Slot\(hostname\)/);
  assert.doesNotMatch(ADAPTER_SOURCE, /fetch\.bind/);
  assert.doesNotMatch(ADAPTER_SOURCE, /open511\.gov\.bc/);
});

const MANITOBA_EVENTS_FIXTURE = JSON.parse(
  readFileSync(new URL('./fixtures/manitoba-511-events.json', import.meta.url), 'utf8'),
);
const MANITOBA_ALERTS_FIXTURE = JSON.parse(
  readFileSync(new URL('./fixtures/manitoba-511-alerts.json', import.meta.url), 'utf8'),
);

test('get() fetches Manitoba events with format=json, lang=en, and a redacted key identity', async () => {
  const secret = 'mb-test-key-not-a-real-secret';
  const urls = [];
  const fetchFn = async (url, init) => {
    urls.push({ url: String(url), init });
    return jsonResponse(MANITOBA_EVENTS_FIXTURE);
  };
  const result = await get('https://www.manitoba511.ca', 'event', {
    fetchFn,
    key: secret,
    lang: 'en',
  });
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].id, '88001');
  assert.equal(result.records[0].jurisdiction, 'MB');
  assert.equal(result.records[0].isFullClosure, true);
  assert.match(urls[0].url, /^https:\/\/www\.manitoba511\.ca\/api\/v2\/get\/event\?format=json&lang=en&key=/);
  assert.equal(urls[0].url.includes(secret), true);
  assert.equal(result.requestIdentity.includes(secret), false);
  assert.equal(result.requestIdentity, 'www.manitoba511.ca/api/v2/get/event?format=json&lang=en&key=present');
  assert.equal(limiterTesting.pendingTokens('www.manitoba511.ca'), 1);
  assert.equal(limiterTesting.pendingTokens('511on.ca'), 0);
});

test('vendor511RequestIdentity records key presence, never the secret', () => {
  const secret = 'mb-test-key-not-a-real-secret';
  const identity = vendor511RequestIdentity({
    hostname: 'www.manitoba511.ca',
    resource: 'alerts',
    format: 'json',
    lang: 'en',
    hasKey: true,
  });
  assert.equal(identity, 'www.manitoba511.ca/api/v2/get/alerts?format=json&lang=en&key=present');
  assert.equal(identity.includes(secret), false);
  assert.equal(
    redactVendor511Secret(`https://www.manitoba511.ca/api/v2/get/event?format=json&key=${secret}`, secret),
    'https://www.manitoba511.ca/api/v2/get/event?format=json&key=REDACTED',
  );
});

test('fetchVendor511(MANITOBA_511) pulls events and alerts through the shared adapter', async () => {
  const urls = [];
  const fetchFn = async (url) => {
    urls.push(String(url));
    if (String(url).includes('/event')) return jsonResponse(MANITOBA_EVENTS_FIXTURE);
    return jsonResponse(MANITOBA_ALERTS_FIXTURE);
  };
  const envelope = await fetchVendor511(MANITOBA_511, {
    fetchFn,
    staggerMs: 0,
    key: 'mb-test-key-not-a-real-secret',
  });
  assert.equal(envelope.events.length, 1);
  assert.equal(envelope.alerts.length, 2);
  assert.equal(envelope.events[0].jurisdiction, 'MB');
  assert.equal(envelope.alerts[1].severity, 'Severe');
  assert.deepEqual(envelope.failedResources, []);
  assert.equal(isCompleteVendor511(envelope, MANITOBA_511), true);
  assert.ok(urls.every((url) => url.includes('lang=en')));
  assert.ok(urls.every((url) => url.includes('format=json')));
  assert.equal(limiterTesting.pendingTokens('www.manitoba511.ca'), 2);
});

test('Manitoba treats an HTTP 200 error object as a failed resource', async () => {
  const fetchFn = async (url) => {
    if (String(url).includes('/event')) {
      return jsonResponse({ error: 'invalid key', key: 'must-not-be-logged' });
    }
    return jsonResponse(MANITOBA_ALERTS_FIXTURE);
  };
  const envelope = await fetchVendor511(MANITOBA_511, {
    fetchFn,
    staggerMs: 0,
    key: 'mb-test-key-not-a-real-secret',
  });
  assert.equal(envelope.events.length, 0);
  assert.equal(envelope.alerts.length, 2);
  assert.deepEqual(envelope.failedResources, ['event']);
  assert.equal(isCompleteVendor511(envelope, MANITOBA_511), false);
});

test('Manitoba partial poll must not replace last-good or flip health green', async () => {
  const eventsDownAlertsEmpty = async (url) => {
    if (String(url).includes('/event')) return new Response('nope', { status: 503 });
    return jsonResponse([]);
  };
  const partialEmpty = await fetchVendor511(MANITOBA_511, {
    fetchFn: eventsDownAlertsEmpty,
    staggerMs: 0,
    key: 'mb-test-key-not-a-real-secret',
  });
  assert.deepEqual(partialEmpty.failedResources, ['event']);
  assert.equal(isCompleteVendor511(partialEmpty, MANITOBA_511), false);

  const alertsDownEventsOk = async (url) => {
    if (String(url).includes('/alerts')) return new Response('nope', { status: 502 });
    return jsonResponse(MANITOBA_EVENTS_FIXTURE);
  };
  const partialEvents = await fetchVendor511(MANITOBA_511, {
    fetchFn: alertsDownEventsOk,
    staggerMs: 0,
    key: 'mb-test-key-not-a-real-secret',
  });
  assert.equal(partialEvents.events.length, 1);
  assert.deepEqual(partialEvents.failedResources, ['alerts']);
  assert.equal(isCompleteVendor511(partialEvents, MANITOBA_511), false);

  const complete = await fetchVendor511(MANITOBA_511, {
    fetchFn: async () => jsonResponse([]),
    staggerMs: 0,
    key: 'mb-test-key-not-a-real-secret',
  });
  assert.deepEqual(complete.failedResources, []);
  assert.equal(isCompleteVendor511(complete, MANITOBA_511), true);
  assert.equal(complete.events.length, 0);
  assert.equal(complete.alerts.length, 0);

  const seeder = readFileSync(new URL('../scripts/seed-provincial-511.mjs', import.meta.url), 'utf8');
  assert.match(seeder, /isCompleteVendor511\(envelope, MANITOBA_511\)/);
  assert.match(seeder, /MANITOBA_511_KEY/);
  assert.match(seeder, /infra:manitoba-511:v1/);
  assert.match(seeder, /seed-meta:infra:manitoba-511/);
  assert.doesNotMatch(seeder, /sourceState: 'unavailable'/);
  assert.doesNotMatch(seeder, /skipReason: 'MANITOBA_511_KEY missing'/);
  assert.doesNotMatch(seeder, /writeManitobaNotConfiguredMeta/);
  assert.match(seeder, /loadEnvFile\(import\.meta\.url\)/);
  assert.doesNotMatch(seeder, /mb-test-key|REDACTED|sk-/);
  const fetchManitoba = seeder.slice(
    seeder.indexOf('async function fetchManitoba511'),
    seeder.indexOf('async function fetchProvincial511Tick'),
  );
  assert.match(fetchManitoba, /if \(!key\)/);
  assert.match(fetchManitoba, /notConfigured = true/);
  assert.match(fetchManitoba, /if \(!isCompleteVendor511\(envelope, MANITOBA_511\)\)/);
  assert.match(fetchManitoba, /new Error\(`Manitoba 511: partial poll/);

  const preserveManitoba = seeder.slice(
    seeder.indexOf('async function preserveManitoba'),
    seeder.indexOf('async function publishManitobaFromTick'),
  );
  assert.match(
    preserveManitoba,
    /extendExistingTtl\(\[MANITOBA_KEY, MANITOBA_META_KEY\], CACHE_TTL\)/,
  );
  assert.doesNotMatch(preserveManitoba, /writeSeedMeta/);

  const publishManitoba = seeder.slice(seeder.indexOf('async function publishManitobaFromTick'));
  const notConfiguredBranch = publishManitoba.slice(
    publishManitoba.indexOf('if (data?._manitobaNotConfigured)'),
    publishManitoba.indexOf('if (!data || data._manitobaFailed)'),
  );
  assert.match(notConfiguredBranch, /await preserveManitoba\(\)/);
  assert.doesNotMatch(notConfiguredBranch, /writeSeedMeta|publishManitobaEnvelope/);
  assert.ok(
    publishManitoba.indexOf('await preserveManitoba()')
    < publishManitoba.indexOf('await publishManitobaEnvelope'),
    'partial/failed/unconfigured ticks must preserve last-good before any envelope write',
  );
});

test('manitobaRoads publishes, so its cutover acknowledgement is gone and the probe wiring is what stays pinned', () => {
  // The #6622 ack was pruned on 2026-08-20: the live monitor reported
  // manitobaRoads:EMPTY as "no longer reported", and the entry had already
  // passed its own expiresAt. Asserting ABSENCE is what stops it being
  // reinstated — an acknowledgement that outlives its problem silently absorbs
  // the NEXT outage of the same probe.
  const baseline = JSON.parse(readFileSync(new URL('../scripts/seed-freshness-baseline.json', import.meta.url), 'utf8'));
  assert.equal(
    baseline.acknowledged.some((row) => row.name === 'manitobaRoads'),
    false,
    'manitobaRoads publishes; do not suppress a future recurrence',
  );

  // What the ack was pinning as a side effect, and the only reason its
  // probeKey was ever worth asserting: health must watch the exact seed-meta
  // key the seeder writes. runSeed derives `seed-meta:${domain}:${resource}`,
  // and the colon-vs-hyphen slip (#6623) points a probe at a key nothing ever
  // writes — which reads as a permanently EMPTY source, the very state the ack
  // was suppressing. Without this the removal takes the check with it.
  const seeder = readFileSync(new URL('../scripts/seed-provincial-511.mjs', import.meta.url), 'utf8');
  const health = readFileSync(new URL('../api/health.js', import.meta.url), 'utf8');
  assert.match(seeder, /MANITOBA_META_KEY = 'seed-meta:infra:manitoba-511'/);
  assert.match(seeder, /MANITOBA_KEY = 'infra:manitoba-511:v1'/);
  assert.match(health, /manitobaRoads:\s*\{\s*\n\s*key: 'seed-meta:infra:manitoba-511'/);
  assert.match(health, /manitobaRoads:\s+'infra:manitoba-511:v1'/);
});

test('seeder fixtures and adapter never embed a Manitoba credential', () => {
  const seeder = readFileSync(new URL('../scripts/seed-provincial-511.mjs', import.meta.url), 'utf8');
  assert.match(seeder, /process\.env\.MANITOBA_511_KEY/);
  assert.doesNotMatch(seeder, /key:\s*'[^']+'/);
  assert.doesNotMatch(ADAPTER_SOURCE, /MANITOBA_511_KEY\s*=\s*'[^']+'/);
  for (const fixture of [MANITOBA_EVENTS_FIXTURE, MANITOBA_ALERTS_FIXTURE]) {
    assert.equal(JSON.stringify(fixture).includes('key='), false);
  }
});

test('seeder module is not imported by this test file', () => {
  const src = import.meta.url;
  assert.match(src, /provincial-511\.test\.mjs$/);
  const self = readFileSync(new URL(import.meta.url), 'utf8');
  assert.equal(/from ['"][^'"]*seed-provincial-511/.test(self), false);
});

test('roadconditions without an ID get a synthesized stable id', () => {
  const record = normalize511Record({
    LocationDescription: 'From Highway 17 to Pukaskwa Park',
    Condition: ['No Report'],
    RoadwayName: '627',
    EncodedPolyline: ['yklkG|jqcNC?'],
  }, { kind: 'condition', jurisdiction: 'ON' });
  assert.ok(record.id);
  assert.match(record.id, /^ON:condition:627:/);
});

test('live-shaped Ontario mix keeps accidents inside the 400-record cap', () => {
  const events = [];
  for (let i = 0; i < 104; i++) {
    events.push(normalize511Record({
      ID: 200000 + i,
      Latitude: 43 + (i * 0.001),
      Longitude: -79.3,
      EventType: 'closures',
      IsFullClosure: true,
      Severity: 'Unknown',
    }, { kind: 'event', jurisdiction: 'ON' }));
  }
  for (let i = 0; i < 11; i++) {
    events.push(normalize511Record({
      ID: 300000 + i,
      Latitude: 44.1,
      Longitude: -80.2,
      EventType: 'accidentsAndIncidents',
      Severity: 'Unknown',
    }, { kind: 'event', jurisdiction: 'ON' }));
  }
  for (let i = 0; i < 499; i++) {
    events.push(normalize511Record({
      ID: 400000 + i,
      Latitude: 45.2,
      Longitude: -81.1,
      EventType: 'roadwork',
      Severity: 'Unknown',
    }, { kind: 'event', jurisdiction: 'ON' }));
  }
  assert.equal(events.length, 614);

  const conditions = [];
  for (let i = 0; i < 546; i++) {
    conditions.push(normalize511Record({
      LocationDescription: `Segment ${i}`,
      Condition: ['No Report'],
      RoadwayName: String(400 + (i % 200)),
      EncodedPolyline: ['yklkG|jqcNC?'],
    }, { kind: 'condition', jurisdiction: 'ON' }));
  }
  assert.equal(conditions.length, 546);
  assert.equal(conditions.every((r) => r.id && r.severity === 'Unknown'), true);

  const selected = select511Records([...events, ...conditions]);
  assert.equal(selected.length, MAX_RECORDS);
  assert.equal(selected.filter((r) => r.isFullClosure).length, 104);
  assert.equal(selected.filter((r) => /accident/i.test(r.eventType)).length, 11);
  assert.equal(selected.filter((r) => r.kind === 'condition').length, 0);
});
