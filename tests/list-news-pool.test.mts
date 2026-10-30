import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { newsHandler } from '../server/worldmonitor/news/v1/handler';
import { REVOKED_URLS_KEY } from '../server/_shared/digest-revocations';
import { __resetKeyPrefixCacheForTests } from '../server/_shared/redis';
import { drainResponseHeaders } from '../server/_shared/response-headers';
import { lastGoodKey } from '../server/worldmonitor/news/v1/_lastgood';
import { rssFeedCacheKey } from '../server/worldmonitor/news/v1/_rss-cache';
import { VARIANT_FEEDS } from '../server/worldmonitor/news/v1/_feeds';
import { NEWS_POOL_MAX_LANGUAGES, sourceLanguage } from '../server/worldmonitor/news/v1/list-news-pool';
import { NEWS_POOL_LAYOUT } from '../shared/news-pool-layout.generated';
import { buildNewsPoolLayout } from '../shared/news-catalog';
import { getOutletProfile } from '../server/_shared/outlet-profile';
import { createNewsServiceRoutes, type ListNewsPoolResponse } from '../src/generated/server/worldmonitor/news/v1/service_server';
import { validateGeneratedRequest } from '../server/request-validator';

const route = createNewsServiceRoutes(newsHandler, { validateRequest: validateGeneratedRequest })
  .find(entry => entry.path.endsWith('/list-news-pool'))!;
const envKeys = ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'VERCEL_ENV', 'LOCAL_API_MODE'] as const;
const oldEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
const originalFetch = globalThis.fetch;
let cache: Map<string, unknown>;
let reads: string[];
let revoked: string[];
let failRevocations: boolean;

let serial = 0;
function article(source: string, title: string, link = `https://news.example.org/${++serial}`) {
  serial++;
  return { source, title, link, publishedAt: Date.now() - serial * 60_000, threat: { level: 'THREAT_LEVEL_LOW' } };
}

function digest(categories: Record<string, unknown[]>, state = 'complete') {
  return {
    categories: Object.fromEntries(Object.entries(categories).map(([key, items]) => [key, { items }])),
    feedStatuses: {},
    generatedAt: new Date().toISOString(),
    coverage: { state },
  };
}

function fresh(edition: string, lang: string, body: unknown) {
  cache.set(`news:digest:v1:${edition}:${lang}`, body);
}

/** One feed's cached parse, as a digest build writes it. */
function feedRow(edition: string, source: string, titles: string[], extra: Record<string, unknown> = {}) {
  const feed = Object.values(VARIANT_FEEDS[edition]!).flat().find(entry => entry.name === source)!;
  assert.ok(feed, `fixture feed ${source} is placed in ${edition}`);
  cache.set(rssFeedCacheKey(edition, feed.url), {
    items: titles.map(title => ({
      source, title, link: `https://news.example.org/${++serial}`, publishedAt: Date.now() - ++serial * 60_000,
      isAlert: false, level: 'low', category: 'general', confidence: 0.5, classSource: 'keyword',
      importanceScore: 0, credibilityScore: 0, corroborationCount: 1, entityCorroborationCount: 0,
    })),
    parsedTotal: titles.length,
    droppedUndated: 0,
    ...extra,
  });
}

async function request(params: Record<string, string | string[]> = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    for (const item of Array.isArray(value) ? value : [value]) query.append(key, item);
  }
  const req = new Request(`https://example.test/api/news/v1/list-news-pool?${query}`);
  const res = await route.handler(req);
  return { req, res, payload: await res.json() as ListNewsPoolResponse };
}

const titles = (payload: ListNewsPoolResponse) => payload.items.map(entry => entry.item!.title).sort();

// Every other full cell an English read covers (feeds tagged for another
// language that publish in English, like Tuoi Tre News). Derived from the
// layout so a catalog migration adding one does not break the fixtures.
const OTHER_ENGLISH_CELLS = NEWS_POOL_LAYOUT.cells
  .filter(cell => cell.edition === 'full' && cell.contentLanguages.includes('en') && !['en', 'th'].includes(cell.lang))
  .map(cell => cell.lang);

function freshOtherEnglishCells() {
  // One Norwegian item keeps each digest acceptable; an English read filters it out.
  for (const lang of OTHER_ENGLISH_CELLS) fresh('full', lang, digest({ asia: [article('NRK', `Filler (${lang})`)] }));
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
  failRevocations = false;
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    if (target.startsWith('https://redis.example.test/get/')) {
      const key = decodeURIComponent(target.slice('https://redis.example.test/get/'.length));
      reads.push(key);
      return Response.json({ result: cache.has(key) ? JSON.stringify(cache.get(key)) : null });
    }
    assert.equal(target, 'https://redis.example.test/pipeline', 'never build a digest or fetch a publisher');
    const batch = JSON.parse(String(init?.body)) as string[][];
    return Response.json(batch.map(command => {
      if (command[0] === 'GET') {
        reads.push(command[1]!);
        return { result: cache.has(command[1]!) ? JSON.stringify(cache.get(command[1]!)) : null };
      }
      assert.deepEqual(command, ['SMEMBERS', REVOKED_URLS_KEY]);
      return failRevocations ? { error: 'fixture read failure' } : { result: revoked };
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

describe('news pool layout', () => {
  it('is the committed generation of the catalog', () => {
    assert.deepEqual(NEWS_POOL_LAYOUT, buildNewsPoolLayout(name => getOutletProfile(name)?.language ?? 'en'));
  });

  it('files a feed with no lang under its own cell by content language', () => {
    // NRK publishes in Norwegian with no feed lang, so only the English cell is its own.
    assert.equal(sourceLanguage('NRK'), 'no');
    const owners = NEWS_POOL_LAYOUT.cells.filter(cell => cell.contentLanguages.includes('no'));
    assert.deepEqual(owners.map(cell => `${cell.edition}:${cell.lang}`), ['full:en']);
    // Bangkok Post is fetched for Thai readers but publishes in English.
    assert.ok(NEWS_POOL_LAYOUT.cells.find(cell => cell.edition === 'full' && cell.lang === 'th')!.contentLanguages.includes('en'));
  });
});

describe('ListNewsPool', () => {
  it('defaults to English items from the full digest', async () => {
    fresh('full', 'en', digest({ europe: [article('BBC World', 'Talks resume'), article('NRK', 'Stortinget stemmer')] }));
    fresh('full', 'th', digest({ asia: [article('Bangkok Post', 'Baht steadies')] }));
    freshOtherEnglishCells();

    const { res, payload } = await request();

    assert.equal(res.status, 200);
    assert.equal(payload.state, 'complete');
    assert.deepEqual(titles(payload), ['Baht steadies', 'Talks resume'], 'Norwegian NRK stays out of an English read; English Bangkok Post comes in');
    assert.deepEqual(
      payload.cells.map(cell => `${cell.edition}:${cell.language}:${cell.state}`).sort(),
      ['en', 'th', ...OTHER_ENGLISH_CELLS].map(lang => `full:${lang}:complete`).sort(),
    );
    for (const entry of payload.items) {
      assert.equal(entry.language, 'en');
      assert.deepEqual(entry.editions, ['full']);
    }
  });

  it('returns other languages from their feeds, untranslated', async () => {
    fresh('full', 'en', digest({ europe: [article('BBC World', 'Talks resume'), article('NRK', 'Stortinget stemmer (cell copy)')] }));
    feedRow('full', 'NRK', ['Stortinget stemmer']);
    feedRow('full', 'Tagesschau', ['Bundestag stimmt ab']);

    const { payload } = await request({ languages: ['no', 'de'] });

    assert.equal(payload.state, 'partial', 'full places other German and Norwegian feeds this fixture leaves uncached');
    assert.deepEqual(titles(payload), ['Bundestag stimmt ab', 'Stortinget stemmer']);
    assert.deepEqual(Object.fromEntries(payload.items.map(entry => [entry.item!.source, entry.language])), { NRK: 'no', Tagesschau: 'de' });
    assert.ok(payload.items.every(entry => entry.item!.threat?.level), 'threat classification carried through');
    assert.ok(!reads.some(key => key.startsWith('news:digest:')), 'no digest cell is read for languages other than English');
  });

  it('returns a language its digest cell crowded out', async () => {
    // A category keeps its newest items, and English feeds with no lang ride
    // along in the French cell, so the cell can hold no French item at all.
    fresh('full', 'fr', digest({ us: [article('Reuters World', 'Senate votes'), article('AP News', 'Markets open')] }));
    feedRow('full', 'Radio-Canada', ['Le Sénat vote', 'Les marchés ouvrent', 'Tempête au Québec']);

    const { payload } = await request({ languages: ['fr'] });

    assert.deepEqual(titles(payload), ['Le Sénat vote', 'Les marchés ouvrent', 'Tempête au Québec']);
    assert.ok(payload.items.every(entry => entry.language === 'fr' && entry.category === 'us'));
  });

  it('scores feed-row items the way the digest does, not with the row placeholders', async () => {
    feedRow('full', 'Tagesschau', ['Bundestag stimmt ab']);
    const { payload } = await request({ languages: ['de'] });
    const item = payload.items[0]!.item!;
    assert.ok(item.credibilityScore > 0, `credibilityScore ${item.credibilityScore}`);
    assert.ok(item.importanceScore > 0, `importanceScore ${item.importanceScore}`);
  });

  it('marks every response except a complete one uncacheable', async () => {
    fresh('full', 'en', digest({ europe: [article('BBC World', 'Talks resume')] }));
    fresh('full', 'th', digest({ asia: [article('Bangkok Post', 'Baht steadies')] }));
    freshOtherEnglishCells();
    const complete = await request();
    assert.equal(complete.payload.state, 'complete');
    assert.equal(drainResponseHeaders(complete.req)?.['X-No-Cache'], undefined);

    const partial = await request({ languages: ['en', 'de'] });
    assert.equal(partial.payload.state, 'partial');
    assert.equal(drainResponseHeaders(partial.req)?.['X-No-Cache'], '1');

    cache.clear();
    const down = await request();
    assert.equal(down.payload.state, 'unavailable');
    assert.equal(drainResponseHeaders(down.req)?.['X-No-Cache'], '1');
  });

  it('counts a feed whose last fetch failed as uncached', async () => {
    feedRow('full', 'Tagesschau', [], { attempt: { failure: 'timeout' } });
    const { payload } = await request({ languages: ['de'] });
    assert.equal(payload.state, 'unavailable');
  });

  it('drops feed items older than the digest window', async () => {
    feedRow('full', 'Tagesschau', ['Bundestag stimmt ab']);
    const row = [...cache.values()].at(-1) as { items: Array<{ publishedAt: number }> };
    row.items[0]!.publishedAt = Date.now() - 30 * 24 * 3600_000;
    const { payload } = await request({ languages: ['de'] });
    assert.deepEqual(payload.items, []);
  });

  it('reads the same keys for reordered, repeated and mixed-case inputs', async () => {
    feedRow('full', 'Tagesschau', ['Bundestag stimmt ab']);
    feedRow('full', 'Radio-Canada', ['Le Sénat vote']);
    await request({ languages: ['fr', 'de'] });
    const first = [...reads];
    reads = [];
    await request({ languages: ['DE', 'fr', 'de'], editions: ['full', 'FULL'] });
    assert.deepEqual(reads, first);
  });

  it('rejects unknown or oversized filters', async () => {
    const tooMany = NEWS_POOL_LAYOUT.languages.slice(0, NEWS_POOL_MAX_LANGUAGES + 1);
    for (const params of [
      { languages: ['xx'] },
      { languages: tooMany },
      { editions: ['sports'] },
      { editions: ['tech'], category: 'europe' },
    ]) {
      const { res } = await request(params);
      assert.equal(res.status, 400, JSON.stringify(params));
    }
    assert.deepEqual(reads, [], 'nothing is read for an invalid request');
  });

  it('merges one article carried by two editions', async () => {
    const link = 'https://news.example.org/shared';
    fresh('full', 'en', digest({ finance: [article('Reuters Business', 'Rates hold', link)] }));
    fresh('finance', 'en', digest({ markets: [article('Reuters Business', 'Rates hold', link)] }));

    const { payload } = await request({ editions: ['finance', 'full'] });

    assert.equal(payload.items.length, 1);
    assert.deepEqual(payload.items[0]!.editions, ['full', 'finance']);
  });

  it('applies the category within the selected editions', async () => {
    fresh('full', 'en', digest({ europe: [article('BBC World', 'Talks resume')], asia: [article('BBC World', 'Monsoon arrives')] }));
    const { payload } = await request({ category: 'asia' });
    assert.deepEqual(titles(payload), ['Monsoon arrives']);
    assert.equal(payload.items[0]!.category, 'asia');
  });

  it('serves a last-good snapshot for a cell with no fresh body, marked stale', async () => {
    const acceptedAt = Date.now() - 2 * 3600_000;
    cache.set(lastGoodKey('full', 'en'), {
      acceptedAt, categoryCount: 1, itemCount: 1,
      data: digest({ europe: [article('BBC World', 'Talks resume')] }),
    });
    fresh('full', 'th', digest({ asia: [article('Bangkok Post', 'Baht steadies')] }));
    freshOtherEnglishCells();

    const { payload } = await request();

    assert.equal(payload.state, 'stale');
    const english = payload.cells.find(cell => cell.language === 'en')!;
    assert.equal(english.state, 'stale');
    assert.ok(english.staleAgeSeconds >= 7199);
    assert.deepEqual(titles(payload), ['Baht steadies', 'Talks resume']);
  });

  it('reports unfetched feeds as partial coverage, not a quiet result', async () => {
    fresh('full', 'en', digest({ europe: [article('BBC World', 'Talks resume')] }));
    fresh('full', 'th', digest({ asia: [] }));
    const { payload } = await request({ languages: ['en', 'de'] });
    assert.equal(payload.state, 'partial');
    assert.equal(payload.cells.find(cell => cell.language === 'de')!.state, 'missing');
    assert.deepEqual(titles(payload), ['Talks resume']);

    feedRow('full', 'Tagesschau', ['Bundestag stimmt ab']);
    const some = await request({ languages: ['de'] });
    const german = some.payload.cells.find(cell => cell.language === 'de')!;
    assert.equal(german.state, 'partial', 'one of several German feeds cached');
    assert.equal(some.payload.state, 'partial');
  });

  it('is unavailable when no requested cell has a body', async () => {
    const { payload } = await request({ languages: ['de'] });
    assert.equal(payload.state, 'unavailable');
    assert.deepEqual(payload.items, []);
  });

  it('drops a URL revoked after the cell was cached', async () => {
    fresh('full', 'en', digest({ europe: [article('BBC World', 'Talks resume', 'https://news.example.org/revoked'), article('BBC World', 'Monsoon arrives')] }));
    revoked = ['https://news.example.org/revoked'];
    const { payload } = await request();
    assert.deepEqual(titles(payload), ['Monsoon arrives']);
  });

  it('serves nothing when the revocation set cannot be read', async () => {
    fresh('full', 'en', digest({ europe: [article('BBC World', 'Talks resume')] }));
    failRevocations = true;
    const { payload } = await request();
    assert.equal(payload.state, 'unavailable');
    assert.deepEqual(payload.items, []);
  });
});
