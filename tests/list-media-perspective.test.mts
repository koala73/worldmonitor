import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { newsHandler } from '../server/worldmonitor/news/v1/handler';
import { INTEL_SOURCES, isServerFeedReachableForLanguage, VARIANT_FEEDS } from '../server/worldmonitor/news/v1/_feeds';
import { rssFeedCacheKey } from '../server/worldmonitor/news/v1/_rss-cache';
import { REVOKED_URLS_KEY } from '../server/_shared/digest-revocations';
import { drainResponseHeaders } from '../server/_shared/response-headers';
import { __resetKeyPrefixCacheForTests } from '../server/_shared/redis';
import { MEDIA_PERSPECTIVE_CACHE_PREFIX } from '../server/worldmonitor/news/v1/list-media-perspective';
import { createNewsServiceRoutes, type ListMediaPerspectiveResponse } from '../src/generated/server/worldmonitor/news/v1/service_server';
import { validateGeneratedRequest } from '../server/request-validator';

const route = createNewsServiceRoutes(newsHandler, { validateRequest: validateGeneratedRequest })
  .find(entry => entry.path.endsWith('/list-media-perspective'))!;
const envKeys = ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'VERCEL_ENV', 'LOCAL_API_MODE', 'NEWS_MAX_AGE_HOURS'] as const;
const oldEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
const originalFetch = globalThis.fetch;
const feeds = [...Object.values(VARIANT_FEEDS.full ?? {}).flat(), ...INTEL_SOURCES];
let cache: Map<string, unknown>;
let writes: Map<string, unknown>;
let revoked: string[];
let failRevocations: boolean;

function feed(name: string) {
  const found = feeds.find(entry => entry.name === name);
  assert.ok(found, `${name} is a catalog feed`);
  return found;
}

let serial = 0;
function article(source: string, title: string, overrides: Record<string, unknown> = {}) {
  serial++;
  return { source, title, link: `https://news.example.org/${serial}`, publishedAt: Date.now() - serial * 60_000, ...overrides };
}

function put(source: string, items: unknown[]) {
  cache.set(rssFeedCacheKey('full', feed(source).url), { items });
}

async function request(params: Record<string, string | string[]>) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    for (const item of Array.isArray(value) ? value : [value]) query.append(key, item);
  }
  const req = new Request(`https://example.test/api/news/v1/list-media-perspective?${query}`);
  const res = await route.handler(req);
  return { req, res, payload: await res.json() as ListMediaPerspectiveResponse };
}

function group(payload: ListMediaPerspectiveResponse, homeCountry: string, audience: string) {
  return payload.groups.find(entry => entry.homeCountry === homeCountry && entry.audience === audience);
}

beforeEach(() => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fixture-token';
  process.env.VERCEL_ENV = 'production';
  delete process.env.LOCAL_API_MODE;
  delete process.env.NEWS_MAX_AGE_HOURS;
  __resetKeyPrefixCacheForTests();
  cache = new Map(feeds.map(entry => [rssFeedCacheKey('full', entry.url), { items: [] }]));
  writes = new Map();
  revoked = [];
  failRevocations = false;
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    if (target.startsWith('https://redis.example.test/get/')) {
      const key = decodeURIComponent(target.slice('https://redis.example.test/get/'.length));
      return Response.json({ result: writes.has(key) ? JSON.stringify(writes.get(key)) : null });
    }
    if (target === 'https://redis.example.test/') {
      const [command, key, value] = JSON.parse(String(init?.body)) as string[];
      assert.equal(command, 'SET');
      writes.set(key, JSON.parse(value));
      return Response.json({ result: 'OK' });
    }
    assert.equal(target, 'https://redis.example.test/pipeline', 'never fetch a publisher or call a model');
    const batch = JSON.parse(String(init?.body)) as string[][];
    return Response.json(batch.map(command => {
      if (command[0] === 'SMEMBERS') {
        assert.equal(command[1], REVOKED_URLS_KEY);
        return failRevocations ? { error: 'fixture read failure' } : { result: revoked };
      }
      assert.equal(command[0], 'GET', 'RSS acquisition is read-only');
      return { result: cache.has(command[1]) ? JSON.stringify(cache.get(command[1])) : null };
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

describe('ListMediaPerspective', () => {
  it('groups headlines about the subject by outlet home country, then audience', async () => {
    put('Al Arabiya', [article('Al Arabiya', 'Saudi Arabia intercepts missiles over Riyadh')]);
    put('Egypt Independent', [article('Egypt Independent', 'Cairo welcomes Saudi investment pledge')]);
    put('New York Times World', [article('New York Times World', 'Riyadh airport reopens as Saudi Arabia weighs response')]);
    put('BBC Persian', [article('BBC Persian', 'Saudi Arabia and Iran resume talks', { lang: 'fa' })]);
    put('Mada Masr', [article('Mada Masr', 'Parliament debates the budget')]);

    const { payload, req } = await request({ subject_country: 'sa' });

    assert.equal(payload.state, 'complete');
    assert.equal(payload.subjectCountry, 'SA');
    assert.equal(payload.windowHours, 72);
    assert.deepEqual(payload.groups.map(entry => `${entry.homeCountry}/${entry.audience}`).sort(),
      ['EG/international', 'GB/diaspora', 'SA/international', 'US/domestic']);
    const saudi = group(payload, 'SA', 'international')!.headlines[0]!;
    assert.equal(saudi.outlet, 'Al Arabiya');
    assert.equal(saudi.ownershipClass, 'state');
    assert.equal(saudi.englishTitle, saudi.title);
    assert.equal(saudi.framing, undefined, 'no framing label before the background job computes one');
    assert.equal(group(payload, 'SA', 'international')!.framing!.unlabeled, 1);
    assert.equal(drainResponseHeaders(req)?.['X-No-Cache'], undefined, 'a complete response stays cacheable');
  });

  it('reads feeds the English digest cannot reach', async () => {
    assert.equal(isServerFeedReachableForLanguage(feed('BBC Persian'), 'en'), false, 'fixture premise');
    put('BBC Persian', [article('BBC Persian', 'Saudi Arabia and Iran resume talks', { lang: 'fa' })]);

    const { payload } = await request({ subject_country: 'SA' });
    const persian = group(payload, 'GB', 'diaspora')!.headlines[0]!;
    assert.equal(persian.titleLanguage, 'fa');
    assert.equal(persian.englishTitle, '', 'a non-English headline has no English title until it is translated');
  });

  it('counts sibling editions of one newsroom once, and keeps all their headlines', async () => {
    put('BBC World', [article('BBC World', 'Saudi Arabia hosts ceasefire talks')]);
    put('BBC Middle East', [article('BBC Middle East', 'What Saudi Arabia wants from Yemen talks')]);

    const { payload } = await request({ subject_country: 'SA' });
    const bbc = group(payload, 'GB', 'international')!;
    assert.equal(bbc.outletCount, 1);
    assert.equal(bbc.headlineCount, 2);
    assert.equal(bbc.headlines.length, 2);
  });

  it('lists requested countries with no coverage instead of returning an empty success', async () => {
    put('Al Arabiya', [article('Al Arabiya', 'Saudi Arabia intercepts missiles over Riyadh')]);

    const { payload } = await request({ subject_country: 'SA', outlet_countries: ['EG', 'SA'] });
    assert.deepEqual(payload.groups.map(entry => entry.homeCountry), ['SA']);
    assert.deepEqual(payload.noCoverageCountries, ['EG']);
  });

  it('filters by audience', async () => {
    put('BBC UK', [article('BBC UK', 'UK minister visits Saudi Arabia')]);
    put('BBC World', [article('BBC World', 'Saudi Arabia hosts ceasefire talks')]);

    const { payload } = await request({ subject_country: 'SA', audience: 'domestic' });
    assert.deepEqual(payload.groups.map(entry => `${entry.homeCountry}/${entry.audience}`), ['GB/domestic']);
  });

  it('leaves multi-publisher searches and unprofiled publishers ungrouped, and counts them', async () => {
    put('Oil & Gas', [article('Oil & Gas', 'Saudi Arabia raises crude output')]);
    put('Al Arabiya', [article('Al Arabiya', 'Saudi Arabia intercepts missiles', {
      originPublisher: 'Unlisted Gulf Daily', originPublisherTrusted: true,
    })]);

    const { payload } = await request({ subject_country: 'SA' });
    assert.deepEqual(payload.groups, []);
    assert.equal(payload.unattributedCount, 2);
  });

  it('drops revoked links and headlines outside the window', async () => {
    put('Al Arabiya', [
      article('Al Arabiya', 'Saudi Arabia intercepts missiles', { link: 'https://news.example.org/revoked' }),
      article('Al Arabiya', 'Saudi Arabia signs accord', { publishedAt: Date.now() - 30 * 3600_000 }),
      article('Al Arabiya', 'Saudi Arabia opens airport'),
    ]);
    revoked = ['https://news.example.org/revoked'];

    const { payload } = await request({ subject_country: 'SA', window_hours: '24' });
    assert.deepEqual(group(payload, 'SA', 'international')!.headlines.map(item => item.title), ['Saudi Arabia opens airport']);
  });

  it('builds one cache key for reordered or duplicated outlet countries, and serves it', async () => {
    put('Al Arabiya', [article('Al Arabiya', 'Saudi Arabia intercepts missiles')]);

    await request({ subject_country: 'SA', outlet_countries: ['US', 'SA', 'sa'] });
    assert.deepEqual([...writes.keys()].map(key => key.slice(key.indexOf(MEDIA_PERSPECTIVE_CACHE_PREFIX))),
      [`${MEDIA_PERSPECTIVE_CACHE_PREFIX}:SA:SA,US:*:72`]);

    cache.clear();
    const { payload } = await request({ subject_country: 'SA', outlet_countries: ['SA', 'US'] });
    assert.equal(payload.groups[0]!.headlines[0]!.title, 'Saudi Arabia intercepts missiles', 'served from the response cache');
  });

  it('rejects invalid parameters', async () => {
    for (const params of [
      { subject_country: 'SAU' },
      { subject_country: 'SA', window_hours: '50' },
      { subject_country: 'SA', audience: 'elite' },
      { subject_country: 'SA', outlet_countries: ['Saudi'] },
    ]) {
      const { res } = await request(params);
      assert.equal(res.status, 400, JSON.stringify(params));
    }
  });

  it('never caches a partial or revocation-blind response', async () => {
    put('Al Arabiya', [article('Al Arabiya', 'Saudi Arabia intercepts missiles')]);
    cache.delete(rssFeedCacheKey('full', feed('BBC World').url));

    const partial = await request({ subject_country: 'SA' });
    assert.equal(partial.payload.state, 'partial');
    assert.equal(drainResponseHeaders(partial.req)?.['X-No-Cache'], '1');

    failRevocations = true;
    const blind = await request({ subject_country: 'SA', window_hours: '48' });
    assert.equal(blind.payload.state, 'unavailable');
    assert.deepEqual(blind.payload.groups, []);
    assert.equal(drainResponseHeaders(blind.req)?.['X-No-Cache'], '1');
    assert.equal(writes.size, 0);
  });
});
