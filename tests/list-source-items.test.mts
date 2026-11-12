// ListSourceItems (#9796): a panel whose enabled sources fell below the
// digest's per-category cap reads those sources' cached feed parses. It reads
// the cache only: a request never builds a digest or fetches a publisher.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { newsHandler } from '../server/worldmonitor/news/v1/handler';
import { REVOKED_URLS_KEY } from '../server/_shared/digest-revocations';
import { __resetKeyPrefixCacheForTests } from '../server/_shared/redis';
import { drainResponseHeaders } from '../server/_shared/response-headers';
import { rssFeedCacheKey } from '../server/worldmonitor/news/v1/_rss-cache';
import { INTEL_SOURCES, VARIANT_FEEDS } from '../server/worldmonitor/news/v1/_feeds';
import { createNewsServiceRoutes, type ListSourceItemsResponse } from '../src/generated/server/worldmonitor/news/v1/service_server';
import { validateGeneratedRequest } from '../server/request-validator';

const route = createNewsServiceRoutes(newsHandler, { validateRequest: validateGeneratedRequest })
  .find(entry => entry.path.endsWith('/list-source-items'))!;
const envKeys = ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'VERCEL_ENV', 'LOCAL_API_MODE'] as const;
const oldEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
const originalFetch = globalThis.fetch;
let cache: Map<string, unknown>;
let reads: string[];
let revoked: string[];

// Two full/europe feeds, and a tech feed no full category places.
const [EUROPE_A, EUROPE_B] = VARIANT_FEEDS.full!.europe!;
const fullNames = new Set(Object.values(VARIANT_FEEDS.full!).flat().map(feed => feed.name));
const TECH_ONLY = Object.values(VARIANT_FEEDS.tech!).flat().find(feed => !fullNames.has(feed.name))!;
const techCategory = Object.entries(VARIANT_FEEDS.tech!).find(([, feeds]) => feeds.includes(TECH_ONLY))![0];

let serial = 0;
function feedRow(edition: string, feed: { name: string; url: string }, count: number, extra: Record<string, unknown> = {}) {
  cache.set(rssFeedCacheKey(edition, feed.url), {
    items: Array.from({ length: count }, (_, index) => ({
      source: feed.name, title: `${feed.name} ${index + 1}`, link: `https://news.example.org/${++serial}`,
      publishedAt: Date.now() - (index + 1) * 60_000,
      isAlert: false, level: 'low', category: 'general', confidence: 0.5, classSource: 'keyword',
      importanceScore: 0, credibilityScore: 0, corroborationCount: 1, entityCorroborationCount: 0,
    })),
    parsedTotal: count,
    droppedUndated: 0,
    ...extra,
  });
}

async function request(params: Record<string, string | string[]>) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    for (const item of Array.isArray(value) ? value : [value]) query.append(key, item);
  }
  const req = new Request(`https://example.test/api/news/v1/list-source-items?${query}`);
  const res = await route.handler(req);
  return { req, res, payload: await res.json() as ListSourceItemsResponse };
}

beforeEach(() => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fixture-token';
  process.env.VERCEL_ENV = 'production';
  delete process.env.LOCAL_API_MODE;
  __resetKeyPrefixCacheForTests();
  cache = new Map();
  reads = [];
  revoked = [];
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    assert.equal(target, 'https://redis.example.test/pipeline', 'never build a digest or fetch a publisher');
    const batch = JSON.parse(String(init?.body)) as string[][];
    return Response.json(batch.map(command => {
      if (command[0] === 'GET') {
        reads.push(command[1]!);
        return { result: cache.has(command[1]!) ? JSON.stringify(cache.get(command[1]!)) : null };
      }
      assert.deepEqual(command, ['SMEMBERS', REVOKED_URLS_KEY]);
      return { result: revoked };
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

describe('ListSourceItems', () => {
  it('returns the newest three cached items of each found source', async () => {
    feedRow('full', EUROPE_A!, 5);
    feedRow('full', EUROPE_B!, 1);

    const { res, payload } = await request({ category: 'europe', sources: [EUROPE_B!.name, EUROPE_A!.name] });

    assert.equal(res.status, 200);
    assert.deepEqual(payload.items.map(item => item.title).sort(),
      [`${EUROPE_A!.name} 1`, `${EUROPE_A!.name} 2`, `${EUROPE_A!.name} 3`, `${EUROPE_B!.name} 1`].sort());
    assert.ok(payload.items.every(item => item.importanceScore > 0), 'rows are scored as the digest scores them');
    assert.deepEqual(payload.sources.map(s => [s.source, s.state, s.edition, s.items]),
      [[EUROPE_A!.name, 'found', 'full', 3], [EUROPE_B!.name, 'found', 'full', 1]].sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
  });

  it('reports a failed or absent parse as missing and an unplaced name as unplaced', async () => {
    feedRow('full', EUROPE_A!, 2, { items: [], attempt: { source: 'direct', failure: 'timeout', negativeCache: true } });

    const { req, payload } = await request({ category: 'europe', sources: [EUROPE_A!.name, EUROPE_B!.name, 'No Such Source'] });

    assert.deepEqual(payload.items, []);
    assert.deepEqual(Object.fromEntries(payload.sources.map(s => [s.source, s.state])), {
      [EUROPE_A!.name]: 'missing',
      [EUROPE_B!.name]: 'missing',
      'No Such Source': 'unplaced',
    });
    assert.equal(drainResponseHeaders(req)?.['X-No-Cache'], '1', 'an incomplete read is not cached');
    feedRow('full', EUROPE_A!, 1);
    const complete = await request({ category: 'europe', sources: [EUROPE_A!.name] });
    assert.equal(drainResponseHeaders(complete.req)?.['X-No-Cache'], undefined, 'a read that found every source is cacheable');
  });

  it('reads each source from the first requested edition that places it in the category', async () => {
    feedRow('tech', TECH_ONLY, 2);

    const { payload } = await request({ editions: ['full', 'tech'], category: techCategory, sources: [TECH_ONLY.name] });

    assert.deepEqual(payload.sources.map(s => [s.state, s.edition]), [['found', 'tech']]);
    assert.deepEqual(reads.filter(key => key.includes('rss:feed:')), [rssFeedCacheKey('tech', TECH_ONLY.url)]);
  });

  it('reads only sources the requested language\'s digest fetches', async () => {
    // A feed the server fetches for one language only: its cached row exists,
    // but no other language's digest carries it.
    const [category, feed] = Object.entries(VARIANT_FEEDS.full!)
      .flatMap(([key, feeds]) => feeds.map(entry => [key, entry] as const))
      .find(([, entry]) => entry.lang && entry.lang !== 'en' && !entry.strategicDefault)!;
    feedRow('full', feed, 2);

    const english = await request({ category, sources: [feed.name] });
    assert.deepEqual(english.payload.sources.map(s => s.state), ['unplaced']);
    assert.deepEqual(english.payload.items, []);

    const own = await request({ category, sources: [feed.name], lang: feed.lang! });
    assert.deepEqual(own.payload.sources.map(s => s.state), ['found']);
    assert.equal((await request({ category, sources: [feed.name], lang: 'xx' })).res.status, 400);
  });

  it('reads intel sources from the full edition', async () => {
    const intel = INTEL_SOURCES[0]!;
    feedRow('full', intel, 1);
    const { payload } = await request({ category: 'intel', sources: [intel.name] });
    assert.deepEqual(payload.sources.map(s => s.state), ['found']);
  });

  it('drops items past the freshness floor and revoked links', async () => {
    feedRow('full', EUROPE_A!, 2);
    const row = cache.get(rssFeedCacheKey('full', EUROPE_A!.url)) as { items: Array<{ publishedAt: number; link: string }> };
    row.items[0]!.publishedAt = Date.now() - 30 * 24 * 3600_000;
    revoked = [row.items[1]!.link];

    const { payload } = await request({ category: 'europe', sources: [EUROPE_A!.name] });
    assert.deepEqual(payload.items, []);
  });

  it('answers the same for the same set in any order, with duplicates', async () => {
    feedRow('full', EUROPE_A!, 1);
    feedRow('full', EUROPE_B!, 1);
    const one = (await request({ category: 'europe', sources: [EUROPE_A!.name, EUROPE_B!.name] })).payload;
    const two = (await request({ category: 'europe', sources: [EUROPE_B!.name, EUROPE_A!.name, EUROPE_B!.name] })).payload;
    assert.deepEqual({ ...one, generatedAt: '' }, { ...two, generatedAt: '' });
  });

  it('rejects an unknown edition, a category no edition carries, too many sources, and an overlong name', async () => {
    assert.equal((await request({ editions: ['nope'], category: 'europe', sources: ['x'] })).res.status, 400);
    assert.equal((await request({ category: 'not-a-category', sources: ['x'] })).res.status, 400);
    assert.equal((await request({ category: 'europe', sources: Array.from({ length: 25 }, (_, i) => `s${i}`) })).res.status, 400);
    assert.equal((await request({ category: 'europe', sources: ['x'.repeat(121)] })).res.status, 400);
    assert.equal((await request({ category: 'europe' })).res.status, 400);
  });
});
