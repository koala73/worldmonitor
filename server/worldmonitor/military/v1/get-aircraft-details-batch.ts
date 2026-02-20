declare const process: { env: Record<string, string | undefined> };

import type {
  ServerContext,
  GetAircraftDetailsBatchRequest,
  GetAircraftDetailsBatchResponse,
  AircraftDetails,
} from '../../../../src/generated/server/worldmonitor/military/v1/service_server';

import { mapWingbitsDetails } from './_shared';

export async function getAircraftDetailsBatch(
  _ctx: ServerContext,
  req: GetAircraftDetailsBatchRequest,
): Promise<GetAircraftDetailsBatchResponse> {
  const apiKey = process.env.WINGBITS_API_KEY;
  if (!apiKey) return { results: {}, fetched: 0, requested: 0, configured: false };

  const limitedList = req.icao24s.slice(0, 20).map((id) => id.toLowerCase());
  const results: Record<string, AircraftDetails> = {};

  const fetches = limitedList.map(async (icao24) => {
    try {
      const resp = await fetch(`https://customer-api.wingbits.com/v1/flights/details/${icao24}`, {
        headers: { 'x-api-key': apiKey, Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      if (resp.ok) {
        const data = (await resp.json()) as Record<string, unknown>;
        return { icao24, details: mapWingbitsDetails(icao24, data) };
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
