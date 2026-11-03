// The server builds the intel category only into the full edition's digest.
// An Intel Feed a user added on another edition read its own edition's digest,
// found no intel there, and returned without rendering, so the panel stayed on
// its boot "Loading…" state for the whole session.
import { describe, expect, it, vi } from 'vitest';

import type { AppContext } from '@/app/app-context';
import { INTEL_SOURCES } from '@/config';

vi.mock('@/config', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/config')>(),
  SITE_VARIANT: 'tech',
}));
vi.mock('@/services/analysis-worker', () => ({
  analysisWorker: { clusterNews: vi.fn(), analyzeCorrelations: vi.fn() },
}));

type Selection = { digest: { categories: Record<string, { items: unknown[] }> }; servedStale: boolean } | null;

interface LoaderInternals {
  newsLoadGeneration: number;
  loadIntelNews(selection: Selection, options: { recordBaselineSample: boolean; digestPending: boolean }, generation?: number): Promise<unknown[]>;
  selectEditionDigest(edition: string, language: string): Promise<Selection>;
  renderNewsForCategory(category: string, items: unknown[]): void;
  shouldHydrateNews(forceAll: boolean): boolean;
  resolveEnabledNewsCategories(): unknown[];
  tryFetchDigest(): Promise<Selection>;
  loadNewsCategory(): Promise<unknown[]>;
  clusterNewsForGeneration(): Promise<{ clusters: unknown[] }>;
}

function protoItem(source: string, title: string) {
  return {
    source, title, link: `https://example.com/${encodeURIComponent(title)}`,
    publishedAt: Date.now(), isAlert: false, importanceScore: 0, credibilityScore: 0.8,
    corroborationCount: 0, threat: undefined, locationName: '', location: undefined,
  };
}

async function techLoader(fullDigest: Selection) {
  const ctx = {
    statusPanel: { updateDigestCoverage: vi.fn(), updateFeed: vi.fn(), updateApi: vi.fn() },
    disabledSources: new Set<string>(),
    newsCategoryPanelKeys: new Map<string, string>(),
    newsPanels: {},
    panels: {},
    panelSettings: { intel: { name: 'Intel Feed', enabled: true, priority: 1 } },
    newsByCategory: {},
    currentTimeRange: 'all',
    initialLoadComplete: false,
    allNews: [],
    latestClusters: [],
    latestPredictions: [],
    latestMarkets: [],
    clustersSettled: false,
    monitors: [],
    map: { setNewsLocations: vi.fn(), updateHotspotActivity: vi.fn(), flashLocation: vi.fn() },
  } as unknown as AppContext;
  const { DataLoaderManager } = await import('@/app/data-loader');
  const loader = new DataLoaderManager(ctx, { renderCriticalBanner: () => undefined, refreshOpenCountryBrief: () => undefined });
  const internal = loader as unknown as LoaderInternals;
  const selectEditionDigest = vi.fn(async () => fullDigest);
  const renderNewsForCategory = vi.fn();
  internal.selectEditionDigest = selectEditionDigest;
  internal.renderNewsForCategory = renderNewsForCategory;
  return { internal, selectEditionDigest, renderNewsForCategory };
}

const techDigest: Selection = { digest: { categories: { tech: { items: [] } } }, servedStale: false };
const options = { recordBaselineSample: false, digestPending: false };

describe('Intel Feed on an edition without an intel digest', () => {
  it('reads intel from the full edition digest', async () => {
    const source = INTEL_SOURCES[0]!.name;
    const full: Selection = {
      digest: { categories: { intel: { items: [protoItem(source, 'Carrier group moves'), protoItem(source, 'Drills resume')] } } },
      servedStale: false,
    };
    const { internal, selectEditionDigest, renderNewsForCategory } = await techLoader(full);

    const items = await internal.loadIntelNews(techDigest, options);

    expect(selectEditionDigest).toHaveBeenCalledWith('full', expect.any(String));
    expect(items).toHaveLength(2);
    expect(renderNewsForCategory).toHaveBeenCalledWith('intel', items);
  });

  it('drops a load that a newer one superseded during the full edition fetch', async () => {
    const source = INTEL_SOURCES[0]!.name;
    const full: Selection = { digest: { categories: { intel: { items: [protoItem(source, 'Stale headline')] } } }, servedStale: false };
    const { internal, selectEditionDigest, renderNewsForCategory } = await techLoader(full);
    const generation = internal.newsLoadGeneration;
    selectEditionDigest.mockImplementation(async () => {
      internal.newsLoadGeneration += 1;
      return full;
    });

    const items = await internal.loadIntelNews(techDigest, options, generation);

    expect(items).toEqual([]);
    expect(renderNewsForCategory).not.toHaveBeenCalled();
  });

  it('does not hold the pending pass on the full edition fetch and fetches it once per load', async () => {
    const source = INTEL_SOURCES[0]!.name;
    const full: Selection = {
      digest: { categories: { intel: { items: [protoItem(source, 'Strike group sails'), protoItem(source, 'Range reopens')] } } },
      servedStale: false,
    };
    const { internal, selectEditionDigest } = await techLoader(null);
    let resolveFull: (selection: Selection) => void = () => undefined;
    selectEditionDigest.mockImplementation(() => new Promise<Selection>((resolve) => { resolveFull = resolve; }));
    const generation = internal.newsLoadGeneration;

    const pending = await internal.loadIntelNews(techDigest, { recordBaselineSample: false, digestPending: true }, generation);
    expect(pending).toEqual([]);

    const settled = internal.loadIntelNews(techDigest, options, generation);
    resolveFull(full);
    expect(await settled).toHaveLength(2);
    expect(selectEditionDigest).toHaveBeenCalledTimes(1);
  }, 2_000);

  it('leaves a newer load alone when a superseded one reaches its pending pass late', async () => {
    const source = INTEL_SOURCES[0]!.name;
    const full: Selection = { digest: { categories: { intel: { items: [protoItem(source, 'Live headline')] } } }, servedStale: false };
    const { internal, selectEditionDigest, renderNewsForCategory } = await techLoader(full);
    const ctx = (internal as unknown as { ctx: { newsByCategory: Record<string, unknown[]> } }).ctx;
    const older = internal.newsLoadGeneration;
    internal.newsLoadGeneration += 1;
    const newer = internal.newsLoadGeneration;
    const pendingOptions = { recordBaselineSample: false, digestPending: true };

    await internal.loadIntelNews(techDigest, pendingOptions, newer);
    const live = await internal.loadIntelNews(techDigest, options, newer);
    renderNewsForCategory.mockClear();
    ctx.newsByCategory.intel = live;

    expect(await internal.loadIntelNews(techDigest, pendingOptions, older)).toEqual([]);
    expect(renderNewsForCategory, 'the stale pass must not re-render the live list as cached').not.toHaveBeenCalled();
    expect(selectEditionDigest, 'the stale pass must not start or replace the full edition fetch').toHaveBeenCalledTimes(1);
  });

  it('renders an empty list instead of leaving the panel loading when no digest has intel', async () => {
    const { internal, renderNewsForCategory } = await techLoader(null);

    const items = await internal.loadIntelNews(techDigest, options);

    expect(items).toEqual([]);
    expect(renderNewsForCategory).toHaveBeenCalledWith('intel', []);
  });

  it('keeps news retryable while the full edition digest is unavailable', async () => {
    const source = INTEL_SOURCES[0]!.name;
    const { internal, selectEditionDigest } = await techLoader(null);
    internal.resolveEnabledNewsCategories = () => [{ key: 'tech', feeds: [], isCustom: false }];
    internal.tryFetchDigest = async () => techDigest;
    internal.loadNewsCategory = async () => [];
    internal.clusterNewsForGeneration = async () => ({ clusters: [] });

    await (internal as unknown as { loadNews(): Promise<void> }).loadNews();
    expect(selectEditionDigest).toHaveBeenCalledWith('full', expect.any(String));
    expect(internal.shouldHydrateNews(false), 'a later trigger retries intel').toBe(true);

    selectEditionDigest.mockImplementation(async () => ({
      digest: { categories: { intel: { items: [protoItem(source, 'Recovered headline')] } } },
      servedStale: false,
    }));
    await (internal as unknown as { loadNews(): Promise<void> }).loadNews();
    expect(internal.shouldHydrateNews(false), 'a landed intel load is not repeated').toBe(false);
  });
});
