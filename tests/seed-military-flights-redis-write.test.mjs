import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import {
  preserveMilitaryPublicationTtls,
  redisDel,
  redisGet,
  redisSet,
} from '../scripts/seed-military-flights.mjs';

const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;
const originalRedisUrl = process.env.UPSTASH_REDIS_REST_URL;
const originalRedisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

beforeEach(() => {
  globalThis.setTimeout = (callback, _delay, ...args) => {
    queueMicrotask(() => callback(...args));
    return 0;
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalSetTimeout;
  if (originalRedisUrl == null) delete process.env.UPSTASH_REDIS_REST_URL;
  else process.env.UPSTASH_REDIS_REST_URL = originalRedisUrl;
  if (originalRedisToken == null) delete process.env.UPSTASH_REDIS_REST_TOKEN;
  else process.env.UPSTASH_REDIS_REST_TOKEN = originalRedisToken;
});

test('redisSet rejects an Upstash command error returned with HTTP 200', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({
      error: 'WRONGTYPE Operation against a key holding the wrong kind of value',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  await assert.rejects(
    redisSet('https://redis.test', 'test-token', 'military:flights:v1', { flights: [] }, 600),
    /Redis SET military:flights:v1 rejected by Upstash: WRONGTYPE/,
  );
  assert.equal(calls, 3, 'command-level failures use the bounded Redis retry contract');
});

test('redisSet accepts a successful response with a null error field', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ result: 'OK', error: null }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

  await redisSet('https://redis.test', 'test-token', 'military:flights:v1', { flights: [] }, 600);
});

test('redisSet wraps a non-JSON HTTP 200 response with the key context', async () => {
  globalThis.fetch = async () => new Response('temporarily unavailable', { status: 200 });

  await assert.rejects(
    redisSet('https://redis.test', 'test-token', 'military:flights:v1', { flights: [] }, 600),
    /Redis SET military:flights:v1 returned invalid JSON \(HTTP 200\)/,
  );
});

test('redisSet retains an HTTP failure response body in the error', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response('request payload exceeds the database limit', { status: 413 });
  };

  await assert.rejects(
    redisSet('https://redis.test', 'test-token', 'military:flights:v1', { flights: [] }, 600),
    /Redis SET military:flights:v1 failed: HTTP 413 — request payload exceeds the database limit/,
  );
  assert.equal(calls, 1, 'payload-too-large responses are permanent request failures');
});

test('redisSet retries a transient HTTP failure before succeeding', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) return new Response('overloaded', { status: 503 });
    return new Response(JSON.stringify({ result: 'OK' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  await redisSet('https://redis.test', 'test-token', 'military:flights:v1', { flights: [] }, 600);
  assert.equal(calls, 2);
});

test('redisGet distinguishes an Upstash rejection from a missing history key', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'ERR injected read failure' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

  await assert.rejects(
    redisGet('https://redis.test', 'test-token', 'military:surges:history:v1'),
    /Redis GET military:surges:history:v1 rejected by Upstash/,
  );

  globalThis.fetch = async () => new Response(JSON.stringify({ result: null }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
  assert.equal(await redisGet('https://redis.test', 'test-token', 'military:surges:history:v1'), null);
});

test('redisDel surfaces a command rejection while clearing the OpenSky cooldown', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'ERR injected delete failure' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

  await assert.rejects(
    redisDel('https://redis.test', 'test-token', 'opensky:quota-cooldown:v1'),
    /Redis DEL opensky:quota-cooldown:v1 rejected by Upstash/,
  );
});

test('publish-failure preservation extends every military publication key at its recovery TTL', async () => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  const ttlByKey = new Map();
  globalThis.fetch = async (_url, init) => {
    const pipeline = JSON.parse(init.body);
    for (const command of pipeline) ttlByKey.set(command[1], command[2]);
    return new Response(JSON.stringify(pipeline.map(() => ({ result: 1 }))), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  assert.equal(await preserveMilitaryPublicationTtls(), true);
  assert.equal(ttlByKey.size, 16);
  assert.equal(ttlByKey.get('military:flights:v1'), 600);
  assert.equal(ttlByKey.get('military:flights:stale:v1'), 86400);
  assert.equal(ttlByKey.get('military:surges:v1'), 900);
  assert.equal(ttlByKey.get('military:surges:history:v1'), 604800);
  assert.equal(ttlByKey.get('seed-meta:military-surges'), 86400);
});
