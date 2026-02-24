declare const process: { env: Record<string, string | undefined> };

import type {
  ServerContext,
  ListMilitaryFlightsRequest,
  ListMilitaryFlightsResponse,
  MilitaryAircraftType,
} from '../../../../src/generated/server/worldmonitor/military/v1/service_server';

import { isMilitaryCallsign, isMilitaryHex, detectAircraftType, UPSTREAM_TIMEOUT_MS, openSkyHeaders, fetchOpenSkyMetadataBatch, resolveTypeFromTypecode, resolveOperatorFromIcao, metadataToEnrichment } from './_shared';
import { getCachedJson, setCachedJson } from '../../../_shared/redis';

const REDIS_CACHE_KEY = 'military:flights:v1';
const REDIS_CACHE_TTL = 120; // 2 min — real-time ADS-B data

/** Snap a coordinate to a grid step so nearby bbox values share cache entries. */
const quantize = (v: number, step: number) => Math.round(v / step) * step;
const BBOX_GRID_STEP = 1; // 1-degree grid (~111 km at equator)

interface RequestBounds {
  south: number;
  north: number;
  west: number;
  east: number;
}

function normalizeBounds(bb: NonNullable<ListMilitaryFlightsRequest['boundingBox']>): RequestBounds {
  return {
    south: Math.min(bb.southWest!.latitude, bb.northEast!.latitude),
    north: Math.max(bb.southWest!.latitude, bb.northEast!.latitude),
    west: Math.min(bb.southWest!.longitude, bb.northEast!.longitude),
    east: Math.max(bb.southWest!.longitude, bb.northEast!.longitude),
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
  _ctx: ServerContext,
  req: ListMilitaryFlightsRequest,
): Promise<ListMilitaryFlightsResponse> {
  try {
    const bb = req.boundingBox;
    if (!bb?.southWest || !bb?.northEast) return { flights: [], clusters: [], pagination: undefined };
    const requestBounds = normalizeBounds(bb);

    // Quantize bbox to a 1° grid so nearby map views share cache entries.
    // Precise coordinates caused near-zero hit rate since every pan/zoom created a unique key.
    const quantizedBB = [
      quantize(bb.southWest.latitude, BBOX_GRID_STEP),
      quantize(bb.southWest.longitude, BBOX_GRID_STEP),
      quantize(bb.northEast.latitude, BBOX_GRID_STEP),
      quantize(bb.northEast.longitude, BBOX_GRID_STEP),
    ].join(':');
    const cacheKey = `${REDIS_CACHE_KEY}:${quantizedBB}:${req.operator || ''}:${req.aircraftType || ''}:${req.pagination?.pageSize || 0}`;
    const cached = (await getCachedJson(cacheKey)) as ListMilitaryFlightsResponse | null;
    if (cached?.flights?.length) {
      return { ...cached, flights: filterFlightsToBounds(cached.flights, requestBounds) };
    }

    const isSidecar = (process.env.LOCAL_API_MODE || '').includes('sidecar');
    const baseUrl = isSidecar
      ? 'https://opensky-network.org/api/states/all'
      : process.env.WS_RELAY_URL ? process.env.WS_RELAY_URL + '/opensky' : null;

    if (!baseUrl) return { flights: [], clusters: [], pagination: undefined };

    // Use quantized (expanded) bbox for the upstream fetch so cache results
    // cover the full grid cell regardless of exact viewport position.
    const fetchBB = {
      lamin: quantize(bb.southWest.latitude, BBOX_GRID_STEP) - BBOX_GRID_STEP / 2,
      lamax: quantize(bb.northEast.latitude, BBOX_GRID_STEP) + BBOX_GRID_STEP / 2,
      lomin: quantize(bb.southWest.longitude, BBOX_GRID_STEP) - BBOX_GRID_STEP / 2,
      lomax: quantize(bb.northEast.longitude, BBOX_GRID_STEP) + BBOX_GRID_STEP / 2,
    };
    const params = new URLSearchParams();
    params.set('lamin', String(fetchBB.lamin));
    params.set('lamax', String(fetchBB.lamax));
    params.set('lomin', String(fetchBB.lomin));
    params.set('lomax', String(fetchBB.lomax));

    const url = `${baseUrl}${params.toString() ? '?' + params.toString() : ''}`;
    const headers = await openSkyHeaders();
    const resp = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });

    if (!resp.ok) return { flights: [], clusters: [], pagination: undefined };

    const data = (await resp.json()) as { states?: Array<[string, string, ...unknown[]]> };
    if (!data.states) return { flights: [], clusters: [], pagination: undefined };

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

    // ── Enrich flights with OpenSky aircraft metadata (type, model, reg, country) ──
    if (flights.length > 0) {
      try {
        const hexCodes = flights.map(f => f.hexCode);
        const metadataMap = await fetchOpenSkyMetadataBatch(hexCodes);

        for (const flight of flights) {
          const meta = metadataMap.get(flight.hexCode);
          if (!meta) continue;

          // Registration
          if (meta.registration) flight.registration = meta.registration;

          // Aircraft model (e.g. "C-130J Super Hercules")
          if (meta.model) flight.aircraftModel = meta.model;

          // Country (e.g. "Qatar")
          if (meta.country) flight.operatorCountry = meta.country;

          // Aircraft type — use typecode when callsign detection returned unknown
          if (flight.aircraftType === ('MILITARY_AIRCRAFT_TYPE_UNKNOWN' as MilitaryAircraftType) && meta.typecode) {
            const resolved = resolveTypeFromTypecode(meta.typecode);
            if (resolved !== 'MILITARY_AIRCRAFT_TYPE_UNKNOWN') {
              flight.aircraftType = resolved as MilitaryAircraftType;
            }
          }

          // Operator — use operatorIcao when still generic
          if (flight.operator === 'MILITARY_OPERATOR_OTHER' && meta.operatorIcao) {
            flight.operator = resolveOperatorFromIcao(meta.operatorIcao);
          }

          // Confidence boost
          const isMilitary = meta.dbFlags != null && (meta.dbFlags & 1) !== 0;
          if (isMilitary) {
            flight.confidence = 'MILITARY_CONFIDENCE_HIGH';
            flight.isInteresting = true;
          } else if (meta.registration || meta.model) {
            flight.confidence = 'MILITARY_CONFIDENCE_MEDIUM';
          }

          // Enrichment proto (manufacturer, owner, etc.)
          flight.enrichment = metadataToEnrichment(meta);
        }
      } catch {
        // Metadata enrichment failed — flights still returned with basic data
      }
    }

    // Cache the full quantized-cell payload, then filter per-request bbox before returning.
    const result: ListMilitaryFlightsResponse = { flights, clusters: [], pagination: undefined };
    if (flights.length > 0) {
      setCachedJson(cacheKey, result, REDIS_CACHE_TTL).catch(() => {});
    }
    return { flights: filterFlightsToBounds(flights, requestBounds), clusters: [], pagination: undefined };
  } catch {
    return { flights: [], clusters: [], pagination: undefined };
  }
}
