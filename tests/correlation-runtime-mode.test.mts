import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  CORRELATION_RUNTIME_MODE_ENDPOINT,
  CORRELATION_RUNTIME_MODE_KEY,
  CORRELATION_RUNTIME_MODES,
  resolveCorrelationRuntimeMode,
} from '../shared/correlation-runtime-mode.js';
import {
  fetchCorrelationRuntimeMode,
} from '../src/services/correlation-runtime-mode';
import { readCorrelationRuntimeMode } from '../scripts/seed-correlation.mjs';
import correlationRuntimeModeHandler, { __testing__ as apiTesting } from '../api/correlation-runtime-mode.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const MODE_CASES: Array<[unknown, 'legacy' | 'exact' | 'fuzzy']> = [
  [undefined, 'legacy'],
  [null, 'legacy'],
  [{}, 'legacy'],
  [{ mode: 'unknown' }, 'legacy'],
  [{ mode: 'EXACT' }, 'legacy'],
  [{ mode: ' exact ' }, 'legacy'],
  [[], 'legacy'],
  [42, 'legacy'],
  ['legacy', 'legacy'],
  [{ mode: 'legacy' }, 'legacy'],
  [{ mode: 'exact' }, 'exact'],
  [{ mode: 'fuzzy' }, 'fuzzy'],
];

function redisResponse(result: unknown, status = 200): Response {
  return new Response(
    JSON.stringify([{ result }]),
    { status, headers: { 'Content-Type': 'application/json' } },
  );
}

describe('#5983 correlation runtime mode contract', () => {
  it('keeps the Railway mirror byte-identical and exposes only the three staged modes', () => {
    const canonical = readFileSync(resolve(repoRoot, 'shared/correlation-runtime-mode.js'), 'utf8');
    const mirror = readFileSync(resolve(repoRoot, 'scripts/shared/correlation-runtime-mode.js'), 'utf8');
    assert.equal(mirror, canonical);
    assert.deepEqual([...CORRELATION_RUNTIME_MODES], ['legacy', 'exact', 'fuzzy']);
    assert.equal(CORRELATION_RUNTIME_MODE_KEY, 'correlation:runtime-mode:v1');
    assert.equal(CORRELATION_RUNTIME_MODE_ENDPOINT, '/api/correlation-runtime-mode');
  });

  it('fails closed for absent, malformed, and unknown configuration', () => {
    for (const [value, expected] of MODE_CASES) {
      assert.equal(resolveCorrelationRuntimeMode(value), expected, JSON.stringify(value));
      assert.equal(apiTesting.resolveMode(value), expected, `edge mirror: ${JSON.stringify(value)}`);
    }
  });

  it('reads the browser contract without browser or HTTP caching and falls back on failures', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const exact = await fetchCorrelationRuntimeMode(async (input, init) => {
      calls.push({ input, init });
      return new Response(JSON.stringify({ mode: 'exact' }), { status: 200 });
    });

    assert.equal(exact, 'exact');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.input, CORRELATION_RUNTIME_MODE_ENDPOINT);
    assert.equal(calls[0]?.init?.cache, 'no-store');
    assert.equal(calls[0]?.init?.credentials, 'omit');

    const failure = await fetchCorrelationRuntimeMode(async () => {
      throw new Error('control plane unavailable');
    });
    assert.equal(failure, 'legacy');

    const malformed = await fetchCorrelationRuntimeMode(async () => (
      new Response('{', { status: 200 })
    ));
    assert.equal(malformed, 'legacy');

    const unavailable = await fetchCorrelationRuntimeMode(async () => (
      new Response('{}', { status: 503 })
    ));
    assert.equal(unavailable, 'legacy');
  });

  it('reads the Redis control afresh on every seeder decision and fails closed', async () => {
    let reads = 0;
    const env = {
      UPSTASH_REDIS_REST_URL: 'https://redis.example',
      UPSTASH_REDIS_REST_TOKEN: 'test-token',
    };
    const fetchImpl = async () => {
      reads++;
      return new Response(JSON.stringify({ result: JSON.stringify({ mode: 'fuzzy' }) }), { status: 200 });
    };

    assert.equal(await readCorrelationRuntimeMode({ env, fetchImpl }), 'fuzzy');
    assert.equal(await readCorrelationRuntimeMode({ env, fetchImpl }), 'fuzzy');
    assert.equal(reads, 2);

    assert.equal(
      await readCorrelationRuntimeMode({
        env,
        fetchImpl: async () => new Response(JSON.stringify({ result: '{' }), { status: 200 }),
      }),
      'legacy',
    );
    assert.equal(
      await readCorrelationRuntimeMode({ env: {}, fetchImpl }),
      'legacy',
    );
    assert.equal(
      await readCorrelationRuntimeMode({
        env,
        fetchImpl: async () => { throw new Error('redis timeout'); },
      }),
      'legacy',
    );
    assert.equal(
      await readCorrelationRuntimeMode({
        env,
        fetchImpl: async () => new Response('{}', { status: 503 }),
      }),
      'legacy',
    );
  });

  it('returns a no-store canonical decision and fails closed at the Edge read seam', async () => {
    const originalUrl = process.env.UPSTASH_REDIS_REST_URL;
    const originalToken = process.env.UPSTASH_REDIS_REST_TOKEN;
    const originalFetch = globalThis.fetch;
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';

    try {
      for (const [result, expected] of [
        [JSON.stringify({ mode: 'legacy' }), 'legacy'],
        [JSON.stringify({ mode: 'exact' }), 'exact'],
        [JSON.stringify({ mode: 'fuzzy' }), 'fuzzy'],
        [null, 'legacy'],
        ['{', 'legacy'],
      ] as const) {
        globalThis.fetch = async () => redisResponse(result);
        const response = await correlationRuntimeModeHandler(
          new Request('https://api.worldmonitor.app/api/correlation-runtime-mode', {
            headers: { Origin: 'https://worldmonitor.app' },
          }),
        );
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('Cache-Control'), 'no-store');
        assert.equal(response.headers.get('CDN-Cache-Control'), 'no-store');
        assert.deepEqual(await response.json(), { mode: expected });
      }

      globalThis.fetch = async () => redisResponse(null, 503);
      const unavailable = await correlationRuntimeModeHandler(
        new Request('https://api.worldmonitor.app/api/correlation-runtime-mode'),
      );
      assert.equal(unavailable.status, 200);
      assert.deepEqual(await unavailable.json(), { mode: 'legacy' });
      assert.equal(unavailable.headers.get('Cache-Control'), 'no-store');
    } finally {
      if (originalUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
      else process.env.UPSTASH_REDIS_REST_URL = originalUrl;
      if (originalToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
      else process.env.UPSTASH_REDIS_REST_TOKEN = originalToken;
      globalThis.fetch = originalFetch;
    }
  });

  it('refreshes the browser decision at startup and before each scheduled correlation run', () => {
    const appSource = readFileSync(resolve(repoRoot, 'src/App.ts'), 'utf8');
    const runnerStart = appSource.indexOf('private async runCorrelationEngine(): Promise<void>');
    assert.notEqual(runnerStart, -1);
    const runner = appSource.slice(runnerStart, runnerStart + 1_200);
    assert.match(runner, /fetchCorrelationRuntimeMode\(\)/);
    assert.match(runner, /engine\.run\(this\.state, runtimeMode\)/);

    const initialCall = appSource.lastIndexOf('await this.runCorrelationEngine();', runnerStart);
    const refreshCall = appSource.indexOf('await this.runCorrelationEngine();', runnerStart);
    assert.ok(initialCall > 0 && initialCall < runnerStart, 'startup must run through the mode-aware runner');
    assert.ok(refreshCall > runnerStart, 'scheduled refresh must run through the mode-aware runner');

    const seederSource = readFileSync(resolve(repoRoot, 'scripts/seed-correlation.mjs'), 'utf8');
    const computeStart = seederSource.indexOf('async function computeCorrelation()');
    assert.notEqual(computeStart, -1);
    assert.match(
      seederSource.slice(computeStart, computeStart + 260),
      /const runtimeMode = await readCorrelationRuntimeMode\(\)/,
    );
  });
});
