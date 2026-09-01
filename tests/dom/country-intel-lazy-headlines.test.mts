import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppContext } from '@/app/app-context';
import type { CountryBriefSignals, NewsItem } from '@/types';

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

vi.mock('@/services/country-geometry', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/country-geometry')>(),
  preloadCountryGeometry: async () => {},
  getCountryCentroid: () => null,
}));

vi.mock('@/services/related-assets', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/related-assets')>(),
  preloadInfrastructureTables: async () => {},
  getNearbyInfrastructure: () => [],
}));

vi.mock('@/services/military-base-config', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/military-base-config')>(),
  preloadMilitaryBases: async () => [],
  getCachedMilitaryBases: () => [],
}));

import { CountryIntelManager } from '@/app/country-intel';

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

function newsItem(title: string): NewsItem {
  return {
    source: 'Test wire',
    title,
    link: `https://example.com/${encodeURIComponent(title)}`,
    pubDate: new Date('2026-09-01T12:00:00Z'),
    isAlert: false,
  };
}

function createBriefHarness(eagerNews: NewsItem[]) {
  let visible = false;
  let activeCode = '';
  const newsUpdates: NewsItem[][] = [];
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
    updateNews: (headlines: NewsItem[]) => {
      newsUpdates.push(headlines);
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
    allNews: eagerNews,
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
    open: () => manager.openCountryBriefByCode('US', 'United States', { trackAnalytics: false }),
  };
}

describe('CountryIntelManager lazy coverage headlines', () => {
  beforeEach(() => {
    coverageMocks.fetchCountryCoverage.mockReset();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
  });

  it('does not replace eager news when the opened country appears second in a lazy headline', async () => {
    const eagerHeadline = newsItem('US announces new sanctions package');
    const secondCountryHeadline = newsItem('Iran considers latest US proposal');
    coverageMocks.fetchCountryCoverage.mockResolvedValue({
      headlines: [secondCountryHeadline],
      timelineEvents: [],
    });

    const { newsUpdates, open } = createBriefHarness([eagerHeadline]);
    await open();
    await vi.waitFor(() => expect(coverageMocks.fetchCountryCoverage).toHaveBeenCalled());
    await vi.waitFor(() => expect(newsUpdates.length).toBeGreaterThanOrEqual(1));

    expect(newsUpdates[0]?.map((item) => item.title)).toEqual([eagerHeadline.title]);
    expect(newsUpdates.some((batch) => batch.some((item) => item.title === secondCountryHeadline.title)))
      .toBe(false);
    expect(newsUpdates[newsUpdates.length - 1]?.map((item: NewsItem) => item.title)).toEqual([eagerHeadline.title]);
  });
});
