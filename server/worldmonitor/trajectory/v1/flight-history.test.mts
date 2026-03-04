import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// Mock global fetch before importing the module under test
const originalFetch = globalThis.fetch;

// --- Test data ---

const VALID_ICAO24 = 'a1b2c3';
const VALID_ICAO24_UPPER = 'A1B2C3';

/** Minimal OpenSky /api/tracks/all response */
const OPENSKY_TRACK_RESPONSE = {
  icao24: VALID_ICAO24,
  callsign: 'UAL123  ',
  startTime: 1709500000,
  endTime: 1709503600,
  path: [
    // [time, lat, lon, baro_alt, heading, on_ground]
    [1709500000, 40.6413, -73.7781, 0, 90.0, true],
    [1709500300, 40.7000, -73.7000, 3048, 85.0, false],
    [1709500600, 40.7500, -73.6000, 6096, 80.0, false],
    [1709500900, 40.8000, -73.5000, 9144, 75.0, false],
    [1709501200, 40.8500, -73.4000, 10668, 70.0, false],
  ],
};

/** Response with no path data */
const OPENSKY_EMPTY_RESPONSE = {
  icao24: VALID_ICAO24,
  callsign: '',
  startTime: 0,
  endTime: 0,
  path: [],
};

function makeOpenSkyResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('queryFlightHistory', () => {
  let queryFlightHistory: typeof import('./flight-history').queryFlightHistory;

  beforeEach(async () => {
    // Re-import with fresh mocks each time
    // Reset the fetch mock
    globalThis.fetch = originalFetch;

    // Dynamic import to pick up the mocked fetch
    const mod = await import('./flight-history');
    queryFlightHistory = mod.queryFlightHistory;
  });

  it('rejects empty icao24', async () => {
    const ctx = { request: new Request('http://localhost'), pathParams: {}, headers: {} };
    await assert.rejects(
      () => queryFlightHistory(ctx as any, { icao24: '', begin: 0, end: 0 }),
      (err: Error) => {
        assert.ok(err.message.includes('icao24'));
        return true;
      },
    );
  });

  it('rejects non-hex icao24', async () => {
    const ctx = { request: new Request('http://localhost'), pathParams: {}, headers: {} };
    await assert.rejects(
      () => queryFlightHistory(ctx as any, { icao24: 'zzzzzz', begin: 0, end: 0 }),
      (err: Error) => {
        assert.ok(err.message.includes('icao24'));
        return true;
      },
    );
  });

  it('rejects wrong-length icao24', async () => {
    const ctx = { request: new Request('http://localhost'), pathParams: {}, headers: {} };
    await assert.rejects(
      () => queryFlightHistory(ctx as any, { icao24: 'abc', begin: 0, end: 0 }),
      (err: Error) => {
        assert.ok(err.message.includes('icao24'));
        return true;
      },
    );
  });

  it('lowercases uppercase icao24', async () => {
    globalThis.fetch = mock.fn(async () =>
      makeOpenSkyResponse(OPENSKY_TRACK_RESPONSE),
    ) as any;

    const mod = await import('./flight-history');
    const ctx = { request: new Request('http://localhost'), pathParams: {}, headers: {} };
    const result = await mod.queryFlightHistory(ctx as any, { icao24: VALID_ICAO24_UPPER, begin: 0, end: 0 });

    assert.strictEqual(result.status, 'ok');
    // Verify the fetch was called with lowercase icao24
    const calls = (globalThis.fetch as any).mock.calls;
    assert.ok(calls.length > 0);
    const fetchUrl = calls[0].arguments[0] as string;
    assert.ok(fetchUrl.includes(VALID_ICAO24), `URL should contain lowercase icao24: ${fetchUrl}`);
  });

  it('parses OpenSky track response correctly', async () => {
    globalThis.fetch = mock.fn(async () =>
      makeOpenSkyResponse(OPENSKY_TRACK_RESPONSE),
    ) as any;

    const mod = await import('./flight-history');
    const ctx = { request: new Request('http://localhost'), pathParams: {}, headers: {} };
    const result = await mod.queryFlightHistory(ctx as any, { icao24: VALID_ICAO24, begin: 0, end: 0 });

    assert.strictEqual(result.status, 'ok');
    assert.strictEqual(result.callsign, 'UAL123');
    assert.strictEqual(result.points.length, 5);
    assert.strictEqual(result.errorMessage, '');

    // Verify first point
    const p0 = result.points[0];
    assert.ok(p0);
    assert.strictEqual(p0.latitude, 40.6413);
    assert.strictEqual(p0.longitude, -73.7781);
    assert.strictEqual(p0.altitude, 0);
    assert.strictEqual(p0.timestamp, 1709500000);
    assert.strictEqual(p0.heading, 90.0);
    assert.strictEqual(p0.onGround, true);

    // Verify last point
    const p4 = result.points[4];
    assert.ok(p4);
    assert.strictEqual(p4.latitude, 40.85);
    assert.strictEqual(p4.altitude, 10668);
    assert.strictEqual(p4.onGround, false);
  });

  it('handles empty track response', async () => {
    globalThis.fetch = mock.fn(async () =>
      makeOpenSkyResponse(OPENSKY_EMPTY_RESPONSE),
    ) as any;

    const mod = await import('./flight-history');
    const ctx = { request: new Request('http://localhost'), pathParams: {}, headers: {} };
    const result = await mod.queryFlightHistory(ctx as any, { icao24: VALID_ICAO24, begin: 0, end: 0 });

    assert.strictEqual(result.status, 'no_data');
    assert.strictEqual(result.points.length, 0);
  });

  it('handles OpenSky 404 (aircraft not found)', async () => {
    globalThis.fetch = mock.fn(async () =>
      new Response('Not Found', { status: 404 }),
    ) as any;

    const mod = await import('./flight-history');
    const ctx = { request: new Request('http://localhost'), pathParams: {}, headers: {} };
    const result = await mod.queryFlightHistory(ctx as any, { icao24: VALID_ICAO24, begin: 0, end: 0 });

    assert.strictEqual(result.status, 'not_found');
    assert.strictEqual(result.points.length, 0);
    assert.ok(result.errorMessage.length > 0);
  });

  it('handles OpenSky 429 (rate limited)', async () => {
    globalThis.fetch = mock.fn(async () =>
      new Response('Too Many Requests', { status: 429 }),
    ) as any;

    const mod = await import('./flight-history');
    const ctx = { request: new Request('http://localhost'), pathParams: {}, headers: {} };
    const result = await mod.queryFlightHistory(ctx as any, { icao24: VALID_ICAO24, begin: 0, end: 0 });

    assert.strictEqual(result.status, 'rate_limited');
    assert.ok(result.errorMessage.includes('rate'));
  });

  it('handles network errors gracefully', async () => {
    globalThis.fetch = mock.fn(async () => {
      throw new TypeError('fetch failed');
    }) as any;

    const mod = await import('./flight-history');
    const ctx = { request: new Request('http://localhost'), pathParams: {}, headers: {} };
    const result = await mod.queryFlightHistory(ctx as any, { icao24: VALID_ICAO24, begin: 0, end: 0 });

    assert.strictEqual(result.status, 'error');
    assert.ok(result.errorMessage.length > 0);
  });

  it('passes time parameter when begin > 0', async () => {
    globalThis.fetch = mock.fn(async () =>
      makeOpenSkyResponse(OPENSKY_TRACK_RESPONSE),
    ) as any;

    const mod = await import('./flight-history');
    const ctx = { request: new Request('http://localhost'), pathParams: {}, headers: {} };
    await mod.queryFlightHistory(ctx as any, { icao24: VALID_ICAO24, begin: 1709500000, end: 0 });

    const calls = (globalThis.fetch as any).mock.calls;
    assert.ok(calls.length > 0);
    const fetchUrl = calls[0].arguments[0] as string;
    assert.ok(fetchUrl.includes('time=1709500000'), `URL should contain time param: ${fetchUrl}`);
  });
});

describe('ramerDouglasPeucker', () => {
  let ramerDouglasPeucker: typeof import('./flight-history').ramerDouglasPeucker;

  beforeEach(async () => {
    const mod = await import('./flight-history');
    ramerDouglasPeucker = mod.ramerDouglasPeucker;
  });

  it('returns empty array for empty input', () => {
    assert.deepStrictEqual(ramerDouglasPeucker([], 0.001), []);
  });

  it('returns single point unchanged', () => {
    const points = [{ latitude: 0, longitude: 0, altitude: 0, timestamp: 0, velocity: 0, heading: 0, onGround: false }];
    assert.deepStrictEqual(ramerDouglasPeucker(points, 0.001), points);
  });

  it('returns two points unchanged', () => {
    const points = [
      { latitude: 0, longitude: 0, altitude: 0, timestamp: 0, velocity: 0, heading: 0, onGround: false },
      { latitude: 1, longitude: 1, altitude: 0, timestamp: 1, velocity: 0, heading: 0, onGround: false },
    ];
    assert.deepStrictEqual(ramerDouglasPeucker(points, 0.001), points);
  });

  it('removes collinear points', () => {
    const points = [
      { latitude: 0, longitude: 0, altitude: 0, timestamp: 0, velocity: 0, heading: 0, onGround: false },
      { latitude: 0.5, longitude: 0.5, altitude: 0, timestamp: 1, velocity: 0, heading: 0, onGround: false },
      { latitude: 1, longitude: 1, altitude: 0, timestamp: 2, velocity: 0, heading: 0, onGround: false },
    ];
    const result = ramerDouglasPeucker(points, 0.01);
    // Collinear mid-point should be removed
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].latitude, 0);
    assert.strictEqual(result[1].latitude, 1);
  });

  it('keeps points with significant deviation', () => {
    const points = [
      { latitude: 0, longitude: 0, altitude: 0, timestamp: 0, velocity: 0, heading: 0, onGround: false },
      { latitude: 0.5, longitude: 2, altitude: 0, timestamp: 1, velocity: 0, heading: 0, onGround: false },
      { latitude: 1, longitude: 0, altitude: 0, timestamp: 2, velocity: 0, heading: 0, onGround: false },
    ];
    const result = ramerDouglasPeucker(points, 0.01);
    // All 3 points should be kept because the middle deviates significantly
    assert.strictEqual(result.length, 3);
  });

  it('reduces a large straight-line dataset', () => {
    // Generate 1000 points along a straight line
    const points = Array.from({ length: 1000 }, (_, i) => ({
      latitude: i * 0.001,
      longitude: i * 0.001,
      altitude: 10000,
      timestamp: i,
      velocity: 250,
      heading: 45,
      onGround: false,
    }));
    const result = ramerDouglasPeucker(points, 0.001);
    // Should be drastically reduced for a straight line
    assert.ok(result.length < 10, `Expected < 10 points but got ${result.length}`);
    // First and last should always be preserved
    assert.strictEqual(result[0].timestamp, 0);
    assert.strictEqual(result[result.length - 1].timestamp, 999);
  });
});

describe('MAX_POINTS enforcement', () => {
  it('enforces 10000 point limit', async () => {
    // Generate a response with 15000 points (exceeding MAX_POINTS)
    const largePath = Array.from({ length: 15000 }, (_, i) => [
      1709500000 + i,
      40.0 + (i / 15000) * 5 + Math.sin(i * 0.1) * 0.1,
      -73.0 + (i / 15000) * 5 + Math.cos(i * 0.1) * 0.1,
      i * 10,
      90 + Math.sin(i * 0.01) * 45,
      i < 100,
    ]);

    const largeResponse = {
      icao24: VALID_ICAO24,
      callsign: 'TEST1234',
      startTime: 1709500000,
      endTime: 1709515000,
      path: largePath,
    };

    globalThis.fetch = mock.fn(async () =>
      makeOpenSkyResponse(largeResponse),
    ) as any;

    const mod = await import('./flight-history');
    const ctx = { request: new Request('http://localhost'), pathParams: {}, headers: {} };
    const result = await mod.queryFlightHistory(ctx as any, { icao24: VALID_ICAO24, begin: 0, end: 0 });

    assert.strictEqual(result.status, 'ok');
    assert.ok(result.points.length <= 10000, `Expected <= 10000 points but got ${result.points.length}`);
    assert.ok(result.points.length > 0, 'Should have at least some points');
  });
});
