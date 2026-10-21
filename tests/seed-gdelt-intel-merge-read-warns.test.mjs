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
  let nowCalls = 0;
  const warns = [];
  console.warn = (...args) => { warns.push(args.join(' ')); };
  // Collapse only the Redis retry backoffs so exhaustion doesn't sleep for
  // real. Keep the ordering-read budget timer intact: collapsing every large
  // timer also collapses the operation's deadline and races the retry ladder.
  globalThis.setTimeout = (cb, ms, ...args) =>
    originalSetTimeout(cb, ms === 1000 || ms === 2000 ? 0 : ms, ...args);
  globalThis.fetch = async () => {
    redisCalls += 1;
    const err = new Error('The operation was aborted due to timeout');
    err.name = 'AbortError';
    throw err;
  };

  // Give the ordering read a deterministic budget, then advance the injected
  // run clock before the topic loop. A real 1ms budget made this test
  // load-dependent: slow CI could spend it before the ordering operation was
  // even invoked, observing only the later cache-merge read.
  const out = await fetchAllTopics({
    _now: () => (++nowCalls <= 2 ? 0 : 40_000),
    _softBudgetMs: 40_000,
    _minRequestBudgetMs: 35_000,
    _sleep: async () => {},
    _fetchArticles: async () => { throw new Error('must not fetch topics'); },
    _fetchTimeline: async () => [],
  });

  // Two logical reads x 3 retried attempts each. Since issue #5848 the fetch
  // order is chosen from the same snapshot, so the run reads it up front too — but
  // a read that degraded to null is deliberately NOT memoized, because "Upstash
  // was unreachable" and "there is no previous snapshot" arrive as the same value.
  // Caching the first failure would silently disable the cache-merge for the whole
  // run; leaving it unmemoized buys the merge an independent attempt minutes later,
  // when the blip may have passed.
  assert.equal(redisCalls, 6, 'each of the two previous-snapshot reads must be retried (3 attempts each)');
  assert.ok(
    warns.some((w) => w.includes('cache-merge')),
    `a failed merge read must warn loudly; warns were: ${JSON.stringify(warns)}`,
  );
  assert.equal(out.topics.length, 6, 'run still completes with all topics represented');
  for (const t of out.topics) assert.equal(t.articles.length, 0, 'no backfill when the read is down');
});
