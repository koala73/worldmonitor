export type AviationTransportProvider =
  | 'fr24'
  | 'opensky'
  | 'airlabs'
  | 'aviationstack'
  | 'aerodatabox'
  | 'flightaware';

export type MaritimeTransportProvider =
  | 'marinetraffic'
  | 'aisstream'
  | 'vesselfinder'
  | 'aishub';

export interface TransportPoint {
  latitude: number;
  longitude: number;
}

export interface CivilFlight {
  id: string;
  callsign: string;
  position: TransportPoint;
  altitude?: number;
  speed?: number;
  heading?: number;
  provider: AviationTransportProvider;
  observedAt: number;
}

export interface CivilVessel {
  id: string;
  mmsi?: string;
  name: string;
  position: TransportPoint;
  shipType?: number;
  speed?: number;
  heading?: number;
  provider: MaritimeTransportProvider;
  observedAt: number;
}
