import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'node:test';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

const SAMPLE_PAYLOAD = {
  wti:        { current: 76.23, previous: 75.10, date: '2026-04-11', unit: 'dollars per barrel' },
  brent:      { current: 81.02, previous: 80.44, date: '2026-04-11', unit: 'dollars per barrel' },
  production: { current: 13100, previous: 13050, date: '2026-04-11', unit: 'MBBL' },
  inventory:  { current: 458_100, previous: 459_200, date: '2026-04-11', unit: 'MBBL' },
};

const ENVELOPE = {
  _seed: {
    fetchedAt: 1_700_000_000_000,
    recordCount: 4,
    sourceVersion: 'eia-petroleum-v1',
    schemaVersion: 1,
    state: 'OK',
  },
  data: SAMPLE_PAYLOAD,
};

function makeRequest(path, opts = {}) {
  return new Request(`https://worldmonitor.app/api/eia${path}`, {
    method: opts.method || 'GET',
    headers: { origin: 'https://worldmonitor.app', ...(opts.headers || {}) },
  });
}

let handler;

describe('api/eia/[[...path]] — petroleum reader', () => {
  beforeEach(async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://fake-upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
    const mod = await import(`../api/eia/%5B%5B...path%5D%5D.js?t=${Date.now()}`);
    handler = mod.default;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Object.keys(process.env).forEach(k => {
      if (!(k in originalEnv)) delete process.env[k];
    });
    Object.assign(process.env, originalEnv);
  });

  it('OPTIONS returns 204 with CORS headers', async () => {
    const res = await handler(makeRequest('/petroleum', { method: 'OPTIONS' }));
    assert.equal(res.status, 204);
    assert.ok(res.headers.get('access-control-allow-origin'));
  });

  it('disallowed origin returns 403', async () => {
    const res = await handler(makeRequest('/petroleum', { headers: { origin: 'https://evil.example' } }));
    assert.equal(res.status, 403);
  });

  it('non-GET returns 405', async () => {
    const res = await handler(makeRequest('/petroleum', { method: 'POST' }));
    assert.equal(res.status, 405);
  });

  it('/health returns configured:true', async () => {
    const res = await handler(makeRequest('/health'));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.configured, true);
  });

  it('/petroleum returns 200 with data on Upstash hit (envelope unwrapped)', async () => {
    globalThis.fetch = async (url) => {
      assert.match(String(url), /fake-upstash\.io\/get\/energy%3Aeia-petroleum%3Av1/);
      return new Response(JSON.stringify({ result: JSON.stringify(ENVELOPE) }), { status: 200 });
    };
    const res = await handler(makeRequest('/petroleum'));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, SAMPLE_PAYLOAD);
    assert.match(res.headers.get('cache-control') || '', /max-age=1800/);
    assert.match(res.headers.get('cache-control') || '', /stale-while-revalidate=86400/);
  });

  it('/petroleum returns 503 with hint when Redis key is missing', async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ result: null }), { status: 200 });
    const res = await handler(makeRequest('/petroleum'));
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.match(body.error, /not yet seeded/i);
    assert.ok(body.hint);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('retry-after'), '300');
  });

  it('/petroleum returns 503 (not 504) when Upstash itself errors', async () => {
    globalThis.fetch = async () => new Response('bad gateway', { status: 502 });
    const res = await handler(makeRequest('/petroleum'));
    assert.equal(res.status, 503);
  });

  it('/petroleum returns 503 when Upstash throws', async () => {
    globalThis.fetch = async () => { throw new Error('connection refused'); };
    const res = await handler(makeRequest('/petroleum'));
    assert.equal(res.status, 503);
  });

  it('unknown path returns 404', async () => {
    const res = await handler(makeRequest('/unknown'));
    assert.equal(res.status, 404);
  });
});
