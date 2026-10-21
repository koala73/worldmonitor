// Users can add any panel to any variant's layout. Loaders gated on
// `SITE_VARIANT === 'full'` left those panels on their loading state forever:
// Intel Feed and Fires under the Tech variant on desktop (#9396).
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppContext } from '@/app/app-context';

vi.mock('@/config', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/config')>(),
  SITE_VARIANT: 'tech',
}));
vi.mock('@/services/analysis-worker', () => ({
  analysisWorker: { clusterNews: vi.fn(), analyzeCorrelations: vi.fn() },
}));

interface LoaderInternals {
  shouldHydrateNews(forceAll: boolean): boolean;
  resolveEnabledNewsCategories(): unknown[];
  tryFetchDigest(): Promise<unknown>;
  loadIntelNews(): Promise<unknown[]>;
  clusterNewsForGeneration(): Promise<{ clusters: unknown[] }>;
}

async function loadNewsWith(panelSettings: AppContext['panelSettings']) {
  const ctx = {
    statusPanel: { updateDigestCoverage: vi.fn(), updateFeed: vi.fn(), updateApi: vi.fn() },
    disabledSources: new Set<string>(),
    newsCategoryPanelKeys: new Map<string, string>(),
    newsPanels: {},
    panels: {},
    panelSettings,
    newsByCategory: {},
    currentTimeRange: 'all',
    initialLoadComplete: false,
    allNews: [],
    latestClusters: [],
    latestPredictions: [],
    latestMarkets: [],
    clustersSettled: false,
    monitors: [],
    map: { setNewsLocations: vi.fn(), updateHotspotActivity: vi.fn() },
  } as unknown as AppContext;
  const { DataLoaderManager } = await import('@/app/data-loader');
  const loader = new DataLoaderManager(ctx, { renderCriticalBanner: () => undefined, refreshOpenCountryBrief: () => undefined });
  const internal = loader as unknown as LoaderInternals;
  const loadIntelNews = vi.fn(async () => []);
  internal.resolveEnabledNewsCategories = () => [];
  internal.tryFetchDigest = async () => null;
  internal.loadIntelNews = loadIntelNews;
  internal.clusterNewsForGeneration = async () => ({ clusters: [] });
  await loader.loadNews();
  return Object.assign(loadIntelNews, { internal, panelSettings });
}

describe('cross-variant panel hydration', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
  });

  it('loads the Intel Feed a Tech user added to their layout', async () => {
    const loadIntelNews = await loadNewsWith({ intel: { name: 'Intel Feed', enabled: true, priority: 1 } });
    expect(loadIntelNews).toHaveBeenCalled();
  });

  it('does not load intel for a Tech layout without the panel', async () => {
    const loadIntelNews = await loadNewsWith({ intel: { name: 'Intel Feed', enabled: false, priority: 1 } });
    expect(loadIntelNews).not.toHaveBeenCalled();
  });

  it('reloads news when the Intel Feed is added after a load', async () => {
    const { internal, panelSettings } = await loadNewsWith({ intel: { name: 'Intel Feed', enabled: false, priority: 1 } });
    expect(internal.shouldHydrateNews(false)).toBe(false);
    panelSettings.intel!.enabled = true;
    expect(internal.shouldHydrateNews(false)).toBe(true);
  });
});

describe('variantShipsOrUserEnabled', () => {
  it('hydrates a panel its variant ships, or one the user enabled', async () => {
    const { variantShipsOrUserEnabled } = await import('@/app/panel-data-gate');
    expect(variantShipsOrUserEnabled({ variant: 'full', owningVariants: ['full'], panelEnabled: false })).toBe(true);
    expect(variantShipsOrUserEnabled({ variant: 'tech', owningVariants: ['full'], panelEnabled: true })).toBe(true);
    expect(variantShipsOrUserEnabled({ variant: 'tech', owningVariants: ['full'], panelEnabled: false })).toBe(false);
  });
});
