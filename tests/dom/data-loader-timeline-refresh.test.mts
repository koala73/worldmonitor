import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppContext } from '@/app/app-context';
import type { ConflictEvent } from '@/services/conflict';
import type { Earthquake } from '@/services/earthquakes';
import type { SocialUnrestEvent } from '@/types';

const mocks = vi.hoisted(() => ({
  fetchEarthquakes: vi.fn(),
  fetchNaturalEvents: vi.fn(),
  fetchImdCycloneMarine: vi.fn(),
  fetchProtestEvents: vi.fn(),
  getProtestStatus: vi.fn(() => ({ acledConfigured: true, gdeltAvailable: true })),
  fetchConflictEvents: vi.fn(),
  fetchUcdpEvents: vi.fn(),
  fetchMilitaryFlights: vi.fn(),
  getMilitaryVesselsModule: vi.fn(),
  fetchInternetOutages: vi.fn(),
  fetchUnhcrPopulation: vi.fn(),
  fetchClimateAnomalies: vi.fn(),
  fetchSecurityAdvisories: vi.fn(),
  fetchUSNIFleetReport: vi.fn(),
  getHydratedData: vi.fn(),
  isDesktopRuntime: vi.fn(() => true),
  hasPremiumAccess: vi.fn(() => false),
  isInLearningMode: vi.fn(() => true),
  getCachedScores: vi.fn(() => null),
  getSignalAggregator: vi.fn(),
  updateAndCheck: vi.fn(),
  enrichEventsWithExposure: vi.fn(),
}));

vi.mock('@/services/earthquakes', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/earthquakes')>(),
  fetchEarthquakes: mocks.fetchEarthquakes,
}));

vi.mock('@/services/eonet', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/eonet')>(),
  fetchNaturalEvents: mocks.fetchNaturalEvents,
}));

vi.mock('@/services/imd-cyclone-marine', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/imd-cyclone-marine')>(),
  fetchImdCycloneMarine: mocks.fetchImdCycloneMarine,
}));

vi.mock('@/services/unrest', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/unrest')>(),
  fetchProtestEvents: mocks.fetchProtestEvents,
  getProtestStatus: mocks.getProtestStatus,
}));

vi.mock('@/services/conflict', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/conflict')>(),
  fetchConflictEvents: mocks.fetchConflictEvents,
  fetchUcdpEvents: mocks.fetchUcdpEvents,
}));

vi.mock('@/services/military-flights', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/military-flights')>(),
  fetchMilitaryFlights: mocks.fetchMilitaryFlights,
}));

vi.mock('@/services/military-vessels-lazy', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/military-vessels-lazy')>(),
  getMilitaryVesselsModule: mocks.getMilitaryVesselsModule,
}));

vi.mock('@/services/infrastructure', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/infrastructure')>(),
  fetchInternetOutages: mocks.fetchInternetOutages,
}));

vi.mock('@/services/displacement', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/displacement')>(),
  fetchUnhcrPopulation: mocks.fetchUnhcrPopulation,
}));

vi.mock('@/services/climate', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/climate')>(),
  fetchClimateAnomalies: mocks.fetchClimateAnomalies,
}));

vi.mock('@/services/security-advisories', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/security-advisories')>(),
  fetchSecurityAdvisories: mocks.fetchSecurityAdvisories,
}));

vi.mock('@/services/usni-fleet', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/usni-fleet')>(),
  fetchUSNIFleetReport: mocks.fetchUSNIFleetReport,
}));

vi.mock('@/services/bootstrap', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/bootstrap')>(),
  getHydratedData: mocks.getHydratedData,
}));

vi.mock('@/services/runtime', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/runtime')>(),
  isDesktopRuntime: mocks.isDesktopRuntime,
}));

vi.mock('@/services/panel-gating', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/panel-gating')>(),
  hasPremiumAccess: mocks.hasPremiumAccess,
}));

vi.mock('@/services/country-instability', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/country-instability')>(),
  isInLearningMode: mocks.isInLearningMode,
}));

vi.mock('@/services/cached-risk-scores', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/cached-risk-scores')>(),
  getCachedScores: mocks.getCachedScores,
}));

vi.mock('@/app/lazy-services', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/app/lazy-services')>(),
  getSignalAggregator: mocks.getSignalAggregator,
}));

vi.mock('@/services/temporal-baseline', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/temporal-baseline')>(),
  updateAndCheck: mocks.updateAndCheck,
}));

vi.mock('@/services/population-exposure', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/population-exposure')>(),
  enrichEventsWithExposure: mocks.enrichEventsWithExposure,
}));

// #6677: move the data-loader graph transform into the file import phase.
await import('@/app/data-loader');

const emptyImd = {
  coverageState: 'unavailable',
  cycloneEvents: [],
  portAlerts: [],
  marineBulletins: [],
  sourceName: 'India Meteorological Department',
  sourceUrl: 'https://api.imd.gov.in/public/api_reference.html',
};

const vesselsModule = {
  isMilitaryVesselTrackingConfigured: () => false,
  initMilitaryVesselStream: vi.fn(),
  fetchMilitaryVessels: vi.fn(async () => ({ vessels: [], clusters: [] })),
};

const earthquake: Earthquake = {
  id: 'eq-1',
  place: 'California',
  magnitude: 4.2,
  depthKm: 10,
  location: { latitude: 34.05, longitude: -118.25 },
  occurredAt: Date.parse('2026-09-01T00:00:00.000Z'),
  sourceUrl: 'https://example.test/eq-1',
  source: 'usgs',
  category: 'earthquake',
};

const protestEvent = {
  id: 'fr-protest-1',
  title: 'National protest in France',
  eventType: 'protest',
  country: 'France',
  lat: 48.8566,
  lon: 2.3522,
  time: new Date('2026-09-01T12:00:00.000Z'),
  severity: 'medium',
  sources: ['test'],
  sourceType: 'rss',
  confidence: 'high',
  validated: true,
} as SocialUnrestEvent;

const protestData = {
  events: [protestEvent],
  byCountry: new Map<string, SocialUnrestEvent[]>([['France', [protestEvent]]]),
  highSeverityCount: 0,
  sources: { acled: 1, gdelt: 0 },
};

const conflictEvent: ConflictEvent = {
  id: 'ua-conflict-1',
  eventType: 'battle',
  subEventType: '',
  country: 'Ukraine',
  location: 'Kyiv',
  lat: 50.45,
  lon: 30.52,
  time: new Date('2026-09-01T12:00:00.000Z'),
  fatalities: 0,
  actors: [],
  source: 'test',
};

const conflictData = {
  events: [conflictEvent],
  byCountry: new Map<string, ConflictEvent[]>([['Ukraine', [conflictEvent]]]),
  totalFatalities: 0,
  count: 1,
};

const flight = { id: 'flight-1', lat: 51.5, lon: -0.1 } as never;

async function makeLoader() {
  const refreshOpenCountryTimeline = vi.fn();
  const ctx = {
    intelligenceCache: {},
    mapLayers: {},
    map: {
      setEarthquakes: vi.fn(),
      setNaturalEvents: vi.fn(),
      setProtests: vi.fn(),
      setLayerReady: vi.fn(),
      setMilitaryFlights: vi.fn(),
      setMilitaryVessels: vi.fn(),
      updateMilitaryForEscalation: vi.fn(),
      setCIIScores: vi.fn(),
    },
    statusPanel: { updateApi: vi.fn(), updateFeed: vi.fn() },
    panels: {},
    isDestroyed: false,
  } as unknown as AppContext;
  const { DataLoaderManager } = await import('@/app/data-loader');
  const loader = new DataLoaderManager(ctx, {
    renderCriticalBanner: () => undefined,
    refreshOpenCountryBrief: () => undefined,
    refreshOpenCountryTimeline,
  });
  return { loader, ctx, refreshOpenCountryTimeline };
}

describe('DataLoaderManager cache-to-timeline callbacks', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('unexpected fetch in timeline callback test');
    }));
    mocks.fetchEarthquakes.mockReset().mockRejectedValue(new Error('earthquakes unused'));
    mocks.fetchNaturalEvents.mockReset().mockResolvedValue([]);
    mocks.fetchImdCycloneMarine.mockReset().mockResolvedValue(emptyImd);
    mocks.fetchProtestEvents.mockReset().mockRejectedValue(new Error('protests unused'));
    mocks.getProtestStatus.mockReset().mockReturnValue({ acledConfigured: true, gdeltAvailable: true });
    mocks.fetchConflictEvents.mockReset().mockRejectedValue(new Error('conflicts unused'));
    mocks.fetchUcdpEvents.mockReset().mockRejectedValue(new Error('ucdp unused'));
    mocks.fetchMilitaryFlights.mockReset().mockRejectedValue(new Error('flights unused'));
    mocks.getMilitaryVesselsModule.mockReset().mockResolvedValue(vesselsModule);
    mocks.fetchInternetOutages.mockReset().mockRejectedValue(new Error('outages unused'));
    mocks.fetchUnhcrPopulation.mockReset().mockRejectedValue(new Error('unhcr unused'));
    mocks.fetchClimateAnomalies.mockReset().mockRejectedValue(new Error('climate unused'));
    mocks.fetchSecurityAdvisories.mockReset().mockRejectedValue(new Error('advisories unused'));
    mocks.fetchUSNIFleetReport.mockReset().mockResolvedValue(null);
    mocks.getHydratedData.mockReset().mockReturnValue(undefined);
    mocks.isDesktopRuntime.mockReset().mockReturnValue(true);
    mocks.hasPremiumAccess.mockReset().mockReturnValue(false);
    mocks.isInLearningMode.mockReset().mockReturnValue(true);
    mocks.getCachedScores.mockReset().mockReturnValue(null);
    mocks.getSignalAggregator.mockReset().mockResolvedValue({
      ingestOutages: vi.fn(),
      ingestProtests: vi.fn(),
      ingestFlights: vi.fn(),
      ingestVessels: vi.fn(),
    });
    mocks.updateAndCheck.mockReset().mockResolvedValue([]);
    mocks.enrichEventsWithExposure.mockReset().mockResolvedValue([]);
    vesselsModule.fetchMilitaryVessels.mockReset().mockResolvedValue({ vessels: [], clusters: [] });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('invokes refreshOpenCountryTimeline after loadNatural assigns earthquakes', async () => {
    mocks.fetchEarthquakes.mockResolvedValueOnce([earthquake]);
    const { loader, ctx, refreshOpenCountryTimeline } = await makeLoader();
    refreshOpenCountryTimeline.mockImplementation(() => {
      expect(ctx.intelligenceCache.earthquakes).toEqual([earthquake]);
    });

    await loader.loadNatural();

    expect(refreshOpenCountryTimeline).toHaveBeenCalledOnce();
    expect(ctx.intelligenceCache.earthquakes).toEqual([earthquake]);
  });

  it('invokes refreshOpenCountryTimeline after loadProtests assigns cache', async () => {
    mocks.fetchProtestEvents.mockResolvedValueOnce(protestData);
    const { loader, ctx, refreshOpenCountryTimeline } = await makeLoader();
    refreshOpenCountryTimeline.mockImplementation(() => {
      expect(ctx.intelligenceCache.protests).toEqual(protestData);
    });

    await loader.loadProtests();

    expect(refreshOpenCountryTimeline).toHaveBeenCalledOnce();
    expect(ctx.intelligenceCache.protests).toEqual(protestData);
  });

  it('invokes refreshOpenCountryTimeline after the intelligence protest path assigns cache', async () => {
    mocks.fetchProtestEvents.mockResolvedValueOnce(protestData);
    const { loader, ctx, refreshOpenCountryTimeline } = await makeLoader();
    refreshOpenCountryTimeline.mockImplementation(() => {
      expect(ctx.intelligenceCache.protests).toEqual(protestData);
    });

    await loader.loadIntelligenceSignals();

    expect(refreshOpenCountryTimeline).toHaveBeenCalledOnce();
    expect(ctx.intelligenceCache.protests).toEqual(protestData);
  });

  it('invokes refreshOpenCountryTimeline after the intelligence conflict path assigns cache', async () => {
    mocks.fetchConflictEvents.mockResolvedValueOnce(conflictData);
    const { loader, ctx, refreshOpenCountryTimeline } = await makeLoader();
    refreshOpenCountryTimeline.mockImplementation(() => {
      expect(ctx.intelligenceCache.conflicts).toEqual(conflictData.events);
    });

    await loader.loadIntelligenceSignals();

    expect(refreshOpenCountryTimeline).toHaveBeenCalledOnce();
    expect(ctx.intelligenceCache.conflicts).toEqual(conflictData.events);
  });

  it('invokes refreshOpenCountryTimeline after loadMilitary assigns tracks', async () => {
    mocks.fetchMilitaryFlights.mockResolvedValueOnce({ flights: [flight], clusters: [] });
    const { loader, ctx, refreshOpenCountryTimeline } = await makeLoader();
    refreshOpenCountryTimeline.mockImplementation(() => {
      expect(ctx.intelligenceCache.military).toEqual({
        flights: [flight],
        flightClusters: [],
        vessels: [],
        vesselClusters: [],
      });
    });

    await loader.loadMilitary();

    expect(refreshOpenCountryTimeline).toHaveBeenCalledOnce();
    expect(ctx.intelligenceCache.military?.flights).toEqual([flight]);
  });

  it('invokes refreshOpenCountryTimeline after the intelligence military path assigns cache', async () => {
    mocks.fetchMilitaryFlights.mockResolvedValueOnce({ flights: [flight], clusters: [] });
    const { loader, ctx, refreshOpenCountryTimeline } = await makeLoader();
    refreshOpenCountryTimeline.mockImplementation(() => {
      expect(ctx.intelligenceCache.military).toEqual({
        flights: [flight],
        flightClusters: [],
        vessels: [],
        vesselClusters: [],
      });
    });

    await loader.loadIntelligenceSignals();

    expect(refreshOpenCountryTimeline).toHaveBeenCalledOnce();
    expect(ctx.intelligenceCache.military?.flights).toEqual([flight]);
  });
});
