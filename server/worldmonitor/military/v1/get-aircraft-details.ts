declare const process: { env: Record<string, string | undefined> };

import type {
  ServerContext,
  GetAircraftDetailsRequest,
  GetAircraftDetailsResponse,
} from '../../../../src/generated/server/worldmonitor/military/v1/service_server';

import { mapWingbitsDetails } from './_shared';

export async function getAircraftDetails(
  _ctx: ServerContext,
  req: GetAircraftDetailsRequest,
): Promise<GetAircraftDetailsResponse> {
  const apiKey = process.env.WINGBITS_API_KEY;
  if (!apiKey) return { details: undefined, configured: false };

  const icao24 = req.icao24.toLowerCase();
  try {
    const resp = await fetch(`https://customer-api.wingbits.com/v1/flights/details/${icao24}`, {
      headers: { 'x-api-key': apiKey, Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });

    if (!resp.ok) {
      return { details: undefined, configured: true };
    }

    const data = (await resp.json()) as Record<string, unknown>;
    return {
      details: mapWingbitsDetails(icao24, data),
      configured: true,
    };
  } catch {
    return { details: undefined, configured: true };
  }
}
