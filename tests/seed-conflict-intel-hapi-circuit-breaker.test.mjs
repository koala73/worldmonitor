// Regression coverage for the HAPI bot-block follow-up to #5554.
//
// The first repair paced 38 per-country requests at ~1 request/second, but the
// production identifier was blocked again after that still produced thousands
// of requests per day. The durable contract is:
//   - two global bulk requests (admin-0, then admin-2 for the HRP countries that
//     publish no national row at all) for the target countries,
//   - no new request while the last successful snapshot is fresh,
//   - direct bot-block failures switch to HAPI's official HDX snapshot,
//   - quota/identifier throttles persist a failure backoff without snapshotting,
//   - last-known-good Redis rows preserved without refreshing their fetchedAt.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  HAPI_FAILURE_BACKOFF_MS,
  HAPI_HDX_MAX_RESPONSE_BYTES,
  HAPI_HDX_PACKAGE_URL,
  HAPI_COUNTRIES,
  HAPI_DASHBOARD_COUNTRIES,
  HAPI_REFRESH_INTERVAL_MS,
  HAPI_REQUIRED_COUNTRIES,
  aggregateHapiConflictEvents,
  buildHapiConflictEventsUrl,
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

test('HAPI ingestion makes two global bulk requests and maps all returned target countries', async () => {
  const calls = [];
  const result = await fetchAllHumanitarianSummaries({
    now: () => NOW,
    countryCodes: ['SD', 'UA', 'AF'],
    pace: async () => assert.fail('two covering sweeps must leave the fallback fan-out with nothing to pace'),
    loadPreviousMarker: async () => null,
    loadFailureBackoff: async () => null,
    writeFailureBackoff: async () => assert.fail('success must not write a failure backoff'),
    preserveLastGood: async () => assert.fail('success must not extend stale rows'),
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
  assert.deepEqual(Object.keys(result).sort(), ['AF', 'SD', 'UA']);
  assert.equal(
    result.AF.summary.conflictEventsTotal,
    11,
    'an HRP country with no national row must publish from the subnational sweep',
  );
});

test('HAPI ingestion keeps the per-country fallback for targets neither sweep covers', async () => {
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
  assert.deepEqual(Object.keys(result).sort(), ['SD', 'UA']);
  assert.equal(result.SD.summary.conflictEventsTotal, 12);
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
  assert.deepEqual(Object.keys(result).sort(), ['IR', 'SD', 'UA'], 'countries already covered must still publish');
  assert.equal(backoff.reasonCode, 'HAPI_FALLBACK_BUDGET_EXHAUSTED');
  assert.equal(backoff.status, 0, 'a budget cut has no provider status to record');
  assert.equal(backoff.retryAt, NOW + HAPI_FAILURE_BACKOFF_MS);
  assert.equal(preserved, 1, 'partial coverage must preserve last-good rather than pass as complete');
});

test('the HDX snapshot fallback serves the subnational sweep instead of returning nothing', async () => {
  // fetchRowsFromSnapshot filters on row.admin_level, so a bot-blocked run must
  // still hand the admin-2 sweep its rows out of the ONE memoized download.
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
    writeFailureBackoff: async () => assert.fail('successful snapshot recovery must not back off'),
    writeFailureMeta: async () => assert.fail('successful snapshot recovery must not publish SEED_ERROR'),
    preserveLastGood: async () => assert.fail('successful snapshot recovery must not preserve stale rows'),
    snapshotFetchFn: async (input) => {
      snapshotCalls += 1;
      return String(input).includes('/api/3/action/package_show')
        ? Response.json(hapiHdxMetadata())
        : new Response(csv, { headers: { 'Content-Type': 'text/csv' } });
    },
    fetchFn: async () => {
      directCalls += 1;
      return new Response('Blocked due to bot activity.', { status: 406 });
    },
  });

  assert.equal(directCalls, 1, 'the subnational sweep must reuse the snapshot, not re-hit the blocked API');
  assert.equal(snapshotCalls, 2, 'one metadata plus one CSV download serves both sweeps');
  assert.deepEqual(Object.keys(result).sort(), ['AF', 'SD']);
  assert.equal(result.SD.summary.conflictEventsTotal, 12);
  assert.equal(
    result.AF.summary.conflictEventsTotal,
    11,
    'admin-2 rows must survive the snapshot admin_level filter',
  );
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
  assert.deepEqual(Object.keys(result), ['SD']);
  assert.equal(preserved, 1);
  assert.equal(backoff.status, 429);
  assert.equal(backoff.reasonCode, 'HAPI_RATE_LIMIT');
});

test('HAPI bot-detection rejection loads the official HDX snapshot', async () => {
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
    writeFailureBackoff: async () => assert.fail('successful snapshot recovery must not back off'),
    writeFailureMeta: async () => assert.fail('successful snapshot recovery must not publish SEED_ERROR'),
    preserveLastGood: async () => assert.fail('successful snapshot recovery must not preserve stale rows'),
    snapshotFetchFn: async (input) => {
      const url = String(input);
      snapshotUrls.push(url);
      if (url.includes('/api/3/action/package_show')) {
        return Response.json(hapiHdxMetadata());
      }
      return new Response(csv, {
        headers: { 'Content-Type': 'text/csv' },
      });
    },
    fetchFn: async () => {
      directCalls += 1;
      return new Response('Blocked due to bot activity.', { status: 406 });
    },
  });

  assert.equal(directCalls, 1);
  assert.equal(snapshotUrls.length, 2);
  assert.deepEqual(Object.keys(result), ['SD']);
  assert.equal(result.SD.summary.countryName, 'Sudan');
});

test('HAPI quota rejection backs off without loading a snapshot and publishes failure health', async () => {
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
    snapshotFetchFn: async () => assert.fail('quota/identifier 429 must not load a snapshot'),
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
  assert.equal(backoff.reasonCode, 'HAPI_HDX_SNAPSHOT_FALLBACK_FAILED');
  assert.equal(failureMeta.status, 'error');
  assert.equal(failureMeta.errorReason, 'HAPI_HDX_SNAPSHOT_FALLBACK_FAILED');
  assert.equal(failureMeta.directFailureReason, 'HAPI_BOT_BLOCK');
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

test('HAPI snapshot failure aborts the cycle without publishing a partial direct aggregate', async () => {
  const snapshotUrls = [];
  let directCalls = 0;
  let failureMeta;
  let backoff;
  let preserved = 0;
  const result = await fetchAllHumanitarianSummaries({
    now: () => NOW,
    countryCodes: ['SD', 'UA', 'IR'],
    pace: async () => assert.fail('a terminal snapshot failure must stop before pacing another fallback'),
    loadPreviousMarker: async () => ({
      updatedAt: NOW - 10 * HAPI_REFRESH_INTERVAL_MS,
      requiredCountriesCovered: 3,
    }),
    loadFailureBackoff: async () => null,
    writeFailureBackoff: async (value) => { backoff = value; },
    writeFailureMeta: async (value) => { failureMeta = value; },
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

  assert.equal(result, null, 'a terminal snapshot failure must discard the partial Sudan result');
  assert.equal(directCalls, 3, 'both global sweeps and the first missing-country request should run');
  assert.equal(snapshotUrls.length, 2, 'metadata plus one failed CSV request should run');
  assert.equal(preserved, 1);
  assert.equal(backoff.status, 503);
  assert.equal(backoff.reasonCode, 'HAPI_HDX_SNAPSHOT_FALLBACK_FAILED');
  assert.equal(backoff.retryAt, NOW + HAPI_FAILURE_BACKOFF_MS);
  assert.equal(failureMeta.status, 'error');
  assert.equal(failureMeta.errorReason, 'HAPI_HDX_SNAPSHOT_FALLBACK_FAILED');
  assert.equal(failureMeta.directFailureReason, 'HAPI_BOT_BLOCK');
  assert.equal(failureMeta.snapshotFailureReason, 'HDX_HTTP_503');
  assert.equal(failureMeta.lastSuccessAt, NOW - 10 * HAPI_REFRESH_INTERVAL_MS);
  assert.equal(failureMeta.recordCount, 3);
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
  let calls = 0;
  const fetchFn = async () => {
    calls += 1;
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  };

  const recent = await fetchAllHumanitarianSummaries({
    now: () => NOW,
    countryCodes: ['SD'],
    pace: async () => {},
    loadPreviousMarker: async () => ({ updatedAt: NOW - HAPI_REFRESH_INTERVAL_MS + 1 }),
    loadFailureBackoff: async () => null,
    fetchFn,
  });
  const blocked = await fetchAllHumanitarianSummaries({
    now: () => NOW,
    countryCodes: ['SD'],
    pace: async () => {},
    loadPreviousMarker: async () => null,
    loadFailureBackoff: async () => ({ retryAt: NOW + 1 }),
    fetchFn,
  });

  assert.equal(recent, null);
  assert.equal(blocked, null);
  assert.equal(calls, 0);
});
