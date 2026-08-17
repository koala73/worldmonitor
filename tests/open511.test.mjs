import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { __testing__ as limiterTesting } from '../scripts/_511-rate-limit.mjs';
import {
  BC_OPEN511,
  MAX_RECORDS,
  OPEN511_HOSTS,
  centroidOfPath,
  fetchEvents,
  geometryFromOpen511,
  isOpen511Host,
  normalizeOpen511Event,
  normalizeOpen511List,
  open511Adapter,
  selectOpen511Records,
} from '../scripts/lib/open511.mjs';

const PAGE = JSON.parse(readFileSync(new URL('./fixtures/open511-bc-active-page.json', import.meta.url), 'utf8'));
const PAGE1 = JSON.parse(readFileSync(new URL('./fixtures/open511-bc-page-1.json', import.meta.url), 'utf8'));
const PAGE2 = JSON.parse(readFileSync(new URL('./fixtures/open511-bc-page-2.json', import.meta.url), 'utf8'));
const ADAPTER_SOURCE = readFileSync(new URL('../scripts/lib/open511.mjs', import.meta.url), 'utf8');
const SEEDER_SOURCE = readFileSync(new URL('../scripts/seed-open511.mjs', import.meta.url), 'utf8');
const RELAY_SOURCE = readFileSync(new URL('../scripts/ais-relay.cjs', import.meta.url), 'utf8');
const TEST_SOURCE = readFileSync(new URL(import.meta.url), 'utf8');

test.afterEach(() => {
  limiterTesting.reset();
});

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

test('seeder module is not imported by this test file', () => {
  assert.equal(/from ['"][^'"]*seed-open511/.test(TEST_SOURCE), false);
  assert.equal(TEST_SOURCE.includes('seed-open511.mjs'), true, 'fixture: this file must still mention the seeder as text');
});

test('adapter is Open511 /events?status=ACTIVE, not vendor /api/v2/get', () => {
  assert.match(ADAPTER_SOURCE, /events\?status=ACTIVE|searchParams\.set\('status'/);
  assert.doesNotMatch(ADAPTER_SOURCE, /\/api\/v2\/get/);
  assert.doesNotMatch(ADAPTER_SOURCE, /from ['"].*provincial-511/);
  assert.equal(isOpen511Host('api.open511.gov.bc.ca'), true);
  assert.equal(isOpen511Host('511on.ca'), false);
  assert.equal(OPEN511_HOSTS['api.open511.gov.bc.ca'].jurisdiction, 'BC');
  assert.equal(BC_OPEN511.source, 'bc-open511');
});

test('captured page fixture preserves coordinates as [lon, lat]', () => {
  const records = normalizeOpen511List(PAGE, { jurisdiction: 'BC', source: 'bc-open511' });
  assert.equal(records.length, 2);
  const point = records.find((r) => r.id === 'drivebc.ca/DBC-47311');
  const line = records.find((r) => r.id === 'drivebc.ca/RIDE-100556');
  assert.ok(point);
  assert.equal(point.lat, 52.972914);
  assert.equal(point.lon, -122.489194);
  assert.deepEqual(point.centroid, [-122.489194, 52.972914]);
  assert.equal(point.jurisdiction, 'BC');
  assert.equal(point.source, 'bc-open511');
  assert.ok(line);
  assert.ok(line.path && line.path.length > 1);
  assert.ok(line.centroid);
  assert.equal(line.centroid[0].toFixed(3), centroidOfPath(line.path)[0].toFixed(3));
  assert.ok(line.lat > 48 && line.lat < 50);
  assert.ok(line.lon < -123 && line.lon > -124);
});

test('LineString geography downsamples to a path; Point has no path', () => {
  const point = geometryFromOpen511({ type: 'Point', coordinates: [-123.1, 49.2] });
  assert.deepEqual(point.centroid, [-123.1, 49.2]);
  assert.equal(point.path, null);
  const line = geometryFromOpen511({
    type: 'LineString',
    coordinates: [[-123.4, 48.4], [-123.5, 48.5], [-123.6, 48.6]],
  });
  assert.equal(line.path.length, 3);
  assert.ok(line.centroid);
});

test('closed road state maps to Extreme full-closure', () => {
  const record = normalizeOpen511Event({
    id: 'drivebc.ca/DBC-1',
    headline: 'INCIDENT',
    severity: 'MAJOR',
    event_type: 'INCIDENT',
    geography: { type: 'Point', coordinates: [-123, 49] },
    roads: [{ name: 'Highway 1', state: 'CLOSED' }],
  }, { jurisdiction: 'BC', source: 'bc-open511' });
  assert.equal(record.isFullClosure, true);
  assert.equal(record.severity, 'Extreme');
  assert.equal(record.roadwayName, 'Highway 1');
});

test('fetchEvents hits Open511 events?status=ACTIVE&limit=500 and acquires the BC host slot', async () => {
  const urls = [];
  const fetchFn = async (url, init) => {
    urls.push({ url: String(url), init });
    return jsonResponse(PAGE);
  };
  const result = await fetchEvents('https://api.open511.gov.bc.ca', { fetchFn });
  assert.equal(result.records.length, 2);
  assert.match(urls[0].url, /^https:\/\/api\.open511\.gov\.bc\.ca\/events\?status=ACTIVE&limit=500$/);
  assert.doesNotMatch(urls[0].url, /\/api\/v2\/get/);
  assert.equal(urls[0].init.redirect, 'error');
  assert.equal(urls[0].init.headers.Accept, 'application/json');
  assert.equal(typeof urls[0].init.fetch, 'undefined');
  assert.equal(limiterTesting.pendingTokens('api.open511.gov.bc.ca'), 1);
  assert.equal(limiterTesting.pendingTokens('511on.ca'), 0);
});

test('two-page pagination follows next_url and rate-limits each page', async () => {
  const urls = [];
  const fetchFn = async (url) => {
    urls.push(String(url));
    if (String(url).includes('offset=500')) return jsonResponse(PAGE2);
    return jsonResponse(PAGE1);
  };
  const adapter = open511Adapter('https://api.open511.gov.bc.ca', { fetchFn });
  const result = await adapter.fetchEvents({ status: 'ACTIVE', limit: 500 });
  assert.equal(result.records.length, 2);
  assert.equal(result.pages, 2);
  assert.match(urls[0], /\/events\?status=ACTIVE&limit=500$/);
  assert.match(urls[1], /offset=500/);
  assert.equal(limiterTesting.pendingTokens('api.open511.gov.bc.ca'), 1);
  assert.equal(result.records[0].source, 'bc-open511');
  assert.equal(result.records[1].jurisdiction, 'BC');
});

test('every Open511 page acquires its own limiter slot', async () => {
  const slots = [];
  const fetchFn = async (url) => String(url).includes('offset=500')
    ? jsonResponse(PAGE2)
    : jsonResponse(PAGE1);
  const result = await fetchEvents('https://api.open511.gov.bc.ca', {
    fetchFn,
    acquireSlot: async (host) => { slots.push(host); },
  });
  assert.equal(result.pages, 2);
  assert.deepEqual(slots, ['api.open511.gov.bc.ca', 'api.open511.gov.bc.ca']);
});

test('non-advancing pagination fails closed', async () => {
  const same = 'https://api.open511.gov.bc.ca/events?status=ACTIVE&limit=1';
  const fetchFn = async () => jsonResponse({
    events: [PAGE.events[0]],
    pagination: { next_url: same },
  });
  await assert.rejects(
    fetchEvents('https://api.open511.gov.bc.ca', {
      fetchFn,
      limit: 1,
      acquireSlot: async () => {},
    }),
    /pagination did not advance/,
  );
});

test('offset pagination continues until an empty page when next_url is absent', async () => {
  const urls = [];
  const fetchFn = async (url) => {
    urls.push(String(url));
    const parsed = new URL(url);
    if (parsed.searchParams.get('offset') === '1') {
      return jsonResponse({ events: [], pagination: { offset: '1' } });
    }
    return jsonResponse({
      events: [{
        id: 'drivebc.ca/DBC-page1',
        headline: 'CONSTRUCTION',
        severity: 'MINOR',
        event_type: 'CONSTRUCTION',
        geography: { type: 'Point', coordinates: [-123.1, 49.2] },
      }],
      pagination: { offset: '0' },
    });
  };
  const result = await fetchEvents('https://api.open511.gov.bc.ca', { fetchFn, limit: 1 });
  assert.equal(result.records.length, 1);
  assert.equal(result.pages, 2);
  assert.match(urls[1], /offset=1/);
});

test('a successful response without an events array fails closed', async () => {
  await assert.rejects(
    fetchEvents('https://api.open511.gov.bc.ca', {
      fetchFn: async () => jsonResponse({ unexpected: true }),
      acquireSlot: async () => {},
    }),
    /missing an events array/,
  );
});

test('pagination metadata continues a short page when more records are declared', async () => {
  const urls = [];
  const fetchFn = async (url) => {
    urls.push(String(url));
    if (new URL(url).searchParams.get('offset') === '1') {
      return jsonResponse({ events: [], pagination: { offset: 1, total: 1 } });
    }
    return jsonResponse({
      events: [PAGE.events[0]],
      pagination: { offset: 0, total: 2 },
    });
  };
  const result = await fetchEvents('https://api.open511.gov.bc.ca', {
    fetchFn,
    limit: 500,
    acquireSlot: async () => {},
  });
  assert.equal(result.pages, 2);
  assert.equal(result.records.length, 1);
  assert.equal(urls.length, 2);
  assert.match(urls[1], /offset=1/);
});

test('an empty page that claims more records fails closed', async () => {
  await assert.rejects(
    fetchEvents('https://api.open511.gov.bc.ca', {
      fetchFn: async () => jsonResponse({
        events: [],
        pagination: { offset: 1, total: 2 },
      }),
      acquireSlot: async () => {},
    }),
    /claims more results after an empty page/,
  );
});

test('malformed pagination fields fail closed instead of looking terminal', async () => {
  for (const pagination of [
    { offset: 0, next_url: { bad: true } },
    { offset: 'not-a-number' },
    { offset: 0, total: -1 },
    { offset: 0, has_more: 'yes' },
  ]) {
    await assert.rejects(
      fetchEvents('https://api.open511.gov.bc.ca', {
        fetchFn: async () => jsonResponse({ events: [PAGE.events[0]], pagination }),
        acquireSlot: async () => {},
      }),
      /pagination/,
    );
  }
});

test('vendor 511 host is rejected and does not use this Open511 client', async () => {
  let called = false;
  const fetchFn = async () => {
    called = true;
    return jsonResponse({ events: [] });
  };
  await assert.rejects(
    () => fetchEvents('https://511on.ca', { fetchFn }),
    /not on the Open511 allowlist/,
  );
  assert.equal(called, false);
  assert.equal(limiterTesting.pendingTokens('511on.ca'), 0);
});

test('responses larger than 5MB are rejected', async () => {
  const fetchFn = async () => jsonResponse({ events: [] }, {
    headers: { 'content-length': String(5 * 1024 * 1024 + 1) },
  });
  await assert.rejects(
    () => fetchEvents('https://api.open511.gov.bc.ca', { fetchFn }),
    /exceeds 5242880 bytes/,
  );
});

test('empty event lists are valid', () => {
  assert.deepEqual(normalizeOpen511List({ events: [] }, { jurisdiction: 'BC' }), []);
});

test('seeder is a standalone nixpacks job and does not loop ais-relay', () => {
  assert.match(SEEDER_SOURCE, /open511Adapter\(BC_OPEN511\.baseUrl/);
  assert.match(SEEDER_SOURCE, /zeroIsValid:\s*true/);
  assert.match(SEEDER_SOURCE, /infra:bc-open511:v1/);
  assert.match(SEEDER_SOURCE, /status: 'ACTIVE'/);
  assert.doesNotMatch(SEEDER_SOURCE, /\/api\/v2\/get/);
  assert.doesNotMatch(SEEDER_SOURCE, /provincial-511/);
  assert.doesNotMatch(RELAY_SOURCE, /open511\.gov\.bc/);
  assert.doesNotMatch(RELAY_SOURCE, /bc-open511/);
  assert.doesNotMatch(RELAY_SOURCE, /canadaRoads/);
});

test('CHROME_UA, timeout, redirect error, and no fetch.bind', async () => {
  const urls = [];
  const fetchFn = async (url, init) => {
    urls.push({ url: String(url), init });
    return jsonResponse({ events: [] });
  };
  await fetchEvents('https://api.open511.gov.bc.ca', { fetchFn });
  assert.match(urls[0].init.headers['User-Agent'], /Chrome\/134/);
  assert.equal(urls[0].init.redirect, 'error');
  assert.ok(urls[0].init.signal, 'AbortSignal.timeout must be set');
  assert.doesNotMatch(ADAPTER_SOURCE, /fetch\.bind/);
  assert.doesNotMatch(SEEDER_SOURCE, /fetch\.bind/);
  assert.match(ADAPTER_SOURCE, /AbortSignal\.timeout/);
  assert.match(ADAPTER_SOURCE, /redirect: 'error'/);
});

test('pagination fails closed when max pages is exhausted before completion', async () => {
  let calls = 0;
  const fetchFn = async (url) => {
    calls += 1;
    const offset = Number(new URL(url).searchParams.get('offset') || 0);
    return jsonResponse({
      events: [{
        id: `drivebc.ca/DBC-${offset}`,
        headline: 'CONSTRUCTION',
        severity: 'MINOR',
        event_type: 'CONSTRUCTION',
        geography: { type: 'Point', coordinates: [-123.1, 49.2] },
      }],
      pagination: {
        offset,
        next_url: `https://api.open511.gov.bc.ca/events?status=ACTIVE&limit=1&offset=${offset + 1}`,
      },
    });
  };
  await assert.rejects(
    fetchEvents('https://api.open511.gov.bc.ca', { fetchFn, limit: 1, maxPages: 20, acquireSlot: async () => {} }),
    /maxPages=20.*before pagination completed/,
  );
  assert.equal(calls, 20);
});

test('BC Open511 shares canadaRoads and does not invent a second MapLayers key', () => {
  const types = readFileSync(new URL('../src/types/index.ts', import.meta.url), 'utf8');
  const layers = readFileSync(new URL('../src/config/map-layer-definitions.ts', import.meta.url), 'utf8');
  const client = readFileSync(new URL('../src/services/canada-roads.ts', import.meta.url), 'utf8');
  // The descriptors moved to canada-roads-core.ts in #6763 so tests could import
  // the real list rather than clone it, and both loader maps are now derived
  // from that list — so the per-key literals this used to grep for are gone.
  const core = readFileSync(new URL('../src/services/canada-roads-core.ts', import.meta.url), 'utf8');
  assert.match(types, /canadaRoads: boolean/);
  assert.doesNotMatch(types, /bcOpen511\?: boolean/);
  assert.match(layers, /canadaRoads:\s+def\('canadaRoads'/);
  assert.doesNotMatch(layers, /bcOpen511:\s+def\(/);
  assert.match(client, /unionCanadaRoadRecords/);
  assert.match(client, /HYDRATED_LOADERS[\s\S]{0,200}CANADA_ROAD_SOURCES\.map/);
  assert.match(core, /ontario-511/);
  assert.match(core, /bc-open511/);
  assert.match(core, /key: 'bcOpen511', source: 'bc-open511'/);
});

test('bc open511 runs as a bundle member, not its own */15 service', () => {
  // seed-bundle-canada (#6711) owns this seeder gated on intervalMs 30min.
  // DriveBC returned the full active set in a single page, so a tick is one
  // request, not MAX_PAGES — halving 84 MB/day costs nothing in coverage.
  const registry = JSON.parse(readFileSync(new URL('../scripts/railway-services.json', import.meta.url), 'utf8'));
  assert.equal(
    registry.some((s) => s.service === 'seed-open511'),
    false,
    'a standalone row would claim a slot the bundle already covers',
  );
});

test('bootstrap fetches bcOpen511 and its Ontario sibling on demand, never on a tier', () => {
  // Was: 'keeps canadaRoads on the fast tier; bcOpen511 is on-demand (~797 KB)'.
  // Holding BC back while Ontario rode FAST was the #6763 bug — a tier is not
  // layer-gated, so the sibling this file was protecting the payload from
  // shipped 306,757 B to every visitor anyway.
  const src = readFileSync(new URL('../shared/bootstrap-tier-keys.js', import.meta.url), 'utf8');
  assert.match(src, /canadaRoads: 'infra:ontario-511:v1'/);
  assert.match(src, /bcOpen511: 'infra:bc-open511:v1'/);
  const fast = src.slice(src.indexOf('const FAST_KEY_NAMES'), src.indexOf('const ON_DEMAND_KEY_NAMES'));
  const onDemand = src.slice(src.indexOf('const ON_DEMAND_KEY_NAMES'));
  for (const key of ['canadaRoads', 'bcOpen511']) {
    assert.doesNotMatch(fast, new RegExp(`'${key}'`), `${key} must not ride the fast tier`);
    assert.match(onDemand, new RegExp(`'${key}'`), `${key} must be on-demand`);
  }
});

test('BC Open511 is live, so it carries no freshness acknowledgement', () => {
  // Was: pinned the expiring-ack dates for a probe that had never published.
  // seed-bundle-canada is provisioned and bcOpen511 now reads healthy, so the
  // ack was removed as SATISFIED. Asserting its absence is what stops it being
  // reinstated: an acknowledgement that outlives its problem is a suppression
  // with nothing to suppress, and would silently absorb a FUTURE BC outage.
  const baseline = JSON.parse(readFileSync(new URL('../scripts/seed-freshness-baseline.json', import.meta.url), 'utf8'));
  const row = baseline.acknowledged.find((a) => a.issue === 6611 || a.name === 'bcOpen511');
  assert.equal(row, undefined, 'bcOpen511 publishes now; it must not be acknowledged as a known-empty probe');

  // The probe itself must still exist, or "no ack" would be trivially true
  // because nothing is watching the key at all.
  const health = readFileSync(new URL('../api/health.js', import.meta.url), 'utf8');
  assert.match(health, /bcOpen511:\s*\{[\s\S]{0,120}?key:\s*'seed-meta:infra:bc-open511'/);
});

test('following next_url without status=ACTIVE still requests ACTIVE pages', async () => {
  const urls = [];
  const fetchFn = async (url) => {
    urls.push(String(url));
    if (String(url).includes('offset=1')) {
      return jsonResponse({ events: [], pagination: { offset: '1' } });
    }
    return jsonResponse({
      events: [{
        id: 'drivebc.ca/DBC-page1',
        headline: 'INCIDENT',
        severity: 'MAJOR',
        event_type: 'INCIDENT',
        geography: { type: 'Point', coordinates: [-123.1, 49.2] },
      }],
      pagination: {
        offset: '0',
        next_url: 'https://api.open511.gov.bc.ca/events?limit=1&offset=1',
      },
    });
  };
  const result = await fetchEvents('https://api.open511.gov.bc.ca', { fetchFn, limit: 1 });
  assert.equal(result.pages, 2);
  assert.match(urls[0], /status=ACTIVE/);
  assert.match(urls[1], /status=ACTIVE/);
  assert.match(urls[1], /offset=1/);
});

test('hitting maxPages rejects instead of publishing a partial success', async () => {
  const fetchFn = async (url) => {
    const offset = Number(new URL(url).searchParams.get('offset') || 0);
    return jsonResponse({
      events: [{
        id: `drivebc.ca/DBC-${offset}`,
        headline: 'CONSTRUCTION',
        severity: 'MINOR',
        event_type: 'CONSTRUCTION',
        geography: { type: 'Point', coordinates: [-123.1, 49.2] },
      }],
      pagination: {
        offset,
        next_url: `https://api.open511.gov.bc.ca/events?limit=1&offset=${offset + 1}`,
      },
    });
  };
  await assert.rejects(
    fetchEvents('https://api.open511.gov.bc.ca', {
      fetchFn, limit: 1, maxPages: 3, acquireSlot: async () => {},
    }),
    /maxPages=3.*before pagination completed/,
  );
});

test('400-record cap keeps closures and accidents above construction filler', () => {
  const records = [];
  for (let i = 0; i < 20; i++) {
    records.push(normalizeOpen511Event({
      id: `zzz-closure-${String(i).padStart(4, '0')}`,
      headline: 'INCIDENT',
      severity: 'MAJOR',
      event_type: 'INCIDENT',
      geography: { type: 'Point', coordinates: [-123.1, 49.2] },
      roads: [{ name: 'Highway 1', state: 'CLOSED' }],
    }, { jurisdiction: 'BC', source: 'bc-open511' }));
  }
  for (let i = 0; i < 15; i++) {
    records.push(normalizeOpen511Event({
      id: `zzz-accident-${String(i).padStart(4, '0')}`,
      headline: 'Accident',
      description: 'Two-vehicle collision blocking the left lane',
      severity: 'MODERATE',
      event_type: 'INCIDENT',
      geography: { type: 'Point', coordinates: [-122.8, 49.1] },
      roads: [{ name: 'Highway 99', state: 'ALL_LANES_OPEN' }],
    }, { jurisdiction: 'BC', source: 'bc-open511' }));
  }
  for (let i = 0; i < 400; i++) {
    records.push(normalizeOpen511Event({
      id: `aaa-construction-${String(i).padStart(4, '0')}`,
      headline: 'CONSTRUCTION',
      severity: 'MINOR',
      event_type: 'CONSTRUCTION',
      geography: { type: 'Point', coordinates: [-123.0, 49.0] },
      roads: [{ name: 'Highway 5', state: 'ALL_LANES_OPEN' }],
    }, { jurisdiction: 'BC', source: 'bc-open511' }));
  }
  assert.equal(records.length, 435);
  const selected = selectOpen511Records(records);
  assert.equal(selected.truncated, true);
  assert.equal(selected.records.length, MAX_RECORDS);
  assert.equal(selected.records.filter((r) => r.isFullClosure).length, 20);
  assert.equal(selected.records.filter((r) => /accident|collision/i.test(`${r.headline} ${r.description}`)).length, 15);
  assert.equal(selected.records.filter((r) => r.eventType === 'CONSTRUCTION').length, 365);
});

test('400-record cap is a no-op below the limit and records truncated:false', () => {
  const records = [
    normalizeOpen511Event({
      id: 'drivebc.ca/DBC-1',
      headline: 'INCIDENT',
      severity: 'MAJOR',
      event_type: 'INCIDENT',
      geography: { type: 'Point', coordinates: [-123.1, 49.2] },
      roads: [{ name: 'Highway 1', state: 'CLOSED' }],
    }, { jurisdiction: 'BC', source: 'bc-open511' }),
  ];
  const selected = selectOpen511Records(records);
  assert.equal(selected.truncated, false);
  assert.equal(selected.records.length, 1);
  assert.equal(selected.records[0].id, 'drivebc.ca/DBC-1');
});
