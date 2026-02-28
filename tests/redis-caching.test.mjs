import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const REDIS_MODULE_URL = pathToFileURL(resolve(root, 'server/_shared/redis.ts')).href;

function jsonResponse(payload, ok = true) {
  return {
    ok,
    async json() {
      return payload;
    },
  };
}

function withEnv(overrides) {
  const previous = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value == null) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  return () => {
    for (const [key, value] of previous.entries()) {
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

async function importRedisFresh() {
  return import(`${REDIS_MODULE_URL}?t=${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

async function importPatchedTsModule(relPath, replacements) {
  const sourcePath = resolve(root, relPath);
  let source = readFileSync(sourcePath, 'utf-8');

  for (const [specifier, targetPath] of Object.entries(replacements)) {
    source = source.replaceAll(`'${specifier}'`, `'${pathToFileURL(targetPath).href}'`);
  }

  const tempDir = mkdtempSync(join(tmpdir(), 'wm-ts-module-'));
  const tempPath = join(tempDir, basename(sourcePath));
  writeFileSync(tempPath, source);

  const module = await import(`${pathToFileURL(tempPath).href}?t=${Date.now()}-${Math.random().toString(16).slice(2)}`);
  return {
    module,
    cleanup() {
      rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

describe('redis caching behavior', { concurrency: 1 }, () => {
  it('coalesces concurrent misses into one upstream fetcher execution', async () => {
    const redis = await importRedisFresh();
    const restoreEnv = withEnv({
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'token',
      VERCEL_ENV: undefined,
      VERCEL_GIT_COMMIT_SHA: undefined,
    });
    const originalFetch = globalThis.fetch;

    let getCalls = 0;
    let setCalls = 0;
    globalThis.fetch = async (url) => {
      const raw = String(url);
      if (raw.includes('/get/')) {
        getCalls += 1;
        return jsonResponse({ result: undefined });
      }
      if (raw.includes('/set/')) {
        setCalls += 1;
        return jsonResponse({ result: 'OK' });
      }
      throw new Error(`Unexpected fetch URL: ${raw}`);
    };

    try {
      let fetcherCalls = 0;
      const fetcher = async () => {
        fetcherCalls += 1;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
        return { value: 42 };
      };

      const [a, b, c] = await Promise.all([
        redis.cachedFetchJson('military:test:key', 60, fetcher),
        redis.cachedFetchJson('military:test:key', 60, fetcher),
        redis.cachedFetchJson('military:test:key', 60, fetcher),
      ]);

      assert.equal(fetcherCalls, 1, 'concurrent callers should share a single miss fetch');
      assert.deepEqual(a, { value: 42 });
      assert.deepEqual(b, { value: 42 });
      assert.deepEqual(c, { value: 42 });
      assert.equal(getCalls, 3, 'each caller should still attempt one cache read');
      assert.equal(setCalls, 1, 'only one cache write should happen after coalesced fetch');
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });

  it('parses pipeline results and skips malformed entries', async () => {
    const redis = await importRedisFresh();
    const restoreEnv = withEnv({
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'token',
      VERCEL_ENV: undefined,
      VERCEL_GIT_COMMIT_SHA: undefined,
    });
    const originalFetch = globalThis.fetch;

    let pipelineCalls = 0;
    globalThis.fetch = async (_url, init = {}) => {
      pipelineCalls += 1;
      const pipeline = JSON.parse(String(init.body));
      assert.equal(pipeline.length, 3);
      assert.deepEqual(pipeline.map((cmd) => cmd[0]), ['GET', 'GET', 'GET']);
      return jsonResponse([
        { result: JSON.stringify({ details: { id: 'a1' } }) },
        { result: '{ malformed json' },
        { result: JSON.stringify({ details: { id: 'c3' } }) },
      ]);
    };

    try {
      const map = await redis.getCachedJsonBatch(['k1', 'k2', 'k3']);
      assert.equal(pipelineCalls, 1, 'batch lookup should use one pipeline round-trip');
      assert.deepEqual(map.get('k1'), { details: { id: 'a1' } });
      assert.equal(map.has('k2'), false, 'malformed JSON entry should be skipped');
      assert.deepEqual(map.get('k3'), { details: { id: 'c3' } });
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });
});

describe('cachedFetchJsonWithMeta source labeling', { concurrency: 1 }, () => {
  it('reports source=cache on Redis hit', async () => {
    const redis = await importRedisFresh();
    const restoreEnv = withEnv({
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'token',
      VERCEL_ENV: undefined,
      VERCEL_GIT_COMMIT_SHA: undefined,
    });
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async (url) => {
      const raw = String(url);
      if (raw.includes('/get/')) {
        return jsonResponse({ result: JSON.stringify({ value: 'cached-data' }) });
      }
      throw new Error(`Unexpected fetch URL: ${raw}`);
    };

    try {
      let fetcherCalled = false;
      const { data, source } = await redis.cachedFetchJsonWithMeta('meta:test:hit', 60, async () => {
        fetcherCalled = true;
        return { value: 'fresh-data' };
      });

      assert.equal(source, 'cache', 'should report source=cache on Redis hit');
      assert.deepEqual(data, { value: 'cached-data' });
      assert.equal(fetcherCalled, false, 'fetcher should not run on cache hit');
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });

  it('reports source=fresh on cache miss', async () => {
    const redis = await importRedisFresh();
    const restoreEnv = withEnv({
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'token',
      VERCEL_ENV: undefined,
      VERCEL_GIT_COMMIT_SHA: undefined,
    });
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async (url) => {
      const raw = String(url);
      if (raw.includes('/get/')) return jsonResponse({ result: undefined });
      if (raw.includes('/set/')) return jsonResponse({ result: 'OK' });
      throw new Error(`Unexpected fetch URL: ${raw}`);
    };

    try {
      const { data, source } = await redis.cachedFetchJsonWithMeta('meta:test:miss', 60, async () => {
        return { value: 'fresh-data' };
      });

      assert.equal(source, 'fresh', 'should report source=fresh on cache miss');
      assert.deepEqual(data, { value: 'fresh-data' });
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });

  it('reports source=fresh for ALL coalesced concurrent callers', async () => {
    const redis = await importRedisFresh();
    const restoreEnv = withEnv({
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'token',
      VERCEL_ENV: undefined,
      VERCEL_GIT_COMMIT_SHA: undefined,
    });
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async (url) => {
      const raw = String(url);
      if (raw.includes('/get/')) return jsonResponse({ result: undefined });
      if (raw.includes('/set/')) return jsonResponse({ result: 'OK' });
      throw new Error(`Unexpected fetch URL: ${raw}`);
    };

    try {
      let fetcherCalls = 0;
      const fetcher = async () => {
        fetcherCalls += 1;
        await new Promise((r) => setTimeout(r, 10));
        return { value: 'coalesced' };
      };

      const [a, b, c] = await Promise.all([
        redis.cachedFetchJsonWithMeta('meta:test:coalesce', 60, fetcher),
        redis.cachedFetchJsonWithMeta('meta:test:coalesce', 60, fetcher),
        redis.cachedFetchJsonWithMeta('meta:test:coalesce', 60, fetcher),
      ]);

      assert.equal(fetcherCalls, 1, 'only one fetcher should run');
      assert.equal(a.source, 'fresh', 'leader should report fresh');
      assert.equal(b.source, 'fresh', 'follower 1 should report fresh (not cache)');
      assert.equal(c.source, 'fresh', 'follower 2 should report fresh (not cache)');
      assert.deepEqual(a.data, { value: 'coalesced' });
      assert.deepEqual(b.data, { value: 'coalesced' });
      assert.deepEqual(c.data, { value: 'coalesced' });
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });

  it('TOCTOU: reports cache when Redis is populated between concurrent reads', async () => {
    const redis = await importRedisFresh();
    const restoreEnv = withEnv({
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'token',
      VERCEL_ENV: undefined,
      VERCEL_GIT_COMMIT_SHA: undefined,
    });
    const originalFetch = globalThis.fetch;

    // First call: cache miss. Second call (from a "different instance"): cache hit.
    let getCalls = 0;
    globalThis.fetch = async (url) => {
      const raw = String(url);
      if (raw.includes('/get/')) {
        getCalls += 1;
        if (getCalls === 1) return jsonResponse({ result: undefined });
        // Simulate another instance populating cache between calls
        return jsonResponse({ result: JSON.stringify({ value: 'from-other-instance' }) });
      }
      if (raw.includes('/set/')) return jsonResponse({ result: 'OK' });
      throw new Error(`Unexpected fetch URL: ${raw}`);
    };

    try {
      // First call: miss → fetcher runs → fresh
      const first = await redis.cachedFetchJsonWithMeta('meta:test:toctou', 60, async () => {
        return { value: 'fetched' };
      });
      assert.equal(first.source, 'fresh');
      assert.deepEqual(first.data, { value: 'fetched' });

      // Second call (fresh module import to clear inflight map): cache hit from other instance
      const redis2 = await importRedisFresh();
      const second = await redis2.cachedFetchJsonWithMeta('meta:test:toctou', 60, async () => {
        throw new Error('fetcher should not run on cache hit');
      });
      assert.equal(second.source, 'cache', 'should report cache when Redis has data');
      assert.deepEqual(second.data, { value: 'from-other-instance' });
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });
});

describe('negative-result caching', { concurrency: 1 }, () => {
  it('caches sentinel on null fetcher result and suppresses subsequent upstream calls', async () => {
    const redis = await importRedisFresh();
    const restoreEnv = withEnv({
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'token',
      VERCEL_ENV: undefined,
      VERCEL_GIT_COMMIT_SHA: undefined,
    });
    const originalFetch = globalThis.fetch;

    const store = new Map();
    globalThis.fetch = async (url) => {
      const raw = String(url);
      if (raw.includes('/get/')) {
        const key = decodeURIComponent(raw.split('/get/').pop() || '');
        const val = store.get(key);
        return jsonResponse({ result: val ?? undefined });
      }
      if (raw.includes('/set/')) {
        const parts = raw.split('/set/').pop().split('/');
        const key = decodeURIComponent(parts[0]);
        const value = decodeURIComponent(parts[1]);
        store.set(key, value);
        return jsonResponse({ result: 'OK' });
      }
      throw new Error(`Unexpected fetch URL: ${raw}`);
    };

    try {
      let fetcherCalls = 0;
      const fetcher = async () => {
        fetcherCalls += 1;
        return null;
      };

      const first = await redis.cachedFetchJson('neg:test:suppress', 300, fetcher);
      assert.equal(first, null, 'first call should return null');
      assert.equal(fetcherCalls, 1, 'fetcher should run on first call');

      const redis2 = await importRedisFresh();
      const second = await redis2.cachedFetchJson('neg:test:suppress', 300, fetcher);
      assert.equal(second, null, 'second call should return null from sentinel');
      assert.equal(fetcherCalls, 1, 'fetcher should NOT run again — sentinel suppresses');
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });

  it('cachedFetchJsonWithMeta returns data:null source:cache on sentinel hit', async () => {
    const redis = await importRedisFresh();
    const restoreEnv = withEnv({
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'token',
      VERCEL_ENV: undefined,
      VERCEL_GIT_COMMIT_SHA: undefined,
    });
    const originalFetch = globalThis.fetch;

    const store = new Map();
    globalThis.fetch = async (url) => {
      const raw = String(url);
      if (raw.includes('/get/')) {
        const key = decodeURIComponent(raw.split('/get/').pop() || '');
        const val = store.get(key);
        return jsonResponse({ result: val ?? undefined });
      }
      if (raw.includes('/set/')) {
        const parts = raw.split('/set/').pop().split('/');
        const key = decodeURIComponent(parts[0]);
        const value = decodeURIComponent(parts[1]);
        store.set(key, value);
        return jsonResponse({ result: 'OK' });
      }
      throw new Error(`Unexpected fetch URL: ${raw}`);
    };

    try {
      const first = await redis.cachedFetchJsonWithMeta('neg:meta:sentinel', 300, async () => null);
      assert.equal(first.data, null);
      assert.equal(first.source, 'fresh', 'first null result is fresh');

      const redis2 = await importRedisFresh();
      const second = await redis2.cachedFetchJsonWithMeta('neg:meta:sentinel', 300, async () => {
        throw new Error('fetcher should not run on sentinel hit');
      });
      assert.equal(second.data, null, 'sentinel should resolve to null data, not the sentinel string');
      assert.equal(second.source, 'cache', 'sentinel hit should report source=cache');
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });

  it('does not cache sentinel when fetcher throws', async () => {
    const redis = await importRedisFresh();
    const restoreEnv = withEnv({
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'token',
      VERCEL_ENV: undefined,
      VERCEL_GIT_COMMIT_SHA: undefined,
    });
    const originalFetch = globalThis.fetch;

    let setCalls = 0;
    globalThis.fetch = async (url) => {
      const raw = String(url);
      if (raw.includes('/get/')) return jsonResponse({ result: undefined });
      if (raw.includes('/set/')) {
        setCalls += 1;
        return jsonResponse({ result: 'OK' });
      }
      throw new Error(`Unexpected fetch URL: ${raw}`);
    };

    try {
      let fetcherCalls = 0;
      const throwingFetcher = async () => {
        fetcherCalls += 1;
        throw new Error('upstream ETIMEDOUT');
      };

      await assert.rejects(() => redis.cachedFetchJson('neg:test:throw', 300, throwingFetcher));
      assert.equal(fetcherCalls, 1);
      assert.equal(setCalls, 0, 'no sentinel should be cached when fetcher throws');

      const redis2 = await importRedisFresh();
      await assert.rejects(() => redis2.cachedFetchJson('neg:test:throw', 300, throwingFetcher));
      assert.equal(fetcherCalls, 2, 'fetcher should run again after a thrown error (no sentinel)');
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });
});

describe('theater posture caching behavior', { concurrency: 1 }, () => {
  async function importTheaterPosture() {
    return importPatchedTsModule('server/worldmonitor/military/v1/get-theater-posture.ts', {
      './_shared': resolve(root, 'server/worldmonitor/military/v1/_shared.ts'),
      '../../../_shared/constants': resolve(root, 'server/_shared/constants.ts'),
      '../../../_shared/redis': resolve(root, 'server/_shared/redis.ts'),
    });
  }

  function mockOpenSkyResponse() {
    return jsonResponse({
      states: [
        ['ae1234', 'RCH001', null, null, null, 50.0, 36.0, 30000, false, 400, 90],
        ['ae5678', 'DUKE02', null, null, null, 51.0, 35.0, 25000, false, 350, 180],
      ],
    });
  }

  it('coalesces concurrent calls into a single upstream fetch', async () => {
    const { module, cleanup } = await importTheaterPosture();
    const restoreEnv = withEnv({
      LOCAL_API_MODE: 'sidecar',
      WS_RELAY_URL: undefined,
      WINGBITS_API_KEY: undefined,
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'token',
      VERCEL_ENV: undefined,
      VERCEL_GIT_COMMIT_SHA: undefined,
    });
    const originalFetch = globalThis.fetch;

    let openskyFetchCount = 0;
    globalThis.fetch = async (url) => {
      const raw = String(url);
      if (raw.includes('/get/') || raw.includes('/pipeline')) {
        return jsonResponse({ result: undefined });
      }
      if (raw.includes('/set/')) {
        return jsonResponse({ result: 'OK' });
      }
      if (raw.includes('opensky-network.org')) {
        openskyFetchCount += 1;
        await new Promise((r) => setTimeout(r, 10));
        return mockOpenSkyResponse();
      }
      return jsonResponse({}, false);
    };

    try {
      const [a, b, c] = await Promise.all([
        module.getTheaterPosture({}, {}),
        module.getTheaterPosture({}, {}),
        module.getTheaterPosture({}, {}),
      ]);

      assert.equal(openskyFetchCount, 2, 'coalesced into one fetcher invocation × 2 theater query regions');
      assert.ok(a.theaters.length > 0, 'should return theater posture data');
      assert.deepEqual(a, b, 'all callers should receive the same result');
      assert.deepEqual(b, c, 'all callers should receive the same result');
    } finally {
      cleanup();
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });

  it('falls back to stale/backup when both upstreams are down', async () => {
    const { module, cleanup } = await importTheaterPosture();
    const restoreEnv = withEnv({
      LOCAL_API_MODE: 'sidecar',
      WS_RELAY_URL: undefined,
      WINGBITS_API_KEY: undefined,
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'token',
      VERCEL_ENV: undefined,
      VERCEL_GIT_COMMIT_SHA: undefined,
    });
    const originalFetch = globalThis.fetch;

    const staleData = { theaters: [{ theater: 'stale-test', postureLevel: 'normal', activeFlights: 1, trackedVessels: 0, activeOperations: [], assessedAt: 1 }] };

    globalThis.fetch = async (url) => {
      const raw = String(url);
      if (raw.includes('/get/')) {
        const key = decodeURIComponent(raw.split('/get/').pop() || '');
        if (key === 'theater-posture:sebuf:v1') {
          return jsonResponse({ result: undefined });
        }
        if (key === 'theater-posture:sebuf:stale:v1') {
          return jsonResponse({ result: JSON.stringify(staleData) });
        }
        return jsonResponse({ result: undefined });
      }
      if (raw.includes('/set/')) {
        return jsonResponse({ result: 'OK' });
      }
      if (raw.includes('opensky-network.org')) {
        throw new Error('OpenSky down');
      }
      return jsonResponse({}, false);
    };

    try {
      const result = await module.getTheaterPosture({}, {});
      assert.deepEqual(result, staleData, 'should return stale cache when upstreams fail');
    } finally {
      cleanup();
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });

  it('returns empty theaters when all tiers exhausted', async () => {
    const { module, cleanup } = await importTheaterPosture();
    const restoreEnv = withEnv({
      LOCAL_API_MODE: 'sidecar',
      WS_RELAY_URL: undefined,
      WINGBITS_API_KEY: undefined,
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'token',
      VERCEL_ENV: undefined,
      VERCEL_GIT_COMMIT_SHA: undefined,
    });
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async (url) => {
      const raw = String(url);
      if (raw.includes('/get/')) {
        return jsonResponse({ result: undefined });
      }
      if (raw.includes('/set/')) {
        return jsonResponse({ result: 'OK' });
      }
      if (raw.includes('opensky-network.org')) {
        throw new Error('OpenSky down');
      }
      return jsonResponse({}, false);
    };

    try {
      const result = await module.getTheaterPosture({}, {});
      assert.deepEqual(result, { theaters: [] }, 'should return empty when all tiers exhausted');
    } finally {
      cleanup();
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });

  it('awaits stale/backup writes before returning', async () => {
    const { module, cleanup } = await importTheaterPosture();
    const restoreEnv = withEnv({
      LOCAL_API_MODE: 'sidecar',
      WS_RELAY_URL: undefined,
      WINGBITS_API_KEY: undefined,
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'token',
      VERCEL_ENV: undefined,
      VERCEL_GIT_COMMIT_SHA: undefined,
    });
    const originalFetch = globalThis.fetch;

    const cacheWrites = [];
    globalThis.fetch = async (url) => {
      const raw = String(url);
      if (raw.includes('/get/')) {
        return jsonResponse({ result: undefined });
      }
      if (raw.includes('/set/')) {
        const key = decodeURIComponent(raw.split('/set/').pop()?.split('/').shift() || '');
        cacheWrites.push(key);
        return jsonResponse({ result: 'OK' });
      }
      if (raw.includes('opensky-network.org')) {
        return mockOpenSkyResponse();
      }
      return jsonResponse({}, false);
    };

    try {
      await module.getTheaterPosture({}, {});
      const staleWritten = cacheWrites.some((k) => k.includes('stale'));
      const backupWritten = cacheWrites.some((k) => k.includes('backup'));
      assert.ok(staleWritten, 'stale tier should be written before response returns');
      assert.ok(backupWritten, 'backup tier should be written before response returns');
    } finally {
      cleanup();
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });
});

describe('military flights bbox behavior', { concurrency: 1 }, () => {
  async function importListMilitaryFlights() {
    return importPatchedTsModule('server/worldmonitor/military/v1/list-military-flights.ts', {
      './_shared': resolve(root, 'server/worldmonitor/military/v1/_shared.ts'),
      '../../../_shared/constants': resolve(root, 'server/_shared/constants.ts'),
      '../../../_shared/redis': resolve(root, 'server/_shared/redis.ts'),
      '../../../_shared/response-headers': resolve(root, 'server/_shared/response-headers.ts'),
    });
  }

  const request = {
    swLat: 10,
    swLon: 10,
    neLat: 11,
    neLon: 11,
  };

  it('fetches expanded quantized bbox but returns only flights inside the requested bbox', async () => {
    const { module, cleanup } = await importListMilitaryFlights();
    const restoreEnv = withEnv({
      LOCAL_API_MODE: 'sidecar',
      WS_RELAY_URL: undefined,
      UPSTASH_REDIS_REST_URL: undefined,
      UPSTASH_REDIS_REST_TOKEN: undefined,
    });
    const originalFetch = globalThis.fetch;

    const fetchUrls = [];
    globalThis.fetch = async (url) => {
      const raw = String(url);
      fetchUrls.push(raw);
      if (!raw.includes('opensky-network.org/api/states/all')) {
        throw new Error(`Unexpected fetch URL: ${raw}`);
      }
      return jsonResponse({
        states: [
          ['in-bounds', 'RCH123', null, null, null, 10.5, 10.5, 20000, false, 300, 90],
          ['south-out', 'RCH124', null, null, null, 10.4, 9.7, 22000, false, 280, 95],
          ['east-out', 'RCH125', null, null, null, 11.3, 10.6, 21000, false, 290, 92],
        ],
      });
    };

    try {
      const result = await module.listMilitaryFlights({}, request);
      assert.deepEqual(
        result.flights.map((flight) => flight.id),
        ['in-bounds'],
        'response should not include out-of-viewport flights',
      );

      assert.equal(fetchUrls.length, 1);
      const params = new URL(fetchUrls[0]).searchParams;
      assert.equal(params.get('lamin'), '9.5');
      assert.equal(params.get('lamax'), '11.5');
      assert.equal(params.get('lomin'), '9.5');
      assert.equal(params.get('lomax'), '11.5');
    } finally {
      cleanup();
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });

  it('filters cached quantized-cell results back to the requested bbox', async () => {
    const { module, cleanup } = await importListMilitaryFlights();
    const restoreEnv = withEnv({
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'token',
      LOCAL_API_MODE: undefined,
      WS_RELAY_URL: undefined,
      VERCEL_ENV: undefined,
      VERCEL_GIT_COMMIT_SHA: undefined,
    });
    const originalFetch = globalThis.fetch;

    let openskyCalls = 0;
    let redisGetCalls = 0;
    globalThis.fetch = async (url) => {
      const raw = String(url);
      if (raw.includes('/get/')) {
        redisGetCalls += 1;
        return jsonResponse({
          result: JSON.stringify({
            flights: [
              { id: 'cache-in', location: { latitude: 10.2, longitude: 10.2 } },
              { id: 'cache-out', location: { latitude: 9.8, longitude: 10.2 } },
            ],
            clusters: [],
          }),
        });
      }
      if (raw.includes('opensky-network.org/api/states/all')) {
        openskyCalls += 1;
      }
      throw new Error(`Unexpected fetch URL: ${raw}`);
    };

    try {
      const result = await module.listMilitaryFlights({}, request);
      assert.equal(redisGetCalls, 1, 'handler should read quantized cache first');
      assert.equal(openskyCalls, 0, 'cache hit should avoid upstream fetch');
      assert.deepEqual(
        result.flights.map((flight) => flight.id),
        ['cache-in'],
        'cached quantized-cell payload must be re-filtered to request bbox',
      );
    } finally {
      cleanup();
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });
});
