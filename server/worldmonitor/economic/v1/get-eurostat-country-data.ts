/**
 * RPC: getEurostatCountryData -- reads seeded Eurostat per-country economic data.
 * All external Eurostat API calls happen in seed-eurostat-country-data.mjs on Railway.
 */

import type {
  ServerContext,
  GetEurostatCountryDataRequest,
  GetEurostatCountryDataResponse,
} from '../../../../src/generated/server/worldmonitor/economic/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';

const SEED_CACHE_KEY = 'economic:eurostat-country-data:v1';

function buildFallbackResult(): GetEurostatCountryDataResponse {
  return {
    countries: {},
    seededAt: '0',
    unavailable: true,
  };
}

export async function getEurostatCountryData(
  _ctx: ServerContext,
  _req: GetEurostatCountryDataRequest,
): Promise<GetEurostatCountryDataResponse> {
  try {
    const raw = await getCachedJson(SEED_CACHE_KEY, true) as Record<string, unknown> | null;
    if (!raw || !raw.countries || Object.keys(raw.countries as object).length === 0) {
      return buildFallbackResult();
    }
    return {
      countries: raw.countries as GetEurostatCountryDataResponse['countries'],
      seededAt: String(raw.seededAt ?? '0'),
      unavailable: false,
    };
  } catch {
    return buildFallbackResult();
  }
}
