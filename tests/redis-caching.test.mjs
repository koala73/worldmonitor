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

describe('military flights bbox behavior', { concurrency: 1 }, () => {
  async function importListMilitaryFlights() {
    return importPatchedTsModule('server/worldmonitor/military/v1/list-military-flights.ts', {
      './_shared': resolve(root, 'server/worldmonitor/military/v1/_shared.ts'),
      '../../../_shared/constants': resolve(root, 'server/_shared/constants.ts'),
      '../../../_shared/redis': resolve(root, 'server/_shared/redis.ts'),
    });
  }

  const request = {
    boundingBox: {
      southWest: { latitude: 10, longitude: 10 },
      northEast: { latitude: 11, longitude: 11 },
    },
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
