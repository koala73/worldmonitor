import { getRpcBaseUrl } from '@/services/rpc-client';
import {
  AviationServiceClient,
  type AirportDelayAlert as ProtoAlert,
  type AirportOpsSummary as ProtoOpsSummary,
  type FlightInstance as ProtoFlight,
  type CarrierOpsSummary as ProtoCarrierOps,
  type PositionSample as ProtoPosition,
  type PriceQuote as ProtoPriceQuote,
  type AviationNewsItem as ProtoAviationNews,
  type CabinClass,
} from '@/generated/client/worldmonitor/aviation/v1/service_client';
import { createCircuitBreaker } from '@/utils';
import { getHydratedData } from '@/services/bootstrap';

// ---- Consumer-friendly display types ----

export type FlightDelaySource = 'faa' | 'eurocontrol' | 'computed' | 'aviationstack' | 'notam';
export type FlightDelaySeverity = 'normal' | 'minor' | 'moderate' | 'major' | 'severe';
export type FlightDelayType = 'ground_stop' | 'ground_delay' | 'departure_delay' | 'arrival_delay' | 'general' | 'closure';
export type AirportRegion = 'americas' | 'europe' | 'apac' | 'mena' | 'africa';
export type FlightStatus = 'scheduled' | 'boarding' | 'departed' | 'airborne' | 'landed' | 'arrived' | 'cancelled' | 'diverted' | 'unknown';

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

export interface AirportOpsSummary {
  iata: string;
  icao: string;
  name: string;
  delayPct: number;
  avgDelayMinutes: number;
  cancellationRate: number;
  totalFlights: number;
  closureStatus: boolean;
  notamFlags: string[];
  severity: FlightDelaySeverity;
  topDelayReasons: string[];
  source: string;
  updatedAt: Date;
}

export interface FlightInstance {
  flightNumber: string;
  date: string;
  carrier: { iata: string; name: string };
  origin: { iata: string; name: string };
  destination: { iata: string; name: string };
  scheduledDeparture: Date | null;
  scheduledArrival: Date | null;
  estimatedDeparture: Date | null;
  estimatedArrival: Date | null;
  status: FlightStatus;
  delayMinutes: number;
  cancelled: boolean;
  diverted: boolean;
  gate: string;
  terminal: string;
  aircraftType: string;
  source: string;
}

export interface CarrierOps {
  carrierIata: string;
  carrierName: string;
  airport: string;
  totalFlights: number;
  delayedCount: number;
  cancelledCount: number;
  avgDelayMinutes: number;
  delayPct: number;
  cancellationRate: number;
  updatedAt: Date;
}

export interface PositionSample {
  icao24: string;
  callsign: string;
  lat: number;
  lon: number;
  altitudeFt: number;
  groundSpeedKts: number;
  trackDeg: number;
  onGround: boolean;
  source: string;
  observedAt: Date;
}

export interface PriceQuote {
  id: string;
  origin: string;
  destination: string;
  departureDate: string;
  carrierIata: string;
  carrierName: string;
  priceAmount: number;
  currency: string;
  cabin: string;
  stops: number;
  durationMinutes: number;
  isIndicative: boolean;
  provider: string;          // 'travelpayouts_data' | 'demo'
  expiresAt: Date | null;   // null means no known expiry
  checkoutRef: string;       // empty for cached/demo
}

/** Returns true if a quote has a known expiry that has passed. */
export function isPriceExpired(q: PriceQuote): boolean {
  return q.expiresAt !== null && q.expiresAt.getTime() < Date.now();
}

export interface AviationNewsItem {
  id: string;
  title: string;
  url: string;
  sourceName: string;
  publishedAt: Date;
  snippet: string;
  matchedEntities: string[];
}

// ---- Enum maps ----

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
  FLIGHT_DELAY_TYPE_CLOSURE: 'closure',
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
  FLIGHT_DELAY_SOURCE_AVIATIONSTACK: 'aviationstack',
  FLIGHT_DELAY_SOURCE_NOTAM: 'notam',
};

const FLIGHT_STATUS_MAP: Record<string, FlightStatus> = {
  FLIGHT_INSTANCE_STATUS_SCHEDULED: 'scheduled',
  FLIGHT_INSTANCE_STATUS_BOARDING: 'boarding',
  FLIGHT_INSTANCE_STATUS_DEPARTED: 'departed',
  FLIGHT_INSTANCE_STATUS_AIRBORNE: 'airborne',
  FLIGHT_INSTANCE_STATUS_LANDED: 'landed',
  FLIGHT_INSTANCE_STATUS_ARRIVED: 'arrived',
  FLIGHT_INSTANCE_STATUS_CANCELLED: 'cancelled',
  FLIGHT_INSTANCE_STATUS_DIVERTED: 'diverted',
};

// ---- Normalizers ----

function msToDt(ms: number): Date | null { return ms ? new Date(ms) : null; }

function toDisplayAlert(p: ProtoAlert): AirportDelayAlert {
  return {
    id: p.id, iata: p.iata, icao: p.icao, name: p.name, city: p.city, country: p.country,
    lat: p.location?.latitude ?? 0, lon: p.location?.longitude ?? 0,
    region: REGION_MAP[p.region] ?? 'americas',
    delayType: DELAY_TYPE_MAP[p.delayType] ?? 'general',
    severity: SEVERITY_MAP[p.severity] ?? 'normal',
    avgDelayMinutes: p.avgDelayMinutes,
    delayedFlightsPct: p.delayedFlightsPct || undefined,
    cancelledFlights: p.cancelledFlights || undefined,
    totalFlights: p.totalFlights || undefined,
    reason: p.reason || undefined,
    source: SOURCE_MAP[p.source] ?? 'computed',
    updatedAt: new Date(p.updatedAt),
  };
}

function toDisplayOps(p: ProtoOpsSummary): AirportOpsSummary {
  return {
    iata: p.iata, icao: p.icao, name: p.name,
    delayPct: p.delayPct, avgDelayMinutes: p.avgDelayMinutes, cancellationRate: p.cancellationRate,
    totalFlights: p.totalFlights, closureStatus: p.closureStatus,
    notamFlags: p.notamFlags ?? [], severity: SEVERITY_MAP[p.severity] ?? 'normal',
    topDelayReasons: p.topDelayReasons ?? [], source: p.source, updatedAt: new Date(p.updatedAt),
  };
}

function toDisplayFlight(p: ProtoFlight): FlightInstance {
  return {
    flightNumber: p.flightNumber, date: p.date,
    carrier: { iata: p.operatingCarrier?.iataCode ?? '', name: p.operatingCarrier?.name ?? '' },
    origin: { iata: p.origin?.iata ?? '', name: p.origin?.name ?? '' },
    destination: { iata: p.destination?.iata ?? '', name: p.destination?.name ?? '' },
    scheduledDeparture: msToDt(p.scheduledDeparture), scheduledArrival: msToDt(p.scheduledArrival),
    estimatedDeparture: msToDt(p.estimatedDeparture || p.scheduledDeparture),
    estimatedArrival: msToDt(p.estimatedArrival || p.scheduledArrival),
    status: FLIGHT_STATUS_MAP[p.status ?? ''] ?? 'unknown',
    delayMinutes: p.delayMinutes, cancelled: p.cancelled, diverted: p.diverted,
    gate: p.gate, terminal: p.terminal, aircraftType: p.aircraftType, source: p.source,
  };
}

function toDisplayCarrierOps(p: ProtoCarrierOps): CarrierOps {
  return {
    carrierIata: p.carrier?.iataCode ?? '', carrierName: p.carrier?.name ?? p.carrier?.iataCode ?? '',
    airport: p.airport, totalFlights: p.totalFlights, delayedCount: p.delayedCount,
    cancelledCount: p.cancelledCount, avgDelayMinutes: p.avgDelayMinutes,
    delayPct: p.delayPct, cancellationRate: p.cancellationRate, updatedAt: new Date(p.updatedAt),
  };
}

function toDisplayPosition(p: ProtoPosition): PositionSample {
  return {
    icao24: p.icao24, callsign: p.callsign, lat: p.lat, lon: p.lon,
    altitudeFt: Math.round(p.altitudeM * 3.281),
    groundSpeedKts: p.groundSpeedKts, trackDeg: p.trackDeg, onGround: p.onGround,
    source: p.source, observedAt: new Date(p.observedAt),
  };
}

function toDisplayPriceQuote(p: ProtoPriceQuote): PriceQuote {
  return {
    id: p.id, origin: p.origin, destination: p.destination, departureDate: p.departureDate,
    carrierIata: p.carrier?.iataCode ?? '', carrierName: p.carrier?.name ?? '',
    priceAmount: p.priceAmount,
    currency: p.currency?.toUpperCase() || 'USD',
    cabin: p.cabin?.replace('CABIN_CLASS_', '').replace(/_/g, ' ') ?? 'Economy',
    stops: p.stops, durationMinutes: p.durationMinutes, isIndicative: p.isIndicative,
    provider: p.provider || 'demo',
    expiresAt: p.expiresAt > 0 ? new Date(p.expiresAt) : null,
    checkoutRef: p.checkoutRef || '',
  };
}

function toDisplayNewsItem(p: ProtoAviationNews): AviationNewsItem {
  return {
    id: p.id, title: p.title, url: p.url, sourceName: p.sourceName,
    publishedAt: new Date(p.publishedAt), snippet: p.snippet,
    matchedEntities: p.matchedEntities ?? [],
  };
}

// ---- Client + circuit breakers ----

const client = new AviationServiceClient(getRpcBaseUrl(), { fetch: (...args) => globalThis.fetch(...args) });

const breakerDelays = createCircuitBreaker<AirportDelayAlert[]>({ name: 'Flight Delays v2', cacheTtlMs: 2 * 60 * 60 * 1000, persistCache: true });
const breakerOps = createCircuitBreaker<AirportOpsSummary[]>({ name: 'Airport Ops', cacheTtlMs: 6 * 60 * 1000, persistCache: true });
const breakerFlights = createCircuitBreaker<FlightInstance[]>({ name: 'Airport Flights', cacheTtlMs: 5 * 60 * 1000, persistCache: false });
const breakerCarrier = createCircuitBreaker<CarrierOps[]>({ name: 'Carrier Ops', cacheTtlMs: 5 * 60 * 1000, persistCache: false });
const breakerStatus = createCircuitBreaker<FlightInstance[]>({ name: 'Flight Status', cacheTtlMs: 6 * 60 * 1000, persistCache: false });
const breakerTrack = createCircuitBreaker<PositionSample[]>({ name: 'Track Aircraft', cacheTtlMs: 15 * 1000, persistCache: false });
const breakerPrices = createCircuitBreaker<{ quotes: PriceQuote[]; isDemoMode: boolean }>({ name: 'Flight Prices', cacheTtlMs: 10 * 60 * 1000, persistCache: true });
const breakerNews = createCircuitBreaker<AviationNewsItem[]>({ name: 'Aviation News', cacheTtlMs: 15 * 60 * 1000, persistCache: true });

// ---- Public API ----

export async function fetchFlightDelays(): Promise<AirportDelayAlert[]> {
  const hydrated = getHydratedData('flightDelays') as { alerts?: ProtoAlert[] } | undefined;
  if (hydrated?.alerts?.length) return hydrated.alerts.map(toDisplayAlert);

  return breakerDelays.execute(async () => {
    const r = await client.listAirportDelays({ region: 'AIRPORT_REGION_UNSPECIFIED', minSeverity: 'FLIGHT_DELAY_SEVERITY_UNSPECIFIED', pageSize: 0, cursor: '' });
    return r.alerts.map(toDisplayAlert);
  }, []);
}

export async function fetchAirportOpsSummary(airports: string[]): Promise<AirportOpsSummary[]> {
  return breakerOps.execute(async () => {
    const r = await client.getAirportOpsSummary({ airports });
    return r.summaries.map(toDisplayOps);
  }, [], { cacheKey: airports.join(',') });
}

export async function fetchAirportFlights(airport: string, direction: 'departure' | 'arrival' | 'both' = 'both', limit = 30): Promise<FlightInstance[]> {
  const dirMap = { departure: 'FLIGHT_DIRECTION_DEPARTURE', arrival: 'FLIGHT_DIRECTION_ARRIVAL', both: 'FLIGHT_DIRECTION_BOTH' } as const;
  return breakerFlights.execute(async () => {
    const r = await client.listAirportFlights({ airport, direction: dirMap[direction], limit });
    return r.flights.map(toDisplayFlight);
  }, [], { cacheKey: `${airport}:${direction}:${limit}` });
}

export async function fetchCarrierOps(airports: string[]): Promise<CarrierOps[]> {
  return breakerCarrier.execute(async () => {
    const r = await client.getCarrierOps({ airports, minFlights: 3 });
    return r.carriers.map(toDisplayCarrierOps);
  }, [], { cacheKey: airports.join(',') });
}

export async function fetchFlightStatus(flightNumber: string, date?: string, origin?: string): Promise<FlightInstance[]> {
  return breakerStatus.execute(async () => {
    const r = await client.getFlightStatus({ flightNumber, date: date ?? '', origin: origin ?? '' });
    return r.flights.map(toDisplayFlight);
  }, [], { cacheKey: `${flightNumber}:${date ?? ''}:${origin ?? ''}` });
}

export async function fetchAircraftPositions(opts: { icao24?: string; callsign?: string; swLat?: number; swLon?: number; neLat?: number; neLon?: number }): Promise<PositionSample[]> {
  return breakerTrack.execute(async () => {
    const r = await client.trackAircraft({ icao24: opts.icao24 ?? '', callsign: opts.callsign ?? '', swLat: opts.swLat ?? 0, swLon: opts.swLon ?? 0, neLat: opts.neLat ?? 0, neLon: opts.neLon ?? 0 });
    return r.positions.map(toDisplayPosition);
  }, [], { cacheKey: `${opts.icao24 ?? ''}:${opts.callsign ?? ''}:${opts.swLat ?? 0}:${opts.swLon ?? 0}:${opts.neLat ?? 0}:${opts.neLon ?? 0}` });
}

export async function fetchFlightPrices(opts: { origin: string; destination: string; departureDate: string; returnDate?: string; adults?: number; cabin?: CabinClass; nonstopOnly?: boolean; maxResults?: number; currency?: string; market?: string }): Promise<{ quotes: PriceQuote[]; isDemoMode: boolean; isIndicative: boolean; provider: string }> {
  return breakerPrices.execute(async () => {
    const r = await client.searchFlightPrices({
      origin: opts.origin, destination: opts.destination,
      departureDate: opts.departureDate, returnDate: opts.returnDate ?? '',
      adults: opts.adults ?? 1, cabin: opts.cabin ?? 'CABIN_CLASS_ECONOMY',
      nonstopOnly: opts.nonstopOnly ?? false, maxResults: opts.maxResults ?? 10,
      currency: opts.currency ?? 'usd', market: opts.market ?? '',
    });
    return {
      quotes: r.quotes.map(toDisplayPriceQuote),
      isDemoMode: r.isDemoMode,
      isIndicative: r.isIndicative ?? true,
      provider: r.provider,
    };
  }, { quotes: [], isDemoMode: true, isIndicative: true, provider: 'demo' });
}

export async function fetchAviationNews(entities: string[], windowHours = 24, maxItems = 20): Promise<AviationNewsItem[]> {
  return breakerNews.execute(async () => {
    const r = await client.listAviationNews({ entities, windowHours, maxItems });
    return r.items.map(toDisplayNewsItem);
  }, []);
}
