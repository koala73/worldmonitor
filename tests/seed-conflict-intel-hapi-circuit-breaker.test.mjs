// Regression coverage for the HAPI bot-block follow-up to #5554.
//
// The first repair paced 38 per-country requests at ~1 request/second, but the
// production identifier was blocked again after that still produced thousands
// of requests per day. The durable contract is:
//   - two global bulk requests (admin-0, then admin-2 for the HRP countries that
//     publish no national row at all) for the target countries,
//   - no new request while the last successful snapshot is fresh.
//
// #7658 then inverted which channel serves those two sweeps, because HAPI's
// JSON API and its official HDX CSV snapshot disagree by ~23% on the trailing
// reference period and bot detection was picking between them. The contract is
// now:
//   - the HDX snapshot is the PRIMARY channel, latched once before any sweep,
//     so a healthy-but-lagging API can never win the run,
//   - a snapshot failure inside HAPI_FALLBACK_BUDGET_MS demotes the whole run to
//     the JSON API; a slower one fails closed rather than stacking sweeps behind
//     a spent budget,
//   - the demoted route re-anchors the per-country fan-out's window at the
//     demotion, so a slow-failing primary cannot starve the emergency net,
//   - every seed records which channel served it, and a demoted seed also marks
//     the source degraded so a permanent HDX break cannot run green,
//   - last-known-good Redis rows preserved without refreshing their fetchedAt.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  HAPI_API_CHANNEL,
  HAPI_DEMOTED_REFRESH_INTERVAL_MS,
  HAPI_FAILURE_BACKOFF_MS,
  HAPI_FALLBACK_BUDGET_MS,
  HAPI_HDX_MAX_RESPONSE_BYTES,
  HAPI_HDX_PACKAGE_URL,
  HAPI_COUNTRIES,
  HAPI_DASHBOARD_COUNTRIES,
  HAPI_REFRESH_INTERVAL_MS,
  HAPI_REQUIRED_COUNTRIES,
  HAPI_SNAPSHOT_CHANNEL,
  aggregateHapiConflictEvents,
  buildHapiConflictEventsUrl,
  buildHapiSeedProvenance,
  fetchAllHumanitarianSummaries,
  fetchHapiHdxSnapshotRows,
  selectHapiHdxCsvResources,
} from '../scripts/seed-conflict-intel.mjs';
import {
  HAPI_HDX_METADATA_TIMEOUT_MS,
  HAPI_HDX_SNAPSHOT_TIMEOUT_MS,
  HAPI_MAX_PAGES,
  HAPI_PAGE_LIMIT,
  hapiHdxFailureReason,
  readBoundedHapiHdxText,
} from '../scripts/_conflict-hapi.mjs';

const NOW = Date.parse('2026-07-26T13:30:00Z');
// The seeder DERIVES its crisis coverage from this registry instead of duplicating
// the codes, so these tests read the same file rather than restating them: a
// hand-written expectation here would reintroduce the exact drift being fixed.
const CRISIS_REGISTRY_PATH = new URL('../shared/crawlable-crises.json', import.meta.url);
const CRISIS_REGISTRY_COUNTRIES = [...new Set(
  JSON.parse(readFileSync(CRISIS_REGISTRY_PATH, 'utf8'))
    .flatMap((crisis) => crisis.coverage.map((entry) => entry.code.toUpperCase())),
)];

function hapiRow(locationCode, overrides = {}) {
  return {
    location_code: locationCode,
    reference_period_start: '2026-07-01',
    admin_level: 0,
    event_type: 'political_violence',
    events: 1,
    fatalities: 0,
    ...overrides,
  };
}
const HAPI_CSV_HEADER = '\ufefflocation_code,has_hrp,in_gho,provider_admin1_name,provider_admin2_name,admin1_code,admin1_name,admin2_code,admin2_name,admin_level,event_type,events,fatalities,reference_period_start,reference_period_end,dataset_hdx_id,resource_hdx_id,warning,error';

function hapiCsv(...rows) {
  return [HAPI_CSV_HEADER, ...rows].join('\n');
}

function hapiHdxResource(year) {
  return {
    id: `resource-${year}`,
    format: 'CSV',
    name: `Global Coordination & Context: Conflict Events (${year})`,
    url: `https://data.humdata.org/dataset/example/resource/resource-${year}/download/hdx_hapi_conflict_event_global_${year}.csv`,
  };
}

function hapiHdxMetadata(resources = [hapiHdxResource(2026)]) {
  return {
    success: true,
    result: { resources },
  };
}

// #7658 made the HDX snapshot the PRIMARY channel, so every ingestion test has
// to say what that channel does before it can say anything about the JSON API.
// These are the two answers: the snapshot serves, or the snapshot is down and
// the run is demoted to the API.
function snapshotServing(csv, onCall = () => {}) {
  return async (input) => {
    const url = String(input);
    onCall(url);
    return url.includes('/api/3/action/package_show')
      ? Response.json(hapiHdxMetadata())
      : new Response(csv, { headers: { 'Content-Type': 'text/csv' } });
  };
}

// Fails on the FIRST (metadata) request, so the demotion happens with the whole
// HAPI_FALLBACK_BUDGET_MS window still unspent — the slow-failure case has its
// own test below.
function snapshotDown(onCall = () => {}) {
  return async (input) => {
    onCall(String(input));
    return new Response('unavailable', { status: 503 });
  };
}

test('humanitarian health reports partial target-country coverage', () => {
  const healthSource = readFileSync(new URL('../api/health.js', import.meta.url), 'utf8');
  const seedSource = readFileSync(new URL('../scripts/seed-conflict-intel.mjs', import.meta.url), 'utf8');
  const minRecordCount = Number(
    /humanitarianSummary:\s*\{[^}]*maxStaleMin:\s*300,\s*minRecordCount:\s*(\d+)\s*\}/
      .exec(healthSource)?.[1],
  );
  assert.match(
    seedSource,
    /const requiredCountriesCovered = HAPI_REQUIRED_COUNTRIES\.filter\([^;]+/,
  );
  assert.match(
    seedSource,
    /HAPI_SEED_META_TTL_SECONDS,\s*requiredCountriesCovered,\s*HAPI_SEED_META_KEY/,
  );
  assert.equal(
    minRecordCount,
    HAPI_REQUIRED_COUNTRIES.length,
    'health.js minRecordCount must track the guaranteed-coverage contract, not a frozen count',
  );
  assert.equal(new URL(HAPI_HDX_PACKAGE_URL).hostname, 'data.humdata.org');
  assert.doesNotMatch(seedSource, /HAPI_PROXY_URL/);
  assert.deepEqual(
    new Set(HAPI_REQUIRED_COUNTRIES),
    new Set([...CRISIS_REGISTRY_COUNTRIES, ...HAPI_DASHBOARD_COUNTRIES]),
    'required coverage is the crisis registry plus the dashboard watchlist — never a third hand-maintained list',
  );
});

test('the channel that served a seed reaches the marker AND the seed-meta record', async () => {
  // #7658. The two HAPI channels disagree by ~23% on the trailing reference
  // period, so a published number that cannot name its channel cannot be
  // compared with the tick before it.
  //
  // This asserts on what the SEEDER builds, not on an object literal the test
  // itself passed in. The earlier version did the latter and was proven
  // toothless by mutation: deleting the channel from the marker payload, or
  // sourcing it from a field that does not exist, both kept the whole suite
  // green — writeSeedMeta drops undefined values, so the field simply vanished.
  const demoted = buildHapiSeedProvenance({
    summaries: { SD: { summary: {} }, UA: { summary: {} } },
    sourceChannel: HAPI_API_CHANNEL,
    snapshotFailureReason: 'HDX_HTTP_503',
  }, { nowMs: NOW });
  const authoritative = buildHapiSeedProvenance({
    summaries: { SD: { summary: {} } },
    sourceChannel: HAPI_SNAPSHOT_CHANNEL,
    snapshotFailureReason: null,
  }, { nowMs: NOW });

  assert.equal(demoted.marker.sourceChannel, HAPI_API_CHANNEL);
  assert.equal(demoted.channelProvenance.sourceChannel, HAPI_API_CHANNEL);
  assert.equal(demoted.channelProvenance.snapshotFailureReason, 'HDX_HTTP_503');
  assert.equal(
    demoted.channelProvenance.sourceState,
    'degraded',
    'a demoted seed must trip health’s degraded-but-serving hook, or a permanent HDX break runs green',
  );
  assert.equal(demoted.marker.countriesCovered, 2);
  assert.equal(demoted.marker.requiredCountriesTotal, HAPI_REQUIRED_COUNTRIES.length);
  assert.equal(demoted.marker.updatedAt, NOW);
  // api/health.js relays `errorCode` onto the entry when the fault is
  // SEED_ERROR and relays `errorReason` nowhere, so without this a demotion and
  // a bot-block are indistinguishable on the public endpoint.
  assert.equal(demoted.channelProvenance.errorCode, 'HDX_HTTP_503');
  assert.match(
    demoted.channelProvenance.errorCode,
    /^[A-Z0-9_]{1,64}$/,
    'health gates errorCode on this regex — a code that fails it is silently dropped',
  );
  // The family is HAPI_COUNTRIES (44), not the required set (41): a run can
  // cover every REQUIRED country while the 3 opportunistic ones still hold the
  // other channel's vintage, so the marker has to carry both totals.
  assert.equal(demoted.marker.countriesTotal, HAPI_COUNTRIES.length);
  assert.ok(
    HAPI_COUNTRIES.length > HAPI_REQUIRED_COUNTRIES.length,
    'if these ever coincide, the two-total distinction above stops being load-bearing',
  );

  // A healthy run must claim neither a failure reason nor a degraded source, or
  // the demotion alarm fires every tick and stops meaning anything.
  assert.equal(authoritative.marker.sourceChannel, HAPI_SNAPSHOT_CHANNEL);
  assert.deepEqual(
    Object.keys(authoritative.channelProvenance),
    ['sourceChannel'],
    'an authoritative run must not carry snapshotFailureReason, sourceState or errorCode',
  );

  // The per-country keys outlive a run (HAPI_TTL), and the caller's loop
  // overwrites only the countries THIS run covered, so after a partial run that
  // changed channel the family can hold both vintages. sourceChannel is
  // family-wide only when coverage is complete — so the marker must keep
  // carrying the coverage pair that lets a reader tell those apart.
  for (const field of ['requiredCountriesCovered', 'requiredCountriesTotal', 'countriesCovered', 'countriesTotal']) {
    assert.ok(
      Object.hasOwn(demoted.marker, field),
      `the marker must keep ${field} — it is what scopes sourceChannel to the whole family or just this run`,
    );
  }
  // Presence is not enough for this one: it is ALSO the recordCount argument to
  // writeExtraKeyWithMeta, and health gates humanitarianSummary on
  // minRecordCount === HAPI_REQUIRED_COUNTRIES.length. Computed backwards it
  // would either report 39/41 covered while 2 countries are published (health
  // green, crisis pages empty) or false-alarm on a healthy run. Both SD and UA
  // are in the required set, so the count is 2 — inverting the filter yields 39
  // and must fail here.
  assert.equal(demoted.marker.requiredCountriesCovered, 2);
  assert.equal(demoted.requiredCountriesCovered, 2, 'the returned recordCount must match the marker');
  assert.equal(authoritative.requiredCountriesCovered, 1);

  // Second half of the contract: `extra` is the ONLY writeExtraKeyWithMeta
  // argument slot that reaches the seed-meta record, so provenance passed one
  // slot earlier lands in `coverage` and is silently dropped. Drive the real
  // helper with the seeder's own arguments, then pin the call site's shape.
  process.env.UPSTASH_REDIS_REST_URL ||= 'https://redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN ||= 'fake-token';
  const { writeExtraKeyWithMeta } = await import('../scripts/_seed-utils.mjs');
  const originalFetch = globalThis.fetch;
  const sets = [];
  globalThis.fetch = async (_url, opts = {}) => {
    const command = opts?.body ? JSON.parse(opts.body) : null;
    if (Array.isArray(command) && command[0] === 'SET') sets.push(command);
    return Response.json({ result: 'OK' });
  };
  try {
    await writeExtraKeyWithMeta(
      'conflict:humanitarian:v1',
      demoted.marker,
      3 * 86400,
      demoted.requiredCountriesCovered,
      'seed-meta:conflict:humanitarian',
      3 * 86400,
      undefined,
      demoted.channelProvenance,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  const meta = JSON.parse(sets.find((c) => c[1] === 'seed-meta:conflict:humanitarian')[2]);
  assert.equal(meta.sourceChannel, HAPI_API_CHANNEL, 'the seed-meta record must name the channel too');
  assert.equal(meta.snapshotFailureReason, 'HDX_HTTP_503');
  assert.equal(meta.sourceState, 'degraded');

  const seedSource = readFileSync(new URL('../scripts/seed-conflict-intel.mjs', import.meta.url), 'utf8');
  assert.match(
    seedSource,
    /HAPI_SEED_META_TTL_SECONDS,\s*undefined,\s*channelProvenance,/,
    'the HAPI marker write must pass channelProvenance in writeExtraKeyWithMeta’s `extra` slot',
  );
  assert.match(
    seedSource,
    /buildHapiSeedProvenance\(ha\)/,
    'fetchAll must build the marker through the tested helper, not inline',
  );
});

test('every crisis-tracker registry country reaches the HAPI aggregation filter', () => {
  // THE regression guard for the bug this file's dual sweep exists to fix: the
  // registry shipped public /crises/<slug> pages for countries the seeder never
  // requested, and countryCodes silently DISCARDS rows for any country outside
  // HAPI_COUNTRIES — so a miss here is invisible in logs and in health.
  assert.ok(CRISIS_REGISTRY_COUNTRIES.length > 0, 'the crisis registry must not be empty');
  for (const countryCode of CRISIS_REGISTRY_COUNTRIES) {
    assert.ok(
      HAPI_COUNTRIES.includes(countryCode),
      `${countryCode} is published by a crisis tracker but sits outside the HAPI aggregation filter`,
    );
    assert.ok(
      HAPI_REQUIRED_COUNTRIES.includes(countryCode),
      `${countryCode} is published by a crisis tracker but is not in the guaranteed coverage contract`,
    );
  }
});

test('the Railway deploy copy of the crisis registry stays byte-identical', () => {
  // loadSharedConfig resolves ../shared/ first and scripts/shared/ second, so the
  // seeder reads a DIFFERENT file inside the Railway image than it does locally.
  // Divergence would make coverage depend on where the seeder happens to run.
  assert.equal(
    readFileSync(new URL('../scripts/shared/crawlable-crises.json', import.meta.url), 'utf8'),
    readFileSync(CRISIS_REGISTRY_PATH, 'utf8'),
  );
});

test('HAPI bulk URL requests national totals for the current and previous month', () => {
  const url = new URL(buildHapiConflictEventsUrl({ nowMs: NOW }));

  assert.equal(url.origin, 'https://hapi.humdata.org');
  assert.equal(url.pathname, '/api/v2/coordination-context/conflict-events');
  assert.equal(url.searchParams.get('admin_level'), '0');
  assert.equal(url.searchParams.get('start_date'), '2026-06-01');
  assert.equal(url.searchParams.get('limit'), '10000');
  assert.equal(url.searchParams.get('offset'), '0');
  assert.equal(url.searchParams.has('location_code'), false);
  assert.equal(url.searchParams.has('app_identifier'), false, 'identifier belongs in the supported request header');
});

test('the bulk page budget clears two monthly periods of subnational rows', () => {
  // Measured against the live API on 2026-09-04: ONE monthly reference period is
  // 13,785 admin-2 rows (vs 654 at admin-0, which is what the old 3-page budget
  // was sized for), and previousMonthStart can put TWO periods in the window.
  // fetchHapiRows THROWS past the budget instead of truncating, so a breach takes
  // the HRP countries dark again behind nothing but a warn line.
  const measuredRowsPerReferencePeriod = 13_785;
  const worstCaseRows = 2 * measuredRowsPerReferencePeriod;

  assert.ok(
    HAPI_MAX_PAGES * HAPI_PAGE_LIMIT >= Math.ceil(worstCaseRows * 1.5),
    `page budget ${HAPI_MAX_PAGES * HAPI_PAGE_LIMIT} leaves under 1.5x headroom on the measured ${worstCaseRows}-row worst case`,
  );
});

test('HAPI subnational sweep URL requests the deepest published level globally', () => {
  const url = new URL(buildHapiConflictEventsUrl({ nowMs: NOW, adminLevel: '2' }));

  assert.equal(url.searchParams.get('admin_level'), '2');
  assert.equal(url.searchParams.get('start_date'), '2026-06-01');
  assert.equal(url.searchParams.has('location_code'), false, 'the subnational sweep is global, not per country');
});

test('HAPI HDX snapshot selection spans the year boundary needed by the two-month query', () => {
  const resources = [
    hapiHdxResource(2024),
    hapiHdxResource(2025),
    hapiHdxResource(2026),
  ];
  const selected = selectHapiHdxCsvResources(resources, {
    nowMs: Date.parse('2026-01-15T00:00:00Z'),
  });

  assert.deepEqual(selected.map((resource) => resource.year), [2025, 2026]);
});

test('HAPI HDX snapshot selection tolerates a not-yet-published January resource', () => {
  const selected = selectHapiHdxCsvResources([hapiHdxResource(2025)], {
    nowMs: Date.parse('2026-01-01T00:00:00Z'),
  });

  assert.deepEqual(selected.map((resource) => resource.year), [2025]);
});

test('HAPI HDX snapshot selection rejects metadata-controlled resource hosts', () => {
  assert.throws(
    () => selectHapiHdxCsvResources([{
      ...hapiHdxResource(2026),
      url: 'https://example.invalid/hdx_hapi_conflict_event_global_2026.csv',
    }], { nowMs: NOW }),
    (error) => error.reasonCode === 'HDX_RESOURCE_INVALID',
  );
});

test('HAPI HDX gives snapshot downloads a longer bounded deadline than metadata', async () => {
  const timeoutCalls = [];
  const timeoutSignals = [];
  const fetchSignals = [];
  const csv = hapiCsv(
    'SDN,,,,,,,,,0,political_violence,12,3,2026-07-01,2026-07-31,dataset,resource,,',
  );
  const rows = await fetchHapiHdxSnapshotRows({
    nowMs: NOW,
    countryCodes: ['SD'],
    createTimeoutSignal: (timeoutMs) => {
      timeoutCalls.push(timeoutMs);
      const signal = new AbortController().signal;
      timeoutSignals.push(signal);
      return signal;
    },
    fetchFn: async (input, options) => {
      fetchSignals.push(options.signal);
      return String(input).includes('/api/3/action/package_show')
        ? Response.json(hapiHdxMetadata())
        : new Response(csv, { headers: { 'Content-Type': 'text/csv' } });
    },
  });

  assert.equal(rows.length, 1);
  assert.equal(HAPI_HDX_METADATA_TIMEOUT_MS, 60_000);
  assert.equal(HAPI_HDX_SNAPSHOT_TIMEOUT_MS, 120_000);
  assert.deepEqual(timeoutCalls, [60_000, 120_000]);
  assert.strictEqual(fetchSignals[0], timeoutSignals[0]);
  assert.strictEqual(fetchSignals[1], timeoutSignals[1]);
});

test('HAPI HDX metadata identity avoids the Railway WAF challenge', async () => {
  let metadataCalls = 0;
  const requestUserAgents = [];
  const csv = hapiCsv(
    'SDN,,,,,,,,,0,political_violence,12,3,2026-07-01,2026-07-31,dataset,resource,,',
  );
  const rows = await fetchHapiHdxSnapshotRows({
    nowMs: NOW,
    countryCodes: ['SD'],
    fetchFn: async (input, options) => {
      requestUserAgents.push(options.headers['User-Agent']);
      if (String(input).includes('/api/3/action/package_show')) {
        metadataCalls += 1;
        if (options.headers['User-Agent'] !== 'wm-crisis-tracker/1.0') {
          return new Response('', {
            status: 202,
            headers: {
              'Content-Type': 'text/html',
              'x-amzn-waf-action': 'challenge',
            },
          });
        }
        return Response.json(hapiHdxMetadata());
      }
      return new Response(csv, { headers: { 'Content-Type': 'text/csv' } });
    },
  });

  assert.equal(metadataCalls, 1);
  assert.deepEqual(requestUserAgents, ['wm-crisis-tracker/1.0', 'wm-crisis-tracker/1.0']);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].location_code, 'SDN');
});

test('HAPI bulk rows are grouped by country and only the latest reference period is published', () => {
  const rows = [
    {
      location_code: 'SDN',
      location_name: 'Sudan',
      reference_period_start: '2026-06-01',
      admin_level: 0,
      event_type: 'political_violence',
      events: 99,
      fatalities: 10,
    },
    {
      location_code: 'SDN',
      location_name: 'Sudan',
      reference_period_start: '2026-07-01',
      admin_level: 0,
      event_type: 'political_violence',
      events: 12,
      fatalities: 3,
    },
    {
      location_code: 'SDN',
      location_name: 'Sudan',
      reference_period_start: '2026-07-01',
      admin_level: 0,
      event_type: 'civilian_targeting',
      events: 4,
      fatalities: 2,
    },
    {
      location_code: 'SDN',
      location_name: 'Sudan',
      reference_period_start: '2026-07-01',
      admin_level: 0,
      event_type: 'demonstration',
      events: 7,
      fatalities: 0,
    },
    {
      location_code: 'ZZZ',
      location_name: 'Unknown',
      reference_period_start: '2026-07-01',
      admin_level: 0,
      event_type: 'political_violence',
      events: 500,
      fatalities: 500,
    },
  ];

  const result = aggregateHapiConflictEvents(rows, { nowMs: NOW, countryCodes: ['SD'] });

  assert.deepEqual(result, {
    SD: {
      summary: {
        countryCode: 'SD',
        countryName: 'Sudan',
        conflictEventsTotal: 23,
        conflictPoliticalViolenceEvents: 16,
        conflictFatalities: 5,
        referencePeriod: '2026-07-01',
        conflictDemonstrations: 7,
        updatedAt: NOW,
      },
    },
  });
});

test('HAPI aggregation uses the deepest available administrative level without double counting', () => {
  const result = aggregateHapiConflictEvents([
    {
      location_code: 'SDN',
      location_name: 'Sudan',
      reference_period_start: '2026-07-01',
      admin_level: 1,
      event_type: 'political_violence',
      events: 100,
      fatalities: 10,
    },
    {
      location_code: 'SDN',
      location_name: 'Sudan',
      reference_period_start: '2026-07-01',
      admin_level: 2,
      event_type: 'political_violence',
      events: 12,
      fatalities: 3,
    },
    {
      location_code: 'SDN',
      location_name: 'Sudan',
      reference_period_start: '2026-07-01',
      admin_level: 2,
      event_type: 'demonstration',
      events: 7,
      fatalities: 0,
    },
  ], { nowMs: NOW, countryCodes: ['SD'] });

  assert.equal(result.SD.summary.conflictEventsTotal, 19);
  assert.equal(result.SD.summary.conflictFatalities, 3);
});

test('one aggregation pass over both sweeps keeps each country at its own admin level', () => {
  // The live shape: HAPI publishes a country at exactly ONE admin level, so the
  // two global sweeps are disjoint. Aggregating the CONCATENATION in a single
  // pass (rather than merging two aggregates) is what keeps the deepest-level
  // tiebreak available if that ever stops being true.
  const nationalRows = [
    hapiRow('SDN', { location_name: 'Sudan', events: 12, fatalities: 3 }),
    hapiRow('SDN', { location_name: 'Sudan', event_type: 'demonstration', events: 7 }),
    hapiRow('UKR', { location_name: 'Ukraine', event_type: 'demonstration', events: 8 }),
  ];
  const subnationalRows = [
    hapiRow('AFG', { location_name: 'Afghanistan', admin_level: 2, events: 5, fatalities: 2 }),
    hapiRow('AFG', { location_name: 'Afghanistan', admin_level: 2, events: 6, fatalities: 1 }),
    hapiRow('HTI', { location_name: 'Haiti', admin_level: 2, event_type: 'civilian_targeting', events: 4, fatalities: 9 }),
  ];
  const countryCodes = ['SD', 'UA', 'AF', 'HT'];

  const combined = aggregateHapiConflictEvents(
    [...nationalRows, ...subnationalRows],
    { nowMs: NOW, countryCodes },
  );

  assert.deepEqual(Object.keys(combined).sort(), ['AF', 'HT', 'SD', 'UA']);
  assert.equal(combined.SD.summary.conflictEventsTotal, 19);
  assert.equal(combined.AF.summary.conflictEventsTotal, 11);
  assert.equal(combined.AF.summary.conflictFatalities, 3);
  assert.equal(combined.HT.summary.conflictEventsTotal, 4);
  assert.equal(combined.HT.summary.conflictFatalities, 9);

  // Behaviour preservation: every country live today comes from the admin-0
  // sweep, and appending the disjoint subnational rows must not perturb them.
  const nationalOnly = aggregateHapiConflictEvents(nationalRows, { nowMs: NOW, countryCodes });
  assert.deepEqual(combined.SD, nationalOnly.SD);
  assert.deepEqual(combined.UA, nationalOnly.UA);
  assert.equal(nationalOnly.AF, undefined, 'admin-0 alone is exactly what left the HRP countries dark');
  assert.equal(nationalOnly.HT, undefined);
});

test('a country returned by both sweeps resolves to the deeper level without double counting', () => {
  const result = aggregateHapiConflictEvents([
    hapiRow('UKR', { location_name: 'Ukraine', events: 100, fatalities: 10 }),
    hapiRow('UKR', { location_name: 'Ukraine', admin_level: 2, events: 40, fatalities: 4 }),
    hapiRow('UKR', { location_name: 'Ukraine', admin_level: 2, events: 20, fatalities: 1 }),
  ], { nowMs: NOW, countryCodes: ['UA'] });

  assert.equal(result.UA.summary.conflictEventsTotal, 60);
  assert.equal(result.UA.summary.conflictFatalities, 5);
});

test('a demoted run makes two global bulk requests and maps all returned target countries', async () => {
  const calls = [];
  const result = await fetchAllHumanitarianSummaries({
    now: () => NOW,
    countryCodes: ['SD', 'UA', 'AF'],
    pace: async () => assert.fail('two covering sweeps must leave the fallback fan-out with nothing to pace'),
    loadPreviousMarker: async () => null,
    loadFailureBackoff: async () => null,
    writeFailureBackoff: async () => assert.fail('success must not write a failure backoff'),
    preserveLastGood: async () => assert.fail('success must not extend stale rows'),
    snapshotFetchFn: snapshotDown(),
    fetchFn: async (url, options) => {
      const parsed = new URL(String(url));
      calls.push({ url: parsed, options });
      assert.equal(parsed.searchParams.has('location_code'), false, 'both sweeps are global');
      const data = parsed.searchParams.get('admin_level') === '0'
        ? [
            hapiRow('SDN', { location_name: 'Sudan', events: 12, fatalities: 3 }),
            hapiRow('UKR', { location_name: 'Ukraine', event_type: 'demonstration', events: 8 }),
          ]
        : [
            hapiRow('AFG', { location_name: 'Afghanistan', admin_level: 2, events: 5, fatalities: 2 }),
            hapiRow('AFG', { location_name: 'Afghanistan', admin_level: 2, events: 6, fatalities: 1 }),
          ];
      return new Response(JSON.stringify({ data }), { status: 200 });
    },
  });

  assert.deepEqual(
    calls.map((call) => call.url.searchParams.get('admin_level')),
    ['0', '2'],
    'two global bulk requests replace the 38-request per-country sweep',
  );
  assert.ok(calls[0].options.headers['X-HDX-HAPI-APP-IDENTIFIER']);
  assert.ok(calls[1].options.headers['X-HDX-HAPI-APP-IDENTIFIER']);
  assert.deepEqual(Object.keys(result.summaries).sort(), ['AF', 'SD', 'UA']);
  assert.equal(
    result.summaries.AF.summary.conflictEventsTotal,
    11,
    'an HRP country with no national row must publish from the subnational sweep',
  );
  assert.equal(result.sourceChannel, HAPI_API_CHANNEL);
  assert.equal(
    result.snapshotFailureReason,
    'HDX_HTTP_503',
    'a demoted seed must carry WHY it left the authoritative channel (#7658)',
  );
});

test('a demoted run keeps the per-country fallback for targets neither sweep covers', async () => {
  // Sudan here is published only at admin-1, which neither global sweep requests.
  // The fan-out is dead weight against today's upstream shape and MUST stay: it
  // is the fail-closed net for a required country moving between admin levels.
  const urls = [];
  const result = await fetchAllHumanitarianSummaries({
    now: () => NOW,
    countryCodes: ['SD', 'UA'],
    pace: async () => {},
    loadPreviousMarker: async () => null,
    loadFailureBackoff: async () => null,
    writeFailureBackoff: async () => assert.fail('complete coverage must not write a failure backoff'),
    preserveLastGood: async () => assert.fail('complete coverage must not extend stale rows'),
    snapshotFetchFn: snapshotDown(),
    fetchFn: async (url) => {
      const parsed = new URL(url);
      urls.push(parsed);
      if (parsed.searchParams.get('location_code') === 'SDN') {
        return new Response(JSON.stringify({
          data: [hapiRow('SDN', { location_name: 'Sudan', admin_level: 1, events: 12, fatalities: 3 })],
        }), { status: 200 });
      }
      const data = parsed.searchParams.get('admin_level') === '0'
        ? [hapiRow('UKR', { location_name: 'Ukraine', event_type: 'demonstration', events: 8 })]
        : [];
      return new Response(JSON.stringify({ data }), { status: 200 });
    },
  });

  assert.deepEqual(
    urls.map((parsed) => [
      parsed.searchParams.get('admin_level'),
      parsed.searchParams.get('location_code'),
    ]),
    [['0', null], ['2', null], [null, 'SDN']],
  );
  assert.deepEqual(Object.keys(result.summaries).sort(), ['SD', 'UA']);
  assert.equal(result.summaries.SD.summary.conflictEventsTotal, 12);
});

test('the per-country fallback stops LAUNCHING once its wall-clock budget is spent', async () => {
  // #7656: unbounded, this loop could add 23 × 15s behind two 75s sweeps and blow
  // the 315s envelope the fetch-deadline model is anchored on. Each per-country
  // request here burns 70s of the 140s budget, so exactly two may launch.
  const requested = [];
  let elapsedMs = 0;
  let backoff;
  let preserved = 0;
  const result = await fetchAllHumanitarianSummaries({
    now: () => NOW,
    readElapsedMs: () => elapsedMs,
    countryCodes: ['SD', 'UA', 'IR', 'IL', 'YE'],
    pace: async () => {},
    loadPreviousMarker: async () => null,
    loadFailureBackoff: async () => null,
    writeFailureBackoff: async (value) => { backoff = value; },
    writeFailureMeta: async () => assert.fail('partial coverage must not publish SEED_ERROR'),
    preserveLastGood: async () => { preserved += 1; },
    snapshotFetchFn: snapshotDown(),
    fetchFn: async (url) => {
      const parsed = new URL(url);
      const locationCode = parsed.searchParams.get('location_code');
      if (!locationCode) {
        // Only Sudan comes back from the sweeps; the rest fall to the fan-out.
        const data = parsed.searchParams.get('admin_level') === '0'
          ? [hapiRow('SDN', { location_name: 'Sudan', events: 12, fatalities: 3 })]
          : [];
        return new Response(JSON.stringify({ data }), { status: 200 });
      }
      requested.push(locationCode);
      elapsedMs += 70_000;
      return new Response(JSON.stringify({
        data: [hapiRow(locationCode, { admin_level: 1, events: 5, fatalities: 1 })],
      }), { status: 200 });
    },
  });

  assert.deepEqual(requested, ['UKR', 'IRN'], 'the third launch is over budget and must never be issued');
  assert.deepEqual(Object.keys(result.summaries).sort(), ['IR', 'SD', 'UA'], 'countries already covered must still publish');
  assert.equal(backoff.reasonCode, 'HAPI_FALLBACK_BUDGET_EXHAUSTED');
  assert.equal(backoff.status, 0, 'a budget cut has no provider status to record');
  assert.equal(backoff.retryAt, NOW + HAPI_FAILURE_BACKOFF_MS);
  assert.equal(preserved, 1, 'partial coverage must preserve last-good rather than pass as complete');
});

test('the HDX snapshot serves both sweeps without ever touching the JSON API', async () => {
  // #7658: the snapshot is the AUTHORITATIVE channel, not a bot-block rescue.
  // A healthy API must not win the run, because its trailing reference period
  // runs ~23% below the snapshot's — measured 2026-09-04, 103 countries lower
  // and zero higher. fetchRowsFromSnapshot filters on row.admin_level, so the
  // admin-2 sweep is served from the same ONE memoized download.
  let directCalls = 0;
  let snapshotCalls = 0;
  const csv = hapiCsv(
    'SDN,,,,,,,,,0,political_violence,12,3,2026-07-01,2026-07-31,dataset,resource,,',
    'AFG,,,,,,,,,2,political_violence,5,2,2026-07-01,2026-07-31,dataset,resource,,',
    'AFG,,,,,,,,,2,political_violence,6,1,2026-07-01,2026-07-31,dataset,resource,,',
  );
  const result = await fetchAllHumanitarianSummaries({
    now: () => NOW,
    countryCodes: ['SD', 'AF'],
    pace: async () => assert.fail('a snapshot covering every target must not pace a fallback'),
    loadPreviousMarker: async () => null,
    loadFailureBackoff: async () => null,
    writeFailureBackoff: async () => assert.fail('a healthy snapshot run must not back off'),
    writeFailureMeta: async () => assert.fail('a healthy snapshot run must not publish SEED_ERROR'),
    preserveLastGood: async () => assert.fail('a healthy snapshot run must not preserve stale rows'),
    snapshotFetchFn: snapshotServing(csv, () => { snapshotCalls += 1; }),
    fetchFn: async () => {
      directCalls += 1;
      // A perfectly healthy API. Reaching it at all is the regression.
      return Response.json({ data: [hapiRow('SDN', { location_name: 'Sudan', events: 9999 })] });
    },
  });

  assert.equal(directCalls, 0, 'the authoritative channel must not be decided by whether the API answers');
  assert.equal(snapshotCalls, 2, 'one metadata plus one CSV download serves both sweeps');
  assert.deepEqual(Object.keys(result.summaries).sort(), ['AF', 'SD']);
  assert.equal(result.summaries.SD.summary.conflictEventsTotal, 12);
  assert.equal(
    result.summaries.AF.summary.conflictEventsTotal,
    11,
    'admin-2 rows must survive the snapshot admin_level filter',
  );
  assert.equal(result.sourceChannel, HAPI_SNAPSHOT_CHANNEL);
  assert.equal(result.snapshotFailureReason, null);
});

test('a failed subnational sweep still publishes the national sweep and backs off', async () => {
  let backoff;
  let preserved = 0;
  const adminLevels = [];
  const result = await fetchAllHumanitarianSummaries({
    now: () => NOW,
    countryCodes: ['SD'],
    pace: async () => {},
    loadPreviousMarker: async () => null,
    loadFailureBackoff: async () => null,
    writeFailureBackoff: async (value) => { backoff = value; },
    writeFailureMeta: async () => assert.fail('a partial success must not publish SEED_ERROR'),
    preserveLastGood: async () => { preserved += 1; },
    snapshotFetchFn: snapshotDown(),
    fetchFn: async (url) => {
      const parsed = new URL(url);
      adminLevels.push(parsed.searchParams.get('admin_level'));
      if (parsed.searchParams.get('admin_level') === '2') {
        return new Response(JSON.stringify({ error: 'Too Many Requests' }), { status: 429 });
      }
      return new Response(JSON.stringify({
        data: [hapiRow('SDN', { location_name: 'Sudan', events: 12, fatalities: 3 })],
      }), { status: 200 });
    },
  });

  assert.deepEqual(adminLevels, ['0', '2'], 'a rejected subnational sweep must not abort the run');
  assert.deepEqual(Object.keys(result.summaries), ['SD']);
  assert.equal(preserved, 1);
  assert.equal(backoff.status, 429);
  assert.equal(backoff.reasonCode, 'HAPI_RATE_LIMIT');
});

test('a bot-blocked API is irrelevant while the snapshot is healthy', async () => {
  let directCalls = 0;
  const snapshotUrls = [];
  const csv = hapiCsv(
    'SDN,,,,,,,,,0,political_violence,12,3,2026-07-01,2026-07-31,dataset,resource,,',
  );
  const result = await fetchAllHumanitarianSummaries({
    now: () => NOW,
    countryCodes: ['SD'],
    pace: async () => {},
    loadPreviousMarker: async () => null,
    loadFailureBackoff: async () => null,
    writeFailureBackoff: async () => assert.fail('a healthy snapshot run must not back off'),
    writeFailureMeta: async () => assert.fail('a healthy snapshot run must not publish SEED_ERROR'),
    preserveLastGood: async () => assert.fail('a healthy snapshot run must not preserve stale rows'),
    snapshotFetchFn: snapshotServing(csv, (url) => snapshotUrls.push(url)),
    fetchFn: async () => {
      directCalls += 1;
      return new Response('Blocked due to bot activity.', { status: 406 });
    },
  });

  assert.equal(directCalls, 0, 'the bot block that used to pick the channel now never gets asked');
  assert.equal(snapshotUrls.length, 2);
  assert.deepEqual(Object.keys(result.summaries), ['SD']);
  assert.equal(result.summaries.SD.summary.countryName, 'Sudan');
  assert.equal(result.sourceChannel, HAPI_SNAPSHOT_CHANNEL);
});

test('a quota rejection on the demoted API backs off and names both channels', async () => {
  let directCalls = 0;
  let backoff;
  let failureMeta;
  let preserved = 0;
  const result = await fetchAllHumanitarianSummaries({
    now: () => NOW,
    countryCodes: ['SD'],
    pace: async () => {},
    loadPreviousMarker: async () => ({
      updatedAt: NOW - 10 * HAPI_REFRESH_INTERVAL_MS,
      requiredCountriesCovered: 23,
    }),
    loadFailureBackoff: async () => null,
    writeFailureBackoff: async (value) => { backoff = value; },
    writeFailureMeta: async (value) => { failureMeta = value; },
    preserveLastGood: async () => { preserved += 1; },
    snapshotFetchFn: snapshotDown(),
    fetchFn: async () => {
      directCalls += 1;
      return new Response(JSON.stringify({ error: 'Too Many Requests' }), { status: 429 });
    },
  });

  assert.equal(result, null);
  assert.equal(directCalls, 1, 'a quota rejection must not fan out into per-country retries');
  assert.equal(preserved, 1);
  assert.equal(backoff.status, 429);
  assert.equal(backoff.reasonCode, 'HAPI_RATE_LIMIT');
  assert.equal(backoff.retryAt, NOW + HAPI_FAILURE_BACKOFF_MS);
  assert.equal(failureMeta.status, 'error');
  assert.equal(failureMeta.errorReason, 'HAPI_RATE_LIMIT');
  assert.equal(failureMeta.attemptedChannel, HAPI_API_CHANNEL);
  assert.equal(
    failureMeta.snapshotFailureReason,
    'HDX_HTTP_503',
    'a dark HAPI must name the primary failure as well as the fallback one',
  );
  assert.equal(failureMeta.lastSuccessAt, NOW - 10 * HAPI_REFRESH_INTERVAL_MS);
  assert.equal(failureMeta.recordCount, 23);
});

test('HAPI snapshot network failure publishes actionable SEED_ERROR metadata before backoff', async () => {
  let failureMeta;
  let backoff;
  const result = await fetchAllHumanitarianSummaries({
    now: () => NOW,
    countryCodes: ['SD'],
    pace: async () => {},
    loadPreviousMarker: async () => null,
    loadFailureBackoff: async () => null,
    writeFailureBackoff: async (value) => { backoff = value; },
    writeFailureMeta: async (value) => { failureMeta = value; },
    preserveLastGood: async () => {},
    snapshotFetchFn: async () => {
      throw Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('getaddrinfo ENOTFOUND data.humdata.org'), {
          code: 'ENOTFOUND',
        }),
      });
    },
    fetchFn: async () => (
      new Response(JSON.stringify({ error: 'Blocked due to bot activity.' }), { status: 429 })
    ),
  });

  assert.equal(result, null);
  assert.equal(backoff.status, 429);
  assert.equal(backoff.reasonCode, 'HAPI_BOT_BLOCK', 'the terminal failure is the demoted channel’s own');
  assert.equal(failureMeta.status, 'error');
  assert.equal(failureMeta.errorReason, 'HAPI_BOT_BLOCK');
  assert.equal(failureMeta.attemptedChannel, HAPI_API_CHANNEL);
  assert.equal(failureMeta.snapshotFailureReason, 'HDX_DNS_ERROR');
  assert.equal(failureMeta.failedAt, NOW);
});

test('HAPI snapshot classifies nested Undici timeouts', () => {
  for (const code of [
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT',
  ]) {
    const error = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error(code), { code }),
    });

    assert.equal(hapiHdxFailureReason(error), 'HDX_TIMEOUT', code);
  }
});

test('HAPI snapshot response limit failure keeps its operator-actionable reason', async () => {
  let failureMeta;
  let snapshotCalls = 0;
  const result = await fetchAllHumanitarianSummaries({
    now: () => NOW,
    countryCodes: ['SD'],
    pace: async () => {},
    loadPreviousMarker: async () => null,
    loadFailureBackoff: async () => null,
    writeFailureBackoff: async () => {},
    writeFailureMeta: async (value) => { failureMeta = value; },
    preserveLastGood: async () => {},
    snapshotFetchFn: async () => {
      snapshotCalls += 1;
      if (snapshotCalls === 1) return Response.json(hapiHdxMetadata());
      return new Response('oversize', {
        headers: {
          'Content-Length': String(HAPI_HDX_MAX_RESPONSE_BYTES + 1),
          'Content-Type': 'text/csv',
        },
      });
    },
    fetchFn: async () => (
      new Response(JSON.stringify({ error: 'Blocked due to bot activity.' }), { status: 429 })
    ),
  });

  assert.equal(result, null);
  assert.equal(failureMeta.snapshotFailureReason, 'RESPONSE_TOO_LARGE');
});

test('HAPI snapshot enforces its response limit while streaming without content-length', async () => {
  let failureMeta;
  const oversizedMetadata = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(1_200_000));
      controller.enqueue(new Uint8Array(1_200_000));
      controller.close();
    },
  });
  const result = await fetchAllHumanitarianSummaries({
    now: () => NOW,
    countryCodes: ['SD'],
    pace: async () => {},
    loadPreviousMarker: async () => null,
    loadFailureBackoff: async () => null,
    writeFailureBackoff: async () => {},
    writeFailureMeta: async (value) => { failureMeta = value; },
    preserveLastGood: async () => {},
    snapshotFetchFn: async () => new Response(oversizedMetadata),
    fetchFn: async () => (
      new Response(JSON.stringify({ error: 'Blocked due to bot activity.' }), { status: 429 })
    ),
  });

  assert.equal(result, null);
  assert.equal(failureMeta.snapshotFailureReason, 'RESPONSE_TOO_LARGE');
});

test('HAPI bounded reader cancels an unbounded stream before full buffering', async () => {
  let reads = 0;
  let cancellations = 0;
  let arrayBufferCalls = 0;
  const response = {
    status: 200,
    headers: { get: () => null },
    body: {
      getReader: () => ({
        read: async () => {
          reads += 1;
          return { done: false, value: new Uint8Array(1_200_000) };
        },
        cancel: async () => { cancellations += 1; },
        releaseLock: () => {},
      }),
    },
    arrayBuffer: async () => {
      arrayBufferCalls += 1;
      return new Uint8Array(2_400_000).buffer;
    },
  };

  await assert.rejects(
    () => readBoundedHapiHdxText(response, 2_000_000),
    (error) => error.reasonCode === 'RESPONSE_TOO_LARGE',
  );
  assert.equal(reads, 2);
  assert.equal(cancellations, 1);
  assert.equal(arrayBufferCalls, 0);
});

test('HAPI snapshot schema drift publishes an actionable failure reason', async () => {
  let failureMeta;
  let snapshotCalls = 0;
  const result = await fetchAllHumanitarianSummaries({
    now: () => NOW,
    countryCodes: ['SD'],
    pace: async () => {},
    loadPreviousMarker: async () => null,
    loadFailureBackoff: async () => null,
    writeFailureBackoff: async () => {},
    writeFailureMeta: async (value) => { failureMeta = value; },
    preserveLastGood: async () => {},
    snapshotFetchFn: async () => {
      snapshotCalls += 1;
      if (snapshotCalls === 1) return Response.json(hapiHdxMetadata());
      return new Response('location_code,events\nSDN,12', {
        headers: { 'Content-Type': 'text/csv' },
      });
    },
    fetchFn: async () => (
      new Response(JSON.stringify({ error: 'Blocked due to bot activity.' }), { status: 429 })
    ),
  });

  assert.equal(result, null);
  assert.equal(failureMeta.snapshotFailureReason, 'HDX_CSV_INVALID');
});

test('a snapshot outage publishes the demoted aggregate rather than going dark', async () => {
  // Inverted by #7658. The snapshot used to be the rescue path, so its failure
  // was terminal and discarded whatever the API had already produced. Now the
  // API is the rescue path: partial coverage from it is worth publishing — the
  // crisis pages keep numbers — PROVIDED the seed says it came from the lagging
  // channel and the run still backs off over the country it could not cover.
  const snapshotUrls = [];
  let directCalls = 0;
  let backoff;
  let preserved = 0;
  const result = await fetchAllHumanitarianSummaries({
    now: () => NOW,
    countryCodes: ['SD', 'UA', 'IR'],
    pace: async () => {},
    loadPreviousMarker: async () => ({
      updatedAt: NOW - 10 * HAPI_REFRESH_INTERVAL_MS,
      requiredCountriesCovered: 3,
    }),
    loadFailureBackoff: async () => null,
    writeFailureBackoff: async (value) => { backoff = value; },
    writeFailureMeta: async () => assert.fail('a partial success must not publish SEED_ERROR'),
    preserveLastGood: async () => { preserved += 1; },
    snapshotFetchFn: async (input) => {
      const url = String(input);
      snapshotUrls.push(url);
      if (url.includes('/api/3/action/package_show')) {
        return Response.json(hapiHdxMetadata());
      }
      return new Response('unavailable', { status: 503 });
    },
    fetchFn: async (input) => {
      directCalls += 1;
      const url = new URL(String(input));
      if (!url.searchParams.has('location_code')) {
        return Response.json({
          data: url.searchParams.get('admin_level') === '0'
            ? [hapiRow('SDN', { location_name: 'Sudan', events: 12, fatalities: 3 })]
            : [],
        });
      }
      assert.equal(url.searchParams.get('location_code'), 'UKR');
      return new Response('Blocked due to bot activity.', { status: 429 });
    },
  });

  assert.deepEqual(Object.keys(result.summaries), ['SD']);
  assert.equal(result.sourceChannel, HAPI_API_CHANNEL);
  assert.equal(result.snapshotFailureReason, 'HDX_HTTP_503');
  assert.equal(directCalls, 3, 'both global sweeps and the first missing-country request should run');
  assert.equal(snapshotUrls.length, 2, 'metadata plus one failed CSV request should run');
  assert.equal(preserved, 1, 'incomplete coverage must preserve last-good rather than pass as complete');
  assert.equal(backoff.status, 429);
  assert.equal(backoff.reasonCode, 'HAPI_BOT_BLOCK');
  assert.equal(backoff.retryAt, NOW + HAPI_FAILURE_BACKOFF_MS);
});

test('a snapshot that parses but covers nothing demotes rather than going dark', async () => {
  // Promoting the snapshot to primary would otherwise turn an upstream
  // publication gap — a well-formed annual file with no rows in the window —
  // into a dark HAPI, even though the channel that used to be primary is
  // healthy and has the month.
  const result = await fetchAllHumanitarianSummaries({
    now: () => NOW,
    countryCodes: ['SD'],
    pace: async () => {},
    loadPreviousMarker: async () => null,
    loadFailureBackoff: async () => null,
    writeFailureBackoff: async () => assert.fail('a covered demotion must not back off'),
    writeFailureMeta: async () => assert.fail('a covered demotion must not publish SEED_ERROR'),
    preserveLastGood: async () => assert.fail('a covered demotion must not preserve stale rows'),
    snapshotFetchFn: snapshotServing(hapiCsv()),
    fetchFn: async (url) => Response.json({
      data: new URL(url).searchParams.get('admin_level') === '0'
        ? [hapiRow('SDN', { location_name: 'Sudan', events: 12, fatalities: 3 })]
        : [],
    }),
  });

  assert.equal(result.sourceChannel, HAPI_API_CHANNEL);
  assert.equal(result.snapshotFailureReason, 'HDX_SNAPSHOT_EMPTY');
  assert.equal(result.summaries.SD.summary.conflictEventsTotal, 12);
});

test('a slow-failing snapshot does not starve the demoted per-country fan-out', async () => {
  // docs/solutions/design-patterns/primary-fallback-inversion-budget-transfer.md,
  // filed against this module: inverting primary/fallback silently transfers the
  // shared budget to the new primary, so a SLOW (not down) primary permanently
  // disables the emergency fallback. The doc prescribes exactly this
  // injected-clock test, and it is the one shape ordinary mocks cannot catch —
  // synchronous stub failures consume zero clock, so the fan-out always appears
  // to get its full window. Here the snapshot burns 130s of the 140s budget
  // before failing; an entry-anchored fan-out would launch ZERO countries.
  const requested = [];
  let elapsedMs = 0;
  const result = await fetchAllHumanitarianSummaries({
    now: () => NOW,
    readElapsedMs: () => elapsedMs,
    countryCodes: ['SD', 'UA'],
    pace: async () => {},
    loadPreviousMarker: async () => null,
    loadFailureBackoff: async () => null,
    writeFailureBackoff: async () => {},
    writeFailureMeta: async () => assert.fail('a covered fan-out must not publish SEED_ERROR'),
    preserveLastGood: async () => {},
    snapshotFetchFn: async () => {
      elapsedMs = HAPI_FALLBACK_BUDGET_MS - 10_000;
      return new Response('unavailable', { status: 503 });
    },
    fetchFn: async (url) => {
      const parsed = new URL(url);
      const locationCode = parsed.searchParams.get('location_code');
      if (!locationCode) return Response.json({ data: [] });
      requested.push(locationCode);
      return Response.json({
        data: [hapiRow(locationCode, { admin_level: 1, events: 5, fatalities: 1 })],
      });
    },
  });

  assert.deepEqual(
    requested,
    ['SDN', 'UKR'],
    'the fan-out window must be re-anchored at the demotion, not spent by the failed primary',
  );
  assert.deepEqual(Object.keys(result.summaries).sort(), ['SD', 'UA']);
  assert.equal(result.sourceChannel, HAPI_API_CHANNEL);
});

test('the demotion gate admits a snapshot failure one tick inside the budget', async () => {
  // Pins the >= boundary from the other side: the fail-closed test below sits
  // exactly ON HAPI_FALLBACK_BUDGET_MS, so without this one the gate could be
  // inverted to `>` and still pass everything.
  let elapsedMs = 0;
  const result = await fetchAllHumanitarianSummaries({
    now: () => NOW,
    readElapsedMs: () => elapsedMs,
    countryCodes: ['SD'],
    pace: async () => {},
    loadPreviousMarker: async () => null,
    loadFailureBackoff: async () => null,
    writeFailureBackoff: async () => {},
    writeFailureMeta: async () => assert.fail('a successful demotion must not publish SEED_ERROR'),
    preserveLastGood: async () => {},
    snapshotFetchFn: async () => {
      elapsedMs = HAPI_FALLBACK_BUDGET_MS - 1;
      return new Response('unavailable', { status: 503 });
    },
    fetchFn: async (url) => Response.json({
      data: new URL(url).searchParams.get('admin_level') === '0'
        ? [hapiRow('SDN', { location_name: 'Sudan', events: 12, fatalities: 3 })]
        : [],
    }),
  });

  assert.equal(result.sourceChannel, HAPI_API_CHANNEL);
  assert.equal(result.summaries.SD.summary.conflictEventsTotal, 12);
});

test('a demoted seed shortens its own freshness pin so the next tick retries the snapshot', async () => {
  // Recording the channel is only half the fix: a demoted run that bought the
  // full 2h pin would publish the ~23%-low vintage for 8 cron ticks.
  let snapshotCalls = 0;
  const csv = hapiCsv(
    'SDN,,,,,,,,,0,political_violence,12,3,2026-07-01,2026-07-31,dataset,resource,,',
  );
  const stillPinned = await fetchAllHumanitarianSummaries({
    now: () => NOW,
    countryCodes: ['SD'],
    loadPreviousMarker: async () => ({
      updatedAt: NOW - (HAPI_DEMOTED_REFRESH_INTERVAL_MS - 1),
      sourceChannel: HAPI_API_CHANNEL,
    }),
    loadFailureBackoff: async () => null,
    snapshotFetchFn: async () => assert.fail('inside the demoted window, nothing should refetch'),
    fetchFn: async () => assert.fail('inside the demoted window, nothing should refetch'),
  });
  const retried = await fetchAllHumanitarianSummaries({
    now: () => NOW,
    countryCodes: ['SD'],
    pace: async () => {},
    loadPreviousMarker: async () => ({
      updatedAt: NOW - HAPI_DEMOTED_REFRESH_INTERVAL_MS,
      sourceChannel: HAPI_API_CHANNEL,
    }),
    loadFailureBackoff: async () => null,
    writeFailureBackoff: async () => assert.fail('a recovered snapshot must not back off'),
    preserveLastGood: async () => assert.fail('a recovered snapshot must not preserve stale rows'),
    snapshotFetchFn: snapshotServing(csv, () => { snapshotCalls += 1; }),
    fetchFn: async () => assert.fail('a recovered snapshot must not touch the API'),
  });
  // A seed from the AUTHORITATIVE channel keeps the full 2h pin.
  const snapshotPinned = await fetchAllHumanitarianSummaries({
    now: () => NOW,
    countryCodes: ['SD'],
    loadPreviousMarker: async () => ({
      updatedAt: NOW - HAPI_DEMOTED_REFRESH_INTERVAL_MS,
      sourceChannel: HAPI_SNAPSHOT_CHANNEL,
    }),
    loadFailureBackoff: async () => null,
    snapshotFetchFn: async () => assert.fail('a fresh snapshot seed must not refetch'),
    fetchFn: async () => assert.fail('a fresh snapshot seed must not refetch'),
  });

  assert.equal(stillPinned, null);
  assert.equal(snapshotPinned, null, 'the shortened pin must apply ONLY to demoted seeds');
  assert.equal(retried.sourceChannel, HAPI_SNAPSHOT_CHANNEL, 'the next tick must reclaim the authoritative channel');
  assert.equal(snapshotCalls, 2);
  assert.ok(HAPI_DEMOTED_REFRESH_INTERVAL_MS < HAPI_REFRESH_INTERVAL_MS);
});

test('a still-down snapshot preserves the demoted rows instead of re-sweeping the API', async () => {
  // The shortened demoted pin buys a cheap SNAPSHOT retry. If it also re-swept
  // the JSON API every 15 min it would run those two global requests at 8x
  // their designed cadence during an HDX outage, on the shared app_identifier
  // #5554 got throttled for exactly that kind of burst — and the resulting 429
  // would take BOTH channels dark. The rows it would re-fetch are the ones
  // already published minutes ago, so there is nothing to gain.
  let preserved = 0;
  let snapshotCalls = 0;
  const result = await fetchAllHumanitarianSummaries({
    now: () => NOW,
    countryCodes: ['SD'],
    pace: async () => {},
    loadPreviousMarker: async () => ({
      // Past the 15-min snapshot-retry pin, but well inside the 2h API cadence.
      updatedAt: NOW - (HAPI_DEMOTED_REFRESH_INTERVAL_MS + 60_000),
      sourceChannel: HAPI_API_CHANNEL,
    }),
    loadFailureBackoff: async () => null,
    writeFailureBackoff: async () => assert.fail('a preserved tick is not a failure — no backoff'),
    writeFailureMeta: async () => assert.fail('a preserved tick must not publish SEED_ERROR'),
    preserveLastGood: async () => { preserved += 1; },
    snapshotFetchFn: snapshotDown(() => { snapshotCalls += 1; }),
    fetchFn: async () => assert.fail('the demoted rows are still fresh — the API must not be re-swept'),
  });

  assert.equal(result, null);
  assert.equal(snapshotCalls, 1, 'the authoritative channel must still be retried each tick');
  assert.equal(preserved, 1, 'last-good must keep serving while the snapshot is down');
});

test('a still-down snapshot DOES re-sweep once the demoted rows reach the normal cadence', async () => {
  // The other side of the same gate: preserving forever would let the demoted
  // rows age past their own TTL. At HAPI_REFRESH_INTERVAL_MS the API refresh
  // resumes at its designed cadence.
  const adminLevels = [];
  const result = await fetchAllHumanitarianSummaries({
    now: () => NOW,
    countryCodes: ['SD'],
    pace: async () => {},
    loadPreviousMarker: async () => ({
      updatedAt: NOW - HAPI_REFRESH_INTERVAL_MS,
      sourceChannel: HAPI_API_CHANNEL,
    }),
    loadFailureBackoff: async () => null,
    writeFailureBackoff: async () => assert.fail('a covered refresh must not back off'),
    writeFailureMeta: async () => assert.fail('a covered refresh must not publish SEED_ERROR'),
    preserveLastGood: async () => assert.fail('a covered refresh must not preserve stale rows'),
    snapshotFetchFn: snapshotDown(),
    fetchFn: async (url) => {
      const parsed = new URL(url);
      adminLevels.push(parsed.searchParams.get('admin_level'));
      return Response.json({
        data: parsed.searchParams.get('admin_level') === '0'
          ? [hapiRow('SDN', { location_name: 'Sudan', events: 12, fatalities: 3 })]
          : [],
      });
    },
  });

  assert.deepEqual(adminLevels, ['0', '2']);
  assert.equal(result.sourceChannel, HAPI_API_CHANNEL);
});

test('a snapshot that fails SLOWLY fails closed instead of stacking API sweeps behind it', async () => {
  // The snapshot's own timeouts let it burn 60s of metadata plus two 120s annual
  // downloads. Demoting after that would stack two 75s API sweeps on top and
  // push the worst case to 465s, past the ≤315s envelope the fetch-deadline
  // model is anchored on. Past HAPI_FALLBACK_BUDGET_MS the run must stop.
  let elapsedMs = 0;
  let backoff;
  let failureMeta;
  let preserved = 0;
  const result = await fetchAllHumanitarianSummaries({
    now: () => NOW,
    readElapsedMs: () => elapsedMs,
    countryCodes: ['SD'],
    pace: async () => {},
    loadPreviousMarker: async () => null,
    loadFailureBackoff: async () => null,
    writeFailureBackoff: async (value) => { backoff = value; },
    writeFailureMeta: async (value) => { failureMeta = value; },
    preserveLastGood: async () => { preserved += 1; },
    snapshotFetchFn: async () => {
      elapsedMs = HAPI_FALLBACK_BUDGET_MS;
      throw Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('timed out'), { code: 'UND_ERR_BODY_TIMEOUT' }),
      });
    },
    fetchFn: async () => assert.fail('an out-of-budget run must not launch a demoted API sweep'),
  });

  assert.equal(result, null);
  assert.equal(preserved, 1);
  assert.equal(backoff.reasonCode, 'HDX_TIMEOUT');
  assert.equal(backoff.status, 0, 'a transport timeout has no provider status to record');
  assert.equal(failureMeta.status, 'error');
  assert.equal(failureMeta.errorReason, 'HDX_TIMEOUT');
  assert.equal(
    failureMeta.attemptedChannel,
    HAPI_SNAPSHOT_CHANNEL,
    'a run that never demoted must not be attributed to the API',
  );
});

test('HAPI backoff records the fallback rejection status when the national sweep is empty', async () => {
  let backoff;
  let failureMeta;
  let preserved = 0;
  const result = await fetchAllHumanitarianSummaries({
    now: () => NOW,
    countryCodes: ['SD'],
    pace: async () => {},
    loadPreviousMarker: async () => null,
    loadFailureBackoff: async () => null,
    writeFailureBackoff: async (value) => { backoff = value; },
    writeFailureMeta: async (value) => { failureMeta = value; },
    preserveLastGood: async () => { preserved += 1; },
    snapshotFetchFn: snapshotDown(),
    fetchFn: async (url) => {
      const parsed = new URL(url);
      if (!parsed.searchParams.has('location_code')) {
        // National admin-0 sweep covers nothing for this target country.
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      // Bounded per-country fallback is the one that gets throttled.
      return new Response(JSON.stringify({ error: 'Too Many Requests' }), { status: 429 });
    },
  });

  assert.equal(result, null);
  assert.equal(preserved, 1);
  assert.equal(backoff.status, 429, 'must record the fallback rejection status, not fall back to 0');
  assert.equal(failureMeta.errorReason, 'HAPI_RATE_LIMIT');
  assert.equal(backoff.retryAt, NOW + HAPI_FAILURE_BACKOFF_MS);
});

test('HAPI ingestion skips network calls during success and failure backoff windows', async () => {
  // Counting only fetchFn used to be enough, but since #7658 the SNAPSHOT
  // resolves first on every non-gated run — and snapshotFetchFn defaults to the
  // real globalThis.fetch against data.humdata.org (~21MB). So the invariant
  // here is "no network AT ALL inside a pinned window", and both channels have
  // to be stubbed to assert it: an unstubbed snapshot would hit the live
  // provider and still pass on `calls`.
  let calls = 0;
  const fetchFn = async () => {
    calls += 1;
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  };
  const snapshotFetchFn = async () => {
    calls += 1;
    assert.fail('a pinned window must not reach the snapshot channel either');
  };

  const recent = await fetchAllHumanitarianSummaries({
    now: () => NOW,
    countryCodes: ['SD'],
    pace: async () => {},
    loadPreviousMarker: async () => ({ updatedAt: NOW - HAPI_REFRESH_INTERVAL_MS + 1 }),
    loadFailureBackoff: async () => null,
    snapshotFetchFn,
    fetchFn,
  });
  const blocked = await fetchAllHumanitarianSummaries({
    now: () => NOW,
    countryCodes: ['SD'],
    pace: async () => {},
    loadPreviousMarker: async () => null,
    loadFailureBackoff: async () => ({ retryAt: NOW + 1 }),
    snapshotFetchFn,
    fetchFn,
  });

  assert.equal(recent, null);
  assert.equal(blocked, null);
  assert.equal(calls, 0);
});
