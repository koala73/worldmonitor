import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  buildSportsFixtureAggregateMarker,
  fetchFeaturedSportsFixtures,
  fetchSportsFixtureMapMarkers,
  resetSportsServiceCacheForTests,
} from '../src/services/sports.ts';

const originalFetch = globalThis.fetch;
const originalDate = globalThis.Date;

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.Date = originalDate;
  resetSportsServiceCacheForTests();
});

describe('fetchSportsFixtureMapMarkers', () => {
  it('uses ESPN scoreboard data when the daily fixture feed is otherwise empty', async () => {
    const requested: Array<{ provider: string; path: string }> = [];

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const rawUrl = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      const url = new URL(rawUrl, 'https://worldmonitor.test');
      const provider = url.searchParams.get('provider') || '';
      const path = decodeURIComponent(url.searchParams.get('path') || '');

      requested.push({ provider, path });

      if (provider === 'thesportsdb') {
        return new Response(JSON.stringify({ events: [], results: [] }), { status: 200 });
      }

      if (provider === 'espnsite' && path === '/soccer/eng.1/scoreboard') {
        return new Response(JSON.stringify({
          leagues: [{ season: { displayName: '2025-26' } }],
          events: [
            {
              id: 'espn-epl-1',
              name: 'Arsenal vs Chelsea',
              date: '2026-04-11T19:00:00Z',
              competitions: [
                {
                  date: '2026-04-11T19:00:00Z',
                  competitors: [
                    {
                      homeAway: 'home',
                      score: '0',
                      team: {
                        displayName: 'Arsenal',
                        shortDisplayName: 'ARS',
                        logos: [{ href: 'https://example.com/arsenal.png' }],
                      },
                    },
                    {
                      homeAway: 'away',
                      score: '0',
                      team: {
                        displayName: 'Chelsea',
                        shortDisplayName: 'CHE',
                        logos: [{ href: 'https://example.com/chelsea.png' }],
                      },
                    },
                  ],
                  venue: {
                    fullName: 'Emirates Stadium',
                    address: {
                      city: 'London',
                      country: 'England',
                    },
                    latitude: 51.555,
                    longitude: -0.1086,
                  },
                  status: {
                    type: {
                      description: 'Scheduled',
                      detail: 'Sat, 7:00 PM',
                    },
                  },
                },
              ],
              week: { text: 'Matchday 32' },
              seasonType: { name: 'Regular Season' },
            },
          ],
        }), { status: 200 });
      }

      if (provider === 'espnsite') {
        return new Response(JSON.stringify({
          leagues: [{ season: { displayName: '2025-26' } }],
          events: [],
        }), { status: 200 });
      }

      if (provider === 'jolpica') {
        return new Response(JSON.stringify({ MRData: { RaceTable: { Races: [] } } }), { status: 200 });
      }

      throw new Error(`Unexpected request: ${provider} ${path}`);
    }) as typeof fetch;

    const markers = await fetchSportsFixtureMapMarkers();

    assert.equal(markers.length, 1);
    assert.equal(markers[0]?.eventId, 'espn-epl-1');
    assert.equal(markers[0]?.venue, 'Emirates Stadium');
    assert.equal(markers[0]?.sport, 'Soccer');
    assert.equal(markers[0]?.lat, 51.555);
    assert.equal(markers[0]?.lng, -0.1086);
    assert.ok(requested.some((request) => request.provider === 'thesportsdb'));
    assert.ok(requested.some((request) => request.provider === 'espnsite' && request.path === '/soccer/eng.1/scoreboard'));
  });

  it('uses the local calendar day when requesting daily fixtures', async () => {
    const requested: Array<{ provider: string; path: string }> = [];
    // Use local constructor args so the mocked "calendar day" stays stable across CI timezones.
    const fixedNow = new originalDate(2026, 3, 11, 0, 30, 0, 0).valueOf();

    class MockDate extends originalDate {
      constructor(...args: any[]) {
        super(...(args.length > 0 ? args : [fixedNow]));
      }

      static now(): number {
        return fixedNow;
      }
    }

    globalThis.Date = MockDate as DateConstructor;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const rawUrl = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      const url = new URL(rawUrl, 'https://worldmonitor.test');
      const provider = url.searchParams.get('provider') || '';
      const path = decodeURIComponent(url.searchParams.get('path') || '');

      requested.push({ provider, path });
      return new Response(JSON.stringify({ events: [], results: [], leagues: [] }), { status: 200 });
    }) as typeof fetch;

    const groups = await fetchFeaturedSportsFixtures();

    assert.equal(groups.length, 0);
    assert.ok(requested.some((request) => request.provider === 'thesportsdb' && request.path === '/eventsday.php?d=2026-04-10&s=Soccer'));
    assert.ok(requested.some((request) => request.provider === 'thesportsdb' && request.path === '/eventsday.php?d=2026-04-11&s=Soccer'));
    assert.ok(requested.some((request) => request.provider === 'thesportsdb' && request.path === '/eventsday.php?d=2026-04-12&s=Soccer'));
    assert.ok(requested.some((request) => request.provider === 'espnsite' && request.path === '/soccer/eng.1/scoreboard?dates=20260411'));
    assert.ok(requested.some((request) => request.provider === 'espnsite' && request.path === '/soccer/eng.1/scoreboard'));
  });

  it('groups same-league fixtures into a single hub marker with the full schedule', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const rawUrl = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      const url = new URL(rawUrl, 'https://worldmonitor.test');
      const provider = url.searchParams.get('provider') || '';
      const path = decodeURIComponent(url.searchParams.get('path') || '');

      if (provider === 'thesportsdb') {
        return new Response(JSON.stringify({ events: [], results: [] }), { status: 200 });
      }

      if (provider === 'espnsite' && path === '/soccer/eng.1/scoreboard') {
        return new Response(JSON.stringify({
          leagues: [{ season: { displayName: '2025-26' } }],
          events: [
            {
              id: 'espn-epl-1',
              name: 'Arsenal vs Chelsea',
              date: '2026-04-11T12:30:00Z',
              competitions: [{
                date: '2026-04-11T12:30:00Z',
                competitors: [
                  { homeAway: 'home', score: '0', team: { displayName: 'Arsenal' } },
                  { homeAway: 'away', score: '0', team: { displayName: 'Chelsea' } },
                ],
                venue: {
                  fullName: 'Emirates Stadium',
                  address: { city: 'London', country: 'England' },
                  latitude: 51.555,
                  longitude: -0.1086,
                },
                status: { type: { description: 'Scheduled', detail: 'Sat, 12:30 PM' } },
              }],
            },
            {
              id: 'espn-epl-2',
              name: 'Tottenham vs Liverpool',
              date: '2026-04-11T15:00:00Z',
              competitions: [{
                date: '2026-04-11T15:00:00Z',
                competitors: [
                  { homeAway: 'home', score: '0', team: { displayName: 'Tottenham' } },
                  { homeAway: 'away', score: '0', team: { displayName: 'Liverpool' } },
                ],
                venue: {
                  fullName: 'Emirates Stadium',
                  address: { city: 'London', country: 'England' },
                  latitude: 51.555,
                  longitude: -0.1086,
                },
                status: { type: { description: 'Scheduled', detail: 'Sat, 3:00 PM' } },
              }],
            },
          ],
        }), { status: 200 });
      }

      if (provider === 'espnsite') {
        return new Response(JSON.stringify({
          leagues: [{ season: { displayName: '2025-26' } }],
          events: [],
        }), { status: 200 });
      }

      if (provider === 'jolpica') {
        return new Response(JSON.stringify({ MRData: { RaceTable: { Races: [] } } }), { status: 200 });
      }

      throw new Error(`Unexpected request: ${provider} ${path}`);
    }) as typeof fetch;

    const markers = await fetchSportsFixtureMapMarkers();

    assert.equal(markers.length, 1);
    assert.equal(markers[0]?.fixtureCount, 2);
    assert.equal(markers[0]?.venue, 'Emirates Stadium');
    assert.equal(markers[0]?.fixtures?.length, 2);
    assert.equal(markers[0]?.fixtures?.[0]?.eventId, 'espn-epl-1');
    assert.equal(markers[0]?.fixtures?.[1]?.eventId, 'espn-epl-2');
  });

  it('supplements motorsport fixtures from Jolpica when the event lands on the local day', async () => {
    // Keep this anchored to local noon regardless of runner timezone.
    const fixedNow = new originalDate(2026, 3, 11, 12, 0, 0, 0).valueOf();

    class MockDate extends originalDate {
      constructor(...args: any[]) {
        super(...(args.length > 0 ? args : [fixedNow]));
      }

      static now(): number {
        return fixedNow;
      }
    }

    globalThis.Date = MockDate as DateConstructor;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const rawUrl = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      const url = new URL(rawUrl, 'https://worldmonitor.test');
      const provider = url.searchParams.get('provider') || '';
      const path = decodeURIComponent(url.searchParams.get('path') || '');

      if (provider === 'jolpica' && path === '/ergast/f1/current/next.json') {
        return new Response(JSON.stringify({
          MRData: {
            RaceTable: {
              Races: [{
                raceName: 'Bahrain Grand Prix',
                round: '4',
                date: '2026-04-11',
                time: '15:00:00Z',
                Circuit: {
                  circuitName: 'Bahrain International Circuit',
                  Location: {
                    locality: 'Sakhir',
                    country: 'Bahrain',
                    lat: '26.0325',
                    long: '50.5106',
                  },
                },
              }],
            },
          },
        }), { status: 200 });
      }

      return new Response(JSON.stringify({ events: [], results: [], leagues: [] }), { status: 200 });
    }) as typeof fetch;

    const markers = await fetchSportsFixtureMapMarkers();

    assert.ok(markers.some((marker) => marker.eventId === 'jolpica-f1-4'));
    const f1Marker = markers.find((marker) => marker.eventId === 'jolpica-f1-4');
    assert.equal(f1Marker?.venue, 'Bahrain International Circuit');
    assert.equal(f1Marker?.sport, 'Motorsport');
    assert.equal(f1Marker?.lat, 26.0325);
    assert.equal(f1Marker?.lng, 50.5106);
  });

  it('keeps all fallback football fixtures on a single per-league marker when the generic scoreboard is used', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const rawUrl = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      const url = new URL(rawUrl, 'https://worldmonitor.test');
      const provider = url.searchParams.get('provider') || '';
      const path = decodeURIComponent(url.searchParams.get('path') || '');

      if (provider === 'thesportsdb') {
        return new Response(JSON.stringify({ events: [], results: [] }), { status: 200 });
      }

      if (provider === 'jolpica') {
        return new Response(JSON.stringify({ MRData: { RaceTable: { Races: [] } } }), { status: 200 });
      }

      if (provider === 'espnsite' && path === '/soccer/eng.1/scoreboard?dates=20260411') {
        return new Response(JSON.stringify({
          leagues: [{ season: { displayName: '2025-26' } }],
          events: [],
        }), { status: 200 });
      }

      if (provider === 'espnsite' && path === '/soccer/eng.1/scoreboard') {
        return new Response(JSON.stringify({
          leagues: [{ season: { displayName: '2025-26' } }],
          events: [
            {
              id: 'fb-1',
              name: 'A vs B',
              date: '2026-04-12T10:00:00Z',
              competitions: [{ date: '2026-04-12T10:00:00Z', competitors: [], venue: { fullName: 'Venue 1', latitude: 10, longitude: 10 } }],
            },
            {
              id: 'fb-2',
              name: 'C vs D',
              date: '2026-04-12T12:00:00Z',
              competitions: [{ date: '2026-04-12T12:00:00Z', competitors: [], venue: { fullName: 'Venue 2', latitude: 11, longitude: 11 } }],
            },
            {
              id: 'fb-3',
              name: 'E vs F',
              date: '2026-04-12T14:00:00Z',
              competitions: [{ date: '2026-04-12T14:00:00Z', competitors: [], venue: { fullName: 'Venue 3', latitude: 12, longitude: 12 } }],
            },
            {
              id: 'fb-4',
              name: 'G vs H',
              date: '2026-04-12T16:00:00Z',
              competitions: [{ date: '2026-04-12T16:00:00Z', competitors: [], venue: { fullName: 'Venue 4', latitude: 13, longitude: 13 } }],
            },
          ],
        }), { status: 200 });
      }

      if (provider === 'espnsite') {
        return new Response(JSON.stringify({
          leagues: [{ season: { displayName: '2025-26' } }],
          events: [],
        }), { status: 200 });
      }

      throw new Error(`Unexpected request: ${provider} ${path}`);
    }) as typeof fetch;

    const markers = await fetchSportsFixtureMapMarkers();
    const footballMarkers = markers.filter((marker) => marker.eventId.startsWith('fb-'));

    assert.equal(footballMarkers.length, 1);
    assert.equal(footballMarkers[0]?.fixtureCount, 4);
    assert.equal(footballMarkers[0]?.fixtures?.length, 4);
    assert.equal(footballMarkers[0]?.fixtures?.[0]?.eventId, 'fb-1');
    assert.equal(footballMarkers[0]?.fixtures?.[3]?.eventId, 'fb-4');
  });

  it('flattens nested hub markers when building a regional sports hub', () => {
    const aggregate = buildSportsFixtureAggregateMarker([
      {
        id: 'hub-1',
        eventId: 'hub-1',
        leagueName: 'English Premier League',
        leagueShortName: 'EPL',
        sport: 'Soccer',
        title: '2 fixtures',
        venue: 'London fixture hub',
        venueCity: 'London',
        venueCountry: 'England',
        startTime: '2026-04-12T10:00:00Z',
        startLabel: 'Apr 12, 1:00 PM',
        lat: 51.5,
        lng: -0.1,
        fixtureCount: 2,
        competitionCount: 1,
        sports: ['Soccer'],
        fixtures: [
          {
            id: 'sports-fixture:1',
            eventId: 'fixture-1',
            leagueName: 'English Premier League',
            leagueShortName: 'EPL',
            sport: 'Soccer',
            title: 'Arsenal vs Chelsea',
            homeTeam: 'Arsenal',
            awayTeam: 'Chelsea',
            venue: 'Emirates Stadium',
            venueCity: 'London',
            venueCountry: 'England',
            startTime: '2026-04-12T10:00:00Z',
            startLabel: 'Apr 12, 1:00 PM',
            lat: 51.555,
            lng: -0.1086,
          },
          {
            id: 'sports-fixture:2',
            eventId: 'fixture-2',
            leagueName: 'English Premier League',
            leagueShortName: 'EPL',
            sport: 'Soccer',
            title: 'Tottenham vs Liverpool',
            homeTeam: 'Tottenham',
            awayTeam: 'Liverpool',
            venue: 'Tottenham Hotspur Stadium',
            venueCity: 'London',
            venueCountry: 'England',
            startTime: '2026-04-12T12:30:00Z',
            startLabel: 'Apr 12, 3:30 PM',
            lat: 51.6043,
            lng: -0.0664,
          },
        ],
      },
      {
        id: 'sports-fixture:3',
        eventId: 'fixture-3',
        leagueName: 'NBA',
        leagueShortName: 'NBA',
        sport: 'Basketball',
        title: 'Knicks vs Celtics',
        homeTeam: 'Knicks',
        awayTeam: 'Celtics',
        venue: 'Madison Square Garden',
        venueCity: 'New York',
        venueCountry: 'United States',
        startTime: '2026-04-12T23:00:00Z',
        startLabel: 'Apr 13, 2:00 AM',
        lat: 40.7505,
        lng: -73.9934,
      },
    ], {
      venue: 'Regional fixture hub',
    });

    assert.equal(aggregate.fixtureCount, 3);
    assert.equal(aggregate.fixtures?.length, 3);
    assert.equal(aggregate.fixtures?.[0]?.eventId, 'fixture-1');
    assert.equal(aggregate.fixtures?.[1]?.eventId, 'fixture-2');
    assert.equal(aggregate.fixtures?.[2]?.eventId, 'fixture-3');
    assert.deepEqual(aggregate.sports, ['Soccer', 'Basketball']);
    assert.equal(aggregate.sport, 'Mixed');
    assert.equal(aggregate.venue, 'Regional fixture hub');
  });
});
