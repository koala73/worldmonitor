import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { RpcValidationError } from '../api/mcp/billing-denial.ts';
import { TOOL_ALIASES, TOOL_REGISTRY } from '../api/mcp/registry/index.ts';

const BASE_URL = 'https://worldmonitor.app';
const AUTH = { kind: 'pro', userId: 'user_flight_modes', mcpTokenId: 'mcp_flight_modes' } as const;
const ROUTE = { origin: 'JFK', destination: 'LHR' };
const originalFetch = globalThis.fetch;
const originalHmacSecret = process.env.MCP_INTERNAL_HMAC_SECRET;

const searchFlights = () => {
  const tool = TOOL_REGISTRY.find((candidate) => candidate.name === 'search_flights');
  assert.ok(tool?._execute && tool._validateArgs);
  return tool;
};

async function requestedUrl(params: Record<string, unknown>): Promise<URL> {
  let captured = '';
  globalThis.fetch = (async (input: string | URL | Request) => {
    captured = String(input);
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  await searchFlights()._execute!(params, BASE_URL, AUTH);
  return new URL(captured);
}

beforeEach(() => {
  process.env.MCP_INTERNAL_HMAC_SECRET = 'test-secret-mcp-flight-modes';
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalHmacSecret === undefined) delete process.env.MCP_INTERNAL_HMAC_SECRET;
  else process.env.MCP_INTERNAL_HMAC_SECRET = originalHmacSecret;
});

describe('search_flights modes', () => {
  it('sends a departure_date search to the itinerary route', async () => {
    const url = await requestedUrl({ ...ROUTE, departure_date: '2026-09-01', return_date: '2026-09-08', max_stops: '0', sort_by: 'duration' });
    assert.equal(url.pathname, '/api/aviation/v1/search-google-flights');
    assert.equal(url.searchParams.get('departure_date'), '2026-09-01');
    assert.equal(url.searchParams.get('return_date'), '2026-09-08');
    assert.equal(url.searchParams.get('max_stops'), '0');
    assert.equal(url.searchParams.get('sort_by'), 'duration');
    assert.equal(url.searchParams.has('start_date'), false);
  });

  it('sends a date range to the per-date route, one-way unless trip_duration is set', async () => {
    let url = await requestedUrl({ ...ROUTE, start_date: '2026-09-01', end_date: '2026-09-08' });
    assert.equal(url.pathname, '/api/aviation/v1/search-google-dates');
    assert.equal(url.searchParams.get('is_round_trip'), 'false');
    assert.equal(url.searchParams.has('trip_duration'), false);
    assert.equal(url.searchParams.get('sort_by_price'), 'false');

    url = await requestedUrl({ ...ROUTE, start_date: '2026-09-01', end_date: '2026-09-08', trip_duration: 7, sort_by: 'price' });
    assert.equal(url.searchParams.get('is_round_trip'), 'true');
    assert.equal(url.searchParams.get('trip_duration'), '7');
    assert.equal(url.searchParams.get('sort_by_price'), 'true');
  });

  it('rejects arguments from the other mode before any allowance is reserved', () => {
    const rejected: Array<[Record<string, unknown>, string]> = [
      [{ ...ROUTE }, 'departure_date'],
      [{ ...ROUTE, departure_date: '2026-09-01', start_date: '2026-09-01', end_date: '2026-09-08' }, 'departure_date'],
      [{ ...ROUTE, start_date: '2026-09-01' }, 'end_date'],
      [{ ...ROUTE, end_date: '2026-09-08' }, 'start_date'],
      [{ ...ROUTE, start_date: '2026-09-01', end_date: '2026-09-08', return_date: '2026-09-10' }, 'return_date'],
      [{ ...ROUTE, start_date: '2026-09-01', end_date: '2026-09-08', max_stops: '0' }, 'max_stops'],
      [{ ...ROUTE, start_date: '2026-09-01', end_date: '2026-09-08', sort_by: 'duration' }, 'sort_by'],
      [{ ...ROUTE, departure_date: '2026-09-01', trip_duration: 7 }, 'trip_duration'],
      // A duration the route cannot use would otherwise reach it as a round trip with no duration.
      [{ ...ROUTE, start_date: '2026-09-01', end_date: '2026-09-08', trip_duration: 0 }, 'trip_duration'],
      [{ ...ROUTE, start_date: '2026-09-01', end_date: '2026-09-08', trip_duration: -3 }, 'trip_duration'],
      [{ ...ROUTE, start_date: '2026-09-01', end_date: '2026-09-08', trip_duration: 2.5 }, 'trip_duration'],
    ];
    for (const [params, field] of rejected) {
      assert.throws(
        () => searchFlights()._validateArgs!(params),
        (error: unknown) => error instanceof RpcValidationError && error.violations.some((violation) => violation.field === field),
        JSON.stringify(params),
      );
    }
    assert.doesNotThrow(() => searchFlights()._validateArgs!({ ...ROUTE, departure_date: '2026-09-01' }));
    assert.doesNotThrow(() => searchFlights()._validateArgs!({ ...ROUTE, start_date: '2026-09-01', end_date: '2026-09-08', sort_by: 'price' }));
  });
});

describe('search_flight_prices_by_date alias', () => {
  const range = { ...ROUTE, start_date: '2026-09-01', end_date: '2026-09-08' };

  it('translates the retired round-trip and sort flags onto search_flights', () => {
    const resolved = TOOL_ALIASES.resolve('search_flight_prices_by_date', { ...range, is_round_trip: true, trip_duration: 7, sort_by_price: true, passengers: 2 });
    assert.equal(resolved.kind, 'alias');
    if (resolved.kind !== 'alias') return;
    assert.equal(resolved.tool.name, 'search_flights');
    assert.equal(resolved.argumentsShape, 'target');
    assert.deepEqual(resolved.arguments, { ...range, passengers: 2, trip_duration: 7, sort_by: 'price' });
    assert.equal(resolved.notice.replacement, 'search_flights');
  });

  it('drops trip_duration from a one-way call, as the old route ignored it', () => {
    const resolved = TOOL_ALIASES.resolve('search_flight_prices_by_date', { ...range, is_round_trip: false, trip_duration: 7, sort_by_price: false });
    assert.equal(resolved.kind, 'alias');
    if (resolved.kind !== 'alias') return;
    assert.deepEqual(resolved.arguments, range);
  });

  it('rejects a round trip without a duration and non-boolean flags', () => {
    for (const [args, field] of [
      [{ ...range, is_round_trip: true }, 'trip_duration'],
      [{ ...range, is_round_trip: 'yes' }, 'is_round_trip'],
      [{ ...range, sort_by_price: 1 }, 'sort_by_price'],
    ] as const) {
      const resolved = TOOL_ALIASES.resolve('search_flight_prices_by_date', args);
      assert.equal(resolved.kind, 'invalid');
      if (resolved.kind !== 'invalid') return;
      assert.equal(resolved.violations[0]?.field, field);
    }
  });
});
