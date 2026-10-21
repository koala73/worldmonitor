// /verify claim search: every fresh headline in the full-variant RSS caches,
// including entries kept past the digest's five-per-feed cap.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { newsHandler } from '../server/worldmonitor/news/v1/handler';
import { __testing__ as digest } from '../server/worldmonitor/news/v1/list-feed-digest';
import { __testing__ as claimPool } from '../server/worldmonitor/news/v1/search-claim-headlines';
import { rssFeedCacheKey } from '../server/worldmonitor/news/v1/_rss-cache';
import { REVOKED_URLS_KEY } from '../server/_shared/digest-revocations';
import { drainResponseHeaders } from '../server/_shared/response-headers';
import { __resetKeyPrefixCacheForTests } from '../server/_shared/redis';
import { createNewsServiceRoutes, type SearchClaimHeadlinesResponse } from '../src/generated/server/worldmonitor/news/v1/service_server';
import { validateGeneratedRequest } from '../server/request-validator';

const route = createNewsServiceRoutes(newsHandler, { validateRequest: validateGeneratedRequest })
  .find(entry => entry.path.endsWith('/search-claim-headlines'))!;
const envKeys = ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'VERCEL_ENV', 'LOCAL_API_MODE', 'NEWS_MAX_AGE_HOURS'] as const;
const oldEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
const originalFetch = globalThis.fetch;
const entries = digest.buildDigestFeedBatches('full', 'en').allEntries;
let cache: Map<string, unknown>;
let reads: number;
let revoked: string[];
let failRevocations: boolean;

function feed(name: string) {
  const found = entries.find(entry => entry.feed.name === name)?.feed;
  assert.ok(found, `${name} is a registered English digest feed`);
  return found;
}

const hoursAgo = (hours: number) => Date.now() - hours * 3600_000;
const row = (source: string, title: string, link: string, publishedAt = hoursAgo(1)) => ({ source, title, link, publishedAt });

function put(source: string, items: unknown[], countryItems?: unknown[]) {
  cache.set(rssFeedCacheKey('full', feed(source).url), { items, ...(countryItems ? { countryItems } : {}) });
}

async function request(claim: string) {
  const req = new Request(`https://example.test/api/news/v1/search-claim-headlines?claim=${encodeURIComponent(claim)}`);
  const res = await route.handler(req);
  return { req, payload: await res.json() as SearchClaimHeadlinesResponse };
}

beforeEach(() => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fixture-token';
  process.env.VERCEL_ENV = 'production';
  delete process.env.LOCAL_API_MODE;
  delete process.env.NEWS_MAX_AGE_HOURS;
  __resetKeyPrefixCacheForTests();
  claimPool.resetPool();
  cache = new Map(entries.map(entry => [rssFeedCacheKey('full', entry.feed.url), { items: [] }]));
  reads = 0;
  revoked = [];
  failRevocations = false;
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), 'https://redis.example.test/pipeline', 'never fetch a publisher');
    const batch = JSON.parse(String(init?.body)) as string[][];
    return Response.json(batch.map(command => {
      if (command[0] === 'SMEMBERS') {
        assert.equal(command[1], REVOKED_URLS_KEY);
        return failRevocations ? { error: 'fixture read failure' } : { result: revoked };
      }
      assert.equal(command[0], 'GET', 'the search is read-only');
      reads++;
      return { result: cache.has(command[1]!) ? JSON.stringify(cache.get(command[1]!)) : null };
    }));
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of envKeys) {
    if (oldEnv[key] === undefined) delete process.env[key];
    else process.env[key] = oldEnv[key];
  }
  __resetKeyPrefixCacheForTests();
});

describe('claim headline search over the RSS caches', () => {
  it('finds headlines past the digest cap and returns only those sharing the claim\'s words, best first', async () => {
    put('BBC World', [row('BBC World', 'Storm hits Manila', 'https://www.bbc.co.uk/news/1')],
      [row('BBC World', 'Brazil abolishes six-day working week, a win for Lula', 'https://www.bbc.co.uk/news/2')]);
    put('Guardian World', [], [row('Guardian World', 'Brazil abolishes six-day workweek in win for Lula', 'https://www.theguardian.com/world/3')]);
    put('Al Jazeera', [row('Al Jazeera', 'Lula visits Angola', 'https://www.aljazeera.com/4')]);
    const { req, payload } = await request('Brazil abolishes six-day workweek in win for Lula');
    assert.deepEqual(payload.headlines.map(h => h.source), ['Guardian World', 'BBC World', 'Al Jazeera']);
    assert.equal(payload.headlines[0]!.link, 'https://www.theguardian.com/world/3');
    assert.equal(typeof payload.headlines[0]!.publishedAt, 'number');
    assert.equal(payload.searchedHeadlines, 4);
    assert.equal(payload.searchedFeeds, 3);
    assert.equal(payload.state, 'complete');
    assert.equal(payload.feedCached, payload.feedTotal);
    assert.equal(drainResponseHeaders(req)?.['X-No-Cache'], undefined);
  });

  it('drops stale, future-dated and revoked headlines, and counts a story once per link', async () => {
    revoked = ['https://www.bbc.co.uk/news/revoked'];
    put('BBC World', [
      row('BBC World', 'Brazil abolishes six-day workweek', 'https://www.bbc.co.uk/news/fresh'),
      row('BBC World', 'Brazil abolishes six-day workweek', 'https://www.bbc.co.uk/news/fresh'),
      row('BBC World', 'Brazil abolishes six-day workweek', 'https://www.bbc.co.uk/news/old', hoursAgo(97)),
      row('BBC World', 'Brazil abolishes six-day workweek', 'https://www.bbc.co.uk/news/future', hoursAgo(-2)),
      row('BBC World', 'Brazil abolishes six-day workweek', 'https://www.bbc.co.uk/news/revoked'),
      row('Not BBC', 'Brazil abolishes six-day workweek', 'https://www.bbc.co.uk/news/wrong-feed'),
    ]);
    const { payload } = await request('Brazil abolishes six-day workweek');
    assert.deepEqual(payload.headlines.map(h => h.link), ['https://www.bbc.co.uk/news/fresh']);
    assert.equal(payload.searchedHeadlines, 1);
  });

  it('credits a broad Google News feed\'s rows to their trusted publishers; a site: feed keeps its label', async () => {
    const origin = (source: string, title: string, link: string, originPublisher: string, originPublisherTrusted = true) =>
      ({ ...row(source, title, link), originPublisher, originPublisherTrusted });
    put('AI News', [
      origin('AI News', 'OpenAI raises $40 billion in record funding round', 'https://www.bloomberg.com/1', 'Bloomberg'),
      origin('AI News', 'OpenAI closes record $40 billion funding round', 'https://www.theverge.com/2', 'The Verge'),
      origin('AI News', 'OpenAI funding round sets record at $40 billion', 'https://example.org/3', 'Untrusted Outlet', false),
    ]);
    put('Reuters World', [origin('Reuters World', 'OpenAI raises $40 billion in funding round', 'https://www.reuters.com/4', 'Reuters')]);
    const { payload } = await request('OpenAI raises $40 billion in record funding round');
    assert.deepEqual(payload.headlines.map(h => h.source).sort(), ['AI News', 'Bloomberg', 'Reuters World', 'The Verge']);
    assert.equal(payload.searchedFeeds, 2, 'feeds, not publishers');
  });

  it('an empty claim returns the counts only, and the pool read is reused across claims', async () => {
    put('BBC World', [row('BBC World', 'Storm hits Manila', 'https://www.bbc.co.uk/news/1')]);
    const { payload } = await request('');
    assert.deepEqual(payload.headlines, []);
    assert.equal(payload.searchedHeadlines, 1);
    const before = reads;
    await request('Storm hits Manila');
    assert.equal(reads, before, 'one feed-cache read serves the next claims');
  });

  it('missing feed caches make the search partial, which is still a search and may be cached', async () => {
    cache.delete(rssFeedCacheKey('full', feed('Al Jazeera').url));
    put('BBC World', [row('BBC World', 'Storm hits Manila', 'https://www.bbc.co.uk/news/1')]);
    const { req, payload } = await request('Storm hits Manila');
    assert.equal(payload.state, 'partial');
    assert.equal(payload.feedCached, payload.feedTotal - 1);
    assert.equal(payload.headlines.length, 1);
    assert.equal(drainResponseHeaders(req)?.['X-No-Cache'], undefined);
  });

  it('an unreadable revocation list searches nothing: unavailable, never an empty search', async () => {
    failRevocations = true;
    put('BBC World', [row('BBC World', 'Storm hits Manila', 'https://www.bbc.co.uk/news/1')]);
    const { req, payload } = await request('Storm hits Manila');
    assert.equal(payload.state, 'unavailable');
    assert.equal(payload.searchedHeadlines, 0);
    assert.deepEqual(payload.headlines, []);
    assert.equal(drainResponseHeaders(req)?.['X-No-Cache'], '1');
    // A failed read is not reused.
    failRevocations = false;
    assert.equal((await request('Storm hits Manila')).payload.state, 'complete');
  });
});
