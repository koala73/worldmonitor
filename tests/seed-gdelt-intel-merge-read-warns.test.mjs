// Regression test for issue #5437 (seeder side): the cache-merge fallback's
// previous-snapshot read must be RETRIED and its failure must be LOUD.
//
// The default `_loadPrevious` was `verifySeedKey(KEY).catch(() => null)` — a
// silent catch. During the 2026-07-21 GDELT brownout the read blipped on every
// run, the merge silently no-op'd, and seed-meta aged for 21h with zero
// evidence in the run logs. The fallback is the mechanism that keeps freshness
// alive through an upstream outage; when it dies the log must say so.

import { test, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';

process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';

const { fetchAllTopics } = await import('../scripts/seed-gdelt-intel.mjs');

const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;
const originalWarn = console.warn;

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalSetTimeout;
  console.warn = originalWarn;
});

test('default _loadPrevious retries the Redis read and warns loudly when it stays down', async () => {
  let redisCalls = 0;
  const warns = [];
  console.warn = (...args) => { warns.push(args.join(' ')); };
  // Collapse retry backoffs so exhaustion doesn't sleep for real.
  globalThis.setTimeout = (cb, ms, ...args) =>
    originalSetTimeout(cb, ms >= 500 ? 0 : ms, ...args);
  globalThis.fetch = async () => {
    redisCalls += 1;
    const err = new Error('The operation was aborted due to timeout');
    err.name = 'AbortError';
    throw err;
  };

  // Soft budget pre-spent: no topic fetch starts, all 6 topics are empty, so
  // the cache-merge consults the DEFAULT _loadPrevious (deliberately not
  // injected here — this test exercises the real wiring).
  const out = await fetchAllTopics({
    _softBudgetMs: 1,
    _sleep: async () => {},
    _fetchArticles: async () => { throw new Error('must not fetch topics'); },
    _fetchTimeline: async () => [],
  });

  assert.equal(redisCalls, 3, 'previous-snapshot read must be retried (3 attempts)');
  assert.ok(
    warns.some((w) => w.includes('cache-merge')),
    `a failed merge read must warn loudly; warns were: ${JSON.stringify(warns)}`,
  );
  assert.equal(out.topics.length, 6, 'run still completes with all topics represented');
  for (const t of out.topics) assert.equal(t.articles.length, 0, 'no backfill when the read is down');
});
