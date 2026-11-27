// The aviation seeder buys a dep_iata page for each of its hubs every hour.
// list-airport-flights used to buy that same page again for every departure
// board a panel or API customer opened. These tests pin the hand-off: the
// seeder stores the page, the request path serves departures from it without a
// paid call, and a stale or missing board falls back to the paid call.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { departureBoardKey, listAirportFlights } from '../server/worldmonitor/aviation/v1/list-airport-flights.ts';
import {
  AIRPORTS,
  departureBoardKey as seederDepartureBoardKey,
  seedIntlDelays,
  trimBoardRows,
  writeDepartureBoards,
} from '../scripts/seed-aviation.mjs';

const ENV_KEYS = [
  'AVIATIONSTACK_MONTHLY_BUDGET',
  'AVIATIONSTACK_REQUEST_BUDGET',
  'LOCAL_API_MODE',
  'UPSTASH_REDIS_REST_TOKEN',
  'UPSTASH_REDIS_REST_URL',
  'WORLDMONITOR_VALID_KEYS',
  'WS_RELAY_URL',
] as const;
const originalEnv = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of ENV_KEYS) {
    originalEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'redis-token';
  process.env.WORLDMONITOR_VALID_KEYS = 'test-key';
  process.env.WS_RELAY_URL = 'https://relay.test';
  process.env.AVIATIONSTACK_MONTHLY_BUDGET = '48000';
  process.env.AVIATIONSTACK_REQUEST_BUDGET = '6000';
});

afterEach(() => {
  mock.restoreAll();
  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  originalEnv.clear();
});

const NOW = Date.parse('2026-11-27T21:00:00Z');

// Raw AviationStack rows as the API returns them, including the fields the
// board trims away (live, flight.number, flight_date) and a codeshare of the
// operating flight.
const RAW_PAGE = [
  {
    flight_date: '2026-11-27', flight_status: 'active', live: { latitude: 51.4 },
    flight: { number: '117', iata: 'BA117', icao: 'BAW117', codeshared: null },
    airline: { name: 'British Airways', iata: 'BA', icao: 'BAW' },
    departure: { airport: 'Heathrow', timezone: 'Europe/London', iata: 'LHR', icao: 'EGLL', terminal: '5', gate: 'B42', delay: 18, scheduled: '2026-11-27T20:25:00+00:00', estimated: '2026-11-27T20:25:00+00:00', actual: '2026-11-27T20:43:00+00:00' },
    arrival: { airport: 'John F Kennedy International', timezone: 'America/New_York', iata: 'JFK', icao: 'KJFK', terminal: '7', scheduled: '2026-11-27T23:30:00+00:00', estimated: null, actual: null },
    aircraft: { registration: 'G-STBA', iata: 'B77W', icao: 'B77W', icao24: '4007f5' },
  },
  {
    flight_date: '2026-11-27', flight_status: 'active', live: null,
    flight: { number: '6143', iata: 'AA6143', icao: 'AAL6143', codeshared: { airline_name: 'british airways', airline_iata: 'ba', airline_icao: 'baw', flight_number: '117', flight_iata: 'ba117', flight_icao: 'baw117' } },
    airline: { name: 'American Airlines', iata: 'AA', icao: 'AAL' },
    departure: { airport: 'Heathrow', timezone: 'Europe/London', iata: 'LHR', icao: 'EGLL', terminal: '5', gate: 'B42', delay: 18, scheduled: '2026-11-27T20:25:00+00:00', estimated: '2026-11-27T20:25:00+00:00', actual: '2026-11-27T20:43:00+00:00' },
    arrival: { airport: 'John F Kennedy International', timezone: 'America/New_York', iata: 'JFK', icao: 'KJFK', scheduled: '2026-11-27T23:30:00+00:00' },
    aircraft: null,
  },
  {
    flight_date: '2026-11-27', flight_status: 'scheduled', live: null,
    flight: { number: '326', iata: 'LH911', icao: 'DLH911', codeshared: null },
    airline: { name: 'Lufthansa', iata: 'LH', icao: 'DLH' },
    departure: { airport: 'Heathrow', timezone: 'Europe/London', iata: 'LHR', icao: 'EGLL', terminal: '2', scheduled: '2026-11-27T21:40:00+00:00' },
    arrival: { airport: 'Frankfurt International Airport', timezone: 'Europe/Berlin', iata: 'FRA', icao: 'EDDF', scheduled: '2026-11-28T00:15:00+00:00' },
    aircraft: null,
  },
];

function mockRedisAndRelay(store: Map<string, string>) {
  const calls = { relayUrls: [] as string[], reservedKeys: [] as string[], cacheWrites: [] as unknown[][] };
  mock.method(Date, 'now', () => NOW);
  mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('https://redis.test/get/')) {
      const key = decodeURIComponent(url.slice('https://redis.test/get/'.length));
      return Response.json({ result: store.get(key) ?? null });
    }
    if (url === 'https://redis.test/pipeline') {
      const commands = JSON.parse(String(init?.body ?? '[]')) as unknown[][];
      return Response.json(commands.map(([verb, key]) => {
        if (verb === 'INCRBY') calls.reservedKeys.push(String(key));
        return { result: 1 };
      }));
    }
    if (url === 'https://redis.test/') {
      const command = JSON.parse(String(init?.body ?? '[]')) as [string, string, string, ...unknown[]];
      calls.cacheWrites.push(command);
      store.set(command[1], command[2]);
      return Response.json({ result: 'OK' });
    }
    if (url.startsWith('https://relay.test/aviationstack')) {
      calls.relayUrls.push(url);
      return Response.json({ data: RAW_PAGE });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  return calls;
}

async function board(direction: string) {
  const request = new Request('https://worldmonitor.app/api/aviation/v1/list-airport-flights?airport=LHR', {
    headers: { 'X-WorldMonitor-Key': 'test-key' },
  });
  return listAirportFlights(
    { request, pathParams: {}, headers: {} } as never,
    { airport: 'LHR', direction, limit: 30 } as never,
  );
}

const departures = () => board('FLIGHT_DIRECTION_DEPARTURE');

function boardStore(fetchedAt: number) {
  return new Map([[departureBoardKey('LHR'), JSON.stringify({ fetchedAt, rows: trimBoardRows(RAW_PAGE) })]]);
}

const withoutUpdatedAt = (flights: Array<{ updatedAt: number }>) => flights.map(({ updatedAt: _, ...rest }) => rest);

describe('departure board hand-off from the aviation seeder', () => {
  it('serves departures from a fresh board without a paid call, identical to the paid page', async () => {
    const paidCalls = mockRedisAndRelay(new Map());
    const paid = await departures();
    assert.equal(paidCalls.relayUrls.length, 1, 'no board: the leg buys its page');
    mock.restoreAll();

    const fetchedAt = NOW - 40 * 60 * 1000;
    const boardCalls = mockRedisAndRelay(boardStore(fetchedAt));
    const served = await departures();

    assert.equal(served.source, 'aviationstack');
    assert.deepEqual(boardCalls.relayUrls, [], 'a fresh board needs no relay call');
    assert.deepEqual(boardCalls.reservedKeys, [], 'a fresh board reserves no budget');
    assert.equal(served.flights.length, 2, 'the codeshare row folds into its operating flight');
    assert.deepEqual(withoutUpdatedAt(served.flights), withoutUpdatedAt(paid.flights));
    assert.ok(served.flights.every(f => f.updatedAt === fetchedAt), 'flights report when the board was bought');
  });

  it('buys its own page once the board is older than 90 minutes', async () => {
    const calls = mockRedisAndRelay(boardStore(NOW - 91 * 60 * 1000));
    const response = await departures();

    assert.equal(calls.relayUrls.length, 1);
    assert.equal(response.source, 'aviationstack');
    assert.ok(response.flights.every(f => f.updatedAt === NOW));
  });

  it('keeps a bought arrival page for an hour, as long as a board lives', async () => {
    const calls = mockRedisAndRelay(boardStore(NOW - 10 * 60 * 1000));
    await board('FLIGHT_DIRECTION_BOTH');

    assert.equal(calls.relayUrls.length, 1, 'only the arrival leg is bought');
    assert.match(calls.relayUrls[0], /arr_iata=LHR/);
    const arrivalWrite = calls.cacheWrites.find(([, key]) => String(key).startsWith('aviation:flights:LHR:arrival:'));
    assert.deepEqual(arrivalWrite?.slice(3), ['EX', '3600']);
  });

  it('keeps a bought departure page for 15 minutes when no board covers the hub', async () => {
    const calls = mockRedisAndRelay(new Map());
    await departures();

    const departureWrite = calls.cacheWrites.find(([, key]) => String(key).startsWith('aviation:flights:LHR:departure:'));
    assert.deepEqual(departureWrite?.slice(3), ['EX', '900']);
  });

  it('reads the key the seeder writes', () => {
    for (const iata of ['LHR', 'HND', 'JFK']) assert.equal(departureBoardKey(iata), seederDepartureBoardKey(iata));
  });
});

describe('seeder departure boards', () => {
  const hubs = ['LHR', 'HND'].map(iata => AIRPORTS.find(a => a.iata === iata));

  it('keeps each answered hub page as its board and asks for the local day', async () => {
    const urls: string[] = [];
    mock.method(Date, 'now', () => NOW);
    const result = await seedIntlDelays({
      apiKey: 'synthetic-key', airports: hubs,
      logger: { log() {}, warn() {} },
      fetchFn: async (url: string) => {
        urls.push(url);
        if (url.includes('dep_iata=HND')) return Response.json({ error: { message: 'upstream down' } });
        return Response.json({ data: RAW_PAGE });
      },
    });

    assert.ok(urls.every(u => !new URL(u).searchParams.has('flight_date')), 'same query the request path issues');
    assert.deepEqual(result.boards, [{ iata: 'LHR', fetchedAt: NOW, rows: trimBoardRows(RAW_PAGE) }], 'a failed hub writes no board');
    const trimmed = JSON.stringify(result.boards[0].rows);
    for (const dropped of ['live', 'flight_date', 'registration', 'BAW117']) {
      assert.ok(!trimmed.includes(dropped), `${dropped} is not stored`);
    }
  });

  it('writes one expiring SET per board', async () => {
    const bodies: unknown[][][] = [];
    mock.method(console, 'log', () => {});
    await writeDepartureBoards(
      [{ iata: 'LHR', fetchedAt: NOW, rows: [] }, { iata: 'HND', fetchedAt: NOW, rows: [] }],
      async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return Response.json([{ result: 'OK' }]);
      },
    );

    assert.deepEqual(bodies.map(([[verb, key, , ex, ttl]]) => [verb, key, ex, ttl]).sort(), [
      ['SET', 'aviation:avstack:departures:v1:HND', 'EX', 10_800],
      ['SET', 'aviation:avstack:departures:v1:LHR', 'EX', 10_800],
    ]);
    assert.deepEqual(JSON.parse(String(bodies[0][0][2])), { fetchedAt: NOW, rows: [] });
  });

  it('counts a SET that Redis rejected inside an HTTP 200 as not written', async () => {
    const logs: string[] = [];
    mock.method(console, 'log', (line: string) => logs.push(line));
    await writeDepartureBoards(
      [{ iata: 'LHR', fetchedAt: NOW, rows: [] }, { iata: 'HND', fetchedAt: NOW, rows: [] }],
      async (_url: string, init: RequestInit) => String(init.body).includes(':HND')
        ? Response.json([{ error: 'OOM command not allowed' }])
        : Response.json([{ result: 'OK' }]),
    );

    assert.deepEqual(logs, ['[Intl] departure boards written: 1/2']);
  });
});
