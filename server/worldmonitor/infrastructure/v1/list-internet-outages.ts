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

import { readRequiredSeed } from '../../../_shared/required-seed';

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
  const seedData = await readRequiredSeed(SEED_CACHE_KEY, value => {
    const data = value as ListInternetOutagesResponse | null;
    return data && Array.isArray(data.outages) ? data : undefined;
  });
  return { outages: filterOutages(seedData.outages, req), pagination: undefined };
}
