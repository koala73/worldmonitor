import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppContext } from '@/app/app-context';
import type { CountryBriefSignals } from '@/types';

const geometryMocks = vi.hoisted(() => ({
  preloadCountryGeometry: vi.fn(),
}));

const infraMocks = vi.hoisted(() => ({
  preloadInfrastructureTables: vi.fn(),
}));

const militaryMocks = vi.hoisted(() => ({
  preloadMilitaryBases: vi.fn(async () => []),
}));

vi.mock('@/services/country-geometry', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/country-geometry')>(),
  preloadCountryGeometry: () => geometryMocks.preloadCountryGeometry(),
}));

vi.mock('@/services/related-assets', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/related-assets')>(),
  preloadInfrastructureTables: () => infraMocks.preloadInfrastructureTables(),
  getNearbyInfrastructure: () => [],
}));

vi.mock('@/services/military-base-config', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/military-base-config')>(),
  preloadMilitaryBases: () => militaryMocks.preloadMilitaryBases(),
  getCachedMilitaryBases: () => [],
}));

vi.mock('@/utils/after-paint', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/utils/after-paint')>(),
  yieldToMain: async () => {},
}));

vi.mock('@/app/lazy-services', () => ({
  getSignalAggregator: async () => ({
    getCountryClusters: () => [],
    getRegionalConvergence: () => [],
  }),
}));

vi.mock('@/services/imf-country-data', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/imf-country-data')>(),
  getImfCountryBundle: async () => ({
    macro: null,
    growth: null,
    labor: null,
    external: null,
    fetchedAt: 0,
  }),
}));

vi.mock('@/services/prediction', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/prediction')>(),
  fetchCountryMarkets: async () => [],
}));

vi.mock('@/services/supply-chain', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/supply-chain')>(),
  fetchMultiSectorExposure: async () => [],
  fetchCountryProducts: async () => [],
  fetchMultiSectorCostShock: async () => null,
  fetchCountryVulnerabilities: async () => null,
}));

vi.mock('@/services/panel-gating', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/panel-gating')>(),
  hasPremiumAccess: () => false,
}));

vi.mock('@/services/analysis-framework-store', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/analysis-framework-store')>(),
  subscribeFrameworkChange: () => () => {},
  getActiveFrameworkForPanel: () => null,
}));

import { CountryIntelManager } from '@/app/country-intel';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

const EMPTY_SIGNALS: CountryBriefSignals = {
  criticalNews: 0,
  protests: 0,
  militaryFlights: 0,
  militaryVessels: 0,
  militaryFlightsInCountry: 0,
  militaryVesselsInCountry: 0,
  outages: 0,
  aisDisruptions: 0,
  satelliteFires: 0,
  radiationAnomalies: 0,
  temporalAnomalies: 0,
  cyberThreats: 0,
  earthquakes: 0,
  displacementOutflow: 0,
  climateStress: 0,
  conflictEvents: 0,
  activeStrikes: 0,
  orefSirens: 0,
  orefHistory24h: 0,
  aviationDisruptions: 0,
  travelAdvisories: 0,
  travelAdvisoryMaxLevel: null,
  gpsJammingHexes: 0,
  isTier1: false,
  thermalEscalations: 0,
  sanctionsDesignations: 0,
  sanctionsNewDesignations: 0,
};

function createBriefHarness(code: string) {
  let visible = false;
  let activeCode = '';
  const infrastructureUpdates: string[] = [];
  const newsUpdates: string[] = [];
  const page = {
    getCode: () => activeCode,
    isVisible: () => visible,
    hide: () => {
      visible = false;
      activeCode = '';
    },
    show: (_country: string, nextCode: string) => {
      visible = true;
      activeCode = nextCode;
    },
    showLoading: () => {
      visible = true;
      activeCode = '__loading__';
    },
    updateInfrastructure: (nextCode: string) => {
      infrastructureUpdates.push(nextCode);
    },
    updateNews: () => {
      newsUpdates.push(activeCode);
    },
    updateMilitaryActivity: () => {},
    updateEconomicIndicators: () => {},
    updateStock: () => {},
    updateMarkets: () => {},
    updateBrief: () => {},
    getTimelineMount: () => undefined,
  };
  const ctx = {
    countryBriefPage: page,
    isDestroyed: false,
    allNews: [],
    latestClusters: [],
    intelligenceCache: {},
    map: {
      setRenderPaused: () => {},
      highlightCountry: () => {},
      fitCountry: () => {},
    },
  } as unknown as AppContext;
  const manager = new CountryIntelManager(ctx);
  Reflect.set(manager, 'ensureCountryBriefPage', async () => true);
  Reflect.set(manager, 'getCountrySignals', async () => EMPTY_SIGNALS);
  Reflect.set(manager, 'buildSignalDetails', async () => ({
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    recentHigh: [],
  }));
  Reflect.set(manager, 'fetchCountryIntelBrief', async () => ({ brief: '', sources: [] }));
  Reflect.set(manager, 'fetchDefenseIndustrialBase', () => {});
  Reflect.set(manager, 'fetchProSections', () => {});
  Reflect.set(manager, 'fetchCommodityVulnerability', () => {});
  Reflect.set(manager, 'mountCountryTimeline', () => {});
  return {
    infrastructureUpdates,
    newsUpdates,
    open: () => manager.openCountryBriefByCode(code, code, { trackAnalytics: false }),
  };
}

describe('CountryIntelManager infrastructure preload barrier', () => {
  beforeEach(() => {
    geometryMocks.preloadCountryGeometry.mockReset();
    infraMocks.preloadInfrastructureTables.mockReset();
    militaryMocks.preloadMilitaryBases.mockReset();
    militaryMocks.preloadMilitaryBases.mockResolvedValue([]);
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
  });

  it('does not render a cold brief until geometry and infrastructure tables settle, then refreshes once', async () => {
    const geometry = deferred();
    const infrastructure = deferred();
    geometryMocks.preloadCountryGeometry.mockReturnValue(geometry.promise);
    infraMocks.preloadInfrastructureTables.mockReturnValue(infrastructure.promise);

    const { infrastructureUpdates, newsUpdates, open } = createBriefHarness('FR');
    const pendingOpen = open();
    await vi.waitFor(() => expect(newsUpdates).toEqual(['FR']));

    expect(infrastructureUpdates).toEqual([]);

    geometry.resolve();
    await Promise.resolve();
    expect(infrastructureUpdates).toEqual([]);

    infrastructure.resolve();
    await vi.waitFor(() => expect(infrastructureUpdates).toEqual(['FR']));
    await pendingOpen;
    expect(infrastructureUpdates).toEqual(['FR']);
  });

  it('keeps the immediate infrastructure render when a warm centroid is already known', async () => {
    const geometry = deferred();
    const infrastructure = deferred();
    geometryMocks.preloadCountryGeometry.mockReturnValue(geometry.promise);
    infraMocks.preloadInfrastructureTables.mockReturnValue(infrastructure.promise);

    const { infrastructureUpdates, newsUpdates, open } = createBriefHarness('AE');
    const pendingOpen = open();
    await vi.waitFor(() => expect(newsUpdates).toEqual(['AE']));

    expect(infrastructureUpdates).toEqual(['AE']);

    infrastructure.resolve();
    await Promise.resolve();
    expect(infrastructureUpdates).toEqual(['AE']);

    geometry.resolve();
    await vi.waitFor(() => expect(infrastructureUpdates).toEqual(['AE', 'AE']));
    await pendingOpen;
    expect(infrastructureUpdates).toEqual(['AE', 'AE']);
  });
});
