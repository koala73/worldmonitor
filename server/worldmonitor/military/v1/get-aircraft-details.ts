import type {
  ServerContext,
  GetAircraftDetailsRequest,
  GetAircraftDetailsResponse,
} from '../../../../src/generated/server/worldmonitor/military/v1/service_server';

import {
  AIRCRAFT_DETAILS_CACHE_KEY,
  AIRCRAFT_DETAILS_CACHE_TTL,
  type CachedAircraftDetails,
  fetchWingbitsAircraftDetails,
} from './_wingbits-aircraft-details';
import { cachedFetchJson } from '../../../_shared/redis';

export async function getAircraftDetails(
  _ctx: ServerContext,
  req: GetAircraftDetailsRequest,
): Promise<GetAircraftDetailsResponse> {
  if (!req.icao24) return { details: undefined, configured: false };
  const apiKey = process.env.WINGBITS_API_KEY;
  if (!apiKey) return { details: undefined, configured: false };

  const icao24 = req.icao24.toLowerCase();
  const cacheKey = `${AIRCRAFT_DETAILS_CACHE_KEY}:${icao24}`;

  try {
    const result = await cachedFetchJson<CachedAircraftDetails>(
      cacheKey,
      AIRCRAFT_DETAILS_CACHE_TTL,
      async () => fetchWingbitsAircraftDetails(icao24, apiKey),
    );

    if (!result || !result.details) {
      return { details: undefined, configured: true };
    }

    return {
      details: result.details,
      configured: true,
    };
  } catch {
    return { details: undefined, configured: true };
  }
}
