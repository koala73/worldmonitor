import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppContext } from '@/app/app-context';
import type { ListFeedDigestResponse } from '@/generated/client/worldmonitor/news/v1/service_client';

vi.mock('@/services/analysis-worker', () => ({
  analysisWorker: { clusterNews: vi.fn(), analyzeCorrelations: vi.fn() },
}));

interface NewsItemLike { source: string; title: string }

interface CrossEditionInternals {
  loadNewsCategory(
    category: string,
    feeds: Array<{ name: string; url: string }>,
    digest: null,
    isCustom: boolean,
    options: { allowDigestPendingFallback: boolean; recordBaselineSample: boolean },
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
});
