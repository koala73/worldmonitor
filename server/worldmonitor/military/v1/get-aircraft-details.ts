import { ApiError } from '../../../../src/generated/server/worldmonitor/military/v1/service_server';
import type {
  ServerContext,
  GetAircraftDetailsRequest,
  GetAircraftDetailsResponse,
} from '../../../../src/generated/server/worldmonitor/military/v1/service_server';

import {
  AIRCRAFT_DETAILS_CACHE_KEY,
  AIRCRAFT_DETAILS_CACHE_TTL,
  isValidAircraftIcao24,
  type CachedAircraftDetails,
  fetchWingbitsAircraftDetails,
} from './_wingbits-aircraft-details';
import { cachedFetchJson } from '../../../_shared/redis';
import { requirePremiumRpcAccess } from '../../../_shared/premium-check';

export async function getAircraftDetails(
  ctx: ServerContext,
  req: GetAircraftDetailsRequest,
): Promise<GetAircraftDetailsResponse> {
  // A cache miss can spend the server's Wingbits credential. Gate before
  // validation-dependent cache work so anonymous callers cannot probe or bill
  // the provider.
  await requirePremiumRpcAccess(
    ctx.request,
    ApiError,
    'PRO subscription or API key required for live flight data',
  );

  if (!req.icao24) return { details: undefined, configured: false };
  if (!isValidAircraftIcao24(req.icao24)) {
    throw new ApiError(400, 'icao24 must be a 6-character hexadecimal address', '');
  }
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
