// Regression coverage for the HAPI bot-block follow-up to #5554.
//
// The first repair paced 38 per-country requests at ~1 request/second, but the
// production identifier was blocked again after that still produced thousands
// of requests per day. The durable contract is:
//   - one national-level bulk request for the target countries,
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
  hapiHdxFailureReason,
  readBoundedHapiHdxText,
} from '../scripts/_conflict-hapi.mjs';

const NOW = Date.parse('2026-07-26T13:30:00Z');
const HAPI_CSV_HEADER = '\ufefflocation_code,has_hrp,in_gho,provider_admin1_name,provider_admin2_name,admin1_code,admin1_name,admin2_code,admin2_name,admin_level,event_type,events,fatalities,reference_period_start,reference_period_end,dataset_hdx_id,resource_hdx_id,warning,error';

function hapiCsv(...rows) {
  return [HAPI_CSV_HEADER, ...rows].join('\n');
}

function hapiHdxResource(year) {
  return {
    id: `resource-${year}`,
    format: 'CSV',
    name: `hdx_hapi_conflict_event_global_${year}.csv`,
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
  assert.match(
    healthSource,
    /humanitarianSummary:\s*\{[^}]*maxStaleMin:\s*300,\s*minRecordCount:\s*23\s*\}/,
  );
  assert.match(
    seedSource,
    /const requiredCountriesCovered = HAPI_REQUIRED_COUNTRIES\.filter\([^;]+/,
  );
  assert.match(
    seedSource,
    /HAPI_SEED_META_TTL_SECONDS,\s*requiredCountriesCovered,\s*HAPI_SEED_META_KEY/,
  );
  assert.equal(HAPI_REQUIRED_COUNTRIES.length, 23);
  assert.equal(new URL(HAPI_HDX_PACKAGE_URL).hostname, 'data.humdata.org');
  assert.doesNotMatch(seedSource, /HAPI_PROXY_URL/);
  assert.deepEqual(
    new Set(HAPI_REQUIRED_COUNTRIES),
    new Set([
      'US', 'RU', 'CN', 'UA', 'IR', 'IL', 'TW', 'KP', 'SA', 'TR',
      'PL', 'DE', 'FR', 'GB', 'IN', 'PK', 'SY', 'YE', 'MM', 'VE',
      'SD', 'DJ', 'ER',
    ]),
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

test('HAPI ingestion makes one bulk request and maps all returned target countries', async () => {
  const calls = [];
  const result = await fetchAllHumanitarianSummaries({
    now: () => NOW,
    countryCodes: ['SD', 'UA'],
    pace: async () => {},
    loadPreviousMarker: async () => null,
    loadFailureBackoff: async () => null,
    writeFailureBackoff: async () => assert.fail('success must not write a failure backoff'),
    preserveLastGood: async () => assert.fail('success must not extend stale rows'),
    fetchFn: async (url, options) => {
      calls.push({ url: String(url), options });
      return new Response(JSON.stringify({
        data: [
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
            location_code: 'UKR',
            location_name: 'Ukraine',
            reference_period_start: '2026-07-01',
            admin_level: 0,
            event_type: 'demonstration',
            events: 8,
            fatalities: 0,
          },
        ],
      }), { status: 200 });
    },
  });

  assert.equal(calls.length, 1, 'one bulk request replaces the 38-request per-country sweep');
  assert.ok(calls[0].options.headers['X-HDX-HAPI-APP-IDENTIFIER']);
  assert.deepEqual(Object.keys(result).sort(), ['SD', 'UA']);
});

test('HAPI ingestion falls back only for targets missing national rows', async () => {
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
      const data = parsed.searchParams.get('location_code') === 'SDN'
        ? [{
            location_code: 'SDN',
            location_name: 'Sudan',
            reference_period_start: '2026-07-01',
            admin_level: 2,
            event_type: 'political_violence',
            events: 12,
            fatalities: 3,
          }]
        : [{
            location_code: 'UKR',
            location_name: 'Ukraine',
            reference_period_start: '2026-07-01',
            admin_level: 0,
            event_type: 'demonstration',
            events: 8,
            fatalities: 0,
          }];
      return new Response(JSON.stringify({ data }), { status: 200 });
    },
  });

  assert.equal(urls.length, 2);
  assert.equal(urls[0].searchParams.get('admin_level'), '0');
  assert.equal(urls[0].searchParams.has('location_code'), false);
  assert.equal(urls[1].searchParams.has('admin_level'), false);
  assert.equal(urls[1].searchParams.get('location_code'), 'SDN');
  assert.deepEqual(Object.keys(result).sort(), ['SD', 'UA']);
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
          data: [{
            location_code: 'SDN',
            location_name: 'Sudan',
            reference_period_start: '2026-07-01',
            admin_level: 0,
            event_type: 'political_violence',
            events: 12,
            fatalities: 3,
          }],
        });
      }
      assert.equal(url.searchParams.get('location_code'), 'UKR');
      return new Response('Blocked due to bot activity.', { status: 429 });
    },
  });

  assert.equal(result, null, 'a terminal snapshot failure must discard the partial Sudan result');
  assert.equal(directCalls, 2, 'the initial sweep and first missing-country request should run');
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
