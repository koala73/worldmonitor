/**
 * ListInternetOutages RPC -- reads seeded outage data from Railway seed cache.
 * All external Cloudflare Radar API calls happen in seed-internet-outages.mjs on Railway.
 */

import type {
  ServerContext,
  ListInternetOutagesRequest,
  ListInternetOutagesResponse,
  InternetOutage,
} from '../../../../src/generated/server/worldmonitor/infrastructure/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';

const SEED_CACHE_KEY = 'infra:outages:v1';

function filterOutages(outages: InternetOutage[], req: ListInternetOutagesRequest): InternetOutage[] {
  let filtered = outages;
  if (req.country) {
    const target = req.country.toLowerCase();
    filtered = filtered.filter((o) => o.country.toLowerCase().includes(target));
  }
  if (req.start) {
    filtered = filtered.filter((o) => o.detectedAt >= req.start);
  }
  if (req.end) {
    filtered = filtered.filter((o) => o.detectedAt <= req.end);
  }
  return filtered;
}

export async function listInternetOutages(
  _ctx: ServerContext,
  req: ListInternetOutagesRequest,
): Promise<ListInternetOutagesResponse> {
  try {
    const seedData = await getCachedJson(SEED_CACHE_KEY, true) as ListInternetOutagesResponse | null;
    return { outages: filterOutages(seedData?.outages || [], req), pagination: undefined };
  } catch {
    return { outages: [], pagination: undefined };
  }
}
