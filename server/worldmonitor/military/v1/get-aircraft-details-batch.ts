import type {
  ServerContext,
  GetAircraftDetailsBatchRequest,
  GetAircraftDetailsBatchResponse,
  AircraftDetails,
} from '../../../../src/generated/server/worldmonitor/military/v1/service_server';

import { mapWingbitsDetails } from './_shared';
import { CHROME_UA } from '../../../_shared/constants';
import { getCachedJsonBatch, cachedFetchJson } from '../../../_shared/redis';

/** Max ICAO24 identifiers per batch request */
const MAX_BATCH_SIZE = 10;
/** Delay between sequential Wingbits API fetches to avoid rate-limiting */
const FETCH_DELAY_MS = 100;
/** Timeout for individual Wingbits API requests */
const WINGBITS_TIMEOUT_MS = 10_000;
/** Cache TTL for aircraft details (24 hours) */
const AIRCRAFT_CACHE_TTL = 24 * 60 * 60;

interface CachedAircraftDetails {
  details: AircraftDetails | null;
  configured: boolean;
}

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
    const uniqueSorted = Array.from(new Set(normalized)).sort();
    const limitedList = uniqueSorted.slice(0, MAX_BATCH_SIZE);

    // Redis shared cache — batch GET all keys in a single pipeline round-trip
    const SINGLE_KEY = 'military:aircraft:v1';
    const SINGLE_TTL = AIRCRAFT_CACHE_TTL;
    const results: Record<string, AircraftDetails> = {};
    const toFetch: string[] = [];

    const cacheKeys = limitedList.map((icao24) => `${SINGLE_KEY}:${icao24}`);
    const cachedMap = await getCachedJsonBatch(cacheKeys);

    for (let i = 0; i < limitedList.length; i++) {
      const icao24 = limitedList[i]!;
      const cached = cachedMap.get(cacheKeys[i]!);
      if (cached && typeof cached === 'object' && 'details' in cached) {
        const details = (cached as { details?: AircraftDetails | null }).details;
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
        `${SINGLE_KEY}:${icao24}`,
        SINGLE_TTL,
        async () => {
          try {
            const resp = await fetch(`https://customer-api.wingbits.com/v1/flights/details/${icao24}`, {
              headers: { 'x-api-key': apiKey, Accept: 'application/json', 'User-Agent': CHROME_UA },
              signal: AbortSignal.timeout(WINGBITS_TIMEOUT_MS),
            });
            if (resp.status === 404) {
              return { details: null, configured: true };
            }
            if (resp.ok) {
              const data = (await resp.json()) as Record<string, unknown>;
              const details = mapWingbitsDetails(icao24, data);
              return { details, configured: true };
            }
          } catch { /* skip failed lookups */ }
          return null;
        },
      );
      if (cacheResult?.details) results[icao24] = cacheResult.details;
      if (i < toFetch.length - 1) await delay(FETCH_DELAY_MS);
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
