import assert from 'node:assert/strict';
import test from 'node:test';

// #6235: LookupSanctionEntity was the only uncached third-party fetch in the
// server tree — every request re-hit api.opensanctions.org. Sanctioned-entity
// lookups cluster hard on repeat queries, so an uncached proxy multiplies
// upstream load for no benefit and leaves the route one outage away from the
// narrower OFAC-only fallback.

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_ENV = {
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
};

function restoreEnvironment() {
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_ENV.url == null) delete process.env.UPSTASH_REDIS_REST_URL;
  else process.env.UPSTASH_REDIS_REST_URL = ORIGINAL_ENV.url;
  if (ORIGINAL_ENV.token == null) delete process.env.UPSTASH_REDIS_REST_TOKEN;
  else process.env.UPSTASH_REDIS_REST_TOKEN = ORIGINAL_ENV.token;
}

const OPENSANCTIONS_PAYLOAD = {
  results: [
    {
      id: 'NK-abc123',
      schema: 'Person',
      caption: 'Test Person',
      properties: { name: ['Test Person'], country: ['ru'], program: ['SDN'] },
    },
  ],
  total: { value: 1 },
};

/**
 * Minimal in-memory Upstash stub: serves GET from a Map that POST /SET fills,
 * so the second handler call sees whatever the first one persisted.
 */
function installRedisBackedStub() {
  const store = new Map<string, string>();
  const upstreamCalls: string[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);

    if (url.startsWith('https://redis.example.test/get/')) {
      const key = decodeURIComponent(url.slice('https://redis.example.test/get/'.length));
      const hit = store.get(key);
      return new Response(JSON.stringify({ result: hit ?? null }), { status: 200 });
    }

    if (url === 'https://redis.example.test/') {
      const cmd = JSON.parse(String(init?.body)) as string[];
      if (cmd[0] === 'SET') store.set(cmd[1]!, cmd[2]!);
      return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
    }

    if (url.startsWith('https://api.opensanctions.org/')) {
      upstreamCalls.push(url);
      return new Response(JSON.stringify(OPENSANCTIONS_PAYLOAD), { status: 200 });
    }

    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;

  return { upstreamCalls, store };
}

test('repeat OpenSanctions lookup is served from Redis, not re-fetched upstream', async (t) => {
  t.after(restoreEnvironment);
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';

  const { upstreamCalls } = installRedisBackedStub();
  const { lookupSanctionEntity } = await import('../server/worldmonitor/sanctions/v1/lookup-entity.ts');

  const first = await lookupSanctionEntity({} as never, { q: 'Test Person', maxResults: 10 } as never);
  assert.equal(first.source, 'opensanctions');
  assert.equal(first.results.length, 1);
  assert.equal(upstreamCalls.length, 1, 'first lookup must reach upstream');

  const second = await lookupSanctionEntity({} as never, { q: 'Test Person', maxResults: 10 } as never);
  assert.equal(second.source, 'opensanctions');
  assert.deepEqual(second.results, first.results, 'cached payload must match the fresh one');
  assert.equal(
    upstreamCalls.length,
    1,
    'second identical lookup must be served from Redis without re-hitting OpenSanctions',
  );
});

test('lookup cache key normalizes case and surrounding whitespace', async (t) => {
  t.after(restoreEnvironment);
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';

  const { upstreamCalls } = installRedisBackedStub();
  const { lookupSanctionEntity } = await import('../server/worldmonitor/sanctions/v1/lookup-entity.ts');

  await lookupSanctionEntity({} as never, { q: 'Test Person', maxResults: 10 } as never);
  await lookupSanctionEntity({} as never, { q: '  TEST person  ', maxResults: 10 } as never);

  assert.equal(
    upstreamCalls.length,
    1,
    'case/whitespace variants of one query must share a cache entry',
  );
});

test('an OpenSanctions outage falls back to OFAC without persisting a negative sentinel', async (t) => {
  t.after(restoreEnvironment);
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';

  const store = new Map<string, string>();
  const ofacIndex = [{ id: 'ofac:1', name: 'Test Person', et: 'individual', cc: ['RU'], pr: ['SDN'] }];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('https://redis.example.test/get/')) {
      const key = decodeURIComponent(url.slice('https://redis.example.test/get/'.length));
      if (key === 'sanctions:entities:v1') {
        return new Response(JSON.stringify({ result: JSON.stringify(ofacIndex) }), { status: 200 });
      }
      return new Response(JSON.stringify({ result: store.get(key) ?? null }), { status: 200 });
    }
    if (url === 'https://redis.example.test/') {
      const cmd = JSON.parse(String(init?.body)) as string[];
      if (cmd[0] === 'SET') store.set(cmd[1]!, cmd[2]!);
      return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
    }
    if (url.startsWith('https://api.opensanctions.org/')) {
      return new Response('upstream down', { status: 503 });
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;

  const { lookupSanctionEntity } = await import('../server/worldmonitor/sanctions/v1/lookup-entity.ts');
  const result = await lookupSanctionEntity({} as never, { q: 'Test Person', maxResults: 10 } as never);

  assert.equal(result.source, 'ofac', 'a 503 must degrade to the seeded OFAC index');
  assert.equal(result.results.length, 1);

  const lookupKeys = [...store.keys()].filter(k => k.includes('sanctions:lookup:'));
  assert.deepEqual(
    lookupKeys,
    [],
    'an availability failure must not persist a sentinel that pins later callers to OFAC',
  );
});

test('a different maxResults does not serve a short cached result', async (t) => {
  t.after(restoreEnvironment);
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';

  const { upstreamCalls } = installRedisBackedStub();
  const { lookupSanctionEntity } = await import('../server/worldmonitor/sanctions/v1/lookup-entity.ts');

  await lookupSanctionEntity({} as never, { q: 'Test Person', maxResults: 5 } as never);
  await lookupSanctionEntity({} as never, { q: 'Test Person', maxResults: 50 } as never);

  assert.equal(
    upstreamCalls.length,
    2,
    'a wider maxResults must not be answered from a narrower cached response',
  );
});
