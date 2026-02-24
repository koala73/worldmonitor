declare const process: { env: Record<string, string | undefined> };

import type {
  ServerContext,
  GetAircraftDetailsRequest,
  GetAircraftDetailsResponse,
} from '../../../../src/generated/server/worldmonitor/military/v1/service_server';

import { mapWingbitsDetails } from './_shared';
import { CHROME_UA } from '../../../_shared/constants';
import { getCachedJson, setCachedJson } from '../../../_shared/redis';

const REDIS_CACHE_KEY = 'military:aircraft:v1';
const REDIS_CACHE_TTL = 300; // 5 min — aircraft details rarely change

export async function getAircraftDetails(
  _ctx: ServerContext,
  req: GetAircraftDetailsRequest,
): Promise<GetAircraftDetailsResponse> {
  const apiKey = process.env.WINGBITS_API_KEY;
  if (!apiKey) return { details: undefined, configured: false };

  const icao24 = req.icao24.toLowerCase();

  // Redis shared cache (cross-instance)
  const cacheKey = `${REDIS_CACHE_KEY}:${icao24}`;
  const cached = (await getCachedJson(cacheKey)) as GetAircraftDetailsResponse | null;
  if (cached?.details) return cached;

  try {
    const resp = await fetch(`https://customer-api.wingbits.com/v1/flights/details/${icao24}`, {
      headers: { 'x-api-key': apiKey, Accept: 'application/json', 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(10_000),
    });

    if (!resp.ok) {
      return { details: undefined, configured: true };
    }

    const data = (await resp.json()) as Record<string, unknown>;
    const result: GetAircraftDetailsResponse = {
      details: mapWingbitsDetails(icao24, data),
      configured: true,
    };
    setCachedJson(cacheKey, result, REDIS_CACHE_TTL).catch(() => {});
    return result;
  } catch {
    return { details: undefined, configured: true };
  }
}
