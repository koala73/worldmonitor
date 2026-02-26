declare const process: { env: Record<string, string | undefined> };

import type {
  ServerContext,
  GetAircraftDetailsBatchRequest,
  GetAircraftDetailsBatchResponse,
  AircraftDetails,
} from '../../../../src/generated/server/worldmonitor/military/v1/service_server';

import { mapWingbitsDetails } from './_shared';
import { CHROME_UA } from '../../../_shared/constants';
import { getCachedJsonBatch, cachedFetchJson } from '../../../_shared/redis';

interface CachedAircraftDetails {
  details: AircraftDetails | null;
  configured: boolean;
}

export async function getAircraftDetailsBatch(
  _ctx: ServerContext,
  req: GetAircraftDetailsBatchRequest,
): Promise<GetAircraftDetailsBatchResponse> {
  const apiKey = process.env.WINGBITS_API_KEY;
  if (!apiKey) return { results: {}, fetched: 0, requested: 0, configured: false };

  const normalized = req.icao24s
    .map((id) => id.trim().toLowerCase())
    .filter((id) => id.length > 0);
  const uniqueSorted = Array.from(new Set(normalized)).sort();
  const limitedList = uniqueSorted.slice(0, 20);

  // Redis shared cache — batch GET all keys in a single pipeline round-trip
  const SINGLE_KEY = 'military:aircraft:v1';
  const SINGLE_TTL = 24 * 60 * 60;
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

  const fetches = toFetch.map(async (icao24) => {
    const cacheResult = await cachedFetchJson<CachedAircraftDetails>(
      `${SINGLE_KEY}:${icao24}`,
      SINGLE_TTL,
      async () => {
        try {
          const resp = await fetch(`https://customer-api.wingbits.com/v1/flights/details/${icao24}`, {
            headers: { 'x-api-key': apiKey, Accept: 'application/json', 'User-Agent': CHROME_UA },
            signal: AbortSignal.timeout(10_000),
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
    if (cacheResult?.details) return { icao24, details: cacheResult.details };
    return null;
  });

  const fetchResults = await Promise.all(fetches);
  for (const r of fetchResults) {
    if (r) results[r.icao24] = r.details;
  }

  return {
    results,
    fetched: Object.keys(results).length,
    requested: limitedList.length,
    configured: true,
  };
}
