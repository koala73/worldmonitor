// Cmd+K headline search: the digest build records every served headline, and
// two routes search that history over a 24-hour (free) or 7-day (Pro) window.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { newsHandler } from '../server/worldmonitor/news/v1/handler';
import { __testing__ as digest } from '../server/worldmonitor/news/v1/list-feed-digest';
import {
  __testing__ as history,
  buildHeadlineHistoryWrite,
  headlineHistoryBucketKey,
  writeHeadlineHistory,
} from '../server/worldmonitor/news/v1/_headline-history';
import { REVOKED_URLS_KEY } from '../server/_shared/digest-revocations';
import { drainResponseHeaders } from '../server/_shared/response-headers';
import { __resetKeyPrefixCacheForTests } from '../server/_shared/redis';
import { createNewsServiceRoutes, type SearchHeadlinesResponse } from '../src/generated/server/worldmonitor/news/v1/service_server';
import { validateGeneratedRequest } from '../server/request-validator';
import { PREMIUM_RPC_PATHS } from '../src/shared/premium-paths';
import { PUBLIC_NO_AUTH_RPC_PATHS } from '../server/gateway';
import { isPublicSharedRpcRequest } from '../src/shared/public-rpc-cache';

const routes = createNewsServiceRoutes(newsHandler, { validateRequest: validateGeneratedRequest });
const freeRoute = routes.find(entry => entry.path.endsWith('/search-headlines'))!;
const archiveRoute = routes.find(entry => entry.path.endsWith('/search-headline-archive'))!;

const envKeys = ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'VERCEL_ENV', 'VERCEL_GIT_COMMIT_SHA', 'LOCAL_API_MODE'] as const;
const oldEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
const originalFetch = globalThis.fetch;

const HOUR = 3600_000;
// Mid-afternoon UTC, so "hours ago" stays inside the day unless a test says otherwise.
const NOW = Date.UTC(2026, 10, 17, 15, 0, 0);

let hashes: Map<string, Map<string, string>>;
let expiries: Map<string, number>;
let commands: string[][];
let revoked: string[];
let failRevocations: boolean;
let failReads: boolean;

const item = (title: string, link: string, source = 'Reuters World', publishedAt = NOW - HOUR) =>
  ({ title, link, source, publishedAt });

/** What a digest build at `at` would have written for these served items. */
async function served(at: number, items: ReturnType<typeof item>[], variant = 'full', lang = 'en') {
  assert.equal(await writeHeadlineHistory(items, variant, lang, at), true);
}

async function search(route: typeof freeRoute, query: string, extra = '') {
  const path = route === freeRoute ? 'search-headlines' : 'search-headline-archive';
  const req = new Request(`https://example.test/api/news/v1/${path}?query=${encodeURIComponent(query)}${extra}`);
  const res = await route.handler(req);
  return { req, status: res.status, payload: await res.json() as SearchHeadlinesResponse };
}

const titles = (payload: SearchHeadlinesResponse) => payload.headlines.map(headline => headline.title);

beforeEach(() => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fixture-token';
  process.env.VERCEL_ENV = 'production';
  delete process.env.VERCEL_GIT_COMMIT_SHA;
  delete process.env.LOCAL_API_MODE;
  __resetKeyPrefixCacheForTests();
  history.resetPools();
  mock.timers.enable({ apis: ['Date'], now: NOW });
  hashes = new Map();
  expiries = new Map();
  commands = [];
  revoked = [];
  failRevocations = false;
  failReads = false;
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), 'https://redis.example.test/pipeline', 'never fetch a publisher');
    const batch = JSON.parse(String(init?.body)) as string[][];
    commands.push(...batch);
    return Response.json(batch.map(([verb, key, ...rest]) => {
      if (verb === 'SMEMBERS') {
        assert.ok(key!.endsWith(REVOKED_URLS_KEY));
        return failRevocations ? { error: 'fixture read failure' } : { result: revoked };
      }
      if (verb === 'HSET') {
        const hash = hashes.get(key!) ?? new Map<string, string>();
        for (let i = 0; i + 1 < rest.length; i += 2) hash.set(rest[i]!, rest[i + 1]!);
        hashes.set(key!, hash);
        return { result: rest.length / 2 };
      }
      if (verb === 'EXPIREAT') {
        expiries.set(key!, Number(rest[0]));
        return { result: 1 };
      }
      assert.equal(verb, 'HVALS', 'the search reads hashes only');
      return failReads ? { error: 'fixture read failure' } : { result: [...(hashes.get(key!)?.values() ?? [])] };
    }));
  };
});

afterEach(() => {
  mock.timers.reset();
  globalThis.fetch = originalFetch;
  for (const key of envKeys) {
    if (oldEnv[key] === undefined) delete process.env[key];
    else process.env[key] = oldEnv[key];
  }
  __resetKeyPrefixCacheForTests();
});

describe('headline history write', () => {
  it('records a build in one HSET on the served day and a fixed nine-day expiry', () => {
    const write = buildHeadlineHistoryWrite([
      item('Rates held at 4.5%', 'https://www.reuters.com/a'),
      item('Port strike ends', 'https://www.bbc.com/b', 'BBC World'),
    ], 'full', 'en', NOW);
    assert.equal(write.length, 2);
    const [hset, expire] = write;
    assert.deepEqual(hset!.slice(0, 2), ['HSET', 'news:headline-history:v1:full:en:2026-11-17']);
    assert.equal(hset!.length, 2 + 2 * 2, 'two fields, one command');
    assert.equal(hset![2], 'https://www.reuters.com/a', 'the field is the article URL');
    assert.deepEqual(JSON.parse(String(hset![3])), {
      t: 'Rates held at 4.5%', s: 'Reuters World', l: 'https://www.reuters.com/a', p: NOW - HOUR, a: NOW,
    });
    assert.deepEqual(expire, ['EXPIREAT', 'news:headline-history:v1:full:en:2026-11-17', Date.UTC(2026, 10, 26) / 1000]);
  });

  it('skips an item nobody could open or read', () => {
    const write = buildHeadlineHistoryWrite([
      item('Gate blanked this link', ''),
      item('Not a web link', 'javascript:alert(1)'),
      item('   ', 'https://www.reuters.com/blank-title'),
      item('No source', 'https://www.reuters.com/no-source', ''),
      item('Kept', 'https://www.reuters.com/kept'),
      item('Kept again under the same URL', 'https://www.reuters.com/kept'),
    ], 'full', 'en', NOW);
    assert.deepEqual(write[0]!.slice(2).filter((_, index) => index % 2 === 0), ['https://www.reuters.com/kept']);
    assert.deepEqual(buildHeadlineHistoryWrite([item('Gate blanked', '')], 'full', 'en', NOW), [], 'nothing to write');
  });

  it('the digest build records every served item with a publisher-gated link', async () => {
    const ok = await digest.recordServedHeadlines([
      { source: 'Reuters World', title: 'Rates held at 4.5%', link: 'https://www.reuters.com/world/rates', publishedAt: NOW - HOUR,
        originPublisher: '', originPublisherTrusted: false },
      { source: 'Reuters World', title: 'Hostile link', link: 'https://phish.example/login', publishedAt: NOW - HOUR,
        originPublisher: '', originPublisherTrusted: false },
    ] as never, 'full', 'en');
    assert.equal(ok, true);
    const bucket = hashes.get(headlineHistoryBucketKey('full', 'en', NOW))!;
    assert.deepEqual([...bucket.keys()], ['https://www.reuters.com/world/rates'], 'the off-publisher link is not indexed');
    const { payload } = await search(freeRoute, 'rates held');
    assert.deepEqual(titles(payload), ['Rates held at 4.5%']);
  });

  it('does not start a write the digest deadline has no room for', async () => {
    const ok = await digest.recordServedHeadlines([
      { source: 'Reuters World', title: 'Rates held', link: 'https://www.reuters.com/world/rates', publishedAt: NOW,
        originPublisher: '', originPublisherTrusted: false },
    ] as never, 'full', 'en', NOW - 1);
    assert.equal(ok, false);
    assert.equal(commands.length, 0);
  });

  it('keeps a preview deployment out of the production index, on write and on read', async () => {
    process.env.VERCEL_ENV = 'preview';
    process.env.VERCEL_GIT_COMMIT_SHA = 'deadbeefcafebabe';
    __resetKeyPrefixCacheForTests();
    await served(NOW, [item('Preview only', 'https://www.reuters.com/p')]);
    assert.deepEqual([...hashes.keys()], ['preview:deadbeef:news:headline-history:v1:full:en:2026-11-17']);
    const { payload } = await search(freeRoute, 'preview only');
    assert.deepEqual(titles(payload), ['Preview only']);
    assert.ok(commands.filter(command => command[0] === 'HVALS').every(command => command[1]!.startsWith('preview:deadbeef:')));
  });
});

describe('headline search', () => {
  it('finds a headline served earlier today that the dashboard no longer holds', async () => {
    await served(NOW - 5 * HOUR, [item('Strait of Hormuz tanker seized by patrol boats', 'https://www.reuters.com/hormuz', 'Reuters World', NOW - 6 * HOUR)]);
    await served(NOW, [item('Rates held at 4.5%', 'https://www.reuters.com/rates')]);
    const { payload } = await search(freeRoute, 'hormuz tanker');
    assert.deepEqual(payload.headlines, [{
      source: 'Reuters World',
      title: 'Strait of Hormuz tanker seized by patrol boats',
      link: 'https://www.reuters.com/hormuz',
      publishedAt: NOW - 6 * HOUR,
      lastServedAt: NOW - 5 * HOUR,
    }]);
    assert.equal(payload.searchedHeadlines, 2);
    assert.equal(payload.windowHours, 24);
    assert.equal(payload.state, 'complete');
    assert.equal(payload.newestServedAt, NOW);
  });

  it('gives the free route 24 hours and the Pro route 7 days', async () => {
    await served(NOW - 30 * HOUR, [item('Cabinet reshuffle announced', 'https://www.reuters.com/reshuffle')]);
    await served(NOW - 6 * 24 * HOUR, [item('Cabinet talks collapse', 'https://www.reuters.com/collapse')]);
    await served(NOW - 8 * 24 * HOUR, [item('Cabinet formed', 'https://www.reuters.com/formed')]);

    const free = await search(freeRoute, 'cabinet');
    assert.deepEqual(titles(free.payload), [], 'nothing older than 24 hours on the free route');
    assert.equal(free.payload.windowHours, 24);

    const pro = await search(archiveRoute, 'cabinet');
    assert.deepEqual(titles(pro.payload).sort(), ['Cabinet reshuffle announced', 'Cabinet talks collapse']);
    assert.equal(pro.payload.windowHours, 168);
  });

  it('measures the window from when a headline was last served, not when it was published', async () => {
    await served(NOW - 2 * HOUR, [item('Old article, alerted today', 'https://www.reuters.com/old', 'Reuters World', NOW - 30 * HOUR)]);
    const { payload } = await search(freeRoute, 'alerted today');
    assert.deepEqual(titles(payload), ['Old article, alerted today']);
  });

  it('reads across midnight UTC', async () => {
    const justAfterMidnight = Date.UTC(2026, 10, 18, 0, 30, 0);
    await served(Date.UTC(2026, 10, 17, 23, 50, 0), [item('Late evening strike', 'https://www.reuters.com/late')]);
    await served(Date.UTC(2026, 10, 17, 0, 10, 0), [item('Yesterday at dawn strike', 'https://www.reuters.com/dawn')]);
    mock.timers.setTime(justAfterMidnight);
    const { payload } = await search(freeRoute, 'strike');
    assert.deepEqual(titles(payload), ['Late evening strike'], 'yesterday 23:50 is inside 24 hours; 00:10 is not');
    assert.deepEqual(
      commands.filter(command => command[0] === 'HVALS').map(command => command[1]),
      ['news:headline-history:v1:full:en:2026-11-17', 'news:headline-history:v1:full:en:2026-11-18'],
    );
  });

  it('matches every word in any order, ignoring case and punctuation, and puts whole phrases first', async () => {
    await served(NOW, [
      item('Sanctions on Iran widen after talks', 'https://www.reuters.com/1', 'Reuters World', NOW - HOUR),
      item('Iran sanctions: EU ministers split', 'https://www.reuters.com/2', 'Reuters World', NOW - 3 * HOUR),
      item('Iran talks resume in Vienna', 'https://www.reuters.com/3'),
      item('Sanctions relief for Syria', 'https://www.reuters.com/4'),
    ]);
    const { payload } = await search(freeRoute, '  IRAN   sanctions ');
    assert.deepEqual(titles(payload), [
      'Iran sanctions: EU ministers split',
      'Sanctions on Iran widen after talks',
    ], 'the phrase match leads although it is older');
    const quoted = await search(freeRoute, 'iran sanctions eu');
    assert.deepEqual(titles(quoted.payload), ['Iran sanctions: EU ministers split'], 'punctuation in the title does not block a pasted title');
  });

  it('lists a headline once: newest copy across days, one row per title', async () => {
    await served(NOW - 20 * HOUR, [item('Port strike ends', 'https://www.reuters.com/port')]);
    await served(NOW - HOUR, [
      item('Port strike ends', 'https://www.reuters.com/port'),
      item('Port strike ends', 'https://news.google.com/rss/articles/port', 'AP News'),
    ]);
    const { payload } = await search(freeRoute, 'port strike');
    assert.equal(payload.headlines.length, 1);
    assert.equal(payload.headlines[0]!.lastServedAt, NOW - HOUR);
    assert.equal(payload.searchedHeadlines, 1);
  });

  it('returns at most 20 headlines, newest first', async () => {
    await served(NOW, Array.from({ length: 30 }, (_, index) =>
      item(`Quake update ${index}`, `https://www.reuters.com/q${index}`, 'Reuters World', NOW - index * 60_000)));
    const { payload } = await search(freeRoute, 'quake update');
    assert.equal(payload.headlines.length, 20);
    assert.equal(payload.headlines[0]!.title, 'Quake update 0');
    assert.equal(payload.searchedHeadlines, 30);
  });

  it('searches only the edition and language asked for', async () => {
    await served(NOW, [item('Chip export rules tighten', 'https://www.reuters.com/chips')], 'tech', 'en');
    await served(NOW, [item('Règles sur les puces renforcées', 'https://www.lemonde.fr/puces', 'Le Monde')], 'full', 'fr');
    assert.deepEqual(titles((await search(freeRoute, 'chip export')).payload), []);
    assert.deepEqual(titles((await search(freeRoute, 'chip export', '&variant=tech')).payload), ['Chip export rules tighten']);
    assert.deepEqual(titles((await search(freeRoute, 'puces', '&lang=fr')).payload), ['Règles sur les puces renforcées']);
  });

  it('reads the index once a minute per window, not once per keystroke', async () => {
    await served(NOW, [item('Rates held at 4.5%', 'https://www.reuters.com/rates')]);
    commands = [];
    await search(freeRoute, 'ra');
    await search(freeRoute, 'rat');
    await search(freeRoute, 'rates');
    assert.equal(commands.filter(command => command[0] === 'HVALS').length, 2, 'one read of two day buckets');
    mock.timers.setTime(NOW + 61_000);
    await search(freeRoute, 'rates');
    assert.equal(commands.filter(command => command[0] === 'HVALS').length, 4);
  });
});

describe('headline search failure and revocation', () => {
  it('drops a revoked article', async () => {
    await served(NOW, [
      item('Retracted claim about the minister', 'https://www.reuters.com/retracted'),
      item('Minister denies the claim', 'https://www.reuters.com/denial'),
    ]);
    revoked = ['https://www.reuters.com/retracted'];
    const { payload } = await search(freeRoute, 'minister');
    assert.deepEqual(titles(payload), ['Minister denies the claim']);
  });

  it('fails closed and uncached when revocations cannot be read', async () => {
    await served(NOW, [item('Rates held at 4.5%', 'https://www.reuters.com/rates')]);
    failRevocations = true;
    const { req, payload } = await search(freeRoute, 'rates');
    assert.equal(payload.state, 'unavailable');
    assert.deepEqual(payload.headlines, []);
    assert.equal(drainResponseHeaders(req)?.['X-No-Cache'], '1');
  });

  it('reports an unreadable index as unavailable, not as no matches, and retries on the next query', async () => {
    await served(NOW, [item('Rates held at 4.5%', 'https://www.reuters.com/rates')]);
    failReads = true;
    const failed = await search(freeRoute, 'rates');
    assert.equal(failed.payload.state, 'unavailable');
    assert.equal(drainResponseHeaders(failed.req)?.['X-No-Cache'], '1');
    failReads = false;
    const recovered = await search(freeRoute, 'rates');
    assert.equal(recovered.payload.state, 'complete');
    assert.deepEqual(titles(recovered.payload), ['Rates held at 4.5%']);
    assert.equal(drainResponseHeaders(recovered.req), undefined, 'a completed search may be cached');
  });

  it('reports unavailable when Redis is not configured', async () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    const { payload } = await search(freeRoute, 'rates');
    assert.equal(payload.state, 'unavailable');
  });

  it('rejects a query with nothing to search for, an unknown edition and an unknown language', async () => {
    for (const [query, extra] of [['a', ''], ['?!', ''], ['rates', '&variant=sports'], ['rates', '&lang=xx']] as const) {
      const { status } = await search(freeRoute, query, extra);
      assert.equal(status, 400, `${query}${extra}`);
    }
    assert.equal(commands.length, 0, 'a rejected request reads nothing');
  });
});

describe('headline search access', () => {
  it('gates the 7-day route as premium and leaves the 24-hour route to any dashboard session', () => {
    assert.ok(PREMIUM_RPC_PATHS.has('/api/news/v1/search-headline-archive'));
    assert.ok(!PREMIUM_RPC_PATHS.has('/api/news/v1/search-headlines'));
    for (const path of ['/api/news/v1/search-headlines', '/api/news/v1/search-headline-archive']) {
      assert.ok(!PUBLIC_NO_AUTH_RPC_PATHS.has(path), `${path} needs a session or key`);
      assert.ok(!isPublicSharedRpcRequest(`https://www.worldmonitor.app${path}?query=iran&public=1`), `${path} is not an anonymous shared-cache route`);
    }
  });
});
