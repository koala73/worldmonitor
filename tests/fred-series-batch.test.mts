import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { getCachedJsonBatch } from '../server/_shared/redis';
import { sidecarCacheSet } from '../server/_shared/sidecar-cache';
import { getFredSeriesBatch } from '../server/worldmonitor/economic/v1/get-fred-series-batch';

const ORIGINAL_ENV = {
  UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
  VERCEL_ENV: process.env.VERCEL_ENV,
  VERCEL_GIT_COMMIT_SHA: process.env.VERCEL_GIT_COMMIT_SHA,
  LOCAL_API_MODE: process.env.LOCAL_API_MODE,
};
const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_CONSOLE_WARN = console.warn;
const ORIGINAL_CONSOLE_ERROR = console.error;

function restoreEnv(name: keyof typeof ORIGINAL_ENV): void {
  const value = ORIGINAL_ENV[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  console.warn = ORIGINAL_CONSOLE_WARN;
  console.error = ORIGINAL_CONSOLE_ERROR;
  restoreEnv('UPSTASH_REDIS_REST_URL');
  restoreEnv('UPSTASH_REDIS_REST_TOKEN');
  restoreEnv('VERCEL_ENV');
  restoreEnv('VERCEL_GIT_COMMIT_SHA');
  restoreEnv('LOCAL_API_MODE');
});

function fredSeries(seriesId: string) {
  return {
    seriesId,
    title: seriesId,
    units: 'Percent',
    frequency: 'Monthly',
    lastUpdated: '2026-07-01',
    observations: [
      { date: '2026-04-01', value: 1 },
      { date: '2026-05-01', value: 2 },
      { date: '2026-06-01', value: 3 },
    ],
  };
}

function configureRemoteRedis(): void {
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  process.env.VERCEL_ENV = 'preview';
  process.env.VERCEL_GIT_COMMIT_SHA = 'abcdef123456';
  delete process.env.LOCAL_API_MODE;
}

function stubPipelineFetch(results: Array<{ result?: string }>): Array<{ url: string; init: RequestInit | undefined }> {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify(results), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return calls;
}

describe('getFredSeriesBatch', () => {
  it('reads seeded FRED series through one raw Redis pipeline request', async () => {
    configureRemoteRedis();

    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      const commands = JSON.parse(String(init?.body));
      assert.deepEqual(commands, [
        ['GET', 'economic:fred:v1:CPIAUCSL:0'],
        ['GET', 'economic:fred:v1:FEDFUNDS:0'],
      ]);
      return new Response(JSON.stringify([
        { result: JSON.stringify({ series: fredSeries('CPIAUCSL') }) },
        { result: JSON.stringify({ series: fredSeries('FEDFUNDS') }) },
      ]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    const response = await getFredSeriesBatch(
      {} as never,
      { seriesIds: ['FEDFUNDS', 'CPIAUCSL', 'NOPE', 'fedfunds'], limit: 2 },
    );

    assert.equal(calls.length, 1, 'one batch RPC should produce one Redis HTTP request');
    assert.equal(calls[0]!.url, 'https://redis.example.test/pipeline');
    assert.equal(response.requested, 2);
    assert.equal(response.fetched, 2);
    assert.deepEqual(Object.keys(response.results), ['CPIAUCSL', 'FEDFUNDS']);
    assert.deepEqual(response.results.FEDFUNDS?.observations, [
      { date: '2026-05-01', value: 2 },
      { date: '2026-06-01', value: 3 },
    ]);
  });

  it('keeps partial Redis misses out of results without changing requested count', async () => {
    configureRemoteRedis();
    stubPipelineFetch([
      { result: JSON.stringify({ series: fredSeries('CPIAUCSL') }) },
      {},
    ]);

    const response = await getFredSeriesBatch(
      {} as never,
      { seriesIds: ['FEDFUNDS', 'CPIAUCSL'], limit: 2 },
    );

    assert.equal(response.requested, 2);
    assert.equal(response.fetched, 1);
    assert.deepEqual(Object.keys(response.results), ['CPIAUCSL']);
  });

  it('returns an empty success response when every Redis key misses', async () => {
    configureRemoteRedis();
    stubPipelineFetch([{}, {}]);

    const response = await getFredSeriesBatch(
      {} as never,
      { seriesIds: ['FEDFUNDS', 'CPIAUCSL'], limit: 2 },
    );

    assert.deepEqual(response, { results: {}, fetched: 0, requested: 2 });
  });

  it('logs Redis pipeline HTTP status failures', async () => {
    configureRemoteRedis();
    const warnings: string[] = [];
    console.warn = ((...args: unknown[]) => { warnings.push(args.map(String).join(' ')); }) as typeof console.warn;
    globalThis.fetch = (async () => new Response('nope', { status: 503 })) as typeof fetch;

    const result = await getCachedJsonBatch(['economic:fred:v1:FEDFUNDS:0'], true);

    assert.equal(result.size, 0);
    assert.ok(warnings.some((line) => line.includes('[redis] getCachedJsonBatch HTTP 503')));
  });

  it('logs Redis pipeline timeout failures with the timeout marker', async () => {
    configureRemoteRedis();
    const errors: string[] = [];
    console.error = ((...args: unknown[]) => { errors.push(args.map(String).join(' ')); }) as typeof console.error;
    const timeout = new Error('deadline exceeded');
    timeout.name = 'TimeoutError';
    globalThis.fetch = (async () => { throw timeout; }) as typeof fetch;

    const result = await getCachedJsonBatch(['economic:fred:v1:FEDFUNDS:0'], true);

    assert.equal(result.size, 0);
    assert.ok(errors.some((line) => line.includes('[REDIS-TIMEOUT] getCachedJsonBatch keys=1')));
  });

  it('reads raw seed keys from the Tauri sidecar cache branch', async () => {
    process.env.LOCAL_API_MODE = 'tauri-sidecar';
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    sidecarCacheSet('economic:fred:v1:FEDFUNDS:0', { series: fredSeries('FEDFUNDS') }, 60);

    const response = await getFredSeriesBatch(
      {} as never,
      { seriesIds: ['FEDFUNDS', 'CPIAUCSL'], limit: 2 },
    );

    assert.equal(response.requested, 2);
    assert.equal(response.fetched, 1);
    assert.deepEqual(Object.keys(response.results), ['FEDFUNDS']);
  });
});
