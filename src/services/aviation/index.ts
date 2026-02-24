import {
  AviationServiceClient,
  type AirportDelayAlert as ProtoAlert,
} from '@/generated/client/worldmonitor/aviation/v1/service_client';
import { createCircuitBreaker } from '@/utils';

// --- Consumer-friendly types (matching legacy shape exactly) ---

export type FlightDelaySource = 'faa' | 'eurocontrol' | 'computed';
export type FlightDelaySeverity = 'normal' | 'minor' | 'moderate' | 'major' | 'severe';
export type FlightDelayType = 'ground_stop' | 'ground_delay' | 'departure_delay' | 'arrival_delay' | 'general';
export type AirportRegion = 'americas' | 'europe' | 'apac' | 'mena' | 'africa';

export interface AirportDelayAlert {
  id: string;
  iata: string;
  icao: string;
  name: string;
  city: string;
  country: string;
  lat: number;
  lon: number;
  region: AirportRegion;
  delayType: FlightDelayType;
  severity: FlightDelaySeverity;
  avgDelayMinutes: number;
  delayedFlightsPct?: number;
  cancelledFlights?: number;
  totalFlights?: number;
  reason?: string;
  source: FlightDelaySource;
  updatedAt: Date;
}

// --- Internal: proto -> legacy mapping ---

const SEVERITY_MAP: Record<string, FlightDelaySeverity> = {
  FLIGHT_DELAY_SEVERITY_NORMAL: 'normal',
  FLIGHT_DELAY_SEVERITY_MINOR: 'minor',
  FLIGHT_DELAY_SEVERITY_MODERATE: 'moderate',
  FLIGHT_DELAY_SEVERITY_MAJOR: 'major',
  FLIGHT_DELAY_SEVERITY_SEVERE: 'severe',
};

const DELAY_TYPE_MAP: Record<string, FlightDelayType> = {
  FLIGHT_DELAY_TYPE_GROUND_STOP: 'ground_stop',
  FLIGHT_DELAY_TYPE_GROUND_DELAY: 'ground_delay',
  FLIGHT_DELAY_TYPE_DEPARTURE_DELAY: 'departure_delay',
  FLIGHT_DELAY_TYPE_ARRIVAL_DELAY: 'arrival_delay',
  FLIGHT_DELAY_TYPE_GENERAL: 'general',
};

const REGION_MAP: Record<string, AirportRegion> = {
  AIRPORT_REGION_AMERICAS: 'americas',
  AIRPORT_REGION_EUROPE: 'europe',
  AIRPORT_REGION_APAC: 'apac',
  AIRPORT_REGION_MENA: 'mena',
  AIRPORT_REGION_AFRICA: 'africa',
};

const SOURCE_MAP: Record<string, FlightDelaySource> = {
  FLIGHT_DELAY_SOURCE_FAA: 'faa',
  FLIGHT_DELAY_SOURCE_EUROCONTROL: 'eurocontrol',
  FLIGHT_DELAY_SOURCE_COMPUTED: 'computed',
};

function toDisplayAlert(proto: ProtoAlert): AirportDelayAlert {
  return {
    id: proto.id,
    iata: proto.iata,
    icao: proto.icao,
    name: proto.name,
    city: proto.city,
    country: proto.country,
    lat: proto.location?.latitude ?? 0,
    lon: proto.location?.longitude ?? 0,
    region: REGION_MAP[proto.region] ?? 'americas',
    delayType: DELAY_TYPE_MAP[proto.delayType] ?? 'general',
    severity: SEVERITY_MAP[proto.severity] ?? 'normal',
    avgDelayMinutes: proto.avgDelayMinutes,
    delayedFlightsPct: proto.delayedFlightsPct || undefined,
    cancelledFlights: proto.cancelledFlights || undefined,
    totalFlights: proto.totalFlights || undefined,
    reason: proto.reason || undefined,
    source: SOURCE_MAP[proto.source] ?? 'computed',
    updatedAt: new Date(proto.updatedAt),
  };
}

// --- Client + circuit breaker ---

const client = new AviationServiceClient('', { fetch: (...args) => globalThis.fetch(...args) });
const breaker = createCircuitBreaker<AirportDelayAlert[]>({ name: 'FAA Flight Delays' });

// --- Main fetch (public API) ---

export async function fetchFlightDelays(): Promise<AirportDelayAlert[]> {
  return breaker.execute(async () => {
    const response = await client.listAirportDelays({
      region: 'AIRPORT_REGION_UNSPECIFIED',
      minSeverity: 'FLIGHT_DELAY_SEVERITY_UNSPECIFIED',
    });
    return response.alerts.map(toDisplayAlert);
  }, []);
}
