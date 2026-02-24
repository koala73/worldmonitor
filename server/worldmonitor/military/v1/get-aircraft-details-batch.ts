declare const process: { env: Record<string, string | undefined> };

import type {
  ServerContext,
  GetAircraftDetailsBatchRequest,
  GetAircraftDetailsBatchResponse,
  AircraftDetails,
} from '../../../../src/generated/server/worldmonitor/military/v1/service_server';

import { mapWingbitsDetails } from './_shared';
import { CHROME_UA } from '../../../_shared/constants';
import { getCachedJsonBatch, setCachedJson } from '../../../_shared/redis';

export async function getAircraftDetailsBatch(
  _ctx: ServerContext,
  req: GetAircraftDetailsBatchRequest,
): Promise<GetAircraftDetailsBatchResponse> {
  const apiKey = process.env.WINGBITS_API_KEY;
  if (!apiKey) return { results: {}, fetched: 0, requested: 0, configured: false };

  const limitedList = req.icao24s.slice(0, 20).map((id) => id.toLowerCase());

  // Redis shared cache — batch GET all keys in a single pipeline round-trip
  const SINGLE_KEY = 'military:aircraft:v1';
  const SINGLE_TTL = 300;
  const results: Record<string, AircraftDetails> = {};
  const toFetch: string[] = [];

  const cacheKeys = limitedList.map((icao24) => `${SINGLE_KEY}:${icao24}`);
  const cachedMap = await getCachedJsonBatch(cacheKeys);

  for (let i = 0; i < limitedList.length; i++) {
    const icao24 = limitedList[i]!;
    const cached = cachedMap.get(cacheKeys[i]!) as { details?: AircraftDetails } | null;
    if (cached?.details) {
      results[icao24] = cached.details;
    } else {
      toFetch.push(icao24);
    }
  }

  const fetches = toFetch.map(async (icao24) => {
    try {
      const resp = await fetch(`https://customer-api.wingbits.com/v1/flights/details/${icao24}`, {
        headers: { 'x-api-key': apiKey, Accept: 'application/json', 'User-Agent': CHROME_UA },
        signal: AbortSignal.timeout(10_000),
      });
      if (resp.ok) {
        const data = (await resp.json()) as Record<string, unknown>;
        const details = mapWingbitsDetails(icao24, data);
        setCachedJson(`${SINGLE_KEY}:${icao24}`, { details, configured: true }, SINGLE_TTL).catch(() => {});
        return { icao24, details };
      }
    } catch { /* skip failed lookups */ }
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
