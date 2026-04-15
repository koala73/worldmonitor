// Unit tests for api/seed-contract-probe.ts — covers every branch of
// checkProbe() (envelope, bare, missing, malformed, expected-bare-got-envelope,
// expected-envelope-got-bare, minRecords floor, missing-field detection) and
// checkPublicBoundary() (seed leak detection, bad status).
//
// Mocks globalThis.fetch so these run hermetically with no network / Upstash.

import { test, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';

process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
process.env.RELAY_SHARED_SECRET = 'test-secret';

// tsx resolves .ts imports for node:test.
const { checkProbe, checkPublicBoundary, DEFAULT_PROBES } = await import('../api/seed-contract-probe.ts');

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function mockRedisGet(value) {
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ result: value == null ? null : JSON.stringify(value) }),
  });
}

// ─── envelope shape probes ───────────────────────────────────────────────

test('checkProbe: envelope-shaped key with all fields + records passes', async () => {
  mockRedisGet({
    _seed: { fetchedAt: Date.now(), recordCount: 52, sourceVersion: 'v1', schemaVersion: 1, state: 'OK' },
    data: { latestValue: 0.23, history: [{ date: '2026-04-14', value: 0.23 }] },
  });
  const r = await checkProbe({ key: 'economic:fsi-eu:v1', shape: 'envelope', dataHas: ['latestValue', 'history'] });
  assert.equal(r.pass, true);
  assert.equal(r.state, 'OK');
  assert.equal(r.records, 52);
});

test('checkProbe: envelope missing required data field fails', async () => {
  mockRedisGet({
    _seed: { fetchedAt: Date.now(), recordCount: 1, sourceVersion: 'v1', schemaVersion: 1, state: 'OK' },
    data: { latestValue: 0.23 }, // missing history
  });
  const r = await checkProbe({ key: 'economic:fsi-eu:v1', shape: 'envelope', dataHas: ['latestValue', 'history'] });
  assert.equal(r.pass, false);
  assert.match(r.reason, /missing-field:history/);
});

test('checkProbe: envelope recordCount below floor fails', async () => {
  mockRedisGet({
    _seed: { fetchedAt: Date.now(), recordCount: 3, sourceVersion: 'v1', schemaVersion: 1, state: 'OK' },
    data: { normals: [1, 2, 3] },
  });
  const r = await checkProbe({ key: 'climate:zone-normals:v1', shape: 'envelope', dataHas: ['normals'], minRecords: 13 });
  assert.equal(r.pass, false);
  assert.match(r.reason, /records:3<13/);
});

test('checkProbe: expected envelope got bare fails (dual-write not active)', async () => {
  mockRedisGet({ latestValue: 0.23, history: [], fetchedAt: Date.now() });
  const r = await checkProbe({ key: 'economic:fsi-eu:v1', shape: 'envelope', dataHas: ['latestValue'] });
  assert.equal(r.pass, false);
  assert.equal(r.reason, 'expected-envelope-got-bare');
});

// ─── bare shape probes (seed-meta:* invariant) ───────────────────────────

test('checkProbe: bare seed-meta key with fetchedAt passes', async () => {
  mockRedisGet({ fetchedAt: Date.now(), recordCount: 31, sourceVersion: 'v1' });
  const r = await checkProbe({ key: 'seed-meta:energy:oil-stocks-analysis', shape: 'bare', dataHas: ['fetchedAt'] });
  assert.equal(r.pass, true);
});

test('checkProbe: bare expected but got envelope fails (shouldEnvelopeKey invariant broken)', async () => {
  mockRedisGet({
    _seed: { fetchedAt: Date.now(), recordCount: 1, sourceVersion: 'v1', schemaVersion: 1, state: 'OK' },
    data: { fetchedAt: Date.now(), recordCount: 1 },
  });
  const r = await checkProbe({ key: 'seed-meta:economic:fsi-eu', shape: 'bare', dataHas: ['fetchedAt'] });
  assert.equal(r.pass, false);
  assert.equal(r.reason, 'expected-bare-got-envelope');
});

test('checkProbe: bare missing field fails', async () => {
  mockRedisGet({ recordCount: 1 }); // no fetchedAt
  const r = await checkProbe({ key: 'seed-meta:economic:fsi-eu', shape: 'bare', dataHas: ['fetchedAt'] });
  assert.equal(r.pass, false);
  assert.match(r.reason, /missing-field:fetchedAt/);
});

// ─── error branches ─────────────────────────────────────────────────────

test('checkProbe: missing key in Redis returns reason=missing', async () => {
  mockRedisGet(null);
  const r = await checkProbe({ key: 'economic:fsi-eu:v1', shape: 'envelope' });
  assert.equal(r.pass, false);
  assert.equal(r.reason, 'missing');
});

test('checkProbe: malformed JSON returns reason=malformed-json', async () => {
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ result: '{not json' }) });
  const r = await checkProbe({ key: 'economic:fsi-eu:v1', shape: 'envelope' });
  assert.equal(r.pass, false);
  assert.equal(r.reason, 'malformed-json');
});

test('checkProbe: Redis non-2xx returns reason=redis:<code>', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
  const r = await checkProbe({ key: 'economic:fsi-eu:v1', shape: 'envelope' });
  assert.equal(r.pass, false);
  assert.equal(r.reason, 'redis:503');
});

// ─── public boundary checks ─────────────────────────────────────────────

function mockBoundary(bodyByEndpoint, headersByEndpoint = {}) {
  globalThis.fetch = async (url) => {
    const path = new URL(url).pathname;
    const body = bodyByEndpoint[path] ?? '{}';
    const hdrs = new Headers(headersByEndpoint[path] || {});
    return {
      ok: true, status: 200,
      text: async () => body,
      headers: { get: (name) => hdrs.get(name) },
    };
  };
}

test('checkPublicBoundary: product-catalog served from cache + bootstrap no leak → pass', async () => {
  mockBoundary(
    {
      '/api/product-catalog': JSON.stringify({ tiers: [{ id: 'pro' }], fetchedAt: 1 }),
      '/api/bootstrap':       JSON.stringify({ market: { quotes: [] } }),
    },
    { '/api/product-catalog': { 'x-product-catalog-source': 'cache' } },
  );
  const res = await checkPublicBoundary('https://example.test');
  assert.equal(res.every(r => r.pass), true, JSON.stringify(res));
});

test('checkPublicBoundary: product-catalog served from fallback fails source-header assert', async () => {
  // This is the regression case — response has no _seed leak, but the cached
  // reader path silently failed and we fell through to static fallback.
  mockBoundary(
    {
      '/api/product-catalog': JSON.stringify({ tiers: [], priceSource: 'fallback' }),
      '/api/bootstrap':       JSON.stringify({}),
    },
    { '/api/product-catalog': { 'x-product-catalog-source': 'fallback' } },
  );
  const res = await checkPublicBoundary('https://example.test');
  const pc = res.find(r => r.endpoint === '/api/product-catalog');
  assert.equal(pc.pass, false);
  assert.match(pc.reason, /source:fallback!=cache/);
});

test('checkPublicBoundary: product-catalog missing source header fails', async () => {
  mockBoundary({
    '/api/product-catalog': JSON.stringify({ tiers: [] }),
    '/api/bootstrap':       JSON.stringify({}),
  });
  const res = await checkPublicBoundary('https://example.test');
  const pc = res.find(r => r.endpoint === '/api/product-catalog');
  assert.equal(pc.pass, false);
  assert.match(pc.reason, /source:missing!=cache/);
});

test('checkPublicBoundary: response leaking _seed fails before source check', async () => {
  mockBoundary(
    {
      '/api/product-catalog': JSON.stringify({ _seed: { fetchedAt: 1 }, data: { tiers: [] } }),
      '/api/bootstrap':       JSON.stringify({}),
    },
    { '/api/product-catalog': { 'x-product-catalog-source': 'cache' } },
  );
  const res = await checkPublicBoundary('https://example.test');
  assert.ok(res.some(r => !r.pass && r.reason === 'seed-leak'));
});

test('checkPublicBoundary: bad status fails', async () => {
  globalThis.fetch = async () => ({
    ok: false, status: 502, text: async () => '', headers: { get: () => null },
  });
  const res = await checkPublicBoundary('https://example.test');
  assert.ok(res.every(r => !r.pass && r.reason.startsWith('status:')));
});

// ─── default probe set sanity ───────────────────────────────────────────

test('DEFAULT_PROBES: enforces seed-meta:* bare invariant', () => {
  const bare = DEFAULT_PROBES.filter(p => p.key.startsWith('seed-meta:'));
  assert.ok(bare.length >= 2, 'at least two seed-meta probes must exist');
  assert.ok(bare.every(p => p.shape === 'bare'), 'all seed-meta probes must be shape=bare');
});

test('DEFAULT_PROBES: token-panels regression guards present (minRecords on all 3 panels)', () => {
  // Every panel needs the minRecords floor — without it, a regression where
  // an extra-key declareRecords returns 0 would silently pass the probe.
  for (const key of ['market:defi-tokens:v1', 'market:ai-tokens:v1', 'market:other-tokens:v1']) {
    const p = DEFAULT_PROBES.find(x => x.key === key);
    assert.ok(p, `missing probe for ${key}`);
    assert.equal(p.shape, 'envelope');
    assert.equal(p.minRecords, 1, `${key} must enforce minRecords≥1`);
  }
});
