/**
 * The SVG map (the default renderer on phones) must apply the TIME RANGE
 * selector to every feed whose records carry a date, the same way DeckGLMap
 * does. Before this suite only earthquakes, ACLED conflicts and news followed
 * the selector, so a 24H view still drew week-old fires, outages, military
 * tracks and natural events.
 *
 * Runs against the real MapComponent.overlayFeedSlices(), the single slice
 * both the marker budget and the render loops read.
 */

import { expect, it } from 'vitest';

const HOUR = 60 * 60 * 1000;
const fresh = new Date(Date.now() - 2 * HOUR);
const stale = new Date(Date.now() - 3 * 24 * HOUR);

function pair<T>(make: (id: string, at: Date) => T): T[] {
  return [make('fresh', fresh), make('stale', stale)];
}

function feeds() {
  return {
    earthquakes: pair((id, at) => ({ id, magnitude: 5, occurredAt: at.getTime() })),
    conflictEvents: pair((id, at) => ({ id, occurredAt: at.getTime() })),
    iranEvents: pair((id, at) => ({ id, timestamp: at.getTime() })),
    protests: pair((id, at) => ({ id, time: at, sourceType: 'gdelt' })),
    weatherAlerts: pair((id, at) => ({ id, onset: at, centroid: [0, 0] })),
    naturalEvents: pair((id, at) => ({ id, date: at })),
    radiationObservations: pair((id, at) => ({ id, observedAt: at })),
    outages: pair((id, at) => ({ id, pubDate: at })),
    cableAdvisories: pair((id, at) => ({ id, reported: at })),
    flightDelays: pair((id, at) => ({ id, updatedAt: at })),
    militaryFlights: pair((id, at) => ({ id, lastSeen: at })),
    militaryVessels: pair((id, at) => ({ id, lastAisUpdate: at, vesselType: 'destroyer' })),
    militaryFlightClusters: [{
      id: 'mixed-flights',
      flightCount: 2,
      flights: pair((id, at) => ({ id, lastSeen: at })),
    }, {
      id: 'stale-flights',
      flightCount: 1,
      flights: [{ id: 'stale', lastSeen: stale }],
    }],
    militaryVesselClusters: [{
      id: 'mixed-vessels',
      vesselCount: 2,
      vessels: pair((id, at) => ({ id, lastAisUpdate: at })),
    }, {
      id: 'stale-vessels',
      vesselCount: 1,
      vessels: [{ id: 'stale', lastAisUpdate: stale }],
    }],
    firmsFireData: pair((id, at) => ({ id, acq_date: at.toISOString() })),
    aircraftPositions: [],
    newsLocations: [],
  };
}

const ALL_LAYERS = {
  natural: true, conflicts: true, iranAttacks: true, protests: true, weather: true,
  radiationWatch: true, outages: true, cables: true, flights: true, military: true, fires: true,
};

const DATED_SLICES = [
  'quakes', 'conflictEvents', 'iranEvents', 'protests', 'weather', 'naturalEvents',
  'radiationObservations', 'outages', 'cableAdvisories', 'flightDelays', 'militaryFlights',
  'militaryVessels', 'fires',
] as const;

async function mapWith(timeRange: string) {
  const { MapComponent } = await import('@/components/Map');
  const map = Object.create(MapComponent.prototype);
  Object.assign(map, { state: { layers: { ...ALL_LAYERS }, timeRange }, isMobile: false, ...feeds() });
  return map;
}

const ids = (items: readonly { id: string }[]) => items.map((item) => item.id);

it('drops records older than the selected window from every dated feed', async () => {
  const slices = (await mapWith('24h')).overlayFeedSlices();
  for (const key of DATED_SLICES) {
    expect(ids(slices[key]), key).toEqual(['fresh']);
  }
});

it('trims clustered military tracks to the window and drops clusters left empty', async () => {
  const slices = (await mapWith('24h')).overlayFeedSlices();
  expect(slices.militaryFlightClusters).toHaveLength(1);
  expect(ids(slices.militaryFlightClusters[0].flights)).toEqual(['fresh']);
  expect(slices.militaryFlightClusters[0].flightCount).toBe(1);
  expect(slices.militaryVesselClusters).toHaveLength(1);
  expect(ids(slices.militaryVesselClusters[0].vessels)).toEqual(['fresh']);
  expect(slices.militaryVesselClusters[0].vesselCount).toBe(1);
});

it('keeps every record when the window is ALL', async () => {
  const slices = (await mapWith('all')).overlayFeedSlices();
  for (const key of DATED_SLICES) {
    expect(ids(slices[key]), key).toEqual(['fresh', 'stale']);
  }
  expect(slices.militaryFlightClusters).toHaveLength(2);
  expect(slices.militaryVesselClusters).toHaveLength(2);
});

it('keeps records without a parseable date, matching DeckGLMap', async () => {
  const map = await mapWith('1h');
  map.outages = [{ id: 'undated', pubDate: undefined }, { id: 'invalid', pubDate: new Date('nope') }];
  expect(ids(map.overlayFeedSlices().outages)).toEqual(['undated', 'invalid']);
});
