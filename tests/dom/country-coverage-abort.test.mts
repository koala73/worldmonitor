import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppContext } from '@/app/app-context';
import type { CountryBriefSignals } from '@/types';

const coverageMocks = vi.hoisted(() => ({
  fetchCountryCoverage: vi.fn(),
}));

vi.mock('@/services/country-coverage', () => ({
  fetchCountryCoverage: (...args: unknown[]) => coverageMocks.fetchCountryCoverage(...args),
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

function createBriefHarness() {
  let visible = false;
  let activeCode = '';
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
    updateInfrastructure: () => {},
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
    newsUpdates,
    open: (code: string, name: string) => manager.openCountryBriefByCode(code, name, { trackAnalytics: false }),
  };
}

describe('CountryIntelManager coverage abort', () => {
  beforeEach(() => {
    coverageMocks.fetchCountryCoverage.mockReset();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
  });

  it('aborts an in-flight country coverage fetch when the brief switches countries', async () => {
    const franceCoverage = deferred<{ headlines: []; timelineEvents: [] }>();
    const capturedSignals: AbortSignal[] = [];
    coverageMocks.fetchCountryCoverage.mockImplementation(async (_country, _terms, options) => {
      capturedSignals.push(options.signal);
      if (capturedSignals.length === 1) return franceCoverage.promise;
      return { headlines: [], timelineEvents: [] };
    });

    const { newsUpdates, open } = createBriefHarness();
    const franceOpen = open('FR', 'France');
    await vi.waitFor(() => expect(coverageMocks.fetchCountryCoverage).toHaveBeenCalledTimes(1));
    expect(capturedSignals[0]?.aborted).toBe(false);

    const germanyOpen = open('DE', 'Germany');
    await vi.waitFor(() => expect(capturedSignals[0]?.aborted).toBe(true));
    await vi.waitFor(() => expect(coverageMocks.fetchCountryCoverage).toHaveBeenCalledTimes(2));
    expect(capturedSignals[1]?.aborted).toBe(false);
    expect(coverageMocks.fetchCountryCoverage.mock.calls[1]?.[0]).toBe('Germany');

    franceCoverage.resolve({ headlines: [], timelineEvents: [] });
    await Promise.all([franceOpen, germanyOpen]);
    expect(newsUpdates.at(-1)).toBe('DE');
  });
});
