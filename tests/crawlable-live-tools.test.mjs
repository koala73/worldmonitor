import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  airportDisruptionViewModel,
  chokepointStatusViewModel,
  crisisTrackerViewModel,
  hazardPulseViewModel,
  loadHazards,
  militaryFlightsViewModel,
  pointInBounds,
  requestLiveJson,
  runLatestToolRequest,
} from '../scripts/crawlable-live-tools.mjs';

const NOW = Date.UTC(2026, 6, 24, 12);

describe('crawlable live intelligence view models', () => {
  it('matches the requested chokepoint and preserves partial transit coverage', () => {
    const payload = {
      fetchedAt: new Date(NOW - 60_000).toISOString(),
      upstreamUnavailable: false,
      chokepoints: [
        { id: 'suez', disruptionScore: 8, status: 'green' },
        {
          id: 'hormuz_strait',
          disruptionScore: 72,
          status: 'red',
          congestionLevel: 'high',
          activeWarnings: 3,
          aisDisruptions: 2,
          description: 'Shipping warning activity is elevated.',
          transitSummary: {
            dataAvailable: false,
            todayTotal: 0,
          },
        },
      ],
    };

    assert.deepEqual(chokepointStatusViewModel(payload, 'hormuz_strait', NOW), {
      disruptionScore: '72',
      status: 'Red',
      congestion: 'High',
      warnings: '3 warnings · 2 AIS disruptions',
      description: 'Shipping warning activity is elevated.',
      todayTransits: null,
      weekMovement: null,
      fetchedAt: NOW - 60_000,
      partial: true,
    });
    const responsePartial = chokepointStatusViewModel({
      ...payload,
      upstreamUnavailable: true,
      chokepoints: payload.chokepoints.map((row) => row.id === 'hormuz_strait'
        ? {
            ...row,
            transitSummary: { dataAvailable: true, todayTotal: 11, wowChangePct: 2.5 },
          }
        : row),
    }, 'hormuz_strait', NOW);
    assert.equal(responsePartial.todayTransits, '11');
    assert.equal(responsePartial.weekMovement, '+2.5% vs prior week');
    assert.equal(responsePartial.partial, true);
    assert.throws(
      () => chokepointStatusViewModel({ chokepoints: [], upstreamUnavailable: true }, 'hormuz_strait', NOW),
      /not present/i,
    );
    assert.throws(
      () => chokepointStatusViewModel(payload, 'panama', NOW),
      /not present/i,
    );
    assert.throws(
      () => chokepointStatusViewModel(
        { ...payload, fetchedAt: NOW - (49 * 60 * 60 * 1_000) },
        'hormuz_strait',
        NOW,
      ),
      /stale/i,
    );
  });

  it('aggregates same-period crisis summaries and names missing coverage', () => {
    const countries = [
      { code: 'IR', name: 'Iran' },
      { code: 'IL', name: 'Israel' },
      { code: 'LB', name: 'Lebanon' },
    ];
    const results = [
      {
        code: 'IR',
        payload: {
          summary: {
            countryCode: 'IR',
            countryName: 'Iran',
            conflictEventsTotal: 12,
            conflictPoliticalViolenceEvents: 8,
            conflictFatalities: 4,
            conflictDemonstrations: 2,
            referencePeriod: '2026-06-01',
            updatedAt: NOW - 60_000,
          },
        },
      },
      {
        code: 'IL',
        payload: {
          summary: {
            countryCode: 'IL',
            countryName: 'Israel',
            conflictEventsTotal: 7,
            conflictPoliticalViolenceEvents: 5,
            conflictFatalities: 1,
            conflictDemonstrations: 1,
            referencePeriod: '2026-06-01',
            updatedAt: NOW - 120_000,
          },
        },
      },
      { code: 'LB', error: new Error('unavailable') },
    ];

    const view = crisisTrackerViewModel(results, countries, NOW);
    assert.equal(view.state, 'partial');
    assert.equal(view.eventsTotal, '19');
    assert.equal(view.fatalities, '5');
    assert.equal(view.politicalViolenceEvents, '13');
    assert.equal(view.referencePeriod, '2026-06-01');
    assert.deepEqual(view.missingCountries, ['Lebanon']);
    assert.equal(view.rows.length, 2);

    const mixed = crisisTrackerViewModel([
      results[0],
      {
        ...results[1],
        payload: {
          summary: {
            ...results[1].payload.summary,
            referencePeriod: '2026-05-01',
          },
        },
      },
    ], countries.slice(0, 2), NOW);
    assert.equal(mixed.state, 'partial');
    assert.equal(mixed.eventsTotal, null);
    assert.equal(mixed.referencePeriod, 'Mixed reference periods');
  });

  it('handles ordinary and antimeridian bounds without accepting missing coordinates', () => {
    assert.equal(pointInBounds(35, 140, [31, 129, 46, 146]), true);
    assert.equal(pointInBounds(35, 170, [31, 129, 46, 146]), false);
    assert.equal(pointInBounds(0, 179, [-10, 170, 10, -170]), true);
    assert.equal(pointInBounds(0, -179, [-10, 170, 10, -170]), true);
    assert.equal(pointInBounds(0, 0, [-10, 170, 10, -170]), false);
    assert.equal(pointInBounds(null, 140, [31, 129, 46, 146]), false);
  });

  it('distinguishes an authoritative zero hazard result from unavailable data', () => {
    const empty = hazardPulseViewModel({
      dataAvailable: true,
      fetchedAt: NOW - 60_000,
      events: [],
    }, { now: NOW });
    assert.equal(empty.total, '0');
    assert.deepEqual(empty.events, []);

    assert.throws(
      () => hazardPulseViewModel({
        dataAvailable: false,
        fetchedAt: 0,
        events: [],
      }, { now: NOW }),
      /unavailable/i,
    );

    const filtered = hazardPulseViewModel({
      dataAvailable: true,
      fetchedAt: NOW - 60_000,
      events: [
        {
          id: 'jp-quake',
          title: 'Offshore earthquake',
          category: 'earthquakes',
          categoryTitle: 'Earthquakes',
          lat: 35,
          lon: 140,
          date: NOW - 3_600_000,
          magnitude: 6.2,
          magnitudeUnit: 'Mw',
          sourceName: 'USGS',
          closed: false,
        },
        {
          id: 'old-closed',
          title: 'Closed storm',
          category: 'severeStorms',
          categoryTitle: 'Severe Storms',
          lat: 34,
          lon: 139,
          date: NOW - 7_200_000,
          sourceName: 'GDACS',
          closed: true,
        },
        {
          id: 'outside',
          title: 'Distant volcano',
          category: 'volcanoes',
          categoryTitle: 'Volcanoes',
          lat: 0,
          lon: 0,
          date: NOW - 1_800_000,
          sourceName: 'EONET',
          closed: false,
        },
      ],
    }, { now: NOW, bounds: [31, 129, 46, 146] });
    assert.equal(filtered.total, '1');
    assert.equal(filtered.categories, 'Earthquakes 1');
    assert.equal(filtered.strongest, '6.2 Mw');
    assert.equal(filtered.events[0].source, 'USGS');

    assert.throws(
      () => hazardPulseViewModel({
        dataAvailable: true,
        fetchedAt: NOW - 60_000,
        events: [{ id: 'malformed', closed: false, lat: null, lon: 140, date: NOW - 60_000 }],
      }, { now: NOW }),
      /observations are malformed/i,
    );

    const boundedZero = hazardPulseViewModel({
      dataAvailable: true,
      fetchedAt: NOW - 60_000,
      events: [{ id: 'outside-stale', closed: false, lat: 0, lon: 0, date: 0 }],
    }, { now: NOW, bounds: [31, 129, 46, 146] });
    assert.equal(boundedZero.total, '0');

    const mixedUnits = hazardPulseViewModel({
      dataAvailable: true,
      fetchedAt: NOW - 60_000,
      events: [
        {
          id: 'quake',
          title: 'Earthquake',
          categoryTitle: 'Earthquakes',
          lat: 35,
          lon: 140,
          date: NOW - 60_000,
          magnitude: 6.2,
          magnitudeUnit: 'Mw',
          sourceName: 'USGS',
        },
        {
          id: 'storm',
          title: 'Storm',
          categoryTitle: 'Severe Storms',
          lat: 34,
          lon: 139,
          date: NOW - 120_000,
          magnitude: 80,
          magnitudeUnit: 'kt',
          sourceName: 'NHC',
        },
      ],
    }, { now: NOW });
    assert.equal(mixedUnits.strongest, 'Mixed units — see events');
  });

  it('keeps unknown airport coverage separate from disruption', () => {
    const view = airportDisruptionViewModel({
      alerts: [
        {
          iata: 'NRT',
          name: 'Narita',
          location: { latitude: 35.77, longitude: 140.39 },
          severity: 'FLIGHT_DELAY_SEVERITY_MAJOR',
          avgDelayMinutes: 55,
          reason: 'Weather',
          source: 'FLIGHT_DELAY_SOURCE_AVIATIONSTACK',
          updatedAt: NOW - 60_000,
        },
        {
          iata: 'HND',
          name: 'Haneda',
          location: { latitude: 35.55, longitude: 139.78 },
          severity: 'FLIGHT_DELAY_SEVERITY_UNKNOWN',
          source: 'FLIGHT_DELAY_SOURCE_UNSPECIFIED',
          updatedAt: NOW - 60_000,
        },
        {
          iata: 'KIX',
          name: 'Kansai',
          location: { latitude: 34.43, longitude: 135.24 },
          severity: 'FLIGHT_DELAY_SEVERITY_NORMAL',
          source: 'FLIGHT_DELAY_SOURCE_AVIATIONSTACK',
          updatedAt: NOW - 60_000,
        },
        {
          iata: 'NGO',
          name: 'Chubu Centrair',
          location: { latitude: 34.86, longitude: 136.81 },
          severity: 'FLIGHT_DELAY_SEVERITY_FUTURE_VALUE',
          source: 'FLIGHT_DELAY_SOURCE_UNSPECIFIED',
          updatedAt: NOW - 60_000,
        },
      ],
    }, [31, 129, 46, 146], NOW);

    assert.equal(view.monitored, '4');
    assert.equal(view.disrupted, '1');
    assert.equal(view.normal, '1');
    assert.equal(view.unknown, '2');
    assert.equal(view.alerts[0].iata, 'NRT');

    assert.throws(
      () => airportDisruptionViewModel({
        alerts: [{
          iata: 'NRT',
          name: 'Narita',
          location: { latitude: 35.77, longitude: 140.39 },
          severity: 'FLIGHT_DELAY_SEVERITY_MAJOR',
          avgDelayMinutes: 55,
          source: 'FLIGHT_DELAY_SOURCE_AVIATIONSTACK',
          updatedAt: NOW - (25 * 60 * 60 * 1_000),
        }],
      }, [31, 129, 46, 146], NOW),
      /coverage is unavailable/i,
    );

    assert.throws(
      () => airportDisruptionViewModel({
        alerts: [
          {
            iata: 'NRT',
            name: 'Narita',
            location: { latitude: 35.77, longitude: 140.39 },
            severity: 'FLIGHT_DELAY_SEVERITY_MAJOR',
            updatedAt: NOW - (25 * 60 * 60 * 1_000),
          },
          {
            iata: 'LAX',
            name: 'Los Angeles',
            location: { latitude: 33.94, longitude: -118.4 },
            severity: 'FLIGHT_DELAY_SEVERITY_NORMAL',
            updatedAt: NOW - 60_000,
          },
        ],
      }, [31, 129, 46, 146], NOW),
      /coverage is unavailable/i,
      'fresh observations outside the selected bounds must not validate stale in-bounds coverage',
    );
  });

  it('treats an empty military response as unavailable and labels returned observations', () => {
    assert.throws(
      () => militaryFlightsViewModel({ flights: [] }, NOW),
      /unavailable/i,
    );

    const view = militaryFlightsViewModel({
      flights: [
        {
          id: 'A1',
          callsign: 'RCH123',
          aircraftType: 'MILITARY_AIRCRAFT_TYPE_TRANSPORT',
          operator: 'MILITARY_OPERATOR_USAF',
          lastSeenAt: NOW - 60_000,
          isInteresting: false,
        },
        {
          id: 'A2',
          callsign: 'FORTE10',
          aircraftType: 'MILITARY_AIRCRAFT_TYPE_RECONNAISSANCE',
          operator: 'MILITARY_OPERATOR_USAF',
          lastSeenAt: NOW - 30_000,
          isInteresting: true,
        },
      ],
    }, NOW);

    assert.equal(view.returned, '2');
    assert.equal(view.interesting, '1');
    assert.equal(view.latestSeenAt, NOW - 30_000);
    assert.equal(view.flights[0].aircraftType, 'Reconnaissance');
  });

  it('mints an anonymous session after a 401 and retries the original request once', async () => {
    const calls = [];
    const responses = [
      { ok: false, status: 401 },
      { ok: true, status: 200 },
      { ok: true, status: 200, json: async () => ({ value: 42 }) },
    ];
    const fetchImpl = async (url, options) => {
      calls.push({ url, method: options.method || 'GET', credentials: options.credentials });
      return responses.shift();
    };

    const payload = await requestLiveJson('/api/example', { fetchImpl });
    assert.deepEqual(payload, { value: 42 });
    assert.deepEqual(calls, [
      { url: '/api/example', method: 'GET', credentials: 'include' },
      { url: '/api/wm-session', method: 'POST', credentials: 'include' },
      { url: '/api/example', method: 'GET', credentials: 'include' },
    ]);
  });

  it('aborts a live request at the configured request bound', async () => {
    const fetchImpl = async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('request aborted')), {
        once: true,
      });
    });

    await assert.rejects(
      requestLiveJson('/api/slow', { fetchImpl, timeoutMs: 10 }),
      /timed out/i,
    );
  });

  it('keeps the request bound active while decoding the response body', async () => {
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      json: async () => new Promise((resolve) => {
        setTimeout(() => resolve({ tooLate: true }), 50);
      }),
    });

    await assert.rejects(
      requestLiveJson('/api/slow-body', { fetchImpl, timeoutMs: 10 }),
      /timed out/i,
    );
  });

  it('keeps the latest hazard handoff when its live request fails', async () => {
    const select = {
      value: 'JP',
      selectedOptions: [{ dataset: { bounds: '31,129,46,146' } }],
    };
    const dashboardLink = { href: '/?country=NO&expanded=1' };
    const tool = {
      dataset: {},
      querySelector(selector) {
        if (selector === '[data-country-select]') return select;
        return null;
      },
      querySelectorAll() {
        return [];
      },
      ownerDocument: {
        querySelector(selector) {
          return selector === '[data-dashboard-link]' ? dashboardLink : null;
        },
      },
    };
    const replacedUrls = [];
    const originalFetch = globalThis.fetch;
    const originalWindow = globalThis.window;
    globalThis.window = {
      location: { href: 'https://www.worldmonitor.app/tools/natural-hazard-pulse/?country=NO' },
      history: {
        replaceState(_state, _title, url) {
          replacedUrls.push(url);
        },
      },
    };
    globalThis.fetch = async () => {
      throw new Error('offline');
    };

    try {
      await loadHazards(tool);
      assert.deepEqual(replacedUrls, ['/tools/natural-hazard-pulse/?country=JP']);
      assert.equal(dashboardLink.href, '/?country=JP&expanded=1&utm_source=seo-tool');
    } finally {
      globalThis.fetch = originalFetch;
      if (originalWindow === undefined) delete globalThis.window;
      else globalThis.window = originalWindow;
    }
  });

  it('commits counters, URL, and dashboard link only for the latest request', async () => {
    const tool = {};
    const rendered = {
      counter: null,
      url: null,
      dashboardLink: null,
    };
    let resolveFirst;

    const first = runLatestToolRequest(
      tool,
      () => new Promise((resolve) => {
        resolveFirst = resolve;
      }),
      (value) => Object.assign(rendered, value),
    );
    const second = runLatestToolRequest(
      tool,
      async () => ({
        counter: 2,
        url: '/tools/natural-hazard-pulse/?country=JP',
        dashboardLink: '/?country=JP&expanded=1',
      }),
      (value) => Object.assign(rendered, value),
    );

    await second;
    resolveFirst({
      counter: 99,
      url: '/tools/natural-hazard-pulse/?country=US',
      dashboardLink: '/?country=US&expanded=1',
    });
    await first;

    assert.deepEqual(rendered, {
      counter: 2,
      url: '/tools/natural-hazard-pulse/?country=JP',
      dashboardLink: '/?country=JP&expanded=1',
    });
  });
});
