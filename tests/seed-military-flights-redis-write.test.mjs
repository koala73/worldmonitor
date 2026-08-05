import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { redisSet } from '../scripts/seed-military-flights.mjs';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('redisSet rejects an Upstash command error returned with HTTP 200', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: 'ERR max request size exceeded',
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

  await assert.rejects(
    redisSet('https://redis.test', 'test-token', 'military:flights:v1', { flights: [] }, 600),
    /Redis SET military:flights:v1 rejected by Upstash: ERR max request size exceeded/,
  );
});

test('redisSet accepts an Upstash command success response', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ result: 'OK' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

  await redisSet('https://redis.test', 'test-token', 'military:flights:v1', { flights: [] }, 600);
});
