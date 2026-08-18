import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  CHROME_UA,
  MAX_RECORDS,
  TORONTO_ROADS_HOST,
  TORONTO_ROADS_JURISDICTION,
  TORONTO_ROADS_SOURCE,
  TORONTO_ROADS_URL,
  centroidOfPath,
  declareTorontoRoadRecords,
  extractRestrictionsList,
  fetchTorontoRoadRestrictions,
  isAllowedTorontoHost,
  normalizeTorontoRoadList,
  normalizeTorontoRoadRecord,
  parseGeoPolyline,
  parseRestrictionsJson,
  selectTorontoRoadRecords,
  validateTorontoRoadEnvelope,
} from '../scripts/lib/toronto-road-restrictions.mjs';
import { CANADA_ROAD_SOURCES } from '../src/services/canada-roads-core.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_PATH = join(root, 'tests/fixtures/toronto-road-restrictions.json');
// Captured 2026-08-13 from TORONTO_ROADS_URL with CHROME_UA (Chrome/134).
const FIXTURE = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
const SEEDER_SOURCE = readFileSync(join(root, 'scripts/seed-toronto-road-restrictions.mjs'), 'utf8');
const RELAY_SOURCE = readFileSync(join(root, 'scripts/ais-relay.cjs'), 'utf8');
const LIB_SOURCE = readFileSync(join(root, 'scripts/lib/toronto-road-restrictions.mjs'), 'utf8');

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(payload, {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

test('fixture envelope is a Closure list with district and coordinates', () => {
  const items = extractRestrictionsList(FIXTURE);
  assert.ok(Array.isArray(items) && items.length >= 3);
  for (const item of items) {
    assert.equal(typeof item.district, 'string');
    assert.ok(item.district.length > 0, 'captured records must include district');
    assert.ok(Number.isFinite(Number(item.latitude)), 'captured records must include latitude');
    assert.ok(Number.isFinite(Number(item.longitude)), 'captured records must include longitude');
  }
  const types = new Set(items.map((item) => item.type));
  assert.ok(types.has('CONSTRUCTION'));
  assert.ok(types.has('ROAD_CLOSED'));
  assert.ok(types.has('HAZARD'));
});

test('normalise preserves district, lat/lon centroid, type, and currImpact', () => {
  const records = normalizeTorontoRoadList(FIXTURE);
  assert.equal(records.length, 3);
  const construction = records.find((r) => r.id === 'Tor-RD52026-4842');
  assert.equal(construction.district, 'NORTH YORK');
  assert.equal(construction.type, 'CONSTRUCTION');
  assert.equal(construction.eventType, 'CONSTRUCTION');
  assert.equal(construction.currImpact, 'Low');
  assert.equal(construction.lat, 43.731550);
  assert.equal(construction.lon, -79.424030);
  assert.deepEqual(construction.centroid, [-79.424030, 43.731550]);
  assert.ok(Array.isArray(construction.path) && construction.path.length > 1);
  assert.equal(construction.source, TORONTO_ROADS_SOURCE);
  assert.equal(construction.jurisdiction, TORONTO_ROADS_JURISDICTION);
  assert.equal(construction.createdTime, 1786652617000);
});

test('ROAD_CLOSED records are full closures; HAZARD keeps High currImpact', () => {
  const records = normalizeTorontoRoadList(FIXTURE);
  const closed = records.find((r) => r.type === 'ROAD_CLOSED');
  assert.equal(closed.district, 'SCARBOROUGH');
  assert.equal(closed.isFullClosure, true);
  assert.equal(closed.severity, 'Extreme');
  assert.ok(closed.centroid);
  const hazard = records.find((r) => r.type === 'HAZARD');
  assert.equal(hazard.district, 'NORTH YORK');
  assert.equal(hazard.currImpact, 'High');
  assert.equal(hazard.severity, 'Extreme');
  assert.equal(hazard.isFullClosure, false);
  assert.equal(hazard.path, null, 'single-point geoPolyline is a dot, not a path');
});

test('missing lat/lon falls back to a geoPolyline centroid', () => {
  const item = { ...FIXTURE.Closure[0] };
  delete item.latitude;
  delete item.longitude;
  const decoded = parseGeoPolyline(item.geoPolyline);
  assert.ok(decoded.length > 1);
  const expected = centroidOfPath(decoded);
  const record = normalizeTorontoRoadRecord(item);
  assert.equal(record.lat, null);
  assert.equal(record.lon, null);
  assert.ok(record.centroid);
  assert.equal(record.centroid[0].toFixed(5), expected[0].toFixed(5));
  assert.equal(record.centroid[1].toFixed(5), expected[1].toFixed(5));
  assert.ok(record.centroid[1] > 43 && record.centroid[1] < 44);
  assert.ok(record.centroid[0] < -79 && record.centroid[0] > -80);
});

test('empty Closure list is valid zero-record success', () => {
  const records = normalizeTorontoRoadList({ Closure: [] });
  assert.deepEqual(records, []);
  assert.equal(declareTorontoRoadRecords({ records: [] }), 0);
  assert.equal(validateTorontoRoadEnvelope({ records: [] }), true);
});

test('non-list 200 bodies are rejected as degraded', () => {
  assert.throws(() => parseRestrictionsJson('<html>not json</html>'), /parseable restrictions list/);
  assert.throws(() => normalizeTorontoRoadList({ ok: true }), /parseable restrictions list/);
  assert.throws(() => normalizeTorontoRoadList(null), /parseable restrictions list/);
  assert.throws(() => parseRestrictionsJson(''), /parseable restrictions list/);
});

test('invalid JSON escapes in CART descriptions still parse', () => {
  const body = '{"Closure":[{"id":"x","district":"TORONTO","latitude":"43.65","longitude":"-79.38","type":"CONSTRUCTION","currImpact":"Low","description":"Water \\ Serwer"}]}';
  const parsed = parseRestrictionsJson(body);
  const records = normalizeTorontoRoadList(parsed);
  assert.equal(records.length, 1);
  assert.equal(records[0].district, 'TORONTO');
  assert.equal(records[0].lat, 43.65);
});

test('host allowlist is secure.toronto.ca only', () => {
  assert.equal(isAllowedTorontoHost(TORONTO_ROADS_URL), true);
  assert.equal(isAllowedTorontoHost('https://511on.ca/api/v2/get/event'), false);
  assert.equal(isAllowedTorontoHost('https://open.toronto.ca/dataset/road-restrictions/'), false);
});

test('selectTorontoRoadRecords prefers closures and hazards so the record cap cannot drop them', () => {
  const records = [];
  for (let i = 0; i < MAX_RECORDS + 20; i++) {
    records.push(normalizeTorontoRoadRecord({
      id: `n-${i}`,
      district: 'TORONTO',
      latitude: '43.65',
      longitude: '-79.38',
      type: 'CONSTRUCTION',
      currImpact: 'None',
    }));
  }
  records.push(normalizeTorontoRoadRecord({
    id: 'closed-1',
    district: 'TORONTO',
    latitude: '43.65',
    longitude: '-79.38',
    type: 'ROAD_CLOSED',
    currImpact: 'High',
  }));
  records.push(normalizeTorontoRoadRecord({
    id: 'hazard-1',
    district: 'NORTH YORK',
    latitude: '43.73',
    longitude: '-79.42',
    type: 'HAZARD',
    currImpact: 'High',
  }));
  const selected = selectTorontoRoadRecords(records);
  assert.equal(selected.length, MAX_RECORDS);
  assert.equal(selected[0].id, 'closed-1');
  assert.ok(selected.some((r) => r.id === 'hazard-1'));
  assert.equal(selected.filter((r) => r.type === 'CONSTRUCTION').length, MAX_RECORDS - 2);
});

test('fetchTorontoRoadRestrictions records truncated:true when the record cap fires', async () => {
  const closure = [];
  for (let i = 0; i < MAX_RECORDS + 5; i++) {
    closure.push({
      id: `n-${i}`,
      district: 'TORONTO',
      latitude: '43.65',
      longitude: '-79.38',
      type: i === 0 ? 'ROAD_CLOSED' : 'CONSTRUCTION',
      currImpact: i === 0 ? 'High' : 'None',
    });
  }
  const result = await fetchTorontoRoadRestrictions({
    fetchFn: async () => jsonResponse({ Closure: closure }),
  });
  assert.equal(result.records.length, MAX_RECORDS);
  assert.equal(result.truncated, true);
  assert.equal(result.records[0].id, 'n-0');
  assert.equal(result.records[0].type, 'ROAD_CLOSED');
});

test('live-shaped CART with more than 400 ROAD_CLOSED keeps leftover closures and High construction', () => {
  const closedNone = 312;
  const closedOther = 136;
  const highConstruction = 145;
  const otherConstruction = 1786;
  const records = [];
  for (let i = 0; i < closedNone; i++) {
    records.push(normalizeTorontoRoadRecord({
      id: `closed-none-${i}`,
      district: 'TORONTO',
      latitude: '43.65',
      longitude: '-79.38',
      type: 'ROAD_CLOSED',
      currImpact: 'None',
    }));
  }
  for (let i = 0; i < closedOther; i++) {
    records.push(normalizeTorontoRoadRecord({
      id: `closed-high-${i}`,
      district: 'SCARBOROUGH',
      latitude: '43.76',
      longitude: '-79.23',
      type: 'ROAD_CLOSED',
      currImpact: 'High',
    }));
  }
  for (let i = 0; i < highConstruction; i++) {
    records.push(normalizeTorontoRoadRecord({
      id: `const-high-${i}`,
      district: 'NORTH YORK',
      latitude: '43.73',
      longitude: '-79.42',
      type: 'CONSTRUCTION',
      currImpact: 'High',
    }));
  }
  for (let i = 0; i < otherConstruction; i++) {
    records.push(normalizeTorontoRoadRecord({
      id: `const-low-${i}`,
      district: 'ETOBICOKE YORK',
      latitude: '43.69',
      longitude: '-79.54',
      type: 'CONSTRUCTION',
      currImpact: 'Low',
    }));
  }
  const closedCount = closedNone + closedOther;
  const constructionCount = highConstruction + otherConstruction;
  assert.ok(closedCount > 400, 'live CART has more ROAD_CLOSED than the old 400 cap');
  assert.equal(records.length, 2379);
  const selected = selectTorontoRoadRecords(records);
  assert.equal(selected.filter((r) => r.type === 'ROAD_CLOSED').length, closedCount);
  assert.equal(selected.filter((r) => r.type === 'CONSTRUCTION' && String(r.currImpact).toLowerCase() === 'high').length, highConstruction);
  assert.equal(selected.filter((r) => r.type === 'CONSTRUCTION').length, constructionCount);
  assert.equal(selected.length, records.length);
  assert.ok(selected.length > 400);
});

test('fetchTorontoRoadRestrictions omits truncated when the list fits', async () => {
  const result = await fetchTorontoRoadRestrictions({
    fetchFn: async () => jsonResponse(FIXTURE),
  });
  assert.equal(result.records.length, 3);
  assert.equal(result.truncated, undefined);
});

test('fetchTorontoRoadRestrictions uses CHROME_UA and the CART v3 URL', async () => {
  const urls = [];
  const fetchFn = async (url, init) => {
    urls.push({ url: String(url), init });
    return jsonResponse(FIXTURE);
  };
  const result = await fetchTorontoRoadRestrictions({ fetchFn, userAgent: CHROME_UA });
  assert.equal(result.records.length, 3);
  assert.equal(result.records[0].district, 'NORTH YORK');
  assert.ok(result.records[0].centroid);
  assert.equal(urls[0].url, TORONTO_ROADS_URL);
  assert.equal(urls[0].init.redirect, 'error');
  assert.match(urls[0].init.headers['User-Agent'], /Chrome\/134/);
  assert.equal(typeof urls[0].init.fetch, 'undefined');
});

test('fetchTorontoRoadRestrictions rejects a foreign host and a non-list 200', async () => {
  await assert.rejects(
    () => fetchTorontoRoadRestrictions({
      url: 'https://example.com/restrictions',
      fetchFn: async () => jsonResponse(FIXTURE),
    }),
    /allowlist/,
  );
  await assert.rejects(
    () => fetchTorontoRoadRestrictions({
      fetchFn: async () => jsonResponse({ status: 'ok' }),
    }),
    /parseable restrictions list/,
  );
});

test('Toronto roads stay isolated from the relay and the 511 rate limiter', () => {
  // Isolation policy: absence of a reference is the contract, and no
  // executable test can observe it. Toronto ships as a standalone nixpacks job
  // so a relay incident cannot take it down, and its fetch must not inherit the
  // shared 511 limiter — that coupling is what stalled this feed before.
  // The seeder's own config values (zeroIsValid, the key names) used to be
  // echoed here too; those restated the object literal inside the seeder.
  assert.doesNotMatch(SEEDER_SOURCE, /from ['"].*provincial-511|acquire511Slot|fetch\.bind/);
  assert.doesNotMatch(LIB_SOURCE, /_511-rate-limit|from ['"].*provincial-511|511on\.ca/);
  assert.doesNotMatch(RELAY_SOURCE, /toronto\.ca|toronto-roads|secure\.toronto\.ca/);

  // And it reaches only its own upstream host.
  assert.match(LIB_SOURCE, new RegExp(TORONTO_ROADS_HOST.replace(/\./g, '\\.')));
});

test("this test file does not import the seeder module", () => {
  const self = readFileSync(new URL(import.meta.url), "utf8");
  assert.equal(/from ['"][^'"]*seed-toronto-road-restrictions/.test(self), false);
});

test("toronto restrictions share canadaRoads and do not invent a second MapLayers key", () => {
  const types = readFileSync(join(root, "src/types/index.ts"), "utf8");
  const layers = readFileSync(join(root, "src/config/map-layer-definitions.ts"), "utf8");
  const client = readFileSync(join(root, "src/services/canada-roads.ts"), "utf8");
  assert.match(types, /canadaRoads: boolean/);
  assert.doesNotMatch(types, /torontoRoads\?: boolean/);
  assert.match(layers, /canadaRoads:\s+def\('canadaRoads'/);
  assert.doesNotMatch(layers, /torontoRoads:\s+def\(/);
  assert.match(client, /unionCanadaRoadRecords/);

  // Read the real descriptors instead of grepping canada-roads.ts for their
  // literals: #6763 moved the list into canada-roads-core.ts so tests could
  // import it, and derived both loader maps from it — so the per-key strings
  // this used to match no longer exist anywhere in the client.
  assert.deepEqual(
    CANADA_ROAD_SOURCES.map(({ key, source }) => `${key}:${source}`),
    [
      'canadaRoads:ontario-511',
      'albertaRoads:alberta-511',
      'manitobaRoads:manitoba-511',
      'torontoRoads:toronto-roads',
      'bcOpen511:bc-open511',
    ],
    'Toronto is one source of the shared canadaRoads layer, not its own layer key',
  );
  // Derived, so a source cannot be added without a loader and read as
  // permanently unavailable.
  assert.match(client, /HYDRATED_LOADERS[\s\S]{0,200}CANADA_ROAD_SOURCES\.map/);
  assert.match(client, /ON_DEMAND_LOADERS[\s\S]{0,200}CANADA_ROAD_SOURCES\.map/);
});

test("toronto roads runs as a bundle member, not its own */15 service", () => {
  // A 3.62MB construction-permit feed does not earn a dedicated Railway slot,
  // and */15 on that payload cost 348 MB/day. seed-bundle-canada (#6711) owns
  // this seeder gated on intervalMs 2h — ~44 MB/day for data that changes on a
  // permit desk's schedule.
  const registry = JSON.parse(readFileSync(join(root, "scripts/railway-services.json"), "utf8"));
  assert.equal(
    registry.some((s) => s.service === "seed-toronto-road-restrictions"),
    false,
    "a standalone row would claim a slot the bundle already covers",
  );
});

test("bootstrap fetches every Canada road feed on demand, including Toronto", () => {
  // Was: "keeps Ontario and Alberta fast but fetches Toronto roads on demand".
  // That split was the #6763 bug. A tier is not layer-gated, so keeping the two
  // 511 feeds fast shipped 507,639 B to every visitor on every variant while
  // this file's own subject — the 2 MB Toronto snapshot — was correctly held
  // back. All four are on-demand now.
  //
  // The layer-level invariant (an on-demand-backed layer must not ship enabled)
  // lives in tests/canada-roads-startup-cost.test.mts; this only pins Toronto's
  // neighbourhood of it.
  const src = readFileSync(join(root, "shared/bootstrap-tier-keys.js"), "utf8");
  assert.match(src, /canadaRoads: 'infra:ontario-511:v1'/);
  assert.match(src, /torontoRoads: 'infra:toronto-roads:v1'/);
  const fast = src.slice(src.indexOf("const FAST_KEY_NAMES"), src.indexOf("const ON_DEMAND_KEY_NAMES"));
  const onDemand = src.slice(src.indexOf("const ON_DEMAND_KEY_NAMES"));
  for (const key of ["canadaRoads", "albertaRoads", "manitobaRoads", "torontoRoads", "bcOpen511"]) {
    assert.doesNotMatch(fast, new RegExp(`'${key}'`), `${key} must not ride the fast tier`);
    assert.match(onDemand, new RegExp(`'${key}'`), `${key} must be on-demand`);
  }
});

test("Toronto roads is live, so it carries no freshness acknowledgement", () => {
  // Was: pinned the expiring-ack window for a probe that had never published.
  // The bundle is provisioned and torontoRoads reads healthy, so the ack was
  // removed as SATISFIED rather than re-anchored. Asserting its absence keeps
  // it from being reinstated — a suppression outliving its problem would
  // silently absorb a future Toronto outage.
  const baseline = JSON.parse(readFileSync(join(root, "scripts/seed-freshness-baseline.json"), "utf8"));
  const row = baseline.acknowledged.find((a) => a.issue === 6609 || a.name === "torontoRoads");
  assert.equal(row, undefined, "torontoRoads publishes now; it must not be acknowledged as known-empty");

  // The staleness budget must still cover the 2h bundle cadence. This is the
  // pairing that broke once already: the interval moved to 2h while the probe
  // kept a 45min budget, so a healthy publisher read STALE_SEED permanently.
  const health = readFileSync(join(root, "api/health.js"), "utf8");
  const probe = /torontoRoads:\s*\{[\s\S]{0,200}?maxStaleMin:\s*(\d+)/.exec(health);
  assert.ok(probe, "torontoRoads must still have a health probe");
  assert.ok(
    Number(probe[1]) * 60_000 >= 2 * 60 * 60 * 1000,
    `maxStaleMin ${probe[1]}min must cover the 2h seed-bundle-canada interval`,
  );
});
