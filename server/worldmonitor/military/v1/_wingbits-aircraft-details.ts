import type { AircraftDetails } from '../../../../src/generated/server/worldmonitor/military/v1/service_server';

import { CHROME_UA } from '../../../_shared/constants';
import { mapWingbitsDetails } from './_shared';

export const AIRCRAFT_DETAILS_CACHE_KEY = 'military:aircraft:v1';
export const AIRCRAFT_DETAILS_CACHE_TTL = 24 * 60 * 60; // 24 hours — aircraft metadata is mostly static

export interface CachedAircraftDetails {
  details: AircraftDetails | null;
  configured: boolean;
}

export async function fetchWingbitsAircraftDetails(
  icao24: string,
  apiKey: string,
): Promise<CachedAircraftDetails | null> {
  const resp = await fetch(`https://customer-api.wingbits.com/v1/flights/details/${icao24}`, {
    headers: { 'x-api-key': apiKey, Accept: 'application/json', 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(10_000),
  });

  if (resp.status === 404) {
    return { details: null, configured: true };
  }
  if (!resp.ok) return null;

  const data = (await resp.json()) as Record<string, unknown>;
  return {
    details: mapWingbitsDetails(icao24, data),
    configured: true,
  };
}
