import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { fetchGpsInterference } from '../src/services/gps-interference.ts';
import { reverseGeocode } from '../src/utils/reverse-geocode.ts';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('public API client requests', () => {
  it('fetches GPS interference without credentials while retaining its timeout signal', async () => {
    let requestInit: RequestInit | undefined;
    globalThis.fetch = (async (_input, init) => {
      requestInit = init;
      return new Response(JSON.stringify({
        fetchedAt: '2026-08-27T00:00:00.000Z',
        source: 'gpsjam.org',
        stats: { totalHexes: 0, highCount: 0, mediumCount: 0 },
        hexes: [],
      }), { status: 200 });
    }) as typeof fetch;

    await fetchGpsInterference();

    assert.equal(requestInit?.credentials, 'omit');
    assert.ok(requestInit?.signal, 'the GPS request timeout signal must be preserved');
  });

  it('fetches reverse geocoding without credentials while retaining its abort signal', async () => {
    let requestInit: RequestInit | undefined;
    globalThis.fetch = (async (_input, init) => {
      requestInit = init;
      return new Response(JSON.stringify({ country: 'United States', code: 'US' }), { status: 200 });
    }) as typeof fetch;

    await reverseGeocode(40.7, -74);

    assert.equal(requestInit?.credentials, 'omit');
    assert.ok(requestInit?.signal, 'the reverse-geocode abort signal must be preserved');
  });
});
