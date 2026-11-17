// The gateway decides who reaches each headline-search window. The handler
// never sees a plan: the 7-day route is premium by path.
import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';

import { createDomainGateway } from '../server/gateway.ts';
import { issueSessionToken } from '../api/_session.js';
import { createRedisFetch } from './helpers/fake-upstash-redis.mts';

const FREE_PATH = '/api/news/v1/search-headlines';
const ARCHIVE_PATH = '/api/news/v1/search-headline-archive';

const saved = {
  keys: process.env.WORLDMONITOR_VALID_KEYS,
  sessionSecret: process.env.WM_SESSION_SECRET,
  redisUrl: process.env.UPSTASH_REDIS_REST_URL,
  redisToken: process.env.UPSTASH_REDIS_REST_TOKEN,
};
const originalFetch = globalThis.fetch;

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

let sessionToken: string;
let reached: string[];

const handler = createDomainGateway([FREE_PATH, ARCHIVE_PATH].map((path) => ({
  method: 'GET',
  path,
  handler: async () => {
    reached.push(path);
    return new Response(JSON.stringify({ headlines: [], state: 'complete' }), { status: 200 });
  },
})));

function call(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return handler(new Request(`https://worldmonitor.app${path}?query=hormuz&variant=full&lang=en`, {
    headers: { Origin: 'https://worldmonitor.app', ...headers },
  }));
}

before(async () => {
  process.env.WM_SESSION_SECRET = saved.sessionSecret ?? 'test-secret-must-be-at-least-32-chars-long-xxx';
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
  const { fetchImpl } = createRedisFetch({});
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    assert.ok(url.startsWith('https://redis.example'), `unexpected fetch: ${url}`);
    return fetchImpl(input, init);
  }) as typeof fetch;
  sessionToken = (await issueSessionToken()).token;
});

afterEach(() => {
  restore('WORLDMONITOR_VALID_KEYS', saved.keys);
});

after(() => {
  globalThis.fetch = originalFetch;
  restore('WM_SESSION_SECRET', saved.sessionSecret);
  restore('UPSTASH_REDIS_REST_URL', saved.redisUrl);
  restore('UPSTASH_REDIS_REST_TOKEN', saved.redisToken);
});

describe('headline search gateway access', () => {
  it('serves the 24-hour window to an anonymous dashboard session and refuses it the 7-day window', async () => {
    reached = [];
    const free = await call(FREE_PATH, { 'X-WorldMonitor-Key': sessionToken });
    assert.equal(free.status, 200);

    const archive = await call(ARCHIVE_PATH, { 'X-WorldMonitor-Key': sessionToken });
    assert.equal(archive.status, 401);
    assert.deepEqual(reached, [FREE_PATH], 'the 7-day handler never ran for a session without a plan');
  });

  it('refuses both windows to a caller with no session or key', async () => {
    reached = [];
    assert.equal((await call(FREE_PATH)).status, 401);
    assert.equal((await call(ARCHIVE_PATH)).status, 401);
    assert.deepEqual(reached, []);
  });

  it('serves the 7-day window to a premium credential, and never from a shared cache', async () => {
    reached = [];
    process.env.WORLDMONITOR_VALID_KEYS = 'real-key-123';
    const archive = await call(ARCHIVE_PATH, { 'X-WorldMonitor-Key': 'real-key-123' });
    assert.equal(archive.status, 200);
    assert.deepEqual(reached, [ARCHIVE_PATH]);
    const cacheControl = archive.headers.get('Cache-Control') ?? '';
    assert.ok(!/\bpublic\b|s-maxage/.test(cacheControl), `a Pro answer must not be shared-cacheable: ${cacheControl}`);
    assert.equal(archive.headers.get('CDN-Cache-Control'), null);
  });
});
