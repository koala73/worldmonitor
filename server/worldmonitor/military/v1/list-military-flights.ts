declare const process: { env: Record<string, string | undefined> };

import type {
  ServerContext,
  ListMilitaryFlightsRequest,
  ListMilitaryFlightsResponse,
  MilitaryAircraftType,
} from '../../../../src/generated/server/worldmonitor/military/v1/service_server';

import { isMilitaryCallsign, isMilitaryHex, detectAircraftType, UPSTREAM_TIMEOUT_MS } from './_shared';
import { CHROME_UA } from '../../../_shared/constants';
import { cachedFetchJson } from '../../../_shared/redis';
import { markNoCacheResponse } from '../../../_shared/response-headers';

const REDIS_CACHE_KEY = 'military:flights:v1';
const REDIS_CACHE_TTL = 600; // 10 min — reduce upstream API pressure

/** Snap a coordinate to a grid step so nearby bbox values share cache entries. */
const quantize = (v: number, step: number) => Math.round(v / step) * step;
const BBOX_GRID_STEP = 1; // 1-degree grid (~111 km at equator)

interface RequestBounds {
  south: number;
  north: number;
  west: number;
  east: number;
}

function getRelayRequestHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': CHROME_UA,
  };
  const relaySecret = process.env.RELAY_SHARED_SECRET;
  if (relaySecret) {
    const relayHeader = (process.env.RELAY_AUTH_HEADER || 'x-relay-key').toLowerCase();
    headers[relayHeader] = relaySecret;
    headers.Authorization = `Bearer ${relaySecret}`;
  }
  return headers;
}

function normalizeBounds(req: ListMilitaryFlightsRequest): RequestBounds {
  return {
    south: Math.min(req.swLat, req.neLat),
    north: Math.max(req.swLat, req.neLat),
    west: Math.min(req.swLon, req.neLon),
    east: Math.max(req.swLon, req.neLon),
  };
}

function filterFlightsToBounds(
  flights: ListMilitaryFlightsResponse['flights'],
  bounds: RequestBounds,
): ListMilitaryFlightsResponse['flights'] {
  return flights.filter((flight) => {
    const lat = flight.location?.latitude;
    const lon = flight.location?.longitude;
    if (lat == null || lon == null) return false;
    return lat >= bounds.south && lat <= bounds.north && lon >= bounds.west && lon <= bounds.east;
  });
}

const AIRCRAFT_TYPE_MAP: Record<string, string> = {
  tanker: 'MILITARY_AIRCRAFT_TYPE_TANKER',
  awacs: 'MILITARY_AIRCRAFT_TYPE_AWACS',
  transport: 'MILITARY_AIRCRAFT_TYPE_TRANSPORT',
  reconnaissance: 'MILITARY_AIRCRAFT_TYPE_RECONNAISSANCE',
  drone: 'MILITARY_AIRCRAFT_TYPE_DRONE',
  bomber: 'MILITARY_AIRCRAFT_TYPE_BOMBER',
};

export async function listMilitaryFlights(
  ctx: ServerContext,
  req: ListMilitaryFlightsRequest,
): Promise<ListMilitaryFlightsResponse> {
  try {
    if (!req.neLat && !req.neLon && !req.swLat && !req.swLon) return { flights: [], clusters: [], pagination: undefined };
    const requestBounds = normalizeBounds(req);

    // Quantize bbox to a 1° grid so nearby map views share cache entries.
    // Precise coordinates caused near-zero hit rate since every pan/zoom created a unique key.
    const quantizedBB = [
      quantize(req.swLat, BBOX_GRID_STEP),
      quantize(req.swLon, BBOX_GRID_STEP),
      quantize(req.neLat, BBOX_GRID_STEP),
      quantize(req.neLon, BBOX_GRID_STEP),
    ].join(':');
    const cacheKey = `${REDIS_CACHE_KEY}:${quantizedBB}:${req.operator || ''}:${req.aircraftType || ''}:${req.pageSize || 0}`;

    const fullResult = await cachedFetchJson<ListMilitaryFlightsResponse>(
      cacheKey,
      REDIS_CACHE_TTL,
      async () => {
        const isSidecar = (process.env.LOCAL_API_MODE || '').includes('sidecar');
        const baseUrl = isSidecar
          ? 'https://opensky-network.org/api/states/all'
          : process.env.WS_RELAY_URL ? process.env.WS_RELAY_URL + '/opensky' : null;

        if (!baseUrl) return null;

        const fetchBB = {
          lamin: quantize(req.swLat, BBOX_GRID_STEP) - BBOX_GRID_STEP / 2,
          lamax: quantize(req.neLat, BBOX_GRID_STEP) + BBOX_GRID_STEP / 2,
          lomin: quantize(req.swLon, BBOX_GRID_STEP) - BBOX_GRID_STEP / 2,
          lomax: quantize(req.neLon, BBOX_GRID_STEP) + BBOX_GRID_STEP / 2,
        };
        const params = new URLSearchParams();
        params.set('lamin', String(fetchBB.lamin));
        params.set('lamax', String(fetchBB.lamax));
        params.set('lomin', String(fetchBB.lomin));
        params.set('lomax', String(fetchBB.lomax));

        const url = `${baseUrl!}${params.toString() ? '?' + params.toString() : ''}`;
        const resp = await fetch(url, {
          headers: getRelayRequestHeaders(),
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        });

        if (!resp.ok) return null;

        const data = (await resp.json()) as { states?: Array<[string, string, ...unknown[]]> };
        if (!data.states) return null;

        const flights: ListMilitaryFlightsResponse['flights'] = [];
        for (const state of data.states) {
          const [icao24, callsign, , , , lon, lat, altitude, onGround, velocity, heading] = state as [
            string, string, unknown, unknown, unknown, number | null, number | null, number | null, boolean, number | null, number | null,
          ];
          if (lat == null || lon == null || onGround) continue;
          if (!isMilitaryCallsign(callsign) && !isMilitaryHex(icao24)) continue;

          const aircraftType = detectAircraftType(callsign);

          flights.push({
            id: icao24,
            callsign: (callsign || '').trim(),
            hexCode: icao24,
            registration: '',
            aircraftType: (AIRCRAFT_TYPE_MAP[aircraftType] || 'MILITARY_AIRCRAFT_TYPE_UNKNOWN') as MilitaryAircraftType,
            aircraftModel: '',
            operator: 'MILITARY_OPERATOR_OTHER',
            operatorCountry: '',
            location: { latitude: lat, longitude: lon },
            altitude: altitude ?? 0,
            heading: heading ?? 0,
            speed: (velocity as number) ?? 0,
            verticalRate: 0,
            onGround: false,
            squawk: '',
            origin: '',
            destination: '',
            lastSeenAt: Date.now(),
            firstSeenAt: 0,
            confidence: 'MILITARY_CONFIDENCE_LOW',
            isInteresting: false,
            note: '',
            enrichment: undefined,
          });
        }

        return flights.length > 0 ? { flights, clusters: [], pagination: undefined } : null;
      },
    );

    if (!fullResult) {
      markNoCacheResponse(ctx.request);
      return { flights: [], clusters: [], pagination: undefined };
    }
    return { ...fullResult, flights: filterFlightsToBounds(fullResult.flights, requestBounds) };
  } catch {
    markNoCacheResponse(ctx.request);
    return { flights: [], clusters: [], pagination: undefined };
  }
}
