import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { newsHandler } from '../server/worldmonitor/news/v1/handler';
import { REVOKED_URLS_KEY } from '../server/_shared/digest-revocations';
import { __resetKeyPrefixCacheForTests } from '../server/_shared/redis';
import { lastGoodKey } from '../server/worldmonitor/news/v1/_lastgood';
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

async function request(params: Record<string, string | string[]> = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    for (const item of Array.isArray(value) ? value : [value]) query.append(key, item);
  }
  const res = await route.handler(new Request(`https://example.test/api/news/v1/list-news-pool?${query}`));
  return { res, payload: await res.json() as ListNewsPoolResponse };
}

const titles = (payload: ListNewsPoolResponse) => payload.items.map(entry => entry.item!.title).sort();

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

    const { res, payload } = await request();

    assert.equal(res.status, 200);
    assert.equal(payload.state, 'complete');
    assert.deepEqual(titles(payload), ['Baht steadies', 'Talks resume'], 'Norwegian NRK stays out of an English read; English Bangkok Post comes in');
    assert.deepEqual(payload.cells.map(cell => `${cell.edition}:${cell.language}:${cell.state}`), ['full:en:complete', 'full:th:complete']);
    for (const entry of payload.items) {
      assert.equal(entry.language, 'en');
      assert.deepEqual(entry.editions, ['full']);
    }
  });

  it('returns each requested language from the cells that carry it, untranslated', async () => {
    fresh('full', 'en', digest({ europe: [article('BBC World', 'Talks resume'), article('NRK', 'Stortinget stemmer')] }));
    fresh('full', 'de', digest({
      europe: [article('Tagesschau', 'Bundestag stimmt ab'), article('BBC World', 'Talks resume (German cell copy)')],
    }));

    const { payload } = await request({ languages: ['no', 'de'] });

    assert.equal(payload.state, 'complete');
    assert.deepEqual(titles(payload), ['Bundestag stimmt ab', 'Stortinget stemmer']);
    assert.deepEqual(Object.fromEntries(payload.items.map(entry => [entry.item!.source, entry.language])), { NRK: 'no', Tagesschau: 'de' });
    assert.ok(payload.items.every(entry => entry.item!.threat), 'threat classification carried through');
  });

  it('reads the same cells for reordered, repeated and mixed-case inputs', async () => {
    fresh('full', 'de', digest({ europe: [article('Tagesschau', 'Bundestag stimmt ab')] }));
    fresh('full', 'fr', digest({ europe: [article('France 24 FR', 'Le Parlement vote')] }));
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
    cache.set(lastGoodKey('full', 'de'), {
      acceptedAt, categoryCount: 1, itemCount: 1,
      data: digest({ europe: [article('Tagesschau', 'Bundestag stimmt ab')] }),
    });
    // German also comes from feeds with no lang, which live in the English cell.
    assert.deepEqual(
      NEWS_POOL_LAYOUT.cells.filter(cell => cell.contentLanguages.includes('de')).map(cell => cell.lang),
      ['en', 'de'],
      'fixture premise',
    );
    fresh('full', 'en', digest({ europe: [article('BBC World', 'Talks resume')] }));

    const { payload } = await request({ languages: ['de'] });

    assert.equal(payload.state, 'stale');
    const german = payload.cells.find(cell => cell.language === 'de')!;
    assert.equal(german.state, 'stale');
    assert.ok(german.staleAgeSeconds >= 7199);
    assert.deepEqual(titles(payload), ['Bundestag stimmt ab']);
  });

  it('reports an unwarmed cell as partial coverage, not a quiet result', async () => {
    fresh('full', 'en', digest({ europe: [article('BBC World', 'Talks resume')] }));
    const { payload } = await request({ languages: ['en', 'de'] });
    assert.equal(payload.state, 'partial');
    assert.equal(payload.cells.find(cell => cell.language === 'de')!.state, 'missing');
    assert.deepEqual(titles(payload), ['Talks resume']);
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
