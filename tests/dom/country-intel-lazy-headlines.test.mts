import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppContext } from '@/app/app-context';
import type { CountryBriefSignals, NewsItem } from '@/types';

const coverageMocks = vi.hoisted(() => ({
  fetchCountryCoverage: vi.fn(),
  createPanel: vi.fn(),
  premiumFetch: vi.fn(),
}));

vi.mock('@/services/premium-fetch', () => ({
  premiumFetch: (...args: unknown[]) => coverageMocks.premiumFetch(...args),
}));

vi.mock('@/components/CountryDeepDivePanel', () => ({
  CountryDeepDivePanel: function CountryDeepDivePanel() {
    return coverageMocks.createPanel();
  },
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

function createBriefHarness(eagerNews: NewsItem[], options: { realBriefFetch?: boolean } = {}) {
  let visible = false;
  let activeCode = '';
  let close = () => {};
  const newsUpdates: NewsItem[][] = [];
  const briefUpdates: Array<Record<string, unknown>> = [];
  const page = {
    onClose: (callback: () => void) => { close = callback; },
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
    updateBrief: (data: Record<string, unknown>) => {
      briefUpdates.push(data);
    },
    getTimelineMount: () => undefined,
  };
  const ctx = {
    countryBriefPage: page,
    isDestroyed: false,
    allNews: eagerNews,
    latestClusters: [],
    intelligenceCache: {},
    map: {
      clearCountryHighlight: () => {},
      setRenderPaused: () => {},
      highlightCountry: () => {},
      fitCountry: () => {},
    },
  } as unknown as AppContext;
  const manager = new CountryIntelManager(ctx);
  coverageMocks.createPanel.mockReturnValue(page);
  Reflect.set(manager, 'ensureCountryBriefPage', async () => true);
  Reflect.set(manager, 'getCountrySignals', async () => EMPTY_SIGNALS);
  Reflect.set(manager, 'buildSignalDetails', async () => ({
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    recentHigh: [],
  }));
  if (!options.realBriefFetch) {
    Reflect.set(manager, 'fetchCountryIntelBrief', async () => ({ brief: '', sources: [] }));
  }
  Reflect.set(manager, 'fetchDefenseIndustrialBase', () => {});
  Reflect.set(manager, 'fetchProSections', () => {});
  Reflect.set(manager, 'fetchCommodityVulnerability', () => {});
  Reflect.set(manager, 'mountCountryTimeline', () => {});
  return {
    newsUpdates,
    briefUpdates,
    bindClose: () => Reflect.get(manager, 'createCountryBriefPage').call(manager),
    close: () => { page.hide(); close(); },
    open: () => manager.openCountryBriefByCode('US', 'United States', { trackAnalytics: false }),
  };
}

describe('CountryIntelManager lazy coverage headlines', () => {
  beforeEach(() => {
    coverageMocks.fetchCountryCoverage.mockReset();
    coverageMocks.premiumFetch.mockReset();
    coverageMocks.premiumFetch.mockRejectedValue(new Error('offline'));
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
  });

  it('keeps coverage alive on close but aborts it when another brief opens', async () => {
    const signals: AbortSignal[] = [];
    let resolveCoverage!: (value: { headlines: NewsItem[]; timelineEvents: [] }) => void;
    const pending = new Promise<{ headlines: NewsItem[]; timelineEvents: [] }>(resolve => {
      resolveCoverage = resolve;
    });
    coverageMocks.fetchCountryCoverage.mockImplementation(
      (_country: string, _terms: string[], options: { signal: AbortSignal }) => {
        signals.push(options.signal);
        return signals.length === 1 ? pending : Promise.resolve({ headlines: [], timelineEvents: [] });
      },
    );
    const harness = createBriefHarness([]);
    await harness.bindClose();
    await harness.open();
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    harness.close();
    expect(signals[0]!.aborted).toBe(false);
    await harness.open();
    await vi.waitFor(() => expect(signals).toHaveLength(2));
    expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]!.aborted).toBe(false);
    const staleHeadline = newsItem('US announces stale coverage');
    resolveCoverage({ headlines: [staleHeadline], timelineEvents: [] });
    await pending;
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(harness.newsUpdates.flat()).not.toContainEqual(staleHeadline);
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

  it('passes only well-formed evidence items from the brief response to the page', async () => {
    coverageMocks.fetchCountryCoverage.mockResolvedValue({ headlines: [], timelineEvents: [] });
    const validItem = {
      id: 'E2',
      kind: 'resilience',
      label: 'Fiscal space',
      value: '28/100',
      factText: 'Fiscal space scores 28 of 100.',
      asOf: '2026-09-01',
      url: 'https://www.worldmonitor.app/country/US',
    };
    coverageMocks.premiumFetch.mockImplementation(async (url: string) => {
      if (!String(url).includes('get-country-intel-brief')) throw new Error('offline');
      return new Response(JSON.stringify({
        brief: 'SITUATION NOW\nFiscal space scores 28 of 100. [E2]',
        sources: [],
        evidence: [validItem, null, { label: 'No id', value: '1' }, { id: 7, label: 'Number id', value: '2' }, 'E3'],
        generatedAt: 1758585600000,
        cached: false,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    const { briefUpdates, open } = createBriefHarness([], { realBriefFetch: true });
    await open();
    await vi.waitFor(() => expect(briefUpdates.some((update) => update.brief)).toBe(true));

    const update = briefUpdates.find((entry) => entry.brief)!;
    expect(update.brief).toBe('SITUATION NOW\nFiscal space scores 28 of 100. [E2]');
    expect(update.evidence).toEqual([validItem]);
  });
});
