import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const originalFetch = globalThis.fetch;
const originalAbortSignalTimeout = AbortSignal.timeout;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function installFastAbortTimeout(delayMs = 5): void {
  Object.defineProperty(AbortSignal, 'timeout', {
    configurable: true,
    writable: true,
    value: () => {
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), delayMs);
      return ctrl.signal;
    },
  });
}

function restoreGlobals(): void {
  globalThis.fetch = originalFetch;
  Object.defineProperty(AbortSignal, 'timeout', {
    configurable: true,
    writable: true,
    value: originalAbortSignalTimeout,
  });
}

async function loadFreshCountryGeometryModule() {
  return import(`../src/services/country-geometry.ts?test=${Date.now()}-${Math.random()}`);
}

function makeFeatureCollection(maxCoord: number) {
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {
          name: 'Pakistan',
          'ISO3166-1-Alpha-2': 'PK',
          'ISO3166-1-Alpha-3': 'PAK',
        },
        geometry: {
          type: 'Polygon',
          coordinates: [[
            [0, 0],
            [maxCoord, 0],
            [maxCoord, maxCoord],
            [0, maxCoord],
            [0, 0],
          ]],
        },
      },
    ],
  };
}

afterEach(() => {
  restoreGlobals();
});

describe('country geometry overrides', () => {
  it('loads bundled geometry when override fetch times out', async () => {
    installFastAbortTimeout();
    let overrideAborted = false;

    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url === 'https://maps.worldmonitor.app/countries.geojson') {
        return Promise.resolve(jsonResponse(makeFeatureCollection(1)));
      }
      if (url === 'https://maps.worldmonitor.app/country-boundary-overrides.geojson') {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            overrideAborted = true;
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          }, { once: true });
        });
      }
      return Promise.reject(new Error(`Unexpected URL: ${url}`));
    }) as typeof fetch;

    const countryGeometry = await loadFreshCountryGeometryModule();
    const start = Date.now();
    await countryGeometry.preloadCountryGeometry();
    const elapsedMs = Date.now() - start;

    assert.equal(overrideAborted, true);
    assert.ok(elapsedMs < 2000, `Expected preload to complete within timeout, got ${elapsedMs}ms`);
    assert.deepEqual(countryGeometry.getCountryBbox('PK'), [0, 0, 1, 1]);
  });

  it('applies override geometry when the CDN responds in time', async () => {
    globalThis.fetch = ((input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url === 'https://maps.worldmonitor.app/countries.geojson') {
        return Promise.resolve(jsonResponse(makeFeatureCollection(1)));
      }
      if (url === 'https://maps.worldmonitor.app/country-boundary-overrides.geojson') {
        return Promise.resolve(jsonResponse(makeFeatureCollection(2)));
      }
      return Promise.reject(new Error(`Unexpected URL: ${url}`));
    }) as typeof fetch;

    const countryGeometry = await loadFreshCountryGeometryModule();
    await countryGeometry.preloadCountryGeometry();

    assert.deepEqual(countryGeometry.getCountryBbox('PK'), [0, 0, 2, 2]);
    assert.deepEqual(countryGeometry.getCountryAtCoordinates(1.5, 1.5), {
      code: 'PK',
      name: 'Pakistan',
    });
  });
});
