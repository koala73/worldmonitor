import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { newsHandler } from '../server/worldmonitor/news/v1/handler';
import { INTEL_SOURCES, isServerFeedReachableForLanguage, VARIANT_FEEDS } from '../server/worldmonitor/news/v1/_feeds';
import { rssFeedCacheKey } from '../server/worldmonitor/news/v1/_rss-cache';
import { REVOKED_URLS_KEY } from '../server/_shared/digest-revocations';
import { drainResponseHeaders } from '../server/_shared/response-headers';
import { __resetKeyPrefixCacheForTests } from '../server/_shared/redis';
import { MEDIA_PERSPECTIVE_CACHE_PREFIX } from '../server/worldmonitor/news/v1/list-media-perspective';
import { unM49RegionCountries } from '../server/_shared/un-m49-regions';
import { createNewsServiceRoutes, type ListMediaPerspectiveResponse } from '../src/generated/server/worldmonitor/news/v1/service_server';
import { validateGeneratedRequest } from '../server/request-validator';

const route = createNewsServiceRoutes(newsHandler, { validateRequest: validateGeneratedRequest })
  .find(entry => entry.path.endsWith('/list-media-perspective'))!;
const envKeys = ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'VERCEL_ENV', 'LOCAL_API_MODE', 'NEWS_MAX_AGE_HOURS'] as const;
const oldEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
const originalFetch = globalThis.fetch;
// Every catalog feed under the cache key of the first variant that lists it (full first), as the handler reads them.
const variantOrder = ['full', ...Object.keys(VARIANT_FEEDS).filter(variant => variant !== 'full')];
const feedVariants = new Map<string, string>();
const feeds = [
  ...variantOrder.flatMap(variant => Object.values(VARIANT_FEEDS[variant] ?? {}).flat().map(entry => ({ entry, variant }))),
  ...INTEL_SOURCES.map(entry => ({ entry, variant: 'full' })),
].filter(({ entry, variant }) => {
  if (feedVariants.has(entry.url)) return false;
  feedVariants.set(entry.url, variant);
  return true;
}).map(({ entry }) => entry);
const feedKey = (entry: { url: string }) => rssFeedCacheKey(feedVariants.get(entry.url)!, entry.url);
let ttls: Map<string, number>;
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
  cache.set(feedKey(feed(source)), { items });
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
  cache = new Map(feeds.map(entry => [feedKey(entry), { items: [] }]));
  writes = new Map();
  ttls = new Map();
  revoked = [];
  failRevocations = false;
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    if (target.startsWith('https://redis.example.test/get/')) {
      const key = decodeURIComponent(target.slice('https://redis.example.test/get/'.length));
      return Response.json({ result: writes.has(key) ? JSON.stringify(writes.get(key)) : null });
    }
    if (target === 'https://redis.example.test/') {
      const [command, key, value, , ttl] = JSON.parse(String(init?.body)) as string[];
      assert.equal(command, 'SET');
      writes.set(key, JSON.parse(value));
      ttls.set(key, Number(ttl));
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
    assert.equal(saudi.framing, '', 'no framing label before the background job computes one');
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

  it('expands an outlet region, so one call covers a whole region', async () => {
    put('Clarín', [article('Clarín', 'Finland tops the world happiness ranking again')]);
    put('Mexico News Daily', [article('Mexico News Daily', 'Finland opens its schools to Mexican teachers')]);
    put('BBC World', [article('BBC World', 'Finland reinforces its eastern border')]);

    const { payload } = await request({ subject_country: 'FI', outlet_regions: 'latin-america-and-the-caribbean' });
    const latam = unM49RegionCountries('latin-america-and-the-caribbean')!;
    assert.deepEqual(payload.groups.map(entry => `${entry.homeCountry}/${entry.audience}`).sort(), ['AR/domestic', 'MX/international']);
    assert.ok(latam.length > 30, 'a whole region exceeds the outlet_countries cap');
    assert.deepEqual(payload.noCoverageCountries, latam.filter(code => code !== 'AR' && code !== 'MX').sort());
  });

  it('caches one unfiltered entry per subject and window, and filters on serve', async () => {
    put('Clarín', [article('Clarín', 'Finland tops the world happiness ranking again')]);
    put('BBC World', [article('BBC World', 'Finland reinforces its eastern border')]);

    await request({ subject_country: 'FI', outlet_regions: 'Latin-America-and-the-Caribbean' });
    assert.deepEqual([...writes.keys()].map(key => key.slice(key.indexOf(MEDIA_PERSPECTIVE_CACHE_PREFIX))),
      [`${MEDIA_PERSPECTIVE_CACHE_PREFIX}:FI:72`], 'filters never mint cache keys');

    cache.clear();
    const { payload } = await request({ subject_country: 'FI', outlet_regions: 'latin-america-and-the-caribbean', outlet_countries: ['GB'] });
    assert.equal(writes.size, 1, 'served from the shared entry');
    assert.deepEqual(payload.groups.map(entry => `${entry.homeCountry}/${entry.audience}`).sort(), ['AR/domestic', 'GB/international']);
    assert.ok(!payload.noCoverageCountries.includes('GB'), 'listed countries join the region');
    assert.ok(payload.noCoverageCountries.includes('MX'));
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

  it('serves a cached entry while none of its links is revoked, and rebuilds once one is', async () => {
    put('Al Arabiya', [
      article('Al Arabiya', 'Saudi Arabia intercepts missiles', { link: 'https://news.example.org/withdrawn' }),
      article('Al Arabiya', 'Saudi Arabia opens airport'),
    ]);

    await request({ subject_country: 'SA', outlet_countries: ['US', 'SA', 'sa'] });
    put('Al Arabiya', [article('Al Arabiya', 'Saudi Arabia signs accord')]);
    const cached = await request({ subject_country: 'SA' });
    assert.deepEqual(group(cached.payload, 'SA', 'international')!.headlines.map(item => item.title).sort(),
      ['Saudi Arabia intercepts missiles', 'Saudi Arabia opens airport'], 'served from the response cache');

    revoked = ['https://news.example.org/withdrawn'];
    const rebuilt = await request({ subject_country: 'SA' });
    assert.deepEqual(group(rebuilt.payload, 'SA', 'international')!.headlines.map(item => item.title), ['Saudi Arabia signs accord']);

    failRevocations = true;
    const blind = await request({ subject_country: 'SA' });
    assert.equal(blind.payload.state, 'unavailable', 'a hit is not served while revocations are unreadable');
    assert.deepEqual(blind.payload.groups, []);
  });

  it('treats a cached fetch failure as a missing feed, not coverage', async () => {
    put('Al Arabiya', [article('Al Arabiya', 'Saudi Arabia intercepts missiles')]);
    const healthy = await request({ subject_country: 'SA', window_hours: '24' });
    assert.equal(healthy.payload.state, 'complete', 'fixture premise: every feed is cached');

    cache.set(feedKey(feed('BBC World')), { items: [], parsedTotal: 0, attempt: { source: 'direct', failure: 'direct-error', negativeCache: false } });
    const { payload } = await request({ subject_country: 'SA' });
    assert.equal(payload.state, 'partial');
    assert.equal(payload.feedCached, payload.feedTotal - 1);
  });

  it('keeps an article syndicated to two audiences in both groups', async () => {
    const link = 'https://www.bbc.co.uk/news/articles/shared';
    put('BBC World', [article('BBC World', 'Saudi Arabia hosts ceasefire talks', { link })]);
    put('BBC UK', [article('BBC UK', 'Saudi Arabia hosts ceasefire talks', { link })]);

    const domestic = await request({ subject_country: 'SA', audience: 'domestic' });
    assert.deepEqual(domestic.payload.groups.map(entry => `${entry.homeCountry}/${entry.audience}`), ['GB/domestic']);
    const all = await request({ subject_country: 'SA' });
    assert.deepEqual(all.payload.groups.map(entry => `${entry.audience}:${entry.headlineCount}`).sort(), ['domestic:1', 'international:1']);
  });

  it('matches the subject named in the headline language', async () => {
    put('BBC Persian', [article('BBC Persian', 'حمله موشکی به عربستان سعودی', { lang: 'fa' })]);

    const { payload } = await request({ subject_country: 'SA' });
    assert.equal(group(payload, 'GB', 'diaspora')!.headlines[0]!.title, 'حمله موشکی به عربستان سعودی');
  });

  it('reads feeds that only a non-full variant lists', async () => {
    assert.equal(feedVariants.get(feed('Tech in Asia').url), 'tech', 'fixture premise');
    put('Tech in Asia', [article('Tech in Asia', 'Saudi Arabia funds a Singapore AI lab')]);

    const { payload } = await request({ subject_country: 'SA' });
    assert.equal(group(payload, 'SG', 'international')!.headlines[0]!.outlet, 'Tech in Asia');
  });

  it('rejects invalid parameters', async () => {
    for (const params of [
      { subject_country: 'SAU' },
      { subject_country: 'SA', window_hours: '50' },
      { subject_country: 'SA', audience: 'elite' },
      { subject_country: 'SA', outlet_countries: ['Saudi'] },
      { subject_country: 'SA', outlet_regions: 'atlantis' },
      { subject_country: 'SA', outlet_regions: 'latam' },
    ]) {
      const { res } = await request(params);
      assert.equal(res.status, 400, JSON.stringify(params));
    }
  });

  it('caches a partial response briefly and a revocation-blind one never', async () => {
    put('Al Arabiya', [article('Al Arabiya', 'Saudi Arabia intercepts missiles')]);
    cache.delete(feedKey(feed('BBC World')));

    const partial = await request({ subject_country: 'SA' });
    assert.equal(partial.payload.state, 'partial');
    assert.equal(drainResponseHeaders(partial.req)?.['X-No-Cache'], '1');
    assert.deepEqual([...ttls.values()], [60], 'a partial build is cached for one minute');

    failRevocations = true;
    const blind = await request({ subject_country: 'SA', window_hours: '48' });
    assert.equal(blind.payload.state, 'unavailable');
    assert.deepEqual(blind.payload.groups, []);
    assert.equal(drainResponseHeaders(blind.req)?.['X-No-Cache'], '1');
    assert.equal(writes.size, 1);
  });
});
