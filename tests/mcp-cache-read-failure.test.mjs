// A Redis read that FAILED is not a key that is ABSENT.
//
// `readJsonFromUpstash` resolves null for a miss and rejects when the request
// itself fails (AbortSignal.timeout, network tear). The cache-tool loader used
// to `Promise.all` those reads, so one 3s timeout on any key failed the whole
// tool call as a raw `TimeoutError` (Sentry WORLDMONITOR-176 /
// WORLDMONITOR-ZM / WORLDMONITOR-137). Swallowing the rejection into null at the
// helper would be worse: an unreadable seed-meta would read as "never seeded"
// (stale: true on fresh data) and an unreadable data key as an empty section.
// These tests pin the loader keeping the two apart.
//
// Run: node --test tests/mcp-cache-read-failure.test.mjs

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { executeTool } from '../api/mcp/dispatch.ts';
import { McpSourceUnavailableError } from '../api/mcp/source-unavailable.ts';

const NOW = Date.parse('2026-10-02T03:00:00.000Z');
const TOOL = {
  name: 'test_cache_read_failure',
  description: 'synthetic',
  inputSchema: { type: 'object', properties: {}, required: [] },
  _cacheKeys: ['test:alpha:v1', 'test:beta:v1'],
  _freshnessChecks: [{ key: 'seed-meta:test:alpha', maxStaleMin: 60 }],
  _apiPaths: [],
};

const FRESH_META = JSON.stringify({ fetchedAt: NOW - 5 * 60_000, recordCount: 3 });
const timeout = () => {
  throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
};

let originalFetch;
let originalUrl;
let originalToken;
beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalUrl = process.env.UPSTASH_REDIS_REST_URL;
  originalToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
  else process.env.UPSTASH_REDIS_REST_URL = originalUrl;
  if (originalToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
  else process.env.UPSTASH_REDIS_REST_TOKEN = originalToken;
});

/** Route each GET by key: a string is the stored value, null a miss, a function throws. */
function mockRedis(byKey) {
  globalThis.fetch = async (url) => {
    const key = decodeURIComponent(String(url).split('/get/')[1] ?? '');
    if (!(key in byKey)) throw new Error(`unexpected key ${key}`);
    const entry = byKey[key];
    if (typeof entry === 'function') return entry();
    return new Response(JSON.stringify({ result: entry }), { status: 200 });
  };
}

describe('executeTool keeps a failed Redis read distinct from an absent key', () => {
  it('serves the readable section and names the unreadable one', async () => {
    mockRedis({
      'test:alpha:v1': JSON.stringify({ items: [1, 2, 3] }),
      'test:beta:v1': timeout,
      'seed-meta:test:alpha': FRESH_META,
    });
    const out = await executeTool(TOOL, {}, NOW);
    assert.deepEqual(out.data.alpha, { items: [1, 2, 3] });
    assert.equal(out.data.beta, null);
    assert.deepEqual(out.unreadable, ['beta']);
    assert.equal(out.stale, false);
    assert.equal(out.freshnessUnknown, undefined);
  });

  it('flags freshness as unknown, not merely stale, when the seed-meta read fails', async () => {
    mockRedis({
      'test:alpha:v1': JSON.stringify({ items: [1] }),
      'test:beta:v1': JSON.stringify({ items: [2] }),
      'seed-meta:test:alpha': timeout,
    });
    const out = await executeTool(TOOL, {}, NOW);
    assert.equal(out.freshnessUnknown, true);
    // Fails closed, like an unreadable activation marker: unknown is never fresh.
    assert.equal(out.stale, true);
    assert.equal(out.unreadable, undefined);
  });

  it('reports a source outage, not cache_all_null, when every data read fails', async () => {
    mockRedis({
      'test:alpha:v1': timeout,
      'test:beta:v1': timeout,
      'seed-meta:test:alpha': FRESH_META,
    });
    await assert.rejects(executeTool(TOOL, {}, NOW), (err) => {
      assert.ok(err instanceof McpSourceUnavailableError);
      assert.deepEqual(err.failedInputs, ['alpha', 'beta']);
      return true;
    });
  });

  it('reports a source outage when the only non-empty answers are failures', async () => {
    mockRedis({
      'test:alpha:v1': null,
      'test:beta:v1': timeout,
      'seed-meta:test:alpha': FRESH_META,
    });
    await assert.rejects(executeTool(TOOL, {}, NOW), (err) => {
      assert.ok(err instanceof McpSourceUnavailableError);
      assert.deepEqual(err.failedInputs, ['beta']);
      assert.deepEqual(err.unavailableInputs, ['alpha']);
      return true;
    });
  });

  it('still throws cache_all_null when every key is genuinely absent', async () => {
    mockRedis({
      'test:alpha:v1': null,
      'test:beta:v1': null,
      'seed-meta:test:alpha': FRESH_META,
    });
    await assert.rejects(executeTool(TOOL, {}, NOW), /^Error: cache_all_null$/);
  });

  it('adds no new fields when every read succeeds', async () => {
    mockRedis({
      'test:alpha:v1': JSON.stringify({ items: [1] }),
      'test:beta:v1': null,
      'seed-meta:test:alpha': FRESH_META,
    });
    const out = await executeTool(TOOL, {}, NOW);
    assert.equal(out.data.beta, null);
    assert.equal('unreadable' in out, false);
    assert.equal('freshnessUnknown' in out, false);
  });
});
