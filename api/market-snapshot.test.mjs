import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import handler from './market-snapshot.js';
import { __resetRateLimitForTest } from './_rate-limit.js';
import { DATASETS } from './_market-snapshot.js';

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
const ENDPOINT = 'https://api.worldmonitor.app/api/market-snapshot';

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
}

function makeRequest(query = '', options = {}) {
  return new Request(`${ENDPOINT}${query}`, {
    method: options.method ?? 'GET',
    headers: options.origin === null ? {} : { Origin: options.origin ?? 'https://worldmonitor.app' },
  });
}

function mockUpstash({ rateLimited = false, redisStatus = 200 } = {}) {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const commands = JSON.parse(String(init.body ?? '[]'));
    calls.push({ url, commands });
    if (commands[0]?.[0] === 'GET') {
      if (redisStatus !== 200) return new Response('unavailable', { status: redisStatus });
      return new Response(JSON.stringify(DATASETS.map(() => ({ result: null }))), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify([{ result: [rateLimited ? -1 : 29, 30] }]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return calls;
}

beforeEach(() => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://upstash.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  __resetRateLimitForTest();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreEnv();
  __resetRateLimitForTest();
});

test('shields a successful public snapshot with cache-safe public CORS', async () => {
  const calls = mockUpstash();

  const response = await handler(makeRequest());

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal(response.headers.get('Access-Control-Allow-Credentials'), null);
  assert.equal(response.headers.get('Vary'), null);
  assert.match(response.headers.get('Cache-Control') ?? '', /s-maxage=60/);
  assert.match(response.headers.get('CDN-Cache-Control') ?? '', /s-maxage=60/);
  assert.equal(calls.filter((call) => call.commands[0]?.[0] === 'GET').length, 1);
});

test('serves Markdown through the same bounded format contract', async () => {
  mockUpstash();

  const response = await handler(makeRequest('?format=markdown'));

  assert.equal(response.status, 200);
  assert.match(response.headers.get('Content-Type') ?? '', /^text\/markdown/);
  const markdown = await response.text();
  assert.match(markdown, /^# World Monitor Market Snapshot/);
  assert.match(markdown, /- Age: unknown/);
  assert.match(markdown, /- Fetch age: unknown/);
  assert.match(markdown, /- Observation age: unknown/);
});

test('rejects unknown, duplicate, and invalid query parameters before any Redis work', async () => {
  const requests = ['?cacheBust=1', '?format=json&format=json', '?format=xml'];
  for (const query of requests) {
    const calls = mockUpstash();
    const response = await handler(makeRequest(query));
    assert.equal(response.status, 400, query);
    assert.equal(response.headers.get('Cache-Control'), 'no-store', query);
    assert.deepEqual(calls, [], query);
  }
});

test('applies the dedicated rate limit before reading snapshot datasets', async () => {
  const calls = mockUpstash({ rateLimited: true });

  const response = await handler(makeRequest());

  assert.equal(response.status, 429);
  assert.equal(response.headers.get('X-RateLimit-Limit'), '30');
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(calls.filter((call) => call.commands[0]?.[0] === 'GET').length, 0);
});

test('keeps a Redis-error snapshot out of shared caches', async () => {
  mockUpstash({ redisStatus: 503 });

  const response = await handler(makeRequest());
  const snapshot = await response.json();

  assert.equal(response.status, 200);
  assert.equal(snapshot.summary.error, DATASETS.length);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('CDN-Cache-Control'), 'no-store');
});

test('answers preflight with public CORS and no Redis work', async () => {
  const calls = mockUpstash();

  const response = await handler(makeRequest('', { method: 'OPTIONS' }));

  assert.equal(response.status, 204);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal(response.headers.get('Access-Control-Allow-Methods'), 'GET, OPTIONS');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(calls, []);
});
