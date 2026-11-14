import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppContext } from '@/app/app-context';
import type { ConflictEvent } from '@/services/conflict';
import { dataFreshness } from '@/services/data-freshness';
import type { Earthquake } from '@/services/earthquakes';
import type { ExposureCoverage, PopulationExposure, SocialUnrestEvent } from '@/types';

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

vi.mock('@/services/cached-theater-posture',()=>({fetchCachedTheaterPosture:async()=>null}));

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
  const refreshOpenCountryMilitary = vi.fn();
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
    panelSettings: {},
    isDestroyed: false,
  } as unknown as AppContext;
  const { DataLoaderManager } = await import('@/app/data-loader');
  const loader = new DataLoaderManager(ctx, {
    renderCriticalBanner: () => undefined,
    refreshOpenCountryBrief: () => undefined,
    refreshOpenCountryMilitary,
    refreshOpenCountryTimeline,
  });
  return { loader, ctx, refreshOpenCountryMilitary, refreshOpenCountryTimeline };
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
    vesselsModule.fetchMilitaryVessels.mockReset().mockResolvedValue({ vessels: [], clusters: [] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
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

  it('limits only eligible locations and keeps UCDP estimates after a failed refresh', async () => {
    const acled = {
      ...protestEvent, id: 'aden', city: 'Aden', country: 'Yemen', lat: 12.8, lon: 45,
      hasPreciseLocation: true,
    };
    const ucdp = {
      id: 'taiz', locationName: 'Taiz', country: 'Yemen', latitude: 13.58, longitude: 44.02,
      type_of_violence: 'state-based', hasPreciseLocation: true,
    };
    const unsupportedAcled = Array.from({ length: 10 }, (_, i) => ({
      ...acled, id: `unsupported-acled-${i}`, country: 'Chile', lat: -33.45, lon: -70.67,
    }));
    const unsupportedUcdp = Array.from({ length: 10 }, (_, i) => ({
      ...ucdp, id: `unsupported-ucdp-${i}`, latitude: 91,
    }));
    mocks.fetchProtestEvents.mockResolvedValue({ ...protestData, events: [...unsupportedAcled, acled] });
    const fullFeed = (data: unknown[], fromCache: boolean) => ({
      success: true, data, fromCache, exposure: { source: 'full-feed', events: data },
    });
    mocks.fetchUcdpEvents
      .mockResolvedValueOnce(fullFeed([...unsupportedUcdp, ucdp], false))
      .mockResolvedValueOnce({ success: false, data: [] })
      .mockResolvedValueOnce(fullFeed([ucdp], true))
      .mockResolvedValueOnce(fullFeed([ucdp], false));
    const { loader, ctx } = await makeLoader();
    const recordUpdate = vi.spyOn(dataFreshness, 'recordUpdate');
    const recordError = vi.spyOn(dataFreshness, 'recordError');
    const setExposures = vi.fn<(exposures: PopulationExposure[], hasCachedUcdp: boolean, coverage?: ExposureCoverage) => void>();
    ctx.panels['population-exposure'] = { setExposures } as unknown as AppContext['panels'][string];

    await loader.loadIntelligenceSignals();
    // App replaces this cache before each scheduled intelligence refresh.
    ctx.intelligenceCache = {};
    await loader.loadIntelligenceSignals();
    ctx.intelligenceCache = {};
    await loader.loadIntelligenceSignals();
    ctx.intelligenceCache = {};
    await loader.loadIntelligenceSignals();

    expect(setExposures.mock.calls.map(([, hasCachedUcdp]) => hasCachedUcdp)).toEqual([false, true, true, false]);
    expect(setExposures.mock.calls[0]?.[2]).toEqual({
      totalEvents: 22, withoutPreciseLocation: 0, withoutEstimate: 20, atOtherPlaces: 0,
    });
    for (const [exposures] of setExposures.mock.calls) {
      expect(exposures.map(exposure => exposure.eventId)).toEqual(['aden', 'taiz']);
    }
    expect(recordUpdate.mock.calls.filter(([source]) => source === 'worldpop')).toEqual([['worldpop', 2], ['worldpop', 2]]);
    expect(recordError).toHaveBeenCalledWith('worldpop', 'Exposure source data unavailable');
  });

  it('uses separate UCDP exposure rows while preserving the UCDP panel projection', async () => {
    const point = {
      id: 'eligible', locationName: 'Taiz', country: 'Yemen', latitude: 13.58, longitude: 44.02,
      type_of_violence: 'state-based', hasPreciseLocation: true,
    };
    const projected = Array.from({ length: 50 }, (_, i) => ({
      ...point, id: `projected-${i}`, hasPreciseLocation: false,
    }));
    const aggregates = { UCDP_VIOLENCE_TYPE_STATE_BASED: { count: 51, totalDeaths: 0 } };
    const hydrated = { events: projected, totalEvents: 51, aggregates, exposureEvents: [point] };
    mocks.getHydratedData.mockImplementation(key => key === 'ucdpEvents' ? hydrated : undefined);
    mocks.fetchProtestEvents.mockResolvedValue({ ...protestData, events: [] });
    const exposureCoverage = { totalEvents: 51, withoutPreciseLocation: 50, withoutEstimate: 0, atOtherPlaces: 0 };
    mocks.fetchUcdpEvents.mockResolvedValueOnce({
      success: true, data: projected, fromCache: false,
      exposure: { source: 'projection', events: [point], coverage: exposureCoverage },
    });
    const { loader, ctx } = await makeLoader();
    const setExposures = vi.fn();
    const setEvents = vi.fn();
    ctx.panels['population-exposure'] = { setExposures } as unknown as AppContext['panels'][string];
    ctx.panels['ucdp-events'] = { setEvents } as unknown as AppContext['panels'][string];

    await loader.loadIntelligenceSignals();

    expect(mocks.fetchUcdpEvents.mock.calls).toEqual([[hydrated]]);
    expect(setEvents).toHaveBeenCalledExactlyOnceWith(projected, aggregates);
    expect(setExposures).toHaveBeenCalledExactlyOnceWith(
      [expect.objectContaining({ eventId: 'eligible' })], false, exposureCoverage,
      expect.objectContaining({ ucdpIsProjection: true, ucdp: [expect.objectContaining({ id: 'eligible' })] }),
    );
  });

  it('keeps unrest coverage when the projection predates UCDP coverage', async () => {
    const point = {
      id: 'eligible', locationName: 'Taiz', country: 'Yemen', latitude: 13.58, longitude: 44.02,
      type_of_violence: 'state-based', hasPreciseLocation: true, eventCount: 2,
    };
    mocks.fetchProtestEvents.mockResolvedValue({ ...protestData, events: [
      { ...protestEvent, id: 'aden', city: 'Aden', country: 'Yemen', lat: 12.8, lon: 45, hasPreciseLocation: true },
    ] });
    mocks.fetchUcdpEvents.mockResolvedValueOnce({
      success: true, data: [point], fromCache: false, exposure: { source: 'projection', events: [point] },
    });
    const { loader, ctx } = await makeLoader();
    const setExposures = vi.fn();
    ctx.panels['population-exposure'] = { setExposures } as unknown as AppContext['panels'][string];

    await loader.loadIntelligenceSignals();

    expect(setExposures).toHaveBeenCalledExactlyOnceWith(
      expect.arrayContaining([expect.objectContaining({ eventId: 'eligible', eventCount: 2 })]), false,
      { totalEvents: 1, withoutPreciseLocation: 0, withoutEstimate: 0, atOtherPlaces: 0, ucdpPending: true },
      expect.any(Object),
    );
  });

  it('keeps legacy UCDP rows pending through the real adapter and excludes explicit imprecision', async () => {
    const { fetchUcdpEvents } = await vi.importActual<typeof import('@/services/conflict')>('@/services/conflict');
    const point = {
      id: 'legacy', country: 'Yemen', locationName: 'Taiz', location: { latitude: 13.58, longitude: 44.02 },
      dateStart: 0, dateEnd: 0, sideA: 'A', sideB: 'B', deathsBest: 0, deathsLow: 0, deathsHigh: 0,
      violenceType: 'UCDP_VIOLENCE_TYPE_STATE_BASED', sourceOriginal: '',
    };
    const response = await fetchUcdpEvents({
      events: [point, { ...point, id: 'broad', hasPreciseLocation: false }],
    } as Parameters<typeof fetchUcdpEvents>[0]);
    expect(response.data.map(e => e.hasPreciseLocation)).toEqual([undefined, false]);
    mocks.fetchUcdpEvents.mockResolvedValueOnce(response);
    mocks.fetchProtestEvents.mockResolvedValue({ ...protestData, events: [] });
    const { loader, ctx } = await makeLoader();
    const setExposures = vi.fn();
    ctx.panels['population-exposure'] = { setExposures } as unknown as AppContext['panels'][string];
    await loader.loadIntelligenceSignals();
    expect(setExposures).toHaveBeenCalledExactlyOnceWith(
      [expect.objectContaining({ eventId: 'legacy', locationPending: true })], false,
      { totalEvents: 0, withoutPreciseLocation: 0, withoutEstimate: 0, atOtherPlaces: 0, ucdpPending: true }, expect.any(Object),
    );
  });

  it('counts UCDP coverage alone when the unrest feed is unavailable', async () => {
    const point = {
      id: 'eligible', locationName: 'Taiz', country: 'Yemen', latitude: 13.58, longitude: 44.02,
      type_of_violence: 'state-based', hasPreciseLocation: true, eventCount: 2,
    };
    const coverage = { totalEvents: 9, withoutPreciseLocation: 4, withoutEstimate: 3, atOtherPlaces: 0 };
    mocks.fetchUcdpEvents.mockResolvedValueOnce({
      success: true, data: [point], fromCache: false, exposure: { source: 'projection', events: [point], coverage },
    });
    const { loader, ctx } = await makeLoader();
    const setExposures = vi.fn();
    ctx.panels['population-exposure'] = { setExposures } as unknown as AppContext['panels'][string];

    await loader.loadIntelligenceSignals();

    expect(ctx.intelligenceCache.protests).toBeUndefined();
    expect(setExposures).toHaveBeenCalledExactlyOnceWith(
      [expect.objectContaining({ eventId: 'eligible' })], false, coverage, expect.any(Object),
    );
  });

  it.each(['unrest', 'ucdp', 'neither'] as const)(
    'distinguishes a cold source failure from a successful empty exposure result: %s',
    async (failedSource) => {
      if (failedSource !== 'unrest') {
        mocks.fetchProtestEvents.mockResolvedValue({ ...protestData, events: [] });
      }
      const data = failedSource === 'ucdp' ? [] : [{
        id: 'imprecise-row', country: 'Yemen', latitude: 13.58, longitude: 44.02, hasPreciseLocation: false,
        side_a: 'Side A', side_b: 'Side B', type_of_violence: 'state-based',
      }];
      mocks.fetchUcdpEvents.mockResolvedValue({
        success: failedSource !== 'ucdp', data, exposure: { source: 'full-feed', events: data },
      });
      const { loader, ctx } = await makeLoader();
      const setExposures = vi.fn();
      const showError = vi.fn();
      ctx.panels['population-exposure'] = { setExposures, showError } as unknown as AppContext['panels'][string];

      await loader.loadIntelligenceSignals();

      if (failedSource === 'neither') {
        expect(showError).not.toHaveBeenCalled();
        expect(setExposures).toHaveBeenCalledExactlyOnceWith([], false, expect.objectContaining({ withoutPreciseLocation: 1 }), expect.any(Object));
      } else {
        expect(showError).toHaveBeenCalledOnce();
        expect(setExposures).not.toHaveBeenCalled();
      }
    },
  );

  it('invokes refreshOpenCountryTimeline after loadMilitary assigns tracks', async () => {
    mocks.fetchMilitaryFlights.mockResolvedValueOnce({ flights: [flight], clusters: [],dataState:{mode:'cached',timestamp:1000,offline:false} });
    vesselsModule.fetchMilitaryVessels.mockResolvedValueOnce({vessels:[],clusters:[],dataState:{mode:'live',timestamp:2000,offline:false},negativeEvidenceConfirmed:false,coverageNotes:['partial roster']} as never);
    const { loader, ctx, refreshOpenCountryMilitary, refreshOpenCountryTimeline } = await makeLoader();
    refreshOpenCountryTimeline.mockImplementation(() => {
      expect(ctx.intelligenceCache.military).toEqual({
        flights: [flight],
        flightClusters: [],
        vessels: [],
        vesselClusters: [],
        flightDataState: {mode:'cached',timestamp:1000,offline:false},
        vesselDataState: {mode:'live',timestamp:2000,offline:false},
        vesselNegativeEvidenceConfirmed: false,
        vesselCoverageNotes: ['partial roster'],
      });
    });

    await loader.loadMilitary();

    expect(refreshOpenCountryTimeline).toHaveBeenCalledOnce();
    expect(refreshOpenCountryMilitary).toHaveBeenCalledOnce();
    expect(ctx.intelligenceCache.military?.flights).toEqual([flight]);
  });

  it('invokes refreshOpenCountryTimeline after the intelligence military path assigns cache', async () => {
    mocks.fetchMilitaryFlights.mockResolvedValueOnce({ flights: [flight], clusters: [],dataState:{mode:'cached',timestamp:1000,offline:false} });
    vesselsModule.fetchMilitaryVessels.mockResolvedValueOnce({vessels:[],clusters:[],dataState:{mode:'live',timestamp:2000,offline:false},negativeEvidenceConfirmed:false,coverageNotes:['partial roster']} as never);
    const { loader, ctx, refreshOpenCountryMilitary, refreshOpenCountryTimeline } = await makeLoader();
    refreshOpenCountryTimeline.mockImplementation(() => {
      expect(ctx.intelligenceCache.military).toEqual({
        flights: [flight],
        flightClusters: [],
        vessels: [],
        vesselClusters: [],
        flightDataState: {mode:'cached',timestamp:1000,offline:false},
        vesselDataState: {mode:'live',timestamp:2000,offline:false},
        vesselNegativeEvidenceConfirmed: false,
        vesselCoverageNotes: ['partial roster'],
      });
    });

    await loader.loadIntelligenceSignals();

    expect(refreshOpenCountryTimeline).toHaveBeenCalledOnce();
    expect(refreshOpenCountryMilitary).toHaveBeenCalledOnce();
    expect(ctx.intelligenceCache.military?.flights).toEqual([flight]);
  });
  it('warm military cache retains observation metadata and performs no new source reads',async()=>{
    const {loader,ctx}=await makeLoader();
    const cached={flights:[flight],flightClusters:[],vessels:[],vesselClusters:[],flightDataState:{mode:'cached' as const,timestamp:1000,offline:false},vesselDataState:{mode:'unavailable' as const,timestamp:null,offline:false},vesselNegativeEvidenceConfirmed:false,vesselCoverageNotes:['retained partial']};
    ctx.intelligenceCache.military=cached;await loader.loadMilitary();
    expect(ctx.intelligenceCache.military).toBe(cached);expect(mocks.fetchMilitaryFlights).not.toHaveBeenCalled();expect(vesselsModule.fetchMilitaryVessels).not.toHaveBeenCalled();expect(ctx.intelligenceCache.military?.vesselCoverageNotes).toEqual(['retained partial']);
  });

});
