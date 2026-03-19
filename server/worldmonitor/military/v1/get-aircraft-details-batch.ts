import type {
  ServerContext,
  GetAircraftDetailsBatchRequest,
  GetAircraftDetailsBatchResponse,
} from '../../../../src/generated/server/worldmonitor/military/v1/service_server';

import { getCachedJsonBatch, cachedFetchJson } from '../../../_shared/redis';
import { toUniqueSortedLimited } from '../../../_shared/normalize-list';
import {
  AIRCRAFT_DETAILS_CACHE_KEY,
  AIRCRAFT_DETAILS_CACHE_TTL,
  type CachedAircraftDetails,
  fetchWingbitsAircraftDetails,
} from './_wingbits-aircraft-details';

export async function getAircraftDetailsBatch(
  _ctx: ServerContext,
  req: GetAircraftDetailsBatchRequest,
): Promise<GetAircraftDetailsBatchResponse> {
  try {
    const apiKey = process.env.WINGBITS_API_KEY;
    if (!apiKey) return { results: {}, fetched: 0, requested: 0, configured: false };

    const normalized = req.icao24s
      .map((id) => id.trim().toLowerCase())
      .filter((id) => id.length > 0);
    const limitedList = toUniqueSortedLimited(normalized, 10);

    // Redis shared cache — batch GET all keys in a single pipeline round-trip
    const results: Record<string, NonNullable<CachedAircraftDetails['details']>> = {};
    const toFetch: string[] = [];

    const cacheKeys = limitedList.map((icao24) => `${AIRCRAFT_DETAILS_CACHE_KEY}:${icao24}`);
    const cachedMap = await getCachedJsonBatch(cacheKeys);

    for (let i = 0; i < limitedList.length; i++) {
      const icao24 = limitedList[i]!;
      const cached = cachedMap.get(cacheKeys[i]!);
      if (cached && typeof cached === 'object' && 'details' in cached) {
        const details = (cached as { details?: CachedAircraftDetails['details'] }).details;
        if (details) {
          results[icao24] = details;
        }
        // details === null means cached negative lookup; skip refetch.
      } else {
        toFetch.push(icao24);
      }
    }

    const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

    for (let i = 0; i < toFetch.length; i++) {
      const icao24 = toFetch[i]!;
      const cacheResult = await cachedFetchJson<CachedAircraftDetails>(
        `${AIRCRAFT_DETAILS_CACHE_KEY}:${icao24}`,
        AIRCRAFT_DETAILS_CACHE_TTL,
        async () => {
          try {
            return await fetchWingbitsAircraftDetails(icao24, apiKey);
          } catch { /* skip failed lookups */ }
          return null;
        },
      );
      if (cacheResult?.details) results[icao24] = cacheResult.details;
      if (i < toFetch.length - 1) await delay(100);
    }

    return {
      results,
      fetched: Object.keys(results).length,
      requested: limitedList.length,
      configured: true,
    };
  } catch {
    return { results: {}, fetched: 0, requested: 0, configured: true };
  }
}
