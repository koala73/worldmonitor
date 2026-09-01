import { beforeEach, describe, expect, it, vi } from 'vitest';

const preloadMocks = vi.hoisted(() => ({
  centroid: null as { lat: number; lon: number } | null,
  geometry: vi.fn<() => Promise<void>>(),
  militaryBases: vi.fn<() => Promise<unknown[]>>(),
  infrastructureTables: vi.fn<() => Promise<void>>(),
}));

vi.mock('@/services/country-geometry', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/country-geometry')>(),
  getCountryCentroid: () => preloadMocks.centroid,
  preloadCountryGeometry: preloadMocks.geometry,
}));

vi.mock('@/services/military-base-config', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/military-base-config')>(),
  preloadMilitaryBases: preloadMocks.militaryBases,
}));

vi.mock('@/services/related-assets', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/related-assets')>(),
  preloadInfrastructureTables: preloadMocks.infrastructureTables,
}));

vi.mock('@/app/lazy-services', () => ({
  getSignalAggregator: async () => ({
    getCountryClusters: () => [],
    getRegionalConvergence: () => [],
  }),
}));

vi.mock('@/services/generated-rpc-clients', () => ({
  EconomicServiceClient: class {},
  IntelligenceServiceClient: class {
    getCountryFacts = () => Promise.reject(new Error('not used'));
    getCountryEnergyProfile = () => Promise.reject(new Error('not used'));
    getCountryPortActivity = () => Promise.reject(new Error('not used'));
  },
  MarketServiceClient: class {
    getCountryStockIndex = () => Promise.resolve({ available: false });
  },
  MilitaryServiceClient: class {},
  TradeServiceClient: class {},
}));

vi.mock('@/services/panel-gating', () => ({ hasPremiumAccess: () => false }));
vi.mock('@/services/prediction', () => ({ fetchCountryMarkets: async () => [] }));
vi.mock('@/services/imf-country-data', () => ({
  getImfCountryBundle: async () => null,
  buildImfEconomicIndicators: () => [],
}));
vi.mock('@/services/supply-chain', () => ({
  fetchMultiSectorExposure: async () => [],
  fetchCountryProducts: async () => ({ products: [] }),
  fetchMultiSectorCostShock: async () => null,
  fetchCountryVulnerabilities: async () => null,
}));

import type { AppContext } from '@/app/app-context';
import { CountryIntelManager } from '@/app/country-intel';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

type PreloadReadiness = {
  geometry: boolean;
  militaryBases: boolean;
  infrastructureTables: boolean;
};

type InfrastructureEvents = {
  readiness: PreloadReadiness;
  updateInfrastructureCalls: Array<{
    code: string;
    readiness: PreloadReadiness;
  }>;
};

function startCountryBrief(warmCentroid: boolean) {
  const geometry = deferred<void>();
  const militaryBases = deferred<unknown[]>();
  const infrastructureTables = deferred<void>();
  const events: InfrastructureEvents = {
    readiness: {
      geometry: false,
      militaryBases: false,
      infrastructureTables: false,
    },
    updateInfrastructureCalls: [],
  };

  preloadMocks.centroid = warmCentroid ? { lat: 24.3, lon: 54.4 } : null;
  preloadMocks.geometry.mockImplementation(() => geometry.promise.then(() => {
    events.readiness.geometry = true;
  }));
  preloadMocks.militaryBases.mockImplementation(() => militaryBases.promise.then((bases) => {
    events.readiness.militaryBases = true;
    return bases;
  }));
  preloadMocks.infrastructureTables.mockImplementation(() => infrastructureTables.promise.then(() => {
    events.readiness.infrastructureTables = true;
  }));

  let activeCode = '';
  let visible = false;
  const page = {
    getCode: () => activeCode,
    getName: () => 'United Arab Emirates',
    isVisible: () => visible,
    showLoading: () => {
      activeCode = '__loading__';
      visible = true;
    },
    show: (_country: string, code: string) => {
      activeCode = code;
      visible = true;
    },
    updateNews: () => {},
    updateMarkets: () => {},
    updateStock: () => {},
    updateInfrastructure: (code: string) => {
      events.updateInfrastructureCalls.push({
        code,
        readiness: { ...events.readiness },
      });
    },
  };
  const ctx = {
    countryBriefPage: page,
    isDestroyed: false,
    allNews: [],
    intelligenceCache: { advisories: [] },
    map: {
      setRenderPaused: () => {},
      highlightCountry: () => {},
      fitCountry: () => {},
    },
  } as unknown as AppContext;
  const manager = new CountryIntelManager(ctx);
  Reflect.set(manager, 'ensureCountryBriefPage', async () => true);
  Reflect.set(manager, 'getCountrySignals', async () => ({}));
  Reflect.set(manager, 'buildSignalDetails', async () => ({}));
  Reflect.set(manager, 'buildMilitarySummary', () => ({}));
  Reflect.set(manager, 'buildEconomicIndicators', () => []);
  Reflect.set(manager, 'fetchDefenseIndustrialBase', () => {});
  Reflect.set(manager, 'fetchCommodityVulnerability', () => {});
  Reflect.set(manager, 'mountCountryTimeline', () => {});
  Reflect.set(manager, 'buildBriefContextSnapshot', () => '');
  Reflect.set(manager, 'fetchCountryIntelBrief', async () => ({ brief: '', sources: [] }));

  const open = manager.openCountryBriefByCode('AE', 'United Arab Emirates', {
    trackAnalytics: false,
  });

  return {
    events,
    open,
    settleBarrier: () => {
      geometry.resolve();
      militaryBases.resolve([]);
      infrastructureTables.resolve();
    },
  };
}

describe('CountryIntelManager infrastructure preload barrier', () => {
  beforeEach(() => {
    preloadMocks.geometry.mockReset();
    preloadMocks.militaryBases.mockReset();
    preloadMocks.infrastructureTables.mockReset();
  });

  it('waits for cold geometry and asset tables before the first infrastructure render', async () => {
    const run = startCountryBrief(false);

    await vi.waitFor(() => expect(preloadMocks.infrastructureTables).toHaveBeenCalledOnce());
    expect(preloadMocks.geometry).toHaveBeenCalledOnce();
    expect(preloadMocks.militaryBases).toHaveBeenCalledOnce();
    expect(run.events).toEqual({
      readiness: {
        geometry: false,
        militaryBases: false,
        infrastructureTables: false,
      },
      updateInfrastructureCalls: [],
    });

    run.settleBarrier();
    await vi.waitFor(() => expect(run.events.updateInfrastructureCalls).toHaveLength(1));
    expect(run.events.updateInfrastructureCalls).toEqual([{
      code: 'AE',
      readiness: {
        geometry: true,
        militaryBases: true,
        infrastructureTables: true,
      },
    }]);
    await run.open;
  });

  it('keeps the warm-centroid render before the preload refresh', async () => {
    const run = startCountryBrief(true);

    await vi.waitFor(() => expect(preloadMocks.infrastructureTables).toHaveBeenCalledOnce());
    expect(preloadMocks.geometry).toHaveBeenCalledOnce();
    expect(preloadMocks.militaryBases).toHaveBeenCalledOnce();
    expect(run.events.updateInfrastructureCalls).toEqual([{
      code: 'AE',
      readiness: {
        geometry: false,
        militaryBases: false,
        infrastructureTables: false,
      },
    }]);

    run.settleBarrier();
    await vi.waitFor(() => expect(run.events.updateInfrastructureCalls).toHaveLength(2));
    expect(run.events.updateInfrastructureCalls[1]).toEqual({
      code: 'AE',
      readiness: {
        geometry: true,
        militaryBases: true,
        infrastructureTables: true,
      },
    });
    await run.open;
  });
});
