import type {
  ServerContext,
  ListAirportDelaysRequest,
  ListAirportDelaysResponse,
  AirportDelayAlert,
} from '../../../../src/generated/server/worldmonitor/aviation/v1/service_server';
import {
  MONITORED_AIRPORTS,
  FAA_AIRPORTS,
} from '../../../../src/config/airports';
import {
  FAA_URL,
  parseFaaXml,
  toProtoDelayType,
  toProtoSeverity,
  toProtoRegion,
  toProtoSource,
  determineSeverity,
  generateSimulatedDelay,
} from './_shared';

export async function listAirportDelays(
  _ctx: ServerContext,
  _req: ListAirportDelaysRequest,
): Promise<ListAirportDelaysResponse> {
  try {
    const alerts: AirportDelayAlert[] = [];

    // 1. Fetch and parse FAA XML
    const faaResponse = await fetch(FAA_URL, {
      headers: { Accept: 'application/xml' },
      signal: AbortSignal.timeout(15_000),
    });

    let faaDelays = new Map<string, { airport: string; reason: string; avgDelay: number; type: string }>();
    if (faaResponse.ok) {
      const xml = await faaResponse.text();
      faaDelays = parseFaaXml(xml);
    }

    // 2. Enrich US airports with FAA delay data
    for (const iata of FAA_AIRPORTS) {
      const airport = MONITORED_AIRPORTS.find((a) => a.iata === iata);
      if (!airport) continue;

      const faaDelay = faaDelays.get(iata);
      if (faaDelay) {
        alerts.push({
          id: `faa-${iata}`,
          iata,
          icao: airport.icao,
          name: airport.name,
          city: airport.city,
          country: airport.country,
          location: { latitude: airport.lat, longitude: airport.lon },
          region: toProtoRegion(airport.region),
          delayType: toProtoDelayType(faaDelay.type),
          severity: toProtoSeverity(determineSeverity(faaDelay.avgDelay)),
          avgDelayMinutes: faaDelay.avgDelay,
          delayedFlightsPct: 0,
          cancelledFlights: 0,
          totalFlights: 0,
          reason: faaDelay.reason,
          source: toProtoSource('faa'),
          updatedAt: Date.now(),
        });
      }
    }

    // 3. Generate simulated delays for non-US airports
    const nonUsAirports = MONITORED_AIRPORTS.filter((a) => a.country !== 'USA');
    for (const airport of nonUsAirports) {
      const simulated = generateSimulatedDelay(airport);
      if (simulated) {
        alerts.push(simulated);
      }
    }

    return { alerts };
  } catch {
    // Graceful empty response on ANY failure (established pattern from 2F-01)
    return { alerts: [] };
  }
}
