import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppContext } from '@/app/app-context';
import type { ListFeedDigestResponse } from '@/generated/client/worldmonitor/news/v1/service_client';

const mocks = vi.hoisted(() => ({
  fetchCategoryFeeds: vi.fn(),
  checkBatchForBreakingAlerts: vi.fn(),
  ingestHeadlines: vi.fn(),
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
    feeds: Array<{ name: string; url: string; browserOnly?: true; digestLang?: string }>,
    digest: null,
    isCustom: boolean,
    options: { allowDigestPendingFallback: boolean; recordBaselineSample: boolean },
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

async function makeLoader() {
  const ctx = {
    statusPanel: { updateDigestCoverage: vi.fn(), updateFeed: vi.fn(), updateApi: vi.fn() },
    disabledSources: new Set<string>(),
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
  return loader as unknown as CrossEditionInternals;
}

const OPTIONS = { allowDigestPendingFallback: false, recordBaselineSample: false };
const feeds = (names: string[]) => names.map(name => ({ name, url: `https://feeds.example/${encodeURIComponent(name)}` }));

describe('cross-edition panels read the digests of every edition that carries them', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    mocks.fetchCategoryFeeds.mockReset();
    mocks.checkBatchForBreakingAlerts.mockReset();
    mocks.ingestHeadlines.mockReset();
  });

  it('merges a markets panel from both the finance and commodity digests', async () => {
    const fetchMock = digestFetch({
      finance: editionDigest('markets', ['Finance Wire']),
      commodity: editionDigest('markets', ['Commodity Desk']),
    });
    vi.stubGlobal('fetch', fetchMock);
    const loader = await makeLoader();

    const items = await loader.loadNewsCategory('markets', feeds(['Finance Wire', 'Commodity Desk']), null, true, OPTIONS);

    expect(new Set(items.map(i => i.source))).toEqual(new Set(['Finance Wire', 'Commodity Desk']));
    expect(editionsRequested(fetchMock).sort()).toEqual(['commodity', 'finance']);
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

  it('clears the partial-coverage badge total when every source is digest-served', async () => {
    vi.stubGlobal('fetch', digestFetch({ tech: editionDigest('podcasts', ['Show']) }));
    const loader = await makeLoader();
    const totals = (loader as unknown as { customNewsSourceTotals: Map<string, number> }).customNewsSourceTotals;

    await loader.loadNewsCategory('podcasts', feeds(['Show']), null, true, OPTIONS);

    expect(totals.has('podcasts')).toBe(false);
  });

  const directFetch = async (requested: Array<{ name: string }>) =>
    requested.map((feed, i) => ({
      source: feed.name,
      title: `${feed.name} direct ${i}`,
      link: `https://direct.example/${encodeURIComponent(feed.name)}`,
      pubDate: new Date(Date.UTC(2026, 9, 27, 13, 0, i)),
    }));
  const BROWSER_ONLY = { name: 'Browser Only Wire', url: 'https://feeds.example/browser-only', browserOnly: true as const };

  it('still fetches sources no digest carries yet, merged with the digest items', async () => {
    vi.stubGlobal('fetch', digestFetch({
      finance: editionDigest('markets', ['Finance Wire']),
      commodity: editionDigest('markets', ['Commodity Desk']),
    }));
    mocks.fetchCategoryFeeds.mockImplementation(directFetch);
    const loader = await makeLoader();

    const items = await loader.loadNewsCategory('markets', [
      ...feeds(['Finance Wire', 'Commodity Desk']),
      BROWSER_ONLY,
    ], null, true, OPTIONS);

    const requested = mocks.fetchCategoryFeeds.mock.calls[0]![0] as Array<{ name: string }>;
    expect(requested.map(f => f.name)).toEqual(['Browser Only Wire']);
    expect(new Set(items.map(i => i.source))).toEqual(new Set(['Finance Wire', 'Commodity Desk', 'Browser Only Wire']));
  });

  it('fetches a source directly when this language\'s digest omits it (digestLang)', async () => {
    // BBC Persian is `fa` on the server but unrestricted in the browser: the
    // English digest never carries it, so it must not count as digest-served.
    vi.stubGlobal('fetch', digestFetch({
      finance: editionDigest('markets', ['Finance Wire']),
      commodity: editionDigest('markets', ['Commodity Desk']),
    }));
    mocks.fetchCategoryFeeds.mockImplementation(directFetch);
    const loader = await makeLoader();

    const persian = { name: 'Persian Service', url: 'https://feeds.example/persian', digestLang: 'fa' };
    const items = await loader.loadNewsCategory('markets', [
      ...feeds(['Finance Wire', 'Commodity Desk']),
      persian,
    ], null, true, OPTIONS);

    const requested = mocks.fetchCategoryFeeds.mock.calls[0]![0] as Array<{ name: string }>;
    expect(requested.map(f => f.name)).toEqual(['Persian Service']);
    expect(new Set(items.map(i => i.source))).toEqual(new Set(['Finance Wire', 'Commodity Desk', 'Persian Service']));
  });

  it('falls back to fetching every source when one carrying edition digest is missing', async () => {
    // markets is placed in finance and commodity; commodity answers 503.
    vi.stubGlobal('fetch', digestFetch({ finance: editionDigest('markets', ['Finance Wire']) }));
    mocks.fetchCategoryFeeds.mockImplementation(directFetch);
    const loader = await makeLoader();

    await loader.loadNewsCategory('markets', [
      ...feeds(['Finance Wire', 'Commodity Desk']),
      BROWSER_ONLY,
    ], null, true, OPTIONS);

    const requested = mocks.fetchCategoryFeeds.mock.calls[0]![0] as Array<{ name: string }>;
    expect(requested.map(f => f.name)).toContain('Commodity Desk');
  });

  it('keeps a stale digest stale when direct feeds are merged onto it', async () => {
    const stale = editionDigest('markets', ['Finance Wire']);
    stale.coverage = { state: 'ok', servedStale: true } as never;
    vi.stubGlobal('fetch', digestFetch({ finance: stale, commodity: editionDigest('markets', ['Commodity Desk']) }));
    mocks.fetchCategoryFeeds.mockImplementation(directFetch);
    const loader = await makeLoader();
    const recorded: boolean[] = [];

    await loader.loadNewsCategory('markets', [
      ...feeds(['Finance Wire', 'Commodity Desk']),
      BROWSER_ONLY,
    ], null, true, OPTIONS, undefined, servedStale => { recorded.push(servedStale); });

    expect(recorded.length).toBeGreaterThan(0);
    expect(recorded[recorded.length - 1]).toBe(true);
  });
});
