declare const process: { env: Record<string, string | undefined> };

import type {
  ServerContext,
  GetTheaterPostureRequest,
  GetTheaterPostureResponse,
  TheaterPosture,
} from '../../../../src/generated/server/worldmonitor/military/v1/service_server';

import { getCachedJson, setCachedJson } from '../../../_shared/redis';
import {
  isMilitaryCallsign,
  isMilitaryHex,
  detectAircraftType,
  POSTURE_THEATERS,
  UPSTREAM_TIMEOUT_MS,
  type RawFlight,
} from './_shared';
import { CHROME_UA } from '../../../_shared/constants';

const CACHE_KEY = 'theater-posture:sebuf:v1';
const STALE_CACHE_KEY = 'theater-posture:sebuf:stale:v1';
const BACKUP_CACHE_KEY = 'theater-posture:sebuf:backup:v1';
const CACHE_TTL = 300;
const STALE_TTL = 86400;
const BACKUP_TTL = 604800;

// ========================================================================
// Flight fetching (OpenSky + Wingbits fallback)
// ========================================================================

async function fetchMilitaryFlightsFromOpenSky(): Promise<RawFlight[]> {
  const isSidecar = (process.env.LOCAL_API_MODE || '').includes('sidecar');
  const baseUrl = isSidecar
    ? 'https://opensky-network.org/api/states/all'
    : process.env.WS_RELAY_URL ? process.env.WS_RELAY_URL + '/opensky' : null;

  if (!baseUrl) return [];

  const resp = await fetch(baseUrl, {
    headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`OpenSky API error: ${resp.status}`);

  const data = (await resp.json()) as { states?: Array<[string, string, ...unknown[]]> };
  if (!data.states) return [];

  const flights: RawFlight[] = [];
  for (const state of data.states) {
    const [icao24, callsign, , , , lon, lat, altitude, onGround, velocity, heading] = state as [
      string, string, unknown, unknown, unknown, number | null, number | null, number | null, boolean, number | null, number | null,
    ];
    if (lat == null || lon == null || onGround) continue;
    if (!isMilitaryCallsign(callsign) && !isMilitaryHex(icao24)) continue;

    flights.push({
      id: icao24,
      callsign: callsign?.trim() || '',
      lat, lon,
      altitude: altitude ?? 0,
      heading: heading ?? 0,
      speed: (velocity as number) ?? 0,
      aircraftType: detectAircraftType(callsign),
    });
  }
  return flights;
}

async function fetchMilitaryFlightsFromWingbits(): Promise<RawFlight[] | null> {
  const apiKey = process.env.WINGBITS_API_KEY;
  if (!apiKey) return null;

  const areas = POSTURE_THEATERS.map((t) => ({
    alias: t.id,
    by: 'box',
    la: (t.bounds.north + t.bounds.south) / 2,
    lo: (t.bounds.east + t.bounds.west) / 2,
    w: Math.abs(t.bounds.east - t.bounds.west) * 60,
    h: Math.abs(t.bounds.north - t.bounds.south) * 60,
    unit: 'nm',
  }));

  try {
    const resp = await fetch('https://customer-api.wingbits.com/v1/flights', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': CHROME_UA },
      body: JSON.stringify(areas),
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) return null;

    const data = (await resp.json()) as Array<{ flights?: Array<Record<string, unknown>> }>;
    const flights: RawFlight[] = [];
    const seenIds = new Set<string>();

    for (const areaResult of data) {
      const flightList = Array.isArray(areaResult.flights || areaResult) ? (areaResult.flights || areaResult) as Array<Record<string, unknown>> : [];
      for (const f of flightList) {
        const icao24 = (f.h || f.icao24 || f.id) as string;
        if (!icao24 || seenIds.has(icao24)) continue;
        seenIds.add(icao24);
        const callsign = ((f.f || f.callsign || f.flight || '') as string).trim();
        if (!isMilitaryCallsign(callsign) && !isMilitaryHex(icao24)) continue;
        flights.push({
          id: icao24,
          callsign,
          lat: (f.la || f.latitude || f.lat) as number,
          lon: (f.lo || f.longitude || f.lon || f.lng) as number,
          altitude: (f.ab || f.altitude || f.alt || 0) as number,
          heading: (f.th || f.heading || f.track || 0) as number,
          speed: (f.gs || f.groundSpeed || f.speed || f.velocity || 0) as number,
          aircraftType: detectAircraftType(callsign),
        });
      }
    }
    return flights;
  } catch {
    return null;
  }
}

// ========================================================================
// Theater posture calculation
// ========================================================================

function calculatePostures(flights: RawFlight[]): TheaterPosture[] {
  return POSTURE_THEATERS.map((theater) => {
    const theaterFlights = flights.filter(
      (f) => f.lat >= theater.bounds.south && f.lat <= theater.bounds.north &&
        f.lon >= theater.bounds.west && f.lon <= theater.bounds.east,
    );

    const total = theaterFlights.length;
    const byType = {
      tankers: theaterFlights.filter((f) => f.aircraftType === 'tanker').length,
      awacs: theaterFlights.filter((f) => f.aircraftType === 'awacs').length,
      fighters: theaterFlights.filter((f) => f.aircraftType === 'fighter').length,
    };

    const postureLevel = total >= theater.thresholds.critical
      ? 'critical'
      : total >= theater.thresholds.elevated
        ? 'elevated'
        : 'normal';

    const strikeCapable =
      byType.tankers >= theater.strikeIndicators.minTankers &&
      byType.awacs >= theater.strikeIndicators.minAwacs &&
      byType.fighters >= theater.strikeIndicators.minFighters;

    const ops: string[] = [];
    if (strikeCapable) ops.push('strike_capable');
    if (byType.tankers > 0) ops.push('aerial_refueling');
    if (byType.awacs > 0) ops.push('airborne_early_warning');

    return {
      theater: theater.id,
      postureLevel,
      activeFlights: total,
      trackedVessels: 0,
      activeOperations: ops,
      assessedAt: Date.now(),
    };
  });
}

// ========================================================================
// RPC handler
// ========================================================================

export async function getTheaterPosture(
  _ctx: ServerContext,
  _req: GetTheaterPostureRequest,
): Promise<GetTheaterPostureResponse> {
  const cached = (await getCachedJson(CACHE_KEY)) as GetTheaterPostureResponse | null;
  if (cached) return cached;

  try {
    // Race both sources in parallel instead of sequential fallback (H-6 fix)
    let flights: RawFlight[];
    const [openskyResult, wingbitsResult] = await Promise.allSettled([
      fetchMilitaryFlightsFromOpenSky(),
      fetchMilitaryFlightsFromWingbits(),
    ]);

    if (openskyResult.status === 'fulfilled' && openskyResult.value.length > 0) {
      flights = openskyResult.value;
    } else if (wingbitsResult.status === 'fulfilled' && wingbitsResult.value && wingbitsResult.value.length > 0) {
      flights = wingbitsResult.value;
    } else {
      throw new Error('Both OpenSky and Wingbits unavailable');
    }

    const theaters = calculatePostures(flights);
    const result: GetTheaterPostureResponse = { theaters };

    await Promise.all([
      setCachedJson(CACHE_KEY, result, CACHE_TTL),
      setCachedJson(STALE_CACHE_KEY, result, STALE_TTL),
      setCachedJson(BACKUP_CACHE_KEY, result, BACKUP_TTL),
    ]);
    return result;
  } catch {
    const stale = (await getCachedJson(STALE_CACHE_KEY)) as GetTheaterPostureResponse | null;
    if (stale) return stale;
    const backup = (await getCachedJson(BACKUP_CACHE_KEY)) as GetTheaterPostureResponse | null;
    if (backup) return backup;
    return { theaters: [] };
  }
}
