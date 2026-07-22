// Regression tests for issue #5437: transient-Redis retry on the READ path
// (verifySeedKey/redisGet), on writeFreshnessMetadata, and on
// readCanonicalEnvelopeMeta.
//
// seed-gdelt-intel's cache-merge fallback loads the previous canonical
// snapshot via verifySeedKey. redisGet had a 5s abort with NO retry and
// converted any non-OK status into a silent null, so a single Upstash blip at
// the soft-budget boundary read as "no previous snapshot": the merge no-op'd,
// validation failed, the run skipped without writing, and seed-meta aged until
// the freshness gate fired (gdeltIntel age=882m > max=720m) — while the
// canonical key was perfectly healthy. Sibling ops on the same skip path
// (writeFreshnessMetadata's SET, readCanonicalEnvelopeMeta's GET) were also
// unretried; the SET aborting is what produced the two
// `FATAL: The operation was aborted due to timeout` exit-1 crashes.
//
// Contract under test (mirrors the writeExtraKey / redisCommand tagging):
//   - timeout / network / 5xx / 429 → retried (429 honors Retry-After)
//   - permanent 4xx → fail fast, no retry
//   - reads NEVER gain a new throw path: HTTP failures still degrade to null
//     after retries; thrown (network/timeout) failures still propagate.

import { test, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';

process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';

const { verifySeedKey, writeFreshnessMetadata, readCanonicalEnvelopeMeta } =
  await import('../scripts/_seed-utils.mjs');

const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;

beforeEach(() => {
  // Collapse retry backoffs (>=500ms) so exhaustion tests don't sleep for real;
  // short timers pass through untouched.
  globalThis.setTimeout = (cb, ms, ...args) =>
    originalSetTimeout(cb, ms >= 500 ? 0 : ms, ...args);
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalSetTimeout;
});

const ENVELOPE = {
  _seed: { fetchedAt: 1784621196406, recordCount: 6, sourceVersion: 'gdelt-doc-v2', schemaVersion: 1, state: 'OK' },
  data: { topics: [{ id: 'military', articles: [{ title: 'cached' }] }], fetchedAt: '2026-07-21T08:06:36.406Z' },
};

function buildResponse({ ok = true, status = 200, body = { result: 'OK' }, headers = {} }) {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body), headers };
}

function abortError() {
  const err = new Error('The operation was aborted due to timeout');
  err.name = 'AbortError';
  return err;
}

// ---------- verifySeedKey (the merge-fallback read) ----------

test('verifySeedKey: retries on timeout and succeeds on second attempt', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) throw abortError();
    return buildResponse({ body: { result: JSON.stringify(ENVELOPE) } });
  };

  const data = await verifySeedKey('intelligence:gdelt-intel:v1');
  assert.equal(calls, 2, 'must retry once after timeout');
  assert.equal(data.topics[0].articles[0].title, 'cached', 'returns unwrapped payload');
});

test('verifySeedKey: retries on 503 and succeeds on second attempt', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) return buildResponse({ ok: false, status: 503, body: {} });
    return buildResponse({ body: { result: JSON.stringify(ENVELOPE) } });
  };

  const data = await verifySeedKey('intelligence:gdelt-intel:v1');
  assert.equal(calls, 2, 'must retry once after 503');
  assert.ok(Array.isArray(data.topics), 'returns the payload, not null');
});

test('verifySeedKey: retries on 429 honoring Retry-After', async () => {
  let calls = 0;
  const waits = [];
  globalThis.setTimeout = (cb, ms, ...args) => {
    waits.push(ms);
    return originalSetTimeout(cb, ms >= 500 ? 0 : ms, ...args);
  };
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) return buildResponse({ ok: false, status: 429, body: {}, headers: { 'retry-after': '2' } });
    return buildResponse({ body: { result: JSON.stringify(ENVELOPE) } });
  };

  const data = await verifySeedKey('intelligence:gdelt-intel:v1');
  assert.equal(calls, 2, 'must retry once after 429');
  assert.ok(data.topics, 'returns the payload');
  assert.ok(waits.some((ms) => ms >= 2000), 'Retry-After hint must be honored');
});

test('verifySeedKey: permanent 401 returns null without retry', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return buildResponse({ ok: false, status: 401, body: {} });
  };

  const data = await verifySeedKey('intelligence:gdelt-intel:v1');
  assert.equal(calls, 1, 'must not retry permanent 401');
  assert.equal(data, null, 'legacy null contract preserved');
});

test('verifySeedKey: persistent 503 degrades to null after exhausting retries (no new throw path)', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return buildResponse({ ok: false, status: 503, body: {} });
  };

  const data = await verifySeedKey('intelligence:gdelt-intel:v1');
  assert.equal(calls, 3, 'default retry count should be 2 (3 total attempts)');
  assert.equal(data, null, 'HTTP failure still degrades to null, never throws');
});

test('verifySeedKey: persistent timeout still propagates (legacy throw contract) after retries', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw abortError();
  };

  await assert.rejects(() => verifySeedKey('intelligence:gdelt-intel:v1'), /aborted due to timeout/);
  assert.equal(calls, 3, 'timeouts must be retried before propagating');
});

// ---------- writeFreshnessMetadata (the skip-path seed-meta mirror SET) ----------

test('writeFreshnessMetadata: retries on timeout and succeeds on second attempt', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) throw abortError();
    return buildResponse({});
  };

  const meta = await writeFreshnessMetadata('intelligence', 'gdelt-intel', 6, 'gdelt-doc-v2', 86400, 1784621196406);
  assert.equal(calls, 2, 'must retry once after timeout');
  assert.equal(meta.fetchedAt, 1784621196406, 'mirrored fetchedAt preserved');
});

test('writeFreshnessMetadata: retries on 503 and succeeds on second attempt', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) return buildResponse({ ok: false, status: 503, body: {} });
    return buildResponse({});
  };

  await writeFreshnessMetadata('intelligence', 'gdelt-intel', 6, 'gdelt-doc-v2', 86400);
  assert.equal(calls, 2, 'must retry once after 503');
});

test('writeFreshnessMetadata: fails fast on permanent 401 without retry', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return buildResponse({ ok: false, status: 401, body: {} });
  };

  await assert.rejects(
    () => writeFreshnessMetadata('intelligence', 'gdelt-intel', 6, 'gdelt-doc-v2', 86400),
    /HTTP 401/,
  );
  assert.equal(calls, 1, 'must not retry permanent 401');
});

test('writeFreshnessMetadata: still throws after exhausting retries', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return buildResponse({ ok: false, status: 503, body: {} });
  };

  await assert.rejects(
    () => writeFreshnessMetadata('intelligence', 'gdelt-intel', 6, 'gdelt-doc-v2', 86400),
    /HTTP 503/,
  );
  assert.equal(calls, 3, 'default retry count should be 2 (3 total attempts)');
});

// ---------- readCanonicalEnvelopeMeta (the skip-path mirror GET) ----------
// A transient failure here is worse than a crash: the caller falls back to
// writing recordCount=0 with fetchedAt=NOW, resetting the freshness clock and
// masking real staleness.

test('readCanonicalEnvelopeMeta: retries on 503 and returns meta on second attempt', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) return buildResponse({ ok: false, status: 503, body: {} });
    return buildResponse({ body: { result: JSON.stringify(ENVELOPE) } });
  };

  const meta = await readCanonicalEnvelopeMeta('intelligence:gdelt-intel:v1');
  assert.equal(calls, 2, 'must retry once after 503');
  assert.equal(meta.recordCount, 6);
  assert.equal(meta.fetchedAt, 1784621196406);
});

test('readCanonicalEnvelopeMeta: retries on timeout, still null (never throws) when exhausted', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw abortError();
  };

  const meta = await readCanonicalEnvelopeMeta('intelligence:gdelt-intel:v1');
  assert.equal(calls, 3, 'default retry count should be 2 (3 total attempts)');
  assert.equal(meta, null, 'defensive null contract preserved');
});
