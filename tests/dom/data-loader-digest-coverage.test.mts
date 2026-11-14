import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppContext } from '@/app/app-context';
import type { ListFeedDigestResponse } from '@/generated/client/worldmonitor/news/v1/service_client';
import type { ClusteredEvent } from '@/types';

const mocks = vi.hoisted(() => ({
  checkBatchForBreakingAlerts: vi.fn(),
  clusterNews: vi.fn(),
  analyzeCorrelations: vi.fn(),
  enqueueSentryCall: vi.fn(),
  track: vi.fn(),
  isAnalyticsHost: vi.fn(() => true),
}));

vi.mock('@/bootstrap/sentry-defer', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/bootstrap/sentry-defer')>(),
  enqueueSentryCall: mocks.enqueueSentryCall,
}));

vi.mock('@/services/analytics', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/analytics')>(),
  track: mocks.track,
  isAnalyticsHost: mocks.isAnalyticsHost,
}));

vi.mock('@/services/breaking-news-alerts', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/breaking-news-alerts')>(),
  checkBatchForBreakingAlerts: mocks.checkBatchForBreakingAlerts,
}));

vi.mock('@/services/analysis-worker', () => ({
  analysisWorker: {
    clusterNews: mocks.clusterNews,
    analyzeCorrelations: mocks.analyzeCorrelations,
  },
}));

await import('@/app/data-loader');
const { INTEL_SOURCES } = await import('@/config');

interface SelectedNewsDigest {
  digest: ListFeedDigestResponse;
  servedStale: boolean;
}

interface DigestLoaderInternals {
  digestBreaker: {
    state: 'closed' | 'open' | 'half-open';
    failures: number;
    cooldownUntil: number;
  };
  lastGoodDigest: { key: string; data: ListFeedDigestResponse } | null;
  digestCacheKey(language?: string): string;
  loadPersistedDigest(key?: string): Promise<ListFeedDigestResponse | null>;
  persistDigest(key: string, data: ListFeedDigestResponse): void;
  tryFetchDigest(): Promise<SelectedNewsDigest | null>;
  fetchEditionDigest(edition: string, language: string): Promise<ListFeedDigestResponse | null>;
  beginNewsLoad(): number;
  commitNewsFreshness(generation: number, servedStale: boolean): boolean;
  canNotifyForCommittedNews(generation: number, servedStale: boolean): boolean;
  runCorrelationAnalysis(): Promise<void>;
  resolveEnabledNewsCategories(): Array<{ key: string; feeds: Array<{ name: string; url: string }>; isCustom: boolean }>;
  loadIntelNews(
    digest?: SelectedNewsDigest | null,
    options?: { recordBaselineSample: boolean },
    generation?: number,
  ): Promise<unknown[]>;
  clusterNewsForGeneration(): Promise<{ clusters: ClusteredEvent[] }>;
  loadNewsCategory(
    category: string,
    feeds: Array<{ name: string }>,
    digest: SelectedNewsDigest | null,
    isCustom: boolean,
    options: { recordBaselineSample: boolean },
    generation: number,
  ): Promise<unknown[]>;
}

function digest(state: string, itemCount = 2): ListFeedDigestResponse {
  return {
    categories: {
      politics: {
        items: Array.from({ length: itemCount }, (_, index) => ({
          source: `source-${index}`,
          title: `item-${index}`,
          link: `https://example.com/${index}`,
          publishedAt: '2026-08-25T00:00:00.000Z',
        })) as never[],
      },
    },
    feedStatuses: {},
    generatedAt: '2026-08-25T00:00:00.000Z',
    coverage: {
      state,
      attemptedAt: '2026-08-25T00:00:00.000Z',
      itemsServed: itemCount,
      publisherCount: 1,
      feedTotal: 2,
      feedCompleted: 2,
      categoryTotal: 1,
      categoryCompleted: 1,
      categoryStates: { politics: 'ok' },
      droppedFeedCap: 0,
      droppedUndated: 0,
      droppedFreshness: 0,
      droppedCategoryCap: 0,
      // #7084: keep the fixture self-consistent — a body describing itself as
      // 'stale' is exactly the one a replay produces.
      servedStale: state === 'stale',
      staleAgeSeconds: state === 'stale' ? 1800 : 0,
      staleReason: state === 'stale' ? 'build-error' : '',
      itemsConsidered: itemCount,
      publishersConsidered: 1,
    },
  };
}

async function makeLoader() {
  const updateDigestCoverage = vi.fn();
  const ctx = {
    statusPanel: { updateDigestCoverage, updateFeed: vi.fn(), updateApi: vi.fn() },
    disabledSources: new Set<string>(),
    newsCategoryPanelKeys: new Map<string, string>(),
    newsPanels: {},
    panels: {
      politics: { setSourceCoverage: vi.fn(), setRefreshDegraded: vi.fn() },
      intel: { setSourceCoverage: vi.fn(), setRefreshDegraded: vi.fn() },
    },
    newsByCategory: {},
    currentTimeRange: 'all',
    initialLoadComplete: false,
    allNews: [],
    latestClusters: [],
    latestPredictions: [],
    latestMarkets: [],
    clustersSettled: false,
  } as unknown as AppContext;
  const { DataLoaderManager } = await import('@/app/data-loader');
  const loader = new DataLoaderManager(ctx, {
    renderCriticalBanner: () => undefined,
    refreshOpenCountryBrief: () => undefined,
  });
  const internal = loader as unknown as DigestLoaderInternals;
  internal.persistDigest = vi.fn();
  internal.loadPersistedDigest = vi.fn().mockResolvedValue(null);
  const panels = ctx.panels as unknown as Record<'politics' | 'intel', { setRefreshDegraded: ReturnType<typeof vi.fn> }>;
  return { loader, internal, updateDigestCoverage, panels };
}

describe('digest coverage follows the selected browser response', () => {
  beforeEach(() => {
    mocks.checkBatchForBreakingAlerts.mockReset();
    mocks.clusterNews.mockReset();
    mocks.analyzeCorrelations.mockReset();
    mocks.enqueueSentryCall.mockReset();
    mocks.track.mockReset();
    mocks.isAnalyticsHost.mockReset();
    mocks.isAnalyticsHost.mockReturnValue(true);
    vi.stubGlobal('fetch', vi.fn());
  });

  it('reports a retained digest as stale while the breaker is open', async () => {
    const { internal, updateDigestCoverage } = await makeLoader();
    const retained = digest('complete');
    internal.digestCacheKey = () => 'digest:current';
    internal.lastGoodDigest = { key: 'digest:current', data: retained };
    internal.digestBreaker = {
      state: 'open',
      failures: 2,
      cooldownUntil: Date.now() + 60_000,
    };

    const result = await internal.tryFetchDigest();

    expect(result).toEqual({ digest: retained, servedStale: true });
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(updateDigestCoverage).toHaveBeenCalledOnce();
    expect(updateDigestCoverage).toHaveBeenCalledWith(expect.objectContaining({
      state: 'stale',
      itemsServed: 2,
      feedsCompleted: 2,
    }));
    expect(retained.coverage?.state).toBe('complete');
  });

  it('clears news locations on a successful refresh without located clusters', async () => {
    const { loader, internal } = await makeLoader();
    const ctx = (loader as unknown as { ctx: AppContext }).ctx;
    const setNewsLocations = vi.fn();
    ctx.map = { setNewsLocations, updateHotspotActivity: vi.fn() } as unknown as AppContext['map'];
    ctx.monitors = [];
    internal.resolveEnabledNewsCategories = () => [];
    internal.tryFetchDigest = async () => null;
    internal.loadIntelNews = async () => [];
    internal.clusterNewsForGeneration = async () => ({ clusters: [] });
    setNewsLocations([{ lat: 52.5, lon: 13.4, title: 'Previous headline', threatLevel: 'info' }]);

    await loader.loadNews();

    expect(ctx.clustersSettled).toBe(true);
    expect(setNewsLocations).toHaveBeenLastCalledWith([]);
  });

  describe('a slow digest does not hold the hydration queue (#10323 review)', () => {
    type HydrationInternals = {
      digestFirstPaintGraceMs: number;
      runHydrationTasks(tasks: Array<{ name: string; task: () => Promise<void> }>, forceAll: boolean): Promise<void>;
      newsHydrationTask(forceAll: boolean): Promise<void>;
      wantsNewsHydration(forceAll: boolean): boolean;
      waitForNewsLoad(): Promise<void>;
    };

    async function slowDigestLoader(digestPromise: Promise<SelectedNewsDigest | null>) {
      const made = await makeLoader();
      const ctx = (made.loader as unknown as { ctx: AppContext }).ctx;
      ctx.map = { setNewsLocations: vi.fn(), updateHotspotActivity: vi.fn() } as unknown as AppContext['map'];
      ctx.monitors = [];
      ctx.inFlight = new Set();
      const hydration = made.internal as unknown as HydrationInternals;
      hydration.digestFirstPaintGraceMs = 0;
      made.internal.resolveEnabledNewsCategories = () => [{ key: 'politics', feeds: [{ name: 'Reuters', url: 'https://fixture.test/rss' }], isCustom: false }];
      made.internal.tryFetchDigest = () => digestPromise;
      made.internal.loadNewsCategory = async () => [];
      made.internal.loadIntelNews = async () => [];
      made.internal.clusterNewsForGeneration = async () => ({ clusters: [] });
      const loadNews = vi.spyOn(made.loader, 'loadNews');
      const updateSearchIndex = vi.fn();
      made.loader.updateSearchIndex = updateSearchIndex;
      return { ...made, ctx, hydration, loadNews, updateSearchIndex };
    }

    it('starts the next tier at first paint and still commits the late digest', async () => {
      let resolveDigest!: (value: SelectedNewsDigest | null) => void;
      const { ctx, hydration } = await slowDigestLoader(new Promise((resolve) => { resolveDigest = resolve; }));
      const natural = vi.fn(async () => {});

      await hydration.runHydrationTasks([
        { name: 'news', task: () => hydration.newsHydrationTask(false) },
        { name: 'natural', task: natural },
      ], false);

      // The queue drained while the digest was still pending.
      expect(natural).toHaveBeenCalledOnce();
      expect(ctx.initialLoadComplete).toBe(false);
      expect(ctx.inFlight.has('news')).toBe(true);

      resolveDigest({ digest: digest('complete'), servedStale: false });
      await vi.waitFor(() => expect(ctx.clustersSettled).toBe(true));
      expect(ctx.initialLoadComplete).toBe(true);
      expect(ctx.inFlight.has('news')).toBe(false);
    });

    it('waits for the whole load when the digest arrives within the grace window', async () => {
      const { ctx, hydration } = await slowDigestLoader(Promise.resolve({ digest: digest('complete'), servedStale: false }));
      hydration.digestFirstPaintGraceMs = 1500;

      await hydration.newsHydrationTask(false);

      expect(ctx.clustersSettled).toBe(true);
      expect(ctx.inFlight.has('news')).toBe(false);
    });

    it('replays a request made during the wait once the load ends', async () => {
      let resolveDigest!: (value: SelectedNewsDigest | null) => void;
      const { ctx, hydration, loadNews } = await slowDigestLoader(new Promise((resolve) => { resolveDigest = resolve; }));

      await hydration.newsHydrationTask(false);
      // A forced pass (e.g. a source toggle) arrives while the digest is pending.
      await hydration.newsHydrationTask(true);
      expect(loadNews).toHaveBeenCalledOnce();

      resolveDigest({ digest: digest('complete'), servedStale: false });
      await vi.waitFor(() => expect(loadNews).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(ctx.inFlight.has('news')).toBe(false));
    });

    it('replays a return to the previously loaded work-list made during the wait', async () => {
      const { internal, hydration, loadNews } = await slowDigestLoader(Promise.resolve({ digest: digest('complete'), servedStale: false }));
      const politics = [{ key: 'politics', feeds: [{ name: 'Reuters', url: 'https://fixture.test/rss' }], isCustom: false }];
      const withEnergy = [...politics, { key: 'energy', feeds: [{ name: 'Oil', url: 'https://fixture.test/oil' }], isCustom: false }];

      // Work-list A loads and lands.
      internal.resolveEnabledNewsCategories = () => politics;
      await hydration.newsHydrationTask(false);
      expect(hydration.wantsNewsHydration(false)).toBe(false);

      // The user adds a panel (B); its digest is slow.
      let resolveDigest!: (value: SelectedNewsDigest | null) => void;
      internal.tryFetchDigest = () => new Promise((resolve) => { resolveDigest = resolve; });
      internal.resolveEnabledNewsCategories = () => withEnergy;
      expect(hydration.wantsNewsHydration(false)).toBe(true);
      await hydration.newsHydrationTask(false);

      // They remove it again before B lands. The recorded signature is still
      // A's, so only the running load lets the pass through.
      internal.resolveEnabledNewsCategories = () => politics;
      expect(hydration.wantsNewsHydration(false)).toBe(true);
      await hydration.newsHydrationTask(false);
      expect(loadNews).toHaveBeenCalledTimes(2);

      // B commits B's signature, which no longer matches the panels: replay A.
      internal.tryFetchDigest = async () => ({ digest: digest('complete'), servedStale: false });
      resolveDigest({ digest: digest('complete'), servedStale: false });
      await vi.waitFor(() => expect(loadNews).toHaveBeenCalledTimes(3));
      await hydration.waitForNewsLoad();
      expect(hydration.wantsNewsHydration(false)).toBe(false);
    });

    it('re-indexes search when the late digest commits', async () => {
      let resolveDigest!: (value: SelectedNewsDigest | null) => void;
      const { hydration, updateSearchIndex } = await slowDigestLoader(new Promise((resolve) => { resolveDigest = resolve; }));

      await hydration.newsHydrationTask(false);
      expect(updateSearchIndex).not.toHaveBeenCalled();

      resolveDigest({ digest: digest('complete'), servedStale: false });
      await hydration.waitForNewsLoad();
      expect(updateSearchIndex).toHaveBeenCalledOnce();
    });

    it('does not re-index search for a load the task already waited on', async () => {
      const { hydration, updateSearchIndex } = await slowDigestLoader(Promise.resolve({ digest: digest('complete'), servedStale: false }));
      hydration.digestFirstPaintGraceMs = 1500;

      await hydration.newsHydrationTask(false);

      expect(updateSearchIndex).not.toHaveBeenCalled();
    });

    it('lets headline consumers wait for the late digest and any replay', async () => {
      let resolveDigest!: (value: SelectedNewsDigest | null) => void;
      const { ctx, hydration, loadNews } = await slowDigestLoader(new Promise((resolve) => { resolveDigest = resolve; }));

      await hydration.newsHydrationTask(false);
      await hydration.newsHydrationTask(true);
      let waited = false;
      const wait = hydration.waitForNewsLoad().then(() => { waited = true; });
      await Promise.resolve();
      expect(waited).toBe(false);

      resolveDigest({ digest: digest('complete'), servedStale: false });
      await wait;
      // Both the original load and its forced replay have finished.
      expect(loadNews).toHaveBeenCalledTimes(2);
      expect(ctx.inFlight.has('news')).toBe(false);
    });

    it('does not replay a request whose work-list the finished load already covered', async () => {
      let resolveDigest!: (value: SelectedNewsDigest | null) => void;
      const { ctx, hydration, loadNews } = await slowDigestLoader(new Promise((resolve) => { resolveDigest = resolve; }));

      await hydration.newsHydrationTask(false);
      await hydration.newsHydrationTask(false);

      resolveDigest({ digest: digest('complete'), servedStale: false });
      await vi.waitFor(() => expect(ctx.inFlight.has('news')).toBe(false));
      expect(loadNews).toHaveBeenCalledOnce();
    });
  });

  it('preserves news locations when the news load has no authoritative result', async () => {
    const { loader, internal } = await makeLoader();
    const ctx = (loader as unknown as { ctx: AppContext }).ctx;
    const setNewsLocations = vi.fn();
    ctx.map = { setNewsLocations, updateHotspotActivity: vi.fn() } as unknown as AppContext['map'];
    internal.resolveEnabledNewsCategories = () => [{ key: 'politics', feeds: [{ name: 'Reuters', url: 'https://fixture.test/rss' }], isCustom: false }];
    internal.tryFetchDigest = async () => null;
    internal.loadNewsCategory = async () => [];
    internal.loadIntelNews = async () => [];
    internal.clusterNewsForGeneration = async () => ({ clusters: [] });

    await loader.loadNews();

    expect(ctx.clustersSettled).toBe(true);
    expect(setNewsLocations).not.toHaveBeenCalled();
  });

  it('derives retained item counts when a pre-coverage digest is marked stale', async () => {
    const { internal, updateDigestCoverage } = await makeLoader();
    const retained = digest('complete', 3);
    delete retained.coverage;
    internal.digestCacheKey = () => 'digest:current';
    internal.lastGoodDigest = { key: 'digest:current', data: retained };
    internal.digestBreaker = {
      state: 'open',
      failures: 2,
      cooldownUntil: Date.now() + 60_000,
    };

    const result = await internal.tryFetchDigest();

    expect(result).toEqual({ digest: retained, servedStale: true });
    expect(updateDigestCoverage).toHaveBeenCalledWith(expect.objectContaining({
      state: 'stale',
      itemsServed: 3,
      publisherCount: 3,
      categoriesCompleted: 1,
      categoriesTotal: 1,
    }));
  });

  it('reports unavailable when the open breaker has no current-language fallback', async () => {
    const { internal, updateDigestCoverage } = await makeLoader();
    internal.digestCacheKey = () => 'digest:current';
    internal.digestBreaker = {
      state: 'open',
      failures: 2,
      cooldownUntil: Date.now() + 60_000,
    };

    const result = await internal.tryFetchDigest();

    expect(result).toBeNull();
    expect(updateDigestCoverage).toHaveBeenCalledWith(expect.objectContaining({
      state: 'unavailable',
      itemsServed: 0,
      feedsCompleted: 0,
    }));
  });

  it('reports the retained digest as stale after a fetch failure', async () => {
    const { internal, updateDigestCoverage } = await makeLoader();
    const retained = digest('complete', 3);
    internal.digestCacheKey = () => 'digest:current';
    internal.lastGoodDigest = { key: 'digest:current', data: retained };
    vi.mocked(globalThis.fetch).mockRejectedValueOnce(new Error('network down'));

    const result = await internal.tryFetchDigest();

    expect(result).toEqual({ digest: retained, servedStale: true });
    expect(updateDigestCoverage).toHaveBeenCalledOnce();
    expect(updateDigestCoverage).toHaveBeenCalledWith(expect.objectContaining({
      state: 'stale',
      itemsServed: 3,
      // The server never failed: the browser's request did.
      staleCause: 'device',
    }));
  });

  describe('the browser fallback reports to Sentry', () => {
    function captured(): Array<{ message: string; ctx: { level: string; tags: Record<string, string>; fingerprint: string[] } }> {
      return mocks.enqueueSentryCall.mock.calls.map(([fn]) => {
        const captureMessage = vi.fn();
        (fn as (s: unknown) => void)({ captureMessage });
        const [message, ctx] = captureMessage.mock.calls[0]!;
        return { message, ctx };
      });
    }

    it('reports a failure that left the panels empty with its kind, fallback and fingerprint', async () => {
      const { internal } = await makeLoader();
      internal.digestCacheKey = () => 'digest:current';
      // Both attempts stall and there is no copy to show.
      vi.mocked(globalThis.fetch)
        .mockRejectedValueOnce(new DOMException('signal timed out', 'TimeoutError'))
        .mockRejectedValueOnce(new DOMException('signal timed out', 'TimeoutError'));

      await internal.tryFetchDigest();

      const events = captured();
      expect(events).toHaveLength(1);
      expect(events[0]!.message).toBe('News digest fetch failed');
      expect(events[0]!.ctx.level).toBe('warning');
      expect(events[0]!.ctx.tags).toMatchObject({ 'digest.failure': 'timeout', 'digest.fallback': 'none', 'digest.retry': 'failed' });
      expect(events[0]!.ctx.fingerprint).toEqual(['news-digest-fetch', 'timeout']);
      expect(mocks.track).not.toHaveBeenCalled();
    });

    // Sentry WORLDMONITOR-1D4: 94% of its events had news on screen. Those are
    // a rate, so they are counted in analytics and never open a Sentry issue.
    describe('a failure with news still on screen is counted, not reported', () => {
      it('a retained copy', async () => {
        const { internal } = await makeLoader();
        internal.digestCacheKey = () => 'digest:current';
        internal.lastGoodDigest = { key: 'digest:current', data: digest('complete', 3) };
        vi.mocked(globalThis.fetch).mockRejectedValueOnce(new DOMException('signal timed out', 'TimeoutError'));

        await internal.tryFetchDigest();

        expect(captured()).toHaveLength(0);
        expect(mocks.track).toHaveBeenCalledOnce();
        expect(mocks.track).toHaveBeenCalledWith('news-digest-degraded', {
          outcome: 'retained',
          failure: 'timeout',
          variant: expect.any(String),
        });
      });

      it('a saved copy', async () => {
        const { internal } = await makeLoader();
        internal.digestCacheKey = () => 'digest:current';
        internal.loadPersistedDigest = vi.fn().mockResolvedValue(digest('complete', 3));
        vi.mocked(globalThis.fetch).mockRejectedValueOnce(new TypeError('Failed to fetch'));

        await internal.tryFetchDigest();

        expect(captured()).toHaveLength(0);
        expect(mocks.track).toHaveBeenCalledWith('news-digest-degraded', expect.objectContaining({ outcome: 'saved', failure: 'network' }));
      });

      it('a retry that recovered', async () => {
        const { internal } = await makeLoader();
        internal.digestCacheKey = () => 'digest:current';
        vi.mocked(globalThis.fetch)
          .mockRejectedValueOnce(new DOMException('signal timed out', 'TimeoutError'))
          .mockResolvedValueOnce(new Response(JSON.stringify(digest('complete', 3))));

        await internal.tryFetchDigest();

        expect(captured()).toHaveLength(0);
        expect(mocks.track).toHaveBeenCalledWith('news-digest-degraded', expect.objectContaining({ outcome: 'recovered', failure: 'timeout' }));
      });
    });

    // Codex review: the tracker disables itself on tech, commodity, energy and
    // self-hosted origins, so a count sent there is dropped. Keep Sentry.
    it('keeps reporting to Sentry on a host the analytics tracker is disabled on', async () => {
      mocks.isAnalyticsHost.mockReturnValue(false);
      const { internal } = await makeLoader();
      internal.digestCacheKey = () => 'digest:current';
      internal.lastGoodDigest = { key: 'digest:current', data: digest('complete', 3) };
      vi.mocked(globalThis.fetch).mockRejectedValueOnce(new DOMException('signal timed out', 'TimeoutError'));

      await internal.tryFetchDigest();

      expect(mocks.track).not.toHaveBeenCalled();
      expect(captured()).toHaveLength(1);
      expect(captured()[0]!.ctx.tags).toMatchObject({ 'digest.failure': 'timeout', 'digest.fallback': 'retained' });
    });

    // Greptile review: a copy with no stories puts nothing on screen.
    it('treats a retained or saved copy with no stories as empty panels', async () => {
      const { internal } = await makeLoader();
      internal.digestCacheKey = () => 'digest:current';
      internal.lastGoodDigest = { key: 'digest:current', data: { ...digest('complete', 3), categories: { world: { items: [] } } } };
      vi.mocked(globalThis.fetch).mockRejectedValueOnce(new DOMException('signal timed out', 'TimeoutError'));

      await internal.tryFetchDigest();

      expect(mocks.track).not.toHaveBeenCalled();
      expect(captured()).toHaveLength(1);
      expect(captured()[0]!.ctx.tags).toMatchObject({ 'digest.fallback': 'none' });
    });

    // CodeRabbit review: a recovered stall counted in analytics must not use up
    // the Sentry slot for a later failure of the same kind that blanks the panels.
    it('a counted degradation does not suppress a later empty-panel report of the same kind', async () => {
      const { internal } = await makeLoader();
      internal.digestCacheKey = () => 'digest:current';
      vi.mocked(globalThis.fetch)
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockResolvedValueOnce(new Response(JSON.stringify(digest('complete', 3))));
      await internal.tryFetchDigest();
      expect(mocks.track).toHaveBeenCalledWith('news-digest-degraded', expect.objectContaining({ outcome: 'recovered', failure: 'network' }));
      expect(captured()).toHaveLength(0);

      // The user switches to a language with no saved copy, and both requests fail.
      internal.digestCacheKey = () => 'digest:other-language';
      vi.mocked(globalThis.fetch)
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockRejectedValueOnce(new TypeError('Failed to fetch'));
      await internal.tryFetchDigest();

      expect(captured()).toHaveLength(1);
      expect(captured()[0]!.ctx.tags).toMatchObject({ 'digest.failure': 'network', 'digest.fallback': 'none', 'digest.retry': 'failed' });
    });

    // CodeRabbit review: the zero-category check counts keys, so a retry can
    // succeed with categories that hold no stories. Panels stay empty.
    it('a retry that answers with no stories is reported as failed, not recovered', async () => {
      const { internal } = await makeLoader();
      internal.digestCacheKey = () => 'digest:current';
      vi.mocked(globalThis.fetch)
        .mockRejectedValueOnce(new DOMException('signal timed out', 'TimeoutError'))
        .mockResolvedValueOnce(new Response(JSON.stringify({ ...digest('complete', 3), categories: { world: { items: [] } } })));

      await internal.tryFetchDigest();

      expect(mocks.track).not.toHaveBeenCalled();
      expect(captured()).toHaveLength(1);
      expect(captured()[0]!.ctx.tags).toMatchObject({ 'digest.failure': 'timeout', 'digest.fallback': 'none', 'digest.retry': 'failed' });
    });

    it('knows which hosts the analytics tracker runs on', async () => {
      const actual = await vi.importActual<typeof import('@/services/analytics')>('@/services/analytics');
      for (const host of ['worldmonitor.app', 'www.worldmonitor.app', 'happy.worldmonitor.app', 'finance.worldmonitor.app']) {
        expect(actual.isAnalyticsHost(host), host).toBe(true);
      }
      for (const host of ['tech.worldmonitor.app', 'commodity.worldmonitor.app', 'energy.worldmonitor.app', 'self-host.example', '']) {
        expect(actual.isAnalyticsHost(host), host).toBe(false);
      }
    });

    it('reads whether a digest carries a story', async () => {
      const { digestHasItems } = await import('@/app/data-loader');
      expect(digestHasItems(null)).toBe(false);
      expect(digestHasItems({ ...digest('complete', 3), categories: {} })).toBe(false);
      expect(digestHasItems({ ...digest('complete', 3), categories: { world: { items: [] } } })).toBe(false);
      expect(digestHasItems(digest('complete', 3))).toBe(true);
    });

    it('classifies the outcome from what was left on screen', async () => {
      const { digestFailureOutcome } = await import('@/app/data-loader');
      expect(digestFailureOutcome('retained', 'none')).toBe('retained');
      expect(digestFailureOutcome('saved', 'failed')).toBe('saved');
      expect(digestFailureOutcome('none', 'recovered')).toBe('recovered');
      expect(digestFailureOutcome('none', 'failed')).toBe('empty');
      expect(digestFailureOutcome('none', 'none')).toBe('empty');
    });

    it('waits as long as the server is allowed to take (Sentry WORLDMONITOR-1D4)', async () => {
      // The server answers a cold rebuild by RESPONSE_DEADLINE_MS. A shorter
      // client deadline throws away digests the server was still delivering:
      // in production, 8.3-8.7 s server responses landed just after the
      // browser's 8 s deadline, and users with no saved copy saw empty panels.
      const { __testing__ } = await import('../../server/worldmonitor/news/v1/list-feed-digest');
      const { internal } = await makeLoader();
      internal.digestCacheKey = () => 'digest:current';
      const timeout = vi.spyOn(AbortSignal, 'timeout');
      vi.mocked(globalThis.fetch).mockImplementation(async () => new Response(JSON.stringify(digest('complete', 3))));

      // Each method mints its own deadline before publicRpcFetch adds its 30 s
      // transport cap, so the FIRST timeout of each request is the caller's.
      // Checking per method keeps the transport cap from standing in for a
      // deadline a method stopped setting.
      const callerDeadline = async (request: () => Promise<unknown>): Promise<number[]> => {
        timeout.mockClear();
        expect(await request()).not.toBeNull();
        return timeout.mock.calls.map(([ms]) => ms);
      };
      let home: number[];
      let edition: number[];
      try {
        home = await callerDeadline(() => internal.tryFetchDigest());
        edition = await callerDeadline(() => internal.fetchEditionDigest('tech', 'en'));
      } finally {
        timeout.mockRestore();
      }

      for (const calls of [home, edition]) {
        expect(calls).toHaveLength(2);
        // The request aborts at the shorter of the two, so both must outlast the server.
        expect(calls[0]).toBeGreaterThan(__testing__.RESPONSE_DEADLINE_MS);
        expect(calls[1]).toBeGreaterThan(__testing__.RESPONSE_DEADLINE_MS);
      }
    });

    it('counts a WebKit deadline abort as a timeout, not "other" (Sentry WORLDMONITOR-1D5)', async () => {
      // Safari and every iOS browser reject the fetch with `AbortError: Fetch is
      // aborted` when AbortSignal.timeout fires, never `TimeoutError`, so the
      // name alone filed one condition under two Sentry issues.
      const { internal } = await makeLoader();
      internal.digestCacheKey = () => 'digest:current';
      const expired = AbortSignal.abort(new DOMException('signal timed out', 'TimeoutError'));
      const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(expired);
      // No copy to show, so the retry runs too and the failure is an incident.
      vi.mocked(globalThis.fetch)
        .mockRejectedValueOnce(new DOMException('Fetch is aborted', 'AbortError'))
        .mockRejectedValueOnce(new DOMException('Fetch is aborted', 'AbortError'));

      try {
        await internal.tryFetchDigest();
      } finally {
        timeout.mockRestore();
      }

      const events = captured();
      expect(events).toHaveLength(1);
      expect(events[0]!.ctx.tags).toMatchObject({ 'digest.failure': 'timeout', 'digest.error': 'AbortError' });
      expect(events[0]!.ctx.fingerprint).toEqual(['news-digest-fetch', 'timeout']);
    });

    it('keeps an abort the deadline did not cause out of the timeout bucket, and names it', async () => {
      const { internal } = await makeLoader();
      internal.digestCacheKey = () => 'digest:current';
      vi.mocked(globalThis.fetch).mockRejectedValueOnce(new DOMException('The operation was aborted.', 'AbortError'));

      await internal.tryFetchDigest();

      expect(captured()[0]!.ctx.tags).toMatchObject({ 'digest.failure': 'other', 'digest.error': 'AbortError' });
    });

    it('judges the deadline when the request failed, not after the fallback read', async () => {
      // An unrelated abort fails the request early; the saved-digest read then
      // runs long enough for the deadline to fire. That is still not a timeout.
      const { internal } = await makeLoader();
      internal.digestCacheKey = () => 'digest:current';
      const deadline = new AbortController();
      const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
      internal.loadPersistedDigest = async () => {
        deadline.abort(new DOMException('signal timed out', 'TimeoutError'));
        return null;
      };
      vi.mocked(globalThis.fetch).mockRejectedValueOnce(new DOMException('The operation was aborted.', 'AbortError'));

      try {
        await internal.tryFetchDigest();
      } finally {
        timeout.mockRestore();
      }

      expect(captured()[0]!.ctx.tags).toMatchObject({ 'digest.failure': 'other', 'digest.error': 'AbortError' });
    });

    it('names the error behind an "other" failure so the bucket can be read', async () => {
      const { internal } = await makeLoader();
      internal.digestCacheKey = () => 'digest:current';
      vi.mocked(globalThis.fetch).mockResolvedValueOnce(new Response('{"truncated', { status: 200 }));

      await internal.tryFetchDigest();

      expect(captured()[0]!.ctx.tags).toMatchObject({ 'digest.failure': 'other', 'digest.error': 'SyntaxError' });
    });

    it('classifies an HTTP 5xx and reports when nothing could be shown', async () => {
      const { internal } = await makeLoader();
      internal.digestCacheKey = () => 'digest:current';
      vi.mocked(globalThis.fetch).mockResolvedValueOnce(new Response('', { status: 503 }));

      await internal.tryFetchDigest();

      expect(captured()[0]!.ctx.tags).toMatchObject({ 'digest.failure': 'http-5xx', 'digest.fallback': 'none' });
    });

    // Sentry WORLDMONITOR-1DE: a 4xx that left no gateway telemetry. The kind
    // alone could not say which status it was or whether Vercel answered at all.
    describe('names the status and who answered an HTTP failure', () => {
      async function reportFor(response: Response): Promise<Record<string, string>> {
        const { internal } = await makeLoader();
        internal.digestCacheKey = () => 'digest:current';
        vi.mocked(globalThis.fetch).mockResolvedValueOnce(response);
        await internal.tryFetchDigest();
        return captured()[0]!.ctx.tags;
      }

      it('a response Vercel served', async () => {
        const tags = await reportFor(new Response('', { status: 401, headers: { 'x-vercel-id': 'fra1::abc' } }));
        expect(tags).toMatchObject({ 'digest.failure': 'http-4xx', 'digest.status': '401', 'digest.responder': 'vercel' });
      });

      it('a Cloudflare challenge', async () => {
        const tags = await reportFor(new Response('', { status: 403, headers: { 'cf-mitigated': 'challenge' } }));
        expect(tags).toMatchObject({ 'digest.status': '403', 'digest.responder': 'cloudflare-challenge' });
      });

      it('a readable response Vercel never saw', async () => {
        const tags = await reportFor(new Response('', { status: 429 }));
        expect(tags).toMatchObject({ 'digest.status': '429', 'digest.responder': 'not-vercel' });
      });

      it('a cross-origin response, whose Vercel header the browser hides', async () => {
        const response = new Response('', { status: 403 });
        Object.defineProperty(response, 'type', { value: 'cors' });
        const tags = await reportFor(response);
        expect(tags).toMatchObject({ 'digest.status': '403', 'digest.responder': 'cross-origin' });
      });

      it('leaves both tags off a failure that had no response', async () => {
        const { internal } = await makeLoader();
        internal.digestCacheKey = () => 'digest:current';
        vi.mocked(globalThis.fetch)
          .mockRejectedValueOnce(new TypeError('Failed to fetch'))
          .mockRejectedValueOnce(new TypeError('Failed to fetch'));
        await internal.tryFetchDigest();
        const tags = captured()[0]!.ctx.tags;
        expect(tags['digest.failure']).toBe('network');
        expect(tags).not.toHaveProperty('digest.status');
        expect(tags).not.toHaveProperty('digest.responder');
      });
    });

    it('reports each failure kind once per page, not on every refresh', async () => {
      const { internal } = await makeLoader();
      internal.digestCacheKey = () => 'digest:current';
      internal.lastGoodDigest = { key: 'digest:current', data: digest('complete', 3) };
      vi.mocked(globalThis.fetch)
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockRejectedValueOnce(new TypeError('Failed to fetch'));

      await internal.tryFetchDigest();
      await internal.tryFetchDigest();

      expect(captured()).toHaveLength(0);
      expect(mocks.track).toHaveBeenCalledOnce();
      expect(mocks.track).toHaveBeenCalledWith('news-digest-degraded', expect.objectContaining({ failure: 'network' }));
    });

    // Sentry WORLDMONITOR-1D4 after the 25 s deadline shipped: the server had
    // answered every digest in under 20 s, and most timed-out requests never
    // reached the origin at all (the CDN serves this route). A request that
    // stalls on the way left a browser with no saved copy showing empty news
    // until the next refresh, 10 minutes later. One immediate retry covers it.
    describe('a stalled first request with nothing to show', () => {
      it('retries once and renders the retry', async () => {
        const { internal } = await makeLoader();
        internal.digestCacheKey = () => 'digest:current';
        const fresh = digest('complete', 3);
        vi.mocked(globalThis.fetch)
          .mockRejectedValueOnce(new DOMException('signal timed out', 'TimeoutError'))
          .mockResolvedValueOnce(new Response(JSON.stringify(fresh)));

        const result = await internal.tryFetchDigest();

        expect(globalThis.fetch).toHaveBeenCalledTimes(2);
        expect(result).toEqual({ digest: fresh, servedStale: false });
        expect(internal.persistDigest).toHaveBeenCalledWith('digest:current', fresh);
        expect(internal.digestBreaker).toMatchObject({ state: 'closed', failures: 0 });
        // The stall still happened, so it is counted, but news rendered: no Sentry issue.
        expect(captured()).toHaveLength(0);
        expect(mocks.track).toHaveBeenCalledWith('news-digest-degraded', expect.objectContaining({
          outcome: 'recovered',
          failure: 'timeout',
        }));
      });

      it('gives up after the retry fails and reports both attempts as one event', async () => {
        const { internal } = await makeLoader();
        internal.digestCacheKey = () => 'digest:current';
        vi.mocked(globalThis.fetch)
          .mockRejectedValueOnce(new DOMException('signal timed out', 'TimeoutError'))
          .mockRejectedValueOnce(new TypeError('Failed to fetch'));

        const result = await internal.tryFetchDigest();

        expect(globalThis.fetch).toHaveBeenCalledTimes(2);
        expect(result).toBeNull();
        // Two real failures: the breaker counts both.
        expect(internal.digestBreaker.state).toBe('open');
        const events = captured();
        expect(events).toHaveLength(1);
        expect(events[0]!.ctx.tags).toMatchObject({
          'digest.failure': 'timeout',
          'digest.fallback': 'none',
          'digest.retry': 'failed',
          'digest.retry.failure': 'network',
        });
      });

      it('retries a CDN 5xx as well', async () => {
        const { internal } = await makeLoader();
        internal.digestCacheKey = () => 'digest:current';
        vi.mocked(globalThis.fetch)
          .mockResolvedValueOnce(new Response('', { status: 522 }))
          .mockResolvedValueOnce(new Response(JSON.stringify(digest('complete', 3))));

        expect(await internal.tryFetchDigest()).not.toBeNull();
        expect(globalThis.fetch).toHaveBeenCalledTimes(2);
      });

      it('does not retry when a copy is on screen to fall back to', async () => {
        const { internal } = await makeLoader();
        internal.digestCacheKey = () => 'digest:current';
        internal.lastGoodDigest = { key: 'digest:current', data: digest('complete', 3) };
        vi.mocked(globalThis.fetch).mockRejectedValueOnce(new DOMException('signal timed out', 'TimeoutError'));

        await internal.tryFetchDigest();

        expect(globalThis.fetch).toHaveBeenCalledOnce();
        expect(mocks.track).toHaveBeenCalledWith('news-digest-degraded', expect.objectContaining({ outcome: 'retained' }));
      });

      it('does not retry when a saved copy exists', async () => {
        const { internal } = await makeLoader();
        internal.digestCacheKey = () => 'digest:current';
        internal.loadPersistedDigest = vi.fn().mockResolvedValue(digest('complete', 3));
        vi.mocked(globalThis.fetch).mockRejectedValueOnce(new TypeError('Failed to fetch'));

        await internal.tryFetchDigest();

        expect(globalThis.fetch).toHaveBeenCalledOnce();
      });

      it('does not retry a failure a second request would repeat', async () => {
        const { internal } = await makeLoader();
        internal.digestCacheKey = () => 'digest:current';
        vi.mocked(globalThis.fetch).mockResolvedValueOnce(new Response('', { status: 404 }));

        await internal.tryFetchDigest();

        expect(globalThis.fetch).toHaveBeenCalledOnce();
      });

      it('does not retry while the breaker is probing a recovery', async () => {
        const { internal } = await makeLoader();
        internal.digestCacheKey = () => 'digest:current';
        internal.digestBreaker = { state: 'open', failures: 2, cooldownUntil: 0 };
        vi.mocked(globalThis.fetch).mockRejectedValueOnce(new TypeError('Failed to fetch'));

        await internal.tryFetchDigest();

        expect(globalThis.fetch).toHaveBeenCalledOnce();
      });

      it('does not retry while the browser reports itself offline', async () => {
        const { internal } = await makeLoader();
        internal.digestCacheKey = () => 'digest:current';
        const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
        vi.mocked(globalThis.fetch).mockRejectedValueOnce(new TypeError('Failed to fetch'));

        try {
          await internal.tryFetchDigest();
        } finally {
          online.mockRestore();
        }

        expect(globalThis.fetch).toHaveBeenCalledOnce();
      });
    });

    it('stays quiet while the browser reports itself offline', async () => {
      const { internal } = await makeLoader();
      internal.digestCacheKey = () => 'digest:current';
      const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
      vi.mocked(globalThis.fetch).mockRejectedValueOnce(new TypeError('Failed to fetch'));

      await internal.tryFetchDigest();

      online.mockRestore();
      expect(mocks.enqueueSentryCall).not.toHaveBeenCalled();
    });
  });

  it('attributes a server replay to the server and carries the considered pool', async () => {
    const { internal, updateDigestCoverage } = await makeLoader();
    const replay = digest('stale', 3);
    replay.coverage = { ...replay.coverage!, itemsConsidered: 40, publishersConsidered: 12 };
    internal.digestCacheKey = () => 'digest:current';
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response(JSON.stringify(replay), { status: 200, headers: { 'content-type': 'application/json' } }),
    );

    await internal.tryFetchDigest();

    expect(updateDigestCoverage).toHaveBeenCalledWith(expect.objectContaining({
      state: 'stale',
      staleCause: 'server',
      staleReason: 'build-error',
      contentAgeSeconds: 1800,
      itemsConsidered: 40,
      publishersConsidered: 12,
    }));
  });

  it('dates a device copy from its content generatedAt', async () => {
    const { internal, updateDigestCoverage } = await makeLoader();
    const retained = digest('complete', 3);
    retained.generatedAt = new Date(Date.now() - 600_000).toISOString();
    internal.digestCacheKey = () => 'digest:current';
    internal.lastGoodDigest = { key: 'digest:current', data: retained };
    vi.mocked(globalThis.fetch).mockRejectedValueOnce(new Error('timeout'));

    await internal.tryFetchDigest();

    const summary = updateDigestCoverage.mock.calls[0]![0] as { contentAgeSeconds: number };
    expect(summary.contentAgeSeconds).toBeGreaterThanOrEqual(599);
    expect(summary.contentAgeSeconds).toBeLessThan(620);
  });

  it('does not report a fresh digest discarded by an in-flight language switch', async () => {
    const { internal, updateDigestCoverage } = await makeLoader();
    const fresh = digest('complete', 4);
    const retained = digest('partial', 1);
    let currentKey = 'digest:requested';
    internal.digestCacheKey = (language?: string) => language ? 'digest:requested' : currentKey;
    internal.lastGoodDigest = { key: 'digest:current', data: retained };

    let resolveFetch!: (response: Response) => void;
    vi.mocked(globalThis.fetch).mockImplementationOnce(() => new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    }));

    const pending = internal.tryFetchDigest();
    currentKey = 'digest:current';
    resolveFetch(new Response(JSON.stringify(fresh), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    const result = await pending;

    expect(result).toEqual({ digest: retained, servedStale: true });
    expect(updateDigestCoverage).toHaveBeenCalledOnce();
    expect(updateDigestCoverage).toHaveBeenCalledWith(expect.objectContaining({
      state: 'stale',
      itemsServed: 1,
      // The service answered; the answer was for the previous language.
      staleCause: 'switching',
    }));
    expect(updateDigestCoverage).not.toHaveBeenCalledWith(expect.objectContaining({
      state: 'complete',
      itemsServed: 4,
    }));
    expect(mocks.enqueueSentryCall).not.toHaveBeenCalled();
  });

  it('a late stale load cannot replace or alert over a newer fresh commit (#7084)', async () => {
    const { internal } = await makeLoader();
    const staleGeneration = internal.beginNewsLoad();
    const staleCompletion = Promise.resolve().then(() => (
      internal.commitNewsFreshness(staleGeneration, true)
    ));
    const freshGeneration = internal.beginNewsLoad();

    expect(internal.commitNewsFreshness(freshGeneration, false)).toBe(true);
    expect(await staleCompletion).toBe(false);
    expect(internal.canNotifyForCommittedNews(freshGeneration, false)).toBe(true);
    expect(internal.canNotifyForCommittedNews(staleGeneration, true)).toBe(false);
  });

  it('a late obsolete-language response cannot re-mute newer fresh news (#7084)', async () => {
    const { internal } = await makeLoader();
    let currentKey = 'digest:requested';
    internal.digestCacheKey = (language?: string) => language ? 'digest:requested' : currentKey;
    internal.lastGoodDigest = { key: 'digest:current', data: digest('partial', 1) };

    let resolveFetch!: (response: Response) => void;
    vi.mocked(globalThis.fetch).mockImplementationOnce(() => new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    }));
    const obsoleteGeneration = internal.beginNewsLoad();
    const obsoleteSelection = internal.tryFetchDigest();

    currentKey = 'digest:current';
    const freshGeneration = internal.beginNewsLoad();
    expect(internal.commitNewsFreshness(freshGeneration, false)).toBe(true);

    resolveFetch(new Response(JSON.stringify(digest('complete', 4)), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    const selected = await obsoleteSelection;
    expect(selected?.servedStale).toBe(true);
    expect(internal.commitNewsFreshness(obsoleteGeneration, selected?.servedStale ?? false)).toBe(false);
    expect(internal.canNotifyForCommittedNews(freshGeneration, false)).toBe(true);
  });

  it('a superseded correlation clustering pass cannot replace current clusters (#7782)', async () => {
    const { loader, internal } = await makeLoader();
    const ctx = (loader as unknown as { ctx: AppContext }).ctx;
    ctx.allNews = [{
      source: 'Reuters',
      title: 'Fixture event',
      link: 'https://fixture.test/event',
      pubDate: new Date('2026-09-06T12:00:00.000Z'),
      isAlert: false,
    }];

    const committedGeneration = internal.beginNewsLoad();
    expect(internal.commitNewsFreshness(committedGeneration, false)).toBe(true);
    const staleCluster: ClusteredEvent = {
      id: 'stale-cluster',
      primaryTitle: 'Fixture event',
      primarySource: 'Reuters',
      primaryLink: 'https://fixture.test/event',
      sourceCount: 1,
      uniquePublisherCount: 1,
      topSources: [{ name: 'Reuters', tier: 1, url: 'https://fixture.test/event' }],
      allItems: ctx.allNews,
      firstSeen: ctx.allNews[0]!.pubDate,
      lastUpdated: ctx.allNews[0]!.pubDate,
      isAlert: false,
    };
    let resolveClusters!: (clusters: ClusteredEvent[]) => void;
    mocks.clusterNews.mockImplementationOnce(() => new Promise<ClusteredEvent[]>((resolve) => {
      resolveClusters = resolve;
    }));

    const pending = internal.runCorrelationAnalysis();
    internal.beginNewsLoad();
    resolveClusters([staleCluster]);
    await pending;

    expect(ctx.latestClusters).toEqual([]);
    expect(ctx.clustersSettled).toBe(false);
    expect(mocks.analyzeCorrelations).not.toHaveBeenCalled();
  });

  it('keeps local clusters when the ML-off analysis worker is unavailable (#7782)', async () => {
    const { loader, internal } = await makeLoader();
    const ctx = (loader as unknown as { ctx: AppContext }).ctx;
    ctx.allNews = [{
      source: 'Reuters',
      title: 'Fixture event',
      link: 'https://fixture.test/event',
      pubDate: new Date('2026-09-06T12:00:00.000Z'),
      isAlert: false,
    }];

    const generation = internal.beginNewsLoad();
    expect(internal.commitNewsFreshness(generation, false)).toBe(true);
    mocks.clusterNews.mockResolvedValueOnce([]);
    mocks.analyzeCorrelations.mockResolvedValueOnce([]);

    await internal.runCorrelationAnalysis();

    expect(ctx.latestClusters).toHaveLength(1);
    expect(ctx.latestClusters[0]?.primaryTitle).toBe('Fixture event');
    expect(ctx.clustersSettled).toBe(true);
    expect(mocks.analyzeCorrelations).toHaveBeenCalledWith(
      ctx.latestClusters,
      ctx.latestPredictions,
      ctx.latestMarkets,
    );
  });

  it.each(['retained', 'persisted'] as const)(
    'a %s fallback cannot run direct breaking-alert checks (#7084)',
    async (fallbackKind) => {
      const { internal } = await makeLoader();
      const fallback = digest('complete', 1);
      internal.digestCacheKey = () => 'digest:current';
      if (fallbackKind === 'retained') {
        internal.lastGoodDigest = { key: 'digest:current', data: fallback };
      } else {
        internal.loadPersistedDigest = vi.fn().mockResolvedValue(fallback);
      }
      vi.mocked(globalThis.fetch).mockRejectedValueOnce(new Error('network down'));
      const selected = await internal.tryFetchDigest();
      const generation = internal.beginNewsLoad();

      await internal.loadNewsCategory(
        'politics',
        [{ name: 'source-0' }],
        selected,
        false,
        { recordBaselineSample: false },
        generation,
      );

      expect(selected?.servedStale).toBe(true);
      expect(mocks.checkBatchForBreakingAlerts).not.toHaveBeenCalled();
    },
  );

  it('a stale replay renders but is not persisted as the client last-good (#7084)', async () => {
    const { internal } = await makeLoader();
    internal.digestCacheKey = () => 'digest:current';

    vi.mocked(globalThis.fetch).mockResolvedValueOnce(new Response(JSON.stringify(digest('stale')), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    const served = await internal.tryFetchDigest();

    expect(served?.digest.coverage?.state).toBe('stale');
    expect(served?.servedStale).toBe(true);
    expect(internal.persistDigest).not.toHaveBeenCalled();
  });

  describe('the LIVE/CACHED badge follows the selected digest', () => {
    function respond(body: ListFeedDigestResponse): void {
      vi.mocked(globalThis.fetch).mockResolvedValueOnce(new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    }

    function withIntel(body: ListFeedDigestResponse): ListFeedDigestResponse {
      const items = body.categories.politics!.items.map(item => ({ ...item, source: INTEL_SOURCES[0]!.name }));
      return { ...body, categories: { ...body.categories, intel: { items } } };
    }

    async function selectHomeDigest(kind: 'fresh' | 'server-stale' | 'retained' | 'persisted') {
      const { internal, panels } = await makeLoader();
      internal.digestCacheKey = () => 'digest:current';
      if (kind === 'fresh') respond(withIntel(digest('complete')));
      if (kind === 'server-stale') respond(withIntel(digest('stale')));
      if (kind === 'retained') {
        internal.lastGoodDigest = { key: 'digest:current', data: withIntel(digest('complete')) };
        vi.mocked(globalThis.fetch).mockRejectedValueOnce(new Error('network down'));
      }
      if (kind === 'persisted') {
        internal.loadPersistedDigest = vi.fn().mockResolvedValue(withIntel(digest('complete')));
        vi.mocked(globalThis.fetch).mockRejectedValueOnce(new Error('network down'));
      }
      const selected = await internal.tryFetchDigest();
      return { internal, panels, selected, generation: internal.beginNewsLoad() };
    }

    it.each([
      ['fresh', false],
      ['server-stale', true],
      ['retained', true],
      ['persisted', true],
    ] as const)('a %s home digest marks the category panel cached=%s', async (kind, cached) => {
      const { internal, panels, selected, generation } = await selectHomeDigest(kind);

      await internal.loadNewsCategory('politics', [{ name: 'source-0' }], selected, false, { recordBaselineSample: false }, generation);

      expect(panels.politics.setRefreshDegraded).toHaveBeenLastCalledWith(cached);
    });

    it.each([
      ['fresh', false],
      ['server-stale', true],
      ['retained', true],
      ['persisted', true],
    ] as const)('a %s home digest marks the intel panel cached=%s', async (kind, cached) => {
      const { internal, panels, selected, generation } = await selectHomeDigest(kind);

      const intel = await internal.loadIntelNews(selected, { recordBaselineSample: false }, generation);

      expect(intel).toHaveLength(2);
      expect(panels.intel.setRefreshDegraded).toHaveBeenLastCalledWith(cached);
    });

    it('returns a cached panel to LIVE once a fresh digest arrives', async () => {
      const { internal, panels } = await makeLoader();
      internal.digestCacheKey = () => 'digest:current';

      respond(digest('stale'));
      const stale = await internal.tryFetchDigest();
      await internal.loadNewsCategory('politics', [{ name: 'source-0' }], stale, false, { recordBaselineSample: false }, internal.beginNewsLoad());
      expect(panels.politics.setRefreshDegraded).toHaveBeenLastCalledWith(true);

      respond(digest('complete'));
      const fresh = await internal.tryFetchDigest();
      await internal.loadNewsCategory('politics', [{ name: 'source-0' }], fresh, false, { recordBaselineSample: false }, internal.beginNewsLoad());
      expect(panels.politics.setRefreshDegraded).toHaveBeenLastCalledWith(false);
    });
  });
});
