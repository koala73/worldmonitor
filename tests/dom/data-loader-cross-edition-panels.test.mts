import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppContext } from '@/app/app-context';
import type { ListFeedDigestResponse } from '@/generated/client/worldmonitor/news/v1/service_client';

const mocks = vi.hoisted(() => ({
  fetchCategoryFeeds: vi.fn(),
  checkBatchForBreakingAlerts: vi.fn(),
  ingestHeadlines: vi.fn(),
  saved: new Map<string, { data: unknown; updatedAt: number }>(),
}));

vi.mock('@/services/persistent-cache', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/persistent-cache')>(),
  getPersistentCache: async (key: string) => mocks.saved.get(key) ?? null,
  setPersistentCache: async (key: string, data: unknown) => { mocks.saved.set(key, { data, updatedAt: Date.now() }); },
}));
vi.mock('@/services/analysis-worker', () => ({
  analysisWorker: { clusterNews: vi.fn(), analyzeCorrelations: vi.fn() },
}));
vi.mock('@/services/rss', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/rss')>(),
  fetchCategoryFeeds: mocks.fetchCategoryFeeds,
  getFeedFailures: () => new Map(),
}));
vi.mock('@/services/breaking-news-alerts', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/breaking-news-alerts')>(),
  checkBatchForBreakingAlerts: mocks.checkBatchForBreakingAlerts,
}));
vi.mock('@/services/trending-keywords', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/trending-keywords')>(),
  ingestHeadlines: mocks.ingestHeadlines,
}));

interface NewsItemLike { source: string; title: string }

interface CrossEditionInternals {
  loadNewsCategory(
    category: string,
    feeds: Array<{ name: string; url: string; digestLang?: string }>,
    digest: null,
    isCustom: boolean,
    options: { recordBaselineSample: boolean },
    generation?: number,
    recordSelectedFreshness?: (servedStale: boolean) => void,
  ): Promise<NewsItemLike[]>;
}

function editionDigest(category: string, sources: string[], perSource = 2): ListFeedDigestResponse {
  return {
    categories: {
      [category]: {
        items: sources.flatMap((source, s) => Array.from({ length: perSource }, (_, i) => ({
          source,
          title: `${source} headline ${i}`,
          link: `https://example.com/${encodeURIComponent(source)}/${i}`,
          publishedAt: new Date(Date.UTC(2026, 9, 27, 12, s, i)).toISOString(),
        }))) as never[],
      },
    },
    feedStatuses: {},
    generatedAt: '2026-10-27T12:00:00.000Z',
    coverage: { state: 'ok', servedStale: false } as never,
  } as ListFeedDigestResponse;
}

function mergeDigests(...digests: ListFeedDigestResponse[]): ListFeedDigestResponse {
  return { ...digests[0]!, categories: Object.assign({}, ...digests.map(d => d.categories)) };
}

function digestFetch(byEdition: Record<string, ListFeedDigestResponse>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'https://www.worldmonitor.app');
    if (!url.pathname.endsWith('/list-feed-digest')) throw new Error(`unexpected direct fetch ${url}`);
    const body = byEdition[url.searchParams.get('variant') ?? ''];
    if (!body) return new Response('', { status: 503 });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  });
}

function editionsRequested(fetchMock: ReturnType<typeof digestFetch>): string[] {
  return fetchMock.mock.calls.map(([u]) => new URL(String(u), 'https://x.test').searchParams.get('variant') ?? '');
}

async function makeLoader(panels: Record<string, unknown> = {}) {
  const ctx = {
    statusPanel: { updateDigestCoverage: vi.fn(), updateFeed: vi.fn(), updateApi: vi.fn() },
    disabledSources: new Set<string>(),
    newsCategoryPanelKeys: new Map<string, string>(),
    newsPanels: {},
    panels,
    newsByCategory: {},
    currentTimeRange: 'all',
    allNews: [],
    latestClusters: [],
  } as unknown as AppContext;
  const { DataLoaderManager } = await import('@/app/data-loader');
  const loader = new DataLoaderManager(ctx, { renderCriticalBanner: () => undefined, refreshOpenCountryBrief: () => undefined });
  return loader as unknown as CrossEditionInternals;
}

const OPTIONS = { recordBaselineSample: false };
const feeds = (names: string[]) => names.map(name => ({ name, url: `https://feeds.example/${encodeURIComponent(name)}` }));

describe('cross-edition panels read the digests of every edition that carries them', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    mocks.fetchCategoryFeeds.mockReset();
    mocks.checkBatchForBreakingAlerts.mockReset();
    mocks.ingestHeadlines.mockReset();
    mocks.saved.clear();
  });

  it('merges a markets panel from both the finance and commodity digests', async () => {
    const fetchMock = digestFetch({
      finance: editionDigest('markets', ['Finance Wire']),
      commodity: editionDigest('markets', ['Commodity Desk']),
    });
    vi.stubGlobal('fetch', fetchMock);
    const setRefreshDegraded = vi.fn();
    const loader = await makeLoader({ markets: { setRefreshDegraded } });

    const items = await loader.loadNewsCategory('markets', feeds(['Finance Wire', 'Commodity Desk']), null, true, OPTIONS);

    expect(new Set(items.map(i => i.source))).toEqual(new Set(['Finance Wire', 'Commodity Desk']));
    expect(editionsRequested(fetchMock).sort()).toEqual(['commodity', 'finance']);
    expect(setRefreshDegraded).toHaveBeenLastCalledWith(false);
  });

  it('caps the merged panel at 40 items and keeps every source represented', async () => {
    const sources = Array.from({ length: 12 }, (_, i) => `Source ${i}`);
    vi.stubGlobal('fetch', digestFetch({
      finance: editionDigest('markets', sources.slice(0, 6), 5),
      commodity: editionDigest('markets', sources.slice(6), 5),
    }));
    const loader = await makeLoader();

    const items = await loader.loadNewsCategory('markets', feeds(sources), null, true, OPTIONS);

    expect(items).toHaveLength(40);
    expect(new Set(items.map(i => i.source)).size).toBe(12);
  });

  it('drops items from sources the user disabled', async () => {
    vi.stubGlobal('fetch', digestFetch({ tech: editionDigest('podcasts', ['Kept Show', 'Disabled Show']) }));
    const loader = await makeLoader();

    const items = await loader.loadNewsCategory('podcasts', feeds(['Kept Show']), null, true, OPTIONS);

    expect(items.length).toBeGreaterThan(0);
    expect(items.every(i => i.source === 'Kept Show')).toBe(true);
  });

  it('makes one digest request per edition for several panels in a refresh', async () => {
    const fetchMock = digestFetch({
      tech: mergeDigests(editionDigest('podcasts', ['Show']), editionDigest('thinktanks', ['Institute'])),
      full: editionDigest('thinktanks', ['Institute']),
    });
    vi.stubGlobal('fetch', fetchMock);
    const loader = await makeLoader();

    await loader.loadNewsCategory('podcasts', feeds(['Show']), null, true, OPTIONS);
    await loader.loadNewsCategory('thinktanks', feeds(['Institute']), null, true, OPTIONS);

    expect(editionsRequested(fetchMock).filter(e => e === 'tech')).toHaveLength(1);
  });

  it('sends digest items through breaking alerts and trending headlines', async () => {
    vi.stubGlobal('fetch', digestFetch({ tech: editionDigest('podcasts', ['Show']) }));
    const loader = await makeLoader();

    await loader.loadNewsCategory('podcasts', feeds(['Show']), null, true, OPTIONS);

    expect(mocks.checkBatchForBreakingAlerts).toHaveBeenCalledTimes(1);
    const alerted = mocks.checkBatchForBreakingAlerts.mock.calls[0]![0] as NewsItemLike[];
    expect(alerted.map(i => i.source)).toEqual(['Show', 'Show']);
    // Ingestion is async (dynamic import), so earlier tests' calls can land
    // here too; look for this panel's batch.
    await vi.waitFor(() => expect(mocks.ingestHeadlines.mock.calls.some(([batch]) =>
      (batch as NewsItemLike[]).length === 2 && (batch as NewsItemLike[]).every(h => h.source === 'Show'))).toBe(true));
  });

  it('does not alert on a stale digest replay', async () => {
    const stale = editionDigest('podcasts', ['Show']);
    stale.coverage = { state: 'ok', servedStale: true } as never;
    vi.stubGlobal('fetch', digestFetch({ tech: stale }));
    const loader = await makeLoader();

    await loader.loadNewsCategory('podcasts', feeds(['Show']), null, true, OPTIONS);

    expect(mocks.checkBatchForBreakingAlerts).not.toHaveBeenCalled();
  });

  it('shows only digest items; a source this language\'s digest omits is not fetched directly (digestLang)', async () => {
    // BBC Persian is `fa` on the server but unrestricted in the browser: the
    // English digest never carries it, and panels read only digests.
    vi.stubGlobal('fetch', digestFetch({
      finance: editionDigest('markets', ['Finance Wire']),
      commodity: editionDigest('markets', ['Commodity Desk']),
    }));
    const loader = await makeLoader();

    const persian = { name: 'Persian Service', url: 'https://feeds.example/persian', digestLang: 'fa' };
    const items = await loader.loadNewsCategory('markets', [
      ...feeds(['Finance Wire', 'Commodity Desk']),
      persian,
    ], null, true, OPTIONS);

    expect(mocks.fetchCategoryFeeds).not.toHaveBeenCalled();
    expect(new Set(items.map(i => i.source))).toEqual(new Set(['Finance Wire', 'Commodity Desk']));
  });

  it('shows the editions that arrived as live when another carrying edition digest is missing on a cold load', async () => {
    // markets is placed in finance and commodity; commodity answers 503.
    vi.stubGlobal('fetch', digestFetch({ finance: editionDigest('markets', ['Finance Wire']) }));
    const setRefreshDegraded = vi.fn();
    const loader = await makeLoader({ markets: { setRefreshDegraded } });
    const recorded: boolean[] = [];

    const items = await loader.loadNewsCategory('markets', feeds(['Finance Wire', 'Commodity Desk']), null, true, OPTIONS,
      undefined, servedStale => { recorded.push(servedStale); });

    expect(items.map(i => i.title).sort()).toEqual(['Finance Wire headline 0', 'Finance Wire headline 1']);
    expect(setRefreshDegraded).toHaveBeenLastCalledWith(false);
    expect(recorded).toEqual([false]);
    expect(mocks.fetchCategoryFeeds).not.toHaveBeenCalled();
  });

  it('keeps the missing edition\'s last items beside the fresh ones while its digest is missing and nothing was saved', async () => {
    vi.stubGlobal('fetch', digestFetch({
      finance: editionDigest('markets', ['Finance Wire']),
      commodity: editionDigest('markets', ['Commodity Desk']),
    }));
    const setRefreshDegraded = vi.fn();
    const loader = await makeLoader({ markets: { setRefreshDegraded } });
    await loader.loadNewsCategory('markets', feeds(['Finance Wire', 'Commodity Desk']), null, true, OPTIONS);
    (loader as unknown as { crossEditionDigests: Map<string, unknown> }).crossEditionDigests.clear();
    await vi.waitFor(() => expect(mocks.saved.size).toBe(2));
    mocks.saved.clear();
    const refreshed = editionDigest('markets', ['Finance Wire']);
    for (const item of refreshed.categories.markets!.items) (item as { title: string }).title += ' (new)';
    vi.stubGlobal('fetch', digestFetch({ finance: refreshed }));
    const recorded: boolean[] = [];

    const items = await loader.loadNewsCategory('markets', feeds(['Finance Wire', 'Commodity Desk']), null, true, OPTIONS,
      undefined, servedStale => { recorded.push(servedStale); });

    expect(items.map(i => i.title).sort()).toEqual([
      'Commodity Desk headline 0',
      'Commodity Desk headline 1',
      'Finance Wire headline 0 (new)',
      'Finance Wire headline 1 (new)',
    ]);
    expect(setRefreshDegraded).toHaveBeenLastCalledWith(true);
    expect(recorded).toEqual([true]);
    expect(mocks.fetchCategoryFeeds).not.toHaveBeenCalled();
  });

  it('keeps the panel\'s last items while no carrying edition digest arrives and nothing was saved', async () => {
    vi.stubGlobal('fetch', digestFetch({
      finance: editionDigest('markets', ['Finance Wire']),
      commodity: editionDigest('markets', ['Commodity Desk']),
    }));
    const loader = await makeLoader();
    const first = await loader.loadNewsCategory('markets', feeds(['Finance Wire', 'Commodity Desk']), null, true, OPTIONS);
    (loader as unknown as { crossEditionDigests: Map<string, unknown> }).crossEditionDigests.clear();
    await vi.waitFor(() => expect(mocks.saved.size).toBe(2));
    mocks.saved.clear();
    vi.stubGlobal('fetch', digestFetch({}));
    const recorded: boolean[] = [];

    const items = await loader.loadNewsCategory('markets', feeds(['Finance Wire', 'Commodity Desk']), null, true, OPTIONS,
      undefined, servedStale => { recorded.push(servedStale); });

    expect(items.map(i => i.title).sort()).toEqual(first.map(i => i.title).sort());
    expect(recorded).toEqual([true]);
    expect(mocks.fetchCategoryFeeds).not.toHaveBeenCalled();
  });

  it('serves the edition digests a previous page load saved, marked cached, when they are down on a new page load', async () => {
    vi.stubGlobal('fetch', digestFetch({
      finance: editionDigest('markets', ['Finance Wire']),
      commodity: editionDigest('markets', ['Commodity Desk']),
    }));
    const firstPage = await makeLoader();
    const first = await firstPage.loadNewsCategory('markets', feeds(['Finance Wire', 'Commodity Desk']), null, true, OPTIONS);
    await vi.waitFor(() => expect(mocks.saved.size).toBe(2));
    mocks.checkBatchForBreakingAlerts.mockClear();

    vi.stubGlobal('fetch', digestFetch({}));
    const setRefreshDegraded = vi.fn();
    const secondPage = await makeLoader({ markets: { setRefreshDegraded } });
    const recorded: boolean[] = [];

    const items = await secondPage.loadNewsCategory('markets', feeds(['Finance Wire', 'Commodity Desk']), null, true, OPTIONS,
      undefined, servedStale => { recorded.push(servedStale); });

    expect(items.map(i => i.title).sort()).toEqual(first.map(i => i.title).sort());
    expect(setRefreshDegraded).toHaveBeenLastCalledWith(true);
    expect(recorded).toEqual([true]);
    expect(mocks.checkBatchForBreakingAlerts).not.toHaveBeenCalled();
    expect(mocks.fetchCategoryFeeds).not.toHaveBeenCalled();
  });
});
