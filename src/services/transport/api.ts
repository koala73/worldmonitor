import type { CivilFlight, CivilVessel } from './types';

export interface TransportFlightProviderStatus {
  fr24?: { enabled?: boolean; configured?: boolean };
  opensky?: { enabled?: boolean; authConfigured?: boolean; mode?: string };
}

export interface TransportVesselProviderStatus {
  aisstream?: { enabled?: boolean; configured?: boolean; relayConfigured?: boolean; relayReachable?: boolean };
  marinetraffic?: { enabled?: boolean; configured?: boolean };
  vesselfinder?: { enabled?: boolean; configured?: boolean };
}

interface TransportFlightsResponse {
  count?: number;
  providers?: Record<string, number>;
  providerStatus?: TransportFlightProviderStatus;
  flights?: Array<{
    id?: string;
    callsign?: string;
    provider?: string;
    location?: { latitude?: number; longitude?: number };
    altitude?: number;
    speed?: number;
    heading?: number;
    observedAt?: number | string;
  }>;
}

interface TransportVesselsResponse {
  count?: number;
  providers?: Record<string, number>;
  providerStatus?: TransportVesselProviderStatus;
  vessels?: Array<{
    id?: string;
    mmsi?: string;
    name?: string;
    provider?: string;
    location?: { latitude?: number; longitude?: number };
    shipType?: number;
    speed?: number;
    heading?: number;
    observedAt?: number | string;
  }>;
}

function toObservedAt(value: number | string | undefined): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber)) return asNumber;
    const asDate = Date.parse(value);
    if (Number.isFinite(asDate)) return asDate;
  }
  return Date.now();
}

function toCoordinate(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
}

export interface TransportFlightsResult {
  flights: CivilFlight[];
  count: number;
  providers: Record<string, number>;
  providerStatus?: TransportFlightProviderStatus;
}

export interface TransportVesselsResult {
  vessels: CivilVessel[];
  count: number;
  providers: Record<string, number>;
  providerStatus?: TransportVesselProviderStatus;
}

export async function fetchTransportFlights(bounds: {
  neLat: number;
  neLon: number;
  swLat: number;
  swLon: number;
}): Promise<TransportFlightsResult> {
  const params = new URLSearchParams({
    neLat: String(bounds.neLat),
    neLon: String(bounds.neLon),
    swLat: String(bounds.swLat),
    swLon: String(bounds.swLon),
  });

  const response = await fetch(`/api/transport/flights?${params.toString()}`);
  if (!response.ok) {
    throw new Error(`Transport flights API failed: HTTP ${response.status}`);
  }

  const payload = await response.json() as TransportFlightsResponse;
  const flights = Array.isArray(payload.flights) ? payload.flights : [];
  const mappedFlights = flights
    .map((row, index): CivilFlight | null => {
      const lat = toCoordinate(row.location?.latitude);
      const lon = toCoordinate(row.location?.longitude);
      if (lat === null || lon === null) return null;

      const id = String(row.id ?? '').trim() || `flight-${index}`;
      const callsign = String(row.callsign ?? '').trim() || id;
      const providerRaw = String(row.provider ?? '').trim();
      const provider = (providerRaw || 'opensky') as CivilFlight['provider'];

      return {
        id,
        callsign,
        provider,
        position: { latitude: lat, longitude: lon },
        altitude: typeof row.altitude === 'number' ? row.altitude : undefined,
        speed: typeof row.speed === 'number' ? row.speed : undefined,
        heading: typeof row.heading === 'number' ? row.heading : undefined,
        observedAt: toObservedAt(row.observedAt),
      };
    })
    .filter((flight): flight is CivilFlight => Boolean(flight));

  return {
    flights: mappedFlights,
    count: typeof payload.count === 'number' ? payload.count : mappedFlights.length,
    providers: payload.providers && typeof payload.providers === 'object' ? payload.providers : {},
    providerStatus: payload.providerStatus,
  };
}

export async function fetchTransportVessels(): Promise<TransportVesselsResult> {
  const response = await fetch('/api/transport/vessels');
  if (!response.ok) {
    throw new Error(`Transport vessels API failed: HTTP ${response.status}`);
  }

  const payload = await response.json() as TransportVesselsResponse;
  const vessels = Array.isArray(payload.vessels) ? payload.vessels : [];
  const mappedVessels = vessels
    .map((row, index): CivilVessel | null => {
      const lat = toCoordinate(row.location?.latitude);
      const lon = toCoordinate(row.location?.longitude);
      if (lat === null || lon === null) return null;

      const id = String(row.id ?? '').trim() || `vessel-${index}`;
      const mmsi = String(row.mmsi ?? '').trim() || undefined;
      const name = String(row.name ?? '').trim() || mmsi || id;
      const providerRaw = String(row.provider ?? '').trim();
      const provider = (providerRaw || 'aisstream') as CivilVessel['provider'];

      return {
        id,
        mmsi,
        name,
        provider,
        position: { latitude: lat, longitude: lon },
        shipType: typeof row.shipType === 'number' ? row.shipType : undefined,
        speed: typeof row.speed === 'number' ? row.speed : undefined,
        heading: typeof row.heading === 'number' ? row.heading : undefined,
        observedAt: toObservedAt(row.observedAt),
      };
    })
    .filter((vessel): vessel is CivilVessel => Boolean(vessel));

  return {
    vessels: mappedVessels,
    count: typeof payload.count === 'number' ? payload.count : mappedVessels.length,
    providers: payload.providers && typeof payload.providers === 'object' ? payload.providers : {},
    providerStatus: payload.providerStatus,
  };
}
