// 2026-10-17 audit of /verify against Google News World: Al Jazeera's own RSS
// carries 25 entries, about ten hours, so older Al Jazeera stories were not
// searchable. Its Google News site: search returns 100 entries over two days.
// That search feeds the claim pool only: the digest and panels keep the
// native feed.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { VARIANT_FEEDS } from '../server/worldmonitor/news/v1/_feeds';
import { __testing__ as digest } from '../server/worldmonitor/news/v1/list-feed-digest';
import { __testing__ as claimPool, searchClaimPool } from '../server/worldmonitor/news/v1/search-claim-headlines';
import { rssFeedCacheKey } from '../server/worldmonitor/news/v1/_rss-cache';
import { REVOKED_URLS_KEY } from '../server/_shared/digest-revocations';
import { __resetKeyPrefixCacheForTests } from '../server/_shared/redis';

const gn = (q: string) => `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
const NATIVE_URL = 'https://www.aljazeera.com/xml/rss/all.xml';
const DEPTH_URL = gn('site:aljazeera.com when:2d');
const aljazeera = VARIANT_FEEDS.full!.middleeast!.find((feed) => feed.name === 'Al Jazeera')!;
const envKeys = ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'VERCEL_ENV', 'LOCAL_API_MODE', 'NEWS_MAX_AGE_HOURS'] as const;
const oldEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
const originalFetch = globalThis.fetch;
let cache: Map<string, unknown>;
let revoked: string[];

const hoursAgo = (hours: number) => Date.now() - hours * 3600_000;
const nativeXml = (titles: string[]) => `<?xml version="1.0"?><rss><channel>${titles.map((title, i) => `<item>
  <title>${title}</title><link>https://www.aljazeera.com/news/2026/10/17/story-${i}</link>
  <pubDate>${new Date(hoursAgo(i + 1)).toUTCString()}</pubDate></item>`).join('')}</channel></rss>`;
const depthXml = (titles: string[]) => `<?xml version="1.0"?><rss><channel>${titles.map((title, i) => `<item>
  <title>${title} - Al Jazeera</title><link>https://news.google.com/rss/articles/CBMi${i}?oc=5</link>
  <pubDate>${new Date(hoursAgo(i + 1)).toUTCString()}</pubDate>
  <source url="https://www.aljazeera.com">Al Jazeera</source></item>`).join('')}</channel></rss>`;

beforeEach(() => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fixture-token';
  process.env.VERCEL_ENV = 'production';
  delete process.env.LOCAL_API_MODE;
  delete process.env.NEWS_MAX_AGE_HOURS;
  __resetKeyPrefixCacheForTests();
  claimPool.resetPool();
  cache = new Map();
  revoked = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of envKeys) {
    if (oldEnv[key] === undefined) delete process.env[key];
    else process.env[key] = oldEnv[key];
  }
  __resetKeyPrefixCacheForTests();
});

/** Redis REST GET/SET/pipeline over `cache`, plus the two Al Jazeera feeds. */
function stubFetch(publisher: Record<string, string>, fetched: string[] = []) {
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    if (href in publisher) {
      fetched.push(href);
      return new Response(publisher[href]);
    }
    const get = href.match(/^https:\/\/redis\.example\.test\/get\/(.+)$/);
    if (get) {
      const key = decodeURIComponent(get[1]!);
      return Response.json({ result: cache.has(key) ? JSON.stringify(cache.get(key)) : null });
    }
    if (href === 'https://redis.example.test/') {
      const command = JSON.parse(String(init?.body)) as string[];
      assert.equal(command[0], 'SET');
      cache.set(command[1]!, JSON.parse(command[2]!));
      return Response.json({ result: 'OK' });
    }
    if (href === 'https://redis.example.test/pipeline') {
      const batch = JSON.parse(String(init?.body)) as string[][];
      return Response.json(batch.map((command) => {
        if (command[0] === 'SMEMBERS') {
          assert.equal(command[1], REVOKED_URLS_KEY);
          return { result: revoked };
        }
        if (command[0] === 'GET') return { result: cache.has(command[1]!) ? JSON.stringify(cache.get(command[1]!)) : null };
        return { result: 'OK' };
      }));
    }
    throw new Error(`unexpected fetch ${href}`);
  };
}

describe('Al Jazeera claim-pool depth feed', () => {
  it('keeps the native feed for the digest and adds the Google News search as a pool-only depth URL', () => {
    assert.equal(aljazeera.url, NATIVE_URL);
    assert.equal(aljazeera.depthUrl, DEPTH_URL);
    const digestUrls = digest.buildDigestFeedBatches('full', 'en').allEntries.map((entry) => entry.feed.url);
    assert.ok(digestUrls.includes(NATIVE_URL));
    assert.ok(!digestUrls.includes(DEPTH_URL), 'the depth search is not a digest feed');
  });

  it('warms every depth URL at once in the full variant, without touching native feeds', async () => {
    const fetched: string[] = [];
    stubFetch({ [DEPTH_URL]: depthXml(['Sudan army retakes Wad Madani bridge']) }, fetched);
    const entries = digest.buildDigestFeedBatches('full', 'en').allEntries;
    await digest.warmDepthFeeds(entries, 'full', new AbortController().signal);
    assert.deepEqual(fetched, [DEPTH_URL]);
    const depth = cache.get(rssFeedCacheKey('full', DEPTH_URL)) as { items: Array<{ source: string; link: string }> };
    assert.equal(depth.items[0]!.source, 'Al Jazeera');
    assert.match(depth.items[0]!.link, /^https:\/\/news\.google\.com\/rss\/articles\//, 'the publisher-link gate keeps Google News links');
  });

  it('warms nothing outside the full variant', async () => {
    const fetched: string[] = [];
    stubFetch({}, fetched);
    await digest.warmDepthFeeds([{ attemptId: 'middleeast:0', category: 'middleeast', feed: aljazeera }], 'finance', new AbortController().signal);
    assert.deepEqual(fetched, []);
  });

  it('settles when the build deadline aborts a stalled depth fetch, and never throws', async () => {
    stubFetch({});
    const stalled = globalThis.fetch;
    globalThis.fetch = async (url, init) => String(url) === DEPTH_URL
      ? new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
      : stalled(url, init);
    const deadline = new AbortController();
    let settled = false;
    const warming = digest.warmDepthFeeds([{ attemptId: 'middleeast:0', category: 'middleeast', feed: aljazeera }], 'full', deadline.signal)
      .then(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(settled, false, 'still waiting on the stalled depth fetch');
    deadline.abort();
    await warming;
    assert.equal(settled, true);
  });

  it('starts depth warming before the batches and awaits it only after them', () => {
    const src = readFileSync(new URL('../server/worldmonitor/news/v1/list-feed-digest.ts', import.meta.url), 'utf8');
    const start = src.indexOf('const depthWarming = warmDepthFeeds(allEntries, variant, deadlineController.signal);');
    const batches = src.indexOf('const attempts = await runFeedAttemptBatches(');
    const settle = src.indexOf('await depthWarming;');
    assert.ok(start > 0 && start < batches && batches < settle, 'warm, then run batches, then settle');
    const attempt = src.slice(batches, settle);
    assert.match(attempt, /fetchAndParseRss\(feed, variant, deadlineController\.signal\)/);
    assert.doesNotMatch(attempt, /depth/i, 'no batch attempt waits on a depth fetch');
  });

  it('lets /verify find a story that only the depth search carries, credited to Al Jazeera without the suffix', async () => {
    stubFetch({});
    cache.set(rssFeedCacheKey('full', NATIVE_URL), digest.parseRssXml(nativeXml(['Gaza ceasefire talks resume in Cairo']), aljazeera, 'full'));
    const depthFeed = { name: 'Al Jazeera', url: DEPTH_URL };
    const titles = Array.from({ length: 40 }, (_, i) => `Filler headline ${i} on regional markets`);
    titles[30] = 'Sudan army retakes Wad Madani bridge from RSF fighters';
    cache.set(rssFeedCacheKey('full', DEPTH_URL), digest.parseRssXml(depthXml(titles), depthFeed, 'full'));
    const search = await searchClaimPool('Sudan army retakes Wad Madani bridge from RSF');
    const hit = search.candidates.find((item) => item.title.startsWith('Sudan army'));
    assert.ok(hit, 'the depth-only story is searchable');
    assert.equal(hit.source, 'Al Jazeera');
    assert.equal(hit.title, 'Sudan army retakes Wad Madani bridge from RSF fighters');
  });

  it('keeps one copy of a story both feeds carry, with the native link', async () => {
    stubFetch({});
    const title = 'Gaza ceasefire talks resume in Cairo with Qatari mediators';
    cache.set(rssFeedCacheKey('full', NATIVE_URL), digest.parseRssXml(nativeXml([title]), aljazeera, 'full'));
    cache.set(rssFeedCacheKey('full', DEPTH_URL), digest.parseRssXml(depthXml([title]), { name: 'Al Jazeera', url: DEPTH_URL }, 'full'));
    const search = await searchClaimPool(title);
    const copies = search.candidates.filter((item) => item.title === title);
    assert.equal(copies.length, 1);
    assert.match(copies[0]!.link, /^https:\/\/www\.aljazeera\.com\//);
  });

  it('keeps a story out when its native link is revoked, even through the Google News copy', async () => {
    stubFetch({});
    const title = 'Gaza ceasefire talks resume in Cairo with Qatari mediators';
    const native = digest.parseRssXml(nativeXml([title, 'Unrelated story about Lebanon solar plant']), aljazeera, 'full')!;
    revoked = ['https://www.aljazeera.com/news/2026/10/17/story-0'];
    cache.set(rssFeedCacheKey('full', NATIVE_URL), native);
    cache.set(rssFeedCacheKey('full', DEPTH_URL), digest.parseRssXml(depthXml([title]), { name: 'Al Jazeera', url: DEPTH_URL }, 'full'));
    const search = await searchClaimPool(title);
    assert.ok(!search.candidates.some((item) => item.title === title), 'the revoked story stays out');
  });

  it('searches a cached depth URL without counting it as a cached feed', async () => {
    stubFetch({});
    const title = 'Sudan army retakes Wad Madani bridge from RSF fighters';
    cache.set(rssFeedCacheKey('full', NATIVE_URL), digest.parseRssXml(nativeXml(['Gaza ceasefire talks resume in Cairo']), aljazeera, 'full'));
    cache.set(rssFeedCacheKey('full', DEPTH_URL), digest.parseRssXml(depthXml([title]), { name: 'Al Jazeera', url: DEPTH_URL }, 'full'));
    const search = await searchClaimPool(title);
    assert.ok(search.candidates.some((item) => item.title === title));
    assert.equal(search.feedCached, 1, 'only catalog feeds count toward coverage');
    assert.equal(search.searchedFeeds, 1);
    assert.equal(search.searchedHeadlines, 2);
  });
});
