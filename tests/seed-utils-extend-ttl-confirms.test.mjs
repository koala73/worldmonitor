// Regression tests for the extendExistingTtl success-boolean contract
// (#4922d review fix). The market-closed skip in seed-market-quotes.mjs now
// reports fresh + exit(0) ONLY when extendExistingTtl confirms every key was
// actually re-expired. If the helper silently swallowed a failure and returned
// nothing (its prior behavior), a partial Redis outage over a 60h weekend
// would keep health monitors green while the canonical key lapsed. These tests
// lock the boolean: true iff the pipeline responded ok AND every requested key
// returned 1; false on any missing/expired key, non-ok HTTP, network throw, or
// absent credentials.
//
// The helper reads Upstash via fetch, so we monkey-patch global fetch.

import { test, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';

process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';

const { extendExistingTtl } = await import('../scripts/_seed-utils.mjs');

const originalFetch = globalThis.fetch;

// Upstash /pipeline returns an array of { result } objects, one per command,
// in request order. EXPIRE returns 1 when the key existed (TTL refreshed) and
// 0 when it was missing/expired (no-op).
function mockPipeline(results, { ok = true } = {}) {
  globalThis.fetch = async () => ({ ok, json: async () => results });
}

beforeEach(() => { globalThis.fetch = originalFetch; });
afterEach(() => { globalThis.fetch = originalFetch; });

test('extendExistingTtl: returns true when every key is extended', async () => {
  mockPipeline([{ result: 1 }, { result: 1 }, { result: 1 }]);
  const ok = await extendExistingTtl(['a', 'b', 'c'], 1800);
  assert.equal(ok, true);
});

test('extendExistingTtl: returns false when any key is missing/expired (EXPIRE no-op)', async () => {
  // Canonical key alive but RPC key already lapsed — must NOT report success,
  // so the seeder falls through to a real fetch and repopulates.
  mockPipeline([{ result: 1 }, { result: 1 }, { result: 0 }]);
  const ok = await extendExistingTtl(['canonical', 'seed-meta', 'rpc'], 1800);
  assert.equal(ok, false);
});

test('extendExistingTtl: returns false on non-ok HTTP response', async () => {
  mockPipeline([{ result: 1 }], { ok: false });
  const ok = await extendExistingTtl(['a'], 1800);
  assert.equal(ok, false);
});

test('extendExistingTtl: returns false when fetch throws (network failure)', async () => {
  globalThis.fetch = async () => { throw new Error('ECONNRESET'); };
  const ok = await extendExistingTtl(['a'], 1800);
  assert.equal(ok, false);
});

test('extendExistingTtl: returns false when credentials are absent', async () => {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_URL;
  try {
    const ok = await extendExistingTtl(['a'], 1800);
    assert.equal(ok, false);
  } finally {
    process.env.UPSTASH_REDIS_REST_URL = url;
  }
});

test('seed-market-quotes gates the closed-market exit on the extend result', async () => {
  // Source-text guard: the skip path must branch on the boolean and only
  // writeFreshnessMetadata + exit(0) when the extension confirmed. A future
  // edit that reverts to an unconditional exit(0) reintroduces the false-green.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../scripts/seed-market-quotes.mjs', import.meta.url), 'utf8');
  assert.match(src, /const extended = await extendExistingTtl\(/);
  assert.match(src, /if \(extended\) \{/);
  // writeFreshnessMetadata + exit(0) must sit INSIDE the if(extended) block.
  const gateIdx = src.indexOf('if (extended) {');
  const exitIdx = src.indexOf('process.exit(0)');
  assert.ok(gateIdx > 0 && exitIdx > gateIdx, 'exit(0) must be gated behind if(extended)');
});
