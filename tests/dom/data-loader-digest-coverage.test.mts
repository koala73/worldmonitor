import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppContext } from '@/app/app-context';
import type { ListFeedDigestResponse } from '@/generated/client/worldmonitor/news/v1/service_client';

const mocks = vi.hoisted(() => ({
  checkBatchForBreakingAlerts: vi.fn(),
}));

vi.mock('@/services/breaking-news-alerts', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/breaking-news-alerts')>(),
  checkBatchForBreakingAlerts: mocks.checkBatchForBreakingAlerts,
}));

await import('@/app/data-loader');

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
  beginNewsLoad(): number;
  commitNewsFreshness(generation: number, servedStale: boolean): boolean;
  canNotifyForCommittedNews(generation: number, servedStale: boolean): boolean;
  loadNewsCategory(
    category: string,
    feeds: Array<{ name: string }>,
    digest: SelectedNewsDigest | null,
    isCustom: boolean,
    options: { allowDigestPendingFallback: boolean; recordBaselineSample: boolean },
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
    },
    newsByCategory: {},
    currentTimeRange: 'all',
    initialLoadComplete: false,
  } as unknown as AppContext;
  const { DataLoaderManager } = await import('@/app/data-loader');
  const loader = new DataLoaderManager(ctx, {
    renderCriticalBanner: () => undefined,
    refreshOpenCountryBrief: () => undefined,
  });
  const internal = loader as unknown as DigestLoaderInternals;
  internal.persistDigest = vi.fn();
  internal.loadPersistedDigest = vi.fn().mockResolvedValue(null);
  return { loader, internal, updateDigestCoverage };
}

describe('digest coverage follows the selected browser response', () => {
  beforeEach(() => {
    mocks.checkBatchForBreakingAlerts.mockReset();
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
    }));
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
    }));
    expect(updateDigestCoverage).not.toHaveBeenCalledWith(expect.objectContaining({
      state: 'complete',
      itemsServed: 4,
    }));
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
        { allowDigestPendingFallback: false, recordBaselineSample: false },
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
});
