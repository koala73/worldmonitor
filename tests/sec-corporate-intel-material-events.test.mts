import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { listMaterialEvents } from '../server/worldmonitor/intelligence/v1/list-material-events';
import { ValidationError } from '../src/generated/server/worldmonitor/intelligence/v1/service_server';

const ctx = { request: new Request('http://localhost/'), pathParams: {}, headers: {} } as never;
const originalFetch = globalThis.fetch;
const originalEnv = {
  UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
  VERCEL_ENV: process.env.VERCEL_ENV,
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function installStream(stream: unknown | null) {
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  process.env.VERCEL_ENV = 'production';
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('/get/intelligence%3Asec-8k-stream%3Av1')) {
      const value = stream == null
        ? null
        : {
            _seed: { fetchedAt: Date.now(), recordCount: 2, sourceVersion: 't', schemaVersion: 1, state: 'OK' },
            data: stream,
          };
      return new Response(JSON.stringify({ result: value == null ? null : JSON.stringify(value) }));
    }
    return new Response('unexpected fetch: ' + url, { status: 599 });
  }) as typeof fetch;
}

const STREAM = {
  events: [
    { company: 'A', cik: '1', form: '8-K', accession: 'acc-1', filedAtMs: 1785187798000, items: [{ code: '5.02', description: 'Officers' }], url: 'https://www.sec.gov/1' },
    { company: 'B', cik: '2', form: '8-K', accession: 'acc-2', filedAtMs: 1785187700000, items: [{ code: '2.01', description: 'Acquisition' }], url: 'https://www.sec.gov/2' },
  ],
  fetchedAt: '2026-07-27T22:43:29.498Z',
};

describe('listMaterialEvents', () => {
  it('serves the seeded stream with freshness metadata', async () => {
    installStream(STREAM);
    const response = await listMaterialEvents(ctx, { itemCode: '', limit: 0 });
    assert.equal(response.unavailable, false);
    assert.equal(response.events.length, 2);
    assert.equal(response.fetchedAtMs, Date.parse(STREAM.fetchedAt));
  });

  it('filters by item code', async () => {
    installStream(STREAM);
    const response = await listMaterialEvents(ctx, { itemCode: '2.01', limit: 0 });
    assert.deepEqual(response.events.map(event => event.accession), ['acc-2']);
  });

  it('rejects a malformed item code instead of returning the whole stream', async () => {
    installStream(STREAM);
    await assert.rejects(
      () => listMaterialEvents(ctx, { itemCode: 'executive changes', limit: 0 }),
      ValidationError,
    );
  });

  it('reports unavailable when the seed is missing', async () => {
    installStream(null);
    const response = await listMaterialEvents(ctx, { itemCode: '', limit: 0 });
    assert.equal(response.unavailable, true);
    assert.deepEqual(response.events, []);
  });
});
