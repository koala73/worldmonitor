import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppContext } from '@/app/app-context';
import type { ListFeedDigestResponse } from '@/generated/client/worldmonitor/news/v1/service_client';

await import('@/app/data-loader');

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
  tryFetchDigest(): Promise<ListFeedDigestResponse | null>;
}

function digest(state: string, itemCount = 2): ListFeedDigestResponse {
  return {
    categories: {
      politics: {
        items: Array.from({ length: itemCount }, (_, index) => ({
          source: `source-${index}`,
          title: `item-${index}`,
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
    },
  };
}

async function makeLoader() {
  const updateDigestCoverage = vi.fn();
  const ctx = {
    statusPanel: { updateDigestCoverage },
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

    expect(result).toBe(retained);
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

    expect(result).toBe(retained);
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

    expect(result).toBe(retained);
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

    expect(result).toBe(retained);
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
});
