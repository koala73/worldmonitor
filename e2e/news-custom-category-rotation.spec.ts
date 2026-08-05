import { expect, test } from '@playwright/test';

test('custom news rotation persists, accumulates, survives lazy mount, and reports failed refreshes', async ({ page }) => {
  await page.goto('/tests/runtime-harness.html');

  const result = await page.evaluate(async () => {
    const [{ DataLoaderManager }, { NewsPanel }, { replayPendingCalls }] = await Promise.all([
      import('/src/app/data-loader.ts'),
      import('/src/components/NewsPanel.ts'),
      import('/src/app/pending-panel-data.ts'),
    ]);

    type Feed = { name: string; url: string; lang?: string };
    type NewsItem = {
      source: string;
      title: string;
      link: string;
      pubDate: Date;
      isAlert: boolean;
    };
    type LoadCategory = (
      category: string,
      feeds: Feed[],
      digest: null,
      isCustom: boolean,
      options: { allowDigestPendingFallback: boolean; recordBaselineSample: boolean },
    ) => Promise<NewsItem[]>;

    const originalFetch = window.fetch.bind(window);
    const requestedTargets: string[] = [];
    const sourceByTarget = new Map<string, string>();
    const now = Date.now();

    const makeFeeds = (prefix: string, count: number): Feed[] =>
      Array.from({ length: count }, (_, index) => {
        const target = `https://rotation.test/${prefix}-${index}.xml`;
        const name = `${prefix}-${index}`;
        sourceByTarget.set(target, name);
        return {
          name,
          lang: 'en',
          url: `/api/rss-proxy?url=${encodeURIComponent(target)}`,
        };
      });

    window.fetch = (async (input: RequestInfo | URL) => {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const url = new URL(raw, window.location.origin);
      if (url.pathname !== '/api/rss-proxy') return new Response('{}', { status: 200 });

      const target = url.searchParams.get('url') ?? '';
      requestedTargets.push(target);
      if (target.includes('/failed-')) return new Response('upstream failed', { status: 503 });

      const source = sourceByTarget.get(target) ?? 'unknown';
      const isOutsideRange = source === 'rotation-0';
      const pubDate = new Date(isOutsideRange ? now - 2 * 60 * 60_000 : now);
      const xml = `<?xml version="1.0"?><rss version="2.0"><channel><item>` +
        `<title>${source} headline</title>` +
        `<link>https://example.test/${source}</link>` +
        `<pubDate>${pubDate.toUTCString()}</pubDate>` +
        `</item></channel></rss>`;
      return new Response(xml, { status: 200, headers: { 'content-type': 'application/rss+xml' } });
    }) as typeof window.fetch;

    const feedStatuses: Array<{ name: string; status?: string; itemCount?: number }> = [];
    const apiStatuses: Array<{ name: string; status?: string }> = [];
    const ctx = {
      currentTimeRange: '1h',
      newsByCategory: {} as Record<string, NewsItem[]>,
      newsPanels: {} as Record<string, NewsPanel>,
      panels: {} as Record<string, NewsPanel>,
      newsCategoryPanelKeys: new Map<string, string>(),
      disabledSources: new Set<string>(),
      statusPanel: {
        updateFeed: (name: string, status: { status?: string; itemCount?: number }) => {
          feedStatuses.push({ name, ...status });
        },
        updateApi: (name: string, status: { status?: string }) => {
          apiStatuses.push({ name, ...status });
        },
      },
    };
    const manager = new DataLoaderManager(ctx as never, {
      renderCriticalBanner: () => {},
      refreshOpenCountryBrief: () => {},
    });
    const internals = manager as unknown as {
      loadNewsCategory: LoadCategory;
      resolveEnabledNewsCategories: () => Array<{ key: string; feeds: Feed[]; isCustom: boolean }>;
      flashMapForNews: (items: NewsItem[]) => void;
    };
    internals.flashMapForNews = () => {};

    const rotationFeeds = makeFeeds('rotation', 6);
    internals.resolveEnabledNewsCategories = () => [
      { key: 'custom-rotation', feeds: rotationFeeds, isCustom: true },
    ];
    ctx.newsCategoryPanelKeys.set('custom-rotation', 'custom-rotation-panel');
    localStorage.removeItem('worldmonitor-news-feed-rotation');

    const loadOptions = { allowDigestPendingFallback: false, recordBaselineSample: false };
    await internals.loadNewsCategory('custom-rotation', rotationFeeds, null, true, loadOptions);
    const firstWindow = [...requestedTargets];

    // Mirror the deferred-panel factory: cached items render before pending
    // calls replay. setSourceCoverage must repaint the badge after that replay.
    const panel = new NewsPanel('custom-rotation-panel', 'Custom rotation');
    const coverageEvents: Array<{ covered: number; total: number } | null> = [];
    const originalSetSourceCoverage = panel.setSourceCoverage.bind(panel);
    panel.setSourceCoverage = (coverage) => {
      coverageEvents.push(coverage);
      originalSetSourceCoverage(coverage);
    };
    document.body.appendChild(panel.getElement());
    panel.renderNews(manager.filterItemsByTimeRange(ctx.newsByCategory['custom-rotation'] ?? []));
    await replayPendingCalls('custom-rotation-panel', panel);
    const firstCoverage = coverageEvents.at(-1);

    ctx.newsPanels['custom-rotation'] = panel;
    ctx.panels['custom-rotation-panel'] = panel;
    await internals.loadNewsCategory('custom-rotation', rotationFeeds, null, true, loadOptions);
    const secondWindow = requestedTargets.slice(firstWindow.length);
    const accumulatedSources = [...new Set(
      (ctx.newsByCategory['custom-rotation'] ?? []).map(item => item.source),
    )].sort();
    const secondCoverage = coverageEvents.at(-1);
    const persistedCycles = JSON.parse(
      localStorage.getItem('worldmonitor-news-feed-rotation') ?? '{}',
    ) as Record<string, number>;

    ctx.currentTimeRange = 'all';
    manager.applyTimeRangeFilterToNewsPanels();
    const allTimeCoverage = coverageEvents.at(-1);

    // A fully failed next window must keep accumulated headlines, return them
    // to the caller (and therefore ctx.allNews), and label them cached/error.
    const retainedItem = (source: string): NewsItem => ({
      source,
      title: `${source} retained`,
      link: `https://example.test/${source}-retained`,
      pubDate: new Date(now),
      isAlert: false,
    });
    const failedFeeds = makeFeeds('failed', 3);
    const failedRetained = [retainedItem('failed-0'), retainedItem('failed-1')];
    ctx.newsByCategory['custom-failure'] = failedRetained;
    ctx.newsCategoryPanelKeys.set('custom-failure', 'custom-failure-panel');
    const failedPanel = new NewsPanel('custom-failure-panel', 'Custom failure');
    document.body.appendChild(failedPanel.getElement());
    ctx.newsPanels['custom-failure'] = failedPanel;
    ctx.panels['custom-failure-panel'] = failedPanel;
    internals.resolveEnabledNewsCategories = () => [
      { key: 'custom-failure', feeds: failedFeeds, isCustom: true },
    ];
    const failedResult = await internals.loadNewsCategory(
      'custom-failure',
      failedFeeds,
      null,
      true,
      loadOptions,
    );
    const failedBadgeClass = failedPanel.getElement().querySelector('.panel-data-badge')?.className ?? '';

    // A hard exception after the RSS module loads uses the catch path. It must
    // return retained custom items instead of silently dropping them.
    const thrownFeeds = makeFeeds('thrown', 1);
    const thrownRetained = [retainedItem('thrown-0')];
    ctx.newsByCategory['custom-throw'] = thrownRetained;
    ctx.newsCategoryPanelKeys.set('custom-throw', 'custom-throw-panel');
    const thrownPanel = new NewsPanel('custom-throw-panel', 'Custom throw');
    document.body.appendChild(thrownPanel.getElement());
    ctx.newsPanels['custom-throw'] = thrownPanel;
    ctx.panels['custom-throw-panel'] = thrownPanel;
    internals.resolveEnabledNewsCategories = () => [
      { key: 'custom-throw', feeds: thrownFeeds, isCustom: true },
    ];
    internals.flashMapForNews = () => {
      throw new Error('synthetic batch failure');
    };
    const thrownResult = await internals.loadNewsCategory(
      'custom-throw',
      thrownFeeds,
      null,
      true,
      loadOptions,
    );

    window.fetch = originalFetch;
    panel.destroy();
    failedPanel.destroy();
    thrownPanel.destroy();

    return {
      firstWindow,
      secondWindow,
      accumulatedSources,
      firstCoverage,
      secondCoverage,
      allTimeCoverage,
      persistedCycle: persistedCycles['custom-rotation'],
      failedResultSources: failedResult.map(item => item.source).sort(),
      failedRetainedSources: failedRetained.map(item => item.source).sort(),
      failedBadgeClass,
      thrownResultSources: thrownResult.map(item => item.source).sort(),
      thrownResultCount: thrownResult.length,
      thrownRetainedSources: thrownRetained.map(item => item.source).sort(),
      failedFeedStatus: feedStatuses.find(
        status => status.name === 'Custom-failure' && status.status === 'error',
      ),
      apiStatuses,
    };
  });

  expect(result.firstWindow).toHaveLength(3);
  expect(result.secondWindow).toHaveLength(3);
  expect(new Set(result.firstWindow)).toEqual(new Set([
    'https://rotation.test/rotation-0.xml',
    'https://rotation.test/rotation-1.xml',
    'https://rotation.test/rotation-2.xml',
  ]));
  expect(new Set(result.secondWindow)).toEqual(new Set([
    'https://rotation.test/rotation-3.xml',
    'https://rotation.test/rotation-4.xml',
    'https://rotation.test/rotation-5.xml',
  ]));
  expect(result.accumulatedSources).toEqual([
    'rotation-0',
    'rotation-1',
    'rotation-2',
    'rotation-3',
    'rotation-4',
    'rotation-5',
  ]);
  expect(result.persistedCycle).toBe(2);
  expect(result.firstCoverage).toEqual({ covered: 2, total: 6 });
  expect(result.secondCoverage).toEqual({ covered: 5, total: 6 });
  expect(result.allTimeCoverage).toEqual({ covered: 6, total: 6 });
  expect(result.failedResultSources).toEqual(result.failedRetainedSources);
  expect(result.failedBadgeClass).toContain('cached');
  expect(result.failedFeedStatus?.itemCount).toBe(2);
  expect(new Set(result.thrownResultSources)).toEqual(new Set(result.thrownRetainedSources));
  expect(result.thrownResultCount).toBeGreaterThanOrEqual(result.thrownRetainedSources.length);
  expect(result.apiStatuses.some(status => status.status === 'error')).toBe(true);
});
