import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';

const originalFetch = globalThis.fetch;

process.env.WS_RELAY_URL = 'http://relay.test';
process.env.RELAY_SHARED_SECRET = 'test-secret';

const { searchGoogleFlights } = await import('../server/worldmonitor/aviation/v1/search-google-flights.ts');
const { searchGoogleDates } = await import('../server/worldmonitor/aviation/v1/search-google-dates.ts');

type MockFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function mockFetch(fn: MockFn) {
  globalThis.fetch = fn as typeof globalThis.fetch;
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return (input as Request).url;
}

const mockCtx = { request: new Request('http://localhost'), pathParams: {}, headers: {} } as never;

describe('searchGoogleFlights — multi-airline filtering', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('forwards multiple airlines as repeated query params to the relay', async () => {
    let capturedUrl = '';
    mockFetch(async (input) => {
      capturedUrl = urlOf(input);
      return new Response(JSON.stringify({ flights: [] }), { status: 200 });
    });

    await searchGoogleFlights(mockCtx, {
      origin: 'JFK',
      destination: 'LHR',
      departureDate: '2026-05-01',
      airlines: ['BA', 'AA'],
      returnDate: '',
      cabinClass: '',
      maxStops: '',
      departureWindow: '',
      sortBy: '',
      passengers: 1,
    });

    const url = new URL(capturedUrl);
    const airlines = url.searchParams.getAll('airlines');
    assert.deepEqual(airlines.sort(), ['AA', 'BA'], 'each airline should be a separate airlines= param');
    assert.equal(url.searchParams.get('airlines'), 'BA', 'first value sanity check');
  });

  it('forwards a single airline correctly', async () => {
    let capturedUrl = '';
    mockFetch(async (input) => {
      capturedUrl = urlOf(input);
      return new Response(JSON.stringify({ flights: [] }), { status: 200 });
    });

    await searchGoogleFlights(mockCtx, {
      origin: 'DXB',
      destination: 'CDG',
      departureDate: '2026-06-01',
      airlines: ['EK'],
      returnDate: '',
      cabinClass: '',
      maxStops: '',
      departureWindow: '',
      sortBy: '',
      passengers: 1,
    });

    const url = new URL(capturedUrl);
    assert.deepEqual(url.searchParams.getAll('airlines'), ['EK']);
  });

  it('sends no airlines param when array is empty', async () => {
    let capturedUrl = '';
    mockFetch(async (input) => {
      capturedUrl = urlOf(input);
      return new Response(JSON.stringify({ flights: [] }), { status: 200 });
    });

    await searchGoogleFlights(mockCtx, {
      origin: 'ORD',
      destination: 'NRT',
      departureDate: '2026-07-01',
      airlines: [],
      returnDate: '',
      cabinClass: '',
      maxStops: '',
      departureWindow: '',
      sortBy: '',
      passengers: 1,
    });

    const url = new URL(capturedUrl);
    assert.equal(url.searchParams.has('airlines'), false, 'no airlines param when array is empty');
  });

  it('handles comma-joined string from codegen (parseStringArray path)', async () => {
    let capturedUrl = '';
    mockFetch(async (input) => {
      capturedUrl = urlOf(input);
      return new Response(JSON.stringify({ flights: [] }), { status: 200 });
    });

    // Simulate what the generated server stub produces: a comma-joined string assigned to string[]
    await searchGoogleFlights(mockCtx, {
      origin: 'SFO',
      destination: 'HKG',
      departureDate: '2026-08-01',
      airlines: 'UA,CX' as unknown as string[],
      returnDate: '',
      cabinClass: '',
      maxStops: '',
      departureWindow: '',
      sortBy: '',
      passengers: 1,
    });

    const url = new URL(capturedUrl);
    const airlines = url.searchParams.getAll('airlines');
    assert.deepEqual(airlines.sort(), ['CX', 'UA'], 'comma-joined string should be split into separate params');
  });
});

describe('searchGoogleDates — multi-airline filtering', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('forwards multiple airlines as repeated query params to the relay', async () => {
    let capturedUrl = '';
    mockFetch(async (input) => {
      capturedUrl = urlOf(input);
      return new Response(JSON.stringify({ dates: [], partial: false }), { status: 200 });
    });

    await searchGoogleDates(mockCtx, {
      origin: 'LAX',
      destination: 'SYD',
      startDate: '2026-05-01',
      endDate: '2026-05-30',
      airlines: ['QF', 'UA'],
      isRoundTrip: false,
      tripDuration: 0,
      cabinClass: '',
      maxStops: '',
      departureWindow: '',
      sortByPrice: false,
      passengers: 1,
    });

    const url = new URL(capturedUrl);
    const airlines = url.searchParams.getAll('airlines');
    assert.deepEqual(airlines.sort(), ['QF', 'UA'], 'each airline should be a separate airlines= param');
  });

  it('sets degraded: true when relay returns partial: true', async () => {
    mockFetch(async () =>
      new Response(JSON.stringify({ dates: [{ date: '2026-05-01', return_date: '', price: 450 }], partial: true }), { status: 200 }),
    );

    const result = await searchGoogleDates(mockCtx, {
      origin: 'MIA',
      destination: 'MAD',
      startDate: '2026-05-01',
      endDate: '2026-05-30',
      airlines: [],
      isRoundTrip: false,
      tripDuration: 0,
      cabinClass: '',
      maxStops: '',
      departureWindow: '',
      sortByPrice: false,
      passengers: 1,
    });

    assert.equal(result.degraded, true, 'partial chunk failure should set degraded: true');
    assert.equal(result.dates.length, 1, 'partial results still returned');
  });

  it('sets degraded: false when relay returns complete results', async () => {
    mockFetch(async () =>
      new Response(JSON.stringify({ dates: [{ date: '2026-06-01', return_date: '', price: 380 }], partial: false }), { status: 200 }),
    );

    const result = await searchGoogleDates(mockCtx, {
      origin: 'BOS',
      destination: 'LIS',
      startDate: '2026-06-01',
      endDate: '2026-06-30',
      airlines: [],
      isRoundTrip: false,
      tripDuration: 0,
      cabinClass: '',
      maxStops: '',
      departureWindow: '',
      sortByPrice: false,
      passengers: 1,
    });

    assert.equal(result.degraded, false);
    assert.equal(result.dates.length, 1);
  });
});
