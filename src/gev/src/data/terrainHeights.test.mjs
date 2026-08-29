// src/data/terrainHeights.test.mjs — batched, cached client terrain-height
// resolver.
//
// Locks the module's public interface (Task 5/6 call it verbatim):
//   resolveEllipsoidalGround(coords: [{lat, lon, sourceOrthometricM?}])
//     : Promise<Array<{ellipsoid:number, source:'reearth'|'geoid-fallback'}>>
//   cachedEllipsoidalGround(lat, lon): number|null
//
// `fetch` is injected via `globalThis.fetch` (no real network) so these tests
// run offline like every other suite in this repo. Each test installs its own
// fake and restores the original in a `finally` so injection never leaks
// across test files (node:test runs this file's tests sequentially, but the
// module-level in-memory cache in terrainHeights.js DOES persist across
// tests within this file — tests below use distinct coordinates per case to
// avoid cross-test cache contamination, except the dedicated cache tests
// which rely on that persistence deliberately).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveEllipsoidalGround,
  cachedEllipsoidalGround,
} from './terrainHeights.js';

const AUSTIN = { lat: 30.2672, lon: -97.7431 };
const AUSTIN_GEOID_N = -26.9; // Cross-checked against Re:Earth reference data.

/** Installs a fake fetch for the duration of `fn`, restoring the original after. */
async function withFakeFetch(fakeFetch, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

/** Builds a fake proxy response matching the real `/api/gev/terrain/heights` shape. */
function proxyResponse(points) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      results: points.map(([lon, lat]) => ({
        lon,
        lat,
        elevation: 0,
        geoid: 0,
        ellipsoid: lon + lat, // arbitrary deterministic value keyed by input, for order-mapping assertions
      })),
    }),
  };
}

test('resolveEllipsoidalGround: happy path maps results IN ORDER', async () => {
  const coords = [
    { lat: 1, lon: 10 },
    { lat: 2, lon: 20 },
    { lat: 3, lon: 30 },
  ];
  let capturedUrl = null;
  await withFakeFetch(
    async (url) => {
      capturedUrl = String(url);
      // Order in the URL must match the input coord order (lon,lat pairs).
      return proxyResponse([[10, 1], [20, 2], [30, 3]]);
    },
    async () => {
      const out = await resolveEllipsoidalGround(coords);
      assert.equal(out.length, 3);
      assert.deepEqual(
        out.map((r) => r.ellipsoid),
        [11, 22, 33] // lon+lat for each, in input order
      );
      for (const r of out) assert.equal(r.source, 'reearth');
    }
  );
  assert.ok(capturedUrl.includes('/api/gev/terrain/heights'));
  assert.ok(capturedUrl.includes('points='));
});

test('resolveEllipsoidalGround: a 300-point input issues exactly 2 fetches (chunked at <=200/request) AND preserves order across the chunk boundary', async () => {
  // Each coord carries a DISTINGUISHABLE lat/lon derived from its index so
  // the oracle below can be an independent function of the point's INPUT
  // identity — not an echo of whatever the request happened to send. This is
  // what makes the positional assertions able to catch an index-shift or a
  // within-chunk reversal in fetchChunk's zip (chunk[i].key vs
  // body.results[i]); the brief's guard is "point[250] must map to
  // result[250]".
  //   lat(i) = i * 0.001, lon(i) = -i * 0.001  → unique per i, both 5dp-clean
  const oracle = (lat, lon) => lat * 1_000_000 + lon; // deterministic, encodes the index (via lat) unambiguously
  const coords = Array.from({ length: 300 }, (_, i) => ({
    lat: i * 0.001,
    lon: -i * 0.001,
  }));
  let fetchCount = 0;
  const chunkSizes = [];
  await withFakeFetch(
    async (url) => {
      fetchCount += 1;
      const u = new URL(String(url), 'http://internal');
      const pts = u.searchParams.get('points').split(';');
      chunkSizes.push(pts.length);
      // Independent oracle: compute ellipsoid = oracle(lat, lon) per point
      // FROM THE PARSED lon,lat the module actually sent, in the order it
      // sent them. The module (fetchChunk) maps our results back positionally
      // to its chunk items; if it mis-zips, the positional asserts below fail.
      return {
        ok: true,
        status: 200,
        json: async () => ({
          results: pts.map((p) => {
            const [lon, lat] = p.split(',').map(Number);
            return { lon, lat, elevation: 0, geoid: 0, ellipsoid: oracle(lat, lon) };
          }),
        }),
      };
    },
    async () => {
      const out = await resolveEllipsoidalGround(coords);
      assert.equal(out.length, 300);
      // Positional correctness at and across the chunk boundary (chunk 1 =
      // [0,199], chunk 2 = [200,299]): each output must equal the oracle of
      // its OWN input coord. The module rounds to 5dp before sending, so
      // compare against the oracle of the rounded coord to stay exact.
      for (const k of [0, 1, 199, 200, 299]) {
        const lat = Number(coords[k].lat.toFixed(5));
        const lon = Number(coords[k].lon.toFixed(5));
        assert.equal(
          out[k].ellipsoid,
          oracle(lat, lon),
          `out[${k}] must map to the oracle of coords[${k}] (order held within+across chunks)`
        );
        assert.equal(out[k].source, 'reearth');
      }
    }
  );
  assert.equal(fetchCount, 2, `expected 2 fetches for 300 points at <=200/chunk, got ${fetchCount}`);
  for (const size of chunkSizes) {
    assert.ok(size <= 200, `chunk size ${size} exceeds the 200-point ceiling`);
  }
  assert.equal(
    chunkSizes.reduce((a, b) => a + b, 0),
    300,
    'chunk sizes must sum to the total input length'
  );
});

test('resolveEllipsoidalGround: proxy failure falls back to sourceOrthometricM + geoidHeight (Austin)', async () => {
  await withFakeFetch(
    async () => {
      throw new Error('simulated network failure');
    },
    async () => {
      const out = await resolveEllipsoidalGround([
        { lat: AUSTIN.lat, lon: AUSTIN.lon, sourceOrthometricM: 150 },
      ]);
      assert.equal(out.length, 1);
      const expected = 150 + AUSTIN_GEOID_N; // ≈ 123.1
      assert.ok(
        Math.abs(out[0].ellipsoid - expected) <= 2.5,
        `expected ≈${expected} (±2.5), got ${out[0].ellipsoid}`
      );
      assert.ok(
        Math.abs(out[0].ellipsoid - 123) <= 2.5,
        `expected ≈123 (±2.5) per the brief's worked example, got ${out[0].ellipsoid}`
      );
      assert.equal(out[0].source, 'geoid-fallback');
    }
  );
});

test('resolveEllipsoidalGround: proxy failure + no sourceOrthometricM falls back to geoidHeight alone (H≈0 coast prior)', async () => {
  const point = { lat: 51.0, lon: -1.0 }; // arbitrary, distinct from other tests' cache keys
  await withFakeFetch(
    async () => {
      throw new Error('simulated network failure');
    },
    async () => {
      const out = await resolveEllipsoidalGround([point]);
      assert.equal(out.length, 1);
      assert.equal(out[0].source, 'geoid-fallback');
      // H treated as 0 -> ellipsoid == geoidHeight(lat,lon) alone, finite and plausible.
      assert.ok(Number.isFinite(out[0].ellipsoid));
      assert.ok(Math.abs(out[0].ellipsoid) < 200, 'geoid undulation should be within the -106..+85 m worldwide range (with margin)');
    }
  );
});

test('resolveEllipsoidalGround: a repeated coord issues NO second fetch (in-memory cache)', async () => {
  const point = { lat: 12.34567, lon: 56.78901 };
  let fetchCount = 0;
  await withFakeFetch(
    async (url) => {
      fetchCount += 1;
      const u = new URL(String(url), 'http://internal');
      const pts = u.searchParams.get('points').split(';').map((p) => p.split(',').map(Number));
      return proxyResponse(pts);
    },
    async () => {
      const first = await resolveEllipsoidalGround([point]);
      const second = await resolveEllipsoidalGround([point]);
      assert.equal(first[0].ellipsoid, second[0].ellipsoid);
      assert.equal(second[0].source, 'reearth');
    }
  );
  assert.equal(fetchCount, 1, `expected exactly 1 fetch across both calls (cache hit on the 2nd), got ${fetchCount}`);
});

test('resolveEllipsoidalGround: repeated coord within the SAME batch also only fetches once', async () => {
  const point = { lat: 22.5001, lon: 33.5001 };
  let fetchCount = 0;
  let lastPointCount = 0;
  await withFakeFetch(
    async (url) => {
      fetchCount += 1;
      const u = new URL(String(url), 'http://internal');
      const pts = u.searchParams.get('points').split(';');
      lastPointCount = pts.length;
      const parsed = pts.map((p) => p.split(',').map(Number));
      return proxyResponse(parsed);
    },
    async () => {
      const out = await resolveEllipsoidalGround([point, point, point]);
      assert.equal(out.length, 3);
      assert.equal(out[0].ellipsoid, out[1].ellipsoid);
      assert.equal(out[1].ellipsoid, out[2].ellipsoid);
    }
  );
  assert.equal(fetchCount, 1);
  assert.equal(lastPointCount, 1, 'the duplicate point should be de-duplicated before hitting the network');
});

test('resolveEllipsoidalGround: rounds coordinates to 5 decimals for the cache key (near-identical points share one fetch)', async () => {
  const a = { lat: 44.111112, lon: 55.222223 };
  const b = { lat: 44.1111124, lon: 55.2222234 }; // rounds to the same 5dp key as `a`
  let fetchCount = 0;
  await withFakeFetch(
    async (url) => {
      fetchCount += 1;
      const u = new URL(String(url), 'http://internal');
      const pts = u.searchParams.get('points').split(';').map((p) => p.split(',').map(Number));
      return proxyResponse(pts);
    },
    async () => {
      await resolveEllipsoidalGround([a]);
      await resolveEllipsoidalGround([b]);
    }
  );
  assert.equal(fetchCount, 1, 'points identical at 5-decimal rounding should share the in-memory cache');
});

test('cachedEllipsoidalGround: returns the prior resolved ellipsoid value synchronously', async () => {
  const point = { lat: 9.87654, lon: 8.76543 };
  assert.equal(cachedEllipsoidalGround(point.lat, point.lon), null, 'cold cache must return null');
  await withFakeFetch(
    async (url) => {
      const u = new URL(String(url), 'http://internal');
      const pts = u.searchParams.get('points').split(';').map((p) => p.split(',').map(Number));
      return proxyResponse(pts);
    },
    async () => {
      const [result] = await resolveEllipsoidalGround([point]);
      const cached = cachedEllipsoidalGround(point.lat, point.lon);
      assert.equal(cached, result.ellipsoid);
    }
  );
});

test('cachedEllipsoidalGround: returns null for a coordinate never resolved', () => {
  assert.equal(cachedEllipsoidalGround(-89.99999, 179.99999), null);
});

test('cachedEllipsoidalGround: also populated by the geoid-fallback path (cache stores fallback results too)', async () => {
  const point = { lat: -33.5, lon: 151.2 }; // distinct coord, unused elsewhere
  await withFakeFetch(
    async () => {
      throw new Error('simulated network failure');
    },
    async () => {
      const [result] = await resolveEllipsoidalGround([point]);
      const cached = cachedEllipsoidalGround(point.lat, point.lon);
      assert.equal(cached, result.ellipsoid);
    }
  );
});

test('resolveEllipsoidalGround: a non-ok HTTP response is treated as failure and falls back', async () => {
  const point = { lat: 61.001, lon: -149.001 }; // distinct coord
  await withFakeFetch(
    async () => ({ ok: false, status: 500, json: async () => ({ error: 'boom' }) }),
    async () => {
      const out = await resolveEllipsoidalGround([
        { ...point, sourceOrthometricM: 10 },
      ]);
      assert.equal(out[0].source, 'geoid-fallback');
      assert.ok(Number.isFinite(out[0].ellipsoid));
    }
  );
});

test('resolveEllipsoidalGround: geoid fallback cools down retries, then self-heals after 60s', async () => {
  const point = { lat: 64.20001, lon: -21.90001, sourceOrthometricM: 25 };
  const originalNow = Date.now;
  let now = 5_000_000;
  let fetchCount = 0;
  Date.now = () => now;
  try {
    await withFakeFetch(
      async (url) => {
        fetchCount += 1;
        if (fetchCount === 1) throw new Error('simulated outage');
        const u = new URL(String(url), 'http://internal');
        const points = u.searchParams.get('points').split(';').map((pair) => pair.split(',').map(Number));
        return proxyResponse(points);
      },
      async () => {
        const first = await resolveEllipsoidalGround([point]);
        assert.equal(first[0].source, 'geoid-fallback');

        const cooling = await resolveEllipsoidalGround([point]);
        assert.equal(cooling[0].source, 'geoid-fallback');
        assert.equal(fetchCount, 1, 'a warm request during cooldown must not hit the failing proxy');

        now += 60_001;
        const healed = await resolveEllipsoidalGround([point]);
        assert.equal(fetchCount, 2, 'the point should retry after cooldown');
        assert.equal(healed[0].source, 'reearth');

        await resolveEllipsoidalGround([point]);
        assert.equal(fetchCount, 2, 'a successful retry replaces fallback and clears retry work');
      }
    );
  } finally {
    Date.now = originalNow;
  }
});

test('resolveEllipsoidalGround: an empty input array resolves to an empty array without fetching', async () => {
  let fetchCount = 0;
  await withFakeFetch(
    async () => {
      fetchCount += 1;
      return proxyResponse([]);
    },
    async () => {
      const out = await resolveEllipsoidalGround([]);
      assert.deepEqual(out, []);
    }
  );
  assert.equal(fetchCount, 0);
});
