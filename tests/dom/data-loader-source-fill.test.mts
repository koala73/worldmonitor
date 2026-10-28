// #9796: a digest category keeps its top items across every feed, so a panel
// whose user turned sources off can be left with enabled sources that have no
// item in it. The panel fills the slots its filter freed from those sources'
// cached rows (ListSourceItems), and a panel nobody changed never asks.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppContext } from '@/app/app-context';
import type { ListFeedDigestResponse, NewsItem as ProtoNewsItem } from '@/generated/client/worldmonitor/news/v1/service_client';
import { SITE_VARIANT } from '@/config/variant';

vi.mock('@/services/analysis-worker', () => ({
  analysisWorker: { clusterNews: vi.fn(), analyzeCorrelations: vi.fn() },
}));
vi.mock('@/services/breaking-news-alerts', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/breaking-news-alerts')>(),
  checkBatchForBreakingAlerts: vi.fn(),
}));
vi.mock('@/services/trending-keywords', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/trending-keywords')>(),
  ingestHeadlines: vi.fn(),
}));

interface NewsItemLike { source: string; title: string }
type FeedLike = { name: string; url: string; browserOnly?: true; digestLang?: string; lang?: string };

interface LoaderInternals {
  loadNewsCategory(
    category: string,
    feeds: FeedLike[],
    digest: { digest: ListFeedDigestResponse; servedStale: boolean } | null,
    isCustom: boolean,
    options: { allowDigestPendingFallback: boolean; recordBaselineSample: boolean },
  ): Promise<NewsItemLike[]>;
}

let minute = 0;
function protoItems(source: string, count: number): ProtoNewsItem[] {
  return Array.from({ length: count }, (_, i) => ({
    source,
    title: `${source} ${i}`,
    link: `https://example.com/${encodeURIComponent(source)}/${i}`,
    publishedAt: Date.UTC(2026, 9, 28, 12, ++minute),
  })) as never[];
}

function digestOf(category: string, items: ProtoNewsItem[]): ListFeedDigestResponse {
  return {
    categories: { [category]: { items } },
    feedStatuses: {},
    generatedAt: '2026-10-28T12:00:00.000Z',
    coverage: { state: 'ok', servedStale: false },
  } as unknown as ListFeedDigestResponse;
}

/** Serves list-source-items from `rows`; any other request is a test failure. */
function sourceRowsFetch(rows: Record<string, ProtoNewsItem[]>, status = 200) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'https://www.worldmonitor.app');
    if (!url.pathname.endsWith('/list-source-items')) throw new Error(`unexpected request ${url}`);
    if (status !== 200) return new Response('', { status });
    const items = url.searchParams.getAll('sources').flatMap(source => rows[source] ?? []);
    return new Response(JSON.stringify({ items, sources: [], generatedAt: '' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  });
}

async function makeLoader(disabled: string[] = []) {
  const ctx = {
    statusPanel: { updateDigestCoverage: vi.fn(), updateFeed: vi.fn(), updateApi: vi.fn() },
    disabledSources: new Set<string>(disabled),
    newsCategoryPanelKeys: new Map<string, string>(),
    newsPanels: {},
    panels: {},
    newsByCategory: {},
    currentTimeRange: 'all',
    allNews: [],
    latestClusters: [],
  } as unknown as AppContext;
  const { DataLoaderManager } = await import('@/app/data-loader');
  const loader = new DataLoaderManager(ctx, { renderCriticalBanner: () => undefined, refreshOpenCountryBrief: () => undefined });
  return loader as unknown as LoaderInternals;
}

const OPTIONS = { allowDigestPendingFallback: false, recordBaselineSample: false };
const feeds = (names: string[]): FeedLike[] => names.map(name => ({ name, url: `https://feeds.example/${encodeURIComponent(name)}` }));
const fresh = (digest: ListFeedDigestResponse) => ({ digest, servedStale: false });

describe('preset panels fill slots the source filter freed from cached source rows', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('a panel with every source on makes no request and shows exactly the digest items', async () => {
    const fetchMock = sourceRowsFetch({});
    vi.stubGlobal('fetch', fetchMock);
    const loader = await makeLoader();
    const digest = digestOf('europe', [...protoItems('Wire A', 2), ...protoItems('Wire B', 2)]);

    const items = await loader.loadNewsCategory('europe', feeds(['Wire A', 'Wire B', 'Niche C']), fresh(digest), false, OPTIONS);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(items.map(i => i.title).sort()).toEqual(['Wire A 0', 'Wire A 1', 'Wire B 0', 'Wire B 1']);
  });

  it('fills from enabled sources below the cap when the user turned a source off, up to the digest count', async () => {
    const fetchMock = sourceRowsFetch({ 'Niche C': protoItems('Niche C', 3), 'Niche D': protoItems('Niche D', 1) });
    vi.stubGlobal('fetch', fetchMock);
    const loader = await makeLoader(['Wire B']);
    const digest = digestOf('europe', [...protoItems('Wire A', 2), ...protoItems('Wire B', 2)]);

    const items = await loader.loadNewsCategory('europe', feeds(['Wire A', 'Wire B', 'Niche D', 'Niche C']), fresh(digest), false, OPTIONS);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = new URL(String(fetchMock.mock.calls[0]![0]), 'https://x.test');
    expect(url.searchParams.getAll('sources')).toEqual(['Niche C', 'Niche D']);
    expect(url.searchParams.getAll('editions')).toEqual([SITE_VARIANT]);
    expect(url.searchParams.get('category')).toBe('europe');
    expect(items).toHaveLength(4);
    expect(items.filter(i => i.source === 'Wire A')).toHaveLength(2);
    expect(new Set(items.map(i => i.source))).toEqual(new Set(['Wire A', 'Niche C', 'Niche D']));
  });

  it('does not ask for a source this language\'s digest never fetches', async () => {
    const fetchMock = sourceRowsFetch({});
    vi.stubGlobal('fetch', fetchMock);
    const loader = await makeLoader(['Wire B']);
    const digest = digestOf('europe', [...protoItems('Wire A', 1), ...protoItems('Wire B', 1)]);

    await loader.loadNewsCategory('europe', [
      ...feeds(['Wire A', 'Wire B']),
      { name: 'Le Quotidien', url: 'https://feeds.example/fr', lang: 'fr' },
    ], fresh(digest), false, OPTIONS);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the digest items when the source-rows request fails', async () => {
    vi.stubGlobal('fetch', sourceRowsFetch({}, 503));
    const loader = await makeLoader(['Wire B']);
    const digest = digestOf('europe', [...protoItems('Wire A', 2), ...protoItems('Wire B', 2)]);

    const items = await loader.loadNewsCategory('europe', feeds(['Wire A', 'Wire B', 'Niche C']), fresh(digest), false, OPTIONS);

    expect(items.map(i => i.source)).toEqual(['Wire A', 'Wire A']);
  });
});

describe('cross-edition panels fill from sources no carrying digest includes', () => {
  it('reads the missing source from the carrying editions', async () => {
    const rows = sourceRowsFetch({ 'Niche Desk': protoItems('Niche Desk', 2) });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'https://www.worldmonitor.app');
      if (!url.pathname.endsWith('/list-feed-digest')) return rows(input);
      const edition = url.searchParams.get('variant');
      const body = digestOf('markets', protoItems(edition === 'finance' ? 'Finance Wire' : 'Commodity Desk', 2));
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const loader = await makeLoader();

    const items = await loader.loadNewsCategory('markets', feeds(['Finance Wire', 'Commodity Desk', 'Niche Desk']), null, true, OPTIONS);

    expect(rows).toHaveBeenCalledTimes(1);
    const url = new URL(String(rows.mock.calls[0]![0]), 'https://x.test');
    expect(url.searchParams.getAll('editions').sort()).toEqual(['commodity', 'finance']);
    expect(new Set(items.map(i => i.source))).toEqual(new Set(['Finance Wire', 'Commodity Desk', 'Niche Desk']));
  });
});
