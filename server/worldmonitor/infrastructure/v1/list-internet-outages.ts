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
import { readRequiredSeed } from '../../../_shared/required-seed';

const SEED_CACHE_KEY = 'infra:outages:v1';
// Retention keeps the payload alive when a Radar refresh fails but never
// advances this clock, so it is the list's real age.
const SEED_META_KEY = 'seed-meta:infra:outages';

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
  const [seedData, seedMeta] = await Promise.all([
    readRequiredSeed(SEED_CACHE_KEY, value => {
      const data = value as ListInternetOutagesResponse | null;
      return data && Array.isArray(data.outages) ? data : undefined;
    }),
    getCachedJson(SEED_META_KEY, true) as Promise<{ fetchedAt?: number } | null>,
  ]);
  const fetchedAt = Number.isFinite(seedMeta?.fetchedAt) ? Number(seedMeta?.fetchedAt) : 0;
  return { outages: filterOutages(seedData.outages, req), pagination: undefined, fetchedAt };
}
