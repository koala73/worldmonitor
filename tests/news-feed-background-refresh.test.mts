import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  FEED_REFRESH_AFTER_MS,
  fetchAndParseRss,
  isDueForRefresh,
  refreshFeedCache,
  type ParseResult,
  __testing__,
} from '../server/worldmonitor/news/v1/list-feed-digest';
import { rssFeedCacheKey } from '../server/worldmonitor/news/v1/_rss-cache';
import { __resetKeyPrefixCacheForTests } from '../server/_shared/redis';
import { createRedisFetch, type FakeRedisState } from './helpers/fake-upstash-redis.mts';

const FEED = { name: 'Reuters World', url: 'https://feeds.example.org/world.xml' };
const VARIANT = 'full';
const KEY = rssFeedCacheKey(VARIANT, FEED.url);
const envKeys = ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'VERCEL_ENV', 'LOCAL_API_MODE', 'WS_RELAY_URL'] as const;
const oldEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
const originalFetch = globalThis.fetch;

const rss = (titles: string[]) => `<?xml version="1.0"?><rss><channel>${titles.map((title, i) => `<item>
  <title>${title}</title><link>https://feeds.example.org/story-${i}</link>
  <pubDate>${new Date(Date.now() - (i + 1) * 3_600_000).toUTCString()}</pubDate></item>`).join('')}</channel></rss>`;

type Upstream = (request: { headers: Headers }) => Response;
let redis: FakeRedisState;
let upstreamCalls: Headers[];

function install(upstream: Upstream) {
  redis = createRedisFetch({});
  upstreamCalls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (new URL(href).host === 'redis.example') return redis.fetchImpl(input, init);
    if (href === FEED.url) {
      const headers = new Headers(init?.headers);
      upstreamCalls.push(headers);
      return upstream({ headers });
    }
    throw new Error(`unexpected fetch ${href}`);
  }) as typeof fetch;
}

function seed(entry: ParseResult) {
  redis.redis.set(KEY, JSON.stringify(entry));
}

function cachedEntry(): ParseResult {
  return JSON.parse(redis.redis.get(KEY)!) as ParseResult;
}

async function parsed(titles: string[], extra: Partial<ParseResult> = {}): Promise<ParseResult> {
  return { ...__testing__.parseRssXml(rss(titles), FEED, VARIANT)!, ...extra };
}

beforeEach(() => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
  delete process.env.VERCEL_ENV;
  delete process.env.LOCAL_API_MODE;
  delete process.env.WS_RELAY_URL;
  __resetKeyPrefixCacheForTests();
});

afterEach(async () => {
  // A deadline-cut fetch probes its feed after the response; finish it on this test's fetch.
  await __testing__.settleFeedProbes();
  globalThis.fetch = originalFetch;
  for (const key of envKeys) {
    if (oldEnv[key] === undefined) delete process.env[key];
    else process.env[key] = oldEnv[key];
  }
  __resetKeyPrefixCacheForTests();
});

describe('feed cache background refresh', () => {
  it('is due only for a healthy parse confirmed more than five minutes ago', async () => {
    const now = Date.now();
    assert.equal(isDueForRefresh(await parsed(['A story']), now), false, 'an entry from before fetchedAt existed ages out instead');
    assert.equal(isDueForRefresh(await parsed(['A story'], { fetchedAt: now - FEED_REFRESH_AFTER_MS + 1000 }), now), false);
    assert.equal(isDueForRefresh(await parsed(['A story'], { fetchedAt: now - FEED_REFRESH_AFTER_MS }), now), true);
    assert.equal(isDueForRefresh({ items: [], parsedTotal: 0, droppedUndated: 0, fetchedAt: 0 }, now), false, 'a cached failure is never refreshed in the background');
  });

  it('stamps fetchedAt and the publisher validators on a foreground fetch', async () => {
    install(() => new Response(rss(['Fresh story']), { status: 200, headers: { etag: '"v1"', 'last-modified': 'Sat, 17 Oct 2026 10:00:00 GMT' } }));
    const before = Date.now();
    const result = await fetchAndParseRss(FEED, VARIANT, new AbortController().signal);
    assert.equal(result.items[0]?.title, 'Fresh story');
    assert.ok(result.fetchedAt! >= before);
    assert.deepEqual(cachedEntry().validators, { etag: '"v1"', lastModified: 'Sat, 17 Oct 2026 10:00:00 GMT' });
  });

  it('serves a stale parse without waiting and refreshes it after', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    install(() => new Response(rss(['Newer story']), { status: 200 }));
    seed(await parsed(['Older story'], { fetchedAt: Date.now() - 10 * 60_000 }));
    const origin = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === FEED.url) await gate;
      return origin(input, init);
    }) as typeof fetch;

    const served = await fetchAndParseRss(FEED, VARIANT, new AbortController().signal);
    assert.equal(served.items[0]?.title, 'Older story', 'the build is not held up by upstream');
    release();
    for (let i = 0; i < 50 && cachedEntry().items[0]?.title !== 'Newer story'; i += 1) await new Promise((r) => setTimeout(r, 5));
    assert.equal(cachedEntry().items[0]?.title, 'Newer story', 'the next build reads the refreshed parse');
  });

  it('does not ask upstream when the parse is fresh', async () => {
    install(() => { throw new Error('upstream must not be called'); });
    seed(await parsed(['Story'], { fetchedAt: Date.now() - 60_000 }));
    await fetchAndParseRss(FEED, VARIANT, new AbortController().signal);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(upstreamCalls.length, 0);
  });

  it('sends a conditional GET and only re-dates the entry on 304', async () => {
    install(() => new Response(null, { status: 304 }));
    const stale = await parsed(['Story'], { fetchedAt: Date.now() - 10 * 60_000, validators: { etag: '"v1"', lastModified: 'Sat, 17 Oct 2026 10:00:00 GMT' } });
    seed(stale);
    const before = Date.now();
    assert.equal(await refreshFeedCache(FEED, VARIANT, stale), 'not-modified');
    assert.equal(upstreamCalls[0]!.get('if-none-match'), '"v1"');
    assert.equal(upstreamCalls[0]!.get('if-modified-since'), 'Sat, 17 Oct 2026 10:00:00 GMT');
    const entry = cachedEntry();
    assert.ok(entry.fetchedAt! >= before);
    assert.deepEqual(entry.items, stale.items);
    assert.ok(redis.expires.get(KEY)! > 3000, 'a 304 restores the full healthy TTL');
  });

  it('on 304 re-dates the parse it read, and leaves a newer parse a foreground fetch stored meanwhile', async () => {
    install(() => new Response(null, { status: 304 }));
    const parsedAt = Date.now() - 10 * 60_000;
    const stale = await parsed(['Story'], { fetchedAt: parsedAt, parsedAt, validators: { etag: '"v1"' } });
    seed(stale);
    assert.equal(await refreshFeedCache(FEED, VARIANT, stale), 'not-modified');
    assert.equal(cachedEntry().parsedAt, parsedAt);
    assert.ok(cachedEntry().fetchedAt! > parsedAt, 'the same parse is re-dated');

    // While the conditional request is in flight, the entry expires and a
    // foreground fetch stores a newer parse, whose country pool is keyed to
    // that newer parsedAt.
    redis.redis.delete(`rss:feed-refresh-lock:v1:${VARIANT}:${FEED.url}`);
    const newer = await parsed(['Newer story'], { fetchedAt: Date.now(), parsedAt: Date.now() });
    const origin = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === FEED.url) seed(newer);
      return origin(input, init);
    }) as typeof fetch;
    assert.equal(await refreshFeedCache(FEED, VARIANT, stale), 'not-modified');
    assert.deepEqual(cachedEntry(), newer, 'the older entry is not put back');
  });

  it('on 304 never keeps the entry past the country pool written with its parse', async () => {
    // The conditional request starts inside the hour; its 304 lands 1700s later.
    const realNow = Date.now;
    const start = realNow();
    let skew = 0;
    Date.now = () => realNow() + skew;
    try {
      install(() => {
        skew = 1700_000;
        return new Response(null, { status: 304 });
      });
      const parsedAt = start - 3500_000;
      const stale = await parsed(['Story'], { fetchedAt: parsedAt, parsedAt, validators: { etag: '"v1"' } });
      seed(stale);
      assert.equal(await refreshFeedCache(FEED, VARIANT, stale), 'not-modified');
      assert.equal(upstreamCalls[0]!.get('if-none-match'), '"v1"', 'fixture premise: a conditional request');
      const ttl = redis.expires.get(KEY)!;
      assert.ok(ttl > 1990 && ttl <= 2000, `renewed for ${ttl}s; the pool expires 7200s after the parse, 5200s ago`);
    } finally {
      Date.now = realNow;
    }
  });

  it('on 304 a renewal that reaches Redis after the pool expired cannot keep the entry', async () => {
    const realNow = Date.now;
    const start = realNow();
    let skew = 0;
    Date.now = () => realNow() + skew;
    try {
      install(() => {
        skew = 1700_000;
        return new Response(null, { status: 304 });
      });
      // The write lands 2100s after the 304, past any client timeout and past
      // the pool's expiry 2000s after the 304.
      const redisFetch = redis.fetchImpl;
      let renewal: unknown[] | undefined;
      redis.fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const body = String(init?.body ?? '');
        if (body.includes('EVAL')) {
          renewal = (JSON.parse(body) as unknown[][])[0];
          skew += 2100_000;
        }
        return redisFetch(input, init);
      }) as typeof fetch;
      const parsedAt = start - 3500_000;
      const stale = await parsed(['Story'], { fetchedAt: parsedAt, parsedAt, validators: { etag: '"v1"' } });
      seed(stale);
      assert.equal(await refreshFeedCache(FEED, VARIANT, stale), 'not-modified');
      assert.equal(renewal?.[6], String(parsedAt + 7200_000), 'the expiry sent is the pool deadline itself, not a TTL');
      assert.equal(redis.redis.has(KEY), false, 'the entry ends no later than its country pool');
    } finally {
      Date.now = realNow;
    }
  });

  it('on 304 in the desktop sidecar leaves a newer parse a foreground fetch stored meanwhile', async () => {
    process.env.LOCAL_API_MODE = 'tauri-sidecar';
    install(() => new Response(null, { status: 304 }));
    const { sidecarCacheGet, sidecarCacheSet } = await import('../server/_shared/sidecar-cache');
    const parsedAt = Date.now() - 10 * 60_000;
    const stale = await parsed(['Story'], { fetchedAt: parsedAt, parsedAt, validators: { etag: '"v1"' } });
    const newer = await parsed(['Newer story'], { fetchedAt: Date.now(), parsedAt: Date.now() });
    sidecarCacheSet(KEY, newer, 3600);
    assert.equal(await refreshFeedCache(FEED, VARIANT, stale), 'not-modified');
    assert.deepEqual(sidecarCacheGet(KEY), newer, 'the older entry is not put back');

    // A second feed, so its refresh lock is free: an unchanged parse is re-dated.
    const other = { name: 'Reuters Europe', url: 'https://feeds.example.org/europe.xml' };
    const otherKey = rssFeedCacheKey(VARIANT, other.url);
    const origin = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => (
      String(input) === other.url ? new Response(null, { status: 304 }) : origin(input, init)
    )) as typeof fetch;
    sidecarCacheSet(otherKey, stale, 3600);
    assert.equal(await refreshFeedCache(other, VARIANT, stale), 'not-modified');
    assert.ok((sidecarCacheGet(otherKey) as ParseResult).fetchedAt! > parsedAt, 'the same parse is re-dated');
  });

  it('replaces the parse and its validators when upstream has new items', async () => {
    install(() => new Response(rss(['Breaking update']), { status: 200, headers: { etag: '"v2"' } }));
    const stale = await parsed(['Story'], { fetchedAt: Date.now() - 10 * 60_000, validators: { etag: '"v1"' } });
    seed(stale);
    assert.equal(await refreshFeedCache(FEED, VARIANT, stale), 'updated');
    assert.equal(cachedEntry().items[0]?.title, 'Breaking update');
    assert.deepEqual(cachedEntry().validators, { etag: '"v2"' });
  });

  it('keeps the healthy parse when upstream fails or returns no items', async () => {
    for (const response of [() => new Response('down', { status: 503 }), () => new Response(rss([]), { status: 200 })]) {
      install(response);
      const stale = await parsed(['Story'], { fetchedAt: Date.now() - 10 * 60_000 });
      seed(stale);
      assert.equal(await refreshFeedCache(FEED, VARIANT, stale), 'failed');
      assert.deepEqual(cachedEntry(), stale);
    }
  });

  it('keeps the healthy parse when every refreshed entry fails the date gate', async () => {
    const undated = `<?xml version="1.0"?><rss><channel><item><title>No date here</title><link>https://feeds.example.org/x</link></item></channel></rss>`;
    install(() => new Response(undated, { status: 200 }));
    const stale = await parsed(['Story'], { fetchedAt: Date.now() - 10 * 60_000 });
    seed(stale);
    assert.equal(await refreshFeedCache(FEED, VARIANT, stale), 'failed', 'titled but unusable entries are not a replacement');
    assert.deepEqual(cachedEntry(), stale);
  });

  it('does a full GET once the last full parse is an hour old, so date-gated items get re-checked', async () => {
    install(() => new Response(rss(['Story', 'Scheduled story now live']), { status: 200, headers: { etag: '"v1"' } }));
    const hourOld = Date.now() - 61 * 60_000;
    const stale = await parsed(['Story'], { fetchedAt: Date.now() - 10 * 60_000, parsedAt: hourOld, validators: { etag: '"v1"' } });
    seed(stale);
    assert.equal(await refreshFeedCache(FEED, VARIANT, stale), 'updated');
    assert.equal(upstreamCalls[0]!.get('if-none-match'), null, 'unconditional, so an unchanged body is parsed again');
    assert.equal(cachedEntry().items.length, 2);
    assert.ok(cachedEntry().parsedAt! > hourOld);
  });

  it('keeps the full-parse time across 304s', async () => {
    install(() => new Response(null, { status: 304 }));
    const parsedAt = Date.now() - 30 * 60_000;
    const stale = await parsed(['Story'], { fetchedAt: Date.now() - 10 * 60_000, parsedAt, validators: { etag: '"v1"' } });
    seed(stale);
    assert.equal(await refreshFeedCache(FEED, VARIANT, stale), 'not-modified');
    assert.equal(cachedEntry().parsedAt, parsedAt);
  });

  it('lets one refresher per feed run across concurrent builds', async () => {
    install(() => new Response(null, { status: 304 }));
    const stale = await parsed(['Story'], { fetchedAt: Date.now() - 10 * 60_000, validators: { etag: '"v1"' } });
    seed(stale);
    const outcomes = await Promise.all([refreshFeedCache(FEED, VARIANT, stale), refreshFeedCache(FEED, VARIANT, stale)]);
    assert.deepEqual(outcomes.sort(), ['locked', 'not-modified']);
    assert.equal(upstreamCalls.length, 1);
  });
});

describe('deadline-aborted fetches', () => {
  it('does not cache an empty row when the global deadline aborted the fetch', async () => {
    const deadline = new AbortController();
    install(() => {
      deadline.abort();
      throw new DOMException('The operation was aborted.', 'AbortError');
    });
    const result = await fetchAndParseRss(FEED, VARIANT, deadline.signal);
    assert.equal(result.items.length, 0);
    assert.equal(result.attempt?.failure, 'deadline-abort');
    // The next build must fetch the feed again, not serve a 5-minute empty row
    // that the old batch barrier would never have started.
    assert.equal(redis.redis.get(KEY), undefined);
  });

  it('does not start the relay fallback once the deadline has aborted', async () => {
    process.env.WS_RELAY_URL = 'https://relay.example';
    const deadline = new AbortController();
    install(() => {
      deadline.abort();
      throw new DOMException('The operation was aborted.', 'AbortError');
    });
    const relayCalls: string[] = [];
    const feedFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const href = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (new URL(href).host === 'relay.example') {
        relayCalls.push(href);
        // A relay request that ignores the deadline runs its own 8 s timeout.
        return new Response(rss(['Late relay story']), { status: 200 });
      }
      return feedFetch(input, init);
    }) as typeof fetch;
    const result = await fetchAndParseRss(FEED, VARIANT, deadline.signal);
    assert.deepEqual(relayCalls, [], 'an expired deadline must not start another request');
    assert.equal(result.items.length, 0);
    assert.equal(result.attempt?.failure, 'deadline-abort');
  });

  it('caches a feed that timed out on its own clock before the deadline cut its relay', async (t) => {
    process.env.WS_RELAY_URL = 'https://relay.example';
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const deadline = new AbortController();
    const hangUntilAborted = (signal: AbortSignal | null | undefined) => new Promise<Response>((_, reject) => {
      signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')), { once: true });
    });
    let relayStarted!: () => void;
    const relayStart = new Promise<void>((resolve) => { relayStarted = resolve; });
    redis = createRedisFetch({});
    upstreamCalls = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const href = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (new URL(href).host === 'redis.example') return redis.fetchImpl(input, init);
      if (new URL(href).host === 'relay.example') {
        relayStarted();
        return hangUntilAborted(init?.signal);
      }
      if (href === FEED.url) {
        upstreamCalls.push(new Headers(init?.headers));
        return hangUntilAborted(init?.signal);
      }
      throw new Error(`unexpected fetch ${href}`);
    }) as typeof fetch;

    const pending = fetchAndParseRss(FEED, VARIANT, deadline.signal);
    while (upstreamCalls.length === 0) await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(8_000);
    await relayStart;
    deadline.abort();
    const result = await pending;

    assert.equal(result.items.length, 0);
    assert.equal(result.attempt?.failure, 'per-feed-timeout', 'the feed failed on its own 8 s clock');
    assert.notEqual(redis.redis.get(KEY), undefined, 'an unresponsive feed must not pin every later build to the deadline');

    const next = await fetchAndParseRss(FEED, VARIANT, new AbortController().signal);
    assert.equal(next.attempt?.negativeCache, true);
    assert.equal(upstreamCalls.length, 1, 'the next build serves the cached failure instead of waiting on the feed');
  });

  it('probes a feed the deadline cut early, so a feed that hangs is cached as failed', async (t) => {
    process.env.WS_RELAY_URL = 'https://relay.example';
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const deadline = new AbortController();
    const hangUntilAborted = (signal: AbortSignal | null | undefined) => new Promise<Response>((_, reject) => {
      signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')), { once: true });
    });
    let relayStarted!: () => void;
    const relayStart = new Promise<void>((resolve) => { relayStarted = resolve; });
    redis = createRedisFetch({});
    upstreamCalls = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const href = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (new URL(href).host === 'redis.example') return redis.fetchImpl(input, init);
      if (new URL(href).host === 'relay.example') {
        relayStarted();
        return hangUntilAborted(init?.signal);
      }
      if (href === FEED.url) {
        upstreamCalls.push(new Headers(init?.headers));
        return hangUntilAborted(init?.signal);
      }
      throw new Error(`unexpected fetch ${href}`);
    }) as typeof fetch;

    // The feed started late in the build: the deadline fires 3 s into its 8 s.
    const pending = fetchAndParseRss(FEED, VARIANT, deadline.signal);
    while (upstreamCalls.length === 0) await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(3_000);
    deadline.abort();
    const result = await pending;
    assert.equal(result.attempt?.failure, 'deadline-abort', 'the build itself still reports its own deadline');

    // After the response the feed gets its own full budget: 8 s direct, then 8 s relay.
    for (let i = 0; i < 200 && upstreamCalls.length < 2; i += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(upstreamCalls.length, 2, 'the cut feed is fetched again after the response');
    t.mock.timers.tick(8_000);
    await relayStart;
    t.mock.timers.tick(8_000);
    await __testing__.settleFeedProbes();

    const next = await fetchAndParseRss(FEED, VARIANT, new AbortController().signal);
    assert.equal(next.attempt?.negativeCache, true, 'a feed that hangs must not pin every later build to the deadline');
    assert.equal(upstreamCalls.length, 2, 'the next build serves the cached failure instead of waiting on the feed');
  });

  it('caches a healthy feed the deadline cut early as healthy, not as failed', async () => {
    const deadline = new AbortController();
    let cut = true;
    install(() => {
      if (cut) {
        cut = false;
        deadline.abort();
        throw new DOMException('The operation was aborted.', 'AbortError');
      }
      return new Response(rss(['Late but healthy']), { status: 200 });
    });
    const result = await fetchAndParseRss(FEED, VARIANT, deadline.signal);
    assert.equal(result.attempt?.failure, 'deadline-abort');
    await __testing__.settleFeedProbes();
    assert.equal(cachedEntry().items[0]?.title, 'Late but healthy');
    assert.equal(upstreamCalls.length, 2);
  });

  it('probes a cut feed once across concurrent builds', async () => {
    const deadline = new AbortController();
    let calls = 0;
    install(() => {
      calls += 1;
      if (calls <= 2) {
        deadline.abort();
        throw new DOMException('The operation was aborted.', 'AbortError');
      }
      return new Response(rss(['Story']), { status: 200 });
    });
    await Promise.all([
      fetchAndParseRss(FEED, VARIANT, deadline.signal),
      fetchAndParseRss(FEED, VARIANT, deadline.signal),
    ]);
    await __testing__.settleFeedProbes();
    assert.equal(cachedEntry().items[0]?.title, 'Story');
    assert.equal(upstreamCalls.length, 3, 'two cut attempts, one probe');
  });

  it('still caches an empty row for an upstream failure', async () => {
    install(() => new Response('nope', { status: 503 }));
    const result = await fetchAndParseRss(FEED, VARIANT, new AbortController().signal);
    assert.equal(result.items.length, 0);
    assert.notEqual(redis.redis.get(KEY), undefined);
  });
});
