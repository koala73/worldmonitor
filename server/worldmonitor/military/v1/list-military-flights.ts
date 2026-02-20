declare const process: { env: Record<string, string | undefined> };

import type {
  ServerContext,
  ListMilitaryFlightsRequest,
  ListMilitaryFlightsResponse,
  MilitaryAircraftType,
} from '../../../../src/generated/server/worldmonitor/military/v1/service_server';

import { isMilitaryCallsign, isMilitaryHex, detectAircraftType, UPSTREAM_TIMEOUT_MS } from './_shared';

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

    const isSidecar = (process.env.LOCAL_API_MODE || '').includes('sidecar');
    const baseUrl = isSidecar
      ? 'https://opensky-network.org/api/states/all'
      : process.env.WS_RELAY_URL ? process.env.WS_RELAY_URL + '/opensky' : null;

    if (!baseUrl) return { flights: [], clusters: [], pagination: undefined };

    const params = new URLSearchParams();
    params.set('lamin', String(bb.southWest.latitude));
    params.set('lamax', String(bb.northEast.latitude));
    params.set('lomin', String(bb.southWest.longitude));
    params.set('lomax', String(bb.northEast.longitude));

    const url = `${baseUrl}${params.toString() ? '?' + params.toString() : ''}`;
    const resp = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 WorldMonitor/1.0' },
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

    return { flights, clusters: [], pagination: undefined };
  } catch {
    return { flights: [], clusters: [], pagination: undefined };
  }
}
