// Runtime proof that the energy variant ships and hydrates the Renewable
// Energy panel (#8690, replacing the source-text checks in
// energy-variant-renewable-guard.test.mts).
//
// The panel is shared by the happy and energy variants. The config must enable
// it for energy, and the data loader must schedule its hydration outside the
// happy-only branch. PanelLayoutManager has no DOM harness yet (#5892), so its
// creation branch keeps one text check here: it is gated on
// shouldCreatePanel('renewable'), which is the hasPanelSettingEntry() read this
// file proves at runtime against the energy settings.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppContext } from '@/app/app-context';

vi.mock('@/config', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/config')>(),
  SITE_VARIANT: 'energy',
}));
vi.mock('@/services/analysis-worker', () => ({
  analysisWorker: { clusterNews: vi.fn(), analyzeCorrelations: vi.fn() },
}));
vi.mock('@/services/renewable-energy-data', () => ({
  fetchRenewableEnergyData: vi.fn(),
  fetchEnergyCapacity: vi.fn(),
}));

import { getInitialPanelSettingsForVariant } from '@/config/panels';
import { hasPanelSettingEntry } from '@/app/news-panel-keys';
import { fetchRenewableEnergyData, fetchEnergyCapacity } from '@/services/renewable-energy-data';

const renewableResult = {
  state: 'live' as const,
  cachedAt: null,
  data: { globalPercentage: 30, globalYear: 2024, historicalData: [{ year: 2024, value: 30 }], regions: [] },
};
const capacity = [{ source: 'SUN', name: 'Solar', data: [{ year: 2024, capacityMw: 100 }] }];

interface LoaderInternals {
  runHydrationTasks(tasks: Array<{ name: string; task: () => Promise<void> }>, forceAll: boolean): Promise<void>;
  updateSearchIndex(): void;
  shouldHydrateNews(forceAll: boolean): boolean;
}

async function scheduledTasks(panelSettings: AppContext['panelSettings']) {
  const renewablePanel = { setData: vi.fn(), setCapacityData: vi.fn() };
  const ctx = {
    statusPanel: { updateDigestCoverage: vi.fn(), updateFeed: vi.fn(), updateApi: vi.fn() },
    disabledSources: new Set<string>(),
    newsCategoryPanelKeys: new Map<string, string>(),
    newsPanels: {},
    panels: { renewable: renewablePanel },
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
    mapLayers: {},
    inFlight: new Set<string>(),
    isDestroyed: false,
    map: { setNewsLocations: vi.fn(), updateHotspotActivity: vi.fn() },
  } as unknown as AppContext;
  const { DataLoaderManager } = await import('@/app/data-loader');
  const loader = new DataLoaderManager(ctx, { renderCriticalBanner: () => undefined, refreshOpenCountryBrief: () => undefined });
  const internal = loader as unknown as LoaderInternals;
  const names: string[] = [];
  internal.runHydrationTasks = async (tasks) => {
    names.push(...tasks.map((t) => t.name));
    await tasks.find((t) => t.name === 'renewable')?.task();
  };
  internal.updateSearchIndex = () => undefined;
  internal.shouldHydrateNews = () => false;
  await loader.loadAllData(true);
  return { names, renewablePanel };
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
  vi.mocked(fetchRenewableEnergyData).mockResolvedValue(renewableResult);
  vi.mocked(fetchEnergyCapacity).mockResolvedValue(capacity);
});

describe('energy variant renewable panel', () => {
  it('is enabled in the energy and happy initial settings', () => {
    for (const variant of ['energy', 'happy']) {
      const settings = getInitialPanelSettingsForVariant(variant);
      expect(settings.renewable, variant).toMatchObject({ name: 'Renewable Energy', enabled: true });
      expect(hasPanelSettingEntry(settings, 'renewable'), variant).toBe(true);
    }
  });

  it('runs its hydration callback under the energy variant alongside the non-happy loaders', async () => {
    const { names, renewablePanel } = await scheduledTasks(getInitialPanelSettingsForVariant('energy'));
    expect(names).toContain('renewable');
    expect(names).toContain('markets');
    expect(renewablePanel.setData).toHaveBeenCalledExactlyOnceWith(renewableResult);
    expect(renewablePanel.setCapacityData).toHaveBeenCalledExactlyOnceWith(capacity);
  });

  it('is created by the layout through the same panel-setting read', () => {
    const layout = readFileSync(resolve(process.cwd(), 'src/app/panel-layout.ts'), 'utf8');
    expect(layout).toMatch(/if \(this\.shouldCreatePanel\('renewable'\)\) \{\s*this\.lazyImportedPanel\('renewable'/);
    expect(layout).toMatch(/private shouldCreatePanel\(key: string\): boolean \{\s*return hasPanelSettingEntry\(this\.ctx\.panelSettings, key\);/);
  });
});
