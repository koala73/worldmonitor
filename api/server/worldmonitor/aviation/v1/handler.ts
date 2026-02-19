/**
 * Aviation service handler -- implements the generated AviationServiceHandler
 * interface by proxying the FAA NASSTATUS XML API.
 *
 * This handler performs a data flow inversion: the legacy architecture proxies
 * raw XML to the browser where DOMParser parses it client-side. This handler
 * does ALL processing server-side: XML fetch, parse (fast-xml-parser), airport
 * enrichment, simulated delay generation, severity classification, and proto
 * enum mapping. The client receives fully processed JSON.
 */

import { XMLParser } from 'fast-xml-parser';
import type {
  AviationServiceHandler,
  ServerContext,
  ListAirportDelaysRequest,
  ListAirportDelaysResponse,
  AirportDelayAlert,
  FlightDelayType,
  FlightDelaySeverity,
  FlightDelaySource,
  AirportRegion,
} from '../../../../../src/generated/server/worldmonitor/aviation/v1/service_server';
import {
  MONITORED_AIRPORTS,
  FAA_AIRPORTS,
  DELAY_SEVERITY_THRESHOLDS,
} from '../../../../../src/config/airports';

// ---------- Constants ----------

const FAA_URL = 'https://nasstatus.faa.gov/api/airport-status-information';

// ---------- XML Parser ----------

const xmlParser = new XMLParser({
  ignoreAttributes: true,
  isArray: (_name: string, jpath: string) => {
    // Force arrays for list items regardless of count to prevent single-item-as-object bug
    return /\.(Ground_Delay|Ground_Stop|Delay|Airport)$/.test(jpath);
  },
});

// ---------- Internal types ----------

interface FAADelayInfo {
  airport: string;
  reason: string;
  avgDelay: number;
  type: string;
}

// ---------- Helpers ----------

function parseDelayTypeFromReason(reason: string): string {
  const r = reason.toLowerCase();
  if (r.includes('ground stop')) return 'ground_stop';
  if (r.includes('ground delay') || r.includes('gdp')) return 'ground_delay';
  if (r.includes('departure')) return 'departure_delay';
  if (r.includes('arrival')) return 'arrival_delay';
  if (r.includes('clos')) return 'ground_stop';
  return 'general';
}

function parseFaaXml(xml: string): Map<string, FAADelayInfo> {
  const delays = new Map<string, FAADelayInfo>();
  const parsed = xmlParser.parse(xml);
  const root = parsed?.AIRPORT_STATUS_INFORMATION;
  if (!root) return delays;

  // Delay_type may be array or single object
  const delayTypes = Array.isArray(root.Delay_type)
    ? root.Delay_type
    : root.Delay_type ? [root.Delay_type] : [];

  for (const dt of delayTypes) {
    // Ground Delays
    if (dt.Ground_Delay_List?.Ground_Delay) {
      for (const gd of dt.Ground_Delay_List.Ground_Delay) {
        if (gd.ARPT) {
          delays.set(gd.ARPT, {
            airport: gd.ARPT,
            reason: gd.Reason || 'Ground delay',
            avgDelay: gd.Avg ? parseInt(gd.Avg, 10) : 30,
            type: 'ground_delay',
          });
        }
      }
    }
    // Ground Stops
    if (dt.Ground_Stop_List?.Ground_Stop) {
      for (const gs of dt.Ground_Stop_List.Ground_Stop) {
        if (gs.ARPT) {
          delays.set(gs.ARPT, {
            airport: gs.ARPT,
            reason: gs.Reason || 'Ground stop',
            avgDelay: 60,
            type: 'ground_stop',
          });
        }
      }
    }
    // Arrival/Departure Delays
    if (dt.Arrival_Departure_Delay_List?.Delay) {
      for (const d of dt.Arrival_Departure_Delay_List.Delay) {
        if (d.ARPT) {
          const min = parseInt(d.Arrival_Delay?.Min || d.Departure_Delay?.Min || '15', 10);
          const max = parseInt(d.Arrival_Delay?.Max || d.Departure_Delay?.Max || '30', 10);
          const existing = delays.get(d.ARPT);
          // Don't downgrade ground_stop to lesser delay
          if (!existing || existing.type !== 'ground_stop') {
            delays.set(d.ARPT, {
              airport: d.ARPT,
              reason: d.Reason || 'Delays',
              avgDelay: Math.round((min + max) / 2),
              type: parseDelayTypeFromReason(d.Reason || ''),
            });
          }
        }
      }
    }
    // Airport Closures
    if (dt.Airport_Closure_List?.Airport) {
      for (const ac of dt.Airport_Closure_List.Airport) {
        if (ac.ARPT && FAA_AIRPORTS.includes(ac.ARPT)) {
          delays.set(ac.ARPT, {
            airport: ac.ARPT,
            reason: 'Airport closure',
            avgDelay: 120,
            type: 'ground_stop',
          });
        }
      }
    }
  }

  return delays;
}

// ---------- Proto enum mappers ----------

function toProtoDelayType(t: string): FlightDelayType {
  const map: Record<string, FlightDelayType> = {
    ground_stop: 'FLIGHT_DELAY_TYPE_GROUND_STOP',
    ground_delay: 'FLIGHT_DELAY_TYPE_GROUND_DELAY',
    departure_delay: 'FLIGHT_DELAY_TYPE_DEPARTURE_DELAY',
    arrival_delay: 'FLIGHT_DELAY_TYPE_ARRIVAL_DELAY',
    general: 'FLIGHT_DELAY_TYPE_GENERAL',
  };
  return map[t] || 'FLIGHT_DELAY_TYPE_GENERAL';
}

function toProtoSeverity(s: string): FlightDelaySeverity {
  const map: Record<string, FlightDelaySeverity> = {
    normal: 'FLIGHT_DELAY_SEVERITY_NORMAL',
    minor: 'FLIGHT_DELAY_SEVERITY_MINOR',
    moderate: 'FLIGHT_DELAY_SEVERITY_MODERATE',
    major: 'FLIGHT_DELAY_SEVERITY_MAJOR',
    severe: 'FLIGHT_DELAY_SEVERITY_SEVERE',
  };
  return map[s] || 'FLIGHT_DELAY_SEVERITY_NORMAL';
}

function toProtoRegion(r: string): AirportRegion {
  const map: Record<string, AirportRegion> = {
    americas: 'AIRPORT_REGION_AMERICAS',
    europe: 'AIRPORT_REGION_EUROPE',
    apac: 'AIRPORT_REGION_APAC',
    mena: 'AIRPORT_REGION_MENA',
    africa: 'AIRPORT_REGION_AFRICA',
  };
  return map[r] || 'AIRPORT_REGION_UNSPECIFIED';
}

function toProtoSource(s: string): FlightDelaySource {
  const map: Record<string, FlightDelaySource> = {
    faa: 'FLIGHT_DELAY_SOURCE_FAA',
    eurocontrol: 'FLIGHT_DELAY_SOURCE_EUROCONTROL',
    computed: 'FLIGHT_DELAY_SOURCE_COMPUTED',
  };
  return map[s] || 'FLIGHT_DELAY_SOURCE_COMPUTED';
}

// ---------- Severity classification ----------

function determineSeverity(avgDelayMinutes: number, delayedPct?: number): string {
  const t = DELAY_SEVERITY_THRESHOLDS;
  if (avgDelayMinutes >= t.severe.avgDelayMinutes || (delayedPct && delayedPct >= t.severe.delayedPct)) return 'severe';
  if (avgDelayMinutes >= t.major.avgDelayMinutes || (delayedPct && delayedPct >= t.major.delayedPct)) return 'major';
  if (avgDelayMinutes >= t.moderate.avgDelayMinutes || (delayedPct && delayedPct >= t.moderate.delayedPct)) return 'moderate';
  if (avgDelayMinutes >= t.minor.avgDelayMinutes || (delayedPct && delayedPct >= t.minor.delayedPct)) return 'minor';
  return 'normal';
}

// ---------- Simulated delay generation ----------

function generateSimulatedDelay(airport: typeof MONITORED_AIRPORTS[number]): AirportDelayAlert | null {
  const hour = new Date().getUTCHours();
  const isRushHour = (hour >= 6 && hour <= 10) || (hour >= 16 && hour <= 20);
  const busyAirports = ['LHR', 'CDG', 'FRA', 'JFK', 'LAX', 'ORD', 'PEK', 'HND', 'DXB', 'SIN'];
  const isBusy = busyAirports.includes(airport.iata);
  const random = Math.random();
  const delayChance = isRushHour ? 0.35 : 0.15;
  const hasDelay = random < (isBusy ? delayChance * 1.5 : delayChance);

  if (!hasDelay) return null;

  let avgDelayMinutes = 0;
  let delayType = 'general';
  let reason = 'Minor delays';

  const severityRoll = Math.random();
  if (severityRoll < 0.05) {
    avgDelayMinutes = 60 + Math.floor(Math.random() * 60);
    delayType = Math.random() < 0.3 ? 'ground_stop' : 'ground_delay';
    reason = Math.random() < 0.5 ? 'Weather conditions' : 'Air traffic volume';
  } else if (severityRoll < 0.2) {
    avgDelayMinutes = 45 + Math.floor(Math.random() * 20);
    delayType = 'ground_delay';
    reason = Math.random() < 0.5 ? 'Weather' : 'High traffic volume';
  } else if (severityRoll < 0.5) {
    avgDelayMinutes = 25 + Math.floor(Math.random() * 20);
    delayType = Math.random() < 0.5 ? 'departure_delay' : 'arrival_delay';
    reason = 'Congestion';
  } else {
    avgDelayMinutes = 15 + Math.floor(Math.random() * 15);
    delayType = 'general';
    reason = 'Minor delays';
  }

  const severity = determineSeverity(avgDelayMinutes);
  // Only return if severity is not normal (matching legacy behavior: filter out normal)
  if (severity === 'normal') return null;

  return {
    id: `sim-${airport.iata}`,
    iata: airport.iata,
    icao: airport.icao,
    name: airport.name,
    city: airport.city,
    country: airport.country,
    location: { latitude: airport.lat, longitude: airport.lon },
    region: toProtoRegion(airport.region),
    delayType: toProtoDelayType(delayType),
    severity: toProtoSeverity(severity),
    avgDelayMinutes,
    delayedFlightsPct: 0,
    cancelledFlights: 0,
    totalFlights: 0,
    reason,
    source: toProtoSource('computed'),
    updatedAt: Date.now(),
  };
}

// ---------- Handler ----------

export const aviationHandler: AviationServiceHandler = {
  async listAirportDelays(
    _ctx: ServerContext,
    _req: ListAirportDelaysRequest,
  ): Promise<ListAirportDelaysResponse> {
    try {
      const alerts: AirportDelayAlert[] = [];

      // 1. Fetch and parse FAA XML
      const faaResponse = await fetch(FAA_URL, {
        headers: { Accept: 'application/xml' },
      });

      let faaDelays = new Map<string, FAADelayInfo>();
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
  },
};
