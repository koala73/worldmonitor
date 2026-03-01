import type { CivilFlight } from '../types';

export interface AviationProvider {
  name: 'fr24' | 'opensky' | 'airlabs' | 'aviationstack' | 'aerodatabox' | 'flightaware';
  listFlights(bounds: {
    neLat: number;
    neLon: number;
    swLat: number;
    swLon: number;
  }): Promise<CivilFlight[]>;
}
