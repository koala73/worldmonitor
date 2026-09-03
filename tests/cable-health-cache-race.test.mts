import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import type { GetCableHealthResponse } from '../src/generated/server/worldmonitor/infrastructure/v1/service_server';
import { getCachedJson, __resetKeyPrefixCacheForTests } from '../server/_shared/redis';
import { getCableHealth } from '../server/worldmonitor/infrastructure/v1/get-cable-health';

const CACHE_KEY = 'cable-health-v1';
const NGA_CACHE_KEY = 'cable-health-nga-warnings-v2';
const META_KEY = 'seed-meta:cable-health';
const NEG_SENTINEL = '__WM_NEG__';
const originalFetch = globalThis.fetch;
const originalEnv = new Map<string, string | undefined>();

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function currentNgaDate() {
  const now = new Date();
  const month = now.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }).toUpperCase();
  const day = String(now.getUTCDate()).padStart(2, '0');
  const time = `${String(now.getUTCHours()).padStart(2, '0')}${String(now.getUTCMinutes()).padStart(2, '0')}`;
  return `${day}${time}Z ${month} ${now.getUTCFullYear()}`;
}

function responseBody(response: GetCableHealthResponse) {
  return JSON.stringify(response);
}

describe('getCableHealth cache publication', { concurrency: 1 }, () => {
  beforeEach(() => {
    for (const key of ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'VERCEL_ENV', 'VERCEL_GIT_COMMIT_SHA']) {
      originalEnv.set(key, process.env[key]);
    }
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.cable-health.test';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
    process.env.VERCEL_ENV = 'production';
    delete process.env.VERCEL_GIT_COMMIT_SHA;
    __resetKeyPrefixCacheForTests();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of originalEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    originalEnv.clear();
    __resetKeyPrefixCacheForTests();
  });

  it('awaits fallback publication before health can read the served snapshot', async () => {
    const store = new Map<string, unknown>();
    const delayedKeys = new Map<string, ReturnType<typeof deferred<void>>>();
    const writesStarted = deferred<void>();
    let delayedWriteCount = 0;
    let upstreamAvailable = true;

    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.startsWith('https://redis.cable-health.test/get/')) {
        const key = decodeURIComponent(url.slice('https://redis.cable-health.test/get/'.length));
        const value = store.get(key);
        return Response.json({ result: value === undefined ? null : JSON.stringify(value) });
      }
      if (url === 'https://redis.cable-health.test/') {
        const command = JSON.parse(String(init?.body)) as [string, string, string, string, string];
        assert.equal(command[0], 'SET');
        const key = command[1];
        const value = JSON.parse(command[2]);
        const gate = delayedKeys.get(key);
        if (gate && value !== NEG_SENTINEL) {
          delayedWriteCount += 1;
          if (delayedWriteCount === delayedKeys.size) writesStarted.resolve();
          await gate.promise;
        }
        store.set(key, value);
        return Response.json({ result: 'OK' });
      }
      if (url.startsWith('https://msi.nga.mil/')) {
        return upstreamAvailable
          ? Response.json([{ text: 'FAULT REPORTED ON SUBMARINE CABLE MAREA', issueDate: currentNgaDate() }])
          : new Response('upstream unavailable', { status: 503 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const first = await getCableHealth({} as never, {} as never);
    assert.ok(Object.keys(first.cables).length > 0);

    store.delete(CACHE_KEY);
    store.delete(NGA_CACHE_KEY);
    upstreamAvailable = false;
    delayedKeys.set(CACHE_KEY, deferred<void>());
    delayedKeys.set(META_KEY, deferred<void>());

    let responseSettled = false;
    const secondPromise = getCableHealth({} as never, {} as never).then((response) => {
      responseSettled = true;
      return response;
    });

    await writesStarted.promise;
    assert.equal(store.get(NGA_CACHE_KEY), NEG_SENTINEL);
    const healthDuringFormerWindow = await getCachedJson(CACHE_KEY);
    assert.equal(healthDuringFormerWindow, null);
    await Promise.resolve();
    assert.equal(responseSettled, false);

    for (const gate of delayedKeys.values()) gate.resolve();
    const fallback = await secondPromise;
    const published = await getCachedJson(CACHE_KEY) as GetCableHealthResponse;
    const metadata = await getCachedJson(META_KEY) as { recordCount: number };

    assert.deepEqual(fallback, first);
    assert.deepEqual(published, fallback);
    assert.equal(metadata.recordCount, Object.keys(fallback.cables).length);
    assert.notEqual(published, NEG_SENTINEL);
  });

  it('keeps a legitimate empty computation as positive data', async () => {
    const store = new Map<string, unknown>();
    let upstreamCalls = 0;

    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.startsWith('https://redis.cable-health.test/get/')) {
        const key = decodeURIComponent(url.slice('https://redis.cable-health.test/get/'.length));
        const value = store.get(key);
        return Response.json({ result: value === undefined ? null : JSON.stringify(value) });
      }
      if (url === 'https://redis.cable-health.test/') {
        const command = JSON.parse(String(init?.body)) as [string, string, string];
        store.set(command[1], JSON.parse(command[2]));
        return Response.json({ result: 'OK' });
      }
      if (url.startsWith('https://msi.nga.mil/')) {
        upstreamCalls += 1;
        return Response.json([]);
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const response = await getCableHealth({} as never, {} as never);

    assert.deepEqual(response.cables, {});
    assert.deepEqual(store.get(CACHE_KEY), response);
    assert.equal(upstreamCalls, 1);
    assert.equal(store.get(META_KEY).recordCount, 0);
  });
});
