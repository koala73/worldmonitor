/**
 * The outage fallback (unified news catalog plan, KTD9): panels read only
 * digests. When no digest carries a category and the panel has no items,
 * desktop fetches a few of its catalog feeds directly unless the
 * `newsOutageFallback` switch is off. Web never fetches feeds directly.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppContext } from '@/app/app-context';
import type { ListFeedDigestResponse } from '@/generated/client/worldmonitor/news/v1/service_client';

const mocks = vi.hoisted(() => ({
  fetchCategoryFeeds: vi.fn(),
  isDesktopRuntime: vi.fn(() => false),
  toggles: {} as Record<string, boolean>,
}));

vi.mock('@/services/analysis-worker', () => ({
  analysisWorker: { clusterNews: vi.fn(), analyzeCorrelations: vi.fn() },
}));
vi.mock('@/services/rss', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/rss')>(),
  fetchCategoryFeeds: mocks.fetchCategoryFeeds,
  getFeedFailures: () => new Map(),
}));
vi.mock('@/services/runtime', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/runtime')>(),
  isDesktopRuntime: mocks.isDesktopRuntime,
}));
vi.mock('@/services/runtime-config', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/runtime-config')>(),
  isFeatureEnabled: (id: string) => mocks.toggles[id] ?? true,
}));

interface NewsItemLike { source: string; title: string; link?: string }
type FeedLike = { name: string; url: string; lang?: string };
type Selection = { digest: ListFeedDigestResponse; servedStale: boolean } | null;

interface LoaderInternals {
  loadNewsCategory(
    category: string,
    feeds: FeedLike[],
    digest: Selection,
    isCustom: boolean,
    options: { recordBaselineSample: boolean; digestPending: boolean },
    generation?: number,
    recordSelectedFreshness?: (servedStale: boolean) => void,
  ): Promise<NewsItemLike[]>;
  loadIntelNews(digest: Selection, options: { recordBaselineSample: boolean; digestPending: boolean }): Promise<NewsItemLike[]>;
}

const OPTIONS = { recordBaselineSample: false, digestPending: false };
const PENDING = { recordBaselineSample: false, digestPending: true };
const feeds = (names: string[]): FeedLike[] => names.map(name => ({ name, url: `https://feeds.example/${encodeURIComponent(name)}` }));

function digestOf(category: string, sources: string[]): Selection {
  return {
    digest: {
      categories: {
        [category]: {
          items: sources.map((source, i) => ({
            source,
            title: `${source} digest ${i}`,
            link: `https://example.com/${encodeURIComponent(source)}/${i}`,
            publishedAt: new Date(Date.UTC(2026, 9, 29, 12, 0, i)).toISOString(),
          })) as never[],
        },
      },
      feedStatuses: {},
      generatedAt: '2026-10-29T12:00:00.000Z',
      coverage: { state: 'ok', servedStale: false } as never,
    } as ListFeedDigestResponse,
    servedStale: false,
  };
}

async function makeLoader() {
  const statusPanel = { updateDigestCoverage: vi.fn(), updateFeed: vi.fn(), updateApi: vi.fn() };
  const panels = {
    politics: { renderNews: vi.fn(), renderFilteredEmpty: vi.fn(), setRefreshDegraded: vi.fn() },
  };
  const ctx = {
    statusPanel,
    disabledSources: new Set<string>(),
    newsCategoryPanelKeys: new Map<string, string>(),
    newsPanels: panels,
    panels,
    newsByCategory: {},
    currentTimeRange: 'all',
    allNews: [],
    latestClusters: [],
  } as unknown as AppContext;
  const { DataLoaderManager } = await import('@/app/data-loader');
  const loader = new DataLoaderManager(ctx, { renderCriticalBanner: () => undefined, refreshOpenCountryBrief: () => undefined });
  return { loader: loader as unknown as LoaderInternals, ctx, statusPanel, panels };
}

const fetchedNames = () => (mocks.fetchCategoryFeeds.mock.calls[0]![0] as FeedLike[]).map(f => f.name);

beforeEach(() => {
  vi.unstubAllGlobals();
  // Any other request (edition digests, source rows) is an outage here.
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })));
  mocks.fetchCategoryFeeds.mockReset();
  mocks.fetchCategoryFeeds.mockImplementation(async (requested: FeedLike[]) => requested.map((feed, i) => ({
    source: feed.name,
    title: `${feed.name} direct ${i}`,
    link: `https://direct.example/${encodeURIComponent(feed.name)}`,
    pubDate: new Date(Date.UTC(2026, 9, 29, 13, 0, i)),
  })));
  mocks.isDesktopRuntime.mockReturnValue(false);
  mocks.toggles = {};
});

describe('desktop outage fallback', () => {
  beforeEach(() => { mocks.isDesktopRuntime.mockReturnValue(true); });

  it('renders a desktop energy panel from the digest with no direct fetch (AE4)', async () => {
    const { loader } = await makeLoader();

    const items = await loader.loadNewsCategory('energy', feeds(['Oil Desk', 'Grid Wire']), digestOf('energy', ['Oil Desk', 'Grid Wire']), false, OPTIONS);

    expect(items.map(i => i.source)).toEqual(['Oil Desk', 'Grid Wire']);
    expect(mocks.fetchCategoryFeeds).not.toHaveBeenCalled();
  });

  it('fetches a capped prefix of the catalog feeds when no digest carries the category and the panel is empty (AE5)', async () => {
    const { loader } = await makeLoader();
    const recorded: boolean[] = [];

    const items = await loader.loadNewsCategory('politics', feeds(['A', 'B', 'C', 'D', 'E']), null, false, OPTIONS,
      undefined, servedStale => { recorded.push(servedStale); });

    expect(fetchedNames()).toEqual(['A', 'B', 'C']);
    expect(items.map(i => i.source).sort()).toEqual(['A', 'B', 'C']);
    expect(recorded).toEqual([false]);
  });

  it('spends the cap on feeds this UI language can read', async () => {
    const { loader } = await makeLoader();

    await loader.loadNewsCategory('europe', [
      { name: 'Tagesschau', url: 'https://feeds.example/de', lang: 'de' },
      { name: 'Le Monde', url: 'https://feeds.example/fr', lang: 'fr' },
      ...feeds(['Reuters Europe', 'BBC Europe']),
    ], null, false, OPTIONS);

    expect(fetchedNames()).toEqual(['Reuters Europe', 'BBC Europe']);
  });

  it('falls back for a cross-edition panel whose edition digests are unavailable', async () => {
    const { loader } = await makeLoader();

    await loader.loadNewsCategory('markets', feeds(['Finance Wire', 'Commodity Desk']), null, true, OPTIONS);

    expect(fetchedNames()).toEqual(['Finance Wire', 'Commodity Desk']);
  });

  it('waits for a pending digest instead of fetching, then falls back once it settles empty', async () => {
    const { loader, statusPanel } = await makeLoader();

    expect(await loader.loadNewsCategory('politics', feeds(['A', 'B']), null, false, PENDING)).toEqual([]);
    expect(await loader.loadIntelNews(null, PENDING)).toEqual([]);
    expect(mocks.fetchCategoryFeeds).not.toHaveBeenCalled();
    expect(statusPanel.updateFeed).not.toHaveBeenCalled();

    await loader.loadNewsCategory('politics', feeds(['A', 'B']), null, false, OPTIONS);
    expect(fetchedNames()).toEqual(['A', 'B']);
  });

  it('shows the panel\'s last items instead of fetching while it has any, marked cached', async () => {
    const { loader, panels } = await makeLoader();
    const shown = await loader.loadNewsCategory('politics', feeds(['A', 'B']), digestOf('politics', ['A', 'B']), false, OPTIONS);
    const recorded: boolean[] = [];

    const items = await loader.loadNewsCategory('politics', feeds(['A', 'B']), null, false, OPTIONS,
      undefined, servedStale => { recorded.push(servedStale); });

    expect(items.map(i => i.title).sort()).toEqual(shown.map(i => i.title).sort());
    expect(recorded).toEqual([true]);
    expect(mocks.fetchCategoryFeeds).not.toHaveBeenCalled();
    expect(panels.politics.setRefreshDegraded).toHaveBeenLastCalledWith(true);
  });

  it('turning the switch off stops the fetch and reports the digest unavailable', async () => {
    mocks.toggles.newsOutageFallback = false;
    const { loader, statusPanel } = await makeLoader();

    const items = await loader.loadNewsCategory('politics', feeds(['A', 'B']), null, false, OPTIONS);

    expect(items).toEqual([]);
    expect(mocks.fetchCategoryFeeds).not.toHaveBeenCalled();
    expect(statusPanel.updateFeed).toHaveBeenCalledWith('Politics', { status: 'error', errorMessage: 'Digest unavailable' });
  });

  it('applies to the intel panel too, and its switch', async () => {
    const { loader } = await makeLoader();
    await loader.loadIntelNews(null, OPTIONS);
    expect(mocks.fetchCategoryFeeds).toHaveBeenCalledTimes(1);
    expect((mocks.fetchCategoryFeeds.mock.calls[0]![0] as FeedLike[]).length).toBeLessThanOrEqual(6);

    mocks.fetchCategoryFeeds.mockClear();
    mocks.toggles.newsOutageFallback = false;
    const { loader: off } = await makeLoader();
    expect(await off.loadIntelNews(null, OPTIONS)).toEqual([]);
    expect(mocks.fetchCategoryFeeds).not.toHaveBeenCalled();
  });
});

describe('web makes no direct feed requests', () => {
  it('leaves a preset panel loading, not empty, while the digest is pending', async () => {
    const { loader, statusPanel, panels } = await makeLoader();

    await loader.loadNewsCategory('politics', feeds(['A', 'B']), null, false, PENDING);

    expect(panels.politics.renderNews).not.toHaveBeenCalled();
    expect(statusPanel.updateFeed).not.toHaveBeenCalled();
  });

  it('leaves a preset panel empty when no digest carries its category (AE5)', async () => {
    const { loader, statusPanel } = await makeLoader();

    const items = await loader.loadNewsCategory('politics', feeds(['A', 'B']), null, false, OPTIONS);

    expect(items).toEqual([]);
    expect(mocks.fetchCategoryFeeds).not.toHaveBeenCalled();
    expect(statusPanel.updateFeed).toHaveBeenCalledWith('Politics', { status: 'error', errorMessage: 'Digest unavailable' });
  });

  it('even with the switch on, for preset, cross-edition and intel panels', async () => {
    mocks.toggles.newsOutageFallback = true;
    const { loader } = await makeLoader();

    await loader.loadNewsCategory('politics', feeds(['A']), null, false, OPTIONS);
    await loader.loadNewsCategory('markets', feeds(['Finance Wire']), null, true, OPTIONS);
    await loader.loadIntelNews(null, OPTIONS);

    expect(mocks.fetchCategoryFeeds).not.toHaveBeenCalled();
  });
});
