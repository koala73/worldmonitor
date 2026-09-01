import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppContext } from '@/app/app-context';

const sourceMocks = vi.hoisted(() => ({
  fetchEarthquakes: vi.fn(),
  fetchNaturalEvents: vi.fn(),
  fetchProtestEvents: vi.fn(),
  fetchMilitaryFlights: vi.fn(),
  fetchUSNIFleetReport: vi.fn(),
  getProtestStatus: vi.fn(),
  fetchImdCycloneMarine: vi.fn(),
  getMilitaryVesselsModule: vi.fn(),
  getSignalAggregator: vi.fn(),
  updateAndCheck: vi.fn(),
  fetchCachedTheaterPosture: vi.fn(),
}));

vi.mock('@/services', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services')>(),
  fetchEarthquakes: sourceMocks.fetchEarthquakes,
  fetchNaturalEvents: sourceMocks.fetchNaturalEvents,
  fetchProtestEvents: sourceMocks.fetchProtestEvents,
  fetchMilitaryFlights: sourceMocks.fetchMilitaryFlights,
  fetchUSNIFleetReport: sourceMocks.fetchUSNIFleetReport,
  getProtestStatus: sourceMocks.getProtestStatus,
}));

vi.mock('@/services/imd-cyclone-marine', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/imd-cyclone-marine')>(),
  fetchImdCycloneMarine: sourceMocks.fetchImdCycloneMarine,
}));

vi.mock('@/services/military-vessels-lazy', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/military-vessels-lazy')>(),
  getMilitaryVesselsModule: sourceMocks.getMilitaryVesselsModule,
}));

vi.mock('@/app/lazy-services', () => ({
  getSignalAggregator: sourceMocks.getSignalAggregator,
}));

vi.mock('@/services/temporal-baseline', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/temporal-baseline')>(),
  updateAndCheck: sourceMocks.updateAndCheck,
}));

vi.mock('@/services/cached-theater-posture', () => ({
  fetchCachedTheaterPosture: sourceMocks.fetchCachedTheaterPosture,
}));

vi.mock('@/services/country-instability', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/country-instability')>(),
  isInLearningMode: () => true,
}));

// Move the data-loader graph transform out of individual test timeouts. The
// mocks above still apply to every cached import below.
await import('@/app/data-loader');

function makeLoader() {
  const ctx = {
    intelligenceCache: {},
    mapLayers: {},
    panels: {},
  } as unknown as AppContext;
  const refreshedCaches: Array<{
    earthquakes: unknown;
    protests: unknown;
    military: unknown;
  }> = [];
  const refreshOpenCountryTimeline = vi.fn(() => {
    refreshedCaches.push({
      earthquakes: ctx.intelligenceCache.earthquakes,
      protests: ctx.intelligenceCache.protests,
      military: ctx.intelligenceCache.military,
    });
  });

  return import('@/app/data-loader').then(({ DataLoaderManager }) => ({
    ctx,
    refreshedCaches,
    refreshOpenCountryTimeline,
    loader: new DataLoaderManager(ctx, {
      renderCriticalBanner: () => undefined,
      refreshOpenCountryBrief: () => undefined,
      refreshOpenCountryTimeline,
    }),
  }));
}

beforeEach(() => {
  sourceMocks.fetchEarthquakes.mockReset();
  sourceMocks.fetchNaturalEvents.mockReset();
  sourceMocks.fetchProtestEvents.mockReset();
  sourceMocks.fetchMilitaryFlights.mockReset();
  sourceMocks.fetchUSNIFleetReport.mockReset();
  sourceMocks.getProtestStatus.mockReset();
  sourceMocks.fetchImdCycloneMarine.mockReset();
  sourceMocks.getMilitaryVesselsModule.mockReset();
  sourceMocks.getSignalAggregator.mockReset();
  sourceMocks.updateAndCheck.mockReset();
  sourceMocks.fetchCachedTheaterPosture.mockReset();

  sourceMocks.fetchNaturalEvents.mockResolvedValue([]);
  sourceMocks.fetchImdCycloneMarine.mockResolvedValue({
    coverageState: 'disabled',
    cycloneEvents: [],
    portAlerts: [],
    marineBulletins: [],
  });
  sourceMocks.getProtestStatus.mockReturnValue({ acledConfigured: true });
  sourceMocks.fetchUSNIFleetReport.mockResolvedValue(null);
  sourceMocks.getSignalAggregator.mockResolvedValue({
    ingestProtests: vi.fn(),
    ingestFlights: vi.fn(),
    ingestVessels: vi.fn(),
  });
  sourceMocks.updateAndCheck.mockResolvedValue([]);
  sourceMocks.fetchCachedTheaterPosture.mockResolvedValue(null);
});

describe('DataLoaderManager country timeline refreshes', () => {
  it('refreshes after natural, protest, and military cache assignments', async () => {
    const earthquakes = [{
      id: 'earthquake-1',
      location: { latitude: 1, longitude: 2 },
      occurredAt: '2026-09-01T00:00:00.000Z',
    }];
    const protests = {
      events: [{ id: 'protest-1', lat: 3, lon: 4, time: new Date('2026-09-01T00:00:00.000Z') }],
      sources: { acled: 1, gdelt: 0 },
    };
    const military = {
      flights: [{ id: 'flight-1', lat: 5, lon: 6, lastSeen: new Date('2026-09-01T00:00:00.000Z') }],
      flightClusters: [],
      vessels: [{ id: 'vessel-1', lat: 7, lon: 8, lastAisUpdate: new Date('2026-09-01T00:00:00.000Z') }],
      vesselClusters: [],
    };
    sourceMocks.fetchEarthquakes.mockResolvedValue(earthquakes);
    sourceMocks.fetchProtestEvents.mockResolvedValue(protests);
    sourceMocks.fetchMilitaryFlights.mockResolvedValue({
      flights: military.flights,
      clusters: military.flightClusters,
    });
    sourceMocks.getMilitaryVesselsModule.mockResolvedValue({
      isMilitaryVesselTrackingConfigured: () => false,
      fetchMilitaryVessels: async () => ({
        vessels: military.vessels,
        clusters: military.vesselClusters,
      }),
    });
    const { ctx, loader, refreshedCaches, refreshOpenCountryTimeline } = await makeLoader();

    await loader.loadNatural();
    expect(refreshedCaches[refreshedCaches.length - 1]?.earthquakes).toBe(earthquakes);
    expect(ctx.intelligenceCache.earthquakes).toBe(earthquakes);

    await loader.loadProtests();
    expect(refreshedCaches[refreshedCaches.length - 1]?.protests).toBe(protests);
    expect(ctx.intelligenceCache.protests).toBe(protests);

    await loader.loadMilitary();
    expect(refreshedCaches[refreshedCaches.length - 1]?.military).toEqual(military);
    expect(ctx.intelligenceCache.military).toEqual(military);
    expect(refreshOpenCountryTimeline).toHaveBeenCalledTimes(3);
  });

  it('does not report a fresh timeline when the protest fetch fails', async () => {
    sourceMocks.fetchProtestEvents.mockRejectedValue(new Error('offline'));
    const { ctx, loader, refreshOpenCountryTimeline } = await makeLoader();

    await loader.loadProtests();

    expect(ctx.intelligenceCache.protests).toBeUndefined();
    expect(refreshOpenCountryTimeline).not.toHaveBeenCalled();
  });

  it('keeps conflict cache assignment before the timeline refresh contract', async () => {
    // loadIntelligenceSignals starts every intelligence source at once, so a
    // runtime fixture for its conflict branch would need unrelated loaders.
    // Pin the small ordered branch instead.
    const source = await readFile(resolve(process.cwd(), 'src/app/data-loader.ts'), 'utf8');
    const conflictBranch = source.match(
      /const conflictData = await fetchConflictEvents\(\);([\s\S]*?)if \(conflictData\.count > 0\)/,
    )?.[1];

    expect(conflictBranch).toBeDefined();
    expect(conflictBranch?.indexOf('this.ctx.intelligenceCache.conflicts = conflictData.events;'))
      .toBeLessThan(conflictBranch?.indexOf('this.callbacks.refreshOpenCountryTimeline?.();') ?? -1);
  });
});
