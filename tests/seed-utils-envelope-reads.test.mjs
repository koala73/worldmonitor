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
    json: async () => ({ result: upstashResult == null ? null : JSON.stringify(upstashResult) }),
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
