// Regression tests for PR 2a: envelope-aware reads in _seed-utils.mjs.
//
// After contract mode enveloped 91 canonical Redis keys as {_seed, data}, any
// internal reader that returned the raw parsed JSON silently started handing
// callers the envelope instead of the bare payload. This test locks the fix:
// redisGet / readSeedSnapshot / verifySeedKey all strip _seed and pass legacy
// bare-shape values through unchanged.
//
// The helpers read a live Upstash instance via fetch, so we monkey-patch the
// global fetch to return canned payloads without network I/O.

import { test, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';

// Force env so getRedisCredentials() doesn't process.exit(1).
process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';

const { readSeedSnapshot, verifySeedKey } = await import('../scripts/_seed-utils.mjs');

const originalFetch = globalThis.fetch;

function mockFetch(upstashResult) {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ result: upstashResult == null ? null : JSON.stringify(upstashResult) }),
  });
}

function mockUpstashBody(body) {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => body,
  });
}

beforeEach(() => { /* per-test mock set inside test body */ });
afterEach(() => { globalThis.fetch = originalFetch; });

test('readSeedSnapshot: envelope-wrapped value returns inner data only', async () => {
  mockFetch({
    _seed: { fetchedAt: 1, recordCount: 3, sourceVersion: 'v1', schemaVersion: 1, state: 'OK' },
    data: { countries: [{ code: 'US' }, { code: 'GB' }, { code: 'MY' }] },
  });
  const snap = await readSeedSnapshot('economic:bigmac:v1');
  assert.deepEqual(snap, { countries: [{ code: 'US' }, { code: 'GB' }, { code: 'MY' }] });
  assert.equal(snap._seed, undefined);
});

test('readSeedSnapshot: legacy bare-shape value passes through unchanged', async () => {
  mockFetch({ countries: [{ code: 'US' }], fetchedAt: 1234 });
  const snap = await readSeedSnapshot('economic:bigmac:v1');
  assert.deepEqual(snap, { countries: [{ code: 'US' }], fetchedAt: 1234 });
});

test('readSeedSnapshot: null Upstash result returns null', async () => {
  mockFetch(null);
  assert.equal(await readSeedSnapshot('missing:key:v1'), null);
});

test('readSeedSnapshot: strict mode distinguishes an upstream read failure from a missing key', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 503 });
  await assert.rejects(
    readSeedSnapshot('conflict:acled:v1:all:0:0', { strict: true }),
    /Redis snapshot read failed: HTTP 503/,
  );
});

test('readSeedSnapshot: strict mode accepts only an explicit null result as a missing key', async () => {
  mockUpstashBody({ result: null });
  assert.equal(await readSeedSnapshot('missing:key:v1', { strict: true }), null);
});

test('readSeedSnapshot: strict mode accepts a valid envelope and unwraps it', async () => {
  mockFetch({
    _seed: { fetchedAt: 1, recordCount: 1, sourceVersion: 'v1', schemaVersion: 1, state: 'OK' },
    data: { samples: [1] },
  });
  assert.deepEqual(await readSeedSnapshot('rolling:baseline:v1', { strict: true }), { samples: [1] });
});

test('readSeedSnapshot: can return data and envelope meta from one Redis read', async () => {
  const meta = { fetchedAt: 1, recordCount: 1, sourceVersion: 'v1', schemaVersion: 1, state: 'OK' };
  mockFetch({ _seed: meta, data: { samples: [1] } });
  assert.deepEqual(
    await readSeedSnapshot('rolling:baseline:v1', { strict: true, includeEnvelopeMeta: true }),
    { data: { samples: [1] }, meta },
  );
});

test('readSeedSnapshot: strict mode accepts a valid legacy payload', async () => {
  mockFetch({ samples: [1], fetchedAt: 1 });
  assert.deepEqual(await readSeedSnapshot('rolling:baseline:v1', { strict: true }), { samples: [1], fetchedAt: 1 });
});

test('readSeedSnapshot: strict mode rejects malformed Upstash response envelopes', async () => {
  const malformedEnvelopes = [
    [{}, /without a result/],
    [{ error: 'upstream protocol error' }, /rejected by Upstash: upstream protocol error/],
    [{ result: { unexpected: true } }, /non-string result/],
    [[], /unexpected Upstash response/],
  ];

  for (const [body, expected] of malformedEnvelopes) {
    mockUpstashBody(body);
    await assert.rejects(
      readSeedSnapshot('rolling:baseline:v1', { strict: true }),
      expected,
    );
  }
});

test('readSeedSnapshot: strict mode rejects malformed stored JSON', async () => {
  for (const result of ['{not valid json', '']) {
    mockUpstashBody({ result });
    await assert.rejects(
      readSeedSnapshot('rolling:baseline:v1', { strict: true }),
      /malformed stored JSON/,
    );
  }
});

test('readSeedSnapshot: strict mode does not confuse a stored JSON null with a missing key', async () => {
  mockUpstashBody({ result: 'null' });
  await assert.rejects(
    readSeedSnapshot('rolling:baseline:v1', { strict: true }),
    /null stored snapshot/,
  );
});

test('readSeedSnapshot: strict mode rejects an unparseable HTTP-200 body', async () => {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => { throw new SyntaxError('bad response'); },
  });
  await assert.rejects(
    readSeedSnapshot('rolling:baseline:v1', { strict: true }),
    /returned invalid JSON \(HTTP 200\)/,
  );
});

test('readSeedSnapshot: non-strict mode preserves null degradation for ambiguous reads', async () => {
  for (const body of [{}, { error: 'upstream protocol error' }, { result: { unexpected: true } }, []]) {
    mockUpstashBody(body);
    assert.equal(await readSeedSnapshot('best-effort:key:v1'), null);
  }

  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => { throw new SyntaxError('bad response'); },
  });
  assert.equal(await readSeedSnapshot('best-effort:key:v1'), null);
});

test('verifySeedKey: envelope-wrapped value returns inner data only', async () => {
  mockFetch({
    _seed: { fetchedAt: 1, recordCount: 1, sourceVersion: 'v1', schemaVersion: 1, state: 'OK' },
    data: { normals: [{ zone: 'tropical' }] },
  });
  const value = await verifySeedKey('climate:zone-normals:v1');
  assert.deepEqual(value, { normals: [{ zone: 'tropical' }] });
});

test('verifySeedKey: legacy bare-shape value passes through unchanged', async () => {
  mockFetch({ fireDetections: [{ lat: 10, lon: 20 }] });
  const value = await verifySeedKey('wildfire:fires:v1');
  assert.deepEqual(value, { fireDetections: [{ lat: 10, lon: 20 }] });
});

test('verifySeedKey: truthy semantics hold for presence check', async () => {
  mockFetch({ _seed: { fetchedAt: 1, recordCount: 0, sourceVersion: 'v1', schemaVersion: 1, state: 'OK_ZERO' }, data: {} });
  const value = await verifySeedKey('any:key:v1');
  assert.ok(value); // non-null — runSeed's post-write verify still works
});
