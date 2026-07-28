// Regression coverage for the HAPI bot-block follow-up to #5554.
//
// The first repair paced 38 per-country requests at ~1 request/second, but the
// production identifier was blocked again after that still produced thousands
// of requests per day. The durable contract is:
//   - one national-level bulk request for the target countries,
//   - no new request while the last successful snapshot is fresh,
//   - a persisted failure backoff after a provider rejection, and
//   - last-known-good Redis rows preserved without refreshing their fetchedAt.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  HAPI_FAILURE_BACKOFF_MS,
  HAPI_REFRESH_INTERVAL_MS,
  HAPI_REQUIRED_COUNTRIES,
  aggregateHapiConflictEvents,
  buildHapiConflictEventsUrl,
  fetchAllHumanitarianSummaries,
} from '../scripts/seed-conflict-intel.mjs';

const NOW = Date.parse('2026-07-26T13:30:00Z');

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

test('HAPI provider rejection persists a backoff and preserves last-known-good rows', async () => {
  let calls = 0;
  let backoff;
  let preserved = 0;
  const result = await fetchAllHumanitarianSummaries({
    now: () => NOW,
    countryCodes: ['SD'],
    pace: async () => {},
    loadPreviousMarker: async () => null,
    loadFailureBackoff: async () => null,
    writeFailureBackoff: async (value) => { backoff = value; },
    preserveLastGood: async () => { preserved += 1; },
    fetchFn: async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: 'Blocked due to bot activity.' }), { status: 429 });
    },
  });

  assert.equal(result, null);
  assert.equal(calls, 1, 'a blocked bulk request must not fan out into per-country retries');
  assert.equal(preserved, 1);
  assert.equal(backoff.status, 429);
  assert.equal(backoff.retryAt, NOW + HAPI_FAILURE_BACKOFF_MS);
});

test('HAPI backoff records the fallback rejection status when the national sweep is empty', async () => {
  let backoff;
  let preserved = 0;
  const result = await fetchAllHumanitarianSummaries({
    now: () => NOW,
    countryCodes: ['SD'],
    pace: async () => {},
    loadPreviousMarker: async () => null,
    loadFailureBackoff: async () => null,
    writeFailureBackoff: async (value) => { backoff = value; },
    preserveLastGood: async () => { preserved += 1; },
    fetchFn: async (url) => {
      const parsed = new URL(url);
      if (!parsed.searchParams.has('location_code')) {
        // National admin-0 sweep covers nothing for this target country.
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      // Bounded per-country fallback is the one that gets throttled.
      return new Response(JSON.stringify({ error: 'Blocked due to bot activity.' }), { status: 429 });
    },
  });

  assert.equal(result, null);
  assert.equal(preserved, 1);
  assert.equal(backoff.status, 429, 'must record the fallback rejection status, not fall back to 0');
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
