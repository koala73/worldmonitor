/**
 * GetCountryCoverage (#7526) — the rules an agent consumer depends on.
 *
 * These tests pin the behaviours the issue's acceptance criteria name:
 * country-name collisions, event expiry, duplicate clustering, refresh, and
 * source failure. Every one of them is a rule the country PANEL owns, so a
 * failure here means the agent surface has drifted from the UI.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  getCountryCoverage,
  resolveCountryName,
  type CountryCoverageDependencies,
} from '../server/worldmonitor/intelligence/v1/get-country-coverage.ts';
import {
  collectStructuredIncidents,
  type StructuredDependencies,
  type StructuredSourceResult,
} from '../server/worldmonitor/intelligence/v1/_country-coverage-structured.ts';
import { countryBox, inBox } from '../shared/country-bbox.ts';
import {
  buildEventQueryTerms,
  countryEventFeed,
  countryHeadlineFeed,
  fetchCountryCoverageFeeds,
  splitGoogleNewsTitle,
  type CoverageFetch,
} from '../server/worldmonitor/intelligence/v1/_country-coverage-feeds.ts';
import * as feedDigest from '../server/worldmonitor/news/v1/list-feed-digest.ts';
import { isCountryHeadline } from '../shared/country-headline-match.ts';
import { classifyByKeyword } from '../shared/threat-keyword-classifier.ts';
import type { CountryTimelineIncident } from '../shared/country-timeline-events.ts';
import type {
  GetCountryCoverageRequest,
  GetCountryCoverageResponse,
  ServerContext,
} from '../src/generated/server/worldmonitor/intelligence/v1/service_server.ts';
import { ValidationError } from '../src/generated/server/worldmonitor/intelligence/v1/service_server.ts';

const NOW_MS = Date.parse('2026-09-07T12:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const ctx = {
  request: new Request('https://worldmonitor.app/api/intelligence/v1/get-country-coverage'),
  pathParams: {},
  headers: {},
} as ServerContext;

function emptyParse() {
  return { items: [], parsedTotal: 0, droppedUndated: 0, attempt: { source: 'direct' as const, failure: null, negativeCache: false } };
}

function healthyParse(parsedTotal = 5) {
  return { items: [], parsedTotal, droppedUndated: 0, attempt: { source: 'direct' as const, failure: null, negativeCache: false } };
}

function coverage(overrides: Partial<CoverageFetch> = {}): CoverageFetch {
  return {
    headlines: [],
    incidents: [],
    headlineResult: healthyParse(),
    eventResult: healthyParse(),
    ...overrides,
  } as CoverageFetch;
}

function okSource(source: string, incidents: CountryTimelineIncident[] = []): StructuredSourceResult {
  return {
    source,
    state: incidents.length > 0 ? 'ok' : 'empty',
    detail: incidents.length > 0
      ? ''
      : 'The producer responded; nothing in it matched this country inside the window.',
    fetchedAtMs: NOW_MS - HOUR,
    incidents,
  };
}

function deps(
  overrides: {
    coverage?: CoverageFetch;
    coverageError?: Error;
    structured?: StructuredSourceResult[];
  } = {},
): CountryCoverageDependencies {
  return {
    now: () => NOW_MS,
    fetchCoverage: async () => {
      if (overrides.coverageError) throw overrides.coverageError;
      return overrides.coverage ?? coverage();
    },
    collectStructured: async () => overrides.structured ?? [],
  };
}

function request(overrides: Partial<GetCountryCoverageRequest> = {}): GetCountryCoverageRequest {
  return { countryCode: 'IL', windowHours: 0, limit: 0, ...overrides };
}

function sourceState(response: GetCountryCoverageResponse, source: string): string {
  return response.sources.find(entry => entry.source === source)?.state ?? '<missing>';
}

describe('GetCountryCoverage — request validation', () => {
  it('rejects a country code that is not ISO 3166-1 alpha-2', async () => {
    for (const countryCode of ['', 'I', 'ISR', 'il1', '**', '  ']) {
      await assert.rejects(
        () => getCountryCoverage(ctx, request({ countryCode }), deps()),
        (error: unknown) => {
          assert.ok(error instanceof ValidationError, `expected ValidationError for ${JSON.stringify(countryCode)}`);
          assert.equal(error.violations[0]?.field, 'country_code');
          return true;
        },
      );
    }
  });

  it('accepts a lowercase code and echoes it back uppercased', async () => {
    const response = await getCountryCoverage(ctx, request({ countryCode: 'il' }), deps());
    assert.equal(response.countryCode, 'IL');
    assert.equal(response.countryName, 'Israel');
  });

  it('rejects a window wider than the upstream query can honour', async () => {
    await assert.rejects(
      () => getCountryCoverage(ctx, request({ windowHours: 169 }), deps()),
      (error: unknown) => {
        assert.ok(error instanceof ValidationError);
        assert.equal(error.violations[0]?.field, 'window_hours');
        return true;
      },
    );
  });

  it('rejects a limit above the response cap', async () => {
    await assert.rejects(
      () => getCountryCoverage(ctx, request({ limit: 501 }), deps()),
      (error: unknown) => {
        assert.ok(error instanceof ValidationError);
        assert.equal(error.violations[0]?.field, 'limit');
        return true;
      },
    );
  });

  it('defaults to the 7-day window the panel renders', async () => {
    const response = await getCountryCoverage(ctx, request(), deps());
    assert.equal(response.windowHours, 168);
  });
});

describe('GetCountryCoverage — country-name collisions', () => {
  it('gives a headline to the country mentioned first, not merely mentioned', () => {
    // The panel's rule, exercised through the same shared matcher the RPC uses.
    assert.equal(isCountryHeadline('Israel strikes targets in Iran', 'Israel', 'IL'), true);
    assert.equal(isCountryHeadline('Israel strikes targets in Iran', 'Iran', 'IR'), false);
    assert.equal(isCountryHeadline('Iran retaliates against Israel', 'Iran', 'IR'), true);
    assert.equal(isCountryHeadline('Iran retaliates against Israel', 'Israel', 'IL'), false);
  });

  it('does not match the pronoun "us" as the United States', () => {
    assert.equal(isCountryHeadline('The deal brings us closer to peace', 'United States', 'US'), false);
    assert.equal(isCountryHeadline('US forces deploy to the region', 'United States', 'US'), true);
  });

  it('builds the event query from the country plus its aliases, capped at six terms', () => {
    const terms = buildEventQueryTerms('Israel', [
      'israel', 'israeli', 'gaza', 'hamas', 'hezbollah', 'netanyahu', 'idf', 'west bank',
    ]);
    // "Israel" and "israel" collapse case-insensitively, so six survive.
    assert.equal(terms.split(' OR ').length, 6);
    assert.ok(terms.startsWith('"Israel" OR '));
    assert.ok(!terms.includes('"west bank"'), 'the 7th+ term must be dropped, not appended');
  });

  it('drops terms of two characters or fewer, matching the panel', () => {
    assert.equal(buildEventQueryTerms('IQ', []), '');
    assert.equal(buildEventQueryTerms('Iraq', ['IQ']), '"Iraq"');
  });

  it('keys each country feed on its own upstream URL', () => {
    const israel = countryHeadlineFeed('Israel').url;
    const iraq = countryHeadlineFeed('Iraq').url;
    assert.notEqual(israel, iraq);
    assert.ok(israel.includes('news.google.com'));
    // The cache key downstream is the feed URL, so country and window must be
    // visible in it. This is the request-varying-values-in-the-cache-key rule.
    // URLSearchParams encodes a space as '+', so read the query back the same
    // way the fetcher will rather than decodeURIComponent-ing it.
    const query = (url: string) => new URL(url).searchParams.get('q') ?? '';
    assert.equal(query(israel), '"Israel" when:7d');
    assert.ok(query(countryEventFeed('Israel', ['israel']).url).includes('protest OR demonstration'));
    assert.ok(query(countryEventFeed('Israel', ['israel']).url).includes('when:7d'));
  });
});

describe('GetCountryCoverage — title normalization', () => {
  it('splits the Google News publisher suffix on the LAST separator', () => {
    assert.deepEqual(
      splitGoogleNewsTitle('Protests spread - and grow - across the capital - Reuters'),
      { title: 'Protests spread - and grow - across the capital', source: 'Reuters' },
    );
  });

  it('leaves a title with no publisher suffix intact', () => {
    assert.deepEqual(splitGoogleNewsTitle('Protests spread'), { title: 'Protests spread', source: '' });
  });

  it('classifies with the same keyword classifier the panel uses', () => {
    // Lane assignment depends on this category; a drift here silently rewrites
    // which lane an incident lands in.
    assert.equal(classifyByKeyword('Protests erupt in the capital').category, 'protest');
    assert.equal(classifyByKeyword('Magnitude 6.2 earthquake hits the coast').category, 'disaster');
    // The cascade tests 'strikes' (conflict) before 'earthquake' (disaster), so
    // "earthquake strikes the coast" lands in the conflict lane. That is what
    // the panel does; pinning it here means a reordering of the keyword tables
    // shows up as a lane change on this surface too, instead of silently.
    assert.equal(classifyByKeyword('M6.2 earthquake strikes the coast').category, 'conflict');
  });
});

describe('GetCountryCoverage — event expiry', () => {
  it('drops a coverage incident older than the window', async () => {
    const response = await getCountryCoverage(ctx, request(), deps({
      coverage: coverage({
        incidents: [
          { timestamp: NOW_MS - 2 * DAY, lane: 'protest', label: 'Recent protest', severity: 'medium' },
          { timestamp: NOW_MS - 9 * DAY, lane: 'protest', label: 'Old protest', severity: 'medium' },
        ],
      }),
    }));
    assert.deepEqual(response.events.map(e => e.label), ['Recent protest']);
  });

  it('drops an incident with a non-finite timestamp', async () => {
    const response = await getCountryCoverage(ctx, request(), deps({
      coverage: coverage({
        incidents: [
          { timestamp: Number.NaN, lane: 'protest', label: 'Undated protest', severity: 'medium' },
          { timestamp: NOW_MS - HOUR, lane: 'protest', label: 'Dated protest', severity: 'medium' },
        ],
      }),
    }));
    assert.deepEqual(response.events.map(e => e.label), ['Dated protest']);
  });

  it('honours a narrower requested window', async () => {
    const incidents: CountryTimelineIncident[] = [
      { timestamp: NOW_MS - 2 * HOUR, lane: 'protest', label: 'Two hours ago', severity: 'medium' },
      { timestamp: NOW_MS - 30 * HOUR, lane: 'protest', label: 'Thirty hours ago', severity: 'medium' },
    ];
    const wide = await getCountryCoverage(ctx, request(), deps({ coverage: coverage({ incidents }) }));
    assert.equal(wide.events.length, 2);

    const narrow = await getCountryCoverage(ctx, request({ windowHours: 24 }), deps({ coverage: coverage({ incidents }) }));
    assert.deepEqual(narrow.events.map(e => e.label), ['Two hours ago']);
    assert.equal(narrow.windowHours, 24);
  });

  it('an EXPIRED structured event cannot hide a visible coverage event', async () => {
    // The precedence rule drops a coverage reprint when a structured record
    // describes the same same-lane incident. If the structured record has
    // expired out of the window it is no longer visible, so it must not
    // suppress anything — otherwise the timeline silently loses the incident.
    const label = 'Mass protest fills the central square';
    const response = await getCountryCoverage(ctx, request(), deps({
      coverage: coverage({
        incidents: [{ timestamp: NOW_MS - 2 * HOUR, lane: 'protest', label, severity: 'medium' }],
      }),
      structured: [okSource('structured:protests', [
        { timestamp: NOW_MS - 30 * DAY, lane: 'protest', label, severity: 'high' },
      ])],
    }));
    assert.equal(response.events.length, 1, 'the visible coverage event must survive');
    assert.equal(response.events[0]?.label, label);
    assert.equal(response.events[0]?.origin, 'coverage');
  });

  it('a VISIBLE structured event does take precedence over its coverage reprint', async () => {
    const label = 'Mass protest fills the central square';
    const response = await getCountryCoverage(ctx, request(), deps({
      coverage: coverage({
        incidents: [{ timestamp: NOW_MS - 2 * HOUR, lane: 'protest', label, severity: 'medium' }],
      }),
      structured: [okSource('structured:protests', [
        { timestamp: NOW_MS - 3 * HOUR, lane: 'protest', label, severity: 'high' },
      ])],
    }));
    assert.equal(response.events.length, 1, 'one incident, not two');
    assert.equal(response.events[0]?.origin, 'structured');
    assert.equal(response.events[0]?.source, 'structured:protests');
  });
});

describe('GetCountryCoverage — duplicate clustering', () => {
  it('collapses several outlets reporting one incident into one entry', async () => {
    const base = NOW_MS - 4 * HOUR;
    const response = await getCountryCoverage(ctx, request(), deps({
      coverage: coverage({
        incidents: [
          { timestamp: base, lane: 'protest', label: 'Thousands protest fuel prices in the capital', severity: 'medium' },
          { timestamp: base + 20 * 60_000, lane: 'protest', label: 'Thousands protest fuel prices in the capital', severity: 'high' },
          { timestamp: base + 90 * 60_000, lane: 'protest', label: 'Thousands protest fuel prices in the capital', severity: 'low' },
        ],
      }),
    }));
    assert.equal(response.events.length, 1, 'one incident reported three times is one entry');
    // The cluster keeps the earliest timestamp and the most severe member.
    assert.equal(response.events[0]?.timestampMs, base);
    assert.equal(response.events[0]?.severity, 'high');
  });

  it('keeps genuinely different incidents in the same lane apart', async () => {
    const response = await getCountryCoverage(ctx, request(), deps({
      coverage: coverage({
        incidents: [
          { timestamp: NOW_MS - 4 * HOUR, lane: 'protest', label: 'Thousands protest fuel prices in the capital', severity: 'medium' },
          { timestamp: NOW_MS - 3 * HOUR, lane: 'protest', label: 'Teachers strike over pay in the north', severity: 'medium' },
        ],
      }),
    }));
    assert.equal(response.events.length, 2);
  });

  it('does not cluster the same wording across different lanes', async () => {
    const response = await getCountryCoverage(ctx, request(), deps({
      coverage: coverage({
        incidents: [
          { timestamp: NOW_MS - 4 * HOUR, lane: 'protest', label: 'Unrest reported near the border', severity: 'medium' },
          { timestamp: NOW_MS - 4 * HOUR, lane: 'conflict', label: 'Unrest reported near the border', severity: 'medium' },
        ],
      }),
    }));
    assert.equal(response.events.length, 2);
  });

  it('returns the most recent events when the limit bites', async () => {
    const LABELS = [
      'Teachers walk out over unpaid salaries',
      'Farmers block the coastal highway',
      'Students occupy the university rectorate',
      'Dockworkers halt container loading',
      'Pensioners rally outside parliament',
    ];
    const incidents: CountryTimelineIncident[] = LABELS.map((label, i) => ({
      timestamp: NOW_MS - (LABELS.length - i) * HOUR,
      lane: 'protest',
      label,
      severity: 'low',
    }));
    const all = await getCountryCoverage(ctx, request(), deps({ coverage: coverage({ incidents }) }));
    assert.equal(all.events.length, LABELS.length, 'distinct wording must not cluster');

    const response = await getCountryCoverage(ctx, request({ limit: 3 }), deps({ coverage: coverage({ incidents }) }));
    assert.equal(response.events.length, 3);
    assert.deepEqual(
      response.events.map(e => e.timestampMs),
      [NOW_MS - 3 * HOUR, NOW_MS - 2 * HOUR, NOW_MS - HOUR],
    );
  });
});

describe('GetCountryCoverage — source status is explicit', () => {
  it('reports every producer, including the ones that contributed nothing', async () => {
    const response = await getCountryCoverage(ctx, request(), deps({
      structured: [okSource('structured:protests'), okSource('structured:earthquakes')],
    }));
    assert.deepEqual(response.sources.map(s => s.source), [
      'coverage:headlines',
      'coverage:events',
      'structured:protests',
      'structured:earthquakes',
    ]);
  });

  it('an empty event list on healthy sources is NOT degraded', async () => {
    const response = await getCountryCoverage(ctx, request(), deps({
      structured: [okSource('structured:protests')],
    }));
    assert.equal(response.events.length, 0);
    assert.equal(response.degraded, false);
    assert.equal(sourceState(response, 'coverage:events'), 'empty');
    // An empty producer still explains itself, so a caller is never left
    // guessing whether silence meant health.
    for (const source of ['coverage:headlines', 'coverage:events']) {
      const entry = response.sources.find(s => s.source === source);
      assert.ok((entry?.detail.length ?? 0) > 0, `${source} must explain its empty state`);
    }
  });

  it('a failed coverage fetch degrades the response instead of failing it', async () => {
    const response = await getCountryCoverage(ctx, request(), deps({
      coverageError: new Error('upstream refused the connection'),
      structured: [okSource('structured:protests', [
        { timestamp: NOW_MS - HOUR, lane: 'protest', label: 'Structured protest still served', severity: 'medium' },
      ])],
    }));
    assert.equal(response.degraded, true);
    assert.equal(sourceState(response, 'coverage:headlines'), 'failed');
    assert.equal(sourceState(response, 'coverage:events'), 'failed');
    assert.ok(response.sources[0]?.detail.includes('upstream refused the connection'));
    // The half that DID work is still served.
    assert.equal(response.events.length, 1);
  });

  it('surfaces a per-feed transport failure recorded by the fetcher', async () => {
    const response = await getCountryCoverage(ctx, request(), deps({
      coverage: coverage({
        eventResult: { ...emptyParse(), attempt: { source: 'relay', failure: 'per-feed-timeout', negativeCache: false } },
      } as Partial<CoverageFetch>),
    }));
    assert.equal(sourceState(response, 'coverage:events'), 'failed');
    assert.equal(sourceState(response, 'coverage:headlines'), 'empty');
    assert.equal(response.degraded, true);
  });

  it('a stale structured producer still contributes but flags the response', async () => {
    const response = await getCountryCoverage(ctx, request(), deps({
      structured: [{
        source: 'structured:protests',
        state: 'stale',
        detail: 'Snapshot is 40h old.',
        fetchedAtMs: NOW_MS - 40 * HOUR,
        incidents: [{ timestamp: NOW_MS - HOUR, lane: 'protest', label: 'Stale-sourced protest', severity: 'medium' }],
      }],
    }));
    assert.equal(response.degraded, true);
    assert.equal(response.events.length, 1);
    assert.equal(sourceState(response, 'structured:protests'), 'stale');
    assert.equal(response.sources.find(s => s.source === 'structured:protests')?.ageSeconds, 40 * 3600);
  });

  it('a permanently unavailable producer does NOT degrade the response', async () => {
    // Two producers are unavailable on every single response, so counting them
    // would pin degraded to true forever and drain the flag of meaning. The gap
    // is still reported per-source.
    const response = await getCountryCoverage(ctx, request(), deps({
      structured: [{
        source: 'structured:military-vessels',
        state: 'unavailable',
        detail: 'No server-side equivalent.',
        fetchedAtMs: 0,
        incidents: [],
      }],
    }));
    assert.equal(response.degraded, false, 'a structural gap is not a transient problem');
    const vessels = response.sources.find(s => s.source === 'structured:military-vessels');
    assert.equal(vessels?.state, 'unavailable');
    assert.equal(vessels?.fetchedAt, '');
    assert.equal(vessels?.ageSeconds, 0);
  });

  it('an unknown producer does not degrade, but still reports itself', async () => {
    // `unknown` is structural: some producers can never prove they were
    // reached, so degrading on it would pin the flag true on every response.
    // The guarantee lives in `sources`, which must still say so plainly.
    const response = await getCountryCoverage(ctx, request(), deps({
      structured: [{
        source: 'structured:conflicts',
        state: 'unknown',
        detail: 'Cannot confirm the upstream was reachable.',
        fetchedAtMs: 0,
        incidents: [],
      }],
    }));
    assert.equal(response.degraded, false);
    assert.equal(sourceState(response, 'structured:conflicts'), 'unknown');
    assert.ok(response.sources.find(s => s.source === 'structured:conflicts')?.detail.length);
  });

  it('states how structured events were tested for country containment', async () => {
    const response = await getCountryCoverage(ctx, request(), deps());
    assert.equal(response.containment, 'bbox');
  });
});

describe('GetCountryCoverage — refresh behaviour', () => {
  it('a second call over refreshed data returns the refreshed events', async () => {
    const first = await getCountryCoverage(ctx, request(), deps({
      coverage: coverage({
        incidents: [{ timestamp: NOW_MS - 5 * HOUR, lane: 'protest', label: 'First reported incident here', severity: 'low' }],
      }),
    }));
    assert.deepEqual(first.events.map(e => e.label), ['First reported incident here']);

    const second = await getCountryCoverage(ctx, request(), deps({
      coverage: coverage({
        incidents: [
          { timestamp: NOW_MS - 5 * HOUR, lane: 'protest', label: 'First reported incident here', severity: 'low' },
          { timestamp: NOW_MS - HOUR, lane: 'conflict', label: 'Newly reported clash at the crossing', severity: 'high' },
        ],
      }),
    }));
    assert.deepEqual(second.events.map(e => e.label), [
      'First reported incident here',
      'Newly reported clash at the crossing',
    ]);
    // generatedAt is the caller-visible refresh marker.
    assert.equal(second.generatedAt, new Date(NOW_MS).toISOString());
  });

  it('a structured record arriving late replaces its earlier coverage reprint', async () => {
    const label = 'Explosion reported at the northern depot';
    const before = await getCountryCoverage(ctx, request(), deps({
      coverage: coverage({ incidents: [{ timestamp: NOW_MS - 3 * HOUR, lane: 'conflict', label, severity: 'high' }] }),
    }));
    assert.equal(before.events[0]?.origin, 'coverage');

    const after = await getCountryCoverage(ctx, request(), deps({
      coverage: coverage({ incidents: [{ timestamp: NOW_MS - 3 * HOUR, lane: 'conflict', label, severity: 'high' }] }),
      structured: [okSource('structured:conflicts', [
        { timestamp: NOW_MS - 3 * HOUR, lane: 'conflict', label, severity: 'critical' },
      ])],
    }));
    assert.equal(after.events.length, 1);
    assert.equal(after.events[0]?.origin, 'structured');
    assert.equal(after.events[0]?.severity, 'critical');
  });
});

describe('GetCountryCoverage — geographic containment', () => {
  it('contains Russia on both sides of the dateline without matching western Europe or North America', () => {
    const box = countryBox('RU');
    for (const [lat, lon] of [[55.75, 37.62], [65, 179], [65, -175]]) {
      assert.equal(inBox(box, lat, lon), true, `${lat},${lon} belongs in Russia's bounds`);
    }
    for (const [lat, lon] of [[52.52, 13.4], [48.86, 2.35], [51.51, -0.13], [43.65, -79.38], [47.61, -122.33]]) {
      assert.equal(inBox(box, lat, lon), false, `${lat},${lon} must not match Russia`);
    }
  });

  it('rejects collapsed country boxes and invalid geographic coordinates', () => {
    assert.equal(inBox({ south: 41.21, west: -180, north: 81.29, east: 180 }, 52.52, 13.4), false);
    assert.equal(inBox({ south: 60, west: 170, north: 70, east: -170 }, 65, 540), false);
    assert.equal(inBox(countryBox('AQ'), -75, 0), true, 'full-longitude polar containment remains valid');
    assert.equal(inBox(countryBox('AQ'), -75, 175), true);
  });

  it('reads the shared bounding box as [south, west, north, east]', () => {
    const box = countryBox('IL');
    assert.ok(box, 'Israel must have a bounding box');
    assert.ok(box!.south < box!.north, 'south must be below north');
    assert.ok(box!.west < box!.east, 'west must be left of east');
  });

  it('accepts a point inside the box and rejects one outside', () => {
    const box = countryBox('IL');
    assert.equal(inBox(box, 31.78, 35.22), true, 'Jerusalem is inside Israel’s box');
    assert.equal(inBox(box, 55.75, 37.62), false, 'Moscow is not');
  });

  it('rejects a point with a missing or non-finite coordinate', () => {
    const box = countryBox('IL');
    assert.equal(inBox(box, undefined, 35.22), false);
    assert.equal(inBox(box, 31.78, Number.NaN), false);
    assert.equal(inBox(null, 31.78, 35.22), false);
  });
});

describe('GetCountryCoverage — country naming', () => {
  it('prefers the curated tier-1 name over the ICU display name', () => {
    assert.equal(resolveCountryName('RU'), 'Russia');
    assert.equal(resolveCountryName('US'), 'United States');
  });

  it('falls back to the ICU display name, then to the code itself', () => {
    assert.equal(resolveCountryName('PT'), 'Portugal');
    assert.equal(resolveCountryName('ZZ'), 'ZZ');
  });
});


describe('collectStructuredIncidents — producer status', () => {
  const ISRAEL = { lat: 31.78, lon: 35.22 };

  function flight(callsign: string) {
    return {
      id: callsign,
      callsign,
      hexCode: '',
      registration: '',
      aircraftType: 'MILITARY_AIRCRAFT_TYPE_TRANSPORT',
      aircraftModel: 'C-17',
      operator: 'MILITARY_OPERATOR_UNSPECIFIED',
      operatorCountry: 'US',
      location: { latitude: ISRAEL.lat, longitude: ISRAEL.lon },
      altitude: 0,
      heading: 0,
      speed: 0,
      verticalRate: 0,
      onGround: false,
      squawk: '',
      origin: '',
      destination: '',
      lastSeenAt: NOW_MS - HOUR,
      firstSeenAt: NOW_MS - 2 * HOUR,
      confidence: 'MILITARY_CONFIDENCE_HIGH',
      isInteresting: true,
      note: '',
    };
  }

  function structuredDeps(overrides: Partial<StructuredDependencies> = {}): StructuredDependencies {
    return {
      listUnrestEvents: async () => ({ events: [], clusters: [], pagination: undefined }),
      listEarthquakes: async () => ({ earthquakes: [], pagination: undefined }),
      listAcledEvents: async () => ({ events: [], pagination: undefined }),
      // The retired default: the handler returns the '0' sentinel when
      // IRAN_EVENTS_ENABLED is off.
      listIranEvents: async () => ({ events: [], scrapedAt: '0' }),
      listMilitaryFlights: async () => ({ flights: [], clusters: [], pagination: undefined }),
      readSeed: async () => ({ status: 'hit' as const, fetchedAtMs: NOW_MS - HOUR }),
      ...overrides,
    } as StructuredDependencies;
  }

  async function collect(overrides: Partial<StructuredDependencies> = {}) {
    return collectStructuredIncidents({
      ctx,
      code: 'IL',
      countryName: 'Israel',
      cutoffMs: NOW_MS - 7 * DAY,
      now: NOW_MS,
      deps: structuredDeps(overrides),
    });
  }

  function find(results: StructuredSourceResult[], source: string): StructuredSourceResult {
    const match = results.find(r => r.source === source);
    assert.ok(match, `expected a ${source} producer`);
    return match!;
  }

  it('keeps Russian incidents across the dateline and rejects foreign attribution in every geographic lane', async () => {
    const points = [
      { name: 'Moscow', country: 'RU', lat: 55.75, lon: 37.62 },
      { name: 'Chukotka east', country: '', lat: 65, lon: 179 },
      { name: 'Chukotka west', country: '', lat: 65, lon: -175 },
      { name: 'Berlin', country: 'Germany', lat: 52.52, lon: 13.4 },
      { name: 'Toronto', country: 'Canada', lat: 43.65, lon: -79.38 },
    ];
    const namedProtests = [...points, { name: 'Kazakhstan labelled', country: 'Kazakhstan', lat: 55, lon: 70 }];
    const queries: { swLon: number; neLon: number; cursor: string }[] = [];
    const results = await collectStructuredIncidents({
      ctx, code: 'RU', countryName: 'Russia', cutoffMs: NOW_MS - DAY, now: NOW_MS,
      deps: structuredDeps({
        listUnrestEvents: async () => ({ events: namedProtests.map(p => ({
          id: p.name, title: p.name, country: p.country, occurredAt: NOW_MS - HOUR,
          severity: 'SEVERITY_LEVEL_HIGH', location: { latitude: p.lat, longitude: p.lon },
        })) }),
        listEarthquakes: async () => ({ earthquakes: points.map(p => ({
          id: p.name, place: p.name, magnitude: 5, occurredAt: NOW_MS - HOUR,
          location: { latitude: p.lat, longitude: p.lon },
        })) }),
        listIranEvents: async () => ({ scrapedAt: String(NOW_MS), events: points.map(p => ({
          id: p.name, title: p.name, latitude: p.lat, longitude: p.lon,
          timestamp: String(NOW_MS - HOUR), severity: 'high',
        })) }),
        listMilitaryFlights: async (_ctx, req) => {
          queries.push(req);
          assert.ok(req.swLon <= req.neLon && req.neLon - req.swLon < 360, 'only ordinary bounded queries reach flights');
          const matches = points.filter(p => p.lon >= req.swLon && p.lon <= req.neLon);
          const page = req.cursor ? matches.slice(1) : matches.slice(0, 1);
          return {
            flights: page.map(p => ({ ...flight(p.name), location: { latitude: p.lat, longitude: p.lon } })),
            clusters: [], pagination: { nextCursor: !req.cursor && matches.length > 1 ? 'page2' : '', totalCount: matches.length },
          };
        },
      } as Partial<StructuredDependencies>),
    });
    for (const source of ['structured:protests', 'structured:earthquakes', 'structured:strikes', 'structured:military-flights']) {
      const result = find(results, source);
      assert.equal(result.state, 'ok');
      assert.equal(result.incidents.length, 3, source);
      assert.ok(result.incidents.every(i => !/Berlin|Toronto|Kazakhstan/.test(i.label)), source);
    }
    assert.deepEqual(queries.map(q => [q.swLon, q.neLon, q.cursor]), [
      [19.6, 180, ''], [19.6, 180, 'page2'], [-180, -169.7, ''],
    ]);
  });

  it('reports a split flight query failure and never queries full-longitude countries', async () => {
    const ru = await collectStructuredIncidents({
      ctx, code: 'RU', countryName: 'Russia', cutoffMs: NOW_MS - DAY, now: NOW_MS,
      deps: structuredDeps({ listMilitaryFlights: async (_ctx, req) => {
        if (req.swLon < 0) throw new Error('east-of-dateline query failed');
        return { flights: [{ ...flight('MOSCOW'), location: { latitude: 55.75, longitude: 37.62 } }], clusters: [] };
      } } as Partial<StructuredDependencies>),
    });
    assert.equal(find(ru, 'structured:military-flights').state, 'failed');
    assert.deepEqual(find(ru, 'structured:military-flights').incidents, []);
    let calls = 0;
    const aq = await collectStructuredIncidents({
      ctx, code: 'AQ', countryName: 'Antarctica', cutoffMs: NOW_MS - DAY, now: NOW_MS,
      deps: structuredDeps({
        listMilitaryFlights: async () => { calls++; throw new Error('must not call'); },
        listEarthquakes: async () => ({ earthquakes: [{
          id: 'polar-quake', place: 'Southern Ocean', magnitude: 5, occurredAt: NOW_MS - HOUR,
          location: { latitude: -75, longitude: 175 },
        }] }),
      } as Partial<StructuredDependencies>),
    });
    assert.equal(calls, 0);
    assert.equal(find(aq, 'structured:military-flights').state, 'unavailable');
    assert.equal(find(aq, 'structured:earthquakes').incidents.length, 1);
  });

  it('always reports all six producers, in a stable order', async () => {
    const results = await collect();
    assert.deepEqual(results.map(r => r.source), [
      'structured:protests',
      'structured:earthquakes',
      'structured:conflicts',
      'structured:military-flights',
      'structured:military-vessels',
      'structured:strikes',
    ]);
  });

  it('an empty producer whose cache WAS readable is "empty" and says why', async () => {
    const protests = find(await collect(), 'structured:protests');
    assert.equal(protests.state, 'empty');
    assert.ok(protests.detail.length > 0);
  });

  it('a producer with no health signal reports "unknown", never "empty"', async () => {
    // ACLED has no single seeded snapshot key, and list-acled-events returns an
    // empty array for both a real outage and a genuinely quiet week. Claiming
    // `empty` there would assert a health this surface cannot observe.
    const conflicts = find(await collect(), 'structured:conflicts');
    assert.equal(conflicts.state, 'unknown');
    assert.ok(conflicts.detail.includes('cannot confirm'));
  });

  it('a DEAD upstream reports failed, not empty, even though the handler swallows its error', async () => {
    // The regression this guards: list-unrest-events catches its own failure and
    // returns { events: [] }, so the producer looks quiet unless the seed read
    // is consulted. Redis erroring must surface as failed.
    const errored = find(
      await collect({ readSeed: async () => ({ status: 'error' as const, fetchedAtMs: 0 }) }),
      'structured:protests',
    );
    assert.equal(errored.state, 'failed');
    assert.ok(errored.detail.includes('not evidence of a quiet period'));

    // A seed key that is simply absent means the seeder is not publishing.
    const missing = find(
      await collect({ readSeed: async () => ({ status: 'miss' as const, fetchedAtMs: 0 }) }),
      'structured:protests',
    );
    assert.equal(missing.state, 'failed');
    assert.ok(missing.detail.includes('not evidence of a quiet period'));
  });

  it('a throwing producer is "failed" and carries the cause, without taking the others down', async () => {
    const results = await collect({
      listUnrestEvents: async () => { throw new Error('unrest seed key missing'); },
    });
    const protests = find(results, 'structured:protests');
    assert.equal(protests.state, 'failed');
    assert.ok(protests.detail.includes('unrest seed key missing'));
    assert.equal(protests.incidents.length, 0);
    // A neighbour failing must not change this producer's verdict.
    assert.equal(find(results, 'structured:earthquakes').state, 'empty');
  });

  it('a snapshot past its freshness budget is "stale" but still contributes', async () => {
    const results = await collect({
      readSeed: async () => ({ status: 'hit' as const, fetchedAtMs: NOW_MS - 40 * HOUR }),
      listUnrestEvents: async () => ({
        events: [{
          id: 'u1',
          title: 'Protest outside the ministry',
          summary: '',
          eventType: 'UNREST_EVENT_TYPE_PROTEST',
          city: 'Jerusalem',
          country: 'Israel',
          region: '',
          location: { latitude: ISRAEL.lat, longitude: ISRAEL.lon },
          occurredAt: NOW_MS - 2 * HOUR,
          severity: 'SEVERITY_LEVEL_HIGH',
          fatalities: 0,
          sources: [],
          sourceType: 'UNREST_SOURCE_TYPE_ACLED',
          tags: [],
          actors: [],
          confidence: 'CONFIDENCE_LEVEL_HIGH',
          sourceUrls: [],
        }],
        clusters: [],
        pagination: undefined,
      }),
    } as Partial<StructuredDependencies>);
    const protests = find(results, 'structured:protests');
    assert.equal(protests.state, 'stale');
    assert.equal(protests.incidents.length, 1, 'a stale producer still contributes');
    assert.equal(protests.incidents[0]?.severity, 'high');
    assert.equal(protests.incidents[0]?.label, 'Protest outside the ministry');
  });

  it('composes a protest label from the event type when the record has no title', async () => {
    const results = await collect({
      listUnrestEvents: async () => ({
        events: [{
          id: 'u2',
          title: '',
          summary: '',
          eventType: 'UNREST_EVENT_TYPE_CIVIL_UNREST',
          city: 'Haifa',
          country: 'Israel',
          region: '',
          location: { latitude: ISRAEL.lat, longitude: ISRAEL.lon },
          occurredAt: NOW_MS - 2 * HOUR,
          severity: 'SEVERITY_LEVEL_MEDIUM',
          fatalities: 0,
          sources: [],
          sourceType: 'UNREST_SOURCE_TYPE_ACLED',
          tags: [],
          actors: [],
          confidence: 'CONFIDENCE_LEVEL_HIGH',
          sourceUrls: [],
        }],
        clusters: [],
        pagination: undefined,
      }),
    } as Partial<StructuredDependencies>);
    // The browser's mapEventType funnels CIVIL_UNREST *and* UNSPECIFIED to the
    // literal 'civil_unrest' (underscore), so the panel never renders
    // "civil unrest" or "unspecified".
    assert.equal(find(results, 'structured:protests').incidents[0]?.label, 'civil_unrest in Haifa');
  });

  it('drops a structured record that fell out of the window', async () => {
    const results = await collect({
      listEarthquakes: async () => ({
        earthquakes: [
          { id: 'q1', place: 'near Israel', magnitude: 5.2, depthKm: 10, location: { latitude: ISRAEL.lat, longitude: ISRAEL.lon }, occurredAt: NOW_MS - 2 * HOUR, sourceUrl: '', source: 'usgs', category: '' },
          { id: 'q2', place: 'near Israel', magnitude: 6.4, depthKm: 10, location: { latitude: ISRAEL.lat, longitude: ISRAEL.lon }, occurredAt: NOW_MS - 30 * DAY, sourceUrl: '', source: 'usgs', category: '' },
        ],
        pagination: undefined,
      }),
    } as Partial<StructuredDependencies>);
    const quakes = find(results, 'structured:earthquakes');
    assert.deepEqual(quakes.incidents.map(i => i.label), ['M5.2 near Israel']);
    assert.equal(quakes.incidents[0]?.severity, 'high');
  });

  it('rejects superstring place names that only contain the country name', async () => {
    // Substring matching attributed foreign quakes to the wrong country:
    // Nigeria to Niger, Somalia to Mali, Romania to Oman, Indiana to India,
    // South Sudan to Sudan. Each place below sits far outside the request
    // country's box, so only the name arm can fire — and it must not.
    const superstrings: Array<[string, string, { lat: number; lon: number }]> = [
      ['NE', 'Niger', { lat: 6.45, lon: 3.39 }], // Lagos, Nigeria
      ['ML', 'Mali', { lat: 2.03, lon: 45.34 }], // Mogadishu, Somalia
      ['OM', 'Oman', { lat: 44.42, lon: 26.1 }], // Bucharest, Romania
      ['IN', 'India', { lat: 39.16, lon: -86.52 }], // Bloomington, Indiana
      ['SD', 'Sudan', { lat: 4.85, lon: 31.57 }], // Juba, South Sudan
    ];
    const foreignPlace: Record<string, string> = {
      NE: '10km S of Lagos, Nigeria',
      ML: 'Mogadishu, Somalia',
      OM: 'Bucharest, Romania',
      IN: 'Bloomington, Indiana',
      SD: 'Juba, South Sudan',
    };
    for (const [code, name, loc] of superstrings) {
      const results = await collectStructuredIncidents({
        ctx, code, countryName: name, cutoffMs: NOW_MS - DAY, now: NOW_MS,
        deps: structuredDeps({
          listEarthquakes: async () => ({ earthquakes: [{
            id: `q-${code}`, place: foreignPlace[code], magnitude: 5.2, depthKm: 10,
            location: { latitude: loc.lat, longitude: loc.lon },
            occurredAt: NOW_MS - 2 * HOUR, sourceUrl: '', source: 'usgs', category: '',
          }] }),
        } as Partial<StructuredDependencies>),
      });
      assert.equal(
        find(results, 'structured:earthquakes').incidents.length, 0,
        `${foreignPlace[code]} must not attribute to ${name}`,
      );
    }
  });

  it('rejects demonym matches in USGS place labels', async () => {
    // The shared matcher is tuned for news prose, where a demonym names a
    // country. A USGS `place` is a toponym, where it does not: these five all
    // matched once the shared matcher was wired in (the old substring test
    // missed them), attributing Alaskan and Utah quakes to the Netherlands and
    // Spain. collectEarthquakes drops the demonym arm for this reason.
    const demonymTraps: Array<[string, string, string, { lat: number; lon: number }]> = [
      ['NL', 'Netherlands', '73 km SE of Dutch Harbor, Alaska', { lat: 53.9, lon: -166.5 }],
      ['ES', 'Spain', '10 km N of Spanish Fork, Utah', { lat: 40.1, lon: -111.65 }],
      ['PH', 'Philippines', 'Philippine Sea', { lat: 20.0, lon: 130.0 }],
      ['NO', 'Norway', 'Norwegian Sea', { lat: 68.0, lon: 2.0 }],
      ['FR', 'France', '12 km SW of French Camp, California', { lat: 37.87, lon: -121.27 }],
    ];
    for (const [code, name, place, loc] of demonymTraps) {
      const results = await collectStructuredIncidents({
        ctx, code, countryName: name, cutoffMs: NOW_MS - DAY, now: NOW_MS,
        deps: structuredDeps({
          listEarthquakes: async () => ({ earthquakes: [{
            id: `q-${code}`, place, magnitude: 5.2, depthKm: 10,
            location: { latitude: loc.lat, longitude: loc.lon },
            occurredAt: NOW_MS - 2 * HOUR, sourceUrl: '', source: 'usgs', category: '',
          }] }),
        } as Partial<StructuredDependencies>),
      });
      assert.equal(
        find(results, 'structured:earthquakes').incidents.length, 0,
        `${place} must not attribute to ${name} via its demonym`,
      );
    }
  });

  it('rejects a structured record geolocated outside the country box', async () => {
    const results = await collect({
      listEarthquakes: async () => ({
        earthquakes: [
          // Moscow: outside Israel's box, and its place name does not contain
          // the country name either, so neither match arm fires.
          { id: 'q3', place: 'near Moscow', magnitude: 5.2, depthKm: 10, location: { latitude: 55.75, longitude: 37.62 }, occurredAt: NOW_MS - 2 * HOUR, sourceUrl: '', source: 'usgs', category: '' },
        ],
        pagination: undefined,
      }),
    } as Partial<StructuredDependencies>);
    assert.equal(find(results, 'structured:earthquakes').incidents.length, 0);
  });

  it('reports the retired strike lane as unavailable, not as a quiet week', async () => {
    const strikes = find(await collect(), 'structured:strikes');
    assert.equal(strikes.state, 'unavailable');
    assert.ok(strikes.detail.includes('retired'));
  });

  it('reports an ENABLED but quiet strike lane as empty, not retired', async () => {
    // The distinguishing signal is the scrapedAt sentinel, not the event count.
    const strikes = find(
      await collect({ listIranEvents: async () => ({ events: [], scrapedAt: new Date(NOW_MS).toISOString() }) }),
      'structured:strikes',
    );
    assert.equal(strikes.state, 'empty');
  });

  it('reports military vessels as unavailable on this surface', async () => {
    const vessels = find(await collect(), 'structured:military-vessels');
    assert.equal(vessels.state, 'unavailable');
    assert.ok(vessels.detail.toLowerCase().includes('ais'));
  });

  it('maps ACLED rows to the panel\'s label and severity', async () => {
    const results = await collect({
      listAcledEvents: async () => ({
        events: [
          { id: 'a1', eventType: 'Battles', country: 'Israel', location: { latitude: ISRAEL.lat, longitude: ISRAEL.lon }, occurredAt: NOW_MS - 2 * HOUR, fatalities: 3, actors: [], source: 'acled', admin1: 'North' },
          { id: 'a2', eventType: 'Explosions/Remote violence', country: 'Israel', location: { latitude: ISRAEL.lat, longitude: ISRAEL.lon }, occurredAt: NOW_MS - 3 * HOUR, fatalities: 0, actors: [], source: 'acled', admin1: 'South' },
          { id: 'a3', eventType: 'Battles', country: 'Egypt', location: { latitude: 30.0, longitude: 31.2 }, occurredAt: NOW_MS - 2 * HOUR, fatalities: 1, actors: [], source: 'acled', admin1: 'Cairo' },
        ],
        pagination: undefined,
      }),
    } as Partial<StructuredDependencies>);
    const conflicts = find(results, 'structured:conflicts');
    assert.deepEqual(conflicts.incidents.map(i => i.label), [
      'battle: Israel',
      'explosion: Israel',
    ]);
    assert.equal(conflicts.incidents[0]?.severity, 'critical', 'fatalities > 0 is critical');
    assert.equal(conflicts.incidents[1]?.severity, 'high', 'no fatalities is high');
  });

  it('bounds military flights to the country box and grades them by interest', async () => {
    const results = await collect({
      listMilitaryFlights: async () => ({
        flights: [{
          id: 'f1',
          callsign: 'RCH123',
          hexCode: '',
          registration: '',
          aircraftType: 'MILITARY_AIRCRAFT_TYPE_TRANSPORT',
          aircraftModel: 'C-17',
          operator: 'MILITARY_OPERATOR_UNSPECIFIED',
          operatorCountry: 'US',
          location: { latitude: ISRAEL.lat, longitude: ISRAEL.lon },
          altitude: 0,
          heading: 0,
          speed: 0,
          verticalRate: 0,
          onGround: false,
          squawk: '',
          origin: '',
          destination: '',
          lastSeenAt: NOW_MS - HOUR,
          firstSeenAt: NOW_MS - 2 * HOUR,
          confidence: 'MILITARY_CONFIDENCE_HIGH',
          isInteresting: true,
          note: '',
        }],
        clusters: [],
        pagination: undefined,
      }),
    } as Partial<StructuredDependencies>);
    const flights = find(results, 'structured:military-flights');
    assert.deepEqual(flights.incidents.map(i => i.label), ['RCH123 (C-17)']);
    assert.equal(flights.incidents[0]?.severity, 'high');
    assert.equal(flights.incidents[0]?.lane, 'military');
    // A live snapshot reports no gather time, so it must not invent one.
    assert.equal(flights.fetchedAtMs, 0);
  });

  it('follows the flights cursor instead of keeping only the first page', async () => {
    // The browser reassembles the region by following next_cursor
    // (military-flights.ts fetchViaProto). Reading one page would silently drop
    // military-lane incidents for exactly the busiest countries.
    const pages = new Map([
      ['', { next: 'p2', callsign: 'RCH001' }],
      ['p2', { next: 'p3', callsign: 'RCH002' }],
      ['p3', { next: '', callsign: 'RCH003' }],
    ]);
    const results = await collect({
      listMilitaryFlights: async (_ctx: unknown, req: { cursor: string }) => {
        const page = pages.get(req.cursor);
        assert.ok(page, `unexpected cursor ${JSON.stringify(req.cursor)}`);
        return {
          flights: [flight(page!.callsign)],
          clusters: [],
          pagination: { nextCursor: page!.next, totalCount: 3 },
        };
      },
    } as Partial<StructuredDependencies>);
    assert.deepEqual(
      find(results, 'structured:military-flights').incidents.map(i => i.label),
      ['RCH001 (C-17)', 'RCH002 (C-17)', 'RCH003 (C-17)'],
    );
  });

  it('stops rather than spinning when the flights cursor does not advance', async () => {
    let calls = 0;
    const results = await collect({
      listMilitaryFlights: async () => {
        calls++;
        return {
          flights: [flight('RCH999')],
          clusters: [],
          // A cursor that never changes would loop forever without the guard.
          pagination: { nextCursor: 'stuck', totalCount: 1 },
        };
      },
    } as Partial<StructuredDependencies>);
    assert.ok(calls <= 10, `cursor walk must be bounded, made ${calls} calls`);
    assert.equal(find(results, 'structured:military-flights').state, 'failed');
    assert.deepEqual(find(results, 'structured:military-flights').incidents, []);
  });

  it('says plainly that flight severity is un-enriched', async () => {
    // The browser raises isInteresting via Wingbits enrichment this surface does
    // not run, so severity here can under-rate. That must be stated, not hidden.
    const flights = find(await collect(), 'structured:military-flights');
    assert.ok(flights.detail.toLowerCase().includes('un-enriched'));
  });

  it('marks military flights unavailable for a country with no bounding box', async () => {
    const results = await collectStructuredIncidents({
      ctx,
      code: 'ZZ',
      countryName: 'ZZ',
      cutoffMs: NOW_MS - 7 * DAY,
      now: NOW_MS,
      deps: structuredDeps(),
    });
    const flights = find(results, 'structured:military-flights');
    assert.equal(flights.state, 'unavailable');
    assert.ok(flights.detail.includes('bounding box'));
  });
});

describe('GetCountryCoverage — end to end over the real collector', () => {
  // The suites above inject BOTH halves, which is what let a broken producer
  // look healthy: every state they assert was hand-built by the test. These
  // compose the REAL collectStructuredIncidents with the REAL handler and stub
  // only the leaf RPC calls, so the states are the ones production can produce.
  const ISRAEL = { lat: 31.78, lon: 35.22 };

  function leafDeps(overrides: Partial<StructuredDependencies> = {}): StructuredDependencies {
    return {
      listUnrestEvents: async () => ({ events: [], clusters: [], pagination: undefined }),
      listEarthquakes: async () => ({ earthquakes: [], pagination: undefined }),
      listAcledEvents: async () => ({ events: [], pagination: undefined }),
      listIranEvents: async () => ({ events: [], scrapedAt: '0' }),
      listMilitaryFlights: async () => ({ flights: [], clusters: [], pagination: undefined }),
      readSeed: async () => ({ status: 'hit' as const, fetchedAtMs: NOW_MS - HOUR }),
      ...overrides,
    } as StructuredDependencies;
  }

  async function run(
    structuredOverrides: Partial<StructuredDependencies> = {},
    coverageOverride?: CoverageFetch,
  ): Promise<GetCountryCoverageResponse> {
    return getCountryCoverage(ctx, request(), {
      now: () => NOW_MS,
      fetchCoverage: async () => coverageOverride ?? coverage(),
      collectStructured: collectStructuredIncidents,
      structuredDeps: leafDeps(structuredOverrides),
    });
  }

  it('an enabled strike cache failure degrades the response', async () => {
    const response = await run({ strikeTrackingEnabled: true });
    assert.equal(response.sources.find(s => s.source === 'structured:strikes')?.state, 'failed');
    assert.equal(response.degraded, true);
  });

  for (const complete of [false, true]) {
    it(`a tenth flight page with complete=${complete} reports integrity`, async () => {
      let pages = 0;
      const response = await run({
        listMilitaryFlights: async () => ({
          flights: [], clusters: [],
          pagination: { nextCursor: ++pages === 10 && complete ? '' : String(pages), totalCount: 0 },
        }),
      });
      assert.equal(pages, 10);
      assert.equal(response.sources.find(s => s.source === 'structured:military-flights')?.state, complete ? 'unknown' : 'failed');
      assert.equal(response.degraded, !complete);
    });
  }

  it('a healthy but quiet snapshot is NOT degraded', async () => {
    // The flag has to be able to be false, or it carries no information.
    const response = await run();
    assert.equal(response.events.length, 0);
    assert.equal(response.degraded, false);
  });

  it('a Redis outage degrades the response instead of reading as a quiet week', async () => {
    // Production shape of the bug this endpoint exists to prevent: the upstream
    // handler catches its own failure and RESOLVES EMPTY, so only the seed read
    // reveals the outage. Nothing may report `empty` here.
    const response = await run({
      readSeed: async () => ({ status: 'error' as const, fetchedAtMs: 0 }),
    });
    assert.equal(response.degraded, true);
    const seedBacked = ['structured:protests', 'structured:earthquakes'];
    for (const source of seedBacked) {
      const entry = response.sources.find(s => s.source === source);
      assert.equal(entry?.state, 'failed', `${source} must report failed, not empty`);
      assert.ok(entry?.detail.includes('not evidence of a quiet period'));
    }
    // Scoped to the structured half: the coverage feeds are healthy in this
    // scenario and their `empty` is a true statement.
    assert.ok(
      response.sources
        .filter(s => s.source.startsWith('structured:'))
        .every(s => s.state !== 'empty'),
      'no structured producer may claim a confirmed-quiet state while its cache is unreadable',
    );
  });

  it('a producer with no health signal reports unknown end to end', async () => {
    const response = await run();
    assert.equal(response.sources.find(s => s.source === 'structured:conflicts')?.state, 'unknown');
    assert.equal(response.sources.find(s => s.source === 'structured:military-flights')?.state, 'unknown');
    // Structural, so it does not degrade — but every one of them says why, which
    // is where the "empty is never silently healthy" guarantee actually lives.
    assert.equal(response.degraded, false);
    for (const entry of response.sources) {
      if (entry.state !== 'ok') {
        assert.ok(entry.detail.length > 0, `${entry.source} (${entry.state}) must explain itself`);
      }
    }
  });

  it('a globally non-empty conflicts feed with nothing for this country is empty, not unknown', async () => {
    // ACLED is queried globally, so rows coming back prove it answered even when
    // none are this country's. That is a confirmed-quiet `empty`.
    const response = await run({
      listAcledEvents: async () => ({
        events: [{
          id: 'a1',
          eventType: 'Battles',
          country: 'Egypt',
          location: { latitude: 30.0, longitude: 31.2 },
          occurredAt: NOW_MS - 2 * HOUR,
          fatalities: 1,
          actors: [],
          source: 'acled',
          admin1: 'Cairo',
        }],
        pagination: undefined,
      }),
    } as Partial<StructuredDependencies>);
    assert.equal(response.sources.find(s => s.source === 'structured:conflicts')?.state, 'empty');
    assert.equal(response.degraded, false);
  });

  it('carries a real structured incident through to the response', async () => {
    const response = await run({
      listUnrestEvents: async () => ({
        events: [{
          id: 'u1',
          title: 'Protest outside the ministry',
          summary: '',
          eventType: 'UNREST_EVENT_TYPE_PROTEST',
          city: 'Jerusalem',
          country: 'Israel',
          region: '',
          location: { latitude: ISRAEL.lat, longitude: ISRAEL.lon },
          occurredAt: NOW_MS - 2 * HOUR,
          severity: 'SEVERITY_LEVEL_HIGH',
          fatalities: 0,
          sources: [],
          sourceType: 'UNREST_SOURCE_TYPE_ACLED',
          tags: [],
          actors: [],
          confidence: 'CONFIDENCE_LEVEL_HIGH',
          sourceUrls: [],
        }],
        clusters: [],
        pagination: undefined,
      }),
    } as Partial<StructuredDependencies>);
    assert.deepEqual(response.events.map(e => e.label), ['Protest outside the ministry']);
    assert.equal(response.events[0]?.origin, 'structured');
    assert.equal(response.events[0]?.source, 'structured:protests');
    assert.equal(response.sources.find(s => s.source === 'structured:protests')?.contributed, 1);
  });

  it('builds a strike incident and normalizes a seconds-precision stamp', async () => {
    // The strike lane is retired by default, so its construction path is only
    // reachable with the flag on — pin it anyway so a future re-enable is not
    // the first time this code runs.
    const response = await run({
      listIranEvents: async () => ({
        scrapedAt: String(NOW_MS),
        events: [
          {
            id: 's1',
            title: 'Strike on the northern depot',
            category: '',
            sourceUrl: '',
            latitude: ISRAEL.lat,
            longitude: ISRAEL.lon,
            // Seconds, not milliseconds — the panel multiplies these up.
            timestamp: String(Math.floor((NOW_MS - 3 * HOUR) / 1000)),
            locationName: 'North',
            severity: 'high',
          },
          // Duplicate id: the panel de-duplicates before rendering.
          {
            id: 's1',
            title: 'Strike on the northern depot',
            category: '',
            sourceUrl: '',
            latitude: ISRAEL.lat,
            longitude: ISRAEL.lon,
            timestamp: String(Math.floor((NOW_MS - 3 * HOUR) / 1000)),
            locationName: 'North',
            severity: 'high',
          },
        ],
      }),
    } as Partial<StructuredDependencies>);
    const strikes = response.events.filter(e => e.source === 'structured:strikes');
    assert.equal(strikes.length, 1, 'the duplicate id must be dropped');
    assert.equal(strikes[0]?.label, 'Strike on the northern depot');
    assert.equal(strikes[0]?.severity, 'critical');
    assert.equal(strikes[0]?.timestampMs, (NOW_MS - 3 * HOUR) - ((NOW_MS - 3 * HOUR) % 1000));
  });

  it('bounds the structured half with its own deadline', async () => {
    // The coverage AbortController does not reach these producers — they are
    // plain handler calls that take no signal — so one hanging upstream would
    // otherwise hold the whole response open.
    const response = await getCountryCoverage(ctx, request(), {
      now: () => NOW_MS,
      fetchCoverage: async () => coverage(),
      collectStructured: () => new Promise(() => { /* never settles */ }),
    });
    assert.equal(response.degraded, true);
    const structured = response.sources.filter(s => s.source.startsWith('structured:'));
    assert.ok(structured.length > 0, 'timed-out producers must still be reported');
    assert.ok(structured.every(s => s.state === 'failed'));
    assert.ok(structured[0]?.detail.includes('did not settle'));
  });
});


describe('fetchCountryCoverageFeeds — the real coverage pipeline', () => {
  // Everything above injects `fetchCoverage`, so the function that actually
  // wires the fetch, the cutoff, the country gate, the classifier, the lane map
  // and the clustering together never ran under test. It holds the
  // cluster-before-filter ordering the panel depends on, so it needs its own.
  const TERMS = ['israel', 'israeli', 'gaza'];

  function item(overrides: Record<string, unknown> = {}) {
    return {
      source: 'Country events: Israel',
      originPublisher: '',
      originPublisherTrusted: false,
      title: 'Protests erupt across Israel - Reuters',
      link: 'https://example.org/a',
      publishedAt: NOW_MS - 2 * HOUR,
      isAlert: false,
      level: 'medium',
      category: 'protest',
      confidence: 0.7,
      classSource: 'keyword',
      importanceScore: 0,
      credibilityScore: 0,
      corroborationCount: 1,
      entityCorroborationCount: 0,
      lang: 'en',
      description: '',
      isOpinion: false,
      isFeelGood: false,
      isEphemeralLiveCoverage: false,
      tickers: [],
      ...overrides,
    };
  }

  function parseOf(items: ReturnType<typeof item>[]) {
    return {
      items,
      parsedTotal: items.length,
      droppedUndated: 0,
      attempt: { source: 'direct' as const, failure: null, negativeCache: false },
    };
  }

  /** Stub the shared transport; returns the two feeds in call order. */
  async function runFeeds(
    headlineItems: ReturnType<typeof item>[],
    eventItems: ReturnType<typeof item>[],
    cutoffMs = NOW_MS - 7 * DAY,
  ): Promise<CoverageFetch> {
    const seen: string[] = [];
    const fetchFeed = (async (feed: { name: string }) => {
      seen.push(feed.name);
      return feed.name.startsWith('Country coverage')
        ? parseOf(headlineItems)
        : parseOf(eventItems);
    }) as unknown as typeof feedDigest.fetchAndParseRss;
    const result = await fetchCountryCoverageFeeds(
      'Israel', 'IL', TERMS, cutoffMs, new AbortController().signal, fetchFeed,
    );
    assert.equal(seen.length, 2, 'both country feeds must be fetched');
    return result;
  }

  it('drops items older than the cutoff', async () => {
    const result = await runFeeds([], [
      item({ title: 'Protests erupt across Israel - Reuters', publishedAt: NOW_MS - 2 * HOUR }),
      item({ title: 'Older protests in Israel - AP', publishedAt: NOW_MS - 30 * DAY }),
    ]);
    assert.deepEqual(result.incidents.map(i => i.label), ['Protests erupt across Israel']);
  });

  it('strips the publisher suffix and keeps only country-relevant headlines', async () => {
    const result = await runFeeds([
      item({ title: 'Israel announces new measures - Reuters' }),
      // Iran is mentioned first, so this headline belongs to Iran, not Israel.
      item({ title: 'Iran responds to Israel over the strike - AP' }),
    ], []);
    assert.deepEqual(result.headlines.map(h => h.title), ['Israel announces new measures']);
    assert.equal(result.headlines[0]?.source, 'Reuters');
  });

  it('drops an article whose category maps to no timeline lane', async () => {
    // 'election' classifies as diplomatic, which has no lane in TIMELINE_LANES.
    const result = await runFeeds([], [
      item({ title: 'Israel election result confirmed - Reuters' }),
    ]);
    assert.equal(result.incidents.length, 0);
  });

  it('CLUSTERS BEFORE FILTERING, so a cluster named only by a later reprint is dropped', async () => {
    // The regression guard for the ordering fix. Two outlets carry one incident;
    // only the LATER headline names the country. The cluster is represented by
    // its earliest member, which does not mention Israel, so the panel drops the
    // whole cluster. Filtering first would have kept the later headline as its
    // own incident and invented an event the UI never shows.
    const base = NOW_MS - 4 * HOUR;
    const result = await runFeeds([], [
      item({ title: 'Thousands protest rising fuel prices outside government headquarters - Reuters', publishedAt: base }),
      item({ title: 'Thousands protest rising fuel prices outside government headquarters in Israel - AP', publishedAt: base + 20 * 60_000 }),
    ]);
    assert.equal(result.incidents.length, 0, 'the cluster representative does not name the country');
  });

  it('keeps a cluster whose earliest member does name the country', async () => {
    const base = NOW_MS - 4 * HOUR;
    const result = await runFeeds([], [
      item({ title: 'Thousands protest fuel prices in Israel - Reuters', publishedAt: base }),
      item({ title: 'Thousands protest fuel prices in Israel - AP', publishedAt: base + 20 * 60_000 }),
    ]);
    assert.equal(result.incidents.length, 1, 'one incident, not two reprints');
    assert.equal(result.incidents[0]?.timestamp, base, 'the cluster keeps the earliest timestamp');
    assert.equal(result.incidents[0]?.lane, 'protest');
  });

  it('classifies the RAW title but labels with the NORMALIZED one', async () => {
    // rss.ts classifies before normalization and country-coverage.ts labels
    // after it, so a publisher name must not leak into the label.
    const result = await runFeeds([], [
      item({ title: 'Airstrike reported in Israel - The Jerusalem Post' }),
    ]);
    assert.equal(result.incidents[0]?.label, 'Airstrike reported in Israel');
    assert.equal(result.incidents[0]?.lane, 'conflict');
  });
});
