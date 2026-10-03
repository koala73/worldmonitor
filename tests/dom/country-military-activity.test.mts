import { describe, expect, it, vi } from 'vitest';
import type { CountryBriefSource } from '@/services/country-brief-source';

vi.mock('@/utils', () => import('@/utils/circuit-breaker'));
vi.mock('@/services/maritime', () => ({ registerAisCallback: vi.fn(), unregisterAisCallback: vi.fn(), isAisConfigured: () => false, initAisStream: vi.fn() }));
vi.mock('@/services/related-assets', () => ({ preloadInfrastructureTables: async () => {}, getNearbyInfrastructure: () => [{ id: 'base', name: 'Controlled base', distanceKm: 25 }] }));
import { isCountryActivityCoordinate, loadHostCountryMilitaryActivity, projectCountryMilitaryActivity, projectCountryMilitarySignalCounts } from '@/services/country-military-activity';
import * as geometry from '@/services/country-geometry';
import { classifyMilitaryVessel } from '@/services/military-vessels';

const own = { lat: 38, lon: -77, operatorCountry: 'US' };
const foreign = { lat: 39, lon: -76, operatorCountry: 'United Kingdom' };
const outside = { lat: 52, lon: 0, operatorCountry: 'US' };
const flight = (id: string, item = own) => ({ id, location: { latitude: item.lat, longitude: item.lon }, operatorCountry: item.operatorCountry });
function source(flights: ReturnType<typeof vi.fn>, aisAvailable = true) {
  return {
    military: { listMilitaryFlights: flights, getUSNIFleetReport: async () => ({}) },
    vessels: { getVesselSnapshot: async () => ({ dataAvailable: aisAvailable, snapshot: { snapshotAt: Date.now(), status: { connected: true }, candidateReports: [{ mmsi: '235123456', name: 'Controlled AIS', shipType: 35, lat: 38, lon: -77, timestamp: Date.now() }] } }) },
  } as unknown as CountryBriefSource;
}

describe('shared country military observations', () => {
  it('shares near and inside Signal counts without treating absent observations as zero', () => {
    const near = { lat: 50, lon: -77, operatorCountry: 'GB' };
    expect(projectCountryMilitarySignalCounts('US', [own, near, outside], [foreign, near])).toEqual({ militaryFlights: 2, militaryFlightsInCountry: 1, militaryVessels: 2, militaryVesselsInCountry: 1 });
    expect(projectCountryMilitarySignalCounts('US', null, [])).toEqual({ militaryFlights: null, militaryFlightsInCountry: null, militaryVessels: 0, militaryVesselsInCountry: 0 });
  });

  it('keeps precise negative geometry for inside Signals while retaining near-country activity', () => {
    vi.spyOn(geometry, 'isCoordinateInCountry').mockImplementation((_lat, lon) => lon === 2.3522);
    const paris = { lat: 48.8566, lon: 2.3522, operatorCountry: 'FR' };
    const zurich = { lat: 47.3769, lon: 8.5417, operatorCountry: 'CH' };
    expect(projectCountryMilitarySignalCounts('FR', [paris, zurich], [])).toEqual({ militaryFlights: 2, militaryFlightsInCountry: 1, militaryVessels: 0, militaryVesselsInCountry: 0 });
  });
  it('uses coarse bounds only when geometry is unavailable and retains precise inclusion outside them', () => {
    const coordinate = vi.spyOn(geometry, 'isCoordinateInCountry').mockReturnValue(null);
    expect(isCountryActivityCoordinate(48.8566, 2.3522, 'FR')).toBe(true);
    expect(isCountryActivityCoordinate(52, 0, 'FR')).toBe(false);
    coordinate.mockReturnValue(true);
    expect(isCountryActivityCoordinate(52, 0, 'FR')).toBe(true);
    expect(isCountryActivityCoordinate(Number.NaN, 0, 'FR')).toBe(false);
    expect(isCountryActivityCoordinate(52, Number.POSITIVE_INFINITY, 'FR')).toBe(false);
  });
  it('does not count a neighboring observation rejected by precise country geometry', () => {
    vi.spyOn(geometry, 'isCoordinateInCountry').mockImplementation((_lat, lon) => lon === 2.3522);
    const paris = { lat: 48.8566, lon: 2.3522, operatorCountry: 'FR' };
    const zurich = { lat: 47.3769, lon: 8.5417, operatorCountry: 'CH' };
    expect(isCountryActivityCoordinate(zurich.lat, zurich.lon, 'FR')).toBe(false);
    const summary = projectCountryMilitaryActivity('FR', 'France', [paris, zurich], [zurich]);
    expect(summary.ownFlights).toBe(1);
    expect(summary.foreignFlights).toBe(0);
    expect(summary.nearbyVessels).toBe(0);
    expect(summary.foreignPresence).toBe(false);
  });
  it('uses geography, own operator normalization and foreign vessels instead of counting the global snapshot', () => {
    const summary = projectCountryMilitaryActivity('US', 'United States', [own, foreign, outside], [foreign, outside]);
    expect(summary.ownFlights).toBe(1);
    expect(summary.foreignFlights).toBe(1);
    expect(summary.nearbyVessels).toBe(1);
    expect(summary.foreignPresence).toBe(true);
    expect(summary.nearestBases[0]?.name).toBe('Controlled base');
  });
  it('represents unavailable sources separately from confirmed empty observations', () => {
    expect(projectCountryMilitaryActivity('US', 'United States', null, []).ownFlights).toBeNull();
    expect(projectCountryMilitaryActivity('US', 'United States', null, []).foreignPresence).toBeNull();
    expect(projectCountryMilitaryActivity('US', 'United States', [], []).foreignPresence).toBe(false);
    expect(projectCountryMilitaryActivity('US', 'United States', null, [foreign]).foreignPresence).toBe(true);
  });
  it('preserves the website classification for generic AIS military activity and excludes a civil vessel', () => {
    expect(classifyMilitaryVessel({ mmsi: '235123456', name: 'Controlled AIS', shipType: 35, lat: 38, lon: -77 })?.vesselType).toBe('unknown');
    expect(classifyMilitaryVessel({ mmsi: '235123456', name: 'Controlled cargo', shipType: 70, lat: 38, lon: -77 })).toBeNull();
  });
  it('follows flight pages and retains vessels when flight pagination fails', async () => {
    const flights = vi.fn().mockImplementation(async (args: { cursor: string }) => args.cursor ? { flights: [flight('foreign', foreign)], pagination: { nextCursor: '' } } : { flights: [flight('own')], pagination: { nextCursor: 'next' } });
    const summary = await loadHostCountryMilitaryActivity(source(flights), 'US', 'United States', new AbortController().signal);
    expect(summary.ownFlights).toBe(1);
    expect(summary.foreignFlights).toBe(1);
    expect(summary.nearbyVessels).toBe(1);
    expect(flights.mock.calls.some(([args]) => args.cursor === 'next')).toBe(true);
    flights.mockImplementation(async () => ({ flights: [flight('own')], pagination: { nextCursor: 'same' } }));
    const partial = await loadHostCountryMilitaryActivity(source(flights), 'US', 'United States', new AbortController().signal);
    expect(partial.ownFlights).toBeNull();
    expect(partial.nearbyVessels).toBe(1);
    expect(partial.coverageNotes.join(' ')).toContain('not a zero');
  });
  it.each(['US', 'GB', 'RU'])('reads one valid global AIS candidate snapshot for %s', async code => {
    const reader = source(vi.fn().mockResolvedValue({ flights: [flight('own')] }));
    const snapshot = reader.vessels.getVesselSnapshot;
    reader.vessels.getVesselSnapshot = vi.fn(snapshot);
    await loadHostCountryMilitaryActivity(reader, code, code, new AbortController().signal);
    expect(reader.vessels.getVesselSnapshot).toHaveBeenCalledExactlyOnceWith({ neLat: 0, neLon: 0, swLat: 0, swLon: 0, includeCandidates: true, includeTankers: false }, { signal: expect.any(AbortSignal) });
  });
  it('skips invalid military report dates while retaining valid observations and partial coverage', async () => {
    const reader = source(vi.fn().mockResolvedValue({ flights: [flight('own')] }));
    reader.vessels.getVesselSnapshot = vi.fn().mockResolvedValue({ dataAvailable: true, snapshot: { snapshotAt: Date.now(), status: { connected: true }, candidateReports: [
      { mmsi: '235123456', name: 'Valid', shipType: 35, lat: 38, lon: -77, timestamp: Date.now() },
      ...[0, Number.NaN, Date.now() + 600_000].map((timestamp, index) => ({ mmsi: String(235123457 + index), name: 'Invalid', shipType: 35, lat: 38, lon: -77, timestamp })),
    ] } });
    const summary = await loadHostCountryMilitaryActivity(reader, 'US', 'United States', new AbortController().signal);
    expect(summary.nearbyVessels).toBe(1);
    expect(summary.foreignPresence).toBe(true);
    expect(summary.coverage).toBe('partial');
    expect(summary.coverageNotes.join(' ')).toContain('3 military reports with invalid dates excluded');
  });
  it('retains flights on an AIS outage and does not claim no foreign presence', async () => {
    const flights = vi.fn().mockResolvedValue({ flights: [flight('own')], pagination: { nextCursor: '' } });
    const summary = await loadHostCountryMilitaryActivity(source(flights, false), 'US', 'United States', new AbortController().signal);
    expect(summary.ownFlights).toBe(1);
    expect(summary.nearbyVessels).toBeNull();
    expect(summary.foreignPresence).toBeNull();
  });  it('retains independent observations when the fleet report is malformed', async () => {
    const flights = vi.fn().mockResolvedValue({ flights: [flight('own')], pagination: { nextCursor: '' } });
    const reader = source(flights);
    reader.military.getUSNIFleetReport = vi.fn().mockResolvedValue({ report: { vessels: [], timestamp: Number.NaN } });
    const summary = await loadHostCountryMilitaryActivity(reader, 'US', 'United States', new AbortController().signal);
    expect(summary.ownFlights).toBe(1);
    expect(summary.nearbyVessels).toBe(1);
    expect(summary.coverageNotes).toContain('USNI fleet roster unavailable.');
  });

});
