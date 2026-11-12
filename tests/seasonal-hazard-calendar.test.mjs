// Seasonal hazard calendar (#10511): the aggregation that builds it and the
// shape of the committed file the travel risk assessment reads.

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';

import { aggregateSeasonalCalendar, fetchPage, fetchGdacsEvents, GDACS_HAZARDS } from '../scripts/build-seasonal-hazard-calendar.mjs';

const WINDOWS = { TC: { fromYear: 2011, toYear: 2025 }, FL: { fromYear: 2019, toYear: 2025 } };
const event = (type, eventId, fromDate, countries) => ({ type, eventId, fromDate, countries });

describe('aggregateSeasonalCalendar', () => {
  it('counts distinct years with an event starting in the month, not events', () => {
    const calendar = aggregateSeasonalCalendar([
      event('FL', 1, '2020-09-03T00:00:00', ['TH']),
      event('FL', 2, '2020-09-20T00:00:00', ['TH']),
      event('FL', 3, '2021-09-11T00:00:00', ['TH']),
      event('FL', 4, '2021-10-01T00:00:00', ['TH']),
    ], WINDOWS);
    assert.deepEqual(calendar.TH.FL, [0, 0, 0, 0, 0, 0, 0, 0, 2, 1, 0, 0]);
  });

  it('counts an event once even when the archive returns it twice', () => {
    const calendar = aggregateSeasonalCalendar([
      event('TC', 7, '2015-08-01T00:00:00', ['PH']),
      event('TC', 7, '2015-08-01T00:00:00', ['PH']),
    ], WINDOWS);
    assert.equal(calendar.PH.TC[7], 1);
  });

  it('keeps affected countries added by a later record of the same event', () => {
    const calendar = aggregateSeasonalCalendar([
      event('TC', 7, '2015-08-01T00:00:00', []),
      event('TC', 7, '2015-08-01T00:00:00', ['PH']),
      event('TC', 7, '2015-08-01T00:00:00', ['PH', 'TW']),
    ], WINDOWS);
    assert.equal(calendar.PH.TC[7], 1);
    assert.equal(calendar.TW.TC[7], 1);
  });

  it('credits every affected country and ignores malformed country codes', () => {
    const calendar = aggregateSeasonalCalendar([event('TC', 9, '2016-10-05T00:00:00', ['PH', 'TW', 'TW', '', 'X1'])], WINDOWS);
    assert.deepEqual(Object.keys(calendar), ['PH', 'TW']);
  });

  it('applies each hazard its own window', () => {
    const calendar = aggregateSeasonalCalendar([
      event('FL', 1, '2018-06-01T00:00:00', ['TH']),
      event('FL', 2, '2026-06-01T00:00:00', ['TH']),
      event('TC', 3, '2018-06-01T00:00:00', ['TH']),
      event('EQ', 4, '2020-06-01T00:00:00', ['TH']),
    ], WINDOWS);
    assert.deepEqual(Object.keys(calendar), ['TH']);
    assert.equal(calendar.TH.FL, undefined, 'floods before 2019 and after 2025 are outside the window');
    assert.equal(calendar.TH.TC[5], 1);
    assert.equal(calendar.TH.EQ, undefined, 'only listed hazards are kept');
  });

  it('skips events with no usable start date', () => {
    assert.deepEqual(aggregateSeasonalCalendar([event('FL', 1, '', ['TH']), event('FL', 2, undefined, ['TH'])], WINDOWS), {});
  });
});

describe('fetchPage', () => {
  const reply = (status, body) => async () => new Response(body, { status });

  it('reads an empty 204 or empty 200 as an empty page', async () => {
    assert.deepEqual(await fetchPage('FL', '2019-01-01', '2019-12-31', 1, reply(204, null), 0), []);
    assert.deepEqual(await fetchPage('FL', '2019-01-01', '2019-12-31', 1, reply(200, ''), 0), []);
  });

  it('retries an empty error response and then fails instead of returning an empty page', async () => {
    let calls = 0;
    const fetchFn = async () => { calls++; return new Response('', { status: 503 }); };
    await assert.rejects(() => fetchPage('FL', '2019-01-01', '2019-12-31', 1, fetchFn, 0), /HTTP 503/);
    assert.equal(calls, 3);
  });

  it('recovers when a retry succeeds', async () => {
    let calls = 0;
    const fetchFn = async () => (++calls < 2 ? new Response('', { status: 500 }) : new Response(JSON.stringify({ features: [{ properties: {} }] }), { status: 200 }));
    assert.equal((await fetchPage('TC', '2019-01-01', '2019-12-31', 1, fetchFn, 0)).length, 1);
  });

  for (const failure of ['transport', 'body']) {
    it(`retries ${failure} failures and preserves the final error`, async () => {
      let calls = 0;
      const fetchFn = async () => {
        calls++;
        if (failure === 'transport') throw new Error('connection reset');
        return { text: async () => { throw new Error('body interrupted'); } };
      };
      await assert.rejects(() => fetchPage('FL', '2019-01-01', '2019-12-31', 1, fetchFn, 0), /GDACS archive FL.*(?:connection reset|body interrupted)/);
      assert.equal(calls, 3);
      calls = 0;
      const recover = async (...args) => calls < 2 ? fetchFn(...args) : new Response('{"features":[]}', { status: 200 });
      assert.deepEqual(await fetchPage('FL', '2019-01-01', '2019-12-31', 1, recover, 0), []);
      assert.equal(calls, 2);
    });
  }
});

describe('fetchGdacsEvents', () => {
  const windows = { TC: { fromYear: 2025, toYear: 2025 }, FL: { fromYear: 2025, toYear: 2025 } };
  const features = Array.from({ length: 100 }, (_, eventid) => ({ properties: { eventid, fromdate: '2025-09-01', affectedcountries: [{ iso2: 'TH' }] } }));

  it('rejects a full final page rather than returning truncated history', async () => {
    let calls = 0;
    const fetchFn = async () => { calls++; return Response.json({ features }); };
    await assert.rejects(() => fetchGdacsEvents(windows, fetchFn), /TC 2025: pagination limit reached/);
    assert.equal(calls, 40);
  });

  it('completes each hazard-year only after a short page', async () => {
    const fetchFn = async (url) => Response.json({ features: url.searchParams.get('pagenumber') === '1' ? features : [] });
    const result = await fetchGdacsEvents(windows, fetchFn);
    assert.deepEqual(result.perYear, { 'TC:2025': 100, 'FL:2025': 100 });
    assert.equal(result.events.length, 200);
  });
});

describe('committed calendar', () => {
  const calendar = JSON.parse(readFileSync(new URL('../shared/seasonal-hazard-calendar.json', import.meta.url), 'utf8'));

  it('names its source, method, hazards and window for each hazard', () => {
    assert.match(calendar.source, /GDACS/);
    assert.match(calendar.method, /not a forecast/);
    assert.match(calendar.generatedAt, /^\d{4}-\d{2}-\d{2}$/);
    assert.deepEqual(Object.keys(calendar.hazards).sort(), [...GDACS_HAZARDS].sort());
    for (const code of GDACS_HAZARDS) assert.ok(calendar.windows[code].toYear >= calendar.windows[code].fromYear, code);
  });

  it('holds twelve whole-number month counts per country and hazard, none above the window length', () => {
    const countries = Object.entries(calendar.countries);
    assert.ok(countries.length > 100, `only ${countries.length} countries`);
    for (const [country, hazards] of countries) {
      assert.match(country, /^[A-Z]{2}$/);
      for (const [code, counts] of Object.entries(hazards)) {
        const window = calendar.windows[code];
        assert.ok(window, `${country} ${code}`);
        assert.equal(counts.length, 12, `${country} ${code}`);
        const years = window.toYear - window.fromYear + 1;
        for (const count of counts) assert.ok(Number.isInteger(count) && count >= 0 && count <= years, `${country} ${code} ${count}`);
      }
    }
  });

  it('shows the known seasons: Atlantic and Pacific cyclone peaks and a monsoon flood season', () => {
    const peak = (counts) => counts.indexOf(Math.max(...counts)) + 1;
    assert.ok([8, 9].includes(peak(calendar.countries.JP.TC)), 'Japan typhoon peak is August or September');
    assert.ok(peak(calendar.countries.US.TC) >= 8 && peak(calendar.countries.US.TC) <= 10, 'US hurricane peak is August to October');
    assert.ok(calendar.countries.TH.FL.slice(5, 11).every((count) => count >= 3), 'Thailand floods recorded June to November');
  });
});
