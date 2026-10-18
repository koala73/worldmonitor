import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  FEED_REFRESH_AFTER_MS,
  fetchAndParseRss,
  isDueForRefresh,
  refreshFeedCache,
  type ParseResult,
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
  const { __testing__ } = await import('../server/worldmonitor/news/v1/list-feed-digest');
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

afterEach(() => {
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
