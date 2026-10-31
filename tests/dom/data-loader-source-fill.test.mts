// #9796: a digest category keeps its top items across every feed, so a panel
// whose user turned sources off can be left with enabled sources that have no
// item in it. The panel fills the slots its filter freed from those sources'
// cached rows (ListSourceItems), and a panel nobody changed never asks.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppContext } from '@/app/app-context';
import type { ListFeedDigestResponse, NewsItem as ProtoNewsItem } from '@/generated/client/worldmonitor/news/v1/service_client';
import { SITE_VARIANT } from '@/config/variant';
import { INTEL_SOURCES } from '@/config/feeds';

const mocks = vi.hoisted(() => ({ fetchCategoryFeeds: vi.fn() }));
vi.mock('@/services/rss', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/rss')>(),
  fetchCategoryFeeds: mocks.fetchCategoryFeeds,
  getFeedFailures: () => new Map(),
}));
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
  beginNewsLoad(): number;
  loadIntelNews(
    digest: { digest: ListFeedDigestResponse; servedStale: boolean } | null,
    allowDigestPendingFallback: boolean,
    options: { recordBaselineSample: boolean },
  ): Promise<NewsItemLike[]>;
  committedNewsGeneration: number;
  newsLoadGeneration: number;
}

/** A source-rows fetch held until `release()`. */
function gatedRows(rows: Record<string, ProtoNewsItem[]>) {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const served = sourceRowsFetch(rows);
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => { await gate; return served(input); });
  return { fetchMock, served, release };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 20));

interface Harness { loader: LoaderInternals; ctx: AppContext }

/** What the panel shows for `category` once a pending fill has landed. */
async function shownAfterFill(ctx: AppContext, category: string, count: number): Promise<NewsItemLike[]> {
  await vi.waitFor(() => expect(ctx.newsByCategory[category]).toHaveLength(count));
  return ctx.newsByCategory[category] as NewsItemLike[];
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

async function makeLoader(disabled: string[] = []): Promise<Harness> {
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
  return { loader: loader as unknown as LoaderInternals, ctx };
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
    const { loader } = await makeLoader();
    const digest = digestOf('europe', [...protoItems('Wire A', 2), ...protoItems('Wire B', 2)]);

    const items = await loader.loadNewsCategory('europe', feeds(['Wire A', 'Wire B', 'Niche C']), fresh(digest), false, OPTIONS);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(items.map(i => i.title).sort()).toEqual(['Wire A 0', 'Wire A 1', 'Wire B 0', 'Wire B 1']);
  });

  it('fills from enabled sources below the cap when the user turned a source off, up to the digest count', async () => {
    const fetchMock = sourceRowsFetch({ 'Niche C': protoItems('Niche C', 3), 'Niche D': protoItems('Niche D', 1) });
    vi.stubGlobal('fetch', fetchMock);
    const { loader, ctx } = await makeLoader(['Wire B']);
    const digest = digestOf('europe', [...protoItems('Wire A', 2), ...protoItems('Wire B', 2)]);

    const returned = await loader.loadNewsCategory('europe', feeds(['Wire A', 'Wire B', 'Niche D', 'Niche C']), fresh(digest), false, OPTIONS);

    // The digest items render first; the fill lands after.
    expect(returned.map(i => i.source)).toEqual(['Wire A', 'Wire A']);
    const items = await shownAfterFill(ctx, 'europe', 4);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = new URL(String(fetchMock.mock.calls[0]![0]), 'https://x.test');
    expect(url.searchParams.getAll('sources')).toEqual(['Niche C', 'Niche D']);
    expect(url.searchParams.getAll('editions')).toEqual([SITE_VARIANT]);
    expect(url.searchParams.get('category')).toBe('europe');
    expect(url.searchParams.get('lang')).toBe('en');
    expect(items.filter(i => i.source === 'Wire A')).toHaveLength(2);
    expect(new Set(items.map(i => i.source))).toEqual(new Set(['Wire A', 'Niche C', 'Niche D']));
  });

  it('does not ask for a source this language\'s digest never fetches', async () => {
    const fetchMock = sourceRowsFetch({});
    vi.stubGlobal('fetch', fetchMock);
    const { loader } = await makeLoader(['Wire B']);
    const digest = digestOf('europe', [...protoItems('Wire A', 1), ...protoItems('Wire B', 1)]);

    await loader.loadNewsCategory('europe', [
      ...feeds(['Wire A', 'Wire B']),
      { name: 'Le Quotidien', url: 'https://feeds.example/fr', lang: 'fr', digestLang: 'fr' },
    ], fresh(digest), false, OPTIONS);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the digest items when the source-rows request fails', async () => {
    vi.stubGlobal('fetch', sourceRowsFetch({}, 503));
    const { loader, ctx } = await makeLoader(['Wire B']);
    const digest = digestOf('europe', [...protoItems('Wire A', 2), ...protoItems('Wire B', 2)]);

    await loader.loadNewsCategory('europe', feeds(['Wire A', 'Wire B', 'Niche C']), fresh(digest), false, OPTIONS);
    await new Promise(resolve => setTimeout(resolve, 20));

    expect((ctx.newsByCategory.europe as NewsItemLike[]).map(i => i.source)).toEqual(['Wire A', 'Wire A']);
  });

  it('drops a fill that lands after a newer load started', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const rows = sourceRowsFetch({ 'Niche C': protoItems('Niche C', 1) });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => { await gate; return rows(input); }));
    const { loader, ctx } = await makeLoader(['Wire B']);
    const digest = digestOf('europe', [...protoItems('Wire A', 1), ...protoItems('Wire B', 1)]);

    await loader.loadNewsCategory('europe', feeds(['Wire A', 'Wire B', 'Niche C']), fresh(digest), false, OPTIONS);
    loader.beginNewsLoad();
    release();
    await vi.waitFor(() => expect(rows).toHaveBeenCalledTimes(1));
    await new Promise(resolve => setTimeout(resolve, 20));

    expect((ctx.newsByCategory.europe as NewsItemLike[]).map(i => i.source)).toEqual(['Wire A']);
  });
});

describe('a fill reaches the committed news set and never overwrites a newer render', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('drops a fill whose render a later digest in the same load replaced', async () => {
    const { fetchMock, served, release } = gatedRows({ 'Niche C': protoItems('Niche C', 1) });
    vi.stubGlobal('fetch', fetchMock);
    const { loader, ctx } = await makeLoader(['Wire B']);
    const list = feeds(['Wire A', 'Wire B', 'Niche C']);

    await loader.loadNewsCategory('europe', list, fresh(digestOf('europe', [...protoItems('Wire A', 1), ...protoItems('Wire B', 1)])), false, OPTIONS);
    const live = await loader.loadNewsCategory('europe', list, fresh(digestOf('europe', protoItems('Wire A', 2))), false, OPTIONS);
    release();
    await vi.waitFor(() => expect(served).toHaveBeenCalledTimes(1));
    await settle();

    expect(ctx.newsByCategory.europe).toBe(live);
  });

  it('adds the rows to what the load returns when the fill lands before the commit', async () => {
    vi.stubGlobal('fetch', sourceRowsFetch({ 'Niche C': protoItems('Niche C', 1) }));
    const { loader, ctx } = await makeLoader(['Wire B']);
    loader.beginNewsLoad();

    const returned = await loader.loadNewsCategory('europe', feeds(['Wire A', 'Wire B', 'Niche C']),
      fresh(digestOf('europe', [...protoItems('Wire A', 1), ...protoItems('Wire B', 1)])), false, OPTIONS);
    await shownAfterFill(ctx, 'europe', 2);

    expect(returned.map(i => i.source).sort()).toEqual(['Niche C', 'Wire A']);
  });

  it('appends the rows to the committed news set when the fill lands after the commit', async () => {
    const { fetchMock, served, release } = gatedRows({ 'Niche C': protoItems('Niche C', 1) });
    vi.stubGlobal('fetch', fetchMock);
    const { loader, ctx } = await makeLoader(['Wire B']);

    const returned = await loader.loadNewsCategory('europe', feeds(['Wire A', 'Wire B', 'Niche C']),
      fresh(digestOf('europe', [...protoItems('Wire A', 1), ...protoItems('Wire B', 1)])), false, OPTIONS);
    ctx.allNews = [...returned] as never[];
    loader.committedNewsGeneration = loader.newsLoadGeneration;
    release();
    await vi.waitFor(() => expect(served).toHaveBeenCalledTimes(1));
    await shownAfterFill(ctx, 'europe', 2);

    expect((ctx.allNews as NewsItemLike[]).map(i => i.source).sort()).toEqual(['Niche C', 'Wire A']);
  });

  it('fills the intel panel from the full edition', async () => {
    const [kept, off, niche] = INTEL_SOURCES.filter(feed => !feed.lang || feed.lang === 'en');
    const fetchMock = sourceRowsFetch({ [niche!.name]: protoItems(niche!.name, 1) });
    vi.stubGlobal('fetch', fetchMock);
    const enabled = new Set([kept!.name, niche!.name]);
    const { loader, ctx } = await makeLoader(INTEL_SOURCES.map(feed => feed.name).filter(name => !enabled.has(name)));
    const digest = digestOf('intel', [...protoItems(kept!.name, 1), ...protoItems(off!.name, 1)]);

    await loader.loadIntelNews(fresh(digest), false, { recordBaselineSample: false });
    const items = await shownAfterFill(ctx, 'intel', 2);

    const url = new URL(String(fetchMock.mock.calls[0]![0]), 'https://x.test');
    expect(url.searchParams.getAll('editions')).toEqual(['full']);
    expect(url.searchParams.getAll('sources')).toEqual([niche!.name]);
    expect(items.map(i => i.source).sort()).toEqual([kept!.name, niche!.name].sort());
  });
});

describe('cross-edition panels fill from sources no carrying digest includes', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    mocks.fetchCategoryFeeds.mockReset();
  });

  function crossEditionFetch(rows: ReturnType<typeof sourceRowsFetch>) {
    return vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'https://www.worldmonitor.app');
      if (!url.pathname.endsWith('/list-feed-digest')) return rows(input);
      const edition = url.searchParams.get('variant');
      const body = digestOf('markets', protoItems(edition === 'finance' ? 'Finance Wire' : 'Commodity Desk', 2));
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    });
  }

  it('reads the missing source from the carrying editions', async () => {
    const rows = sourceRowsFetch({ 'Niche Desk': protoItems('Niche Desk', 2) });
    vi.stubGlobal('fetch', crossEditionFetch(rows));
    const { loader, ctx } = await makeLoader();

    await loader.loadNewsCategory('markets', feeds(['Finance Wire', 'Commodity Desk', 'Niche Desk']), null, true, OPTIONS);

    const items = await shownAfterFill(ctx, 'markets', 6);
    expect(rows).toHaveBeenCalledTimes(1);
    const url = new URL(String(rows.mock.calls[0]![0]), 'https://x.test');
    expect(url.searchParams.getAll('editions').sort()).toEqual(['commodity', 'finance']);
    expect(new Set(items.map(i => i.source))).toEqual(new Set(['Finance Wire', 'Commodity Desk', 'Niche Desk']));
  });

  it('reads a source the browser limits to another language when every digest carries it', async () => {
    const rows = sourceRowsFetch({ 'Desk Français': protoItems('Desk Français', 1) });
    vi.stubGlobal('fetch', crossEditionFetch(rows));
    const { loader, ctx } = await makeLoader();

    await loader.loadNewsCategory('markets', [
      ...feeds(['Finance Wire', 'Commodity Desk']),
      { name: 'Desk Français', url: 'https://feeds.example/fr-desk', lang: 'fr' },
    ], null, true, OPTIONS);

    const items = await shownAfterFill(ctx, 'markets', 5);
    const url = new URL(String(rows.mock.calls[0]![0]), 'https://x.test');
    expect(url.searchParams.getAll('sources')).toEqual(['Desk Français']);
    expect(items.some(i => i.source === 'Desk Français')).toBe(true);
  });

  it('fills from source rows on a panel that also fetches a source directly', async () => {
    const rows = sourceRowsFetch({ 'Niche Desk': protoItems('Niche Desk', 1) });
    vi.stubGlobal('fetch', crossEditionFetch(rows));
    const direct = { source: 'Browser Desk', title: 'Browser Desk 0', link: 'https://example.com/browser/0', pubDate: new Date() };
    mocks.fetchCategoryFeeds.mockResolvedValue([direct]);
    const { loader, ctx } = await makeLoader();

    const items = await loader.loadNewsCategory('markets', [
      ...feeds(['Finance Wire', 'Commodity Desk', 'Niche Desk']),
      { name: 'Browser Desk', url: 'https://feeds.example/browser', browserOnly: true },
    ], null, true, OPTIONS);

    expect(mocks.fetchCategoryFeeds).toHaveBeenCalledTimes(1);
    const url = new URL(String(rows.mock.calls[0]![0]), 'https://x.test');
    expect(url.searchParams.getAll('sources')).toEqual(['Niche Desk']);
    expect(new Set(items.map(i => i.source))).toEqual(new Set(['Finance Wire', 'Commodity Desk', 'Niche Desk', 'Browser Desk']));
    expect(ctx.newsByCategory.markets).toEqual(items);
  });

  it('does not render a mixed panel after a newer load started while it waited for the rows', async () => {
    const { fetchMock: gated, release } = gatedRows({ 'Niche Desk': protoItems('Niche Desk', 1) });
    const digests = crossEditionFetch(sourceRowsFetch({}));
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes('/list-source-items') ? gated(input) : digests(input)));
    mocks.fetchCategoryFeeds.mockResolvedValue([
      { source: 'Browser Desk', title: 'Browser Desk 0', link: 'https://example.com/browser/0', pubDate: new Date() },
    ]);
    const { loader, ctx } = await makeLoader();

    const pending = loader.loadNewsCategory('markets', [
      ...feeds(['Finance Wire', 'Commodity Desk', 'Niche Desk']),
      { name: 'Browser Desk', url: 'https://feeds.example/browser', browserOnly: true },
    ], null, true, OPTIONS);
    await vi.waitFor(() => expect(gated).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(mocks.fetchCategoryFeeds).toHaveBeenCalled());
    const newer = [{ source: 'Newer', title: 'Newer 0', link: 'https://example.com/newer' }];
    loader.beginNewsLoad();
    ctx.newsByCategory.markets = newer as never[];
    release();
    await pending;
    await settle();

    expect(ctx.newsByCategory.markets).toBe(newer);
  });
});
