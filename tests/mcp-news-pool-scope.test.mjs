// languages and editions on get_news_clusters and extract_entities: one
// English edition keeps reading the public digest; anything wider reads the
// premium ListNewsPool. Real edge handler, network edges mocked.
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { HMAC_SECRET, callBody, makeProDeps, proReq } from './helpers/mcp-pro-deps.mjs';
import { NEWS_POOL_LAYOUT } from '../shared/news-pool-layout.generated.ts';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

const digestResponse = {
  generatedAt: '2026-07-28T12:00:00.000Z',
  feedStatuses: { Reuters: 'ok' },
  categories: {
    politics: { items: [{ source: 'Reuters', title: 'Summit talks resume in Geneva', link: 'https://n/en1', publishedAt: 1785405600000 }] },
  },
};

const threat = { level: 'THREAT_LEVEL_HIGH', category: 'conflict', confidence: 0.8, source: 'keyword' };
const poolItem = (source, title, link, language, publishedAt, editions = ['full']) => ({
  item: { source, title, link, publishedAt, threat, corroborationCount: 2 },
  language,
  editions,
  category: 'europe',
});

const poolResponse = {
  generatedAt: '2026-07-28T12:00:00.000Z',
  state: 'partial',
  cells: [
    { edition: 'full', language: 'en', state: 'complete', items: 2, staleAgeSeconds: 0, generatedAt: '' },
    { edition: 'full', language: 'de', state: 'missing', items: 0, staleAgeSeconds: 0, generatedAt: '' },
  ],
  items: [
    poolItem('Tagesschau', 'Bundestag stimmt über Haushalt ab', 'https://n/de1', 'de', 1785405900000),
    poolItem('Welt', 'Bundestag stimmt über den Haushalt ab', 'https://n/de2', 'de', 1785405800000),
    // Same words as a German title, other language: must not merge with it.
    poolItem('NRK', 'Bundestag stimmt über Haushalt ab', 'https://n/no1', 'no', 1785405700000),
  ],
};

describe('MCP news languages and editions', () => {
  let mcpHandler;
  let requests;
  let poolBody;

  beforeEach(async () => {
    process.env.MCP_INTERNAL_HMAC_SECRET = HMAC_SECRET;
    process.env.MCP_TELEMETRY = 'false';
    requests = [];
    poolBody = poolResponse;
    globalThis.fetch = async (input, init = {}) => {
      const url = String(input);
      requests.push(url);
      if (url.includes('/api/news/v1/list-feed-digest')) return Response.json(digestResponse);
      if (url.includes('/api/news/v1/list-news-pool')) return Response.json(poolBody);
      throw new Error(`unexpected fetch: ${url}`);
    };
    const mod = await import(`../api/mcp.ts?pool=${Date.now()}-${Math.random()}`);
    mcpHandler = mod.mcpHandler;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Object.keys(process.env).forEach((key) => {
      if (!(key in originalEnv)) delete process.env[key];
    });
    Object.assign(process.env, originalEnv);
  });

  async function callTool(name, args = {}, overrides = {}) {
    const { deps } = makeProDeps(overrides);
    const response = await mcpHandler(proReq('POST', callBody(name, args)), deps);
    const body = await response.json();
    const result = body.result?.content?.[0]?.text ? JSON.parse(body.result.content[0].text) : null;
    return { body, result };
  }

  const newsRequests = () => requests.filter((url) => url.includes('/api/news/v1/'));

  it('keeps a default call on the public English digest with today\'s fields', async () => {
    const { result } = await callTool('get_news_clusters', {});
    assert.equal(newsRequests().length, 1);
    assert.match(newsRequests()[0], /\/list-feed-digest\?variant=full&lang=en$/);
    assert.equal(result.variant, 'full');
    for (const field of ['languages', 'editions', 'poolCoverage']) assert.equal(field in result, false, field);
    assert.equal('language' in result.clusters[0], false);
  });

  it('treats variant tech as editions [tech]', async () => {
    await callTool('get_news_clusters', { variant: 'tech' });
    await callTool('get_news_clusters', { editions: ['tech'] });
    const [byVariant, byEditions] = newsRequests();
    assert.equal(byVariant, byEditions);
    assert.match(byVariant, /\/list-feed-digest\?variant=tech&lang=en$/);
  });

  it('clusters each requested language on its own, untranslated, with coverage', async () => {
    const { result } = await callTool('get_news_clusters', { languages: ['no', 'de'] });
    const [request] = newsRequests();
    assert.match(request, /\/list-news-pool\?languages=de&languages=no&editions=full$/, 'sorted, so reordered input hits the same cells');
    assert.deepEqual(result.languages, ['de', 'no']);
    assert.deepEqual(result.editions, ['full']);
    assert.equal(result.poolCoverage.state, 'partial', 'an unwarmed cell is partial coverage, not quiet');
    assert.deepEqual(result.poolCoverage.cells.map((cell) => `${cell.language}:${cell.state}`), ['en:complete', 'de:missing']);
    assert.deepEqual(result.clusters.map((cluster) => [cluster.language, cluster.memberCount]), [['de', 2], ['no', 1]]);
    assert.equal(result.clusters[0].title, 'Bundestag stimmt über Haushalt ab', 'publisher text, untranslated');
    assert.equal(result.clusters[0].threatLevel, 'high');
    assert.ok(result.clusters[0].corroboration);
    assert.deepEqual(result.clusters[0].editions, ['full']);
  });

  it('clusters non-Latin headlines by their own letters', async () => {
    poolBody = {
      ...poolResponse,
      state: 'complete',
      cells: [{ edition: 'full', language: 'ru', state: 'complete', items: 3, staleAgeSeconds: 0, generatedAt: '' }],
      items: [
        poolItem('TASS', 'Госдума приняла бюджет на следующий год', 'https://n/ru1', 'ru', 1785405900000),
        poolItem('Interfax', 'Госдума приняла бюджет на следующий год в третьем чтении', 'https://n/ru2', 'ru', 1785405800000),
        poolItem('RIA', 'Шторм обесточил побережье Приморья', 'https://n/ru3', 'ru', 1785405700000),
        poolItem('Xinhua', '国务院发布新的经济刺激计划', 'https://n/zh1', 'zh', 1785405600000),
        poolItem('CGTN', '国务院发布经济刺激计划', 'https://n/zh2', 'zh', 1785405500000),
        // Korean words are often two syllables long.
        poolItem('Yonhap', '정부 경제 발표', 'https://n/ko1', 'ko', 1785405400000),
        poolItem('KBS', '정부 경제 발표', 'https://n/ko2', 'ko', 1785405300000),
      ],
    };
    const { result } = await callTool('get_news_clusters', { languages: ['ko', 'ru', 'zh'] });
    const shape = result.clusters.map((cluster) => [cluster.language, cluster.memberCount]);
    assert.deepEqual(shape, [['ru', 2], ['ru', 1], ['zh', 2], ['ko', 2]], 'same story merges across publishers; a different story stays apart');
    assert.ok(result.clusters[0].topKeywords.includes('бюджет'), `keywords ${result.clusters[0].topKeywords}`);
    assert.ok(result.clusters[3].topKeywords.includes('경제'), `keywords ${result.clusters[3].topKeywords}`);
  });

  it('aggregates entities over several editions through the pool', async () => {
    const { result } = await callTool('extract_entities', { editions: ['finance', 'full'] });
    assert.match(newsRequests()[0], /\/list-news-pool\?languages=en&editions=full&editions=finance$/);
    assert.equal(result.headlineCount, 3);
    assert.deepEqual(result.editions, ['full', 'finance']);
    assert.equal('variant' in result, false);
  });

  it('refuses a caller without a subscription before any fetch', async () => {
    const free = { planKey: 'free', features: { tier: 0, mcpAccess: false }, validUntil: Date.now() + 86_400_000 };
    const { body } = await callTool('get_news_clusters', { languages: ['de'] }, { getEntitlements: async () => free });
    assert.equal(body.error?.code, -32002);
    assert.equal(body.error.data.reason, 'upgrade-required');
    assert.deepEqual(newsRequests(), []);
  });

  it('rejects unknown, oversized and conflicting filters before any fetch', async () => {
    const nine = NEWS_POOL_LAYOUT.languages.slice(0, 9);
    for (const args of [
      { languages: ['xx'] },
      { languages: nine },
      { editions: ['sports'] },
    ]) {
      const { body } = await callTool('get_news_clusters', args);
      assert.equal(body.error?.code, -32602, JSON.stringify(args));
    }
    const { result } = await callTool('get_news_clusters', { variant: 'tech', editions: ['full'] });
    assert.match(result.error, /editions or variant/);
    assert.deepEqual(newsRequests(), []);
  });

  it('answers a category outside the selected editions with a note, not a fetch', async () => {
    const { result } = await callTool('get_news_clusters', { languages: ['de'], category: 'markets' });
    assert.match(result.note, /Unknown digest category "markets"/);
    assert.deepEqual(newsRequests(), []);
  });

  it('matches camelCase category keys as written', async () => {
    await callTool('get_news_clusters', { languages: ['de'], editions: ['tech'], category: 'regionalStartups' });
    assert.match(newsRequests()[0], /category=regionalStartups$/);
  });

  it('keeps the widest read inside the output budget', async () => {
    const languages = NEWS_POOL_LAYOUT.languages.slice(0, 8);
    const items = [];
    for (const language of languages) {
      for (let i = 0; i < 120; i += 1) {
        // Distinct words per title, so every item is its own cluster.
        const title = Array.from({ length: 12 }, (_, w) => `${language}${i}w${w}`).join(' ');
        items.push(poolItem(`Outlet ${language} ${i % 9}`, title, `https://n/${language}/${i}`, language, 1785405600000 - i));
      }
    }
    const saved = poolResponse.items;
    poolResponse.items = items;
    try {
      const { body, result } = await callTool('get_news_clusters', { languages, editions: Object.keys(NEWS_POOL_LAYOUT.editions), limit: 25 });
      assert.ok(result, JSON.stringify(body).slice(0, 300));
      assert.equal(result.clusters.length, 25);
      assert.equal(result.totalClusters, items.length);
    } finally {
      poolResponse.items = saved;
    }
  });
});
