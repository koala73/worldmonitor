export type TransportAviationProviderName =
  | 'fr24'
  | 'opensky'
  | 'airlabs'
  | 'aviationstack'
  | 'aerodatabox'
  | 'flightaware';

export type TransportMaritimeProviderName =
  | 'marinetraffic'
  | 'aisstream'
  | 'vesselfinder'
  | 'aishub';

export interface GeoPoint {
  latitude: number;
  longitude: number;
}

export interface TransportFlightRecord {
  id: string;
  callsign: string;
  location: GeoPoint;
  altitude?: number;
  heading?: number;
  speed?: number;
  provider: TransportAviationProviderName;
  observedAt: number;
}

export interface TransportVesselRecord {
  id: string;
  mmsi?: string;
  name: string;
  location: GeoPoint;
  shipType?: number;
  heading?: number;
  speed?: number;
  provider: TransportMaritimeProviderName;
  observedAt: number;
}

export interface FlightQueryBounds {
  neLat: number;
  neLon: number;
  swLat: number;
  swLon: number;
}
